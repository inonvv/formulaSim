/**
 * wake-paths.js — where the car's disturbed ("dirty") air goes (pure).
 *
 * These are MODELLED pathlines, not a solved flow: each stream is a short
 * list of control points placed from the car's measured geometry (axles,
 * wheel radius, wings, sidepod inlets) following the well-documented
 * structure of an open-wheel car's wake:
 *
 *   frontWingTip   the front-wing tip vortex is thrown OUTBOARD (outwash)
 *                  around the outside of the front tyre and runs down the
 *                  flank of the car
 *   frontTyreWake  the slow, turbulent air shed by the rotating front tyre;
 *                  pushed outboard along the floor edge, then drawn back in
 *                  at the "coke-bottle" waist ahead of the rear tyre and up
 *                  into the rear wake
 *   sidepodFlow    air between the front tyre and the chassis is taken into
 *                  the sidepod inlet, leaves over the engine cover and feeds
 *                  the underside of the rear wing, which throws it upward
 *   rearTyreWake   the rear tyre's own wake, pulled inboard and up by the
 *                  diffuser
 *   diffuser       the underfloor air expanding out of the diffuser — the
 *                  rising core of the "mushroom"
 *   rearWingTip    the rear-wing tip vortices, trailing up and out
 *
 * Every point carries a spread radius r [m] and a dirt level 0..1 (how
 * much energy the air has lost — the colour). The streams react to the
 * car's state: steering turns the front-tyre wake, load makes a tyre's
 * wake bigger, and the rear wing's loading sets how steeply the wake is
 * thrown upward (DRS flattens it).
 *
 * Car-local frame: x right, y up, z rearward (nose at −z).
 */

const lerp = (a, b, t) => a + (b - a) * t;

