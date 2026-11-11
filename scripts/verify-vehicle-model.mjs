/**
 * verify-vehicle-model.mjs — headless browser check of the vehicle model,
 * telemetry HUD and aero-setup controls on the real app.
 *   npm start   (port 3000)   then   node scripts/verify-vehicle-model.mjs [outDir]
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
const setSpeed = (v) => page.evaluate((v) => {
  const s = document.getElementById('speed-slider'); s.value = v; s.dispatchEvent(new Event('input'));
}, v);
const waitSpeed = (kmh, tol = 3) => page.waitForFunction(
  ([k, t]) => Math.abs(window.__fsim.state.speed - k) < t, [kmh, tol], { timeout: 240000 });
const wheelBottoms = () => page.evaluate(() => {
  const st = window.__fsim.state;
  const out = {};
  for (const [k, w] of Object.entries(st.wheels)) {
    if (!w) continue;
    w.updateWorldMatrix(true, false);
    out[k] = w.matrixWorld.elements[13];   // hub centre, world y
  }
  return { out, bodyY: st.carGroup.position.y, heave: st.vehicle.heaveM };
});
const tm = () => page.evaluate(() => {
  const g = (id) => document.getElementById(id).textContent;
  const v = window.__fsim.state.vehicle;
  return {
    df: g('tm-df'), drag: g('tm-drag'), bal: g('tm-bal'), ride: g('tm-ride'), vmax: g('tm-vmax'),
    flags: [...document.querySelectorAll('.tm-flag')].map(e => e.textContent),
    model: { df: v.aero.downforce, drag: v.aero.drag, ride: v.aero.rideMm, ax: v.ax, ay: v.ay, loads: v.loads, gains: v.aero.gains },
  };
});

// ── 1. Rest
let t = await tm();
check(t.df === '0.0' && t.drag === '0.0', `rest: zero aero (df ${t.df}, drag ${t.drag})`);
const rest = await wheelBottoms();

// ── 2. Accelerate to 300 km/h
await setSpeed(300);
await waitSpeed(300);
await page.waitForTimeout(1500);
t = await tm();
check(t.model.df > 15000 && t.model.df < 26000, `F1 @300: downforce ${(t.model.df / 1000).toFixed(1)} kN`);
check(Math.abs(Number(t.df) - t.model.df / 1000) < 0.6, `HUD downforce mirrors model (${t.df})`);
check(Number(t.ride) < 30 && Number(t.ride) > 8, `dynamic ride height dropped to ${t.ride} mm`);
const fast = await wheelBottoms();
check(fast.heave > 0.008 && rest.bodyY - fast.bodyY > 0.008, `body sank ${(1000 * (rest.bodyY - fast.bodyY)).toFixed(1)} mm`);
const maxWheelShift = Math.max(...Object.keys(rest.out).map(k => Math.abs(rest.out[k] - fast.out[k])));
// Tolerance covers the 3 mm idle vibration at rest + the aero-rake pitch.
check(maxWheelShift < 0.007, `tyres stayed on the road (max shift ${(maxWheelShift * 1000).toFixed(2)} mm)`);

// ── 3. DRS
const vmaxShut = Number(t.vmax);
await page.click('#drs-btn');
await page.waitForTimeout(1500);
let t2 = await tm();
check(t2.flags.includes('DRS'), 'DRS flag shown');
check(t2.model.gains.rearWing < 0.6, `rear-wing gain ${t2.model.gains.rearWing.toFixed(2)} with DRS`);
check(t2.model.drag < t.model.drag && t2.model.df < t.model.df, 'DRS cut drag and downforce');
check(Number(t2.vmax) > vmaxShut, `top speed ${vmaxShut} → ${t2.vmax} km/h`);
check(await page.evaluate(() => !!document.querySelector('.chip-drs')), 'DRS chip mirrors state');
const cfdAero = await page.evaluate(() => window.__fsim.cfd._aero);
check(cfdAero && cfdAero.rearWing < 0.6, 'CFD paint received the DRS gain');
await page.click('#drs-btn');

// ── 4. Wing + ride + yaw sliders
const setRange = (id, v) => page.evaluate(([id, v]) => {
  const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event('input'));
}, [id, v]);
await setRange('wing-slider', 100);
await page.waitForTimeout(1500);
let t3 = await tm();
check(t3.model.df > t.model.df, `max wing: ${(t.model.df / 1000).toFixed(1)} → ${(t3.model.df / 1000).toFixed(1)} kN`);
check(Number(t3.vmax) < vmaxShut, `max wing lowers top speed to ${t3.vmax}`);
await setRange('wing-slider', 50);
await setRange('yaw-slider', 10);
await page.waitForTimeout(1500);
const beta = await page.evaluate(() => window.__fsim.cfd._beta);
check(Math.abs(beta) > 0.1, `yaw 10° reaches the CFD sideslip (β = ${(beta * 57.3).toFixed(1)}°)`);
await setRange('yaw-slider', 0);

// ── 5. Effects on: screenshot for a human
await page.click('#btn-cfd');
await page.click('#btn-airflow');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/vm-f1-300.png` });

// ── 6. Hard braking: load goes forward
await setSpeed(0);
await page.waitForFunction(() => window.__fsim.state.vehicle.ax < -15, null, { timeout: 60000 });
let t4 = await tm();
check(t4.model.loads.FL > t4.model.loads.RL, `braking ${(t4.model.ax / 9.81).toFixed(1)} g: front ${(t4.model.loads.FL / 1000).toFixed(1)} kN > rear ${(t4.model.loads.RL / 1000).toFixed(1)} kN`);
await waitSpeed(0, 1);

// ── 7. GT
await page.click('.car-btn[data-car="GT"]');
await page.waitForFunction(() => document.getElementById('car-badge-type').textContent === 'GT', null, { timeout: 120000 });
const ride = await page.evaluate(() => { const r = document.getElementById('ride-slider'); return [r.min, r.max, r.value]; });
check(ride[0] === '60' && ride[1] === '120' && ride[2] === '90', `GT ride-height range ${ride.join('/')}`);
await setSpeed(200);
await waitSpeed(200, 4);
await page.waitForTimeout(1500);
const t5 = await tm();
check(t5.model.df > 2000 && t5.model.df < 6000, `GT @200: downforce ${(t5.model.df / 1000).toFixed(1)} kN`);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/vm-gt-200.png` });

// ── 8. Arcade hides the sim tools
await page.click('.mode-btn[data-mode="arcade"]');
check(await page.evaluate(() => getComputedStyle(document.getElementById('telemetry')).display === 'none'), 'telemetry hidden in arcade');
await page.click('.mode-btn[data-mode="sim"]');

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
