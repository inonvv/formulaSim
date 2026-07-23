/**
 * effect-stub.js — inert stand-in used when an effect constructor throws.
 *
 * main.js swaps AirflowEffect / RainEffect / CfdEffect / VentEmitterSystem
 * for an EffectStub on construction failure so animate() keeps running.
 * The stub must therefore cover the FULL method surface main.js invokes on
 * an effect instance — including the non-optional spawnCar calls
 * (setBodySurface, setModifiers, getModifiers, setFlowCoupling, …) that
 * previously crashed spawnCar when only the 6 original no-ops existed.
 *
 * effect-stub.test.js source-scans main.js and asserts every called method
 * exists here, so a future main.js call on a missing method fails the suite
 * instead of the runtime.
 *
 * Value-returning methods honour the real interfaces:
 *   sampleFlowAt    → zero-velocity vector ({vx,vy,vz} — AirflowEffect shape)
 *   getFlowEnvelope → null (no flow field)
 *   getModifiers    → []   (no feature modifiers)
 *   raycastCp       → null (no overlay to probe)
 */
export class EffectStub {
  setSpeed() {}
  setVisible() {}
  setCarType(_t, _m) {}
  setBaseY() {}
  update() {}
  dispose() {}
  setBodySurface() {}
  setModifiers() {}
  setOccupancy() {}
  setTurnState() {}
  setPathBend() {}
  setFlowCoupling() {}
  sampleFlowAt() { return { vx: 0, vy: 0, vz: 0 }; }
  getFlowEnvelope() { return null; }
  getModifiers() { return []; }
  raycastCp() { return null; }
}
