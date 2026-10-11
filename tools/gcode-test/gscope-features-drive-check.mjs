/**
 * nest-optimizer / tools/gcode-test / gscope-features-drive-check.mjs
 *
 * READ docs/GSCOPE-FEATURES.md for the four rules; tools/nso_face_features_test.js
 * holds them to nso_features.js's ground truth in Node. This drives the real
 * app in headless Chromium and checks the four rows under Flange in G-scope's
 * Parts list - Handle, Bracket, Lid, Hinge. Every row in that list is a show /
 * hide toggle, the same model as a slice's All features list: nothing in it
 * isolates, and the list never leaves the screen.
 *
 *   1  EACH FEATURE ALONE (fixtures/features/feature-hull_<rule>.stl through
 *      G-scope's own Import): its row opens lit and switched on, with the
 *      numbers nso_face_features.js measures in Node, the feature drawn in its
 *      colour over the hull; the other rows - Flange included - read "none
 *      detected", dimmed, with the reason in the tooltip, and a click on one
 *      changes nothing and says why. A real click on the hull's own row
 *      switches the hull off: the feature is then drawn alone, the list still
 *      up, nothing isolated. Select shown takes exactly the feature - its
 *      bounds the declared bounds - and Export as STL writes exactly it: the
 *      same triangles, its declared volume and bounds, a clean solid.
 *   2  ALL FIVE ON ONE HULL (feature-hull_all.stl): every row lit. Every row
 *      switched off, one real click at a time, leaves nothing drawn; switched
 *      back on one at a time, each click draws exactly what it adds. Each
 *      feature alone (every other row off) is exactly that feature, and
 *      nothing of the others. With the hull on, a feature is a highlight on
 *      it: Select shown takes the hull and not the feature twice. Crop takes a
 *      band out of one as a new piece, as it does for the flange.
 *   3  A SLICE: no detector rows at all - a slice has no closed surface to
 *      look at, and its one list is its features. Asked anyway, a rule says so.
 *   4  SCREENSHOTS of each feature alone, and the hinge on the hull.
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
                                  checked: e.getAttribute('aria-checked'), title: e.title,
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

/**
 * What G-scope draws and holds right now: every visible mesh in the overview
 * (a part, or a detector row's feature) with its colour, whether anything is
 * isolated, the list's own state, and the selection.
 */
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
      listUp: !!(float.offsetWidth && float.offsetHeight) && !float.classList.contains('collapsed'),
      rows: document.querySelectorAll('#ms-legend-float .ms-legend-item').length,
      checked: Array.from(document.querySelectorAll('#ms-legend-float .ms-legend-item'))
        .filter((e) => e.getAttribute('aria-checked') === 'true')
        .map((e) => e.dataset.group || e.dataset.detected),
      sel: M.selection().map((o) => o.name), by: M.selectionSource(),
      bounds: M.selection().length === 1 ? M.selection()[0].bounds : null,
      exportShown: getComputedStyle(document.getElementById('ms-export-row')).display !== 'none',
      info: document.getElementById('ms-info').textContent,
    };
  });
}

