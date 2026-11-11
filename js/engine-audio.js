/**
 * engine-audio.js — engine sound, pure Web Audio synthesis (no asset files).
 *
 * VOICE — combustion-pulse synthesis.
 * An engine is not a tone, it is a train of firing pulses. One engine CYCLE
 * (two revolutions) is the true period, so the voice is one oscillator at
 * the cycle frequency (rpm ÷ 120) carrying a custom harmonic recipe:
 *   • every 6th harmonic is a FIRING harmonic (six cylinders fire per
 *     cycle) — the note you hear;
 *   • every 3rd is the bank-to-bank order, weaker;
 *   • all the others are the half-orders that uneven pulses leave behind —
 *     the growl. Their level is the car's character (`rough`).
 * Phases are scrambled so the pulses are ragged, not a clean click.
 * The harmonics then pass through three FIXED resonances (the exhaust and
 * intake tracts). Because those do not move with rpm, the timbre changes as
 * the engine revs through them — the difference between a machine and a
 * synthesiser. (The previous voice was a sawtooth + square + a ×1.5 saw:
 * a few widely spaced partials with nothing between them, which is exactly
 * how an insect's wing-beat sounds.)
 *
 * Graph (built ONCE on the first resume() after a user gesture):
 *   core  (cycle wave) ─ coreGain ─┐
 *   core2 (same, +6 cents) ─ g ────┼ engineGain ─ F1 ─ F2 ─ F3 ─ lowpass ─ master ─ limiter ─ out
 *   sub   (sine, half firing) ─ g ─┘                         ▲
 *   exhaust noise ─ bandpass (tracks 2× firing) ─ noiseGain ─┘
 *   jitter: two slow LFOs ─ lfoGain (cents) → core/core2 detune
 *   turbo whistle ─ turboGain ─ master         (F1 / F2)
 *   wind / road noise ─ lowpass ─ windGain ─ master
 *   tyre scrub noise ─ bandpass ─ scrubGain ─ master
 *   rain patter noise ─ HP ─ LP ─ rainGain ─ master
 *   one-shots (shift pop, overrun crackle, thunder, arcade blips) ─ master
 *
 * Inputs: main.js feeds the vehicle model + gearbox every frame (setDrive).
 * Without it the synth derives the same thing from setSpeed alone, through
 * the same gearbox model — one voice, one code path.
 *
 * All parameter writes after init are scheduled (setTargetAtTime τ 60 ms or
 * ramps) — never a direct `.value =` (zipper noise). Nothing is created
 * per frame; one-shots are created per event.
 */
import { rpmRatio } from './physics.js';
import { firingHz, getPowertrain, createPowertrainState, stepPowertrain } from './powertrain.js';

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

/* ── Voices ──────────────────────────────────────────────────────── *
 * rough    level of the half-order harmonics (0 = pure tone, 0.4 = lumpy)
 * tilt     harmonic number where the spectrum starts to fall away
 * formants three fixed resonances [Hz] — the exhaust / intake tracts
 * sub      level of the half-firing sine (body)
 * turbo    whistle level (0 = naturally aspirated)
 * crackle  overrun pops                                               */
export const VOICES = {
  F1: { rough: 0.27, tilt: 6.5, formants: [280, 760, 1750], sub: 1.25, turbo: 1.0, crackle: 0.6 },
  F2: { rough: 0.30, tilt: 6.5, formants: [260, 700, 1600], sub: 1.25, turbo: 0.8, crackle: 0.4 },
  F3: { rough: 0.33, tilt: 6.5, formants: [250, 680, 1500], sub: 1.3,  turbo: 0.0, crackle: 0.5 },
  GT: { rough: 0.38, tilt: 6.5, formants: [210, 560, 1300], sub: 1.4,  turbo: 0.0, crackle: 0.9 },
};
export const HARMONICS = 64;
const FORMANT_DB = [9, 6, 3];
const FORMANT_Q  = 1.3;

