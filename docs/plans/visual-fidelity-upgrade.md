# Plan: Visual Fidelity Upgrade — Car Geometry Accuracy + Polish

## Background

Current state after material calibration:
- Wheel grounding fixed (`cars.js:624/824/988/1199`).
- `makeBodyMat` tuned (clearcoat 0.55, roughness 0.15, envMapIntensity 1.4, iridescence 0.08).
- Scene exposure 1.3, environmentIntensity 1.0, bloom threshold 1.05.
- Cars no longer glow like neon.

Remaining issue (primary): **car geometry looks like assembled lego blocks**. The `rBox`, `cyl`, `LatheGeometry`, and `TubeGeometry` primitives that build each car's body cannot express the double-curved sidepod inlets, monocoque flow, engine-cover sculpting, or cascade-flap detail that make F1/F2/F3/GT cars visually distinctive. No material pass can fix this — the geometry is the bottleneck.

## Goal

Move from 100% procedural cars to **hybrid cars**: imported glTF/GLB bodies for all the sculpted static geometry, procedural-as-before for the parts that animate or swap color (wheels, rear wing, brake glow, livery tint).

Second goal: raise the realism of surfaces that stay procedural by adding **PBR texture maps** (albedo + normal + roughness + metalness) where today we have solid colors.

## Scope

**In scope**:
- New module `js/car-loader.js` with glTF loading + fallback.
- New asset folder `public/models/cars/` for GLB files.
- New asset folder `public/textures/` for PBR texture sets.
- Refactor of `buildF1 / buildF2 / buildF3 / buildGT` in `js/cars.js` to compose: imported body GLB + procedural wheels / rear wing / brakes / livery.
- Track asphalt + rumble strips PBR uplift in `js/track.js`.
- New tests: `js/__tests__/car-loader.test.js`.

**Out of scope**:
- `airflow-core.js`, `effects.js`, `cfd-effect.js`, `physics.js`.
- Smoke / rain / CFD / optimal weather behavior.
- Scene-config invariants (ambient / sun / exposure floors).
- Post-processing pipeline.

## Constraints

- **TDD**: tests first for every non-asset code change.
- **No regressions**: all existing tests pass (currently 140: 136 + 4 wheel-grounding). New tests are additive.
- **Procedural fallback required**: if a GLB file is missing or fails to load, the existing procedural builder must run. The app must never break because an asset is absent.
- **Preserve named sub-objects**: `wFL`, `wFR`, `wRL`, `wRR`, `rearWing`, `brake_*`, `brake_cal_*` must continue to exist on the returned group — effects and physics attach to them by name.
- **Preserve `buildLivery()` semantics**: user-selected `color` still recolors the car. For imported bodies, this requires naming convention inside the GLB (a mesh named `liveryPrimary` that we tint via a material clone).
- **Licensing**: every imported asset must be usable under a permissive license (CC-BY / CC0 / purchased). Record the license + source URL in `public/models/cars/ASSETS.md`.
- **No new heavy dependencies**. Three.js already ships `GLTFLoader` and `DRACOLoader` — use those.
- Do not commit unless the user explicitly asks.

## Phasing

Six phases, each independently verifiable. Pause between phases for user approval before moving on.

---

### Phase 0 — Visual verification of material calibration

Before any new work, confirm the calibration pass actually produced the intended look.

**Working session actions**:
1. Start dev server (`npm run start`), hard refresh browser.
2. Screenshot each car at idle + speed 200 from the same angle as `images/observation-1.png`.
3. Save to `images/post-calibration-{F1,F2,F3,GT}.png`.
4. Report back qualitatively: red reads as paint (not neon)? highlights roll off? details visible?

**Stop condition**: orchestrator + user review screenshots. Proceed only if calibration is acceptable. Otherwise loop back to material tuning before phase 1.

---

### Phase 1 — Loader foundation

Build the asset-loading infrastructure WITHOUT replacing any cars yet.

**Write failing tests first** in `js/__tests__/car-loader.test.js`:
- `loadCarModel(url)` returns a Promise that resolves to a `{ scene, wheels: [], liveryMeshes: [] }` shape.
- When the URL is missing / fetch fails, the returned Promise resolves (not rejects) with `null` — caller decides fallback.
- Loader correctly traverses the GLB scene and extracts any mesh named `wheel_*` into `wheels[]` (for the test we supply a fake GLB shape via a mocked `GLTFLoader`).
- Loader sets `castShadow = true` and `receiveShadow = true` on all meshes in the imported scene.

Extend the Three.js mock to include a `GLTFLoader` stub that resolves with a caller-provided fake scene graph.

