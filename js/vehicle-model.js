/**
 * vehicle-model.js — the computed vehicle state (pure math, no THREE/DOM).
 *
 * Everything the simulator shows about forces reads from here: aero loads
 * from ½ρv²·C·A, the dynamic ride height those loads squeeze the car down
 * to, the load on each tyre under longitudinal + lateral weight transfer,
 * tyre grip with load sensitivity, and the speed the car can actually reach
 * or carry through a corner with the selected aero setup.
 *
 * Conventions (shared with track-path.js):
 *   • SI units throughout — N, m, m/s, kg. Ride heights are in mm.
 *   • ax > 0 accelerating (load moves to the rear axle).
 *   • ay > 0 turning LEFT (κ > 0) — load moves to the RIGHT wheels.
 *   • aero balance = fraction of total downforce carried by the FRONT axle.
 *
 * The coefficients are representative published-order-of-magnitude figures
 * for each class (see VEHICLE_PARAMS notes), not team data. The model is a
 * quasi-steady-state one: no tyre slip dynamics, no transient damping.
 */

export const RHO_AIR = 1.225;   // kg/m³, sea level 15 °C
export const G       = 9.81;    // m/s²

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp  = (a, b, t) => a + (b - a) * t;

/* ── Per-car parameters ───────────────────────────────────────────────
 * aero.*ClA / *CdA are the component areas [m²] at the REFERENCE setup
 * (wing 0.5, nominal ride height, DRS closed, zero yaw):
 *   front / rear  — the wings (scale with wing level; rear sheds with DRS)
 *   floor         — underbody + diffuser (scales with ride height)
 *   body          — everything else (constant; lift-neutral on formula cars)
 * *Pos is each component's centre of pressure as a FRONT-axle load share
 * (1 = on the front axle, 0 = on the rear axle; outside 0..1 = overhung).
 * ------------------------------------------------------------------- */
