#!/usr/bin/env node
/* tools/nso_support_exact_gap_check.js - EXACT TOP GAP (npm run support:exact-gap; docs/FILAMENTS.md "A printer and a filament")
   The CR-TPU ladder's shelves (models/tpu-support-ladder: a 14 mm flat overhang at 10 mm) with supports built by the card, each its own gap,
   sliced for the A1 mini: with supExactGap each support's top stands its gap to the dot under the shelf (its own layers end there, interface
   on top); without it every gap from 0.21 to 0.40 rounds up to the part's 0.4. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const lib = require('./nso_support_plate_lib.js'), PRINT = require(path.join(ROOT, 'app-print.js')), L = require('./print-planner/lib.js');
require(path.join(ROOT, 'nso_paint.js')); require(path.join(ROOT, 'nso_paint_segment.js')); const SL = require(path.join(ROOT, 'nso_slicer.js')); require(path.join(ROOT, 'nso-print-planner.js'));
let fails = 0; const check = (name, ok, info) => { console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok || !info ? '' : '\n        ' + info)); if (!ok) fails++; };
function readStl(f) { const b = fs.readFileSync(f), n = b.readUInt32LE(80), p = new Float32Array(n * 9); for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) p[i * 9 + k] = b.readFloatLE(84 + i * 50 + 12 + k * 4); return p; }
async function ladder(gaps, exact, sopts, extra) {
  const objs = gaps.map((g, i) => ({ id: i + 1, name: 'shelf ' + g, positions: readStl(path.join(ROOT, 'models', 'tpu-support-ladder', 'shelf_' + g + '.stl')), triangleCount: 0 }));
  objs.forEach(o => { o.triangleCount = o.positions.length / 9; });
  const app = lib.makeApp(); app.ctx.nsoSupportInterfaceRule = () => 'column'; app.ctx.NSO_Slicer = SL;
  const ids = app.load(objs); app.openCard(); app.setPlateBox(true); app.card.angle(45);
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  const pieces = [];
  objs.forEach((o, i) => { pieces.push({ name: o.name, soup: Float32Array.from(app.soupOf(ids[i])), sourceId: ids[i] });
    app.supportsOf(ids[i]).forEach((m, k) => pieces.push({ name: o.name + ' support ' + k, soup: Float32Array.from(app.ctx.nsoSupportSliceSoup ? app.ctx.nsoSupportSliceSoup(m, app.soupOf(m.id)) : app.soupOf(m.id)),
      sourceId: m.id, support: true, brim: !!m.nsoSupport.brim, hostSourceId: ids[i], interfaceLayers: m.nsoSupport.interfaceLayers, sheetLayerMm: m.nsoSupport.sheetLayerMm, supportGapMm: m.nsoSupport.brim ? undefined : +gaps[i], supportOptions: m.nsoSupport.brim || !sopts ? undefined : sopts[i] })); });
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; pieces.forEach(p => { for (let i = 0; i < p.soup.length; i += 3) { x0 = Math.min(x0, p.soup[i]); x1 = Math.max(x1, p.soup[i]); y0 = Math.min(y0, p.soup[i + 1]); y1 = Math.max(y1, p.soup[i + 1]); } });
  pieces.forEach(p => { for (let i = 0; i < p.soup.length; i += 3) { p.soup[i] -= (x0 + x1) / 2; p.soup[i + 1] -= (y0 + y1) / 2; } });
  const tpl = PRINT.nsoBaseline(await L.a1Template()), pr = L.printer('a1mini-0.4');
  const st = Object.assign(PRINT.settingsFromConfig(tpl), { filament: 'cr-tpu', angle: 45, interfaceRule: 'column', supExactGap: exact }, extra || {});
  const r = await PRINT.build(PRINT.pieceObjects(pieces, pr.bed), { config: tpl, printer: pr }, { settings: st });
  if (!r.ok) return { r };
  const g = L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode')).split('\n');
  /* each shelf's support top, by where it stands on the plate (the shelves left to right in the order given), and the feature there */
  let z = 0, feat = '', x = 0; const tops = [];
  g.forEach(l => { let m; if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(l))) z = +m[1]; else if ((m = /^; FEATURE: (.*)$/.exec(l))) feat = m[1];
    else if ((m = /^G1 X([\d.]+) Y[\d.]+ E/.exec(l))) { x = +m[1]; if (z > 3 && /^Support/.test(feat)) tops.push({ x, z, feat }); } });
  const xs = tops.map(t => t.x), lo = Math.min(...xs), hi = Math.max(...xs), w = (hi - lo) / gaps.length;
  /* the top interface layer's length per shelf, and the interface waits */
  const len = gaps.map(() => 0); let lz = 0, lf = '', lx = 0, ly = 0;
  const zTop = Math.max(...tops.map(t => t.z));
  g.forEach(l => { let m; if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(l))) lz = +m[1]; else if ((m = /^; FEATURE: (.*)$/.exec(l))) lf = m[1];
    else if ((m = /^G1 X([\d.]+) Y([\d.]+)( E)?/.exec(l))) { const nx = +m[1], ny = +m[2];
      if (m[3] && lf === 'Support interface' && Math.abs(lz - zTop) < 1e-6) { const i = Math.min(gaps.length - 1, Math.floor((nx - lo) / w)); if (i >= 0) len[i] += Math.hypot(nx - lx, ny - ly); }
      lx = nx; ly = ny; } });
  const waits = g.filter(l => /^; NSO interface wait/.test(l));
  return { r, len, waits, gap: gaps.map((gp, i) => { const mine = tops.filter(t => t.x >= lo + i * w - 1e-6 && t.x <= lo + (i + 1) * w + 1e-6); const zt = Math.max(...mine.map(t => t.z));
    return { want: +gp, got: +(10 - zt).toFixed(3), feat: [...new Set(mine.filter(t => Math.abs(t.z - zt) < 1e-6).map(t => t.feat))] }; }) };
}
(async () => {
  const gaps = ['0.33', '0.37', '0.39', '0.4'];
  const ex = await ladder(gaps, true), rd = await ladder(gaps, false);
  check('the ladder slices with and without the exact gap', ex.r.ok && rd.r.ok, ex.r.reason || rd.r.reason);
  if (ex.r.ok && rd.r.ok) {
    check('Exact top gap: each shelf\'s support top stands its own gap to the dot under it - 0.33, 0.37, 0.39, 0.4 (' + JSON.stringify(ex.gap.map(q => q.got)) + ')',
      ex.gap.every(q => Math.abs(q.got - q.want) < 0.002));
    check('...and its top layer is interface', ex.gap.every(q => q.feat.length === 1 && q.feat[0] === 'Support interface'), JSON.stringify(ex.gap));
    check('Off: every one of them rounds up to the part\'s 0.4 (' + JSON.stringify(rd.gap.map(q => q.got)) + ')', rd.gap.every(q => Math.abs(q.got - 0.4) < 0.002));
  }
  /* PER-SUPPORT INTERFACE AND THE INTERFACE WAIT: the second shelf's interface closed (supportInterfaceSpacingMm 0), a 15 s wait before the part */
  const iv = await ladder(['0.37', '0.37'], true, [{}, { supportInterfaceSpacingMm: 0 }], { ifaceWait: 15 });
  check('a support\'s own interface: closed (spacing 0) lays ' + (iv.len ? (iv.len[1] / iv.len[0]).toFixed(2) : '-') + ' x the line of the default\'s top layer under the same shelf',
    iv.r.ok && iv.len[1] > 1.6 * iv.len[0], JSON.stringify(iv.len));
  check('Interface wait 15: one wait, before the shelves\' first layer over the supports (z 10), 15 s off the part',
    iv.r.ok && iv.waits.length === 1 && / at 10 mm$/.test(iv.waits[0]) && iv.r.stats.interfaceWait && iv.r.stats.interfaceWait.seconds === 15, JSON.stringify(iv.waits));
  console.log(fails ? '\nFAILED ' + fails : '\nall checks pass');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
