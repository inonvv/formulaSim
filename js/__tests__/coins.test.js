/**
 * coins.test.js — TDD for the ARCADE coin system (Phase B).
 *
 * js/coins.js is a PURE module (no THREE/DOM): pattern generation in
 * (s, lat) track space, coin pooling + spawn frontier, swept collision,
 * magnet-lite, scoring/combo. Plan pins (docs/plans/arcade-race-mode.md):
 *   • Patterns: straight runs of 5–8 coins @ 5 m on one lateral; sine arcs
 *     sweeping ±6 m over 50 m; occasional 3-lane rows at lat −5 / 0 / +5.
 *   • Spawn window 80–140 m ahead (inside WINDOW_AHEAD 160).
 *   • Collision is SWEPT, not sphere: collect when |latCoin − playerX| < 1.7
 *     AND coin s crosses the car's s interval this frame (±1.5 m pad) — at
 *     80 m/s the car moves 1.3–4 m/frame, a point test tunnels through.
 *   • Magnet-lite: within 3.5 m lateral+longitudinal, coin lerps toward the
 *     car at 18 m/s.
 *   • Scoring: score = floor(distance_m) + 10·coins; pickups within a 2 s
 *     window build streak; streak ≥ 8 → ×2 multiplier; reset after 2 s idle.
 *   • Epoch rebase (decision 2): rebase(shift) keeps coin world positions
 *     invariant — all s coordinates (coins, sweep memory, spawn frontier)
 *     shift together, exactly like furniture rows re-place on path.epoch.
 */
import { describe, it, expect, vi } from 'vitest';

/* Guard mock — coins.js must stay pure math; fail loudly if it (or a
   transitive import) ever pulls three. */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };
  return { Vector3: Vec3 };
});

import {
  COIN_CFG,
  patternStraight, patternArc, patternLanes, nextPattern,
  createCoinField, createScoring,
} from '../coins.js';

/* Deterministic rng for seeded pattern/spawn tests. */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Field with spawning disabled — collision/magnet tests author coins by hand. */
function bareField() {
  return createCoinField(mulberry32(7), { spawn: false });
}

/* ══════════════════════════════════════════════════════════════════
   COIN_CFG — pinned plan constants
══════════════════════════════════════════════════════════════════ */
describe('COIN_CFG', () => {
  it('pins the plan constants', () => {
    expect(COIN_CFG.SPACING).toBe(5);
    expect(COIN_CFG.ARC_LEN).toBe(50);
    expect(COIN_CFG.ARC_AMP).toBe(6);
    expect(COIN_CFG.LANES_X).toBe(5);
    expect(COIN_CFG.SPAWN_MIN).toBe(80);
    expect(COIN_CFG.SPAWN_MAX).toBe(140);
    expect(COIN_CFG.COLLECT_LAT).toBe(1.7);
    expect(COIN_CFG.COLLECT_PAD).toBe(1.5);
    expect(COIN_CFG.MAGNET_R).toBe(3.5);
    expect(COIN_CFG.MAGNET_V).toBe(18);
    expect(COIN_CFG.COIN_POINTS).toBe(10);
    expect(COIN_CFG.COMBO_WINDOW).toBe(2);
    expect(COIN_CFG.COMBO_STREAK).toBe(8);
    expect(COIN_CFG.COMBO_MULT).toBe(2);
  });
});

