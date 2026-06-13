/* Load the DEPLOYED GitHub Pages site fresh (no service-worker cache) and
 * confirm the GLB F1 + GT models render in the production build. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = 'https://inonvv.github.io/formulaSim/';
const OUT = 'scripts/_shots/live';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
// Fresh context = no service worker, no cache — simulates a first-time visitor.
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(90000);
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', r => logs.push(`[reqfail] ${r.url()} — ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(7000);                       // F1 GLB load
await page.screenshot({ path: `${OUT}/01-f1.png` });

await page.click('[data-car="GT"]');
await page.waitForTimeout(8000);                       // GT GLB load + split
await page.screenshot({ path: `${OUT}/02-gt.png` });

const glbLogs = logs.filter(l => /glb|sdf|wheel|split|loader|error|fail/i.test(l));
console.log('--- relevant console lines ---');
for (const l of glbLogs.slice(0, 25)) console.log(l);
const errs = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[reqfail]'));
console.log(`\ntotal console: ${logs.length}, errors/failed-requests: ${errs.length}`);
await browser.close();
