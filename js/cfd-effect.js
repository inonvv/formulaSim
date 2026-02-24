/**
 * cfd-effect.js — CFD Pressure-Coefficient Visualisation
 *
 * Paints pressure-coefficient colour maps on the car body surface using:
 *   • Surface patches  — PlaneGeometry with per-vertex Cp colouring
 *   • Zone blobs       — Sphere meshes at key stagnation / suction points
 *   • Vortex cores     — Spiral line traces at leading-edge and diffuser exits
 *
 * Interface mirrors AirflowEffect: constructor(scene), setCarType(type),
 * setSpeed(v), setVisible(v), update(dt, t), dispose(), setWingStall(isStalled).
 */

import * as THREE from 'three';
import { topViewVelocity, pressureCoeff, cpToColor, applyWingStall } from './airflow-core.js';

/* ── Helpers ──────────────────────────────────────────────────────── */
function rnd(a, b) { return a + Math.random() * (b - a); }

/* ── Per-car CFD patch definitions ──────────────────────────────────
 * Each patch: { w, h, cx, cy, cz, nx, ny, nz, rx, ry, rz }
 *   (cx,cy,cz) = world centre  (rx,ry,rz) = Euler rotation of patch plane
 * ------------------------------------------------------------------ */
const CFD_PATCHES = {
  F1: [
    // Front wing stagnation plane (horizontal, in front of nose)
    { w: 1.74, h: 0.34, cx: 0, cy: 0.020, cz: -2.72, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'frontWing' },
    // Sidepod inlet — left
    { w: 0.065, h: 0.32, cx: -0.528, cy: 0.22, cz: -0.64, rx: 0, ry: Math.PI / 2, rz: 0, role: 'sidepodInlet' },
    // Sidepod inlet — right
    { w: 0.065, h: 0.32, cx:  0.528, cy: 0.22, cz: -0.64, rx: 0, ry: -Math.PI / 2, rz: 0, role: 'sidepodInlet' },
    // Engine cover top
    { w: 0.50, h: 1.15, cx: 0, cy: 0.57, cz: 1.38, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'engineCover' },
    // Diffuser suction underside
    { w: 1.14, h: 1.00, cx: 0, cy: -0.05, cz: 1.93, rx:  Math.PI / 2, ry: 0, rz: 0.28, role: 'diffuser' },
    // Rear wing main plane
    { w: 1.92, h: 0.36, cx: 0, cy: 0.98, cz: 1.95, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'rearWing' },
  ],
  F2: [
    { w: 1.74, h: 0.30, cx: 0, cy: 0.022, cz: -2.48, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'frontWing' },
    { w: 0.055, h: 0.272, cx: -0.449, cy: 0.19, cz: -0.55, rx: 0, ry: Math.PI / 2, rz: 0, role: 'sidepodInlet' },
    { w: 0.055, h: 0.272, cx:  0.449, cy: 0.19, cz: -0.55, rx: 0, ry: -Math.PI / 2, rz: 0, role: 'sidepodInlet' },
    { w: 0.48, h: 1.00, cx: 0, cy: 0.51, cz: 1.30, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'engineCover' },
    { w: 1.00, h: 0.88, cx: 0, cy: -0.04, cz: 1.80, rx: Math.PI / 2, ry: 0, rz: 0.24, role: 'diffuser' },
    { w: 1.74, h: 0.30, cx: 0, cy: 0.90, cz: 1.80, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'rearWing' },
  ],
  F3: [
    { w: 1.46, h: 0.24, cx: 0, cy: 0.020, cz: -2.24, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'frontWing' },
    { w: 0.88, h: 0.76, cx: 0, cy: -0.04, cz: 1.68, rx: Math.PI / 2, ry: 0, rz: 0.22, role: 'diffuser' },
    { w: 1.56, h: 0.26, cx: 0, cy: 0.82, cz: 1.68, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'rearWing' },
  ],
  GT: [
    { w: 1.76, h: 0.42, cx: 0, cy: 0.84, cz: 1.92, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'rearWing' },
    { w: 1.84, h: 0.40, cx: 0, cy: 0.00, cz: -2.32, rx: -Math.PI / 2, ry: 0, rz: 0, role: 'frontBumper' },
    { w: 1.10, h: 0.78, cx: 0, cy: -0.10, cz: 2.14, rx: Math.PI / 2, ry: 0, rz: 0.30, role: 'diffuser' },
  ],
};

/* ── Zone blob definitions ──────────────────────────────────────────
 * role: 'stagnation' (red), 'suction' (blue), 'sidepodInlet',
 *        'diffuser' (blue), 'rearWing'
 * ------------------------------------------------------------------ */
