# Arcade Race Mode — Implementation Plan

Branch: `game-feature`. Goal: add an ARCADE RACE mode (move car left/right, catch
coins, 90 s timed run) alongside the untouched SIMULATE mode, plus a more
immersive horizon, within vanilla Three.js 0.163 / procedural-only / no new deps.

**Method: TDD.** Every phase writes failing tests FIRST, then implements until
green, then runs the FULL suite (`npm test`). Do not kill the dev server on
port 3000 (user session + background task).

## Core architecture decisions (load-bearing — do not deviate)

1. **Move the WORLD, not the car.** Car stays at origin (effects, CFD, camera
   rigs, occupancy SDF all assume it). Player lateral position `playerX` is
   applied as `trackGroup.position.x -= playerX` AFTER the existing
   `trackGroup.position.set(w.x, 0, w.z)` in main.js (~line 780). The inverse
   pose guarantees path tangent at car = world −z, so world +x ≡ right of road.
   Do NOT offset `skyline.group` (infinite-parallax by design).
2. **Coins live in trackGroup** in (s, lateralX) track space, using the existing
   `rowPose(path, s, lateralX)` + sliding pool machinery (track-path.js:265-297).
   MUST handle `path.epoch` rebase (every 1000 m) exactly like furniture rows.
   Coin world position then already includes −playerX → collision test is
   against origin.
3. **Mode is top-level state**: `state.mode = 'sim' | 'arcade'`. SIMULATE is the
   current app, behaviorally unchanged (guard every arcade feature behind mode
   checks; scene must always mirror state — core principle). Arcade game states:
   `menu → countdown → running → gameover → (restart → countdown)`.
4. New logic goes in **pure, testable modules**: `js/game-mode.js` (state
   machine + lateral physics), `js/coins.js` (patterns, pooling, collision,
   scoring). main.js only wires them. Frame-rate-independent smoothing
   everywhere: `1 − exp(−dt/tau)` (reuse `smoothAngle` from track-path.js where
   it fits), never bare per-frame lerp constants.

## Phase A — Mode + lateral control (executor run 1)

Tests first: `js/__tests__/game-mode.test.js` (mock three like other suites).

- `js/game-mode.js` exports:
  - `createGame()` → state machine with `start()`, `tick(dt)`, `collect()`,
    `reset()`; states as in decision 3; countdown 3-2-1 at 0.9 s per tick,
    "GO" holds 0.5 s; run timer 90 s → gameover.
  - `lateralStep(state, input, vFwd, dt)` — pure. Constants:
    - `vxMax = clamp(0.12 · vFwd, 3, 9)` m/s
    - one-pole lateral-velocity smoothing tau **0.12 s**
    - hard clamp `|playerX| ≤ 12`; soft zone `|x| > 10`: spring
      `a = −25·(|x|−10)` m/s² + expose `edgeRumble` 0..1 for shake/audio
    - returns `{ playerX, vx }`
  - Visual-tilt mapping helper: body roll toward strafe up to **7°** cap, nose
    yaw **4°** cap, front-wheel steer via existing steerVis path (pseudo-
    curvature from vx), smoothing tau **0.12 s**.
- main.js wiring:
  - Input: ArrowLeft/Right + A/D (hold = continuous strafe), pointer drag on
    canvas for touch. Only active in arcade running state.
  - World offset per decision 1. Camera juice: `camera.position.x += 0.25·playerX`
    smoothed tau 0.3 s, applied after existing per-mode camera logic (orbit
    excluded); do NOT put residual on carGroup.
  - Sign chain (pin in a test): world offset −playerX ⇒ apparent wind hits +x
    side when vx > 0 ⇒ (used in Phase C).
- UI: segmented toggle **SIMULATE | ARCADE** at top of panel (match existing
  design tokens / unified button system in css/styles.css; aria-pressed).
  Arcade collapses (not destroys) env/CFD sections; Reset returns to sim mode
  defaults. index.html + css/styles.css minimal additions.
- Verify: full `npm test` green; brief manual note of what was checked.

## Phase B — Coins, scoring, HUD, audio (executor run 2)

Tests first: `js/__tests__/coins.test.js`.

- `js/coins.js`:
  - Pattern generator in (s, lat) space, seeded/deterministic: straight runs of
    5–8 coins @ **5 m** spacing on one lateral; sine arcs sweeping **±6 m over
    50 m**; occasional 3-lane rows at lat **−5 / 0 / +5**. Spawn window
    **80–140 m ahead** (inside WINDOW_AHEAD 160). Pool + epoch rebase per
    decision 2.
  - Collision — **swept, not sphere** (at 80 m/s the car moves 1.3 m/frame;
    write the tunneling regression test): collect when `|latCoin − playerX| <
    1.7` AND coin's s crosses the car's s interval this frame (±1.5 m pad).
  - Magnet-lite: within **3.5 m** lateral+longitudinal, coin lerps toward car at
    **18 m/s**.
  - Scoring: `score = floor(distance_m) + 10·coins`; combo: pickups within a
    **2 s** window build streak; streak ≥ 8 → ×2 multiplier; reset after 2 s idle.
