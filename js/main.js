/**
 * main.js — FormulaSim core
 * Three.js scene, render loop, camera modes, speed animation, UI wiring
 */

import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { Sky }             from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import { buildCar, getCarMeta, WHEEL_NAMES } from './cars.js';
import { CAR_MANIFEST } from './car-manifest.js';
import { createDebugOverlay } from './debug-overlay.js';
import { buildTrack, buildSkyline } from './track.js';
import { TrackPath, TURN_CFG, steerAngleRad, rollAngleRad, smoothAngle, cameraBankRad, pathBendTable } from './track-path.js';
import { AirflowEffect, RainEffect } from './effects.js';
import { CfdEffect, syncCfdLegend } from './cfd-effect.js';
import { VentEmitterSystem } from './vent-emitters.js';
import { buildOccupancy } from './body-sdf.js';
import { collectOccupancyMeshes } from './car-loader.js';
import { createSwapGuard } from './swap-guard.js';
import { EffectStub } from './effect-stub.js';
import { gearFromSpeed, wheelRotationRate, aeroSquishFactor, rpmRatio, lerpSpeed } from './physics.js';
import {
  BACKGROUND_COLOR, AMBIENT_COLOR, AMBIENT_INTENSITY,
  SUN_COLOR, SUN_INTENSITY, FILL_COLOR, FILL_INTENSITY,
  RIM_COLOR, RIM_INTENSITY, EXPOSURE, SKY, BLOOM, WEATHER,
} from './scene-config.js';

/* ══════════════════════════════════════════════════════════════════
   SCENE SETUP
══════════════════════════════════════════════════════════════════ */
const canvas   = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.toneMapping         = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
renderer.setClearColor(BACKGROUND_COLOR, 1);   // canvas never clears to black

const pmremGenerator = new THREE.PMREMGenerator(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND_COLOR);   // bright sky-blue fallback
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 1.0;
pmremGenerator.dispose();

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100000);
camera.position.set(4.5, 2.5, 6);
camera.lookAt(0, 0.3, 0);

/* ── Orbit controls (active only in orbit mode) ───────────────── */
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.4, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.06;
orbit.minDistance   = 2.5;
orbit.maxDistance   = 18;
orbit.maxPolarAngle = Math.PI * 0.52;

// Debug hook for headless verify scripts (scripts/verify-*.mjs): lets
// Playwright place the camera deterministically instead of faking drags.
// trackPath is attached after construction (declared further down).
window.__fsim = { camera, orbit };

/* ── Lights ───────────────────────────────────────────────────── */
const ambientLight = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
sunLight.position.set(6, 14, -4);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far  = 50;
sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -8;
sunLight.shadow.camera.right = sunLight.shadow.camera.top  =  8;
sunLight.shadow.bias = -0.0003;
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY);
fillLight.position.set(-4, 5, 6);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(RIM_COLOR, RIM_INTENSITY);
rimLight.position.set(0, 2, -8);
scene.add(rimLight);

/* ── Track ────────────────────────────────────────────────────── */
const track = buildTrack();
const trackGroup = track.group;
scene.add(trackGroup);

// Horizon panorama: yaws with the world during turns, never translates.
const skyline = buildSkyline();
scene.add(skyline.group);

/* Virtual driving path — the car is fixed, the track gets the inverse pose. */
const trackPath = new TrackPath();
window.__fsim.trackPath = trackPath;
track.update(trackPath); // initial furniture placement

/* ── Sky — clear bright midday ────────────────────────────────── */
function buildSky() {
  const sky = new Sky();
  sky.scale.setScalar(SKY.scale);
  scene.add(sky);
  const u = sky.material.uniforms;
  u['turbidity'].value       = SKY.turbidity;
  u['rayleigh'].value        = SKY.rayleigh;
  u['mieCoefficient'].value  = SKY.mieCoefficient;
  u['mieDirectionalG'].value = SKY.mieDirectionalG;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(SKY.sunElevationDeg),
    THREE.MathUtils.degToRad(SKY.sunAzimuthDeg)
  );
  u['sunPosition'].value.copy(sunDir);
  sunLight.position.copy(sunDir).multiplyScalar(50);
}
buildSky();

/* ── Post-processing ──────────────────────────────────────────── */
// BLOOM is SELECTIVE: threshold 0.85 means only genuinely emissive surfaces
// (brake discs, headlights, cockpit glow) bloom — the sky (~0.53 luminance)
// stays crisp and does NOT spread into a haze.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  BLOOM.strength,   // 0.28 — subtle
  BLOOM.radius,     // 0.08 — tight spread
  BLOOM.threshold   // 0.85 — only emissives
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

