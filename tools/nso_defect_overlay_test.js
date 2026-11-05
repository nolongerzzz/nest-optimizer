/* The defect overlay's numbers and, more to the point, its COORDINATES.
 *
 * nso-defects.js exists so the viewport can paint the canonical checker's
 * findings on the mesh. That makes two things worth pinning, and the second is
 * the one a rendering bug hides behind:
 *
 *   1. the numbers are still the canonical numbers. `locate()` is held to
 *      `tools/mesh_validate.py --min-wall 0.42 [--non-solid]` on every STL in
 *      the repo - every count, every wall figure, the wall examples face for
 *      face, the piercing pairs pair for pair, and the verdict under both
 *      settings of the flag. This is the same contract
 *      tools/nso_selfint_equiv_test.js holds the self-intersection checker to,
 *      extended to the wall/gap pass, which had no browser copy before.
 *
 *   2. the marks are WHERE THE DEFECT IS. An overlay that renders something
 *      is not an overlay that works: a wrong sign in the raw -> display map, a
 *      stale index, a mark on the whole piece instead of the hole would all
 *      still draw. So every defect in the generated fixtures - whose exact
 *      coordinates tools/nso_open_make_fixtures.js and
 *      tools/nso_repair_make_fixtures.js put there on purpose - is checked
 *      against the marks BOTH ways: every mark must land inside the region the
 *      generator put the defect in, and (where the generator gives exact
 *      vertices) the marks must BE those vertices.
 *
 * The viewport side of it - that the marks come out on the piece, in the
 * piece's own space, through the real app - is tools/nso_defect_overlay_drive_check.js.
 *
 *   node tools/nso_defect_overlay_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readSTL } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');
const LIBDIR = require('./nso_library_dir');
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');

/* Load both browser scripts the way the page does: classic scripts that find a
   `window` and hang themselves off it, NSO_Repair first. Nothing node-specific
   is added to either for our benefit. */
function loadBrowser() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['NSO_Repair.js', 'nso-defects.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  if (!sandbox.window.NSO_Defects) throw new Error('nso-defects.js did not attach to window');
  return sandbox.window;
}
const W = loadBrowser();
const D = W.NSO_Defects;
const R = W.NSO_Repair;

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}
function eq(got, want, label) {
  ok(got === want, label + ' = ' + want, got !== want ? 'got ' + got + ', want ' + want : null);
}
function near(got, want, tol, label) {
  const good = (got == null && want == null) ||
               (got != null && want != null && Math.abs(got - want) <= tol);
  ok(good, label, good ? null : 'got ' + got + ', want ' + want + ' (+/- ' + tol + ')');
}

function stlsUnder(dir) {
  const out = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.stl')) out.push(p);
    }
  })(dir);
  return out.sort();
}
function pyValidate(file, extra) {
  const args = [MV, file, '--json', '--min-wall', '0.42'].concat(extra || []);
  return JSON.parse(execFileSync('python3', args, { maxBuffer: 1 << 28 }).toString());
}

/* ---- little geometry helpers over a flat xyz run ---- */

function pts(flat) {
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}
function bbox(flat) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts(flat)) for (let k = 0; k < 3; k++) {
    if (p[k] < lo[k]) lo[k] = p[k];
    if (p[k] > hi[k]) hi[k] = p[k];
  }
  return { lo: lo, hi: hi };
}
/* Every mark vertex inside `box` ([lo, hi] per axis). This is the assertion
   that a rendered-but-wrong overlay fails: paint the whole piece and the box
   test catches it immediately. */
