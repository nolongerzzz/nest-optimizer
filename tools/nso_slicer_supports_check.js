#!/usr/bin/env node
/*
 * SUPPORTS SLICE AS SUPPORT (npm run slicer:supports).
 *
 * Bambu's slice of an NSO export prints NSO's supports as its own support
 * line types; NSO's own slicer used to slice them as ordinary models (Outer
 * wall, Inner wall, Sparse infill) and still report the host as needing
 * support right over the sheet that holds it. This holds the fix on the clip
 * coupon - fixtures/supports/top_clip_x2.stl, a 10 x 10 x 16 post with two
 * 8 x 8 clips under its top, one each side (the user's top_clip_x2 case: one
 * ceiling per clip) - with the supports the Supports card builds for it at
 * its defaults (angle 60, Tree, 1.2 mm, rest off, the sheet on: the same
 * pipeline support:shells drives, NSO_SupportGridpack.parts then .shells).
 * Sliced at the card's own 0.4 mm nozzle / 0.2 mm layers.
 *
 *   1. Every line of a support object is Support, Support transition or
 *      Support interface - read off the G-code by OBJECT_ID - and the counts
 *      are exact: interface is every move of the object's top 2 layers,
 *      transition every move of the 2 below, and nothing else is either.
 *   2. The slice's features hold the three rows, each with a count, and
 *      G-scope colours every one of them.
 *   3. The host is credited: each clip's overhang is covered by the support
 *      under it and by no other, its uncovered area is 0 where the sheet is
 *      under it, and the readout (NSO_GSCOPE_SLICE.report, the words
 *      #ms-slice-read shows) names the covering support - with what is left
 *      uncovered, or as "held by support" when nothing is. The support objects'
 *      own lines say "support for <host>: N tips, sheet at z ...", never
 *      "needs support".
 *   4. The words for a fully covered host: "no support needed (2 supports
 *      cover ...)".
 *   5. A part with no supports slices byte-identically: roles passed or not,
 *      the same G-code; and the host's own lines in the slice with supports
 *      are its lines alone.
 *
 *   node tools/nso_slicer_supports_check.js           the check
 *   node tools/nso_slicer_supports_check.js --make    (re)write the fixture STL
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const SL = require('../nso_slicer.js');
const G = require('../nso-gcode-lines.js');

const FIXTURE = path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2.stl');
const HOST = 'top_clip_x2';
const SUPPORT_TYPES = ['Support', 'Support transition', 'Support interface'];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}

if (process.argv.includes('--make')) {
  /* the post and its two clips: overlapping boxes, one file, as a plate piece cut from one export is */
  const soup = [].concat(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16]), box([-8, 1, 12], [0, 9, 16]));
  writeSTL(FIXTURE, new Float32Array(soup), 'NSO top_clip_x2 coupon: post + two clips, ceilings at z 12');
  console.log('wrote ' + path.relative(ROOT, FIXTURE) + ' (' + soup.length / 9 + ' triangles)');
  process.exit(0);
}

/* the card's build worker's own list (app-supports-card.js ENGINE), as support:shells loads it */
const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree, GP = ctx.NSO_SupportGridpack;
const CARD = { skipList: [], angleDeg: 60, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };
const PARTS = { interface: true, foldSheets: false };

