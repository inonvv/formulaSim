/**
 * vent-emitters.js — Sidepod / airbox / brake-duct / exhaust particle emitters.
 *
 * Consumes role-tagged anchors (`role: 'inlet' | 'outlet'`) produced by
 * `measureAnchors` in car-loader.js (and the synthesised PROCEDURAL_ANCHORS
 * in cars.js) and emits soft billboarded particles at those anchor positions.
 *
 *   Inlet:  particle is BORN ahead of the vent along +direction, converges on
 *           the anchor as its phase advances from 0 → 1, alpha = sin(π·p).
 *           Reads as smoke threading INTO the duct.
 *
 *   Outlet: particle is born AT the anchor, launched along +direction with
 *           speed (8 m/s + speedKmh × 0.05), linear alpha fade over 1.2 s.
 *           Reads as a warm exhaust plume jetting OUT.
 *
 * Capacity: VENT_CAP particles per emitter × up to 10 emitters per car.
 * All emitters share one THREE.Points cloud; inactive slots stay at origin
 * with alpha 0, so the GPU cost is fixed regardless of how many vents the
 * car has.
 *
 * Visibility is gated externally in main.js (`airflow || cfd` chip on).
 */

import * as THREE from 'three';

const VENT_CAP  = 40;    // particles per emitter
const N_VENTS   = 10;    // max emitters per car (matches manifest roster)
const INLET_APPROACH_M = 1.5;   // how far ahead of the vent a particle spawns

/* ── Inlet / outlet colour constants (additive billboards) ── */
const COLOR_INLET  = { r: 0x66 / 255, g: 0xcc / 255, b: 0xff / 255 };
const COLOR_OUTLET = { r: 0xdd / 255, g: 0xd6 / 255, b: 0xc0 / 255 };

/**
 * Build a soft radial-gradient texture used by the smoke/effects system.
 * Cached per module load.
 */
let _ventPuffTex = null;
function _makePuffTexture() {
  if (_ventPuffTex) return _ventPuffTex;
  if (typeof document === 'undefined' || !document.createElement) {
    _ventPuffTex = new THREE.CanvasTexture({});
    return _ventPuffTex;
  }
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.50, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  _ventPuffTex = new THREE.CanvasTexture(canvas);
  _ventPuffTex.needsUpdate = true;
  return _ventPuffTex;
}

export class VentEmitterSystem {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'ventEmitters';
    scene.add(this.group);

    this._visible = false;
    this._speed   = 0;
    this._baseY   = 0;
    this._time    = 0;

    // Emitter list (populated by setCarType). Each entry:
    //   { role, pos: {x,y,z}, dir: {x,y,z} (unit) }
    this._emitters = [];

