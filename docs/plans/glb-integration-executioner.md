# GLB Integration Executioner Plan
## Hybrid Cars: Imported GLB Bodies + Procedural Wheels / Wings / Brakes

> **Working-session instruction document.** Execute one phase at a time. Stop at each phase boundary and report before continuing. Do not commit unless the user explicitly asks.

---

## Context snapshot (verified against live code, 2026-04-18)

| Fact | Value |
|---|---|
| Test count | **148 passing** (8 files: airflow-core 32, physics 30, scene-clarity 17, cars 27, car-loader 8, cfd-effect 15, effects 13, + others) |
| `js/cars.js:20` | `export const USE_IMPORTED_MODELS = false` |
| `js/cars.js:359` | `export function buildCar(type)` — **synchronous** |
| `js/car-loader.js` | `export async function loadCarModel(url)` — null-on-fail, exists |
| `js/main.js:14` | `import { buildCar, getCarMeta, WHEEL_NAMES }` |
| `js/main.js:151` | `const grp = buildCar(type)` — sync call in `spawnCar()` |
| Assets | `assets/models/f1.glb`, `assets/models/gt.glb`, `assets/models/ATTRIBUTION.md` |
| Draco | `public/draco/` — decoder files present, matches `DRACOLoader.setDecoderPath('/draco/')` |

**Named sub-objects `main.js` traverses — must survive every phase:**

| Name | Purpose |
|---|---|
| `wFL` `wFR` `wRL` `wRR` | Wheel spin + brake glow wiring |
| `brake_*` | Brake disc heat emissive |
| `brake_cal_*` | Caliper emissive |
| `rearWing` | Wing-flip pivot group |
| `rearWingFlap` | DRS flap rotation |

**Wheel constants (hardcode in tests and hybrid builders):**

| Car | `wR` | `wW` | `wheelLocalY` | `wPos.wFL` | `grp.position.y` |
|---|---|---|---|---|---|
| F1 | 0.345 | 0.340 | −0.04 | [−0.82, −0.04, −1.50] | 0.045 |
| GT | 0.338 | 0.260 | −0.05 | [−0.86, −0.05, −1.38] | 0.048 |

---

## Hard constraints

1. **TDD** — write failing tests first for every logic change, confirm they fail, then implement.
2. **No regressions** — all 148 existing tests pass at end of every phase.
3. **Procedural builders kept** — rename to `*Procedural`, never delete. Fallback always works.
4. **Null-on-fail** — if any GLB is absent or broken, `loadCarModel` returns `null`, the hybrid builder calls the procedural fallback, and the app renders normally.
5. **F2 + F3 untouched** — builder bodies are not modified in any phase.
6. **No commits** unless the user explicitly asks.
7. **No changes** to `scene-config.js`, `effects.js`, `cfd-effect.js`, `physics.js`, `airflow-core.js`, `track.js`.

---

## Phase 1 — Manifest module

**Goal**: `js/car-manifest.js` — single source of truth for each car's GLB URL, mesh-role substring lists, and scene-root transform. No Three.js dependency; pure data.

### 1.1 Write failing tests first

Create `js/__tests__/car-manifest.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { CAR_MANIFEST, getManifest } from '../car-manifest.js';

describe('CAR_MANIFEST', () => {
  it('has entries for f1 and gt', () => {
    expect(CAR_MANIFEST).toHaveProperty('f1');
    expect(CAR_MANIFEST).toHaveProperty('gt');
  });

  it('each entry has url string ending in .glb', () => {
    for (const m of Object.values(CAR_MANIFEST)) {
      expect(typeof m.url).toBe('string');
      expect(m.url).toMatch(/\.glb$/);
    }
  });

  it('transform has scale (number), rotation (length-3 array), position (length-3 array)', () => {
    for (const m of Object.values(CAR_MANIFEST)) {
      expect(typeof m.transform.scale).toBe('number');
      expect(m.transform.rotation).toHaveLength(3);
      expect(m.transform.position).toHaveLength(3);
    }
  });

  it('stripMeshes and liveryMeshes are non-empty lowercase-string arrays', () => {
    for (const m of Object.values(CAR_MANIFEST)) {
      expect(m.stripMeshes.length).toBeGreaterThan(0);
      expect(m.liveryMeshes.length).toBeGreaterThan(0);
      m.stripMeshes.forEach(s => expect(s).toBe(s.toLowerCase()));
      m.liveryMeshes.forEach(s => expect(s).toBe(s.toLowerCase()));
    }
  });

  it('f1.rearWing is a non-empty string', () => {
    expect(typeof CAR_MANIFEST.f1.rearWing).toBe('string');
    expect(CAR_MANIFEST.f1.rearWing.length).toBeGreaterThan(0);
  });

  it('gt.rearWing is null (GT wing is body-integral, no flip)', () => {
    expect(CAR_MANIFEST.gt.rearWing).toBeNull();
  });

  it('getManifest("f1") returns CAR_MANIFEST.f1', () => {
    expect(getManifest('f1')).toBe(CAR_MANIFEST.f1);
  });

  it('getManifest("UNKNOWN") returns null', () => {
    expect(getManifest('UNKNOWN')).toBeNull();
  });
});
```

