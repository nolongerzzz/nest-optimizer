#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-one-list-drive-check.mjs
 *
 * One list per view, every row a show / hide toggle, and a box only when it
 * is asked for - driven through the real app in headless Chromium with real
 * clicks, on the part this was found on (library/tape_on-edge-single.stl: one
 * piece, a flange, no handle / bracket / lid / hinge).
 *
 *   1  SLICE VIEW SHOWS ONE LIST: All features, no tab strip in the page, no
 *      Overhang / Conflict / Flange rows. Every row off is an empty view;
 *      every row back on is the slice again.
 *   2  NORMAL SHOWS ONE LIST: Parts - the piece, then the five detector rows
 *      under their rule; titled "Parts". Every row off (real clicks) is an
 *      empty view; back on one at a time, each click draws exactly its own;
 *      the four "none detected" rows stay off when clicked and say why. The
 *      list is on screen throughout and nothing is isolated.
 *   3  EXPORT IS EXACTLY WHAT IS CHECKED: the flange alone (piece off) -
 *      Select shown, Export as STL: the flange's own triangles and bounds, a
 *      clean solid; Export to plate: the same triangles as a new piece. The
 *      piece alone (flange off): its own 46924 triangles. Both on: the piece
 *      once - the flange is inside it, not exported twice.
 *   4  BOXES ON A TOGGLE-BUILT VIEW: with the piece off, a real click on the
 *      flange drops a box that catches the flange; Isolate all boxes shows it
 *      alone with the list still up; switching the flange off takes it out of
 *      the selection; Clear all boxes clears. With both on, a box over the
 *      flange takes the piece once.
 *   5  A BOX ONLY WHEN ASKED: a fresh piece opens in orbit; a real click on it
 *      drops no box and selects nothing. Click to select region, then the same
 *      click: a box drops and catches the piece, as before.
 *   6  SCREENSHOTS of each, and no page errors.
 *
 * Usage: node tools/gcode-test/gscope-one-list-drive-check.mjs   (npm run gcode:gscope-one-list)
 */
import { chromium } from 'playwright';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'gscope-one-list-out');
const PART = 'library/tape_on-edge-single.stl';
const NAME = 'tape_on-edge-single';
const FLANGE = `${NAME} - Flange`;
const DET = ['flange', 'handle', 'bracket', 'lid', 'hinge'];

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
const r3 = (a) => a.map((x) => Math.round(x * 1000) / 1000 + 0);
const pb = (b) => r3([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ]);
const tb = (b) => r3([b.lo[0], b.lo[1], b.lo[2], b.hi[0], b.hi[1], b.hi[2]]);

function validate(file) {
  const j = JSON.parse(execFileSync('python3', [join(ROOT, 'tools', 'mesh_validate.py'), file, '--no-selfint', '--json']).toString());
  return [j.verdict, j.open_edges, j.nonmanifold_edges, j.inconsistent_winding_edges];
}

async function frames(page, n = 2) {
  for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}

async function shot(page, file, label) {
  await frames(page);
  const path = join(SHOTS, file);
  await page.locator('#microscope').screenshot({ path });
  const size = (await stat(path)).size;
  console.log(`       ${file}  ${(size / 1024).toFixed(0)} kB`);
  check(`${label}: screenshot written`, size > 5000, true);
}

/** What G-scope draws and holds right now. */
async function view(page) {
  await frames(page);
  return page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    const drawn = [];
    v.overviewGroup.children.forEach((c) => {
      const n = c.geometry && c.geometry.attributes.position ? c.geometry.attributes.position.count : 0;
      if (c.visible && n > 0) drawn.push(c.userData.feature);
    });
    const float = document.getElementById('ms-legend-float');
    const rows = Array.from(document.querySelectorAll('#ms-legend-float .ms-legend-item'));
    return {
      drawn: drawn.sort(), detail: v.detailGroup.visible, overview: v.overviewGroup.visible,
      detailDrawn: v.detailGroup.visible ? v.detailGroup.children.map((c) => c.userData.feature).sort() : [],
      badge: document.getElementById('ms-mode-badge').textContent,
      listUp: !!(float.offsetWidth && float.offsetHeight) && !float.classList.contains('collapsed'),
      title: document.getElementById('ms-legend-title').textContent,
      rows: rows.map((e) => e.dataset.group || e.dataset.detected),
      checked: rows.filter((e) => e.getAttribute('aria-checked') === 'true').map((e) => e.dataset.group || e.dataset.detected),
      tabsInPage: !!document.querySelector('.ms-legend-tabs, #ms-tab-legend, #ms-tab-detected, [role="tab"]'),
      sel: M.selection().map((o) => o.name || o.feature), by: M.selectionSource(), boxes: M.boxes().length,
      mode: M.mode(), info: document.getElementById('ms-info').textContent,
      exportShown: getComputedStyle(document.getElementById('ms-export-row')).display !== 'none',
    };
  });
}

