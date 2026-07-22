/**
 * track-path.test.js — TDD for the curved-track path model (js/track-path.js).
 *
 * Conventions pinned here (single source of truth):
 *   • Track space: car starts at origin heading −z. forward(θ) = (−sinθ, −cosθ) in (x,z).
 *   • Positive yaw rate / curvature ⇒ θ grows ⇒ nose swings toward −x = LEFT turn.
 *   • Turns are emitted in arc-length domain: κ(s) = dir·κmax·sin²(π(s−s0)/L),
 *     κmax = MAX_YAW_RATE / v_emit (clamped to MIN_RADIUS), L = duration·v_emit.
 *   • Track group world transform = inverse car pose: rotY = −θ,
 *     pos = −R_y(−θ)·p  ⇒ driving straight 10 m puts the track at world z = +10.
 *
 * Pure module — no THREE, no DOM.
 */
import { describe, it, expect } from 'vitest';
import {
  TURN_CFG,
  TrackPath,
  rowPose,
  steerAngleRad,
  rollAngleRad,
  rainLateralAccel,
  ribbonDrift,
  rowWindow,
  poolSize,
  poolIndex,
} from '../track-path.js';

/* Deterministic RNG (LCG) so turn schedules are reproducible. */
function makeRng(seed = 1) {
  let st = seed >>> 0;
  return () => {
    st = (st * 1664525 + 1013904223) >>> 0;
    return st / 2 ** 32;
  };
}

/* Drive helper: advance path at constant speed for `seconds`. */
function drive(path, seconds, v, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) path.update(dt, v);
}

const V = 50; // m/s test cruise (180 km/h)

describe('TURN_CFG contract', () => {
  it('schedule + sweep bounds match the spec (20–35 s gaps, 3–4 s sweeps)', () => {
    expect(TURN_CFG.GAP_MIN_S).toBe(20);
    expect(TURN_CFG.GAP_MAX_S).toBe(35);
    expect(TURN_CFG.DUR_MIN_S).toBe(3);
    expect(TURN_CFG.DUR_MAX_S).toBe(4);
  });

  it('turns are cinematic: ω_max ≈ 17°/s, min radius 20 m, lookahead ≥ road horizon', () => {
    // 0.30 rad/s: at 280 km/h → R ≈ 259 m → ~7.7° of visible bend across the
    // 35 m road horizon. The old 0.14 gave 3.6° — imperceptible on screen.
    expect(TURN_CFG.MAX_YAW_RATE).toBeCloseTo(0.30, 5);
    expect(TURN_CFG.MIN_RADIUS).toBeGreaterThanOrEqual(20);
    expect(TURN_CFG.LOOKAHEAD).toBeGreaterThanOrEqual(36); // visible road ends ~35 m ahead
  });
});

