/**
 * cfd-effect.js — CFD Pressure-Coefficient Visualisation (Enhanced)
 *
 * Full-body pressure mapping covering the entire car:
 *   • Surface patches   — PlaneGeometry with role-specific Cp biases + per-vertex colouring
 *   • Zone blobs        — Sphere meshes at key stagnation / suction / separation points
 *   • Vortex cores      — Spiral traces at front wing tips, sidepod undercut, diffuser exits
 *   • Streamlines       — Animated nose→tail flow lines with Cp-gradient vertex colours
 *
 * Interface mirrors AirflowEffect:
 *   constructor(scene), setCarType(type), setSpeed(v), setVisible(v),
 *   update(dt, t), dispose().
 */

import * as THREE from 'three';
import { topViewVelocity, pressureCoeff, cpToColor, vortexVelocity, sumVelocity } from './airflow-core.js';

/* ── Helpers ──────────────────────────────────────────────────────── */
function rnd(a, b) { return a + Math.random() * (b - a); }

/**
 * Piecewise-linear Cp profiles along the car body (car-frame z), PER CAR and
 * PER SURFACE. An open-wheel ground-effect F1 and a closed-body GT3 RS have
 * fundamentally different longitudinal pressure signatures:
 *   top   — centreline over the upper body (streamline colouring)
 *   under — underbody slice (floor / diffuser patch sampling)
 * F1 keeps its single calibrated table for both surfaces (legacy behaviour,
 * regression-locked by cfd-floor-suction.test.js). GT gets distinct tables:
 * blunt bumper stagnation → hood-lip suction → windshield-base compression →
 * roof-header suction peak (top), and splitter suction → flat floor →
 * diffuser pump (under).
 */
const F1_CP_TABLE = [
  [-3.00,  0.15], [-2.80,  0.90], [-2.60, -2.20],
  [-2.00, -0.85], [-0.50, -0.40], [ 0.50, -0.22],
  [ 1.40, -0.18], [ 2.00, -1.10], [ 2.40,  0.15],
];
const CP_TABLES = {
  F1: { top: F1_CP_TABLE, under: F1_CP_TABLE },
  GT: {
    top: [
      [-2.60,  0.10], [-2.35,  0.90],   // blunt-bumper stagnation
      [-1.90, -0.85],                   // hood-lip acceleration
      [-1.20, -0.25],                   // mid-hood recovery
      [-0.70,  0.45],                   // windshield-base compression
      [-0.10, -0.95],                   // roof-header suction peak
      [ 0.60, -0.45],                   // roof flat
      [ 1.30, -0.35],                   // rear glass (separated, recovering)
      [ 1.95, -0.60],                   // decklid under the wing
      [ 2.35,  0.08],                   // base region
    ],
    under: [
      [-2.40,  0.65],                   // splitter leading-edge stagnation
      [-2.05, -1.25],                   // splitter suction peak
      [-1.00, -0.55],                   // forward flat floor
      [ 0.60, -0.45],                   // mid floor
      [ 1.40, -0.65],                   // diffuser inlet ramp
      [ 2.00, -1.15],                   // diffuser suction peak
      [ 2.35,  0.05],                   // exit recovery
    ],
  },
};

/**
 * Emphasis colour mapping for the CFD overlays (heat-point legibility).
 *
 * cpToColor always emits one full-luminance channel, so under additive
 * blending the mid-range Cp band (−1…+0.5 ⇒ green/yellow) glowed as bright
 * as the true stagnation/suction peaks — the whole shell washed uniform.
 *
 * Here the HUE still comes from cpToColor (which is shared with the venturi
 * underfloor tint and must not change), but luminance is scaled by
 *   w = smoothstep(0.25, 0.85, |cp| / cpRef)      (cpRef per sign)
 * Zero luminance is invisible under additive blending: mid-range fades out,
 * peaks glow. Callers normalise cpRef by the CURRENT speed's attainable
 * peak (cpRef·sf) so the emphasis pattern survives at low speed.
 *
 * @param {number} cp
 * @param {number} cpRefPos — reference positive peak (stagnation), default 0.9
 * @param {number} cpRefNeg — reference negative peak (suction), default 2.2
 * @returns {{r: number, g: number, b: number}}
 */
export function cpToEmphasisColor(cp, cpRefPos = 0.9, cpRefNeg = 2.2) {
  const ref = cp >= 0 ? cpRefPos : cpRefNeg;
  if (!(ref > 1e-6)) return { r: 0, g: 0, b: 0 };
  const x = Math.abs(cp) / ref;
  const t = Math.min(1, Math.max(0, (x - 0.25) / 0.60));
  const w = t * t * (3 - 2 * t);                 // smoothstep(0.25, 0.85, x)
  if (w <= 0) return { r: 0, g: 0, b: 0 };
  const c = cpToColor(cp);
  return { r: c.r * w, g: c.g * w, b: c.b * w };
}

export function lerpCpProfile(z, type = 'F1', surface = 'under') {
  const tables = CP_TABLES[type] || CP_TABLES.F1;
  const table  = tables[surface] || tables.under;
  if (z <= table[0][0]) return table[0][1];
  if (z >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [z0, cp0] = table[i], [z1, cp1] = table[i + 1];
    if (z >= z0 && z <= z1) {
      const t = (z - z0) / (z1 - z0);
      return cp0 + t * (cp1 - cp0);
    }
  }
  return 0;
}

/* ── Per-role Cp bias, PER CAR (physics-correct baselines) ────────── *
 * bias  = base Cp value for surface (positive = stagnation, negative = suction)
 * scale = amplitude of potential-flow variation on top of bias
 *
 * F1 (open-wheel, venturi ground effect): strong floor/diffuser suction,
 * multi-element wing peaks. GT (closed body, flat floor): weaker floor
 * suction, blunter stagnation, dedicated closed-body roles for the hood /
 * windshield-roof / rear-deck pressure stations.
 * -------------------------------------------------------------------- */
const ROLE_CP = {
  F1: {
    frontWing:        { bias: -1.80, scale: 1.10 },
    frontWingFlap:    { bias: -2.40, scale: 0.85 },
    rearWing:         { bias: -1.50, scale: 0.95 },
    rearWingFlap:     { bias: -2.00, scale: 0.80 },
    diffuser:         { bias: -1.30, scale: 0.90 },
    sidepodInlet:     { bias:  0.85, scale: 0.25 },
    sidepodTop:       { bias: -0.55, scale: 0.55 },
    sidepodSide:      { bias:  0.20, scale: 0.40 },
    engineCover:      { bias: -0.25, scale: 0.40 },
    floor:            { bias: -0.75, scale: 0.80 },
    nose:             { bias:  0.55, scale: 0.50 },
    monocoque:        { bias: -0.10, scale: 0.30 },
  },
  GT: {
    frontBumper:      { bias:  0.78, scale: 0.35 },   // blunt-body stagnation
    hood:             { bias: -0.35, scale: 0.45 },   // hood-lip acceleration
    windshieldRoof:   { bias: -0.60, scale: 0.55 },   // base compression → header suction
    rearDeck:         { bias: -0.30, scale: 0.40 },   // separated flow, recovering
    floor:            { bias: -0.55, scale: 0.70 },   // flat floor — no venturi tunnels
    diffuser:         { bias: -1.05, scale: 0.85 },
    rearWing:         { bias: -1.40, scale: 0.90 },   // swan-neck GT wing
  },
};

