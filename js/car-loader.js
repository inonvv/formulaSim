import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { sliceGeometryByPredicate } from './geometry-split.js';

const _loader = new GLTFLoader();
const _draco  = new DRACOLoader();
_draco.setDecoderPath('/draco/');
_loader.setDRACOLoader(_draco);

/**
 * Load a GLB car body.
 * Returns { scene, wheels, liveryMeshes } on success, or null on any failure.
 * Never rejects — callers should fall back to the procedural builder when null.
 *
 * loadCarFromManifest(manifest) wraps this with manifest-driven classification:
 *   strips GLB wheels, collects livery meshes, resolves rear-wing node, applies transform.
 */
export async function loadCarModel(url) {
  try {
    const gltf = await _loader.loadAsync(url);
    const scene = gltf.scene;
    const wheels       = [];
    const liveryMeshes = [];

    scene.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow    = true;
      child.receiveShadow = true;
      if (child.name.startsWith('wheel_'))  wheels.push(child);
      if (child.name.startsWith('livery_')) liveryMeshes.push(child);
    });

    return { scene, wheels, liveryMeshes };
  } catch (err) {
    console.warn('[car-loader] falling back to procedural:', url, err.message);
    return null;
  }
}

/* Name-based lookup that works on both real Object3D and test fakes. */
function findByName(root, name) {
  let found = null;
  root.traverse(node => { if (node.name === name && !found) found = node; });
  return found;
}

/**
 * Measure tire bboxes in world-space to derive groundContactY + axle X/Z.
 * Must be called BEFORE stripMeshes removes the tire nodes from the scene.
 * World-space is correct here because scene.rotation/position/scale have already
 * been applied and updateMatrixWorld propagates those through the bbox.
 *
 * @returns {{ groundContactY, frontAxleZ, rearAxleZ, frontAxleX, rearAxleX }}
 * @throws if a named source mesh is not found
 */
function measureTires(scene, wheelSources) {
  const frontTire = findByName(scene, wheelSources.front);
  const rearTire  = findByName(scene, wheelSources.rear);
  if (!frontTire) throw new Error(`[car-loader] wheelSources.front "${wheelSources.front}" not found in scene`);
  if (!rearTire)  throw new Error(`[car-loader] wheelSources.rear "${wheelSources.rear}" not found in scene`);

  scene.updateMatrixWorld?.(true);
  frontTire.updateMatrixWorld?.(true);
  rearTire.updateMatrixWorld?.(true);

  const ftBB = new THREE.Box3().setFromObject(frontTire);
  const rtBB = new THREE.Box3().setFromObject(rearTire);
  const ftC  = ftBB.getCenter(new THREE.Vector3());
  const rtC  = rtBB.getCenter(new THREE.Vector3());

  // Wheel radius = half the tire Y-extent (tire stands upright, Y spans the diameter).
  // Average front/rear tire heights to avoid asymmetric noise.
  const ftH = ftBB.max.y - ftBB.min.y;
  const rtH = rtBB.max.y - rtBB.min.y;
  const wheelRadius = 0.25 * (ftH + rtH);

  return {
    groundContactY: Math.min(ftBB.min.y, rtBB.min.y),
    frontAxleZ:     ftC.z,
    rearAxleZ:      rtC.z,
    frontAxleX:     Math.abs(ftC.x),
    rearAxleX:      Math.abs(rtC.x),
    wheelRadius,
  };
}

/**
 * Measure per-feature anchor points from named GLB meshes in world-space.
 * Each anchor returns { x, y, z, bbox: {minY,maxY,minZ,maxZ} }.
 *   use: 'peak'   → y = bbox.max.y (highest point of the feature)
 *   use: 'center' → y = bbox center.y
 * Runs AFTER scene.rotation/position/scale are applied (same pre-strip phase as measureTires).
 *
 * From the measured bbox of each anchor we also synthesise sidepodTop and floor:
 *   sidepodTop.y = bodyShell top Y minus 20% of shell height
 *   floor.y      = bodyShell bottom Y plus  10% of shell height
 * Only emitted when bodyShell is present.
 */
