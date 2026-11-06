/* The Scale card's sliders and live preview, driven through the real app with
   a real keyboard and real clicks: a slider or a typed value previews on the
   piece, nothing changes until Set.
   node tools/nso_scale_live_drive_check.js     exit 0 = every gate held

     1  the card's buttons: the mm | in toggle, Set, Cancel, Fit to plate - Set
        and Cancel greyed with nothing staged; every shown row has a slider
        that reads the same number as its box
     2  three values typed into Length, one after another, without leaving the
        field: the PIECE is not touched (the very soup, no undo entry) while a
        preview stands over it at each value, sized as typed; Set (Enter)
        bakes it - exactly NSO_extendRaw of the STARTING soup at the last value
        - as one Undo step, the preview gone; one Undo restores the start
     2b inches shown: a value typed in inches previews at the right mm, the
        slider steps in inches; Escape drops it
     3  Escape and Cancel: a preview shown, then dropped - the piece, the field,
        the slider and the undo stack are back where they were
     3b a slider: dragging Whole x previews, the box follows, Set bakes, the
        slider is re-ranged round the new size
     4  a refused value (Height 1.5 on the tray, under its floor): the reason is
        under the field in red, no preview is drawn, Set is greyed; a good value
        after it previews, a refused one after that clears the preview; Enter on
        the refused value says why and changes nothing
     5  Set (button) and Enter both bake; Tab / leaving the field does not
     6  Offset and the ring rows behave the same way
     7  the preview is dropped by another piece, the other mm | in unit, Fit to
        plate and closing the card - the piece never changed
     8  every field stays staged: Length, Width and Height all adjusted (and
        Length again) before Set - the one preview holds all of them, the piece
        is untouched, Set bakes the final state as one Undo step; a refusal in
        one field names that field, leaves it out of the preview (the others
        still draw) and blocks Set; Escape drops every field

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
    seen: window.__nsoSeen ? window.__nsoSeen.length - 1 : null,
    // the preview: scale-live helpers in the scene, and the first one's size (display x, y, z)
    previews: nsoHelpers.live().filter(o => o.userData.nsoHelper === 'scale-live').length,
    pv: (() => {
      const o = nsoHelpers.live().find(q => q.userData.nsoHelper === 'scale-live');
      if (!o) return null;
      const bb = o.geometry.boundingBox, sc = o.scale;
      return [(bb.max.x - bb.min.x) * sc.x, (bb.max.y - bb.min.y) * sc.y, (bb.max.z - bb.min.z) * sc.z];
    })(),
    setOff: document.getElementById('btn-scale-set').disabled,
    cancelOff: document.getElementById('btn-scale-cancel').disabled,
    note: document.getElementById('scale-preview-note').textContent,
    slider: (() => { const sl = document.getElementById(id + '-slider'); return sl ? { v: sl.value, min: sl.min, max: sl.max, step: sl.step } : null; })()
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

/* The preview stands, sized as typed along display x (the piece's raw X). */
const waitPreview = (page, want, axis) => page.waitForFunction(([w, a]) => {
  const o = nsoHelpers.live().find(q => q.userData.nsoHelper === 'scale-live');
  if (!o) return false;
  const bb = o.geometry.boundingBox, d = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z][a];
  return Math.abs(d - w) < 1e-2;
}, [want, axis || 0], { timeout: 30000 });
const waitNoPreview = page => page.waitForFunction(() =>
  nsoHelpers.live().filter(o => o.userData.nsoHelper === 'scale-live').length === 0, null, { timeout: 30000 });
