#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-flange-drive-check.mjs
 *
 * G-scope's Flange row, driven through the real app in headless Chromium.
 * READ docs/GSCOPE-FLANGE.md for the rule; tools/nso_flange_test.js holds
 * the rule to the clamp bar's real geometry. This holds the ROW to it. The
 * row is one of the Parts list's show / hide toggles, the same model as a
 * slice's All features list: nothing in that list isolates, and the list
 * never leaves the screen.
 *
 *   1  THE REAL CLAMP BAR, through G-scope's own Import (library/
 *      v9_mirror_factory.stl): the row says a flange is there and opens
 *      switched on, and what the page lifted out is the same solid
 *      nso_flange.js lifts out in Node - triangle for triangle.
 *   2  ONE CLICK SHOWS IT ALONE: a real click on the part's own row switches
 *      the part off and leaves the flange on screen alone, in the row's
 *      colour - the list still up, nothing isolated, no Back to press. The
 *      part's row back on is the whole part again, the flange over it.
 *   3  THE SAME WAY OUT AS ANY SELECTION: Select shown takes exactly the
 *      flange; Export as STL writes exactly it (closed, manifold, nothing of
 *      the neck or ribs), and Crop takes a Z band out of it as a new piece.
 *   4  THE PLATE ROUTE: the clamp bar on the plate, the rail button, the row.
 *      The same toggles there - which used to be a dead end once isolated
 *      (only a full "Read the plate" reopen got you back), pinned so it cannot
 *      come back: the rows alone return the whole plate. Export to plate
 *      lands the flange as its own piece and leaves the clamp bar exactly as
 *      it was.
 *   5  NO FLANGE, SAID SO: a real part with none (library/hinge_knuckle_box
 *      .stl) reads "none detected", stays off, and a click on it selects
 *      nothing, draws nothing new and says why. A slice has no Flange row.
 *   6  SCREENSHOTS of the row found, the flange alone, on the part, and none.
 *
 * Usage: node tools/gcode-test/gscope-flange-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const require = createRequire(import.meta.url);
const F = require(join(ROOT, 'nso_flange.js'));
const SHOTS = join(ROOT, 'tools', 'gscope-flange-out');

const CLAMP = 'library/v9_mirror_factory.stl';
const NONE = 'library/hinge_knuckle_box.stl';
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';

function readSTL(buf) {
  const n = buf.readUInt32LE(80), o = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o[t * 9 + k] = buf.readFloatLE(84 + t * 50 + 12 + k * 4);
  return o;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
  return { lo, hi };
}
const r3 = (a) => a.map((x) => Math.round(x * 1000) / 1000);

/** What nso_flange.js lifts out of the file in Node, with app-cut.js's rawCut. */
async function nodeFlange(rel) {
  const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
    Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('var state = {}; var THREE = {};', ctx);
  vm.runInContext(await readFile(join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
  const soup = readSTL(await readFile(join(ROOT, rel)));
  const r = F.detect(soup);
  return r.flanges.map((f) => F.extract(soup, f, ctx.rawCut));
}

function validate(file) {
  const j = JSON.parse(execFileSync('python3', [join(ROOT, 'tools', 'mesh_validate.py'), file, '--no-selfint', '--json']).toString());
  return [j.verdict, j.open_edges, j.nonmanifold_edges, j.inconsistent_winding_edges, j.euler_characteristic];
}

async function frames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** A drawn view, asserted from the back buffer (see microscope-overlay-drive-check.mjs, shot()). */
async function shot(page, file, label) {
  await frames(page);
  const path = join(SHOTS, file);
  await page.locator('#microscope').screenshot({ path });
  const px = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    v.renderer.render(v.scene, v.camera);
    const gl = v.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const b = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    let lit = 0, orange = 0;
    for (let i = 0; i < b.length; i += 4 * 53) {
      if (b[i] > 0x20 || b[i + 1] > 0x20 || b[i + 2] > 0x20) lit++;
      // The tab's colour, 0xff8a1f, lit and shaded: red well over green over blue.
      if (b[i] > 90 && b[i] > b[i + 1] * 1.3 && b[i + 1] > b[i + 2] * 1.5) orange++;
    }
    return { lit, orange };
  });
  const size = (await stat(path)).size;
  console.log(`       ${file}  ${px.lit} lit samples, ${px.orange} flange-coloured, ${(size / 1024).toFixed(0)} kB`);
  check(`${label}: the canvas is a drawn view`, px.lit > 20 && size > 5000, true);
  return px;
}