/* ── Debug overlay (no-op unless ?debug=1 is in the URL) ────────── */
const debugOverlay = createDebugOverlay(scene);

/* ══════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════ */
const state = {
  carType:    'F1',
  speed:      0,          // km/h
  targetSpeed: 0,
  paused:     false,
  camMode:    'orbit',    // orbit | trackside | cockpit | drone
  activeEnvs: new Set(),  // 'airflow' | 'rain' | 'cfd'
  turnMode:   'auto',     // 'auto' | 't5' | 't10' | 'only' (TURN_MODES)
  steerVis:   0,          // time-smoothed visual pose (smoothAngle targets)
  rollVis:    0,
  yawVis:     0,
  time:       0,
  carGroup:   null,
  carMeasure: null,       // group.userData.measure snapshot — consumed by effects / overlay
  bodyOccupancy: null,    // Phase B: binary SDF of GLB body meshes for streamline collision
  wheels:     {},
  brakes:     {},
  camT:       0,          // camera path parameter for trackside/drone
  camBank:    0,          // smoothed cinematic camera roll (rad)
};

/* ══════════════════════════════════════════════════════════════════
   CAR MANAGEMENT
══════════════════════════════════════════════════════════════════ */

/**
 * Phase B — Build a binary body-occupancy field from the GLB body meshes
 * of the given car group, for EVERY GLB car (F1 McLaren and GT 992 GT3 RS).
 * Returns null for procedural fallbacks (no manifest collision meshes
 * found) so AirflowEffect treats them as before.
 *
 * Mesh selection is manifest-driven (collectOccupancyMeshes: anchorSources
 * body roles + occupancyMeshes extras, GLTFLoader-sanitization aware).
 * Bounds are MEASURED from the collected meshes' world bbox + margin, so
 * the voxel grid hugs each car's real envelope instead of a hardcoded box —
 * the GT roof (y ≈ 1.32) was clipped by the old fixed y-max of 1.1.
 */
function buildBodyOccupancyFor(grp, carKey) {
  const manifest = CAR_MANIFEST[carKey];
  if (!manifest) return null;

  const meshes = collectOccupancyMeshes(grp, manifest);
  if (meshes.length === 0) return null;  // GLB didn't load (procedural fallback)

  // Ensure world matrices are up-to-date so extracted triangles are in
  // world space — the car group was just added to the scene.
  grp.updateMatrixWorld(true);

  const bbox = new THREE.Box3();
  for (const m of meshes) bbox.union(new THREE.Box3().setFromObject(m));
  const M = 0.15;   // margin so gradients have room to push streamlines out
  const bounds = {
    min: [bbox.min.x - M, bbox.min.y - M, bbox.min.z - M],
    max: [bbox.max.x + M, bbox.max.y + M, bbox.max.z + M],
  };

  const resolution = { x: 96, y: 40, z: 56 };
  const t0 = performance.now();
  const occ = buildOccupancy(meshes, { resolution, bounds });
  const ms = Math.round(performance.now() - t0);
  console.log(`[body-sdf] ${carKey}: ${resolution.x}x${resolution.y}x${resolution.z} voxels in ${ms}ms (${meshes.length} meshes, y ${bounds.min[1].toFixed(2)}..${bounds.max[1].toFixed(2)})`);
  return occ;
}

const carSpawnGuard = createSwapGuard();

