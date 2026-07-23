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

  function BoxGeometry(w, h, d) { this.parameters = { width: w, height: h, depth: d }; this.type = 'BoxGeometry'; }
  function TorusGeometry(r, tube) { this.parameters = { radius: r, tube }; this.type = 'TorusGeometry'; }
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

  function Box3() {
    // Default covers both the legacy `min.y`-only consumers and the
    // GT-hybrid path which needs full min/max for synthesiseGTAnchors.
    this.min = { x: -1.0, y: _mockBboxMinY, z: -2.0 };
    this.max = { x:  1.0, y:  1.3,          z:  2.0 };
  }
  Box3.prototype.setFromObject = function () { return this; };

  return {
    Group,
    Mesh,
    BoxGeometry,
    TorusGeometry,
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

  it('F2/F3 removed — fall back to F1 meta', async () => {
    const { getCarMeta } = await import('../cars.js');
    expect(getCarMeta('F2').label).toBe('Formula One');
    expect(getCarMeta('F3').label).toBe('Formula One');
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

  it('buildCar("F2")/("F3") removed types fall back to F1 build', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F2')).name).toBe('car');
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
    for (const t of ['F1', 'GT']) {
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

  /* ── Phase 3: wheelsRoot integration ─────────────────────────── */
  it('H10. GLB path — wheelsRoot attached to grp; procedural wFL suppressed', async () => {
    // Fake wheelsRoot with 4 corner groups
    const makeCorner = (name, x, y, z) => ({
      name, position: { x, y, z },
      children: [], traverse(fn) { fn(this); },
    });
    const FL = makeCorner('FL', -0.82, 0.44, -1.47);
    const FR = makeCorner('FR',  0.82, 0.44, -1.47);
    const RL = makeCorner('RL', -0.80, 0.44,  2.10);
    const RR = makeCorner('RR',  0.80, 0.44,  2.10);
    const wheelsRoot = {
      name: 'wheelsRoot',
      children: [FL, FR, RL, RR],
      traverse(fn) { fn(this); this.children.forEach(c => c.traverse(fn)); },
    };
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: { groundContactY: -0.6232, frontAxleZ: -1.47, rearAxleZ: 2.10, frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.440 },
      wheelsRoot,
    };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    // wheelsRoot is a child of grp
    expect(grp.children).toContain(wheelsRoot);
    // userData.wheels exposes 4 corner Groups keyed by name
    expect(grp.userData.wheels).toBeDefined();
    expect(grp.userData.wheels.FL).toBe(FL);
    expect(grp.userData.wheels.FR).toBe(FR);
    expect(grp.userData.wheels.RL).toBe(RL);
    expect(grp.userData.wheels.RR).toBe(RR);
    // Procedural wheel names must NOT appear on the GLB-wheel path.
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    expect(names.has('wFL')).toBe(false);
    expect(names.has('wRR')).toBe(false);
  });

  it('H11. GLB path without wheelsRoot — procedural wheels still build (legacy fallback)', async () => {
    // Loader resolves without wheelsRoot (e.g. GLB loaded but split skipped).
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: { groundContactY: -0.6232, frontAxleZ: -1.47, rearAxleZ: 2.10, frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.440 },
      // wheelsRoot: undefined
    };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.userData.wheels).toBeUndefined();
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    expect(names.has('wFL')).toBe(true);
    expect(names.has('wFR')).toBe(true);
  });
});

/* ── Phase 5 (updated): GT is hybrid when GLB loads, procedural fallback ─── */
describe('GT hybrid + procedural fallback via buildCar', () => {
  beforeEach(() => { _loaderManifestResult = null; });

  it('GT. buildCar("GT") falls back to procedural when loader returns null', async () => {
    const { buildCar } = await import('../cars.js');
    const grp = await buildCar('GT');
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    // Procedural GT radius (0.338) — the fallback path preserves the old contract.
    expect(grp.position.y + wFL.position.y - 0.338).toBeCloseTo(-0.34, 3);
  });
});

/* ── T2.A: buildGTHybrid — GLB body + GLB wheels split from the mega-mesh ──
 * gt.glb's wheels are connectivity islands inside the monolithic body mesh;
 * the loader extracts them into wheelsRoot (buildWheelsFromMonolith) and
 * measures the axles/radius from the tire islands. buildGTHybrid mirrors
 * buildF1Hybrid: attach wheelsRoot, expose userData.wheels, passthrough
 * measure. Empirical GLB values: tires (±0.77, 0.30, −1.17/+1.29), r 0.39.
 */