const row = (page, key) => page.click(DET.includes(key) ? `#ms-detected [data-detected="${key}"]` : `#ms-legend [data-group="${key}"]`);

/** Screen point of a view-space point. */
async function screenOf(page, p) {
  return page.evaluate((q) => {
    const v = window.NSO_MICROSCOPE.getView();
    const c = new THREE.Vector3(q[0], q[1], q[2]).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
  }, p);
}
/** A point on the top of a drawn mesh (a part, or a detector row's feature), found by raycast. */
async function pointOn(page, which) {
  return page.evaluate((w) => {
    const v = window.NSO_MICROSCOPE.getView();
    const m = v.overviewMeshes[w] || v.detectedMeshes[w];
    const b = new THREE.Box3().setFromObject(m);
    const r = v.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    const targets = v.overviewGroup.children.filter((c) => c.visible);
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const p = new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * f, b.max.y, (b.min.z + b.max.z) / 2);
      const c = p.clone().project(v.camera);
      rc.setFromCamera(new THREE.Vector2(c.x, c.y), v.camera);
      const hit = rc.intersectObjects(targets, false)[0];
      if (hit && hit.object === m) return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
    }
    return null;
  }, which);
}

/** G-scope's own Import, a fresh document each time (the same file again included). */
async function importPart(page) {
  await page.evaluate(() => { window.__prevDoc = window.NSO_MICROSCOPE.getDoc(); document.getElementById('ms-input').value = ''; });
  await page.setInputFiles('#ms-input', join(ROOT, PART));
  await page.waitForFunction((n) => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    return M.isOpen() && d && d !== window.__prevDoc && d.kind === 'mesh' && d.name.indexOf(n) === 0 &&
      M.flange().status !== 'pending';
  }, NAME, { timeout: 60000 });
  await frames(page);
}

