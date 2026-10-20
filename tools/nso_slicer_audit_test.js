#!/usr/bin/env node
// Headless self-test for tools/nso_slicer_audit.js: the overhang rule a slicer
// applies to NSO's supports, asked of shapes whose answer is checkable by hand,
// and the Bambu side (g-code parsing, classing, calibration) on a g-code
// written here.
//
//   node tools/nso_slicer_audit_test.js      exit 0 = every gate held
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

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
