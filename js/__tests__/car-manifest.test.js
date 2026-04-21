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

  it('getManifest("f1") returns CAR_MANIFEST.f1', () => {
    expect(getManifest('f1')).toBe(CAR_MANIFEST.f1);
  });

  it('getManifest("UNKNOWN") returns null', () => {
    expect(getManifest('UNKNOWN')).toBeNull();
  });
});
