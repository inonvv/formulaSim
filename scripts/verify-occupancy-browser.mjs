/**
 * verify-occupancy-browser.mjs — read the production `[body-sdf] …ms` console
 * lines from the running dev server (port 3000, override with FSIM_PORT).
 *
 *   node scripts/verify-occupancy-browser.mjs
 *
 * Waits for the initial F1 occupancy log, clicks the GT car button, waits for
 * the GT occupancy log, and reports both. Passes iff the GT voxelization is
 * under 500 ms (was ~3500 ms with the per-voxel fill).
 */
import { chromium } from 'playwright';

const PORT = process.env.FSIM_PORT || 3000;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);

const lines = [];
const waiters = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (!text.startsWith('[body-sdf]')) return;
  lines.push(text);
  for (const w of [...waiters]) {
    if (text.includes(w.tag)) { w.resolve(text); waiters.splice(waiters.indexOf(w), 1); }
  }
});
const waitForLog = (tag) => new Promise((resolve, reject) => {
  const hit = lines.find(l => l.includes(tag));
  if (hit) return resolve(hit);
  waiters.push({ tag, resolve });
  setTimeout(() => reject(new Error(`timeout waiting for [body-sdf] ${tag}`)), 120000);
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

const f1Line = await waitForLog('f1:');
console.log('F1:', f1Line);

await page.click('.car-btn[data-car="GT"]');
const gtLine = await waitForLog('gt:');
console.log('GT:', gtLine);

const ms = parseInt(/in (\d+)ms/.exec(gtLine)?.[1] ?? 'NaN', 10);

/* In-session A/B: run the OLD per-voxel fill (kept as
 * _internal.buildOccupancyReference) on the SAME production mesh list the
 * GT occupancy was just built from (__fsim.cfd._bodyMeshes is the same
 * collectOccupancyMeshes output main.js feeds buildOccupancy), with the
 * same bounds convention (union bbox + 0.15 m) and resolution. This gives
 * the true in-browser "before" without serving old code. */
const ab = await page.evaluate(async () => {
  const { buildOccupancy, _internal } = await import('/js/body-sdf.js');
  const meshes = window.__fsim?.cfd?._bodyMeshes;
  if (!meshes || !meshes.length) return { error: 'no _bodyMeshes on __fsim.cfd' };

  // World bbox without importing THREE: transform each geometry bbox's 8
  // corners by the mesh's matrixWorld (column-major elements).
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    const e = mesh.matrixWorld.elements;
    for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
      const wx = e[0] * cx + e[4] * cy + e[8]  * cz + e[12];
      const wy = e[1] * cx + e[5] * cy + e[9]  * cz + e[13];
      const wz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
      const w = [wx, wy, wz];
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], w[i]); mx[i] = Math.max(mx[i], w[i]); }
    }
  }
  const M = 0.15;
  const opts = {
    resolution: { x: 96, y: 40, z: 56 },
    bounds: { min: mn.map(v => v - M), max: mx.map(v => v + M) },
  };
  const t0 = performance.now();
  const ref = _internal.buildOccupancyReference(meshes, opts);
  const msRef = performance.now() - t0;
  const t1 = performance.now();
  const fast = buildOccupancy(meshes, opts);
  const msFast = performance.now() - t1;
  let diffs = 0;
  for (let i = 0; i < ref.data.length; i++) if (ref.data[i] !== fast.data[i]) diffs++;
  return { msRef: Math.round(msRef), msFast: Math.round(msFast), diffs };
});
console.log('In-browser A/B on the GT production mesh list:', JSON.stringify(ab));

await browser.close();

if (Number.isFinite(ms) && ms < 500) {
  console.log(`PASS: GT voxelization ${ms} ms < 500 ms`);
  process.exit(0);
}
console.log(`FAIL: GT voxelization ${ms} ms (target < 500 ms)`);
process.exit(1);