const ZONE_BLOBS = {
  F1: [
    { role: 'stagnation', color: 0xff2200, r: 0.28, intensity: 1.0,  phase: 0.0,  pos: [0, 0.12, -2.72] },
    { role: 'suction',    color: 0x2266ff, r: 0.40, intensity: 0.9,  phase: 1.1,  pos: [0, 0.02, -2.65] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.22, intensity: 0.7, phase: 0.5, pos: [-0.528, 0.22, -0.64] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.22, intensity: 0.7, phase: 0.5, pos: [ 0.528, 0.22, -0.64] },
    { role: 'diffuser',   color: 0x0088ff, r: 0.55, intensity: 0.9,  phase: 2.2,  pos: [0, -0.04, 1.93] },
    { role: 'rearWing',   color: 0xff2200, r: 0.30, intensity: 0.7,  phase: 0.8,  pos: [0, 0.98, 1.95] },
  ],
  F2: [
    { role: 'stagnation', color: 0xff2200, r: 0.24, intensity: 0.85, phase: 0.0, pos: [0, 0.12, -2.48] },
    { role: 'suction',    color: 0x2266ff, r: 0.35, intensity: 0.72, phase: 1.1, pos: [0, 0.02, -2.40] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.18, intensity: 0.6, phase: 0.5, pos: [-0.449, 0.19, -0.55] },
    { role: 'sidepodInlet', color: 0xff4400, r: 0.18, intensity: 0.6, phase: 0.5, pos: [ 0.449, 0.19, -0.55] },
    { role: 'diffuser',   color: 0x0088ff, r: 0.45, intensity: 0.76, phase: 2.2, pos: [0, -0.04, 1.80] },
    { role: 'rearWing',   color: 0xff2200, r: 0.26, intensity: 0.58, phase: 0.8, pos: [0, 0.90, 1.80] },
  ],
  F3: [
    { role: 'stagnation', color: 0xff2200, r: 0.20, intensity: 0.68, phase: 0.0, pos: [0, 0.10, -2.24] },
    { role: 'diffuser',   color: 0x0088ff, r: 0.38, intensity: 0.55, phase: 2.2, pos: [0, -0.04, 1.68] },
    { role: 'rearWing',   color: 0xff2200, r: 0.22, intensity: 0.55, phase: 0.8, pos: [0, 0.82, 1.68] },
  ],
  GT: [
    { role: 'stagnation', color: 0xff2200, r: 0.40, intensity: 0.85, phase: 0.0, pos: [0, 0.08, -2.32] },
    { role: 'diffuser',   color: 0x0088ff, r: 0.50, intensity: 0.65, phase: 2.2, pos: [0, -0.10, 2.14] },
    { role: 'rearWing',   color: 0xff2200, r: 0.35, intensity: 0.60, phase: 0.8, pos: [0, 0.84, 1.92] },
  ],
};

/* ── Vortex core defs (diffuser strake exits) ─────────────────────── */
const VORTEX_CORES = {
  F1: [
    { x: -0.48, y: -0.04, z: 1.93, sign:  1 },
    { x:  0.48, y: -0.04, z: 1.93, sign: -1 },
  ],
  F2: [
    { x: -0.40, y: -0.04, z: 1.80, sign:  1 },
    { x:  0.40, y: -0.04, z: 1.80, sign: -1 },
  ],
  F3: [
    { x: -0.32, y: -0.04, z: 1.68, sign:  1 },
    { x:  0.32, y: -0.04, z: 1.68, sign: -1 },
  ],
  GT: [
    { x: -0.44, y: -0.10, z: 2.14, sign:  1 },
    { x:  0.44, y: -0.10, z: 2.14, sign: -1 },
  ],
};

const VORTEX_PTS = 60;

/* ════════════════════════════════════════════════════════════════════
   CfdEffect class
════════════════════════════════════════════════════════════════════ */
export class CfdEffect {
  constructor(scene) {
    this.scene   = scene;
    this.group   = new THREE.Group();
    this.group.name = 'cfd';
    scene.add(this.group);

    this._speed       = 0;
    this._visible     = false;
    this._type        = 'F1';
    this._wingStalled = false;
    this._speedDirty  = true;
    this._lastBuiltSpeed = -1;

    this._patchMeshes   = [];
    this._blobMeshes    = [];
    this._vortexLines   = [];

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
    this._speed = speed;
    this._speedDirty = true;
  }

  setVisible(v) {
    this._visible = v;
    this.group.visible = v;
  }

  setWingStall(isStalled) {
    this._wingStalled = isStalled;
    // Force colour refresh on next update
    this._lastBuiltSpeed = -1;
    this._speedDirty = true;
  }

