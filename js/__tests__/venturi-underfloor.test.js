/**
 * venturi-underfloor.test.js — Venturi-accurate underfloor airflow (F1 + GT)
 *
 * Physics contract (Bernoulli): Cp = 1 − (V/V∞)²  ⟹  V/V∞ = √(1 − Cp).
 * The underfloor ribbons must:
 *   • pass UNDER the car (not divert around it like the cylinder flow),
 *   • accelerate through the venturi throat / diffuser inlet per the
 *     regression-locked CP_TABLES[type].under in cfd-effect.js,
 *   • rise through the diffuser ramp at the rear,
 *   • tint toward the CFD suction palette at speed, white at rest.
 *
 * Unlike effects.test.js this file does NOT mock airflow-core.js or
 * cfd-effect.js — the numbers below are real end-to-end math.
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

/* ── Three.js mock (same shape as effects.test.js) ────────────────── */
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

/* ── Helpers ──────────────────────────────────────────────────────── */
const F1_HALF_L = 2.45;

function underfloorSeedIdx(airflow, xi = 0) {
  return airflow._seeds.findIndex(s => s.group === 'underfloor' && Math.abs(s.seedXi - xi) < 1e-6);
}

/** Index of the path vertex whose car-frame z is nearest `zTarget`. */
function vertexNearZ(path, halfL, zTarget) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = Math.abs(path[i].eta * halfL - zTarget);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* ════════════════════════════════════════════════════════════════ */
/*  1. Pure venturi math — real CP_TABLES end-to-end                */
/* ════════════════════════════════════════════════════════════════ */
describe('venturi speed ratios from real CP_TABLES', () => {
  it('F1: diffuser-inlet peak (z=2.0, Cp −1.10) → V/V∞ ≈ 1.4491', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    const { venturiSpeedRatio } = await import('../airflow-core.js');
    const cp = lerpCpProfile(2.0, 'F1', 'under');
    expect(cp).toBeCloseTo(-1.10, 6);
    expect(venturiSpeedRatio(cp)).toBeCloseTo(Math.sqrt(2.10), 4);
  });

  it('F1: throat accelerates ≥1.25× over mid-floor (z=2.0 vs z=0)', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    const { venturiSpeedRatio } = await import('../airflow-core.js');
    const mid  = venturiSpeedRatio(lerpCpProfile(0.0, 'F1', 'under'));  // Cp −0.31 → 1.1446
    const peak = venturiSpeedRatio(lerpCpProfile(2.0, 'F1', 'under'));  // Cp −1.10 → 1.4491
    expect(mid).toBeCloseTo(Math.sqrt(1.31), 4);
    expect(peak / mid).toBeGreaterThan(1.25);
  });

  it('GT: splitter peak (z=−2.05, Cp −1.25) → 1.50; diffuser peak (z=2.0, Cp −1.15) → 1.4663', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    const { venturiSpeedRatio } = await import('../airflow-core.js');
    expect(venturiSpeedRatio(lerpCpProfile(-2.05, 'GT', 'under'))).toBeCloseTo(1.5, 4);
    expect(venturiSpeedRatio(lerpCpProfile( 2.00, 'GT', 'under'))).toBeCloseTo(Math.sqrt(2.15), 4);
  });

  it('GT: flat mid-floor is slower than both peaks (venturi shape, not uniform)', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    const { venturiSpeedRatio } = await import('../airflow-core.js');
    const mid = venturiSpeedRatio(lerpCpProfile(0.6, 'GT', 'under'));   // Cp −0.45 → 1.2042
    expect(mid).toBeCloseTo(Math.sqrt(1.45), 4);
    expect(venturiSpeedRatio(lerpCpProfile(-2.05, 'GT', 'under'))).toBeGreaterThan(mid);
    expect(venturiSpeedRatio(lerpCpProfile( 2.00, 'GT', 'under'))).toBeGreaterThan(mid);
  });
});