function measureAnchors(scene, anchorSources) {
  if (!anchorSources) return null;
  scene.updateMatrixWorld?.(true);
  const anchors = {};
  for (const [key, src] of Object.entries(anchorSources)) {
    const node = findByName(scene, src.mesh);
    if (!node) continue;
    node.updateMatrixWorld?.(true);
    const bb = new THREE.Box3().setFromObject(node);
    const c  = bb.getCenter(new THREE.Vector3());
    anchors[key] = {
      x: c.x,
      y: src.use === 'peak' ? bb.max.y : c.y,
      z: c.z,
      bbox: { minY: bb.min.y, maxY: bb.max.y, minZ: bb.min.z, maxZ: bb.max.z },
    };
  }
  const bs = anchors.bodyShell;
  if (bs) {
    const h = bs.bbox.maxY - bs.bbox.minY;
    anchors.sidepodTop = { x: 0, y: bs.bbox.maxY - h * 0.20, z: bs.z };
    anchors.floor      = { x: 0, y: bs.bbox.minY + h * 0.10, z: bs.z };
  }
  return anchors;
}

/* ── Wheel split config ──────────────────────────────────────────────
 * Source mesh names → split mode.
 *   'x'   → 2-way by world-X sign (front_tire / rear_tire / front_cover)
 *   'xz'  → 4-way by (X sign, Z sign) (rim / nut / screws)
 * The 'side' flag on 'x' sources tells us which half of the car the whole
 * mesh lives on ('front' → both fragments land at front axle Z, etc.).
 */
const WHEEL_SPLIT_CONFIG = {
  Object_33: { mode: 'x',  side: 'front' },   // front_tire        — merged L+R fronts
  Object_26: { mode: 'x',  side: 'rear'  },   // rear_tire         — merged L+R rears
  Object_34: { mode: 'x',  side: 'front' },   // front_wheel_cover — merged L+R fronts
  Object_27: { mode: 'xz' },                  // wheel_rim         — all 4 corners
  Object_29: { mode: 'xz' },                  // wheel_nut         — all 4 corners
  Object_24: { mode: 'xz' },                  // wheel_screw.001   — all 4 corners
  Object_25: { mode: 'xz' },                  // wheel_screw       — all 4 corners
};

/**
 * Split merged GLB wheel meshes (front_tire / rear_tire / wheel_rim / wheel_nut /
 * wheel_screws / front_wheel_cover) into 4 per-corner wheel groups FL/FR/RL/RR.
 *
 * Implementation:
 *   1. For each source mesh listed in WHEEL_SPLIT_CONFIG that exists in `scene`,
 *      clone its geometry and apply its world matrix so vertex positions are
 *      in car-local (scene-world) coordinates.
 *   2. Run `sliceGeometryByPredicate` per corner. Predicates use world X sign
 *      for 'x' mode and (X sign, Z sign) for 'xz' mode; 4-way splits use the
 *      midpoint of measured front/rear axle Z as the Z-split plane.
 *   3. Translate each fragment's geometry so its bbox center sits at (0,0,0).
 *      Wrap in a Mesh with the SHARED (un-cloned) source material.
 *   4. Attach the mesh to the corresponding corner Group, which is positioned
 *      at the bbox center in car-local space (= fragment's axle point).
 *   5. Remove the source meshes from the scene so they don't double-render.
 *
 * Returns { wheelsRoot, wheels: { FL, FR, RL, RR }, debug: { counts } }.
 * `debug.counts` maps corner → { <srcName>: { fragmentVertCount, sourceVertCount } }
 * so callers (and tests) can verify no > 5% vertex loss per corner.
 */
