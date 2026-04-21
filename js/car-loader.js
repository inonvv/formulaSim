import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

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

/**
 * Manifest-aware GLB loader.
 * @param {object} manifest  — entry from CAR_MANIFEST (not a type string).
 * @returns {{ scene, liveryMeshes, glbMeasure } | null}
 *   glbMeasure is null when manifest.wheelSources is not set.
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

  const toStrip      = [];
  const liveryMeshes = [];

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const name = child.name || '';
    if (stripMeshes.includes(name)) toStrip.push(child);
    if (livSubs.includes(name))     liveryMeshes.push(child);
  });

  toStrip.forEach(m => m.parent?.remove(m));

  return { scene, liveryMeshes, glbMeasure };
}
