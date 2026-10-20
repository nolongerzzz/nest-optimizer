/* Scale parts 2 and 3 in the real app: the ring verbs, the Shrink fix, screenshots.
   node tools/nso_ring_drive_check.js                 exit 0 = every gate held
   node tools/nso_ring_drive_check.js --shots DIR     also write DIR/*.png
                                                      (a scratch directory -
                                                      no screenshot is committed)

   MINI_TPU_TEST.stl is loaded the way a user loads it: Library -> Test
   Fixtures -> click. It lives in nolongerzzz/nest-library; the harness answers
   the catalog's raw URL from the checkout nso_library_dir.js resolves, and
   without one steps 1-6 and 8 SKIP out loud rather than pass. Steps 7 and 9
   are Stock pieces and always run.

   A ring's three rows each move ONE face (scale-ring-id-od, pipe work):
   Outer Ø the outside, the bore held; Bore Ø the bore, the outside held; Wall
   the bore, the outside held. The length is held by all three.

   Steps, in the ticket's order:

     1  MINI_TPU_TEST from the Library    -> Ring Ø20.0 / Ø18.0, wall 1.0, height 8.0;
                                             rows Height, Outer Ø, Bore Ø, Wall
     2  Fatten's Shrink is gone from the Finish menu, and the card shows no
        Offset on a ring (Outer Ø, Bore Ø and Length do its job); the offset
        that replaced it, run at -0.1 and -0.5 mm, leaves a RING with its
        wall - part 2's Shrink un-rang it at both. Then shrinking through the
        ring verbs, Outer Ø 20 -> 19.8 (the bore held, the wall 0.9) and
        Wall 1 -> 0.9
     3  Outer Ø -> 24  -> Ø24.0 / Ø18.0, wall 3.0, height 8.0; Undo returns it
     4  Bore Ø -> 16   -> Ø20.0 / Ø16.0, wall 2.0, the outer bit for bit
     5  Wall -> 2      -> Ø20.0 / Ø16.0, wall 2.0
     6  Wall -> 0.4    -> refused, worded, piece unchanged (and Wall -> 0.5,
                          which the 0.42 mm floor at a 0.4 nozzle allows)
     7  Stock cylinder -> Rod, Diameter -> 30, no Outer / Bore / Wall fields
     8  Export the Ø24 ring as STL, read the file back with the reader
     9  pipe work on a Stock tube brought to OD 40 / bore 30 by the rows
        themselves: Outer Ø 44 -> bore still 30.00, wall 7.00; Bore Ø 34 ->
        outside still 44.00, wall 5.00; Wall 3 -> bore 38.00; each done line
        "Ø44.0 / bore Ø30.0 · wall 7.0 · height held"; the floor and the
        crossing refused in words, piece unchanged; one Undo step each

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

const HAVE_TPU = !!(LIB.libraryDir() && LIB.catalogFile('MINI_TPU_TEST.stl'));

const select = (page, id) => page.evaluate(i => selectPlaced(state.placed.findIndex(p => p.sourceId === i)), id);

const RING_ROWS = ['scale-ring-outer-row', 'scale-ring-bore-row', 'scale-ring-wall-row'];

/* The card, read the way a user reads it: Scale menu open, line rendered. */
async function card(page) {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(() => document.getElementById('scale-readout').dataset.stale === '0', null, { timeout: 30000 });
  return page.evaluate(rows => {
    const m = getActiveModel();
    const shown = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && !e.closest('[hidden]'); };
    const val = id => (document.getElementById(id) || {}).value;
    const s = NSO_scaleSectionOf(m);
    return {
      readout: document.getElementById('scale-readout').textContent,
      ring: rows.every(shown), anyRing: rows.some(shown), rod: shown('scale-rod-diameter-row'),
      offset: shown('scale-offset-row'),
      axisRows: ['length', 'width', 'height'].filter(r => shown('scale-' + r + '-row')),
      fields: { outer: val('scale-ring-outer'), bore: val('scale-ring-bore'), wall: val('scale-ring-wall'),
                diameter: val('scale-rod-diameter'), height: val('scale-height') },
      holds: rows.map(id => document.querySelector('#' + id + ' .hint').textContent),
      outerTitle: document.getElementById('scale-ring-outer').title,
      rodHold: document.querySelector('#scale-rod-diameter-row .hint').textContent,
      rodTitle: document.getElementById('scale-rod-diameter').title,      // #187: the Set's title is the field's
      outer: s && s.outer ? s.outer.diameterMm : null, boreMm: s && s.bore ? s.bore.diameterMm : null,
      wall: s ? s.wallMm : null, length: s ? s.lengthMm : null,
      soup: Array.from(m.rawTris).join(','), undo: state.undoStack.length
    };
  }, RING_ROWS);
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

