/**
 * engine-audio.test.js — Web Audio engine-sound synth (engine-audio.js).
 *
 * No real AudioContext in Node: a plain-JS mock context records every node
 * built and every AudioParam write (method calls AND direct `.value =` sets)
 * so the suite can assert:
 *   EA1 — lazy graph: nothing before resume(), built exactly once, setters
 *         safe pre-resume, fixed node counts.
 *   EA2 — pitch model: fundamentalHz monotonic in-gear, F1 > GT, bounded.
 *   EA3 — shift blip: exactly one blip on a gear boundary, none within a
 *         gear; upshift adds a one-shot noise "pop" source.
 *   EA4 — mute/volume: perceptual volume² curve, mute → 0, unmute restores.
 *   EA5 — rain layer: exact 0.04 + 0.06·sf gain mapping, 0 when off.
 *   EA6 — no zipper: after resume, params only move via scheduled methods
 *         (setTargetAtTime / ramps), never direct `.value =` writes.
 *   EA7 — localStorage settings: load/save round-trip, junk-tolerant,
 *         pre-resume setMuted/setVolume apply at graph build.
 */
import { describe, it, expect } from 'vitest';
import {
  EngineAudio, VOICES, HARMONICS, cycleHz, harmonicRecipe, harmonicPhase,
  loadGain, loadBrightnessHz, jitterCents, windGain, scrubGain, crackleChance,
  coinPickupHz, countdownHz, loadAudioSettings, saveAudioSettings, AUDIO_STORE_KEY,
} from '../engine-audio.js';
import { POWERTRAIN, firingHz } from '../powertrain.js';

/* ── Mock Web Audio ─────────────────────────────────────────────── */

function makeParam(ctx, init = 0) {
  const p = {
    _value: init,
    directSets: [],   // `.value =` writes (allowed at init only)
    calls: [],        // scheduled writes
    setTargetAtTime(v, t, tau) { p.calls.push({ m: 'setTargetAtTime', v, t, tau }); p._value = v; },
    setValueAtTime(v, t)       { p.calls.push({ m: 'setValueAtTime', v, t }); p._value = v; },
    exponentialRampToValueAtTime(v, t) { p.calls.push({ m: 'expRamp', v, t }); p._value = v; },
    linearRampToValueAtTime(v, t)      { p.calls.push({ m: 'linRamp', v, t }); p._value = v; },
    cancelScheduledValues(t)   { p.calls.push({ m: 'cancel', t }); },
  };
  Object.defineProperty(p, 'value', {
    get: () => p._value,
    set: (v) => { p.directSets.push(v); p._value = v; },
  });
  ctx.allParams.push(p);
  return p;
}

class MockAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.destination = { name: 'destination', connect() {} };
    this.allParams = [];
    this.created = { osc: 0, gain: 0, biquad: 0, buffer: 0, bufferSrc: 0, wave: 0, limiter: 0 };
    this.oscNodes  = [];   // every oscillator in creation order (EA8 one-shots)
    this.gainNodes = [];
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close()  { this.state = 'closed';  return Promise.resolve(); }
  createOscillator() {
    this.created.osc++;
    const osc = { type: 'sine', frequency: makeParam(this, 440), detune: makeParam(this, 0), wave: null,
                  setPeriodicWave(w) { this.wave = w; this.type = 'custom'; },
                  connect() {}, disconnect() {},
                  started: null, stopped: null,
                  start(t) { this.started = t ?? 0; }, stop(t) { this.stopped = t ?? 0; } };
    this.oscNodes.push(osc);
    return osc;
  }
  createGain() {
    this.created.gain++;
    const g = { gain: makeParam(this, 1), connect() {}, disconnect() {} };
    this.gainNodes.push(g);
    return g;
  }
  createBiquadFilter() {
    this.created.biquad++;
    return { type: 'lowpass', frequency: makeParam(this, 350), Q: makeParam(this, 1), gain: makeParam(this, 0),
             connect() {}, disconnect() {} };
  }
  createPeriodicWave(real, imag) {
    this.created.wave++;
    return { real: Float32Array.from(real), imag: Float32Array.from(imag) };
  }
  createDynamicsCompressor() {
    this.created.limiter++;
    const p = () => makeParam(this, 0);
    return { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect() {}, disconnect() {} };
  }
  createBuffer(channels, length, rate) {
    this.created.buffer++;
    const data = new Float32Array(length);
    return { length, sampleRate: rate, numberOfChannels: channels, getChannelData: () => data };
  }
  createBufferSource() {
    this.created.bufferSrc++;
    return { buffer: null, loop: false, playbackRate: makeParam(this, 1),
             connect() {}, disconnect() {}, start() {}, stop() {} };
  }
}

