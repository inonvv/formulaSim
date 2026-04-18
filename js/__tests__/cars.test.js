import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/* ── Mock car-loader (Phase 4+) — controlled per test ───────────── */
let _loaderManifestResult = null;
let _mockBboxMinY = -0.385;   // controlled per test for bbox-derived ground offset
vi.mock('../car-loader.js', () => ({
  loadCarModel:        async () => null,
  loadCarFromManifest: async () => _loaderManifestResult,
}));

/* ── Mock three ────────────────────────────────────────────────── */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set           = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.copy          = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };
  Vec3.prototype.addVectors    = function (a, b) { this.x = a.x+b.x; this.y = a.y+b.y; this.z = a.z+b.z; return this; };
  Vec3.prototype.subVectors    = function (a, b) { this.x = a.x-b.x; this.y = a.y-b.y; this.z = a.z-b.z; return this; };
  Vec3.prototype.multiplyScalar= function (s) { this.x *= s; this.y *= s; this.z *= s; return this; };
  Vec3.prototype.normalize     = function () { const l = Math.sqrt(this.x**2+this.y**2+this.z**2)||1; this.x/=l; this.y/=l; this.z/=l; return this; };
  Vec3.prototype.distanceTo    = function (v) { return Math.sqrt((this.x-v.x)**2+(this.y-v.y)**2+(this.z-v.z)**2); };

  function Quaternion() {}
  Quaternion.prototype.setFromUnitVectors = function () { return this; };

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
    this.quaternion = new Quaternion();
    this.castShadow = false;
    this.receiveShadow = false;
    this.children = [];
    this.userData = {};
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

  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; return this; };
    this.setIndex    = function () { return this; };
    this.computeVertexNormals = function () { return this; };
    this.dispose     = function () {};
  }
  function BufferAttribute(array, itemSize) {
    this.array = array; this.itemSize = itemSize; this.needsUpdate = false;
  }

  function MeshStandardMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshBasicMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshPhysicalMaterial(opts = {}) { Object.assign(this, opts); }
  function Color(v) { this.r = 0; this.g = 0; this.b = 0; }
  Color.prototype.offsetHSL = function () { return this; };

  function Box3() { this.min = { y: _mockBboxMinY }; this.max = {}; }
  Box3.prototype.setFromObject = function () { return this; };

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
    BufferGeometry,
    BufferAttribute,
    MeshStandardMaterial,
    MeshBasicMaterial,
    MeshPhysicalMaterial,
    Color,
    Box3,
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
  it('buildCar("F1") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    expect(car.name).toBe('car');
  });

  it('buildCar("F2") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F2')).name).toBe('car');
  });

  it('buildCar("F3") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F3')).name).toBe('car');
  });

  it('buildCar("GT") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('GT')).name).toBe('car');
  });

  it('buildCar with unknown type falls back to F1 silently', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('UNKNOWN')).name).toBe('car');
  });

  it('F1 car has children (geometry was added)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    expect(car.children.length).toBeGreaterThan(0);
  });

  it('all 4 wheel names exist on F1 car children (by name property)', async () => {
    const { buildCar, WHEEL_NAMES } = await import('../cars.js');
    const car = await buildCar('F1');
    const names = new Set();
    car.traverse(obj => { if (obj.name) names.add(obj.name); });
    WHEEL_NAMES.forEach(n => expect(names.has(n)).toBe(true));
  });
});

/* ── Phase 1: Sharp Sidepod Redesign ──────────────────────────────── */
describe('Sharp sidepod geometry (Phase 1)', () => {
  it('F1 has at least one mesh at z ≈ -0.64 (sharp inlet mouth)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    let found = false;
    car.traverse(obj => {
      if (obj.position && Math.abs(obj.position.z + 0.64) < 0.05) found = true;
    });
    expect(found).toBe(true);
  });

  it('F1 sidepods have more parts after redesign (≥ 10 per side via child increase)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    expect(car.children.length).toBeGreaterThanOrEqual(115);
  });

  it('GT car child count is not lower than before (GT sidepods unchanged)', async () => {
    const { buildCar } = await import('../cars.js');
    const gtCar = await buildCar('GT');
    expect(gtCar.children.length).toBeGreaterThanOrEqual(80);
  });
});

