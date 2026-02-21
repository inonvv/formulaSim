import { describe, it, expect, vi, beforeAll } from 'vitest';

/* ── Mock three ────────────────────────────────────────────────── */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };

  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };

  function Group() {
    this.name = '';
    this.children = [];
    this.position = new Vec3();
    this.rotation = new Euler();
    this.castShadow = false;
  }
  Group.prototype.add = function (...items) { this.children.push(...items); return this; };
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
    this.castShadow = false;
    this.receiveShadow = false;
    this.children = [];
  }
  Mesh.prototype.add = function (...items) { this.children.push(...items); return this; };
  Mesh.prototype.traverse = function (fn) {
    fn(this);
    this.children.forEach(c => { if (c && c.traverse) c.traverse(fn); });
  };

  function BoxGeometry() {}
  function CylinderGeometry() {}
  function SphereGeometry() {}
  function ConeGeometry() {
    this.rotateX = function () { return this; };
    this.translate = function () { return this; };
    this.scale = function () { return this; };
  }
  function PlaneGeometry() {}

  // New geometry types used by rBox / wingGeo / noseTip helpers
  function Vector2(x, y) { this.x = x; this.y = y; }
  function Shape(pts) {
    this.moveTo = function () { return this; };
    this.lineTo = function () { return this; };
    this.quadraticCurveTo = function () { return this; };
  }
  function ExtrudeGeometry(shape, opts) {
    this.translate = function () { return this; };
    this.rotateY  = function () { return this; };
  }

  function MeshStandardMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshBasicMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshPhysicalMaterial(opts = {}) { Object.assign(this, opts); }
  function Color(v) { this.r = 0; this.g = 0; this.b = 0; }

  return {
    Group,
    Mesh,
    BoxGeometry,
    CylinderGeometry,
    SphereGeometry,
    ConeGeometry,
    PlaneGeometry,
    ExtrudeGeometry,
    Shape,
    Vector2,
    MeshStandardMaterial,
    MeshBasicMaterial,
    MeshPhysicalMaterial,
    Color,
    Vector3: Vec3,
    Euler,
  };
});

/* ── Tests ─────────────────────────────────────────────────────── */
describe('getCarMeta', () => {
  it('returns correct label for F1', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('F1').label).toBe('Formula One');
  });

  it('returns correct label for F2', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('F2').label).toBe('Formula Two');
  });

  it('returns correct label for F3', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('F3').label).toBe('Formula Three');
  });

  it('returns correct label for GT', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('GT').label).toBe('GT Race Car');
  });

  it('falls back to F1 for unknown type', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('UNKNOWN').label).toBe('Formula One');
  });

  it('falls back to F1 for empty string', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('').label).toBe('Formula One');
  });
});

describe('WHEEL_NAMES', () => {
  it('contains exactly 4 items', async () => {
    const { WHEEL_NAMES } = await import('../cars.js');
    expect(WHEEL_NAMES).toHaveLength(4);
  });

  it('contains wFL, wFR, wRL, wRR', async () => {
    const { WHEEL_NAMES } = await import('../cars.js');
    expect(WHEEL_NAMES).toContain('wFL');
    expect(WHEEL_NAMES).toContain('wFR');
    expect(WHEEL_NAMES).toContain('wRL');
    expect(WHEEL_NAMES).toContain('wRR');
  });
});

describe('buildCar', () => {
  it('buildCar("F1").name === "car"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F1');
    expect(car.name).toBe('car');
  });

  it('buildCar("F2") does not throw and has name "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect(() => buildCar('F2')).not.toThrow();
    expect(buildCar('F2').name).toBe('car');
  });

  it('buildCar("F3") does not throw and has name "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect(() => buildCar('F3')).not.toThrow();
    expect(buildCar('F3').name).toBe('car');
  });

  it('buildCar("GT") does not throw and has name "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect(() => buildCar('GT')).not.toThrow();
    expect(buildCar('GT').name).toBe('car');
  });

  it('buildCar with unknown type falls back to F1 silently', async () => {
    const { buildCar } = await import('../cars.js');
    expect(() => buildCar('UNKNOWN')).not.toThrow();
    expect(buildCar('UNKNOWN').name).toBe('car');
  });

  it('F1 car has children (geometry was added)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F1');
    expect(car.children.length).toBeGreaterThan(0);
  });

  it('all 4 wheel names exist on F1 car children (by name property)', async () => {
    const { buildCar, WHEEL_NAMES } = await import('../cars.js');
    const car = buildCar('F1');
    const names = new Set();
    car.traverse(obj => { if (obj.name) names.add(obj.name); });
    WHEEL_NAMES.forEach(n => expect(names.has(n)).toBe(true));
  });
});
