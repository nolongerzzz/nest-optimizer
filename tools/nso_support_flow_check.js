#!/usr/bin/env node
/* ============================================================
   tools/nso_support_flow_check.js - THE FLOW TREE'S OWN GATES (npm run support:flow, docs/SUPPORT-FLOW.md)

   nso_support_flow.js grows every tree by one program. This check throws shapes at it - a free slab, a slope, a slab over the part's own
   pedestal, a ceiling walled in, a wall beside the tips, a wide field, a twig - and asks the same questions of every one:

     STRUCTURE   every tip built runs down to the plate through its branches; no branch leans past the branch angle; a branch is never
                 thinner than the one that runs into it, and never thinner going down
     CLEARANCE   no branch point stands in the part, or nearer it than the xy distance (past its tip's own column)
     NO WELDS    two branches that are not one tree's parent and child do not run through one another: bodies that overlap deeply
                 have joined
     ECONOMY     the tree is shorter than a column under every tip; the trunks are as few as the height allows
     SAME AGAIN  the same input gives the same tree

   No browser, no slicer: the planner alone. About 3 s.
   ============================================================ */
'use strict';
const path = require('path');
const FL = require(path.join(__dirname, '..', 'nso_support_flow.js'));

let pass = 0, fail = 0; const failed = [];
function check(name, ok, note) { if (ok) pass++; else { fail++; failed.push(name); } console.log((ok ? '  ok    ' : '  FAIL  ') + name + (note ? '   ' + note : '')); }

function quad(a, b, c, d) { return [].concat(a, b, c, a, c, d); }
function box(x0, y0, z0, x1, y1, z1) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return [].concat(quad(p[0], p[3], p[2], p[1]), quad(p[4], p[5], p[6], p[7]), quad(p[0], p[1], p[5], p[4]), quad(p[1], p[2], p[6], p[5]), quad(p[2], p[3], p[7], p[6]), quad(p[3], p[0], p[4], p[7]));
}
const soup = (...boxes) => Float32Array.from([].concat(...boxes));
function gridTips(x0, y0, x1, y1, pitch, zOf) {
  const out = [];
  for (let x = x0; x <= x1 + 1e-9; x += pitch) for (let y = y0; y <= y1 + 1e-9; y += pitch) out.push({ id: out.length, p: [x, y, typeof zOf === 'function' ? zOf(x, y) : zOf] });
  return out;
}
/* is (x, y, z) inside one of the boxes, grown by g? */
function inBoxes(boxes, q, g) { return boxes.some(b => q[0] > b[0] - g && q[0] < b[3] + g && q[1] > b[1] - g && q[1] < b[4] + g && q[2] > b[2] - g && q[2] < b[5] + g); }

const K = FL.KNOBS, TAN_A = Math.tan(K.branchAngleDeg * Math.PI / 180), D = FL.DEFAULTS;

