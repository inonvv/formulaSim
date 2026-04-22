import { describe, it, expect, vi, beforeEach } from 'vitest';

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

/* ── Three.js mock ────────────────────────────────────────────────── */
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
    this.castShadow = false;
    this.receiveShadow = false;
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

/* ── Mock airflow-core dependency ─────────────────────────────────── */
vi.mock('../airflow-core.js', () => ({
  topViewVelocity:     () => ({ vxi: 0, veta: 1 }),
  pressureCoeff:       () => 0,
  cpToColor:           () => ({ r: 0.5, g: 0.5, b: 0.5 }),
  vortexVelocity:      () => ({ vxi: 0.1, veta: 0.2 }),
  sideViewVelocity:    () => ({ veta: 1, vy: 0 }),
  // Return a multi-vertex path so ribbon-line rendering (needs ≥2 vertices)
  // can exercise the update loop in tests.
  traceStreamlinePath: (seedXi, seedEta) => {
    const path = [];
    for (let i = 0; i < 16; i++) {
      path.push({ xi: seedXi, eta: seedEta + i * 0.5, vxi: 0, veta: 1 });
    }
    return path;
  },
}));

/* ── Scene stub ───────────────────────────────────────────────────── */
function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

/* ── Tests ────────────────────────────────────────────────────────── */
describe('RainEffect', () => {
  it('constructs without throwing', async () => {
    const { RainEffect } = await import('../effects.js');
    const scene = makeScene();
    expect(() => new RainEffect(scene)).not.toThrow();
  });

  it('spray particle count > 0', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    expect(rain._sCount).toBeGreaterThan(0);
  });

  it('droplet vels are in range [6, 14]', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    for (const v of rain._dVels) {
      expect(v).toBeGreaterThanOrEqual(6);
      expect(v).toBeLessThanOrEqual(14);
    }
  });

  it('roosterCount > 0 after construction', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    expect(rain._roosterCount).toBeGreaterThan(0);
  });

  it('setCarType adopts measure.rearAxleZ and rearAxleX when supplied', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    // McLaren-style measure: rear axle Z = 2.10, X = 0.81
    rain.setCarType('F1', { rearAxleZ: 2.10, rearAxleX: 0.81 });
    expect(rain._rainPos.sprayZ).toBeCloseTo(2.10, 5);
    expect(rain._rainPos.sprayX).toBeCloseTo(0.81, 5);
    // Rooster preserves authored offset of ~0.07 outboard / ~0.13 aft from base RAIN_POS.F1
    expect(rain._rainPos.roosterX).toBeGreaterThan(rain._rainPos.sprayX);
    expect(rain._rainPos.roosterZ).toBeGreaterThan(rain._rainPos.sprayZ);
  });

  it('setCarType falls back to RAIN_POS when measure lacks axles', async () => {
    const { RainEffect } = await import('../effects.js');
    const rain = new RainEffect(makeScene());
    rain.setCarType('F2', {});     // measure without rearAxleZ
    // F2 authored: sprayZ = 1.38
    expect(rain._rainPos.sprayZ).toBeCloseTo(1.38, 5);
  });
});

describe('OptimalWeatherEffect', () => {
  it('setCarType repositions heat haze to rearAxleZ + 0.5', async () => {
    const { OptimalWeatherEffect } = await import('../effects.js');
    const opt = new OptimalWeatherEffect(makeScene(), {});
    opt.setCarType('F1', { rearAxleZ: 2.10 });
    expect(opt.hazeBlob.position.z).toBeCloseTo(2.60, 5);
  });

  it('setCarType leaves haze untouched when measure has no axles', async () => {
    const { OptimalWeatherEffect } = await import('../effects.js');
    const opt = new OptimalWeatherEffect(makeScene(), {});
    const zBefore = opt.hazeBlob.position.z;
    opt.setCarType('F1', {});
    expect(opt.hazeBlob.position.z).toBe(zBefore);
  });
});