export function getRoleCp(type, role) {
  const table = ROLE_CP[type] || ROLE_CP.F1;
  return table[role] || ROLE_CP.F1[role] || { bias: 0, scale: 0.5 };
}

/* ── Per-car CFD patch definitions ─────────────────────────────────── *
 * { w, h, cx, cy, cz, rx, ry, rz, role }
 * (cx,cy,cz) world centre  (rx,ry,rz) patch plane Euler rotation
 * Exported for unit tests — see cfd-floor-suction.test.js.
 * -------------------------------------------------------------------- */
const π = Math.PI;
export const CFD_PATCHES = {
  F1: [
    // Front wing — main element
    { w: 1.74, h: 0.34, cx:  0,      cy:  0.020, cz: -2.72, rx: -π/2, ry: 0,    rz: 0,    role: 'frontWing' },
    // Front wing — flap 1 (slanted)
    { w: 1.68, h: 0.22, cx:  0,      cy:  0.065, cz: -2.65, rx: -π/2, ry: 0,    rz: 0.10, role: 'frontWingFlap' },
    // Front wing — flap 2
    { w: 1.54, h: 0.18, cx:  0,      cy:  0.105, cz: -2.58, rx: -π/2, ry: 0,    rz: 0.18, role: 'frontWingFlap' },
    // Nose top surface
    { w: 0.32, h: 0.92, cx:  0,      cy:  0.13,  cz: -2.22, rx: 0,    ry: 0,    rz: 0,    role: 'nose' },
    // Upper monocoque / tub top
    { w: 0.62, h: 1.20, cx:  0,      cy:  0.44,  cz: -0.08, rx: -π/2, ry: 0,    rz: 0,    role: 'monocoque' },
    // Sidepod inlets (L / R)
    { w: 0.065,h: 0.32, cx: -0.528,  cy:  0.22,  cz: -0.64, rx: 0,    ry:  π/2, rz: 0,    role: 'sidepodInlet' },
    { w: 0.065,h: 0.32, cx:  0.528,  cy:  0.22,  cz: -0.64, rx: 0,    ry: -π/2, rz: 0,    role: 'sidepodInlet' },
    // Sidepod tops (L / R)
    { w: 0.35, h: 1.82, cx: -0.535,  cy:  0.46,  cz:  0.28, rx: -π/2, ry: 0,    rz: 0,    role: 'sidepodTop' },
    { w: 0.35, h: 1.82, cx:  0.535,  cy:  0.46,  cz:  0.28, rx: -π/2, ry: 0,    rz: 0,    role: 'sidepodTop' },
    // Sidepod outer faces (L / R)
    { w: 0.32, h: 1.82, cx: -0.715,  cy:  0.22,  cz:  0.28, rx: 0,    ry:  π/2, rz: 0,    role: 'sidepodSide' },
    { w: 0.32, h: 1.82, cx:  0.715,  cy:  0.22,  cz:  0.28, rx: 0,    ry: -π/2, rz: 0,    role: 'sidepodSide' },
    // Engine cover top
    { w: 0.50, h: 1.15, cx:  0,      cy:  0.57,  cz:  1.38, rx: -π/2, ry: 0,    rz: 0,    role: 'engineCover' },
    // Floor underside (primary downforce generator)
    { w: 1.44, h: 3.80, cx:  0,      cy:  0.007, cz: -0.05, rx:  π/2, ry: 0,    rz: 0,    role: 'floor' },
    // Diffuser suction
    { w: 1.14, h: 1.00, cx:  0,      cy: -0.05,  cz:  1.93, rx:  π/2, ry: 0,    rz: 0.28, role: 'diffuser' },
    // Rear wing main plane
    { w: 1.92, h: 0.36, cx:  0,      cy:  0.98,  cz:  1.95, rx: -π/2, ry: 0,    rz: 0,    role: 'rearWing' },
    // Rear wing DRS flap
    { w: 1.86, h: 0.26, cx:  0,      cy:  1.06,  cz:  1.91, rx: -π/2, ry: 0,    rz: 0.14, role: 'rearWingFlap' },
  ],
  GT: [
    { w: 1.84, h: 0.40, cx:  0,      cy:  0.00,  cz: -2.32, rx: -π/2, ry: 0,    rz: 0,    role: 'frontBumper' },
    { w: 1.70, h: 0.50, cx:  0,      cy:  0.60,  cz: -2.10, rx: -π/2, ry: 0,    rz:-0.20, role: 'hood' },
    { w: 1.60, h: 1.20, cx:  0,      cy:  0.72,  cz:  0.10, rx: -π/2, ry: 0,    rz: 0,    role: 'windshieldRoof' },
    { w: 1.60, h: 1.10, cx:  0,      cy:  0.72,  cz:  1.20, rx: -π/2, ry: 0,    rz: 0,    role: 'rearDeck' },
    { w: 1.20, h: 2.80, cx:  0,      cy:  0.007, cz:  0.00, rx:  π/2, ry: 0,    rz: 0,    role: 'floor' },
    { w: 1.10, h: 0.78, cx:  0,      cy: -0.10,  cz:  2.14, rx:  π/2, ry: 0,    rz: 0.30, role: 'diffuser' },
    { w: 1.76, h: 0.42, cx:  0,      cy:  0.84,  cz:  1.92, rx: -π/2, ry: 0,    rz: 0,    role: 'rearWing' },
  ],
};

