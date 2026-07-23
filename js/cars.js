/**
 * cars.js — Procedural 3D car model builder for Three.js
 *
 * Complete rebuild — Option D "Detailed Realistic":
 *   • Correct real-world proportions for each class
 *   • Layered body construction (floor, lower tub, upper tub, engine cover)
 *   • More aero parts: floor fences, bargeboard stacks, DRS endplates,
 *     dive planes, beam wings, diffuser strakes, swan-neck mounts
 *   • Proper GT fastback roofline (stacked angled slabs)
 *   • All-new suspension geometry (upper + lower wishbones + push rod)
 *
 * Coordinate system (car at rest):
 *   +Z = rear   −Z = nose   +Y = up   −X = left   +X = right
 * grp.position.y lifts car so wheels sit on track surface (y = TRACK.SURFACE_Y).
 */

import * as THREE from 'three';
import { CAR_MANIFEST } from './car-manifest.js';
import { loadCarFromManifest } from './car-loader.js';
import { TRACK } from './scene-config.js';

/* ── Feature flag — flip per-car once GLBs are aligned ──
 * F1: GLB body + per-corner split wheels via buildF1Hybrid (see car-loader).
 * GT: GLB body + GLB wheels via buildGTHybrid. gt.glb is monolithic (no
 *     named wheel nodes) but the four wheels are connected-geometry islands
 *     inside the mega-mesh; the loader's buildWheelsFromMonolith extracts
 *     them into spinnable FL/FR/RL/RR corner groups (manifest.wheelBake)
 *     and measures axles/radius from the tire islands. Any split failure
 *     falls back to the fully procedural GT — never a partial mix.
 * F2 / F3: removed for now — will return in a later phase.
 */
export const USE_IMPORTED_MODELS = { F1: true, GT: true };

/* ── Livery clone-and-tint helper ─────────────────────────────────── */
function applyLivery(meshes, color) {
  const c = new THREE.Color(color);
  meshes.forEach(m => {
    if (!m.material) return;
    m.material = m.material.clone();
    if (m.material.color) m.material.color.copy(c);
  });
}

/* ── Shared material helpers ──────────────────────────────────── */

function makeMat(color, rough = 0.25, metal = 0.8, emissive = 0x000000, emissiveInt = 0) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, emissive, emissiveIntensity: emissiveInt,
  });
}

function makeBodyMat(color) {
  const sheenColor = new THREE.Color(color).offsetHSL(0, 0.15, 0.08);
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.10, metalness: 0.90,
    clearcoat: 0.55, clearcoatRoughness: 0.15,
    envMapIntensity: 1.4,
    sheen: 0.4, sheenRoughness: 0.35, sheenColor,
    iridescence: 0.08, iridescenceIOR: 1.6,
  });
}

function makeCarbonMat(color = 0x0e0e0e, rough = 0.40, metal = 0.60) {
  const mat = new THREE.MeshPhysicalMaterial({
    color, roughness: rough, metalness: metal,
    clearcoat: 0.4, clearcoatRoughness: 0.25,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vCarbonPos;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>',
      `#include <fog_vertex>
       vCarbonPos = (modelMatrix * vec4(position, 1.0)).xyz;`);
    shader.fragmentShader = 'varying vec3 vCarbonPos;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>',
      `#include <color_fragment>
       {
         float SCALE = 160.0;
         float cx = floor(vCarbonPos.x * SCALE);
         float cz = floor(vCarbonPos.z * SCALE);
         float cell = mod(cx + cz, 2.0);
         vec2 uv = fract(vec2(vCarbonPos.x, vCarbonPos.z) * SCALE);
         float rib = smoothstep(0.35, 0.50, mix(uv.x, uv.y, cell))
                   - smoothstep(0.50, 0.65, mix(uv.x, uv.y, cell));
         float weave = 0.80 + rib * 0.28;
         float shimmer = 0.5 + 0.5 * sin(vCarbonPos.x * 320.0 + vCarbonPos.z * 80.0);
         diffuseColor.rgb *= weave;
         diffuseColor.rgb += vec3(shimmer * 0.04);
       }`);
  };
  return mat;
}

/* ── Geometry shortcuts ───────────────────────────────────────── */
function box(w, h, d)              { return new THREE.BoxGeometry(w, h, d); }
function cyl(rt, rb, h, seg = 32)  { return new THREE.CylinderGeometry(rt, rb, h, seg); }
function sph(r, ws = 16, hs = 16)  { return new THREE.SphereGeometry(r, ws, hs); }
function cone(r, h, seg = 20)      { return new THREE.ConeGeometry(r, h, seg, 1); }

/* ── Smooth body geometry helpers ─────────────────────────────── */

/** Rounded-edge rectangular panel — ExtrudeGeometry with rounded-rect Shape.
 *  Cross-section: w × h in XY.  Depth d along Z.  Centered on Z. */
function rBox(w, h, d, r) {
  if (r === undefined) r = Math.min(w, h) * 0.16;
  r = Math.min(r, w * 0.45, h * 0.45);
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo( w / 2 - r, -h / 2); s.quadraticCurveTo( w / 2, -h / 2,  w / 2, -h / 2 + r);
  s.lineTo( w / 2,  h / 2 - r); s.quadraticCurveTo( w / 2,  h / 2,  w / 2 - r,  h / 2);
  s.lineTo(-w / 2 + r,  h / 2); s.quadraticCurveTo(-w / 2,  h / 2, -w / 2,  h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);   // center on Z
  return g;
}

/** Elliptical cross-section body — zero corners, continuous curvature. Centered on Z. */
function ovalPod(w, h, d, N = 24) {
  const s = new THREE.Shape();
  for (let i = 0; i <= N; i++) {
    const θ = (i / N) * Math.PI * 2;
    if (i === 0) s.moveTo((w/2)*Math.cos(θ), (h/2)*Math.sin(θ));
    else         s.lineTo((w/2)*Math.cos(θ), (h/2)*Math.sin(θ));
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Tapered oval barrel. Front face wF×hF at z=−len/2, rear face wR×hR at z=+len/2. */
function ovalSweep(wF, hF, wR, hR, len, N = 24, segs = 14) {
  const pos = new Float32Array(((segs + 1) * N + 2) * 3);
  const idx = [];
  let vi = 0;
  const vSet = (x, y, z) => { pos[vi*3]=x; pos[vi*3+1]=y; pos[vi*3+2]=z; vi++; };

  for (let si = 0; si <= segs; si++) {
    const t = si / segs;
    const w = wF + (wR-wF)*t,  h = hF + (hR-hF)*t,  z = -len/2 + t*len;
    for (let ni = 0; ni < N; ni++) {
      const θ = (ni/N)*Math.PI*2;
      vSet((w/2)*Math.cos(θ), (h/2)*Math.sin(θ), z);
    }
  }
  const frontCap = vi;  vSet(0, 0, -len/2);
  const rearCap  = vi;  vSet(0, 0,  len/2);

  for (let si = 0; si < segs; si++)
    for (let ni = 0; ni < N; ni++) {
      const a=si*N+ni, b=si*N+(ni+1)%N, c=(si+1)*N+(ni+1)%N, d=(si+1)*N+ni;
      idx.push(a,b,c, a,c,d);
    }
  for (let ni = 0; ni < N; ni++) idx.push(frontCap, (ni+1)%N, ni);
  const rB = segs*N;
  for (let ni = 0; ni < N; ni++) idx.push(rearCap, rB+ni, rB+(ni+1)%N);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** NACA-style airfoil cross-section wing.
 *  Span along X (centered), chord along Z (centered), camber along Y.
 *  Upper (suction) surface is more curved; lower (pressure) is flatter. */
function wingGeo(span, chord, thickness) {
  const N = 20, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push(new THREE.Vector2(chord * t - chord / 2,
                               thickness * 0.60 * Math.sin(t * Math.PI)));
  }
  for (let i = N - 1; i >= 1; i--) {
    const t = i / N;
    pts.push(new THREE.Vector2(chord * t - chord / 2,
                               -thickness * 0.28 * Math.sin(t * Math.PI)));
  }
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts),
                                      { depth: span, bevelEnabled: false });
  g.rotateY(-Math.PI / 2);
  g.translate(span / 2, 0, 0);
  return g;
}

