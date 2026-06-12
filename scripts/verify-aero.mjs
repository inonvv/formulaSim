/* Verify removals + per-car aero: F1/GT with airflow and CFD active. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(90000);
const shoot = (p) => page.screenshot({ path: p, timeout: 90000 });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);

// UI checks: removed buttons must be gone.
const f2 = await page.$('[data-car="F2"]');
const f3 = await page.$('[data-car="F3"]');
const opt = await page.$('[data-env="optimal"]');
console.log('UI: F2 btn', f2 ? 'PRESENT (BAD)' : 'gone', '| F3 btn', f3 ? 'PRESENT (BAD)' : 'gone', '| optimal btn', opt ? 'PRESENT (BAD)' : 'gone');

// F1 + airflow at speed.
await page.click('[data-env="airflow"]');
await page.click('[data-speed="280"]');
await page.waitForTimeout(9000);
await shoot(`${OUT}/30-f1-airflow.png`);

// F1 + CFD.
await page.click('[data-env="airflow"]');
await page.click('[data-env="cfd"]');
await page.waitForTimeout(3000);
await shoot(`${OUT}/31-f1-cfd.png`);

// GT + CFD.
await page.click('[data-car="GT"]');
await page.waitForTimeout(8000);
await shoot(`${OUT}/32-gt-cfd.png`);

// GT + airflow.
await page.click('[data-env="cfd"]');
await page.click('[data-env="airflow"]');
await page.waitForTimeout(4000);
await shoot(`${OUT}/33-gt-airflow.png`);

console.log('--- console (non-debug) ---');
for (const l of logs.filter(l => !l.includes('[debug]'))) console.log(l);
await browser.close();
