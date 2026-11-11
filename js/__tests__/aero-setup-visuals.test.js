/**
 * aero-setup-visuals.test.js — the CFD paint must mirror the selected aero
 * setup (wing level / DRS / ride height), driven by the vehicle model's
 * component gains. Reference setup (all gains 1) must be the identity.
 */
import { describe, it, expect } from 'vitest';
import {
  CfdEffect, computeSurfaceCp, computePatchCp, roleAeroGain, probeCp, CFD_PATCHES,
} from '../cfd-effect.js';
import { aeroCoeffs, defaultSetup } from '../vehicle-model.js';

const A = {
  frontWing: { x: 0, y: 0.05, z: -2.30 },
  rearWing:  { x: 0, y: 0.84, z:  1.92 },
  floor:     { x: 0, y: 0.03, z:  0.10 },
};
// Rear-wing suction side: forward-and-down normal, at 25 % chord.
const RW = [0, 0.84, 1.92 - 0.35 + 0.25 * 0.70, 0, -0.6, -0.8];
// Front-wing underside.
const FW = [0, 0.05, -2.30 - 0.30 + 0.25 * 0.60, 0, -1, 0];
// Mid-floor underside.
const FL = [0, -0.02, 0.4, 0, -1, 0];
const cp = (pt, aero) => computeSurfaceCp(...pt, 'F1', A, 1, 1, 0, aero);

function makeScene() {
  return { _o: [], add(o) { this._o.push(o); }, remove(o) { this._o = this._o.filter(x => x !== o); } };
}

describe('computeSurfaceCp — aero setup gains', () => {
  it('reference gains are the identity', () => {
    for (const pt of [RW, FW, FL]) {
      expect(cp(pt, { frontWing: 1, rearWing: 1, floor: 1 })).toBe(cp(pt, null));
      expect(cp(pt, undefined)).toBe(cp(pt, null));
    }
  });
  it('DRS (rear gain < 1) weakens rear-wing suction only', () => {
    const drs = { frontWing: 1, rearWing: 0.42, floor: 1 };
    expect(cp(RW, drs)).toBeGreaterThan(cp(RW, null));      // less negative
    expect(cp(RW, null)).toBeLessThan(0);
    expect(cp(FW, drs)).toBe(cp(FW, null));
    expect(cp(FL, drs)).toBe(cp(FL, null));
  });
  it('more front wing deepens front-wing suction only', () => {
    const hi = { frontWing: 1.35, rearWing: 1, floor: 1 };
    expect(cp(FW, hi)).toBeLessThan(cp(FW, null));
    expect(cp(RW, hi)).toBe(cp(RW, null));
  });
  it('floor gain scales underbody suction linearly', () => {
    const base = cp(FL, null);
    expect(base).toBeLessThan(0);
    expect(cp(FL, { floor: 1.3 })).toBeCloseTo(base * 1.3, 10);
    expect(cp(FL, { floor: 0.6 })).toBeGreaterThan(base);
  });
  it('probeCp reads the same value the surface was painted with', () => {
    const aero = { frontWing: 1, rearWing: 0.5, floor: 1 };
    const hit = { point: { x: RW[0], y: RW[1] + 0.2, z: RW[2] }, face: { normal: { x: RW[3], y: RW[4], z: RW[5] } } };
    expect(probeCp(hit, 'F1', A, 1, 0.2, 0, aero)).toBe(cp(RW, aero));
    expect(probeCp(hit, 'F1', A, 1, 0.2)).toBe(cp(RW, null));
  });
});

describe('patch path (procedural cars)', () => {
  it('roleAeroGain maps roles to components', () => {
    const g = { frontWing: 1.2, rearWing: 0.5, floor: 0.8 };
    expect(roleAeroGain('frontWingFlap', g)).toBe(1.2);
    expect(roleAeroGain('rearWing', g)).toBe(0.5);
    expect(roleAeroGain('diffuser', g)).toBe(0.8);
    expect(roleAeroGain('nose', g)).toBe(1);
    expect(roleAeroGain('rearWing', null)).toBe(1);
  });
  it('computePatchCp scales wing patches and is unchanged without gains', () => {
    const p = CFD_PATCHES.F2.find(q => q.role === 'rearWing');
    const base = computePatchCp(p, 0, 0, 1, [], [], 'F2');
    expect(computePatchCp(p, 0, 0, 1, [], [], 'F2', null)).toBe(base);
    expect(computePatchCp(p, 0, 0, 1, [], [], 'F2', { rearWing: 0.5 })).toBeCloseTo(base * 0.5, 10);
  });
});

describe('CfdEffect.setAeroSetup', () => {
  it('quantises, ignores no-op changes, and schedules a repaint on a real one', () => {
    const cfd = new CfdEffect(makeScene());
    cfd.setAeroSetup({ frontWing: 1, rearWing: 1, floor: 1 });
    cfd._betaDirty = false;
    cfd.setAeroSetup({ frontWing: 1.005, rearWing: 0.995, floor: 1.01 });   // inside the 0.04 quantum
    expect(cfd._betaDirty).toBe(false);
    cfd.setAeroSetup({ frontWing: 1, rearWing: 0.42, floor: 1 });
    expect(cfd._betaDirty).toBe(true);
    expect(cfd._aero.rearWing).toBeCloseTo(0.44, 10);
    expect(() => cfd.setAeroSetup(null)).not.toThrow();
    expect(cfd._aero.frontWing).toBe(1);
  });
  it('end to end: model gains for DRS reach the paint', () => {
    const shut = aeroCoeffs('F1', defaultSetup('F1')).gains;
    const open = aeroCoeffs('F1', { ...defaultSetup('F1'), drs: true }).gains;
    expect(cp(RW, open)).toBeGreaterThan(cp(RW, shut));
    expect(cp(RW, shut)).toBeCloseTo(cp(RW, null), 10);
  });
});
