import { describe, it, expect } from 'vitest';
import { buildCircuit, minCurvatureLine, circuitBounds } from '../circuit.js';
import { solveLap, formatLapTime } from '../lap-sim.js';
import { SPA } from '../circuits/spa-data.js';
import { defaultSetup } from '../vehicle-model.js';
import { TrackPath } from '../track-path.js';

/** Closed circle of radius R, counter-clockwise (left turn), n points. */
function circleDef(R, n = 360, extra = {}) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push(R * Math.cos(a), R * Math.sin(a));
  }
  return { id: 'circle', name: 'Circle', points, racingLine: false, ...extra };
}
/** Stadium: two straights of length L joined by semicircles of radius R (CCW). */
function stadiumDef(L, R, extra = {}) {
  const pts = [];
  const step = 5;
  for (let x = -L / 2; x < L / 2; x += step) pts.push(x, -R);
  for (let a = -Math.PI / 2; a < Math.PI / 2; a += step / R) pts.push(L / 2 + R * Math.cos(a), R * Math.sin(a));
  for (let x = L / 2; x > -L / 2; x -= step) pts.push(x, R);
  for (let a = Math.PI / 2; a < 1.5 * Math.PI; a += step / R) pts.push(-L / 2 + R * Math.cos(a), R * Math.sin(a));
  return { id: 'stadium', name: 'Stadium', points: pts, racingLine: false, ...extra };
}

describe('buildCircuit', () => {
  it('circle: length 2πR, constant curvature +1/R (left), periodic', () => {
    const c = buildCircuit(circleDef(100));
    expect(c.length).toBeCloseTo(2 * Math.PI * 100, 0);
    for (const s of [0, 50, 333, 600]) expect(c.kappaAt(s)).toBeCloseTo(1 / 100, 4);
    expect(c.kappaAt(-25)).toBeCloseTo(c.kappaAt(c.length - 25), 12);
    expect(c.kappaAt(c.length + 40)).toBeCloseTo(c.kappaAt(40), 12);
    expect(c.wrap(-1)).toBeCloseTo(c.length - 1, 9);
  });
  it('clockwise circle has negative (right) curvature', () => {
    const def = circleDef(80);
    const rev = [];
    for (let i = def.points.length - 2; i >= 0; i -= 2) rev.push(def.points[i], def.points[i + 1]);
    expect(buildCircuit({ ...def, points: rev }).kappaAt(100)).toBeCloseTo(-1 / 80, 4);
  });
  it('stadium: straights are straight, ends are 1/R', () => {
    const c = buildCircuit(stadiumDef(400, 60));
    expect(Math.abs(c.kappaAt(200))).toBeLessThan(1e-4);
    expect(c.kappaAt(400 + 0.5 * Math.PI * 60)).toBeCloseTo(1 / 60, 3);
    const total = c.kappa.reduce((a, k) => a + k * c.step, 0);
    expect(total).toBeCloseTo(2 * Math.PI, 2);          // one full left-hand lap
  });
  it('elevation: hits its control points, is periodic, grade is its slope', () => {
    const c = buildCircuit(circleDef(200, 720, { elevation: [[0, 0], [300, 20], [800, -10]] }));
    expect(c.elevationAt(0)).toBeCloseTo(0, 9);
    expect(c.elevationAt(300)).toBeCloseTo(20, 9);
    expect(c.elevationAt(800)).toBeCloseTo(-10, 9);
    expect(c.elevationAt(c.length)).toBeCloseTo(0, 6);
    expect(c.elevationAt(c.length + 300)).toBeCloseTo(20, 6);
    expect(c.gradeAt(150)).toBeGreaterThan(0);          // climbing 0 → 20
    expect(c.gradeAt(550)).toBeLessThan(0);
    expect(Math.abs(c.gradeAt(300))).toBeLessThan(0.01); // crest
    expect(buildCircuit(circleDef(100)).gradeAt(50)).toBe(0);
  });
  it('cornerAt names sections and returns "" between them', () => {
    const c = buildCircuit(circleDef(100, 360, { corners: [{ name: 'T1', from: 100, to: 200 }] }));
    expect(c.cornerAt(150)).toBe('T1');
    expect(c.cornerAt(250)).toBe('');
    expect(c.cornerAt(150 + c.length)).toBe('T1');
  });
  it('circuitBounds spans the geometry', () => {
    const b = circuitBounds(buildCircuit(circleDef(100)));
    expect(b.maxX - b.minX).toBeCloseTo(200, 0);
    expect(b.maxY - b.minY).toBeCloseTo(200, 0);
  });
});