function makeEngine() {
  let ctx = null;
  let factoryCalls = 0;
  const ea = new EngineAudio(() => { factoryCalls++; ctx = new MockAudioContext(); return ctx; });
  return { ea, getCtx: () => ctx, getFactoryCalls: () => factoryCalls };
}

/* ── EA1 — lazy graph ───────────────────────────────────────────── */

describe('EngineAudio — lazy graph build (EA1)', () => {
  it('EA1a. builds NOTHING before resume — factory never called', () => {
    const { getFactoryCalls } = makeEngine();
    expect(getFactoryCalls()).toBe(0);
  });

  it('EA1b. all setters are safe (no throw) before resume', () => {
    const { ea } = makeEngine();
    expect(() => {
      ea.setSpeed(120); ea.setCarType('GT'); ea.setRain(true); ea.setRainIntensity(0.4);
      ea.setPaused(true); ea.setMuted(true); ea.setVolume(0.4);
      ea.setDrive({ throttle: 1, rpm: 9000, rpm01: 0.5, gear: 3, shifted: 1, speedMps: 40 });
      ea.update(0.016); ea.thunder(); ea.coinPickup(2); ea.countdownBlip(1);
    }).not.toThrow();
    expect(ea.nodes).toBeNull();
  });

  it('EA1c. resume builds the graph once with fixed node counts; update never grows it', () => {
    const { ea, getCtx, getFactoryCalls } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    expect(getFactoryCalls()).toBe(1);
    expect(ctx.state).toBe('running');
    const counts = { ...ctx.created };
    // core + core2 + sub + two jitter LFOs + turbo whistle
    expect(counts.osc).toBe(6);
    // one shared noise buffer, looped by exhaust + rain + wind + scrub
    expect(counts.buffer).toBe(1);
    expect(counts.bufferSrc).toBe(4);
    // 3 formants + engine lowpass + exhaust BP + rain HP/LP + wind LP + scrub BP + pop BP
    expect(counts.biquad).toBe(10);
    // core, core2, sub, engine, jitter depth, noise, rain, turbo, wind, scrub, pop, master
    expect(counts.gain).toBe(12);
    expect(counts.wave).toBe(1);
    expect(counts.limiter).toBe(1);

    ea.resume();
    expect(getFactoryCalls()).toBe(1);
    ea.setDrive({ throttle: 1, rpm: 9000, rpm01: 0.5, gear: 3, shifted: 0, speedMps: 40 });
    const snap = { ...ctx.created };
    for (let i = 0; i < 20; i++) ea.update(0.016);
    expect(ctx.created).toEqual(snap);
  });

  it('EA1d. the two voice oscillators carry the custom cycle wave', () => {
    const { ea } = makeEngine();
    ea.resume();
    expect(ea.nodes.core.type).toBe('custom');
    expect(ea.nodes.core2.wave).toBe(ea.nodes.core.wave);
    expect(ea.nodes.core.wave.real.length).toBe(HARMONICS + 1);
    expect(ea.nodes.sub.type).toBe('sine');
  });

  it('EA1e. changing car rebuilds the wave and retunes the formants; same car does not', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    ea.setCarType('F1');
    expect(ctx.created.wave).toBe(1);
    ea.setCarType('GT');
    expect(ctx.created.wave).toBe(2);
    const targets = ea.nodes.formants.map(f => [...f.frequency.calls].reverse().find(c => c.m === 'setTargetAtTime').v);
    expect(targets).toEqual(VOICES.GT.formants);
  });
});