function allInside(flat, box, label) {
  const bad = [];
  for (const p of pts(flat)) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < box[k][0] - 1e-4 || p[k] > box[k][1] + 1e-4) { bad.push(p); break; }
    }
  }
  ok(flat.length > 0 && bad.length === 0, label,
     flat.length === 0 ? 'nothing marked at all'
       : bad.length + ' of ' + (flat.length / 3) + ' mark vertices outside, e.g. ' + JSON.stringify(bad[0]));
}
function key(p) { return p.map(function (v) { return Math.round(v * 1e4) / 1e4; }).join(','); }
/* The exact set of segment endpoints, as unordered vertex keys. */
function segSet(flat) {
  const s = new Set();
  const P = pts(flat);
  for (let i = 0; i + 1 < P.length; i += 2) {
    const a = key(P[i]), b = key(P[i + 1]);
    s.add(a < b ? a + '|' + b : b + '|' + a);
  }
  return s;
}
function seg(a, b) {
  const ka = key(a), kb = key(b);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
}
function sameSet(got, want, label) {
  const missing = [].concat.apply([], Array.from(want).filter(function (x) { return !got.has(x); }));
  const extra = Array.from(got).filter(function (x) { return !want.has(x); });
  ok(missing.length === 0 && extra.length === 0, label,
     (missing.length ? 'missing ' + JSON.stringify(missing) : '') +
     (extra.length ? ' extra ' + JSON.stringify(extra) : ''));
}

/* ====================================================================== *
 * 1. the numbers are the canonical numbers, on every STL in the repo
 * ====================================================================== */

console.log('\n1. locate() vs tools/mesh_validate.py --min-wall 0.42, every fixture');
const files = [].concat(stlsUnder(path.join(ROOT, 'fixtures')), stlsUnder(path.join(ROOT, 'library')),
                        LIBDIR.extraStls());
if (!files.length) { console.log('  no STL fixtures found'); fail++; }
/* The catalog's pieces moved to nest-library; walk them from a checkout when
   there is one (nso_library_dir.js), and say so when there is not. */
if (!LIBDIR.libraryDir()) LIBDIR.skip('the catalog-only STLs in nest-library');

