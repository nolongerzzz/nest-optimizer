#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-one-list-drive-check.mjs
 *
 * One list per view, a Display check on every row, and a box only when it
 * is asked for - driven through the real app in headless Chromium with real
 * clicks, on the part this was found on (library/tape_on-edge-single.stl).
 *
 * The surface-feature detector rows (Flange / Handle / Bracket / Lid / Hinge)
 * and the Parts rows left G-scope (docs/GSCOPE-SELECT.md sections 3 and 4), so
 * the sections that toggled, exported and boxed the FLANGE are gone; what
 * remains is the same intent through the Features list.
 *
 *   1  SLICE SHOWS ONE LIST: Features, no tab strip in the page, no
 *      Overhang / Conflict / Flange rows. Every Display check off is an empty
 *      view; every check back on is the slice again. (The card's switch:
 *      Slice slices the mesh, Normal goes back to it - round 2c.)
 *   2  NORMAL SHOWS ONE LIST: Features too - and a mesh has no line types, so
 *      it holds no rows, only "Not sliced - no line types."; no detector rows.
 *      The piece is drawn, G-scope is in Piece mode, nothing is isolated.
 *   3  EXPORT IS EXACTLY WHAT IS SHOWN: selectVisible() (Select shown's
 *      job - its button is gone in round 2c, the API stays), Export as STL: the
 *      piece's own triangles, a clean solid; Export to plate: the same
 *      triangles as a new piece.
 *   4  BOXES: REGION armed, a real click on the piece PLACES a box that catches
 *      it and isolates nothing (round 2c, item 7); a click inside the box, off
 *      its dots, isolates it; Whole part makes it whole, the box kept; Isolate
 *      shows it alone with the list still up; Clear boxes clears.
 *   5  A BOX ONLY WHEN ASKED: a fresh piece opens in Piece mode (REGION off,
 *      its note hidden); a real click on it drops no box (it isolates the
 *      piece); REGION armed, then the same click: a box drops and catches the
 *      piece, as before.
 *   6  SCREENSHOTS of each, and no page errors.
 *
 * Usage: node tools/gcode-test/gscope-one-list-drive-check.mjs   (npm run gcode:gscope-one-list)
 */
import { chromium } from 'playwright';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const SHOTS = join(ROOT, 'tools', 'gscope-one-list-out');
const PART = 'library/tape_on-edge-single.stl';
const NAME = 'tape_on-edge-single';

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
      rows: rows.map((e) => e.dataset.group),
      checked: rows.filter((e) => e.querySelector('input.ms-legend-display').checked).map((e) => e.dataset.group),
      notes: Array.from(document.querySelectorAll('#ms-legend .ms-legend-note')).map((e) => e.textContent),
      detectorUI: !!document.getElementById('ms-detected') || typeof M.flange === 'function',
      isolated: M.isIsolated(),
      tabsInPage: !!document.querySelector('.ms-legend-tabs, #ms-tab-legend, #ms-tab-detected, [role="tab"]'),
      sel: M.selection().map((o) => o.name || o.feature), by: M.selectionSource(), boxes: M.boxes().length,
      mode: M.mode(), info: document.getElementById('ms-info').textContent,
      exportShown: getComputedStyle(document.getElementById('ms-export-row')).display !== 'none',
      side: M.cardSide(),
      wholeOn: !document.getElementById('ms-btn-back').disabled,     // Whole part: enabled only while isolated
    };
  });
}

/** A real click on a row's Display check. */
const row = (page, key) => page.click(`#ms-legend [data-group="${key}"] input.ms-legend-display`);

