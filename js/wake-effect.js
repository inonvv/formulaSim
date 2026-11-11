/**
 * wake-effect.js — the "dirty air" layer: particles carried along the
 * modelled wake pathlines (wake-paths.js), coloured by how much energy the
 * air has lost. Thin THREE wrapper; all the flow logic is pure and tested.
 *
 * One Points object, fixed buffers, no per-frame allocation. The stream
 * list is rebuilt only when the car or its state changes enough to matter
 * (quantised), never per frame.
 */
import * as THREE from 'three';
import { bendLookup } from './track-path.js';
import { wakeGeometry, wakeStreams, sampleStream, streamLength, dirtColor } from './wake-paths.js';

const COUNT = 2600;
const CORE_PTS = 28;          // samples per pathline core

function makeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aFade;
      attribute vec3 aColor;
      varying float vFade;
      varying vec3 vColor;
      void main() {
        vFade = aFade;
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vFade;
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d);
        if (r > 0.5) discard;
        float soft = smoothstep(0.5, 0.1, r);
        gl_FragColor = vec4(vColor, uOpacity * vFade * soft);
      }`,
    transparent: true,
    depthWrite: false,
    // Normal blending: additive vanishes against this scene's bright road.
    blending: THREE.NormalBlending,
  });
}

/** Quantise a state value so tiny changes do not rebuild the streams. */
const q = (v, step) => Math.round((Number.isFinite(v) ? v : 0) / step) * step;

export class WakeEffect {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'wake';
    scene.add(this.group);

    this._speed = 0;
    this._visible = false;
    this._baseY = 0;
    this._pathBend = null;
    this._crosswind = 0;
    this._geo = wakeGeometry(null);
    this._state = { steer: 0, loadL: 1, loadR: 1, rearGain: 1, floorGain: 1 };
    this._key = '';
    this._streams = [];

    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const size = new Float32Array(COUNT);
    const fade = new Float32Array(COUNT);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
    this._mat = makeMaterial();
    this.points = new THREE.Points(g, this._mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this._pos = pos; this._col = col; this._size = size; this._fade = fade;

    // Per-particle constants: which stream, where along it, where across it.
    this._pStream = new Uint16Array(COUNT);
    this._pU = new Float32Array(COUNT);
    this._pAng = new Float32Array(COUNT);
    this._pRad = new Float32Array(COUNT);
    this._pSeed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this._pU[i] = Math.random();
      this._pAng[i] = Math.random() * Math.PI * 2;
      this._pRad[i] = Math.sqrt(Math.random());      // uniform over the disc
      this._pSeed[i] = Math.random() * 100;
    }
    // Pathline cores: one thin coloured line per stream, so the ROUTE the
    // air takes is readable even where the particles are sparse.
    this._cores = [];
    this._coreMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
    for (let i = 0; i < 12; i++) {
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CORE_PTS * 3), 3));
      cg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(CORE_PTS * 3), 3));
      const line = new THREE.Line(cg, this._coreMat);
      line.frustumCulled = false;
      this.group.add(line);
      this._cores.push(line);
    }

    this._rebuild();
    this.group.visible = false;
  }

  setBaseY(y) { this._baseY = y || 0; this.group.position.y = this._baseY; }

  setCarType(_type, measure) {
    this._geo = wakeGeometry(measure);
    this._key = '';
    this._rebuild();
  }

  setSpeed(speed) { this._speed = speed; }
  setVisible(v) { this._visible = !!v; this.group.visible = this._visible; }
  setPathBend(table) { this._pathBend = table; }
  setCrosswind(c) { this._crosswind = c || 0; }

  /** Aero-setup gains (vehicle model): rear wing and floor loading. */
  setAeroSetup(gains) {
    this._state.rearGain = Number.isFinite(gains?.rearWing) ? gains.rearWing : 1;
    this._state.floorGain = Number.isFinite(gains?.floor) ? gains.floor : 1;
    this._rebuild();
  }

  /**
   * Cornering state: steer angle [rad, + = left] and the front tyres' load
   * relative to static (the loaded outer tyre sheds the bigger wake).
   */
  setTurnFlow({ steer = 0, loadL = 1, loadR = 1 } = {}) {
    this._state.steer = steer;
    this._state.loadL = loadL;
    this._state.loadR = loadR;
    this._rebuild();
  }

  /** Rebuild the stream list when the quantised state really changed. */
  _rebuild() {
    const s = this._state;
    const key = [q(s.steer, 0.01), q(s.loadL, 0.1), q(s.loadR, 0.1), q(s.rearGain, 0.05), q(s.floorGain, 0.05)].join('|');
    if (key === this._key && this._streams.length) return false;
    this._key = key;
    this._streams = wakeStreams(this._geo, s);
    this._lengths = this._streams.map(streamLength);
    // Share the particles between streams by weight.
    const total = this._streams.reduce((a, st) => a + st.weight, 0);
    let i = 0;
    this._streams.forEach((st, si) => {
      const n = si === this._streams.length - 1 ? COUNT - i : Math.round(COUNT * st.weight / total);
      for (let k = 0; k < n && i < COUNT; k++, i++) this._pStream[i] = si;
    });
    return true;
  }

  update(dt, t) {
    if (!this._visible) return;
    const sf = Math.min(this._speed / 350, 1);
    const mps = this._speed / 3.6;
    this._mat.uniforms.uOpacity.value = Math.min(0.9, sf * 2.6);
    this._coreMat.opacity = Math.min(0.95, sf * 3);
    const moving = sf > 0.01;
    this.points.visible = moving;
    for (const c of this._cores) c.visible = moving;
    if (!moving) return;

    // Cores follow the same curved air and crosswind as the particles.
    for (let si = 0; si < this._cores.length; si++) {
      const st = this._streams[si];
      const line = this._cores[si];
      if (!st) { line.visible = false; continue; }
      const cp = line.geometry.attributes.position.array;
      const cc = line.geometry.attributes.color.array;
      for (let k = 0; k < CORE_PTS; k++) {
        const p = sampleStream(st, k / (CORE_PTS - 1));
        let x = p.x + bendLookup(this._pathBend, p.z);
        if (this._crosswind) x += (this._crosswind * (p.z - this._geo.zf)) / Math.max(mps, 8);
        cp[k * 3] = x; cp[k * 3 + 1] = p.y; cp[k * 3 + 2] = p.z;
        const c = dirtColor(p.dirt);
        cc[k * 3] = c[0]; cc[k * 3 + 1] = c[1]; cc[k * 3 + 2] = c[2];
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.attributes.color.needsUpdate = true;
    }

    const pos = this._pos, col = this._col, size = this._size, fade = this._fade;
    const zRef = this._geo.zf;
    for (let i = 0; i < COUNT; i++) {
      const si = this._pStream[i];
      const st = this._streams[si];
      // Air leaves the car at roughly car speed; the wake is slower (it has
      // lost energy), so dirtier streams drift back more gently.
      const len = this._lengths[si] || 1;
      let u = this._pU[i] + (dt * mps * 0.55) / len;
      if (u >= 1) { u -= Math.floor(u); this._pAng[i] = Math.random() * Math.PI * 2; }
      this._pU[i] = u;

      const p = sampleStream(st, u);
      const seed = this._pSeed[i];
      let ang = this._pAng[i], rad = this._pRad[i] * p.r;
      if (st.vortex) {
        // Tip vortex: particles wind helically around the core.
        ang += st.side * (u * 22 + t * 6);
        rad = (0.45 + 0.55 * this._pRad[i]) * p.r;
      }
      // Turbulence: dirtier air wanders more.
      const wob = p.dirt * p.r * 0.45;
      const ox = Math.cos(ang) * rad + Math.sin(t * 7.1 + seed) * wob;
      const oy = Math.sin(ang) * rad * 0.8 + Math.cos(t * 5.3 + seed * 1.7) * wob;

      let x = p.x + ox;
      const y = Math.max(this._geo.g + 0.03, p.y + oy);
      const z = p.z + Math.sin(t * 3.7 + seed * 0.9) * wob * 0.6;
      // The wake rides the same curved air as the streamlines: it trails
      // toward the outside of a turn, and shears with a crosswind.
      x += bendLookup(this._pathBend, z);
      if (this._crosswind) x += (this._crosswind * (z - zRef)) / Math.max(mps, 8);

      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const c = dirtColor(p.dirt);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      size[i] = (0.17 + 0.6 * p.r) * (st.scale || 1);
      // Fade in at the source, thin out as the wake diffuses.
      fade[i] = Math.min(1, u * 14) * (1 - u) * (0.35 + 0.65 * p.dirt);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true;
    a.aColor.needsUpdate = true;
    a.aSize.needsUpdate = true;
    a.aFade.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this._mat.dispose();
    for (const c of this._cores) c.geometry.dispose();
    this._coreMat.dispose();
    this.scene.remove(this.group);
  }
}
