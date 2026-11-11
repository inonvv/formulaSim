import { describe, it, expect } from 'vitest';
import {
  LAYOUTS, KERB_KAPPA, cornerKappa, outsideOf, insideBlocked, kerbVisible, gravelExtent,
  tyresVisible, clampToBend, hash01, TREES, treeSpec, inLapRange, expandScenery, treeBlocked, barrierBlocked,
} from '../track-layout.js';
import { buildCircuit } from '../circuit.js';
import { SPA } from '../circuits/spa-data.js';
import { SPA_SCENERY } from '../circuits/spa-scenery.js';

const spa = buildCircuit(SPA);

describe('layouts', () => {
  it('the circuit road is ~11 m with barriers set back behind a verge', () => {
    const c = LAYOUTS.circuit, t = LAYOUTS.test;
    expect(c.roadW).toBeGreaterThanOrEqual(9);
    expect(c.roadW).toBeLessThanOrEqual(13);
    expect(c.rumbleX + 0.45).toBeLessThanOrEqual(c.roadW / 2 + 1e-9);   // kerb inside the asphalt
    expect(c.edgeLineX).toBeLessThan(c.roadW / 2);
    expect(c.armcoX).toBeGreaterThan(c.roadW / 2 + 5);
    expect(c.tyreX).toBeLessThan(c.armcoX);                              // tyres in front of the rail
    expect(c.gravelFrom).toBeGreaterThan(c.roadW / 2);
    expect(c.gravelTo).toBeLessThan(c.armcoX);
    expect(t.roadW).toBe(30);                                            // arcade apron untouched
  });
  it('the racing line always stays on the asphalt', () => {
    let m = 0;
    for (const o of spa.lineOffset) m = Math.max(m, Math.abs(o));
    expect(m + 1.0).toBeLessThanOrEqual(LAYOUTS.circuit.roadW / 2);      // + half a car
  });
});

describe('corner rules', () => {
  const path = { curvatureAt: (s) => (s > 100 && s < 160 ? -1 / 50 : 0) };
  it('cornerKappa sees a bend up to 30 m away, signed', () => {
    expect(cornerKappa(path, 0)).toBe(0);
    expect(cornerKappa(path, 75)).toBeCloseTo(-1 / 50, 12);
    expect(cornerKappa(path, 185)).toBeCloseTo(-1 / 50, 12);
    expect(cornerKappa(path, 195)).toBe(0);
  });
  it('outside of a left turn is the right, and vice versa', () => {
    expect(outsideOf(0.01)).toBe(1);
    expect(outsideOf(-0.01)).toBe(-1);
  });
  it('insideBlocked only blocks far-inside points of tight bends', () => {
    expect(insideBlocked(1 / 18, -20)).toBe(true);     // left hairpin, 20 m to the left
    expect(insideBlocked(1 / 18, 20)).toBe(false);     // same hairpin, outside
    expect(insideBlocked(1 / 18, -8)).toBe(false);
    expect(insideBlocked(0, -60)).toBe(false);
  });
  it('kerbs: everywhere on the test track, only at corners on a circuit', () => {
    expect(kerbVisible(LAYOUTS.test, 0)).toBe(true);
    expect(kerbVisible(LAYOUTS.circuit, 0)).toBe(false);
    expect(kerbVisible(LAYOUTS.circuit, KERB_KAPPA * 1.5)).toBe(true);
    expect(kerbVisible(LAYOUTS.circuit, -KERB_KAPPA * 1.5)).toBe(true);
  });
  it('gravel sits on the outside of real corners, ordered left→right', () => {
    expect(gravelExtent(LAYOUTS.test, 1 / 50)).toBeNull();
    expect(gravelExtent(LAYOUTS.circuit, 1 / 900)).toBeNull();
    const left = gravelExtent(LAYOUTS.circuit, 1 / 60);     // left turn ⇒ gravel on the right
    expect(left[0]).toBeGreaterThan(0);
    expect(left[0]).toBeLessThan(left[1]);
    const right = gravelExtent(LAYOUTS.circuit, -1 / 60);
    expect(right[1]).toBeLessThan(0);
    expect(right[0]).toBeLessThan(right[1]);
  });
  it('tyre walls: both sides on the test track, outside of tight corners on a circuit', () => {
    expect(tyresVisible(LAYOUTS.test, 0, 1)).toBe(true);
    expect(tyresVisible(LAYOUTS.circuit, 0, 1)).toBe(false);
    expect(tyresVisible(LAYOUTS.circuit, 1 / 60, 1)).toBe(true);
    expect(tyresVisible(LAYOUTS.circuit, 1 / 60, -1)).toBe(false);
  });
});