describe('REAL_CORNER — signature R85 sweeper every Nth turn', () => {
  // Deterministic LCG so the schedule is reproducible.
  const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  async function pathWithTurns(n) {
    const { TrackPath } = await import('../track-path.js');
    const tp = new TrackPath(lcg(42));
    while (tp.turns.length < n) tp.update(0.05, 50);
    return tp;
  }

  it('spec constants: R 85 m, 180 m constant-radius hold, 12 m clothoid ramps', async () => {
    const { REAL_CORNER } = await import('../track-path.js');
    expect(REAL_CORNER.RADIUS).toBe(85);
    expect(REAL_CORNER.HOLD).toBe(180);
    expect(REAL_CORNER.RAMP).toBe(12);
    expect(REAL_CORNER.EVERY_NTH).toBe(3);
  });

  it('every 3rd scheduled turn is the real corner; others stay speed-scaled sweeps', async () => {
    const { REAL_CORNER } = await import('../track-path.js');
    const tp = await pathWithTurns(6);
    expect(tp.turns[2].shape).toBe('real');
    expect(tp.turns[5].shape).toBe('real');
    for (const i of [0, 1, 3, 4]) expect(tp.turns[i].shape).not.toBe('real');
    const real = tp.turns[2];
    expect(real.s1 - real.s0).toBeCloseTo(REAL_CORNER.HOLD + 2 * REAL_CORNER.RAMP, 9);
  });

  it('trapezoidal curvature: linear ramp to exactly 1/85, constant hold, ramp out', async () => {
    const tp = await pathWithTurns(3);
    const t = tp.turns[2];
    const k85 = 1 / 85;
    expect(Math.abs(tp.curvatureAt(t.s0 + 6))).toBeCloseTo(k85 / 2, 9);      // mid-ramp
    expect(Math.abs(tp.curvatureAt(t.s0 + 12))).toBeCloseTo(k85, 9);         // hold start
    expect(Math.abs(tp.curvatureAt((t.s0 + t.s1) / 2))).toBeCloseTo(k85, 9); // mid-corner
    expect(Math.abs(tp.curvatureAt(t.s1 - 6))).toBeCloseTo(k85 / 2, 9);      // ramp out
    expect(tp.curvatureAt(t.s0 - 1)).toBe(0);
    expect(tp.curvatureAt(t.s1 + 1)).toBe(0);
  });

  it('heading change through the hold is 180/85 rad = 121.3° (spec)', async () => {
    const tp = await pathWithTurns(3);
    const t = tp.turns[2];
    let dTheta = 0;
    for (let s = t.s0 + 12; s < t.s1 - 12; s += 0.01) dTheta += tp.curvatureAt(s) * 0.01;
    expect(Math.abs(dTheta)).toBeCloseTo(180 / 85, 3);                       // 2.1176 rad
    expect((Math.abs(dTheta) * 180) / Math.PI).toBeCloseTo(121.3, 1);
  });

  it('at 180 km/h the mid-corner yaw rate is the spec 0.588 rad/s = 33.7°/s', async () => {
    const tp = await pathWithTurns(3);
    const t = tp.turns[2];
    const v = 50; // 180 km/h
    expect(Math.abs(v * tp.curvatureAt((t.s0 + t.s1) / 2))).toBeCloseTo(50 / 85, 9);
  });
});

describe('pathBendTable / bendLookup — car-frame road bend for effect coherence', () => {
  const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  it('straight road: every sample is ~0, and z = 0 maps onto the car exactly', async () => {
    const { TrackPath, pathBendTable } = await import('../track-path.js');
    const tp = new TrackPath(lcg(1));
    for (let i = 0; i < 100; i++) tp.update(0.05, 30); // < first turn gap
    const table = pathBendTable(tp);
    for (const dx of table.dx) expect(Math.abs(dx)).toBeLessThan(1e-6);
  });

  it('mid-hold in the REAL corner the table matches the analytic R 85 circle', async () => {
    const { TrackPath, pathBendTable, REAL_CORNER } = await import('../track-path.js');
    const tp = new TrackPath(lcg(42));
    // Drive until the car sits deep enough in a real-corner hold that the
    // whole sampled window [−24, +12] m lies inside the constant-radius arc.
    let real = null;
    while (!real) {
      tp.update(0.05, 50);
      const s = tp.pose.s;
      real = tp.turns.find(t =>
        t.shape === 'real' && s > t.s0 + REAL_CORNER.RAMP + 24 && s < t.s1 - REAL_CORNER.RAMP - 24) ?? null;
    }
    const k = real.kMax;                       // ±1/85
    const table = pathBendTable(tp);
    for (let i = 0; i < table.dx.length; i++) {
      const z = table.zMin + i * table.step;
      const expected = -(1 - Math.cos(k * z)) / k;   // cos is even: same law fore & aft
      expect(table.dx[i]).toBeCloseTo(expected, 2);
    }
    // Direction: ahead of the nose (z<0) the road bends toward the turn side.
    const iAhead = 0;                          // z = −24
    expect(Math.sign(table.dx[iAhead])).toBe(-Math.sign(k));
  });

  it('bendLookup lerps between samples and clamps beyond the table ends', async () => {
    const { bendLookup } = await import('../track-path.js');
    const table = { zMin: -4, step: 2, dx: [0, 2, 6, 6, 8] };  // z: −4,−2,0,2,4
    expect(bendLookup(table, -4)).toBe(0);
    expect(bendLookup(table, -3)).toBeCloseTo(1, 9);   // midpoint lerp
    expect(bendLookup(table, 1)).toBeCloseTo(6, 9);
    expect(bendLookup(table, -40)).toBe(0);            // clamp low
    expect(bendLookup(table, 40)).toBe(8);             // clamp high
    expect(bendLookup(null, 3)).toBe(0);
  });
});

