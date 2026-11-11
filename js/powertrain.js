/**
 * powertrain.js — gearbox + engine speed (pure math, no THREE / DOM).
 *
 * Replaces "gear from speed band" with a real model: each gear has a road
 * speed at the shift point, engine rpm follows road speed through the
 * current ratio, the box shifts up at the shift point and down when the
 * next gear down would no longer over-rev. That is what makes an engine
 * note right: revs fall ~15–25 % on an upshift (not to the floor), climb
 * through each gear, and step back up through the box under braking.
 *
 * Figures are representative for each class, not manufacturer data.
 */

/** km/h reached in each gear at the shift point. */
export const POWERTRAIN = {
  // 1.6 V6 turbo hybrid, 8-speed. Shifts ~12 000 rpm.
  F1: { cyl: 6, idle: 4800, shift: 12000, limit: 12800, launch: 8500,
        vGear: [112, 146, 180, 214, 248, 282, 316, 352] },
  // 3.4 V6 turbo, 6-speed.
  F2: { cyl: 6, idle: 2600, shift: 8500, limit: 8900, launch: 6000,
        vGear: [102, 142, 184, 228, 278, 338] },
  // 3.4 V6 naturally aspirated, 6-speed.
  F3: { cyl: 6, idle: 2400, shift: 7900, limit: 8200, launch: 5500,
        vGear: [92, 128, 164, 204, 250, 304] },
  // 4.0 flat-six naturally aspirated, 7-speed PDK, 9000 rpm.
  GT: { cyl: 6, idle: 950, shift: 8800, limit: 9000, launch: 4500,
        vGear: [76, 119, 160, 202, 246, 290, 332] },
};

export function getPowertrain(type) {
  return POWERTRAIN[type] || POWERTRAIN.F1;
}

/** Engine rpm in `gear` (1-based) at road speed `kmh`, with no clutch slip. */
export function rpmInGearAt(type, gear, kmh) {
  const p = getPowertrain(type);
  const g = Math.min(Math.max(gear, 1), p.vGear.length);
  return p.shift * kmh / p.vGear[g - 1];
}

/** Fraction of first gear's speed at which the clutch is fully engaged. */
export const CLUTCH_BITE = 0.55;

/** Downshift once the next gear down would sit at or below this fraction of the shift rpm. */
export const DOWNSHIFT_AT = 0.86;

/**
 * Gear to be in, given the gear we are in now (hysteresis: up at the shift
 * point, down only when the lower gear would not over-rev).
 * 0 = neutral (stationary, off the throttle).
 */
export function nextGear(type, gear, kmh, throttle = 1) {
  const p = getPowertrain(type);
  const n = p.vGear.length;
  if (kmh < 3 && throttle < 0.05) return 0;
  let g = Math.min(Math.max(gear, 1), n);
  // Up: at the shift point (several steps if the speed jumped).
  while (g < n && rpmInGearAt(type, g, kmh) >= p.shift) g++;
  // Down: when the gear below would be comfortably under the shift point.
  while (g > 1 && rpmInGearAt(type, g - 1, kmh) <= p.shift * DOWNSHIFT_AT) g--;
  return g;
}

/**
 * Engine rpm including launch behaviour: below the speed where first gear
 * is fully engaged the clutch slips and the revs are held up by the
 * throttle; off the throttle they fall to idle.
 */
export function engineRpm(type, gear, kmh, throttle = 1) {
  const p = getPowertrain(type);
  if (gear <= 0) return p.idle + (p.launch - p.idle) * 0.25 * Math.max(0, Math.min(1, throttle));
  const locked = rpmInGearAt(type, gear, kmh);
  if (gear !== 1) return Math.min(p.limit, Math.max(locked, p.idle));
  // First gear: the clutch slips from the launch revs and bites fully at
  // CLUTCH_BITE of the gear's speed — the revs sag a little as it takes up,
  // then climb with road speed. (Held flat they would drone.)
  const t = Math.max(0, Math.min(1, throttle));
  const vBite = CLUTCH_BITE * p.vGear[0];
  const hold = p.idle + (p.launch - p.idle) * t;
  const slip = kmh >= vBite ? 0 : hold + (rpmInGearAt(type, 1, vBite) - hold) * (kmh / vBite);
  return Math.min(p.limit, Math.max(locked, slip, p.idle));
}

/** 0..1 position between idle and the limiter (rev-bar fraction). */
export function rpm01(type, rpm) {
  const p = getPowertrain(type);
  return Math.min(1, Math.max(0, (rpm - p.idle) / (p.limit - p.idle)));
}

/** Firing frequency [Hz] of a four-stroke: rpm/60 × cylinders/2. */
export function firingHz(type, rpm) {
  return (rpm / 60) * (getPowertrain(type).cyl / 2);
}

export function createPowertrainState() {
  return { gear: 0, rpm: 0, rpm01: 0, shifted: 0 };
}

/**
 * Advance the gearbox one frame.
 * @returns the same state object; `shifted` is +1 / −1 on the frame a
 *          gear change happens (0 otherwise), for the shift sound.
 */
export function stepPowertrain(st, type, kmh, throttle = 1) {
  const prev = st.gear;
  st.gear = nextGear(type, prev, kmh, throttle);
  st.shifted = st.gear > prev && prev > 0 ? 1 : (st.gear < prev && st.gear > 0 ? -1 : 0);
  st.rpm = engineRpm(type, st.gear, kmh, throttle);
  st.rpm01 = rpm01(type, st.rpm);
  return st;
}