for (const f of files) {
  const rel = LIBDIR.labelOf(f);
  let soup;
  try { soup = readSTL(f); } catch (e) { console.log('  skip  ' + rel + ' (' + e.message + ')'); continue; }
  if (!soup.length) { console.log('  skip  ' + rel + ' (empty)'); continue; }

  const js = D.locate(soup, { minWall: 0.42 });
  const py = pyValidate(f);

  const gotCounts = [js.openEdges, js.nonManifoldEdges, js.flippedEdges, js.degenerateTris,
                     js.pierce, js.coplanar].join('/');
  const wantCounts = [py.open_edges, py.nonmanifold_edges, py.inconsistent_winding_edges,
                      py.degenerate_tris, py.self_intersection.pierce,
                      py.self_intersection.coplanar].join('/');
  ok(gotCounts === wantCounts,
     rel + ' — open/nm/winding/degen/pierce/coplanar ' + wantCounts,
     gotCounts !== wantCounts ? 'locate() ' + gotCounts + ', mesh_validate.py ' + wantCounts : null);

  const gotWall = [js.wall.facesMeasured, js.wall.thinFaces, js.wall.sheetFaces].join('/');
  const wantWall = [py.wall.faces_measured, py.wall.thin_faces, py.wall.sheet_faces].join('/');
  ok(gotWall === wantWall, rel + ' — wall measured/thin/sheet ' + wantWall,
     gotWall !== wantWall ? 'locate() ' + gotWall + ', mesh_validate.py ' + wantWall : null);
  near(js.wall.minWallMm, py.wall.min_wall_mm, 1e-9, rel + ' — thinnest wall ' + py.wall.min_wall_mm);

  /* The validator keeps 8 examples; locate() keeps every thin face because
     every thin face gets painted. The first 8 must be the same 8, face index
     and millimetre both - that is the localisation agreeing, not just the
     count. */
  const gotEx = JSON.stringify(js.wall.faces.slice(0, 8).map(function (x) {
    return { face: x.face, hit: x.hit, mm: Math.round(x.mm * 1e5) / 1e5 };
  }));
  const wantEx = JSON.stringify(py.wall.examples);
  ok(gotEx === wantEx, rel + ' — wall examples, face for face',
     gotEx !== wantEx ? 'locate() ' + gotEx + '\n          mesh_validate.py ' + wantEx : null);

  /* Same for the piercing pairs, wherever the validator reported them all.
     As a SET of unordered pairs: a BVH self-traversal and a uniform hash visit
     the same pairs in a different order and from different sides, which is a
     property of the broad phase and not of the policy (NSO_Repair.js: "a
     uniform hash and a BVH are both conservative supersets feeding the same
     exact narrow-phase test"). WHICH faces pierce WHICH is the part that has
     to agree, and is what the overlay paints. */
  if (py.self_intersection.pierce + py.self_intersection.coplanar <= 8) {   // the validator's example cap
    const norm = function (list) {
      return list.map(function (e) { return Math.min(e.a, e.b) + '-' + Math.max(e.a, e.b); }).sort().join(' ');
    };
    const gotP = norm(js.piercePairs);
    const wantP = norm(py.self_intersection.examples.filter(function (e) { return e.kind === 'pierce'; }));
    ok(gotP === wantP, rel + ' — piercing pairs, pair for pair (' + py.self_intersection.pierce + ')',
       gotP !== wantP ? 'locate() ' + gotP + '\n          mesh_validate.py ' + wantP : null);
  }

  /* The verdict, under both settings of the flag it is the only consumer of.
     The flag-off run is the one already taken above - --non-solid only changes
     the verdict, so the measurements do not need taking twice. */
  for (const flag of [false, true]) {
    const jsv = flag ? D.locate(soup, { minWall: 0.42, nonSolid: true }) : js;
    const pyv = flag ? pyValidate(f, ['--non-solid']) : py;
    ok(jsv.verdict === pyv.verdict,
       rel + ' — verdict' + (flag ? ' (non-solid)' : '') + ' ' + pyv.verdict,
       jsv.verdict !== pyv.verdict ? 'locate() ' + jsv.verdict + ' ' + JSON.stringify(jsv.fails) +
         ', mesh_validate.py ' + pyv.verdict + ' ' + JSON.stringify(pyv.verdict_fails) : null);
    eq(jsv.fails.length, pyv.verdict_fails.length,
       rel + ' — failing checks' + (flag ? ' (non-solid)' : ''));
  }

  /* One mark per finding, always. An edge that is counted and not drawn, or
     drawn twice, is the bug this catches before anyone looks at a screen. */
  eq(js.marks.openEdges.length / 6, js.openEdges, rel + ' — open-edge segments drawn');
  eq(js.marks.nonManifoldEdges.length / 6, js.nonManifoldEdges, rel + ' — non-manifold segments drawn');
}

/* ====================================================================== *
 * 2. the divergence from NSO_Repair.analyze() is the documented one
 * ====================================================================== */

/* locate() takes the VALIDATOR's degenerate and winding definitions, not
   analyze()'s, and nso-defects.js says why at degenerateRaw(). That is a
   deliberate difference between two live implementations, so it is pinned from
   both ends: if someone "fixes" either side, this section says so instead of
   the difference quietly becoming something else. */