async function makeStock(page, shape) {
  const n = await page.evaluate(() => state.models.length);
  await openMenuFor(page, '#btn-stock-' + shape);
  await page.click('#btn-stock-' + shape);
  await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
  const id = await page.evaluate(() => state.models[state.models.length - 1].id);
  await select(page, id);
  return id;
}

const f2 = x => (+x).toFixed(2), f3 = x => (+x).toFixed(3);
// nso_section.js's one display precision, restated so a change to it shows here
const show = x => { const one = (+x).toFixed(1); return Math.abs(+one - x) > 0.01 ? (+x).toFixed(2) : one; };
const line = c => 'Ø' + f3(c.outer) + ' / Ø' + f3(c.boreMm) + ', wall ' + f3(c.wall) + ', height ' + f3(c.length);

/* Steps 1-6 and 8: MINI_TPU_TEST from the Library. */
async function libraryRing(page) {
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
  check('Height, Outer Ø, Bore Ø and Wall shown; no Length / Width, no Diameter, no Offset',
    c0.axisRows.join() === 'height' && c0.ring && !c0.rod && !c0.offset,
    JSON.stringify({ axisRows: c0.axisRows, ring: c0.ring, rod: c0.rod, offset: c0.offset }));
  check('each states its hold: bore kept, outer kept, outer kept', JSON.stringify(c0.holds) === '["bore kept","outer kept","outer kept"]', c0.holds.join(' | '));
  check('prefilled at the readout\'s own precision: 20.0, 18.0, 1.0, Height 8.0',
    c0.fields.outer === '20.0' && c0.fields.bore === '18.0' && c0.fields.wall === '1.0' && c0.fields.height === '8.0', JSON.stringify(c0.fields));
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
  check('Outer Ø -> 19.8 applies: outer 19.800, the bore held, the wall 0.9; its line reports all three and "height held"',
    v1 === 'Outer Ø done - Ø19.8 / bore Ø18.0 · wall 0.9 · height held' && Math.abs(c1.outer - 19.8) < 1e-6 &&
    c1.boreMm === orig.boreMm && Math.abs(c1.wall - (19.8 - orig.boreMm) / 2) < 2e-6 && c1.length === 8, line(c1));
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
  check('readout: Ø24.0 outer · Ø18.0 bore · wall 3.0 · height 8.0 - the bore held, the wall took the change',
    c3.readout === 'Ring Ø24.0 outer · Ø18.0 bore · wall 3.0 · height 8.0 · fits A1 Mini' && c3.boreMm === orig.boreMm, c3.readout);
  check('one Undo step', c3.undo === orig.undo + 1, orig.undo + ' -> ' + c3.undo);
  check('the fields re-prefilled from the new reading', c3.fields.outer === '24.0' && c3.fields.bore === '18.0' && c3.fields.wall === '3.0',
    JSON.stringify(c3.fields));
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
  check('...and the Ø18 bore it started with - 18.005 by the file\'s own vertices, as MINI_TPU_TEST has', Math.abs(ex.bore - orig.boreMm) < 1e-4, f3(ex.bore));

  const u3 = await undo(page);
  const c3u = await card(page);
  console.log('   undo:    ' + u3 + '\n   readout: ' + c3u.readout);
  check('Undo returns it, coordinate for coordinate', c3u.soup === orig.soup);
  check('Undo names the ring edit', /Undo: Ring \/ rod size reverted/.test(u3), u3);

  console.log('\n=== 4. Bore Ø -> 16 ===');
  const s4 = await ringSet(page, 'scale-ring-bore', 16);
  const c4 = await card(page);
  console.log('   status:  ' + s4 + '\n   readout: ' + c4.readout);
  check('readout: Ø20.0 · Ø16.0 · wall 2.0, the outer bit for bit (the reader\'s Ø unchanged)',
    c4.readout === 'Ring Ø20.0 outer · Ø16.0 bore · wall 2.0 · height 8.0 · fits A1 Mini' && c4.outer === orig.outer, c4.readout);
  check('its line reports all three', s4 === 'Bore Ø done - Ø20.0 / bore Ø16.0 · wall 2.0 · height held', s4);
  await shot(page, '03-bore-16');
  await undo(page);
  check('  ...Undo returns it', (await card(page)).soup === orig.soup);

  console.log('\n=== 5. Wall -> 2 ===');
  const s5 = await ringSet(page, 'scale-ring-wall', 2);
  const c5 = await card(page);
  console.log('   status:  ' + s5 + '\n   readout: ' + c5.readout);
  check('readout: Ø20.0 · Ø16.0 · wall 2.0 - the bore Bore Ø 16 reaches, through Wall',
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

  console.log('\n=== the Shrink fix, on record ===');
  for (const s of SHRINK) console.log('   offset ' + s.mm + ' mm: ' + (s.ok ? s.readout : 'refused - ' + s.reason));
  console.log('   Outer Ø 20 -> 19.8: "' + v1 + '"');
  console.log('   Wall 1 -> 0.9:      "' + v2 + '"');
}

/* Step 7: a Stock cylinder reads as a rod and offers Diameter alone. */
async function rod(page) {
  console.log('\n=== 7. Stock cylinder: Rod, Diameter only ===');
  await makeStock(page, 'cylinder');
  const c7 = await card(page);
  console.log('   readout: ' + c7.readout);
  // stood up, axis Z: its axis goes by Height, in the readout, the row, the hold and the done line
  check('reads Rod, its axis as height', /^Rod Ø\d+\.\d\d? · height \d+\.\d\d? · fits A1 Mini$/.test(c7.readout), c7.readout);
  check('Diameter shown, no Outer / Bore / Wall fields', c7.rod && !c7.anyRing);
  check('...with the Height row (no Length), and Diameter\'s hold says "height kept"',
    c7.axisRows.join() === 'height' && c7.rodHold === 'height kept' && /the height is held/.test(c7.rodTitle), JSON.stringify([c7.axisRows, c7.rodHold, c7.rodTitle]));
  const s7 = await ringSet(page, 'scale-rod-diameter', 30);
  const c7b = await card(page);
  console.log('   status:  ' + s7 + '\n   readout: ' + c7b.readout);
  check('Diameter -> 30 works, and says "height held"', /^Diameter done - .*, height held$/.test(s7) && Math.abs(c7b.outer - 30) < 1e-6 && c7b.length === c7.length,
    'Ø' + f3(c7b.outer) + ', height ' + f3(c7.length) + ' -> ' + f3(c7b.length));
  await shot(page, '06-rod-diameter-30');
}

/* Step 9, the ticket's gate: pipe work - OD and ID set directly and
   independently, each edit one face, one Undo step, the length held. */
async function pipe(page) {
  console.log('\n=== 9. Pipe work: a Stock tube, its outside and bore set independently ===');
  await makeStock(page, 'tube');
  const t0 = await card(page);
  console.log('   Stock tube: ' + t0.readout);
  check('a Stock tube shows Outer Ø, Bore Ø and Wall: bore kept, outer kept, outer kept',
    t0.ring && t0.axisRows.join() === 'height' && JSON.stringify(t0.holds) === '["bore kept","outer kept","outer kept"]', JSON.stringify(t0.holds));
  check('Outer Ø\'s tooltip: the bore stays, and its old both-faces move is SCALE\'s Offset row',
    /The bore stays where it is/.test(t0.outerTitle) && /as this row used to, is SCALE's Offset row/.test(t0.outerTitle), t0.outerTitle);

  // To OD 40 / bore 30 with the rows themselves: the outside, then the bore.
  const a = await ringSet(page, 'scale-ring-outer', 40);
  const ca = await card(page);
  console.log('   Outer Ø 40: "' + a + '"');
  check('Outer Ø 40: the outside alone - the Stock bore held', /^Outer Ø done - Ø40\.0 \/ bore Ø/.test(a) && Math.abs(ca.outer - 40) < 1e-6 &&
    ca.boreMm === t0.boreMm && ca.length === t0.length, line(ca));
  const b = await ringSet(page, 'scale-ring-bore', 30);
  const S0 = await card(page);
  console.log('   Bore Ø 30: "' + b + '"\n   start:  ' + S0.readout);
  check('Bore Ø 30: the bore alone - OD 40.00 / bore 30.00, wall 5.00', b === 'Bore Ø done - Ø40.0 / bore Ø30.0 · wall 5.0 · height held' &&
    S0.outer === ca.outer && Math.abs(S0.boreMm - 30) < 1e-6 && Math.abs(S0.wall - 5) < 1e-6, line(S0));

  const GATE = [
    ['scale-ring-outer', 44, 'bore', { outer: 44, bore: 30, wall: 7 }, 'Outer Ø done - Ø44.0 / bore Ø30.0 · wall 7.0 · height held',
      'Ring Ø44.0 outer · Ø30.0 bore · wall 7.0 · height 40.62 · fits A1 Mini'],
    ['scale-ring-bore', 34, 'outer', { outer: 44, bore: 34, wall: 5 }, 'Bore Ø done - Ø44.0 / bore Ø34.0 · wall 5.0 · height held',
      'Ring Ø44.0 outer · Ø34.0 bore · wall 5.0 · height 40.62 · fits A1 Mini'],
    ['scale-ring-wall', 3, 'outer', { outer: 44, bore: 38, wall: 3 }, 'Wall done - Ø44.0 / bore Ø38.0 · wall 3.0 · height held',
      'Ring Ø44.0 outer · Ø38.0 bore · wall 3.0 · height 40.62 · fits A1 Mini']
  ];
  const states = [S0];
  for (const [id, value, held, want, said, readout] of GATE) {
    const was = states[states.length - 1];
    const st = await ringSet(page, id, value);
    const c = await card(page);
    states.push(c);
    console.log('   ' + id.replace('scale-ring-', '') + ' ' + value + ': "' + st + '"\n     reads ' + line(c));
    check(id + ' ' + value + ': outside ' + f2(want.outer) + ', bore ' + f2(want.bore) + ', wall ' + f2(want.wall) + ', length held',
      Math.abs(c.outer - want.outer) < 1e-6 && Math.abs(c.boreMm - want.bore) < 1e-6 && Math.abs(c.wall - want.wall) < 1e-6 &&
      c.length === S0.length, line(c));
    check('  ...the ' + held + ' held (the reader\'s Ø unchanged, bit for bit)',
      held === 'bore' ? c.boreMm === was.boreMm : c.outer === was.outer);
    check('  ...the done line reports all three: "' + said + '"', st === said, st);
    check('  ...and the readout: "' + readout + '"', c.readout === readout, c.readout);
    check('  ...one Undo step', c.undo === was.undo + 1, was.undo + ' -> ' + c.undo);
    check('  ...the three fields re-prefilled', c.fields.outer === show(want.outer) && c.fields.bore === show(want.bore) &&
      c.fields.wall === show(want.wall), JSON.stringify(c.fields));
  }
  await shot(page, '07-pipe-44-38');

  // Refused at Ø44 / Ø38: under the floor, and a face onto the other.
  const last = states[states.length - 1];
  const REFUSE = [
    ['scale-ring-outer', 38.6, 'Outer Ø refused - piece unchanged (wall would be 0.3 mm, under the 0.42 mm floor)'],
    ['scale-ring-bore', 43.4, 'Bore Ø refused - piece unchanged (wall would be 0.3 mm, under the 0.42 mm floor)'],
    ['scale-ring-wall', 0.3, 'Wall refused - piece unchanged (wall would be 0.3 mm, under the 0.42 mm floor)'],
    ['scale-ring-outer', 37, 'Outer Ø refused - piece unchanged (outer would reach the bore - Ø37 outer against a Ø38 bore)'],
    ['scale-ring-bore', 45, 'Bore Ø refused - piece unchanged (bore would reach the outer - Ø45 bore against a Ø44 outer)']
  ];
  for (const [id, value, want] of REFUSE) {
    const st = await ringSet(page, id, value);
    const c = await card(page);
    console.log('   ' + id.replace('scale-ring-', '') + ' ' + value + ': "' + st + '"');
    check(id + ' ' + value + ' refused in words, piece unchanged, no Undo step', st === want && c.soup === last.soup && c.undo === last.undo, st);
  }
  await shot(page, '08-pipe-floor-refused');

  // One Undo per edit, each back to the piece before it, coordinate for coordinate.
  for (let i = GATE.length; i > 0; i--) {
    const u = await undo(page);
    const c = await card(page);
    check('Undo ' + (GATE.length - i + 1) + ' returns the piece before ' + GATE[i - 1][0] + ' ' + GATE[i - 1][1] + ' (' + states[i - 1].readout + ')',
      c.soup === states[i - 1].soup && c.readout === states[i - 1].readout && /Undo: Ring \/ rod size reverted/.test(u), c.readout);
  }
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  if (HAVE_TPU) await libraryRing(page);
  else LIB.skip('steps 1-6 and 8 of the ring drive check: MINI_TPU_TEST.stl comes from the Library');
  await rod(page);
  await pipe(page);

  console.log('\n=== nothing else broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