describe('minCurvatureLine', () => {
  /** Rounded rectangle (CCW): four 90° corners of radius R joined by straights. */
  function roundRectDef(L, R, extra = {}) {
    const pts = [];
    const step = 5;
    const h = L / 2;
    const arc = (cx, cy, a0) => { for (let a = a0; a < a0 + Math.PI / 2; a += step / R) pts.push(cx + R * Math.cos(a), cy + R * Math.sin(a)); };
    for (let x = -h; x < h; x += step) pts.push(x, -h - R);
    arc(h, -h, -Math.PI / 2);
    for (let y = -h; y < h; y += step) pts.push(h + R, y);
    arc(h, h, 0);
    for (let x = h; x > -h; x -= step) pts.push(x, h + R);
    arc(-h, h, Math.PI / 2);
    for (let y = h; y > -h; y -= step) pts.push(-h - R, y);
    arc(-h, -h, Math.PI);
    return { id: 'rr', name: 'RoundRect', points: pts, racingLine: false, ...extra };
  }
  it('stays inside the corridor and opens up 90° corners (wide in, apex, wide out)', () => {
    const centre = buildCircuit(roundRectDef(300, 30));
    const raced  = buildCircuit(roundRectDef(300, 30, { racingLine: true, widthM: 14, edgeMarginM: 1 }));
    let maxOff = 0, minOff = 0;
    for (const o of raced.lineOffset) { maxOff = Math.max(maxOff, o); minOff = Math.min(minOff, o); }
    expect(maxOff).toBeLessThanOrEqual(6 + 1e-9);
    expect(minOff).toBeGreaterThanOrEqual(-6 - 1e-9);
    expect(maxOff).toBeGreaterThan(4);                  // clips the inside (left) apex
    expect(minOff).toBeLessThan(-2);                    // swings wide (right) before/after
    const peak = (c) => c.kappa.reduce((m, k) => Math.max(m, Math.abs(k)), 0);
    expect(peak(raced)).toBeLessThan(peak(centre) * 0.75);
    // Apex of the first corner (centre of its arc) is on the inside.
    const mid = Math.round((300 + 0.25 * Math.PI * 30) / raced.step);
    expect(raced.lineOffset[mid]).toBeGreaterThan(3);
  });
  it('zero width is the identity', () => {
    const x = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const y = Float64Array.from([0, 1, 0, 1, 0, 1, 0, 1, 0]);
    const r = minCurvatureLine(x, y, 0);
    expect(Array.from(r.x)).toEqual(Array.from(x));
    expect(r.offset.every(o => o === 0)).toBe(true);
  });
});

describe('Spa-Francorchamps', () => {
  const spa = buildCircuit(SPA);
  it('is 7.0 km, clockwise overall, with ~102 m of elevation range', () => {
    expect(spa.length).toBeGreaterThan(6950);
    expect(spa.length).toBeLessThan(7050);
    const total = spa.kappa.reduce((a, k) => a + k * spa.step, 0);
    expect(total).toBeCloseTo(-2 * Math.PI, 1);
    let lo = Infinity, hi = -Infinity, g = 0;
    for (let s = 0; s < spa.length; s += 5) {
      const h = spa.elevationAt(s);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      g = Math.max(g, Math.abs(spa.gradeAt(s)));
    }
    expect(hi - lo).toBeCloseTo(102, 0);
    expect(g).toBeLessThan(0.20);                       // Raidillon ≈ 18 %
    expect(g).toBeGreaterThan(0.12);
  });
  it('corners are where they should be', () => {
    expect(spa.cornerAt(400)).toBe('La Source');
    expect(spa.cornerAt(1060)).toBe('Eau Rouge');
    expect(spa.cornerAt(1200)).toBe('Raidillon');
    expect(spa.cornerAt(2000)).toBe('Kemmel Straight');
    expect(spa.cornerAt(3900)).toBe('Pouhon');
    expect(spa.cornerAt(6780)).toBe('Bus Stop');
    // La Source is a tight right-hander; Pouhon a long left; Kemmel is straight.
    const peak = (a, b) => { let m = 0; for (let s = a; s < b; s += 5) if (Math.abs(spa.kappaAt(s)) > Math.abs(m)) m = spa.kappaAt(s); return m; };
    expect(peak(330, 460)).toBeLessThan(-1 / 40);
    expect(peak(3750, 4180)).toBeGreaterThan(1 / 250);
    expect(Math.abs(peak(1500, 2300))).toBeLessThan(1 / 400);
    // Eau Rouge bottom is lower than both La Source and the top of Raidillon.
    expect(spa.elevationAt(1050)).toBeLessThan(spa.elevationAt(400) - 20);
    expect(spa.elevationAt(1400)).toBeGreaterThan(spa.elevationAt(1050) + 30);
  });
  it('corner sections are ordered and non-overlapping', () => {
    for (let i = 1; i < SPA.corners.length; i++) {
      expect(SPA.corners[i].from).toBeGreaterThanOrEqual(SPA.corners[i - 1].to);
    }
  });
});