const SUB_GAIN    = 0.45;
const CORE2_GAIN  = 0.55;
const CORE2_CENTS = 6;       // static detune of the second voice (thickness)
const NOISE_MAX   = 0.34;
const POP_GAIN    = 0.158;   // −16 dB
const SMOOTH_TAU  = 0.06;    // s — param smoothing, no zipper noise
const BLIP_LEN    = 0.08;    // s — shift-blip envelope
const TURBO_MAX   = 0.012;
const WIND_MAX    = 0.16;
const SCRUB_MAX   = 0.12;
const SCRUB_FROM  = 0.85;    // tyre usage where scrub starts
const CRACKLE_RATE = 11;     // pops / s at full overrun
const OUT_TRIM    = 0.42;    // headroom: the summed layers must never clip
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Engine-cycle frequency [Hz]: one cycle is two revolutions. */
export function cycleHz(rpm) {
  return rpm / 120;
}

/**
 * Harmonic amplitudes of the cycle wave, index = harmonic number (1-based;
 * [0] is DC and stays 0). Pure — the wave table is built from this.
 * @param {object} voice   VOICES entry
 * @param {number} cyl     cylinders (firing harmonics are multiples of it)
 */
export function harmonicRecipe(voice, cyl = 6, n = HARMONICS) {
  const amp = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    // Firing harmonics are full strength; the bank-to-bank order (half the
    // firing rate) is nearly as strong — it sits an octave BELOW the firing
    // note and gives the voice its body; the rest are the rough half-orders.
    const order = k % cyl === 0 ? 1 : (k % (cyl / 2) === 0 ? 0.8 : voice.rough);
    const tilt = 1 / (1 + Math.pow(k / voice.tilt, 2.0));
    const lead = k === cyl ? 1.1 : 1;
    amp[k] = order * tilt * lead;
  }
  return amp;
}

/** Deterministic phase 0..2π for harmonic k (ragged pulses, same every run). */
export function harmonicPhase(k) {
  const x = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) * Math.PI * 2;
}

/** Engine loudness 0..1 from revs and load (throttle). */
export function loadGain(rpm01, load) {
  return (0.22 + 0.48 * clamp01(rpm01)) * (0.42 + 0.58 * clamp01(load));
}

/** Lowpass cut-off [Hz]: opens with revs AND load, never above 3640. */
export function loadBrightnessHz(rpm01, load) {
  const r = clamp01(rpm01), l = clamp01(load);
  return 460 + 2400 * Math.min(1, r * (0.45 + 0.55 * l) + 0.12 * l);
}

