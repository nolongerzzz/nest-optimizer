#!/usr/bin/env node
/* ============================================================
   tools/nso_support_footprint_check.js - the beacons' outline is the surface's own edge, and the supports built
   on it stay on the part.                                                          (npm run support:footprint)

   The ticket (the owner's, on the Supports card): "fix the supports generation beacons to reflect the actual
   perimeter of the model / contact surfaces so they don't stick over the edges and build odd interfaces". The
   card outlined an area as the edges of the grid cells its spots were found in, and a cell at the rim of a
   surface is mostly air: 41 % of the Base head's outlined cells lay over nothing, 61 % of Negative Sphere's. A spot
   found by the corner of such a cell stood on the very edge, so its cap and its sheet hung off the part.
   docs/SUPPORT-FOOTPRINT.md is the whole story. This is the gate:

   1. A FIXTURE WITH A KNOWN ANSWER: the tilted box of support:beacons (its underside, 30 deg off the plate). The
      footprint's area is the face's plan area (less the strip within 0.5 mm of the plate), its outline lies on the
      face's own edge to 0.03 mm, and neither the area nor the outline moves with the tessellation (2 / 200 / 2048
      triangles). Asked for a 1 mm inset, every spot stands 1 mm in, on the face, with the face's normal.
   2. THE SIX REAL HEADS (Bambu's own test parts, fixtures/supports/supp_ref.3mf), read against what Bambu laid
      under them (fixtures/supports/tree_slimsupports.gcode.3mf, its interface lines closed into a region, at
      Bambu's own 30 deg threshold): the footprint of Base, Oblique, Circular and Sphere is the area of Bambu's
      interface to 10 %, where the cells the card used to outline were 1.4 - 1.9 x too big (Base, Oblique,
      Circular). The Negative Spheres are findings: Bambu lays a second surface (the apex, docs/SUPPORT-ONE-TRUNK.md
      section 5) that detection does not find.
   3. THE BUILD, the card's one-trunk Auto (NSO_SupportGridpack with the sheet's perimeter on, spots 1 mm in), the geometry
      read as it stands: the flat faces of the sheet's stack and of the caps' tops under it lie under the part - outside
      the part's plan, no more than 12 % of them in all (the same build as it was: see the table), never more than 1.3 mm out.

     node tools/nso_support_footprint_check.js            all three
     node tools/nso_support_footprint_check.js --no-build   1 and 2 only (a few seconds)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RP = require('./nso_support_ref_pieces.js');
const SB = require(path.join(ROOT, 'nso_support_beacons.js'));
const AUDIT = require('./nso_slicer_audit.js');
const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
const args = process.argv.slice(2);
const BUILD = !args.includes('--no-build');
const REF_FILE = path.join(ROOT, 'fixtures', 'supports', 'tree_slimsupports.gcode.3mf');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);
const within = (got, want, frac) => Math.abs(got - want) <= Math.abs(want) * frac;

/* ---------------------------------------------------------------- geometry helpers */
function inLoop(x, y, L) {
  let inn = false;
  for (let q = 0, w = L.length - 1; q < L.length; w = q++) {
    if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
  }
  return inn;
}
function distToLoops(x, y, loops) {
  let best = Infinity;
  for (const L of loops) for (let q = 0; q < L.length; q++) {
    const u = L[q], v = L[(q + 1) % L.length], dx = v[0] - u[0], dy = v[1] - u[1], l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - u[0]) * dx + (y - u[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - u[0] - t * dx, y - u[1] - t * dy));
  }
  return best;
}
const loopsOf = det => [].concat(...det.regions.filter(R => R.footprint).map(R => R.footprint.loops));
const footArea = det => det.regions.reduce((a, R) => a + (R.footprint ? R.footprint.areaMm2 : 0), 0);
const cellArea = det => new Set(det.beacons.map(b => b.cell.join(','))).size * det.grid.pitch * det.grid.pitch;

