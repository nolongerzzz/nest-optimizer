/* Drive check: every skin patch this ticket put in the Library tab, loaded
   through the REAL Library UI.
     node tools/nso_skin_fine_drive_check.js
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_skin_fine_drive_check.js

   Registering a file in app-library.js's CATALOG is not the same as the
   Library tab being able to load it, and the two fail apart: a name that does
   not match the file on disk, a file the fetch cannot reach, a mesh the
   importer chokes on. So nothing here reads CATALOG and calls it done - each
   row is CLICKED in the shipped list and the piece that arrives is measured.

   Per catalog row:
     1. the row exists in the shipped list, labelled with the file's own name
     2. click it -> a new piece on the plate, no existing piece disturbed
     3. it is a real import: rawTris in file axes, and the footprint,
        thickness and triangle count ITS OWN manifest states - not a blanket
        30 x 30, which would paper over the loose ring's real 10 x 10
   Then, once:
     4. the new patch controls are really in the shipped selects -
        crosshatch-fine as a pattern, sandwich as a patch variant
     5. the sandwich patch bakes through the Skin patch button and its status
        says what it is - double-sided, no floor, contact on EACH face
     6. no page errors anywhere */

'use strict';

const path = require('path');
const fs = require('fs');
const { withApp, selectModel, openFinishMenu, ROOT } = require('./nso_app_harness');
const fine = require('./nso_skin_fine_samples.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const waitStatus = (page, re) => page.waitForFunction(
  src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });

/* What each file should come back as, from whichever manifest owns it. */
const EXPECT = fine.expectations();

/* The plate is Y UP while a patch file is Z up, so a piece's `size` reads
   (width, HEIGHT, depth) and its footprint is size.x by size.z. Asserting
   size.x/size.y here would fail every one of these for the wrong reason. */
const footprintOf = size => [size.x, size.z];
/* addModel strips the extension: `name.replace(/\.stl$/i, '')`. */
const pieceName = f => f.replace(/\.stl$/i, '');

