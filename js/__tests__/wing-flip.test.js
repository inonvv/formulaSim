import { describe, it, expect } from 'vitest';
import { applyWingStall } from '../airflow-core.js';

/* ── Sample profile used across all tests ─────────────────────────── */
const BASE_PROFILE = {
  pressureBlobs: [
    // Front wing stagnation (z < 0)
    { color: 0xff2200, r: 0.40, intensity: 1.00, pos: [0, 0.12, -2.50] },
    // Rear wing high pressure (z > 1)
    { color: 0xff2200, r: 0.36, intensity: 0.70, pos: [0, 0.88,  1.85] },
    { color: 0x2266ff, r: 0.55, intensity: 0.95, pos: [0, 0.75,  1.85] },
  ],
  vortexDefs: [
    { wx: -0.82, wy: 0.02, wz: -2.60, sign:  1, gamma: 0.6, rc: 0.12 },
    { wx:  0.82, wy: 0.02, wz: -2.60, sign: -1, gamma: 0.6, rc: 0.12 },
    // rear tip vortices (z > 1)
    { wx: -0.90, wy: 0.85, wz:  1.85, sign: -1, gamma: 1.0, rc: 0.18 },
    { wx:  0.90, wy: 0.85, wz:  1.85, sign:  1, gamma: 1.0, rc: 0.18 },
  ],
  wakeCount:  220,
  wakeWidthX: 1.0,
};

describe('applyWingStall', () => {
  it('returns the original profile unchanged when isStalled=false', () => {
    const result = applyWingStall(BASE_PROFILE, false);
    expect(result).toBe(BASE_PROFILE);
  });

  it('rear-wing blobs have lower intensity than original when stalled', () => {
    const result = applyWingStall(BASE_PROFILE);
    // Rear wing blobs are those with pos[2] > 1.5
    const originalRearIntensity = BASE_PROFILE.pressureBlobs
      .filter(b => b.pos[2] > 1.5)
      .reduce((sum, b) => sum + b.intensity, 0);
    const stalledRearIntensity = result.pressureBlobs
      .filter(b => b.pos[2] > 1.5 && b.color !== 0x888888)
      .reduce((sum, b) => sum + b.intensity, 0);
    expect(stalledRearIntensity).toBeLessThan(originalRearIntensity);
  });

  it('fewer rear vortex defs when stalled (rear tip vortices removed)', () => {
    const result = applyWingStall(BASE_PROFILE);
    const originalRearVortices = BASE_PROFILE.vortexDefs.filter(d => d.wz > 1.5).length;
    const stalledRearVortices  = result.vortexDefs.filter(d => d.wz > 1.5).length;
    expect(stalledRearVortices).toBeLessThan(originalRearVortices);
  });

  it('does not mutate the original profile', () => {
    const original = JSON.stringify(BASE_PROFILE);
    applyWingStall(BASE_PROFILE);
    expect(JSON.stringify(BASE_PROFILE)).toBe(original);
  });

  it('stalled profile has increased wake count', () => {
    const result = applyWingStall(BASE_PROFILE);
    expect(result.wakeCount).toBeGreaterThan(BASE_PROFILE.wakeCount);
  });

  it('stalled profile has increased wake width', () => {
    const result = applyWingStall(BASE_PROFILE);
    expect(result.wakeWidthX).toBeGreaterThan(BASE_PROFILE.wakeWidthX);
  });
});
