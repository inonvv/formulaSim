/* Drive the running dev server (port 3000), wait for a random turn to
 * arrive under the car, and screenshot it from a chase camera — proving
 * the road visibly bends, the car leans, and the camera banks.
 * Prints the live curvature so the shot can be checked for sign:
 * κ > 0 = LEFT turn (nose toward −x). */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'scripts/_shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(90000);

const setCam = (pos, target) => page.evaluate(([p, t]) => {
  const { camera, orbit } = window.__fsim;
  camera.position.set(...p);
  orbit.target.set(...t);
  orbit.update();
}, [pos, target]);

const curvature = () => page.evaluate(() => {
  const tp = window.__fsim.trackPath;
  return tp.curvatureAt(tp.pose.s);
});

await page.goto('http://localhost:3000/', { waitUntil: 'load' });
await page.waitForSelector('canvas');
await page.waitForTimeout(6000);
await page.click('[data-speed="280"]');
await page.waitForTimeout(12000);                      // speed ramp

// Chase camera: behind and slightly above, looking up the road (−z).
await setCam([0, 1.4, 6.0], [0, 0.5, -4]);

// SwiftShader renders ~3 fps and the app clamps dt to 0.05 s, so the sim
// runs ~15× slow motion headless — waiting out a real 20–35 s turn gap
// would take minutes. Fast-forward the path directly instead: advance in
// 0.5 s sim chunks until the car sits mid-turn (the app loop re-places
// rows and poses the world from the same path state every frame).
const fastForwardToTurn = () => page.evaluate(() => {
  const tp = window.__fsim.trackPath;
  const v = 77.8;                                      // 280 km/h
  const kMid = 0.6 * (0.30 / v);                       // 60% of peak curvature
  for (let i = 0; i < 400; i++) {                      // ≤200 sim-seconds
    for (let j = 0; j < 10; j++) tp.update(0.05, v);
    tp.rebaseIfNeeded();
    const k = tp.curvatureAt(tp.pose.s);
    if (Math.abs(k) > kMid) return k;
  }
  return null;
});

// Fast-forward into the REAL_CORNER's constant-radius hold (shape 'real',
// |κ| = 1/85) — the signature R 85 m sweeper emitted every 3rd turn.
const fastForwardToRealCorner = () => page.evaluate(() => {
  const tp = window.__fsim.trackPath;
  const v = 77.8;
  for (let i = 0; i < 1200; i++) {                     // ≤600 sim-seconds
    for (let j = 0; j < 10; j++) tp.update(0.05, v);
    tp.rebaseIfNeeded();
    const s = tp.pose.s;
    const t = tp.turns.find(t => t.shape === 'real' && s > t.s0 + 12 && s < t.s1 - 12);
    if (t) return tp.curvatureAt(s);
  }
  return null;
});

// Straight-road reference first.
await page.screenshot({ path: `${OUT}/t0-straight-chase.png` });

for (let shot = 1; shot <= 2; shot++) {
  const k = await fastForwardToTurn();
  if (k === null) { console.log('no turn found — check scheduler'); break; }
  console.log(`turn shot ${shot}: curvature ${k.toFixed(5)} (${k > 0 ? 'LEFT' : 'RIGHT'})`);
  await page.waitForTimeout(1500);                     // let rows recycle + bank settle
  await page.screenshot({ path: `${OUT}/t${shot}-turn-chase.png` });
}

const kr = await fastForwardToRealCorner();
if (kr === null) {
  console.log('REAL corner not reached');
} else {
  console.log(`REAL corner: curvature ${kr.toFixed(5)} = R ${(1 / Math.abs(kr)).toFixed(1)} m (${kr > 0 ? 'LEFT' : 'RIGHT'})`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/t3-real-corner-chase.png` });
}

await browser.close();