describe('AirflowEffect', () => {
  it('_ribbonLines exists with one entry per seed', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(Array.isArray(airflow._ribbonLines)).toBe(true);
    expect(airflow._ribbonLines.length).toBe(airflow._seeds.length);
  });

  it('setBaseY lifts the group position.y so local coords land on ground plane', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow.group.position.y).toBe(0);
    airflow.setBaseY(0.283);
    expect(airflow.group.position.y).toBeCloseTo(0.283, 6);
  });

  it('setBaseY persists across setCarType', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setBaseY(0.42);
    airflow.setCarType('F2');
    expect(airflow.group.position.y).toBeCloseTo(0.42, 6);
  });

  it('setCarType accepts optional measure and stores it', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    const measure = { anchors: { halo: { x: 0, y: 0.373, z: -0.05 } } };
    airflow.setCarType('F2', measure);
    expect(airflow._measure).toBe(measure);
  });

  it('ribbon model: every seed is group "ribbon" (no anchor-clustered groups)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', { anchors: {
      frontWing:  { x: 0, y: 0.04,  z: -2.30 },
      rearWing:   { x: 0, y: 0.454, z:  2.412 },
      halo:       { x: 0, y: 0.373, z: -0.05 },
      sidepodTop: { x: 0, y: 0.28,  z:  0.0 },
      floor:      { x: 0, y: 0.014, z:  0.129 },
    } });
    for (const s of airflow._seeds) expect(s.group).toBe('ribbon');
  });

  it('ribbon model: 10 heights × 7 xiLanes = 70 seeds on F1 + McLaren measure', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', { anchors: {
      frontWing:  { x: 0, y: 0.04,  z: -2.30 },
      rearWing:   { x: 0, y: 0.454, z:  2.412 },
      halo:       { x: 0, y: 0.373, z: -0.05 },
      sidepodTop: { x: 0, y: 0.28,  z:  0.0 },
      floor:      { x: 0, y: 0.014, z:  0.129 },
    } });
    expect(airflow._seeds.length).toBe(70);
  });

  it('ribbon model: no seed belongs to a banned generic or anchor-clustered group', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', { anchors: {
      frontWing:  { x: 0, y: 0.04,  z: -2.30 },
      rearWing:   { x: 0, y: 0.454, z:  2.412 },
      halo:       { x: 0, y: 0.373, z: -0.05 },
      sidepodTop: { x: 0, y: 0.28,  z:  0.0 },
      floor:      { x: 0, y: 0.014, z:  0.129 },
    } });
    const banned = new Set([
      'top', 'side', 'body', 'fw', 'under', 'spine', 'far',
      'nose', 'flank', 'halo', 'rearWing', 'frontWing', 'rearWheelWake', 'floor',
    ]);
    for (const s of airflow._seeds) expect(banned.has(s.group)).toBe(false);
  });

  it('ribbon model: 7 lateral lanes at xi in [-1.4, -0.9, -0.45, 0, 0.45, 0.9, 1.4]', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    const xis = [...new Set(airflow._seeds.map(s => s.seedXi))].sort((a, b) => a - b);
    expect(xis.length).toBe(7);
    expect(xis[0]).toBeCloseTo(-1.40, 6);
    expect(xis[1]).toBeCloseTo(-0.90, 6);
    expect(xis[2]).toBeCloseTo(-0.45, 6);
    expect(xis[3]).toBeCloseTo( 0.00, 6);
    expect(xis[4]).toBeCloseTo( 0.45, 6);
    expect(xis[5]).toBeCloseTo( 0.90, 6);
    expect(xis[6]).toBeCloseTo( 1.40, 6);
  });

  it('ribbon model: vertical coverage spans floor-skim to well-above-halo', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    const haloY = 0.66;
    airflow.setCarType('F1', { anchors: {
      halo:  { x: 0, y: haloY, z: -0.05 },
      floor: { x: 0, y: 0.02,  z:  0.0  },
      frontWing: { x: 0, y: 0.04, z: -2.30 },
    } });
    const ys = airflow._seeds.map(s => s.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    expect(minY).toBeLessThan(0.10);             // near floor
    expect(maxY).toBeGreaterThan(haloY + 0.30);  // above halo
  });

  it('ribbon model: every seedEta is within ±0.1 of -8 (parallel upstream seeding)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    for (const s of airflow._seeds) {
      expect(Math.abs(s.seedEta + 8)).toBeLessThanOrEqual(0.1);
    }
  });

  it('ribbon model: seedEta jitter breaks perfect sync (distinct values present)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    const etas = new Set(airflow._seeds.map(s => s.seedEta));
    // With 40 seeds and deterministic jitter, at least half should be distinct.
    expect(etas.size).toBeGreaterThanOrEqual(20);
  });

  it('F1 vortexMaxRadius stays small enough to avoid front-wheel overlap', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    // 0.25 m is the tuning ceiling — above that, the spiral visibly
    // overlaps a tyre (radius ~0.345). Reassert as a regression guard.
    expect(airflow._vortexMaxRadius).toBeLessThanOrEqual(0.25);
  });
});