describe('solveLap', () => {
  const spa = buildCircuit(SPA);
  it('formatLapTime', () => {
    expect(formatLapTime(106.3)).toBe('1:46.300');
    expect(formatLapTime(59.05)).toBe('0:59.050');
    expect(formatLapTime(NaN)).toBe('–:––.–––');
  });
  it('profile never exceeds the corner limit and is periodic', () => {
    const lap = solveLap(spa, 'F1', defaultSetup('F1'));
    for (let i = 0; i < spa.count; i++) expect(lap.v[i]).toBeLessThanOrEqual(lap.vLim[i] + 1e-9);
    expect(lap.vAt(0)).toBeCloseTo(lap.vAt(spa.length), 9);
    expect(lap.vAt(-5)).toBeCloseTo(lap.vAt(spa.length - 5), 9);
  });
  it('acceleration and braking between samples stay physically bounded', () => {
    const lap = solveLap(spa, 'F1', defaultSetup('F1'));
    for (let i = 0; i < spa.count; i++) {
      const a = (lap.v[(i + 1) % spa.count] ** 2 - lap.v[i] ** 2) / (2 * spa.step);
      expect(a).toBeLessThan(22);       // < ~2.2 g drive
      expect(a).toBeGreaterThan(-75);   // < ~7.5 g braking
    }
  });
  it('F1 laps Spa in a believable time; the ladder is ordered', () => {
    const t = (type) => solveLap(spa, type, defaultSetup(type)).lapTime;
    const f1 = t('F1'), f2 = t('F2'), f3 = t('F3'), gt = t('GT');
    expect(f1).toBeGreaterThan(98);
    expect(f1).toBeLessThan(115);
    expect(f1).toBeLessThan(f2);
    expect(f2).toBeLessThan(f3);
    expect(f3).toBeLessThan(gt);
  });
  it('F1: La Source is slow, Eau Rouge and Blanchimont are fast', () => {
    const lap = solveLap(spa, 'F1', defaultSetup('F1'));
    expect(lap.vAt(400) * 3.6).toBeLessThan(110);
    expect(lap.vAt(1070) * 3.6).toBeGreaterThan(280);
    expect(lap.vAt(6200) * 3.6).toBeGreaterThan(280);
    expect(lap.vMax * 3.6).toBeGreaterThan(310);
  });
  it('setup matters: rain is much slower; bare-minimum wing is slower than medium at Spa', () => {
    const s = defaultSetup('F1');
    const dry = solveLap(spa, 'F1', s).lapTime;
    expect(solveLap(spa, 'F1', s, true).lapTime).toBeGreaterThan(dry + 10);
    expect(solveLap(spa, 'F1', { ...s, wing: 0 }).lapTime).toBeGreaterThan(dry);
    // Low wing is faster on the straight even though it loses the lap.
    expect(solveLap(spa, 'F1', { ...s, wing: 0 }).vMax).toBeGreaterThan(solveLap(spa, 'F1', s).vMax);
  });
  it('a constant-radius circle laps at the corner limit', () => {
    const c = buildCircuit(circleDef(100));
    const lap = solveLap(c, 'GT', defaultSetup('GT'));
    expect(lap.vMax - lap.vMin).toBeLessThan(0.5);
    expect(lap.lapTime).toBeCloseTo(c.length / lap.vAt(0), 1);
  });
});

