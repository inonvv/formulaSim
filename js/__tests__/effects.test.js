import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── DOM stub — canvas needed by _makePuffTexture in node environment ── */
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
  function ShaderMaterial(opts = {}) {
    this.uniforms        = opts.uniforms        || {};
    this.vertexShader    = opts.vertexShader    || '';
    this.fragmentShader  = opts.fragmentShader  || '';
    this.transparent     = opts.transparent     || false;
    this.blending        = opts.blending;
    this.depthWrite      = opts.depthWrite !== undefined ? opts.depthWrite : true;
    this.side            = opts.side;
    this.dispose = () => {};
  }

  function Color(hex) { this.hex = hex; }

  function CanvasTexture(source) {
    this.image = source || {};
    this.needsUpdate = false;
    this.wrapS = this.wrapT = 0;
    this.minFilter = this.magFilter = 0;
    this.dispose = () => {};
  }

  const NormalBlending   = 1;
  const AdditiveBlending = 2;
  const DoubleSide       = 2;
  const BackSide         = 1;
  const FrontSide        = 0;

  const MathUtils = { degToRad: d => d * Math.PI / 180 };

  return {
    Group, Mesh, Points, Line, LineSegments,
    BufferGeometry, BufferAttribute,
    PlaneGeometry, SphereGeometry,
    MeshStandardMaterial, MeshBasicMaterial,
    PointsMaterial, LineBasicMaterial, ShaderMaterial,
    Color, CanvasTexture,
    MathUtils,
    Vector3: Vec3, Euler,
    NormalBlending, AdditiveBlending, DoubleSide, BackSide, FrontSide,
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

  it('setBaseY lifts the group position.y so local coords land on ground plane', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow.group.position.y).toBe(0);
    airflow.setBaseY(0.283);
    expect(airflow.group.position.y).toBeCloseTo(0.283, 6);
  });

  it('setBaseY persists across setCarType', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setBaseY(0.42);
    airflow.setCarType('F2');
    expect(airflow.group.position.y).toBeCloseTo(0.42, 6);
  });
});

describe('AirflowEffect — smoke puff particles', () => {
  it('1. _guideLines is undefined — tube system removed', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._guideLines).toBeUndefined();
  });

  it('2. _smokePoints exists and is a THREE.Points instance', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._smokePoints).toBeDefined();
    expect(airflow._smokePoints.constructor.name).toBe('Points');
  });

  it('3. smoke PointsMaterial has map set and alphaTest >= 0', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    const mat = airflow._smokeMat;
    expect(mat.map).toBeDefined();
    expect(mat.alphaTest).toBeGreaterThanOrEqual(0);
  });

  it('4. _smokeLife Float32Array exists with length = seeds * SMOKE_PTS', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._smokeLife).toBeDefined();
    expect(airflow._smokeLife).toBeInstanceOf(Float32Array);
    expect(airflow._smokeLife.length).toBe(airflow._smokeJx.length);
  });

  it('5. SMOKE_PTS >= 120 (denser trails)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    const smokePts = airflow._smokeLife.length / airflow._seeds.length;
    expect(smokePts).toBeGreaterThanOrEqual(120);
  });

  it('6. material size grows with speedFactor', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setSpeed(350);
    airflow.setVisible(true);
    const sizeAt0 = airflow._smokeMat.size;
    airflow.update(0.016, 0);
    expect(airflow._smokeMat.size).toBeGreaterThan(sizeAt0 + 0.05);
  });

  it('7. _smokePoints has sizeAttenuation: true', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._smokeMat.sizeAttenuation).toBe(true);
  });

  it('8. smoke opacity rises with speed and is higher at 350 than at 0', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setVisible(true);

    airflow.setSpeed(0);
    airflow.update(0.016, 0);
    const opacityAt0 = airflow._smokeMat.opacity;

    airflow.setSpeed(350);
    airflow.update(0.016, 0);
    const opacityAt350 = airflow._smokeMat.opacity;

    expect(opacityAt350).toBeGreaterThan(opacityAt0);
    expect(opacityAt350).toBeGreaterThan(0.5);
  });
});

