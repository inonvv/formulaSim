/**
 * spray-rooster-mist.test.js — TDD for the spray/rooster presentation polish.
 * Plan: ~/.claude/plans/spray-rooster-polish.md
 *
 * Both tire spray and rooster tails become soft round shader sprites via a
 * shared mist material (the splash pool's pattern): per-particle aSize/aFade
 * attributes, radial smoothstep falloff, additive, depthWrite false.
 * PHYSICS BYTE-IDENTICAL — velocities, spawn/recycle rules untouched
 * (turn-effects.test.js guards those, unmodified).
 */
import { describe, it, expect, vi } from 'vitest';

/* ── DOM stub (canvas for puff textures) ──────────────────────────── */
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

/* ── Three.js mock (same shape as turn-effects.test.js) ───────────── */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };
  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  function Group() {
    this.name = ''; this.children = [];
    this.position = new Vec3(); this.rotation = new Euler(); this.visible = true;
  }
  Group.prototype.add      = function (...items) { this.children.push(...items); return this; };
  Group.prototype.remove   = function (item) { this.children = this.children.filter(c => c !== item); return this; };
  Group.prototype.traverse = function (fn) { fn(this); this.children.forEach(c => c?.traverse?.(fn)); };
  function Mesh(geo, mat) {
    this.name = ''; this.geometry = geo || {}; this.material = mat || {};
    this.position = new Vec3(); this.rotation = new Euler(); this.scale = new Vec3(1, 1, 1);
    this.castShadow = false; this.receiveShadow = false;
    this.children = []; this.visible = true; this.userData = {};
  }
  Mesh.prototype.add      = function (...items) { this.children.push(...items); return this; };
  Mesh.prototype.traverse = function (fn) { fn(this); this.children.forEach(c => c?.traverse?.(fn)); };
  function Points(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {}; this.children = []; this.visible = true;
  }
  Points.prototype.traverse = function (fn) { fn(this); };
  function Line(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {}; this.children = []; this.visible = true;
  }
  Line.prototype.traverse = function (fn) { fn(this); };
  function LineSegments(geo, mat) {
    this.geometry = geo || { attributes: {}, setAttribute() {} };
    this.material = mat || {}; this.children = []; this.visible = true;
  }
  LineSegments.prototype.traverse = function (fn) { fn(this); };
  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }
  function BufferAttribute(array, itemSize) {
    this.array = array; this.itemSize = itemSize; this.needsUpdate = false;
  }
  function PlaneGeometry(w, h, segW, segH) {
    const count = ((segW || 1) + 1) * ((segH || 1) + 1);
    this.attributes = { position: { array: new Float32Array(count * 3), count, needsUpdate: false } };
    this.setAttribute = function (name, attr) { this.attributes[name] = attr; };
    this.dispose = function () {};
  }
  function SphereGeometry() { this.attributes = {}; this.setAttribute = () => {}; this.dispose = () => {}; }
  function MeshStandardMaterial(o = {}) { Object.assign(this, o); this.dispose = () => {}; }
  function MeshBasicMaterial(o = {})    { Object.assign(this, o); this.dispose = () => {}; }
  function PointsMaterial(o = {})       { Object.assign(this, o); this.dispose = () => {}; }
  function LineBasicMaterial(o = {})    { Object.assign(this, o); this.dispose = () => {}; }
  function ShaderMaterial(o = {}) {
    this.uniforms = o.uniforms || {}; this.vertexShader = o.vertexShader || '';
    this.fragmentShader = o.fragmentShader || ''; this.transparent = o.transparent || false;
    this.blending = o.blending; this.depthWrite = o.depthWrite !== undefined ? o.depthWrite : true;
    this.side = o.side; this.dispose = () => {};
  }
  function Color(hex) { this.hex = hex; }
  function CanvasTexture(src) {
    this.image = src || {}; this.needsUpdate = false;
    this.wrapS = this.wrapT = 0; this.minFilter = this.magFilter = 0; this.dispose = () => {};
  }
  return {
    Group, Mesh, Points, Line, LineSegments,
    BufferGeometry, BufferAttribute, PlaneGeometry, SphereGeometry,
    MeshStandardMaterial, MeshBasicMaterial, PointsMaterial, LineBasicMaterial, ShaderMaterial,
    Color, CanvasTexture,
    MathUtils: { degToRad: d => d * Math.PI / 180 },
    Vector3: Vec3, Euler,
    NormalBlending: 1, AdditiveBlending: 2, DoubleSide: 2, BackSide: 1, FrontSide: 0,
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

function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

async function makeRain() {
  const { RainEffect } = await import('../effects.js');
  return new RainEffect(makeScene());
}

/* Park spray/rooster particles mid-flight so update() can't respawn them. */
function park(rain) {
  for (let i = 0; i < rain._sCount; i++) {
    rain._sPos[i * 3 + 1] = 1.0;
    rain._sVels[i * 3 + 1] = 0;
  }
  for (let i = 0; i < rain._roosterCount; i++) {
    rain._roosterPos[i * 3 + 1] = 1.0;
    rain._roosterPos[i * 3 + 2] = 0.0;
    rain._roosterVels[i * 3 + 1] = 0;
  }
}

const MIST_TINT = 0xc4d8e6;

describe('Spray/rooster mist — shared soft-sprite shader', () => {
  it('spray + rooster + splash all use the round-falloff shader material', async () => {
    const rain = await makeRain();
    for (const mat of [rain._sMat, rain._roosterMat, rain._splashPoints.material]) {
      expect(mat.vertexShader).toContain('aSize');
      expect(mat.vertexShader).toContain('gl_PointSize');
      expect(mat.fragmentShader).toContain('gl_PointCoord');
      expect(mat.fragmentShader).toContain('smoothstep');   // round feathered falloff
      expect(mat.fragmentShader).toContain('discard');
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.blending).toBe(2);   // AdditiveBlending in the mock
    }
    // Shared helper ⇒ identical shader source across all three.
    expect(rain._sMat.fragmentShader).toBe(rain._splashPoints.material.fragmentShader);
    expect(rain._roosterMat.fragmentShader).toBe(rain._splashPoints.material.fragmentShader);
  });

  it('palette: spray/rooster tinted 0xc4d8e6, splash keeps 0xbfd8e8', async () => {
    const rain = await makeRain();
    expect(rain._sMat.uniforms.uColor.value.hex).toBe(MIST_TINT);
    expect(rain._roosterMat.uniforms.uColor.value.hex).toBe(MIST_TINT);
    expect(rain._splashPoints.material.uniforms.uColor.value.hex).toBe(0xbfd8e8);
  });

  it('per-particle aSize/aFade attributes exist with length == particle count', async () => {
    const rain = await makeRain();
    expect(rain.spray.geometry.attributes.aSize.array.length).toBe(rain._sCount);
    expect(rain.spray.geometry.attributes.aFade.array.length).toBe(rain._sCount);
    expect(rain._roosterPoints.geometry.attributes.aSize.array.length).toBe(rain._roosterCount);
    expect(rain._roosterPoints.geometry.attributes.aFade.array.length).toBe(rain._roosterCount);
  });
});

