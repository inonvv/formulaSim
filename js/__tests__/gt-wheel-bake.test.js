/**
 * gt-wheel-bake.test.js — GT baked-wheel extraction from the monolithic GLB mesh.
 *
 * gt.glb has no named wheel meshes: the four wheels are connected-geometry
 * islands inside the 224k-vert mega-mesh. This suite covers the F1-style
 * pipeline adapted to that case:
 *
 *   CL    classifyWheelComponents — pure tire/wheel-part classification over
 *         component summaries (empirical numbers from docs analysis).
 *   WM    buildWheelsFromMonolith — connectivity split into FL/FR/RL/RR
 *         corner groups + in-place body remainder.
 *   LM-GT loadCarFromManifest wiring via manifest.wheelBake.
 *
 * Real THREE + real slicer; only the GLTF/DRACO addons are mocked (pattern
 * from mclaren-wheels.test.js).
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  classifyWheelComponents,
  buildWheelsFromMonolith,
  loadCarFromManifest,
  collectOccupancyMeshes,
} from '../car-loader.js';

const holder = vi.hoisted(() => ({ gltf: null }));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setDRACOLoader() {}
    async loadAsync() {
      if (!holder.gltf) throw new Error('no gltf fixture set');
      return holder.gltf;
    }
  },
}));
vi.mock('three/addons/loaders/DRACOLoader.js', () => ({
  DRACOLoader: class { setDecoderPath() {} },
}));

/* ── Empirical GT constants (car-local, post-rotation [0,π,0]) ──────────
 * Measured from gt.glb via draco decode + union-find connectivity:
 * tires (±0.77, 0.30, −1.17 front / +1.29 rear), radius 0.39, width 0.33,
 * tire bottoms at y ≈ −0.09, wheelbase 2.46.
 */
const GT = {
  frontZ: -1.17,
  rearZ:   1.29,
  axleX:   0.77,
  centerY: 0.30,
  radius:  0.39,
  width:   0.33,
};

const WHEEL_BAKE_CFG = {
  mesh: 'monolith',
  maxComponentDim: 1.0,
  groundEpsilon: 0.02,
  axisTolerance: 0.10,
  minOutboardX: 0.5,
  expectedTires: 4,
  wheelbaseSpec: 2.457,
  wheelbaseTol: 0.15,
  maxStraddleDropRatio: 0.005,
};

/* ── Summary fixtures for CL tests (shape of summarizeComponents output) ── */
function tireSummary(sx, z, { y = GT.centerY, r = GT.radius, w = GT.width } = {}) {
  const x = sx * GT.axleX;
  return {
    id: -1, vertCount: 6280,
    min: [x - w / 2, y - r, z - r],
    max: [x + w / 2, y + r, z + r],
    centroid: [x, y, z],
  };
}
function rimSummary(sx, z) {
  const x = sx * 0.92;
  return {
    id: -1, vertCount: 735,
    min: [x - 0.025, GT.centerY - 0.315, z - 0.32],
    max: [x + 0.025, GT.centerY + 0.315, z + 0.32],
    centroid: [x, GT.centerY, z],
  };
}
function hubSummary(sx, z) {
  const x = sx * 0.88;
  return {
    id: -1, vertCount: 524,
    min: [x - 0.035, GT.centerY - 0.12, z - 0.13],
    max: [x + 0.035, GT.centerY + 0.14, z + 0.13],
    centroid: [x, GT.centerY + 0.01, z],
  };
}
/** Off-axis arch-liner plate — 0.20 m behind the axle in Z. Must NOT spin. */
function linerSummary(sx, axleZ) {
  const x = sx * 0.78;
  const z = axleZ - 0.20;
  return {
    id: -1, vertCount: 800,
    min: [x - 0.085, GT.centerY - 0.185, z - 0.04],
    max: [x + 0.085, GT.centerY + 0.185, z + 0.04],
    centroid: [x, GT.centerY, z],
  };
}
function bodySummary() {
  return {
    id: -1, vertCount: 150000,
    min: [-0.95, 0.10, -2.20],
    max: [ 0.95, 1.32,  2.10],
    centroid: [0, 0.6, -0.05],
  };
}

