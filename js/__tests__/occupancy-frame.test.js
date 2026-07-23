/**
 * occupancy-frame.test.js — Occupancy frame-offset fix (plan occupancy-frame-offset.md).
 *
 * The body-occupancy SDF is voxelized in WORLD space (car lifted by baseY
 * before voxelization in main.js), while airflow coordinates are CAR-LOCAL
 * (group lifted visually by baseY). Two legacy sampling sites passed
 * car-local y straight into the world-frame SDF — a systematic vertical
 * error equal to baseY (GLB F1 +0.2787, GT ≈ −0.25; voxel dy ≈ 0.035 m).
 *
 * Like part-flow.test.js this file mocks ONLY three — airflow-core math runs
 * REAL, end-to-end.
 *
 * Fixture seed heights (GLB F1 measure, body-centered frame):
 *   wing −0.2517 / −0.1370, axle −0.2737, pod −0.1784 / +0.0624,
 *   halo +0.293 / +0.393, upper +0.523 / +0.673, free +0.873.
 */
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

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

/* ── Three.js mock (same shape as part-flow.test.js) ──────────────── */
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

/* ── Scene stub ───────────────────────────────────────────────────── */
function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

/* ── GLB-F1-shaped measure fixture (body-centered frame) ──────────── */
function glbF1Measure() {
  return {
    groundContactY: -0.6187,
    frontAxleZ: -1.47,
    rearAxleZ:   2.10,
    frontAxleX:  0.82,
    rearAxleX:   0.80,
    wheelbase:   3.57,
    trackWidth:  1.64,
    wheelRadius: 0.345,
    anchors: {
      halo: {
        x: 0, y: 0.373, z: 0.09,
        bbox: { minX: -0.38, maxX: 0.38, minY: 0.05, maxY: 0.373, minZ: -0.47, maxZ: 0.65 },
      },
      cockpit:   { x: 0, y: 0.35, z: 0.30 },
      frontWing: {
        x: 0, y: -0.0524, z: -2.297,
        bbox: { minX: -0.90, maxX: 0.90, minY: -0.4163, maxY: -0.0524, minZ: -2.55, maxZ: -2.04 },
      },
      rearWing: {
        x: 0, y: 0.454, z: 2.412,
        bbox: { minX: -0.50, maxX: 0.50, minY: 0.05, maxY: 0.454, minZ: 2.00, maxZ: 2.42 },
      },
      bodyShell: {
        x: 0, y: 0.0142, z: 0.0,
        bbox: { minX: -0.8125, maxX: 0.8125, minY: -0.4674, maxY: 0.4958, minZ: -2.40, maxZ: 2.30 },
      },
      sidepodTop: { x: 0, y: 0.303,  z: 0.0 },
      floor:      { x: 0, y: -0.371, z: 0.0 },
    },
  };
}

const F1_BASE_Y = 0.2787;   // TRACK.SURFACE_Y − groundContactY = −0.34 − (−0.6187)
const GT_BASE_Y = -0.25;    // GT sign-flipped case (contact ≈ −0.09)

/** Occupancy stub: inside a WORLD-frame y window, all x/z. Records samples. */
function windowStub(yLo, yHi) {
  const sampledYs = [];
  return {
    sampledYs,
    sample: (x, y, z) => { sampledYs.push(y); return (y >= yLo && y <= yHi) ? 1 : 0; },
    gradient: () => ({ x: 0, y: 1, z: 0 }),
  };
}

/** Recorder stub: never inside, records every sampled y. */
function recorderStub() {
  const sampledYs = [];
  return {
    sampledYs,
    sample: (x, y, z) => { sampledYs.push(y); return 0; },
    gradient: () => ({ x: 0, y: 1, z: 0 }),
  };
}

