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
 * Optional height-aware body (plan airflow-part-precision Phase 2):
 * `body = { rw, rl, etaC }` evaluates the same doublet at the scaled,
 * z-offset coordinates xi' = xi/rw, eta' = (eta − etaC)/rl — a per-height
 * cross-section cylinder (halo band pinches to the cockpit, wing band to
 * the wing planform). `{rw:1, rl:1, etaC:0}` ≡ default unit cylinder.
 * A non-positive rw/rl means NO body at this height → pure freestream.
 *
 * @param {number} xi
 * @param {number} eta
 * @param {{rw:number, rl:number, etaC:number}} [body]
 * @returns {{vxi: number, veta: number}}
 */
export function topViewVelocity(xi, eta, body) {
  if (body) {
    if (!(body.rw > 0) || !(body.rl > 0)) return { vxi: 0, veta: 1 };
    const xs = xi / body.rw;
    const es = (eta - (body.etaC || 0)) / body.rl;
    const r2 = xs * xs + es * es;
    if (r2 <= 1) return { vxi: 0, veta: 0 };
    const r4 = r2 * r2;
    // Streamlines of the scaled field map back through the scaling:
    // (dxi, deta) ∝ (rw·vxs, rl·ves), normalized so freestream veta = 1
    // ⇒ vxi picks up the aspect factor rw/rl. Without it the integration
    // distorts the direction and paths stagnate INTO short bodies instead
    // of diverting around them.
    return {
      vxi:  (-2 * xs * es / r4) * (body.rw / body.rl),
      veta:  1 - (es * es - xs * xs) / r4,
    };
  }
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
 * Local flow speed as a fraction of freestream, from the pressure
 * coefficient (inverse Bernoulli): Cp = 1 − (V/V∞)²  ⟹  V/V∞ = √(1 − Cp).
 * Suction (Cp < 0) means faster-than-freestream flow — the venturi effect.
 * Cp ≥ 1 (super-stagnation from numeric overshoot) clamps to 0.
 *
 * @param {number} cp
 * @returns {number} V/V∞ ≥ 0
 */
export function venturiSpeedRatio(cp) {
  return Math.sqrt(Math.max(0, 1 - cp));
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
 * Trace a single streamline by RK4 integration.
 * Returns an array of sample points, each with position and velocity.
 * Stops early if the path enters the body (r² ≤ 1).
 *
 * When `opts.occupancy` is provided, each integration step also consults a
 * body occupancy field. If the post-step point lands inside the body, the
 * step is projected along the negative gradient (slides along the surface).
 * If still inside after projection, the streamline terminates.
 *
 * @param {number} seedXi   - starting xi coordinate (|eta| seed should be ≥ 2)
 * @param {number} seedEta  - starting eta coordinate
 * @param {number} steps    - maximum number of integration steps
 * @param {number} stepSize - Euler step size (ds)
 * @param {object} [opts]   - optional modifiers
 * @param {{sample:(x:number,y:number,z:number)=>number,
 *          gradient:(x:number,y:number,z:number)=>{x:number,y:number,z:number}}}
 *          [opts.occupancy] - binary occupancy field (from body-sdf.js)
 * @param {(xi:number,eta:number)=>{x:number,y:number,z:number}}
 *          [opts.toWorld]   - map (xi,eta) → world-(x,y,z). Defaults to
 *                             treating (xi,eta) as world-(z,y) with x=0.
 * @param {Array<object>} [opts.modifiers] - optional analytical flow modifiers
 *          (sinks / sources / vortices) summed on top of `topViewVelocity`
 *          via `sumVelocity`. Omitted or empty ⇒ identical to the pure
 *          cylinder flow (zero-regression path).
 * @param {{rw:number, rl:number, etaC:number}} [opts.body] - height-aware
 *          body cross-section forwarded to `topViewVelocity` (and, through
 *          `sumVelocity` opts, to the base field under modifiers). Omitted
 *          ⇒ the default whole-car unit cylinder.
 * @param {number} [opts.seedY]  - seed height (m, car-local) for modifier
 *          y-band gating in `sumVelocity`.
 * @param {number} [opts.halfW]  - physical flow-plane half-dims, needed by
 * @param {number} [opts.halfL]    physical-space modifiers (tire doublets).
 * @returns {Array<{xi: number, eta: number, vxi: number, veta: number}>}
 */
export function traceStreamlinePath(seedXi, seedEta, steps = 200, stepSize = 0.14, opts = {}) {
  const path = [];
  let xi = seedXi, eta = seedEta;

  const occupancy = opts.occupancy || null;
  const toWorld   = opts.toWorld   || ((xi_, eta_) => ({ x: 0, y: eta_, z: xi_ }));
  const modifiers = opts.modifiers || null;
  const hasMods   = Array.isArray(modifiers) && modifiers.length > 0;
  const body      = opts.body || null;
  const flowOpts  = (body || opts.seedY !== undefined || opts.halfW !== undefined)
    ? { body, y: opts.seedY, halfW: opts.halfW, halfL: opts.halfL }
    : undefined;

  function insideBody(x, e) {
    if (body) {
      if (!(body.rw > 0) || !(body.rl > 0)) return false;   // no body at this height
      const xs = x / body.rw;
      const es = (e - (body.etaC || 0)) / body.rl;
      return xs * xs + es * es <= 1;
    }
    return x * x + e * e <= 1;
  }

  function normalizedDir(x, e) {
    const { vxi, veta } = hasMods
      ? sumVelocity(x, e, topViewVelocity, modifiers, flowOpts)
      : topViewVelocity(x, e, body);
    const spd = Math.sqrt(vxi * vxi + veta * veta);
    if (spd < 1e-6) return { dxi: 0, deta: 0, vxi, veta, spd: 0 };
    return { dxi: vxi / spd, deta: veta / spd, vxi, veta, spd };
  }

  for (let i = 0; i < steps; i++) {
    const k1 = normalizedDir(xi, eta);
    path.push({ xi, eta, vxi: k1.vxi, veta: k1.veta });
    if (k1.spd < 1e-6) break;

    const k2 = normalizedDir(xi + 0.5 * stepSize * k1.dxi, eta + 0.5 * stepSize * k1.deta);
    if (k2.spd < 1e-6) break;
    const k3 = normalizedDir(xi + 0.5 * stepSize * k2.dxi, eta + 0.5 * stepSize * k2.deta);
    if (k3.spd < 1e-6) break;
    const k4 = normalizedDir(xi +       stepSize * k3.dxi, eta +       stepSize * k3.deta);

    let nextXi  = xi  + (stepSize / 6) * (k1.dxi  + 2 * k2.dxi  + 2 * k3.dxi  + k4.dxi);
    let nextEta = eta + (stepSize / 6) * (k1.deta + 2 * k2.deta + 2 * k3.deta + k4.deta);

    if (occupancy) {
      const w = toWorld(nextXi, nextEta);
      if (occupancy.sample(w.x, w.y, w.z) > 0.5) {
        // Slide along the surface — subtract the component of the step vector
        // projected onto the gradient direction.
        const g   = occupancy.gradient(w.x, w.y, w.z);
        const gMag = Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
        if (gMag > 1e-9) {
          const nx = g.x / gMag, ny = g.y / gMag, nz = g.z / gMag;
          const dXi  = nextXi  - xi;
          const dEta = nextEta - eta;
          // Approximate step vector in world from (dXi, dEta) using toWorld-
          // equivalent axes: treat dXi → world Z, dEta → world Y (caller
          // supplies the real mapping via toWorld; the projection uses those
          // world-space components anyway).
          const wNow  = toWorld(xi, eta);
          const stepWx = w.x - wNow.x;
          const stepWy = w.y - wNow.y;
          const stepWz = w.z - wNow.z;
          const dotN   = stepWx * nx + stepWy * ny + stepWz * nz;
          const projWx = stepWx - dotN * nx;
          const projWy = stepWy - dotN * ny;
          const projWz = stepWz - dotN * nz;
          const projX  = wNow.x + projWx;
          const projY  = wNow.y + projWy;
          const projZ  = wNow.z + projWz;
          // Translate the projected world-space back into (xi,eta) — since
          // toWorld is one-to-one lookup for our axes, we approximate the
          // reverse via the unchanged component mapping: Z→xi, Y→eta.
          // Callers supplying a non-default toWorld should note this
          // projection is an approximation; inside means the path is trying
          // to enter the body, so we err toward terminating on repeated
          // contact instead of drifting.
          const projStillInside = occupancy.sample(projX, projY, projZ) > 0.5;
          if (projStillInside) break;
          // We can't cleanly invert a user-supplied toWorld, so use the step
          // remaining in (dXi,dEta) scaled by (1 - |dotN|/|stepWorld|) as a
          // safe approximation to keep the path moving.
          const stepMag = Math.sqrt(stepWx * stepWx + stepWy * stepWy + stepWz * stepWz);
          const slideScale = stepMag > 1e-9
            ? Math.max(0, Math.min(1, 1 - Math.abs(dotN) / stepMag))
            : 0;
          nextXi  = xi  + dXi  * slideScale;
          nextEta = eta + dEta * slideScale;
        } else {
          // Gradient ~0 means the sample is deep inside — terminate.
          break;
        }
      }
    }

    // Analytic-body slide (plan airflow-part-precision Phase 4): strong
    // sinks can drag a path INTO the body cylinder mid-flight; terminating
    // there killed most ribbons at the nose. Instead project the point
    // radially (in scaled space) just outside the surface — the ribbon
    // hugs the body and continues downstream, matching the occupancy-slide
    // behavior. A stalled projection (stagnation line) still terminates.
    if (insideBody(nextXi, nextEta)) {
      let px = nextXi, pe = nextEta;
      if (body) {
        const xs = px / body.rw;
        const es = (pe - (body.etaC || 0)) / body.rl;
        const r  = Math.hypot(xs, es) || 1e-9;
        const s  = 1.001 / r;
        px = xs * s * body.rw;
        pe = es * s * body.rl + (body.etaC || 0);
      } else {
        const r = Math.hypot(px, pe) || 1e-9;
        const s = 1.001 / r;
        px *= s;
        pe *= s;
      }
      // Terminate when surface progress collapses — either a stagnation
      // line or a vent sink pinning the path against the wall (air being
      // ingested). 0.25·step keeps genuine tangential slides alive (they
      // retain near-full step length) while killing sub-crawl loops.
      if (Math.hypot(px - xi, pe - eta) < stepSize * 0.25) break;
      nextXi = px;
      nextEta = pe;
    }

    xi  = nextXi;
    eta = nextEta;
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
 * Analytical point-sink velocity contribution at (xi, eta) from a sink
 * centred at (x0, e0) with visual strength `strength` and Rankine-core
 * regularisation radius `rc`.
 *
 * Math: with dx = xi - x0, de = eta - e0, r2 = dx² + de² + rc²
 *   vxi  = -strength · dx / r2
 *   veta = -strength · de / r2
 *
 * At r = 0 the (x², y²) + rc² denominator avoids the singularity. As r → ∞,
 * the contribution decays like 1/r (consistent with a 2-D potential sink).
 *
 * NOTE: `strength` is a VISUAL approximation, not a calibrated mass-flow
 * rate — tuned per-feature in `effects.js`.
 *
 * @param {number} xi
 * @param {number} eta
 * @param {number} x0   - sink centre xi
 * @param {number} e0   - sink centre eta
 * @param {number} [strength=0.2]
 * @param {number} [rc=0.12] - core-regularisation radius
 * @returns {{vxi: number, veta: number}}
 */
export function sinkVelocity(xi, eta, x0, e0, strength = 0.2, rc = 0.12) {
  const dx = xi  - x0;
  const de = eta - e0;
  const r2 = dx * dx + de * de + rc * rc;
  return {
    vxi:  -strength * dx / r2,
    veta: -strength * de / r2,
  };
}

/**
 * Analytical point-source velocity contribution (opposite sign of `sinkVelocity`).
 * Pushes fluid radially outward from (x0, e0).
 *
 * NOTE: `strength` is a VISUAL approximation.
 *
 * @param {number} xi
 * @param {number} eta
 * @param {number} x0
 * @param {number} e0
 * @param {number} [strength=0.2]
 * @param {number} [rc=0.12]
 * @returns {{vxi: number, veta: number}}
 */
export function sourceVelocity(xi, eta, x0, e0, strength = 0.2, rc = 0.12) {
  const dx = xi  - x0;
  const de = eta - e0;
  const r2 = dx * dx + de * de + rc * rc;
  return {
    vxi:  strength * dx / r2,
    veta: strength * de / r2,
  };
}

/**
 * Linear superposition of a base velocity field with a list of analytical
 * modifiers (sinks, sources, vortices). The base field is evaluated at
 * (xi, eta) via `baseFn`; each modifier adds its own contribution.
 *
 * Modifier shape:
 *   { type: 'sink'   | 'source',  x, e, strength, rc }
 *   { type: 'vortex',             x, e, gamma,    rc }
 * (Fields `x` and `e` are the modifier's xi/eta centre — naming shortened
 * to keep the table declarations compact in `effects.js`.)
 *
 * Empty or missing modifier list ⇒ identical to `baseFn(xi, eta)`.
 *
 * Optional `opts` (plan airflow-part-precision Phases 2-3):
 *   opts.body  — height-aware cross-section forwarded to `baseFn`.
 *   opts.y     — evaluation height (m, car-local). Modifiers carrying a
 *                `yBand: [lo, hi]` are SKIPPED when y falls outside it
 *                (per-part locality). No opts.y ⇒ no gating (CFD path).
 *   opts.halfW/opts.halfL — physical flow-plane half-dims. Required by
 *                'doublet' modifiers (tire bluff bodies), which evaluate in
 *                physical car-local xz so wheels stay circular; doublets
 *                are skipped when the dims are absent.
 *
 * @param {number} xi
 * @param {number} eta
 * @param {(xi:number, eta:number, body?:object)=>{vxi:number, veta:number}} baseFn
 * @param {Array<object>} [modifiers=[]]
 * @param {{body?:object, y?:number, halfW?:number, halfL?:number}} [opts]
 * @returns {{vxi: number, veta: number}}
 */
export function sumVelocity(xi, eta, baseFn, modifiers = [], opts) {
  const base = baseFn(xi, eta, opts?.body);
  let vxi = base.vxi, veta = base.veta;
  if (!modifiers || modifiers.length === 0) return { vxi, veta };
  const gateY = opts && Number.isFinite(opts.y);
  const hasDims = opts && Number.isFinite(opts.halfW) && Number.isFinite(opts.halfL);
  for (const m of modifiers) {
    if (gateY && Array.isArray(m.yBand) && (opts.y < m.yBand[0] || opts.y > m.yBand[1])) {
      continue;   // part-local modifier — this height doesn't see it
    }
    let c;
    if (m.type === 'sink') {
      c = sinkVelocity(xi, eta, m.x, m.e, m.strength, m.rc);
    } else if (m.type === 'source') {
      c = sourceVelocity(xi, eta, m.x, m.e, m.strength, m.rc);
    } else if (m.type === 'vortex') {
      c = vortexVelocity(xi, eta, m.x, m.e, m.gamma, m.rc);
    } else if (m.type === 'doublet') {
      if (!hasDims) continue;   // physical-space modifier needs real dims
      const p = doubletVelocity(
        xi * opts.halfW, eta * opts.halfL,
        m.x * opts.halfW, m.e * opts.halfL,
        m.R, m.rc
      );
      // Physical→(xi,eta): freestream (veta=1) maps to a physical speed of
      // halfL per unit parameter, so a dimensionless physical perturbation
      // (freestream=1) contributes vxi += pvx·halfL/halfW, veta += pvz.
      c = { vxi: p.vx * (opts.halfL / opts.halfW), veta: p.vz };
    } else {
      continue;
    }
    vxi  += c.vxi;
    veta += c.veta;
  }
  return { vxi, veta };
}

/**
 * Ideal-cylinder (doublet) bluff-body perturbation in PHYSICAL 2-D
 * coordinates — used for tires, which must stay circular regardless of the
 * anisotropic (xi, eta) normalization. Uniform flow of speed 1 in +z past
 * a cylinder of radius R centred at (x0, z0); returns the PERTURBATION
 * only (freestream excluded), Rankine-regularized with core radius rc:
 *
 *   r²  = dx² + dz² + rc²
 *   vx  = −2·R²·dx·dz / r⁴
 *   vz  = −R²·(dz² − dx²) / r⁴
 *
 * @param {number} x    - sample x (m)
 * @param {number} z    - sample z (m)
 * @param {number} x0   - cylinder centre x (m)
 * @param {number} z0   - cylinder centre z (m)
 * @param {number} [R=0.28]   - cylinder radius (m)
 * @param {number} [rc=0.08]  - regularization core radius (m)
 * @returns {{vx: number, vz: number}}
 */
export function doubletVelocity(x, z, x0, z0, R = 0.28, rc = 0.08) {
  let dx = x - x0;
  let dz = z - z0;
  // Solid-body interior guard: the ideal doublet's interior recirculation
  // (reversed flow for r < R) can TRAP streamlines that get numerically
  // pushed inside the cylinder. Tires are solid — project interior samples
  // onto the surface along the same ray, so the interior field equals the
  // (tangential) surface field and paths slide around instead of orbiting.
  const rRaw = Math.sqrt(dx * dx + dz * dz);
  if (rRaw < R && rRaw > 1e-9) {
    const s = R / rRaw;
    dx *= s;
    dz *= s;
  }
  const r2 = dx * dx + dz * dz + rc * rc;
  const r4 = r2 * r2;
  const R2 = R * R;
  return {
    vx: -2 * R2 * dx * dz / r4,
    vz: -R2 * (dz * dz - dx * dx) / r4,
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
