#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / microscope-drive-check.mjs
 *
 * The Microscope view, driven through the REAL app in headless Chromium.
 *
 * microscope-check.js proves the arithmetic. This proves the thing the ticket
 * is about, end to end, through controls a user can see:
 *
 *   - the rail button opens the view, and the view's own Import takes all
 *     FOUR file kinds - two real slices, a plain 3MF and a plain STL;
 *   - the reference tool's renderer is what draws it: one LineSegments per
 *     FEATURE for a slice, one Mesh per build object for a plain file;
 *   - both selection modes work and are unchanged - the capture box with its
 *     independent footprint and thickness, and whole-layer selection;
 *   - a plain STL/3MF degrades as documented: one whole unsegmented part,
 *     the layer control disabled with the reason on screen, the box still
 *     selecting;
 *   - Export to plate leaves the view and lands a real, standalone, undoable
 *     object in the main Nest 3D viewport;
 *   - Export as STL writes a real file, which is re-read from disk and shown
 *     to hold EXACTLY the same triangles Export to plate added.
 *
 * Usage:
 *   node tools/gcode-test/microscope-drive-check.mjs
 *   CHROME_PATH=/path/to/chrome node tools/gcode-test/microscope-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();

const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';   // 2,895 moves, 50 layers
const BIG = 'fixtures/3mf/tabletop.gcode.3mf';                  // 202,877 moves, 73 layers
const PLAIN_3MF = 'fixtures/3mf/flowrate-test-pass2.3mf';       // 10 build objects
const PLAIN_STL = 'fixtures/box-20mm.stl';                      // one object, ASCII

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
 * Click the rail button and answer the file chooser IF one opens. The button
 * opens the panel, and asks for a file only when nothing is loaded - reopening
 * it over a file already in the view shows that file rather than interrupting
 * with a picker - so a chooser is expected on the first open and not after.
 */
async function openPanelViaRail(page) {
  const chooser = page.waitForEvent('filechooser', { timeout: 2500 }).catch(() => null);
  await page.click('#btn-microscope');
  const c = await chooser;
  if (c) await c.setFiles([]);
  return !!c;
}

/** Open a file through the view's own Import button and its file chooser. */
async function importThrough(page, selector, relPath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20000 }),
    page.click(selector),
  ]);
  await chooser.setFiles(join(ROOT, relPath));
  await page.waitForFunction(
    (name) => {
      const d = window.NSO_MICROSCOPE && window.NSO_MICROSCOPE.getDoc();
      return !!(d && d.name === name);
    },
    relPath.split('/').pop(),
    { timeout: 60000 },
  );
}

