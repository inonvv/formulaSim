/**
 * engine-audio.js — RPM-driven engine sound, pure Web Audio synthesis.
 *
 * No audio asset files. The whole graph is built lazily on the first
 * resume() after a user gesture (autoplay policy: an AudioContext starts
 * 'suspended' until then). Every setter is safe to call before resume —
 * state is cached and applied when the graph exists.
 *
 * Graph (built ONCE):
 *   engine voice: fund (sawtooth) ─ fundGain ─┐
 *                 harm2 ×2 (square, −8 dB) ───┼─ engineGain ─ lowpass ─ master ─ dest
 *                 sub ×0.5 (sine, −6 dB) ─────┘                 ▲
 *   exhaust:      noise loop ─ bandpass 90–260 Hz ─ noiseGain ──┘ (−14 dB max)
 *   rain layer:   noise loop ─ HP 1.8 kHz ─ LP 6 kHz ─ rainGain ─ master
 *   shift pop:    (one-shot noise burst on upshift) ─ popBP ─ popGain ─ master
 *   idle wobble:  LFO 6 Hz ─ lfoGain (±1.5 Hz, fades out above sf 0.1) → fund.frequency
 *
 * All frequency/gain writes after init go through setTargetAtTime (τ 60 ms)
 * or the blip's exponential ramps — never direct `.value =` (zipper noise).
 * No per-frame node creation; the only post-build node is the one-shot
 * upshift pop source (per gear change, not per frame).
 */
import { gearFromSpeed, rpmRatio, rpmInGear } from './physics.js';

export const AUDIO_STORE_KEY = 'fsim-audio';

const DEFAULT_SETTINGS = { muted: false, volume: 0.6 };

