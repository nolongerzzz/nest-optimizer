/* The Scale card, driven through the real app: read the shape, then Length,
   Whole x and Fit to plate, with real clicks and real Undo.
   node tools/nso_scale_card_drive_check.js        exit 0 = every gate held

   The headless proofs live in tools/nso_section_test.js (the reading) and
   tools/nso_extend_test.js (Shorten). What this file proves is that the card
   the user sees says what those say, in print terms, about a piece made the
   way a user makes one - and that its four verbs do what their labels claim:

     Stock tube        -> the readout is a Ring, with nso_stock.js's own numbers
     Length shorter    -> Shorten; the readout follows; Undo restores the soup
     Length longer     -> Extend
     Whole x 2         -> all three sizes double
     tape_on-edge-single (185 mm on an A1 Mini's 180) -> over by 5.0 mm on W;
                          Fit to plate brings it inside 180 and says the factor;
                          pressed again it already fits and changes nothing
     Stock box         -> Bar
     Stock sphere      -> other: the three sizes and the reason, and no Length

   Every number is printed; the PR quotes them. */

const path = require('path');
const { withApp, loadSTL, statusOf, openMenuFor, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const f1 = x => (+x).toFixed(1);

/* Select a piece through the app's one selection path (selectPlaced), which
   is what a click on it does - and what refreshes the size line the card
   follows. */
const select = (page, id) => page.evaluate(i => {
  const idx = state.placed.findIndex(p => p.sourceId === i);
  selectPlaced(idx);
}, id);

/* Reads the card the way a user does: open the Scale menu (the line is only
   read while the card is open), wait for it to render, read it. */
const card = async page => {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  return readCard(page);
};
const readCard = page => page.evaluate(() => {
  const m = getActiveModel();
  const row = document.getElementById('scale-length-row');
  return {
    readout: document.getElementById('scale-readout').textContent,
    lengthShown: !!row && getComputedStyle(row).display !== 'none',
    lengthBox: document.getElementById('scale-length').value,
    size: m ? { x: m.size.x, y: m.size.y, z: m.size.z } : null,
    soup: m ? Array.from(m.rawTris).join(',') : ''
  };
});

const setFields = (page, vals) => page.evaluate(v => {
  for (const id of Object.keys(v)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = v[id] === null ? '' : String(v[id]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, vals);

async function makeStock(page, shape) {
  const n = await page.evaluate(() => state.models.length);
  await setFields(page, { 'sel-stock-shape': shape, 'inp-stock-height': 40, 'inp-stock-radius': null, 'inp-stock-prop': null });
  await openMenuFor(page, '#btn-stock-make');
  await page.click('#btn-stock-make');
  await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
  const id = await page.evaluate(() => state.models[state.models.length - 1].id);
  await select(page, id);
  // The generator's own numbers for the same ask, from the same module, the
  // same printer and the card's blank boxes (blank = nso_stock.js's defaults).
  const sizing = await page.evaluate(sh => NSO_Stock.size({ shape: sh, height: 40, printer: NSO_fitCurrentPrinter() }), shape);
  return { id, sizing };
}

async function clickScale(page, sel, waitRe) {
  await openMenuFor(page, sel);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click(sel);
  await page.waitForFunction(re => new RegExp(re).test(document.getElementById('status').textContent),
    waitRe, { timeout: 60000 });
  return statusOf(page);
}

async function undo(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  return statusOf(page);
}

withApp(async (page, logs) => {
  const plate = await page.evaluate(() => state.plate);
  console.log('plate: ' + plate);

  console.log('\n=== 1. Stock tube -> Ring, with the generator\'s numbers ===');
  const tube = await makeStock(page, 'tube');
  const shut = await page.evaluate(() => ({ open: document.getElementById('menu-scale').open,
    stale: document.getElementById('scale-readout').dataset.stale }));
  check('with the Scale menu shut the line is not read (the Stock menu is the open one)',
    !shut.open && shut.stale === '1', JSON.stringify(shut));
  const m = tube.sizing.measure;
  const want = 'Ring Ø' + f1(2 * m.radius) + ' outer · Ø' + f1(2 * m.inner_radius) + ' bore · wall ' +
    f1(m.tube_wall) + ' · length ' + f1(m.height) + ' · fits A1 Mini';
  const c0 = await card(page);
  console.log('   generator: radius ' + m.radius + ', inner_radius ' + m.inner_radius + ', tube_wall ' + m.tube_wall + ', height ' + m.height);
  console.log('   readout:   ' + c0.readout);
  check('the readout is the Ring line, number for number', c0.readout === want, 'want "' + want + '"');
  check('Length is shown (a tube has a straight axis)', c0.lengthShown);
  check('...and prefilled with the real length', +c0.lengthBox === +m.height.toFixed(2), c0.lengthBox);
  const before = c0;

  console.log('\n=== 2. Length shorter -> Shorten; the readout follows; Undo restores ===');
  await setFields(page, { 'scale-length': 30 });
  const s1 = await clickScale(page, '#btn-scale-length', 'Shorten done|refused|stood down');
  const c1 = await card(page);
  console.log('   status:  ' + s1);
  console.log('   readout: ' + c1.readout);
  check('Shorten ran', /^Shorten done - Z 40\.623 → 30\.000 mm/.test(s1), s1);
  check('the readout reads length 30.0, Ø and wall unchanged',
    c1.readout === want.replace('length ' + f1(m.height), 'length 30.0'), c1.readout);
  check('the app\'s height is 30 (display Y = raw Z)', Math.abs(c1.size.y - 30) < 1e-4, String(c1.size.y));
  check('W and D are bit for bit what they were', c1.size.x === before.size.x && c1.size.z === before.size.z);
  const u1 = await undo(page);
  const c1u = await card(page);
  console.log('   undo:    ' + u1);
  console.log('   readout: ' + c1u.readout);
  check('Undo restores the soup coordinate for coordinate', c1u.soup === before.soup);
  check('...and the readout with it', c1u.readout === want, c1u.readout);

  console.log('\n=== 3. Length longer -> Extend ===');
  await setFields(page, { 'scale-length': 50 });
  const s2 = await clickScale(page, '#btn-scale-length', 'Extend done|refused|stood down');
  const c2 = await card(page);
  console.log('   status:  ' + s2);
  console.log('   readout: ' + c2.readout);
  check('Extend ran', /^Extend done - Z 40\.623 → 50\.000 mm/.test(s2), s2);
  check('the readout reads length 50.0, Ø and wall unchanged',
    c2.readout === want.replace('length ' + f1(m.height), 'length 50.0'), c2.readout);
  await undo(page);
  check('Undo restores it', (await card(page)).soup === before.soup);

  console.log('\n=== 4. Whole x 2 -> all three sizes double ===');
  await setFields(page, { 'scale-factor': 2 });
  const s3 = await clickScale(page, '#btn-scale-factor', 'Scale done|refused|stood down');
  const c3 = await card(page);
  console.log('   status:  ' + s3);
  console.log('   size:    ' + [before.size, c3.size].map(s => f1(s.x) + ' x ' + f1(s.z) + ' x ' + f1(s.y)).join('  ->  ') + '  (W x D x H)');
  console.log('   readout: ' + c3.readout);
  const dbl = ['x', 'y', 'z'].map(k => c3.size[k] / before.size[k]);
  check('W, D and H all doubled', dbl.every(r => Math.abs(r - 2) < 1e-6), dbl.map(r => r.toFixed(8)).join(' / '));
  check('the readout doubled too: Ø, bore, wall and length',
    c3.readout === 'Ring Ø' + f1(4 * m.radius) + ' outer · Ø' + f1(4 * m.inner_radius) + ' bore · wall ' +
      f1(2 * m.tube_wall) + ' · length ' + f1(2 * m.height) + ' · fits A1 Mini', c3.readout);
  await undo(page);
  check('Undo restores it', (await card(page)).soup === before.soup);

  console.log('\n=== 5. tape_on-edge-single, 185 mm on a 180 mm bed -> Fit to plate ===');
  const tape = await loadSTL(page, path.join(ROOT, 'library', 'tape_on-edge-single.stl'));
  await select(page, tape);
  const c4 = await card(page);
  console.log('   readout: ' + c4.readout);
  check('the verdict says over by 5.0 mm on W', / · over by 5\.0 mm on W$/.test(c4.readout), c4.readout);
  check('the piece is 185 mm along the bed\'s W', Math.abs(c4.size.x - 185) < 1e-4, String(c4.size.x));
  const s4 = await clickScale(page, '#btn-scale-fit', 'Fit to plate|refused|stood down');
  const c5 = await card(page);
  console.log('   status:  ' + s4);
  console.log('   size:    ' + f1(c5.size.x) + ' x ' + f1(c5.size.z) + ' x ' + f1(c5.size.y) + ' W x D x H  (W ' + c5.size.x + ')');
  console.log('   readout: ' + c5.readout);
  const factor = 180 / 185;
  check('Fit to plate says the factor', s4.indexOf('×' + factor.toFixed(6)) >= 0, s4);
  check('...and that it now fits', /fits A1 Mini( \||$)/.test(s4), s4);
  check('W is inside 180, by the fit check\'s own 1e-4 mm', c5.size.x <= 180 + 1e-4, String(c5.size.x));
  check('the other two shrank by the same factor',
    Math.abs(c5.size.y / c4.size.y - factor) < 1e-6 && Math.abs(c5.size.z / c4.size.z - factor) < 1e-6);
  check('the readout\'s verdict follows: fits A1 Mini', / · fits A1 Mini$/.test(c5.readout), c5.readout);
  const s5 = await clickScale(page, '#btn-scale-fit', 'Fit to plate');
  const c6 = await card(page);
  console.log('   again:   ' + s5);
  check('pressed again: already fits, nothing changed', /already fits A1 Mini/.test(s5) && /nothing changed/.test(s5) && c6.soup === c5.soup, s5);

  console.log('\n=== 6. Stock box -> Bar ===');
  const box = await makeStock(page, 'box');
  const c7 = await card(page);
  const bm = box.sizing.measure;
  console.log('   generator: ' + bm.x + ' x ' + bm.y + ' x ' + bm.z);
  console.log('   readout:   ' + c7.readout);
  check('the readout is a Bar with the generator\'s sides',
    c7.readout === 'Bar ' + f1(bm.x) + ' × ' + f1(bm.y) + ' × ' + f1(bm.z) + ' W × D × L · fits A1 Mini', c7.readout);
  check('Length is shown', c7.lengthShown);

  console.log('\n=== 7. Stock sphere -> other, the reason shown, no Length ===');
  const sph = await makeStock(page, 'sphere');
  const c8 = await card(page);
  const d = f1(sph.sizing.measure.diameter);
  console.log('   generator: diameter ' + sph.sizing.measure.diameter);
  console.log('   readout:   ' + c8.readout);
  check('the three sizes and the reason, on one line',
    c8.readout === d + ' × ' + d + ' × ' + d + ' W × D × H · no straight axis: 100% of the surface is curved or tapered · fits A1 Mini',
    c8.readout);
  check('Length is absent', !c8.lengthShown);

  console.log('\n=== 8. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const gone = await page.evaluate(() => ({ axis: !!document.getElementById('scale-axis'),
    xhz: /X x H x Z/.test(document.getElementById('scale-readout').textContent) }));
  check('the old axis menu and the X x H x Z readout are gone', !gone.axis && !gone.xhz);

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
