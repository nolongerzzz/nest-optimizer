/**
 * nest-optimizer / tools/gcode-test / gscope-features-drive-check.mjs
 *
 * READ docs/GSCOPE-FEATURES.md for the four rules; tools/nso_face_features_test.js
 * holds them to nso_features.js's ground truth in Node. This drives the real
 * app in headless Chromium and checks the four rows under Flange in G-scope's
 * Parts list - Handle, Bracket, Lid, Hinge:
 *
 *   1  EACH FEATURE ALONE (fixtures/features/feature-hull_<rule>.stl through
 *      G-scope's own Import): its row is lit with the numbers nso_face_features.js
 *      measures in Node, and the other rows - Flange included - read "none
 *      detected", dimmed, with the reason in the tooltip. A real click on the
 *      row isolates it: alone, in its colour, its bounds exactly the feature's
 *      declared bounds. Export as STL writes exactly that feature: the same
 *      triangles, its declared volume and bounds, a clean solid.
 *   2  ALL FIVE ON ONE HULL (feature-hull_all.stl): every row lit, and each
 *      click isolates its own feature and nothing of the others. Back puts the
 *      hull back with the feature highlighted on it; Crop takes a band out of
 *      one as a new piece, as it does for the flange.
 *   3  A SLICE: every row says it cannot look, and a click says so.
 *   4  SCREENSHOTS of each feature isolated.
 *
 * Usage: node tools/gcode-test/gscope-features-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const require = createRequire(import.meta.url);
const FF = require(join(ROOT, 'nso_face_features.js'));
const SHOTS = join(ROOT, 'tools', 'gscope-features-out');
const FIX = 'fixtures/features';
const MANIFEST = JSON.parse(readFileSync(join(ROOT, FIX, 'features.json'), 'utf8'));
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const RULES = ['handle', 'bracket', 'lid', 'hinge'];
const NAME = { flange: 'Flange', handle: 'Handle', bracket: 'Bracket', lid: 'Lid', hinge: 'Hinge' };
const COLOR = { handle: 0x3fb6ff, bracket: 0xb57bff, lid: 0x3fd98a, hinge: 0xffd23f };

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
function volume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
          s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}
const r3 = (a) => a.map((x) => Math.round(x * 1000) / 1000 + 0);
const pb = (b) => r3([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ]);
const tb = (b) => r3([b.lo[0], b.lo[1], b.lo[2], b.hi[0], b.hi[1], b.hi[2]]);
const feat = (stl, type) => MANIFEST.entries.find((e) => e.stl === stl).features.find((f) => f.type === type);

function validate(file) {
  const j = JSON.parse(execFileSync('python3', [join(ROOT, 'tools', 'mesh_validate.py'), file, '--no-selfint', '--json']).toString());
  return [j.verdict, j.open_edges, j.nonmanifold_edges, j.inconsistent_winding_edges, j.euler_characteristic];
}

async function frames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function shot(page, file, label) {
  await frames(page);
  const path = join(SHOTS, file);
  await page.locator('#microscope').screenshot({ path });
  const size = (await stat(path)).size;
  console.log(`       ${file}  ${(size / 1024).toFixed(0)} kB`);
  check(`${label}: the canvas is a drawn view`, size > 5000, true);
}

/** Wait for every row to finish looking, and read the rows. */
async function rows(page) {
  await page.waitForFunction(() => {
    const M = window.NSO_MICROSCOPE, f = M.flange();
    return f && f.status !== 'pending' && M.featureRules().every((r) => M.feature(r).status !== 'pending');
  }, null, { timeout: 60000 });
  await frames(page);
  return page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    const out = {};
    document.querySelectorAll('#ms-detected .ms-legend-item').forEach((e) => {
      out[e.dataset.detected] = { text: e.textContent, status: e.dataset.status, dim: e.classList.contains('dim'),
                                  active: e.classList.contains('active'), title: e.title,
                                  visible: !!(e.offsetWidth && e.offsetHeight) };
    });
    const states = {};
    M.featureRules().forEach((r) => { states[r] = M.feature(r); });
    return { order: Array.from(document.querySelectorAll('#ms-detected .ms-legend-item')).map((e) => e.dataset.detected),
             rows: out, states, flange: M.flange() };
  });
}

async function importFile(page, rel) {
  const base = rel.split('/').pop().replace(/\.stl$/, '');
  await page.setInputFiles('#ms-input', join(ROOT, rel));
  await page.waitForFunction((b) => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && d.name.indexOf(b) === 0;
  }, base, { timeout: 30000 });
}

