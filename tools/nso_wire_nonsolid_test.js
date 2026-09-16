/* End-to-end evidence for the Non-solid checkbox (docs/NON-SOLID.md), driving
   the real page in Chromium through the shipped controls, on the open
   fixtures. What it proves at the button level:

     - the flag is per piece, visible (checkbox + list tag), undoable, and set
       by nobody but the user;
     - Seal with Repair ticked on a flagged open piece leaves it open and says
       so; unticked, the same click peels it (the hazard, pinned);
     - plain Seal on a flagged piece stands down by name;
     - a flagged piece with a real self-intersection never reads as a clean
       no-op: the status line names the pairs;
     - Smooth on a flagged sheet lands on the area budget instead of refusing
       on a meaningless volume.

   node tools/nso_wire_nonsolid_test.js        exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', 'open', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const measure = page => page.evaluate(() => {
  const m = getActiveModel();
  const s = m.rawTris;
  const st = NSO_edgeStats(s);
  return { id: m.id, tris: s.length / 9, open: st.open, nm: st.nm, nonSolid: !!m.nonSolid,
           chk: document.getElementById('chk-non-solid').checked,
           chkDisabled: document.getElementById('chk-non-solid').disabled,
           tag: !!document.querySelector('#model-list .model-item.active .tag-nonsolid') };
});

async function openAdjust(page) {
  await page.evaluate(() => {
    const b = document.getElementById('btn-seal');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    document.getElementById('status').textContent = '';
  });
}
async function setRepair(page, on) {
  await page.evaluate(v => { document.getElementById('chk-seal-repair').checked = v; }, on);
}
async function clickSeal(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-seal');
  await page.waitForFunction(() => {
    const t = document.getElementById('status').textContent;
    return t && /Repair|Nothing to repair|Seal/.test(t);
  }, null, { timeout: 60000 });
  return statusOf(page);
}
async function toggleNonSolid(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#chk-non-solid');
  return statusOf(page);
}

withApp(async (page, logs) => {
  console.log('\n=== 0. the module is on the page ===');
  const t = await page.evaluate(() => typeof window.nsoNonSolid);
  check('window.nsoNonSolid loaded', t === 'function', 'typeof = ' + t);
  const noSel = await page.evaluate(() => document.getElementById('chk-non-solid').disabled);
  check('checkbox disabled with nothing selected', noSel === true);

  console.log('\n=== 1. the flag is per piece, visible, undoable ===');
  const clipId = await loadSTL(page, fx('open_clip.stl'));
  await selectModel(page, clipId);
  await page.evaluate(() => { renderModelList(); updateAdjustUI(); });
  await openAdjust(page);
  let m = await measure(page);
  check('fresh piece is not flagged', m.nonSolid === false && m.chk === false && m.tag === false && m.chkDisabled === false, JSON.stringify(m));
  console.log('   open_clip: tris ' + m.tris + ' open ' + m.open + ' nm ' + m.nm);
  let st = await toggleNonSolid(page);
  m = await measure(page);
  check('ticking the box sets m.nonSolid on the active piece', m.nonSolid === true && m.chk === true, JSON.stringify(m));
  check('  ...and the list row shows the tag', m.tag === true);
  check('  ...and the status says what it means', /Flagged non-solid/.test(st) && /self-intersection, degenerate and winding checks still apply/.test(st), st);

  const cupId = await loadSTL(page, fx('thin_shell_cup.stl'));
  await selectModel(page, cupId);
  await page.evaluate(() => { renderModelList(); updateAdjustUI(); });
  m = await measure(page);
  check('a second piece is NOT flagged (per piece, not global)', m.nonSolid === false && m.chk === false && m.tag === false, JSON.stringify(m));
  const clipStill = await page.evaluate(id => !!state.models.find(x => x.id === id).nonSolid, clipId);
  check('  ...while the first still is', clipStill === true);

  await selectModel(page, clipId);
  await page.evaluate(() => { renderModelList(); updateAdjustUI(); });
  await page.click('#btn-undo');
  m = await measure(page);
  st = await statusOf(page);
  check('Undo clears the flag again', m.nonSolid === false && m.chk === false && m.tag === false, st);
  await toggleNonSolid(page);
  m = await measure(page);
  check('re-ticked for the rest of the run', m.nonSolid === true);

  console.log('\n=== 2. Seal + Repair on a flagged open piece leaves it open ===');
  await setRepair(page, true);
  const before = await measure(page);
  st = await clickSeal(page);
  let after = await measure(page);
  console.log('   status: ' + st);
  check('status is the non-solid no-op', /^Nothing to repair \(non-solid\)/.test(st), st);
  check('open edges untouched', after.open === before.open && after.tris === before.tris, before.open + ' -> ' + after.open);
  check('no self-intersections reported', !/self-intersecting/.test(st));

  console.log('\n=== 3. the same click with the flag OFF alters the piece (the hazard) ===');
  await toggleNonSolid(page);
  m = await measure(page);
  check('flag cleared', m.nonSolid === false);
  st = await clickSeal(page);
  after = await measure(page);
  console.log('   status: ' + st);
  check('Repair reports work done on a sound open sheet', /^Repair (done|partial)/.test(st), st);
  check('triangles were removed (flap peel ate the sheet corners)', after.tris < before.tris, before.tris + ' -> ' + after.tris);
  await page.click('#btn-undo');
  after = await measure(page);
  check('Undo restores the sheet', after.tris === before.tris && after.open === before.open);
  await toggleNonSolid(page);

  console.log('\n=== 4. plain Seal on a flagged piece stands down by name ===');
  await setRepair(page, false);
  st = await clickSeal(page);
  after = await measure(page);
  console.log('   status: ' + st);
  check('Seal stood down', /^Seal stood down - open_clip is flagged non-solid/.test(st), st);
  check('piece unchanged', after.tris === before.tris && after.open === before.open);

  console.log('\n=== 5. a flagged piece with a real pierce is never a clean no-op ===');
  const badId = await loadSTL(page, fx('open_clip_selfint.stl'));
  await selectModel(page, badId);
  await page.evaluate(() => { renderModelList(); updateAdjustUI(); });
  await toggleNonSolid(page);
  await setRepair(page, true);
  const b0 = await measure(page);
  st = await clickSeal(page);
  const b1 = await measure(page);
  console.log('   status: ' + st);
  check('status names the self-intersecting pairs', /4 self-intersecting pair\(s\) present, not hidden by the non-solid flag/.test(st), st);
  check('nothing peeled away to hide them', b1.tris === b0.tris, b0.tris + ' -> ' + b1.tris);

  console.log('\n=== 6. Smooth on a flagged sheet uses the area budget ===');
  const weaveId = await loadSTL(page, fx('fabric_weave.stl'));
  await selectModel(page, weaveId);
  await page.evaluate(() => { renderModelList(); updateAdjustUI(); });
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-smooth');
  await page.waitForFunction(() => /Smooth/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  st = await statusOf(page);
  console.log('   unflagged: ' + st);
  check('unflagged weave: Smooth reports a volume figure (noise on a sheet, but that is the unflagged contract)', /^Smooth done - /.test(st) && /volume/.test(st), st);
  await page.click('#btn-undo');
  await toggleNonSolid(page);
  const w0 = await measure(page);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-smooth');
  await page.waitForFunction(() => /Smooth/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  st = await statusOf(page);
  const w1 = await measure(page);
  console.log('   flagged:   ' + st);
  check('flagged weave: Smooth lands and reports area, not volume', /^Smooth done \(non-solid\)/.test(st) && /area/.test(st), st);
  check('  ...open edges did not rise, triangle count kept', w1.open <= w0.open && w1.tris === w0.tris, w0.open + ' -> ' + w1.open);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
