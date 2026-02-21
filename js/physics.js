/**
 * physics.js — Pure math helpers extracted from main.js
 * No Three.js dependency; fully testable with vitest.
 */

/**
 * Returns gear index (0–8) for the given speed in km/h.
 * 0 = Neutral, 1–8 = gears.
 */
export function gearFromSpeed(speed) {
  if (speed < 5)   return 0;
  if (speed < 50)  return 1;
  if (speed < 100) return 2;
  if (speed < 160) return 3;
  if (speed < 210) return 4;
  if (speed < 265) return 5;
  if (speed < 310) return 6;
  if (speed < 340) return 7;
  return 8;
}

/**
 * Wheel rotation rate in rotations per second.
 * @param {number} speedKmh - speed in km/h
 * @param {number} circumferenceM - tyre circumference in metres
 */
export function wheelRotationRate(speedKmh, circumferenceM) {
  return (speedKmh / 3.6) / circumferenceM;
}

/**
 * Aero body squish scale factor (y-axis).
 * Returns a value slightly below 1 at high speed.
 * @param {number} speed - km/h
 * @param {number} maxSpeed
 */
export function aeroSquishFactor(speed, maxSpeed = 350) {
  return 1 - Math.min(speed / maxSpeed, 1) * 0.018;
}

/**
 * Normalised RPM ratio clamped to [0, 1].
 * @param {number} speed - km/h
 * @param {number} maxSpeed
 */
export function rpmRatio(speed, maxSpeed = 350) {
  return Math.min(speed / maxSpeed, 1);
}

/**
 * Asymmetric speed lerp — accelerates slower than it decelerates.
 * Snaps to target when within ±0.5 km/h.
 * @param {number} cur       - current speed
 * @param {number} tgt       - target speed
 * @param {number} accelUp   - km/h per second when accelerating
 * @param {number} accelDown - km/h per second when decelerating
 * @param {number} dt        - delta time in seconds
 * @returns {number} new speed
 */
export function lerpSpeed(cur, tgt, accelUp, accelDown, dt) {
  const diff = tgt - cur;
  if (Math.abs(diff) <= 0.5) return tgt;
  const accel = diff > 0 ? accelUp : accelDown;
  return cur + Math.sign(diff) * Math.min(accel * dt, Math.abs(diff));
}
