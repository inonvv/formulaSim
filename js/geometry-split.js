/**
 * geometry-split.js — Split BufferGeometry by a per-vertex predicate, plus
 * pure connectivity analysis over indexed triangle soups.
 *
 * sliceGeometryByPredicate(srcGeo, keepVertexFn)
 *   Returns a NEW THREE.BufferGeometry containing only triangles whose all 3
 *   vertices pass `keepVertexFn(x, y, z, v)`. Handles both indexed and
 *   non-indexed source geometries. Re-maps indices to a compact vertex list;
 *   preserves position / normal / uv / tangent attributes verbatim for kept
 *   vertices.
 *
 *   Triangles that STRADDLE the split plane (mixed predicate results) are
 *   dropped — callers verify empirically that drop rate is acceptable (the
 *   split plane passes through empty space between L/R wheels in our use case).
 *
 * computeConnectedComponents(indexArray, vertexCount)
 * summarizeComponents(positionArray, labels, count)
 *   THREE-free typed-array utilities — union-find over the index buffer.
 *   Used to find geometry islands (e.g. wheels baked into a monolithic GLB
 *   mesh) without relying on mesh names.
 */

import * as THREE from 'three';

/* Attribute names we carry through — if source has them, output gets them. */
const PASSTHROUGH_ATTRS = ['position', 'normal', 'uv', 'tangent'];

/**
 * @param {THREE.BufferGeometry} srcGeo
 * @param {(x: number, y: number, z: number, v: number) => boolean} keepVertexFn
 *   `v` is the source vertex index — lets component-membership masks drive
 *   the split when coordinates alone can't distinguish vertices.
 * @returns {THREE.BufferGeometry}
 */
export function sliceGeometryByPredicate(srcGeo, keepVertexFn) {
  const posAttr = srcGeo.attributes.position;
  if (!posAttr) throw new Error('[geometry-split] source geometry has no position attribute');

  const vertexCount = posAttr.count;

  // Build (or synthesise) the source index — uniform triangle walk for both cases.
  let srcIndex;
  if (srcGeo.index) {
    srcIndex = srcGeo.index.array;
  } else {
    srcIndex = new (vertexCount > 65535 ? Uint32Array : Uint16Array)(vertexCount);
    for (let i = 0; i < vertexCount; i++) srcIndex[i] = i;
  }

  // Predicate cache: each source vertex tested at most once.
  const keepVert = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const x = posAttr.getX(v);
    const y = posAttr.getY(v);
    const z = posAttr.getZ(v);
    keepVert[v] = keepVertexFn(x, y, z, v) ? 1 : 0;
  }

  // Walk triangles, keep only those with ALL 3 vertices passing.
  const triCount = srcIndex.length / 3;
  const keptTris = [];
  const oldToNew = new Int32Array(vertexCount).fill(-1);
  let newVertCount = 0;

  for (let t = 0; t < triCount; t++) {
    const a = srcIndex[t * 3 + 0];
    const b = srcIndex[t * 3 + 1];
    const c = srcIndex[t * 3 + 2];
    if (!keepVert[a] || !keepVert[b] || !keepVert[c]) continue;
    keptTris.push(a, b, c);
    if (oldToNew[a] === -1) oldToNew[a] = newVertCount++;
    if (oldToNew[b] === -1) oldToNew[b] = newVertCount++;
    if (oldToNew[c] === -1) oldToNew[c] = newVertCount++;
  }

  const outGeo = new THREE.BufferGeometry();

  // Build compact vertex buffers for each passthrough attribute the source has.
  for (const name of PASSTHROUGH_ATTRS) {
    const srcAttr = srcGeo.attributes[name];
    if (!srcAttr) continue;
    const itemSize = srcAttr.itemSize;
    const ArrayCtor = srcAttr.array.constructor;
    const dst = new ArrayCtor(newVertCount * itemSize);
    for (let v = 0; v < vertexCount; v++) {
      const n = oldToNew[v];
      if (n === -1) continue;
      for (let k = 0; k < itemSize; k++) {
        dst[n * itemSize + k] = srcAttr.array[v * itemSize + k];
      }
    }
    outGeo.setAttribute(name, new THREE.BufferAttribute(dst, itemSize, srcAttr.normalized));
  }

  // Re-map kept triangle indices to the compact vertex numbering.
  const IdxCtor = newVertCount > 65535 ? Uint32Array : Uint16Array;
  const outIdx = new IdxCtor(keptTris.length);
  for (let i = 0; i < keptTris.length; i++) outIdx[i] = oldToNew[keptTris[i]];
  outGeo.setIndex(new THREE.BufferAttribute(outIdx, 1));

  return outGeo;
}

