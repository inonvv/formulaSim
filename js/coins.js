/**
 * coins.js — ARCADE coin system core (pure math, no THREE/DOM).
 *
 * Coins live in (s, lateralX) track space (plan decision 2) — the THREE
 * wrapper (coin-visuals.js) places them in trackGroup via rowPose, so the
 * world already carries the −playerX strafe offset and the inverse car
 * pose. This module owns:
 *   • pattern generation (straight runs / sine arcs / 3-lane rows),
 *   • the spawn frontier (patterns start 80–140 m ahead of the car),
 *   • SWEPT collision (the car covers 1.3–4 m per frame at speed — a point
 *     test tunnels straight through a 5 m coin run),
 *   • magnet-lite pull, and
 *   • scoring with the 2 s combo window.
 * Constants are pinned by coins.test.js against the plan
 * (docs/plans/arcade-race-mode.md).
 *
 * Epoch rebase (floating origin every 1000 m): main.js captures the car's
 * s just before TrackPath.rebase() zeroes it and calls rebase(shift) here —
 * every stored s (coins, sweep memory, spawn frontier) shifts together, so
 * coin world positions are invariant, exactly like furniture rows.
 */

export const COIN_CFG = {
  SPACING:      5,     // m between coins inside a pattern
  RUN_MIN:      5,     // straight run: 5–8 coins
  RUN_MAX:      8,
  ARC_LEN:      50,    // sine arc sweeps ±ARC_AMP over ARC_LEN metres
  ARC_AMP:      6,
  LANES_X:      5,     // 3-lane row at lat −5 / 0 / +5
  SPAWN_MIN:    80,    // patterns start inside [sCar+80, sCar+140]
  SPAWN_MAX:    140,   //   (inside WINDOW_AHEAD 160 — coins pop in beyond the haze)
  GAP_MIN:      8,     // m of empty road between patterns
  GAP_MAX:      20,
  CULL_BEHIND:  35,    // matches WINDOW_BEHIND — passed coins leave the pool
  COLLECT_LAT:  1.7,   // m — half-width of the collection lane
  COLLECT_PAD:  1.5,   // m — longitudinal pad on the swept interval
  MAGNET_R:     3.5,   // m — lateral AND longitudinal capture range
  MAGNET_V:     18,    // m/s — pull speed toward the car
  COIN_POINTS:  10,    // score per coin (before multiplier)
  COMBO_WINDOW: 2,     // s — pickups inside this window build the streak
  COMBO_STREAK: 8,     // streak length that arms the multiplier
  COMBO_MULT:   2,
};

/* ── Pattern generators — arrays of {ds, lat} offsets from a start s ── */

/** Straight run: 5–8 coins @ 5 m on one lateral (anywhere in ±6 m). */
export function patternStraight(rng) {
  const C = COIN_CFG;
  const n = C.RUN_MIN + Math.floor(rng() * (C.RUN_MAX - C.RUN_MIN + 1));
  const lat = (rng() * 2 - 1) * C.ARC_AMP;
  const coins = [];
  for (let i = 0; i < n; i++) coins.push({ ds: i * C.SPACING, lat });
  return { coins, span: (n - 1) * C.SPACING };
}

/** Sine arc: 11 coins over 50 m, lat = ±6·sin(π·ds/50) — apex mid-arc. */
export function patternArc(rng) {
  const C = COIN_CFG;
  const dir = rng() < 0.5 ? 1 : -1;
  const coins = [];
  for (let ds = 0; ds <= C.ARC_LEN + 1e-9; ds += C.SPACING) {
    coins.push({ ds, lat: dir * C.ARC_AMP * Math.sin(Math.PI * ds / C.ARC_LEN) });
  }
  return { coins, span: C.ARC_LEN };
}

/** 3-lane row: one s, coins at lat −5 / 0 / +5 (pick-a-lane moment). */
export function patternLanes(_rng) {
  const C = COIN_CFG;
  return {
    coins: [{ ds: 0, lat: -C.LANES_X }, { ds: 0, lat: 0 }, { ds: 0, lat: C.LANES_X }],
    span: 0,
  };
}

/** Weighted pick: straights carry the rhythm, arcs steer, rows are occasional. */
export function nextPattern(rng) {
  const r = rng();
  if (r < 0.5) return patternStraight(rng);
  if (r < 0.8) return patternArc(rng);
  return patternLanes(rng);
}

/* ── Coin field — pool, spawn frontier, magnet, swept collection ──── */

/**
 * @param {() => number} rng   injectable for deterministic tests
 * @param {{spawn?: boolean}} opts  spawn:false → collision tests author coins by hand
 */
