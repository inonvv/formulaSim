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
import {
  LAYOUTS, TREES, rowSide, groundOffset, cornerKappa, insideBlocked, kerbVisible, gravelExtent, tyresVisible,
  treeSpec, inLapRange, expandScenery, treeBlocked, barrierBlocked,
} from './track-layout.js';

const GRASS_W     = 320;    // grass apron width (m) — fills the view to the sides
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

  // Skirt: the same hazy green continued straight down from the foot of the
  // panorama. Invisible on flat ground (the disc covers it); on a circuit
  // with elevation the disc is dropped below the lowest road in view
  // (setGroundDrop) and the world pitches with the slope — the skirt keeps
  // the horizon closed instead of showing sky under the hills.
  const SKIRT_H = 140;
  const skirtGeo = new THREE.CylinderGeometry(SKYLINE_R, SKYLINE_R, SKIRT_H, 64, 1, true);
  const skirt = new THREE.Mesh(skirtGeo, new THREE.MeshBasicMaterial({ color: 0x4a7a40, side: THREE.BackSide, fog: false }));
  skirt.position.y = GRASS_Y - 0.1 - SKIRT_H / 2;
  group.add(skirt);
  const discBaseY = disc.position.y;
  /** Lower the far ground by d metres (0 = flat test track). */
  function setGroundDrop(d) { disc.position.y = discBaseY - Math.max(0, d || 0); }

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

  return { group, near, setGroundDrop };
}

/* ── Ground — path-following strips laid side by side ─────────────── *
 * One station every RIBBON_DS metres; at each, track-layout.rowSide()
 * gives the cross-section (road · verge · gravel / pit lane · verge ·
 * bank) and every strip takes its two edges from it. Neighbouring strips
 * share those edges exactly, so nothing overlaps and nothing can poke
 * through on a sloping, fanning corner.                                  */
const GROUND_AHEAD = 260;   // m — ground reaches past the furniture window so
                            // distant scenery stands on something
const U_PER_M = 18 / 30;    // texture tiles per metre across (≈1.67 m / tile)

function makeStrip(tex, matOpts, pick) {
  const rows = poolSize(RIBBON_DS, WINDOW_BEHIND, GROUND_AHEAD);   // fixed vertex count
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
    map: tex, roughness: 0.88, metalness: 0.04, side: THREE.DoubleSide, ...matOpts,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;   // verts move in track space every frame
  return { mesh, geo, positions, uvs, rows, pick };
}

