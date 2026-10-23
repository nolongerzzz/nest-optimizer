/* End-to-end evidence for the Scale card's Offset, driven through the real app.
   node tools/nso_wire_offset_test.js        exit 0 = every gate held

   Offset is Fatten and Shrink folded into one signed number (Scale part 3):
   the outside moves by the mm entered, the inner faces follow, walls and
   floors keep their thickness. The geometry proofs live in
   tools/nso_box_scale_test.js; what this file exists to prove is that the
   Finish menu's Fatten / Shrink buttons are gone, that the Offset row shows
   everywhere but on a ring or rod, that its commit rebuilds the piece
   the app draws, that Undo names it and restores the soup, that a refusal
   changes nothing and pushes no undo, that paint stands it down, and -
   section 7, kept from the Fatten wire test this replaces - that the two
   Thicken buttons still do exactly what they did, now that Thicken's offset
   has a wall-kept mode. */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openMenuFor, ROOT } = require('./nso_app_harness');

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
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6, soup: Array.from(s).join(','),
           size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) } };
});

const select = (page, id) => page.evaluate(i => selectPlaced(state.placed.findIndex(p => p.sourceId === i)), id);

/* The card, open and read. */
async function card(page) {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => {
    const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none'; };
    return { readout: document.getElementById('scale-readout').textContent, offset: shown('scale-offset-row'),
             diameter: shown('scale-rod-diameter-row'), length: shown('scale-length-row'),
             value: document.getElementById('scale-offset').value };
  });
}

/* The live field (#187: no Set): typed on the keyboard and left with Tab,
   which is what commits it. */
