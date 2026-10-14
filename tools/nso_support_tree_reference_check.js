#!/usr/bin/env node
// nso_support_tree.js against a real, proven Bambu tree support.
//
//   node tools/nso_support_tree_reference_check.js    exit 0 = every gate held
//
// WHY THIS EXISTS
//
// nso_support_tree.js carries exactly two numbers that are not derived from
// the piece it is supporting: MAX_SPAN_MM, the span it allows between contact
// points, and BRANCH_TILT_DEG, how far it lets a branch lean. Both were
// measured off fixtures/3mf/tabletop.gcode.3mf - a real Bambu Studio slice of
// a 70 mm tabletop on tree supports, 202,877 moves, already in the repo and
// already parsed end to end by npm run gcode:lines and gcode:zfilter.
//
// A constant measured once and then typed into a source file is a constant
// that can drift from what it was measured from without anything saying so.
// So this check takes both of them out of the G-code AGAIN, every run, from
// the toolpath itself rather than from a note about it, and fails if the file
// and the file's own header have parted company.
//
// It then does the comparison the constants were for: it puts a synthetic
// overhang of the reference's own dimensions through contactPoints() and
// planTree() (the grid-pack planner, nso_support_gridpack.js) and asks
// whether this module places the same number of contacts, at the same pitch,
// and lands a comparable number of trunks.
//
// HOW THE STRUCTURE IS READ OUT OF THE TOOLPATH
//
// Each Support / Support interface layer's extrusion moves are clustered into
// connected components: two moves are in one island when their segments come
// within 1.5 extrusion widths of each other in XY. An island is one branch's
// cross-section at that height, so the island COUNT per layer is the number
// of separate things the support consists of at that height - which is the
// whole trunk-then-branches question, asked of the print instead of of a
// picture of it.
//
// WHAT THE REFERENCE TURNS OUT TO BE (and what this check re-derives):
//
//   z 0.60 .. 4.50   36 islands on every one of 14 layers.  The TRUNK phase.
//   z 4.80 .. 19.20  36 -> 451, climbing on nearly every layer. The BRANCHES.
//   z 19.50, 19.80   Support interface: a perforated sheet at a ~1.09 mm line
//                    pitch, over a 69.9 x 69.9 mm footprint.
//
// That is the observed pattern this module was written to build: bulk carries
// the load as far as it can, then hands off to many thin branches, each
// ending at one discrete point of the interface.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'nso-gcode-lines.js'));

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const ST = ctx.NSO_SupportTree;
const SA = ctx.NSO_SupportAim;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const within = (got, want, frac) => Math.abs(got - want) <= Math.abs(want) * frac;

/* ---------- clustering a layer's moves into islands ---------------------- */

function ptSeg(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
function segDist(a, b) {
  return Math.min(
    ptSeg(a.x0, a.y0, b.x0, b.y0, b.x1, b.y1), ptSeg(a.x1, a.y1, b.x0, b.y0, b.x1, b.y1),
    ptSeg(b.x0, b.y0, a.x0, a.y0, a.x1, a.y1), ptSeg(b.x1, b.y1, a.x0, a.y0, a.x1, a.y1));
}
function islands(moves, tol) {
  const n = moves.length, par = new Int32Array(n);
  for (let i = 0; i < n; i++) par[i] = i;
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
  const cell = Math.max(tol * 2, 1), grid = new Map(), key = (i, j) => i + '|' + j;
  for (let k = 0; k < n; k++) {
    const m = moves[k];
    const i0 = Math.floor(Math.min(m.x0, m.x1) / cell), i1 = Math.floor(Math.max(m.x0, m.x1) / cell);
    const j0 = Math.floor(Math.min(m.y0, m.y1) / cell), j1 = Math.floor(Math.max(m.y0, m.y1) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const s = key(i, j);
      if (!grid.has(s)) grid.set(s, []);
      grid.get(s).push(k);
    }
  }
  for (const [s, list] of grid) {
    const [i, j] = s.split('|').map(Number), near = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const o = grid.get(key(i + di, j + dj));
      if (o) near.push(...o);
    }
    for (const a of list) for (const b of near) {
      if (a >= b || find(a) === find(b)) continue;
      if (segDist(moves[a], moves[b]) <= tol) uni(a, b);
    }
  }
  const g = new Map();
  for (let k = 0; k < n; k++) {
    const r = find(k);
    if (!g.has(r)) g.set(r, []);
    g.get(r).push(moves[k]);
  }
  return [...g.values()];
}
const centroid = g => {
  let sx = 0, sy = 0, w = 0;
  for (const m of g) { sx += (m.x0 + m.x1) / 2 * m.length; sy += (m.y0 + m.y1) / 2 * m.length; w += m.length; }
  return [sx / w, sy / w];
};
function nnStats(pts) {
  const d = pts.map((p, i) => {
    let b = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const q = Math.hypot(p[0] - pts[j][0], p[1] - pts[j][1]);
      if (q < b) b = q;
    }
    return b;
  }).sort((a, b) => a - b);
  return { min: d[0], median: d[(d.length / 2) | 0], max: d[d.length - 1] };
}
function bboxOf(moves) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const m of moves) {
    x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1);
    y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1);
  }
  return { x0, x1, y0, y1, w: x1 - x0, d: y1 - y0, area: (x1 - x0) * (y1 - y0) };
}

