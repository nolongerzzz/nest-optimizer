/* End-to-end evidence for planar fusion as Join's Route 0, driven through the
   real app: a real Square Cut, then a real Join on the halves it produced.
   node tools/nso_wire_fuse_test.js        exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Loads a piece and puts it through the real Split button path. */
async function splitFixture(page, file) {
  await page.evaluate(() => { state.models = []; state.placed = []; state.undoStack = []; });
  const id = await loadSTL(page, file);
  await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
  if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
  await selectModel(page, id);
  return await page.evaluate(() => {
    if (typeof updateCutHelper === 'function') updateCutHelper();
    cutActiveModel();
    return { status: document.getElementById('status').textContent,
             models: state.models.map(m => ({ id: m.id, name: m.name, tris: m.rawTris.length / 9 })) };
  });
}

/* Start Join / Pick A / Pick B, then Complete Join. */
async function joinPair(page, idA, idB) {
  await page.evaluate(([a, b]) => {
    state.joinSession = true; state.editId = a; state.joinPartnerId = b;
    document.getElementById('status').textContent = '';
  }, [idA, idB]);
  await page.evaluate(() => { document.getElementById('btn-join').disabled = false; });
  await page.click('#btn-join');
  await page.waitForFunction(() => /Join ok|Join failed/.test(document.getElementById('status').textContent),
    null, { timeout: 90000 });
  return await statusOf(page);
}


/* Re-runs split+join on a fresh page state with the fusion entry point
   removed, which is exactly the code path that existed before Route 0. */
async function withFusionDisabled(page, file) {
  await page.evaluate(() => { window.__fuse = NSO_fuseFindMating; NSO_fuseFindMating = undefined; });
  try {
    const c = await splitFixture(page, file);
    return await joinPair(page, c.models[0].id, c.models[1].id);
  } finally {
    await page.evaluate(() => { NSO_fuseFindMating = window.__fuse; });
  }
}

const soupVol = page => page.evaluate(() => {
  const s = getActiveModel().rawTris; let v = 0;
  for (let t = 0; t < s.length / 9; t++) { const o = t * 9;
    v += (s[o]*(s[o+4]*s[o+8]-s[o+5]*s[o+7]) - s[o+1]*(s[o+3]*s[o+8]-s[o+5]*s[o+6]) + s[o+2]*(s[o+3]*s[o+7]-s[o+4]*s[o+6])); }
  return v / 6;
});