describe('AirflowEffect — vortexDefs role tagging', () => {
  it('F1 vortexDefs tag roles frontWing / rearWing / floor with expected counts', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    const defs = airflow._profile.vortexDefs;
    const frontWing = defs.filter(d => d.role === 'frontWing');
    const rearWing  = defs.filter(d => d.role === 'rearWing');
    const floor     = defs.filter(d => d.role === 'floor');
    expect(frontWing.length).toBe(2);
    expect(rearWing.length).toBe(2);
    expect(floor.length).toBe(2);
    // Every def must be tagged (no untagged leftovers).
    expect(defs.every(d => d.role === 'frontWing' || d.role === 'rearWing' || d.role === 'floor'))
      .toBe(true);
  });

  it('F2 vortexDefs tag roles frontWing / rearWing (no floor)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F2');
    const defs = airflow._profile.vortexDefs;
    expect(defs.filter(d => d.role === 'frontWing').length).toBe(2);
    expect(defs.filter(d => d.role === 'rearWing').length).toBe(2);
    expect(defs.filter(d => d.role === 'floor').length).toBe(0);
    expect(defs.every(d => d.role)).toBe(true);
  });

  it('F3 vortexDefs tagged rearWing', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F3');
    const defs = airflow._profile.vortexDefs;
    expect(defs.length).toBe(2);
    expect(defs.every(d => d.role === 'rearWing')).toBe(true);
  });

  it('GT vortexDefs tagged rearWing', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('GT');
    const defs = airflow._profile.vortexDefs;
    expect(defs.length).toBe(4);
    expect(defs.every(d => d.role === 'rearWing')).toBe(true);
  });
});

describe('AirflowEffect — vortex wz resolved from measure anchors', () => {
  it('F1 with measure: frontWing/rearWing wz snap to anchor.z, floor wz preserved', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', {
      anchors: {
        frontWing: { z: -2.297 },
        rearWing:  { z:  2.412 },
      },
    });
    const defs = airflow._vortexDefs;
    const fw = defs.filter(d => d.role === 'frontWing');
    const rw = defs.filter(d => d.role === 'rearWing');
    const fl = defs.filter(d => d.role === 'floor');
    expect(fw.length).toBe(2);
    expect(rw.length).toBe(2);
    expect(fl.length).toBe(2);
    for (const d of fw) expect(d.wz).toBeCloseTo(-2.297, 5);
    for (const d of rw) expect(d.wz).toBeCloseTo( 2.412, 5);
    // Floor authored wz = 0.50 — must be unchanged by measure.
    for (const d of fl) expect(d.wz).toBeCloseTo(0.50, 5);
  });

  it('profile.vortexDefs is NOT mutated — resolution returns a new array', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', {
      anchors: {
        frontWing: { z: -2.297 },
        rearWing:  { z:  2.412 },
      },
    });
    const authored = airflow._profile.vortexDefs;
    const authoredFw = authored.filter(d => d.role === 'frontWing');
    const authoredRw = authored.filter(d => d.role === 'rearWing');
    // Authored F1: frontWing wz = -2.60, rearWing wz = 1.85.
    for (const d of authoredFw) expect(d.wz).toBeCloseTo(-2.60, 5);
    for (const d of authoredRw) expect(d.wz).toBeCloseTo( 1.85, 5);
  });

  it('F2 without measure: authored wz preserved', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F2');
    const defs = airflow._vortexDefs;
    const fw = defs.filter(d => d.role === 'frontWing');
    const rw = defs.filter(d => d.role === 'rearWing');
    // Authored F2: frontWing wz = -2.36, rearWing wz = 1.70.
    for (const d of fw) expect(d.wz).toBeCloseTo(-2.36, 5);
    for (const d of rw) expect(d.wz).toBeCloseTo( 1.70, 5);
  });

  it('measure without frontWing/rearWing anchors: authored wz preserved', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', { anchors: { halo: { y: 0.373, z: -0.05 } } });
    const defs = airflow._vortexDefs;
    const fw = defs.filter(d => d.role === 'frontWing');
    const rw = defs.filter(d => d.role === 'rearWing');
    for (const d of fw) expect(d.wz).toBeCloseTo(-2.60, 5);
    for (const d of rw) expect(d.wz).toBeCloseTo( 1.85, 5);
  });
});

