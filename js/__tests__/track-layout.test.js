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
