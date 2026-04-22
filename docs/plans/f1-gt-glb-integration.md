# Plan: F1 + GT GLB Integration (Hybrid Import)

## Current State (verified 2026-04-18)

**Assets downloaded**:
- `assets/models/f1-shunqi-mcl39.glb` — **117 MB** · 1.1M tris · CC-BY · shunqi · F1 2025 McLaren MCL39
- `assets/models/gt-blacksnow-porsche-gt3-rs.glb` — **19 MB** · 368.8k tris · CC-BY · Black Snow · Porsche GT3 RS

**Code already in place**:
- `js/car-loader.js` — `loadCarModel(url)` returns `{ scene, wheels, liveryMeshes }` or `null`. 8 passing tests.
- `js/cars.js` exports `USE_IMPORTED_MODELS = false` feature flag.
- Wheel grounding formula correct on all 4 builders.
- Material calibration applied.

**Tests**: 140 passing (136 base + 4 wheel-grounding + 8 loader = 148? — working session to confirm exact count before starting).

## Blockers Driving This Plan

1. **117 MB F1 is unshippable to browsers.** Must be pre-processed (Draco + decimate) to ~10-15 MB.
2. **Downloaded GLBs use the artist's mesh names, not our convention** (`livery_*`, `wheel_*`, `rearWing`). We cannot edit the GLB by hand. Solution: a per-car **manifest** that maps artist names → our roles, plus a fallback strategy when nothing matches.
3. **`buildCar(type, color)` is synchronous today**; GLB loading is async. Full async refactor is the riskiest step in this plan.
4. **Alignment unknown**: each GLB has its own scale, origin, forward-axis, and ground plane. We must compute a transform to fit our coord system (wheels on `y=-0.34`, nose at `-Z`, width ≤ 2u for F1).

## Goal

F1 + GT cars use their imported GLB bodies with procedural wheels, livery recolor, wing-flip, and all existing effects intact. F2 + F3 remain procedural (out of scope this plan). Fallback to procedural on any failure.

## Scope

**In scope**:
- Asset preprocessing (Draco + optional decimation) via npm scripts.
- `js/car-manifest.js` — per-car GLB manifest (transform, livery meshes, wheels to strip).
- `js/car-loader.js` extension — accepts manifest, returns roles resolved.
- `js/cars.js` — async `buildCar`, refactored `buildF1` + `buildGT` with GLB branch + procedural fallback.
- `js/main.js` — await `buildCar`; loading placeholder.
- Tests: loader manifest resolution, builder fallback, wheel preservation.
- `assets/models/ATTRIBUTION.md` — CC-BY credits.
- Vite config audit: GLB asset handling.

**Out of scope**:
- F2 and F3 GLB integration (plan a follow-up once F1+GT proven).
- PBR texture upgrades for track / wheels (Phase 5 of visual-fidelity-upgrade.md, separate plan).
- `effects.js`, `cfd-effect.js`, `physics.js`, `airflow-core.js`.
- Scene-config invariants.

## Constraints

- **TDD** for every logic change.
- **No regressions** — all existing tests remain green.
- **Fallback mandatory** — if the GLB is missing, corrupt, or the manifest fails to resolve, the procedural car must render. App must never show a broken scene.
- **License file mandatory** — `assets/models/ATTRIBUTION.md` updated before any integration is visible in UI.
- **No commits** without explicit user approval.
- **Do not delete procedural `buildF1` / `buildGT` logic** — rename to `buildF1Procedural` / `buildGTProcedural` and call from the fallback branch.

---

## Phase A — Preprocess GLBs (mandatory, do first)

**Why**: 117 MB is a dev-build + download-time + GPU-memory disaster. A 10x–20x reduction is achievable without perceptible quality loss using Draco geometry compression + KTX2/BasisU texture compression.

### A.1 Install tooling (devDependencies only)

```bash
npm i -D @gltf-transform/cli
```

gltf-transform ships a CLI (`gltf-transform`) with Draco, Meshopt, texture resize, and dedup commands. No Blender required.

### A.2 Add preprocessing npm scripts

Update `package.json`:

