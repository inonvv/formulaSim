import { describe, it, expect } from 'vitest';
import {
  topViewVelocity,
  pressureCoeff,
  cpToColor,
  traceStreamlinePath,
  vortexVelocity,
} from '../airflow-core.js';

/* ── helpers ── */
const approx = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;

describe('topViewVelocity', () => {
  it('returns {0,0} inside the body (r²≤1)', () => {
    const v = topViewVelocity(0, 0);
    expect(v.vxi).toBe(0);
    expect(v.veta).toBe(0);
  });

  it('returns {0,0} exactly on the body surface (0,1)', () => {
    const v = topViewVelocity(0, 1);
    expect(v.vxi).toBe(0);
    expect(v.veta).toBe(0);
  });

  it('freestream at far distance — veta ≈ 1, vxi ≈ 0', () => {
    const v = topViewVelocity(0, 100);
    expect(v.veta).toBeCloseTo(1, 3);
    expect(v.vxi).toBeCloseTo(0, 3);
  });

  it('stagnation at front (0, −1.001) — speed near 0', () => {
    const v = topViewVelocity(0, -1.001);
    const speed = Math.sqrt(v.vxi ** 2 + v.veta ** 2);
    expect(speed).toBeLessThan(0.05);
  });

  it('stagnation at rear (0, 1.001) — speed near 0', () => {
    const v = topViewVelocity(0, 1.001);
    const speed = Math.sqrt(v.vxi ** 2 + v.veta ** 2);
    expect(speed).toBeLessThan(0.05);
  });

  it('speed at widest point (1.05, 0) > 1.5× freestream', () => {
    const v = topViewVelocity(1.05, 0);
    const speed = Math.sqrt(v.vxi ** 2 + v.veta ** 2);
    expect(speed).toBeGreaterThan(1.5);
  });

  it('is laterally antisymmetric — vxi flips sign across xi=0', () => {
    const pos = topViewVelocity(2, 3);
    const neg = topViewVelocity(-2, 3);
    expect(neg.vxi).toBeCloseTo(-pos.vxi, 5);
    expect(neg.veta).toBeCloseTo(pos.veta, 5);
  });

  it('is symmetric about eta=0 — veta same, vxi flips', () => {
    const top = topViewVelocity(1.5, 2);
    const bot = topViewVelocity(1.5, -2);
    expect(bot.veta).toBeCloseTo(top.veta, 4);
    expect(bot.vxi).toBeCloseTo(-top.vxi, 4);
  });

  it('returns finite numbers for large coordinates', () => {
    const v = topViewVelocity(1000, 1000);
    expect(isFinite(v.vxi)).toBe(true);
    expect(isFinite(v.veta)).toBe(true);
  });
});

describe('pressureCoeff', () => {
  it('returns 1 at stagnation (zero velocity)', () => {
    expect(pressureCoeff(0, 0)).toBe(1);
  });

  it('returns 0 in freestream (vxi=0, veta=1)', () => {
    expect(pressureCoeff(0, 1)).toBe(0);
  });

  it('returns negative in suction zones (speed > 1)', () => {
    const v = topViewVelocity(1.05, 0);
    const cp = pressureCoeff(v.vxi, v.veta);
    expect(cp).toBeLessThan(0);
  });

  it('returns value ≤ 1 always', () => {
    [[0, 0], [1, 0], [0, 1], [2, 3], [1.5, 0]].forEach(([vx, ve]) => {
      expect(pressureCoeff(vx, ve)).toBeLessThanOrEqual(1);
    });
  });
});

describe('cpToColor', () => {
  it('cp=+1 (stagnation) is red-ish — r close to 1, b close to 0', () => {
    const c = cpToColor(1);
    expect(c.r).toBeGreaterThan(0.8);
    expect(c.b).toBeLessThan(0.2);
  });

  it('cp=−3 (high suction) is blue-ish — b close to 1, r close to 0', () => {
    const c = cpToColor(-3);
    expect(c.b).toBeGreaterThan(0.8);
    expect(c.r).toBeLessThan(0.2);
  });

  it('all channels are in [0, 1] for various cp values', () => {
    [-3, -2, -1, 0, 0.5, 1].forEach(cp => {
      const c = cpToColor(cp);
      expect(c.r).toBeGreaterThanOrEqual(0);
      expect(c.r).toBeLessThanOrEqual(1);
      expect(c.g).toBeGreaterThanOrEqual(0);
      expect(c.g).toBeLessThanOrEqual(1);
      expect(c.b).toBeGreaterThanOrEqual(0);
      expect(c.b).toBeLessThanOrEqual(1);
    });
  });

  it('clamps out-of-range cp values gracefully', () => {
    const high = cpToColor(5);
    const low  = cpToColor(-10);
    expect(high.r).toBeCloseTo(1, 2);
    expect(low.b).toBeCloseTo(1, 2);
  });

  it('cp=0 (freestream) is greenish', () => {
    const c = cpToColor(0);
    expect(c.g).toBeGreaterThan(0.5);
  });
});

