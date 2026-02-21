/**
 * scene-clarity.test.js
 *
 * Test-driven specification for a fog-free, bright outdoor scene.
 * Every assertion here defines what "clear sky, no fog" means in code.
 * If any test fails, the scene will look dark or foggy in the browser.
 */

import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_COLOR,
  AMBIENT_INTENSITY,
  SUN_INTENSITY,
  EXPOSURE,
  SKY,
  BLOOM,
  WEATHER,
} from '../scene-config.js';

/* ── Helper: decode a 0xRRGGBB int to [0,1] channels ── */
function hex(n) {
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >>  8) & 0xff) / 255,
    b: ( n        & 0xff) / 255,
  };
}

/* ════════════════════════════════════════════════════════════════
   BACKGROUND — must be bright, never dark
════════════════════════════════════════════════════════════════ */
describe('Background / clear colour — no black canvas', () => {
  it('BACKGROUND_COLOR blue channel > 0.5 (sky blue)', () => {
    expect(hex(BACKGROUND_COLOR).b).toBeGreaterThan(0.5);
  });
  it('BACKGROUND_COLOR perceived luminance > 0.3 (not dark)', () => {
    const { r, g, b } = hex(BACKGROUND_COLOR);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(lum).toBeGreaterThan(0.3);
  });
});

/* ════════════════════════════════════════════════════════════════
   LIGHTING — bright midday sun
════════════════════════════════════════════════════════════════ */
describe('Ambient light — bright sky-fill', () => {
  it('AMBIENT_INTENSITY > 2.0 (no dark ambient)', () => {
    expect(AMBIENT_INTENSITY).toBeGreaterThan(2.0);
  });
});

describe('Sun light — strong direct light', () => {
  it('SUN_INTENSITY > 3.0', () => {
    expect(SUN_INTENSITY).toBeGreaterThan(3.0);
  });
});

describe('Tone-mapping exposure — outdoor brightness', () => {
  it('EXPOSURE >= 1.3', () => {
    expect(EXPOSURE).toBeGreaterThanOrEqual(1.3);
  });
});

/* ════════════════════════════════════════════════════════════════
   SKY SHADER — crystal-clear atmosphere
════════════════════════════════════════════════════════════════ */
describe('Sky shader — clear atmosphere (no haze)', () => {
  it('turbidity < 3  (clear sky, not industrial haze)', () => {
    expect(SKY.turbidity).toBeLessThan(3);
  });
  it('mieCoefficient < 0.003  (negligible aerosol scattering)', () => {
    expect(SKY.mieCoefficient).toBeLessThan(0.003);
  });
  it('rayleigh >= 1.5  (vivid blue sky)', () => {
    expect(SKY.rayleigh).toBeGreaterThanOrEqual(1.5);
  });
  it('sky scale < 100000  (within camera far plane)', () => {
    expect(SKY.scale).toBeLessThan(100000);
  });
});

/* ════════════════════════════════════════════════════════════════
   BLOOM — selective: only emissive surfaces glow, NOT the sky
   The key anti-fog rule: threshold > 0.7 prevents the bright sky
   (luminance ≈ 0.53) from triggering bloom and spreading white haze.
════════════════════════════════════════════════════════════════ */
describe('Bloom — selective (not scene-wide)', () => {
  it('threshold > 0.7  (sky luminance ~0.53 must NOT bloom)', () => {
    expect(BLOOM.threshold).toBeGreaterThan(0.7);
  });
  it('radius < 0.25  (tight spread, no diffuse fog)', () => {
    expect(BLOOM.radius).toBeLessThan(0.25);
  });
  it('strength < 0.5  (subtle glow, not washed-out)', () => {
    expect(BLOOM.strength).toBeLessThan(0.5);
  });
  it('sky blue 0x87ceeb luminance (0.531) is BELOW bloom threshold', () => {
    const { r, g, b } = hex(BACKGROUND_COLOR);
    const skyLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(skyLum).toBeLessThan(BLOOM.threshold);
  });
});

/* ════════════════════════════════════════════════════════════════
   WEATHER overrides — rain dims, optimal brightens, default is sunny
════════════════════════════════════════════════════════════════ */
describe('Weather lighting overrides', () => {
  it('default weather exposure >= 1.3', () => {
    expect(WEATHER.default.exposure).toBeGreaterThanOrEqual(1.3);
  });
  it('default weather sun intensity > 3', () => {
    expect(WEATHER.default.sunIntensity).toBeGreaterThan(3);
  });
  it('optimal weather sun intensity > default', () => {
    expect(WEATHER.optimal.sunIntensity).toBeGreaterThan(WEATHER.default.sunIntensity);
  });
  it('rain weather dims compared to default', () => {
    expect(WEATHER.rain.sunIntensity).toBeLessThan(WEATHER.default.sunIntensity);
    expect(WEATHER.rain.exposure).toBeLessThan(WEATHER.default.exposure);
  });
});
