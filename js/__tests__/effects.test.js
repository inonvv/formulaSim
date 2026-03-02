import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── Three.js mock ────────────────────────────────────────────────── */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };

  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };

  function Group() {
    this.name = '';
    this.children = [];
    this.position = new Vec3();
    this.rotation = new Euler();
    this.visible = true;
  }
  Group.prototype.add    = function (...items) { this.children.push(...items); return this; };
  Group.prototype.remove = function (item)     { this.children = this.children.filter(c => c !== item); return this; };
  Group.prototype.traverse = function (fn) {
    fn(this);
    this.children.forEach(c => { if (c && c.traverse) c.traverse(fn); });
  };

  function Mesh(geo, mat) {
    this.name = '';
    this.geometry = geo || {};
    this.material = mat || {};
    this.position = new Vec3();
    this.rotation = new Euler();
    this.scale    = new Vec3(1, 1, 1);
    this.castShadow = false;
    this.receiveShadow = false;
    this.children = [];
    this.visible  = true;
    this.userData = {};
  }
  Mesh.prototype.add      = function (...items) { this.children.push(...items); return this; };
  Mesh.prototype.traverse = function (fn) {
    fn(this);
    this.children.forEach(c => { if (c && c.traverse) c.traverse(fn); });
  };

  function Points(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {};
    this.children = [];
    this.visible  = true;
  }
  Points.prototype.traverse = function (fn) { fn(this); };

  function Line(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {};
    this.children = [];
    this.visible  = true;
  }
  Line.prototype.traverse = function (fn) { fn(this); };

  function LineSegments(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {};
    this.children = [];
    this.visible  = true;
  }
  LineSegments.prototype.traverse = function (fn) { fn(this); };

  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }

  function BufferAttribute(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.needsUpdate = false;
  }

  function PlaneGeometry(w, h, segW, segH) {
    const sw = segW || 1;
    const sh = segH || 1;
    const count = (sw + 1) * (sh + 1);
    const posArray = new Float32Array(count * 3);
    this.attributes = {
      position: { array: posArray, count, needsUpdate: false },
    };
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }

  function SphereGeometry() {
    this.attributes = {};
    this.setAttribute = function () {};
    this.dispose = function () {};
  }

  function MeshStandardMaterial(opts = {}) { Object.assign(this, opts); this.dispose = () => {}; }
  function MeshBasicMaterial(opts = {})    { Object.assign(this, opts); this.dispose = () => {}; }
  function PointsMaterial(opts = {})       { Object.assign(this, opts); this.dispose = () => {}; }
  function LineBasicMaterial(opts = {})    { Object.assign(this, opts); this.dispose = () => {}; }

  const AdditiveBlending = 2;
  const DoubleSide       = 2;
  const BackSide         = 1;

  const MathUtils = { degToRad: d => d * Math.PI / 180 };

  return {
    Group, Mesh, Points, Line, LineSegments,
    BufferGeometry, BufferAttribute,
    PlaneGeometry, SphereGeometry,
    MeshStandardMaterial, MeshBasicMaterial,
    PointsMaterial, LineBasicMaterial,
    MathUtils,
    Vector3: Vec3, Euler,
    AdditiveBlending, DoubleSide, BackSide,
  };
});

/* ── Mock airflow-core dependency ─────────────────────────────────── */
vi.mock('../airflow-core.js', () => ({
  topViewVelocity:     () => ({ vxi: 0, veta: 1 }),
  pressureCoeff:       () => 0,
  cpToColor:           () => ({ r: 0.5, g: 0.5, b: 0.5 }),
  vortexVelocity:      () => ({ vxi: 0.1, veta: 0.2 }),
  sideViewVelocity:    () => ({ veta: 1, vy: 0 }),
  traceStreamlinePath: () => [{ xi: 0, eta: -8, vxi: 0, veta: 1 }],
  applyWingStall:      (p) => ({ ...p }),
}));

/* ── Scene stub ───────────────────────────────────────────────────── */
function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

/* ── Tests ────────────────────────────────────────────────────────── */
describe('RainEffect', () => {
  it('constructs without throwing', async () => {
    const { RainEffect } = await import('../effects.js');
    const scene = makeScene();
    expect(() => new RainEffect(scene)).not.toThrow();
  });

  it('spray particle count > 0', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    expect(rain._sCount).toBeGreaterThan(0);
  });

  it('droplet vels are in range [6, 14]', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    for (const v of rain._dVels) {
      expect(v).toBeGreaterThanOrEqual(6);
      expect(v).toBeLessThanOrEqual(14);
    }
  });

  it('roosterCount > 0 after construction', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    expect(rain._roosterCount).toBeGreaterThan(0);
  });
});

describe('AirflowEffect', () => {
  it('_smokeJx/y/z all exist with equal length > 0', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._smokeJx).toBeDefined();
    expect(airflow._smokeJy).toBeDefined();
    expect(airflow._smokeJz).toBeDefined();
    expect(airflow._smokeJx.length).toBeGreaterThan(0);
    expect(airflow._smokeJx.length).toBe(airflow._smokeJy.length);
    expect(airflow._smokeJy.length).toBe(airflow._smokeJz.length);
  });
});
