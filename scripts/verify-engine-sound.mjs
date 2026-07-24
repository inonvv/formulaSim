/* Verify the engine-sound feature against the running dev server (port 3000).
 *
 * Playwright can't hear — this asserts STATE via window.__fsim.engineAudio:
 *   1. gesture unlock: no AudioContext before pointerdown; 'running' after.
 *   2. pitch: fundamental in the F1 gear-4 band at 180 km/h and RISING
 *      while the speed lerps through the band.
 *   3. blip trigger demo: forcing 49→50 km/h advances the gear and arms the
 *      80 ms blip window (_blipUntil moves past ctx.currentTime).
 *   4. rain layer: rainGain > 0 only while the rain env is on.
 *   5. mute → masterGain ≈ 0; slider 20 → volume² = 0.04; unmute restores.
 *   6. persistence: settings survive a reload via localStorage('fsim-audio').
 *   7. coarse perf: JS heap growth < 5 MB over 30 s at speed (no per-frame
 *      node/alloc leak from the audio path).
 *
 * HEADLESS SLOW-MO: SwiftShader renders ~3 fps and main.js clamps dt, so the
 * sim runs ~15× slow — speed is fast-forwarded via __fsim.state directly.
 */
import { chromium } from 'playwright';

const failures = [];
const pageErrors = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(90000);
page.on('pageerror', e => pageErrors.push(e.message));

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(5000);

const dbg = () => page.evaluate(() => window.__fsim.engineAudio.debugState());

/* ── 1. Gesture unlock ─────────────────────────────────────────── */
const pre = await dbg();
ok(pre.ctxState === 'idle', `pre-gesture ctxState should be 'idle', got ${pre.ctxState}`);

await page.mouse.click(400, 400);          // pointerdown on the canvas
const running = await page.waitForFunction(
  () => window.__fsim.engineAudio.debugState().ctxState === 'running',
  null, { timeout: 15000 }).then(() => true).catch(() => false);
ok(running, 'ctx.state never reached running after canvas click');

/* ── 2. Pitch at 180 km/h (F1 gear 4) + rising through the band ── */
// Deterministic in-band samples (the lerp can outrun slow-mo waits): pin
// the sim to gear-4 low, sample, then gear-4 high, sample again.
const pinSpeed = v => page.evaluate(sp => {
  const s = window.__fsim.state;
  s.speed = sp; s.targetSpeed = sp;
}, v);
await pinSpeed(165);
await page.waitForTimeout(800);
const fLow = (await dbg()).fundamentalHz;
await pinSpeed(180);
await page.waitForTimeout(800);
const at180 = await dbg();
ok(at180.gear === 4, `gear at ~180 km/h should be 4, got ${at180.gear}`);
ok(at180.fundamentalHz > fLow,
  `fundamental should rise through gear 4 (${fLow.toFixed(1)} → ${at180.fundamentalHz.toFixed(1)})`);
// F1 gear-4 band edges: 160 → (55+0)·(0.85+0.3·160/350) ≈ 54.3 Hz,
//                       210 → (55+165)·(0.85+0.3·210/350) ≈ 226.6 Hz.
ok(at180.fundamentalHz > 54 && at180.fundamentalHz < 227,
  `fundamental at 180 km/h out of the F1 gear-4 band: ${at180.fundamentalHz}`);

/* ── 3. Blip trigger demo — 49 → 50 km/h crossing ──────────────── */
const blip = await page.evaluate(async () => {
  const s = window.__fsim.state;
  const ea = window.__fsim.engineAudio;
  const frame = () => new Promise(r => requestAnimationFrame(r));
  s.speed = 49; s.targetSpeed = 49;
  await frame(); await frame();
  const before = { gear: ea.debugState().gear, blipUntil: ea._blipUntil,
                   t: ea.ctx.currentTime };
  s.speed = 50; s.targetSpeed = 50;
  await frame(); await frame();
  const after = { gear: ea.debugState().gear, blipUntil: ea._blipUntil,
                  t: ea.ctx.currentTime };
  return { before, after };
});
ok(blip.before.gear === 1 && blip.after.gear === 2,
  `blip demo gears: expected 1→2, got ${blip.before.gear}→${blip.after.gear}`);
ok(blip.after.blipUntil > blip.before.blipUntil && blip.after.blipUntil > blip.before.t,
  `49→50 crossing did not arm the blip window (${blip.before.blipUntil} → ${blip.after.blipUntil})`);
