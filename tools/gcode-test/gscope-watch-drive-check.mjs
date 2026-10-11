#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-watch-drive-check.mjs
 *
 * The live watch (nso-watch.js) across the G-scope boundary, driven through
 * the real app in headless Chromium with real clicks.
 *
 * G-scope (#microscope) is a full-screen sheet at z-index 2000 over the whole
 * app. The watch panel used to stay behind in .viewport-section, UNDER it:
 * armed on main, the panel vanished the instant G-scope opened, in Normal and
 * in Slice view alike (driver round, 2026-09-28). Now, while watching, the
 * panel and the report follow into G-scope's viewport and back.
 *
 *   1  ARMED ON MAIN, CARRIED ACROSS. Arm with the eye button, enter G-scope
 *      with its rail button: on the very next frame the panel is in G-scope's
 *      viewport, on top (a hit test at the panel lands on the panel), still
 *      on, the SAME run - no second "watch on", no re-arm, the same counts.
 *   2  NORMAL VIEW. Legend rows hidden and shown again, a real click on a
 *      piece in G-scope's own 3D view - in orbit, as G-scope opens, it drops
 *      nothing; with Click to select region armed, a capture box drops -
 *      Normal re-frame.
 *      The panel stays visible throughout; it keeps its collapse state.
 *   3  SLICE VIEW. Slice view, its All features rows, Normal back to the
 *      mesh, Slice again - the panel is on top in each. The slice's own
 *      status line lands in the log as a row, in this run.
 *   4  THE COUNTS ARE LIVE INSIDE G-SCOPE. A real pose mismatch made while
 *      G-scope is up is caught by the check a G-scope click schedules, and an
 *      uncaught error thrown while it is up is counted: both pills move,
 *      inside G-scope, and both events are stamped inside the G-scope window.
 *      The Report view opens on top inside G-scope too.
 *   5  BACK ON MAIN. Close: the panel is back in the main viewport, on top,
 *      with the counts from the G-scope portion - not only what was there
 *      before entering. Round trip again: still one run.
 *   6  LEFT OFF, STAYS OFF. A fresh page with the watch never armed: entering
 *      G-scope does not start it, show it, move it or patch anything, in
 *      Normal or Slice view, and closing leaves it off. No run is recorded.
 *
 * SOAK_MS=120000 node tools/gcode-test/gscope-watch-drive-check.mjs
 *   repeats part 2 / 3's interactions for that long inside G-scope before
 *   part 4 - the "couple of minutes" drive. The suite runs it without.
 *
 * Usage: node tools/gcode-test/gscope-watch-drive-check.mjs   (npm run gcode:gscope-watch)
 */
import { chromium } from 'playwright';
import { serveRoot, routeCdn, mkCheck, launchOpts } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const SOAK_MS = Number(process.env.SOAK_MS || 0);
const PROBE = 'gscope-watch probe: thrown while G-scope is up';

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return o;
}
function stl(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return Array.from(b);
}
/* A 4 mm stem under a 14 mm cap (one overhang), and a plain block. */
const MUSHROOM = stl([...box([-2, -2, 0], [2, 2, 5]), ...box([-7, -7, 5], [7, 7, 7])]);
const PLAIN = stl(box([0, 0, 0], [10, 8, 6]));

async function frames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
async function sliced(page) {
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return !window.NSO_GSCOPE_SLICE.busy() && d && d.kind === 'toolpath' && !!d.nsoSlice;
  }, null, { timeout: 120000 });
}
async function meshBack(page) {
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 30000 });
}

