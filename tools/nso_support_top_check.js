#!/usr/bin/env node
/* WHERE THE SUPPORT STOPS, AGAINST BAMBU'S OWN SLICE.
     node tools/nso_support_top_check.js                 the card's default build (raft off) of the six reference heads, sliced
     node tools/nso_support_top_check.js --raft          the same with the Raft interface on
     node tools/nso_support_top_check.js --only=circular,sphere
     npm run support:top

   The rule, read off Bambu's slice of the six heads (fixtures/supports/tree_slimsupports.gcode.3mf): a head's support runs up to the TOP layer that
   has Overhang wall - its last line 0.2 - 0.4 mm under it - and nothing above, because what is printed above that layer has something under it.

   Three things are measured per head, and they fail for different reasons:
     the SUPPORT   its top (the highest Support, interface or transition line) against the overhang's top: gap = overhang top - support top.
                   Bambu's gap is 0.2 - 0.4 mm on all six. This is the generator.
     the CLASSIFIER our slicer's top Overhang-wall layer against Bambu's, and how much overhang wall it finds in all (Bambu: a wall is overhang where its
                   whole width hangs past the layer below). A support cannot reach a layer our slicer never calls an overhang; one that calls too much asks for more.
   Gates: our overhang top is within 0.4 mm of Bambu's (the slicer, held). The support's gap under Bambu's own overhang top has a GOAL, 0 - 0.8 mm
   (a note where it is not met, today on the four heads whose tops are ledges and apexes), and a FLOOR, 2.2 mm, that fails: before the narrow ledge
   (docs/SUPPORT-TOP.md) Circular stopped 6.4 and Sphere 5.6 mm under it. --report prints and never fails. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SL = require(path.join(ROOT, 'nso_slicer.js'));
const RP = require('./nso_support_ref_pieces.js');
const PE = require('./nso_supports_print_export.js');
const AUDIT = require('./nso_slicer_audit.js');
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const G = require(path.join(ROOT, 'nso-gcode-lines.js'));
const M = require(path.join(ROOT, 'nso_gscope_measure.js'));

const args = process.argv.slice(2);
const RAFT = args.includes('--raft'), REPORT = args.includes('--report');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const REF = path.join(ROOT, 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');
const KEYS = RP.NAMES.filter(k => !ONLY.length || ONLY.includes(k));
const SUPPORT_GAP_GOAL = 0.8, SUPPORT_GAP_FLOOR = 2.2, CLASSIFIER_TOL = 0.4, LENGTH_RATIO = [0.8, 1.3];
const headName = n => String(n).replace(/\.stl$/, '').replace(/ - (support|brim).*$/, '');

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) pass++; else if (!REPORT) fail++; console.log('  ' + (cond ? 'ok    ' : REPORT ? 'note  ' : 'FAIL  ') + name + (detail ? '   ' + detail : '')); };
const f2 = v => v == null ? '  -  ' : (+v).toFixed(2);

/* Bambu's own: its slice, read the way the viewer reads any slice, a head joined to its support by the object's name */
async function bambu() {
  const bytes = new Uint8Array(fs.readFileSync(REF));
  const doc = await G.readSlicedGcode3MF(bytes, { name: 'ref' });
  const zip = R3.openZip(bytes);
  const names = AUDIT.sliceNames(new TextDecoder().decode(await zip.read('Metadata/slice_info.config')));
  return M.reach(doc.parsed.moves, { headOf: m => names[m.objectId] ? headName(names[m.objectId]) : null });
}

