import { describe, it, expect } from 'vitest';
import { minimapProjection, speedColor, speedSegments, createCircuitHud } from '../circuit-hud.js';
import { buildCircuit } from '../circuit.js';
import { solveLap } from '../lap-sim.js';
import { SPA } from '../circuits/spa-data.js';
import { defaultSetup } from '../vehicle-model.js';

const spa = buildCircuit(SPA);

describe('minimap helpers', () => {
  it('projection keeps every point inside the padded box, north up, uniform scale', () => {
    const project = minimapProjection(spa, 110, 150, 8);
    let north = { y: -Infinity }, south = { y: Infinity };
    for (let i = 0; i < spa.count; i++) {
      const p = project(spa.x[i], spa.y[i]);
      expect(p.x).toBeGreaterThanOrEqual(8 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(102 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(8 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(142 + 1e-6);
      if (spa.y[i] > north.y) north = { y: spa.y[i], py: p.y };
      if (spa.y[i] < south.y) south = { y: spa.y[i], py: p.y };
    }
    expect(north.py).toBeLessThan(south.py);            // larger data-y ⇒ higher on screen
    const a = project(0, 0), b = project(100, 0), c = project(0, 100);
    expect(b.x - a.x).toBeCloseTo(a.y - c.y, 9);        // same scale on both axes
  });
  it('speedColor: slow is red, fast is cyan, clamped', () => {
    expect(speedColor(10, 10, 90)).toBe('hsl(0, 90%, 52%)');
    expect(speedColor(90, 10, 90)).toBe('hsl(190, 90%, 58%)');
    expect(speedColor(500, 10, 90)).toBe(speedColor(90, 10, 90));
    expect(speedColor(5, 5, 5)).toBe('hsl(0, 90%, 52%)');
  });
  it('speedSegments cover the lap with coloured pieces', () => {
    const lap = solveLap(spa, 'F1', defaultSetup('F1'));
    const project = minimapProjection(spa, 110, 150);
    const segs = speedSegments(spa, lap, project, 70);
    expect(segs.length).toBe(70);
    expect(segs.every(s => s.d.startsWith('M') && s.d.includes('L'))).toBe(true);
    expect(new Set(segs.map(s => s.color)).size).toBeGreaterThan(10);
    // La Source (s≈400) is redder (lower hue) than the Kemmel straight (s≈2000).
    const hue = (s) => Number(segs[Math.floor(s / spa.length * 70)].color.match(/hsl\((\d+)/)[1]);
    expect(hue(400)).toBeLessThan(hue(2000));
    expect(speedSegments(spa, null, project, 10)[0].color).toBe('#8892a0');
  });
});

describe('createCircuitHud', () => {
  function fakeDoc() {
    const nodes = new Map();
    const make = () => ({
      textContent: '', children: [], attrs: {},
      get firstChild() { return this.children[0] || null; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); },
      appendChild(c) { this.children.push(c); },
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } },
    });
    return { nodes, getElementById(id) { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); }, createElementNS: () => make() };
  }
  it('shows, draws, recolours and tracks the car', () => {
    const doc = fakeDoc();
    const hud = createCircuitHud(doc);
    hud.setCircuit(spa);
    expect(doc.nodes.get('circuit-hud').classList._s.has('show')).toBe(true);
    expect(doc.nodes.get('ch-name').textContent).toBe('SPA-FRANCORCHAMPS');
    expect(doc.nodes.get('ch-map-segs').children.length).toBe(140);
    expect(doc.nodes.get('ch-ideal').textContent).toBe('…');
    const lap = solveLap(spa, 'F1', defaultSetup('F1'));
    hud.setLap(lap);
    expect(doc.nodes.get('ch-map-segs').children.length).toBe(140);   // replaced, not appended
    expect(doc.nodes.get('ch-ideal').textContent).toMatch(/^1:4\d\.\d{3}$/);
    hud.update({ lapS: 400, lapTime: 12.345, lastLap: 0, corner: 'La Source', lapNumber: 1 }, 1);
    expect(doc.nodes.get('ch-corner').textContent).toBe('La Source');
    expect(doc.nodes.get('ch-cur').textContent).toBe('0:12.3');
    expect(doc.nodes.get('ch-last').textContent).toBe('–');
    const x1 = doc.nodes.get('ch-dot').attrs.cx;
    hud.update({ lapS: 3000, lapTime: 60, lastLap: 106.4, corner: 'Bruxelles', lapNumber: 2 }, 1);
    expect(doc.nodes.get('ch-dot').attrs.cx).not.toBe(x1);
    expect(doc.nodes.get('ch-last').textContent).toBe('1:46.400');
    expect(doc.nodes.get('ch-elev').textContent).toMatch(/m · [+−]\d+%$/);
    hud.setCircuit(null);
    expect(doc.nodes.get('circuit-hud').classList._s.has('show')).toBe(false);
  });
});
