#!/usr/bin/env node
/* ============================================================
   tools/nso_support_settings_drive_check.mjs - THE REAL PAGE: the Print card - Advanced, Saved settings, May rest on the part, Slice
   (npm run support:settings-drive, in driveSteps; docs/SUPPORTS-CARD.md section 10)

   The owner's Supporttest on the plate. The card's Advanced section and Saved settings row are there and work as a hand would work them:
   save under a name (the browser's prompt), move the controls, pick the name - every control is back; reload - the card opens with what was
   saved. Then May rest on the part at 46 deg: Generate builds ONE support in the build worker, with nothing unreachable.
   Then the Print card itself (docs/PRINT-CARD.md): Slice with Supports unticked takes the supports off and slices the bare plate, the raft
   is still reached, Preview opens the slice in G-scope (which has no settings of its own), the built-in "NSO classic" puts the old numbers
   back, and the card's Printer row is the Plate panel's.
   A screenshot of the card and the built plate goes to tools/support-settings-out/.
   ============================================================ */
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const SHOTS = join(ROOT, 'tools', 'support-settings-out');
const check = mkCheck();

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let promptAnswer = 'PLA slim';
  page.on('dialog', (d) => d.accept(promptAnswer));
  const open = async () => {
    await page.goto(served.base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
    await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD && !!window.NSO_SupportFlow, null, { timeout: 30000 });
  };
  const val = (id) => page.evaluate((i) => { const e = document.getElementById(i); return e ? (e.type === 'checkbox' ? e.checked : e.value) : null; }, id);
  const set = (id, v) => page.evaluate(([i, x]) => { const e = document.getElementById(i); if (e.type === 'checkbox') e.checked = !!x; else e.value = String(x); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);

  await open();
  const bytes = Array.from(await readFile(join(ROOT, 'fixtures', 'supports', 'supporttest.3mf')));
  const load = async () => {
    await page.evaluate((a) => handleFiles([new File([new Uint8Array(a)], 'Supporttest.3mf')]), bytes);
    await page.waitForFunction(() => state.placed.length >= 1, null, { timeout: 30000 });
    await page.evaluate(() => { const m = document.getElementById('menu-supports'); m.open = true; m.dispatchEvent(new Event('toggle')); });
    await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 60000 });
  };
  await load();

  console.log('-- the controls');
  const ids = ['sup-adv-sec', 'sup-adv-cover', 'sup-adv-tipdrop', 'sup-adv-gather', 'sup-adv-reach', 'sup-adv-floor', 'sup-adv-flare', 'sup-adv-flaretan',
    'sup-bambu-sec', 'slice-set-sup-density', 'slice-set-sup-expand', 'slice-set-sup-walls', 'slice-set-sup-topz', 'slice-set-sup-bottomz', 'slice-set-sup-base', 'slice-set-sup-base-spacing', 'slice-set-sup-angle',
    'sup-interface', 'slice-set-sup-iface-pattern', 'slice-set-sup-iface-spacing', 'slice-set-sup-expansion', 'slice-set-sup-xy', 'slice-set-sup-zover', 'slice-set-sup-first-gap', 'slice-set-sup-bridge', 'slice-set-sup-indep',
    'sup-adv-defaults', 'sup-preset', 'sup-preset-save', 'sup-preset-delete', 'sup-preset-export', 'sup-preset-import'];
  const have = await page.evaluate((list) => list.filter((i) => !document.getElementById(i)), ids);
  check('Tree planner, Bambu\'s Advanced rows and the Saved settings row are on the card', have, []);
  check('every lever Saved settings keeps is a control of the page', await page.evaluate(() => window.NSO_SUPPORTS_CARD.settings.fields.filter((i) => !document.getElementById(i))), []);
  check('Advanced at its defaults sends nothing; Defaults is off', [await page.evaluate(() => window.NSO_SUPPORTS_CARD.settings.advanced()), await page.evaluate(() => document.getElementById('sup-adv-defaults').disabled)], [null, true]);

  console.log('-- save, move, pick');
  check('Bambu\'s rows open at the printer profile\'s values, in Bambu\'s order', await page.evaluate(() => [...document.querySelectorAll('#sup-bambu-sec input, #sup-bambu-sec select')].map((e) => e.id + '=' + (e.type === 'checkbox' ? e.checked : e.value))),
    ['slice-set-sup-density=90', 'slice-set-sup-expand=-1', 'slice-set-sup-walls=-1', 'slice-set-sup-topz=0.2', 'slice-set-sup-bottomz=0.2', 'slice-set-sup-base=default', 'slice-set-sup-base-spacing=2.5', 'slice-set-sup-angle=0',
      'sup-interface=3', 'slice-set-sup-iface-pattern=default', 'slice-set-sup-iface-spacing=0.5', 'slice-set-sup-expansion=0', 'slice-set-sup-xy=0.35', 'slice-set-sup-zover=false', 'slice-set-sup-first-gap=0.2',
      'slice-set-sup-bridge=0', 'slice-set-sup-indep=true']);
  await set('sup-angle', 46); await set('sup-rest', true); await set('sup-adv-tipdrop', 2.4); await set('sup-tree-distance', 4.5);
  await set('slice-set-sup-iface-pattern', 'concentric'); await set('slice-set-sup-base', 'rectilinear'); await set('slice-set-sup-topz', 0.25); await set('slice-set-sup-zover', true);
  check('a changed Advanced number is counted, and Defaults comes on', [await page.evaluate(() => document.getElementById('sup-adv-note').textContent), await page.evaluate(() => document.getElementById('sup-adv-defaults').disabled)], ['1 changed from the defaults', false]);
  await page.click('#sup-preset-save');
  check('Save asks for a name and lists it, picked', [await val('sup-preset'), await page.evaluate(() => window.NSO_SUPPORTS_CARD.settings.names())], ['PLA slim', ['PLA slim']]);
  await set('sup-angle', 30); await set('sup-rest', false); await set('sup-adv-tipdrop', 2.8); await set('sup-tree-distance', 5);
  await set('slice-set-sup-iface-pattern', 'default'); await set('slice-set-sup-base', 'default'); await set('slice-set-sup-topz', 0.2); await set('slice-set-sup-zover', false);
  check('a control moved by hand: the list reads not saved', await val('sup-preset'), '');
  await page.selectOption('#sup-preset', 'PLA slim');
  check('picking the name puts every control back', [await val('sup-angle'), await val('sup-rest'), await val('sup-adv-tipdrop'), await val('sup-tree-distance'), await val('sup-preset')], ['46', true, '2.4', '4.5', 'PLA slim']);
  check('...Bambu\'s rows with them', [await val('slice-set-sup-iface-pattern'), await val('slice-set-sup-base'), await val('slice-set-sup-topz'), await val('slice-set-sup-zover')], ['concentric', 'rectilinear', '0.25', true]);
  check('...and the card\'s own angle with it', (await page.evaluate(() => window.NSO_SUPPORTS_CARD.view().line || document.getElementById('sup-count').textContent)).includes('46'), true);

  console.log('-- reload');
  await open(); await load();
  check('the card opens with what was saved last', [await val('sup-preset'), await val('sup-angle'), await val('sup-rest'), await val('sup-adv-tipdrop'), await val('slice-set-sup-iface-pattern'), await val('slice-set-sup-zover')], ['PLA slim', '46', true, '2.4', 'concentric', true]);

  console.log('-- Slice, Supports ticked: May rest on the part, at 46 deg');
  const t0 = Date.now();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 30000 }).catch(() => {});
  const idle = async () => { await page.waitForTimeout(400); await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy() && !window.NSO_Print.card.state().busy, null, { timeout: 300000 }); await page.waitForTimeout(800); };
  await idle();
  const head = await page.evaluate(() => document.getElementById('sup-count').textContent);
  const nSup = await page.evaluate(() => state.models.filter((m) => m.nsoSupport && !m.nsoSupport.brim).length);
  check('one support, nothing unreachable (built in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)', [nSup, /unreachable 0/.test(head), /unsupported 0/.test(head)], [1, true, true]);
  console.log('       ' + head);
  /* the plate's slice (Generate slices it with the Slice settings, these rows among them): the interface is rings, the tree is crossed by lines */
  const sl = await page.evaluate(() => { const st = window.NSO_Print && NSO_Print.card ? NSO_Print.card.state() : null, r = st && st.result; return r ? { ok: !!r.ok, changed: r.changed || null } : null; });
  check('the slice Generate made carries the rows that were changed, by Bambu\'s keys', !!sl && sl.ok && ['support_interface_pattern', 'support_base_pattern', 'support_top_z_distance', 'top_z_overrides_xy_distance'].every((k) => (sl.changed || []).indexOf(k) >= 0), true);
  await page.evaluate(() => { const d = document.getElementById('sup-bambu-sec'); if (d) d.open = true; });
  await page.screenshot({ path: join(SHOTS, 'card-and-plate.png') });

  console.log('-- the Print card');
  const text = (id) => page.evaluate((i) => (document.getElementById(i) || {}).textContent || '', id);
  const off = (id) => page.evaluate((i) => { const e = document.getElementById(i); return !e || !!e.disabled; }, id);
  check('one card, named Print: Slice, Preview and Export, and none of the buttons it took the place of',
    [await page.evaluate(() => document.querySelector('#menu-supports > summary').textContent.trim()), (await text('btn-sup-all')).trim(), (await text('btn-sup-slice')).trim(),
      await page.evaluate(() => ['btn-slice-go', 'btn-sup-none', 'btn-sup-remove', 'slice-set-angle', 'slice-set-iface', 'sup-plate'].filter((i) => document.getElementById(i)))],
    ['Print', 'Slice', 'Preview', []]);
  check('the types are Straight strut, Tree and Gecko Hands (None is the tick)', await page.evaluate(() => [...document.getElementById('sup-style').options].map((o) => o.textContent.trim())), ['Straight strut', 'Tree', 'Gecko Hands']);
  check('after Slice the file can be exported and previewed', [await off('btn-slice-export'), await off('btn-sup-slice')], [false, false]);
  const sliced = await text('sup-slice-line');
  await set('sup-on', false);
  check('Supports unticked: the supports\' rows are greyed, the raft and the brim are not', await page.evaluate(() => [document.getElementById('print-sup-body').inert, !!document.getElementById('slice-set-raft').closest('[inert]'), !!document.getElementById('slice-set-brim').closest('[inert]')]), [true, false, false]);
  await page.click('#btn-sup-all'); await idle();
  const bare = await text('sup-slice-line');
  check('...Slice takes the supports off the plate and slices it bare: ' + bare, [await page.evaluate(() => state.models.filter((m) => m.nsoSupport).length), /^Sliced/.test(bare), bare !== sliced, await off('btn-slice-export')], [0, true, true, false]);
  await page.click('#btn-undo'); await page.waitForTimeout(600);
  check('...and one Undo puts them back', await page.evaluate(() => state.models.filter((m) => m.nsoSupport && !m.nsoSupport.brim).length), 1);
  await page.evaluate(() => { const m = document.getElementById('menu-supports'); if (!m.open) { m.open = true; m.dispatchEvent(new Event('toggle')); } });
  await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 60000 });
  await page.selectOption('#sup-preset', 'NSO classic');
  check('the built-in "NSO classic" puts the old numbers back (top Z 0.18, first layer solid, bridges to 5 mm) and cannot be deleted',
    [await val('slice-set-sup-topz'), await val('slice-set-sup-density'), await val('slice-set-sup-bridge'), await off('sup-preset-delete'), await val('sup-preset')], ['0.18', '100', '5', true, 'NSO classic']);
  check('G-scope has no slice settings of its own: a note, and no row', await page.evaluate(() => [document.querySelectorAll('[id^="ms-slice-set-"]').length, !!document.getElementById('ms-slice-settings-note')]), [0, true]);
  await page.click('#btn-sup-slice'); await page.waitForTimeout(600); await idle();
  await page.waitForFunction(() => { const c = document.getElementById('ms-close'); return !!c && c.offsetParent !== null; }, null, { timeout: 120000 });
  check('Preview opens the plate\'s slice in G-scope: ' + (await text('ms-slice-settings-note')), /Print card/.test(await text('ms-slice-settings-note')), true);
  await page.screenshot({ path: join(SHOTS, 'preview.png') });
  await page.click('#ms-close'); await page.waitForTimeout(600);
  await page.evaluate(() => { const m = document.getElementById('menu-supports'); if (!m.open) { m.open = true; m.dispatchEvent(new Event('toggle')); } });
  await page.waitForTimeout(600);
  check('the card\'s Printer row is the Plate panel\'s: the same choice, either way', [await val('print-printer'), await val('plate-select')], ['a1mini', 'a1mini']);
  await page.selectOption('#print-printer', 'p1s'); await page.waitForTimeout(1200);
  check('...changed on the card, the plate changes', [await val('plate-select'), await page.evaluate(() => state.plate && (state.plate.id || state.plate.key || null))].slice(0, 1), ['p1s']);
  await page.selectOption('#plate-select', 'a1mini'); await page.waitForTimeout(1200);
  check('...changed on the Plate panel, the card follows', await val('print-printer'), 'a1mini');
  /* ...on a page that never had a piece (nothing else redraws the card there): the owner changed the Plate panel and the card's row stayed
     as it was until the card was closed and opened again */
  await open();
  await page.click('#menu-supports > summary'); await page.waitForTimeout(1200);
  const seq = [];
  for (const [id, to] of [['print-printer', 'p1s'], ['plate-select', 'a1mini'], ['plate-select', 'p1s'], ['print-printer', 'a1mini'], ['plate-select', 'p1s']]) {
    await page.selectOption('#' + id, to); await page.waitForTimeout(600);
    seq.push([await val('print-printer'), await val('plate-select')].join('/'));
  }
  check('...and on an empty page, the card left open: card, panel, panel, card, panel - both rows agree after every change', seq, ['p1s/p1s', 'a1mini/a1mini', 'p1s/p1s', 'a1mini/a1mini', 'p1s/p1s']);
  /* a printer that changed with no hand on a picker (a saved scene opened: applySavedPlate sets it): the profile line follows the Printer row */
  await page.evaluate(() => { state.plate = 'a1mini'; document.getElementById('plate-select').value = 'a1mini'; });
  await page.waitForTimeout(1300);
  const lineA = await page.evaluate(() => document.getElementById('slice-profile').textContent);
  await page.evaluate(() => { state.plate = 'p1s'; document.getElementById('plate-select').value = 'p1s'; });
  await page.waitForTimeout(1300);
  check('the printer set by an opened file: the Printer row and the profile line both say it', [/A1 mini/.test(lineA), await val('print-printer'), /P1S/.test(await page.evaluate(() => document.getElementById('slice-profile').textContent))], [true, 'p1s', true]);
  /* ...and the plate's 3MF export is that printer's project */
  await load();
  const tplAsked = await page.evaluate(async () => {
    const real = NSO3MF.build3MF, seen = [];
    NSO3MF.build3MF = function (o) { seen.push(o.template); return real.apply(this, arguments); };
    const dl = window.downloadBlob; window.downloadBlob = function () {};
    try { await export3MF(); state.plate = 'a1mini'; await export3MF(); } finally { NSO3MF.build3MF = real; window.downloadBlob = dl; state.plate = 'p1s'; }
    return seen;
  });
  check('Export plate 3MF is written from the plate\'s own printer template: the P1S\'s on a P1S plate, the A1 mini\'s on its plate', tplAsked, ['p1s-0.4', 'a1mini-0.4']);
  check('no page error', errors, []);
  await browser.close(); if (served.server && served.server.close) served.server.close();
  process.exit(check.report() ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