/* ---------- a flat overhang of stated size, floating at stated height ---- */

function slab(w, d, z, t) {
  const lo = [-w / 2, -d / 2, z], hi = [w / 2, d / 2, z + t];
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const tri of f) for (const i of tri) out.push(...v[i]);
  return new Float32Array(out);
}

(async () => {

console.log('\n=== 1. READING THE REAL STRUCTURE OUT OF fixtures/3mf/tabletop.gcode.3mf ===');

const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures/3mf/tabletop.gcode.3mf')));
const slice = await G.readSlicedGcode3MF(bytes);
const moves = slice.parsed.moves.filter(m => m.length > 0);

const support = moves.filter(m => /^Support$/i.test(m.feature || ''));
const iface = moves.filter(m => /^Support interface$/i.test(m.feature || ''));
check('the file really is a tree support with an interface on top',
  support.length > 100000 && iface.length > 0,
  `${support.length} Support moves, ${iface.length} Support interface moves, ` +
  `${slice.parsed.moves.length} moves in all`);

const byZ = new Map();
for (const m of support) {
  const k = m.z.toFixed(3);
  if (!byZ.has(k)) byZ.set(k, []);
  byZ.get(k).push(m);
}
const zs = [...byZ.keys()].map(Number).sort((a, b) => a - b);
const width = support[0].width;
const counts = zs.map(z => {
  const ms = byZ.get(z.toFixed(3));
  return { z, n: islands(ms, width * 1.5).length };
});

/* The trunk phase is the run of layers, starting above the first, over which
   the island count does not move. The branch phase is everything after it. */
const first = counts[1];                              /* layer 0 is the raft-like base */
let last = 1;
while (last + 1 < counts.length && counts[last + 1].n === first.n) last++;
const trunkCount = first.n;
const trunkTopZ = counts[last].z;
const tipLayer = counts[counts.length - 1];
const ifaceZ = Math.min(...iface.map(m => m.z));
const plateZ = counts[0].z;

console.log(`  trunk phase: ${trunkCount} islands, z ${first.z} .. ${trunkTopZ} ` +
  `(${last} layers, no change)`);
console.log(`  branch phase: ${trunkCount} -> ${tipLayer.n} islands by z ${tipLayer.z}`);
console.log(`  interface at z ${ifaceZ}; support starts at z ${plateZ}`);

check('the island count really is FLAT through the trunk phase, for 10+ layers',
  last >= 10 && counts.slice(1, last + 1).every(c => c.n === trunkCount),
  `${last} layers all at ${trunkCount}`);
check('and then climbs, monotonically enough to be called a fan',
  tipLayer.n > trunkCount * 5 &&
  counts.slice(last + 1).filter((c, i, a) => i === 0 || c.n >= a[i - 1].n).length >=
    (counts.length - last - 1) * 0.9,
  `${trunkCount} -> ${tipLayer.n}, fan-out ${(tipLayer.n / trunkCount).toFixed(2)} per trunk`);

const tips = islands(byZ.get(tipLayer.z.toFixed(3)), width * 1.5).map(centroid);
const trunks = islands(byZ.get(trunkTopZ.toFixed(3)), width * 1.5).map(centroid);
const tipNN = nnStats(tips);
const trunkNN = nnStats(trunks);
const foot = bboxOf(iface.filter(m => Math.abs(m.z - ifaceZ) < 1e-6));

console.log(`  interface footprint ${foot.w.toFixed(2)} x ${foot.d.toFixed(2)} = ` +
  `${foot.area.toFixed(0)} mm^2`);
console.log(`  tip spacing   nn min ${tipNN.min.toFixed(2)} median ${tipNN.median.toFixed(2)} ` +
  `max ${tipNN.max.toFixed(2)} mm`);
console.log(`  trunk spacing nn min ${trunkNN.min.toFixed(2)} median ${trunkNN.median.toFixed(2)} ` +
  `max ${trunkNN.max.toFixed(2)} mm`);

console.log('\n=== 2. THE TWO CONSTANTS, TAKEN OUT OF THE FILE AGAIN ===');

/* MAX_SPAN_MM is the AREAL pitch: the side of the square cell each contact
   has to itself over the footprint it covers. Nearest-neighbour spacing is a
   different and smaller number on an irregular point set, which is why the
   areal figure is the one a square lattice can be compared against. */
const arealPitch = Math.sqrt(foot.area / tips.length);
check('MAX_SPAN_MM is the reference\'s own areal contact pitch, to 2%',
  within(ST.MAX_SPAN_MM, arealPitch, 0.02),
  `${ST.MAX_SPAN_MM} mm vs sqrt(${foot.area.toFixed(0)} / ${tips.length}) = ` +
  `${arealPitch.toFixed(4)} mm`);
check('...and it sits inside the spacing the structure itself uses',
  ST.MAX_SPAN_MM >= tipNN.median && ST.MAX_SPAN_MM <= tipNN.max,
  `${tipNN.median.toFixed(2)} <= ${ST.MAX_SPAN_MM} <= ${tipNN.max.toFixed(2)} mm`);

/* BRANCH_TILT_DEG is measured per tip, as the angle off vertical from that
   tip down to its nearest trunk over the rise between the two phases. */
const rise = ifaceZ - trunkTopZ;
const tilts = tips.map(t => {
  let b = Infinity;
  for (const s of trunks) {
    const d = Math.hypot(t[0] - s[0], t[1] - s[1]);
    if (d < b) b = d;
  }
  return Math.atan2(b, rise) * 180 / Math.PI;
}).sort((a, b) => a - b);
const tiltMax = tilts[tilts.length - 1];
const tiltMed = tilts[(tilts.length / 2) | 0];
console.log(`  branch lean off vertical over a ${rise.toFixed(1)} mm rise: median ` +
  `${tiltMed.toFixed(2)}, p95 ${tilts[Math.floor(0.95 * (tilts.length - 1))].toFixed(2)}, ` +
  `max ${tiltMax.toFixed(2)} deg`);

check('BRANCH_TILT_DEG is the widest lean the proven structure ever uses, to 0.1 deg',
  Math.abs(ST.BRANCH_TILT_DEG - tiltMax) <= 0.1,
  `${ST.BRANCH_TILT_DEG} deg vs ${tiltMax.toFixed(4)} deg measured`);
check('...which is well inside the printable angle, not at it',
  ST.BRANCH_TILT_DEG < SA.ANGLE_DEFAULT_DEG,
  `${ST.BRANCH_TILT_DEG} deg vs the ${SA.ANGLE_DEFAULT_DEG} deg overhang threshold - ` +
  `the proven structure keeps ${(SA.ANGLE_DEFAULT_DEG - ST.BRANCH_TILT_DEG).toFixed(2)} deg in hand`);

console.log('\n=== 3. THE SAME OVERHANG, PUT THROUGH contactPoints() ===');

{
  /* The reference's own footprint, as a flat slab at the reference's own
     interface height. Not the reference's mesh - that is not in the file,
     only its toolpath is - but its dimensions, which is what the contact
     placement is a function of. */
  const host = slab(foot.w, foot.d, ifaceZ - plateZ, 4);
  const det = SA.detectOverhangs(host, { skipList: [], plateZ: 0 });
  const region = det.regions[0];
  check('the slab reads as one unsupported region of the reference\'s own area',
    det.ok && det.regions.length === 1 && within(region.areaMm2, foot.area, 0.01),
    `${region.areaMm2.toFixed(0)} mm^2 vs the interface's ${foot.area.toFixed(0)} mm^2`);

  const cp = ST.contactPoints(host, region, { skipList: [], maxContacts: 4096 });
  check('contactPoints covers it', cp.ok, cp.reason);
  console.log(`  this module: ${cp.points.length} contacts on a ${cp.latticeNx} x ` +
    `${cp.latticeNy} lattice at ${cp.pitchMm} mm`);
  console.log(`  the slicer:  ${tips.length} contact islands on the same footprint`);

  check('the contact count lands within 15% of what the real slice used',
    within(cp.points.length, tips.length, 0.15),
    `${cp.points.length} vs ${tips.length} - ` +
    `${(100 * (cp.points.length / tips.length - 1)).toFixed(1)}%`);

  /* Nearest-neighbour spacing is NOT the same statistic on the two sets and
     the comparison says so: a regular lattice's nearest neighbour IS its
     pitch, while an irregular point set's nearest neighbour sits below its
     areal pitch - the slicer's 451 tips have a 2.36 mm nearest neighbour and
     a 3.29 mm areal pitch. So the two are held within a stated band and the
     areal figure above is the one that is compared exactly. */
  check('nearest-neighbour spacing is the same order on both, lattice against field',
    cp.nnMm.median <= tipNN.max && cp.nnMm.median >= tipNN.median,
    `nn median ${cp.nnMm.median.toFixed(2)} mm on this lattice vs ` +
    `${tipNN.median.toFixed(2)} .. ${tipNN.max.toFixed(2)} mm across the slicer's field`);

  /* The whole tabletop, through the planner (nso_support_gridpack.js since
     the trunk-first planner was replaced). It no longer refuses for want of
     a trunk field: it grows one strut per contact and merges them pairwise,
     and the number of trunks that land on the plate is the number to put
     beside the slicer's 36. */
  const whole = ST.planTree(host, {
    skipList: [], plateZ: 0, bases: [{ kind: 'plate', z: 0 }], maxContacts: 4096
  });
  check('planTree holds the whole tabletop, every contact to the plate',
    whole.ok && whole.held === whole.beacons.length && whole.trunks.every(t => t.landing === 'plate'), whole.reason);
  console.log(`  this module lands ${whole.trunks.length} trunks; the real slice used ${trunks.length}`);
  check('the trunk count is the same order as the slicer\'s',
    whole.trunks.length >= trunks.length / 4 && whole.trunks.length <= trunks.length * 4,
    `${whole.trunks.length} vs ${trunks.length}`);
}

console.log('\n=== 4. ONE TRUNK\'S SHARE, PUT THROUGH planTree() ===');

{
  /* A patch of overhang the size of one reference trunk's own cell - the
     median spacing between trunks - carried at the reference's own height.
     This is the comparison the module is actually scoped to: one trunk, one
     fan, against one trunk's worth of the real structure. */
  const cellMm = trunkNN.median;
  const host = slab(cellMm, cellMm, ifaceZ - plateZ, 4);
  const p = ST.planTree(host, { skipList: [], plateZ: 0, bases: [{ kind: 'plate', z: 0 }] });
  /* The trunk-first planner built exactly one trunk here, by construction.
     The grid-pack planner merges pairwise only where the lean budget allows
     before the plate, so one reference trunk's share comes out as a few. */
  check('one trunk\'s share of the overhang is held, on a handful of trunks', p.ok && p.held === p.beacons.length &&
    p.trunks.length >= 1 && p.trunks.length <= 4, p.reason);

  const fanOut = tips.length / trunks.length;
  const ours = p.beacons.length;
  console.log(`  cell ${cellMm.toFixed(2)} x ${cellMm.toFixed(2)} mm at z ` +
    `${(ifaceZ - plateZ).toFixed(1)}: this module puts ${ours} contacts on it, merged into ${p.trunks.length} trunk(s)`);
  console.log(`  the real slice fans one trunk into ${fanOut.toFixed(2)} tips`);
  check('the fan-out is the same order as the reference\'s',
    ours >= fanOut / 2 && ours <= fanOut * 2,
    `${ours} vs ${fanOut.toFixed(2)}`);

  /* Where the members become one. The reference's trunk phase ends at its
     first split; here the last merge is where the trunk starts. Both are
     reported; the planner merges pairwise level by level, as the reference
     splits again and again on the way up. */
  const refFrac = (trunkTopZ - plateZ) / (ifaceZ - plateZ);
  const lastMerge = Math.min(...p.merges.map(m => m.z));
  const ourFrac = (lastMerge - plateZ) / (ifaceZ - plateZ);
  console.log(`  trunk height: ${(ourFrac * 100).toFixed(1)}% of the run here (the last merge), ` +
    `${(refFrac * 100).toFixed(1)}% at the reference's first split; ${p.merges.length} merges on the way down, ` +
    `the reference splits ${counts.length - last} times on the way up`);
  check('the trunk carries a real share of the height, as the reference\'s does',
    ourFrac > 0.05 && ourFrac < 0.95, `${(ourFrac * 100).toFixed(1)}%`);

  const maxHoriz = Math.max(...tips.map(t => {
    let b = Infinity;
    for (const s of trunks) {
      const d = Math.hypot(t[0] - s[0], t[1] - s[1]);
      if (d < b) b = d;
    }
    return b;
  }));
  /* Each contact's sideways travel to the foot of the trunk it lands on. */
  let ourHoriz = 0;
  for (const t of p.trunks) {
    const root = p.members[t.root], foot = root.path[root.path.length - 1];
    for (const id of t.beacons) ourHoriz = Math.max(ourHoriz, Math.hypot(p.beacons[id].p[0] - foot[0], p.beacons[id].p[1] - foot[1]));
  }
  check('no contact here is further sideways from its trunk than the reference\'s worst',
    ourHoriz <= maxHoriz + 1e-9,
    `${ourHoriz.toFixed(2)} mm here vs ${maxHoriz.toFixed(2)} mm there`);
}

console.log('\n=== 5. THE SECOND SLICE: an isolated interface with no trunk at all ===');

{
  /* fixtures/3mf/supportwithinsupport.gcode.3mf is the other real Bambu file
     in the repo, and it is the same pattern seen from the other end: two
     interface layers and no Support feature whatever. The lower one is a
     field of separate contact patches; the upper one is a single sheet lying
     on them. That is "isolated point contacts carrying one continuous
     interface" as a measurement rather than as a description. */
  const b2 = new Uint8Array(fs.readFileSync(
    path.join(ROOT, 'fixtures/3mf/supportwithinsupport.gcode.3mf')));
  const s2 = await G.readSlicedGcode3MF(b2);
  const sup2 = s2.parsed.moves.filter(m => m.length > 0 && /support/i.test(m.feature || ''));
  const z2 = [...new Set(sup2.map(m => m.z.toFixed(3)))].map(Number).sort((a, b) => a - b);
  check('it carries a support interface and no bulk support at all',
    sup2.length > 0 && sup2.every(m => /interface/i.test(m.feature)) && z2.length === 2,
    `${sup2.length} moves, all Support interface, on ${z2.length} layers at z ` +
    `${z2.join(' and ')}`);

  const lower = islands(sup2.filter(m => Math.abs(m.z - z2[0]) < 1e-6), 0.61 * 1.5);
  const upper = islands(sup2.filter(m => Math.abs(m.z - z2[1]) < 1e-6), 0.61 * 1.5);
  console.log(`  z ${z2[0]}: ${lower.length} separate contact patches`);
  console.log(`  z ${z2[1]}: ${upper.length} sheet(s) lying on them`);
  check('the first layer is many separate patches and the second is one sheet',
    lower.length > 5 && upper.length < lower.length / 5,
    `${lower.length} -> ${upper.length}`);

  const lowerPts = lower.map(centroid);
  const nn2 = nnStats(lowerPts);
  check('and those patches sit at a spacing this module\'s span is inside',
    ST.MAX_SPAN_MM <= nn2.max,
    `patch nn median ${nn2.median.toFixed(2)} max ${nn2.max.toFixed(2)} mm, ` +
    `span ${ST.MAX_SPAN_MM} mm`);
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }

})().catch(err => { console.error(err); process.exit(1); });
