import { describe, it, expect } from 'vitest';
import {
  POWERTRAIN, getPowertrain, rpmInGearAt, nextGear, engineRpm, rpm01, firingHz,
  createPowertrainState, stepPowertrain, DOWNSHIFT_AT, CLUTCH_BITE,
} from '../powertrain.js';
import { VEHICLE_PARAMS, topSpeed, defaultSetup } from '../vehicle-model.js';

describe('powertrain data', () => {
  it('every car has rising gear speeds and sane rev limits', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const p = POWERTRAIN[t];
      for (let i = 1; i < p.vGear.length; i++) expect(p.vGear[i]).toBeGreaterThan(p.vGear[i - 1]);
      expect(p.idle).toBeLessThan(p.launch);
      expect(p.launch).toBeLessThan(p.shift);
      expect(p.shift).toBeLessThan(p.limit);
    }
    expect(getPowertrain('nope')).toBe(POWERTRAIN.F1);
  });
  it('top gear is tall enough for the car to reach its drag-limited top speed', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const p = POWERTRAIN[t];
      const vTop = topSpeed(t, defaultSetup(t)) * 3.6;
      expect(rpmInGearAt(t, p.vGear.length, vTop)).toBeLessThanOrEqual(p.limit);
      expect(VEHICLE_PARAMS[t]).toBeTruthy();
    }
  });
});

describe('rpm and shifting', () => {
  it('rpm is proportional to speed within a gear and hits the shift point at the gear speed', () => {
    expect(rpmInGearAt('F1', 3, 180)).toBeCloseTo(12000, 6);
    expect(rpmInGearAt('F1', 3, 90)).toBeCloseTo(6000, 6);
    expect(rpmInGearAt('F1', 99, 352)).toBeCloseTo(12000, 6);   // clamped to top gear
  });
  it('an upshift drops the revs by the ratio step — not to the floor', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const p = POWERTRAIN[t];
      for (let g = 1; g < p.vGear.length; g++) {
        const after = rpmInGearAt(t, g + 1, p.vGear[g - 1]) / p.shift;
        expect(after, `${t} ${g}→${g + 1}`).toBeGreaterThan(0.6);
        expect(after).toBeLessThan(0.95);
      }
    }
  });
  it('accelerating runs up through every gear in order', () => {
    const seen = [];
    let g = 0;
    for (let v = 0; v <= 350; v += 1) {
      const n = nextGear('F1', g, v, 1);
      if (n !== g) seen.push(n);
      g = n;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it('hysteresis: just after an upshift a small lift does not shift back down', () => {
    expect(nextGear('F1', 2, 146, 1)).toBe(3);
    expect(nextGear('F1', 3, 144, 1)).toBe(3);
    expect(nextGear('F1', 3, 140, 0)).toBe(3);
    // …but slowing properly does.
    expect(nextGear('F1', 3, 146 * DOWNSHIFT_AT - 1, 0)).toBe(2);
  });
  it('braking comes back down through the box without ever over-revving', () => {
    let g = 8;
    const seen = [];
    for (let v = 350; v >= 0; v -= 1) {
      const n = nextGear('F1', g, v, 0);
      if (n !== g) seen.push(n);
      g = n;
      if (g > 0) expect(rpmInGearAt('F1', g, v)).toBeLessThanOrEqual(POWERTRAIN.F1.shift * 1.001);
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });
  it('neutral only when stopped and off the throttle', () => {
    expect(nextGear('GT', 1, 0, 0)).toBe(0);
    expect(nextGear('GT', 0, 0, 1)).toBe(1);
    expect(nextGear('GT', 0, 40, 0)).toBe(1);
  });
});

describe('engine speed', () => {
  it('idles in neutral; a blip of throttle raises it a little', () => {
    expect(engineRpm('GT', 0, 0, 0)).toBe(950);
    expect(engineRpm('GT', 0, 0, 1)).toBeGreaterThan(950);
  });
  it('launch: the clutch slips and holds the revs up until first gear catches', () => {
    const p = POWERTRAIN.F1;
    expect(engineRpm('F1', 1, 0, 1)).toBeCloseTo(p.launch, 6);
    expect(engineRpm('F1', 1, 100, 1)).toBeCloseTo(rpmInGearAt('F1', 1, 100), 6);
    expect(engineRpm('F1', 1, 0, 0)).toBe(p.idle);              // off the throttle: tick-over
    expect(engineRpm('F1', 1, 5, 0)).toBeLessThan(p.idle + 300);
    // The revs are never held flat: they move with road speed all the way
    // through the take-up, and there is no jump where the clutch bites.
    const vBite = CLUTCH_BITE * p.vGear[0];
    for (let v = 1; v < vBite; v += 5) {
      expect(engineRpm('F1', 1, v, 1)).not.toBeCloseTo(engineRpm('F1', 1, v + 5, 1), 0);
    }
    expect(Math.abs(engineRpm('F1', 1, vBite - 0.01, 1) - engineRpm('F1', 1, vBite + 0.01, 1))).toBeLessThan(5);
    expect(engineRpm('F1', 1, vBite, 1)).toBeLessThan(p.launch);       // sags as it bites
  });
  it('never exceeds the limiter and never drops below idle in gear', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const p = POWERTRAIN[t];
      for (let g = 1; g <= p.vGear.length; g++) for (const v of [0, 50, 200, 400]) {
        const r = engineRpm(t, g, v, 0.5);
        expect(r).toBeLessThanOrEqual(p.limit);
        expect(r).toBeGreaterThanOrEqual(p.idle);
      }
    }
  });
  it('rpm01 spans idle → limiter and clamps', () => {
    expect(rpm01('F1', 4800)).toBe(0);
    expect(rpm01('F1', 12800)).toBe(1);
    expect(rpm01('F1', 99999)).toBe(1);
    expect(rpm01('F1', 8800)).toBeCloseTo(0.5, 9);
  });
  it('firing frequency: six cylinders fire three times per revolution', () => {
    expect(firingHz('F1', 12000)).toBeCloseTo(600, 9);
    expect(firingHz('GT', 9000)).toBeCloseTo(450, 9);
  });
});

describe('stepPowertrain', () => {
  it('reports each gear change once, with its direction', () => {
    const st = createPowertrainState();
    const events = [];
    for (let v = 0; v <= 200; v += 2) { stepPowertrain(st, 'F1', v, 1); if (st.shifted) events.push([st.gear, st.shifted]); }
    expect(events).toEqual([[2, 1], [3, 1], [4, 1]]);       // N→1 is a launch, not a shift
    events.length = 0;
    for (let v = 200; v >= 60; v -= 2) { stepPowertrain(st, 'F1', v, 0); if (st.shifted) events.push([st.gear, st.shifted]); }
    expect(events.every(e => e[1] === -1)).toBe(true);
    expect(events.map(e => e[0])).toEqual([3, 2, 1]);
  });
  it('rpm climbs within a gear and steps down on the upshift', () => {
    const st = createPowertrainState();
    let last = 0, drops = 0;
    for (let v = 20; v <= 300; v += 1) {
      stepPowertrain(st, 'F1', v, 1);
      if (st.shifted === 1) { expect(st.rpm).toBeLessThan(last); drops++; }
      else if (v > 115) expect(st.rpm).toBeGreaterThanOrEqual(last - 1e-6);
      last = st.rpm;
    }
    expect(drops).toBe(6);
    expect(st.rpm01).toBeGreaterThan(0);
    expect(st.rpm01).toBeLessThanOrEqual(1);
  });
});