**Implement** `js/car-loader.js`:
```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const loader = new GLTFLoader();
const draco  = new DRACOLoader();
draco.setDecoderPath('/draco/');   // optional, only if we use draco-compressed assets
loader.setDRACOLoader(draco);

export async function loadCarModel(url) {
  try {
    const gltf = await loader.loadAsync(url);
    const scene = gltf.scene;
    const wheels = [];
    const liveryMeshes = [];
    scene.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      if (child.name.startsWith('wheel_')) wheels.push(child);
      if (child.name.startsWith('livery_')) liveryMeshes.push(child);
    });
    return { scene, wheels, liveryMeshes };
  } catch (err) {
    console.warn('[car-loader] falling back to procedural:', url, err);
    return null;
  }
}
```

**Wire it** behind a feature flag in `js/cars.js` but **do not yet replace any car**:
```js
const USE_IMPORTED_MODELS = false;   // flip per-car in phase 3
```

**Verify**: tests green, procedural cars still render identically in the browser.

---

### Phase 2 — Source & validate ONE asset (F1 only)

Do not commit to four assets before proving the pipeline with one.

**User decisions required** (orchestrator to ask before handing to working session):
- Asset source: Sketchfab free (CC-BY), Sketchfab store (paid), CGTrader, TurboSquid, Blender Market, or commissioned?
- Budget per car (in USD, or $0 if free-only).
- Style: photorealistic, stylized, or cartoon?

**Target spec for the F1 GLB**:
- Polycount: **30k–90k triangles total**. Below 30k looks blocky; above 90k may hurt FPS on integrated GPUs.
- Body only — **no wheels included** (we keep those procedural to animate spin / brake glow / livery).
- Named sub-meshes required:
  - `body_primary` — the main painted shell; recolored by `buildLivery`.
  - `body_carbon` — exposed carbon-fibre parts (monocoque, floor, diffuser).
  - `rearWing` — must be a self-contained group so we can pivot it 180° for the wing-flip feature.
  - `front_wing`, `nose`, `sidepod_left`, `sidepod_right`, `engine_cover`, `halo` — used for localized effects / material tuning.
- PBR texture set per material (albedo, normal, roughness, metalness, AO if available). Textures at 2048×2048 max.
- File format: `.glb` (binary) at `public/models/cars/f1.glb`. Draco compression optional.

**Working session actions**:
1. Once the asset is placed at `public/models/cars/f1.glb`, write a one-off smoke script `scripts/inspect-model.js` that logs the GLB's mesh names + triangle counts. Confirm naming matches the spec.
2. If naming doesn't match, rename in Blender before shipping — don't adapt code to bad naming.
3. Record source URL + license in `public/models/cars/ASSETS.md`.

**Stop condition**: F1 asset validates. User approves the look before phase 3.

---

### Phase 3 — Integrate F1 (hybrid: GLB body + procedural wheels)

**Refactor `buildF1({ color })`** in `js/cars.js`:

Pseudo-code structure:
```js
async function buildF1({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  // 1. Try to load the imported body
  const loaded = await loadCarModel('/models/cars/f1.glb');
  if (loaded) {
    grp.add(loaded.scene);
    // Re-tint livery meshes to user color
    applyLivery(loaded.liveryMeshes, color);
    // Find and name the rearWing subgroup for wing-flip animation
    const rearWing = loaded.scene.getObjectByName('rearWing');
    if (rearWing) rearWing.name = 'rearWing';
  } else {
    // Fallback: current procedural buildF1 body (keep a copy as buildF1Procedural)
    buildF1Procedural(grp, color);
  }

  // 2. Procedural wheels stay the same (same positions, names, materials)
  const wR = 0.345, wW = 0.340;
  const wPos = { wFL: [-0.82, -0.04, -1.50], ... };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n;
    w.position.set(x, y, z);
    grp.add(w);
  });

  // 3. Ground lift unchanged — wheel formula still correct
  grp.position.y = -0.34 + wR - (-0.04);

  return grp;
}
```

**Two important refactors** needed:
- `buildCar(type)` must become async (returns `Promise<Group>`), since loaders are async. Audit every call site in `main.js` and elsewhere — await the result, or restructure state so scene builds once the car resolves. **This is the riskiest change in the whole plan**. Do it carefully with tests.
- `applyLivery(meshes, color)` utility: clones the material of each `liveryMeshes` entry (to avoid mutating shared materials across cars) and sets `.color` to the user's pick.

**Tests**:
- `buildF1({ color })` with the loader mocked to return a fake scene → returned group contains the fake scene.
- `buildF1({ color })` with the loader returning `null` → falls back to procedural; wheels still present and grounded.
- Existing wheel-grounding test still passes with the new async form.
- Existing `rearWing` test (for wing-flip) still finds the group.

**Stop condition**: F1 loads, renders, animates rear wing, swaps livery color, spins wheels, and falls back cleanly if the GLB is removed.

---

