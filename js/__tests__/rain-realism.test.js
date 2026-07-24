import { describe, it, expect, vi } from 'vitest';

/* ═══════════════════════════════════════════════════════════════════
 * Rain realism — velocity-true streaks, drop-size distribution,
 * apparent-headwind sweep, upstream-biased respawn, ground splashes.
 * Plan: ~/.claude/plans/rain-realism.md
 * ═══════════════════════════════════════════════════════════════════ */

/* ── DOM stub — canvas needed by texture makers in node environment ── */
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
  sumVelocity:         (xi, eta, baseFn) => baseFn(xi, eta),
  venturiSpeedRatio:   cp => Math.sqrt(Math.max(0, 1 - cp)),
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

async function makeRain() {
  const { RainEffect } = await import('../effects.js');
  const rain = new RainEffect(makeScene());
  rain.setVisible(true);
  return rain;
}

const DT = 1 / 60;
const ENV = { halfW: 0.9, halfL: 2.4, topY: 1.6 };

/* Streak vector head − tail of drop i (Float32 storage). */
function streakVec(rain, i) {
  const dp = rain._dPos;
  return [
    dp[i * 6 + 3] - dp[i * 6],
    dp[i * 6 + 4] - dp[i * 6 + 1],
    dp[i * 6 + 5] - dp[i * 6 + 2],
  ];
}
const mag = v => Math.hypot(v[0], v[1], v[2]);

/* ═══════════════════════════════════════════════════════════════════
 * Commit 1 — droplet physics + rendering
 * ═══════════════════════════════════════════════════════════════════ */
