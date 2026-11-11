/**
 * track-layout.js — pure rules for what stands where beside the road.
 * No THREE / DOM: track.js is the renderer, this decides the layout, and
 * track-layout.test.js pins it.
 *
 * Lateral distances are metres to the RIGHT of the road centre (− = left).
 */

/** Roadside dimensions per track type. */
export const LAYOUTS = {
  // Endless test track / arcade: a wide apron (the arcade strafe uses ±12 m).
  test: {
    circuit: false, roadW: 30, rumbleX: 5.55, armcoX: 6.4, tyreX: 7.2,
  },
  // Real circuit: an 11 m road, grass verge, gravel on the outside of
  // corners, barriers set back behind it.
  circuit: {
    circuit: true, roadW: 11, rumbleX: 5.05, edgeLineX: 5.3, armcoX: 12.5, tyreX: 11.7,
    gravelFrom: 6.1, gravelTo: 12.0,
  },
};

export const KERB_KAPPA   = 1 / 400;   // kerbs appear on anything tighter than R 400
export const GRAVEL_KAPPA = 1 / 260;   // gravel traps on real corners only
export const TYRE_KAPPA   = 1 / 170;   // tyre walls where a hit is likely

/**
 * Clamp a ground strip's lateral edges so it never reaches past the centre
 * of a bend: beyond 1/|κ| on the inside the rows cross over each other and
 * the strip folds back on itself (seen as a black patch inside a hairpin).
 * Lateral is metres right of the driven line; κ > 0 is a left turn.
 */
export function clampToBend(xl, xr, kappa) {
  if (Math.abs(kappa) < 1e-4) return [xl, xr];
  const reach = 0.85 / Math.abs(kappa);
  if (kappa > 0) xl = Math.max(xl, -reach);   // inside is the left
  else           xr = Math.min(xr, reach);    // inside is the right
  return xl <= xr ? [xl, xr] : [xr, xr];
}

/** Half-width [m] of the level shelf the road stands on: asphalt, gravel,
 *  barriers and pit lane all sit flat at road height inside it. */
export const SHELF = 22;

/**
 * The ground to one side of the road, given the room to the next stretch
 * of track (hairpin legs, parallel straights):
 *   • a level shelf at road height out to `flat`,
 *   • then a bank that reaches `dh` at `reach`.
 * The ground between two stretches is split at the midpoint, where the
 * bank meets the neighbour's bank at the mean of the two road heights — so
 * neither verge lies across the other road, and no road is buried.
 * @param {number} room      distance to the other stretch (Infinity = none)
 * @param {number} dhOther   that stretch's height minus ours
 * @param {number} maxReach  widest the verge may be
 * @param {number} minReach  road edge + margin (never narrower)
 * @param {number} shelf     wanted shelf half-width
 */
export function vergeReach(room, dhOther, maxReach, minReach, shelf = SHELF) {
  if (!Number.isFinite(room)) return { reach: maxReach, flat: Math.min(shelf, maxReach), dh: 0 };
  const mid = room / 2;
  const reach = Math.max(minReach, Math.min(maxReach, mid));
  // Close neighbours: the shelf shrinks to leave at least a metre of bank.
  const flat = Math.max(Math.min(shelf, reach - 1), Math.min(minReach, reach));
  const run = mid - flat;                       // bank length to the midpoint
  const dh = run > 1e-6 ? (dhOther / 2) * Math.min(1, (reach - flat) / run) : dhOther / 2;
  return { reach, flat, dh };
}

/**
 * Ground height offset [m] at `lateral` metres from the line, relative to
 * the road at that station; null when that spot belongs to the next
 * stretch of track (nothing of ours should stand there).
 */
export function groundOffset(room, dhOther, lateral, shelf = SHELF) {
  const a = Math.abs(lateral);
  if (!Number.isFinite(room)) return 0;
  const mid = room / 2;
  if (a > mid - 2) return null;
  const flat = Math.min(shelf, mid - 1);
  if (a <= flat) return 0;
  return (dhOther / 2) * ((a - flat) / (mid - flat));
}

