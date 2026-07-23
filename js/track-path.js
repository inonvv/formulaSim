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
  MAX_YAW_RATE: 0.30,  // rad/s peak (≈17°/s) — total sweep 50–70°; at 280 km/h
                       // R ≈ 259 m → ~7.7° visible bend over the 35 m road
                       // horizon (0.14 gave 3.6° — turns read as "nothing")
  MIN_RADIUS:   20,    // m — curvature clamp so low speeds can't hairpin
  LOOKAHEAD:    40,    // m — turn starts beyond the visible road horizon (~35 m)
  REBASE_DIST:  1000,  // m — floating-origin rebase cadence (float32 health)
};

/* User-selectable turn frequency (TURNS control). `auto` mirrors TURN_CFG —
 * the legacy random schedule — so the default behaviour is unchanged. Rates
 * are nominal at driving speed: cycle length = emission-to-emission gap.
 * `only` chains turns end-to-end (short gaps + the genEnd guard) with
 * alternating direction so continuous cornering reads as a circuit. */
export const TURN_MODES = {
  auto: { gapMin: 20,  gapMax: 35,  durMin: 3, durMax: 4,   altDir: false },
  t5:   { gapMin: 5.5, gapMax: 6.5, durMin: 3, durMax: 4,   altDir: false }, // 30/6 ≈ 5 per 30 s
  t10:  { gapMin: 2.7, gapMax: 3.3, durMin: 2, durMax: 2.5, altDir: false }, // 30/3 ≈ 10 per 30 s
  only: { gapMin: 2.5, gapMax: 3.0, durMin: 3, durMax: 5,   altDir: true  }, // continuous slalom
};

const KNOT_DS = 0.5;   // m — pose integration grid

/* Signature corner — a real F1 medium-speed sweeper with FIXED geometry
 * (real corners don't scale with your speed; yaw rate follows from v·κ):
 * R 85 m, 180 m constant-radius hold (Δψ = 180/85 rad = 121.3°), 12 m
 * linear clothoid ramps in/out. At 180 km/h: ω = 0.588 rad/s = 33.7°/s,
 * 3.0 g flat. Emitted every EVERY_NTH scheduled turn. */
export const REAL_CORNER = {
  RADIUS:    85,
  HOLD:      180,
  RAMP:      12,
  EVERY_NTH: 3,
};

export class TrackPath {
  constructor(rng = Math.random) {
    this._rng = rng;
    this.turns = [];          // [{s0, s1, kMax, dir, vEmit, emitS}]
    this.epoch = 0;           // bumped on rebase — consumers must re-place rows
    this._turnMode = 'auto';
    this._lastDir = 0;
    this._gapTimer = 0;
    this._nextGap = this._uniform(TURN_CFG.GAP_MIN_S, TURN_CFG.GAP_MAX_S);
    // progressive integration knots from s=0: forward (s ≥ 0) and backward
    // (s < 0 — the road behind the start) arrays on the KNOT_DS grid
    this._knots = [{ s: 0, x: 0, z: 0, theta: 0 }];
    this._knotsBack = [];
    this._car = { s: 0, x: 0, z: 0, theta: 0 };
  }

  get pose() { return this._car; }

  get turnMode() { return this._turnMode; }

  /**
   * Switch turn-frequency mode. Resamples the pending gap from the NEW
   * range and clamps the accumulated timer so a long pending `auto` gap
   * (up to 35 s) can't stall the new mode — next turn ≤ new gapMax away.
   * Already-emitted geometry is immutable; only future emissions change.
   */
  setTurnMode(mode) {
    if (!TURN_MODES[mode]) return;
    this._turnMode = mode;
    const m = TURN_MODES[mode];
    this._nextGap = this._uniform(m.gapMin, m.gapMax);
    if (this._gapTimer > this._nextGap) this._gapTimer = this._nextGap;
  }

  _uniform(a, b) { return a + this._rng() * (b - a); }

