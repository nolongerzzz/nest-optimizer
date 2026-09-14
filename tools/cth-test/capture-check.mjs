#!/usr/bin/env node
/**
 * nest-optimizer / tools/cth-test / capture-check.mjs
 *
 * Ported from click-test's replay/capture-check.js, but pointed at the real
 * Nest app instead of a synthetic demo host. Nest IS the worst case that check
 * was written for: app-core.js registers its pointerdown inside initThree()
 * while the document is still parsing, so the host's own move tool is bound
 * BEFORE anything the harness does.
 *
 * Two things are proved here, and neither can be proved without a browser:
 *
 *   A. the harness capture (gestures 1-6) - an armed pick must reach the
 *      harness and must not start the host's move drag, and the drag/click
 *      boundary must be real in both directions;
 *   B. the paint-mode guard (gesture 7) - a paint click on a piece must paint
 *      the face and must NOT leave the status reading "Moved model #N".
 *
 * B is the fix in app-core.js's nsoMaskTakesClick stand-down. Up to now it was
 * only covered by the source checks and the EventTarget model in
 * paint-click-steal.test.mjs, which prove the contract but never press a real
 * mouse button.
 *
 * Hermetic on purpose: index.html pulls three from cdn.jsdelivr.net, and the
 * CDN is not reachable from every CI box (it is blocked outright by the agent
 * proxy this was written on). Those three requests are served from the local
 * three devDependency instead, so the check needs no network at all.
 *
 * Usage:
 *   npm run cth:capture
 *   APP_URL=http://localhost:5174 node tools/cth-test/capture-check.mjs
 *   CHROME_PATH=/path/to/chrome  node tools/cth-test/capture-check.mjs
 *
 * CI gets its browser from `npx playwright install chromium` and needs no
 * CHROME_PATH. Set it when a matching build is already on the box and
 * downloading another one is not wanted - a sandbox with a pinned Chromium,
 * say, or an air-gapped runner.
 */
import { chromium } from 'playwright';
import { ROOT, serveRoot, routeCdn, mkCheck, launchOpts } from './browser-lib.mjs';

const DRAG_PX = 24;               // cth/pointer-capture.js dragThresholdPx
const check = mkCheck();

