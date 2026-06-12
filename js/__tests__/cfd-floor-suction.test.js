/**
 * cfd-floor-suction.test.js — Adversarial test for under-body Cp at speed.
 *
 * Bug: the previous _updatePatchColors implementation sampled topViewVelocity
 * at points that all lay INSIDE the unit circle for floor / diffuser patches.
 * topViewVelocity short-circuits inside the body to (0, 0), so pressureCoeff
 * returns 1.0 (full stagnation). The floor patch therefore registered as red
 * stagnation at max speed instead of the expected deep-blue suction of an
 * F1 underbody pulling several G of downforce.
 *
 * The fix exposes computePatchCp as a pure function (no THREE imports) so we
 * can drive it directly and assert the Cp value, not the downstream colour.
 */

import { describe, it, expect } from 'vitest';
import { computePatchCp, CFD_PATCHES } from '../cfd-effect.js';

const F1_FLOOR    = CFD_PATCHES.F1.find(p => p.role === 'floor');
const F1_DIFFUSER = CFD_PATCHES.F1.find(p => p.role === 'diffuser');
const F1_NOSE     = CFD_PATCHES.F1.find(p => p.role === 'nose');

describe('CFD underbody Cp at max speed — physical sanity', () => {
  it('Bug 2.t1. F1 floor patch centre Cp is deep suction at max speed (Cp < -0.5)', () => {
    // Floor patch is 3.80m × 1.44m; centre vertex is (lx=0, ly=0).
    // At speedFactor=1.0 the underbody should pull hard — real F1 floor Cp
    // approaches -3 in the venturi throat. Anything less negative than -0.5
    // means the formula is still in the stagnation trap.
    const cp = computePatchCp(F1_FLOOR, 0, 0, 1.0);
    expect(cp).toBeLessThan(-0.5);
  });

  it('Bug 2.t2. F1 floor outer-edge Cp is also negative (not just the centre)', () => {
    // Sample near the lateral edge of the floor: lx = w/2 - 0.1
    const lx = F1_FLOOR.w / 2 - 0.1;
    const cp = computePatchCp(F1_FLOOR, lx, 0, 1.0);
    expect(cp).toBeLessThan(-0.2);
  });

  it('Bug 2.t3. F1 diffuser Cp is also deeply negative at max speed', () => {
    const cp = computePatchCp(F1_DIFFUSER, 0, 0, 1.0);
    expect(cp).toBeLessThan(-0.5);
  });

  it('Bug 2.t4. F1 nose patch stays positive (stagnation, this side is unchanged)', () => {
    // Sanity guard: the fix must only affect under-body sampling, NOT flip
    // the sign on nose stagnation which is supposed to read red.
    const cp = computePatchCp(F1_NOSE, 0, 0, 1.0);
    expect(cp).toBeGreaterThan(0.4);
  });

  it('Bug 2.t5. floor Cp deepens further as speed rises (ground-effect scaling)', () => {
    const cpHalf = computePatchCp(F1_FLOOR, 0, 0, 0.5);
    const cpMax  = computePatchCp(F1_FLOOR, 0, 0, 1.0);
    expect(cpMax).toBeLessThan(cpHalf);   // more suction at higher speed
  });

  it('Bug 2.t6. floor Cp at zero speed reduces to the static bias (~-0.75), not exploding', () => {
    // At speedFactor=0 the velocity-derived terms scale out; only the
    // role-specific static bias remains. CFD patches fade to invisible at
    // low speed (material.opacity = speedFactor * 0.68) so the raw Cp value
    // doesn't render — but it must be bounded.
    const cp = computePatchCp(F1_FLOOR, 0, 0, 0.0);
    expect(cp).toBeCloseTo(-0.75, 2);
  });
});

describe('CFD GT underbody also reads as suction (Bug 2 also fixes GT)', () => {
  it('Bug 2.t7. GT floor patch centre Cp is negative at max speed', () => {
    const GT_FLOOR = CFD_PATCHES.GT.find(p => p.role === 'floor');
    const cp = computePatchCp(GT_FLOOR, 0, 0, 1.0);
    expect(cp).toBeLessThan(-0.1);   // GT floor isn't a venturi, but still net negative
  });
});
