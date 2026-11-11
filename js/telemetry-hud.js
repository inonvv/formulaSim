/**
 * telemetry-hud.js — the on-screen readout of the vehicle model.
 *
 * Split in two so the numbers are testable without a browser:
 *   • telemetryView()  — pure: vehicle state → display strings / fractions.
 *   • createTelemetryHud() — thin DOM writer that mirrors the view, with
 *     no-op-write guards so an unchanged value never touches the DOM.
 */
import { G, getVehicleParams, topSpeed } from './vehicle-model.js';

const WHEELS = ['FL', 'FR', 'RL', 'RR'];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Tyre-usage colour: green (easy) → amber (working) → red (at the limit). */
export function usageColor(u) {
  const t = clamp01(u);
  const hue = 135 - 135 * Math.pow(t, 1.4);        // 135° green → 0° red
  return `hsl(${Math.round(hue)}, 85%, ${Math.round(46 + 8 * t)}%)`;
}

/**
 * g-g dot position, each axis −1..1 of `scaleG`.
 * Screen convention (CSS: +x right, +y down): the dot is the acceleration
 * vector as on an F1 broadcast — turning LEFT moves it left, BRAKING moves
 * it up (toward the nose), accelerating moves it down.
 */
export function ggDot(axG, ayG, scaleG) {
  const s = scaleG > 0 ? scaleG : 1;
  const c = (v) => Math.max(-1, Math.min(1, v));
  return { x: c(-ayG / s) + 0, y: c(axG / s) + 0 };
}

/** g-g plot full-scale for a car: 6 g for the formula cars, 3 g for the GT. */
export function ggScale(type) {
  return getVehicleParams(type).mu >= 1.5 ? 6 : 3;
}

/** Pure view-model: everything the HUD shows, as strings and 0..1 fractions. */
export function telemetryView(vs, type, setup) {
  const p = getVehicleParams(type);
  const aero = vs?.aero;
  const W = p.mass * G;
  const axG = (vs?.ax ?? 0) / G;
  const ayG = (vs?.ay ?? 0) / G;
  const loads = vs?.loads ?? { FL: 0, FR: 0, RL: 0, RR: 0 };
  // Bars are scaled to 2.5× the heaviest static corner — room for aero + transfer.
  const full = 2.5 * W * Math.max(p.frontWeight, 1 - p.frontWeight) / 2
    + (type === 'GT' ? 0 : 0.9 * W);
  const wheels = {};
  for (const k of WHEELS) {
    const u = vs?.usage?.[k] ?? 0;
    wheels[k] = {
      kN: (loads[k] / 1000).toFixed(1),
      frac: clamp01(loads[k] / full),
      usage: u,
      color: usageColor(u),
      lifted: loads[k] <= 0 && (vs?.v ?? 0) > 1,
    };
  }
  const flags = [];
  if (setup?.drs) flags.push('DRS');
  if (aero?.bottoming) flags.push('BOTTOMING');
  if (vs?.overLimit) flags.push('OVER GRIP');
  else if (vs?.cornerLimited) flags.push('CORNER LIMIT');
  if (WHEELS.some(k => wheels[k].lifted)) flags.push('WHEEL LIFT');

  return {
    downforce: ((aero?.downforce ?? 0) / 1000).toFixed(1),
    downforceWeights: `${(aero?.weightRatio ?? 0).toFixed(2)}× car weight`,
    drag: ((aero?.drag ?? 0) / 1000).toFixed(1),
    dragPower: `${Math.round(aero?.dragPowerKW ?? 0)} kW to push air`,
    balance: `${Math.round((aero?.balance ?? p.frontWeight) * 100)}`,
    ld: `L/D ${(aero?.ld ?? 0).toFixed(2)}`,
    ride: `${Math.round(aero?.rideMm ?? setup?.rideHeightMm ?? p.ride.nominal)}`,
    rideSub: `set ${Math.round(setup?.rideHeightMm ?? p.ride.nominal)} mm`,
    latG: Math.abs(ayG).toFixed(1),
    longG: `${axG >= 0 ? '+' : '−'}${Math.abs(axG).toFixed(1)}`,
    gg: ggDot(axG, ayG, ggScale(type)),
    ggScale: ggScale(type),
    wheels,
    throttle: clamp01(vs?.throttle ?? 0),
    brake: clamp01(vs?.brake ?? 0),
    flags,
  };
}

