#!/usr/bin/env node
/**
 * nest-optimizer / tools/cth-test / drive-check.mjs
 *
 * Runs ?cth=drive for real, in headless Chromium, and asserts it passes.
 *
 * This is the one path the rest of the suite could not reach. The Node checks
 * cover the pieces - the paint maths (paint-six-outer), the status grade rule
 * (drive-fixes), the overlay readout (overlay-summary) - but the drive itself
 * is a browser thing end to end: it fetches the fixture, imports it through
 * the app's own handleFiles, paints six faces, presses the real Soften button,
 * and waits on a wasm CSG bake. None of that runs in Node.
 *
 * The bake is the reason it was unreachable: NSO_CSG (app-join.js) imports
 * the manifold kernel from cdn.jsdelivr.net, which not every runner can
 * reach. browser-lib serves the vendor/manifold copy that is already in the
 * repo instead, so the kernel is real and the network is not needed.
 *
 * It does not take the driver's word for it. The driver's own verdict is one
 * assertion; the rest read the app: the status wording Nest itself emits, the
 * paint still on the piece, and the geometry actually changed.
 *
 * Usage:
 *   npm run cth:drive
 *   CHROME_PATH=/path/to/chrome node tools/cth-test/drive-check.mjs
 */
import { chromium } from 'playwright';
import { serveRoot, routeCdn, mkCheck, launchOpts } from './browser-lib.mjs';

const FIXTURE_TRIS = 28;          // library/CTH_fixture.stl - the unwrapped box hull
const check = mkCheck();

async function main() {
  const external = process.env.APP_URL;
  const served = external ? null : await serveRoot();
  const base = external || served.base;

  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const cdn = routeCdn(page);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const driveLog = [];
  page.on('console', (m) => { if (m.text().startsWith('[cth-drive]')) driveLog.push(m.text()); });

  console.log(`\nNest at ${base}/index.html?cth=drive`);
  await page.goto(`${base}/index.html?cth=drive`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });

  /* The drive runs itself on mount. Its last act is say(), which writes the
     verdict into #status and the fallback card, so wait for that rather than
     for a fixed time. 60s: the driver's own settle wait is 30s and the fixture
     import and the kernel load sit in front of it. */
  await page.waitForFunction(
    "/^DRIVE /.test((document.getElementById('status')||{}).textContent || '')",
    null, { timeout: 60000 },
  );

  const verdict = await page.evaluate(() => document.getElementById('status').textContent.trim());
  console.log('\nverdict: ' + verdict);
  if (driveLog.length) console.log('drive log:\n  ' + driveLog.join('\n  '));

  // --- the environment the drive actually ran in ---
  console.log('\n--- the build under test ---');
  check('the manifold kernel was fetched', cdn.includes('manifold-3d@3.5.3/manifold.js'), true);
  check('its wasm was fetched', cdn.includes('manifold-3d@3.5.3/manifold.wasm'), true);
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('NSO_CSG is present in this build', await page.evaluate(() => typeof NSO_CSG), 'object');

  // --- the driver's own verdict ---
  console.log('\n--- the drive ---');
  check('the drive reports PASS', /^DRIVE PASS\b/.test(verdict), true);

  /* Not taking the driver's word for it. DRIVE PASS carries the Nest status
     line that earned it, so the wording Nest itself emitted is checkable, and
     the piece is checkable on top of that. */
  console.log('\n--- what Nest itself reported ---');
  check('the status is a wrap bake, at the radius the drive set', /wrap R 0\.50/i.test(verdict), true);
  check('faces were baked', /faces baked/i.test(verdict), true);
  check('the painted faces were left square', /painted out and left square/i.test(verdict), true);
  check('it was not left armed for a face pick', /click a face/i.test(verdict), false);
  check('it did not refuse', /(Wrap failed|Wrap stopped|Piece unchanged)/i.test(verdict), false);

  console.log('\n--- the piece on the plate ---');
  const piece = await page.evaluate(() => {
    const m = window.state.models[0];
    return {
      painted: window.nsoMaskCount(m),
      tris: m.geometry.attributes.position.count / 3,
      rawTris: m.rawTris.length / 9,
      hasRaw: !!(m.rawTris && m.rawTris.length),
    };
  });
  check('six faces are still painted out', piece.painted, 6);
  check('the piece still has a raw soup', piece.hasRaw, true);
  check('the geometry changed - a bake really landed',
    piece.tris !== FIXTURE_TRIS && piece.rawTris !== FIXTURE_TRIS, true);
  console.log(`       fixture ${FIXTURE_TRIS} tris  ->  baked ${piece.tris} display / ${piece.rawTris} raw`);

  check('no uncaught page errors', errors, []);

  await browser.close();
  if (served) served.srv.close();
  if (check.report()) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
