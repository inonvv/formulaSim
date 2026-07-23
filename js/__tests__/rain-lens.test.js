/**
 * rain-lens.test.js
 *
 * Cockpit rain-on-lens post pass. Pure-math coverage:
 *   • rainLensIntensity — one-pole ramp (tau 0.4 s), monotonic, composable
 *   • lensActive — enabled ONLY in cockpit view with rain env on
 *   • RainLensShader — ShaderPass-compatible shape, procedural GLSL that
 *     samples tDiffuse and reacts to uSpeed (visor streak smear)
 */

import { describe, it, expect } from 'vitest';
import { RainLensShader, rainLensIntensity, lensActive } from '../rain-lens.js';

describe('rainLensIntensity — one-pole ramp, tau 0.4 s', () => {
  it('reaches ~63% after one tau (0.4 s) from 0', () => {
    const v = rainLensIntensity(0, true, 0.4);
    expect(v).toBeCloseTo(1 - Math.exp(-1), 3);   // ≈ 0.632
  });

  it('is monotonic increasing while active, bounded by 1', () => {
    let v = 0;
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      v = rainLensIntensity(v, true, 0.05);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(v).toBeGreaterThan(0.99);   // 5 s ≫ tau
  });

  it('decays toward 0 when inactive (no pop on toggle-off)', () => {
    let v = 1;
    v = rainLensIntensity(v, false, 0.4);
    expect(v).toBeCloseTo(Math.exp(-1), 3);        // ≈ 0.368
    for (let i = 0; i < 100; i++) v = rainLensIntensity(v, false, 0.05);
    expect(v).toBeLessThan(0.01);
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it('is dt-composable: two half-steps equal one full step', () => {
    const one  = rainLensIntensity(0.2, true, 0.3);
    const half = rainLensIntensity(rainLensIntensity(0.2, true, 0.15), true, 0.15);
    expect(half).toBeCloseTo(one, 10);
  });

  it('dt = 0 is the identity', () => {
    expect(rainLensIntensity(0.37, true, 0)).toBeCloseTo(0.37, 12);
    expect(rainLensIntensity(0.37, false, 0)).toBeCloseTo(0.37, 12);
  });
});

describe('lensActive — cockpit × rain gating truth table', () => {
  const rain   = new Set(['rain']);
  const noRain = new Set(['airflow', 'cfd']);
  it('cockpit + rain → true',    () => expect(lensActive('cockpit', rain)).toBe(true));
  it('cockpit, no rain → false', () => expect(lensActive('cockpit', noRain)).toBe(false));
  it('orbit + rain → false',     () => expect(lensActive('orbit', rain)).toBe(false));
  it('orbit, no rain → false',   () => expect(lensActive('orbit', noRain)).toBe(false));
  it('trackside/drone + rain → false', () => {
    expect(lensActive('trackside', rain)).toBe(false);
    expect(lensActive('drone', rain)).toBe(false);
  });
});

describe('RainLensShader — ShaderPass-compatible procedural shader', () => {
  it('carries every required uniform', () => {
    for (const u of ['tDiffuse', 'uTime', 'uIntensity', 'uSpeed', 'uAspect']) {
      expect(RainLensShader.uniforms[u], `uniform ${u}`).toBeDefined();
      expect(RainLensShader.uniforms[u]).toHaveProperty('value');
    }
  });

  it('starts disabled-safe: uIntensity 0, tDiffuse null', () => {
    expect(RainLensShader.uniforms.uIntensity.value).toBe(0);
    expect(RainLensShader.uniforms.tDiffuse.value).toBeNull();
  });

  it('fragment samples the composed frame through tDiffuse', () => {
    expect(RainLensShader.fragmentShader).toContain('texture2D( tDiffuse');
  });

  it('fragment uses uSpeed (streak slide direction / length) and uTime', () => {
    expect(RainLensShader.fragmentShader).toContain('uSpeed');
    expect(RainLensShader.fragmentShader).toContain('uTime');
  });

  it('is fully procedural — no texture uniforms besides tDiffuse', () => {
    const samplers = Object.keys(RainLensShader.uniforms)
      .filter(k => RainLensShader.uniforms[k].value === null || k === 'tDiffuse');
    expect(samplers).toEqual(['tDiffuse']);
  });

  it('vertex shader passes vUv through', () => {
    expect(RainLensShader.vertexShader).toContain('vUv');
  });
});
