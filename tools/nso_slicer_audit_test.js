#!/usr/bin/env node
// Headless self-test for tools/nso_slicer_audit.js: the overhang rule a slicer
// applies to NSO's supports, asked of shapes whose answer is checkable by hand,
// and the Bambu side (g-code parsing, classing, calibration) on a g-code
// written here.
//
//   node tools/nso_slicer_audit_test.js      exit 0 = every gate held
//
// Section 5 is --sheet (sheetAudit): how the interface sheet's lines printed,
// on g-code written here - one pass a line, a chopped loop round a sliver,
// column loops, and the export's lines counted printed or missing.
//
// The calibration against a real slice (the 12-piece clamp plate) is not
// here: neither the export nor the sliced file is committed. It runs from the
// CLI - node tools/nso_slicer_audit.js export.3mf --gcode sliced.gcode.3mf
// --shift -2.25,0 - and its numbers are in the PR that added this file.

'use strict';
const path = require('path');
const AU = require(path.join(__dirname, 'nso_slicer_audit.js'));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* An outward-wound box. */
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
/* A column leaning `deg` off vertical along +x: a 2 x 2 square on the plate,
   its top square slid along x by h * tan(deg). Its +x face looks down, at
   exactly `deg` off vertical; its bottom sits on the plate. */
function lean(deg, h) {
  const d = h * Math.tan(deg * Math.PI / 180);
  const v = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [d, 0, h], [2 + d, 0, h], [2 + d, 2, h], [d, 2, h]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return new Float32Array(out);
}
const S = (...parts) => new Float32Array([].concat(...parts));
const one = (soup, occ, opts) => AU.audit([{ id: 1, name: 't', soup }], occ || [], Object.assign({ plateZ: 0 }, opts));

console.log('\n=== 1. The rule: more than 30 deg off vertical, nothing within a layer below ===');
{
  const col = one(S(box([0, 0, 0], [2, 2, 10])));
  check('a column standing on the plate flags nothing', col.flaggedAreaMm2 === 0 && col.regions.length === 0,
    `${col.flaggedAreaMm2} mm^2`);

  const bar = one(S(box([0, 0, 5], [10, 2, 7])));
  check('a bar in mid-air flags its whole underside, one region', near(bar.flaggedAreaMm2, 20, 1e-4) && bar.regions.length === 1,
    `${bar.flaggedAreaMm2.toFixed(4)} mm^2 (10 x 2), ${bar.regions.length} region(s), z ${bar.regions[0].lo[2].toFixed(2)}`);

  for (const [deg, flag] of [[25, false], [30, false], [31, true], [45, true]]) {
    const r = one(lean(deg, 10));
    const want = flag ? 2 * 10 / Math.cos(deg * Math.PI / 180) : 0;
    check(`a column leaning ${deg} deg: ${flag ? 'its downward face flags, all of it' : 'nothing'}`,
      near(r.flaggedAreaMm2, want, 1e-3), `${r.flaggedAreaMm2.toFixed(4)} mm^2, want ${want.toFixed(4)}`);
  }
  const noPlate = AU.audit([{ id: 1, name: 't', soup: S(box([0, 0, 0], [2, 2, 10]), box([0, 0, 5], [10, 2, 7])) }], [], {});
  const withPlate = AU.audit([{ id: 1, name: 't', soup: S(box([0, 0, 0], [2, 2, 10]), box([0, 0, 5], [10, 2, 7])) }], [], { plateZ: 0 });
  check('with no plateZ given, the plate is the lowest z: the same as plateZ 0', near(noPlate.flaggedAreaMm2, withPlate.flaggedAreaMm2, 1e-9) && withPlate.flaggedAreaMm2 > 0,
    `${noPlate.flaggedAreaMm2.toFixed(4)} mm^2 against ${withPlate.flaggedAreaMm2.toFixed(4)}`);
  const steep = one(lean(45, 10), [], { maxFromVerticalDeg: 50 });
  check('the limit is a dial: at 50 deg the 45 deg lean is clean', steep.flaggedAreaMm2 === 0, `${steep.flaggedAreaMm2} mm^2`);
}

