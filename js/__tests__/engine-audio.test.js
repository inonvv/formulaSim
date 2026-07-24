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
  EngineAudio,
  fundamentalHz,
  loadAudioSettings,
  saveAudioSettings,
  AUDIO_STORE_KEY,
} from '../engine-audio.js';

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
    this.created = { osc: 0, gain: 0, biquad: 0, buffer: 0, bufferSrc: 0 };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close()  { this.state = 'closed';  return Promise.resolve(); }
  createOscillator() {
    this.created.osc++;
    return { type: 'sine', frequency: makeParam(this, 440), connect() {}, disconnect() {},
             start() {}, stop() {} };
  }
  createGain() {
    this.created.gain++;
    return { gain: makeParam(this, 1), connect() {}, disconnect() {} };
  }
  createBiquadFilter() {
    this.created.biquad++;
    return { type: 'lowpass', frequency: makeParam(this, 350), Q: makeParam(this, 1),
             connect() {}, disconnect() {} };
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
      ea.setSpeed(180);
      ea.setCarType('GT');
      ea.setRain(true);
      ea.setMuted(true);
      ea.setVolume(0.3);
      ea.setPaused(true);
      ea.update(0.016);
      ea.dispose();
    }).not.toThrow();
  });

  it('EA1c. resume builds the graph once with fixed node counts; a second resume adds nothing', () => {
    const { ea, getCtx, getFactoryCalls } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    expect(getFactoryCalls()).toBe(1);
    expect(ctx.state).toBe('running');
    const counts = { ...ctx.created };
    // 3 engine-voice oscillators + 1 idle LFO
    expect(counts.osc).toBe(4);
    // shared 1 s white-noise buffer, looped by exhaust + rain chains
    expect(counts.buffer).toBe(1);
    expect(counts.bufferSrc).toBe(2);
    // engine lowpass + exhaust bandpass + rain HP/LP + pop bandpass
    expect(counts.biquad).toBe(5);
    // fund/harm2/sub voice gains + engine + noise + rain + pop + lfo + master
    expect(counts.gain).toBe(9);

    ea.resume();
    ea.update(0.016);
    ea.setSpeed(120);   // 0→3 pull-away shift MAY create a one-shot pop source
    ea.update(0.016);
    expect(getFactoryCalls()).toBe(1);
    // Persistent graph never grows — only the per-shift one-shot pop source.
    const { bufferSrc: _ignored, ...persistent } = ctx.created;
    const { bufferSrc: _ignored0, ...persistent0 } = counts;
    expect(persistent).toEqual(persistent0);
    // update() alone NEVER creates anything, sources included.
    const snap = { ...ctx.created };
    for (let i = 0; i < 20; i++) ea.update(0.016);
    expect(ctx.created).toEqual(snap);
  });
});

/* ── EA2 — pitch model ──────────────────────────────────────────── */

