/**
 * cfd-tires.test.js — CFD tire paint (static torus proxies).
 *
 * Defect: the CFD overlay painted the body shell only — nothing at all on
 * the tires, though an exposed rotating tire carries the strongest
 * stagnation front on the car. Fix: when the measure carries the axle
 * fields, CfdEffect builds 4 TorusGeometry proxies (rotation-symmetric, so
 * static meshes are spin-correct) at the measured hub positions and paints
 * them through the SAME recolor routine as the body overlay
 * (computeSurfaceCp + emphasis map + SDF shadowing + sf-scaled opacity).
 *
 * Real THREE (TorusGeometry / attribute math); airflow-core partially
 * mocked as in cfd-surface.test.js so colours don't mask Cp assertions.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../airflow-core.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    vortexVelocity: () => ({ vxi: 0, veta: 0 }),
  };
});

import { CfdEffect, computeSurfaceCp } from '../cfd-effect.js';

function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

const GT_ANCHORS = {
  frontWing: { x: 0, y: 0.00, z: -2.08 },
  rearWing:  { x: 0, y: 0.84, z:  1.92 },
  noseTip:   { x: 0, y: 0.00, z: -2.13 },
  floor:     { x: 0, y: 0.10, z:  0.03 },
  halo:      { x: 0, y: 1.29, z:  0.10 },
  cockpit:   { x: 0, y: 0.88, z:  0.48 },
};

/* GT-like measure with the axle fields the tire proxies key off
 * (gt.glb measured: r 0.39, wheelbase 2.455, width 0.33). */
const GT_MEASURE = {
  anchors: { ...GT_ANCHORS },
  groundContactY: 0.00,
  frontAxleZ: -1.23,
  rearAxleZ:   1.23,
  frontAxleX:  0.80,
  rearAxleX:   0.84,
  wheelRadius: 0.39,
  wheelWidth:  0.33,
};

const HUB_Y = GT_MEASURE.groundContactY + GT_MEASURE.wheelRadius;

function makeCfd(measure = GT_MEASURE) {
  const cfd = new CfdEffect(makeScene());
  cfd.setCarType('GT', measure);
  return cfd;
}

/** Hub of a proxy from its baked (car-local) positions. Bbox centre, not
 *  vertex centroid — TorusGeometry duplicates the seam vertices, which
 *  biases a plain average off the hub. */
