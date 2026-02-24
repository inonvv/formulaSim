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
 * grp.position.y lifts car so wheels sit on track surface (y = −0.34).
 */

import * as THREE from 'three';

/* ── Shared material helpers ──────────────────────────────────── */

function makeMat(color, rough = 0.25, metal = 0.8, emissive = 0x000000, emissiveInt = 0) {
  return new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, emissive, emissiveIntensity: emissiveInt,
  });
}

function makeBodyMat(color) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.10, metalness: 0.90,
    clearcoat: 1.0, clearcoatRoughness: 0.03, envMapIntensity: 2.0,
  });
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

/* ── Suspension wishbone helper ───────────────────────────────── */
function wishbone(len, matCarbon, x, y, z, rz) {
  return mesh(cyl(0.013, 0.013, len, 8), matCarbon, x, y, z, 0, 0, rz);
}

/* ── Car definitions ──────────────────────────────────────────── */

const CAR_META = {
  F1: { label: 'Formula One',   color: 0xe8132a },
  F2: { label: 'Formula Two',   color: 0x1166ff },
  F3: { label: 'Formula Three', color: 0x00cc66 },
  GT: { label: 'GT Race Car',   color: 0xff8800 },
};

export function buildCar(type) {
  const meta = CAR_META[type] || CAR_META.F1;
  switch (type) {
    case 'F2': return buildF2(meta);
    case 'F3': return buildF3(meta);
    case 'GT': return buildGT(meta);
    default:   return buildF1(meta);
  }
}

export function getCarMeta(type) { return CAR_META[type] || CAR_META.F1; }
export const WHEEL_NAMES = ['wFL', 'wFR', 'wRL', 'wRR'];