describe('Spray mist — life-driven growth and fade', () => {
  it('aSize grows 0.035 → 0.10 with _sprayLife; aFade = 1 − life', async () => {
    const rain = await makeRain();
    rain.setVisible(true);
    rain.setSpeed(180);
    park(rain);
    rain._sprayLife.fill(0);
    rain.update(0.01, 0);                    // life advances by dt·2 = 0.02
    const aSize = rain.spray.geometry.attributes.aSize.array;
    const aFade = rain.spray.geometry.attributes.aFade.array;
    expect(aSize[0]).toBeCloseTo(0.035 + 0.065 * 0.02, 5);
    expect(aFade[0]).toBeCloseTo(1 - 0.02, 5);
    const s1 = aSize[0], f1 = aFade[0];
    rain.update(0.01, 0);                    // life 0.04 — grows, fades
    expect(aSize[0]).toBeGreaterThan(s1);
    expect(aFade[0]).toBeLessThan(f1);
    expect(aSize[0]).toBeCloseTo(0.035 + 0.065 * 0.04, 5);
  });

  it('uOpacity follows sf·0.65 (no more flat PointsMaterial size/opacity)', async () => {
    const rain = await makeRain();
    rain.setVisible(true);
    rain.setSpeed(180);
    park(rain);
    rain.update(0.01, 0);
    expect(rain._sMat.uniforms.uOpacity.value).toBeCloseTo((180 / 350) * 0.65, 5);
  });
});

