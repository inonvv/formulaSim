import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import {
  sliceGeometryByPredicate,
  computeConnectedComponents,
  summarizeComponents,
} from './geometry-split.js';

const _loader = new GLTFLoader();
const _draco  = new DRACOLoader();
_draco.setDecoderPath('/draco/');
_loader.setDRACOLoader(_draco);

/**
 * Load a GLB car body.
 * Returns { scene, wheels, liveryMeshes } on success, or null on any failure.
 * Never rejects — callers should fall back to the procedural builder when null.
 *
 * loadCarFromManifest(manifest) wraps this with manifest-driven classification:
 *   strips GLB wheels, collects livery meshes, resolves rear-wing node, applies transform.
 */
export async function loadCarModel(url) {
  try {
    const gltf = await _loader.loadAsync(url);
    const scene = gltf.scene;
    const wheels       = [];
    const liveryMeshes = [];

    scene.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow    = true;
      child.receiveShadow = true;
      if (child.name.startsWith('wheel_'))  wheels.push(child);
      if (child.name.startsWith('livery_')) liveryMeshes.push(child);
    });

    return { scene, wheels, liveryMeshes };
  } catch (err) {
    console.warn('[car-loader] falling back to procedural:', url, err.message);
    return null;
  }
}

/* Mirror THREE.PropertyBinding.sanitizeNodeName — GLTFLoader applies it to
 * every node name, stripping [ ] . : / and replacing whitespace with _.
 * Manifests keep the AUTHORED glTF names (matching gltf-transform inspect
 * output), so every name comparison must bridge the sanitization:
 * 'plastic_mgl_060606FF.001_0' (authored) === 'plastic_mgl_060606FF001_0'
 * (what the loaded Object3D is actually called). */
function sanitizeGlbName(name) {
  return String(name).replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');
}

function glbNameMatches(a, b) {
  return a === b || sanitizeGlbName(a) === sanitizeGlbName(b);
}

/* Name-based lookup that works on both real Object3D and test fakes. */
function findByName(root, name) {
  let found = null;
  root.traverse(node => { if (!found && glbNameMatches(node.name ?? '', name)) found = node; });
  return found;
}

/**
 * Measure tire bboxes in world-space to derive groundContactY + axle X/Z.
 * Must be called BEFORE stripMeshes removes the tire nodes from the scene.
 * World-space is correct here because scene.rotation/position/scale have already
 * been applied and updateMatrixWorld propagates those through the bbox.
 *
 * @returns {{ groundContactY, frontAxleZ, rearAxleZ, frontAxleX, rearAxleX }}
 * @throws if a named source mesh is not found
 */
function measureTires(scene, wheelSources) {
  const frontTire = findByName(scene, wheelSources.front);
  const rearTire  = findByName(scene, wheelSources.rear);
  if (!frontTire) throw new Error(`[car-loader] wheelSources.front "${wheelSources.front}" not found in scene`);
  if (!rearTire)  throw new Error(`[car-loader] wheelSources.rear "${wheelSources.rear}" not found in scene`);

  scene.updateMatrixWorld?.(true);
  frontTire.updateMatrixWorld?.(true);
  rearTire.updateMatrixWorld?.(true);

  const ftBB = new THREE.Box3().setFromObject(frontTire);
  const rtBB = new THREE.Box3().setFromObject(rearTire);
  const ftC  = ftBB.getCenter(new THREE.Vector3());
  const rtC  = rtBB.getCenter(new THREE.Vector3());

  // Wheel radius = half the tire Y-extent (tire stands upright, Y spans the diameter).
  // Average front/rear tire heights to avoid asymmetric noise.
  const ftH = ftBB.max.y - ftBB.min.y;
  const rtH = rtBB.max.y - rtBB.min.y;
  const wheelRadius = 0.25 * (ftH + rtH);

  return {
    groundContactY: Math.min(ftBB.min.y, rtBB.min.y),
    frontAxleZ:     ftC.z,
    rearAxleZ:      rtC.z,
    frontAxleX:     Math.abs(ftC.x),
    rearAxleX:      Math.abs(rtC.x),
    wheelRadius,
  };
}

