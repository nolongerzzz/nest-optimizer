#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / entry-drive-check.mjs
 *
 * The G-code microscope's ENTRY POINT, driven through the real app.
 *
 * toolpath-drive-check.mjs proves the pipeline by calling `handleFiles()`
 * directly. That is the right shape for testing the importer, and it is
 * exactly why the feature could be finished, green and unreachable at the same
 * time: the check never touched a control a user can see. Before this change
 * the only way in was to know that dropping a `*.gcode.3mf` on the Library
 * file box does something different from dropping a model, with the Toolpath
 * card `hidden` until that had already worked.
 *
 * So this check starts where a user starts - at a button - and never calls
 * `handleFiles()`, `importSliced3MF()` or anything else in page script to get
 * the file in. It clicks `#btn-gcode`, answers the file chooser Chromium
 * really opens, and then drives the whole advertised flow through the DOM:
 * toolpath renders, Z filter isolates one layer, Extract pulls that layer out,
 * Undo takes it back.
 *
 * Both files it reads are real Bambu Studio slices, not generated fixtures.
 *
 * Usage:
 *   node tools/gcode-test/entry-drive-check.mjs
 *   CHROME_PATH=/path/to/chrome node tools/gcode-test/entry-drive-check.mjs
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();

/* A real slice, small enough to drive every step of the UI on. */
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
/* A real slice at real scale - 202,877 moves - for the import and the filter. */
const BIG = 'fixtures/3mf/tabletop.gcode.3mf';
/* Not a slice. Proves the button says so rather than importing it as geometry. */
const PLAIN = 'fixtures/3mf/pa_pattern.3mf';

/** Click the button and answer the file chooser Chromium opens. */
async function pickThroughButton(page, relPath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.click('#btn-gcode'),
  ]);
  await chooser.setFiles(join(ROOT, relPath));
  return chooser;
}

