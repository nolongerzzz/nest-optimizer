'use strict';
/* gscope:measure - nso_gscope_measure.js, the numbers behind G-scope's MEASURE row.
 *
 *   1. a made zigzag reads back as one run of ten strokes at its pitch and angle
 *   2. a row per (layer, feature); a feature only one side has is named
 *   3. on a real sliced file every move is counted once: the feature rows sum to the file's
 *   4. NSO_MEASURE_REF=<Bambu supp_ref.gcode.3mf> NSO_MEASURE_REF_OBJ=<name>: the reference's
 *      flat head reads as docs/SUPPORT-INTERFACE.md says (2 runs a layer, ~259 mm, pitch 0.46)
 */
const fs = require('fs'), path = require('path');
const M = require('../nso_gscope_measure.js');
const G = require('../nso-gcode-lines.js');
const R3 = require('../nso-3mf-read.js');

let fails = 0;
function ok(cond, what, detail) { console.log((cond ? '  ok    ' : '  FAIL  ') + what + (detail ? '   ' + detail : '')); if (!cond) fails++; }
const near = (a, b, t) => Math.abs(a - b) <= t;

(async () => {
  /* 1. a zigzag: strokes along 45 deg, a pitch apart, joined at alternate ends */
  function zig(z, feat, pitch, n, len, layer, idx0) {
    const mv = []; let i = idx0 || 0;
    const ux = Math.SQRT1_2, uy = Math.SQRT1_2, nx = -uy, ny = ux;
    let x = 0, y = 0;
    for (let k = 0; k < n; k++) {
      const dir = k % 2 ? -1 : 1;
      const x1 = x + dir * ux * len, y1 = y + dir * uy * len;
      mv.push({ index: i++, x0: x, y0: y, x1, y1, z, width: 0.42, height: 0.2, length: len, layer, feature: feat, objectId: 1 });
      x = x1; y = y1;
      if (k < n - 1) { const x2 = x + nx * pitch, y2 = y + ny * pitch; mv.push({ index: i++, x0: x, y0: y, x1: x2, y1: y2, z, width: 0.42, height: 0.2, length: pitch, layer, feature: feat, objectId: 1 }); x = x2; y = y2; }
    }
    return mv;
  }
  const L1 = zig(10, 'Support interface', 0.5, 10, 10, 0, 0);
  const rows1 = M.layerRows(L1, { features: ['Support interface'] });
  ok(rows1.length === 1, 'one row for one layer and feature', 'rows ' + rows1.length);
  const r = rows1[0] || {};
  ok(r.runs === 1, 'a zigzag laid without lifting is ONE run', 'runs ' + r.runs);
  ok(r.longLines === 10, 'ten strokes', 'long ' + r.longLines);
  ok(near(r.pitchMm, 0.5, 0.02), 'its pitch is read back', 'pitch ' + (r.pitchMm && r.pitchMm.toFixed(3)));
  ok(r.domDeg === 45, 'its angle is read back', 'deg ' + r.domDeg);
  ok(near(r.lengthMm, 10 * 10 + 9 * 0.5, 0.01), 'its length is the moves\' own', 'mm ' + (r.lengthMm && r.lengthMm.toFixed(2)));
  const lifted = L1.slice(); lifted.splice(5, 0, { index: 4.5, x0: 100, y0: 100, x1: 101, y1: 100, z: 10, width: 0.42, height: 0.2, length: 1, layer: 0, feature: 'Sparse infill', objectId: 1 });
  ok(M.layerRows(lifted, { features: ['Support interface'] })[0].runs === 2, 'a move of another feature between breaks the run in two');

  /* 2. rows per layer and feature; the compare names what only one side has */
  const L2 = zig(10.2, 'Support transition', 0.5, 6, 8, 1, 100);
  const all = L1.concat(L2);
  const rows2 = M.layerRows(all);
  ok(rows2.length === 2 && rows2[0].z < rows2[1].z, 'a row per (Z, feature), bottom first', rows2.map(x => x.z + ':' + x.feature).join(' '));
  const sA = M.summarize(all), sB = M.summarize(L1);
  const cmp = M.compare(sA, sB);
  ok(cmp.onlyA.length === 1 && cmp.onlyA[0] === 'Support transition' && !cmp.onlyB.length, 'a feature only one side has is named', JSON.stringify([cmp.onlyA, cmp.onlyB]));
  ok(near(sA.lengthMm, sB.lengthMm + M.summarize(L2).lengthMm, 1e-6), 'a summary adds the moves it is given');

  /* 2b. reach: where a head's support stops against the top Overhang-wall layer (docs/SUPPORT-TOP.md) */
  {
    const mv = [];
    const put = (z, feat, obj) => mv.push({ index: mv.length, x0: 0, y0: 0, x1: 1, y1: 0, z, width: 0.42, height: 0.2, length: 1, layer: 0, feature: feat, objectId: obj });
    [5, 10, 15.2].forEach(z => put(z, 'Overhang wall', 'a'));
    [2, 14.8].forEach(z => put(z, 'Support', 'a'));
    put(14.4, 'Support interface', 'a');
    put(9.8, 'Support', 'b'); put(10, 'Overhang wall', 'b');
    put(7, 'Outer wall', 'c');
    const rows = M.reach(mv, { headOf: m => m.objectId });
    const a = rows.find(r => r.head === 'a'), b = rows.find(r => r.head === 'b');
    ok(a && near(a.overhangTop, 15.2, 1e-9) && near(a.supportTop, 14.8, 1e-9) && near(a.gapMm, 0.4, 1e-9), 'reach: the top overhang layer, the top support line and the gap between', JSON.stringify(a));
    ok(a && near(a.interfaceTop, 14.4, 1e-9), 'reach: the interface top is its own', a && a.interfaceTop);
    ok(b && near(b.gapMm, 0.2, 1e-9), 'reach: a second head is read on its own', JSON.stringify(b));
    const c = rows.find(r => r.head === 'c');
    ok(c && c.overhangTop === null && c.supportTop === null && c.gapMm === null, 'reach: a head with neither overhang nor support has a row of nulls, and no gap', JSON.stringify(c));
  }

  /* 3. a real sliced file: every move counted once */
  const fx = path.join(__dirname, '..', 'fixtures', 'supports', 'simple_overhang_bambu.gcode.3mf');
  const res = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(fx)), { name: 'x' });
  const mv = res.parsed.moves, s = M.summarize(mv);
  ok(s.moves === mv.length, 'the summary counts every move of the file', s.moves + ' of ' + mv.length);
  ok(s.features.reduce((a, f) => a + f.moves, 0) === mv.length, 'the feature rows sum to the file');
  ok(s.objects.reduce((a, f) => a + f.moves, 0) === mv.length, 'the object rows sum to the file');
  ok(near(s.features.reduce((a, f) => a + f.lengthMm, 0), s.lengthMm, 1e-6), 'and in length');
  const rep = M.report(s, M.layerRows(mv)); ok(rep.indexOf('G-scope measure') === 0 && rep.split('\n').length > 5, 'the report is plain text');

  /* 4. the reference, when it is given */
  const REF = process.env.NSO_MEASURE_REF;
  if (REF && fs.existsSync(REF)) {
    const ref = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(REF)), { name: 'ref' });
    const AUDIT = require('./nso_slicer_audit.js');
    const zip = R3.openZip(new Uint8Array(fs.readFileSync(REF)));
    const names = AUDIT.sliceNames(new TextDecoder().decode(await zip.read('Metadata/slice_info.config')));
    const want = process.env.NSO_MEASURE_REF_OBJ || 'Support Base.stl';
    const ids = Object.keys(names).filter(i => names[i] === want).map(Number);
    const rr = M.layerRows(ref.parsed.moves.filter(m => ids.includes(+m.objectId)), { features: ['Support interface', 'Support transition'] });
    ok(rr.length === 5, 'the reference head: 2 transition + 3 interface layers', 'rows ' + rr.length);
    ok(rr.every(x => x.runs === 2), 'two runs a layer', rr.map(x => x.runs).join(','));
    ok(rr.every(x => near(x.lengthMm, 259, 12)), 'about 259 mm a layer', rr.map(x => x.lengthMm.toFixed(0)).join(','));
    ok(rr.every(x => near(x.pitchMm, 0.46, 0.02)), 'pitch 0.46', rr.map(x => x.pitchMm && x.pitchMm.toFixed(2)).join(','));
  } else console.log('  skip  the reference (set NSO_MEASURE_REF to supp_ref.gcode.3mf)');

  console.log(fails ? '\nFAILED ' + fails : '\nPASSED all');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