/* ── Small canvas textures for scenery ───────────────────────────── */
function canvasTex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGravelTexture() {
  return canvasTex(256, 256, (ctx) => {
    ctx.fillStyle = '#b9a98a';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5000; i++) {
      const v = 120 + Math.floor(Math.random() * 90);
      ctx.fillStyle = `rgb(${v + 20},${v + 8},${v - 18})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
    }
  }, true);
}

/* Rows of spectators: dark tiers with a scatter of bright shirts. */
function makeCrowdTexture() {
  return canvasTex(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#3a3f4a';
    ctx.fillRect(0, 0, w, h);
    const shirts = ['#e8e8e8', '#d23b3b', '#2f6fd0', '#f0c330', '#3aa860', '#f08a2c', '#1d1d22', '#c9c9d4'];
    for (let row = 0; row < 12; row++) {
      ctx.fillStyle = row % 2 ? '#2d313a' : '#353a45';
      ctx.fillRect(0, row * (h / 12), w, h / 12 - 2);
      for (let x = 2; x < w; x += 5) {
        if (Math.random() < 0.22) continue;                 // empty seat
        ctx.fillStyle = shirts[Math.floor(Math.random() * shirts.length)];
        ctx.fillRect(x, row * (h / 12) + 1, 3.4, h / 12 - 5);
      }
    }
  }, true);
}

/* Pit garage front: door openings below, glazed hospitality band above. */
function makePitTexture() {
  return canvasTex(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#d9dce2';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#5d7f9c';
    ctx.fillRect(0, 10, w, 34);                              // glass band
    ctx.fillStyle = '#c2c6cf';
    for (let x = 0; x < w; x += 16) ctx.fillRect(x, 10, 2, 34);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(0, 50, w, 6);                               // fascia stripe
    ctx.fillStyle = '#1b1d22';
    for (let x = 6; x < w; x += 64) ctx.fillRect(x, 62, 52, 66);   // garage doors
  }, true);
}

function makeTextTexture(text, bg, fg, w = 256, h = 64) {
  return canvasTex(w, h, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = fg;
    ctx.font = `bold ${Math.floor(h * 0.62)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
  });
}

function makeCheckerTexture() {
  return canvasTex(128, 16, (ctx, w, h) => {
    for (let x = 0; x < w; x += 8) for (let y = 0; y < h; y += 8) {
      ctx.fillStyle = ((x + y) / 8) % 2 ? '#111' : '#f4f4f4';
      ctx.fillRect(x, y, 8, 8);
    }
  });
}

/* ── Generic row pool — one Object3D per grid line, recycled ──────── */
function makeRowPool({ spacing, build, place, version }) {
  const n = poolSize(spacing);
  const items = [];
  for (let i = 0; i < n; i++) {
    const obj = build(i);
    obj.userData.k = null;
    obj.userData.epoch = -1;
    obj.userData.ver = -1;
    items.push(obj);
  }

  let lastVer = 0;
  function update(path) {
    const { kMin, kMax } = rowWindow(path.pose.s, spacing);
    const ver = version ? version() : 0;
    if (ver !== lastVer) {
      // Layout switched: rows left outside the new window would linger at
      // their old spot in the old style — retire them until re-placed.
      lastVer = ver;
      for (const obj of items) { obj.userData.k = null; obj.visible = false; }
    }
    for (let k = kMin; k <= kMax; k++) {
      const obj = items[poolIndex(k, n)];
      if (obj.userData.k === k && obj.userData.epoch === path.epoch && obj.userData.ver === ver) continue;
      place(obj, k, path);
      obj.userData.k = k;
      obj.userData.epoch = path.epoch;
      obj.userData.ver = ver;
    }
  }

  return { items, update };
}

/* Position a row object at grid line k: `lateralX` metres right of the ROAD
 * CENTRE (which itself slides relative to the driven line on a circuit). */
function placeRow(obj, k, spacing, lateralX, y, path) {
  const s = k * spacing;
  const rp = rowPose(path, s, lateralX + path.centerOffsetAt(s));
  obj.position.set(rp.x, y + path.heightAt(s), rp.z);
  // Yaw with the road, then pitch with its slope (YXZ: the pitch is about
  // the row's own lateral axis) so paint and kerbs lie ON a gradient
  // instead of half-buried in it. Both are 0 on the flat test track.
  obj.rotation.order = 'YXZ';
  obj.rotation.y = rp.rotY;
  obj.rotation.x = Math.atan(path.gradeAt(s));
}

export function buildTrack() {
  const grp = new THREE.Group();
  grp.name = 'track';

  // Active roadside layout + circuit scenery (setLayout swaps both).
  let layout = LAYOUTS.test;
  let layoutVer = 0;
  let scenery = { items: [], pitlanes: [], keepOut: [] };
  const version = () => layoutVer;
  const lapLen = (path) => path.circuit?.length ?? 1;

  /* ── Ground strips ───────────────────────────────────────────────
   * pick(row) → [x0, x1, dh0, dh1]: the strip's two edges at this station
   * (metres right of the DRIVEN line) and their height offsets. A strip
   * with x0 === x1 draws nothing there, so gravel and pit lane come and go
   * along the lap. */
  // Matte, no sky reflection: at grazing angles the environment map washed
  // the grass out to near-white against the (unlit) far ground.
  const grassMat  = { roughness: 1, metalness: 0, envMapIntensity: 0.12, color: 0x537649 };
  const gravelMat = { roughness: 1, metalness: 0, envMapIntensity: 0.1, color: 0x9a927f };
  const grassTex  = makeGrassTexture();
  const gravelTex = makeGravelTexture();
  const groundTex = makeAsphaltTexture();
  const strips = [makeStrip(groundTex, {}, (row) => [row.c - row.L.a, row.c + row.R.a, 0, 0])];
  for (const side of [-1, 1]) {
    const S = side < 0 ? 'L' : 'R';
    const at = (row, v) => row.c + side * v;
    const span = (row, v0, v1, dh0 = 0, dh1 = 0) => (side < 0
      ? [at(row, v1), at(row, v0), dh1, dh0]
      : [at(row, v0), at(row, v1), dh0, dh1]);
    strips.push(makeStrip(grassTex, grassMat, (row) => span(row, row[S].a, row[S].z0)));
    strips.push(makeStrip(gravelTex, gravelMat, (row) => (row[S].zone === 'gravel'
      ? span(row, row[S].z0, row[S].z1) : span(row, row[S].z0, row[S].z0))));
    strips.push(makeStrip(groundTex, {}, (row) => (row[S].zone === 'pit'
      ? span(row, row[S].z0, row[S].z1) : span(row, row[S].z0, row[S].z0))));
    strips.push(makeStrip(grassTex, grassMat, (row) => span(row, row[S].z1, row[S].flat)));
    strips.push(makeStrip(grassTex, grassMat, (row) => span(row, row[S].flat, row[S].reach, 0, row[S].dh)));
  }
  for (const st of strips) grp.add(st.mesh);

  const _row = { c: 0, L: null, R: null };
  const pitOn = (path, lap, side) => {
    for (const p of scenery.pitlanes) {
      if (p.side === side && inLapRange(lap, p.from, p.to, lapLen(path))) return p;
    }
    return null;
  };
  function updateGround(path) {
    const { kMin, kMax } = rowWindow(path.pose.s, RIBBON_DS, WINDOW_BEHIND, GROUND_AHEAD);
    const rows = strips[0].rows;
    for (let r = 0; r < rows; r++) {
      const k = Math.min(kMin + r, kMax);     // tail rows degenerate on kMax
      const s = k * RIBBON_DS;
      // One pose per station; every strip edge is that pose pushed sideways.
      const p = path.poseAt(s);
      const cs = Math.cos(p.theta), sn = Math.sin(p.theta);
      const h = SURFACE_Y + path.heightAt(s);
      const c = path.centerOffsetAt(s);
      const kappa = path.curvatureAt(s);
      const near = layout.circuit ? cornerKappa(path, s) : 0;
      const lap = path.lapAt(s);
      _row.c = c;
      for (const side of [-1, 1]) {
        const room = path.sideRoomAt(s, side);
        _row[side < 0 ? 'L' : 'R'] = rowSide(layout, side, {
          c, kappa, kappaNear: near, room: room.room, dh: room.dh,
          pit: layout.circuit ? pitOn(path, lap, side) : null, maxReach: GRASS_W / 2,
        });
      }
      const v = s / (70 / 36);          // one tile ≈ 1.94 m along the road
      const i = r * 6, j = r * 4;
      for (const st of strips) {
        const e = st.pick(_row);
        const pos = st.positions, uv = st.uvs;
        // right(θ) = (cosθ, −sinθ) in (x, z)
        pos[i]     = p.x + e[0] * cs; pos[i + 1] = h + e[2]; pos[i + 2] = p.z - e[0] * sn;
        pos[i + 3] = p.x + e[1] * cs; pos[i + 4] = h + e[3]; pos[i + 5] = p.z - e[1] * sn;
        uv[j] = e[0] * U_PER_M;      uv[j + 1] = v;
        uv[j + 2] = e[1] * U_PER_M;  uv[j + 3] = v;
      }
    }
    for (const st of strips) {
      st.geo.attributes.position.needsUpdate = true;
      st.geo.attributes.uv.needsUpdate = true;
      st.geo.computeVertexNormals();
    }
  }

  const pools = [];

  /* ── Start / finish band — one per 70 m (test track only) ───────── */
  const sfGeo = new THREE.PlaneGeometry(12, 0.45);
  sfGeo.rotateX(-Math.PI / 2);
  const sfMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  pools.push(makeRowPool({
    spacing: 70, version,
    build: () => { const m = new THREE.Mesh(sfGeo, sfMat); grp.add(m); return m; },
    place: (m, k, path) => {
      m.visible = !layout.circuit;
      placeRow(m, k, 70, 0, SURFACE_Y + 0.007, path);
    },
  }));

  /* ── Centre-line dashes — every 4 m (test track only) ───────────── */
  const dashGeo = new THREE.PlaneGeometry(0.12, 2.2);
  dashGeo.rotateX(-Math.PI / 2);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  pools.push(makeRowPool({
    spacing: 4, version,
    build: () => { const m = new THREE.Mesh(dashGeo, dashMat); grp.add(m); return m; },
    place: (m, k, path) => {
      m.visible = !layout.circuit;
      placeRow(m, k, 4, 0, SURFACE_Y + 0.008, path);
    },
  }));

  /* ── White edge lines — circuit only, continuous along both edges ── */
  const edgeGeo = new THREE.PlaneGeometry(0.16, 4.1);
  edgeGeo.rotateX(-Math.PI / 2);
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 4, version,
      build: () => { const m = new THREE.Mesh(edgeGeo, dashMat); m.visible = false; grp.add(m); return m; },
      place: (m, k, path) => {
        m.visible = !!layout.circuit;
        if (layout.circuit) placeRow(m, k, 4, side * layout.edgeLineX, SURFACE_Y + 0.008, path);
      },
    }));
  }

  /* ── Red/white kerbs — every 0.6 m, both sides ──────────────────── *
   * Test track: continuous. Circuit: only through corners.            */
  const rumbleGeo   = new THREE.PlaneGeometry(0.9, 0.58);
  rumbleGeo.rotateX(-Math.PI / 2);
  const rumbleRed   = new THREE.MeshBasicMaterial({ color: 0xcc1111 });
  const rumbleWhite = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 0.6, version,
      build: () => { const m = new THREE.Mesh(rumbleGeo, rumbleRed); grp.add(m); return m; },
      place: (m, k, path) => {
        m.visible = kerbVisible(layout, layout.circuit ? cornerKappa(path, k * 0.6) : 0);
        if (!m.visible) return;
        m.material = k % 2 === 0 ? rumbleRed : rumbleWhite;
        placeRow(m, k, 0.6, side * layout.rumbleX, SURFACE_Y + 0.009, path);
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
  // A roadside row gives way to a pit wall, and is dropped on the inside of
  // a bend too tight to hold it (it would land across the corner).
  const roadsideHidden = (path, s, lateral) => layout.circuit && (
    insideBlocked(path.curvatureAt(s), lateral)
    || barrierBlocked(scenery.keepOut, path.lapAt(s), Math.sign(lateral), lapLen(path)));
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 4, version,
      build: () => {
        const m = new THREE.Mesh(armcoGeo, armcoMat);
        m.castShadow = m.receiveShadow = true;
        grp.add(m);
        return m;
      },
      place: (m, k, path) => {
        m.visible = !roadsideHidden(path, k * 4, side * layout.armcoX);
        if (m.visible) placeRow(m, k, 4, side * layout.armcoX, -0.15, path);
      },
    }));
  }

  /* ── Tyre stacks — every 1.2 m, two high ────────────────────────── *
   * Test track: both sides. Circuit: outside of tight corners only.    */
  const tyreGeo  = new THREE.CylinderGeometry(0.22, 0.22, 0.2, 16);
  const tyreMats = [0x222222, 0xdd1111].map(c => new THREE.MeshStandardMaterial({
    color: c, roughness: 0.82, metalness: 0.05,
  }));
  for (const side of [-1, 1]) {
    pools.push(makeRowPool({
      spacing: 1.2, version,
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
        const s = k * 1.2;
        stack.visible = tyresVisible(layout, layout.circuit ? cornerKappa(path, s) : 0, side)
          && !roadsideHidden(path, s, side * layout.tyreX);
        if (!stack.visible) return;
        stack.children.forEach((tyre, row) => {
          tyre.material = tyreMats[(((k + row) % 2) + 2) % 2]; // positive mod — k can be negative
        });
        placeRow(stack, k, 1.2, side * layout.tyreX, SURFACE_Y + 0.22, path);
      },
    }));
  }

  /* ── Forest — instanced trees both sides (circuit only) ─────────── *
   * Three draw calls for ~400 trees. Rows recycle through the same
   * sliding window as the furniture; a row is rebuilt only when its grid
   * line changes. Trees are dropped where they would stand on a building,
   * on the inside of a tight bend, or on another stretch of track.      */
  const treeRows = poolSize(TREES.spacing, TREES.behind, TREES.ahead);
  const treeCap  = treeRows * 2 * TREES.perRow;
  const coniferGeo = new THREE.ConeGeometry(2.4, 10, 7);
  coniferGeo.translate(0, 7, 0);
  const leafyGeo = new THREE.IcosahedronGeometry(3.4, 1);
  leafyGeo.scale(1, 1.15, 1);
  leafyGeo.translate(0, 6.6, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 4.4, 6);
  trunkGeo.translate(0, 2.2, 0);
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 0.1, flatShading: true });
  const trunkMat   = new THREE.MeshStandardMaterial({ color: 0x2a1f16, roughness: 1, metalness: 0, envMapIntensity: 0.1 });
  const mkInst = (geo, mat) => {
    const im = new THREE.InstancedMesh(geo, mat, treeCap);
    im.frustumCulled = false;
    im.visible = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grp.add(im);
    return im;
  };
  const conifers = mkInst(coniferGeo, foliageMat);
  const leafies  = mkInst(leafyGeo, foliageMat);
  const trunks   = mkInst(trunkGeo, trunkMat);
  const treeRowK = new Int32Array(treeRows).fill(-2147483648);
  let treeEpoch = -1, treeVer = -1;
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const _col = new THREE.Color();
  const _yAxis = new THREE.Vector3(0, 1, 0);

  function updateTrees(path) {
    const on = !!layout.circuit && !!path.circuit;
    conifers.visible = leafies.visible = trunks.visible = on;
    if (!on) return;
    if (treeEpoch !== path.epoch || treeVer !== layoutVer) {
      treeRowK.fill(-2147483648);
      treeEpoch = path.epoch; treeVer = layoutVer;
    }
    const { kMin, kMax } = rowWindow(path.pose.s, TREES.spacing, TREES.behind, TREES.ahead);
    const L = lapLen(path);
    let dirty = false;
    for (let k = kMin; k <= kMax; k++) {
      const slot = poolIndex(k, treeRows);
      if (treeRowK[slot] === k) continue;
      treeRowK[slot] = k;
      dirty = true;
      for (let si = 0; si < 2; si++) {
        const side = si === 0 ? -1 : 1;
        for (let j = 0; j < TREES.perRow; j++) {
          const idx = (slot * 2 + si) * TREES.perRow + j;
          const t = treeSpec(k, side, j);
          const s = k * TREES.spacing + t.ds;
          const lap = path.lapAt(s);
          const hide = insideBlocked(cornerKappa(path, s), t.lateral)
            || treeBlocked(scenery.keepOut, lap, t.lateral, L)
            || path.circuit.clearanceAt(lap, t.lateral) < 18;
          if (hide) {
            conifers.setMatrixAt(idx, _zero); leafies.setMatrixAt(idx, _zero); trunks.setMatrixAt(idx, _zero);
            continue;
          }
          const x = t.lateral + path.centerOffsetAt(s);
          const room = path.sideRoomAt(s, Math.sign(x));
          const gh = groundOffset(room.room, room.dh, x);
          if (gh === null) {                    // that ground belongs to another stretch of track
            conifers.setMatrixAt(idx, _zero); leafies.setMatrixAt(idx, _zero); trunks.setMatrixAt(idx, _zero);
            continue;
          }
          const rp = rowPose(path, s, x);
          _p.set(rp.x, GRASS_Y + path.heightAt(s) + gh, rp.z);
          _q.setFromAxisAngle(_yAxis, t.shade * Math.PI * 2);
          _s.set(t.scale, t.scale * (0.9 + 0.3 * t.shade), t.scale);
          _m4.compose(_p, _q, _s);
          trunks.setMatrixAt(idx, _m4);
          const crown = t.conifer ? conifers : leafies;
          const other = t.conifer ? leafies : conifers;
          crown.setMatrixAt(idx, _m4);
          other.setMatrixAt(idx, _zero);
          // Dark Ardennes pine vs lighter broadleaf, each with a little variation.
          // (Lightness is low on purpose: the scene's lighting is very
          // bright and washes mid-tones out to pastel.)
          if (t.conifer) _col.setHSL(0.37 + 0.03 * t.shade, 0.55, 0.035 + 0.02 * t.shade);
          else           _col.setHSL(0.28 + 0.05 * t.shade, 0.60, 0.06 + 0.03 * t.shade);
          crown.setColorAt(idx, _col);
        }
      }
    }
    if (dirty) {
      for (const im of [conifers, leafies, trunks]) im.instanceMatrix.needsUpdate = true;
      for (const im of [conifers, leafies]) if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  /* ── Lap-anchored scenery (circuit only) ────────────────────────── *
   * Buildings and signs defined per circuit (circuits/*-scenery.js) and
   * placed at fixed lap distances. Prefabs are generic shapes.           */
  const sceneryGrp = new THREE.Group();
  sceneryGrp.name = 'scenery';
  grp.add(sceneryGrp);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x5a5e64, roughness: 0.95, metalness: 0, envMapIntensity: 0.15 });
  const steel    = new THREE.MeshStandardMaterial({ color: 0x4b5058, roughness: 0.6, metalness: 0.5, envMapIntensity: 0.3 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0x8f9296, roughness: 0.8, metalness: 0, envMapIntensity: 0.15 });
  const roofMat  = new THREE.MeshStandardMaterial({ color: 0x70757d, roughness: 0.7, metalness: 0.2, envMapIntensity: 0.2 });
  let crowdTex = null, pitTex = null, checkerTex = null;
  const textMats = new Map();
  const textMat = (text, bg, fg) => {
    const key = `${text}|${bg}|${fg}`;
    if (!textMats.has(key)) textMats.set(key, new THREE.MeshBasicMaterial({ map: makeTextTexture(text, bg, fg) }));
    return textMats.get(key);
  };
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return m;
  };

  /* Local frame of every prefab: −z = direction of travel, +x = AWAY from
     the road (the placer mirrors left-hand items), y = 0 at ground level. */
  const PREFABS = {
    grandstand(it) {
      const g = new THREE.Group();
      const len = it.len, D = 11, H0 = 0.8, H1 = 7.6;
      crowdTex ??= makeCrowdTexture();
      // Raked seating: one quad rising away from the road.
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, H0, -len / 2,  0, H0, len / 2,  D, H1, len / 2,  D, H1, -len / 2,
      ]), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, len / 12, 0, len / 12, 1, 0, 1]), 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 1, metalness: 0, envMapIntensity: 0.1, side: THREE.DoubleSide })));
      g.add(box(0.3, H0, len, concrete, 0.15, H0 / 2, 0));                 // front wall
      g.add(box(0.4, H1, len, concrete, D + 0.2, H1 / 2, 0));              // back wall
      g.add(box(D + 2.5, 0.25, len, roofMat, D / 2 + 0.6, H1 + 2.6, 0));   // roof
      for (const z of [-len / 2 + 0.4, len / 2 - 0.4]) g.add(box(0.3, H1 + 2.6, 0.3, steel, D + 0.2, (H1 + 2.6) / 2, z));
      return g;
    },
    pit(it) {
      const g = new THREE.Group();
      pitTex ??= makePitTexture();
      const front = new THREE.MeshStandardMaterial({ map: pitTex.clone(), roughness: 0.8, metalness: 0.05, envMapIntensity: 0.2 });
      front.map.needsUpdate = true;
      front.map.repeat.set(it.len / 20, 1);
      // BoxGeometry face order: +x, −x, +y, −y, +z, −z. −x faces the road.
      const m = new THREE.Mesh(new THREE.BoxGeometry(10, 7, it.len), [whiteMat, front, roofMat, whiteMat, whiteMat, whiteMat]);
      m.position.set(5, 3.5, 0);
      g.add(m);
      return g;
    },
    wall(it) {
      const g = new THREE.Group();
      g.add(box(0.3, 1.0, it.len + 0.05, whiteMat, 0, 0.5, 0));
      // Catch fence posts on top of the pit wall.
      g.add(box(0.06, 2.2, 0.06, steel, 0, 2.1, -it.len / 2 + 0.3));
      g.add(box(0.06, 2.2, 0.06, steel, 0, 2.1, it.len / 2 - 0.3));
      return g;
    },
    hoarding(it) {
      const WORDS = [['FORMULASIM', '#c62828', '#ffffff'], ['APEX', '#0d47a1', '#ffffff'], ['DOWNFORCE', '#f9a825', '#111111'],
        ['GRIP', '#1b5e20', '#ffffff'], ['SLIPSTREAM', '#eceff1', '#111111'], ['7.0 KM', '#111111', '#ffffff']];
      const [text, bg, fg] = WORDS[it.index % WORDS.length];
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, it.len - 0.4),
        [steel, textMat(text, bg, fg), steel, steel, steel, steel]);
      m.position.set(0, 0.75, 0);
      g.add(m);
      return g;
    },
    board(it) {
      const g = new THREE.Group();
      g.add(box(0.08, 1.4, 0.08, steel, 0, 0.7, 0));
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8), textMat(it.text, '#f4f4f4', '#111111'));
      p.material.side = THREE.DoubleSide;
      p.position.set(0, 1.75, 0);          // PlaneGeometry normal +z = faces the approaching car
      g.add(p);
      return g;
    },
    gantry() {
      const g = new THREE.Group();
      checkerTex ??= makeCheckerTexture();
      const span = LAYOUTS.circuit.roadW + 4;
      for (const x of [-span / 2, span / 2]) g.add(box(0.4, 6.4, 0.4, steel, x, 3.2, 0));
      g.add(box(span + 0.4, 0.9, 0.5, steel, 0, 6.4, 0));
      const lightMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
      for (let i = -2; i <= 2; i++) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), lightMat);
        l.position.set(i * 0.9, 6.4, 0.32);
        g.add(l);
      }
      const line = new THREE.Mesh(new THREE.PlaneGeometry(LAYOUTS.circuit.roadW, 1.0),
        new THREE.MeshBasicMaterial({ map: checkerTex }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.012, 0);
      g.add(line);
      return g;
    },
    arch(it) {
      const g = new THREE.Group();
      const span = LAYOUTS.circuit.armcoX * 2 + 1;
      for (const x of [-span / 2, span / 2]) g.add(box(0.5, 7, 0.5, steel, x, 3.5, 0));
      const banner = new THREE.Mesh(new THREE.BoxGeometry(span, 1.5, 0.3),
        [steel, steel, steel, steel, textMat(it.text || 'FORMULASIM', '#12151c', '#ffffff'), textMat(it.text || 'FORMULASIM', '#12151c', '#ffffff')]);
      banner.position.set(0, 7.2, 0);
      g.add(banner);
      return g;
    },
  };

  let sceneryObjs = [];   // [{ obj, it, key }]
  function buildScenery() {
    for (const o of sceneryObjs) sceneryGrp.remove(o.obj);
    sceneryObjs = [];
    for (const it of scenery.items) {
      const make = PREFABS[it.type];
      if (!make) continue;
      const obj = make(it);
      obj.visible = false;
      obj.traverse(c => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; } });
      sceneryGrp.add(obj);
      sceneryObjs.push({ obj, it, key: '' });
    }
  }

  const SCENERY_BEHIND = 150, SCENERY_AHEAD = 300;
  function updateScenery(path) {
    sceneryGrp.visible = !!layout.circuit && !!path.circuit;
    if (!sceneryGrp.visible) return;
    const sCar = path.pose.s;
    for (const o of sceneryObjs) {
      const sT = path.trackSOfLap(o.it.s);
      const d = sT - sCar;
      if (!(d > -SCENERY_BEHIND && d < SCENERY_AHEAD)) { o.obj.visible = false; continue; }
      o.obj.visible = true;
      const key = `${path.epoch}|${Math.round(sT * 4)}`;
      if (o.key === key) continue;              // track-space position unchanged
      o.key = key;
      const side = o.it.side ?? 1;
      const x = side * (o.it.lateral ?? 0) + path.centerOffsetAt(sT);
      const room = path.sideRoomAt(sT, Math.sign(x) || 1);
      const gh = groundOffset(room.room, room.dh, x);
      if (gh === null) { o.obj.visible = false; o.key = ''; continue; }
      const rp = rowPose(path, sT, x);
      o.obj.position.set(rp.x, SURFACE_Y + path.heightAt(sT) + gh, rp.z);
      // Left-hand items are turned round so their local +x still points
      // away from the road.
      o.obj.rotation.y = rp.rotY + (side < 0 ? Math.PI : 0);
    }
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

  /**
   * Switch the roadside between the test-track apron and a real circuit.
   * @param {'test'|'circuit'} name
   * @param {object|null} circuit      — buildCircuit() result (for scenery)
   * @param {Array|null}  sceneryDefs  — circuits/*-scenery.js definition
   */
  function setLayout(name, circuit = null, sceneryDefs = null) {
    layout = LAYOUTS[name] || LAYOUTS.test;
    layoutVer += 1;                                   // every pooled row re-places
    scenery = (layout.circuit && circuit && sceneryDefs)
      ? expandScenery(sceneryDefs, circuit)
      : { items: [], pitlanes: [], keepOut: [] };
    buildScenery();
  }

  /* Re-place every out-of-date row + rebuild the ground ribbons. */
  function update(path) {
    updateGround(path);
    for (const p of pools) p.update(path);
    updateTrees(path);
    updateScenery(path);
  }

  return { group: grp, groundTex, update, setArcadeProps, setLayout, WINDOW_BEHIND, WINDOW_AHEAD };
}
