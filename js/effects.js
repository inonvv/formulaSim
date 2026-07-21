/**
 * effects.js — Visual effects system
 * Manages: Airflow, Rain, Optimal Weather
 */

import * as THREE from 'three';
import {
  traceStreamlinePath, topViewVelocity,
  vortexVelocity, sideViewVelocity,
  venturiSpeedRatio, cpToColor,
} from './airflow-core.js';
import { lerpCpProfile } from './cfd-effect.js';
import { ribbonDrift, rainLateralAccel } from './track-path.js';

/* ── Phase C modifier strengths (VISUAL approximations, not CFD-calibrated) ── *
 * Each vent/wing in AirflowEffect._buildModifiers emits an entry into the
 * modifier table consumed by sumVelocity. Numeric values match the table in
 * docs/plans/calm-petting-willow.md §Phase C3.
 * -------------------------------------------------------------------------- */
const MOD_STR = Object.freeze({
  SIDEPOD_INLET:    { strength: 0.25, rc: 0.12 },
  SIDEPOD_EXHAUST:  { strength: 0.20, rc: 0.12 },
  AIRBOX_INTAKE:    { strength: 0.15, rc: 0.10 },
  EXHAUST_PIPE:     { strength: 0.30, rc: 0.12 },
  BRAKE_DUCT:       { strength: 0.15, rc: 0.10 },
  FRONT_WING_VORT:  { gamma:    0.6,  rc: 0.12 },
  REAR_WING_VORT:   { gamma:    1.0,  rc: 0.12 },
});

/* Fallback (xi, eta) scaling when a profile lacks halfW/halfL. Matches the
 * default basis used by traceStreamlinePath and CAR_AERO.F1. */
const DEFAULT_HALF_L = 2.4;
const DEFAULT_HALF_W = 0.9;

/* ── Utility ───────────────────────────────────────────────────── */
function rnd(min, max) { return min + Math.random() * (max - min); }

