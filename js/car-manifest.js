/**
 * car-manifest.js — Per-car GLB asset descriptors.
 *
 * All mesh name lists use EXACT node names from gltf-transform inspect output
 * (docs/f1-inspect.txt, docs/gt-inspect.txt) and per-mesh bbox data
 * (docs/f1-bboxes.json, docs/gt-bboxes.json).
 *
 * Exact matching is enforced in car-loader.js — no substring guessing.
 *
 * F1 (shunqi MCL39):
 *   Wheel nodes (Object_24–Object_34) are stripped; procedural wheels render instead.
 *   Object_28 = rear_wheel_cover (the "orphaned papaya cape" at Z≈+2.1) is stripped.
 *   Object_19 = main_body — primary livery paint surface.
 *
 * GT (TwiXeR 992 GT3 RS):
 *   No wheel nodes in the GLB; stripMeshes is empty.
 *   Largest body mesh carries PaletteMaterial001 (the main painted shell).
 */

export const CAR_MANIFEST = {
  f1: {
    url: new URL('../assets/models/f1.glb', import.meta.url).href,
    transform: { scale: 1.0, rotation: [0, Math.PI, 0], position: [0, 0, 0] },
    //
    // Wheel meshes (Object_24/25/26/27/29/33/34) are NOT stripped here —
    // buildWheelsFromGLB splits them into 4 per-corner groups and removes the
    // originals from the scene. Only the orphaned rear-wheel cape stays stripped.
    stripMeshes: [
      'Object_28',  // rear_wheel_cover  — orphaned cape (Z≈+2.1 after rotation)
    ],
    liveryMeshes: [
      'Object_19',  // main_body — primary papaya paint surface
      'Object_9',   // rear_wing — painted wing assembly
      'Object_12',  // front_wing — painted front wing
    ],
    //
    // Pre-strip tire measurement: these meshes define the ground-contact plane
    // and the front/rear axle positions. After measurement, buildWheelsFromGLB
    // (in car-loader.js) splits these merged meshes into per-corner fragments
    // and removes the originals from the scene.
    // Values derived from docs/f1-bboxes.json + rotation [0, π, 0]:
    //   Object_33 front_tire: world Y-min = -0.6187, world Z-center = -1.47
    //   Object_26 rear_tire:  world Y-min = -0.6232, world Z-center = +2.10
    wheelSources: {
      front: 'Object_33',
      rear:  'Object_26',
    },
    //
    // Per-feature anchor sources (measured in world-space pre-strip).
    // use: 'peak' takes bbox max.y; 'center' takes bbox center.y.
    // Consumed by airflow/CFD placement so visuals track the real GLB geometry
    // instead of halfH-fraction estimates.
    //   Object_22 halo         — peak Y ≈ 0.373
    //   Object_17 headrest     — used as cockpit anchor (top of seat/airbox region)
    //   Object_12 front_wing   — center Z ≈ -2.297 after rotation, peak Y just below nose
    //   Object_9  rear_wing    — center Z ≈ +2.412 after rotation, peak Y ≈ 0.454
    //   Object_19 main_body    — bodyShell bbox for sidepodTop/floor synthesis
    anchorSources: {
      halo:      { mesh: 'Object_22', use: 'peak'   },
      cockpit:   { mesh: 'Object_17', use: 'peak'   },
      frontWing: { mesh: 'Object_12', use: 'peak'   },
      rearWing:  { mesh: 'Object_9',  use: 'peak'   },
      bodyShell: { mesh: 'Object_19', use: 'center' },
    },
  },
  gt: {
    url: new URL('../assets/models/gt.glb', import.meta.url).href,
    transform: { scale: 1.0, rotation: [0, 0, 0], position: [0, 0, 0] },
    stripMeshes: [],  // no wheel meshes in this GLB
    liveryMeshes: [
      'TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_plastic_mgl_060606FF.001_0',  // main body shell
    ],
  },
};

export function getManifest(type) {
  return CAR_MANIFEST[type] ?? null;
}
