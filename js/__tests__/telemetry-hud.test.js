import { describe, it, expect } from 'vitest';
import { usageColor, ggDot, ggScale, telemetryView, vmaxLabel, createTelemetryHud } from '../telemetry-hud.js';
import { createVehicleState, stepVehicle, defaultSetup, topSpeed } from '../vehicle-model.js';

const settle = (type, setup, targetKmh, kappa = 0, seconds = 40) => {
  const vs = createVehicleState();
  for (let i = 0; i < seconds * 60; i++) {
    stepVehicle(vs, { type, setup, dt: 1 / 60, targetV: targetKmh / 3.6, kappa });
  }
  return vs;
};

describe('telemetry view-model', () => {
  it('usageColor runs green → red and clamps', () => {
    expect(usageColor(0)).toBe('hsl(135, 85%, 46%)');
    expect(usageColor(1)).toBe('hsl(0, 85%, 54%)');
    expect(usageColor(5)).toBe(usageColor(1));
    expect(usageColor(-1)).toBe(usageColor(0));
  });
  it('ggDot: braking up, left turn left, clamped to the ring', () => {
    expect(ggDot(0, 0, 6)).toEqual({ x: 0, y: 0 });
    expect(ggDot(-3, 0, 6).y).toBeCloseTo(-0.5, 10);   // braking ⇒ up (CSS −y)
    expect(ggDot(0, 3, 6).x).toBeCloseTo(-0.5, 10);
    expect(ggDot(-99, 99, 6)).toEqual({ x: -1, y: -1 });
    expect(ggScale('F1')).toBe(6);
    expect(ggScale('GT')).toBe(3);
  });
  it('at rest: zero aero, static loads, no flags', () => {
    const v = telemetryView(createVehicleState(), 'F1', defaultSetup('F1'));
    expect(v.downforce).toBe('0.0');
    expect(v.drag).toBe('0.0');
    expect(v.flags).toEqual([]);
    expect(v.latG).toBe('0.0');
    expect(v.ride).toBe('35');
  });
  it('at speed: numbers mirror the model state', () => {
    const s = defaultSetup('F1');
    const vs = settle('F1', s, 280);
    const v = telemetryView(vs, 'F1', s);
    expect(Number(v.downforce)).toBeCloseTo(vs.aero.downforce / 1000, 1);
    expect(Number(v.drag)).toBeCloseTo(vs.aero.drag / 1000, 1);
    expect(v.downforceWeights).toMatch(/^\d\.\d\d× car weight$/);
    expect(Number(v.wheels.FL.kN)).toBeCloseTo(vs.loads.FL / 1000, 1);
    expect(v.wheels.RL.frac).toBeGreaterThan(0);
    expect(v.wheels.RL.frac).toBeLessThanOrEqual(1);
    expect(Number(v.ride)).toBeLessThan(35);
  });
  it('flags follow the state: DRS, corner limit, over grip', () => {
    const s = { ...defaultSetup('F1'), drs: true };
    const vs = settle('F1', s, 200, 1 / 20, 5);
    const v = telemetryView(vs, 'F1', s);
    expect(v.flags).toContain('DRS');
    expect(v.flags).toContain('OVER GRIP');
    const vs2 = createVehicleState();
    stepVehicle(vs2, { type: 'F1', setup: s, dt: 1 / 60, targetV: 80, kappa: 0, capV: 20 });
    expect(telemetryView(vs2, 'F1', s).flags).toContain('CORNER LIMIT');
  });
  it('GT cornering hard lifts the inside front and flags it', () => {
    const s = defaultSetup('GT');
    const vs = settle('GT', s, 150, 1 / 100, 20);
    const v = telemetryView(vs, 'GT', s);
    expect(v.wheels.FR.frac).toBeGreaterThan(v.wheels.FL.frac);
    expect(v.wheels.FR.usage).toBeGreaterThan(0.5);
  });
  it('vmaxLabel is the drag-limited top speed in km/h', () => {
    const s = defaultSetup('F1');
    expect(vmaxLabel('F1', s)).toBe(String(Math.round(topSpeed('F1', s) * 3.6)));
  });
});

describe('createTelemetryHud (DOM mirror)', () => {
  function fakeDoc() {
    const nodes = new Map();
    const make = () => ({
      textContent: '', innerHTML: '', style: {}, children: [], className: '', writes: 0,
      _l: {}, attrs: {},
      classList: { _s: new Set(), toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); return this._s.has(c); } },
      addEventListener(t, f) { this._l[t] = f; },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); },
    });
    return {
      nodes,
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); },
      createElement: make,
    };
  }
  it('writes the view, throttles text to 10 Hz, and skips unchanged values', () => {
    const doc = fakeDoc();
    const hud = createTelemetryHud(doc);
    const s = defaultSetup('F1');
    const view = telemetryView(settle('F1', s, 250), 'F1', s);
    hud.update(view, 1 / 60);
    expect(doc.nodes.get('tm-df').textContent).toBe(view.downforce);
    expect(doc.nodes.get('tm-w-RL').style.height).toMatch(/%$/);
    expect(doc.nodes.get('tm-gg-dot').style.left).toBe('50.0%');
    // Second frame inside the 0.1 s window: text untouched even if changed.
    hud.update({ ...view, downforce: '99.9' }, 1 / 60);
    expect(doc.nodes.get('tm-df').textContent).toBe(view.downforce);
    hud.update({ ...view, downforce: '99.9' }, 0.2);
    expect(doc.nodes.get('tm-df').textContent).toBe('99.9');
  });
  it('header click toggles the collapsed state + aria', () => {
    const doc = fakeDoc();
    createTelemetryHud(doc);
    const head = doc.nodes.get('telemetry-head');
    head._l.click();
    expect(doc.nodes.get('telemetry').classList._s.has('collapsed')).toBe(true);
    expect(head.attrs['aria-expanded']).toBe('false');
  });
  it('flags render as chips', () => {
    const doc = fakeDoc();
    const hud = createTelemetryHud(doc);
    const s = { ...defaultSetup('F1'), drs: true };
    hud.update(telemetryView(createVehicleState(), 'F1', s), 1);
    expect(doc.nodes.get('tm-flags').children.map(c => c.textContent)).toEqual(['DRS']);
  });
});