/* ── EA2 — the voice (pure) ─────────────────────────────────────── */

describe('EngineAudio — combustion-pulse voice (EA2)', () => {
  it('EA2a. one engine cycle is two revolutions; six firings per cycle', () => {
    expect(cycleHz(12000)).toBeCloseTo(100, 9);
    expect(firingHz('F1', 12000)).toBeCloseTo(6 * cycleHz(12000), 9);
  });
  it('EA2b. firing harmonics lead; the bank-to-bank order gives body; half-orders give the growl', () => {
    const a = harmonicRecipe(VOICES.F1, 6);
    expect(a[0]).toBe(0);
    expect(a[6]).toBeGreaterThan(a[5]);
    expect(a[6]).toBeGreaterThan(a[7]);
    expect(a[3]).toBeGreaterThan(a[2]);            // an octave below the firing note
    expect(a[3]).toBeGreaterThan(a[4]);
    expect(a[1]).toBeGreaterThan(0);               // half-orders are never silent
    expect(a[5]).toBeGreaterThan(0);
  });
  it('EA2c. the spectrum falls away — nothing harsh on top', () => {
    for (const v of Object.values(VOICES)) {
      const a = harmonicRecipe(v, 6);
      expect(a[36]).toBeLessThan(a[6] * 0.08);
      expect(a[60]).toBeLessThan(a[6] * 0.03);
      for (let k = 12; k + 6 <= HARMONICS; k += 6) expect(a[k + 6]).toBeLessThan(a[k]);
    }
  });
  it('EA2d. it is not a few bare partials: energy is spread over many harmonics', () => {
    for (const [name, v] of Object.entries(VOICES)) {
      const a = harmonicRecipe(v, 6);
      let total = 0, top = 0, audible = 0;
      for (let k = 1; k <= HARMONICS; k++) { total += a[k] * a[k]; top = Math.max(top, a[k] * a[k]); }
      for (let k = 1; k <= HARMONICS; k++) if (a[k] * a[k] > top * 0.01) audible++;
      expect(top / total, name).toBeLessThan(0.45);          // no single dominant whine
      expect(audible, name).toBeGreaterThanOrEqual(12);
    }
  });
  it('EA2e. the GT is rougher and darker than the F1', () => {
    expect(VOICES.GT.rough).toBeGreaterThan(VOICES.F1.rough);
    VOICES.GT.formants.forEach((f, i) => expect(f).toBeLessThan(VOICES.F1.formants[i]));
  });
  it('EA2f. phases are deterministic and scattered', () => {
    expect(harmonicPhase(7)).toBe(harmonicPhase(7));
    const ph = [];
    for (let k = 1; k <= 40; k++) { const p = harmonicPhase(k); expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(Math.PI * 2); ph.push(p); }
    expect(new Set(ph.map(p => p.toFixed(2))).size).toBeGreaterThan(30);
  });
  it('EA2g. load: full throttle is louder and brighter than a lift; brightness is capped', () => {
    expect(loadGain(0.8, 1)).toBeGreaterThan(loadGain(0.8, 0) * 2);
    expect(loadBrightnessHz(0.8, 1)).toBeGreaterThan(loadBrightnessHz(0.8, 0) + 600);
    for (const r of [0, 0.5, 1, 9]) for (const l of [0, 1, 9]) {
      expect(loadBrightnessHz(r, l)).toBeLessThanOrEqual(3000);
      expect(loadBrightnessHz(r, l)).toBeGreaterThanOrEqual(400);
    }
    expect(loadGain(1, 1)).toBeCloseTo(0.70, 9);
  });
  it('EA2h. jitter is lumpy at tick-over and nearly steady at speed', () => {
    expect(jitterCents(0, 0)).toBeGreaterThan(20);
    expect(jitterCents(0.5, 1)).toBeLessThan(6);
    expect(jitterCents(1, 1)).toBeGreaterThan(0);
  });
  it('EA2i. wind grows with v², louder in the wet, capped', () => {
    expect(windGain(0, false)).toBe(0);
    expect(windGain(45, false)).toBeCloseTo(windGain(90, false) / 4, 9);
    expect(windGain(60, true)).toBeGreaterThan(windGain(60, false));
    expect(windGain(500, true)).toBeLessThanOrEqual(0.24 + 1e-9);
  });
  it('EA2j. tyres are silent until worked hard, quieter in the wet', () => {
    expect(scrubGain(0.5, 50, false)).toBe(0);
    expect(scrubGain(1.0, 50, false)).toBeGreaterThan(0);
    expect(scrubGain(1.0, 50, true)).toBeLessThan(scrubGain(1.0, 50, false));
    expect(scrubGain(1.0, 0, false)).toBe(0);
    expect(scrubGain(9, 50, false)).toBeLessThanOrEqual(0.12 + 1e-9);
  });
  it('EA2k. crackle only on a closed throttle at high revs', () => {
    expect(crackleChance(VOICES.GT, 0.8, 1, 0.016)).toBe(0);
    expect(crackleChance(VOICES.GT, 0.2, 0, 0.016)).toBe(0);
    expect(crackleChance(VOICES.GT, 0.8, 0, 0.016)).toBeGreaterThan(0);
    expect(crackleChance(VOICES.GT, 0.8, 0, 99)).toBe(1);
  });
  it('EA2l. only the turbo cars whistle', () => {
    expect(VOICES.F1.turbo).toBeGreaterThan(0);
    expect(VOICES.F2.turbo).toBeGreaterThan(0);
    expect(VOICES.F3.turbo).toBe(0);
    expect(VOICES.GT.turbo).toBe(0);
  });
});

