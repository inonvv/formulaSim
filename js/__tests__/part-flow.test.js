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

  it('P2.9 some halo-band lane passes within 0.55 m of centreline at the cockpit throat (old model: ≥ 0.81 m)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const sec = airflow._sections.halo;
    // Closest lateral approach of any halo-band lane inside the throat
    // window. With the whole-car cylinder every line bulged to ≥ halfW
    // (0.8125 m); with the cockpit cross-section inner lanes skim the halo.
    let closest = Infinity;
    airflow._seeds.forEach((s, i) => {
      if (s.band !== 'halo') return;
      for (const p of airflow._paths[i]) {
        if (Math.abs(p.eta - sec.etaC) > 0.4 * sec.rl) continue;
        closest = Math.min(closest, Math.abs(p.xi) * airflow._halfW);
      }
    });
    expect(closest).toBeLessThan(0.55);
    expect(closest).toBeGreaterThanOrEqual(0.38);   // …but never clips the halo
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

/* ════════════════════════════════════════════════════════════════ */
/*  Phase 3 — per-part modifier gating + tire doublets + tire wakes */
/* ════════════════════════════════════════════════════════════════ */
describe('Phase 3 — modifier y-band gating', () => {
  it('P3.1 vent modifiers carry a yBand centred on their anchor height', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const sinks = airflow._modifiers.filter(m => m.type === 'sink' || m.type === 'source');
    expect(sinks.length).toBeGreaterThanOrEqual(6);
    for (const m of sinks) {
      expect(Array.isArray(m.yBand)).toBe(true);
      expect(m.yBand[0]).toBeLessThan(m.yBand[1]);
    }
    // Sidepod inlet (anchor y 0.0142) → band [−0.2358, +0.1942].
    const podSink = airflow._modifiers.find(m =>
      m.type === 'sink' && Math.abs(m.x - (-0.70 / airflow._halfW)) < 1e-6);
    expect(podSink.yBand[0]).toBeCloseTo(0.0142 - 0.25, 5);
    expect(podSink.yBand[1]).toBeCloseTo(0.0142 + 0.18, 5);
  });

  it('P3.2 brake ducts are banded to the measured AXLE height, not their authored anchor y', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const axleY = -0.6187 + 0.345;
    // rear brake duct anchors are authored high (y −0.274 here matches axle
    // in the fixture, but the CODE must bind to measured axleY).
    const ducts = airflow._modifiers.filter(m =>
      m.type === 'sink' && Math.abs(Math.abs(m.x) - 0.90 / airflow._halfW) < 1e-6);
    expect(ducts.length).toBe(2);
    for (const d of ducts) {
      expect(d.yBand[0]).toBeCloseTo(axleY - 0.25, 5);
      expect(d.yBand[1]).toBeCloseTo(axleY + 0.25, 5);
    }
  });

  it('P3.3 wing vortices are banded to their bbox ± 0.1', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const vorts = airflow._modifiers.filter(m => m.type === 'vortex');
    expect(vorts.length).toBe(2);
    const fw = vorts.find(v => v.e < 0);
    expect(fw.yBand[0]).toBeCloseTo(-0.4163 - 0.1, 5);
    expect(fw.yBand[1]).toBeCloseTo(-0.0524 + 0.1, 5);
  });

  it('P3.4 D7 fix: freestream reference ribbon (haloY+0.50) is unbent — deviation ≤ 0.02 m (was shared with all mods)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const freeIdx = airflow._seeds.findIndex(s => s.band === 'free' && Math.abs(s.seedXi - 0.45) < 1e-6);
    expect(freeIdx).toBeGreaterThanOrEqual(0);
    const path = airflow._paths[freeIdx];
    let maxDev = 0;
    for (const p of path) maxDev = Math.max(maxDev, Math.abs(p.xi - 0.45) * airflow._halfW);
    expect(maxDev).toBeLessThanOrEqual(0.02);
  });

  it('P3.5 four tire doublets at measured wheel x/z, R 0.28 / rc 0.08, gated y ≤ tire top', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const tires = airflow._modifiers.filter(m => m.type === 'doublet');
    expect(tires.length).toBe(4);
    const tireTop = -0.6187 + 2 * 0.345;   // ≈ +0.0713
    const expected = [
      [-0.82, -1.47], [0.82, -1.47], [-0.80, 2.10], [0.80, 2.10],
    ];
    for (const [x, z] of expected) {
      const t = tires.find(m =>
        Math.abs(m.x - x / airflow._halfW) < 1e-6 && Math.abs(m.e - z / airflow._halfL) < 1e-6);
      expect(t).toBeDefined();
      expect(t.R).toBeCloseTo(0.28, 6);
      expect(t.rc).toBeCloseTo(0.08, 6);
      expect(t.yBand[1]).toBeCloseTo(tireTop, 4);
      expect(t.yBand[0]).toBeCloseTo(-0.6187, 4);
    }
  });

  it('P3.6 D4 fix: axle-height path near the wheel lane deviates ≥ 0.15 m and clears the wheel circle (was 0.00)', async () => {
    const { traceStreamlinePath } = await import('../airflow-core.js');
    const mods = [
      { type: 'doublet', x:  0.82 / HALF_W, e: -1.47 / HALF_L, R: 0.28, rc: 0.08 },
      { type: 'doublet', x: -0.82 / HALF_W, e: -1.47 / HALF_L, R: 0.28, rc: 0.08 },
      { type: 'doublet', x:  0.80 / HALF_W, e:  2.10 / HALF_L, R: 0.28, rc: 0.08 },
      { type: 'doublet', x: -0.80 / HALF_W, e:  2.10 / HALF_L, R: 0.28, rc: 0.08 },
    ];
    const seedX = 0.73;
    const path = traceStreamlinePath(seedX / HALF_W, -3, 800, 0.03, {
      body: { rw: 0, rl: 0, etaC: 0 },     // isolate the tire effect
      modifiers: mods, halfW: HALF_W, halfL: HALF_L,
    });
    let maxDev = 0, minClear = Infinity;
    for (const q of path) {
      const x = q.xi * HALF_W, z = q.eta * HALF_L;
      if (Math.abs(z + 1.47) <= 1.0) maxDev = Math.max(maxDev, Math.abs(x - seedX));
      minClear = Math.min(minClear, Math.hypot(x - 0.82, z + 1.47));
    }
    console.info(`[part-flow] tire deflection: ${maxDev.toFixed(3)} m, wheel clearance ${minClear.toFixed(3)} m`);
    expect(maxDev).toBeGreaterThanOrEqual(0.15);
    expect(minClear).toBeGreaterThanOrEqual(0.24);   // wheel R 0.28, regularized skim
  });

  it('P3.7 doublets without physical dims (CFD path) are inert — sumVelocity skips them', async () => {
    const { sumVelocity, topViewVelocity } = await import('../airflow-core.js');
    const mods = [{ type: 'doublet', x: 1.0, e: -0.6, R: 0.28, rc: 0.08, yBand: [-0.6, 0.07] }];
    const withD = sumVelocity(1.05, -0.61, topViewVelocity, mods);
    const bare  = sumVelocity(1.05, -0.61, topViewVelocity, []);
    expect(withD.vxi).toBe(bare.vxi);
    expect(withD.veta).toBe(bare.veta);
  });

  it('P3.8 CFD patch Cp is unchanged by yBand fields + doublet entries (no-CFD-change guarantee)', async () => {
    const { computePatchCp } = await import('../cfd-effect.js');
    const patch = { role: 'sidepodTop', x: 0.5, y: 0.3, z: 0.1, w: 0.4, h: 0.4 };
    const sinkPlain  = [{ type: 'sink', x: -0.78, e: -0.2, strength: 0.25, rc: 0.12 }];
    const sinkTagged = [
      { type: 'sink', x: -0.78, e: -0.2, strength: 0.25, rc: 0.12, yBand: [-0.25, 0.19] },
      { type: 'doublet', x: 1.0, e: -0.61, R: 0.28, rc: 0.08, yBand: [-0.62, 0.07] },
    ];
    const a = computePatchCp(patch, 0.2, 0.1, 0.8, sinkPlain,  [], 'F1');
    const b = computePatchCp(patch, 0.2, 0.1, 0.8, sinkTagged, [], 'F1');
    expect(b).toBeCloseTo(a, 12);
  });
});

