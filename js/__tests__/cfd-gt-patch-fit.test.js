/**
 * cfd-gt-patch-fit.test.js — Adversarial test for GT CFD patch placement.
 *
 * Bug: CFD_PATCHES.GT is authored with z positions assuming the GT body
 * spans z ∈ [-2.32, +2.14] (≈ 4.46m). After bug 1's fix to GT axle math,
 * the bodyshell envelope is anchored to z ∈ roughly [frontWing.z, rearWing.z]
 * which is closer to [-1.6, +1.6] (≈ 3.2m) for the real gt.glb.
 *
 * Without dynamic remap the patches float 0.5m+ in front of the nose and
 * past the rear bumper — visibly mismatched with the car body, which is
 * exactly the "CFD not calculated to size of the car" symptom the user
 * reported.
 *
 * Fix: when setCarType('GT', measure) is called with anchor-bearing
 * measure, CfdEffect remaps each patch's cz from the authored envelope
 * to the measured frontWing.z / rearWing.z range.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s) { this.x = s; this.y = s; this.z = s; return this; };
  function Euler(x=0,y=0,z=0){ this.x=x;this.y=y;this.z=z; }
  Euler.prototype.set = function(x,y,z){ this.x=x;this.y=y;this.z=z; return this; };
  function Group() {
    this.name=''; this.children=[]; this.visible=true;
    this.position=new Vec3(); this.rotation=new Euler();
  }
  Group.prototype.add = function(...i){ this.children.push(...i); return this; };
  Group.prototype.remove = function(c){ this.children = this.children.filter(x=>x!==c); return this; };
  Group.prototype.traverse = function(fn){ fn(this); this.children.forEach(c=>c.traverse&&c.traverse(fn)); };
  function Mesh(g,m){
    this.geometry=g||{}; this.material=m||{};
    this.position=new Vec3(); this.rotation=new Euler(); this.scale=new Vec3(1,1,1);
    this.userData={}; this.children=[]; this.visible=true;
  }
  Mesh.prototype.add = function(...i){ this.children.push(...i); return this; };
  Mesh.prototype.traverse = function(fn){ fn(this); };
  function Line(g,m){ this.geometry=g||{attributes:{}}; this.material=m||{}; this.children=[]; this.visible=true; }
  Line.prototype.traverse = function(fn){ fn(this); };
  function BufferGeometry(){
    this.attributes={};
    this.setAttribute = function(n,a){ this.attributes[n]=a; };
    this.dispose = function(){};
  }
  function BufferAttribute(a,n){ this.array=a; this.itemSize=n; this.needsUpdate=false; }
  function PlaneGeometry(w,h,sW,sH){
    const segW=sW||1, segH=sH||1, count=(segW+1)*(segH+1);
    this.attributes = { position: { array: new Float32Array(count*3), count, needsUpdate: false } };
    this.setAttribute = function(n,a){ this.attributes[n]=a; };
    this.dispose = function(){};
  }
  function SphereGeometry(){ this.attributes={}; this.setAttribute=function(){}; this.dispose=function(){}; }
  function MeshBasicMaterial(o={}){ Object.assign(this,o); this.dispose=()=>{}; }
  function LineBasicMaterial(o={}){ Object.assign(this,o); this.dispose=()=>{}; }
  return {
    Group, Mesh, Line, BufferGeometry, BufferAttribute,
    PlaneGeometry, SphereGeometry,
    MeshBasicMaterial, LineBasicMaterial,
    Vector3: Vec3, Euler,
    AdditiveBlending: 2, DoubleSide: 2, BackSide: 1,
  };
});

vi.mock('../airflow-core.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    cpToColor: () => ({ r: 0.5, g: 0.5, b: 0.5 }),
    vortexVelocity: () => ({ vxi: 0, veta: 0 }),
    sideViewVelocity: () => ({ veta: 1, vy: 0 }),
    traceStreamlinePath: () => [],
  };
});

function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

// GT measure with anchors that mimic the bodyshell-aware bbox from bug 1.
// frontWing/rearWing.z bound the actual bodyshell envelope.
function gtMeasureWithAnchors(frontZ, rearZ) {
  return {
    wheelbase: 2.457,
    trackWidth: 1.635,
    wheelRadius: 0.350,
    frontAxleZ: frontZ + 0.5,
    rearAxleZ: rearZ - 0.5,
    groundContactY: -0.04,
    anchors: {
      frontWing:  { x: 0, y: 0.10, z: frontZ },
      rearWing:   { x: 0, y: 1.00, z: rearZ  },
      cockpit:    { x: 0, y: 0.70, z: (frontZ + rearZ) / 2 - 0.20 },
      halo:       { x: 0, y: 1.10, z: (frontZ + rearZ) / 2 - 0.10 },
      floor:      { x: 0, y: 0.00, z: (frontZ + rearZ) / 2 },
      diffuser:   { x: 0, y: 0.00, z: rearZ - 0.20 },
      sidepodTop: { x: 0, y: 0.50, z: (frontZ + rearZ) / 2 },
      noseTip:    { x: 0, y: 0.05, z: frontZ - 0.05 },
    },
  };
}

describe('CFD GT patch placement — dynamic fit to bodyshell extents', () => {
  it('Bug 3.t1. GT patches fit within frontWing.z … rearWing.z envelope (+/- 0.30m grace)', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    const FRONT = -1.6;   // GT bodyshell front
    const REAR  = +1.6;   // GT bodyshell rear
    cfd.setCarType('GT', gtMeasureWithAnchors(FRONT, REAR));

    for (const m of cfd._patchMeshes) {
      expect(m.position.z).toBeGreaterThanOrEqual(FRONT - 0.30);
      expect(m.position.z).toBeLessThanOrEqual(REAR + 0.30);
    }
  });

  it('Bug 3.t2. GT frontmost patch sits near frontWing.z (not 0.5m+ ahead of it)', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    const FRONT = -1.6;
    const REAR  = +1.6;
    cfd.setCarType('GT', gtMeasureWithAnchors(FRONT, REAR));

    // The most forward patch (smallest z) should sit close to the nose
    // anchor, not a half-metre in front of it.
    const minZ = Math.min(...cfd._patchMeshes.map(m => m.position.z));
    expect(minZ).toBeGreaterThan(FRONT - 0.30);
  });

  it('Bug 3.t3. GT rearmost patch sits near rearWing.z (not 0.5m+ behind it)', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    const FRONT = -1.6;
    const REAR  = +1.6;
    cfd.setCarType('GT', gtMeasureWithAnchors(FRONT, REAR));

    const maxZ = Math.max(...cfd._patchMeshes.map(m => m.position.z));
    expect(maxZ).toBeLessThan(REAR + 0.30);
  });

  it('Bug 3.t4. patches scale proportionally — shorter measure ⇒ shorter patch envelope', async () => {
    const { CfdEffect } = await import('../cfd-effect.js');
    const cfd1 = new CfdEffect(makeScene());
    const cfd2 = new CfdEffect(makeScene());
    cfd1.setCarType('GT', gtMeasureWithAnchors(-2.0, +2.0));   // 4m envelope
    cfd2.setCarType('GT', gtMeasureWithAnchors(-1.2, +1.2));   // 2.4m envelope

    const span1 = Math.max(...cfd1._patchMeshes.map(m => m.position.z))
                - Math.min(...cfd1._patchMeshes.map(m => m.position.z));
    const span2 = Math.max(...cfd2._patchMeshes.map(m => m.position.z))
                - Math.min(...cfd2._patchMeshes.map(m => m.position.z));
    expect(span2).toBeLessThan(span1);
  });

  it('Bug 3.t5. no measure → falls back to authored positions (regression guard)', async () => {
    const { CfdEffect, CFD_PATCHES } = await import('../cfd-effect.js');
    const cfd = new CfdEffect(makeScene());
    cfd.setCarType('GT');   // no measure

    // Patches should match the authored GT entries verbatim.
    const authored = CFD_PATCHES.GT;
    cfd._patchMeshes.forEach((m, i) => {
      expect(m.position.z).toBeCloseTo(authored[i].cz, 3);
    });
  });
});
