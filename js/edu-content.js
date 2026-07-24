/**
 * edu-content.js — Educational layer content + hit mapping (pure, no THREE).
 *
 * EDU_COPY holds the authored part cards (plan edu-wheel-backlog.md — copy is
 * VERBATIM, do not reword physics). partForHit maps a car-local hit point to
 * a part id via nearest mapped anchor within EDU_RADIUS, with an underfloor
 * y-band fallback. eduEntryFor resolves per-car-type overrides (GT splitter).
 */

/* Nearest-anchor search radius (m, car-local). */
export const EDU_RADIUS = 0.55;

/* Part copy — "Title — body" strings; splitCopy() separates them for the card. */
export const EDU_COPY = {
  frontWing: 'Front wing — first surface to meet the air. Generates ~25% of total downforce and steers the wake around the tires and into the floor.',
  rearWing:  'Rear wing — high-pressure above, suction below: rear downforce for traction, at the price of drag. The endplates limit tip vortices.',
  halo:      "Halo — titanium crash structure. Costs a little airflow to the engine intake, protects the driver's head.",
  sidepod:   'Sidepods — house the radiators. Inlets swallow cooling air; the sculpted undercut accelerates flow toward the rear.',
  floor:     'Floor & diffuser — the biggest downforce device: air accelerates through the narrow gap (low pressure sucks the car down), the diffuser eases it back out.',
  wheels:    'Tires — the only contact with the road, and aerodynamically messy: their wake disturbs everything behind them.',
  mirror:    'Mirrors — a small but real drag source; teams shape them to steer flow onto the sidepods.',
  airbox:    'Airbox — feeds the engine above the driver\'s head, where the air is cleanest.',
  brakeDuct: 'Brake ducts — scoop air to cool carbon discs that run at up to 1000 °C.',
  exhaust:   'Exhaust — hot gases exit here; regulations stopped teams from blowing them at the diffuser.',
  cockpit:   'Cockpit — the driver sits reclined, feet up front, in a carbon survival cell.',
  nose:      'Nose — pierces the air and sets the stagnation point; everything downstream inherits its wake.',
};

/* Per-type overrides where parts differ. GT has no front wing — the
 * frontWing anchor is the splitter (title + copy adapted per the plan's
 * override note; the base frontWing copy stays the source of intent). */
const TYPE_OVERRIDES = {
  GT: {
    frontWing: "Splitter — flat blade at the bumper's base: the first surface to meet the air, generating front downforce and feeding flow to the floor.",
    halo: "Roof — the crash structure over the cabin; protects the driver's head.",
  },
};

/* Anchor key → part id. Unlisted anchors (fender vents, bodyShell, …) are
 * skipped by the nearest-anchor search. */
export const ANCHOR_TO_PART = {
  frontWing:       'frontWing',
  rearWing:        'rearWing',
  halo:            'halo',
  cockpit:         'cockpit',
  noseTip:         'nose',
  sidepodTop:      'sidepod',
  sidepodInletL:   'sidepod',
  sidepodInletR:   'sidepod',
  sidepodExhaustL: 'sidepod',
  sidepodExhaustR: 'sidepod',
  frontIntake:     'sidepod',   // GT: front radiator intake
  airboxIntake:    'airbox',
  engineIntake:    'airbox',    // GT: rear-deck engine intake
  frontBrakeDuctL: 'brakeDuct',
  frontBrakeDuctR: 'brakeDuct',
  rearBrakeDuctL:  'brakeDuct',
  rearBrakeDuctR:  'brakeDuct',
  exhaustPipe:     'exhaust',
  floor:           'floor',
  diffuser:        'floor',
};

/** Split an authored "Title — body" string for card rendering. */
export function splitCopy(s) {
  const i = s.indexOf(' — ');
  if (i < 0) return { title: s, body: '' };
  return { title: s.slice(0, i), body: s.slice(i + 3) };
}

/**
 * Map a car-local hit point to a part id (or null).
 *   1. Underfloor band: y below floor.y + 0.1 → 'floor'.
 *   2. Nearest mapped anchor within EDU_RADIUS.
 * `point` must already be in car-local frame (caller subtracts baseY).
 */
export function partForHit(point, anchors, _type) {
  if (!point || !anchors) return null;

  const floorA = anchors.floor;
  if (floorA && Number.isFinite(floorA.y) && point.y < floorA.y + 0.1) return 'floor';

  let best = null;
  let bestD2 = EDU_RADIUS * EDU_RADIUS;
  for (const [key, part] of Object.entries(ANCHOR_TO_PART)) {
    const a = anchors[key];
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) continue;
    const dx = point.x - a.x, dy = point.y - a.y, dz = point.z - a.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = part; }
  }
  return best;
}

/** Resolve the copy string for a part on a given car type (null if unknown). */
export function eduEntryFor(part, type) {
  return TYPE_OVERRIDES[type]?.[part] ?? EDU_COPY[part] ?? null;
}