/** Wait for the row to finish looking, and read it. */
async function tab(page) {
  await page.waitForFunction(() => {
    const f = window.NSO_MICROSCOPE.flange();
    return f && f.status !== 'pending';
  }, null, { timeout: 60000 });
  await frames(page);
  return page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    const row = document.querySelector('#ms-detected [data-detected="flange"]');
    return {
      state: M.flange(),
      row: row ? { text: row.textContent, status: row.dataset.status, dim: row.classList.contains('dim'),
                   checked: row.getAttribute('aria-checked'), title: row.title,
                   visible: !!(row.offsetWidth && row.offsetHeight) } : null,
      legendRows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      parts: Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map((e) => e.dataset.group),
    };
  });
}

/** What G-scope draws and holds right now (see gscope-features-drive-check.mjs, view()). */
async function view(page) {
  await frames(page);
  return page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    const drawn = [];
    v.overviewGroup.children.forEach((c) => {
      if (c.visible) drawn.push([c.userData.feature, c.material.color.getHex()]);
    });
    drawn.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const float = document.getElementById('ms-legend-float');
    return {
      drawn, detail: v.detailGroup.visible, overview: v.overviewGroup.visible,
      badge: document.getElementById('ms-mode-badge').textContent,
      backShown: getComputedStyle(document.getElementById('ms-detail-controls')).display !== 'none',
      listUp: !!(float.offsetWidth && float.offsetHeight),
      rows: document.querySelectorAll('#ms-legend-float .ms-legend-item').length,
      sel: M.selection().map((o) => o.name), by: M.selectionSource(),
      exportShown: getComputedStyle(document.getElementById('ms-export-row')).display !== 'none',
      info: document.getElementById('ms-info').textContent,
      docSource: M.getDoc() && M.getDoc().source, panelOpen: M.isOpen(),
    };
  });
}

