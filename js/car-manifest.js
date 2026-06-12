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
 *   No NAMED wheel nodes — the four wheels are connected-geometry islands
 *   baked into the 224k-vert mega-mesh (PaletteMaterial001, also the livery
 *   surface). `wheelBake` drives buildWheelsFromMonolith (car-loader.js):
 *   a connectivity split that extracts them into spinnable corner groups.
 *   Empirical (draco decode + union-find, car-local post-rotation): tires at
 *   (±0.77, 0.30, −1.17 front / +1.29 rear), radius 0.39 m, width 0.33 m,
 *   wheelbase 2.46 m (992 spec: 2.457).
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

      // ── Vent / duct anchors (Phase A) ────────────────────────────
      // Each entry is one of:
      //   { mesh, use }                          → bbox-derived (above)
      //   { anchor, offset, direction, role }    → offset relative to another anchor
      //   { mirrored: '<key>' }                  → auto-mirror the named entry (X, dir.x negated)
      // role: 'inlet' | 'outlet' — consumed by VentEmitterSystem.
      // Offsets authored in car-local space; measurement runs post-rotation,
      // so offsets compose directly with the anchor's car-local position.
      sidepodInletL:   { anchor: 'bodyShell', offset: [-0.70,  0.00, -0.40], direction: [ 0.25,  0, -1], role: 'inlet'  },
      sidepodInletR:   { mirrored: 'sidepodInletL' },
      sidepodExhaustL: { anchor: 'bodyShell', offset: [-0.60,  0.05,  1.20], direction: [-0.10,  0,  1], role: 'outlet' },
      sidepodExhaustR: { mirrored: 'sidepodExhaustL' },
      airboxIntake:    { anchor: 'halo',      offset: [ 0.00,  0.30, -0.20], direction: [ 0,   -0.3, -1], role: 'inlet'  },
      exhaustPipe:     { anchor: 'rearWing',  offset: [ 0.00, -0.30, -0.15], direction: [ 0,    0.1,  1], role: 'outlet' },
      frontBrakeDuctL: { anchor: 'frontWing', offset: [-0.45,  0.15,  0.10], direction: [ 0.10, 0, -1], role: 'inlet' },
      frontBrakeDuctR: { mirrored: 'frontBrakeDuctL' },
      rearBrakeDuctL:  { anchor: 'rearWing',  offset: [-0.90,  0.30, -0.40], direction: [ 0.10, 0, -1], role: 'inlet' },
      rearBrakeDuctR:  { mirrored: 'rearBrakeDuctL' },
    },
    // Extra collision meshes for the body-occupancy SDF (streamline/smoke
    // deflection) beyond the anchorSources body roles. Per docs/f1-bboxes.json:
    // Object_20 = mirror, Object_6 = suspensions.
    occupancyMeshes: ['Object_20', 'Object_6'],
  },
  gt: {
    url: new URL('../assets/models/gt.glb', import.meta.url).href,
    // GT GLB is authored nose-at-+Z (headlight_L_led at z=+1.63). Rotate π
    // around Y to match the project convention (nose at -Z).
    transform: { scale: 1.0, rotation: [0, Math.PI, 0], position: [0, 0, 0] },
    // Nothing to strip: there are no separately-named wheel meshes, and
    // body_gt3rs_plastic.002_0 (once wrongly stripped as "baked wheels")
    // is window/trim geometry at y ∈ [0.50, 1.02] that must stay visible.
    stripMeshes: [],
    liveryMeshes: [
      'TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_plastic_mgl_060606FF.001_0',  // main body shell
    ],
    // Connectivity wheel split (buildWheelsFromMonolith). Wheel positions,
    // radius, and width are MEASURED from the GLB's tire islands at load
    // time; the constants below are classification thresholds and sanity
    // bounds only. All metric (not vertex-count-based) — robust to draco
    // decoder reordering.
    wheelBake: {
      mesh: 'TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_plastic_mgl_060606FF.001_0',
      maxComponentDim: 1.0,        // m — tire islands are ~[0.33, 0.78, 0.78]
      groundEpsilon: 0.02,         // m — tires are the only islands at scene-min Y
      axisTolerance: 0.10,         // m — centroid (y,z) distance to axle for rims/hubs
      minOutboardX: 0.5,           // m — wheel parts live outboard of |x| 0.5
      expectedTires: 4,
      wheelbaseSpec: 2.457,        // m — 992 GT3 RS, sanity bound for measurement
      wheelbaseTol: 0.15,
      maxStraddleDropRatio: 0.005, // connectivity masks can't straddle; guard anyway
      spokeFaceDepth: 0.06,        // m — spokes live within this depth of the rim face
      spokeMaxRadiusRatio: 0.92,   // spoke bbox must fit radially inside the rim
    },
    // Measured feature anchors — same machinery as F1 (car-loader
    // measureAnchors). For GT these are measured POST wheel-split so the
    // bodyShell bbox excludes the tires (its floor is the body underside,
    // not the contact patch). Mesh names are AUTHORED glTF names; runtime
    // matching bridges GLTFLoader's name sanitization.
    //   carbon_roof — roof skin, peak y ≈ 1.29 (halo/roofline anchor)
    //   roof_alc    — headliner/cabin trim, centre ≈ driver-head region
    anchorSources: {
      halo:      { mesh: 'TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_carbon_roof.001_0', use: 'peak'   },
      cockpit:   { mesh: 'TwiXeR_992_body_gt3rs_TwiXeR_992_roof_alc.001_0',           use: 'center' },
      bodyShell: { mesh: 'TwiXeR_992_gt3rs_carbon_Wing_TwiXeR_992_plastic_mgl_060606FF.001_0', use: 'center' },

      // ── 992 GT3 RS vent layout (role-tagged, consumed by airflow
      //     modifiers + VentEmitterSystem). Offsets in car-local space
      //     relative to the measured anchor. Inlet directions point
      //     upstream (suction axis), outlets point along the exhaust flow.
      frontIntake:  { anchor: 'bodyShell', offset: [ 0.00, -0.30, -2.10], direction: [ 0,    0,   -1], role: 'inlet'  },
      engineIntake: { anchor: 'halo',      offset: [ 0.00, -0.25,  1.45], direction: [ 0,   -0.4, -1], role: 'inlet'  },
      exhaustPipe:  { anchor: 'bodyShell', offset: [ 0.00, -0.45,  2.15], direction: [ 0,   -0.1,  1], role: 'outlet' },
      fenderVentL:  { anchor: 'bodyShell', offset: [-0.78, -0.05, -1.10], direction: [-0.3,  1,    0], role: 'outlet' },
      fenderVentR:  { mirrored: 'fenderVentL' },
    },
    // Extra collision meshes for the body-occupancy SDF: windows, doors and
    // hood complete the closed-body canopy on top of the (wheel-less)
    // mega-mesh + roof measured via anchorSources.
    occupancyMeshes: [
      'TwiXeR_992_gt3rs_sideskirts_L_TwiXeR_992_glass.002_0',
      'TwiXeR_992_gt3rs_door_L_TwiXeR_992_rubbertrim.004_0',
      'TwiXeR_992_gt3rs_carbon_hood_TwiXeR_992_metal_radiator.002_0',
    ],
  },
};

export function getManifest(type) {
  return CAR_MANIFEST[type] ?? null;
}
