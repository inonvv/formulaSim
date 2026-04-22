# Plan: Replace Linear Tube Streamlines with Soft Smoke-Puff Particles

## Background

The `AirflowEffect` in `js/effects.js` currently renders two overlapping airflow visualizations:

1. **Stream tubes** — fat 3D `TubeGeometry` pipes, one per seed streamline (`_buildSmokeGuides`). These are the "linear lines" the user wants removed. They look solid, hard-edged, and CAD-like — not smoke.
2. **Smoke particles** — `THREE.Points` chains advecting along the same paths (`_buildSmokeParticles`). These already exist and produce a smoke-thread effect, but with default square-point sprites they read as grainy dots.

## Goal

Remove the hard tube lines entirely, and upgrade the particle system into **soft, billboarded smoke puffs** that look like real wind-tunnel smoke:
- Each particle is a fuzzy radial-gradient sprite (not a flat square)
- Particles **grow** and **fade out** as they travel downstream along each streamline
- Density is high enough to look continuous, not pointillist
- Cp-based coloring preserved (red stagnation → blue suction)
- Pulsing / speed-based opacity preserved

Visual target: think F1 wind-tunnel footage or smoke wand demos — continuous wispy trails of colored smoke drifting through the flow field.

## Scope

**In scope**:
- `js/effects.js` → `AirflowEffect`:
  - Delete `_buildSmokeGuides()` and all `_guideLines` state + references
  - Rewrite `_buildSmokeParticles()` with a generated radial-gradient texture
  - Add per-particle **life** buffer driving size + alpha fade
  - Update the smoke branch of `update()` accordingly
- Tests in `js/__tests__/effects.test.js` — update assertions for removed tubes and new puff behavior

**Out of scope**:
- `airflow-core.js` (do not touch — pure math)
- Streamline paths, seeds, vortex lines, wake particles, pressure orbs, rain, optimal weather, CFD
- Car geometry, scene setup, UI
- `CAR_AERO` profile data (all seeds / positions stay the same)

## Constraints

- **TDD required**: write failing tests first, then implement.
- All existing tests must still pass (adjust the ones that specifically reference stream tubes).
- No new npm dependencies — use a canvas-generated `CanvasTexture` for the radial gradient.
- Keep the existing Cp coloring via vertex colors.
- Preserve the existing advect math (path following, smoke jitter, vortex-coupled drift, yAcc vertical displacement). Do not regress the physics precision work from commit `bc21b66`.
- The Three.js mock in `effects.test.js` does **not** include `CanvasTexture` or DOM `document.createElement('canvas')`. You will need to:
  - Either add a `CanvasTexture` stub to the mock that accepts any argument and exposes `.dispose()`.
  - Or guard the texture creation with a `typeof document !== 'undefined'` check so tests skip texture generation.
  - Prefer the mock-extension approach — cleaner and testable.

## Implementation Steps

### 1. Write failing tests first

In `js/__tests__/effects.test.js`, update the `AirflowEffect` describe block:

**Remove / replace any test that**:
- Asserts `_guideLines` exists or has `length === seeds.length`
- Asserts `TubeGeometry` or `MeshBasicMaterial` with `vertexColors: true` for streamlines

**Add tests that**:
1. After construction, `_guideLines` is `undefined` (or the property does not exist) — tubes are gone.
2. `_smokePoints` still exists and is a `THREE.Points` instance.
3. The smoke `PointsMaterial` has `map` set (the puff texture) and `alphaTest` ≥ 0 (so additive blending works with the gradient).
4. A `_smokeLife` Float32Array is created, length = `seeds.length * SMOKE_PTS`.
5. `SMOKE_PTS` has been raised to ≥ 120 (denser trails).
6. The material's `size` responds to `speedFactor` — at speed 0 it stays near base; at speed 350 it grows noticeably.
7. `_smokePoints` sprite size attenuates with distance (`sizeAttenuation: true`).
8. Smoke opacity is 0 at speed 0 and rises with speed.

Extend the mock to include `CanvasTexture`:
```js
function CanvasTexture(source) {
  this.image = source || {};
  this.needsUpdate = false;
  this.wrapS = this.wrapT = 0;
  this.minFilter = this.magFilter = 0;
  this.dispose = () => {};
}
```
Also stub the global `document` if missing, returning a minimal canvas with `getContext('2d')` that returns a no-op object for gradient calls — only needed because the tested code may invoke canvas APIs during construction. Keep the stub tiny and scoped to this test file.

Run `npm test`. Confirm new tests fail before implementing.

### 2. Delete the tube system

In `js/effects.js`:
- Remove the `_buildSmokeGuides()` method entirely (lines ~250–312).
- Remove the `this._buildSmokeGuides();` call from `_build()`.
- Remove the stream-tube opacity block inside `update()`:
  ```js
  /* ── Stream tube opacity ── */
  for (const gl of this._guideLines) {
    if (gl) gl.mat.opacity = speedFactor * 0.55;
  }
  ```
- Remove the constant `TUBE_R`, `TUBE_SEG`, `RAD_SEG` if they are local only (they are).
- Leave all other constants (`STEPS`, `STEP_SIZE`, `VORTEX_PTS`) alone.
- Raise `SMOKE_PTS` from `60` to `140`.

### 3. Build the puff texture

Add a helper at module scope (near `rnd`):

```js
/* Radial-gradient soft puff texture for smoke particles */
function _makePuffTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  grd.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
```

