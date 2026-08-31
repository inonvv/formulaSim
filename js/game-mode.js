/**
 * game-mode.js — ARCADE RACE mode core (pure math, no THREE/DOM).
 *
 * State machine + lateral strafe physics for the arcade game. main.js only
 * wires this: input capture, world offset, camera juice, tilt application.
 * Constants are pinned by game-mode.test.js against the plan
 * (docs/plans/arcade-race-mode.md).
 *
 * Conventions:
 *   • playerX > 0 = car strafed RIGHT of the road centreline (world +x).
 *   • The car never moves — the WORLD gets −playerX (worldOffsetX), exactly
 *     like the track's inverse pose. Sign chain (pinned): vx > 0 ⇒
 *     playerX > 0 ⇒ world shifts −x ⇒ apparent wind gains a +x component
 *     (consumed by the Phase C crosswind coupling).
 *   • All smoothing is one-pole 1 − exp(−dt/tau) — frame-rate independent.
 */

import { smoothAngle, steerAngleRad } from './track-path.js';

export const GAME_CFG = {
  RUN_TIME:   90,     // s — arcade run length
  COUNT_TICK: 0.9,    // s per countdown digit (3, 2, 1)
  GO_HOLD:    0.5,    // s the "GO" (countdown = 0) frame holds before running
  VX_GAIN:    0.12,   // vxMax = clamp(VX_GAIN·vFwd, VX_MIN, VX_MAX) m/s
  VX_MIN:     3,
  VX_MAX:     9,
  VX_TAU:     0.12,   // s — one-pole lateral-velocity smoothing
  X_HARD:     12,     // m — hard clamp on |playerX|
  X_SOFT:     10,     // m — soft-zone start: spring + edgeRumble beyond this
  SPRING_K:   25,     // m/s² per metre past X_SOFT (a = −K·(|x|−X_SOFT))
  TILT_TAU:   0.12,   // s — visual tilt smoothing
  ROLL_CAP:   (7 * Math.PI) / 180,   // body roll toward strafe
  YAW_CAP:    (4 * Math.PI) / 180,   // nose yaw toward strafe
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ── Sign chain pin — decision 1 ─────────────────────────────────── */
/** World-group x correction for a given player strafe: move the world, not
 *  the car. main.js applies `trackGroup.position.x += worldOffsetX(playerX)`
 *  AFTER the inverse-pose position.set. */
export function worldOffsetX(playerX) {
  return -playerX + 0;   // +0 normalises −0
}

/* ── Lateral strafe physics (pure) ───────────────────────────────── */
/**
 * One integration step of the strafe. Does NOT mutate `prev`.
 * @param {{playerX:number, vx:number}} prev
 * @param {number} input  −1 (left) .. +1 (right), clamped here
 * @param {number} vFwd   forward speed m/s (scales the strafe cap)
 * @param {number} dt     s
 * @returns {{playerX:number, vx:number, edgeRumble:number}}
 */
export function lateralStep(prev, input, vFwd, dt) {
  const C = GAME_CFG;
  let vx = prev.vx;
  let playerX = prev.playerX;
  if (dt > 0) {
    const vxMax  = clamp(C.VX_GAIN * vFwd, C.VX_MIN, C.VX_MAX);
    const target = clamp(input, -1, 1) * vxMax;
    vx += (target - vx) * (1 - Math.exp(-dt / C.VX_TAU));
    // Soft-zone spring: past |x| = X_SOFT push back toward the road.
    const over = Math.abs(playerX) - C.X_SOFT;
    if (over > 0) vx += -C.SPRING_K * over * Math.sign(playerX) * dt;
    playerX = clamp(playerX + vx * dt, -C.X_HARD, C.X_HARD);
  }
  const edgeRumble = clamp(
    (Math.abs(playerX) - C.X_SOFT) / (C.X_HARD - C.X_SOFT), 0, 1);
  return { playerX, vx, edgeRumble };
}

/* ── Visual tilt (pure) ──────────────────────────────────────────── */
/** Pseudo-curvature of the arc the car "drives" while strafing: the wheels
 *  point along the velocity vector, tanδ = vx/vFwd ⇒ κ = (vx/vFwd)/wb.
 *  Negative for vx > 0: right strafe = right steer, and in the track
 *  convention positive κ/steer is a LEFT turn. vFwd floored at 8 m/s so a
 *  near-standstill strafe can't blow κ up. */
export function pseudoCurvature(vx, vFwd, wheelbase = 3.6) {
  return -vx / (Math.max(vFwd, 8) * wheelbase);
}

/**
 * Smooth the strafe pose toward its targets (tau TILT_TAU). Additive on top
 * of the turn pose in main.js. Does NOT mutate `prev`. three.js signs:
 * +rot.z tips the roof toward −x and +rot.y yaws the nose toward −x, so
 * "toward the strafe" (right, vx > 0) is negative for all three outputs.
 * @param {{roll:number, yaw:number, steer:number}} prev
 * @returns {{roll:number, yaw:number, steer:number}}
 */
export function tiltStep(prev, vx, vFwd, dt, wheelbase = 3.6) {
  const C = GAME_CFG;
  const n = clamp(vx / C.VX_MAX, -1, 1);
  const rollT  = -C.ROLL_CAP * n;
  const yawT   = -C.YAW_CAP * n;
  const steerT = steerAngleRad(pseudoCurvature(vx, vFwd, wheelbase), wheelbase);
  return {
    roll:  smoothAngle(prev.roll,  rollT,  dt, C.TILT_TAU),
    yaw:   smoothAngle(prev.yaw,   yawT,   dt, C.TILT_TAU),
    steer: smoothAngle(prev.steer, steerT, dt, C.TILT_TAU),
  };
}

/* ── Phase C — immersion helpers (pure) ──────────────────────────── */

/** Dynamic FOV (arcade only): 50° base → 60° at sf 1, scaled by sf²,
 *  one-pole tau 0.45 s. main.js touches the projection matrix only when
 *  |camera.fov − fovStep(...)| > EPS. */
export const FOV_CFG = { BASE: 50, MAX: 60, TAU: 0.45, EPS: 0.05 };

export function fovTarget(sf) {
  const s = clamp(sf, 0, 1);
  return FOV_CFG.BASE + (FOV_CFG.MAX - FOV_CFG.BASE) * s * s;
}

export function fovStep(current, sf, dt) {
  if (!(dt > 0)) return current;
  return current + (fovTarget(sf) - current) * (1 - Math.exp(-dt / FOV_CFG.TAU));
}

/** Near parallax cylinder (R 200 in track.js buildSkyline): forward motion
 *  reads as a slow drift v·dt/(2π·R) rad against the static far ring —
 *  the rotation differential is the depth cue. Accumulated sim time only. */
export function nearParallaxStep(prev, vFwd, dt, radius = 200) {
  if (!(dt > 0)) return prev;
  return prev + (vFwd * dt) / (2 * Math.PI * radius);
}

/**
 * Camera shake (arcade only, camera-local x/y): 2 summed sines per axis in
 * the 15–25 Hz band, peak amplitude 0.006–0.012 m, gain sf² ramping in
 * above sf 0.7. Edge rumble (lateralStep soft zone) adds a 0.02–0.03 m
 * component at 28 Hz regardless of speed. `t` is ACCUMULATED SIM TIME
 * (state.time) — never Date.now(), so the shake pauses with the sim.
 */
export const SHAKE_CFG = { SF_GATE: 0.7, RUMBLE_AMP: 0.025, RUMBLE_HZ: 28 };

export function cameraShake(t, sf, edgeRumble = 0) {
  const s    = clamp(sf, 0, 1);
  const ramp = Math.max(0, (s - SHAKE_CFG.SF_GATE) / (1 - SHAKE_CFG.SF_GATE));
  const gain = ramp * s * s;
  const TAU  = 2 * Math.PI;
  let x = 0, y = 0;
  if (gain > 0) {
    x = gain * (0.007 * Math.sin(TAU * 17 * t) +
                0.004 * Math.sin(TAU * 23 * t + 1.3));
    y = gain * (0.005 * Math.sin(TAU * 15 * t + 0.7) +
                0.004 * Math.sin(TAU * 25 * t + 2.4));
  }
  if (edgeRumble > 0) {
    const r = clamp(edgeRumble, 0, 1) * SHAKE_CFG.RUMBLE_AMP;
    x += r * Math.sin(TAU * SHAKE_CFG.RUMBLE_HZ * t);
    y += r * 0.6 * Math.sin(TAU * SHAKE_CFG.RUMBLE_HZ * t + Math.PI / 2);
  }
  return { x: x + 0, y: y + 0 };   // +0 normalises −0 (toEqual pins exact zero)
}

/* ── Game state machine ──────────────────────────────────────────── */
/**
 * menu → (start) → countdown → running → (timer 0) → gameover → (start) →
 * countdown. Time is accumulated dt only — never wall clock.
 */
export function createGame() {
  const C = GAME_CFG;
  return {
    phase:     'menu',      // 'menu' | 'countdown' | 'running' | 'gameover'
    countdown: 3,           // 3 | 2 | 1 | 0 (0 = "GO"), valid in countdown
    timeLeft:  C.RUN_TIME,  // s remaining in the run
    coins:     0,
    lateral:   { playerX: 0, vx: 0, edgeRumble: 0 },
    _t:        0,           // countdown-phase clock

    /** menu/gameover → countdown with a fresh run. No-op mid-run. */
    start() {
      if (this.phase === 'countdown' || this.phase === 'running') return;
      this.phase     = 'countdown';
      this._t        = 0;
      this.countdown = 3;
      this.timeLeft  = C.RUN_TIME;
      this.coins     = 0;
      this.lateral   = { playerX: 0, vx: 0, edgeRumble: 0 };
    },

    /** Advance the machine by dt seconds. Returns the (new) phase. */
    tick(dt) {
      if (!(dt > 0)) return this.phase;
      if (this.phase === 'countdown') {
        this._t += dt;
        const digits = 3 * C.COUNT_TICK;              // 3-2-1 window
        if (this._t < digits) {
          this.countdown = 3 - Math.floor(this._t / C.COUNT_TICK);
        } else if (this._t < digits + C.GO_HOLD) {
          this.countdown = 0;                          // "GO"
        } else {
          this.phase = 'running';
        }
      } else if (this.phase === 'running') {
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        if (this.timeLeft === 0) this.phase = 'gameover';
      }
      return this.phase;
    },

    /** Coin pickup — running only. Returns whether it counted. */
    collect() {
      if (this.phase !== 'running') return false;
      this.coins += 1;
      return true;
    },

    /** Back to menu; everything zeroed (used when leaving arcade mode). */
    reset() {
      this.phase     = 'menu';
      this._t        = 0;
      this.countdown = 3;
      this.timeLeft  = C.RUN_TIME;
      this.coins     = 0;
      this.lateral   = { playerX: 0, vx: 0, edgeRumble: 0 };
    },
  };
}