function gates(name, boxes, tips, want) {
  want = want || {};
  console.log('\n=== ' + name + ' ===');
  const S = soup(...boxes.map(b => box(...b)));
  const t0 = Date.now(), r = FL.plan({ soups: [S], plateZ: 0, tips });
  const ms = Date.now() - t0;
  check('plans', r.ok, r.reason + ' in ' + ms + ' ms (' + r.stats.nx + ' x ' + r.stats.ny + ' x ' + r.stats.levels + ', ' + r.stats.classes + ' laws)');
  if (!r.ok) return r;
  const B = r.branches, un = new Set(r.unreachable), built = tips.filter(t => !un.has(t.id));
  if (want.unreachable != null) check('unreachable: ' + want.unreachable, r.unreachable.length === want.unreachable, 'got ' + r.unreachable.length);
  if (want.unreachable === tips.length) { check('nothing is built for tips with no way down', B.length === 0 && r.trunks.length === 0); return r; }
  /* STRUCTURE */
  const tipBranch = {}; B.forEach(b => { if (b.tip != null) tipBranch[b.tip] = b; });
  let lost = 0;
  built.forEach(t => { let b = tipBranch[t.id], n = 0; while (b && b.into >= 0 && n++ < 1e4) b = B[b.into]; if (!b || Math.abs(b.pts[b.pts.length - 1][2]) > 1e-6) lost++; });
  check('every tip built runs down to the plate', lost === 0 && built.length > 0, built.length + ' tip(s), ' + lost + ' without a way');
  let worstLean = 0, thinner = 0, upSteps = 0;
  B.forEach(b => {
    for (let i = (b.tip != null ? 2 : 1); i < b.pts.length; i++) {
      const a = b.pts[i - 1], c = b.pts[i], dz = a[2] - c[2], dxy = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (dz < -1e-9) upSteps++;
      if (dz > 1e-9) worstLean = Math.max(worstLean, dxy / dz);
      if (b.r[i] < b.r[i - 1] - 1e-9 && !(b.tip != null && i === 1)) thinner++;
    }
    if (b.into >= 0 && B[b.into].r[0] < b.r[b.r.length - 1] - 1e-9) thinner++;
  });
  /* a level's step is held to the lean; the grid's own step (a cell's diagonal on a forced move) may add a little */
  check('no branch leans past the branch angle', worstLean <= TAN_A * 1.6 && upSteps === 0, 'steepest ' + (Math.atan(worstLean) * 180 / Math.PI).toFixed(1) + ' deg of ' + K.branchAngleDeg + (worstLean > TAN_A * 1.05 ? ' (a step round the part)' : ''));
  check('a branch is never thinner going down, nor than one that runs into it', thinner === 0, thinner + ' place(s)');
  /* CLEARANCE: every branch point under its tip's own column */
  const boxesB = boxes.map(b => [b[0], b[1], b[2], b[3], b[4], b[5]]);
  let inside = 0, near = 0, n = 0;
  B.forEach(b => b.pts.forEach((q, i) => {
    if (b.tip != null && i === 0) return;
    n++;
    if (inBoxes(boxesB, q, 0)) inside++;
    else if (inBoxes(boxesB, q, 0.3 + 0.6 * b.r[i])) near++;
  }));
  check('no branch stands in the part or against it', inside === 0 && near <= Math.ceil(n * 0.01), inside + ' point(s) inside, ' + near + ' of ' + n + ' nearer than its clearance');
  /* NO WELDS: two branches of no kin whose bodies overlap deeply at one height, well above where either joins */
  let welds = 0;
  const kin = (a, b) => { let x = a, n2 = 0; while (x && n2++ < 1e4) { if (x === b) return true; x = x.into >= 0 ? B[x.into] : null; } return false; };
  const at = (b, z) => { for (let i = 1; i < b.pts.length; i++) { const a = b.pts[i - 1], c = b.pts[i]; if (z <= a[2] + 1e-9 && z >= c[2] - 1e-9 && a[2] - c[2] > 1e-9) { const t = (a[2] - z) / (a[2] - c[2]); return [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, b.r[i - 1] + (b.r[i] - b.r[i - 1]) * t]; } } return null; };
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const a = B[i], b = B[j];
    if (kin(a, b) || kin(b, a)) continue;
    const zLo = Math.max(a.pts[a.pts.length - 1][2], b.pts[b.pts.length - 1][2]) + 2, zHi = Math.min(a.pts[0][2], b.pts[0][2]) - 3;
    let run = 0, worst = 0;
    for (let z = zHi; z >= zLo; z -= 0.4) { const p = at(a, z), q = at(b, z); if (p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.35 * Math.min(p[2], q[2])) { run += 0.4; worst = Math.max(worst, run); } else run = 0; }
    if (worst > 2) welds++;
  }
  check('no two branches run through one another without joining', welds === 0, welds + ' pair(s)');
  /* ECONOMY */
  let len = 0; B.forEach(b => { for (let i = 1; i < b.pts.length; i++) len += Math.hypot(b.pts[i][0] - b.pts[i - 1][0], b.pts[i][1] - b.pts[i - 1][1], b.pts[i][2] - b.pts[i - 1][2]); });
  const cols = built.reduce((s, t) => s + t.p[2], 0);
  check('the tree is shorter than a column under every tip', built.length < 2 || len <= cols * 1.001, len.toFixed(0) + ' mm of branch against ' + cols.toFixed(0) + ' mm of columns (' + (100 * len / cols).toFixed(0) + ' %)');
  if (want.trunks != null) check('trunks: at most ' + want.trunks, r.trunks.length <= want.trunks, r.trunks.length + ' trunk(s)');
  if (want.trunkOff) { const bo = want.trunkOff, bad = r.trunks.filter(t => Math.hypot(Math.max(bo[0] - t.c[0], 0, t.c[0] - bo[3]), Math.max(bo[1] - t.c[1], 0, t.c[1] - bo[4])) < t.r + 0.3).length; check('no trunk stands on or against the part\'s base', bad === 0, bad + ' of ' + r.trunks.length); }
  /* SAME AGAIN */
  const r2 = FL.plan({ soups: [S], plateZ: 0, tips });
  check('the same input gives the same tree', JSON.stringify(r2.branches) === JSON.stringify(r.branches));
  const pr = FL.prims(r);
  check('its body\'s capsules: one a branch, radii all positive, a tip\'s cut flat at its spot', pr.length === B.length && pr.every(p => p.r.every(v => v > 0) && p.pts.length >= 2) && pr.filter(p => p.clip).length === B.filter(b => b.tip != null).length);
  return r;
}