async function exportStl(page, file) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#ms-btn-export-stl')]);
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
  await page.waitForFunction(() => !!(window.NSO_MICROSCOPE && window.NSO_GSCOPE_SLICE && window.NSO_Flange), null, { timeout: 30000 });
  await page.click('#btn-microscope');                       // empty plate: panel + chooser
  await importPart(page);
  const truth = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc(), f = M.flange().objects[0];
    return { pieceTris: d.objects[0].triangles, flangeTris: f.triangles, flangeBounds: f.bounds };
  });
  console.log(`       ${NAME}: ${truth.pieceTris} triangles, flange ${truth.flangeTris}`);

  // =======================================================================
  console.log('\n--- 1. Slice view: one list, All features, no tabs ---');
  // =======================================================================
  await page.click('#ms-cam-slice');
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return !window.NSO_GSCOPE_SLICE.busy() && d && d.kind === 'toolpath' && !!d.nsoSlice;
  }, null, { timeout: 120000 });
  const s1 = await view(page);
  const groups = await page.evaluate(() => Object.keys(window.NSO_MICROSCOPE.getDoc().groups).filter((g) => g !== 'Travel').sort());
  check('Slice view: one list, titled All features, no tab strip in the page',
    [s1.title, s1.listUp, s1.tabsInPage], ['All features', true, false]);
  check('... one row per feature the slice printed, every one on, nothing else in it',
    [s1.rows.slice().sort(), s1.checked.slice().sort()], [groups, groups]);
  check(`... that is ${groups.length} rows`, s1.rows.length, groups.length);
  check('... no Overhang, Conflict, Flange or "not on a slice" rows',
    /Overhang:|Conflict:|Flange|not on a slice/.test(await page.textContent('#ms-legend-float')), false);
  await shot(page, '1-slice-one-list.png', 'Slice view, one list');
  for (const g of s1.rows) await row(page, g);
  const s0 = await view(page);
  check('every row off: an empty view, the list still up', [s0.drawn, s0.checked, s0.listUp], [[], [], true]);
  await shot(page, '1b-slice-all-off.png', 'Slice view, every row off');
  for (const g of s1.rows) await row(page, g);
  check('every row back on: the slice again', (await view(page)).drawn, s1.drawn);

  // =======================================================================
  console.log('\n--- 2. Normal: one list, Parts, every row a toggle ---');
  // =======================================================================
  await page.click('#ms-cam-normal');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh' &&
    window.NSO_MICROSCOPE.flange().status !== 'pending', null, { timeout: 60000 });
  const n1 = await view(page);
  check('Normal: one list, titled Parts (not "click to isolate"), no tab strip in the page',
    [n1.title, n1.listUp, n1.tabsInPage], ['Parts', true, false]);
  check('... the piece, then Flange, Handle, Bracket, Lid, Hinge', n1.rows, [NAME, ...DET]);
  check('... opening with the piece and the flange on - the four with nothing found off',
    n1.checked, [NAME, 'flange']);
  check('... both drawn: the piece, the flange over it', n1.drawn, [NAME, FLANGE].sort());
  check('... in orbit, nothing isolated', [n1.mode, n1.detail, n1.badge], ['orbit', false, 'Whole part']);
  const counts = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-detected .ms-legend-item'))
    .map((e) => [e.dataset.detected, e.textContent, e.title.split('\n')[0]]));
  check('the detector rows keep their numbers', counts[0][1], `Flange (2.94 mm, ${truth.flangeTris} tri)`);
  check('... and the four with nothing found keep their "none detected" and its tooltip',
    counts.slice(1).map((c) => [c[1], /^No \w+: .+/.test(c[2])]),
    DET.slice(1).map((r) => [`${r[0].toUpperCase()}${r.slice(1)} - none detected`, true]));
  await shot(page, '2-normal-one-list.png', 'Normal, one list');

  await row(page, NAME);
  await row(page, 'flange');
  const n0 = await view(page);
  check('every Parts row off (real clicks): an empty viewport', [n0.drawn, n0.checked], [[], []]);
  check('... the list still on screen, all six rows, nothing isolated, no Back to press',
    [n0.listUp, n0.rows.length, n0.detail, await page.isVisible('#ms-btn-back')], [true, 6, false, false]);
  check('... nothing shown to take', await page.evaluate(() => window.NSO_MICROSCOPE.shownCount()), 0);
  await shot(page, '2b-normal-all-off.png', 'Normal, every Parts row off');
  for (const r of DET.slice(1)) {
    await row(page, r);
    const vr = await view(page);
    check(`"${r}" - none detected: a click leaves it off and draws nothing, and says why`,
      [vr.checked, vr.drawn, new RegExp(`^No ${r} detected\\.`).test(vr.info)], [[], [], true]);
  }
  await row(page, 'flange');
  const nf = await view(page);
  check('back on one at a time - the flange: drawn alone', [nf.drawn, nf.checked], [[FLANGE], ['flange']]);
  await shot(page, '2c-normal-flange-alone.png', 'Normal, the flange alone');
  await row(page, NAME);
  const nb = await view(page);
  check('... then the piece: both again, the flange over it', [nb.drawn, nb.checked], [[NAME, FLANGE].sort(), [NAME, 'flange']]);
  await row(page, 'flange');
  const np = await view(page);
  check('... and the flange off with the piece on: the piece alone', [np.drawn, np.checked], [[NAME], [NAME]]);

  // =======================================================================
  console.log('\n--- 3. Export: exactly what is checked ---');
  // =======================================================================
  await page.click('#ms-btn-select-visible');
  const vp = await view(page);
  check('the piece alone: Select shown takes the piece', [vp.sel, vp.by, vp.exportShown], [[NAME], 'visible', true]);
  const exP = await exportStl(page, 'export-piece.stl');
  check('... Export as STL writes the piece: its own triangles', [exP.name, exP.soup.length / 9], [`${NAME}_-_${NAME}.stl`, truth.pieceTris]);

  await row(page, 'flange');                                  // both on
  const vb = await view(page);
  check('both on: the selection follows what is checked - the piece once, the flange is inside it',
    [vb.drawn, vb.sel], [[NAME, FLANGE].sort(), [NAME]]);
  const exB = await exportStl(page, 'export-both.stl');
  check('... and Export writes the piece once, not the flange on top of it', exB.soup.length / 9, truth.pieceTris);

  await row(page, NAME);                                      // the flange alone
  const vf = await view(page);
  check('the piece off: the selection is the flange alone', [vf.drawn, vf.sel], [[FLANGE], [FLANGE]]);
  await shot(page, '3-export-flange-alone.png', 'the flange alone, selected');
  const exF = await exportStl(page, 'export-flange.stl');
  check('Export as STL writes exactly the flange: its name, its triangles',
    [exF.name, exF.soup.length / 9], [`${NAME}_-_Flange.stl`, truth.flangeTris]);
  check('... its bounds', tb(bounds(exF.soup)), pb(truth.flangeBounds));
  check('... a clean solid (verdict, open, nm, inconsistent)', validate(exF.path), ['PASS', 0, 0, 0]);
  const before = await page.evaluate(() => ({ models: state.models.length, placed: state.placed.length }));
  await page.click('#ms-btn-export-plate');
  const landed = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { models: state.models.length, placed: state.placed.length, name: m.name, tris: m.rawTris.length / 9,
             open: window.NSO_MICROSCOPE.isOpen() };
  });
  check('Export to plate lands exactly the flange as one new piece',
    [landed.models - before.models, landed.placed - before.placed, landed.name, landed.tris, landed.open],
    [1, 1, FLANGE, truth.flangeTris, false]);

  // =======================================================================
  console.log('\n--- 4. boxes on a toggle-built view ---');
  // =======================================================================
  await importPart(page);
  await row(page, NAME);                                      // the flange alone
  await page.click('#ms-mode-select');
  const fp = await pointOn(page, FLANGE);
  check('the flange is on screen to click', !!fp, true);
  await page.mouse.click(fp[0], fp[1]);
  const b1 = await view(page);
  check('the piece off, a real click on the flange: a box drops and catches the flange alone',
    [b1.boxes, b1.sel, b1.by], [1, [FLANGE], 'box']);
  await page.click('#ms-btn-isolate');
  const b2 = await view(page);
  check('Isolate all boxes: the flange alone, isolated, the list still up',
    [b2.detail, b2.detailDrawn, b2.listUp, b2.rows.length], [true, [FLANGE], true, 6]);
  await shot(page, '4-box-flange-isolated.png', 'a box on the flange, isolated');
  await page.click('#ms-btn-back');
  await row(page, 'flange');                                  // the flange off too
  const b3 = await view(page);
  check('the flange switched off under the box: out of the selection - a box catches only what is shown',
    [b3.boxes, b3.sel, b3.exportShown], [1, [], false]);
  await row(page, 'flange');
  check('... and back on: caught again', (await view(page)).sel, [FLANGE]);
  await row(page, NAME);                                      // both on
  const b4 = await view(page);
  check('both on, the same box over the flange: the piece once, not the flange as well', b4.sel, [NAME]);
  await page.click('#ms-btn-clear');
  const b5 = await view(page);
  check('Clear all boxes: no box, nothing selected, nothing to export', [b5.boxes, b5.sel, b5.exportShown], [0, [], false]);

  // =======================================================================
  console.log('\n--- 5. a box only when asked ---');
  // =======================================================================
  await importPart(page);
  const f0 = await view(page);
  check('a fresh piece opens in orbit: Orbit lit, the box controls tucked away, no hint',
    [f0.mode, await page.evaluate(() => document.getElementById('ms-mode-orbit').classList.contains('active')),
     await page.isVisible('#ms-select-controls'), await page.isVisible('#ms-hint-badge')], ['orbit', true, false, false]);
  const pp = await pointOn(page, NAME);
  await page.mouse.click(pp[0], pp[1]);
  const f1 = await view(page);
  check('a plain click on the piece, nothing armed: no box, nothing selected', [f1.boxes, f1.sel], [0, []]);
  await shot(page, '5a-orbit-click-no-box.png', 'orbit: a click, no box');
  await page.click('#ms-mode-select');
  check('Click to select region: armed, its controls up', [(await view(page)).mode, await page.isVisible('#ms-select-controls')],
    ['select', true]);
  await page.mouse.click(pp[0], pp[1]);
  const f2 = await view(page);
  check('the same click now: a box drops and catches the piece, as before', [f2.boxes, f2.sel, f2.by], [1, [NAME], 'box']);
  await shot(page, '5b-armed-click-box.png', 'armed: a click drops a box');

  check('no page errors', errors, []);
  await browser.close();
  served.srv.close();
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
