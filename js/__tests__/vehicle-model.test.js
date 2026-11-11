import { describe, it, expect } from 'vitest';
import {
  RHO_AIR, G, VEHICLE_PARAMS, getVehicleParams, defaultSetup, normalizeSetup,
  wingScale, rideEffect, aeroCoeffs, solveAero, wheelLoads, tireMu,
  gripCapacity, maxLateralAccel, cornerSpeedLimit, longAccel, topSpeed,
  tireUsage, createVehicleState, stepVehicle, lookAheadCap,
} from '../vehicle-model.js';

const kmh = (v) => v / 3.6;
const sum = (l) => l.FL + l.FR + l.RL + l.RR;

describe('params + setup', () => {
  it('has all four cars and falls back to F1', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) expect(VEHICLE_PARAMS[t]).toBeTruthy();
    expect(getVehicleParams('nope')).toBe(VEHICLE_PARAMS.F1);
  });
  it('normalizeSetup clamps junk into legal ranges', () => {
    const s = normalizeSetup('F1', { wing: 9, rideHeightMm: -5, drs: 1, yawDeg: 99 });
    expect(s.wing).toBe(1);
    expect(s.rideHeightMm).toBe(VEHICLE_PARAMS.F1.ride.min);
    expect(s.drs).toBe(true);
    expect(s.yawDeg).toBe(12);
    expect(normalizeSetup('F1', { wing: NaN })).toEqual(defaultSetup('F1'));
  });
  it('wingScale is 1 at the reference and monotonic', () => {
    expect(wingScale(0.5)).toBeCloseTo(1, 10);
    expect(wingScale(0)).toBeLessThan(wingScale(1));
  });
});

describe('aero coefficients', () => {
  it('dynamic pressure law: forces scale with v²', () => {
    // Fixed ride height (no spring solve) isolates the pure ½ρv²·C·A law.
    const c = aeroCoeffs('F1', defaultSetup('F1'));
    const q = 0.5 * RHO_AIR * 50 * 50;
    expect(q * c.ClA).toBeCloseTo(0.5 * 1.225 * 2500 * c.ClA, 6);
    const a1 = solveAero('GT', defaultSetup('GT'), 30);
    const a2 = solveAero('GT', defaultSetup('GT'), 60);
    expect(a2.drag / a1.drag).toBeGreaterThan(3.9);
    expect(a2.drag / a1.drag).toBeLessThan(4.3);
  });
  it('F1 downforce exceeds its own weight somewhere between 150 and 230 km/h', () => {
    const W = VEHICLE_PARAMS.F1.mass * G;
    expect(solveAero('F1', defaultSetup('F1'), kmh(150)).downforce).toBeLessThan(W);
    expect(solveAero('F1', defaultSetup('F1'), kmh(230)).downforce).toBeGreaterThan(W);
  });
  it('GT at max wing makes roughly the 860 kg Porsche quotes at 285 km/h', () => {
    const a = solveAero('GT', { ...defaultSetup('GT'), wing: 1 }, kmh(285));
    expect(a.downforce / G).toBeGreaterThan(700);
    expect(a.downforce / G).toBeLessThan(1050);
  });
  it('more wing ⇒ more downforce AND more drag', () => {
    const lo = aeroCoeffs('F1', { ...defaultSetup('F1'), wing: 0 });
    const hi = aeroCoeffs('F1', { ...defaultSetup('F1'), wing: 1 });
    expect(hi.ClA).toBeGreaterThan(lo.ClA);
    expect(hi.CdA).toBeGreaterThan(lo.CdA);
  });
  it('DRS sheds rear load and drag and moves the balance forward', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const shut = aeroCoeffs(t, defaultSetup(t));
      const open = aeroCoeffs(t, { ...defaultSetup(t), drs: true });
      expect(open.CdA).toBeLessThan(shut.CdA);
      expect(open.ClA).toBeLessThan(shut.ClA);
      expect(open.balance).toBeGreaterThan(shut.balance);
      expect(open.gains.rearWing).toBeLessThan(shut.gains.rearWing);
      expect(open.gains.frontWing).toBeCloseTo(shut.gains.frontWing, 10);
    }
  });
  it('ride height: lower floor makes more downforce until it stalls', () => {
    const r = VEHICLE_PARAMS.F1.ride;
    expect(rideEffect('F1', r.nominal)).toBeCloseTo(1, 10);
    expect(rideEffect('F1', r.opt)).toBeGreaterThan(rideEffect('F1', r.nominal));
    expect(rideEffect('F1', r.max)).toBeLessThan(1);
    expect(rideEffect('F1', r.opt * 0.3)).toBeLessThan(rideEffect('F1', r.opt));   // stall
  });
  it('yaw costs downforce, adds drag, and makes a signed side force', () => {
    const s0 = defaultSetup('F1');
    const c0 = aeroCoeffs('F1', s0);
    const cL = aeroCoeffs('F1', { ...s0, yawDeg: 8 });
    const cR = aeroCoeffs('F1', { ...s0, yawDeg: -8 });
    expect(cL.ClA).toBeLessThan(c0.ClA);
    expect(cL.CdA).toBeGreaterThan(c0.CdA);
    expect(c0.CyA).toBe(0);
    expect(cL.CyA).toBeGreaterThan(0);
    expect(cR.CyA).toBeCloseTo(-cL.CyA, 10);
    expect(cR.ClA).toBeCloseTo(cL.ClA, 10);
  });
  it('balance is a sane front share for every car', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const b = aeroCoeffs(t, defaultSetup(t)).balance;
      expect(b).toBeGreaterThan(0.25);
      expect(b).toBeLessThan(0.60);
    }
  });
});