```json
"scripts": {
  "models:inspect:f1": "gltf-transform inspect assets/models/f1-shunqi-mcl39.glb",
  "models:inspect:gt": "gltf-transform inspect assets/models/gt-blacksnow-porsche-gt3-rs.glb",
  "models:optimize:f1": "gltf-transform optimize assets/models/f1-shunqi-mcl39.glb assets/models/f1.glb --texture-compress webp --texture-size 2048 --compress draco",
  "models:optimize:gt": "gltf-transform optimize assets/models/gt-blacksnow-porsche-gt3-rs.glb assets/models/gt.glb --texture-compress webp --texture-size 2048 --compress draco"
}
```

`gltf-transform optimize` runs prune → dedup → resample → Draco + texture compress in one pass.

### A.3 Run + verify

1. `npm run models:inspect:f1` — note pre-optimize file size, triangle count, texture sizes. Save output to `docs/logs/asset-preprocess-f1.md`.
2. `npm run models:optimize:f1` — produces `assets/models/f1.glb` (target **< 15 MB**).
3. Repeat for GT → `assets/models/gt.glb` (target **< 8 MB**).
4. If either output still exceeds target, add `--simplify 0.6` (mesh decimation to 60% tris) to the optimize command and re-run.
5. **Keep** the original `f1-shunqi-mcl39.glb` + `gt-blacksnow-porsche-gt3-rs.glb` as source files. Only `f1.glb` and `gt.glb` get loaded at runtime.

### A.4 Write attribution file

Create `assets/models/ATTRIBUTION.md`:

```markdown
# 3D Model Attribution

This project uses Creative Commons Attribution (CC-BY 4.0) licensed models.
Required attribution below.

## F1 — McLaren MCL39 (2025)
- Author: **shunqi**
- Source: https://sketchfab.com/3d-models/f1-2025-mclaren-mcl39-c6194270002b401bb25be7e35ab56e34
- License: CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/

## GT — Porsche 911 GT3 RS
- Author: **Black Snow (@BlackSnow02)**
- Source: https://sketchfab.com/3d-models/porsche-gt3-rs-e738eae819c34d19a31dd066c45e0f3d
- License: CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/
```

### A.5 Add a runtime credit surface

In `index.html` footer or info panel, add a small "3D models © shunqi, Black Snow — CC-BY 4.0" line. The CC-BY license requires attribution to be visible to users, not only in a source file.

**Stop condition**: both optimized files land under size budget; attribution in place; existing tests still pass.

---

## Phase B — Car manifest module

**Goal**: Decouple artist mesh names from our code. Each car gets a manifest that tells the loader what's what.

### B.1 Create `js/car-manifest.js`

```js
/**
 * Per-car GLB manifest.
 * Tells car-loader + cars.js how to adapt an artist's scene graph
 * to our coordinate system and role-based naming.
 */

export const CAR_MANIFEST = {
  f1: {
    url: new URL('../assets/models/f1.glb', import.meta.url).href,
    // Transform applied to the imported root to fit our scene:
    //   - scale:    uniform multiplier
    //   - rotation: [x, y, z] in radians applied after scale
    //   - position: [x, y, z] applied after rotation
    // Values are placeholders — working session measures actual GLB and tunes.
    transform: { scale: 1.0, rotation: [0, 0, 0], position: [0, 0, 0] },
    // Mesh names (case-insensitive substring match) to strip from the imported
    // scene because we replace them with procedural wheels.
    stripMeshes: ['wheel', 'tire', 'tyre', 'rim'],
    // Mesh names (case-insensitive substring match) that should be tinted
    // when buildLivery is called with a user color.
    liveryMeshes: ['body', 'paint', 'chassis'],
    // Optional: a single mesh name (substring match) that must become
    // the rotatable rear wing group for the wing-flip feature.
    rearWing: 'wing_rear',
  },
  gt: {
    url: new URL('../assets/models/gt.glb', import.meta.url).href,
    transform: { scale: 1.0, rotation: [0, 0, 0], position: [0, 0, 0] },
    stripMeshes: ['wheel', 'tire', 'tyre', 'rim'],
    liveryMeshes: ['body', 'paint'],
    rearWing: null,   // GT3 RS has a fixed wing — no flip animation
  },
};
```

### B.2 Write failing tests `js/__tests__/car-manifest.test.js`

- `CAR_MANIFEST.f1.url` is a usable URL string.
- `CAR_MANIFEST.gt.transform` has numeric scale + array rotation + array position.
- Keys `stripMeshes` and `liveryMeshes` are arrays of lowercase strings.