/* ════════════════════════════════════════════════════════════════ */
describe('Occupancy frame offset — trace-time toWorld (defect O1)', () => {
  it('T1 every trace-time sampled y = seed y + baseY (F1 +0.2787)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setBaseY(F1_BASE_Y);                       // main.js order: baseY first
    const rec = recorderStub();
    airflow.setCarType('F1', glbF1Measure(), rec);     // occupancy arrives after
    let seedsChecked = 0;
    for (const s of airflow._seeds) {
      if (s.group !== 'ribbon') continue;
      rec.sampledYs.length = 0;
      airflow._traceSeedPath(s, airflow._activeModifiers);
      expect(rec.sampledYs.length).toBeGreaterThan(0);
      for (const y of rec.sampledYs) {
        expect(y).toBeCloseTo(s.y + F1_BASE_Y, 6);
      }
      seedsChecked++;
    }
    expect(seedsChecked).toBeGreaterThanOrEqual(10);
    console.info(`[occupancy-frame] T1: ${seedsChecked} ribbon seeds sampled at seedY + ${F1_BASE_Y}`);
  });
});

describe('Occupancy frame offset — update-time nudge (defect O2)', () => {
  /**
   * Runs update() twice — without and with an occupancy stub whose inside
   * region is a WORLD-frame y window — and returns, per unique seed height,
   * whether any upstream vertex (eta ≤ −1.2, where vertex y === seed.y
   * exactly) moved by more than half the 0.12 m nudge.
   */
  async function nudgedHeights(baseY, winLo, winHi) {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());          // NO occupancy at build
    airflow.setBaseY(baseY);
    airflow.setVisible(true);
    airflow.update(0.016, 0);
    const before = airflow._ribbonLines.map(R => Float32Array.from(R.positions));
    airflow._occupancy = windowStub(winLo, winHi);     // inject: isolates the update site
    airflow.update(0.016, 0);
    const moved = new Map();   // seed.y → boolean
    airflow._ribbonLines.forEach((R, k) => {
      const seed = airflow._seeds[R.seedIdx];
      if (seed.group !== 'ribbon') return;
      const path = airflow._paths[R.seedIdx];
      let m = moved.get(seed.y) || false;
      for (let i = 0; i < path.length; i++) {
        if (path[i].eta > -1.2) continue;              // upstream: vertex y === seed.y
        if (Math.abs(R.positions[i * 3 + 1] - before[k][i * 3 + 1]) > 0.06) m = true;
      }
      moved.set(seed.y, m);
    });
    return moved;
  }

  /** Look up the moved flag for the seed height nearest yWant (must exist). */
  function movedNear(moved, yWant) {
    let best = null, bestD = Infinity;
    for (const y of moved.keys()) {
      const d = Math.abs(y - yWant);
      if (d < bestD) { bestD = d; best = y; }
    }
    expect(bestD).toBeLessThan(1e-3);
    return moved.get(best);
  }

  it('T2a F1 (+0.2787): world-window [0.25,0.45] nudges the pod row at car-local 0.06236, NOT the halo rows', async () => {
    const moved = await nudgedHeights(F1_BASE_Y, 0.25, 0.45);
    // pod1 seed y = 0.06236 → world 0.3411 ∈ window ⇒ nudged.
    expect(movedNear(moved, 0.06236)).toBe(true);
    // halo rows sit at CAR-LOCAL 0.293 / 0.393 (inside the window pre-fix!)
    // but world 0.572 / 0.672 — outside ⇒ must NOT be nudged.
    expect(movedNear(moved, 0.293)).toBe(false);
    expect(movedNear(moved, 0.393)).toBe(false);
  });

  it('T2b GT sign-flip (−0.25): world-window [0.00,0.10] nudges the halo-underside row, NOT the pod row', async () => {
    const moved = await nudgedHeights(GT_BASE_Y, 0.00, 0.10);
    // halo underside seed y = 0.293 → world 0.043 ∈ window ⇒ nudged.
    expect(movedNear(moved, 0.293)).toBe(true);
    // pod1 seed y = 0.06236 sits inside the window CAR-LOCALLY (pre-fix trap)
    // but world −0.1876 — outside ⇒ must NOT be nudged.
    expect(movedNear(moved, 0.06236)).toBe(false);
  });
});