async function spawnCar(type) {
  const myToken = carSpawnGuard.begin();
  if (state.carGroup) {
    debugOverlay.detach();
    scene.remove(state.carGroup);
  }
  const grp = await buildCar(type);
  // If another spawnCar started after us, drop this load — it's already stale.
  // Without this guard a slow initial F1 finishing after a user-clicked GT
  // would clobber state.carGroup and leave both bodies in the scene.
  if (!carSpawnGuard.isCurrent(myToken)) return;
  state.carGroup   = grp;
  state.carMeasure = grp.userData.measure ?? null;
  state.wheels   = {};
  state.brakes   = {};
  // GLB-wheel path exposes corner groups via grp.userData.wheels = { FL, FR, RL, RR }.
  // Procedural path exposes wFL/wFR/wRL/wRR meshes by name. Populate state.wheels
  // from whichever is present — animateCar treats both uniformly.
  if (grp.userData?.wheels) {
    Object.assign(state.wheels, grp.userData.wheels);
  } else {
    grp.traverse(obj => {
      if (WHEEL_NAMES.includes(obj.name)) state.wheels[obj.name] = obj;
    });
  }
  grp.traverse(obj => {
    if (obj.name?.startsWith('brake_')) state.brakes[obj.name] = obj;
  });
  scene.add(grp);
  const carKey = String(type).toLowerCase();
  debugOverlay.attach(grp, CAR_MANIFEST[carKey] ?? null, state.carMeasure);

  // Phase B: binary body-occupancy SDF for streamline / smoke collision —
  // built for every GLB car (F1 + GT) from manifest-listed collision meshes;
  // procedural fallbacks return null so AirflowEffect behaves as before.
  // Deferred one frame: voxelizing the GT mega-mesh costs seconds of CPU,
  // so the car paints immediately and the ribbons gain body collision as
  // soon as the field lands (airflow.setCarType rebuilds on occ change).
  state.bodyOccupancy = null;
  requestAnimationFrame(() => {
    if (!carSpawnGuard.isCurrent(myToken)) return;
    state.bodyOccupancy = buildBodyOccupancyFor(grp, carKey);
    if (state.bodyOccupancy) {
      airflow.setCarType(type, state.carMeasure, state.bodyOccupancy);
      // CFD upstream shadowing: world-frame SDF sampled at car-local y +
      // baseY (occupancy frame convention). Forces an overlay recolor.
      cfd.setOccupancy?.(state.bodyOccupancy, grp.userData?.baseY ?? 0);
    }
    wireRainCoupling();   // rain body-splash gains the occupancy once it lands
  });

  airflow.setCarType(type, state.carMeasure, state.bodyOccupancy);
  // CFD body-surface overlay: pressure is painted on the REAL body meshes
  // (collectOccupancyMeshes — same manifest-driven list as the SDF); the
  // rectangle patches only render for procedural fallbacks.
  grp.updateMatrixWorld(true);
  cfd.setBodySurface(collectOccupancyMeshes(grp, CAR_MANIFEST[carKey] ?? null), grp);
  cfd.setCarType(type, state.carMeasure);
  // Phase C: pipe the same feature-aware modifier list into CFD so the
  // pressure map sinks under inlets / low-pressure under the rear wing
  // match the airflow streamlines.
  cfd.setModifiers(airflow.getModifiers());
  rain.setCarType(type, state.carMeasure);
  vents.setCarType(type, state.carMeasure);

  // Propagate ground-lift: all effect groups author coords in car-local
  // space (y=0 at ground-contact plane). Shift them onto the world surface
  // so blobs/streamlines/rain-spray follow the car's actual ride height.
  const baseY = grp.userData?.baseY ?? 0;
  airflow.setBaseY(baseY);
  cfd.setBaseY(baseY);
  vents.setBaseY(baseY);

  // Refresh orbit target to the current car's cockpit anchor so the
  // camera pivots around the actual car, not a hardcoded y=0.4.
  applyOrbitTarget();

  // Update badge
  const meta = getCarMeta(type);
  document.getElementById('car-badge-type').textContent = type;
  document.getElementById('car-badge-name').textContent = meta.label;
}

/* ══════════════════════════════════════════════════════════════════
   EFFECTS
══════════════════════════════════════════════════════════════════ */
// Stub used if an effect fails to construct, so animate() always runs.
// Lives in effect-stub.js (node-testable — main.js can't load outside the
// browser); effect-stub.test.js source-scans this file to keep it complete.

let airflow, rain, cfd, vents;
try { airflow = new AirflowEffect(scene); }
catch (e) { console.error('[AirflowEffect] constructor failed:', e); airflow = new EffectStub(); }
try { rain = new RainEffect(scene); }
catch (e) { console.error('[RainEffect] constructor failed:', e); rain = new EffectStub(); }
try { cfd = new CfdEffect(scene); }
catch (e) { console.error('[CfdEffect] constructor failed:', e); cfd = new EffectStub(); }
try { vents = new VentEmitterSystem(scene); }
catch (e) { console.error('[VentEmitterSystem] constructor failed:', e); vents = new EffectStub(); }

// Initial F1 spawn — surface the error to the console if it fails so a blank
// scene doesn't go unexplained. The swap-token guard inside spawnCar keeps
// this safe against an early user click on a different car-btn.
spawnCar('F1').catch(e => console.error('[init] spawnCar failed:', e));

// Verify-script hook (scripts/verify-cfd-emphasis.mjs): lets Playwright
// inspect the CFD overlay state (mesh counts, colour buffers) headlessly.
window.__fsim.cfd = cfd;

/**
 * Phase 5 (part-precision): wire rain to the airflow field when BOTH envs
 * are active. The sampler translates rain's world-frame coords into
 * airflow's car-local frame (− baseY); occupancy is world-frame already.
 */
