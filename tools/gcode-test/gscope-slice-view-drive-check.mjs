#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-slice-view-drive-check.mjs
 *
 * G-scope's Normal / Slice view toggle (app-gscope-slice.js owns it), driven
 * through the real app in headless Chromium with real clicks:
 *
 *   1  NORMAL, AS IT WAS. The View row is Normal | Slice view; Close
 *      inspection is gone (no button, no API, no badge). On a mesh, Normal is
 *      the same re-frame of the whole part it always was, and changes nothing
 *      else. The slice settings are all there, behind a disclosure that is
 *      collapsed by default.
 *   2  SLICE VIEW slices at once with the settings as they stand, shows the
 *      real slice (layers, walls, infill - the same moves NSO_Slicer +
 *      parseGcode give directly) and turns the legend to its Detected
 *      features tab, populated with walls / infill / top-bottom and every
 *      overhang call, each a real click to isolate.
 *   3  NORMAL AGAIN goes back to the mesh through backToMesh(), even from an
 *      isolated overhang: the whole-part state is exactly the one before
 *      slicing - same document, nothing selected, nothing isolated, nothing
 *      hidden or cleared, the same camera, the legend without tabs.
 *   4  THE ROUND TRIP AGAIN: the settings kept their values, and the second
 *      slice is the first one, G-code for G-code; Normal is clean again.
 *   5  AN IMPORTED SLICE has nothing to slice: Slice view is disabled there.
 *   6  NOTHING IS WRITTEN and nothing throws.
 *
 * Usage: node tools/gcode-test/gscope-slice-view-drive-check.mjs
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
async function meshBack(page) {
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 30000 });
}

