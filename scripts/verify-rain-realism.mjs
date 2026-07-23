/* Drive the running dev server (port 3000) and screenshot the reworked
 * rain: velocity-aligned streaks (angle grows with speed), ground splash
 * layer, and the airflow+rain combined view. Camera is placed
 * deterministically via the window.__fsim debug hook (main.js).
 * Headless slow-motion rules apply: SwiftShader runs ~15× slower than
 * real time, so wait long after each speed chip and log the km/h readout
 * before every shot. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(90000);
const shoot = (path) => page.screenshot({ path, timeout: 90000 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

const setCam = (pos, target) => page.evaluate(([p, t]) => {
  const { camera, orbit } = window.__fsim;
  camera.position.set(...p);
  orbit.target.set(...t);
  orbit.update();
}, [pos, target]);

const kmh = () => page.evaluate(() =>
  document.querySelector('#speed-value')?.textContent ?? '?');

// Headless slow-mo: the ramp takes minutes of wall time — wait on the LIVE
// readout, not a fixed timeout.
const waitForSpeed = (target) => page.waitForFunction((t) => {
  const v = parseFloat(document.querySelector('#speed-value')?.textContent ?? '0');
  return v >= t - 5;
}, target, { timeout: 240000, polling: 500 });

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);                       // F1 GLB load + settle

await page.click('#btn-rain');
await page.waitForTimeout(2000);

// Side-on view — streak angle is read against the car profile.
await setCam([6.0, 1.2, 0], [0, 0.6, 0]);
await page.waitForTimeout(1200);
console.log(`shot r1 @ ${await kmh()} km/h (expect 0 — vertical streaks)`);
await shoot(`${OUT}/r1-rain-idle-side.png`);

// Close-up — individual streaks + size/brightness variation.
await setCam([2.5, 0.9, 1.2], [0, 0.6, 0]);
await page.waitForTimeout(1200);
console.log(`shot r1b @ ${await kmh()} km/h (close-up, vertical streaks)`);
await shoot(`${OUT}/r1b-rain-idle-close.png`);

// Low ground-level view — splash layer at the road surface.
await setCam([4.0, 0.3, 1.5], [0, -0.2, 0]);
await page.waitForTimeout(1200);
console.log(`shot r2 @ ${await kmh()} km/h (splash layer, idle)`);
await shoot(`${OUT}/r2-rain-idle-ground.png`);

await page.click('[data-speed="180"]');
await waitForSpeed(180);
await setCam([6.0, 1.2, 0], [0, 0.6, 0]);
await page.waitForTimeout(1200);
console.log(`shot r3 @ ${await kmh()} km/h (expect ≈180 — streaks lean back)`);
await shoot(`${OUT}/r3-rain-180-side.png`);

// Rear-¾ — spray + rooster tails read as soft round mist (no square sprites).
await setCam([3.5, 1.6, 5.5], [0, 0.4, 1.4]);
await page.waitForTimeout(1200);
console.log(`shot r3b @ ${await kmh()} km/h (rear-¾ — spray/rooster soft mist)`);
await shoot(`${OUT}/r3b-mist-180-rear34.png`);

await page.click('[data-speed="350"]');
await waitForSpeed(345);
await setCam([6.0, 1.2, 0], [0, 0.6, 0]);
await page.waitForTimeout(1200);
console.log(`shot r4 @ ${await kmh()} km/h (expect ≈350 — near-horizontal streaks)`);
await shoot(`${OUT}/r4-rain-350-side.png`);

// Rear-¾ at top speed — full rooster plume, mist must not wash out the car.
await setCam([3.5, 1.6, 5.5], [0, 0.4, 1.4]);
await page.waitForTimeout(1200);
console.log(`shot r4b @ ${await kmh()} km/h (rear-¾ — rooster plume growth)`);
await shoot(`${OUT}/r4b-mist-350-rear34.png`);

// Density check around the car under full sweep (upstream-biased respawn).
await setCam([0, 1.4, -7.5], [0, 0.6, 0]);
await page.waitForTimeout(1200);
console.log(`shot r5 @ ${await kmh()} km/h (front view — box stays filled)`);
await shoot(`${OUT}/r5-rain-350-front.png`);

// Airflow + rain combined — coherence check.
await page.click('#btn-airflow');
await page.waitForTimeout(3000);
await setCam([6.0, 1.2, 0], [0, 0.6, 0]);
await page.waitForTimeout(1200);
console.log(`shot r6 @ ${await kmh()} km/h (airflow + rain combined)`);
await shoot(`${OUT}/r6-rain-airflow-350.png`);

console.log('--- console log capture ---');
for (const l of logs) console.log(l);
await browser.close();
