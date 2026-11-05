#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_paint_drive_check.mjs   (npm run support:paint-drive)
 *
 * The Supports card's BRUSH and RAFT switch (docs/SUPPORTS-CARD.md "The brush and the raft", docs/SUPPORT-FOOTPRINT.md section 10), driven in headless
 * Chromium with real pointer events on the page: the card's Paint row is there in Auto, the brush holds the pointer while it is on, a drag over the
 * piece paints one stroke (one Undo step, spots asked for, dots drawn), a drag off the piece orbits as ever, Escape puts the brush down, Clear paint
 * takes it all off, and a build with the paint ends BUILT. The geometry of what a stroke builds is support:paint's; this is the pointer's path.
 */
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'supports-out');
const SHOTS_ON = process.argv.includes('--shots') || !process.env.CI;
const W = 1280, H = 800;
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  routeCdn(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
  const bytes = await readFile(join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  await page.evaluate((a) => handleFiles([new File([new Uint8Array(a)], 'supp_ref.3mf')]), [...bytes]);
  await page.waitForFunction(() => state.models.length >= 6 && state.placed.length >= 6, null, { timeout: 60000 });
  const hostId = await page.evaluate(() => state.models.find((m) => /Negative Sphere(\.stl)?$/.test(m.name)).id);

  console.log('\n--- 1. the card: the raft switch and the Paint row, in Auto ---');
  await page.click('#menu-supports > summary');
  await page.evaluate((id) => window.NSO_SUPPORTS_CARD.pick(id), hostId);
  await page.waitForFunction(() => /hanging area/.test(window.NSO_SUPPORTS_CARD.view().count), null, { timeout: 60000 });
  const ui = () => page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const shown = (e) => !!e && !e.hidden && e.getBoundingClientRect().width > 0;
    return { raft: $('sup-raft') && $('sup-raft').checked, row: shown($('sup-paint-row')), paintOn: !$('sup-paint').disabled, pressed: $('sup-paint').getAttribute('aria-pressed'),
      clearOn: !$('sup-paint-clear').disabled, brush: $('sup-brush').value, hint: $('sup-hint') && $('sup-hint').textContent, count: window.NSO_SUPPORTS_CARD.paintCount(),
      undo: state.undoStack.length, spots: window.NSO_SUPPORTS_CARD.view().beacons.length, cursor: state.renderer.domElement.style.cursor };
  });
  let u = await ui();
  check('the Raft interface box is there, on', u.raft, true);
  check('the Paint row shows in Auto, Paint on offer, Clear paint off (nothing painted)', [u.row, u.paintOn, u.clearOn, u.pressed], [true, true, false, 'false']);
  check('the brush is 4 mm', u.brush, '4');

  console.log('\n--- 2. the brush on: a drag over the piece paints one stroke ---');
  const spots0 = u.spots, undo0 = u.undo;
  await page.click('#sup-paint');
  u = await ui();
  check('Paint is pressed, the hint says so, the cursor is a crosshair', [u.pressed, /^Painting/.test(u.hint), u.cursor], ['true', true, 'crosshair']);
  /* a run of the piece along one screen row where the ray, through the piece if need be, meets a face the card calls hanging (normal below -cos 35 deg): the brush paints
     the underside the outline shows through the piece, from above */
  const findRun = () => page.evaluate((id) => {
    const p = state.placed.find((q) => q.sourceId === id), cv = state.renderer.domElement, r = cv.getBoundingClientRect();
    const hits = [];
    for (let y = 0.05; y < 0.95; y += 0.012) for (let x = 0.05; x < 0.95; x += 0.012) {
      state.pointer.set(x * 2 - 1, -(y * 2 - 1));
      state.raycaster.setFromCamera(state.pointer, state.camera);
      const mats = [].concat(p.mesh.material), was = mats.map((m) => m.side);
      mats.forEach((m) => { m.side = THREE.DoubleSide; });
      const all = state.raycaster.intersectObject(p.mesh, false);
      mats.forEach((m, k) => { m.side = was[k]; });
      const h = all.find((q) => q.face && q.face.normal.clone().transformDirection(p.mesh.matrixWorld).y <= -0.83);      // the view's y is Z up
      if (h) hits.push({ cx: r.left + x * r.width, cy: r.top + y * r.height });
    }
    if (hits.length < 4) return null;
    const byRow = {};
    hits.forEach((h) => { (byRow[h.cy.toFixed(0)] = byRow[h.cy.toFixed(0)] || []).push(h); });
    const best = Object.values(byRow).sort((a, b) => b.length - a.length)[0].sort((a, b) => a.cx - b.cx);
    return { a: best[0], b: best[best.length - 1], n: best.length };
  }, hostId);
  const drag = await findRun();
  check('a run of the piece\'s side is in view to paint on', !!drag && drag.n >= 2, true);
  if (drag) {
    await page.mouse.move(drag.a.cx, drag.a.cy);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(drag.a.cx + (drag.b.cx - drag.a.cx) * k / 12, drag.a.cy + (drag.b.cy - drag.a.cy) * k / 12);
    await frames(page);
    const during = await page.evaluate(() => !!state.scene.getObjectByName('supportsCardPaint'));
    await page.mouse.up();
    await frames(page);
    u = await ui();
    check('while the button was down the stroke was drawn (translucent dots over the piece)', during, true);
    check('one stroke, one Undo step, and it asked for spots', [u.count, u.undo - undo0, u.spots > spots0], [1, 1, true]);
    check('Clear paint is on now; the dots stay when the button is up', [u.clearOn, await page.evaluate(() => !!state.scene.getObjectByName('supportsCardPaint'))], [true, true]);
    check('the brush stays armed after the stroke (pressed, the hint still says painting)', [u.pressed, /^Painting/.test(u.hint)], ['true', true]);
    if (SHOTS_ON) { await page.screenshot({ path: join(SHOTS, 'paint-stroke.png') }); console.log('       paint-stroke.png'); }
  }

  console.log('\n--- 3. off the piece the view orbits; Escape puts the brush down ---');
  const cam0 = await page.evaluate(() => state.camera.position.toArray().map((v) => +v.toFixed(3)));
  await page.mouse.move(900, 700);
  await page.mouse.down();
  await page.mouse.move(1010, 720, { steps: 6 });
  await page.mouse.up();
  await frames(page);
  const cam1 = await page.evaluate(() => state.camera.position.toArray().map((v) => +v.toFixed(3)));
  u = await ui();
  check('a drag that starts off the piece paints nothing and the view orbits', [u.count, JSON.stringify(cam1) !== JSON.stringify(cam0)], [drag ? 1 : 0, true]);
  check('...and after the orbit the brush is still armed', [u.pressed, /^Painting/.test(u.hint)], ['true', true]);
  const drag2 = await findRun();
  if (drag2) {
    await page.mouse.move(drag2.a.cx, drag2.a.cy);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(drag2.a.cx + (drag2.b.cx - drag2.a.cx) * k / 12, drag2.a.cy + (drag2.b.cy - drag2.a.cy) * k / 12);
    await page.mouse.up();
    await frames(page);
    u = await ui();
  }
  check('...and a second drag over the piece, found again after the orbit, paints a second stroke', [!!drag2, u.count], [true, 2]);
  const drag3 = await findRun();
  if (drag3) {
    const n0 = u.count;
    await page.keyboard.down('Alt');
    await page.mouse.move(drag3.a.cx, drag3.a.cy);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(drag3.a.cx + (drag3.b.cx - drag3.a.cx) * k / 8, drag3.a.cy + (drag3.b.cy - drag3.a.cy) * k / 8);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await frames(page);
    u = await ui();
    check('Alt held, a drag over the piece is the view\'s: no stroke, and the brush stays armed', [u.count, u.pressed], [n0, 'true']);
  }
  await page.keyboard.press('Escape');
  u = await ui();
  check('Escape puts the brush down (not pressed, the hint is the card\'s again)', [u.pressed, /^Painting/.test(u.hint || '')], ['false', false]);

  console.log('\n--- 4. a build with the paint, then Undo and Clear ---');
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
  const line = await page.evaluate(() => document.getElementById('sup-count').textContent);
  check('GENERATE with the paint ends BUILT', /^Built: \d+ support/.test(line), true);
  console.log('       ' + line);
  const before = await ui();
  await page.click('#sup-paint-clear');
  u = await ui();
  check('Clear paint takes every stroke off, one Undo step', [u.count, u.undo - before.undo], [0, 1]);
  await page.evaluate(() => document.getElementById('btn-undo') && document.getElementById('btn-undo').click());
  await frames(page);
  u = await ui();
  check('...and Undo puts the paint back', u.count, before.count);

  check('no page errors', errors, []);
  await browser.close();
  served.srv.close();
  return check.report();
}
main().then((failed) => process.exit(failed ? 1 : 0), (e) => { console.error(e); process.exit(2); });