describe('clampToBend', () => {
  it('leaves straights alone', () => {
    expect(clampToBend(-160, 160, 0)).toEqual([-160, 160]);
  });
  it('stops a strip short of the centre of a bend, on the inside only', () => {
    const [l, r] = clampToBend(-160, 160, 1 / 20);       // left hairpin R 20
    expect(l).toBeCloseTo(-17, 6);
    expect(r).toBe(160);
    const [l2, r2] = clampToBend(-160, 160, -1 / 20);    // right hairpin
    expect(l2).toBe(-160);
    expect(r2).toBeCloseTo(17, 6);
  });
  it('a strip wholly past the centre collapses to zero width instead of inverting', () => {
    const [l, r] = clampToBend(-40, -30, 1 / 20);
    expect(l).toBe(r);
  });
  it('wide bends do not clip a normal road', () => {
    expect(clampToBend(-5.5, 5.5, 1 / 60)).toEqual([-5.5, 5.5]);
  });
});

describe('trees', () => {
  it('hash01 is deterministic, in [0,1) and well spread', () => {
    expect(hash01(3, 1, 2, 5)).toBe(hash01(3, 1, 2, 5));
    const xs = [];
    for (let k = -200; k < 200; k++) xs.push(hash01(k, 1, 0, 1));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    expect(new Set(xs.map(x => x.toFixed(3))).size).toBeGreaterThan(300);
  });
  it('treeSpec keeps every tree behind the barrier, on its side, and stable', () => {
    for (let k = -50; k < 50; k++) for (const side of [-1, 1]) for (let j = 0; j < TREES.perRow; j++) {
      const t = treeSpec(k, side, j);
      expect(Math.sign(t.lateral)).toBe(side);
      expect(Math.abs(t.lateral)).toBeGreaterThanOrEqual(TREES.minX);
      expect(Math.abs(t.lateral)).toBeLessThanOrEqual(TREES.maxX);
      expect(Math.abs(t.lateral)).toBeGreaterThan(LAYOUTS.circuit.armcoX);
      expect(t.ds).toBeGreaterThanOrEqual(0);
      expect(t.ds).toBeLessThan(TREES.spacing);
      expect(t.scale).toBeGreaterThan(0.7);
      expect(treeSpec(k, side, j)).toEqual(t);
    }
  });
});

describe('scenery expansion', () => {
  it('inLapRange handles ranges that wrap the start line', () => {
    expect(inLapRange(6900, 6860, 7260, 7000)).toBe(true);
    expect(inLapRange(100, 6860, 7260, 7000)).toBe(true);
    expect(inLapRange(300, 6860, 7260, 7000)).toBe(false);
    expect(inLapRange(6800, 6860, 7260, 7000)).toBe(false);
    expect(inLapRange(7100, 6860, 7260, 7000)).toBe(true);   // un-wrapped input
  });
  const { items, pitlanes, keepOut } = expandScenery(SPA_SCENERY, spa);
  it('Spa gets a gantry, pit buildings, grandstands, boards and hoardings', () => {
    const count = (t) => items.filter(i => i.type === t).length;
    expect(count('gantry')).toBe(1);
    expect(count('pit')).toBeGreaterThan(15);
    expect(count('grandstand')).toBeGreaterThan(25);
    expect(count('board')).toBe(7 * 3);
    expect(count('hoarding')).toBeGreaterThan(40);
    // Hoardings stand at the barrier, never on the road.
    for (const h of items.filter(i => i.type === 'hoarding')) {
      expect(h.lateral).toBeGreaterThan(LAYOUTS.circuit.roadW / 2 + 3);
    }
    expect(count('arch')).toBe(2);
    expect(pitlanes.length).toBe(2);
  });
  it('every item sits at a lap distance inside the lap', () => {
    for (const i of items) {
      expect(i.s).toBeGreaterThanOrEqual(0);
      expect(i.s).toBeLessThan(spa.length);
    }
  });
  it('no building stands on another stretch of track', () => {
    for (const i of items) {
      if (i.type !== 'grandstand' && i.type !== 'pit') continue;
      expect(spa.clearanceAt(i.s, i.side * (i.lateral + 6))).toBeGreaterThan(20);
    }
  });
  it('distance boards count down to the corner', () => {
    const b = items.filter(i => i.type === 'board' && i.s > 150 && i.s < 340).sort((x, y) => x.s - y.s);
    expect(b.map(x => x.text)).toEqual(['150', '100', '50']);
    expect(b[2].s).toBeCloseTo(280, 6);
  });
  it('trees and barriers give way to buildings and pit walls', () => {
    expect(treeBlocked(keepOut, 6950, 25, spa.length)).toBe(true);     // pit building, right
    expect(treeBlocked(keepOut, 6950, 70, spa.length)).toBe(false);    // well behind it
    expect(treeBlocked(keepOut, 6950, -20, spa.length)).toBe(true);    // main grandstand, left
    expect(treeBlocked(keepOut, 2000, 25, spa.length)).toBe(false);    // Kemmel: forest
    expect(barrierBlocked(keepOut, 100, 1, spa.length)).toBe(true);    // pit wall replaces the rail
    expect(barrierBlocked(keepOut, 100, -1, spa.length)).toBe(false);
    expect(barrierBlocked(keepOut, 2000, 1, spa.length)).toBe(false);
  });
});

