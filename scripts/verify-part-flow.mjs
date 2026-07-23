/* verify-part-flow.mjs — visual verification for the airflow part-precision
 * plan (Phases 1-5). Drives the RUNNING dev server (default port 3000; do
 * NOT kill it — override with BASE_URL) via the window.__fsim camera hook
 * (NEVER mouse-drag orbiting: headless drags silently produce top-down
 * shots).
 *
 * Headless slow motion: SwiftShader renders ~3 fps and main.js clamps dt to
 * 0.05 s, so the sim runs ~15x slower than real time. Every speed change is
 * therefore verified against the km/h READOUT in-page, not wall-clock waits.
 *
 * Shots (scripts/_shots/):
 *   pf-a-side-halo.png       — side view, halo band: lines pinch to cockpit
 *   pf-b-front-low.png       — front 3/4 low: wing band + tire deflection
 *   pf-c-side-sf02.png       — side view at ~70 km/h  (sf bucket 0.2)
 *   pf-c-side-sf10.png       — side view at ~350 km/h (sf bucket 1.0)
 *   pf-d-rain-airflow.png    — rain + airflow: drops deflecting over nose
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000/';
const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(120000);

const setCam = (pos, target) => page.evaluate(([p, t]) => {
  const { camera, orbit } = window.__fsim;
  camera.position.set(...p);
  orbit.target.set(...t);
  orbit.update();
}, [pos, target]);

const kmh = async () => Number(await page.textContent('#speed-value'));

/** Wait until the km/h readout reaches ~target (sim ramps in slow motion). */
async function waitForSpeed(target, tolerance = 12, maxMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const v = await kmh();
    if (Math.abs(v - target) <= tolerance) return v;
    if (Date.now() - t0 > maxMs) {
      console.log(`WARN: speed readout ${v} never reached ${target}±${tolerance}`);
      return v;
    }
    await page.waitForTimeout(1000);
  }
}

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);   // GLB + occupancy build

// Sanity: part-precision internals present.
const probe = await page.evaluate(() => {
  const a = window.__fsim;
  return { hasTrackPath: !!a.trackPath };
});
console.log('probe:', JSON.stringify(probe));

await page.click('#btn-airflow');

/* ── (a) side view, halo band ─────────────────────────────────────── */
await page.click('[data-speed="180"]');
let v = await waitForSpeed(180);
await setCam([5.2, 1.15, 0.1], [0, 0.75, 0]);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/pf-a-side-halo.png` });
console.log(`shot a: side halo band @ ${v} km/h`);

/* ── (b) front 3/4 low — wing band + tire deflection ──────────────── */
await setCam([2.6, 0.55, -4.6], [0, 0.25, -1.2]);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/pf-b-front-low.png` });
console.log(`shot b: front 3/4 low @ ${await kmh()} km/h`);

/* ── (c) speed coherence: sf 0.2 vs sf 1.0 from the same side camera ─ */
await setCam([5.6, 1.0, 0.2], [0, 0.55, 0]);
await page.click('[data-speed="80"]');
v = await waitForSpeed(80, 8);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/pf-c-side-sf02.png` });
console.log(`shot c1: sf~0.2 @ ${v} km/h`);

await page.click('[data-speed="350"]');
v = await waitForSpeed(350, 15);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/pf-c-side-sf10.png` });
console.log(`shot c2: sf~1.0 @ ${v} km/h`);

/* ── (d) rain + airflow — drops deflecting over the nose ──────────── */
await page.click('#btn-rain');
await page.click('[data-speed="280"]');
v = await waitForSpeed(280, 15);
await setCam([3.4, 0.9, -3.6], [0, 0.5, -1.0]);
await page.waitForTimeout(2500);   // let coupled drops accumulate deflection
await page.screenshot({ path: `${OUT}/pf-d-rain-airflow.png` });
console.log(`shot d: rain+airflow @ ${v} km/h`);

/* ── numeric probe: coupling active + flow field sane in-browser ──── */
const readout = await page.evaluate(() => {
  // main.js does not export the effect objects; probe via the airflow group
  // presence and the coupling side-channel on the rain group if available.
  const groups = [];
  window.__fsim.camera.parent?.traverse?.(o => { if (o.name) groups.push(o.name); });
  return { sceneGroups: groups.filter(n => n === 'airflow' || n === 'rain') };
});
console.log('scene groups:', JSON.stringify(readout));

await browser.close();
console.log('done — inspect scripts/_shots/pf-*.png');