/* ── Phase 2a: Named rearWing Group ───────────────────────────────── */
describe('rearWing named group', () => {
  it('F1 car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('F2 car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F2');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('F3 car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F3');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('GT car has a child/descendant named "rearWing"', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('GT');
    let found = false;
    car.traverse(obj => { if (obj.name === 'rearWing') found = true; });
    expect(found).toBe(true);
  });

  it('F1 rearWing group has ≥ 2 children', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    let rearWing = null;
    car.traverse(obj => { if (obj.name === 'rearWing') rearWing = obj; });
    expect(rearWing).not.toBeNull();
    expect(rearWing.children.length).toBeGreaterThanOrEqual(2);
  });
});

/* ── Wheel ground contact ─────────────────────────────────────────── */
describe('wheel ground contact (grp.position.y places wheels at Y = -0.34)', () => {
  const GROUND_Y = -0.34;
  const WHEEL_NAMES_LOCAL = ['wFL', 'wFR', 'wRL', 'wRR'];

  function findWheel(car, name) {
    let found = null;
    car.traverse(obj => { if (obj.name === name) found = obj; });
    return found;
  }

  it('F1: wheel bottom touches ground (carY + wheelY - wR ≈ -0.34)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    const wR = 0.345;
    const wheel = findWheel(car, 'wFL');
    expect(wheel).not.toBeNull();
    expect(car.position.y + wheel.position.y - wR).toBeCloseTo(GROUND_Y, 3);
  });

  it('F2: wheel bottom touches ground (carY + wheelY - wR ≈ -0.34)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F2');
    const wR = 0.328;
    const wheel = findWheel(car, 'wFL');
    expect(wheel).not.toBeNull();
    expect(car.position.y + wheel.position.y - wR).toBeCloseTo(GROUND_Y, 3);
  });

  it('F3: wheel bottom touches ground (carY + wheelY - wR ≈ -0.34)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F3');
    const wR = 0.300;
    const wheel = findWheel(car, 'wFL');
    expect(wheel).not.toBeNull();
    expect(car.position.y + wheel.position.y - wR).toBeCloseTo(GROUND_Y, 3);
  });

  it('GT: wheel bottom touches ground (carY + wheelY - wR ≈ -0.34)', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('GT');
    const wR = 0.338;
    const wheel = findWheel(car, 'wFL');
    expect(wheel).not.toBeNull();
    expect(car.position.y + wheel.position.y - wR).toBeCloseTo(GROUND_Y, 3);
  });
});

/* ── Phase 3: buildCar is async ──────────────────────────────────── */
describe('buildCar is async (Phase 3)', () => {
  it('buildCar("F1") returns a Promise', async () => {
    const { buildCar } = await import('../cars.js');
    const result = buildCar('F1');
    expect(result).toBeInstanceOf(Promise);
    const grp = await result;
    expect(grp.name).toBe('car');
  });

  it('await buildCar("F2") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F2')).name).toBe('car');
  });

  it('await buildCar("F3") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F3')).name).toBe('car');
  });

  it('await buildCar("GT") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('GT')).name).toBe('car');
  });
});

/* ── Phase 4: buildF1Hybrid ──────────────────────────────────────── */

// Minimal fake mesh with clonable material
function fakeMesh(name) {
  const mat = { clone() { return { ...this, color: { copy() {} } }; }, color: { copy() {} } };
  return {
    name, isMesh: true, castShadow: false, receiveShadow: false,
    material: mat, parent: null, children: [],
    traverse(fn) { fn(this); },
  };
}
// Fake scene root (non-mesh, with THREE-like stubs)
function fakeScene(children = []) {
  const s = {
    name: 'root', isMesh: false, children: [...children],
    position: { set() {} }, scale: { setScalar() {} }, rotation: { set() {} },
    remove(child) { this.children = this.children.filter(c => c !== child); },
    add(child)    { this.children.push(child); child.parent = this; },
    traverse(fn) { fn(this); this.children.forEach(c => c.traverse ? c.traverse(fn) : fn(c)); },
  };
  children.forEach(c => { c.parent = s; });
  return s;
}