    this._capacity = VENT_CAP * N_VENTS;
    this._buildGeometry();
    this.group.visible = false;
  }

  _buildGeometry() {
    const total = this._capacity;
    const positions = new Float32Array(total * 3);
    const colors    = new Float32Array(total * 3);

    this._pos     = positions;
    this._col     = colors;
    this._phase   = new Float32Array(total);   // inlet: 0..1 flight progress
    this._life    = new Float32Array(total);   // outlet: remaining time (s)
    this._vel     = new Float32Array(total * 3);   // outlet: velocity m/s
    this._emIdx   = new Int16Array(total);     // which emitter slot this particle belongs to
    this._alpha   = new Float32Array(total);

    for (let i = 0; i < total; i++) this._emIdx[i] = -1;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const mat = new THREE.PointsMaterial({
      size: 0.14,
      map: _makePuffTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });

    this._points = new THREE.Points(geo, mat);
    this._mat    = mat;
    this._geo    = geo;
    this.group.add(this._points);
  }

  /**
   * Rebuild emitter list from measure.anchors entries that carry a `role`.
   * Limits to the first N_VENTS such anchors to respect the particle budget.
   */
  setCarType(_type, measure) {
    const anchors = measure?.anchors ?? {};
    const emitters = [];
    for (const [key, a] of Object.entries(anchors)) {
      if (!a || !a.role) continue;
      if (!a.direction) continue;
      if (emitters.length >= N_VENTS) break;
      emitters.push({
        key,
        role: a.role,
        pos:  { x: a.x, y: a.y, z: a.z },
        dir:  { x: a.direction.x, y: a.direction.y, z: a.direction.z },
      });
    }
    this._emitters = emitters;

    // Initialise per-particle slots. Each particle is assigned an emitter
    // (round-robin within VENT_CAP of each), with a staggered phase so the
    // stream reads as continuous rather than pulsing.
    const n = emitters.length;
    for (let i = 0; i < this._capacity; i++) {
      if (n === 0) {
        this._emIdx[i] = -1;
        this._alpha[i] = 0;
        continue;
      }
      const emitterSlot = Math.floor(i / VENT_CAP);
      if (emitterSlot >= n) {
        this._emIdx[i] = -1;
        this._alpha[i] = 0;
        continue;
      }
      this._emIdx[i] = emitterSlot;
      this._phase[i] = (i % VENT_CAP) / VENT_CAP;      // 0..1 stagger
      this._life[i]  = Math.random() * 1.2;
      this._spawn(i, true);
    }
  }

  setBaseY(y) {
    this._baseY = y || 0;
    this.group.position.y = this._baseY;
  }

  setSpeed(speedKmh) { this._speed = Math.max(0, speedKmh || 0); }

  setVisible(v) {
    this._visible = !!v;
    this.group.visible = this._visible;
  }

  /**
   * Respawn particle i in its emitter's coordinate frame.
   * stagger=true means we keep whatever phase/life value was already set
   * (used during initial seeding to spread particles along the stream).
   */
  _spawn(i, stagger = false) {
    const ei = this._emIdx[i];
    if (ei < 0) return;
    const em = this._emitters[ei];
    if (!em) return;

    if (em.role === 'inlet') {
      if (!stagger) this._phase[i] = 0;
      this._writeInletPos(i);
      const color = COLOR_INLET;
      this._col[i * 3]     = color.r;
      this._col[i * 3 + 1] = color.g;
      this._col[i * 3 + 2] = color.b;
    } else {
      // outlet: spawn at anchor, velocity = dir × (8 + speedKmh × 0.05)
      if (!stagger) this._life[i] = 1.2;
      this._pos[i * 3]     = em.pos.x;
      this._pos[i * 3 + 1] = em.pos.y;
      this._pos[i * 3 + 2] = em.pos.z;
      const speedMag = 8 + this._speed * 0.05;
      this._vel[i * 3]     = em.dir.x * speedMag;
      this._vel[i * 3 + 1] = em.dir.y * speedMag;
      this._vel[i * 3 + 2] = em.dir.z * speedMag;
      const color = COLOR_OUTLET;
      this._col[i * 3]     = color.r;
      this._col[i * 3 + 1] = color.g;
      this._col[i * 3 + 2] = color.b;
    }
  }

  /** Given phase p ∈ [0,1], place the particle at anchor + dir·(1-p)·APPROACH. */
  _writeInletPos(i) {
    const em = this._emitters[this._emIdx[i]];
    if (!em) return;
    const p = this._phase[i];
    const s = (1 - p) * INLET_APPROACH_M;
    this._pos[i * 3]     = em.pos.x + em.dir.x * s;
    this._pos[i * 3 + 1] = em.pos.y + em.dir.y * s;
    this._pos[i * 3 + 2] = em.pos.z + em.dir.z * s;
  }

  update(dt) {
    if (!this._visible || this._emitters.length === 0) return;
    this._time += dt;

    for (let i = 0; i < this._capacity; i++) {
      const ei = this._emIdx[i];
      if (ei < 0) { this._alpha[i] = 0; continue; }
      const em = this._emitters[ei];
      if (!em) { this._alpha[i] = 0; continue; }

      if (em.role === 'inlet') {
        // Phase advances faster when the car is moving — inlets draw more
        // air at speed. Base rate keeps the stream visible at idle.
        const advance = dt * (0.6 + (this._speed / 350) * 1.2);
        this._phase[i] += advance;
        if (this._phase[i] >= 1) {
          this._phase[i] = 0;
          this._spawn(i);
        }
        this._writeInletPos(i);
        this._alpha[i] = Math.sin(this._phase[i] * Math.PI);
      } else {
        this._life[i] -= dt;
        if (this._life[i] <= 0) {
          this._spawn(i);
          continue;
        }
        this._pos[i * 3]     += this._vel[i * 3]     * dt;
        this._pos[i * 3 + 1] += this._vel[i * 3 + 1] * dt;
        this._pos[i * 3 + 2] += this._vel[i * 3 + 2] * dt;
        this._alpha[i] = this._life[i] / 1.2;   // linear fade
      }
    }

    // Modulate colour by alpha so the fade reads through an additive blend.
    for (let i = 0; i < this._capacity; i++) {
      const a = this._alpha[i];
      const ei = this._emIdx[i];
      if (ei < 0) {
        this._col[i * 3] = this._col[i * 3 + 1] = this._col[i * 3 + 2] = 0;
        continue;
      }
      const base = this._emitters[ei].role === 'inlet' ? COLOR_INLET : COLOR_OUTLET;
      this._col[i * 3]     = base.r * a;
      this._col[i * 3 + 1] = base.g * a;
      this._col[i * 3 + 2] = base.b * a;
    }

    if (this._geo.attributes.position)  this._geo.attributes.position.needsUpdate  = true;
    if (this._geo.attributes.color)     this._geo.attributes.color.needsUpdate     = true;
  }

  dispose() {
    this.scene.remove(this.group);
    this._geo?.dispose?.();
    this._mat?.dispose?.();
  }
}
