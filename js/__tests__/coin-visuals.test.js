/**
 * coin-visuals.test.js — thin-THREE coin renderer (js/coin-visuals.js).
 *
 * Coins live in trackGroup (plan decision 2): the pool is positioned via the
 * REAL rowPose/TrackPath math each frame, so the world offset −playerX is
 * inherited from the group transform. Three is mocked (as in sibling
 * suites); on a straight path rowPose(s, lat) = (x: lat, z: −s), which pins
 * the placement without a renderer.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s) { this.x = s; this.y = s; this.z = s; return this; };
  class Group {
    constructor() { this.children = []; this.name = ''; this.visible = true; }
    add(...o) { this.children.push(...o); return this; }
  }
  class Object3DLike {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material;
      this.position = new Vec3(); this.rotation = { x: 0, y: 0, z: 0, order: 'XYZ' };
      this.scale = new Vec3(1, 1, 1);
      this.visible = true; this.userData = {};
    }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  }
  class MaterialBase {
    constructor(params = {}) { Object.assign(this, params); }
    clone() { return new this.constructor({ ...this }); }
  }
  return {
    Vector3: Vec3,
    Group,
    Mesh: class extends Object3DLike {},
    Points: class extends Object3DLike {},
    TorusGeometry: class { constructor(r, tube) { this.r = r; this.tube = tube; } },
    BufferGeometry,
    BufferAttribute,
    MeshStandardMaterial: class extends MaterialBase {},
    PointsMaterial: class extends MaterialBase {},
    AdditiveBlending: 2,
  };
});

import { buildCoinVisuals, COIN_VIS } from '../coin-visuals.js';
import { TrackPath } from '../track-path.js';

function straightPath() { return new TrackPath(() => 0.5); }   // no turns emitted yet

describe('buildCoinVisuals — pool', () => {
  it('builds a hidden pool of COIN_VIS.POOL toruses inside the parent group', () => {
    const parent = { children: [], add(o) { this.children.push(o); } };
    const cv = buildCoinVisuals(parent);
    expect(parent.children).toContain(cv.group);
    expect(cv.meshes.length).toBe(COIN_VIS.POOL);
    cv.meshes.forEach(m => expect(m.visible).toBe(false));
  });

  it('update places coins at rowPose (straight path: x = lat, z = −s) at hover height', () => {
    const parent = { children: [], add() {} };
    const cv = buildCoinVisuals(parent);
    const path = straightPath();
    const field = { coins: [{ id: 1, s: 100, lat: 3 }, { id: 2, s: 110, lat: -5 }] };
    cv.update(field, path, 0, 0.016, true);
    const [a, b] = cv.meshes;
    expect(a.visible).toBe(true);
    expect(a.position.x).toBeCloseTo(3, 6);
    expect(a.position.z).toBeCloseTo(-100, 6);
    expect(Math.abs(a.position.y - COIN_VIS.HOVER_Y)).toBeLessThanOrEqual(COIN_VIS.BOB_AMP + 1e-9);
    expect(b.position.x).toBeCloseTo(-5, 6);
    expect(b.position.z).toBeCloseTo(-110, 6);
    // unused slots stay hidden
    cv.meshes.slice(2).forEach(m => expect(m.visible).toBe(false));
  });

  it('spins at 2.5 rad/s and hides everything when not visible', () => {
    const parent = { children: [], add() {} };
    const cv = buildCoinVisuals(parent);
    const path = straightPath();
    const field = { coins: [{ id: 1, s: 50, lat: 0 }] };
    cv.update(field, path, 1, 0.016, true);
    const r1 = cv.meshes[0].rotation.y;
    cv.update(field, path, 2, 0.016, true);
    expect(cv.meshes[0].rotation.y - r1).toBeCloseTo(COIN_VIS.SPIN, 6);
    cv.update(field, path, 3, 0.016, false);
    cv.meshes.forEach(m => expect(m.visible).toBe(false));
  });
});

describe('buildCoinVisuals — collection pop', () => {
  it('pop() shows a burst at the coin position; the slot recycles after SPARK_TIME', () => {
    const parent = { children: [], add() {} };
    const cv = buildCoinVisuals(parent);
    const path = straightPath();
    cv.pop({ id: 1, s: 20, lat: 2 }, path);
    const slot = cv.pops.find(p => p.t >= 0);
    expect(slot).toBeTruthy();
    expect(slot.torus.visible).toBe(true);
    expect(slot.points.visible).toBe(true);
    expect(slot.torus.position.x).toBeCloseTo(2, 6);
    expect(slot.torus.position.z).toBeCloseTo(-20, 6);

    // scale pops 1 → 1.4 → 0 over POP_TIME
    cv.update({ coins: [] }, path, 0, COIN_VIS.POP_TIME * 0.4, true);
    expect(slot.torus.scale.x).toBeCloseTo(1.4, 2);
    cv.update({ coins: [] }, path, 0, COIN_VIS.POP_TIME * 0.6, true);
    expect(slot.torus.scale.x).toBeLessThan(0.05);

    // sparkles fade out and free the slot
    cv.update({ coins: [] }, path, 0, COIN_VIS.SPARK_TIME, true);
    expect(slot.t).toBe(-1);
    expect(slot.points.visible).toBe(false);
    expect(slot.torus.visible).toBe(false);
  });

  it('plan pins: 1.0 m coin diameter, spin 2.5 rad/s, bob ±0.1 m @ 1.5 Hz, pop 0.25 s, 6–10 sparks', () => {
    expect(2 * (COIN_VIS.RADIUS + COIN_VIS.TUBE)).toBeCloseTo(1.0, 6);
    expect(COIN_VIS.SPIN).toBe(2.5);
    expect(COIN_VIS.BOB_AMP).toBe(0.1);
    expect(COIN_VIS.BOB_HZ).toBe(1.5);
    expect(COIN_VIS.POP_TIME).toBe(0.25);
    expect(COIN_VIS.SPARKS).toBeGreaterThanOrEqual(6);
    expect(COIN_VIS.SPARKS).toBeLessThanOrEqual(10);
  });
});
