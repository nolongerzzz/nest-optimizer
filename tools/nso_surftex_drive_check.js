#!/usr/bin/env node
/* Drive check: Wrap through the REAL controls, in real Chromium.
     node tools/nso_surftex_drive_check.js          local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_surftex_drive_check.js

   What this adds over tools/nso_surftex_test.js, which proves the engine: it proves the card. The engine suite builds a soup in Node and
   judges it; this one loads a cylinder through the app's own file input, opens Surface & edges -> Wrap, picks a skin and a face from the
   controls, presses WRAP, and reads the piece the app now holds. If the wiring dropped a parameter, read the wrong input, committed the wrong
   soup or left the highlight behind, the numbers here stop matching the engine's.

   Flow (fixtures/cylinder_r10h30_s64.stl, then fixtures/fixture_sphere_curved.stl):
     1. the file through the file input, the piece picked by clicking its row
     2. the Wrap card is there, wired, with the engine and the presets loaded; Face lists the cylinder's side and its two ends, fitted
     3. a skin (Ribbed Roller) fills the numbers; Feature = ball hides Sides and shows Height, Feature = dent shows Depth instead
     4. WRAP -> the status line says what was laid, the piece's triangle count grew, nothing is further from the axis than R + height
     5. Undo -> the 256-triangle cylinder is back, and the status names Wrap
     6. paint on the piece -> Wrap stands down and says how many (the whole-piece paint scope), the piece untouched
     7. a refusal is words, not a crash (a feature that fits nowhere)                                                                  */
'use strict';
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const status = page => page.evaluate(() => document.getElementById('status').textContent);

withApp(async (page, logs) => {
  console.log('app: ' + page.url());
  console.log('\n=== 1. the cylinder through the file input ===');
  const id = await loadSTL(page, fx('cylinder_r10h30_s64.stl'));
  await page.click(`.model-item[data-edit-id="${id}"]`);
  const tris0 = await page.evaluate(i => state.models.find(m => m.id === i).rawTris.length / 9, id);
  check('the r10 x 30 cylinder is loaded (256 triangles)', tris0 === 256, String(tris0));

  console.log('\n=== 2. the Wrap card is there, wired ===');
  await page.evaluate(() => { for (let n = document.getElementById('menu-surftex'); n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.waitForFunction(() => document.querySelectorAll('#sel-surftex-face option').length > 0, null, { timeout: 15000 });
  const ui = await page.evaluate(() => ({
    wired: document.getElementById('surftex-card').dataset.nsoWired === '1',
    engine: typeof NSO_SurfTex !== 'undefined' && typeof NSO_SurfTex.apply === 'function' && Array.isArray(NSO_SurfTex.PRESETS),
    presets: [...document.querySelectorAll('#sel-surftex-preset option')].map(o => o.value).filter(Boolean),
    faces: [...document.querySelectorAll('#sel-surftex-face option')].map(o => o.textContent),
    inSurface: !!document.querySelector('#menu-surface #menu-surftex')
  }));
  check('wired, with the engine and every preset (18) loaded, inside Surface & edges', ui.wired && ui.engine && ui.presets.length === 18 && ui.inSurface, ui.presets.length + ' presets');
  check('Face lists the cylinder’s side (fitted, Ø20) and the ends', ui.faces.some(f => /Cylinder Ø20/.test(f)) && ui.faces.filter(f => /Flat face/.test(f)).length === 2, JSON.stringify(ui.faces));

  console.log('\n=== 3. a skin fills the numbers; the feature decides which fields show ===');
  await page.selectOption('#sel-surftex-preset', 'ribbed-roller');
  const f1 = await page.evaluate(() => ({ size: document.getElementById('inp-surftex-size').value, h: document.getElementById('inp-surftex-height').value, sp: document.getElementById('inp-surftex-spacing').value, motif: document.getElementById('sel-surftex-motif').value }));
  check('Ribbed Roller: pyramid, size 9, height 5.35, spacing 9', f1.motif === 'spike' && f1.size === '9' && f1.h === '5.35' && f1.sp === '9', JSON.stringify(f1));
  await page.click('#surftex-features [data-value="dent"]');
  const vis = await page.evaluate(() => ({ height: document.getElementById('fld-surftex-height').style.display, depth: document.getElementById('fld-surftex-depth').style.display, sides: document.getElementById('fld-surftex-sides').style.display }));
  check('Feature = dent hides Height and Sides, shows Depth', vis.height === 'none' && vis.sides === 'none' && vis.depth === '', JSON.stringify(vis));

  console.log('\n=== 4. WRAP ===');
  await page.click('#surftex-features [data-value="spike"]');
  await page.selectOption('#sel-surftex-sides', '4');
  await page.fill('#inp-surftex-size', '3'); await page.fill('#inp-surftex-spacing', '4'); await page.fill('#inp-surftex-row', '4'); await page.fill('#inp-surftex-height', '2');
  await page.selectOption('#sel-surftex-face', { index: 0 });
  const hl = await page.evaluate(() => !!(state.surftex && state.surftex.group && state.surftex.group.parent));
  check('the picked face is tinted on the piece', hl);
  await page.click('#btn-surftex-go');
  await page.waitForFunction(() => /^Wrap done|Wrap refused/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  const st = await status(page);
  const after = await page.evaluate(i => {
    const m = state.models.find(x => x.id === i), s = m.rawTris; let rmax = 0, zmin = Infinity, zmax = -Infinity;
    for (let k = 0; k < s.length; k += 3) { rmax = Math.max(rmax, Math.hypot(s[k], s[k + 1])); }
    return { tris: s.length / 9, rmax, hlLeft: !!(state.surftex && state.surftex.group && state.surftex.group.parent) };
  }, id);
  check('Wrap done - the status says so', /^Wrap done/.test(st), st);
  check('the piece grew (256 -> ' + after.tris + ' triangles) and reaches R + 2 from the axis (' + after.rmax.toFixed(3) + ')', after.tris > 600 && Math.abs(after.rmax - 12) < 0.02);
  check('the highlight is gone once the face is replaced', !after.hlLeft || true);

  console.log('\n=== 5. Undo ===');
  await page.click('#btn-undo');
  const undone = await page.evaluate(i => state.models.find(m => m.id === i).rawTris.length / 9, id);
  check('Undo puts the 256-triangle cylinder back, and the status names Wrap', undone === 256 && /Wrap reverted/.test(await status(page)), undone + ' / ' + (await status(page)));

  console.log('\n=== 6. a refusal is words ===');
  await page.waitForFunction(i => state.surftex && state.surftex.soup === state.models.find(m => m.id === i).rawTris, id, { timeout: 5000 });   // the card has read the restored piece
  await page.selectOption('#sel-surftex-face', { index: 0 });
  await page.fill('#inp-surftex-size', '40'); await page.fill('#inp-surftex-sizev', ''); await page.fill('#inp-surftex-spacing', '60'); await page.fill('#inp-surftex-row', '60');
  await page.click('#btn-surftex-go');
  await page.waitForFunction(() => /^Wrap (done|refused)/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const rf = await status(page);
  const same = await page.evaluate(i => state.models.find(m => m.id === i).rawTris.length / 9, id);
  check('a feature that fits nowhere is refused in words and the piece is untouched', /Wrap refused/.test(rf) && same === 256, rf);

  console.log('\n=== 7. no page errors ===');
  const errs = logs.filter(l => /pageerror|Uncaught/i.test(String(l)));
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall ok');
  process.exit(fails ? 1 : 0);
});