/* ════════════════════════════════════════════════════════════════
   F1  —  2022+ ground-effect open-wheel single-seater
   Wheelbase ~3.10 u  |  Track ~1.60 u  |  Wheel radius 0.345 u
════════════════════════════════════════════════════════════════ */
function buildF1({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const matBody   = makeBodyMat(color);
  const matCarbon = makeMat(0x0e0e0e, 0.40, 0.60);
  const matCfrp   = makeMat(0x1a1a1a, 0.50, 0.50);
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

  /* ── MONOCOQUE / SURVIVAL CELL — 3 rounded-edge layers ─────── */
  // Layer 1: lower tub (widest, flattest)
  grp.add(mesh(rBox(0.78, 0.12, 3.55, 0.04), matBody, 0, 0.13, 0.05));
  // Layer 2: mid tub (proper monocoque width)
  grp.add(mesh(rBox(0.64, 0.24, 2.85, 0.06), matBody, 0, 0.30, -0.08));
  // Layer 3: upper section (narrows above driver knees)
  grp.add(mesh(rBox(0.50, 0.18, 1.80, 0.09), matBody, 0, 0.47, -0.12));

  /* ── SIDEPODS — 2022+ sharp-sidepod geometry ─────────────── */
  for (const s of [-1, 1]) {
    // Main pod volume — near-square section, sharp edges
    grp.add(mesh(rBox(0.34, 0.32, 1.85, 0.015), matBody, s * 0.545, 0.22, 0.28));
    // Shoulder crease line (upper ridge transition)
    grp.add(mesh(rBox(0.33, 0.055, 1.82, 0.012), matBody, s * 0.540, 0.385, 0.28));
    // Top surface panel
    grp.add(mesh(rBox(0.31, 0.06, 1.78, 0.010), matBody, s * 0.535, 0.435, 0.30));
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
  }

  /* ── ENGINE COVER ─────────────────────────────────────────── */
  grp.add(mesh(rBox(0.50, 0.30, 1.15), matBody, 0, 0.42, 1.38));
  // Tapers to gearbox (slimmer)
  grp.add(mesh(rBox(0.40, 0.24, 0.60), matBody, 0, 0.36, 1.98));
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
  // Oval nose cone — smooth taper to tip
  grp.add(mesh(noseTip(0.30, 0.13, 0.51), matBody, 0, 0.09, -2.60));
  // Camera pods (small aero bumps at nose sides)
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.038, 0.038, 0.09, 10), matCfrp, s * 0.15, 0.06, -1.95, 0, 0, Math.PI / 2));
    grp.add(mesh(cyl(0.024, 0.024, 0.042, 10), makeMat(0x001144, 0.1, 0.3), s * 0.205, 0.06, -1.95, 0, 0, Math.PI / 2));
  }
  // S-duct outlet (top of nose)
  grp.add(mesh(box(0.10, 0.04, 0.14), matCarbon, 0, 0.16, -2.22));

  /* ── COCKPIT ──────────────────────────────────────────────── */
  grp.add(mesh(box(0.54, 0.38, 1.22), matCockpit, 0, 0.44, 0.44));
  // Cockpit surround rim
  grp.add(mesh(box(0.64, 0.048, 1.24), matCarbon, 0, 0.63, 0.44));
  // Driver headrest padding
  grp.add(mesh(box(0.22, 0.13, 0.24), makeMat(0xcc2200, 0.65, 0.05), 0, 0.54, 0.76));

  /* ── DRIVER HELMET ────────────────────────────────────────── */
  grp.add(mesh(sph(0.162, 22, 18), matHelmet, 0, 0.70, 0.26));
  grp.add(mesh(new THREE.SphereGeometry(0.166, 22, 18, 0.58, 1.98, 0.48, 1.22), matVisor, 0, 0.70, 0.26));
  // Helmet air intake nub
  grp.add(mesh(box(0.06, 0.04, 0.05), matCarbon, 0, 0.86, 0.34));

  /* ── HALO ─────────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.026, 0.026, 0.60, 12), matHalo, 0, 0.72, 0.10));
  grp.add(mesh(cyl(0.026, 0.026, 0.60, 12), matHalo, 0, 0.72, 0.88));
  grp.add(mesh(cyl(0.026, 0.026, 0.80, 12), matHalo, 0, 0.96, 0.49, Math.PI / 2, 0, 0));
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.018, 0.018, 0.48, 10), matHalo, s * 0.26, 0.62, 0.49, 0, 0, s * 0.60));
  }

  /* ── MIRRORS ─────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.020, 0.062, 0.06), matCarbon, s * 0.34, 0.68, -0.32));
    grp.add(mesh(box(0.026, 0.068, 0.20), matBody, s * 0.37, 0.68, -0.30));
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
    grp.add(mesh(box(0.040, 0.168, 0.36), matCarbon, s * 0.87, 0.040, -2.72));
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

  /* ── REAR WING — two-element DRS airfoil (named group for flip) */
  const rearWingGrp = new THREE.Group();
  rearWingGrp.name = 'rearWing';
  rearWingGrp.position.set(0, 0.98, 1.95);   // pivot at main-plane leading edge
  // Main plane at pivot origin
  rearWingGrp.add(mesh(wingGeo(1.92, 0.36, 0.100), matBody, 0, 0, 0));
  // DRS flap — named so wing-stall animation rotates only this element
  const f1Flap = mesh(wingGeo(1.92, 0.26, 0.080), matBody, 0, -0.11, -0.06);
  f1Flap.name = 'rearWingFlap';
  rearWingGrp.add(f1Flap);
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
    grp.add(mesh(box(0.020, 0.074, 0.90), matCarbon, di * 0.24, -0.036, 1.91));
  }

  /* ── EXHAUST ──────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.038, 0.044, 0.19, 12), matCarbon, 0.12, 0.24, 2.10));
  grp.add(mesh(cyl(0.044, 0.044, 0.022, 12), makeMat(0x999999, 0.04, 1.0), 0.12, 0.24, 2.20));

  /* ── SUSPENSION ───────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    const fz = -1.50, rz = 1.60;
    // Front: upper wishbone + lower wishbone + push rod
    grp.add(wishbone(0.62, matCarbon, s * 0.40, 0.14, fz, s * 0.44));
    grp.add(wishbone(0.60, matCarbon, s * 0.38, -0.04, fz, s * -0.38));
    grp.add(mesh(cyl(0.008, 0.008, 0.46, 6), matCarbon, s * 0.30, 0.06, fz, 0, 0, s * 0.20));
    // Rear: upper wishbone + lower wishbone + pull rod
    grp.add(wishbone(0.58, matCarbon, s * 0.38, 0.12, rz, s * 0.42));
    grp.add(wishbone(0.56, matCarbon, s * 0.36, -0.04, rz, s * -0.36));
    grp.add(mesh(cyl(0.008, 0.008, 0.44, 6), matCarbon, s * 0.28, 0.04, rz, 0, 0, s * -0.22));
    // Anti-roll bar tie
    grp.add(mesh(cyl(0.010, 0.010, 1.42, 8), matCarbon, 0, 0.10, fz, 0, 0, Math.PI / 2));
    grp.add(mesh(cyl(0.010, 0.010, 1.38, 8), matCarbon, 0, 0.10, rz, 0, 0, Math.PI / 2));
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

  grp.position.y = wR + 0.34;
  return grp;
}

/* ════════════════════════════════════════════════════════════════
   F2  —  Dallara F2-2018 style
   Wheelbase ~2.85 u  |  Track ~1.50 u  |  Wheel radius 0.328 u
════════════════════════════════════════════════════════════════ */
function buildF2({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const matBody   = makeBodyMat(color);
  const matCarbon = makeMat(0x101010, 0.45, 0.58);
  const matTyre   = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub    = makeMat(0xd8d8d8, 0.10, 1.00);
  const matCockpit= makeMat(0x050505, 0.05, 0.20, 0x001122, 0.45);
  const matHalo   = makeMat(0xcccccc, 0.08, 1.00);
  const matHelmet = makeBodyMat(0xeeeeee);

  /* ── FLOOR ────────────────────────────────────────────────── */
  grp.add(mesh(box(1.28, 0.060, 3.70), matCarbon, 0, 0.04, 0.00));
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.024, 0.085, 3.30), matCarbon, s * 0.63, 0.07, 0.10));
  }

  /* ── MONOCOQUE — 3 rounded-edge layers ───────────────────── */
  grp.add(mesh(rBox(0.76, 0.11, 3.30, 0.04), matBody, 0, 0.12, 0.05));
  grp.add(mesh(rBox(0.62, 0.22, 2.65, 0.06), matBody, 0, 0.28, -0.06));
  grp.add(mesh(rBox(0.48, 0.17, 1.70, 0.08), matBody, 0, 0.44, -0.10));

  /* ── SIDEPODS — 2022+ sharp-sidepod geometry (F2 ~85% scale) ─ */
  for (const s of [-1, 1]) {
    // Main pod volume
    grp.add(mesh(rBox(0.29, 0.27, 1.57, 0.015), matBody, s * 0.465, 0.19, 0.26));
    // Shoulder crease line
    grp.add(mesh(rBox(0.28, 0.048, 1.55, 0.012), matBody, s * 0.462, 0.328, 0.26));
    // Top surface panel
    grp.add(mesh(rBox(0.265, 0.052, 1.51, 0.010), matBody, s * 0.455, 0.370, 0.28));
    // Undercut angled panel
    const ucPanel = mesh(box(0.11, 0.15, 1.48), matCarbon, s * 0.520, 0.085, 0.28);
    ucPanel.rotation.z = s * 0.35;
    grp.add(ucPanel);
    // Inlet mouth — sharp rectangular
    grp.add(mesh(rBox(0.055, 0.272, 0.051, 0.008), matCockpit, s * 0.449, 0.19, -0.55));
    // Carbon fibre inlet surround lip
    grp.add(mesh(rBox(0.068, 0.289, 0.014, 0.005), matCarbon, s * 0.449, 0.19, -0.55));
    // Central divider vane
    grp.add(mesh(box(0.009, 0.255, 0.041), matCarbon, s * 0.449, 0.19, -0.55));
    // Leading edge wedge
    const ledge = mesh(rBox(0.015, 0.289, 0.085, 0.006), matCarbon, s * 0.416, 0.19, -0.57);
    ledge.rotation.y = s * 0.12;
    grp.add(ledge);
    // Louver mounting rail
    grp.add(mesh(box(0.204, 0.010, 0.391), matCarbon, s * 0.416, 0.365, 0.58));
    // Heat exchanger exit louvers — 5 slats
    for (let li = 0; li < 5; li++) {
      const louver = mesh(box(0.187, 0.024, 0.306), matCarbon, s * 0.416, 0.357 - li * 0.010, 0.595 + li * 0.221);
      louver.rotation.x = -0.15;
      grp.add(louver);
    }
    // Top winglet fin
    const finGeo = wingGeo(0.153, 0.102, 0.015);
    const fin = mesh(finGeo, matCarbon, s * 0.451, 0.391, 0.187);
    fin.rotation.y = s * 0.22;
    grp.add(fin);
    // Bargeboard (3 vanes — F2 spec)
    for (let bi = 0; bi < 3; bi++) {
      const v = mesh(box(0.020, 0.19, 0.14), matCarbon, s * (0.36 + bi * 0.06), 0.07, -0.60 + bi * 0.04);
      v.rotation.y = s * (0.10 + bi * 0.06);
      grp.add(v);
    }
  }

  /* ── ENGINE COVER ─────────────────────────────────────────── */
  grp.add(mesh(rBox(0.48, 0.27, 1.00), matBody, 0, 0.38, 1.30));
  grp.add(mesh(rBox(0.38, 0.20, 0.52), matBody, 0, 0.30, 1.85));
  // Intake
  grp.add(mesh(box(0.14, 0.28, 0.18), matCarbon, 0, 0.54, 0.90));
  grp.add(mesh(cone(0.070, 0.18, 12), matCarbon, 0, 0.68, 0.80, -Math.PI / 2, 0, 0));

  /* ── NOSE — sculpted transitions + oval tip ───────────────── */
  grp.add(mesh(rBox(0.46, 0.17, 0.80, 0.06), matBody, 0, 0.15, -1.64));
  grp.add(mesh(rBox(0.30, 0.14, 0.80, 0.05), matBody, 0, 0.11, -2.06));
  grp.add(mesh(noseTip(0.28, 0.12, 0.47), matBody, 0, 0.09, -2.44));

  /* ── COCKPIT ──────────────────────────────────────────────── */
  grp.add(mesh(box(0.52, 0.35, 1.12), matCockpit, 0, 0.42, 0.42));
  grp.add(mesh(box(0.62, 0.044, 1.14), matCarbon, 0, 0.60, 0.42));
  grp.add(mesh(box(0.20, 0.12, 0.20), makeMat(0x1155cc, 0.65, 0.05), 0, 0.50, 0.72));

  /* ── DRIVER HELMET ────────────────────────────────────────── */
  grp.add(mesh(sph(0.155, 20, 16), matHelmet, 0, 0.67, 0.24));
  grp.add(mesh(new THREE.SphereGeometry(0.158, 20, 16, 0.6, 2.0, 0.5, 1.2),
    new THREE.MeshPhysicalMaterial({ color: 0x334455, transmission: 0.5, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.78, depthWrite: false }),
    0, 0.67, 0.24));

  /* ── HALO ─────────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.024, 0.024, 0.55, 12), matHalo, 0, 0.68, 0.10));
  grp.add(mesh(cyl(0.024, 0.024, 0.55, 12), matHalo, 0, 0.68, 0.82));
  grp.add(mesh(cyl(0.024, 0.024, 0.74, 12), matHalo, 0, 0.90, 0.46, Math.PI / 2, 0, 0));
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.016, 0.016, 0.44, 10), matHalo, s * 0.24, 0.60, 0.46, 0, 0, s * 0.58));
  }

  /* ── MIRRORS ─────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.020, 0.058, 0.06), matCarbon, s * 0.32, 0.66, -0.30));
    grp.add(mesh(box(0.025, 0.064, 0.18), matBody, s * 0.35, 0.66, -0.28));
  }

  /* ── FRONT WING — 3-element airfoil ──────────────────────── */
  grp.add(mesh(wingGeo(1.60, 0.28, 0.065), matBody, 0, 0.022, -2.48));
  grp.add(mesh(wingGeo(1.44, 0.20, 0.050), matBody, 0, 0.072, -2.40));
  grp.add(mesh(wingGeo(1.20, 0.15, 0.040), matBody, 0, 0.114, -2.34));
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.038, 0.136, 0.30), matCarbon, s * 0.80, 0.036, -2.48));
    const can = mesh(box(0.20, 0.020, 0.18), matBody, s * 0.66, 0.036, -2.44);
    can.rotation.y = s * 0.22;
    grp.add(can);
    for (let fi = 0; fi < 3; fi++) {
      grp.add(mesh(box(0.020, 0.090, 0.26), matCarbon, s * (0.26 + fi * 0.16), 0.050, -2.46));
    }
  }
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.016, 0.018, 0.20, 8), matCarbon, s * 0.20, -0.076, -2.40));
  }

  /* ── REAR WING — named group for flip animation ──────────── */
  const rearWingGrp = new THREE.Group();
  rearWingGrp.name = 'rearWing';
  rearWingGrp.position.set(0, 0.90, 1.80);
  rearWingGrp.add(mesh(wingGeo(1.74, 0.30, 0.090), matBody, 0, 0, 0));
  const f2Flap = mesh(wingGeo(1.74, 0.22, 0.070), matBody, 0, -0.10, -0.06);
  f2Flap.name = 'rearWingFlap';
  rearWingGrp.add(f2Flap);
  for (const s of [-1, 1]) {
    rearWingGrp.add(mesh(box(0.038, 0.48, 0.34), matCarbon, s * 0.87, -0.20, 0));
  }
  rearWingGrp.add(mesh(cyl(0.034, 0.050, 0.64, 10), matCarbon, 0, -0.30, 0));
  rearWingGrp.add(mesh(wingGeo(0.82, 0.20, 0.055), matCarbon, 0, -0.38, -0.06));
  grp.add(rearWingGrp);

  /* ── DIFFUSER ─────────────────────────────────────────────── */
  const diff = mesh(box(1.00, 0.054, 0.88), matCarbon, 0, -0.042, 1.80);
  diff.rotation.x = -0.24;
  grp.add(diff);
  for (let di = -1; di <= 1; di++) {
    grp.add(mesh(box(0.018, 0.066, 0.78), matCarbon, di * 0.28, -0.034, 1.78));
  }

  /* ── EXHAUST ──────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.036, 0.040, 0.16, 12), matCarbon, 0.10, 0.22, 2.00));

  /* ── SUSPENSION ───────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(wishbone(0.56, matCarbon, s * 0.38, 0.13, -1.38, s * 0.42));
    grp.add(wishbone(0.54, matCarbon, s * 0.36, -0.04, -1.38, s * -0.36));
    grp.add(wishbone(0.54, matCarbon, s * 0.36, 0.11, 1.48, s * 0.40));
    grp.add(wishbone(0.52, matCarbon, s * 0.34, -0.04, 1.48, s * -0.34));
    grp.add(mesh(cyl(0.010, 0.010, 1.28, 8), matCarbon, 0, 0.09, -1.38, 0, 0, Math.PI / 2));
    grp.add(mesh(cyl(0.010, 0.010, 1.24, 8), matCarbon, 0, 0.09,  1.48, 0, 0, Math.PI / 2));
  }

  /* ── WHEELS ───────────────────────────────────────────────── */
  const wR = 0.328, wW = 0.318;
  const wPos = {
    wFL: [-0.76, -0.04, -1.38],
    wFR: [ 0.76, -0.04, -1.38],
    wRL: [-0.74, -0.04,  1.48],
    wRR: [ 0.74, -0.04,  1.48],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n; w.position.set(x, y, z); grp.add(w);
  });

  grp.position.y = wR + 0.34;
  return grp;
}

