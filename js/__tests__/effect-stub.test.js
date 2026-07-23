/**
 * effect-stub.test.js — EffectStub interface completeness.
 *
 * main.js swaps a failed effect constructor for an EffectStub so animate()
 * keeps running. The old inline stub only carried 6 methods; spawnCar calls
 * several more WITHOUT optional chaining (cfd.setBodySurface, cfd.setModifiers,
 * airflow.getModifiers, rain.setFlowCoupling, …) — a stubbed effect crashed
 * spawnCar at runtime.
 *
 * Two nets:
 *   ES1 — drift-proof source scan: every method main.js invokes on an effect
 *         instance (non-comment lines) must exist on EffectStub.prototype.
 *         A future main.js call on a missing stub method fails this suite
 *         instead of crashing spawnCar in the field.
 *   ES2 — direct: the literal spawnCar / syncEffects / animate call sequence
 *         runs against four stubs without throwing, and the value-returning
 *         methods honour their contracts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EffectStub } from '../effect-stub.js';

const MAIN_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');

/** Every `airflow.m(` / `rain.m(` / `cfd.m(` / `vents.m(` call in main.js
 *  (optional `?.(` calls too — the stub should cover the full surface),
 *  skipping comment lines. Over-matching is harmless: the stub just needs
 *  a no-op for anything matched. */
function scanEffectCalls(src) {
  const methods = new Set();
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const m of line.matchAll(/\b(?:airflow|rain|cfd|vents)\.([A-Za-z_$][\w$]*)\s*(?:\?\.)?\(/g)) {
      methods.add(m[1]);
    }
  }
  return [...methods];
}

describe('EffectStub — drift-proof source scan (ES1)', () => {
  const called = scanEffectCalls(MAIN_SRC);

  it('ES1a. the scan finds the known spawnCar surface (sanity: regex not dead)', () => {
    for (const known of ['setCarType', 'setBodySurface', 'setModifiers', 'getModifiers',
                         'setFlowCoupling', 'sampleFlowAt', 'getFlowEnvelope',
                         'setSpeed', 'setVisible', 'setBaseY', 'update']) {
      expect(called, `main.js should call ${known}`).toContain(known);
    }
  });

  it('ES1b. every effect method main.js calls exists on EffectStub.prototype', () => {
    for (const m of called) {
      expect(typeof EffectStub.prototype[m], `EffectStub is missing .${m}()`)
        .toBe('function');
    }
  });
});

describe('EffectStub — direct spawnCar call sequence (ES2)', () => {
  it('ES2a. the literal spawnCar + syncEffects + animate sequence does not throw', () => {
    const airflow = new EffectStub();
    const rain    = new EffectStub();
    const cfd     = new EffectStub();
    const vents   = new EffectStub();
    const measure = { anchors: {}, groundContactY: 0, wheelRadius: 0.33 };

    expect(() => {
      // spawnCar body (main.js) — non-optional calls first
      airflow.setCarType('F1', measure, null);
      cfd.setBodySurface([], { updateMatrixWorld() {} });
      cfd.setCarType('F1', measure);
      cfd.setModifiers(airflow.getModifiers());
      rain.setCarType('F1', measure);
      vents.setCarType('F1', measure);
      airflow.setBaseY(0.4);
      cfd.setBaseY(0.4);
      vents.setBaseY(0.4);
      // deferred rAF body
      airflow.setCarType('F1', measure, { sample: () => 0 });
      cfd.setOccupancy?.({ sample: () => 0 }, 0.4);
      // wireRainCoupling — both-envs branch (typeof guards pass on the stub)
      const env = airflow.getFlowEnvelope();
      rain.setFlowCoupling((x, y, z) => airflow.sampleFlowAt(x, y - 0.4, z), null,
                           env ? { ...env, topY: env.topY + 0.4 } : null);
      rain.setFlowCoupling?.(null, null, null);
      // syncEffects
      airflow.setSpeed(120); rain.setSpeed(120); cfd.setSpeed(120); vents.setSpeed(120);
      airflow.setVisible(true); rain.setVisible(false); cfd.setVisible(true);
      vents.setVisible(true);
      // probe + animate loop
      cfd.raycastCp?.({ intersectObjects: () => [] });
      airflow.setPathBend?.([]);
      airflow.setTurnState?.(0, 0);
      rain.setTurnState?.(0, 0);
      airflow.update(0.016, 1); rain.update(0.016, 1);
      cfd.update(0.016, 1);     vents.update(0.016);
      airflow.dispose(); rain.dispose(); cfd.dispose(); vents.dispose();
    }).not.toThrow();
  });

  it('ES2b. value-returning stubs honour their contracts', () => {
    const stub = new EffectStub();
    expect(stub.getModifiers()).toEqual([]);
    expect(stub.getFlowEnvelope()).toBeNull();
    expect(stub.raycastCp({})).toBeNull();
    const v = stub.sampleFlowAt(1, 2, 3);
    // Zero-velocity vector in the real AirflowEffect.sampleFlowAt shape.
    expect(v.vx).toBe(0);
    expect(v.vy).toBe(0);
    expect(v.vz).toBe(0);
  });
});
