/**
 * coin-visuals.js — thin THREE wrapper for arcade coins (game plan Phase B).
 *
 * Coins live in trackGroup (plan decision 2): meshes are positioned in
 * TRACK SPACE via rowPose each frame, so the group's inverse car pose and
 * the −playerX strafe offset are inherited for free — the collision test
 * in coins.js stays a pure (s, lat) comparison against the origin.
 *
 * Pool layout follows track.js: fixed mesh pool, no per-frame allocation.
 * Collection pop: scale 1 → 1.4 → 0 over 0.25 s + 8 additive sparkle
 * points (rooster-tail/mist sprite pattern). Logic in coins.js; this file
 * is render-only and is covered by coin-visuals.test.js with mocked three.
 */

import * as THREE from 'three';
import { rowPose } from './track-path.js';

export const COIN_VIS = {
  POOL:      64,     // torus pool — covers back-to-back arcs across the 175 m live span
  RADIUS:    0.41,   // + TUBE → 1.0 m outer diameter (plan)
  TUBE:      0.09,
  HOVER_Y:   0.66,   // 1.0 m above the road surface (SURFACE_Y −0.34) — driver-head height
  SPIN:      2.5,    // rad/s
  BOB_AMP:   0.1,    // m
  BOB_HZ:    1.5,
  POP_TIME:  0.25,   // s — collection scale pop 1 → 1.4 → 0
  POP_POOL:  6,      // simultaneous pops (combo bursts)
  SPARKS:    8,      // sparkle sprites per pop (plan: 6–10)
  SPARK_TIME: 0.45,  // s — sparkle flight + fade
};

export function buildCoinVisuals(parent) {
  const V = COIN_VIS;
  const group = new THREE.Group();
  group.name = 'coins';
  parent.add(group);

  const coinGeo = new THREE.TorusGeometry(V.RADIUS, V.TUBE, 10, 24);
  const coinMat = new THREE.MeshStandardMaterial({
    color: 0xffc428,
    emissive: 0xffaa00,
    emissiveIntensity: 0.6,
    metalness: 0.85,
    roughness: 0.25,
  });

  const meshes = [];
  for (let i = 0; i < V.POOL; i++) {
    const m = new THREE.Mesh(coinGeo, coinMat);
    m.visible = false;
    group.add(m);
    meshes.push(m);
  }

  // ── Collection pops: torus that scale-pops + additive sparkle points ──
  const sparkMat = new THREE.PointsMaterial({
    color: 0xffd766,
    size: 0.16,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const pops = [];
  for (let i = 0; i < V.POP_POOL; i++) {
    const torus = new THREE.Mesh(coinGeo, coinMat);
    torus.visible = false;
    group.add(torus);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V.SPARKS * 3), 3));
    const points = new THREE.Points(pg, sparkMat.clone());   // per-pop opacity fade
    points.visible = false;
    group.add(points);
    pops.push({ torus, points, vels: new Float32Array(V.SPARKS * 3), t: -1 });
  }

  /** Fire a collection burst at the coin's track-space spot. */
  function pop(coin, path) {
    const slot = pops.find(p => p.t < 0) ?? pops[0];
    const rp = rowPose(path, coin.s, coin.lat);
    slot.t = 0;
    slot.torus.position.set(rp.x, V.HOVER_Y, rp.z);
    slot.torus.rotation.y = rp.rotY;
    slot.torus.scale.setScalar(1);
    slot.torus.visible = true;
    const pos = slot.points.geometry.attributes.position.array;
    for (let i = 0; i < V.SPARKS; i++) {
      pos[i * 3]     = rp.x;
      pos[i * 3 + 1] = V.HOVER_Y;
      pos[i * 3 + 2] = rp.z;
      // radial fan with a small upward kick — deterministic, visual-only
      const a = (i / V.SPARKS) * Math.PI * 2;
      const sp = 1.5 + (i % 3) * 0.8;
      slot.vels[i * 3]     = Math.cos(a) * sp;
      slot.vels[i * 3 + 1] = 1.2 + (i % 2) * 0.9;
      slot.vels[i * 3 + 2] = Math.sin(a) * sp;
    }
    slot.points.geometry.attributes.position.needsUpdate = true;
    slot.points.material.opacity = 1;
    slot.points.visible = true;
  }

  /**
   * Per-frame: place the live pool over field.coins (spin + bob), advance
   * pops. `visible` false hides everything (sim mode / arcade menu).
   */
  function update(field, path, time, dt, visible) {
    const coins = field.coins;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      const c = visible ? coins[i] : null;
      if (!c) { m.visible = false; continue; }
      const rp = rowPose(path, c.s, c.lat);
      const phase = (c.id ?? i) * 1.7;
      m.position.set(
        rp.x,
        V.HOVER_Y + V.BOB_AMP * Math.sin(2 * Math.PI * V.BOB_HZ * time + phase),
        rp.z,
      );
      m.rotation.y = rp.rotY + V.SPIN * time + phase;
      m.visible = true;
    }

    for (const p of pops) {
      if (p.t < 0) continue;
      p.t += dt;
      const u = p.t / V.POP_TIME;
      if (u < 1) {
        // 1 → 1.4 over the first 40%, then 1.4 → 0
        const s = u < 0.4 ? 1 + (u / 0.4) * 0.4 : 1.4 * (1 - (u - 0.4) / 0.6);
        p.torus.scale.setScalar(Math.max(s, 1e-3));
      } else {
        p.torus.scale.setScalar(1e-3);
        p.torus.visible = false;
      }
      const pos = p.points.geometry.attributes.position.array;
      for (let i = 0; i < V.SPARKS; i++) {
        p.vels[i * 3 + 1] -= 4 * dt;               // soft gravity on the sparks
        pos[i * 3]     += p.vels[i * 3] * dt;
        pos[i * 3 + 1] += p.vels[i * 3 + 1] * dt;
        pos[i * 3 + 2] += p.vels[i * 3 + 2] * dt;
      }
      p.points.geometry.attributes.position.needsUpdate = true;
      p.points.material.opacity = Math.max(0, 1 - p.t / V.SPARK_TIME);
      if (p.t >= V.SPARK_TIME) {
        p.t = -1;
        p.points.visible = false;
        p.torus.visible = false;
      }
    }
  }

  return { group, meshes, pops, pop, update };
}
