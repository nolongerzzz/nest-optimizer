#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-slice-drive-check.mjs
 *
 * G-scope's Slice action (app-gscope-slice.js), driven through the real app in
 * headless Chromium with real clicks:
 *
 *   1  THE ACTION IS THERE for a mesh document - the plate, and an STL opened
 *      straight into G-scope - and not for an imported slice.
 *   2  A REAL CLICK SLICES THE PLATE and opens the result as a toolpath
 *      document. Its moves are, move for move, what NSO_Slicer + parseGcode
 *      give when called directly on the same pieces with the same options.
 *   3  IT IS THE SAME KIND OF DOCUMENT an imported .gcode.3mf is: the same
 *      document keys, the same per-segment schema as tabletop.gcode.3mf opened
 *      through the import route, the slicer's own feature names coloured by
 *      the slicer table.
 *   4  G-SCOPE'S OWN TOOLS WORK ON IT unchanged: the legend's "only" (a real
 *      click), a whole layer, Pick a line + Isolate, the layer-range slider,
 *      the solid view, Clear from view.
 *   5  THE REPORT names the support-need region on the mushroom and none on
 *      the plain box; a non-solid piece is sliced with its chains left open.
 *   6  NOTHING IS WRITTEN: no model, no plate piece, no undo step.
 *   7  BACK TO THE MESH re-opens the plate; an STL opened into G-scope slices too.
 *   8  THE PIECE STAYS EXPORTABLE while its slice is shown, with nothing
 *      selected: Export piece as STL downloads the piece's exact triangles,
 *      Export piece to plate adds them as a new piece with one Undo step.
 *
 * Usage: node tools/gcode-test/gscope-slice-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'gscope-slice-out');

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
/* A 4 mm stem under a 14 mm cap: one overhang, on the plate. And a plain block. */
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

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SLICE && !!window.NSO_Slicer, null, { timeout: 30000 });

  await page.evaluate(([a, b]) => handleFiles([new File([new Uint8Array(a)], 'mushroom.stl'),
    new File([new Uint8Array(b)], 'plain.stl')]), [MUSHROOM, PLAIN]);
  await page.waitForFunction(() => state.models.length === 2, null, { timeout: 30000 });
  const before = await page.evaluate(() => ({ models: state.models.length, placed: state.placed.length, undo: state.undoStack.length }));
  await page.click('#btn-microscope');

  // =======================================================================
  console.log('\n--- 1. the action is there for a mesh document ---');
  // =======================================================================
  check('the plate opened as a mesh document', await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().kind), 'mesh');
  check('the Slice section is visible', await page.isVisible('#ms-slice-row'), true);
  check('the Slice button is visible', await page.isVisible('#ms-btn-slice'), true);
  check('defaults are the real setup: 0.6 nozzle, 0.3 layers, 2 walls, 15 % grid, 30 deg (Bambu profile)',
    await page.evaluate(() => [document.getElementById('ms-slice-nozzle').value, document.getElementById('ms-slice-layer').value,
      document.getElementById('ms-slice-walls').value, document.getElementById('ms-slice-density').value,
      document.getElementById('ms-slice-pattern').value, document.getElementById('ms-slice-angle').value]),
    ['0.6', '0.3', '2', '15', 'grid', '30']);

  // =======================================================================
  console.log('\n--- 2. a real click slices the plate ---');
  // =======================================================================
  await page.selectOption('#ms-slice-nozzle', '0.4');
  check('changing the nozzle sets the layer to half of it', await page.inputValue('#ms-slice-layer'), '0.2');
  const plateObjs = await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().objects.map((o) => o.name));
  await page.click('#ms-btn-slice');
  await sliced(page);
  const doc = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return { name: d.name, kind: d.kind, moves: d.parsed.moves.length, layers: d.parsed.layers.length,
      assumed: d.parsed.meta.assumed, segs: d.segments.length, groups: Object.keys(d.groups).sort() };
  });
  check('the slice opened as a toolpath document, named for its source and settings',
    [doc.kind, /^Plate - NSO slice \(0\.4 mm nozzle, 0\.2 mm layers\)$/.test(doc.name)], ['toolpath', true]);
  check('parsed with nothing assumed', doc.assumed, false);
  const direct = await page.evaluate(async (names) => {
    const d = window.NSO_MICROSCOPE.getDoc(), src = window.NSO_GSCOPE_SLICE.last().source;
    const objs = src.objects.map((o) => ({ name: o.name, soup: o.positions }));
    const opts = Object.assign({}, window.NSO_GSCOPE_SLICE.panelOpts().over);
    const r = await window.NSO_Slicer.run(objs, window.NSO_Slicer.defaultsFor(0.4, opts));
    const p = window.NSOGcodeLines.parseGcode(r.gcode);
    let same = p.moves.length === d.parsed.moves.length;
    for (let i = 0; same && i < p.moves.length; i++) {
      const a = p.moves[i], b = d.parsed.moves[i];
      same = a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1 && a.z === b.z &&
             a.width === b.width && a.feature === b.feature && a.run === b.run;
    }
    return { same, n: p.moves.length, srcNames: src.objects.map((o) => o.name), names };
  }, plateObjs);
  check('its moves are, move for move, NSO_Slicer + parseGcode called directly on the same pieces', direct.same, true);
  check('it sliced the pieces the plate document held', direct.srcNames, plateObjs);
  check('the legend is the slicer\'s features', doc.groups.filter((g) => g !== 'Travel'),
    ['Bottom surface', 'Bridge', 'Inner wall', 'Internal solid infill', 'Outer wall', 'Overhang wall', 'Sparse infill', 'Top surface']);
  await frames(page);
  await page.locator('#microscope').screenshot({ path: join(SHOTS, 'slice-01-plate.png') });

  // =======================================================================
  console.log('\n--- 3. the same kind of document an imported .gcode.3mf is ---');
  // =======================================================================
  const bytes = Array.from(await readFile(join(ROOT, 'fixtures', '3mf', 'supportwithinsupport.gcode.3mf')));
  const shape = await page.evaluate(async (b) => {
    const M = window.NSO_MICROSCOPE;
    const ours = M.getDoc();
    const keysOf = (d) => Object.keys(d).filter((k) => k !== 'nsoSlice' && k !== 'groups').sort();
    const segKeys = (d) => Object.keys(d.segments[0]).sort();
    const a = { doc: keysOf(ours), seg: segKeys(ours), mv: Object.keys(ours.segments[0].mv).sort() };
    const saved = window.NSO_GSCOPE_SLICE.last();
    await M.load('supportwithinsupport.gcode.3mf', new Uint8Array(b).buffer);
    const real = M.getDoc();
    const r = { doc: keysOf(real), seg: segKeys(real), mv: Object.keys(real.segments[0].mv).sort(), name: real.name, kind: real.kind };
    return { a, r, saved: !!saved };
  }, bytes);
  check('the imported real slice opened through the import route', [shape.r.kind, shape.r.name], ['toolpath', 'supportwithinsupport.gcode.3mf']);
  check('same document keys as the imported real slice', shape.a.doc, shape.r.doc);
  check('same per-segment schema', shape.a.seg, shape.r.seg);
  check('same per-move schema (the parser\'s own)', shape.a.mv, shape.r.mv);
  check('the Slice section hides on an imported slice (there is no mesh to slice)', await page.isVisible('#ms-slice-row'), false);

  // back to the plate, slice again for section 4
  await page.click('#ms-btn-plate');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh');
  await page.click('#ms-btn-slice');
  await sliced(page);

  // =======================================================================
  console.log('\n--- 4. G-scope\'s own tools, unchanged ---');
  // =======================================================================
  const only = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#ms-legend .ms-legend-item, #ms-legend > *'));
    return items.map((el) => el.textContent.trim()).filter(Boolean).length;
  });
  check('the legend lists the features', only > 5, true);
  const onlyBtn = page.locator('#ms-legend').getByText('only').first();
  const hasOnly = await onlyBtn.count();
  if (hasOnly) {
    // the legend's "only" for Outer wall: find the row and click its button
    const clicked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#ms-legend > *'));
      const row = rows.find((r) => /Outer wall/.test(r.textContent));
      const btn = row && Array.from(row.querySelectorAll('button, span, a')).find((x) => /only/i.test(x.textContent));
      if (!btn) return false;
      btn.click();
      return true;
    });
    check('legend "only" on Outer wall (a real click on its control)', clicked, true);
    const hidden = await page.evaluate(() => window.NSO_MICROSCOPE.hidden().sort());
    check('... every other feature is hidden', hidden.includes('Sparse infill') && !hidden.includes('Outer wall'), true);
    await page.evaluate(() => window.NSO_MICROSCOPE.showAll());
  }
  const ops = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    const out = {};
    M.selectLayer(10);
    const sel = M.selection();
    out.layer = { n: sel.length, oneLayer: new Set(sel.map((s) => s.layer)).size, want: d.parsed.moves.filter((m) => m.layer === 10).length };
    const seg = d.segments.find((s) => s.feature === 'Outer wall' && s.layer === 10);
    M.pickLine(seg.mv.index);
    out.pick = M.selection().map((s) => s.mv.index);
    out.pickWant = seg.mv.index;
    M.isolate();
    const reg = M.selectionRegion();
    out.region = reg && reg.moves ? reg.moves.length : -1;
    M.back();
    M.setZRangeMm(1.0, 2.0);
    out.zr = M.zRange();
    out.shown = M.shownCount();
    M.setZRangeMm(0, 99);
    M.setRenderMode('solid');
    out.solid = !!M.shownSolid();
    M.setRenderMode('toolpath');
    return out;
  });
  check('a whole layer: every move of layer 10, one layer only', [ops.layer.n === ops.layer.want, ops.layer.oneLayer], [true, 1]);
  check('Pick a line: exactly the picked move', ops.pick, [ops.pickWant]);
  check('Isolate: the selection region carries the one move', ops.region, 1);
  check('the layer-range slider narrows what is shown', ops.shown > 0 && ops.shown < doc.segs, true);
  check('the solid view builds a solid of the slice', ops.solid, true);
  await frames(page);
  await page.locator('#microscope').screenshot({ path: join(SHOTS, 'slice-02-tools.png') });

  // =======================================================================
  console.log('\n--- 5. the report ---');
  // =======================================================================
  const read = await page.textContent('#ms-slice-read');
  console.log('       ' + read);
  const rep = await page.evaluate(() => window.NSO_GSCOPE_SLICE.last().result.objects.map((o) => ({
    name: o.name, regions: o.overhang.map((g) => ({ z: g.firstZ, on: g.standsOn, a: g.footprintMm2 })) })));
  const mush = rep.find((o) => /mushroom/.test(o.name)), plain = rep.find((o) => /plain/.test(o.name));
  check('the mushroom\'s cap needs support, at z 5, standing on the plate',
    [mush.regions.length, Math.abs(mush.regions[0].z - 5) < 1e-6, mush.regions[0].on], [1, true, 'plate']);
  check('the plain block needs none', plain.regions.length, 0);
  check('the panel says so',
    [/mushroom: .*needs support at z 5\.00/.test(read), /plain: .*no support needed/.test(read)], [true, true]);
  await page.evaluate(() => window.NSO_MICROSCOPE.setSelectionMoves([]));
  check('on the plate\'s slice, both piece exports are there with nothing selected',
    [await page.isVisible('#ms-btn-slice-export-plate'), await page.isVisible('#ms-btn-slice-export-stl'),
     await page.evaluate(() => window.NSO_MICROSCOPE.selection().length)], [true, true, 0]);
  // non-solid: flag the plain block, slice again
  await page.click('#ms-btn-slice-back');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh');
  check('Back to the mesh re-opens the plate', await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().source), 'plate');
  await page.evaluate(() => { state.models.find((m) => /plain/.test(m.name)).nonSolid = true; });
  await page.click('#ms-btn-slice');
  await sliced(page);
  const ns = await page.evaluate(() => ({ read: document.getElementById('ms-slice-read').textContent,
    flags: window.NSO_GSCOPE_SLICE.last().result.objects.map((o) => o.nonSolid) }));
  check('a non-solid piece is read through nsoNonSolid and sliced without closing chords', ns.flags, [false, true]);
  check('... and the report names it', /Non-solid \(open by design\): plain/.test(ns.read), true);
  await page.evaluate(() => { state.models.find((m) => /plain/.test(m.name)).nonSolid = false; });

  // =======================================================================
  console.log('\n--- 6. nothing written ---');
  // =======================================================================
  const after = await page.evaluate(() => ({ models: state.models.length, placed: state.placed.length, undo: state.undoStack.length }));
  check('no model, plate piece or undo step added by slicing', after, before);

  // =======================================================================
  console.log('\n--- 7. an STL opened straight into G-scope slices too ---');
  // =======================================================================
  await page.evaluate(async (b) => {
    const a = new Uint8Array(b).buffer;
    await window.NSO_MICROSCOPE.load('mushroom.stl', a);
  }, MUSHROOM);
  check('the STL is a mesh document', await page.evaluate(() => [window.NSO_MICROSCOPE.getDoc().kind, window.NSO_MICROSCOPE.getDoc().source || 'file']), ['mesh', 'file']);
  check('Slice is offered on it', await page.isVisible('#ms-btn-slice'), true);
  await page.click('#ms-btn-slice');
  await sliced(page);
  check('it slices into a toolpath document', await page.evaluate(() => /^mushroom\.stl - NSO slice/.test(window.NSO_MICROSCOPE.getDoc().name)), true);
  await frames(page);
  await page.locator('#microscope').screenshot({ path: join(SHOTS, 'slice-03-stl.png') });

  // =======================================================================
  console.log('\n--- 8. the piece stays exportable while its slice is shown ---');
  // =======================================================================
  const srcSoup = await page.evaluate(() => Array.from(window.NSO_GSCOPE_SLICE.last().source.objects[0].positions));
  check('nothing is selected in the slice view', await page.evaluate(() => window.NSO_MICROSCOPE.selection().length), 0);
  check('Export piece to plate and Export piece as STL are both visible',
    [await page.isVisible('#ms-btn-slice-export-plate'), await page.isVisible('#ms-btn-slice-export-stl')], [true, true]);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('#ms-btn-slice-export-stl')]);
  const file = await readFile(await dl.path());
  const n = file.readUInt32LE(80);
  const got = [];
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) got.push(file.readFloatLE(84 + t * 50 + 12 + k * 4));
  check('Export piece as STL downloads the piece, named for it', dl.suggestedFilename(), 'mushroom_-_mushroom.stl');
  check('... carrying the piece\'s exact triangles', [n, got.every((v, i) => v === Math.fround(srcSoup[i]))], [srcSoup.length / 9, true]);
  const pre = await page.evaluate(() => ({ models: state.models.length, undo: state.undoStack.length }));
  await page.click('#ms-btn-slice-export-plate');
  await page.waitForFunction((m) => state.models.length === m + 1, pre.models, { timeout: 15000 });
  const added = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { name: m.name, tris: m.rawTris.length / 9, undo: state.undoStack.length,
             top: state.undoStack[state.undoStack.length - 1].type };
  });
  check('Export piece to plate adds the piece as its own model with the same triangle count, one addModels undo step',
    [added.name, added.tris, added.undo - pre.undo, added.top], ['mushroom - mushroom', srcSoup.length / 9, 1, 'addModels']);
  await page.click('#btn-undo');
  await page.waitForFunction((m) => state.models.length === m, pre.models, { timeout: 15000 });
  check('... and Undo takes it off again', await page.evaluate(() => state.models.length), pre.models);

  check('the kernel came from the vendored copy (no network)', cdn.includes('manifold-3d@3.5.3/manifold.wasm'), true);
  check('no page errors', errors, []);

  await browser.close();
  served.srv.close();
  check.report();
}

main().catch((err) => { console.error(err); process.exit(1); });
