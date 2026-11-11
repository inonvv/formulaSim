import { describe, it, expect } from 'vitest';
import {
  PEAK_SLIP, localSpeedRatio, localQScale, rearSlip, flowYawAt, sideSplit, turnFlow,
} from '../flow-asymmetry.js';
import {
  wakeGeometry, wakeStreams, sampleStream, streamLength, dirtColor,
} from '../wake-paths.js';

describe('cornering flow asymmetry', () => {
  it('straight line: both sides see the same air', () => {
    expect(localQScale(0.9, 0)).toBe(1);
    expect(localQScale(-0.9, 0)).toBe(1);
    expect(sideSplit(0, 0.9)).toEqual({ left: 0.5, right: 0.5 });
    expect(rearSlip(0, 40)).toBe(0);
    expect(flowYawAt(-1.5, 0, 0, 2)).toBe(0);
  });
  it('LEFT turn: the right (outside) of the car meets faster air', () => {
    const k = 1 / 60;                                   // left, R 60 m
    expect(localSpeedRatio(0.9, k)).toBeCloseTo(1.015, 9);
    expect(localQScale(0.9, k)).toBeGreaterThan(1);
    expect(localQScale(-0.9, k)).toBeLessThan(1);
    expect(localQScale(0, k)).toBe(1);
    const s = sideSplit(k, 0.9);
    expect(s.right).toBeGreaterThan(s.left);
    expect(s.left + s.right).toBeCloseTo(1, 12);
  });
  it('RIGHT turn mirrors it exactly', () => {
    const l = sideSplit(1 / 40, 0.9), r = sideSplit(-1 / 40, 0.9);
    expect(r.left).toBeCloseTo(l.right, 12);
    expect(localQScale(0.9, -1 / 40)).toBeCloseTo(localQScale(-0.9, 1 / 40), 12);
  });
  it('the tighter the corner, the bigger the difference; a hairpin is several percent', () => {
    const fast = sideSplit(1 / 300, 0.9), hairpin = sideSplit(1 / 20, 0.9);
    expect(hairpin.right - hairpin.left).toBeGreaterThan(fast.right - fast.left);
    expect(hairpin.right - hairpin.left).toBeGreaterThan(0.03);
    expect(fast.right - fast.left).toBeLessThan(0.01);
  });
  it('rear slip grows with grip used, capped at the tyre peak, signed like the turn', () => {
    expect(rearSlip(20, 40)).toBeCloseTo(PEAK_SLIP / 2, 12);
    expect(rearSlip(-20, 40)).toBeCloseTo(-PEAK_SLIP / 2, 12);
    expect(rearSlip(400, 40)).toBeCloseTo(PEAK_SLIP, 12);
    expect(rearSlip(10, 0)).toBe(0);
  });
  it('yaw gradient: left turn — air from the right at the tail, swinging back toward the nose', () => {
    const k = 1 / 60, slip = rearSlip(30, 40), zRear = 2.0;
    const tail = flowYawAt(zRear, k, slip, zRear), nose = flowYawAt(-2.4, k, slip, zRear);
    expect(tail).toBeCloseTo(-slip, 12);                // β < 0 ⇒ air moving toward −x ⇒ from the right
    expect(nose).toBeGreaterThan(tail);
    expect(nose - tail).toBeCloseTo(k * 4.4, 12);       // κ per metre
  });
  it('turnFlow bundles the state', () => {
    expect(turnFlow(1 / 80, 20, 40, 2.1)).toEqual({ kappa: 1 / 80, slip: PEAK_SLIP / 2, zRear: 2.1 });
    expect(turnFlow(undefined, undefined, 40)).toEqual({ kappa: 0, slip: 0, zRear: 1.8 });
  });
});

