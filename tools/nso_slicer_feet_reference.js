#!/usr/bin/env node
/*
 * tools/nso_slicer_feet_reference.js - the measures of two real Bambu Studio slices of one plate, written to
 * fixtures/slicer-feet-reference.json for slicer:test ("The anti-vibration feet").
 *
 *   node tools/nso_slicer_feet_reference.js <bambu_arachne.gcode.3mf> <anti_vibration ... A1 mini.gcode.3mf>
 *
 * The plate: four 60 x 60 x 24 mm blocks ("Grand Krunk", printed in TPU as anti-vibration feet), the owner's (2026-11-19). Neither file
 * holds a mesh - G-code only - and the model, its pictures and its description are its designer's, so they stay out of the repo. Only
 * what NSO measured off the G-code is kept, for ONE foot (its box is plate_1.json's):
 *   noWalls  bambu_arachne.gcode.3mf (Studio 02.09.01.70): wall_loops 0, no top / bottom shells, 3D honeycomb 10 %, 0.45 / 0.2 -
 *            every layer's sparse length and move count, the honeycomb's line spacing on a straight layer, how close to the edge the
 *            lines come, and points along its lines (in from the edge: the joins along the outline are not the lattice).
 *   arachne  the other (Studio 02.08.02.61): Arachne, 2 walls (0.42 outer, 0.45 inner), grid 15 %, 3 bottom / 5 top - every layer's
 *            length by feature and the inset of each feature from the edge (at mid height and on the top layer).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../nso-3mf-read.js');
const G = require('../nso-gcode-lines.js');

const ROOT = path.join(__dirname, '..');
const r4 = v => Math.round(v * 1e4) / 1e4;

async function read(file) {
  const zip = R.openZip(new Uint8Array(fs.readFileSync(file)));
  const txt = b => new TextDecoder().decode(b);
  const gcode = txt(await zip.read('Metadata/plate_1.gcode'));
  const plate = JSON.parse(txt(await zip.read('Metadata/plate_1.json')));
  const config = JSON.parse(txt(await zip.read('Metadata/project_settings.config')));
  return { gcode, plate, config, parsed: G.parseGcode(gcode), studio: (/^; BambuStudio ([\d.]+)/m.exec(gcode) || [])[1] };
}

/* the foot at the plate's far right (bbox 94..154 x 101..161), by its label: the object whose moves fall in that box */
function footOf(f) {
  const box = f.plate.bbox_objects.slice().sort((a, b) => (b.bbox[0] + b.bbox[1]) - (a.bbox[0] + a.bbox[1]))[0].bbox;
  const ids = {};
  f.parsed.moves.forEach(m => { if (m.width > 0 && m.x0 > box[0] && m.x0 < box[2] && m.y0 > box[1] && m.y0 < box[3]) ids[m.objectId] = (ids[m.objectId] || 0) + 1; });
  const id = Object.keys(ids).sort((a, b) => ids[b] - ids[a])[0];
  return { box: box.map(v => Math.round(v * 1000) / 1000), moves: f.parsed.moves.filter(m => String(m.objectId) === id && m.width > 0) };
}

function changesOf(cfg) {
  const d = cfg.different_settings_to_system, o = {};
  (Array.isArray(d) && d[0] ? String(d[0]).split(';').filter(Boolean) : []).forEach(k => { const v = cfg[k]; o[k] = Array.isArray(v) ? String(v[0]) : String(v); });
  return o;
}
function settingsOf(cfg, keys) { const o = {}; keys.forEach(k => { o[k] = Array.isArray(cfg[k]) ? cfg[k][0] : cfg[k]; }); return o; }
const KEYS = ['wall_generator', 'wall_loops', 'top_shell_layers', 'top_shell_thickness', 'bottom_shell_layers', 'bottom_shell_thickness', 'sparse_infill_density',
  'sparse_infill_pattern', 'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width', 'layer_height', 'initial_layer_print_height', 'detect_thin_wall',
  'min_bead_width', 'min_feature_size', 'wall_transition_angle', 'wall_transition_filter_deviation', 'wall_transition_length', 'wall_distribution_count'];