export function buildWheelsFromGLB(scene, measure) {
  if (!scene || !measure) return null;

  scene.updateMatrixWorld?.(true);

  // Z-plane between front and rear axles — splits rim/nut/screws into F vs R halves.
  // In car-local post-rotation space: frontAxleZ ≈ -1.47, rearAxleZ ≈ +2.10.
  const zMid = 0.5 * (measure.frontAxleZ + measure.rearAxleZ);
  const wheelY = measure.groundContactY + measure.wheelRadius;

  const wheels = {
    FL: new THREE.Group(),
    FR: new THREE.Group(),
    RL: new THREE.Group(),
    RR: new THREE.Group(),
  };
  wheels.FL.name = 'FL';
  wheels.FR.name = 'FR';
  wheels.RL.name = 'RL';
  wheels.RR.name = 'RR';

  const wheelsRoot = new THREE.Group();
  wheelsRoot.name = 'wheelsRoot';
  wheelsRoot.add(wheels.FL, wheels.FR, wheels.RL, wheels.RR);

  const debug = { counts: { FL: {}, FR: {}, RL: {}, RR: {} } };
  const toRemove = [];

  for (const [srcName, cfg] of Object.entries(WHEEL_SPLIT_CONFIG)) {
    const srcMesh = findByName(scene, srcName);
    if (!srcMesh || !srcMesh.geometry || !srcMesh.geometry.attributes?.position) {
      continue;   // source absent or geometry-less (test stub) — skip quietly
    }
    srcMesh.updateMatrixWorld?.(true);

    // Clone geometry and bake the source's world matrix so split predicates
    // can work in world / car-local coordinates instead of mesh-local ones.
    const worldGeo = srcMesh.geometry.clone();
    if (srcMesh.matrixWorld && worldGeo.applyMatrix4) {
      worldGeo.applyMatrix4(srcMesh.matrixWorld);
    }

    const srcVertCount = worldGeo.attributes.position.count;

    // Build the per-corner predicates this source contributes to.
    const cornerPreds = [];
    if (cfg.mode === 'x') {
      // 2-way: whole mesh is on front or rear. Just split by X sign.
      const z = cfg.side === 'front' ? measure.frontAxleZ : measure.rearAxleZ;
      const xFront = measure.frontAxleX;
      const xRear  = measure.rearAxleX;
      const ax = cfg.side === 'front' ? xFront : xRear;
      if (cfg.side === 'front') {
        cornerPreds.push({ corner: 'FL', axle: { x: -ax, z }, pred: (x) => x < 0 });
        cornerPreds.push({ corner: 'FR', axle: { x:  ax, z }, pred: (x) => x > 0 });
      } else {
        cornerPreds.push({ corner: 'RL', axle: { x: -ax, z }, pred: (x) => x < 0 });
        cornerPreds.push({ corner: 'RR', axle: { x:  ax, z }, pred: (x) => x > 0 });
      }
    } else {
      // 4-way: X sign + Z sign (front = Z < zMid, rear = Z > zMid in car-local).
      // With frontAxleZ ≈ -1.47 and rearAxleZ ≈ +2.10, zMid ≈ +0.315; front halves
      // have Z < zMid and rear halves have Z > zMid.
      cornerPreds.push({
        corner: 'FL',
        axle: { x: -measure.frontAxleX, z: measure.frontAxleZ },
        pred: (x, _y, z) => x < 0 && z < zMid,
      });
      cornerPreds.push({
        corner: 'FR',
        axle: { x:  measure.frontAxleX, z: measure.frontAxleZ },
        pred: (x, _y, z) => x > 0 && z < zMid,
      });
      cornerPreds.push({
        corner: 'RL',
        axle: { x: -measure.rearAxleX, z: measure.rearAxleZ },
        pred: (x, _y, z) => x < 0 && z > zMid,
      });
      cornerPreds.push({
        corner: 'RR',
        axle: { x:  measure.rearAxleX, z: measure.rearAxleZ },
        pred: (x, _y, z) => x > 0 && z > zMid,
      });
    }

    for (const { corner, axle, pred } of cornerPreds) {
      const fragGeo = sliceGeometryByPredicate(worldGeo, pred);
      const fragVertCount = fragGeo.attributes.position?.count ?? 0;
      debug.counts[corner][srcName] = { fragmentVertCount: fragVertCount, sourceVertCount: srcVertCount };
      if (fragVertCount === 0) continue;

      // Translate fragment geometry so its bbox center lies at the corner's
      // axle point — subtracting (axle.x, wheelY, axle.z) in world/car-local.
      // This way the fragment mesh sits at (0,0,0) inside a group whose
      // .position is the axle; rotating the group around X spins the wheel
      // in place around its own axle.
      if (fragGeo.translate) {
        fragGeo.translate(-axle.x, -wheelY, -axle.z);
      }

      const mesh = new THREE.Mesh(fragGeo, srcMesh.material);
      mesh.name = `${srcName}_${corner}`;
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      wheels[corner].add(mesh);
    }

    // Position the corner groups — shared across all 4 sources; last write wins
    // but they all map the same corner → same axle, so no conflict.
    wheels.FL.position.set(-measure.frontAxleX, wheelY, measure.frontAxleZ);
    wheels.FR.position.set( measure.frontAxleX, wheelY, measure.frontAxleZ);
    wheels.RL.position.set(-measure.rearAxleX,  wheelY, measure.rearAxleZ);
    wheels.RR.position.set( measure.rearAxleX,  wheelY, measure.rearAxleZ);

    toRemove.push(srcMesh);
  }

  // Strip the originals from the scene so they don't double-render alongside
  // the new per-corner fragments. Skip gracefully when parent.remove is absent
  // (some test stubs don't implement it).
  for (const m of toRemove) {
    m.parent?.remove?.(m);
  }

  return { wheelsRoot, wheels, debug };
}