describe('Phase 3 — tire-anchored wake emitters', () => {
  it('P3.9 wake emitters sit at the 4 measured wheel positions + rear body', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    const em = airflow._wakeEmitters;
    expect(em).toBeTruthy();
    expect(em.length).toBe(5);
    const axleY = -0.6187 + 0.345;
    const wheels = [
      [-0.82, -1.47], [0.82, -1.47], [-0.80, 2.10], [0.80, 2.10],
    ];
    for (const [x, z] of wheels) {
      const hit = em.find(e => Math.abs(e.x - x) < 1e-6 && Math.abs(e.z - z) < 1e-6);
      expect(hit).toBeDefined();
      expect(hit.y).toBeCloseTo(axleY, 5);
    }
    // 5th emitter: rear body, centred.
    const body = em.find(e => e.x === 0);
    expect(body).toBeDefined();
    expect(body.z).toBeGreaterThan(1.5);
  });

  it('P3.10 wake spread/length scale with speedFactor', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', glbF1Measure());
    expect(airflow._wakeSpread(1)).toBeGreaterThan(airflow._wakeSpread(0));
    expect(airflow._wakeLength(1)).toBeGreaterThan(airflow._wakeLength(0));
  });

  it('P3.11 procedural cars without axle measure keep the legacy wake (no emitters)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');   // no measure at all
    expect(airflow._wakeEmitters).toBeNull();
  });

  it('P3.12 underfloor group provably unaffected: paths identical with and without part modifiers', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const withVents = glbF1Measure();
    const noVents   = glbF1Measure();
    for (const k of Object.keys(noVents.anchors)) {
      if (noVents.anchors[k].role) delete noVents.anchors[k];
    }
    const a = new AirflowEffect(makeScene());
    a.setCarType('F1', withVents);
    const b = new AirflowEffect(makeScene());
    b.setCarType('F1', noVents);
    expect(a._modifiers.length).toBeGreaterThan(b._modifiers.length);
    const ufA = a._seeds.map((s, i) => i).filter(i => a._seeds[i].group === 'underfloor');
    const ufB = b._seeds.map((s, i) => i).filter(i => b._seeds[i].group === 'underfloor');
    expect(ufA.length).toBe(5);
    for (let k = 0; k < 5; k++) {
      const pa = a._paths[ufA[k]];
      const pb = b._paths[ufB[k]];
      expect(pa.length).toBe(pb.length);
      for (let i = 0; i < pa.length; i++) {
        expect(pa[i].xi).toBe(pb[i].xi);
        expect(pa[i].eta).toBe(pb[i].eta);
      }
    }
  });
});