export function createCoinField(rng = Math.random, opts = {}) {
  const C = COIN_CFG;
  const spawn = opts.spawn !== false;
  return {
    coins: [],       // [{id, s, lat}] — s in current track space
    _prevS: null,    // sweep memory (car s last update)
    _genS:  null,    // spawn frontier — next pattern start
    _id:    0,

    /**
     * One frame: spawn ahead, magnet-pull, swept-collect, cull behind.
     * @returns collected coin objects (removed from the field).
     */
    update({ sCar, playerX, dt }) {
      // ─ Spawn: keep pattern starts flowing through [sCar+80, sCar+140].
      if (spawn) {
        if (this._genS === null || this._genS < sCar + C.SPAWN_MIN) {
          this._genS = sCar + C.SPAWN_MIN;
        }
        while (this._genS < sCar + C.SPAWN_MAX) {
          const p = nextPattern(rng);
          for (const c of p.coins) {
            this.coins.push({ id: ++this._id, s: this._genS + c.ds, lat: c.lat });
          }
          this._genS += p.span + C.GAP_MIN + rng() * (C.GAP_MAX - C.GAP_MIN);
        }
      }

      // ─ Magnet-lite: inside 3.5 m on BOTH axes, pull toward the car at
      //   18 m/s along the (Δs, Δlat) vector (runs before collection so a
      //   pulled coin can land inside the sweep this same frame).
      for (const c of this.coins) {
        const dS = c.s - sCar, dL = c.lat - playerX;
        if (Math.abs(dS) <= C.MAGNET_R && Math.abs(dL) <= C.MAGNET_R) {
          const len = Math.hypot(dS, dL);
          const step = C.MAGNET_V * dt;
          if (step >= len) { c.s = sCar; c.lat = playerX; }
          else { c.s -= (dS / len) * step; c.lat -= (dL / len) * step; }
        }
      }

      // ─ Swept collection: the car's s interval this frame, padded ±1.5 m.
      const prevS = this._prevS ?? sCar;
      const lo = Math.min(prevS, sCar) - C.COLLECT_PAD;
      const hi = Math.max(prevS, sCar) + C.COLLECT_PAD;
      const collected = [];
      const kept = [];
      for (const c of this.coins) {
        if (c.s >= lo && c.s <= hi && Math.abs(c.lat - playerX) < C.COLLECT_LAT) {
          collected.push(c);
        } else if (c.s >= sCar - C.CULL_BEHIND) {
          kept.push(c);
        }
        // else: passed uncollected — culled silently
      }
      this.coins = kept;
      this._prevS = sCar;
      return collected;
    },

    /** Floating-origin rebase — shift EVERY stored s by the same amount. */
    rebase(shift) {
      for (const c of this.coins) c.s -= shift;
      if (this._prevS !== null) this._prevS -= shift;
      if (this._genS  !== null) this._genS  -= shift;
    },

    /** Clear the run (mode exit / restart); frontier re-arms on next update. */
    reset() {
      this.coins = [];
      this._prevS = null;
      this._genS = null;
    },
  };
}

/* ── Scoring — distance + coins, 2 s combo window ─────────────────── */

/** score = floor(distance_m) + coin points; streak ≥ 8 inside the rolling
 *  2 s window doubles pickups; 2 s idle resets the streak. */
export function createScoring() {
  const C = COIN_CFG;
  return {
    distance:   0,   // m driven while running
    coins:      0,
    coinPoints: 0,
    streak:     0,
    mult:       1,
    _idle:      Infinity,   // s since last pickup

    /** Per-frame: accumulate distance, expire the combo window. */
    step(dt, vFwd) {
      this.distance += vFwd * dt;
      this._idle += dt;
      if (this._idle > C.COMBO_WINDOW && this.streak !== 0) {
        this.streak = 0;
        this.mult = 1;
      }
    },

    /** Register one coin. @returns {points, streak, mult} for HUD/audio. */
    pickup() {
      this.streak += 1;
      this.mult = this.streak >= C.COMBO_STREAK ? C.COMBO_MULT : 1;
      const points = C.COIN_POINTS * this.mult;
      this.coinPoints += points;
      this.coins += 1;
      this._idle = 0;
      return { points, streak: this.streak, mult: this.mult };
    },

    get score() {
      return Math.floor(this.distance) + this.coinPoints;
    },

    reset() {
      this.distance = 0;
      this.coins = 0;
      this.coinPoints = 0;
      this.streak = 0;
      this.mult = 1;
      this._idle = Infinity;
    },
  };
}