describe('solveAero — ride-height coupling', () => {
  it('is all zero at rest', () => {
    const a = solveAero('F1', defaultSetup('F1'), 0);
    expect(a.downforce).toBe(0);
    expect(a.drag).toBe(0);
    expect(a.heaveMm).toBeCloseTo(0, 10);
    expect(a.rideMm).toBeCloseTo(defaultSetup('F1').rideHeightMm, 10);
  });
  it('downforce squeezes the car down, and never through the plank', () => {
    const s = defaultSetup('F1');
    const a = solveAero('F1', s, kmh(320));
    expect(a.heaveMm).toBeGreaterThan(5);
    expect(a.rideMm).toBeLessThan(s.rideHeightMm);
    expect(a.rideMm).toBeGreaterThanOrEqual(VEHICLE_PARAMS.F1.ride.floorMm - 1e-9);
    const low = solveAero('F1', { ...s, rideHeightMm: VEHICLE_PARAMS.F1.ride.min }, kmh(340));
    expect(low.bottoming).toBe(true);
  });
  it('front + rear downforce sum to the total; drag power = F·v', () => {
    const a = solveAero('F2', defaultSetup('F2'), 70);
    expect(a.downforceFront + a.downforceRear).toBeCloseTo(a.downforce, 6);
    expect(a.dragPowerKW).toBeCloseTo(a.drag * 70 / 1000, 9);
  });
  it('all outputs stay finite across the whole envelope', () => {
    for (const t of ['F1', 'F2', 'F3', 'GT']) {
      const p = VEHICLE_PARAMS[t];
      for (const wing of [0, 0.5, 1]) for (const h of [p.ride.min, p.ride.max]) for (const v of [0, 40, 100]) {
        const a = solveAero(t, { wing, rideHeightMm: h, drs: wing === 0, yawDeg: 10 }, v);
        for (const k of ['downforce', 'drag', 'sideForce', 'balance', 'rideMm', 'heaveMm', 'ld']) {
          expect(Number.isFinite(a[k]), `${t} ${k}`).toBe(true);
        }
      }
    }
  });
});

