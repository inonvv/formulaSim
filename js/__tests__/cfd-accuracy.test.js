/**
 * cfd-accuracy.test.js — Per-car CFD physics accuracy.
 *
 * Three upgrades over the single-profile CFD:
 *   1. Per-car ROLE_CP + per-car/per-surface longitudinal Cp tables —
 *      an open-wheel ground-effect F1 and a closed-body GT3 RS must not
 *      share one pressure model.
 *   2. Patch envelope remap driven by measured anchors for EVERY car
 *      (was GT-only; F1 GLB measured envelope differs from authored).
 *   3. Vortex cores resolved from measured anchors (were hardcoded ~0.4 m
 *      off the measured wing positions).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };
  function Euler(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Euler.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  function Group() {
    this.name = ''; this.children = []; this.visible = true;
    this.position = new Vec3(); this.rotation = new Euler();
  }
  Group.prototype.add    = function (...items) { this.children.push(...items); return this; };
  Group.prototype.remove = function (item) { this.children = this.children.filter(c => c !== item); return this; };
  function Mesh(geo, mat) {
    this.geometry = geo || {}; this.material = mat || {};
    this.position = new Vec3(); this.rotation = new Euler(); this.scale = new Vec3(1, 1, 1);
    this.visible = true; this.userData = {}; this.children = [];
  }
  function Line(geo, mat) { this.geometry = geo || {}; this.material = mat || {}; this.visible = true; }
  function BufferGeometry() {
    this.attributes = {};
    this.setAttribute = function (n, a) { this.attributes[n] = a; };
    this.dispose = function () {};
  }
  function BufferAttribute(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  function PlaneGeometry(w, h, segW, segH) {
    const count = ((segW || 1) + 1) * ((segH || 1) + 1);
    this.attributes = { position: { array: new Float32Array(count * 3), count, needsUpdate: false } };
    this.setAttribute = function (n, a) { this.attributes[n] = a; };
    this.dispose = function () {};
  }
  function SphereGeometry() { this.attributes = {}; this.setAttribute = function () {}; this.dispose = function () {}; }
  function MeshBasicMaterial(o = {}) { Object.assign(this, o); this.dispose = () => {}; }
  function LineBasicMaterial(o = {}) { Object.assign(this, o); this.dispose = () => {}; }
  function Color() { this.r = 0; this.g = 0; this.b = 0; }
  return {
    Group, Mesh, Line, BufferGeometry, BufferAttribute, PlaneGeometry, SphereGeometry,
    MeshBasicMaterial, LineBasicMaterial, Color, Vector3: Vec3, Euler,
    AdditiveBlending: 2, DoubleSide: 2, BackSide: 1,
  };
});

vi.mock('../airflow-core.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    cpToColor:      () => ({ r: 0.5, g: 0.5, b: 0.5 }),
    vortexVelocity: () => ({ vxi: 0, veta: 0 }),
  };
});

function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

/* ── 1. Per-car role Cp tables ───────────────────────────────────── */
describe('per-car ROLE_CP (getRoleCp)', () => {
  it('CA1. F1 floor suction is stronger than GT floor (venturi vs flat floor)', async () => {
    const { getRoleCp } = await import('../cfd-effect.js');
    expect(Math.abs(getRoleCp('F1', 'floor').bias))
      .toBeGreaterThan(Math.abs(getRoleCp('GT', 'floor').bias));
  });

  it('CA2. GT blunt-body stagnation exceeds F1 slender-nose stagnation', async () => {
    const { getRoleCp } = await import('../cfd-effect.js');
    expect(getRoleCp('GT', 'frontBumper').bias).toBeGreaterThan(getRoleCp('F1', 'nose').bias);
  });

  it('CA3. unknown car type falls back to the F1 table', async () => {
    const { getRoleCp } = await import('../cfd-effect.js');
    expect(getRoleCp('NOPE', 'floor')).toEqual(getRoleCp('F1', 'floor'));
  });

  it('CA4. GT patches use closed-body roles (hood / windshieldRoof / rearDeck)', async () => {
    const { CFD_PATCHES } = await import('../cfd-effect.js');
    const roles = new Set(CFD_PATCHES.GT.map(p => p.role));
    expect(roles.has('hood')).toBe(true);
    expect(roles.has('windshieldRoof')).toBe(true);
    expect(roles.has('rearDeck')).toBe(true);
    expect(roles.has('bodyTop')).toBe(false);   // generic role retired for GT
  });

  it('CA5. windshieldRoof gradient: base (front edge) reads higher Cp than header', async () => {
    const { computePatchCp, CFD_PATCHES } = await import('../cfd-effect.js');
    const ws = CFD_PATCHES.GT.find(p => p.role === 'windshieldRoof');
    expect(ws).toBeDefined();
    const hh = ws.h / 2;
    // Patch rx = -π/2 ⇒ local +y points toward the windscreen base (front).
    const cpBase   = computePatchCp(ws,  0,  hh, 1.0, [], [], 'GT');
    const cpHeader = computePatchCp(ws,  0, -hh, 1.0, [], [], 'GT');
    expect(cpBase).toBeGreaterThan(cpHeader);
  });
});

