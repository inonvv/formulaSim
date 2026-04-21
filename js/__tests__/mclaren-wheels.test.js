/**
 * mclaren-wheels.test.js — Phase 5 of glb-wheels-split-and-render.
 *
 * Regression coverage for the GLB-wheel pipeline using REAL
 * sliceGeometryByPredicate on a synthetic McLaren-like scene. Verifies:
 *   - loaded.wheelsRoot has exactly 4 corner groups
 *   - Each corner group contains a mesh whose tyre bbox height ≈ 2·wheelRadius (±0.05)
 *   - Corner positions match measured axle X/Z within ±0.02 m
 *   - L/R and F/R symmetry (FL↔FR, RL↔RR)
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { buildWheelsFromGLB } from '../car-loader.js';

/* Mock the heavy three addons so importing car-loader doesn't pull in
 * GLTFLoader / DRACOLoader at module-load time — we only need the
 * buildWheelsFromGLB export. */
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { setDRACOLoader() {} async loadAsync() { return null; } },
}));
vi.mock('three/addons/loaders/DRACOLoader.js', () => ({
  DRACOLoader: class { setDecoderPath() {} },
}));

/* ── McLaren reference values (post-rotation, from docs/f1-bboxes.json) ── */
const MCLAREN_MEASURE = {
  groundContactY: -0.6232,
  frontAxleZ: -1.47,
  rearAxleZ:   2.10,
  frontAxleX:  0.97,
  rearAxleX:   1.03,
  wheelRadius: 0.44,
};

/* ── Synthetic tyre geometry: TWO rings (L/R) around each axle ──
 * Each tyre ring is a circle in the YZ plane at the given X, centred at the
 * axle point (axleX, wheelY, axleZ). This produces a bbox-height ≈ 2·wheelRadius
 * per fragment after splitting — exactly what Phase 5 verifies.
 */