async function offset(page, mm, waitRe) {
  await openMenuFor(page, '#scale-offset');
  await page.focus('#scale-offset');
  await page.keyboard.press('Control+A');
  if (String(mm) === '') await page.keyboard.press('Backspace');
  else await page.keyboard.type(String(mm));
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.keyboard.press('Tab');
  await page.waitForFunction(re => new RegExp(re).test(document.getElementById('status').textContent), waitRe || 'Offset', { timeout: 60000 });
  return statusOf(page);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. Fatten / Shrink are gone; the Offset row is there and wired ===');
  const ui = await page.evaluate(() => {
    const i = document.getElementById('scale-offset');
    return { gone: ['btn-fatten-grow', 'btn-fatten-shrink', 'inp-fatten-mm'].filter(id => document.getElementById(id)),
             wired: !!i && i.dataset.nsoWired === '1', input: !!i && i.type === 'number',
             inScale: !!i && !!i.closest('#scale-card') };
  });
  check('no Fatten / Shrink control left in the Finish menu', ui.gone.length === 0, ui.gone.join(','));
  check('#scale-offset is a live numeric field on the Scale card, wired at load', ui.wired && ui.input && ui.inScale);

  console.log('\n=== 2. shown everywhere but on a ring or rod ===');
  const pin = await loadSTL(page, fx('pin.stl'));
  await select(page, pin);
  const cp = await card(page);
  console.log('   pin:    ' + cp.readout);
  check('pin.stl (a rod): Diameter and Length shown, no Offset', cp.diameter && cp.length && !cp.offset);
  const sphereId = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await select(page, sphereId);
  const csph = await card(page);
  console.log('   sphere: ' + csph.readout);
  check('the curved sphere reads as a sphere (#186): its A / B / C rows, no Offset, no Length', !csph.offset && !csph.length);
  const blobId = await loadSTL(page, fx('fixture_blob_organic.stl'));
  await select(page, blobId);
  const cs = await card(page);
  console.log('   blob:   ' + cs.readout);
  check('a curved blob: Offset shown, no Length', cs.offset && !cs.length);

  console.log('\n=== 3. Offset +0.5 on the blob, typed ===');
  const before = await measure(page);
  const s1 = await offset(page, 0.5, 'Offset (done|refused)|stood down');
  const after = await measure(page);
  console.log('   status: ' + s1);
  console.log('   bbox ' + JSON.stringify(before.size) + ' -> ' + JSON.stringify(after.size));
  check('status reports the offset', /^Offset done - out 0\.5 mm, /.test(s1), s1);
  check('all three sizes grew by 2 x 0.5 mm', ['x', 'y', 'z'].every(k => Math.abs(after.size[k] - before.size[k] - 1) < 0.02),
    ['x', 'y', 'z'].map(k => (after.size[k] - before.size[k]).toFixed(4)).join(' / '));
  check('triangle count preserved, no opening, no non-manifold edge', after.tris === before.tris && after.open <= before.open && after.nm <= before.nm);
  check('volume grew', Math.abs(after.volume) > Math.abs(before.volume), before.volume.toFixed(2) + ' -> ' + after.volume.toFixed(2));
  check('the field is cleared for the next one', (await card(page)).value === '');

  console.log('\n=== 4. Undo puts the piece back, and names Offset ===');
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const s2 = await statusOf(page);
  const undone = await measure(page);
  console.log('   status: ' + s2);
  check('undo names Offset', /Undo: Offset reverted/.test(s2), s2);
  check('the whole soup is back, coordinate for coordinate', undone.soup === before.soup);

  console.log('\n=== 5. a shrink, and a shrink through the floor ===');
  const s3 = await offset(page, -0.5, 'Offset (done|refused)|stood down');
  const shrunk = await measure(page);
  console.log('   status: ' + s3);
  check('Offset -0.5 shrinks every size by 1 mm', /^Offset done - in 0\.5 mm/.test(s3) &&
    ['x', 'y', 'z'].every(k => Math.abs(before.size[k] - shrunk.size[k] - 1) < 0.02), s3);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Offset reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const undoDepth = await page.evaluate(() => state.undoStack.length);
  const s4 = await offset(page, -1000, 'Offset (done|refused)|stood down');
  console.log('   status: ' + s4);
  check('Offset -1000 refused, naming the floor', /^Offset refused - piece unchanged \(its . size of .* would go through zero, under the 0\.42 mm floor/.test(s4), s4);
  check('the piece is byte-for-byte unchanged and no undo entry was pushed',
    (await measure(page)).soup === before.soup && (await page.evaluate(() => state.undoStack.length)) === undoDepth);
  const depth5 = await page.evaluate(() => state.undoStack.length);
  await openMenuFor(page, '#scale-offset');
  await page.focus('#scale-offset');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Tab');
  check('an empty field, left, changes nothing and pushes no undo step (a live field: empty is no change)',
    (await measure(page)).soup === before.soup && (await page.evaluate(() => state.undoStack.length)) === depth5);

  console.log('\n=== 6. paint wins ===');
  await page.evaluate(() => {
    getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  });
  const painted = await measure(page);
  const s6 = await offset(page, 0.5, 'stood down|Offset');
  console.log('   status: ' + s6);
  check('stood down, naming the painted count', /^Scale stood down - 1 painted face\(s\); Offset moves faces/.test(s6), s6);
  check('piece is byte-for-byte unchanged', JSON.stringify(await measure(page)) === JSON.stringify(painted));
  await page.evaluate(() => { getActiveModel().faceMask = null; });
  await page.evaluate(() => { const d = document.querySelector('.vp-finish-menu'); if (d) d.open = true;
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(x => { x.open = true; }); });

  console.log('\n=== 7. REGRESSION: Thicken (arm, Set) still behaves exactly as before ===');
  await select(page, sphereId);
  // Offset's whole claim is that wallKept is additive to Thicken. The sphere is the
  // sharpest case for that: it has no axis at all, so if the axis restriction
  // had leaked into Thicken's default path this is where it would show.
  {
    const b = await measure(page);
    // The Thicken buttons arm a live ghost now (app-thicken-live.js); Set bakes it,
    // through the same thickenSelectedModel. The slider's default is 1.5.
    await page.click('#btn-thicken-out');
    await page.click('#btn-thicken-set');
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
    await page.click('#btn-thicken-in');
    await page.click('#btn-thicken-set');
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
  console.log(fails ? 'WIRE OFFSET: ' + fails + ' FAILED' : 'WIRE OFFSET: all checks passed');
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error('WIRE OFFSET FAIL', e); process.exit(1); });