/* ── Zone blob definitions ────────────────────────────────────────── */
const ZONE_BLOBS = {
  F1: [
    { role: 'stagnation',   color: 0xff2200, r: 0.26, intensity: 0.90, phase: 0.0, pos: [ 0,      0.12, -2.88] },
    { role: 'suction',      color: 0x0044ff, r: 0.42, intensity: 0.85, phase: 1.1, pos: [ 0,      0.02, -2.64] },
    { role: 'fwTipL',       color: 0x2266ff, r: 0.18, intensity: 0.70, phase: 0.6, pos: [-0.93,   0.02, -2.72] },
    { role: 'fwTipR',       color: 0x2266ff, r: 0.18, intensity: 0.70, phase: 0.6, pos: [ 0.93,   0.02, -2.72] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.22, intensity: 0.70, phase: 0.5, pos: [-0.528,  0.22, -0.64] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.22, intensity: 0.70, phase: 0.5, pos: [ 0.528,  0.22, -0.64] },
    { role: 'undercut',     color: 0x00aaff, r: 0.20, intensity: 0.60, phase: 1.8, pos: [-0.61,   0.06,  0.30] },
    { role: 'undercut',     color: 0x00aaff, r: 0.20, intensity: 0.60, phase: 1.8, pos: [ 0.61,   0.06,  0.30] },
    { role: 'diffuser',     color: 0x0066ff, r: 0.55, intensity: 0.85, phase: 2.2, pos: [ 0,     -0.04,  1.93] },
    { role: 'rearWing',     color: 0xff2200, r: 0.30, intensity: 0.65, phase: 0.8, pos: [ 0,      0.98,  1.95] },
    { role: 'fwCenter',     color: 0x0044ff, r: 0.16, intensity: 0.50, phase: 0.7, pos: [ 0,      0.10, -2.72] },
    { role: 'cockpit',      color: 0xff6600, r: 0.20, intensity: 0.70, phase: 1.4, pos: [ 0,      0.52, -0.45] },
  ],
  GT: [
    { role: 'stagnation',   color: 0xff2200, r: 0.42, intensity: 0.80, phase: 0.0, pos: [ 0,      0.08, -2.48] },
    { role: 'diffuser',     color: 0x0066ff, r: 0.50, intensity: 0.62, phase: 2.2, pos: [ 0,     -0.10,  2.14] },
    { role: 'rearWing',     color: 0xff2200, r: 0.35, intensity: 0.58, phase: 0.8, pos: [ 0,      0.84,  1.92] },
    { role: 'cockpit',      color: 0xff6600, r: 0.20, intensity: 0.70, phase: 1.4, pos: [ 0,      0.68, -0.50] },
  ],
};

/* ── Vortex core definitions ──────────────────────────────────────── *
 * Each core emits a rotating spiral traveling in +Z (rearward).
 * radius: base spiral radius (scaled by speedFactor in update)
 * -------------------------------------------------------------------- */
const VORTEX_CORES = {
  F1: [
    { x: -0.93, y:  0.02, z: -2.72, sign:  1, radius: 0.14, length: 1.00, role: 'frontWing',  dz: 0    }, // FW tip L
    { x:  0.93, y:  0.02, z: -2.72, sign: -1, radius: 0.14, length: 1.00, role: 'frontWing',  dz: 0    }, // FW tip R
    { x: -0.61, y:  0.06, z:  0.10, sign:  1, radius: 0.18, length: 1.40, role: 'sidepodTop', dz: -0.18 }, // sidepod undercut L
    { x:  0.61, y:  0.06, z:  0.10, sign: -1, radius: 0.18, length: 1.40, role: 'sidepodTop', dz: -0.18 }, // sidepod undercut R
    { x: -0.48, y: -0.04, z:  2.10, sign:  1, radius: 0.26, length: 1.43, role: 'diffuser',   dz: 0.17 }, // diffuser L
    { x:  0.48, y: -0.04, z:  2.10, sign: -1, radius: 0.26, length: 1.43, role: 'diffuser',   dz: 0.17 }, // diffuser R
  ],
  GT: [
    // Splitter-edge vortices — the GT3 RS front splitter sheds a tip pair.
    { x: -0.80, y:  0.02, z: -2.20, sign:  1, radius: 0.10, length: 0.85, role: 'frontWing', dz: 0    },
    { x:  0.80, y:  0.02, z: -2.20, sign: -1, radius: 0.10, length: 0.85, role: 'frontWing', dz: 0    },
    // Rear-wing endplate vortices — dominant on the swan-neck GT wing.
    { x: -0.86, y:  0.80, z:  1.80, sign: -1, radius: 0.16, length: 1.10, role: 'rearWing',  dz: 0    },
    { x:  0.86, y:  0.80, z:  1.80, sign:  1, radius: 0.16, length: 1.10, role: 'rearWing',  dz: 0    },
    { x: -0.44, y: -0.10, z:  2.31, sign:  1, radius: 0.24, length: 1.23, role: 'diffuser',  dz: 0.10 },
    { x:  0.44, y: -0.10, z:  2.31, sign: -1, radius: 0.24, length: 1.23, role: 'diffuser',  dz: 0.10 },
  ],
};

/**
 * Resolve vortex-core positions against the measured anchor map: each core's
 * z snaps to its role's anchor z (plus the authored dz offset — e.g. the
 * diffuser vortex trails slightly AFT of the diffuser anchor). Cores whose
 * role has no anchor — or with no anchors at all — keep authored positions.
 * Pure; returns NEW objects (authored table never mutated).
 */
export function resolveVortexCores(type, anchors) {
  const defs = VORTEX_CORES[type] || VORTEX_CORES.F1;
  return defs.map(def => {
    const a = anchors?.[def.role];
    if (!a || typeof a.z !== 'number') return { ...def };
    return { ...def, z: a.z + (def.dz ?? 0) };
  });
}

/* ── Streamline lane definitions (animated nose→tail flow) ────────── *
 * Each lane is a line strip from zStart to zEnd at a fixed (x, y) lane.
 * waveX/waveY: lateral + vertical oscillation amplitude.
 * -------------------------------------------------------------------- */
const STREAMLINE_DEFS = {
  F1: [
    { x:  0.00, y: 0.52, zStart: -2.85, zEnd: 2.70, waveX: 0.000, waveY: 0.030 }, // centerline
    { x: -0.22, y: 0.40, zStart: -2.85, zEnd: 2.50, waveX: 0.012, waveY: 0.025 }, // monocoque L
    { x:  0.22, y: 0.40, zStart: -2.85, zEnd: 2.50, waveX:-0.012, waveY: 0.025 }, // monocoque R
    { x: -0.54, y: 0.46, zStart: -2.85, zEnd: 2.30, waveX: 0.008, waveY: 0.020 }, // sidepod top L
    { x:  0.54, y: 0.46, zStart: -2.85, zEnd: 2.30, waveX:-0.008, waveY: 0.020 }, // sidepod top R
    { x: -0.72, y: 0.22, zStart: -2.85, zEnd: 2.20, waveX: 0.010, waveY: 0.018 }, // sidepod outer L
    { x:  0.72, y: 0.22, zStart: -2.85, zEnd: 2.20, waveX:-0.010, waveY: 0.018 }, // sidepod outer R
    { x:  0.00, y: 0.00, zStart: -2.10, zEnd: 2.15, waveX: 0.000, waveY: 0.012 }, // floor / ground effect
  ],
  GT: [
    { x:  0.00, y: 0.68, zStart: -2.40, zEnd: 2.60, waveX: 0.000, waveY: 0.030 },
    { x: -0.40, y: 0.68, zStart: -2.40, zEnd: 2.40, waveX: 0.010, waveY: 0.025 },
    { x:  0.40, y: 0.68, zStart: -2.40, zEnd: 2.40, waveX:-0.010, waveY: 0.025 },
    { x:  0.00, y: 0.00, zStart: -1.80, zEnd: 2.20, waveX: 0.000, waveY: 0.012 },
  ],
};

const VORTEX_PTS  = 70;
const STREAM_PTS  = 90;
const PATCH_SEG   = 14; // higher → smoother Cp gradients

