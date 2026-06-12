/**
 * cfd-surface.test.js — CFD pressure painted on the REAL body surface.
 *
 * The rectangle patches floated through the car (planes at authored
 * coordinates intersecting the GLB body). For GLB cars the CFD now clones
 * the body meshes, inflates them along their normals, and colours every
 * vertex from the per-car Cp model — pressure lives exactly on the body.
 * Rectangle patches remain only as the procedural fallback.
 *
 * Real THREE here (geometry cloning / matrix math); airflow-core partially
 * mocked so colours don't mask Cp assertions.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

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

/* ── Pure surface-Cp model ───────────────────────────────────────── *
 * Signature: computeSurfaceCp(x, y, z, nx, ny, nz, type, anchors, sf).
 * Flow travels +z in the car frame (nose at −z) — a surface "sees" the
 * oncoming air when its normal has a NEGATIVE z component. Newtonian
 * impact (facing²) pulls Cp toward stagnation on those faces.
 */
describe('computeSurfaceCp', () => {
  it('CS1. downward-facing underbody vertex reads the UNDER profile (splitter suction)', () => {
    const under = computeSurfaceCp(0, 0.05, -2.0, 0, -1, 0, 'GT', GT_ANCHORS, 1.0);
    expect(under).toBeLessThan(-0.8);   // GT under-table splitter peak
  });

  it('CS2. nose-front topside vertex reads stagnation (positive Cp)', () => {
    const cp = computeSurfaceCp(0, 0.35, -2.10, 0, 0.2, -0.9, 'GT', GT_ANCHORS, 1.0);
    expect(cp).toBeGreaterThan(0);
  });

  it('CS3. rear-wing band reads stronger suction than the mid roof', () => {
    const wing = computeSurfaceCp(0, 0.86, 1.92, 0, 0.9, 0, 'GT', GT_ANCHORS, 1.0);
    const roof = computeSurfaceCp(0, 1.25, 0.60, 0, 1.0, 0, 'GT', GT_ANCHORS, 1.0);
    expect(wing).toBeLessThan(roof);
    expect(wing).toBeLessThan(-1.0);
  });

  it('CS4. zero speed → zero Cp everywhere (patches fade out at rest)', () => {
    expect(computeSurfaceCp(0, 0.05, -2.0, 0, -1, 0, 'GT', GT_ANCHORS, 0)).toBe(0);
    expect(computeSurfaceCp(0, 0.35, -2.10, 0, 0.2, -0.9, 'GT', GT_ANCHORS, 0)).toBe(0);
  });

  it('CS5. F1 front-wing band reads strong suction below wing height', () => {
    const anchors = { frontWing: { x: 0, y: 0.05, z: -2.30 }, rearWing: { x: 0, y: 0.45, z: 2.41 }, floor: { x: 0, y: -0.37, z: 0.13 } };
    const fw = computeSurfaceCp(0.4, 0.03, -2.30, 0, 0.8, 0, 'F1', anchors, 1.0);
    const mid = computeSurfaceCp(0.4, 0.40, 0.0, 0, 1.0, 0, 'F1', anchors, 1.0);
    expect(fw).toBeLessThan(mid);
  });

  /* ── Flow-facing (Newtonian impact) precision ─────────────────── */
  it('CS11. MIRROR: fully flow-facing vertex reads near-stagnation red, anywhere on the car', () => {
    // A mirror face at mid-car (z ≈ -0.3, head height) — normal points
    // straight into the oncoming flow.
    const mirror = computeSurfaceCp(0.95, 0.95, -0.30, 0, 0, -1, 'GT', GT_ANCHORS, 1.0);
    expect(mirror).toBeGreaterThan(0.6);
  });

  it('CS12. WINDSHIELD: raked glass at mid-car reads clearly positive (compression heat)', () => {
    // 992 windshield ≈ 0.77 up / 0.64 forward normal at z ≈ -0.45.
    const glass = computeSurfaceCp(0, 0.95, -0.45, 0, 0.77, -0.64, 'GT', GT_ANCHORS, 1.0);
    expect(glass).toBeGreaterThan(0.15);
    // …and clearly hotter than the flat roof right behind it.
    const roof = computeSurfaceCp(0, 1.28, 0.30, 0, 1, -0.05, 'GT', GT_ANCHORS, 1.0);
    expect(glass).toBeGreaterThan(roof + 0.5);
  });

  it('CS13. LEEWARD: rear-facing surfaces fall into base/wake suction', () => {
    const rearFace = computeSurfaceCp(0, 0.60, 2.30, 0, 0, 1, 'GT', GT_ANCHORS, 1.0);
    const sameSpotNeutral = computeSurfaceCp(0, 0.60, 2.30, 1, 0, 0, 'GT', GT_ANCHORS, 1.0);
    expect(rearFace).toBeLessThan(sameSpotNeutral);
  });

  it('CS14. SIDE faces (normal ±x) are not reddened by the impact term', () => {
    const side = computeSurfaceCp(1.0, 0.60, 0.0, 1, 0, 0, 'GT', GT_ANCHORS, 1.0);
    const front = computeSurfaceCp(1.0, 0.60, 0.0, 0, 0, -1, 'GT', GT_ANCHORS, 1.0);
    expect(front).toBeGreaterThan(side + 0.5);
  });
});

