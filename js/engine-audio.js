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
 *                 harm2 ×2 (square, −8 dB, rolls to ~−13 dB at vMax) ─┼─ engineGain ─ lowpass ─ master ─ dest
 *                 sub ×0.5 (sine, −6 dB) ─────┘                 ▲
 *   exhaust:      noise loop ─ bandpass 90–260 Hz ─ noiseGain ──┘ (−14 dB max)
 *   rain layer:   noise loop ─ HP 1.8 kHz ─ LP 6 kHz ─ rainGain ─ master
 *   shift pop:    (one-shot noise burst on upshift) ─ popBP ─ popGain ─ master
 *   idle wobble:  LFO 6 Hz ─ lfoGain (±1.5 Hz, fades out above sf 0.1) → fund.frequency
 *
 * Driven mode (setDrive — main.js feeds the vehicle model + gearbox every
 * frame) adds what a speed-only synth cannot do:
 *   • pitch from real engine rpm (firing frequency), so an upshift drops
 *     the note by the ratio step and braking steps back up through the box
 *   • LOAD: on the throttle the engine is loud and bright; on a lift or
 *     under braking it falls back, darkens and crackles on the overrun
 *   • rasp voice ×1.5 (the uneven-order growl of a six), per-car level
 *   • turbo whistle (F1 / F2) that spools with boost
 *   • wind / road roar that grows with speed², brighter in the wet
 *   • tyre scrub when the tyres are near their grip limit
 * Without setDrive every legacy mapping below is unchanged.
 *
 * All frequency/gain writes after init go through setTargetAtTime (τ 60 ms)
 * or the blip's exponential ramps — never direct `.value =` (zipper noise).
 * No per-frame node creation; the only post-build node is the one-shot
 * upshift pop source (per gear change, not per frame).
 */
import { gearFromSpeed, rpmRatio, rpmInGear } from './physics.js';
import { firingHz, getPowertrain } from './powertrain.js';

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
 * F2: turbo V6 — mid ladder (48 + rig·120)·(0.90 + 0.20·rpmRatio).
 * F3: NA V6 growl 42 + rig·100 — flat like GT but pitched higher.
 * GT: flat-6 growl 40 + rig·95 — same band every gear.
 * Pitch ordering at any speed: F1 > F2 > F3 > GT.
 */
