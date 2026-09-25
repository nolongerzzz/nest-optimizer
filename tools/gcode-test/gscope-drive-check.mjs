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
 *   2  CLEAR FROM VIEW IS VIEW ONLY. Clearing a plate piece, a picked line,
 *      soloing a feature, Isolate / Back and the slider change nothing on the
 *      plate: models, placement, raw meshes, undo stack - all compared before
 *      and after - and no download fires.
 *   3  LINE vs FEATURE ISOLATION. A real mouse click on a line picks THAT
 *      move and nothing else; its isolated solid and its exported STL are
 *      extrudeFlatLine's prism of that move, triangle for triangle. The
 *      legend's "only" + Select shown takes exactly one feature's moves, and
 *      with the slider, exactly that feature inside the Z band.
 *   4  THE LAYER-RANGE SLIDER. Real drags on both handles; one layer (exactly
 *      the moves NSOGcodeLines.movesAtZ finds), a chunk (the window moved
 *      with Shift+Arrow), everything (All). On a mesh document it clips.
 *   5  CROP THROUGH G-SCOPE, END TO END, through app-crop.js: a slice's
 *      isolated feature becomes a piece and has a Z band cropped out (height
 *      and volume exact, closed shells, two undo steps); a plate piece is
 *      cropped IN PLACE (canonical checker on the result, one undo reverts);
 *      and refusals leave the plate untouched.
 *   6  SCREENSHOTS of every visual claim, each asserted to be a drawn view.
 *
 * Usage:
 *   node tools/gcode-test/gscope-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat, mkdtemp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

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

