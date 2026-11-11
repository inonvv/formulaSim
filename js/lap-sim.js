/**
 * lap-sim.js — quasi-steady-state lap-time simulation (pure).
 *
 * The classic three-pass method used for first-order lap simulation:
 *   1. corner limit   v_lim(s): the fastest the tyres + downforce can hold
 *                     the local curvature;
 *   2. forward pass   accelerate from each point as hard as power, traction
 *                     and what is left of the friction circle allow;
 *   3. backward pass  brake as late as the tyres allow into each limit.
 * The lap is periodic, so the passes run twice around to converge the
 * start/finish speed. Gradient adds −g·grade to the longitudinal balance.
 */
import {
  G, cornerSpeedLimit, longAccel, maxLateralAccel, topSpeed,
} from './vehicle-model.js';

const V_MIN = 8;   // m/s floor — keeps Σds/v finite through a hairpin apex

/**
 * @returns {{v:Float64Array, vLim:Float64Array, step:number, length:number,
 *            lapTime:number, vMax:number, vMin:number, vAt:(s:number)=>number}}
 */
export function solveLap(circuit, type, setup, wet = false) {
  const N = circuit.count;
  const ds = circuit.step;
  const vTop = topSpeed(type, setup);
  const vCeil = Math.min(110, vTop);

  // 1 — corner limits (memoised on bucketed |κ|: thousands of points share
  //     a few hundred distinct radii).
  const memo = new Map();
  const vLim = new Float64Array(N);
  const grade = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.abs(circuit.kappa[i]);
    const key = Math.round(k * 4000);
    let vl = memo.get(key);
    if (vl === undefined) {
      vl = key === 0 ? vCeil : Math.min(vCeil, cornerSpeedLimit(type, setup, key / 4000, wet));
      memo.set(key, vl);
    }
    vLim[i] = Math.max(V_MIN, vl);
    grade[i] = circuit.gradeAt(i * ds);
  }

  // Friction-circle share left for longitudinal force at speed v on κ.
  const ayMemo = new Map();
  const ayMax = (v) => {
    const key = Math.round(v);
    let a = ayMemo.get(key);
    if (a === undefined) { a = maxLateralAccel(type, setup, key, wet); ayMemo.set(key, a); }
    return a;
  };
  const longShare = (v, kappa) => {
    const u = Math.min(1, (v * v * Math.abs(kappa)) / Math.max(ayMax(v), 1e-6));
    return Math.sqrt(Math.max(0, 1 - u * u));
  };
  const accMemo = new Map(), brkMemo = new Map();
  const accel = (v) => {
    const key = Math.round(v * 2);
    let a = accMemo.get(key);
    if (a === undefined) { a = longAccel(type, setup, key / 2, 1, 0, wet); accMemo.set(key, a); }
    return a;
  };
  const brake = (v) => {
    const key = Math.round(v * 2);
    let a = brkMemo.get(key);
    if (a === undefined) { a = -longAccel(type, setup, key / 2, 0, 1, wet); brkMemo.set(key, a); }
    return a;
  };

  const v = Float64Array.from(vLim);
  for (let pass = 0; pass < 2; pass++) {
    // 2 — forward (acceleration)
    for (let j = 0; j < N; j++) {
      const i = j, nx = (j + 1) % N;
      const a = accel(v[i]) * longShare(v[i], circuit.kappa[i]) - G * grade[i];
      const vn = Math.sqrt(Math.max(V_MIN * V_MIN, v[i] * v[i] + 2 * a * ds));
      if (vn < v[nx]) v[nx] = Math.max(V_MIN, vn);
    }
    // 3 — backward (braking)
    for (let j = N - 1; j >= 0; j--) {
      const i = j, nx = (j + 1) % N;
      const a = brake(v[nx]) * longShare(v[nx], circuit.kappa[nx]) + G * grade[i];
      const vp = Math.sqrt(Math.max(V_MIN * V_MIN, v[nx] * v[nx] + 2 * Math.max(a, 0.5) * ds));
      if (vp < v[i]) v[i] = vp;
    }
  }

  let lapTime = 0, vMax = 0, vMin = Infinity;
  for (let i = 0; i < N; i++) {
    const a = v[i], b = v[(i + 1) % N];
    lapTime += ds / (0.5 * (a + b));
    if (a > vMax) vMax = a;
    if (a < vMin) vMin = a;
  }

  const length = circuit.length;
  return {
    v, vLim, step: ds, length, lapTime, vMax, vMin,
    vAt(sIn) {
      const f = (((sIn % length) + length) % length) / ds;
      const i = Math.floor(f), t = f - i;
      return v[i % N] * (1 - t) + v[(i + 1) % N] * t;
    },
  };
}

/** 106.3 → "1:46.300" */
export function formatLapTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '–:––.–––';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
