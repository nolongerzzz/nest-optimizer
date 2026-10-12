/* Scale part 2 in the real app: the ring verbs, the Shrink diagnosis, screenshots.
   node tools/nso_ring_drive_check.js           exit 0 = every gate held
   node tools/nso_ring_drive_check.js --shots   also write docs/scale-ring/*.png

   MINI_TPU_TEST.stl is loaded the way a user loads it: Library -> Test
   Fixtures -> click. It lives in nolongerzzz/nest-library; the harness answers
   the catalog's raw URL from the checkout nso_library_dir.js resolves, and
   without one this check SKIPs out loud rather than passing.

   Steps, in the ticket's order:

     1  MINI_TPU_TEST from the Library    -> Ring Ø20.0 / Ø18.0, wall 1.0, length 8.0
     2  Task 4: Fatten's Shrink at 0.1, 0.5, 1.0 - each outcome recorded as the
        status line says it; then the same intent through the ring verbs,
        Outer Ø 20 -> 19.8 and Wall 1 -> 0.9
     3  Outer Ø -> 24  -> Ø24.0 / Ø22.0, wall 1.0, length 8.0; Undo returns it
     4  Bore Ø -> 16   -> Ø20.0 / Ø16.0, wall 2.0
     5  Wall -> 2      -> the same as step 4
     6  Wall -> 0.4    -> refused, worded, piece unchanged (and Wall -> 0.5,
                          which the 0.42 mm floor at a 0.4 nozzle allows)
     7  Stock cylinder -> Rod, Diameter -> 30, no Bore / Wall fields
     8  Export the Ø24 ring as STL, read the file back with the reader

   Every number is printed; the PR quotes them. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, statusOf, openMenuFor, ROOT } = require('./nso_app_harness');
const LIB = require('./nso_library_dir');

const SHOTS = process.argv.includes('--shots') ? path.join(ROOT, 'docs', 'scale-ring') : null;
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
      ring: shown('scale-ring-rows'), rod: shown('scale-rod-rows'),
      fields: { outer: val('scale-ring-outer'), bore: val('scale-ring-bore'), wall: val('scale-ring-wall'), diameter: val('scale-rod-diameter') },
      holds: Array.from(document.querySelectorAll('#scale-ring-rows .hint, #scale-rod-rows .hint')).map(e => e.textContent),
      outer: s && s.outer ? s.outer.diameterMm : null, bore: s && s.bore ? s.bore.diameterMm : null,
      wall: s ? s.wallMm : null, length: s ? s.lengthMm : null,
      soup: Array.from(m.rawTris).join(','), undo: state.undoStack.length
    };
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  console.log('   screenshot docs/scale-ring/' + name + '.png');
}

async function clear(page) { await page.evaluate(() => { document.getElementById('status').textContent = ''; }); }

/* Type into a ring field and press its Set, as a user does. */
async function ringSet(page, inputId, value) {
  await openMenuFor(page, '#scale-readout');
  await page.evaluate(([id, v]) => { document.getElementById(id).value = String(v); }, [inputId, value]);
  await clear(page);
  await openMenuFor(page, '#btn-' + inputId);
  await page.click('#btn-' + inputId);
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
  const line = c => 'Ø' + f3(c.outer) + ' / Ø' + f3(c.bore) + ', wall ' + f3(c.wall) + ', length ' + f3(c.length);

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
    c0.readout === 'Ring Ø20.0 outer · Ø18.0 bore · wall 1.0 · length 8.0 · fits A1 Mini', c0.readout);
  check('three ring fields shown, no Diameter', c0.ring && !c0.rod);
  check('each states its hold: wall kept, outer kept, outer kept', JSON.stringify(c0.holds.slice(0, 3)) === '["wall kept","outer kept","outer kept"]', c0.holds.join(' | '));
  check('prefilled with the current values', c0.fields.outer === String(+c0.outer.toFixed(3)) &&
    c0.fields.bore === String(+c0.bore.toFixed(3)) && c0.fields.wall === String(+c0.wall.toFixed(3)), JSON.stringify(c0.fields));
  await shot(page, '01-mini-tpu-ring-read');
  const orig = c0;

  console.log('\n=== 2. Task 4: Fatten\'s Shrink on the ring, then the same intent through the ring verbs ===');
  const SHRINK = [];
  for (const mm of [0.1, 0.5, 1.0]) {
    await page.evaluate(() => { document.querySelectorAll('.vp-finish-menu, .vp-finish-menu .vp-sec').forEach(d => { d.open = true; }); });
    await page.evaluate(v => { document.getElementById('inp-fatten-mm').value = String(v); }, mm);
    await clear(page);
    await page.click('#btn-fatten-shrink');
    await page.waitForFunction(() => document.getElementById('status').textContent.length > 0, null, { timeout: 30000 });
    const st = await statusOf(page);
    const after = await card(page);
    const changed = after.soup !== orig.soup;
    // A shrunk piece may no longer be a ring at all: record the reader's own
    // words for it, not a Ø it does not have.
    SHRINK.push({ mm, status: st, changed, reading: changed ? (after.outer != null && after.bore != null ? line(after) : 'reads "' + after.readout + '"') : null });
    console.log('   Shrink ' + mm + ': ' + (changed ? 'APPLIED -> ' + SHRINK[SHRINK.length - 1].reading : 'unchanged') + '\n     "' + st + '"');
    if (changed) { await undo(page); check('  Shrink ' + mm + ' undone', (await card(page)).soup === orig.soup); }
  }
  check('Fatten\'s Shrink was run at 0.1, 0.5 and 1.0 and each outcome recorded', SHRINK.length === 3);
  check('the card re-read after a Fatten bake, which does not call updateEditSize',
    SHRINK.filter(s => s.changed).every(s => /section is not constant along Z/.test(s.reading)),
    SHRINK.map(s => s.reading).join(' | '));
  const v1 = await ringSet(page, 'scale-ring-outer', 19.8);
  const c1 = await card(page);
  console.log('   Outer Ø 20 -> 19.8: "' + v1 + '"\n     reads ' + line(c1));
  check('Outer Ø -> 19.8 applies: outer 19.800, wall kept', /^Outer Ø done/.test(v1) && Math.abs(c1.outer - 19.8) < 1e-6 &&
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
  check('readout: Ø24.0 outer · Ø22.0 bore · wall 1.0 · length 8.0',
    c3.readout === 'Ring Ø24.0 outer · Ø22.0 bore · wall 1.0 · length 8.0 · fits A1 Mini', c3.readout);
  check('one Undo step', c3.undo === orig.undo + 1, orig.undo + ' -> ' + c3.undo);
  check('the fields re-prefilled from the new reading', c3.fields.outer === '24', JSON.stringify(c3.fields));
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

  console.log('\n=== 4. Bore Ø -> 16 ===');
  const s4 = await ringSet(page, 'scale-ring-bore', 16);
  const c4 = await card(page);
  console.log('   status:  ' + s4 + '\n   readout: ' + c4.readout);
  check('readout: Ø20.0 · Ø16.0 · wall 2.0', c4.readout === 'Ring Ø20.0 outer · Ø16.0 bore · wall 2.0 · length 8.0 · fits A1 Mini', c4.readout);
  check('the outer did not move', c4.outer === orig.outer);
  await shot(page, '03-bore-16');
  await undo(page);

  console.log('\n=== 5. Wall -> 2 ===');
  const s5 = await ringSet(page, 'scale-ring-wall', 2);
  const c5 = await card(page);
  console.log('   status:  ' + s5 + '\n   readout: ' + c5.readout);
  check('the same result as Bore Ø -> 16', c5.readout === c4.readout && Math.abs(c5.bore - c4.bore) < 1e-3, line(c5) + ' vs ' + line(c4));
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
  check('reads Rod', /^Rod Ø\d+\.\d · length \d+\.\d · fits A1 Mini$/.test(c7.readout), c7.readout);
  check('Diameter shown, no Outer / Bore / Wall fields', c7.rod && !c7.ring);
  const s7 = await ringSet(page, 'scale-rod-diameter', 30);
  const c7b = await card(page);
  console.log('   status:  ' + s7 + '\n   readout: ' + c7b.readout);
  check('Diameter -> 30 works', /^Diameter done/.test(s7) && Math.abs(c7b.outer - 30) < 1e-6 && c7b.length === c7.length,
    'Ø' + f3(c7b.outer) + ', length ' + f3(c7.length) + ' -> ' + f3(c7b.length));
  await shot(page, '06-rod-diameter-30');

  console.log('\n=== nothing else broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n=== Task 4, on record ===');
  for (const s of SHRINK) console.log('   Shrink ' + s.mm + ' mm: ' + (s.changed ? 'applied, ' + s.reading : 'refused') + ' - "' + s.status + '"');
  console.log('   Outer Ø 20 -> 19.8: "' + v1 + '"');
  console.log('   Wall 1 -> 0.9:      "' + v2 + '"');

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