/** Assign sequential ids and return the summaries array. */
function withIds(summaries) {
  summaries.forEach((s, i) => { s.id = i; });
  return summaries;
}

function standardSummaries() {
  return withIds([
    bodySummary(),
    tireSummary(-1, GT.frontZ), tireSummary(1, GT.frontZ),
    tireSummary(-1, GT.rearZ),  tireSummary(1, GT.rearZ),
    rimSummary(-1, GT.frontZ),  rimSummary(1, GT.frontZ),
    rimSummary(-1, GT.rearZ),   rimSummary(1, GT.rearZ),
    hubSummary(-1, GT.frontZ),  hubSummary(1, GT.frontZ),
    hubSummary(-1, GT.rearZ),   hubSummary(1, GT.rearZ),
    linerSummary(1, GT.frontZ), linerSummary(-1, GT.rearZ),
  ]);
}

describe('classifyWheelComponents', () => {
  it('CL1. finds exactly the 4 tires (compact + ground-reaching)', () => {
    const cls = classifyWheelComponents(standardSummaries(), WHEEL_BAKE_CFG);
    expect(cls).not.toBeNull();
    const corners = Object.keys(cls.corners).sort();
    expect(corners).toEqual(['FL', 'FR', 'RL', 'RR']);
  });

  it('CL2. derives per-corner centers, radius and width from tire bboxes', () => {
    const cls = classifyWheelComponents(standardSummaries(), WHEEL_BAKE_CFG);
    expect(cls.corners.FL.center.x).toBeCloseTo(-GT.axleX, 2);
    expect(cls.corners.FL.center.y).toBeCloseTo(GT.centerY, 2);
    expect(cls.corners.FL.center.z).toBeCloseTo(GT.frontZ, 2);
    expect(cls.corners.RR.center.z).toBeCloseTo(GT.rearZ, 2);
    expect(cls.corners.FL.radius).toBeCloseTo(GT.radius, 2);
    expect(cls.corners.FL.width).toBeCloseTo(GT.width, 2);
    expect(cls.measure.wheelRadius).toBeCloseTo(GT.radius, 2);
    expect(cls.measure.groundContactY).toBeCloseTo(GT.centerY - GT.radius, 2);
    expect(cls.measure.frontAxleZ).toBeCloseTo(GT.frontZ, 2);
    expect(cls.measure.rearAxleZ).toBeCloseTo(GT.rearZ, 2);
    expect(cls.measure.frontAxleX).toBeCloseTo(GT.axleX, 2);
    expect(cls.measure.rearAxleX).toBeCloseTo(GT.axleX, 2);
  });

  it('CL3. adopts axis-centered rim/hub components into the same corner', () => {
    const summaries = standardSummaries();
    const cls = classifyWheelComponents(summaries, WHEEL_BAKE_CFG);
    // FL corner: tire id 1, rim id 5, hub id 9 (per standardSummaries order).
    expect(cls.wheelComponentToCorner.get(1)).toBe('FL');
    expect(cls.wheelComponentToCorner.get(5)).toBe('FL');
    expect(cls.wheelComponentToCorner.get(9)).toBe('FL');
    expect(cls.wheelComponentToCorner.get(2)).toBe('FR');
    expect(cls.wheelComponentToCorner.get(4)).toBe('RR');
  });

  it('CL4. rejects off-axis liner plates (0.20 m off the axle in z)', () => {
    const summaries = standardSummaries();
    const cls = classifyWheelComponents(summaries, WHEEL_BAKE_CFG);
    // Liners are ids 13 (front-right) and 14 (rear-left).
    expect(cls.wheelComponentToCorner.has(13)).toBe(false);
    expect(cls.wheelComponentToCorner.has(14)).toBe(false);
    // Body never adopted either.
    expect(cls.wheelComponentToCorner.has(0)).toBe(false);
  });

  it('CL7. SPOKES adopted: off-axis small components at the outboard rim face spin', () => {
    // Real gt.glb data: ~12 spokes per wheel, each ~39 verts, centroid at
    // radial distance ~0.196 from the axle (> axisTolerance 0.10) but ON
    // the outboard rim-face plane |x| ≈ 0.91 (rim face centroid 0.93).
    const spokes = [];
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const sy = GT.centerY + Math.cos(ang) * 0.196;
      const sz = GT.frontZ + Math.sin(ang) * 0.196;
      spokes.push({
        id: -1, vertCount: 39,
        min: [-0.935, sy - 0.06, sz - 0.06],
        max: [-0.885, sy + 0.06, sz + 0.06],
        centroid: [-0.91, sy, sz],
      });
    }
    const summaries = withIds([...standardSummaries(), ...spokes]);
    const cls = classifyWheelComponents(summaries, WHEEL_BAKE_CFG);
    expect(cls).not.toBeNull();
    const spokeIds = summaries.slice(-12).map(s => s.id);
    for (const id of spokeIds) {
      expect(cls.wheelComponentToCorner.get(id), `spoke ${id}`).toBe('FL');
    }
  });

  it('CL8. CALIPER stays static: off-axis cluster INBOARD of the rim face', () => {
    // Real gt.glb data: caliper assembly at centroid |x| 0.80 (rim face at
    // 0.93), z offset +0.21 behind the axle, dAxis ≈ 0.21.
    const caliper = {
      id: -1, vertCount: 758,
      min: [-0.885, GT.centerY - 0.185, GT.frontZ + 0.17],
      max: [-0.715, GT.centerY + 0.185, GT.frontZ + 0.25],
      centroid: [-0.80, GT.centerY, GT.frontZ + 0.21],
    };
    const summaries = withIds([...standardSummaries(), caliper]);
    const cls = classifyWheelComponents(summaries, WHEEL_BAKE_CFG);
    expect(cls.wheelComponentToCorner.has(summaries[summaries.length - 1].id)).toBe(false);
  });

  it('CL5. ≠4 tire candidates → null (drives procedural fallback)', () => {
    const three = withIds([
      bodySummary(),
      tireSummary(-1, GT.frontZ), tireSummary(1, GT.frontZ),
      tireSummary(-1, GT.rearZ),
    ]);
    expect(classifyWheelComponents(three, WHEEL_BAKE_CFG)).toBeNull();

    const five = withIds([
      bodySummary(),
      tireSummary(-1, GT.frontZ), tireSummary(1, GT.frontZ),
      tireSummary(-1, GT.rearZ),  tireSummary(1, GT.rearZ),
      tireSummary(1, 0.0),   // phantom fifth ground-reaching compact island
    ]);
    expect(classifyWheelComponents(five, WHEEL_BAKE_CFG)).toBeNull();
  });

  it('CL6. wheelbase outside spec ± tolerance → null', () => {
    const squeezed = withIds([
      bodySummary(),
      tireSummary(-1, -0.8), tireSummary(1, -0.8),
      tireSummary(-1,  0.8), tireSummary(1,  0.8),   // wheelbase 1.6 ≪ 2.457
    ]);
    expect(classifyWheelComponents(squeezed, WHEEL_BAKE_CFG)).toBeNull();
  });
});

