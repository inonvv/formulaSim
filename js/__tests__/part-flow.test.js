/**
 * part-flow.test.js — Per-part airflow precision (wing / halo / sidepods / tires),
 * speed-coherent flow shape, rain↔airflow coupling.
 *
 * Plan: airflow-part-precision.md. Like venturi-underfloor.test.js this file
 * mocks ONLY three — airflow-core / cfd-effect / track-path math runs REAL,
 * end-to-end, so every tolerance below is an actual physical readout.
 *
 * Frame ground truth (GLB F1, body-centered — see plan §2):
 *   ground contact y = −0.6187, bodyShell y ∈ [−0.4674, +0.4958],
 *   halo peak y = +0.373, frontWing bbox y ∈ [−0.4163, −0.0524],
 *   front axle z ≈ −1.47 / x ±0.82, rear axle z ≈ +2.10 / x ±0.80,
 *   wheel r ≈ 0.345 ⇒ axle y ≈ −0.274, tire top y ≈ +0.071.
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

/* ── Three.js mock (same shape as venturi-underfloor.test.js) ─────── */
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

/* ── GLB-F1-shaped measure fixture (body-centered frame, plan §2) ─── */
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
      // Role-tagged vents (manifest-shaped, car-local, body-centered y)
      sidepodInletL:   { x: -0.70, y: 0.0142, z: -0.40, role: 'inlet'  },
      sidepodInletR:   { x:  0.70, y: 0.0142, z: -0.40, role: 'inlet'  },
      sidepodExhaustL: { x: -0.60, y: 0.0642, z:  1.20, role: 'outlet' },
      sidepodExhaustR: { x:  0.60, y: 0.0642, z:  1.20, role: 'outlet' },
      airboxIntake:    { x: 0,     y: 0.673,  z: -0.11, role: 'inlet'  },
      exhaustPipe:     { x: 0,     y: 0.154,  z:  2.26, role: 'outlet' },
      frontBrakeDuctL: { x: -0.45, y: -0.274, z: -2.20, role: 'inlet'  },
      frontBrakeDuctR: { x:  0.45, y: -0.274, z: -2.20, role: 'inlet'  },
      rearBrakeDuctL:  { x: -0.90, y: -0.274, z:  2.01, role: 'inlet'  },
      rearBrakeDuctR:  { x:  0.90, y: -0.274, z:  2.01, role: 'inlet'  },
    },
  };
}

const uniqueRibbonHeights = (airflow) =>
  [...new Set(airflow._seeds.filter(s => s.group === 'ribbon').map(s => s.y))].sort((a, b) => a - b);

/* ════════════════════════════════════════════════════════════════ */
/*  Phase 1 — frame fix: anchor-only seed heights + correct _halfH  */
/* ════════════════════════════════════════════════════════════════ */
describe('Phase 1 — anchor-derived seed heights (GLB F1 body-centered frame)', () => {
  it('P1.1 wing band gets ≥2 heights inside [fw.minY+0.05, fw.maxY+0.03] (D2: was 0)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const lo = -0.4163 + 0.05, hi = -0.0524 + 0.03;
    const inBand = uniqueRibbonHeights(airflow).filter(y => y >= lo && y <= hi);
    expect(inBand.length).toBeGreaterThanOrEqual(2);
  });

  it('P1.2 sidepod flank band gets ≥2 heights inside [−0.32, +0.07] (D3: was 0)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const inBand = uniqueRibbonHeights(airflow).filter(y => y >= -0.32 && y <= 0.07);
    expect(inBand.length).toBeGreaterThanOrEqual(2);
  });

  it('P1.3 axle band gets a height at groundContactY + wheelRadius (≈ −0.274)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const axleY = -0.6187 + 0.345;
    const hit = uniqueRibbonHeights(airflow).find(y => Math.abs(y - axleY) < 1e-6);
    expect(hit).toBeDefined();
  });

  it('P1.4 _halfH is ground-referenced: (halo.y − groundContactY)/1.93 ∈ [0.45, 0.60] (D5: was 0.193)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    expect(airflow._halfH).toBeCloseTo((0.373 + 0.6187) / 1.93, 5);
    expect(airflow._halfH).toBeGreaterThanOrEqual(0.45);
    expect(airflow._halfH).toBeLessThanOrEqual(0.60);
  });

  it('P1.5 no hardcoded ground-frame heights (0.18 / 0.30 / 0.42-floor) survive on the GLB measure', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const heights = uniqueRibbonHeights(airflow);
    for (const banned of [0.18, 0.30, 0.42]) {
      expect(heights.some(y => Math.abs(y - banned) < 1e-6)).toBe(false);
    }
    // The whole lower half (wing + axle + pod-lower) sits BELOW body center —
    // impossible with the old ground-frame constants (all ≥ 0.08).
    expect(heights.filter(y => y < -0.1).length).toBeGreaterThanOrEqual(3);
  });

  it('P1.6 halo-referenced upper heights are preserved exactly (haloY −0.08 … +0.50)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const heights = uniqueRibbonHeights(airflow);
    for (const off of [-0.08, 0.02, 0.15, 0.30, 0.50]) {
      expect(heights.some(y => Math.abs(y - (0.373 + off)) < 1e-6)).toBe(true);
    }
  });

  it('P1.7 procedural regression: no-bbox fallback keeps 0.18/0.30 sidepod + halo bands, all ≥ ground', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');   // no measure → _fallbackAnchors (ground frame)
    const heights = uniqueRibbonHeights(airflow);
    const haloY = 0.55 * 1.93;
    expect(heights.some(y => Math.abs(y - 0.18) < 1e-6)).toBe(true);
    expect(heights.some(y => Math.abs(y - 0.30) < 1e-6)).toBe(true);
    for (const off of [-0.08, 0.02, 0.15, 0.30, 0.50]) {
      expect(heights.some(y => Math.abs(y - (haloY + off)) < 1e-6)).toBe(true);
    }
    // Ground frame: nothing below the track surface.
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.02);
    // Haze budget: ≤ 10 ribbon heights.
    expect(heights.length).toBeLessThanOrEqual(10);
  });

  it('P1.8 procedural _halfH keeps the profile value when no measure exists', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    expect(airflow._halfH).toBeCloseTo(0.55, 5);
  });

  it('P1.9 haze budget: ribbon heights ≤ 10 on the GLB measure too', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    expect(uniqueRibbonHeights(airflow).length).toBeLessThanOrEqual(10);
  });
});