/* 1. a free slab 20 mm up */
gates('a slab 30 x 30 at 20 mm, nothing under it', [[-15, -15, 20, 15, 15, 24]], gridTips(-12, -12, 12, 12, 4, 20), { unreachable: 0, trunks: 6 });       /* a canopy 24 mm across at 20 mm: its corners cannot reach one trunk at 45 deg */
/* 2. a slope: tips from 12 to 28 mm */
gates('a slope, tips from 12 to 28 mm', [[-16, -16, 30, 16, 16, 32]], gridTips(-12, -12, 12, 12, 4, (x) => 20 + x * 0.66), { unreachable: 0, trunks: 8 });
/* 3. a slab over the part's own pedestal: the tree goes round it */
gates('a slab over its own pedestal: the trunks stand off it', [[-15, -15, 20, 15, 15, 24], [-6, -6, 0, 6, 6, 20]],
  gridTips(-12, -12, 12, 12, 4, 20).filter(t => Math.abs(t.p[0]) > 7 || Math.abs(t.p[1]) > 7), { unreachable: 0, trunkOff: [-6, -6, 0, 6, 6, 20] });
/* 4. tips with a wall beside them: no trunk in the wall */
gates('a shelf off a wall', [[-10, -10, 0, -6, 10, 30], [-6, -10, 18, 10, 10, 21]], gridTips(-4, -8, 8, 8, 4, 18), { unreachable: 0, trunkOff: [-10, -10, 0, -6, 10, 30] });
/* 5. a ceiling walled in on every side, a floor under it: no way down for any tip, nothing built */
gates('a ceiling closed in: no way down', [[-10, -10, 0, 10, 10, 2], [-10, -10, 2, -8, 10, 20], [8, -10, 2, 10, 10, 20], [-8, -10, 2, 8, -8, 20], [-8, 8, 2, 8, 10, 20], [-10, -10, 20, 10, 10, 22]],
  gridTips(-4, -4, 4, 4, 4, 20), { unreachable: 9 });
/* 6. a floor under half the slab: those over the floor lean out to the open side or are named, the rest stand */
(function () {
  const tips = gridTips(-12, -12, 12, 12, 4, 20), r = gates('a slab with the part\'s floor under half of it', [[-15, -15, 20, 15, 15, 24], [-15, -15, 0, 0, 15, 3]], tips, { trunkOff: [-15, -15, 0, 0, 15, 3] });
  check('the tips over the open half all stand', tips.filter(t => t.p[0] > 2).every(t => r.unreachable.indexOf(t.id) < 0));
})();
/* 7. a twig among tips joins the tree */
(function () {
  const tips = gridTips(-8, -8, 8, 8, 4, 20); tips.push({ id: tips.length, p: [13, 0, 24], twig: true });
  const r = gates('a twig beside a canopy', [[-12, -12, 20, 12, 12, 23], [12.5, -3, 24, 16, 3, 27]], tips, { unreachable: 0, trunks: 2 });
  const tw = r.branches.find(b => b.tip === tips.length - 1);
  check('the twig is one ring of line at its spot and thinner than a tip all its way', !!tw && tw.r[0] <= 0.3 && tw.r[1] < K.branchDiameterMm / 2);
})();
/* 8. a wide field: 400 tips, timed */
(function () {
  const t0 = Date.now(), r = gates('a field of 400 tips at 25 mm', [[-42, -42, 25, 42, 42, 27]], gridTips(-38, -38, 38, 38, 4, 25), { unreachable: 0 });
  check('...planned in under 6 s', Date.now() - t0 < 12000, (Date.now() - t0) + ' ms for two plans and the gates');
  check('...on few trunks (a trunk to about a canopy of its height: a column a tip would be 400)', r.trunks.length <= 30, r.trunks.length + ' trunk(s)');
})();
/* 9. squat: tips 6 mm up - columns, short, no leaning in the flare */
gates('a squat slab 6 mm up', [[-10, -10, 6, 10, 10, 8]], gridTips(-8, -8, 8, 8, 4, 6), { unreachable: 0 });

console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  all ' + pass));
if (fail) { failed.forEach(f => console.log('  ' + f)); process.exit(1); }