function centroid(mesh) {
  const pos = mesh.geometry.attributes.position;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

/** Vertex index with the extreme normal-z on a proxy (front/rear tread). */
function extremeNzVertex(mesh, sign) {
  const nrm = mesh.geometry.attributes.normal;
  let best = 0, bestNz = 0;
  for (let i = 0; i < nrm.count; i++) {
    const nz = nrm.getZ(i);
    if (sign * nz > sign * bestNz) { best = i; bestNz = nz; }
  }
  return best;
}

describe('CFD tire proxies — build geometry', () => {
  it('CT1. four proxies at the measured hub positions (±0.01 m)', () => {
    const cfd = makeCfd();
    expect(cfd._tireMeshes.length).toBe(4);
    const hubs = cfd._tireMeshes.map(({ mesh }) => centroid(mesh));
    const want = [
      { x: -GT_MEASURE.frontAxleX, y: HUB_Y, z: GT_MEASURE.frontAxleZ },
      { x:  GT_MEASURE.frontAxleX, y: HUB_Y, z: GT_MEASURE.frontAxleZ },
      { x: -GT_MEASURE.rearAxleX,  y: HUB_Y, z: GT_MEASURE.rearAxleZ  },
      { x:  GT_MEASURE.rearAxleX,  y: HUB_Y, z: GT_MEASURE.rearAxleZ  },
    ];
    for (const w of want) {
      const hit = hubs.find(h =>
        Math.abs(h.x - w.x) < 0.01 && Math.abs(h.y - w.y) < 0.01 && Math.abs(h.z - w.z) < 0.01);
      expect(hit, `no proxy at (${w.x}, ${w.y}, ${w.z})`).toBeDefined();
    }
  });

  it('CT2. proxy tread stays inside the measured tire (majorR + tubeR = wheelRadius)', () => {
    const cfd = makeCfd();
    // Front-left proxy: max radial extent from the hub in the wheel (y–z) plane.
    const { mesh } = cfd._tireMeshes[0];
    const hub = centroid(mesh);
    const pos = mesh.geometry.attributes.position;
    let maxR = 0, maxX = 0;
    for (let i = 0; i < pos.count; i++) {
      const dy = pos.getY(i) - hub.y, dz = pos.getZ(i) - hub.z;
      maxR = Math.max(maxR, Math.hypot(dy, dz));
      maxX = Math.max(maxX, Math.abs(pos.getX(i) - hub.x));
    }
    expect(maxR).toBeLessThanOrEqual(GT_MEASURE.wheelRadius + 1e-6);
    expect(maxR).toBeGreaterThan(GT_MEASURE.wheelRadius - 0.02);
    // Tube radius = min(width/2, 0.12) — width 0.33 caps at 0.12.
    expect(maxX).toBeLessThanOrEqual(0.12 + 1e-6);
  });
});

describe('CFD tire proxies — painted through the shared recolor routine', () => {
  function paintedCfd() {
    const cfd = makeCfd();
    cfd.setVisible(true);
    cfd.setSpeed(350);                 // sf = 1
    cfd.update(0.016, 1.0);
    return cfd;
  }

  it('CT3. front-tread vertex (nz ≈ −1) reads stagnation: Cp ≥ +0.5·sf, painted red', () => {
    const cfd = paintedCfd();
    const front = cfd._tireMeshes.find(({ mesh }) =>
      Math.abs(centroid(mesh).z - GT_MEASURE.frontAxleZ) < 0.01).mesh;
    const i   = extremeNzVertex(front, -1);
    const pos = front.geometry.attributes.position;
    const nrm = front.geometry.attributes.normal;
    expect(nrm.getZ(i)).toBeLessThan(-0.9);

    const sf = 1;
    const cp = computeSurfaceCp(
      pos.getX(i), pos.getY(i), pos.getZ(i),
      nrm.getX(i), nrm.getY(i), nrm.getZ(i),
      'GT', GT_ANCHORS, sf);
    expect(cp).toBeGreaterThanOrEqual(0.5 * sf);

    // …and the recolor routine actually painted it (stagnation = red-dominant).
    const col = front.geometry.attributes.color;
    expect(col.getX(i)).toBeGreaterThan(0.3);
    expect(col.getX(i)).toBeGreaterThan(col.getZ(i));
  });

  it('CT4. rear-facing tread of a rear tire falls into lee/wake suction (Cp < 0)', () => {
    const cfd = paintedCfd();
    const rear = cfd._tireMeshes.find(({ mesh }) =>
      Math.abs(centroid(mesh).z - GT_MEASURE.rearAxleZ) < 0.01).mesh;
    const i   = extremeNzVertex(rear, +1);
    const pos = rear.geometry.attributes.position;
    const nrm = rear.geometry.attributes.normal;
    expect(nrm.getZ(i)).toBeGreaterThan(0.9);

    const cp = computeSurfaceCp(
      pos.getX(i), pos.getY(i), pos.getZ(i),
      nrm.getX(i), nrm.getY(i), nrm.getZ(i),
      'GT', GT_ANCHORS, 1);
    expect(cp).toBeLessThan(0);
  });

  it('CT5. SDF upstream shadowing dims a flow-facing tread (rear tire in body wake)', () => {
    const cfd = paintedCfd();
    const rear = cfd._tireMeshes.find(({ mesh }) =>
      Math.abs(centroid(mesh).z - GT_MEASURE.rearAxleZ) < 0.01).mesh;
    const i   = extremeNzVertex(rear, -1);   // forward-facing tread of the rear tire
    const col = rear.geometry.attributes.color;
    const before = Math.max(col.getX(i), col.getY(i), col.getZ(i));

    cfd.setOccupancy({ sample: () => 1 }, 0.25);   // everything upstream occupied
    cfd.update(0.016, 1.1);
    const after = Math.max(col.getX(i), col.getY(i), col.getZ(i));
    expect(after).toBeLessThan(before);
  });

  it('CT6. opacity is sf-scaled like the body overlay', () => {
    const cfd = makeCfd();
    cfd.setVisible(true);
    cfd.setSpeed(175);                 // sf = 0.5
    cfd.update(0.016, 1.0);
    for (const { mesh } of cfd._tireMeshes) {
      expect(mesh.material.opacity).toBeCloseTo(0.5 * 0.85, 5);
      expect(mesh.material.depthWrite).toBe(false);
      expect(mesh.material.transparent).toBe(true);
    }
  });
});

describe('CFD tire proxies — gating and lifecycle', () => {
  it('CT7. no measure ⇒ no proxies, no throw', () => {
    const cfd = new CfdEffect(makeScene());
    expect(() => cfd.setCarType('GT')).not.toThrow();
    expect(cfd._tireMeshes.length).toBe(0);
    expect(() => cfd.setCarType('F1', { anchors: { ...GT_ANCHORS } })).not.toThrow();
    expect(cfd._tireMeshes.length).toBe(0);   // anchors alone are not enough
  });

  it('CT8. partial axle fields ⇒ no proxies (mocked-three suites stay safe)', () => {
    const cfd = new CfdEffect(makeScene());
    const partial = { ...GT_MEASURE };
    delete partial.frontAxleX;
    delete partial.rearAxleX;
    expect(() => cfd.setCarType('GT', partial)).not.toThrow();
    expect(cfd._tireMeshes.length).toBe(0);
  });

  it('CT9. dispose cleans the proxies out of the group', () => {
    const scene = makeScene();
    const cfd = new CfdEffect(scene);
    cfd.setCarType('GT', GT_MEASURE);
    expect(cfd._tireMeshes.length).toBe(4);
    const tireMeshes = cfd._tireMeshes.map(t => t.mesh);
    cfd.dispose();
    expect(cfd._tireMeshes.length).toBe(0);
    for (const m of tireMeshes) expect(cfd.group.children).not.toContain(m);
  });
});