Cache it in a module-scope singleton (`let _puffTex = null;`) — multiple `AirflowEffect` instances (e.g. car-type switches) should share one texture.

### 4. Rewrite `_buildSmokeParticles`

Replace the existing body so it:

- Still allocates `positions`, `colors`, `_smokeSeedIdx`, `_smokeT`, `_smokeJx/Jy/Jz`, `_smokeYAcc` exactly as before (same layout).
- Adds a new `this._smokeLife = new Float32Array(total);` buffer initialized so each particle starts at a random life offset `rnd(0, 1)` — staggers the fades so trails look continuous, not pulsing together.
- Swaps the `PointsMaterial` for:
  ```js
  const mat = new THREE.PointsMaterial({
    size: 0.18,
    map: _puffTex ||= _makePuffTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  ```
  (Doubled base size since puffs are soft-edged — they need to overlap.)

### 5. Update the smoke branch of `update()`

Inside the per-particle loop, add life progression:

```js
this._smokeLife[i] += dt * 0.6;  // seconds to full life
if (this._smokeLife[i] > 1) this._smokeLife[i] = 0;
```

Use life to compute a fade envelope:

```js
const life = this._smokeLife[i];
// soft in/out: bell curve peaking mid-life
const fade = Math.sin(life * Math.PI);  // 0 → 1 → 0 across life
```

When writing the vertex color, multiply by `fade`:

```js
const cp = pressureCoeff(vxi, veta);
const c  = cpToColor(cp);
sCol[i * 3]     = c.r * fade;
sCol[i * 3 + 1] = c.g * fade;
sCol[i * 3 + 2] = c.b * fade;
```

(Additive blending × faded color = soft appearance/disappearance of each puff.)

The material-level opacity keeps speed gating:

```js
this._smokeMat.opacity = speedFactor * 0.95;
this._smokeMat.size    = 0.15 + 0.12 * speedFactor;  // puffs grow with speed
```

Leave the existing jitter, vortex-coupling, path-advection, and yAcc code untouched. The life fade is **additive** to the existing logic.

### 6. Dispose the texture correctly

In the module-scope texture singleton, add a hook so the texture lives for the lifetime of the app (no need to dispose per-effect). If the working session prefers per-instance disposal, that is fine too — just ensure no leaks when `setCarType` rebuilds. The existing `_disposeAll()` walks children and calls `material.dispose()`; `PointsMaterial` with a `map` does **not** dispose the texture automatically — note this if tests complain.

### 7. Run full test suite

```
npm test
```

All existing + new tests must pass. Count should remain 128+ (may change slightly if tube-specific tests were replaced).

### 8. Manual visual verification

```
npm run start
```

Open `http://localhost:3000/`. For each car (F1, F2, F3, GT):
- Idle (speed 0): no smoke visible, car is clean.
- Speed 100: sparse wispy puffs visible along streamline paths — no tubes.
- Speed 200: dense continuous smoke trails — clearly smoke-like, soft edges, Cp-colored (red at stagnation points, blue-green along flow).
- Speed 350: thick trails, larger puffs, strong pulsing.
- Toggle Airflow off: all smoke disappears with no leftover geometry.
- Switch between cars: smoke rebuilds correctly at new positions.
- Enable CFD mode: confirm CFD visualizations still work (they're a separate system, should be unaffected).
- Enable Wing Flip (stall): smoke should show disturbed flow over the rear wing as before.

Report back whether the visuals now look like smoke vs. previously-hard tubes.

## Acceptance Criteria

- [ ] All stream-tube geometry and references deleted.
- [ ] Smoke particles use a soft radial-gradient texture.
- [ ] Particles fade in/out over their life cycle (no hard pop-in, no dot artifacts).
- [ ] Cp coloring preserved — user can still read pressure from the smoke.
- [ ] At speed 200, trails look continuous, not dotty.
- [ ] At speed 0, no visible airflow.
- [ ] Works across F1 / F2 / F3 / GT.
- [ ] All tests pass.
- [ ] No memory leak when switching cars multiple times.

## Tuning Knobs

- **`SMOKE_PTS`** — particle count per streamline. Too low = gaps. Too high = FPS drop. Start at `140`; try `180` or `200` if still gappy.
- **Base `size`** in `PointsMaterial` — `0.18` starting value. Soft puffs need to overlap, so bigger than the old `0.10`. Try `0.14` for tighter, `0.24` for wispy.
- **Life duration** (`dt * 0.6`) — how long a puff lives before fading out. Lower = faster churn, more "alive" feel. Higher = slower drift. Try `0.4` for gusty, `0.8` for calm.
- **Gradient midpoint** (`0.4` stop in the canvas gradient) — controls softness. Lower (`0.2`) = harder core, higher (`0.6`) = wispier.

## Do Not

- Do not touch `airflow-core.js`.
- Do not modify `CAR_AERO` profile data.
- Do not change vortex / wake / pressure-orb / rain / weather systems.
- Do not introduce a shader or custom material — plain `PointsMaterial` with a texture is sufficient for Option B.
- Do not delete the particle jitter, yAcc vertical displacement, or vortex-coupled drift code — they contribute to physics realism.
- Do not refactor neighbouring unrelated systems.
- Do not commit unless the user explicitly asks.

## Report Back With

1. Test counts: `X passed / Y total` before and after.
2. List of files changed with one-line rationale each.
3. Any mock changes made to `effects.test.js`.
4. Approximate FPS difference observed (if any).
5. Anything that looked wrong during manual verification.
