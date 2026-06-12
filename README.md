# FormulaSim

Interactive 3D wind-tunnel simulator for racing cars — a cinematic, educational frontend experience built with Three.js.

**▶ Live simulator:** https://inonvv.github.io/formulaSim/

## Features

- **High-fidelity 3D cars** — GLB McLaren F1 and Porsche 992 GT3 RS GT, each with split spinning wheels and a fully procedural fallback
- **Speed-driven animation** — idle to 350 km/h with live wheel rotation and effect intensity
- **Airflow mode** — ribbon streamlines with RK4-traced paths around the real car body
- **Rain mode** — droplet streaks, rooster tails, wet-surface reflections
- **CFD mode** — pressure-coefficient (Cp) visualisation painted directly on the car body via vertex colors, with per-car Cp tables, zone blobs, and vortex cores
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
```

## Project layout

- `js/cars.js` — procedural car builders + GLB hybrid assembly
- `js/car-loader.js` — GLB loading, wheel splitting, anchor measurement
- `js/effects.js` — airflow and rain effects
- `js/cfd-effect.js` — CFD pressure visualisation
- `js/main.js` — scene setup, state, UI wiring
- `assets/models/` — GLB car models (see ATTRIBUTION.md)