describe('Rain realism — drop-size distribution', () => {
  it('fall speeds are terminal velocities in [4, 9] m/s', async () => {
    const rain = await makeRain();
    for (const v of rain._dVels) {
      expect(v).toBeGreaterThanOrEqual(4);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it('fall speed is monotonic in drop size (bigger ⇒ faster)', async () => {
    const rain = await makeRain();
    const idx = Array.from({ length: rain._dCount }, (_, i) => i)
      .sort((a, b) => rain._dSizes[a] - rain._dSizes[b]);
    for (let k = 1; k < idx.length; k++) {
      expect(rain._dVels[idx[k]]).toBeGreaterThanOrEqual(rain._dVels[idx[k - 1]]);
    }
    // And the exact law vFall = 4 + 5·s
    for (let i = 0; i < rain._dCount; i++) {
      expect(rain._dVels[i]).toBeCloseTo(4 + 5 * rain._dSizes[i], 5);
    }
  });

  it('small drops dominate (rnd² skew: median size below midpoint 0.625)', async () => {
    const rain = await makeRain();
    const below = Array.from(rain._dSizes).filter(s => s < 0.625).length;
    expect(below).toBeGreaterThan(rain._dCount * 0.6);
  });
});

describe('Rain realism — velocity-aligned streaks', () => {
  it('at sf 0 streaks are vertical (head directly below tail)', async () => {
    const rain = await makeRain();
    rain.setSpeed(0);
    rain.update(DT, 0);
    for (let i = 0; i < rain._dCount; i++) {
      const d = streakVec(rain, i);
      expect(d[0]).toBe(0);           // no lateral component
      expect(d[2]).toBe(0);           // no wind component
      expect(d[1]).toBeLessThan(0);   // head leads the fall
    }
  });

  it('at sf 1 (with fake coupling velocities) the streak is parallel to the drop velocity', async () => {
    const rain = await makeRain();
    rain.setSpeed(350);
    rain.setFlowCoupling(() => ({ vx: 0, vy: 0, vz: 0 }), null, ENV);
    // Park drop 0 inside the envelope with hand-set coupled velocities.
    rain._dPos[0] = 0.2; rain._dPos[1] = 5.0; rain._dPos[2] = 0.1;
    rain._dVelX[0] = 2.0;
    rain._dVelZ[0] = -4.0;
    rain.update(DT, 0);
    const d = streakVec(rain, 0);
    const vel = [2.0, -rain._dVels[0], 30 + (-4.0)];
    // Normalised cross product ≈ 0 ⇒ parallel. Float32 position storage
    // bounds the error (ulp(y≈5) ≈ 5e-7 per component ⇒ tol 1e-4, not the
    // plan's 1e-6 which only holds in double precision).
    const dm = mag(d), vm = mag(vel);
    const cross = [
      (d[1] * vel[2] - d[2] * vel[1]) / (dm * vm),
      (d[2] * vel[0] - d[0] * vel[2]) / (dm * vm),
      (d[0] * vel[1] - d[1] * vel[0]) / (dm * vm),
    ];
    expect(Math.abs(cross[0])).toBeLessThan(1e-4);
    expect(Math.abs(cross[1])).toBeLessThan(1e-4);
    expect(Math.abs(cross[2])).toBeLessThan(1e-4);
    // Same direction, not anti-parallel.
    expect(d[0] * vel[0] + d[1] * vel[1] + d[2] * vel[2]).toBeGreaterThan(0);
  });

  it('streak length ∈ [0.05, 0.9] and grows with speed (12 ms exposure)', async () => {
    const rain = await makeRain();
    rain.setSpeed(0);
    rain._dPos[0] = 0; rain._dPos[1] = 5; rain._dPos[2] = 0;
    rain.update(DT, 0);
    const len0 = mag(streakVec(rain, 0));
    for (let i = 0; i < rain._dCount; i++) {
      const L = mag(streakVec(rain, i));
      expect(L).toBeGreaterThanOrEqual(0.05 - 1e-6);
      expect(L).toBeLessThanOrEqual(0.9 + 1e-6);
    }
    // Expected: |v|·0.012 at rest = vFall·0.012
    expect(len0).toBeCloseTo(rain._dVels[0] * 0.012, 4);

    rain.setSpeed(350);
    rain._dPos[0] = 0; rain._dPos[1] = 5; rain._dPos[2] = 0;
    rain.update(DT, 0);
    const len1 = mag(streakVec(rain, 0));
    expect(len1).toBeGreaterThan(len0);
    // Expected: |(0, −vFall, 30)|·0.012
    const vm = Math.hypot(rain._dVels[0], 30);
    expect(len1).toBeCloseTo(vm * 0.012, 4);
  });
});

describe('Rain realism — apparent headwind sweep', () => {
  it('rearward drift integrates to ≈ 30 m/s over 1 s at sf 1', async () => {
    const rain = await makeRain();
    rain.setSpeed(350);
    // Slow faller parked far upstream so neither ground hit nor z-exit
    // recycles it during the 1 s integration.
    rain._dVels[0] = 5;
    rain._dPos[0] = 0; rain._dPos[1] = 8; rain._dPos[2] = -25;
    for (let k = 0; k < 60; k++) rain.update(DT, 0);
    const drift = rain._dPos[2] - (-25);
    expect(drift).toBeGreaterThan(29);
    expect(drift).toBeLessThan(31);
    // x untouched (no turn, no coupling)
    expect(rain._dPos[0]).toBe(0);
  });

  it('drops swept past the car (z > 7) wrap upstream at the SAME height (keeps car-height density)', async () => {
    // Deviation from the plan's sky respawn on z-exit: with a 30 m/s sweep
    // vs 4–9 m/s fall, sky-only re-entry can never reach car height ahead
    // of the car (diagonal slope vFall/W ≈ 0.22 ⇒ y < 2 only at z ≳ 1).
    // Wrapping z − 15 with y kept restores uniform density — the plan's own
    // R6 goal ("swept box stays filled around the car").
    const rain = await makeRain();
    rain.setSpeed(350);
    rain._dPos[0] = 0.4; rain._dPos[1] = 1.0; rain._dPos[2] = 7.2;
    rain.update(DT, 0);
    const zAfter = 7.2 + 30 * DT - 15;   // integrated then wrapped
    expect(rain._dPos[2]).toBeCloseTo(zAfter, 4);
    expect(rain._dPos[0]).toBeCloseTo(0.4, 5);                  // x kept
    expect(rain._dPos[1]).toBeCloseTo(1.0 - rain._dVels[0] * DT, 4); // y kept
  });

  it('ground respawn is upstream-biased: x ∈ [−6,6], y ∈ [4,9], z ∈ [−8,2]', async () => {
    const rain = await makeRain();
    rain.setSpeed(350);
    rain._dPos[0] = 1; rain._dPos[1] = -1; rain._dPos[2] = 0;
    rain.update(DT, 0);
    expect(rain._dPos[0]).toBeGreaterThanOrEqual(-6);
    expect(rain._dPos[0]).toBeLessThanOrEqual(6);
    expect(rain._dPos[1]).toBeGreaterThanOrEqual(4);
    expect(rain._dPos[1]).toBeLessThanOrEqual(9);
    expect(rain._dPos[2]).toBeGreaterThanOrEqual(-8);
    expect(rain._dPos[2]).toBeLessThanOrEqual(2);
  });
});

describe('Rain realism — look', () => {
  it('material: desaturated 0xbfd8e8, opacity 0.55, per-vertex colors', async () => {
    const rain = await makeRain();
    expect(rain._dMat.color).toBe(0xbfd8e8);
    expect(rain._dMat.opacity).toBeCloseTo(0.55, 5);
    expect(rain._dMat.vertexColors).toBe(true);
  });

  it('tail vertex is dimmer than head (0.35× motion-blur falloff); brightness scales with size', async () => {
    const rain = await makeRain();
    const colors = rain.droplets.geometry.attributes.color.array;
    for (let i = 0; i < rain._dCount; i++) {
      const tail = colors[i * 6];       // r of tail vertex
      const head = colors[i * 6 + 3];   // r of head vertex
      expect(tail).toBeLessThan(head);
      expect(tail).toBeCloseTo(head * 0.35, 5);
      expect(head).toBeCloseTo(0.45 + 0.55 * rain._dSizes[i], 5);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * Commit 2 — ground splashes
 * ═══════════════════════════════════════════════════════════════════ */
const SPLASH_LIFE = 0.25;
const activeSplashes = rain =>
  Array.from(rain._splashLife).filter(l => l < SPLASH_LIFE).length;

describe('Rain realism — ground splashes', () => {
  it('pool of 256 splash particles, all inactive at build', async () => {
    const rain = await makeRain();
    expect(rain._splashCount).toBe(256);
    expect(activeSplashes(rain)).toBe(0);
  });

  it('a ground hit spawns a splash at the impact x/z (±0.01)', async () => {
    const rain = await makeRain();
    rain.setSpeed(0);   // no rearward sweep ⇒ impact z is deterministic
    rain._dPos[0] = 1.5; rain._dPos[1] = -0.34; rain._dPos[2] = 0.5;
    rain.update(DT, 0);   // y falls ≥ 4/60 ⇒ crosses −0.35
    expect(activeSplashes(rain)).toBe(1);
    expect(rain._splashLife[0]).toBeLessThan(SPLASH_LIFE);
    expect(rain._splashPos[0]).toBeCloseTo(1.5, 2);
    expect(rain._splashPos[1]).toBeCloseTo(-0.34, 2);
    expect(rain._splashPos[2]).toBeCloseTo(0.5, 2);
    // Upward launch velocity in [0.3, 1.0]
    expect(rain._splashVy[0]).toBeGreaterThanOrEqual(0.3 - 9.8 * DT);
    expect(rain._splashVy[0]).toBeLessThanOrEqual(1.0);
  });

  it('splash expires within 0.3 s and returns to the pool', async () => {
    const rain = await makeRain();
    rain.setSpeed(0);
    rain._dPos[0] = 1.5; rain._dPos[1] = -0.34; rain._dPos[2] = 0.5;
    rain.update(DT, 0);
    expect(activeSplashes(rain)).toBe(1);
    // Park every drop high so no NEW splashes spawn during the wait.
    for (let i = 0; i < rain._dCount; i++) rain._dPos[i * 6 + 1] = 50;
    for (let k = 0; k < 21; k++) rain.update(DT, 0);   // 0.35 s
    expect(activeSplashes(rain)).toBe(0);
  });

  it('splash shrinks (0.05 → 0.02) and fades ((1 − u)·0.5) over its life', async () => {
    const rain = await makeRain();
    rain.setSpeed(0);
    rain._dPos[0] = 1.5; rain._dPos[1] = -0.34; rain._dPos[2] = 0.5;
    rain.update(DT, 0);
    for (let i = 0; i < rain._dCount; i++) rain._dPos[i * 6 + 1] = 50;
    rain.update(DT, 0);   // one aging step: u = DT / 0.25
    const u = DT / SPLASH_LIFE;
    expect(rain._splashSize[0]).toBeCloseTo(0.05 - 0.03 * u, 4);
    expect(rain._splashFade[0]).toBeCloseTo((1 - u) * 0.5, 4);
    rain.update(DT, 0);   // second step: strictly smaller/dimmer
    const u2 = 2 * DT / SPLASH_LIFE;
    expect(rain._splashSize[0]).toBeCloseTo(0.05 - 0.03 * u2, 4);
    expect(rain._splashFade[0]).toBeCloseTo((1 - u2) * 0.5, 4);
  });

  it('body-splash respawns do NOT spawn ground splashes', async () => {
    const rain = await makeRain();
    rain.setSpeed(200);   // sf ≥ 0.15 coupling gate
    const occupancy = { sample: (x, y, z) => (Math.abs(x) < 1 && y < 1 && Math.abs(z) < 2) ? 1 : 0 };
    rain.setFlowCoupling(() => ({ vx: 0, vy: 0, vz: 0 }), occupancy, ENV);
    rain._dPos[0] = 0.1; rain._dPos[1] = 0.6; rain._dPos[2] = 0.1;   // inside the body
    rain.update(DT, 0);
    expect(rain._dPos[1]).toBeGreaterThanOrEqual(4);   // body respawn happened
    expect(activeSplashes(rain)).toBe(0);              // ...without a ground splash
  });

  it('pool never exceeds 256 active splashes (ring buffer wraps)', async () => {
    const rain = await makeRain();
    rain.setSpeed(0);
    for (let i = 0; i < rain._dCount; i++) rain._dPos[i * 6 + 1] = -1;  // all hit
    rain.update(DT, 0);
    expect(activeSplashes(rain)).toBe(256);
    expect(rain._splashNext).toBe(rain._dCount % 256);   // wrapped 1200 → 176
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * P4 — wind gusts + density waves (deterministic, no RNG in update)
 * ═══════════════════════════════════════════════════════════════════ */
describe('Rain gusts — gustVector / rainDensity pure functions', () => {
  it('gustVector is deterministic and bounded: |gx| ≤ 2.2, |gz| ≤ 1.4', async () => {
    const { gustVector } = await import('../effects.js');
    for (let t = 0; t <= 600; t += 0.37) {
      const a = gustVector(t);
      const b = gustVector(t);
      expect(a.gx).toBe(b.gx);                 // deterministic
      expect(a.gz).toBe(b.gz);
      expect(Math.abs(a.gx)).toBeLessThanOrEqual(2.2);
      expect(Math.abs(a.gz)).toBeLessThanOrEqual(1.4);
    }
    // Exact authored law at a spot value.
    const g = gustVector(5);
    expect(g.gx).toBeCloseTo(2.2 * Math.sin(0.31 * 5) * Math.sin(0.113 * 5 + 1.7), 10);
    expect(g.gz).toBeCloseTo(1.4 * Math.sin(0.23 * 5 + 0.9) * Math.sin(0.077 * 5), 10);
  });

  it('gust is zero-mean-ish over 600 s (|mean| < 0.15 per axis)', async () => {
    const { gustVector } = await import('../effects.js');
    let sx = 0, sz = 0, n = 0;
    for (let t = 0; t <= 600; t += 0.1) {
      const g = gustVector(t);
      sx += g.gx; sz += g.gz; n++;
    }
    expect(Math.abs(sx / n)).toBeLessThan(0.15);
    expect(Math.abs(sz / n)).toBeLessThan(0.15);
  });

  it('rainDensity stays within ±15% of 1', async () => {
    const { rainDensity } = await import('../effects.js');
    for (let t = 0; t <= 600; t += 0.31) {
      const d = rainDensity(t);
      expect(d).toBeGreaterThanOrEqual(0.85);
      expect(d).toBeLessThanOrEqual(1.15);
    }
  });
});

describe('Rain gusts — droplet integration', () => {
  it('streak head−tail includes the gust term: parallel to (gx, −vFall, wind+gz) at gusty t', async () => {
    const { gustVector } = await import('../effects.js');
    const g = gustVector(5);
    expect(Math.abs(g.gx)).toBeGreaterThan(1);   // t=5 is a strong-gust instant
    const rain = await makeRain();
    rain.setSpeed(350);                          // windRear 30, no coupling, no turn
    rain._dPos[0] = 0.2; rain._dPos[1] = 5.0; rain._dPos[2] = 0.1;
    rain.update(DT, 5);
    const d = streakVec(rain, 0);
    const vel = [g.gx, -rain._dVels[0], 30 + g.gz];
    const dm = mag(d), vm = mag(vel);
    const cross = [
      (d[1] * vel[2] - d[2] * vel[1]) / (dm * vm),
      (d[2] * vel[0] - d[0] * vel[2]) / (dm * vm),
      (d[0] * vel[1] - d[1] * vel[0]) / (dm * vm),
    ];
    expect(Math.abs(cross[0])).toBeLessThan(1e-4);
    expect(Math.abs(cross[1])).toBeLessThan(1e-4);
    expect(Math.abs(cross[2])).toBeLessThan(1e-4);
    expect(d[0] * vel[0] + d[1] * vel[1] + d[2] * vel[2]).toBeGreaterThan(0);
  });

  it('gust drifts droplet positions: x advances by gx·dt at gusty t', async () => {
    const { gustVector } = await import('../effects.js');
    const g = gustVector(5);
    const rain = await makeRain();
    rain.setSpeed(0);                            // isolate the gust from the sweep
    rain._dPos[0] = 0; rain._dPos[1] = 5; rain._dPos[2] = 0;
    rain.update(DT, 5);
    expect(rain._dPos[0]).toBeCloseTo(g.gx * DT, 5);
    expect(rain._dPos[2]).toBeCloseTo(g.gz * DT, 5);
  });

  it('droplet opacity = 0.55 × rainDensity(t), always within [0.55·0.85, 0.55·1.15]', async () => {
    const { rainDensity } = await import('../effects.js');
    const rain = await makeRain();
    for (const t of [0, 13, 27, 100, 314]) {
      rain.update(DT, t);
      expect(rain._dMat.opacity).toBeCloseTo(0.55 * rainDensity(t), 6);
      expect(rain._dMat.opacity).toBeGreaterThanOrEqual(0.55 * 0.85 - 1e-9);
      expect(rain._dMat.opacity).toBeLessThanOrEqual(0.55 * 1.15 + 1e-9);
    }
  });
});
