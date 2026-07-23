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
