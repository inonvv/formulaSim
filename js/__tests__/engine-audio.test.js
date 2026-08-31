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
  coinPickupHz,
  countdownHz,
  loadAudioSettings,
  saveAudioSettings,
  AUDIO_STORE_KEY,
} from '../engine-audio.js';
import { rpmInGear, rpmRatio } from '../physics.js';

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
    this.oscNodes  = [];   // every oscillator in creation order (EA8 one-shots)
    this.gainNodes = [];
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close()  { this.state = 'closed';  return Promise.resolve(); }
  createOscillator() {
    this.created.osc++;
    const osc = { type: 'sine', frequency: makeParam(this, 440), connect() {}, disconnect() {},
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
      for (const type of ['F1', 'F2', 'F3', 'GT']) {
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

/* ── f2-f3-cars P2: F2/F3 engine voices ─────────────────────────── */

describe('EngineAudio — F2/F3 voices + pitch ordering (P2)', () => {
  it('P2a. F2 voice is the turbo-V6 mid ladder: (48 + rig·120)·(0.90 + 0.20·sf)', () => {
    for (const s of [0, 80, 200, 335]) {
      const rig = rpmInGear(s), sf = rpmRatio(s);
      expect(fundamentalHz('F2', s)).toBeCloseTo((48 + rig * 120) * (0.90 + 0.20 * sf), 6);
    }
  });

  it('P2b. F3 voice is the flat NA-V6 ladder: 42 + rig·100', () => {
    for (const s of [0, 80, 200, 300]) {
      const rig = rpmInGear(s);
      expect(fundamentalHz('F3', s)).toBeCloseTo(42 + rig * 100, 6);
    }
  });

  it('P2c. PITCH ORDERING (hard requirement): F1 > F2 > F3 > GT at 200 km/h mid-gear and across speeds', () => {
    for (const s of [60, 120, 200, 300]) {
      const f1 = fundamentalHz('F1', s);
      const f2 = fundamentalHz('F2', s);
      const f3 = fundamentalHz('F3', s);
      const gt = fundamentalHz('GT', s);
      expect(f1).toBeGreaterThan(f2);
      expect(f2).toBeGreaterThan(f3);
      expect(f3).toBeGreaterThan(gt);
    }
  });

  it('P2d. F2/F3 stay monotonic within a gear (55 → 99 km/h)', () => {
    expect(fundamentalHz('F2', 99)).toBeGreaterThan(fundamentalHz('F2', 55));
    expect(fundamentalHz('F3', 99)).toBeGreaterThan(fundamentalHz('F3', 55));
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

/* ── EA8 — arcade pickup + countdown blips (game plan Phase B) ────── */

describe('EngineAudio — coin pickup + countdown blips (EA8)', () => {
  it('EA8a. coinPickupHz: base 988 Hz, +1 semitone per streak step, capped +12', () => {
    expect(coinPickupHz(1)).toBeCloseTo(988, 6);
    expect(coinPickupHz(2)).toBeCloseTo(988 * Math.pow(2, 1 / 12), 6);
    expect(coinPickupHz(5)).toBeCloseTo(988 * Math.pow(2, 4 / 12), 6);
    expect(coinPickupHz(13)).toBeCloseTo(988 * 2, 6);      // +12 semitones
    expect(coinPickupHz(40)).toBeCloseTo(988 * 2, 6);      // capped
    expect(coinPickupHz(0)).toBeCloseTo(988, 6);           // junk-tolerant floor
  });

  it('EA8b. countdownHz rises 3 → 2 → 1 → GO', () => {
    const f3 = countdownHz(3), f2 = countdownHz(2), f1 = countdownHz(1), go = countdownHz(0);
    expect(f2).toBeGreaterThan(f3);
    expect(f1).toBeGreaterThan(f2);
    expect(go).toBeGreaterThan(f1);
  });

  it('EA8c. pre-resume coinPickup/countdownBlip are safe no-ops (graph stays unbuilt)', () => {
    const { ea, getFactoryCalls } = makeEngine();
    expect(() => { ea.coinPickup(3); ea.countdownBlip(2); }).not.toThrow();
    expect(getFactoryCalls()).toBe(0);
  });

  it('EA8d. coinPickup: one triangle one-shot at coinPickupHz, gain 0.15 exp-decaying over 0.15 s', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    const oscBefore = ctx.oscNodes.length, gainBefore = ctx.gainNodes.length;
    ctx.currentTime = 2;
    ea.coinPickup(5);
    expect(ctx.oscNodes.length).toBe(oscBefore + 1);
    expect(ctx.gainNodes.length).toBe(gainBefore + 1);
    const osc = ctx.oscNodes.at(-1);
    expect(osc.type).toBe('triangle');
    const fset = osc.frequency.calls.find(c => c.m === 'setValueAtTime');
    expect(fset.v).toBeCloseTo(coinPickupHz(5), 6);
    expect(osc.started).toBe(2);
    expect(osc.stopped).toBeCloseTo(2.15, 6);
    const g = ctx.gainNodes.at(-1).gain;
    expect(g.calls.find(c => c.m === 'setValueAtTime').v).toBeCloseTo(0.15, 6);
    const ramp = g.calls.find(c => c.m === 'expRamp');
    expect(ramp.v).toBeLessThanOrEqual(0.001);
    expect(ramp.t).toBeCloseTo(2.15, 6);
  });

  it('EA8e. countdownBlip: one-shot osc at countdownHz(step); repeated calls never grow the persistent graph', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    const before = ctx.oscNodes.length;
    ea.countdownBlip(3);
    ea.countdownBlip(0);
    expect(ctx.oscNodes.length).toBe(before + 2);
    const [t3, go] = ctx.oscNodes.slice(-2);
    expect(t3.frequency.calls.find(c => c.m === 'setValueAtTime').v).toBeCloseTo(countdownHz(3), 6);
    expect(go.frequency.calls.find(c => c.m === 'setValueAtTime').v).toBeCloseTo(countdownHz(0), 6);
    // one-shots stop themselves — persistent node families untouched
    expect(t3.stopped).toBeGreaterThan(t3.started);
    expect(ctx.created.biquad).toBe(5);
    expect(ctx.created.bufferSrc).toBe(2);
  });

  it('EA8f. one-shots never write params directly (no zipper) — scheduled methods only', () => {
    const { ea, getCtx } = makeEngine();
    ea.resume();
    const ctx = getCtx();
    const snapshot = ctx.allParams.length;
    ea.coinPickup(2);
    ea.countdownBlip(1);
    ctx.allParams.slice(snapshot).forEach((p, i) => {
      expect(p.directSets.length, `one-shot param #${i} used a direct .value write`).toBe(0);
    });
  });
});

/* ── EA9 — high-rev harshness cap (300+ km/h shrillness fix) ────── */

function lastTarget(param) {
  const w = param.calls.filter((c) => c.m === 'setTargetAtTime');
  return w.length ? w[w.length - 1].v : param.value;
}

describe('EngineAudio — high-rev timbre stays civil (EA9)', () => {
  function targetsAt(speed) {
    const { ea } = makeEngine();
    ea.resume();
    ea.setSpeed(speed);
    // Push past the shift-blip window so update() owns the params again.
    ea.ctx.currentTime = 1;
    ea.update(0.016);
    return {
      lowpassHz: lastTarget(ea.nodes.lowpass.frequency),
      harm2Gain: lastTarget(ea.nodes.harm2Gain.gain),
    };
  }

  it('EA9a. lowpass brightness is capped ≤ 3700 Hz even at vMax (was ~5.2 kHz scream)', () => {
    expect(targetsAt(350).lowpassHz).toBeLessThanOrEqual(3700);
    expect(targetsAt(300).lowpassHz).toBeLessThanOrEqual(3700);
  });

  it('EA9b. brightness still opens with revs (monotonic 0 → 150 → 300)', () => {
    const lo = targetsAt(0).lowpassHz;
    const mid = targetsAt(150).lowpassHz;
    const hi = targetsAt(300).lowpassHz;
    expect(mid).toBeGreaterThan(lo);
    expect(hi).toBeGreaterThan(mid);
    expect(lo).toBeGreaterThanOrEqual(350);
  });

  it('EA9c. square-harmonic gain rolls off with rpmRatio — ~−5 dB by vMax', () => {
    const g0 = targetsAt(0).harm2Gain;
    const gMid = targetsAt(175).harm2Gain;
    const gTop = targetsAt(350).harm2Gain;
    expect(gMid).toBeLessThan(g0);
    expect(gTop).toBeLessThan(gMid);
    // exact curve: HARM2_GAIN · (1 − 0.45·sf), sf = speed/350
    expect(gTop).toBeCloseTo(0.398 * (1 - 0.45), 3);
    expect(g0).toBeCloseTo(0.398 * (1 - 0.45 * rpmRatio(0)), 3);
  });

  it('EA9d. harm2 roll-off is a scheduled write (EA6 zipper rule holds)', () => {
    const { ea } = makeEngine();
    ea.resume();
    const before = ea.nodes.harm2Gain.gain.directSets.length;
    ea.setSpeed(340);
    ea.ctx.currentTime = 1;
    ea.update(0.016);
    expect(ea.nodes.harm2Gain.gain.directSets.length).toBe(before);
  });
});