/** Restore { muted, volume } from a Storage-like object; junk-tolerant. */
export function loadAudioSettings(storage) {
  try {
    const raw = storage?.getItem?.(AUDIO_STORE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw);
    return {
      muted:  typeof p.muted === 'boolean' ? p.muted : DEFAULT_SETTINGS.muted,
      volume: (typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1)
        ? p.volume : DEFAULT_SETTINGS.volume,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist { muted, volume }; storage failures (private mode) are swallowed. */
export function saveAudioSettings(storage, settings) {
  try {
    storage?.setItem?.(AUDIO_STORE_KEY, JSON.stringify({
      muted: !!settings.muted,
      volume: settings.volume,
    }));
  } catch { /* quota / private mode — non-fatal */ }
}

/**
 * Fundamental engine frequency (Hz) for a car type at a speed.
 * F1: in-gear ladder 55 + rig·165, scaled by (0.85 + 0.3·rpmRatio) so each
 *     successive gear screams higher (~58 → ~250 Hz downshift ladder).
 * GT: flat-6 growl 40 + rig·95 — same band every gear.
 */
export function fundamentalHz(type, speed) {
  const rig = rpmInGear(speed);
  if (type === 'GT') return 40 + rig * 95;
  return (55 + rig * 165) * (0.85 + 0.3 * rpmRatio(speed));
}

/* Gain constants (dB → linear). Tuning freedom per plan: ±6 dB. */
const HARM2_GAIN  = 0.398;   // −8 dB
const SUB_GAIN    = 0.501;   // −6 dB
const NOISE_MAX   = 0.2;     // −14 dB
const POP_GAIN    = 0.158;   // −16 dB
const SMOOTH_TAU  = 0.06;    // s — param smoothing, no zipper noise
const BLIP_LEN    = 0.08;    // s — shift-blip envelope
const IDLE_LFO_HZ = 6;
const IDLE_LFO_AMP = 1.5;    // Hz of wobble on the fundamental

export class EngineAudio {
  /** @param {() => AudioContext} [ctxFactory] injectable for tests */
  constructor(ctxFactory) {
    this._ctxFactory = ctxFactory ||
      (() => new (window.AudioContext || window.webkitAudioContext)());
    this.ctx   = null;
    this.nodes = null;
    this._speed   = 0;
    this._gear    = 0;
    this._carType = 'F1';
    this._rain    = false;
    this._paused  = false;
    this._muted   = DEFAULT_SETTINGS.muted;
    this._volume  = DEFAULT_SETTINGS.volume;
    this._blipUntil = -1;
  }

  /** Build the graph on first call (must follow a user gesture). */
  resume() {
    if (!this.ctx) {
      this.ctx = this._ctxFactory();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _buildGraph() {
    const ctx = this.ctx;
    const n = {};

    n.masterGain = ctx.createGain();
    n.masterGain.gain.value = this._masterTarget();
    n.masterGain.connect(ctx.destination);

    n.lowpass = ctx.createBiquadFilter();
    n.lowpass.type = 'lowpass';
    n.lowpass.frequency.value = 350;
    n.lowpass.connect(n.masterGain);

    n.engineGain = ctx.createGain();
    n.engineGain.gain.value = this._engineGainTarget();
    n.engineGain.connect(n.lowpass);

    // ── Engine voice: 3 oscillators ────────────────────────────────
    const f0 = fundamentalHz(this._carType, 0);
    n.fund = ctx.createOscillator();
    n.fund.type = 'sawtooth';
    n.fund.frequency.value = f0;
    n.fundGain = ctx.createGain();
    n.fundGain.gain.value = 1.0;
    n.fund.connect(n.fundGain); n.fundGain.connect(n.engineGain);

    n.harm2 = ctx.createOscillator();
    n.harm2.type = 'square';
    n.harm2.frequency.value = f0 * 2;
    n.harm2Gain = ctx.createGain();
    n.harm2Gain.gain.value = HARM2_GAIN;
    n.harm2.connect(n.harm2Gain); n.harm2Gain.connect(n.engineGain);

    n.sub = ctx.createOscillator();
    n.sub.type = 'sine';
    n.sub.frequency.value = f0 * 0.5;
    n.subGain = ctx.createGain();
    n.subGain.gain.value = SUB_GAIN;
    n.sub.connect(n.subGain); n.subGain.connect(n.engineGain);

    // Idle wobble LFO → fund frequency (±1.5 Hz at 6 Hz, fades above sf 0.1)
    n.lfo = ctx.createOscillator();
    n.lfo.type = 'sine';
    n.lfo.frequency.value = IDLE_LFO_HZ;
    n.lfoGain = ctx.createGain();
    n.lfoGain.gain.value = IDLE_LFO_AMP;
    n.lfo.connect(n.lfoGain); n.lfoGain.connect(n.fund.frequency);

    // ── Shared 1 s white-noise buffer ─────────────────────────────
    const rate = ctx.sampleRate || 44100;
    n.noiseBuffer = ctx.createBuffer(1, rate, rate);
    const data = n.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Exhaust texture: noise → bandpass 90–260 Hz → noiseGain → lowpass
    n.exhaustSrc = ctx.createBufferSource();
    n.exhaustSrc.buffer = n.noiseBuffer;
    n.exhaustSrc.loop = true;
    n.exhaustBP = ctx.createBiquadFilter();
    n.exhaustBP.type = 'bandpass';
    n.exhaustBP.frequency.value = 90;
    n.exhaustBP.Q.value = 1.2;
    n.noiseGain = ctx.createGain();
    n.noiseGain.gain.value = 0;
    n.exhaustSrc.connect(n.exhaustBP);
    n.exhaustBP.connect(n.noiseGain);
    n.noiseGain.connect(n.lowpass);

    // Rain-on-bodywork patter: noise → HP 1.8 kHz → LP 6 kHz → rainGain
    n.rainSrc = ctx.createBufferSource();
    n.rainSrc.buffer = n.noiseBuffer;
    n.rainSrc.loop = true;
    n.rainHP = ctx.createBiquadFilter();
    n.rainHP.type = 'highpass';
    n.rainHP.frequency.value = 1800;
    n.rainLP = ctx.createBiquadFilter();
    n.rainLP.type = 'lowpass';
    n.rainLP.frequency.value = 6000;
    n.rainGain = ctx.createGain();
    n.rainGain.gain.value = 0;
    n.rainSrc.connect(n.rainHP);
    n.rainHP.connect(n.rainLP);
    n.rainLP.connect(n.rainGain);
    n.rainGain.connect(n.masterGain);

    // Upshift "pop" chain — pre-built; only the one-shot source is per-shift.
    n.popBP = ctx.createBiquadFilter();
    n.popBP.type = 'bandpass';
    n.popBP.frequency.value = 1200;
    n.popBP.Q.value = 2;
    n.popGain = ctx.createGain();
    n.popGain.gain.value = POP_GAIN;
    n.popBP.connect(n.popGain);
    n.popGain.connect(n.masterGain);

    n.fund.start(); n.harm2.start(); n.sub.start(); n.lfo.start();
    n.exhaustSrc.start(); n.rainSrc.start();

    this.nodes = n;
  }

  /* ── Targets ───────────────────────────────────────────────────── */

  _effSpeed() { return this._paused ? 0 : this._speed; }

  _masterTarget() {
    return this._muted ? 0 : this._volume * this._volume;
  }

  _engineGainTarget() {
    const sf = rpmRatio(this._effSpeed());
    const base = 0.22 + 0.55 * sf;
    return this._paused ? base * 0.5 : base;
  }

  /* ── API ───────────────────────────────────────────────────────── */

  /** Store speed; a gear-band crossing triggers the shift blip. */
  setSpeed(kmh) {
    this._speed = kmh;
    const gear = gearFromSpeed(kmh);
    if (gear !== this._gear) {
      const up = gear > this._gear;
      this._gear = gear;
      if (this.nodes) this._blip(up);
    }
  }

  setCarType(type) { this._carType = type; }
  setRain(on)      { this._rain = !!on; }
  setPaused(p)     { this._paused = !!p; }

  setMuted(m) {
    this._muted = !!m;
    this._applyMaster();
  }

  /** Perceptual curve: masterGain = muted ? 0 : volume². */
  setVolume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    this._applyMaster();
  }

  _applyMaster() {
    if (!this.nodes) return;
    this.nodes.masterGain.gain.setTargetAtTime(
      this._masterTarget(), this.ctx.currentTime, 0.02);
  }

  /** 80 ms shift blip: engine gain dips to 0.35×, fund drops 12%, recovers. */
  _blip(up) {
    const n = this.nodes, t = this.ctx.currentTime;
    const base = Math.max(this._engineGainTarget(), 0.001);
    const g = n.engineGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(base, t);
    g.exponentialRampToValueAtTime(base * 0.35, t + BLIP_LEN * 0.375);
    g.exponentialRampToValueAtTime(base, t + BLIP_LEN);

    const freq = fundamentalHz(this._carType, this._effSpeed());
    const f = n.fund.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(freq, t);
    f.exponentialRampToValueAtTime(freq * 0.88, t + BLIP_LEN * 0.375);
    f.exponentialRampToValueAtTime(freq, t + BLIP_LEN);

    this._blipUntil = t + BLIP_LEN;

    if (up) {
      // 40 ms bandpassed noise burst — the upshift "pop".
      const src = this.ctx.createBufferSource();
      src.buffer = n.noiseBuffer;
      src.connect(n.popBP);
      src.start(t);
      src.stop(t + 0.04);
    }
  }

  /** Per-frame smoothing — every AudioParam approaches its target (τ 60 ms). */
  update(_dt) {
    const n = this.nodes;
    if (!n) return;
    const t   = this.ctx.currentTime;
    const eff = this._effSpeed();
    const sf  = rpmRatio(eff);
    const rig = rpmInGear(eff);
    const freq = fundamentalHz(this._carType, eff);
    const inBlip = t < this._blipUntil;

    // Blip owns engineGain + fund.frequency until its ramps finish.
    if (!inBlip) {
      n.fund.frequency.setTargetAtTime(freq, t, SMOOTH_TAU);
      n.engineGain.gain.setTargetAtTime(this._engineGainTarget(), t, SMOOTH_TAU);
    }
    n.harm2.frequency.setTargetAtTime(freq * 2, t, SMOOTH_TAU);
    n.sub.frequency.setTargetAtTime(freq * 0.5, t, SMOOTH_TAU);

    // Idle wobble fades to 0 above sf 0.1.
    n.lfoGain.gain.setTargetAtTime(
      IDLE_LFO_AMP * Math.max(0, 1 - sf / 0.1), t, SMOOTH_TAU);

    // Brightness opens with revs: 350 → 5200 Hz.
    n.lowpass.frequency.setTargetAtTime(
      350 + 4850 * Math.min(1, 0.65 * sf + 0.35 * rig), t, SMOOTH_TAU);

    // Exhaust rumble: band sweeps 90 → 260 Hz, level rises with rpm.
    n.exhaustBP.frequency.setTargetAtTime(90 + 170 * sf, t, SMOOTH_TAU);
    n.noiseGain.gain.setTargetAtTime(
      NOISE_MAX * (0.15 + 0.85 * sf), t, SMOOTH_TAU);

    // Rain layer: bodywork patter, exactly 0.04 + 0.06·sf when raining.
    n.rainGain.gain.setTargetAtTime(
      this._rain ? 0.04 + 0.06 * sf : 0, t, SMOOTH_TAU);
  }

  /** Verify-script window: current state without poking at private nodes. */
  debugState() {
    return {
      ctxState:      this.ctx ? this.ctx.state : 'idle',
      masterGain:    this.nodes ? this.nodes.masterGain.gain.value : null,
      masterTarget:  this._masterTarget(),
      fundamentalHz: fundamentalHz(this._carType, this._effSpeed()),
      rainGain:      this.nodes ? this.nodes.rainGain.gain.value : null,
      gear:          this._gear,
      muted:         this._muted,
      volume:        this._volume,
    };
  }

  dispose() {
    const n = this.nodes;
    if (n) {
      try {
        n.fund.stop(); n.harm2.stop(); n.sub.stop(); n.lfo.stop();
        n.exhaustSrc.stop(); n.rainSrc.stop();
      } catch { /* already stopped */ }
    }
    if (this.ctx) { try { this.ctx.close(); } catch { /* closed */ } }
    this.nodes = null;
    this.ctx = null;
  }
}