/** Smooth oval nose cone.  Base at z=0, tip at z=−length. */
function noseTip(baseW, baseH, length) {
  const g = new THREE.ConeGeometry(1, length, 24, 4);
  g.rotateX(-Math.PI / 2);           // apex toward −Z (front)
  g.translate(0, 0, -length / 2);    // base at z=0, tip at z=−length
  g.scale(baseW / 2, baseH / 2, 1);
  return g;
}

/** High-fidelity ogive nose using LatheGeometry for smooth power-law curvature.
 *  Produces a continuous C¹ surface vs the faceted ConeGeometry hack.
 *  Base at z=0, tip at z=−length.  Cross-section oval: baseW × baseH. */
function ogiveNose(baseW, baseH, length) {
  const N = 24, pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = Math.pow(1 - t, 0.72); // ogive power law
    pts.push(new THREE.Vector2(Math.max(0.003, r), t * length));
  }
  const geo = new THREE.LatheGeometry(pts, 32);
  geo.rotateX(-Math.PI / 2);         // tip toward −Z
  geo.scale(baseW / 2, baseH / 2, 1);
  return geo;
}

function mesh(geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow    = true;
  m.receiveShadow = true;
  return m;
}

/* ── Wheel assembly — 5-spoke Y-design ───────────────────────── */
function wheel(radius, width, matHub, matTyre, wheelName = '') {
  const grp = new THREE.Group();

  // Tyre body — wide, low-profile (18″ 2022 spec)
  const tyre = mesh(cyl(radius, radius, width, 52), matTyre);
  tyre.rotation.z = Math.PI / 2;
  grp.add(tyre);

  // Tyre sidewall rings — distinct outer band at each edge
  for (const ox of [-width * 0.44, width * 0.44]) {
    const sw = mesh(cyl(radius * 1.02, radius * 1.02, width * 0.08, 52), matTyre);
    sw.rotation.z = Math.PI / 2;
    sw.position.x = ox;
    grp.add(sw);
  }

  // Rim — outer lip rings (one per side, slightly proud of barrel)
  for (const ox of [-width * 0.46, width * 0.46]) {
    const lip = mesh(cyl(radius * 0.62, radius * 0.62, width * 0.12, 24), matHub);
    lip.rotation.z = Math.PI / 2;
    lip.position.x = ox;
    grp.add(lip);
  }
  // Rim inner barrel (recessed)
  const barrel = mesh(cyl(radius * 0.56, radius * 0.56, width * 0.80, 18), matHub);
  barrel.rotation.z = Math.PI / 2;
  grp.add(barrel);

  // 5 main spokes — wide machined face
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const spoke = mesh(box(radius * 0.86, radius * 0.14, width * 0.08), matHub);
    spoke.rotation.z = angle;
    grp.add(spoke);
  }
  // 5 inner accent pins (offset 36°)
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + Math.PI / 5;
    const pin = mesh(box(radius * 0.50, radius * 0.040, width * 0.04), matHub);
    pin.rotation.z = angle;
    grp.add(pin);
  }

  // Centre cap — flat-face disc
  const cap = mesh(cyl(radius * 0.18, radius * 0.18, width * 0.05, 14), matHub);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = width * 0.44;
  grp.add(cap);
  // Raised wheel nut (hexagonal)
  const nut = mesh(cyl(radius * 0.10, radius * 0.10, width * 0.06, 6), makeMat(0xffcc00, 0.08, 1.0));
  nut.rotation.z = Math.PI / 2;
  nut.position.x = width * 0.50;
  grp.add(nut);

  // Brake disc
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, roughness: 0.35, metalness: 0.85,
    emissive: new THREE.Color(0xff3300), emissiveIntensity: 0,
  });
  const disc = new THREE.Mesh(cyl(radius * 0.56, radius * 0.56, 0.034, 24), brakeMat);
  disc.name = `brake_${wheelName}`;
  disc.rotation.z = Math.PI / 2;
  disc.position.x = 0.04;
  grp.add(disc);

  // Brake caliper — red saddle over disc
  const caliperMat = new THREE.MeshPhysicalMaterial({
    color: 0xdd1100, roughness: 0.18, metalness: 0.60,
    clearcoat: 0.8, clearcoatRoughness: 0.12,
    emissive: new THREE.Color(0xff3300), emissiveIntensity: 0,
  });
  const caliper = new THREE.Mesh(rBox(0.08, 0.18, width * 0.55, 0.010), caliperMat);
  caliper.name = `brake_cal_${wheelName}`;
  caliper.position.set(-0.02, 0, 0);
  caliper.castShadow = true;
  grp.add(caliper);

  // 6 radial slots — cross-drilled / ventilated disc appearance
  const slotMat = makeMat(0x0a0a0a, 0.6, 0.4);
  for (let si = 0; si < 6; si++) {
    const angle = (si / 6) * Math.PI * 2;
    const slot = mesh(box(radius * 0.36, radius * 0.022, 0.036), slotMat);
    slot.rotation.z = angle;
    slot.position.x = 0.04;
    grp.add(slot);
  }

  grp.castShadow = true;
  return grp;
}

/* ── GT road-car wheel — multi-spoke alloy, flush centre-lock ─────
 * Styled after the 992 GT3 RS magnesium centre-lock wheel. Key visual
 * differences vs the formula-style `wheel()`:
 *   • 10 thin spokes (not 5 wide) — multi-spoke alloy look
 *   • No raised wheel nut — flush centre-lock cap
 *   • Yellow brake caliper (PCCB option, identifies a GT3 RS)
 *   • Taller-sidewall street tyre (no pronounced sidewall rings)
 * Signature matches `wheel()` so call sites are interchangeable.
 */
function gtWheel(radius, width, matHub, matTyre, wheelName = '') {
  const grp = new THREE.Group();

  // Street tyre — plain sidewall, no racing rings.
  const tyre = mesh(cyl(radius, radius, width, 52), matTyre);
  tyre.rotation.z = Math.PI / 2;
  grp.add(tyre);

  // Rim lip rings (thin outer flange each side).
  for (const ox of [-width * 0.46, width * 0.46]) {
    const lip = mesh(cyl(radius * 0.72, radius * 0.72, width * 0.06, 32), matHub);
    lip.rotation.z = Math.PI / 2;
    lip.position.x = ox;
    grp.add(lip);
  }
  // Deep-dish barrel — concave face characteristic of a GT3 RS wheel.
  const barrel = mesh(cyl(radius * 0.66, radius * 0.66, width * 0.84, 24), matHub);
  barrel.rotation.z = Math.PI / 2;
  grp.add(barrel);

  // 10 thin radial spokes.
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const spoke = mesh(box(radius * 0.96, radius * 0.06, width * 0.05), matHub);
    spoke.rotation.z = angle;
    grp.add(spoke);
  }

  // Flush centre-lock cap — no protruding nut.
  const cap = mesh(cyl(radius * 0.22, radius * 0.22, width * 0.04, 24), matHub);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = width * 0.46;
  grp.add(cap);

  // Brake disc.
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x222222, roughness: 0.45, metalness: 0.80,
  });
  const disc = new THREE.Mesh(cyl(radius * 0.60, radius * 0.60, 0.032, 24), brakeMat);
  disc.name = `brake_${wheelName}`;
  disc.rotation.z = Math.PI / 2;
  disc.position.x = 0.03;
  grp.add(disc);

  // Yellow caliper — PCCB identifier on a 992 GT3 RS.
  const caliperMat = new THREE.MeshPhysicalMaterial({
    color: 0xf0c000, roughness: 0.25, metalness: 0.55,
    clearcoat: 0.7, clearcoatRoughness: 0.15,
  });
  const caliper = new THREE.Mesh(rBox(0.09, 0.20, width * 0.50, 0.012), caliperMat);
  caliper.name = `brake_cal_${wheelName}`;
  caliper.position.set(-0.02, 0, 0);
  caliper.castShadow = true;
  grp.add(caliper);

  grp.castShadow = true;
  return grp;
}