async function main() {
  const served = await serveRoot();
  const base = served.base;
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const cdn = routeCdn(page);
  const errors = [];
  const status = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\nNest at ${base}/index.html`);
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__status = [];
    const real = window.setStatus;
    window.setStatus = function (msg, isErr) { window.__status.push(String(msg)); return real.apply(this, arguments); };
  });

  // -----------------------------------------------------------------------
  console.log('\n--- the button is on screen, directly below X-ray ---');
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('the G-code button exists and is visible', await page.isVisible('#btn-gcode'), true);
  check('it reads "G" and a microscope',
    (await page.textContent('#btn-gcode')).trim(), 'G\u{1F52C}');
  check('it wears the same rail class as the other viewport tools',
    await page.evaluate(() => document.getElementById('btn-gcode').classList.contains('viewport-tool-btn')), true);
  check('it says what it does on hover',
    /sliced|\.gcode\.3mf/i.test(await page.getAttribute('#btn-gcode', 'title')), true);

  const rail = await page.evaluate(() => {
    const ids = ['btn-undo', 'btn-frame-view', 'btn-xray', 'btn-gcode', 'btn-watch'];
    const box = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { id, x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) };
    };
    const all = ids.map(box);
    // Everything the rail renders, top to bottom, whatever the DOM order.
    const drawn = Array.from(document.querySelectorAll('.viewport-overlay-bl .viewport-tool-btn'))
      .map((el) => ({ id: el.id, y: el.getBoundingClientRect().top }))
      .sort((a, b) => a.y - b.y)
      .map((e) => e.id);
    return { all, drawn };
  });
  const xray = rail.all.find((b) => b.id === 'btn-xray');
  const gbtn = rail.all.find((b) => b.id === 'btn-gcode');
  check('the rail renders top-to-bottom with G directly under X-ray',
    rail.drawn, ['btn-undo', 'btn-frame-view', 'btn-xray', 'btn-gcode', 'btn-watch']);
  check('same left edge as X-ray - one column, not a second one',
    gbtn.x, xray.x);
  check('below X-ray, by the rail\'s own 8px gap and nothing more',
    gbtn.y - (xray.y + xray.h), 8);
  check('same 44px square as every other tool button',
    [gbtn.w, gbtn.h], [44, 44]);
  check('both glyphs fit inside the button - nothing spills out',
    await page.evaluate(() => {
      const el = document.getElementById('btn-gcode');
      return el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1;
    }), true);

  // -----------------------------------------------------------------------
  console.log('\n--- before the click ---');
  check('the toolpath card starts hidden', await page.isVisible('#toolpath-card'), false);
  check('the button starts unlit',
    await page.evaluate(() => document.getElementById('btn-gcode').classList.contains('is-on')), false);
  check('there is no session yet',
    await page.evaluate(() => window.NSO_TOOLPATH.getSession()), null);

  // Something already on the plate, so "left alone" has teeth later on.
  const stl = Array.from(await readFile(join(ROOT, 'library/box_closed.stl')));
  await page.evaluate(([b]) => handleFiles([new File([new Uint8Array(b)], 'box_closed.stl')]), [stl]);
  await page.waitForFunction('state.models.length === 1', null, { timeout: 20000 });
  const plateBefore = await page.evaluate(() => ({
    models: state.models.length, placed: state.placed.length, undo: state.undoStack.length
  }));

  // -----------------------------------------------------------------------
  console.log('\n--- click it: a real file chooser, answered with a real slice ---');
  await pickThroughButton(page, SLICE);
  await page.waitForFunction('window.NSO_TOOLPATH.getSession() !== null', null, { timeout: 30000 });

  const opened = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    return {
      file: s.file,
      moves: s.moves.length,
      layers: s.layers.length,
      features: s.result.groups.length,
      assumed: s.result.parsed.meta.assumed,
      models: state.models.length,
      zup: state.models.filter((m) => m.rawAxis === 'zup' && m.rawTris.length > 0).length,
      lit: document.getElementById('btn-gcode').classList.contains('is-on'),
      focused: document.activeElement ? document.activeElement.id : null
    };
  });
  check('the file the chooser was given is the file that opened',
    opened.file, 'supportwithinsupport.gcode.3mf');
  check('the toolpath is on screen - 50 layers of 2895 moves',
    [opened.layers, opened.moves], [50, 2895]);
  check('one model per feature group, ten of them, added to the box already there',
    [opened.features, opened.models], [10, plateBefore.models + 10]);
  check('every one came in through the normal ingest path',
    opened.zup, opened.models);
  check('nothing was assumed - every number came out of the file', opened.assumed, false);
  check('the Toolpath card opened', await page.isVisible('#toolpath-card'), true);
  check('and took the keyboard, so the arrow keys scrub at once',
    opened.focused, 'toolpath-card');
  check('the rail button is lit while the microscope is open', opened.lit, true);

  // -----------------------------------------------------------------------
  console.log('\n--- scrub, through the card the button opened ---');
  await page.click('#btn-tp-next');
  await page.click('#btn-tp-next');
  const scrub = await page.evaluate(() => ({
    cursor: window.NSO_TOOLPATH.getSession().cursor,
    readout: document.getElementById('tp-readout').textContent,
    detail: document.getElementById('tp-detail').textContent
  }));
  check('+1 line twice moves the cursor exactly two moves', scrub.cursor, 2);
  check('the readout counts lines and layers', /Line 3 \/ 2895/.test(scrub.readout), true);
  check('the detail names a real measured bead',
    /mm wide x .* mm tall/.test(scrub.detail), true);

  await page.click('#btn-tp-layer-up');
  const layerUp = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    return { layer: s.moves[s.cursor].layer, z: s.moves[s.cursor].z };
  });
  check('the layer step lands on the next layer up', layerUp.layer, 1);

  // -----------------------------------------------------------------------
  console.log('\n--- Isolate Z, through the checkbox ---');
  // Park on a feature that really spans several layers, or "one layer" proves
  // nothing - a single-layer feature is already isolated.
  const spread = await page.evaluate(() => {
    const T = window.NSO_TOOLPATH, s = T.getSession(), by = {};
    s.moves.forEach((m) => { (by[m.feature] = by[m.feature] || new Set()).add(m.z.toFixed(6)); });
    const name = Object.keys(by).find((k) => by[k].size > 1);
    T.setCursor(s.moves.findIndex((m) => m.feature === name));
    return { name, layers: by[name].size, all: s.moves.filter((m) => m.feature === name).length };
  });
  check('parked on a feature that spans several layers', spread.layers > 1, true);
  console.log(`       ${spread.name}: ${spread.all} moves over ${spread.layers} layers`);

  await page.check('#tp-zfilter');
  const iso = await page.evaluate(() => {
    const T = window.NSO_TOOLPATH, s = T.getSession();
    const inWin = T.movesInWindow();
    const mv = s.moves[s.cursor];
    return {
      on: s.zFilter.on,
      layersInWin: T.layersInWindow(),
      importedVisible: s.modelIds.filter((id) => {
        const e = state.placed.find((p) => p.sourceId === id);
        return e && e.mesh && e.mesh.visible !== false;
      }).length,
      otherVisible: state.placed.filter((p) => s.modelIds.indexOf(p.sourceId) === -1 &&
        p.mesh && p.mesh.visible !== false).length,
      featHere: inWin.filter((m) => m.feature === mv.feature).length,
      readout: document.getElementById('tp-zreadout').textContent,
      undo: state.undoStack.length,
      tris: state.models.map((m) => m.rawTris.length).join(',')
    };
  });
  const beforeExtract = await page.evaluate(() => ({
    models: state.models.length, undo: state.undoStack.length
  }));
  check('the checkbox turns the Z filter on', iso.on, true);
  check('the window is exactly one layer', iso.layersInWin, 1);
  check('every model of this import is hidden while it is on', iso.importedVisible, 0);
  check('the box that was already on the plate is left alone', iso.otherVisible, 1);
  check('this feature at this Z is a STRICT subset of the whole feature',
    iso.featHere > 0 && iso.featHere < spread.all, true);
  check('the readout says one layer is isolated',
    /one layer, isolated/.test(iso.readout), true);
  console.log('       ' + iso.readout);

  // -----------------------------------------------------------------------
  console.log('\n--- Extract, through the button on that card ---');
  await page.click('#btn-tp-extract');
  const extracted = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    const m = state.models[state.models.length - 1];
    return {
      models: state.models.length,
      undo: state.undoStack.length,
      name: m.name,
      tris: m.rawTris.length / 9,
      inWindow: window.NSO_TOOLPATH.movesInWindow().length,
      placed: state.placed.filter((p) => p.sourceId === m.id).length,
      said: window.__status[window.__status.length - 1]
    };
  });
  check('one new model, and one new undo entry',
    [extracted.models - beforeExtract.models, extracted.undo - beforeExtract.undo], [1, 1]);
  check('it is the isolated layer, 12 triangles a line and nothing else',
    extracted.tris, extracted.inWindow * 12);
  check('it is named for the Z it came from', /Z \d+\.\d+ mm/.test(extracted.name), true);
  check('it is a real piece on the plate', extracted.placed, 1);
  check('and the app said so', /Extract Line ok/.test(extracted.said), true);
  console.log('       ' + extracted.said);

  await page.click('#btn-undo');
  const undone = await page.evaluate(() => ({
    models: state.models.length, undo: state.undoStack.length
  }));
  check('one Undo takes back the extraction and nothing else',
    [undone.models, undone.undo], [beforeExtract.models, beforeExtract.undo]);

  await page.uncheck('#tp-zfilter');
  const off = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    return {
      on: s.zFilter.on,
      hidden: s.modelIds.filter((id) => {
        const e = state.placed.find((p) => p.sourceId === id);
        return e && e.mesh && e.mesh.visible === false;
      }).length,
      tris: state.models.map((m) => m.rawTris.length).join(',')
    };
  });
  check('unchecking gives every model its visibility back', [off.on, off.hidden], [false, 0]);
  check('the whole round trip edited no geometry', off.tris, iso.tris);

  // -----------------------------------------------------------------------
  console.log('\n--- the button refuses what it cannot read ---');
  const before = await page.evaluate(() => ({
    models: state.models.length, file: window.NSO_TOOLPATH.getSession().file
  }));
  await pickThroughButton(page, PLAIN);
  await page.waitForFunction(
    () => /not a sliced project/.test(window.__status[window.__status.length - 1] || ''),
    null, { timeout: 15000 });
  const refused = await page.evaluate(() => ({
    said: window.__status[window.__status.length - 1],
    models: state.models.length,
    file: window.NSO_TOOLPATH.getSession().file
  }));
  check('a plain .3mf picked here is named and refused',
    /pa_pattern\.3mf is not a sliced project/.test(refused.said), true);
  check('it says what the microscope wants instead',
    /\.gcode\.3mf/.test(refused.said), true);
  check('nothing was imported by the back door', refused.models, before.models);
  check('and the open session was not disturbed', refused.file, before.file);

  // -----------------------------------------------------------------------
  console.log('\n--- reset puts it back the way it was ---');
  await page.evaluate(() => { window.NSO_TOOLPATH.reset(); });
  check('reset hides the card again', await page.isVisible('#toolpath-card'), false);
  check('and puts the rail button out',
    await page.evaluate(() => document.getElementById('btn-gcode').classList.contains('is-on')), false);

  // -----------------------------------------------------------------------
  // On a fresh page, so the timings below measure this file and not the
  // geometry three earlier imports left on the plate.
  console.log('\n--- and again at real scale: 202,877 moves through the same button ---');
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });
  check('the button is wired again after a reload', await page.isVisible('#btn-gcode'), true);

  const t0 = Date.now();
  await pickThroughButton(page, BIG);
  await page.waitForFunction('window.NSO_TOOLPATH.getSession() !== null', null, { timeout: 180000 });
  const big = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    return { file: s.file, moves: s.moves.length, layers: s.layers.length,
             features: s.result.groups.length, assumed: s.result.parsed.meta.assumed };
  });
  console.log(`       imported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check('the big real slice opens from the same button', big.file, 'tabletop.gcode.3mf');
  check('73 layers, 202877 moves, 9 features',
    [big.layers, big.moves, big.features], [73, 202877, 9]);
  check('still nothing assumed at real scale', big.assumed, false);
  check('the card opened for it too', await page.isVisible('#toolpath-card'), true);

  // Time the CHANGE HANDLER, not the round trip: a capture-phase listener runs
  // before the module's, and a bubble listener added now runs after it, so the
  // pair brackets exactly the work the checkbox sets off. Wall-clock around
  // `page.check` would fold in Playwright's own actionability polling, which
  // on a busy main thread is most of the number and none of the feature.
  await page.evaluate(() => {
    const el = document.getElementById('tp-zfilter');
    el.addEventListener('change', () => { window.__z0 = performance.now(); }, true);
    el.addEventListener('change', () => { window.__z1 = performance.now(); });
  });
  // `force` and a long timeout, for a reason worth writing down: the handler
  // itself takes 48ms (measured just below), but `page.check` on this file has
  // been seen to take ~19s, and it timed out at Playwright's 30s default when
  // the suite ran its shards side by side. The cost is NOT the feature - it is
  // Playwright's actionability polling and the frames three.js paints for a
  // scene holding a 202,877-move import, in a software rasteriser under load.
  // `force` drops the polling; the timeout covers the frames. The small real
  // slice above is checked WITHOUT either, so the ordinary path still proves
  // the checkbox is genuinely clickable.
  await page.check('#tp-zfilter', { force: true, timeout: 120000 });
  const bigIso = await page.evaluate(() => ({
    layersInWin: window.NSO_TOOLPATH.layersInWindow(),
    readout: document.getElementById('tp-zreadout').textContent,
    ms: Math.round(window.__z1 - window.__z0)
  }));
  console.log(`       Z filter handler: ${bigIso.ms}ms`);
  check('one layer out of 73, at real scale', bigIso.layersInWin, 1);
  check('and it says so', /one layer, isolated/.test(bigIso.readout), true);

  await page.click('#btn-tp-extract', { timeout: 120000 });
  const bigOut = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { name: m.name, tris: m.rawTris.length / 9,
             inWindow: window.NSO_TOOLPATH.movesInWindow().length };
  });
  check('the isolated real layer extracts as its own piece',
    bigOut.tris, bigOut.inWindow * 12);
  console.log(`       ${bigOut.name} - ${bigOut.tris} triangles`);

  // -----------------------------------------------------------------------
  check('no uncaught page errors', errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