describe('cameraBankRad — cinematic camera roll into turns', () => {
  it('zero at zero yaw rate; antisymmetric in ω', async () => {
    const { cameraBankRad } = await import('../track-path.js');
    expect(cameraBankRad(0)).toBe(0);
    expect(cameraBankRad(0.15)).toBeCloseTo(-cameraBankRad(-0.15), 9);
  });

  it('peaks at ±6° at max yaw rate and clamps beyond it', async () => {
    const { cameraBankRad } = await import('../track-path.js');
    const six = (6 * Math.PI) / 180;
    expect(Math.abs(cameraBankRad(TURN_CFG.MAX_YAW_RATE))).toBeCloseTo(six, 9);
    expect(Math.abs(cameraBankRad(TURN_CFG.MAX_YAW_RATE * 3))).toBeCloseTo(six, 9);
  });

  it('left turn (ω>0) banks positive rotateZ (lean into the turn, chase view)', async () => {
    const { cameraBankRad } = await import('../track-path.js');
    expect(cameraBankRad(0.15)).toBeGreaterThan(0);
  });

  it('scales linearly inside the clamp', async () => {
    const { cameraBankRad } = await import('../track-path.js');
    expect(cameraBankRad(TURN_CFG.MAX_YAW_RATE / 2))
      .toBeCloseTo(cameraBankRad(TURN_CFG.MAX_YAW_RATE) / 2, 9);
  });
});

describe('Straight driving (no turn emitted yet)', () => {
  it('integrates pose along −z with θ = 0', () => {
    const p = new TrackPath(makeRng());
    drive(p, 2, V); // 100 m, well before any 20 s gap fires
    expect(p.pose.theta).toBeCloseTo(0, 9);
    expect(p.pose.x).toBeCloseTo(0, 9);
    expect(p.pose.z).toBeCloseTo(-100, 0);
    expect(p.pose.s).toBeCloseTo(100, 0);
  });

  it('world transform moves track +z past the fixed car', () => {
    const p = new TrackPath(makeRng());
    drive(p, 0.2, V); // 10 m
    const w = p.worldTransform();
    expect(w.rotY).toBeCloseTo(0, 9);
    expect(w.x).toBeCloseTo(0, 6);
    expect(w.z).toBeCloseTo(10, 1);
  });

  it('does not advance or schedule while speed is 0', () => {
    const p = new TrackPath(makeRng());
    drive(p, 40, 0); // 40 s parked — past any gap timer if it (wrongly) ran
    expect(p.pose.s).toBe(0);
    expect(p.turns.length).toBe(0);
  });
});

describe('Turn scheduling', () => {
  it('first turn fires after 20–35 s of driving time and starts ≥ LOOKAHEAD ahead', () => {
    const p = new TrackPath(makeRng(7));
    drive(p, 36, V);
    expect(p.turns.length).toBeGreaterThanOrEqual(1);
    const t0 = p.turns[0];
    const emitS = t0.emitS; // car position when emitted
    expect(t0.s0 - emitS).toBeGreaterThanOrEqual(TURN_CFG.LOOKAHEAD - 1e-6);
    // gap timer respected: emitted no earlier than 20 s × V metres
    expect(emitS).toBeGreaterThanOrEqual(20 * V - 1);
  });

  it('turn arc length corresponds to a 3–4 s sweep at emit speed', () => {
    const p = new TrackPath(makeRng(7));
    drive(p, 36, V);
    const t0 = p.turns[0];
    const L = t0.s1 - t0.s0;
    expect(L).toBeGreaterThanOrEqual(3 * V - 1);
    expect(L).toBeLessThanOrEqual(4 * V + 1);
  });

  it('both directions occur across seeds', () => {
    const dirs = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      const p = new TrackPath(makeRng(seed));
      drive(p, 36, V);
      if (p.turns[0]) dirs.add(p.turns[0].dir);
    }
    expect(dirs.has(1)).toBe(true);
    expect(dirs.has(-1)).toBe(true);
  });

  it('successive gaps stay within 20–35 driving seconds (s-domain at constant v)', () => {
    const p = new TrackPath(makeRng(3));
    drive(p, 120, V); // ~3-4 turns
    expect(p.turns.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < p.turns.length; i++) {
      const gapS = p.turns[i].emitS - p.turns[i - 1].emitS;
      // emit-to-emit spacing ≈ gap timer; sweep itself adds ≤ 4 s
      expect(gapS).toBeGreaterThanOrEqual(20 * V - 1);
      expect(gapS).toBeLessThanOrEqual((35 + 4) * V + 1);
    }
  });

  it('low emit speed clamps curvature to MIN_RADIUS (no hairpins)', () => {
    const vSlow = 1.5; // 5.4 km/h → unclamped κ would be 0.093 ⇒ R ≈ 10.7 m
    const p = new TrackPath(makeRng(5));
    drive(p, 36, vSlow);
    const t0 = p.turns[0];
    expect(t0).toBeDefined();
    expect(Math.abs(t0.kMax)).toBeLessThanOrEqual(1 / TURN_CFG.MIN_RADIUS + 1e-9);
  });
});

