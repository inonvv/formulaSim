/* Verify the cockpit rain-on-visor post pass: enabled + strong in cockpit
 * with rain at speed, smoothly disabled in orbit. Headless is ~15× slow —
 * poll live values (fixed waits under-shoot both the speed ramp and the
 * 0.4 s-tau intensity decay, which needs ~25 real seconds here). */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(120000);

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);

await page.click('[data-cam="cockpit"]');
await page.click('[data-env="rain"]');
await page.click('[data-speed="280"]');
await page.waitForFunction(() =>
  Number(document.getElementById('speed-value').textContent) > 200);

await page.waitForFunction(() => {
  const rl = window.__fsim.rainLens;
  return rl && rl.enabled && rl.uniforms.uIntensity.value > 0.5;
});
const wet = await page.evaluate(() => ({
  enabled: window.__fsim.rainLens.enabled,
  intensity: window.__fsim.rainLens.uniforms.uIntensity.value,
  speed: window.__fsim.rainLens.uniforms.uSpeed.value,
}));
console.log('cockpit+rain:', JSON.stringify(wet));
await page.screenshot({ path: `${OUT}/rain-lens-cockpit.png` });

await page.click('[data-cam="orbit"]');
await page.waitForFunction(() => {
  const rl = window.__fsim.rainLens;
  return rl && !rl.enabled && rl.uniforms.uIntensity.value < 0.02;
});
console.log('orbit: pass decayed and disabled');

await browser.close();

const failures = [];
if (!wet.enabled) failures.push('pass not enabled in cockpit+rain');
if (wet.intensity <= 0.5) failures.push(`intensity ${wet.intensity} too low`);
if (wet.speed <= 0.5) failures.push(`uSpeed ${wet.speed} not tracking speed`);
if (failures.length) {
  console.error('FAIL:', failures.join('; '));
  process.exit(1);
}
console.log('PASS — rain-on-visor verified (cockpit strong, orbit decays off)');
