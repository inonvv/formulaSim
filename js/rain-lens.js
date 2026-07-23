/**
 * rain-lens.js — Cockpit rain-on-visor post-processing shader.
 *
 * Fullscreen ShaderPass inserted AFTER bloom, BEFORE OutputPass. Enabled
 * ONLY when the camera is in cockpit mode AND the rain env is active
 * (lensActive), with a one-pole intensity ramp (rainLensIntensity, tau
 * 0.4 s) so toggling camera/env never pops.
 *
 * Fully procedural — hash-grid droplet cells, no textures, deterministic
 * from uTime. Two layers:
 *   • ~40 static clinging drops that swell in and evaporate (fade-respawn)
 *   • streaking trickles whose slide direction/length follow uSpeed —
 *     gravity-down when crawling, smeared up/backward at speed like a visor
 * Droplet interiors refract: they sample tDiffuse with a normal-offset UV
 * (magnified, inverted feel), plus faint edge darkening and a subtle 5%
 * desaturation at full intensity.
 *
 * No Three.js import — the shader object is plain data (ShaderPass clones
 * the uniforms), and the helpers are pure math, so vitest covers all of it.
 */

const TAU = 0.4;   // seconds — intensity ramp time constant

/**
 * One-pole exponential ramp toward 1 (active) or 0 (inactive).
 * Exact-exponential form makes it dt-composable: two half-steps compose
 * to precisely one full step, so frame-rate never changes the feel.
 */
export function rainLensIntensity(prev, active, dt) {
  const target = active ? 1 : 0;
  return prev + (target - prev) * (1 - Math.exp(-dt / TAU));
}

/** The lens pass runs ONLY in cockpit view while the rain env is active. */
export function lensActive(camMode, activeEnvs) {
  return camMode === 'cockpit' && activeEnvs.has('rain');
}

export const RainLensShader = {
  name: 'RainLensShader',

  uniforms: {
    tDiffuse:   { value: null },   // composed frame from the previous pass
    uTime:      { value: 0 },      // seconds — sole source of animation
    uIntensity: { value: 0 },      // 0..1 ramped by rainLensIntensity
    uSpeed:     { value: 0 },      // speedFactor 0..1 — streak slide dir/length
    uAspect:    { value: 1 },      // viewport w/h — round drops, not ovals
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uSpeed;
    uniform float uAspect;
    varying vec2 vUv;

    // Deterministic 2-out hash — the whole effect derives from this + uTime.
    vec2 hash22( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * vec3( 443.897, 441.423, 437.195 ) );
      p3 += dot( p3, p3.yzx + 19.19 );
      return fract( vec2( ( p3.x + p3.y ) * p3.z, ( p3.x + p3.z ) * p3.y ) );
    }

    // One droplet layer on a hash grid.
    // trickle 0 → static clinging drops (slow fade-respawn in place);
    // trickle 1 → sliding streaks: gravity-down when slow, smeared upward /
    // backward when uSpeed rises (airflow over the visor wins over gravity).
    // Returns xy = refraction offset vector, z = coverage mask.
    vec3 dropLayer( vec2 uv, float cells, float t, float trickle ) {
      vec2 st  = uv * vec2( uAspect, 1.0 ) * cells;
      vec2 id  = floor( st );
      vec2 f   = fract( st ) - 0.5;
      vec2 rnd = hash22( id );

      // Life cycle: each cell's drop swells in, lives, evaporates, respawns.
      float phase = fract( t * ( 0.10 + rnd.y * 0.20 ) + rnd.x * 7.0 );
      float life  = smoothstep( 0.0, 0.12, phase ) * ( 1.0 - smoothstep( 0.72, 1.0, phase ) );

      // Slide: -1 = down (gravity), +1 = up/backward (visor airflow at speed).
      float slideDir = mix( -1.0, 1.0, smoothstep( 0.15, 0.75, uSpeed ) );
      float slideLen = trickle * ( 0.10 + 0.80 * uSpeed );
      vec2 center = ( rnd - 0.5 ) * 0.55;
      center.y += slideDir * slideLen * phase;

      vec2 d = f - center;
      // Trickles elongate along the slide axis, longer with speed.
      d.y /= mix( 1.0, 2.0 + 3.0 * uSpeed, trickle );

      float r = 0.17 * ( 0.55 + 0.45 * rnd.y ) * mix( 1.0, life, 0.85 );
      float m = smoothstep( r, r * 0.35, length( d ) );
      // Sparse population — more drops as the rain intensity ramps in.
      m *= step( rnd.x, mix( 0.45, 0.80, uIntensity ) );

      return vec3( d * m, m );
    }

    void main() {
      // Layer 1: ~40 static clinging drops (7-cell grid × aspect ≈ 12×7,
      // ~50% populated). Layer 2: finer, faster streaking trickles.
      vec3 drops = dropLayer( vUv,       7.0,  uTime,       0.0 );
      vec3 trick = dropLayer( vUv + 3.7, 13.0, uTime * 1.6, 1.0 );

      vec2  n    = drops.xy * 1.4 + trick.xy;
      float mask = clamp( drops.z + trick.z, 0.0, 1.0 ) * uIntensity;

      // Refraction: droplet interiors sample the frame offset AGAINST the
      // radial vector — magnified, inverted-lens feel.
      vec2 uv  = vUv - n * 0.35 * uIntensity;
      vec4 col = texture2D( tDiffuse, uv );

      // Faint darkening at droplet edges sells the meniscus.
      col.rgb *= 1.0 - 0.25 * mask;

      // Subtle wet-visor desaturation (5% at full intensity).
      float lum = dot( col.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      col.rgb = mix( col.rgb, vec3( lum ), 0.05 * uIntensity );

      gl_FragColor = col;
    }
  `,
};