(async () => {
  const [fa, fb] = process.argv.slice(2);
  if (!fa || !fb) { console.error('usage: node tools/nso_slicer_feet_reference.js <bambu_arachne.gcode.3mf> <anti_vibration ... .gcode.3mf>'); process.exit(2); }
  const A = await read(fa), B = await read(fb);
  const inset = (box, x, y) => Math.min(x - box[0], box[2] - x, y - box[1], box[3] - y);

  /* --- no walls: 3D honeycomb alone --- */
  const fa1 = footOf(A), nLayers = Math.max(...fa1.moves.map(m => m.layer)) + 1;
  const sparse = [], count = [];
  for (let L = 0; L < nLayers; L++) { const ms = fa1.moves.filter(m => m.layer === L); sparse.push(r4(ms.reduce((t, m) => t + m.length, 0))); count.push(ms.length); }
  const features = [...new Set(fa1.moves.map(m => m.feature))];
  let edge = Infinity;
  fa1.moves.forEach(m => { edge = Math.min(edge, inset(fa1.box, m.x0, m.y0), inset(fa1.box, m.x1, m.y1)); });
  /* straight layers: the few-move ones; their line spacing across the long moves */
  const straight = count.map((n, L) => [n, L]).filter(x => x[0] < 60).map(x => x[1]);
  const cx = (fa1.box[0] + fa1.box[2]) / 2, cy = (fa1.box[1] + fa1.box[3]) / 2;
  const us = [...new Set(fa1.moves.filter(m => m.layer === straight[0] && m.length > 5 && Math.abs(Math.abs(m.x1 - m.x0) - Math.abs(m.y1 - m.y0)) < 1e-3)
    .map(m => { const s = Math.sign((m.x1 - m.x0) * (m.y1 - m.y0)); return r4(s > 0 ? ((m.x0 - cx) - (m.y0 - cy)) / Math.SQRT2 : ((m.x0 - cx) + (m.y0 - cy)) / Math.SQRT2); }))].sort((a, b) => a - b);
  const D = (us[us.length - 1] - us[0]) / (us.length - 1);
  /* points along the lattice, 1.5 mm or more in from the edge, every 10th layer, every 3 mm along each move */
  const points = {};
  for (let L = 0; L < nLayers; L += 10) {
    const pts = [];
    fa1.moves.filter(m => m.layer === L).forEach(m => { const n = Math.max(1, Math.ceil(m.length / 3)); for (let k = 0; k <= n; k++) {
      const x = m.x0 + (m.x1 - m.x0) * k / n, y = m.y0 + (m.y1 - m.y0) * k / n;
      if (inset(fa1.box, x, y) >= 1.5) pts.push([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]); } });
    points[L] = pts;
  }

  /* --- Arachne, two walls --- */
  const fb1 = footOf(B), nB = Math.max(...fb1.moves.map(m => m.layer)) + 1;
  const byFeature = {};
  fb1.moves.forEach(m => { const a = byFeature[m.feature] = byFeature[m.feature] || new Array(nB).fill(0); a[m.layer] += m.length; });
  Object.keys(byFeature).forEach(k => { byFeature[k] = byFeature[k].map(r4); });
  const insetsAt = L => { const o = {}; fb1.moves.filter(m => m.layer === L).forEach(m => { const d = Math.min(inset(fb1.box, m.x0, m.y0), inset(fb1.box, m.x1, m.y1)); o[m.feature] = Math.min(o[m.feature] == null ? Infinity : o[m.feature], d); });
    Object.keys(o).forEach(k => { o[k] = r4(o[k]); }); return o; };
  const widths = {};
  fb1.moves.forEach(m => { const w = widths[m.feature] = widths[m.feature] || { min: Infinity, max: -Infinity }; w.min = Math.min(w.min, m.width); w.max = Math.max(w.max, m.width); });
  Object.keys(widths).forEach(k => { widths[k] = [r4(widths[k].min), r4(widths[k].max)]; });

  const out = {
    source: 'Two real Bambu Studio slices of one plate, the owner\'s (2026-11-19): four 60 x 60 x 24 mm blocks printed in TPU as anti-vibration feet ' +
      '("Grand Krunk"), G-code only. Measured off one foot (box ' + fa1.box.join(', ') + ') by tools/nso_slicer_feet_reference.js; the files ' +
      'themselves (the designer\'s model, pictures and description) are not in the repo. docs/SLICER.md "Arachne" and "3D honeycomb".',
    noWalls: {
      file: 'bambu_arachne.gcode.3mf', studio: A.studio, settings: settingsOf(A.config, KEYS), box: fa1.box, layers: nLayers, features,
      edgeMm: r4(edge), lineSpacingMm: r4(D), straightLayers: straight, sparseMm: sparse, moves: count, points,
      /* what the owner changed in Studio (different_settings_to_system, the process's): the Print card takes exactly these from the project */
      projectChanges: changesOf(A.config), printSettingsId: settingsOf(A.config, ['print_settings_id']).print_settings_id
    },
    arachne: {
      file: path.basename(fb).replace(/^[0-9a-f]{8}-/, '').replace(/[^\w .()-]/g, ''), studio: B.studio, settings: settingsOf(B.config, KEYS), box: fb1.box, layers: nB,
      lengthMm: byFeature, widthMm: widths, insetMm: { mid: insetsAt(Math.floor(nB / 2)), top: insetsAt(nB - 1) }
    }
  };
  const dest = path.join(ROOT, 'fixtures', 'slicer-feet-reference.json');
  fs.writeFileSync(dest, JSON.stringify(out) + '\n');
  console.log('wrote', path.relative(ROOT, dest), (fs.statSync(dest).size / 1024).toFixed(0) + ' KB:',
    'no walls - D ' + out.noWalls.lineSpacingMm + ', straight ' + straight.join(' ') + ', edge ' + out.noWalls.edgeMm + ', ' +
    Object.values(points).reduce((t, p) => t + p.length, 0) + ' points; arachne - insets ' + JSON.stringify(out.arachne.insetMm));
})();