withApp(async (page, logs) => {
  console.log('\n=== 0. the module is on the page ===');
  check('NSO_findSharedFace loaded', await page.evaluate(() => typeof NSO_findSharedFace) === 'function');
  check('NSO_fuseFindMating loaded', await page.evaluate(() => typeof NSO_fuseFindMating) === 'function');

  console.log('\n=== 1. QUALIFIES: box-20mm split, then rejoined ===');
  let cut = await splitFixture(page, fx('box-20mm.stl'));
  console.log('   split: ' + cut.status.split('.')[0]);
  console.log('   halves: ' + cut.models.map(m => m.name + ' ' + m.tris + ' tris').join(', '));
  const triSum = cut.models[0].tris + cut.models[1].tris;
  const volA = await page.evaluate(id => { const m = state.models.find(x=>x.id===id); const s=m.rawTris; let v=0;
    for(let t=0;t<s.length/9;t++){const o=t*9;v+=(s[o]*(s[o+4]*s[o+8]-s[o+5]*s[o+7])-s[o+1]*(s[o+3]*s[o+8]-s[o+5]*s[o+6])+s[o+2]*(s[o+3]*s[o+7]-s[o+4]*s[o+6]));} return v/6; }, cut.models[0].id);
  const volB = await page.evaluate(id => { const m = state.models.find(x=>x.id===id); const s=m.rawTris; let v=0;
    for(let t=0;t<s.length/9;t++){const o=t*9;v+=(s[o]*(s[o+4]*s[o+8]-s[o+5]*s[o+7])-s[o+1]*(s[o+3]*s[o+8]-s[o+5]*s[o+6])+s[o+2]*(s[o+3]*s[o+7]-s[o+4]*s[o+6]));} return v/6; }, cut.models[1].id);

  let st = await joinPair(page, cut.models[0].id, cut.models[1].id);
  console.log('   status: ' + st);
  console.log('   console: ' + (logs.filter(l => /planar fuse/.test(l)).pop() || '(none)'));
  const joined = await page.evaluate(() => {
    const m = getActiveModel(); const s = m.rawTris; const e = NSO_edgeStats(s);
    return { tris: s.length / 9, open: e.open, nm: e.nm, models: state.models.length };
  });
  const volJ = await soupVol(page);
  console.log('   result: ' + joined.tris + ' tris, open ' + joined.open + ', nm ' + joined.nm);
  check('Join took the planar fuse route', /planar fuse/.test(st), st);
  check('status names the removed caps', /cap tri\(s\) removed/.test(st), st);
  check('4 cap triangles gone (2 per side)', joined.tris === triSum - 4, triSum + ' -> ' + joined.tris);
  check('result is watertight', joined.open === 0 && joined.nm === 0,
        'open ' + joined.open + ', nm ' + joined.nm);
  check('volume is the sum of the halves', Math.abs(volJ - (volA + volB)) < 1e-3,
        (volA + volB).toFixed(4) + ' vs ' + volJ.toFixed(4));
  check('two pieces became one', joined.models === 1, joined.models + ' model(s)');

  console.log('\n=== 2. QUALIFIES: pin.stl, a 32-segment round cross-section ===');
  cut = await splitFixture(page, fx('pin.stl'));
  const triSum2 = cut.models[0].tris + cut.models[1].tris;
  st = await joinPair(page, cut.models[0].id, cut.models[1].id);
  const joined2 = await page.evaluate(() => {
    const m = getActiveModel(); const e = NSO_edgeStats(m.rawTris);
    return { tris: m.rawTris.length / 9, open: e.open, nm: e.nm };
  });
  console.log('   status: ' + st);
  check('fused the round seam', /planar fuse/.test(st), st);
  check('64 cap triangles gone (32 per side)', joined2.tris === triSum2 - 64,
        triSum2 + ' -> ' + joined2.tris);
  check('result is watertight', joined2.open === 0 && joined2.nm === 0);

  console.log('\n=== 3. DECLINES CLEANLY: box_open.stl - same cap outline,');
  console.log('       opposite quad diagonal on each half ===');
  cut = await splitFixture(page, fx('box_open.stl'));
  st = await joinPair(page, cut.models[0].id, cut.models[1].id);
  console.log('   status: ' + st);
  const fuseLog = logs.filter(l => /planar fuse declined/.test(l)).pop();
  console.log('   console: ' + (fuseLog || '(none)'));
  check('did NOT claim a fuse', !/planar fuse\)/.test(st), st);
  check('decline reason logged', !!fuseLog, fuseLog);
  // The real question is whether declining changed anything. Re-run the same
  // join with the fusion module hidden, so Route 0 cannot even be attempted,
  // and require the identical outcome.
  const baseline = await withFusionDisabled(page, fx('box_open.stl'));
  console.log('   fusion disabled: ' + baseline);
  check('outcome identical with fusion disabled', baseline === st,
        'with: ' + st + '  ||  without: ' + baseline);

  console.log('\n=== 4. DECLINES: two unrelated pieces are not a cut pair ===');
  await page.evaluate(() => { state.models = []; state.placed = []; state.undoStack = []; });
  const i1 = await loadSTL(page, fx('box-20mm.stl'));
  const i2 = await loadSTL(page, fx('pin.stl'));
  st = await joinPair(page, i1, i2);
  console.log('   status: ' + st);
  const fuseLog2 = logs.filter(l => /planar fuse declined/.test(l)).pop();
  console.log('   console: ' + (fuseLog2 || '(none)'));
  check('no bogus fuse on unrelated pieces', !/planar fuse\)/.test(st), st);

  console.log('\n=== 5. paint wins: fusion stands down, join still works ===');
  cut = await splitFixture(page, fx('box-20mm.stl'));
  await page.evaluate(id => {
    state.models.find(x => x.id === id).faceMask =
      { exclude: [{ n: [0,0,1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  }, cut.models[0].id);
  st = await joinPair(page, cut.models[0].id, cut.models[1].id);
  const painted = logs.filter(l => /planar fuse declined.*painted/.test(l)).pop();
  console.log('   status: ' + st);
  console.log('   console: ' + (painted || '(none)'));
  check('fusion stood down for paint', !!painted, painted);
  check('did not fuse', !/planar fuse\)/.test(st), st);
  const paintedBaseline = await withFusionDisabled(page, fx('box-20mm.stl'));
  console.log('   fusion disabled: ' + paintedBaseline);
  check('a painted pair behaves exactly as it did before fusion existed',
        paintedBaseline === st, 'with: ' + st + '  ||  without: ' + paintedBaseline);

  console.log('\n=== 6. nothing else broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
