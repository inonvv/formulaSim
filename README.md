# FormulaSim

Interactive 3D wind-tunnel simulator for racing cars — a cinematic, educational frontend experience built with Three.js.

**▶ Live simulator:** https://inonvv.github.io/formulaSim/

## Features

- **High-fidelity 3D cars** — GLB McLaren F1 and Porsche 992 GT3 RS GT, each with split spinning wheels and a fully procedural fallback
- **Speed-driven animation** — idle to 350 km/h with live wheel rotation and effect intensity
- **Airflow mode** — ribbon streamlines with RK4-traced paths around the real car body
- **Rain mode** — droplet streaks, rooster tails, wet-surface reflections
- **CFD mode** — pressure-coefficient (Cp) visualisation painted directly on the car body via vertex colors, with per-car Cp tables, zone blobs, and vortex cores
- **Computed vehicle model** — downforce and drag from ½ρv²·C·A, dynamic ride height, per-tyre loads under longitudinal and lateral weight transfer, tyre grip with load sensitivity, power- and drag-limited acceleration, and a driver that brakes for the corners ahead
- **Telemetry HUD** — downforce, drag, aero balance, ride height, g-g plot, four tyre-load bars coloured by grip used, throttle/brake, and the top speed of the current setup
- **Spa-Francorchamps** — the real 7.0 km layout (open centreline data), a computed minimum-curvature racing line, approximate elevation, a lap-time solver that predicts the ideal lap for the current car and setup, a driver that follows it, minimap, corner names and lap timing
- **Aero setup** — wing level, ride height, yaw (crosswind) and DRS; the numbers, the Cp paint and the streamlines all respond
- **Camera modes** — Orbit / Trackside / Cockpit / Drone

## Getting started

```bash
npm install
npm start        # dev server on http://localhost:3000
```

## Tests

```bash
npx vitest run                      # unit suite
node scripts/verify-gt-wheels.mjs   # headless GT wheel-split check on the real GLB
node scripts/verify-gt-visual.mjs   # Playwright browser smoke (needs npm start running)
node scripts/verify-vehicle-model.mjs  # vehicle model + telemetry + aero controls in a real browser (needs npm start running)
node scripts/verify-spa.mjs            # drives two laps of Spa in a real browser, compares with the ideal lap (several minutes)
```

## Project layout

- `js/cars.js` — procedural car builders + GLB hybrid assembly
- `js/car-loader.js` — GLB loading, wheel splitting, anchor measurement
- `js/effects.js` — airflow and rain effects
- `js/cfd-effect.js` — CFD pressure visualisation
- `js/vehicle-model.js` — pure vehicle physics (aero, wheel loads, grip, driver model)
- `js/telemetry-hud.js` — telemetry view-model + DOM mirror
- `js/circuit.js` — closed-circuit geometry: curvature, elevation, racing line
- `js/lap-sim.js` — quasi-steady-state lap-time solver
- `js/circuit-hud.js` — minimap + lap timing
- `js/circuits/` — circuit data (see `assets/models/ATTRIBUTION.md`)
- `js/track-layout.js` — roadside rules: road width, kerbs, gravel, barriers, trees, scenery placement
- `js/main.js` — scene setup, state, UI wiring
- `assets/models/` — GLB car models (see ATTRIBUTION.md)