console.log(`blip demo: gear ${blip.before.gear}→${blip.after.gear}, ` +
  `blip window armed at t=${blip.before.t.toFixed(3)}s until ${blip.after.blipUntil.toFixed(3)}s`);

/* ── 4. Rain layer ─────────────────────────────────────────────── */
const rainOff = (await dbg()).rainGain;
ok(rainOff !== null && rainOff < 0.005, `rainGain should be ~0 with rain off, got ${rainOff}`);
await page.click('#btn-rain');
await page.waitForTimeout(2000);           // τ 60 ms smoothing + slow frames
const rainOn = (await dbg()).rainGain;
ok(rainOn > 0.02, `rainGain should be > 0 with rain on at speed, got ${rainOn}`);
await page.click('#btn-rain');
await page.waitForTimeout(2000);
ok((await dbg()).rainGain < 0.01, 'rainGain did not fall back toward 0 after rain off');

/* ── 5. Mute / volume ──────────────────────────────────────────── */
await page.click('#mute-btn');
await page.waitForTimeout(1200);
let d = await dbg();
ok(d.muted === true && d.masterTarget === 0, `mute: target should be 0, got ${d.masterTarget}`);
ok(d.masterGain < 0.02, `mute: masterGain should decay to ~0, got ${d.masterGain}`);
const muteUI = await page.evaluate(() => ({
  pressed: document.getElementById('mute-btn').getAttribute('aria-pressed'),
  icon: document.getElementById('mute-btn').textContent.trim(),
  cls: document.getElementById('mute-btn').classList.contains('muted'),
}));
ok(muteUI.pressed === 'true' && muteUI.cls && muteUI.icon === '🔇',
  `mute button UI wrong: ${JSON.stringify(muteUI)}`);

await page.click('#mute-btn');             // unmute — volume preserved
await page.fill('#volume-slider', '20');   // fires input → volume 0.2
await page.waitForTimeout(1200);
d = await dbg();
ok(Math.abs(d.masterTarget - 0.04) < 1e-6,
  `volume 20 should target 0.2² = 0.04, got ${d.masterTarget}`);
ok(Math.abs(d.masterGain - 0.04) < 0.02,
  `masterGain should approach 0.04, got ${d.masterGain}`);

/* ── 6. Persistence across reload ──────────────────────────────── */
await page.click('#mute-btn');             // leave muted:true, volume:0.2
const stored = await page.evaluate(() => localStorage.getItem('fsim-audio'));
ok(!!stored, 'fsim-audio missing from localStorage');
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(4000);
const restored = await page.evaluate(() => ({
  audio: window.__fsim.state.audio,
  slider: document.getElementById('volume-slider').value,
  pressed: document.getElementById('mute-btn').getAttribute('aria-pressed'),
  icon: document.getElementById('mute-btn').textContent.trim(),
}));
ok(restored.audio.muted === true && Math.abs(restored.audio.volume - 0.2) < 1e-6,
  `restored settings wrong: ${JSON.stringify(restored.audio)}`);
ok(restored.slider === '20' && restored.pressed === 'true' && restored.icon === '🔇',
  `restored UI wrong: ${JSON.stringify(restored)}`);
// Restored-muted graph builds silent after the next gesture.
await page.mouse.click(400, 400);
await page.waitForTimeout(1500);
d = await dbg();
ok(d.ctxState === 'running' && d.masterTarget === 0,
  `restored-muted session should build silent: ${JSON.stringify(d)}`);

/* ── 7. Coarse perf — heap growth < 5 MB over 30 s at speed ────── */
await page.evaluate(() => {
  const s = window.__fsim.state;
  s.speed = 280; s.targetSpeed = 280;
});
await page.waitForTimeout(3000);           // let transients settle
const heap0 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? -1);
await page.waitForTimeout(30000);
const heap1 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? -1);
if (heap0 > 0 && heap1 > 0) {
  const growth = (heap1 - heap0) / 1048576;
  console.log(`heap growth over 30 s: ${growth.toFixed(2)} MB`);
  ok(growth < 5, `heap grew ${growth.toFixed(2)} MB over 30 s (limit 5)`);
} else {
  console.log('performance.memory unavailable — heap check skipped');
}

await browser.close();

if (pageErrors.length) failures.push(`pageerrors: ${pageErrors.join(' | ')}`);
if (failures.length) {
  console.error('FAIL:', failures.join('; '));
  process.exit(1);
}
console.log('PASS — engine sound: gesture unlock, gear-4 pitch band + rise, ' +
  '49→50 blip armed, rain layer gain, mute/volume curve, localStorage persistence, heap stable');