/* ── Synthetic monolith fixture for WM/LM tests ──────────────────────────
 * Built in GLB-NATIVE coordinates (nose +Z) so the [0,π,0] rotation path is
 * exercised: native (x,z) → car-local (−x,−z). Native tire centers:
 * front z = +1.17, rear z = −1.29.
 */
function pushTube(buf, cx, cy, cz, r, w, segments = 24) {
  const first = buf.positions.length / 3;
  for (const sx of [-1, 1]) {
    const x = cx + sx * w / 2;
    for (let i = 0; i < segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      buf.positions.push(x, cy + r * Math.cos(th), cz + r * Math.sin(th));
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = first + i;
    const b = first + ((i + 1) % segments);
    const c = first + segments + i;
    const d = first + segments + ((i + 1) % segments);
    buf.indices.push(a, b, c,  b, d, c);
  }
  return first;
}
function pushDisc(buf, cx, cy, cz, r, segments = 16) {
  const first = buf.positions.length / 3;
  buf.positions.push(cx, cy, cz);   // center
  for (let i = 0; i < segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    buf.positions.push(cx, cy + r * Math.cos(th), cz + r * Math.sin(th));
  }
  for (let i = 0; i < segments; i++) {
    buf.indices.push(first, first + 1 + i, first + 1 + ((i + 1) % segments));
  }
  return first;
}
/** Thin plate (2 tris) spanning [w, h, d] around its center. */
function pushPlate(buf, cx, cy, cz, w, h, d) {
  const first = buf.positions.length / 3;
  buf.positions.push(
    cx - w / 2, cy - h / 2, cz - d / 2,
    cx + w / 2, cy - h / 2, cz + d / 2,
    cx + w / 2, cy + h / 2, cz - d / 2,
    cx - w / 2, cy + h / 2, cz + d / 2,
  );
  buf.indices.push(first, first + 1, first + 2,  first, first + 2, first + 3);
  return first;
}

const NATIVE = { frontZ: 1.17, rearZ: -1.29 };   // pre-rotation

function buildMonolithGeo() {
  const buf = { positions: [], indices: [] };
  const marks = {};
  // Body slab — large, min y 0.10, never reaches ground.
  marks.body = pushPlate(buf, 0, 0.71, -0.05, 1.8, 1.22, 4.3);
  // 4 tires (compact tubes reaching y = centerY − r = −0.09).
  marks.tireFL = pushTube(buf,  GT.axleX, GT.centerY, NATIVE.frontZ, GT.radius, GT.width); // native +x → FL after flip
  marks.tireFR = pushTube(buf, -GT.axleX, GT.centerY, NATIVE.frontZ, GT.radius, GT.width);
  marks.tireRL = pushTube(buf,  GT.axleX, GT.centerY, NATIVE.rearZ,  GT.radius, GT.width);
  marks.tireRR = pushTube(buf, -GT.axleX, GT.centerY, NATIVE.rearZ,  GT.radius, GT.width);
  // 4 rim discs — outboard faces, axis-centered.
  marks.rimFL = pushDisc(buf,  0.92, GT.centerY, NATIVE.frontZ, 0.31);
  marks.rimFR = pushDisc(buf, -0.92, GT.centerY, NATIVE.frontZ, 0.31);
  marks.rimRL = pushDisc(buf,  0.92, GT.centerY, NATIVE.rearZ,  0.31);
  marks.rimRR = pushDisc(buf, -0.92, GT.centerY, NATIVE.rearZ,  0.31);
  // 2 off-axis liner plates (0.20 m off the axle in z) — must stay static.
  marks.linerF = pushPlate(buf, 0.78, GT.centerY, NATIVE.frontZ - 0.20, 0.17, 0.37, 0.08);
  marks.linerR = pushPlate(buf, -0.78, GT.centerY, NATIVE.rearZ - 0.20, 0.17, 0.37, 0.08);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.positions), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array(buf.indices), 1));
  return { geo, marks, totalTris: buf.indices.length / 3 };
}

