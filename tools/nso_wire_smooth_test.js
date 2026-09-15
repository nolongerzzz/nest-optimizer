/* End-to-end evidence for the Smooth button, driven through the real app.
   node tools/nso_wire_smooth_test.js        exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Measures the selected piece the way the app itself would. */
const measure = page => page.evaluate(() => {
  const m = getActiveModel();
  const s = m.rawTris;
  const st = NSO_edgeStats(s);
  let v = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    v += (s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7])
        - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6])
        + s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]));
  }
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
           size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) } };
});

withApp(async (page, logs) => {
  console.log('\n=== 1. the button exists and is reachable ===');
  const btn = await page.evaluate(() => {
    const b = document.getElementById('btn-smooth');
    return b ? { text: b.textContent.trim(), wired: b.dataset.nsoWired === '1' } : null;
  });
  check('#btn-smooth present in the DOM', !!btn, btn ? 'label "' + btn.text + '"' : 'missing');
  check('listener attached at load', !!btn && btn.wired);

  console.log('\n=== 2. real STL, real click: fixture_sphere_curved.stl ===');
  const id = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await selectModel(page, id);
  const before = await measure(page);
  console.log('   before  tris ' + before.tris + '  open ' + before.open + '  nm ' + before.nm +
              '  vol ' + before.volume.toFixed(3) + '  bbox ' + JSON.stringify(before.size));

  // the Finish menu is a <details>; a user opens it before reaching the button
  await page.evaluate(() => {
    const b = document.getElementById('btn-smooth');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  await page.click('#btn-smooth');
  await page.waitForFunction(() => {
    const el = document.getElementById('status');
    return el && /Smooth/.test(el.textContent);
  }, null, { timeout: 60000 });
  const after = await measure(page);
  const status1 = await statusOf(page);
  console.log('   after   tris ' + after.tris + '  open ' + after.open + '  nm ' + after.nm +
              '  vol ' + after.volume.toFixed(3) + '  bbox ' + JSON.stringify(after.size));
  console.log('   status: ' + status1);

  check('status reports a completed smooth', /Smooth done/.test(status1), status1);
  check('geometry actually changed', Math.abs(after.volume - before.volume) > 1e-6,
        'vol ' + before.volume.toFixed(3) + ' -> ' + after.volume.toFixed(3));
  check('triangle count preserved', after.tris === before.tris, before.tris + ' -> ' + after.tris);
  check('did not open the mesh', after.open <= before.open, before.open + ' -> ' + after.open);
  check('did not add non-manifold edges', after.nm <= before.nm, before.nm + ' -> ' + after.nm);
  const volPct = 100 * (Math.abs(after.volume) / Math.abs(before.volume) - 1);
  check('inside the 25% volume budget', Math.abs(volPct) <= 25, volPct.toFixed(2) + '%');

  console.log('\n=== 3. Undo puts the piece back ===');
  const undoEnabled = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo button enabled after smooth', undoEnabled);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });
  const undone = await measure(page);
  const status2 = await statusOf(page);
  console.log('   status: ' + status2);
  check('undo names Smooth, not another bake', /Undo: Smooth reverted/.test(status2), status2);
  check('volume restored exactly', undone.volume === before.volume,
        before.volume.toFixed(6) + ' -> ' + undone.volume.toFixed(6));
  check('bbox restored exactly', JSON.stringify(undone.size) === JSON.stringify(before.size));

  console.log('\n=== 4. paint wins: a painted piece is a stand-down ===');
  await page.evaluate(() => {
    const m = getActiveModel();
    // one excluded face, shaped exactly as app-mask.js records a click
    m.faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const paintedBefore = await measure(page);
  const res = await page.evaluate(() => NSO_smoothSelectedModel());
  const paintedAfter = await measure(page);
  const status3 = await statusOf(page);
  console.log('   status: ' + status3);
  check('declined', res.ok === false, 'reason: ' + res.reason);
  check('status names the painted count', /stood down - 1 painted face/.test(status3), status3);
  check('piece is byte-for-byte unchanged',
        JSON.stringify(paintedAfter) === JSON.stringify(paintedBefore));

  console.log('\n=== 5. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-soften','btn-seal','btn-solidify','btn-join','btn-mask-paint']
    .filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
