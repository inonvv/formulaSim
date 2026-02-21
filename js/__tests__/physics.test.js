import { describe, it, expect } from 'vitest';
import {
  gearFromSpeed,
  wheelRotationRate,
  aeroSquishFactor,
  rpmRatio,
  lerpSpeed,
} from '../physics.js';

describe('gearFromSpeed', () => {
  it('returns 0 (neutral) at speed 0', () => {
    expect(gearFromSpeed(0)).toBe(0);
  });

  it('returns 0 just below 5 km/h', () => {
    expect(gearFromSpeed(4.9)).toBe(0);
  });

  it('returns 1 at 5 km/h', () => {
    expect(gearFromSpeed(5)).toBe(1);
  });

  it('returns 1 at 49 km/h', () => {
    expect(gearFromSpeed(49)).toBe(1);
  });

  it('returns 2 at 50 km/h', () => {
    expect(gearFromSpeed(50)).toBe(2);
  });

  it('returns 4 at 180 km/h', () => {
    expect(gearFromSpeed(180)).toBe(4);
  });

  it('returns 8 at 340 km/h', () => {
    expect(gearFromSpeed(340)).toBe(8);
  });

  it('returns 8 at 350 km/h', () => {
    expect(gearFromSpeed(350)).toBe(8);
  });

  it('is monotone — gear never decreases as speed increases', () => {
    const speeds = [0, 10, 30, 50, 80, 100, 150, 200, 250, 300, 340, 350];
    let prev = 0;
    for (const s of speeds) {
      const g = gearFromSpeed(s);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
});

describe('wheelRotationRate', () => {
  it('returns 0 at speed 0', () => {
    expect(wheelRotationRate(0, 2.09)).toBe(0);
  });

  it('returns ~13.29 rps at 100 km/h with 2.09 m circumference', () => {
    expect(wheelRotationRate(100, 2.09)).toBeCloseTo(13.29, 1);
  });

  it('doubles when speed doubles', () => {
    const r1 = wheelRotationRate(100, 2.09);
    const r2 = wheelRotationRate(200, 2.09);
    expect(r2).toBeCloseTo(r1 * 2, 5);
  });

  it('halves when circumference doubles', () => {
    const r1 = wheelRotationRate(100, 2.0);
    const r2 = wheelRotationRate(100, 4.0);
    expect(r2).toBeCloseTo(r1 / 2, 5);
  });
});

describe('aeroSquishFactor', () => {
  it('returns exactly 1 at speed 0', () => {
    expect(aeroSquishFactor(0)).toBe(1);
  });

  it('returns a value > 0.95 at 350 km/h (still close to 1)', () => {
    expect(aeroSquishFactor(350)).toBeGreaterThan(0.95);
  });

  it('returns a value < 1 at any positive speed', () => {
    expect(aeroSquishFactor(100)).toBeLessThan(1);
    expect(aeroSquishFactor(200)).toBeLessThan(1);
  });

  it('decreases as speed increases', () => {
    expect(aeroSquishFactor(200)).toBeLessThan(aeroSquishFactor(100));
  });

  it('clamps at maxSpeed — beyond 350 gives same result as 350', () => {
    expect(aeroSquishFactor(350)).toBeCloseTo(aeroSquishFactor(400), 5);
  });
});

describe('rpmRatio', () => {
  it('returns 0 at speed 0', () => {
    expect(rpmRatio(0)).toBe(0);
  });

  it('returns ~0.5 at 175 km/h', () => {
    expect(rpmRatio(175)).toBeCloseTo(0.5, 2);
  });

  it('returns 1 at 350 km/h', () => {
    expect(rpmRatio(350)).toBe(1);
  });

  it('clamps to 1 above 350 km/h', () => {
    expect(rpmRatio(400)).toBe(1);
    expect(rpmRatio(1000)).toBe(1);
  });

  it('accepts a custom maxSpeed', () => {
    expect(rpmRatio(100, 200)).toBeCloseTo(0.5, 5);
  });
});

describe('lerpSpeed', () => {
  it('snaps to target when within ±0.5 km/h', () => {
    expect(lerpSpeed(99.8, 100, 60, 90, 0.016)).toBe(100);
    expect(lerpSpeed(100.3, 100, 60, 90, 0.016)).toBe(100);
  });

  it('accelerates toward higher target', () => {
    const next = lerpSpeed(0, 100, 60, 90, 1);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(100);
  });

  it('decelerates toward lower target', () => {
    const next = lerpSpeed(200, 100, 60, 90, 1);
    expect(next).toBeLessThan(200);
    expect(next).toBeGreaterThanOrEqual(100);
  });

  it('does not overshoot target when accelerating', () => {
    // Large dt — should be clamped to target, not beyond
    const next = lerpSpeed(0, 50, 60, 90, 10);
    expect(next).toBe(50);
  });

  it('does not overshoot target when decelerating', () => {
    const next = lerpSpeed(100, 50, 60, 90, 10);
    expect(next).toBe(50);
  });

  it('decelerates faster than it accelerates for same |diff|', () => {
    const accel = lerpSpeed(0, 100, 60, 90, 1) - 0;
    const decel = 100 - lerpSpeed(100, 0, 60, 90, 1);
    expect(decel).toBeGreaterThan(accel);
  });

  it('returns current speed unchanged when target equals current (within snap)', () => {
    expect(lerpSpeed(100, 100, 60, 90, 0.016)).toBe(100);
  });
});