/* ── Suspension wishbone helper ───────────────────────────────── */
function wishbone(len, matCarbon, x, y, z, rz) {
  return mesh(cyl(0.013, 0.013, len, 8), matCarbon, x, y, z, 0, 0, rz);
}

/** Cylinder spanning two arbitrary 3D points — for anatomically correct suspension. */
function rod(ax, ay, az, bx, by, bz, radius, mat) {
  const a = new THREE.Vector3(ax, ay, az);
  const b = new THREE.Vector3(bx, by, bz);
  const len = a.distanceTo(b);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const m = new THREE.Mesh(cyl(radius, radius, len, 6), mat);
  m.position.copy(mid);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  m.castShadow = true;
  return m;
}

/* ── Car definitions ──────────────────────────────────────────── */

const CAR_META = {
  F1: { label: 'Formula One',   color: 0xe8132a },
  GT: { label: 'GT Race Car',   color: 0xff8800 },
};

/* ── Per-car livery panels ────────────────────────────────────── */
function buildLivery(grp, color, type) {
  const T = 0.004;
  if (type === 'F1') {
    const matW = makeBodyMat(0xffffff);
    const matS = makeBodyMat(0xcccccc);
    const numMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.05, metalness: 0.0,
      emissive: new THREE.Color(0xffffff), emissiveIntensity: 0,
      clearcoat: 0.55, clearcoatRoughness: 0.15,
    });
    grp.add(mesh(rBox(0.10, T, 0.80, 0.004), matW, 0, 0.175, -1.72));
    for (const s of [-1, 1])
      grp.add(mesh(rBox(0.20, T, 0.60, 0.003), matS, s * 0.535, 0.442, 0.28));
    grp.add(mesh(rBox(0.12, 0.09, T, 0.004), numMat, -0.33, 0.44, 0.44));

  } else if (type === 'GT') {
    const matB = makeBodyMat(0x111111);
    const matW = makeBodyMat(0xffffff);
    grp.add(mesh(rBox(0.22, T, 1.50, 0.004), matB, 0, 0.307, -1.50));
    grp.add(mesh(rBox(0.28, T, 1.20, 0.004), matW, 0, 0.662,  0.12));
    grp.add(mesh(rBox(1.60, 0.06, T, 0.003), matW, 0, 0.02,   2.215));
  }
}

