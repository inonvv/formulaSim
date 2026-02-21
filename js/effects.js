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

// Bright aerodynamic palette: electric blue (suction) → white (freestream) → warm yellow (stagnation)
function streamColor(cp) {
  const t = Math.max(0, Math.min(1, (cp + 3) / 4));
  return {
    r: 0.20 + 0.80 * t,   // 0.20 (blue) → 1.00 (warm white)
    g: 0.70 + 0.30 * t,   // 0.70 (cyan) → 1.00
    b: 1.00 - 0.55 * t,   // 1.00 (blue) → 0.45 (warm)
  };
}

/* ════════════════════════════════════════════════════════════════ */
/*  AIRFLOW EFFECT — potential-flow based, 3-D corrected            */
/* ════════════════════════════════════════════════════════════════ */

const STEPS     = 200;
const STEP_SIZE = 0.14;
const SMOKE_PTS  = 60;     // smoke-chain particles per streamline
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
    pressureBlobs: [
      { color:0xff2200, r:0.40, intensity:1.00, pos:[0, 0.12,-2.50] },
      { color:0x2266ff, r:0.50, intensity:0.90, pos:[0, 0.02,-2.60] },
      { color:0xff2200, r:0.36, intensity:0.70, pos:[0, 0.88, 1.85] },
      { color:0x2266ff, r:0.55, intensity:0.95, pos:[0, 0.75, 1.85] },
      { color:0x00ddff, r:0.80, intensity:0.90, pos:[0,-0.05, 0.00] },
      { color:0xff4400, r:0.30, intensity:0.70, pos:[ 0.85, 0.04,-1.60] },
      { color:0xff4400, r:0.30, intensity:0.70, pos:[-0.85, 0.04,-1.60] },
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
    pressureBlobs: [
      { color:0xff2200, r:0.38, intensity:0.85, pos:[0, 0.12,-2.35] },
      { color:0x2266ff, r:0.45, intensity:0.72, pos:[0, 0.02,-2.36] },
      { color:0xff2200, r:0.32, intensity:0.58, pos:[0, 0.79, 1.70] },
      { color:0x2266ff, r:0.48, intensity:0.76, pos:[0, 0.68, 1.70] },
      { color:0x00ddff, r:0.65, intensity:0.65, pos:[0,-0.04, 0.00] },
      { color:0xff4400, r:0.26, intensity:0.55, pos:[ 0.76, 0.04,-1.45] },
      { color:0xff4400, r:0.26, intensity:0.55, pos:[-0.76, 0.04,-1.45] },
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
    pressureBlobs: [
      { color:0xff2200, r:0.32, intensity:0.68, pos:[0, 0.11,-2.10] },
      { color:0x2266ff, r:0.35, intensity:0.48, pos:[0, 0.02,-2.12] },
      { color:0x2266ff, r:0.42, intensity:0.55, pos:[0, 0.65, 1.55] },
      { color:0x00ddff, r:0.45, intensity:0.35, pos:[0,-0.03, 0.00] },
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
    pressureBlobs: [
      { color:0xff2200, r:0.55, intensity:0.85, pos:[ 0.00, 0.25,-2.26] },
      { color:0x2266ff, r:0.45, intensity:0.55, pos:[ 0.00, 0.10,-2.30] },
      { color:0xff2200, r:0.40, intensity:0.60, pos:[ 0.00, 0.75, 1.80] },
      { color:0x2266ff, r:0.50, intensity:0.65, pos:[ 0.00, 0.60, 1.80] },
      { color:0x4488ff, r:0.50, intensity:0.55, pos:[ 0.85, 0.28, 0.00] },
      { color:0x4488ff, r:0.50, intensity:0.55, pos:[-0.85, 0.28, 0.00] },
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
  return seeds;
}

export class AirflowEffect {
  constructor(scene) {
    this.scene   = scene;
    this.group   = new THREE.Group();
    this.group.name = 'airflow';
    scene.add(this.group);

    this._speed   = 0;
    this._visible = false;
    this._type    = 'F1';
    this._time    = 0;

    this._build(getProfile('F1'));
    this.group.visible = false;
  }

  setCarType(type) {
    if (this._type === type) return;
    this._type = type;
    this._disposeAll();
    this._build(getProfile(type));
    this.group.visible = this._visible;
  }

  _disposeAll() {
    for (const child of [...this.group.children]) {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material?.dispose();
      this.group.remove(child);
    }
  }

  _build(profile) {
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
    this._buildSmokeGuides();
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

  /* ── Stream lines — pressure-colored flow skeleton ── */
  _buildSmokeGuides() {
    this._guideLines = [];

    for (let s = 0; s < this._seeds.length; s++) {
      const path = this._paths[s];
      const y0   = this._seeds[s].y;
      if (path.length < 2) { this._guideLines.push(null); continue; }

      const positions = new Float32Array(path.length * 3);
      const colors    = new Float32Array(path.length * 3);

      let yAcc = 0;
      for (let i = 0; i < path.length; i++) {
        const { xi, eta, vxi, veta } = path[i];
        const dy = this._verticalDelta(eta, y0 + yAcc);
        yAcc += dy;
        const w = this._toWorld(xi, eta, y0 + yAcc);
        positions[i * 3]     = w.x;
        positions[i * 3 + 1] = w.y;
        positions[i * 3 + 2] = w.z;
        const c = streamColor(pressureCoeff(vxi, veta));
        colors[i * 3]     = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

      const line = new THREE.Line(geo, mat);
      this.group.add(line);
      this._guideLines.push({ line, mat });
    }
  }

  /* ── Smoke particles — dense chains forming continuous smoke threads ── */
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

    let idx = 0;
    for (let s = 0; s < this._seeds.length; s++) {
      const pathLen = this._paths[s].length;
      for (let k = 0; k < SMOKE_PTS; k++) {
        this._smokeSeedIdx[idx] = s;
        this._smokeT[idx]       = (k / SMOKE_PTS) * (pathLen - 1);
        idx++;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const mat = new THREE.PointsMaterial({
      size: 0.10,
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

    /* ── Guide line opacity ── */
    for (const gl of this._guideLines) {
      if (gl) gl.mat.opacity = speedFactor * 0.55;
    }

    /* ── Smoke particles — dense chains ── */
    const advRate = speedFactor * 9.0;
    const jBase   = 0.006 * speedFactor;
    const jDecay  = 0.90;
    const sPos    = this._smokePos;
    const sCol    = this._smokeColors;

    for (let i = 0; i < this._smokeT.length; i++) {
      const s    = this._smokeSeedIdx[i];
      const path = this._paths[s];
      if (!path || path.length < 2) continue;

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
      this._smokeJx[i] = this._smokeJx[i] * jDecay + (Math.random() * 2 - 1) * jitterAmp;
      this._smokeJy[i] = this._smokeJy[i] * jDecay + (Math.random() * 2 - 1) * jitterAmp * 0.4;
      this._smokeJz[i] = this._smokeJz[i] * jDecay + (Math.random() * 2 - 1) * jitterAmp;

      const w = this._toWorld(xi, eta, y0 + this._smokeYAcc[i]);
      sPos[i * 3]     = w.x + this._smokeJx[i];
      sPos[i * 3 + 1] = w.y + this._smokeJy[i];
      sPos[i * 3 + 2] = w.z + this._smokeJz[i];

      const cp = pressureCoeff(vxi, veta);
      const c  = streamColor(cp);
      sCol[i * 3]     = c.r;
      sCol[i * 3 + 1] = c.g;
      sCol[i * 3 + 2] = c.b;
    }

    this._smokePoints.geometry.attributes.position.needsUpdate = true;
    this._smokePoints.geometry.attributes.color.needsUpdate    = true;
    this._smokeMat.opacity = speedFactor * 0.88;

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
export class RainEffect {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'rain';
    scene.add(this.group);

    this._speed = 0;
    this._visible = false;

    this._buildDroplets();
    this._buildSpray();
    this._buildWetGround();
    this.group.visible = false;
  }

  _buildDroplets() {
    const COUNT = 1200;
    const positions = new Float32Array(COUNT * 3);
    const vels      = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3]     = rnd(-5, 5);
      positions[i * 3 + 1] = rnd(0.5, 8);
      positions[i * 3 + 2] = rnd(-6, 6);
      vels[i] = rnd(4, 9);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x88ccff,
      size: 0.035,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.droplets = new THREE.Points(geo, mat);
    this.group.add(this.droplets);

    this._dPos  = positions;
    this._dVels = vels;
    this._dCount = COUNT;
    this._dMat = mat;
  }

  _buildSpray() {
    const COUNT = 300;
    const positions = new Float32Array(COUNT * 3);
    const vels      = new Float32Array(COUNT * 3);

    const spawnSpray = (i) => {
      const side = i % 2 === 0 ? -0.73 : 0.73;
      positions[i * 3]     = side + rnd(-0.1, 0.1);
      positions[i * 3 + 1] = 0.25;
      positions[i * 3 + 2] = 1.5 + rnd(-0.1, 0.1);
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

  _buildWetGround() {
    const geo = new THREE.PlaneGeometry(3.0, 7.0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x224466,
      roughness: 0.05,
      metalness: 0.9,
      transparent: true,
      opacity: 0,
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.33;
    plane.receiveShadow = true;
    this.group.add(plane);
    this._wetMat = mat;
  }

  setSpeed(speed) { this._speed = speed; }

  setVisible(v) {
    this._visible = v;
    this.group.visible = v;
  }

  update(dt, _t) {
    if (!this._visible) return;

    const speedFactor = Math.min(this._speed / 350, 1);
    const windTilt = speedFactor * 1.5;

    const dp = this._dPos;
    for (let i = 0; i < this._dCount; i++) {
      dp[i * 3 + 1] -= dt * this._dVels[i];
      dp[i * 3 + 2] += dt * windTilt;
      if (dp[i * 3 + 1] < -0.35) {
        dp[i * 3 + 1] = 8;
        dp[i * 3]     = rnd(-5, 5);
        dp[i * 3 + 2] = rnd(-6, 6);
      }
    }
    this.droplets.geometry.attributes.position.needsUpdate = true;

    const sp = this._sPos, sv = this._sVels;
    for (let i = 0; i < this._sCount; i++) {
      this._sprayLife[i] += dt * 2.0;
      sp[i * 3]     += sv[i * 3]     * dt;
      sp[i * 3 + 1] += sv[i * 3 + 1] * dt - 4.9 * dt * dt;
      sp[i * 3 + 2] += sv[i * 3 + 2] * dt * (1 + speedFactor);

      if (this._sprayLife[i] > 1 || sp[i * 3 + 1] < -0.3) {
        this._sprayLife[i] = 0;
        this._spawnSpray(i);
      }
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
    this._sMat.opacity = speedFactor * 0.65;
    this._sMat.size    = 0.04 + 0.07 * speedFactor;

    this._wetMat.opacity = 0.3 + 0.4 * speedFactor;
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
    this._shimMat.opacity = 0.25 + 0.35 * Math.abs(Math.sin(t * 0.5));

    this._hazeMat.opacity = speedFactor * 0.06 * (0.7 + 0.3 * Math.sin(t * 4));
  }

  dispose() {
    this.scene.remove(this.group);
  }
}
