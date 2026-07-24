# Mobile Perf Audit — edu-and-backlog (P7)

Measured 2026-07-23 on the dev server (vite, port 3000), Chromium headless
SwiftShader, CDP `Emulation.setCPUThrottlingRate 4`, viewport **390×844**
(iPhone-class), F1 (GLB McLaren), **280 km/h with airflow + rain active**.
Script: ad-hoc Playwright run alongside `scripts/verify-edu-backlog.mjs`
(hooks: `__fsim.renderer`, `__fsim.rain`, `__fsim.vents`).

## Headline numbers

| Metric | Value | Notes |
|---|---|---|
| fps over 10 s | **2.27** | SwiftShader = software rasterizer; absolute fps is NOT representative of a mobile GPU. Treat as a relative budget baseline for this rig. |
| Draw calls / frame | **404–405** | Full composer frame (render + bloom + output passes), measured with `info.autoReset = false`. |
| Triangles / frame | **~491 k** | F1 GLB + split wheels + track ribbons/furniture + effects. |
| Geometries / textures / programs | 275 / 68 / 30 | `renderer.info.memory`, steady state. |
| devicePixelRatio | 1 (test rig) | `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` — **the cap from the plan is already in place** (`js/main.js` scene setup), so the "one free win" needs no change. |

## Bundle sizes (`npm run build`, vite 5)

| Asset | Size | Gzip |
|---|---|---|
| `assets/index-*.js` | 770.5 kB | 211.7 kB |
| `assets/index-*.css` | 14.4 kB | 3.3 kB |
| `assets/f1-*.glb` | 5 297 kB | — (draco-compressed already) |
| `assets/gt-*.glb` | 1 637 kB | — |
| PWA precache | 1 535 KiB (9 entries) | GLBs are NOT precached |

## INFO-mode hover raycast (GT mega-mesh)

- Target subset: 10 objects, **~268 k triangles** (dominated by the 224 k-vert
  bodyShell mega-mesh; wheels are a minor slice).
- Measured hover-handler cost under 4× throttle: **37–65 ms per cast** at 10 Hz.
- The plan's contingency ("drop wheels from targets if > 4 ms") does not apply:
  removing the wheels leaves > 200 k triangles in the mega-mesh, so it cannot
  reach the 4 ms target — and it would break the 'Tires' card. Cost is gated to
  `infoMode && pointermove` at 10 Hz, so it never taxes the render loop while
  INFO is off. Left as-is; see recommendation R4.

## Recommendations (NOT implemented — report only)

- **R1 — f1.glb is the mobile bottleneck (5.3 MB).** Recompress (meshopt or
  higher draco level) and/or serve a decimated mobile tier; it is the default
  car, fetched on first load.
- **R2 — 404 draw calls.** Track furniture rows and effect layers dominate;
  instance/merge repeated row geometry (cones, stripes, apron segments).
- **R3 — Bloom at full resolution.** UnrealBloomPass at 390×844×dpr is a large
  fullscreen cost on integrated GPUs; half-resolution bloom on small viewports
  would be invisible at these sizes.
- **R4 — GT hover raycast.** Adopt `three-mesh-bvh` for the occupancy subset
  (build once at spawn, reuse for CFD probe too) to bring the 40–65 ms cast to
  sub-millisecond.
- **R5 — GT occupancy voxelization (~3.5 s CPU)** is already deferred one rAF;
  moving `buildOccupancy` into a Web Worker would remove the visible stall on
  car switch entirely.
- **R6 — JS chunking.** 770 kB single chunk; splitting three.js addons +
  postprocessing into a lazy chunk trims first-paint JS on slow networks.
