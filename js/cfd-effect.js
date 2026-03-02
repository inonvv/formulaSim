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
 *   update(dt, t), dispose(), setWingStall(isStalled).
 */

import * as THREE from 'three';
import { topViewVelocity, pressureCoeff, cpToColor, vortexVelocity } from './airflow-core.js';

/* ── Helpers ──────────────────────────────────────────────────────── */
function rnd(a, b) { return a + Math.random() * (b - a); }

/**
 * Piecewise-linear Cp profile along the car body (car-frame z).
 * Interpolates between physics-calibrated control points — no hard discontinuities.
 */
const CP_TABLE = [
  [-3.00,  0.15], [-2.80,  0.90], [-2.60, -2.20],
  [-2.00, -0.85], [-0.50, -0.40], [ 0.50, -0.22],
  [ 1.40, -0.18], [ 2.00, -1.10], [ 2.40,  0.15],
];

export function lerpCpProfile(z) {
  if (z <= CP_TABLE[0][0]) return CP_TABLE[0][1];
  if (z >= CP_TABLE[CP_TABLE.length - 1][0]) return CP_TABLE[CP_TABLE.length - 1][1];
  for (let i = 0; i < CP_TABLE.length - 1; i++) {
    const [z0, cp0] = CP_TABLE[i], [z1, cp1] = CP_TABLE[i + 1];
    if (z >= z0 && z <= z1) {
      const t = (z - z0) / (z1 - z0);
      return cp0 + t * (cp1 - cp0);
    }
  }
  return 0;
}

/* ── Per-role Cp bias (physics-correct baselines) ─────────────────── *
 * bias  = base Cp value for surface (positive = stagnation, negative = suction)
 * scale = amplitude of potential-flow variation on top of bias
 * -------------------------------------------------------------------- */
const ROLE_CP = {
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
  frontBumper:      { bias:  0.70, scale: 0.40 },
  bodyTop:          { bias: -0.25, scale: 0.45 },
};

/* ── Per-car CFD patch definitions ─────────────────────────────────── *
 * { w, h, cx, cy, cz, rx, ry, rz, role }
 * (cx,cy,cz) world centre  (rx,ry,rz) patch plane Euler rotation
 * -------------------------------------------------------------------- */