function wireRainCoupling() {
  const both = state.activeEnvs.has('airflow') && state.activeEnvs.has('rain');
  // getFlowEnvelope() is null on a stubbed airflow (EffectStub) — no field to couple.
  const env = both && typeof airflow.getFlowEnvelope === 'function' ? airflow.getFlowEnvelope() : null;
  if (env && typeof airflow.sampleFlowAt === 'function' && typeof rain.setFlowCoupling === 'function') {
    const baseY = state.carGroup?.userData?.baseY ?? 0;
    rain.setFlowCoupling(
      (x, y, z) => airflow.sampleFlowAt(x, y - baseY, z),
      state.bodyOccupancy || null,
      { ...env, topY: env.topY + baseY }
    );
  } else {
    rain.setFlowCoupling?.(null, null, null);
  }
}

function syncEffects() {
  const sp = state.speed;
  airflow.setSpeed(sp);
  rain.setSpeed(sp);
  cfd.setSpeed(sp);
  vents.setSpeed(sp);
  airflow.setVisible(state.activeEnvs.has('airflow'));
  rain.setVisible(state.activeEnvs.has('rain'));
  cfd.setVisible(state.activeEnvs.has('cfd'));
  // CFD legend follows the env toggle; the probe tooltip never outlives it.
  syncCfdLegend(document.getElementById('cfd-legend'), state.activeEnvs.has('cfd'));
  if (!state.activeEnvs.has('cfd')) {
    document.getElementById('cfd-probe-tip')?.classList.remove('show');
  }
  wireRainCoupling();
  // Vents are visible whenever the user is viewing the airflow or CFD picture —
  // the vent stream is part of the flow visualisation, not a standalone env.
  vents.setVisible(state.activeEnvs.has('airflow') || state.activeEnvs.has('cfd'));

  // Lighting per weather mode — values from scene-config.js
  const w = state.activeEnvs.has('rain') ? WEATHER.rain : WEATHER.default;
  ambientLight.color.set(w.ambientColor);
  ambientLight.intensity           = w.ambientIntensity;
  sunLight.intensity               = w.sunIntensity;
  renderer.toneMappingExposure     = w.exposure;
}

/* ── CFD hover probe: 10 Hz raycast against the overlay clones ──── */
const probeTip = document.getElementById('cfd-probe-tip');
const probeRaycaster = new THREE.Raycaster();
const probeNdc = new THREE.Vector2();
let probeLastT = 0;

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!probeTip) return;
  if (!state.activeEnvs.has('cfd')) return;          // syncEffects hides the tip
  const now = performance.now();
  if (now - probeLastT < 100) return;                // throttle to 10 Hz
  probeLastT = now;

  probeNdc.set(
    (e.clientX / window.innerWidth)  *  2 - 1,
    (e.clientY / window.innerHeight) * -2 + 1,
  );
  probeRaycaster.setFromCamera(probeNdc, camera);
  const res = cfd.raycastCp?.(probeRaycaster);
  if (res) {
    probeTip.textContent = `Cp ≈ ${res.cp.toFixed(2)}`;
    probeTip.style.left = `${e.clientX + 14}px`;
    probeTip.style.top  = `${e.clientY - 10}px`;
    probeTip.classList.add('show');
  } else {
    probeTip.classList.remove('show');
  }
});

/* ══════════════════════════════════════════════════════════════════
   CAMERA MODES
══════════════════════════════════════════════════════════════════ */

/**
 * Return a world-space look/pivot point for a named anchor. The measure's
 * anchors live in car-local space (pre-lift), so we add baseY here to land
 * on the surface the car actually sits at. Fallback coords match the old
 * hardcoded values so a fresh (unspawned) camera still frames roughly
 * where the car will appear.
 */
function anchorWorld(name, fallback) {
  const m = state.carMeasure;
  const a = m?.anchors?.[name];
  if (!a) return fallback.clone();
  const baseY = state.carGroup?.userData?.baseY ?? 0;
  return new THREE.Vector3(a.x, a.y + baseY, a.z);
}

function applyOrbitTarget() {
  // Orbit pivots around the cockpit so the user's attention stays on the driver area.
  const t = anchorWorld('cockpit', new THREE.Vector3(0, 0.4, 0));
  orbit.target.copy(t);
}

// Cockpit helmet-cam downward pitch (~7°): frames the nose + front wheels.
const _cockpitPitch = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12);

