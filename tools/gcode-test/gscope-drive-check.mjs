#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-drive-check.mjs
 *
 * G-scope - the ONE G-code tool - driven through the real app in headless
 * Chromium. Every claim of the consolidation ticket, checked where a user
 * would meet it:
 *
 *   1  ONE TOOL, TWO WAYS IN. The old G🔬 door (#btn-gcode, which put a slice
 *      on the plate and never opened the view) is gone, and nothing else
 *      reaches the removed importer. The rail button opens G-scope; a
 *      `.gcode.3mf` through the app's own Import, a dropped file, and a slice
 *      RENAMED to a plain `.3mf` all land in G-scope too - recognised by
 *      content - and put nothing on the plate. A plain 3MF still goes to the
 *      plate and does not open G-scope.
 *   2  CLEAR FROM VIEW IS VIEW ONLY. Clearing a plate piece, a picked line
 *      (NSO_MICROSCOPE.clearFromView() - round 2c dropped its button, the API
 *      stays), soloing a feature, Isolate / Whole part and the slider change
 *      nothing on the plate: models, placement, raw meshes, undo stack - all
 *      compared before and after - and no download fires.
 *   3  LINE vs FEATURE ISOLATION. A real hover on a line reads THAT move out
 *      in SELECTION / SEGMENT INFO (round 2c: isolating one move from the UI
 *      is dropped; it is the API's pickLine + isolate); its isolated solid and
 *      its exported STL are extrudeFlatLine's prism of that move, triangle for
 *      triangle. The Features checkboxes (only Inner wall on) + a real click
 *      take exactly one feature's moves of the piece; selectVisible() (Select
 *      shown's API) takes them all, and with the slider, exactly that feature
 *      inside the Z band.
 *   4  THE LAYER-RANGE SLIDER. Real drags on both handles; one layer (exactly
 *      the moves NSOGcodeLines.movesAtZ finds), a chunk (the window moved
 *      with Shift+Arrow), everything (All). On a mesh document it clips.
 *   5  TAKE BAND (was Crop Z, docs/GSCOPE.md item 5; the card's Slice-side
 *      row): the slider's range, isolated as one piece - exactly the band's
 *      moves, the mode left as it was, nothing on the plate.
 *   6  SCREENSHOTS of every visual claim, each asserted to be a drawn view.
 *
 * Usage:
 *   node tools/gcode-test/gscope-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const PLAIN_3MF = 'fixtures/3mf/pa_pattern.3mf';
const CUBE = 'fixtures/box-20mm.stl';                 // 20 mm cube, ASCII
const SHOTS = join(ROOT, 'tools', 'gscope-out');

function stlTriangles(buf) {
  const n = buf.readUInt32LE(80);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const t = [];
    for (let k = 0; k < 9; k++) t.push(buf.readFloatLE(o + k * 4));
    out.push(t);
  }
  return out;
}

async function frames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Screenshot G-scope and prove the canvas is a drawn view (see the overlay check). */
async function shot(page, file, label, target = 'scope') {
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  await frames(page);
  const path = join(SHOTS, file);
  await page.locator(target === 'scope' ? '#microscope' : 'body').screenshot({ path });
  const px = await page.evaluate((t) => {
    let r, scene, cam;
    if (t === 'scope') {
      const v = window.NSO_MICROSCOPE.getView();
      r = v.renderer; scene = v.scene; cam = v.camera;
    } else {
      r = state.renderer; scene = state.scene; cam = state.camera;
    }
    r.render(scene, cam);
    const gl = r.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const seen = new Set();
    let lit = 0;
    for (let i = 0; i < buf.length; i += 4 * 97) {
      seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
      if (buf[i] > 0x20 || buf[i + 1] > 0x20 || buf[i + 2] > 0x20) lit++;
    }
    return { distinct: seen.size, lit, w, h };
  }, target);
  const size = (await stat(path)).size;
  check(`${label}: screenshot is a drawn view, not a blank panel`,
    px.distinct > 6 && px.lit > 20 && px.w > 300 && px.h > 300, true);
  console.log(`       ${file}  ${px.w}x${px.h}, ${px.distinct} colours, ${px.lit} lit, ${(size / 1024).toFixed(0)} kB`);
}

/** Everything on the plate that a "view only" action must not change. */
const plateSnapshot = (page) => page.evaluate(() => ({
  models: state.models.map((m) => [m.id, m.name, m.rawTris ? m.rawTris.length : 0,
    m.geometry ? m.geometry.attributes.position.count : 0]),
  placed: state.placed.map((p) => [p.sourceId, p.name,
    +p.mesh.position.x.toFixed(5), +p.mesh.position.y.toFixed(5), +p.mesh.position.z.toFixed(5),
    +p.mesh.rotation.y.toFixed(5), p.mesh.visible]),
  undo: state.undoStack.length,
}));

