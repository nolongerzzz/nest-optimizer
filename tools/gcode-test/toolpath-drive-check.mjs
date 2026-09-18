#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / toolpath-drive-check.mjs
 *
 * The toolpath importer, the line slider and Extract Line, driven through the
 * REAL app in headless Chromium.
 *
 * gcode-lines-check.js proves the reader and the geometry maths. This proves
 * the thing the ticket is actually about, end to end and through the UI a user
 * touches:
 *
 *   - a `.gcode.3mf` dropped on the app becomes one model per FEATURE group,
 *     through the same ingest path an STL uses, with undo wired;
 *   - the line slider steps ONE MOVE AT A TIME within a layer, not just whole
 *     layers, and isolates and highlights exactly one move at each stop;
 *   - Extract Line pulls the scrubbed Support-interface region out as its own
 *     standalone model;
 *   - pressing the app's own "Download selected" writes that object, and
 *     NOTHING ELSE, to a real file, which is then re-opened from disk and
 *     checked to contain only the extracted feature.
 *
 * Usage:
 *   node tools/gcode-test/toolpath-drive-check.mjs
 *   CHROME_PATH=/path/to/chrome node tools/gcode-test/toolpath-drive-check.mjs
 */
import { chromium } from 'playwright';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const FIXTURE = 'fixtures/3mf/toolpath-ground-truth.gcode.3mf';

/** Triangles out of a binary STL, as flat [x,y,z] * 3 per triangle. */
function stlTriangles(buf) {
  const n = buf.readUInt32LE(80);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const t = [];
    for (let v = 0; v < 9; v++) t.push(buf.readFloatLE(o + v * 4));
    out.push(t);
  }
  return out;
}

