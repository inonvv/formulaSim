/**
 * debug-overlay.js — Authoring instrumentation, gated by ?debug=1.
 *
 * When active, shows:
 *   • GridHelper at y = TRACK.SURFACE_Y — instant visual for "is the car on the track?"
 *   • AxesHelper at car origin (1m) — orientation check.
 *   • Box3Helper per GLB mesh — color-coded by manifest role:
 *       red    = stripMeshes (removed from scene)
 *       orange = liveryMeshes (painted)
 *       cyan   = wheelSources.front / wheelSources.rear (ground-ref)
 *   • HTML HUD — measure fields formatted to 3 decimals.
 *
 * When gate is off, every exported method is a no-op — zero runtime cost.
 *
 * Usage:
 *   const overlay = createDebugOverlay(scene);
 *   overlay.attach(carGroup, manifest, measure);  // in spawnCar
 *   overlay.detach();                             // before next spawn
 */

import * as THREE from 'three';
import { TRACK } from './scene-config.js';

export function isDebugEnabled() {
  if (typeof window === 'undefined' || !window.location) return false;
  const p = new URLSearchParams(window.location.search);
  return p.get('debug') === '1';
}

function createNoopOverlay() {
  return {
    enabled: false,
    attach() {},
    detach() {},
  };
}

export function createDebugOverlay(scene) {
  if (!isDebugEnabled()) return createNoopOverlay();

  // Track grid — green, fine divisions, lives at ground plane.
  const grid = new THREE.GridHelper(20, 40, 0x00ff00, 0x008800);
  grid.position.y = TRACK.SURFACE_Y;
  scene.add(grid);

  // HUD
  const hud = document.createElement('div');
  hud.id = 'debug-hud';
  hud.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'z-index:9999',
    'background:rgba(0,0,0,0.72)', 'color:#0f0', 'font-family:monospace',
    'font-size:11px', 'padding:8px 10px', 'border:1px solid #0f0',
    'white-space:pre', 'pointer-events:none',
  ].join(';');
  hud.textContent = '[debug overlay] no car yet';
  document.body.appendChild(hud);

  let attached = null;   // { carGroup, axes, boxHelpers[] }

  function renderHud(manifest, measure) {
    const m = measure || {};
    const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v));
    hud.textContent = [
      `[debug overlay] TRACK.SURFACE_Y = ${TRACK.SURFACE_Y}`,
      `groundContactY = ${fmt(m.groundContactY)}`,
      `baseY          = ${fmt(TRACK.SURFACE_Y - (m.groundContactY ?? 0))}`,
      `wheelRadius    = ${fmt(m.wheelRadius)}`,
      `wheelbase      = ${fmt(m.wheelbase)}`,
      `trackWidth     = ${fmt(m.trackWidth)}`,
      `front axle Z/X = ${fmt(m.frontAxleZ)} / ${fmt(m.frontAxleX)}`,
      `rear  axle Z/X = ${fmt(m.rearAxleZ)} / ${fmt(m.rearAxleX)}`,
    ].join('\n');
  }

  function classifyMesh(name, manifest) {
    if (!manifest) return 0xffffff;
    if (manifest.wheelSources) {
      if (name === manifest.wheelSources.front) return 0x00ffff;
      if (name === manifest.wheelSources.rear)  return 0x00ffff;
    }
    if (manifest.stripMeshes?.includes(name))   return 0xff3030;
    if (manifest.liveryMeshes?.includes(name))  return 0xffaa00;
    return 0x888888;
  }

  function attach(carGroup, manifest, measure) {
    detach();

    const axes = new THREE.AxesHelper(1);
    carGroup.add(axes);

    const boxHelpers = [];
    carGroup.traverse((child) => {
      if (!child.isMesh) return;
      const color = classifyMesh(child.name || '', manifest);
      const helper = new THREE.BoxHelper(child, color);
      scene.add(helper);
      boxHelpers.push(helper);
    });

    renderHud(manifest, measure);
    attached = { carGroup, axes, boxHelpers };
  }

  function detach() {
    if (!attached) return;
    const { carGroup, axes, boxHelpers } = attached;
    carGroup.remove(axes);
    boxHelpers.forEach((h) => {
      scene.remove(h);
      h.geometry?.dispose?.();
      h.material?.dispose?.();
    });
    hud.textContent = '[debug overlay] no car yet';
    attached = null;
  }

  return { enabled: true, attach, detach };
}
