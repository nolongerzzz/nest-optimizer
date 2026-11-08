#!/usr/bin/env node
/* ============================================================
   tools/nso_support_gate.js - THE PRINTABILITY GATE (npm run support:gate, docs/SUPPORT-GATE.md)

   Does the interface print and break away the way Bambu's does? Measured on G-code, every head of supp_ref at once,
   each against Bambu's own slice of the same head (fixtures/supports/tree_slimsupports.gcode.3mf), so a change that
   mends one head and breaks another fails here.

     node tools/nso_support_gate.js                          build supp_ref with the card (Auto, Dense, 30 deg), slice it with
                                                             NSO_Slicer, gate it
     node tools/nso_support_gate.js --gcode a.gcode.3mf ...  gate sliced files instead (NSO's export, or Bambu Studio's slice of
                                                             NSO's support meshes); several are gated one after another
     --ref f.gcode.3mf     another reference         --json out.json     every number
     --rule column         slice with the column interface rule (NSO_Slicer supportInterfaceRule: 'column')
     --report              print, never fail
     --dump moves.json     (a build) every move, [head, role, feature, z, h, x0, y0, x1, y1], for a picture

   Exit 1 when any check fails (not with --report).
   ============================================================ */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const GL = require('./nso_support_gate_lib.js');
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const files = argv.filter((a, i) => /\.3mf$/i.test(a) && argv[i - 1] !== '--ref' && argv[i - 1] !== '--json');
const REF = arg('--ref') || path.join(ROOT, 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');
const REPORT = argv.includes('--report');

async function readSliced(file) {
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(file)));
  const dec = new TextDecoder();
  const gname = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
  const info = zip.names().includes('Metadata/slice_info.config') ? dec.decode(await zip.read('Metadata/slice_info.config')) : '';
  return GL.movesFromGcode(dec.decode(await zip.read(gname)), info);
}

/* the in-node build: the card's own build of supp_ref (tools/nso_support_score.js's harness), sliced piece by piece */
async function buildAndSlice(opts) {
  const lib = require('./nso_support_plate_lib.js');
  const SL = require(path.join(ROOT, 'nso_slicer.js'));
  const objs = await lib.readFixture(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  const app = lib.makeApp(); const ids = app.load(objs); app.openCard(); app.setPlateBox(true);
  app.card.angle(+(opts.angle || 30));
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  const WASM = await SL.loadKernel({});
  const moves = [];
  for (let i = 0; i < objs.length; i++) {
    const head = objs[i].name.replace(/\.stl$/i, '');
    const sups = app.supportsOf(ids[i]).map(m => Array.from(app.soupOf(m.id)));
    const objl = [{ name: 'part', soup: Float32Array.from(app.soupOf(ids[i])), key: 101, role: 'part' }]
      .concat(sups.map((s, k) => ({ name: 's' + k, soup: Float32Array.from(s), key: 201 + k, role: 'support', hostKey: 101 })));
    const so = { supportInterfaceLayers: 3, supportLayerMaxMm: 0.28 };
    if (opts.rule) so.supportInterfaceRule = opts.rule;
    const res = SL.sliceObjects(objl, SL.defaultsFor(0.4, so), WASM);
    res.objects.forEach(ob => (ob.layers || []).forEach(L => (L.paths || []).forEach(p => {
      if (p.feature === 'Brim' || p.role === 'brim') return;
      const pts = p.pts.slice(); if (p.closed && pts.length > 2) pts.push(pts[0]);
      const role = ob.role === 'support' || /^Support/.test(p.feature || '') ? 'support' : 'part';
      for (let q = 1; q < pts.length; q++) moves.push({ head, role, feat: p.feature, z: Math.round(L.printZ * 1000) / 1000, h: L.h || 0.2, w: p.width || 0.42,
        x0: pts[q - 1][0], y0: pts[q - 1][1], x1: pts[q][0], y1: pts[q][1] });
    })));
  }
  return moves;
}

const pct = (v) => v == null ? '  -  ' : (100 * v).toFixed(0).padStart(4) + '%';
function table(name, M) {
  console.log('\n' + name);
  console.log('  head                       touch  thin  contact | gap: one   two  | floating empty | carried depth specks');
  Object.keys(M).sort().forEach(h => {
    const r = M[h];
    console.log('  ' + h.padEnd(25) + r.touchMm2.toFixed(1).padStart(6) + r.thinMm2.toFixed(1).padStart(6) + r.contactMm2.toFixed(0).padStart(8) + '  | ' +
      pct(r.share.one) + ' ' + pct(r.share.two) + ' | ' + String(r.floating.length).padStart(6) + String(r.empty.length).padStart(7) + '  | ' +
      pct(r.carried) + '  ' + pct(r.depth) + '  ' + (r.specks == null ? '  -' : String(r.specks).padStart(4)));
    r.touchAt.slice(0, 3).forEach(t => console.log('      touching z ' + t.z.toFixed(2) + ' under the part layer ' + t.partZ.toFixed(2) + '  ' + t.areaMm2 + ' mm2 about X ' + t.x + ' Y ' + t.y));
    r.floating.slice(0, 3).forEach(f => console.log('      floating island z ' + f.z.toFixed(2) + '  ' + f.areaMm2 + ' mm2 at X ' + f.x + ' Y ' + f.y));
    r.empty.slice(0, 3).forEach(e => console.log('      empty layers between z ' + e.from.toFixed(2) + ' and ' + e.to.toFixed(2)));
  });
}

(async () => {
  const ref = GL.measureAll(await readSliced(REF));
  table('REFERENCE  ' + path.relative(process.cwd(), REF), ref);
  const runs = [];
  if (files.length) for (const f of files) runs.push([path.basename(f), GL.measureAll(await readSliced(f))]);
  else {
    const mv = await buildAndSlice({ rule: arg('--rule'), angle: arg('--angle') });
    if (arg('--dump')) fs.writeFileSync(arg('--dump'), JSON.stringify(mv.map(m => [m.head, m.role, m.feat, m.z, m.h, +m.x0.toFixed(3), +m.y0.toFixed(3), +m.x1.toFixed(3), +m.y1.toFixed(3)])));
    runs.push(['NSO build + NSO_Slicer' + (arg('--rule') ? ' (rule ' + arg('--rule') + ')' : ''), GL.measureAll(mv)]);
  }
  let fails = 0; const json = { ref, runs: {} };
  for (const [name, M] of runs) {
    /* the heads are named as the reference names them ('Support Base'); a build names them the same */
    table(name, M);
    const rows = GL.gate(M, ref);
    const bad = rows.filter(r => !r.ok);
    fails += bad.length;
    const fmt = (r, v) => v == null ? '-' : r.pct ? pct(v).trim() : (+v).toFixed(2).replace(/\.00$/, '');
    console.log('  gate: ' + (rows.length - bad.length) + ' of ' + rows.length + ' pass');
    bad.forEach(r => console.log('    FAIL  ' + r.head.padEnd(25) + r.check.padEnd(18) + 'ours ' + fmt(r, r.ours).padStart(6) + '  ref ' + fmt(r, r.ref).padStart(6) + '   (' + r.rule + ')'));
    json.runs[name] = { measures: M, gate: rows };
  }
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(json, null, 1));
  console.log('\n' + (fails ? fails + ' check(s) failed' : 'all checks pass'));
  process.exit(fails && !REPORT ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
