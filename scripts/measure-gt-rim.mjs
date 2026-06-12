/**
 * measure-gt-rim.mjs — Forensic measurement of the GT wheel split.
 *
 * Question: does the SPINNING fragment contain the visible rim/spokes, or
 * did classification leave them in the static body remainder?
 *
 * Method: decode gt.glb, run connectivity analysis on the mega-mesh, then
 * for every component near a wheel zone report: vert count, bbox, centroid,
 * centroid distance from the wheel axis in (y,z), and whether the production
 * classifyWheelComponents adopts it.
 */

import draco3d from 'draco3dgltf';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTTextureWebP, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import * as THREE from 'three';
import { computeConnectedComponents, summarizeComponents } from '../js/geometry-split.js';
import { classifyWheelComponents } from '../js/car-loader.js';
import { CAR_MANIFEST } from '../js/car-manifest.js';

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP, KHRMaterialsSpecular])
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const doc = await io.read('assets/models/gt.glb');
const root = doc.getRoot();

const wheelBake = CAR_MANIFEST.gt.wheelBake;
let prim = null, nodeMat = null;
function worldMat(node) {
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
for (const node of root.listNodes()) {
  const m = node.getMesh();
  if (!m) continue;
  if (node.getName() === wheelBake.mesh || m.getName() === wheelBake.mesh) {
    prim = m.listPrimitives()[0];
    nodeMat = worldMat(node);
    break;
  }
}

// Build car-local positions: node world matrix + manifest rotation [0,π,0].
const rot = new THREE.Matrix4().makeRotationY(Math.PI);
const full = rot.multiply(nodeMat);
const srcPos = prim.getAttribute('POSITION').getArray();
const n = prim.getAttribute('POSITION').getCount();
const pos = new Float32Array(n * 3);
const v = new THREE.Vector3();
for (let i = 0; i < n; i++) {
  v.set(srcPos[i*3], srcPos[i*3+1], srcPos[i*3+2]).applyMatrix4(full);
  pos[i*3] = v.x; pos[i*3+1] = v.y; pos[i*3+2] = v.z;
}
const idx = prim.getIndices().getArray();

const { labels, count } = computeConnectedComponents(idx, n);
const summaries = summarizeComponents(pos, labels, count);
const cls = classifyWheelComponents(summaries, wheelBake);
if (!cls) { console.error('classification failed'); process.exit(1); }

const corners = Object.entries(cls.corners).map(([k, c]) => ({ k, ...c.center, r: c.radius }));
console.log('wheel centers:', corners.map(c => `${c.k}(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`).join(' '), 'r =', corners[0].r.toFixed(3));

// Every component whose bbox intersects a wheel cylinder (axis x, radius r*1.15, width ±0.45 around axle x).
console.log('\n--- components intersecting wheel zones (vert>30) ---');
console.log('verts | centroid           | bbox size          | dAxis(y,z) | |x|ctr | adopted');
let staticVertsInWheel = 0;
for (const s of summaries) {
  if (s.vertCount < 30) continue;
  for (const c of corners) {
    // bbox vs cylinder rough test: bbox overlaps |x| band and (y,z) disc
    const ox = s.max[0] >= c.x - 0.45 && s.min[0] <= c.x + 0.45 && Math.sign(s.centroid[0]) === Math.sign(c.x);
    const cy = (s.min[1] + s.max[1]) / 2, cz = (s.min[2] + s.max[2]) / 2;
    const dC = Math.hypot(cy - c.y, cz - c.z);
    if (!ox || dC > c.r * 1.3) continue;
    const dAxis = Math.hypot(s.centroid[1] - c.y, s.centroid[2] - c.z);
    const adopted = cls.wheelComponentToCorner.has(s.id);
    const size = [0,1,2].map(k => (s.max[k]-s.min[k]).toFixed(2)).join(',');
    const ctr = s.centroid.map(x => x.toFixed(2)).join(',');
    console.log(
      String(s.vertCount).padStart(5), '|', ctr.padEnd(18), '| [' + size + ']',
      '|', dAxis.toFixed(3), '|', Math.abs(s.centroid[0]).toFixed(2),
      '|', adopted ? 'SPIN' : '*** STATIC ***', 'corner', c.k
    );
    if (!adopted) staticVertsInWheel += s.vertCount;
    break;
  }
}
console.log(`\nstatic verts inside wheel zones: ${staticVertsInWheel}`);