/* ── EA3 — driven behaviour ─────────────────────────────────────── */

const drive = (o = {}) => ({ throttle: 1, rpm: 10000, rpm01: 0.65, gear: 4, shifted: 0, speedMps: 60, usage: 0.3, wet: false, ...o });
const lastTarget = (param) => [...param.calls].reverse().find(c => c.m === 'setTargetAtTime')?.v;

describe('EngineAudio — follows the engine (EA3)', () => {
  it('EA3a. pitch is the cycle frequency of the real rpm; the sub sits at half the firing rate', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setDrive(drive({ rpm: 8400 }));
    ea.setSpeed(300);                      // ignored for pitch in driven mode
    ea.update(0.016);
    expect(lastTarget(ea.nodes.core.frequency)).toBeCloseTo(70, 9);
    expect(lastTarget(ea.nodes.core2.frequency)).toBeCloseTo(70, 9);
    expect(lastTarget(ea.nodes.sub.frequency)).toBeCloseTo(210, 9);
    expect(ea.debugState().driven).toBe(true);
    expect(ea.debugState().firingHz).toBeCloseTo(420, 9);
  });
  it('EA3b. an upshift drops the note by the ratio step, not to the floor', () => {
    const p = POWERTRAIN.F1;
    const after = cycleHz(p.shift * p.vGear[2] / p.vGear[3]) / cycleHz(p.shift);   // 3rd → 4th
    expect(after).toBeGreaterThan(0.75);
    expect(after).toBeLessThan(0.92);
  });
  it('EA3c. lifting off drops the engine level and closes the filter', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setDrive(drive({ throttle: 1 }));
    ea.update(0.016);
    const gOn = lastTarget(ea.nodes.engineGain.gain), fOn = lastTarget(ea.nodes.lowpass.frequency);
    ea.setDrive(drive({ throttle: 0 }));
    ea.update(0.016);
    expect(lastTarget(ea.nodes.engineGain.gain)).toBeLessThan(gOn * 0.6);
    expect(lastTarget(ea.nodes.lowpass.frequency)).toBeLessThan(fOn);
  });
  it('EA3d. a reported shift blips once: level dips and recovers', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setDrive(drive());
    ea.update(0.016);
    const ramps = () => ea.nodes.engineGain.gain.calls.filter(c => c.m === 'expRamp').length;
    const r0 = ramps();
    ea.setSpeed(49); ea.setSpeed(51); ea.setSpeed(101);      // speed alone never shifts in driven mode
    expect(ramps()).toBe(r0);
    ea.setDrive(drive({ gear: 5, shifted: 1 }));
    expect(ramps()).toBe(r0 + 2);
    ea.setDrive(drive({ gear: 5, shifted: 0 }));
    expect(ramps()).toBe(r0 + 2);
  });
  it('EA3e. downshift flares the note up, upshift sags it — on both voice oscillators', () => {
    const { ea } = makeEngine();
    ea.resume();
    const fc = cycleHz(9000);
    const firstRamp = (calls) => calls.filter(c => c.m === 'expRamp').slice(-2)[0].v;
    ea.setDrive(drive({ gear: 3, shifted: -1, rpm: 9000 }));
    expect(firstRamp(ea.nodes.core.frequency.calls)).toBeCloseTo(fc * 1.10, 6);
    expect(firstRamp(ea.nodes.core2.frequency.calls)).toBeCloseTo(fc * 1.10, 6);
    ea.setDrive(drive({ gear: 4, shifted: 1, rpm: 9000 }));
    expect(firstRamp(ea.nodes.core.frequency.calls)).toBeCloseTo(fc * 0.88, 6);
  });
  it('EA3f. upshift pops (one noise one-shot); downshift does not', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea._rng = () => 0.999999;                                 // no crackle
    ea.setDrive(drive());
    const base = getCtx().created.bufferSrc;
    ea.setDrive(drive({ gear: 5, shifted: 1 }));
    expect(getCtx().created.bufferSrc).toBe(base + 1);
    ea.setDrive(drive({ gear: 4, shifted: -1 }));
    expect(getCtx().created.bufferSrc).toBe(base + 1);
  });
  it('EA3g. turbo spools with load on the F1 and stays silent on the GT', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setDrive(drive({ throttle: 1, rpm01: 0.9 }));
    for (let i = 0; i < 120; i++) ea.update(0.016);
    expect(ea.debugState().boost).toBeGreaterThan(0.7);
    expect(lastTarget(ea.nodes.turboGain.gain)).toBeGreaterThan(0.005);
    ea.setDrive(drive({ throttle: 0, rpm01: 0.9 }));
    for (let i = 0; i < 120; i++) ea.update(0.016);
    expect(ea.debugState().boost).toBeLessThan(0.05);
    ea.setCarType('GT');
    ea.setDrive(drive({ throttle: 1, rpm01: 0.9 }));
    for (let i = 0; i < 120; i++) ea.update(0.016);
    expect(lastTarget(ea.nodes.turboGain.gain)).toBeLessThan(1e-4);
  });
  it('EA3h. overrun crackle fires only off-throttle at revs', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea._rng = () => 0;                                        // always under the chance
    const ctx = getCtx();
    ea.setDrive(drive({ throttle: 1, rpm01: 0.9 }));
    const base = ctx.created.bufferSrc;
    for (let i = 0; i < 10; i++) ea.update(0.016);
    expect(ctx.created.bufferSrc).toBe(base);
    ea.setDrive(drive({ throttle: 0, rpm01: 0.9 }));
    for (let i = 0; i < 10; i++) ea.update(0.016);
    expect(ctx.created.bufferSrc).toBe(base + 10);
  });
  it('EA3i. paused idles the engine: idle pitch, half level, no wind, no crackle', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea._rng = () => 0;
    ea.setDrive(drive({ throttle: 0, rpm01: 0.9, speedMps: 80 }));
    ea.setPaused(true);
    const base = getCtx().created.bufferSrc;
    ea.update(0.016);
    expect(lastTarget(ea.nodes.core.frequency)).toBeCloseTo(cycleHz(POWERTRAIN.F1.idle), 9);
    expect(lastTarget(ea.nodes.engineGain.gain)).toBeCloseTo(loadGain(0, 0) * 0.5, 9);
    expect(lastTarget(ea.nodes.windGain.gain)).toBe(0);
    expect(getCtx().created.bufferSrc).toBe(base);
  });
  it('EA3j. without setDrive the same voice is derived from speed through the gearbox', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setSpeed(0);
    ea.update(0.016);
    expect(lastTarget(ea.nodes.core.frequency)).toBeCloseTo(cycleHz(POWERTRAIN.F1.idle), 6);
    const ramps = () => ea.nodes.engineGain.gain.calls.filter(c => c.m === 'expRamp').length;
    const r0 = ramps();
    for (let v = 5; v <= 200; v += 5) ea.setSpeed(v);         // runs up through the box
    expect(ramps()).toBeGreaterThanOrEqual(r0 + 4);           // at least two upshift blips
    expect(ea.debugState().gear).toBeGreaterThanOrEqual(3);
    expect(ea.debugState().driven).toBe(false);
    expect(ea.debugState().load).toBe(1);
    ea.setDrive(drive());
    ea.setDrive(null);
    expect(ea.debugState().driven).toBe(false);
  });
});