async function plateFile(page, relPath, name) {
  const bytes = Array.from(await readFile(join(ROOT, relPath)));
  const before = await page.evaluate(() => state.models.length);
  await page.evaluate(([b, n]) => handleFiles([new File([new Uint8Array(b)], n)]), [bytes, name]);
  await page.waitForFunction((n) => state.models.length === n, before + 1, { timeout: 30000 });
}

/** Screen pixel of a G-code-space point in the G-scope canvas. */
function projectJS([x, y, z]) {
  const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
  const p = new THREE.Vector3(x - d.cx, z, -(y - d.cy)).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const TMP = await mkdtemp(join(tmpdir(), 'gscope-'));
  const RENAMED = join(TMP, 'plate-renamed.3mf');
  await copyFile(join(ROOT, SLICE), RENAMED);

  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  gscopeCards.install(page);
  const cdn = routeCdn(page);
  const errors = [];
  let downloads = 0;
  page.on('download', () => { downloads++; });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_MICROSCOPE, null, { timeout: 30000 });

  // =======================================================================
  console.log('\n--- 1. one tool: consolidation ---');
  // =======================================================================
  const dom = await page.evaluate(() => ({
    gcodeBtn: !!document.getElementById('btn-gcode'),
    gcodeInput: !!document.getElementById('gcode-input'),
    toolpathCard: !!document.getElementById('toolpath-card'),
    toolpathScript: !!document.querySelector('script[src*="app-toolpath"]'),
    oldGlobal: typeof window.NSO_TOOLPATH,
    // The lens glyph, or (shell v2: the slab reads "G-scope") the G-scope name.
    scopeButtons: [...document.querySelectorAll('button')]
      .filter((b) => /\u{1F52C}/u.test(b.textContent) || b.getAttribute('aria-label') === 'G-scope').map((b) => b.id),
    label: document.getElementById('btn-microscope').getAttribute('aria-label'),
    title: document.getElementById('ms-title').textContent,
  }));
  check('the old G-code door is gone: no #btn-gcode, no #gcode-input',
    [dom.gcodeBtn, dom.gcodeInput], [false, false]);
  check('no sidebar Toolpath card and no app-toolpath.js', [dom.toolpathCard, dom.toolpathScript], [false, false]);
  check('nothing can reach the removed plate importer', dom.oldGlobal, 'undefined');
  check('exactly ONE lens button on the page, and it is G-scope', dom.scopeButtons, ['btn-microscope']);
  check('it is called G-scope, on the button and in the panel', [dom.label, dom.title], ['G-scope', 'G-scope']);

  // Door A, empty plate: the panel AND a file chooser; answer it with a slice.
  let chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await page.click('#btn-microscope');
  let fc = await chooser;
  check('rail button on an empty plate: G-scope opens and asks for a file',
    [await page.isVisible('#microscope'), !!fc], [true, true]);
  await fc.setFiles(join(ROOT, SLICE));
  await page.waitForFunction(() => (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  check('the slice picked there opens in G-scope, and the plate stays empty',
    await page.evaluate(() => [window.NSO_MICROSCOPE.getDoc().segments.length, state.models.length]), [2895, 0]);
  await page.click('#ms-close');

  // Door B: the app's own Import, a real change event on #file-input.
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  await page.setInputFiles('#file-input', join(ROOT, SLICE));
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() &&
    (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  check('a .gcode.3mf through Import lands in G-scope, no button pressed, nothing on the plate',
    await page.evaluate(() => [window.NSO_MICROSCOPE.getDoc().name, state.models.length]),
    ['supportwithinsupport.gcode.3mf', 0]);
  check('and the status line says the plate was left alone',
    /nothing was added to the plate/.test(await page.textContent('#status')), true);
  await page.click('#ms-close');

  // Door B, renamed: recognised by content, not by the name.
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  await page.setInputFiles('#file-input', RENAMED);
  await page.waitForFunction(() => (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  check('a slice renamed to plain .3mf is recognised by content and lands in G-scope',
    await page.evaluate(() => [window.NSO_MICROSCOPE.getDoc().name, window.NSO_MICROSCOPE.getDoc().segments.length,
      state.models.length]), ['plate-renamed.3mf', 2895, 0]);
  await page.click('#ms-close');

  // Door B, dropped: a real drop event on the viewport.
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  const sliceBytes = Array.from(await readFile(join(ROOT, SLICE)));
  await page.evaluate((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'dropped.gcode.3mf'));
    document.getElementById('viewport').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, sliceBytes);
  await page.waitForFunction(() => (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  check('a slice dropped on the viewport lands in G-scope too',
    await page.evaluate(() => [window.NSO_MICROSCOPE.getDoc().name, state.models.length]), ['dropped.gcode.3mf', 0]);
  await page.click('#ms-close');

  // A plain 3MF is a model: the plate, not G-scope.
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  await page.setInputFiles('#file-input', join(ROOT, PLAIN_3MF));
  await page.waitForFunction(() => state.models.length === 1, null, { timeout: 30000 });
  check('a plain 3MF still imports onto the plate and does not open G-scope',
    await page.evaluate(() => [state.models.length, window.NSO_MICROSCOPE.isOpen()]), [1, false]);

  // Door A with something on the plate: no dialog at all.
  chooser = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
  await page.click('#btn-microscope');
  fc = await chooser;
  check('rail button with a piece on the plate: G-scope on the plate, no file dialog',
    [!!fc, await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().source)], [false, 'plate']);
  await page.click('#ms-close');
  // Clean plate for what follows.
  await page.evaluate(() => { state.undoStack.length = 0; });
  await page.click('#btn-clear-plate').catch(() => {});
  await page.evaluate(() => { if (state.models.length) { state.models = []; } });

  // =======================================================================
  console.log('\n--- 2. clear from view is view only ---');
  // =======================================================================
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  await plateFile(page, CUBE, 'cube-a.stl');
  await plateFile(page, CUBE, 'cube-b.stl');
  await page.click('#btn-microscope');
  const snap0 = await plateSnapshot(page);
  const dl0 = downloads;
  const pieces = await page.evaluate(() => window.NSO_MICROSCOPE.groups());
  check('two pieces under the lens', pieces.length, 2);
  // Select the first piece with a capture box over its own bounds.
  await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, o = M.getDoc().objects[0], b = o.bounds;
    M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 10.2, 10.2);
  });
  const caught = await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((o) => o.name));
  check('a box catches one piece', caught.length, 1);
  // Clear from view has no button since round 2c (the API stays): its job, view only, checked through it.
  await page.evaluate(() => window.NSO_MICROSCOPE.clearFromView());
  const cleared = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    return {
      hidden: M.hidden(), sel: M.selection().length, open: M.isOpen(),
      drawn: Object.keys(v.overviewMeshes).filter((k) => v.overviewMeshes[k].visible),
      info: document.getElementById('ms-info').textContent,
    };
  });
  check('Clear from view hides that piece in G-scope', cleared.hidden, caught);
  check('and only that one is still drawn', cleared.drawn, pieces.filter((p) => p !== caught[0]));
  check('the selection is emptied and G-scope stays open', [cleared.sel, cleared.open], [0, true]);
  check('it says nothing was exported and the plate is unchanged',
    /Nothing was exported and the plate is unchanged/.test(cleared.info), true);
  await shot(page, '01-plate-piece-cleared-from-view.png', 'a plate piece cleared from view');
  check('the plate is EXACTLY as it was: models, placement, raw meshes, undo', await plateSnapshot(page), snap0);
  check('no file was written', downloads, dl0);
  // More view actions, same promise.
  // A mesh document has no line types: the Features list has no rows (only its note),
  // so the old per-row "only" is the API's soloGroup here (what a Feature click calls).
  check('a mesh document has no Features rows - the list says it is not sliced',
    await page.evaluate(() => [document.querySelectorAll('#ms-legend .ms-legend-item').length,
      /Not sliced/.test(document.getElementById('ms-legend').textContent)]), [0, true]);
  await page.evaluate((g) => window.NSO_MICROSCOPE.soloGroup(g), pieces[0]);
  // Select shown has no button since round 2c (selection is what's shown): its API.
  check('selectVisible() (Select shown\'s API) takes what is shown',
    await page.evaluate(() => window.NSO_MICROSCOPE.selectVisible().length > 0), true);
  // Isolate is in the card's REGION row (both sides) and isolates what the
  // boxes hold; WHOLE PART is the Normal side's un-isolate. Arm REGION as a
  // user does, box the shown piece, isolate, whole again, disarm.
  await page.click('#ms-mode-select');
  await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, o = M.getDoc().objects.find((x) => M.hidden().indexOf(x.name) < 0), b = o.bounds;
    M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 10.2, 10.2);
  });
  await page.click('#ms-btn-isolate');
  check('Isolate (the REGION row) isolates the selection on a mesh',
    await page.evaluate(() => window.NSO_MICROSCOPE.isIsolated()), true);
  await page.click('#ms-btn-back');
  check('WHOLE PART (the Normal side) backs out of it',
    await page.evaluate(() => window.NSO_MICROSCOPE.isIsolated()), false);
  await page.click('#ms-btn-clear');
  await page.click('#ms-mode-select');
  check('a second press on REGION disarms it', await page.evaluate(() => window.NSO_MICROSCOPE.mode()), 'piece');
  // Check all is the Features list's (a mesh has none: it is disabled); CLEAR is
  // what makes plate 1 whole again (docs/GSCOPE.md, items 2 and 4).
  check('a mesh has no Features boxes, so Check all is disabled',
    await page.evaluate(() => { const b = document.getElementById('ms-btn-show-all'); return [b.textContent.trim(), b.disabled]; }), ['Check all', true]);
  // CLEAR empties the active plate (docs/GSCOPE.md item 9); Read plate (inside IMPORT ▾) fills it again from the plate.
  await page.click('#ms-btn-take-clear');
  check('CLEAR empties plate 1', await page.evaluate(() => window.NSO_MICROSCOPE.getDoc()), null);
  await page.click('#ms-btn-plate');
  check('...and Read plate brings both pieces back, the cleared one drawn again',
    await page.evaluate(() => { const M = window.NSO_MICROSCOPE, ms = Object.values(M.getView().overviewMeshes);
      return [M.hidden(), M.groups().length, ms.length > 0 && ms.every((m) => m.visible)]; }),
    [[], 2, true]);
  check('after only / select shown / isolate / back / CLEAR: the plate is still untouched',
    await plateSnapshot(page), snap0);
  check('and still no file written', downloads, dl0);

  // =======================================================================
  console.log('\n--- 4a. the slider on a mesh document clips ---');
  // =======================================================================
  const zr = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    M.setZRangeMm(8, 12); M.flushView();
    const v = M.getView(), r = M.zRange();
    return { unit: r.unit, band: r.bandMm.map((z) => +z.toFixed(1)),
      planes: v.clip.map((p) => +p.constant.toFixed(3)),
      clipped: Object.values(v.overviewMeshes).every((m) => m.material.clippingPlanes.length === 2),
      visible: !document.getElementById('ms-zr').hidden };
  });
  check('the slider is docked and visible on a mesh document', zr.visible, true);
  check('in millimetres, not layers - a mesh has none', zr.unit, 'mm');
  // The cube stands on z=0 and is 20 mm tall: 201 steps is 0.1 mm a step.
  check('the band sits where it was put', zr.band, [8, 12]);
  check('and the view is clipped to it', [zr.clipped, zr.planes], [true, [-8, 12]]);
  await shot(page, '02-mesh-z-band.png', 'a mesh clipped to a Z band');
  check('the slider did not touch the plate either', await plateSnapshot(page), snap0);

  // =======================================================================
  console.log('\n--- 3. line-level vs feature-level isolation, on a real slice ---');
  // =======================================================================
  await page.setInputFiles('#file-input', join(ROOT, SLICE));
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() &&
    (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
  const snap1 = await plateSnapshot(page);
  const dl1 = downloads;
  await shot(page, '04-slice-overview-with-slider.png', 'a slice with the layer-range slider');

  // --- 4b. the slider, by real drags ---
  const handleBox = async (id) => page.locator(id).boundingBox();
  const trackBox = await page.locator('#ms-zr-track').boundingBox();
  let hb = await handleBox('#ms-zr-hi');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, trackBox.y + trackBox.height * 0.6, { steps: 8 });
  await page.mouse.up();
  hb = await handleBox('#ms-zr-lo');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, trackBox.y + trackBox.height * 0.75, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  const dragged = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, r = M.zRange(), v = M.getView(), d = M.getDoc();
    let verts = 0, outside = 0;
    Object.values(v.overviewMeshes).forEach((m) => {
      if (!m.visible) return;
      const a = m.geometry.attributes.position;
      verts += a.count;
      for (let i = 0; i < a.count; i++) if (a.getY(i) < r.zLo - 1e-4 || a.getY(i) > r.zHi + 1e-4) outside++;
    });
    // the upper handle may stand part way up its layer: that layer is drawn by the scrub (its first moves), the rest by the overview
    const sst = M.scrubState();
    const want = d.segments.filter((s) => s.z >= r.zLo - 1e-6 && s.z <= r.zHi + 1e-6).length - (sst ? sst.moves - sst.shown : 0);
    return { lo: r.lo, hi: r.hi, steps: r.steps, shown: M.shownCount(), want, drawn: verts / 2 + (sst ? sst.lines : 0), outside,
      readHi: document.getElementById('ms-zr-hi-read').textContent,
      readLo: document.getElementById('ms-zr-lo-read').textContent };
  });
  check('dragging the upper handle down and the lower one up narrows the range',
    dragged.lo > 0 && dragged.hi < dragged.steps - 1 && dragged.lo < dragged.hi, true);
  check('what is shown is exactly the moves printed inside the band', dragged.shown, dragged.want);
  check('and that is what is drawn - one GL line per shown move, none outside the band',
    [dragged.drawn, dragged.outside], [dragged.want, 0]);
  console.log(`       dragged to steps ${dragged.lo}..${dragged.hi} (${dragged.readLo} .. ${dragged.readHi}): ${dragged.shown} moves`);

  // One layer: Home on the upper handle collapses it onto the lower one.
  await page.focus('#ms-zr-hi');
  await page.keyboard.press('Home');
  const one = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, r = M.zRange(), d = M.getDoc(), G = window.NSOGcodeLines;
    return { lo: r.lo, hi: r.hi, shown: M.shownCount(), atZ: G.movesAtZ(d.parsed, r.zLo).length,
      count: document.getElementById('ms-zr-count').textContent };
  });
  check('Home on the upper handle: exactly one layer', one.lo, one.hi);
  check('holding exactly the moves NSOGcodeLines.movesAtZ finds at that Z', one.shown, one.atZ);
  check('and the slider says one layer', /^1 \/ 50 layers$/.test(one.count), true);
  await shot(page, '05-single-layer.png', 'one layer on the slider');
  // A chunk, moved as a window.
  await page.focus('#ms-zr-hi');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp');
  const chunk0 = await page.evaluate(() => window.NSO_MICROSCOPE.zRange());
  await page.focus('#ms-zr-lo');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  const chunk = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, r = M.zRange(), d = M.getDoc();
    return { r, shown: M.shownCount(),
      want: d.segments.filter((s) => s.zi >= r.lo && s.zi <= r.hi).length };
  });
  check('a chunk of five layers', chunk0.hi - chunk0.lo, 4);
  check('Shift+Arrow moves the whole window and keeps its width',
    [chunk.r.lo - chunk0.lo, chunk.r.hi - chunk0.hi], [2, 2]);
  check('the chunk shows exactly its layers\' moves', chunk.shown, chunk.want);
  await page.click('#ms-zr-all');
  check('All: everything again',
    await page.evaluate(() => [window.NSO_MICROSCOPE.zRange().full, window.NSO_MICROSCOPE.shownCount()]), [true, 2895]);

  // --- line-level: a REAL hover on a line reads THAT move ---
  const LAYER = 10;
  await page.evaluate((L) => { const M = window.NSO_MICROSCOPE; M.setZRange(L, L); M.soloGroup('Outer wall'); M.flushView(); }, LAYER);
  // soloGroup selected the layer's Outer wall; empty it, so the readout is the hover's and not the selection's.
  await page.evaluate(() => window.NSO_MICROSCOPE.setSelectionMoves([]));
  const aim = await page.evaluate(({ L, proj }) => {
    const project = new Function('return ' + proj)();
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    // Frame the layer so lines are well apart, then aim at the longest one.
    const segs = d.segments.filter((s) => s.zi === L && s.feature === 'Outer wall');
    const box = new THREE.Box3();
    segs.forEach((s) => { box.expandByPoint(new THREE.Vector3(s.x0 - d.cx, s.z, -(s.y0 - d.cy))); });
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    v.controls.target.copy(c);
    v.camera.position.set(c.x, c.y + Math.max(size.x, size.z) * 1.3, c.z + 0.01);
    v.camera.updateProjectionMatrix(); v.controls.update(); v.camera.updateMatrixWorld();
    const s = segs.slice().sort((a, b) => b.mv.length - a.mv.length)[0];
    return { idx: s.mv.index, px: project([(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z]), n: segs.length };
  }, { L: LAYER, proj: projectJS.toString() });
  // SELECT > Line's readout lives on as the hover's (round 2c): the move under
  // the pointer, read out in SELECTION / SEGMENT INFO, nothing picked.
  const moveRe = new RegExp('Move ' + (aim.idx + 1) + ' - Outer wall');
  await page.mouse.move(aim.px[0] - 6, aim.px[1] - 6);
  await page.mouse.move(aim.px[0], aim.px[1], { steps: 3 });
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('ms-info').textContent),
    moveRe.source, { timeout: 3000 }).catch(() => {});
  const hoverRead = await page.evaluate(() => ({ info: document.getElementById('ms-info').textContent,
    sel: window.NSO_MICROSCOPE.selection().length, iso: window.NSO_MICROSCOPE.isIsolated() }));
  check('a real hover on a line names exactly that move in SELECTION / SEGMENT INFO', moveRe.test(hoverRead.info), true);
  check('and the hover picks and isolates nothing', [hoverRead.sel, hoverRead.iso], [0, false]);
  // Isolating one move from the UI is dropped (round 2c): the pick and the isolate are the API's.
  await page.mouse.move(5, 450);
  const picked = await page.evaluate((idx) => {
    const M = window.NSO_MICROSCOPE;
    M.pickLine(idx); M.isolate(); M.flushView();
    return { sel: M.selection().map((s) => s.mv.index), by: M.selectionSource(), iso: M.isIsolated(),
      info: document.getElementById('ms-info').textContent };
  }, aim.idx);
  check('pickLine (the API) takes exactly that move', picked.sel, [aim.idx]);
  check('as a line selection', picked.by, 'line');
  check('and isolate() isolates it', picked.iso, true);
  check('and SELECTION / SEGMENT INFO names it', moveRe.test(picked.info), true);
  await shot(page, '06-line-picked.png', 'one line picked and highlighted');

  // Step with the keyboard, the way the old Toolpath card did (a line selection only).
  await page.focus('#microscope');
  await page.keyboard.press('ArrowRight');
  const stepped = await page.evaluate((L) => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const shown = d.segments.filter((s) => s.zi === L && s.feature === 'Outer wall');
    return { sel: M.selection().map((s) => s.mv.index), order: shown.map((s) => s.mv.index) };
  }, LAYER);
  const at = stepped.order.indexOf(aim.idx);
  check('Right arrow steps to the next drawn move in print order',
    stepped.sel, [stepped.order[Math.min(at + 1, stepped.order.length - 1)]]);
  await page.keyboard.press('ArrowLeft');
  check('Left arrow steps back', await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((s) => s.mv.index)), [aim.idx]);

  // Isolated, the line is that one move alone, as-is - its line, nothing else
  // (the arrows redrew it; it is back on the picked move).
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  const lineAlone = await page.evaluate((idx) => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView(), mv = d.parsed.moves[idx];
    const p = [];
    v.detailGroup.children.forEach((c) => { p.push(...c.geometry.attributes.position.array); });
    const g = [];
    for (let i = 0; i < p.length; i += 3) g.push([p[i] + d.cx, -p[i + 2] + d.cy, p[i + 1]]);
    const err = g.length === 2 ? Math.max(
      Math.abs(g[0][0] - mv.x0), Math.abs(g[0][1] - mv.y0), Math.abs(g[0][2] - mv.z),
      Math.abs(g[1][0] - mv.x1), Math.abs(g[1][1] - mv.y1), Math.abs(g[1][2] - mv.z)) : Infinity;
    return { kinds: v.detailGroup.children.map((c) => c.type), n: g.length, err,
      overview: v.overviewGroup.visible, badge: document.getElementById('ms-mode-badge').textContent };
  }, aim.idx);
  check('Isolate shows the one move alone, as its line', [lineAlone.kinds, lineAlone.n], [['LineSegments'], 2]);
  check('and it is that move, endpoint for endpoint (to the micron)', lineAlone.err < 1e-3, true);
  check('the overview is hidden and the badge says one segment', [lineAlone.overview, lineAlone.badge], [false, 'Detail: 1 segments']);
  await shot(page, '07-line-isolated.png', 'one line isolated, alone, as-is');

  // Back to the whole part, still selected: its extrudeFlatLine prism,
  // highlighted in context. A slice is the card's Slice side: WHOLE PART is
  // not shown there, Escape is its job.
  check('a slice shows the card\'s Slice side, without WHOLE PART',
    await page.evaluate(() => [window.NSO_MICROSCOPE.cardSide(), !!document.getElementById('ms-btn-back').offsetParent]),
    ['slice', false]);
  await page.focus('#microscope');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  const lineIso = await page.evaluate((idx) => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView(), G = window.NSOGcodeLines;
    const mv = d.parsed.moves[idx];
    const want = G.extrudeFlatLine(mv, []);
    const got = [];
    v.highlightGroup.children.forEach((c) => { got.push(...c.geometry.attributes.position.array); });
    // Detail positions are view space; take them back to G-code space.
    let maxErr = 0;
    for (let i = 0; i < got.length; i += 3) {
      const gx = got[i] + d.cx, gy = -got[i + 2] + d.cy, gz = got[i + 1];
      maxErr = Math.max(maxErr, Math.abs(gx - want[i]), Math.abs(gy - want[i + 1]), Math.abs(gz - want[i + 2]));
    }
    return { kinds: v.highlightGroup.children.map((c) => c.type), tris: got.length / 9, wantTris: want.length / 9, maxErr,
      overview: v.overviewGroup.visible, badge: document.getElementById('ms-mode-badge').textContent };
  }, aim.idx);
  check('back on the whole part, the one line is highlighted as ONE solid', lineIso.kinds, ['Mesh']);
  check('12 triangles - one prism, one move', [lineIso.tris, lineIso.wantTris], [12, 12]);
  check('and it IS extrudeFlatLine\'s prism of that move, to the micron', lineIso.maxErr < 1e-3, true);
  check('with the rest of the part drawn round it', [lineIso.overview, lineIso.badge], [true, 'Whole part']);
  await shot(page, '07b-line-highlighted.png', 'the same line on the whole part, its printed prism in context');

  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#ms-btn-export-stl')]);
  const lineStl = join(TMP, 'line.stl');
  await dl.saveAs(lineStl);
  const lineTris = stlTriangles(await readFile(lineStl));
  const wantLine = await page.evaluate((idx) => window.NSOGcodeLines.extrudeFlatLine(window.NSO_MICROSCOPE.getDoc().parsed.moves[idx], []), aim.idx);
  check('the exported line is that prism, triangle for triangle',
    lineTris.length === 12 && lineTris.every((t, i) => t.every((v, k) => Math.abs(v - wantLine[i * 9 + k]) < 1e-4)), true);

  // Clear that one line from view: view only (clearFromView - its button is gone, round 2c).
  await page.evaluate(() => window.NSO_MICROSCOPE.clearFromView());
  const lineCleared = await page.evaluate((idx) => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    const drawn = Object.values(v.overviewMeshes).some((m) => (m.userData.segs || []).some((s) => s.mv.index === idx));
    return { cleared: M.cleared(), drawn, shown: M.shownCount() };
  }, aim.idx);
  check('clearFromView takes the picked line out of the drawing', [lineCleared.cleared, lineCleared.drawn], [[aim.idx], false]);
  check('one fewer line shown', lineCleared.shown, aim.n - 1);
  await shot(page, '08-line-cleared.png', 'a line cleared from view');

  // Feature-level. SELECT > Feature is gone (round 2c): a line type is the
  // Features list's checkboxes - what is shown is what a click takes. The
  // list is checkboxes only (docs/GSCOPE.md, item 4): its row text toggles its
  // box and nothing else.
  await page.click('#ms-btn-show-all');
  await page.click('#ms-zr-all');
  const inner = page.locator('#ms-legend .ms-legend-item[data-group="Inner wall"] .ms-legend-label');
  await inner.hover();
  await inner.click();
  check('a click on the Inner wall row text toggles its box, and selects and isolates nothing',
    await page.evaluate(() => [window.NSO_MICROSCOPE.hidden().indexOf('Inner wall') >= 0, window.NSO_MICROSCOPE.isIsolated(),
      window.NSO_MICROSCOPE.selection().length]), [true, false, 0]);
  await inner.click();
  check('the old Feature mode falls back to the piece', await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE; M.setMode('feature'); return M.mode(); }), 'piece');
  // Every other line type off by its real checkbox: only Inner wall is shown.
  for (const g of await page.evaluate(() => window.NSO_MICROSCOPE.groups())) {
    if (g !== 'Inner wall') await page.locator(`#ms-legend .ms-legend-item[data-group="${g}"] .ms-legend-display`).uncheck();
  }
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  const innerAim = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView(), r = v.renderer.domElement.getBoundingClientRect();
    const segs = d.segments.filter((g) => g.feature === 'Inner wall');
    for (const s of segs) {
      const p = M.toView((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z).project(v.camera);
      const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
      const t = M.pressTargetAt(x, y);
      if (t && t.source === 'pick' && document.elementFromPoint(x, y) === v.renderer.domElement) {
        return { px: [x, y], count: t.count };
      }
    }
    return null;
  });
  check('an Inner wall line is under the pointer somewhere', !!innerAim, true);
  await page.mouse.move(innerAim.px[0], innerAim.px[1]);
  await page.waitForTimeout(150);
  const hovered = await page.evaluate(() => window.NSO_MICROSCOPE.hoverInfo());
  await page.mouse.click(innerAim.px[0], innerAim.px[1]);
  await page.waitForTimeout(150);
  const soloed = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), sel = M.selection();
    const objs = new Set(sel.map((s) => s.obj));
    return { n: sel.length, objs: objs.size,
      want: d.segments.filter((g) => g.feature === 'Inner wall' && objs.has(g.obj)).length,
      onlyInner: sel.every((s) => s.feature === 'Inner wall'),
      exportShown: getComputedStyle(document.getElementById('ms-export-row')).display !== 'none' };
  });
  check('Features (only Inner wall on) + a real click: every Inner wall move of that piece and nothing else, Export offered',
    [soloed.n > 0, soloed.objs, soloed.n, soloed.onlyInner, soloed.exportShown, !!hovered && hovered.label === 'piece' && hovered.count === soloed.n],
    [true, 1, soloed.want, true, true, true]);
  check('and it is the piece\'s pick, isolated', await page.evaluate(() =>
    [window.NSO_MICROSCOPE.selectionSource(), window.NSO_MICROSCOPE.isIsolated()]), ['pick', true]);
  // Select shown (its button is gone, round 2c: selection is what's shown) is
  // selectVisible()'s: the identical set across every piece, not a second, required step.
  await page.evaluate(() => { const M = window.NSO_MICROSCOPE; M.back(); M.setMode('piece'); });
  await page.mouse.move(5, 450);
  await page.evaluate(() => window.NSO_MICROSCOPE.selectVisible());
  const feat = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), sel = M.selection();
    return { n: sel.length, want: d.parsed.moves.filter((m) => m.feature === 'Inner wall').length,
      onlyInner: sel.every((s) => s.feature === 'Inner wall'), by: M.selectionSource() };
  });
  check('Features checks (only Inner wall on) + selectVisible() takes every Inner wall move and nothing else',
    [feat.n, feat.onlyInner, feat.by], [feat.want, true, 'visible']);
  await shot(page, '09-feature-solo.png', 'one feature alone');
  const featBand = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    M.setZRange(5, 9); M.flushView(); M.selectVisible();
    const zs = d.zLevels;
    return { n: M.selection().length,
      want: d.parsed.moves.filter((m) => m.feature === 'Inner wall' && m.z >= zs[5] - 1e-6 && m.z <= zs[9] + 1e-6).length };
  });
  check('feature AND slider: exactly Inner wall inside the Z band', featBand.n, featBand.want);
  console.log(`       line: 1 move; feature: ${feat.n} moves; feature in 5 layers: ${featBand.n} moves`);
  check('none of the slice work touched the plate', await plateSnapshot(page), snap1);
  check('only the one STL asked for was written', downloads, dl1 + 1);

  // =======================================================================
  console.log('\n--- 5. Take band: the slider\'s range, as one piece ---');
  // =======================================================================
  // Crop Z's "Crop out band" became TAKE BAND, the card's Slice-side row
  // (docs/GSCOPE.md, item 5): the slider's range IS the band, isolated as one
  // piece to drag onto plate 2 or export. Nothing is cut out of anything, and
  // the mode is left as it was (round 2c: there is no Layer mode).
  const band = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    M.setSelectionMoves([]);
    if (M.isIsolated()) M.back();
    M.setZRange(10, 19); M.flushView();
    const zr = M.zRange(), mode = M.mode();
    const want = M.getDoc().segments.filter((s) => s.zi >= zr.lo && s.zi <= zr.hi && M.hidden().indexOf(s.feature) < 0).length;
    return { want, mode, models: state.models.length, read: document.getElementById('ms-band-read').textContent };
  });
  check('Take band says what the band holds', /the band: Z [\d.]+ - [\d.]+ mm, \d+ moves/.test(band.read), true);
  await page.click('#ms-btn-take-band');
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  const taken = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    return { iso: M.isIsolated(), n: M.selection().length, src: M.selectionSource(), mode: M.mode(),
             tris: M.geometry().attributes.position.count / 3, models: state.models.length };
  });
  check('Take band isolates exactly the moves the slider\'s range shows, as one selection (the mode left as it was)',
    [taken.iso, taken.n, taken.src, taken.mode], [true, band.want, 'range', band.mode]);
  check('...one piece: what Export would write is 12 triangles a move', taken.tris, band.want * 12);
  check('...and nothing reached the plate', taken.models, band.models);
  check('Take band did not touch the plate', await plateSnapshot(page), snap1);
  await shot(page, '10-take-band.png', 'the band, isolated as one piece');

  // =======================================================================
  console.log('\n--- the build ---');
  // =======================================================================
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);

  await browser.close();
  served.srv.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