/**
 * Measure per-feature anchor points from named GLB meshes in world-space.
 * Each anchor returns { x, y, z, bbox: {minY,maxY,minZ,maxZ} }.
 *   use: 'peak'   → y = bbox.max.y (highest point of the feature)
 *   use: 'center' → y = bbox center.y
 * Runs AFTER scene.rotation/position/scale are applied (same pre-strip phase as measureTires).
 *
 * From the measured bbox of each anchor we also synthesise sidepodTop and floor:
 *   sidepodTop.y = bodyShell top Y minus 20% of shell height
 *   floor.y      = bodyShell bottom Y plus  10% of shell height
 * Only emitted when bodyShell is present.
 */
function measureAnchors(scene, anchorSources) {
  if (!anchorSources) return null;
  scene.updateMatrixWorld?.(true);
  const anchors = {};

  // Pass 1: bbox-derived entries (original behaviour).
  for (const [key, src] of Object.entries(anchorSources)) {
    if (!src.mesh) continue;   // anchor-relative or mirrored — handled in later passes
    const node = findByName(scene, src.mesh);
    if (!node) continue;
    node.updateMatrixWorld?.(true);
    const bb = new THREE.Box3().setFromObject(node);
    const c  = bb.getCenter(new THREE.Vector3());
    anchors[key] = {
      x: c.x,
      y: src.use === 'peak' ? bb.max.y : c.y,
      z: c.z,
      bbox: {
        minX: bb.min.x, maxX: bb.max.x,
        minY: bb.min.y, maxY: bb.max.y,
        minZ: bb.min.z, maxZ: bb.max.z,
      },
    };
  }

  const bs = anchors.bodyShell;
  if (bs) {
    const h = bs.bbox.maxY - bs.bbox.minY;
    anchors.sidepodTop = { x: 0, y: bs.bbox.maxY - h * 0.20, z: bs.z };
    anchors.floor      = { x: 0, y: bs.bbox.minY + h * 0.10, z: bs.z };
  }

  // Pass 2: anchor-relative entries (authored vent offsets).
  // Computed after pass 1 so `src.anchor` resolves to a measured position.
  for (const [key, src] of Object.entries(anchorSources)) {
    if (!src.anchor || !src.offset) continue;
    const base = anchors[src.anchor];
    if (!base) continue;   // source anchor missing (mesh not in GLB) — skip gracefully
    const [ox, oy, oz] = src.offset;
    const entry = { x: base.x + ox, y: base.y + oy, z: base.z + oz };
    if (src.direction) {
      entry.direction = _normalizedVec3(src.direction);
    }
    if (src.role) entry.role = src.role;
    anchors[key] = entry;
  }

  // Pass 3: mirrored entries — negate X and direction.x.
  for (const [key, src] of Object.entries(anchorSources)) {
    if (!src.mirrored) continue;
    const source = anchors[src.mirrored];
    if (!source) continue;
    const entry = { x: -source.x, y: source.y, z: source.z };
    if (source.direction) {
      entry.direction = new THREE.Vector3(-source.direction.x, source.direction.y, source.direction.z);
    }
    if (source.role) entry.role = source.role;
    anchors[key] = entry;
  }

  return anchors;
}

/**
 * Normalise a [dx, dy, dz] array into a THREE.Vector3 (unit length).
 * Zero vectors return (0,0,0) unchanged to avoid NaN.
 */
function _normalizedVec3([x, y, z]) {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-9) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(x / len, y / len, z / len);
}

/* ── Wheel split config ──────────────────────────────────────────────
 * Source mesh names → split mode.
 *   'x'   → 2-way by world-X sign (front_tire / rear_tire / front_cover)
 *   'xz'  → 4-way by (X sign, Z sign) (rim / nut / screws)
 * The 'side' flag on 'x' sources tells us which half of the car the whole
 * mesh lives on ('front' → both fragments land at front axle Z, etc.).
 */
