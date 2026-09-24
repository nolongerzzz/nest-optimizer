/* Solidify, driven through the REAL button, measured by the CANONICAL checker.

   The bug this pins: library/v9_mirror_factory.stl is exact-vertex clean
   (every edge shared by exactly 2 faces, consistent winding, 0 degenerate),
   and one click of Solidify, with nothing else run first, turned it into
   31,199 triangles out of 49,026 with 35 open / 55 non-manifold / 69
   degenerate by tools/mesh_validate.py - under a status line that said
   "Solidify ok". The hole fill was not the culprit (there were no holes);
   the two coarse grid-snap welds were (0.2 mm in Solidify, 0.3 mm inside
   repairJoinedSoup). See the comment above solidifySelectedModel().

   Every number gated here comes from tools/mesh_validate.py and
   tools/stl_watertight_check.py, run as subprocesses on the soup the app
   actually holds before and after the click - never from the app's own
   status line or counters. The status line is then checked against them.

     1. clean piece: Solidify leaves it bit-identical and says so.
     2. clean piece with one face knocked out: Solidify still runs (there IS
        an opening), the coarse welds would wreck it, and the result gate
        refuses - piece unchanged, and the refusal names the count that rose.
     3. a box with its top missing: a job Solidify can do. It commits, the
        canonical checker passes the result, the status numbers match it,
        and Undo puts the open box back.

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

  console.log('\n=== 2. one face knocked out: Solidify runs, and the result gate refuses ===');
  const holed = s1.slice(9);                       // drop the first triangle: 3 open edges
  const holedFile = path.join(TMP, 'factory-holed.stl');
  writeSTL(holedFile, holed);
  await load(page, holedFile);
  const s2 = await soupOf(page);
  const c2 = canonical(s2, 'holed-before');
  console.log('   before  ' + fmt(c2));
  check('precondition: exactly the one opening, nothing non-manifold',
        c2.exact.open === 3 && c2.exact.nm === 0, 'exact open ' + c2.exact.open);
  // What the pipeline WOULD produce if it were allowed to commit - the same
  // stages, called directly, so the refusal below is shown to be protecting
  // against a real regression rather than a vacuous one.
  const raw = new Float32Array(await page.evaluate(() => {
    let w = getActiveModel().rawTris;
    w = weldSoupVerts(w); w = capSmallOpenLoops(w, 28); w = capAllOuterHoles(w);
    w = repairJoinedSoup(w); w = weldSoupVerts(w);
    return Array.from(w);
  }));
  const c2raw = canonical(raw, 'holed-ungated');
  console.log('   ungated ' + fmt(c2raw));
  check('the ungated pipeline really does raise non-manifold edges on this piece',
        c2raw.nm > c2.nm, 'NM ' + c2.nm + ' -> ' + c2raw.nm);
  const st2 = await solidify(page);
  const s2b = await soupOf(page);
  const c2b = canonical(s2b, 'holed-after');
  console.log('   after   ' + fmt(c2b));
  console.log('   status: ' + st2);
  check('Solidify refused and said so', /Solidify refused/.test(st2) && !/Solidify ok/.test(st2), st2);
  check('...naming non-manifold as the count that rose', /non-manifold \d+→\d+/.test(st2));
  check('the piece is bit-identical - nothing committed', sameSoup(s2, s2b));
  check('canonical: non-manifold did not rise', c2b.nm <= c2.nm && c2b.exact.nm <= c2.exact.nm);
  check('nothing went on the undo stack for a refusal',
        await page.evaluate(() => !(state.undoStack || []).some(u => u && u.type === 'solidifyReplace')));

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
