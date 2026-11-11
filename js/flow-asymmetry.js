/**
 * flow-asymmetry.js — why the two sides of a car see different air in a
 * corner (pure math, no THREE / DOM).
 *
 * A cornering car is not in straight, uniform flow. In the car's own frame
 * the air arrives on a CURVE:
 *   1. Speed gradient — the outside of the car travels a bigger circle than
 *      the inside, so it meets faster air. Local speed = v·(1 + x·κ) for a
 *      point x metres to the right (κ > 0 = left turn, centre on the left).
 *      Pressure scales with speed², so the outside front-wing half, tyre and
 *      floor edge carry more load than the inside ones.
 *   2. Yaw gradient — the rear tyres run at a slip angle, so at the rear
 *      axle the air comes from the OUTSIDE of the turn; moving forward along
 *      the car the flow angle swings back toward the inside by κ per metre.
 *      The nose and the tail therefore see different crosswinds.
 *
 * Conventions: car-local x right, z rearward (nose at −z); κ > 0 and
 * ay > 0 mean a LEFT turn; flow yaw β > 0 means the air is moving toward
 * +x (it comes from the left), matching CfdEffect's sideslip.
 */

/** Typical peak slip angle of a racing slick, radians (~6°). */
export const PEAK_SLIP = 6 * Math.PI / 180;

/** Local air speed ÷ car speed at lateral position x (clamped to ±50 %). */
export function localSpeedRatio(x, kappa) {
  return Math.min(1.5, Math.max(0.5, 1 + x * kappa));
}

/** Local dynamic pressure ÷ the car's nominal dynamic pressure. */
export function localQScale(x, kappa) {
  const r = localSpeedRatio(x, kappa);
  return r * r;
}

/**
 * Rear-axle slip angle [rad], signed like the turn (+ = left turn): grows
 * with how much of the available grip the car is using.
 */
export function rearSlip(ay, ayMax) {
  if (!(ayMax > 0)) return 0;
  const u = Math.min(1, Math.abs(ay) / ayMax);
  return Math.sign(ay) * PEAK_SLIP * u;
}

/**
 * Flow yaw β [rad] at station z. At the rear axle the air comes from the
 * outside of the turn (β = −slip for a left turn); forward of it the angle
 * swings by κ per metre.
 */
export function flowYawAt(z, kappa, slip, zRear) {
  return -slip + kappa * (zRear - z);
}

/**
 * Share of a spanwise-uniform aero load carried by the left and right
 * halves of a surface of half-span h, from the speed gradient alone.
 * @returns {{left:number, right:number}} fractions summing to 1
 */
export function sideSplit(kappa, halfSpan) {
  const h = Math.abs(halfSpan);
  // ∫(1 + xκ)² dx over each half.
  const I = (a, b) => (b - a) + kappa * (b * b - a * a) + kappa * kappa * (b ** 3 - a ** 3) / 3;
  const left = I(-h, 0), right = I(0, h);
  const sum = left + right;
  return sum > 0 ? { left: left / sum, right: right / sum } : { left: 0.5, right: 0.5 };
}

/**
 * Bundle the turn state the visual layers need.
 * @param {number} kappa   path curvature under the car [1/m]
 * @param {number} ay      lateral acceleration [m/s²]
 * @param {number} ayMax   grip-limited lateral acceleration [m/s²]
 * @param {number} zRear   rear axle z in car-local metres
 */
export function turnFlow(kappa, ay, ayMax, zRear) {
  return { kappa: kappa || 0, slip: rearSlip(ay || 0, ayMax), zRear: zRear ?? 1.8 };
}
