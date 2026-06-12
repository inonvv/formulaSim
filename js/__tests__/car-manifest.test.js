import { describe, it, expect } from 'vitest';
import { CAR_MANIFEST, getManifest } from '../car-manifest.js';

describe('CAR_MANIFEST', () => {
  it('has entries for f1 and gt', () => {
    expect(CAR_MANIFEST).toHaveProperty('f1');
    expect(CAR_MANIFEST).toHaveProperty('gt');
  });

  it('each entry has url string ending in .glb', () => {
    for (const m of Object.values(CAR_MANIFEST)) {
      expect(typeof m.url).toBe('string');
      expect(m.url).toMatch(/\.glb$/);
    }
  });

  it('transform has scale (number), rotation (length-3 array), position (length-3 array)', () => {
    for (const m of Object.values(CAR_MANIFEST)) {
      expect(typeof m.transform.scale).toBe('number');
      expect(m.transform.rotation).toHaveLength(3);
      expect(m.transform.position).toHaveLength(3);
    }
  });

  it('stripMeshes and liveryMeshes are arrays of strings (exact node names, may be mixed-case)', () => {
    for (const m of Object.values(CAR_MANIFEST)) {
      expect(Array.isArray(m.stripMeshes)).toBe(true);
      expect(Array.isArray(m.liveryMeshes)).toBe(true);
      expect(m.liveryMeshes.length).toBeGreaterThan(0);  // every car has at least one livery mesh
      m.stripMeshes.forEach(s => expect(typeof s).toBe('string'));
      m.liveryMeshes.forEach(s => expect(typeof s).toBe('string'));
    }
  });

  it('f1.stripMeshes keeps only Object_28 (orphan rear-cape); wheel nodes are un-stripped for splitter', () => {
    const names = CAR_MANIFEST.f1.stripMeshes;
    // Object_28 = orphaned rear_wheel_cover cape — must stay stripped.
    expect(names).toContain('Object_28');
    // Object_24/25/26/27/29/33/34 are SPLIT by buildWheelsFromGLB, not stripped.
    ['Object_24', 'Object_25', 'Object_26', 'Object_27', 'Object_29', 'Object_33', 'Object_34'].forEach(n =>
      expect(names).not.toContain(n)
    );
  });

  it('gt.stripMeshes is empty — the GLB has no strippable wheel meshes, and the trim mesh stays', () => {
    // TwiXeR_992_body_gt3rs_TwiXeR_992_plastic.002_0 is window/trim geometry
    // (y ∈ [0.50, 1.02]) — it was wrongly stripped as "baked wheels".
    expect(CAR_MANIFEST.gt.stripMeshes).toEqual([]);
  });

  it('gt.wheelBake targets the mega-mesh with typed classification thresholds', () => {
    const wb = CAR_MANIFEST.gt.wheelBake;
    expect(wb.mesh).toBe('TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_plastic_mgl_060606FF.001_0');
    for (const key of [
      'maxComponentDim', 'groundEpsilon', 'axisTolerance', 'minOutboardX',
      'expectedTires', 'wheelbaseSpec', 'wheelbaseTol', 'maxStraddleDropRatio',
    ]) {
      expect(typeof wb[key], key).toBe('number');
    }
    expect(wb.expectedTires).toBe(4);
    expect(wb.wheelbaseSpec).toBeCloseTo(2.457, 3);
  });

  it('gt no longer carries the spec-constant hybrid block (measured at runtime instead)', () => {
    expect(CAR_MANIFEST.gt.hybrid).toBeUndefined();
  });

  it('gt.anchorSources measures roof/cockpit/bodyShell from real mesh names', () => {
    const a = CAR_MANIFEST.gt.anchorSources;
    expect(a.halo.mesh).toBe('TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_carbon_roof.001_0');
    expect(a.halo.use).toBe('peak');
    expect(a.cockpit.mesh).toBe('TwiXeR_992_body_gt3rs_TwiXeR_992_roof_alc.001_0');
    expect(a.bodyShell.mesh).toBe('TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_plastic_mgl_060606FF.001_0');
  });

  it('gt.anchorSources authors role-tagged vents (992 GT3 RS intake/exhaust layout)', () => {
    const a = CAR_MANIFEST.gt.anchorSources;
    expect(a.frontIntake.role).toBe('inlet');
    expect(a.engineIntake.role).toBe('inlet');
    expect(a.exhaustPipe.role).toBe('outlet');
    expect(a.fenderVentL.role).toBe('outlet');
    expect(a.fenderVentR.mirrored).toBe('fenderVentL');
    // Every authored vent rides on a measured anchor (bodyShell or halo).
    for (const key of ['frontIntake', 'engineIntake', 'exhaustPipe', 'fenderVentL']) {
      expect(typeof a[key].anchor).toBe('string');
      expect(a[key].offset).toHaveLength(3);
      expect(a[key].direction).toHaveLength(3);
    }
  });

  it('occupancyMeshes list the collision extras per car (f1 mirror/suspension, gt glass/doors/hood)', () => {
    expect(CAR_MANIFEST.f1.occupancyMeshes).toEqual(['Object_20', 'Object_6']);
    expect(CAR_MANIFEST.gt.occupancyMeshes).toEqual([
      'TwiXeR_992_gt3rs_sideskirts_L_TwiXeR_992_glass.002_0',
      'TwiXeR_992_gt3rs_door_L_TwiXeR_992_rubbertrim.004_0',
      'TwiXeR_992_gt3rs_carbon_hood_TwiXeR_992_metal_radiator.002_0',
    ]);
  });

  it('getManifest("f1") returns CAR_MANIFEST.f1', () => {
    expect(getManifest('f1')).toBe(CAR_MANIFEST.f1);
  });

  it('getManifest("UNKNOWN") returns null', () => {
    expect(getManifest('UNKNOWN')).toBeNull();
  });
});