describe('Curvature profile and pose integration through a turn', () => {
  function pathWithTurn(dir = 1) {
    const p = new TrackPath(makeRng(2));
    p._emitTurn({ s0: 100, L: 3.5 * V, dir, vEmit: V }); // test hook
    return p;
  }

  it('κ is 0 outside the turn, peaks at the middle, sin²-shaped', () => {
    const p = pathWithTurn(1);
    const L = 3.5 * V;
    expect(p.curvatureAt(99)).toBe(0);
    expect(p.curvatureAt(100 + L + 1)).toBe(0);
    const kMid = p.curvatureAt(100 + L / 2);
    expect(kMid).toBeCloseTo(TURN_CFG.MAX_YAW_RATE / V, 6);
    expect(p.curvatureAt(100 + L / 4)).toBeCloseTo(kMid * 0.5, 6);
  });

  it('net heading change = ω_max·T/2 and is constant after the turn', () => {
    const p = pathWithTurn(1);
    const L = 3.5 * V;
    const after = p.poseAt(100 + L + 10);
    const expected = (TURN_CFG.MAX_YAW_RATE / V) * L * 0.5; // ∫sin² = L/2
    expect(after.theta).toBeCloseTo(expected, 3);
    const further = p.poseAt(100 + L + 60);
    expect(further.theta).toBeCloseTo(after.theta, 6);
  });

  it('left turn (dir=+1) drifts the path toward −x; right turn toward +x', () => {
    const L = 3.5 * V;
    const pl = pathWithTurn(1).poseAt(100 + L + 50);
    const pr = pathWithTurn(-1).poseAt(100 + L + 50);
    expect(pl.x).toBeLessThan(-1);
    expect(pr.x).toBeGreaterThan(1);
    expect(pr.x).toBeCloseTo(-pl.x, 4); // mirror symmetry
  });

  it('driving through the turn yields yaw rate v·κ ≤ ω_max', () => {
    const p = pathWithTurn(1);
    let maxYaw = 0;
    drive(p, (100 + 3.5 * V + 20) / V, V);
    // sample yaw rate over the sweep region directly
    for (let s = 100; s < 100 + 3.5 * V; s += 5) {
      maxYaw = Math.max(maxYaw, Math.abs(V * p.curvatureAt(s)));
    }
    expect(maxYaw).toBeLessThanOrEqual(TURN_CFG.MAX_YAW_RATE + 1e-9);
    expect(maxYaw).toBeGreaterThan(TURN_CFG.MAX_YAW_RATE * 0.95);
  });
});

describe('World transform (inverse car pose)', () => {
  it('maps the car-pose point to the world origin', () => {
    const p = new TrackPath(makeRng(2));
    p._emitTurn({ s0: 20, L: 3.5 * V, dir: 1, vEmit: V });
    drive(p, 4, V); // 200 m — through the turn
    const { x, z, theta } = p.pose;
    const w = p.worldTransform();
    // world = R_y(rotY)·T + pos with T = car track-space position ⇒ origin
    const wx = Math.cos(w.rotY) * x + Math.sin(w.rotY) * z + w.x;
    const wz = -Math.sin(w.rotY) * x + Math.cos(w.rotY) * z + w.z;
    expect(wx).toBeCloseTo(0, 4);
    expect(wz).toBeCloseTo(0, 4);
    expect(w.rotY).toBeCloseTo(-theta, 9);
  });

  it('a point 10 m ahead on a straight maps to world (0, −10)', () => {
    const p = new TrackPath(makeRng());
    drive(p, 2, V);
    const ahead = p.poseAt(p.pose.s + 10);
    const w = p.worldTransform();
    const wx = Math.cos(w.rotY) * ahead.x + Math.sin(w.rotY) * ahead.z + w.x;
    const wz = -Math.sin(w.rotY) * ahead.x + Math.cos(w.rotY) * ahead.z + w.z;
    expect(wx).toBeCloseTo(0, 3);
    expect(wz).toBeCloseTo(-10, 3);
  });
});