/* the tilted box of support:beacons */
function subdividedBox(size, n, xf) {
  const P = (i, j, k) => xf([size[0] * i / n, size[1] * j / n, size[2] * k / n]);
  const out = [];
  const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
    quad(P(u, v, 0), P(u, v + 1, 0), P(u + 1, v + 1, 0), P(u + 1, v, 0));
    quad(P(u, v, n), P(u + 1, v, n), P(u + 1, v + 1, n), P(u, v + 1, n));
    quad(P(u, 0, v), P(u + 1, 0, v), P(u + 1, 0, v + 1), P(u, 0, v + 1));
    quad(P(u, n, v), P(u, n, v + 1), P(u + 1, n, v + 1), P(u + 1, n, v));
    quad(P(0, u, v), P(0, u, v + 1), P(0, u + 1, v + 1), P(0, u + 1, v));
    quad(P(n, u, v), P(n, u + 1, v), P(n, u + 1, v + 1), P(n, u, v + 1));
  }
  return new Float32Array(out);
}
const TILT = 30 * Math.PI / 180;
const tiltedBox = n => subdividedBox([40, 30, 10], n, p => [p[0] * Math.cos(TILT) - p[2] * Math.sin(TILT), p[1], p[0] * Math.sin(TILT) + p[2] * Math.cos(TILT)]);

/* ---------------------------------------------------------------- 1. the tilted box */
console.log('\n=== 1. the tilted box: the footprint is the face, at any tessellation ===');
{
  const X1 = 40 * Math.cos(TILT), X0 = 0.5 / Math.tan(TILT), W = X1 - X0, D = 30;     /* the face's plan, less the strip within 0.5 mm of the plate */
  const want = W * D, rect = [[[X0, 0], [X1, 0], [X1, D], [X0, D]]];
  let prev = null;
  for (const n of [1, 10, 32]) {
    const soup = tiltedBox(n), det = SB.detect(soup, { pitch: 3, angleDeg: 35, skipList: [], footprint: true });
    const loops = loopsOf(det), a = footArea(det);
    let worst = 0;
    loops.forEach(L => L.forEach(q => { worst = Math.max(worst, distToLoops(q[0], q[1], rect)); }));
    check(n * n * 12 + ' triangles: one outline, its area the face\'s (' + f1(want) + ' mm2) to 1 %', loops.length === 1 && within(a, want, 0.01), 'area ' + f1(a) + ' mm2, ' + loops.length + ' loop(s)');
    check('  ...and every vertex of it lies on the face\'s own edge (0.03 mm)', worst <= 0.03, 'worst ' + worst.toFixed(3) + ' mm');
    check('  ...where the grid\'s cells overstate it', cellArea(det) > a * 1.05, 'cells ' + f1(cellArea(det)) + ' mm2 = ' + f2(cellArea(det) / a) + ' x');
    if (prev != null) check('  ...the same area as at the last tessellation (0.3 %)', within(a, prev, 0.003), f2(a) + ' / ' + f2(prev));
    prev = a;
  }
  const soup = tiltedBox(10), d0 = SB.detect(soup, { pitch: 3, angleDeg: 35, skipList: [], footprint: true }), d1 = SB.detect(soup, { pitch: 3, angleDeg: 35, skipList: [], footprint: true, insetMm: 1 });
  check('a tilted face keeps its spots at the grid\'s own points, asked for the inset or not (its stair and its flat sheet\'s reach are laid on them)',
    d1.counts.moved === 0 && d1.beacons.every((b, i) => b.x === d0.beacons[i].x && b.y === d0.beacons[i].y && b.z === d0.beacons[i].z), d1.beacons.length + ' spots, 0 moved');
  check('inset 0 (the default) leaves every spot where the grid put it', d0.counts.moved === 0 && d0.beacons.every(b => !b.moved));
}