/** Geometry the streams are built from, with safe fallbacks. */
export function wakeGeometry(measure, fallback = {}) {
  const m = measure || {};
  const a = m.anchors || {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const zf = num(m.frontAxleZ, fallback.frontAxleZ ?? -1.5);
  const zr = num(m.rearAxleZ, fallback.rearAxleZ ?? 2.0);
  const xf = num(m.frontAxleX, fallback.frontAxleX ?? 0.8);
  const xr = num(m.rearAxleX, fallback.rearAxleX ?? 0.8);
  const R  = num(m.wheelRadius, 0.34);
  const g  = num(m.groundContactY, fallback.groundContactY ?? 0);
  const fw = a.frontWing || {};
  const rw = a.rearWing || {};
  const inlet = a.sidepodInletR || a.sidepodInletL || {};
  return {
    zf, zr, xf, xr, R, g, L: zr - zf,
    fwZ: num(fw.z, zf - 0.9), fwY: num(fw.y, g + 0.15),
    rwZ: num(rw.z, zr + 0.6), rwY: num(rw.y, g + 0.95),
    rwHalf: Math.min(xr + 0.1, 0.55 + 0.25 * xr),
    inletX: Math.abs(num(inlet.x, 0.6 * xf)), inletY: num(inlet.y, g + 0.45), inletZ: num(inlet.z, zf + 0.9),
  };
}

/**
 * @param {object} geo    wakeGeometry()
 * @param {object} st
 *   steer      front-wheel steer angle [rad], + = steering LEFT
 *   loadL/R    front tyre load ÷ static load (1 = at rest)
 *   rearGain   rear-wing loading ×1 at the reference setup (DRS ≈ 0.42)
 *   floorGain  underbody loading ×1 at the reference setup
 * @returns {Array<{id, side, vortex, weight, scale, pts}>}
 */
export function wakeStreams(geo, st = {}) {
  const { zf, zr, xf, xr, R, g, L, fwZ, fwY, rwZ, rwY, rwHalf, inletX, inletY, inletZ } = geo;
  const steer = st.steer || 0;
  const rearGain = Number.isFinite(st.rearGain) ? st.rearGain : 1;
  const floorGain = Number.isFinite(st.floorGain) ? st.floorGain : 1;
  // How steeply the wing and diffuser throw the wake upward.
  const up = 0.55 + 0.45 * Math.max(0, rearGain);
  const upFloor = 0.6 + 0.4 * Math.max(0, Math.min(1.6, floorGain));
  // A steered tyre makes side force; its wake is deflected the other way
  // (steer left ⇒ wake pushed right), building up over the first metre or so.
  const defl = (z) => steer * 0.9 * (1 - Math.exp(-Math.max(0, z - zf) / 1.2));
  const out = [];
  for (const side of [-1, 1]) {
    const load = Math.max(0.3, Math.min(2.2, (side < 0 ? st.loadL : st.loadR) ?? 1));
    // A loaded tyre is squashed wider and sheds a bigger wake.
    const scale = Math.max(0.6, Math.min(1.5, 0.7 + 0.3 * load));
    const X = (x, z) => side * x + defl(z);
    const P = (x, y, z, r, dirt) => ({ x: X(x, z), y, z, r, dirt });

    out.push({
      id: 'frontWingTip', side, vortex: true, weight: 0.9, scale,
      pts: [
        P(xf + 0.10, fwY + 0.05, fwZ, 0.05, 0.30),
        P(xf + 0.36, g + 0.32, zf, 0.10, 0.40),
        P(xf + 0.46, g + 0.46, zf + 0.35 * L, 0.16, 0.50),
        P(xf + 0.42, g + 0.52, zf + 0.70 * L, 0.22, 0.55),
        P(xr + 0.36, g + 0.58, zr, 0.28, 0.60),
        P(xr + 0.28, g + 0.58 + 0.45 * up, zr + 2.5, 0.40, 0.60),
        P(xr + 0.24, g + 0.58 + 1.00 * up, zr + 6.5, 0.60, 0.50),
      ],
    });
    out.push({
      id: 'frontTyreWake', side, vortex: false, weight: 1.6, scale,
      pts: [
        P(xf, g + R, zf + 0.5 * R, 0.14 * scale, 0.85),
        P(xf + 0.18, g + 0.85 * R, zf + 1.0, 0.20 * scale, 0.95),
        P(xf + 0.24, g + 0.48, zf + 0.42 * L, 0.26 * scale, 1.00),
        P(xf + 0.10, g + 0.42, zf + 0.78 * L, 0.28 * scale, 0.95),   // drawn in at the waist
        P(0.74 * xr, g + 0.38, zr + 0.3, 0.30, 0.95),
        P(0.56, g + 0.38 + 0.50 * up, zr + 1.8, 0.42, 0.90),
        P(0.52, g + 0.38 + 1.05 * up, zr + 4.5, 0.62, 0.80),
        P(0.62, g + 0.38 + 1.60 * up, zr + 8.5, 0.95, 0.65),
      ],
    });
    out.push({
      id: 'sidepodFlow', side, vortex: false, weight: 1.0, scale: 1,
      pts: [
        P(xf - 0.28, g + 0.50, zf + 0.25, 0.07, 0.35),
        P(inletX, inletY, inletZ, 0.06, 0.40),                       // into the sidepod inlet
        P(0.9 * inletX, inletY + 0.12, lerp(inletZ, zr, 0.55), 0.10, 0.55),
        P(0.40, lerp(inletY, rwY, 0.55), zr - 0.5, 0.14, 0.55),      // out over the engine cover
        P(0.30, rwY - 0.22, rwZ, 0.16, 0.55),                        // under the rear wing
        P(0.30, rwY - 0.22 + 0.75 * up, rwZ + 2.2, 0.34, 0.60),      // thrown up by it
        P(0.36, rwY - 0.22 + 1.45 * up, rwZ + 6.0, 0.62, 0.50),
      ],
    });
    out.push({
      id: 'rearTyreWake', side, vortex: false, weight: 1.3, scale: 1,
      pts: [
        P(xr, g + R, zr + 0.5 * R, 0.15, 0.90),
        P(xr - 0.10, g + 0.62, zr + 1.5, 0.24, 1.00),
        P(xr - 0.34, g + 0.62 + 0.42 * up, zr + 4.5, 0.48, 0.90),
        P(xr - 0.40, g + 0.62 + 0.95 * up, zr + 9.0, 0.85, 0.70),
      ],
    });
    out.push({
      id: 'diffuser', side, vortex: false, weight: 1.2, scale: 1,
      pts: [
        P(0.24, g + 0.12, zr - 0.3, 0.09, 0.75),
        P(0.30, g + 0.12 + 0.36 * upFloor, zr + 0.8, 0.18, 0.90),
        P(0.30, g + 0.12 + 0.95 * upFloor * up, zr + 3.0, 0.36, 0.85),
        P(0.36, g + 0.12 + 1.55 * upFloor * up, zr + 7.0, 0.66, 0.70),
        P(0.46, g + 0.12 + 1.95 * upFloor * up, zr + 11.0, 1.00, 0.55),
      ],
    });
    out.push({
      id: 'rearWingTip', side, vortex: true, weight: 0.8, scale: Math.max(0.4, rearGain),
      pts: [
        P(rwHalf, rwY, rwZ, 0.05, 0.50),
        P(rwHalf + 0.06, rwY + 0.42 * up, rwZ + 2.5, 0.16, 0.60),
        P(rwHalf + 0.16, rwY + 0.95 * up, rwZ + 6.0, 0.30, 0.55),
        P(rwHalf + 0.26, rwY + 1.45 * up, rwZ + 10.0, 0.46, 0.45),
      ],
    });
  }
  return out;
}

/** Point on a stream at u ∈ [0, 1] (piecewise-linear in every field). */
export function sampleStream(stream, u) {
  const p = stream.pts;
  const f = Math.min(1, Math.max(0, u)) * (p.length - 1);
  const i = Math.min(p.length - 2, Math.floor(f));
  const t = f - i;
  const a = p[i], b = p[i + 1];
  return {
    x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
    r: lerp(a.r, b.r, t), dirt: lerp(a.dirt, b.dirt, t),
  };
}

/** Arc length [m] of a stream (for even particle pacing). */
export function streamLength(stream) {
  let L = 0;
  for (let i = 1; i < stream.pts.length; i++) {
    const a = stream.pts[i - 1], b = stream.pts[i];
    L += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return L;
}

/**
 * Colour for a dirt level: clean cyan-white → amber → hot magenta-red.
 * @returns {[number, number, number]} linear-ish RGB 0..1
 */
export function dirtColor(dirt) {
  const d = Math.min(1, Math.max(0, dirt));
  const stops = [[0.55, 0.88, 1.0], [1.0, 0.78, 0.22], [1.0, 0.22, 0.38]];
  const f = d * 2, i = Math.min(1, Math.floor(f)), t = f - i;
  return [0, 1, 2].map(k => lerp(stops[i][k], stops[i + 1][k], t));
}