const partRow = (page, name) => page.click(`#ms-legend [data-group="${name}"]`);

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  gscopeCards.install(page);
  routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!(window.NSO_MICROSCOPE && window.NSO_Flange), null, { timeout: 30000 });

  const ref = await nodeFlange(CLAMP);

  // =======================================================================
  console.log('\n--- 1. the real clamp bar, through G-scope\'s own Import ---');
  // =======================================================================
  await page.click('#btn-microscope');                       // empty plate: panel + chooser
  await page.setInputFiles('#ms-input', join(ROOT, CLAMP));
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && /v9_mirror_factory/.test(d.name);
  }, null, { timeout: 30000 });
  const t1 = await tab(page);
  check('the row found a flange', t1.state.status, 'found');
  check('one flange, lifted out of the one part', t1.state.objects.map((o) => [o.name, o.host]),
    [['v9_mirror_factory - Flange', 'v9_mirror_factory']]);
  check('the row reads it, lit and switched on', [t1.row.text, t1.row.dim, t1.row.checked, t1.row.visible],
    [`Flange (2.94 mm, ${ref[0].positions.length / 9} tri)`, false, 'true', true]);
  check('the file\'s own rows are untouched: one part, one row', t1.legendRows, 1);
  check('the list is titled Parts', await page.textContent('#ms-legend-title'), 'Parts');
  console.log('       detected in ' + t1.state.ms + ' ms (page)');
  const pageObj = t1.state.objects[0];
  const rb = bounds(ref[0].positions);
  check('what the page lifted out is what nso_flange.js lifts out in Node: triangle count',
    pageObj.triangles, ref[0].positions.length / 9);
  check('... and bounds, to the micron',
    r3([pageObj.bounds.minX, pageObj.bounds.minY, pageObj.bounds.minZ, pageObj.bounds.maxX, pageObj.bounds.maxY, pageObj.bounds.maxZ]),
    r3([rb.lo[0], rb.lo[1], rb.lo[2], rb.hi[0], rb.hi[1], rb.hi[2]]));
  check('the whole plate and nothing else: X -93.49..93.49, Y -17.01..-2.01, Z 7.53..10.47',
    r3([pageObj.bounds.minX, pageObj.bounds.maxX, pageObj.bounds.minY, pageObj.bounds.maxY, pageObj.bounds.minZ, pageObj.bounds.maxZ])
      .map((x) => Math.round(x * 100) / 100),
    [-93.49, 93.49, -17.01, -2.01, 7.53, 10.47]);
  check('2.94 mm thick, 14 mm out, 186 mm of root',
    [pageObj.flange.thickness.toFixed(2), Math.floor(pageObj.flange.reach), Math.floor(pageObj.flange.rootLength)],
    ['2.94', 14, 186]);
  const v0 = await view(page);
  check('it opens drawn over the part in the row\'s colour', v0.drawn.map((d) => d[0]),
    ['v9_mirror_factory', 'v9_mirror_factory - Flange']);
  check('...the flange in 0xff8a1f', v0.drawn[1][1], 0xff8a1f);
  await shot(page, '1-flange-row-found.png', 'the clamp bar with its Flange row');

  // =======================================================================
  console.log('\n--- 2. one click on the part\'s row: the flange alone ---');
  // =======================================================================
  await partRow(page, 'v9_mirror_factory');
  const alone = await view(page);
  check('the part switched off: the flange alone, in the row\'s colour', alone.drawn,
    [['v9_mirror_factory - Flange', 0xff8a1f]]);
  check('...nothing isolated, nothing selected, no Back to press', [alone.detail, alone.overview, alone.badge,
    alone.backShown, alone.sel], [false, true, 'Whole part', false, []]);
  check('...and the list stays up, both rows in it', [alone.listUp, alone.rows], [true, 6]);
  const isoPx = await shot(page, '2-flange-alone.png', 'the flange alone');
  check('and it is the flange\'s colour on screen', isoPx.orange > 50, true);
  await partRow(page, 'v9_mirror_factory');
  const both = await view(page);
  check('the part\'s row back on: the whole part again, the flange over it',
    [both.drawn.map((d) => d[0]), both.detail, both.badge], [['v9_mirror_factory', 'v9_mirror_factory - Flange'], false, 'Whole part']);
  await shot(page, '3-flange-highlighted-on-part.png', 'the flange highlighted on the whole part');
  await partRow(page, 'v9_mirror_factory');
  await page.click('#ms-btn-select-visible');
  const taken = await view(page);
  check('Select shown takes exactly what is checked: the flange', [taken.sel, taken.by], [['v9_mirror_factory - Flange'], 'visible']);
  check('Export is offered for it, as for any selection', taken.exportShown, true);
  check('the info line names it', /everything shown.*1 object\(s\).*v9_mirror_factory - Flange/.test(taken.info), true);

  // =======================================================================
  console.log('\n--- 3. the same way out as any selection ---');
  // =======================================================================
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#ms-btn-export-stl'),
  ]);
  check('Export as STL names the file for the flange', dl.suggestedFilename(), 'v9_mirror_factory_-_Flange.stl');
  const stlPath = join(SHOTS, 'exported-flange.stl');
  await dl.saveAs(stlPath);
  const written = readSTL(await readFile(stlPath));
  const wb = bounds(written);
  check('it writes exactly the flange: the same triangles', written.length / 9, ref[0].positions.length / 9);
  check('with nothing of the neck (Y <= -2.01) or the body below (Z >= 7.53)',
    [wb.hi[1] <= -2.01, wb.lo[2] >= 7.53], [true, true]);
  check('and the file is a clean solid (verdict, open, nm, inconsistent, chi)', validate(stlPath), ['PASS', 0, 0, 0, 2]);

  // Crop: through the Crop tool, a Z band out of the flange, as a new piece.
  const beforeCrop = await page.evaluate(() => ({ models: state.models.length, undo: state.undoStack.length }));
  const crop = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    M.setZRangeMm(8.5, 9.5);
    M.flushView();
    const why = M.cropReason();
    const read = document.getElementById('ms-crop-read').textContent;
    const res = M.cropZBand();
    const m = state.models[state.models.length - 1];
    let lo = Infinity, hi = -Infinity;
    const p = m.rawTris;
    for (let i = 2; i < p.length; i += 3) { if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
    return { why, read, ok: res.ok, name: m.name, zSpan: hi - lo, models: state.models.length,
             undo: state.undoStack.length };
  });
  check('Crop is offered on the flange, as a new piece (it is not a plate piece)',
    [crop.why, /as a new piece on the plate/.test(crop.read)], ['', true]);
  check('Crop takes the band out', crop.ok, true);
  check('landing one new piece, named for the flange', [crop.models - beforeCrop.models, crop.name],
    [1, 'v9_mirror_factory - Flange - cropped']);
  check('about 1 mm thinner: the 2.94 mm flange, less the band', Math.abs(crop.zSpan - 1.94) < 0.15, true);
  console.log(`       cropped flange Z span ${crop.zSpan.toFixed(3)} mm`);

  // =======================================================================
  console.log('\n--- 4. the plate route: the clamp bar on the plate ---');
  // =======================================================================
  // A successful Crop closes G-scope onto the plate, where the new piece is.
  check('Crop closed G-scope onto the plate', await page.isVisible('#microscope'), false);
  const bytes = Array.from(await readFile(join(ROOT, CLAMP)));
  const nBefore = await page.evaluate(() => state.models.length);
  await page.evaluate(([b]) => handleFiles([new File([new Uint8Array(b)], 'v9_mirror_factory.stl')]), [bytes]);
  await page.waitForFunction((n) => state.models.length === n, nBefore + 1, { timeout: 30000 });
  const hostBefore = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { id: m.id, tris: m.rawTris.length / 9, name: m.name };
  });
  // The rail button reopens the file last looked at; "Read the plate" is the
  // way from a file back to the plate.
  await page.click('#btn-microscope');
  await page.click('#ms-btn-plate');
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && d.source === 'plate';
  }, null, { timeout: 30000 });
  const t4 = await tab(page);
  const clampRows = t4.state.objects.filter((o) => /v9_mirror_factory/.test(o.host));
  check('on the plate, the tab finds the clamp bar\'s flange', clampRows.length >= 1 && t4.state.status === 'found', true);
  const plateFlange = clampRows[clampRows.length - 1];
  check('the same flange (triangles)', plateFlange.triangles, ref[0].positions.length / 9);
  check('named for its piece', /v9_mirror_factory.* - Flange$/.test(plateFlange.name), true);
  check('the cropped flange from section 3 is a plain plate now: no flange of its own',
    t4.state.objects.length, 1);
  const placedBefore = await page.evaluate(() => state.placed.length);
  check('the row is on there too', t4.row.checked, 'true');
  // Every part's row off: the plate's flange alone. Real clicks.
  for (const g of t4.parts) await partRow(page, g);
  const pAlone = await view(page);
  check('on the plate, every part off: the clamp bar\'s flange alone, the list still up',
    [pAlone.drawn.map((d) => d[0]), pAlone.detail, pAlone.listUp], [[plateFlange.name], false, true]);
  await page.click('#ms-btn-select-visible');
  check('Select shown takes it on the plate too',
    await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((o) => o.name)), [plateFlange.name]);

  // The dead end this used to be, on the PLATE route specifically: isolating
  // the flange left no way back to the whole part except closing G-scope and
  // reopening it - the same "read the plate again" reload a user reaches for
  // when nothing else works. Now nothing isolates, and the rows themselves
  // are the way back - here as on a file.
  for (const g of t4.parts) await partRow(page, g);
  const plateBacked = await page.evaluate((hostId) => {
    const v = window.NSO_MICROSCOPE.getView(), d = window.NSO_MICROSCOPE.getDoc();
    const host = d.objects.find((o) => o.sourceId === hostId);
    return {
      overview: v.overviewGroup.visible, detail: v.detailGroup.visible,
      badge: document.getElementById('ms-mode-badge').textContent,
      docSource: d && d.source, panelOpen: window.NSO_MICROSCOPE.isOpen(),
      hostTriangles: host ? host.triangles : null,
      hostDrawn: !!(host && v.overviewMeshes[host.name] && v.overviewMeshes[host.name].visible),
    };
  }, hostBefore.id);
  check('the part rows back on, on the PLATE route: the whole plate again, not a reload', plateBacked,
    { overview: true, detail: false, badge: 'Whole part', docSource: 'plate', panelOpen: true,
      hostTriangles: hostBefore.tris, hostDrawn: true });
  check('...and Select shown, still the choice, follows: the parts, not the flange twice',
    (await view(page)).sel.sort(), t4.parts.slice().sort());
  await shot(page, '3b-plate-flange-back.png', 'the plate route, the parts back on, the flange over the clamp bar');

  // The flange alone again for the export that follows.
  for (const g of t4.parts) await partRow(page, g);
  check('the parts off again: Select shown is the same flange again',
    await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((o) => o.name)), [plateFlange.name]);
  await page.click('#ms-btn-export-plate');
  const after4 = await page.evaluate((hostId) => {
    const host = state.models.find((m) => m.id === hostId);
    const m = state.models[state.models.length - 1];
    return { placed: state.placed.length, name: m.name, rawAxis: m.rawAxis,
             hostTris: host.rawTris.length / 9, open: !document.getElementById('microscope').hidden };
  }, hostBefore.id);
  check('Export to plate lands the flange as a new piece', [after4.placed, after4.name],
    [placedBefore + 1, plateFlange.name]);
  check('through the ordinary ingest path', after4.rawAxis, 'zup');
  check('and the clamp bar itself is untouched', after4.hostTris, hostBefore.tris);

  // =======================================================================
  console.log('\n--- 5. no flange, said so ---');
  // =======================================================================
  // Export to plate closed G-scope; open it again and Import a file.
  await page.click('#btn-microscope');
  await page.setInputFiles('#ms-input', join(ROOT, NONE));
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && /hinge_knuckle_box/.test(d.name);
  }, null, { timeout: 30000 });
  const t5 = await tab(page);
  check('a part with no flange: the row says none detected, and is off', [t5.state.status, t5.row.text, t5.row.dim, t5.row.checked],
    ['none', 'Flange - none detected', true, 'false']);
  check('and says why, in words, when asked (the row\'s tooltip)',
    /^No flange: the nearest flat plate \(8 mm\) does not come off anything thicker$/.test(t5.row.title), true);
  console.log('       ' + t5.row.title);
  const n0 = await view(page);
  await page.click('#ms-detected [data-detected="flange"]');
  const none = await view(page);
  check('a click selects nothing, draws nothing new, isolates nothing',
    [none.sel.length, none.drawn, none.detail, none.exportShown], [0, n0.drawn, false, false]);
  check('...and the row stays off', (await tab(page)).row.checked, 'false');
  check('and the info line says no flange was found', /^No flange detected\./.test(none.info), true);
  await shot(page, '4-no-flange.png', 'a part with no flange');

  await page.setInputFiles('#ms-input', join(ROOT, SLICE));
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && d.kind === 'toolpath';
  }, null, { timeout: 60000 });
  const t6 = await tab(page);
  check('a slice: no Flange row - its one list is its features', [t6.row, await page.textContent('#ms-legend-title')],
    [null, 'All features']);
  check('...asked, the rule says it cannot look, and why', [t6.state.status, /closed surface/.test(t6.state.reason)],
    ['unavailable', true]);
  check('the slice\'s own feature rows are all still there', t6.legendRows, 10);

  check('no page errors', errors, []);
  await browser.close();
  served.srv.close();
  const failed = check.report();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
