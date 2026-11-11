#!/usr/bin/env node
/* ============================================================
   tools/nso_support_gate.js - THE PRINTABILITY GATE (npm run support:gate, docs/SUPPORT-GATE.md)

   Does the interface print and break away the way Bambu's does? Measured on G-code, every head of supp_ref at once,
   each against Bambu's own slice of the same head (fixtures/supports/supp_ref_v2.gcode.3mf, Studio 02.09), so a change that
   mends one head and breaks another fails here.

     node tools/nso_support_gate.js                          build supp_ref with the card (Auto, Dense, 30 deg), slice it with
                                                             NSO_Slicer, gate it
     node tools/nso_support_gate.js --gcode a.gcode.3mf ...  gate sliced files instead (NSO's export, or Bambu Studio's slice of
                                                             NSO's support meshes); several are gated one after another
     --ref f.gcode.3mf     another reference         --json out.json     every number
     --rule sheet          slice with the sheet typing (the app's default is the column rule, NSO_Slicer supportInterfaceRule:
                           'column', and so is the gate's; --rule column says so)
     --merged              (a build) the six heads as one piece, as a plate imported whole has them
     --report              print, never fail
     --worst               the five layers per head that differ most from Bambu's
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
/* the reference: the owner's slice of supp_ref on Bambu Studio 02.09.01.70 (the Negative Sphere's side wall no longer holed); --ref
   fixtures/supports/tree_slimsupports.gcode.3mf for the 02.08 one the gate was built on */
const REF = arg('--ref') || path.join(ROOT, 'fixtures', 'supports', 'supp_ref_v2.gcode.3mf');
const REPORT = argv.includes('--report');

async function readSliced(file) {
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(file)));
  const dec = new TextDecoder();
  const gname = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
  const info = zip.names().includes('Metadata/slice_info.config') ? dec.decode(await zip.read('Metadata/slice_info.config')) : '';
  return GL.movesFromGcode(dec.decode(await zip.read(gname)), info);
}