async function main() {
  const external = process.env.APP_URL;
  const served = external ? null : await serveRoot();
  const base = external || served.base;

  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });

  routeCdn(page);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`${base}/index.html?cth=finish`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready && window.__CTH_HARNESS__', null, { timeout: 20000 });

  /* Put the fixture on the plate the way the app does it, through handleFiles,
     so the piece has the rawTris the paint and the wrap both read. */
  await page.evaluate(async () => {
    const buf = await (await fetch('library/CTH_fixture.stl', { cache: 'no-store' })).arrayBuffer();
    handleFiles([new File([buf], 'CTH_fixture.stl', { type: 'model/stl' })]);
  });
  await page.waitForFunction('window.state.placed.length === 1 && window.state.placed[0].mesh', null, { timeout: 20000 });
  await page.evaluate(() => { selectPlaced(0); if (window.__CTH_REBUILD__) window.__CTH_REBUILD__(); });

  /* The probe. Nothing here is app code - it only reads what Nest and the
     harness already expose, so the check cannot pass by instrumenting the
     thing it is testing. */
  await page.evaluate(() => {
    const rect = () => state.renderer.domElement.getBoundingClientRect();
    const shadow = () => document.querySelector('[data-cth-overlay]').shadowRoot;
    window.__NESTCHECK__ = {
      hitAt(cx, cy) {
        const r = rect();
        return window.__CTH_HOST__.raycastAtScreenPoint({
          xNDC: ((cx - r.left) / r.width) * 2 - 1,
          yNDC: -((cy - r.top) / r.height) * 2 + 1,
        });
      },
      centre() {                       // the piece's own centre, on screen
        const v = new THREE.Vector3();
        state.placed[0].mesh.getWorldPosition(v);
        v.project(state.camera);
        const r = rect();
        return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
      },
      status: () => String(document.getElementById('status').textContent || ''),
      setStatus: (t) => { document.getElementById('status').textContent = t; },
      note: () => String(shadow().getElementById('cth-note').textContent || ''),
      xz: () => ({ x: state.placed[0].x, z: state.placed[0].z }),
      results: () => window.__CTH_HARNESS__.getResults(),
      isArmed: () => window.__CTH_HARNESS__.isArmed(),
      armOnce: () => window.__CTH_HARNESS__.armOnce(),
      paintOn: () => { if (!state.maskPaint) document.getElementById('btn-mask-paint').click(); return !!state.maskPaint; },
      paintOff: () => { if (state.maskPaint) document.getElementById('btn-mask-paint').click(); return !!state.maskPaint; },
      maskCount: () => window.nsoMaskCount(state.models.find((m) => m.id === state.placed[0].sourceId)),
    };
  });

  const centre = async () => page.evaluate(() => window.__NESTCHECK__.centre());
  const SENTINEL = '--- nothing yet ---';
  const arm = async () => page.evaluate(() => window.__NESTCHECK__.armOnce());
  const reset = async () => page.evaluate((s) => window.__NESTCHECK__.setStatus(s), SENTINEL);

  async function gesture(dx = 0, dy = 0, steps = 1) {
    const c = await centre();
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    if (dx || dy) await page.mouse.move(c.x + dx, c.y + dy, { steps });
    await page.mouse.up();
    await page.waitForTimeout(160);
  }

  console.log(`\nNest at ${base}/index.html?cth=finish   drag threshold ${DRAG_PX}px (Manhattan)`);
  const aim = await page.evaluate(() => window.__NESTCHECK__.hitAt(
    window.__NESTCHECK__.centre().x, window.__NESTCHECK__.centre().y));
  check('the fixture is under the aim point', !!(aim && aim.hit), true);
  check('it resolves as the CTH fixture', aim && aim.objectId, 'CTH_fixture');

  // --- 1. Not armed: the host must still take the click, or this proves nothing.
  console.log('\n--- gesture 1: NOT armed (the host move is expected to win) ---');
  await reset();
  const r0 = await page.evaluate(() => window.__NESTCHECK__.results().length);
  await gesture();
  const g1 = await page.evaluate(() => ({ status: window.__NESTCHECK__.status(), n: window.__NESTCHECK__.results().length }));
  check('host reported its move', /^Moved model #\d+$/.test(g1.status), true);
  check('harness recorded nothing', g1.n, r0);

  // --- 2. Armed: the host must be locked out and the harness must get the pick.
  console.log('\n--- gesture 2: ARMED (the pick must reach the harness) ---');
  await reset();
  await arm();
  check('harness reports armed', await page.evaluate(() => window.__NESTCHECK__.isArmed()), true);
  const xz2 = await page.evaluate(() => window.__NESTCHECK__.xz());
  await gesture();
  const g2 = await page.evaluate(() => ({
    status: window.__NESTCHECK__.status(), xz: window.__NESTCHECK__.xz(),
    results: window.__NESTCHECK__.results(), armed: window.__NESTCHECK__.isArmed(),
  }));
  check('host did NOT report a move', /Moved model/.test(g2.status), false);
  check('the piece did not slide', g2.xz, xz2);
  check('harness recorded exactly one pick', g2.results.length, r0 + 1);
  check('the pick resolved the fixture', g2.results[g2.results.length - 1].hit.objectId, 'CTH_fixture');
  /* Deliberately not asserting pass. Whether a pick passes depends on which
     aim is current - aims 2 and 4 want region 'pocket' and every gesture here
     clicks the hull - and that is the grader's business, not the capture's.
     What capture has to prove is that the ray was cast and reached the piece,
     which is exactly "not a miss". */
  check('the pick was graded, not missed', g2.results[g2.results.length - 1].result !== 'miss', true);
  check('capture stood down after one pick', g2.armed, false);

  // --- 3. Disarmed again: the host gets its input back.
  console.log('\n--- gesture 3: disarmed again (host input restored) ---');
  await reset();
  await gesture();
  check('host reported a move again', /^Moved model #\d+$/.test(
    await page.evaluate(() => window.__NESTCHECK__.status())), true);

  // --- 4. A drag while armed must not be graded as a pick.
  console.log('\n--- gesture 4: armed, but dragged (must not grade) ---');
  await reset();
  await arm();
  const n4 = await page.evaluate(() => window.__NESTCHECK__.results().length);
  await gesture(60, 40, 8);
  const g4 = await page.evaluate(() => ({
    status: window.__NESTCHECK__.status(), n: window.__NESTCHECK__.results().length, note: window.__NESTCHECK__.note(),
  }));
  check('host stayed locked out through the armed drag', /Moved model/.test(g4.status), false);
  check('armed drag was not graded as a pick', g4.n, n4);
  check('armed drag was reported as an ignored drag', /treated as a drag/i.test(g4.note), true);

  // --- 5. Sub-threshold jitter is still a click. A human clicking a real model
  //        does not hold the mouse perfectly still.
  console.log(`\n--- gesture 5: armed, 8px of jitter (under ${DRAG_PX} must still be a click) ---`);
  await reset();
  await arm();
  const n5 = await page.evaluate(() => window.__NESTCHECK__.results().length);
  await gesture(4, 4, 3);                                   // Manhattan 8
  const g5 = await page.evaluate(() => ({
    status: window.__NESTCHECK__.status(), results: window.__NESTCHECK__.results(),
  }));
  check('jitter still graded as a click', g5.results.length, n5 + 1);
  check('jitter resolved the fixture', g5.results[g5.results.length - 1].hit.objectId, 'CTH_fixture');
  check('jitter was graded, not missed', g5.results[g5.results.length - 1].result !== 'miss', true);
  check('host stayed locked out through the jitter', /Moved model/.test(g5.status), false);

  // --- 6. Over the threshold is a drag, so the boundary is real both ways.
  console.log(`\n--- gesture 6: armed, 40px of travel (over ${DRAG_PX} must be a drag) ---`);
  await reset();
  await arm();
  const n6 = await page.evaluate(() => window.__NESTCHECK__.results().length);
  await gesture(20, 20, 4);                                 // Manhattan 40
  check('travel over the threshold was not graded as a click',
    await page.evaluate(() => window.__NESTCHECK__.results().length), n6);

  /* --- 7. The paint-mode guard. Nest-specific, and the reason this port
         exists: app-core's pointerdown is bound first, so without the
         nsoMaskTakesClick stand-down a paint click also starts a move drag and
         endMoveDrag paints "Moved model #N" over the paint's own status. */
  console.log('\n--- gesture 7: paint mode, click a piece (app-core must stand down) ---');
  await reset();
  check('paint mode is live', await page.evaluate(() => window.__NESTCHECK__.paintOn()), true);
  const before7 = await page.evaluate(() => ({ xz: window.__NESTCHECK__.xz(), mask: window.__NESTCHECK__.maskCount() }));
  await gesture();
  const g7 = await page.evaluate(() => ({
    status: window.__NESTCHECK__.status(), xz: window.__NESTCHECK__.xz(), mask: window.__NESTCHECK__.maskCount(),
  }));
  check('the face was painted', g7.mask, before7.mask + 1);
  check('the piece did not move', g7.xz, before7.xz);
  check('the status is NOT "Moved model #N"', /Moved model/.test(g7.status), false);
  check('the status is the paint line', /face\(s\) excluded/.test(g7.status), true);
  await page.evaluate(() => window.__NESTCHECK__.paintOff());

  // --- 8. With paint off the host gets its input back, so the guard is narrow.
  console.log('\n--- gesture 8: paint off again (the guard must not be sticky) ---');
  await reset();
  await gesture();
  check('host reported a move once paint was off', /^Moved model #\d+$/.test(
    await page.evaluate(() => window.__NESTCHECK__.status())), true);

  check('no uncaught page errors', errors, []);

  await browser.close();
  if (served) served.srv.close();

  if (check.report()) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