Run `npm test`. **8 tests must fail** (module missing). Confirm, then implement.

### 1.2 Implement `js/car-manifest.js`

```js
/**
 * car-manifest.js — Per-car GLB asset descriptors.
 *
 * url: resolved at module import time via import.meta.url so Vite's asset
 *   pipeline can hash and serve the file. The GLBs live in assets/models/.
 *
 * transform: applied to the imported scene root.
 *   Initial values are starting points — tune in Phase 4/5 alignment passes.
 *   F1 source bbox (post-compress): ~5.5 m long × 2.1 m wide — matches scene scale.
 *   GT source bbox: ~4.6 m long × 2.0 m wide.
 *
 * stripMeshes: lowercase substrings. Any mesh whose name contains one of these
 *   is removed from the imported scene (we supply procedural wheels instead).
 *
 * liveryMeshes: lowercase substrings. Any mesh whose name contains one of these
 *   gets its material cloned and tinted to the user-selected color.
 *
 * rearWing: lowercase substring to find the rear-wing mesh/group for wing-flip.
 *   null = no wing-flip for this car.
 */

export const CAR_MANIFEST = {
  f1: {
    url: new URL('../assets/models/f1.glb', import.meta.url).href,
    transform: { scale: 1.0, rotation: [0, 0, 0], position: [0, 0, 0] },
    stripMeshes:  ['wheel', 'tire', 'tyre', 'rim', 'brake_disc', 'caliper'],
    liveryMeshes: ['body', 'paint', 'chassis', 'shell', 'livery'],
    rearWing:     'wing',   // tightened in Phase 4 alignment — may need e.g. 'wing_rear'
  },
  gt: {
    url: new URL('../assets/models/gt.glb', import.meta.url).href,
    transform: { scale: 1.0, rotation: [0, 0, 0], position: [0, 0, 0] },
    stripMeshes:  ['wheel', 'tire', 'tyre', 'rim', 'brake_disc', 'caliper'],
    liveryMeshes: ['body', 'paint', 'hood', 'door', 'fender', 'livery'],
    rearWing:     null,
  },
};

export function getManifest(type) {
  return CAR_MANIFEST[type] ?? null;
}
```

### 1.3 Verify

`npm test` → **156 passing** (148 + 8). All existing tests still green.

---

## Phase 2 — Loader extension

**Goal**: add `loadCarFromManifest(manifest)` to `js/car-loader.js`. Takes a manifest object, loads the GLB via the existing `loadCarModel`, applies the scene transform, strips GLB wheels, collects livery meshes, and finds the rear-wing node.

### 2.1 Write failing tests first

**Extend** `js/__tests__/car-loader.test.js`. The `makeNode` / `makeFakeGltf` helpers and the `GLTFLoader` mock are already in that file — do not duplicate them. Add at the end:

