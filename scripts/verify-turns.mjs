/* Drive the running dev server (port 3000) and capture the random-turn feature.
 * Speed 280 km/h → first turn fires 20–35 s in; sweep lasts 3–4 s. Screenshot
 * every 2.5 s for 55 s so several mid-turn frames are guaranteed, then enable
 * rain + airflow and capture a second turn window for the coupling. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots/turns';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(90000);
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);

await page.click('[data-speed="280"]');
for (let i = 0; i < 22; i++) {           // 55 s, every 2.5 s
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/a-${String(i).padStart(2, '0')}.png` });
}

// Second window with effects on — rain + airflow coupling during a turn.
await page.click('[data-env="rain"]');
await page.click('[data-env="airflow"]');
for (let i = 0; i < 16; i++) {           // 40 s more
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/b-${String(i).padStart(2, '0')}.png` });
}

const errs = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[error]'));
console.log(`console lines: ${logs.length}, errors: ${errs.length}`);
for (const e of errs.slice(0, 10)) console.log(e);
await browser.close();
process.exit(errs.length ? 1 : 0);