export const VEHICLE_PARAMS = {
  // 2022+ ground-effect F1: ~800 kg with driver, ~1000 hp, floor makes
  // roughly half the downforce. ClA ≈ 4.3 static, rising toward 5 as the
  // car is squeezed onto the road ⇒ downforce = weight near 190 km/h.
  F1: {
    label: 'Formula 1', mass: 800, wheelbase: 3.60, track: 1.60, cgHeight: 0.25,
    frontWeight: 0.455, powerKW: 735, driveEff: 0.92, brakeBias: 0.57,
    mu: 1.80, muLoadSens: 0.10, rollGradDeg: 0.30, pitchGradDeg: 0.22, rollDistFront: 0.52,
    wheelRate: { front: 300e3, rear: 250e3 },         // N/m per wheel (incl. heave spring)
    ride: { min: 15, nominal: 35, max: 70, opt: 16, exp: 0.45, floorMm: 4 },
    aero: {
      frontClA: 1.25, rearClA: 1.15, floorClA: 1.90, bodyClA: 0.0,
      frontPos: 1.08, rearPos: -0.12, floorPos: 0.47,
      bodyCdA: 0.62, wheelCdA: 0.28, wingCdA: 0.30, floorCdA: 0.05,
      cySlope: 2.6, yawClLoss: 0.012, yawCdGain: 0.010,
    },
    hasDRS: true, drs: { rearCl: 0.42, rearCd: 0.30 },
  },
  // FIA F2 (Dallara F2 2024): ~795 kg, ~620 hp turbo V6, wing-dominant aero.
  F2: {
    label: 'Formula 2', mass: 795, wheelbase: 3.135, track: 1.55, cgHeight: 0.27,
    frontWeight: 0.45, powerKW: 462, driveEff: 0.92, brakeBias: 0.57,
    mu: 1.65, muLoadSens: 0.10, rollGradDeg: 0.40, pitchGradDeg: 0.30, rollDistFront: 0.53,
    wheelRate: { front: 240e3, rear: 200e3 },
    ride: { min: 15, nominal: 30, max: 65, opt: 14, exp: 0.35, floorMm: 4 },
    aero: {
      frontClA: 1.00, rearClA: 0.95, floorClA: 1.05, bodyClA: 0.0,
      frontPos: 1.08, rearPos: -0.12, floorPos: 0.47,
      bodyCdA: 0.48, wheelCdA: 0.25, wingCdA: 0.22, floorCdA: 0.03,
      cySlope: 2.3, yawClLoss: 0.012, yawCdGain: 0.010,
    },
    hasDRS: true, drs: { rearCl: 0.45, rearCd: 0.35 },
  },
  // FIA F3 (Dallara F3): ~673 kg with driver, ~380 hp NA V6.
  F3: {
    label: 'Formula 3', mass: 673, wheelbase: 2.88, track: 1.50, cgHeight: 0.27,
    frontWeight: 0.45, powerKW: 283, driveEff: 0.92, brakeBias: 0.57,
    mu: 1.55, muLoadSens: 0.10, rollGradDeg: 0.45, pitchGradDeg: 0.35, rollDistFront: 0.53,
    wheelRate: { front: 200e3, rear: 170e3 },
    ride: { min: 15, nominal: 30, max: 65, opt: 14, exp: 0.30, floorMm: 4 },
    aero: {
      frontClA: 0.80, rearClA: 0.78, floorClA: 0.70, bodyClA: 0.0,
      frontPos: 1.08, rearPos: -0.12, floorPos: 0.47,
      bodyCdA: 0.40, wheelCdA: 0.22, wingCdA: 0.18, floorCdA: 0.02,
      cySlope: 2.1, yawClLoss: 0.012, yawCdGain: 0.010,
    },
    hasDRS: true, drs: { rearCl: 0.50, rearCd: 0.40 },
  },
  // Porsche 911 GT3 RS (992): 1450 kg + driver, 386 kW, rear-engined.
  // Porsche quotes 860 kg of downforce at 285 km/h ⇒ ClA ≈ 2.2 m² in the
  // high-downforce wing position; the active rear wing has a DRS mode.
  GT: {
    label: 'GT (911 GT3 RS)', mass: 1525, wheelbase: 2.457, track: 1.60, cgHeight: 0.45,
    frontWeight: 0.39, powerKW: 386, driveEff: 0.86, brakeBias: 0.62,
    mu: 1.35, muLoadSens: 0.12, rollGradDeg: 1.50, pitchGradDeg: 1.10, rollDistFront: 0.56,
    wheelRate: { front: 110e3, rear: 150e3 },
    ride: { min: 60, nominal: 90, max: 120, opt: 55, exp: 0.45, floorMm: 25 },
    aero: {
      frontClA: 0.55, rearClA: 1.00, floorClA: 0.65, bodyClA: -0.15,
      frontPos: 1.15, rearPos: -0.22, floorPos: 0.45,
      bodyCdA: 0.62, wheelCdA: 0.06, wingCdA: 0.20, floorCdA: 0.02,
      cySlope: 2.4, yawClLoss: 0.008, yawCdGain: 0.008,
    },
    hasDRS: true, drs: { rearCl: 0.40, rearCd: 0.35 },
  },
};

export function getVehicleParams(type) {
  return VEHICLE_PARAMS[type] || VEHICLE_PARAMS.F1;
}

/** Reference setup for a car: mid wing, nominal ride height, DRS shut, no yaw. */
export function defaultSetup(type) {
  return { wing: 0.5, rideHeightMm: getVehicleParams(type).ride.nominal, drs: false, yawDeg: 0 };
}

/** Clamp a user setup into the car's legal ranges (never throws on junk). */
export function normalizeSetup(type, setup = {}) {
  const p = getVehicleParams(type);
  const d = defaultSetup(type);
  const num = (v, f) => (Number.isFinite(v) ? v : f);
  return {
    wing:         clamp(num(setup.wing, d.wing), 0, 1),
    rideHeightMm: clamp(num(setup.rideHeightMm, d.rideHeightMm), p.ride.min, p.ride.max),
    drs:          !!setup.drs && p.hasDRS,
    yawDeg:       clamp(num(setup.yawDeg, 0), -12, 12),
  };
}

