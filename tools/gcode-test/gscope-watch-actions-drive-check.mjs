#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-watch-actions-drive-check.mjs
 *
 * G-scope's own actions as lines of their own in the live watch's trail
 * (nso-watch.js), driven through the real app in headless Chromium with real
 * clicks.
 *
 * Since #130 the watch follows into G-scope and keeps counting there, but its
 * trail only showed a G-scope action when a phantom or an error happened to
 * carry it: a legend toggle, a click on the 3D view or a Normal / Slice switch
 * left nothing behind when nothing went wrong. Now each is a "gscope" line,
 * in sequence with everything else, saying what was done and in which view.
 *
 *   1  A CLEAN SEQUENCE, EVERY ACTION A LINE. Armed on main, into G-scope
 *      (no re-arm), then 3D view clicks (on a piece with REGION off - the
 *      piece click, no mode suffix since round 2c removed the Piece button -
 *      a box placed with REGION armed, on empty space), the card's REGION /
 *      Isolate / Clear boxes / Whole part, and its Normal / Slice switch with
 *      a Features-list row click, a Display check and a REGION box in Slice
 *      view, out again. (A mesh has no line types, so the
 *      Features list has rows only in Slice view.) Nothing goes wrong - and the Report still holds every one of
 *      those actions as its own row, in exactly the order they were done,
 *      each naming its view; "view Normal -> Slice" precedes "Sliced ...".
 *   2  A PHANTOM AND AN ERROR MID-SEQUENCE. The same kind of use, with a real
 *      pose mismatch made and caught half-way through and an uncaught error
 *      thrown later: both sit in the Report between the actions done before
 *      and after them, tagged with the G-scope view they happened in, and
 *      the phantom's own trail names the G-scope actions that led to it.
 *   3  CARRY-IN / CARRY-OUT. Turned off from main, G-scope use records
 *      nothing and nothing is left listening; a fresh page that was never
 *      armed records nothing on either side of the boundary.
 *
 * Usage: node tools/gcode-test/gscope-watch-actions-drive-check.mjs   (npm run gcode:gscope-watch-actions)
 */
import { chromium } from 'playwright';
import { serveRoot, routeCdn, mkCheck, launchOpts } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const PROBE = 'gscope-actions probe: thrown mid-sequence';

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
  await frames(page);
}
async function meshBack(page) {
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 30000 });
  await frames(page);
}
const lastSeq = (page) => page.evaluate(() => { const e = NSOWatch.events(); return e.length ? e[e.length - 1].seq : 0; });
const eventsAfter = (page, lo) => page.evaluate((a) => NSOWatch.events().filter((e) => e.seq > a), lo);
const pills = (page) => page.evaluate(() => [document.getElementById('nso-watch-n-phantom').textContent,
  document.getElementById('nso-watch-n-error').textContent]);

/** A screen point on a piece (or, in a slice, on one of a feature's lines). */
async function pointOn(page, which) {
  return page.evaluate((w) => {
    const v = window.NSO_MICROSCOPE.getView();
    const r = v.renderer.domElement.getBoundingClientRect();
    const toScreen = (p) => { const c = p.clone().project(v.camera); return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height }; };
    const m = v.overviewMeshes[Object.keys(v.overviewMeshes).find((k) => k.includes(w))];
    if (m.isLineSegments) {
      const a = m.geometry.attributes.position, i = Math.floor(a.count / 4) * 2;
      return toScreen(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).lerp(new THREE.Vector3(a.getX(i + 1), a.getY(i + 1), a.getZ(i + 1)), 0.5));
    }
    const b = new THREE.Box3().setFromObject(m);
    return toScreen(new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2));
  }, which);
}
/** A screen point on G-scope's 3D view with nothing of the part under it: the watcher's own
    raycast hits nothing there, and G-scope's press target (pressTargetAt) is bare plate too. */
