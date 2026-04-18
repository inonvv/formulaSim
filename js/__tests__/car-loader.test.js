import { describe, it, expect, vi, beforeEach } from 'vitest';

/* ── Fake scene graph used by the mocked GLTFLoader ─────────────── */
function makeNode(name, isMesh = true) {
  return {
    name,
    isMesh,
    castShadow: false,
    receiveShadow: false,
    children: [],
    traverse(fn) {
      fn(this);
      this.children.forEach(c => c.traverse(fn));
    },
  };
}

function makeFakeGltf(children = []) {
  const scene = makeNode('Scene', false);
  scene.children = children;
  scene.traverse = function (fn) {
    fn(this);
    this.children.forEach(c => c.traverse(fn));
  };
  return { scene };
}

/* ── Mock three/addons GLTFLoader + DRACOLoader ──────────────────── */
let _resolveWith = null;   // set per test
let _shouldReject = false;

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setDRACOLoader() {}
    async loadAsync(url) {
      if (_shouldReject) throw new Error('fetch failed');
      return _resolveWith;
    }
  },
}));

vi.mock('three/addons/loaders/DRACOLoader.js', () => ({
  DRACOLoader: class {
    setDecoderPath() {}
  },
}));

beforeEach(() => {
  _resolveWith = null;
  _shouldReject = false;
});

/* ── Tests ────────────────────────────────────────────────────────── */
describe('loadCarModel', () => {
  it('1. resolves with { scene, wheels, liveryMeshes } shape on success', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    _resolveWith = makeFakeGltf();
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('scene');
    expect(result).toHaveProperty('wheels');
    expect(result).toHaveProperty('liveryMeshes');
    expect(Array.isArray(result.wheels)).toBe(true);
    expect(Array.isArray(result.liveryMeshes)).toBe(true);
  });

  it('2. resolves with null (not rejects) when URL is missing / fetch fails', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    _shouldReject = true;
    await expect(loadCarModel('/models/cars/missing.glb')).resolves.toBeNull();
  });

  it('3. extracts meshes named wheel_* into wheels[]', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    const wFL = makeNode('wheel_FL');
    const wFR = makeNode('wheel_FR');
    const body = makeNode('body_primary');
    _resolveWith = makeFakeGltf([wFL, wFR, body]);
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(result.wheels).toHaveLength(2);
    expect(result.wheels.every(m => m.name.startsWith('wheel_'))).toBe(true);
  });

  it('4. extracts meshes named livery_* into liveryMeshes[]', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    const livP = makeNode('livery_primary');
    const livS = makeNode('livery_secondary');
    const body = makeNode('body_carbon');
    _resolveWith = makeFakeGltf([livP, livS, body]);
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(result.liveryMeshes).toHaveLength(2);
    expect(result.liveryMeshes.every(m => m.name.startsWith('livery_'))).toBe(true);
  });

  it('5. sets castShadow = true on all meshes in the imported scene', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    const m1 = makeNode('body_primary');
    const m2 = makeNode('wheel_FL');
    _resolveWith = makeFakeGltf([m1, m2]);
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(m1.castShadow).toBe(true);
    expect(m2.castShadow).toBe(true);
  });

  it('6. sets receiveShadow = true on all meshes in the imported scene', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    const m1 = makeNode('body_primary');
    _resolveWith = makeFakeGltf([m1]);
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(m1.receiveShadow).toBe(true);
  });

  it('7. non-mesh nodes (isMesh = false) are NOT added to wheels or liveryMeshes', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    const grp = makeNode('wheel_group', false);   // isMesh = false
    _resolveWith = makeFakeGltf([grp]);
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(result.wheels).toHaveLength(0);
  });

  it('8. wheels[] is empty when no wheel_* meshes exist', async () => {
    const { loadCarModel } = await import('../car-loader.js');
    _resolveWith = makeFakeGltf([makeNode('body_primary')]);
    const result = await loadCarModel('/models/cars/f1.glb');
    expect(result.wheels).toHaveLength(0);
  });
});

/* ── Phase 2: loadCarFromManifest ────────────────────────────────── */

// Scene node with THREE-compatible position/scale/rotation stubs
function makeSceneNode(children = []) {
  const s = {
    name: 'Scene', isMesh: false, children,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    scale:    { x: 1,            setScalar(v)   { this.x = v; } },
    rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    remove(child) { this.children = this.children.filter(c => c !== child); },
    traverse(fn) {
      fn(this);
      this.children.forEach(c => c.traverse ? c.traverse(fn) : fn(c));
    },
  };
  children.forEach(c => { c.parent = s; });
  return s;
}