/* ── 2. Per-car / per-surface longitudinal Cp tables ─────────────── */
describe('per-car lerpCpProfile', () => {
  it('CB1. legacy default (F1) unchanged: z = -2.60 → -2.20', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    expect(lerpCpProfile(-2.60)).toBeCloseTo(-2.20, 6);
  });

  it('CB2. GT underbody: splitter suction near z = -2.0', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    expect(lerpCpProfile(-2.0, 'GT', 'under')).toBeLessThan(-0.8);
  });

  it('CB3. GT underbody: diffuser suction peak near z = +2.0', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    expect(lerpCpProfile(2.0, 'GT', 'under')).toBeLessThan(-0.9);
  });

  it('CB4. GT topside: windshield-base compression is positive, roof header suction negative', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    expect(lerpCpProfile(-0.70, 'GT', 'top')).toBeGreaterThan(0);
    expect(lerpCpProfile(-0.10, 'GT', 'top')).toBeLessThan(-0.4);
  });

  it('CB5. unknown type falls back to F1 table', async () => {
    const { lerpCpProfile } = await import('../cfd-effect.js');
    expect(lerpCpProfile(-2.60, 'NOPE', 'under')).toBeCloseTo(-2.20, 6);
  });

  it('CB6. GT floor patch Cp differs from the F1-typed evaluation of the same patch', async () => {
    const { computePatchCp, CFD_PATCHES } = await import('../cfd-effect.js');
    const GT_FLOOR = CFD_PATCHES.GT.find(p => p.role === 'floor');
    const asGT = computePatchCp(GT_FLOOR, 0, 0, 1.0, [], [], 'GT');
    const asF1 = computePatchCp(GT_FLOOR, 0, 0, 1.0, [], [], 'F1');
    expect(asGT).not.toBeCloseTo(asF1, 3);
    expect(asGT).toBeLessThan(-0.1);   // still clearly suction
  });
});

/* ── 3. Envelope remap for every car ─────────────────────────────── */
describe('patch envelope remap (all cars)', () => {
  const F1_MEASURE = {
    anchors: {
      frontWing: { x: 0, y: 0.05, z: -2.297 },
      rearWing:  { x: 0, y: 0.454, z: 2.412 },
      cockpit:   { x: 0, y: 0.32, z: -0.10 },
      floor:     { x: 0, y: -0.37, z: 0.13 },
    },
  };

  it('CC1. F1 patches now remap onto the measured GLB envelope', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setCarType('GT');                  // force a type change away from F1
    cfd.setCarType('F1', F1_MEASURE);
    const czs = cfd._patchMeshes.map(m => m.userData.patchDef.cz);
    expect(Math.min(...czs)).toBeCloseTo(-2.297, 2);
    expect(Math.max(...czs)).toBeCloseTo(2.412, 2);
  });

  it('CC2. without anchors, authored F1 envelope is kept verbatim', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    const czs = cfd._patchMeshes.map(m => m.userData.patchDef.cz);
    expect(Math.min(...czs)).toBeCloseTo(-2.72, 2);   // authored frontWing cz
  });
});

/* ── 4. Anchor-resolved vortex cores ─────────────────────────────── */
describe('resolveVortexCores', () => {
  it('CD1. F1 front-wing tip cores snap z to the measured frontWing anchor', async () => {
    const { resolveVortexCores } = await import('../cfd-effect.js');
    const cores = resolveVortexCores('F1', { frontWing: { z: -2.297 } });
    const fw = cores.filter(c => c.role === 'frontWing');
    expect(fw.length).toBe(2);
    for (const c of fw) expect(c.z).toBeCloseTo(-2.297 + (c.dz ?? 0), 5);
  });

  it('CD2. without anchors, authored positions are preserved', async () => {
    const { resolveVortexCores } = await import('../cfd-effect.js');
    const cores = resolveVortexCores('F1', null);
    const fw = cores.filter(c => c.role === 'frontWing');
    for (const c of fw) expect(c.z).toBeCloseTo(-2.72, 5);
  });

  it('CD3. GT gains rear-wing tip cores that track the rearWing anchor', async () => {
    const { resolveVortexCores } = await import('../cfd-effect.js');
    const cores = resolveVortexCores('GT', { rearWing: { z: 1.80 }, diffuser: { z: 2.05 } });
    const rw = cores.filter(c => c.role === 'rearWing');
    const df = cores.filter(c => c.role === 'diffuser');
    expect(rw.length).toBe(2);
    expect(df.length).toBe(2);
    for (const c of rw) expect(c.z).toBeCloseTo(1.80 + (c.dz ?? 0), 5);
    for (const c of df) expect(c.z).toBeCloseTo(2.05 + (c.dz ?? 0), 5);
  });

  it('CD4. GT also gets splitter-edge cores (frontWing role)', async () => {
    const { resolveVortexCores } = await import('../cfd-effect.js');
    const cores = resolveVortexCores('GT', null);
    expect(cores.filter(c => c.role === 'frontWing').length).toBe(2);
  });

  it('CD5. CfdEffect stores resolved cores and uses them for the spiral lines', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setCarType('GT', { anchors: { rearWing: { x: 0, y: 0.84, z: 1.80 } } });
    expect(Array.isArray(cfd._vortexDefs)).toBe(true);
    expect(cfd._vortexLines.length).toBe(cfd._vortexDefs.length);
    const rw = cfd._vortexDefs.filter(c => c.role === 'rearWing');
    expect(rw.length).toBe(2);
    for (const c of rw) expect(c.z).toBeCloseTo(1.80 + (c.dz ?? 0), 5);
  });
});