/* ════════════════════════════════════════════════════════════════
   F3  —  Dallara F3-2019 style
   Wheelbase ~2.60 u  |  Track ~1.36 u  |  Wheel radius 0.300 u
════════════════════════════════════════════════════════════════ */
function buildF3({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const matBody   = makeBodyMat(color);
  const matCarbon = makeMat(0x141414, 0.52, 0.52);
  const matTyre   = makeMat(0x0d0d0d, 0.92, 0.04);
  const matHub    = makeMat(0xcccccc, 0.12, 0.95);
  const matCockpit= makeMat(0x050505, 0.05, 0.20, 0x000d1a, 0.40);
  const matHalo   = makeMat(0xcccccc, 0.10, 0.95);
  const matHelmet = makeBodyMat(0xffd700);

  /* ── FLOOR ────────────────────────────────────────────────── */
  grp.add(mesh(box(1.14, 0.055, 3.35), matCarbon, 0, 0.036, 0.00));
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.020, 0.070, 2.90), matCarbon, s * 0.56, 0.060, 0.10));
  }

  /* ── MONOCOQUE — 3 rounded-edge layers ───────────────────── */
  grp.add(mesh(rBox(0.70, 0.10, 2.95, 0.04), matBody, 0, 0.11, 0.04));
  grp.add(mesh(rBox(0.56, 0.20, 2.35, 0.05), matBody, 0, 0.26, -0.08));
  grp.add(mesh(rBox(0.44, 0.15, 1.52, 0.07), matBody, 0, 0.40, -0.10));

  /* ── SIDEPODS ─────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(rBox(0.26, 0.25, 1.28), matBody, s * 0.450, 0.18, 0.24));
    grp.add(mesh(rBox(0.25, 0.055, 1.22), matBody, s * 0.450, 0.33, 0.26));
    grp.add(mesh(box(0.09, 0.14, 1.18), matCarbon, s * 0.498, 0.10, 0.28));
    grp.add(mesh(box(0.044, 0.22, 0.044), matCockpit, s * 0.440, 0.18, -0.50));
  }

  /* ── ENGINE COVER ─────────────────────────────────────────── */
  grp.add(mesh(rBox(0.42, 0.22, 0.88), matBody, 0, 0.34, 1.22));
  grp.add(mesh(rBox(0.34, 0.17, 0.44), matBody, 0, 0.28, 1.68));
  grp.add(mesh(box(0.12, 0.24, 0.15), matCarbon, 0, 0.46, 0.84));
  grp.add(mesh(cone(0.060, 0.15, 12), matCarbon, 0, 0.58, 0.76, -Math.PI / 2, 0, 0));

  /* ── NOSE — sculpted transitions + oval tip ───────────────── */
  grp.add(mesh(rBox(0.42, 0.15, 0.72, 0.05), matBody, 0, 0.13, -1.52));
  grp.add(mesh(rBox(0.27, 0.12, 0.72, 0.04), matBody, 0, 0.10, -1.90));
  grp.add(mesh(noseTip(0.24, 0.11, 0.43), matBody, 0, 0.08, -2.22));

  /* ── COCKPIT ──────────────────────────────────────────────── */
  grp.add(mesh(box(0.48, 0.30, 1.02), matCockpit, 0, 0.38, 0.38));
  grp.add(mesh(box(0.56, 0.040, 1.04), matCarbon, 0, 0.55, 0.38));
  grp.add(mesh(box(0.18, 0.10, 0.18), makeMat(0x003399, 0.65, 0.05), 0, 0.46, 0.66));

  /* ── DRIVER HELMET ────────────────────────────────────────── */
  grp.add(mesh(sph(0.145, 18, 14), matHelmet, 0, 0.61, 0.22));
  grp.add(mesh(new THREE.SphereGeometry(0.148, 18, 14, 0.6, 2.0, 0.5, 1.2),
    new THREE.MeshPhysicalMaterial({ color: 0x445522, transmission: 0.5, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.75, depthWrite: false }),
    0, 0.61, 0.22));

  /* ── HALO ─────────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.022, 0.022, 0.50, 12), matHalo, 0, 0.62, 0.08));
  grp.add(mesh(cyl(0.022, 0.022, 0.50, 12), matHalo, 0, 0.62, 0.76));
  grp.add(mesh(cyl(0.022, 0.022, 0.66, 12), matHalo, 0, 0.84, 0.42, Math.PI / 2, 0, 0));
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.014, 0.014, 0.38, 10), matHalo, s * 0.22, 0.54, 0.42, 0, 0, s * 0.56));
  }

  /* ── MIRRORS ─────────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.018, 0.052, 0.055), matCarbon, s * 0.28, 0.60, -0.26));
    grp.add(mesh(box(0.022, 0.058, 0.15), matBody, s * 0.30, 0.60, -0.24));
  }

  /* ── FRONT WING — 2-element airfoil + small flap ─────────── */
  grp.add(mesh(wingGeo(1.46, 0.24, 0.055), matBody, 0, 0.020, -2.24));
  grp.add(mesh(wingGeo(1.30, 0.17, 0.042), matBody, 0, 0.068, -2.17));
  grp.add(mesh(wingGeo(0.80, 0.12, 0.034), matBody, 0, 0.102, -2.12));
  for (const s of [-1, 1]) {
    grp.add(mesh(box(0.034, 0.110, 0.26), matCarbon, s * 0.73, 0.030, -2.24));
    for (let fi = 0; fi < 2; fi++) {
      grp.add(mesh(box(0.018, 0.078, 0.22), matCarbon, s * (0.24 + fi * 0.18), 0.044, -2.22));
    }
  }
  for (const s of [-1, 1]) {
    grp.add(mesh(cyl(0.014, 0.016, 0.17, 8), matCarbon, s * 0.18, -0.066, -2.17));
  }

  /* ── REAR WING — named group for flip animation ──────────── */
  const rearWingGrp = new THREE.Group();
  rearWingGrp.name = 'rearWing';
  rearWingGrp.position.set(0, 0.82, 1.68);
  rearWingGrp.add(mesh(wingGeo(1.56, 0.26, 0.080), matBody, 0, 0, 0));
  const f3Flap = mesh(wingGeo(1.56, 0.18, 0.062), matBody, 0, -0.09, -0.05);
  f3Flap.name = 'rearWingFlap';
  rearWingGrp.add(f3Flap);
  for (const s of [-1, 1]) {
    rearWingGrp.add(mesh(box(0.034, 0.42, 0.28), matCarbon, s * 0.78, -0.18, 0));
  }
  rearWingGrp.add(mesh(cyl(0.032, 0.046, 0.56, 10), matCarbon, 0, -0.28, 0));
  grp.add(rearWingGrp);

  /* ── DIFFUSER ─────────────────────────────────────────────── */
  const diff = mesh(box(0.88, 0.048, 0.76), matCarbon, 0, -0.038, 1.68);
  diff.rotation.x = -0.22;
  grp.add(diff);
  for (let di = -1; di <= 1; di++) {
    grp.add(mesh(box(0.016, 0.058, 0.68), matCarbon, di * 0.24, -0.030, 1.66));
  }

  /* ── EXHAUST ──────────────────────────────────────────────── */
  grp.add(mesh(cyl(0.032, 0.036, 0.14, 12), matCarbon, 0.09, 0.20, 1.90));

  /* ── SUSPENSION ───────────────────────────────────────────── */
  for (const s of [-1, 1]) {
    grp.add(wishbone(0.50, matCarbon, s * 0.34, 0.11, -1.25, s * 0.40));
    grp.add(wishbone(0.48, matCarbon, s * 0.32, -0.04, -1.25, s * -0.34));
    grp.add(wishbone(0.48, matCarbon, s * 0.32, 0.10, 1.35, s * 0.38));
    grp.add(wishbone(0.46, matCarbon, s * 0.30, -0.04, 1.35, s * -0.32));
    grp.add(mesh(cyl(0.009, 0.009, 1.14, 8), matCarbon, 0, 0.08, -1.25, 0, 0, Math.PI / 2));
    grp.add(mesh(cyl(0.009, 0.009, 1.10, 8), matCarbon, 0, 0.08,  1.35, 0, 0, Math.PI / 2));
  }

  /* ── WHEELS ───────────────────────────────────────────────── */
  const wR = 0.300, wW = 0.290;
  const wPos = {
    wFL: [-0.68, -0.04, -1.25],
    wFR: [ 0.68, -0.04, -1.25],
    wRL: [-0.66, -0.04,  1.35],
    wRR: [ 0.66, -0.04,  1.35],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n; w.position.set(x, y, z); grp.add(w);
  });

  grp.position.y = wR + 0.34;
  return grp;
}

