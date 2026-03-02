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
import { buildTrack }      from './track.js';
import { AirflowEffect, RainEffect, OptimalWeatherEffect } from './effects.js';
import { CfdEffect } from './cfd-effect.js';
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
scene.environmentIntensity = 1.5;
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
const { group: trackGroup, groundTex, dashMeshes, rumbleGroup, sfBand } = buildTrack();
scene.add(trackGroup);

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

/* ══════════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════════ */
const state = {
  carType:    'F1',
  speed:      0,          // km/h
  targetSpeed: 0,
  paused:     false,
  camMode:    'orbit',    // orbit | trackside | cockpit | drone
  activeEnvs: new Set(),  // 'airflow' | 'rain' | 'optimal' | 'cfd'
  time:       0,
  carGroup:   null,
  wheels:     {},
  brakes:     {},
  camT:       0,          // camera path parameter for trackside/drone
  // Wing flip (only the top DRS flap element rotates)
  wingFlipped:  false,
  wingFlipT:    0,
  wingFlipping: false,
  rearWing:     null,   // whole group (kept for reference)
  rearWingFlap: null,   // top flap mesh — the only thing that rotates
};

/* ══════════════════════════════════════════════════════════════════
   CAR MANAGEMENT
══════════════════════════════════════════════════════════════════ */
function spawnCar(type) {
  if (state.carGroup) {
    scene.remove(state.carGroup);
  }
  const grp = buildCar(type);
  state.carGroup = grp;
  state.wheels   = {};
  state.brakes   = {};
  state.rearWing     = null;
  state.rearWingFlap = null;
  grp.traverse(obj => {
    if (WHEEL_NAMES.includes(obj.name))    state.wheels[obj.name] = obj;
    if (obj.name?.startsWith('brake_'))    state.brakes[obj.name] = obj;
    if (obj.name === 'rearWing')           state.rearWing = obj;
    if (obj.name === 'rearWingFlap')       state.rearWingFlap = obj;
  });
  scene.add(grp);
  airflow.setCarType(type);
  cfd.setCarType(type);
  rain.setCarType(type);

  // Reset wing flip state on car change
  state.wingFlipped  = false;
  state.wingFlipping = false;
  state.wingFlipT    = 0;
  if (state.rearWingFlap) state.rearWingFlap.rotation.x = 0;
  airflow.setWingStall(false);
  cfd.setWingStall(false);
  const wingBtn = document.getElementById('btn-wing-flip');
  if (wingBtn) wingBtn.classList.remove('active');

  // Update badge
  const meta = getCarMeta(type);
  document.getElementById('car-badge-type').textContent = type;
  document.getElementById('car-badge-name').textContent = meta.label;
}

/* ══════════════════════════════════════════════════════════════════
   EFFECTS
══════════════════════════════════════════════════════════════════ */
// Stub used if an effect fails to construct, so animate() always runs
class EffectStub {
  setSpeed() {} setVisible() {} setCarType() {} update() {} dispose() {}
  setWingStall() {}
}

let airflow, rain, optimal, cfd;
try { airflow = new AirflowEffect(scene); }
catch (e) { console.error('[AirflowEffect] constructor failed:', e); airflow = new EffectStub(); }
try { rain = new RainEffect(scene); }
catch (e) { console.error('[RainEffect] constructor failed:', e); rain = new EffectStub(); }
try { optimal = new OptimalWeatherEffect(scene, renderer); }
catch (e) { console.error('[OptimalWeatherEffect] constructor failed:', e); optimal = new EffectStub(); }
try { cfd = new CfdEffect(scene); }
catch (e) { console.error('[CfdEffect] constructor failed:', e); cfd = new EffectStub(); }

spawnCar('F1');

function syncEffects() {
  const sp = state.speed;
  airflow.setSpeed(sp);
  rain.setSpeed(sp);
  optimal.setSpeed(sp);
  cfd.setSpeed(sp);
  airflow.setVisible(state.activeEnvs.has('airflow'));
  rain.setVisible(state.activeEnvs.has('rain'));
  optimal.setVisible(state.activeEnvs.has('optimal'));
  cfd.setVisible(state.activeEnvs.has('cfd'));
  airflow.setWingStall(state.wingFlipped);
  cfd.setWingStall(state.wingFlipped);

  // Lighting per weather mode — values from scene-config.js
  const w = state.activeEnvs.has('rain')    ? WEATHER.rain
          : state.activeEnvs.has('optimal') ? WEATHER.optimal
          : WEATHER.default;
  ambientLight.color.set(w.ambientColor);
  ambientLight.intensity           = w.ambientIntensity;
  sunLight.intensity               = w.sunIntensity;
  renderer.toneMappingExposure     = w.exposure;
}

