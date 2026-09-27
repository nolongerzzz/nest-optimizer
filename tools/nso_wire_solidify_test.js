/* Solidify, driven through the REAL button, measured by the CANONICAL checker.

   The bug this pins: library/v9_mirror_factory.stl is exact-vertex clean
   (every edge shared by exactly 2 faces, consistent winding, 0 degenerate),
   and one click of Solidify, with nothing else run first, turned it into
   31,199 triangles out of 49,026 with 35 open / 55 non-manifold / 69
   degenerate by tools/mesh_validate.py - under a status line that said
   "Solidify ok". The hole fill was not the culprit (there were no holes);
   the two coarse grid-snap welds were (0.2 mm in Solidify, 0.3 mm inside
   repairJoinedSoup). See the comment above solidifySelectedModel().

   The tradeoff that fix left standing, and this file now also pins: those
   same two coarse welds are also what closes a genuine seam gap wider than
   exact-vertex (two parts meant to register but off by a fraction of a
   millimetre) - so gating on them meant Solidify correctly REFUSED a
   fine-detail piece with a real, trivially-closable hole rather than risk
   that damage, and a real hole went unrepaired. solidifySelectedModel now
   tries an exact-vertex tier first - weld, cap, cap, weld, close-loops, with
   repairJoinedSoup left out entirely (it filters degenerate/duplicate faces
   and drops small disjoint shells on its own, blind to weld tolerance, which
   is its own risk on a piece with many small legitimate features) - and only
   escalates to the coarse tier, the original pipeline unchanged, when the
   tight pass makes no progress. Section 2 is the fine-detail repair this
   unblocks; section 2b is the genuine-gap case the coarse tier still exists
   for, and confirms it still works.

   Every number gated here comes from tools/mesh_validate.py and
   tools/stl_watertight_check.py, run as subprocesses on the soup the app
   actually holds before and after the click - never from the app's own
   status line or counters. The status line is then checked against them.

     1. clean piece: Solidify leaves it bit-identical and says so.
     2. clean piece with one face knocked out: a fine-detail hole whose own
        boundary is already exact-vertex. The exact-vertex tier closes it
        with exactly the one triangle it needs - nothing else invented,
        nothing dropped, no collateral non-manifold - where the coarse-only
        pipeline would refuse it (proven directly, ungated, alongside).
     2b. two halves of a tube, registered a fraction of a millimetre apart at
        their seam: the real case the coarse weld exists for. Too long a
        loop for either capper, so the exact-vertex tier makes no progress
        and Solidify escalates - the coarse weld snaps the seam back
        together and the result is the one solid tube, volume included.
     3. a box with its top missing: a job Solidify can do. It commits, the
        canonical checker passes the result, the status numbers match it,
        and Undo puts the open box back.

     4. driver-testing round 1 (fixtures/damage/shape-cylinder_holes-light.stl):
        a loop pinched at the cap centre and a loop folded over the top rim
        onto the wall, which the bbox-plane cappers cannot close -
        solidifyCloseLoops does, the checker passes it, and the volume is
        the clean cylinder's.
     5. a tilted open tube nothing can close: the progress gate refuses
        rather than committing an unchanged piece as "Solidify ok".
     6. fixtures/damage/shape-sphere_holes-shredded.stl: fewer open edges
        bought with mis-wound ones is refused - winding is in the result gate.

   node tools/nso_wire_solidify_test.js        exit 0 = every gate held */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-solidify-'));
let seq = 0;

/* The canonical checker on a soup: mesh_validate.py at its default weld
   (1e-4 mm, the one NSO_Repair.WELD_TOL transcribes) plus the exact-vertex
   census from stl_watertight_check.py - the "all edges shared by 2" figure. */