```js
// ── Phase 2: loadCarFromManifest ──────────────────────────────────

// Minimal manifest stub (all lowercase substrings)
const FAKE_MANIFEST = {
  url: '/models/cars/f1.glb',
  transform: { scale: 2.0, rotation: [0.1, 0, 0], position: [1, 2, 3] },
  stripMeshes:  ['wheel'],
  liveryMeshes: ['body'],
  rearWing:     'wing_rear',
};

// Re-use the file-level makeNode / makeFakeGltf helpers.
// Also need the scene to carry a THREE-like position/scale/rotation — extend makeNode:
function makeSceneNode(children = []) {
  const s = {
    name: 'Scene', isMesh: false, children,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x=x; this.y=y; this.z=z; } },
    scale:    { x: 1, setScalar(v) { this.x = v; } },
    rotation: { x: 0, y: 0, z: 0, set(x, y, z) { this.x=x; this.y=y; this.z=z; } },
    traverse(fn) { fn(this); this.children.forEach(c => c.traverse ? c.traverse(fn) : fn(c)); },
  };
  children.forEach(c => { c.parent = s; });
  return s;
}

describe('loadCarFromManifest', () => {
  beforeEach(() => { _shouldReject = false; });

  it('LM1. returns { scene, liveryMeshes, rearWing } on success', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const w  = makeNode('wheel_fl');
    const b  = makeNode('body_primary');
    const rw = makeNode('wing_rear_main');
    const scene = makeSceneNode([w, b, rw]);
    w.parent = b.parent = rw.parent = scene;
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
    b.parent = scene;
    _resolveWith = { scene };
    const result = await loadCarFromManifest(FAKE_MANIFEST);
    expect(result.liveryMeshes).toHaveLength(1);
    expect(result.liveryMeshes[0].name).toBe('body_primary');
  });

  it('LM3. rearWing resolves to the wing_rear mesh', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const rw = makeNode('wing_rear_main');
    const scene = makeSceneNode([rw]);
    rw.parent = scene;
    _resolveWith = { scene };
    const result = await loadCarFromManifest(FAKE_MANIFEST);
    expect(result.rearWing).toBe(rw);
  });

  it('LM4. wheel meshes are removed from scene (parent.remove called)', async () => {
    const { loadCarFromManifest } = await import('../car-loader.js');
    const w = makeNode('wheel_fl');
    let removed = false;
    const scene = makeSceneNode([w]);
    scene.remove = (m) => { removed = true; };
    w.parent = scene;
    _resolveWith = { scene };
    await loadCarFromManifest(FAKE_MANIFEST);
    expect(removed).toBe(true);
  });

  it('LM5. transform is applied — scale and position', async () => {
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
});
```

Run `npm test`. **7 new tests must fail**. Confirm, then implement.

### 2.2 Implement in `js/car-loader.js`

Add this export after `loadCarModel`. The `import { getManifest }` is NOT needed here — the caller passes the manifest object directly.

```js
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

  // Apply scene-root transform
  scene.scale.setScalar(transform.scale);
  scene.rotation.set(...transform.rotation);
  scene.position.set(...transform.position);

  const toStrip    = [];
  const liveryMeshes = [];
  let rearWing     = null;

  const lcStrip  = stripMeshes.map(s => s.toLowerCase());
  const lcLivery = livSubs.map(s => s.toLowerCase());
  const lcRW     = rwSub ? rwSub.toLowerCase() : null;

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const name = (child.name || '').toLowerCase();
    if (lcStrip.some(p => name.includes(p)))                toStrip.push(child);
    if (lcLivery.some(p => name.includes(p)))               liveryMeshes.push(child);
    if (lcRW && rearWing === null && name.includes(lcRW))   rearWing = child;
  });

  toStrip.forEach(m => m.parent?.remove(m));

  return { scene, liveryMeshes, rearWing };
}
```

**Note**: `scene.rotation.set` requires that the Three.js `Euler` in the test mock already has a `set` method — it does (confirmed in `cars.test.js` mock). `scene.scale.setScalar` requires `setScalar` — also present. Both are already in the mock.

### 2.3 Verify

`npm test` → **163 passing** (156 + 7).

---

## Phase 3 — Async `buildCar` refactor ⚠️

**This is the riskiest phase. It changes the public API surface (`buildCar` becomes async) and requires coordinated changes in `cars.js`, `main.js`, and the test file. Take it slowly. Run `npm test` after each sub-step.**

### 3.1 Write failing tests first

Append to `js/__tests__/cars.test.js`:

