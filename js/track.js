/**
 * track.js — Procedural track environment for FormulaSim.
 *
 * Curved-track rework: all furniture (asphalt ribbon, dashes, rumbles,
 * barriers, tyre stacks, S/F band) is laid out along the TrackPath in
 * track space and recycled through a sliding window [s−35, s+41] as the
 * car advances. The car never moves — main.js applies the inverse car
 * pose to the whole group, so local coordinates here are track-space.
 *
 * Layout math (rowPose / rowWindow / pools) lives in track-path.js and is
 * unit-tested there; this file is the thin THREE wrapper.
 */

import * as THREE from 'three';
import {
  rowPose, rowWindow, poolSize, poolIndex,
  WINDOW_BEHIND, WINDOW_AHEAD,
} from './track-path.js';
import { HORIZON_COLOR } from './scene-config.js';

const ROAD_W      = 30;     // full ground width (m)
const GRASS_W     = 160;    // grass apron width (m) — fills the view to the sides
const RIBBON_DS   = 2;      // ground ribbon row spacing (m)
const SURFACE_Y   = -0.34;
const GRASS_Y     = SURFACE_Y - 0.04;   // under the asphalt, no z-fight

function makeAsphaltTexture() {
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Dark grey base
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(0, 0, 512, 512);

  // 9000 random aggregate dots
  for (let i = 0; i < 9000; i++) {
    const x  = Math.random() * 512;
    const y  = Math.random() * 512;
    const r  = Math.random() * 1.4 + 0.3;
    const v  = Math.floor(Math.random() * 40 + 20);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Faint racing-line gradient (centre strip, worn smooth)
  const grad = ctx.createLinearGradient(256, 0, 256, 512);
  grad.addColorStop(0,    'rgba(60,60,60,0)');
  grad.addColorStop(0.15, 'rgba(60,60,60,0.18)');
  grad.addColorStop(0.5,  'rgba(55,55,55,0.28)');
  grad.addColorStop(0.85, 'rgba(60,60,60,0.18)');
  grad.addColorStop(1,    'rgba(60,60,60,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(170, 0, 172, 512);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeGrassTexture() {
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Mid-green base
  ctx.fillStyle = '#2e6b2a';
  ctx.fillRect(0, 0, 512, 512);

  // Mottled patches — mowing/wear variation
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const r = Math.random() * 26 + 8;
    const g = Math.floor(Math.random() * 45 + 85);
    ctx.fillStyle = `rgba(${Math.floor(g * 0.42)},${g},${Math.floor(g * 0.3)},0.35)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine blade speckle
  for (let i = 0; i < 7000; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const g = Math.floor(Math.random() * 70 + 75);
    ctx.fillStyle = `rgb(${Math.floor(g * 0.45)},${g},${Math.floor(g * 0.32)})`;
    ctx.fillRect(x, y, 1.2, Math.random() * 3 + 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* ── Skyline — distant horizon panorama that meets the grass ─────── *
 * A ground disc (hazy distant grass) fills the floor from the grass
 * apron out to a panorama cylinder: treeline + hill silhouettes over a
 * sky gradient that tops out at the scene background colour. Distant
 * scenery YAWS with the world during turns but never translates, so the
 * group is added to the SCENE (not trackGroup) and main.js copies only
 * the world rotation onto it each frame. */
const SKYLINE_R = 350;   // m — horizon ring radius
const SKYLINE_H = 90;    // m — panorama height (sky gradient blends out on top)

/* Arcade mid-ground parallax ring (game plan Phase C): a second, nearer
 * cylinder of taller/darker silhouettes. Per frame it gets the world rotY
 * PLUS a forward drift v·dt/(2π·R) rad (nearParallaxStep in game-mode.js);
 * the far ring keeps rotY only — that differential is the depth cue.
 * Hidden in SIM mode (sim scene must stay byte-identical). */
export const SKYLINE_NEAR_R = 200;   // m — between WINDOW_AHEAD 160 and R 350
const SKYLINE_NEAR_H = 70;

/* Arcade rhythm furniture (Phase C): roadside posts + dashed lane paint
 * give the strafe lanes a visible beat. Row-pool spacings/laterals pinned
 * by game-mode.test.js. LANE_X = ±2.5 m — the boundaries of the three
 * coin lanes at lat −5 / 0 / +5 (coins.js). */
export const ARCADE_PROPS = {
  POST_X:       13.5,   // m — outside the strafe hard clamp (±12)
  POST_SPACING: 25,     // m
  LANE_X:       2.5,    // m — lane-paint lateral
  LANE_SPACING: 8,      // m — dash period
};

function makeSkylineTexture() {
  const W = 2048, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Sky: background blue at top → pale haze at the horizon line (62%).
  // The final stop is HORIZON_COLOR — the arcade fog (ARCADE_FOG) shares
  // the constant so the fog wall melts into this panorama seamlessly.
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.66);
  sky.addColorStop(0,    '#87ceeb');   // = BACKGROUND_COLOR, seamless blend up
  sky.addColorStop(0.75, '#b8dcec');
  sky.addColorStop(1,    HORIZON_COLOR);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H * 0.66);

  // Silhouette bands — sums of integer-cycle sinusoids so the 360°
  // panorama wraps with no seam. Far hills first (pale), treeline after.
  const bands = [
    { base: 0.630, amps: [[3, 0.030], [7, 0.014], [11, 0.008]], phase: 1.7, color: '#9dbba8' },
    { base: 0.680, amps: [[5, 0.026], [9, 0.016], [17, 0.007]], phase: 4.2, color: '#587f58' },
    { base: 0.725, amps: [[8, 0.020], [13, 0.012], [23, 0.006]], phase: 0.6, color: '#3d603c' },
  ];
  for (const b of bands) {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
      let y = b.base;
      for (const [k, a] of b.amps) y -= a * Math.sin((2 * Math.PI * k * x) / W + b.phase * k);
      ctx.lineTo(x, y * H);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }

  // Base: darker green grading to the ground-disc colour at the bottom
  // edge so the cylinder foot melts into the floor.
  const base = ctx.createLinearGradient(0, H * 0.80, 0, H);
  base.addColorStop(0, 'rgba(62,96,60,0)');
  base.addColorStop(1, '#4a7a40');
  ctx.fillStyle = base;
  ctx.fillRect(0, H * 0.80, W, H * 0.20);

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

/* Arcade near ring: taller/darker silhouettes only — the sky stays
 * transparent so the far panorama shows through above them. Same
 * integer-cycle sinusoid rule as the far ring (seamless 360° wrap). */
function makeNearSkylineTexture() {
  const W = 2048, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bands = [
    { base: 0.42, amps: [[2, 0.100], [5, 0.045], [9, 0.020]], phase: 2.9, color: '#31502f' },
    { base: 0.55, amps: [[4, 0.080], [7, 0.040], [13, 0.018]], phase: 5.1, color: '#22381f' },
  ];
  for (const b of bands) {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
      let y = b.base;
      for (const [k, a] of b.amps) y -= a * Math.sin((2 * Math.PI * k * x) / W + b.phase * k);
      ctx.lineTo(x, y * H);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }

  // Foot melts into the ground-disc green, like the far ring.
  const base = ctx.createLinearGradient(0, H * 0.85, 0, H);
  base.addColorStop(0, 'rgba(74,122,64,0)');
  base.addColorStop(1, '#4a7a40');
  ctx.fillStyle = base;
  ctx.fillRect(0, H * 0.85, W, H * 0.15);

  return new THREE.CanvasTexture(canvas);
}

export function buildSkyline() {
  const group = new THREE.Group();
  group.name = 'skyline';

  // Hazy distant-grass floor out to the horizon ring. fog: false — beyond
  // the arcade fog far plane (330), fogging would flatten it to a wall
  // that clashes with the (fog-exempt) panorama above it.
  const discGeo = new THREE.CircleGeometry(SKYLINE_R + 40, 48);
  discGeo.rotateX(-Math.PI / 2);
  const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: 0x4a7a40, fog: false }));
  disc.position.y = GRASS_Y - 0.06;
  group.add(disc);

  const cylGeo = new THREE.CylinderGeometry(SKYLINE_R, SKYLINE_R, SKYLINE_H, 64, 1, true);
  // fog: false — the far ring IS the horizon backdrop; the arcade fog ends
  // at 330 < 350, so a fogged panorama would collapse to a flat colour band
  // under the (unfogged) Sky shader. Fog colour == HORIZON_COLOR keeps the
  // hand-off seamless instead.
  const cylMat = new THREE.MeshBasicMaterial({ map: makeSkylineTexture(), side: THREE.BackSide, fog: false });
  const cyl = new THREE.Mesh(cylGeo, cylMat);
  cyl.position.y = SKYLINE_H / 2 + GRASS_Y - 0.1;
  group.add(cyl);

  // Arcade mid-ground parallax ring — HIDDEN in sim mode. Fog stays ON for
  // this one (R 200 → ~46% fogged): the haze is part of the depth cue.
  const nearGeo = new THREE.CylinderGeometry(SKYLINE_NEAR_R, SKYLINE_NEAR_R, SKYLINE_NEAR_H, 64, 1, true);
  const nearMat = new THREE.MeshBasicMaterial({
    map: makeNearSkylineTexture(),
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const near = new THREE.Mesh(nearGeo, nearMat);
  near.name = 'skyline-near';
  near.position.y = SKYLINE_NEAR_H / 2 + GRASS_Y - 0.08;
  near.visible = false;
  group.add(near);

  return { group, near };
}

/* ── Ground ribbon — path-following textured strip (asphalt or grass) ── */
function buildGroundRibbon(groundTex, width = ROAD_W, y = SURFACE_Y, uRepeat = 18) {
  const rows = poolSize(RIBBON_DS);            // fixed vertex count
  const positions = new Float32Array(rows * 2 * 3);
  const uvs       = new Float32Array(rows * 2 * 2);
  const indices   = [];
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  const mat = new THREE.MeshStandardMaterial({
    map: groundTex,
    roughness: 0.88,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;   // verts move in track space every frame

  function update(path) {
    const { kMin, kMax } = rowWindow(path.pose.s, RIBBON_DS);
    for (let r = 0; r < rows; r++) {
      const k = Math.min(kMin + r, kMax);     // tail rows degenerate on kMax
      const s = k * RIBBON_DS;
      const L = rowPose(path, s, -width / 2);
      const R = rowPose(path, s,  width / 2);
      const i = r * 2 * 3;
      positions[i]     = L.x; positions[i + 1] = y; positions[i + 2] = L.z;
      positions[i + 3] = R.x; positions[i + 4] = y; positions[i + 5] = R.z;
      const j = r * 2 * 2;
      // matches the old PlaneGeometry(30,70) + repeat(18,36): one tile ≈ 1.67×1.94 m
      const v = s / (70 / 36);
      uvs[j] = 0;  uvs[j + 1] = v;
      uvs[j + 2] = uRepeat; uvs[j + 3] = v;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
    geo.computeVertexNormals();
  }

  return { mesh, update };
}

/* ── Generic row pool — one Object3D per grid line, recycled ──────── */
function makeRowPool({ spacing, build, place }) {
  const n = poolSize(spacing);
  const items = [];
  for (let i = 0; i < n; i++) {
    const obj = build(i);
    obj.userData.k = null;
    obj.userData.epoch = -1;
    items.push(obj);
  }

  function update(path) {
    const { kMin, kMax } = rowWindow(path.pose.s, spacing);
    for (let k = kMin; k <= kMax; k++) {
      const obj = items[poolIndex(k, n)];
      if (obj.userData.k === k && obj.userData.epoch === path.epoch) continue;
      place(obj, k, path);
      obj.userData.k = k;
      obj.userData.epoch = path.epoch;
    }
  }

  return { items, update };
}

/* Position a row object at grid line k with lateral offset and yaw. */
function placeRow(obj, k, spacing, lateralX, y, path) {
  const rp = rowPose(path, k * spacing, lateralX);
  obj.position.set(rp.x, y, rp.z);
  obj.rotation.y = rp.rotY;
}

export function buildTrack() {
  const grp = new THREE.Group();
  grp.name = 'track';

  // Grass apron first (renders under the asphalt): same path-following
  // ribbon, much wider, slightly lower — replaces the bare sky-bright void
  // either side of the road. Tile density matches the asphalt (~1.67 m/tile).
  const grass = buildGroundRibbon(makeGrassTexture(), GRASS_W, GRASS_Y, GRASS_W / (30 / 18));
  grp.add(grass.mesh);

  const groundTex = makeAsphaltTexture();
  const ribbon = buildGroundRibbon(groundTex);
  grp.add(ribbon.mesh);

  const pools = [];

  /* ── Start / finish band — one per 70 m ─────────────────────────── */
  const sfGeo = new THREE.PlaneGeometry(12, 0.45);
  sfGeo.rotateX(-Math.PI / 2);
  const sfMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  pools.push(makeRowPool({
    spacing: 70,
    build: () => { const m = new THREE.Mesh(sfGeo, sfMat); grp.add(m); return m; },
    place: (m, k, path) => placeRow(m, k, 70, 0, SURFACE_Y + 0.007, path),
  }));

  /* ── Centre-line dashes — every 4 m ─────────────────────────────── */
  const dashGeo = new THREE.PlaneGeometry(0.12, 2.2);
  dashGeo.rotateX(-Math.PI / 2);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  pools.push(makeRowPool({
    spacing: 4,
    build: () => { const m = new THREE.Mesh(dashGeo, dashMat); grp.add(m); return m; },
    place: (m, k, path) => placeRow(m, k, 4, 0, SURFACE_Y + 0.008, path),
  }));

  /* ── Red/white rumble strips — every 0.6 m, both sides ──────────── */
  const rumbleGeo   = new THREE.PlaneGeometry(0.9, 0.58);
  rumbleGeo.rotateX(-Math.PI / 2);
  const rumbleRed   = new THREE.MeshBasicMaterial({ color: 0xcc1111 });
  const rumbleWhite = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 0.6,
      build: () => { const m = new THREE.Mesh(rumbleGeo, rumbleRed); grp.add(m); return m; },
      place: (m, k, path) => {
        m.material = k % 2 === 0 ? rumbleRed : rumbleWhite;
        placeRow(m, k, 0.6, side * 5.55, SURFACE_Y + 0.009, path);
      },
    }));
  }

  /* ── Armco barriers — 4 m segments, both sides ──────────────────── */
  const armcoGeo = new THREE.BoxGeometry(0.12, 0.38, 4.05);
  const armcoMat = new THREE.MeshStandardMaterial({
    color: 0xbbbbbb,
    roughness: 0.35,
    metalness: 0.75,
  });
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 4,
      build: () => {
        const m = new THREE.Mesh(armcoGeo, armcoMat);
        m.castShadow = m.receiveShadow = true;
        grp.add(m);
        return m;
      },
      place: (m, k, path) => placeRow(m, k, 4, side * 6.4, -0.15, path),
    }));
  }

  /* ── Tyre stacks — every 1.2 m, two high, both sides ────────────── */
  const tyreGeo  = new THREE.CylinderGeometry(0.22, 0.22, 0.2, 16);
  const tyreMats = [0x222222, 0xdd1111].map(c => new THREE.MeshStandardMaterial({
    color: c, roughness: 0.82, metalness: 0.05,
  }));
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 1.2,
      build: () => {
        const stack = new THREE.Group();
        for (let row = 0; row < 2; row++) {
          const tyre = new THREE.Mesh(tyreGeo, tyreMats[0]);
          tyre.position.y = row * 0.44;
          tyre.castShadow = tyre.receiveShadow = true;
          stack.add(tyre);
        }
        grp.add(stack);
        return stack;
      },
      place: (stack, k, path) => {
        stack.children.forEach((tyre, row) => {
          tyre.material = tyreMats[(((k + row) % 2) + 2) % 2]; // positive mod — k can be negative
        });
        placeRow(stack, k, 1.2, side * 7.2, SURFACE_Y + 0.22, path);
      },
    }));
  }

  /* ── ARCADE rhythm props (Phase C) — hidden in sim mode ─────────── *
   * Roadside posts every 25 m at ±13.5 m (outside the ±12 strafe clamp)
   * and dashed lane paint every 8 m at ±2.5 m (coin-lane boundaries).
   * Same row-pool recycling as the rest of the furniture; visibility is
   * the only arcade/sim difference (setArcadeProps). */
  const arcadeItems = [];

  const postGeo   = new THREE.BoxGeometry(0.14, 2.4, 0.14);
  const postRed   = new THREE.MeshBasicMaterial({ color: 0xd22222 });
  const postWhite = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: ARCADE_PROPS.POST_SPACING,
      build: () => {
        const m = new THREE.Mesh(postGeo, postWhite);
        m.visible = false;
        grp.add(m);
        arcadeItems.push(m);
        return m;
      },
      place: (m, k, path) => {
        m.material = (((k % 2) + 2) % 2) === 0 ? postRed : postWhite; // positive mod
        placeRow(m, k, ARCADE_PROPS.POST_SPACING, side * ARCADE_PROPS.POST_X,
          SURFACE_Y + 1.2, path);
      },
    }));
  }

  const laneGeo = new THREE.PlaneGeometry(0.12, 2.2);
  laneGeo.rotateX(-Math.PI / 2);
  const laneMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: ARCADE_PROPS.LANE_SPACING,
      build: () => {
        const m = new THREE.Mesh(laneGeo, laneMat);
        m.visible = false;
        grp.add(m);
        arcadeItems.push(m);
        return m;
      },
      place: (m, k, path) => placeRow(m, k, ARCADE_PROPS.LANE_SPACING,
        side * ARCADE_PROPS.LANE_X, SURFACE_Y + 0.008, path),
    }));
  }

  function setArcadeProps(on) {
    for (const o of arcadeItems) o.visible = !!on;
  }

  /* Re-place every out-of-date row + rebuild the ground ribbons. */
  function update(path) {
    grass.update(path);
    ribbon.update(path);
    for (const p of pools) p.update(path);
  }

  return { group: grp, groundTex, update, setArcadeProps, WINDOW_BEHIND, WINDOW_AHEAD };
}
