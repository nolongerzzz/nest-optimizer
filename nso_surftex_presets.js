/* nso_surftex_presets.js - the named skins for the Wrap tool: one for each design in the two plates this tool was built from
   (nest_Bambu_A1__P1S__X1C_315pcs.3mf and spikefoot.3mf), and the single features to start a skin of your own from.
   docs/SURFTEX.md. Loads as a classic script (adds NSO_SurfTex.PRESETS) and as a Node module.

   Each skin is a set of Wrap parameters - the same ones the card shows - so any of them can be wrapped on a cylinder, a tube, a
   sphere, a flat face or a contoured one, and every number can be changed after. `measured` is what was read off the design the skin
   is named for (a tip count round a roller, the lattice pitch, the height), `from` is where the design came from.

   What each design is, as read off the meshes:
     the three rollers  (Soft Spikes, Ribbed Roller, Medium Point Roller): a 95 mm tube, bore 15 mm, wrapped in rows of pyramids -
                        14 round the Soft Spikes at a 9.0 mm arc pitch, 17 mm between the five rows, 9.0 mm tall, each tooth filling its cell;
                        14 x 10 on the Ribbed Roller at 8.6 mm between rows, 5.35 mm tall; 11 round on the Medium Point at 11.7 mm, 6.1 mm tall
     the spiked dome    ("1.0"): a sphere of R 22.5 with 268 spikes on it, 4.0 mm apart, 3.5 mm tall
     the massage ball   (the "按摩球" dome): 32 balls on a dome, about 10.5 mm apart, standing 4.6 mm
     the ten pads       (66.stl_*): domed foot pads whose face carries dimples, slashes, dashes or ribs
     the spikefoot      (left12): a contoured sole, square pyramids 4.95 mm a side on an 8.0 mm grid, 3.4 mm tall (4.3 on the heel)

   Not a single feature repeated, so not here: the pads' nested ovals (66.stl_4, _6), their swirl (_12) and their waves (_13) - the
   closest thing, a round-topped ridge, is `pad-waves`. */
