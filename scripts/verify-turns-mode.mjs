/* Verify the TURNS frequency control end-to-end against the running dev
 * server (port 3000): click the `10 /30s` preset, confirm TrackPath switched
 * mode, fast-forward 60 SIMULATED seconds at 180 km/h via
 * __fsim.trackPath.update loops (SwiftShader runs ~15× slow — never wait
 * wall-clock for turns), and assert the car actually drives through ≥ 2
 * turns. Screenshot must show the active `10 /30s` button + TURNS chip. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(90000);

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);

await page.click('[data-turn-mode="t10"]');
await page.click('[data-speed="180"]');
await page.waitForTimeout(12000);                      // speed ramp (headless slow-mo)

const kmh = await page.evaluate(() =>
  document.getElementById('speed-value').textContent);
console.log(`HUD speed: ${kmh} km/h`);

// UI state: exclusive active button + effects chip mirror the selection.
const ui = await page.evaluate(() => ({
  activeMode: document.querySelector('.turn-btn.active')?.dataset.turnMode,
  activeCount: document.querySelectorAll('.turn-btn.active').length,
  chips: [...document.querySelectorAll('#effects-chips .chip')].map(c => c.textContent),
  pathMode: window.__fsim.trackPath.turnMode,
}));
console.log('UI state:', JSON.stringify(ui));

// Fast-forward 60 simulated seconds at 180 km/h (50 m/s). Count distinct
// turns the CAR drives through via off→on curvature transitions (robust
// across rebases, which remap turn arc-lengths).
const drive = await page.evaluate(() => {
  const tp = window.__fsim.trackPath;
  const v = 50;
  let inTurn = false, encountered = 0;
  const emitted0 = tp.turns.length;
  for (let i = 0; i < 1200; i++) {                     // 1200 × 0.05 s = 60 s
    tp.update(0.05, v);
    const on = Math.abs(tp.curvatureAt(tp.pose.s)) > 1e-5;
    if (on && !inTurn) encountered++;
    inTurn = on;
    tp.rebaseIfNeeded();
  }
  return { encountered, emittedDuring: tp.turns.length - emitted0 };
});
console.log(`t10 over 60 sim-s: turns encountered ${drive.encountered}, emitted ${drive.emittedDuring}`);

await page.waitForTimeout(1500);                       // let rows recycle
await page.screenshot({ path: `${OUT}/turns-t10-mode.png` });

await browser.close();

const failures = [];
if (ui.activeMode !== 't10') failures.push(`active button is ${ui.activeMode}, want t10`);
if (ui.activeCount !== 1) failures.push(`${ui.activeCount} active turn buttons, want 1`);
if (ui.pathMode !== 't10') failures.push(`trackPath.turnMode is ${ui.pathMode}, want t10`);
if (!ui.chips.some(c => c.includes('TURNS 10/30s'))) failures.push(`no TURNS chip: ${ui.chips}`);
if (drive.encountered < 2) failures.push(`only ${drive.encountered} turns encountered in 60 s, want ≥ 2`);

if (failures.length) {
  console.error('FAIL:', failures.join('; '));
  process.exit(1);
}
console.log('PASS — TURNS t10 mode verified (button, chip, path mode, turn rate)');