/* ══════════════════════════════════════════════════════════════════
   Pattern generators — (s, lat) offsets, deterministic under a seed
══════════════════════════════════════════════════════════════════ */
describe('pattern generators', () => {
  it('patternStraight: 5–8 coins @ 5 m spacing on ONE lateral, |lat| ≤ 6', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = patternStraight(mulberry32(seed));
      expect(p.coins.length).toBeGreaterThanOrEqual(5);
      expect(p.coins.length).toBeLessThanOrEqual(8);
      const lat0 = p.coins[0].lat;
      p.coins.forEach((c, i) => {
        expect(c.ds).toBeCloseTo(i * 5, 9);
        expect(c.lat).toBe(lat0);               // one lateral for the whole run
        expect(Math.abs(c.lat)).toBeLessThanOrEqual(6);
      });
      expect(p.span).toBeCloseTo((p.coins.length - 1) * 5, 9);
    }
  });

  it('patternArc: sweeps ±6 m over 50 m at 5 m spacing', () => {
    let sawPos = false, sawNeg = false;
    for (let seed = 1; seed <= 20; seed++) {
      const p = patternArc(mulberry32(seed));
      expect(p.span).toBeCloseTo(50, 9);
      expect(p.coins.length).toBe(11);          // 0..50 @ 5 m
      let peak = 0;
      p.coins.forEach((c, i) => {
        expect(c.ds).toBeCloseTo(i * 5, 9);
        expect(Math.abs(c.lat)).toBeLessThanOrEqual(6 + 1e-9);
        peak = Math.max(peak, Math.abs(c.lat));
      });
      expect(peak).toBeCloseTo(6, 6);           // full ±6 amplitude is reached
      const mid = p.coins[5].lat;               // ds = 25 — the sweep apex
      if (mid > 0) sawPos = true; else sawNeg = true;
    }
    expect(sawPos && sawNeg).toBe(true);        // both sweep directions occur
  });

  it('patternLanes: 3 coins in one row at lat −5 / 0 / +5', () => {
    const p = patternLanes(mulberry32(3));
    expect(p.coins.length).toBe(3);
    expect(p.coins.map(c => c.lat).sort((a, b) => a - b)).toEqual([-5, 0, 5]);
    p.coins.forEach(c => expect(c.ds).toBe(0));
    expect(p.span).toBe(0);
  });

  it('nextPattern eventually emits all three shapes', () => {
    const rng = mulberry32(11);
    const shapes = new Set();
    for (let i = 0; i < 200; i++) {
      const p = nextPattern(rng);
      if (p.span === 0) shapes.add('lanes');
      else if (p.coins.length === 11 && p.span === 50) shapes.add('arc');
      else shapes.add('straight');
    }
    expect(shapes).toEqual(new Set(['straight', 'arc', 'lanes']));
  });
});

/* ══════════════════════════════════════════════════════════════════
   Coin field — spawn window, determinism, culling
══════════════════════════════════════════════════════════════════ */
describe('createCoinField — spawning', () => {
  it('first update spawns every pattern START inside [sCar+80, sCar+140]', () => {
    const f = createCoinField(mulberry32(1));
    f.update({ sCar: 0, playerX: 0, dt: 0.016 });
    expect(f.coins.length).toBeGreaterThan(0);
    for (const c of f.coins) {
      expect(c.s).toBeGreaterThanOrEqual(80);
      // pattern starts < 140; a 50 m arc may trail past the window edge
      expect(c.s).toBeLessThanOrEqual(140 + COIN_CFG.ARC_LEN);
    }
  });

  it('keeps the frontier ahead as the car drives; culls coins > 35 m behind', () => {
    const f = createCoinField(mulberry32(2));
    let sCar = 0;
    for (let i = 0; i < 600; i++) {
      sCar += 22 * 0.05;                       // ~80 km/h at headless dt
      f.update({ sCar, playerX: 0, dt: 0.05 });
    }
    expect(f.coins.some(c => c.s > sCar + 60)).toBe(true);   // fresh coins ahead
    for (const c of f.coins) expect(c.s).toBeGreaterThanOrEqual(sCar - 35);
  });

  it('is deterministic under a seed', () => {
    const run = () => {
      const f = createCoinField(mulberry32(9));
      let sCar = 0;
      for (let i = 0; i < 100; i++) {
        sCar += 1.5;
        f.update({ sCar, playerX: 0, dt: 0.05 });
      }
      return f.coins.map(c => [c.s, c.lat]);
    };
    expect(run()).toEqual(run());
  });

  it('reset() clears coins and re-arms the frontier at the new position', () => {
    const f = createCoinField(mulberry32(4));
    f.update({ sCar: 0, playerX: 0, dt: 0.016 });
    expect(f.coins.length).toBeGreaterThan(0);
    f.reset();
    expect(f.coins).toEqual([]);
    f.update({ sCar: 500, playerX: 0, dt: 0.016 });
    for (const c of f.coins) expect(c.s).toBeGreaterThanOrEqual(580);
  });
});

