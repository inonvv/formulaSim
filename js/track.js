/**
 * track.js — Procedural track environment for FormulaSim
 * Builds asphalt surface, markings, barriers, and tyre stacks.
 */

import * as THREE from 'three';

export function buildTrack() {
  const grp = new THREE.Group();
  grp.name = 'track';

  /* ── Asphalt ground ─────────────────────────────────────────── */
  const canvas = document.createElement('canvas');
  canvas.width  = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Dark grey base
  ctx.fillStyle = '#1c1c1c';
  ctx.fillRect(0, 0, 512, 512);

  // 9000 random aggregate dots
  for (let i = 0; i < 9000; i++) {
    const x  = Math.random() * 512;
    const y  = Math.random() * 512;
    const r  = Math.random() * 1.4 + 0.3;
    const v  = Math.floor(Math.random() * 40 + 20);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Faint racing-line gradient (centre strip, worn smooth)
  const grad = ctx.createLinearGradient(256, 0, 256, 512);
  grad.addColorStop(0,    'rgba(60,60,60,0)');
  grad.addColorStop(0.15, 'rgba(60,60,60,0.18)');
  grad.addColorStop(0.5,  'rgba(55,55,55,0.28)');
  grad.addColorStop(0.85, 'rgba(60,60,60,0.18)');
  grad.addColorStop(1,    'rgba(60,60,60,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(170, 0, 172, 512);

  const groundTex = new THREE.CanvasTexture(canvas);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.repeat.set(18, 36);

  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTex,
    roughness: 0.88,
    metalness: 0.04,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 70), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.34;
  ground.receiveShadow = true;
  grp.add(ground);

  /* ── Start / finish band ────────────────────────────────────── */
  const sfBand = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 0.45),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  sfBand.rotation.x = -Math.PI / 2;
  sfBand.position.set(0, -0.333, 0);
  grp.add(sfBand);

  /* ── Centre-line dashes ─────────────────────────────────────── */
  const dashMat   = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const dashMeshes = [];
  for (let z = -28; z <= 28; z += 4) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 2.2), dashMat);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, -0.332, z);
    dashMeshes.push(dash);
    grp.add(dash);
  }

  /* ── Red/white rumble strips ────────────────────────────────── */
  const rumbleRed   = new THREE.MeshBasicMaterial({ color: 0xcc1111 });
  const rumbleWhite = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  const rumbleGroup = new THREE.Group();
  for (const side of [-1, 1]) {
    const xPos = side * 5.55;
    for (let z = -28; z <= 28; z += 0.6) {
      const idx = Math.round((z + 28) / 0.6);
      const mat = idx % 2 === 0 ? rumbleRed : rumbleWhite;
      const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.58), mat);
      seg.rotation.x = -Math.PI / 2;
      seg.position.set(xPos, -0.331, z);
      rumbleGroup.add(seg);
    }
  }
  grp.add(rumbleGroup);

  /* ── Armco barriers ─────────────────────────────────────────── */
  const armcoMat = new THREE.MeshStandardMaterial({
    color: 0xbbbbbb,
    roughness: 0.35,
    metalness: 0.75,
  });
  for (const side of [-1, 1]) {
    const barrier = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.38, 68),
      armcoMat
    );
    barrier.position.set(side * 6.4, -0.15, 0);
    barrier.castShadow  = true;
    barrier.receiveShadow = true;
    grp.add(barrier);
  }

  /* ── Tyre stacks ────────────────────────────────────────────── */
  const tyreColors = [0x222222, 0xdd1111];
  for (const side of [-1, 1]) {
    const xPos = side * 7.2;
    for (let z = -28; z <= 28; z += 1.2) {
      for (let row = 0; row < 2; row++) {
        const colorIdx = (Math.round((z + 28) / 1.2) + row) % 2;
        const tyreMat  = new THREE.MeshStandardMaterial({
          color:     tyreColors[colorIdx],
          roughness: 0.82,
          metalness: 0.05,
        });
        const tyre = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.22, 0.2, 16),
          tyreMat
        );
        tyre.position.set(xPos, -0.34 + 0.22 + row * 0.44, z);
        tyre.castShadow    = true;
        tyre.receiveShadow = true;
        grp.add(tyre);
      }
    }
  }

  return { group: grp, groundTex, dashMeshes, rumbleGroup, sfBand };
}