/* the readout's own words: app-gscope-slice.js with no page (it mounts only where there is a document) */
const sliceCtx = { window: {}, console, Math, Object, Array, String, Number, JSON, Promise, setTimeout };
vm.createContext(sliceCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-gscope-slice.js'), 'utf8'), sliceCtx, { filename: 'app-gscope-slice.js' });
const READOUT = sliceCtx.window.NSO_GSCOPE_SLICE;

/* every extrusion move per object, per layer, per feature - off the G-code text, through the importer */
function movesByObject(gcode) {
  const p = G.parseGcode(gcode);
  const out = {};
  for (const m of p.moves) {
    const o = out[m.objectId] || (out[m.objectId] = {});
    const l = o[m.layer] || (o[m.layer] = {});
    l[m.feature] = (l[m.feature] || 0) + 1;
  }
  return { parsed: p, by: out };
}

(async () => {
  const piece = readSTL(FIXTURE);
  const csg = csgContext();
  ctx.NSO_unionSoups = csg.NSO_unionSoups;
  const wasm = await SL.loadKernel({});

  /* the card's build, area by area */
  const det = SA.detectOverhangs(piece, { skipList: [], angleDeg: CARD.angleDeg, occluders: [] });
  const sups = [];
  for (const rg of (det.beaconRegions || [])) {
    const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'k' }));
    const p = ST.planTree(piece, Object.assign({}, CARD, { beacons: bs }));
    if (!p.ok) continue;
    const tp = await GP.parts(p, PARTS);
    if (!tp.ok) continue;
    const sh = GP.shells(p, tp);
    if (!sh.ok) continue;
    let n = 0;
    for (const s of sh.solids) sups.push({ name: HOST + ' - support ' + (rg.id + 1) + '.' + (++n) + ' (Tree)', soup: s.soup, region: rg.id });
  }
  check('the card builds the coupon its two supports, one under each clip', det.ok && sups.length === 2 && sups[0].region !== sups[1].region,
    sups.map(s => s.name + ' (' + s.soup.length / 9 + ' tris)').join(', '));
  if (sups.length !== 2) { console.log('\nFAILED  ' + pass + ' of ' + (pass + fail)); process.exit(1); }

  const o = SL.defaultsFor(0.4);
  const HOST_KEY = 101;
  const objects = [{ name: HOST, soup: piece, key: HOST_KEY, role: 'part' }]
    .concat(sups.map((s, i) => ({ name: s.name, soup: s.soup, key: 201 + i, role: 'support', hostKey: HOST_KEY })));
  const t0 = Date.now();
  const r = SL.sliceObjects(objects, o, wasm);
  check('the coupon slices: part + 2 supports, no conflict', r.ok && r.objects.length === 3 && !r.conflicts.length,
    r.ok ? r.planes.length + ' layers, ' + (Date.now() - t0) + ' ms' : r.reason);
  const { parsed, by } = movesByObject(r.gcode);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. a support object prints as support ===');
  for (const ob of r.objects.slice(1)) {
    const L = by[ob.id] || {};
    const layers = Object.keys(L).map(Number).sort((a, b) => a - b);
    const feats = new Set();
    layers.forEach(k => Object.keys(L[k]).forEach(f => feats.add(f)));
    check(ob.name + ': every line is Support, Support transition or Support interface - no wall, infill or overhang wall',
      layers.length > 0 && [...feats].every(f => SUPPORT_TYPES.includes(f)), [...feats].join(', '));
    const top = layers.slice(-4).reverse();     // the top 4 layers with moves, top first
    const sum = (k) => Object.values(L[k] || {}).reduce((a, b) => a + b, 0);
    const iface = layers.reduce((a, k) => a + (L[k]['Support interface'] || 0), 0);
    const trans = layers.reduce((a, k) => a + (L[k]['Support transition'] || 0), 0);
    const wantI = sum(top[0]) + sum(top[1]), wantT = sum(top[2]) + sum(top[3]);
    check(ob.name + ': Support interface is exactly every move of its top 2 layers',
      iface === wantI && (L[top[0]]['Support interface'] || 0) === sum(top[0]) && (L[top[1]]['Support interface'] || 0) === sum(top[1]),
      iface + ' interface moves; layers ' + top[1] + '-' + top[0] + ' hold ' + wantI);
    check(ob.name + ': Support transition is exactly every move of the 2 layers below',
      trans === wantT && (L[top[2]]['Support transition'] || 0) === sum(top[2]) && (L[top[3]]['Support transition'] || 0) === sum(top[3]),
      trans + ' transition moves; layers ' + top[3] + '-' + top[2] + ' hold ' + wantT);
    const below = layers.filter(k => k < top[3]);
    check(ob.name + ': everything under the sheet (trunks, branches, feet) is Support',
      below.length > 0 && below.every(k => Object.keys(L[k]).length === 1 && L[k]['Support'] > 0),
      below.length + ' layers, ' + below.reduce((a, k) => a + (L[k]['Support'] || 0), 0) + ' Support moves');
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. the Features list ===');
  {
    const counts = {};
    parsed.moves.forEach(m => { counts[m.feature] = (counts[m.feature] || 0) + 1; });
    check('the slice holds the three rows, each with a count', SUPPORT_TYPES.every(f => counts[f] > 0),
      SUPPORT_TYPES.map(f => f + ' (' + (counts[f] || 0) + ')').join(', '));
    check('G-scope colours every one of them (nso-gcode-lines.js FEATURE_COLORS)',
      SUPPORT_TYPES.every(f => Object.prototype.hasOwnProperty.call(G.FEATURE_COLORS, f)));
    const hostFeats = new Set(parsed.moves.filter(m => m.objectId === 0).map(m => m.feature));
    check('...and the host prints none of them', SUPPORT_TYPES.every(f => !hostFeats.has(f)), [...hostFeats].join(', '));
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. the host is credited with what holds it ===');
  {
    const host = r.objects[0];
    const g = SL.geometry(wasm);
    try {
      check('the host has its two overhangs, one per clip', host.overhang.length === 2,
        host.overhang.map(h => 'z ' + h.firstZ.toFixed(2) + ' ' + h.footprintMm2.toFixed(1) + ' mm²').join(', '));
      for (const h of host.overhang) {
        const cx = (h.min[0] + h.max[0]) / 2;
        const under = r.objects.slice(1).find(ob => {
          const top = ob.layers[ob.support.sheets[0].topLayer].sectionPolys;
          const xs = [].concat(...top).map(p => p[0]);
          return Math.min(...xs) < cx && cx < Math.max(...xs);
        });
        const label = 'clip at x ' + cx.toFixed(1);
        check(label + ': covered by the support under it, and by no other',
          under && h.coveredBy.length === 1 && h.coveredBy[0].id === under.id && h.coveredMm2 > 0.5 * h.footprintMm2,
          h.coveredBy.map(c => c.name + ' ' + c.mm2.toFixed(1) + ' mm²').join(', '));
        /* the sheet's top footprint, as the slicer closes it */
        const sheet = under.support.sheets[0];
        const foot = g.offset(g.offset(g.of(under.layers[sheet.topLayer].sectionPolys), SL.CONSTANTS.supportSheet.closeMm), -SL.CONSTANTS.supportSheet.closeMm);
        const left = g.area(g.inter(g.of(h.uncoveredPolys), foot));
        check(label + ': its uncovered area is 0 where the sheet is under it',
          left < 1e-3 && Math.abs(h.coveredMm2 + h.uncoveredMm2 - h.footprintMm2) < 1e-6,
          h.footprintMm2.toFixed(1) + ' mm² = ' + h.coveredMm2.toFixed(1) + ' covered + ' + h.uncoveredMm2.toFixed(1) +
          ' uncovered (where the sheet stops short of the clip\'s corners); ' + left.toExponential(1) + ' mm² of it under the sheet');
      }
    } finally { g.free(); }
    const words = READOUT.report(r, []);
    const hostLine = words.slice(words.indexOf(HOST + ': '), words.indexOf(HOST + ' - support'));
    console.log('        readout: ' + words);
    const z = 'z ' + host.overhang[0].firstZ.toFixed(2);
    /* a clip with some of it uncovered is listed with its covered and
       uncovered area; one the sheet covers whole (#256's 0.40 sheet covers
       one clip so) reads "held by support at z ... (A mm², support N)" */
    const supName = h => h.coveredBy[0].name.replace(HOST + ' - ', '').replace(/\s*\([^)]*\)$/, '');
    check('the host\'s readout lists each clip with its covered and uncovered area, or as held when nothing is uncovered, naming the covering support',
      host.overhang.every(h => h.uncoveredMm2 > 0
        ? hostLine.includes(z + ': ' + h.footprintMm2.toFixed(1) + ' mm² overhang, ' + h.coveredMm2.toFixed(1) + ' covered by ' + supName(h) + ', ' + h.uncoveredMm2.toFixed(1) + ' uncovered')
        : hostLine.includes('held by support at ') && hostLine.includes(z + ' (' + h.coveredMm2.toFixed(1) + ' mm², ' + supName(h) + ')')) &&
        /support 1\.1/.test(hostLine) && /support 2\.1/.test(hostLine), hostLine.trim());
    for (const ob of r.objects.slice(1)) {
      const at = words.indexOf(ob.name + ': '), next = words.indexOf('. ' + HOST, at);
      const line = words.slice(at, next < 0 ? undefined : next + 1);
      const sp = ob.support;
      check(ob.name + ': its own line says what it holds - and not that it needs support',
        line.includes('support for ' + HOST + ': ' + sp.tips + ' tips, sheet at z ' + sp.zLo.toFixed(2) + '–' + sp.zHi.toFixed(2)) &&
        !/needs support/.test(line) && sp.tips > 0 && sp.sheets.length === 1, line.trim());
    }
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the words for a host the supports fully cover ===');
  {
    const reg = (z, a, by) => ({ firstZ: z, footprintMm2: a, standsOn: 'plate', coveredMm2: a, uncoveredMm2: 0,
      coveredBy: by.map(([id, n]) => ({ id, name: HOST + ' - support ' + n + ' (Tree)', mm2: a / by.length })) });
    const fake = {
      planes: [{}], ms: 0, conflicts: [],
      options: { layerMm: 0.2, outerWallWidthMm: 0.42, wallLoops: 2, sparseDensity: 0.15, sparsePattern: 'grid', supportThresholdDeg: 30 },
      objects: [{ name: HOST, role: 'part', wallCountHistogram: { 2: 10 }, sectionStats: { openChains: 0 },
                  overhang: [reg(13.5, 200.0, [[1, '1.1']]), reg(13.5, 111.7, [[2, '1.2']])] }]
    };
    const w = READOUT.report(fake, []);
    check('zero uncovered: "no support needed (2 supports cover 311.7 mm²)"', w.includes(HOST + ': walls per layer 2×10; no support needed (2 supports cover 311.7 mm²).'), w);
    fake.objects[0].overhang = [Object.assign(reg(13.5, 311.7, [[1, '1.1']]), { coveredMm2: 298.0, uncoveredMm2: 13.7 })];
    const w2 = READOUT.report(fake, []);
    check('partly covered: "z 13.50: 311.7 mm² overhang, 298.0 covered by support 1.1, 13.7 uncovered"',
      w2.includes('needs support at z 13.50: 311.7 mm² overhang, 298.0 covered by support 1.1, 13.7 uncovered.'), w2);
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. a part with no supports slices as it always did ===');
  {
    const plain = SL.sliceObjects([{ name: HOST, soup: piece }], o, wasm);
    const roled = SL.sliceObjects([{ name: HOST, soup: piece, key: HOST_KEY, role: 'part' }], o, wasm);
    check('roles passed or not, the same G-code byte for byte', plain.gcode === roled.gcode, plain.gcode.length + ' bytes');
    check('...the same readout, no credit fields on its overhangs', READOUT.report(plain, []).replace(/\(\d+ ms\)/, '') === READOUT.report(roled, []).replace(/\(\d+ ms\)/, '') &&
      plain.objects[0].overhang.every(h => h.coveredMm2 === undefined) && /needs support at z 12\.00 \(61\.2 mm² on plate\)/.test(READOUT.report(plain, [])),
      READOUT.report(plain, []).split('. ').slice(1).join('. '));
    const same = plain.objects[0].layers.every((L, i) => JSON.stringify(L.paths) === JSON.stringify(r.objects[0].layers[i].paths));
    check('the host\'s own lines in the slice with supports are its lines alone - supports change only themselves', same);
  }

  console.log(`\n${fail ? 'FAILED' : 'PASSED'}  ${pass} of ${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
