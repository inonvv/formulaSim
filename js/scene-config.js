/**
 * scene-config.js — Centralised scene clarity constants.
 * No browser / Three.js dependency so vitest can import and assert these values.
 *
 * Rules encoded here:
 *   • No fog in SIM mode (scene.fog only exists in ARCADE — see ARCADE_FOG)
 *   • Bright outdoor sky (background = sky blue, high ambient + sun)
 *   • Bloom is SELECTIVE — threshold > 0.7 so only genuinely emissive
 *     objects (brake glow, headlights, cockpit) bloom, not the sky or body.
 */

/* ── Track frame (single source of truth for ground plane) ──── */
export const TRACK = {
  SURFACE_Y: -0.34,   // world-Y of the drivable surface — all cars measure against this
};

/* ── Background & clear colour ───────────────────────────────── */
export const BACKGROUND_COLOR = 0x87ceeb;   // sky blue — never black

/* ── Ambient light ───────────────────────────────────────────── */
export const AMBIENT_COLOR     = 0x88aadd;
export const AMBIENT_INTENSITY = 2.8;       // must be > 2.0

/* ── Sun (directional) light ─────────────────────────────────── */
export const SUN_COLOR     = 0xfff8e0;
export const SUN_INTENSITY = 4.5;           // must be > 3.0

/* ── Fill & rim lights ───────────────────────────────────────── */
export const FILL_COLOR     = 0x99bbff;
export const FILL_INTENSITY = 1.0;
export const RIM_COLOR      = 0xffcc88;
export const RIM_INTENSITY  = 0.5;

/* ── Tone-mapping exposure ───────────────────────────────────── */
export const EXPOSURE = 1.3;               // must be >= 1.3 for bright outdoors

/* ── Sky shader uniforms (Three.js Sky addon) ────────────────── */
export const SKY = {
  scale:             50000,  // < camera.far (100000)
  turbidity:         1.5,    // must be < 3   → crystal-clear atmosphere
  rayleigh:          2.0,    // vivid blue sky
  mieCoefficient:    0.001,  // must be < 0.003 → almost zero haze
  mieDirectionalG:   0.75,
  sunElevationDeg:   55,
  sunAzimuthDeg:     200,
};

/* ── Post-processing bloom ───────────────────────────────────── */
export const BLOOM = {
  strength:  0.28,   // subtle glow
  radius:    0.08,   // tight spread
  threshold: 1.05,   // must be > 0.7 — only emissive surfaces bloom
};

/* ── Arcade horizon fog (game plan Phase C) ──────────────────── */
// SIM mode never sets scene.fog (clarity rules above). ARCADE adds
// distance fog for speed/depth; its colour MUST equal the skyline's
// horizon-haze gradient stop (track.js imports HORIZON_COLOR for the
// panorama texture) so the fog wall melts into the panorama. The far
// band ends inside the skyline ring (330 < R 350).
export const HORIZON_COLOR = '#d8e9e4';
export const ARCADE_FOG = { color: HORIZON_COLOR, near: 90, far: 330 };

/* ── Weather override tables ─────────────────────────────────── */
export const WEATHER = {
  rain: {
    ambientColor:     0x7799bb,
    ambientIntensity: 1.6,
    sunIntensity:     1.2,
    exposure:         1.0,
  },
  default: {
    ambientColor:     AMBIENT_COLOR,
    ambientIntensity: AMBIENT_INTENSITY,
    sunIntensity:     SUN_INTENSITY,
    exposure:         EXPOSURE,
  },
};