  update(dt, t) {
    if (!this._visible) return;

    const speedFactor = Math.min(this._speed / 350, 1);

    // Refresh vertex colours only when speed changes meaningfully (dirty flag)
    if (this._speedDirty && Math.abs(this._speed - this._lastBuiltSpeed) > 5) {
      this._updatePatchColors(speedFactor);
      this._lastBuiltSpeed = this._speed;
      this._speedDirty = false;
    }

    // Animate zone blobs: scale + pulse opacity
    const blobs = ZONE_BLOBS[this._type] || ZONE_BLOBS.F1;
    for (let i = 0; i < this._blobMeshes.length; i++) {
      const blob = blobs[i];
      if (!blob || !this._blobMeshes[i]) continue;
      const blobMesh = this._blobMeshes[i];

      // Stall: rear-wing blobs become faint and large
      let effectiveIntensity = blob.intensity;
      let effectiveR         = blob.r;
      if (this._wingStalled && blob.role === 'rearWing') {
        effectiveIntensity = blob.intensity * 0.15;
        effectiveR         = blob.r * 2.2;
      }

      const s = speedFactor * speedFactor * effectiveIntensity * 0.25;
      blobMesh.scale.setScalar(s * (0.8 + 0.2 * Math.sin(t * 2 + blob.phase)));
      blobMesh.material.opacity = speedFactor * effectiveIntensity * 0.55
        * (0.75 + 0.25 * Math.sin(t * 2 + blob.phase));
    }

    // Animate vortex core spirals
    const vDefs = VORTEX_CORES[this._type] || VORTEX_CORES.F1;
    for (let vi = 0; vi < this._vortexLines.length; vi++) {
      const def = vDefs[vi];
      if (!def) continue;
      const { geo, mat } = this._vortexLines[vi];
      const pos = geo.attributes.position.array;
      const r   = speedFactor * 0.28;

      for (let pi = 0; pi < VORTEX_PTS; pi++) {
        const frac  = pi / VORTEX_PTS;
        const angle = frac * Math.PI * 6 * def.sign + t * 1.2;
        pos[pi * 3]     = def.x + Math.cos(angle) * r * (1 - frac * 0.5);
        pos[pi * 3 + 1] = def.y + Math.sin(angle) * r * 0.5 * (1 - frac);
        pos[pi * 3 + 2] = def.z + frac * 1.6;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = speedFactor * 0.65;
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
  }

  _build(type) {
    this._buildPatches(type);
    this._buildBlobs(type);
    this._buildVortexCores(type);
  }

  /* ── Surface pressure patches with per-vertex Cp colour ──────── */
  _buildPatches(type) {
    const patches = CFD_PATCHES[type] || CFD_PATCHES.F1;
    const SEG = 8; // subdivisions per patch axis

    for (const p of patches) {
      const geo = new THREE.PlaneGeometry(p.w, p.h, SEG, SEG);
      const count = geo.attributes.position.count;
      const colors = new Float32Array(count * 3);

      // Initialise with freestream colour (Cp≈0, green)
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
        opacity:      0.55,
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

  /* ── Pressure Cp colour per patch vertex ────────────────────────
   * For each vertex we get (xi, eta) in patch-local normalised coords
   * → topViewVelocity → pressureCoeff → cpToColor
   * ---------------------------------------------------------------- */
  _updatePatchColors(speedFactor) {
    const patches = CFD_PATCHES[this._type] || CFD_PATCHES.F1;
    const SEG = 8;

    for (let pi = 0; pi < this._patchMeshes.length; pi++) {
      const m   = this._patchMeshes[pi];
      const p   = patches[pi];
      if (!m || !p) continue;

      const pos    = m.geometry.attributes.position.array;
      const colors = m.geometry.attributes.color.array;
      const count  = m.geometry.attributes.position.count;

      // Half-extents in patch local coords
      const hw = p.w / 2;
      const hh = p.h / 2;

      // Stalled rear-wing patch → flat near-zero Cp
      const isRearStalled = this._wingStalled && p.role === 'rearWing';

      for (let vi = 0; vi < count; vi++) {
        const lx = pos[vi * 3];     // local x on patch (−hw … +hw)
        const ly = pos[vi * 3 + 1]; // local y on patch (−hh … +hh)

        let cp;
        if (isRearStalled) {
          cp = 0 + rnd(-0.05, 0.05); // turbulent, near-zero Cp
        } else {
          // Map patch coords to potential-flow (xi, eta)
          const xi  = hw > 0 ? lx / hw : 0;
          const eta = hh > 0 ? ly / hh : 0;
          // Scale by speed: at low speed Cp field is weak
          const { vxi, veta } = topViewVelocity(xi * 1.2 + 0.01, eta * 1.2 + 0.01);
          cp = pressureCoeff(vxi * speedFactor, veta * speedFactor) - (1 - speedFactor);
        }

        const c = cpToColor(cp);
        colors[vi * 3]     = c.r;
        colors[vi * 3 + 1] = c.g;
        colors[vi * 3 + 2] = c.b;
      }

      m.geometry.attributes.color.needsUpdate = true;
      m.material.opacity = speedFactor * 0.55;
    }
  }

  /* ── Zone blobs ───────────────────────────────────────────────── */
  _buildBlobs(type) {
    const blobs = ZONE_BLOBS[type] || ZONE_BLOBS.F1;
    for (const blob of blobs) {
      const geo = new THREE.SphereGeometry(blob.r, 12, 10);
      const mat = new THREE.MeshBasicMaterial({
        color:      blob.color,
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
}
