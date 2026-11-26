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
async function ladder(gaps, exact) {
  const objs = gaps.map((g, i) => ({ id: i + 1, name: 'shelf ' + g, positions: readStl(path.join(ROOT, 'models', 'tpu-support-ladder', 'shelf_' + g + '.stl')), triangleCount: 0 }));
  objs.forEach(o => { o.triangleCount = o.positions.length / 9; });
  const app = lib.makeApp(); app.ctx.nsoSupportInterfaceRule = () => 'column'; app.ctx.NSO_Slicer = SL;
  const ids = app.load(objs); app.openCard(); app.setPlateBox(true); app.card.angle(45);
  app.click('btn-sup-all'); await app.until(() => app.card.busy()); await app.until(() => !app.card.busy());
  const pieces = [];
  objs.forEach((o, i) => { pieces.push({ name: o.name, soup: Float32Array.from(app.soupOf(ids[i])), sourceId: ids[i] });
    app.supportsOf(ids[i]).forEach((m, k) => pieces.push({ name: o.name + ' support ' + k, soup: Float32Array.from(app.ctx.nsoSupportSliceSoup ? app.ctx.nsoSupportSliceSoup(m, app.soupOf(m.id)) : app.soupOf(m.id)),
      sourceId: m.id, support: true, brim: !!m.nsoSupport.brim, hostSourceId: ids[i], interfaceLayers: m.nsoSupport.interfaceLayers, sheetLayerMm: m.nsoSupport.sheetLayerMm, supportGapMm: m.nsoSupport.brim ? undefined : +gaps[i] })); });
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; pieces.forEach(p => { for (let i = 0; i < p.soup.length; i += 3) { x0 = Math.min(x0, p.soup[i]); x1 = Math.max(x1, p.soup[i]); y0 = Math.min(y0, p.soup[i + 1]); y1 = Math.max(y1, p.soup[i + 1]); } });
  pieces.forEach(p => { for (let i = 0; i < p.soup.length; i += 3) { p.soup[i] -= (x0 + x1) / 2; p.soup[i + 1] -= (y0 + y1) / 2; } });
  const tpl = PRINT.nsoBaseline(await L.a1Template()), pr = L.printer('a1mini-0.4');
  const st = Object.assign(PRINT.settingsFromConfig(tpl), { filament: 'cr-tpu', angle: 45, interfaceRule: 'column', supExactGap: exact });
  const r = await PRINT.build(PRINT.pieceObjects(pieces, pr.bed), { config: tpl, printer: pr }, { settings: st });
  if (!r.ok) return { r };
  const g = L.text(await L.R.openZip(r.bytes).read('Metadata/plate_1.gcode')).split('\n');
  /* each shelf's support top, by where it stands on the plate (the shelves left to right in the order given), and the feature there */
  let z = 0, feat = '', x = 0; const tops = [];
  g.forEach(l => { let m; if ((m = /^; Z_HEIGHT: ([\d.]+)/.exec(l))) z = +m[1]; else if ((m = /^; FEATURE: (.*)$/.exec(l))) feat = m[1];
    else if ((m = /^G1 X([\d.]+) Y[\d.]+ E/.exec(l))) { x = +m[1]; if (z > 3 && /^Support/.test(feat)) tops.push({ x, z, feat }); } });
  const xs = tops.map(t => t.x), lo = Math.min(...xs), hi = Math.max(...xs), w = (hi - lo) / gaps.length;
  return { r, gap: gaps.map((gp, i) => { const mine = tops.filter(t => t.x >= lo + i * w - 1e-6 && t.x <= lo + (i + 1) * w + 1e-6); const zt = Math.max(...mine.map(t => t.z));
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
  console.log(fails ? '\nFAILED ' + fails : '\nall checks pass');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