/* ════════════════════════════════════════════════════════════════ */
/*  Phase 2 — height-aware body cross-section (halo engagement)     */
/* ════════════════════════════════════════════════════════════════ */

// GLB F1 flow-plane dims (bodyShell half-width / max wing |z|).
const HALF_W = 0.8125;
const HALF_L = 2.412;

// Halo cross-section per plan: halfwidth 0.38 m, z −0.47…0.65, +0.05 skim
// inflation on rw.
const HALO_BODY = {
  rw:   (0.38 + 0.05) / HALF_W,
  rl:   ((0.65 + 0.47) / 2) / HALF_L,
  etaC: ((0.65 - 0.47) / 2) / HALF_L,
};

describe('Phase 2 — topViewVelocity height-aware body (pure math)', () => {
  it('P2.1 default args are bit-identical to the closed-form unit cylinder', async () => {
    const { topViewVelocity } = await import('../airflow-core.js');
    for (let xi = -2; xi <= 2; xi += 0.23) {
      for (let eta = -3; eta <= 3; eta += 0.31) {
        const v  = topViewVelocity(xi, eta);
        const r2 = xi * xi + eta * eta;
        if (r2 <= 1) {
          expect(v.vxi).toBe(0);
          expect(v.veta).toBe(0);
        } else {
          const r4 = r2 * r2;
          expect(v.vxi).toBe(-2 * xi * eta / r4);
          expect(v.veta).toBe(1 - (eta * eta - xi * xi) / r4);
        }
      }
    }
  });

  it('P2.2 body {rw:1, rl:1, etaC:0} reproduces the default exactly', async () => {
    const { topViewVelocity } = await import('../airflow-core.js');
    for (const [xi, eta] of [[0.5, -2], [1.2, 0.3], [-0.8, 1.7], [0.1, -0.4]]) {
      const a = topViewVelocity(xi, eta);
      const b = topViewVelocity(xi, eta, { rw: 1, rl: 1, etaC: 0 });
      expect(b.vxi).toBe(a.vxi);
      expect(b.veta).toBe(a.veta);
    }
  });

  it('P2.3 empty body ({rw:0}) means NO body: pure freestream everywhere', async () => {
    const { topViewVelocity } = await import('../airflow-core.js');
    const v = topViewVelocity(0.1, 0.0, { rw: 0, rl: 0, etaC: 0 });
    expect(v.vxi).toBe(0);
    expect(v.veta).toBe(1);
  });

  it('P2.4 D1 fix: halo-band streamline skims the 0.38 m cockpit — clearance ∈ [0, 0.12] m (was 0.43)', async () => {
    const { traceStreamlinePath } = await import('../airflow-core.js');
    const seedXi = 0.1;

    // Clearance is measured at the THROAT (|eta − etaC| ≤ 0.4·rl) where the
    // halo body really is 0.38 m wide — the flow body is a lens, so window
    // ends legitimately taper below the bbox halfwidth.
    const clearOf = (path) => {
      let minClear = Infinity;
      for (const p of path) {
        if (Math.abs(p.eta - HALO_BODY.etaC) > 0.4 * HALO_BODY.rl) continue;
        const c = Math.abs(p.xi) * HALF_W - 0.38;
        if (c < minClear) minClear = c;
      }
      return minClear;
    };

    // OLD whole-car cylinder: line bulges around halfW (0.8125), leaving a
    // ≈0.43 m air gap to the halo surface.
    const oldClear = clearOf(traceStreamlinePath(seedXi, -3, 400, 0.05));
    expect(oldClear).toBeGreaterThan(0.30);   // documents defect D1

    // NEW per-height scaled cylinder: line pinches to the cockpit and skims.
    const newClear = clearOf(traceStreamlinePath(seedXi, -3, 400, 0.05, { body: HALO_BODY }));
    console.info(`[part-flow] halo clearance: old ${oldClear.toFixed(3)} m -> new ${newClear.toFixed(3)} m`);
    expect(newClear).toBeGreaterThanOrEqual(0);
    expect(newClear).toBeLessThanOrEqual(0.12);
  });

  it('P2.5 streamline never enters the scaled body core', async () => {
    const { traceStreamlinePath } = await import('../airflow-core.js');
    const path = traceStreamlinePath(0.05, -3, 400, 0.05, { body: HALO_BODY });
    for (const p of path) {
      const xs = p.xi / HALO_BODY.rw;
      const es = (p.eta - HALO_BODY.etaC) / HALO_BODY.rl;
      expect(xs * xs + es * es).toBeGreaterThan(0.98);
    }
  });
});