  /* κ(s) from the emitted turn list (turns never overlap). */
  curvatureAt(s) {
    for (const t of this.turns) {
      if (s > t.s0 && s < t.s1) {
        if (t.shape === 'real') {
          // Trapezoid: linear clothoid ramp → constant 1/R hold → ramp out.
          const ds = s - t.s0;
          const { RAMP } = REAL_CORNER;
          if (ds < RAMP) return t.kMax * (ds / RAMP);
          if (s > t.s1 - RAMP) return t.kMax * ((t.s1 - s) / RAMP);
          return t.kMax;
        }
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

  /* The signature corner: fixed real-world geometry, independent of speed. */
  _emitRealCorner({ s0, dir, vEmit }) {
    const { RADIUS, HOLD, RAMP } = REAL_CORNER;
    this.turns.push({
      s0, s1: s0 + HOLD + 2 * RAMP,
      kMax: dir / RADIUS, dir, vEmit,
      emitS: this._car.s, shape: 'real',
    });
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
      const mode = TURN_MODES[this._turnMode];
      const s0 = Math.max(genEnd, this._car.s + TURN_CFG.LOOKAHEAD);
      const dur = this._uniform(mode.durMin, mode.durMax);
      const dir = mode.altDir && this._lastDir !== 0
        ? -this._lastDir
        : (this._rng() < 0.5 ? 1 : -1);
      this._lastDir = dir;
      this._turnCount = (this._turnCount ?? 0) + 1;
      if (this._turnCount % REAL_CORNER.EVERY_NTH === 0) {
        this._emitRealCorner({ s0, dir, vEmit: v });
      } else {
        this._emitTurn({ s0, L: dur * v, dir, vEmit: v });
      }
      this._gapTimer = 0;
      this._nextGap = this._uniform(mode.gapMin, mode.gapMax);
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

export const WINDOW_BEHIND = 35;  // m of track kept behind the car
export const WINDOW_AHEAD  = 160; // m ahead — the row-window edge must sit
                                  // near the horizon: at 41 m the road/grass
                                  // visibly ENDED at a border line in front
                                  // of the car once the green floor disc
                                  // replaced the old white void behind it

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

const STEER_EXAG = 6;                       // legibility ×6 (real δ ≈ 2.4° even in the R 85 corner)
const STEER_CAP  = (16 * Math.PI) / 180;
const ROLL_GAIN  = (7 * Math.PI) / 180;     // 7° at 1 g lateral
const G = 9.81;

/* Front-wheel steer angle from path curvature (Ackermann δ = atan(wb·κ)).
   Smooth p-norm saturation instead of a hard clamp: small angles pass
   through untouched (deviation ∝ (d/CAP)⁸), but the approach to the cap is
   rounded — the wheel never sits pinned dead-flat at 16° through a whole
   sweep (which read as "stuck"), and δ stays strictly monotonic in κ. */
export function steerAngleRad(curvature, wheelbase) {
  const d = Math.atan(wheelbase * curvature) * STEER_EXAG;
  const r = Math.abs(d) / STEER_CAP;
  return d / Math.pow(1 + Math.pow(r, 8), 1 / 8);
}

/* Exponential (one-pole) smoothing toward a target angle. Time-constant
   form is frame-rate independent: two dt/2 steps compose to one dt step
   exactly. tau 0.22 s ⇒ ~63% of a steer step in 0.22 s — fluid wheel
   motion without feeling laggy against the 2-4 s turn sweeps. */
export function smoothAngle(prev, target, dt, tau = 0.22) {
  if (!(dt > 0)) return prev;
  return prev + (target - prev) * (1 - Math.exp(-dt / tau));
}

/* Body roll: outward lean, capped 7°. Left turn (ω>0) ⇒ right side down (−rot.z). */
export function rollAngleRad(v, omega) {
  const latG = (v * omega) / G;
  return -Math.max(-1, Math.min(1, latG)) * ROLL_GAIN + 0; // +0 normalises −0
}

/* Cinematic camera bank: roll the camera about its view axis into the
   turn, racing-game style. Linear in yaw rate, clamped at ±6° at the
   scheduler's peak ω. Applied AFTER lookAt/orbit each frame (lookAt
   resets orientation, so the roll must be re-applied per frame). */
const BANK_MAX = (6 * Math.PI) / 180;
export function cameraBankRad(omega) {
  const n = Math.max(-1, Math.min(1, omega / TURN_CFG.MAX_YAW_RATE));
  // +rotateZ tips the camera top toward frame-left (+y → −x), which is the
  // lean-into pose for a LEFT turn (ω>0): horizon's left end rises in frame.
  return n * BANK_MAX + 0;
}

/* ── Effect coupling helpers ─────────────────────────────────────── */

/* Car-frame lateral offset of the driving path itself, sampled on a fixed
   z grid. Streamlines of still air, seen from the car, trace the car's own
   trajectory — so ribbons must bend along the EXACT road curve, not by a
   rigid-rotation heuristic (the old ribbonDrift shear could never match
   the drawn road, which the user spotted the moment the R 85 corner and
   grass made the geometry legible). Car-frame z < 0 is ahead of the nose
   (flow arrives from −z), so the arc offset is −z. */
export function pathBendTable(path, zMin = -24, zMax = 12, step = 2) {
  const s = path.pose.s;
  const w = path.worldTransform();
  const c = Math.cos(w.rotY), sn = Math.sin(w.rotY);
  const dx = [];
  for (let z = zMin; z <= zMax + 1e-9; z += step) {
    const p = path.poseAt(s - z);
    dx.push(c * p.x + sn * p.z + w.x);   // world transform of a track-space point, x only
  }
  return { zMin, step, dx };
}

/* Linear interpolation into a pathBendTable, clamped at the ends. */
export function bendLookup(table, z) {
  if (!table) return 0;
  const { zMin, step, dx } = table;
  const f = (z - zMin) / step;
  const i = Math.max(0, Math.min(dx.length - 1, Math.floor(f)));
  const j = Math.min(dx.length - 1, i + 1);
  const t = Math.max(0, Math.min(1, f - i));
  return dx[i] + (dx[j] - dx[i]) * t;
}

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

/* ── Turn counter (HUD) ──────────────────────────────────────────── */

const TURN_COUNT_ON  = 1e-4;   // |κ| rising past this = a new turn
const TURN_COUNT_OFF = 5e-5;   // rearm only once |κ| drops below this (hysteresis)

/* Rising-edge turn counter with hysteresis. Pure: feed the previous state
   ({inTurn, count} or null to bootstrap) and the current path curvature;
   returns the next state. The on/off gap keeps curvature-ramp jitter around
   a single threshold from double-counting one corner. */
export function turnEdgeCounter(prev, kappa) {
  const st = prev ?? { inTurn: false, count: 0 };
  const a = Math.abs(kappa);
  if (!st.inTurn && a > TURN_COUNT_ON)  return { inTurn: true,  count: st.count + 1 };
  if (st.inTurn  && a < TURN_COUNT_OFF) return { inTurn: false, count: st.count };
  return st;
}