/** The whole-part state a round trip must give back, exactly. */
function snapshot(page) {
  return page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
    const r = (a) => a.toArray().map((x) => Math.round(x * 1e9) / 1e9);
    return {
      kind: d.kind, source: d.source || 'file', name: d.name, sliced: !!d.nsoSlice,
      objects: (d.objects || []).map((o) => [o.name, o.triangles]),
      selection: M.selection().length, selectionSource: M.selectionSource(),
      detailShown: v.detailGroup.visible, overviewShown: v.overviewGroup.visible,
      backOffered: vis('ms-detail-controls'), badge: document.getElementById('ms-mode-badge').textContent,
      hidden: M.hidden().sort(), cleared: M.cleared().sort(), zRange: M.zRange(),
      legendTab: M.legendTab(), tabsShown: vis('ms-tab-legend'),
      legendTitle: document.getElementById('ms-legend-title').textContent,
      legendRows: Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map((e) => e.dataset.group),
      legendShown: vis('ms-legend'),
      detectedRows: Array.from(document.querySelectorAll('#ms-detected .ms-legend-item')).map((e) => e.dataset.detected),
      camera: { target: r(v.controls.target), position: r(v.camera.position), near: v.camera.near, far: v.camera.far },
      toggle: [document.getElementById('ms-cam-normal').classList.contains('active'),
               document.getElementById('ms-cam-slice').classList.contains('active')],
      viewMode: window.NSO_GSCOPE_SLICE.viewMode()
    };
  });
}
function settings(page) {
  return page.evaluate(() => ['nozzle', 'layer', 'walls', 'density', 'pattern', 'angle']
    .map((k) => document.getElementById('ms-slice-' + k).value));
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
  const written = await page.evaluate(() => ({ models: state.models.length, placed: state.placed.length, undo: state.undoStack.length }));
  await page.click('#btn-microscope');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc() && window.NSO_MICROSCOPE.getDoc().kind === 'mesh');
  await frames(page);

  // =======================================================================
  console.log('\n--- 1. Normal, as it was; Close inspection gone; settings tucked away ---');
  // =======================================================================
  const base = await snapshot(page);
  check('the plate opens as a mesh, whole part, in Normal',
    [base.kind, base.source, base.badge, base.toggle, base.viewMode], ['mesh', 'plate', 'Whole part', [true, false], 'normal']);
  check('the View row is Normal | Slice view',
    await page.evaluate(() => Array.from(document.querySelectorAll('#ms-camera-row button')).map((b) => [b.id, b.textContent.trim()])),
    [['ms-cam-normal', 'Normal'], ['ms-cam-slice', 'Slice view']]);
  check('Close inspection is gone: no button, no camera-mode API, nowhere in the panel',
    await page.evaluate(() => [!!document.getElementById('ms-cam-close'), typeof window.NSO_MICROSCOPE.setCameraMode,
      typeof window.NSO_MICROSCOPE.cameraMode, /Close inspection/.test(document.getElementById('microscope').textContent)]),
    [false, 'undefined', 'undefined', false]);
  check('Normal has the legend as ever: Parts, no tab strip, the Flange, Handle, Bracket, Lid and Hinge rows under it',
    [base.legendTab, base.tabsShown, base.legendShown, base.legendTitle, base.detectedRows],
    [null, false, true, 'Parts (click to isolate)', ['flange', 'handle', 'bracket', 'lid', 'hinge']]);
  check('the slice settings sit behind a disclosure, collapsed by default',
    await page.evaluate(() => [document.getElementById('ms-slice-settings').open,
      document.getElementById('ms-slice-settings').querySelector('summary').textContent.trim()]), [false, 'Slice settings']);
  check('... every control is still there, just not shown',
    [await page.evaluate(() => ['nozzle', 'layer', 'walls', 'density', 'pattern', 'angle']
      .every((k) => document.getElementById('ms-slice-settings').contains(document.getElementById('ms-slice-' + k)))),
     await page.isVisible('#ms-slice-layer')], [true, false]);
  check('defaults are the real setup: 0.6 nozzle, 0.3 layers, 2 walls, 15 % grid, 30 deg',
    await settings(page), ['0.6', '0.3', '2', '15', 'grid', '30']);

  // Normal on a mesh: the plain re-frame, nothing else. Move the camera off,
  // select and isolate a piece, then Normal: turned to the selection, still
  // isolated - exactly as before this change.
  await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    v.controls.target.x += 7; v.camera.position.x += 7; v.controls.update();
  });
  await page.click('#ms-cam-normal');
  const renorm = await snapshot(page);
  check('Normal on a mesh re-frames the whole part and keeps the same document',
    [renorm.camera, renorm.name, renorm.kind, renorm.toggle], [base.camera, base.name, 'mesh', [true, false]]);
  const pieceName = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, n = M.getDoc().objects.find((o) => /mushroom/.test(o.name)).name;
    M.selectObjects([n]); M.isolate(); return n;
  });
  await page.click('#ms-cam-normal');
  const isoNorm = await snapshot(page);
  check('Normal while isolated on a mesh: still isolated, same selection (no change in behaviour)',
    [isoNorm.detailShown, isoNorm.selection, isoNorm.backOffered, isoNorm.kind], [true, 1, true, 'mesh']);

  // =======================================================================
  console.log('\n--- 2. Slice view: sliced now, with the settings as set ---');
  // =======================================================================
  await page.click('#ms-slice-settings > summary');
  check('the disclosure opens on a click', await page.isVisible('#ms-slice-layer'), true);
  await page.selectOption('#ms-slice-nozzle', '0.4');
  check('changing the nozzle still sets the layer to half of it', await page.inputValue('#ms-slice-layer'), '0.2');
  await page.fill('#ms-slice-walls', '3');
  await page.fill('#ms-slice-density', '20');
  await page.selectOption('#ms-slice-pattern', 'zigzag');
  await page.fill('#ms-slice-angle', '35');
  await page.click('#ms-slice-settings > summary');     // tucked away again
  const set = await settings(page);
  check('the settings as set', set, ['0.4', '0.2', '3', '20', 'zigzag', '35']);

  await page.click('#ms-cam-slice');                    // from the isolated mesh
  await sliced(page);
  await frames(page);
  const s1 = await snapshot(page);
  const out1 = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc(), r = d.nsoSlice.result, o = r.options;
    return { layers: d.parsed.layers.length, planes: r.planes.length, moves: d.parsed.moves.length,
      groups: Object.keys(d.groups).sort(), gcode: r.gcode,
      opts: [o.nozzleMm, o.layerMm, o.wallLoops, o.sparseDensity, o.sparsePattern, o.supportThresholdDeg],
      srcNames: d.nsoSlice.source.objects.map((x) => x.name) };
  });
  check('Slice view shows a real slice of every piece, not the isolated one alone',
    [s1.kind, s1.sliced, out1.srcNames.length], ['toolpath', true, 2]);
  check('... with the settings as they were set', out1.opts, [0.4, 0.2, 3, 0.2, 'zigzag', 35]);
  check('... real layers, walls and infill',
    [out1.layers === out1.planes && out1.layers > 20, out1.moves > 1000,
     ['Outer wall', 'Inner wall', 'Sparse infill'].every((g) => out1.groups.includes(g))], [true, true, true]);
  const direct = await page.evaluate(async () => {
    const d = window.NSO_MICROSCOPE.getDoc(), src = d.nsoSlice.source;
    const po = window.NSO_GSCOPE_SLICE.panelOpts();
    const r = await window.NSO_Slicer.run(src.objects.map((o) => ({ name: o.name, soup: o.positions })),
      window.NSO_Slicer.defaultsFor(po.nozzleMm, po.over));
    return r.gcode === d.nsoSlice.result.gcode;
  });
  check('... the same G-code NSO_Slicer gives called directly on the same pieces', direct, true);
  check('the toggle reads Slice view', [s1.toggle, s1.viewMode], [[false, true], 'slice']);
  check('the legend turned to its Detected features tab',
    [s1.legendTab, s1.tabsShown, s1.legendShown, await page.isVisible('#ms-detected'), s1.legendTitle],
    ['detected', true, false, true, 'Detected features (click to isolate)']);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-detected .ms-legend-item'))
    .map((e) => [e.dataset.detected, e.textContent.trim()]));
  console.log('    detected rows:\n      ' + rows.map((r) => r[1]).join('\n      '));
  const rowOf = (k) => rows.find((r) => r[0] === k || r[0].startsWith(k));
  check('Detected features lists the walls, with the loop count set',
    !!rowOf('walls') && /^Walls - 3 loops/.test(rowOf('walls')[1]), true);
  check('... the infill, with the density and pattern set',
    !!rowOf('infill') && /^Infill - 20 % zigzag/.test(rowOf('infill')[1]), true);
  check('... top / bottom', !!rowOf('skin'), true);
  check('... the mushroom\'s overhang call at z 5, on the plate',
    !!rowOf('overhang:') && /mushroom.* at z 5\.00 - support on plate/.test(rowOf('overhang:')[1]), true);
  check('... and the plain block\'s "none"', !!rowOf('overhang-none:') && /plain/.test(rowOf('overhang-none:')[1]), true);
  await page.locator('#microscope').screenshot({ path: join(SHOTS, 'slice-view-01-detected.png') });

  await page.click('#ms-detected [data-detected="walls"]');
  const walls = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, sel = M.selection();
    return { n: sel.length, feats: [...new Set(sel.map((s) => s.feature))].sort(),
      detail: M.getView().detailGroup.visible, hidden: M.hidden() };
  });
  check('clicking Walls isolates every wall move and nothing else',
    [walls.n > 0, walls.detail, walls.feats.every((f) => /wall/i.test(f)), walls.hidden.includes('Sparse infill')],
    [true, true, true, true]);
  await page.click('#ms-detected [data-detected^="overhang:"]');
  const ovh = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, sel = M.selection();
    return { n: sel.length, zMin: Math.min(...sel.map((s) => s.z)), detail: M.getView().detailGroup.visible,
      badge: document.getElementById('ms-mode-badge').textContent };
  });
  check('clicking the overhang call isolates the moves printed over it, from z 5 up',
    [ovh.n > 0, ovh.zMin > 5, ovh.detail, /^Detail: /.test(ovh.badge)], [true, true, true, true]);
  await frames(page);
  await page.locator('#microscope').screenshot({ path: join(SHOTS, 'slice-view-02-overhang.png') });

  // =======================================================================
  console.log('\n--- 3. Normal: back to the mesh, exactly as it was before slicing ---');
  // =======================================================================
  await page.click('#ms-cam-normal');                   // from an isolated overhang
  await meshBack(page);
  await frames(page);
  const n1 = await snapshot(page);
  check('Normal goes back to the mesh (the plate, re-read)', [n1.kind, n1.source, n1.sliced], ['mesh', 'plate', false]);
  check('the whole-part state is exactly the one before slicing', n1, base);
  check('... no residual isolation, no stuck selection',
    [n1.selection, n1.detailShown, n1.backOffered, n1.badge], [0, false, false, 'Whole part']);
  check('the settings are closed and kept', [await page.evaluate(() => document.getElementById('ms-slice-settings').open),
    await settings(page)], [false, set]);

  // =======================================================================
  console.log('\n--- 4. the round trip again ---');
  // =======================================================================
  await page.click('#ms-cam-slice');
  await sliced(page);
  const s2 = await snapshot(page);
  const out2 = await page.evaluate(() => {
    const r = window.NSO_MICROSCOPE.getDoc().nsoSlice.result, o = r.options;
    return { gcode: r.gcode, opts: [o.nozzleMm, o.layerMm, o.wallLoops, o.sparseDensity, o.sparsePattern, o.supportThresholdDeg] };
  });
  check('the second Slice view used the persisted settings', out2.opts, out1.opts);
  check('... and is the first slice, G-code for G-code', out2.gcode === out1.gcode, true);
  check('... on the Detected features tab again, the same rows', [s2.legendTab, s2.detectedRows], ['detected', s1.detectedRows]);
  check('Slice view again while on the slice changes nothing',
    await page.evaluate(async () => {
      const d = window.NSO_MICROSCOPE.getDoc();
      await window.NSO_GSCOPE_SLICE.sliceView();
      return window.NSO_MICROSCOPE.getDoc() === d;
    }), true);
  await page.click('#ms-cam-normal');
  await meshBack(page);
  await frames(page);
  check('Normal again: the same whole-part mesh state', await snapshot(page), base);
  check('the settings are kept through both round trips', await settings(page), set);
  check('... and the piece selected before is simply unselected', await page.evaluate((n) =>
    window.NSO_MICROSCOPE.getDoc().objects.some((o) => o.name === n) && window.NSO_MICROSCOPE.selection().length, pieceName), 0);

  // =======================================================================
  console.log('\n--- 5. an imported slice has nothing to slice ---');
  // =======================================================================
  const bytes = Array.from(await readFile(join(ROOT, 'fixtures', '3mf', 'supportwithinsupport.gcode.3mf')));
  await page.evaluate(async (b) => { await window.NSO_MICROSCOPE.load('supportwithinsupport.gcode.3mf', new Uint8Array(b).buffer); }, bytes);
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'toolpath');
  const imp = await snapshot(page);
  check('on an imported .gcode.3mf: Normal, Slice view disabled, the legend as ever',
    [imp.toggle, await page.isDisabled('#ms-cam-slice'), imp.legendTab, imp.tabsShown], [[true, false], true, null, false]);
  await page.click('#ms-cam-normal');
  check('... and Normal there keeps the imported slice', await page.evaluate(() => window.NSO_MICROSCOPE.getDoc().name),
    'supportwithinsupport.gcode.3mf');

  // =======================================================================
  console.log('\n--- 6. nothing written, nothing thrown ---');
  // =======================================================================
  check('no model, plate piece or undo step added',
    await page.evaluate(() => ({ models: state.models.length, placed: state.placed.length, undo: state.undoStack.length })), written);
  check('the kernel came from the vendored copy (no network)', cdn.includes('manifold-3d@3.5.3/manifold.wasm'), true);
  check('no page errors', errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