describe('TrackPath circuit mode', () => {
  it('curvature comes from the circuit; test track restored with null', () => {
    const c = buildCircuit(circleDef(100));
    const tp = new TrackPath(() => 0.5);
    tp.setCircuit(c);
    expect(tp.curvatureAt(0)).toBeCloseTo(0.01, 4);
    expect(tp.curvatureAt(123)).toBeCloseTo(0.01, 4);
    expect(tp.circuit).toBe(c);
    tp.setCircuit(null);
    expect(tp.curvatureAt(123)).toBe(0);
    expect(tp.lapS).toBe(0);
  });
  it('setCircuit re-roots the car and bumps the epoch', () => {
    const tp = new TrackPath(() => 0.5);
    tp.update(1, 50);
    const e = tp.epoch;
    tp.setCircuit(buildCircuit(circleDef(100)), 40);
    expect(tp.pose).toEqual({ s: 0, x: 0, z: 0, theta: 0 });
    expect(tp.epoch).toBe(e + 1);
    expect(tp.lapS).toBeCloseTo(40, 9);
  });
  it('driving a lap returns to the start pose and counts the lap; no random turns are emitted', () => {
    const c = buildCircuit(circleDef(100, 720));
    const tp = new TrackPath(() => 0.5);
    tp.setCircuit(c);
    const dt = 0.01, v = 40;
    let t = 0;
    while (tp.lapCount < 1 && t < 60) { tp.update(dt, v); t += dt; }
    expect(tp.lapCount).toBe(1);
    expect(t).toBeCloseTo(c.length / v, 1);
    expect(tp.turns.length).toBe(0);
    // Heading turned one full revolution; position closed to within a metre.
    expect(tp.pose.theta).toBeCloseTo(2 * Math.PI, 1);
    expect(Math.hypot(tp.pose.x, tp.pose.z)).toBeLessThan(1.5);
    expect(tp.lapS).toBeLessThan(1);
  });
  it('joining mid-lap: the lap counts when the start line is crossed, not after a full length', () => {
    const c = buildCircuit(circleDef(100, 720));
    const tp = new TrackPath(() => 0.5);
    tp.setCircuit(c, c.length - 50);
    expect(tp.lapCount).toBe(0);
    for (let i = 0; i < 10; i++) tp.update(0.1, 40);    // 40 m — still before the line
    expect(tp.lapCount).toBe(0);
    for (let i = 0; i < 5; i++) tp.update(0.1, 40);     // 60 m — crossed
    expect(tp.lapCount).toBe(1);
    expect(tp.lapS).toBeCloseTo(10, 6);
  });
  it('lap distance survives the floating-origin rebase', () => {
    const tp = new TrackPath(() => 0.5);
    tp.setCircuit(buildCircuit(SPA));
    for (let i = 0; i < 300; i++) {            // 300 × 0.1 s × 80 m/s = 2400 m
      tp.update(0.1, 80);
      tp.rebaseIfNeeded();
    }
    expect(tp.epoch).toBeGreaterThan(2);       // setCircuit + ≥2 rebases
    expect(tp.lapS).toBeCloseTo(2400, 3);
    expect(tp.curvatureAt(tp.pose.s)).toBeCloseTo(tp.circuit.kappaAt(2400), 9);
  });
});

