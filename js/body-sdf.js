/**
 * body-sdf.js — Binary occupancy field built from car body meshes.
 *
 * Phase B of the calm-petting-willow plan. Streamlines and smoke particles
 * consult this field to avoid clipping through the halo, monocoque, wings.
 *
 * No three.js import at module top — the mesh inputs only need:
 *   { geometry: { attributes: { position: { array, itemSize, count } },
 *                 index?: { array } },
 *     matrixWorld? }
 *
 * Algorithm:
 *   For each voxel centre, cast a ray in +X and count triangle intersections
 *   against the union of input mesh triangles. Odd count = inside.
 *   Per-triangle bbox pruning skips tris whose Y/Z bbox doesn't straddle the
 *   voxel's (Y, Z).
 */

const DEFAULT_RES    = { x: 96, y: 40, z: 56 };
const DEFAULT_BOUNDS = { min: [-1.2, -0.7, -3.0], max: [+1.2, +1.1, +3.0] };

/**
 * Möller–Trumbore ray-triangle intersection for a slightly-perturbed +X ray.
 * Direction = RAY_DIR (near-unit X with tiny y/z offsets) so axis-aligned
 * meshes don't produce shared-edge double-counts.
 *
 * Returns true iff the ray hits the triangle at t > 0.
 *
 * The ray direction is fixed in this file — see RAY_DIR below.
 */
const RAY_DIR = { x: 1, y: 1e-5, z: 2e-5 };

function rayPlusXHitsTri(ox, oy, oz,
                         ax, ay, az,
                         bx, by, bz,
                         cx, cy, cz) {
  const dx = RAY_DIR.x, dy = RAY_DIR.y, dz = RAY_DIR.z;
  // Edges
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  // pvec = dir × e2
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return false;   // parallel
  const invDet = 1 / det;

  // tvec = orig - a
  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;

  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return false;

  // qvec = tvec × e1
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  // v = dir · qvec
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return false;

  // t = e2 · qvec
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 1e-9;   // strictly forward, ignore touches at origin
}

/**
 * Pull indexed / non-indexed triangle list out of one mesh. Applies
 * matrixWorld if provided (4x4 column-major float array with elements
 * field — mimics three.js Matrix4 but we only need {elements: Float32Array}).
 *
 * Returns an array of {ax,ay,az,bx,by,bz,cx,cy,cz, minY,maxY, minZ,maxZ}
 * objects — bbox fields are cached for per-voxel pruning.
 */
function extractTriangles(mesh) {
  const geom = mesh.geometry;
  if (!geom || !geom.attributes || !geom.attributes.position) return [];
  const pos = geom.attributes.position.array;
  const idx = geom.index?.array || null;

  const tris = [];
  const mw   = mesh.matrixWorld?.elements || null;

  const transform = (x, y, z) => {
    if (!mw) return [x, y, z];
    // column-major: mw[0..3] = col 0, mw[4..7] = col 1, etc.
    const wx = mw[0] * x + mw[4] * y + mw[8]  * z + mw[12];
    const wy = mw[1] * x + mw[5] * y + mw[9]  * z + mw[13];
    const wz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
    return [wx, wy, wz];
  };

  const triCount = idx ? (idx.length / 3) : (pos.length / 9);
  for (let t = 0; t < triCount; t++) {
    let iA, iB, iC;
    if (idx) {
      iA = idx[t * 3]     * 3;
      iB = idx[t * 3 + 1] * 3;
      iC = idx[t * 3 + 2] * 3;
    } else {
      iA = t * 9;
      iB = t * 9 + 3;
      iC = t * 9 + 6;
    }
    const [ax, ay, az] = transform(pos[iA],     pos[iA + 1], pos[iA + 2]);
    const [bx, by, bz] = transform(pos[iB],     pos[iB + 1], pos[iB + 2]);
    const [cx, cy, cz] = transform(pos[iC],     pos[iC + 1], pos[iC + 2]);

    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    const minZ = Math.min(az, bz, cz);
    const maxZ = Math.max(az, bz, cz);

    tris.push({ ax, ay, az, bx, by, bz, cx, cy, cz, minY, maxY, minZ, maxZ });
  }
  return tris;
}