/* a FLAT area: a 20 x 14 x 3 cap on a 4 x 4 stem, 10 mm up - its underside is the cap less the stem's square */
console.log('\n=== 1b. a flat cap on a stem: the spots stand in from the edge, and from the stem ===');
{
  const cap = (() => {
    const v = [], quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
    const bx = (x0, y0, z0, x1, y1, z1) => {
      quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
      quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    };
    bx(8, 5, 0, 12, 9, 10); bx(0, 0, 10, 20, 14, 13);
    return new Float32Array(v);
  })();
  const d0 = SB.detect(cap, { pitch: 3, angleDeg: 35, skipList: [], footprint: true }), d1 = SB.detect(cap, { pitch: 3, angleDeg: 35, skipList: [], footprint: true, insetMm: 1 });
  const want = 20 * 14 - 16, outer = [[[0, 0], [20, 0], [20, 14], [0, 14]], [[8, 5], [12, 5], [12, 9], [8, 9]]];
  let worst = 0;
  loopsOf(d0).forEach(L => L.forEach(q => { worst = Math.max(worst, distToLoops(q[0], q[1], outer)); }));
  check('the footprint is the cap\'s underside less the stem (' + want + ' mm2) to 0.5 %: an outer loop and the stem\'s hole', within(footArea(d0), want, 0.005) && loopsOf(d0).length === 2,
    'area ' + f1(footArea(d0)) + ' mm2, ' + loopsOf(d0).length + ' loops');
  check('  ...every vertex of it on the cap\'s edge or the stem\'s (0.02 mm)', worst <= 0.02, 'worst ' + worst.toFixed(3) + ' mm');
  check('  ...where the grid\'s cells overstate it', cellArea(d0) > footArea(d0) * 1.03, 'cells ' + f1(cellArea(d0)) + ' mm2 = ' + f2(cellArea(d0) / footArea(d0)) + ' x');
  const edgeOf = b => distToLoops(b.x, b.y, outer);
  check('inset 1 mm: every spot stands 0.95 mm or more in from the edge and from the stem', d1.beacons.every(b => edgeOf(b) >= 0.95), 'nearest ' + f2(Math.min(...d1.beacons.map(edgeOf))) + ' mm (before ' + f2(Math.min(...d0.beacons.map(edgeOf))) + ')');
  check('  ...none lost or added, each on the underside (z = 10)', d1.beacons.length === d0.beacons.length && d1.beacons.every(b => Math.abs(b.z - 10) < 1e-6),
    d0.beacons.length + ' -> ' + d1.beacons.length + ' (' + d1.counts.moved + ' moved)');
  check('inset 0 (the default) leaves every spot where the grid put it', d0.counts.moved === 0 && d0.beacons.every(b => !b.moved));
}

/* ---------------------------------------------------------------- 2. the six real heads against Bambu's interface */
/* the region Bambu's interface and transition lines make: each line's samples grown 0.3 mm and the result shrunk by as much (a closing) */
async function bambuRegions() {
  const zip = R3.openZip(new Uint8Array(fs.readFileSync(REF_FILE)));
  const dec = new TextDecoder();
  const gcode = dec.decode(await zip.read(zip.names().find(n => /plate_\d+\.gcode$/.test(n))));
  const names = AUDIT.sliceNames(dec.decode(await zip.read('Metadata/slice_info.config')));
  const mv = AUDIT.extrusions(gcode), keyOf = {};
  RP.NAMES.forEach(k => { keyOf[RP.PROJECT_NAME[k]] = k; });
  const out = {};
  for (const id of Object.keys(names)) {
    const L = mv.filter(m => +m.obj === +id && /^Support (interface|transition)/.test(m.feat || ''));
    let lo = [1e9, 1e9], hi = [-1e9, -1e9];
    L.forEach(m => { lo = [Math.min(lo[0], m.x0, m.x1), Math.min(lo[1], m.y0, m.y1)]; hi = [Math.max(hi[0], m.x0, m.x1), Math.max(hi[1], m.y0, m.y1)]; });
    const st = 0.1, pad = 1, W = Math.ceil((hi[0] - lo[0] + 2 * pad) / st), H = Math.ceil((hi[1] - lo[1] + 2 * pad) / st), a = new Uint8Array(W * H);
    const disc = [];
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (Math.hypot(i, j) * st <= 0.3 + 1e-9) disc.push([i, j]);
    for (const m of L) {
      const n = Math.max(1, Math.ceil(Math.hypot(m.x1 - m.x0, m.y1 - m.y0) / 0.05));
      for (let q = 0; q <= n; q++) {
        const ci = Math.round((m.x0 + (m.x1 - m.x0) * q / n - lo[0] + pad) / st), cj = Math.round((m.y0 + (m.y1 - m.y0) * q / n - lo[1] + pad) / st);
        for (const [di, dj] of disc) { const i = ci + di, j = cj + dj; if (i >= 0 && j >= 0 && i < W && j < H) a[j * W + i] = 1; }
      }
    }
    let n = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!a[j * W + i]) continue;
      let ok = true;
      for (const [di, dj] of disc) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H || !a[jj * W + ii]) { ok = false; break; } }
      if (ok) n++;
    }
    out[keyOf[names[id]]] = n * st * st;
  }
  return out;
}

