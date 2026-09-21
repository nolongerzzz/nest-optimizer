/* End-to-end evidence for the Mirror button, driven through the real app.
   node tools/nso_wire_mirror_test.js        exit 0 = every gate held

   Same shape as tools/nso_wire_extend_test.js: real index.html, real clicks,
   real undo. The geometry proofs live in tools/nso_mirror_test.js. This file
   proves the button is reachable, the commit half rebuilds the piece the app
   draws, undo names Mirror, and paint stands it down. Soften is not pressed. */

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
  let v = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    v += (s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
        - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
        + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]));
  }
  const yz = [];
  for (let i = 0; i < s.length; i += 3) yz.push(s[i + 1], s[i + 2]);
  yz.sort((a, b) => a - b);
  let xMin = Infinity, xMax = -Infinity;
  for (let i = 0; i < s.length; i += 3) {
    if (s[i] < xMin) xMin = s[i];
    if (s[i] > xMax) xMax = s[i];
  }
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
           yz: yz.join(','), soup: Array.from(s).join(','),
           xMin, xMax };
});

const openFinishMenu = page => page.evaluate(() => {
  const b = document.getElementById('btn-mirror');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
});

withApp(async (page, logs) => {
  console.log('\n=== 1. the control exists and is reachable ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-mirror');
    const i = document.getElementById('inp-mirror-plane');
    return { btn: !!b, text: b ? b.textContent.trim() : '', wired: !!b && b.dataset.nsoWired === '1',
             input: !!i, type: i ? i.type : '' };
  });
  check('#btn-mirror present in the DOM', ui.btn, ui.btn ? 'label "' + ui.text + '"' : 'missing');
  check('listener attached at load', ui.wired);
  check('#inp-mirror-plane present and numeric', ui.input && ui.type === 'number');

  console.log('\n=== 2. a blank box reports the detected axis and the clean-band cut ===');
  const id = await loadSTL(page, fx('lid_strap.stl'));
  await selectModel(page, id);
  await openFinishMenu(page);
  await page.click('#btn-mirror');
  await page.waitForFunction(() => /Mirror/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status0 = await statusOf(page);
  const prefilled = await page.evaluate(() => document.getElementById('inp-mirror-plane').value);
  console.log('   status: ' + status0);
  check('names the detected axis', /along X/.test(status0), status0);
  check('names the clean-band cut', /Plane 30\b/.test(status0) && /clean-band cut/.test(status0), status0);
  check('prefills the box with that plane', prefilled === '30', 'value "' + prefilled + '"');

  console.log('\n=== 3. real click: lid_strap reflected across X = 0 ===');
  const before = await measure(page);
  await page.fill('#inp-mirror-plane', '0');
  await page.click('#btn-mirror');
  await page.waitForFunction(() => /Mirror done|Mirror refused/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status1 = await statusOf(page);
  const after = await measure(page);
  console.log('   status: ' + status1);
  check('status reports a completed mirror', /Mirror done/.test(status1), status1);
  check('X negated: 0..60 became -60..0', after.xMin === -before.xMax && after.xMax === -before.xMin,
    after.xMin + '..' + after.xMax);
  check('every Y and Z coordinate is still present', after.yz === before.yz);
  check('triangle count preserved', after.tris === before.tris);
  check('volume stayed positive and equal', after.volume === before.volume && after.volume > 0,
    before.volume + ' → ' + after.volume);
  check('did not open the mesh', after.open <= before.open, before.open + ' → ' + after.open);

  console.log('\n=== 4. Undo puts the piece back and names Mirror ===');
  const undoEnabled = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo button enabled after mirror', undoEnabled);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });
  const undone = await measure(page);
  const status2 = await statusOf(page);
  check('undo names Mirror', /Undo: Mirror reverted/.test(status2), status2);
  check('the whole soup is back, coordinate for coordinate', undone.soup === before.soup);

  console.log('\n=== 5. paint wins: a painted piece is a stand-down ===');
  await page.evaluate(() => {
    const m = getActiveModel();
    m.faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const paintedBefore = await measure(page);
  const res = await page.evaluate(() => NSO_mirrorSelectedModel({ plane: 0 }));
  const paintedAfter = await measure(page);
  const status3 = await statusOf(page);
  check('declined', res.ok === false, 'reason: ' + res.reason);
  check('status names the painted count', /stood down - 1 painted face/.test(status3), status3);
  check('piece is byte-for-byte unchanged', JSON.stringify(paintedAfter) === JSON.stringify(paintedBefore));

  console.log('\n=== 6. a curved piece is refused in Extend\'s words ===');
  await page.evaluate(() => { getActiveModel().faceMask = null; });
  const sphereId = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await selectModel(page, sphereId);
  const sphereBefore = await measure(page);
  await page.fill('#inp-mirror-plane', '0');
  await page.click('#btn-mirror');
  await page.waitForFunction(() => /Mirror refused/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status4 = await statusOf(page);
  const sphereAfter = await measure(page);
  check('refused: no dominant straight axis', /no dominant straight axis/.test(status4), status4);
  check('and the piece is untouched', JSON.stringify(sphereAfter) === JSON.stringify(sphereBefore));

  console.log('\n=== 7. Soften is still its own button ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-soften', 'btn-seal', 'btn-solidify', 'btn-join',
    'btn-mask-paint', 'btn-smooth', 'btn-extend'].filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