describe('Negative arc-length (road behind the car)', () => {
  it('poseAt(−35) on a fresh path is the straight road behind the start', () => {
    const p = new TrackPath(makeRng());
    const b = p.poseAt(-35);
    expect(b.x).toBeCloseTo(0, 9);
    expect(b.z).toBeCloseTo(35, 6);   // behind = +z
    expect(b.theta).toBeCloseTo(0, 9);
  });

  it('rowPose works across the whole initial window [−35, +41]', () => {
    const p = new TrackPath(makeRng());
    for (let s = -35; s <= 41; s += 7.6) {
      const r = rowPose(p, s, 5.55);
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isFinite(r.z)).toBe(true);
    }
  });

  it('after rebase, the behind-region preserves a past turn (world-invariant)', () => {
    const p = new TrackPath(makeRng(2));
    p._emitTurn({ s0: 50, L: 3.5 * V, dir: 1, vEmit: V });
    drive(p, 5, V); // 250 m — turn fully behind the car
    const sBack = p.pose.s - 20;
    const before = p.poseAt(sBack);
    const wb = p.worldTransform();
    const bx = Math.cos(wb.rotY) * before.x + Math.sin(wb.rotY) * before.z + wb.x;
    const bz = -Math.sin(wb.rotY) * before.x + Math.cos(wb.rotY) * before.z + wb.z;

    p.rebase();
    const after = p.poseAt(-20);
    const wa = p.worldTransform();
    const ax = Math.cos(wa.rotY) * after.x + Math.sin(wa.rotY) * after.z + wa.x;
    const az = -Math.sin(wa.rotY) * after.x + Math.cos(wa.rotY) * after.z + wa.z;
    expect(ax).toBeCloseTo(bx, 2);
    expect(az).toBeCloseTo(bz, 2);
  });
});

describe('Rebase (floating origin)', () => {
  it('rebase preserves world-space geometry of points ahead', () => {
    const p = new TrackPath(makeRng(2));
    p._emitTurn({ s0: 50, L: 3.5 * V, dir: -1, vEmit: V });
    drive(p, 5, V); // 250 m
    const sAhead = p.pose.s + 25;
    const before = p.poseAt(sAhead);
    const wb = p.worldTransform();
    const bx = Math.cos(wb.rotY) * before.x + Math.sin(wb.rotY) * before.z + wb.x;
    const bz = -Math.sin(wb.rotY) * before.x + Math.cos(wb.rotY) * before.z + wb.z;

    const epochBefore = p.epoch;
    p.rebase();
    expect(p.epoch).toBe(epochBefore + 1);
    expect(p.pose.s).toBeCloseTo(0, 9);
    expect(Math.abs(p.pose.x)).toBeLessThan(1e-6);
    expect(Math.abs(p.pose.theta)).toBeLessThan(1e-6);

    const after = p.poseAt(25); // same physical point, rebased coords
    const wa = p.worldTransform();
    const ax = Math.cos(wa.rotY) * after.x + Math.sin(wa.rotY) * after.z + wa.x;
    const az = -Math.sin(wa.rotY) * after.x + Math.cos(wa.rotY) * after.z + wa.z;
    expect(ax).toBeCloseTo(bx, 3);
    expect(az).toBeCloseTo(bz, 3);
  });
});

describe('rowPose — furniture layout along the path', () => {
  it('lateral offset stays perpendicular to the local heading', () => {
    const p = new TrackPath(makeRng(2));
    p._emitTurn({ s0: 10, L: 3.5 * V, dir: 1, vEmit: V });
    const s = 10 + (3.5 * V) / 2; // mid-turn, θ ≠ 0
    const c = p.poseAt(s);
    const r = rowPose(p, s, 5.55);
    const dx = r.x - c.x;
    const dz = r.z - c.z;
    expect(Math.hypot(dx, dz)).toBeCloseTo(5.55, 6);
    // perpendicular to forward(θ) = (−sinθ, −cosθ)
    const dot = dx * -Math.sin(c.theta) + dz * -Math.cos(c.theta);
    expect(dot).toBeCloseTo(0, 6);
    expect(r.rotY).toBeCloseTo(c.theta, 9);
  });
});

