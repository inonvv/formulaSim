/**
 * track-path.js — Curved-track path model (pure math, no THREE/DOM).
 *
 * The car never moves in world space; it drives a virtual path in "track
 * space" and the whole track group is given the INVERSE of the car's pose
 * each frame. Turns are emitted ahead of the car as fixed arc-length
 * geometry so the bend is visible before the car reaches it.
 *
 * Conventions (pinned by track-path.test.js):
 *   • Car starts at track-space origin heading −z: forward(θ) = (−sinθ, −cosθ).
 *   • Positive curvature/yaw ⇒ θ grows ⇒ nose toward −x ⇒ LEFT turn.
 *   • κ(s) = dir·κmax·sin²(π(s−s0)/L) with κmax = MAX_YAW_RATE/v_emit
 *     clamped to 1/MIN_RADIUS; L = duration·v_emit. ∫κ ds = κmax·L/2.
 */

export const TURN_CFG = {
  GAP_MIN_S:    20,    // s of driving time between turns (uniform)
  GAP_MAX_S:    35,
  DUR_MIN_S:    3,     // s sweep duration at emit speed (uniform)
  DUR_MAX_S:    4,
  MAX_YAW_RATE: 0.14,  // rad/s peak (≈8°/s) — total sweep 12–16°
  MIN_RADIUS:   20,    // m — curvature clamp so low speeds can't hairpin
  LOOKAHEAD:    40,    // m — turn starts beyond the visible road horizon (~35 m)
  REBASE_DIST:  1000,  // m — floating-origin rebase cadence (float32 health)
};

const KNOT_DS = 0.5;   // m — pose integration grid

export class TrackPath {
  constructor(rng = Math.random) {
    this._rng = rng;
    this.turns = [];          // [{s0, s1, kMax, dir, vEmit, emitS}]
    this.epoch = 0;           // bumped on rebase — consumers must re-place rows
    this._gapTimer = 0;
    this._nextGap = this._uniform(TURN_CFG.GAP_MIN_S, TURN_CFG.GAP_MAX_S);
    // progressive integration knots from s=0: forward (s ≥ 0) and backward
    // (s < 0 — the road behind the start) arrays on the KNOT_DS grid
    this._knots = [{ s: 0, x: 0, z: 0, theta: 0 }];
    this._knotsBack = [];
    this._car = { s: 0, x: 0, z: 0, theta: 0 };
  }

  get pose() { return this._car; }

  _uniform(a, b) { return a + this._rng() * (b - a); }

  /* κ(s) from the emitted turn list (turns never overlap). */
  curvatureAt(s) {
    for (const t of this.turns) {
      if (s > t.s0 && s < t.s1) {
        const u = (s - t.s0) / (t.s1 - t.s0);
        const sn = Math.sin(Math.PI * u);
        return t.kMax * sn * sn;
      }
    }
    return 0;
  }

  /* Test hook + internal emitter. Turn geometry is fixed once emitted. */
  _emitTurn({ s0, L, dir, vEmit }) {
    const kUnclamped = TURN_CFG.MAX_YAW_RATE / Math.max(vEmit, 1e-6);
    const kMax = dir * Math.min(kUnclamped, 1 / TURN_CFG.MIN_RADIUS);
    this.turns.push({ s0, s1: s0 + L, kMax, dir, vEmit, emitS: this._car.s });
  }

  /* Extend the forward knot cache up to sMax (midpoint rule per step). */
  _ensureKnots(sMax) {
    let last = this._knots[this._knots.length - 1];
    while (last.s < sMax) {
      const ds = KNOT_DS;
      const thetaMid = last.theta + this.curvatureAt(last.s + ds / 2) * (ds / 2);
      const next = {
        s: last.s + ds,
        x: last.x - Math.sin(thetaMid) * ds,
        z: last.z - Math.cos(thetaMid) * ds,
        theta: last.theta + this.curvatureAt(last.s + ds / 2) * ds,
      };
      this._knots.push(next);
      last = next;
    }
  }