const WHEEL_SPLIT_CONFIG = {
  Object_33: { mode: 'x',  side: 'front' },   // front_tire        — merged L+R fronts
  Object_26: { mode: 'x',  side: 'rear'  },   // rear_tire         — merged L+R rears
  Object_34: { mode: 'x',  side: 'front' },   // front_wheel_cover — merged L+R fronts
  Object_27: { mode: 'xz' },                  // wheel_rim         — all 4 corners
  Object_29: { mode: 'xz' },                  // wheel_nut         — all 4 corners
  Object_24: { mode: 'xz' },                  // wheel_screw.001   — all 4 corners
  Object_25: { mode: 'xz' },                  // wheel_screw       — all 4 corners
};

/**
 * Split merged GLB wheel meshes (front_tire / rear_tire / wheel_rim / wheel_nut /
 * wheel_screws / front_wheel_cover) into 4 per-corner wheel groups FL/FR/RL/RR.
 *
 * Implementation:
 *   1. For each source mesh listed in WHEEL_SPLIT_CONFIG that exists in `scene`,
 *      clone its geometry and apply its world matrix so vertex positions are
 *      in car-local (scene-world) coordinates.
 *   2. Run `sliceGeometryByPredicate` per corner. Predicates use world X sign
 *      for 'x' mode and (X sign, Z sign) for 'xz' mode; 4-way splits use the
 *      midpoint of measured front/rear axle Z as the Z-split plane.
 *   3. Translate each fragment's geometry so its bbox center sits at (0,0,0).
 *      Wrap in a Mesh with the SHARED (un-cloned) source material.
 *   4. Attach the mesh to the corresponding corner Group, which is positioned
 *      at the bbox center in car-local space (= fragment's axle point).
 *   5. Remove the source meshes from the scene so they don't double-render.
 *
 * Returns { wheelsRoot, wheels: { FL, FR, RL, RR }, debug: { counts } }.
 * `debug.counts` maps corner → { <srcName>: { fragmentVertCount, sourceVertCount } }
 * so callers (and tests) can verify no > 5% vertex loss per corner.
 */
