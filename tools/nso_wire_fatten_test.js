/* End-to-end evidence for the Fatten buttons, driven through the real app.
   node tools/nso_wire_fatten_test.js        exit 0 = every gate held

   Same shape as tools/nso_wire_extend_test.js: real index.html, real script
   tags, real clicks, real undo. The geometry proofs live in
   tools/nso_fatten_test.js; what this file exists to prove is that the two
   buttons are reachable, that Fatten's commit half rebuilds the piece the app
   actually draws, that undo names Fatten and restores the soup, that paint
   stands it down, and - section 7 - that the two Thicken buttons next to it
   still do exactly what they did before Fatten was wired in. */

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
  // pin.stl runs along raw X. xLo / xHi are the two end faces - what "the
  // length is held" is a statement about - and they are reported raw so the
  // comparison can be exact rather than rounded. xMoved counts the coordinates
  // that did shift, which on a chamfered piece is not zero and should not be:
  // see section 3.
  let xLo = Infinity, xHi = -Infinity;
  const xs = [];
  for (let i = 0; i < s.length; i += 3) {
    xs.push(s[i]);
    if (s[i] < xLo) xLo = s[i];
    if (s[i] > xHi) xHi = s[i];
  }
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
           xLo, xHi, xs, soup: Array.from(s).join(','),
           size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) } };
});

const openFinishMenu = page => page.evaluate(() => {
  const b = document.getElementById('btn-fatten-grow');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
});

