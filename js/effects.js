/**
 * effects.js — Visual effects system
 * Manages: Airflow, Rain, Optimal Weather
 */

import * as THREE from 'three';
import {
  traceStreamlinePath, topViewVelocity, pressureCoeff,
  cpToColor, vortexVelocity, sideViewVelocity,
} from './airflow-core.js';

/* ── Utility ───────────────────────────────────────────────────── */
function rnd(min, max) { return min + Math.random() * (max - min); }

/* ── Radial-gradient soft puff texture (shared singleton) ───────── */
let _puffTex = null;

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
function _makePuffTexture() {
  const size   = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.22)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.14)');
  grd.addColorStop(0.70, 'rgba(255,255,255,0.05)');
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
const SMOKE_PTS  = 260;    // smoke-chain particles per streamline
const VORTEX_PTS = 100;

/* ── Per-car aerodynamic profiles ── */
const CAR_AERO = {
  F1: {
    halfW: 0.90, halfL: 2.45, halfH: 0.55,
    /* Top-plane seeds: multiple lateral offsets for dense coverage */
    topSeeds:    [-2.8,-2.2,-1.6,-1.0,-0.4, 0.4, 1.0, 1.6, 2.2, 2.8],
    /* Side-height seeds: more layers for 3-D vertical structure */
    sideHeights: [-0.12, 0.05, 0.20, 0.38, 0.58, 0.78, 1.00, 1.22, 1.45, 1.65],
    /* Under-floor ground-effect zone — critical for downforce */
    underSeeds:  [-0.45,-0.25,-0.08, 0.08, 0.25, 0.45],  underY: -0.04,
    /* Outer far-field seeds to show undisturbed flow */
    farSeeds:    [-4.5,-3.5,-2.5, 2.5, 3.5, 4.5],
    /* Front wing cascade seeds — at wing height */
    fwSeeds:     [-1.4,-0.9,-0.4, 0.4, 0.9, 1.4],  fwY: 0.04, fwEta: -2.6,
    /* Body-hugging seeds — boundary layer along sidepod/body edge */
    bodySeeds:   [-1.04,-0.96,-0.88, 0.88, 0.96, 1.04],  bodyY: [0.28, 0.50],
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
      {wx:-0.82,wy:0.02,wz:-2.60,sign: 1, gamma:0.6, rc:0.12},
      {wx: 0.82,wy:0.02,wz:-2.60,sign:-1, gamma:0.6, rc:0.12},
      {wx:-0.90,wy:0.85,wz: 1.85,sign:-1, gamma:1.0, rc:0.18},
      {wx: 0.90,wy:0.85,wz: 1.85,sign: 1, gamma:1.0, rc:0.18},
      // under-car ground vortices (floor edge)
      {wx:-0.88,wy:-0.05,wz: 0.50,sign: 1, gamma:0.4, rc:0.10},
      {wx: 0.88,wy:-0.05,wz: 0.50,sign:-1, gamma:0.4, rc:0.10},
    ],
    vortexMaxRadius:0.40, wakeWidthX:1.0,
    wakeHeightRange:[-0.10,1.20], wakeCount:220,
    strouhal: 0.21,  // Strouhal number for vortex shedding frequency
  },
  F2: {
    halfW: 0.82, halfL: 2.20, halfH: 0.50,
    topSeeds:    [-2.8,-2.0,-1.4,-0.8,-0.3, 0.3, 0.8, 1.4, 2.0, 2.8],
    sideHeights: [-0.10, 0.05, 0.20, 0.36, 0.55, 0.72, 0.92, 1.12, 1.32, 1.50],
    underSeeds:  [-0.40,-0.22,-0.07, 0.07, 0.22, 0.40],  underY: -0.03,
    farSeeds:    [-4.5,-3.5,-2.5, 2.5, 3.5, 4.5],
    fwSeeds:     [-1.3,-0.8,-0.3, 0.3, 0.8, 1.3],  fwY: 0.04, fwEta: -2.36,
    bodySeeds:   [-1.04,-0.96,-0.88, 0.88, 0.96, 1.04],  bodyY: [0.24, 0.46],
    pressureBlobs: [
      { color:0xff2200, r:0.38, intensity:0.85, pos:[0, 0.12,-2.35] },
      { color:0x2266ff, r:0.45, intensity:0.72, pos:[0, 0.02,-2.36] },
      { color:0xff2200, r:0.32, intensity:0.58, pos:[0, 0.79, 1.70] },
      { color:0x2266ff, r:0.48, intensity:0.76, pos:[0, 0.68, 1.70] },
      { color:0x00ddff, r:0.65, intensity:0.65, pos:[0,-0.04, 0.00] },
      { color:0xff4400, r:0.26, intensity:0.55, pos:[ 0.76, 0.04,-1.45] },
      { color:0xff4400, r:0.26, intensity:0.55, pos:[-0.76, 0.04,-1.45] },
      { color:0x0066ff, r:0.16, intensity:0.40, phase:1.6, pos:[0, 0.10,-2.48] },
      { color:0xff6600, r:0.28, intensity:0.75, phase:0.9, pos:[0, 0.46,-0.42] },
    ],
    vortexDefs: [
      {wx:-0.77,wy:0.02,wz:-2.36,sign: 1, gamma:0.5, rc:0.10},
      {wx: 0.77,wy:0.02,wz:-2.36,sign:-1, gamma:0.5, rc:0.10},
      {wx:-0.86,wy:0.76,wz: 1.70,sign:-1, gamma:0.8, rc:0.16},
      {wx: 0.86,wy:0.76,wz: 1.70,sign: 1, gamma:0.8, rc:0.16},
    ],
    vortexMaxRadius:0.30, wakeWidthX:1.0,
    wakeHeightRange:[-0.10,1.00], wakeCount:190,
    strouhal: 0.20,
  },
  F3: {
    halfW: 0.72, halfL: 1.90, halfH: 0.44,
    topSeeds:    [-2.6,-1.9,-1.3,-0.7,-0.2, 0.2, 0.7, 1.3, 1.9, 2.6],
    sideHeights: [-0.10, 0.05, 0.18, 0.32, 0.48, 0.64, 0.80, 0.96, 1.10, 1.25],
    underSeeds:  [-0.30,-0.15,-0.05, 0.05, 0.15, 0.30],  underY: -0.02,
    farSeeds:    [-4.0,-3.0,-2.2, 2.2, 3.0, 4.0],
    fwSeeds:     [-1.2,-0.7,-0.2, 0.2, 0.7, 1.2],  fwY: 0.04, fwEta: -2.12,
    bodySeeds:   [-1.04,-0.96,-0.88, 0.88, 0.96, 1.04],  bodyY: [0.20, 0.40],
    pressureBlobs: [
      { color:0xff2200, r:0.32, intensity:0.68, pos:[0, 0.11,-2.10] },
      { color:0x2266ff, r:0.35, intensity:0.48, pos:[0, 0.02,-2.12] },
      { color:0x2266ff, r:0.42, intensity:0.55, pos:[0, 0.65, 1.55] },
      { color:0x00ddff, r:0.45, intensity:0.35, pos:[0,-0.03, 0.00] },
      { color:0x0066ff, r:0.14, intensity:0.35, phase:1.7, pos:[0, 0.08,-2.24] },
      { color:0xff6600, r:0.28, intensity:0.75, phase:1.0, pos:[0, 0.40,-0.38] },
    ],
    vortexDefs: [
      {wx:-0.75,wy:0.65,wz: 1.55,sign:-1, gamma:0.5, rc:0.10},
      {wx: 0.75,wy:0.65,wz: 1.55,sign: 1, gamma:0.5, rc:0.10},
    ],
    vortexMaxRadius:0.20, wakeWidthX:0.80,
    wakeHeightRange:[-0.10,0.90], wakeCount:150,
    strouhal: 0.19,
  },
  GT: {
    halfW: 1.05, halfL: 2.40, halfH: 0.65,
    topSeeds:    [-2.8,-2.0,-1.4,-0.8,-0.3, 0.3, 0.8, 1.4, 2.0, 2.8],
    sideHeights: [-0.08, 0.10, 0.28, 0.46, 0.64, 0.82, 1.00, 1.16, 1.30, 1.48],
    underSeeds:  [-0.35,-0.18,-0.06, 0.06, 0.18, 0.35],  underY: -0.07,
    farSeeds:    [-4.5,-3.5,-2.5, 2.5, 3.5, 4.5],
    fwSeeds:     [], fwY: 0, fwEta: 0,  // GT has no dedicated front wing
    bodySeeds:   [-1.04,-0.96,-0.88, 0.88, 0.96, 1.04],  bodyY: [0.20, 0.46],
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
      {wx:-0.86,wy:0.72,wz: 1.80,sign:-1, gamma:0.8, rc:0.14},
      {wx: 0.86,wy:0.72,wz: 1.80,sign: 1, gamma:0.8, rc:0.14},
      {wx:-0.93,wy:0.12,wz: 1.60,sign: 1, gamma:0.5, rc:0.10},
      {wx: 0.93,wy:0.12,wz: 1.60,sign:-1, gamma:0.5, rc:0.10},
    ],
    vortexMaxRadius:0.28, wakeWidthX:1.50,
    wakeHeightRange:[-0.08,1.00], wakeCount:250,
    strouhal: 0.22,
  },
};

