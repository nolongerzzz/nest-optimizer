#!/usr/bin/env node
/* ============================================================
   tools/nso_supports_print_export.js - the top_clip_x2 coupon with its
   supports, built the way the Supports card builds them, as a 3MF to slice.

     node tools/nso_supports_print_export.js        (npm run support:print-export)

   The card's pipeline at its defaults (angle 60, Tree, 1.2 mm, rest off):
   NSO_SupportAim.detectOverhangs, planTree per area, NSO_SupportGridpack.parts
   with the card's PARTS_OPTS (the sheet on its caps; every trunk on its foot,
   no pad), shells, then shareFeet over every area - the pads, and the supports
   that stand on one pad joined into one. Named as the card names them.

   Writes, to tools/supports-print-out/ (git-ignored):
     top_clip_x2_supports.3mf   the export as the card makes it: the sheet's
                                lines 0.40 mm (0.95 of a bead), and on every
                                support object, as the card sets them
                                (NSO_SupportInterface.SHEET.slicerSettings),
                                wall_generator = classic and detect_thin_wall
                                = 1 in Metadata/model_settings.config - the
                                thin-wall pass prints each line once (the
                                width matrix settled it: 0.40 printed in one
                                pass on the owner's A1 mini). Open it in
                                Bambu Studio as a PROJECT: imported as
                                geometry only, Bambu drops object settings.

   Slice any in Bambu Studio, save the .gcode.3mf, and read the sheet with
     node tools/nso_slicer_audit.js --sheet sliced.gcode.3mf --export tools/supports-print-out/top_clip_x2_supports.3mf

   API (require): build(piece, partsOver, name) -> { areas, sf, ms, objects } - the
   same build, PARTS_OPTS overridden by partsOver (e.g. { sheetWidthMm: 0.43 });
   slicer:bambu slices it.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'supports-print-out');
const { readSTL } = require('./nso_stl_io.js');
const NSO3MF = require(path.join(ROOT, 'nso-3mf.js'));

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date, WeakMap,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
/* the card's build worker's own list (app-supports-card.js ENGINE) */
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree, GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface;
const CARD = { skipList: [], angleDeg: 35, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };
/* app-supports-card.js PARTS_OPTS */
const PARTS = { interface: true, foldSheets: false, footPads: 'shared' };
const NAME = 'top_clip_x2';