**Stop condition**: manifest module exists; tests green.

---

## Phase C — Loader extension (manifest-aware)

### C.1 Extend `js/car-loader.js`

Add second function that accepts a manifest entry and resolves roles:

```js
export async function loadCarFromManifest(manifest) {
  const loaded = await loadCarModel(manifest.url);
  if (!loaded) return null;

  const { scene } = loaded;
  const { transform, stripMeshes, liveryMeshes, rearWing } = manifest;

  // Apply transform
  scene.scale.setScalar(transform.scale);
  scene.rotation.set(...transform.rotation);
  scene.position.set(...transform.position);

  const stripped = [];
  const liveryFound = [];
  let rearWingNode = null;

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const n = (child.name || '').toLowerCase();
    if (stripMeshes.some(s => n.includes(s))) stripped.push(child);
    if (liveryMeshes.some(s => n.includes(s))) liveryFound.push(child);
    if (rearWing && n.includes(rearWing.toLowerCase())) rearWingNode = child;
  });

  // Remove stripped meshes (we replace with procedural wheels).
  stripped.forEach(m => m.parent?.remove(m));

  return {
    scene,
    liveryMeshes: liveryFound,
    rearWing: rearWingNode,
  };
}
```

### C.2 Tests `js/__tests__/car-loader.test.js` (append)

- Given a fake GLB with meshes `['body', 'wheel_FL', 'wheel_FR', 'wing_rear']`, loader with manifest `{ stripMeshes: ['wheel'], liveryMeshes: ['body'], rearWing: 'wing_rear' }`:
  - `stripped` meshes are removed from the scene graph.
  - `liveryMeshes` contains 1 entry (`body`).
  - `rearWing` is the `wing_rear` node.
- With `rearWing: null`, returned `rearWing` is `null`.
- With manifest.url that fails to load, returns `null` (uses existing fallback path).
- Transform is applied: `scene.scale`, `scene.rotation`, `scene.position` match manifest values.

**Stop condition**: tests green.

---

## Phase D — Async `buildCar` refactor

**This is the highest-risk step.** Take it slowly.

### D.1 Rename existing procedural builders

In `js/cars.js`, rename:
- `buildF1` → `buildF1Procedural`
- `buildF2` → `buildF2Procedural`  *(keep identity, F2 still procedural)*
- `buildF3` → `buildF3Procedural`  *(keep identity, F3 still procedural)*
- `buildGT` → `buildGTProcedural`

All call sites internal to `cars.js` get updated. Exported `buildCar` dispatches to them.

### D.2 Make `buildCar` async

```js
export async function buildCar(type, color) {
  if (type === 'F1') return await buildF1Hybrid(color);
  if (type === 'GT') return await buildGTHybrid(color);
  // F2 / F3 stay procedural (sync wrapped in Promise for uniform API).
  if (type === 'F2') return buildF2Procedural({ color });
  if (type === 'F3') return buildF3Procedural({ color });
}
```

### D.3 Update every `buildCar` caller to `await`

Audit `js/main.js` with grep first, then edit:
```bash
grep -n "buildCar" js/main.js
```

Each call site becomes `const car = await buildCar(type, color);` — and the surrounding function must be async or use `.then(...)`. Work outward until callers are async-clean or the top-level gets an IIFE.

**UI concern**: if the GLB takes 2s to stream on first load, the scene shouldn't be empty. Options:
- (A) Render a procedural car first, swap when GLB resolves.
- (B) Show a "Loading..." overlay.

**Pick A** — it's fail-soft. Implementation:
```js
let car = buildF1Procedural({ color });           // sync placeholder
scene.add(car);
buildCar('F1', color).then(hybrid => {
  scene.remove(car);
  car = hybrid;
  scene.add(car);
});
```
But this doubles the complexity on the car-swap state machine. **Defer to Phase E decision**. For Phase D, simpler: block scene build on `await` with a spinner.

### D.4 Tests

In `js/__tests__/cars.test.js`:
- `await buildCar('F1', 0xff0000)` returns a Group.
- Returned group still has `wFL`, `wFR`, `wRL`, `wRR` children.
- Returned group has `rearWing` child.
- Wheel-grounding invariant still holds (existing 4 tests — change to `await`).
- `buildCar('F2', ...)` uses procedural path (unchanged behavior).