export function fundamentalHz(type, speed) {
  const rig = rpmInGear(speed);
  if (type === 'GT') return 40 + rig * 95;
  if (type === 'F3') return 42 + rig * 100;
  if (type === 'F2') return (48 + rig * 120) * (0.90 + 0.20 * rpmRatio(speed));
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

/* ── Driven-mode voice (per car) ─────────────────────────────────── */
export const VOICES = {
  F1: { rasp: 0.10, turbo: 1.0, crackle: 0.6, sub: 1.0 },
  F2: { rasp: 0.16, turbo: 0.8, crackle: 0.4, sub: 1.0 },
  F3: { rasp: 0.22, turbo: 0.0, crackle: 0.5, sub: 1.1 },
  GT: { rasp: 0.34, turbo: 0.0, crackle: 0.9, sub: 1.3 },
};
const TURBO_MAX   = 0.035;   // whistle level at full boost
const WIND_MAX    = 0.16;
const SCRUB_MAX   = 0.12;
const SCRUB_FROM  = 0.85;    // tyre usage where scrub starts
const CRACKLE_RATE = 11;     // pops / s at full overrun
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Fundamental [Hz] in driven mode: half the firing frequency (the saw's
 * 2nd harmonic and the ×2 square then sit ON the firing frequency, which is
 * the note you hear), kept in the synth's comfortable 28–420 Hz range.
 */
export function drivenFundamentalHz(type, rpm) {
  return Math.min(420, Math.max(28, firingHz(type, rpm) / 2));
}

/** Engine loudness 0..1 from revs and load (throttle). */
export function loadGain(rpm01, load) {
  return (0.20 + 0.50 * clamp01(rpm01)) * (0.42 + 0.58 * clamp01(load));
}

/** Lowpass cut-off [Hz]: opens with revs AND load, never above 3640. */
export function loadBrightnessHz(rpm01, load) {
  const r = clamp01(rpm01), l = clamp01(load);
  return 350 + 3290 * Math.min(1, r * (0.5 + 0.5 * l) + 0.1 * l);
}

/** Wind / road roar gain: ∝ v², louder on a wet road. */
export function windGain(speedMps, wet) {
  const g = WIND_MAX * Math.min(1, (speedMps / 90) ** 2);
  return Math.min(WIND_MAX * 1.5, g * (wet ? 1.5 : 1));
}

/** Tyre scrub gain from the hardest-worked tyre's grip usage. */
export function scrubGain(usage, speedMps, wet) {
  const over = Math.max(0, (usage ?? 0) - SCRUB_FROM);
  return Math.min(SCRUB_MAX, over * 0.6) * Math.min(1, speedMps / 15) * (wet ? 0.4 : 1);
}

/** Overrun crackle probability for this frame (0 on the throttle). */
export function crackleChance(voice, rpm01, load, dt) {
  if (load > 0.08 || rpm01 < 0.45) return 0;
  return Math.min(1, CRACKLE_RATE * voice.crackle * clamp01(rpm01) * dt);
}

/* Arcade one-shots (game plan Phase B) */
const COIN_BASE_HZ = 988;    // B5 — coin-pickup base pitch
const COIN_GAIN    = 0.15;
const COIN_DECAY   = 0.15;   // s — exponential decay
const COUNT_BASE_HZ = 660;   // countdown tick base (E5)
const COUNT_LEN     = 0.12;  // s per tick; "GO" holds longer
const COUNT_GO_LEN  = 0.30;
const COUNT_GAIN    = 0.2;

/** Coin-pickup pitch: base 988 Hz, +1 semitone per combo-streak step past
 *  the first pickup, capped at +12 (one octave). */
export function coinPickupHz(streak) {
  const semi = Math.min(Math.max((streak ?? 1) - 1, 0), 12);
  return COIN_BASE_HZ * Math.pow(2, semi / 12);
}

/** Countdown tick pitch — rises a semitone per step 3 → 2 → 1; the "GO"
 *  frame (step 0) jumps a full octave above the base. */
export function countdownHz(step) {
  if (step === 0) return COUNT_BASE_HZ * 2;
  return COUNT_BASE_HZ * Math.pow(2, (3 - step) / 12);
}

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
    this._drive = null;      // setDrive payload — null ⇒ legacy speed-only mode
    this._boost = 0;         // turbo spool state 0..1
    this._rng = Math.random; // injectable (tests)
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

    // ── Driven-mode layers (silent until setDrive feeds them) ─────
    // Rasp: ×1.5 saw — the uneven-order growl between firing pulses.
    n.rasp = ctx.createOscillator();
    n.rasp.type = 'sawtooth';
    n.rasp.frequency.value = f0 * 1.5;
    n.raspGain = ctx.createGain();
    n.raspGain.gain.value = 0;
    n.rasp.connect(n.raspGain); n.raspGain.connect(n.engineGain);

    // Turbo whistle: pure tone, bypasses the engine lowpass.
    n.turbo = ctx.createOscillator();
    n.turbo.type = 'sine';
    n.turbo.frequency.value = 1400;
    n.turboGain = ctx.createGain();
    n.turboGain.gain.value = 0;
    n.turbo.connect(n.turboGain); n.turboGain.connect(n.masterGain);

    // Wind / road roar: noise → lowpass → windGain.
    n.windSrc = ctx.createBufferSource();
    n.windSrc.buffer = n.noiseBuffer;
    n.windSrc.loop = true;
    n.windLP = ctx.createBiquadFilter();
    n.windLP.type = 'lowpass';
    n.windLP.frequency.value = 300;
    n.windGain = ctx.createGain();
    n.windGain.gain.value = 0;
    n.windSrc.connect(n.windLP); n.windLP.connect(n.windGain); n.windGain.connect(n.masterGain);

    // Tyre scrub: noise → resonant bandpass → scrubGain.
    n.scrubSrc = ctx.createBufferSource();
    n.scrubSrc.buffer = n.noiseBuffer;
    n.scrubSrc.loop = true;
    n.scrubBP = ctx.createBiquadFilter();
    n.scrubBP.type = 'bandpass';
    n.scrubBP.frequency.value = 900;
    n.scrubBP.Q.value = 3.5;
    n.scrubGain = ctx.createGain();
    n.scrubGain.gain.value = 0;
    n.scrubSrc.connect(n.scrubBP); n.scrubBP.connect(n.scrubGain); n.scrubGain.connect(n.masterGain);

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
    n.rasp.start(); n.turbo.start();
    n.exhaustSrc.start(); n.rainSrc.start(); n.windSrc.start(); n.scrubSrc.start();

    this.nodes = n;
  }

  /* ── Targets ───────────────────────────────────────────────────── */

  _effSpeed() { return this._paused ? 0 : this._speed; }

  _masterTarget() {
    return this._muted ? 0 : this._volume * this._volume;
  }

  _engineGainTarget() {
    if (this._drive) {
      const d = this._driveNow();
      const base = loadGain(d.rpm01, d.load);
      return this._paused ? base * 0.5 : base;
    }
    const sf = rpmRatio(this._effSpeed());
    const base = 0.22 + 0.55 * sf;
    return this._paused ? base * 0.5 : base;
  }

  /** Driven-mode inputs as the synth should hear them (paused ⇒ idling). */
  _driveNow() {
    const d = this._drive;
    if (this._paused) {
      return { rpm: getPowertrain(this._carType).idle, rpm01: 0, load: 0, speedMps: 0, usage: 0, wet: d.wet };
    }
    return { rpm: d.rpm, rpm01: clamp01(d.rpm01), load: clamp01(d.throttle), speedMps: d.speedMps || 0, usage: d.usage || 0, wet: !!d.wet };
  }

  _fundHz() {
    return this._drive
      ? drivenFundamentalHz(this._carType, this._driveNow().rpm)
      : fundamentalHz(this._carType, this._effSpeed());
  }

  /* ── API ───────────────────────────────────────────────────────── */

  /** Store speed; a gear-band crossing triggers the shift blip. */
  setSpeed(kmh) {
    this._speed = kmh;
    if (this._drive) return;            // driven mode: the gearbox reports its own shifts
    const gear = gearFromSpeed(kmh);
    if (gear !== this._gear) {
      const up = gear > this._gear;
      this._gear = gear;
      if (this.nodes) this._blip(up);
    }
  }

  /**
   * Feed the vehicle model + gearbox (driven mode). Pass null to return to
   * the legacy speed-only mapping.
   * @param {{throttle:number, rpm:number, rpm01:number, gear:number,
   *          shifted:number, speedMps:number, usage:number, wet:boolean}|null} d
   */
  setDrive(d) {
    if (!d) { this._drive = null; return; }
    this._drive = d;
    if (d.gear !== this._gear) this._gear = d.gear;
    if (d.shifted && this.nodes && !this._paused) this._blip(d.shifted > 0);
  }

  setCarType(type) { this._carType = type; }
  setRain(on)      { this._rain = !!on; }
  /** Rain loudness 0..1 — 1 (default) keeps the original level exactly. */
  setRainIntensity(i) { this._rainI = Math.min(1, Math.max(0, Number.isFinite(i) ? i : 1)); }
  _rainScale() { return 0.4 + 0.6 * (this._rainI ?? 1); }

  /**
   * Thunder: a low rumble with a slow tail. One-shot nodes per strike
   * (never per frame); scheduled writes only. `distance` 0..1 makes it
   * quieter and duller, like a strike further off.
   */
  thunder(distance = 0.5) {
    if (!this.nodes) return;
    const n = this.nodes, t = this.ctx.currentTime;
    const d = Math.min(1, Math.max(0, distance));
    const src = this.ctx.createBufferSource();
    src.buffer = n.noiseBuffer;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220 - 120 * d, t);
    const g = this.ctx.createGain();
    const peak = 0.5 - 0.3 * d;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.06);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    src.connect(lp); lp.connect(g); g.connect(n.masterGain);
    src.start(t);
    src.stop(t + 2.7);
  }
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

    const freq = this._fundHz();
    const f = n.fund.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(freq, t);
    // Upshift (and every legacy blip): ignition cut, the note sags 12 %.
    // Driven downshift: a rev-matching blip — the note flares up instead.
    const flare = (this._drive && !up) ? 1.10 : 0.88;
    f.exponentialRampToValueAtTime(freq * flare, t + BLIP_LEN * 0.375);
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

  /** One-shot helper — osc → gain(g0, exp decay over len) → masterGain.
   *  Scheduled writes only (EA6 zipper rule); per-event, never per-frame. */
  _oneShot(type, hz, g0, len) {
    const n = this.nodes, t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    osc.connect(g);
    g.connect(n.masterGain);
    osc.start(t);
    osc.stop(t + len);
  }

  /** Arcade coin pickup — triangle blip; pitch climbs with the combo streak
   *  (coinPickupHz). Safe no-op before the graph exists. */
  coinPickup(streak) {
    if (!this.nodes) return;
    this._oneShot('triangle', coinPickupHz(streak), COIN_GAIN, COIN_DECAY);
  }

  /** Arcade countdown tick (3 / 2 / 1 / 0 = "GO") — rising-pitch blip with
   *  the shift-blip's exp-envelope style. Safe no-op before the graph. */
  countdownBlip(step) {
    if (!this.nodes) return;
    this._oneShot('sine', countdownHz(step), COUNT_GAIN,
      step === 0 ? COUNT_GO_LEN : COUNT_LEN);
  }

  /** Per-frame smoothing — every AudioParam approaches its target (τ 60 ms). */
  update(_dt) {
    const n = this.nodes;
    if (!n) return;
    const t   = this.ctx.currentTime;
    const eff = this._effSpeed();
    const sf  = rpmRatio(eff);
    const inBlip = t < this._blipUntil;
    if (this._drive) { this._updateDriven(_dt, t, sf, inBlip); return; }
    const rig = rpmInGear(eff);
    const freq = fundamentalHz(this._carType, eff);

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

    // Brightness opens with revs: 350 → 3640 Hz. Capped well below the old
    // 5.2 kHz top — fully open, the saw/square partials landed square in the
    // ear's 2–5 kHz sensitivity peak and read as a scream above ~300 km/h.
    n.lowpass.frequency.setTargetAtTime(
      350 + 3290 * Math.min(1, 0.65 * sf + 0.35 * rig), t, SMOOTH_TAU);

    // Square harmonic rolls off with revs (−8 dB → ~−13 dB at vMax): the
    // ×2 square's odd partials are the buzzy component at high rpm.
    n.harm2Gain.gain.setTargetAtTime(
      HARM2_GAIN * (1 - 0.45 * sf), t, SMOOTH_TAU);

    // Exhaust rumble: band sweeps 90 → 260 Hz, level rises with rpm.
    n.exhaustBP.frequency.setTargetAtTime(90 + 170 * sf, t, SMOOTH_TAU);
    n.noiseGain.gain.setTargetAtTime(
      NOISE_MAX * (0.15 + 0.85 * sf), t, SMOOTH_TAU);

    // Rain layer: bodywork patter, exactly 0.04 + 0.06·sf when raining.
    n.rainGain.gain.setTargetAtTime(
      this._rain ? (0.04 + 0.06 * sf) * this._rainScale() : 0, t, SMOOTH_TAU);
  }

  /** Driven mode: every layer follows revs, load, speed and grip. */
  _updateDriven(dt, t, sf, inBlip) {
    const n = this.nodes;
    const d = this._driveNow();
    const voice = VOICES[this._carType] || VOICES.F1;
    const freq = drivenFundamentalHz(this._carType, d.rpm);
    const set = (param, v) => param.setTargetAtTime(v, t, SMOOTH_TAU);

    if (!inBlip) {
      set(n.fund.frequency, freq);
      set(n.engineGain.gain, this._engineGainTarget());
    }
    set(n.harm2.frequency, freq * 2);
    set(n.sub.frequency, freq * 0.5);
    set(n.rasp.frequency, freq * 1.5);
    set(n.subGain.gain, SUB_GAIN * Math.min(1.4, voice.sub) * (1 - 0.35 * d.rpm01));

    // Idle wobble only at tick-over.
    set(n.lfoGain.gain, IDLE_LFO_AMP * Math.max(0, 1 - d.rpm01 / 0.08) * (1 - d.load));

    set(n.lowpass.frequency, loadBrightnessHz(d.rpm01, d.load));
    set(n.harm2Gain.gain, HARM2_GAIN * (1 - 0.45 * d.rpm01) * (0.6 + 0.4 * d.load));
    set(n.raspGain.gain, voice.rasp * (0.3 + 0.7 * d.load) * Math.sqrt(d.rpm01));

    // Exhaust rumble follows revs; it thins out off the throttle.
    set(n.exhaustBP.frequency, 90 + 170 * d.rpm01);
    set(n.noiseGain.gain, NOISE_MAX * (0.15 + 0.85 * d.rpm01) * (0.5 + 0.5 * d.load));

    // Turbo: boost builds with load × revs, spools up slower than it dumps.
    const want = voice.turbo * d.load * (0.25 + 0.75 * d.rpm01);
    const tau = want > this._boost ? 0.35 : 0.15;
    this._boost += (want - this._boost) * Math.min(1, (dt || 0) / tau);
    set(n.turbo.frequency, 1400 + 5200 * this._boost);
    set(n.turboGain.gain, TURBO_MAX * this._boost * this._boost);

    // Wind / road roar and tyre scrub.
    set(n.windLP.frequency, (d.wet ? 520 : 300) + 1400 * Math.min(1, d.speedMps / 90));
    set(n.windGain.gain, windGain(d.speedMps, d.wet));
    set(n.scrubBP.frequency, 800 + 500 * clamp01(d.usage));
    set(n.scrubGain.gain, scrubGain(d.usage, d.speedMps, d.wet));

    // Rain layer keeps its speed mapping.
    set(n.rainGain.gain, this._rain ? (0.04 + 0.06 * sf) * this._rainScale() : 0);

    // Overrun crackle: unburnt fuel popping in the exhaust on a closed throttle.
    if (!this._paused && this._rng() < crackleChance(voice, d.rpm01, d.load, dt || 0)) {
      const src = this.ctx.createBufferSource();
      src.buffer = n.noiseBuffer;
      src.connect(n.popBP);
      src.start(t);
      src.stop(t + 0.018 + 0.03 * this._rng());
    }
  }

  /** Verify-script window: current state without poking at private nodes. */
  debugState() {
    return {
      ctxState:      this.ctx ? this.ctx.state : 'idle',
      masterGain:    this.nodes ? this.nodes.masterGain.gain.value : null,
      masterTarget:  this._masterTarget(),
      fundamentalHz: this._fundHz(),
      driven:        !!this._drive,
      load:          this._drive ? this._driveNow().load : null,
      boost:         this._boost,
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
        n.rasp.stop(); n.turbo.stop();
        n.exhaustSrc.stop(); n.rainSrc.stop(); n.windSrc.stop(); n.scrubSrc.stop();
      } catch { /* already stopped */ }
    }
    if (this.ctx) { try { this.ctx.close(); } catch { /* closed */ } }
    this.nodes = null;
    this.ctx = null;
  }
}