function canonical(soup, tag) {
  const f = path.join(TMP, (seq++) + '-' + tag + '.stl');
  writeSTL(f, soup);
  const mv = JSON.parse(execFileSync('python3',
    [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--no-selfint', '--json'], { encoding: 'utf8' }));
  let wt;
  try {
    wt = execFileSync('python3', [path.join(ROOT, 'tools', 'stl_watertight_check.py'), f, '--odd', '--degen'],
                      { encoding: 'utf8' });
  } catch (e) { wt = e.stdout; }
  const num = re => { const m = wt.match(re); return m ? +m[1] : null; };
  return {
    tris: mv.triangles, open: mv.open_edges, nm: mv.nonmanifold_edges,
    wind: mv.inconsistent_winding_edges, degen: mv.degenerate_tris, verdict: mv.verdict,
    exact: { open: num(/open_edges\(count=1\) (\d+)/), nm: num(/nonmanifold_edges\(count>2\) (\d+)/),
             degen: num(/degenerate_tris (\d+)/) }
  };
}
const fmt = c => c.tris + ' tris, open ' + c.open + ', NM ' + c.nm + ', wind ' + c.wind +
                 ', degen ' + c.degen + ' | exact open ' + c.exact.open + ', NM ' + c.exact.nm;

const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris)).then(a => new Float32Array(a));
const sameSoup = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function solidify(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-solidify');
  await page.waitForFunction(() => /Solidify/.test(document.getElementById('status').textContent),
                             null, { timeout: 120000 });
  return statusOf(page);
}

async function load(page, file) {
  const id = await loadSTL(page, file);
  await selectModel(page, id);
  return id;
}

withApp(async (page, logs) => {
  await page.evaluate(() => {
    const b = document.getElementById('btn-solidify');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
  });

  console.log('\n=== 1. a clean piece is left exactly as it is ===');
  const factory = path.join(ROOT, 'library', 'v9_mirror_factory.stl');
  await load(page, factory);
  const s1 = await soupOf(page);
  const c1 = canonical(s1, 'factory-before');
  console.log('   before  ' + fmt(c1));
  check('precondition: the input is exact-vertex clean by the canonical census',
        c1.exact.open === 0 && c1.exact.nm === 0 && c1.exact.degen === 0 && c1.open === 0);
  const st1 = await solidify(page);
  const s1b = await soupOf(page);
  const c1b = canonical(s1b, 'factory-after');
  console.log('   after   ' + fmt(c1b));
  console.log('   status: ' + st1);
  check('the soup the app holds is bit-identical after Solidify', sameSoup(s1, s1b),
        s1.length / 9 + ' -> ' + s1b.length / 9 + ' tris');
  check('canonical: non-manifold did not rise', c1b.nm <= c1.nm && c1b.exact.nm <= c1.exact.nm,
        'NM ' + c1.nm + '->' + c1b.nm + ', exact ' + c1.exact.nm + '->' + c1b.exact.nm);
  check('canonical: open edges did not rise', c1b.open <= c1.open && c1b.exact.open <= c1.exact.open);
  check('the status says nothing was done, not "Solidify ok"',
        /already closed/.test(st1) && !/Solidify ok/.test(st1), st1);

  console.log('\n=== 2. one face knocked out: the exact-vertex tier closes it, no collateral damage ===');
  const holed = s1.slice(9);                       // drop the first triangle: 3 open edges
  const holedFile = path.join(TMP, 'factory-holed.stl');
  writeSTL(holedFile, holed);
  await load(page, holedFile);
  const s2 = await soupOf(page);
  const c2 = canonical(s2, 'holed-before');
  console.log('   before  ' + fmt(c2));
  check('precondition: exactly the one opening, nothing non-manifold',
        c2.exact.open === 3 && c2.exact.nm === 0, 'exact open ' + c2.exact.open);
  // What the COARSE-ONLY pipeline would produce if that were the only tier -
  // the same stages the original single-tolerance pipeline always ran,
  // called directly, so the fix is shown to be protecting against a real
  // regression rather than a vacuous one, and the coarse tier is shown to
  // still be exactly as risky on this piece as it always was.
  const raw = new Float32Array(await page.evaluate(() => {
    let w = getActiveModel().rawTris;
    w = weldSoupVerts(w); w = capSmallOpenLoops(w, 28); w = capAllOuterHoles(w);
    w = repairJoinedSoup(w); w = weldSoupVerts(w);
    return Array.from(w);
  }));
  const c2raw = canonical(raw, 'holed-ungated');
  console.log('   coarse-only (not what Solidify runs) ' + fmt(c2raw));
  check('the coarse-only pipeline really does raise non-manifold edges on this piece',
        c2raw.nm > c2.nm, 'NM ' + c2.nm + ' -> ' + c2raw.nm);
  const st2 = await solidify(page);
  const s2b = await soupOf(page);
  const c2b = canonical(s2b, 'holed-after');
  console.log('   after   ' + fmt(c2b));
  console.log('   status: ' + st2);
  check('Solidify committed and said ok', /Solidify ok/.test(st2) && !/Solidify refused/.test(st2), st2);
  check('...closing the one opening', /open 3→0/.test(st2), st2);
  check('...with non-manifold unchanged, not the coarse pipeline\'s rise', /NM 2→2/.test(st2), st2);
  check('nothing invented or dropped beyond the one face: 49025 -> 49026 tris',
        c2.tris === 49025 && c2b.tris === 49026, c2.tris + ' -> ' + c2b.tris);
  check('canonical: non-manifold did not rise', c2b.nm <= c2.nm && c2b.exact.nm <= c2.exact.nm,
        'NM ' + c2.nm + '->' + c2b.nm + ', exact ' + c2.exact.nm + '->' + c2b.exact.nm);
  check('canonical: open edges closed', c2b.open === 0 && c2b.exact.open === 0);
  check('it went on the undo stack once',
        await page.evaluate(() => (state.undoStack || []).filter(u => u && u.type === 'solidifyReplace').length) === 1);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
                             null, { timeout: 30000 });
  check('Undo puts the hole back', sameSoup(s2, await soupOf(page)));

  console.log('\n=== 2b. two tube halves registered a fraction of a mm apart at the seam ===');
  // The real case the coarse weld exists for: two parts meant to meet at a
  // seam, off by less than the coarse tolerance (0.05 mm here, well under
  // the 0.2 mm grid) - the kind of registration error a part exported in two
  // pieces, or reprinted and rejoined, actually has. Each half's own rim sits
  // exactly on a 0.2 mm grid so the shift lands every vertex pair in the same
  // grid cell regardless of its angle around the seam - deterministic, not
  // a coin flip on which side of a rounding boundary a given vertex falls.
  // 80 segments per rim: too long for capSmallOpenLoops (span > 28 mm) and
  // too long for solidifyCloseLoops (> the 64-edge cap) either, and circular
  // enough (Q well above the 0.72 cutoff) that capAllOuterHoles's shape test
  // would not have filled it even if the seam sat on an outer bbox plane, so
  // only a weld that actually reunites the two rims can close it at all.
  function seamTube(SEG, RAD, Hb, Ht, dx, dy, GRID) {
    const snap = v => Math.round(v / GRID) * GRID;
    const tris = [];
    const push3 = (A, B, C) => { tris.push(...A, ...B, ...C); };
    const ang = i => 2 * Math.PI * i / SEG;
    const rim = (i, ox, oy) => [snap(RAD * Math.cos(ang(i))) + ox, snap(RAD * Math.sin(ang(i))) + oy];
    const bc = [0, 0, 0];
    for (let i = 0; i < SEG; i++) {
      const r0 = rim(i, 0, 0), r1 = rim(i + 1, 0, 0);
      const p00 = [r0[0], r0[1], 0], p10 = [r1[0], r1[1], 0];
      const p01 = [r0[0], r0[1], Hb], p11 = [r1[0], r1[1], Hb];
      push3(p00, p10, p11); push3(p00, p11, p01); push3(p10, p00, bc);
    }
    const tc = [dx, dy, Hb + Ht];
    for (let i = 0; i < SEG; i++) {
      const r0 = rim(i, dx, dy), r1 = rim(i + 1, dx, dy);
      const p00 = [r0[0], r0[1], Hb], p10 = [r1[0], r1[1], Hb];
      const p01 = [r0[0], r0[1], Hb + Ht], p11 = [r1[0], r1[1], Hb + Ht];
      push3(p00, p10, p11); push3(p00, p11, p01); push3(p01, p11, tc);
    }
    return new Float32Array(tris);
  }
  const seamSoup = seamTube(80, 20, 10, 10, 0.05, 0.05, 0.2);
  const seamFile = path.join(TMP, 'seam-tube.stl');
  writeSTL(seamFile, seamSoup);
  await load(page, seamFile);
  const s2c = await soupOf(page);
  const c2c = canonical(s2c, 'seam-before');
  console.log('   before  ' + fmt(c2c));
  check('precondition: two 80-edge rims, exact-vertex clean otherwise',
        c2c.exact.open === 160 && c2c.exact.nm === 0 && c2c.wind === 0, 'exact open ' + c2c.exact.open);
  const st2c = await solidify(page);
  const s2cb = await soupOf(page);
  const c2cb = canonical(s2cb, 'seam-after');
  console.log('   after   ' + fmt(c2cb));
  console.log('   status: ' + st2c);
  check('Solidify committed and said ok', /Solidify ok/.test(st2c) && !/Solidify refused/.test(st2c), st2c);
  check('THE CANONICAL CHECKER PASSES THE RESULT',
        c2cb.verdict === 'PASS' && c2cb.open === 0 && c2cb.nm === 0 && c2cb.wind === 0, c2cb.verdict);
  check('...and by the exact census too', c2cb.exact.open === 0 && c2cb.exact.nm === 0 && c2cb.exact.degen === 0);
  check('nothing invented: the seam only had to be rejoined, tris unchanged',
        c2cb.tris === c2c.tris, c2c.tris + ' -> ' + c2cb.tris);
  const seamAfterFile = path.join(TMP, 'seam-after-full.stl');
  writeSTL(seamAfterFile, s2cb);
  const v2cb = JSON.parse(execFileSync('python3',
    [path.join(ROOT, 'tools', 'mesh_validate.py'), seamAfterFile, '--json'], { encoding: 'utf8' }));
  console.log('   volume  ' + v2cb.signed_volume.toFixed(2) + ' mm3 (one solid tube, R 20, H 20)');
  check('volume matches one unsplit tube (within 0.5%)',
        Math.abs(v2cb.signed_volume - Math.PI * 20 * 20 * 20) <= 0.005 * Math.PI * 20 * 20 * 20,
        v2cb.signed_volume.toFixed(2));
  check('it went on the undo stack once',
        await page.evaluate(() => (state.undoStack || []).filter(u => u && u.type === 'solidifyReplace').length) === 1);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
                             null, { timeout: 30000 });
  check('Undo puts the seam gap back', sameSoup(s2c, await soupOf(page)));

  console.log('\n=== 3. a box with its top missing: Solidify closes it ===');
  const box = readSTL(path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  const boxSoup = box.rawTris || box;
  // Drop the two faces whose three corners all sit on the top plane.
  let zMax = -Infinity;
  for (let i = 2; i < boxSoup.length; i += 3) zMax = Math.max(zMax, boxSoup[i]);
  const keep = [];
  for (let t = 0; t < boxSoup.length / 9; t++) {
    const o = t * 9;
    const top = [2, 5, 8].every(k => Math.abs(boxSoup[o + k] - zMax) < 1e-6);
    if (!top) for (let k = 0; k < 9; k++) keep.push(boxSoup[o + k]);
  }
  const openBox = path.join(TMP, 'box-open-top.stl');
  writeSTL(openBox, new Float32Array(keep));
  await load(page, openBox);
  const s3 = await soupOf(page);
  const c3 = canonical(s3, 'box-before');
  console.log('   before  ' + fmt(c3));
  check('precondition: the box is open (4 rim edges), not non-manifold', c3.open === 4 && c3.nm === 0,
        'open ' + c3.open);
  const st3 = await solidify(page);
  const s3b = await soupOf(page);
  const c3b = canonical(s3b, 'box-after');
  console.log('   after   ' + fmt(c3b));
  console.log('   status: ' + st3);
  check('Solidify committed', /Solidify ok/.test(st3), st3);
  check('THE CANONICAL CHECKER PASSES THE RESULT', c3b.verdict === 'PASS' && c3b.open === 0 && c3b.nm === 0,
        c3b.verdict);
  check('...and by the exact census too', c3b.exact.open === 0 && c3b.exact.nm === 0 && c3b.exact.degen === 0);
  check('the status numbers are the canonical ones',
        st3.indexOf('open ' + c3.open + '→' + c3b.open) >= 0 &&
        st3.indexOf('NM ' + c3.nm + '→' + c3b.nm) >= 0, st3);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
                             null, { timeout: 30000 });
  check('Undo puts the open box back', sameSoup(s3, await soupOf(page)));

  console.log('\n=== 4. driver-testing round 1: pinched loop + loop folded over the top rim ===');
  // fixtures/damage/shape-cylinder_holes-light.stl - nso_damage.hole on
  // shape-cylinder, severity light, seed 7. Before the fix Solidify committed
  // it byte-identical under "Solidify ok - open 16→16" and pushed an Undo.
  const dmgFile = path.join(ROOT, 'fixtures', 'damage', 'shape-cylinder_holes-light.stl');
  const dmgMan = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'damage', 'damage.json'), 'utf8'))
    .entries.find(e => e.stl === 'shape-cylinder_holes-light.stl');
  await load(page, dmgFile);
  const s4 = await soupOf(page);
  const c4 = canonical(s4, 'cyl-before');
  console.log('   before  ' + fmt(c4));
  check('precondition: the app holds what damage.json predicts',
        c4.tris === dmgMan.expected.triangles && c4.open === dmgMan.expected.open_edges &&
        c4.nm === dmgMan.expected.nonmanifold_edges && c4.wind === dmgMan.expected.inconsistent_winding_edges,
        'open ' + c4.open + ' (predicted ' + dmgMan.expected.open_edges + ')');
  // The two failure modes, named and shown to be real on this input.
  const modes = await page.evaluate(() => {
    const s = getActiveModel().rawTris;
    const w = NSO_Repair._weldToIndexed(s, NSO_Repair.WELD_TOL);
    const L = solidifyDirectedLoops(w.mesh, NSO_Repair._buildEdges(w.mesh));
    const z = i => w.mesh.pos[i * 3 + 2];
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 2; i < s.length; i += 3) { zMin = Math.min(zMin, s[i]); zMax = Math.max(zMax, s[i]); }
    const loops = L.loops.map(l => ({ n: l.length, zs: [Math.min(...l.map(z)), Math.max(...l.map(z))], verts: l }));
    const shared = [];
    for (let a = 0; a < loops.length; a++) for (let b = a + 1; b < loops.length; b++) {
      if (loops[a].verts.some(v => loops[b].verts.indexOf(v) >= 0)) shared.push([a, b]);
    }
    let old = s;
    old = weldSoupVerts(old); old = capSmallOpenLoops(old, 28); old = capAllOuterHoles(old);
    old = repairJoinedSoup(old); old = weldSoupVerts(old);
    return { loops: loops.map(l => ({ n: l.n, zs: l.zs })), shared: shared, dead: L.deadEnds,
             zMin: zMin, zMax: zMax, oldOpen: solidifyCensus(old).open };
  });
  console.log('   directed loops ' + JSON.stringify(modes.loops) + ', sharing a vertex: ' + JSON.stringify(modes.shared));
  check('the pre-fix stages alone leave all of it open', modes.oldOpen === c4.open, 'open ' + modes.oldOpen);
  check('failure mode 1 is present: two directed loops share a vertex (the pinch at the cap centre)',
        modes.shared.length === 1 && modes.dead === 0);
  check('failure mode 2 is present: a loop folds over the top rim down to z = 0 (on no plane)',
        modes.loops.some(l => l.zs[0] === modes.zMin && l.zs[1] === modes.zMax));
  const st4 = await solidify(page);
  const s4b = await soupOf(page);
  const c4b = canonical(s4b, 'cyl-after');
  console.log('   after   ' + fmt(c4b));
  console.log('   status: ' + st4);
  check('Solidify committed and said ok', /Solidify ok/.test(st4), st4);
  check('THE CANONICAL CHECKER PASSES THE RESULT', c4b.verdict === 'PASS' && c4b.open === 0 && c4b.nm === 0 &&
        c4b.wind === 0 && c4b.degen === 0, c4b.verdict);
  check('...and by the exact census too', c4b.exact.open === 0 && c4b.exact.nm === 0 && c4b.exact.degen === 0);
  check('the status numbers are the canonical ones',
        st4.indexOf('open ' + c4.open + '→' + c4b.open) >= 0 && st4.indexOf('NM ' + c4.nm + '→' + c4b.nm) >= 0, st4);
  check('nothing invented: exactly the 10 removed faces come back (118 -> 128 tris)', c4b.tris === c4.tris + dmgMan.removed_faces,
        c4.tris + ' -> ' + c4b.tris);
  // Self-intersection and volume, against the clean source it was damaged from.
  const full = f => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
                                            { encoding: 'utf8' }));
  const cylAfterFile = path.join(TMP, 'cyl-after-full.stl');
  writeSTL(cylAfterFile, s4b);
  const v4b = full(cylAfterFile);
  const v4c = full(path.join(ROOT, 'fixtures', 'quick', 'shape-cylinder.stl'));
  console.log('   volume  ' + v4b.signed_volume.toFixed(4) + ' mm3 (clean source ' + v4c.signed_volume.toFixed(4) + ')');
  check('no piercing pairs in the result', v4b.self_intersection.pierce === 0, 'pierce ' + v4b.self_intersection.pierce);
  // Every loop is closed from its own vertices; the flat ones (the pinched
  // pair, the cap part of the folded one) re-triangulate in their own plane
  // and the wall face comes back exactly, so the volume is the clean one.
  // A flat best-fit-plane fill of the folded loop was measured at -1.04%.
  check('volume is the clean cylinder\'s (to 1e-6 relative)',
        Math.abs(v4b.signed_volume - v4c.signed_volume) <= 1e-6 * v4c.signed_volume,
        (v4b.signed_volume - v4c.signed_volume).toExponential(2) + ' mm3');
  check('it went on the undo stack once',
        await page.evaluate(() => (state.undoStack || []).filter(u => u && u.type === 'solidifyReplace').length) === 1);

  console.log('\n=== 5. nothing Solidify can close: the progress gate refuses ===');
  // A tilted, uncapped tube, 80 segments round: two rims of 80 edges each.
  // Too long to be a hole (the 64-edge cap NSO_Repair uses too), on no
  // bounding-box plane, and coarse enough that the grid-snap welds do not
  // touch it - so the result is neither worse nor better. Before the fix that
  // committed as "Solidify ok".
  const tube = [];
  const SEG = 80, RAD = 20, H = 10, tilt = Math.PI / 6;
  const rot = (x, y, z) => [x, y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt) + 20];
  for (let i = 0; i < SEG; i++) {
    const a0 = 2 * Math.PI * i / SEG, a1 = 2 * Math.PI * (i + 1) / SEG;
    const p00 = rot(RAD * Math.cos(a0), RAD * Math.sin(a0), 0), p10 = rot(RAD * Math.cos(a1), RAD * Math.sin(a1), 0);
    const p01 = rot(RAD * Math.cos(a0), RAD * Math.sin(a0), H), p11 = rot(RAD * Math.cos(a1), RAD * Math.sin(a1), H);
    tube.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
  }
  const tubeFile = path.join(TMP, 'tube-open-tilted.stl');
  writeSTL(tubeFile, new Float32Array(tube));
  await load(page, tubeFile);
  const s5 = await soupOf(page);
  const c5 = canonical(s5, 'tube-before');
  console.log('   before  ' + fmt(c5));
  check('precondition: two 80-edge rims, nothing non-manifold', c5.open === 2 * SEG && c5.nm === 0, 'open ' + c5.open);
  const undo5 = await page.evaluate(() => (state.undoStack || []).length);
  const st5 = await solidify(page);
  const s5b = await soupOf(page);
  console.log('   status: ' + st5);
  check('Solidify refused - not "ok"', /Solidify refused/.test(st5) && !/Solidify ok/.test(st5), st5);
  check('...saying none of the open edges closed', st5.indexOf('closed none of the ' + c5.open + ' open edges') >= 0);
  check('...and why', /80-edge loop \(over 64/.test(st5));
  check('the piece is bit-identical', sameSoup(s5, s5b));
  check('nothing went on the undo stack', await page.evaluate(() => (state.undoStack || []).length) === undo5);

  console.log('\n=== 6. progress that costs winding is not progress ===');
  // fixtures/damage/shape-sphere_holes-shredded.stl: the coarse welds and
  // repairJoinedSoup close 13 of 221 open edges and mis-wind 21. Open went
  // down, so before the winding line in solidifyRegressions this committed.
  const shredFile = path.join(ROOT, 'fixtures', 'damage', 'shape-sphere_holes-shredded.stl');
  await load(page, shredFile);
  const s6 = await soupOf(page);
  const c6 = canonical(s6, 'shred-before');
  console.log('   before  ' + fmt(c6));
  const raw6 = new Float32Array(await page.evaluate(() => {
    let w = getActiveModel().rawTris;
    w = weldSoupVerts(w); w = capSmallOpenLoops(w, 28); w = capAllOuterHoles(w);
    w = repairJoinedSoup(w); w = weldSoupVerts(w);
    return Array.from(solidifyCloseLoops(w).soup);
  }));
  const c6raw = canonical(raw6, 'shred-ungated');
  console.log('   ungated ' + fmt(c6raw));
  check('the ungated result really does close some and mis-wind some',
        c6raw.open < c6.open && c6raw.wind > c6.wind, 'open ' + c6.open + '->' + c6raw.open + ', wind ' + c6.wind + '->' + c6raw.wind);
  const undo6 = await page.evaluate(() => (state.undoStack || []).length);
  const st6 = await solidify(page);
  console.log('   status: ' + st6);
  check('Solidify refused, naming the winding', /Solidify refused/.test(st6) && /mis-wound \d+→\d+/.test(st6), st6);
  check('the piece is bit-identical', sameSoup(s6, await soupOf(page)));
  check('nothing went on the undo stack', await page.evaluate(() => (state.undoStack || []).length) === undo6);

  const errs = logs.filter(l => /pageerror/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall Solidify gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
