/* Scale parts 2 and 3 in the real app: the ring verbs, the Shrink fix, screenshots.
   node tools/nso_ring_drive_check.js                 exit 0 = every gate held
   node tools/nso_ring_drive_check.js --shots DIR     also write DIR/*.png
                                                      (a scratch directory -
                                                      no screenshot is committed)

   MINI_TPU_TEST.stl is loaded the way a user loads it: Library -> Test
   Fixtures -> click. It lives in nolongerzzz/nest-library; the harness answers
   the catalog's raw URL from the checkout nso_library_dir.js resolves, and
   without one this check SKIPs out loud rather than passing.

   Steps, in the ticket's order:

     1  MINI_TPU_TEST from the Library    -> Ring Ø20.0 / Ø18.0, wall 1.0, height 8.0
     2  Fatten's Shrink is gone from the Finish menu, and the card shows no
        Offset on a ring (Outer Ø and Length already do its job); the offset
        that replaced it, run at -0.1 and -0.5 mm, leaves a RING with its
        wall - part 2's Shrink un-rang it at both. Then the same intent
        through the ring verbs, Outer Ø 20 -> 19.8 and Wall 1 -> 0.9
     3  Outer Ø -> 24  -> Ø24.0 / Ø22.0, wall 1.0, height 8.0; Undo returns it
     5  Wall -> 2      -> Ø20.0 / Ø16.0, wall 2.0 (part 2's Bore Ø -> 16; the
                          Bore row is gone, Wall reaches the same bore)
     6  Wall -> 0.4    -> refused, worded, piece unchanged (and Wall -> 0.5,
                          which the 0.42 mm floor at a 0.4 nozzle allows)
     7  Stock cylinder -> Rod, Diameter -> 30, no Outer / Wall fields
     8  Export the Ø24 ring as STL, read the file back with the reader

   Every number is printed; the PR quotes them. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, statusOf, openMenuFor, ROOT } = require('./nso_app_harness');
const LIB = require('./nso_library_dir');

const SHOTS = (() => {
  const i = process.argv.indexOf('--shots');
  if (i < 0) return null;
  const dir = process.argv[i + 1];
  if (!dir || dir.startsWith('--')) { console.error('--shots needs a directory (a scratch one: no PNG goes in the repo)'); process.exit(2); }
  return path.resolve(dir);
})();
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

if (!LIB.libraryDir() || !LIB.catalogFile('MINI_TPU_TEST.stl')) {
  LIB.skip('the ring drive check: MINI_TPU_TEST.stl comes from the Library');
  process.exit(0);
}

const select = (page, id) => page.evaluate(i => selectPlaced(state.placed.findIndex(p => p.sourceId === i)), id);

/* The card, read the way a user reads it: Scale menu open, line rendered. */
async function card(page) {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  return page.evaluate(() => {
    const m = getActiveModel();
    const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && !e.closest('[hidden]'); };
    const val = id => (document.getElementById(id) || {}).value;
    const s = NSO_scaleSectionOf(m);
    return {
      readout: document.getElementById('scale-readout').textContent,
      ring: shown('scale-ring-outer-row') && shown('scale-ring-wall-row'), rod: shown('scale-rod-diameter-row'),
      bore: !!document.getElementById('scale-ring-bore'), offset: shown('scale-offset-row'),
      axisRows: ['length', 'width', 'height'].filter(r => shown('scale-' + r + '-row')),
      fields: { outer: val('scale-ring-outer'), wall: val('scale-ring-wall'), diameter: val('scale-rod-diameter'), height: val('scale-height') },
      holds: ['scale-ring-outer-row', 'scale-ring-wall-row'].map(id => document.querySelector('#' + id + ' .hint').textContent),
      rodHold: document.querySelector('#scale-rod-diameter-row .hint').textContent,
      rodTitle: document.getElementById('scale-rod-diameter').title,      // #187: the Set's title is the field's
      outer: s && s.outer ? s.outer.diameterMm : null, boreMm: s && s.bore ? s.bore.diameterMm : null,
      wall: s ? s.wallMm : null, length: s ? s.lengthMm : null,
      soup: Array.from(m.rawTris).join(','), undo: state.undoStack.length
    };
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('   screenshot ' + path.join(SHOTS, name + '.png'));
}

async function clear(page) { await page.evaluate(() => { document.getElementById('status').textContent = ''; }); }

/* Type into a ring field and leave it with Tab, as a user does (#187: the
   fields are live, no Set; leaving the field is what commits it). */
async function ringSet(page, inputId, value) {
  await openMenuFor(page, '#' + inputId);
  await page.focus('#' + inputId);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(value));
  await clear(page);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0, null, { timeout: 30000 });
  return statusOf(page);
}

