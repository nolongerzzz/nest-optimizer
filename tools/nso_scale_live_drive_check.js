/* The Scale card's live fields, driven through the real app with a real
   keyboard: no Set - typing applies, leaving the field commits.
   node tools/nso_scale_live_drive_check.js     exit 0 = every gate held

     1  the card has no Set button: Fit to plate and the mm | in toggle are
        its only buttons
     2  three values typed into Length, one after another, without leaving
        the field: the piece changes three times and the readout follows
        each; the undo stack grows by one, not three. Tab commits: the
        piece is exactly NSO_extendRaw of the STARTING soup at the last
        value - each value runs on the piece as it was when the edit
        began, not on the last one shown - and one Undo restores the start
        coordinate for coordinate
     3  Escape: a typed value shown, then Escape - the piece, the field and
        the undo stack are back where they were
     4  a refused value (Height 1.5 on the tray, under its floor): the reason
        is under the field in red while it is typed, the piece is unchanged
        and the undo stack too; after a good value (Height 30) a refused one
        leaves the piece at 30; leaving the field on it commits nothing and
        the field reads 25.0 again
     5  Enter commits too, and the field keeps the focus
     6  Offset and the ring rows behave the same way: Offset 1 live then
        Tab, one Undo; a tube's Outer Ø live then Escape; its Wall under the
        floor refused in place

   Every number is printed; the PR quotes them. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf, openMenuFor } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const BOX = require('./nso_box_fixtures.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const select = (page, id) => page.evaluate(i => {
  const idx = state.placed.findIndex(p => p.sourceId === i);
  selectPlaced(idx);
}, id);

const card = async page => {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
};

/* The piece as it stands, and the card around one field. */
const look = (page, input) => page.evaluate(id => {
  const m = getActiveModel(), why = document.getElementById(id + '-why');
  return {
    span: Array.from(NSO_scaleRawBounds(m.rawTris).span),
    soupIsStart: m.rawTris === window.__nsoStart,
    soup: Array.from(m.rawTris).join(','),
    undo: state.undoStack.length,
    value: document.getElementById(id).value,
    readout: document.getElementById('scale-readout').textContent,
    status: document.getElementById('status').textContent,
    why: why && !why.hidden ? why.textContent : '',
    whyRed: why ? getComputedStyle(why).color : '',
    focused: document.activeElement && document.activeElement.id,
    seen: window.__nsoSeen ? window.__nsoSeen.length - 1 : null
  };
}, input);

/* Keep the piece as it stands, and count every soup it shows from here on. */
const keepStart = page => page.evaluate(() => {
  window.__nsoStart = getActiveModel().rawTris;
  window.__nsoSeen = [window.__nsoStart];
  if (!window.__nsoWatch) {
    window.__nsoWatch = true;
    (function f() {
      const t = getActiveModel() && getActiveModel().rawTris;
      if (t && t !== window.__nsoSeen[window.__nsoSeen.length - 1]) window.__nsoSeen.push(t);
      requestAnimationFrame(f);
    })();
  }
});

/* Type into a field as a person does: focus it, select what is there, type.
   The field is not left. */
async function type(page, input, text) {
  await openMenuFor(page, '#' + input);
  await page.focus('#' + input);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(text));
}
const waitSpan = (page, k, want) => page.waitForFunction(([k, w]) =>
  Math.abs(NSO_scaleRawBounds(getActiveModel().rawTris).span[k] - w) < 1e-3, [k, want], { timeout: 30000 });