/**
 * Connected components of a triangle soup: vertices sharing a triangle are
 * in the same component. Union-find with path halving + union by size.
 *
 * @param {Uint16Array|Uint32Array|number[]} indexArray — flat triangle indices
 * @param {number} vertexCount
 * @returns {{ labels: Int32Array, count: number }}
 *   labels[v] ∈ [0, count) — dense component id per vertex. Vertices not
 *   referenced by any triangle become singleton components.
 */
export function computeConnectedComponents(indexArray, vertexCount) {
  const parent = new Int32Array(vertexCount);
  const size = new Int32Array(vertexCount).fill(1);
  for (let v = 0; v < vertexCount; v++) parent[v] = v;

  function find(a) {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];   // path halving
      a = parent[a];
    }
    return a;
  }

  for (let t = 0; t < indexArray.length; t += 3) {
    const a = find(indexArray[t]);
    const b = find(indexArray[t + 1]);
    const c = find(indexArray[t + 2]);
    if (a !== b) {
      const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
      parent[small] = big;
      size[big] += size[small];
    }
    const ab = find(indexArray[t]);
    if (ab !== c) {
      const [big, small] = size[ab] >= size[c] ? [ab, c] : [c, ab];
      parent[small] = big;
      size[big] += size[small];
    }
  }

  // Remap roots to dense ids.
  const labels = new Int32Array(vertexCount);
  const rootToId = new Map();
  let count = 0;
  for (let v = 0; v < vertexCount; v++) {
    const r = find(v);
    let id = rootToId.get(r);
    if (id === undefined) { id = count++; rootToId.set(r, id); }
    labels[v] = id;
  }
  return { labels, count };
}

/**
 * Per-component vertex count, axis-aligned bbox, and centroid.
 *
 * @param {Float32Array} positionArray — flat xyz, 3 * vertexCount
 * @param {Int32Array} labels — from computeConnectedComponents
 * @param {number} count — component count
 * @returns {Array<{ id: number, vertCount: number,
 *                   min: [number,number,number], max: [number,number,number],
 *                   centroid: [number,number,number] }>}
 */
export function summarizeComponents(positionArray, labels, count) {
  const vertCount = new Int32Array(count);
  const min = new Float64Array(count * 3).fill(Infinity);
  const max = new Float64Array(count * 3).fill(-Infinity);
  const sum = new Float64Array(count * 3);

  const n = labels.length;
  for (let v = 0; v < n; v++) {
    const id = labels[v];
    vertCount[id]++;
    for (let k = 0; k < 3; k++) {
      const c = positionArray[v * 3 + k];
      const o = id * 3 + k;
      if (c < min[o]) min[o] = c;
      if (c > max[o]) max[o] = c;
      sum[o] += c;
    }
  }

  const out = new Array(count);
  for (let id = 0; id < count; id++) {
    const o = id * 3;
    out[id] = {
      id,
      vertCount: vertCount[id],
      min: [min[o], min[o + 1], min[o + 2]],
      max: [max[o], max[o + 1], max[o + 2]],
      centroid: [
        sum[o] / vertCount[id],
        sum[o + 1] / vertCount[id],
        sum[o + 2] / vertCount[id],
      ],
    };
  }
  return out;
}