console.log('\n=== 2. What counts as underneath ===');
{
  const part = box([0, 0, 0], [10, 2, 5]);
  const close = one(S(box([0, 0, 5.15], [10, 2, 7])), [new Float32Array(part)]);
  const far = one(S(box([0, 0, 5.3], [10, 2, 7])), [new Float32Array(part)]);
  check('a bar 0.15 mm over the part (an occluder) is held', close.flaggedAreaMm2 === 0, `${close.flaggedAreaMm2} mm^2`);
  check('...and 0.3 mm over it is not', near(far.flaggedAreaMm2, 20, 1e-4), `${far.flaggedAreaMm2.toFixed(4)} mm^2`);

  const low = one(S(box([0, 0, 0.15], [10, 2, 2])));
  check('an underside 0.15 mm over the plate is held by the plate', low.flaggedAreaMm2 === 0, `${low.flaggedAreaMm2} mm^2`);

  const twoObj = AU.audit([{ id: 1, name: 'a', soup: S(box([0, 0, 5], [10, 2, 7])) },
                           { id: 2, name: 'b', soup: S(box([0, 0, 0], [10, 2, 4.9])) }], [], { plateZ: 0 });
  check('another support 0.1 mm under a bar holds it', twoObj.flaggedAreaMm2 === 0, `${twoObj.flaggedAreaMm2} mm^2`);

  /* A 3 x 3 pad on a column, the two NOT unioned: the column pokes into the
     pad. The pad's underside is two triangles, four samples each; the
     column's footprint takes in two of the eight (the centroids, (1, 0) and
     (0, 1)), so 3/4 of each 4.5 mm^2 triangle flags: 6.75 mm^2. */
  const pad = one(S(box([-1, -1, 5], [2, 2, 5.6]), box([-0.1, -0.1, 0], [1.1, 1.1, 5.3])));
  check('a pad on a column: the rim flags, the samples over (and inside) the column do not',
    near(pad.flaggedAreaMm2, 6.75, 1e-4), `${pad.flaggedAreaMm2.toFixed(4)} mm^2 of 9`);
}

console.log('\n=== 3. Per object, in regions ===');
{
  const r = AU.audit([{ id: 7, name: 'two bars', soup: S(box([0, 0, 5], [10, 2, 7]), box([20, 0, 8], [24, 2, 9])) },
                      { id: 8, name: 'column', soup: S(box([40, 0, 0], [42, 2, 10])) }], [], { plateZ: 0 });
  const o7 = r.objects.find(o => o.id === 7), o8 = r.objects.find(o => o.id === 8);
  check('two separate bars are two regions of their object, largest first',
    o7.regions.length === 2 && near(o7.regions[0].areaMm2, 20, 1e-4) && near(o7.regions[1].areaMm2, 8, 1e-4),
    o7.regions.map(x => x.areaMm2.toFixed(2)).join(', '));
  check('the column object reports zero', o8.flaggedAreaMm2 === 0 && o8.regions.length === 0, `${o8.flaggedAreaMm2} mm^2`);
  check('the total is the sum', near(r.flaggedAreaMm2, 28, 1e-4), `${r.flaggedAreaMm2.toFixed(4)} mm^2`);
  const minR = AU.audit([{ id: 7, name: 'two bars', soup: S(box([0, 0, 5], [10, 2, 7]), box([20, 0, 8], [24, 2, 9])) }], [],
                        { plateZ: 0, minRegionMm2: 10 });
  check('minRegionMm2 leaves out the small one', minR.regions.length === 1 && near(minR.flaggedAreaMm2, 20, 1e-4),
    `${minR.regions.length} region(s)`);
}