describe('dirty-air pathlines', () => {
  const measure = {
    frontAxleZ: -1.47, rearAxleZ: 2.10, frontAxleX: 0.82, rearAxleX: 0.80, wheelRadius: 0.345, groundContactY: -0.62,
    anchors: {
      frontWing: { x: 0, y: -0.25, z: -2.45 }, rearWing: { x: 0, y: 0.35, z: 2.55 },
      sidepodInletR: { x: 0.70, y: -0.10, z: -0.40 },
    },
  };
  const geo = wakeGeometry(measure);
  const base = wakeStreams(geo);
  const get = (list, id, side) => list.find(s => s.id === id && s.side === side);
  const IDS = ['frontWingTip', 'frontTyreWake', 'sidepodFlow', 'rearTyreWake', 'diffuser', 'rearWingTip'];

  it('geometry falls back safely with no measure', () => {
    const g = wakeGeometry(null);
    for (const k of Object.keys(g)) expect(Number.isFinite(g[k]), k).toBe(true);
    expect(g.zr).toBeGreaterThan(g.zf);
    expect(wakeStreams(g).length).toBe(12);
  });
  it('six streams per side, mirror images at rest', () => {
    expect(base.length).toBe(12);
    for (const id of IDS) {
      const l = get(base, id, -1), r = get(base, id, 1);
      expect(l.pts.length).toBe(r.pts.length);
      l.pts.forEach((p, i) => {
        expect(p.x).toBeCloseTo(-r.pts[i].x, 12);
        expect(p.y).toBeCloseTo(r.pts[i].y, 12);
        expect(p.z).toBeCloseTo(r.pts[i].z, 12);
      });
    }
  });
  it('every stream runs front-to-back, stays above the ground, and widens', () => {
    for (const s of base) {
      for (let i = 1; i < s.pts.length; i++) expect(s.pts[i].z, s.id).toBeGreaterThan(s.pts[i - 1].z);
      for (const p of s.pts) {
        expect(p.y).toBeGreaterThanOrEqual(geo.g);
        expect(p.dirt).toBeGreaterThanOrEqual(0);
        expect(p.dirt).toBeLessThanOrEqual(1);
        expect(p.r).toBeGreaterThan(0);
      }
      expect(s.pts[s.pts.length - 1].r).toBeGreaterThan(s.pts[0].r);
      expect(streamLength(s)).toBeGreaterThan(3);
    }
  });
  it('front tyre wake: starts at the tyre, is pushed OUTBOARD, drawn back in at the waist, then up', () => {
    const w = get(base, 'frontTyreWake', 1).pts;
    expect(w[0].x).toBeCloseTo(geo.xf, 9);
    expect(w[0].z).toBeGreaterThan(geo.zf);
    expect(w[0].z).toBeLessThan(geo.zf + 2 * geo.R);
    const widest = Math.max(...w.map(p => p.x));
    expect(widest).toBeGreaterThan(geo.xf + 0.15);                       // outwash
    const atRear = w.find(p => p.z > geo.zr);
    expect(atRear.x).toBeLessThan(geo.xr);                               // inboard of the rear tyre
    expect(w[w.length - 1].y).toBeGreaterThan(w[0].y + 1.0);             // thrown up behind the car
    expect(Math.max(...w.map(p => p.dirt))).toBe(1);                     // the dirtiest air on the car
  });
  it('front wing tip vortex goes around the OUTSIDE of the front tyre', () => {
    const v = get(base, 'frontWingTip', 1);
    expect(v.vortex).toBe(true);
    const atAxle = v.pts.find(p => Math.abs(p.z - geo.zf) < 1e-9);
    expect(atAxle.x).toBeGreaterThan(geo.xf + 0.2);
    expect(v.pts[0].z).toBeLessThan(geo.zf);                             // born at the wing, ahead of the axle
  });
  it('sidepod flow enters at the inlet, then passes UNDER the rear wing and is thrown up', () => {
    const s = get(base, 'sidepodFlow', 1).pts;
    const inlet = s[1];
    expect(inlet.x).toBeCloseTo(0.70, 9);
    expect(inlet.z).toBeCloseTo(-0.40, 9);
    const atWing = s.find(p => Math.abs(p.z - geo.rwZ) < 1e-9);
    expect(atWing.y).toBeLessThan(geo.rwY);
    expect(s[s.length - 1].y).toBeGreaterThan(geo.rwY + 0.8);
  });
  it('rear wing tip vortices start at the wing tips; the diffuser core starts under the car', () => {
    const t = get(base, 'rearWingTip', 1).pts[0];
    expect(t.z).toBeCloseTo(geo.rwZ, 9);
    expect(t.y).toBeCloseTo(geo.rwY, 9);
    const d = get(base, 'diffuser', 1).pts;
    expect(d[0].y).toBeLessThan(geo.g + 0.2);
    expect(d[0].z).toBeLessThan(geo.zr);
    expect(d[d.length - 1].y).toBeGreaterThan(geo.g + 1.5);              // the mushroom
  });
  it('DRS / low wing flattens the wake; more wing throws it higher', () => {
    const top = (list, id) => { const p = get(list, id, 1).pts; return p[p.length - 1].y; };
    const drs = wakeStreams(geo, { rearGain: 0.42 }), hi = wakeStreams(geo, { rearGain: 1.35 });
    for (const id of ['frontTyreWake', 'rearTyreWake', 'sidepodFlow', 'rearWingTip', 'diffuser']) {
      expect(top(drs, id), id).toBeLessThan(top(base, id));
      expect(top(hi, id), id).toBeGreaterThan(top(base, id));
    }
    expect(get(drs, 'rearWingTip', 1).scale).toBeLessThan(get(base, 'rearWingTip', 1).scale);
  });
  it('LEFT turn: steering left pushes both front wakes to the RIGHT; the loaded right tyre sheds the bigger wake', () => {
    const turn = wakeStreams(geo, { steer: 0.06, loadL: 0.6, loadR: 1.5 });
    for (const side of [-1, 1]) {
      const a = get(base, 'frontTyreWake', side).pts, b = get(turn, 'frontTyreWake', side).pts;
      expect(b[0].x).toBeCloseTo(a[0].x, 1);                             // still born at the tyre
      expect(b[3].x).toBeGreaterThan(a[3].x + 0.03);                     // deflected right downstream
    }
    const L = get(turn, 'frontTyreWake', -1), R = get(turn, 'frontTyreWake', 1);
    expect(R.scale).toBeGreaterThan(L.scale);
    expect(R.pts[1].r).toBeGreaterThan(L.pts[1].r);
    // …and no longer mirror images.
    expect(L.pts[3].x).not.toBeCloseTo(-R.pts[3].x, 3);
  });
  it('sampleStream interpolates continuously and clamps', () => {
    const s = get(base, 'frontTyreWake', 1);
    expect(sampleStream(s, 0)).toEqual({ x: s.pts[0].x, y: s.pts[0].y, z: s.pts[0].z, r: s.pts[0].r, dirt: s.pts[0].dirt });
    const end = s.pts[s.pts.length - 1];
    expect(sampleStream(s, 1).z).toBeCloseTo(end.z, 12);
    expect(sampleStream(s, 5).z).toBeCloseTo(end.z, 12);
    expect(sampleStream(s, -1).z).toBeCloseTo(s.pts[0].z, 12);
    let last = -Infinity;
    for (let u = 0; u <= 1.0001; u += 0.02) { const p = sampleStream(s, u); expect(p.z).toBeGreaterThanOrEqual(last - 1e-9); last = p.z; }
  });
  it('dirtColor: clean is cool, dirty is hot', () => {
    const clean = dirtColor(0), mid = dirtColor(0.5), hot = dirtColor(1);
    expect(clean[2]).toBeGreaterThan(clean[0]);          // blue-ish
    expect(hot[0]).toBeGreaterThan(hot[2]);              // red-ish
    expect(mid[0]).toBeCloseTo(1, 9);
    expect(dirtColor(9)).toEqual(hot);
    for (const c of [clean, mid, hot]) for (const v of c) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
});

import { computeSurfaceCp, CfdEffect } from '../cfd-effect.js';

describe('pressure paint in a corner', () => {
  const A = { frontWing: { x: 0, y: 0.05, z: -2.30 }, rearWing: { x: 0, y: 0.84, z: 1.92 }, floor: { x: 0, y: 0.03, z: 0.10 } };
  // Underside of the front wing, left and right halves.
  const fwAt = (x) => [x, 0.05, -2.30 - 0.30 + 0.25 * 0.60, 0, -1, 0];
  const cp = (pt, turn) => computeSurfaceCp(...pt, 'F1', A, 1, 1, 0, null, turn);
  const scene = () => ({ add() {}, remove() {} });

  it('no turn state ⇒ identical to the straight-line paint', () => {
    for (const x of [-0.8, 0, 0.8]) expect(cp(fwAt(x), null)).toBe(computeSurfaceCp(...fwAt(x), 'F1', A, 1, 1, 0, null));
  });
  it('LEFT turn: the right front-wing half pulls harder than the left', () => {
    const turn = { kappa: 1 / 40, slip: 0, zRear: 2 };
    const L = cp(fwAt(-0.8), turn), R = cp(fwAt(0.8), turn), mid = cp(fwAt(0), turn);
    expect(L).toBeLessThan(0);                       // suction
    expect(Math.abs(R)).toBeGreaterThan(Math.abs(L));
    expect(mid).toBeCloseTo(cp(fwAt(0), null), 12);  // centreline unchanged by the speed gradient
    expect(R / cp(fwAt(0.8), null)).toBeCloseTo((1 + 0.8 / 40) ** 2, 9);
  });
  it('RIGHT turn mirrors it', () => {
    const l = { kappa: 1 / 40, slip: 0, zRear: 2 }, r = { kappa: -1 / 40, slip: 0, zRear: 2 };
    expect(cp(fwAt(-0.8), r)).toBeCloseTo(cp(fwAt(0.8), l), 12);
  });
  it('yaw: with rear slip in a left turn, a RIGHT-facing rear flank gains impact pressure', () => {
    // Vertical flank near the rear axle, normal pointing right (+x) or left (−x).
    const flank = (nx) => [nx * 0.7, 0.4, 1.9, nx, 0, 0];
    // Slip alone (κ → 0 isolates the yaw from the speed gradient): the air
    // comes from the right, so the right flank is pushed toward stagnation
    // and the left one is untouched.
    const turn = { kappa: 0, slip: 6 * Math.PI / 180, zRear: 1.9 };
    expect(cp(flank(1), turn)).toBeGreaterThan(cp(flank(1), null) + 0.01);
    expect(cp(flank(-1), turn)).toBeCloseTo(cp(flank(-1), null), 12);
    expect(cp(flank(1), null)).toBeCloseTo(cp(flank(-1), null), 12);   // symmetric when straight
  });
  it('CfdEffect.setTurnFlow quantises, ignores no-ops, and clears on the straight', () => {
    const cfd = new CfdEffect(scene());
    cfd._betaDirty = false;
    cfd.setTurnFlow({ kappa: 0, slip: 0 });
    expect(cfd._turn).toBeNull();
    expect(cfd._betaDirty).toBe(false);
    cfd.setTurnFlow({ kappa: 1 / 60, slip: 0.05, zRear: 2.1 });
    expect(cfd._turn.kappa).toBeCloseTo(0.016, 9);
    expect(cfd._turn.zRear).toBe(2.1);
    expect(cfd._betaDirty).toBe(true);
    cfd._betaDirty = false;
    cfd.setTurnFlow({ kappa: 1 / 60 + 1e-4, slip: 0.0501, zRear: 2.1 });   // inside the quantum
    expect(cfd._betaDirty).toBe(false);
    cfd.setTurnFlow({ kappa: 0.0004, slip: 0.004 });                       // straight again
    expect(cfd._turn).toBeNull();
    expect(cfd._betaDirty).toBe(true);
  });
});