withApp(async (page, logs) => {
  console.log('\n=== 1. the controls exist and are reachable ===');
  const ui = await page.evaluate(() => {
    const g = document.getElementById('btn-fatten-grow');
    const s = document.getElementById('btn-fatten-shrink');
    const i = document.getElementById('inp-fatten-mm');
    return {
      grow: !!g, growText: g ? g.textContent.trim() : '', growWired: !!g && g.dataset.nsoWired === '1',
      shrink: !!s, shrinkText: s ? s.textContent.trim() : '', shrinkWired: !!s && s.dataset.nsoWired === '1',
      input: !!i, type: i ? i.type : ''
    };
  });
  check('#btn-fatten-grow present in the DOM', ui.grow, ui.grow ? 'label "' + ui.growText + '"' : 'missing');
  check('#btn-fatten-shrink present in the DOM', ui.shrink, ui.shrink ? 'label "' + ui.shrinkText + '"' : 'missing');
  check('both listeners attached at load', ui.growWired && ui.shrinkWired);
  check('#inp-fatten-mm present and numeric', ui.input && ui.type === 'number');

  console.log('\n=== 2. a blank box reports the piece instead of failing ===');
  const id = await loadSTL(page, fx('pin.stl'));
  await selectModel(page, id);
  await openFinishMenu(page);
  await page.evaluate(() => { document.getElementById('inp-fatten-mm').value = ''; });
  await page.click('#btn-fatten-grow');
  await page.waitForFunction(() => /Fatten/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status0 = await statusOf(page);
  console.log('   status: ' + status0);
  check('names the detected axis and says the length is the held one',
        /runs along X \(20\.00 mm, held\)/.test(status0), status0);
  check('and reports the cross-section it is about to move',
        /Cross-section Y 3\.00, Z 3\.00 mm/.test(status0), status0);

  console.log('\n=== 3. real STL, real click: pin.stl 3 mm section -> 4 mm, 20 mm stays 20 ===');
  const before = await measure(page);
  console.log('   before  tris ' + before.tris + '  open ' + before.open + '  nm ' + before.nm +
              '  vol ' + before.volume.toFixed(3) + '  bbox ' + JSON.stringify(before.size));
  await page.fill('#inp-fatten-mm', '0.5');
  await page.click('#btn-fatten-grow');
  await page.waitForFunction(() => /Fatten grow|Fatten refused|Fatten failed/.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const after = await measure(page);
  const status1 = await statusOf(page);
  console.log('   after   tris ' + after.tris + '  open ' + after.open + '  nm ' + after.nm +
              '  vol ' + after.volume.toFixed(3) + '  bbox ' + JSON.stringify(after.size));
  console.log('   status: ' + status1);
  check('status reports a completed grow', /^Fatten grow 0\.5 - /.test(status1), status1);
  check('status names the held axis', /X length held/.test(status1), status1);
  check('status counts the moved cross-section faces and the held ones',
        /64 cross-section face\(s\) moved, 192 held/.test(status1), status1);
  // The app draws Y-up: m.size.x is the raw soup's X (the pin's length), and
  // the other two are the cross-section.
  check('the app\'s own bbox still reads 20 mm along the axis', after.size.x === 20,
        before.size.x + ' -> ' + after.size.x);
  check('both end faces are bit-for-bit where they were - the length is HELD, not re-derived',
        after.xLo === before.xLo && after.xHi === before.xHi,
        'X ' + before.xLo + '..' + before.xHi + ' -> ' + after.xLo + '..' + after.xHi);
  // Not every X is unchanged, and that is the design rather than a leak. The
  // ring where the 0.1 mm chamfer meets the shaft sits on a HELD chamfer plane
  // and a MOVING shaft plane, so it slides ALONG the chamfer: 0.1 -> 0.6 mm in
  // X as the radius goes out by 0.5. The chamfer keeps its 45 degrees and its
  // position and grows to suit, which is the only answer available while both
  // the end face and the chamfer plane stay put. The two layers that define
  // the length - checked above - do not move at all.
  {
    const movedX = after.xs.filter((v, i) => v !== before.xs[i]).length;
    const interior = after.xs.filter((v, i) => v !== before.xs[i])
                             .filter(v => v > before.xLo && v < before.xHi).length;
    check('the X coordinates that did move are all interior chamfer rings',
          movedX > 0 && interior === movedX,
          movedX + ' of ' + before.xs.length + ' moved, all strictly inside 0..20');
  }
  check('the cross-section grew by 2 x 0.5 mm on both axes',
        Math.abs(after.size.y - before.size.y - 1) < 5e-3 &&
        Math.abs(after.size.z - before.size.z - 1) < 5e-3,
        JSON.stringify(before.size) + ' -> ' + JSON.stringify(after.size));
  check('triangle count preserved - nothing re-tessellated', after.tris === before.tris,
        before.tris + ' -> ' + after.tris);
  check('did not open the mesh', after.open <= before.open, before.open + ' -> ' + after.open);
  check('did not add non-manifold edges', after.nm <= before.nm, before.nm + ' -> ' + after.nm);
  check('volume grew - a fatter pin has more material in it',
        Math.abs(after.volume) > Math.abs(before.volume),
        before.volume.toFixed(3) + ' -> ' + after.volume.toFixed(3) + ' mm3');

  console.log('\n=== 4. Undo puts the piece back, and names Fatten ===');
  const undoEnabled = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo button enabled after fatten', undoEnabled);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });
  const undone = await measure(page);
  const status2 = await statusOf(page);
  console.log('   status: ' + status2);
  check('undo names Fatten, not Thicken or another bake', /Undo: Fatten reverted/.test(status2), status2);
  check('volume restored exactly', undone.volume === before.volume,
        before.volume.toFixed(6) + ' -> ' + undone.volume.toFixed(6));
  check('bbox restored exactly', JSON.stringify(undone.size) === JSON.stringify(before.size));
  check('the whole soup is back, coordinate for coordinate', undone.soup === before.soup,
        before.soup.split(',').length + ' floats compared');

  console.log('\n=== 5. shrink, and the gate that stops it eating the chamfer ===');
  await page.fill('#inp-fatten-mm', '0.2');
  await page.click('#btn-fatten-shrink');
  await page.waitForFunction(() => /Fatten shrink/.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const statusTooFar = await statusOf(page);
  const afterRefusal = await measure(page);
  console.log('   status: ' + statusTooFar);
  check('0.2 mm off pin.stl is refused - more than its 0.1 mm chamfer',
        /^Fatten shrink 0\.2 failed/.test(statusTooFar) && /turn inside out/.test(statusTooFar),
        statusTooFar);
  check('the piece is byte-for-byte unchanged by the refusal',
        afterRefusal.soup === before.soup);
  check('and the refusal pushed no undo entry',
        await page.evaluate(() => document.getElementById('btn-undo').disabled));

  await page.fill('#inp-fatten-mm', '0.1');
  await page.click('#btn-fatten-shrink');
  await page.waitForFunction(() => /Fatten shrink 0\.1 - /.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const shrunk = await measure(page);
  const statusShrink = await statusOf(page);
  console.log('   status: ' + statusShrink);
  check('0.1 mm - exactly the chamfer width - goes through', /X length held/.test(statusShrink), statusShrink);
  check('length still exactly 20 mm', shrunk.size.x === 20, before.size.x + ' -> ' + shrunk.size.x);
  check('  ...and both end faces are still bit-for-bit where they were',
        shrunk.xLo === before.xLo && shrunk.xHi === before.xHi,
        'X ' + shrunk.xLo + '..' + shrunk.xHi);
  check('cross-section came in by 2 x 0.1 mm',
        Math.abs(before.size.y - shrunk.size.y - 0.2) < 5e-3,
        before.size.y + ' -> ' + shrunk.size.y);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Fatten reverted/.test(document.getElementById('status').textContent),
    null, { timeout: 15000 });

  console.log('\n=== 6. paint wins, and a curved piece is refused by name ===');
  await page.evaluate(() => {
    const m = getActiveModel();
    m.faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const paintedBefore = await measure(page);
  const res = await page.evaluate(() => NSO_fattenSelectedModel('grow', 0.5));
  const paintedAfter = await measure(page);
  const status3 = await statusOf(page);
  console.log('   status: ' + status3);
  check('declined', res.ok === false, 'reason: ' + res.reason);
  check('status names Fatten and the painted count',
        /Fatten stood down - 1 painted face/.test(status3), status3);
  check('piece is byte-for-byte unchanged',
        JSON.stringify(paintedAfter) === JSON.stringify(paintedBefore));

  await page.evaluate(() => { getActiveModel().faceMask = null; });
  const sphereId = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await selectModel(page, sphereId);
  const sphereBefore = await measure(page);
  await page.fill('#inp-fatten-mm', '0.5');
  await page.click('#btn-fatten-grow');
  await page.waitForFunction(() => /Fatten refused/.test(document.getElementById('status').textContent),
    null, { timeout: 30000 });
  const status4 = await statusOf(page);
  const sphereAfter = await measure(page);
  console.log('   status: ' + status4);
  check('a curved piece is refused by name', /no dominant straight axis/.test(status4), status4);
  check('and the piece is untouched', JSON.stringify(sphereAfter) === JSON.stringify(sphereBefore));

  console.log('\n=== 7. REGRESSION: the Thicken buttons still behave exactly as before ===');
  // Fatten's whole claim is that it is additive to Thicken. The sphere is the
  // sharpest case for that: it has no axis at all, so if the axis restriction
  // had leaked into Thicken's default path this is where it would show.
  {
    const b = await measure(page);
    await page.fill('#inp-thicken-mm', '1.5');
    await page.click('#btn-thicken-out');
    await page.waitForFunction(() => /^Thicken out 1\.5 /.test(document.getElementById('status').textContent),
      null, { timeout: 60000 });
    const st = await statusOf(page);
    const a = await measure(page);
    console.log('   status: ' + st);
    check('Thicken out 1.5 on a sphere still succeeds and still says "Thicken out"',
          /^Thicken out 1\.5 - 2208 outer face\(s\) moved, 0 held/.test(st), st);
    check('  ...and it still grows all three axes, the whole-surface offset it always was',
          Math.abs(a.size.x - b.size.x - 3) < 0.05 &&
          Math.abs(a.size.y - b.size.y - 3) < 0.05 &&
          Math.abs(a.size.z - b.size.z - 3) < 0.05,
          JSON.stringify(b.size) + ' -> ' + JSON.stringify(a.size));
    await page.click('#btn-undo');
    await page.waitForFunction(() => /Undo: Thicken reverted/.test(document.getElementById('status').textContent),
      null, { timeout: 15000 });
    const u = await measure(page);
    check('  ...and undo still names Thicken and restores the soup exactly', u.soup === b.soup);
  }
  {
    // box_open.stl is the pocket fixture Thicken in exists for - the non-tube
    // case that must not have learned anything about axes.
    const boxId = await loadSTL(page, fx('box_open.stl'));
    await selectModel(page, boxId);
    const b = await measure(page);
    await page.fill('#inp-thicken-mm', '1.5');
    await page.click('#btn-thicken-in');
    await page.waitForFunction(() => /^Thicken in 1\.5 /.test(document.getElementById('status').textContent),
      null, { timeout: 60000 });
    const st = await statusOf(page);
    const a = await measure(page);
    console.log('   status: ' + st);
    check('Thicken in 1.5 on the open box still moves the cavity and only the cavity',
          /^Thicken in 1\.5 - 10 inner face\(s\) moved, 58 held/.test(st), st);
    check('  ...outer bbox untouched, exactly as before',
          JSON.stringify(a.size) === JSON.stringify(b.size),
          JSON.stringify(b.size) + ' -> ' + JSON.stringify(a.size));
    check('  ...and the cavity really did move (volume rose)',
          Math.abs(a.volume) > Math.abs(b.volume),
          b.volume.toFixed(3) + ' -> ' + a.volume.toFixed(3) + ' mm3');
    await page.click('#btn-undo');
    await page.waitForFunction(() => /Undo: Thicken reverted/.test(document.getElementById('status').textContent),
      null, { timeout: 15000 });
    check('  ...undo restores it coordinate for coordinate',
          (await measure(page)).soup === b.soup);
  }

  console.log('\n=== 8. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const stillThere = await page.evaluate(() => ['btn-soften','btn-seal','btn-solidify','btn-join','btn-mask-paint','btn-smooth','btn-extend','btn-thicken-out','btn-thicken-in']
    .filter(i => !document.getElementById(i)));
  check('existing buttons all still present', stillThere.length === 0, stillThere.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails ? 'WIRE FATTEN: ' + fails + ' FAILED' : 'WIRE FATTEN: all checks passed');
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error('WIRE FATTEN FAIL', e); process.exit(1); });
