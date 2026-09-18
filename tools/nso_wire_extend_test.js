/* End-to-end evidence for the Extend button, driven through the real app.
   node tools/nso_wire_extend_test.js        exit 0 = every gate held

   Same shape as tools/nso_wire_smooth_test.js: real index.html, real script
   tags, real clicks, real undo. The headless proofs live in
   tools/nso_extend_test.js; what this file exists to prove is that the button
   is reachable, that the commit half rebuilds the piece the app actually
   draws, that undo restores it, and that paint stands it down. */

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
  // Every Y and Z coordinate of the RAW soup, in order: the cross-section,
  // verbatim. And the whole soup, for the undo comparison - checking only the
  // cross-section there would pass trivially, since the cross-section is what
  // Extend never touches in the first place.
  const yz = [];
  for (let i = 0; i < s.length; i += 3) yz.push(s[i + 1], s[i + 2]);
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
           yz: yz.join(','), soup: Array.from(s).join(','),
           size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) } };
});

const openFinishMenu = page => page.evaluate(() => {
  const b = document.getElementById('btn-extend');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
});

withApp(async (page, logs) => {
  console.log('\n=== 1. the control exists and is reachable ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-extend');
    const i = document.getElementById('inp-extend-mm');
    return { btn: !!b, text: b ? b.textContent.trim() : '', wired: !!b && b.dataset.nsoWired === '1',
             input: !!i, type: i ? i.type : '' };
  });
  check('#btn-extend present in the DOM', ui.btn, ui.btn ? 'label "' + ui.text + '"' : 'missing');
  check('listener attached at load', ui.wired);
  check('#inp-extend-mm present and numeric', ui.input && ui.type === 'number');

  console.log('\n=== 2. a blank box reports the piece instead of failing ===');
  const id = await loadSTL(page, fx('lid_strap.stl'));
  await selectModel(page, id);
  await openFinishMenu(page);
  await page.click('#btn-extend');
  await page.waitForFunction(() => /Extend/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status0 = await statusOf(page);
  const prefilled = await page.evaluate(() => document.getElementById('inp-extend-mm').value);
  console.log('   status: ' + status0);
  check('names the detected axis and the current length', /60\.00 mm along X/.test(status0), status0);
  check('and prefills the box with it', prefilled === '60.00', 'value "' + prefilled + '"');

  console.log('\n=== 3. real STL, real click: lid_strap 60 -> 95 mm ===');
  const before = await measure(page);
  console.log('   before  tris ' + before.tris + '  open ' + before.open + '  nm ' + before.nm +
              '  vol ' + before.volume.toFixed(3) + '  bbox ' + JSON.stringify(before.size));
  await page.fill('#inp-extend-mm', '95');
  await page.click('#btn-extend');
  await page.waitForFunction(() => /Extend done|Extend refused/.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const after = await measure(page);
  const status1 = await statusOf(page);
  console.log('   after   tris ' + after.tris + '  open ' + after.open + '  nm ' + after.nm +
              '  vol ' + after.volume.toFixed(3) + '  bbox ' + JSON.stringify(after.size));
  console.log('   status: ' + status1);

  check('status reports a completed extend', /Extend done/.test(status1), status1);
  check('status names the zero cross-section drift', /0 drifted coordinates/.test(status1));
  check('the app\'s own bbox is 95 mm along X', after.size.x === 95, before.size.x + ' -> ' + after.size.x);
  // The app draws Y-up, so m.size.y is the raw soup's Z (the 2.4 mm slab depth
  // that carries the 0.6 mm flexure) and m.size.z is the raw soup's Y.
  check('the app\'s own height is bit-for-bit unchanged (raw Z, the slab)',
        after.size.y === before.size.y, before.size.y + ' -> ' + after.size.y + ' mm');
  check('the app\'s own depth is bit-for-bit unchanged (raw Y)',
        after.size.z === before.size.z, before.size.z + ' -> ' + after.size.z + ' mm');
  check('every Y and Z coordinate in the soup is identical', after.yz === before.yz,
        (before.yz.split(',').length) + ' coordinates compared');
  check('triangle count preserved', after.tris === before.tris, before.tris + ' -> ' + after.tris);
  check('did not open the mesh', after.open <= before.open, before.open + ' -> ' + after.open);
  check('did not add non-manifold edges', after.nm <= before.nm, before.nm + ' -> ' + after.nm);
  check('volume grew by the cross-section x the shift',
        Math.abs((after.volume - before.volume) / 35 - 102) < 1e-3,
        'implied ' + ((after.volume - before.volume) / 35).toFixed(4) + ' mm2');

  console.log('\n=== 4. Undo puts the piece back ===');
  const undoEnabled = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo button enabled after extend', undoEnabled);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });
  const undone = await measure(page);
  const status2 = await statusOf(page);
  console.log('   status: ' + status2);
  check('volume restored exactly', undone.volume === before.volume,
        before.volume.toFixed(6) + ' -> ' + undone.volume.toFixed(6));
  check('bbox restored exactly', JSON.stringify(undone.size) === JSON.stringify(before.size));
  check('undo names Extend, not another bake', /Undo: Extend reverted/.test(status2), status2);
  check('the whole soup is back, coordinate for coordinate', undone.soup === before.soup,
        before.soup.split(',').length + ' floats compared');

  console.log('\n=== 5. paint wins: a painted piece is a stand-down ===');
  await page.evaluate(() => {
    const m = getActiveModel();
    // one excluded face, shaped exactly as app-mask.js records a click
    m.faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const paintedBefore = await measure(page);
  const res = await page.evaluate(() => NSO_extendSelectedModel({ length: 95 }));
  const paintedAfter = await measure(page);
  const status3 = await statusOf(page);
  console.log('   status: ' + status3);
  check('declined', res.ok === false, 'reason: ' + res.reason);
  check('status names the painted count', /stood down - 1 painted face/.test(status3), status3);
  check('piece is byte-for-byte unchanged',
        JSON.stringify(paintedAfter) === JSON.stringify(paintedBefore));

  console.log('\n=== 6. a refusal is loud and leaves the piece alone ===');
  await page.evaluate(() => { getActiveModel().faceMask = null; });
  const sphereId = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await selectModel(page, sphereId);
  const sphereBefore = await measure(page);
  await page.fill('#inp-extend-mm', '40');
  await page.click('#btn-extend');
  await page.waitForFunction(() => /Extend refused/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status4 = await statusOf(page);
  const sphereAfter = await measure(page);
  console.log('   status: ' + status4);
  check('a curved piece is refused by name', /no dominant straight axis/.test(status4), status4);
  check('and the piece is untouched', JSON.stringify(sphereAfter) === JSON.stringify(sphereBefore));

  console.log('\n=== 7. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-soften','btn-seal','btn-solidify','btn-join','btn-mask-paint','btn-smooth']
    .filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