/* ours: the card's build, sliced by our own slicer */
async function ours(WASM, key) {
  const piece = await RP.build(key);
  const OUT = RAFT ? { inset: 1, seed: 1, ledge: 1, perimeter: 1, fill: 1, region: 1 } : { inset: 1, seed: 1, ledge: 1, perimeter: 1, fill: 1 };
  const b = await PE.build(piece, null, RP.PROJECT_NAME[key].replace(/\.stl$/, ''), true, true, OUT);
  const objs = [{ name: 'part', soup: piece, key: 101, role: 'part' }].concat(b.objects.slice(1).map((x, i) => ({ name: x.name, soup: x.soup, key: 201 + i, role: 'support', hostKey: 101, brim: !!x.brim })));
  const r = SL.sliceObjects(objs, SL.defaultsFor(0.4, {}), WASM);
  if (!r.ok) throw new Error('slice failed: ' + r.reason);
  const moves = [];
  r.objects.forEach(ob => (ob.layers || []).forEach(L => (L.paths || []).forEach(p => { let l = 0; for (let i = 0; i + 1 < p.pts.length; i++) l += Math.hypot(p.pts[i + 1][0] - p.pts[i][0], p.pts[i + 1][1] - p.pts[i][1]); moves.push({ feature: p.feature, z: L.printZ, objectId: 'h', length: l }); })));
  const row = M.reach(moves, { headOf: m => m.objectId })[0] || {};
  const sup = r.objects.filter(o => o.role === 'support').length;
  return Object.assign(row, { head: key, supports: sup });
}

(async () => {
  console.log('support top vs the top overhang-wall layer - ' + (RAFT ? 'Raft interface ON' : 'the card\'s default, raft OFF') + (REPORT ? ' (report only)' : ''));
  const ref = await bambu();
  const byName = {};
  ref.forEach(r => { byName[r.head] = r; });
  const WASM = await SL.loadKernel({});
  console.log('\n head                    | Bambu: overhang top  support top  gap | ours: overhang top  support top  gap | support vs Bambu\'s overhang top');
  for (const key of KEYS) {
    const name = headName(RP.PROJECT_NAME[key]), B = byName[name];
    if (!B) { check(name + ': in the reference', false, 'not found'); continue; }
    const t0 = Date.now();
    let O;
    try { O = await ours(WASM, key); } catch (e) { check(name + ': built and sliced', false, e.message); continue; }
    const vsB = O.supportTop == null ? null : Math.round((B.overhangTop - O.supportTop) * 100) / 100;
    console.log(' ' + name.padEnd(23) + ' |        ' + f2(B.overhangTop) + '        ' + f2(B.supportTop) + '  ' + f2(B.gapMm) + ' |       ' + f2(O.overhangTop) + '        ' + f2(O.supportTop) + '  ' + f2(O.gapMm) + ' | ' + f2(vsB) + '  (' + O.supports + ' supports, ' + (Date.now() - t0) + ' ms)');
    const okFloor = vsB != null && vsB >= -0.2 && vsB <= SUPPORT_GAP_FLOOR + 1e-9, okGoal = vsB != null && vsB >= -0.2 && vsB <= SUPPORT_GAP_GOAL + 1e-9;
    check(name + ': the support stops within ' + SUPPORT_GAP_FLOOR + ' mm under the top of Bambu\'s overhang (the floor)', okFloor, 'support top ' + f2(O.supportTop) + ' vs overhang top ' + f2(B.overhangTop));
    if (okFloor && !okGoal) console.log('  note  ' + name + ': ' + f2(vsB) + ' mm under it; the goal is ' + SUPPORT_GAP_GOAL + ' (Bambu: 0.2 - 0.4)');
    const ratio = B.overhangMm > 0 && O.overhangMm != null ? O.overhangMm / B.overhangMm : null;
    check(name + ': our overhang wall is as long as Bambu\'s, within ' + LENGTH_RATIO.join(' - ') + ' x (a wall is overhang where its whole width hangs)', ratio != null && ratio >= LENGTH_RATIO[0] && ratio <= LENGTH_RATIO[1], 'ours ' + f2(O.overhangMm) + ' mm vs Bambu ' + f2(B.overhangMm) + ' mm');
    check(name + ': our top overhang-wall layer is Bambu\'s, within ' + CLASSIFIER_TOL + ' mm', O.overhangTop != null && Math.abs(O.overhangTop - B.overhangTop) <= CLASSIFIER_TOL + 1e-9, 'ours ' + f2(O.overhangTop) + ' vs Bambu ' + f2(B.overhangTop));
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
