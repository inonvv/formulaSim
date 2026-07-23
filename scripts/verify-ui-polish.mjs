/* Verify the ui-polish pass against the running dev server (port 3000).
 *
 * 1. Shots: desktop 1600×900 (idle, airflow@180, cfd+legend, keyboard focus),
 *    mobile 390×844 (tab bar, open Env section). Firefox not needed — the
 *    -moz slider rules are static CSS.
 * 2. Click-through regression: every .env-btn/.turn-btn/.preset-btn/.cam-btn
 *    is clicked once; assert zero pageerrors and that the expected `.active`
 *    contract holds (env toggles, turn/cam exclusive, speed presets set the
 *    slider value and never take `.active`).
 *
 * HEADLESS SLOW-MO: SwiftShader runs ~15× slow; wait ~12 s after a speed chip. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const failures = [];
const pageErrors = [];

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});

/* ── Desktop shots ─────────────────────────────────────────────── */
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(90000);
page.on('pageerror', e => pageErrors.push(`desktop: ${e.message}`));

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/ui-polish-desktop-idle.png` });

await page.click('#btn-airflow');
await page.click('[data-speed="180"]');
await page.waitForTimeout(12000);
await page.screenshot({ path: `${OUT}/ui-polish-desktop-airflow-180.png` });

await page.click('#btn-airflow');
await page.click('#btn-cfd');
await page.waitForTimeout(4000);
// The 0.18s ease crawls under SwiftShader slow-mo — poll, don't instant-assert.
const legendShown = await page.waitForFunction(() => {
  const el = document.getElementById('cfd-legend');
  const cs = getComputedStyle(el);
  return el.classList.contains('show') && cs.opacity === '1' && cs.visibility === 'visible';
}, null, { timeout: 30000 }).then(() => true).catch(() => false);
if (!legendShown) failures.push('cfd legend never reached opacity 1 / visible with .show');
await page.screenshot({ path: `${OUT}/ui-polish-desktop-cfd-legend.png` });

await page.click('#btn-cfd');
const legendHidden = await page.waitForFunction(() => {
  const el = document.getElementById('cfd-legend');
  const cs = getComputedStyle(el);
  return !el.classList.contains('show') && cs.visibility === 'hidden';
}, null, { timeout: 30000 }).then(() => true).catch(() => false);
if (!legendHidden) failures.push('cfd legend never reached visibility hidden after toggle-off');

// Keyboard focus ring
await page.evaluate(() => document.querySelector('[data-car="F1"]').focus());
await page.keyboard.press('Tab');
await page.screenshot({ path: `${OUT}/ui-polish-desktop-focus.png` });

/* ── Click-through regression ──────────────────────────────────── */
// Env toggles: on → assert active, off again to leave a clean state.
for (const env of ['airflow', 'rain', 'cfd']) {
  await page.click(`.env-btn[data-env="${env}"]`);
  const on = await page.evaluate(
    e => document.querySelector(`.env-btn[data-env="${e}"]`).classList.contains('active'), env);
  if (!on) failures.push(`env ${env}: .active missing after click`);
  await page.click(`.env-btn[data-env="${env}"]`);
  const off = await page.evaluate(
    e => document.querySelector(`.env-btn[data-env="${e}"]`).classList.contains('active'), env);
  if (off) failures.push(`env ${env}: .active stuck after toggle-off`);
}

// Turn modes: exclusive active.
for (const mode of ['t5', 't10', 'only', 'auto']) {
  await page.click(`.turn-btn[data-turn-mode="${mode}"]`);
  const st = await page.evaluate(() => ({
    active: document.querySelector('.turn-btn.active')?.dataset.turnMode,
    count: document.querySelectorAll('.turn-btn.active').length,
  }));
  if (st.active !== mode || st.count !== 1)
    failures.push(`turn ${mode}: active=${st.active} count=${st.count}`);
}

// Speed presets: set the slider value; never take .active.
for (const speed of ['80', '280', '0']) {
  await page.click(`#speed-presets [data-speed="${speed}"]`);
  const st = await page.evaluate(() => ({
    slider: document.getElementById('speed-slider').value,
    activePresets: document.querySelectorAll('#speed-presets .preset-btn.active').length,
  }));
  if (st.slider !== speed) failures.push(`preset ${speed}: slider=${st.slider}`);
  if (st.activePresets !== 0) failures.push(`preset ${speed}: unexpected .active on speed preset`);
}

// Camera modes: exclusive active + label mirrors.
for (const cam of ['trackside', 'cockpit', 'drone', 'orbit']) {
  await page.click(`.cam-btn[data-cam="${cam}"]`);
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({
    active: document.querySelector('.cam-btn.active')?.dataset.cam,
    count: document.querySelectorAll('.cam-btn.active').length,
    label: document.getElementById('camera-label').textContent,
  }));
  if (st.active !== cam || st.count !== 1)
    failures.push(`cam ${cam}: active=${st.active} count=${st.count}`);
  if (!st.label.toLowerCase().includes(cam))
    failures.push(`cam ${cam}: label "${st.label}"`);
}
await page.close();

/* ── Mobile shots ──────────────────────────────────────────────── */
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
mob.setDefaultTimeout(90000);
mob.on('pageerror', e => pageErrors.push(`mobile: ${e.message}`));
await mob.goto('http://localhost:3000/', { waitUntil: 'load' });
await mob.waitForSelector('canvas');
await mob.waitForTimeout(6000);
await mob.screenshot({ path: `${OUT}/ui-polish-mobile-tabbar.png` });

await mob.click('.tab-btn[data-section="section-env"]');
await mob.waitForTimeout(500);
const mobOpen = await mob.evaluate(() => ({
  open: document.getElementById('panel-body').classList.contains('open'),
  activeSection: document.querySelector('#panel-body .ctrl-group.active')?.id,
}));
if (!mobOpen.open || mobOpen.activeSection !== 'section-env')
  failures.push(`mobile env section: ${JSON.stringify(mobOpen)}`);
await mob.screenshot({ path: `${OUT}/ui-polish-mobile-env-open.png` });
await mob.close();

await browser.close();

if (pageErrors.length) failures.push(`pageerrors: ${pageErrors.join(' | ')}`);
if (failures.length) {
  console.error('FAIL:', failures.join('; '));
  process.exit(1);
}
console.log('PASS — ui-polish shots captured, click-through contract held (env toggle, turn/cam exclusive, presets, no pageerrors)');
