/* End-to-end evidence for Seal's Repair checkbox now running NSO_Repair.commit().
   Drives the real page in Chromium against real broken files.
   node tools/nso_wire_repair_test.js        exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const measure = page => page.evaluate(() => {
  const m = getActiveModel();
  const s = m.rawTris;
  const st = NSO_edgeStats(s);
  return { tris: s.length / 9, open: st.open, nm: st.nm,
           sig: Array.from(s.slice(0, 24)).map(v => v.toFixed(6)).join(',') };
});

/* One run of Seal with Repair ticked, on a freshly loaded piece. */
async function sealRepair(page, file) {
  const id = await loadSTL(page, file);
  await selectModel(page, id);
  await page.evaluate(() => {
    const b = document.getElementById('btn-seal');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    document.getElementById('chk-seal-repair').checked = true;
    document.getElementById('status').textContent = '';
  });
  const before = await measure(page);
  await page.click('#btn-seal');
  await page.waitForFunction(() => {
    const t = document.getElementById('status').textContent;
    return t && /Repair|Nothing to repair|Seal/.test(t);
  }, null, { timeout: 60000 });
  const after = await measure(page);
  return { before, after, status: await statusOf(page) };
}

withApp(async (page, logs) => {
  console.log('\n=== 0. the module is actually on the page now ===');
  const t = await page.evaluate(() => typeof window.NSO_Repair);
  check('window.NSO_Repair loaded', t === 'object', 'typeof = ' + t);
  const ver = await page.evaluate(() => window.NSO_Repair && window.NSO_Repair.VERSION);
  console.log('   NSO_Repair VERSION ' + ver);

  console.log('\n=== 1. a real defect gets repaired: synth_hole.stl (open boundary) ===');
  let r = await sealRepair(page, fx('repair/synth_hole.stl'));
  console.log('   before tris ' + r.before.tris + ' open ' + r.before.open + ' nm ' + r.before.nm);
  console.log('   after  tris ' + r.after.tris + ' open ' + r.after.open + ' nm ' + r.after.nm);
  console.log('   status: ' + r.status);
  check('status says Repair done', /^Repair done/.test(r.status), r.status);
  check('the hole is closed', r.after.open === 0, r.before.open + ' -> ' + r.after.open);
  check('open-edge counts are in the line', /open edges 3→0/.test(r.status), r.status);
  check('names the stage that fired', /hole\(s\) filled/.test(r.status), r.status);

  console.log('\n=== 2. bowtie vertices separated: thingi10k/40921.stl ===');
  r = await sealRepair(page, fx('repair/thingi10k/40921.stl'));
  console.log('   before tris ' + r.before.tris + ' open ' + r.before.open + ' nm ' + r.before.nm);
  console.log('   after  tris ' + r.after.tris + ' open ' + r.after.open + ' nm ' + r.after.nm);
  console.log('   status: ' + r.status);
  check('status says Repair done', /^Repair done/.test(r.status), r.status);
  check('geometry changed', r.after.sig !== r.before.sig || r.after.tris !== r.before.tris);
  // Edge-based counts are blind to bowtie vertices (docs/HANDOFF.md). The
  // status line must still say what was done, or a real repair reads as a no-op.
  check('reports the pinch-vertex work the edge counts cannot show',
        /pinch vert\(s\) split/.test(r.status), r.status);

  console.log('\n=== 3. FAIL-SAFE: gate refuses the fix, piece must survive intact ===');
  console.log('   synth_pinch_2sheet_tight.stl - separating the pinch would open');
  console.log('   12 self-intersections, so NSO_Repair rolls the stage back.');
  r = await sealRepair(page, fx('repair/synth_pinch_2sheet_tight.stl'));
  console.log('   before tris ' + r.before.tris + ' open ' + r.before.open + ' nm ' + r.before.nm);
  console.log('   after  tris ' + r.after.tris + ' open ' + r.after.open + ' nm ' + r.after.nm);
  console.log('   status: ' + r.status);
  check('reports unavailable, not success', /^Repair unavailable for this defect/.test(r.status), r.status);
  check('names the gated stage', /pinch-separate/.test(r.status), r.status);
  check('piece is byte-for-byte unchanged', r.after.sig === r.before.sig && r.after.tris === r.before.tris);
  check('non-manifold count not made worse', r.after.nm <= r.before.nm, r.before.nm + ' -> ' + r.after.nm);

  console.log('\n=== 4. FAIL-SAFE: final gate blocks: thingi10k/39644.stl ===');
  r = await sealRepair(page, fx('repair/thingi10k/39644.stl'));
  console.log('   status: ' + r.status);
  check('reports unavailable', /^Repair unavailable for this defect/.test(r.status), r.status);
  check('names the gate', /final:oddEdges/.test(r.status), r.status);
  check('piece unchanged', r.after.sig === r.before.sig && r.after.tris === r.before.tris);

  console.log('\n=== 5. a clean mesh is a no-op, and says so honestly ===');
  r = await sealRepair(page, fx('box-20mm.stl'));
  console.log('   status: ' + r.status);
  check('says nothing to repair', /^Nothing to repair/.test(r.status), r.status);
  check('piece unchanged', r.after.sig === r.before.sig && r.after.tris === r.before.tris);
  // a no-op must not cost the user an undo step
  const undoAfterNoop = await page.evaluate(() => state.undoStack.length);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-seal');
  await page.waitForFunction(() => /Nothing to repair/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  check('a no-op pushes no undo entry',
        await page.evaluate(() => state.undoStack.length) === undoAfterNoop,
        'stack stayed at ' + undoAfterNoop);

  console.log('\n=== 6. paint wins ===');
  await page.evaluate(() => {
    getActiveModel().faceMask = { exclude: [{ n: [0,0,1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
    document.getElementById('status').textContent = '';
  });
  const pb = await measure(page);
  await page.click('#btn-seal');
  await page.waitForFunction(() => /stood down|Repair|Nothing/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const pa = await measure(page);
  const ps = await statusOf(page);
  console.log('   status: ' + ps);
  check('stands down on a painted piece', /Repair stood down - 1 painted face/.test(ps), ps);
  check('piece unchanged', pa.sig === pb.sig);

  console.log('\n=== 7. Seal with Repair UNTICKED still runs the old seal path ===');
  const id = await loadSTL(page, fx('repair/synth_hole.stl'));
  await selectModel(page, id);
  await page.evaluate(() => {
    document.getElementById('chk-seal-repair').checked = false;
    document.getElementById('status').textContent = '';
  });
  await page.click('#btn-seal');
  await page.waitForFunction(() => /Seal/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const sealStatus = await statusOf(page);
  console.log('   status: ' + sealStatus);
  check('plain Seal path untouched', /^Seal ok/.test(sealStatus), sealStatus);

  console.log('\n=== 8. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