/* ════════════════════════════════════════════════════════════════ */
/*  1b. Dedicated venturi channel profile (F1)                      */
/*  The F1 CFD body table has a +0.90/−2.20 front-wing stagnation   */
/*  spike at z −2.8/−2.6 — physical for the WING, but channel flow  */
/*  in the floor gap never sees it. The channel profile must be a   */
/*  textbook venturi: smooth acceleration to a single throat peak   */
/*  at the diffuser inlet, then pressure recovery.                  */
/* ════════════════════════════════════════════════════════════════ */
describe('underfloorChannelCp — venturi-shaped channel profile', () => {
  it('F1: single suction peak Cp −1.10 at the throat (z=1.4) → 1.4491×', async () => {
    const { underfloorChannelCp } = await import('../effects.js');
    const { venturiSpeedRatio } = await import('../airflow-core.js');
    expect(underfloorChannelCp(1.4, 'F1')).toBeCloseTo(-1.10, 6);
    expect(venturiSpeedRatio(-1.10)).toBeCloseTo(Math.sqrt(2.10), 4);
  });

  it('F1: no stagnation spike anywhere in the channel (Cp ≤ 0.06 throughout)', async () => {
    const { underfloorChannelCp } = await import('../effects.js');
    for (let z = -3.0; z <= 2.6; z += 0.05) {
      expect(underfloorChannelCp(z, 'F1')).toBeLessThanOrEqual(0.06);
    }
  });

  it('F1: monotonic acceleration from entry to throat, then recovery (no double hump)', async () => {
    const { underfloorChannelCp } = await import('../effects.js');
    let prev = underfloorChannelCp(-3.0, 'F1');
    for (let z = -2.9; z <= 1.4 + 1e-9; z += 0.05) {
      const cp = underfloorChannelCp(z, 'F1');
      expect(cp).toBeLessThanOrEqual(prev + 1e-9);   // Cp falls ⟹ speed rises
      prev = cp;
    }
    // Recovery after the throat: pressure climbs back toward freestream.
    expect(underfloorChannelCp(2.2, 'F1')).toBeGreaterThan(underfloorChannelCp(1.4, 'F1'));
    expect(Math.abs(underfloorChannelCp(2.6, 'F1'))).toBeLessThan(0.1);
  });

  it('GT delegates to the calibrated GT under table (splitter aero is real)', async () => {
    const { underfloorChannelCp } = await import('../effects.js');
    const { lerpCpProfile } = await import('../cfd-effect.js');
    expect(underfloorChannelCp(-2.05, 'GT')).toBeCloseTo(lerpCpProfile(-2.05, 'GT', 'under'), 10);
    expect(underfloorChannelCp( 2.00, 'GT')).toBeCloseTo(lerpCpProfile( 2.00, 'GT', 'under'), 10);
  });
});

/* ════════════════════════════════════════════════════════════════ */
/*  2. Exported effects.js helpers                                  */
/* ════════════════════════════════════════════════════════════════ */
describe('underfloorCp — windowed, speed-scaled ground effect', () => {
  it('full strength inside the car footprint at speedFactor 1', async () => {
    const { underfloorCp } = await import('../effects.js');
    expect(underfloorCp(1.4, 'F1', F1_HALF_L, 1)).toBeCloseTo(-1.10, 4);
  });

  it('scales with speedFactor² like the CFD ground effect', async () => {
    const { underfloorCp } = await import('../effects.js');
    expect(underfloorCp(1.4, 'F1', F1_HALF_L, 0.5)).toBeCloseTo(-1.10 * 0.25, 4);
    expect(underfloorCp(1.4, 'F1', F1_HALF_L, 0)).toBe(0);
  });

  it('fades to zero far upstream/downstream (window)', async () => {
    const { underfloorCp } = await import('../effects.js');
    expect(underfloorCp(-19.6, 'F1', F1_HALF_L, 1)).toBe(0);
    expect(underfloorCp( 19.6, 'F1', F1_HALF_L, 1)).toBe(0);
  });
});

