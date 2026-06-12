/**
 * gt-hybrid-placement.test.js — Adversarial tests for buildGTHybrid placement.
 *
 * Old premise (deleted): axle positions were derived from the scene bbox +
 * spec constants, so outlier meshes (rear-wing strut extending 1.5 m past the
 * bumper, node-transformed hood) could drag the wheelbase. The fix made
 * placement a PASSTHROUGH of the loader's connectivity measurement
 * (buildWheelsFromMonolith measures the GLB's own tire islands), so scene
 * clutter cannot perturb it — these tests prove that, plus the fallback
 * ladder when the split fails.
 *
 * Mesh-aware Box3 mock retained: synthesiseGTAnchors still consumes the
 * bodyshell bbox, and the wing-outlier scenarios exercise that path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let _loaderManifestResult = null;

vi.mock('../car-loader.js', () => ({
  loadCarModel:        async () => null,
  loadCarFromManifest: async () => _loaderManifestResult,
}));

/* Mesh-aware Three.js mock — Box3.setFromObject walks the object's
 * descendants and unions per-mesh bboxes carried in userData.__bbox.
 * Without per-mesh bboxes (procedural cars), it falls back to the legacy
 * fixed values used elsewhere in the test suite. */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.copy = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };

  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };

  function Group() {
    this.name = ''; this.children = []; this.userData = {};
    this.position = new Vec3(); this.rotation = new Euler();
  }
  Group.prototype.add = function (...items) { this.children.push(...items); return this; };
  Group.prototype.traverse = function (fn) {
    fn(this);
    this.children.forEach(c => { if (c && c.traverse) c.traverse(fn); });
  };

  function Mesh(geo, mat) {
    this.name = ''; this.geometry = geo || {}; this.material = mat || {};
    this.position = new Vec3(); this.rotation = new Euler();
    this.children = []; this.userData = {}; this.isMesh = true;
  }
  Mesh.prototype.add = function (...items) { this.children.push(...items); return this; };
  Mesh.prototype.traverse = function (fn) {
    fn(this);
    this.children.forEach(c => { if (c && c.traverse) c.traverse(fn); });
  };
  Mesh.prototype.updateMatrixWorld = function () {};

  /* Geometry/material stubs — same shape used elsewhere. */
  function noop() { return this; }
  function makeStubGeo() { return { rotateX: noop, translate: noop, scale: noop, rotateY: noop }; }
  function BoxGeometry() { return makeStubGeo(); }
  function CylinderGeometry() { return makeStubGeo(); }
  function SphereGeometry() { return makeStubGeo(); }
  function ConeGeometry() { return makeStubGeo(); }
  function PlaneGeometry() { return makeStubGeo(); }
  function ExtrudeGeometry() { return makeStubGeo(); }
  function LatheGeometry() { return makeStubGeo(); }
  function TubeGeometry() { return makeStubGeo(); }
  function CatmullRomCurve3(pts) { this.points = pts || []; }
  function Shape() { this.moveTo = noop; this.lineTo = noop; this.quadraticCurveTo = noop; }
  function Vector2(x, y) { this.x = x; this.y = y; }
  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (n, a) { this.attributes[n] = a; return this; };
    this.computeVertexNormals = noop; this.dispose = noop; this.setIndex = noop;
  }
  function BufferAttribute(arr, sz) { this.array = arr; this.itemSize = sz; this.needsUpdate = false; }

  function MeshStandardMaterial(opts = {}) { Object.assign(this, opts); }
  function MeshBasicMaterial(opts = {})    { Object.assign(this, opts); }
  function MeshPhysicalMaterial(opts = {}) { Object.assign(this, opts); }
  function Color() { this.r = 0; this.g = 0; this.b = 0; }
  Color.prototype.offsetHSL = function () { return this; };

  /* The key piece — bbox unions per-mesh userData.__bbox under the target. */
  function Box3() {
    this.min = { x: Infinity,  y: Infinity,  z: Infinity };
    this.max = { x: -Infinity, y: -Infinity, z: -Infinity };
  }
  Box3.prototype.makeEmpty = function () {
    this.min = { x: Infinity, y: Infinity, z: Infinity };
    this.max = { x: -Infinity, y: -Infinity, z: -Infinity };
    return this;
  };
  Box3.prototype.expandByPoint = function (p) {
    if (p.x < this.min.x) this.min.x = p.x;
    if (p.y < this.min.y) this.min.y = p.y;
    if (p.z < this.min.z) this.min.z = p.z;
    if (p.x > this.max.x) this.max.x = p.x;
    if (p.y > this.max.y) this.max.y = p.y;
    if (p.z > this.max.z) this.max.z = p.z;
    return this;
  };
  Box3.prototype.union = function (b) {
    this.expandByPoint(b.min);
    this.expandByPoint(b.max);
    return this;
  };
  Box3.prototype.getCenter = function (target) {
    target.x = (this.min.x + this.max.x) / 2;
    target.y = (this.min.y + this.max.y) / 2;
    target.z = (this.min.z + this.max.z) / 2;
    return target;
  };
  Box3.prototype.setFromObject = function (obj) {
    this.makeEmpty();
    if (!obj) return this;
    const visit = (node) => {
      const bb = node?.userData?.__bbox;
      if (bb) { this.expandByPoint(bb.min); this.expandByPoint(bb.max); }
      (node.children || []).forEach(visit);
    };
    visit(obj);
    // If no per-mesh bboxes were found, leave a sane fallback so non-aware
    // call sites (procedural cars) still get a usable Box3.
    if (this.min.x === Infinity) {
      this.min = { x: -1.0, y: -0.385, z: -2.0 };
      this.max = { x:  1.0, y:  1.3,    z:  2.0 };
    }
    return this;
  };

  return {
    Group, Mesh, Vector3: Vec3, Euler, Color, Box3,
    BoxGeometry, CylinderGeometry, SphereGeometry, ConeGeometry, PlaneGeometry,
    ExtrudeGeometry, LatheGeometry, TubeGeometry, CatmullRomCurve3,
    Vector2, Shape, BufferGeometry, BufferAttribute,
    MeshStandardMaterial, MeshBasicMaterial, MeshPhysicalMaterial,
  };
});

