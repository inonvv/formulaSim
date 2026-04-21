/**
 * body-sdf.test.js — Phase B1
 *
 * Tests the binary occupancy field builder. The real `three` is mocked here
 * (as in all our test files), and body-sdf.js itself is three-free so we
 * can pass plain-object meshes with {geometry:{attributes:{position}}, index?}.
 */
import { describe, it, expect } from 'vitest';
import { buildOccupancy } from '../body-sdf.js';

/* ── Helpers ─────────────────────────────────────────────────────── */

/**
 * Build a solid (triangulated) axis-aligned box mesh as a plain object.
 * Returns { geometry: { attributes: { position }, index } } — no matrixWorld
 * means positions are used as world-space directly.
 */
function makeBoxMesh({ min, max }) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  // 8 corners, 6 faces x 2 tris = 12 tris, 36 indices.
  const positions = new Float32Array([
    x0, y0, z0,  // 0
    x1, y0, z0,  // 1
    x1, y1, z0,  // 2
    x0, y1, z0,  // 3
    x0, y0, z1,  // 4
    x1, y0, z1,  // 5
    x1, y1, z1,  // 6
    x0, y1, z1,  // 7
  ]);
  const indices = new Uint16Array([
    // -Z face (normal -Z)   — ccw when viewed from -Z
    0, 2, 1,   0, 3, 2,
    // +Z face
    4, 5, 6,   4, 6, 7,
    // -Y face
    0, 1, 5,   0, 5, 4,
    // +Y face
    3, 7, 6,   3, 6, 2,
    // -X face
    0, 4, 7,   0, 7, 3,
    // +X face
    1, 2, 6,   1, 6, 5,
  ]);
  return {
    geometry: {
      attributes: { position: { array: positions, itemSize: 3, count: 8 } },
      index:      { array: indices },
    },
  };
}

/**
 * Procedural torus-like mesh generator for the perf test. Generates a
 * parametric torus of given (major, minor) radii and (segU, segV) subdivision.
 * Returns a plain-object mesh with a Float32Array positions buffer and a
 * Uint32Array index buffer.
 */
function makeTorusMesh(R, r, segU, segV) {
  const positions = new Float32Array(segU * segV * 3);
  const indices   = new Uint32Array(segU * segV * 6);
  let pi = 0;
  for (let u = 0; u < segU; u++) {
    const a = (u / segU) * Math.PI * 2;
    for (let v = 0; v < segV; v++) {
      const b = (v / segV) * Math.PI * 2;
      const x = (R + r * Math.cos(b)) * Math.cos(a);
      const y = r * Math.sin(b);
      const z = (R + r * Math.cos(b)) * Math.sin(a);
      positions[pi++] = x;
      positions[pi++] = y;
      positions[pi++] = z;
    }
  }
  let ii = 0;
  for (let u = 0; u < segU; u++) {
    const uNext = (u + 1) % segU;
    for (let v = 0; v < segV; v++) {
      const vNext = (v + 1) % segV;
      const i00 = u     * segV + v;
      const i01 = u     * segV + vNext;
      const i10 = uNext * segV + v;
      const i11 = uNext * segV + vNext;
      indices[ii++] = i00; indices[ii++] = i10; indices[ii++] = i11;
      indices[ii++] = i00; indices[ii++] = i11; indices[ii++] = i01;
    }
  }
  return {
    geometry: {
      attributes: { position: { array: positions, itemSize: 3, count: positions.length / 3 } },
      index:      { array: indices },
    },
  };
}

/* ── Tests ───────────────────────────────────────────────────────── */

describe('buildOccupancy — unit cube at origin', () => {
  const cube = makeBoxMesh({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });

  it('sample inside (0,0,0) returns 1; outside (1.5,1.5,1.5) returns 0', () => {
    const occ = buildOccupancy([cube], {
      resolution: { x: 32, y: 32, z: 32 },
      bounds: { min: [-1.5, -1.5, -1.5], max: [+1.5, +1.5, +1.5] },
    });
    expect(occ.sample(0, 0, 0)).toBe(1);
    expect(occ.sample(1.5, 1.5, 1.5)).toBe(0);
    // Just outside the cube but inside the grid should also be 0.
    expect(occ.sample(0.9, 0.9, 0.9)).toBe(0);
  });
});