(function (root) {
  'use strict';
  var ST = root && root.NSO_SurfTex ? root.NSO_SurfTex : null;
  if (!ST && typeof module !== 'undefined' && typeof require === 'function') { try { ST = require('./nso_surftex.js'); } catch (e) { ST = null; } }
  if (!ST) return;

  var P = [
    // ---------------------------------------------------------------- the designs
    { id: 'soft-spikes', name: 'Soft Spikes', group: 'design', faces: 'cylinder \u00b7 tube',
      from: 'Soft Spikes roller', measured: '14 round, 5 rows, 9.0 mm arc \u00d7 17 mm, 9.0 mm tall - wide teeth that fill their cell',
      params: { motif: 'spike', sides: 4, size: 9, sizeV: 17, height: 9, layout: 'grid', spacing: 9, spacingV: 17, margin: 3 } },
    { id: 'ribbed-roller', name: 'Ribbed Roller', group: 'design', faces: 'cylinder · tube',
      from: 'Ribbed Roller', measured: '14 round, 10 rows, 8.6 mm between rows, 5.35 mm tall',
      params: { motif: 'spike', sides: 4, size: 9, sizeV: 8.6, height: 5.35, layout: 'grid', spacing: 9, spacingV: 8.6, margin: 1 } },
    { id: 'medium-point-roller', name: 'Medium Point Roller', group: 'design', faces: 'cylinder · tube',
      from: 'Medium Point Roller', measured: '11 round at 11.7 mm, rows 12 mm apart, 6.1 mm tall',
      params: { motif: 'spike', sides: 4, size: 10, sizeV: 10, height: 6.1, layout: 'grid', spacing: 11.7, spacingV: 12, margin: 1 } },
    { id: 'spiked-dome', name: 'Spiked Dome', group: 'design', faces: 'sphere · dome',
      from: '"1.0" (spiked hemisphere)', measured: 'R 22.5, spikes 4.0 mm apart, 3.5 mm tall',
      params: { motif: 'spike', sides: 0, size: 3.4, height: 3.5, layout: 'hex', spacing: 4, margin: 0.6 } },
    { id: 'massage-balls', name: 'Massage Balls', group: 'design', faces: 'sphere · dome',
      from: '按摩球 (ball dome)', measured: '32 balls, about 10.5 mm apart, standing 4.6 mm',
      params: { motif: 'ball', size: 9.2, height: 4.6, layout: 'hex', spacing: 10.5, margin: 1 } },
    { id: 'pad-dimples', name: 'Pad · Dimples', group: 'design', faces: 'contoured · flat · dome',
      from: '66.stl_5, _8', measured: 'round dimples about 11 mm across, 14 mm apart',
      params: { motif: 'dent', size: 11, depth: 2, layout: 'hex', spacing: 14, margin: 1.5 } },
    { id: 'pad-slashes', name: 'Pad · Slashes', group: 'design', faces: 'contoured · flat · dome',
      from: '66.stl_7, _10', measured: 'diagonal grooves, 4.5 mm apart',
      params: { motif: 'line', ridge: false, profile: 'round', size: 2, depth: 1.2, layout: 'grid', spacing: 4.5, spacingV: 6, rot: 60, margin: 1 } },
    { id: 'pad-dashes', name: 'Pad · Dashes', group: 'design', faces: 'contoured · flat · dome',
      from: '66.stl_9', measured: 'short slots, 1.6 × 5 mm, on a 3.4 × 7 mm stagger',
      params: { motif: 'line', ridge: false, profile: 'round', size: 1.6, sizeV: 5, depth: 1, layout: 'stagger', spacing: 3.4, spacingV: 7, margin: 1 } },
    { id: 'pad-ribs', name: 'Pad · Ribs', group: 'design', faces: 'contoured · flat · dome',
      from: '66.stl_11', measured: 'long ridges, 3.2 mm apart',
      params: { motif: 'line', ridge: true, profile: 'round', size: 1.8, height: 0.9, layout: 'grid', spacing: 3.2, spacingV: 8, margin: 1 } },
    { id: 'pad-waves', name: 'Pad · Waves', group: 'design', faces: 'contoured · flat · dome',
      from: '66.stl_13 (nearest: round-topped ridges)', measured: 'ridges 5 mm apart',
      params: { motif: 'line', ridge: true, profile: 'round', size: 2.4, height: 1.1, layout: 'grid', spacing: 5, spacingV: 8, rot: 8, margin: 1 } },
    { id: 'spikefoot', name: 'Spikefoot', group: 'design', faces: 'contoured · flat',
      from: 'spikefoot (left12)', measured: 'square pyramids 4.95 mm a side on an 8.0 mm grid, 3.43 mm tall',
      params: { motif: 'spike', sides: 4, size: 4.95, height: 3.43, layout: 'grid', spacing: 8, rot: 1.9, margin: 1 } },
    { id: 'spikefoot-tall', name: 'Spikefoot · Tall', group: 'design', faces: 'contoured · flat',
      from: 'spikefoot (the taller spikes)', measured: 'the same pyramids, 4.33 mm tall',
      params: { motif: 'spike', sides: 4, size: 4.95, height: 4.33, layout: 'grid', spacing: 8, rot: 1.9, margin: 1 } },
    // ---------------------------------------------------------------- the single features
    { id: 'one-ball', name: 'Ball', group: 'feature', faces: 'any', from: 'a ball', measured: '',
      params: { motif: 'ball', size: 4, height: 2, layout: 'hex', spacing: 5 } },
    { id: 'one-spike', name: 'Spike (cone)', group: 'feature', faces: 'any', from: 'a spike', measured: '',
      params: { motif: 'spike', sides: 0, size: 3, height: 4, layout: 'hex', spacing: 4 } },
    { id: 'one-pyramid', name: 'Pyramid', group: 'feature', faces: 'any', from: 'a pyramid', measured: '',
      params: { motif: 'spike', sides: 4, size: 4, height: 3, layout: 'grid', spacing: 4 } },
    { id: 'one-bump', name: 'Bump', group: 'feature', faces: 'any', from: 'a bump', measured: '',
      params: { motif: 'bump', size: 4, height: 1.2, layout: 'hex', spacing: 5 } },
    { id: 'one-dent', name: 'Dent', group: 'feature', faces: 'any', from: 'a dent', measured: '',
      params: { motif: 'dent', size: 4, depth: 1.2, layout: 'hex', spacing: 5 } },
    { id: 'one-line', name: 'Line (ridge)', group: 'feature', faces: 'any', from: 'a line', measured: '',
      params: { motif: 'line', ridge: true, profile: 'tri', size: 1.6, height: 1, layout: 'grid', spacing: 3, spacingV: 8 } }
  ];

  ST.PRESETS = P;
  ST.preset = function (id) { for (var i = 0; i < P.length; i++) if (P[i].id === id) return P[i]; return null; };
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