describe('AirflowEffect — Phase C modifiers from role-tagged anchors', () => {
  // Synthetic McLaren-style measure with role-tagged vent anchors +
  // frontWing/rearWing. Values roughly match docs/f1-bboxes.json.
  const mclarenMeasure = {
    anchors: {
      frontWing:       { x: 0,      y: 0.04,  z: -2.30 },
      rearWing:        { x: 0,      y: 0.454, z:  2.412 },
      sidepodInletL:   { x: -0.7,   y: 0.22,  z: -0.50, role: 'inlet'  },
      sidepodInletR:   { x:  0.7,   y: 0.22,  z: -0.50, role: 'inlet'  },
      sidepodExhaustL: { x: -0.6,   y: 0.27,  z:  1.33, role: 'outlet' },
      sidepodExhaustR: { x:  0.6,   y: 0.27,  z:  1.33, role: 'outlet' },
      airboxIntake:    { x: 0,      y: 0.673, z: -0.25, role: 'inlet'  },
      exhaustPipe:     { x: 0,      y: 0.154, z:  2.26, role: 'outlet' },
      frontBrakeDuctL: { x: -0.45,  y: 0.19,  z: -2.20, role: 'inlet'  },
      frontBrakeDuctR: { x:  0.45,  y: 0.19,  z: -2.20, role: 'inlet'  },
      rearBrakeDuctL:  { x: -0.90,  y: 0.754, z:  2.01, role: 'inlet'  },
      rearBrakeDuctR:  { x:  0.90,  y: 0.754, z:  2.01, role: 'inlet'  },
    },
  };

  it('populates _modifiers from role-tagged anchors (≥ 6 entries)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', mclarenMeasure);
    expect(Array.isArray(airflow._modifiers)).toBe(true);
    expect(airflow._modifiers.length).toBeGreaterThanOrEqual(6);
  });

  it('modifier mix includes expected sidepod inlets, exhausts, airbox, exhaust pipe, wing dipoles', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', mclarenMeasure);
    const mods = airflow._modifiers;
    const sinks  = mods.filter(m => m.type === 'sink');
    const srcs   = mods.filter(m => m.type === 'source');
    const vorts  = mods.filter(m => m.type === 'vortex');

    // Sink count = 2 sidepod inlets + airbox + 2 front brake ducts + 2 rear brake ducts = 7
    expect(sinks.length).toBeGreaterThanOrEqual(5);
    // Source count = 2 sidepod exhausts + exhaust pipe = 3
    expect(srcs.length).toBeGreaterThanOrEqual(3);
    // Vortex dipoles: frontWing + rearWing
    expect(vorts.length).toBe(2);
  });

  it('no _modifiers entries when no measure supplied', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');   // no measure
    expect(airflow._modifiers).toEqual([]);
  });

  it('getModifiers() returns the same array reference as _modifiers', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', mclarenMeasure);
    const mods = airflow.getModifiers();
    expect(mods).toBe(airflow._modifiers);
    expect(mods.length).toBeGreaterThan(0);
  });

  it('modifier (xi, eta) coordinates divide anchor (x, z) by (halfW, halfL)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1', mclarenMeasure);
    const halfW = airflow._halfW;
    const halfL = airflow._halfL;
    // Sidepod inlet L: anchor x=-0.7, z=-0.50 → xi=-0.7/halfW, eta=-0.50/halfL
    const sinkL = airflow._modifiers.find(m =>
      m.type === 'sink' && Math.abs(m.x - (-0.7 / halfW)) < 1e-6
    );
    expect(sinkL).toBeDefined();
    expect(sinkL.e).toBeCloseTo(-0.50 / halfL, 6);
    expect(sinkL.strength).toBeCloseTo(0.25, 6);
  });
});

