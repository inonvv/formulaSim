/**
 * verify-spa.mjs — headless browser check of circuit mode on the real app:
 * select Spa, drive a run-up plus one full lap, compare with the solved ideal lap.
 *   npm start   (port 3000)   then   node scripts/verify-spa.mjs [outDir]
 */
import { createRequire } from 'node:module';
// require() honours NODE_PATH (global installs); ESM import does not.
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.FSIM_URL || 'http://localhost:3000/';
const OUT = process.argv[2] || '.';
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL);
await page.waitForFunction(() => window.__fsim?.state?.carGroup, null, { timeout: 120000 });

// ── Select Spa, ask for full speed
await page.click('.track-btn[data-track="spa"]');
// Join 300 m before the line so the flying lap starts almost at once
// (a standing-start lap first would double this script's run time).
await page.evaluate(() => { const f = window.__fsim; f.trackPath.setCircuit(f.trackPath.circuit, f.trackPath.circuit.length - 300); });
await page.evaluate(() => { const s = document.getElementById('speed-slider'); s.value = 350; s.dispatchEvent(new Event('input')); });
await page.waitForFunction(() => window.__fsim.state.lapPlan, null, { timeout: 60000 });
const ideal = await page.evaluate(() => window.__fsim.state.lapPlan.lapTime);
check(ideal > 98 && ideal < 115, `ideal F1 lap ${ideal.toFixed(2)} s`);
check(await page.evaluate(() => getComputedStyle(document.getElementById('circuit-hud')).display !== 'none'), 'circuit HUD visible');
check(await page.evaluate(() => document.querySelectorAll('#ch-map-segs path').length === 140), 'minimap drawn');
check(await page.evaluate(() => [...document.querySelectorAll('.turn-btn')].every(b => b.disabled)), 'turn scheduler control disabled on a circuit');
check(await page.evaluate(() => !!document.querySelector('.chip-track')), 'track chip mirrors state');

// ── Sample the drive: record speed / flags by lap distance
await page.evaluate(() => {
  const f = window.__fsim, log = (f._spaLog = { over: 0, n: 0, maxLat: 0, pitchMax: 0, pitchMin: 0, samples: {} });
  const tick = () => {
    const v = f.state.vehicle, s = f.trackPath.lapS;
    log.n++;
    if (v.overLimit) log.over++;
    log.maxLat = Math.max(log.maxLat, Math.abs(v.ay) / 9.81);
    log.pitchMax = Math.max(log.pitchMax, f.state.gradeVis);
    log.pitchMin = Math.min(log.pitchMin, f.state.gradeVis);
    log.samples[Math.round(s / 50) * 50] = Math.round(v.v * 3.6);
    requestAnimationFrame(tick);
  };
  tick();
});
const shot = async (lapS, name) => {
  await page.waitForFunction((s) => { const f = window.__fsim; return f.state.lap.count >= 1 && f.trackPath.lapS >= s && f.trackPath.lapS < s + 400; }, lapS, { timeout: 900000 });
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
// The first line crossing ends the 300 m run-up; the next full lap is timed.
await shot(380, 'spa-la-source');
await shot(1150, 'spa-raidillon');
await shot(3850, 'spa-pouhon');
await page.waitForFunction(() => window.__fsim.state.lap.count >= 2, null, { timeout: 900000 });
const r = await page.evaluate(() => ({ last: window.__fsim.state.lap.last, log: window.__fsim._spaLog, hud: document.getElementById('ch-last').textContent }));
console.log('speeds by lap distance:', JSON.stringify(r.log.samples));
check(Math.abs(r.last - ideal) < ideal * 0.03, `flying lap ${r.last.toFixed(2)} s vs ideal ${ideal.toFixed(2)} s`);
check(r.hud.startsWith('1:'), `HUD last lap ${r.hud}`);
check(r.log.over / r.log.n < 0.03, `over-grip frames ${(100 * r.log.over / r.log.n).toFixed(1)} %`);
check(r.log.maxLat > 3.5 && r.log.maxLat < 7, `peak lateral ${r.log.maxLat.toFixed(1)} g`);
check(r.log.pitchMax > 0.12 && r.log.pitchMin < -0.05, `world pitch range ${(r.log.pitchMin * 57.3).toFixed(1)}° … ${(r.log.pitchMax * 57.3).toFixed(1)}°`);
check(r.log.samples[400] < 110 && r.log.samples[2200] > 300, `La Source ${r.log.samples[400]} km/h, Kemmel ${r.log.samples[2200]} km/h`);

// ── Setup changes the ideal lap; back to the test track restores everything
await page.evaluate(() => window.__fsim.setAero({ wing: 0 }));
await page.waitForFunction((t) => window.__fsim.state.lapPlan && Math.abs(window.__fsim.state.lapPlan.lapTime - t) > 0.3, ideal, { timeout: 60000 });
const low = await page.evaluate(() => window.__fsim.state.lapPlan.lapTime);
check(low > ideal, `low wing ideal ${low.toFixed(2)} s is slower than ${ideal.toFixed(2)} s`);
await page.click('.track-btn[data-track="test"]');
check(await page.evaluate(() => getComputedStyle(document.getElementById('circuit-hud')).display === 'none'), 'circuit HUD hidden on the test track');
check(await page.evaluate(() => window.__fsim.trackPath.circuit === null && [...document.querySelectorAll('.turn-btn')].every(b => !b.disabled)), 'test track restored');
await page.waitForTimeout(1500);
check(await page.evaluate(() => Math.abs(window.__fsim.state.gradeVis) < 1e-3), 'world pitch back to level');

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