/**
 * Build a binary occupancy field over the given world-space AABB.
 *
 * @param {Array} meshes — objects with {geometry, matrixWorld?} (three.js
 *                         meshes or plain test fixtures).
 * @param {object} [opts]
 * @param {object} [opts.resolution={x:96,y:40,z:56}]
 * @param {object} [opts.bounds={min:[-1.2,-0.7,-3.0],max:[+1.2,+1.1,+3.0]}]
 * @returns {{
 *   data: Uint8Array,
 *   bounds: {min:number[], max:number[]},
 *   res: {x:number,y:number,z:number},
 *   sample(x:number,y:number,z:number):number,
 *   gradient(x:number,y:number,z:number):{x:number,y:number,z:number}
 * }}
 */
export function buildOccupancy(meshes, opts = {}) {
  const res    = opts.resolution || DEFAULT_RES;
  const bounds = opts.bounds     || DEFAULT_BOUNDS;
  const nx = res.x, ny = res.y, nz = res.z;
  const [bx0, by0, bz0] = bounds.min;
  const [bx1, by1, bz1] = bounds.max;

  const dx = (bx1 - bx0) / nx;
  const dy = (by1 - by0) / ny;
  const dz = (bz1 - bz0) / nz;

  const data = new Uint8Array(nx * ny * nz);

  // Gather all triangles once
  const tris = [];
  for (const m of (meshes || [])) {
    const mt = extractTriangles(m);
    for (let i = 0; i < mt.length; i++) tris.push(mt[i]);
  }

  // For each (y, z) row, pre-filter triangles whose Y/Z bbox straddles that
  // row, then for each voxel in +X count intersections (parity → inside).
  // We ray-cast from bx0 - 1 along +X so every ray starts OUTSIDE the domain,
  // independent of voxel x — parity at each voxel is then derived from the
  // sorted t-list, but that's slower; simpler: cast per-voxel. The per-tri
  // Y/Z bbox prune already cuts most rejections.
  for (let iy = 0; iy < ny; iy++) {
    const y = by0 + (iy + 0.5) * dy;
    // First Y-band prune
    const yBand = [];
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      if (tri.maxY < y || tri.minY > y) continue;
      yBand.push(tri);
    }
    for (let iz = 0; iz < nz; iz++) {
      const z = bz0 + (iz + 0.5) * dz;
      // Z-band prune
      const row = [];
      for (let t = 0; t < yBand.length; t++) {
        const tri = yBand[t];
        if (tri.maxZ < z || tri.minZ > z) continue;
        row.push(tri);
      }
      if (row.length === 0) continue;

      for (let ix = 0; ix < nx; ix++) {
        const x = bx0 + (ix + 0.5) * dx;
        let hits = 0;
        for (let t = 0; t < row.length; t++) {
          const tri = row[t];
          if (rayPlusXHitsTri(x, y, z,
                              tri.ax, tri.ay, tri.az,
                              tri.bx, tri.by, tri.bz,
                              tri.cx, tri.cy, tri.cz)) {
            hits++;
          }
        }
        if ((hits & 1) === 1) {
          data[ix + iy * nx + iz * nx * ny] = 1;
        }
      }
    }
  }

  function inBounds(x, y, z) {
    return x >= bx0 && x <= bx1
        && y >= by0 && y <= by1
        && z >= bz0 && z <= bz1;
  }

  function sample(x, y, z) {
    if (!inBounds(x, y, z)) return 0;
    // Nearest-voxel lookup — clamp indices into [0, n-1].
    let ix = Math.floor((x - bx0) / dx);
    let iy = Math.floor((y - by0) / dy);
    let iz = Math.floor((z - bz0) / dz);
    if (ix < 0) ix = 0; if (ix >= nx) ix = nx - 1;
    if (iy < 0) iy = 0; if (iy >= ny) iy = ny - 1;
    if (iz < 0) iz = 0; if (iz >= nz) iz = nz - 1;
    return data[ix + iy * nx + iz * nx * ny];
  }

  function gradient(x, y, z) {
    const gx = sample(x + dx, y, z) - sample(x - dx, y, z);
    const gy = sample(x, y + dy, z) - sample(x, y - dy, z);
    const gz = sample(x, y, z + dz) - sample(x, y, z - dz);
    return { x: gx, y: gy, z: gz };
  }

  return { data, bounds, res, sample, gradient };
}

export const _internal = { rayPlusXHitsTri, extractTriangles };
