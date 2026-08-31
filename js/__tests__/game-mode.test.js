/**
 * game-mode.test.js — TDD for the ARCADE RACE mode core (Phase A).
 *
 * js/game-mode.js is a PURE module (state machine + lateral physics), no
 * THREE/DOM. Plan pins (docs/plans/arcade-race-mode.md):
 *   • createGame(): menu → countdown → running → gameover → (restart →
 *     countdown); countdown 3-2-1 at 0.9 s per tick, "GO" holds 0.5 s;
 *     run timer 90 s → gameover.
 *   • lateralStep: vxMax = clamp(0.12·vFwd, 3, 9); one-pole vx smoothing
 *     tau 0.12 s; hard clamp |playerX| ≤ 12; soft zone |x| > 10 spring
 *     a = −25·(|x|−10); edgeRumble 0..1 exposed.
 *   • tiltStep: roll cap 7°, yaw cap 4°, steer via the existing
 *     steerAngleRad path fed a pseudo-curvature from vx; tau 0.12 s.
 *   • SIGN CHAIN (decision 1): world offset is −playerX ⇒ strafing right
 *     (vx > 0 ⇒ playerX > 0) shifts the world toward −x, so apparent wind
 *     hits the +x side of the car (consumed by Phase C crosswind).
 */
import { describe, it, expect, vi } from 'vitest';

/* Guard mock — game-mode.js is pure math today, but if it (or a transitive
   import) ever pulls three, fail loudly with the sibling-suite shape. */
vi.mock('three', () => {
  function Vec3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  Vec3.prototype.set       = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vec3.prototype.setScalar = function (s)       { this.x = s; this.y = s; this.z = s; return this; };
  return { Vector3: Vec3 };
});

import {
  createGame, lateralStep, tiltStep, worldOffsetX, GAME_CFG,
} from '../game-mode.js';

const DEG = Math.PI / 180;

/* ══════════════════════════════════════════════════════════════════
   State machine
══════════════════════════════════════════════════════════════════ */
describe('createGame state machine', () => {
  it('starts in menu with a full 90 s timer and zero coins', () => {
    const g = createGame();
    expect(g.phase).toBe('menu');
    expect(g.timeLeft).toBe(90);
    expect(g.coins).toBe(0);
    expect(g.lateral).toEqual({ playerX: 0, vx: 0, edgeRumble: 0 });
  });

  it('start() enters countdown at 3', () => {
    const g = createGame();
    g.start();
    expect(g.phase).toBe('countdown');
    expect(g.countdown).toBe(3);
  });

  it('counts 3-2-1 at 0.9 s per tick, then GO (0) for 0.5 s, then running', () => {
    const g = createGame();
    g.start();
    g.tick(0.89);
    expect(g.countdown).toBe(3);
    g.tick(0.02);                    // t = 0.91
    expect(g.countdown).toBe(2);
    g.tick(0.9);                     // t = 1.81
    expect(g.countdown).toBe(1);
    g.tick(0.9);                     // t = 2.71 → GO hold
    expect(g.countdown).toBe(0);
    expect(g.phase).toBe('countdown');
    g.tick(0.48);                    // t = 3.19 — still GO
    expect(g.phase).toBe('countdown');
    g.tick(0.02);                    // t = 3.21 > 2.7 + 0.5
    expect(g.phase).toBe('running');
    expect(g.timeLeft).toBe(90);
  });

  it('run timer counts down 90 s then gameover, clamped at 0', () => {
    const g = createGame();
    g.start();
    g.tick(4);                       // through countdown
    expect(g.phase).toBe('running');
    g.tick(1);
    expect(g.timeLeft).toBeCloseTo(89, 6);
    g.tick(100);
    expect(g.timeLeft).toBe(0);
    expect(g.phase).toBe('gameover');
  });

  it('collect() tallies coins only while running', () => {
    const g = createGame();
    expect(g.collect()).toBe(false); // menu — ignored
    g.start();
    expect(g.collect()).toBe(false); // countdown — ignored
    g.tick(4);
    expect(g.collect()).toBe(true);
    expect(g.collect()).toBe(true);
    expect(g.coins).toBe(2);
    g.tick(1000);                    // → gameover
    expect(g.collect()).toBe(false);
    expect(g.coins).toBe(2);
  });

  it('restart from gameover: start() re-enters countdown with fresh run state', () => {
    const g = createGame();
    g.start(); g.tick(4); g.collect(); g.lateral.playerX = 5; g.tick(1000);
    expect(g.phase).toBe('gameover');
    g.start();
    expect(g.phase).toBe('countdown');
    expect(g.countdown).toBe(3);
    expect(g.timeLeft).toBe(90);
    expect(g.coins).toBe(0);
    expect(g.lateral.playerX).toBe(0);
  });

  it('start() is a no-op mid-countdown and mid-run', () => {
    const g = createGame();
    g.start(); g.tick(1.0);          // countdown at 2
    g.start();
    expect(g.countdown).toBe(2);     // not reset to 3
    g.tick(3); g.tick(10);           // running, 10 s burned
    g.start();
    expect(g.phase).toBe('running');
    expect(g.timeLeft).toBeCloseTo(80, 5);
  });

  it('reset() returns to menu and zeroes run + lateral state', () => {
    const g = createGame();
    g.start(); g.tick(4); g.collect(); g.lateral.playerX = -7; g.lateral.vx = 3;
    g.reset();
    expect(g.phase).toBe('menu');
    expect(g.coins).toBe(0);
    expect(g.timeLeft).toBe(90);
    expect(g.lateral).toEqual({ playerX: 0, vx: 0, edgeRumble: 0 });
  });

  it('tick() with dt ≤ 0 or in menu changes nothing', () => {
    const g = createGame();
    g.tick(1);
    expect(g.phase).toBe('menu');
    g.start();
    g.tick(0);
    g.tick(-1);
    expect(g.countdown).toBe(3);
  });
});

