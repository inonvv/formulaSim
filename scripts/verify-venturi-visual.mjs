/* Drive the running dev server (port 3000) and screenshot the venturi
 * underfloor streaks. Camera is placed deterministically via the
 * window.__fsim debug hook (main.js) — mouse-drag orbiting proved
 * unreliable headless and left every shot top-down. */
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

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);                       // F1 GLB load + settle

await page.click('#btn-airflow');
await page.click('[data-speed="280"]');
await page.waitForTimeout(12000);                      // let the speed ramp settle near 280
await shoot(`${OUT}/v1-f1-airflow-default.png`);

// Low side-on view — the floor gap and full streak length in profile.
await setCam([6.0, 0.6, 0], [0, 0.25, 0]);
await page.waitForTimeout(1200);
await shoot(`${OUT}/v2-f1-side-low.png`);

// Closer low side, framing splitter → diffuser.
await setCam([4.0, 0.35, 0.6], [0, 0.15, 0.5]);
await page.waitForTimeout(1200);
await shoot(`${OUT}/v3-f1-side-low-zoom.png`);

// Rear three-quarter low — diffuser upwash and lateral expansion.
await setCam([3.0, 0.8, 4.4], [0, 0.3, 1.0]);
await page.waitForTimeout(1200);
await shoot(`${OUT}/v4-f1-rear-quarter.png`);

// Ground-level, just off the rear corner looking up the floor gap — the
// only angle where the venturi lanes are fully unoccluded.
await setCam([1.6, 0.18, 3.4], [0, 0.10, 0.8]);
await page.waitForTimeout(1200);
await shoot(`${OUT}/v4b-f1-floor-gap.png`);

// GT for the per-car table difference.
await page.click('[data-car="GT"]');
await page.waitForTimeout(7000);                       // GT GLB load + split
await setCam([6.0, 0.6, 0], [0, 0.25, 0]);
await page.waitForTimeout(1200);
await shoot(`${OUT}/v5-gt-side-low.png`);

console.log('--- console log capture ---');
for (const l of logs) console.log(l);
await browser.close();