describe('buildOccupancy — resolution respected', () => {
  const cube = makeBoxMesh({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });

  it('32^3 vs 64^3 produce different data.length', () => {
    const a = buildOccupancy([cube], {
      resolution: { x: 32, y: 32, z: 32 },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    });
    const b = buildOccupancy([cube], {
      resolution: { x: 64, y: 64, z: 64 },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    });
    expect(a.data.length).toBe(32 * 32 * 32);
    expect(b.data.length).toBe(64 * 64 * 64);
    expect(a.data.length).not.toBe(b.data.length);
  });
});

describe('buildOccupancy — gradient points outward across a face', () => {
  const cube = makeBoxMesh({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
  // High enough resolution that a voxel lies cleanly just-inside/just-outside
  // the +X face.
  const occ = buildOccupancy([cube], {
    resolution: { x: 40, y: 40, z: 40 },
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  });

  it('gradient at the +X face points in -X direction (inside→outside transition)', () => {
    // Straddle the +X face: we expect sample(0.4,0,0)≈1 and sample(0.6,0,0)≈0,
    // so gradient.x = sample(+dx) - sample(-dx) is negative (since +dx is outside,
    // -dx is inside). The dominant component must be X and its sign -1.
    const g = occ.gradient(0.5, 0, 0);
    expect(Math.abs(g.x)).toBeGreaterThanOrEqual(Math.abs(g.y));
    expect(Math.abs(g.x)).toBeGreaterThanOrEqual(Math.abs(g.z));
    expect(g.x).toBeLessThan(0);
  });
});

describe('buildOccupancy — bounds parameter crops', () => {
  const cube = makeBoxMesh({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });

  it('point outside configured bounds returns 0 even if inside the cube', () => {
    // Bounds exclude the cube entirely — sample(0,0,0) is inside cube but
    // outside bounds, so must return 0.
    const occ = buildOccupancy([cube], {
      resolution: { x: 8, y: 8, z: 8 },
      bounds: { min: [2, 2, 2], max: [3, 3, 3] },
    });
    expect(occ.sample(0, 0, 0)).toBe(0);
  });
});

describe('buildOccupancy — multi-mesh union', () => {
  it('two offset cubes both report inside', () => {
    const a = makeBoxMesh({ min: [-0.8, -0.3, -0.3], max: [-0.3, 0.3, 0.3] });
    const b = makeBoxMesh({ min: [ 0.3, -0.3, -0.3], max: [ 0.8, 0.3, 0.3] });
    const occ = buildOccupancy([a, b], {
      resolution: { x: 40, y: 16, z: 16 },
      bounds: { min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] },
    });
    // Interior of cube a
    expect(occ.sample(-0.55, 0, 0)).toBe(1);
    // Interior of cube b
    expect(occ.sample( 0.55, 0, 0)).toBe(1);
    // Gap between them
    expect(occ.sample(   0,  0, 0)).toBe(0);
  });
});

describe('buildOccupancy — sample out of bounds', () => {
  it('returns 0', () => {
    const cube = makeBoxMesh({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
    const occ = buildOccupancy([cube], {
      resolution: { x: 8, y: 8, z: 8 },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    });
    expect(occ.sample(-10, 0, 0)).toBe(0);
    expect(occ.sample(0, 50, 0)).toBe(0);
    expect(occ.sample(0, 0, 5)).toBe(0);
  });
});

describe('buildOccupancy — gradient deep inside is ~0', () => {
  it('gradient components all near zero far from any face', () => {
    // Large cube, small sample region deep inside.
    const cube = makeBoxMesh({ min: [-2, -2, -2], max: [2, 2, 2] });
    const occ = buildOccupancy([cube], {
      resolution: { x: 40, y: 40, z: 40 },
      bounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    });
    const g = occ.gradient(0, 0, 0);
    expect(g.x).toBe(0);
    expect(g.y).toBe(0);
    expect(g.z).toBe(0);
  });
});

describe('buildOccupancy — perf budget', () => {
  it('96x40x56 grid against ~3k-triangle torus builds in under 3s', () => {
    // Torus with segU=48, segV=24 → 48*24*2 = 2304 tris (close to 3k).
    const torus = makeTorusMesh(0.8, 0.3, 48, 24);
    const t0 = performance.now();
    const occ = buildOccupancy([torus], {
      resolution: { x: 96, y: 40, z: 56 },
      bounds: { min: [-1.2, -0.7, -3.0], max: [+1.2, +1.1, +3.0] },
    });
    const elapsed = performance.now() - t0;
    expect(occ.data.length).toBe(96 * 40 * 56);
    expect(elapsed).toBeLessThan(3000);
  });
});