describe('traceStreamlinePath', () => {
  it('returns an array of objects with xi, eta, vxi, veta fields', () => {
    const path = traceStreamlinePath(0, -5, 10, 0.1);
    expect(path.length).toBeGreaterThan(0);
    const pt = path[0];
    expect(pt).toHaveProperty('xi');
    expect(pt).toHaveProperty('eta');
    expect(pt).toHaveProperty('vxi');
    expect(pt).toHaveProperty('veta');
  });

  it('seed point is the first point in path', () => {
    const path = traceStreamlinePath(2, -5, 20, 0.1);
    expect(path[0].xi).toBeCloseTo(2, 5);
    expect(path[0].eta).toBeCloseTo(-5, 5);
  });

  it('generally flows in the +eta direction', () => {
    const path = traceStreamlinePath(3, -8, 30, 0.2);
    // Last eta should be greater than first eta
    expect(path[path.length - 1].eta).toBeGreaterThan(path[0].eta);
  });

  it('returns at most `steps` points', () => {
    const path = traceStreamlinePath(0, -5, 15, 0.2);
    expect(path.length).toBeLessThanOrEqual(15);
  });

  it('stops before entering the body', () => {
    // Streamline headed straight at the body
    const path = traceStreamlinePath(0, -5, 200, 0.05);
    path.forEach(pt => {
      const r2 = pt.xi * pt.xi + pt.eta * pt.eta;
      expect(r2).toBeGreaterThan(1);
    });
  });

  it('symmetric seed produces symmetric path (mirrored xi)', () => {
    const pathR = traceStreamlinePath(2, -6, 20, 0.15);
    const pathL = traceStreamlinePath(-2, -6, 20, 0.15);
    // They should have the same length
    expect(pathL.length).toBe(pathR.length);
    // xi values should be mirrored
    pathR.forEach((pt, i) => {
      expect(pathL[i].xi).toBeCloseTo(-pt.xi, 3);
      expect(pathL[i].eta).toBeCloseTo(pt.eta, 3);
    });
  });
});

describe('vortexVelocity', () => {
  it('returns {0,0} at the vortex centre', () => {
    const v = vortexVelocity(1, 2, 1, 2, 1.0, 0.1);
    expect(v.vxi).toBeCloseTo(0, 10);
    expect(v.veta).toBeCloseTo(0, 10);
  });

  it('speed decreases with distance outside the core', () => {
    const gamma = 1.0, rc = 0.1;
    const x0 = 0, e0 = 0;
    const r1 = 0.5, r2 = 1.0; // both outside core
    const v1 = vortexVelocity(r1, 0, x0, e0, gamma, rc);
    const v2 = vortexVelocity(r2, 0, x0, e0, gamma, rc);
    const speed1 = Math.sqrt(v1.vxi ** 2 + v1.veta ** 2);
    const speed2 = Math.sqrt(v2.vxi ** 2 + v2.veta ** 2);
    expect(speed1).toBeGreaterThan(speed2);
  });

  it('speed increases with distance inside the core (solid body)', () => {
    const gamma = 1.0, rc = 2.0; // large core so r=0.5 and r=1.0 are inside
    const v1 = vortexVelocity(0.5, 0, 0, 0, gamma, rc);
    const v2 = vortexVelocity(1.0, 0, 0, 0, gamma, rc);
    const speed1 = Math.sqrt(v1.vxi ** 2 + v1.veta ** 2);
    const speed2 = Math.sqrt(v2.vxi ** 2 + v2.veta ** 2);
    expect(speed2).toBeGreaterThan(speed1);
  });

  it('velocity is tangential — perpendicular to radial direction', () => {
    const v = vortexVelocity(1, 0, 0, 0, 1.0, 0.1);
    // At (1,0), radial direction is (1,0), so velocity should be purely in eta direction
    expect(v.vxi).toBeCloseTo(0, 5);
    expect(Math.abs(v.veta)).toBeGreaterThan(0.01);
  });

  it('returns finite values for all inputs', () => {
    const v = vortexVelocity(5, 3, 1, 1, 2.0, 0.3);
    expect(isFinite(v.vxi)).toBe(true);
    expect(isFinite(v.veta)).toBe(true);
  });
});
