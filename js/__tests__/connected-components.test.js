import { describe, it, expect } from 'vitest';
import { computeConnectedComponents, summarizeComponents } from '../geometry-split.js';

/* Pure typed-array tests — no THREE involved. */

describe('computeConnectedComponents', () => {
  it('CC1. two disjoint triangles → 2 components with correct partition', () => {
    const idx = new Uint16Array([0, 1, 2,  3, 4, 5]);
    const { labels, count } = computeConnectedComponents(idx, 6);
    expect(count).toBe(2);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[1]).toBe(labels[2]);
    expect(labels[3]).toBe(labels[4]);
    expect(labels[4]).toBe(labels[5]);
    expect(labels[0]).not.toBe(labels[3]);
  });

  it('CC2. two triangles sharing a vertex → 1 component', () => {
    const idx = new Uint16Array([0, 1, 2,  2, 3, 4]);
    const { labels, count } = computeConnectedComponents(idx, 5);
    expect(count).toBe(1);
    for (let v = 1; v < 5; v++) expect(labels[v]).toBe(labels[0]);
  });

  it('CC3. transitive merge across a chain of triangles', () => {
    // tri A (0,1,2) shares v2 with tri B (2,3,4); tri B shares v4 with tri C (4,5,6).
    const idx = new Uint16Array([0, 1, 2,  2, 3, 4,  4, 5, 6]);
    const { labels, count } = computeConnectedComponents(idx, 7);
    expect(count).toBe(1);
    expect(labels[0]).toBe(labels[6]);
  });

  it('CC4. accepts Uint16Array and Uint32Array index inputs', () => {
    const idx16 = new Uint16Array([0, 1, 2]);
    const idx32 = new Uint32Array([0, 1, 2]);
    expect(computeConnectedComponents(idx16, 3).count).toBe(1);
    expect(computeConnectedComponents(idx32, 3).count).toBe(1);
  });

  it('CC5. vertices referenced by no triangle become singleton components', () => {
    // 4 vertices, only 0..2 in a triangle; vertex 3 is an orphan.
    const idx = new Uint16Array([0, 1, 2]);
    const { labels, count } = computeConnectedComponents(idx, 4);
    expect(count).toBe(2);
    expect(labels[3]).not.toBe(labels[0]);
  });
});

describe('summarizeComponents', () => {
  it('CC6. per-component vertCount / bbox / centroid are correct', () => {
    // Component A: verts 0..2 (triangle), component B: verts 3..5.
    const idx = new Uint16Array([0, 1, 2,  3, 4, 5]);
    const positions = new Float32Array([
      0, 0, 0,   2, 0, 0,   1, 3, 0,      // A: bbox [0,0,0]..[2,3,0], centroid (1,1,0)
      10, 10, 10,  12, 10, 10,  11, 10, 13, // B: bbox [10,10,10]..[12,10,13], centroid (11,10,11)
    ]);
    const { labels, count } = computeConnectedComponents(idx, 6);
    const summaries = summarizeComponents(positions, labels, count);
    expect(summaries).toHaveLength(2);

    const a = summaries.find(s => s.min[0] === 0);
    const b = summaries.find(s => s.min[0] === 10);
    expect(a.vertCount).toBe(3);
    expect(a.min).toEqual([0, 0, 0]);
    expect(a.max).toEqual([2, 3, 0]);
    expect(a.centroid[0]).toBeCloseTo(1, 5);
    expect(a.centroid[1]).toBeCloseTo(1, 5);
    expect(a.centroid[2]).toBeCloseTo(0, 5);

    expect(b.vertCount).toBe(3);
    expect(b.max).toEqual([12, 10, 13]);
    expect(b.centroid[0]).toBeCloseTo(11, 5);
    expect(b.centroid[1]).toBeCloseTo(10, 5);
    expect(b.centroid[2]).toBeCloseTo(11, 5);
  });

  it('CC7. scales to GLB-sized buffers well under a second', () => {
    // 100k verts in 50k disjoint 2-triangle pairs → 715k-index analogue.
    const VERTS = 100_000;
    const idx = new Uint32Array((VERTS / 4) * 6);
    const positions = new Float32Array(VERTS * 3);
    for (let q = 0; q < VERTS / 4; q++) {
      const v = q * 4;
      idx.set([v, v + 1, v + 2,  v + 1, v + 2, v + 3], q * 6);
      for (let k = 0; k < 4; k++) {
        positions[(v + k) * 3] = q;
        positions[(v + k) * 3 + 1] = k;
        positions[(v + k) * 3 + 2] = 0;
      }
    }
    const t0 = performance.now();
    const { labels, count } = computeConnectedComponents(idx, VERTS);
    const summaries = summarizeComponents(positions, labels, count);
    const ms = performance.now() - t0;
    expect(count).toBe(VERTS / 4);
    expect(summaries).toHaveLength(VERTS / 4);
    expect(ms).toBeLessThan(1000);
  });
});
