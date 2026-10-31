#!/usr/bin/env node
/* THE USER'S OWN PATH, IN THE REAL PAGE (headless Chromium): the six-part supp_ref imported, "Generate for plate" ticked, GENERATE pressed, then
   G-scope's Slice - what the Slice switch does - and the slice's moves written out (JSON) for tools/nso_support_score.js --moves, or just read.
     node tools/nso_support_plate_page_slice.mjs out.json
   Why: a headless score that is not the page's own path can be right while the page shows nothing new. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serveRoot, routeCdn, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const out = process.argv[2];
const printOut = process.argv[3];      // optional: ALSO run the Print card's Slice (what Export .gcode.3mf writes) and save its .gcode.3mf here
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
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 30000 });
  await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 900000 });
  console.log('supports:', await page.evaluate(() => document.getElementById('sup-count').textContent));
  console.log('meta:', JSON.stringify(await page.evaluate(() => state.models.filter(m => m.nsoSupport).slice(0, 3).map(m => ({ name: m.name, sheetLayerMm: m.nsoSupport.sheetLayerMm, interfaceLayers: m.nsoSupport.interfaceLayers })))));
  if (printOut) {
    const r = await page.evaluate(async () => {
      const C = window.NSO_Print.card;
      const o = await C.slice();
      if (!o || !o.ok) return { ok: false, reason: o && o.reason };
      const b = C.state().result.bytes; let bin = ''; for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
      return { ok: true, line: o.line, b64: btoa(bin) };
    });
    if (!r.ok) console.log('print slice refused:', r.reason);
    else { await writeFile(printOut, Buffer.from(r.b64, 'base64')); console.log('print slice:', r.line, '->', printOut); }
  }
  // G-scope on the plate, then the Slice switch's own call
  await page.evaluate(() => { const M = window.NSO_MICROSCOPE; if (M.openPlate) M.openPlate(); });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(async () => {
    const r = await window.NSO_GSCOPE_SLICE.slice();
    if (!r || !r.ok) return { ok: false, reason: r && r.reason };
    const names = {}; (r.result.objects || []).forEach(o => { names[o.key != null ? o.key : o.name] = o.name; });
    const moves = r.parsed.moves.map(m => ({ feature: m.feature, z: m.z, x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, width: m.width, height: m.height, length: m.length, objectId: m.objectId }));
    return { ok: true, n: moves.length, planes: r.result.planes.length, objs: (r.result.objects || []).map(o => ({ name: o.name, role: o.role, key: o.key, planes: o.planes ? o.planes.length : null })), moves };
  });
  if (!res.ok) { console.log('slice refused:', res.reason); } else {
    console.log('sliced:', res.n, 'moves, shared planes', res.planes, '| objects:', JSON.stringify(res.objs.map(o => o.name + (o.planes ? ' (own grid ' + o.planes + ')' : ''))));
    if (out) await writeFile(out, JSON.stringify(res));
  }
} finally { await browser.close(); }
process.exit(0);