/* ── Helpers ─────────────────────────────────────────────────────── */
function fakeMesh(name, bbox) {
  const m = {
    name,
    isMesh: true,
    children: [],
    material: { clone: () => ({ color: { copy: () => {} } }) },
    userData: { __bbox: bbox },
    traverse(fn) { fn(this); },
    updateMatrixWorld() {},
  };
  return m;
}

function fakeScene(meshes) {
  return {
    name: 'gtScene',
    children: meshes,
    userData: {},
    rotation: { set() {} },
    scale: { setScalar() {} },
    position: { set() {} },
    traverse(fn) {
      fn(this);
      meshes.forEach(m => m.traverse(fn));
    },
    updateMatrixWorld() {},
  };
}

/** Empirical connectivity measurement (what buildWheelsFromMonolith returns). */
function gtGlbMeasure() {
  return {
    groundContactY: -0.09, frontAxleZ: -1.17, rearAxleZ: 1.29,
    frontAxleX: 0.77, rearAxleX: 0.77, wheelRadius: 0.39, wheelWidth: 0.33,
  };
}

function fakeWheelsRoot() {
  const corner = (name, x, z) => ({
    name, position: { x, y: 0.30, z },
    children: [], traverse(fn) { fn(this); },
  });
  return {
    name: 'wheelsRoot',
    children: [
      corner('FL', -0.77, -1.17), corner('FR', 0.77, -1.17),
      corner('RL', -0.77,  1.29), corner('RR', 0.77,  1.29),
    ],
    traverse(fn) { fn(this); this.children.forEach(c => c.traverse(fn)); },
  };
}