/* the build at the card's defaults, its objects named as the card names them */
async function build(piece, partsOver, name, one, brim, outline) {
  const pname = name || NAME;
  const t0 = Date.now();
  /* outline: the card's own (docs/SUPPORT-FOOTPRINT.md) - the spots kept in from the edge of the surface, the sheet and its caps kept to the part */
  const det = SA.detectOverhangs(piece, { skipList: [], angleDeg: CARD.angleDeg, occluders: [], beaconInsetMm: outline && outline !== 'perimeter' ? ctx.NSO_SupportBeacons.INSET_PRODUCT_MM : 0 });
  if (!det.ok) throw new Error(det.reason);
  const areas = [];
  let plateZ = 0;
  /* one: the card's Auto with ONE TRUNK (opts.oneTrunk): the areas the planner says one trunk can feed are planned in one
     call, as the card plans them (NSO_SupportGridpack.oneTrunkGroups) */
  const groups = one ? GP.oneTrunkGroups(det.beaconRegions.map(r => ({ id: r.id, pts: r.beacons }))).map(g => g.map(i => det.beaconRegions[i]))
    : det.beaconRegions.map(r => [r]);
  for (const grp of groups) {
    const rg = grp[0];
    const bs = [].concat(...grp.map(g => g.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: g.id, key: 'k' }))));
    const p = ST.planTree(piece, Object.assign({}, CARD, { beacons: bs }, one ? { oneTrunk: true } : {}));
    if (!p.ok) { console.log(`area ${rg.id + 1}: ${p.reason}`); continue; }
    plateZ = p.plateZ;
    const tp = await GP.parts(p, Object.assign({}, PARTS, one ? { sheetPitchMm: SI.SHEET.densePitchMm, interfaceLayers: SI.SHEET.denseInterfaceLayers, sheetFlatGapMm: SI.SHEET.denseFlatGapMaxMm } : {}, outline && outline !== 'inset' ? { sheetPerimeter: true } : {}, partsOver || {}));
    if (!tp.ok) throw new Error(`area ${rg.id + 1}: ${tp.reason}`);
    areas.push({ rid: rg.id, p, tp, sh: GP.shells(p, tp) });
  }
  const sf = GP.shareFeet(areas.map(a => ({ solids: a.sh.solids })), piece, { plateZ });
  if (!sf.ok) throw new Error(sf.reason);
  const ms = Date.now() - t0;
  /* the card's names: "<piece> - support <area>.<n> (Tree)", n counting on over the build */
  let n = 0;
  const objects = [{ name: pname, soup: piece }];
  areas.forEach((a, ai) => sf.objects.filter(o => o.from[0][0] === ai).forEach(o => {
    objects.push({ name: `${pname} - support ${a.rid + 1}.${++n} (Tree)`, soup: o.soup, settings: Object.assign({}, SI.SHEET.slicerSettings) });
  }));
  /* the card's brim (app-supports-card.js brimStep): one first layer round the foot of a part tall for it, off every pad */
  let brimInfo = null;
  if (brim) {
    const SL = require('../nso_slicer.js'), wasm = await SL.loadKernel({});
    brimInfo = SL.brimFor(piece, { brimType: 'auto' }, wasm, objects.slice(1).map(o => o.soup), plateZ);
    if (brimInfo.ok && brimInfo.needed && brimInfo.soup.length)
      objects.push({ name: `${pname} - brim`, soup: brimInfo.soup, brim: true, settings: { wall_generator: 'classic', detect_thin_wall: '0', wall_loops: '10', sparse_infill_density: '0%', top_shell_layers: '0', bottom_shell_layers: '1' } });
  }
  return { areas, sf, ms, objects, brim: brimInfo };
}
/* the 3MF's bytes: each object with its own settings, as the card's export writes them */
async function write(file, objects) {
  const indexed = objects.map(o => { const m = NSO3MF.indexTriangleSoup(Array.from(o.soup)); return { name: o.name, vertices: m.vertices, triangles: m.triangles, settings: o.settings }; });
  const built = await NSO3MF.build3MF({ objects: indexed, plateName: 'Bambu A1 Mini' });
  fs.writeFileSync(file, Buffer.from(built.bytes));
}

module.exports = { build, write, NAME };
if (require.main === module) (async () => {
  const piece = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
  fs.mkdirSync(OUT, { recursive: true });
  const b = await build(piece);
  const S0 = b.areas[0] && b.areas[0].tp.sheet;
  console.log(`${NAME}, sheet lines ${S0 ? S0.widthMm : '-'} mm: built in ${b.ms} ms - ${b.sf.reason}`);
  b.areas.forEach(a => {
    const S = a.tp.sheet;
    console.log(`  area ${a.rid + 1}: ${a.p.reason} ${S ? S.reason : ''}`);
    (S ? S.levels : []).forEach(L => {
      const ws = L.caps.map(c => c.w);
      console.log(`    sheet at ${L.zTop.toFixed(3)} (z_cap ${L.zCap.toFixed(3)}): ${L.caps.length} caps ${Math.min(...ws).toFixed(2)} - ${Math.max(...ws).toFixed(2)} mm; ` +
        `loop ${L.layers[0].loopMm.map(v => v.toFixed(2)).join(' x ')} mm, ` +
        L.layers.map(x => `${x.role[0].toUpperCase()} ${x.lines} lines of ${x.shortestMm.toFixed(2)} mm at ${x.angleDeg.toFixed(1)} deg`).join(', '));
    });
  });
  const file = path.join(OUT, NAME + '_supports.3mf');
  await write(file, b.objects);
  console.log('  wrote ' + path.relative(ROOT, file) + '   (on every support: ' +
    Object.keys(SI.SHEET.slicerSettings).map(k => k + ' = ' + SI.SHEET.slicerSettings[k]).join(', ') + ')');
})().catch(err => { console.error(err); process.exit(1); });