console.log('\n=== 4. Bambu\'s side: g-code, classing, calibration ===');
{
  /* The export: a part with a ceiling at z 10 (x 0-10), and a tree bar in
     mid-air at x 20-30 whose underside is at z 6. The slice is shifted -2.25
     in x, as Bambu re-centred the clamp plate. */
  const partSoup = S(box([0, 0, 10], [10, 4, 12]), box([-2, 0, 0], [0, 4, 12]));
  const tree = S(box([20, 0, 6], [30, 4, 7]), box([29, 0, 0], [30, 4, 6]));
  const objs = [{ id: 1, name: 'part', soup: partSoup, support: false },
                { id: 2, name: 'part - support 1.1 (Tree)', soup: tree, support: true }];
  const g = [
    '; Z_HEIGHT: 9.6', '; FEATURE: Support interface',
    'G1 X0.75 Y1 F3000', 'G1 X5.75 Y1 E0.2',             /* under the part's ceiling: x 3-8 in the export */
    'G91', 'G1 X1 E0.1', 'G90',                           /* a relative move: skipped, and it moves x on */
    '; Z_HEIGHT: 5.6', '; FEATURE: Support interface',
    'G1 X19.75 Y2 F3000', 'G1 X23.75 Y2 E0.2',            /* under the tree bar: x 22-26 */
    '; FEATURE: Support', 'G1 X25.75 Y2 E0.2',            /* support body: not interface */
    '; Z_HEIGHT: 2.0', '; FEATURE: Support interface',
    'G1 X60 Y2 F3000', 'G1 X62 Y2 E0.1'                   /* under nothing */
  ].join('\n');
  const pts = AU.interfacePoints(g, { shift: [-2.25, 0] });
  check('interfacePoints: interface extrusions only, every 0.2 mm, in the export\'s frame',
    pts.length === 26 + 21 + 11 && near(pts[0][0], 3, 1e-9) && near(pts[25][0], 8, 1e-9) && pts[0][2] === 9.6 &&
    near(pts[26][0], 22, 1e-9) && near(pts[46][0], 26, 1e-9),
    `${pts.length} samples; first ${pts[0].map(v => +v.toFixed(3)).join(',')}`);

  const b = AU.bambuInterface(g, objs, { shift: [-2.25, 0] });
  check('classed by what is just above: 26 under the part, 21 under the tree, 11 under nothing',
    b.counts.topPart === 26 && b.counts.topTree === 21 && b.counts.none === 11,
    JSON.stringify({ part: b.counts.topPart, tree: b.counts.topTree, bottom: b.counts.bottom, none: b.counts.none }));
  check('the shadow: 26 with the part first above, 21 under the tree alone (all within 1 mm), 11 under nothing',
    b.counts.shadow.partFirst === 26 && b.counts.shadow.treeOnly === 21 && b.counts.shadow.treeOnlyNear === 21 &&
    b.counts.shadow.nothing === 11, JSON.stringify(b.counts.shadow));
  check('the tree lines are one Bambu region, and one with no part above', b.regions.length === 1 && b.aloneRegions.length === 1,
    `${b.regions.length} / ${b.aloneRegions.length}`);

  /* All 10 x 4 of the bar's underside flags: its 1 mm leg at x 29-30 lies
     between the eight samples of its two triangles (the audit's resolution
     is four samples a triangle, stated in its header). */
  const res = AU.audit(objs.filter(o => o.support), [partSoup], { plateZ: 0 });
  const cal = AU.calibrate(res, b);
  check('calibration: the audit flags the bar\'s underside, and that region matches Bambu\'s',
    near(res.flaggedAreaMm2, 40, 1e-4) && cal.bambuRegions === 1 && cal.matched === 1 && cal.treeAlone.matched === 1,
    `${res.flaggedAreaMm2.toFixed(2)} mm^2 flagged; ${cal.matched}/${cal.bambuRegions} matched`);
  check('...and nothing the audit flagged was left alone by Bambu', cal.auditAlone === 0 && cal.aloneAreaRate === 0,
    `${cal.auditAlone} of ${cal.auditRegions}`);

  const extra = AU.audit([{ id: 2, name: 'tree', soup: S(Array.from(tree), box([40, 0, 6], [44, 4, 7]), box([43, 0, 0], [44, 4, 6])) }],
                         [partSoup], { plateZ: 0 });
  const cal2 = AU.calibrate(extra, b);
  check('a flagged region with no Bambu line under it is counted as left alone',
    cal2.auditAlone === 1 && near(cal2.auditAloneAreaMm2, 12, 1e-4),
    `${cal2.auditAlone} region(s), ${cal2.auditAloneAreaMm2.toFixed(2)} mm^2`);
}

