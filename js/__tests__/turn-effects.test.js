/**
 * turn-effects.test.js — TDD for turn coupling in effects.js.
 *
 * During a turn (yaw rate ω, speed v) the car frame rotates:
 *   • Rain spray + rooster tails: REAL centrifugal accel a_lat = v·ω on the
 *     x velocity each frame (outward = +x on a left turn, ω > 0).
 *   • Droplet streaks: lateral drift + outward lean of the streak head.
 *   • Airflow ribbons: rigid apparent-rotation drift −ω·z (×6 legibility,
 *     see ribbonDrift in track-path.js) displacing vertices laterally.
 *   • ω = 0 ⇒ bit-identical behavior to no coupling (regression guard).
 */
import { describe, it, expect, vi } from 'vitest';

/* ── DOM stub (canvas for puff textures) ──────────────────────────── */
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0, height: 0,
          getContext() {
            return {
              createRadialGradient: () => ({ addColorStop: () => {} }),
              fillRect: () => {},
              set fillStyle(_v) {},
            };
          },
        };
      }
      return {};
    },
  };
}

/* ── Three.js mock (same shape as effects.test.js) ────────────────── */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };
  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  function Group() {
    this.name = ''; this.children = [];
    this.position = new Vec3(); this.rotation = new Euler(); this.visible = true;
  }
  Group.prototype.add      = function (...items) { this.children.push(...items); return this; };
  Group.prototype.remove   = function (item) { this.children = this.children.filter(c => c !== item); return this; };
  Group.prototype.traverse = function (fn) { fn(this); this.children.forEach(c => c?.traverse?.(fn)); };
  function Mesh(geo, mat) {
    this.name = ''; this.geometry = geo || {}; this.material = mat || {};
    this.position = new Vec3(); this.rotation = new Euler(); this.scale = new Vec3(1, 1, 1);
    this.castShadow = false; this.receiveShadow = false;
    this.children = []; this.visible = true; this.userData = {};
  }
  Mesh.prototype.add      = function (...items) { this.children.push(...items); return this; };
  Mesh.prototype.traverse = function (fn) { fn(this); this.children.forEach(c => c?.traverse?.(fn)); };
  function Points(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {}; this.children = []; this.visible = true;
  }
  Points.prototype.traverse = function (fn) { fn(this); };
  function Line(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {}; this.children = []; this.visible = true;
  }
  Line.prototype.traverse = function (fn) { fn(this); };
  function LineSegments(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {}; this.children = []; this.visible = true;
  }
  LineSegments.prototype.traverse = function (fn) { fn(this); };
  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }
  function BufferAttribute(array, itemSize) {
    this.array = array; this.itemSize = itemSize; this.needsUpdate = false;
  }
  function PlaneGeometry(w, h, segW, segH) {
    const count = ((segW || 1) + 1) * ((segH || 1) + 1);
    this.attributes = { position: { array: new Float32Array(count * 3), count, needsUpdate: false } };
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }
  function SphereGeometry() { this.attributes = {}; this.setAttribute = () => {}; this.dispose = () => {}; }
  function MeshStandardMaterial(o = {}) { Object.assign(this, o); this.dispose = () => {}; }
  function MeshBasicMaterial(o = {})    { Object.assign(this, o); this.dispose = () => {}; }
  function PointsMaterial(o = {})       { Object.assign(this, o); this.dispose = () => {}; }
  function LineBasicMaterial(o = {})    { Object.assign(this, o); this.dispose = () => {}; }
  function ShaderMaterial(o = {}) {
    this.uniforms = o.uniforms || {}; this.vertexShader = o.vertexShader || '';
    this.fragmentShader = o.fragmentShader || ''; this.transparent = o.transparent || false;
    this.blending = o.blending; this.depthWrite = o.depthWrite !== undefined ? o.depthWrite : true;
    this.side = o.side; this.dispose = () => {};
  }
  function Color(hex) { this.hex = hex; }
  function CanvasTexture(src) {
    this.image = src || {}; this.needsUpdate = false;
    this.wrapS = this.wrapT = 0; this.minFilter = this.magFilter = 0; this.dispose = () => {};
  }
  return {
    Group, Mesh, Points, Line, LineSegments,
    BufferGeometry, BufferAttribute, PlaneGeometry, SphereGeometry,
    MeshStandardMaterial, MeshBasicMaterial, PointsMaterial, LineBasicMaterial, ShaderMaterial,
    Color, CanvasTexture,
    MathUtils: { degToRad: d => d * Math.PI / 180 },
    Vector3: Vec3, Euler,
    NormalBlending: 1, AdditiveBlending: 2, DoubleSide: 2, BackSide: 1, FrontSide: 0,
  };
});

