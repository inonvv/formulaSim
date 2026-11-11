import { describe, it, expect } from 'vitest';
import {
  wheelRotationRate,
  rpmRatio,
  lerpSpeed,
} from '../physics.js';

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
