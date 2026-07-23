/**
 * verify-occupancy-perf.mjs — scanline voxelization on the REAL gt.glb.
 *
 *   node scripts/verify-occupancy-perf.mjs
 *
 * Decodes the GT mega-mesh (the 224k-vert monolith that made buildOccupancy
 * cost ~3.5 s in the browser), voxelizes it at the production resolution
 * (96×40×56) over its measured bounds (+0.15 m margin, as main.js does),
 * through BOTH paths:
 *   • buildOccupancy                     — new scanline fill
 *   • _internal.buildOccupancyReference  — old per-voxel fill
 * Asserts byte-identical `data` and prints the before/after ms.
 * (GLB decode plumbing mirrors verify-gt-wheels.mjs.)
 */

import draco3d from 'draco3dgltf';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTTextureWebP, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import * as THREE from 'three';
import { buildOccupancy, _internal } from '../js/body-sdf.js';
import { CAR_MANIFEST } from '../js/car-manifest.js';

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP, KHRMaterialsSpecular])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });

const doc = await io.read(new URL('../assets/models/gt.glb', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = doc.getRoot();

function nodeWorldMatrix(node) {
  let m = new THREE.Matrix4().fromArray(node.getMatrix());
  let cur = node;
  for (;;) {
    const parents = cur.listParents().filter(p => p.propertyType === 'Node');
    if (!parents.length) break;
    cur = parents[0];
    m = new THREE.Matrix4().fromArray(cur.getMatrix()).multiply(m);
  }
  return m;
}

const megaName = CAR_MANIFEST.gt.wheelBake.mesh;
let mesh = null;
for (const node of root.listNodes()) {
  const m = node.getMesh();
  if (!m) continue;
  if (node.getName() === megaName || m.getName() === megaName) {
    const prim = m.listPrimitives()[0];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(prim.getAttribute('POSITION').getArray().slice(), 3));
    geo.setIndex(new THREE.BufferAttribute(prim.getIndices().getArray().slice(), 1));
    geo.applyMatrix4(nodeWorldMatrix(node));
    mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    break;
  }
}
if (!mesh) {
  console.error(`FAIL: mesh "${megaName}" not found in gt.glb`);
  process.exit(1);
}

const scene = new THREE.Group();
scene.rotation.set(...CAR_MANIFEST.gt.transform.rotation);
scene.add(mesh);
scene.updateMatrixWorld(true);

// main.js buildBodyOccupancyFor: bbox union + 0.15 m margin, 96×40×56.
const bbox = new THREE.Box3().setFromObject(mesh);
const M = 0.15;
const opts = {
  resolution: { x: 96, y: 40, z: 56 },
  bounds: {
    min: [bbox.min.x - M, bbox.min.y - M, bbox.min.z - M],
    max: [bbox.max.x + M, bbox.max.y + M, bbox.max.z + M],
  },
};
const tris = mesh.geometry.index.array.length / 3;
console.log(`gt mega-mesh: ${mesh.geometry.attributes.position.count} verts, ${tris} tris`);
console.log(`bounds y ${opts.bounds.min[1].toFixed(2)}..${opts.bounds.max[1].toFixed(2)}, res 96x40x56`);

const t0 = performance.now();
const ref = _internal.buildOccupancyReference([mesh], opts);
const msRef = performance.now() - t0;

const t1 = performance.now();
const fast = buildOccupancy([mesh], opts);
const msFast = performance.now() - t1;

let diffs = 0, occupied = 0;
for (let i = 0; i < ref.data.length; i++) {
  if (ref.data[i]) occupied++;
  if (ref.data[i] !== fast.data[i]) diffs++;
}

console.log(`per-voxel (old): ${msRef.toFixed(0)} ms`);
console.log(`scanline (new):  ${msFast.toFixed(0)} ms  (${(msRef / msFast).toFixed(1)}×)`);
console.log(`occupied voxels: ${occupied} / ${ref.data.length}`);
console.log(diffs === 0 ? 'PASS: byte-identical data' : `FAIL: ${diffs} voxels differ`);
process.exit(diffs === 0 ? 0 : 1);