/* ── Mock airflow-core dependency ─────────────────────────────────── */
vi.mock('../airflow-core.js', () => ({
  topViewVelocity:     () => ({ vxi: 0, veta: 1 }),
  pressureCoeff:       () => 0,
  cpToColor:           () => ({ r: 0.5, g: 0.5, b: 0.5 }),
  vortexVelocity:      () => ({ vxi: 0.1, veta: 0.2 }),
  sideViewVelocity:    () => ({ veta: 1, vy: 0 }),
  sumVelocity:         (xi, eta, baseFn) => baseFn(xi, eta),
  venturiSpeedRatio:   cp => Math.sqrt(Math.max(0, 1 - cp)),
  traceStreamlinePath: (seedXi, seedEta) => {
    const path = [];
    for (let i = 0; i < 16; i++) {
      path.push({ xi: seedXi, eta: seedEta + i * 0.5, vxi: 0, veta: 1 });
    }
    return path;
  },
}));

function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

const OMEGA = 0.14;  // peak yaw rate (left turn)
const V     = 50;    // m/s
const A_LAT = V * OMEGA; // 7 m/s²

/* Park spray/rooster particles mid-flight so one update can't respawn them. */
function freezeRain(rain) {
  for (let i = 0; i < rain._sCount; i++) {
    rain._sprayLife[i] = 0.1;
    rain._sPos[i * 3 + 1] = 1.0;
    rain._sVels[i * 3] = 0;
    rain._sVels[i * 3 + 1] = 0;
  }
  for (let i = 0; i < rain._roosterCount; i++) {
    rain._roosterPos[i * 3 + 1] = 1.0;
    rain._roosterPos[i * 3 + 2] = 0.0;
    rain._roosterVels[i * 3] = 0;
    rain._roosterVels[i * 3 + 1] = 0;
  }
}

describe('RainEffect — turn coupling', () => {
  it('exposes setTurnState(omega, v)', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    expect(typeof rain.setTurnState).toBe('function');
  });

  it('spray x-velocity accumulates the real centrifugal accel v·ω·dt', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    rain.setVisible(true);
    rain.setSpeed(180);
    freezeRain(rain);
    rain.setTurnState(OMEGA, V);
    rain.update(0.01, 0);
    for (let i = 0; i < rain._sCount; i++) {
      expect(rain._sVels[i * 3]).toBeCloseTo(A_LAT * 0.01, 5);
    }
  });

  it('rooster-tail x-velocity accumulates v·ω·dt the same way', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    rain.setVisible(true);
    rain.setSpeed(180); // > 20 so rooster tails update
    freezeRain(rain);
    rain.setTurnState(OMEGA, V);
    rain.update(0.01, 0);
    for (let i = 0; i < rain._roosterCount; i++) {
      expect(rain._roosterVels[i * 3]).toBeCloseTo(A_LAT * 0.01, 5);
    }
  });

  it('droplet streak heads lean outward (+x for left turn) while turning', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    rain.setVisible(true);
    rain.setSpeed(180);
    rain.setTurnState(OMEGA, V);
    rain.update(0.01, 0);
    const dp = rain._dPos;
    for (let i = 0; i < rain._dCount; i++) {
      expect(dp[i * 6 + 3]).toBeGreaterThan(dp[i * 6]); // head.x > tail.x
    }
  });

  it('ω = 0 leaves x velocities and streak lean untouched (regression guard)', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    rain.setVisible(true);
    rain.setSpeed(180);
    freezeRain(rain);
    rain.setTurnState(0, V);
    rain.update(0.01, 0);
    for (let i = 0; i < rain._sCount; i++) expect(rain._sVels[i * 3]).toBe(0);
    const dp = rain._dPos;
    for (let i = 0; i < rain._dCount; i++) expect(dp[i * 6 + 3]).toBe(dp[i * 6]);
  });
});

describe('AirflowEffect — turn coupling (apparent-rotation ribbon drift)', () => {
  async function ribbonXDeltas(omega) {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setVisible(true);
    airflow.setSpeed(180);

    airflow.setTurnState(0, V);
    airflow.update(0.016, 0);
    const bases = airflow._ribbonLines.map(R => Float32Array.from(R.positions));

    airflow.setTurnState(omega, V);
    airflow.update(0.016, 0.016);

    const deltas = [];
    airflow._ribbonLines.forEach((R, r) => {
      const base = bases[r];
      for (let i = 0; i < base.length / 3; i++) {
        deltas.push({ dx: R.positions[i * 3] - base[i * 3], z: base[i * 3 + 2] });
      }
    });
    return deltas;
  }

  it('exposes setTurnState(omega, v)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    expect(typeof new AirflowEffect(makeScene()).setTurnState).toBe('function');
  });

  it('every vertex obeys the rigid apparent-rotation law dx = ribbonDrift(ω, z)·0.4', async () => {
    const { ribbonDrift } = await import('../track-path.js');
    const deltas = await ribbonXDeltas(OMEGA);
    expect(deltas.length).toBeGreaterThan(100);
    let sawFar = false;
    for (const d of deltas) {
      expect(d.dx).toBeCloseTo(ribbonDrift(OMEGA, d.z) * 0.4, 4);
      if (Math.abs(d.z) > 2) sawFar = true;
    }
    expect(sawFar).toBe(true); // far vertices exist ⇒ scaling with |z| exercised
  });

  it('ω = 0 produces zero drift (vertices identical across frames)', async () => {
    const deltas = await ribbonXDeltas(0);
    for (const d of deltas) expect(d.dx).toBe(0);
  });
});
