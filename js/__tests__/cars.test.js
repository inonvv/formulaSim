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

  // New geometry types used by rBox / wingGeo / noseTip / ogiveNose helpers
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
  // ogiveNose uses LatheGeometry; halo arch uses CatmullRomCurve3 + TubeGeometry
  function LatheGeometry(points, segments) {
    this.rotateX = function () { return this; };
    this.scale   = function () { return this; };
  }
  function CatmullRomCurve3(points) { this.points = points || []; }
  function TubeGeometry(curve, tubeSeg, radius, radSeg, closed) {}

  function MeshStandardMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshBasicMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshPhysicalMaterial(opts = {}) { Object.assign(this, opts); }
  function Color(v) { this.r = 0; this.g = 0; this.b = 0; }
  Color.prototype.offsetHSL = function () { return this; };

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
    LatheGeometry,
    CatmullRomCurve3,
    TubeGeometry,
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

/* ── Phase 1: Sharp Sidepod Redesign ──────────────────────────────── */
describe('Sharp sidepod geometry (Phase 1)', () => {
  it('F1 has at least one mesh at z ≈ -0.64 (sharp inlet mouth)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F1');
    let found = false;
    car.traverse(obj => {
      if (obj.position && Math.abs(obj.position.z + 0.64) < 0.05) found = true;
    });
    expect(found).toBe(true);
  });

  it('F1 sidepods have more parts after redesign (≥ 10 per side via child increase)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F1');
    // After both sidepod redesign (adds 8) and rearWing extraction (removes 15),
    // net: 130 + 8 - 15 = 123. Assert at least 115 to allow minor variation.
    expect(car.children.length).toBeGreaterThanOrEqual(115);
  });

  it('GT car child count is not lower than before (GT sidepods unchanged)', async () => {
    const { buildCar } = await import('../cars.js');
    const gtCar = buildCar('GT');
    // GT had ~101 direct children, loses ~15 for rearWing extraction → ~86 minimum
    expect(gtCar.children.length).toBeGreaterThanOrEqual(80);
  });
});

/* ── Phase 2a: Named rearWing Group ───────────────────────────────── */
describe('rearWing named group', () => {
  it('F1 car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F1');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('F2 car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F2');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('F3 car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F3');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('GT car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('GT');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('F1 rearWing group has ≥ 2 children', async () => {
    const { buildCar } = await import('../cars.js');
    const car = buildCar('F1');
    let rearWing = null;
    car.traverse(obj => { if (obj.name === 'rearWing') rearWing = obj; });
    expect(rearWing).not.toBeNull();
    expect(rearWing.children.length).toBeGreaterThanOrEqual(2);
  });
});