export function buildWheelsFromGLB(scene, measure) {
  if (!scene || !measure) return null;

  scene.updateMatrixWorld?.(true);

  // Z-plane between front and rear axles — splits rim/nut/screws into F vs R halves.
  // In car-local post-rotation space: frontAxleZ ≈ -1.47, rearAxleZ ≈ +2.10.
  const zMid = 0.5 * (measure.frontAxleZ + measure.rearAxleZ);
  const wheelY = measure.groundContactY + measure.wheelRadius;

  const wheels = {
    FL: new THREE.Group(),
    FR: new THREE.Group(),
    RL: new THREE.Group(),
    RR: new THREE.Group(),
  };
  wheels.FL.name = 'FL';
  wheels.FR.name = 'FR';
  wheels.RL.name = 'RL';
  wheels.RR.name = 'RR';

  const wheelsRoot = new THREE.Group();
  wheelsRoot.name = 'wheelsRoot';
  wheelsRoot.add(wheels.FL, wheels.FR, wheels.RL, wheels.RR);

  const debug = { counts: { FL: {}, FR: {}, RL: {}, RR: {} } };
  const toRemove = [];

  for (const [srcName, cfg] of Object.entries(WHEEL_SPLIT_CONFIG)) {
    const srcMesh = findByName(scene, srcName);
    if (!srcMesh || !srcMesh.geometry || !srcMesh.geometry.attributes?.position) {
      continue;   // source absent or geometry-less (test stub) — skip quietly
    }
    srcMesh.updateMatrixWorld?.(true);

    // Clone geometry and bake the source's world matrix so split predicates
    // can work in world / car-local coordinates instead of mesh-local ones.
    const worldGeo = srcMesh.geometry.clone();
    if (srcMesh.matrixWorld && worldGeo.applyMatrix4) {
      worldGeo.applyMatrix4(srcMesh.matrixWorld);
    }

    const srcVertCount = worldGeo.attributes.position.count;

    // Build the per-corner predicates this source contributes to.
    const cornerPreds = [];
    if (cfg.mode === 'x') {
      // 2-way: whole mesh is on front or rear. Just split by X sign.
      const z = cfg.side === 'front' ? measure.frontAxleZ : measure.rearAxleZ;
      const xFront = measure.frontAxleX;
      const xRear  = measure.rearAxleX;
      const ax = cfg.side === 'front' ? xFront : xRear;
      if (cfg.side === 'front') {
        cornerPreds.push({ corner: 'FL', axle: { x: -ax, z }, pred: (x) => x < 0 });
        cornerPreds.push({ corner: 'FR', axle: { x:  ax, z }, pred: (x) => x > 0 });
      } else {
        cornerPreds.push({ corner: 'RL', axle: { x: -ax, z }, pred: (x) => x < 0 });
        cornerPreds.push({ corner: 'RR', axle: { x:  ax, z }, pred: (x) => x > 0 });
      }
    } else {
      // 4-way: X sign + Z sign (front = Z < zMid, rear = Z > zMid in car-local).
      // With frontAxleZ ≈ -1.47 and rearAxleZ ≈ +2.10, zMid ≈ +0.315; front halves
      // have Z < zMid and rear halves have Z > zMid.
      cornerPreds.push({
        corner: 'FL',
        axle: { x: -measure.frontAxleX, z: measure.frontAxleZ },
        pred: (x, _y, z) => x < 0 && z < zMid,
      });
      cornerPreds.push({
        corner: 'FR',
        axle: { x:  measure.frontAxleX, z: measure.frontAxleZ },
        pred: (x, _y, z) => x > 0 && z < zMid,
      });
      cornerPreds.push({
        corner: 'RL',
        axle: { x: -measure.rearAxleX, z: measure.rearAxleZ },
        pred: (x, _y, z) => x < 0 && z > zMid,
      });
      cornerPreds.push({
        corner: 'RR',
        axle: { x:  measure.rearAxleX, z: measure.rearAxleZ },
        pred: (x, _y, z) => x > 0 && z > zMid,
      });
    }

    for (const { corner, axle, pred } of cornerPreds) {
      const fragGeo = sliceGeometryByPredicate(worldGeo, pred);
      const fragVertCount = fragGeo.attributes.position?.count ?? 0;
      debug.counts[corner][srcName] = { fragmentVertCount: fragVertCount, sourceVertCount: srcVertCount };
      if (fragVertCount === 0) continue;

      // Translate fragment geometry so its bbox center lies at the corner's
      // axle point — subtracting (axle.x, wheelY, axle.z) in world/car-local.
      // This way the fragment mesh sits at (0,0,0) inside a group whose
      // .position is the axle; rotating the group around X spins the wheel
      // in place around its own axle.
      if (fragGeo.translate) {
        fragGeo.translate(-axle.x, -wheelY, -axle.z);
      }

      const mesh = new THREE.Mesh(fragGeo, srcMesh.material);
      mesh.name = `${srcName}_${corner}`;
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      wheels[corner].add(mesh);
    }

    // Position the corner groups — shared across all 4 sources; last write wins
    // but they all map the same corner → same axle, so no conflict.
    wheels.FL.position.set(-measure.frontAxleX, wheelY, measure.frontAxleZ);
    wheels.FR.position.set( measure.frontAxleX, wheelY, measure.frontAxleZ);
    wheels.RL.position.set(-measure.rearAxleX,  wheelY, measure.rearAxleZ);
    wheels.RR.position.set( measure.rearAxleX,  wheelY, measure.rearAxleZ);

    toRemove.push(srcMesh);
  }

  // Strip the originals from the scene so they don't double-render alongside
  // the new per-corner fragments. Skip gracefully when parent.remove is absent
  // (some test stubs don't implement it).
  for (const m of toRemove) {
    m.parent?.remove?.(m);
  }

  return { wheelsRoot, wheels, debug };
}

/* ── Monolith wheel split (GT path) ──────────────────────────────────────
 * gt.glb has no named wheel meshes — the four wheels are connected-geometry
 * islands baked into one 224k-vert mega-mesh. The split therefore keys on
 * CONNECTIVITY (union-find over the index buffer), not on mesh names.
 */

const MONOLITH_CORNERS = ['FL', 'FR', 'RL', 'RR'];