/* ── EA4 — mute and volume ──────────────────────────────────────── */

describe('EngineAudio — mute and volume (EA4)', () => {
  const TRIM = 0.42;
  it('EA4a. setMuted(true) schedules masterGain → 0', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setMuted(true);
    expect(lastTarget(ea.nodes.masterGain.gain)).toBe(0);
  });
  it('EA4b. volume follows the perceptual square curve, with headroom trim', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setVolume(0.6);
    expect(lastTarget(ea.nodes.masterGain.gain)).toBeCloseTo(0.36 * TRIM, 9);
    ea.setVolume(7);
    expect(lastTarget(ea.nodes.masterGain.gain)).toBeCloseTo(TRIM, 9);       // never above the trim
  });
  it('EA4c. mute preserves volume — unmute restores it', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setVolume(0.5);
    ea.setMuted(true);
    ea.setMuted(false);
    expect(lastTarget(ea.nodes.masterGain.gain)).toBeCloseTo(0.25 * TRIM, 9);
  });
  it('EA4d. pre-resume settings apply at graph build', () => {
    const { ea } = makeEngine();
    ea.setMuted(true);
    ea.setVolume(0.9);
    ea.resume();
    expect(ea.nodes.masterGain.gain.value).toBe(0);
    expect(ea.debugState().masterTarget).toBe(0);
  });
  it('EA4e. a limiter sits on the output', () => {
    const { ea } = makeEngine();
    ea.resume();
    expect(ea.nodes.limiter).toBeTruthy();
    expect(ea.nodes.limiter.ratio.value).toBeGreaterThanOrEqual(8);
  });
});