/* the in-node build: the card's own build of supp_ref (tools/nso_support_score.js's harness), sliced piece by piece */
let CARD_HEAD = null;
async function buildAndSlice(opts) {
  const lib = require('./nso_support_plate_lib.js');
  const SL = require(path.join(ROOT, 'nso_slicer.js'));
  let objs = await lib.readFixture(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  /* --merged: the six heads as ONE piece, as the owner's plate has them ('supp_ref - 6 objects') */
  if (opts.merged) {
    let n = 0; objs.forEach(o => { n += o.positions.length; });
    const pos = new Float32Array(n); let k = 0; objs.forEach(o => { pos.set(o.positions, k); k += o.positions.length; });
    objs = [{ id: objs[0].id, name: 'supp_ref - 6 objects', positions: pos, triangleCount: n / 9 }];
  }
  const app = lib.makeApp();
  if (opts.rule) app.ctx.nsoSupportInterfaceRule = () => opts.rule;      /* the card builds for the slicer's rule (no sheet of its own under the column rule) */
  if (opts.rule === 'column') app.ctx.NSO_Slicer = SL;                    /* ...and draws the rule's stack on its supports, as the page does (the brim stays off) */
  const ids = app.load(objs); app.openCard(); app.setPlateBox(true);
  app.card.angle(+(opts.angle || 30));
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  CARD_HEAD = app.head();
  const WASM = await SL.loadKernel({});
  const moves = [];
  for (let i = 0; i < objs.length; i++) {
    const head = objs[i].name.replace(/\.stl$/i, '');
    /* what the page slices: a support the card drew as it prints is sliced as the tree it was built as (nsoSupportSliceSoup) */
    const sups = app.supportsOf(ids[i]).map(m => ({ soup: Array.from(app.ctx.nsoSupportSliceSoup ? app.ctx.nsoSupportSliceSoup(m, app.soupOf(m.id)) : app.soupOf(m.id)), brim: !!m.nsoSupport.brim }));
    const objl = [{ name: 'part', soup: Float32Array.from(app.soupOf(ids[i])), key: 101, role: 'part' }]
      .concat(sups.map((s, k) => ({ name: 's' + k, soup: Float32Array.from(s.soup), key: 201 + k, role: s.brim ? 'brim' : 'support', hostKey: 101 })));
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
  console.log('  head                       touch  thin  contact | gap: one   two  | floating empty | carried depth specks | over air');
  Object.keys(M).sort().forEach(h => {
    const r = M[h];
    console.log('  ' + h.padEnd(25) + r.touchMm2.toFixed(1).padStart(6) + r.thinMm2.toFixed(1).padStart(6) + r.contactMm2.toFixed(0).padStart(8) + '  | ' +
      pct(r.share.one) + ' ' + pct(r.share.two) + ' | ' + String(r.floating.length).padStart(6) + String(r.empty.length).padStart(7) + '  | ' +
      pct(r.carried) + '  ' + pct(r.depth) + '  ' + (r.specks == null ? '  -' : String(r.specks).padStart(4)) + ' | ' + (r.airMm2 != null ? r.airMm2.toFixed(1).padStart(6) : '   -'));
    if (argv.includes('--worst')) (r.airAt || []).slice(0, 3).forEach(t => console.log('      tree over air z ' + t.z.toFixed(2) + '  ' + t.areaMm2 + ' mm2 about X ' + t.x + ' Y ' + t.y));
    r.touchAt.slice(0, 3).forEach(t => console.log('      touching z ' + t.z.toFixed(2) + ' under the part layer ' + t.partZ.toFixed(2) + '  ' + t.areaMm2 + ' mm2 about X ' + t.x + ' Y ' + t.y));
    if (r.spanP95 != null) console.log('      span under the sheet: p95 ' + r.spanP95.toFixed(1) + ' mm, longest ' + r.spanMax.toFixed(1) + ' mm, ' + r.overSpanMm2 + ' mm2 further than 2.5 mm');
    (r.spanAt || []).forEach(t => console.log('      span over 2.5 mm z ' + t.z.toFixed(2) + '  ' + t.areaMm2 + ' mm2 about X ' + t.x + ' Y ' + t.y));
    r.floating.slice(0, 3).forEach(f => console.log('      floating island z ' + f.z.toFixed(2) + '  ' + f.areaMm2 + ' mm2 at X ' + f.x + ' Y ' + f.y));
    if (argv.includes('--worst') && r.depthSeqs) console.log('      columns top down (I interface, T transition, S support): ' + r.depthSeqs.join(', '));
    r.empty.slice(0, 3).forEach(e => console.log('      empty layers between z ' + e.from.toFixed(2) + ' and ' + e.to.toFixed(2)));
  });
}

/* a slice whose objects are not named as the reference's heads (the six imported as one piece, 'supp_ref - 6 objects'): each move goes to the
   head whose part it lies over on the plate, the reference's footprints grown 2 mm; a plate laid out elsewhere is moved onto the reference by the
   centres of the two plates' parts first */
function reHead(moves, refMoves) {
  const box = {};
  refMoves.forEach(m => { if (m.role !== 'part') return; const b = box[m.head] || (box[m.head] = [Infinity, Infinity, -Infinity, -Infinity]); b[0] = Math.min(b[0], m.x0, m.x1); b[1] = Math.min(b[1], m.y0, m.y1); b[2] = Math.max(b[2], m.x0, m.x1); b[3] = Math.max(b[3], m.y0, m.y1); });
  const names = Object.keys(box);
  if (moves.every(m => names.includes(m.head))) return moves;
  const ctr = (ms) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; ms.forEach(m => { if (m.role !== 'part') return; x0 = Math.min(x0, m.x0); y0 = Math.min(y0, m.y0); x1 = Math.max(x1, m.x0); y1 = Math.max(y1, m.y0); }); return [(x0 + x1) / 2, (y0 + y1) / 2]; };
  const a = ctr(refMoves), b = ctr(moves), dx = a[0] - b[0], dy = a[1] - b[1];
  const out = [];
  for (const m of moves) {
    const mx = (m.x0 + m.x1) / 2 + dx, my = (m.y0 + m.y1) / 2 + dy;
    let best = null, bd = Infinity;
    for (const h of names) {
      const q = box[h];
      if (mx < q[0] - 2 || mx > q[2] + 2 || my < q[1] - 2 || my > q[3] + 2) continue;
      const d = Math.hypot(mx - (q[0] + q[2]) / 2, my - (q[1] + q[3]) / 2);
      if (d < bd) { bd = d; best = h; }
    }
    if (!best) continue;
    const n = Object.assign({}, m, { head: best, x0: m.x0 + dx, x1: m.x1 + dx, y0: m.y0 + dy, y1: m.y1 + dy });
    if (m.pts) n.pts = m.pts.map(p => [p[0] + dx, p[1] + dy]);
    out.push(n);
  }
  return out;
}

(async () => {
  const refMoves = await readSliced(REF);
  const ref = GL.measureAll(refMoves);
  table('REFERENCE  ' + path.relative(process.cwd(), REF), ref);
  const runs = [];
  if (files.length) for (const f of files) { const mv = reHead(await readSliced(f), refMoves); runs.push([path.basename(f), GL.measureAll(mv), mv]); }
  else {
    const rule = arg('--rule') === 'sheet' ? null : 'column';                /* the app's default (the column rule); --rule sheet the sheet typing */
    let mv = await buildAndSlice({ rule: rule, angle: arg('--angle'), merged: argv.includes('--merged') });
    if (argv.includes('--merged')) mv = reHead(mv, refMoves);
    if (arg('--dump')) fs.writeFileSync(arg('--dump'), JSON.stringify(mv.map(m => [m.head, m.role, m.feat, m.z, m.h, +m.x0.toFixed(3), +m.y0.toFixed(3), +m.x1.toFixed(3), +m.y1.toFixed(3)])));
    runs.push(['NSO build + NSO_Slicer (rule ' + (rule || 'sheet') + ')' + (argv.includes('--merged') ? ', the six as one piece' : ''), GL.measureAll(mv), mv]);
  }
  let fails = 0; const json = { ref, runs: {} };
  for (const [name, M, mv] of runs) {
    /* the heads are named as the reference names them ('Support Base'); a build names them the same */
    table(name, M);
    const rows = GL.gate(M, ref);
    const bad = rows.filter(r => !r.ok);
    fails += bad.length;
    const fmt = (r, v) => v == null ? '-' : r.pct ? pct(v).trim() : (+v).toFixed(2).replace(/\.00$/, '');
    console.log('  gate: ' + (rows.length - bad.length) + ' of ' + rows.length + ' pass');
    bad.forEach(r => console.log('    FAIL  ' + r.head.padEnd(25) + r.check.padEnd(18) + 'ours ' + fmt(r, r.ours).padStart(6) + '  ref ' + fmt(r, r.ref).padStart(6) + '   (' + r.rule + ')'));
    /* parity with Bambu's interface and transition (reported; the owner's gate 2: the overlay differences go away) */
    const PA = GL.parityAll(mv, refMoves);
    console.log('  parity with Bambu (interface + transition, layer by layer):   plate IoU   type IoU   layer heights met');
    Object.keys(PA).sort().forEach(h => {
      const p = PA[h];
      console.log('    ' + h.padEnd(25) + pct(p.iou).padStart(32) + pct(p.role).padStart(11) + pct(p.grid).padStart(14));
      if (argv.includes('--worst')) p.worst.forEach(w => console.log('        z ' + w.z.toFixed(3) + (w.oursZ != null ? ' (ours ' + w.oursZ.toFixed(3) + ')' : ' (ours: no layer)') + '  ref ' + w.refMm2 + ' mm2, ours ' + w.oursMm2 + ' mm2, IoU ' + w.iou));
    });
    json.runs[name] = { measures: M, gate: rows, parity: PA };
  }
  /* the owner's first gate: the generator flags nothing as unreachable (the card's own count, a build only) */
  if (CARD_HEAD) {
    const un = /unreachable (\d+)/.exec(CARD_HEAD), nUn = un ? +un[1] : 0;
    console.log('\ncard: ' + CARD_HEAD + (nUn ? '   FAIL  nothing may be unreachable' : '   ok'));
    if (nUn) fails++;
    json.card = CARD_HEAD;
  }
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(json, null, 1));
  console.log('\n' + (fails ? fails + ' check(s) failed' : 'all checks pass'));
  process.exit(fails && !REPORT ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
