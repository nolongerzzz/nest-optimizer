#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / microscope-overlay-drive-check.mjs
 *
 * The microscope as an OVERLAY, driven through the real app in headless
 * Chromium - and the two claims that are only worth anything in pixels.
 *
 * microscope-drive-check.mjs proves the FILE routes: Import a slice, an STL, a
 * 3MF, select, isolate, export. It never asks the question this file asks,
 * because until now the view could not be asked it:
 *
 *   1  THE BUTTON ACTS ON THE PLATE, like X-ray. Something is on the plate;
 *      the rail button puts it under the lens with no file dialog in the way,
 *      it is a mesh document whose source is the plate, and the plate itself
 *      is not touched, moved or replaced while you look at it.
 *   2  IT IS NOT GATED TO G-CODE. The piece driven here is a plain STL - no
 *      slicer, no features, no layers anywhere near it.
 *   3  ISOLATION AND BOTH EXPORTS STILL WORK from that source. A capture box
 *      over a plate piece, Isolate, and then Export to plate / Export as STL
 *      writing the SAME triangles - the dissection-to-usable-object path,
 *      unchanged by where the document came from.
 *   4  A `.gcode.3mf` IMPORT LANDS HERE BY ITSELF. Through the app's own
 *      Import button and a real file chooser, with nothing else pressed: the
 *      microscope is open on it, coloured per slicer feature, when the import
 *      settles.
 *   5  A PLATE OF FEATURES READS BACK AS FEATURES. After that import the
 *      plate holds one piece per slicer feature, so reading the plate gives
 *      feature-named, feature-coloured groups - and the support interface
 *      comes out on its own, with none of the model's walls or infill in it.
 *      That is the support-isolation library's first step, taken with the
 *      shipped controls and nothing written for it.
 *   6  SCREENSHOTS. Four, of the real canvas, each asserted to be a drawn 3D
 *      view and not a blank panel, because this feature's whole history is
 *      claims that did not survive being looked at.
 *
 * Usage:
 *   node tools/gcode-test/microscope-overlay-drive-check.mjs
 *   CHROME_PATH=/path/to/chrome node tools/gcode-test/microscope-overlay-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();

const PLAIN_STL = 'library/box_closed.stl';          // a piece with no G-code anywhere near it
const SECOND_STL = 'fixtures/box-20mm.stl';          // a second one, for unique naming
// 2,895 moves over 50 layers, ten slicer features, one of them the support
// INTERFACE - which is one of the three shapes the isolation library wants
// (a branch, a web, a whole interface layer), and the one this file has.
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const SHOTS = join(ROOT, 'tools', 'scope-overlay-out');

/** Triangles out of a binary STL, as flat [x,y,z] * 3 per triangle. */
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

/**
 * Put a file on the plate through the app's own file handler.
 * (The Import BUTTON and its chooser are driven for real further down, where
 * the claim under test is about the import route itself.)
 */
async function plate(page, relPath, name) {
  const bytes = Array.from(await readFile(join(ROOT, relPath)));
  const before = await page.evaluate(() => state.models.length);
  await page.evaluate(([b, n]) => handleFiles([new File([new Uint8Array(b)], n)]), [bytes, name]);
  await page.waitForFunction((n) => state.models.length === n, before + 1, { timeout: 30000 });
}

/**
 * Screenshot the microscope's own canvas, and prove it is a DRAWN view: a
 * blank or single-colour grab is the exact failure a screenshot is supposed
 * to catch, so the pixels are counted rather than trusted.
 */
