#!/usr/bin/env node
/* ============================================================
   tools/nso_support_settings_drive_check.mjs - THE REAL PAGE: Advanced, Saved settings, May rest on the part
   (npm run support:settings-drive, in driveSteps; docs/SUPPORTS-CARD.md section 10)

   The owner's Supporttest on the plate. The card's Advanced section and Saved settings row are there and work as a hand would work them:
   save under a name (the browser's prompt), move the controls, pick the name - every control is back; reload - the card opens with what was
   saved. Then May rest on the part at 46 deg: Generate builds ONE support in the build worker, with nothing unreachable.
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
  const ids = ['sup-adv-sec', 'sup-adv-cover', 'sup-adv-tipdrop', 'sup-adv-gather', 'sup-adv-reach', 'sup-adv-floor', 'sup-adv-flare', 'sup-adv-flaretan', 'sup-adv-pad', 'sup-adv-xy', 'sup-adv-bottom',
    'sup-adv-defaults', 'sup-preset', 'sup-preset-save', 'sup-preset-delete', 'sup-preset-export', 'sup-preset-import'];
  const have = await page.evaluate((list) => list.filter((i) => !document.getElementById(i)), ids);
  check('Advanced and the Saved settings row are on the card', have, []);
  check('every lever Saved settings keeps is a control of the page', await page.evaluate(() => window.NSO_SUPPORTS_CARD.settings.fields.filter((i) => !document.getElementById(i))), []);
  check('Advanced at its defaults sends nothing; Defaults is off', [await page.evaluate(() => window.NSO_SUPPORTS_CARD.settings.advanced()), await page.evaluate(() => document.getElementById('sup-adv-defaults').disabled)], [null, true]);

  console.log('-- save, move, pick');
  await set('sup-angle', 46); await set('sup-rest', true); await set('sup-adv-tipdrop', 2.4); await set('sup-tree-distance', 4.5);
  check('a changed Advanced number is counted, and Defaults comes on', [await page.evaluate(() => document.getElementById('sup-adv-note').textContent), await page.evaluate(() => document.getElementById('sup-adv-defaults').disabled)], ['1 changed from the defaults', false]);
  await page.click('#sup-preset-save');
  check('Save asks for a name and lists it, picked', [await val('sup-preset'), await page.evaluate(() => window.NSO_SUPPORTS_CARD.settings.names())], ['PLA slim', ['PLA slim']]);
  await set('sup-angle', 30); await set('sup-rest', false); await set('sup-adv-tipdrop', 2.8); await set('sup-tree-distance', 5);
  check('a control moved by hand: the list reads not saved', await val('sup-preset'), '');
  await page.selectOption('#sup-preset', 'PLA slim');
  check('picking the name puts every control back', [await val('sup-angle'), await val('sup-rest'), await val('sup-adv-tipdrop'), await val('sup-tree-distance'), await val('sup-preset')], ['46', true, '2.4', '4.5', 'PLA slim']);
  check('...and the card\'s own angle with it', (await page.evaluate(() => window.NSO_SUPPORTS_CARD.view().line || document.getElementById('sup-count').textContent)).includes('46'), true);

  console.log('-- reload');
  await open(); await load();
  check('the card opens with what was saved last', [await val('sup-preset'), await val('sup-angle'), await val('sup-rest'), await val('sup-adv-tipdrop')], ['PLA slim', '46', true, '2.4']);

  console.log('-- Generate: May rest on the part, at 46 deg');
  const t0 = Date.now();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 300000 });
  const head = await page.evaluate(() => document.getElementById('sup-count').textContent);
  const nSup = await page.evaluate(() => state.models.filter((m) => m.nsoSupport && !m.nsoSupport.brim).length);
  check('one support, nothing unreachable (built in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)', [nSup, /unreachable 0/.test(head), /unsupported 0/.test(head)], [1, true, true]);
  console.log('       ' + head);
  await page.evaluate(() => { const d = document.getElementById('sup-adv-sec'); if (d) d.open = true; });
  await page.screenshot({ path: join(SHOTS, 'card-and-plate.png') });
  check('no page error', errors, []);
  await browser.close(); if (served.server && served.server.close) served.server.close();
  process.exit(check.report() ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
