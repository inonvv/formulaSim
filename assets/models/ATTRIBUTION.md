# 3D Model Attribution

This project uses Creative Commons Attribution (CC-BY 4.0) licensed 3D models.
Required attribution below. If the runtime UI displays the cars, the attribution
line in `index.html` fulfills the visibility requirement of the license.

## F1 — McLaren MCL39 (2025)

- **Author:** shunqi
- **Source:** https://sketchfab.com/3d-models/f1-2025-mclaren-mcl39-c6194270002b401bb25be7e35ab56e34
- **License:** CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- **File (shipped):** `assets/models/f1.glb` — optimized via `gltf-transform optimize`
  (original 122 MB → 5.3 MB after Draco + WebP + decimation).

## GT — Porsche 911 GT3 RS

- **Author:** Black Snow (@BlackSnow02)
- **Source:** https://sketchfab.com/3d-models/porsche-gt3-rs-e738eae819c34d19a31dd066c45e0f3d
- **License:** CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- **File (shipped):** `assets/models/gt.glb` — optimized via `gltf-transform optimize`
  (original 19 MB → 1.6 MB).

## Attribution line for runtime UI

Add to `index.html` in a footer or info panel:

> 3D car models © shunqi, Black Snow — CC-BY 4.0

# Circuit data attribution

## Spa-Francorchamps centreline

- **Source:** TUMFTM racetrack-database, `tracks/Spa.csv`
  — https://github.com/TUMFTM/racetrack-database
- **Authors:** Institute of Automotive Technology, Technical University of Munich
- **License:** LGPL-3.0 — https://www.gnu.org/licenses/lgpl-3.0.html
- **File (shipped):** `js/circuits/spa-data.js` — the x/y centreline rounded to
  0.1 m (track-width columns reduced to their mean). The racing line used at
  runtime is computed from it by `js/circuit.js`.
- **Not from that dataset:** the elevation profile and corner names in the same
  file are hand-authored approximations, not survey data.
