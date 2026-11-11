/**
 * circuit.js — a closed racing circuit as pure functions of lap distance.
 *
 * buildCircuit() turns a centreline polyline into a uniform arc-length
 * table and answers, for any lap distance s (periodic, any sign):
 *   kappaAt(s)      signed curvature [1/m], + = LEFT (track-path.js convention)
 *   elevationAt(s)  height [m] relative to the start line
 *   gradeAt(s)      slope dh/ds (+ = uphill)
 *   cornerAt(s)     name of the section the car is in, or ''
 *   xyAt(s)         centreline position in the source data frame (minimap)
 * No THREE / DOM — unit-tested in circuit.test.js.
 */

const TAU = Math.PI * 2;
const wrapAngle = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;

/**
 * @param {object} def
 *   points    — flat [x0,y0,x1,y1,…] closed centreline in metres (last point
 *               connects back to the first)
 *   elevation — [[s, h], …] control points, s ascending within one lap
 *   corners   — [{name, from, to}] in lap metres
 * @param {number} ds — output table spacing [m]
 */
export function buildCircuit(def, ds = 5) {
  const src = def.points;
  const n = src.length / 2;
  const px = (i) => src[2 * (((i % n) + n) % n)];
  const py = (i) => src[2 * (((i % n) + n) % n) + 1];

  // Cumulative arc length of the source polyline (closed).
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + Math.hypot(px(i + 1) - px(i), py(i + 1) - py(i));
  const length = cum[n];

  // Uniform resample.
  const N = Math.round(length / ds);
  const step = length / N;
  const x = new Float64Array(N), y = new Float64Array(N);
  let seg = 0;
  for (let i = 0; i < N; i++) {
    const s = i * step;
    while (seg < n - 1 && cum[seg + 1] < s) seg++;
    const t = (s - cum[seg]) / Math.max(cum[seg + 1] - cum[seg], 1e-9);
    x[i] = px(seg) + (px(seg + 1) - px(seg)) * t;
    y[i] = py(seg) + (py(seg + 1) - py(seg)) * t;
  }

  // Optional racing line: slide each point across the track (within the
  // usable half-width) to minimise curvature, then re-parameterise.
  let lineOffset = null;
  if (def.racingLine !== false && def.widthM) {
    const half = Math.max(0, def.widthM / 2 - (def.edgeMarginM ?? 1.3));
    const rl = minCurvatureLine(x, y, half);
    lineOffset = rl.offset;
    for (let i = 0; i < N; i++) { x[i] = rl.x[i]; y[i] = rl.y[i]; }
  }

  // Curvature = heading change per metre over a ±2-sample chord, then a
  // short binomial smooth — survey noise must not become phantom corners.
  const at = (a, i) => a[((i % N) + N) % N];
  const raw = new Float64Array(N);
  const W = 2;
  for (let i = 0; i < N; i++) {
    const h1 = Math.atan2(at(y, i) - at(y, i - W), at(x, i) - at(x, i - W));
    const h2 = Math.atan2(at(y, i + W) - at(y, i), at(x, i + W) - at(x, i));
    raw[i] = wrapAngle(h2 - h1) / (W * step);
  }
  const kappa = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    kappa[i] = (at(raw, i - 2) + 4 * at(raw, i - 1) + 6 * raw[i] + 4 * at(raw, i + 1) + at(raw, i + 2)) / 16;
  }

  // Elevation: periodic cosine interpolation between control points
  // (C¹ at the knots — zero slope there — so crests and dips are smooth).
  const ctrl = (def.elevation && def.elevation.length) ? def.elevation : [[0, 0]];
  const elevationAt = (sIn) => {
    const s = ((sIn % length) + length) % length;
    let i = ctrl.length - 1;
    for (let k = 0; k < ctrl.length; k++) { if (ctrl[k][0] > s) { i = k - 1; break; } }
    const a = ctrl[(i + ctrl.length) % ctrl.length];
    const b = ctrl[(i + 1) % ctrl.length];
    let sa = a[0], sb = b[0];
    if (i < 0) sa -= length;                 // wrapped segment before the first knot
    if (i === ctrl.length - 1) sb += length; // wrapped segment after the last knot
    const t = sb > sa ? (s - sa) / (sb - sa) : 0;
    return a[1] + (b[1] - a[1]) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2;
  };

  const lerpTable = (table, sIn) => {
    const f = (((sIn % length) + length) % length) / step;
    const i = Math.floor(f);
    const t = f - i;
    return table[i % N] * (1 - t) + table[(i + 1) % N] * t;
  };

  const corners = def.corners || [];
  return {
    id: def.id, name: def.name, length, step, count: N, widthM: def.widthM ?? 12,
    x, y, kappa, corners, lineOffset,
    wrap: (s) => ((s % length) + length) % length,
    kappaAt: (s) => lerpTable(kappa, s),
    xyAt: (s) => ({ x: lerpTable(x, s), y: lerpTable(y, s) }),
    elevationAt,
    gradeAt: (s) => (elevationAt(s + 2.5) - elevationAt(s - 2.5)) / 5,
    cornerAt: (sIn) => {
      const s = ((sIn % length) + length) % length;
      for (const c of corners) if (s >= c.from && s < c.to) return c.name;
      return '';
    },
  };
}

