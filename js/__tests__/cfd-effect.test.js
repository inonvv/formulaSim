import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── Extended Three.js mock (reuses same structure as cars.test.js) ── */
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
    this.castShadow = false;
    this.visible = true;
  }
  Group.prototype.add      = function (...items) { this.children.push(...items); return this; };
  Group.prototype.remove   = function (item)     { this.children = this.children.filter(c => c !== item); return this; };
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
  function BoxGeometry() {}
  function CylinderGeometry() {}
  function ConeGeometry() {
    this.rotateX = function () { return this; };
    this.translate = function () { return this; };
    this.scale = function () { return this; };
  }
  function Vector2(x, y) { this.x = x; this.y = y; }
  function Shape(pts) {
    this.moveTo = function () { return this; };
    this.lineTo = function () { return this; };
    this.quadraticCurveTo = function () { return this; };
  }
  function ExtrudeGeometry(shape, opts) {
    this.translate = function () { return this; };
    this.rotateY   = function () { return this; };
  }

  function MeshStandardMaterial(opts = {}) { Object.assign(this, opts); this.dispose = () => {}; }
  function MeshBasicMaterial(opts = {})    { Object.assign(this, opts); this.dispose = () => {}; }
  function MeshPhysicalMaterial(opts = {}) { Object.assign(this, opts); this.dispose = () => {}; }
  function PointsMaterial(opts = {})       { Object.assign(this, opts); this.dispose = () => {}; }
  function LineBasicMaterial(opts = {})    { Object.assign(this, opts); this.dispose = () => {}; }
  function Color(v) { this.r = 0; this.g = 0; this.b = 0; this.setHex = () => this; }

  const AdditiveBlending = 2;
  const DoubleSide       = 2;
  const BackSide         = 1;

  const MathUtils = { degToRad: d => d * Math.PI / 180 };

  return {
    Group, Mesh, Points, Line,
    BufferGeometry, BufferAttribute,
    PlaneGeometry, SphereGeometry, BoxGeometry, CylinderGeometry, ConeGeometry,
    ExtrudeGeometry, Shape, Vector2,
    MeshStandardMaterial, MeshBasicMaterial, MeshPhysicalMaterial,
    PointsMaterial, LineBasicMaterial,
    Color, MathUtils,
    Vector3: Vec3, Euler,
    AdditiveBlending, DoubleSide, BackSide,
  };
});

/* ── Mock airflow-core dependency ─────────────────────────────────── */
vi.mock('../airflow-core.js', () => ({
  topViewVelocity:  (xi, eta) => ({ vxi: 0, veta: 1 }),
  pressureCoeff:    (vxi, veta) => 0,
  cpToColor:        (cp) => ({ r: 0.5, g: 0.5, b: 0.5 }),
  vortexVelocity:   () => ({ vxi: 0, veta: 0 }),
  sideViewVelocity: () => ({ veta: 1, vy: 0 }),
  traceStreamlinePath: () => [],
  applyWingStall:   (profile, isStalled = true) => isStalled ? { ...profile } : profile,
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
describe('CfdEffect', () => {
  it('constructor does not throw', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const scene = makeScene();
    expect(() => new CfdEffect(scene)).not.toThrow();
  });

  it('adds its group to the scene', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const scene = makeScene();
    const cfd = new CfdEffect(scene);
    expect(scene._objects).toContain(cfd.group);
  });

  it('setVisible(false) makes group invisible', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setVisible(false);
    expect(cfd.group.visible).toBe(false);
  });

  it('setVisible(true) makes group visible', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setVisible(false);
    cfd.setVisible(true);
    expect(cfd.group.visible).toBe(true);
  });

  it('setSpeed stores the speed value', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setSpeed(200);
    expect(cfd._speed).toBe(200);
  });

  it('setCarType("F2") does not throw', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    expect(() => cfd.setCarType('F2')).not.toThrow();
  });

  it('setCarType("GT") does not throw', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    expect(() => cfd.setCarType('GT')).not.toThrow();
  });

  it('dispose() removes group from scene', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const scene = makeScene();
    const cfd = new CfdEffect(scene);
    cfd.dispose();
    expect(scene._objects).not.toContain(cfd.group);
  });

  it('update() does not throw when visible', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setVisible(true);
    cfd.setSpeed(200);
    expect(() => cfd.update(0.016, 1.0)).not.toThrow();
  });

  it('update() does not throw when invisible', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setVisible(false);
    expect(() => cfd.update(0.016, 1.0)).not.toThrow();
  });

  it('setWingStall(true) does not throw', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    expect(() => cfd.setWingStall(true)).not.toThrow();
  });

  it('setWingStall(false) does not throw', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setWingStall(true);
    expect(() => cfd.setWingStall(false)).not.toThrow();
  });
});