const CAM_CONFIGS = {
  orbit: {
    label: 'ORBIT',
    enter() {
      orbit.enabled = true;
      applyOrbitTarget();
    },
    update(_dt) { /* OrbitControls handles it */ },
  },

  trackside: {
    label: 'TRACKSIDE',
    enter() {
      orbit.enabled = false;
      state.camT = 0;
    },
    update(dt) {
      const speed   = state.speed;
      const tSpeed  = 0.08 + (speed / 350) * 0.3; // pan speed
      state.camT   += dt * (state.paused ? 0 : tSpeed) * 0.4;

      // Trackside — fixed low angle, oscillating Z, looks at cockpit height.
      const t = state.camT;
      const swing = Math.sin(t * 0.6) * 3.5;
      const targetPos = new THREE.Vector3(5.5, 0.6, swing);
      camera.position.lerp(targetPos, 0.02);
      const look = anchorWorld('cockpit', new THREE.Vector3(0, 0.5, 0));
      camera.lookAt(look);
    },
  },

  cockpit: {
    label: 'COCKPIT',
    enter() { orbit.enabled = false; },
    update(_dt) {
      if (!state.carGroup) return;
      // Helmet-cam: RIGIDLY attached to the chassis. The camera inherits the
      // car's FULL orientation (yaw + roll + pitch), so in a turn the body
      // stays fixed in frame and the horizon banks — real onboard feel. The
      // old lookAt() kept camera-up world-vertical, so the ±7° body roll
      // rocked the car around a level camera ("tilting like a boat").
      const a = state.carMeasure?.anchors?.cockpit;
      const cockpitLocal = a
        ? new THREE.Vector3(a.x, a.y + 0.14, a.z - 0.10)   // eye above headrest, nudged forward
        : new THREE.Vector3(0, 0.69, 0.20);
      const worldPos = cockpitLocal.applyMatrix4(state.carGroup.matrixWorld);
      camera.position.copy(worldPos);
      // Car forward is -Z = camera default view axis: copy the quaternion,
      // then pitch down ~7° in the CAR frame so the nose and both steering
      // front wheels sit in the lower third of the frame.
      camera.quaternion.copy(state.carGroup.quaternion);
      camera.quaternion.multiply(_cockpitPitch);
    },
  },

  drone: {
    label: 'DRONE',
    enter() {
      orbit.enabled = false;
      state.camT = 0;
    },
    update(dt) {
      state.camT += dt * (state.paused ? 0 : 0.25);
      const t    = state.camT;
      const r    = 7 + Math.sin(t * 0.5) * 1.5;
      const x    = Math.sin(t * 0.4) * r;
      const z    = Math.cos(t * 0.4) * r;
      const y    = 3.5 + Math.sin(t * 0.28) * 1.2;
      const target = new THREE.Vector3(x, y, z);
      camera.position.lerp(target, 0.025);
      const look = anchorWorld('halo', new THREE.Vector3(0, 0.6, 0));
      camera.lookAt(look);
    },
  },
};

function switchCamera(mode) {
  state.camMode = mode;
  CAM_CONFIGS[mode].enter();
  document.getElementById('camera-label').textContent = CAM_CONFIGS[mode].label;

  document.querySelectorAll('.cam-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.cam === mode);
  });
}

/* ══════════════════════════════════════════════════════════════════
   HUD UPDATE
══════════════════════════════════════════════════════════════════ */
const GEARS = ['N', '1', '2', '3', '4', '5', '6', '7', '8'];

function updateHUD(speed) {
  document.getElementById('speed-value').textContent = Math.round(speed);

  const gear = gearFromSpeed(speed);
  document.getElementById('gear-display').textContent = GEARS[gear];

  const rpmVal = rpmRatio(speed);
  const fill = document.getElementById('rpm-fill');
  fill.style.width  = `${rpmVal * 100}%`;
  fill.classList.toggle('redline', rpmVal > 0.88);
}

/* ══════════════════════════════════════════════════════════════════
   EFFECTS CHIPS
══════════════════════════════════════════════════════════════════ */
const TURN_CHIP_LABELS = { t5: '↩ TURNS 5/30s', t10: '↩ TURNS 10/30s', only: '↩ TURNS ONLY' };

function updateChips() {
  const container = document.getElementById('effects-chips');
  container.innerHTML = '';
  const labels = { airflow: '🌬 AIRFLOW', rain: '🌧 RAIN', cfd: '🔬 CFD' };
  state.activeEnvs.forEach(env => {
    const chip = document.createElement('div');
    chip.className = `chip chip-${env}`;
    chip.textContent = labels[env];
    container.appendChild(chip);
  });
  if (state.turnMode !== 'auto') {           // scene must mirror the selection
    const chip = document.createElement('div');
    chip.className = 'chip chip-turns';
    chip.textContent = TURN_CHIP_LABELS[state.turnMode];
    container.appendChild(chip);
  }
}