const status = page => page.evaluate(() => document.getElementById('status').textContent);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scale-live-'));
  const trayFile = path.join(tmp, 'tray_100x40x25.stl');
  writeSTL(trayFile, BOX.tray(100, 40, 25, 2, 2), 'tray 100 x 40 x 25, 2 mm walls and floor (tools/nso_box_fixtures.js)');
  const trayId = await loadSTL(page, trayFile);
  await select(page, trayId);
  await card(page);

  console.log('\n=== 1. the buttons and the sliders ===');
  const btns = await page.evaluate(() => Array.from(document.querySelectorAll('#scale-card button')).map(b => b.id));
  console.log('   buttons: ' + btns.join(', '));
  check('the card\'s buttons are the mm | in toggle, Set, Cancel and Fit to plate',
    btns.join() === 'btn-scale-unit-mm,btn-scale-unit-in,btn-scale-set,btn-scale-cancel,btn-scale-fit', btns.join());
  const ui = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#scale-rows .scale-row')).filter(r => !r.hidden);
    return {
      rows: rows.map(r => r.id.replace(/^scale-|-row$/g, '')),
      sliders: rows.map(r => r.querySelector('input[type=range]')).map(sl => sl ? { id: sl.id, v: sl.value, box: document.getElementById(sl.id.replace(/-slider$/, '')).value, off: sl.disabled } : null),
      set: document.getElementById('btn-scale-set').disabled, cancel: document.getElementById('btn-scale-cancel').disabled
    };
  });
  console.log('   rows: ' + ui.rows.join(', '));
  check('every shown row has a slider, enabled, on the same number as its box (Offset: empty box, slider at 0)',
    ui.sliders.length > 0 && ui.sliders.every(x => x && !x.off && (x.box === '' ? +x.v === 0 : Math.abs(parseFloat(x.v) - parseFloat(x.box)) < 1e-6)), JSON.stringify(ui.sliders));
  check('Set and Cancel are greyed with nothing staged', ui.set && ui.cancel);
  const l0 = await look(page, 'scale-length');
  check('Length\'s slider runs a quarter to four times the length: 25..400', l0.slider.min === '25' && l0.slider.max === '400', JSON.stringify(l0.slider));

  console.log('\n=== 2. Length: three values typed, the piece untouched until Set ===');
  await keepStart(page);
  const a0 = await look(page, 'scale-length');
  console.log('   start:  X ' + a0.span[0] + ', undo ' + a0.undo + ', "' + a0.readout + '"');
  const typed = [110, 125, 130], steps = [];
  for (const v of typed) {
    await type(page, 'scale-length', v);
    await waitPreview(page, v);
    const s = await look(page, 'scale-length');
    steps.push(s);
    console.log('   typed ' + v + ': preview ' + s.pv.map(x => x.toFixed(3)).join(' x ') + ', piece X ' + s.span[0] + ', undo ' + s.undo + ', "' + s.note.slice(0, 60) + '…"');
  }
  check('a preview stands at each value typed, sized as typed (display x), one at a time',
    steps.every((s, i) => s.previews === 1 && Math.abs(s.pv[0] - typed[i]) < 1e-2), steps.map(s => s.pv[0].toFixed(3)).join(' / '));
  check('the piece was not touched: the very soup, no undo entry, the readout unchanged, never a new soup',
    steps.every(s => s.soupIsStart && s.undo === a0.undo && s.seen === 0 && s.readout === a0.readout && s.span[0] === 100), steps.map(s => s.undo).join(' / '));
  check('the field kept what was typed and the focus', steps.every((s, i) => s.value === String(typed[i]) && s.focused === 'scale-length'));
  check('the slider follows the box; Set and Cancel are lit', steps.every((s, i) => +s.slider.v === typed[i] && !s.setOff && !s.cancelOff), steps.map(s => s.slider.v).join(' / '));
  check('the note says what the preview is and that Set bakes it', /^Preview: X 100\.0 → 130\.0 mm .*Set bakes it/.test(steps[2].note), steps[2].note);
  check('...and nothing is said done', steps.every(s => !/done/.test(s.status)), steps[2].status);
  await page.keyboard.press('Tab');
  await settle(page);
  const a0t = await look(page, 'scale-length');
  check('Tab - leaving the field - commits nothing: the preview stays, the piece is untouched',
    a0t.soupIsStart && a0t.undo === a0.undo && a0t.previews === 1 && !a0t.setOff);
  await page.focus('#scale-length');
  await clearStatus(page);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Length done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  await waitNoPreview(page);
  const a1 = await look(page, 'scale-length');
  console.log('   Enter:  ' + a1.status);
  check('Enter is Set: "Length done - X 100.0 → 130.0 mm", the field re-reads 130.0, one undo step, the preview gone',
    /^Length done - X 100\.0 → 130\.0 mm \(inserted at X /.test(a1.status) && a1.value === '130.0' && a1.undo === a0.undo + 1 && a1.previews === 0 && a1.setOff && a1.cancelOff, a1.value);
  const eq = await page.evaluate(() => {
    const r = NSO_extendRaw(window.__nsoStart, { axis: 0, length: 130 }), got = getActiveModel().rawTris;
    if (!r.ok) return 'engine refused: ' + r.reason;
    if (r.tris.length !== got.length) return 'length ' + r.tris.length + ' vs ' + got.length;
    for (let i = 0; i < got.length; i++) if (r.tris[i] !== got[i]) return 'float ' + i;
    return 'ok ' + got.length;
  });
  check('the piece is NSO_extendRaw(start, 130) float for float - each value ran on the starting piece', /^ok/.test(eq), eq);
  await clearStatus(page);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await card(page);
  const a2 = await look(page, 'scale-length');
  console.log('   Undo:   ' + a2.status);
  check('one Undo restores the start, coordinate for coordinate, and the field reads 100.0',
    a2.soup === a0.soup && a2.undo === a0.undo && a2.value === '100.0', a2.value + ', undo ' + a2.undo);

  console.log('\n=== 2b. inches shown ===');
  await openMenuFor(page, '#btn-scale-unit-in');
  await page.click('#btn-scale-unit-in');
  await card(page);
  await keepStart(page);
  const i0 = await look(page, 'scale-length');
  console.log('   Length slider in inches: ' + JSON.stringify(i0.slider));
  check('the slider steps in inches (0.005) and runs 0.984..15.748 in round a 3.937 in length',
    i0.slider.step === '0.005' && Math.abs(+i0.slider.min - 0.985) < 0.006 && Math.abs(+i0.slider.max - 15.745) < 0.006, JSON.stringify(i0.slider));
  await type(page, 'scale-length', 5);
  await waitPreview(page, 127);
  const i1 = await look(page, 'scale-length');
  console.log('   typed 5 in: preview ' + i1.pv[0].toFixed(3) + ' mm, "' + i1.note.slice(0, 50) + '…"');
  check('Length 5 typed in inches previews at 127 mm; the piece is still 100 and the readout still the old one',
    Math.abs(i1.pv[0] - 127) < 1e-2 && i1.span[0] === 100 && i1.readout === i0.readout && i1.soupIsStart, i1.readout);
  check('the note speaks inches', /5\.000 in/.test(i1.note) && !/\bmm\b/.test(i1.note), i1.note);
  await page.keyboard.press('Escape');
  await waitNoPreview(page);
  const i2 = await look(page, 'scale-length');
  check('...Escape: the preview gone, the field back to ' + i0.value + ' in, the very soup', i2.value === i0.value && i2.soupIsStart && i2.undo === i0.undo, i2.value);
  await openMenuFor(page, '#btn-scale-unit-mm');
  await page.click('#btn-scale-unit-mm');
  await card(page);

  console.log('\n=== 3. Escape and Cancel drop it ===');
  await keepStart(page);
  const e0 = await look(page, 'scale-length');
  await type(page, 'scale-length', 115);
  await waitPreview(page, 115);
  await page.keyboard.press('Escape');
  await waitNoPreview(page);
  const e2 = await look(page, 'scale-length');
  console.log('   Escape: field "' + e2.value + '", undo ' + e2.undo + ', status ' + e2.status);
  check('Escape: the field reads 100.0 again, the slider with it, the piece the very soup, the undo stack as it was, Set and Cancel greyed',
    e2.value === '100.0' && +e2.slider.v === 100 && e2.soupIsStart && e2.undo === e0.undo && e2.readout === e0.readout && e2.setOff && e2.cancelOff, JSON.stringify({ v: e2.value, u: e2.undo }));
  await type(page, 'scale-length', 115);
  await waitPreview(page, 115);
  await page.click('#btn-scale-cancel');
  await waitNoPreview(page);
  const e3 = await look(page, 'scale-length');
  check('the Cancel button does the same, and says the piece was never touched',
    e3.value === '100.0' && e3.soupIsStart && e3.undo === e0.undo && /preview dropped - piece unchanged/.test(e3.status), e3.status);

  console.log('\n=== 3b. a slider ===');
  await keepStart(page);
  const f0 = await look(page, 'scale-factor');
  await page.evaluate(() => { const sl = document.getElementById('scale-factor-slider'); sl.value = '1.5'; sl.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitPreview(page, 150);
  const f1 = await look(page, 'scale-factor');
  console.log('   Whole x slider 1.5: box "' + f1.value + '", preview ' + f1.pv.map(x => x.toFixed(2)).join(' x ') + ', piece ' + f1.span.join(' x '));
  check('the slider writes the box (1.5), the preview is the piece x 1.5 on all three axes, the piece untouched',
    f1.value === '1.5' && f1.pv.every((x, i) => Math.abs(x - [100, 25, 40][i] * 1.5) < 1e-2) && f1.soupIsStart && f1.undo === f0.undo, JSON.stringify(f1.pv));
  const seated = await page.evaluate(() => {
    const o = nsoHelpers.live().find(q => q.userData.nsoHelper === 'scale-live'), p = state.placed.find(q => q.sourceId === getActiveModel().id);
    o.geometry.computeBoundingBox(); const sz = o.geometry.boundingBox.max.y - o.geometry.boundingBox.min.y;
    return { bottom: o.position.y - sz / 2, x: o.position.x - p.mesh.position.x, z: o.position.z - p.mesh.position.z, ghost: p.mesh.material.opacity };
  });
  console.log('   seating: ' + JSON.stringify(seated));
  check('the preview sits where the bake will: bottom on the plate (0.3), centred on the piece, the piece itself drawn as a ghost',
    Math.abs(seated.bottom - 0.3) < 1e-3 && Math.abs(seated.x) < 1e-6 && Math.abs(seated.z) < 1e-6 && seated.ghost < 0.5, JSON.stringify(seated));
  await clearStatus(page);
  await page.click('#btn-scale-set');
  await page.waitForFunction(() => /^Scale done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  await waitNoPreview(page);
  await card(page);
  const f2 = await look(page, 'scale-factor');
  console.log('   Set:    ' + f2.status);
  check('Set bakes it: 150 long, one undo step, Whole x back to 1, the ghost back to solid, the slider re-ranged round the new size',
    Math.abs(f2.span[0] - 150) < 1e-3 && f2.undo === f0.undo + 1 && f2.value === '1' && +f2.slider.v === 1, JSON.stringify(f2.span));
  const solid = await page.evaluate(() => { const p = state.placed.find(q => q.sourceId === getActiveModel().id); return p.mesh.material.opacity; });
  check('...the piece is opaque again', solid === 1, String(solid));
  const lr = await look(page, 'scale-length');
  check('Length\'s slider re-ranged: 37.5..600 round the new 150', lr.slider.min === '37.5' && lr.slider.max === '600', JSON.stringify(lr.slider));
  await page.click('#btn-undo');
  await waitSpan(page, 0, 100);
  check('...one Undo returns the tray', (await look(page, 'scale-factor')).soupIsStart);

  console.log('\n=== 4. A refused value ===');
  await keepStart(page);
  const r0 = await look(page, 'scale-height');
  await type(page, 'scale-height', '1.5');
  await waitWhy(page, 'scale-height');
  await settle(page);
  const r1 = await look(page, 'scale-height');
  console.log('   typed 1.5: why "' + r1.why + '" (' + r1.whyRed + '), previews ' + r1.previews);
  check('the reason is under the field while it is typed: Shorten\'s most',
    /^Shorten can remove up to 22\.9 mm here - asked for 23\.5 mm;/.test(r1.why), r1.why);
  check('...in red', r1.whyRed === 'rgb(248, 113, 113)', r1.whyRed);
  check('...no preview is drawn, Set is greyed, the piece unchanged, nothing on the undo stack',
    r1.previews === 0 && r1.setOff && r1.soupIsStart && r1.undo === r0.undo && r1.seen === 0);
  check('...and the note says there is nothing to show', /^Nothing to show - Shorten can remove/.test(r1.note), r1.note);
  const under = await page.evaluate(() => {
    const w = document.getElementById('scale-height-why').getBoundingClientRect(), f = document.getElementById('scale-height').getBoundingClientRect();
    return w.top >= f.bottom - 0.5;
  });
  check('...and it sits under the field', under);
  await type(page, 'scale-height', 30);
  await waitPreview(page, 30, 1);
  const r2 = await look(page, 'scale-height');
  check('a good value after it: the reason goes, a preview 30 tall stands, Set is lit', r2.why === '' && r2.previews === 1 && !r2.setOff && r2.span[2] === 25, r2.why);
  await type(page, 'scale-height', '1.5');
  await waitWhy(page, 'scale-height');
  await settle(page);
  const r3 = await look(page, 'scale-height');
  check('a refused value after a good one clears the preview and greys Set; the piece is still 25',
    r3.previews === 0 && r3.setOff && r3.why !== '' && r3.span[2] === 25 && r3.soupIsStart);
  await clearStatus(page);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Height refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const r4 = await look(page, 'scale-height');
  console.log('   Enter:  ' + r4.status);
  check('Enter on the refused value says why on the status line and changes nothing',
    /^Height refused - piece unchanged \(Shorten can remove up to 22\.9 mm here/.test(r4.status) && r4.soupIsStart && r4.undo === r0.undo, r4.status);
  await page.keyboard.press('Escape');
  await settle(page);
  const r5 = await look(page, 'scale-height');
  check('Escape clears the reason and puts the field back to 25.0', r5.why === '' && r5.value === '25.0' && r5.soupIsStart && r5.undo === r0.undo, JSON.stringify({ v: r5.value, why: r5.why }));

  console.log('\n=== 5. Set bakes, leaving the field does not ===');
  await keepStart(page);
  const n0 = await look(page, 'scale-width');
  await type(page, 'scale-width', 50);
  await waitPreview(page, 50, 2);
  await page.click('#btn-scale-set');
  await page.waitForFunction(() => /^Width done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const n1 = await look(page, 'scale-width');
  console.log('   Set:    ' + n1.status);
  check('the Set button bakes Width 50: one undo step, the preview gone, the field re-reads 50.0',
    n1.undo === n0.undo + 1 && n1.previews === 0 && n1.value === '50.0' && Math.abs(n1.span[1] - 50) < 1e-3, JSON.stringify({ u: n1.undo, v: n1.value }));
  await page.click('#btn-undo');
  await waitSpan(page, 1, 40);
  check('...one Undo returns the tray', (await look(page, 'scale-width')).soupIsStart);
  // a keystroke inside the pacing gap: Enter straight after typing still sets what the box says
  await keepStart(page);
  const q0 = await look(page, 'scale-width');
  await openMenuFor(page, '#scale-width');
  await page.focus('#scale-width');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('45');
  await clearStatus(page);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Width done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const q1 = await look(page, 'scale-width');
  check('Enter pressed straight after typing (before the preview is drawn) still sets the box: Width 45',
    Math.abs(q1.span[1] - 45) < 1e-3 && q1.undo === q0.undo + 1, JSON.stringify(q1.span));
  await page.click('#btn-undo');
  await waitSpan(page, 1, 40);

  console.log('\n=== 6. Offset and the ring rows ===');
  await keepStart(page);
  const o0 = await look(page, 'scale-offset');
  await type(page, 'scale-offset', 1);
  await waitPreview(page, 102);
  const o1 = await look(page, 'scale-offset');
  check('Offset 1 previews 102 x 27 x 42 (display), the piece untouched, Offset\'s slider +-5',
    o1.pv.map(x => x.toFixed(3)).join() === '102.000,27.000,42.000' && o1.soupIsStart && o1.slider.min === '-5' && o1.slider.max === '5', o1.pv.join(' / ') + ' ' + JSON.stringify(o1.slider));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^Offset done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const o2 = await look(page, 'scale-offset');
  console.log('   Offset 1: ' + o2.status);
  check('Enter bakes it: one undo step, the field empty again', /^Offset done - out 1 mm/.test(o2.status) && o2.undo === o0.undo + 1 && o2.value === '', o2.status);
  await page.click('#btn-undo');
  await waitSpan(page, 0, 100);
  check('...one Undo returns the tray', (await look(page, 'scale-offset')).soupIsStart);

  // A tube: the Stock shelf's tube, at its default drop.
  const nModels = await page.evaluate(() => state.models.length);
  await openMenuFor(page, '#btn-stock-tube');
  await page.click('#btn-stock-tube');
  await page.waitForFunction(k => state.models.length > k, nModels, { timeout: 30000 });
  const tubeId = await page.evaluate(() => state.models[state.models.length - 1].id);
  await select(page, tubeId);
  await card(page);
  await keepStart(page);
  const t0 = await look(page, 'scale-ring-outer');
  console.log('   tube:   ' + t0.readout + '   Outer Ø "' + t0.value + '"');
  const outer = +t0.value + 6;
  await type(page, 'scale-ring-outer', outer);
  await waitPreview(page, outer);
  const t1 = await look(page, 'scale-ring-outer');
  console.log('   Outer Ø ' + outer + ': preview ' + t1.pv[0].toFixed(2) + ', piece ' + t1.span[0].toFixed(2));
  check('Outer Ø typed: the preview is the new diameter, the piece and its readout are as they were, no undo entry',
    Math.abs(t1.pv[0] - outer) < 1e-2 && t1.soupIsStart && t1.readout === t0.readout && t1.undo === t0.undo, t1.readout);
  await page.keyboard.press('Escape');
  await waitNoPreview(page);
  const t2 = await look(page, 'scale-ring-outer');
  check('...Escape drops it, the field and the undo stack as they were', t2.soupIsStart && t2.value === t0.value && t2.undo === t0.undo, JSON.stringify({ v: t2.value, u: t2.undo }));
  const w0 = await look(page, 'scale-ring-wall');
  await type(page, 'scale-ring-wall', '0.2');
  await waitWhy(page, 'scale-ring-wall');
  await settle(page);
  const t3 = await look(page, 'scale-ring-wall');
  console.log('   Wall 0.2: why "' + t3.why + '"');
  check('Wall 0.2 refused in place, under the floor, no preview, the tube unchanged',
    /^wall would be 0\.2 mm, under the 0\.42 mm floor/.test(t3.why) && t3.previews === 0 && t3.soupIsStart && t3.undo === t0.undo, t3.why);
  await page.keyboard.press('Escape');
  await settle(page);
  const t4 = await look(page, 'scale-ring-wall');
  check('...Escape clears the reason and puts the field back', t4.why === '' && t4.value === w0.value && t4.soupIsStart && t4.undo === t0.undo,
    JSON.stringify({ why: t4.why, v: t4.value }));

  console.log('\n=== 7. what else drops a preview ===');
  await select(page, trayId);
  await card(page);
  await keepStart(page);
  const d0 = await look(page, 'scale-length');
  await type(page, 'scale-length', 120);
  await waitPreview(page, 120);
  await select(page, tubeId);
  await waitNoPreview(page);
  await card(page);
  const ghostBack = await page.evaluate(() => state.placed.map(p => p.mesh.material.opacity));
  check('selecting another piece mid-edit drops the preview; every piece is opaque again', ghostBack.every(o => o === 1), ghostBack.join());
  await select(page, trayId);
  await card(page);
  const d1 = await look(page, 'scale-length');
  check('...back on the tray: it is as it was, no undo entry, the field at 100.0', d1.soupIsStart && d1.undo === d0.undo && d1.value === '100.0', JSON.stringify({ v: d1.value, u: d1.undo }));
  await type(page, 'scale-length', 120);
  await waitPreview(page, 120);
  await page.click('#btn-scale-unit-in');
  await waitNoPreview(page);
  const d2 = await look(page, 'scale-length');
  check('the mm | in toggle drops it (the field is rewritten in the new unit)', d2.soupIsStart && d2.undo === d0.undo && d2.value === '3.937', d2.value);
  await page.click('#btn-scale-unit-mm');
  await card(page);
  await type(page, 'scale-length', 120);
  await waitPreview(page, 120);
  await page.evaluate(() => { document.getElementById('menu-scale').open = false; });
  await waitNoPreview(page);
  const d3 = await page.evaluate(() => ({ undo: state.undoStack.length, same: getActiveModel().rawTris === window.__nsoStart,
    opaque: state.placed.every(p => p.mesh.material.opacity === 1) }));
  check('closing the card drops it - the piece never changed, and is opaque', d3.same && d3.undo === d0.undo && d3.opaque, JSON.stringify(d3));
  await card(page);
  const d4 = await look(page, 'scale-length');
  check('...and reopening shows the field at 100.0 with nothing staged', d4.value === '100.0' && d4.setOff && d4.cancelOff, JSON.stringify({ v: d4.value, s: d4.setOff }));
  const helpersLeft = await page.evaluate(() => nsoHelpers.live().length);
  check('no helper left in the scene', helpersLeft === 0, String(helpersLeft));

  console.log('\n=== 8. every field stays staged until Set ===');
  await select(page, trayId);
  await card(page);
  await keepStart(page);
  const u8 = await page.evaluate(() => state.undoStack.length);
  await type(page, 'scale-length', 120);
  await waitPreview(page, 120, 0);
  await type(page, 'scale-width', 50);                 // switch field: Length must be held
  await waitPreview(page, 50, 2);
  const w8 = await look(page, 'scale-width');
  check('moving Width keeps the Length: the preview is 120 long AND 50 wide, the piece untouched',
    Math.abs(w8.pv[0] - 120) < 1e-2 && Math.abs(w8.pv[2] - 50) < 1e-2 && w8.soupIsStart && w8.undo === u8,
    JSON.stringify(w8.pv));
  const l8 = await look(page, 'scale-length');
  check('...and the Length box still reads what was typed, Set and Cancel are lit', l8.value === '120' && !w8.setOff && !w8.cancelOff, l8.value);
  await type(page, 'scale-height', 30);
  await waitPreview(page, 30, 1);
  const h8 = await look(page, 'scale-height');
  check('Height as well: all three held on one preview',
    Math.abs(h8.pv[0] - 120) < 1e-2 && Math.abs(h8.pv[1] - 30) < 1e-2 && Math.abs(h8.pv[2] - 50) < 1e-2, JSON.stringify(h8.pv));
  await type(page, 'scale-length', 140);               // go back to an earlier field and change it again
  await waitPreview(page, 140, 0);
  const b8 = await look(page, 'scale-height');
  check('going back to Length re-sizes it and still holds Width and Height',
    Math.abs(b8.pv[0] - 140) < 1e-2 && Math.abs(b8.pv[1] - 30) < 1e-2 && Math.abs(b8.pv[2] - 50) < 1e-2 && b8.soupIsStart, JSON.stringify(b8.pv));
  await page.keyboard.press('Enter');                  // Set bakes the final state
  await waitSpan(page, 0, 140);
  const a8 = await look(page, 'scale-height');
  check('Set bakes the final state: 140 x 50 x 30, one Undo step, the preview gone',
    Math.abs(a8.span[0] - 140) < 1e-3 && Math.abs(a8.span[1] - 50) < 1e-3 && Math.abs(a8.span[2] - 30) < 1e-3 &&
    a8.undo === u8 + 1 && a8.previews === 0, JSON.stringify({ span: a8.span, undo: a8.undo }));
  check('...and every field re-reads the new size',
    (await page.evaluate(() => ['scale-length', 'scale-width', 'scale-height'].map(i => document.getElementById(i).value).join())) === '140.0,50.0,30.0');
  await clearStatus(page);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await card(page);
  const u8b = await look(page, 'scale-length');
  check('one Undo restores all three', Math.abs(u8b.span[0] - 100) < 1e-3 && Math.abs(u8b.span[1] - 40) < 1e-3 && Math.abs(u8b.span[2] - 25) < 1e-3 && u8b.undo === u8, JSON.stringify(u8b.span));

  console.log('  -- a refusal in one field blocks Set and names that field; Escape drops every field');
  await type(page, 'scale-length', 120);
  await waitPreview(page, 120, 0);
  await type(page, 'scale-height', 1.5);
  await waitWhy(page, 'scale-height');
  const r8 = await look(page, 'scale-height');
  const lw = await look(page, 'scale-length');
  check('Height 1.5 is refused under its own field; Length shows no reason; Length 120 still previews, Set greyed',
    r8.why.length > 0 && lw.why === '' && r8.previews === 1 && Math.abs(r8.pv[0] - 120) < 1e-2 && Math.abs(r8.pv[1] - 25) < 1e-2 && r8.setOff,
    JSON.stringify({ why: r8.why.slice(0, 40), lwhy: lw.why, pv: r8.pv }));
  await page.keyboard.press('Enter');
  const n8 = await look(page, 'scale-height');
  check('Enter with a refused field bakes nothing and says why',
    n8.soupIsStart && n8.undo === u8 && /Height refused/.test(n8.status), n8.status.slice(0, 60));
  await page.keyboard.press('Escape');
  const e8 = await page.evaluate(() => ({ l: document.getElementById('scale-length').value, h: document.getElementById('scale-height').value,
    soupSame: getActiveModel().rawTris === window.__nsoStart, previews: nsoHelpers.live().filter(o => o.userData.nsoHelper === 'scale-live').length }));
  check('Escape puts every field back and drops the preview', e8.l === '100.0' && e8.h === '25.0' && e8.soupSame && e8.previews === 0, JSON.stringify(e8));

  console.log('\n=== nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
