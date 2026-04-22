# Plan: Wheel Grounding Fix + Material / Lighting Calibration

## Background

Two related visual-quality issues observed in `images/observation-1.png` and `images/observation-2.png`:

1. **Wheels float above the tarmac** on all four car types. Root cause: `grp.position.y = wR + 0.34` in each car builder (`js/cars.js:624, 824, 988, 1199`). Formula lifts the car ~0.64m too high. Ground plane is at Y = −0.34 (`js/track.js:55`).

2. **Body and livery render as a neon-red glow** with blown-out specular highlights, loss of surface detail, and clipped whites on the nose/helmet. Root cause: a stack of high-intensity PBR inputs — `envMapIntensity: 3.0` on `makeBodyMat`, `scene.environmentIntensity = 1.5`, `clearcoat: 1.0` with `clearcoatRoughness: 0.01`, plus an emissive white stripe in `buildLivery` (emissiveIntensity 0.5) and relatively hot lights (ambient 2.8 / sun 4.5) with exposure 1.4. Each factor is reasonable on its own; stacked they exceed the renderer's headroom.

## Goal

Restore physically-grounded contact between the wheels and the tarmac, and calibrate materials + lighting so that:
- Red paint looks like painted carbon, not neon.
- Highlight ridges roll off instead of clipping to white.
- Panel lines, livery art, louvers, and front-wing detail remain readable.
- The scene still reads as bright outdoor daylight — **do not** push it into a dim interior look.

## Scope

**In scope**:
- `js/cars.js` — wheel grounding formula; `makeBodyMat` clearcoat / envMapIntensity / iridescence; emissive removal in `buildLivery` white-stripe branch.
- `js/main.js` — `scene.environmentIntensity`.
- `js/scene-config.js` — `EXPOSURE`, `BLOOM.threshold`.
- `js/__tests__/cars.test.js` — new wheel-grounding tests.
- `js/__tests__/scene-clarity.test.js` — update any threshold assertions affected.

**Out of scope**:
- `airflow-core.js`, `effects.js`, `cfd-effect.js`, `track.js`, `physics.js`.
- Smoke / rain / CFD / weather systems.
- Wheel internal geometry, livery geometry, car silhouettes.
- Post-processing pipeline structure (just bloom threshold, nothing else).

## Constraints

- **TDD required**: write failing tests first for every observable behavior change.
- All tests must remain green at the end. Current count is 136.
- `scene-config.js` has hard floors ("must be > N") for AMBIENT_INTENSITY, SUN_INTENSITY, EXPOSURE, and BLOOM.threshold. **Do not** go below those floors. EXPOSURE floor is 1.3. BLOOM.threshold floor is 0.7. Ambient must stay > 2.0, sun > 3.0.
- Do not disable bloom — just raise the threshold so only true emissives bloom.
- Do not remove `clearcoat` entirely from the body — just dial it back. Painted carbon has clearcoat.
- Do not commit unless the user explicitly asks.

## Implementation Steps

### Part A — Wheel grounding fix (TDD)

#### A.1 Write failing tests

In `js/__tests__/cars.test.js`, add a `describe('wheel grounding', ...)` block:

For each car (`buildF1`, `buildF2`, `buildF3`, `buildGT`):
- Call the builder with `{ color: 0xdd1111 }`.
- Traverse the returned group to find the 4 wheels by name (`wFL`, `wFR`, `wRL`, `wRR`). The car group's `position.y` is the lift; each wheel's `position.y` is its local offset.
- Determine the wheel radius from known constants (F1 0.345, F2 0.328, F3 0.300, GT 0.338) — hard-code them in the test file with a comment referencing the builder line.
- Assert: `group.position.y + wheel.position.y - wR === -0.34` within `1e-3` tolerance.

Run `npm test`. The 4 new tests **must fail** before you proceed.

#### A.2 Apply the fix