const π = Math.PI;
const CFD_PATCHES = {
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
  F2: [
    { w: 1.60, h: 0.30, cx:  0,      cy:  0.022, cz: -2.48, rx: -π/2, ry: 0,    rz: 0,    role: 'frontWing' },
    { w: 1.52, h: 0.20, cx:  0,      cy:  0.060, cz: -2.42, rx: -π/2, ry: 0,    rz: 0.10, role: 'frontWingFlap' },
    { w: 0.30, h: 0.84, cx:  0,      cy:  0.12,  cz: -2.02, rx: 0,    ry: 0,    rz: 0,    role: 'nose' },
    { w: 0.56, h: 1.10, cx:  0,      cy:  0.40,  cz: -0.08, rx: -π/2, ry: 0,    rz: 0,    role: 'monocoque' },
    { w: 0.055,h: 0.27, cx: -0.449,  cy:  0.19,  cz: -0.55, rx: 0,    ry:  π/2, rz: 0,    role: 'sidepodInlet' },
    { w: 0.055,h: 0.27, cx:  0.449,  cy:  0.19,  cz: -0.55, rx: 0,    ry: -π/2, rz: 0,    role: 'sidepodInlet' },
    { w: 0.30, h: 1.62, cx: -0.480,  cy:  0.42,  cz:  0.22, rx: -π/2, ry: 0,    rz: 0,    role: 'sidepodTop' },
    { w: 0.30, h: 1.62, cx:  0.480,  cy:  0.42,  cz:  0.22, rx: -π/2, ry: 0,    rz: 0,    role: 'sidepodTop' },
    { w: 0.28, h: 1.62, cx: -0.635,  cy:  0.19,  cz:  0.22, rx: 0,    ry:  π/2, rz: 0,    role: 'sidepodSide' },
    { w: 0.28, h: 1.62, cx:  0.635,  cy:  0.19,  cz:  0.22, rx: 0,    ry: -π/2, rz: 0,    role: 'sidepodSide' },
    { w: 0.48, h: 1.00, cx:  0,      cy:  0.51,  cz:  1.30, rx: -π/2, ry: 0,    rz: 0,    role: 'engineCover' },
    { w: 1.30, h: 3.40, cx:  0,      cy:  0.007, cz: -0.08, rx:  π/2, ry: 0,    rz: 0,    role: 'floor' },
    { w: 1.00, h: 0.88, cx:  0,      cy: -0.04,  cz:  1.80, rx:  π/2, ry: 0,    rz: 0.24, role: 'diffuser' },
    { w: 1.74, h: 0.30, cx:  0,      cy:  0.90,  cz:  1.80, rx: -π/2, ry: 0,    rz: 0,    role: 'rearWing' },
    { w: 1.68, h: 0.22, cx:  0,      cy:  0.97,  cz:  1.77, rx: -π/2, ry: 0,    rz: 0.12, role: 'rearWingFlap' },
  ],
  F3: [
    { w: 1.46, h: 0.24, cx:  0,      cy:  0.020, cz: -2.24, rx: -π/2, ry: 0,    rz: 0,    role: 'frontWing' },
    { w: 1.38, h: 0.16, cx:  0,      cy:  0.055, cz: -2.18, rx: -π/2, ry: 0,    rz: 0.08, role: 'frontWingFlap' },
    { w: 0.26, h: 0.76, cx:  0,      cy:  0.10,  cz: -1.84, rx: 0,    ry: 0,    rz: 0,    role: 'nose' },
    { w: 0.50, h: 0.90, cx:  0,      cy:  0.36,  cz: -0.10, rx: -π/2, ry: 0,    rz: 0,    role: 'monocoque' },
    { w: 1.16, h: 2.90, cx:  0,      cy:  0.007, cz: -0.08, rx:  π/2, ry: 0,    rz: 0,    role: 'floor' },
    { w: 0.88, h: 0.76, cx:  0,      cy: -0.04,  cz:  1.68, rx:  π/2, ry: 0,    rz: 0.22, role: 'diffuser' },
    { w: 1.56, h: 0.26, cx:  0,      cy:  0.82,  cz:  1.68, rx: -π/2, ry: 0,    rz: 0,    role: 'rearWing' },
    { w: 1.48, h: 0.20, cx:  0,      cy:  0.88,  cz:  1.65, rx: -π/2, ry: 0,    rz: 0.12, role: 'rearWingFlap' },
  ],
  GT: [
    { w: 1.84, h: 0.40, cx:  0,      cy:  0.00,  cz: -2.32, rx: -π/2, ry: 0,    rz: 0,    role: 'frontBumper' },
    { w: 1.70, h: 0.50, cx:  0,      cy:  0.60,  cz: -2.10, rx: -π/2, ry: 0,    rz:-0.20, role: 'bodyTop' },
    { w: 1.60, h: 1.20, cx:  0,      cy:  0.72,  cz:  0.10, rx: -π/2, ry: 0,    rz: 0,    role: 'bodyTop' },
    { w: 1.60, h: 1.10, cx:  0,      cy:  0.72,  cz:  1.20, rx: -π/2, ry: 0,    rz: 0,    role: 'bodyTop' },
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
  F2: [
    { role: 'stagnation',   color: 0xff2200, r: 0.22, intensity: 0.82, phase: 0.0, pos: [ 0,      0.12, -2.64] },
    { role: 'suction',      color: 0x0044ff, r: 0.36, intensity: 0.72, phase: 1.1, pos: [ 0,      0.02, -2.40] },
    { role: 'fwTipL',       color: 0x2266ff, r: 0.15, intensity: 0.60, phase: 0.6, pos: [-0.84,   0.02, -2.48] },
    { role: 'fwTipR',       color: 0x2266ff, r: 0.15, intensity: 0.60, phase: 0.6, pos: [ 0.84,   0.02, -2.48] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.18, intensity: 0.60, phase: 0.5, pos: [-0.449,  0.19, -0.55] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.18, intensity: 0.60, phase: 0.5, pos: [ 0.449,  0.19, -0.55] },
    { role: 'diffuser',     color: 0x0066ff, r: 0.45, intensity: 0.72, phase: 2.2, pos: [ 0,     -0.04,  1.80] },
    { role: 'rearWing',     color: 0xff2200, r: 0.26, intensity: 0.55, phase: 0.8, pos: [ 0,      0.90,  1.80] },
    { role: 'fwCenter',     color: 0x0044ff, r: 0.14, intensity: 0.45, phase: 0.7, pos: [ 0,      0.10, -2.48] },
    { role: 'cockpit',      color: 0xff6600, r: 0.20, intensity: 0.70, phase: 1.4, pos: [ 0,      0.46, -0.42] },
  ],
  F3: [
    { role: 'stagnation',   color: 0xff2200, r: 0.18, intensity: 0.65, phase: 0.0, pos: [ 0,      0.10, -2.40] },
    { role: 'suction',      color: 0x0044ff, r: 0.28, intensity: 0.55, phase: 1.1, pos: [ 0,      0.02, -2.18] },
    { role: 'diffuser',     color: 0x0066ff, r: 0.38, intensity: 0.52, phase: 2.2, pos: [ 0,     -0.04,  1.68] },
    { role: 'rearWing',     color: 0xff2200, r: 0.22, intensity: 0.50, phase: 0.8, pos: [ 0,      0.82,  1.68] },
    { role: 'fwCenter',     color: 0x0044ff, r: 0.12, intensity: 0.40, phase: 0.7, pos: [ 0,      0.08, -2.24] },
    { role: 'cockpit',      color: 0xff6600, r: 0.20, intensity: 0.70, phase: 1.4, pos: [ 0,      0.40, -0.38] },
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
    { x: -0.93, y:  0.02, z: -2.72, sign:  1, radius: 0.14, length: 1.00 }, // FW tip L
    { x:  0.93, y:  0.02, z: -2.72, sign: -1, radius: 0.14, length: 1.00 }, // FW tip R
    { x: -0.61, y:  0.06, z:  0.10, sign:  1, radius: 0.18, length: 1.40 }, // sidepod undercut L
    { x:  0.61, y:  0.06, z:  0.10, sign: -1, radius: 0.18, length: 1.40 }, // sidepod undercut R
    { x: -0.48, y: -0.04, z:  2.10, sign:  1, radius: 0.26, length: 1.43 }, // diffuser L
    { x:  0.48, y: -0.04, z:  2.10, sign: -1, radius: 0.26, length: 1.43 }, // diffuser R
  ],
  F2: [
    { x: -0.84, y:  0.02, z: -2.48, sign:  1, radius: 0.12, length: 0.90 },
    { x:  0.84, y:  0.02, z: -2.48, sign: -1, radius: 0.12, length: 0.90 },
    { x: -0.40, y: -0.04, z:  1.97, sign:  1, radius: 0.22, length: 1.23 },
    { x:  0.40, y: -0.04, z:  1.97, sign: -1, radius: 0.22, length: 1.23 },
  ],
  F3: [
    { x: -0.70, y:  0.02, z: -2.24, sign:  1, radius: 0.10, length: 0.80 },
    { x:  0.70, y:  0.02, z: -2.24, sign: -1, radius: 0.10, length: 0.80 },
    { x: -0.32, y: -0.04, z:  1.85, sign:  1, radius: 0.18, length: 1.03 },
    { x:  0.32, y: -0.04, z:  1.85, sign: -1, radius: 0.18, length: 1.03 },
  ],
  GT: [
    { x: -0.44, y: -0.10, z:  2.31, sign:  1, radius: 0.24, length: 1.23 },
    { x:  0.44, y: -0.10, z:  2.31, sign: -1, radius: 0.24, length: 1.23 },
  ],
};

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
  F2: [
    { x:  0.00, y: 0.46, zStart: -2.60, zEnd: 2.40, waveX: 0.000, waveY: 0.028 },
    { x: -0.20, y: 0.35, zStart: -2.60, zEnd: 2.20, waveX: 0.010, waveY: 0.022 },
    { x:  0.20, y: 0.35, zStart: -2.60, zEnd: 2.20, waveX:-0.010, waveY: 0.022 },
    { x: -0.48, y: 0.42, zStart: -2.60, zEnd: 2.10, waveX: 0.007, waveY: 0.018 },
    { x:  0.48, y: 0.42, zStart: -2.60, zEnd: 2.10, waveX:-0.007, waveY: 0.018 },
    { x:  0.00, y: 0.00, zStart: -1.90, zEnd: 1.95, waveX: 0.000, waveY: 0.010 },
  ],
  F3: [
    { x:  0.00, y: 0.40, zStart: -2.35, zEnd: 2.10, waveX: 0.000, waveY: 0.025 },
    { x: -0.18, y: 0.30, zStart: -2.35, zEnd: 1.95, waveX: 0.008, waveY: 0.020 },
    { x:  0.18, y: 0.30, zStart: -2.35, zEnd: 1.95, waveX:-0.008, waveY: 0.020 },
    { x:  0.00, y: 0.00, zStart: -1.70, zEnd: 1.80, waveX: 0.000, waveY: 0.010 },
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
    this._wingStalled    = false;
    this._speedDirty     = true;
    this._lastBuiltSpeed = -1;

    this._patchMeshes    = [];
    this._blobMeshes     = [];
    this._vortexLines    = [];
    this._streamlines    = [];

    this._build('F1');
    this.group.visible = false;
  }

  /* ── Public interface ─────────────────────────────────────────── */

  setCarType(type) {
    if (this._type === type) return;
    this._type = type;
    this._disposeAll();
    this._build(type);
    this.group.visible = this._visible;
    this._lastBuiltSpeed = -1;
  }

  setSpeed(speed) {
    this._speed      = speed;
    this._speedDirty = true;
  }

  setVisible(v) {
    this._visible      = v;
    this.group.visible = v;
  }

  setWingStall(isStalled) {
    if (this._wingStalled === isStalled) return;
    this._wingStalled    = isStalled;
    this._lastBuiltSpeed = -1;
    this._speedDirty     = true;
  }

  update(dt, t) {
    if (!this._visible) return;

    const speedFactor = Math.min(this._speed / 350, 1);

    // Refresh patch vertex colours when speed changes meaningfully
    if (this._speedDirty && Math.abs(this._speed - this._lastBuiltSpeed) > 5) {
      this._updatePatchColors(speedFactor);
      this._lastBuiltSpeed = this._speed;
      this._speedDirty     = false;
    }

    // ── Zone blobs: pulse scale + opacity ─────────────────────────
    const blobs = ZONE_BLOBS[this._type] || ZONE_BLOBS.F1;
    for (let i = 0; i < this._blobMeshes.length; i++) {
      const blob = blobs[i];
      if (!blob || !this._blobMeshes[i]) continue;

      let eff_int = blob.intensity;
      let eff_r   = blob.r;
      if (this._wingStalled && blob.role === 'rearWing') {
        eff_int *= 0.12;
        eff_r   *= 2.4;
      }

      const pulsed = 0.80 + 0.20 * Math.sin(t * 2.2 + blob.phase);
      this._blobMeshes[i].scale.setScalar(
        speedFactor * speedFactor * eff_int * 0.28 * pulsed
      );
      this._blobMeshes[i].material.opacity =
        speedFactor * eff_int * 0.58 * (0.72 + 0.28 * Math.sin(t * 2.2 + blob.phase));
    }

    // ── Vortex core spirals ────────────────────────────────────────
    const vDefs = VORTEX_CORES[this._type] || VORTEX_CORES.F1;
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

        // Cp-based color from longitudinal profile, modulated by speed
        const cp = lerpCpProfile(z) * speedFactor;
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
    this._patchMeshes = [];
    this._blobMeshes  = [];
    this._vortexLines = [];
    this._streamlines = [];
  }

  _build(type) {
    this._buildPatches(type);
    this._buildBlobs(type);
    this._buildVortexCores(type);
    this._buildStreamlines(type);
  }

  /* ── Surface pressure patches ─────────────────────────────────── */
  _buildPatches(type) {
    const patches = CFD_PATCHES[type] || CFD_PATCHES.F1;

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

      const m = new THREE.Mesh(geo, mat);
      m.position.set(p.cx, p.cy, p.cz);
      m.rotation.set(p.rx, p.ry, p.rz);
      m.userData.patchDef = p;
      this.group.add(m);
      this._patchMeshes.push(m);
    }
  }

  /* ── Role-specific per-vertex Cp colouring ────────────────────── */
  _updatePatchColors(speedFactor) {
    const patches = CFD_PATCHES[this._type] || CFD_PATCHES.F1;

    for (let pi = 0; pi < this._patchMeshes.length; pi++) {
      const m = this._patchMeshes[pi];
      const p = patches[pi];
      if (!m || !p) continue;

      const pos    = m.geometry.attributes.position.array;
      const colors = m.geometry.attributes.color.array;
      const count  = m.geometry.attributes.position.count;
      const hw = p.w / 2;
      const hh = p.h / 2;

      const roleDef = ROLE_CP[p.role] || { bias: 0, scale: 0.5 };
      const isRearStalled = this._wingStalled && (p.role === 'rearWing' || p.role === 'rearWingFlap');

      for (let vi = 0; vi < count; vi++) {
        const lx = pos[vi * 3];
        const ly = pos[vi * 3 + 1];

        let cp;
        if (isRearStalled) {
          // Turbulent separated flow — noisy near-zero Cp
          cp = rnd(-0.12, 0.12);
        } else {
          // Potential-flow perturbation on top of role-specific bias
          const xi  = hw > 0 ? lx / hw : 0;
          const eta = hh > 0 ? ly / hh : 0;
          const { vxi, veta } = topViewVelocity(xi * 1.6 + 0.01, eta * 1.6 + 0.01);
          const baseCp = pressureCoeff(vxi, veta);

          // Change 8: ground-effect scaling for floor and diffuser (scales with speed²)
          let groundScale = 1.0;
          if (p.role === 'floor')    groundScale = 1 + speedFactor * speedFactor * 0.30;
          if (p.role === 'diffuser') groundScale = 1 + speedFactor * speedFactor * 0.25;

          cp = (roleDef.bias + roleDef.scale * baseCp * speedFactor) * groundScale;

          // Nose: add gradient — high Cp at centre (stagnation), lower at sides
          if (p.role === 'nose') {
            cp += (1 - Math.abs(xi)) * 0.40 * speedFactor;
          }
          // Floor: Cp increases (stronger suction) toward rear where tunnel height drops
          if (p.role === 'floor') {
            cp -= (eta + 1) * 0.20 * speedFactor; // eta=-1 at front, +1 at rear
          }

          // Change 9: vortex Cp perturbation for sidepodTop, floor, diffuser
          if (['sidepodTop', 'floor', 'diffuser'].includes(p.role)) {
            const vDefs = VORTEX_CORES[this._type] || VORTEX_CORES.F1;
            for (const vc of vDefs) {
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
        }

        const c = cpToColor(cp);
        colors[vi * 3]     = c.r;
        colors[vi * 3 + 1] = c.g;
        colors[vi * 3 + 2] = c.b;
      }

      m.geometry.attributes.color.needsUpdate = true;
      m.material.opacity = speedFactor * 0.68;
    }
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
      m.position.set(blob.pos[0], blob.pos[1], blob.pos[2]);
      this.group.add(m);
      this._blobMeshes.push(m);
    }
  }

  /* ── Vortex core spiral lines ─────────────────────────────────── */
  _buildVortexCores(type) {
    const vDefs = VORTEX_CORES[type] || VORTEX_CORES.F1;
    for (const def of vDefs) {
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
