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
import {
  computePatchCp, CFD_PATCHES, getRoleCp, lerpCpProfile,
  resolveVortexCores, ZONE_BLOBS, STREAMLINE_DEFS,
} from '../cfd-effect.js';

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

/* ── f2-f3-cars P4: per-car CFD identity ─────────────────────────── */
describe('F2/F3 CFD identity (P4)', () => {
  it('P4.1 FLOOR SUCTION ORDERING (hard requirement): F1 < F2 < F3 < 0 at sf 1', () => {
    const cp = {};
    for (const t of ['F1', 'F2', 'F3']) {
      const fl = CFD_PATCHES[t].find(p => p.role === 'floor');
      cp[t] = computePatchCp(fl, 0, 0, 1.0, [], [], t);
    }
    expect(cp.F1).toBeLessThan(cp.F2);
    expect(cp.F2).toBeLessThan(cp.F3);
    expect(cp.F3).toBeLessThan(0);
  });

  it('P4.2 WING/FLOOR DOMINANCE RATIO (hard requirement): |frontWing.bias / floor.bias| strictly increasing F1 → F2 → F3', () => {
    const ratio = t => Math.abs(getRoleCp(t, 'frontWing').bias / getRoleCp(t, 'floor').bias);
    expect(ratio('F2')).toBeGreaterThan(ratio('F1'));
    expect(ratio('F3')).toBeGreaterThan(ratio('F2'));
  });

  it('P4.3 CP_TABLES knots are the plan-authored values (verbatim)', () => {
    expect(lerpCpProfile(-2.15, 'F2', 'top')).toBeCloseTo(-1.40, 5);
    expect(lerpCpProfile( 1.80, 'F2', 'top')).toBeCloseTo(-1.00, 5);
    expect(lerpCpProfile( 1.55, 'F2', 'under')).toBeCloseTo(-0.85, 5);
    expect(lerpCpProfile( 0.00, 'F2', 'under')).toBeCloseTo(-0.40, 5);  // flat-floor plateau
    expect(lerpCpProfile(-1.95, 'F3', 'top')).toBeCloseTo(-1.15, 5);
    expect(lerpCpProfile( 1.68, 'F3', 'top')).toBeCloseTo(-0.90, 5);
    expect(lerpCpProfile( 1.45, 'F3', 'under')).toBeCloseTo(-0.60, 5);
  });

  it('P4.4 under-table suction peak sits inside each diffuser footprint (diffuser-peaked floors)', () => {
    // NOTE (plan deviation, reported): §4 asked for peak z within ±0.10 of
    // the diffuser ANCHOR, but the §2-verbatim tables peak at 1.55/1.45 vs
    // anchors 1.80/1.68 (the physical suction peak is at the diffuser inlet,
    // fore of the geometric centre). §2 numbers are the user-mandated
    // contract, so the assertion is peak-inside-diffuser-footprint.
    const argmin = (t, z0, z1) => {
      let bz = z0, bc = Infinity;
      for (let z = z0; z <= z1; z += 0.01) {
        const c = lerpCpProfile(z, t, 'under');
        if (c < bc) { bc = c; bz = z; }
      }
      return bz;
    };
    const f2 = argmin('F2', -2.30, 2.10);
    const f3 = argmin('F3', -2.10, 1.95);
    expect(f2).toBeCloseTo(1.55, 2);
    expect(f3).toBeCloseTo(1.45, 2);
    // Diffuser footprints: F2 box depth 0.88 centred 1.80 → [1.36, 2.24];
    // F3 depth 0.76 centred 1.68 → [1.30, 2.06].
    expect(f2).toBeGreaterThanOrEqual(1.36);
    expect(f2).toBeLessThanOrEqual(2.24);
    expect(f3).toBeGreaterThanOrEqual(1.30);
    expect(f3).toBeLessThanOrEqual(2.06);
  });

  it('P4.5 zero F1 fallback: every role used by F2/F3 patches has its own ROLE_CP entry', () => {
    for (const t of ['F2', 'F3']) {
      for (const p of CFD_PATCHES[t]) {
        const own = getRoleCp(t, p.role);
        const f1  = getRoleCp('F1', p.role);
        // A silent fallback returns the F1 entry OBJECT itself (getRoleCp:
        // `table[role] || ROLE_CP.F1[role]`). Reference inequality proves the
        // role has its own authored entry even where a value coincides (F2
        // nose bias +0.55 equals F1's by design).
        expect(own).not.toBe(f1);
      }
    }
  });

  it('P4.6 vortex cores: 6 per car (fw pair, sidepod pair, diffuser pair); anchor snap intact', () => {
    for (const t of ['F2', 'F3']) {
      const cores = resolveVortexCores(t, null);
      expect(cores.length).toBe(6);
      expect(cores.filter(c => c.role === 'frontWing').length).toBe(2);
      expect(cores.filter(c => c.role === 'sidepodTop').length).toBe(2);
      expect(cores.filter(c => c.role === 'diffuser').length).toBe(2);
    }
    const snapped = resolveVortexCores('F2', { frontWing: { z: -2.36 } });
    for (const c of snapped.filter(c => c.role === 'frontWing')) {
      expect(c.z).toBeCloseTo(-2.36, 5);
    }
  });

  it('P4.7 patches anchored to each car geometry (fw/rw/diffuser cz) with F1 > F2 > F3 spans', () => {
    const first = (t, role) => CFD_PATCHES[t].find(p => p.role === role);
    expect(first('F2', 'frontWing').cz).toBeCloseTo(-2.48, 2);
    expect(first('F2', 'rearWing').cz).toBeCloseTo( 1.80, 2);
    expect(first('F2', 'diffuser').cz).toBeCloseTo( 1.80, 2);
    expect(first('F3', 'frontWing').cz).toBeCloseTo(-2.24, 2);
    expect(first('F3', 'rearWing').cz).toBeCloseTo( 1.68, 2);
    expect(first('F3', 'diffuser').cz).toBeCloseTo( 1.68, 2);
    for (const role of ['frontWing', 'rearWing', 'floor']) {
      expect(first('F1', role).w).toBeGreaterThan(first('F2', role).w);
      expect(first('F2', role).w).toBeGreaterThan(first('F3', role).w);
    }
  });

  it('P4.8 blob minimum set + streamline lane counts (F2 8 lanes, F3 6 lanes)', () => {
    for (const t of ['F2', 'F3']) {
      const roles = new Set(ZONE_BLOBS[t].map(b => b.role));
      for (const r of ['stagnation', 'fwTipL', 'fwTipR', 'sidepodInlet', 'diffuser', 'rearWing', 'cockpit']) {
        expect(roles.has(r)).toBe(true);
      }
    }
    expect(STREAMLINE_DEFS.F2.length).toBe(8);
    expect(STREAMLINE_DEFS.F3.length).toBe(6);
  });
});