console.log('\n2. the two numbers that are deliberately not NSO_Repair.analyze()\'s');
{
  const tape = readSTL(path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
  const an = R.inspect(tape, { selfIntersections: false });
  const lo = D.locate(tape, { minWall: 0 });
  eq(an.degenerateTris, 297, 'tape — analyze() degenerate, on the WELDED mesh');
  eq(lo.degenerateTris, 0, 'tape — locate() degenerate, on the RAW soup (the validator\'s)');

  const dup = readSTL(path.join(ROOT, 'fixtures', 'repair', 'synth_dup_exact.stl'));
  const an2 = R.inspect(dup, { selfIntersections: false });
  const lo2 = D.locate(dup, { minWall: 0 });
  eq(an2.flippedEdges, 0, 'synth_dup_exact — analyze() winding, undirected, nm edges excluded');
  eq(lo2.flippedEdges, 3, 'synth_dup_exact — locate() winding, directed reuse (the validator\'s)');
}

/* ====================================================================== *
 * 3. the marks are where the generator put the defect
 * ====================================================================== */

console.log('\n3. open edges land on the boundary, not on the piece');
{
  /* open_clip is one rectangular sheet, so its whole boundary is the four
     edges of the (u, v) rectangle: y = +/-10 down both sides, and the two rim
     ends at z = 12. Nothing else on the clip may be red. */
  const r = D.locate(readSTL(path.join(ROOT, 'fixtures/open/open_clip.stl')), { minWall: 0 });
  eq(r.openEdges, 50, 'open_clip — open edges');
  const off = pts(r.marks.openEdges).filter(function (p) {
    return Math.abs(Math.abs(p[1]) - 10) > 1e-3 && Math.abs(p[2] - 12) > 1e-3;
  });
  ok(off.length === 0, 'open_clip — every red endpoint is on the sheet\'s boundary (|y| = 10 or z = 12)',
     off.length ? off.length + ' off it, e.g. ' + JSON.stringify(off[0]) : null);

  /* The cup's two open rims are both at the top, and only there: an overlay
     that painted the whole cup, or the bottom, fails on one number. */
  const c = D.locate(readSTL(path.join(ROOT, 'fixtures/open/thin_shell_cup.stl')), { minWall: 0 });
  eq(c.openEdges, 96, 'thin_shell_cup — open edges (two rims of 48)');
  allInside(c.marks.openEdges, [[-15, 15], [-15, 15], [25 - 1e-3, 25 + 1e-3]],
            'thin_shell_cup — every red endpoint is on the rim plane z = 25');

  /* synth_hole is cube20 with triangle 0 (A, D, C) deleted. The hole is those
     three edges and nothing else, so here the marks are checked as an exact
     set of segments rather than as a region. */
  const h = D.locate(readSTL(path.join(ROOT, 'fixtures/repair/synth_hole.stl')), { minWall: 0 });
  eq(h.openEdges, 3, 'synth_hole — open edges');
  const A = [-10, -10, -10], Dd = [-10, 10, -10], C = [10, 10, -10];
  sameSet(segSet(h.marks.openEdges), new Set([seg(A, Dd), seg(Dd, C), seg(C, A)]),
          'synth_hole — the three red segments ARE the deleted triangle\'s edges');
}

console.log('\n4. non-manifold edges land on the seam, not on the shell');
{
  /* synth_flap hangs one triangle off cube edge F-G. F-G becomes a 3-use edge
     (orange) and the flap's own two free edges become open (red). */
  const F = [10, -10, 10], G = [10, 10, 10], TIP = [18, 0, 18];
  const r = D.locate(readSTL(path.join(ROOT, 'fixtures/repair/synth_flap.stl')), { minWall: 0 });
  eq(r.nonManifoldEdges, 1, 'synth_flap — non-manifold edges');
  sameSet(segSet(r.marks.nonManifoldEdges), new Set([seg(F, G)]),
          'synth_flap — the one orange segment IS cube edge F-G');
  eq(r.openEdges, 2, 'synth_flap — open edges (the flap\'s two free sides)');
  sameSet(segSet(r.marks.openEdges), new Set([seg(F, TIP), seg(G, TIP)]),
          'synth_flap — the two red segments ARE the flap\'s free sides');
}

console.log('\n5. piercing pairs land on the thing that pierces');
{
  /* A fin standing through the clip\'s floor at x 1.3..3.3, y 0.7, z -3..3, on
     a sheet that runs x -8..8 by y -10..10. Everything red must be within a
     couple of millimetres of that fin - the fin\'s own two triangles and the
     floor triangles it crosses - and nothing at the far end of the clip. */
  const r = D.locate(readSTL(path.join(ROOT, 'fixtures/open/open_clip_selfint.stl')), { minWall: 0 });
  eq(r.pierce, 4, 'open_clip_selfint — piercing pairs');
  allInside(r.marks.pierceTris, [[-1, 5], [-3, 3], [-3.1, 3.1]],
            'open_clip_selfint — every red triangle is at the fin, not elsewhere on the clip');
  ok(bbox(r.marks.pierceTris).hi[0] <= 4.001,
     'open_clip_selfint — nothing red past the fin\'s own end of the floor');

  /* The cup\'s fin sits at 3.75 degrees, radius 12..18, z 10..14, and crosses
     both walls. Red must be on that side of the cup only: x positive, y just
     above zero, and in the two wall rings the fin crosses. */
  const c = D.locate(readSTL(path.join(ROOT, 'fixtures/open/thin_shell_cup_selfint.stl')), { minWall: 0 });
  eq(c.pierce, 7, 'thin_shell_cup_selfint — piercing pairs');
  allInside(c.marks.pierceTris, [[11.9, 18.1], [-0.1, 2.1], [5.9, 15.5]],
            'thin_shell_cup_selfint — every red triangle is at the fin, on one side of the cup');

  /* One weft of the weave (j = 2, so y = 6, ribbon y 5.4..6.6) is woven at the
     wrong height and goes THROUGH the warps. Red must be on that weft and the
     warp crossings it passes, and on no other strand - there are nine others. */
  const w = D.locate(readSTL(path.join(ROOT, 'fixtures/open/fabric_weave_selfint.stl')), { minWall: 0 });
  eq(w.pierce, 52, 'fabric_weave_selfint — piercing pairs');
  allInside(w.marks.pierceTris, [[-1, 13], [5.2, 6.8], [-0.9, 0.9]],
            'fabric_weave_selfint — every red triangle is on the bad weft, none on the other nine strands');
}

console.log('\n6. thin walls land on the thin patch, not on the wall that is fine');
{
  /* thin_shell_cup_thin dents ONE patch of the inner wall out to 0.25 mm:
     the angular band 90..150 degrees, rings 2..4 (z 5.96..20.24). The rest of
     the cup is a healthy 1.2 mm and must stay unpainted, which is the whole
     point of the check - a wall overlay that lights up the whole cup has told
     you nothing. */
  const r = D.locate(readSTL(path.join(ROOT, 'fixtures/open/thin_shell_cup_thin.stl')), { minWall: 0.42 });
  eq(r.wall.thinFaces, 96, 'thin_shell_cup_thin — thin faces');
  near(r.wall.minWallMm, 0.2494645, 1e-6, 'thin_shell_cup_thin — thinnest wall 0.2495 mm (the 0.25 mm dent)');
  ok(r.marks.thinTris.length / 9 > 0, 'thin_shell_cup_thin — something violet is drawn');

  const P = pts(r.marks.thinTris);
  const outOfBand = P.filter(function (p) {
    let deg = Math.atan2(p[1], p[0]) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    // 1e-6 of slack on the band edges: the corners are sampled exactly at 90
    // and 150 and float32 lands a hair either side.
    return deg < 90 - 1e-5 || deg > 150 + 1e-5;
  });
  ok(outOfBand.length === 0,
     'thin_shell_cup_thin — every violet vertex is inside the dented band, 90° to 150°',
     outOfBand.length ? outOfBand.length + ' outside, e.g. ' + JSON.stringify(outOfBand[0]) : null);
  const zb = bbox(r.marks.thinTris);
  ok(zb.lo[2] >= 5 - 1e-3 && zb.hi[2] <= 20.24 + 1e-3,
     'thin_shell_cup_thin — violet stops at the dented rings, z 5 to 20.24',
     'got z ' + zb.lo[2] + ' .. ' + zb.hi[2]);
  /* Both sides of the wall, not one skin: the dented inner faces sit at
     r = 14.75 and the outer faces they measure against at r = 15. */
  let sawInner = false, sawOuter = false;
  for (const p of P) {
    const rad = Math.hypot(p[0], p[1]);
    if (Math.abs(rad - 14.75) < 1e-3) sawInner = true;
    if (Math.abs(rad - 15) < 1e-3) sawOuter = true;
  }
  ok(sawInner && sawOuter,
     'thin_shell_cup_thin — both faces of the thin wall are painted, inner r=14.75 and outer r=15',
     'inner ' + sawInner + ', outer ' + sawOuter);

  /* The same cup at its designed 1.2 mm wall is clean, and nothing is painted.
     Without this the band assertion above would pass on a check that paints
     any cup. */
  const good = D.locate(readSTL(path.join(ROOT, 'fixtures/open/thin_shell_cup.stl')), { minWall: 0.42 });
  eq(good.wall.thinFaces, 0, 'thin_shell_cup — thin faces at the same threshold');
  eq(good.marks.thinTris.length, 0, 'thin_shell_cup — nothing violet on the healthy 1.2 mm wall');
  near(good.wall.minWallMm, 1.1972, 1e-3, 'thin_shell_cup — measured wall');

  /* And the threshold is a threshold: raise it past the healthy wall and the
     same cup does light up. A check that can never fire is not a check. */
  const raised = D.locate(readSTL(path.join(ROOT, 'fixtures/open/thin_shell_cup.stl')), { minWall: 2 });
  ok(raised.wall.thinFaces > 0 && raised.marks.thinTris.length > 0,
     'thin_shell_cup — at a 2 mm floor the 1.2 mm wall does light up (' + raised.wall.thinFaces + ' faces)');
}

console.log('\n7. a clean piece paints nothing');
{
  const r = D.locate(readSTL(path.join(ROOT, 'fixtures/box-20mm.stl')), { minWall: 0.42 });
  eq(r.verdict, 'PASS', 'box-20mm — verdict');
  eq(r.marks.openEdges.length + r.marks.nonManifoldEdges.length +
     r.marks.pierceTris.length + r.marks.thinTris.length, 0,
     'box-20mm — total mark vertices on a clean closed box');
}

console.log('\n8. the flag changes the verdict and nothing else');
{
  /* docs/NON-SOLID.md section 3: the flag lifts the open-edge FAILURE and no
     measurement. The clip still has its 50 open edges and they are still
     drawn - the user still wants to see where the piece is open - they just
     stop being a fault. */
  const soup = readSTL(path.join(ROOT, 'fixtures/open/open_clip.stl'));
  const off = D.locate(soup, { minWall: 0.42, nonSolid: false });
  const on = D.locate(soup, { minWall: 0.42, nonSolid: true });
  eq(off.verdict, 'FAIL', 'open_clip — verdict with the flag off');
  eq(on.verdict, 'PASS', 'open_clip — verdict with the flag on');
  eq(on.openEdges, off.openEdges, 'open_clip — open edges measured, flag on');
  eq(on.marks.openEdges.length, off.marks.openEdges.length,
     'open_clip — open edges still drawn with the flag on (mark floats)');

  /* And it lifts ONLY that one. The defective clip fails either way. */
  const bad = readSTL(path.join(ROOT, 'fixtures/open/open_clip_selfint.stl'));
  eq(D.locate(bad, { minWall: 0.42, nonSolid: true }).verdict, 'FAIL',
     'open_clip_selfint — the flag does not hide the fin');
  const thin = readSTL(path.join(ROOT, 'fixtures/open/thin_shell_cup_thin.stl'));
  eq(D.locate(thin, { minWall: 0.42, nonSolid: true }).verdict, 'FAIL',
     'thin_shell_cup_thin — the flag does not hide the thin wall');
}

console.log('\n----------------------------------------------------------');
console.log(pass + ' passed, ' + fail + ' failed');
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