/* ══════════════════════════════════════════════════════════════════
   ANIMATION / PHYSICS
══════════════════════════════════════════════════════════════════ */
function animateCar(dt) {
  if (!state.carGroup) return;

  const speed = state.speed;
  const t     = state.time;

  // ─ Wheel rotation (proportional to speed). Circumference uses the car's
  //   measured wheelRadius when available (GLB path) so rotation rate matches
  //   the real tyre, not a hard-coded value.
  const wR = state.carMeasure?.wheelRadius ?? 0.3325;   // 2π·0.3325 ≈ 2.09
  const rotPerSec = wheelRotationRate(speed, 2 * Math.PI * wR);
  const dRot      = rotPerSec * dt * Math.PI * 2;

  // Rotate whatever wheel objects spawnCar populated — procedural (wFL/wFR/...)
  // or GLB corner groups (FL/FR/RL/RR). Each spins independently around local X.
  Object.values(state.wheels).forEach(w => {
    if (w) w.rotation.x += dRot;
  });

  // ─ Brake glow
  const speedFactor = speed / 350;
  const brakeGlow   = Math.max(0, (speedFactor - 0.28) / 0.72);
  Object.values(state.brakes).forEach(b => {
    // Guard: a future GLB extraction could surface a brake_* parent Group
    // without an immediate .material. Skip it rather than throw every frame.
    if (b?.material) b.material.emissiveIntensity = brakeGlow * brakeGlow * 1.2;
  });

  // ─ Idle vibration — OFFSET from userData.baseY so we preserve ground contact.
  //   Overwriting position.y (old bug) dropped the car onto Y=0 and floated/sunk it.
  const baseY = state.carGroup.userData.baseY ?? state.carGroup.position.y;
  if (speed < 5) {
    state.carGroup.position.y = baseY + Math.sin(t * 28) * 0.003;
  } else {
    state.carGroup.position.y = baseY;
  }

  // ─ Speed-based body roll / aero compression
  state.carGroup.scale.y = aeroSquishFactor(speed);

  // ─ Slight forward lean at speed
  state.carGroup.rotation.x = -rpmRatio(speed) * 0.025;

  // ─ Turn pose — driven by the path curvature under the car.
  //   Steer the front wheels (YXZ so the spin axle tilts with the steer),
  //   roll the body outward (real lateral g, capped 4°), nose-in yaw ≤2°.
  const mps   = speed / 3.6;
  const kappa = trackPath.curvatureAt(trackPath.pose.s);
  const omega = mps * kappa;
  // Time-smooth the visual pose targets (steer/roll/yaw share the same
  // curvature trapezoid — smoothing all three keeps the whole car fluid).
  const steer = steerAngleRad(kappa, state.carMeasure?.wheelbase ?? 3.6);
  state.steerVis = smoothAngle(state.steerVis, steer, dt);
  for (const key of ['FL', 'FR', 'wFL', 'wFR']) {
    const w = state.wheels[key];
    if (w) { w.rotation.order = 'YXZ'; w.rotation.y = state.steerVis; }
  }
  state.rollVis = smoothAngle(state.rollVis, rollAngleRad(mps, omega), dt);
  state.carGroup.rotation.z = state.rollVis;
  // Nose-in yaw ≤4° — clamp the ratio: the REAL_CORNER's fixed R 85 geometry
  // can push ω to ~3× MAX_YAW_RATE at top speed.
  const yawRatio = Math.max(-1, Math.min(1, omega / TURN_CFG.MAX_YAW_RATE));
  state.yawVis = smoothAngle(state.yawVis, yawRatio * 0.07, dt);
  state.carGroup.rotation.y = state.yawVis;
}

/* ══════════════════════════════════════════════════════════════════
   TRACK MOTION
══════════════════════════════════════════════════════════════════ */
function updateTrack(dt) {
  if (state.paused) return;
  const mps = state.speed / 3.6;

  // Advance the virtual car along the path (schedules random turns) and
  // apply the INVERSE car pose to the whole track group — the car stays
  // at the origin while the world curves around it.
  trackPath.update(dt, mps);
  trackPath.rebaseIfNeeded();          // floating origin every 1 km
  const w = trackPath.worldTransform();
  trackGroup.rotation.y = w.rotY;
  trackGroup.position.set(w.x, 0, w.z);
  skyline.group.rotation.y = w.rotY;   // horizon yaws with the turn, stays centred

  // Recycle furniture rows through the sliding window.
  track.update(trackPath);
}