/* ══════════════════════════════════════════════════════════════════
   Collision — swept, not sphere (tunneling regression)
══════════════════════════════════════════════════════════════════ */
describe('createCoinField — swept collision', () => {
  it('REGRESSION: no tunneling at 80 m/s (4 m per headless 0.05 s frame)', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 100, lat: 0 });
    f.update({ sCar: 90, playerX: 0, dt: 0.05 });   // arm prevS at 90
    let collected = [];
    for (let sCar = 94; sCar <= 110; sCar += 4) {   // samples 94/98/102/106/110 — never AT 100
      collected = collected.concat(f.update({ sCar, playerX: 0, dt: 0.05 }));
    }
    expect(collected.length).toBe(1);
    expect(collected[0].id).toBe(1);
    expect(f.coins.length).toBe(0);                  // removed from the field
  });

  it('collects across ONE giant step (20 m in a single frame)', () => {
    const f = bareField();
    f.coins.push({ id: 2, s: 100, lat: 0.5 });
    f.update({ sCar: 90, playerX: 0, dt: 0.05 });
    const got = f.update({ sCar: 110, playerX: 0, dt: 0.25 });
    expect(got.length).toBe(1);
  });

  it('lateral gate: |latCoin − playerX| < 1.7 collects, ≥ 1.7 passes by', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 100, lat: 1.6 });
    f.coins.push({ id: 2, s: 100, lat: 2.0 });
    f.update({ sCar: 95, playerX: 0, dt: 0.05 });
    const got = f.update({ sCar: 105, playerX: 0, dt: 0.05 });
    expect(got.map(c => c.id)).toEqual([1]);
    // the missed coin stays until culled
    expect(f.coins.map(c => c.id)).toEqual([2]);
  });

  it('playerX shifts the collection lane', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 100, lat: 5 });
    f.update({ sCar: 95, playerX: 5, dt: 0.05 });
    const got = f.update({ sCar: 105, playerX: 5, dt: 0.05 });
    expect(got.length).toBe(1);
  });

  it('±1.5 m longitudinal pad on a stationary frame (dt 0 isolates the pad from the magnet)', () => {
    // Magnet range (3.5) > pad (1.5), so the pad boundary is only observable
    // with dt = 0 — any longer frame legitimately pulls the coin in first.
    const near = bareField();
    near.coins.push({ id: 1, s: 101.4, lat: 0 });
    expect(near.update({ sCar: 100, playerX: 0, dt: 0 }).length).toBe(1);

    const far = bareField();
    far.coins.push({ id: 1, s: 101.6, lat: 0 });
    expect(far.update({ sCar: 100, playerX: 0, dt: 0 }).length).toBe(0);
  });

  it('culls passed coins WITHOUT collecting them', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 50, lat: 0 });
    const got = f.update({ sCar: 100, playerX: 0, dt: 0.05 });
    expect(got.length).toBe(0);
    expect(f.coins.length).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════
   Magnet-lite — 3.5 m capture, 18 m/s pull
══════════════════════════════════════════════════════════════════ */
describe('createCoinField — magnet', () => {
  it('inside 3.5 m (both axes) the coin moves toward the car at 18 m/s', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 103, lat: 2.5 });
    f.update({ sCar: 100, playerX: 0, dt: 1e-9 });   // arm prevS
    const before = Math.hypot(3, 2.5);
    f.update({ sCar: 100, playerX: 0, dt: 0.1 });
    const c = f.coins[0];
    const after = Math.hypot(c.s - 100, c.lat - 0);
    expect(before - after).toBeCloseTo(18 * 0.1, 3);
  });

  it('outside 3.5 m the coin does not move', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 105, lat: 0.5 });       // dS = 5 > 3.5
    f.update({ sCar: 100, playerX: 0, dt: 0.1 });
    expect(f.coins[0].s).toBe(105);
    expect(f.coins[0].lat).toBe(0.5);
  });

  it('magnet feeds the collector — an off-lane coin gets pulled in and collected', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 100, lat: 3.0 });       // outside the 1.7 lat gate
    f.update({ sCar: 97, playerX: 0, dt: 1e-9 });
    let got = [];
    for (let i = 0; i < 30 && got.length === 0; i++) {
      got = f.update({ sCar: 100, playerX: 0, dt: 0.05 });
    }
    expect(got.length).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════
   Epoch rebase — decision 2