/* ── F1 hybrid: GLB body + procedural wheels + livery ─────────────── */
export async function buildF1Hybrid({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const loaded = await loadCarFromManifest(CAR_MANIFEST.f1);
  if (!loaded) {
    console.warn('[buildF1Hybrid] GLB load failed — using procedural F1');
    return buildF1Procedural({ color });
  }

  grp.add(loaded.scene);
  applyLivery(loaded.liveryMeshes, color);

  // Derive wheel radius & positions from GLB tire bboxes (measured pre-strip by car-loader).
  // Fallback to procedural F1 defaults only if loader didn't provide a measurement.
  const gm = loaded.glbMeasure;
  const wR = gm ? gm.wheelRadius : 0.345;
  const wheelY = gm ? (gm.groundContactY + wR) : -0.04;
  const fX = gm ? gm.frontAxleX : 0.82;
  const rX = gm ? gm.rearAxleX  : 0.80;
  const fZ = gm ? gm.frontAxleZ : -1.50;
  const rZ = gm ? gm.rearAxleZ  :  1.60;
  const wPos = {
    wFL: [-fX, wheelY, fZ],
    wFR: [ fX, wheelY, fZ],
    wRL: [-rX, wheelY, rZ],
    wRR: [ rX, wheelY, rZ],
  };

  // GLB-success path: attach the real split wheel groups instead of procedural.
  // Fallback path (no wheelsRoot): build procedural cylinder wheels at the
  // same measured axle points — this covers the case where GLB loaded but
  // split failed OR wheelSources was omitted from the manifest.
  if (loaded.wheelsRoot) {
    grp.add(loaded.wheelsRoot);
    grp.userData.wheels = { ...loaded.wheelsRoot.children.reduce((o, g) => { o[g.name] = g; return o; }, {}) };
  } else {
    const matTyre = makeMat(0x0d0d0d, 0.92, 0.04);
    const matHub  = makeMat(0xe0e0e0, 0.08, 1.00);
    const wW = 0.340;
    Object.entries(wPos).forEach(([n, [x, y, z]]) => {
      const w = wheel(wR, wW, matHub, matTyre, n);
      w.name = n; w.position.set(x, y, z); grp.add(w);
    });
  }

  const measure = measureFromWheels(wPos, wR);
  // Forward GLB-measured per-feature anchors to consumers. Keys: cockpit,
  // halo, frontWing, rearWing, sidepodTop (synthesised by car-loader), floor,
  // noseTip. Falls back to procedural-F1 anchor template if loader didn't
  // measure any (e.g. GLB missing the named meshes).
  measure.anchors = (gm && gm.anchors) ? gm.anchors : proceduralAnchors('F1');
  grp.userData.measure = measure;
  grp.userData.baseY   = TRACK.SURFACE_Y - measure.groundContactY;
  grp.position.y       = grp.userData.baseY;
  return grp;
}

/* ── GT hybrid: monolithic GLB body + procedural wheels ───────────── */

/**
 * Union the bboxes of meshes whose name matches `includeRe`. The whole-scene
 * Box3.setFromObject is too noisy on gt.glb — its bbox is dominated by the
 * rear-wing strut (z extends 1.5m past the bumper) and a node-transformed
 * hood (y peaks far above the roofline). Filtering to bodyshell-named meshes
 * gives the true envelope we want for axle placement.
 *
 * Returns null when no mesh matches — callers should fall back to the full
 * scene bbox so degraded GLBs still render.
 */
function measureBodyshellBbox(scene, includeRe) {
  if (!scene || typeof scene.traverse !== 'function') return null;
  const bbox = new THREE.Box3();
  bbox.makeEmpty?.();
  let matched = false;
  scene.traverse(obj => {
    if (!obj?.isMesh) return;
    if (!includeRe.test(obj.name || '')) return;
    obj.updateMatrixWorld?.(true);
    const mb = new THREE.Box3().setFromObject(obj);
    bbox.union(mb);
    matched = true;
  });
  return matched ? bbox : null;
}

// Name regex for the GT bodyshell envelope. Includes the chassis, chrome
// trim (bumper edges), front hood, and headlights — every mesh that defines
// the *outer* car envelope. Excludes rear wing, sideskirts (sometimes wildly
// extended in node-local frames), and all interior nodes (dash, seat,
// steering, gauges) that shouldn't influence axle math.
const GT_BODYSHELL_RE = /body_gt3rs|body_chrome|carbon_hood|headlight_L_led/i;

export async function buildGTHybrid({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const loaded = await loadCarFromManifest(CAR_MANIFEST.gt);
  if (!loaded) {
    console.warn('[buildGTHybrid] GLB load failed — using procedural GT');
    return buildGTProcedural({ color });
  }

  // Single-source guarantee: gt.glb's wheels are baked into the mega-mesh,
  // so rendering the GLB without a successful wheel split would show static
  // wheels (and any procedural overlay would double them). If the loader's
  // connectivity split (buildWheelsFromMonolith via manifest.wheelBake)
  // didn't deliver both the corner groups AND the measurement, use the
  // fully procedural car instead.
  const gm = loaded.glbMeasure;
  if (!loaded.wheelsRoot || !gm) {
    console.warn('[buildGTHybrid] GLB wheel split failed — using procedural GT');
    return buildGTProcedural({ color });
  }

  grp.add(loaded.scene);
  applyLivery(loaded.liveryMeshes, color);

  grp.add(loaded.wheelsRoot);
  grp.userData.wheels = loaded.wheelsRoot.children.reduce((o, g) => { o[g.name] = g; return o; }, {});

  // Measurement is a passthrough of the loader's tire-island data — scene
  // clutter (rear-wing strut, transformed hood) cannot perturb placement.
  const wheelY = gm.groundContactY + gm.wheelRadius;
  const wPos = {
    wFL: [-gm.frontAxleX, wheelY, gm.frontAxleZ],
    wFR: [ gm.frontAxleX, wheelY, gm.frontAxleZ],
    wRL: [-gm.rearAxleX,  wheelY, gm.rearAxleZ],
    wRR: [ gm.rearAxleX,  wheelY, gm.rearAxleZ],
  };
  const measure = measureFromWheels(wPos, gm.wheelRadius);

  // Anchor merge: bbox-synthesised entries fill every key (frontWing,
  // diffuser, noseTip, …), then MEASURED GLB anchors (roof, cockpit,
  // bodyShell, role-tagged vents from manifest.anchorSources) override and
  // extend them. Airflow/CFD/vents see measured geometry wherever the GLB
  // can provide it.
  const bbox = measureBodyshellBbox(loaded.scene, GT_BODYSHELL_RE)
            || new THREE.Box3().setFromObject(loaded.scene);
  measure.anchors = { ...synthesiseGTAnchors(bbox), ...(gm.anchors || {}) };

  grp.userData.measure = measure;
  grp.userData.baseY   = TRACK.SURFACE_Y - measure.groundContactY;
  grp.position.y       = grp.userData.baseY;
  return grp;
}

// gt.glb has no per-feature named meshes, so feature anchors are synthesised
// from the scene bbox. Keys mirror PROCEDURAL_ANCHORS so airflow, vents, and
// CFD all see the same anchor contract as F1.
function synthesiseGTAnchors(bbox) {
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cy = (bbox.min.y + bbox.max.y) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  return {
    cockpit:    { x: cx, y: cy + 0.10,        z: cz - 0.20 },
    halo:       { x: cx, y: bbox.max.y - 0.05, z: cz - 0.10 },
    frontWing:  { x: cx, y: bbox.min.y + 0.10, z: bbox.min.z + 0.05 },
    rearWing:   { x: cx, y: bbox.max.y - 0.10, z: bbox.max.z - 0.10 },
    sidepodTop: { x: cx, y: cy,               z: cz },
    floor:      { x: cx, y: bbox.min.y,       z: cz },
    diffuser:   { x: cx, y: bbox.min.y,       z: bbox.max.z - 0.20 },
    noseTip:    { x: cx, y: bbox.min.y + 0.25, z: bbox.min.z },
  };
}

/* ── P5: cockpit steering wheel ───────────────────────────────────── *
 * Procedural wheel group for BOTH F1 paths (GLB hybrid + procedural) and
 * GT. Built in a local frame with the wheel face in the XY plane (facing
 * +Z, toward the driver); main.js places it off the cockpit anchor, tilts
 * the column about X, and drives rotation.z from state.steerVis.          */
export function buildSteeringWheel(type) {
  const grp = new THREE.Group();
  grp.name = 'steeringWheel';
  const matRim = makeMat(0x141414, 0.55, 0.25);
  const matHub = makeMat(0x0a0a0a, 0.40, 0.50);

  if (type === 'GT') {
    // Road-car wheel: torus Ø0.36 / tube 0.02 + 3 spokes (9-, 3-, 6-o'clock).
    const rim = mesh(new THREE.TorusGeometry(0.18, 0.02, 12, 32), matRim);
    rim.name = 'sw_rim';
    grp.add(rim);
    for (const ang of [0, Math.PI, -Math.PI / 2]) {   // right, left, bottom
      const spoke = mesh(box(0.16, 0.028, 0.018), matHub,
        Math.cos(ang) * 0.085, Math.sin(ang) * 0.085, 0, 0, 0, ang);
      spoke.name = 'sw_spoke';
      grp.add(spoke);
    }
  } else {
    // F1: flat-bottom rectangular wheel — rounded-rect rim + 2 grips + hub screen.
    const rim = mesh(rBox(0.27, 0.17, 0.03, 0.045), matRim);
    rim.name = 'sw_rim';
    grp.add(rim);
    for (const sx of [-1, 1]) {
      const grip = mesh(box(0.045, 0.15, 0.045), matRim, sx * 0.145, 0, 0);
      grip.name = 'sw_grip';
      grp.add(grip);
    }
    const screen = mesh(rBox(0.09, 0.06, 0.012, 0.008), makeMat(0x061018, 0.2, 0.1, 0x2266aa, 0.6), 0, 0.015, 0.018);
    screen.name = 'sw_screen';
    grp.add(screen);
  }
  return grp;
}

export async function buildCar(type) {
  const meta = CAR_META[type] || CAR_META.F1;
  const flag = USE_IMPORTED_MODELS;
  switch (type) {
    case 'GT':
      return (flag?.GT === true)
        ? buildGTHybrid(meta)
        : buildGTProcedural(meta);
    default:
      return (flag === true || flag?.F1 === true)
        ? buildF1Hybrid(meta)
        : buildF1Procedural(meta);
  }
}

export function getCarMeta(type) { return CAR_META[type] || CAR_META.F1; }
export const WHEEL_NAMES = ['wFL', 'wFR', 'wRL', 'wRR'];

/**
 * Build the measurement contract from procedural wheel positions.
 * groundContactY is the car-LOCAL Y of the lowest ground-touching point (wheel bottom).
 * Consumers (main.js, debug overlay) translate to world-Y via TRACK.SURFACE_Y - groundContactY.
 */
function measureFromWheels(wPos, wR) {
  return {
    groundContactY: wPos.wFL[1] - wR,
    frontAxleZ:     wPos.wFL[2],
    rearAxleZ:      wPos.wRL[2],
    frontAxleX:     Math.abs(wPos.wFL[0]),
    rearAxleX:      Math.abs(wPos.wRL[0]),
    wheelbase:      Math.abs(wPos.wRL[2] - wPos.wFL[2]),
    trackWidth:     2 * Math.abs(wPos.wFL[0]),
    wheelRadius:    wR,
  };
}

/**
 * Per-feature anchor coordinates in car-LOCAL space (pre-baseY lift).
 * Each anchor is { x, y, z } in car-local coordinates, matching the authored
 * geometry positions. Effect/camera consumers translate by baseY to world.
 *
 * For GLB variants the loader measures anchors from named mesh bboxes; for
 * procedural cars we synthesise from the known local coordinates authored
 * in the build functions. Keys: cockpit, halo, frontWing, rearWing,
 * sidepodTop, floor, diffuser, noseTip.
 */
const PROCEDURAL_ANCHORS = {
  F1: {
    cockpit:    { x: 0, y: 0.55, z: 0.30 },    // cockpit tub top centre
    halo:       { x: 0, y: 1.06, z: 0.42 },    // halo arch peak
    frontWing:  { x: 0, y: 0.04, z: -2.60 },   // main-plane center
    rearWing:   { x: 0, y: 0.98, z:  1.95 },   // rearWingGrp origin
    sidepodTop: { x: 0, y: 0.46, z:  0.28 },   // sidepod top-face center
    floor:      { x: 0, y: 0.04, z:  0.00 },   // floor panel top centre
    diffuser:   { x: 0, y:-0.044,z:  1.93 },   // diffuser centre
    noseTip:    { x: 0, y: 0.08, z: -2.72 },   // ogiveNose apex
  },
  GT: {
    cockpit:    { x: 0, y: 0.60, z: 0.00 },    // roof interior / driver head
    halo:       { x: 0, y: 0.72, z: 0.12 },    // GT uses roof peak as "halo"
    frontWing:  { x: 0, y: 0.00, z: -2.32 },   // front splitter
    rearWing:   { x: 0, y: 0.84, z:  1.92 },   // rear wing pivot
    sidepodTop: { x: 0, y: 0.44, z:  0.12 },   // belt-line
    floor:      { x: 0, y: 0.03, z:  0.00 },
    diffuser:   { x: 0, y:-0.095,z:  2.14 },
    noseTip:    { x: 0, y: 0.00, z: -2.48 },
  },
};

/**
 * Vent/duct anchor template — 10 entries mirroring the McLaren GLB manifest.
 * Each entry is synthesised from an existing PROCEDURAL_ANCHORS entry + an
 * offset tuned so the procedural variants (F1 proc / GT) read the
 * same as the GLB on screen. Offsets are authored in car-local space; the
 * reference halfW for offset scaling is the McLaren bodyShell (≈0.81 m
 * half-width), but for procedural cars we use the profile-authored body
 * proportions directly — numbers chosen to land inlets on the sidepod inlet
 * mouth and outlets in the tail-pipe area of each body.
 *
 * Directions copied verbatim from the GLB manifest; role likewise.
 * Auto-mirror (L→R) handled inline rather than via a 'mirrored' field to
 * keep the PROCEDURAL_ANCHORS shape strictly numeric.
 */
function _buildProceduralVentAnchors(base) {
  const bs = base.sidepodTop ?? base.bodyShell;   // fall back to bodyShell if present
  const fw = base.frontWing;
  const rw = base.rearWing;
  const halo = base.halo;
  const unit = (x, y, z) => {
    const L = Math.sqrt(x * x + y * y + z * z) || 1;
    return { x: x / L, y: y / L, z: z / L };
  };
  const vents = {};
  if (bs) {
    vents.sidepodInletL   = { x: bs.x - 0.70, y: bs.y + 0.00, z: bs.z - 0.40, direction: unit( 0.25, 0, -1), role: 'inlet'  };
    vents.sidepodInletR   = { x: -vents.sidepodInletL.x, y: vents.sidepodInletL.y, z: vents.sidepodInletL.z, direction: unit(-0.25, 0, -1), role: 'inlet' };
    vents.sidepodExhaustL = { x: bs.x - 0.60, y: bs.y + 0.05, z: bs.z + 1.20, direction: unit(-0.10, 0,  1), role: 'outlet' };
    vents.sidepodExhaustR = { x: -vents.sidepodExhaustL.x, y: vents.sidepodExhaustL.y, z: vents.sidepodExhaustL.z, direction: unit( 0.10, 0, 1), role: 'outlet' };
  }
  if (halo) {
    vents.airboxIntake = { x: halo.x, y: halo.y + 0.30, z: halo.z - 0.20, direction: unit(0, -0.3, -1), role: 'inlet' };
  }
  if (rw) {
    vents.exhaustPipe    = { x: rw.x, y: rw.y - 0.30, z: rw.z - 0.15, direction: unit(0, 0.1, 1), role: 'outlet' };
    vents.rearBrakeDuctL = { x: rw.x - 0.90, y: rw.y + 0.30, z: rw.z - 0.40, direction: unit( 0.10, 0, -1), role: 'inlet' };
    vents.rearBrakeDuctR = { x: -vents.rearBrakeDuctL.x, y: vents.rearBrakeDuctL.y, z: vents.rearBrakeDuctL.z, direction: unit(-0.10, 0, -1), role: 'inlet' };
  }
  if (fw) {
    vents.frontBrakeDuctL = { x: fw.x - 0.45, y: fw.y + 0.15, z: fw.z + 0.10, direction: unit( 0.10, 0, -1), role: 'inlet' };
    vents.frontBrakeDuctR = { x: -vents.frontBrakeDuctL.x, y: vents.frontBrakeDuctL.y, z: vents.frontBrakeDuctL.z, direction: unit(-0.10, 0, -1), role: 'inlet' };
  }
  return vents;
}

/**
 * Merge the vent-anchor template onto every PROCEDURAL_ANCHORS entry so
 * consumers (VentEmitterSystem, later modifier table) see the same anchor
 * surface on GLB and procedural paths.
 */
for (const type of Object.keys(PROCEDURAL_ANCHORS)) {
  const base = PROCEDURAL_ANCHORS[type];
  Object.assign(base, _buildProceduralVentAnchors(base));
}

function proceduralAnchors(type) {
  return PROCEDURAL_ANCHORS[type] || PROCEDURAL_ANCHORS.F1;
}

/* ════════════════════════════════════════════════════════════════
   F1  —  2022+ ground-effect open-wheel single-seater
   Wheelbase ~3.10 u  |  Track ~1.60 u  |  Wheel radius 0.345 u
════════════════════════════════════════════════════════════════ */
function buildF1Procedural({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const matBody   = makeBodyMat(color);
  const matCarbon = makeCarbonMat(0x0e0e0e, 0.40, 0.60);
  const matCfrp   = makeCarbonMat(0x1a1a1a, 0.50, 0.50);
  const matTyre   = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub    = makeMat(0xe0e0e0, 0.08, 1.00);
  const matCockpit= makeMat(0x050505, 0.05, 0.20, 0x001133, 0.6);
  const matHalo   = makeMat(0xdddddd, 0.06, 1.00);
  const matHelmet = makeBodyMat(0xffffff);
  const matVisor  = new THREE.MeshPhysicalMaterial({
    color: 0x334455, transmission: 0.5, roughness: 0.04,
    metalness: 0.1, transparent: true, opacity: 0.80, depthWrite: false,
  });
  const matGold   = makeMat(0xffcc00, 0.08, 1.0);

  /* ── FLOOR / UNDERTRAY ─────────────────────────────────────── */
  // Wide flat 2022 ground-effect floor — most important aero piece
  grp.add(mesh(box(1.44, 0.065, 4.20), matCarbon, 0, 0.04, -0.05));
  // Floor edge sideskirt (sealing vortex)
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.028, 0.10, 3.80), matCarbon, s * 0.71, 0.09, 0.00));
    // Floor fences (generate downforce tunnels)
    for (let fi = 0; fi < 4; fi++) {
      grp.add(mesh(box(0.022, 0.12, 0.70), matCarbon, s * (0.36 + fi * 0.08), 0.09, 0.30 + fi * 0.22));
    }
  }

  /* ── MONOCOQUE / SURVIVAL CELL — 4 rounded-edge layers ─────── */
  // Layer 1: lower tub (widest, flattest)
  grp.add(mesh(rBox(0.78, 0.12, 3.55, 0.04), matBody, 0, 0.13, 0.05));
  // Layer 2: mid tub (proper monocoque width)
  grp.add(mesh(ovalPod(0.64, 0.24, 2.85), matBody, 0, 0.30, -0.08));
  // Layer 3: upper section (narrows above driver knees)
  grp.add(mesh(ovalPod(0.50, 0.18, 1.80), matBody, 0, 0.47, -0.12));
  // Layer 4: shoulder-level sill (tightest — merges into cockpit surround)
  grp.add(mesh(rBox(0.38, 0.10, 1.26, 0.120), matBody, 0, 0.58, -0.08));

  /* ── SIDEPODS — 2022+ sharp-sidepod geometry ─────────────── */
  for (const s of [-1, 1]) {
    // Main pod volume — smooth tapering oval barrel
    grp.add(mesh(ovalSweep(0.36, 0.34, 0.22, 0.18, 1.90), matBody, s * 0.545, 0.22, 0.28));
    // Undercut — angled lower panel (generates vortex seal)
    const ucPanel = mesh(box(0.13, 0.18, 1.74), matCarbon, s * 0.610, 0.10, 0.30);
    ucPanel.rotation.z = s * 0.35;
    grp.add(ucPanel);
    // Inlet mouth — sharp rectangular opening
    grp.add(mesh(rBox(0.065, 0.32, 0.060, 0.008), matCockpit, s * 0.528, 0.22, -0.64));
    // Carbon fibre inlet surround lip
    grp.add(mesh(rBox(0.080, 0.340, 0.016, 0.005), matCarbon, s * 0.528, 0.22, -0.64));
    // Central divider vane inside inlet
    grp.add(mesh(box(0.010, 0.30, 0.048), matCarbon, s * 0.528, 0.22, -0.64));
    // Leading edge wedge — toed outward
    const ledge = mesh(rBox(0.018, 0.34, 0.10, 0.006), matCarbon, s * 0.490, 0.22, -0.67);
    ledge.rotation.y = s * 0.12;
    grp.add(ledge);
    // Louver mounting rail
    grp.add(mesh(box(0.24, 0.012, 0.46), matCarbon, s * 0.490, 0.428, 0.68));
    // Heat exchanger exit louvers — 5 slats, each angled
    for (let li = 0; li < 5; li++) {
      const louver = mesh(box(0.22, 0.028, 0.36), matCarbon, s * 0.490, 0.420 - li * 0.012, 0.70 + li * 0.26);
      louver.rotation.x = -0.15;
      grp.add(louver);
    }
    // Top winglet fin — angled inward
    const finGeo = wingGeo(0.18, 0.12, 0.018);
    const fin = mesh(finGeo, matCarbon, s * 0.530, 0.460, 0.22);
    fin.rotation.y = s * 0.22;
    grp.add(fin);
    // Bargeboard stack (in front of sidepod)
    for (let bi = 0; bi < 4; bi++) {
      const v = mesh(box(0.022, 0.22, 0.16), matCarbon, s * (0.38 + bi * 0.06), 0.08, -0.66 + bi * 0.05);
      v.rotation.y = s * (0.10 + bi * 0.06);
      grp.add(v);
    }
    // Louver cavity — dark recess behind louver slats
    grp.add(mesh(box(0.20, 0.13, 0.52), makeMat(0x050505, 0.9, 0.1), s * 0.490, 0.42, 0.72));
    // Under-pod turning vane — generates vortex under floor
    grp.add(mesh(box(0.30, 0.018, 0.24), matCarbon, s * 0.545, 0.02, -0.42));
    // Vortex generators — 4× small fins on undercut
    for (let vi = 0; vi < 4; vi++) {
      grp.add(mesh(box(0.014, 0.090, 0.030), matCarbon, s * 0.610, 0.10, -0.20 + vi * 0.32));
    }
  }

  /* ── ENGINE COVER — single tapering oval spine ─────────────── */
  grp.add(mesh(ovalSweep(0.50, 0.30, 0.28, 0.16, 1.62), matBody, 0, 0.38, 1.51));
  // Engine air intake
  grp.add(mesh(box(0.16, 0.32, 0.22), matCarbon, 0, 0.60, 0.96));
  grp.add(mesh(cone(0.080, 0.22, 12), matCarbon, 0, 0.76, 0.84, -Math.PI / 2, 0, 0));
  // T-wing / monkey seat above diffuser
  grp.add(mesh(box(0.72, 0.024, 0.24), matCarbon, 0, 0.42, 2.06));

  /* ── NOSE — sculpted transitions + oval noseTip ─────────────── */
  // Transition 1: nose-to-tub (wide at tub, narrows)
  grp.add(mesh(rBox(0.50, 0.17, 0.88, 0.06), matBody, 0, 0.16, -1.72));
  // Transition 2: step — the characteristic 2022 "platypus" shape
  grp.add(mesh(rBox(0.34, 0.14, 0.88, 0.05), matBody, 0, 0.11, -2.16));
  // Ogive nose cone — smooth continuous curvature
  grp.add(mesh(ogiveNose(0.30, 0.13, 0.51), matBody, 0, 0.09, -2.60));
  // Camera pods (small aero bumps at nose sides)
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.038, 0.038, 0.09, 10), matCfrp, s * 0.15, 0.06, -1.95, 0, 0, Math.PI / 2));
    grp.add(mesh(cyl(0.024, 0.024, 0.042, 10), makeMat(0x001144, 0.1, 0.3), s * 0.205, 0.06, -1.95, 0, 0, Math.PI / 2));
  }
  // S-duct outlet (top of nose)
  grp.add(mesh(box(0.10, 0.04, 0.14), matCarbon, 0, 0.16, -2.22));

  /* ── COCKPIT ──────────────────────────────────────────────── */
  grp.add(mesh(rBox(0.54, 0.38, 1.22, 0.06), matCockpit, 0, 0.44, 0.44));
  // Cockpit surround rim
  grp.add(mesh(rBox(0.64, 0.048, 1.24, 0.015), matCarbon, 0, 0.63, 0.44));
  // Driver headrest padding
  grp.add(mesh(box(0.22, 0.13, 0.24), makeMat(0xcc2200, 0.65, 0.05), 0, 0.54, 0.76));

  /* ── DRIVER HELMET ────────────────────────────────────────── */
  grp.add(mesh(sph(0.162, 22, 18), matHelmet, 0, 0.70, 0.26));
  grp.add(mesh(new THREE.SphereGeometry(0.166, 22, 18, 0.58, 1.98, 0.48, 1.22), matVisor, 0, 0.70, 0.26));
  // Helmet air intake nub
  grp.add(mesh(box(0.06, 0.04, 0.05), matCarbon, 0, 0.86, 0.34));

  /* ── HALO — smooth CatmullRom arch (TubeGeometry) ─────────── */
  const haloCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3( 0, 0.42, 0.10),
    new THREE.Vector3( 0, 1.00, 0.10),
    new THREE.Vector3( 0, 1.06, 0.30),
    new THREE.Vector3( 0, 1.06, 0.49),
    new THREE.Vector3( 0, 1.06, 0.68),
    new THREE.Vector3( 0, 1.00, 0.88),
    new THREE.Vector3( 0, 0.42, 0.88),
  ]);
  grp.add(mesh(new THREE.TubeGeometry(haloCurve, 40, 0.034, 12, false), matHalo));
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.022, 0.022, 0.48, 10), matHalo, s * 0.26, 0.62, 0.49, 0, 0, s * 0.60));
  }
  // Central forward keel — anchors halo to front bulkhead (signature F1 feature)
  grp.add(rod(0, 0.42, 0.10,  0, 0.36, -0.28,  0.024, matHalo));

  /* ── MIRRORS ─────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(rBox(0.020, 0.062, 0.06, 0.006), matCarbon, s * 0.34, 0.68, -0.32));
    grp.add(mesh(rBox(0.026, 0.068, 0.20, 0.006), matBody, s * 0.37, 0.68, -0.30));
  }

  /* ── FRONT WING — 4-element airfoil cascade ───────────────── */
  // Main neutral-section plane
  grp.add(mesh(wingGeo(1.74, 0.34, 0.070), matBody, 0, 0.020, -2.72));
  // Flap 1
  grp.add(mesh(wingGeo(1.58, 0.26, 0.055), matBody, 0, 0.072, -2.63));
  // Flap 2
  grp.add(mesh(wingGeo(1.34, 0.20, 0.045), matBody, 0, 0.116, -2.56));
  // Flap 3 (inboard cascade)
  grp.add(mesh(wingGeo(0.82, 0.15, 0.036), matBody, 0, 0.152, -2.50));
  // Endplates
  for (const s of [-1, 1]) {
    grp.add(mesh(rBox(0.040, 0.168, 0.36, 0.010), matCarbon, s * 0.87, 0.040, -2.72));
    // Upper canard
    const can = mesh(box(0.24, 0.022, 0.20), matBody, s * 0.72, 0.040, -2.66);
    can.rotation.y = s * 0.26;
    grp.add(can);
    // Dive plane (under endplate)
    grp.add(mesh(box(0.22, 0.020, 0.26), matCarbon, s * 0.64, -0.044, -2.70));
    // Cascade fences (4 per side)
    for (let fi = 0; fi < 4; fi++) {
      grp.add(mesh(box(0.022, 0.10, 0.30), matCarbon, s * (0.28 + fi * 0.16), 0.055, -2.68));
    }
  }
  // Nose support pylons
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.017, 0.020, 0.24, 8), matCarbon, s * 0.22, -0.082, -2.60));
  }

  /* ── REAR WING — two-element DRS airfoil */
  const rearWingGrp = new THREE.Group();
  rearWingGrp.position.set(0, 0.98, 1.95);   // pivot at main-plane leading edge
  // Main plane at pivot origin
  rearWingGrp.add(mesh(wingGeo(1.92, 0.36, 0.100), matBody, 0, 0, 0));
  // DRS flap
  rearWingGrp.add(mesh(wingGeo(1.92, 0.26, 0.080), matBody, 0, -0.11, -0.06));
  // Endplates (tall, louvred)
  for (const s of [-1, 1]) {
    rearWingGrp.add(mesh(box(0.040, 0.56, 0.40), matCarbon, s * 0.96, -0.21, 0));
    for (let li = 0; li < 5; li++) {
      rearWingGrp.add(mesh(box(0.026, 0.048, 0.042), matCfrp, s * 0.972, -li * 0.08, -0.17 + li * 0.04));
    }
  }
  // Rear wing main pillar
  rearWingGrp.add(mesh(cyl(0.036, 0.054, 0.72, 10), matCarbon, 0, -0.34, 0));
  // Beam wing (lower element)
  rearWingGrp.add(mesh(wingGeo(0.94, 0.24, 0.060), matCarbon, 0, -0.42, -0.06));
  grp.add(rearWingGrp);

  /* ── REAR DIFFUSER ────────────────────────────────────────── */
  const diff = mesh(box(1.14, 0.060, 1.00), matCarbon, 0, -0.044, 1.93);
  diff.rotation.x = -0.28;
  grp.add(diff);
  for (let di = -2; di <= 2; di++) {
    const s = mesh(rBox(0.020, 0.074, 0.90, 0.004), matCarbon, di * 0.24, -0.036, 1.91);
    s.rotation.y = di * 0.087;
    grp.add(s);
  }

  /* ── EXHAUST ──────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.038, 0.044, 0.19, 12), matCarbon, 0.12, 0.24, 2.10));
  grp.add(mesh(cyl(0.044, 0.044, 0.022, 12), makeMat(0x999999, 0.04, 1.0), 0.12, 0.24, 2.20));

  /* ── SUSPENSION ───────────────────────────────────────────── */
  {
    const fz = -1.50, rz = 1.60;
    for (const s of [-1, 1]) {
      // Front corner — upright + V-wishbones + push rod + track rod
      grp.add(rod(s*0.67, -0.10, fz,  s*0.67,  0.22, fz,  0.018, matCarbon)); // upright
      grp.add(rod(s*0.67,  0.20, fz,  s*0.32,  0.26, fz-0.18,  0.013, matCarbon)); // upper front arm
      grp.add(rod(s*0.67,  0.20, fz,  s*0.32,  0.26, fz+0.18,  0.013, matCarbon)); // upper rear arm
      grp.add(rod(s*0.67, -0.10, fz,  s*0.30,  0.00, fz-0.20,  0.013, matCarbon)); // lower front arm
      grp.add(rod(s*0.67, -0.10, fz,  s*0.30,  0.00, fz+0.20,  0.013, matCarbon)); // lower rear arm
      grp.add(rod(s*0.64,  0.00, fz,  s*0.24,  0.30, fz,        0.008, matCarbon)); // push rod
      grp.add(rod(s*0.67, -0.10, fz,  s*0.14, -0.06, fz+0.02,  0.008, matCarbon)); // track rod
      // Rear corner — upright + V-wishbones + pull rod + toe link
      grp.add(rod(s*0.65, -0.10, rz,  s*0.65,  0.22, rz,  0.018, matCarbon)); // upright
      grp.add(rod(s*0.65,  0.20, rz,  s*0.28,  0.24, rz-0.18,  0.013, matCarbon)); // upper front arm
      grp.add(rod(s*0.65,  0.20, rz,  s*0.28,  0.24, rz+0.18,  0.013, matCarbon)); // upper rear arm
      grp.add(rod(s*0.65, -0.10, rz,  s*0.26,  0.00, rz-0.20,  0.013, matCarbon)); // lower front arm
      grp.add(rod(s*0.65, -0.10, rz,  s*0.26,  0.00, rz+0.20,  0.013, matCarbon)); // lower rear arm
      grp.add(rod(s*0.62,  0.00, rz,  s*0.22,  0.28, rz,        0.008, matCarbon)); // pull rod
      grp.add(rod(s*0.65, -0.10, rz,  s*0.12, -0.06, rz+0.02,  0.008, matCarbon)); // toe link
    }
    // Anti-roll bars (outside side loop — single bar each axle)
    grp.add(mesh(cyl(0.010, 0.010, 1.34, 8), matCarbon, 0, 0.14, fz, 0, 0, Math.PI / 2));
    grp.add(mesh(cyl(0.010, 0.010, 1.30, 8), matCarbon, 0, 0.14, rz, 0, 0, Math.PI / 2));
  }

  /* ── WHEELS ───────────────────────────────────────────────── */
  const wR = 0.345, wW = 0.340;
  const wPos = {
    wFL: [-0.82, -0.04, -1.50],
    wFR: [ 0.82, -0.04, -1.50],
    wRL: [-0.80, -0.04,  1.60],
    wRR: [ 0.80, -0.04,  1.60],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n; w.position.set(x, y, z); grp.add(w);
  });

  buildLivery(grp, color, 'F1');
  const measure = measureFromWheels(wPos, wR);
  measure.anchors = proceduralAnchors('F1');
  grp.userData.measure = measure;
  grp.userData.baseY   = TRACK.SURFACE_Y - measure.groundContactY;
  grp.position.y       = grp.userData.baseY;
  return grp;
}