withApp(async (page, logs) => {
  console.log('\n=== the Library tab offers every patch this ticket added ===');
  const rows = await page.evaluate(() => {
    const btn = document.getElementById('btn-library');
    if (btn) btn.click();
    return Array.from(document.querySelectorAll('#library-list .library-item'))
      .map(r => r.querySelector('.name').textContent);
  });
  for (const f of fine.CATALOG_FILES) {
    check(f + ': a row in the shipped Library list', rows.indexOf(f) !== -1);
  }
  check('the list is built from CATALOG in order, patches last',
    rows.length >= fine.CATALOG_FILES.length &&
    rows.slice(-fine.CATALOG_FILES.length).join(',') === fine.CATALOG_FILES.join(','),
    rows.slice(-fine.CATALOG_FILES.length).join(', '));

  console.log('\n=== each one loaded by CLICKING its row ===');
  for (const f of fine.CATALOG_FILES) {
    const before = await page.evaluate(() => state.models.length);
    await page.evaluate(() => { const b = document.getElementById('btn-library'); if (b) b.click(); });
    await page.evaluate(name => {
      const row = Array.from(document.querySelectorAll('#library-list .library-item'))
        .find(r => r.querySelector('.name').textContent === name);
      if (!row) throw new Error('no row for ' + name);
      row.click();
    }, f);
    let arrived = true;
    try {
      await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
    } catch (err) { arrived = false; }
    if (!arrived) {
      check(f + ': loaded from the Library tab', false, await statusOf(page));
      continue;
    }
    const info = await page.evaluate(() => {
      const m = state.models[state.models.length - 1];
      return {
        name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : null,
        rawAxis: m.rawAxis, size: m.size
      };
    });
    const st = await statusOf(page);
    const want = EXPECT[f];
    check(f + ': loaded, and the piece keeps the file\'s own name',
      info.name === pieceName(f) && !/failed/i.test(st), info.tris + ' tris, ' + st.slice(0, 70));
    check(f + ': a real import - rawTris in file axes',
      info.tris > 0 && info.rawAxis === 'zup', 'rawAxis ' + info.rawAxis);
    const fp = footprintOf(info.size);
    check(f + ': the footprint its manifest states, ' +
      want.extent[0] + ' x ' + want.extent[1] + ' mm',
      Math.abs(fp[0] - want.extent[0]) < 0.01 && Math.abs(fp[1] - want.extent[1]) < 0.01,
      fp[0].toFixed(2) + ' x ' + fp[1].toFixed(2) + ' mm (thickness ' + info.size.y.toFixed(2) + ')');
    check(f + ': the thickness its manifest states, ' + want.extent[2] + ' mm',
      Math.abs(info.size.y - want.extent[2]) < 0.01, info.size.y.toFixed(3) + ' mm');
    check(f + ': the triangle count its manifest states', info.tris === want.tris,
      info.tris + ' vs ' + want.tris);
  }

  console.log('\n=== the new controls are in the shipped selects ===');
  await openFinishMenu(page);
  {
    const sels = await page.evaluate(() => ({
      pattern: Array.from(document.getElementById('skin-pattern').options).map(o => o.value).join(','),
      variant: Array.from(document.getElementById('skin-patch-variant').options).map(o => o.value).join(','),
      layer2: Array.from(document.getElementById('skin-layer2').options).map(o => o.value).join(',')
    }));
    check('the pattern select offers crosshatch-fine beside the shipped three',
      sels.pattern === 'crosshatch,crosshatch-fine,zigzag,ring', sels.pattern);
    check('the patch variant select offers sandwich beside bordered and loose',
      sels.variant === 'bordered,loose,sandwich', sels.variant);
    check('and layer 2 can use the fine preset too',
      sels.layer2.indexOf('crosshatch-fine') !== -1, sels.layer2);
  }

  console.log('\n=== the sandwich patch through the Skin patch button ===');
  {
    const before = await page.evaluate(() => state.models.length);
    await page.selectOption('#skin-pattern', 'crosshatch-fine');
    await page.selectOption('#skin-patch-variant', 'sandwich');
    await page.click('#btn-skin-patch');
    await page.waitForFunction(n => state.models.length > n, before, { timeout: 60000 });
    await waitStatus(page, /Added patch_/);
    const st = await statusOf(page);
    check('it bakes and names itself', /Added patch_crosshatch-fine_sandwich/.test(st), st.slice(0, 120));
    check('the status says it is double-sided with no floor',
      /double-sided/.test(st) && /no floor/.test(st), st.slice(0, 200));
    check('the status states the contact on EACH face, not one total',
      /on EACH face/.test(st), st.slice(0, 220));
    check('and it is flagged non-solid, like the loose lattice',
      /flagged non-solid/i.test(st), st.slice(-80));
    const info = await page.evaluate(() => {
      const m = state.models[state.models.length - 1];
      return { id: m.id, tris: m.rawTris ? m.rawTris.length / 9 : null, size: m.size };
    });
    check('the baked piece matches the committed library file exactly',
      info.tris === EXPECT['patch_crosshatch-fine_sandwich.stl'].tris,
      info.tris + ' vs ' + EXPECT['patch_crosshatch-fine_sandwich.stl'].tris + ' tris');
    await selectModel(page, info.id);
    await page.evaluate(() => { if (window.nsoNonSolidRefresh) window.nsoNonSolidRefresh(); });
    const shown = await page.evaluate(() => !!document.getElementById('chk-non-solid').checked);
    check('and the shipped checkbox shows the flag', shown === true);
  }

  console.log('\n=== no page errors ===');
  const bad = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
  check('no console errors or page errors', bad.length === 0,
    bad.slice(0, 4).map(l => l.text).join(' | ') || 'clean');
}).then(() => {
  if (fails) { console.log('\n' + fails + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall checks held');
}).catch(err => { console.error(err); process.exit(1); });