/**
 * Manifest-aware GLB loader.
 * @param {object} manifest  — entry from CAR_MANIFEST (not a type string).
 * @returns {{ scene, liveryMeshes, glbMeasure, wheelsRoot } | null}
 *   glbMeasure is null when manifest.wheelSources is not set.
 *   wheelsRoot is null when no merged-wheel meshes are present (procedural path).
 */
export async function loadCarFromManifest(manifest) {
  const loaded = await loadCarModel(manifest.url);
  if (!loaded) return null;

  const { scene } = loaded;
  const { transform, stripMeshes, liveryMeshes: livSubs, wheelSources } = manifest;

  scene.scale.setScalar(transform.scale);
  scene.rotation.set(...transform.rotation);
  scene.position.set(...transform.position);

  // Measure BEFORE stripping — wheel source meshes must still be in the scene graph.
  const glbMeasure = wheelSources ? measureTires(scene, wheelSources) : null;
  const anchors    = measureAnchors(scene, manifest.anchorSources);
  if (glbMeasure && anchors) glbMeasure.anchors = anchors;

  // Split the merged GLB wheel meshes into 4 per-corner groups BEFORE the
  // strip pass runs — buildWheelsFromGLB removes the originals from the
  // scene itself, so the remaining strip list only handles orphans like
  // Object_28 (rear-wheel cape) that aren't wheels at all.
  let wheelsRoot = null;
  if (glbMeasure && manifest.buildWheels !== false) {
    const built = buildWheelsFromGLB(scene, glbMeasure);
    wheelsRoot = built?.wheelsRoot ?? null;
    if (built) glbMeasure.wheelDebug = built.debug;
  }

  const toStrip      = [];
  const liveryMeshes = [];

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const name = child.name || '';
    if (stripMeshes.includes(name)) toStrip.push(child);
    if (livSubs.includes(name))     liveryMeshes.push(child);
  });

  toStrip.forEach(m => m.parent?.remove(m));

  return { scene, liveryMeshes, glbMeasure, wheelsRoot };
}