/* ── Tests ───────────────────────────────────────────────────────── */
describe('GT hybrid axle placement — measured passthrough, outlier-immune', () => {
  beforeEach(() => { _loaderManifestResult = null; });

  it('P1. outlier wing strut cannot perturb wheelbase or groundContactY', async () => {
    // Scene bbox is dominated by a wing strut extending to z=+3.10 and
    // hanging to y=−1.0. Under the old spec-constant math this dragged the
    // axles; with measured passthrough the wheel placement reads ONLY the
    // loader's tire-island measurement.
    const body = fakeMesh('TwiXeR_992_body_gt3rs_main', {
      min: { x: -0.92, y: -0.04, z: -1.65 },
      max: { x:  0.92, y:  1.08, z: +1.65 },
    });
    const wing = fakeMesh('TwiXeR_992_gt3rs_carbon_Wing_main', {
      min: { x: -0.95, y: -1.00, z: +2.40 },
      max: { x:  0.95, y:  1.45, z: +3.10 },   // ← extreme outlier
    });
    _loaderManifestResult = {
      scene: fakeScene([body, wing]), liveryMeshes: [],
      glbMeasure: gtGlbMeasure(), wheelsRoot: fakeWheelsRoot(),
    };

    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    const m   = grp.userData.measure;

    expect(m.wheelbase).toBeCloseTo(2.46, 2);        // exactly the measured value
    expect(m.frontAxleZ).toBeCloseTo(-1.17, 3);
    expect(m.rearAxleZ).toBeCloseTo(1.29, 3);
    expect(m.groundContactY).toBeCloseTo(-0.09, 3);  // wing −1.0 y did NOT leak in
  });

  it('P2. anchors stay bodyshell-bbox-derived (wing excluded by name filter)', async () => {
    const body = fakeMesh('TwiXeR_992_body_gt3rs_main', {
      min: { x: -0.92, y: -0.04, z: -2.29 },
      max: { x:  0.92, y:  1.08, z: +2.29 },
    });
    const wing = fakeMesh('TwiXeR_992_gt3rs_carbon_Wing_main', {
      min: { x: -0.95, y:  0.80, z: +3.00 },
      max: { x:  0.95, y:  1.45, z: +3.70 },
    });
    _loaderManifestResult = {
      scene: fakeScene([body, wing]), liveryMeshes: [],
      glbMeasure: gtGlbMeasure(), wheelsRoot: fakeWheelsRoot(),
    };

    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    const a   = grp.userData.measure.anchors;

    // rearWing anchor derives from the BODYSHELL bbox max z (2.29), not the
    // wing strut (3.70) — GT_BODYSHELL_RE excludes carbon_Wing meshes.
    expect(a.rearWing.z).toBeLessThanOrEqual(2.29);
    expect(a.frontWing.z).toBeGreaterThanOrEqual(-2.29);
  });

  it('P3. GLB loaded but split failed (no wheelsRoot) → procedural fallback, no throw', async () => {
    const body = fakeMesh('TwiXeR_992_body_gt3rs_main', {
      min: { x: -0.92, y: -0.04, z: -1.65 },
      max: { x:  0.92, y:  1.08, z: +1.65 },
    });
    _loaderManifestResult = { scene: fakeScene([body]), liveryMeshes: [] };

    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    expect(grp.userData.measure).toBeDefined();
    expect(grp.userData.measure.wheelbase).toBeGreaterThan(0);
    // Procedural wheels present, GLB scene NOT attached (single wheel source).
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.children.map(c => c.name)).not.toContain('gtScene');
  });

  it('P4. glbMeasure present but wheelsRoot missing → still procedural (both required)', async () => {
    _loaderManifestResult = {
      scene: fakeScene([]), liveryMeshes: [],
      glbMeasure: gtGlbMeasure(),   // measurement without split output
    };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff0000 });
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
  });
});