**Stop condition**: every existing test migrated to `async/await` passes; no tests fail.

---

## Phase E — F1 hybrid builder

### E.1 `buildF1Hybrid(color)` in `js/cars.js`

```js
import { CAR_MANIFEST } from './car-manifest.js';
import { loadCarFromManifest } from './car-loader.js';

async function buildF1Hybrid(color) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const loaded = await loadCarFromManifest(CAR_MANIFEST.f1);
  if (!loaded) {
    console.warn('[buildF1Hybrid] GLB load failed — falling back to procedural');
    return buildF1Procedural({ color });
  }

  grp.add(loaded.scene);

  // Apply user color to livery meshes (clone materials to avoid shared mutation)
  applyLivery(loaded.liveryMeshes, color);

  // Rename rear wing for wing-flip feature
  if (loaded.rearWing) {
    loaded.rearWing.name = 'rearWing';
  }

  /* Procedural wheels — SAME positions + names as buildF1Procedural */
  const wR = 0.345, wW = 0.340;
  const wPos = {
    wFL: [-0.82, -0.04, -1.50],
    wFR: [ 0.82, -0.04, -1.50],
    wRL: [-0.80, -0.04,  1.60],
    wRR: [ 0.80, -0.04,  1.60],
  };
  const matTyre = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub  = makeMat(0xd8d8d8, 0.10, 1.00);
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n;
    w.position.set(x, y, z);
    grp.add(w);
  });

  // Ground lift — unchanged formula
  grp.position.y = -0.34 + wR - (-0.04);

  return grp;
}

function applyLivery(meshes, color) {
  const c = new THREE.Color(color);
  meshes.forEach(m => {
    m.material = m.material.clone();
    if (m.material.color) m.material.color.copy(c);
  });
}
```

### E.2 Alignment tuning pass

On first browser load with `USE_IMPORTED_MODELS=true` and `buildCar('F1', ...)`:

1. Open browser console. Expect the F1 GLB to be wildly mis-scaled, misoriented, or off-center. **This is normal.**
2. Measure with temporary console logging in `buildF1Hybrid`:
   ```js
   const bbox = new THREE.Box3().setFromObject(loaded.scene);
   console.log('F1 GLB bbox:', bbox.min, bbox.max, 'size:', bbox.getSize(new THREE.Vector3()));
   ```
3. Based on measurements, update `CAR_MANIFEST.f1.transform`:
   - **Scale**: target car length ≈ 5.5u (F1 ~5.5 m at 1 unit = 1 m).
   - **Rotation**: if nose points +Z, rotate `[0, Math.PI, 0]`.
   - **Position Y**: offset so the GLB's wheel-axle-line sits at our procedural wheel Y (~0). Don't over-engineer; just translate until the GLB and the procedural wheels look joined.
4. Iterate: reload, adjust, reload. Usually 3–4 rounds.
5. Commit final `transform` values in `car-manifest.js`. Remove the console.log.

### E.3 Livery tuning

If `applyLivery` doesn't recolor anything, inspect the GLB mesh names:
```js
loaded.scene.traverse(m => { if (m.isMesh) console.log(m.name, m.material.name); });
```
Update `CAR_MANIFEST.f1.liveryMeshes` substrings to match actual names. Shunqi's MCL39 may use names like `body_shell`, `paint_primary`, or McLaren-specific names like `mcl39_body`.

### E.4 Tests

- `buildCar('F1', ...)` with loader mocked to return `null` → returns a procedural F1 (wheels present, grounded).
- `buildCar('F1', 0xff00ff)` with loader mocked to return fake scene + livery meshes → those meshes' `.material.color` equals magenta.
- `buildCar('F1', ...)` with mocked success → returned group still contains 4 named wheels.

**Stop condition**: F1 renders hybrid in browser; rear-wing-flip still animates; wheels spin; color picker still changes livery; fallback tested by renaming `assets/models/f1.glb` → scene still renders procedural F1.

---

## Phase F — GT hybrid builder

Mirror Phase E for GT:
- `buildGTHybrid(color)` using `CAR_MANIFEST.gt`.
- GT wheels: `wR = 0.338, wW = 0.320` (check current `buildGTProcedural` for exact values).
- No rear-wing-flip — GT has a fixed wing.