async function undo(page) {
  await clear(page);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  return statusOf(page);
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const f3 = x => (+x).toFixed(3);
  const line = c => 'Ø' + f3(c.outer) + ' / Ø' + f3(c.boreMm) + ', wall ' + f3(c.wall) + ', height ' + f3(c.length);

  console.log('\n=== 1. MINI_TPU_TEST from the Library ===');
  const n0 = await page.evaluate(() => state.models.length);
  await page.evaluate(() => {
    document.getElementById('btn-library').click();
    document.querySelectorAll('#library-list .library-sec').forEach(d => { d.open = true; });
    const row = Array.from(document.querySelectorAll('#library-list .library-item'))
      .find(r => r.querySelector('.name').textContent === 'MINI_TPU_TEST.stl');
    if (!row) throw new Error('no Library row for MINI_TPU_TEST.stl');
    if (row.dataset.category !== 'Test Fixtures') throw new Error('MINI_TPU_TEST.stl is under ' + row.dataset.category);
    row.click();
  });
  await page.waitForFunction(n => state.models.length > n, n0, { timeout: 30000 });
  const tpuId = await page.evaluate(() => state.models[state.models.length - 1].id);
  await page.evaluate(() => { const c = document.getElementById('btn-library-close'); if (c) c.click(); });
  await select(page, tpuId);
  const c0 = await card(page);
  console.log('   readout: ' + c0.readout);
  console.log('   reader:  ' + line(c0));
  check('the readout reads Ring with the published numbers',
    c0.readout === 'Ring Ø20.0 outer · Ø18.0 bore · wall 1.0 · height 8.0 · fits A1 Mini', c0.readout);
  // It lies flat, its axis its own Z, so its one axis row is Height (one
  // L / W / H vocabulary, as a box's).
  check('Height, Outer Ø and Wall shown; no Length / Width, no Bore Ø, no Diameter, no Offset',
    c0.axisRows.join() === 'height' && c0.ring && !c0.bore && !c0.rod && !c0.offset,
    JSON.stringify({ axisRows: c0.axisRows, ring: c0.ring, bore: c0.bore, rod: c0.rod, offset: c0.offset }));
  check('each states its hold: wall kept, outer kept', JSON.stringify(c0.holds) === '["wall kept","outer kept"]', c0.holds.join(' | '));
  check('prefilled at the readout\'s own precision: 20.0, 1.0, Height 8.0',
    c0.fields.outer === '20.0' && c0.fields.wall === '1.0' && c0.fields.height === '8.0', JSON.stringify(c0.fields));
  await shot(page, '01-mini-tpu-ring-read');
  const orig = c0;

  console.log('\n=== 2. The Shrink fix: no Fatten buttons, no Offset on a ring, and the offset keeps it a ring ===');
  const gone = await page.evaluate(() => ['btn-fatten-grow', 'btn-fatten-shrink', 'inp-fatten-mm'].filter(id => document.getElementById(id)));
  check('Fatten / Shrink are gone from the Finish menu', gone.length === 0, gone.join(', '));
  const SHRINK = await page.evaluate(() => [-0.1, -0.5].map(mm => {
    const r = NSO_scaleOffsetRaw(getActiveModel().rawTris, mm);
    const s = r.ok ? NSO_sectionRead(r.tris) : null;
    return { mm, ok: r.ok, reason: r.reason, readout: s ? NSO_sectionReadout(s) : '', shape: s && s.shape, hollow: s && s.hollow,
             wall: s && s.wallMm, outer: s && s.outer && s.outer.diameterMm, length: s && s.lengthMm };
  }));
  for (const r of SHRINK) {
    console.log('   offset ' + r.mm + ' mm: ' + (r.ok ? r.readout : 'refused - ' + r.reason));
    check('  offset ' + r.mm + ' mm leaves a ring, wall kept, outer and length ' + (-2 * r.mm) + ' mm less',
      r.ok && r.shape === 'round' && r.hollow && Math.abs(r.wall - orig.wall) < 1e-3 &&
      Math.abs(r.outer - (orig.outer + 2 * r.mm)) < 1e-3 && Math.abs(r.length - (orig.length + 2 * r.mm)) < 1e-4, r.readout);
  }
  // The 1e-6 mm checks below assume what is true here: the Library's file is
  // centred on the origin (largest coordinate 12 mm, one float32 ULP 9.5e-7),
  // and the app keeps a raw piece's own coordinates, so 1e-6 is above what
  // float32 can land. A piece far from the origin has a coarser grid - at plate
  // position (90, 90) one ULP is 7.6e-6 mm - which tools/nso_ring_test.js
  // section 2 holds to one ULP at the piece's magnitude instead.
  const v1 = await ringSet(page, 'scale-ring-outer', 19.8);
  const c1 = await card(page);
  console.log('   Outer Ø 20 -> 19.8: "' + v1 + '"\n     reads ' + line(c1));
  check('Outer Ø -> 19.8 applies: outer 19.800, wall kept; its line says "height held"', /^Outer Ø done - .*, wall kept, height held$/.test(v1) && Math.abs(c1.outer - 19.8) < 1e-6 &&
    Math.abs(c1.wall - orig.wall) < 2e-6 && c1.length === 8, line(c1));
  await undo(page);
  check('  ...Undo returns it', (await card(page)).soup === orig.soup);
  const v2 = await ringSet(page, 'scale-ring-wall', 0.9);
  const c2 = await card(page);
  console.log('   Wall 1 -> 0.9: "' + v2 + '"\n     reads ' + line(c2));
  check('Wall -> 0.9 applies: wall 0.900, outer kept', /^Wall done/.test(v2) && Math.abs(c2.wall - 0.9) < 1e-6 &&
    c2.outer === orig.outer && c2.length === 8, line(c2));
  await undo(page);
  check('  ...Undo returns it', (await card(page)).soup === orig.soup);

  console.log('\n=== 3. Outer Ø -> 24 ===');
  const s3 = await ringSet(page, 'scale-ring-outer', 24);
  const c3 = await card(page);
  console.log('   status:  ' + s3 + '\n   readout: ' + c3.readout + '\n   reader:  ' + line(c3));
  check('readout: Ø24.0 outer · Ø22.0 bore · wall 1.0 · height 8.0',
    c3.readout === 'Ring Ø24.0 outer · Ø22.0 bore · wall 1.0 · height 8.0 · fits A1 Mini', c3.readout);
  check('one Undo step', c3.undo === orig.undo + 1, orig.undo + ' -> ' + c3.undo);
  check('the fields re-prefilled from the new reading', c3.fields.outer === '24.0' && c3.fields.wall === '1.0', JSON.stringify(c3.fields));
  await shot(page, '02-outer-24');

  console.log('\n=== 8. Export the Ø24 ring as STL and read the file ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-ring-drive-'));
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', 'stl');
  page.once('dialog', d => d.accept());
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-model')]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const bytes = Array.from(fs.readFileSync(file));
  const ex = await page.evaluate(b => {
    const buf = new Uint8Array(b).buffer, dv = new DataView(buf), n = dv.getUint32(80, true), s = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) s[t * 9 + k] = dv.getFloat32(84 + t * 50 + 12 + k * 4, true);
    const r = NSO_sectionRead(s);
    return { tris: n, shape: r.shape, hollow: r.hollow, outer: r.outer && r.outer.diameterMm, bore: r.bore && r.bore.diameterMm,
             wall: r.wallMm, length: r.lengthMm, readout: NSO_sectionReadout(r) };
  }, bytes);
  console.log('   ' + path.basename(file) + ': ' + ex.tris + ' triangles, reads ' + ex.readout +
    ' (Ø' + f3(ex.outer) + ' / Ø' + f3(ex.bore) + ', wall ' + f3(ex.wall) + ')');
  check('the exported file reads Ø24.000 outer', ex.shape === 'round' && ex.hollow && Math.abs(ex.outer - 24) < 1e-3, f3(ex.outer));
  check('...and Ø22 bore - 22.005 by the file\'s own vertices, the 0.005 MINI_TPU_TEST started with', Math.abs(ex.bore - 22) < 0.01, f3(ex.bore));

  const u3 = await undo(page);
  const c3u = await card(page);
  console.log('   undo:    ' + u3 + '\n   readout: ' + c3u.readout);
  check('Undo returns it, coordinate for coordinate', c3u.soup === orig.soup);
  check('Undo names the ring edit', /Undo: Ring \/ rod size reverted/.test(u3), u3);

  console.log('\n=== 5. Wall -> 2 ===');
  const s5 = await ringSet(page, 'scale-ring-wall', 2);
  const c5 = await card(page);
  console.log('   status:  ' + s5 + '\n   readout: ' + c5.readout);
  check('readout: Ø20.0 · Ø16.0 · wall 2.0 - part 2\'s Bore Ø -> 16, reached through Wall',
    c5.readout === 'Ring Ø20.0 outer · Ø16.0 bore · wall 2.0 · height 8.0 · fits A1 Mini' && c5.outer === orig.outer, c5.readout);
  await shot(page, '04-wall-2');
  await undo(page);

  console.log('\n=== 6. Wall -> 0.4, and 0.5 ===');
  const s6 = await ringSet(page, 'scale-ring-wall', 0.4);
  const c6 = await card(page);
  console.log('   status:  ' + s6);
  check('Wall -> 0.4 refused, worded in mm, piece unchanged',
    s6 === 'Wall refused - piece unchanged (wall would be 0.4 mm, under the 0.42 mm floor)' && c6.soup === orig.soup, s6);
  await shot(page, '05-wall-0.4-refused');
  const s6b = await ringSet(page, 'scale-ring-wall', 0.5);
  const c6b = await card(page);
  console.log('   Wall -> 0.5: ' + s6b);
  check('Wall -> 0.5 applies at the default 0.4 nozzle: 0.5 is over the 0.42 mm floor', /^Wall done/.test(s6b) && Math.abs(c6b.wall - 0.5) < 1e-6, line(c6b));
  await undo(page);
  check('  ...Undo returns it', (await card(page)).soup === orig.soup);

  console.log('\n=== 7. Stock cylinder: Rod, Diameter only ===');
  const n1 = await page.evaluate(() => state.models.length);
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
    set('sel-stock-shape', 'cylinder'); set('inp-stock-height', '40');
  });
  await openMenuFor(page, '#btn-stock-make');
  await page.click('#btn-stock-make');
  await page.waitForFunction(n => state.models.length > n, n1, { timeout: 30000 });
  const cylId = await page.evaluate(() => state.models[state.models.length - 1].id);
  await select(page, cylId);
  const c7 = await card(page);
  console.log('   readout: ' + c7.readout);
  // stood up, axis Z: its axis goes by Height, in the readout, the row, the hold and the done line
  check('reads Rod, its axis as height', /^Rod Ø\d+\.\d\d? · height \d+\.\d\d? · fits A1 Mini$/.test(c7.readout), c7.readout);
  check('Diameter shown, no Outer / Wall fields', c7.rod && !c7.ring);
  check('...with the Height row (no Length), and Diameter\'s hold says "height kept"',
    c7.axisRows.join() === 'height' && c7.rodHold === 'height kept' && /the height is held/.test(c7.rodTitle), JSON.stringify([c7.axisRows, c7.rodHold, c7.rodTitle]));
  const s7 = await ringSet(page, 'scale-rod-diameter', 30);
  const c7b = await card(page);
  console.log('   status:  ' + s7 + '\n   readout: ' + c7b.readout);
  check('Diameter -> 30 works, and says "height held"', /^Diameter done - .*, height held$/.test(s7) && Math.abs(c7b.outer - 30) < 1e-6 && c7b.length === c7.length,
    'Ø' + f3(c7b.outer) + ', height ' + f3(c7.length) + ' -> ' + f3(c7b.length));
  await shot(page, '06-rod-diameter-30');

  console.log('\n=== nothing else broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n=== the Shrink fix, on record ===');
  for (const s of SHRINK) console.log('   offset ' + s.mm + ' mm: ' + (s.ok ? s.readout : 'refused - ' + s.reason));
  console.log('   Outer Ø 20 -> 19.8: "' + v1 + '"');
  console.log('   Wall 1 -> 0.9:      "' + v2 + '"');

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