describe('wheel loads + weight transfer', () => {
  it('static loads sum to the weight and follow the weight distribution', () => {
    const l = wheelLoads('GT', null, 0, 0);
    const p = VEHICLE_PARAMS.GT;
    expect(sum(l)).toBeCloseTo(p.mass * G, 6);
    expect((l.FL + l.FR) / sum(l)).toBeCloseTo(p.frontWeight, 10);
    expect(l.FL).toBeCloseTo(l.FR, 10);
  });
  it('aero adds exactly the downforce to the total', () => {
    const a = solveAero('F1', defaultSetup('F1'), 80);
    expect(sum(wheelLoads('F1', a, 0, 0))).toBeCloseTo(VEHICLE_PARAMS.F1.mass * G + a.downforce, 5);
  });
  it('braking loads the front axle, acceleration the rear — total unchanged', () => {
    const base = wheelLoads('GT', null, 0, 0);
    const brk  = wheelLoads('GT', null, -10, 0);
    const acc  = wheelLoads('GT', null, 5, 0);
    expect(brk.FL).toBeGreaterThan(base.FL);
    expect(brk.RL).toBeLessThan(base.RL);
    expect(acc.RL).toBeGreaterThan(base.RL);
    expect(sum(brk)).toBeCloseTo(sum(base), 6);
    const p = VEHICLE_PARAMS.GT;
    expect((brk.FL + brk.FR) - (base.FL + base.FR)).toBeCloseTo(p.mass * 10 * p.cgHeight / p.wheelbase, 6);
  });
  it('left turn (ay > 0) loads the right-hand wheels', () => {
    const l = wheelLoads('GT', null, 0, 12);
    expect(l.FR).toBeGreaterThan(l.FL);
    expect(l.RR).toBeGreaterThan(l.RL);
    const r = wheelLoads('GT', null, 0, -12);
    expect(r.FL).toBeCloseTo(l.FR, 8);
    expect(sum(l)).toBeCloseTo(VEHICLE_PARAMS.GT.mass * G, 6);
  });
  it('a wheel can lift but never go negative', () => {
    const l = wheelLoads('GT', null, 0, 80);
    expect(l.FL).toBe(0);
    expect(l.RL).toBe(0);
  });
});

describe('tyres + limits', () => {
  it('load sensitivity: μ falls as load rises; wet is lower', () => {
    const fz0 = VEHICLE_PARAMS.F1.mass * G / 4;
    expect(tireMu('F1', fz0)).toBeCloseTo(VEHICLE_PARAMS.F1.mu, 10);
    expect(tireMu('F1', 3 * fz0)).toBeLessThan(tireMu('F1', fz0));
    expect(tireMu('F1', fz0, true)).toBeLessThan(tireMu('F1', fz0));
  });
  it('lateral transfer costs grip (load sensitivity)', () => {
    const even = gripCapacity('GT', wheelLoads('GT', null, 0, 0));
    const turn = gripCapacity('GT', wheelLoads('GT', null, 0, 12));
    expect(turn).toBeLessThan(even);
  });
  it('F1 lateral grip grows strongly with speed; high speed is 4–7 g', () => {
    const s = defaultSetup('F1');
    const slow = maxLateralAccel('F1', s, kmh(80)) / G;
    const fast = maxLateralAccel('F1', s, kmh(280)) / G;
    expect(slow).toBeGreaterThan(1.4);
    expect(slow).toBeLessThan(2.4);
    expect(fast).toBeGreaterThan(4);
    expect(fast).toBeLessThan(7);
  });
  it('GT peaks well below the F1', () => {
    const g = maxLateralAccel('GT', defaultSetup('GT'), kmh(200)) / G;
    expect(g).toBeGreaterThan(1.3);
    expect(g).toBeLessThan(2.6);
  });
  it('corner speed: tighter is slower, more wing is faster, wet is slower', () => {
    const s = defaultSetup('F1');
    const r85  = cornerSpeedLimit('F1', s, 1 / 85);
    const r40  = cornerSpeedLimit('F1', s, 1 / 40);
    expect(r40).toBeLessThan(r85);
    expect(cornerSpeedLimit('F1', { ...s, wing: 1 }, 1 / 85)).toBeGreaterThan(cornerSpeedLimit('F1', { ...s, wing: 0 }, 1 / 85));
    expect(cornerSpeedLimit('F1', s, 1 / 85, true)).toBeLessThan(r85);
    expect(cornerSpeedLimit('F1', s, -1 / 85)).toBeCloseTo(r85, 6);
    expect(cornerSpeedLimit('F1', s, 0)).toBe(110);
    // The limit really is the limit.
    expect(r85 * r85 / 85).toBeLessThanOrEqual(maxLateralAccel('F1', s, r85) + 1e-3);
  });
  it('top speed: less wing and DRS are faster; F1 lands 300–375 km/h', () => {
    const s = defaultSetup('F1');
    const mid = topSpeed('F1', s) * 3.6;
    expect(mid).toBeGreaterThan(300);
    expect(mid).toBeLessThan(375);
    expect(topSpeed('F1', { ...s, wing: 0 })).toBeGreaterThan(topSpeed('F1', { ...s, wing: 1 }));
    expect(topSpeed('F1', { ...s, drs: true })).toBeGreaterThan(topSpeed('F1', s));
    const gt = topSpeed('GT', defaultSetup('GT')) * 3.6;
    expect(gt).toBeGreaterThan(270);
    expect(gt).toBeLessThan(330);
  });
  it('longAccel: launch is traction-limited, top end power-limited, braking grows with speed', () => {
    const s = defaultSetup('F1');
    const launch = longAccel('F1', s, 5, 1, 0) / G;
    expect(launch).toBeGreaterThan(0.8);
    expect(launch).toBeLessThan(1.6);
    expect(longAccel('F1', s, 90, 1, 0)).toBeLessThan(longAccel('F1', s, 40, 1, 0));
    const brakeFast = -longAccel('F1', s, kmh(320), 0, 1) / G;
    const brakeSlow = -longAccel('F1', s, kmh(80), 0, 1) / G;
    expect(brakeFast).toBeGreaterThan(4);
    expect(brakeFast).toBeGreaterThan(brakeSlow * 1.8);
    // At top speed full throttle nets ~zero.
    expect(Math.abs(longAccel('F1', s, topSpeed('F1', s), 1, 0))).toBeLessThan(0.15);
  });
  it('tireUsage: zero at rest, ~1 at the lateral limit, outside tyres work harder under transfer', () => {
    const s = defaultSetup('GT');
    const v = kmh(150);
    const aero = solveAero('GT', s, v);
    const u0 = tireUsage('GT', wheelLoads('GT', aero, 0, 0), 0, 0);
    expect(u0.FL).toBe(0);
    const ay = maxLateralAccel('GT', s, v);
    const u = tireUsage('GT', wheelLoads('GT', aero, 0, ay), 0, ay);
    const loaded = ['FL', 'FR', 'RL', 'RR'].filter(k => u[k] > 0);   // a 911 lifts its inside front
    const mean = loaded.reduce((a, k) => a + u[k], 0) / loaded.length;
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.2);
    // Braking works the fronts (bias), drive works only the rears.
    const ub = tireUsage('GT', wheelLoads('GT', aero, -8, 0), -8, 0);
    expect(ub.FL).toBeGreaterThan(0);
    const ud = tireUsage('GT', wheelLoads('GT', aero, 4, 0), 4, 0);
    expect(ud.FL).toBe(0);
    expect(ud.RL).toBeGreaterThan(0);
  });
});