/**
 * Classify component summaries (from summarizeComponents) into per-corner
 * wheel parts. Pure — operates on plain summary objects, in car-local space.
 *
 * Tires: compact components (every bbox dim < cfg.maxComponentDim) whose
 *   bbox floor reaches below sceneMinY + cfg.groundEpsilon. The tires are the
 *   only ground-reaching compact islands in gt.glb (verified empirically).
 * Wheel parts: any component whose centroid lies within cfg.axisTolerance of
 *   a wheel axis center in the (y,z) plane, on the same side of the car
 *   (|centroid.x| > cfg.minOutboardX, matching x sign). Axis-centered parts
 *   (rims, hubs, discs) spin correctly by construction; off-axis arch liners
 *   and flaps fail the (y,z) distance test and stay with the body.
 *
 * Returns null (→ caller falls back to procedural) when the GLB doesn't
 * match expectations: ≠ cfg.expectedTires tires, a corner missing/duplicated,
 * or measured wheelbase outside cfg.wheelbaseSpec ± cfg.wheelbaseTol.
 */
export function classifyWheelComponents(summaries, cfg) {
  if (!Array.isArray(summaries) || summaries.length === 0) return null;

  let sceneMinY = Infinity;
  for (const s of summaries) if (s.min[1] < sceneMinY) sceneMinY = s.min[1];

  const tires = [];
  for (const s of summaries) {
    const dx = s.max[0] - s.min[0];
    const dy = s.max[1] - s.min[1];
    const dz = s.max[2] - s.min[2];
    const compact = dx < cfg.maxComponentDim && dy < cfg.maxComponentDim && dz < cfg.maxComponentDim;
    if (compact && s.min[1] < sceneMinY + cfg.groundEpsilon) tires.push(s);
  }
  if (tires.length !== cfg.expectedTires) {
    console.warn(`[car-loader] wheelBake: found ${tires.length} tire islands, expected ${cfg.expectedTires}`);
    return null;
  }

  // Corner assignment: front = z below the mean tire z; left = x < 0.
  let zSum = 0;
  for (const t of tires) zSum += (t.min[2] + t.max[2]) / 2;
  const zMid = zSum / tires.length;

  const corners = {};
  for (const t of tires) {
    const cx = (t.min[0] + t.max[0]) / 2;
    const cy = (t.min[1] + t.max[1]) / 2;
    const cz = (t.min[2] + t.max[2]) / 2;
    const corner = `${cz < zMid ? 'F' : 'R'}${cx < 0 ? 'L' : 'R'}`;
    if (corners[corner]) {
      console.warn(`[car-loader] wheelBake: duplicate tire island for corner ${corner}`);
      return null;
    }
    corners[corner] = {
      center: { x: cx, y: cy, z: cz },
      radius: (t.max[1] - t.min[1]) / 2,
      width:  t.max[0] - t.min[0],
      componentIds: new Set([t.id]),
      tireMinY: t.min[1],
    };
  }
  if (MONOLITH_CORNERS.some(c => !corners[c])) return null;

  const wheelbase = Math.abs(
    (corners.RL.center.z + corners.RR.center.z) / 2 -
    (corners.FL.center.z + corners.FR.center.z) / 2
  );
  if (Math.abs(wheelbase - cfg.wheelbaseSpec) > cfg.wheelbaseTol) {
    console.warn(`[car-loader] wheelBake: wheelbase ${wheelbase.toFixed(3)} outside spec ${cfg.wheelbaseSpec} ± ${cfg.wheelbaseTol}`);
    return null;
  }

  // Adopt axis-centered components (rims, hubs, brake discs) into corners.
  const wheelComponentToCorner = new Map();
  for (const s of summaries) {
    const [sx, sy, sz] = s.centroid;
    if (Math.abs(sx) < cfg.minOutboardX) continue;
    for (const corner of MONOLITH_CORNERS) {
      const c = corners[corner].center;
      if (Math.sign(sx) !== Math.sign(c.x)) continue;
      const dy = sy - c.y;
      const dz = sz - c.z;
      if (dy * dy + dz * dz < cfg.axisTolerance * cfg.axisTolerance) {
        corners[corner].componentIds.add(s.id);
        wheelComponentToCorner.set(s.id, corner);
        break;
      }
    }
  }

  // Second pass — SPOKES. Each spoke is its own island whose centroid sits
  // mid-radius (≈0.20 m off-axis in gt.glb — fails axisTolerance), so the
  // first pass leaves them in the body and the visible wheel face doesn't
  // spin. Spokes are distinguished from the (equally off-axis) caliper by
  // the OUTBOARD RIM-FACE PLANE: spokes live at the face (|x| within
  // spokeFaceDepth of the furthest adopted component), calipers hang
  // inboard. Radial containment inside the rim rejects arch lips that touch
  // the face plane.
  const spokeFaceDepth = cfg.spokeFaceDepth ?? 0.06;
  const spokeMaxR      = cfg.spokeMaxRadiusRatio ?? 0.92;
  const faceX = {};
  for (const corner of MONOLITH_CORNERS) faceX[corner] = Math.abs(corners[corner].center.x);
  for (const [id, corner] of wheelComponentToCorner) {
    const ax = Math.abs(summaries[id].centroid[0]);
    if (ax > faceX[corner]) faceX[corner] = ax;
  }
  for (const s of summaries) {
    if (wheelComponentToCorner.has(s.id)) continue;
    const sx = s.centroid[0];
    if (Math.abs(sx) < cfg.minOutboardX) continue;
    if (s.max[0] - s.min[0] > 0.15) continue;        // no long axial parts
    for (const corner of MONOLITH_CORNERS) {
      const c = corners[corner];
      if (Math.sign(sx) !== Math.sign(c.center.x)) continue;
      if (Math.abs(sx) < faceX[corner] - spokeFaceDepth) continue;
      // Whole bbox must sit radially inside the rim around this axle.
      const rMax = Math.max(
        Math.hypot(s.min[1] - c.center.y, s.min[2] - c.center.z),
        Math.hypot(s.min[1] - c.center.y, s.max[2] - c.center.z),
        Math.hypot(s.max[1] - c.center.y, s.min[2] - c.center.z),
        Math.hypot(s.max[1] - c.center.y, s.max[2] - c.center.z),
      );
      if (rMax > c.radius * spokeMaxR) continue;
      c.componentIds.add(s.id);
      wheelComponentToCorner.set(s.id, corner);
      break;
    }
  }

  const measure = {
    groundContactY: Math.min(...MONOLITH_CORNERS.map(c => corners[c].tireMinY)),
    frontAxleZ: (corners.FL.center.z + corners.FR.center.z) / 2,
    rearAxleZ:  (corners.RL.center.z + corners.RR.center.z) / 2,
    frontAxleX: (Math.abs(corners.FL.center.x) + Math.abs(corners.FR.center.x)) / 2,
    rearAxleX:  (Math.abs(corners.RL.center.x) + Math.abs(corners.RR.center.x)) / 2,
    wheelRadius: MONOLITH_CORNERS.reduce((a, c) => a + corners[c].radius, 0) / 4,
    wheelWidth:  MONOLITH_CORNERS.reduce((a, c) => a + corners[c].width, 0) / 4,
  };

  return { corners, measure, wheelComponentToCorner };
}