describe('buildGTHybrid (T2.A Porsche GT)', () => {
  beforeEach(() => { _loaderManifestResult = null; _mockBboxMinY = -0.0836; });

  const GT_GLB_MEASURE = () => ({
    groundContactY: -0.09, frontAxleZ: -1.17, rearAxleZ: 1.29,
    frontAxleX: 0.77, rearAxleX: 0.77, wheelRadius: 0.39, wheelWidth: 0.33,
  });

  const makeCorner = (name, x, y, z) => ({
    name, position: { x, y, z },
    children: [], traverse(fn) { fn(this); },
  });
  const fakeWheelsRoot = () => {
    const FL = makeCorner('FL', -0.77, 0.30, -1.17);
    const FR = makeCorner('FR',  0.77, 0.30, -1.17);
    const RL = makeCorner('RL', -0.77, 0.30,  1.29);
    const RR = makeCorner('RR',  0.77, 0.30,  1.29);
    return {
      name: 'wheelsRoot',
      children: [FL, FR, RL, RR],
      traverse(fn) { fn(this); this.children.forEach(c => c.traverse(fn)); },
    };
  };

  it('T2.A.t1. GLB path — wheelsRoot attached, userData.wheels F1 parity, no overlay', async () => {
    const scene = fakeScene([]);
    const wheelsRoot = fakeWheelsRoot();
    _loaderManifestResult = { scene, liveryMeshes: [], glbMeasure: GT_GLB_MEASURE(), wheelsRoot };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    expect(grp.children).toContain(scene);
    expect(grp.children).toContain(wheelsRoot);
    expect(grp.userData.wheels.FL).toBe(wheelsRoot.children[0]);
    expect(grp.userData.wheels.FR).toBe(wheelsRoot.children[1]);
    expect(grp.userData.wheels.RL).toBe(wheelsRoot.children[2]);
    expect(grp.userData.wheels.RR).toBe(wheelsRoot.children[3]);
    // No procedural overlay wheels on the GLB path — single wheel source.
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(false));
  });

  it('T2.A.t2. measure is MEASURED passthrough (wheelbase 2.46, r 0.39), baseY derived', async () => {
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: GT_GLB_MEASURE(), wheelsRoot: fakeWheelsRoot(),
    };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    const m = grp.userData.measure;
    expect(m.frontAxleZ).toBeCloseTo(-1.17, 3);
    expect(m.rearAxleZ).toBeCloseTo( 1.29, 3);
    expect(m.wheelbase).toBeCloseTo( 2.46, 2);     // measured, not the 2.457 spec constant
    expect(m.wheelRadius).toBeCloseTo(0.39, 3);    // measured, not the 0.35 spec constant
    expect(m.trackWidth).toBeCloseTo(1.54, 2);     // 2 × measured 0.77
    expect(m.groundContactY).toBeCloseTo(-0.09, 3);
    // baseY = TRACK.SURFACE_Y − groundContactY = −0.34 − (−0.09) = −0.25.
    expect(grp.userData.baseY).toBeCloseTo(-0.25, 3);
    expect(grp.position.y).toBeCloseTo(-0.25, 3);
  });

  it('T2.A.t3. synthesised anchors include all 8 standard keys', async () => {
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: GT_GLB_MEASURE(), wheelsRoot: fakeWheelsRoot(),
    };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    const a = grp.userData.measure.anchors;
    ['cockpit','halo','frontWing','rearWing','sidepodTop','floor','diffuser','noseTip']
      .forEach(k => expect(a[k]).toBeDefined());
    // Sanity: frontWing sits at the nose (−Z side of the bbox), rearWing at +Z.
    expect(a.frontWing.z).toBeLessThan(a.rearWing.z);
  });

  it('T2.A.t8. measured GLB anchors override synthesised ones; synthesised fill gaps', async () => {
    const gm = GT_GLB_MEASURE();
    gm.anchors = {
      halo:         { x: 0, y: 0.99, z: 0.10 },               // measured roof peak
      engineIntake: { x: 0, y: 1.05, z: 1.55, role: 'inlet' }, // measured vent
    };
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: gm, wheelsRoot: fakeWheelsRoot(),
    };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    const a = grp.userData.measure.anchors;
    expect(a.halo.y).toBeCloseTo(0.99, 5);            // measured wins
    expect(a.engineIntake.role).toBe('inlet');        // vents flow through
    expect(a.frontWing).toBeDefined();                // synthesised fills the rest
    expect(a.diffuser).toBeDefined();
  });

  it('T2.A.t4. null loader → fallback procedural (no regression)', async () => {
    _loaderManifestResult = null;
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    // Procedural GT has many more children than the hybrid (GLB scene + wheelsRoot ≈ 2).
    expect(grp.children.length).toBeGreaterThanOrEqual(80);
  });

  it('T2.A.t7. GLB loaded but wheel split failed → procedural fallback (no half-strip)', async () => {
    const scene = fakeScene([]);
    _loaderManifestResult = { scene, liveryMeshes: [] };   // no wheelsRoot, no glbMeasure
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    // Single-source guarantee: never render the GLB with baked static wheels
    // plus a procedural overlay — fall back to the fully procedural car.
    expect(grp.children).not.toContain(scene);
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(true));
    expect(grp.children.length).toBeGreaterThanOrEqual(80);
  });

  it('T2.A.t6. procedural GT uses road-car wheel (yellow caliper, no formula wheel-nut)', async () => {
    _loaderManifestResult = null;   // procedural path owns the gtWheel look now
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    // Collect every Mesh under any of the 4 wheel groups.
    const wheelMeshes = [];
    grp.traverse(o => {
      if (!['wFL','wFR','wRL','wRR'].includes(o.name)) return;
      o.traverse?.(c => { if (c !== o) wheelMeshes.push(c); });
    });
    const hasYellowCaliper = wheelMeshes.some(m =>
      m.name?.startsWith?.('brake_cal_') && m.material?.color
    );
    expect(hasYellowCaliper).toBe(true);
    // F1-style wheels have 6-segment hex wheel-nuts (radialSegments=6 in CylinderGeometry).
    // Road-car wheels shouldn't — verify no 6-seg cylinders inside the wheel groups.
    const hasHexNut = wheelMeshes.some(m =>
      m.geometry?.parameters?.radialSegments === 6
    );
    expect(hasHexNut).toBe(false);
  });

  it('T2.A.t5. livery mesh gets a cloned material with color set', async () => {
    const livMesh = fakeMesh('twixer_body_shell');
    const originalMat = livMesh.material;
    let colorCopied = false;
    const cloned = { ...originalMat, color: { copy: () => { colorCopied = true; } } };
    originalMat.clone = () => cloned;
    _loaderManifestResult = {
      scene: fakeScene([livMesh]), liveryMeshes: [livMesh],
      glbMeasure: GT_GLB_MEASURE(), wheelsRoot: fakeWheelsRoot(),
    };
    const { buildGTHybrid } = await import('../cars.js');
    await buildGTHybrid({ color: 0xff0000 });
    expect(livMesh.material).toBe(cloned);
    expect(colorCopied).toBe(true);
  });
});