/* Under-body patch roles. For these we bypass the topViewVelocity sampler
 * and read the longitudinal Cp profile directly, because the patch's
 * normalised sample coordinates can land INSIDE the unit cylinder
 * (r² ≤ 1) where topViewVelocity short-circuits to (0,0) — driving baseCp
 * to 1 (stagnation) and washing out the floor's actual suction. The Cp
 * profile in `CP_TABLE` is the physics-calibrated baseline used by the
 * streamlines and is the correct thing to read for surfaces tucked under
 * the car body. See cfd-floor-suction.test.js for the regression proof. */
const UNDERBODY_ROLES = new Set(['floor', 'diffuser']);

/**
 * Compute Cp at one patch vertex. Pure — no THREE imports, no class state.
 *
 * @param {object} p           — patch def from CFD_PATCHES (has w, h, cx, cy, cz, role)
 * @param {number} lx          — local x within the patch (PlaneGeometry frame)
 * @param {number} ly          — local y within the patch
 * @param {number} speedFactor — normalised speed in [0, 1]
 * @param {Array}  modifiers   — analytical flow modifiers (sinks/sources/vortices)
 * @param {Array}  vortexCores — VORTEX_CORES[type] entries for vortex perturbation
 * @returns {number} pressure coefficient
 */
export function computePatchCp(p, lx, ly, speedFactor, modifiers = [], vortexCores = [], type = 'F1') {
  const roleDef = getRoleCp(type, p.role);
  const hw = p.w / 2;
  const hh = p.h / 2;
  const xi  = hw > 0 ? lx / hw : 0;
  const eta = hh > 0 ? ly / hh : 0;

  let baseCp;
  if (UNDERBODY_ROLES.has(p.role)) {
    // Read the longitudinal Cp table at this vertex's z-position. Spatial
    // variation across the patch comes from `ly` mapping to world z (the
    // floor/diffuser patches are rotated π/2 around X so ly aligns with z).
    baseCp = lerpCpProfile(p.cz + ly, type, 'under');
  } else {
    const sampleXi  = xi  * 1.6 + 0.01;
    const sampleEta = eta * 1.6 + 0.01;
    const { vxi, veta } = (modifiers && modifiers.length > 0)
      ? sumVelocity(sampleXi, sampleEta, topViewVelocity, modifiers)
      : topViewVelocity(sampleXi, sampleEta);
    baseCp = pressureCoeff(vxi, veta);
  }

  let groundScale = 1.0;
  if (p.role === 'floor')    groundScale = 1 + speedFactor * speedFactor * 0.30;
  if (p.role === 'diffuser') groundScale = 1 + speedFactor * speedFactor * 0.25;

  let cp = (roleDef.bias + roleDef.scale * baseCp * speedFactor) * groundScale;

  if (p.role === 'nose') {
    cp += (1 - Math.abs(xi)) * 0.40 * speedFactor;
  }
  if (p.role === 'floor') {
    cp -= (eta + 1) * 0.20 * speedFactor;
  }
  // Closed-body windshield/roof station: the patch spans windscreen base →
  // roof header (rx = -π/2 ⇒ local +y faces the nose). The base half carries
  // a compression ramp toward stagnation; the header half keeps the suction
  // baseline — reproduces the classic saddle on a fastback roofline.
  if (p.role === 'windshieldRoof') {
    cp += Math.max(0, eta) * 1.2 * speedFactor;
  }

  if (p.role === 'sidepodTop' || p.role === 'floor' || p.role === 'diffuser') {
    for (const vc of vortexCores) {
      const dist = Math.sqrt(
        (p.cx + lx - vc.x) ** 2 +
        (p.cy + ly - vc.y) ** 2 +
        (p.cz        - vc.z) ** 2
      );
      if (dist < 0.5) {
        const vv = vortexVelocity(p.cx + lx, p.cz, vc.x, vc.z, vc.sign * 0.3, vc.radius);
        cp += -pressureCoeff(vv.vxi, vv.veta) * 0.35;
      }
    }
  }

  return cp;
}

/**
 * Cp at a point ON the real body surface — drives the per-vertex colouring
 * of the body-surface overlay (the replacement for the floating rectangle
 * patches on GLB cars). Pure and anchor-driven:
 *
 *   1. Underbody (downward-facing normal, or below the floor anchor) reads
 *      the per-car UNDER profile — splitter suction, flat floor, diffuser
 *      pump — with the ground-effect speed gain.
 *   2. Topside reads the per-car TOP profile (stagnation → hood suction →
 *      windshield compression → roof header …).
 *   3. NEWTONIAN IMPACT — the precision term. Freestream travels +z in the
 *      car frame (nose at −z); a surface "sees" the oncoming air when its
 *      normal has a −z component. Cp is pulled toward the stagnation value
 *      by facing² (the classic Cp = Cp_stag·sin²θ blunt-body model). This
 *      is what paints the heat/compression points red wherever they really
 *      are: mirror faces, the windshield base mid-car, bumper, intake lips,
 *      A-pillar leading edges — independent of where they sit along z.
 *      Rear-facing surfaces get base/wake suction instead. `shadow` (from
 *      the body-SDF upstream march) scales facing: a surface sitting in
 *      another part's wake gets impingement, not clean stagnation.
 *   4. WING TREATMENT at the measured anchors — chord-resolved:
 *      • Leading-edge stagnation stripe: frontmost 12% of the chord with a
 *        forward normal (nz < −0.2) blends to Cp +0.90 — the classic red
 *        LE stripe. Applied on the front wing / splitter AND the rear wing.
 *      • Suction only on SUCTION-SIDE normals (front wing: underside
 *        ny < −0.2; rear wing: forward-lower quadrant), weighted by a
 *        gaussian in chord distance (σ = 0.35·chord) peaking at 25% chord.
 *        Peak amplitudes preserved: −1.10 FW / −0.95 RW.
 *      • Endplates (|nx| > 0.7) excluded from all wing treatment.
 *      Chord comes from the anchor's measured bbox when present, else a
 *      fallback band around the anchor z (legacy widths).
 *
 * Everything scales with speedFactor so the overlay fades at rest.
 *
 * @param {number} x, y, z      — vertex position, car-local
 * @param {number} nx, ny, nz   — vertex normal (unit), car-local
 * @param {string} type         — car type for the Cp tables
 * @param {object} anchors      — measured anchor map (frontWing/rearWing/floor/noseTip…)
 * @param {number} speedFactor  — [0, 1]
 * @param {number} shadow       — upstream-shadowing factor ∈ (0, 1]; 1 = clean
 *                                freestream, 0.35 = body part sits upstream
 */