/* ── Overlay build path ──────────────────────────────────────────── */
function bodyFixture() {
  // A coarse "car body": box spanning the GT envelope, with normals.
  const geo = new THREE.BoxGeometry(1.8, 1.2, 4.2, 2, 2, 6);
  geo.translate(0, 0.7, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = 'bodyFixture';
  const carGroup = new THREE.Group();
  carGroup.position.y = 0.25;            // baseY lift — overlay must cancel it
  carGroup.add(mesh);
  carGroup.updateMatrixWorld(true);
  return { mesh, carGroup };
}

describe('CfdEffect body-surface overlay', () => {
  it('CS6. with body meshes: overlay meshes built, rectangle patches suppressed', () => {
    const cfd = new CfdEffect(makeScene());
    const { mesh, carGroup } = bodyFixture();
    cfd.setBodySurface([mesh], carGroup);
    cfd.setCarType('GT', { anchors: { ...GT_ANCHORS } });
    expect(cfd._surfaceMeshes.length).toBe(1);
    expect(cfd._patchMeshes.length).toBe(0);            // no floating rectangles
    const overlay = cfd._surfaceMeshes[0].mesh;
    expect(overlay.geometry.attributes.color).toBeDefined();
    expect(overlay.geometry.attributes.color.count)
      .toBe(overlay.geometry.attributes.position.count);
    expect(overlay.material.vertexColors).toBe(true);
  });

  it('CS7. overlay geometry is rebased to car-local (baseY cancelled)', () => {
    const cfd = new CfdEffect(makeScene());
    const { mesh, carGroup } = bodyFixture();
    cfd.setBodySurface([mesh], carGroup);
    cfd.setCarType('GT', { anchors: { ...GT_ANCHORS } });
    const overlay = cfd._surfaceMeshes[0].mesh;
    const bb = new THREE.Box3().setFromBufferAttribute(overlay.geometry.attributes.position);
    // Source spans y 0.1..1.3 car-local (0.35..1.55 world); the overlay must
    // be CAR-LOCAL (inflation margin ~0.012, not the 0.25 baseY).
    expect(bb.min.y).toBeGreaterThan(0.0);
    expect(bb.min.y).toBeLessThan(0.2);
    expect(bb.max.y).toBeLessThan(1.45);
  });

  it('CS8. update() at speed recolours the overlay (stagnation red ≠ wake)', () => {
    const cfd = new CfdEffect(makeScene());
    const { mesh, carGroup } = bodyFixture();
    cfd.setBodySurface([mesh], carGroup);
    cfd.setCarType('GT', { anchors: { ...GT_ANCHORS } });
    cfd.setVisible(true);
    cfd.setSpeed(350);
    cfd.update(0.016, 1.0);
    const colorAttr = cfd._surfaceMeshes[0].mesh.geometry.attributes.color;
    // Not uniform: at least two clearly different vertex colours.
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < colorAttr.count; i++) {
      min = Math.min(min, colorAttr.getX(i));
      max = Math.max(max, colorAttr.getX(i));
    }
    expect(max - min).toBeGreaterThan(0.1);
  });

  it('CS9. without body meshes: rectangle patches still build (procedural fallback)', () => {
    const cfd = new CfdEffect(makeScene());
    cfd.setCarType('GT');
    expect(cfd._patchMeshes.length).toBeGreaterThan(0);
    expect(cfd._surfaceMeshes.length).toBe(0);
  });

  it('CS10. setBodySurface(null) clears the overlay and restores patches', () => {
    const cfd = new CfdEffect(makeScene());
    const { mesh, carGroup } = bodyFixture();
    cfd.setBodySurface([mesh], carGroup);
    cfd.setCarType('GT', { anchors: { ...GT_ANCHORS } });
    expect(cfd._surfaceMeshes.length).toBe(1);
    cfd.setBodySurface(null, null);
    cfd.setCarType('F1', { anchors: { frontWing: { x: 0, y: 0.05, z: -2.3 }, rearWing: { x: 0, y: 0.45, z: 2.41 } } });
    expect(cfd._surfaceMeshes.length).toBe(0);
    expect(cfd._patchMeshes.length).toBeGreaterThan(0);
  });
});
