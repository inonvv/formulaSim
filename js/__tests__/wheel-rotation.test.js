/**
 * wheel-rotation.test.js — Phase 4 of glb-wheels-split-and-render.
 *
 * The animate-loop in main.js iterates state.wheels (populated either from
 * grp.userData.wheels (GLB path) or from WHEEL_NAMES traversal (procedural))
 * and rotates each around local X by `wheelRotationRate(speed, 2πr) * dt * 2π`
 * radians per frame. This test exercises the core rotation pattern:
 *   - A single dt tick increments each wheel's .rotation.x by the same delta.
 *   - Four wheels starting at four different angles remain distinct after a
 *     tick (they don't collapse to one parent spinner).
 *
 * The rotation formula is re-implemented here rather than imported from
 * main.js (which has DOM-dependent side effects). wheelRotationRate itself
 * is tested thoroughly in physics.test.js.
 */

import { describe, it, expect } from 'vitest';
import { wheelRotationRate } from '../physics.js';

/* Stand-in for a wheel object — minimal rotation.x support. */
function makeWheel(initialX = 0) {
  return { rotation: { x: initialX } };
}

/**
 * Mirror of main.js animateCar's wheel-spin pass.
 * Rotates every object in `wheels` around local X by the same delta.
 */
function tickWheels(wheels, speedKmh, dt, wheelRadius) {
  const rotPerSec = wheelRotationRate(speedKmh, 2 * Math.PI * wheelRadius);
  const dRot = rotPerSec * dt * Math.PI * 2;
  Object.values(wheels).forEach(w => { if (w) w.rotation.x += dRot; });
  return dRot;
}

describe('wheel rotation tick — Phase 4', () => {
  it('WR1. 4 wheels each get rotation.x incremented by the same delta per tick', () => {
    const wheels = { FL: makeWheel(), FR: makeWheel(), RL: makeWheel(), RR: makeWheel() };
    const dRot = tickWheels(wheels, 100, 1 / 60, 0.44);
    expect(wheels.FL.rotation.x).toBeCloseTo(dRot, 10);
    expect(wheels.FR.rotation.x).toBeCloseTo(dRot, 10);
    expect(wheels.RL.rotation.x).toBeCloseTo(dRot, 10);
    expect(wheels.RR.rotation.x).toBeCloseTo(dRot, 10);
  });

  it('WR2. independence — 4 wheels with distinct starting angles stay distinct after tick', () => {
    const wheels = {
      FL: makeWheel(0.10),
      FR: makeWheel(0.20),
      RL: makeWheel(0.30),
      RR: makeWheel(0.40),
    };
    tickWheels(wheels, 100, 1 / 60, 0.44);
    // All differ from each other by the original spacing (0.10) — confirming
    // they're NOT parented to a common rotating object.
    const xs = [wheels.FL.rotation.x, wheels.FR.rotation.x, wheels.RL.rotation.x, wheels.RR.rotation.x];
    expect(new Set(xs).size).toBe(4);
    expect(wheels.FR.rotation.x - wheels.FL.rotation.x).toBeCloseTo(0.10, 10);
    expect(wheels.RL.rotation.x - wheels.FR.rotation.x).toBeCloseTo(0.10, 10);
  });

  it('WR3. rotation rate scales with radius: same speed, smaller wheel spins faster', () => {
    const bigWheel   = { FL: makeWheel() };
    const smallWheel = { FL: makeWheel() };
    tickWheels(bigWheel,   100, 1 / 60, 0.44);
    tickWheels(smallWheel, 100, 1 / 60, 0.30);
    expect(Math.abs(smallWheel.FL.rotation.x)).toBeGreaterThan(Math.abs(bigWheel.FL.rotation.x));
  });

  it('WR4. zero speed → zero delta', () => {
    const wheels = { FL: makeWheel(1.23) };
    tickWheels(wheels, 0, 1 / 60, 0.44);
    expect(wheels.FL.rotation.x).toBeCloseTo(1.23, 10);
  });

  it('WR5. undefined entry is skipped without throwing', () => {
    const wheels = { FL: makeWheel(), FR: undefined, RL: makeWheel() };
    expect(() => tickWheels(wheels, 50, 1 / 60, 0.44)).not.toThrow();
    expect(wheels.FL.rotation.x).toBeGreaterThan(0);
    expect(wheels.RL.rotation.x).toBeGreaterThan(0);
  });
});

/* ── Brake-glow loop guard (mirrors main.js animateCar) ────────────
 * The brake-glow pass walks Object.values(state.brakes) and writes
 * `b.material.emissiveIntensity`. If any entry lacks `.material` (a future
 * GLB extraction wrapping discs in an empty parent, a test fixture, etc.),
 * the loop must skip it rather than throw and kill the render frame. */
function tickBrakeGlow(brakes, brakeGlow) {
  Object.values(brakes).forEach(b => {
    if (b?.material) b.material.emissiveIntensity = brakeGlow * brakeGlow * 1.2;
  });
}

describe('brake glow loop — defensive guard', () => {
  it('BG1. material entry writes emissiveIntensity', () => {
    const brakes = { brake_FL: { material: { emissiveIntensity: 0 } } };
    tickBrakeGlow(brakes, 0.5);
    expect(brakes.brake_FL.material.emissiveIntensity).toBeCloseTo(0.5 * 0.5 * 1.2, 10);
  });

  it('BG2. entry without .material does not throw', () => {
    const brakes = {
      brake_FL: { material: { emissiveIntensity: 0 } },
      brake_FR: {},   // ← no material — must skip
      brake_RL: null, // ← null entry — must skip
    };
    expect(() => tickBrakeGlow(brakes, 0.5)).not.toThrow();
    expect(brakes.brake_FL.material.emissiveIntensity).toBeGreaterThan(0);
  });

  it('BG3. completely empty brakes object is a no-op', () => {
    expect(() => tickBrakeGlow({}, 1.0)).not.toThrow();
  });
});