Alignment pass: GT3 RS has a roof, so `scale` + `position.y` tuning is stricter than F1. Budget 1 hour.

Same test pattern as Phase E.

**Stop condition**: GT renders hybrid; wheels attached correctly; no clipping through body; fallback tested.

---

## Phase G — Feature flag, flip, and smoke test

### G.1 Flip the flag

`js/cars.js`:
```js
export const USE_IMPORTED_MODELS = { F1: true, GT: true, F2: false, F3: false };
```

Update `buildCar` to dispatch based on flag per-type.

### G.2 Full regression test

Run the full matrix in the browser:
- F1 + all 4 camera modes + all 3 environments (airflow / rain / optimal) + CFD.
- Same for GT.
- F2 + F3 (procedural) — still work.
- Speed slider idle → 200 → 300.
- Wing flip feature on F1.
- Hard-refresh; watch network tab — GLBs cached cleanly.

### G.3 Perf gate

Record FPS at speed 200 with Airflow+Rain for each car. Compare to procedural baseline from `docs/logs/`. Acceptable: ≤10% regression.

### G.4 Final screenshots

Screenshot all 4 cars at the `observation-1.png` angle. Save to `images/post-glb-{F1,F2,F3,GT}.png`.

**Stop condition**: user signs off on visual + perf.

---

## Acceptance Criteria

- [ ] `assets/models/f1.glb` < 15 MB; `assets/models/gt.glb` < 8 MB (optimized).
- [ ] `assets/models/ATTRIBUTION.md` exists with CC-BY credits.
- [ ] Runtime attribution line visible in UI.
- [ ] F1 + GT render GLB bodies with visible sculpted detail.
- [ ] All 4 wheels on both cars remain procedural and touch the ground.
- [ ] Color picker still recolors livery on F1 and GT.
- [ ] Wing-flip works on F1 (no regression).
- [ ] F2 + F3 unchanged (still procedural, still working).
- [ ] All effects (airflow/rain/CFD/optimal) still work on all 4 cars.
- [ ] Delete `f1.glb` → procedural fallback renders without console errors.
- [ ] Test count strictly greater than current (new tests added, nothing removed).
- [ ] FPS within 10% of procedural baseline.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| gltf-transform optimize mangles geometry | Keep originals; if optimize fails, try `--simplify 0.8` lighter pass, or fall back to only Draco (`--compress draco` alone). |
| GLB has hardcoded wheel positions that clip with our procedural wheels | Strip by manifest `stripMeshes`; if still clipping, tune `transform.scale` to match wheelbase. |
| shunqi MCL39 livery meshes don't match simple substrings | Console.log mesh tree in browser; update `liveryMeshes` substrings to real names. |
| Async `buildCar` refactor breaks car-swap in UI | Add a loading lock: disable car-swap buttons while `buildCar` promise is pending. |
| Black Snow Porsche is a road car, not GT3 race version | Cosmetic only — shape reads as a GT. Acceptable given the CC-BY pool. Note in `ATTRIBUTION.md`. |
| Vite inlines large GLB into JS bundle | Verify with `npm run build` — expect `.glb` to land in `dist/assets/` as a separate file. If Vite inlines, add `vite-plugin-static-copy` or move to `public/models/`. |
| Wing-flip substring match picks up wrong node | Dump scene tree; tighten substring. If no match, disable wing-flip for F1 hybrid (set `manifest.rearWing = null`) until we can rename in Blender. |

## Report Back After Each Phase

- Phase completed + commit SHA (don't commit — just note where you'd cut one).
- Test count before → after.
- Files added / changed.
- File sizes (for Phase A).
- Any deviation from the plan and why.
- Screenshot when visible changes land (E.2, F alignment, G.4).

## Do Not

- Do not delete `buildF1Procedural` / `buildGTProcedural` — fallback relies on them.
- Do not commit `f1-shunqi-mcl39.glb` (117 MB). Add to `.gitignore` or document as source-only. Only commit the optimized `f1.glb`.
- Do not lower any `scene-config.js` invariants to compensate for imported-material brightness. If needed, do a focused tuning pass in a follow-up plan.
- Do not strip license metadata from the GLBs. gltf-transform optimize preserves it by default.
- Do not block the main render loop on GLB load without a fallback render path.
- Do not commit unless the user explicitly asks.