```js
describe('buildCar is async (Phase 3)', () => {
  it('buildCar("F1") returns a Promise', async () => {
    const { buildCar } = await import('../cars.js');
    const result = buildCar('F1');
    expect(result).toBeInstanceOf(Promise);
    const grp = await result;
    expect(grp.name).toBe('car');
  });

  it('await buildCar("F2") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F2')).name).toBe('car');
  });

  it('await buildCar("F3") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('F3')).name).toBe('car');
  });

  it('await buildCar("GT") resolves to group named "car"', async () => {
    const { buildCar } = await import('../cars.js');
    expect((await buildCar('GT')).name).toBe('car');
  });
});
```

Run `npm test`. **4 tests must fail** (sync function does not return a Promise). Confirm.

### 3.2 Rename private builders in `js/cars.js`

Change **only the function declaration lines** (not anything inside the bodies):

| Old declaration | New declaration |
|---|---|
| `function buildF1({ color })` | `function buildF1Procedural({ color })` |
| `function buildF2({ color })` | `function buildF2Procedural({ color })` |
| `function buildF3({ color })` | `function buildF3Procedural({ color })` |
| `function buildGT({ color })` | `function buildGTProcedural({ color })` |

Add stub hybrid functions immediately after the procedural functions (real implementations in Phases 4-5):

```js
// Phase 4 fills this in:
async function buildF1Hybrid(meta) { return buildF1Procedural(meta); }

// Phase 5 fills this in:
async function buildGTHybrid(meta) { return buildGTProcedural(meta); }
```

### 3.3 Make dispatcher async in `js/cars.js`

Replace `buildCar` (currently lines 359–367):

```js
export async function buildCar(type) {
  const meta = CAR_META[type] || CAR_META.F1;
  const flag = USE_IMPORTED_MODELS;
  switch (type) {
    case 'F2': return buildF2Procedural(meta);
    case 'F3': return buildF3Procedural(meta);
    case 'GT':
      return (flag === true || flag?.GT === true)
        ? buildGTHybrid(meta)
        : buildGTProcedural(meta);
    default:
      return (flag === true || flag?.F1 === true)
        ? buildF1Hybrid(meta)
        : buildF1Procedural(meta);
  }
}
```

### 3.4 Update `USE_IMPORTED_MODELS` to support per-car flags

Change line 20 of `js/cars.js`:

```js
// Before:
export const USE_IMPORTED_MODELS = false;

// After:
export const USE_IMPORTED_MODELS = { F1: false, F2: false, F3: false, GT: false };
```

The dispatcher's `flag?.F1 === true` check handles both the old boolean shape and the new object shape safely.

### 3.5 Update existing `buildCar` tests in `js/__tests__/cars.test.js`

Every `buildCar(...)` call in the test file must become `await buildCar(...)`. Affected tests:
- `describe('buildCar', ...)` — 5 tests — add `await` to the `buildCar(type)` calls
- `describe('Sharp sidepod geometry', ...)` — uses `buildCar('F1')` — add `await`
- `describe('rearWing named group', ...)` — 5 tests — add `await` to each builder call
- `describe('wheel ground contact', ...)` — 4 tests — add `await`

**Rule**: after this step, search `js/__tests__/cars.test.js` for `buildCar(` — every occurrence must be preceded by `await`.

### 3.6 Update `main.js`

Find `spawnCar` and make it async. Then await all call sites.

```js
// main.js — spawnCar becomes async
async function spawnCar(type) {
  if (state.carGroup) {
    scene.remove(state.carGroup);
  }
  const grp = await buildCar(type);    // ← only change
  state.carGroup = grp;
  // ... rest of spawnCar body unchanged ...
}
```