describe('buildF1Hybrid (Phase 4)', () => {
  beforeEach(() => { _loaderManifestResult = null; _mockBboxMinY = -0.385; });

  it('H1. null loader → fallback procedural; wFL present', async () => {
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    expect(names.has('wFL')).toBe(true);
  });

  it('H2. null loader fallback is grounded (carY + wFL.y - 0.345 ≈ -0.34)', async () => {
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.position.y + wFL.position.y - 0.345).toBeCloseTo(-0.34, 3);
  });

  it('H3. GLB path — imported scene is child of returned group', async () => {
    const scene = fakeScene([]);
    _loaderManifestResult = { scene, liveryMeshes: [], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.children).toContain(scene);
  });

  it('H4. GLB path — 4 procedural wheels present', async () => {
    _loaderManifestResult = { scene: fakeScene([]), liveryMeshes: [], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(true));
  });

  it('H5. GLB path — grp.position.y is bbox-derived (not hardcoded)', async () => {
    _mockBboxMinY = -0.6;   // deliberately not the old 0.045 value
    _loaderManifestResult = { scene: fakeScene([]), liveryMeshes: [], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.position.y).toBeCloseTo(-(-0.6 + 0.34), 3);  // 0.26
  });

  it('H6. rearWing node in loaded scene is wrapped in a named group', async () => {
    const rwMesh = fakeMesh('wing_rear_main');
    const scene  = fakeScene([rwMesh]);
    _loaderManifestResult = { scene, liveryMeshes: [], rearWing: rwMesh };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    let rearWingGrp = null;
    grp.traverse(o => { if (o.name === 'rearWing') rearWingGrp = o; });
    expect(rearWingGrp).not.toBeNull();
  });

  it('H7. livery mesh gets a cloned material with color set', async () => {
    const livMesh = fakeMesh('body_shell');
    const originalMat = livMesh.material;
    let colorCopied = false;
    const cloned = { ...originalMat, color: { copy: () => { colorCopied = true; } } };
    originalMat.clone = () => cloned;
    _loaderManifestResult = { scene: fakeScene([livMesh]), liveryMeshes: [livMesh], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    await buildF1Hybrid({ color: 0xe8132a });
    expect(livMesh.material).toBe(cloned);
    expect(colorCopied).toBe(true);
  });
});

/* ── Phase 5: buildGTHybrid ──────────────────────────────────────── */
describe('buildGTHybrid (Phase 5)', () => {
  beforeEach(() => { _loaderManifestResult = null; _mockBboxMinY = -0.385; });

  it('G1. null loader → procedural GT; wFL present and grounded', async () => {
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff8800 });
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.position.y + wFL.position.y - 0.338).toBeCloseTo(-0.34, 3);
  });

  it('G2. GLB path — 4 procedural wheels present', async () => {
    _loaderManifestResult = { scene: fakeScene([]), liveryMeshes: [], rearWing: null };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff8800 });
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(true));
  });

  it('G3. GLB path — grp.position.y is bbox-derived (not hardcoded)', async () => {
    _mockBboxMinY = -0.7;   // deliberately not the old 0.048 value
    _loaderManifestResult = { scene: fakeScene([]), liveryMeshes: [], rearWing: null };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff8800 });
    expect(grp.position.y).toBeCloseTo(-(-0.7 + 0.34), 3);  // 0.36
  });
});

/* ── Phase 6: fallback acceptance (simulates missing GLB) ─────────── */
describe('GLB fallback acceptance (Phase 6)', () => {
  beforeEach(() => { _loaderManifestResult = null; });

  it('F1 procedural renders when loader returns null (simulates missing GLB)', async () => {
    const { buildCar } = await import('../cars.js');
    const grp = await buildCar('F1');
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    expect(names.has('wFL')).toBe(true);
    expect(names.has('rearWing')).toBe(true);
  });

  it('GT procedural renders when loader returns null (simulates missing GLB)', async () => {
    const { buildCar } = await import('../cars.js');
    const grp = await buildCar('GT');
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.position.y + wFL.position.y - 0.338).toBeCloseTo(-0.34, 3);
  });
});