/* ══════════════════════════════════════════════════════════════════
   lateralStep — strafe physics
══════════════════════════════════════════════════════════════════ */
describe('lateralStep', () => {
  const L0 = { playerX: 0, vx: 0, edgeRumble: 0 };

  it('vxMax = clamp(0.12·vFwd, 3, 9)', () => {
    // Converge fully (many taus) and read the steady-state vx. playerX is
    // re-zeroed each step so the soft-zone spring never bleeds into vx.
    const converge = (vFwd) => {
      let s = { ...L0 };
      for (let i = 0; i < 400; i++) { s = lateralStep(s, 1, vFwd, 0.016); s.playerX = 0; }
      return s.vx;
    };
    expect(converge(50)).toBeCloseTo(6, 2);     // 0.12·50 = 6
    expect(converge(100)).toBeCloseTo(9, 2);    // 12 → clamped 9
    expect(converge(5)).toBeCloseTo(3, 2);      // 0.6 → floored 3
  });

  it('vx smoothing is one-pole with tau 0.12 s', () => {
    // One step of dt = tau from rest: vx = vxMax·(1 − e⁻¹).
    const s = lateralStep(L0, 1, 50, 0.12);
    expect(s.vx).toBeCloseTo(6 * (1 - Math.exp(-1)), 6);
  });

  it('is frame-rate independent in the free zone (compose property)', () => {
    let a = { ...L0 };
    for (let i = 0; i < 10; i++) a = lateralStep(a, 1, 50, 0.01);
    let b = lateralStep({ ...L0 }, 1, 50, 0.1);
    // vx smoothing composes exactly; playerX integration is Euler → loose.
    expect(a.vx).toBeCloseTo(b.vx, 6);
    expect(Math.abs(a.playerX - b.playerX)).toBeLessThan(0.15);
  });

  it('does not mutate the previous state (pure)', () => {
    const prev = { playerX: 1, vx: 2, edgeRumble: 0 };
    lateralStep(prev, 1, 50, 0.05);
    expect(prev).toEqual({ playerX: 1, vx: 2, edgeRumble: 0 });
  });

  it('hard-clamps |playerX| at 12 even under sustained input', () => {
    let s = { ...L0 };
    for (let i = 0; i < 2000; i++) s = lateralStep(s, 1, 100, 0.016);
    expect(s.playerX).toBeLessThanOrEqual(12);
    expect(s.playerX).toBeGreaterThan(10);      // spring holds it in the soft zone
  });

  it('soft-zone spring pushes back with a = −25·(|x|−10)', () => {
    // At x = 11, no input, vx = 0: only the spring acts on this step.
    const dt = 0.01;
    const s = lateralStep({ playerX: 11, vx: 0, edgeRumble: 0 }, 0, 50, dt);
    expect(s.vx).toBeCloseTo(-25 * 1 * dt, 6);  // −0.25 m/s after 10 ms
    const sNeg = lateralStep({ playerX: -11, vx: 0, edgeRumble: 0 }, 0, 50, dt);
    expect(sNeg.vx).toBeCloseTo(+25 * 1 * dt, 6);
  });

  it('no spring inside |x| ≤ 10', () => {
    const s = lateralStep({ playerX: 9.9, vx: 0, edgeRumble: 0 }, 0, 50, 0.01);
    expect(s.vx).toBe(0);
    expect(s.playerX).toBeCloseTo(9.9, 9);
  });

  it('edgeRumble ramps 0→1 across the 10..12 soft zone', () => {
    const at = (x) => lateralStep({ playerX: x, vx: 0, edgeRumble: 0 }, 0, 50, 1e-9).edgeRumble;
    expect(at(0)).toBe(0);
    expect(at(10)).toBe(0);
    expect(at(11)).toBeCloseTo(0.5, 3);
    expect(at(-11)).toBeCloseTo(0.5, 3);
    expect(at(12)).toBeCloseTo(1, 3);
  });

  it('input is clamped to [-1, 1]', () => {
    const big = lateralStep(L0, 5, 50, 0.12);
    const one = lateralStep(L0, 1, 50, 0.12);
    expect(big.vx).toBeCloseTo(one.vx, 9);
  });
});