console.log('\n=== 5. --sheet: how the sheet\'s lines printed ===');
{
  /* A plate of two objects: a part (label 1) whose outer wall runs at
     0.0307 E/mm, and a support (label 2) whose z 13.2 layer is ten sheet
     lines 10 mm long, 0.84 mm apart along y. Three ways to print them:
       A  one pass each, one move each, at a thin wall's 0.0342 E/mm (a 0.43
          line drawn as its centreline at 0.473 mm)
       B  each a loop round a sliver: out and back 0.05 mm apart, cut into
          0.25 mm moves, at a 0.3785 loop's 0.0278 E/mm - Bambu's classic
          walls on a 0.42 line, as slice_w_supports.gcode.3mf printed it
       C  column loops (1.2 mm squares): not a sheet layer at all */
  const head = ['M83', '; start printing object, unique label id: 1', '; Z_HEIGHT: 0.2', '; FEATURE: Outer wall',
                'G1 X0 Y0 F3000', 'G1 X10 Y0 E0.5', '; Z_HEIGHT: 13.2', '; LAYER_HEIGHT: 0.2', '; FEATURE: Outer wall',
                'G1 X0 Y-5 F3000', 'G1 X20 Y-5 E0.614', '; stop printing object, unique label id: 1'];
  const names = { 1: 'clip', 2: 'clip - support 1.1 (Tree)' };
  const r3 = v => +v.toFixed(3);
  function layer(kind) {
    const g = ['; start printing object, unique label id: 2', '; Z_HEIGHT: 13.2', '; LAYER_HEIGHT: 0.2', '; FEATURE: Outer wall'];
    for (let k = 0; k < 10; k++) {
      const y = 50 + 0.84 * k;
      if (kind === 'A') g.push(`G1 X50 Y${r3(y)} F3000`, `G1 X60 Y${r3(y)} E${r3(10 * 0.0342)}`);
      if (kind === 'B') {
        g.push(`G1 X50 Y${r3(y)} F3000`);
        for (let x = 50.25; x <= 60 + 1e-9; x += 0.25) g.push(`G1 X${r3(x)} Y${r3(y)} E${(0.25 * 0.0278).toFixed(5)}`);
        g.push(`G1 X60 Y${r3(y + 0.05)} E0.0014`);
        for (let x = 59.75; x >= 50 - 1e-9; x -= 0.25) g.push(`G1 X${r3(x)} Y${r3(y + 0.05)} E${(0.25 * 0.0278).toFixed(5)}`);
      }
      if (kind === 'C') {
        const x0 = 50 + 3 * k;
        g.push(`G1 X${x0} Y50 F3000`, `G1 X${x0 + 1.2} Y50 E0.04`, `G1 X${x0 + 1.2} Y51.2 E0.04`, `G1 X${x0} Y51.2 E0.04`, `G1 X${x0} Y50 E0.04`);
      }
    }
    g.push('; stop printing object, unique label id: 2');
    return head.concat(g).join('\n');
  }
  const A = AU.sheetAudit(layer('A'), { names }), B = AU.sheetAudit(layer('B'), { names }), C = AU.sheetAudit(layer('C'), { names });
  const a = A.layers[0], b = B.layers[0];
  check('the outer wall\'s E/mm is the part\'s, above the first layer', near(A.outerWallEmm, 0.0307, 1e-4), A.outerWallEmm.toFixed(5));
  check('A, one pass a line: 10 segments of 10 mm, 1.00 pass, E per mm of line 1.11 x the wall - OK',
    A.layers.length === 1 && a.segments === 10 && near(a.meanSegMm, 10, 1e-6) && near(a.longShare, 1, 1e-9) &&
    near(a.passes, 1, 1e-6) && near(a.lineRatio, 0.0342 / 0.0307, 1e-3) && a.ok && A.ok,
    a && `${a.segments} segments, mean ${a.meanSegMm.toFixed(2)}, passes ${a.passes.toFixed(3)}, ${a.lineRatio.toFixed(3)} x per mm of line`);
  check('B, a chopped loop round a sliver: 0.25 mm segments, 2 passes, 1.8 x per mm of line - NOT OK',
    B.layers.length === 1 && near(b.meanSegMm, 0.25, 0.01) && b.longShare === 0 && near(b.passes, 2, 0.02) &&
    near(b.ratio, 0.0278 / 0.0307, 0.01) && near(b.lineRatio, 2 * 0.0278 / 0.0307, 0.05) && !b.ok && !B.ok,
    b && `${b.segments} segments, mean ${b.meanSegMm.toFixed(3)}, passes ${b.passes.toFixed(3)}, ratio ${b.ratio.toFixed(3)} -> ${b.lineRatio.toFixed(3)} per mm of line`);
  check('C, column loops: no sheet layer', C.layers.length === 0 && !C.ok, `${C.layers.length} layer(s)`);
  /* the export's lines: the ten, plus an eleventh nobody printed */
  const boxes = [];
  for (let k = 0; k < 11; k++) boxes.push({ obj: names[2], z0: 13.0, z1: 13.2, a: [50, 50 + 0.84 * k], b: [60 + (k === 10 ? 12 : 0), 50 + 0.84 * k] });
  const D = AU.sheetAudit(layer('A'), { names, boxes });
  check('with the export: 10 of 11 lines printed, the 22 mm one missing - NOT OK',
    D.layers.length === 1 && D.layers[0].exportLines === 11 && D.layers[0].printed === 10 && D.layers[0].missingMm.length === 1 &&
    near(D.layers[0].missingMm[0], 22, 1e-6) && !D.layers[0].ok,
    D.layers[0] && `${D.layers[0].printed} of ${D.layers[0].exportLines}, missing ${D.layers[0].missingMm.join(', ')}`);
  /* a G3 arc with E counts its arc length */
  const arc = AU.extrusions(['M83', '; Z_HEIGHT: 1', 'G1 X10 Y0 F3000', 'G3 X0 Y10 I-10 J0 E1'].join('\n'));
  check('a G3 extrusion counts its arc, not its chord', arc.length === 1 && near(arc[0].len, Math.PI * 10 / 2, 1e-9), arc[0] && arc[0].len.toFixed(4));
  /* an arc-fitted round loop (two G3 halves of a 2 mm circle) is as wide as
     the loop: a column's or a cap's loop, not a thin sheet chain (by its
     chord it was 2 mm along and 0 across: thin) */
  const loops = layer('A').replace('; stop printing object, unique label id: 2',
    [0, 1, 2].map(k => `G1 X${80 + 6 * k} Y50 F3000\nG3 X${82 + 6 * k} Y50 I1 J0 E0.1\nG3 X${80 + 6 * k} Y50 I-1 J0 E0.1`).join('\n') +
    '\n; stop printing object, unique label id: 2');
  const LP = AU.sheetAudit(loops, { names });
  check('arc-fitted round loops beside the lines are no sheet chain: still 10 segments, 1.00 pass',
    LP.layers.length === 1 && LP.layers[0].segments === 10 && near(LP.layers[0].passes, 1, 1e-6),
    LP.layers[0] && `${LP.layers[0].segments} segments, passes ${LP.layers[0].passes.toFixed(3)}`);
  /* with the export, only the moves on its lines are counted: the column
     loops of the same object at the same z are not */
  const cols = layer('A').replace('; stop printing object, unique label id: 2',
    [0, 1, 2].map(k => { const x0 = 80 + 3 * k; return `G1 X${x0} Y50 F3000\nG1 X${x0 + 1.2} Y50 E0.04\nG1 X${x0 + 1.2} Y51.2 E0.04\nG1 X${x0} Y51.2 E0.04\nG1 X${x0} Y50 E0.04`; }).join('\n') +
    '\n; stop printing object, unique label id: 2');
  const E10 = AU.sheetAudit(cols, { names, boxes: boxes.slice(0, 10) });
  check('with the export and column loops beside the lines: 10 segments of 10 mm, all 10 printed - OK',
    E10.layers.length === 1 && E10.layers[0].segments === 10 && near(E10.layers[0].longShare, 1, 1e-9) && E10.layers[0].printed === 10 && E10.layers[0].ok,
    E10.layers[0] && `${E10.layers[0].segments} segments, long share ${E10.layers[0].longShare.toFixed(3)}, ${E10.layers[0].printed} printed`);
  /* the parser: G91 moves move the head, M82 E is absolute, names are decoded */
  const g91 = AU.extrusions(['M83', '; Z_HEIGHT: 1', 'G1 X10 Y10 F3000', 'G91', 'G1 X5', 'G90', 'G1 Y20 E0.5'].join('\n'));
  check('a G91 move moves the head: the next extrusion runs from (15, 10)', g91.length === 1 && g91[0].x0 === 15 && g91[0].y0 === 10 && near(g91[0].len, 10, 1e-9),
    g91[0] && `from (${g91[0].x0}, ${g91[0].y0}), ${g91[0].len.toFixed(3)} mm`);
  const m82 = AU.extrusions(['M82', 'G92 E0', '; Z_HEIGHT: 1', 'G1 X0 Y0 F3000', 'G1 X10 Y0 E0.4', 'G1 X20 Y0 E0.8', 'G1 E0.0', 'G92 E0', 'G1 X30 Y0 E0.4'].join('\n'));
  check('M82 (absolute E): each move its own filament, a retraction no extrusion', m82.length === 3 && m82.every(m => near(m.e, 0.4, 1e-9)),
    m82.map(m => m.e.toFixed(3)).join(', '));
  const nm = AU.sliceNames('<object identify_id="7" name="Tom &amp; Jerry - support 1.1 (Tree)" skipped="false" />');
  check('slice_info names are decoded', nm[7] === 'Tom & Jerry - support 1.1 (Tree)', JSON.stringify(nm[7]));
  /* a print of 200k moves: no spread into one call */
  const big = ['M83', '; FEATURE: Outer wall'];
  for (let k = 0; k < 2000; k++) { big.push('; Z_HEIGHT: ' + (0.2 * (k + 1)).toFixed(1)); for (let q = 0; q < 100; q++) big.push(`G1 X${q % 2 ? 10 : 0} Y${q} E0.3`); }
  let bigOk = true;
  try { AU.sheetAudit(big.join('\n'), { names: {} }); } catch (err) { bigOk = String(err); }
  check('200 000 moves: no stack overflow', bigOk === true, String(bigOk));
  /* the export reader: one 8-vertex box per line, a block is not a line */
  const RL = require(path.join(__dirname, '..', 'nso_raster_lines.js'));
  const ex = RL.extrudeFlat([[[0, 0], [10, 0]], [[0, 0.84], [10, 0.84]]], { width: 0.43, height: 0.2, baseZ: 5 });
  const blk = S(box([20, 0, 5], [22, 1, 5.2]));
  const soup = new Float32Array(ex.tris.length + blk.length); soup.set(ex.tris); soup.set(blk, ex.tris.length);
  const eb = AU.exportSheetBoxes([{ name: 'p - support 1.1 (Tree)', soup }, { name: 'p', soup }]);
  check('exportSheetBoxes: the two lines of the support (centreline, width), not the block, not the part',
    eb.length === 2 && eb.every(x => near(x.widthMm, 0.43, 1e-5) && near(Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]), 10, 1e-5) && near(x.z0, 5, 1e-6)),
    `${eb.length} line(s): ${eb.map(x => x.widthMm.toFixed(3) + ' x ' + Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]).toFixed(3)).join(', ')}`);
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