async function shot(page, file, label) {
  // A couple of animation frames, so the grab is of a rendered frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const path = join(SHOTS, file);
  await page.locator('#microscope').screenshot({ path });
  // The canvas has no preserveDrawingBuffer, so drawImage() off it reads
  // blank - which is a fact about the readback, not about the picture, and
  // asserting on it would fail a view that is drawing perfectly. readPixels
  // in the SAME task as the render reads the back buffer before it is
  // presented, which is the frame that was just drawn.
  const colours = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    if (!v) return null;
    v.renderer.render(v.scene, v.camera);
    const gl = v.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const seen = new Set();
    let lit = 0;
    for (let i = 0; i < px.length; i += 4 * 97) {
      seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
      // The view's own background is 0x0d0f13; anything brighter is drawn.
      if (px[i] > 0x20 || px[i + 1] > 0x20 || px[i + 2] > 0x20) lit++;
    }
    return { distinct: seen.size, lit: lit, w: w, h: h };
  });
  const size = (await stat(path)).size;
  check(`${label}: the canvas is a drawn 3D view, not a blank panel`,
    !!(colours && colours.distinct > 8 && colours.lit > 20 &&
       colours.w > 400 && colours.h > 300), true);
  check(`${label}: the screenshot is a real PNG on disk`, size > 5000, true);
  console.log(`       ${file}  ${colours.w}x${colours.h} canvas, ` +
    `${colours.distinct} distinct sampled colours, ${colours.lit} lit samples, ` +
    `${(size / 1024).toFixed(0)} kB`);
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  gscopeCards.install(page);
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_MICROSCOPE, null, { timeout: 30000 });

  // =======================================================================
  console.log('\n--- X-ray\'s pattern, read off the two buttons ---');
  // =======================================================================
  // The interaction this feature was asked to copy, stated as a check so a
  // change to either side shows up here.
  // Shell v2: the rail is gone. Both are in the left column now - G-scope a
  // slab of the print group, X-ray the X in the view row pinned under it.
  const rail = await page.evaluate(() => ['btn-xray', 'btn-microscope'].map((id) => {
    const el = document.getElementById(id);
    return { id, col: !!el.closest('.vp-shell-col'), slab: el.classList.contains('vp-bar-btn') };
  }));
  check('both are buttons in the shell\'s left column',
    rail.map((b) => b.col && b.slab), [true, true]);
  check('X-ray takes no file and asks for none - it is a plain toggle, no file input beside it',
    await page.evaluate(() => {
      const x = document.getElementById('btn-xray');
      return !x.closest('.vp-shell-view').querySelector('input[type=file]');
    }), true);

  // =======================================================================
  console.log('\n--- a piece with no G-code anywhere near it ---');
  // =======================================================================
  await plate(page, PLAIN_STL, 'box_closed.stl');
  const onPlate = await page.evaluate(() => ({
    models: state.models.length,
    placed: state.placed.length,
    undo: state.undoStack.length,
    name: state.placed[0].name,
    pos: [state.placed[0].mesh.position.x, state.placed[0].mesh.position.y, state.placed[0].mesh.position.z],
  }));
  check('one plain STL is on the plate', [onPlate.models, onPlate.placed], [1, 1]);
  check('the panel is shut', await page.isVisible('#microscope'), false);

  // The whole claim of Task 2, in one click: no chooser, no navigation.
  const chooser = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
  await page.click('#btn-microscope');
  const askedForAFile = await chooser;
  check('the rail button opens the view with NO file dialog in the way',
    !!askedForAFile, false);
  check('the panel is up', await page.isVisible('#microscope'), true);
  check('and the button is lit, the way X-ray lights',
    /is-on/.test(await page.getAttribute('#btn-microscope', 'class') || ''), true);

  const plateDoc = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    return {
      kind: d.kind, source: d.source, name: d.name,
      objects: d.objects.length,
      groups: M.groups(),
      tris: d.objects[0].triangles,
      layers: M.layerCount(),
      drawn: [...new Set(v.overviewGroup.children.map((c) => c.type))],
      legend: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      sub: document.getElementById('ms-sub').textContent,
      legendTitle: document.getElementById('ms-legend-title').textContent,
      legendNotes: Array.from(document.querySelectorAll('#ms-legend .ms-legend-note')).map((n) => n.textContent),
      bounds: d.objects[0].bounds,
    };
  });
  check('what is under the lens is the PLATE, not a file', plateDoc.source, 'plate');
  check('read as a mesh document, the same kind an STL makes', plateDoc.kind, 'mesh');
  check('one group for the one piece on the plate', plateDoc.objects, 1);
  check('named for the piece, as the plate names it', plateDoc.groups, [onPlate.name]);
  check('drawn as a whole part', plateDoc.drawn, ['Mesh']);
  // (Parts rows are gone: a mesh document has no line types, so the Features
  // list holds no row for the piece - it is chosen in Piece mode instead.)
  check('the Features list has no row for it, just the "Not sliced" note',
    [plateDoc.legend, plateDoc.legendNotes], [0, ['Not sliced - no line types.']]);
  check('the header says it is the plate, as it stands',
    /plate as it stands/i.test(plateDoc.sub), true);
  check('and says how many pieces and triangles', /1 piece, \d+ triangles/.test(plateDoc.sub), true);
  check('it claims no layers, because a plate piece has none', plateDoc.layers, 0);
  check('the legend is the Features list and invents no features for a plate piece',
    [plateDoc.legendTitle, plateDoc.legend], ['Features', 0]);

  // Geometry, not a picture of it: the piece read off the plate must be the
  // piece that is on the plate, in the file's own Z-up millimetres, standing
  // on the bed at the hover placeModelMovable() gives it.
  const space = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc(), p = state.placed[0];
    const b = d.objects[0].bounds;
    return {
      zMin: b.minZ,
      height: b.maxZ - b.minZ,
      plateHeight: p.height,
      width: b.maxX - b.minX,
      plateWidth: p.width,
      tris: d.objects[0].triangles,
      plateTris: p.mesh.geometry.attributes.position.count / 3,
    };
  });
  check('it is the same triangle count the plate piece has', space.tris, space.plateTris);
  check('the same size, so nothing was scaled on the way in',
    [Math.abs(space.height - space.plateHeight) < 1e-3,
     Math.abs(space.width - space.plateWidth) < 1e-3], [true, true]);
  check('and it stands on the bed - Z up, z=0 is the plate',
    Math.abs(space.zMin - 0.3) < 0.05, true);

  // An overlay, not a route: the plate is exactly as it was left.
  const during = await page.evaluate(() => ({
    models: state.models.length,
    placed: state.placed.length,
    undo: state.undoStack.length,
    name: state.placed[0].name,
    pos: [state.placed[0].mesh.position.x, state.placed[0].mesh.position.y, state.placed[0].mesh.position.z],
    mainCanvasStillThere: !!document.querySelector('#viewport canvas'),
  }));
  check('looking changed nothing on the plate',
    [during.models, during.placed, during.undo, during.name],
    [onPlate.models, onPlate.placed, onPlate.undo, onPlate.name]);
  check('the piece did not move', during.pos, onPlate.pos);
  check('and the main viewport is still there underneath, not torn down',
    during.mainCanvasStillThere, true);

  await shot(page, '1-overlay-on-a-plain-stl.png', 'overlay on a non-G-code piece');

  // =======================================================================
  console.log('\n--- the lens: a capture box over a plate piece, and Isolate ---');
  // =======================================================================
  const boxed = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, b = M.getDoc().objects[0].bounds;
    const mid = (a, z) => (a + z) / 2;
    M.clearBoxes();
    M.addBoxAt(mid(b.minX, b.maxX) + 1e6, mid(b.minY, b.maxY), mid(b.minZ, b.maxZ), 5, 5);
    const miss = M.selection().length;
    M.clearBoxes();
    M.addBoxAt(mid(b.minX, b.maxX), mid(b.minY, b.maxY), mid(b.minZ, b.maxZ), 60, 60);
    const hit = M.selection();
    return {
      miss,
      hit: hit.length,
      names: hit.map((o) => o.name),
      label: M.exportLabel(),
      tris: M.geometry().attributes.position.count / 3,
      exportRow: !document.getElementById('ms-export-row').style.display.includes('none'),
    };
  });
  check('a box nowhere near the piece catches nothing', boxed.miss, 0);
  check('a box over it catches it', boxed.hit, 1);
  check('named as the plate names it', boxed.names, [onPlate.name]);
  check('the export is the whole piece, triangle for triangle', boxed.tris, plateDoc.tris);
  check('and the label is the piece\'s own name, not "Plate - " and it again',
    boxed.label, onPlate.name);
  check('the export row came up with the selection', boxed.exportRow, true);

  // The box controls - Isolate all boxes, Clear all boxes - are under Click
  // to select region, and G-scope opens in Piece: arm it, as a user does.
  await page.click('#ms-mode-select');
  await page.click('#ms-btn-isolate');
  const isolated = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    return {
      detail: v.detailGroup.visible,
      overview: v.overviewGroup.visible,
      badge: document.getElementById('ms-mode-badge').textContent,
      drawn: [...new Set(v.detailGroup.children.map((c) => c.type))],
    };
  });
  check('Isolate shows the selection alone', [isolated.detail, isolated.overview], [true, false]);
  check('drawn as the solid it is', isolated.drawn, ['Mesh']);
  check('and the badge counts what is on screen', isolated.badge, 'Detail: 1 object(s)');
  await shot(page, '2-isolated-plate-piece.png', 'a plate piece isolated');
  await page.click('#ms-btn-back');
  check('Back returns the whole plate',
    await page.evaluate(() => window.NSO_MICROSCOPE.getView().overviewGroup.visible), true);

  // =======================================================================
  console.log('\n--- Export as STL and Export to plate, from a PLATE document ---');
  // =======================================================================
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#ms-btn-export-stl'),
  ]);
  const stlPath = join(SHOTS, 'exported-selection.stl');
  await dl.saveAs(stlPath);
  const written = stlTriangles(await readFile(stlPath));
  check('Export as STL writes the selection to a real file', written.length, boxed.tris);
  check('the panel stayed open - a download is not a way out',
    await page.isVisible('#microscope'), true);

  const beforeExport = await page.evaluate(() => ({
    models: state.models.length, placed: state.placed.length, undo: state.undoStack.length,
  }));
  await page.click('#ms-btn-export-plate');
  const afterExport = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return {
      models: state.models.length, placed: state.placed.length, undo: state.undoStack.length,
      name: m.name, tris: m.geometry.attributes.position.count / 3,
      rawAxis: m.rawAxis, hasRaw: !!(m.rawTris && m.rawTris.length),
      open: !document.getElementById('microscope').hidden,
      said: document.getElementById('status').textContent,
    };
  });
  check('Export to plate lands one new piece', afterExport.models, beforeExport.models + 1);
  check('as a real object on the plate', afterExport.placed, beforeExport.placed + 1);
  check('with one undo entry behind it', afterExport.undo, beforeExport.undo + 1);
  check('through the ordinary ingest path, raw soup and all',
    [afterExport.rawAxis, afterExport.hasRaw], ['zup', true]);
  check('carrying the selection\'s name', afterExport.name, boxed.label);
  check('and the view hands the main viewport back', afterExport.open, false);
  check('the app said so', /Export to plate ok/.test(afterExport.said), true);

  const sameBytes = await page.evaluate(() => Array.from(state.models[state.models.length - 1].rawTris))
    .then((raw) => written.length * 9 === raw.length &&
      written.every((t, i) => t.every((v, k) => Math.abs(v - raw[i * 9 + k]) < 1e-3)));
  check('both doors wrote the SAME triangles', sameBytes, true);

  await page.click('#btn-undo');
  check('one Undo takes the extracted piece back',
    await page.evaluate(() => [state.models.length, state.placed.length]),
    [beforeExport.models, beforeExport.placed]);

  // =======================================================================
  console.log('\n--- two pieces on the plate, and re-reading it ---');
  // =======================================================================
  await plate(page, SECOND_STL, 'box_closed.stl');     // the SAME name, deliberately
  await page.click('#btn-microscope');
  const two = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    return { source: d.source, objects: d.objects.length, groups: M.groups().sort(),
             legend: document.querySelectorAll('#ms-legend .ms-legend-item').length,
             notes: document.querySelectorAll('#ms-legend .ms-legend-note').length };
  });
  check('the button re-reads the plate every time it opens it', two.objects, 2);
  check('and it is still the plate, not a stale file', two.source, 'plate');
  // (No legend rows for plate pieces any more; the unique-name rule is read
  // off the document's groups, which is what the rows used to list.)
  check('two plate pieces make no line-type rows, only the one note', [two.legend, two.notes], [0, 1]);
  check('two pieces of one name stay two groups, not one: the second is made unique rather than folded into the first',
    two.groups, ['box_closed', 'box_closed #2']);

  await page.click('#ms-close');
  check('Close puts the main viewport back', await page.isVisible('#microscope'), false);
  check('with both pieces still on it',
    await page.evaluate(() => state.placed.length), 2);

  // =======================================================================
  console.log('\n--- a .gcode.3mf, through the app\'s OWN Import button ---');
  // =======================================================================
  // No microscope button is pressed anywhere in this block. The claim is that
  // importing a slice IS the way into this view.
  const before3mf = await page.evaluate(() => state.models.length);
  // The app's own import control, and the input it drives - the route a
  // dropped file and the From File button both end in. Set for real, so
  // `handleFiles()` runs off a real change event and nothing is called by
  // name from the outside.
  const importUI = await page.evaluate(() => {
    const b = document.getElementById('btn-load-stl');
    const i = document.getElementById('file-input');
    return { btn: !!b, type: i && i.type, accept: i && i.getAttribute('accept') };
  });
  check('the app\'s From File control drives a real .3mf-accepting input',
    [importUI.btn, importUI.type, importUI.accept], [true, 'file', '.stl,.3mf']);
  await page.setInputFiles('#file-input', join(ROOT, SLICE));
  await page.waitForFunction(
    () => window.NSO_MICROSCOPE.isOpen() &&
          (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath',
    null, { timeout: 60000 });

  const landed = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    const G = window.NSOGcodeLines;
    return {
      kind: d.kind, name: d.name,
      moves: d.segments.length, layers: M.layerCount(),
      groups: M.groups().sort(),
      hidden: M.hidden(),
      drawn: [...new Set(v.overviewGroup.children.map((c) => c.type))],
      coloured: v.overviewGroup.children.every(
        (c) => c.material.color.getHex() === G.colorForFeature(c.userData.feature)),
      layerBtn: !document.getElementById('ms-btn-layer-select').disabled,
      models: state.models.length,
      oldDoor: typeof window.NSO_TOOLPATH,
    };
  });
  check('importing a .gcode.3mf lands in the microscope - no button pressed',
    landed.kind, 'toolpath');
  check('on the file that was imported', landed.name, 'supportwithinsupport.gcode.3mf');
  check('with its real moves and layers', [landed.moves, landed.layers], [2895, 50]);
  check('coloured by the slicer\'s own feature table, every group of it',
    landed.coloured, true);
  check('drawn the reference tool\'s way (one LineSegments per feature, plus nothing else)',
    landed.drawn, ['LineSegments']);
  check('Travel off by default, as the reference tool has it', landed.hidden, ['Travel']);
  check('whole-layer selection is live, because this one really is sliced',
    landed.layerBtn, true);
  check('the support interface is one of the groups it found',
    landed.groups.includes('Support interface'), true);
  // G-scope is the one G-code tool: a slice is looked THROUGH, and nothing
  // reaches the plate until Export or Crop says so.
  check('and NOTHING was put on the plate by the import', landed.models, before3mf);
  check('the old plate-side toolpath importer is gone', landed.oldDoor, 'undefined');
  await shot(page, '3-gcode-3mf-import-lands-here.png', 'a .gcode.3mf import, unassisted');

  // =======================================================================
  console.log('\n--- support, alone: feature isolation, with shipped controls ---');
  // =======================================================================
  // The support interface out of the slice on its own, through soloGroup (the
  // old legend "only" button's job; a row click now isolates instead) and Select shown - no box, nothing written for it - then
  // onto the plate as an ordinary piece, and read back off the plate in the
  // slicer's own colour for it.
  check('the Support interface row is in the Features list',
    await page.locator('#ms-legend .ms-legend-item[data-group="Support interface"]').count(), 1);
  check('soloGroup takes the support interface', await page.evaluate(() =>
    window.NSO_MICROSCOPE.soloGroup('Support interface')), true);
  await page.click('#ms-btn-select-visible');
  const supportOnly = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const sel = M.selection();
    return {
      hidden: M.hidden().sort(),
      n: sel.length,
      want: d.segments.filter((s) => s.feature === 'Support interface').length,
      isSupportOnly: sel.length > 0 && sel.every((s) => s.feature === 'Support interface'),
      tris: M.geometry().attributes.position.count / 3,
      label: M.exportLabel(),
    };
  });
  check('soloGroup leaves the support interface as the one group shown',
    supportOnly.hidden.includes('Support interface'), false);
  check('Select shown takes it and nothing else - no walls, no infill',
    supportOnly.isSupportOnly, true);
  check('every support interface move, all of them', supportOnly.n, supportOnly.want);
  check('and what comes out is 12 triangles per move', supportOnly.tris, supportOnly.n * 12);
  console.log(`       ${supportOnly.label}: ${supportOnly.tris} triangles`);

  // The box controls - Isolate all boxes, Clear all boxes - are under Click
  // to select region, and G-scope opens in Piece: arm it, as a user does.
  await page.click('#ms-mode-select');
  await page.click('#ms-btn-isolate');
  check('and it isolates on screen as one body',
    await page.evaluate(() => {
      const v = window.NSO_MICROSCOPE.getView();
      return [v.detailGroup.visible, v.detailGroup.children.length];
    }), [true, 1]);
  await shot(page, '4-support-isolated-from-the-model.png',
    'support geometry alone, out of the slice');

  const supportBefore = await page.evaluate(() => state.models.length);
  await page.click('#ms-btn-export-plate');
  check('and it goes onto the plate as its own piece',
    await page.evaluate(() => state.models.length), supportBefore + 1);
  check('carrying the feature\'s name with it',
    await page.evaluate(() => state.models[state.models.length - 1].name), supportOnly.label);

  // The rail button reopens the slice that is still loaded; the sidebar's
  // "Read the plate" is the way from a file back to the plate.
  await page.click('#btn-microscope');
  check('the rail button reopens G-scope on the slice it left',
    await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().kind), 'toolpath');
  await page.click('#ms-btn-plate');
  const fromPlate = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView(), G = window.NSOGcodeLines;
    const name = M.groups().find((n) => /Support interface/.test(n));
    return {
      source: M.getDoc().source,
      name,
      colour: name ? v.overviewMeshes[name].material.color.getHex() : null,
      want: G.colorForFeature('Support interface'),
    };
  });
  check('reading the plate back finds it by the slicer\'s name', !!fromPlate.name, true);
  check('the source is the plate', fromPlate.source, 'plate');
  check('and it wears the slicer\'s own colour for it, not a palette slot',
    fromPlate.colour, fromPlate.want);

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