/* ── EA5 — rain layer ───────────────────────────────────────────── */

describe('EngineAudio — rain-on-bodywork layer (EA5)', () => {
  it('EA5a. rainGain stays 0 while rain is off', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setSpeed(200);
    ea.update(0.016);
    expect(lastTarget(ea.nodes.rainGain.gain)).toBe(0);
  });
  it('EA5b. 0.04 + 0.06·sf when raining, scaled by intensity', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setRain(true);
    ea.setSpeed(175);
    ea.update(0.016);
    expect(lastTarget(ea.nodes.rainGain.gain)).toBeCloseTo(0.04 + 0.06 * 0.5, 9);
    ea.setRainIntensity(0);
    ea.update(0.016);
    expect(lastTarget(ea.nodes.rainGain.gain)).toBeCloseTo((0.04 + 0.06 * 0.5) * 0.4, 9);
  });
});

/* ── EA6 — scheduled writes only ────────────────────────────────── */

describe('EngineAudio — scheduled writes only after init (EA6)', () => {
  it('EA6a. no direct `.value =` param writes after resume — updates, shifts, car change, one-shots', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    ctx.allParams.forEach(p => { p.directSets.length = 0; });
    ea._rng = () => 0;
    ea.setDrive(drive({ shifted: 1 }));
    ea.update(0.016);
    ea.setDrive(drive({ throttle: 0, shifted: -1 }));
    ea.update(0.016);
    ea.setCarType('GT');
    ea.setRain(true); ea.setVolume(0.3); ea.setMuted(true); ea.setPaused(true);
    ea.update(0.016);
    ea.thunder(0.2); ea.coinPickup(3); ea.countdownBlip(0);
    expect(ctx.allParams.every(p => p.directSets.length === 0)).toBe(true);
  });
  it('EA6b. update() smooths with setTargetAtTime (τ ≈ 60 ms)', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setDrive(drive());
    ea.update(0.016);
    const c = [...ea.nodes.core.frequency.calls].reverse().find(x => x.m === 'setTargetAtTime');
    expect(c.tau).toBeCloseTo(0.06, 9);
  });
});

