#!/usr/bin/env node
/* ============================================================
   tools/nso_slicer_brim_check.js - the brim, as Bambu lays it on its six test heads.   (npm run slicer:brim)

   The owner's note (supports-one-trunk, third round): Bambu puts a [Brim] ring round the stem of each model, used the way the tree's
   pad is - added hold for a tall thin part, at times all that holds it - and the brim and the pad "meet but do not join". Read off
   fixtures/supports/tree_slimsupports.gcode.3mf (A1 mini, auto_brim, brim_width 5, brim_object_gap 0.1): one layer (0.2), 10 loops
   of a 0.5 mm line at 0.457 spacing, the first 0.1 mm off the wall, the outermost printed first, cut where the support's first layer is
   (centre to centre 0.49 - 0.51 mm: edge to edge, not joined). NSO_Slicer's brimType ('none' by default, 'auto', 'outer') does the same:

   1. the reference's loops, widths and its brim to pad distance read;
   2. ours on the six heads (the card's one-trunk Auto supports, sliced): 10 loops of 0.5 mm line on the first layer and on no other,
      the first 0.35 mm (0.1 + half a line) off the part's outline, the outermost 4.46 mm, the brim's length within 20 % of Bambu's,
      printed before every other line of the layer, and edge to edge 0 - 0.15 mm from the pad's lines (they touch, never overlap);
   3. a flat part (a 40 x 40 x 5 plate) gets none in auto, one in 'outer'; 'none' (the default) gets none anywhere.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const RP = require('./nso_support_ref_pieces.js');
const PE = require('./nso_supports_print_export.js');
const AUDIT = require('./nso_slicer_audit.js');
const R3 = require('../nso-3mf-read.js');
const SL = require('../nso_slicer.js');
const REF_FILE = path.join(__dirname, '..', 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok    ' + n + (d ? '   ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '   ' + d : '')); } };
const f2 = v => v.toFixed(2);
const segd = (px, py, x1, y1, x2, y2) => { const ex = x2 - x1, ey = y2 - y1, ee = ex * ex + ey * ey; let t = ee > 1e-18 ? ((px - x1) * ex + (py - y1) * ey) / ee : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - x1 - t * ex, py - y1 - t * ey); };
const len = pts => pts.reduce((a, q, i) => i ? a + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0, 0);
function distToPolys(x, y, polys) { let b = Infinity; for (const P of polys) for (let i = 0; i < P.length; i++) { const a = P[i], c = P[(i + 1) % P.length]; b = Math.min(b, segd(x, y, a[0], a[1], c[0], c[1])); } return b; }

(async () => {
  const WASM = await SL.loadKernel({});
  console.log('\n=== 1. the reference ===');
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(REF_FILE)));
  const gcode = new TextDecoder().decode(await zip.read(zip.names().find(n => /plate_\d+\.gcode$/.test(n))));
  const mv = AUDIT.extrusions(gcode);
  const br = mv.filter(m => m.feat === 'Brim');
  const byObj = new Map();
  br.forEach(m => byObj.set(m.obj, (byObj.get(m.obj) || 0) + m.len));
  const zs = [...new Set(br.map(m => m.z.toFixed(2)))];
  console.log('        brim: layers ' + zs.join(', ') + '; per object length ' + [...byObj.values()].map(v => v.toFixed(0)).join(' / ') + ' mm');
  check('Bambu brims all six heads on the first layer only', byObj.size === 6 && zs.length === 1 && zs[0] === '0.20');
  const refLen = [...byObj.values()].reduce((a, v) => a + v, 0) / 6;

  console.log('\n=== 2. ours, the six heads ===');
  const lens = [];
  for (const k of RP.NAMES) {
    const piece = await RP.build(k);
    const b = await PE.build(piece, null, RP.PROJECT_NAME[k].replace(/\.stl$/, ''), true);
    const objs = [{ name: 'part', soup: piece, key: 101, role: 'part' }].concat(b.objects.slice(1).map((x, i) => ({ name: x.name, soup: x.soup, key: 201 + i, role: 'support', hostKey: 101 })));
    const r = SL.sliceObjects(objs, SL.defaultsFor(0.4, { supportInterfaceLayers: 3, brimType: 'auto' }), WASM);
    const part = r.objects.find(o => o.role === 'part'), L0 = part.layers[0];
    const brim = L0.paths.filter(p => p.feature === 'Brim');
    const others = part.layers.slice(1).some(L => L.paths.some(p => p.feature === 'Brim'));
    const total = brim.reduce((a, p) => a + len(p.pts), 0); lens.push(total);
    const outline = L0.sectionPolys.filter(p => p.length > 2);
    let dmin = Infinity, dmax = 0;
    brim.forEach(p => p.pts.forEach(q => { const d = distToPolys(q[0], q[1], outline); dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); }));
    const sup = [].concat(...r.objects.filter(o => o.role === 'support').map(o => o.layers[0].paths));
    let dpad = Infinity;
    brim.forEach(p => p.pts.forEach(q => sup.forEach(s => { for (let i = 0; i + 1 < s.pts.length; i++) dpad = Math.min(dpad, segd(q[0], q[1], s.pts[i][0], s.pts[i][1], s.pts[i + 1][0], s.pts[i + 1][1]) - (p.width + s.width) / 2); })));   // edge to edge
    const firstIdx = L0.paths.findIndex(p => p.feature !== 'Brim');
    const brimFirst = brim.length > 0 && L0.paths.slice(0, brim.length).every(p => p.feature === 'Brim') && firstIdx === brim.length;
    console.log('        ' + k.padEnd(11) + brim.length + ' paths, ' + total.toFixed(0) + ' mm; centres ' + f2(dmin) + ' - ' + f2(dmax) + ' mm off the outline; nearest pad line ' + f2(dpad) + ' mm edge to edge');
    check(k + ': a brim of 10 loops, 0.5 mm line, on the first layer only, printed first', brim.length >= 10 && brim.every(p => Math.abs(p.width - 0.5) < 1e-9) && !others && brimFirst);
    check(k + ': the first loop 0.35 mm off the outline (0.1 + half a line), the outermost 4.46 (Bambu: 5 mm wide, 10 loops)', Math.abs(dmin - 0.35) < 0.05 && Math.abs(dmax - 4.46) < 0.1, f2(dmin) + ' / ' + f2(dmax));
    check(k + ': meets the pad, does not join it: the lines\' edges 0 - 0.15 mm apart (Bambu\'s: 0 - 0.05), never overlapping', dpad >= -0.03 && dpad <= 0.15, f2(dpad));
  }
  const mean = lens.reduce((a, v) => a + v, 0) / lens.length;
  check('the brim is as long as Bambu\'s, to 20 %: ' + mean.toFixed(0) + ' mm a head against ' + refLen.toFixed(0), Math.abs(mean / refLen - 1) < 0.2);

  console.log('\n=== 3. which parts ===');
  const plate = new Float32Array([0, 0, 0, 40, 0, 0, 40, 40, 0, 0, 0, 0, 40, 40, 0, 0, 40, 0]);
  const box = (x0, y0, z0, x1, y1, z1) => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    return new Float32Array([].concat(...F.map(f => [].concat(...f.map(i => v[i])))));
  };
  const count = (soup, type) => SL.sliceObjects([{ name: 'p', soup, key: 1, role: 'part' }], SL.defaultsFor(0.4, { brimType: type }), WASM).objects[0].layers[0].paths.filter(p => p.feature === 'Brim').length;
  const flat = box(0, 0, 0, 40, 40, 5), tall = box(0, 0, 0, 5, 5, 30);
  check('a flat plate: no brim in auto, one in outer, none by default', count(flat, 'auto') === 0 && count(flat, 'outer') >= 10 && count(flat, undefined) === 0);
  check('a tall stem: a brim in auto, none off', count(tall, 'auto') >= 10 && count(tall, 'none') === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