export function computeSurfaceCp(x, y, z, nx, ny, nz, type, anchors, speedFactor, shadow = 1) {
  if (!speedFactor) return 0;

  const floorY  = Number.isFinite(anchors?.floor?.y) ? anchors.floor.y : 0.03;
  const isUnder = ny < -0.35 || y < floorY + 0.05;

  let cp = lerpCpProfile(z, type, isUnder ? 'under' : 'top');

  // ── Wing classification (chord-resolved, normal-gated) ──────────
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const wingGeom = (anchor, fallbackHalfChord) => {
    const bb = anchor.bbox;
    if (bb && Number.isFinite(bb.minZ) && Number.isFinite(bb.maxZ) && bb.maxZ > bb.minZ) {
      return { minZ: bb.minZ, maxZ: bb.maxZ, minY: bb.minY, maxY: bb.maxY };
    }
    return { minZ: anchor.z - fallbackHalfChord, maxZ: anchor.z + fallbackHalfChord, minY: null, maxY: null };
  };

  let leW = 0;            // leading-edge stripe blend weight
  let wingSuction = 0;    // gaussian, gated suction contribution
  let sGate = 0;          // strongest suction gate — suppresses the impact term
  if (Math.abs(nx) <= 0.7) {   // endplates excluded from all wing treatment
    const rw = anchors?.rearWing;
    if (rw) {
      const g = wingGeom(rw, 0.35);
      const chord = g.maxZ - g.minZ;
      const yOk = (g.minY != null)
        ? (y >= g.minY - 0.10 && y <= g.maxY + 0.10)
        : (y > rw.y - 0.30);
      if (yOk && z >= g.minZ && z <= g.maxZ) {
        if (z < g.minZ + 0.12 * chord && nz < -0.2) {
          leW = Math.max(leW, clamp01((-nz - 0.2) / 0.4));
        }
        // Suction side of the inverted rear wing faces forward-and-down.
        const gate = clamp01((0.6 * -ny + 0.8 * -nz - 0.2) / 0.4);
        if (gate > 0) {
          const zp = g.minZ + 0.25 * chord;
          const sig = 0.35 * chord;
          const w = Math.exp(-((z - zp) ** 2) / (2 * sig * sig));
          wingSuction -= 0.95 * w * gate;
          sGate = Math.max(sGate, gate * w);
        }
      }
    }
    const fw = anchors?.frontWing;
    if (fw) {
      const g = wingGeom(fw, 0.30);
      const chord = g.maxZ - g.minZ;
      const yOk = (g.minY != null)
        ? (y >= g.minY - 0.10 && y <= g.maxY + 0.10)
        : (y < fw.y + 0.25);
      if (yOk && z >= g.minZ && z <= g.maxZ) {
        // LE stripe on both cars — F1 front wing / GT splitter lip.
        if (z < g.minZ + 0.12 * chord && nz < -0.2) {
          leW = Math.max(leW, clamp01((-nz - 0.2) / 0.4));
        }
        if (type === 'F1') {
          const gate = clamp01((-ny - 0.2) / 0.3);   // underside only
          if (gate > 0) {
            const zp = g.minZ + 0.25 * chord;
            const sig = 0.35 * chord;
            const w = Math.exp(-((z - zp) ** 2) / (2 * sig * sig));
            wingSuction -= 1.10 * w * gate;
            sGate = Math.max(sGate, gate * w);
          }
        }
      }
    }
  }

  if (!isUnder) {
    // Newtonian impact: pull toward stagnation by how squarely the surface
    // faces the flow. facing = −nz ∈ (0, 1]; impact = facing². Scaled by
    // `shadow` (upstream body ⇒ wake impingement, not clean stagnation) and
    // suppressed on wing suction sides (accelerating flow, not blunt-body).
    const facing = Math.max(0, -nz) * shadow;
    if (facing > 0) {
      const t = Math.min(1, facing * facing * 1.4) * (1 - sGate);
      cp = cp + (0.95 - cp) * t;
    }
    // Leeward base/wake suction on rear-facing surfaces.
    const lee = Math.max(0, nz);
    if (lee > 0) cp -= lee * lee * 0.35;

    // Mild residual nose blend — keeps the nose tip warm even where its
    // skin is nearly flow-parallel (real stagnation lines wrap the tip).
    const nose = anchors?.noseTip ?? anchors?.frontWing;
    if (nose && z < nose.z + 0.45) {
      const tN = Math.min(1, Math.max(0, 1 - (z - nose.z) / 0.45));
      cp = cp * (1 - 0.35 * tN) + 0.90 * 0.35 * tN;
    }
  }

  cp += wingSuction;

  if (isUnder) cp *= 1 + speedFactor * speedFactor * 0.30;

  // LE stagnation stripe LAST — the true heat line on the wing wins over
  // suction and the underbody ground-effect gain.
  if (leW > 0) cp = cp + (0.90 - cp) * leW;

  return cp * speedFactor;
}

/**
 * Cp readout for the hover probe. Converts a raycast hit on the overlay
 * (world frame — the CFD group is lifted by baseY) into the car-local frame
 * and evaluates the same surface model that painted the vertex colours.
 * Pure — exported for tests.
 *
 * @param {object} hit    — raycast intersection ({ point, face })
 * @param {string} type   — car type
 * @param {object} anchors
 * @param {number} sf     — speedFactor [0, 1]
 * @param {number} baseY  — CFD group lift (world y = car-local y + baseY)
 */
export function probeCp(hit, type, anchors, sf, baseY = 0) {
  const p = hit?.point ?? { x: 0, y: 0, z: 0 };
  const n = hit?.face?.normal ?? { x: 0, y: 1, z: 0 };
  return computeSurfaceCp(p.x, p.y - baseY, p.z, n.x, n.y, n.z, type, anchors, sf);
}

/**
 * Toggle the DOM colorbar legend with the CFD env state. Tiny and DOM-shape
 * agnostic so it is unit-testable without a browser.
 * @returns {boolean} whether the legend is now shown
 */
export function syncCfdLegend(el, active) {
  if (!el) return false;
  el.classList.toggle('show', !!active);
  return !!active;
}

/* ════════════════════════════════════════════════════════════════════
   CfdEffect class
════════════════════════════════════════════════════════════════════ */
export class CfdEffect {
  constructor(scene) {
    this.scene   = scene;
    this.group   = new THREE.Group();
    this.group.name = 'cfd';
    scene.add(this.group);

    this._speed          = 0;
    this._visible        = false;
    this._type           = 'F1';
    this._speedDirty     = true;
    this._lastBuiltSpeed = -1;
    this._baseY          = 0;
    this._anchors        = null;   // set by setCarType(type, measure)
    this._modifiers      = [];     // Phase C: injected via setModifiers()
    this._occupancy      = null;   // world-frame body SDF (setOccupancy)
    this._occBaseY       = 0;      // world y = car-local y + occBaseY

    this._patchMeshes    = [];
    this._blobMeshes     = [];
    this._vortexLines    = [];
    this._vortexDefs     = [];
    this._streamlines    = [];
    this._surfaceMeshes  = [];   // body-surface overlay (GLB cars)
    this._bodyMeshes     = null; // source meshes for the overlay
    this._bodyFrame      = null; // car group whose frame the overlay rebases into
    this._surfaceDirty   = false;

    this._build('F1');
    this.group.visible = false;
  }

  /* ── Public interface ─────────────────────────────────────────── */