/**
 * Split baked wheels out of a monolithic GLB mesh into 4 spinnable corner
 * groups — the F1 buildWheelsFromGLB contract, driven by connectivity.
 *
 *   1. Clone the source geometry, bake matrixWorld → car-local coords.
 *   2. ONE union-find pass shares component labels between classification
 *      and slicing (index-mask predicates via sliceGeometryByPredicate's
 *      4th argument).
 *   3. Wheel fragments are recentered on the MEASURED wheel center so
 *      group.rotation.x spins in place; fragments share the source material
 *      (built pre-livery, so they keep the untinted palette material).
 *   4. The body remainder is sliced from the ORIGINAL local-space geometry
 *      with the same index mask (clone preserves vertex order) and assigned
 *      in place — the mesh keeps its name/transform/material so livery
 *      traversal still finds it.
 *
 * Connectivity masks cannot produce straddling triangles (a triangle's three
 * vertices always share one component), so triangle conservation is asserted
 * and any drop above cfg.maxStraddleDropRatio aborts to the fallback.
 *
 * Returns null on any guard failure — caller falls back to procedural.
 */
export function buildWheelsFromMonolith(scene, wheelBake) {
  if (!scene || typeof scene.traverse !== 'function' || !wheelBake?.mesh) return null;
  const srcMesh = findByName(scene, wheelBake.mesh);
  if (!srcMesh?.isMesh || !srcMesh.geometry?.attributes?.position) return null;

  const t0 = performance.now();
  scene.updateMatrixWorld?.(true);
  srcMesh.updateMatrixWorld?.(true);

  const srcGeo = srcMesh.geometry;
  if (srcGeo.groups?.length > 1) {
    console.warn('[car-loader] wheelBake source mesh has multiple geometry groups — slicer drops groups');
  }

  const worldGeo = srcGeo.clone();
  if (srcMesh.matrixWorld && worldGeo.applyMatrix4) {
    worldGeo.applyMatrix4(srcMesh.matrixWorld);
  }

  const vertexCount = worldGeo.attributes.position.count;
  // The index mask is reused across worldGeo and srcGeo — requires clone()
  // to preserve vertex order/count (true for BufferGeometry, assert anyway).
  if (vertexCount !== srcGeo.attributes.position.count) {
    worldGeo.dispose?.();
    return null;
  }

  let indexArr;
  if (worldGeo.index) {
    indexArr = worldGeo.index.array;
  } else {
    indexArr = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indexArr[i] = i;
  }

  const { labels, count } = computeConnectedComponents(indexArr, vertexCount);
  const summaries = summarizeComponents(worldGeo.attributes.position.array, labels, count);
  const cls = classifyWheelComponents(summaries, wheelBake);
  if (!cls) {
    worldGeo.dispose?.();
    return null;
  }

  // Per-vertex corner mask: -1 = body, 0..3 = FL/FR/RL/RR.
  const compCorner = new Int8Array(count).fill(-1);
  for (const [id, corner] of cls.wheelComponentToCorner) {
    compCorner[id] = MONOLITH_CORNERS.indexOf(corner);
  }
  const cornerOf = new Int8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) cornerOf[v] = compCorner[labels[v]];

  const wheels = {};
  const wheelsRoot = new THREE.Group();
  wheelsRoot.name = 'wheelsRoot';
  const debug = { counts: {}, droppedTris: 0, splitMs: 0 };

  let wheelTris = 0;
  for (let ci = 0; ci < MONOLITH_CORNERS.length; ci++) {
    const corner = MONOLITH_CORNERS[ci];
    const group = new THREE.Group();
    group.name = corner;

    const fragGeo = sliceGeometryByPredicate(worldGeo, (_x, _y, _z, v) => cornerOf[v] === ci);
    const c = cls.corners[corner].center;
    fragGeo.translate?.(-c.x, -c.y, -c.z);

    const mesh = new THREE.Mesh(fragGeo, srcMesh.material);
    mesh.name = `${srcMesh.name}_${corner}`;
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    group.position.set(c.x, c.y, c.z);

    wheelTris += (fragGeo.index?.count ?? 0) / 3;
    debug.counts[corner] = {
      fragmentVertCount: fragGeo.attributes.position?.count ?? 0,
      sourceVertCount: vertexCount,
    };
    wheels[corner] = group;
    wheelsRoot.add(group);
  }

  // Body remainder from the ORIGINAL local-space geometry, same index mask.
  const remainderGeo = sliceGeometryByPredicate(srcGeo, (_x, _y, _z, v) => cornerOf[v] === -1);
  const srcTris = indexArr.length / 3;
  const remTris = (remainderGeo.index?.count ?? 0) / 3;
  debug.droppedTris = srcTris - wheelTris - remTris;
  if (debug.droppedTris / srcTris > wheelBake.maxStraddleDropRatio) {
    console.warn(`[car-loader] wheelBake: ${debug.droppedTris}/${srcTris} triangles dropped — exceeds cap, falling back`);
    worldGeo.dispose?.();
    remainderGeo.dispose?.();
    return null;
  }

  srcGeo.dispose?.();
  srcMesh.geometry = remainderGeo;
  worldGeo.dispose?.();

  debug.splitMs = performance.now() - t0;
  return { wheelsRoot, wheels, measure: { ...cls.measure }, debug };
}

