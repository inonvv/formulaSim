/**
 * geometry-split.js — Split BufferGeometry by a per-vertex predicate.
 *
 * sliceGeometryByPredicate(srcGeo, keepVertexFn)
 *   Returns a NEW THREE.BufferGeometry containing only triangles whose all 3
 *   vertices pass `keepVertexFn(x, y, z)`. Handles both indexed and non-indexed
 *   source geometries. Re-maps indices to a compact vertex list; preserves
 *   position / normal / uv / tangent attributes verbatim for kept vertices.
 *
 *   Triangles that STRADDLE the split plane (mixed predicate results) are
 *   dropped — callers verify empirically that drop rate is acceptable (the
 *   split plane passes through empty space between L/R wheels in our use case).
 */

import * as THREE from 'three';

/* Attribute names we carry through — if source has them, output gets them. */
const PASSTHROUGH_ATTRS = ['position', 'normal', 'uv', 'tangent'];

/**
 * @param {THREE.BufferGeometry} srcGeo
 * @param {(x: number, y: number, z: number) => boolean} keepVertexFn
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
    keepVert[v] = keepVertexFn(x, y, z) ? 1 : 0;
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
