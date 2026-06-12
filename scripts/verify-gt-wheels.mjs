/**
 * verify-gt-wheels.mjs — Headless end-to-end check of the GT wheel split
 * against the REAL gt.glb (no browser, no mocks).
 *
 *   node scripts/verify-gt-wheels.mjs
 *
 * Decodes assets/models/gt.glb (draco via gltf-transform), reconstructs the
 * mega-mesh as a THREE.BufferGeometry with its node world matrix baked in,
 * wraps it in a scene rotated [0, π, 0] (the manifest transform), and runs
 * the production buildWheelsFromMonolith with the production manifest
 * thresholds. Prints the measured axles/radius and split stats.
 */

import draco3d from 'draco3dgltf';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTTextureWebP, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import * as THREE from 'three';
import { buildWheelsFromMonolith } from '../js/car-loader.js';
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

const wheelBake = CAR_MANIFEST.gt.wheelBake;
let mesh = null;
for (const node of root.listNodes()) {
  const m = node.getMesh();
  if (!m) continue;
  if (node.getName() === wheelBake.mesh || m.getName() === wheelBake.mesh) {
    const prim = m.listPrimitives()[0];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(prim.getAttribute('POSITION').getArray().slice(), 3));
    const normal = prim.getAttribute('NORMAL');
    if (normal) geo.setAttribute('normal', new THREE.BufferAttribute(normal.getArray().slice(), 3));
    const uv = prim.getAttribute('TEXCOORD_0');
    if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv.getArray().slice(), 2));
    geo.setIndex(new THREE.BufferAttribute(prim.getIndices().getArray().slice(), 1));
    geo.applyMatrix4(nodeWorldMatrix(node));   // bake GLB node transform (= loader's mesh-local frame)
    mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = wheelBake.mesh;
    break;
  }
}
if (!mesh) {
  console.error(`FAIL: mesh "${wheelBake.mesh}" not found in gt.glb`);
  process.exit(1);
}

const scene = new THREE.Group();
scene.rotation.set(...CAR_MANIFEST.gt.transform.rotation);
scene.add(mesh);
scene.updateMatrixWorld(true);

const srcVerts = mesh.geometry.attributes.position.count;
const srcTris = mesh.geometry.index.count / 3;
const built = buildWheelsFromMonolith(scene, wheelBake);
if (!built) {
  console.error('FAIL: buildWheelsFromMonolith returned null on the real GLB');
  process.exit(1);
}

const { measure, debug, wheels } = built;
console.log('=== GT wheel split — real gt.glb ===');
console.log(`source: ${srcVerts} verts, ${srcTris} tris`);
console.log(`splitMs: ${debug.splitMs.toFixed(1)} ms   droppedTris: ${debug.droppedTris}`);
console.log('measure:', Object.fromEntries(
  Object.entries(measure).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v])
));
for (const c of ['FL', 'FR', 'RL', 'RR']) {
  const g = wheels[c];
  const frag = g.children[0];
  const bb = new THREE.Box3().setFromBufferAttribute(frag.geometry.attributes.position);
  const ctr = bb.getCenter(new THREE.Vector3());
  console.log(
    `${c}: pos(${g.position.x.toFixed(3)}, ${g.position.y.toFixed(3)}, ${g.position.z.toFixed(3)})` +
    `  verts=${debug.counts[c].fragmentVertCount}` +
    `  recentered-ctr(${ctr.x.toFixed(3)}, ${ctr.y.toFixed(3)}, ${ctr.z.toFixed(3)})`
  );
}
console.log(`remainder: ${mesh.geometry.attributes.position.count} verts, ${mesh.geometry.index.count / 3} tris`);

/* Hard assertions — empirical expectations from the GLB analysis. */
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } };
assert(Math.abs(measure.wheelRadius - 0.39) < 0.02, `wheelRadius ${measure.wheelRadius} ≠ ~0.39`);
assert(Math.abs((measure.rearAxleZ - measure.frontAxleZ) - 2.46) < 0.05, 'wheelbase ≠ ~2.46');
assert(measure.frontAxleZ < 0 && measure.rearAxleZ > 0, 'axle signs wrong (front must be −z)');
assert(debug.droppedTris === 0, `droppedTris ${debug.droppedTris} ≠ 0`);
assert(Math.abs(measure.groundContactY - -0.084) < 0.02, `groundContactY ${measure.groundContactY} ≠ ~−0.084`);
console.log(process.exitCode ? '\n*** FAILED ***' : '\nAll assertions passed.');
