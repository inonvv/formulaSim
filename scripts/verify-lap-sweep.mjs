/**
 * verify-lap-sweep.mjs — is the road visible, everywhere on the lap?
 *
 * Parks the car every STEP metres around a circuit, looks straight down,
 * and reads the rendered pixels at points that MUST be asphalt (the road
 * centre and both lanes, ahead of and behind the car). It fails if grass,
 * gravel or anything else shows there — the two ground faults that reached
 * the live site (verges lying across a neighbouring leg at Bruxelles; the
 * road buried under a tilted bank) both fail this check.
 *
 * A control sample well outside the road must NOT look like asphalt on
 * most of the lap, which proves the detector can tell the two apart.
 *
 *   npm start   (port 3000)   then   node scripts/verify-lap-sweep.mjs [step]
 */
import { createRequire } from 'node:module';
// require() honours NODE_PATH (global installs); ESM import does not.
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.FSIM_URL || 'http://localhost:3000/';
const STEP = Number(process.argv[2] || 250);
const TRACK = process.env.FSIM_TRACK || 'spa';
const MIN_ROAD = 0.94;        // share of road samples that must be asphalt

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL);
await page.waitForFunction(() => window.__fsim?.state?.carGroup, null, { timeout: 120000 });
await page.addStyleTag({ content: '#panel,#telemetry,#circuit-hud,#hud,#orbit-hint,#effects-chips,#car-badge,#camera-label{display:none!important}' });
const length = await page.evaluate((track) => {
  const f = window.__fsim;
  window.dispatchEvent(new Event('resize'));
  f.setTrack(track);
  f.orbit.maxDistance = 400;
  f.trackGroup = f.state.carGroup.parent.children.find(c => c.name === 'track');
  return f.trackPath.circuit.length;
}, TRACK);

/** In the page: sample the frame at road and off-road points. */
const sample = () => page.evaluate(() => new Promise((resolve) => {
  const f = window.__fsim;
  // Runs right after the app's own frame, while the buffer is still valid.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const gl = f.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = gl.width; c.height = gl.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(gl, 0, 0);
    f.camera.updateMatrixWorld();
    f.trackGroup.updateMatrixWorld(true);
    const mul = (m, v) => {            // column-major 4×4 · (x, y, z, 1)
      const e = m.elements, [x, y, z] = v;
      return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13],
              e[2] * x + e[6] * y + e[10] * z + e[14], e[3] * x + e[7] * y + e[11] * z + e[15]];
    };
    const path = f.trackPath;
    const pixelAt = (ds, lateral) => {
      const s = path.pose.s + ds;
      const p = path.poseAt(s);
      const x = lateral + path.centerOffsetAt(s);
      const local = [p.x + x * Math.cos(p.theta), -0.34 + path.heightAt(s), p.z - x * Math.sin(p.theta)];
      const w = mul(f.trackGroup.matrixWorld, local);
      const v = mul(f.camera.matrixWorldInverse, w.slice(0, 3));
      const q = mul(f.camera.projectionMatrix, v.slice(0, 3));
      if (q[3] <= 0) return null;
      const px = Math.round((q[0] / q[3] * 0.5 + 0.5) * c.width);
      const py = Math.round((1 - (q[1] / q[3] * 0.5 + 0.5)) * c.height);
      if (px < 2 || py < 2 || px >= c.width - 2 || py >= c.height - 2) return null;
      const d = ctx.getImageData(px - 1, py - 1, 3, 3).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      return [r / 9, g / 9, b / 9];
    };
    // Asphalt (and paint on it) is neutral: no channel stands out.
    const neutral = (rgb) => rgb && Math.max(...rgb) - Math.min(...rgb) < 30;
    let road = 0, roadOk = 0, off = 0, offNeutral = 0, blank = 0;
    for (let ds = -40; ds <= 70; ds += 3) {
      if (Math.abs(ds) < 7) continue;                       // the car itself
      for (const lat of [-3, 0, 3]) {
        const rgb = pixelAt(ds, lat);
        if (!rgb) continue;
        if (rgb[0] + rgb[1] + rgb[2] < 3) blank++;
        road++;
        if (neutral(rgb)) roadOk++;
      }
      for (const lat of [-8.2, 8.2]) {                      // verge: grass, gravel or pit lane
        const rgb = pixelAt(ds, lat);
        if (!rgb) continue;
        off++;
        if (neutral(rgb)) offNeutral++;
      }
    }
    resolve({ road, roadOk, off, offNeutral, blank, lapS: Math.round(path.lapS) });
  }));
}));

const rows = [];
for (let s = 0; s < length; s += STEP) {
  await page.evaluate((s) => {
    const f = window.__fsim;
    f.trackPath.setCircuit(f.trackPath.circuit, s);
    const sl = document.getElementById('speed-slider'); sl.value = 5; sl.dispatchEvent(new Event('input'));
  }, s);
  await page.waitForTimeout(2200);
  await page.evaluate(() => { const f = window.__fsim; f.camera.position.set(0.01, 95, 0.01); f.orbit.update(); });
  await page.waitForTimeout(500);
  rows.push({ s, ...(await sample()) });
}
await browser.close();

const fails = [];
let offTotal = 0, offNeutralTotal = 0;
for (const r of rows) {
  const share = r.road ? r.roadOk / r.road : 0;
  offTotal += r.off; offNeutralTotal += r.offNeutral;
  const ok = r.road >= 40 && share >= MIN_ROAD && r.blank === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  lap ${String(r.s).padStart(4)} m: asphalt at ${(share * 100).toFixed(0)}% of ${r.road} road samples`);
  if (!ok) fails.push(r.s);
}
const offShare = offTotal ? offNeutralTotal / offTotal : 1;
const control = offShare < 0.5;
console.log(`${control ? 'PASS' : 'FAIL'}  control: only ${(offShare * 100).toFixed(0)}% of verge samples look like asphalt (detector can tell road from verge)`);
if (!control) fails.push('control');
const clean = errors.length === 0;
console.log(`${clean ? 'PASS' : 'FAIL'}  no console errors${clean ? '' : ': ' + errors.slice(0, 3).join(' | ')}`);
if (!clean) fails.push('errors');
console.log(fails.length ? `\nFAILED at: ${fails.join(', ')}` : `\nALL ${rows.length} STATIONS PASSED`);
process.exit(fails.length ? 1 : 0);