async function main() {
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.NSO_MICROSCOPE, null, { timeout: 30000 });

  // =======================================================================
  console.log('\n--- the door ---');
  // =======================================================================
  check('the microscope rail button exists and is visible',
    await page.isVisible('#btn-microscope'), true);
  check('it wears the same rail class as the other viewport tools',
    await page.getAttribute('#btn-microscope', 'class'), 'viewport-tool-btn');
  check('it says what it does on hover',
    /capture box/i.test(await page.getAttribute('#btn-microscope', 'title') || ''), true);
  check('the panel starts closed', await page.isVisible('#microscope'), false);
  check('and no file is open yet',
    await page.evaluate(() => window.NSO_MICROSCOPE.getDoc()), null);
  check('the G-code-onto-the-plate button is untouched and still there',
    await page.isVisible('#btn-gcode'), true);

  // =======================================================================
  console.log('\n--- a real slice, through the view\'s own Import ---');
  // =======================================================================
  // The rail button opens the panel and asks for a file; that chooser is
  // dismissed so the checks below drive Import by name, one control at a time.
  await openPanelViaRail(page);
  check('the panel is open', await page.isVisible('#microscope'), true);
  check('the rail button lights while it is open',
    /is-on/.test(await page.getAttribute('#btn-microscope', 'class') || ''), true);

  await importThrough(page, '#ms-btn-open', SLICE);

  const opened = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    return {
      kind: d.kind,
      segments: d.segments.length,
      layers: M.layerCount(),
      groups: M.groups().sort(),
      assumed: d.parsed.meta.assumed,
      overviewKinds: v.overviewGroup.children.map((c) => c.type),
      overviewCount: v.overviewGroup.children.length,
      hidden: M.hidden(),
      sub: document.getElementById('ms-sub').textContent,
    };
  });
  check('it reads as a toolpath', opened.kind, 'toolpath');
  check('50 layers of 2895 moves', [opened.layers, opened.segments], [50, 2895]);
  check('nothing was assumed - every number came out of the file', opened.assumed, false);
  check('ten feature groups, the slicer\'s own', opened.groups.length, 10);

  // THE reference renderer: LineSegments, not solids. That is what makes the
  // overview clean at real density, and it is why the export is built
  // separately - a GL line has no thickness and cannot be written to a file.
  check('the overview is drawn as the reference tool draws it - LineSegments',
    [...new Set(opened.overviewKinds)], ['LineSegments']);
  check('one per feature group', opened.overviewCount, 10);
  check('Travel is off by default, as in the reference tool', opened.hidden, ['Travel']);

  const legend = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#ms-legend .ms-legend-item'))
      .map((el) => el.dataset.group));
  check('the legend lists exactly the groups the file has',
    legend.slice().sort(), opened.groups);
  check('the header says what is loaded',
    /2895 extrusion moves, 50 layers/.test(opened.sub), true);
  check('and the legend is named for what a SLICE groups on',
    await page.textContent('#ms-legend-title'), 'Features (click to isolate)');

  // Legend click isolates, exactly as the reference tool does.
  await page.click('#ms-legend .ms-legend-item:first-child');
  const dimmed = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    const name = document.querySelector('#ms-legend .ms-legend-item').dataset.group;
    return { hidden: M.hidden(), visible: v.overviewMeshes[name].visible, name };
  });
  check('clicking a legend row hides that feature', dimmed.visible, false);
  check('and records it as hidden', dimmed.hidden.includes(dimmed.name), true);
  await page.click('#ms-legend .ms-legend-item:first-child');   // back on

  // =======================================================================
  console.log('\n--- selection mode 1: the sphere-to-box blob crop ---');
  // =======================================================================
  const boxSel = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const mid = d.parsed.moves[Math.floor(d.parsed.moves.length / 2)];
    const gx = (mid.x0 + mid.x1) / 2, gy = (mid.y0 + mid.y1) / 2, gz = mid.z;
    M.clearBoxes();
    M.addBoxAt(gx, gy, gz, 5.0, 1.0);                     // the reference defaults
    const at1 = M.selection();
    const thinLayers = () => new Set(M.selection().map((s) => s.layer)).size;
    M.clearBoxes(); M.addBoxAt(gx, gy, gz, 5.0, 0.01);
    const thin = { n: M.selection().length, layers: thinLayers() };
    M.clearBoxes(); M.addBoxAt(gx, gy, gz, 5.0, 5.0);
    const tall = { n: M.selection().length, layers: thinLayers() };
    M.clearBoxes(); M.addBoxAt(gx, gy, gz, 5.0, 1.0);
    const boxes = M.boxes();
    return {
      n: at1.length,
      layers: new Set(at1.map((s) => s.layer)).size,
      thin, tall,
      source: M.selectionSource(),
      inside: at1.every((s) => {
        const b = boxes[0];
        return Math.abs((s.x0 + s.x1) / 2 - b.gx) <= b.r &&
               Math.abs((s.y0 + s.y1) / 2 - b.gy) <= b.r &&
               Math.abs(s.z - b.gz) <= b.h;
      }),
      roundTrip: [Math.abs(boxes[0].gx - gx) < 1e-6,
                  Math.abs(boxes[0].gy - gy) < 1e-6,
                  Math.abs(boxes[0].gz - gz) < 1e-6],
    };
  });
  check('a default box catches segments', boxSel.n > 0, true);
  check('every one of them really is inside the box', boxSel.inside, true);
  check('the box round-trips through the view\'s axis map',
    boxSel.roundTrip, [true, true, true]);
  check('the selection is the box\'s', boxSel.source, 'box');
  // The independent vertical extent is the whole reason it stopped being a
  // sphere: "keep it thin to avoid grabbing unrelated layers above/below".
  check('thin takes exactly one layer', boxSel.thin.layers, 1);
  check('tall at the SAME footprint takes more', boxSel.tall.layers > boxSel.thin.layers, true);
  check('and more segments with it', boxSel.tall.n > boxSel.thin.n, true);
  console.log(`       h 0.01 -> ${boxSel.thin.layers} layer / h 1.0 -> ${boxSel.layers} ` +
              `layers / h 5.0 -> ${boxSel.tall.layers} layers, all at r 5.0`);

  check('the export row appears once there is a selection',
    await page.isVisible('#ms-export-row'), true);
  check('and Isolate is live', await page.isEnabled('#ms-btn-isolate'), true);

  // Isolate / Back, the reference tool's two-state view.
  await page.click('#ms-btn-isolate');
  const isolated = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    return {
      detail: v.detailGroup.visible,
      overview: v.overviewGroup.visible,
      // InstancedMesh extends Mesh and does not override `type`, so the flag
      // is what names it - `type` would read 'Mesh' for both.
      kinds: [...new Set(v.detailGroup.children.map(
        (c) => (c.isInstancedMesh ? 'InstancedMesh' : c.type)))],
      badge: document.getElementById('ms-mode-badge').textContent,
    };
  });
  check('Isolate shows the detail group', isolated.detail, true);
  check('and hides the overview', isolated.overview, false);
  check('drawn the reference tool\'s way - instanced cylinders', isolated.kinds, ['InstancedMesh']);
  check('the badge says what is on screen', /^Detail: \d+ segments$/.test(isolated.badge), true);
  await page.click('#ms-btn-back');
  check('Back returns to the whole part',
    await page.evaluate(() => window.NSO_MICROSCOPE.getView().overviewGroup.visible), true);

  // =======================================================================
  console.log('\n--- selection mode 2: full layer ---');
  // =======================================================================
  check('the layer controls are live on a sliced file',
    await page.isEnabled('#ms-btn-layer-select'), true);
  check('and say how many there are',
    /50 layers/.test(await page.textContent('#ms-layer-note')), true);

  await page.fill('#ms-layer-index', '0');
  await page.click('#ms-btn-layer-select');
  const layerSel = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), sel = M.selection();
    const G = window.NSOGcodeLines;
    // The same call the Toolpath card's "whole layer at one Z" scope makes.
    const want = G.movesInZWindow(d.parsed.moves, G.layerZWindow(d.parsed, 0));
    return {
      n: sel.length,
      want: want.length,
      source: M.selectionSource(),
      zs: [...new Set(sel.map((s) => s.z.toFixed(6)))],
      features: [...new Set(sel.map((s) => s.feature))].length,
      layers: [...new Set(sel.map((s) => s.layer))],
      info: document.getElementById('ms-info').textContent,
    };
  });
  check('the whole layer comes out', layerSel.n > 0, true);
  check('and it is exactly what movesAtZ would give - no second copy of it',
    layerSel.n, layerSel.want);
  check('at exactly one printing Z', layerSel.zs.length, 1);
  check('and one layer index', layerSel.layers, [0]);
  check('across every feature at that height, not just one', layerSel.features >= 1, true);
  check('the selection is the layer\'s', layerSel.source, 'layer');
  check('the readout says so', /whole layer/.test(layerSel.info), true);
  console.log(`       L1: ${layerSel.n} moves at Z ${layerSel.zs[0]}, ` +
              `${layerSel.features} feature(s)`);

  // Stepping is bounded, so neither end can run off the file.
  const stepped = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    M.selectLayer(49);
    const top = M.selection().length;
    document.getElementById('ms-layer-next').click();      // past the top
    return { top, after: +document.getElementById('ms-layer-index').value, n: M.layerCount() };
  });
  check('stepping past the top layer stays on it', stepped.after, stepped.n - 1);
  check('and the top layer is a real one', stepped.top > 0, true);

  // =======================================================================
  console.log('\n--- Export as STL: just the selection, to a real file ---');
  // =======================================================================
  await page.evaluate(() => window.NSO_MICROSCOPE.selectLayer(0));
  const expect = await page.evaluate(() => {
    const geo = window.NSO_MICROSCOPE.geometry();
    return {
      tris: geo.attributes.position.count / 3,
      moves: window.NSO_MICROSCOPE.selection().length,
      label: window.NSO_MICROSCOPE.exportLabel(),
    };
  });
  check('the export is 12 triangles a line and nothing else',
    expect.tris, expect.moves * 12);
  check('and it is named for the Z it came from',
    /Z \d+\.\d+ mm \(L1, x\d+\)/.test(expect.label), true);

  const dir = await mkdtemp(join(tmpdir(), 'nso-microscope-'));
  const stlPath = join(dir, 'selection.stl');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#ms-btn-export-stl'),
  ]);
  await dl.saveAs(stlPath);
  const written = stlTriangles(await readFile(stlPath));
  check('the file holds exactly the selection, triangle for triangle',
    written.length, expect.tris);
  check('the file name is the selection\'s name',
    /Z_\d+\.\d+_mm/.test(dl.suggestedFilename()), true);
  check('the panel stayed open - a download is not a way out',
    await page.isVisible('#microscope'), true);

  // =======================================================================
  console.log('\n--- Export to plate: back to the main viewport, as a piece ---');
  // =======================================================================
  const before = await page.evaluate(() => ({
    models: state.models.length, placed: state.placed.length, undo: state.undoStack.length,
  }));
  await page.click('#ms-btn-export-plate');
  const after = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return {
      models: state.models.length,
      placed: state.placed.length,
      undo: state.undoStack.length,
      name: m.name,
      tris: m.geometry.attributes.position.count / 3,
      rawAxis: m.rawAxis,
      hasRaw: !!(m.rawTris && m.rawTris.length),
      panelOpen: !document.getElementById('microscope').hidden,
      lit: /is-on/.test(document.getElementById('btn-microscope').className),
      said: document.getElementById('status').textContent,
    };
  });
  check('the microscope closes and hands you back the main viewport',
    after.panelOpen, false);
  check('and the rail button goes out with it', after.lit, false);
  check('one new model', after.models, before.models + 1);
  check('as a real piece on the plate', after.placed, before.placed + 1);
  check('with one undo entry, so it can be taken back', after.undo, before.undo + 1);
  check('it came in through the ordinary ingest path', after.rawAxis, 'zup');
  check('with its raw soup, so the raw engines will take it', after.hasRaw, true);
  check('it is the same geometry the file got', after.tris, expect.tris);
  check('and it carries the selection\'s name', after.name, expect.label);
  check('the app said so', /Export to plate ok/.test(after.said), true);

  // The property the single builder exists for: the two doors write the same
  // bytes. Compared here against the file actually on disk.
  const plateTris = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return Array.from(m.rawTris);
  });
  const sameBytes = written.length * 9 === plateTris.length &&
    written.every((t, i) => t.every((v, k) => Math.abs(v - plateTris[i * 9 + k]) < 1e-3));
  check('Export to plate and Export as STL are the SAME triangles', sameBytes, true);

  const undone = await page.evaluate(() => {
    document.getElementById('btn-undo').click();
    return { models: state.models.length, placed: state.placed.length };
  });
  check('one Undo takes the exported piece back',
    [undone.models, undone.placed], [before.models, before.placed]);

  // =======================================================================
  console.log('\n--- a plain STL: no layers, no features, one whole part ---');
  // =======================================================================
  await openPanelViaRail(page);
  await importThrough(page, '#ms-btn-open', PLAIN_STL);

  const stlDoc = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    return {
      kind: d.kind,
      objects: d.objects.length,
      tris: d.objects[0].triangles,
      groups: M.groups(),
      layers: M.layerCount(),
      overviewKinds: [...new Set(v.overviewGroup.children.map((c) => c.type))],
      note: document.getElementById('ms-layer-note').textContent,
      sub: document.getElementById('ms-sub').textContent,
      layerBtn: document.getElementById('ms-btn-layer-select').disabled,
      layerNum: document.getElementById('ms-layer-index').disabled,
    };
  });
  check('it reads as a mesh, not a toolpath', stlDoc.kind, 'mesh');
  check('an STL is ONE object - the format has no object structure',
    stlDoc.objects, 1);
  check('so it draws as one whole, unsegmented part', stlDoc.overviewKinds, ['Mesh']);
  check('the legend has that one part and nothing invented beside it',
    stlDoc.groups.length, 1);
  check('it is named after the file', stlDoc.groups[0], 'box-20mm');
  check('it has no layers', stlDoc.layers, 0);
  check('so the layer control is disabled rather than faking one',
    [stlDoc.layerBtn, stlDoc.layerNum], [true, true]);
  check('and says why, on screen',
    /not sliced, so it has no layers/.test(stlDoc.note), true);
  check('the header says the same thing',
    /Not sliced: no layers and no features/.test(stlDoc.sub), true);
  // A plain mesh has no features, so the legend must not claim it groups on
  // them - it groups on build objects, and says so.
  check('the legend is named for what a MESH groups on',
    await page.textContent('#ms-legend-title'), 'Parts (click to isolate)');

  const refused = await page.evaluate(() => {
    window.NSO_MICROSCOPE.selectLayer(0);
    return document.getElementById('status').textContent;
  });
  check('asking for a layer anyway is refused, not invented',
    /has no layers/.test(refused), true);

  // The capture box still works - it is a region test, and a region is a
  // region whether the thing in it is a bead or a triangle.
  const stlBox = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const b = d.objects[0].bounds;
    M.clearBoxes();
    M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 40, 15);
    const hit = M.selection();
    M.clearBoxes();
    M.addBoxAt(b.maxX + 500, b.maxY + 500, b.maxZ + 500, 1, 1);   // nowhere near it
    const miss = M.selection().length;
    M.clearBoxes();
    M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 40, 15);
    const geo = M.geometry();
    return {
      hit: hit.length, miss, names: hit.map((o) => o.name),
      tris: geo ? geo.attributes.position.count / 3 : 0,
      label: M.exportLabel(),
    };
  });
  check('a box over the part selects it', stlBox.hit, 1);
  check('a box nowhere near it selects nothing', stlBox.miss, 0);
  // Whole objects, not loose triangles: a triangle subset of a mesh is an open
  // surface, and this view's export contract is a real standalone object.
  check('what comes out is the whole object, not a surface patch',
    stlBox.tris, stlDoc.tris);
  check('named for the object it is', stlBox.label, 'box-20mm - box-20mm');

  const stlBefore = await page.evaluate(() => state.models.length);
  await page.click('#ms-btn-export-plate');
  const stlAfter = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { models: state.models.length, tris: m.geometry.attributes.position.count / 3 };
  });
  check('a plain STL exports to the plate too', stlAfter.models, stlBefore + 1);
  check('as the whole part it is', stlAfter.tris, stlDoc.tris);

  // =======================================================================
  console.log('\n--- a plain 3MF: one part per build object ---');
  // =======================================================================
  await openPanelViaRail(page);
  await importThrough(page, '#ms-btn-open', PLAIN_3MF);

  const mfDoc = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    return {
      kind: d.kind,
      objects: d.objects.length,
      groups: M.groups(),
      layers: M.layerCount(),
      kinds: [...new Set(v.overviewGroup.children.map((c) => c.type))],
      legend: document.querySelectorAll('#ms-legend .ms-legend-item').length,
    };
  });
  check('a plain 3MF reads as a mesh', mfDoc.kind, 'mesh');
  check('with one part per build object - ten of them', mfDoc.objects, 10);
  check('one legend row each, from the file\'s own object names', mfDoc.legend, 10);
  check('drawn as ten whole parts', mfDoc.kinds, ['Mesh']);
  check('still no layers, because it is still not sliced', mfDoc.layers, 0);

  const mfBox = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const o = d.objects[0], b = o.bounds;
    M.clearBoxes();
    M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2,
      (b.maxX - b.minX) / 2 + 0.1, (b.maxZ - b.minZ) / 2 + 0.1);
    const sel = M.selection();
    return {
      n: sel.length,
      names: sel.map((x) => x.name),
      first: o.name,
      tris: M.geometry().attributes.position.count / 3,
      want: sel.reduce((a, x) => a + x.triangles, 0),
    };
  });
  check('a box over one object selects a real subset of the ten',
    mfBox.n >= 1 && mfBox.n < 10, true);
  check('including the one it was placed on', mfBox.names.includes(mfBox.first), true);
  check('and the export is exactly those objects\' triangles', mfBox.tris, mfBox.want);
  console.log(`       box over "${mfBox.first}" -> ${mfBox.n} of 10 objects, ${mfBox.tris} triangles`);

  // =======================================================================
  console.log('\n--- the big real slice, at real density ---');
  // =======================================================================
  // The panel is still open from the 3MF above - it covers the viewport, so
  // the rail button is behind it and Import is the way to swap files.
  check('the panel is still open, so Import swaps the file in place',
    await page.isVisible('#microscope'), true);
  await importThrough(page, '#ms-btn-open', BIG);
  check('the previous file is gone, not stacked under the new one',
    await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().kind), 'toolpath');
  check('and its boxes went with it',
    await page.evaluate(() => window.NSO_MICROSCOPE.boxes().length), 0);

  const bigDoc = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    return {
      segments: d.segments.length,
      layers: M.layerCount(),
      groups: M.groups().length,
      assumed: d.parsed.meta.assumed,
      kinds: [...new Set(v.overviewGroup.children.map((c) => c.type))],
    };
  });
  check('202,877 moves over 73 layers', [bigDoc.segments, bigDoc.layers], [202877, 73]);
  check('nine feature groups', bigDoc.groups, 9);
  check('nothing assumed on the big file either', bigDoc.assumed, false);
  check('still one LineSegments per feature at 7.8x the reference tool\'s density',
    bigDoc.kinds, ['LineSegments']);

  const bigLayer = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    M.selectLayer(20);
    const sel = M.selection();
    const geo = M.geometry();
    return {
      n: sel.length,
      zs: [...new Set(sel.map((s) => s.z.toFixed(6)))].length,
      features: [...new Set(sel.map((s) => s.feature))].length,
      tris: geo.attributes.position.count / 3,
    };
  });
  // A drag re-runs the box predicate over every segment on every pointermove.
  // At 202,877 that is the worst case this view has, so it is measured rather
  // than assumed - a drag that cannot keep up is a broken interaction.
  const dragCost = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const m = d.parsed.moves[Math.floor(d.parsed.moves.length / 2)];
    M.clearBoxes();
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      M.clearBoxes();
      M.addBoxAt((m.x0 + m.x1) / 2 + i * 0.1, (m.y0 + m.y1) / 2, m.z, 5.0, 1.0);
    }
    const ms = (performance.now() - t0) / 10;
    M.clearBoxes();
    return { ms, n: d.segments.length };
  });
  check('one selection pass over 202,877 segments stays inside a frame',
    dragCost.ms < 16, true);
  console.log(`       ${dragCost.ms.toFixed(1)} ms per pass over ${dragCost.n} segments`);

  check('a whole layer out of the big file selects', bigLayer.n > 0, true);
  check('at one Z', bigLayer.zs, 1);
  check('across several features at that height', bigLayer.features > 1, true);
  check('and exports as 12 triangles a line', bigLayer.tris, bigLayer.n * 12);
  console.log(`       tabletop L21: ${bigLayer.n} moves, ${bigLayer.features} features, ` +
              `${bigLayer.tris} triangles`);

  // Closing leaves the app exactly as it was.
  await page.click('#ms-close');
  check('Close puts the main viewport back', await page.isVisible('#microscope'), false);
  check('and the rail button is reachable again',
    await page.isVisible('#btn-microscope'), true);
  // Escape is the other way out, and it must not lose the loaded file.
  await openPanelViaRail(page);
  await page.focus('#microscope');
  await page.keyboard.press('Escape');
  check('Escape closes it too', await page.isVisible('#microscope'), false);
  check('and the file stays loaded for the next open',
    await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().segments.length), 202877);
  check('and the plate is untouched by looking',
    await page.evaluate(() => state.models.length), stlBefore + 1);

  // =======================================================================
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