/* ══════════════════════════════════════════════════════════════════
   Sign chain — decision 1 pin (consumed by Phase C crosswind)
══════════════════════════════════════════════════════════════════ */
describe('sign chain: strafe right ⇒ world −x ⇒ apparent wind +x', () => {
  it('worldOffsetX is −playerX', () => {
    expect(worldOffsetX(5)).toBe(-5);
    expect(worldOffsetX(-3)).toBe(3);
    expect(worldOffsetX(0)).toBe(0);
  });

  it('input > 0 (right) ⇒ vx > 0 ⇒ playerX > 0 ⇒ world offset < 0', () => {
    let s = { playerX: 0, vx: 0, edgeRumble: 0 };
    for (let i = 0; i < 30; i++) s = lateralStep(s, 1, 50, 0.016);
    expect(s.vx).toBeGreaterThan(0);
    expect(s.playerX).toBeGreaterThan(0);
    expect(worldOffsetX(s.playerX)).toBeLessThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════
   tiltStep — visual strafe pose
══════════════════════════════════════════════════════════════════ */
describe('tiltStep', () => {
  const T0 = { roll: 0, yaw: 0, steer: 0 };
  const converge = (vx, vFwd) => {
    let t = { ...T0 };
    for (let i = 0; i < 600; i++) t = tiltStep(t, vx, vFwd, 0.016);
    return t;
  };

  it('caps roll at 7° and yaw at 4° even at max strafe', () => {
    const t = converge(9, 80);
    expect(Math.abs(t.roll)).toBeLessThanOrEqual(7 * DEG + 1e-9);
    expect(Math.abs(t.yaw)).toBeLessThanOrEqual(4 * DEG + 1e-9);
    expect(Math.abs(t.roll)).toBeGreaterThan(6.9 * DEG);   // actually reaches the cap
    expect(Math.abs(t.yaw)).toBeGreaterThan(3.9 * DEG);
  });

  it('signs: strafe right (vx > 0) leans/yaws/steers toward +x (negative rotations)', () => {
    // three.js: +rot.z tips the roof toward −x; +rot.y yaws the nose (−z)
    // toward −x; steerVis > 0 is a LEFT steer. Toward-strafe (right) ⇒ all
    // three negative for vx > 0.
    const t = converge(6, 50);
    expect(t.roll).toBeLessThan(0);
    expect(t.yaw).toBeLessThan(0);
    expect(t.steer).toBeLessThan(0);
    const tl = converge(-6, 50);
    expect(tl.roll).toBeGreaterThan(0);
    expect(tl.yaw).toBeGreaterThan(0);
    expect(tl.steer).toBeGreaterThan(0);
  });

  it('steer stays within the existing steerVis cap (16°, p-norm saturated)', () => {
    const t = converge(9, 30);
    expect(Math.abs(t.steer)).toBeLessThanOrEqual(16 * DEG + 1e-9);
    expect(Math.abs(t.steer)).toBeGreaterThan(2 * DEG);    // visible steer
  });

  it('smooths with tau 0.12 s (one step of dt = tau covers 1 − e⁻¹ of the gap)', () => {
    const one = tiltStep(T0, 9, 80, 0.12);
    const target = converge(9, 80);
    expect(one.roll).toBeCloseTo(target.roll * (1 - Math.exp(-1)), 4);
  });

  it('vx = 0 decays back to zero pose', () => {
    let t = converge(9, 80);
    for (let i = 0; i < 600; i++) t = tiltStep(t, 0, 80, 0.016);
    expect(Math.abs(t.roll)).toBeLessThan(1e-4);
    expect(Math.abs(t.yaw)).toBeLessThan(1e-4);
    expect(Math.abs(t.steer)).toBeLessThan(1e-4);
  });

  it('is pure — does not mutate prev', () => {
    const prev = { roll: 0.1, yaw: 0.05, steer: 0.02 };
    tiltStep(prev, 5, 50, 0.016);
    expect(prev).toEqual({ roll: 0.1, yaw: 0.05, steer: 0.02 });
  });
});

/* ══════════════════════════════════════════════════════════════════
   GAME_CFG — pinned constants (wiring in main.js reads these)
══════════════════════════════════════════════════════════════════ */
describe('GAME_CFG', () => {
  it('pins the plan constants', () => {
    expect(GAME_CFG.RUN_TIME).toBe(90);
    expect(GAME_CFG.COUNT_TICK).toBe(0.9);
    expect(GAME_CFG.GO_HOLD).toBe(0.5);
    expect(GAME_CFG.VX_GAIN).toBe(0.12);
    expect(GAME_CFG.VX_MIN).toBe(3);
    expect(GAME_CFG.VX_MAX).toBe(9);
    expect(GAME_CFG.VX_TAU).toBe(0.12);
    expect(GAME_CFG.X_HARD).toBe(12);
    expect(GAME_CFG.X_SOFT).toBe(10);
    expect(GAME_CFG.SPRING_K).toBe(25);
    expect(GAME_CFG.TILT_TAU).toBe(0.12);
    expect(GAME_CFG.ROLL_CAP).toBeCloseTo(7 * DEG, 9);
    expect(GAME_CFG.YAW_CAP).toBeCloseTo(4 * DEG, 9);
  });
});