(async () => {
  console.log('\n=== 2. the six real heads: the footprint against Bambu\'s interface (its 30 deg threshold) ===');
  const bam = await bambuRegions(), heads = await RP.load(), rows = {};
  for (const k of RP.NAMES) {
    const det = SB.detect(heads[k], { pitch: 3, angleDeg: 30, skipList: [], footprint: true });
    rows[k] = { det, fp: footArea(det), cells: cellArea(det), bam: bam[k] };
    console.log('        ' + k.padEnd(11) + 'Bambu ' + f1(bam[k]).padStart(6) + ' mm2   footprint ' + f1(rows[k].fp).padStart(6) + ' (' + f2(rows[k].fp / bam[k]) + ' x)   the grid\'s cells ' + f1(rows[k].cells).padStart(6) + ' (' + f2(rows[k].cells / bam[k]) + ' x)');
  }
  for (const k of ['base', 'oblique', 'circular', 'sphere']) {
    check(k + ': the footprint is the area of what Bambu laid under it, 0.9 - 1.05 x (its lines run a hair inside the edge)', rows[k].fp / bam[k] >= 0.9 && rows[k].fp / bam[k] <= 1.05, f2(rows[k].fp / bam[k]) + ' x');
  }
  for (const k of ['base', 'oblique', 'circular']) {
    check(k + ': the cells the card outlined overstated it by 40 % or more (that is the fault)', rows[k].cells / rows[k].fp >= 1.4, f2(rows[k].cells / rows[k].fp) + ' x');
  }
  const signed = L => { let a = 0; for (let q = 0; q < L.length; q++) { const u = L[q], v = L[(q + 1) % L.length]; a += u[0] * v[1] - v[0] * u[1]; } return a / 2; };
  check('every head has an outline of closed loops, the surface on the left of travel (outer loops counter-clockwise, a hole clockwise: the signed areas sum to the area)',
    RP.NAMES.every(k => rows[k].det.regions.every(R => R.footprint && R.footprint.loops.length >= 1 && R.footprint.loops.every(L => L.length >= 3) &&
      Math.abs(R.footprint.loops.reduce((a, L) => a + signed(L), 0) - R.footprint.areaMm2) < 1e-6 && R.footprint.areaMm2 > 0)));
  /* turned: the area does not move with the pose (it is the surface's, not the grid's) */
  {
    const k = 'base', a0 = rows[k].fp, d = SB.detect(RP.pose(heads[k], 37, 0), { pitch: 3, angleDeg: 30, skipList: [], footprint: true });
    check('base turned 37 deg about the vertical: the same area (3 %)', within(footArea(d), a0, 0.03), f1(footArea(d)) + ' / ' + f1(a0));
  }
  /* the spots, kept in: an area of flat faces (Base, the Negative Spheres' rims) moves them in; one with a tilted or a curved face keeps them at the grid's points */
  const IN = 1;
  for (const k of RP.NAMES) {
    const det = SB.detect(heads[k], { pitch: 3, angleDeg: 35, skipList: [], footprint: true, insetMm: IN }), loops = loopsOf(det);
    const surface = det.beacons.filter(b => b.need.kind === 'face' || b.need.kind === 'gap' || (b.need.kind === 'edge' && b.need.corner));
    const clr = surface.map(b => distToLoops(b.x, b.y, loops)), least = Math.min(...clr);
    if (k === 'base') check(k + ': a flat area: every spot stands ' + IN + ' mm or more in from the edge of its surface (0.95)', least >= IN - 0.05, 'nearest ' + f2(least) + ' mm, ' + det.counts.moved + ' moved');
    else check(k + ': an area with a tilted or a curved face (a plane, a dome, a rim\'s chamfer): the spots stay where the grid put them (its stair / its flat sheet\'s reach are laid on them)', det.counts.moved === 0, det.counts.moved + ' moved');
  }

  if (!BUILD) { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

  /* ---------------------------------------------------------------- 3. the build */
  console.log('\n=== 3. the card\'s one-trunk Auto: the sheet lies under the part ===');
  const PE = require('./nso_supports_print_export.js');
  function under(soup, x, y, z0) {                              /* the part is over (x, y), above z0 */
    for (let i = 0; i < soup.length; i += 9) {
      if (Math.max(soup[i + 2], soup[i + 5], soup[i + 8]) < z0) continue;
      const ax = soup[i], ay = soup[i + 1], bx = soup[i + 3], by = soup[i + 4], cx = soup[i + 6], cy = soup[i + 7];
      const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / d, v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / d;
      if (u >= 0 && v >= 0 && u + v <= 1) return true;
    }
    return false;
  }
  /* the sheet's top faces (every level's), and how much of them lies outside the part's plan */
  function outside(piece, b) {
    const sup = b.objects[1].soup, zs = [...new Set([].concat(...b.areas.map(a => a.tp.sheet.levels.map(L => L.zTop.toFixed(2)))))].map(Number);
    let area = 0, out = 0, far = 0;
    for (const zt of zs) for (let i = 0; i < sup.length; i += 9) {
      /* the flat faces of the stack and of the caps' tops under it: the layers, and the discs a cap spreads below them (1.3 mm: the stack's five layers) */
      const z3 = [sup[i + 2], sup[i + 5], sup[i + 8]];
      if (Math.max(...z3) - Math.min(...z3) > 0.03 || z3[0] > zt + 0.03 || z3[0] < zt - 1.3) continue;
      const cx = (sup[i] + sup[i + 3] + sup[i + 6]) / 3, cy = (sup[i + 1] + sup[i + 4] + sup[i + 7]) / 3;
      const ar = Math.abs((sup[i + 3] - sup[i]) * (sup[i + 7] - sup[i + 1]) - (sup[i + 4] - sup[i + 1]) * (sup[i + 6] - sup[i])) / 2;
      area += ar;
      if (!under(piece, cx, cy, zt + 0.01)) {
        out += ar;
        /* how far out: the nearest of a ring of probes that is under the part */
        for (let r = 0.1; r <= 3; r += 0.1) { let hit = false; for (let a = 0; a < 16 && !hit; a++) hit = under(piece, cx + r * Math.cos(a * Math.PI / 8), cy + r * Math.sin(a * Math.PI / 8), zt + 0.01); if (hit) { far = Math.max(far, r); break; } }
      }
    }
    return { area, out, far };
  }
  let totA = 0, totO = 0, totA0 = 0, totO0 = 0, farMax = 0;
  const tipsIn = [];
  for (const k of RP.NAMES) {
    const piece = await RP.build(k);
    const b = await PE.build(piece, null, RP.PROJECT_NAME[k].replace(/\.stl$/, ''), true, false, true), b0 = await PE.build(piece, null, RP.PROJECT_NAME[k].replace(/\.stl$/, ''), true, false, false);
    const o = outside(piece, b), o0 = outside(piece, b0);
    totA += o.area; totO += o.out; totA0 += o0.area; totO0 += o0.out; farMax = Math.max(farMax, o.far);
    console.log('        ' + k.padEnd(11) + 'stack and caps ' + f1(o.area).padStart(6) + ' mm2, outside the part ' + f1(o.out).padStart(5) + ' (' + (o.area ? (100 * o.out / o.area).toFixed(0) : 0) + ' %), at most ' + f2(o.far) + ' mm out     before: ' +
      f1(o0.area).padStart(6) + ' mm2, ' + f1(o0.out).padStart(5) + ' out (' + (o0.area ? (100 * o0.out / o0.area).toFixed(0) : 0) + ' %)');
    const det = SB.detect(piece, { pitch: 3, angleDeg: 35, skipList: [], footprint: true, insetMm: 1 });
    for (const a of b.areas) for (const t of a.tp.sheet.tips) { if (t.mode === 'sheet') tipsIn.push(k); }
    void det;
  }
  check('the sheet lies under the part: no more than 12 % of its top outside the part\'s plan, over the six heads (before: ' + (100 * totO0 / totA0).toFixed(0) + ' %)', totO <= 0.12 * totA,
    f1(totO) + ' of ' + f1(totA) + ' mm2 = ' + (100 * totO / totA).toFixed(0) + ' %');
  check('...and where it is out, never more than 1.3 mm', farMax <= 1.3 + 1e-9, f2(farMax) + ' mm');
  check('...and a good deal less than the build without the outline', totO < 0.5 * totO0, f1(totO) + ' vs ' + f1(totO0) + ' mm2');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
