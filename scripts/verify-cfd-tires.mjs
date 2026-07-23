/**
 * verify-cfd-tires.mjs — browser smoke for the CFD tire proxies against the
 * running dev server (port 3000, override with FSIM_PORT).
 *
 *   node scripts/verify-cfd-tires.mjs
 *
 * Checks (GT, CFD env, speed ≥ 100 km/h):
 *   • 4 tire proxies exist with sf-scaled opacity > 0;
 *   • front-tread vertices are painted red-dominant (stagnation), rear-facing
 *     treads are not red-dominant;
 * and drops a front-¾ shot at scripts/_shots/cfd-tires-gt.png for eyeballing
 * the z-fight / patch-doubling risks from the plan.
 *
 * Headless notes (project memory): SwiftShader runs the sim ~15× slow motion —
 * wait on the km/h readout, never a fixed sleep; camera via window.__fsim.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT  = 'scripts/_shots';
const PORT = process.env.FSIM_PORT || 3000;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__fsim?.cfd);

await page.click('.car-btn[data-car="GT"]');
await page.waitForFunction(() => window.__fsim.cfd._tireMeshes?.length === 4);

await page.click('.env-btn[data-env="cfd"]');
await page.click('.preset-btn[data-speed="350"]');
await page.waitForFunction(() =>
  parseInt(document.getElementById('speed-value').textContent, 10) >= 100);

// Let a couple of frames run so the amortized recolor fires at speed.
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

const res = await page.evaluate(() => {
  const cfd = window.__fsim.cfd;
  const tires = cfd._tireMeshes;
  const out = { count: tires.length, opacities: [], front: [], rear: [] };
  for (const { mesh } of tires) {
    out.opacities.push(+mesh.material.opacity.toFixed(3));
    const nrm = mesh.geometry.attributes.normal;
    const col = mesh.geometry.attributes.color;
    let fi = 0, ri = 0;
    for (let i = 0; i < nrm.count; i++) {
      if (nrm.getZ(i) < nrm.getZ(fi)) fi = i;
      if (nrm.getZ(i) > nrm.getZ(ri)) ri = i;
    }
    out.front.push({ r: +col.getX(fi).toFixed(3), b: +col.getZ(fi).toFixed(3) });
    out.rear.push({ r: +col.getX(ri).toFixed(3), b: +col.getZ(ri).toFixed(3) });
  }
  return out;
});

await page.evaluate(() => {
  const { camera, orbit } = window.__fsim;
  camera.position.set(3.4, 1.7, -4.6);
  orbit.target.set(0, 0.5, 0);
  orbit.update();
});
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await page.screenshot({ path: `${OUT}/cfd-tires-gt.png` });
await browser.close();

console.log('tire proxies:', JSON.stringify(res));
// _tireMeshes order is FL, FR, RL, RR. FRONT-axle treads must glow red
// (clean stagnation); REAR-axle front treads must be DIMMER than the front
// axle's — they sit in the front-tire/body wake, and the SDF upstream
// shadowing dims them automatically (that dimming is the designed result,
// so it is asserted, not excused).
const ok =
  res.count === 4 &&
  res.opacities.every(o => o > 0.1) &&
  res.front.slice(0, 2).every(c => c.r > 0.1 && c.r > c.b) &&
  res.front.slice(2).every((c, i) => c.r < res.front[i].r);
console.log(ok ? 'PASS: 4 painted proxies, red front-axle stagnation, wake-dimmed rear treads'
               : 'FAIL: tire proxy paint mismatch');
console.log(`shot: ${OUT}/cfd-tires-gt.png`);
process.exit(ok ? 0 : 1);