async function main() {
  const served = await serveRoot();
  const base = served.base;
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const outDir = await mkdtemp(join(tmpdir(), 'nso-toolpath-'));

  console.log(`\nNest at ${base}/index.html`);
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });

  // -----------------------------------------------------------------------
  console.log('\n--- the build under test ---');
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('NSOGcodeLines is in this build', await page.evaluate(() => typeof window.NSOGcodeLines), 'object');
  check('NSO_TOOLPATH is in this build', await page.evaluate(() => typeof window.NSO_TOOLPATH), 'object');
  check('the toolpath card starts hidden',
    await page.isVisible('#toolpath-card'), false);
  check('a plain .3mf is NOT treated as sliced',
    await page.evaluate(() => window.NSO_TOOLPATH.looksSliced('pa_pattern.3mf')), false);
  check('a .gcode.3mf IS treated as sliced',
    await page.evaluate(() => window.NSO_TOOLPATH.looksSliced('x.gcode.3mf')), true);

  // -----------------------------------------------------------------------
  console.log('\n--- drop the sliced project on the real file handler ---');
  const bytes = Array.from(await readFile(FIXTURE));
  await page.evaluate(([b, n]) => {
    handleFiles([new File([new Uint8Array(b)], n)]);
  }, [bytes, 'toolpath-ground-truth.gcode.3mf']);
  await page.waitForFunction('window.NSO_TOOLPATH.getSession() !== null', null, { timeout: 20000 });

  const imported = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    return {
      models: state.models.map((m) => ({ name: m.name, tris: m.rawTris.length / 9, axis: m.rawAxis })),
      moves: s.moves.length,
      layers: s.layers.length,
      features: s.result.groups.map((g) => g.name),
      assumed: s.result.parsed.meta.assumed,
      undo: state.undoStack.length
    };
  });
  check('one model per FEATURE group, five groups',
    imported.features, ['Outer wall', 'Inner wall', 'Sparse infill', 'Support', 'Support interface']);
  check('five models landed in the scene', imported.models.length, 5);
  check('every model came in through the normal ingest path (rawTris, file axes)',
    imported.models.every((m) => m.axis === 'zup' && m.tris > 0), true);
  check('the models are named for their feature',
    imported.models.map((m) => m.name.replace(/^.*? - /, '')),
    ['Outer wall', 'Inner wall', 'Sparse infill', 'Support', 'Support interface']);
  check('nothing was assumed - all numbers came out of the file', imported.assumed, false);
  check('51 extrusion moves across 3 layers', [imported.moves, imported.layers], [51, 3]);
  check('the toolpath card is showing now', await page.isVisible('#toolpath-card'), true);

  // -----------------------------------------------------------------------
  console.log('\n--- the toolpath stays assembled, and the highlight lines up ---');
  // Five FEATURE groups out of one slice are five parts of ONE print. The app
  // normally centres each import on its own box and lays new pieces out in a
  // row; if that stood, the walls would sit beside their own infill and the
  // scrub highlight could not line up with anything. Assert the register.
  const register = await page.evaluate(() => {
    const T = window.NSO_TOOLPATH;
    const s = T.getSession();
    // Where each group's beads REALLY are, straight off the placed meshes.
    const world = {};
    state.placed.forEach((p) => {
      p.mesh.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(p.mesh);
      world[p.name.replace(/^.*? - /, '')] = {
        x: [b.min.x, b.max.x], y: [b.min.y, b.max.y], z: [b.min.z, b.max.z]
      };
    });
    // The highlight for a known move, in world space.
    T.setCursor(s.moves.findIndex((m) => m.feature === 'Support interface'));
    s.overlay.updateMatrixWorld(true);
    const hb = new THREE.Box3().setFromObject(s.overlay.children[1]);
    return { world, hi: { x: [hb.min.x, hb.max.x], y: [hb.min.y, hb.max.y], z: [hb.min.z, hb.max.z] } };
  });
  const r3 = (v) => Math.round(v * 1000) / 1000;
  // In the file the Outer wall spans x 9.79..30.21 and the whole toolpath spans
  // 9.79..44.19, so the toolpath centre is 26.99 and the wall belongs at
  // -17.2..3.22. Centred on ITSELF it would be -10.21..10.21 - so this number
  // is the difference between "kept in register" and "re-centred", and both
  // halves are asserted.
  const ow = register.world['Outer wall'];
  check('the Outer wall sits at its true offset within the toolpath',
    [r3(ow.x[0]), r3(ow.x[1])], [-17.2, 3.22]);
  check('...and NOT re-centred on its own box',
    r3(ow.x[0]) === -10.21 && r3(ow.x[1]) === 10.21, false);
  check('the wall is still 20.42 mm across - reseating moved it, it did not resize it',
    r3(ow.x[1] - ow.x[0]), 20.42);
  // Support sits to the +X side of the walls in the file and must still.
  const sup = register.world['Support'];
  check('Support is still to the +X side of the walls, as the slicer placed it',
    sup.x[0] > ow.x[1], true);
  // Every group shares one vertical datum: they all start at the first layer.
  const datums = Object.values(register.world).map((b) => r3(b.y[0]));
  check('every feature group sits on ONE plate datum', new Set(datums).size, 1);
  // And the highlight is inside the Support interface group's own box.
  const si = register.world['Support interface'];
  const inside = register.hi.x[0] >= si.x[0] - 0.05 && register.hi.x[1] <= si.x[1] + 0.05 &&
                 register.hi.z[0] >= si.z[0] - 0.05 && register.hi.z[1] <= si.z[1] + 0.05 &&
                 register.hi.y[0] >= si.y[0] - 0.05 && register.hi.y[1] <= si.y[1] + 0.05;
  check('the scrub highlight lands ON the Support interface geometry it marks', inside, true);
  console.log('       interface box x ' + si.x.map(r3) + ' y ' + si.y.map(r3) + ' z ' + si.z.map(r3));
  console.log('       highlight  box x ' + register.hi.x.map(r3) + ' y ' + register.hi.y.map(r3) +
              ' z ' + register.hi.z.map(r3));

  // -----------------------------------------------------------------------
  console.log('\n--- the slider steps LINE by line, not just layer by layer ---');
  const sliderRange = await page.evaluate(() => {
    window.NSO_TOOLPATH.setCursor(0);   // the register section above left it parked
    const s = document.getElementById('tp-slider');
    return { min: s.min, max: s.max, step: s.step, value: s.value };
  });
  check('the slider spans every move, one step per move',
    sliderRange, { min: '0', max: '50', step: '1', value: '0' });

  // Walk the first layer move by move and confirm each stop is ONE move, and
  // that consecutive stops are different moves on the same layer - which is
  // exactly what "not just jumping whole layers" has to mean.
  const walk = await page.evaluate(() => {
    const T = window.NSO_TOOLPATH;
    const s = T.getSession();
    const out = [];
    for (let i = 0; i < 6; i++) {
      T.setCursor(i);
      const sel = T.selection();
      const mv = s.moves[s.cursor];
      const hi = s.overlay.children[1].geometry.attributes.position.count / 3;  // triangles
      const ctx = s.overlay.children[0].geometry.attributes.position.count / 3;
      out.push({ cursor: s.cursor, sel: sel.length, layer: mv.layer, feature: mv.feature,
                 hiTris: hi, ctxTris: ctx,
                 w: Math.round(mv.width * 1000) / 1000,
                 deg: Math.round(mv.angle * 180 / Math.PI) });
    }
    return out;
  });
  check('six consecutive stops are six different lines',
    walk.map((w) => w.cursor), [0, 1, 2, 3, 4, 5]);
  check('every stop selects exactly ONE move', walk.every((w) => w.sel === 1), true);
  check('every stop is still on layer 1 - it stepped within the layer, not past it',
    walk.every((w) => w.layer === 0), true);
  check('the highlight is exactly one line solid (12 triangles) at every stop',
    walk.every((w) => w.hiTris === 12), true);
  check('the rest of the layer is drawn as faint context, and it is the rest',
    walk.every((w) => w.ctxTris === (17 - 1) * 12), true);
  check('the walk crosses a feature boundary within the layer',
    new Set(walk.map((w) => w.feature)).size > 1, true);
  console.log('       ' + walk.map((w) => `#${w.cursor} ${w.feature} ${w.w}mm ${w.deg}deg`).join(' | '));

  // The readout a user reads while scrubbing.
  await page.evaluate(() => window.NSO_TOOLPATH.setCursor(2));
  const readout = await page.evaluate(() => ({
    line: document.getElementById('tp-readout').textContent,
    detail: document.getElementById('tp-detail').textContent
  }));
  check('the readout names the line within its layer',
    /Line 3 \/ 51/.test(readout.line) && /line 3 \/ 17 on this layer/.test(readout.line), true);
  check('the readout reports the measured width and angle of THAT line',
    /0\.420 mm wide x 0\.200 mm tall/.test(readout.detail) && /180\.0 deg/.test(readout.detail), true);
  console.log('       ' + readout.line);
  console.log('       ' + readout.detail);

  // The +1 line / layer buttons are real buttons, and they differ.
  await page.evaluate(() => window.NSO_TOOLPATH.setCursor(0));
  await page.click('#btn-tp-next');
  check('"+1 line" advances exactly one move',
    await page.evaluate(() => window.NSO_TOOLPATH.getSession().cursor), 1);
  await page.click('#btn-tp-layer-up');
  const afterLayer = await page.evaluate(() => {
    const s = window.NSO_TOOLPATH.getSession();
    return { cursor: s.cursor, layer: s.moves[s.cursor].layer, start: s.layers[1].moveStart };
  });
  check('"layer up" jumps to the first line of the next layer',
    [afterLayer.layer, afterLayer.cursor], [1, afterLayer.start]);
  await page.click('#btn-tp-layer-down');
  check('"layer down" comes back to layer 1',
    await page.evaluate(() => window.NSO_TOOLPATH.getSession().moves[window.NSO_TOOLPATH.getSession().cursor].layer), 0);
  check('the slider element follows the buttons',
    await page.evaluate(() => document.getElementById('tp-slider').value), '0');

  // Scrubbing must not touch the imported models.
  const modelsBefore = await page.evaluate(() =>
    state.models.map((m) => m.rawTris.length).join(','));
  await page.evaluate(() => { for (let i = 0; i < 51; i++) window.NSO_TOOLPATH.setCursor(i); });
  check('scrubbing the whole toolpath changes no model geometry',
    await page.evaluate(() => state.models.map((m) => m.rawTris.length).join(',')), modelsBefore);
  check('scrubbing pushes nothing onto the undo stack',
    await page.evaluate(() => state.undoStack.length), imported.undo);

  // -----------------------------------------------------------------------
  console.log('\n--- scrub to the Support interface and Extract Line ---');
  const parked = await page.evaluate(() => {
    const T = window.NSO_TOOLPATH;
    const s = T.getSession();
    const i = s.moves.findIndex((m) => m.feature === 'Support interface');
    T.setCursor(i);
    return { i, feature: s.moves[i].feature, layer: s.moves[i].layer };
  });
  check('parked on the first Support interface line',
    [parked.feature, parked.layer], ['Support interface', 0]);

  await page.selectOption('#tp-scope', 'feature');
  const scoped = await page.evaluate(() => {
    const T = window.NSO_TOOLPATH;
    T.setCursor(T.getSession().cursor);
    return { sel: T.selection().length, label: document.getElementById('btn-tp-extract').textContent };
  });
  check('scope "this feature, on this layer" selects the three interface lines', scoped.sel, 3);
  check('the Extract button says how much it will take', scoped.label, 'Extract Line (3 lines)');

  const undoBefore = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-tp-extract');
  const extracted = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { count: state.models.length, name: m.name, tris: m.rawTris.length / 9, axis: m.rawAxis,
             undo: state.undoStack.length,
             status: (document.getElementById('status') || {}).textContent || '' };
  });
  check('Extract Line added a sixth model', extracted.count, 6);
  check('it is named for the feature and layer it came from',
    /Support interface L1 x3$/.test(extracted.name), true);
  check('it is 3 line solids, 36 triangles', extracted.tris, 36);
  check('it is an ordinary model - rawTris in file axes, like any import', extracted.axis, 'zup');
  check('Extract Line is undoable', extracted.undo, undoBefore + 1);
  check('the app reports the extraction', /Extract Line ok/.test(extracted.status), true);
  console.log('       ' + extracted.status);

  // Undo really undoes it, then redo the extraction for the export below.
  await page.click('#btn-undo');
  check('undo removes the extracted object', await page.evaluate(() => state.models.length), 5);
  await page.click('#btn-tp-extract');
  check('extracting again brings it back', await page.evaluate(() => state.models.length), 6);

  // -----------------------------------------------------------------------
  console.log('\n--- export it alone, then re-open the file from disk ---');
  // Select the extracted object so "Download selected" writes that and nothing
  // else, then press the app's own button - no test-only export path.
  await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    state.editId = m.id;
  });
  const activeName = await page.evaluate(() => getActiveModel().name);
  check('the extracted object is the active model', /Support interface L1 x3$/.test(activeName), true);

  await page.selectOption('#export-format', 'stl');
  page.once('dialog', (d) => d.accept());
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-model'),
  ]);
  const file = join(outDir, 'extracted.stl');
  await dl.saveAs(file);
  console.log(`       saved ${file}`);

  const buf = await readFile(file);
  const tris = stlTriangles(buf);
  check('the exported STL is a valid binary STL',
    buf.length === 84 + 50 * buf.readUInt32LE(80), true);
  check('it holds exactly the 3 extracted lines - 36 triangles, nothing else', tris.length, 36);

  // Bounds: the three interface lines are y in [20.8, 23.2], x in [34.5, 43.5],
  // one layer 0.2 mm tall. Anything else on the plate would blow this out. The
  // exporter centres on the plate, so compare SPANS, which are invariant.
  const flat = tris.flat();
  const xs = flat.filter((_, i) => i % 3 === 0);
  const ys = flat.filter((_, i) => i % 3 === 1);
  const zs = flat.filter((_, i) => i % 3 === 2);
  const span = (a) => Math.round((Math.max(...a) - Math.min(...a)) * 1000) / 1000;
  // The bead's width is ACROSS the line, so the run direction gets no extra:
  // X is the bare 9 mm the nozzle travelled, Y is the 2 mm between the outer
  // two lines plus one full 0.4 mm width. That asymmetry is the geometry being
  // right, and it is why both are asserted rather than a bounding box.
  check('X span is the bare 9 mm interface run', span(xs), 9);
  check('Y span is the three lines 1 mm apart plus one line width', span(ys), 2.4);
  check('Z span is ONE layer - no other layer came with it', span(zs), 0.2);

  // And it is solid: no open edges, so nothing leaks.
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const vid = new Map(); const ids = [];
  for (const t of tris) {
    for (let v = 0; v < 3; v++) {
      const k = t.slice(v * 3, v * 3 + 3).map((n) => n.toFixed(4)).join(',');
      if (!vid.has(k)) vid.set(k, vid.size);
      ids.push(vid.get(k));
    }
  }
  const counts = new Map();
  for (let t = 0; t < ids.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const k = key(ids[t + a], ids[t + b]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let open = 0; counts.forEach((c) => { if (c === 1) open++; });
  check('the exported object has no open edges - nothing leaks', open, 0);
  check('it is 3 separate bead solids, 8 corners each', vid.size, 24);

  // The same object out through the 3MF route, since Export offers both.
  await page.selectOption('#export-format', '3mf');
  page.once('dialog', (d) => d.accept());
  const [dl3] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-model'),
  ]);
  const file3 = join(outDir, 'extracted.3mf');
  await dl3.saveAs(file3);
  check('"Download selected" with Format = 3MF writes a .3mf',
    /\.3mf$/.test(dl3.suggestedFilename()), true);
  const read3 = await page.evaluate(async ([b]) => {
    const res = await window.NSO3MFRead.parse3MF(new Uint8Array(b), { name: 'extracted.3mf' });
    return res.objects.map((o) => ({ name: o.name, tris: o.positions.length / 9 }));
  }, [Array.from(await readFile(file3))]);
  check('the 3MF re-opens as ONE object - nothing else on the plate', read3.length, 1);
  check('and it is the 3 extracted lines, 36 triangles', read3[0].tris, 36);
  console.log(`       saved ${file3} -> ${JSON.stringify(read3)}`);

  // -----------------------------------------------------------------------
  console.log('\n--- an unsliced project still imports as geometry ---');
  const plain = Array.from(await readFile('fixtures/3mf/pa_pattern.3mf'));
  const modelsWas = await page.evaluate(() => state.models.length);
  await page.evaluate(([b]) => {
    handleFiles([new File([new Uint8Array(b)], 'pa_pattern.3mf')]);
  }, [plain]);
  await page.waitForFunction(`state.models.length === ${modelsWas + 1}`, null, { timeout: 20000 });
  check('a plain .3mf still goes to the geometry importer',
    await page.evaluate(() => state.models[state.models.length - 1].name), 'Cube');

  check('no uncaught page errors', errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