/* ── Soft radial puff for ribbon fog haloes (shared singleton) ── */
let _puffTex = null;
function _makePuffTexture() {
  if (_puffTex) return _puffTex;
  if (typeof document === 'undefined' || !document.createElement) {
    _puffTex = new THREE.CanvasTexture({});
    return _puffTex;
  }
  const size   = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Softer, fluffier falloff — lower peak + broader mid-band so stacked
  // puffs blur into each other as diffuse haze instead of bright dots.
  grd.addColorStop(0.00, 'rgba(255,255,255,0.38)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.26)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  grd.addColorStop(0.85, 'rgba(255,255,255,0.03)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  _puffTex = new THREE.CanvasTexture(canvas);
  _puffTex.needsUpdate = true;
  return _puffTex;
}

/* ── Elliptical alpha-mask for wet-ground soft edges ────────────── */
let _wetMaskTex = null;
function _makeWetMaskTexture() {
  const size   = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.80)');
  grd.addColorStop(0.85, 'rgba(255,255,255,0.20)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/* ════════════════════════════════════════════════════════════════ */
/*  AIRFLOW EFFECT — potential-flow based, 3-D corrected            */
/* ════════════════════════════════════════════════════════════════ */

const STEPS     = 200;
const STEP_SIZE = 0.14;
const VORTEX_PTS = 100;

/* ── Venturi underfloor channel ──────────────────────────────────── *
 * Dedicated 'underfloor' ribbon group: floor flow does NOT divert
 * around the cylinder body like the top-view potential flow — it runs
 * straight through the floor gap, accelerating via Bernoulli:
 *   V/V∞ = √(1 − Cp)   (venturiSpeedRatio in airflow-core.js)
 * F1 uses a dedicated channel profile (single throat peak Cp −1.10 at
 * the diffuser inlet → 1.45× freestream) — the CFD body table's
 * front-wing stagnation spike (+0.90/−2.20 within 20 cm) is physical
 * for the WING but made the channel pulse stall-then-whip at the nose.
 * GT keeps its calibrated under table (splitter suction is real aero).
 * ------------------------------------------------------------------ */
const UNDERFLOOR_LANES = [-0.7, -0.35, 0, 0.35, 0.7];
const UF_RAMP_START_Z  = 1.4;   // venturi throat = diffuser inlet (car-frame m)
const UF_RAMP_END_Z    = 2.6;   // full expansion past the rear bumper
const UF_RAMP_RISE     = 0.30;  // diffuser upwash height (m)
const UF_SEED_ETA      = -2.2;  // ≈1.2 half-lengths ahead of the nose — no 20 m rails
const UF_PATH_END_ETA  = 2.8;   // ≈4.4 m downstream of the rear bumper
const UF_PATH_VERTS    = 64;    // z-spacing ≈ 0.19 m at halfL 2.45 (matches fog ribbons)
const UF_FADE_IN_VERTS  = 6;    // ≈1.2 m brightness ramp at the streak entry
const UF_FADE_OUT_VERTS = 10;   // ≈1.9 m dissolve at the tail

// F1 venturi channel Cp — textbook shape: smooth acceleration from the
// floor leading edge to a single throat suction peak, then diffuser
// pressure recovery. Airflow-ribbon-only; CFD surface painting keeps
// the regression-locked CP_TABLES in cfd-effect.js.
const F1_CHANNEL_TABLE = [
  [-3.00,  0.05],   // gentle entry, near freestream
  [-2.45, -0.35],   // floor leading edge — flow already drawn in
  [-1.50, -0.55],   // forward floor
  [ 0.00, -0.70],   // mid floor, channel converging
  [ 1.40, -1.10],   // throat / diffuser inlet — the single suction peak
  [ 2.20, -0.35],   // diffuser pressure recovery
  [ 2.60,  0.02],   // exit, back to ~freestream
];

function lerpTable(table, z) {
  if (z <= table[0][0]) return table[0][1];
  if (z >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [z0, c0] = table[i];
    const [z1, c1] = table[i + 1];
    if (z >= z0 && z <= z1) return c0 + ((z - z0) / (z1 - z0)) * (c1 - c0);
  }
  return 0;
}

/**
 * Channel-flow Cp at a car-frame z — what the air INSIDE the floor gap
 * experiences, as opposed to the body-surface Cp painted by CFD mode.
 */
export function underfloorChannelCp(zCar, type) {
  if (type === 'F1') return lerpTable(F1_CHANNEL_TABLE, zCar);
  return lerpCpProfile(zCar, type, 'under');
}

/**
 * Lateral channel shape: streamlines converge slightly into the throat
 * (continuity — the floor gap narrows) and expand out of the diffuser.
 * Returns a multiplier on the seed xi.
 */
export function underfloorWidthScale(zCar) {
  const ease = t => t * t * (3 - 2 * t);
  if (zCar <= -2.6) return 1.0;
  if (zCar <= UF_RAMP_START_Z) {
    const t = (zCar + 2.6) / (UF_RAMP_START_Z + 2.6);
    return 1.0 - 0.08 * ease(t);            // 1.00 → 0.92 into the throat
  }
  if (zCar <= UF_RAMP_END_Z) {
    const t = (zCar - UF_RAMP_START_Z) / (UF_RAMP_END_Z - UF_RAMP_START_Z);
    return 0.92 + 0.23 * ease(t);           // 0.92 → 1.15 out of the diffuser
  }
  return 1.15;
}

/**
 * Suction-tint mix weight — eases toward the CFD palette with |Cp| but
 * hard-caps below full saturation so the streak keeps its white smoke
 * identity instead of snapping to a neon rod.
 */
export function underfloorTintMix(cpEff) {
  if (!cpEff) return 0;
  return 0.85 * Math.min(1, Math.abs(cpEff) / 1.6);
}

/**
 * Underfloor ribbon height: flat in the floor gap, then an eased rise
 * through the diffuser ramp (upwash).
 *
 * @param {number} zCar - car-frame longitudinal position (m)
 * @param {number} y0   - floor-gap ribbon height (m)
 */
export function underfloorY(zCar, y0) {
  if (zCar <= UF_RAMP_START_Z) return y0;
  const t = Math.min(1, (zCar - UF_RAMP_START_Z) / (UF_RAMP_END_Z - UF_RAMP_START_Z));
  return y0 + UF_RAMP_RISE * t * t;
}

/**
 * Effective underfloor Cp at a car-frame z: the calibrated per-car
 * profile, windowed to the car footprint (fades to freestream beyond
 * 1.25–1.9 half-lengths) and scaled by speedFactor² like the CFD
 * ground effect (downforce ∝ V²).
 */
export function underfloorCp(zCar, type, halfL, speedFactor) {
  if (!speedFactor) return 0;
  const zAbs = Math.abs(zCar);
  const full = halfL * 1.25, zero = halfL * 1.9;
  if (zAbs >= zero) return 0;
  const w = zAbs <= full ? 1 : 1 - (zAbs - full) / (zero - full);
  return underfloorChannelCp(zCar, type) * w * speedFactor * speedFactor;
}

/**
 * Fog development envelope along the flow direction (eta, car half-length
 * units; nose ≈ −1). Wind-tunnel smoke is laminar and crisp BEFORE the car
 * and only diffuses around the body and wake — so halo fog is nearly off
 * upstream (0.12) and smoothsteps to full over the nose → cockpit span.
 * This also stops the additive halos of all converging ribbons from
 * blowing out into a white blob at the nose.
 */
export function fogEnvelope(eta) {
  const t = Math.max(0, Math.min(1, (eta + 1.1) / 1.2));
  const s = t * t * (3 - 2 * t);
  return 0.05 + 0.95 * s;
}

/**
 * Straight-through channel path for an underfloor seed — constant xi
 * (venturi tunnels are longitudinal), uniform eta sampling. Speed and
 * pressure are expressed per-vertex in the update loop (puff advection
 * rate + Cp tint), not in the path shape.
 */
function _traceUnderfloorPath(seedXi, seedEta, halfL) {
  const path = [];
  const dEta = (UF_PATH_END_ETA - seedEta) / (UF_PATH_VERTS - 1);
  for (let i = 0; i < UF_PATH_VERTS; i++) {
    const eta = seedEta + i * dEta;
    const xi  = seedXi * underfloorWidthScale(eta * halfL);
    path.push({ xi, eta, vxi: 0, veta: 1 });
  }
  return path;
}

/* ── Per-car aerodynamic profiles ── *
 * Seed lists are no longer authored here — `_buildSeedList` synthesises the
 * full streamline set from `measure.anchors` (front wing, sidepod, halo,
 * rear wing, floor) + `measure.rearAxleX/Z`. The previous generic sweeps
 * (`top`, `side`, `under`, `fw`, `body`, `spine`, `far`) painted the whole
 * airspace regardless of car shape and drowned the anchor-driven streams.
 * --------------------------------------------------------------------- */
const CAR_AERO = {
  F1: {
    halfW: 0.90, halfL: 2.45, halfH: 0.55,
    pressureBlobs: [
      { color:0xff2200, r:0.40, intensity:1.00, pos:[0, 0.12,-2.50] },
      { color:0x2266ff, r:0.50, intensity:0.90, pos:[0, 0.02,-2.60] },
      { color:0xff2200, r:0.36, intensity:0.70, pos:[0, 0.88, 1.85] },
      { color:0x2266ff, r:0.55, intensity:0.95, pos:[0, 0.75, 1.85] },
      { color:0x00ddff, r:0.80, intensity:0.90, pos:[0,-0.05, 0.00] },
      { color:0xff4400, r:0.30, intensity:0.70, pos:[ 0.85, 0.04,-1.60] },
      { color:0xff4400, r:0.30, intensity:0.70, pos:[-0.85, 0.04,-1.60] },
      { color:0x0066ff, r:0.18, intensity:0.50, phase:1.5, pos:[0, 0.10,-2.72] },
      { color:0xff6600, r:0.28, intensity:0.75, phase:0.8, pos:[0, 0.52,-0.45] },
    ],
    vortexDefs: [
      {role:'frontWing', wx:-0.82,wy:0.02,wz:-2.60,sign: 1, gamma:0.6, rc:0.12},
      {role:'frontWing', wx: 0.82,wy:0.02,wz:-2.60,sign:-1, gamma:0.6, rc:0.12},
      {role:'rearWing',  wx:-0.90,wy:0.85,wz: 1.85,sign:-1, gamma:1.0, rc:0.18},
      {role:'rearWing',  wx: 0.90,wy:0.85,wz: 1.85,sign: 1, gamma:1.0, rc:0.18},
      // under-car ground vortices (floor edge)
      {role:'floor',     wx:-0.88,wy:-0.05,wz: 0.50,sign: 1, gamma:0.4, rc:0.10},
      {role:'floor',     wx: 0.88,wy:-0.05,wz: 0.50,sign:-1, gamma:0.4, rc:0.10},
    ],
    // Reduced from 0.40 — the 0.40 spiral overlapped the front-left wheel
    // when wz snapped to measure.anchors.frontWing.z, reading as a rainbow
    // bullseye on the tyre. 0.22 keeps the core visible without tyre clash.
    vortexMaxRadius:0.22, wakeWidthX:1.0,
    wakeHeightRange:[-0.10,1.20], wakeCount:220,
    strouhal: 0.21,  // Strouhal number for vortex shedding frequency
  },
  GT: {
    halfW: 1.05, halfL: 2.40, halfH: 0.65,
    pressureBlobs: [
      { color:0xff2200, r:0.55, intensity:0.85, pos:[ 0.00, 0.25,-2.26] },
      { color:0x2266ff, r:0.45, intensity:0.55, pos:[ 0.00, 0.10,-2.30] },
      { color:0xff2200, r:0.40, intensity:0.60, pos:[ 0.00, 0.75, 1.80] },
      { color:0x2266ff, r:0.50, intensity:0.65, pos:[ 0.00, 0.60, 1.80] },
      { color:0x4488ff, r:0.50, intensity:0.55, pos:[ 0.85, 0.28, 0.00] },
      { color:0x4488ff, r:0.50, intensity:0.55, pos:[-0.85, 0.28, 0.00] },
      { color:0xff6600, r:0.28, intensity:0.75, phase:1.1, pos:[0, 0.68,-0.50] },
    ],
    vortexDefs: [
      {role:'rearWing', wx:-0.86,wy:0.72,wz: 1.80,sign:-1, gamma:0.8, rc:0.14},
      {role:'rearWing', wx: 0.86,wy:0.72,wz: 1.80,sign: 1, gamma:0.8, rc:0.14},
      {role:'rearWing', wx:-0.93,wy:0.12,wz: 1.60,sign: 1, gamma:0.5, rc:0.10},
      {role:'rearWing', wx: 0.93,wy:0.12,wz: 1.60,sign:-1, gamma:0.5, rc:0.10},
    ],
    vortexMaxRadius:0.28, wakeWidthX:1.50,
    wakeHeightRange:[-0.08,1.00], wakeCount:250,
    strouhal: 0.22,
  },
};

function getProfile(type) { return CAR_AERO[type] || CAR_AERO.F1; }

/**
 * When no measure is supplied (unit-test path, or pre-setCarType bootstrap),
 * synthesise a minimal anchor set from `profile.halfW/halfL/halfH`. The
 * ratios match the PROCEDURAL_ANCHORS table in `cars.js` so the same
 * streamlines render whether the car builder published a measure or not.
 */
function _fallbackAnchors(p) {
  return {
    frontWing:  { x: 0, y: 0.04,             z: -p.halfL * 1.06 },
    rearWing:   { x: 0, y: p.halfH * 1.79,   z:  p.halfL * 0.80 },
    halo:       { x: 0, y: p.halfH * 1.93,   z:  0.00           },
    sidepodTop: { x: 0, y: p.halfH * 0.84,   z:  0.10           },
    floor:      { x: 0, y: 0.04,             z:  0.00           },
  };
}

/**
 * Deterministic 1-D hash → small ±range jitter so each seed's `seedEta`
 * starts at a slightly different advection phase. Keeps the streams from
 * arriving synchronously without breaking test determinism (identical seed
 * indices always produce identical jitter).
 */
function _seedEtaJitter(seedIdx, range = 0.3) {
  // Cheap bit-mix hash (Mulberry32 step) → [0,1) → (-range, +range).
  let h = (seedIdx * 0x9e3779b1) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  h  = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h / 0xffffffff) * 2 - 1) * range;
}