/** Native-frame scene rotated [0,π,0] like the GT manifest transform. */
function buildMonolithScene() {
  const { geo, marks, totalTris } = buildMonolithGeo();
  const material = new THREE.MeshStandardMaterial({ name: 'palette' });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'monolith';
  const scene = new THREE.Group();
  scene.rotation.set(0, Math.PI, 0);
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  return { scene, mesh, material, marks, totalTris };
}

describe('buildWheelsFromMonolith', () => {
  it('WM1. returns wheelsRoot with exactly FL/FR/RL/RR', () => {
    const { scene } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    expect(built).not.toBeNull();
    const names = built.wheelsRoot.children.map(g => g.name).sort();
    expect(names).toEqual(['FL', 'FR', 'RL', 'RR']);
  });

  it('WM2. corner groups positioned at MEASURED wheel centers (car-local)', () => {
    const { scene } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    const { FL, FR, RL, RR } = built.wheels;
    expect(FL.position.x).toBeCloseTo(-GT.axleX, 2);
    expect(FL.position.z).toBeCloseTo(GT.frontZ, 2);
    expect(FR.position.x).toBeCloseTo(GT.axleX, 2);
    expect(RL.position.z).toBeCloseTo(GT.rearZ, 2);
    expect(RR.position.x).toBeCloseTo(GT.axleX, 2);
    // y = measured wheel center (0.30), NOT a bbox.min heuristic.
    for (const g of [FL, FR, RL, RR]) expect(g.position.y).toBeCloseTo(GT.centerY, 2);
  });

  it('WM3. fragment geometry recentered — bbox center ≈ origin', () => {
    const { scene } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      const mesh = built.wheels[c].children[0];
      expect(mesh).toBeDefined();
      const bb = new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position);
      const ctr = bb.getCenter(new THREE.Vector3());
      expect(Math.abs(ctr.x)).toBeLessThan(0.03);
      expect(Math.abs(ctr.y)).toBeLessThan(0.03);
      expect(Math.abs(ctr.z)).toBeLessThan(0.03);
    }
  });

  it('WM4. rims spin with their corner; off-axis liners stay in the body', () => {
    const { scene, mesh } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    // Each corner fragment must contain tire tube + rim disc:
    // 48 tube verts + 17 disc verts = 65.
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      const frag = built.wheels[c].children[0];
      expect(frag.geometry.attributes.position.count).toBe(65);
    }
    // Remainder keeps body plate (4) + two liner plates (4+4) = 12 verts.
    expect(mesh.geometry.attributes.position.count).toBe(12);
  });

  it('WM5. fragments share the source material instance (not a clone)', () => {
    const { scene, material } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      expect(built.wheels[c].children[0].material).toBe(material);
    }
  });

  it('WM6. source mesh stays in scene, geometry replaced by wheel-less remainder', () => {
    const { scene, mesh } = buildMonolithScene();
    const before = mesh.geometry.attributes.position.count;
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    expect(built).not.toBeNull();
    expect(mesh.parent).toBe(scene);
    expect(mesh.name).toBe('monolith');
    const after = mesh.geometry.attributes.position.count;
    expect(after).toBeLessThan(before);
    // No remaining vertex anywhere near the ground (tires were the only
    // ground-reaching geometry).
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeGreaterThan(0.0);
    }
  });

  it('WM7. triangle conservation — corners + remainder = source, zero drops', () => {
    const { scene, mesh, totalTris } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    let cornerTris = 0;
    for (const c of ['FL', 'FR', 'RL', 'RR']) {
      cornerTris += built.wheels[c].children[0].geometry.index.count / 3;
    }
    const remTris = mesh.geometry.index.count / 3;
    expect(cornerTris + remTris).toBe(totalTris);
    expect(built.debug.droppedTris).toBe(0);
  });

  it('WM8. measure matches measureTires shape with monolith-derived values', () => {
    const { scene } = buildMonolithScene();
    const built = buildWheelsFromMonolith(scene, WHEEL_BAKE_CFG);
    const m = built.measure;
    expect(m.wheelRadius).toBeCloseTo(GT.radius, 2);
    expect(m.wheelWidth).toBeCloseTo(GT.width, 2);
    expect(m.groundContactY).toBeCloseTo(GT.centerY - GT.radius, 2);
    expect(m.frontAxleZ).toBeCloseTo(GT.frontZ, 2);
    expect(m.rearAxleZ).toBeCloseTo(GT.rearZ, 2);
    expect(m.frontAxleX).toBeCloseTo(GT.axleX, 2);
    expect(m.rearAxleX).toBeCloseTo(GT.axleX, 2);
    expect(Math.abs(m.rearAxleZ - m.frontAxleZ)).toBeCloseTo(2.46, 2);
    expect(built.debug.counts).toBeDefined();
  });

  it('WM10. matches THREE-sanitized mesh names (GLTFLoader strips [].:/ from node names)', () => {
    // gt.glb's real node name contains a dot ("...mgl_060606FF.001_0").
    // THREE's GLTFLoader runs PropertyBinding.sanitizeNodeName, so at
    // runtime the mesh is named "...mgl_060606FF001_0" — the manifest keeps
    // the authored name and the lookup must bridge the difference.
    const { geo } = buildMonolithGeo();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'TwiXeR_992_plastic_mgl_060606FF001_0';   // sanitized (dot removed)
    const scene = new THREE.Group();
    scene.rotation.set(0, Math.PI, 0);
    scene.add(mesh);
    scene.updateMatrixWorld(true);
    const cfg = { ...WHEEL_BAKE_CFG, mesh: 'TwiXeR_992_plastic_mgl_060606FF.001_0' };  // authored
    const built = buildWheelsFromMonolith(scene, cfg);
    expect(built).not.toBeNull();
    expect(built.wheelsRoot.children).toHaveLength(4);
  });

  it('WM9. missing mesh name or geometry-less stub → null, no throw', () => {
    const { scene } = buildMonolithScene();
    expect(buildWheelsFromMonolith(scene, { ...WHEEL_BAKE_CFG, mesh: 'nope' })).toBeNull();
    const bare = new THREE.Group();
    const stub = new THREE.Group();   // not a mesh at all
    stub.name = 'monolith';
    bare.add(stub);
    expect(buildWheelsFromMonolith(bare, WHEEL_BAKE_CFG)).toBeNull();
    expect(buildWheelsFromMonolith(null, WHEEL_BAKE_CFG)).toBeNull();
  });
});