describe('stepVehicle', () => {
  const run = (type, setup, targetV, seconds, extra = {}) => {
    const vs = createVehicleState();
    const dt = 1 / 60;
    for (let i = 0; i < seconds * 60; i++) {
      stepVehicle(vs, { type, setup, dt, targetV, kappa: 0, capV: Infinity, ...extra });
    }
    return vs;
  };
  it('accelerates to and holds the target without overshoot', () => {
    const vs = run('F1', defaultSetup('F1'), kmh(200), 20);
    expect(vs.v).toBeCloseTo(kmh(200), 3);
    expect(vs.ax).toBeCloseTo(0, 6);
    expect(vs.throttle).toBeGreaterThan(0);      // holding against drag
    expect(vs.throttle).toBeLessThan(0.5);
    expect(vs.brake).toBe(0);
  });
  it('F1 0–100 km/h takes 2–4 s', () => {
    const vs = createVehicleState();
    let t = 0;
    while (vs.v < kmh(100) && t < 10) {
      stepVehicle(vs, { type: 'F1', setup: defaultSetup('F1'), dt: 1 / 120, targetV: 95, kappa: 0 });
      t += 1 / 120;
    }
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(4);
  });
  it('cannot exceed the drag-limited top speed of the setup', () => {
    const s = { ...defaultSetup('F1'), wing: 1 };
    const vs = run('F1', s, kmh(400), 90);
    expect(vs.v).toBeLessThanOrEqual(topSpeed('F1', s) + 0.5);
    expect(vs.v).toBeGreaterThan(topSpeed('F1', s) - 3);
  });
  it('braking transfers load forward and pitches the nose down', () => {
    const vs = run('GT', defaultSetup('GT'), kmh(250), 40);
    const rest = wheelLoads('GT', vs.aero, 0, 0);
    stepVehicle(vs, { type: 'GT', setup: defaultSetup('GT'), dt: 1 / 60, targetV: 0, kappa: 0 });
    expect(vs.brake).toBe(1);
    expect(vs.ax).toBeLessThan(-8);
    expect(vs.loads.FL).toBeGreaterThan(rest.FL);
    expect(vs.loads.RL).toBeLessThan(rest.RL);
    expect(vs.pitchRad).toBeLessThan(0);
  });
  it('cornering produces capped lateral g, roll, and a speed cap flag', () => {
    const s = defaultSetup('F1');
    const vs = run('F1', s, kmh(250), 30, { kappa: 1 / 300 });
    expect(vs.ay).toBeCloseTo(vs.v * vs.v / 300, 6);
    expect(vs.rollRad).toBeGreaterThan(0);
    expect(vs.loads.FR).toBeGreaterThan(vs.loads.FL);
    expect(vs.overLimit).toBe(false);
    // Demand far past the tyres ⇒ ay clamps at the limit and the flag trips.
    stepVehicle(vs, { type: 'F1', setup: s, dt: 1 / 60, targetV: kmh(250), kappa: 1 / 20 });
    expect(vs.overLimit).toBe(true);
    expect(Math.abs(vs.ay)).toBeLessThanOrEqual(vs.ayMax + 1e-9);
    // A cap below the target marks the car corner-limited and slows it.
    const v0 = vs.v;
    stepVehicle(vs, { type: 'F1', setup: s, dt: 1 / 60, targetV: kmh(250), kappa: 0, capV: 30 });
    expect(vs.cornerLimited).toBe(true);
    expect(vs.v).toBeLessThan(v0);
  });
  it('observer mode: imposed speed yields inferred accel, loads and pedals', () => {
    const vs = createVehicleState();
    const base = { type: 'F1', setup: defaultSetup('F1'), dt: 0.1, targetV: 0, kappa: 0 };
    stepVehicle(vs, { ...base, forcedV: 60 });
    stepVehicle(vs, { ...base, forcedV: 60 });
    expect(vs.v).toBe(60);
    expect(vs.ax).toBe(0);
    expect(vs.brake).toBe(0);
    stepVehicle(vs, { ...base, forcedV: 57 });           // −30 m/s²
    expect(vs.ax).toBeCloseTo(-30, 6);
    expect(vs.brake).toBe(1);
    expect(vs.loads.FL).toBeGreaterThan(vs.loads.RL);
    stepVehicle(vs, { ...base, forcedV: 58 });
    expect(vs.throttle).toBeGreaterThan(0.5);
    expect(vs.aero.downforce).toBeGreaterThan(0);
  });
  it('dt = 0 (paused) changes nothing but stays finite', () => {
    const vs = run('F1', defaultSetup('F1'), 50, 5);
    const v = vs.v;
    stepVehicle(vs, { type: 'F1', setup: defaultSetup('F1'), dt: 0, targetV: 80, kappa: 0 });
    expect(vs.v).toBe(v);
    expect(vs.ax).toBe(0);
  });
  it('downforce heave is reported in metres and grows with speed', () => {
    const a = run('F1', defaultSetup('F1'), kmh(100), 15).heaveM;
    const b = run('F1', defaultSetup('F1'), kmh(300), 40).heaveM;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(0.04);
  });
});

