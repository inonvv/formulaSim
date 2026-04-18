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

/**
 * Manifest-aware GLB loader.
 * @param {object} manifest  — entry from CAR_MANIFEST (not a type string).
 * @returns {{ scene, liveryMeshes, rearWing } | null}
 */
export async function loadCarFromManifest(manifest) {
  const loaded = await loadCarModel(manifest.url);
  if (!loaded) return null;

  const { scene } = loaded;
  const { transform, stripMeshes, liveryMeshes: livSubs, rearWing: rwSub } = manifest;

  scene.scale.setScalar(transform.scale);
  scene.rotation.set(...transform.rotation);
  scene.position.set(...transform.position);

  const toStrip      = [];
  const liveryMeshes = [];
  let rearWing       = null;

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const name = child.name || '';
    if (stripMeshes.includes(name))                        toStrip.push(child);
    if (livSubs.includes(name))                            liveryMeshes.push(child);
    if (rwSub && name === rwSub && rearWing === null)      rearWing = child;
  });

  toStrip.forEach(m => m.parent?.remove(m));

  return { scene, liveryMeshes, rearWing };
}