describe('underfloorY — flat floor then diffuser ramp', () => {
  it('flat at the seed height before the ramp', async () => {
    const { underfloorY } = await import('../effects.js');
    expect(underfloorY(-2.0, 0.02)).toBeCloseTo(0.02, 6);
    expect(underfloorY( 0.0, 0.02)).toBeCloseTo(0.02, 6);
    expect(underfloorY( 1.4, 0.02)).toBeCloseTo(0.02, 6);
  });

  it('rises monotonically through the diffuser ramp', async () => {
    const { underfloorY } = await import('../effects.js');
    const y0 = underfloorY(1.4, 0.02);
    const y1 = underfloorY(2.0, 0.02);
    const y2 = underfloorY(2.6, 0.02);
    expect(y1).toBeGreaterThan(y0);
    expect(y2).toBeGreaterThan(y1);
    expect(y2 - y0).toBeGreaterThan(0.2);   // meaningful upwash, ≥20 cm
  });
});

/* ════════════════════════════════════════════════════════════════ */
/*  3. AirflowEffect integration — real flow math, mocked three     */
/* ════════════════════════════════════════════════════════════════ */
describe('AirflowEffect underfloor ribbons', () => {
  it('F1 and GT both get a dedicated underfloor seed group', async () => {
    const { AirflowEffect } = await import('../effects.js');
    for (const type of ['F1', 'GT']) {
      const airflow = new AirflowEffect(makeScene());
      airflow.setCarType(type);
      const uf = airflow._seeds.filter(s => s.group === 'underfloor');
      expect(uf.length).toBeGreaterThanOrEqual(3);
      for (const s of uf) {
        expect(s.y).toBeGreaterThan(0);
        expect(s.y).toBeLessThan(0.10);   // in the floor gap, not on the bodywork
      }
    }
  });

  it('underfloor path passes UNDER the car — reaches the diffuser without diverting', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    const idx  = underfloorSeedIdx(airflow, 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    const path = airflow._paths[idx];
    // With the cylinder potential flow a centreline (xi=0) seed would
    // stagnate at the nose (r²≤1 stop). The venturi channel must not.
    const etas = path.map(p => p.eta);
    expect(Math.min(...etas)).toBeLessThanOrEqual(-2.1);   // starts ahead of the nose…
    expect(Math.min(...etas)).toBeGreaterThanOrEqual(-2.5); // …but no 20 m painted rails
    expect(Math.max(...etas)).toBeGreaterThanOrEqual(2.7); // well past the diffuser
    for (const p of path) expect(Math.abs(p.xi)).toBeLessThan(1);  // stays in the channel
  });

  it('channel converges into the throat and expands out of the diffuser (lateral pinch)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    const idx  = underfloorSeedIdx(airflow, 0.7);   // outermost lane
    expect(idx).toBeGreaterThanOrEqual(0);
    const path = airflow._paths[idx];
    const xiStart  = Math.abs(path[0].xi);
    const xiThroat = Math.abs(path[vertexNearZ(path, airflow._halfL, 1.4)].xi);
    const xiExit   = Math.abs(path[path.length - 1].xi);
    expect(xiThroat).toBeLessThan(xiStart);         // converging inlet
    expect(xiExit).toBeGreaterThan(xiStart);        // diffuser expansion
    expect(xiExit).toBeLessThan(1);                 // still inside the flow plane
  });

  it('streak brightness fades in at the start and out at the end (no painted rails)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);
    airflow.setSpeed(350);
    const idx = underfloorSeedIdx(airflow, 0);
    const R   = airflow._ribbonLines.find(r => r.seedIdx === idx);
    const N   = airflow._paths[idx].length;
    R.phase = Math.floor(N / 2);                    // park the pulse mid-line
    airflow.update(0.0001, 0);
    const g = i => R.colors[i * 3 + 1];
    expect(g(0)).toBeLessThan(0.05);                // entry emerges from nothing
    expect(g(N - 1)).toBeLessThan(0.05);            // tail dissolves
    expect(g(Math.floor(N / 2))).toBeGreaterThan(0.5);  // core fully visible
  });

  it('suction tint never fully saturates — white smoke identity is kept', async () => {
    const { underfloorTintMix } = await import('../effects.js');
    expect(underfloorTintMix(-1.10)).toBeLessThanOrEqual(0.85);
    expect(underfloorTintMix(-5.0)).toBeLessThanOrEqual(0.85);   // hard cap
    expect(underfloorTintMix(-1.10)).toBeGreaterThan(0.3);       // still clearly tinted
    expect(underfloorTintMix(-0.3)).toBeLessThan(underfloorTintMix(-1.10)); // monotonic
    expect(underfloorTintMix(0)).toBe(0);
  });

  it('at speed, ribbon world-Y rises through the diffuser (upwash)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);
    airflow.setSpeed(350);
    airflow.update(0.016, 0);

    const idx  = underfloorSeedIdx(airflow, 0);
    const path = airflow._paths[idx];
    const R    = airflow._ribbonLines.find(r => r.seedIdx === idx);
    const iMid  = vertexNearZ(path, airflow._halfL, 0.0);
    const iExit = vertexNearZ(path, airflow._halfL, 2.6);
    const yMid  = R.positions[iMid  * 3 + 1];
    const yExit = R.positions[iExit * 3 + 1];
    expect(yExit - yMid).toBeGreaterThan(0.2);
  });

  it('suction tint at the diffuser inlet at speed; white-ish at rest', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);

    const idx  = underfloorSeedIdx(airflow, 0);
    const path = airflow._paths[idx];
    const iPeak = vertexNearZ(path, airflow._halfL, 1.4);   // throat = suction peak
    const R = airflow._ribbonLines.find(r => r.seedIdx === idx);

    // At rest: no ground effect, base near-white tint (r ≈ 0.92·bright).
    airflow.setSpeed(0);
    airflow.update(0.016, 0);
    const rRest = R.colors[iPeak * 3];
    const gRest = R.colors[iPeak * 3 + 1];
    expect(rRest / gRest).toBeGreaterThan(0.9);

    // At full speed: Cp −1.10 pulls the vertex toward the CFD suction
    // palette (green-cyan at that Cp) — red channel collapses.
    airflow.setSpeed(350);
    airflow.update(0.016, 0.016);
    const rFast = R.colors[iPeak * 3];
    const gFast = R.colors[iPeak * 3 + 1];
    expect(rFast / gFast).toBeLessThan(0.6);
  });

  it('underfloor ribbons are crisp — no fog halo layers (fog ribbons keep theirs)', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    for (const R of airflow._ribbonLines) {
      const isUF = airflow._seeds[R.seedIdx].group === 'underfloor';
      if (isUF) {
        expect(R.halo).toBeNull();
        expect(R.outerHalo).toBeNull();
      } else {
        expect(R.halo).toBeTruthy();
        expect(R.outerHalo).toBeTruthy();
      }
    }
  });

  it('underfloor streaks carry a tight glow layer — thickness without fog', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);
    airflow.setSpeed(350);
    airflow.update(0.016, 0);
    for (const R of airflow._ribbonLines) {
      const isUF = airflow._seeds[R.seedIdx].group === 'underfloor';
      if (isUF) {
        expect(R.glow).toBeTruthy();
        expect(R.glowMat.size).toBeLessThanOrEqual(0.25);      // tight, not a fog puff
        expect(R.glowMat.opacity).toBeGreaterThanOrEqual(0.5); // punches through at speed
        expect(R.glowMat.blending).toBe(2);                    // additive
        // Glow samples the SAME tinted color buffer — no separate haze buffer.
        expect(R.glowCol.array).toBe(R.colors);
      } else {
        expect(R.glow).toBeNull();
      }
    }
  });

  it('underfloor line is markedly more opaque than the fog ribbon cores at speed', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);
    airflow.setSpeed(350);
    airflow.update(0.016, 0);
    const Ruf = airflow._ribbonLines.find(r => airflow._seeds[r.seedIdx].group === 'underfloor');
    const Rrb = airflow._ribbonLines.find(r => airflow._seeds[r.seedIdx].group === 'ribbon');
    expect(Ruf.lineMat.opacity).toBeGreaterThanOrEqual(0.85);
    expect(Rrb.lineMat.opacity).toBeLessThanOrEqual(0.70);
  });

  it('underfloor baseline brightness is raised — visible streak even off-pulse', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);
    airflow.setSpeed(0);   // no tint, pure baseline
    const Ruf = airflow._ribbonLines.find(r => airflow._seeds[r.seedIdx].group === 'underfloor');
    const Rrb = airflow._ribbonLines.find(r => airflow._seeds[r.seedIdx].group === 'ribbon');
    Ruf.phase = 0;
    Rrb.phase = 0;
    airflow.update(0.016, 0);
    // Sample a vertex far from the pulse: brightness ≈ baseline.
    const iFarUf = Math.floor(airflow._paths[Ruf.seedIdx].length / 2);
    const iFarRb = Math.floor(airflow._paths[Rrb.seedIdx].length / 2);
    expect(Ruf.colors[iFarUf * 3 + 1]).toBeGreaterThan(0.6);   // g ≈ 0.95 × 0.70 boosted
    expect(Rrb.colors[iFarRb * 3 + 1]).toBeLessThan(0.4);      // g ≈ 0.95 × 0.35
  });

  it('puff pulse advances ~1.45× faster at the F1 throat than freestream', async () => {
    const { AirflowEffect } = await import('../effects.js');
    const airflow = new AirflowEffect(makeScene());
    airflow.setCarType('F1');
    airflow.setVisible(true);
    airflow.setSpeed(350);   // speedFactor 1 → full ground effect

    const idx  = underfloorSeedIdx(airflow, 0);
    const path = airflow._paths[idx];
    const iPeak = vertexNearZ(path, airflow._halfL, 1.4);
    const Ruf = airflow._ribbonLines.find(r => r.seedIdx === idx);
    const Rrb = airflow._ribbonLines.find(r => airflow._seeds[r.seedIdx].group === 'ribbon');

    Ruf.phase = iPeak;
    Rrb.phase = 1;
    const dt = 0.001;                       // small: pulse stays at the peak vertex
    airflow.update(dt, 0);
    const dUf = (Ruf.phase - iPeak + path.length) % path.length;
    const dRb = (Rrb.phase - 1 + airflow._paths[Rrb.seedIdx].length) % airflow._paths[Rrb.seedIdx].length;

    // The expected speed-up is Bernoulli at the ACTUAL vertex z (the grid
    // vertex nearest z=1.4 can sit slightly off the Cp peak), from the
    // dedicated channel profile — NOT the CFD body table.
    const { underfloorChannelCp } = await import('../effects.js');
    const { venturiSpeedRatio }   = await import('../airflow-core.js');
    const zActual  = path[iPeak].eta * airflow._halfL;
    const expected = venturiSpeedRatio(underfloorChannelCp(zActual, 'F1'));
    expect(expected).toBeGreaterThan(1.2);            // meaningfully inside the suction zone
    expect(dUf / dRb).toBeCloseTo(expected, 2);       // pulse speed IS the Bernoulli ratio
  });

  it('no stall-and-whip: pulse rate varies smoothly through the nose region', async () => {
    // With the old body table the ratio went 0.32× → 1.79× within 20 cm.
    const { underfloorChannelCp } = await import('../effects.js');
    const { venturiSpeedRatio }   = await import('../airflow-core.js');
    let prev = venturiSpeedRatio(underfloorChannelCp(-3.0, 'F1'));
    for (let z = -2.95; z <= 0; z += 0.05) {
      const r = venturiSpeedRatio(underfloorChannelCp(z, 'F1'));
      expect(Math.abs(r - prev)).toBeLessThan(0.06);  // ≤ 0.06× jump per 5 cm
      prev = r;
    }
  });
});