describe('loadCarFromManifest with wheelBake', () => {
  function gtManifest(overrides = {}) {
    return {
      url: 'fixture://gt.glb',
      transform: { scale: 1.0, rotation: [0, Math.PI, 0], position: [0, 0, 0] },
      stripMeshes: [],
      liveryMeshes: ['monolith'],
      wheelBake: { ...WHEEL_BAKE_CFG, ...overrides },
    };
  }

  it('LM-GT1. wheelBake manifest → wheelsRoot + F1-shaped glbMeasure', async () => {
    const { geo } = buildMonolithGeo();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'monolith';
    const scene = new THREE.Group();
    scene.add(mesh);
    holder.gltf = { scene };

    const result = await loadCarFromManifest(gtManifest());
    expect(result).not.toBeNull();
    expect(result.wheelsRoot).not.toBeNull();
    for (const key of ['groundContactY', 'frontAxleZ', 'rearAxleZ', 'frontAxleX', 'rearAxleX', 'wheelRadius']) {
      expect(result.glbMeasure[key], key).toBeTypeOf('number');
    }
    expect(result.glbMeasure.wheelDebug).toBeDefined();
  });

  it('LM-GT2. mega-mesh still livery-collectable; fragments live outside scene', async () => {
    const { geo } = buildMonolithGeo();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'monolith';
    const scene = new THREE.Group();
    scene.add(mesh);
    holder.gltf = { scene };

    const result = await loadCarFromManifest(gtManifest());
    expect(result.liveryMeshes).toHaveLength(1);
    expect(result.liveryMeshes[0]).toBe(mesh);
    // Corner groups are NOT descendants of the GLB scene.
    let cornerInScene = false;
    result.scene.traverse(n => { if (['FL', 'FR', 'RL', 'RR'].includes(n.name)) cornerInScene = true; });
    expect(cornerInScene).toBe(false);
    expect(result.wheelsRoot.children).toHaveLength(4);
  });

  it('LM-GT4. livery/strip traversal also bridges sanitized names', async () => {
    const { geo } = buildMonolithGeo();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'monolith001_0';                 // sanitized form of 'monolith.001_0'
    const scene = new THREE.Group();
    scene.add(mesh);
    holder.gltf = { scene };

    const manifest = gtManifest({ mesh: 'monolith.001_0' });
    manifest.liveryMeshes = ['monolith.001_0'];  // authored (dotted) name
    const result = await loadCarFromManifest(manifest);
    expect(result.wheelsRoot).not.toBeNull();
    expect(result.liveryMeshes).toHaveLength(1);
    expect(result.liveryMeshes[0]).toBe(mesh);
  });

  it('LM-GT5. anchorSources measured POST-split — roof anchor present, vents role-tagged', async () => {
    const { geo } = buildMonolithGeo();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'monolith';
    // Roof mesh — measured for the halo anchor (peak y).
    const roofGeo = new THREE.BufferGeometry();
    roofGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.6, 1.20, -0.5,   0.6, 1.29, 0.4,   0, 1.25, 0.6,
    ]), 3));
    roofGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial());
    roof.name = 'roofMesh';
    const scene = new THREE.Group();
    scene.add(mesh, roof);
    holder.gltf = { scene };

    const manifest = gtManifest();
    manifest.anchorSources = {
      halo:      { mesh: 'roofMesh', use: 'peak' },
      bodyShell: { mesh: 'monolith', use: 'center' },
      engineIntake: { anchor: 'halo', offset: [0, -0.2, 1.2], direction: [0, -0.4, -1], role: 'inlet' },
      fenderVentL:  { anchor: 'bodyShell', offset: [-0.80, 0.1, -1.1], direction: [-0.3, 1, 0], role: 'outlet' },
      fenderVentR:  { mirrored: 'fenderVentL' },
    };
    const result = await loadCarFromManifest(manifest);
    const anchors = result.glbMeasure.anchors;
    expect(anchors).toBeDefined();
    expect(anchors.halo.y).toBeCloseTo(1.29, 3);
    expect(anchors.engineIntake.role).toBe('inlet');
    expect(anchors.engineIntake.y).toBeCloseTo(1.29 - 0.2, 3);
    expect(anchors.fenderVentL.role).toBe('outlet');
    expect(anchors.fenderVentR.x).toBeCloseTo(-anchors.fenderVentL.x, 5);
    // bodyShell measured AFTER the wheel split — its bbox floor must NOT
    // reach the tire-bottom y (-0.09); the wheel-less body floor is 0.10.
    expect(anchors.bodyShell.bbox.minY).toBeGreaterThan(0.0);
  });

  it('LM-GT3. split failure → null wheelsRoot/glbMeasure, scene untouched', async () => {
    const { geo } = buildMonolithGeo();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = 'monolith';
    const before = mesh.geometry.attributes.position.count;
    const scene = new THREE.Group();
    scene.add(mesh);
    holder.gltf = { scene };

    const result = await loadCarFromManifest(gtManifest({ mesh: 'renamed-away' }));
    expect(result).not.toBeNull();
    expect(result.wheelsRoot).toBeNull();
    expect(result.glbMeasure).toBeNull();
    expect(mesh.geometry.attributes.position.count).toBe(before);   // no partial strip
  });
});