/**
 * Collect the meshes that define a car's collision envelope for the
 * body-occupancy SDF: the anchorSources body roles (bodyShell, halo,
 * frontWing, rearWing, cockpit) plus the manifest's `occupancyMeshes`
 * extras. Name matching bridges GLTFLoader sanitization.
 * Returns [] when the manifest has no anchorSources (procedural cars).
 */
const OCCUPANCY_ANCHOR_ROLES = ['bodyShell', 'halo', 'frontWing', 'rearWing', 'cockpit'];

export function collectOccupancyMeshes(root, manifest) {
  if (!root || typeof root.traverse !== 'function') return [];
  if (!manifest?.anchorSources) return [];

  const wanted = [];
  for (const role of OCCUPANCY_ANCHOR_ROLES) {
    const src = manifest.anchorSources[role];
    if (src?.mesh) wanted.push(src.mesh);
  }
  wanted.push(...(manifest.occupancyMeshes || []));

  const meshes = [];
  root.traverse(obj => {
    if (obj.isMesh && wanted.some(n => glbNameMatches(n, obj.name || ''))) meshes.push(obj);
  });
  return meshes;
}

/**
 * Manifest-aware GLB loader.
 * @param {object} manifest  — entry from CAR_MANIFEST (not a type string).
 * @returns {{ scene, liveryMeshes, glbMeasure, wheelsRoot } | null}
 *   glbMeasure is null when manifest.wheelSources is not set.
 *   wheelsRoot is null when no merged-wheel meshes are present (procedural path).
 */