/* ── EA7 — settings persistence ─────────────────────────────────── */

describe('EngineAudio — localStorage settings (EA7)', () => {
  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
  it('EA7a. defaults when nothing stored: unmuted, volume 0.6', () => {
    expect(loadAudioSettings(store())).toEqual({ muted: false, volume: 0.6 });
  });
  it('EA7b. save → load round-trip under the fsim-audio key', () => {
    const s = store();
    saveAudioSettings(s, { muted: true, volume: 0.25 });
    expect(JSON.parse(s.getItem(AUDIO_STORE_KEY))).toEqual({ muted: true, volume: 0.25 });
    expect(loadAudioSettings(s)).toEqual({ muted: true, volume: 0.25 });
  });
  it('EA7c. junk-tolerant — malformed JSON or out-of-range values fall back to defaults', () => {
    const s = store();
    s.setItem(AUDIO_STORE_KEY, '{not json');
    expect(loadAudioSettings(s)).toEqual({ muted: false, volume: 0.6 });
    s.setItem(AUDIO_STORE_KEY, JSON.stringify({ muted: 'yes', volume: 7 }));
    expect(loadAudioSettings(s)).toEqual({ muted: false, volume: 0.6 });
    expect(loadAudioSettings(null)).toEqual({ muted: false, volume: 0.6 });
  });
});

/* ── EA8 — one-shots ────────────────────────────────────────────── */

describe('EngineAudio — one-shots (EA8)', () => {
  it('EA8a. coinPickupHz: base 988 Hz, +1 semitone per streak step, capped +12', () => {
    expect(coinPickupHz(1)).toBeCloseTo(988, 6);
    expect(coinPickupHz(2)).toBeCloseTo(988 * Math.pow(2, 1 / 12), 6);
    expect(coinPickupHz(99)).toBeCloseTo(988 * 2, 6);
    expect(coinPickupHz(undefined)).toBeCloseTo(988, 6);
  });
  it('EA8b. countdownHz rises 3 → 2 → 1 → GO', () => {
    expect(countdownHz(3)).toBeLessThan(countdownHz(2));
    expect(countdownHz(2)).toBeLessThan(countdownHz(1));
    expect(countdownHz(0)).toBeCloseTo(countdownHz(3) * 2, 6);
  });
  it('EA8c. coin and countdown are one oscillator each that stops itself; the persistent graph is untouched', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    const before = { ...ctx.created };
    ea.coinPickup(1);
    ea.countdownBlip(3);
    expect(ctx.created.osc).toBe(before.osc + 2);
    expect(ctx.created.biquad).toBe(before.biquad);
    expect(ctx.created.bufferSrc).toBe(before.bufferSrc);
    const [coin, tick] = ctx.oscNodes.slice(-2);
    expect(coin.type).toBe('triangle');
    expect(coin.frequency.calls.find(c => c.m === 'setValueAtTime').v).toBeCloseTo(coinPickupHz(1), 6);
    expect(tick.frequency.calls.find(c => c.m === 'setValueAtTime').v).toBeCloseTo(countdownHz(3), 6);
    expect(coin.stopped).toBeGreaterThan(coin.started);
  });
  it('EA8d. thunder is one noise source through its own lowpass, with a long tail', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    const before = { ...ctx.created };
    ea.thunder(0.5);
    expect(ctx.created.bufferSrc).toBe(before.bufferSrc + 1);
    expect(ctx.created.biquad).toBe(before.biquad + 1);
    expect(ctx.created.gain).toBe(before.gain + 1);
    const g = ctx.gainNodes[ctx.gainNodes.length - 1].gain.calls.filter(c => c.m === 'expRamp');
    expect(g[g.length - 1].t).toBeGreaterThan(2);
  });
});
