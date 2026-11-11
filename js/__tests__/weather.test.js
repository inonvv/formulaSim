import { describe, it, expect } from 'vitest';
import { blendWeather, rainLightMix, strikeRate, STORM_FROM, createLightning } from '../weather.js';
import { WEATHER } from '../scene-config.js';
import {
  wetLevel, wetGripFactor, aquaplaneFactor, tireMu, maxLateralAccel, longAccel,
  defaultSetup, createVehicleState, stepVehicle, VEHICLE_PARAMS, G,
} from '../vehicle-model.js';
import { telemetryView } from '../telemetry-hud.js';
import { solveLap } from '../lap-sim.js';
import { buildCircuit } from '../circuit.js';
import { SPA } from '../circuits/spa-data.js';

describe('rain → light', () => {
  it('blendWeather: endpoints and midpoint', () => {
    expect(blendWeather(WEATHER.default, WEATHER.rain, 0)).toEqual(WEATHER.default);
    const full = blendWeather(WEATHER.default, WEATHER.rain, 1);
    expect(full.ambientColor).toBe(WEATHER.rain.ambientColor);
    expect(full.exposure).toBeCloseTo(WEATHER.rain.exposure, 9);
    expect(full.sunIntensity).toBeCloseTo(WEATHER.rain.sunIntensity, 9);
    const m = blendWeather(WEATHER.default, WEATHER.rain, 0.5);
    expect(m.sunIntensity).toBeCloseTo((WEATHER.default.sunIntensity + WEATHER.rain.sunIntensity) / 2, 9);
    expect(blendWeather(WEATHER.default, WEATHER.rain, 9)).toEqual(full);
  });
  it('heavier rain is darker; full intensity is the original rain look', () => {
    expect(rainLightMix(1)).toBe(1);
    expect(rainLightMix(0.2)).toBeLessThan(rainLightMix(0.8));
    expect(rainLightMix(0)).toBeGreaterThan(0.3);
  });
});

describe('lightning', () => {
  it('no strikes below a storm; more as it worsens', () => {
    expect(strikeRate(0.5)).toBe(0);
    expect(strikeRate(STORM_FROM)).toBe(0);
    expect(strikeRate(0.8)).toBeGreaterThan(0);
    expect(strikeRate(1)).toBeGreaterThan(strikeRate(0.8));
    expect(strikeRate(1)).toBeLessThan(0.2);
  });
  it('a strike flashes at once, then thunder arrives later — exactly once', () => {
    let roll = 0;                                   // rng: strike immediately, mid distance
    const L = createLightning(() => (roll++ === 0 ? 0 : 0.5));
    expect(L.step(0.016, 1)).toBe(true);
    expect(L.state.flash).toBeGreaterThan(0.5);
    expect(L.takeThunder()).toBe(false);
    let thunderAt = null, t = 0;
    for (let i = 0; i < 300; i++) {
      t += 0.016;
      // rng now returns 0.5 ⇒ no further strikes
      L.step(0.016, 1);
      if (L.takeThunder()) { expect(thunderAt).toBeNull(); thunderAt = t; }
    }
    expect(thunderAt).toBeGreaterThan(0.3);
    expect(thunderAt).toBeLessThan(2.6);
    expect(L.state.flash).toBe(0);                  // long over
  });
  it('never strikes in light rain, whatever the dice', () => {
    const L = createLightning(() => 0);
    for (let i = 0; i < 500; i++) expect(L.step(0.016, 0.6)).toBe(false);
    expect(L.state.flash).toBe(0);
  });
  it('strikes are spaced at least 1.5 s apart', () => {
    const L = createLightning(() => 0);             // would strike every frame if allowed
    let n = 0;
    for (let i = 0; i < 625; i++) if (L.step(0.016, 1)) n++;   // 10 s
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(7);
  });
});

describe('wet grip + aquaplaning', () => {
  it('wetLevel: boolean and numeric forms', () => {
    expect(wetLevel(false)).toBe(0);
    expect(wetLevel(0)).toBe(0);
    expect(wetLevel(true)).toBe(0.75);
    expect(wetLevel(0.3)).toBe(0.3);
    expect(wetLevel(7)).toBe(1);
    expect(wetLevel(NaN)).toBe(0);
  });
  it('grip falls monotonically with rain, from 1 to about 0.58', () => {
    expect(wetGripFactor(false)).toBe(1);
    let last = 1;
    for (let w = 0.1; w <= 1.001; w += 0.1) { const f = wetGripFactor(w); expect(f).toBeLessThan(last); last = f; }
    expect(wetGripFactor(1)).toBeCloseTo(0.58, 6);
    expect(wetGripFactor(true)).toBeGreaterThan(0.6);
    expect(wetGripFactor(true)).toBeLessThan(0.7);
    const fz = VEHICLE_PARAMS.F1.mass * G / 4;
    expect(tireMu('F1', fz, 0.5)).toBeCloseTo(VEHICLE_PARAMS.F1.mu * wetGripFactor(0.5), 9);
  });
  it('aquaplaning: only in heavy rain, only at speed, worse with more water', () => {
    expect(aquaplaneFactor(100, 0.5)).toBe(1);
    expect(aquaplaneFactor(100, false)).toBe(1);
    expect(aquaplaneFactor(40, 1)).toBe(1);                 // slow: tyres clear the water
    expect(aquaplaneFactor(90, 1)).toBeCloseTo(0.6, 6);     // fast in a downpour
    expect(aquaplaneFactor(70, 1)).toBeLessThan(aquaplaneFactor(70, 0.8));
    for (const v of [0, 50, 80, 120]) for (const w of [0, 0.6, 1]) {
      expect(aquaplaneFactor(v, w)).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(aquaplaneFactor(v, w)).toBeLessThanOrEqual(1);
    }
  });
  it('the model uses it: cornering and braking are weaker when aquaplaning', () => {
    const s = defaultSetup('F1');
    const base = maxLateralAccel('F1', s, 90, 0.5);          // wet, no aquaplaning
    const aq   = maxLateralAccel('F1', s, 90, 1.0);
    expect(aq).toBeLessThan(base * 0.75);
    expect(-longAccel('F1', s, 90, 0, 1, 1.0)).toBeLessThan(-longAccel('F1', s, 90, 0, 1, 0.5));
  });
  it('the flag reaches the telemetry', () => {
    const s = defaultSetup('F1');
    const vs = createVehicleState();
    vs.v = 92;
    stepVehicle(vs, { type: 'F1', setup: s, dt: 0.016, targetV: 92, kappa: 0, wet: 1 });
    expect(vs.aquaplaning).toBe(true);
    expect(telemetryView(vs, 'F1', s).flags).toContain('AQUAPLANING');
    stepVehicle(vs, { type: 'F1', setup: s, dt: 0.016, targetV: 92, kappa: 0, wet: 0.4 });
    expect(vs.aquaplaning).toBe(false);
  });
  it('lap time rises steadily with rain intensity', () => {
    const spa = buildCircuit(SPA);
    const s = defaultSetup('F1');
    const t = [false, 0.2, 0.5, 0.8, 1].map(w => solveLap(spa, 'F1', s, w).lapTime);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    expect(t[1] - t[0]).toBeGreaterThan(3);
    expect(t[4] - t[0]).toBeGreaterThan(20);
  });
});