/**
 * Build the streamline seed list as a wind-tunnel-style parallel ribbon
 * grid: 8 heights (floor → above halo) × 5 lateral positions, all seeded
 * far upstream at `seedEta ≈ -8`. Every seed produces one continuous line
 * from upstream entry, around the car body, out behind — reproducing the
 * "smoke ribbons" look in `fog.png` rather than isolated anchor chunks.
 *
 * Anchors are still consumed, but only for vertical placement of the
 * ribbons (halo pins the upper half; floor/frontWing pin the lower half).
 * Flow bending at features (sidepod sinks, wing vortices) is handled by
 * `_buildModifiers`, not by the seed list.
 */
function _buildSeedList(p, measure) {
  const anchors = measure?.anchors ?? _fallbackAnchors(p);

  // Anchor-aware vertical extent: bottom = floor.y, top = halo.y + 0.40.
  // Falls back to the profile's halfH ratio when anchors are missing.
  const floorY = Number.isFinite(anchors.floor?.y) ? anchors.floor.y : 0.02;
  const haloY  = Number.isFinite(anchors.halo?.y)  ? anchors.halo.y  : p.halfH * 1.93;
  const fwY    = Number.isFinite(anchors.frontWing?.y) ? anchors.frontWing.y : 0.04;

  // 9 heights — dense enough to read as volumetric fog rather than a thin
  // grid, with extra sampling around the cockpit / halo band where most of
  // the visible flow action happens. Order low → high. (The former
  // "underbody skim" height moved to the dedicated 'underfloor' group
  // below — the cylinder flow diverted it around the body, which is wrong
  // for floor flow.)
  const heights = [
    Math.max(fwY + 0.02, 0.08),    // wing-top / nose
    0.18,                          // sidepod lower
    0.30,                          // sidepod mid
    Math.max(0.42, haloY - 0.18),  // sidepod upper / mirrors
    haloY - 0.08,                  // halo underside
    haloY + 0.02,                  // halo top
    haloY + 0.15,                  // airbox
    haloY + 0.30,                  // engine cover
    haloY + 0.50,                  // freestream reference
  ];

  // 7 lateral positions — tighter spacing than before (min gap 0.45) so
  // the layered ribbons blur into a cloud front rather than reading as
  // five discrete lanes.
  const xiLanes = [-1.4, -0.9, -0.45, 0, 0.45, 0.9, 1.4];

  const seeds = [];
  for (const y of heights) {
    for (const xi of xiLanes) {
      // Tiny deterministic jitter (±0.05) so ribbons don't advect in
      // perfect lockstep — keeps the flow from reading as a rigid grid.
      const etaJ = _seedEtaJitter(seeds.length, 0.05);
      seeds.push({
        seedXi: xi,
        seedEta: -8 + etaJ,
        y,
        group: 'ribbon',
        halfH: p.halfH,
      });
    }
  }

  // Venturi underfloor lanes — seeded in the floor gap, traced as a
  // straight channel (see _traceUnderfloorPath) instead of around the
  // cylinder body. floorY is the body underside (+10% shell height on
  // GLB cars), so step slightly below it, clamped above the track.
  const yUnder = Math.max(0.015, floorY - 0.02);
  for (const xi of UNDERFLOOR_LANES) {
    const etaJ = _seedEtaJitter(seeds.length, 0.05);
    seeds.push({
      seedXi: xi,
      seedEta: UF_SEED_ETA + etaJ,
      y: yUnder,
      group: 'underfloor',
      halfH: p.halfH,
    });
  }
  return seeds;
}

export class AirflowEffect {
  constructor(scene) {
    this.scene   = scene;
    this.group   = new THREE.Group();
    this.group.name = 'airflow';
    scene.add(this.group);

    this._speed        = 0;
    this._visible      = false;
    this._type         = 'F1';
    this._time         = 0;
    this._baseY        = 0;
    this._measure      = null;
    this._turnOmega    = 0;   // car yaw rate (rad/s) while turning

    this._build(getProfile('F1'), null);
    this.group.visible = false;
  }

  /**
   * Lift the airflow group so its car-local y coordinates align with the
   * actual on-track car (which sits at y = TRACK.SURFACE_Y - groundContactY).
   * Called from main.js after each spawnCar so blobs/streamlines/vortices
   * follow the variant's true ride height instead of floating at y=0.
   */
  setBaseY(y) {
    this._baseY = y || 0;
    this.group.position.y = this._baseY;
  }

  setCarType(type, measure, bodyOccupancy) {
    // Detect whether we need to rebuild: either a type change, or the same
    // type with a new measure (e.g. a GLB-derived measure replacing the
    // procedural fallback used by the constructor's initial _build), or a
    // new body-occupancy field arriving after the GLB loaded.
    const measureChanged = (measure || null) !== (this._measure || null);
    const typeChanged    = this._type !== type;
    const occChanged     = (bodyOccupancy || null) !== (this._occupancy || null);
    this._measure    = measure       || null;
    this._occupancy  = bodyOccupancy || null;
    if (!typeChanged && !measureChanged && !occChanged) return;
    this._type = type;
    this._disposeAll();
    this._build(getProfile(type), this._measure);
    this.group.visible = this._visible;
    this.group.position.y = this._baseY;
  }