function buildTwoRingGeo({ zAxle, xLeft, xRight, wheelY, r, segments = 32 }) {
  const positions = [];
  const indices = [];
  const ringStart = [];   // starting vertex index per ring

  const rings = [
    { x: xLeft,  first: -1 },
    { x: xRight, first: -1 },
  ];

  for (const ring of rings) {
    ring.first = positions.length / 3;
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      positions.push(
        ring.x,
        wheelY + r * Math.cos(theta),
        zAxle  + r * Math.sin(theta),
      );
    }
    ringStart.push(ring.first);
  }

  // Build triangle fan per ring — each ring needs at least 1 triangle to be
  // a real mesh for split purposes. Use each ring as (segments-2) triangles
  // fanning out from vertex 0 of that ring.
  for (const first of ringStart) {
    for (let i = 1; i < segments - 1; i++) {
      indices.push(first, first + i, first + i + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
  return geo;
}

/* Minimal mesh-like node with geometry and an identity world matrix. */
function makeSrcMesh(name, geometry) {
  return {
    name, isMesh: true,
    geometry,
    material: { name: `${name}-mat` },
    parent: null,
    children: [],
    matrixWorld: new THREE.Matrix4 ? new THREE.Matrix4() : null,
    updateMatrixWorld() {},
    traverse(fn) { fn(this); this.children.forEach(c => c.traverse(fn)); },
  };
}

/* A parent scene with remove() so buildWheelsFromGLB's cleanup can strip
 * original source meshes. */
function makeScene(children) {
  const s = {
    name: 'Scene', isMesh: false,
    children: [...children],
    updateMatrixWorld() {},
    remove(child) { this.children = this.children.filter(c => c !== child); },
    traverse(fn) {
      fn(this);
      this.children.forEach(c => c.traverse ? c.traverse(fn) : fn(c));
    },
  };
  children.forEach(c => { c.parent = s; });
  return s;
}

describe('McLaren wheel split — Phase 5 regression', () => {
  const wheelY = MCLAREN_MEASURE.groundContactY + MCLAREN_MEASURE.wheelRadius;

  function buildScene() {
    const frontGeo = buildTwoRingGeo({
      zAxle: MCLAREN_MEASURE.frontAxleZ,
      xLeft:  -MCLAREN_MEASURE.frontAxleX,
      xRight:  MCLAREN_MEASURE.frontAxleX,
      wheelY, r: MCLAREN_MEASURE.wheelRadius,
    });
    const rearGeo = buildTwoRingGeo({
      zAxle: MCLAREN_MEASURE.rearAxleZ,
      xLeft:  -MCLAREN_MEASURE.rearAxleX,
      xRight:  MCLAREN_MEASURE.rearAxleX,
      wheelY, r: MCLAREN_MEASURE.wheelRadius,
    });
    const front = makeSrcMesh('Object_33', frontGeo);
    const rear  = makeSrcMesh('Object_26', rearGeo);
    return makeScene([front, rear]);
  }

  it('MW1. 4 corner groups FL/FR/RL/RR', () => {
    const scene = buildScene();
    const built = buildWheelsFromGLB(scene, MCLAREN_MEASURE);
    expect(built.wheelsRoot.children).toHaveLength(4);
    const names = built.wheelsRoot.children.map(g => g.name).sort();
    expect(names).toEqual(['FL', 'FR', 'RL', 'RR']);
  });

  it('MW2. corner positions within ±0.02 m of measure axles', () => {
    const scene = buildScene();
    const built = buildWheelsFromGLB(scene, MCLAREN_MEASURE);
    const { FL, FR, RL, RR } = built.wheels;
    expect(FL.position.x).toBeCloseTo(-MCLAREN_MEASURE.frontAxleX, 2);
    expect(FL.position.z).toBeCloseTo( MCLAREN_MEASURE.frontAxleZ, 2);
    expect(FR.position.x).toBeCloseTo( MCLAREN_MEASURE.frontAxleX, 2);
    expect(FR.position.z).toBeCloseTo( MCLAREN_MEASURE.frontAxleZ, 2);
    expect(RL.position.x).toBeCloseTo(-MCLAREN_MEASURE.rearAxleX,  2);
    expect(RL.position.z).toBeCloseTo( MCLAREN_MEASURE.rearAxleZ,  2);
    expect(RR.position.x).toBeCloseTo( MCLAREN_MEASURE.rearAxleX,  2);
    expect(RR.position.z).toBeCloseTo( MCLAREN_MEASURE.rearAxleZ,  2);
    // All corners share wheelY.
    for (const g of [FL, FR, RL, RR]) {
      expect(g.position.y).toBeCloseTo(wheelY, 5);
    }
  });

  it('MW3. L/R symmetry (positions mirrored in X)', () => {
    const scene = buildScene();
    const built = buildWheelsFromGLB(scene, MCLAREN_MEASURE);
    expect(built.wheels.FL.position.x).toBeCloseTo(-built.wheels.FR.position.x, 5);
    expect(built.wheels.FL.position.z).toBeCloseTo( built.wheels.FR.position.z, 5);
    expect(built.wheels.RL.position.x).toBeCloseTo(-built.wheels.RR.position.x, 5);
    expect(built.wheels.RL.position.z).toBeCloseTo( built.wheels.RR.position.z, 5);
  });

  it('MW4. tyre fragment bbox height ≈ 2·wheelRadius (±0.05)', () => {
    const scene = buildScene();
    const built = buildWheelsFromGLB(scene, MCLAREN_MEASURE);
    const expectedH = 2 * MCLAREN_MEASURE.wheelRadius;
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      const mesh = built.wheels[c].children.find(m => /Object_(33|26)_/.test(m.name));
      expect(mesh, `${c} missing tyre fragment`).toBeDefined();
      const bb = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
      const h = bb.max.y - bb.min.y;
      expect(Math.abs(h - expectedH), `${c} bbox height ${h} vs expected ${expectedH}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('MW5. tyre vertex count: no > 5% loss per corner (clean X=0 split plane)', () => {
    const scene = buildScene();
    const built = buildWheelsFromGLB(scene, MCLAREN_MEASURE);
    // Source has 2 rings × N verts. Each ring is entirely on one side of X=0.
    // A clean split keeps exactly one ring per corner → 50% of the source.
    // Tolerance: >= 45% of source verts land in FL + FR combined (should be 100%).
    const frontSrcCount = (built.debug.counts.FL.Object_33.sourceVertCount);
    const flCount = built.debug.counts.FL.Object_33.fragmentVertCount;
    const frCount = built.debug.counts.FR.Object_33.fragmentVertCount;
    expect(flCount + frCount).toBeGreaterThanOrEqual(frontSrcCount * 0.95);

    const rearSrcCount = (built.debug.counts.RL.Object_26.sourceVertCount);
    const rlCount = built.debug.counts.RL.Object_26.fragmentVertCount;
    const rrCount = built.debug.counts.RR.Object_26.fragmentVertCount;
    expect(rlCount + rrCount).toBeGreaterThanOrEqual(rearSrcCount * 0.95);
  });

  it('MW6. scene no longer contains split source meshes', () => {
    const scene = buildScene();
    buildWheelsFromGLB(scene, MCLAREN_MEASURE);
    const remaining = scene.children.map(c => c.name);
    expect(remaining).not.toContain('Object_33');
    expect(remaining).not.toContain('Object_26');
  });
});
