/**
 * weather.js — rain intensity → light, and lightning timing (pure).
 */

/** Blend two weather lighting tables by t ∈ [0,1] (numbers only). */
export function blendWeather(dry, rain, t) {
  const k = Math.min(1, Math.max(0, t));
  const mix = (a, b) => a + (b - a) * k;
  const ch = (shift) => Math.round(mix((dry.ambientColor >> shift) & 255, (rain.ambientColor >> shift) & 255));
  return {
    ambientColor: (ch(16) << 16) | (ch(8) << 8) | ch(0),
    ambientIntensity: mix(dry.ambientIntensity, rain.ambientIntensity),
    sunIntensity: mix(dry.sunIntensity, rain.sunIntensity),
    exposure: mix(dry.exposure, rain.exposure),
  };
}

/** How far toward the rain lighting a given intensity goes: a drizzle
 *  already dulls the day (0.45), a downpour is the full overcast look. */
export function rainLightMix(intensity) {
  const i = Math.min(1, Math.max(0, intensity));
  return 0.45 + 0.55 * i;
}

export const STORM_FROM = 0.75;     // intensity where lightning starts

/** Expected lightning strikes per second at an intensity (0 below a storm). */
export function strikeRate(intensity) {
  if (intensity <= STORM_FROM) return 0;
  return 0.02 + 0.10 * (intensity - STORM_FROM) / (1 - STORM_FROM);
}

/**
 * Lightning state machine. step() returns true on the frame a strike
 * starts; `flash` is the 0..1 brightness (double-pulse, ~0.35 s); thunder
 * follows after `thunderDelay` seconds via takeThunder().
 */
export function createLightning(rng = Math.random) {
  const st = { flash: 0, age: Infinity, thunderIn: Infinity, distance: 0.5 };
  return {
    state: st,
    step(dt, intensity) {
      st.age += dt;
      st.thunderIn -= dt;
      let struck = false;
      if (st.age > 1.5 && rng() < strikeRate(intensity) * dt) {
        st.age = 0;
        st.distance = rng();
        st.thunderIn = 0.3 + 2.2 * st.distance;     // light first, sound later
        struck = true;
      }
      // Two quick pulses: 0–0.08 s and 0.14–0.30 s.
      const a = st.age;
      const p1 = a < 0.08 ? 1 - a / 0.08 : 0;
      const p2 = a >= 0.14 && a < 0.30 ? 0.7 * (1 - (a - 0.14) / 0.16) : 0;
      st.flash = Math.max(p1, p2) * (1 - 0.5 * st.distance);
      return struck;
    },
    /** True once, when the thunder for the last strike is due. */
    takeThunder() {
      if (st.thunderIn <= 0) { st.thunderIn = Infinity; return true; }
      return false;
    },
  };
}