/* ── P5: cockpit steering wheel ──────────────────────────────────── */
describe('buildSteeringWheel (P5)', () => {
  it('returns a group named "steeringWheel" for both types', async () => {
    const { buildSteeringWheel } = await import('../cars.js');
    expect(buildSteeringWheel('F1').name).toBe('steeringWheel');
    expect(buildSteeringWheel('GT').name).toBe('steeringWheel');
  });

  it('F1: flat-bottom rect wheel — rim + 2 grips + hub screen (4 children)', async () => {
    const { buildSteeringWheel } = await import('../cars.js');
    const w = buildSteeringWheel('F1');
    expect(w.children.length).toBe(4);
    // Rim is the rounded-rect extrusion (rBox → ExtrudeGeometry), not a torus.
    expect(w.children.some(c => c.geometry?.type === 'TorusGeometry')).toBe(false);
  });

  it('GT: round wheel — torus Ø0.36/tube 0.02 + 3 spokes (4 children)', async () => {
    const { buildSteeringWheel } = await import('../cars.js');
    const w = buildSteeringWheel('GT');
    expect(w.children.length).toBe(4);
    const torus = w.children.find(c => c.geometry?.type === 'TorusGeometry');
    expect(torus).toBeDefined();
    expect(torus.geometry.parameters.radius).toBeCloseTo(0.18, 5);   // Ø 0.36
    expect(torus.geometry.parameters.tube).toBeCloseTo(0.02, 5);
  });

  it('unknown type falls back to the F1 wheel', async () => {
    const { buildSteeringWheel } = await import('../cars.js');
    const w = buildSteeringWheel('F2');
    expect(w.children.some(c => c.geometry?.type === 'TorusGeometry')).toBe(false);
    expect(w.children.length).toBe(4);
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