/** Wing level 0..1 → load multiplier 0.65..1.35 (1.0 at the 0.5 reference). */
export function wingScale(wing) {
  return 0.65 + 0.70 * clamp(wing, 0, 1);
}

/**
 * Ground-effect strength vs ride height, normalised to 1 at the car's
 * NOMINAL height. Suction grows as the floor closes on the road
 * (∝ (opt/h)^exp) until the optimum gap; below it the flow chokes and the
 * floor stalls — the mechanism behind porpoising.
 */
export function rideEffect(type, hMm) {
  const r = getVehicleParams(type).ride;
  const raw = (h) => {
    const hh = Math.max(h, 1);
    if (hh >= r.opt) return Math.pow(r.opt / hh, r.exp);
    const d = (r.opt - hh) / r.opt;          // 0 at optimum → 1 on the deck
    return 1 - 0.75 * d * d;
  };
  return raw(hMm) / raw(r.nominal);
}

/**
 * Aero coefficients for a setup at a given DYNAMIC ride height.
 * @returns {{ClA, CdA, CyA, balance, gains:{frontWing, rearWing, floor}, parts}}
 *   gains are the per-component multipliers vs the reference setup — the
 *   visual layers (CFD paint, streamlines) scale their suction by these.
 */
export function aeroCoeffs(type, setup, dynRideMm) {
  const p = getVehicleParams(type);
  const a = p.aero;
  const s = normalizeSetup(type, setup);
  const ws = wingScale(s.wing);
  const yaw = Math.abs(s.yawDeg);

  const gFront = ws;
  const gRear  = ws * (s.drs ? p.drs.rearCl : 1);
  const gFloor = rideEffect(type, Number.isFinite(dynRideMm) ? dynRideMm : s.rideHeightMm);

  // Yawed flow starves the floor edges and the wings' outboard tips.
  const yawLoss = clamp(1 - a.yawClLoss * yaw, 0.6, 1);

  const front = a.frontClA * gFront * yawLoss;
  const rear  = a.rearClA  * gRear  * yawLoss;
  const floor = a.floorClA * gFloor * yawLoss;
  const body  = a.bodyClA;
  const ClA   = front + rear + floor + body;

  // Front-axle share of the downforce = moment balance of the components.
  const moment = front * a.frontPos + rear * a.rearPos + floor * a.floorPos + body * 0.5;
  const balance = ClA > 1e-6 ? clamp(moment / ClA, 0, 1) : p.frontWeight;

  // Drag: bluff body + wheels are fixed; wing drag is induced (∝ load²).
  const wingCd = a.wingCdA * (0.35 * ws * ws + 0.65 * ws * ws * (s.drs ? p.drs.rearCd : 1));
  const CdA = (a.bodyCdA + a.wheelCdA + wingCd + a.floorCdA * gFloor) * (1 + a.yawCdGain * yaw);

  const CyA = a.cySlope * (s.yawDeg * Math.PI / 180);   // signed side-force area

  return {
    ClA, CdA, CyA, balance,
    gains: { frontWing: gFront, rearWing: gRear, floor: gFloor },
    parts: { front, rear, floor, body },
  };
}

/**
 * Aero forces at speed, with the ride height solved for self-consistently:
 * downforce compresses the springs, the lower floor makes more downforce,
 * which compresses the springs further (3 fixed-point passes converge).
 * @param {number} v — m/s
 */