describe('Occupancy frame offset — regressions (must hold before AND after)', () => {
  it('T3 slice scan applies +baseY exactly once (guards double-offset)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setBaseY(F1_BASE_Y);
    // P2.11 box (|x| ≤ 0.30, |z| ≤ 1.0) shifted into WORLD frame:
    // y ∈ [−0.10 + baseY, 0.20 + baseY] = [0.1787, 0.4787].
    const occupancy = {
      sample: (x, y, z) =>
        (Math.abs(x) <= 0.30 && y >= 0.1787 && y <= 0.4787 && Math.abs(z) <= 1.0) ? 1 : 0,
      gradient: () => ({ x: 0, y: 1, z: 0 }),
    };
    airflow.setCarType('F1', glbF1Measure(), occupancy);
    // pod band mean −0.058 → +baseY = 0.2207 ∈ box ⇒ occupancy-derived rw.
    // Double-offset would sample 0.4994 (> 0.4787, miss); zero-offset −0.058.
    const pod = airflow._sections.pod;
    expect(pod.rw * airflow._halfW).toBeLessThan(0.40);
    expect(pod.rw * airflow._halfW).toBeGreaterThan(0.25);
    // wing band mean −0.1943 → +baseY = 0.0844 below the box ⇒ bbox fallback.
    expect(airflow._sections.wing.rw).toBeCloseTo((0.90 + 0.05) / airflow._halfW, 3);
    // halo band mean 0.343 → +baseY = 0.6217 above the box ⇒ bbox fallback.
    expect(airflow._sections.halo.rw).toBeCloseTo((0.38 + 0.05) / airflow._halfW, 3);
  });

  it('T4 rain body-splash still samples RAW drop coords (rain is world-frame)', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    rain.setVisible(true);
    rain.setSpeed(200);   // sf 0.571 ≥ 0.15 coupling gate
    const calls = [];
    const occupancy = {
      sample: (x, y, z) => { calls.push({ x, y, z }); return 0; },
    };
    rain.setFlowCoupling(() => ({ vx: 0, vy: 0, vz: 0 }), occupancy, { halfW: 0.9, halfL: 2.4, topY: 1.6 });
    rain._dPos[0] = 0.2; rain._dPos[1] = 0.8; rain._dPos[2] = 0.1;   // park droplet 0
    const fallV = rain._dVels[0];
    rain.update(0.016, 0);
    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0];   // droplet 0 is sampled first
    // Raw integrated coords — no frame offset of any kind (Float32 storage,
    // so ±1e-5; a frame offset would be ≥ 0.25).
    expect(first.x).toBeCloseTo(0.2, 5);
    expect(first.y).toBeCloseTo(0.8 - 0.016 * fallV, 5);
    // And they match the droplet's post-update tail position byte-for-byte.
    expect(first.x).toBe(rain._dPos[0]);
    expect(first.y).toBe(rain._dPos[1]);
    expect(first.z).toBe(rain._dPos[2]);
  });

  it('T5 setBaseY change with occupancy present retriggers a build; no-op otherwise (defect O3)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure(), recorderStub());
    const count = airflow._traceCount;
    airflow.setBaseY(0.5);                 // changed + occupancy ⇒ rebuild
    expect(airflow._traceCount).toBeGreaterThan(count);
    const count2 = airflow._traceCount;
    airflow.setBaseY(0.5);                 // unchanged ⇒ no rebuild
    expect(airflow._traceCount).toBe(count2);
    expect(airflow.group.position.y).toBe(0.5);

    // Without occupancy: baseY changes never rebuild (visual lift only).
    const plain = new AirflowEffect(makeScene());
    plain.setCarType('F1', glbF1Measure());
    const countP = plain._traceCount;
    plain.setBaseY(0.3);
    expect(plain._traceCount).toBe(countP);
    expect(plain.group.position.y).toBe(0.3);
  });
});
