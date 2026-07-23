import { describe, it, expect } from 'vitest';
import {
  EDU_COPY, ANCHOR_TO_PART, partForHit, eduEntryFor, splitCopy,
} from '../edu-content.js';

/* Synthetic F1-ish anchor set (car-local, ground-referenced y). */
const F1_ANCHORS = {
  frontWing:     { x: 0,     y: 0.04,  z: -2.30 },
  rearWing:      { x: 0,     y: 0.454, z:  2.412 },
  halo:          { x: 0,     y: 0.373, z: -0.05 },
  cockpit:       { x: 0,     y: 0.265, z:  0.00 },
  noseTip:       { x: 0,     y: 0.10,  z: -2.40 },
  sidepodInletL: { x: -0.70, y: 0.22,  z: -0.50, role: 'inlet' },
  sidepodInletR: { x:  0.70, y: 0.22,  z: -0.50, role: 'inlet' },
  airboxIntake:  { x: 0,     y: 0.673, z: -0.25, role: 'inlet' },
  exhaustPipe:   { x: 0,     y: 0.154, z:  2.26, role: 'outlet' },
  floor:         { x: 0,     y: -0.37, z:  0.13 },
  diffuser:      { x: 0,     y: -0.37, z:  1.90 },
};

describe('edu-content — copy table', () => {
  it('every ANCHOR_TO_PART target part has copy', () => {
    for (const part of new Set(Object.values(ANCHOR_TO_PART))) {
      expect(EDU_COPY[part], `copy for ${part}`).toBeTypeOf('string');
    }
  });

  it('wheels and mirror copy exist (non-anchor parts)', () => {
    expect(EDU_COPY.wheels).toBeTypeOf('string');
    expect(EDU_COPY.mirror).toBeTypeOf('string');
  });

  it('splitCopy splits "Title — body" at the first em-dash', () => {
    const { title, body } = splitCopy('Front wing — first surface to meet the air.');
    expect(title).toBe('Front wing');
    expect(body).toBe('first surface to meet the air.');
  });

  it('authored copy is verbatim for spot-checked parts', () => {
    expect(EDU_COPY.frontWing).toBe(
      'Front wing — first surface to meet the air. Generates ~25% of total downforce and steers the wake around the tires and into the floor.');
    expect(EDU_COPY.halo).toBe(
      "Halo — titanium crash structure. Costs a little airflow to the engine intake, protects the driver's head.");
    expect(EDU_COPY.brakeDuct).toBe(
      'Brake ducts — scoop air to cool carbon discs that run at up to 1000 °C.');
  });
});

describe('edu-content — partForHit', () => {
  it('maps a point near the front wing to frontWing', () => {
    expect(partForHit({ x: 0.1, y: 0.06, z: -2.25 }, F1_ANCHORS, 'F1')).toBe('frontWing');
  });

  it('maps a point near the left sidepod inlet to sidepod', () => {
    expect(partForHit({ x: -0.65, y: 0.25, z: -0.45 }, F1_ANCHORS, 'F1')).toBe('sidepod');
  });

  it('radius cutoff: a point > 0.55 m from every anchor returns null', () => {
    expect(partForHit({ x: 3.0, y: 3.0, z: 5.0 }, F1_ANCHORS, 'F1')).toBeNull();
  });

  it('underfloor band: y < floor.y + 0.1 maps to floor even between anchors', () => {
    // floor.y + 0.1 = -0.27; y = -0.30 is below the band threshold.
    expect(partForHit({ x: 0.2, y: -0.30, z: 0.5 }, F1_ANCHORS, 'F1')).toBe('floor');
  });

  it('null anchors returns null', () => {
    expect(partForHit({ x: 0, y: 0, z: 0 }, null, 'F1')).toBeNull();
  });
});

describe('edu-content — per-type overrides', () => {
  it('GT frontWing is the splitter override', () => {
    const entry = eduEntryFor('frontWing', 'GT');
    expect(entry.startsWith("Splitter — flat blade at the bumper's base")).toBe(true);
    expect(entry).not.toBe(EDU_COPY.frontWing);
  });

  it('F1 frontWing uses the base copy', () => {
    expect(eduEntryFor('frontWing', 'F1')).toBe(EDU_COPY.frontWing);
  });

  it('unknown part returns null', () => {
    expect(eduEntryFor('nope', 'F1')).toBeNull();
  });
});