/**
 * Cross-section of the ground on ONE side of the road at one station, as
 * distances from the road centre (all ≥ 0, non-decreasing):
 *
 *   road edge a ─ grass ─ z0 [zone: gravel | pit lane] z1 ─ grass ─ flat ─ bank ─ reach
 *
 * The strips are laid SIDE BY SIDE and share their edges. (Stacked layers
 * each triangulate a sloping, fanning corner differently and poke through
 * one another — seen as green lines across the asphalt.)
 *
 * @param {object} layout  LAYOUTS entry
 * @param {number} side    +1 right, −1 left
 * @param {object} p
 *   c          road centre relative to the driven line (right +)
 *   kappa      curvature at this station (left +)
 *   kappaNear  strongest curvature nearby (cornerKappa) — gravel trigger
 *   room, dh   sideRoomAt() for this side (measured from the line)
 *   pit        {x0, x1} when a pit lane runs on this side here, else null
 *   maxReach   widest the ground may extend
 */
export function rowSide(layout, side, p) {
  const a = layout.roadW / 2;
  const room = Number.isFinite(p.room) ? Math.max(p.room - side * p.c, 2 * (a + 1.5)) : Infinity;
  const v = vergeReach(room, p.dh, p.maxReach, a + 1.5);
  let z0 = a, z1 = a, zone = 'none';
  const lim = Math.max(a, v.flat - 0.2);
  if (p.pit) {
    zone = 'pit'; z0 = Math.min(p.pit.x0, lim); z1 = Math.min(p.pit.x1, lim);
  } else {
    const g = gravelExtent(layout, p.kappaNear);
    if (g && (g[0] > 0 ? 1 : -1) === side) {
      zone = 'gravel'; z0 = Math.min(layout.gravelFrom, lim); z1 = Math.min(layout.gravelTo, lim);
    }
  }
  let out = { a, z0, z1, zone, flat: v.flat, reach: v.reach, dh: v.dh };
  // Inside of a bend: nothing may reach past the centre of curvature.
  if (Math.abs(p.kappa) > 1e-4 && (p.kappa > 0 ? -1 : 1) === side) {
    const vmax = Math.max(0, 0.85 / Math.abs(p.kappa) - side * p.c);
    const cl = (x) => Math.min(x, vmax);
    const reach = cl(out.reach);
    out = { ...out, a: cl(a), z0: cl(z0), z1: cl(z1), flat: cl(out.flat), reach,
      dh: out.reach - out.flat > 1e-6 ? out.dh * Math.max(0, reach - cl(out.flat)) / (out.reach - out.flat) : 0 };
  }
  return out;
}

/** Signed curvature of the strongest bend within ±30 m of s. */
export function cornerKappa(path, s) {
  let best = 0;
  for (const d of [-30, -15, 0, 15, 30]) {
    const k = path.curvatureAt(s + d);
    if (Math.abs(k) > Math.abs(best)) best = k;
  }
  return best;
}

/** +1 (right) / −1 (left): the OUTSIDE of a bend. κ > 0 is a left turn. */
export function outsideOf(kappa) {
  return kappa > 0 ? 1 : -1;
}

/**
 * True when a point `lateral` m from the line sits on the inside of a bend
 * too tight to hold it (it would land across the corner, on the road).
 */
export function insideBlocked(kappa, lateral) {
  if (kappa * lateral >= 0) return false;            // outside, or straight
  return Math.abs(kappa * lateral) > 0.7;
}

export function kerbVisible(layout, kappa) {
  return !layout.circuit || Math.abs(kappa) > KERB_KAPPA;
}

/** Gravel strip [left, right] relative to the road centre; null = none. */
export function gravelExtent(layout, kappa) {
  if (!layout.circuit || Math.abs(kappa) <= GRAVEL_KAPPA) return null;
  const side = outsideOf(kappa);
  const a = side * layout.gravelFrom, b = side * layout.gravelTo;
  return a < b ? [a, b] : [b, a];
}

export function tyresVisible(layout, kappa, side) {
  if (!layout.circuit) return true;
  return Math.abs(kappa) > TYRE_KAPPA && side === outsideOf(kappa);
}