In each builder (F1, F2, F3, GT), replace:
```js
grp.position.y = wR + 0.34;
```
with:
```js
const GROUND_Y = -0.34;
grp.position.y = GROUND_Y + wR - wheelLocalY;  // wheelLocalY from wPos
```
Use `-0.04` for F1/F2/F3 (matches each car's `wPos`), and `-0.05` for GT.

For clarity, you may extract a small helper at the top of `cars.js`:
```js
const GROUND_Y = -0.34;
function liftForGround(wR, wheelLocalY) {
  return GROUND_Y + wR - wheelLocalY;
}
```
and call it in each builder. Optional — only if it stays readable.

#### A.3 Verify

`npm test` → 4 new tests now pass, all existing tests still pass.

Hard-refresh browser. Idle mode, orbit each car. Confirm wheels visibly touch the ground, no gap. Confirm body / floor / front wing do not clip through the tarmac, rumble strips (Y = −0.331), or the start-finish band (Y = −0.333) after the fix. If any body part now clips, report back — some car builders may have body Y offsets that assumed the floating lift.

### Part B — Material calibration (no TDD required for aesthetic numbers, but update any test thresholds that change)

Apply these one at a time and reload between each to confirm the direction is right. Do all six; if the scene looks too dim after B.6, pull back the single most-dimming change.

#### B.1 Reduce body clearcoat

In `js/cars.js`, `makeBodyMat`:
```js
clearcoat: 0.55,            // was 1.0
clearcoatRoughness: 0.15,   // was 0.01
```
Rationale: clearcoat 1.0 + roughness 0.01 = mirror highlights → clips to white. Realistic car paint is glossy but not mirror-smooth.

#### B.2 Reduce body envMapIntensity

Same function:
```js
envMapIntensity: 1.4,       // was 3.0
```
Rationale: 3.0 × scene.environmentIntensity 1.5 = 4.5 combined multiplier on environment reflections → dominates diffuse color.

#### B.3 Soften iridescence

Same function:
```js
iridescence: 0.08,          // was 0.2
```
Rationale: iridescence 0.2 adds rainbow sheen on top of already-saturated red — contributes to the "neon" look.

#### B.4 Remove emissive white stripe in `buildLivery`

In `buildLivery` around line 323 (`js/cars.js`), the F1 branch has:
```js
emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.5,
clearcoat: 1.0, clearcoatRoughness: 0.01,
```
Set `emissiveIntensity: 0` and `clearcoat: 0.55`. Keep the white color as-is. (Livery stripes should reflect light, not emit it.)

#### B.5 Lower scene environmentIntensity

In `js/main.js:43`:
```js
scene.environmentIntensity = 1.0;   // was 1.5
```

#### B.6 Tighten bloom threshold + drop exposure to floor

In `js/scene-config.js`:
```js
export const EXPOSURE = 1.3;         // was 1.4 — sits at the documented floor
export const BLOOM = {
  strength:  0.28,
  radius:    0.08,
  threshold: 1.05,                   // was 0.85 — only real emissives bloom now
};
```
`WEATHER.default.exposure` also uses `EXPOSURE` so it updates automatically. `WEATHER.rain.exposure: 1.0` and `WEATHER.optimal.exposure: 1.6` remain untouched.

Update the scene-clarity test if it asserts a specific threshold — the "must be > 0.7" invariant is still satisfied.

### Part C — Verify

1. `npm test` → all tests green (136 + 4 new wheel-grounding = 140).
2. Hard-refresh browser.
3. For each car at idle and at speed 200:
   - Red livery reads as painted carbon, not neon.
   - Highlight streaks along the body have a rolloff, not a clipped-white band.
   - Helmet highlight visible but not blown out.
   - Front-wing flaps / slats readable as distinct surfaces.
   - Panel lines and livery stripes visible.
   - Track still reads as bright daylight (sky blue, bright asphalt, crisp rumble strips).
4. If any step fails the "bright daylight" check, the most likely culprit is B.5 or B.6 — roll back `environmentIntensity` to `1.2` before touching exposure.
5. Take a new screenshot at the same angle as `observation-1.png` and report back.

## Acceptance Criteria

- [ ] All 4 cars' wheels touch the tarmac at idle — no visible gap, no sinking.
- [ ] Test suite: 140 passing (136 existing + 4 new wheel-grounding).
- [ ] Red body no longer appears self-illuminated.
- [ ] White stripes and helmet no longer clip to solid white.
- [ ] Scene still reads as bright outdoor daylight.
- [ ] Panel details and livery art are readable.
- [ ] Bloom still visible on brake glow / headlights / cockpit screens (if any).

## Tuning Knobs (if the calibration pass overshoots)

- If body now looks **flat and dull**: raise `envMapIntensity` 1.4 → 1.8, or raise `clearcoat` 0.55 → 0.70.
- If scene feels **dark overall**: raise `scene.environmentIntensity` 1.0 → 1.2. Do **not** touch ambient/sun intensities — they are locked by scene-config invariants.
- If highlights **still clip**: lower `EXPOSURE` to its floor (1.3) if not already there, and raise `BLOOM.threshold` to 1.20.
- If red looks **too dim / chalky**: raise `envMapIntensity` 1.4 → 1.6 (not clearcoat — clearcoat tuning is for highlight sharpness, not saturation).

## Do Not

- Do not lower ambient intensity below 2.0 or sun below 3.0 (scene-config invariant).
- Do not disable shadows, tone mapping, or bloom as a shortcut.
- Do not delete `iridescence` / `sheen` — they add depth to the finish; just lower intensity.
- Do not adjust track, environment, effects, or physics.
- Do not commit unless the user explicitly asks.

## Report Back With

1. Test count before → after.
2. Files changed with one-line rationale each.
3. New screenshot from the same angle as `observation-1.png` after fixes.
4. Any visual regression noticed in other car types (e.g. F3 white livery, GT livery) — white / black paint responds differently to the same material change, so spot-check all four.
5. Any value you ended up tuning off my recommended numbers, and why.