  /**
   * Lift the CFD group so its car-local y coordinates align with the
   * actual on-track car (which sits at y = TRACK.SURFACE_Y - groundContactY).
   * Called from main.js after each spawnCar so patches/blobs/streamlines
   * follow the variant's true ride height instead of floating at y=0.
   */
  setBaseY(y) {
    this._baseY = y || 0;
    this.group.position.y = this._baseY;
  }

  /**
   * Provide the REAL body meshes (collectOccupancyMeshes output) plus the
   * car group whose local frame the overlay is rebased into. When present,
   * the next (re)build paints Cp directly on cloned body geometry and
   * suppresses the floating rectangle patches. Pass (null, null) to clear
   * (procedural fallback → rectangles return).
   */
  setBodySurface(meshes, carGroup) {
    this._bodyMeshes = (Array.isArray(meshes) && meshes.length > 0) ? meshes : null;
    this._bodyFrame  = this._bodyMeshes ? carGroup : null;
    this._surfaceDirty = true;
  }

  setCarType(type, measure) {
    // Anchors may be supplied alongside the type (preferred). Fall back to
    // the prior anchors if omitted so external callers that still use the
    // single-arg form keep working.
    const newAnchors = (measure && measure.anchors) ? measure.anchors : null;
    const anchorsChanged = newAnchors && newAnchors !== this._anchors;
    if (newAnchors) this._anchors = newAnchors;

    // Rebuild when the type changes OR when the anchor set refreshes (so the
    // initial F1 spawn — same type, but anchors arriving for the first time —
    // re-anchors blobs to the measured positions instead of authored ones)
    // OR when a new body surface arrived via setBodySurface.
    if (this._type === type && !anchorsChanged && !this._surfaceDirty) return;
    this._surfaceDirty = false;
    this._type = type;
    this._disposeAll();
    this._build(type);
    this.group.visible = this._visible;
    this._lastBuiltSpeed = -1;
    this.group.position.y = this._baseY;
  }

  setSpeed(speed) {
    this._speed      = speed;
    this._speedDirty = true;
  }

  /**
   * Phase C: inject the analytical modifier list produced by
   * AirflowEffect.getModifiers() so the CFD Cp map reflects the same
   * feature-aware flow (sinks at inlets, sources at outlets, wing dipoles).
   *
   * Triggers a vertex-colour regeneration; an empty list restores the
   * pre-Phase-C colouring exactly.
   */
  setModifiers(modifiers) {
    this._modifiers  = Array.isArray(modifiers) ? modifiers : [];
    this._speedDirty = true;
    // Rebake vertex colours on the next update() pass. Force the threshold
    // test by bumping lastBuiltSpeed away from current.
    this._lastBuiltSpeed = -9999;
  }

  /**
   * Provide the world-frame body-occupancy SDF (buildOccupancy output) for
   * upstream shadowing of the Newtonian impact term. The SDF is world-frame;
   * overlay vertices are car-local, so samples go through y + baseY (the
   * occupancy frame convention shared with AirflowEffect). Arrival forces a
   * recolor on the next update() pass.
   */
  setOccupancy(occ, baseY = 0) {
    this._occupancy = (occ && typeof occ.sample === 'function') ? occ : null;
    this._occBaseY  = baseY || 0;
    this._speedDirty     = true;
    this._lastBuiltSpeed = -9999;   // force the recolor threshold
  }

  setVisible(v) {
    this._visible      = v;
    this.group.visible = v;
  }