/**
 * Minimum-curvature line inside a corridor of ±half metres around a closed
 * centreline — the geometric racing line (wide in, clip the apex, wide out).
 *
 * Each point may only slide along its centreline normal. Gradient descent
 * on Σ|p[i−1] − 2p[i] + p[i+1]|² (discrete bending energy), solved on a
 * coarse grid first (long corners need long-wavelength moves, which
 * converge ∝ spacing⁴) and refined on the full grid. Deterministic.
 * @returns {{x:Float64Array, y:Float64Array, offset:Float64Array}} offset
 *          is the signed slide in metres (+ = left of travel).
 */
export function minCurvatureLine(cx, cy, half, opts = {}) {
  const N = cx.length;
  const offset = new Float64Array(N);
  if (!(half > 0) || N < 8) return { x: Float64Array.from(cx), y: Float64Array.from(cy), offset };
  // Left normals of the centreline.
  const nx = new Float64Array(N), ny = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    const tx = cx[b] - cx[a], ty = cy[b] - cy[a];
    const l = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / l; ny[i] = tx / l;
  }
  const relax = (stride, iters) => {
    const idx = [];
    for (let i = 0; i < N; i += stride) idx.push(i);
    const M = idx.length;
    const px = new Float64Array(M), py = new Float64Array(M);
    const d2x = new Float64Array(M), d2y = new Float64Array(M);
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < M; k++) { const i = idx[k]; px[k] = cx[i] + nx[i] * offset[i]; py[k] = cy[i] + ny[i] * offset[i]; }
      for (let k = 0; k < M; k++) {
        const a = (k - 1 + M) % M, b = (k + 1) % M;
        d2x[k] = px[a] - 2 * px[k] + px[b];
        d2y[k] = py[a] - 2 * py[k] + py[b];
      }
      for (let k = 0; k < M; k++) {
        const a = (k - 1 + M) % M, b = (k + 1) % M, i = idx[k];
        const gx = d2x[a] - 2 * d2x[k] + d2x[b];
        const gy = d2y[a] - 2 * d2y[k] + d2y[b];
        const o = offset[i] - 0.06 * (gx * nx[i] + gy * ny[i]);
        offset[i] = o > half ? half : (o < -half ? -half : o);
      }
    }
    // Fill the skipped points by linear interpolation of the offset.
    if (stride > 1) {
      for (let k = 0; k < M; k++) {
        const i0 = idx[k], i1 = idx[(k + 1) % M];
        const span = ((i1 - i0) + N) % N || N;
        for (let j = 1; j < span; j++) {
          offset[(i0 + j) % N] = offset[i0] + (offset[i1] - offset[i0]) * (j / span);
        }
      }
    }
  };
  relax(8, opts.coarseIters ?? 1500);
  relax(4, opts.midIters ?? 1500);
  relax(2, opts.fineIters ?? 800);
  relax(1, opts.finalIters ?? 200);
  const x = new Float64Array(N), y = new Float64Array(N);
  for (let i = 0; i < N; i++) { x[i] = cx[i] + nx[i] * offset[i]; y[i] = cy[i] + ny[i] * offset[i]; }
  return { x, y, offset };
}

/** Bounding box of the centreline (minimap fitting). */
export function circuitBounds(c) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < c.count; i++) {
    if (c.x[i] < minX) minX = c.x[i]; if (c.x[i] > maxX) maxX = c.x[i];
    if (c.y[i] < minY) minY = c.y[i]; if (c.y[i] > maxY) maxY = c.y[i];
  }
  return { minX, maxX, minY, maxY };
}