/** A real click on a row, and what it did. */
async function clickRow(page, rule) {
  await page.click(`#ms-detected [data-detected="${rule}"]`);
  await frames(page);
  return page.evaluate((rule) => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    const sel = M.selection();
    return {
      sel: sel.map((o) => o.name), by: M.selectionSource(),
      bounds: sel.length === 1 ? sel[0].bounds : null,
      detail: v.detailGroup.visible, overview: v.overviewGroup.visible,
      drawn: v.detailGroup.children.map((c) => [c.type, c.material.color.getHex()]),
      active: document.querySelector(`#ms-detected [data-detected="${rule}"]`).classList.contains('active'),
      exportShown: getComputedStyle(document.getElementById('ms-export-row')).display !== 'none',
      info: document.getElementById('ms-info').textContent,
    };
  }, rule);
}

async function exportStl(page, file) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#ms-btn-export-stl'),
  ]);
  const path = join(SHOTS, file);
  await dl.saveAs(path);
  return { name: dl.suggestedFilename(), path, soup: readSTL(await readFile(path)) };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!(window.NSO_MICROSCOPE && window.NSO_FaceFeatures), null, { timeout: 30000 });
  await page.click('#btn-microscope');                       // empty plate: panel + chooser

  // =======================================================================
  console.log('\n--- 1. each feature alone: its row lit, the others "none" ---');
  // =======================================================================
  for (const rule of RULES) {
    const stl = `feature-hull_${rule}.stl`;
    const rec = feat(stl, rule);
    const node = FF.detect(readSTL(await readFile(join(ROOT, FIX, stl))))[rule].found[0];
    console.log(`\n  ${stl}`);
    await importFile(page, `${FIX}/${stl}`);
    const t = await rows(page);
    check('the Parts list: Flange, then Handle, Bracket, Lid, Hinge, one row each', t.order, ['flange', ...RULES]);
    const want = `${NAME[rule]} (${FF.summary(rule, node)}, ${node.triangles} tri)`;
    check(`the ${NAME[rule]} row is lit with the numbers Node measures`, [t.rows[rule].text, t.rows[rule].dim, t.rows[rule].visible],
      [want, false, true]);
    console.log('       ' + t.rows[rule].text);
    const others = ['flange', ...RULES].filter((r) => r !== rule);
    check('the other four read "none detected", dimmed', others.map((r) => [t.rows[r].text, t.rows[r].dim]),
      others.map((r) => [`${NAME[r]} - none detected`, true]));
    check('...each saying why in its tooltip', others.every((r) => new RegExp(`^No ${r}: .+`).test(t.rows[r].title)), true);
    console.log('       ' + others.map((r) => t.rows[r].title).join('\n       '));
    const obj = t.states[rule].objects[0];
    check('what the page found is what Node finds: triangles, volume', [obj.triangles, obj.feature.volume.toFixed(3)],
      [node.triangles, rec.volume.toFixed(3)]);

    const iso = await clickRow(page, rule);
    check('a click isolates it: the selection is the feature, from its row', [iso.sel, iso.by],
      [[`feature-hull_${rule} - ${NAME[rule]}`], rule]);
    check('alone, as one solid, in the row\'s colour', [iso.detail, iso.overview, iso.drawn],
      [true, false, [['Mesh', COLOR[rule]]]]);
    check('the row is lit while it is the selection; Export is offered', [iso.active, iso.exportShown], [true, true]);
    check('the info line names it', new RegExp(`${NAME[rule]} \\(detected\\).*feature-hull_${rule} - ${NAME[rule]}`).test(iso.info), true);
    check('the isolated geometry is exactly the feature\'s declared bounds', pb(iso.bounds), tb(rec.truth.bounds));
    await shot(page, `${rule}-isolated.png`, `the ${rule} isolated`);

    const ex = await exportStl(page, `exported-${rule}.stl`);
    check('Export as STL names the file for it', ex.name, `feature-hull_${rule}_-_${NAME[rule]}.stl`);
    check('it writes exactly the feature: the same triangles', ex.soup.length / 9, node.triangles);
    check('...its declared volume and bounds', [volume(ex.soup).toFixed(2), tb(bounds(ex.soup))],
      [rec.volume.toFixed(2), tb(rec.truth.bounds)]);
    const chi = 2 + (rec.topology.bodies || []).reduce((s, g) => s + 2 - 2 * g, 0);
    check('...a clean solid (verdict, open, nm, inconsistent, chi)', validate(ex.path), ['PASS', 0, 0, 0, chi]);
    await page.click('#ms-btn-back');
    await frames(page);
  }

  // =======================================================================
  console.log('\n--- 2. all five on one hull ---');
  // =======================================================================
  const ALL = 'feature-hull_all.stl';
  await importFile(page, `${FIX}/${ALL}`);
  const ta = await rows(page);
  check('every row lit: Flange, Handle, Bracket, Lid, Hinge',
    ['flange', ...RULES].map((r) => [ta.rows[r].status, ta.rows[r].dim]), ['flange', ...RULES].map(() => ['found', false]));
  console.log('       ' + ['flange', ...RULES].map((r) => ta.rows[r].text).join('\n       '));
  for (const rule of RULES) {
    const rec = feat(ALL, rule);
    const iso = await clickRow(page, rule);
    check(`${NAME[rule]}: a click isolates it and nothing else`, [iso.sel, iso.by, iso.drawn],
      [[`feature-hull_all - ${NAME[rule]}`], rule, [['Mesh', COLOR[rule]]]]);
    check('...exactly its declared bounds', pb(iso.bounds), tb(rec.truth.bounds));
    check('...and only its own row is lit', await page.evaluate(() =>
      Array.from(document.querySelectorAll('#ms-detected .ms-legend-item.active')).map((e) => e.dataset.detected)), [rule]);
  }
  await shot(page, 'all-hinge-isolated.png', 'the hinge isolated off the whole piece');
  await page.click('#ms-btn-back');
  await frames(page);
  const backed = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    return [v.overviewGroup.visible, v.detailGroup.visible, v.highlightGroup.children.length];
  });
  check('Back: the whole piece again, the hinge highlighted on it', backed, [true, false, 1]);
  await shot(page, 'all-hinge-highlighted.png', 'the hinge highlighted on the whole piece');

  // Crop: the handle's middle band, as a new piece (a feature is not a plate piece).
  await clickRow(page, 'handle');
  const before = await page.evaluate(() => state.models.length);
  const crop = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    M.setZRangeMm(19, 21);
    M.flushView();
    const why = M.cropReason();
    const read = document.getElementById('ms-crop-read').textContent;
    const res = M.cropZBand();
    const m = state.models[state.models.length - 1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < m.rawTris.length; i += 3) { if (m.rawTris[i] < lo) lo = m.rawTris[i]; if (m.rawTris[i] > hi) hi = m.rawTris[i]; }
    return { why, read, ok: res.ok, name: m.name, zSpan: hi - lo, models: state.models.length };
  });
  check('Crop is offered on the handle, as a new piece', [crop.why, /as a new piece on the plate/.test(crop.read)], ['', true]);
  check('Crop takes the band out, one new piece named for the handle', [crop.ok, crop.models - before, crop.name],
    [true, 1, 'feature-hull_all - Handle - cropped']);
  // The band snaps to Crop's layer grid, as it does for the flange (whose check allows 0.15).
  check('about 2 mm shorter: the 8 mm rod, less the band', Math.abs(crop.zSpan - 6) < 0.2, true);
  console.log(`       cropped handle Z span ${crop.zSpan.toFixed(3)} mm`);

  // =======================================================================
  console.log('\n--- 3. a slice: every row says it cannot look ---');
  // =======================================================================
  await page.click('#btn-microscope');
  await page.setInputFiles('#ms-input', join(ROOT, SLICE));
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && d.kind === 'toolpath';
  }, null, { timeout: 60000 });
  const ts = await rows(page);
  check('each of the four: not on a slice, and why', RULES.map((r) => [ts.rows[r].status, ts.rows[r].text, /closed surface/.test(ts.rows[r].title)]),
    RULES.map((r) => ['unavailable', `${NAME[r]} - not on a slice`, true]));
  await page.click('#ms-detected [data-detected="lid"]');
  const sc = await page.evaluate(() => ({ sel: window.NSO_MICROSCOPE.selection().length, info: document.getElementById('ms-info').textContent }));
  check('a click there selects nothing and says it is not available', [sc.sel, /^Lid: not available here\./.test(sc.info)], [0, true]);

  check('no page errors', errors, []);
  await browser.close();
  served.srv.close();
  const failed = check.report();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