describe('rowWindow / poolIndex — sliding furniture window', () => {
  it('covers [s−behind, s+ahead] on the spacing grid', () => {
    const { kMin, kMax } = rowWindow(100, 4, 35, 41);
    expect(kMin).toBe(Math.ceil(65 / 4));   // 17 → s=68 ≥ 65
    expect(kMax).toBe(Math.floor(141 / 4)); // 35 → s=140 ≤ 141
    for (let k = kMin; k <= kMax; k++) {
      expect(k * 4).toBeGreaterThanOrEqual(65);
      expect(k * 4).toBeLessThanOrEqual(141);
    }
  });

  it('window size is stable as s advances (pool never overflows)', () => {
    const n = poolSize(4, 35, 41);
    for (let s = 0; s < 200; s += 0.7) {
      const { kMin, kMax } = rowWindow(s, 4, 35, 41);
      expect(kMax - kMin + 1).toBeLessThanOrEqual(n);
    }
  });

  it('poolIndex maps each grid line to a stable slot, also for negative k', () => {
    expect(poolIndex(0, 20)).toBe(0);
    expect(poolIndex(21, 20)).toBe(1);
    expect(poolIndex(-1, 20)).toBe(19);
    // distinct k in one window never collide
    const { kMin, kMax } = rowWindow(50, 4, 35, 41);
    const n = poolSize(4, 35, 41);
    const used = new Set();
    for (let k = kMin; k <= kMax; k++) used.add(poolIndex(k, n));
    expect(used.size).toBe(kMax - kMin + 1);
  });
});

describe('Car visual helpers', () => {
  it('steerAngleRad follows Ackermann ∝ wheelbase·κ, exaggerated ×6, capped at 16°', () => {
    expect(steerAngleRad(0, 3.6)).toBe(0);
    const small = steerAngleRad(0.002, 3.6);
    expect(small).toBeCloseTo(Math.atan(3.6 * 0.002) * 6, 4); // ×6 legibility
    expect(steerAngleRad(0.05, 3.6)).toBeLessThanOrEqual((16 * Math.PI) / 180 + 1e-9);
    expect(steerAngleRad(-0.002, 3.6)).toBeCloseTo(-small, 9);
    // REAL corner (R 85): visibly steered, inside the cap.
    expect(steerAngleRad(1 / 85, 3.6) * 180 / Math.PI).toBeCloseTo(14.6, 1);
  });

  it('rollAngleRad: left turn (ω>0) rolls right side down (negative rot.z), capped 7°', () => {
    const roll = rollAngleRad(50, 0.14); // a_lat = 7 m/s² ≈ 0.71 g
    expect(roll).toBeLessThan(0);
    expect(Math.abs(roll)).toBeCloseTo(0.7136 * (7 * Math.PI) / 180, 3); // linear below 1 g
    expect(Math.abs(rollAngleRad(80, 0.30))).toBeLessThanOrEqual((7 * Math.PI) / 180 + 1e-9); // 2.4 g clamps
    expect(rollAngleRad(50, -0.14)).toBeCloseTo(-roll, 9);
    expect(rollAngleRad(50, 0)).toBe(0);
  });
});

describe('Effect coupling helpers', () => {
  it('rainLateralAccel is the real centrifugal term v·ω (outward = +x on left turn)', () => {
    expect(rainLateralAccel(77.8, 0.14)).toBeCloseTo(10.892, 2); // ≈1.1 g at 280 km/h
    expect(rainLateralAccel(50, -0.1)).toBeCloseTo(-5, 6);
    expect(rainLateralAccel(0, 0.14)).toBe(0);
  });

  it('ribbonDrift: apparent world rotation sweeps downstream air −ω·z, ×6 legibility', () => {
    // left turn (ω>0), downstream point z=+3 → drift toward −x
    expect(ribbonDrift(0.14, 3)).toBeCloseTo(-0.14 * 3 * 6, 6);
    expect(ribbonDrift(-0.14, 3)).toBeCloseTo(0.14 * 3 * 6, 6);
    expect(ribbonDrift(0.14, 0)).toBe(0);
  });
});