/** Deterministic 0..1 hash of a few integers (stable scenery, no RNG). */
export function hash01(a, b = 0, c = 0, d = 0) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 2147483647 + (d | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

export const TREES = { spacing: 8, perRow: 4, behind: 120, ahead: 240, minX: 16, maxX: 78 };

/**
 * Tree j of row k on `side`: where it stands and what it looks like.
 * Denser near the track (lateral ∝ h²) so the road reads as cut through
 * forest, thinning into the distance.
 */
export function treeSpec(k, side, j) {
  const h1 = hash01(k, side, j, 1), h2 = hash01(k, side, j, 2);
  const h3 = hash01(k, side, j, 3), h4 = hash01(k, side, j, 4);
  return {
    ds: h2 * TREES.spacing,
    lateral: side * (TREES.minX + h1 * h1 * (TREES.maxX - TREES.minX)),
    scale: 0.75 + 0.95 * h3,
    conifer: h4 < 0.68,
    shade: hash01(k, side, j, 5),
  };
}

/** True when lap distance `lap` lies in [from, to) — `to` may exceed the lap (wraps). */
export function inLapRange(lap, from, to, length) {
  const l = ((lap % length) + length) % length;
  if (l >= from && l < to) return true;
  return to > length && l < to - length;
}

const SEG_LEN = { grandstand: 24, pit: 20, wall: 10, hoarding: 10 };
export const SCENERY_DEPTH = { grandstand: 12, pit: 10 };

/**
 * Expand a circuit's scenery definition into individually placed items.
 * Ranged entries become segments that follow the road; anything that would
 * stand on another stretch of track (clearanceAt) is dropped.
 * @returns {{items: Array, pitlanes: Array, keepOut: Array}}
 */
export function expandScenery(defs, circuit) {
  const items = [], pitlanes = [], keepOut = [];
  const L = circuit.length;
  for (const d of defs) {
    if (d.type === 'pitlane') { pitlanes.push({ ...d }); continue; }
    if (d.type === 'boards') {
      for (const m of [150, 100, 50]) {
        items.push({ type: 'board', text: String(m), s: ((d.s - m) % L + L) % L, side: d.side ?? -1, lateral: d.lateral ?? 7.2 });
      }
      continue;
    }
    const seg = SEG_LEN[d.type];
    if (!seg) { items.push({ ...d, side: d.side ?? 1, lateral: d.lateral ?? 0 }); continue; }
    // Hoardings stand just in front of the barrier unless told otherwise.
    const lateral = d.lateral ?? (d.type === 'hoarding' ? LAYOUTS.circuit.armcoX - 0.6 : 0);
    const n = Math.max(1, Math.round((d.to - d.from) / seg));
    const len = (d.to - d.from) / n;
    const depth = SCENERY_DEPTH[d.type] ?? 0;
    for (let i = 0; i < n; i++) {
      const s = d.from + (i + 0.5) * len;
      if (depth && circuit.clearanceAt(s, d.side * (lateral + depth / 2)) < depth + 14) continue;
      items.push({ type: d.type, s: s % L, side: d.side, lateral, len, index: i });
    }
    if (depth) keepOut.push({ from: d.from - 6, to: d.to + 6, side: d.side, lateral: lateral + depth + 4 });
    if (d.type === 'wall') keepOut.push({ from: d.from - 6, to: d.to + 6, side: d.side, lateral: 0, barrier: true });
  }
  return { items, pitlanes, keepOut };
}

/** Should a tree at (lap, signed lateral) be left out? */
export function treeBlocked(keepOut, lap, lateral, length) {
  const side = lateral >= 0 ? 1 : -1;
  for (const k of keepOut) {
    if (k.barrier || k.side !== side) continue;
    if (Math.abs(lateral) < k.lateral && inLapRange(lap, k.from, k.to, length)) return true;
  }
  return false;
}

/** Are the roadside barriers on `side` replaced by a pit wall here? */
export function barrierBlocked(keepOut, lap, side, length) {
  for (const k of keepOut) {
    if (k.barrier && k.side === side && inLapRange(lap, k.from, k.to, length)) return true;
  }
  return false;
}