/* ══════════════════════════════════════════════════════════════════
   RENDER LOOP
══════════════════════════════════════════════════════════════════ */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  if (!state.paused) state.time += dt;

  // Smooth speed towards target
  state.speed = lerpSpeed(state.speed, state.targetSpeed, 60, 90, dt);

  // Camera
  CAM_CONFIGS[state.camMode].update(dt);
  if (state.camMode === 'orbit') orbit.update();

  // Cinematic bank — roll into the turn AFTER lookAt/orbit set the
  // orientation (they reset roll every frame). Smoothed ~0.35 s so the
  // horizon eases over rather than snapping with the curvature profile.
  // Cockpit is rigidly chassis-mounted — its roll comes from the car body
  // itself; stacking the cinematic bank on top fought the (opposite-signed)
  // outward body roll and read as a drunken wobble.
  const bankTarget = (state.paused || state.camMode === 'cockpit')
    ? 0 : cameraBankRad(trackPath.yawRate(state.speed / 3.6));
  state.camBank += (bankTarget - state.camBank) * Math.min(1, dt / 0.35);
  if (state.camBank !== 0 && state.camMode !== 'cockpit') camera.rotateZ(state.camBank);

  // Car animation + track motion
  if (!state.paused) animateCar(dt);
  updateTrack(dt);

  // Effects
  if (!state.paused) {
    // Turn coupling. Ribbons bend along the EXACT road geometry (sampled
    // fresh each frame), so airflow and track cannot diverge mid-corner.
    // Rain keeps the ω-based centrifugal accel, clamped ±0.6 rad/s — its
    // gains were tuned near MAX_YAW_RATE and the REAL_CORNER reaches ~0.9.
    const turnOmega = Math.max(-0.6, Math.min(0.6, trackPath.yawRate(state.speed / 3.6)));
    // Per-frame speed propagation: state.speed lerps toward the target every
    // frame, but syncEffects only fires on UI events — without this the flow
    // picture (and the Phase-4 speed-bucket retrace) would freeze at the
    // speed captured when the user last clicked.
    airflow.setSpeed(state.speed);
    rain.setSpeed(state.speed);
    // CFD too — its overlay opacity and recolor threshold read _speed; the
    // >5 km/h rebake trigger keeps the per-frame call amortized. Without
    // this, a single preset click left the overlay at the click-instant
    // speed (≈0) forever — CFD invisible in any deterministic session.
    cfd.setSpeed(state.speed);
    // Vents too — inlet phase advance and outlet jet speed read _speed in
    // update(); without this the vent streams freeze at the last-clicked
    // speed while state.speed lerps toward its target.
    vents.setSpeed(state.speed);
    airflow.setPathBend?.(pathBendTable(trackPath));
    airflow.setTurnState?.(turnOmega, state.speed / 3.6);
    rain.setTurnState?.(turnOmega, state.speed / 3.6);
    try { airflow.update(dt, state.time); } catch (e) { console.error('[airflow.update]', e); }
    try { rain.update(dt, state.time); }    catch (e) { console.error('[rain.update]', e); }
    try { cfd.update(dt, state.time); }     catch (e) { console.error('[cfd.update]', e); }
    try { vents.update(dt); }               catch (e) { console.error('[vents.update]', e); }
  }

  // HUD
  updateHUD(state.speed);

  composer.render();
}

animate();

/* ══════════════════════════════════════════════════════════════════
   UI WIRING
══════════════════════════════════════════════════════════════════ */

/* ── Car selection ──────────────────────────────────────────────── */
document.querySelectorAll('.car-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const type = btn.dataset.car;
    if (type === state.carType) return;
    state.carType = type;

    document.querySelectorAll('.car-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    await spawnCar(type);
    syncEffects();
  });
});

/* ── Speed slider ───────────────────────────────────────────────── */
const speedSlider = document.getElementById('speed-slider');
const speedLabel  = document.getElementById('speed-label-val');

function setSpeed(v) {
  state.targetSpeed = v;
  speedSlider.value = v;
  speedLabel.textContent = v;
  syncEffects();
}

speedSlider.addEventListener('input', () => setSpeed(Number(speedSlider.value)));

// Scoped to the speed section — `.turn-btn` also carries `.preset-btn` (style only).
document.querySelectorAll('#speed-presets .preset-btn').forEach(btn => {
  btn.addEventListener('click', () => setSpeed(Number(btn.dataset.speed)));
});

/* ── TURNS frequency ────────────────────────────────────────────── */
function applyTurnMode(mode) {
  state.turnMode = mode;
  trackPath.setTurnMode(mode);
  document.querySelectorAll('.turn-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.turnMode === mode));
  updateChips();
}

document.querySelectorAll('.turn-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.turnMode;
    if (mode === state.turnMode) return;
    applyTurnMode(mode);
  });
});

/* ── Environment toggles ────────────────────────────────────────── */
document.querySelectorAll('.env-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const env = btn.dataset.env;
    if (state.activeEnvs.has(env)) {
      state.activeEnvs.delete(env);
      btn.classList.remove('active');
    } else {
      state.activeEnvs.add(env);
      btn.classList.add('active');
    }
    updateChips();
    syncEffects();
  });
});

