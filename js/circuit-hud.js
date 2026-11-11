/**
 * circuit-hud.js — minimap + lap timing readout for circuit mode.
 * Pure helpers (minimapProjection / speedSegments / speedColor) are
 * unit-tested; createCircuitHud is the thin DOM/SVG mirror.
 */
import { circuitBounds } from './circuit.js';
import { formatLapTime } from './lap-sim.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Fit the circuit into a w×h box (uniform scale, centred, y flipped so
 * north is up). Returns project(x, y) → {x, y} in box pixels.
 */
export function minimapProjection(circuit, w, h, pad = 8) {
  const b = circuitBounds(circuit);
  const sx = (w - 2 * pad) / Math.max(b.maxX - b.minX, 1e-6);
  const sy = (h - 2 * pad) / Math.max(b.maxY - b.minY, 1e-6);
  const k = Math.min(sx, sy);
  const ox = (w - k * (b.maxX - b.minX)) / 2;
  const oy = (h - k * (b.maxY - b.minY)) / 2;
  return (x, y) => ({ x: ox + (x - b.minX) * k, y: h - (oy + (y - b.minY) * k) });
}

/** Speed → colour: red (slowest corner) → amber → cyan (flat out). */
export function speedColor(v, vMin, vMax) {
  const t = Math.min(1, Math.max(0, (v - vMin) / Math.max(vMax - vMin, 1e-6)));
  return `hsl(${Math.round(t * 190)}, 90%, ${Math.round(52 + 6 * t)}%)`;
}

/**
 * Split the lap into `n` polyline pieces, each coloured by the ideal speed
 * at its middle. Pieces overlap by one point so the map has no gaps.
 */
export function speedSegments(circuit, lap, project, n = 140) {
  const out = [];
  const per = circuit.count / n;
  for (let k = 0; k < n; k++) {
    const i0 = Math.floor(k * per), i1 = Math.floor((k + 1) * per);
    let d = '';
    for (let i = i0; i <= i1; i++) {
      const p = project(circuit.x[i % circuit.count], circuit.y[i % circuit.count]);
      d += `${i === i0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    const vMid = lap ? lap.v[Math.floor((i0 + i1) / 2) % circuit.count] : 0;
    out.push({ d, color: lap ? speedColor(vMid, lap.vMin, lap.vMax) : '#8892a0' });
  }
  return out;
}

export function createCircuitHud(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const el = {
    root: $('circuit-hud'), name: $('ch-name'), corner: $('ch-corner'),
    segs: $('ch-map-segs'), dot: $('ch-dot'), start: $('ch-start'),
    cur: $('ch-cur'), last: $('ch-last'), ideal: $('ch-ideal'),
    elev: $('ch-elev'), lapn: $('ch-lapn'),
  };
  const W = 110, H = 150;
  let project = null, circuit = null;
  const last = new Map();
  const text = (node, key, v) => {
    if (!node || last.get(key) === v) return;
    last.set(key, v);
    node.textContent = v;
  };
  let clock = 1;

  return {
    el,
    /** Show for a circuit (or hide with null) and draw its outline. */
    setCircuit(c) {
      circuit = c;
      if (!el.root) return;
      el.root.classList.toggle('show', !!c);
      if (!c) return;
      project = minimapProjection(c, W, H);
      text(el.name, 'name', c.name.toUpperCase());
      const p0 = project(c.x[0], c.y[0]);
      el.start?.setAttribute('cx', p0.x.toFixed(1));
      el.start?.setAttribute('cy', p0.y.toFixed(1));
      this.setLap(null);
    },
    /** Recolour the outline with a solved lap's speed profile. */
    setLap(lap) {
      if (!circuit || !el.segs) return;
      while (el.segs.firstChild) el.segs.removeChild(el.segs.firstChild);
      for (const s of speedSegments(circuit, lap, project)) {
        const path = doc.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', s.d);
        path.setAttribute('stroke', s.color);
        el.segs.appendChild(path);
      }
      text(el.ideal, 'ideal', lap ? formatLapTime(lap.lapTime) : '…');
    },
    update(st, dt) {
      if (!circuit || !el.root) return;
      const xy = circuit.xyAt(st.lapS);
      const p = project(xy.x, xy.y);
      const key = `${p.x.toFixed(1)}|${p.y.toFixed(1)}`;
      if (last.get('dot') !== key) {
        last.set('dot', key);
        el.dot?.setAttribute('cx', p.x.toFixed(1));
        el.dot?.setAttribute('cy', p.y.toFixed(1));
      }
      text(el.cur, 'cur', formatLapTime(st.lapTime).slice(0, -2));   // tenths while running
      // A completed lap shows at once — not on the next throttled refresh.
      text(el.last, 'last', st.lastLap ? formatLapTime(st.lastLap) : '–');
      clock += dt;
      if (clock < 0.15) return;
      clock = 0;
      text(el.corner, 'corner', st.corner || ' ');
      const h = circuit.elevationAt(st.lapS), g = circuit.gradeAt(st.lapS) * 100;
      text(el.elev, 'elev', `${h >= 0 ? '+' : '−'}${Math.abs(h).toFixed(0)} m · ${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(0)}%`);
      text(el.lapn, 'lapn', String(st.lapNumber));
    },
  };
}