describe('EngineAudio — fundamental pitch model (EA2)', () => {
  it('EA2a. monotonic within a gear — 100 km/h (gear-2 top) > 55 km/h (gear-2 low)', () => {
    expect(fundamentalHz('F1', 99)).toBeGreaterThan(fundamentalHz('F1', 55));
    expect(fundamentalHz('GT', 99)).toBeGreaterThan(fundamentalHz('GT', 55));
  });

  it('EA2b. F1 fundamental > GT at the same speed', () => {
    for (const s of [0, 30, 80, 180, 280, 350]) {
      expect(fundamentalHz('F1', s)).toBeGreaterThan(fundamentalHz('GT', s));
    }
  });

  it('EA2c. finite and within [30, 400] Hz for every speed 0–350', () => {
    for (let s = 0; s <= 350; s += 5) {
      for (const type of ['F1', 'GT']) {
        const f = fundamentalHz(type, s);
        expect(Number.isFinite(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(30);
        expect(f).toBeLessThanOrEqual(400);
      }
    }
  });

  it('EA2d. F1 rises through the gears — gear-band tops climb with speed', () => {
    // Top of each gear (just below the shift): the F1 global-rpm scale makes
    // each successive gear scream higher — the downshifting-ladder signature.
    const tops = [49.9, 99.9, 159.9, 209.9, 264.9, 309.9, 339.9, 350];
    let prev = 0;
    for (const s of tops) {
      const f = fundamentalHz('F1', s);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });
});

/* ── EA3 — shift blip ───────────────────────────────────────────── */

describe('EngineAudio — gear-shift blip (EA3)', () => {
  function blipMarks(param) {
    return param.calls.filter(c => c.m === 'expRamp');
  }

  it('EA3a. crossing 49→50 km/h triggers exactly one blip (gain dip + recovery ramps)', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea.setSpeed(45);           // pull-away shift 0→1 (its own blip/pop)
    getCtx().currentTime = 1;  // past the pull-away blip window
    ea.update(0.016);
    const g = ea.nodes.engineGain.gain;
    const before = blipMarks(g).length;
    const srcBefore = getCtx().created.bufferSrc;
    ea.setSpeed(50);           // gear 1 → 2
    const marks = blipMarks(g).slice(before);
    expect(marks.length).toBe(2);                       // dip + recover
    expect(marks[0].v).toBeLessThan(marks[1].v);        // dips below recovery
    expect(marks[0].v).toBeCloseTo(marks[1].v * 0.35, 2);
    // fundamental dips 12% then recovers
    const f = blipMarks(ea.nodes.fund.frequency);
    const fm = f.slice(-2);
    expect(fm[0].v).toBeCloseTo(fm[1].v * 0.88, 2);
    // upshift pop: exactly one extra one-shot noise source
    expect(getCtx().created.bufferSrc).toBe(srcBefore + 1);
  });

  it('EA3b. no blip within a gear', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setSpeed(55);
    ea.update(0.016);
    const g = ea.nodes.engineGain.gain;
    const before = blipMarks(g).length;
    ea.setSpeed(60); ea.update(0.016);
    ea.setSpeed(75); ea.update(0.016);
    ea.setSpeed(99); ea.update(0.016);
    expect(blipMarks(g).length).toBe(before);
  });

  it('EA3c. downshift blips but does NOT pop (no new noise source)', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea.setSpeed(55);
    const srcAfterUpshifts = getCtx().created.bufferSrc;
    const g = ea.nodes.engineGain.gain;
    const before = blipMarks(g).length;
    ea.setSpeed(45);           // gear 2 → 1
    expect(blipMarks(g).length).toBe(before + 2);
    expect(getCtx().created.bufferSrc).toBe(srcAfterUpshifts);
  });
});

/* ── EA4 — mute / volume ────────────────────────────────────────── */

describe('EngineAudio — mute and volume (EA4)', () => {
  it('EA4a. setMuted(true) schedules masterGain → 0', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setMuted(true);
    const last = ea.nodes.masterGain.gain.calls.at(-1);
    expect(last.m).toBe('setTargetAtTime');
    expect(last.v).toBe(0);
  });

  it('EA4b. volume follows the perceptual square curve — 0.6 → 0.36', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setVolume(0.6);
    expect(ea.nodes.masterGain.gain.calls.at(-1).v).toBeCloseTo(0.36, 5);
  });

  it('EA4c. mute preserves volume — unmute restores volume²', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setVolume(0.6);
    ea.setMuted(true);
    expect(ea.nodes.masterGain.gain.calls.at(-1).v).toBe(0);
    ea.setMuted(false);
    expect(ea.nodes.masterGain.gain.calls.at(-1).v).toBeCloseTo(0.36, 5);
  });

  it('EA4d. pre-resume settings apply at graph build (init value, not scheduled)', () => {
    const { ea } = makeEngine();
    ea.setVolume(0.5);
    ea.resume();
    expect(ea.nodes.masterGain.gain.value).toBeCloseTo(0.25, 5);

    const { ea: eb } = makeEngine();
    eb.setMuted(true);
    eb.setVolume(0.8);
    eb.resume();
    expect(eb.nodes.masterGain.gain.value).toBe(0);
  });
});

/* ── EA5 — rain layer ───────────────────────────────────────────── */

describe('EngineAudio — rain-on-bodywork layer (EA5)', () => {
  it('EA5a. rainGain stays 0 while rain is off', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setSpeed(180);
    ea.update(0.016);
    expect(ea.nodes.rainGain.gain.value).toBe(0);
  });

  it('EA5b. exact 0.04 + 0.06·sf mapping when raining', () => {
    const { ea } = makeEngine();
    ea.resume();
    ea.setRain(true);
    ea.setSpeed(175);          // sf = 0.5
    ea.update(0.016);
    expect(ea.nodes.rainGain.gain.value).toBeCloseTo(0.04 + 0.06 * 0.5, 5);
    ea.setSpeed(0);
    ea.update(0.016);
    expect(ea.nodes.rainGain.gain.value).toBeCloseTo(0.04, 5);
    ea.setRain(false);
    ea.update(0.016);
    expect(ea.nodes.rainGain.gain.value).toBe(0);
  });
});

