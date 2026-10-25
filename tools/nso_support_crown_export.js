#!/usr/bin/env node
/* ============================================================
   tools/nso_support_crown_export.js - simple_overhang with its supports built
   from Custom mode, one circle to a tree (supports-thinning-1), as a 3MF to
   slice: the card's custom pipeline - the arc's detected spots as the user's
   tips, landing circles, GP.plan with opts.feed, parts with the card's
   PARTS_OPTS, shells, shareFeet - written through the Bambu project envelope
   (nso_supports_print_export.js).

     node tools/nso_support_crown_export.js [x,y,r ...]     default circles: 90,100,5

   Writes tools/supports-crown-out/simple_overhang_custom.3mf (git-ignored):
   open it in Bambu Studio as a PROJECT with its own supports off. Prints each
   tree: its shape, trunk against its circle's centre, over-lean members.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'supports-crown-out');
const EXP = require('./nso_supports_print_export.js');
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date, WeakMap, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer };
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js', 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface;
const CARD = { skipList: [], angleDeg: 35, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };
const PARTS = { interface: true, foldSheets: false, footPads: 'shared' };

(async () => {
  const circles = process.argv.slice(2).map(a => { const v = a.split(',').map(Number); return { x: v[0], y: v[1], r: v[2] }; });
  if (!circles.length) circles.push({ x: 90, y: 100, r: 5 });
  const arc = new Float32Array((await R3.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf'))), { name: 'simple_overhang.3mf' })).objects[0].positions);
  const g = GP.gridBeacons(arc, CARD);
  /* the 40 spots on the curve (the two at the arc's foot sit on its base slab, with no free plate under them: place a circle for them by hand) */
  const tips = g.beacons.filter(b => b.p[2] > 30).map(b => ({ x: b.p[0], y: b.p[1], z: b.p[2] }));
  const p = GP.plan(arc, Object.assign({}, CARD, { feed: { mode: 'custom', tips, landingZones: circles } }));
  if (!p.ok) throw new Error(p.reason);
  const tp = await GP.parts(p, PARTS);
  if (!tp.ok) throw new Error(tp.reason);
  const sh = GP.shells(p, tp), sf = GP.shareFeet([{ solids: sh.solids }], arc, { plateZ: p.plateZ });
  if (!sf.ok) throw new Error(sf.reason);
  console.log(`${tips.length} tips, ${circles.length} circle(s): ${p.reason}`);
  p.crowns.forEach(c => console.log(`  circle ${c.zone + 1} (${circles[c.zone].x}, ${circles[c.zone].y}, r ${circles[c.zone].r}): ${c.tips} tips ${c.shape}, trunk at ${c.axis.map(v => v.toFixed(2)).join(', ')} (${c.offCentreMm.toFixed(2)} mm off the centre), top z ${c.zTop.toFixed(1)}, oval ${c.oval.k.toFixed(2)} : 1${c.tight ? ', NO ROOM (narrowed)' : ''}`));
  console.log(`  over lean ${p.overLean.length}, suggested spots ${p.suggested.length}, blocked by the part ${p.blocked.length}; the stair holds ${tp.sheet.counts.drop} tips; ${sh.members.filter(m => m.kind === 'trunk').length} trunk(s) built`);
  p.suggested.forEach(s => console.log(`    suggested (${s.x.toFixed(1)}, ${s.y.toFixed(1)}) for ${s.forMember}, ${s.leanDeg.toFixed(1)} deg`));
  fs.mkdirSync(OUT, { recursive: true });
  const objects = [{ name: 'simple_overhang', soup: arc }];
  sf.objects.forEach((o, i) => objects.push({ name: `simple_overhang - support 1.${i + 1} (Tree)`, soup: o.soup, settings: Object.assign({}, SI.SHEET.slicerSettings) }));
  const file = path.join(OUT, 'simple_overhang_custom.3mf');
  await EXP.write(file, objects);
  console.log('  wrote ' + path.relative(ROOT, file) + ' (' + (objects.length - 1) + ' support object(s); open it in Bambu Studio as a PROJECT, its own supports off)');
})().catch(err => { console.error(err); process.exit(1); });