- Coin visual: gold emissive torus ~**1.0 m** diameter, hover y ~1.0, spin
  2.5 rad/s, bob ±0.1 m @ 1.5 Hz. Collection: scale pop 1→1.4→0 over 0.25 s,
  6–10 additive sparkle sprites (reuse rooster-tail/mist sprite pattern in
  effects.js), floating "+10" (HUD layer, not 3D text).
- Audio (extend js/engine-audio.js, reuse its AudioContext + setTargetAtTime
  zipper-noise rule): triangle osc pickup, exp decay 0.15 s, gain ~0.15, base
  **988 Hz**; +1 semitone per coin within combo window, cap +12; countdown ticks
  reuse shift-blip with rising pitch.
- HUD (index.html/css, hidden outside arcade): score top-center (rolling
  counter, 0.3 s lerp), coins+combo top-right, timer under score, existing
  speed readout stays bottom-right. Countdown overlay: scale 1.6→1.0 back-ease
  (overshoot ~1.12), fade last 0.2 s. Gameover: final score count-up 0.8 s +
  RESTART button.
- Verify: full `npm test` green.

## Phase C — Immersion + effect accuracy (executor run 3)

Tests first: extend `js/__tests__/game-mode.test.js` + `effects.test.js`
(remember: effects.test.js mocks airflow-core and needs sumVelocity +
venturiSpeedRatio + LineSegments in the mock).

- **Fog** (arcade only): `THREE.Fog(horizonColor, 90, 330)`; fog color MUST
  equal sky horizon color; far inside skyline R 350. Sim mode: untouched.
- **2nd parallax cylinder** at R ≈ **200** in buildSkyline: taller/darker
  silhouettes, integer-cycle sinusoids (seamless 360° wrap rule); per frame it
  gets rotY PLUS forward drift `v·dt/(2π·200)` rad; far cylinder keeps rotY
  only. That differential is the depth cue.
- **Rhythm objects**: roadside posts at x = **±13.5 m every 25 m** via the
  existing row-pool system; dashed lane paint period **8 m** on the road ribbon.
- **Dynamic FOV**: base 50° → **60°** scaled by sf², smoothing tau **0.45 s**;
  arcade only; update projection matrix only when |ΔFOV| > 0.05°.
- **Camera shake**: amplitude **0.006–0.012 m**, 2–3 summed sines **15–25 Hz**
  (use accumulated sim time, NOT Date.now), camera-local x/y only, gain sf²
  ramping in above sf 0.7, plus edgeRumble from Phase A (0.02–0.03 m @ ~28 Hz).
  Arcade only.
- **Effect crosswind** (apparent sideslip β = atan2(vx, vFwd), ~8.5° max):
  - airflow: `setCrosswind(-vx)` → uniform +x shear on ribbon vertices growing
    downstream `Δx = −vx·(η·L/v)`, applied at the same point pathBend is
    applied (air and road must not diverge). Do NOT re-trace streamlines.
  - rain: streaks get additive lateral velocity term **−vx** (distinct from the
    existing rainLateralAccel v·ω term). Rooster tails/splash: car-anchored →
    already correct, zero work.
  - CFD: rotate Newtonian flow dir (0,0,1) → (sinβ, 0, cosβ) in
    computeSurfaceCp's facing term ONLY when |β| > 5°, else skip.
  - Pin the sign chain in a unit test: vx > 0 ⇒ streaks/streamlines drift −x.
- Verify: full `npm test` green.

## Acceptance criteria (final gate, run by orchestrator)

1. Full suite green (`npm test`), including all pre-existing 714 tests.
2. Headless Playwright: sim mode renders identically-shaped scene (4 car
   buttons, effects toggles work); arcade toggle → countdown → running; strafe
   input changes trackGroup x-offset sign-correctly; driving through an
   authored coin increments the HUD counter; timer reaches 0 → gameover UI.
   (SwiftShader is ~15× slow — drive state via __fsim hooks, don't wall-wait.)
3. Sim mode behaviorally unchanged: no arcade code runs when mode === 'sim'.

## Executor ground rules

- Surgical diffs; match existing style (design tokens, __fsim hooks, module
  patterns). Extend `window.__fsim` with `{game, coins}` handles for verify
  scripts.
- Never `Date.now()` in sim logic — accumulate dt.
- Don't touch: WORKLOG.md, wing-stall remnants, anything F2/F3 unless required.
- Commit per phase with a "Phase X:" prefix message ending in the standard
  Co-Authored-By line.