Find every call to `spawnCar` in `main.js`. There are typically two:
1. **Initial spawn** at scene bootstrap — add `await` and ensure the surrounding context is async (wrap in `async function init() { ... }` called as `init()` if it isn't already).
2. **UI car-select handler** — make the callback `async () => { await spawnCar(type); }`.

### 3.7 Verify

`npm test` → **167 passing** (163 + 4 new async tests).

Hard-refresh browser. All four cars must render identically to pre-Phase-3. This is a pure refactor — no visual change. If any car is missing, check the browser console for an uncaught Promise.

---

## Phase 4 — F1 hybrid builder

**Goal**: replace the stub `buildF1Hybrid` with a real implementation that loads `assets/models/f1.glb`, attaches procedural wheels, clones-and-tints livery meshes, wraps the rear-wing node for wing-flip, and grounds the car at `position.y = 0.045`.

### 4.1 Write failing tests first

Add imports at the top of `js/__tests__/cars.test.js`:

```js
// Add with the other vi.mock calls at the top:
let _loaderManifestResult = null;
vi.mock('../car-loader.js', () => ({
  loadCarModel: async () => null,
  loadCarFromManifest: async () => _loaderManifestResult,
}));
```

Append the test block:

```js
describe('buildF1Hybrid (Phase 4)', () => {
  beforeEach(() => { _loaderManifestResult = null; });

  function fakeMesh(name) {
    return {
      name, isMesh: true, castShadow: false, receiveShadow: false,
      material: { clone() { return { ...this }; }, color: { copy() {} } },
      parent: null, children: [],
      traverse(fn) { fn(this); },
    };
  }
  function fakeScene(children = []) {
    const s = {
      name: 'root', isMesh: false, children,
      position: { set() {} }, scale: { setScalar() {} }, rotation: { set() {} },
      traverse(fn) { fn(this); children.forEach(c => c.traverse ? c.traverse(fn) : fn(c)); },
    };
    children.forEach(c => { c.parent = s; });
    return s;
  }

  it('H1. null loader → fallback; group has wFL and rearWing', async () => {
    _loaderManifestResult = null;
    // Temporarily set flag — import is cached; manipulate via a helper export or re-import
    // Pattern: set USE_IMPORTED_MODELS.F1 = true before test, restore after.
    // Since it's a const, mock the module instead:
    const { buildCar } = await import('../cars.js');
    // Flag is { F1: false } by default in test env → goes procedural anyway
    const grp = await buildCar('F1');
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    expect(names.has('wFL')).toBe(true);
    expect(names.has('rearWing')).toBe(true);
  });

  it('H2. procedural fallback is grounded (carY + wFL.y - 0.345 ≈ -0.34)', async () => {
    _loaderManifestResult = null;
    const { buildCar } = await import('../cars.js');
    const grp = await buildCar('F1');
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.position.y + wFL.position.y - 0.345).toBeCloseTo(-0.34, 3);
  });

  it('H3. GLB path — imported scene is added to group', async () => {
    const scene = fakeScene([]);
    _loaderManifestResult = { scene, liveryMeshes: [], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    let found = false;
    grp.traverse(o => { if (o === scene) found = true; });
    expect(found).toBe(true);
  });

  it('H4. GLB path — 4 procedural wheels present', async () => {
    const scene = fakeScene([]);
    _loaderManifestResult = { scene, liveryMeshes: [], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(true));
  });

  it('H5. GLB path — grp.position.y = 0.045', async () => {
    const scene = fakeScene([]);
    _loaderManifestResult = { scene, liveryMeshes: [], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    const grp = await buildF1Hybrid({ color: 0xe8132a });
    expect(grp.position.y).toBeCloseTo(0.045, 3);
  });

  it('H6. livery mesh material is cloned and color set', async () => {
    const livMesh = fakeMesh('body_shell');
    const originalMat = livMesh.material;
    const cloned = { ...originalMat, _isClone: true };
    originalMat.clone = () => cloned;
    let colorSet = false;
    cloned.color = { copy: () => { colorSet = true; } };
    _loaderManifestResult = { scene: fakeScene([livMesh]), liveryMeshes: [livMesh], rearWing: null };
    const { buildF1Hybrid } = await import('../cars.js');
    await buildF1Hybrid({ color: 0xe8132a });
    expect(livMesh.material).toBe(cloned);
    expect(colorSet).toBe(true);
  });
});
```

Run `npm test`. **6 tests must fail** (`buildF1Hybrid` is a stub). Confirm.

### 4.2 Add imports to `js/cars.js`

At the top of the file (after the existing THREE import):

```js
import { CAR_MANIFEST } from './car-manifest.js';
import { loadCarFromManifest } from './car-loader.js';
```

### 4.3 Add `applyLivery` helper in `js/cars.js`

Add near the other material helpers (around line 22):

```js
function applyLivery(meshes, color) {
  const c = new THREE.Color(color);
  meshes.forEach(m => {
    if (!m.material) return;
    m.material = m.material.clone();
    if (m.material.color) m.material.color.copy(c);
  });
}
```

### 4.4 Implement `buildF1Hybrid` in `js/cars.js`

Replace the Phase-3 stub:

```js
async function buildF1Hybrid({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const loaded = await loadCarFromManifest(CAR_MANIFEST.f1);
  if (!loaded) {
    console.warn('[buildF1Hybrid] GLB load failed — using procedural F1');
    return buildF1Procedural({ color });
  }

  grp.add(loaded.scene);
  applyLivery(loaded.liveryMeshes, color);

  // Wrap GLB rear-wing node so main.js can find it by name 'rearWing'
  if (loaded.rearWing) {
    const parent = loaded.rearWing.parent;
    if (parent) {
      const wingGrp = new THREE.Group();
      wingGrp.name = 'rearWing';
      parent.remove(loaded.rearWing);
      wingGrp.add(loaded.rearWing);
      parent.add(wingGrp);
    } else {
      loaded.rearWing.name = 'rearWing';
    }
  }

  // Procedural wheels — same positions + names as buildF1Procedural
  const matTyre = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub  = makeMat(0xe0e0e0, 0.08, 1.00);
  const wR = 0.345, wW = 0.340;
  const wPos = {
    wFL: [-0.82, -0.04, -1.50],
    wFR: [ 0.82, -0.04, -1.50],
    wRL: [-0.80, -0.04,  1.60],
    wRR: [ 0.80, -0.04,  1.60],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n;
    w.position.set(x, y, z);
    grp.add(w);
  });

  grp.position.y = -0.34 + wR - (-0.04);   // 0.045
  return grp;
}
```

### 4.5 Verify tests green

`npm test` → **173 passing** (167 + 6).

### 4.6 Browser alignment tuning pass

**Temporarily** set `USE_IMPORTED_MODELS = { F1: true, GT: false, F2: false, F3: false }` in `cars.js`.

Add temporary debug logging in `buildF1Hybrid` (delete after tuning):
```js
const bbox = new THREE.Box3().setFromObject(loaded.scene);
console.log('[F1 bbox]', bbox.min, bbox.max);
loaded.scene.traverse(m => {
  if (m.isMesh) console.log('  mesh:', m.name, '| mat:', m.material?.name);
});
```

`npm run start`, open browser console, iterate on `CAR_MANIFEST.f1`:

| Symptom | Fix |
|---|---|
| Car nose points backward | `transform.rotation = [0, Math.PI, 0]` |
| Car too large or too small | Adjust `transform.scale` (start 1.0) |
| Body floats above wheels | Decrease `transform.position[1]` |
| Body sinks through track | Increase `transform.position[1]` |
| Livery doesn't recolor | Update `liveryMeshes` to actual mesh-name substrings from console |
| Wrong mesh rotates on wing-flip | Tighten `rearWing` substring to match specific node name |

After tuning: **delete logging**, commit the final `CAR_MANIFEST.f1.transform` values, revert `USE_IMPORTED_MODELS.F1` to `false`.

### 4.7 Acceptance gate (manual browser, flag temporarily true)

- [ ] F1 renders imported body (sculpted sidepods / engine cover visible).
- [ ] Procedural wheels sit inside wheel arches, spin at speed.
- [ ] Livery color picker recolors body paint.
- [ ] Wing-flip animates a rear element.
- [ ] Rename `assets/models/f1.glb` → `f1.glb.bak` → hard refresh → procedural F1 renders. Rename back.
- [ ] All effects (airflow, rain, CFD, optimal) still functional.
- Screenshot: `images/f1-hybrid-idle.png`.

---

## Phase 5 — GT hybrid builder

**Mirror Phase 4 for the GT car. GT has no wing-flip requirement.**

### 5.1 Write failing tests first

Same pattern as Phase 4. Append to `js/__tests__/cars.test.js`:

```js
describe('buildGTHybrid (Phase 5)', () => {
  beforeEach(() => { _loaderManifestResult = null; });

  it('G1. null loader → procedural GT; wFL present and grounded', async () => {
    _loaderManifestResult = null;
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff8800 });
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
    expect(grp.position.y + wFL.position.y - 0.338).toBeCloseTo(-0.34, 3);
  });

  it('G2. GLB path — 4 procedural wheels present', async () => {
    const scene = { name: 'gt-root', isMesh: false, children: [],
                    position: { set() {} }, scale: { setScalar() {} }, rotation: { set() {} },
                    traverse(fn) { fn(this); } };
    _loaderManifestResult = { scene, liveryMeshes: [], rearWing: null };
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff8800 });
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    ['wFL','wFR','wRL','wRR'].forEach(n => expect(names.has(n)).toBe(true));
  });

  it('G3. grp.position.y = 0.048 (GT: wR=0.338, wheelLocalY=-0.05)', async () => {
    _loaderManifestResult = null;
    const { buildGTHybrid } = await import('../cars.js');
    const grp = await buildGTHybrid({ color: 0xff8800 });
    expect(grp.position.y).toBeCloseTo(0.048, 3);
  });
});
```

Run `npm test`. **3 tests must fail**. Confirm.

### 5.2 Implement `buildGTHybrid` in `js/cars.js`

Same structure as `buildF1Hybrid`, GT wheel constants, no rear-wing wrapping:

```js
async function buildGTHybrid({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const loaded = await loadCarFromManifest(CAR_MANIFEST.gt);
  if (!loaded) {
    console.warn('[buildGTHybrid] GLB load failed — using procedural GT');
    return buildGTProcedural({ color });
  }

  grp.add(loaded.scene);
  applyLivery(loaded.liveryMeshes, color);
  // GT: rearWing is null in manifest — no wing wrapping needed

  const matTyre = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub  = makeMat(0xe0e0e0, 0.08, 1.00);
  const wR = 0.338, wW = 0.260;
  const wPos = {
    wFL: [-0.86, -0.05, -1.38],
    wFR: [ 0.86, -0.05, -1.38],
    wRL: [-0.86, -0.05,  1.42],
    wRR: [ 0.86, -0.05,  1.42],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n;
    w.position.set(x, y, z);
    grp.add(w);
  });

  grp.position.y = -0.34 + wR - (-0.05);   // 0.048
  return grp;
}
```

### 5.3 Verify tests green

`npm test` → **176 passing** (173 + 3).

### 5.4 Browser alignment tuning pass

Same process as Phase 4.6 with `USE_IMPORTED_MODELS = { GT: true, ... }`. GT3 RS is typically taller and wider — likely needs `transform.position[1]` adjustment. Scale is usually correct (1.0) for Sketchfab assets in meters.

### 5.5 Acceptance gate

- [ ] GT renders imported body (curved roof, fenders, arches visible).
- [ ] Procedural wheels fit inside arches.
- [ ] Livery color picker recolors.
- [ ] No `rearWing` animation attempted (GT has no flap).
- [ ] Rename `assets/models/gt.glb` → fallback procedural GT renders. Rename back.
- Screenshot: `images/gt-hybrid-idle.png`.

---

## Phase 6 — Flip flags + regression matrix + perf gate + screenshots

**Requires both GLBs present, both alignment passes complete.**

### 6.1 Flip flags in `js/cars.js`

```js
export const USE_IMPORTED_MODELS = { F1: true, F2: false, F3: false, GT: true };
```

### 6.2 Acceptance test — fallback when GLB absent

Append to `js/__tests__/cars.test.js`:

```js
describe('GLB fallback acceptance (Phase 6)', () => {
  it('F1 procedural renders when loader returns null (simulates missing GLB)', async () => {
    _loaderManifestResult = null;
    const { buildCar } = await import('../cars.js');
    // Even with USE_IMPORTED_MODELS.F1 = true, null loader → procedural
    const grp = await buildCar('F1');
    const names = new Set();
    grp.traverse(o => { if (o.name) names.add(o.name); });
    expect(names.has('wFL')).toBe(true);
    expect(names.has('rearWing')).toBe(true);
  });

  it('GT procedural renders when loader returns null', async () => {
    _loaderManifestResult = null;
    const { buildCar } = await import('../cars.js');
    const grp = await buildCar('GT');
    let wFL = null;
    grp.traverse(o => { if (o.name === 'wFL') wFL = o; });
    expect(wFL).not.toBeNull();
  });
});
```

`npm test` → **178 passing** (176 + 2).

### 6.3 Full regression matrix (manual browser)

| Feature | F1 (GLB) | GT (GLB) | F2 (proc) | F3 (proc) |
|---|---|---|---|---|
| Car loads < 3 s | ☐ | ☐ | ☐ | ☐ |
| Wheels visible and spin | ☐ | ☐ | ☐ | ☐ |
| Brake glow on deceleration | ☐ | ☐ | ☐ | ☐ |
| Livery color picker works | ☐ | ☐ | ☐ | ☐ |
| Wing-flip animates | ☐ | n/a | ☐ | ☐ |
| Airflow smoke trails | ☐ | ☐ | ☐ | ☐ |
| Rain + rooster tails | ☐ | ☐ | ☐ | ☐ |
| CFD pressure overlay | ☐ | ☐ | ☐ | ☐ |
| Optimal weather | ☐ | ☐ | ☐ | ☐ |
| All 4 camera modes | ☐ | ☐ | ☐ | ☐ |
| Car-switch no ghost mesh | ☐ | ☐ | ☐ | ☐ |
| F2 makes no GLB network request | — | — | ☐ | — |
| F3 makes no GLB network request | — | — | — | ☐ |

### 6.4 Perf gate

Browser DevTools Performance tab, 10 s recording at F1, speed 200, Airflow + Rain active.

- **Target**: frame time ≤ procedural baseline × 1.10 (≤ 10% regression).
- If over budget: re-run gltf-transform with `--texture-size 1024`; if still over, add `--simplify 0.7` to decimate mesh.

### 6.5 Screenshots

Save from the `images/observation-1.png` angle:
- `images/post-glb-F1-idle.png`
- `images/post-glb-F1-speed200.png`
- `images/post-glb-GT-idle.png`
- `images/post-glb-GT-speed200.png`

---

## File manifest (all phases complete)

| File | Status |
|---|---|
| `js/car-manifest.js` | **new** (Phase 1) |
| `js/__tests__/car-manifest.test.js` | **new** (Phase 1) |
| `js/car-loader.js` | **extended** — `loadCarFromManifest` (Phase 2) |
| `js/__tests__/car-loader.test.js` | **extended** — 7 new tests (Phase 2) |
| `js/cars.js` | **refactored** — builders renamed, dispatcher async, hybrids, flag (Phases 3–6) |
| `js/__tests__/cars.test.js` | **extended** — async migration + hybrid + acceptance tests (Phases 3–6) |
| `js/main.js` | **updated** — `spawnCar` async + await call sites (Phase 3) |
| `assets/models/ATTRIBUTION.md` | **existing** — do not touch |

## Expected test progression

| After phase | Total tests |
|---|---|
| Baseline | 148 |
| Phase 1 | 156 (+8) |
| Phase 2 | 163 (+7) |
| Phase 3 | 167 (+4) |
| Phase 4 | 173 (+6) |
| Phase 5 | 176 (+3) |
| Phase 6 | 178 (+2) |

## Report back after each phase

1. Phase completed and any not completed.
2. Test count before → after.
3. Files added / changed with one-line rationale.
4. Phase 4 / 5: final `CAR_MANIFEST.*.transform` values and any `stripMeshes` / `liveryMeshes` adjustments.
5. Phase 6: completed regression matrix + FPS before/after + screenshots.
6. Any deviation from this plan and why.

## Do Not

- Do not delete `buildF1Procedural`, `buildF2Procedural`, `buildF3Procedural`, `buildGTProcedural`.
- Do not modify F2 or F3 builder bodies.
- Do not lower `scene-config.js` invariants.
- Do not ship a GLB without an `ATTRIBUTION.md` entry.
- Do not block scene init on GLB load without a loading state.
- Do not commit unless the user explicitly asks.
- Do not start Phase 6 until Phase 4 and 5 alignment passes are visually confirmed.