// Fake manifest — exact node names matching the test mesh names used below
const FAKE_MANIFEST = {
  url: '/models/cars/f1.glb',
  transform: { scale: 2.0, rotation: [0.1, 0, 0], position: [1, 2, 3] },
  stripMeshes:  ['wheel_fl'],
  liveryMeshes: ['body_primary'],
  rearWing:     'wing_rear_main',
};

describe('loadCarFromManifest', () => {
  it('LM1. resolves { scene, liveryMeshes, rearWing } on success', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const scene = makeSceneNode([makeNode('body_primary'), makeNode('wing_rear_main')]);
    _resolveWith = { scene };
    const result = await loadCarFromManifest(FAKE_MANIFEST);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('scene');
    expect(result).toHaveProperty('liveryMeshes');
    expect(result).toHaveProperty('rearWing');
  });

  it('LM2. liveryMeshes contains the body mesh', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const b = makeNode('body_primary');
    const scene = makeSceneNode([b]);
    _resolveWith = { scene };
    const result = await loadCarFromManifest(FAKE_MANIFEST);
    expect(result.liveryMeshes).toHaveLength(1);
    expect(result.liveryMeshes[0].name).toBe('body_primary');
  });

  it('LM3. rearWing resolves to the wing_rear mesh', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const rw = makeNode('wing_rear_main');
    const scene = makeSceneNode([rw]);
    _resolveWith = { scene };
    const result = await loadCarFromManifest(FAKE_MANIFEST);
    expect(result.rearWing).toBe(rw);
  });

  it('LM4. wheel meshes are removed from scene children', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const w = makeNode('wheel_fl');
    const scene = makeSceneNode([w]);
    _resolveWith = { scene };
    await loadCarFromManifest(FAKE_MANIFEST);
    expect(scene.children).not.toContain(w);
  });

  it('LM5. transform applied — scale and position', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const scene = makeSceneNode([]);
    _resolveWith = { scene };
    await loadCarFromManifest(FAKE_MANIFEST);
    expect(scene.scale.x).toBe(2.0);
    expect(scene.position.x).toBe(1);
    expect(scene.position.y).toBe(2);
    expect(scene.position.z).toBe(3);
  });

  it('LM6. null manifest.rearWing → result.rearWing is null', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const scene = makeSceneNode([makeNode('wing_rear_main')]);
    _resolveWith = { scene };
    const result = await loadCarFromManifest({ ...FAKE_MANIFEST, rearWing: null });
    expect(result.rearWing).toBeNull();
  });

  it('LM7. returns null when loader rejects (GLB missing)', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    _shouldReject = true;
    await expect(loadCarFromManifest(FAKE_MANIFEST)).resolves.toBeNull();
  });

  it('LM8. exact strip — mesh_a_extra is NOT removed when stripMeshes = ["mesh_a"]', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const correct    = makeNode('mesh_a');
    const notStripped = makeNode('mesh_a_extra');
    const scene = makeSceneNode([correct, notStripped]);
    _resolveWith = { scene };
    const manifest = { ...FAKE_MANIFEST, stripMeshes: ['mesh_a'], liveryMeshes: [], rearWing: null };
    await loadCarFromManifest(manifest);
    expect(scene.children).not.toContain(correct);     // 'mesh_a' is stripped
    expect(scene.children).toContain(notStripped);     // 'mesh_a_extra' is NOT stripped
  });

  it('LM9. empty stripMeshes — nothing is removed', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const m = makeNode('any_mesh');
    const scene = makeSceneNode([m]);
    _resolveWith = { scene };
    const manifest = { ...FAKE_MANIFEST, stripMeshes: [], liveryMeshes: [], rearWing: null };
    await loadCarFromManifest(manifest);
    expect(scene.children).toContain(m);
  });

  it('LM10. rearWing exact match — longer name "wing_exact_long" does not satisfy pattern "wing_exact"', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const wrongMatch = makeNode('wing_exact_long');  // comes first — old substring code would grab it
    const rightMatch = makeNode('wing_exact');
    const scene = makeSceneNode([wrongMatch, rightMatch]);
    _resolveWith = { scene };
    const manifest = { ...FAKE_MANIFEST, stripMeshes: [], liveryMeshes: [], rearWing: 'wing_exact' };
    const result = await loadCarFromManifest(manifest);
    expect(result.rearWing).toBe(rightMatch);
  });
});
