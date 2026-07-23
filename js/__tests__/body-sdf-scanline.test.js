/**
 * body-sdf-scanline.test.js — Phase 3: occupancy scanline voxelization.
 *
 * buildOccupancy's inner loop was per-voxel: for each (y,z) row, 96 point
 * parity ray-casts x |row| Möller tests each (the GT mega-mesh cost ~3.5 s).
 * The rewrite computes each row-triangle's crossing x* ONCE per row (same
 * Möller math, same epsilon/edge semantics, returning x* instead of a
 * boolean-at-origin), sorts the crossings, and parity-fills the row:
 * voxel inside ⟺ odd number of crossings beyond the voxel centre.
 *
 * Equivalence is the whole game: the OLD per-voxel loop is kept as
 * _internal.buildOccupancyReference, and every fixture below must produce
 * BYTE-IDENTICAL `data` through both paths. Bounds are deliberately
 * non-round so voxel rows never sit exactly on fixture edges/diagonals.
 */
import { describe, it, expect } from 'vitest';
import { buildOccupancy, _internal } from '../body-sdf.js';

/* ── Fixtures (plain-object meshes — body-sdf.js is three-free) ──── */

function makeBoxMesh({ min, max }) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1,   0, 3, 2,      // -Z
    4, 5, 6,   4, 6, 7,      // +Z
    0, 1, 5,   0, 5, 4,      // -Y
    3, 7, 6,   3, 6, 2,      // +Y
    0, 4, 7,   0, 7, 3,      // -X
    1, 2, 6,   1, 6, 5,      // +X
  ]);
  return {
    geometry: {
      attributes: { position: { array: positions, itemSize: 3, count: 8 } },
      index:      { array: indices },
    },
  };
}