/* ════════════════════════════════════════════════════════════════
   GT  —  GT3 closed-cockpit sports car (Ferrari 296 / Porsche 992 GT3 R style)
   Wheelbase ~2.80 u  |  Track ~1.70 u  |  Wheel radius 0.338 u

   Fastback roofline built from stacked angled slabs:
     Hood → Windshield (steep) → Roof flat → Rear screen (steep) → Trunk
════════════════════════════════════════════════════════════════ */
function buildGTProcedural({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const matBody   = makeBodyMat(color);
  const matCarbon = makeCarbonMat(0x0e0e0e, 0.42, 0.58);
  const matTyre   = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub    = makeMat(0xd0d0d0, 0.10, 1.00);
  const matGlass  = new THREE.MeshPhysicalMaterial({
    color: 0x1a2a36, transmission: 0.55, roughness: 0.04,
    metalness: 0, ior: 1.52, transparent: true, opacity: 0.68, depthWrite: false,
  });
  const matLight  = makeMat(0xff2200, 0.08, 0.0, 0xff2200, 2.2);
  const matHlight = makeMat(0xffffee, 0.05, 0.0, 0xfff8cc, 2.0);
  const matChrome = makeMat(0xeeeeff, 0.04, 1.0);

  /* ── UNDERBODY FLOOR ──────────────────────────────────────── */
  grp.add(mesh(box(1.96, 0.06, 4.80), matCarbon, 0, 0.03, 0.00));
  // Floor strakes
  for (let di = -2; di <= 2; di++) {
    grp.add(mesh(box(0.018, 0.055, 4.20), matCarbon, di * 0.38, 0.055, 0.10));
  }

  /* ── LOWER BODY SILL — sculpted rBox ─────────────────────── */
  grp.add(mesh(rBox(1.96, 0.22, 4.55, 0.06), matBody, 0, 0.17, 0.00));
  // Side sill extensions
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.040, 0.10, 4.10), matCarbon, s * 0.98, 0.10, 0.00));
    // Sill detail: 3 vertical fins
    for (let fi = 0; fi < 3; fi++) {
      grp.add(mesh(box(0.032, 0.08, 0.032), matCarbon, s * 0.98, 0.14, -0.80 + fi * 0.80));
    }
  }

  /* ── HOOD / BONNET — rBox with slight forward rake ────────── */
  const hood = mesh(rBox(1.84, 0.05, 1.60, 0.02), matBody, 0, 0.30, -1.50);
  hood.rotation.x = -0.06;
  grp.add(hood);
  // Hood center vent (raised duct)
  grp.add(mesh(box(0.32, 0.048, 0.36), matCarbon, 0, 0.33, -1.40));
  grp.add(mesh(box(0.24, 0.036, 0.28), matCarbon, 0, 0.355, -1.40));

  /* ── WINDSHIELD + A-PILLARS ───────────────────────────────── */
  const windshield = mesh(box(1.52, 0.38, 0.055), matGlass, 0, 0.46, -0.84);
  windshield.rotation.x = 0.54;
  grp.add(windshield);
  for (const s of [-1, 1]) {
    const ap = mesh(box(0.055, 0.42, 0.065), matCarbon, s * 0.76, 0.44, -0.84);
    ap.rotation.z = s * 0.18;
    ap.rotation.x = 0.54;
    grp.add(ap);
  }

  /* ── ROOF — rBox volumes ──────────────────────────────────── */
  grp.add(mesh(rBox(1.52, 0.40, 1.92, 0.08), matBody, 0, 0.46, 0.12));
  // Roof narrowing (upper step)
  grp.add(mesh(rBox(1.28, 0.10, 1.80, 0.05), matBody, 0, 0.65, 0.12));
  // NACA duct on roof
  grp.add(mesh(cone(0.060, 0.20, 10), matCarbon, 0, 0.64, -0.18, -Math.PI / 2, 0, 0));
  grp.add(mesh(box(0.075, 0.038, 0.18), matCarbon, 0, 0.640, -0.04));
  // Roof antenna
  grp.add(mesh(cyl(0.006, 0.004, 0.22, 6), matCarbon, 0.20, 0.76, 0.00));

  /* ── SIDE WINDOWS ─────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.048, 0.26, 1.06), matGlass, s * 0.78, 0.44, 0.12));
  }

  /* ── REAR WINDOW + C-PILLARS ──────────────────────────────── */
  const rw = mesh(box(1.52, 0.32, 0.055), matGlass, 0, 0.46, 1.06);
  rw.rotation.x = -0.52;
  grp.add(rw);
  for (const s of [-1, 1]) {
    const cp = mesh(box(0.055, 0.38, 0.065), matCarbon, s * 0.76, 0.44, 1.06);
    cp.rotation.z = s * 0.18;
    cp.rotation.x = -0.52;
    grp.add(cp);
  }

  /* ── REAR DECK / TRUNK — rBox with slight rake ────────────── */
  const deck = mesh(rBox(1.84, 0.058, 0.88, 0.02), matBody, 0, 0.28, 1.90);
  deck.rotation.x = 0.04;
  grp.add(deck);

  /* ── FRONT BUMPER / SPLITTER ASSEMBLY ────────────────────── */
  // Lower bumper
  grp.add(mesh(rBox(1.88, 0.10, 0.20, 0.02), matCarbon, 0, -0.02, -2.30));
  // Main splitter (flat — GT splitters ARE flat)
  grp.add(mesh(box(1.76, 0.038, 0.40), matCarbon, 0, -0.135, -2.38));
  // Front splitter lip
  grp.add(mesh(box(1.70, 0.022, 0.06), matCarbon, 0, -0.146, -2.59));
  // Canard wings (angled outboard)
  for (const s of [-1, 1]) {
    const can = mesh(box(0.38, 0.024, 0.22), matCarbon, s * 0.76, -0.10, -2.34);
    can.rotation.y = s * 0.20;
    can.rotation.z = s * -0.08;
    grp.add(can);
    // Dive plane below canard
    grp.add(mesh(box(0.28, 0.020, 0.28), matCarbon, s * 0.72, -0.15, -2.38));
  }
  // Front grille (dark rectangle)
  grp.add(mesh(box(1.20, 0.14, 0.04), makeMat(0x111111, 0.8, 0.0), 0, 0.12, -2.32));
  // Headlights (LED strip style)
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.46, 0.056, 0.042), matHlight, s * 0.65, 0.19, -2.31));
    // DRL strip
    grp.add(mesh(box(0.38, 0.022, 0.042), makeMat(0xffffff, 0.05, 0.0, 0xffffff, 1.4), s * 0.61, 0.10, -2.31));
  }

  /* ── REAR BUMPER ─────────────────────────────────────────── */
  grp.add(mesh(rBox(1.88, 0.12, 0.18, 0.02), matCarbon, 0, -0.02, 2.30));
  // Rear lights (full-width LED bars)
  grp.add(mesh(box(1.60, 0.042, 0.040), matLight, 0, 0.16, 2.32));
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.38, 0.055, 0.040), matLight, s * 0.68, 0.22, 2.32));
  }
  // Brake light centre
  grp.add(mesh(box(0.50, 0.022, 0.040), matLight, 0, 0.12, 2.32));

  /* ── REAR DIFFUSER ────────────────────────────────────────── */
  const diff = mesh(box(1.10, 0.062, 0.78), matCarbon, 0, -0.095, 2.14);
  diff.rotation.x = -0.30;
  grp.add(diff);
  for (let di = -2; di <= 2; di++) {
    grp.add(mesh(box(0.018, 0.060, 0.70), matCarbon, di * 0.22, -0.086, 2.12));
  }

  /* ── EXHAUST (twin-exit, under diffuser) ─────────────────── */
  for (const ox of [-0.14, 0.14]) {
    grp.add(mesh(cyl(0.042, 0.048, 0.17, 14), matCarbon, ox, -0.090, 2.30));
    grp.add(mesh(cyl(0.048, 0.048, 0.020, 14), matChrome, ox, -0.090, 2.40));
  }

  /* ── REAR WING — GT3 swan-neck ───────────────────────────── */
  const rearWingGrp = new THREE.Group();
  rearWingGrp.position.set(0, 0.84, 1.92);
  // Main element at pivot origin
  rearWingGrp.add(mesh(wingGeo(1.76, 0.42, 0.110), matBody, 0, 0, 0));
  // Second element (Gurney-like flap)
  rearWingGrp.add(mesh(wingGeo(1.76, 0.28, 0.075), matBody, 0, -0.10, -0.06));
  // Large endplates with louvres
  for (const s of [-1, 1]) {
    rearWingGrp.add(mesh(box(0.046, 0.48, 0.46), matCarbon, s * 0.88, -0.20, 0));
    rearWingGrp.add(mesh(box(0.042, 0.06, 0.40), matCarbon, s * 0.88,  0.12, 0));
    for (let li = 0; li < 4; li++) {
      rearWingGrp.add(mesh(box(0.030, 0.046, 0.040), makeMat(0x1a1a1a, 0.5, 0.5), s * 0.896, 0.02 - li * 0.07, -0.17 + li * 0.04));
    }
  }
  // Swan-neck mount pillars
  for (const s of [-1, 1]) {
    const sn = mesh(cyl(0.026, 0.032, 0.40, 10), matCarbon, s * 0.32, -0.18, 0);
    sn.rotation.x = 0.14;
    rearWingGrp.add(sn);
  }
  grp.add(rearWingGrp);

  /* ── WHEEL ARCHES (GT enclosed wheel fenders) ─────────────── */
  for (const s of [-1, 1]) {
    for (const wz of [-1.38, 1.42]) {
      // Outer arch panel
      grp.add(mesh(cyl(0.46, 0.46, 0.30, 32, 1, false, 0, Math.PI), matBody, s * 0.95, -0.06, wz, 0, 0, s * Math.PI / 2));
      // Inner arch lip
      grp.add(mesh(cyl(0.44, 0.44, 0.06, 32, 1, false, 0, Math.PI), matCarbon, s * 0.95, -0.06, wz, 0, 0, s * Math.PI / 2));
    }
  }

  /* ── DOOR PANELS ─────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.026, 0.29, 2.30), matBody, s * 0.94, 0.18, 0.22));
    // Door crease line
    grp.add(mesh(box(0.028, 0.024, 2.18), matCarbon, s * 0.95, 0.28, 0.22));
    // Door vent / outlet
    for (let vi = 0; vi < 3; vi++) {
      grp.add(mesh(box(0.030, 0.058, 0.038), matCarbon, s * 0.95, 0.18 - vi * 0.04, 0.60 + vi * 0.08));
    }
  }

  /* ── WING MIRRORS ────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.011, 0.013, 0.20, 8), matCarbon, s * 0.86, 0.52, -0.50, 0, 0, Math.PI / 2));
    grp.add(mesh(box(0.026, 0.105, 0.22), matChrome, s * 0.90, 0.58, -0.50));
  }

  /* ── WHEELS — road-car gtWheel (10-spoke alloy, yellow PCCB caliper) ── */
  const wR = 0.338, wW = 0.260;
  const wPos = {
    wFL: [-0.86, -0.05, -1.38],
    wFR: [ 0.86, -0.05, -1.38],
    wRL: [-0.86, -0.05,  1.42],
    wRR: [ 0.86, -0.05,  1.42],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = gtWheel(wR, wW, matHub, matTyre, n);
    w.name = n; w.position.set(x, y, z); grp.add(w);
  });

  buildLivery(grp, color, 'GT');
  const measure = measureFromWheels(wPos, wR);
  measure.anchors = proceduralAnchors('GT');
  grp.userData.measure = measure;
  grp.userData.baseY   = TRACK.SURFACE_Y - measure.groundContactY;
  grp.position.y       = grp.userData.baseY;
  return grp;
}