describe('collectOccupancyMeshes', () => {
  function namedMesh(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3));
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
    m.name = name;
    return m;
  }

  it('OC1. collects anchorSources body meshes + occupancyMeshes extras, bridging sanitized names', () => {
    const body = namedMesh('Brand_plastic_mgl001_0');      // sanitized form of '...mgl.001_0'
    const roof = namedMesh('Brand_carbon_roof001_0');
    const glass = namedMesh('Brand_glass002_0');
    const seat = namedMesh('Brand_seat_leather');          // interior — must NOT collect
    const scene = new THREE.Group();
    scene.add(body, roof, glass, seat);

    const manifest = {
      anchorSources: {
        bodyShell: { mesh: 'Brand_plastic_mgl.001_0', use: 'center' },   // authored (dotted)
        halo:      { mesh: 'Brand_carbon_roof.001_0', use: 'peak' },
        engineIntake: { anchor: 'halo', offset: [0,0,0], direction: [0,0,1], role: 'inlet' },
      },
      occupancyMeshes: ['Brand_glass.002_0'],
    };
    const meshes = collectOccupancyMeshes(scene, manifest);
    expect(meshes).toContain(body);
    expect(meshes).toContain(roof);
    expect(meshes).toContain(glass);
    expect(meshes).not.toContain(seat);
  });

  it('OC2. returns [] without anchorSources (procedural cars skip occupancy)', () => {
    const scene = new THREE.Group();
    scene.add(namedMesh('whatever'));
    expect(collectOccupancyMeshes(scene, {})).toEqual([]);
    expect(collectOccupancyMeshes(scene, null)).toEqual([]);
  });
});