/** Screen point of a view-space point. */
async function screenOf(page, p) {
  return page.evaluate((q) => {
    const v = window.NSO_MICROSCOPE.getView();
    const c = new THREE.Vector3(q[0], q[1], q[2]).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
  }, p);
}
/** A point on the top of a drawn part, found by raycast. */
async function pointOn(page, which) {
  return page.evaluate((w) => {
    const v = window.NSO_MICROSCOPE.getView();
    const m = v.overviewMeshes[w];
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
    return M.isOpen() && d && d !== window.__prevDoc && d.kind === 'mesh' && d.name.indexOf(n) === 0;
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
  gscopeCards.install(page);
  routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!(window.NSO_MICROSCOPE && window.NSO_GSCOPE_SLICE), null, { timeout: 30000 });
  await page.click('#btn-microscope');                       // empty plate: panel + chooser
  await importPart(page);
  const truth = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    return { pieceTris: d.objects[0].triangles };
  });
  console.log(`       ${NAME}: ${truth.pieceTris} triangles`);

  // =======================================================================
  console.log('\n--- 1. Slice: one list, Features, no tabs ---');
  // =======================================================================
  await page.click('#ms-cam-slice');
  await page.waitForFunction(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return !window.NSO_GSCOPE_SLICE.busy() && d && d.kind === 'toolpath' && !!d.nsoSlice;
  }, null, { timeout: 120000 });
  const s1 = await view(page);
  check('the switch flipped to Slice: the card on the Slice side, Slice lit',
    [s1.side, await page.evaluate(() => document.getElementById('ms-cam-slice').classList.contains('active'))], ['slice', true]);
  const groups = await page.evaluate(() => Object.keys(window.NSO_MICROSCOPE.getDoc().groups).filter((g) => g !== 'Travel').sort());
  check('Slice: one list, titled Features, no tab strip in the page',
    [s1.title, s1.listUp, s1.tabsInPage], ['Features', true, false]);
  check('... one row per feature the slice printed, every Display check on, nothing else in it',
    [s1.rows.slice().sort(), s1.checked.slice().sort()], [groups, groups]);
  check(`... that is ${groups.length} rows`, s1.rows.length, groups.length);
  check('... no Overhang, Conflict, Flange or "not on a slice" rows, and no detector UI',
    /Overhang:|Conflict:|Flange|not on a slice/.test(await page.textContent('#ms-legend-float')) || s1.detectorUI, false);
  await shot(page, '1-slice-one-list.png', 'Slice, one list');
  for (const g of s1.rows) await row(page, g);
  const s0 = await view(page);
  check('every Display check off: an empty view, the list still up', [s0.drawn, s0.checked, s0.listUp], [[], [], true]);
  await shot(page, '1b-slice-all-off.png', 'Slice, every row off');
  for (const g of s1.rows) await row(page, g);
  check('every check back on: the slice again', (await view(page)).drawn, s1.drawn);

  // =======================================================================
  console.log('\n--- 2. Normal: one list, Features - and a mesh has no line types ---');
  // =======================================================================
  await page.click('#ms-cam-normal');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 60000 });
  const n1 = await view(page);
  check('Normal: one list, titled Features, no tab strip in the page',
    [n1.title, n1.listUp, n1.tabsInPage], ['Features', true, false]);
  check('... no rows (no Parts rows, no Flange / Handle / Bracket / Lid / Hinge rows), just the one note',
    [n1.rows, n1.notes, n1.detectorUI], [[], ['Not sliced - no line types.'], false]);
  check('... the piece is drawn', n1.drawn, [NAME]);
  check('... in Piece mode, nothing isolated, the card on the Normal side',
    [n1.mode, n1.detail, n1.badge, n1.isolated, n1.side], ['piece', false, 'Whole part', false, 'normal']);
  await shot(page, '2-normal-one-list.png', 'Normal, one list');

  // =======================================================================
  console.log('\n--- 3. Export: exactly what is shown ---');
  // =======================================================================
  // Round 2c: Select shown's button is gone (selection is what is shown); its API remains.
  check('no Select shown button in the page', await page.$('#ms-btn-select-visible'), null);
  await page.evaluate(() => window.NSO_MICROSCOPE.selectVisible());
  const vp = await view(page);
  check('the piece: selectVisible() takes the piece', [vp.sel, vp.by, vp.exportShown], [[NAME], 'visible', true]);
  const exP = await exportStl(page, 'export-piece.stl');
  check('... Export as STL writes the piece: its own triangles', [exP.name, exP.soup.length / 9], [`${NAME}_-_${NAME}.stl`, truth.pieceTris]);
  check('... a clean solid (verdict, open, nm, inconsistent)', validate(exP.path), ['PASS', 0, 0, 0]);
  const before = await page.evaluate(() => ({ models: state.models.length, placed: state.placed.length }));
  await page.click('#ms-btn-export-plate');
  const landed = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { models: state.models.length, placed: state.placed.length, tris: m.rawTris.length / 9,
             open: window.NSO_MICROSCOPE.isOpen() };
  });
  check('Export to plate lands exactly the piece as one new piece',
    [landed.models - before.models, landed.placed - before.placed, landed.tris, landed.open],
    [1, 1, truth.pieceTris, false]);

  // =======================================================================
  console.log('\n--- 4. boxes ---');
  // =======================================================================
  await importPart(page);
  await page.click('#ms-mode-select');
  const fp = await pointOn(page, NAME);
  check('the piece is on screen to click', !!fp, true);
  await page.mouse.click(fp[0], fp[1]);
  const b0 = await view(page);
  // Round 2c (item 7): a REGION click PLACES a box and isolates nothing.
  check('REGION armed, a real click on the piece: a box drops and catches it, nothing isolated',
    [b0.boxes, b0.sel, b0.by, b0.isolated, b0.detail, b0.wholeOn], [1, [NAME], 'box', false, false, false]);
  // G-scope opens framed on both plates, where the 10 mm box is a few pixels across and its dots
  // (never under 6 px) cover all of it: wheel in toward the click (the wheel holds the point under the
  // cursor) until the box is big enough to have a face to click clear of its dots.
  await page.mouse.move(fp[0], fp[1]);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -100);
  await frames(page, 3);
  // A click INSIDE the box (on its face, off the three dots) isolates what it holds. The engine's own
  // answer for "a press here is the box's face" is the hover: a pointer cursor with nothing new outlined
  // (a dot's cursor is 'grab'), so the pixel is found by a real hover: rings round the click, clear of the dots.
  const cands = await page.evaluate(([x0, y0]) => {
    const M = window.NSO_MICROSCOPE, cv = M.getView().renderer.domElement, out = [];
    const dots = [].concat(...M.boxDots().map((o) => [o.move, o.resizeH, o.resizeXY]));
    for (let r = 0; r <= 60; r += 6) for (let a = 0; a < (r ? 12 : 1); a++) {
      const x = x0 + r * Math.cos(a * Math.PI / 6), y = y0 + r * Math.sin(a * Math.PI / 6);
      if (document.elementFromPoint(x, y) === cv && dots.every((d) => Math.hypot(d[0] - x, d[1] - y) >= 16)) out.push([x, y]);
    }
    return out;
  }, fp);
  let inside = null;
  for (const c of cands) {
    await page.mouse.move(c[0], c[1], { steps: 2 });
    await page.waitForTimeout(120);
    await frames(page);
    // the face's answer: a pointer cursor and nothing new outlined (a would-be box outlines itself)
    if (await page.evaluate(() => {
      const v = window.NSO_MICROSCOPE.getView();
      return v.renderer.domElement.style.cursor === 'pointer' && v.hoverGroup.children.length === 0;
    })) { inside = c; break; }
  }
  check('a pixel inside the box, on the piece and clear of the dots', !!inside, true);
  if (inside) await page.mouse.click(inside[0], inside[1]);
  const b1 = await view(page);
  check('a click inside the box isolates what it holds: the piece',
    [b1.boxes, b1.sel, b1.by, b1.isolated, b1.detail, b1.detailDrawn, b1.wholeOn], [1, [NAME], 'box', true, true, [NAME], true]);
  check('... the Features list still up (its note, no rows)', [b1.listUp, b1.notes], [true, ['Not sliced - no line types.']]);
  await shot(page, '4-box-piece-isolated.png', 'a box on the piece, isolated');
  await page.click('#ms-btn-back');
  const b1b = await view(page);
  check('Whole part: whole again, the box and the selection kept', [b1b.isolated, b1b.detail, b1b.boxes, b1b.sel, b1b.wholeOn],
    [false, false, 1, [NAME], false]);
  await page.click('#ms-btn-isolate');
  const b2 = await view(page);
  check('Isolate: the piece alone, isolated, the list still up',
    [b2.detail, b2.detailDrawn, b2.listUp, b2.notes], [true, [NAME], true, ['Not sliced - no line types.']]);
  await page.click('#ms-btn-back');
  await page.click('#ms-btn-clear');
  const b5 = await view(page);
  check('Clear boxes: no box, nothing selected, nothing to export, Clear boxes disabled again',
    [b5.boxes, b5.sel, b5.exportShown, await page.evaluate(() => document.getElementById('ms-btn-clear').disabled)], [0, [], false, true]);

  // =======================================================================
  console.log('\n--- 5. a box only when asked ---');
  // =======================================================================
  await importPart(page);
  const f0 = await view(page);
  // Round 2c: no Piece button - REGION is a toggle (not pressed = Piece) and its note shows only while armed.
  check('a fresh piece opens in Piece mode: REGION not pressed, its note tucked away, no hint',
    [f0.mode, await page.getAttribute('#ms-mode-select', 'aria-pressed'),
     await page.isVisible('#ms-region-note'), await page.isVisible('#ms-hint-badge')], ['piece', 'false', false, false]);
  const pp = await pointOn(page, NAME);
  await page.mouse.click(pp[0], pp[1]);
  const f1 = await view(page);
  // A press on a piece is not an orbit any more: a click isolates it (Piece mode's click).
  check('a plain click on the piece, Region not armed: no box (the piece itself is isolated)',
    [f1.boxes, f1.mode, f1.isolated], [0, 'piece', true]);
  await shot(page, '5a-piece-click-no-box.png', 'Piece mode: a click, no box');
  await gscopeCards.closeCards(page);                         // Escape shuts an open card first, then un-isolates
  await page.keyboard.press('Escape');                        // Escape un-isolates
  check('Escape makes it whole again', (await view(page)).isolated, false);
  // The piece clicked above is still the selection, and a press on the selection takes the
  // selection (not a new box); so the Region half starts from a fresh document.
  await importPart(page);
  await page.click('#ms-mode-select');
  check('Region: armed, its toggle pressed and its note up', [(await view(page)).mode,
    await page.getAttribute('#ms-mode-select', 'aria-pressed'), await page.isVisible('#ms-region-note')],
    ['select', 'true', true]);
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
