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
- **Engine sound from the model** — pitch from real engine rpm through a per-car gearbox, load (on/off throttle), overrun crackle, turbo whistle on F1/F2, wind roar and tyre scrub
- **Rain intensity** — drizzle to storm: more streaks, darker light, less grip, aquaplaning at speed, lightning and thunder
- **Adaptive airflow** — in a corner the pressure paint differs left to right (the outside of the car meets faster air, and the flow yaw changes along its length), with a live L : R load split
- **Dirty air** — the car's wake as modelled pathlines: front-wing tip vortex and front-tyre wake pushed outboard, flow into the sidepods and under the rear wing, rear-tyre wake, diffuser core and rear-wing tip vortices rising behind the car; reacts to steering, tyre load, wing level and DRS
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
- `js/powertrain.js` — gearbox and engine speed (drives the gear readout and the engine sound)
- `js/weather.js` — rain intensity → lighting, lightning timing
- `js/flow-asymmetry.js` — cornering flow: speed gradient and yaw gradient across the car
- `js/wake-paths.js` / `js/wake-effect.js` — dirty-air pathline model and its particle layer
- `js/circuit.js` — closed-circuit geometry: curvature, elevation, racing line
- `js/lap-sim.js` — quasi-steady-state lap-time solver
- `js/circuit-hud.js` — minimap + lap timing
- `js/circuits/` — circuit data (see `assets/models/ATTRIBUTION.md`)
- `js/track-layout.js` — roadside rules: road width, kerbs, gravel, barriers, trees, scenery placement
- `js/main.js` — scene setup, state, UI wiring
- `assets/models/` — GLB car models (see ATTRIBUTION.md)