══════════════════════════════════════════════════════════════════ */
describe('createCoinField — rebase', () => {
  it('rebase(shift) shifts every coin s so car-relative offsets are invariant', () => {
    const f = createCoinField(mulberry32(5));
    f.update({ sCar: 990, playerX: 0, dt: 0.016 });
    const relBefore = f.coins.map(c => [c.s - 990, c.lat]);
    f.rebase(990);                                    // path rebased: car s → 0
    const relAfter = f.coins.map(c => [c.s - 0, c.lat]);
    expect(relAfter).toEqual(relBefore);
  });

  it('sweep memory survives rebase — no phantom collect, no missed coin', () => {
    const f = bareField();
    f.coins.push({ id: 1, s: 1002, lat: 0 });
    f.update({ sCar: 998, playerX: 0, dt: 0.05 });    // prevS = 998
    f.rebase(1000);                                   // coin → 2, prevS → −2
    const got = f.update({ sCar: 3, playerX: 0, dt: 0.05 });
    expect(got.length).toBe(1);                       // swept [−2, 3] ∋ 2
  });

  it('spawn frontier rebased too — no 1 km spawn gap after rebase', () => {
    const f = createCoinField(mulberry32(6));
    f.update({ sCar: 990, playerX: 0, dt: 0.016 });
    f.rebase(990);
    f.update({ sCar: 0, playerX: 0, dt: 0.016 });
    // frontier must still sit inside the window, not 990 m out
    expect(f.coins.some(c => c.s <= 140 + COIN_CFG.ARC_LEN)).toBe(true);
    for (const c of f.coins) expect(c.s).toBeLessThanOrEqual(140 + COIN_CFG.ARC_LEN);
  });
});

/* ══════════════════════════════════════════════════════════════════
   Scoring — distance + coins, combo streak
══════════════════════════════════════════════════════════════════ */
describe('createScoring', () => {
  it('score = floor(distance_m) + 10·coins', () => {
    const sc = createScoring();
    sc.step(1, 12.34); sc.step(1, 12.34); sc.step(1, 12.34);
    expect(sc.score).toBe(37);                        // floor(37.02)
    sc.pickup(); sc.pickup();
    expect(sc.coins).toBe(2);
    expect(sc.score).toBe(37 + 20);
  });

  it('streak ≥ 8 inside the 2 s window doubles pickups', () => {
    const sc = createScoring();
    let total = 0;
    for (let i = 1; i <= 9; i++) {
      const p = sc.pickup();
      total += p.points;
      expect(p.points).toBe(i >= 8 ? 20 : 10);
      expect(p.mult).toBe(i >= 8 ? 2 : 1);
      sc.step(0.5, 0);                                // 0.5 s between pickups — window holds
    }
    expect(total).toBe(7 * 10 + 2 * 20);
    expect(sc.score).toBe(total);
  });

  it('2 s idle resets the streak and multiplier', () => {
    const sc = createScoring();
    for (let i = 0; i < 8; i++) { sc.pickup(); sc.step(0.1, 0); }
    expect(sc.mult).toBe(2);
    sc.step(2.1, 0);                                  // idle > 2 s
    expect(sc.mult).toBe(1);
    expect(sc.pickup().points).toBe(10);              // streak restarted
  });

  it('sub-window gaps do NOT reset the streak', () => {
    const sc = createScoring();
    for (let i = 0; i < 12; i++) { sc.pickup(); sc.step(1.9, 0); }
    expect(sc.mult).toBe(2);
  });

  it('reset() zeroes everything', () => {
    const sc = createScoring();
    sc.step(3, 20); sc.pickup(); sc.pickup();
    sc.reset();
    expect(sc.score).toBe(0);
    expect(sc.coins).toBe(0);
    expect(sc.distance).toBe(0);
    expect(sc.mult).toBe(1);
  });
});