describe('lookAheadCap', () => {
  it('no corners ⇒ no cap', () => {
    expect(lookAheadCap('F1', defaultSetup('F1'), 80, () => 0)).toBe(Infinity);
  });
  it('a corner under the car caps at ~its limit; one far ahead allows more', () => {
    const s = defaultSetup('F1');
    const lim = cornerSpeedLimit('F1', s, 1 / 85);
    const here = lookAheadCap('F1', s, 80, () => 1 / 85);
    expect(here).toBeLessThanOrEqual(lim);
    expect(here).toBeGreaterThan(lim * 0.9);
    const ahead = lookAheadCap('F1', s, 80, (ds) => (ds >= 100 ? 1 / 85 : 0));
    expect(ahead).toBeGreaterThan(here);
    expect(Number.isFinite(ahead)).toBe(true);
  });
  it('memo cache gives the same answer and is actually used', () => {
    const s = defaultSetup('GT');
    const k = (ds) => (ds >= 40 ? 1 / 60 : 0);
    const cache = new Map();
    const a = lookAheadCap('GT', s, 70, k, false, cache);
    expect(cache.size).toBe(1);
    expect(lookAheadCap('GT', s, 70, k, false, cache)).toBe(a);
    expect(lookAheadCap('GT', s, 70, k)).toBeCloseTo(a, 1);
  });
});