/** Icosphere (subdivided icosahedron), non-indexed — generic-position tris. */
function makeIcosphereMesh(radius = 0.83, subdiv = 2, center = [0.013, -0.021, 0.017]) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(v => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const norm = (v) => { const n = Math.hypot(...v); return [v[0] / n, v[1] / n, v[2] / n]; };
  const mid  = (a, b) => norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  for (let s = 0; s < subdiv; s++) {
    const next = [];
    for (const [ia, ib, ic] of faces) {
      const a = verts[ia], b = verts[ib], c = verts[ic];
      const ab = verts.push(mid(a, b)) - 1;
      const bc = verts.push(mid(b, c)) - 1;
      const ca = verts.push(mid(c, a)) - 1;
      next.push([ia, ab, ca], [ib, bc, ab], [ic, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float32Array(faces.length * 9);
  let pi = 0;
  for (const f of faces) {
    for (const vi of f) {
      const v = verts[vi];
      positions[pi++] = v[0] * radius + center[0];
      positions[pi++] = v[1] * radius + center[1];
      positions[pi++] = v[2] * radius + center[2];
    }
  }
  return {
    geometry: {
      attributes: { position: { array: positions, itemSize: 3, count: faces.length * 3 } },
    },
  };
}

/** Degenerate / coplanar soup: zero-area tris, ray-parallel slivers, and a
 *  duplicated coplanar pair on top of a closed box. */
function makeDegenerateSoupMesh() {
  const positions = new Float32Array([
    // zero-area (all three verts identical)
    0.11, 0.12, 0.13,   0.11, 0.12, 0.13,   0.11, 0.12, 0.13,
    // zero-area (collinear)
    -0.5, 0.2, 0.1,   0.0, 0.2, 0.1,   0.5, 0.2, 0.1,
    // sliver almost parallel to the +X ray (lies in an x-parallel plane)
    -0.6, 0.31, -0.4,   0.6, 0.31, -0.4,   0.6, 0.31, 0.4,
    // coplanar duplicate pair (same plane z = 0.27, overlapping)
    -0.4, -0.4, 0.27,   0.4, -0.4, 0.27,   0.0, 0.4, 0.27,
    -0.4, -0.4, 0.27,   0.4, -0.4, 0.27,   0.0, 0.4, 0.27,
  ]);
  return {
    geometry: {
      attributes: { position: { array: positions, itemSize: 3, count: 15 } },
    },
  };
}

/* ── Byte-equality harness ───────────────────────────────────────── */

// Non-round bounds/res: voxel centres land in generic position relative to
// the fixtures (no row exactly on a face plane or triangulation diagonal).
const OPTS = {
  resolution: { x: 96, y: 40, z: 56 },
  bounds: { min: [-1.037, -1.011, -1.023], max: [1.041, 1.019, 1.013] },
};

function expectByteIdentical(meshes, opts = OPTS, { expectOccupied = true } = {}) {
  const fast = buildOccupancy(meshes, opts);
  const ref  = _internal.buildOccupancyReference(meshes, opts);
  expect(fast.data.length).toBe(ref.data.length);
  let firstDiff = -1, occupied = 0;
  for (let i = 0; i < ref.data.length; i++) {
    if (ref.data[i]) occupied++;
    if (firstDiff < 0 && fast.data[i] !== ref.data[i]) firstDiff = i;
  }
  expect(firstDiff, `data diverges at voxel ${firstDiff}`).toBe(-1);
  if (expectOccupied) {
    expect(occupied, 'fixture voxelized to nothing — vacuous equality').toBeGreaterThan(0);
  }
  return { fast, ref, occupied };
}

describe('scanline voxelization ≡ per-voxel reference (byte-identical data)', () => {
  it('SL1. closed cube', () => {
    const { occupied } = expectByteIdentical(
      [makeBoxMesh({ min: [-0.513, -0.402, -0.611], max: [0.487, 0.418, 0.529] })]);
    expect(occupied).toBeGreaterThan(500);
  });

  it('SL2. icosphere (generic-position triangle soup)', () => {
    expectByteIdentical([makeIcosphereMesh()]);
  });

  it('SL3. two disjoint boxes (multiple crossings per row)', () => {
    const { fast } = expectByteIdentical([
      makeBoxMesh({ min: [-0.913, -0.302, -0.411], max: [-0.313, 0.318, 0.329] }),
      makeBoxMesh({ min: [0.187, -0.302, -0.411], max: [0.787, 0.318, 0.329] }),
    ]);
    // Sanity: the gap between the boxes is empty (parity walk resets).
    expect(fast.sample(-0.06, 0.0, 0.0)).toBe(0);
    expect(fast.sample(-0.60, 0.0, 0.0)).toBe(1);
    expect(fast.sample(0.48, 0.0, 0.0)).toBe(1);
  });

  it('SL4. degenerate/coplanar tri soup on top of a closed box', () => {
    expectByteIdentical([
      makeDegenerateSoupMesh(),
      makeBoxMesh({ min: [-0.513, -0.402, -0.611], max: [0.487, 0.418, 0.529] }),
    ]);
  });

  it('SL5. degenerate soup alone — no crash, byte-identical (parity garbage allowed, but equal garbage)', () => {
    expectByteIdentical([makeDegenerateSoupMesh()], OPTS, { expectOccupied: false });
  });

  it('SL6. empty mesh list — both paths all-zero', () => {
    expectByteIdentical([], OPTS, { expectOccupied: false });
  });

  it('SL7. coarse timing log (informational only — never asserted, CI-flaky)', () => {
    const mesh = [makeIcosphereMesh(0.83, 3)];   // 1280 tris
    const t0 = performance.now();
    _internal.buildOccupancyReference(mesh, OPTS);
    const tRef = performance.now() - t0;
    const t1 = performance.now();
    buildOccupancy(mesh, OPTS);
    const tFast = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`[body-sdf-scanline] icosphere(1280 tris) 96x40x56: per-voxel ${tRef.toFixed(0)}ms → scanline ${tFast.toFixed(0)}ms (${(tRef / Math.max(tFast, 0.01)).toFixed(1)}×)`);
    expect(true).toBe(true);
  });
});

describe('API surface unchanged', () => {
  it('SL8. sample/gradient/bounds/res survive the rewrite', () => {
    const occ = buildOccupancy(
      [makeBoxMesh({ min: [-0.513, -0.402, -0.611], max: [0.487, 0.418, 0.529] })], OPTS);
    expect(occ.res).toEqual(OPTS.resolution);
    expect(occ.bounds).toEqual(OPTS.bounds);
    expect(occ.sample(0, 0, 0)).toBe(1);
    expect(occ.sample(0.9, 0.9, 0.9)).toBe(0);
    const g = occ.gradient(0.48, 0, 0);   // near the +X face → outward x-gradient
    expect(g.x).toBeLessThan(0);
    expect(typeof g.y).toBe('number');
  });

  it('SL9. _internal keeps rayPlusXHitsTri + extractTriangles and adds the reference build', () => {
    expect(typeof _internal.rayPlusXHitsTri).toBe('function');
    expect(typeof _internal.extractTriangles).toBe('function');
    expect(typeof _internal.buildOccupancyReference).toBe('function');
  });
});