/* ══════════════════════════════════════════════════════════════════
   CAMERA MODES
══════════════════════════════════════════════════════════════════ */
const CAM_CONFIGS = {
  orbit: {
    label: 'ORBIT',
    enter() {
      orbit.enabled = true;
      orbit.target.set(0, 0.4, 0);
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

      // Trackside — fixed low angle, oscillating Z
      const t = state.camT;
      const swing = Math.sin(t * 0.6) * 3.5;
      const targetPos = new THREE.Vector3(5.5, 0.6, swing);
      camera.position.lerp(targetPos, 0.02);
      camera.lookAt(0, 0.5, 0);
    },
  },

  cockpit: {
    label: 'COCKPIT',
    enter() { orbit.enabled = false; },
    update(_dt) {
      if (!state.carGroup) return;
      // Position inside cockpit (above tub centre)
      const cockpitLocal = new THREE.Vector3(0, 0.55, 0.3);
      const worldPos     = cockpitLocal.applyMatrix4(state.carGroup.matrixWorld);
      camera.position.copy(worldPos);
      // Look forward along car's -Z
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(state.carGroup.quaternion);
      const lookAt  = worldPos.clone().add(forward.multiplyScalar(8));
      camera.lookAt(lookAt);
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
      camera.lookAt(0, 0.6, 0);
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
function updateChips() {
  const container = document.getElementById('effects-chips');
  container.innerHTML = '';
  const labels = { airflow: '🌬 AIRFLOW', rain: '🌧 RAIN', optimal: '☀ OPTIMAL', cfd: '🔬 CFD' };
  state.activeEnvs.forEach(env => {
    const chip = document.createElement('div');
    chip.className = `chip chip-${env}`;
    chip.textContent = labels[env];
    container.appendChild(chip);
  });
}

/* ══════════════════════════════════════════════════════════════════
   ANIMATION / PHYSICS
══════════════════════════════════════════════════════════════════ */
function animateCar(dt) {
  if (!state.carGroup) return;

  const speed = state.speed;
  const t     = state.time;

  // ─ Wheel rotation (proportional to speed)
  const rotPerSec = wheelRotationRate(speed, 2.09);
  const dRot      = rotPerSec * dt * Math.PI * 2;

  WHEEL_NAMES.forEach(name => {
    const w = state.wheels[name];
    if (w) w.rotation.x += dRot;
  });

  // ─ Brake glow
  const speedFactor = speed / 350;
  const brakeGlow   = Math.max(0, (speedFactor - 0.28) / 0.72);
  Object.values(state.brakes).forEach(b => {
    b.material.emissiveIntensity = brakeGlow * brakeGlow * 1.2;
  });

  // ─ Idle vibration
  if (speed < 5) {
    state.carGroup.position.y = Math.sin(t * 28) * 0.003;
  }

  // ─ Speed-based body roll / aero compression
  state.carGroup.scale.y = aeroSquishFactor(speed);

  // ─ Slight forward lean at speed
  state.carGroup.rotation.x = -rpmRatio(speed) * 0.025;

  // ─ Wing flap animation (top DRS flap only)
  if (state.rearWingFlap && state.wingFlipping) {
    const FLIP_DURATION = 0.8;
    state.wingFlipT = Math.min(1, state.wingFlipT + dt / FLIP_DURATION);
    if (state.wingFlipT >= 1) state.wingFlipping = false;
    const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const target = state.wingFlipped ? Math.PI : 0;
    const start  = state.wingFlipped ? 0        : Math.PI;
    state.rearWingFlap.rotation.x = start + (target - start) * ease(state.wingFlipT);
  }
}

/* ══════════════════════════════════════════════════════════════════
   TRACK MOTION
══════════════════════════════════════════════════════════════════ */
const DASH_CYCLE   = 60;     // 15 dashes × 4 m
const RUMBLE_CYCLE = 0.6;    // one rumble tile
const TRACK_LEN    = 70;     // full track length

function updateTrack(dt) {
  if (state.paused) return;
  const mps = state.speed / 3.6;
  if (mps < 0.001) return;

  // Ground texture UV scroll
  groundTex.offset.y += mps * dt / (TRACK_LEN / 36);

  // Centre-line dashes
  for (const d of dashMeshes) {
    d.position.z += mps * dt;
    if (d.position.z > 32) d.position.z -= DASH_CYCLE;
  }

  // Rumble strips (both sides, one group)
  rumbleGroup.position.z += mps * dt;
  if (rumbleGroup.position.z >= RUMBLE_CYCLE) rumbleGroup.position.z -= RUMBLE_CYCLE;

  // Start/finish band
  sfBand.position.z += mps * dt;
  if (sfBand.position.z > 35) sfBand.position.z -= TRACK_LEN;
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

  // Car animation + track motion
  if (!state.paused) animateCar(dt);
  updateTrack(dt);

  // Effects
  if (!state.paused) {
    try { airflow.update(dt, state.time); } catch (e) { console.error('[airflow.update]', e); }
    try { rain.update(dt, state.time); }    catch (e) { console.error('[rain.update]', e); }
    try { optimal.update(dt, state.time); } catch (e) { console.error('[optimal.update]', e); }
    try { cfd.update(dt, state.time); }     catch (e) { console.error('[cfd.update]', e); }
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
  btn.addEventListener('click', () => {
    const type = btn.dataset.car;
    if (type === state.carType) return;
    state.carType = type;

    document.querySelectorAll('.car-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    spawnCar(type);
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

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => setSpeed(Number(btn.dataset.speed)));
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

/* ── Wing Stall button ──────────────────────────────────────────── */
document.getElementById('btn-wing-flip').addEventListener('click', () => {
  if (state.wingFlipping) return;
  state.wingFlipped  = !state.wingFlipped;
  state.wingFlipT    = 0;
  state.wingFlipping = true;
  document.getElementById('btn-wing-flip').classList.toggle('active', state.wingFlipped);
  if (state.activeEnvs.has('airflow')) airflow.setWingStall(state.wingFlipped);
  if (state.activeEnvs.has('cfd'))     cfd.setWingStall(state.wingFlipped);
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
  orbit.target.set(0, 0.4, 0);
  camera.position.set(4.5, 2.5, 6);

  // Deactivate all envs (including wing stall)
  state.activeEnvs.clear();
  document.querySelectorAll('.env-btn').forEach(b => b.classList.remove('active'));
  state.wingFlipped  = false;
  state.wingFlipping = false;
  state.wingFlipT    = 0;
  if (state.rearWingFlap) state.rearWingFlap.rotation.x = 0;
  airflow.setWingStall(false);
  cfd.setWingStall(false);
  const wingBtnReset = document.getElementById('btn-wing-flip');
  if (wingBtnReset) wingBtnReset.classList.remove('active');
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