describe('AirflowEffect — ribbon streamlines', () => {
  it('1. _guideLines is undefined — legacy tube system removed', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._guideLines).toBeUndefined();
  });

  it('2. smoke particle state is gone (no _smokePoints / _smokeLife / _smokeJx)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    expect(airflow._smokePoints).toBeUndefined();
    expect(airflow._smokeLife).toBeUndefined();
    expect(airflow._smokeJx).toBeUndefined();
  });

  it('3. each ribbon has line + inner halo + outer halo materials with additive blending', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    for (const R of airflow._ribbonLines) {
      expect(R.lineMat.vertexColors).toBe(true);
      expect(R.lineMat.transparent).toBe(true);
      expect(R.lineMat.blending).toBe(2);   // AdditiveBlending
      expect(R.lineMat.depthWrite).toBe(false);
      expect(R.haloMat.vertexColors).toBe(true);
      expect(R.haloMat.transparent).toBe(true);
      expect(R.haloMat.blending).toBe(2);
      expect(R.haloMat.map).toBeDefined();
      // Outer diffuse fog layer — bigger sprite, same texture, additive.
      expect(R.outerHaloMat.vertexColors).toBe(true);
      expect(R.outerHaloMat.transparent).toBe(true);
      expect(R.outerHaloMat.blending).toBe(2);
      expect(R.outerHaloMat.map).toBeDefined();
      expect(R.outerHaloMat.size).toBeGreaterThan(R.haloMat.size);
    }
  });

  it('4. each ribbon line has position+color buffers sized 3 × path.length', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    for (let s = 0; s < airflow._seeds.length; s++) {
      const R        = airflow._ribbonLines[s];
      const pathLen  = airflow._paths[s].length;
      expect(R.positions.length).toBe(pathLen * 3);
      expect(R.colors.length).toBe(pathLen * 3);
    }
  });

  it('5. ribbon vertex count is always >= 2 (degenerate 1-point paths filtered)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    for (const R of airflow._ribbonLines) {
      expect(R.positions.length / 3).toBeGreaterThanOrEqual(2);
    }
  });

  it('6. update writes position buffer and marks line + both halo layers needsUpdate', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setVisible(true);
    airflow.setSpeed(200);
    airflow.update(0.016, 0);
    const R = airflow._ribbonLines[0];
    expect(R.linePos.needsUpdate).toBe(true);
    expect(R.lineCol.needsUpdate).toBe(true);
    expect(R.haloPos.needsUpdate).toBe(true);
    expect(R.haloCol.needsUpdate).toBe(true);
    expect(R.outerHaloPos.needsUpdate).toBe(true);
    expect(R.outerHaloCol.needsUpdate).toBe(true);
    // At least one vertex moved away from the zero-initialised state.
    let nonZero = 0;
    for (let i = 0; i < R.positions.length; i++) {
      if (Math.abs(R.positions[i]) > 1e-9) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('7. puff phase advances with dt (flow animation is live)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setVisible(true);
    airflow.setSpeed(200);
    const R0 = airflow._ribbonLines[0];
    const before = R0.phase;
    airflow.update(0.016, 0);
    const after = R0.phase;
    expect(after).not.toBe(before);
  });

  it('8. ribbon opacity rises with speed and is higher at 350 than at 0', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setVisible(true);

    airflow.setSpeed(0);
    airflow.update(0.016, 0);
    const opacityAt0 = airflow._ribbonLines[0].lineMat.opacity;

    airflow.setSpeed(350);
    airflow.update(0.016, 0);
    const opacityAt350 = airflow._ribbonLines[0].lineMat.opacity;

    expect(opacityAt350).toBeGreaterThan(opacityAt0);
    expect(opacityAt350).toBeGreaterThan(0.5);
  });
});

