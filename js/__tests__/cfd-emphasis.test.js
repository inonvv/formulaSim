/**
 * cfd-emphasis.test.js — CFD heat-point emphasis mapping (Phase 1).
 *
 * Defect C1: the additive overlay painted EVERY vertex with cpToColor, whose
 * output always has one full-luminance channel — the mid-range Cp band
 * (−1…+0.5) glowed as bright as the stagnation/suction peaks, washing the
 * whole shell in uniform colour.
 *
 * Fix: cpToEmphasisColor(cp, cpRefPos, cpRefNeg) — hue from cpToColor,
 * luminance scaled by w = smoothstep(0.25, 0.85, |cp|/cpRef). Under additive
 * blending zero luminance is invisible, so mid-range fades out and peaks pop.
 * cpToColor itself is SHARED with the venturi underfloor tint and must not
 * change — byte-guarded below.
 *
 * Real THREE (overlay integration); airflow-core kept real except
 * vortexVelocity (mirrors cfd-surface.test.js).
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

import { cpToColor } from '../airflow-core.js';
import {
  CfdEffect, cpToEmphasisColor, computeSurfaceCp, probeCp, syncCfdLegend,
} from '../cfd-effect.js';

const lum = (c) => Math.max(c.r, c.g, c.b);

function makeScene() {
  return {
    _objects: [],
    add(obj)    { this._objects.push(obj); },
    remove(obj) { this._objects = this._objects.filter(o => o !== obj); },
  };
}

function bodyFixture() {
  const geo = new THREE.BoxGeometry(1.8, 1.2, 4.2, 2, 2, 6);
  geo.translate(0, 0.7, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = 'bodyFixture';
  const carGroup = new THREE.Group();
  carGroup.add(mesh);
  carGroup.updateMatrixWorld(true);
  return { mesh, carGroup };
}

const GT_ANCHORS = {
  frontWing: { x: 0, y: 0.00, z: -2.08 },
  rearWing:  { x: 0, y: 0.84, z:  1.92 },
  noseTip:   { x: 0, y: 0.00, z: -2.13 },
  floor:     { x: 0, y: 0.10, z:  0.03 },
  cockpit:   { x: 0, y: 0.88, z:  0.48 },
};

/* ── Emphasis mapping ────────────────────────────────────────────── */
describe('cpToEmphasisColor', () => {
  it('EM1. w(0) = 0 — freestream Cp renders black (invisible under additive)', () => {
    const c = cpToEmphasisColor(0);
    expect(c.r).toBe(0);
    expect(c.g).toBe(0);
    expect(c.b).toBe(0);
  });

  it('EM2. luminance is monotonic non-decreasing in |cp|, both signs', () => {
    let prev = -1;
    for (let cp = 0; cp <= 0.9; cp += 0.05) {
      const l = lum(cpToEmphasisColor(cp));
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
    prev = -1;
    for (let cp = 0; cp >= -2.2; cp -= 0.1) {
      const l = lum(cpToEmphasisColor(cp));
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });

  it('EM3. mid-range fades, peaks glow: Cp −0.4 ≤ 0.15 lum, Cp +0.85 ≥ 0.8 lum', () => {
    expect(lum(cpToEmphasisColor(-0.4))).toBeLessThanOrEqual(0.15);
    expect(lum(cpToEmphasisColor(0.85))).toBeGreaterThanOrEqual(0.8);
  });

  it('EM4. speed-normalised refs keep the pattern visible at low speed', () => {
    // At sf = 0.3 the attainable peak is cpRef·sf; a vertex at 85% of the
    // attainable positive peak must read the SAME luminance as at sf = 1.
    const sf = 0.3;
    const low  = cpToEmphasisColor(0.85 * sf, 0.9 * sf, 2.2 * sf);
    const full = cpToEmphasisColor(0.85, 0.9, 2.2);
    expect(lum(low)).toBeCloseTo(lum(full), 6);
    expect(lum(low)).toBeGreaterThanOrEqual(0.8);
  });

  it('EM5. hue comes from cpToColor (channel ratios preserved)', () => {
    const cp = -1.8;                       // cyan-ish suction
    const hue = cpToColor(cp);
    const emp = cpToEmphasisColor(cp);
    const l = lum(emp);
    expect(l).toBeGreaterThan(0);
    expect(emp.r).toBeCloseTo(hue.r * l, 6);
    expect(emp.g).toBeCloseTo(hue.g * l, 6);
    expect(emp.b).toBeCloseTo(hue.b * l, 6);
  });

  it('EM6. zero-speed refs (cpRef·0) do not divide-by-zero — returns black', () => {
    const c = cpToEmphasisColor(0, 0, 0);
    expect(c.r).toBe(0);
    expect(c.g).toBe(0);
    expect(c.b).toBe(0);
  });
});

/* ── Shared-hue byte-guard: venturi underfloor tint reads cpToColor ── */
describe('cpToColor byte-guard (shared with venturi tint — must not change)', () => {
  const CASES = [
    [-3.0, { r: 0,   g: 0,   b: 1   }],
    [-2.0, { r: 0,   g: 1,   b: 1   }],
    [-1.5, { r: 0,   g: 1,   b: 0.5 }],
    [-1.0, { r: 0,   g: 1,   b: 0   }],
    [ 0.0, { r: 1,   g: 1,   b: 0   }],
    [ 0.5, { r: 1,   g: 0.5, b: 0   }],
    [ 1.0, { r: 1,   g: 0,   b: 0   }],
  ];
  it('EG1. exact stop colours preserved', () => {
    for (const [cp, want] of CASES) {
      const c = cpToColor(cp);
      expect(c.r, `cp ${cp} r`).toBeCloseTo(want.r, 6);
      expect(c.g, `cp ${cp} g`).toBeCloseTo(want.g, 6);
      expect(c.b, `cp ${cp} b`).toBeCloseTo(want.b, 6);
    }
  });
});

/* ── Recolor paths use the emphasis map ──────────────────────────── */
describe('overlay + patch recolor apply emphasis', () => {
  it('EM7. body overlay at speed: mid-range vertices dim, peaks stay bright', () => {
    const cfd = new CfdEffect(makeScene());
    const { mesh, carGroup } = bodyFixture();
    cfd.setBodySurface([mesh], carGroup);
    cfd.setCarType('GT', { anchors: { ...GT_ANCHORS } });
    cfd.setVisible(true);
    cfd.setSpeed(350);
    cfd.update(0.016, 1.0);

    const col = cfd._surfaceMeshes[0].mesh.geometry.attributes.color;
    let dim = 0, bright = 0;
    for (let i = 0; i < col.count; i++) {
      const l = Math.max(col.getX(i), col.getY(i), col.getZ(i));
      if (l < 0.5) dim++;
      if (l > 0.8) bright++;
    }
    // Defect today: cpToColor always emits one full channel → dim = 0.
    expect(dim / col.count).toBeGreaterThan(0.3);
    expect(bright).toBeGreaterThan(0);
  });

  it('EM8. procedural patches at speed: emphasis applied there too', () => {
    const cfd = new CfdEffect(makeScene());
    cfd.setCarType('GT');
    cfd.setVisible(true);
    cfd.setSpeed(350);
    cfd.update(0.016, 1.0);

    let dim = 0, total = 0;
    for (const m of cfd._patchMeshes) {
      const col = m.geometry.attributes.color;
      const arr = col.array ?? col;
      const count = m.geometry.attributes.position.count;
      for (let i = 0; i < count; i++) {
        const l = Math.max(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
        if (l < 0.5) dim++;
        total++;
      }
    }
    expect(dim / total).toBeGreaterThan(0.1);
  });
});

/* ── Phase 3 UX: hover probe, legend sync, blob declutter ────────── */
describe('probeCp (hover Cp readout)', () => {
  it('UX1. converts a world-frame raycast hit to car-local and matches computeSurfaceCp', () => {
    const hit = {
      point: { x: 0.95, y: 1.20, z: -0.30 },       // world (baseY 0.25 lift)
      face:  { normal: { x: 0, y: 0, z: -1 } },
    };
    const cp = probeCp(hit, 'GT', GT_ANCHORS, 1.0, 0.25);
    expect(Number.isFinite(cp)).toBe(true);
    expect(cp).toBeCloseTo(
      computeSurfaceCp(0.95, 0.95, -0.30, 0, 0, -1, 'GT', GT_ANCHORS, 1.0), 10);
  });

  it('UX2. hit without a face still returns a finite Cp (fallback normal)', () => {
    const cp = probeCp({ point: { x: 0, y: 1.0, z: 0.5 } }, 'GT', GT_ANCHORS, 0.8);
    expect(Number.isFinite(cp)).toBe(true);
  });
});

describe('syncCfdLegend', () => {
  it('UX3. toggles the "show" class with the CFD env state', () => {
    const calls = [];
    const el = { classList: { toggle: (cls, on) => calls.push([cls, on]) } };
    expect(syncCfdLegend(el, true)).toBe(true);
    expect(syncCfdLegend(el, false)).toBe(false);
    expect(calls).toEqual([['show', true], ['show', false]]);
  });

  it('UX4. null element is safe and reads as hidden', () => {
    expect(syncCfdLegend(null, true)).toBe(false);
  });
});

describe('blob declutter on the body-surface overlay path', () => {
  it('UX5. GLB path hides stagnation + cockpit blobs (paint shows them now)', () => {
    const cfd = new CfdEffect(makeScene());
    const { mesh, carGroup } = bodyFixture();
    cfd.setBodySurface([mesh], carGroup);
    cfd.setCarType('GT', { anchors: { ...GT_ANCHORS } });
    const byRole = (role) => cfd._blobMeshes.filter(m => m.userData.blobRole === role);
    expect(byRole('stagnation').every(m => m.visible === false)).toBe(true);
    expect(byRole('cockpit').every(m => m.visible === false)).toBe(true);
    expect(byRole('stagnation').length).toBeGreaterThan(0);
    expect(byRole('cockpit').length).toBeGreaterThan(0);
    // Volumes the paint canNOT show stay visible.
    expect(byRole('diffuser').every(m => m.visible === true)).toBe(true);
    expect(byRole('rearWing').every(m => m.visible === true)).toBe(true);
  });

  it('UX6. procedural fallback keeps ALL blobs visible', () => {
    const cfd = new CfdEffect(makeScene());
    cfd.setCarType('GT');
    expect(cfd._blobMeshes.length).toBeGreaterThan(0);
    expect(cfd._blobMeshes.every(m => m.visible === true)).toBe(true);
  });
});