const waitWhy = (page, input) => page.waitForFunction(id => {
  const w = document.getElementById(id + '-why'); return w && !w.hidden && w.textContent.length > 0;
}, input, { timeout: 30000 });
// The debounce is 80 ms; a refused value changes nothing, so give it time to be seen.
const settle = page => page.waitForTimeout(400);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scale-live-'));
  const trayFile = path.join(tmp, 'tray_100x40x25.stl');
  writeSTL(trayFile, BOX.tray(100, 40, 25, 2, 2), 'tray 100 x 40 x 25, 2 mm walls and floor (tools/nso_box_fixtures.js)');
  const trayId = await loadSTL(page, trayFile);
  await select(page, trayId);
  await card(page);

  console.log('\n=== 1. no Set ===');
  const btns = await page.evaluate(() => Array.from(document.querySelectorAll('#scale-card button')).map(b => b.id));
  console.log('   buttons: ' + btns.join(', '));
  check('the card\'s only buttons are the mm | in toggle and Fit to plate',
    btns.join() === 'btn-scale-unit-mm,btn-scale-unit-in,btn-scale-fit', btns.join());

  console.log('\n=== 2. Length: three values typed, one Undo ===');
  await keepStart(page);
  const a0 = await look(page, 'scale-length');
  console.log('   start:  X ' + a0.span[0] + ', undo ' + a0.undo + ', "' + a0.readout + '"');
  const typed = [110, 125, 130], steps = [];
  for (const v of typed) {
    await type(page, 'scale-length', v);
    await waitSpan(page, 0, v);
    const s = await look(page, 'scale-length');
    steps.push(s);
    console.log('   typed ' + v + ': X ' + s.span[0].toFixed(4) + ', undo ' + s.undo + ', field "' + s.value + '", "' + s.readout.slice(0, 26) + '…"');
    console.log('     status: ' + s.status);
  }
  check('the piece changed three times, one per value typed, without leaving the field',
    steps[2].seen === 3 && steps.every((s, i) => Math.abs(s.span[0] - typed[i]) < 1e-3 && s.focused === 'scale-length'),
    'soups shown ' + steps[2].seen);
  check('the readout followed each one', steps.every((s, i) => s.readout.indexOf(typed[i].toFixed(1) + ' L') === 0),
    steps.map(s => s.readout.slice(0, 7)).join(' / '));
  check('the field kept what was typed', steps.every((s, i) => s.value === String(typed[i])), steps.map(s => s.value).join(' / '));
  check('one undo step for the edit, not three', steps.every(s => s.undo === a0.undo + 1), steps.map(s => s.undo).join(' / '));
  check('...and nothing is said done before the field is left', steps.every(s => !/done/.test(s.status)), steps[2].status);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => /^Length done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const a1 = await look(page, 'scale-length');
  console.log('   Tab:    ' + a1.status);
  check('Tab commits: "Length done - X 100.0 → 130.0 mm", the field re-reads 130.0, still one undo step',
    /^Length done - X 100\.0 → 130\.0 mm \(inserted at X /.test(a1.status) && a1.value === '130.0' && a1.undo === a0.undo + 1, a1.value);
  const eq = await page.evaluate(() => {
    const r = NSO_extendRaw(window.__nsoStart, { axis: 0, length: 130 }), got = getActiveModel().rawTris;
    if (!r.ok) return 'engine refused: ' + r.reason;
    if (r.tris.length !== got.length) return 'length ' + r.tris.length + ' vs ' + got.length;
    for (let i = 0; i < got.length; i++) if (r.tris[i] !== got[i]) return 'float ' + i;
    return 'ok ' + got.length;
  });
  check('the piece is NSO_extendRaw(start, 130) float for float - each value ran on the starting piece', /^ok/.test(eq), eq);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await card(page);
  const a2 = await look(page, 'scale-length');
  console.log('   Undo:   ' + a2.status);
  check('one Undo restores the start, coordinate for coordinate, and the field reads 100.0',
    a2.soup === a0.soup && a2.undo === a0.undo && a2.value === '100.0', a2.value + ', undo ' + a2.undo);

  console.log('\n=== 2b. inches shown: the readout follows in inches ===');
  await openMenuFor(page, '#btn-scale-unit-in');
  await page.click('#btn-scale-unit-in');
  await card(page);
  await keepStart(page);
  const i0 = await look(page, 'scale-length');
  await type(page, 'scale-length', 5);
  await waitSpan(page, 0, 127);
  const i1 = await look(page, 'scale-length');
  console.log('   typed 5 in: X ' + i1.span[0].toFixed(4) + ' mm, "' + i1.readout.slice(0, 30) + '…"');
  check('Length 5 typed in inches: the piece is 127 mm and the readout says 5.000 L, live',
    Math.abs(i1.span[0] - 127) < 1e-3 && i1.readout.indexOf('5.000 L × ' + i0.readout.split(' L × ')[1].split(' W')[0] + ' W') === 0, i1.readout);
  await page.keyboard.press('Escape');
  await waitSpan(page, 0, 100);
  check('...Escape: back to ' + i0.value + ' in, the very soup', (await look(page, 'scale-length')).soupIsStart);
  await page.keyboard.press('Tab');
  await openMenuFor(page, '#btn-scale-unit-mm');
  await page.click('#btn-scale-unit-mm');
  await card(page);

  console.log('\n=== 3. Escape puts it back ===');
  await keepStart(page);
  const e0 = await look(page, 'scale-length');
  await type(page, 'scale-length', 115);
  await waitSpan(page, 0, 115);
  const e1 = await look(page, 'scale-length');
  console.log('   typed 115: X ' + e1.span[0].toFixed(4) + ', undo ' + e1.undo);
  await page.keyboard.press('Escape');
  await waitSpan(page, 0, 100);
  const e2 = await look(page, 'scale-length');
  console.log('   Escape: X ' + e2.span[0].toFixed(4) + ', field "' + e2.value + '", undo ' + e2.undo + ', status ' + e2.status);
  check('typed 115 was shown', Math.abs(e1.span[0] - 115) < 1e-3);
  check('Escape: the field reads 100.0 again, the piece is the very soup it was, the undo stack as it was',
    e2.value === '100.0' && e2.soupIsStart && e2.undo === e0.undo && e2.readout === e0.readout, JSON.stringify({ v: e2.value, u: e2.undo }));
  await page.keyboard.press('Tab');
  await settle(page);
  const e3 = await look(page, 'scale-length');
  check('...and leaving the field after Escape commits nothing', e3.soupIsStart && e3.undo === e0.undo);

  console.log('\n=== 4. A refused value ===');
  await keepStart(page);
  const r0 = await look(page, 'scale-height');
  await type(page, 'scale-height', '1.5');
  await waitWhy(page, 'scale-height');
  await settle(page);
  const r1 = await look(page, 'scale-height');
  console.log('   typed 1.5: why "' + r1.why + '" (' + r1.whyRed + '), undo ' + r1.undo);
  check('the reason is under the field while it is typed: Shorten\'s most',
    /^Shorten can remove up to 22\.9 mm here - asked for 23\.5 mm;/.test(r1.why), r1.why);
  check('...in red', r1.whyRed === 'rgb(248, 113, 113)', r1.whyRed);
  check('...the piece unchanged, nothing on the undo stack', r1.soupIsStart && r1.undo === r0.undo && r1.seen === 0);
  const under = await page.evaluate(() => {
    const w = document.getElementById('scale-height-why').getBoundingClientRect(), f = document.getElementById('scale-height').getBoundingClientRect();
    return w.top >= f.bottom - 0.5;
  });
  check('...and it sits under the field', under);
  await type(page, 'scale-height', 30);
  await waitSpan(page, 2, 30);
  const r2 = await look(page, 'scale-height');
  check('a good value after it: the reason goes, the piece is 30 tall', r2.why === '' && Math.abs(r2.span[2] - 30) < 1e-3, r2.why);
  await type(page, 'scale-height', '1.5');
  await waitWhy(page, 'scale-height');
  await settle(page);
  const r3 = await look(page, 'scale-height');
  console.log('   30 then 1.5: Z ' + r3.span[2].toFixed(4) + ', why "' + r3.why.slice(0, 40) + '…"');
  check('a refused value after a good one leaves the piece at the last good value, 30', Math.abs(r3.span[2] - 30) < 1e-3 && r3.why !== '');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => /^Height refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  await waitSpan(page, 2, 25);
  const r4 = await look(page, 'scale-height');
  console.log('   Tab:    ' + r4.status);
  check('leaving the field on it commits nothing: the very soup it was, the undo stack as it was, the field 25.0',
    r4.soupIsStart && r4.undo === r0.undo && r4.value === '25.0' && r4.why === '', JSON.stringify({ v: r4.value, u: r4.undo }));
  check('...and the status line says why', /^Height refused - piece unchanged \(Shorten can remove up to 22\.9 mm here/.test(r4.status), r4.status);

  console.log('\n=== 5. Enter commits ===');
  await keepStart(page);
  const n0 = await look(page, 'scale-width');
  await type(page, 'scale-width', 50);
  await waitSpan(page, 1, 50);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Width done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const n1 = await look(page, 'scale-width');
  console.log('   Enter:  ' + n1.status);
  check('Enter commits Width 50, one undo step, the field keeps the focus and re-reads 50.0',
    n1.undo === n0.undo + 1 && n1.focused === 'scale-width' && n1.value === '50.0', JSON.stringify({ u: n1.undo, f: n1.focused, v: n1.value }));
  await page.keyboard.press('Tab');
  await settle(page);
  check('...Tab after it commits nothing more', (await look(page, 'scale-width')).undo === n0.undo + 1);
  await page.click('#btn-undo');
  await waitSpan(page, 1, 40);
  check('...one Undo returns the tray', (await look(page, 'scale-width')).soupIsStart);

  console.log('\n=== 6. Offset and the ring rows ===');
  await keepStart(page);
  const o0 = await look(page, 'scale-offset');
  await type(page, 'scale-offset', 1);
  await waitSpan(page, 0, 102);
  const o1 = await look(page, 'scale-offset');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => /^Offset done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const o2 = await look(page, 'scale-offset');
  console.log('   Offset 1: ' + o2.status);
  check('Offset 1 live (102 x 42 x 27), Tab commits it, one undo step, the field empty again',
    o1.span.map(x => x.toFixed(3)).join() === '102.000,42.000,27.000' && /^Offset done - out 1 mm/.test(o2.status) &&
    o2.undo === o0.undo + 1 && o2.value === '', o1.span.join(' / '));
  await page.click('#btn-undo');
  await waitSpan(page, 0, 100);
  check('...one Undo returns the tray', (await look(page, 'scale-offset')).soupIsStart);

  // A tube: the Stock card's tube at its defaults, 40 tall.
  const nModels = await page.evaluate(() => state.models.length);
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('sel-stock-shape', 'tube'); set('inp-stock-height', '40'); set('inp-stock-radius', ''); set('inp-stock-prop', '');
  });
  await openMenuFor(page, '#btn-stock-make');
  await page.click('#btn-stock-make');
  await page.waitForFunction(k => state.models.length > k, nModels, { timeout: 30000 });
  await select(page, await page.evaluate(() => state.models[state.models.length - 1].id));
  await card(page);
  await keepStart(page);
  const t0 = await look(page, 'scale-ring-outer');
  console.log('   tube:   ' + t0.readout + '   Outer Ø "' + t0.value + '"');
  const outer = +t0.value + 6;
  await type(page, 'scale-ring-outer', outer);
  await waitSpan(page, 0, outer);
  const t1 = await look(page, 'scale-ring-outer');
  console.log('   Outer Ø ' + outer + ': ' + t1.readout + '   undo ' + t1.undo);
  check('Outer Ø typed: the piece and the readout follow, one undo step',
    Math.abs(t1.span[0] - outer) < 1e-3 && t1.readout.indexOf('Ring Ø' + outer.toFixed(1)) === 0 && t1.undo === t0.undo + 1, t1.readout);
  await page.keyboard.press('Escape');
  await waitSpan(page, 0, t0.span[0]);
  const t2 = await look(page, 'scale-ring-outer');
  check('...Escape puts the tube back, the field and the undo stack with it',
    t2.soupIsStart && t2.value === t0.value && t2.undo === t0.undo, JSON.stringify({ v: t2.value, u: t2.undo }));
  await page.keyboard.press('Tab');
  const w0 = await look(page, 'scale-ring-wall');
  await type(page, 'scale-ring-wall', '0.2');
  await waitWhy(page, 'scale-ring-wall');
  await settle(page);
  const t3 = await look(page, 'scale-ring-wall');
  console.log('   Wall 0.2: why "' + t3.why + '"');
  check('Wall 0.2 refused in place, under the floor, the tube unchanged',
    /^wall would be 0\.2 mm, under the 0\.42 mm floor/.test(t3.why) && t3.soupIsStart && t3.undo === t0.undo, t3.why);
  await page.keyboard.press('Escape');
  await settle(page);
  const t4 = await look(page, 'scale-ring-wall');
  check('...Escape clears the reason and puts the field back', t4.why === '' && t4.value === w0.value && t4.soupIsStart && t4.undo === t0.undo,
    JSON.stringify({ why: t4.why, v: t4.value }));

  console.log('\n=== nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