/** Pitch jitter depth [cents]: lumpy at tick-over, nearly steady at speed. */
export function jitterCents(rpm01, load) {
  return 4 + 22 * Math.max(0, 1 - clamp01(rpm01) / 0.12) * (1 - 0.6 * clamp01(load));
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
    this._waveType = null;   // car the cycle wave was built for
    this._rain    = false;
    this._paused  = false;
    this._muted   = DEFAULT_SETTINGS.muted;
    this._volume  = DEFAULT_SETTINGS.volume;
    this._blipUntil = -1;
    this._drive = null;      // setDrive payload — null ⇒ derived from setSpeed
    this._auto  = createPowertrainState();
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

  _voice() { return VOICES[this._carType] || VOICES.F1; }

  /** (Re)build the cycle wave + formants for the current car. */
  _applyVoice() {
    const n = this.nodes, ctx = this.ctx, voice = this._voice();
    if (!n || this._waveType === this._carType) return;
    this._waveType = this._carType;
    if (ctx.createPeriodicWave) {
      const amp = harmonicRecipe(voice, getPowertrain(this._carType).cyl);
      const real = new Float32Array(amp.length), imag = new Float32Array(amp.length);
      for (let k = 1; k < amp.length; k++) {
        const ph = harmonicPhase(k);
        real[k] = amp[k] * Math.cos(ph);
        imag[k] = amp[k] * Math.sin(ph);
      }
      const wave = ctx.createPeriodicWave(real, imag);
      n.core.setPeriodicWave?.(wave);
      n.core2.setPeriodicWave?.(wave);
    }
    const t = ctx.currentTime;
    n.formants.forEach((f, i) => f.frequency.setTargetAtTime(voice.formants[i], t, 0.05));
  }

  _buildGraph() {
    const ctx = this.ctx;
    const n = {};

    // Output: master → (limiter) → destination. The limiter is a safety net
    // only — OUT_TRIM keeps the mix under full scale on its own.
    n.masterGain = ctx.createGain();
    n.masterGain.gain.value = this._masterTarget();
    if (ctx.createDynamicsCompressor) {
      n.limiter = ctx.createDynamicsCompressor();
      n.limiter.threshold.value = -6;
      n.limiter.knee.value = 6;
      n.limiter.ratio.value = 12;
      n.limiter.attack.value = 0.003;
      n.limiter.release.value = 0.15;
      n.masterGain.connect(n.limiter);
      n.limiter.connect(ctx.destination);
    } else {
      n.masterGain.connect(ctx.destination);
    }

    n.lowpass = ctx.createBiquadFilter();
    n.lowpass.type = 'lowpass';
    n.lowpass.frequency.value = 460;
    n.lowpass.connect(n.masterGain);

    // Three fixed resonances in series, ahead of the lowpass.
    const voice = this._voice();
    n.formants = voice.formants.map((hz, i) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = hz;
      f.Q.value = FORMANT_Q;
      if (f.gain) f.gain.value = FORMANT_DB[i];
      return f;
    });
    n.formants[0].connect(n.formants[1]);
    n.formants[1].connect(n.formants[2]);
    n.formants[2].connect(n.lowpass);

    n.engineGain = ctx.createGain();
    n.engineGain.gain.value = this._engineGainTarget();
    n.engineGain.connect(n.formants[0]);

    // ── Engine voice ───────────────────────────────────────────────
    const d0 = this._driveNow();
    const fc = cycleHz(d0.rpm);
    n.core = ctx.createOscillator();
    n.core.frequency.value = fc;
    n.coreGain = ctx.createGain();
    n.coreGain.gain.value = 1.0;
    n.core.connect(n.coreGain); n.coreGain.connect(n.engineGain);

    n.core2 = ctx.createOscillator();
    n.core2.frequency.value = fc;
    if (n.core2.detune) n.core2.detune.value = CORE2_CENTS;
    n.core2Gain = ctx.createGain();
    n.core2Gain.gain.value = CORE2_GAIN;
    n.core2.connect(n.core2Gain); n.core2Gain.connect(n.engineGain);

    n.sub = ctx.createOscillator();
    n.sub.type = 'sine';
    n.sub.frequency.value = fc * 3;
    n.subGain = ctx.createGain();
    n.subGain.gain.value = SUB_GAIN;
    n.sub.connect(n.subGain); n.subGain.connect(n.engineGain);

    // Jitter: two incommensurate slow LFOs wobble the pitch a few cents so
    // the note is never dead-steady.
    n.lfoA = ctx.createOscillator();
    n.lfoA.type = 'sine';
    n.lfoA.frequency.value = 7.3;
    n.lfoB = ctx.createOscillator();
    n.lfoB.type = 'triangle';
    n.lfoB.frequency.value = 11.9;
    n.lfoGain = ctx.createGain();
    n.lfoGain.gain.value = jitterCents(0, 0);
    n.lfoA.connect(n.lfoGain); n.lfoB.connect(n.lfoGain);
    if (n.core.detune)  n.lfoGain.connect(n.core.detune);
    if (n.core2.detune) n.lfoGain.connect(n.core2.detune);

    // ── Shared 1 s white-noise buffer ─────────────────────────────
    const rate = ctx.sampleRate || 44100;
    n.noiseBuffer = ctx.createBuffer(1, rate, rate);
    const data = n.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noiseLoop = () => {
      const src = ctx.createBufferSource();
      src.buffer = n.noiseBuffer;
      src.loop = true;
      return src;
    };

    // Combustion / exhaust noise: a band that tracks twice the firing rate.
    n.exhaustSrc = noiseLoop();
    n.exhaustBP = ctx.createBiquadFilter();
    n.exhaustBP.type = 'bandpass';
    n.exhaustBP.frequency.value = 160;
    n.exhaustBP.Q.value = 0.6;
    n.noiseGain = ctx.createGain();
    n.noiseGain.gain.value = 0;
    n.exhaustSrc.connect(n.exhaustBP);
    n.exhaustBP.connect(n.noiseGain);
    n.noiseGain.connect(n.lowpass);

    // Rain-on-bodywork patter: noise → HP 1.8 kHz → LP 6 kHz → rainGain
    n.rainSrc = noiseLoop();
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

    // Turbo whistle: pure tone, bypasses the engine filters.
    n.turbo = ctx.createOscillator();
    n.turbo.type = 'sine';
    n.turbo.frequency.value = 1400;
    n.turboGain = ctx.createGain();
    n.turboGain.gain.value = 0;
    n.turbo.connect(n.turboGain); n.turboGain.connect(n.masterGain);

    // Wind / road roar: noise → lowpass → windGain.
    n.windSrc = noiseLoop();
    n.windLP = ctx.createBiquadFilter();
    n.windLP.type = 'lowpass';
    n.windLP.frequency.value = 300;
    n.windGain = ctx.createGain();
    n.windGain.gain.value = 0;
    n.windSrc.connect(n.windLP); n.windLP.connect(n.windGain); n.windGain.connect(n.masterGain);

    // Tyre scrub: noise → resonant bandpass → scrubGain.
    n.scrubSrc = noiseLoop();
    n.scrubBP = ctx.createBiquadFilter();
    n.scrubBP.type = 'bandpass';
    n.scrubBP.frequency.value = 900;
    n.scrubBP.Q.value = 3.5;
    n.scrubGain = ctx.createGain();
    n.scrubGain.gain.value = 0;
    n.scrubSrc.connect(n.scrubBP); n.scrubBP.connect(n.scrubGain); n.scrubGain.connect(n.masterGain);

    // Shift "pop" / crackle chain — pre-built; only the one-shot source is per-event.
    n.popBP = ctx.createBiquadFilter();
    n.popBP.type = 'bandpass';
    n.popBP.frequency.value = 1200;
    n.popBP.Q.value = 2;
    n.popGain = ctx.createGain();
    n.popGain.gain.value = POP_GAIN;
    n.popBP.connect(n.popGain);
    n.popGain.connect(n.masterGain);

    n.core.start(); n.core2.start(); n.sub.start(); n.lfoA.start(); n.lfoB.start(); n.turbo.start();
    n.exhaustSrc.start(); n.rainSrc.start(); n.windSrc.start(); n.scrubSrc.start();

    this.nodes = n;
    this._waveType = null;
    this._applyVoice();
  }

  /* ── Targets ───────────────────────────────────────────────────── */

  _effSpeed() { return this._paused ? 0 : this._speed; }

  _masterTarget() {
    return this._muted ? 0 : this._volume * this._volume * OUT_TRIM;
  }

  _engineGainTarget() {
    const d = this._driveNow();
    const base = loadGain(d.rpm01, d.load);
    return this._paused ? base * 0.5 : base;
  }

  /**
   * What the engine is doing right now, as the synth should hear it.
   * From setDrive when the app supplies it, otherwise derived from the
   * speed through the same gearbox model (full throttle while moving).
   * Paused ⇒ idling.
   */
  _driveNow() {
    const idle = getPowertrain(this._carType).idle;
    if (this._paused) return { rpm: idle, rpm01: 0, load: 0, speedMps: 0, usage: 0, wet: this._rain };
    const d = this._drive;
    if (d) {
      return { rpm: d.rpm || idle, rpm01: clamp01(d.rpm01), load: clamp01(d.throttle), speedMps: d.speedMps || 0, usage: d.usage || 0, wet: !!d.wet };
    }
    const a = this._auto;
    return { rpm: a.rpm || idle, rpm01: clamp01(a.rpm01), load: this._speed > 3 ? 1 : 0, speedMps: this._speed / 3.6, usage: 0, wet: this._rain };
  }

  /* ── API ───────────────────────────────────────────────────────── */

  /** Store speed. Without setDrive, the gearbox is stepped from it here. */
  setSpeed(kmh) {
    this._speed = kmh;
    if (this._drive) return;            // the app's gearbox reports its own shifts
    stepPowertrain(this._auto, this._carType, kmh, kmh > 3 ? 1 : 0);
    this._gear = this._auto.gear;
    if (this._auto.shifted && this.nodes && !this._paused) this._blip(this._auto.shifted > 0);
  }

  /**
   * Feed the vehicle model + gearbox. Pass null to fall back to deriving
   * everything from setSpeed.
   * @param {{throttle:number, rpm:number, rpm01:number, gear:number,
   *          shifted:number, speedMps:number, usage:number, wet:boolean}|null} d
   */
  setDrive(d) {
    if (!d) { this._drive = null; return; }
    this._drive = d;
    if (d.gear !== this._gear) this._gear = d.gear;
    if (d.shifted && this.nodes && !this._paused) this._blip(d.shifted > 0);
  }

  setCarType(type) { this._carType = type; this._applyVoice(); }
  setRain(on)      { this._rain = !!on; }
  /** Rain loudness 0..1 — 1 (default) keeps the original level exactly. */
  setRainIntensity(i) { this._rainI = Math.min(1, Math.max(0, Number.isFinite(i) ? i : 1)); }
  _rainScale() { return 0.4 + 0.6 * (this._rainI ?? 1); }
  setPaused(p)     { this._paused = !!p; }

  setMuted(m) {
    this._muted = !!m;
    this._applyMaster();
  }

  /** Perceptual curve: masterGain = muted ? 0 : volume² × trim. */
  setVolume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    this._applyMaster();
  }

  _applyMaster() {
    if (!this.nodes) return;
    this.nodes.masterGain.gain.setTargetAtTime(
      this._masterTarget(), this.ctx.currentTime, 0.02);
  }

  /**
   * 80 ms shift blip. Upshift: ignition cut — level dips and the note sags.
   * Downshift: rev-match — the note flares up instead. Upshifts also pop.
   */
  _blip(up) {
    const n = this.nodes, t = this.ctx.currentTime;
    const base = Math.max(this._engineGainTarget(), 0.001);
    const g = n.engineGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(base, t);
    g.exponentialRampToValueAtTime(base * 0.35, t + BLIP_LEN * 0.375);
    g.exponentialRampToValueAtTime(base, t + BLIP_LEN);

    const fc = cycleHz(this._driveNow().rpm);
    const flare = up ? 0.88 : 1.10;
    for (const osc of [n.core, n.core2]) {
      const f = osc.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(fc, t);
      f.exponentialRampToValueAtTime(fc * flare, t + BLIP_LEN * 0.375);
      f.exponentialRampToValueAtTime(fc, t + BLIP_LEN);
    }
    this._blipUntil = t + BLIP_LEN;

    if (up) {
      const src = this.ctx.createBufferSource();
      src.buffer = n.noiseBuffer;
      src.connect(n.popBP);
      src.start(t);
      src.stop(t + 0.04);
    }
  }

  /** One-shot helper — osc → gain(g0, exp decay over len) → masterGain. */
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

  /** Arcade coin pickup — triangle blip; pitch climbs with the combo streak. */
  coinPickup(streak) {
    if (!this.nodes) return;
    this._oneShot('triangle', coinPickupHz(streak), COIN_GAIN, COIN_DECAY);
  }

  /** Arcade countdown tick (3 / 2 / 1 / 0 = "GO"). */
  countdownBlip(step) {
    if (!this.nodes) return;
    this._oneShot('sine', countdownHz(step), COUNT_GAIN,
      step === 0 ? COUNT_GO_LEN : COUNT_LEN);
  }

  /**
   * Thunder: a low rumble with a slow tail. One-shot nodes per strike;
   * scheduled writes only. `distance` 0..1 makes it quieter and duller.
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

  /** Per-frame: every layer follows revs, load, speed and grip (τ 60 ms). */
  update(dt) {
    const n = this.nodes;
    if (!n) return;
    const t = this.ctx.currentTime;
    const sf = rpmRatio(this._effSpeed());
    const d = this._driveNow();
    const voice = this._voice();
    const fc = cycleHz(d.rpm);
    const fire = firingHz(this._carType, d.rpm);
    const inBlip = t < this._blipUntil;
    const set = (param, v) => param.setTargetAtTime(v, t, SMOOTH_TAU);

    // The blip owns engineGain + core pitch until its ramps finish.
    if (!inBlip) {
      set(n.core.frequency, fc);
      set(n.core2.frequency, fc);
      set(n.engineGain.gain, this._engineGainTarget());
    }
    set(n.sub.frequency, fire / 2);
    set(n.subGain.gain, SUB_GAIN * voice.sub * (1 - 0.3 * d.rpm01) * (0.5 + 0.5 * d.load));
    set(n.lfoGain.gain, jitterCents(d.rpm01, d.load));
    set(n.lowpass.frequency, loadBrightnessHz(d.rpm01, d.load));

    // Combustion noise sits around twice the firing rate and thins off-throttle.
    set(n.exhaustBP.frequency, Math.min(900, Math.max(110, fire)));
    set(n.noiseGain.gain, NOISE_MAX * (0.2 + 0.8 * d.rpm01) * (0.4 + 0.6 * d.load));

    // Turbo: boost builds with load × revs, spools up slower than it dumps.
    const want = voice.turbo * d.load * (0.25 + 0.75 * d.rpm01);
    const tau = want > this._boost ? 0.35 : 0.15;
    this._boost += (want - this._boost) * Math.min(1, (dt || 0) / tau);
    set(n.turbo.frequency, 1400 + 4200 * this._boost);
    set(n.turboGain.gain, TURBO_MAX * this._boost * this._boost);

    // Wind / road roar and tyre scrub.
    set(n.windLP.frequency, (d.wet ? 520 : 300) + 1400 * Math.min(1, d.speedMps / 90));
    set(n.windGain.gain, windGain(d.speedMps, d.wet));
    set(n.scrubBP.frequency, 800 + 500 * clamp01(d.usage));
    set(n.scrubGain.gain, scrubGain(d.usage, d.speedMps, d.wet));

    // Rain layer: bodywork patter, 0.04 + 0.06·sf at full intensity.
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
    const d = this._driveNow();
    return {
      ctxState:      this.ctx ? this.ctx.state : 'idle',
      masterGain:    this.nodes ? this.nodes.masterGain.gain.value : null,
      masterTarget:  this._masterTarget(),
      cycleHz:       cycleHz(d.rpm),
      firingHz:      firingHz(this._carType, d.rpm),
      fundamentalHz: firingHz(this._carType, d.rpm),   // the note heard (kept for older scripts)
      rainGain:      this.nodes ? this.nodes.rainGain.gain.value : null,
      gear:          this._gear,
      muted:         this._muted,
      volume:        this._volume,
      driven:        !!this._drive,
      load:          d.load,
      boost:         this._boost,
    };
  }

  dispose() {
    const n = this.nodes;
    if (n) {
      try {
        n.core.stop(); n.core2.stop(); n.sub.stop(); n.lfoA.stop(); n.lfoB.stop(); n.turbo.stop();
        n.exhaustSrc.stop(); n.rainSrc.stop(); n.windSrc.stop(); n.scrubSrc.stop();
      } catch { /* already stopped */ }
    }
    if (this.ctx) { try { this.ctx.close(); } catch { /* closed */ } }
    this.nodes = null;
    this.ctx = null;
  }
}