/* ── Camera buttons ─────────────────────────────────────────────── */
document.querySelectorAll('.cam-btn').forEach(btn => {
  btn.addEventListener('click', () => switchCamera(btn.dataset.cam));
});

/* ── Play / Pause ───────────────────────────────────────────────── */
const playBtn = document.getElementById('play-pause-btn');
playBtn.addEventListener('click', () => {
  state.paused = !state.paused;
  if (state.paused) {
    playBtn.innerHTML = '&#9654; PLAY';
    playBtn.classList.remove('playing');
  } else {
    playBtn.innerHTML = '&#9646;&#9646; PAUSE';
    playBtn.classList.add('playing');
  }
});
playBtn.classList.add('playing');

/* ── Reset ──────────────────────────────────────────────────────── */
document.getElementById('reset-btn').addEventListener('click', () => {
  setSpeed(0);
  state.paused = false;
  playBtn.innerHTML = '&#9646;&#9646; PAUSE';
  playBtn.classList.add('playing');

  // Reset camera
  switchCamera('orbit');
  applyOrbitTarget();
  camera.position.set(4.5, 2.5, 6);

  // Deactivate all envs
  state.activeEnvs.clear();
  document.querySelectorAll('.env-btn').forEach(b => b.classList.remove('active'));
  // Back to the default turn schedule — reset means the full selection resets
  applyTurnMode('auto');
  updateChips();
  syncEffects();
});

/* ── Panel collapse (desktop only) ─────────────────────────────── */
const panel       = document.getElementById('panel');
const panelToggle = document.getElementById('panel-toggle');
const camLabel    = document.getElementById('camera-label');

if (window.innerWidth > 640) {
  const panelHeader = document.getElementById('panel-header');
  panelHeader.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    panelToggle.title = collapsed ? 'Expand' : 'Collapse';
    camLabel.style.right = collapsed ? '32px' : 'calc(var(--panel-w) + 32px)';
  });
}

/* ── Mobile tab bar ─────────────────────────────────────────────── */
if (window.innerWidth <= 640) {
  const panelBody        = document.getElementById('panel-body');
  const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
  const tabBtns          = document.querySelectorAll('.tab-btn');
  const sections         = document.querySelectorAll('#panel-body .ctrl-group');
  let activeSection      = null;

  function openSection(sectionId) {
    sections.forEach(s => s.classList.remove('active'));
    tabBtns.forEach(b => b.classList.remove('active'));
    const target = document.getElementById(sectionId);
    if (target) target.classList.add('active');
    panelBody.classList.add('open');
    mobileMenuToggle.classList.add('open');
    activeSection = sectionId;
    const btn = document.querySelector(`.tab-btn[data-section="${sectionId}"]`);
    if (btn) btn.classList.add('active');
  }

  function closePanel() {
    panelBody.classList.remove('open');
    mobileMenuToggle.classList.remove('open');
    tabBtns.forEach(b => b.classList.remove('active'));
    activeSection = null;
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.section;
      if (panelBody.classList.contains('open') && activeSection === sid) {
        closePanel();
      } else {
        openSection(sid);
      }
    });
  });

  mobileMenuToggle.addEventListener('click', () => {
    if (panelBody.classList.contains('open')) {
      closePanel();
    } else {
      openSection(activeSection || 'section-car');
    }
  });
}

/* ── Orbit hint ─────────────────────────────────────────────────── */
const hintEl = document.createElement('div');
hintEl.id = 'orbit-hint';
hintEl.textContent = 'DRAG TO ORBIT  ·  SCROLL TO ZOOM';
document.body.appendChild(hintEl);
setTimeout(() => hintEl.classList.add('hidden'), 4000);

/* ── Window resize ─────────────────────────────────────────────── */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

/* ── Keyboard shortcuts ─────────────────────────────────────────── */
window.addEventListener('keydown', e => {
  switch (e.key) {
    case ' ':
      e.preventDefault();
      document.getElementById('play-pause-btn').click();
      break;
    case '1': switchCamera('orbit');     break;
    case '2': switchCamera('trackside'); break;
    case '3': switchCamera('cockpit');   break;
    case '4': switchCamera('drone');     break;
    case 'ArrowUp':
      e.preventDefault();
      setSpeed(Math.min(350, state.targetSpeed + 20));
      break;
    case 'ArrowDown':
      e.preventDefault();
      setSpeed(Math.max(0, state.targetSpeed - 20));
      break;
    case 'r': case 'R':
      document.getElementById('reset-btn').click();
      break;
  }
});