  /* Extend the backward knot cache down to sMin — the road BEHIND the car.
   * Same midpoint rule with a negative step; after a rebase this region can
   * contain a past turn, so it integrates κ rather than assuming straight. */
  _ensureKnotsBack(sMin) {
    let last = this._knotsBack[this._knotsBack.length - 1] ?? this._knots[0];
    while (last.s > sMin) {
      const ds = -KNOT_DS;
      const thetaMid = last.theta + this.curvatureAt(last.s + ds / 2) * (ds / 2);
      const next = {
        s: last.s + ds,
        x: last.x - Math.sin(thetaMid) * ds,
        z: last.z - Math.cos(thetaMid) * ds,
        theta: last.theta + this.curvatureAt(last.s + ds / 2) * ds,
      };
      this._knotsBack.push(next);
      last = next;
    }
  }

  /* Pose at any arc-length s (negative = behind the start). */
  poseAt(s) {
    let k;
    if (s >= 0) {
      this._ensureKnots(s);
      k = this._knots[Math.min(Math.floor(s / KNOT_DS), this._knots.length - 1)];
    } else {
      this._ensureKnotsBack(s);
      const i = Math.min(Math.ceil(-s / KNOT_DS), this._knotsBack.length);
      k = i === 0 ? this._knots[0] : this._knotsBack[i - 1];
    }
    const ds = s - k.s;
    if (Math.abs(ds) <= 1e-9) return { x: k.x, z: k.z, theta: k.theta };
    const thetaMid = k.theta + this.curvatureAt(k.s + ds / 2) * (ds / 2);
    return {
      x: k.x - Math.sin(thetaMid) * ds,
      z: k.z - Math.cos(thetaMid) * ds,
      theta: k.theta + this.curvatureAt(k.s + ds / 2) * ds,
    };
  }

  /**
   * Advance the car by dt at speed v (m/s). Runs the gap timer on driving
   * time only and emits the next turn ≥ LOOKAHEAD ahead when it fires.
   */
  update(dt, v) {
    if (v <= 1e-3) return this._car;

    this._gapTimer += dt;
    if (this._gapTimer >= this._nextGap) {
      const genEnd = this.turns.length
        ? this.turns[this.turns.length - 1].s1
        : 0;
      const s0 = Math.max(genEnd, this._car.s + TURN_CFG.LOOKAHEAD);
      const dur = this._uniform(TURN_CFG.DUR_MIN_S, TURN_CFG.DUR_MAX_S);
      const dir = this._rng() < 0.5 ? 1 : -1;
      this._emitTurn({ s0, L: dur * v, dir, vEmit: v });
      this._gapTimer = 0;
      this._nextGap = this._uniform(TURN_CFG.GAP_MIN_S, TURN_CFG.GAP_MAX_S);
    }

    const s = this._car.s + v * dt;
    const p = this.poseAt(s);
    this._car = { s, x: p.x, z: p.z, theta: p.theta };
    return this._car;
  }

  /* Current yaw rate of the car frame (rad/s). */
  yawRate(v) { return v * this.curvatureAt(this._car.s); }

  /**
   * Inverse car pose for the track group:
   *   world = R_y(rotY)·T + (x, z)  with rotY = −θ, pos = −R_y(−θ)·p.
   */
  worldTransform() {
    const { x, z, theta } = this._car;
    const c = Math.cos(theta), s = Math.sin(theta);
    // R_y(−θ): x' = x cosθ − z sinθ ; z' = x sinθ + z cosθ
    return { rotY: -theta, x: -(x * c - z * s), z: -(x * s + z * c) };
  }

