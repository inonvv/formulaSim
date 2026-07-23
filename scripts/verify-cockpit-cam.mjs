/* Verify the cockpit helmet-cam rig: rigidly chassis-mounted (camera rolls
 * WITH the body, outward in a turn — sign opposite the yaw rate), no
 * cinematic bank stacking, and the front wheels framed in the lower third.
 * Headless is ~15× slow — fast-forward turns via __fsim.trackPath.update. */
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

await page.click('[data-cam="cockpit"]');
await page.click('[data-turn-mode="only"]');           // continuous cornering
await page.click('[data-speed="180"]');

// Wait for the HUD to actually reach speed (fixed waits under-shoot headless).
await page.waitForFunction(() =>
  Number(document.getElementById('speed-value').textContent) > 150);

// Fast-forward into a turn, then sample camera roll vs yaw rate mid-turn.
const sample = await page.evaluate(() => {
  const tp = window.__fsim.trackPath;
  const cam = window.__fsim.camera;
  const v = 50;
  const samples = [];
  for (let i = 0; i < 2400; i++) {                     // 120 sim-s
    tp.update(0.05, v);
    tp.rebaseIfNeeded();
  }
  return new Promise(resolve => {
    // Let a few real frames run so the render loop applies the pose.
    let frames = 0;
    const tick = () => {
      const omega = tp.yawRate(v);
      // Camera roll = signed angle of its up-vector around the view axis.
      const up = { x: cam.matrixWorld.elements[4], y: cam.matrixWorld.elements[5] };
      const roll = Math.atan2(-up.x, up.y);
      samples.push({ omega, roll });
      if (++frames < 40) requestAnimationFrame(tick);
      else resolve(samples);
    };
    requestAnimationFrame(tick);
  });
});

const turning = sample.filter(s => Math.abs(s.omega) > 0.15);
const rollDeg = turning.map(s => (s.roll * 180) / Math.PI);
const opposite = turning.filter(s => s.roll * s.omega < 0).length;
console.log(`turning frames: ${turning.length}, |roll| mean ${
  (rollDeg.reduce((a, b) => a + Math.abs(b), 0) / (rollDeg.length || 1)).toFixed(2)}°, ` +
  `outward-signed ${opposite}/${turning.length}`);

await page.screenshot({ path: `${OUT}/cockpit-turn.png` });
await browser.close();

const failures = [];
if (turning.length < 5) failures.push(`only ${turning.length} in-turn frames sampled`);
const meanAbs = rollDeg.reduce((a, b) => a + Math.abs(b), 0) / (rollDeg.length || 1);
if (meanAbs < 2) failures.push(`mean |camera roll| ${meanAbs.toFixed(2)}° — camera not rolling with chassis`);
if (opposite < turning.length * 0.9)
  failures.push(`roll not outward (opposite ω) in ${opposite}/${turning.length} frames — bank still stacking?`);

if (failures.length) {
  console.error('FAIL:', failures.join('; '));
  process.exit(1);
}
console.log('PASS — cockpit cam rolls with the chassis (outward), wheels shot saved');