/* ── EA6 — no zipper noise ──────────────────────────────────────── */

describe('EngineAudio — scheduled writes only after init (EA6)', () => {
  it('EA6a. no direct `.value =` param writes after resume (init only)', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    const initSets = ctx.allParams.map(p => p.directSets.length);
    // A busy session: speed sweep with shifts, car swap, rain, pause, volume.
    ea.setCarType('GT');
    ea.setRain(true);
    for (let s = 0; s <= 350; s += 25) { ea.setSpeed(s); ea.update(0.016); }
    ea.setPaused(true);  ea.update(0.016);
    ea.setPaused(false); ea.update(0.016);
    ea.setVolume(0.2);
    ea.setMuted(true);
    ea.update(0.016);
    ctx.allParams.forEach((p, i) => {
      // Params born after the snapshot (one-shot pop sources) baseline at 0.
      expect(p.directSets.length, `param #${i} got a direct .value write post-init`)
        .toBe(initSets[i] ?? 0);
    });
  });

  it('EA6b. update() smooths with setTargetAtTime (τ ≈ 60 ms) — fund freq tracks speed', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea.setSpeed(120);
    getCtx().currentTime = 1;  // past the shift-blip window (blip owns fund until then)
    ea.update(0.016);
    const call = ea.nodes.fund.frequency.calls.findLast(c => c.m === 'setTargetAtTime');
    expect(call).toBeTruthy();
    expect(call.v).toBeCloseTo(fundamentalHz('F1', 120), 3);
    expect(call.tau).toBeGreaterThan(0.02);
    expect(call.tau).toBeLessThan(0.2);
  });

  it('EA6c. setPaused idles the engine — freq → idle value, engine gain halved', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    ea.setSpeed(180);
    getCtx().currentTime = 1;  // past the shift-blip window
    ea.update(0.016);
    const runGain = ea.nodes.engineGain.gain.value;
    ea.setPaused(true);
    ea.update(0.016);
    const f = ea.nodes.fund.frequency.calls.findLast(c => c.m === 'setTargetAtTime');
    expect(f.v).toBeCloseTo(fundamentalHz('F1', 0), 3);
    expect(ea.nodes.engineGain.gain.value).toBeLessThan(runGain * 0.75);
  });
});

/* ── EA7 — localStorage settings ────────────────────────────────── */

describe('EngineAudio — localStorage settings (EA7)', () => {
  function mockStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
      getItem: k => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      _map: map,
    };
  }

  it('EA7a. defaults when nothing stored: unmuted, volume 0.6', () => {
    expect(loadAudioSettings(mockStorage())).toEqual({ muted: false, volume: 0.6 });
  });

  it('EA7b. save → load round-trip under the fsim-audio key', () => {
    const st = mockStorage();
    saveAudioSettings(st, { muted: true, volume: 0.25 });
    expect(st._map.has(AUDIO_STORE_KEY)).toBe(true);
    expect(loadAudioSettings(st)).toEqual({ muted: true, volume: 0.25 });
  });

  it('EA7c. junk-tolerant — malformed JSON or out-of-range values fall back to defaults', () => {
    expect(loadAudioSettings(mockStorage({ [AUDIO_STORE_KEY]: '{not json' })))
      .toEqual({ muted: false, volume: 0.6 });
    expect(loadAudioSettings(mockStorage({ [AUDIO_STORE_KEY]: '{"muted":"yes","volume":7}' })))
      .toEqual({ muted: false, volume: 0.6 });
    expect(loadAudioSettings(null)).toEqual({ muted: false, volume: 0.6 });
  });

  it('EA7d. restored settings drive the graph on init — muted stored ⇒ master 0 at build', () => {
    const st = mockStorage({ [AUDIO_STORE_KEY]: '{"muted":true,"volume":0.4}' });
    const s = loadAudioSettings(st);
    const { ea } = makeEngine();
    ea.setMuted(s.muted);
    ea.setVolume(s.volume);
    ea.resume();
    expect(ea.nodes.masterGain.gain.value).toBe(0);
    ea.setMuted(false);
    expect(ea.nodes.masterGain.gain.calls.at(-1).v).toBeCloseTo(0.16, 5);
  });
});