  /**
   * Floating-origin rebase: re-root track space at the current car pose.
   * All track-space coordinates change ⇒ epoch bumps so consumers re-place
   * their rows. World-space geometry is invariant (tested).
   */
  rebase() {
    const { s: sc, x: xc, z: zc, theta: tc } = this._car;
    const c = Math.cos(tc), sn = Math.sin(tc);
    const remap = (p) => ({
      // R_y(−θc)·(p − pc)
      x: (p.x - xc) * c - (p.z - zc) * sn,
      z: (p.x - xc) * sn + (p.z - zc) * c,
      theta: p.theta - tc,
    });
    this.turns = this.turns
      .filter(t => t.s1 > sc - 50)
      .map(t => ({ ...t, s0: t.s0 - sc, s1: t.s1 - sc, emitS: t.emitS - sc }));
    const seed = remap(this._car);
    this._knots = [{ s: 0, x: seed.x, z: seed.z, theta: seed.theta }];
    this._knotsBack = [];
    this._car = { s: 0, ...seed };
    this.epoch += 1;
  }

  rebaseIfNeeded() {
    if (this._car.s >= TURN_CFG.REBASE_DIST) { this.rebase(); return true; }
    return false;
  }
}

/* Furniture row at arc-length s, offset laterally (right = +x at θ=0). */
export function rowPose(path, s, lateralX) {
  const p = path.poseAt(s);
  const c = Math.cos(p.theta), sn = Math.sin(p.theta);
  // right(θ) = R_y(θ)·(1,0,0) = (cosθ, −sinθ) in (x,z)
  return { x: p.x + lateralX * c, z: p.z - lateralX * sn, rotY: p.theta };
}

/* ── Sliding furniture window (row pools) ────────────────────────── */

export const WINDOW_BEHIND = 35; // m of track kept behind the car
export const WINDOW_AHEAD  = 41; // m ahead (≥ LOOKAHEAD so bends are visible)

/* Grid lines k·spacing inside [sCar−behind, sCar+ahead]. */
export function rowWindow(sCar, spacing, behind = WINDOW_BEHIND, ahead = WINDOW_AHEAD) {
  return {
    kMin: Math.ceil((sCar - behind) / spacing),
    kMax: Math.floor((sCar + ahead) / spacing),
  };
}

/* Pool size that always fits one window of rows. */
export function poolSize(spacing, behind = WINDOW_BEHIND, ahead = WINDOW_AHEAD) {
  return Math.floor((behind + ahead) / spacing) + 1;
}

/* Stable slot for grid line k in a pool of n (handles negative k). */
export function poolIndex(k, n) {
  return ((k % n) + n) % n;
}

/* ── Car visual helpers ──────────────────────────────────────────── */

const STEER_EXAG = 3;                       // legibility ×3 (real δ < 0.5°)
const STEER_CAP  = (8 * Math.PI) / 180;
const ROLL_GAIN  = (4 * Math.PI) / 180;     // 4° at 1 g lateral
const G = 9.81;

/* Front-wheel steer angle from path curvature (Ackermann δ = atan(wb·κ)). */
export function steerAngleRad(curvature, wheelbase) {
  const d = Math.atan(wheelbase * curvature) * STEER_EXAG;
  return Math.max(-STEER_CAP, Math.min(STEER_CAP, d));
}

/* Body roll: outward lean, capped 4°. Left turn (ω>0) ⇒ right side down (−rot.z). */
export function rollAngleRad(v, omega) {
  const latG = (v * omega) / G;
  return -Math.max(-1, Math.min(1, latG)) * ROLL_GAIN + 0; // +0 normalises −0
}

/* ── Effect coupling helpers ─────────────────────────────────────── */

/* Real centrifugal pseudo-acceleration on free particles in the car frame
   (rain, spray): a = v·ω along +x (outward on a left turn). No exaggeration —
   1.1 g at 280 km/h peak yaw is already dramatic. */
export function rainLateralAccel(v, omega) {
  return v * omega;
}

const RIBBON_EXAG = 6;  // real apparent drift is cm-scale — exaggerated for legibility

/* Apparent lateral flow at downstream offset z from the rotating car frame:
   v_app = −ω·z (×RIBBON_EXAG). Left turn ⇒ wake sweeps toward −x. */
export function ribbonDrift(omega, z) {
  return -omega * z * RIBBON_EXAG + 0; // +0 normalises −0
}