describe('TrackPath elevation', () => {
  it('is flat (0 height, 0 grade) off-circuit', () => {
    const tp = new TrackPath(() => 0.5);
    expect(tp.heightAt(50)).toBe(0);
    expect(tp.gradeAt(50)).toBe(0);
  });
  it('heights are relative to s = 0 and match the circuit profile', () => {
    const spa = buildCircuit(SPA);
    const tp = new TrackPath(() => 0.5);
    tp.setCircuit(spa, 1000);
    expect(tp.heightAt(0)).toBe(0);
    expect(tp.heightAt(300)).toBeCloseTo(spa.elevationAt(1300) - spa.elevationAt(1000), 9);
    expect(tp.heightAt(-100)).toBeCloseTo(spa.elevationAt(900) - spa.elevationAt(1000), 9);
    expect(tp.gradeAt(200)).toBeCloseTo(spa.gradeAt(1200), 12);
    expect(tp.gradeAt(200)).toBeGreaterThan(0.1);        // Raidillon climbs
  });
  it('world heights are continuous across a floating-origin rebase', () => {
    const spa = buildCircuit(SPA);
    const tp = new TrackPath(() => 0.5);
    tp.setCircuit(spa, 600);
    for (let i = 0; i < 124; i++) tp.update(0.1, 80);    // 992 m — just before the rebase
    const ahead = 60;
    // Height of a point 60 m ahead RELATIVE TO THE CAR must not jump.
    const rel = () => tp.heightAt(tp.pose.s + ahead) - tp.heightAt(tp.pose.s);
    const before = rel();
    tp.update(0.1, 80);
    expect(tp.rebaseIfNeeded()).toBe(true);
    expect(tp.heightAt(0)).toBe(0);
    expect(Math.abs(rel() - before)).toBeLessThan(0.5);  // 8 m further along a smooth profile
    expect(rel()).toBeCloseTo(spa.elevationAt(tp.lapS + ahead) - spa.elevationAt(tp.lapS), 9);
  });
});

describe('road centre offset + scenery helpers', () => {
  const spa = buildCircuit(SPA);
  it('lineOffsetAt interpolates the racing-line slide and is 0 without one', () => {
    expect(buildCircuit(circleDef(100)).lineOffsetAt(50)).toBe(0);
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s < spa.length; s += 5) { const o = spa.lineOffsetAt(s); lo = Math.min(lo, o); hi = Math.max(hi, o); }
    expect(hi).toBeGreaterThan(2);
    expect(lo).toBeLessThan(-2);
    expect(spa.lineOffsetAt(spa.length + 40)).toBeCloseTo(spa.lineOffsetAt(40), 9);
    // La Source is a right-hander: at the apex the line is on the inside (right ⇒ negative).
    let apex = 0; for (let s = 380; s < 430; s += 5) apex = Math.min(apex, spa.lineOffsetAt(s));
    expect(apex).toBeLessThan(-2);
  });
  it('TrackPath.centerOffsetAt is the road centre relative to the car line (right +)', () => {
    const tp = new TrackPath(() => 0.5);
    expect(tp.centerOffsetAt(10)).toBe(0);
    tp.setCircuit(spa, 300);
    expect(tp.centerOffsetAt(100)).toBeCloseTo(spa.lineOffsetAt(400), 12);
    expect(tp.lapAt(100)).toBeCloseTo(400, 9);
    expect(tp.lapAt(-400)).toBeCloseTo(spa.length - 100, 6);
  });
  it('trackSOfLap finds the nearest occurrence ahead or behind', () => {
    const tp = new TrackPath(() => 0.5);
    expect(Number.isNaN(tp.trackSOfLap(100))).toBe(true);
    tp.setCircuit(spa, 6900);
    expect(tp.trackSOfLap(6950)).toBeCloseTo(50, 6);
    expect(tp.trackSOfLap(50)).toBeCloseTo(spa.length - 6900 + 50, 6);   // across the line, ahead
    expect(tp.trackSOfLap(6800)).toBeCloseTo(-100, 6);                   // behind
    for (let i = 0; i < 30; i++) tp.update(0.1, 50);                     // drive 150 m
    expect(tp.trackSOfLap(50)).toBeCloseTo(spa.length - 6900 + 50, 4);   // track-space s is stable
  });
  it('clearanceAt: open countryside is clear, a point thrown onto another straight is not', () => {
    const c = buildCircuit(stadiumDef(400, 60));
    // On the bottom straight heading +x (CCW): the top straight is 120 m to the LEFT.
    expect(c.clearanceAt(200, 40)).toBeGreaterThan(100);     // 40 m right = outside the stadium
    expect(c.clearanceAt(200, -115)).toBeLessThan(10);       // 115 m left ≈ on the far straight
    expect(c.clearanceAt(200, -60)).toBeGreaterThan(50);     // infield centre
  });
});