  _disposeAll() {
    for (const child of [...this.group.children]) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material?.dispose();
      this.group.remove(child);
    }
  }

  _build(profile, measure) {
    this._profile         = profile;
    this._measure         = measure || this._measure || null;
    // Flow-plane dimensions: MEASURED geometry wins over the authored
    // profile so ξ/η normalization (seeds, modifiers, vortex coupling, and
    // the occupancy toWorld lookup) hugs the real GLB body, not a template.
    //   halfW — bodyShell bbox half-width (measureAnchors carries X extents)
    //   halfL — furthest measured wing |z| (full car envelope)
    //   halfH — halo/roof peak over the standard 1.93 height ratio
    const a = this._measure?.anchors;
    const bs = a?.bodyShell?.bbox;
    this._halfW = (bs && Number.isFinite(bs.minX) && Number.isFinite(bs.maxX))
      ? (bs.maxX - bs.minX) / 2
      : profile.halfW;
    this._halfL = (Number.isFinite(a?.frontWing?.z) && Number.isFinite(a?.rearWing?.z))
      ? Math.max(Math.abs(a.frontWing.z), Math.abs(a.rearWing.z))
      : profile.halfL;
    this._halfH = Number.isFinite(a?.halo?.y) ? a.halo.y / 1.93 : profile.halfH;
    this._vortexMaxRadius = profile.vortexMaxRadius;
    this._wakeWidthX      = profile.wakeWidthX;
    this._wakeHeightRange = profile.wakeHeightRange;
    this._strouhal        = profile.strouhal || 0.20;
    this._seeds           = _buildSeedList(profile, this._measure);
    // Surface the ribbon count on rebuild so a stale browser cache is easy to
    // detect in DevTools — expected output is `{ ribbon: 40 } (total 40)`.
    if (typeof console !== 'undefined' && console.info) {
      const countByGroup = {};
      for (const s of this._seeds) countByGroup[s.group] = (countByGroup[s.group] || 0) + 1;
      console.info('[airflow] seeds by group:', countByGroup, '(total ' + this._seeds.length + ')');
    }
    // Phase C: derive analytical flow modifiers from role-tagged anchors.
    // Procedural fallbacks (no measure.anchors) get an empty list ⇒ the
    // potential-flow baseline is preserved.
    this._modifiers       = this._buildModifiers(profile, this._measure);
    // When a body-occupancy field is attached, pass it per-path with a
    // toWorld closure that lifts the seed's Y into the lookup (xi→X, eta→Z).
    const occ = this._occupancy || null;
    const halfW = this._halfW, halfL = this._halfL;
    const mods = this._modifiers;
    this._paths = this._seeds.map(s => {
      // Underfloor seeds run straight through the floor gap — the cylinder
      // potential flow would stagnate/divert them at the nose (r² ≤ 1).
      if (s.group === 'underfloor') return _traceUnderfloorPath(s.seedXi, s.seedEta, halfL);
      const opts = {};
      if (occ) {
        opts.occupancy = occ;
        opts.toWorld = (xi, eta) => ({ x: xi * halfW, y: s.y, z: eta * halfL });
      }
      if (mods && mods.length > 0) opts.modifiers = mods;
      return traceStreamlinePath(s.seedXi, s.seedEta, STEPS, STEP_SIZE, opts);
    });
    this._vortexDefs      = this._resolveVortexDefs(profile, this._measure);
    this._buildRibbonLines();
    this._buildVortexSpirals(this._vortexDefs);
    this._buildWakeParticles(profile.wakeCount);
  }

  /**
   * Resolve vortex wz from measure anchors by role. Returns a NEW array —
   * never mutates `profile.vortexDefs`. Roles:
   *   - 'frontWing' → snap wz to `measure.anchors.frontWing.z` if finite.
   *   - 'rearWing'  → snap wz to `measure.anchors.rearWing.z`  if finite.
   *   - 'floor'     → authored wz kept (ground vortices are floor-edge, not wing-tip).
   */
  _resolveVortexDefs(profile, measure) {
    const fwZ = measure?.anchors?.frontWing?.z;
    const rwZ = measure?.anchors?.rearWing?.z;
    const hasFw = Number.isFinite(fwZ);
    const hasRw = Number.isFinite(rwZ);
    return profile.vortexDefs.map(def => {
      if (def.role === 'frontWing' && hasFw) return { ...def, wz: fwZ };
      if (def.role === 'rearWing'  && hasRw) return { ...def, wz: rwZ };
      return { ...def };
    });
  }

  /**
   * Phase C: build the analytical-modifier table from role-tagged anchors.
   * Returns a NEW array of `{type, x, e, ...}` entries in the dimensionless
   * (xi, eta) plane used by `sumVelocity`:
   *   - xi  = car-local X / halfW   (lateral)
   *   - eta = car-local Z / halfL   (longitudinal, front→back)
   *
   * Source of truth: `measure.anchors`. Each entry with `role: 'inlet'` or
   * `'outlet'` is converted to a sink/source; the wing anchors `frontWing`
   * and `rearWing` become vortex (dipole-surrogate) entries when present.
   *
   * All strengths are VISUAL approximations (see MOD_STR). Empty list when
   * no anchors are supplied — procedural cars fall through to the baseline
   * potential flow.
   */
  _buildModifiers(profile, measure) {
    const out = [];
    if (!measure?.anchors) return out;
    // Normalize by the SAME flow-plane dims the renderer uses (_build sets
    // this._halfW/_halfL from measured geometry when available) — modifiers
    // and ribbons must agree on the ξ/η mapping or sinks drift off their
    // vents.
    const halfL = this._halfL || profile.halfL || DEFAULT_HALF_L;
    const halfW = this._halfW || profile.halfW || DEFAULT_HALF_W;
    const anchors = measure.anchors;

    const add = (anchor, type, cfg) => {
      if (!anchor) return;
      const entry = {
        type,
        x: anchor.x / halfW,
        e: anchor.z / halfL,
        rc: cfg.rc,
      };
      if (type === 'vortex') entry.gamma    = cfg.gamma;
      else                    entry.strength = cfg.strength;
      out.push(entry);
    };

    // Iterate role-tagged vent anchors. Keyed lookup by known anchor names
    // keeps the mapping explicit (no fuzzy name-matching).
    const ventTable = [
      ['sidepodInletL',   'sink',   MOD_STR.SIDEPOD_INLET,   'inlet'  ],
      ['sidepodInletR',   'sink',   MOD_STR.SIDEPOD_INLET,   'inlet'  ],
      ['sidepodExhaustL', 'source', MOD_STR.SIDEPOD_EXHAUST, 'outlet' ],
      ['sidepodExhaustR', 'source', MOD_STR.SIDEPOD_EXHAUST, 'outlet' ],
      ['airboxIntake',    'sink',   MOD_STR.AIRBOX_INTAKE,   'inlet'  ],
      ['exhaustPipe',     'source', MOD_STR.EXHAUST_PIPE,    'outlet' ],
      ['frontBrakeDuctL', 'sink',   MOD_STR.BRAKE_DUCT,      'inlet'  ],
      ['frontBrakeDuctR', 'sink',   MOD_STR.BRAKE_DUCT,      'inlet'  ],
      ['rearBrakeDuctL',  'sink',   MOD_STR.BRAKE_DUCT,      'inlet'  ],
      ['rearBrakeDuctR',  'sink',   MOD_STR.BRAKE_DUCT,      'inlet'  ],
      // GT (992 GT3 RS) vent layout — measured via manifest anchorSources.
      ['frontIntake',     'sink',   MOD_STR.SIDEPOD_INLET,   'inlet'  ],
      ['engineIntake',    'sink',   MOD_STR.AIRBOX_INTAKE,   'inlet'  ],
      ['fenderVentL',     'source', MOD_STR.SIDEPOD_EXHAUST, 'outlet' ],
      ['fenderVentR',     'source', MOD_STR.SIDEPOD_EXHAUST, 'outlet' ],
    ];
    for (const [key, type, cfg, expectedRole] of ventTable) {
      const a = anchors[key];
      if (!a) continue;
      // Honour anchor role if present (safety net against manifest drift);
      // unrolled anchors without `.role` still resolve to the table's intent.
      if (a.role && a.role !== expectedRole) continue;
      add(a, type, cfg);
    }

    // Wing dipole surrogates — placed slightly under each wing (anchor's xi/
    // eta read directly; the gamma sign follows the downforce convention used
    // by profile.vortexDefs so a clockwise vortex under the wing pulls the
    // underside into suction).
    if (anchors.frontWing) add(anchors.frontWing, 'vortex', MOD_STR.FRONT_WING_VORT);
    if (anchors.rearWing)  add(anchors.rearWing,  'vortex', MOD_STR.REAR_WING_VORT);

    return out;
  }

  /**
   * Read-accessor for Phase-C analytical modifiers. Used by CfdEffect (via
   * main.js wiring) so the CFD Cp recompute uses the same feature-aware
   * velocity field as the airflow streamlines.
   */
  getModifiers() {
    return this._modifiers || [];
  }

  /* ── Convert potential-flow (xi, eta) + y → world XYZ ── */
  _toWorld(xi, eta, y) {
    return new THREE.Vector3(xi * this._halfW, y, eta * this._halfL);
  }

  /* ── Compute 3-D vertical displacement from side-view potential flow ── */
  _verticalDelta(eta, y, scale = 0.10) {
    // Normalise to unit circle
    const etaN = eta / Math.max(this._halfL, 0.1);
    const yN   = y   / Math.max(this._halfH, 0.1);
    const { vy } = sideViewVelocity(etaN, yN);
    return vy * scale;
  }

  /**
   * Wind-tunnel streamline ribbons — one THREE.Line per seed.
   *
   * Each seed's traced path (in (xi, eta) dimensionless flow-plane coordinates)
   * is converted to world XYZ and written into a fixed-size Float32 position
   * buffer. The line itself is STABLE — its shape is defined by the flow field
   * around the car, not by stochastic per-particle life cycles — so it reads
   * as a continuous smoke ribbon front-to-back, matching fog.png.
   *
   * Flow animation is done via per-vertex brightness: a bright "puff" band
   * slides along the line each frame (advanced in `_updateRibbonLines`), giving
   * a visible sense of flow direction without breaking line continuity.
   */
  _buildRibbonLines() {
    const puffTex = _makePuffTexture();
    const lines = [];
    for (let s = 0; s < this._seeds.length; s++) {
      const path     = this._paths[s];
      const nVerts   = path.length;
      // Shared position & color buffers — the crisp line and the soft fog
      // halo read from the same Float32Arrays. One write per vertex per
      // frame; both geometries' needsUpdate flags get flipped.
      const positions = new Float32Array(nVerts * 3);
      const colors    = new Float32Array(nVerts * 3);

      // Line (crisp core)
      const lineGeo  = new THREE.BufferGeometry();
      const linePos  = new THREE.BufferAttribute(positions, 3);
      const lineCol  = new THREE.BufferAttribute(colors,    3);
      lineGeo.setAttribute('position', linePos);
      lineGeo.setAttribute('color',    lineCol);
      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      this.group.add(line);

      // Underfloor venturi streaks stay crisp: the fog halos would blob the
      // tightly-spaced floor-gap lanes into haze and wash out the Cp tint.
      // Instead they get a TIGHT glow — same tinted color buffer, small
      // sprite — for thickness that punches through without reading as fog.
      if (this._seeds[s].group === 'underfloor') {
        const glowGeo = new THREE.BufferGeometry();
        const glowPos = new THREE.BufferAttribute(positions, 3);  // shared arrays
        const glowCol = new THREE.BufferAttribute(colors,    3);
        glowGeo.setAttribute('position', glowPos);
        glowGeo.setAttribute('color',    glowCol);
        const glowMat = new THREE.PointsMaterial({
          size: 0.10,
          map: puffTex,
          vertexColors: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          sizeAttenuation: true,
        });
        const glow = new THREE.Points(glowGeo, glowMat);
        this.group.add(glow);
        lines.push({
          line, lineMat, lineGeo, linePos, lineCol,
          halo: null, haloMat: null, haloGeo: null, haloPos: null, haloCol: null,
          outerHalo: null, outerHaloMat: null, outerHaloGeo: null,
          outerHaloPos: null, outerHaloCol: null,
          glow, glowMat, glowGeo, glowPos, glowCol,
          positions, colors, haloColors: null,
          seedIdx: s,
          phase: Math.random(),
        });
        continue;
      }

      // Inner halo (mid-sized fog puffs) — samples the SAME path vertices
      // with a radial-gradient puff texture. Additive blending over the
      // crisp line yields the aura/thickness of the ribbon. Halo colors get
      // their OWN buffer: line colors × fogEnvelope(eta), so the entry
      // upstream stays a crisp line and fog develops over the body.
      const haloColors = new Float32Array(nVerts * 3);
      const haloGeo = new THREE.BufferGeometry();
      const haloPos = new THREE.BufferAttribute(positions,  3);  // shared array
      const haloCol = new THREE.BufferAttribute(haloColors, 3);
      haloGeo.setAttribute('position', haloPos);
      haloGeo.setAttribute('color',    haloCol);
      const haloMat = new THREE.PointsMaterial({
        size: 0.55,
        map: puffTex,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      const halo = new THREE.Points(haloGeo, haloMat);
      this.group.add(halo);

      // Outer halo (large diffuse fog) — same buffer, bigger sprite, low
      // opacity. Stacks with the inner halo to read as volumetric haze.
      const outerHaloGeo = new THREE.BufferGeometry();
      const outerHaloPos = new THREE.BufferAttribute(positions,  3);
      const outerHaloCol = new THREE.BufferAttribute(haloColors, 3);
      outerHaloGeo.setAttribute('position', outerHaloPos);
      outerHaloGeo.setAttribute('color',    outerHaloCol);
      const outerHaloMat = new THREE.PointsMaterial({
        size: 1.10,
        map: puffTex,
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      const outerHalo = new THREE.Points(outerHaloGeo, outerHaloMat);
      this.group.add(outerHalo);

      lines.push({
        line, lineMat, lineGeo, linePos, lineCol,
        halo, haloMat, haloGeo, haloPos, haloCol,
        outerHalo, outerHaloMat, outerHaloGeo, outerHaloPos, outerHaloCol,
        glow: null, glowMat: null, glowGeo: null, glowPos: null, glowCol: null,
        positions, colors, haloColors,
        seedIdx: s,
        phase: Math.random(),
      });
    }
    this._ribbonLines = lines;
  }

  /* ── Wing-tip vortex spirals — physics-based trajectories ── */
  _buildVortexSpirals(vortexDefs) {
    this._vortexLines = vortexDefs.map(def => {
      const positions = new Float32Array(VORTEX_PTS * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xddeeff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geo, mat);
      this.group.add(line);
      return { line, mat, positions, def };
    });
  }

  /* ── Wake particles — turbulent Kármán-like vortex street ── */
  _buildWakeParticles(count) {
    const positions  = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 4); // vx vy vz vortexPhase
    const [hMin, hMax] = this._wakeHeightRange;

    for (let i = 0; i < count; i++) {
      // Spread in Z from 2 to 8 behind car
      const z = rnd(2.2, 8.0);
      positions[i * 3]     = rnd(-this._wakeWidthX, this._wakeWidthX);
      positions[i * 3 + 1] = rnd(hMin, hMax);
      positions[i * 3 + 2] = z;
      // Lateral velocity with vortex phase offset (Kármán pattern)
      const side = i % 2 === 0 ? 1 : -1;
      velocities[i * 4]     = side * rnd(0.2, 0.9);       // vx — lateral drift
      velocities[i * 4 + 1] = rnd(-0.15, 0.20);           // vy — small vertical
      velocities[i * 4 + 2] = rnd(0.6, 2.8);              // vz — downstream
      velocities[i * 4 + 3] = rnd(0, Math.PI * 2);        // phase
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xe8f4ff,
      size: 0.075,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._wakePoints = new THREE.Points(geo, mat);
    this._wakeMat    = mat;
    this._wakePos    = positions;
    this._wakeVels   = velocities;
    this._wakeCount  = count;
    this.group.add(this._wakePoints);
  }

  setSpeed(speed) { this._speed = speed; }

  /* Turn coupling — ribbons sweep with the apparent rotation of the air mass
   * around the turning car frame (see ribbonDrift; ×6 legibility exaggeration). */
  setTurnState(omega, _v) { this._turnOmega = omega; }

  setVisible(v) {
    this._visible = v;
    this.group.visible = v;
  }

  update(dt, t) {
    if (!this._visible) return;
    this._time += dt;

    const speedFactor = Math.min(this._speed / 350, 1);

    /* ── Ribbon streamlines — one THREE.Line per seed ── *
     * Lines are stable polylines: every vertex is written from the pre-traced
     * path in world space, with a small vortex-coupled nudge per frame. A
     * bright "puff" band slides along each line (vertex brightness wave) to
     * show flow direction without breaking line continuity.
     * ---------------------------------------------------------------------- */
    // Line is the crisp core — kept dim so the two halo layers dominate
    // visually (the user wants fog-like, not pinstripe ribbons).
    const ribbonOpacity   = Math.min(0.70, 0.30 + speedFactor * 0.40);
    // Puff-wave travel speed along the line, in vertex-indices per second.
    const PUFF_ADV_RATE   = 12 + speedFactor * 40;
    // Puff half-width (in vertex indices). Narrower at low speed (subtle),
    // wider at high speed (a visible pulse sweeping past).
    const PUFF_HALF_WIDTH = 4 + speedFactor * 8;

    if (this._ribbonLines) for (const R of this._ribbonLines) {
      const s    = R.seedIdx;
      const path = this._paths[s];
      if (!path || path.length < 2) continue;
      const seed = this._seeds[s];
      const isUnderfloor = seed.group === 'underfloor';

      // Venturi advection — the pulse IS the local flow speed. Underfloor
      // pulses accelerate through the throat / diffuser inlet by the
      // Bernoulli ratio √(1 − Cp) at the pulse's current position.
      let phaseRate = PUFF_ADV_RATE;
      if (isUnderfloor) {
        const pIdx   = Math.min(path.length - 1, Math.max(0, Math.floor(R.phase)));
        const zPulse = path[pIdx].eta * this._halfL;
        phaseRate *= venturiSpeedRatio(underfloorCp(zPulse, this._type, this._halfL, speedFactor));
      }
      R.phase += dt * phaseRate;
      while (R.phase >= path.length) R.phase -= path.length;

      const positions = R.positions;
      const colors    = R.colors;

      for (let i = 0; i < path.length; i++) {
        const pt  = path[i];
        const xi  = pt.xi;
        const eta = pt.eta;
        const zCar = eta * this._halfL;
        let y;
        if (isUnderfloor) {
          // Floor gap, then eased diffuser-ramp upwash — not the side-view
          // cylinder flow, which would lift the ribbon over the nose.
          y = underfloorY(zCar, seed.y);
        } else {
          // Per-vertex vertical delta from side-view potential flow — same as
          // the old smoke system so ribbons still rise over the nose & halo.
          const dy = this._verticalDelta(eta, seed.y);
          y = seed.y + dy * Math.max(0, Math.min(1, (eta + 1) / 2));
        }

        const w = this._toWorld(xi, eta, y);
        let wx = w.x, wy = w.y, wz = w.z;

        // Vortex-coupled drift — bend the ribbon near wing-tip vortex cores.
        if (this._vortexDefs) {
          for (const def of this._vortexDefs) {
            const vxiC = def.wx / this._halfW;
            const vetaC = def.wz / this._halfL;
            const dx = xi - vxiC, de = eta - vetaC;
            const rcN = def.rc / Math.min(this._halfW, this._halfL);
            if (dx * dx + de * de < (rcN * 3) ** 2) {
              const vv = vortexVelocity(xi, eta, vxiC, vetaC, def.gamma, rcN);
              wx += vv.vxi  * this._halfW * speedFactor * 0.08;
              wz += vv.veta * this._halfL * speedFactor * 0.08;
            }
          }
        }

        // Body-occupancy deflection — if the line would pass through the
        // car body, lift it along the gradient so the ribbon hugs the shell
        // instead of cutting through it. Underfloor ribbons skip this: they
        // sit below the underside by construction, and voxel blur at the
        // floor plane would wrongly eject them upward through the body.
        if (this._occupancy && !isUnderfloor && this._occupancy.sample(wx, wy, wz) > 0.5) {
          const g = this._occupancy.gradient
            ? this._occupancy.gradient(wx, wy, wz)
            : { x: 0, y: 1, z: 0 };
          const mag = Math.hypot(g.x, g.y, g.z) || 1;
          const lift = 0.12;
          wx += (g.x / mag) * lift;
          wy += (g.y / mag) * lift;
          wz += (g.z / mag) * lift;
        }

        // Turn coupling — lateral sweep from the apparent rotation of the
        // air mass around the car frame (~0.4 s response time scale).
        if (this._turnOmega !== 0) {
          wx += ribbonDrift(this._turnOmega, wz) * 0.4;
        }

        positions[i * 3]     = wx;
        positions[i * 3 + 1] = wy;
        positions[i * 3 + 2] = wz;

        // Per-vertex brightness wave — a Gaussian pulse centred on R.phase,
        // travelling along the line. Keeps a visible baseline so the line
        // reads even where the pulse isn't currently sitting.
        let d = Math.abs(i - R.phase);
        if (d > path.length / 2) d = path.length - d;
        const pulse    = Math.exp(-(d * d) / (2 * PUFF_HALF_WIDTH * PUFF_HALF_WIDTH));
        // Underfloor streaks have no fog halos, so the line itself carries
        // the visual weight — higher resting brightness, pulse rides on top.
        const baseline = isUnderfloor ? 0.70 : 0.35;
        let bright     = baseline + pulse * (isUnderfloor ? 0.30 : 0.65);
        // Base near-white smoke; underfloor vertices blend toward the CFD
        // Cp palette where the ground effect is active (suction → cyan,
        // fading with speedFactor² so the ribbon is white at rest).
        let cr = 0.92, cg = 0.95, cb = 1.00;
        if (isUnderfloor) {
          // Streaks emerge from nothing and dissolve — end fades keep them
          // reading as smoke filaments, not stripes painted on the tarmac.
          const fIn  = Math.min(1, i / UF_FADE_IN_VERTS);
          const fOut = Math.min(1, (path.length - 1 - i) / UF_FADE_OUT_VERTS);
          bright *= fIn * fIn * (3 - 2 * fIn) * fOut * fOut * (3 - 2 * fOut);
          const cpEff = underfloorCp(zCar, this._type, this._halfL, speedFactor);
          if (cpEff !== 0) {
            const c    = cpToColor(cpEff);
            const mixW = underfloorTintMix(cpEff);
            cr += (c.r - cr) * mixW;
            cg += (c.g - cg) * mixW;
            cb += (c.b - cb) * mixW;
          }
        }
        colors[i * 3]     = cr * bright;
        colors[i * 3 + 1] = cg * bright;
        colors[i * 3 + 2] = cb * bright;

        // Fog halos fade in along the flow — crisp laminar entry, fog
        // developing over the body/wake (see fogEnvelope).
        if (R.haloColors) {
          const env = fogEnvelope(eta);
          R.haloColors[i * 3]     = colors[i * 3]     * env;
          R.haloColors[i * 3 + 1] = colors[i * 3 + 1] * env;
          R.haloColors[i * 3 + 2] = colors[i * 3 + 2] * env;
        }
      }

      // All geometries share the same Float32Array but each BufferAttribute
      // carries its own needsUpdate flag — flip all of them.
      R.linePos.needsUpdate = true;
      R.lineCol.needsUpdate = true;
      if (isUnderfloor) {
        // No halos — the crisp bright line IS the venturi streak; the tight
        // glow rides the same buffers for thickness at speed.
        R.lineMat.opacity = Math.min(0.95, 0.55 + speedFactor * 0.40);
        R.glowPos.needsUpdate = true;
        R.glowCol.needsUpdate = true;
        R.glowMat.opacity = 0.30 + speedFactor * 0.45;
        R.glowMat.size    = 0.10 + speedFactor * 0.06;
      } else {
        R.haloPos.needsUpdate      = true;
        R.haloCol.needsUpdate      = true;
        R.outerHaloPos.needsUpdate = true;
        R.outerHaloCol.needsUpdate = true;
        // Crisp line stays dim; two halo layers stack to read as fog. Inner
        // halo is mid-sized / denser; outer halo is big / low-opacity haze.
        // Opacities are budgeted for SIDE views: all 7 xi-lanes project onto
        // the same pixels from a low angle, so additive halos stack ×7 — the
        // old 0.65/0.30 maxima summed to a white wall that hid the car.
        R.lineMat.opacity      = ribbonOpacity;
        R.haloMat.opacity      = 0.18 + speedFactor * 0.12;
        R.haloMat.size         = 0.55 + speedFactor * 0.10;
        R.outerHaloMat.opacity = 0.05 + speedFactor * 0.07;
        R.outerHaloMat.size    = 1.10 + speedFactor * 0.20;
      }
    }

    /* ── Vortex spirals — physics-based with vortexVelocity ── */
    const vortexRadius  = speedFactor * speedFactor * this._vortexMaxRadius;
    const vortexVisible = this._speed > 30;
    // Strouhal shedding oscillation
    const sheddingFreq  = this._strouhal * (this._speed / 3.6) / (this._halfW * 2);
    const sheddingPhase = this._time * sheddingFreq * Math.PI * 2;

    for (const { mat, positions: vPos, def } of this._vortexLines) {
      mat.opacity = vortexVisible ? speedFactor * 0.80 : 0;

      // Initialise vortex centre and trace it downstream using vortexVelocity
      let vxi = def.wx / this._halfW;
      let veta = def.wz / this._halfL;
      let vy  = def.wy;

      for (let i = 0; i < VORTEX_PTS; i++) {
        const decay = i / VORTEX_PTS;
        // Spiral angle grows with downstream travel
        const angle = (i / VORTEX_PTS) * Math.PI * 8 * def.sign + sheddingPhase * def.sign;
        const r     = vortexRadius * (1 - decay * 0.6);

        // Vortex centre drifts downstream and decays slightly laterally
        const worldX = def.wx + Math.cos(angle) * r;
        const worldY = def.wy - decay * 0.55 + Math.sin(angle * 0.5) * r * 0.25;
        const worldZ = def.wz + (i / VORTEX_PTS) * 2.2;

        vPos[i * 3]     = worldX;
        vPos[i * 3 + 1] = worldY;
        vPos[i * 3 + 2] = worldZ;
      }
    }
    for (const vl of this._vortexLines) {
      vl.line.geometry.attributes.position.needsUpdate = true;
    }

    /* ── Wake particles — Kármán vortex street ── */
    const wakeOp = speedFactor * 0.70;
    this._wakeMat.opacity = wakeOp;
    const wp = this._wakePos;
    const wv = this._wakeVels;
    const [hMin, hMax] = this._wakeHeightRange;
    const kStrouhal    = this._strouhal * Math.PI * 2 * speedFactor * 4;

    for (let i = 0; i < this._wakeCount; i++) {
      const phase = wv[i * 4 + 3];
      // Kármán lateral oscillation modulates vx by shedding frequency
      const karmanLateral = Math.sin(kStrouhal * t + phase) * speedFactor * 0.6;

      wp[i * 3]     += (wv[i * 4]     * speedFactor + karmanLateral) * dt;
      wp[i * 3 + 1] += wv[i * 4 + 1] * dt * speedFactor;
      wp[i * 3 + 2] += wv[i * 4 + 2] * dt * speedFactor;

      if (wp[i * 3 + 2] > 9.0 || wp[i * 3 + 2] < 2.0) {
        const side = i % 2 === 0 ? 1 : -1;
        wp[i * 3]     = side * rnd(0.1, this._wakeWidthX * 0.7);
        wp[i * 3 + 1] = rnd(hMin, hMax);
        wp[i * 3 + 2] = rnd(2.2, 4.0);
      }
    }
    this._wakePoints.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

/* ════════════════════════════════════════════════════════════════ */
/*  RAIN EFFECT                                                     */
/* ════════════════════════════════════════════════════════════════ */

/* Per-car wheel/spray spawn positions */
const RAIN_POS = {
  F1: { sprayX: 0.73, sprayZ: 1.52, roosterX: 0.80, roosterZ: 1.65 },
  GT: { sprayX: 0.85, sprayZ: 1.55, roosterX: 0.93, roosterZ: 1.72 },
};

export class RainEffect {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'rain';
    scene.add(this.group);

    this._speed    = 0;
    this._visible  = false;
    this._rainPos  = RAIN_POS.F1;
    this._turnALat = 0;   // centrifugal accel v·ω while turning (m/s²)

    this._buildDroplets();
    this._buildSpray();
    this._buildWetGround();
    this._buildRoosterTails();
    this.group.visible = false;
  }

  _buildDroplets() {
    const COUNT = 1200;
    // Buffer stores tail + head per droplet (2 vertices × 3 floats = 6 per droplet)
    const positions = new Float32Array(COUNT * 2 * 3);
    const vels      = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      const x = rnd(-5, 5), y = rnd(0.5, 8), z = rnd(-6, 6);
      positions.set([x, y, z, x, y, z], i * 6);
      vels[i] = rnd(6, 14);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.droplets = new THREE.LineSegments(geo, mat);
    this.group.add(this.droplets);

    this._dPos   = positions;
    this._dVels  = vels;
    this._dCount = COUNT;
    this._dMat   = mat;
  }

  _buildSpray() {
    const COUNT = 300;
    const positions = new Float32Array(COUNT * 3);
    const vels      = new Float32Array(COUNT * 3);

    const spawnSpray = (i) => {
      const sx   = this._rainPos.sprayX;
      const side = i % 2 === 0 ? -sx : sx;
      positions[i * 3]     = side + rnd(-0.1, 0.1);
      positions[i * 3 + 1] = 0.25;
      positions[i * 3 + 2] = this._rainPos.sprayZ + rnd(-0.1, 0.1);
      vels[i * 3]     = (side < 0 ? -1 : 1) * rnd(0.2, 0.8);
      vels[i * 3 + 1] = rnd(1.0, 3.0);
      vels[i * 3 + 2] = rnd(1.0, rnd(1.5, 4.5));
    };

    for (let i = 0; i < COUNT; i++) spawnSpray(i);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xaaddff,
      size: 0.06,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.spray = new THREE.Points(geo, mat);
    this.group.add(this.spray);

    this._sPos   = positions;
    this._sVels  = vels;
    this._sCount = COUNT;
    this._sMat   = mat;
    this._spawnSpray = spawnSpray;
    this._sprayLife  = new Float32Array(COUNT).fill(0).map(() => rnd(0, 1));
  }

  _buildRoosterTails() {
    const COUNT = 300; // 150 per rear wheel
    const positions = new Float32Array(COUNT * 3);
    const vels      = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT; i++) {
      const side = i < COUNT / 2 ? -1 : 1;
      positions[i * 3]     = side * this._rainPos.roosterX + rnd(-0.1, 0.1);
      positions[i * 3 + 1] = rnd(0, 0.5);
      positions[i * 3 + 2] = this._rainPos.roosterZ + rnd(-0.1, 0.1);
      vels[i * 3]     = side * rnd(0.5, 2);   // lateral fan
      vels[i * 3 + 1] = rnd(0, 4);            // upward
      vels[i * 3 + 2] = rnd(2, 5);            // rearward
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xaaddff,
      size: 0.04,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._roosterPoints = new THREE.Points(geo, mat);
    this.group.add(this._roosterPoints);
    this._roosterPos   = positions;
    this._roosterVels  = vels;
    this._roosterCount = COUNT;
    this._roosterMat   = mat;
  }

  _buildWetGround() {
    const geo = new THREE.PlaneGeometry(4.5, 9.0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a4a6a,
      roughness: 0.08,
      metalness: 0.75,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      alphaMap: (_wetMaskTex ||= _makeWetMaskTexture()),
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.329;
    this.group.add(plane);
    this._wetMat = mat;
  }

  setSpeed(speed) { this._speed = speed; }

  /* Turn coupling — store the REAL centrifugal pseudo-accel a_lat = v·ω.
   * Free water (spray, rooster tails) accumulates it; falling streaks lean. */
  setTurnState(omega, v) { this._turnALat = rainLateralAccel(v, omega); }

  setCarType(type, measure) {
    // Prefer measured rear-axle position when the car builder exposed it.
    // Falls back to the per-type RAIN_POS table for procedural cars that
    // didn't publish a measure, or when measure.rearAxleZ is absent.
    const base = RAIN_POS[type] || RAIN_POS.F1;
    if (measure && typeof measure.rearAxleZ === 'number') {
      // Spray originates from the wheel contact patch (just outboard of
      // the tyre) and the rooster tail sweeps slightly further back and
      // wider — nudges preserved from the authored RAIN_POS deltas.
      const axleX = (typeof measure.rearAxleX === 'number')
        ? measure.rearAxleX
        : base.sprayX;
      const axleZ = measure.rearAxleZ;
      const sprayDx   = base.roosterX - base.sprayX;     // rooster sits ~0.07-0.08 outboard
      const sprayDz   = base.roosterZ - base.sprayZ;     // rooster trails ~0.13-0.17 aft
      this._rainPos = {
        sprayX:   axleX,
        sprayZ:   axleZ,
        roosterX: axleX + sprayDx,
        roosterZ: axleZ + sprayDz,
      };
    } else {
      this._rainPos = base;
    }
    // Re-place rooster tail particles at the new car's rear wheel positions
    for (let i = 0; i < this._roosterCount; i++) {
      const side = i < this._roosterCount / 2 ? -1 : 1;
      this._roosterPos[i * 3]     = side * this._rainPos.roosterX + rnd(-0.1, 0.1);
      this._roosterPos[i * 3 + 1] = rnd(0, 0.5);
      this._roosterPos[i * 3 + 2] = this._rainPos.roosterZ + rnd(-0.1, 0.1);
      this._roosterVels[i * 3]     = side * rnd(0.5, 2);
      this._roosterVels[i * 3 + 1] = rnd(1.0, 3.0);
      this._roosterVels[i * 3 + 2] = rnd(2, 5);
    }
    // Re-place spray particles
    for (let i = 0; i < this._sCount; i++) {
      this._spawnSpray(i);
      this._sprayLife[i] = rnd(0, 1);
    }
  }

  setVisible(v) {
    this._visible = v;
    this.group.visible = v;
  }

  update(dt, _t) {
    if (!this._visible) return;

    const speedFactor = Math.min(this._speed / 350, 1);
    const windTilt = speedFactor * 1.5;

    // Change 5: streak rendering — update tail position then compute head
    const dp = this._dPos;
    const streakLen = 0.04 + speedFactor * 0.10;
    // Turn coupling: falling drops pick up lateral speed ≈ a_lat × mean fall
    // time (~0.4 s); the streak head leans outward by the accel ratio.
    const aLat = this._turnALat;
    const turnDrift = aLat * 0.4;
    const turnLean  = (aLat / 9.8) * streakLen;
    for (let i = 0; i < this._dCount; i++) {
      dp[i * 6]     += dt * turnDrift;
      dp[i * 6 + 1] -= dt * this._dVels[i];
      dp[i * 6 + 2] += dt * windTilt;
      if (dp[i * 6 + 1] < -0.35) {
        dp[i * 6]     = rnd(-5, 5);
        dp[i * 6 + 1] = 8;
        dp[i * 6 + 2] = rnd(-6, 6);
      }
      // Head = tail + streak offset
      dp[i * 6 + 3] = dp[i * 6] + turnLean;
      dp[i * 6 + 4] = dp[i * 6 + 1] + streakLen;
      dp[i * 6 + 5] = dp[i * 6 + 2] + windTilt * 0.15;
    }
    this.droplets.geometry.attributes.position.needsUpdate = true;

    // Change 4: proper gravity accumulation (9.8 m/s²) for spray
    const sp = this._sPos, sv = this._sVels;
    for (let i = 0; i < this._sCount; i++) {
      this._sprayLife[i] += dt * 2.0;
      sv[i * 3]     += aLat * dt;           // centrifugal drift while turning
      sv[i * 3 + 1] -= 9.8 * dt;            // accumulate gravity into vy
      sp[i * 3]     += sv[i * 3]     * dt;
      sp[i * 3 + 1] += sv[i * 3 + 1] * dt;
      sp[i * 3 + 2] += sv[i * 3 + 2] * dt * (1 + speedFactor);

      if (this._sprayLife[i] > 1 || sp[i * 3 + 1] < -0.3) {
        this._sprayLife[i] = 0;
        this._spawnSpray(i);
      }
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
    this._sMat.opacity = speedFactor * 0.65;
    this._sMat.size    = 0.04 + 0.07 * speedFactor;

    this._wetMat.opacity = speedFactor * 0.40;

    this._updateRoosterTails(dt, speedFactor);
  }

  _updateRoosterTails(dt, speedFactor) {
    if (this._speed <= 20) {
      this._roosterMat.opacity = 0;
      return;
    }
    const rp = this._roosterPos;
    const rv = this._roosterVels;

    for (let i = 0; i < this._roosterCount; i++) {
      rv[i * 3]     += this._turnALat * dt;  // centrifugal drift while turning
      rv[i * 3 + 1] -= 9.8 * dt;             // gravity
      rp[i * 3]     += rv[i * 3]     * dt;
      rp[i * 3 + 1] += rv[i * 3 + 1] * dt;
      rp[i * 3 + 2] += rv[i * 3 + 2] * dt;

      if (rp[i * 3 + 1] < -0.1 || rp[i * 3 + 2] > 4.0) {
        const side = i < this._roosterCount / 2 ? -1 : 1;
        rp[i * 3]     = side * this._rainPos.roosterX + rnd(-0.1, 0.1);
        rp[i * 3 + 1] = rnd(0, 0.2);
        rp[i * 3 + 2] = this._rainPos.roosterZ + rnd(-0.1, 0.1);
        rv[i * 3]     = side * rnd(0.5, 2);
        rv[i * 3 + 1] = rnd(1.0, 3.0);  // reset vy so gravity accumulation restarts
        rv[i * 3 + 2] = rnd(2, 5);
      }
    }

    this._roosterPoints.geometry.attributes.position.needsUpdate = true;
    this._roosterMat.opacity = speedFactor * 0.75;
  }

  dispose() {
    this.scene.remove(this.group);
  }
}