async function emptyPoint(page) {
  return page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView(), cv = v.renderer.domElement, r = cv.getBoundingClientRect();
    const meshes = Object.values(v.overviewMeshes).filter((m) => m.visible);
    const rc = new THREE.Raycaster();
    for (const fx of [0.5, 0.35, 0.65, 0.25, 0.75]) {
      for (const fy of [0.12, 0.2, 0.3, 0.85]) {
        const x = r.left + fx * r.width, y = r.top + fy * r.height;
        if (document.elementFromPoint(x, y) !== cv) continue;
        rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
        if (!rc.intersectObjects(meshes, false).length && !window.NSO_MICROSCOPE.pressTargetAt(x, y)) return { x, y };
      }
    }
    return null;
  });
}
async function click3d(page, at) {
  await page.mouse.click(at.x, at.y);
  await frames(page);
}
const legendGroups = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map((e) => e.dataset.group));
/* Watch's log sits over the left wall in G-scope (nso-watch.js docks it at left 12 / bottom 84, where
   the shell's legend now is), so a real click at the row's centre can land on the log. These checks
   assert what Watch RECORDS when the row's own handler runs, so the handler is run directly.
   A Features row is checkboxes only (docs/GSCOPE.md, item 4): a click on its text toggles its check. */
const legend = (page, g) => page.evaluate((sel) => document.querySelector(sel).click(), `#ms-legend [data-group="${g}"] .ms-legend-label`);
/* The Display check of a Features row (a change event, logged as 'Display "X" on|off'). */
const display = (page, g) => page.evaluate((sel) => document.querySelector(sel).click(), `#ms-legend [data-group="${g}"] .ms-legend-display`);
const pieces = (page) => page.evaluate(() => window.NSO_MICROSCOPE.groups());

/** The list of expected lines the card presses made by gscopeCards go into (null: none being kept). */
let sink = null;

async function openApp(browser, served) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  /* Watch records a press on a column button like any other control, so opening a card to reach a
     control is a line of its own in the log: each one is added to the expectations as it happens. */
  gscopeCards.install(page, { before: async (nav) => {
    if (!sink) return;
    const slice = (await page.evaluate(() => window.NSO_GSCOPE_SLICE.viewMode())) === 'slice';
    sink.push(new RegExp(`^G-scope ${slice ? 'Slice' : 'Normal'}: click ${nav}$`));
  } });
  routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => { if (!String(e).includes(PROBE)) errors.push(String(e)); });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes(PROBE) && !/^\[watch2 /.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_GSCOPE_SLICE && !!window.NSOWatch, null, { timeout: 30000 });
  await page.evaluate(() => { localStorage.removeItem('nso.watch'); localStorage.removeItem('nso.watch.store'); localStorage.removeItem('nso.watch.collapsed'); });
  await page.evaluate(([a, b]) => handleFiles([new File([new Uint8Array(a)], 'mushroom.stl'),
    new File([new Uint8Array(b)], 'plain.stl')]), [MUSHROOM, PLAIN]);
  await page.waitForFunction(() => state.models.length === 2 && state.placed.length === 2, null, { timeout: 30000 });
  return { page, errors };
}

/** The G-scope lines after `seq`, as the watcher recorded them. */
async function gscopeLines(page, seq) {
  return (await eventsAfter(page, seq)).filter((e) => e.kind === 'gscope');
}
/** The Report's own rows (the in-app view), as text, oldest first. */
async function reportRows(page) {
  await page.click('#nso-watch-report-btn');
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#nso-wr-list .nso-watch-row'))
    .map((d) => ({ cls: d.className, text: d.querySelector('span').textContent,
                   tag: (d.querySelector('.vw') || {}).textContent || null })));
  await page.click('#nso-wr-close');
  return rows;
}
/** Each expected pattern matched by a distinct row, strictly in order. */
function inOrder(texts, patterns) {
  let at = -1;
  const idx = [];
  for (const p of patterns) {
    let i = at + 1;
    while (i < texts.length && !p.test(texts[i])) i++;
    if (i >= texts.length) return { ok: false, missing: String(p), idx };
    idx.push(i);
    at = i;
  }
  return { ok: true, idx };
}

