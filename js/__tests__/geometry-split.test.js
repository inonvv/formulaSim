import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { sliceGeometryByPredicate } from '../geometry-split.js';

/* Helper: build a geometry with positions (+ optional normals/uvs) from
 * flat arrays. If `indices` is omitted, geometry is non-indexed. */
function makeGeo({ positions, normals, uvs, indices }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  if (normals) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  if (uvs)     g.setAttribute('uv',     new THREE.BufferAttribute(new Float32Array(uvs), 2));
  if (indices) g.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
  return g;
}

describe('sliceGeometryByPredicate', () => {
  it('GS1. throws when source has no position attribute', () => {
    const g = new THREE.BufferGeometry();
    expect(() => sliceGeometryByPredicate(g, () => true)).toThrow(/position/);
  });

  it('GS2. keepAll predicate returns identical triangle count', () => {
    // Two triangles (quad), indexed.
    const g = makeGeo({
      positions: [
        -1, 0, -1,   // 0
         1, 0, -1,   // 1
         1, 0,  1,   // 2
        -1, 0,  1,   // 3
      ],
      indices: [0, 1, 2,  0, 2, 3],
    });
    const out = sliceGeometryByPredicate(g, () => true);
    expect(out.index.count).toBe(6);
    expect(out.attributes.position.count).toBe(4);
  });

  it('GS3. rejectAll predicate returns empty geometry', () => {
    const g = makeGeo({
      positions: [0, 0, 0,  1, 0, 0,  0, 1, 0],
      indices: [0, 1, 2],
    });
    const out = sliceGeometryByPredicate(g, () => false);
    expect(out.index.count).toBe(0);
    expect(out.attributes.position.count).toBe(0);
  });

  it('GS4. half-cube split by x > 0 keeps only X-positive triangles', () => {
    // 8-vertex cube; 12 triangles (2 per face × 6 faces).
    const v = [
      // x=-1 face (all negative X): 0..3
      -1, -1, -1,   -1,  1, -1,   -1,  1,  1,   -1, -1,  1,
      // x=+1 face (all positive X): 4..7
       1, -1, -1,    1,  1, -1,    1,  1,  1,    1, -1,  1,
    ];
    // Each face as two tris; faces that span both sides in X get DROPPED.
    // Only the x=+1 face (indices 4..7) survives x > 0.
    const idx = [
      // -X face (all X<0) — dropped
      0, 1, 2,  0, 2, 3,
      // +X face (all X>0) — kept
      4, 6, 5,  4, 7, 6,
      // Straddle faces: each has 2 verts at X=-1 and 2 at X=+1 — dropped.
      0, 4, 5,  0, 5, 1,     // bottom (y=-1..y=+1, mixed X)? Actually top/bot below.
      3, 2, 6,  3, 6, 7,
      0, 3, 7,  0, 7, 4,
      1, 5, 6,  1, 6, 2,
    ];
    const g = makeGeo({ positions: v, indices: idx });
    const out = sliceGeometryByPredicate(g, (x) => x > 0);
    // 2 triangles survive (the +X face).
    expect(out.index.count).toBe(6);
    expect(out.attributes.position.count).toBe(4);
    // All surviving positions have x > 0.
    const pos = out.attributes.position;
    for (let i = 0; i < pos.count; i++) expect(pos.getX(i)).toBeGreaterThan(0);
  });

  it('GS5. straddling triangle (1 vertex on each side) is dropped', () => {
    const g = makeGeo({
      positions: [
        -1, 0, 0,    // 0 — x<0
         1, 0, 0,    // 1 — x>0
         0, 1, 0,    // 2 — x=0 (predicate x > 0 rejects)
      ],
      indices: [0, 1, 2],
    });
    const out = sliceGeometryByPredicate(g, (x) => x > 0);
    expect(out.index.count).toBe(0);
  });

  it('GS6. non-indexed input still produces indexed output', () => {
    // 1 triangle, non-indexed. All verts X>0.
    const g = makeGeo({
      positions: [1, 0, 0,  2, 0, 0,  1, 1, 0],
      // no indices
    });
    expect(g.index).toBeNull();
    const out = sliceGeometryByPredicate(g, (x) => x > 0);
    expect(out.index).not.toBeNull();
    expect(out.index.count).toBe(3);
    expect(out.attributes.position.count).toBe(3);
  });

  it('GS7. preserves normal + uv attributes for kept vertices', () => {
    const g = makeGeo({
      positions: [
        -1, 0, 0,   // 0
         1, 0, 0,   // 1 kept
         2, 0, 0,   // 2 kept
      ],
      normals: [
        0, 0, 1,
        0, 1, 0,
        1, 0, 0,
      ],
      uvs: [
        0, 0,
        0.5, 0.5,
        1, 1,
      ],
      indices: [0, 1, 2],   // straddles — this triangle is dropped entirely
    });
    // Different test: two tris, second one has all x>0.
    const g2 = makeGeo({
      positions: [
        -1, 0, 0,    //0
         1, 0, 0,    //1
         2, 0, 0,    //2
         3, 0, 0,    //3
      ],
      normals: [0,0,1,  1,0,0,  0,1,0,  0,0,1],
      uvs: [0,0, 0.1,0.1, 0.2,0.2, 0.3,0.3],
      indices: [0,1,2,  1,2,3],  // tri0 straddles (has vert 0 at x=-1); tri1 all x>0
    });
    const out = sliceGeometryByPredicate(g2, (x) => x > 0);
    expect(out.index.count).toBe(3);   // just tri1
    expect(out.attributes.position.count).toBe(3);   // verts 1,2,3 remapped
    expect(out.attributes.normal).toBeDefined();
    expect(out.attributes.uv).toBeDefined();
    expect(out.attributes.uv.count).toBe(3);
    // Verify a UV value round-trip: vertex 1 had uv (0.1,0.1); after remap it becomes vertex 0.
    expect(out.attributes.uv.getX(0)).toBeCloseTo(0.1, 5);
    expect(out.attributes.uv.getY(0)).toBeCloseTo(0.1, 5);
  });

  it('GS8. returned geometry is a new instance (source untouched)', () => {
    const g = makeGeo({
      positions: [0,0,0, 1,0,0, 0,1,0],
      indices: [0,1,2],
    });
    const out = sliceGeometryByPredicate(g, () => true);
    expect(out).not.toBe(g);
    // Source vertex count unchanged.
    expect(g.attributes.position.count).toBe(3);
  });

  it('GS9. predicate receives the vertex index as 4th argument', () => {
    // Two triangles on identical coordinates — only the vertex index can
    // distinguish them. An index-mask predicate must keep exactly tri 2.
    const g = makeGeo({
      positions: [
        0, 0, 0,  1, 0, 0,  0, 1, 0,   // verts 0..2 (tri 1)
        0, 0, 0,  1, 0, 0,  0, 1, 0,   // verts 3..5 (tri 2, same coords)
      ],
      indices: [0, 1, 2,  3, 4, 5],
    });
    const out = sliceGeometryByPredicate(g, (_x, _y, _z, v) => v >= 3);
    expect(out.index.count).toBe(3);
    expect(out.attributes.position.count).toBe(3);
  });

  it('GS10. 3-arg predicates keep working unchanged (regression)', () => {
    const g = makeGeo({
      positions: [
        -1, 0, 0,   1, 0, 0,   2, 0, 0,   3, 0, 0,
      ],
      indices: [0, 1, 2,  1, 2, 3],   // tri0 straddles; tri1 all x>0
    });
    const out = sliceGeometryByPredicate(g, (x) => x > 0);
    expect(out.index.count).toBe(3);
    expect(out.attributes.position.count).toBe(3);
  });
});
