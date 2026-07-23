/* Verify CFD heat-point emphasis against the running dev server (port 3000,
 * override with FSIM_PORT).
 *
 * In-session A/B: the PRE-change colour pipeline (cfd-effect.js @ ee4ffd9,
 * materialised via `git show` into a temp module Vite serves) repaints the
 * SAME overlay meshes in the SAME session/camera/speed as the baseline shot;
 * the current pipeline is then restored for the after shot. This isolates
 * the emphasis change from load order, camera and speed-ramp noise.
 *
 * Note: a plain checkout-the-old-build baseline is impossible to capture
 * deterministically — before this branch, main.js never propagated the
 * per-frame speed to cfd.setSpeed, so a single preset click left the CFD
 * overlay at opacity ≈0 in a headless session (bug fixed in Phase 4).
 *
 * Headless notes (project memory): SwiftShader runs the sim ~15× slow
 * motion, so speed is awaited via the km/h readout, never a fixed sleep.
 * Camera is placed via the window.__fsim {camera, orbit} hook.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';

const OUT      = 'scripts/_shots';
const PORT     = process.env.FSIM_PORT || 3000;
const PRE_HASH = 'ee4ffd9';                       // main @ branch point — pre-emphasis pipeline
const TMP_OLD  = 'js/cfd-effect-pre-emphasis.tmp.js';
mkdirSync(OUT, { recursive: true });

/* Materialise the pre-change module where Vite can serve + transform it. */
const oldSource = execSync(`git show ${PRE_HASH}:js/cfd-effect.js`, { encoding: 'utf8' });
writeFileSync(TMP_OLD, oldSource);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);

const setCam = (pos, target) => page.evaluate(([p, t]) => {
  const { camera, orbit } = window.__fsim;
  camera.position.set(...p);
  orbit.target.set(...t);
  orbit.update();
}, [pos, target]);

const readSpeed = () => page.evaluate(() =>
  parseInt(document.getElementById('speed-value').textContent, 10));

const waitSpeed = (min, max = Infinity) => page.waitForFunction(([lo, hi]) => {
  const v = parseInt(document.getElementById('speed-value').textContent, 10);
  return v >= lo && v <= hi;
}, [min, max], { timeout: 180000 });

/* Front-¾ view: nose is at −z, so the camera sits ahead-left of the car. */
const FRONT34 = [[3.4, 1.7, -4.6], [0, 0.5, 0]];
const REAR34  = [[3.4, 1.7,  4.8], [0, 0.6, 0]];

/* Mid-body crop (px @1280×720): the car body in the FRONT34 framing —
 * clear of the legend (bottom-left), HUD (bottom-centre) and panel (right). */
const CROP = { x: 440, y: 330, w: 400, h: 200 };

async function shotLum(path) {
  const buf = await page.screenshot({ path });
  const b64 = buf.toString('base64');
  return page.evaluate(async ({ b64, crop }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(crop.x, crop.y, crop.w, crop.h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    return sum / (d.length / 4);
  }, { b64, crop: CROP });
}

/* Repaint the live overlay with the PRE-change pipeline (old
 * computeSurfaceCp + raw cpToColor, opacity sf·0.85, all blobs visible). */
const paintOld = () => page.evaluate(async (tmpPath) => {
  const oldMod = await import(/* @vite-ignore */ '/' + tmpPath);
  const core   = await import(/* @vite-ignore */ '/js/airflow-core.js');
  const cfd = window.__fsim.cfd;
  const sf = Math.min(cfd._speed / 350, 1);
  for (const { mesh } of cfd._surfaceMeshes) {
    const pos = mesh.geometry.attributes.position;
    const nrm = mesh.geometry.attributes.normal;
    const col = mesh.geometry.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const cp = oldMod.computeSurfaceCp(
        pos.getX(i), pos.getY(i), pos.getZ(i),
        nrm ? nrm.getX(i) : 0, nrm ? nrm.getY(i) : 1, nrm ? nrm.getZ(i) : 0,
        cfd._type, cfd._anchors, sf,
      );
      const c = core.cpToColor(cp);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    mesh.material.opacity = sf * 0.85;
  }
  for (const m of cfd._blobMeshes) m.visible = true;   // pre-declutter
  // Pin: stop update() from re-baking with the NEW pipeline this frame.
  cfd._speedDirty = false;
  cfd._lastBuiltSpeed = cfd._speed;
  return sf;
}, TMP_OLD);

/* Restore the current pipeline: force a recolor + rebuild blob visibility. */
const paintNew = () => page.evaluate(() => {
  const cfd = window.__fsim.cfd;
  for (const m of cfd._blobMeshes) {
    if (m.userData.blobRole === 'stagnation' || m.userData.blobRole === 'cockpit') {
      m.visible = false;                                // GLB overlay declutter
    }
  }
  cfd._speedDirty = true;
  cfd._lastBuiltSpeed = -9999;                          // recolor next update()
});

let fail = false;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(8000);          // GLB load + occupancy voxelization
  await page.click('#btn-cfd');
  await page.click('[data-speed="280"]');
  await waitSpeed(275);                      // slow-mo ramp — poll the readout

  await setCam(...FRONT34);
  await page.waitForTimeout(1500);

  /* baseline: old pipeline on the same frame */
  const sf = await paintOld();
  await page.waitForTimeout(700);
  const lumOld = await shotLum(`${OUT}/cfd-baseline-front34.png`);

  /* after: current pipeline */
  await paintNew();
  await page.waitForTimeout(1500);           // frames pass → update() recolours
  const lumNew = await shotLum(`${OUT}/cfd-after-front34.png`);

  const drop = lumOld - lumNew;
  console.log(`(a) front-3/4 @ ${await readSpeed()} km/h (sf ${sf.toFixed(2)})`);
  console.log(`    mid-body luminance: old wash ${lumOld.toFixed(2)} → emphasis ${lumNew.toFixed(2)}  (drop ${drop.toFixed(2)} = ${(100 * drop / lumOld).toFixed(1)}%)`);
  if (!(lumNew < lumOld)) { console.error('FAIL: mid-body luminance did not drop'); fail = true; }

  /* (d) legend visible while CFD is active */
  const legendOn = await page.evaluate(() => {
    const el = document.getElementById('cfd-legend');
    return !!el && el.classList.contains('show') && getComputedStyle(el).display !== 'none';
  });
  console.log(`(d) legend visible with CFD on: ${legendOn}`);
  if (!legendOn) { console.error('FAIL: legend not visible'); fail = true; }

  /* (b) rear-¾ — rear-wing suction + diffuser blue, no cockpit blob */
  await setCam(...REAR34);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/cfd-after-rear34.png` });
  console.log('(b) rear-3/4 shot captured');

  /* (c) 100 km/h — emphasis pattern still legible */
  await page.evaluate(() => {
    const s = document.getElementById('speed-slider');
    s.value = 100;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitSpeed(95, 110);
  await setCam(...FRONT34);
  await page.waitForTimeout(1500);
  const lum100 = await shotLum(`${OUT}/cfd-after-100kmh.png`);
  console.log(`(c) front-3/4 @ ${await readSpeed()} km/h — mid-body luminance ${lum100.toFixed(2)}`);
} finally {
  await browser.close();
  unlinkSync(TMP_OLD);                       // scratch module — never committed
}

if (fail) process.exitCode = 1;