async function main() {
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());

  // =======================================================================
  console.log('\n--- 1. a clean sequence: every G-scope action is its own line, in order ---');
  // =======================================================================
  const { page, errors } = await openApp(browser, served);
  await page.click('#btn-watch');
  check('armed on main with the eye button', await page.evaluate(() => [NSOWatch.isOn(), NSOWatch.where()]), [true, 'main']);
  const runs0 = await page.evaluate(() => NSOWatch.stored().runs.map((r) => r.id));
  const seq1 = await lastSeq(page);
  check('before G-scope: no G-scope line yet', (await gscopeLines(page, 0)).length, 0);

  await page.click('#btn-microscope');
  await frames(page);
  const groups = await pieces(page);
  check('in G-scope, Normal view, on the plate, a piece each - and no Features rows (a mesh has no line types)',
    [await page.evaluate(() => window.NSO_GSCOPE_SLICE.viewMode()), groups.length, (await legendGroups(page)).length], ['normal', 2, 0]);
  const gM = groups.find((g) => g.includes('mushroom')), gP = groups.find((g) => g.includes('plain'));

  // The sequence - each step, and the line it must leave, side by side.
  const expect = [/^G-scope Normal: entered G-scope - the plate$/];
  sink = expect;
  // G-scope opens on the piece click (REGION off): a click takes (and isolates) the piece. Round 2c
  // removed the Piece button, so there is no "click ms-mode-piece" line, and Watch's gsMode() (it reads
  // #ms-mode-*.active) finds no armed mode: the 3D line carries no "(piece mode)" suffix.
  check('G-scope opened with REGION off, on the piece click (no Piece button)',
    await page.evaluate(() => [window.NSO_MICROSCOPE.mode(), !!document.getElementById('ms-mode-piece')]), ['piece', false]);
  await click3d(page, await pointOn(page, 'mushroom'));
  expect.push(new RegExp(`^G-scope Normal: 3D view click - hit "${gM}" at \\(`));
  check('... and that 3D click really took the piece and isolated it',
    await page.evaluate(() => [window.NSO_MICROSCOPE.selection().map((o) => o.name), window.NSO_MICROSCOPE.isIsolated()]), [[gM], true]);
  await page.click('#ms-btn-back'); expect.push(/^G-scope Normal: click ms-btn-back$/);      // Whole part
  // A box is something you arm: REGION (with it armed, a press is the box's, not the selection's).
  await page.click('#ms-mode-select'); expect.push(/^G-scope Normal: click ms-mode-select$/);
  const boxes0 = await page.evaluate(() => window.NSO_MICROSCOPE.boxes().length);
  await click3d(page, await pointOn(page, 'mushroom'));
  expect.push(new RegExp(`^G-scope Normal: 3D view click \\(select mode\\) - hit "${gM}" at \\(`));
  check('... and the 3D click with REGION armed really placed a box - and isolated nothing (item 7)',
    await page.evaluate(() => [window.NSO_MICROSCOPE.boxes().length, window.NSO_MICROSCOPE.isIsolated()]), [boxes0 + 1, false]);
  // after a REGION click nothing is isolated: Whole part is off, so the box's contents go through Isolate
  await page.click('#ms-btn-isolate'); expect.push(/^G-scope Normal: click ms-btn-isolate$/);
  check('... the card\'s Isolate isolated what the box holds', await page.evaluate(() => window.NSO_MICROSCOPE.isIsolated()), true);
  await page.click('#ms-btn-back'); expect.push(/^G-scope Normal: click ms-btn-back$/);
  await page.click('#ms-btn-clear'); expect.push(/^G-scope Normal: click ms-btn-clear$/);   // Clear boxes
  const empty = await emptyPoint(page);
  check('found a point on the 3D view with nothing under it', !!empty, true);
  await click3d(page, empty); expect.push(/^G-scope Normal: 3D view click \(select mode\) - nothing hit$/);
  // REGION off again: the toggle's second click (it replaces the old "click ms-mode-piece")
  await page.click('#ms-mode-select'); expect.push(/^G-scope Normal: click ms-mode-select$/);
  await click3d(page, await pointOn(page, 'plain'));
  expect.push(new RegExp(`^G-scope Normal: 3D view click - hit "${gP}" at \\(`));
  await page.click('#ms-btn-back'); expect.push(/^G-scope Normal: click ms-btn-back$/);
  await page.click('#ms-mode-select'); expect.push(/^G-scope Normal: click ms-mode-select$/);
  // (no Clear boxes here: there is no box, and the button is off - an off button logs nothing)
  await page.click('#ms-cam-normal'); expect.push(/^G-scope Normal: view Normal \(already Normal - re-frame\)$/);
  await page.click('#ms-cam-slice'); expect.push(/^G-scope Normal: view Normal -> Slice$/);
  await sliced(page);
  const sliceGroups = await legendGroups(page);
  const wall = sliceGroups.find((g) => g === 'Outer wall') || sliceGroups[0];
  // A slice opens on its Features list: checkboxes only. A click on a row's text toggles its check -
  // one Display line - and isolates nothing.
  await legend(page, wall); expect.push(new RegExp(`^G-scope Slice: Display "${wall}" off$`));
  check('... and the row text click toggled the check and isolated nothing',
    await page.evaluate((w) => [window.NSO_MICROSCOPE.hidden().indexOf(w) >= 0, window.NSO_MICROSCOPE.isIsolated()], wall), [true, false]);
  await legend(page, wall); expect.push(new RegExp(`^G-scope Slice: Display "${wall}" on$`));
  check('... and the text again checks it again', await page.evaluate((w) => window.NSO_MICROSCOPE.hidden().indexOf(w) < 0, wall), true);
  await display(page, wall); expect.push(new RegExp(`^G-scope Slice: Display "${wall}" off$`));
  check('... the Display check really hid that line type (a new slice opens with Travel off)',
    await page.evaluate(() => window.NSO_MICROSCOPE.hidden().slice().sort()), [wall, 'Travel'].sort());
  await display(page, wall); expect.push(new RegExp(`^G-scope Slice: Display "${wall}" on$`));
  // A slice is a new document: it opens with REGION off, so one click arms it.
  await page.click('#ms-mode-select'); expect.push(/^G-scope Slice: click ms-mode-select$/);
  await click3d(page, await pointOn(page, wall));
  expect.push(/^G-scope Slice: 3D view click \(select mode\) - hit "[^"]+" at \(/);
  await page.click('#ms-btn-isolate'); expect.push(/^G-scope Slice: click ms-btn-isolate$/);
  check('... in Slice view too: the REGION click placed a box, and Isolate isolated it',
    await page.evaluate(() => [window.NSO_MICROSCOPE.boxes().length, window.NSO_MICROSCOPE.isIsolated()]), [1, true]);
  // Whole part is a Normal-side row; on the Slice side Escape backs out (Watch logs no key)
  await page.keyboard.press('Escape');
  check('... and Escape (the Slice side\'s Whole part) made it whole', await page.evaluate(() => window.NSO_MICROSCOPE.isIsolated()), false);
  await page.click('#ms-btn-clear'); expect.push(/^G-scope Slice: click ms-btn-clear$/);
  await page.click('#ms-cam-slice'); expect.push(/^G-scope Slice: view Slice \(already Slice - no change\)$/);
  await page.click('#ms-cam-normal'); expect.push(/^G-scope Slice: view Slice -> Normal$/);
  await meshBack(page);
  await page.click('#ms-cam-slice'); expect.push(/^G-scope Normal: view Normal -> Slice$/);
  await sliced(page);
  await page.click('#ms-cam-normal'); expect.push(/^G-scope Slice: view Slice -> Normal$/);
  await meshBack(page);
  await page.click('#ms-close'); expect.push(/^G-scope Normal: click ms-close$/, /^left G-scope - back on main$/);
  await frames(page);

  const lines1 = await gscopeLines(page, seq1);
  const texts1 = lines1.map((e) => e.msg);
  check(`the watcher recorded exactly ${expect.length} G-scope lines, one per action`, texts1.length, expect.length);
  const firstBad = texts1.findIndex((t, i) => !expect[i] || !expect[i].test(t));
  check('... each the action that was done, in the order it was done',
    firstBad < 0 ? 'all in order' : `line ${firstBad}: ${texts1[firstBad]}`, 'all in order');
  check('... their seq numbers strictly increase', lines1.every((e, i) => !i || e.seq > lines1[i - 1].seq), true);
  check('... each carries its view as a field too (main only for "left")',
    lines1.map((e) => e.view).filter((v, i, a) => a.indexOf(v) === i), ['gscope-normal', 'gscope-slice', 'main']);
  check('... and its action', lines1.map((e) => e.detail.action).filter((v, i, a) => a.indexOf(v) === i).sort(),
    ['click3d', 'control', 'display', 'enter', 'leave', 'view']);
  check('a Features row is not a line of its own (its check\'s change is)', lines1.some((e) => e.detail.action === 'legend'), false);
  const dispOff = lines1.find((e) => e.detail.action === 'display' && !e.detail.on);
  check('a Display line says which row and on/off in its detail', [dispOff.detail.group, dispOff.detail.on], [wall, false]);
  const hit = lines1.find((e) => e.detail.action === 'click3d' && e.detail.hit);
  // (mode null: the piece click has no button since round 2c, so Watch's gsMode() finds none armed)
  check('a 3D click line says what was hit, and where, in its detail',
    [hit.detail.hit, hit.detail.mode, Array.isArray(hit.detail.at) && hit.detail.at.length], [gM, null, 3]);

  const all1 = await eventsAfter(page, seq1);
  const iSwitch = all1.findIndex((e) => e.kind === 'gscope' && /view Normal -> Slice/.test(e.msg));
  const iSliced = all1.findIndex((e) => e.kind === 'status' && /^Sliced /.test(e.msg));
  check('"view Normal -> Slice" is logged before the slice\'s own "Sliced ..." line', iSwitch >= 0 && iSliced > iSwitch, true);
  check('the slice\'s status line carries its view: in G-scope, Normal (the switch had not landed yet) or Slice',
    /^gscope-/.test(all1[iSliced].view), true);
  const iEnter = all1.findIndex((e) => e.kind === 'gscope' && /entered G-scope/.test(e.msg));
  check('"entered G-scope" precedes every other event made inside it',
    all1.every((e, i) => i >= iEnter || e.view === 'main'), true);
  check('nothing went wrong in this sequence: 0 phantom / 0 error', await pills(page), ['0 phantom', '0 error']);
  check('the same run throughout: no re-arm',
    [await page.evaluate(() => NSOWatch.stored().runs.map((r) => r.id)),
      all1.filter((e) => e.kind === 'watch').length], [runs0, 0]);

  const rows1 = await reportRows(page);
  const r1 = inOrder(rows1.map((r) => r.text), expect);
  check('Report: every one of those actions is its own row, in the order it happened', r1.ok ? 'ok' : r1.missing, 'ok');
  check('... drawn as G-scope rows', r1.idx.every((i) => /\bk-gscope\b/.test(rows1[i].cls)), true);
  check('... and the slice\'s status line is tagged with the G-scope view it happened in',
    rows1.some((r) => /^Sliced /.test(r.text) && /^G-scope (Normal|Slice)$/.test(r.tag)), true);
  const copied = await page.evaluate(() => NSOWatch.copyReport());
  const c1 = inOrder(copied.split('\n'), expect.map((p) => new RegExp('  gscope  ' + p.source.replace(/^\^/, ''))));
  check('... and the Report\'s Copy text has them, one per line, in order', c1.ok ? 'ok' : c1.missing, 'ok');
  check('Report filtered to "gscope" shows exactly those lines',
    (await page.evaluate(() => NSOWatch.query({ cat: 'gscope' }))).length, expect.length);

  // =======================================================================
  console.log('\n--- 2. a phantom and an error mid-sequence, the action trail around them ---');
  // =======================================================================
  const seq2 = await lastSeq(page);
  await page.click('#btn-microscope');
  await frames(page);
  const before = [/^G-scope Normal: entered G-scope/];
  sink = before;
  // (a new visit: REGION off, the piece click)
  await click3d(page, await pointOn(page, 'plain'));
  before.push(new RegExp(`^G-scope Normal: 3D view click - hit "${gP}"`));
  await page.click('#ms-btn-back'); before.push(/^G-scope Normal: click ms-btn-back$/);
  await page.click('#ms-mode-select'); before.push(/^G-scope Normal: click ms-mode-select$/);
  await click3d(page, await pointOn(page, 'mushroom'));
  before.push(new RegExp(`^G-scope Normal: 3D view click \\(select mode\\) - hit "${gM}"`));
  await page.click('#ms-btn-isolate'); before.push(/^G-scope Normal: click ms-btn-isolate$/);
  await page.click('#ms-btn-back'); before.push(/^G-scope Normal: click ms-btn-back$/);
  await page.click('#ms-btn-clear'); before.push(/^G-scope Normal: click ms-btn-clear$/);
  await page.click('#ms-cam-normal'); before.push(/^G-scope Normal: view Normal \(already Normal - re-frame\)$/);
  // A real pose mismatch, made while G-scope is up (a quarter turn off the
  // logical pose), after the actions above. Nothing more is done until it is
  // caught, so every one of them is in the log before it. Which pass catches
  // it - a late one from a click, or the idle sweep (every 4 s) - is timing,
  // and not this check's business: where it lands among the actions is.
  await page.evaluate(() => { state.placed[0].mesh.rotation.y += Math.PI / 2; });
  await page.waitForFunction(() => /^1 phantom$/.test(document.getElementById('nso-watch-n-phantom').textContent), null, { timeout: 10000 });
  const between = [];
  sink = between;
  // REGION off and on again (the toggle; it was Piece then Region before round 2c)
  await page.click('#ms-mode-select'); between.push(/^G-scope Normal: click ms-mode-select$/);
  await page.click('#ms-mode-select'); between.push(/^G-scope Normal: click ms-mode-select$/);
  await page.evaluate((m) => { setTimeout(() => { throw new Error(m); }, 0); }, PROBE);
  await page.waitForFunction(() => /^1 error$/.test(document.getElementById('nso-watch-n-error').textContent), null, { timeout: 5000 });
  const after = [];
  sink = after;
  await click3d(page, await emptyPoint(page)); after.push(/^G-scope Normal: 3D view click \(select mode\) - nothing hit$/);
  await page.click('#ms-cam-slice'); after.push(/^G-scope Normal: view Normal -> Slice$/);
  await sliced(page);
  await page.click('#ms-cam-normal'); after.push(/^G-scope Slice: view Slice -> Normal$/);
  await meshBack(page);
  await page.evaluate(() => { state.placed[0].mesh.rotation.y -= Math.PI / 2; });
  await page.click('#ms-cam-normal'); after.push(/^G-scope Normal: view Normal \(already Normal - re-frame\)$/);
  await page.waitForFunction(() => NSOWatch.open().length === 0, null, { timeout: 5000 });
  await page.click('#ms-close'); after.push(/^G-scope Normal: click ms-close$/, /^left G-scope - back on main$/);
  await frames(page);

  const all2 = await eventsAfter(page, seq2);
  const ph = all2.find((e) => e.kind === 'phantom');
  const er = all2.find((e) => e.kind === 'error' && e.msg.includes(PROBE));
  check('the phantom and the error were both caught inside G-scope, in Normal view',
    [!!ph && /^phantom pose/.test(ph.msg), ph && ph.view, !!er, er && er.view], [true, 'gscope-normal', true, 'gscope-normal']);
  check('the phantom\'s own trail names the G-scope actions that led to it (a G-scope button, the 3D click)',
    !!ph && [ph.trail.some((t) => /click ms-btn-(clear|back)/.test(t)), ph.trail.some((t) => /G-scope 3D view click/.test(t))], [true, true]);
  const g2 = all2.filter((e) => e.kind === 'gscope').map((e) => e.msg);
  const e2 = [...before, ...between, ...after];
  check(`every action was still logged as its own line, with nothing gone wrong or not (${e2.length})`,
    [g2.length, g2.every((t, i) => e2[i].test(t))], [e2.length, true]);

  sink = null;
  const rows2 = await reportRows(page);
  const texts2 = rows2.map((r) => r.text);
  const phRow = texts2.findIndex((t) => /^phantom pose/.test(t));
  const erRow = texts2.findIndex((t) => t.includes(PROBE));
  const pre = inOrder(texts2.slice(0, phRow), before);
  const mid = inOrder(texts2.slice(phRow + 1, erRow), between);
  const post = inOrder(texts2.slice(erRow + 1), after);
  check('Report: the actions done before the phantom are rows above it, in order', pre.ok ? 'ok' : pre.missing, 'ok');
  check('... the ones between the phantom and the error sit between them, in order', mid.ok ? 'ok' : mid.missing, 'ok');
  check('... and the ones after the error are rows below it, in order', post.ok ? 'ok' : post.missing, 'ok');
  check('... the phantom row and the error row are tagged with the G-scope view they happened in',
    [rows2[phRow].tag, rows2[erRow].tag], ['G-scope Normal', 'G-scope Normal']);
  check('... and the phantom\'s own row still says what it followed',
    await page.evaluate(() => { NSOWatch.showReport(); const r = Array.from(document.querySelectorAll('#nso-wr-list .nso-watch-row.k-phantom')).pop(); NSOWatch.hideReport(); return r ? r.querySelector('.op').textContent : null; }),
    'after ' + (ph && ph.op));

  // =======================================================================
  console.log('\n--- 3. carry-in / carry-out: off from main records nothing ---');
  // =======================================================================
  await page.click('#btn-watch');
  const stored3 = await page.evaluate(() => NSOWatch.stored().events.length);
  check('turned off from main', await page.evaluate(() => NSOWatch.isOn()), false);
  await page.click('#btn-microscope');
  await frames(page);
  await page.click('#ms-mode-select'); await page.click('#ms-mode-select');     // REGION on, off (a toggle)
  await click3d(page, await pointOn(page, 'mushroom'));
  await page.click('#ms-cam-slice'); await sliced(page);
  await page.click('#ms-cam-normal'); await meshBack(page);
  await page.click('#ms-close');
  check('G-scope used after that: nothing recorded, the stored history unchanged, still off',
    [await page.evaluate(() => NSOWatch.stored().events.length), await page.evaluate(() => NSOWatch.isOn())], [stored3, false]);
  check('no page errors', errors, []);
  await page.close();

  const off = await openApp(browser, served);
  await off.page.click('#btn-microscope');
  await frames(off.page);
  await off.page.click('#ms-mode-select'); await off.page.click('#ms-mode-select');
  await click3d(off.page, await pointOn(off.page, 'mushroom'));
  await off.page.click('#ms-cam-slice'); await sliced(off.page);
  await off.page.click('#ms-cam-normal'); await meshBack(off.page);
  await off.page.click('#ms-close');
  check('never armed: G-scope use records nothing, and no run exists',
    await off.page.evaluate(() => [NSOWatch.isOn(), NSOWatch.events().length, NSOWatch.stored().runs.length,
      localStorage.getItem('nso.watch.store')]), [false, 0, 0, null]);
  check('no page errors', off.errors, []);

  await browser.close();
  served.srv.close();
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