describe('Rooster mist — plume growth, gate, recycle', () => {
  it('_roosterLife ages at 1.4/s; aSize 0.04 → 0.15; aFade = 1 − life', async () => {
    const rain = await makeRain();
    rain.setVisible(true);
    rain.setSpeed(180);
    park(rain);
    rain._roosterLife.fill(0);
    rain.update(0.01, 0);                    // life = 0.014
    const aSize = rain._roosterPoints.geometry.attributes.aSize.array;
    const aFade = rain._roosterPoints.geometry.attributes.aFade.array;
    expect(aSize[0]).toBeCloseTo(0.04 + 0.11 * 0.014, 5);
    expect(aFade[0]).toBeCloseTo(1 - 0.014, 5);
    const s1 = aSize[0];
    rain.update(0.01, 0);
    expect(aSize[0]).toBeGreaterThan(s1);
    expect(aSize[0]).toBeCloseTo(0.04 + 0.11 * 0.028, 5);
  });

  it('life clamps at 1 (fully faded) even before bounds recycle', async () => {
    const rain = await makeRain();
    rain.setVisible(true);
    rain.setSpeed(180);
    park(rain);
    rain._roosterLife.fill(0.999);
    rain.update(0.01, 0);
    expect(rain._roosterLife[0]).toBe(1);
    expect(rain._roosterPoints.geometry.attributes.aFade.array[0]).toBe(0);
  });

  it('uOpacity = sf·0.75 above 20 km/h; 0 at or below the existing gate', async () => {
    const rain = await makeRain();
    rain.setVisible(true);
    rain.setSpeed(15);
    rain.update(0.01, 0);
    expect(rain._roosterMat.uniforms.uOpacity.value).toBe(0);
    rain.setSpeed(180);
    park(rain);
    rain.update(0.01, 0);
    expect(rain._roosterMat.uniforms.uOpacity.value).toBeCloseTo((180 / 350) * 0.75, 5);
  });

  it('bounds recycle stays authoritative and resets life to 0', async () => {
    const rain = await makeRain();
    rain.setVisible(true);
    rain.setSpeed(180);
    park(rain);
    rain._roosterLife.fill(0.5);
    rain._roosterPos[1] = -0.2;              // below the y < −0.1 recycle bound
    rain.update(0.01, 0);
    expect(rain._roosterLife[0]).toBe(0);    // respawned ⇒ fresh plume
    // Respawned at the wheel: z back near roosterZ (±0.1 jitter)
    expect(Math.abs(rain._roosterPos[2] - rain._rainPos.roosterZ)).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});

describe('Physics untouched (presentation-only change)', () => {
  it('spray/rooster spawn velocity ranges are byte-identical to before', async () => {
    const rain = await makeRain();
    for (let i = 0; i < rain._sCount; i++) {
      const side = rain._sPos[i * 3] < 0 ? -1 : 1;
      expect(side * rain._sVels[i * 3]).toBeGreaterThanOrEqual(0.2);
      expect(side * rain._sVels[i * 3]).toBeLessThanOrEqual(0.8);
      expect(rain._sVels[i * 3 + 1]).toBeGreaterThanOrEqual(1.0);
      expect(rain._sVels[i * 3 + 1]).toBeLessThanOrEqual(3.0);
    }
    for (let i = 0; i < rain._roosterCount; i++) {
      expect(rain._roosterVels[i * 3 + 1]).toBeGreaterThanOrEqual(0);
      expect(rain._roosterVels[i * 3 + 1]).toBeLessThanOrEqual(4);
      expect(rain._roosterVels[i * 3 + 2]).toBeGreaterThanOrEqual(2);
      expect(rain._roosterVels[i * 3 + 2]).toBeLessThanOrEqual(5);
    }
  });
});