function soupToSTL(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return b;
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
    scopeButtons: [...document.querySelectorAll('button')]
      .filter((b) => /\u{1F52C}/u.test(b.textContent)).map((b) => b.id),
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
  await page.click('#btn-clear').catch(() => {});
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
  await page.click('#ms-btn-clear-view');
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
  const firstRow = page.locator('#ms-legend .ms-legend-item').first();
  await firstRow.hover();
  await firstRow.locator('.ms-legend-only').click();
  await page.click('#ms-btn-select-visible');
  await page.click('#ms-btn-isolate');
  await page.click('#ms-btn-back');
  await page.click('#ms-btn-show-all');
  check('Show all brings the cleared piece back',
    await page.evaluate(() => [window.NSO_MICROSCOPE.hidden(), Object.values(window.NSO_MICROSCOPE.getView().overviewMeshes).every((m) => m.visible)]),
    [[], true]);
  check('after only / select shown / isolate / back / show all: the plate is still untouched',
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
  console.log('\n--- 5b. crop a plate piece IN PLACE, through the Crop tool ---');
  // =======================================================================
  await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, o = M.getDoc().objects[0], b = o.bounds;
    M.setZRange(0, M.zRange().steps - 1);
    M.clearBoxes();
    M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 10.2, 10.2);
  });
  // Refusal first: a band over the bottom is a trim.
  const refused = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, b = M.getDoc().objects[0].bounds;
    M.setZRangeMm(b.minZ, b.minZ + 5); M.flushView();
    const r = M.cropZBand();
    return { ok: r.ok, reason: r.reason, status: document.getElementById('status').textContent };
  });
  check('a band over the bottom is refused by name - that is a trim', [refused.ok, /trim - use Cut/.test(refused.reason)], [false, true]);
  check('and the refusal left the plate untouched', await plateSnapshot(page), snap0);

  const target = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, o = M.selection()[0], b = o.bounds;
    const p = state.placed[o.placedIndex];
    const m = state.models.find((mm) => mm.id === p.sourceId);
    M.setZRangeMm(b.minZ + 8, b.minZ + 12); M.flushView();
    return { id: m.id, name: o.name, h: b.maxZ - b.minZ, band: M.zRange().bandMm,
      rawLen: m.rawTris.length, read: document.getElementById('ms-crop-read').textContent,
      enabled: !document.getElementById('ms-btn-crop').disabled };
  });
  check('Crop is live and says what it will do', [target.enabled, /in place/.test(target.read)], [true, true]);
  await page.click('#ms-btn-crop');
  const inPlace = await page.evaluate((id) => {
    const M = window.NSO_MICROSCOPE, m = state.models.find((mm) => mm.id === id);
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < m.rawTris.length; i += 3) { lo = Math.min(lo, m.rawTris[i]); hi = Math.max(hi, m.rawTris[i]); }
    return {
      same: !!m, models: state.models.length, h: hi - lo,
      undo: state.undoStack[state.undoStack.length - 1].type,
      status: document.getElementById('status').textContent,
      open: M.isOpen(), source: M.getDoc().source,
      viewH: (() => { const o = M.getDoc().objects.find((x) => x.sourceId === id); return o.bounds.maxZ - o.bounds.minZ; })(),
      raw: Array.from(m.rawTris),
    };
  }, target.id);
  const bandH = target.band[1] - target.band[0];
  check('the SAME piece was edited - no new piece', [inPlace.same, inPlace.models], [true, 2]);
  check('shorter by exactly the band', Math.abs(inPlace.h - (target.h - bandH)) < 1e-3, true);
  check('committed by the Crop tool, with its own undo type', inPlace.undo, 'cropReplace');
  check('its status line is Crop\'s own', /^Crop done - removed Z/.test(inPlace.status), true);
  check('G-scope stayed open and re-read the plate', [inPlace.open, inPlace.source], [true, 'plate']);
  check('and shows the piece at its new height', Math.abs(inPlace.viewH - inPlace.h) < 1e-3, true);
  console.log(`       ${target.name}: ${target.h.toFixed(2)} mm -> ${inPlace.h.toFixed(2)} mm (band ${bandH.toFixed(2)} mm)`);
  const cubeStl = join(TMP, 'cube-cropped.stl');
  await writeFile(cubeStl, soupToSTL(inPlace.raw));
  const canon = JSON.parse(execFileSync('python3', [join(ROOT, 'tools', 'mesh_validate.py'), cubeStl, '--json']).toString());
  check('the canonical checker passes it: closed, manifold, consistently wound, no self-intersection',
    [canon.open_edges, canon.nonmanifold_edges, canon.inconsistent_winding_edges, canon.degenerate_tris,
      canon.self_intersection ? canon.self_intersection.pierce : 0], [0, 0, 0, 0, 0]);
  // Side-on, so the height difference between the cropped cube and its
  // untouched twin reads straight off the picture.
  await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    const box = new THREE.Box3();
    v.overviewGroup.children.forEach((c) => { c.geometry.computeBoundingBox(); box.union(c.geometry.boundingBox); });
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    v.controls.target.copy(c);
    v.camera.position.set(c.x, c.y, c.z + Math.max(size.x, size.y) * 2.2);
    v.controls.update();
  });
  await shot(page, '03-plate-piece-cropped-in-place.png', 'a plate piece cropped through G-scope');
  await page.click('#ms-close');
  await page.click('#btn-undo');
  check('one Undo gives the whole piece back',
    await page.evaluate((id) => state.models.find((m) => m.id === id).rawTris.length, target.id), target.rawLen);

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
    const want = d.segments.filter((s) => s.z >= r.zLo - 1e-6 && s.z <= r.zHi + 1e-6).length;
    return { lo: r.lo, hi: r.hi, steps: r.steps, shown: M.shownCount(), want, drawn: verts / 2, outside,
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

  // --- line-level: a REAL click on a line ---
  const LAYER = 10;
  await page.evaluate((L) => { const M = window.NSO_MICROSCOPE; M.setZRange(L, L); M.soloGroup('Outer wall'); M.flushView(); }, LAYER);
  await page.click('#ms-mode-line');
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
  await page.mouse.click(aim.px[0], aim.px[1]);
  const picked = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    return { sel: M.selection().map((s) => s.mv.index), by: M.selectionSource(),
      read: document.getElementById('ms-line-read').textContent,
      info: document.getElementById('ms-info').textContent };
  });
  check('a real click on a line picks exactly that move', picked.sel, [aim.idx]);
  check('as a line selection', picked.by, 'line');
  check('and the sidebar names it', new RegExp('Move ' + (aim.idx + 1) + ' - Outer wall').test(picked.info), true);
  await shot(page, '06-line-picked.png', 'one line picked and highlighted');

  // Step with the keyboard, the way the old Toolpath card did.
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

  // Isolate the line: that one move alone, as-is - its line, nothing else.
  await page.click('#ms-btn-isolate-line');
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

  // Close inspection on it: its extrudeFlatLine prism, highlighted in context.
  await page.click('#ms-cam-close');
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
  check('Close inspection highlights the one line as ONE solid', lineIso.kinds, ['Mesh']);
  check('12 triangles - one prism, one move', [lineIso.tris, lineIso.wantTris], [12, 12]);
  check('and it IS extrudeFlatLine\'s prism of that move, to the micron', lineIso.maxErr < 1e-3, true);
  check('with the rest of the part drawn round it', [lineIso.overview, lineIso.badge], [true, 'Close inspection (isolated)']);
  await shot(page, '07b-line-close-inspection.png', 'the same line in Close inspection, its printed prism in context');
  await page.click('#ms-cam-normal');

  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#ms-btn-export-stl')]);
  const lineStl = join(TMP, 'line.stl');
  await dl.saveAs(lineStl);
  const lineTris = stlTriangles(await readFile(lineStl));
  const wantLine = await page.evaluate((idx) => window.NSOGcodeLines.extrudeFlatLine(window.NSO_MICROSCOPE.getDoc().parsed.moves[idx], []), aim.idx);
  check('the exported line is that prism, triangle for triangle',
    lineTris.length === 12 && lineTris.every((t, i) => t.every((v, k) => Math.abs(v - wantLine[i * 9 + k]) < 1e-4)), true);
  await page.click('#ms-btn-back');

  // Clear that one line from view: view only.
  await page.click('#ms-btn-clear-view');
  const lineCleared = await page.evaluate((idx) => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    const drawn = Object.values(v.overviewMeshes).some((m) => (m.userData.segs || []).some((s) => s.mv.index === idx));
    return { cleared: M.cleared(), drawn, shown: M.shownCount() };
  }, aim.idx);
  check('Clear from view takes the picked line out of the drawing', [lineCleared.cleared, lineCleared.drawn], [[aim.idx], false]);
  check('one fewer line shown', lineCleared.shown, aim.n - 1);
  await shot(page, '08-line-cleared.png', 'a line cleared from view');

  // Feature-level: the legend's "only", then Select shown.
  await page.click('#ms-btn-show-all');
  await page.click('#ms-zr-all');
  const inner = page.locator('#ms-legend .ms-legend-item[data-group="Inner wall"]');
  await inner.hover();
  await inner.locator('.ms-legend-only').click();
  await page.click('#ms-btn-select-visible');
  const feat = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), sel = M.selection();
    return { n: sel.length, want: d.parsed.moves.filter((m) => m.feature === 'Inner wall').length,
      onlyInner: sel.every((s) => s.feature === 'Inner wall'), by: M.selectionSource() };
  });
  check('"only" + Select shown takes every Inner wall move and nothing else',
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
  console.log('\n--- 5a. crop a slice through G-scope, end to end ---');
  // =======================================================================
  // Refused first: a selection that sits wholly inside the band.
  const refusedSlice = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    const before = state.models.length;
    const r = M.cropZBand();
    return { ok: r.ok, reason: r.reason, added: state.models.length - before };
  });
  check('a selection wholly inside the band is refused, and nothing reaches the plate',
    [refusedSlice.ok, refusedSlice.added], [false, 0]);
  check('refusal left the plate untouched', await plateSnapshot(page), snap1);

  // The real one: the whole Outer wall, band layers 10..19 cropped out.
  const plan = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    M.setZRange(0, M.zRange().steps - 1); M.flushView();
    M.soloGroup('Outer wall'); M.flushView();
    M.selectVisible();
    const sel = M.selection();
    M.setZRange(10, 19); M.flushView();
    const band = M.zRange().bandMm;
    const G = window.NSOGcodeLines;
    const vol = (mvs) => mvs.reduce((a, s) => a + NSO_cropVolume(new Float32Array(G.extrudeFlatLine(s.mv, []))), 0);
    const kept = sel.filter((s) => !(s.z > band[0] + 1e-6 && s.z <= band[1] + 1e-6));
    let lo = Infinity, hi = -Infinity;
    sel.forEach((s) => { lo = Math.min(lo, s.z - s.mv.height); hi = Math.max(hi, s.z); });
    return { n: sel.length, band, keptVol: vol(kept), h: hi - lo, models: state.models.length,
      undo: state.undoStack.length, read: document.getElementById('ms-crop-read').textContent };
  });
  check('Crop says it will make a new piece from the selection', /as a new piece on the plate/.test(plan.read), true);
  await page.click('#ms-btn-crop');
  await page.waitForFunction((n) => state.models.length === n, plan.models + 1, { timeout: 30000 });
  const cropped = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < m.rawTris.length; i += 3) { lo = Math.min(lo, m.rawTris[i]); hi = Math.max(hi, m.rawTris[i]); }
    const ins = NSO_Repair.inspect(m.rawTris, { selfIntersections: false });
    return { name: m.name, h: hi - lo, vol: NSO_cropVolume(m.rawTris), open: ins.openEdges,
      undo: state.undoStack.slice(-2).map((u) => u.type), placed: state.placed.some((p) => p.sourceId === m.id),
      scope: window.NSO_MICROSCOPE.isOpen(), status: document.getElementById('status').textContent,
      rawLen: m.rawTris.length };
  });
  const bandMm = plan.band[1] - plan.band[0];
  check('the isolated feature is on the plate as a real piece', cropped.placed, true);
  check('shorter by exactly the band', Math.abs(cropped.h - (plan.h - bandMm)) < 1e-3, true);
  check('holding exactly the volume of the beads outside the band',
    Math.abs(cropped.vol - plan.keptVol) <= 1e-4 * plan.keptVol, true);
  check('closed: no open edge anywhere', cropped.open, 0);
  check('two undo steps: the piece, then the Crop tool\'s own commit', cropped.undo, ['addModels', 'cropReplace']);
  check('Crop\'s status line, and G-scope handed the plate back',
    [/^Crop done - removed Z/.test(cropped.status), cropped.scope], [true, false]);
  console.log(`       ${cropped.name}: ${plan.h.toFixed(2)} -> ${cropped.h.toFixed(2)} mm, ` +
    `band ${plan.band.map((z) => z.toFixed(2)).join('..')} mm, ${cropped.rawLen / 9} triangles`);
  await page.evaluate(() => { if (typeof frameAllModels === 'function') frameAllModels(); });
  await shot(page, '10-slice-crop-on-the-plate.png', 'the cropped slice piece on the plate', 'main');

  // And it can be looked at again in G-scope, as a plate piece.
  await page.click('#btn-microscope');
  await page.click('#ms-btn-plate');
  const back = await page.evaluate((name) => {
    const d = window.NSO_MICROSCOPE.getDoc();
    const o = d.objects.find((x) => x.name === name);
    return o ? o.bounds.maxZ - o.bounds.minZ : null;
  }, cropped.name);
  check('read back off the plate at its cropped height', back != null && Math.abs(back - cropped.h) < 1e-3, true);
  await shot(page, '11-cropped-piece-in-gscope.png', 'the cropped piece, back under G-scope');
  await page.click('#ms-close');
  await page.click('#btn-undo');
  check('first Undo reverts the crop',
    await page.evaluate(() => state.models[state.models.length - 1].rawTris.length), plan.n * 12 * 9);
  await page.click('#btn-undo');
  check('second Undo takes the piece away', await page.evaluate(() => state.models.length), plan.models);

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