export function solveAero(type, setup, v) {
  const p = getVehicleParams(type);
  const s = normalizeSetup(type, setup);
  const q = 0.5 * RHO_AIR * v * v;

  let ride = s.rideHeightMm;
  let c = aeroCoeffs(type, s, ride);
  let heaveMm = 0, heaveFront = 0, heaveRear = 0;
  for (let i = 0; i < 4; i++) {
    const df = q * c.ClA;
    heaveFront = (df * c.balance)       / (2 * p.wheelRate.front) * 1000;
    heaveRear  = (df * (1 - c.balance)) / (2 * p.wheelRate.rear)  * 1000;
    heaveMm = 0.5 * (heaveFront + heaveRear);
    // Damped update — the stall branch of rideEffect is non-monotonic.
    ride = lerp(ride, Math.max(p.ride.floorMm, s.rideHeightMm - heaveMm), 0.6);
    c = aeroCoeffs(type, s, ride);
  }
  const bottoming = s.rideHeightMm - heaveMm <= p.ride.floorMm + 0.01;

  const downforce = q * c.ClA;
  const drag      = q * c.CdA;
  return {
    q, v, ClA: c.ClA, CdA: c.CdA, balance: c.balance, gains: c.gains, parts: c.parts,
    downforce, drag, sideForce: q * c.CyA,
    downforceFront: downforce * c.balance,
    downforceRear:  downforce * (1 - c.balance),
    dragPowerKW: drag * v / 1000,
    ld: c.CdA > 0 ? c.ClA / c.CdA : 0,
    rideMm: ride, heaveMm: s.rideHeightMm - ride, heaveFrontMm: heaveFront, heaveRearMm: heaveRear,
    bottoming,
    weightRatio: downforce / (p.mass * G),   // downforce in "car weights"
  };
}

/**
 * Vertical load on each tyre [N].
 * Static weight + aero (split by balance) ± longitudinal transfer
 * (m·ax·h/L) ± lateral transfer (m·ay·h/t, split front/rear by roll
 * stiffness). A wheel can lift (0) but never pull the road up.
 */
export function wheelLoads(type, aero, ax = 0, ay = 0) {
  const p = getVehicleParams(type);
  const W = p.mass * G;
  const dLong = p.mass * ax * p.cgHeight / p.wheelbase;        // → rear axle
  const front = W * p.frontWeight       + (aero?.downforceFront ?? 0) - dLong;
  const rear  = W * (1 - p.frontWeight) + (aero?.downforceRear  ?? 0) + dLong;
  const dLat  = p.mass * ay * p.cgHeight / p.track;            // → right side
  const dF = dLat * p.rollDistFront;
  const dR = dLat * (1 - p.rollDistFront);
  const pos = (v) => Math.max(0, v);
  return {
    FL: pos(front / 2 - dF), FR: pos(front / 2 + dF),
    RL: pos(rear  / 2 - dR), RR: pos(rear  / 2 + dR),
  };
}

/** Tyre friction coefficient at a load — falls as the tyre is loaded up. */
export function tireMu(type, fz, wet = false) {
  const p = getVehicleParams(type);
  const fz0 = p.mass * G / 4;
  const mu = p.mu * (1 - p.muLoadSens * (fz / fz0 - 1));
  return Math.max(0.4, mu) * (wet ? 0.62 : 1);
}

/** Total horizontal force the four tyres can make at these loads [N]. */
export function gripCapacity(type, loads, wet = false) {
  let f = 0;
  for (const k of ['FL', 'FR', 'RL', 'RR']) f += tireMu(type, loads[k], wet) * loads[k];
  return f;
}

/** Peak steady lateral acceleration [m/s²] at speed v with this setup. */
export function maxLateralAccel(type, setup, v, wet = false) {
  const p = getVehicleParams(type);
  const aero = solveAero(type, setup, v);
  // Two passes: grip → ay → lateral transfer → (slightly lower) grip.
  let ay = gripCapacity(type, wheelLoads(type, aero, 0, 0), wet) / p.mass;
  ay = gripCapacity(type, wheelLoads(type, aero, 0, ay), wet) / p.mass;
  return ay;
}

/**
 * Fastest speed [m/s] the car can hold on a curve of curvature κ [1/m].
 * Bisection on v²·|κ| = maxLateralAccel(v): with enough downforce the grip
 * grows faster than the demand and the corner is flat (returns vCeil).
 */
