/**
 * physics.js — Pure math helpers extracted from main.js
 * No Three.js dependency; fully testable with vitest.
 */

/**
 * Wheel rotation rate in rotations per second.
 * @param {number} speedKmh - speed in km/h
 * @param {number} circumferenceM - tyre circumference in metres
 */
export function wheelRotationRate(speedKmh, circumferenceM) {
  return (speedKmh / 3.6) / circumferenceM;
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