function getProfile(type) { return CAR_AERO[type] || CAR_AERO.F1; }

function _buildSeedList(p) {
  const seeds = [];
  // Top-plane sweep (plan view, multiple heights for 3-D coverage)
  for (const xi of p.topSeeds) {
    seeds.push({ seedXi: xi,   seedEta: -8, y: 0.38,  group: 'top',   halfH: p.halfH });
    seeds.push({ seedXi: xi,   seedEta: -8, y: 0.70,  group: 'top',   halfH: p.halfH });
  }
  // Side-height sweep (lateral slice at x≈0)
  for (const y of p.sideHeights) {
    seeds.push({ seedXi: 0.01, seedEta: -8, y,        group: 'side',  halfH: p.halfH });
  }
  // Ground-effect underbody
  for (const xi of p.underSeeds) {
    seeds.push({ seedXi: xi,   seedEta: -8, y: p.underY, group: 'under', halfH: p.halfH });
  }
  // Far-field (show undisturbed freestream)
  for (const xi of p.farSeeds) {
    seeds.push({ seedXi: xi,   seedEta: -8, y: 0.38,  group: 'far',   halfH: p.halfH });
  }
  // Front-wing zone (if defined)
  for (const xi of (p.fwSeeds || [])) {
    seeds.push({ seedXi: xi,   seedEta: p.fwEta - 1, y: p.fwY, group: 'fw', halfH: p.halfH });
  }
  // Body-hugging boundary layer (traces surface airflow along body edges)
  for (const xi of (p.bodySeeds || [])) {
    for (const y of (p.bodyY || [])) {
      seeds.push({ seedXi: xi, seedEta: -8, y, group: 'body', halfH: p.halfH });
    }
  }
  // Rooftop spine — dense centerline trail directly above the car body
  for (const xi of [-0.08, -0.03, 0, 0.03, 0.08]) {
    for (const yMul of [1.80, 1.95, 2.10, 2.25]) {
      seeds.push({ seedXi: xi, seedEta: -8, y: p.halfH * yMul, group: 'spine', halfH: p.halfH });
    }
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

  setCarType(type, measure) {
    // Always refresh measure — caller may re-invoke with a new measure snapshot
    // (e.g. when the same type's GLB resolves after the initial procedural build).
    this._measure = measure || null;
    if (this._type === type) return;
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
    this._halfW           = profile.halfW;
    this._halfL           = profile.halfL;
    this._halfH           = profile.halfH;
    this._vortexMaxRadius = profile.vortexMaxRadius;
    this._wakeWidthX      = profile.wakeWidthX;
    this._wakeHeightRange = profile.wakeHeightRange;
    this._strouhal        = profile.strouhal || 0.20;
    this._seeds           = _buildSeedList(profile);
    this._paths           = this._seeds.map(s =>
      traceStreamlinePath(s.seedXi, s.seedEta, STEPS, STEP_SIZE)
    );
    this._buildSmokeParticles();
    this._buildVortexSpirals(profile.vortexDefs);
    this._buildWakeParticles(profile.wakeCount);
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

  /* ── Smoke particles — soft billboarded puff chains ── */
  _buildSmokeParticles() {
    const total     = this._seeds.length * SMOKE_PTS;
    const positions = new Float32Array(total * 3);
    const colors    = new Float32Array(total * 3);

    this._smokeSeedIdx = new Int32Array(total);
    this._smokeT       = new Float32Array(total);
    this._smokeJx      = new Float32Array(total);
    this._smokeJy      = new Float32Array(total);
    this._smokeJz      = new Float32Array(total);
    this._smokeYAcc    = new Float32Array(total);
    this._smokeLife    = new Float32Array(total);

    let idx = 0;
    for (let s = 0; s < this._seeds.length; s++) {
      const pathLen = this._paths[s].length;
      for (let k = 0; k < SMOKE_PTS; k++) {
        this._smokeSeedIdx[idx] = s;
        this._smokeT[idx]       = (k / SMOKE_PTS) * (pathLen - 1);
        this._smokeLife[idx]    = rnd(0, 1); // stagger fades so trails look continuous
        idx++;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const mat = new THREE.PointsMaterial({
      size: 0.55,
      map: (_puffTex ||= _makePuffTexture()),
      alphaTest: 0,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    this._smokePoints  = new THREE.Points(geo, mat);
    this._smokeMat     = mat;
    this._smokePos     = positions;
    this._smokeColors  = colors;
    this.group.add(this._smokePoints);
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

  setVisible(v) {
    this._visible = v;
    this.group.visible = v;
  }

  update(dt, t) {
    if (!this._visible) return;
    this._time += dt;

    const speedFactor = Math.min(this._speed / 350, 1);

    /* ── Smoke particles — soft billboarded puff chains ── */
    const advRate = speedFactor * 9.0;
    const jBase   = 0.002 * speedFactor;
    const jDecay  = 0.90;
    const sPos    = this._smokePos;
    const sCol    = this._smokeColors;

    for (let i = 0; i < this._smokeT.length; i++) {
      const s    = this._smokeSeedIdx[i];
      const path = this._paths[s];
      if (!path || path.length < 2) continue;

      // Life cycle — bell-curve fade so puffs appear/disappear softly
      this._smokeLife[i] += dt * 0.45;
      if (this._smokeLife[i] > 1) this._smokeLife[i] = 0;
      const fade = Math.sin(this._smokeLife[i] * Math.PI);

      const ptNow = path[Math.min(Math.floor(this._smokeT[i]), path.length - 1)];
      const localSpeed = Math.sqrt(ptNow.vxi * ptNow.vxi + ptNow.veta * ptNow.veta);
      this._smokeT[i] += dt * advRate * Math.max(0.4, Math.min(localSpeed, 3.2));

      if (this._smokeT[i] >= path.length - 1) {
        this._smokeT[i]    = 0;
        this._smokeJx[i]   = 0;
        this._smokeJy[i]   = 0;
        this._smokeJz[i]   = 0;
        this._smokeYAcc[i] = 0;
      }

      const ti   = Math.floor(this._smokeT[i]);
      const frac = this._smokeT[i] - ti;
      const ptA  = path[Math.min(ti,     path.length - 1)];
      const ptB  = path[Math.min(ti + 1, path.length - 1)];
      const xi   = ptA.xi  + (ptB.xi  - ptA.xi)  * frac;
      const eta  = ptA.eta + (ptB.eta - ptA.eta)  * frac;
      const vxi  = ptA.vxi + (ptB.vxi - ptA.vxi)  * frac;
      const veta = ptA.veta + (ptB.veta - ptA.veta) * frac;
      const y0   = this._seeds[s].y;

      const dy = this._verticalDelta(eta, y0 + this._smokeYAcc[i]);
      this._smokeYAcc[i] += dy * 0.05;

      const normFrac  = Math.max(0, Math.min(1, (eta - 1) / 7));
      const jitterAmp = jBase * (1 + normFrac * 4);
      this._smokeJx[i] = this._smokeJx[i] * jDecay + (Math.random() * 2 - 1) * jitterAmp * 0.7;
      this._smokeJy[i] = this._smokeJy[i] * jDecay + (Math.random() * 2 - 1) * jitterAmp * 1.0;
      this._smokeJz[i] = this._smokeJz[i] * jDecay + (Math.random() * 2 - 1) * jitterAmp * 0.7;

      const w = this._toWorld(xi, eta, y0 + this._smokeYAcc[i]);
      sPos[i * 3]     = w.x + this._smokeJx[i];
      sPos[i * 3 + 1] = w.y + this._smokeJy[i];
      sPos[i * 3 + 2] = w.z + this._smokeJz[i];

      // Vortex-coupled drift — bend smoke near wing-tip vortex cores
      if (this._profile?.vortexDefs) {
        for (const def of this._profile.vortexDefs) {
          const vxiC = def.wx / this._halfW;
          const vetaC = def.wz / this._halfL;
          const dx = xi - vxiC, de = eta - vetaC;
          const rcN = def.rc / Math.min(this._halfW, this._halfL);
          if (dx * dx + de * de < (rcN * 3) ** 2) {
            const vv = vortexVelocity(xi, eta, vxiC, vetaC, def.gamma, rcN);
            sPos[i * 3]     += vv.vxi  * this._halfW * speedFactor * 0.008;
            sPos[i * 3 + 2] += vv.veta * this._halfL * speedFactor * 0.008;
          }
        }
      }

      // Cp color modulated by life fade — soft in/out
      const cp = pressureCoeff(vxi, veta);
      const c  = cpToColor(cp);
      const r = (0.85 + c.r * 0.15) * fade;
      const g = (0.85 + c.g * 0.15) * fade;
      const b = (0.88 + c.b * 0.15) * fade;
      sCol[i * 3]     = r;
      sCol[i * 3 + 1] = g;
      sCol[i * 3 + 2] = b;
    }

    this._smokePoints.geometry.attributes.position.needsUpdate = true;
    this._smokePoints.geometry.attributes.color.needsUpdate    = true;
    this._smokeMat.opacity = Math.min(1, 0.65 + speedFactor * 0.35);
    this._smokeMat.size    = 0.45 + 0.25 * speedFactor;

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
  F2: { sprayX: 0.65, sprayZ: 1.38, roosterX: 0.73, roosterZ: 1.52 },
  F3: { sprayX: 0.56, sprayZ: 1.22, roosterX: 0.63, roosterZ: 1.38 },
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
    for (let i = 0; i < this._dCount; i++) {
      dp[i * 6 + 1] -= dt * this._dVels[i];
      dp[i * 6 + 2] += dt * windTilt;
      if (dp[i * 6 + 1] < -0.35) {
        dp[i * 6]     = rnd(-5, 5);
        dp[i * 6 + 1] = 8;
        dp[i * 6 + 2] = rnd(-6, 6);
      }
      // Head = tail + streak offset
      dp[i * 6 + 3] = dp[i * 6];
      dp[i * 6 + 4] = dp[i * 6 + 1] + streakLen;
      dp[i * 6 + 5] = dp[i * 6 + 2] + windTilt * 0.15;
    }
    this.droplets.geometry.attributes.position.needsUpdate = true;

    // Change 4: proper gravity accumulation (9.8 m/s²) for spray
    const sp = this._sPos, sv = this._sVels;
    for (let i = 0; i < this._sCount; i++) {
      this._sprayLife[i] += dt * 2.0;
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
      rv[i * 3 + 1] -= 9.8 * dt;         // gravity
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

/* ════════════════════════════════════════════════════════════════ */
/*  OPTIMAL WEATHER EFFECT                                          */
/* ════════════════════════════════════════════════════════════════ */
export class OptimalWeatherEffect {
  constructor(scene, renderer) {
    this.scene    = scene;
    this.renderer = renderer;
    this.group    = new THREE.Group();
    this.group.name = 'optimalWeather';
    scene.add(this.group);

    this._visible = false;
    this._speed   = 0;

    this._buildTrackShimmer();
    this._buildHeatHaze();
    this.group.visible = false;
  }

  _buildTrackShimmer() {
    const COUNT = 500;
    const positions = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3]     = rnd(-3.5, 3.5);
      positions[i * 3 + 1] = -0.34;
      positions[i * 3 + 2] = rnd(-6, 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffeeaa,
      size: 0.03,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.shimmerPoints = new THREE.Points(geo, mat);
    this.group.add(this.shimmerPoints);
    this._shimMat   = mat;
    this._shimPos   = positions;
    this._shimCount = COUNT;
    this._shimPhase = new Float32Array(COUNT).fill(0).map(() => rnd(0, Math.PI * 2));
  }

  _buildHeatHaze() {
    const geo = new THREE.SphereGeometry(0.55, 14, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffddaa,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
    });
    this.hazeBlob = new THREE.Mesh(geo, mat);
    this.hazeBlob.position.set(0, 0.18, 2.1);
    this.group.add(this.hazeBlob);
    this._hazeMat = mat;
  }

  /**
   * Reposition the heat-haze blob behind the rear axle when measure is
   * supplied. Heat sits ~0.5 m aft of the contact patch — same nudge used
   * for the rain rooster tails.
   */
  setCarType(_type, measure) {
    if (!this.hazeBlob) return;
    if (measure && typeof measure.rearAxleZ === 'number') {
      this.hazeBlob.position.z = measure.rearAxleZ + 0.5;
    }
  }

  setSpeed(speed)  { this._speed = speed; }

  setVisible(v) {
    this._visible = v;
    this.group.visible = v;
  }

  update(_dt, t) {
    if (!this._visible) return;

    const speedFactor = Math.min(this._speed / 350, 1);

    const p = this._shimPos;
    for (let i = 0; i < this._shimCount; i++) {
      const bright = Math.max(0, Math.sin(t * 3.5 + this._shimPhase[i]));
      p[i * 3 + 1] = -0.34 + bright * 0.003;
    }
    this.shimmerPoints.geometry.attributes.position.needsUpdate = true;
    this._shimMat.opacity = (0.05 + speedFactor * 0.30) * (0.60 + 0.40 * Math.abs(Math.sin(t * 0.5)));

    this._hazeMat.opacity = speedFactor * 0.06 * (0.7 + 0.3 * Math.sin(t * 4));
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