/** A real click on a row of the Parts list: a part's (by name) or a detector's (by rule). */
async function clickRow(page, key) {
  const sel = ['flange', ...RULES].includes(key) ? `#ms-detected [data-detected="${key}"]` : `#ms-legend [data-group="${key}"]`;
  await page.click(sel);
  return view(page);
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
    const hull = `feature-hull_${rule}`, fname = `${hull} - ${NAME[rule]}`;
    const rec = feat(stl, rule);
    const node = FF.detect(readSTL(await readFile(join(ROOT, FIX, stl))))[rule].found[0];
    console.log(`\n  ${stl}`);
    await importFile(page, `${FIX}/${stl}`);
    const t = await rows(page);
    check('the Parts list: Flange, then Handle, Bracket, Lid, Hinge, one row each', t.order, ['flange', ...RULES]);
    const want = `${NAME[rule]} (${FF.summary(rule, node)}, ${node.triangles} tri)`;
    check(`the ${NAME[rule]} row opens lit and switched on, with the numbers Node measures`,
      [t.rows[rule].text, t.rows[rule].dim, t.rows[rule].checked, t.rows[rule].visible], [want, false, 'true', true]);
    console.log('       ' + t.rows[rule].text);
    const others = ['flange', ...RULES].filter((r) => r !== rule);
    check('the other four read "none detected", dimmed and off', others.map((r) => [t.rows[r].text, t.rows[r].dim, t.rows[r].checked]),
      others.map((r) => [`${NAME[r]} - none detected`, true, 'false']));
    check('...each saying why in its tooltip', others.every((r) => new RegExp(`^No ${r}: .+`).test(t.rows[r].title)), true);
    console.log('       ' + others.map((r) => t.rows[r].title).join('\n       '));
    const obj = t.states[rule].objects[0];
    check('what the page found is what Node finds: triangles, volume', [obj.triangles, obj.feature.volume.toFixed(3)],
      [node.triangles, rec.volume.toFixed(3)]);

    const v0 = await view(page);
    check('it opens drawn in its row\'s colour over the hull, nothing isolated', [v0.drawn, v0.detail, v0.badge],
      [[[hull, v0.drawn.find((d) => d[0] === hull)[1]], [fname, COLOR[rule]]], false, 'Whole part']);

    const nr = others[0];
    const vn = await clickRow(page, nr);
    check(`a click on "${NAME[nr]} - none detected" changes nothing and says why`,
      [vn.drawn, vn.checked, new RegExp(`^No ${nr} detected\\.`).test(vn.info)], [v0.drawn, v0.checked, true]);

    const v1 = await clickRow(page, hull);
    check('a real click on the hull\'s row switches it off: the feature is drawn alone, in its colour',
      v1.drawn, [[fname, COLOR[rule]]]);
    check('...nothing isolated and nothing selected; the list stays up, every row in it',
      [v1.detail, v1.overview, v1.badge, v1.sel, v1.listUp, v1.rows], [false, true, 'Whole part', [], true, 6]);
    await shot(page, `${rule}-alone.png`, `the ${rule} alone`);

    await page.click('#ms-btn-select-visible');
    const v2 = await view(page);
    check('Select shown takes exactly what is checked: the feature', [v2.sel, v2.by, v2.exportShown],
      [[fname], 'visible', true]);
    check('...whose geometry is exactly the feature\'s declared bounds', pb(v2.bounds), tb(rec.truth.bounds));

    const ex = await exportStl(page, `exported-${rule}.stl`);
    check('Export as STL names the file for it', ex.name, `feature-hull_${rule}_-_${NAME[rule]}.stl`);
    check('it writes exactly the feature: the same triangles', ex.soup.length / 9, node.triangles);
    check('...its declared volume and bounds', [volume(ex.soup).toFixed(2), tb(bounds(ex.soup))],
      [rec.volume.toFixed(2), tb(rec.truth.bounds)]);
    const chi = 2 + (rec.topology.bodies || []).reduce((s, g) => s + 2 - 2 * g, 0);
    check('...a clean solid (verdict, open, nm, inconsistent, chi)', validate(ex.path), ['PASS', 0, 0, 0, chi]);
  }

  // =======================================================================
  console.log('\n--- 2. all five on one hull ---');
  // =======================================================================
  const ALL = 'feature-hull_all.stl';
  const HULL = 'feature-hull_all';
  const DET = ['flange', ...RULES];
  await importFile(page, `${FIX}/${ALL}`);
  const ta = await rows(page);
  check('every row lit and on: Flange, Handle, Bracket, Lid, Hinge',
    DET.map((r) => [ta.rows[r].status, ta.rows[r].dim, ta.rows[r].checked]), DET.map(() => ['found', false, 'true']));
  console.log('       ' + DET.map((r) => ta.rows[r].text).join('\n       '));
  const fn = (r) => `${HULL} - ${NAME[r]}`;
  const full = await view(page);
  check('the whole list opens checked: the hull and the five', full.checked, [HULL, ...DET]);
  check('...the hull and all five drawn', full.drawn.map((d) => d[0]).sort(), [HULL, ...DET.map(fn)].sort());

  // Empty, one real click at a time.
  for (const k of [HULL, ...DET]) await clickRow(page, k);
  const empty = await view(page);
  check('every row switched off: nothing drawn, nothing checked, the list still up',
    [empty.drawn, empty.checked, empty.listUp, empty.rows, empty.detail], [[], [], true, 6, false]);
  check('...and nothing is shown to take', await page.evaluate(() => window.NSO_MICROSCOPE.shownCount()), 0);
  // Back on, one at a time: each click adds exactly its own.
  const order = [...DET, HULL];
  for (let i = 0; i < order.length; i++) {
    const vi = await clickRow(page, order[i]);
    const want = order.slice(0, i + 1).map((k) => (k === HULL ? HULL : fn(k))).sort();
    check(`on again, one at a time (${i + 1}/${order.length}, ${order[i]}): exactly those drawn`,
      vi.drawn.map((d) => d[0]).sort(), want);
  }

  for (const rule of RULES) {
    const rec = feat(ALL, rule);
    // This feature alone: everything else off, by real clicks.
    for (const k of [HULL, ...DET.filter((r) => r !== rule)]) {
      if ((await view(page)).checked.includes(k)) await clickRow(page, k);
    }
    if (!(await view(page)).checked.includes(rule)) await clickRow(page, rule);
    await page.click('#ms-btn-select-visible');
    const iso = await view(page);
    check(`${NAME[rule]} alone: drawn and taken, nothing of the others`, [iso.drawn, iso.sel, iso.detail],
      [[[fn(rule), COLOR[rule]]], [fn(rule)], false]);
    check('...exactly its declared bounds', pb(iso.bounds), tb(rec.truth.bounds));
    check('...and only its own row checked', iso.checked, [rule]);
    await clickRow(page, rule);                                   // off again for the next
  }
  // The hull and the hinge: the hinge highlighted on the hull.
  await page.click('#ms-btn-show-all');
  for (const k of DET.filter((r) => r !== 'hinge')) await clickRow(page, k);
  await page.click('#ms-btn-select-visible');
  const hl = await view(page);
  check('the hull with the hinge on: both drawn, the hinge in its colour over it',
    hl.drawn.map((d) => d[0]).sort(), [HULL, fn('hinge')].sort());
  check('...and Select shown takes the hull once - the hinge is inside it, not exported twice', hl.sel, [HULL]);
  await shot(page, 'all-hinge-highlighted.png', 'the hinge highlighted on the whole piece');

  // Crop: the handle's middle band, as a new piece (a feature is not a plate piece).
  await page.click('#ms-btn-show-all');
  for (const k of [HULL, ...DET.filter((r) => r !== 'handle')]) await clickRow(page, k);
  await page.click('#ms-btn-select-visible');
  check('the handle alone, selected for Crop', (await view(page)).sel, [fn('handle')]);
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
  console.log('\n--- 3. a slice: no detector rows ---');
  // =======================================================================
  await page.click('#btn-microscope');
  await page.setInputFiles('#ms-input', join(ROOT, SLICE));
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d && d.kind === 'toolpath';
  }, null, { timeout: 60000 });
  await frames(page);
  const ts = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE;
    return { rows: document.querySelectorAll('#ms-detected .ms-legend-item').length,
             title: document.getElementById('ms-legend-title').textContent,
             states: M.featureRules().map((r) => [M.feature(r).status, /closed surface/.test(M.feature(r).reason)]) };
  });
  check('a slice lists no detector rows, only its All features', [ts.rows, ts.title], [0, 'All features']);
  check('each of the four, asked: not on a slice, and why', ts.states, RULES.map(() => ['unavailable', true]));
  const sc = await page.evaluate(() => ({ on: window.NSO_MICROSCOPE.toggleDetected('lid'),
    sel: window.NSO_MICROSCOPE.selection().length, info: document.getElementById('ms-info').textContent }));
  check('switched on there anyway, it stays off, selects nothing and says it is not available',
    [sc.on, sc.sel, /^Lid: not available here\./.test(sc.info)], [false, 0, true]);

  check('no page errors', errors, []);
  await browser.close();
  served.srv.close();
  const failed = check.report();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