export function cornerSpeedLimit(type, setup, kappa, wet = false, vCeil = 110) {
  const k = Math.abs(kappa);
  if (k < 1e-6) return vCeil;
  const ok = (v) => v * v * k <= maxLateralAccel(type, setup, v, wet);
  if (ok(vCeil)) return vCeil;
  let lo = 0, hi = vCeil;
  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Longitudinal acceleration [m/s²] for pedal inputs.
 * Drive: min(power-limited, rear-tyre traction) − drag.
 * Brake: all four tyres at their grip limit + drag (why an F1 car pulls
 * 5 g from top speed and far less at low speed).
 */
export function longAccel(type, setup, v, throttle, brake, wet = false) {
  const p = getVehicleParams(type);
  const aero = solveAero(type, setup, v);
  const loads = wheelLoads(type, aero, 0, 0);
  const dragA = aero.drag / p.mass;
  if (brake > 0) {
    return -(brake * gripCapacity(type, loads, wet) / p.mass) - dragA;
  }
  const power    = p.powerKW * 1000 * p.driveEff * throttle;
  const fPower   = power / Math.max(v, 4);
  const fTraction = tireMu(type, loads.RL, wet) * loads.RL + tireMu(type, loads.RR, wet) * loads.RR;
  return Math.min(fPower, fTraction * (throttle > 0 ? 1 : 0)) / p.mass - dragA;
}

/** Drag-limited top speed [m/s] for a setup: P·η = ½ρ·CdA·v³. */
export function topSpeed(type, setup) {
  const p = getVehicleParams(type);
  let v = 80;
  for (let i = 0; i < 6; i++) {
    const CdA = solveAero(type, setup, v).CdA;
    v = Math.cbrt(p.powerKW * 1000 * p.driveEff / (0.5 * RHO_AIR * CdA));
  }
  return v;
}

/**
 * How hard each tyre is working: demanded horizontal force ÷ available
 * (friction-circle usage, 1 = at the limit). Lateral force is shared in
 * proportion to load; drive goes to the rear axle, braking by brake bias.
 */
export function tireUsage(type, loads, ax, ay, wet = false) {
  const p = getVehicleParams(type);
  const total = loads.FL + loads.FR + loads.RL + loads.RR || 1;
  const fxTotal = p.mass * ax;
  const fyTotal = p.mass * ay;
  const out = {};
  for (const k of ['FL', 'FR', 'RL', 'RR']) {
    const fz = loads[k];
    const isFront = k[0] === 'F';
    const axleLoad = isFront ? loads.FL + loads.FR : loads.RL + loads.RR;
    const axleShare = fxTotal >= 0 ? (isFront ? 0 : 1) : (isFront ? p.brakeBias : 1 - p.brakeBias);
    const fx = axleLoad > 0 ? fxTotal * axleShare * (fz / axleLoad) : 0;
    const fy = fyTotal * (fz / total);
    const cap = tireMu(type, fz, wet) * fz;
    out[k] = cap > 1 ? Math.hypot(fx, fy) / cap : 0;
  }
  return out;
}

/* ── Driver + integrator ──────────────────────────────────────────── */

export function createVehicleState() {
  return {
    v: 0, ax: 0, ay: 0, throttle: 0, brake: 0,
    aero: null, loads: null, usage: null,
    pitchRad: 0, rollRad: 0, heaveM: 0,
    cornerLimited: false, capV: Infinity,
  };
}

/**
 * Advance the vehicle one frame.
 * @param {object} vs     — createVehicleState() result (mutated + returned)
 * @param {object} inp
 *   type, setup, dt, wet
 *   targetV   — m/s the user asked for
 *   kappa     — path curvature under the car [1/m] (left +)
 *   capV      — m/s speed cap from the corner look-ahead (Infinity = none)
 *   forcedV   — optional m/s: impose the speed (observer mode) instead of
 *               integrating the driver model
 */
export function stepVehicle(vs, inp) {
  const { type, setup, dt, wet = false } = inp;
  const p = getVehicleParams(type);
  const capV = Number.isFinite(inp.capV) ? inp.capV : Infinity;
  const want = Math.min(inp.targetV, capV);
  vs.capV = capV;
  vs.cornerLimited = capV < inp.targetV - 0.5;

  // Pedals: proportional driver (~1 pedal per 3 m/s of error) on top of a
  // feed-forward that holds the throttle needed to cancel drag at `want`.
  const err = want - vs.v;
  const aeroNow = solveAero(type, setup, vs.v);
  const hold = clamp(aeroNow.drag * vs.v / (p.powerKW * 1000 * p.driveEff), 0, 1);
  let throttle = 0, brake = 0;
  if (err >= -0.05) throttle = clamp(hold + Math.max(err, 0) / 3, 0, 1);
  else brake = clamp(-err / 3, 0, 1);

  const vPrev = vs.v;
  if (Number.isFinite(inp.forcedV)) {
    // Observer mode (arcade / scripted speed): the speed is imposed from
    // outside; forces, loads and pedals are inferred from how it changes.
    vs.v = Math.max(0, inp.forcedV);
    vs.ax = dt > 0 ? (vs.v - vPrev) / dt : 0;
    throttle = vs.ax > 0.3 ? clamp(hold + vs.ax / 12, 0, 1) : (vs.ax < -0.5 ? 0 : hold);
    brake    = vs.ax < -0.5 ? clamp(-vs.ax / 25, 0, 1) : 0;
  } else if (dt > 0) {
    const a = longAccel(type, setup, vs.v, throttle, brake, wet);
    let vNew = vs.v + a * dt;
    // Never integrate past the driver's target in one step.
    if ((err > 0 && vNew > want) || (err < 0 && vNew < want) || Math.abs(err) <= 0.05) vNew = want;
    vs.v = Math.max(0, vNew);
    vs.ax = (vs.v - vPrev) / dt;
  } else {
    vs.ax = 0;
  }
  vs.throttle = throttle;
  vs.brake = brake;

  const aero = solveAero(type, setup, vs.v);
  // Demanded lateral accel, capped at what the tyres can give — past that
  // the car would run wide, not pull more g.
  const ayMax = maxLateralAccel(type, setup, vs.v, wet);
  const ayDemand = vs.v * vs.v * (inp.kappa || 0);
  vs.overLimit = Math.abs(ayDemand) > ayMax * 1.02;
  vs.ay = clamp(ayDemand, -ayMax, ayMax);
  vs.ayMax = ayMax;

  vs.aero  = aero;
  vs.loads = wheelLoads(type, aero, vs.ax, vs.ay);
  vs.usage = tireUsage(type, vs.loads, vs.ax, vs.ay, wet);

  // Chassis attitude from the same forces. Pitch: + = nose UP (squat).
  const D2R = Math.PI / 180;
  vs.pitchRad = (vs.ax / G) * p.pitchGradDeg * D2R
    - Math.atan2((aero.heaveFrontMm - aero.heaveRearMm) / 1000, p.wheelbase);
  vs.rollRad  = (vs.ay / G) * p.rollGradDeg * D2R;   // + = left turn, leans right
  vs.heaveM   = aero.heaveMm / 1000;
  return vs;
}

/**
 * Speed cap [m/s] from the corners ahead: the fastest the car may be going
 * NOW and still brake to each upcoming corner's limit.
 * @param {(ds:number)=>number} kappaAhead — curvature ds metres ahead
 * @param {Map} [cache] — optional corner-limit memo, see below
 */
export function lookAheadCap(type, setup, v, kappaAhead, wet = false, cache = null) {
  const p = getVehicleParams(type);
  // Conservative braking decel: mechanical grip only (aero is a bonus).
  const aBrake = 0.85 * p.mu * (wet ? 0.62 : 1) * G;
  const reach = Math.min(260, Math.max(30, v * v / (2 * aBrake) + 15));
  let cap = Infinity;
  for (let ds = 0; ds <= reach; ds += 5) {
    const k = kappaAhead(ds);
    if (Math.abs(k) < 1e-5) continue;
    // Optional memo (caller clears it when the setup / car / grip changes):
    // corner limits depend only on |κ|, bucketed to 2e-4 1/m.
    const key = Math.round(Math.abs(k) * 5000);
    let vc = cache?.get(key);
    if (vc === undefined) {
      vc = 0.97 * cornerSpeedLimit(type, setup, key > 0 ? key / 5000 : Math.abs(k), wet);
      cache?.set(key, vc);
    }
    cap = Math.min(cap, Math.sqrt(vc * vc + 2 * aBrake * ds));
  }
  return cap;
}