/* ════════════════════════════════════════════════════════════════
   GT  —  GT3 closed-cockpit sports car (Ferrari 296 / Porsche 992 GT3 R style)
   Wheelbase ~2.80 u  |  Track ~1.70 u  |  Wheel radius 0.338 u

   Fastback roofline built from stacked angled slabs:
     Hood → Windshield (steep) → Roof flat → Rear screen (steep) → Trunk
════════════════════════════════════════════════════════════════ */
function buildGT({ color }) {
  const grp = new THREE.Group();
  grp.name = 'car';

  const matBody   = makeBodyMat(color);
  const matCarbon = makeMat(0x0e0e0e, 0.42, 0.58);
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
  grp.add(mesh(box(1.88, 0.10, 0.20), matCarbon, 0, -0.02, -2.30));
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
  grp.add(mesh(box(1.88, 0.12, 0.18), matCarbon, 0, -0.02, 2.30));
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

  /* ── REAR WING — GT3 swan-neck (named group for flip) ────── */
  const rearWingGrp = new THREE.Group();
  rearWingGrp.name = 'rearWing';
  rearWingGrp.position.set(0, 0.84, 1.92);
  // Main element at pivot origin
  rearWingGrp.add(mesh(wingGeo(1.76, 0.42, 0.110), matBody, 0, 0, 0));
  // Second element (Gurney-like flap) — named for wing-stall animation
  const gtFlap = mesh(wingGeo(1.76, 0.28, 0.075), matBody, 0, -0.10, -0.06);
  gtFlap.name = 'rearWingFlap';
  rearWingGrp.add(gtFlap);
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

  /* ── WHEELS ───────────────────────────────────────────────── */
  const wR = 0.338, wW = 0.260;
  const wPos = {
    wFL: [-0.86, -0.05, -1.38],
    wFR: [ 0.86, -0.05, -1.38],
    wRL: [-0.86, -0.05,  1.42],
    wRR: [ 0.86, -0.05,  1.42],
  };
  Object.entries(wPos).forEach(([n, [x, y, z]]) => {
    const w = wheel(wR, wW, matHub, matTyre, n);
    w.name = n; w.position.set(x, y, z); grp.add(w);
  });

  grp.position.y = wR + 0.34;
  return grp;
}