### Phase 4 — Integrate F2, F3, GT

Repeat Phase 2 + Phase 3 for each of the remaining three cars. Each gets its own GLB under `public/models/cars/{f2,f3,gt}.glb` with the same naming convention.

- GT model may include closed-body shell (wheel arches / fenders). Decide whether GT wheels stay procedural (consistent) or come from the GLB (lets the GLB artist model the arches fitting the wheels). Recommend: keep GT wheels procedural too — consistency beats perfection.

**Parallelizable**: phases 4.F2, 4.F3, 4.GT are independent. You could ship them one at a time.

---

### Phase 5 — PBR texture sets on what stays procedural

Even with imported bodies, the **track asphalt**, **rumble strips**, **barriers**, **wheels**, and **brake discs** are still procedural and still look flat.

**Target assets (free / CC0)**:
- PolyHaven asphalt set: `public/textures/track/asphalt-{diff,nrm,rgh,ao}.jpg`.
- PolyHaven rubber / tyre set: for wheel tyres.
- PolyHaven concrete / metal sets: for barriers.

**Code changes**:
- Extend `makeMat` and `MeshStandardMaterial` usages in `track.js` / wheel builder to accept a texture pack: `{ map, normalMap, roughnessMap, metalnessMap, aoMap }`.
- Add a small `loadTextureSet(baseName)` helper in a new `js/texture-loader.js`.

**Tests**:
- `loadTextureSet` falls back to solid color if any map is missing.
- Texture paths are requested lazily, not at module import time.

---

### Phase 6 — Performance + final calibration

After assets are in, two cleanups:

1. **Instance repeated meshes** (long pending from the perf conversation): `InstancedMesh` for rumble strips and tyre stacks in `track.js`. Cuts ~500 draw calls to ~2.
2. **Recalibrate materials against new assets**: imported GLBs often ship with their own PBR values (roughness / metalness per-texel). The scene's environmentIntensity + exposure may now be too bright or too dim relative to the imported materials. Do one focused tuning pass based on a fresh screenshot; do not touch `scene-config.js` floors.

**Tests**:
- `track.js` rumble strip count assertion (existing) → update to count instances instead of child meshes.
- No other test changes.

---

## Acceptance Criteria (end-state)

- [ ] Each car (F1/F2/F3/GT) loads a GLB body that has visible curved sidepods, sculpted engine cover, modelled wing cascade, and detailed nose.
- [ ] Procedural wheels still spin, still have brake glow, still named `wFL`/etc.
- [ ] Livery color still changes the user-selected car tint.
- [ ] Rear wing flip feature still works.
- [ ] Airflow / smoke / rain / CFD / optimal weather all still function.
- [ ] If any GLB is deleted, the app falls back to procedural and tells the console.
- [ ] Track surface has visible PBR detail (asphalt grain, road marking wear).
- [ ] All existing tests pass. New loader + texture-loader tests pass.
- [ ] FPS at speed 200 with Airflow + Rain ≥ parity with current build (±10%).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Imported GLB doesn't match wheel positions or wheelbase | Validate in Phase 2 with the inspect script; reject asset if wheelbase is off. |
| Async refactor of `buildCar` breaks `main.js` init flow | Introduce `await` carefully; cover with tests before touching `main.js`. |
| GLB polycount tanks FPS on low-end hardware | 80k triangle ceiling per asset; test on integrated GPU if available. Consider Draco compression. |
| Imported materials conflict with scene lighting | Phase 6 calibration pass. |
| Asset licensing unclear → legal risk for public demo | `ASSETS.md` mandatory. No model ships without a traceable license. |
| buildLivery logic doesn't map to GLB materials | Require `livery_*` naming convention in the asset spec; clone-and-tint pattern. |

## User Decisions (locked)

1. **Asset budget**: $0 — CC-BY only (attribution required, no payment).
2. **Style**: photorealistic.
3. **Source consistency**: all 4 cars from the same artist / collection.
4. **Polycount ceiling**: **90k triangles per car** (body only, wheels excluded).
5. **Pilot car**: F1 first.

Every imported model must have its source URL + author + CC-BY link recorded in `public/models/cars/ASSETS.md`. No asset ships without that credit.

## Report Back After Each Phase

Working session must after every phase report:
1. Test counts (before / after).
2. Files added / changed.
3. New screenshot (comparable angle).
4. Any asset licensing info added to `ASSETS.md`.
5. Any deviation from the plan and why.

## Do Not

- Do not delete the procedural builders — keep them as `buildF1Procedural` etc. for fallback.
- Do not commit copyrighted models without a license file.
- Do not lower lighting invariants in `scene-config.js`.
- Do not block the main render loop on asset load — show a procedural placeholder first, swap in the imported body when it resolves.
- Do not commit unless the user explicitly asks.