/** Where the panel is, whether it is really on screen, and what it says. */
function panel(page) {
  return page.evaluate(() => {
    const p = document.getElementById('nso-watch-panel');
    const W = window.NSOWatch;
    if (!p) return { exists: false, on: W.isOn() };
    const r = p.getBoundingClientRect();
    const shown = getComputedStyle(p).display !== 'none' && r.width > 0 && r.height > 0;
    // On top means a hit test on the panel's header lands on the panel - not
    // on the G-scope sheet that used to cover it.
    const hit = shown ? document.elementFromPoint(r.left + 12, r.top + 10) : null;
    const inView = r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    return {
      exists: true, on: W.isOn(), where: W.where(),
      parent: p.parentNode.id || p.parentNode.className,
      shown, onTop: !!hit && p.contains(hit), inView,
      pills: [document.getElementById('nso-watch-n-phantom').textContent,
              document.getElementById('nso-watch-n-error').textContent],
      rows: p.querySelectorAll('.nso-watch-row').length,
      collapsed: W.isCollapsed()
    };
  });
}
const lastSeq = (page) => page.evaluate(() => { const e = NSOWatch.events(); return e.length ? e[e.length - 1].seq : 0; });
const runs = (page) => page.evaluate(() => NSOWatch.stored().runs.map((r) => r.id));
const eventsBetween = (page, lo, hi) => page.evaluate(([a, b]) =>
  NSOWatch.events().filter((e) => e.seq > a && (b == null || e.seq <= b)), [lo, hi]);

/** A real click on a piece in G-scope's own 3D view. */
async function clickPiece(page, which) {
  const at = await page.evaluate((w) => {
    const v = window.NSO_MICROSCOPE.getView();
    const key = Object.keys(v.overviewMeshes).find((k) => k.includes(w)) || Object.keys(v.overviewMeshes)[0];
    const m = v.overviewMeshes[key];
    const b = new THREE.Box3().setFromObject(m);
    const c = new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  }, which);
  await page.mouse.click(at.x, at.y);
  await frames(page);
}

/** One pass of ordinary G-scope use, in whichever view is up. */
async function exerciseNormal(page) {
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map((e) => e.dataset.group));
  for (const g of groups) await page.click(`#ms-legend [data-group="${g}"]`);       // hide each
  for (const g of groups) await page.click(`#ms-legend [data-group="${g}"]`);       // and back
  await page.click('#ms-mode-select');
  await clickPiece(page, 'mushroom');
  await page.click('#ms-btn-clear');
  await page.click('#ms-cam-normal');
  await frames(page);
}
async function exerciseSlice(page) {
  await page.click('#ms-cam-slice');
  await sliced(page);
  await frames(page);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map((e) => e.dataset.group));
  for (const g of rows.slice(0, 3)) await page.click(`#ms-legend [data-group="${g}"]`);   // off
  for (const g of rows.slice(0, 3)) await page.click(`#ms-legend [data-group="${g}"]`);   // and on
  await frames(page);
  return rows;
}

