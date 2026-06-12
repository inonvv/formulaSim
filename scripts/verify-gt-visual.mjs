/* Drive the running dev server (port 3000) and screenshot the GT wheel fix. */
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

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);                       // F1 GLB load + settle
await shoot(`${OUT}/01-f1-idle.png`);

await page.click('[data-car="GT"]');
await page.waitForTimeout(7000);                       // GT GLB load + split
await shoot(`${OUT}/02-gt-idle.png`);

await page.click('[data-speed="280"]');                // FAST
await page.waitForTimeout(2000);
await shoot(`${OUT}/03-gt-speed-a.png`);
await page.waitForTimeout(400);
await shoot(`${OUT}/04-gt-speed-b.png`);

// Rapid car swaps — swap-guard ghost check.
await page.click('[data-speed="0"]');
await page.click('[data-car="F1"]');
await page.waitForTimeout(150);
await page.click('[data-car="GT"]');
await page.waitForTimeout(150);
await page.click('[data-car="F1"]');
await page.waitForTimeout(150);
await page.click('[data-car="GT"]');
await page.waitForTimeout(7000);
await shoot(`${OUT}/05-gt-after-swaps.png`);

await page.click('[data-car="F1"]');
await page.waitForTimeout(6000);
await shoot(`${OUT}/06-f1-after.png`);

console.log('--- console log capture ---');
for (const l of logs) console.log(l);
await browser.close();
