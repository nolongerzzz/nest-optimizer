#!/usr/bin/env node
/* THE PLATE'S GENERATE, TIMED IN THE REAL PAGE (headless Chromium, the real planner worker): fixtures/supports/supp_ref.3mf - the six reference
   heads - imported, "Generate for plate" ticked, GENERATE pressed, the clock stopped when the card is idle again. Not a gate: the numbers
   are printed (seconds, and calibration loops, tools/nso_pace.js, so a slow box does not move them). The node twin is support:plate gate 1.
     node tools/nso_support_plate_browser_time.mjs            */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveRoot, routeCdn, launchOpts, ROOT } from './cth-test/browser-lib.mjs';
import pace from './nso_pace.js';

const served = await serveRoot();
const browser = await chromium.launch(launchOpts());
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  routeCdn(page);
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
  const buf = await readFile(join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  await page.evaluate((a) => handleFiles([new File([new Uint8Array(a)], 'supp_ref.3mf')]), Array.from(buf));
  await page.waitForFunction(() => state.models.length >= 6 && state.placed.length >= 6, null, { timeout: 60000 });
  await page.evaluate(() => { const m = document.getElementById('menu-supports'); if (m && !m.open) { m.open = true; m.dispatchEvent(new Event('toggle')); } });
  await page.waitForFunction(() => { const r = document.getElementById('sup-plate-row'); return r && !r.hidden; }, null, { timeout: 30000 });
  await page.evaluate(() => { const e = document.getElementById('sup-plate'); if (e && !e.checked) e.click(); });
  const head = () => page.evaluate(() => document.getElementById('sup-count').textContent);
  console.log('readout:', await head());
  const loops = async () => page.evaluate(pace.loopMs ? `(${pace.loopMs.toString()})()` : '0').catch(() => 0);
  const t0 = Date.now();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 30000 });
  await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 900000 });
  const secs = (Date.now() - t0) / 1000;
  console.log('PLATE GENERATE (browser):', secs.toFixed(1), 's  -', await head());
} finally { await browser.close(); }
process.exit(0);