import { vergeReach, groundOffset, SHELF, rowSide } from '../track-layout.js';

describe('shared ground between neighbouring stretches of track', () => {
  it('open country: full reach, level', () => {
    expect(vergeReach(Infinity, 0, 160, 7)).toEqual({ reach: 160, flat: SHELF, dh: 0 });
    expect(groundOffset(Infinity, 5, 60)).toBe(0);
  });
  it('the road always stands on a level shelf — it can never be buried', () => {
    for (const room of [30, 60, 80, 200, 900]) for (const dh of [-20, 15]) {
      const v = vergeReach(room, dh, 160, 7);
      expect(v.flat).toBeGreaterThanOrEqual(7);            // at least the road + margin
      expect(v.flat).toBeLessThanOrEqual(v.reach);
      expect(groundOffset(room, dh, 0)).toBe(0);
      expect(groundOffset(room, dh, Math.min(5.5, room / 2 - 3))).toBe(0);   // across the asphalt
    }
    // With room to spare the shelf covers gravel and barriers too.
    expect(vergeReach(200, 10, 160, 7).flat).toBe(SHELF);
    expect(groundOffset(200, 10, 12.5)).toBe(0);
  });
  it('a neighbour 80 m away: the bank stops half-way and meets it at the mean height', () => {
    const v = vergeReach(80, -12, 160, 7);
    expect(v.reach).toBe(40);
    expect(v.dh).toBeCloseTo(-6, 9);
    // The neighbour's bank, looking back at us: same edge point, same height.
    const w = vergeReach(80, +12, 160, 7);
    expect(w.reach).toBe(40);
    expect(-12 + w.dh).toBeCloseTo(v.dh, 9);
  });
  it('never narrower than the road + margin, never wider than the strip', () => {
    expect(vergeReach(6, 3, 160, 7).reach).toBe(7);
    expect(vergeReach(900, 3, 160, 7).reach).toBe(160);
    // Capped short of the midpoint ⇒ only part of the rise is reached.
    const v = vergeReach(900, 9, 160, 7);
    expect(v.dh).toBeCloseTo(4.5 * (160 - SHELF) / (450 - SHELF), 9);
  });
  it('groundOffset: level on the shelf, linear up the bank, null past half-way', () => {
    expect(groundOffset(80, -12, 20)).toBe(0);
    expect(groundOffset(80, -12, 31)).toBeCloseTo(-6 * (31 - SHELF) / (40 - SHELF), 9);
    expect(groundOffset(80, -12, -31)).toBeCloseTo(groundOffset(80, -12, 31), 12);
    expect(groundOffset(80, -12, 39)).toBeNull();
    expect(groundOffset(80, -12, 60)).toBeNull();
    // Matches the strip's own edge height where they meet.
    const v = vergeReach(80, -12, 160, 7);
    expect(groundOffset(80, -12, v.reach - 2.01)).toBeCloseTo(v.dh * (v.reach - 2.01 - v.flat) / (v.reach - v.flat), 6);
  });
});