/** Drag-limited top speed line for the current setup (cached by caller). */
export function vmaxLabel(type, setup) {
  return `${Math.round(topSpeed(type, setup) * 3.6)}`;
}

/**
 * DOM writer. `root` is #telemetry; children are looked up by id once.
 * update() is cheap to call every frame: text nodes refresh at 10 Hz, the
 * g-g dot and bars every frame, all behind change guards.
 */
export function createTelemetryHud(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const el = {
    root: $('telemetry'), head: $('telemetry-head'),
    df: $('tm-df'), dfw: $('tm-dfw'), drag: $('tm-drag'), dragp: $('tm-dragp'),
    bal: $('tm-bal'), ld: $('tm-ld'), ride: $('tm-ride'), rides: $('tm-rides'),
    lat: $('tm-lat'), lon: $('tm-lon'), dot: $('tm-gg-dot'), ggs: $('tm-gg-scale'),
    thr: $('tm-thr'), brk: $('tm-brk'), flags: $('tm-flags'), vmax: $('tm-vmax'),
  };
  const wheelEls = {};
  for (const k of WHEELS) wheelEls[k] = { fill: $(`tm-w-${k}`), val: $(`tm-wv-${k}`) };
  const last = new Map();
  const set = (node, key, v, apply) => {
    if (!node || last.get(key) === v) return;
    last.set(key, v);
    apply(node, v);
  };
  const text = (node, key, v) => set(node, key, v, (n, x) => { n.textContent = x; });
  let clock = 1;   // force a text refresh on the first update

  el.head?.addEventListener('click', () => {
    const collapsed = el.root.classList.toggle('collapsed');
    el.head.setAttribute('aria-expanded', String(!collapsed));
  });

  return {
    el,
    setVmax(str) { text(el.vmax, 'vmax', str); },
    update(view, dt) {
      if (!el.root) return;
      // Per-frame: dot, bars, pedals.
      set(el.dot, 'dot', `${(50 + view.gg.x * 46).toFixed(1)}%|${(50 + view.gg.y * 46).toFixed(1)}%`,
        (n, v) => { const [x, y] = v.split('|'); n.style.left = x; n.style.top = y; });
      for (const k of WHEELS) {
        const w = view.wheels[k];
        set(wheelEls[k].fill, `wf${k}`, `${Math.round(w.frac * 100)}|${w.color}`,
          (n, v) => { const [h, c] = v.split('|'); n.style.height = `${h}%`; n.style.background = c; });
      }
      set(el.thr, 'thr', Math.round(view.throttle * 100), (n, v) => { n.style.width = `${v}%`; });
      set(el.brk, 'brk', Math.round(view.brake * 100), (n, v) => { n.style.width = `${v}%`; });

      clock += dt;
      if (clock < 0.1) return;
      clock = 0;
      text(el.df, 'df', view.downforce);      text(el.dfw, 'dfw', view.downforceWeights);
      text(el.drag, 'drag', view.drag);       text(el.dragp, 'dragp', view.dragPower);
      text(el.bal, 'bal', view.balance);      text(el.ld, 'ld', view.ld);
      text(el.ride, 'ride', view.ride);       text(el.rides, 'rides', view.rideSub);
      text(el.lat, 'lat', view.latG);         text(el.lon, 'lon', view.longG);
      text(el.ggs, 'ggs', `${view.ggScale} g`);
      for (const k of WHEELS) text(wheelEls[k].val, `wv${k}`, view.wheels[k].kN);
      set(el.flags, 'flags', view.flags.join('|'), (n, v) => {
        n.innerHTML = '';
        for (const f of v ? v.split('|') : []) {
          const s = doc.createElement('span');
          s.className = `tm-flag tm-flag-${f.toLowerCase().replace(/\s+/g, '-')}`;
          s.textContent = f;
          n.appendChild(s);
        }
      });
    },
  };
}