async function openApp(browser, served) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => { if (!String(e).includes(PROBE)) errors.push(String(e)); });
  page.on('console', (m) => {
    // The watcher echoes what it logs to the console; the probe's own echo is expected.
    if (m.type() === 'error' && !m.text().includes(PROBE) && !/^\[watch2 /.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SLICE && !!window.NSOWatch, null, { timeout: 30000 });
  await page.evaluate(([a, b]) => handleFiles([new File([new Uint8Array(a)], 'mushroom.stl'),
    new File([new Uint8Array(b)], 'plain.stl')]), [MUSHROOM, PLAIN]);
  await page.waitForFunction(() => state.models.length === 2 && state.placed.length === 2, null, { timeout: 30000 });
  return { page, errors };
}

async function main() {
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());

  // =======================================================================
  console.log('\n--- 1. armed on main, carried across into G-scope ---');
  // =======================================================================
  const { page, errors } = await openApp(browser, served);
  await page.evaluate(() => { localStorage.removeItem('nso.watch.store'); localStorage.removeItem('nso.watch.collapsed'); });
  await page.click('#btn-watch');
  const main0 = await panel(page);
  check('armed on main with the eye button: on, in the main viewport, on top',
    [main0.on, main0.where, main0.parent, main0.shown, main0.onTop], [true, 'main', 'viewport-section', true, true]);
  const run0 = await runs(page);
  const watchOn0 = (await eventsBetween(page, 0)).filter((e) => e.kind === 'watch').length;

  const enterSeq = await lastSeq(page);
  await page.click('#btn-microscope');
  await frames(page);
  const in0 = await panel(page);
  check('entering G-scope: still on, and the panel is in G-scope\'s viewport on the first frame',
    [in0.on, in0.where, in0.parent], [true, 'gscope', 'ms-viewport']);
  check('... visible, on top of the G-scope sheet, inside the window',
    [in0.shown, in0.onTop, in0.inView], [true, true, true]);
  check('... the same run: no re-arm, no second "watch on", the same pills and rows',
    [await runs(page), (await eventsBetween(page, 0)).filter((e) => e.kind === 'watch').length, in0.pills, in0.rows >= main0.rows],
    [run0, watchOn0, main0.pills, true]);
  check('... and G-scope really is open, on the plate, in Normal',
    await page.evaluate(() => [window.NSO_MICROSCOPE.isOpen(), window.NSO_MICROSCOPE.getDoc().source, window.NSO_GSCOPE_SLICE.viewMode()]),
    [true, 'plate', 'normal']);
  check('the eye button itself stays under the sheet (the panel follows; the toggle does not)',
    await page.evaluate(() => {
      const b = document.getElementById('btn-watch').getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!hit && document.getElementById('microscope').contains(hit);
    }), true);

  // =======================================================================
  console.log('\n--- 2. Normal view: legend rows, a piece clicked, re-frame ---');
  // =======================================================================
  await page.click('#nso-watch-collapse');
  check('the collapse button works inside G-scope', (await panel(page)).collapsed, true);
  await page.click('#nso-watch-collapse');
  const boxes0 = await page.evaluate(() => window.NSO_MICROSCOPE.boxes().length);
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map((e) => e.dataset.group));
  await page.click(`#ms-legend [data-group="${groups[0]}"]`);
  check('a legend row hides its part', await page.evaluate(() => window.NSO_MICROSCOPE.hidden()), [groups[0]]);
  await page.click(`#ms-legend [data-group="${groups[0]}"]`);
  check('... and shows it again', await page.evaluate(() => window.NSO_MICROSCOPE.hidden()), []);
  // G-scope opens in orbit: a plain click on a piece, nothing armed, is a
  // look and nothing else. A box is something you ask for.
  check('G-scope opened in orbit, nothing armed', await page.evaluate(() => [window.NSO_MICROSCOPE.mode(),
    document.getElementById('ms-mode-orbit').classList.contains('active'),
    document.getElementById('ms-mode-select').classList.contains('active')]), ['orbit', true, false]);
  await clickPiece(page, 'mushroom');
  check('a real click on a piece with nothing armed drops no box, selects nothing',
    await page.evaluate(() => [window.NSO_MICROSCOPE.boxes().length, window.NSO_MICROSCOPE.selection().length]), [boxes0, 0]);
  await page.click('#ms-mode-select');
  await clickPiece(page, 'mushroom');
  check('Click to select region, then a real click on the piece: a capture box drops, as before',
    await page.evaluate(() => window.NSO_MICROSCOPE.boxes().length), boxes0 + 1);
  check('... and catches the piece', await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((o) => o.name)),
    [await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().objects.find((o) => /mushroom/.test(o.name)).name)]);
  await page.click('#ms-btn-clear');
  await page.click('#ms-cam-normal');
  await frames(page);
  const n2 = await panel(page);
  check('through all of Normal view the panel stays in G-scope, on top, on',
    [n2.on, n2.where, n2.shown, n2.onTop], [true, 'gscope', true, true]);

  // =======================================================================
  console.log('\n--- 3. Slice view, Normal back, Slice again ---');
  // =======================================================================
  const det = await exerciseSlice(page);
  check('Slice view is up, with its All features rows',
    [await page.evaluate(() => window.NSO_GSCOPE_SLICE.viewMode()), det.some((d) => /wall/i.test(d))], ['slice', true]);
  const s3 = await panel(page);
  check('in Slice view the panel is in G-scope, on top, on',
    [s3.on, s3.where, s3.shown, s3.onTop], [true, 'gscope', true, true]);
  const sliceLine = (await eventsBetween(page, enterSeq)).find((e) => e.kind === 'status' && /^Sliced /.test(e.msg));
  check('the slice\'s own status line is logged, in this run, after entering', !!sliceLine, true);
  check('... and drawn as a row in the panel',
    await page.evaluate(() => Array.from(document.querySelectorAll('#nso-watch-list .nso-watch-row span'))
      .some((s) => /^Sliced /.test(s.textContent))), true);
  await page.click('#ms-cam-normal');
  await meshBack(page);
  await frames(page);
  const b3 = await panel(page);
  check('Normal from the slice: back on the mesh, the panel still in G-scope and on top',
    [await page.evaluate(() => window.NSO_GSCOPE_SLICE.viewMode()), b3.where, b3.shown, b3.onTop], ['normal', 'gscope', true, true]);
  await exerciseSlice(page);
  check('Slice again: the panel is still on top', [(await panel(page)).where, (await panel(page)).onTop], ['gscope', true]);

  if (SOAK_MS > 0) {
    console.log(`    soak: ${Math.round(SOAK_MS / 1000)} s of Normal / Slice use inside G-scope`);
    const t0 = Date.now();
    let passes = 0, lost = 0;
    while (Date.now() - t0 < SOAK_MS) {
      await page.click('#ms-cam-normal'); await meshBack(page);
      await exerciseNormal(page);
      if (!(await panel(page)).onTop) lost++;
      await exerciseSlice(page);
      if (!(await panel(page)).onTop) lost++;
      passes++;
    }
    const soak = await panel(page);
    console.log(`    soak: ${passes} Normal + Slice passes, pills ${soak.pills.join(' / ')}, ${soak.rows} rows`);
    check('soak: the panel never left the screen', lost, 0);
  }

  // =======================================================================
  console.log('\n--- 4. the counts are live inside G-scope ---');
  // =======================================================================
  const before4 = await panel(page);
  const seq4 = await lastSeq(page);
  // A real plate mismatch, made while G-scope is up: a piece's mesh turned
  // off its logical pose - a quarter turn, which leaves the square cap's
  // footprint as it was, so it is a pose mismatch and nothing else. The
  // watcher is not asked to check: the check is the one a click on a G-scope
  // control schedules, as on the main view.
  await page.evaluate(() => { state.placed[0].mesh.rotation.y += Math.PI / 2; });
  await page.click('#ms-cam-normal');
  await meshBack(page);
  await page.waitForFunction(() => /^1 phantom$/.test(document.getElementById('nso-watch-n-phantom').textContent), null, { timeout: 5000 });
  // An uncaught error, thrown while G-scope is up.
  await page.evaluate((m) => { setTimeout(() => { throw new Error(m); }, 0); }, PROBE);
  await page.waitForFunction(() => /^1 error$/.test(document.getElementById('nso-watch-n-error').textContent), null, { timeout: 5000 });
  const c4 = await panel(page);
  check('before: 0 phantom / 0 error', before4.pills, ['0 phantom', '0 error']);
  check('a pose mismatch made inside G-scope moves the phantom pill, inside G-scope', [c4.pills[0], c4.where, c4.onTop], ['1 phantom', 'gscope', true]);
  check('an error thrown inside G-scope moves the error pill', c4.pills[1], '1 error');
  const ev4 = await eventsBetween(page, seq4);
  const ph = ev4.find((e) => e.kind === 'phantom');
  check('the phantom names the pose and the G-scope click it followed',
    [!!ph && /^phantom pose - placed\[0\]/.test(ph.msg), !!ph && ph.trail.some((t) => /click ms-cam-normal/.test(t))], [true, true]);
  check('the error is the one thrown', ev4.some((e) => e.kind === 'error' && e.msg.includes(PROBE)), true);
  await page.evaluate(() => { state.placed[0].mesh.rotation.y -= Math.PI / 2; });
  await page.click('#ms-cam-normal');
  await page.waitForFunction(() => NSOWatch.open().length === 0, null, { timeout: 5000 });
  check('put back, it clears (logged, and the count of what was seen stays)',
    [(await eventsBetween(page, seq4)).some((e) => e.kind === 'cleared'), (await panel(page)).pills], [true, ['1 phantom', '1 error']]);
  await page.click('#nso-watch-report-btn');
  const rep = await page.evaluate(() => {
    const r = document.getElementById('nso-watch-report'), b = r.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 20);
    return [r.parentNode.id, getComputedStyle(r).display, !!hit && r.contains(hit),
      /gscope-watch probe/.test(r.textContent)];
  });
  check('Report opens inside G-scope, on top, with the G-scope portion in it', rep, ['ms-viewport', 'flex', true, true]);
  await page.click('#nso-wr-close');

  // =======================================================================
  console.log('\n--- 5. back on main ---');
  // =======================================================================
  const exitSeq = await lastSeq(page);
  await page.click('#ms-close');
  await frames(page);
  const out5 = await panel(page);
  check('Close: G-scope is gone, the panel is back in the main viewport, on top, on',
    [await page.evaluate(() => window.NSO_MICROSCOPE.isOpen()), out5.on, out5.where, out5.parent, out5.shown, out5.onTop],
    [false, true, 'main', 'viewport-section', true, true]);
  check('the main view\'s pills show the G-scope portion', out5.pills, ['1 phantom', '1 error']);
  const inside = await eventsBetween(page, enterSeq, exitSeq);
  check('... every one of those counted events happened between entering and leaving G-scope',
    [inside.filter((e) => e.kind === 'phantom').length, inside.filter((e) => e.kind === 'error').length], [1, 1]);
  check('... and nothing was counted before entering',
    (await eventsBetween(page, 0, enterSeq)).filter((e) => e.kind === 'phantom' || e.kind === 'error').length, 0);
  check('Report on main is back on the main view', await page.evaluate(() => { NSOWatch.showReport(); const p = document.getElementById('nso-watch-report').parentNode; NSOWatch.hideReport(); return p.className; }), 'viewport-section');
  await page.click('#btn-microscope');
  await frames(page);
  const again = await panel(page);
  await page.click('#ms-close');
  await frames(page);
  check('a second round trip: in G-scope on the way in, main on the way out, still one run',
    [again.where, again.onTop, (await panel(page)).where, await runs(page)], ['gscope', true, 'main', run0]);
  // Stopped from inside G-scope (the console; the eye button is under the
  // sheet) and re-armed on main: the panel comes back where it belongs.
  await page.click('#btn-microscope');
  await page.evaluate(() => NSOWatch.stop());
  const stopped = await panel(page);
  await page.click('#ms-close');
  await page.click('#btn-watch');
  const rearmed = await panel(page);
  check('stopped inside G-scope, the panel goes; re-armed on main, it is in the main viewport on top',
    [stopped.on, stopped.shown, rearmed.on, rearmed.where, rearmed.onTop], [false, false, true, 'main', true]);
  await page.click('#btn-watch');
  check('no page errors', errors, []);
  await page.close();

  // =======================================================================
  console.log('\n--- 6. left off, stays off ---');
  // =======================================================================
  const off = await openApp(browser, served);
  const p6 = off.page;
  await p6.evaluate(() => { localStorage.removeItem('nso.watch'); localStorage.removeItem('nso.watch.store'); });
  await p6.reload({ waitUntil: 'load' });
  await p6.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await p6.evaluate(([a, b]) => handleFiles([new File([new Uint8Array(a)], 'mushroom.stl'),
    new File([new Uint8Array(b)], 'plain.stl')]), [MUSHROOM, PLAIN]);
  await p6.waitForFunction(() => state.models.length === 2 && state.placed.length === 2, null, { timeout: 30000 });
  const patched = () => p6.evaluate(() => [!!window.setStatus.__nsoWatchWrapped, !!window.pushUndo.__nsoWatchWrapped,
    !!Object.getOwnPropertyDescriptor(state, 'selectedIndex').get]);
  const off0 = await panel(p6);
  check('never armed: off, the panel hidden in the main viewport, nothing patched',
    [off0.on, off0.shown, off0.where, await patched()], [false, false, 'main', [false, false, false]]);
  await p6.click('#btn-microscope');
  await frames(p6);
  const off1 = await panel(p6);
  check('entering G-scope does not start it, show it or move it',
    [off1.on, off1.shown, off1.where, off1.parent], [false, false, 'main', 'viewport-section']);
  check('... and patches nothing', await patched(), [false, false, false]);
  await exerciseNormal(p6);
  await exerciseSlice(p6);
  await p6.click('#ms-cam-normal');
  await meshBack(p6);
  const off2 = await panel(p6);
  check('through Normal and Slice view it stays off and hidden',
    [off2.on, off2.shown, off2.where, await patched()], [false, false, 'main', [false, false, false]]);
  await p6.click('#ms-close');
  const off3 = await panel(p6);
  check('closing G-scope: still off; no run was recorded and no event kept',
    [off3.on, off3.shown, await p6.evaluate(() => [localStorage.getItem('nso.watch'), NSOWatch.stored().runs.length, NSOWatch.events().length])],
    [false, false, [null, 0, 0]]);
  check('no page errors', off.errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