describe('Spa: no verge lies across another stretch of track', () => {
  it('sideRoomAt finds the other leg of the Bruxelles and La Source hairpins', () => {
    // Bruxelles is a right-hand hairpin: on entry the exit leg is to the right.
    let found = 0;
    for (let s = 2960; s < 3200; s += 10) {
      const r = spa.sideRoomAt(s, 1);
      if (Number.isFinite(r.room)) { found++; expect(r.room).toBeGreaterThan(15); }
    }
    expect(found).toBeGreaterThan(5);
    // The Kemmel straight is open on both sides.
    // The Kemmel straight has nothing within the verge's reach on either side.
    expect(spa.sideRoomAt(2000, 1).room).toBeGreaterThan(200);
    expect(spa.sideRoomAt(2000, -1).room).toBeGreaterThan(200);
    expect(buildCircuit({ id: 'c', name: 'c', racingLine: false, points: [0, 0, 500, 0, 500, 1, 0, 1] }).sideRoomAt(100, 1).dh).toBe(0);
  });
  it('every verge edge stays clear of every other piece of asphalt', () => {
    // For each station, the grass edge on each side must be nearer to its
    // own road than to any other stretch (else it would cover that road).
    const half = LAYOUTS.circuit.roadW / 2;
    let worst = Infinity;
    for (let s = 0; s < spa.length; s += 10) {
      for (const side of [-1, 1]) {
        const { room } = spa.sideRoomAt(s, side);
        const { reach } = vergeReach(room, 0, 160, half + 1.5);
        if (!Number.isFinite(room)) continue;
        worst = Math.min(worst, room - reach - half);     // gap left before the other road's edge
      }
    }
    expect(worst).toBeGreaterThan(0);
  });
});

describe('rowSide — one side of the ground cross-section', () => {
  const C = LAYOUTS.circuit, T = LAYOUTS.test;
  const base = { c: 0, kappa: 0, kappaNear: 0, room: Infinity, dh: 0, pit: null, maxReach: 160 };
  const ordered = (r) => r.a <= r.z0 && r.z0 <= r.z1 && r.z1 <= r.flat && r.flat <= r.reach;
  it('open straight: road edge, level shelf, full reach, no zone', () => {
    const r = rowSide(C, 1, base);
    expect(r).toMatchObject({ a: 5.5, z0: 5.5, z1: 5.5, zone: 'none', flat: SHELF, reach: 160, dh: 0 });
  });
  it('test track: 15 m of asphalt each side, then grass to the edge', () => {
    const r = rowSide(T, -1, base);
    expect(r.a).toBe(15);
    expect(r.zone).toBe('none');
    expect(r.reach).toBe(160);
    expect(ordered(r)).toBe(true);
  });
  it('gravel appears on the OUTSIDE of a corner only', () => {
    const left = { ...base, kappa: 1 / 60, kappaNear: 1 / 60 };       // left turn ⇒ outside = right
    expect(rowSide(C, 1, left).zone).toBe('gravel');
    expect(rowSide(C, 1, left).z0).toBe(C.gravelFrom);
    expect(rowSide(C, 1, left).z1).toBe(C.gravelTo);
    expect(rowSide(C, -1, left).zone).toBe('none');
  });
  it('a pit lane takes the zone and wins over gravel', () => {
    const r = rowSide(C, 1, { ...base, kappa: 1 / 60, kappaNear: 1 / 60, pit: { x0: 9.2, x1: 20.6 } });
    expect(r.zone).toBe('pit');
    expect(r.z0).toBe(9.2);
    expect(r.z1).toBe(20.6);
    expect(ordered(r)).toBe(true);
  });
  it('a close neighbour squeezes everything but keeps the order and the road', () => {
    for (const room of [20, 30, 44, 60, 100]) for (const c of [-3.5, 0, 3.5]) for (const side of [-1, 1]) {
      const r = rowSide(C, side, { ...base, c, room, dh: 8, kappa: 1 / 60, kappaNear: 1 / 60, pit: side > 0 ? { x0: 9.2, x1: 20.6 } : null });
      expect(ordered(r), `room ${room} c ${c} side ${side}`).toBe(true);
      expect(r.a).toBe(5.5);
      expect(r.reach).toBeLessThanOrEqual(Math.max(7, (room - side * c) / 2) + 1e-9);
    }
  });
  it('inside of a hairpin: nothing reaches past the centre, order holds, bank flattens', () => {
    const r = rowSide(C, -1, { ...base, kappa: 1 / 20, kappaNear: 1 / 20, room: 60, dh: 6 });   // left hairpin, inside = left
    expect(r.reach).toBeLessThanOrEqual(17 + 1e-9);
    expect(ordered(r)).toBe(true);
    expect(Math.abs(r.dh)).toBeLessThanOrEqual(3);
    const out = rowSide(C, 1, { ...base, kappa: 1 / 20, kappaNear: 1 / 20 });
    expect(out.reach).toBe(160);
  });
  it('left and right edges mirror: the two sides never cross at the road', () => {
    for (const c of [-3.6, 0, 3.6]) {
      const L = rowSide(C, -1, { ...base, c }), R = rowSide(C, 1, { ...base, c });
      expect(c - L.a).toBeLessThan(c + R.a);
    }
  });
});