export async function loadCarFromManifest(manifest) {
  const loaded = await loadCarModel(manifest.url);
  if (!loaded) return null;

  const { scene } = loaded;
  const { transform, stripMeshes, liveryMeshes: livSubs, wheelSources } = manifest;

  scene.scale.setScalar(transform.scale);
  scene.rotation.set(...transform.rotation);
  scene.position.set(...transform.position);

  // Measure BEFORE stripping — wheel source meshes must still be in the scene graph.
  let glbMeasure = wheelSources ? measureTires(scene, wheelSources) : null;
  const anchors  = measureAnchors(scene, manifest.anchorSources);
  if (glbMeasure && anchors) glbMeasure.anchors = anchors;

  // Split the merged GLB wheel meshes into 4 per-corner groups BEFORE the
  // strip pass runs — buildWheelsFromGLB removes the originals from the
  // scene itself, so the remaining strip list only handles orphans like
  // Object_28 (rear-wheel cape) that aren't wheels at all.
  //
  // Monolith path (manifest.wheelBake): the GLB has no named wheel meshes;
  // wheels are connectivity islands inside one mega-mesh. The split also
  // produces the measurement (there are no name-addressable tires to
  // measure first), so glbMeasure is assigned from its result. Runs before
  // the strip/livery traversal so the geometry-replaced body mesh is still
  // collected as a livery mesh.
  let wheelsRoot = null;
  if (glbMeasure && manifest.buildWheels !== false) {
    const built = buildWheelsFromGLB(scene, glbMeasure);
    wheelsRoot = built?.wheelsRoot ?? null;
    if (built) glbMeasure.wheelDebug = built.debug;
  } else if (manifest.wheelBake && manifest.buildWheels !== false) {
    const built = buildWheelsFromMonolith(scene, manifest.wheelBake);
    if (built) {
      wheelsRoot = built.wheelsRoot;
      glbMeasure = built.measure;
      glbMeasure.wheelDebug = built.debug;
      // Re-measure anchors AFTER the wheel split: the monolith's geometry is
      // now the wheel-less body remainder, so bodyShell-derived anchors
      // (floor, sidepodTop, vent offsets) read the body underside instead of
      // the tire contact patch. Falls back to the pre-split pass when the
      // post-split measurement comes up empty.
      const postAnchors = measureAnchors(scene, manifest.anchorSources);
      glbMeasure.anchors = postAnchors || anchors || undefined;
    }
  }

  const toStrip      = [];
  const liveryMeshes = [];

  scene.traverse((child) => {
    if (!child.isMesh) return;
    const name = child.name || '';
    if (stripMeshes.some(s => glbNameMatches(s, name))) toStrip.push(child);
    if (livSubs.some(s => glbNameMatches(s, name)))     liveryMeshes.push(child);
  });

  toStrip.forEach(m => m.parent?.remove(m));

  return { scene, liveryMeshes, glbMeasure, wheelsRoot };
}
