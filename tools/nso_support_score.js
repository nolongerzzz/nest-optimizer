#!/usr/bin/env node
/* THE PLATE SCORE: every piece of the six-part supp_ref, generated and sliced here, against Bambu's own slice of it, by the same diff
   G-scope's Compare > Measure reads (nso-gscope-diff.js). One table, so a change that mends one piece shows what it did to the others.

     NSO_SCORE_REF=supp_ref.gcode.3mf node tools/nso_support_score.js [--json out.json] [--vs before.json] [--piece Oblique]

   Per piece, for the interface + transition (the plate that touches the model and has to break away) and for the tree:
     IoU   material both have / (both + only ours + only theirs), summed over the layers, 0 - 1; higher is better
     len   our line length / theirs                       (1.00 = the same amount of line)
     mv    our move count / theirs                        (1.00 = lines as long as theirs; high = chopped up)
     z0    first layer, ours / theirs                     (a plate that starts late or early)
   The two are put in one frame by the centre of the part's outer wall.
   No reference given: nothing to score, exit 0. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const lib = require('./nso_support_plate_lib.js');
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const G = require(path.join(ROOT, 'nso-gcode-lines.js'));
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const AUDIT = require('./nso_slicer_audit.js');
const D = require(path.join(ROOT, 'nso-gscope-diff.js'));

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const REF = process.env.NSO_SCORE_REF;
const PLATE = ['interface', 'transition'];

function centre(moves) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  moves.forEach(m => { if (m.feature !== 'Outer wall') return; x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1); y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1); });
  return isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}

function movesOf(result) {
  const out = [];
  result.objects.forEach(ob => (ob.layers || []).forEach(L => (L.paths || []).forEach(p => {
    const pts = p.pts.slice();
    if (p.closed && pts.length > 2) pts.push(pts[0]);
    for (let q = 1; q < pts.length; q++) {
      out.push({ feature: p.feature, z: L.printZ, x0: pts[q - 1][0], y0: pts[q - 1][1], x1: pts[q][0], y1: pts[q][1], width: p.width || 0.42, height: L.h || 0.2,
                 length: Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]) });
    }
  })));
  return out;
}

function scoreOf(rep) {
  const sum = (f) => PLATE.reduce((a, c) => a + f(rep.classes[c]), 0);
  const both = sum(c => c.bothMm2), oa = sum(c => c.onlyAMm2), ob = sum(c => c.onlyBMm2);
  const lenA = sum(c => c.A.lengthMm), lenB = sum(c => c.B.lengthMm), mvA = sum(c => c.A.moves), mvB = sum(c => c.B.moves);
  const z0 = (side) => { const v = PLATE.map(c => rep.classes[c][side].firstZ).filter(v => v != null); return v.length ? Math.min.apply(null, v) : null; };
  const T = rep.classes.support;
  return {
    plateIoU: both + oa + ob ? both / (both + oa + ob) : null, plateBothMm2: both, plateOnlyOursMm2: oa, plateOnlyTheirsMm2: ob,
    lenRatio: lenB ? lenA / lenB : null, mvRatio: mvB && lenB && lenA ? (mvA / lenA) / (mvB / lenB) : null,    // moves per mm of line, ours over theirs
    z0Ours: z0('A'), z0Theirs: z0('B'),
    treeIoU: T.bothMm2 + T.onlyAMm2 + T.onlyBMm2 ? T.bothMm2 / (T.bothMm2 + T.onlyAMm2 + T.onlyBMm2) : null,
    treeLenRatio: T.B.lengthMm ? T.A.lengthMm / T.B.lengthMm : null
  };
}

(async () => {
  if (!REF || !fs.existsSync(REF)) { console.log('nso_support_score: set NSO_SCORE_REF to supp_ref.gcode.3mf (Bambu\'s slice of the six pieces) - nothing to score.'); return; }
  const only = arg('--piece');
  const objs = await lib.readFixture(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  const bytes = new Uint8Array(fs.readFileSync(REF));
  const ref = await G.readSlicedGcode3MF(bytes, { name: 'ref' });
  const zip = R3.openZip(bytes);
  const names = AUDIT.sliceNames(new TextDecoder().decode(await zip.read('Metadata/slice_info.config')));
  const app = lib.makeApp(); const ids = app.load(objs); app.openCard(); app.setPlateBox(true);
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  const WASM = await SL.loadKernel({});
  const rows = {};
  for (let i = 0; i < objs.length; i++) {
    const nm = objs[i].name.replace(/\.stl$/i, '');
    if (only && !nm.includes(only)) continue;
    const sups = app.supportsOf(ids[i]).map(m => Array.from(app.soupOf(m.id)));
    const objl = [{ name: 'part', soup: Float32Array.from(app.soupOf(ids[i])), key: 101, role: 'part' }]
      .concat(sups.map((s, k) => ({ name: 's' + k, soup: Float32Array.from(s), key: 201 + k, role: 'support', hostKey: 101 })));
    const ours = movesOf(SL.sliceObjects(objl, SL.defaultsFor(0.4, { supportInterfaceLayers: 3 }), WASM));
    const rid = Object.keys(names).filter(k => names[k] === objs[i].name).map(Number);
    const theirs = ref.parsed.moves.filter(m => rid.includes(+m.objectId));
    const ca = centre(ours), cb = centre(theirs);
    if (!ca || !cb || !theirs.length) { console.log(nm.padEnd(22) + 'no reference object found'); continue; }
    const shifted = theirs.map(m => Object.assign({}, m, { x0: m.x0 - cb[0] + ca[0], x1: m.x1 - cb[0] + ca[0], y0: m.y0 - cb[1] + ca[1], y1: m.y1 - cb[1] + ca[1] }));
    const rep = D.compute(ours, shifted, {});
    rows[nm] = scoreOf(rep);
    // the footprint: every line of the plate drawn 1.6 mm wide, so lines 0.46 apart are one sheet, and a different zig-zag in the same ribbon is the same ribbon
    const fat = (ms) => ms.filter(m => /^Support (interface|transition)$/.test(m.feature)).map(m => Object.assign({}, m, { width: 1.6 }));
    const rf = D.compute(fat(ours), fat(shifted), {});
    const fb = PLATE.reduce((a, c) => a + rf.classes[c].bothMm2, 0), fa = PLATE.reduce((a, c) => a + rf.classes[c].onlyAMm2, 0), fo = PLATE.reduce((a, c) => a + rf.classes[c].onlyBMm2, 0);
    rows[nm].footIoU = fb + fa + fo ? fb / (fb + fa + fo) : null; rows[nm].footOnlyOursMm2 = fa; rows[nm].footOnlyTheirsMm2 = fo;
    rows[nm].gaps = { oursLacks: rep.gaps.aLacks.slice(0, 4), theirsLacks: rep.gaps.bLacks.slice(0, 2) };
  }
  const f = (v, d) => v == null ? '   -  ' : v.toFixed(d == null ? 2 : d).padStart(6);
  const before = arg('--vs') && fs.existsSync(arg('--vs')) ? JSON.parse(fs.readFileSync(arg('--vs'), 'utf8')) : null;
  console.log('piece                  foot IoU  line IoU  len   mv/mm   z0 ours/theirs   tree IoU  tree len' + (before ? '    foot IoU was' : ''));
  Object.keys(rows).forEach(nm => {
    const r = rows[nm], b = before && before[nm];
    console.log(nm.padEnd(22) + f(r.footIoU) + '  ' + f(r.plateIoU) + '    ' + f(r.lenRatio) + ' ' + f(r.mvRatio) + '   ' + f(r.z0Ours) + '/' + f(r.z0Theirs).trim().padEnd(6) + '   ' + f(r.treeIoU) + '   ' + f(r.treeLenRatio) +
                (b ? '      ' + f(b.footIoU) + (b.footIoU != null && r.footIoU != null ? (r.footIoU - b.footIoU >= 0 ? '  +' : '  ') + (r.footIoU - b.footIoU).toFixed(2) : '') : ''));
  });
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