  /**
   * Hover probe: raycast the body-surface overlay clones only (cheap — the
   * caller throttles) and return the Cp at the hit, or null. Only answers
   * while CFD is visible and the GLB overlay exists.
   */
  raycastCp(raycaster) {
    if (!this._visible || this._surfaceMeshes.length === 0) return null;
    const meshes = this._surfaceMeshes.map(s => s.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const sf = Math.min(this._speed / 350, 1);
    return {
      cp:    probeCp(hits[0], this._type, this._anchors, sf, this._baseY),
      point: hits[0].point,
    };
  }

  update(dt, t) {
    if (!this._visible) return;

    const speedFactor = Math.min(this._speed / 350, 1);

    // Refresh patch / surface vertex colours when speed changes meaningfully
    if (this._speedDirty && Math.abs(this._speed - this._lastBuiltSpeed) > 5) {
      this._updatePatchColors(speedFactor);
      this._updateSurfaceColors(speedFactor);
      this._lastBuiltSpeed = this._speed;
      this._speedDirty     = false;
    }

    // ── Zone blobs: pulse scale + opacity ─────────────────────────
    const blobs = ZONE_BLOBS[this._type] || ZONE_BLOBS.F1;
    for (let i = 0; i < this._blobMeshes.length; i++) {
      const blob = blobs[i];
      if (!blob || !this._blobMeshes[i]) continue;

      const eff_int = blob.intensity;

      const pulsed = 0.80 + 0.20 * Math.sin(t * 2.2 + blob.phase);
      this._blobMeshes[i].scale.setScalar(
        speedFactor * speedFactor * eff_int * 0.28 * pulsed
      );
      this._blobMeshes[i].material.opacity =
        speedFactor * eff_int * 0.58 * (0.72 + 0.28 * Math.sin(t * 2.2 + blob.phase));
    }

    // ── Vortex core spirals — anchor-resolved defs from _build ────
    const vDefs = this._vortexDefs;
    for (let vi = 0; vi < this._vortexLines.length; vi++) {
      const def = vDefs[vi];
      if (!def) continue;
      const { geo, mat } = this._vortexLines[vi];
      const pos = geo.attributes.position.array;
      const r   = speedFactor * def.radius;

      for (let pi = 0; pi < VORTEX_PTS; pi++) {
        const frac  = pi / VORTEX_PTS;
        const decay = 1 - frac * 0.55;
        const angle = frac * Math.PI * 7 * def.sign + t * 1.4;
        pos[pi * 3]     = def.x + Math.cos(angle) * r * decay;
        pos[pi * 3 + 1] = def.y + Math.sin(angle) * r * 0.55 * decay;
        pos[pi * 3 + 2] = def.z + frac * def.length;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = speedFactor * 0.72;
    }

    // ── Animated streamlines (nose → tail traveling wave) ─────────
    const sDefs = STREAMLINE_DEFS[this._type] || STREAMLINE_DEFS.F1;
    for (let li = 0; li < this._streamlines.length; li++) {
      const def = sDefs[li];
      if (!def) continue;
      const { geo, mat } = this._streamlines[li];
      const pos = geo.attributes.position.array;
      const col = geo.attributes.color.array;
      const zRange = def.zEnd - def.zStart;

      for (let pi = 0; pi < STREAM_PTS; pi++) {
        const frac  = pi / (STREAM_PTS - 1);
        const z     = def.zStart + frac * zRange;
        // Traveling pressure wave moving front→rear
        const phase = frac * Math.PI * 3.5 - t * 2.8;

        pos[pi * 3]     = def.x + Math.sin(phase)        * def.waveX * speedFactor;
        pos[pi * 3 + 1] = def.y + Math.cos(phase * 0.6)  * def.waveY * speedFactor;
        pos[pi * 3 + 2] = z;

        // Cp-based color from the per-car TOP-surface profile (streamlines
        // ride over the upper body), modulated by speed
        const cp = lerpCpProfile(z, this._type, 'top') * speedFactor;
        const c  = cpToColor(cp);
        col[pi * 3]     = c.r;
        col[pi * 3 + 1] = c.g;
        col[pi * 3 + 2] = c.b;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate    = true;
      mat.opacity = speedFactor * 0.82;
    }
  }

  dispose() {
    this._disposeAll();
    this.scene.remove(this.group);
  }

  /* ── Internal build / dispose ─────────────────────────────────── */

  _disposeAll() {
    for (const child of [...this.group.children]) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material?.dispose();
      this.group.remove(child);
    }
    this._patchMeshes   = [];
    this._blobMeshes    = [];
    this._vortexLines   = [];
    this._streamlines   = [];
    this._surfaceMeshes = [];
  }

  _build(type) {
    // Resolve vortex cores once per build — patches, the per-vertex Cp
    // perturbation, and the spiral lines all read the same resolved set.
    this._vortexDefs = resolveVortexCores(type, this._anchors);
    // GLB cars paint Cp on the real body surface; rectangle patches are the
    // procedural fallback only — never both (the rectangles were the
    // "weird shapes running through the car").
    if (this._bodyMeshes) {
      this._buildSurfaceOverlay();
    } else {
      this._buildPatches(type);
    }
    this._buildBlobs(type);
    this._buildVortexCores(type);
    this._buildStreamlines(type);
  }

  /* ── Body-surface Cp overlay ──────────────────────────────────── */
  _buildSurfaceOverlay() {
    const frame = this._bodyFrame;
    const invFrame = new THREE.Matrix4();
    if (frame?.matrixWorld) {
      frame.updateMatrixWorld?.(true);
      invFrame.copy(frame.matrixWorld).invert();
    }

    for (const src of this._bodyMeshes) {
      if (!src?.geometry?.attributes?.position) continue;
      src.updateMatrixWorld?.(true);

      // Rebase into the car group's local frame: the CFD group's baseY lift
      // then matches the on-track car exactly (same convention as patches).
      const geo = src.geometry.clone();
      const rel = new THREE.Matrix4().multiplyMatrices(invFrame, src.matrixWorld);
      geo.applyMatrix4(rel);

      // Inflate ~12 mm along the (re-based) normals so the additive overlay
      // floats just off the paint instead of z-fighting with it.
      const pos = geo.attributes.position;
      const nrm = geo.attributes.normal;
      if (nrm) {
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(
            i,
            pos.getX(i) + nrm.getX(i) * 0.012,
            pos.getY(i) + nrm.getY(i) * 0.012,
            pos.getZ(i) + nrm.getZ(i) * 0.012,
          );
        }
      }

      const colors = new Float32Array(pos.count * 3);
      const c0 = cpToColor(0);
      for (let i = 0; i < pos.count; i++) {
        colors[i * 3] = c0.r; colors[i * 3 + 1] = c0.g; colors[i * 3 + 2] = c0.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent:  true,
        opacity:      0,
        depthWrite:   false,
        blending:     THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `cfdSurface_${src.name}`;
      this.group.add(mesh);
      this._surfaceMeshes.push({ mesh });
    }
  }

  /* ── Per-vertex Cp colouring of the body overlay ──────────────── */
  _updateSurfaceColors(speedFactor) {
    const occ  = this._occupancy;
    const occY = this._occBaseY;
    for (const { mesh } of this._surfaceMeshes) {
      const pos = mesh.geometry.attributes.position;
      const nrm = mesh.geometry.attributes.normal;
      const col = mesh.geometry.attributes.color;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const vnx = nrm ? nrm.getX(i) : 0;
        const vny = nrm ? nrm.getY(i) : 1;
        const vnz = nrm ? nrm.getZ(i) : 0;
        // Upstream shadowing: march 3 samples toward the nose (−z) through
        // the world-frame body SDF. First sample starts 0.15 m out — beyond
        // the 12 mm inflation + local part thickness, so a wing LE never
        // self-shadows. Any hit ⇒ this face sits in another part's wake.
        let shadow = 1;
        if (occ && vnz < 0) {
          const wy = py + occY;
          if (occ.sample(px, wy, pz - 0.15) > 0.5 ||
              occ.sample(px, wy, pz - 0.30) > 0.5 ||
              occ.sample(px, wy, pz - 0.45) > 0.5) shadow = 0.35;
        }
        const cp = computeSurfaceCp(
          px, py, pz, vnx, vny, vnz,
          this._type, this._anchors, speedFactor, shadow,
        );
        // Emphasis map: cpRef scaled by the current speed's attainable peak
        // so the heat-point pattern is legible at 100 km/h too.
        const c = cpToEmphasisColor(cp, 0.9 * speedFactor, 2.2 * speedFactor);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      col.needsUpdate = true;
      mesh.material.opacity = speedFactor * 0.85;
    }
  }

  /**
   * Build a z-axis remap function from the authored CFD_PATCHES[type] z
   * envelope onto the actual measured bodyshell envelope (frontWing.z …
   * rearWing.z). Returns null when the measure lacks the needed anchors —
   * patches then keep their authored z verbatim.
   *
   * The GT GLB bodyshell (after bug 1's bodyshell-aware bbox fix) is
   * shorter than the authored CFD_PATCHES.GT z span; without the remap the
   * patches float past the nose and behind the rear bumper, which is the
   * "CFD not calculated to size of the car" symptom the user reported.
   */
  _buildPatchZRemap(type) {
    const a = this._anchors;
    if (!a || !a.frontWing || !a.rearWing) return null;
    const targetMin = a.frontWing.z;
    const targetMax = a.rearWing.z;
    if (!(targetMax > targetMin)) return null;

    const patches = CFD_PATCHES[type] || CFD_PATCHES.F1;
    if (patches.length < 2) return null;
    let authMin =  Infinity, authMax = -Infinity;
    for (const p of patches) {
      if (p.cz < authMin) authMin = p.cz;
      if (p.cz > authMax) authMax = p.cz;
    }
    if (!(authMax > authMin)) return null;

    const k = (targetMax - targetMin) / (authMax - authMin);
    return (z) => targetMin + (z - authMin) * k;
  }

  /* ── Surface pressure patches ─────────────────────────────────── */
  _buildPatches(type) {
    const patches = CFD_PATCHES[type] || CFD_PATCHES.F1;
    // Remap the authored patch envelope onto the MEASURED body for every
    // car. Null (no anchors yet — procedural fallback / first build) keeps
    // the authored envelope verbatim.
    const remapZ = this._buildPatchZRemap(type);

    for (const p of patches) {
      const geo   = new THREE.PlaneGeometry(p.w, p.h, PATCH_SEG, PATCH_SEG);
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);

      // Initialise to freestream green
      for (let vi = 0; vi < count; vi++) {
        const c = cpToColor(0);
        colors[vi * 3]     = c.r;
        colors[vi * 3 + 1] = c.g;
        colors[vi * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent:  true,
        opacity:      0.68,
        depthWrite:   false,
        blending:     THREE.AdditiveBlending,
        side:         THREE.DoubleSide,
      });

      const cz = remapZ ? remapZ(p.cz) : p.cz;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(p.cx, p.cy, cz);
      m.rotation.set(p.rx, p.ry, p.rz);
      // Store the EFFECTIVE patch def (with remapped cz) so the Cp recompute
      // and zone-blob/vortex distance checks operate against the actual
      // rendered position, not the authored one.
      m.userData.patchDef = (cz === p.cz) ? p : { ...p, cz };
      this.group.add(m);
      this._patchMeshes.push(m);
    }
  }

  /* ── Role-specific per-vertex Cp colouring ────────────────────── */
  _updatePatchColors(speedFactor) {
    const vortexCores = this._vortexDefs;

    for (let pi = 0; pi < this._patchMeshes.length; pi++) {
      const m = this._patchMeshes[pi];
      // Use the EFFECTIVE patch def stored at build time — for GT this
      // carries the z-remapped cz so under-body Cp sampling reads the
      // longitudinal profile at the actual rendered position.
      const p = m?.userData?.patchDef;
      if (!m || !p) continue;

      const pos    = m.geometry.attributes.position.array;
      const colors = m.geometry.attributes.color.array;
      const count  = m.geometry.attributes.position.count;

      for (let vi = 0; vi < count; vi++) {
        const lx = pos[vi * 3];
        const ly = pos[vi * 3 + 1];
        const cp = computePatchCp(p, lx, ly, speedFactor, this._modifiers, vortexCores, this._type);
        // Same emphasis map as the body-surface overlay — the procedural
        // fallback must stay visually consistent with the GLB path.
        const c  = cpToEmphasisColor(cp, 0.9 * speedFactor, 2.2 * speedFactor);
        colors[vi * 3]     = c.r;
        colors[vi * 3 + 1] = c.g;
        colors[vi * 3 + 2] = c.b;
      }

      m.geometry.attributes.color.needsUpdate = true;
      m.material.opacity = speedFactor * 0.68;
    }
  }

  /**
   * Resolve a blob's position from the per-car anchor map when possible,
   * falling back to the authored [x,y,z] in ZONE_BLOBS.
   *
   * The authored values carry meaningful *nudges* (e.g. the stagnation blob
   * sits AHEAD of the nose tip to show oncoming compression, and the diffuser
   * blob sits BELOW the floor). When an anchor is available we:
   *   - replace x (allowing left/right offsets to be honoured verbatim from
   *     the authored value; anchors are centerline for every current role)
   *   - replace y with the anchor's y, but NEVER below the authored y
   *     (the authored y encodes a ground-clearance nudge for diffuser/stag)
   *   - replace z with the anchor's z
   *
   * Role → anchor map:
   *   cockpit       → cockpit
   *   rearWing      → rearWing
   *   fwCenter      → frontWing
   *   stagnation    → frontWing (slightly ahead in Z — preserved via min-Z)
   *   diffuser      → floor (synthesised) — Z preserved from authored value
   *                   because diffuser sits behind bodyShell, not at it
   */
  _resolveBlobPos(role, authored) {
    const a = this._anchors;
    if (!a) return authored;
    const [ax, ay, az] = authored;
    let x = ax, y = ay, z = az;

    const pick = (anchor) => {
      if (!anchor) return;
      x = ax;                       // keep authored lateral nudges
      y = Math.max(ay, anchor.y);   // min-floor on Y to preserve clearance
      z = anchor.z;
    };

    if (role === 'cockpit')      pick(a.cockpit);
    else if (role === 'rearWing') pick(a.rearWing);
    else if (role === 'fwCenter') pick(a.frontWing);
    else if (role === 'stagnation') {
      // nose stagnation sits just ahead of the front wing tip — use frontWing
      // as the reference but retain the authored Z (further forward).
      const fw = a.frontWing;
      if (fw) { y = Math.max(ay, fw.y); /* keep authored x, z */ }
    }
    else if (role === 'diffuser') {
      // floor anchor gives ground-plane Y; the authored Z (well aft of
      // bodyShell) stays — diffuser is not at the body-center Z.
      const fl = a.floor;
      if (fl) { y = Math.min(ay, fl.y); /* authored already below */ }
    }

    return [x, y, z];
  }

  /* ── Zone blobs ───────────────────────────────────────────────── */
  _buildBlobs(type) {
    const blobs = ZONE_BLOBS[type] || ZONE_BLOBS.F1;
    for (const blob of blobs) {
      const geo = new THREE.SphereGeometry(blob.r, 14, 12);
      const mat = new THREE.MeshBasicMaterial({
        color:       blob.color,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
        side:        THREE.BackSide,
      });
      const m = new THREE.Mesh(geo, mat);
      const [x, y, z] = this._resolveBlobPos(blob.role, blob.pos);
      m.position.set(x, y, z);
      m.userData.blobRole = blob.role;
      // Declutter: when Cp is painted on the real body (GLB overlay path),
      // the stagnation/cockpit glow spheres just duplicate the paint — hide
      // them. Volumes the paint cannot show (diffuser/suction/vortices) and
      // the procedural fallback keep every blob.
      if (this._bodyMeshes && (blob.role === 'stagnation' || blob.role === 'cockpit')) {
        m.visible = false;
      }
      this.group.add(m);
      this._blobMeshes.push(m);
    }
  }

  /* ── Vortex core spiral lines ─────────────────────────────────── */
  _buildVortexCores(_type) {
    for (let i = 0; i < this._vortexDefs.length; i++) {
      const positions = new Float32Array(VORTEX_PTS * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color:       0x44ffcc,
        transparent: true,
        opacity:     0,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geo, mat);
      this.group.add(line);
      this._vortexLines.push({ geo, mat, line });
    }
  }

  /* ── Animated streamlines ─────────────────────────────────────── */
  _buildStreamlines(type) {
    const sDefs = STREAMLINE_DEFS[type] || STREAMLINE_DEFS.F1;
    for (const def of sDefs) {
      const positions = new Float32Array(STREAM_PTS * 3);
      const colors    = new Float32Array(STREAM_PTS * 3);

      // Pre-fill positions along z so something renders at first update
      const zRange = def.zEnd - def.zStart;
      for (let pi = 0; pi < STREAM_PTS; pi++) {
        positions[pi * 3]     = def.x;
        positions[pi * 3 + 1] = def.y;
        positions[pi * 3 + 2] = def.zStart + (pi / (STREAM_PTS - 1)) * zRange;
        const c = cpToColor(0);
        colors[pi * 3]     = c.r;
        colors[pi * 3 + 1] = c.g;
        colors[pi * 3 + 2] = c.b;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent:  true,
        opacity:      0,
        depthWrite:   false,
        blending:     THREE.AdditiveBlending,
      });

      const line = new THREE.Line(geo, mat);
      this.group.add(line);
      this._streamlines.push({ geo, mat, line });
    }
  }
}