describe('Phase 2 — per-band cross-section table (effects integration)', () => {
  it('P2.6 halo band section derives from the halo bbox (rw ≈ 0.53, rl ≈ 0.23)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const sec = airflow._sections.halo;
    expect(sec).toBeTruthy();
    expect(sec.rw).toBeCloseTo((0.38 + 0.05) / airflow._halfW, 3);
    expect(sec.rl).toBeCloseTo(0.56 / airflow._halfL, 3);
    expect(sec.etaC).toBeCloseTo(0.09 / airflow._halfL, 3);
  });

  it('P2.7 wing band section spans the frontWing bbox; pod/axle bands use the bodyShell bbox', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const wing = airflow._sections.wing;
    expect(wing.rw).toBeCloseTo((0.90 + 0.05) / airflow._halfW, 3);
    expect(wing.etaC).toBeCloseTo(((-2.55 - 2.04) / 2) / airflow._halfL, 3);
    const pod = airflow._sections.pod;
    expect(pod.rw).toBeCloseTo((0.8125 + 0.05) / airflow._halfW, 3);
    expect(airflow._sections.axle).toEqual(pod);
  });

  it('P2.8 free/upper bands above the bodywork get an EMPTY section (no body bulge)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    expect(airflow._sections.free.rw).toBe(0);
    expect(airflow._sections.upper.rw).toBe(0);
    // Straightness of the freestream line is asserted in Phase 3 (D7) once
    // modifier y-gating stops ungated vents from tugging it.
  });

  it('P2.9 halo-band traced path pinches inside the old whole-car bulge', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const haloIdx = airflow._seeds.findIndex(s => s.band === 'halo' && Math.abs(s.seedXi - 0.45) < 1e-6);
    expect(haloIdx).toBeGreaterThanOrEqual(0);
    const path = airflow._paths[haloIdx];
    // Max lateral excursion stays well inside the whole-car cylinder bulge
    // (old model pushed |xi| beyond 1.0 at the body).
    const maxAbsXi = Math.max(...path.map(p => Math.abs(p.xi)));
    expect(maxAbsXi).toBeLessThan(0.95);
  });

  it('P2.10 procedural (no bboxes) keeps the whole-car cylinder — sections all null', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');   // fallback anchors carry no bboxes
    for (const band of ['wing', 'axle', 'pod', 'halo', 'upper', 'free']) {
      expect(airflow._sections[band] ?? null).toBeNull();
    }
  });

  it('P2.11 occupancy slice scan wins over bbox fallback where the slice is occupied', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    // Fake occupancy: a 0.30 m half-width box spanning y ∈ [−0.10, 0.20],
    // z ∈ [−1.0, 1.0] (narrower than the bodyShell bbox in x and z).
    const occupancy = {
      sample: (x, y, z) =>
        (Math.abs(x) <= 0.30 && y >= -0.10 && y <= 0.20 && Math.abs(z) <= 1.0) ? 1 : 0,
      gradient: () => ({ x: 0, y: 1, z: 0 }),
    };
    airflow.setCarType('F1', glbF1Measure(), occupancy);
    // pod band (mean y ≈ −0.058) intersects the box → occupancy-derived rw
    // (0.30 box − ≤1 grid step + 0.05 inflation), far under the 0.86 bbox rw.
    const pod = airflow._sections.pod;
    expect(pod.rw * airflow._halfW).toBeLessThan(0.40);
    expect(pod.rw * airflow._halfW).toBeGreaterThan(0.25);
    // wing band (y ≈ −0.25) is below the box → falls back to the wing bbox.
    expect(airflow._sections.wing.rw).toBeCloseTo((0.90 + 0.05) / airflow._halfW, 3);
  });
});
