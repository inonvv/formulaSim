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
    this.userData = {};
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

/* ── Measurement contract (Unified Car Measurement v2) ─────────── */
describe('car measurement contract (grp.userData.measure)', () => {
  it('F1 procedural exposes measure with expected fields', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    const m = car.userData.measure;
    expect(m).toBeDefined();
    expect(m.wheelRadius).toBeCloseTo(0.345, 3);
    expect(m.groundContactY).toBeCloseTo(-0.385, 3);   // -0.04 - 0.345
    expect(m.wheelbase).toBeCloseTo(Math.abs(1.60 - (-1.50)), 3); // 3.10
    expect(m.trackWidth).toBeCloseTo(2 * 0.82, 3);
  });

  it('F2 procedural exposes measure with expected fields', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F2');
    const m = car.userData.measure;
    expect(m.wheelRadius).toBeCloseTo(0.328, 3);
    expect(m.groundContactY).toBeCloseTo(-0.368, 3);   // -0.04 - 0.328
    expect(m.wheelbase).toBeCloseTo(Math.abs(1.48 - (-1.38)), 3); // 2.86
  });

  it('F3 procedural exposes measure with expected fields', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F3');
    const m = car.userData.measure;
    expect(m.wheelRadius).toBeCloseTo(0.300, 3);
    expect(m.groundContactY).toBeCloseTo(-0.34, 3);    // -0.04 - 0.300
  });

  it('GT procedural exposes measure with expected fields', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('GT');
    const m = car.userData.measure;
    expect(m.wheelRadius).toBeCloseTo(0.338, 3);
    expect(m.groundContactY).toBeCloseTo(-0.388, 3);   // -0.05 - 0.338
  });

  it('grp.userData.baseY matches TRACK.SURFACE_Y - groundContactY', async () => {
    const { buildCar } = await import('../cars.js');
    const car = await buildCar('F1');
    const m = car.userData.measure;
    expect(car.userData.baseY).toBeCloseTo(-0.34 - m.groundContactY, 3);
    expect(car.position.y).toBeCloseTo(car.userData.baseY, 3);
  });

  it('all variants expose measure.anchors with named feature points', async () => {
    const { buildCar } = await import('../cars.js');
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const car = await buildCar(t);
      const a = car.userData.measure.anchors;
      expect(a).toBeDefined();
      expect(a.cockpit).toBeDefined();
      expect(a.halo).toBeDefined();
      expect(a.frontWing).toBeDefined();
      expect(a.rearWing).toBeDefined();
      expect(a.sidepodTop).toBeDefined();
      expect(a.floor).toBeDefined();
      expect(a.diffuser).toBeDefined();
      expect(a.noseTip).toBeDefined();
      // Anchors are in car-local coordinates with sensible Y/Z signs.
      expect(typeof a.cockpit.y).toBe('number');
      expect(typeof a.halo.y).toBe('number');
      expect(a.frontWing.z).toBeLessThan(0);   // nose is -Z
      expect(a.rearWing.z).toBeGreaterThan(0); // tail is +Z
    }
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
    _loaderManifestResult = { scene, liveryMeshes: [] };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.children).toContain(scene);
  });

  it('H4. GLB path — 4 procedural wheels present', async () => {
    _loaderManifestResult = { scene: fakeScene([]), liveryMeshes: [] };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(true));
  });

  it('H5. GLB path — grp.position.y is glbMeasure-derived (not hardcoded)', async () => {
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: { groundContactY: -0.6232, frontAxleZ: -1.47, rearAxleZ: 2.10, frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.440 },
    };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    // baseY = TRACK.SURFACE_Y - groundContactY = -0.34 - (-0.6232) = 0.2832
    expect(grp.position.y).toBeCloseTo(0.2832, 3);
    // measure propagates to userData
    expect(grp.userData.measure.groundContactY).toBeCloseTo(-0.6232, 4);
    expect(grp.userData.measure.frontAxleZ).toBeCloseTo(-1.47, 3);
    expect(grp.userData.measure.rearAxleZ).toBeCloseTo(2.10, 3);
  });

  it('H6. GLB path — wheelRadius taken from glbMeasure (no hardcoded fallback)', async () => {
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: { groundContactY: -0.6232, frontAxleZ: -1.47, rearAxleZ: 2.10, frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.440 },
    };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.userData.measure.wheelRadius).toBeCloseTo(0.440, 3);
  });

  it('H9. GLB path — anchors from glbMeasure propagate to userData.measure', async () => {
    const fakeAnchors = {
      cockpit:    { x: 0, y: 0.32, z: -0.10 },
      halo:       { x: 0, y: 0.373, z: 0.05 },
      frontWing:  { x: 0, y: -0.05, z: -2.30 },
      rearWing:   { x: 0, y: 0.454, z: 2.41 },
      sidepodTop: { x: 0, y: 0.30, z: 0.13 },
      floor:      { x: 0, y: -0.37, z: 0.13 },
    };
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: {
        groundContactY: -0.6232, frontAxleZ: -1.47, rearAxleZ: 2.10,
        frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.440,
        anchors: fakeAnchors,
      },
    };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.userData.measure.anchors).toBe(fakeAnchors);
  });

  it('H8. GLB path — procedural wheel positions track glbMeasure', async () => {
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: { groundContactY: -0.6232, frontAxleZ: -1.47, rearAxleZ: 2.10, frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.440 },
    };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    let wFL = null, wRR = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; if (o.name === 'wRR') wRR = o; });
    expect(wFL.position.x).toBeCloseTo(-0.82, 3);
    expect(wFL.position.z).toBeCloseTo(-1.47, 3);
    // wheel bottom in local = wheelY - wR = groundContactY
    expect(wFL.position.y - 0.440).toBeCloseTo(-0.6232, 3);
    expect(wRR.position.x).toBeCloseTo(0.80, 3);
    expect(wRR.position.z).toBeCloseTo(2.10, 3);
  });

  it('H7. livery mesh gets a cloned material with color set', async () => {
    const livMesh = fakeMesh('body_shell');
    const originalMat = livMesh.material;
    let colorCopied = false;
    const cloned = { ...originalMat, color: { copy: () => { colorCopied = true; } } };
    originalMat.clone = () => cloned;
    _loaderManifestResult = { scene: fakeScene([livMesh]), liveryMeshes: [livMesh] };
    const { buildF1Hybrid } = await import('../cars.js');
    await buildF1Hybrid({ color: 0xe8132a });
    expect(livMesh.material).toBe(cloned);
    expect(colorCopied).toBe(true);
  });
});

/* ── Phase 5: GT is procedural-only (buildGTHybrid removed) ─────── */
describe('GT procedural is wired through buildCar', () => {
  it('GT. buildCar("GT") uses procedural path — wheels present and grounded', async () => {
    const { buildCar } = await import('../cars.js');
    const grp = await buildCar('GT');
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.position.y + wFL.position.y - 0.338).toBeCloseTo(-0.34, 3);
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
    expect(names.has('wRR')).toBe(true);
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
