/**
 * airflow-core.js — Potential-flow math for airflow visualization
 * No Three.js dependency; fully testable with vitest.
 *
 * Coordinate system (car's local 2-D cross-section):
 *   xi  — lateral axis (car width direction)
 *   eta — longitudinal axis (freestream flows in +eta direction)
 *
 * The car body is modelled as a unit circle centred at origin.
 * Points with r² ≤ 1 are inside the body.
 */

/**
 * Potential-flow velocity around a unit cylinder.
 * Freestream in +eta direction.
 *
 * vxi  = -2·xi·eta / r⁴
 * veta = 1 − (eta²−xi²) / r⁴
 *
 * @param {number} xi
 * @param {number} eta
 * @returns {{vxi: number, veta: number}}
 */
export function topViewVelocity(xi, eta) {
  const r2 = xi * xi + eta * eta;
  if (r2 <= 1) return { vxi: 0, veta: 0 };
  const r4 = r2 * r2;
  return {
    vxi:  -2 * xi * eta / r4,
    veta:  1 - (eta * eta - xi * xi) / r4,
  };
}

/**
 * Pressure coefficient from velocity components (Bernoulli).
 * Cp = 1 − (vxi² + veta²)
 * Cp = 1 at stagnation, 0 in freestream, negative in suction zones.
 *
 * @param {number} vxi
 * @param {number} veta
 * @returns {number}
 */
export function pressureCoeff(vxi, veta) {
  return 1 - (vxi * vxi + veta * veta);
}

/**
 * Map a pressure coefficient in [−3, +1] to an RGB colour.
 * +1 (stagnation) → red
 *  0 (freestream)  → green
 * −3 (high suction)→ blue
 * All channels clamped to [0, 1].
 *
 * @param {number} cp
 * @returns {{r: number, g: number, b: number}}
 */
export function cpToColor(cp) {
  // Normalise cp from [-3, 1] to t in [0, 1]
  const t = Math.max(0, Math.min(1, (cp + 3) / 4));  // 0=blue, 1=red

  let r, g, b;
  if (t < 0.25) {
    // blue → cyan  (t 0→0.25)
    const s = t / 0.25;
    r = 0;
    g = s;
    b = 1;
  } else if (t < 0.5) {
    // cyan → green  (t 0.25→0.5)
    const s = (t - 0.25) / 0.25;
    r = 0;
    g = 1;
    b = 1 - s;
  } else if (t < 0.75) {
    // green → yellow  (t 0.5→0.75)
    const s = (t - 0.5) / 0.25;
    r = s;
    g = 1;
    b = 0;
  } else {
    // yellow → red  (t 0.75→1)
    const s = (t - 0.75) / 0.25;
    r = 1;
    g = 1 - s;
    b = 0;
  }

  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}

/**
 * Trace a single streamline by Euler integration.
 * Returns an array of sample points, each with position and velocity.
 * Stops early if the path enters the body (r² ≤ 1).
 *
 * @param {number} seedXi   - starting xi coordinate (|eta| seed should be ≥ 2)
 * @param {number} seedEta  - starting eta coordinate
 * @param {number} steps    - maximum number of integration steps
 * @param {number} stepSize - Euler step size (ds)
 * @returns {Array<{xi: number, eta: number, vxi: number, veta: number}>}
 */
export function traceStreamlinePath(seedXi, seedEta, steps, stepSize) {
  const path = [];
  let xi  = seedXi;
  let eta = seedEta;

  for (let i = 0; i < steps; i++) {
    const { vxi, veta } = topViewVelocity(xi, eta);
    path.push({ xi, eta, vxi, veta });

    // Normalise step direction by speed to keep step length consistent
    const speed = Math.sqrt(vxi * vxi + veta * veta);
    if (speed < 1e-6) break;

    xi  += (vxi  / speed) * stepSize;
    eta += (veta / speed) * stepSize;

    // Stop if entering body
    if (xi * xi + eta * eta <= 1) break;
  }

  return path;
}

/**
 * Potential-flow velocity around a unit cylinder in the SIDE (longitudinal-vertical) plane.
 * Used to compute the vertical (y) deflection of streamlines as they pass over/under the car.
 *
 * etaNorm = eta (longitudinal coordinate, car half-length units)
 * yNorm   = y normalised by car half-height
 *
 * Returns {veta, vy} — vertical component vy drives streamlines up over the nose and
 * down into the diffuser.
 *
 * @param {number} etaNorm
 * @param {number} yNorm
 * @returns {{veta: number, vy: number}}
 */
export function sideViewVelocity(etaNorm, yNorm) {
  const r2 = etaNorm * etaNorm + yNorm * yNorm;
  if (r2 <= 1) return { veta: 0, vy: 0 };
  const r4 = r2 * r2;
  return {
    veta: 1 - (etaNorm * etaNorm - yNorm * yNorm) / r4,
    vy:  -2 * etaNorm * yNorm / r4,
  };
}

/**
 * Rankine vortex velocity contribution at point (xi, eta)
 * from a vortex centred at (x0, e0) with circulation gamma
 * and core radius rc.
 *
 * Inside core (r < rc): solid-body rotation, v ∝ r
 * Outside core (r ≥ rc): irrotational, v ∝ 1/r
 *
 * @param {number} xi
 * @param {number} eta
 * @param {number} x0    - vortex centre xi
 * @param {number} e0    - vortex centre eta
 * @param {number} gamma - circulation strength (positive = CCW)
 * @param {number} rc    - core radius
 * @returns {{vxi: number, veta: number}}
 */
export function vortexVelocity(xi, eta, x0, e0, gamma, rc) {
  const dx = xi  - x0;
  const de = eta - e0;
  const r2 = dx * dx + de * de;
  const r  = Math.sqrt(r2);

  if (r < 1e-10) return { vxi: 0, veta: 0 };

  let tangentialSpeed;
  if (r < rc) {
    // Solid-body rotation inside core
    tangentialSpeed = (gamma / (2 * Math.PI * rc * rc)) * r;
  } else {
    // Irrotational outside core
    tangentialSpeed = gamma / (2 * Math.PI * r);
  }

  // Tangential direction (perpendicular to radial, CCW positive)
  return {
    vxi:  -tangentialSpeed * (de / r),
    veta:  tangentialSpeed * (dx / r),
  };
}
