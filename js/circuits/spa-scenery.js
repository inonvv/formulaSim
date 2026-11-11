/**
 * spa-scenery.js — roadside scenery for the Spa layout.
 *
 * This is set dressing in the SPIRIT of the place (Ardennes forest, pit
 * building on the start straight, grandstands at the famous corners), built
 * from generic shapes. Positions are approximate and the structures are not
 * models of the real buildings. Distances are lap metres; side +1 = right
 * of travel, −1 = left; lateral = metres from the road centre to the front
 * of the structure. `to` may exceed the lap length (wraps the start line).
 */
export const SPA_SCENERY = [
  // Start / finish
  { type: 'gantry', s: 0 },
  { type: 'pit',        from: 6860, to: 7260, side: 1,  lateral: 21 },
  { type: 'wall',       from: 6860, to: 7260, side: 1,  lateral: 8.6 },
  { type: 'pitlane',    from: 6840, to: 7280, side: 1,  x0: 9.2, x1: 20.6 },
  { type: 'grandstand', from: 6880, to: 7230, side: -1, lateral: 16 },
  // La Source — outside of the hairpin
  { type: 'grandstand', from: 300,  to: 470,  side: -1, lateral: 22 },
  { type: 'boards', s: 330 },
  // Run down the hill: second pit building, stands facing Eau Rouge
  { type: 'pit',        from: 520,  to: 760,  side: 1,  lateral: 21 },
  { type: 'wall',       from: 520,  to: 760,  side: 1,  lateral: 8.6 },
  { type: 'pitlane',    from: 500,  to: 780,  side: 1,  x0: 9.2, x1: 20.6 },
  { type: 'grandstand', from: 780,  to: 1010, side: -1, lateral: 20 },
  { type: 'hoarding',   from: 1050, to: 1260, side: 1 },
  { type: 'grandstand', from: 1290, to: 1420, side: 1,  lateral: 20 },
  { type: 'arch', s: 1520, text: 'KEMMEL' },
  // Les Combes
  { type: 'boards', s: 2360 },
  { type: 'grandstand', from: 2240, to: 2360, side: -1, lateral: 22 },
  { type: 'hoarding',   from: 2380, to: 2560, side: -1 },
  // Bruxelles
  { type: 'boards', s: 2960 },
  { type: 'hoarding',   from: 3000, to: 3160, side: -1 },
  // Pouhon — outside of the long left
  { type: 'boards', s: 3750 },
  { type: 'grandstand', from: 3800, to: 3990, side: 1,  lateral: 24 },
  // Fagnes / Campus / Stavelot
  { type: 'boards', s: 4420 },
  { type: 'hoarding',   from: 4460, to: 4600, side: -1 },
  { type: 'boards', s: 4890 },
  { type: 'hoarding',   from: 5100, to: 5260, side: -1 },
  { type: 'arch', s: 5600, text: 'BLANCHIMONT' },
  // Bus Stop
  { type: 'boards', s: 6710 },
  { type: 'grandstand', from: 6540, to: 6690, side: -1, lateral: 18 },
  { type: 'hoarding',   from: 6730, to: 6850, side: 1 },
];
