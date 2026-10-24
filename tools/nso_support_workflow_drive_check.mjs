#!/usr/bin/env node
/**
 * nest-optimizer / tools / nso_support_workflow_drive_check.mjs   (npm run support:workflow)
 *
 * The SUPPORTS card as a verb with a state (app-supports-card.js), driven in
 * headless Chromium at 1280 x 800 with real clicks on the page. Piece A is
 * support:beacons' tilted box (40 x 30 x 10, underside at 30 deg, 120 beacons
 * in one area); piece B is that box beside a block with a tunnel through it
 * (the tunnel's ceiling hangs over its own floor, so with "May rest on the
 * part" off the plate cannot reach it); the wedge is library/v9_mirror_factory.stl
 * (187 x 34 x 21 mm, 49k triangles, 10 hanging areas at 35 deg, 25 at the old 60).
 *
 *   1  DETECT FIRST. Opening the card on a plate with one piece detects at
 *      once: "1 hanging area at 35 deg on <piece>", the area outlined (one outline of
 *      44 edges, not a grid), nothing generated, nothing in Undo; GENERATE on;
 *      the Paint disclosure is gone; the green build tag and the HUD's copy of
 *      the readout are not drawn.
 *   2  THE ANGLE is editable on the card and re-detects as it changes: 25 deg
 *      is below the underside's 30 deg (nothing hangs), 60 finds the area again,
 *      the label naming Bambu's 30 beside either; back to the default 35.
 *   3  EDIT BEFORE GENERATE. A click on the outline leaves the area out (it dims,
 *      GENERATE off); a click puts it back; Shift-click on the wall adds a spot
 *      (an area of its own, outlined like the rest). Each is one Undo.
 *   4  BUILDING. GENERATE: every control is locked, one bar fills under the
 *      readout (no spinner), the bottom-right status says what the readout says,
 *      the planner runs off the page's thread. (The worker's messages are held
 *      in the middle of building, for the screenshot.)
 *   5  BUILT. "Built: N supports - held H - unsupported K - unreachable U";
 *      REGENERATE replaces (one Undo); REMOVE takes one; REMOVE ALL back to IDLE.
 *   6  EVERY BUILD ENDS IN A STATE. A planner that throws, one that refuses, and
 *      one that never answers (the watchdog: 60 s of silence by default, the
 *      readout counts seconds past 10) each end as "Could not build: <why> - nothing was
 *      added": the plate exactly as before, Undo with nothing new, the card
 *      live again, the bar gone; a REGENERATE that fails leaves the old
 *      supports standing.
 *   7  THE THREE COUNTS. Piece B: 2 areas; the plate reaches only the spots
 *      by the tunnel's mouths, so the build splits the ceiling's lost middle
 *      off as an area of its own (#265): "held 2 - unsupported 0 - unreachable
 *      1", a row for it under the readout, a click on the row frames the area.
 *      Leaving an area out before GENERATE counts it unsupported, with its row.
 *   8  SELECTING A PIECE while the card is open detects there at once (a click
 *      on the piece, or the app's own selection from the Pieces list).
 *   9  THE WEDGE (the piece that used to hang): detect on open, 10 areas at once
 *      (at the default 35 deg; 25 at the old 60, pinned); Generate over all 10
 *      ends BUILT in seconds (the planner has a spatial index now), the three
 *      counts pinned. The watchdog is section 8's.
 *      Its build shows well over 10 progress updates, planning 326 / 326 and
 *      building n / n both at 100 % before BUILT; Escape in the middle of
 *      planning terminates the real worker and changes nothing.
 *  10  PROGRESS. One bar, 0 to 100 % over the whole build, one phase word at a
 *      time: Detecting, Planning (beacons settled / total: the first half of the
 *      bar), Building (the sheet's tips settled, then trunks swept / total: the
 *      second half). There is no welding: the parts are handed back as shells
 *      (support:shells). The messages arrive in that order, done <= total, the
 *      percent never goes down, 100 only when the work is; a phase with no
 *      count (detecting) shows its word and the seconds on a bar that only
 *      sweeps - no count is guessed. REGENERATE and REMOVE ALL are off while
 *      the bar is live; Escape cancels (plate unchanged, Undo empty-handed, old
 *      supports standing, a late planner cannot touch the plate). A planner
 *      that reports nonsense (backwards, past its total, an unknown phase) is
 *      not believed.
 *  11  THE CLAMP (fixtures/supports/clamp_body.stl, standing as support:interface
 *      stands it), at the card's defaults: GENERATE ends with supports added,
 *      the bar reaches 100 % with at least 3 distinct Planning and 3 distinct
 *      Building counts on the way (Building moves while the sheet is planned,
 *      not only once the trunks are swept), inside CLAMP_BUILD_LOOPS
 *      calibration loops (the time gates are in loops - see below).
 *  12  THE WATCHDOG IS SILENCE. A planner that posts progress every 5 s for
 *      90 s is not stopped (its own refusal ends the build); one that says
 *      nothing is stopped at 60 s (section 6); a build still running at the
 *      ceiling is stopped however it reports ("still running after ...").
 *  13  No page errors. Screenshots of each state in tools/supports-out/ (not
 *      under CI, where nothing reads them, unless --shots).
 *
 * FOUR STEPS, ONE FILE. `--only=card|counts|builds|watchdog` runs one group of
 * the sections and no flag runs them all. CI runs the four as
 * support:workflow-card, -counts, -builds and -watchdog: the whole was ~549 s
 * and a step is the smallest thing a shard can be packed with. The groups are
 * a partition of the sections (RUN below, one `if` per block, and the sections
 * between them are in file order), and the closing two checks run in every
 * one. Measured locally, 404 s whole (179 checks):
 *     card      1-6    120 s   one page, one chain: 6 regenerates the supports 5 built
 *     counts    7, 8, 10  70 s
 *     builds    9, 11  111 s   the wedge and the clamp
 *     watchdog  12     102 s   90 s of it a real wait on the card's 60 s watchdog (6 has 60 s of its own)
 * The watchdog's waits are real time against the card's default constants (only
 * the ceiling can be set from the page), so they are not cut here.
 */
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from './cth-test/browser-lib.mjs';
import pace from './nso_pace.js';

const check = mkCheck();
const GROUPS = ['card', 'counts', 'builds', 'watchdog'];
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;
if (ONLY !== null && !GROUPS.includes(ONLY)) {
  console.error('nso_support_workflow_drive_check: --only=' + ONLY + ' is not one of ' + GROUPS.join(', '));
  process.exit(2);
}
const RUN = Object.fromEntries(GROUPS.map((g) => [g, !ONLY || ONLY === g]));
const SHOTS_ON = process.argv.includes('--shots') || !process.env.CI;
/* The wedge (section 9) pinned: areas held / unsupported / unreachable over its 10 areas at 35 deg. */
const WEDGE_HELD = 10, WEDGE_UNSUPPORTED = 0, WEDGE_UNREACHABLE = 0;
/* THE TIME GATES ARE IN CALIBRATION LOOPS, not seconds: a loop is a fixed amount of plain JS run in the page
   just before and just after the timed work (tools/nso_pace.js), so a runner starved for CPU slows both and the
   ratio holds where the seconds did not (the planner's silence was red on Tests #301 at 1 s, the builds went with
   the runner's speed). Each limit is the old one on the 4-core cloud box the old ones were set on - a loop is
   ~285 ms in the page there - and the seconds are still logged as FINDINGs. The planner's own beat is wall-clock
   by design (nso_support_gridpack.js HEARTBEAT_MS: a message goes out once 200 ms have passed, so a gap is the
   beat plus the unit of work in hand), so it is the WORK in a gap, the gap less the beat, that is held to loops. */
const WEDGE_BUILD_LOOPS = 175;      // the wedge's whole build (was 50 s; 13-17 s, ~48 loops, on that box)
const CLAMP_BUILD_LOOPS = 105;      // the clamp's (was 30 s; 23 s, ~79 loops, on that box with the weld)
const HEARTBEAT_MS = 200;
const LATE_UNIT_LOOPS = 0.175;      // a beat held up by more work than this is late (was: a gap over 250 ms)
const SILENCE_UNIT_LOOPS = 6.3;     // the most work between two messages (was: 2 s of silence; ~3.4 loops there)
const FIRST_SECOND_LOOPS = 3.5;     // Building's "first second" (was 1 s)
const SHOTS = join(ROOT, 'tools', 'supports-out');
const W = 1280, H = 800;

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return o;
}
/* A block with a square tunnel through it along y: the x-z section is a 3 x 3
   grid of cells with the middle one open, extruded 40 mm. Every cell edge is
   shared, so the soup is watertight with no T-junctions. */
function tunnelBlock(x0, x1, z1) {
  const xs = [x0, x0 + 12, x1 - 12, x1], zs = [0, 8, 20, z1], cells = [];
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) if (!(i === 1 && k === 1)) cells.push([i, k]);
  const has = (i, k) => cells.some((c) => c[0] === i && c[1] === k);
  const out = [];
  const quad = (a, b, c, d, want) => {
    const u = b.map((x, i) => x - a[i]), w = c.map((x, i) => x - a[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0;
    for (const tri of flip ? [[a, c, b], [a, d, c]] : [[a, b, c], [a, c, d]]) for (const p of tri) out.push(...p);
  };
  for (const [i, k] of cells) {
    const xa = xs[i], xb = xs[i + 1], za = zs[k], zb = zs[k + 1];
    quad([xa, 0, za], [xb, 0, za], [xb, 0, zb], [xa, 0, zb], [0, -1, 0]);
    quad([xa, 40, za], [xb, 40, za], [xb, 40, zb], [xa, 40, zb], [0, 1, 0]);
    for (const [ni, nk, d, e] of [[i - 1, k, [-1, 0], [xa, za, xa, zb]], [i + 1, k, [1, 0], [xb, za, xb, zb]],
                                  [i, k - 1, [0, -1], [xa, za, xb, za]], [i, k + 1, [0, 1], [xa, zb, xb, zb]]]) {
      if (!has(ni, nk)) quad([e[0], 0, e[1]], [e[2], 0, e[3]], [e[2], 40, e[3]], [e[0], 40, e[1]], [d[0], 0, d[1]]);
    }
  }
  return out;
}
function stl(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return Array.from(b);
}
/* support:beacons' tilted box: turned 30 deg about y, lowest edge on the plate. */
const TILT = 30 * Math.PI / 180;
const tilted = box([0, 0, 0], [40, 30, 10]).map((v, i, a) => {
  const k = i % 3, p = a.slice(i - k, i - k + 3);
  return k === 0 ? p[0] * Math.cos(TILT) - p[2] * Math.sin(TILT)
    : k === 1 ? p[1] : p[0] * Math.sin(TILT) + p[2] * Math.cos(TILT);
});
const TILTED = stl(tilted);
const WITH_TUNNEL = stl([...tilted, ...tunnelBlock(60, 100, 30)]);
/* clamp_body standing on its 94 mm axis, as support:interface stands it: (x, y, z) -> (x, -z, y), on the plate */
async function standingClamp() {
  const buf = await readFile(join(ROOT, 'fixtures', 'supports', 'clamp_body.stl')), n = buf.readUInt32LE(80), out = Buffer.from(buf);
  let mz = Infinity;
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) mz = Math.min(mz, buf.readFloatLE(84 + t * 50 + 12 + k * 12 + 4));
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const o = 84 + t * 50 + 12 + k * 12, x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
    out.writeFloatLE(x, o); out.writeFloatLE(-z, o + 4); out.writeFloatLE(y - mz, o + 8);
  }
  return Array.from(out);
}
/* The bar's percent for a counted message: the phase's share of the one bar (app-supports-card.js PHASE_SPAN). */
const SPAN = { planning: [0, 50], building: [50, 100] };
const pctOf = (m) => { const sp = SPAN[m.phase], f = Math.min(1, m.done / m.total); return f >= 1 && sp[1] >= 100 ? 100 : Math.min(99, Math.round(sp[0] + (sp[1] - sp[0]) * f)); };

/** What a build's progress stream must look like, however long the piece: `log` is every message the card kept
    (NSO_SUPPORTS_CARD.onProgress), `spots` the beacons it was asked to plan. */
function progressChecks(label, log, spots) {
  const RANK = { detecting: 0, planning: 1, building: 2 }, WORD = { detecting: 'Detecting', planning: 'Planning', building: 'Building' };
  const counted = log.filter((m) => m.done != null);
  check(label + ': the phases arrive in order - detecting, planning, building (no welding: the parts are shells)', [...new Set(log.map((m) => m.phase))], ['detecting', 'planning', 'building']);
  check('...no message goes back to an earlier phase', log.every((m, i) => !i || RANK[m.phase] >= RANK[log[i - 1].phase]), true);
  check('...every count is a whole number, 0 <= done <= total', counted.every((m) => Number.isInteger(m.done) && Number.isInteger(m.total) && m.done >= 0 && m.done <= m.total), true);
  check('...within planning and within building, done and percent never go down and the total does not move',
    ['planning', 'building'].map((ph) => { const q = counted.filter((m) => m.phase === ph); return q.length > 1 && q.every((m, i) => !i || (m.done >= q[i - 1].done && m.percent >= q[i - 1].percent && m.total === q[i - 1].total)); }), [true, true]);
  check('...detecting has no count: done, total and percent are all null - no count is guessed',
    log.filter((m) => m.phase === 'detecting').every((m) => m.done == null && m.total == null && m.percent == null), true);
  check('...the percent is the whole build\'s: planning fills 0-50, building 50-100, the nearest whole number, 100 only when the work is done',
    counted.every((m) => m.percent === pctOf(m)), true);
  check('...the percent never goes down, from the first message to the last',
    counted.every((m, i) => !i || m.percent >= counted[i - 1].percent), true);
  check('...the line is the word, the count and the percent: "Planning 142 / 344 · 21 %"',
    counted.every((m) => m.line === WORD[m.phase] + ' ' + m.done + ' / ' + m.total + ' \u00b7 ' + m.percent + ' %') && log.filter((m) => m.done == null).every((m) => /^Detecting \u00b7 \d+ s$/.test(m.line)), true);
  const last = (ph) => [...log].reverse().find((m) => m.phase === ph), firstOf = (ph) => log.findIndex((m) => m.phase === ph);
  const lp = last('planning'), lb = last('building');
  check('...planning reaches ' + spots + ' / ' + spots + ' = 50 % before building begins, and building n / n = 100 % is the last message',
    [lp.done, lp.total, lp.percent, log.indexOf(lp) < firstOf('building'), lb.done === lb.total && lb.total > 0, lb.percent, log.indexOf(lb) === log.length - 1 || log.slice(log.indexOf(lb)).every((m) => m.percent === 100)],
    [spots, spots, 50, true, true, 100, true]);
}
/** What a person saw on every frame of a build: the bar is there, the bottom-right status says what the readout says,
    and the bar is filled to the readout's percent - or sweeping, with no percent, when the readout has none. */
function frameChecks(label, fr) {
  const pc = (f) => { const m = /(\d+) %$/.exec(f.line); return m ? Number(m[1]) : null; };
  check(label + ': on all ' + fr.length + ' frames the bar is shown and the status says what the readout says', fr.length > 0 && fr.every((f) => f.shown && f.status === f.line), true);
  check('...a readout with a percent has the bar filled to exactly it', fr.filter((f) => pc(f) != null).every((f) => !f.indeterminate && f.now === String(pc(f)) && f.width === pc(f) + '%'), true);
  check('...a readout without one is "Building…" or "Detecting · N s" on a bar that sweeps, with no value',
    fr.filter((f) => pc(f) == null).every((f) => /^(Building…|Detecting \u00b7 \d+ s)$/.test(f.line) && f.indeterminate && f.now === null), true);
}

const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEG = '°';
/* a progress message's phase and count (section 9's updates, and 10's seam) */
const key = (m) => m.phase + '|' + m.done + '|' + m.total;
/* the readout of a finished build (section 5's, and 7's and 9's: they are different steps) */
const BUILT = (n, h, u, r) => 'Built: ' + n + (n === 1 ? ' support' : ' supports') + ' · held ' + h + ' · unsupported ' + u + ' · unreachable ' + r;

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  /* A planner that throws, on purpose: the card logs it (console.error) and says so on its readout. */
  const expected = /planner exploded|planner threw at once/;
  let cdn = [];

  async function freshPage(files) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    cdn = cdn.concat(routeCdn(page));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !expected.test(m.text())) errors.push('console: ' + m.text()); });
    await page.goto(served.base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
    await page.waitForFunction(() => !!window.NSO_SUPPORTS_CARD, null, { timeout: 30000 });
    await page.evaluate((fs) => handleFiles(fs.map(([n, a]) => new File([new Uint8Array(a)], n))), files);
    await page.waitForFunction((n) => state.models.length === n && state.placed.length === n, files.length, { timeout: 30000 });
    return page;
  }

  /** Everything a step needs from a page, bound to it. */
  function tools(page) {
    const t = {};
    t.shot = async (file) => { await frames(page); if (!SHOTS_ON) return; await page.screenshot({ path: join(SHOTS, file) }); console.log('       ' + file); };
    t.view = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.view());
    t.idle = (ms = 120000) => page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: ms });
    t.undoDepth = () => page.evaluate(() => state.undoStack.length);
    t.sups = () => page.evaluate(() => state.models.filter((m) => m.nsoSupport && state.placed.some((p) => p.sourceId === m.id))
      .map((m) => ({ id: m.id, area: m.nsoSupport.regionId })));
    t.ids = (list) => list.map((s) => s.id).sort((a, b) => a - b);
    /** The plate as a person would compare it: which pieces, where, and what Undo holds. */
    t.plate = () => page.evaluate(() => ({
      placed: state.placed.map((p) => [p.sourceId, p.mesh.position.x, p.mesh.position.y, p.mesh.position.z]),
      models: state.models.map((m) => m.id),
      undo: state.undoStack.length, top: state.undoStack.length ? state.undoStack[state.undoStack.length - 1].type + '|' + (state.undoStack[state.undoStack.length - 1].label || '') : null
    }));
    /** The card as a person sees it: words, buttons, locks, rows, and what the HUD draws. */
    t.card = () => page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      const shown = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); return !e.hidden && r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; };
      const bar = $('sup-progress');
      const rows = [...$('sup-rows').querySelectorAll('button')].map((b) => ({ area: Number(b.dataset.area), text: b.textContent, kind: b.className.replace('sup-row ', '').replace('sup-row-', '') }));
      return {
        state: $('supports-card').dataset.state, line: $('sup-count').textContent, status: $('status').textContent,
        tagShown: shown($('adjust-status')) && /HUD inside/.test($('adjust-status').textContent),
        go: { text: $('btn-sup-all').textContent, on: !$('btn-sup-all').disabled },
        removeAll: { shown: shown($('btn-sup-none')), on: !$('btn-sup-none').disabled },
        remove: { shown: shown($('btn-sup-remove')), on: !$('btn-sup-remove').disabled },
        controls: ['sup-angle', 'sup-style', 'sup-size', 'sup-rest'].map((id) => !$(id).disabled),
        angle: $('sup-angle').value, note: $('sup-angle-note').textContent,
        locked: $('supports-card').classList.contains('is-locked'),
        rows: { shown: shown($('sup-rows')), list: rows },
        bar: bar ? { shown: shown(bar), indeterminate: bar.classList.contains('is-indeterminate'), now: bar.getAttribute('aria-valuenow'),
          width: bar.firstElementChild.style.width, text: bar.getAttribute('aria-valuetext'), phase: bar.dataset.phase,
          anim: getComputedStyle(bar.firstElementChild).animationName } : null,
        spinnerGone: !$('sup-spinner'),
        inside: (() => { const c = $('supports-card').getBoundingClientRect(); return c.width > 0 && c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight; })()
      };
    });
    /** The outlines in the scene: one mesh per area. */
    t.outlines = () => page.evaluate(() => {
      const g = state.scene.getObjectByName('supportsCardOverlay');
      if (!g) return null;
      return {
        kids: g.children.length, allMeshes: g.children.every((o) => o.isMesh && !o.isSprite),
        areas: g.children.map((o) => ({ area: o.userData.area, kind: o.userData.outline, colour: o.material.color.getHex(),
          opacity: o.material.opacity, verts: o.geometry.attributes.position.count }))
      };
    });
    t.screenOf = (p) => page.evaluate((q) => {
      const v = new THREE.Vector3(q[0], q[2], -q[1]).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height];
    }, p);
    /** Look at world point `at` (Z up) from direction `d`, `dist` mm away. */
    t.look = (at, d, dist) => page.evaluate(([at, d, dist]) => {
      const L = Math.hypot(d[0], d[1], d[2]), c = new THREE.Vector3(at[0], at[2], -at[1]);
      state.controls.target.copy(c);
      state.camera.position.set(c.x + d[0] / L * dist, c.y + d[2] / L * dist, c.z - d[1] / L * dist);
      state.camera.updateProjectionMatrix(); state.controls.update(); state.camera.updateMatrixWorld();
    }, [at, d, dist]);
    /** Look at the middle of piece `id` from direction `d`. */
    t.lookAtPiece = async (id, d, dist) => t.look(await page.evaluate((id) => {
      const bb = new THREE.Box3().setFromObject(state.placed.find((q) => q.sourceId === id).mesh), m = bb.getCenter(new THREE.Vector3());
      return [m.x, -m.z, m.y];
    }, id), d, dist);
    /** The screen point of the beacon nearest the middle of area `area`: inside its outline,
        whether or not the face in front is the one it is on. */
    t.areaXY = (area) => page.evaluate((area) => {
      const cand = window.NSO_SUPPORTS_CARD.view().beacons.filter((b) => b.region === area);
      const c = [0, 1, 2].map((k) => cand.reduce((s, b) => s + b.p[k], 0) / cand.length);
      const b = cand.reduce((m, x) => Math.hypot(x.p[0] - c[0], x.p[1] - c[1], x.p[2] - c[2]) < Math.hypot(m.p[0] - c[0], m.p[1] - c[1], m.p[2] - c[2]) ? x : m);
      const ndc = new THREE.Vector3(b.p[0], b.p[2], -b.p[1]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
      return [r.left + (ndc.x + 1) / 2 * r.width, r.top + (1 - ndc.y) / 2 * r.height];
    }, area);
    /** Where the middle of area `area` is in the view, in NDC, and the camera's distance to it. */
    t.areaInView = (area) => page.evaluate((area) => {
      const cand = window.NSO_SUPPORTS_CARD.view().beacons.filter((b) => b.region === area);
      const c = [0, 1, 2].map((k) => (Math.min(...cand.map((b) => b.p[k])) + Math.max(...cand.map((b) => b.p[k]))) / 2);
      const w = new THREE.Vector3(c[0], c[2], -c[1]), n = w.clone().project(state.camera);
      return { x: n.x, y: n.y, dist: state.camera.position.distanceTo(w) };
    }, area);
    /** A built support the camera sees first, and where. */
    t.supportXY = () => page.evaluate(() => {
      const r = state.renderer.domElement.getBoundingClientRect();
      for (const p of state.placed) {
        const m = state.models.find((x) => x.id === p.sourceId);
        if (!m || !m.nsoSupport) continue;
        const ndc = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).project(state.camera);
        const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), state.camera);
        const h = rc.intersectObjects(state.placed.map((q) => q.mesh), false)[0];
        if (h && h.object === p.mesh) return { id: p.sourceId, xy: [r.left + (ndc.x + 1) / 2 * r.width, r.top + (1 - ndc.y) / 2 * r.height] };
      }
      return null;
    });
    t.clickUndo = async () => { await page.click('#btn-undo'); await frames(page); await frames(page); };
    /** One step: it must add exactly one Undo entry. */
    t.oneStep = async (label, fn) => {
      const d0 = await t.undoDepth();
      const r = await fn();
      await t.idle();
      await frames(page);
      check(label + ' is one Undo step', await t.undoDepth(), d0 + 1);
      return r;
    };
    /** The debug HUD is gone: the build tag is not drawn, and the bottom-right status does not repeat the
        card's line - except while the bar is live (`building`), when it says the same words. */
    t.hudClean = async (label, building = false) => {
      const c = await t.card();
      check(label + ': no build tag drawn, and the status ' + (building ? 'says what the readout says' : 'does not repeat the readout'),
        [c.tagShown, c.status === c.line], [false, building]);
      return c;
    };
    /** Listen to the card's progress (and sample what a person sees on every frame) until `unwatch`. */
    t.watch = () => page.evaluate(() => {
      window.__log = []; window.__frames = []; window.__sampling = true;
      window.__off = window.NSO_SUPPORTS_CARD.onProgress((m) => window.__log.push(m));
      const sample = () => {
        if (!window.__sampling) return;
        if (window.NSO_SUPPORTS_CARD.busy()) {
          const bar = document.getElementById('sup-progress');
          window.__frames.push({ line: document.getElementById('sup-count').textContent, status: document.getElementById('status').textContent,
            shown: !bar.hidden, indeterminate: bar.classList.contains('is-indeterminate'), now: bar.getAttribute('aria-valuenow'), width: bar.firstElementChild.style.width });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    t.unwatch = () => page.evaluate(() => { window.__sampling = false; window.__off(); return { log: window.__log, frames: window.__frames }; });
    t.logLen = () => page.evaluate(() => window.__log.length);
    /** A probe for a build that ends on the card's own timers (the watchdog, the ceiling): started just before
        the click, it notes when the card went busy and when it stopped, every progress message, and the worst
        lag of the page's main thread - a 50 ms interval's lateness - in the page's own clock. A timer can only
        fire as late as the thread was busy when it was due, so that lag is what a late stop is held to. */
    t.lagProbe = () => page.evaluate(() => {
      const P = window.__lag = { t0: performance.now(), busy: null, end: null, max: 0, msgs: [] };
      let last = P.t0;
      P.off = window.NSO_SUPPORTS_CARD.onProgress(() => P.msgs.push(performance.now()));
      P.timer = setInterval(() => {
        const now = performance.now(), b = window.NSO_SUPPORTS_CARD.busy();
        P.max = Math.max(P.max, now - last - 50);
        last = now;
        if (b && P.busy === null) P.busy = now;
        if (!b && P.busy !== null && P.end === null) { P.end = now; clearInterval(P.timer); P.off(); }
      }, 50);
    });
    /* took / el: from just before the click (what a "not before" bound counts from - never later than the
       build's start); ran / elRan: from when the card was seen busy, within a probe tick of the start (what a
       "no later than" bound and the readout's seconds count from - the click itself takes its time). Read once
       the build is over, it waits for the probe's own tick to have seen the end (t.idle returns on the frame
       the card stops, a tick before the probe can have noted it). */
    t.lagRead = () => page.evaluate(() => new Promise((res) => {
      const P = window.__lag, s = (a, b) => (a === null || b === null ? null : (a - b) / 1000);
      const read = () => {
        const now = performance.now();
        return { took: s(P.end, P.t0), ran: s(P.end, P.busy), lag: Math.max(0, P.max) / 1000,
                 lastMsg: P.msgs.length ? s(P.msgs[P.msgs.length - 1], P.t0) : null, msgs: P.msgs.length,
                 endAfterMsg: P.msgs.length ? s(P.end, P.msgs[P.msgs.length - 1]) : null,
                 el: s(now, P.t0), elRan: s(now, P.busy) };
      };
      if (P.end !== null || window.NSO_SUPPORTS_CARD.busy()) { res(read()); return; }
      const t0 = performance.now(), w = setInterval(() => {
        if (P.end !== null || performance.now() - t0 > 3000) { clearInterval(w); res(read()); }
      }, 10);
    }));
    /** Hold the build worker's messages, from the first 'building' one on, until released, so BUILDING can be
        looked at: the next worker the card starts has its messages queued, then handed over in order. */
    t.holdBuild = () => page.evaluate(() => {
      const W = window.Worker, desc = Object.getOwnPropertyDescriptor(W.prototype, 'onmessage');
      let queue = [], holding = true, seen = false;
      window.__held = false;
      window.__release = () => { holding = false; const q = queue; queue = []; q.forEach((f) => f()); };
      window.Worker = function (url, o) {
        const w = new W(url, o);
        window.Worker = W;
        Object.defineProperty(w, 'onmessage', { configurable: true, get() { return desc.get.call(w); }, set(fn) {
          desc.set.call(w, fn && function (e) {
            if (holding && seen) { window.__held = true; queue.push(() => fn.call(w, e)); return; }
            if (e.data && e.data.progress && e.data.progress.phase === 'building') seen = true;
            return fn.call(w, e);
          });
        } });
        return w;
      };
    });
    /** A build that was refused or failed: the card says why, the plate is untouched, the card is live. */
    t.failed = async (label, before, why) => {
      const c = await t.card(), now = await t.plate();
      check(label + ': the card says "Could not build: ' + why + ' - nothing was added"', c.line, 'Could not build: ' + why + ' - nothing was added');
      check('...the plate is exactly as before, and Undo has nothing new', [now.placed, now.models, now.undo, now.top], [before.placed, before.models, before.undo, before.top]);
      check('...the card is live again: not building, not locked, the bar gone (and no spinner), the status line cleared, GENERATE on',
        [c.state !== 'building', c.locked, c.bar.shown, c.spinnerGone, c.status, c.go.on, c.controls], [true, false, false, true, '', true, [true, true, true, true]]);
      return c;
    };
    return t;
  }

  /* The tilted box's undersurface sits at 30 deg off the plate. */
  const DIR = [1, -0.45, -0.02];
  let page, T, c, v, xy, ol, s, before;

  if (RUN.card) {
  // =======================================================================
  console.log('\n--- 1. DETECT FIRST: opening the card detects at once ---');
  // =======================================================================
  page = await freshPage([['tilted.stl', TILTED]]);
  T = tools(page);
  const boxId = await page.evaluate(() => state.placed[0].sourceId);
  check('nothing is selected, nothing is built, Undo is empty', await page.evaluate(() => [state.selectedIndex, state.undoStack.length, window.NSO_SUPPORTS_CARD.watchdogMs()]), [-1, 0, 60000]);
  await T.lookAtPiece(boxId, DIR, 105);
  await page.click('#menu-supports > summary');
  await frames(page);
  c = await T.card();
  v = await T.view();
  check('opening Supports (the only piece, nothing selected) detects at once: IDLE, "1 hanging area at 35° on tilted"',
    [c.state, c.line, c.angle], ['idle', '1 hanging area at 35' + DEG + ' on tilted', '35']);
  check('...the angle defaults to 35\u00b0, Bambu\'s own 30\u00b0 named beside it', c.note, '35\u00b0 \u00b7 Bambu 30\u00b0');
  check('...the field says what the number means: faces within it of horizontal get support',
    await page.evaluate(() => /^Faces within this many degrees of horizontal get support\. /.test(document.getElementById('sup-angle').title)), true);
  check('...GENERATE is the one live button; Angle, Style, Size and May-rest are live; Remove all and Remove are out of sight',
    [c.go, c.removeAll.shown, c.remove.shown, c.controls, c.locked, c.rows.shown], [{ text: 'Generate', on: true }, false, false, [true, true, true, true], false, false]);
  check('...nothing is built and nothing was added to Undo', [(await T.sups()).length, await T.undoDepth()], [0, 0]);
  check('...the card sits wholly inside the 1280 x 800 window', c.inside, true);
  check('the Paint disclosure is gone: no Paint row, button, mode picker or word on the card',
    await page.evaluate(() => [!!document.getElementById('sup-more'), !!document.getElementById('btn-sup-paint'), !!document.getElementById('sel-sup-paint'),
      /paint/i.test(document.getElementById('supports-card').textContent)]), [false, false, false, false]);
  await T.hudClean('idle');
  ol = await T.outlines();
  const rows = new Set(v.beacons.map((b) => b.p[1].toFixed(3))).size, cols = v.beacons.length / rows;
  check('the face is 12 x 10 spots', [cols, rows], [12, 10]);
  check('the area is outlined once, faint white, on the surface: one outline of its 44 edge segments (not a grid), no dots, no badges',
    [ol.kids, ol.allMeshes, ol.areas.map((a) => [a.area, a.kind, a.colour, a.opacity < 0.6, a.verts])], [1, true, [[0, 'on', 0xffffff, true, 2 * (cols + rows) * 6]]]);
  await T.shot('01-detected-on-open.png');

  // =======================================================================
  console.log('\n--- 2. the angle is on the card and re-detects as it changes ---');
  // =======================================================================
  await page.fill('#sup-angle', '25');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().angle === 25, null, { timeout: 10000 });
  await frames(page);
  c = await T.card();
  check('25° is below the underside\'s 30°: nothing hangs, no outline, GENERATE off',
    [c.state, c.line.startsWith('Nothing hangs in air'), await T.outlines(), c.go.on], ['nothing', true, null, false]);
  await T.shot('02-angle-25-nothing.png');
  await page.fill('#sup-angle', '60');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().angle === 60, null, { timeout: 10000 });
  await frames(page);
  c = await T.card();
  check('60° finds the area again: "1 hanging area at 60° on tilted", outlined, GENERATE on',
    [c.state, c.line, (await T.outlines()).areas.length, c.go.on], ['idle', '1 hanging area at 60' + DEG + ' on tilted', 1, true]);
  check('...the label follows the field, Bambu\'s 30 beside it (the same measure: no 90 minus)', c.note, '60\u00b0 \u00b7 Bambu 30\u00b0');
  await page.fill('#sup-angle', '95');
  await frames(page);
  c = await T.card();
  check('an angle outside 1..89 is refused in words and changes nothing', [c.line, (await T.view()).angle], ['The angle is between 1' + DEG + ' and 89' + DEG + '.', 60]);
  await page.fill('#sup-angle', '35');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().angle === 35 && window.NSO_SUPPORTS_CARD.view().state === 'idle', null, { timeout: 10000 });
  await frames(page);
  check('back at 35°: the first line again', [(await T.card()).line, (await T.card()).note], ['1 hanging area at 35' + DEG + ' on tilted', '35\u00b0 \u00b7 Bambu 30\u00b0']);
  check('the angle is a setting, not an edit: Undo is still empty', await T.undoDepth(), 0);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());

  // =======================================================================
  console.log('\n--- 3. edit before GENERATE: click an outline, Shift-click a spot ---');
  // =======================================================================
  xy = await T.areaXY(0);
  await T.oneStep('Leaving the area out', async () => { await page.mouse.click(xy[0], xy[1]); });
  c = await T.card();
  check('the count drops: "0 hanging areas at 35° on tilted · 1 left out", still IDLE', [c.state, c.line], ['idle', '0 hanging areas at 35' + DEG + ' on tilted · 1 left out']);
  check('...the outline dims to grey', (await T.outlines()).areas.map((a) => [a.kind, a.colour]), [['off', 0x7b8494]]);
  check('...GENERATE is off (nothing to build), and nothing was built', [c.go.on, (await T.sups()).length], [false, 0]);
  await T.hudClean('left out');
  await T.shot('03-area-left-out.png');
  await T.clickUndo();
  c = await T.card();
  check('Undo puts it back: "1 hanging area", white', [c.line, (await T.outlines()).areas[0].kind], ['1 hanging area at 35' + DEG + ' on tilted', 'on']);
  await T.oneStep('Leaving the area out again', async () => { await page.mouse.click(xy[0], xy[1]); });
  await T.oneStep('Putting it back', async () => { await page.mouse.click(xy[0], xy[1]); });
  c = await T.card();
  check('a click on the grey outline puts it back: white, GENERATE on, nothing built',
    [c.line, (await T.outlines()).areas[0].kind, c.go.on, (await T.sups()).length], ['1 hanging area at 35' + DEG + ' on tilted', 'on', true, 0]);

  const wall = await page.evaluate(() => {
    const p = state.placed.find((q) => q.mesh && !state.models.find((m) => m.id === q.sourceId).nsoSupport);
    const sp = meshToWorldSoup(p.mesh), B = window.NSO_SUPPORTS_CARD.view().beacons;
    let best = null;
    for (let t = 0; t < sp.length; t += 9) {
      const tri = [0, 1, 2].map((k) => [sp[t + k * 3], -sp[t + k * 3 + 2], sp[t + k * 3 + 1]]);
      const u = tri[1].map((x, i) => x - tri[0][i]), w = tri[2].map((x, i) => x - tri[0][i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], L = Math.hypot(...n);
      if (n[1] / L > -0.99) continue;
      const cc = [0, 1, 2].map((i) => (tri[0][i] + tri[1][i] + tri[2][i]) / 3);
      const d = Math.min(...B.map((b) => Math.hypot(b.p[0] - cc[0], b.p[1] - cc[1], b.p[2] - cc[2])));
      if (!best || d > best.d) best = { p: cc, d };
    }
    return best;
  });
  const wallXY = await T.screenOf(wall.p);
  const d3 = await T.undoDepth();
  await page.keyboard.down('Shift');
  await page.mouse.click(wallXY[0], wallXY[1]);
  await page.keyboard.up('Shift');
  await frames(page);
  c = await T.card();
  v = await T.view();
  check('Shift-click on the wall adds one spot: an area of its own, one Undo step',
    [c.line, v.areas.length, v.beacons.filter((b) => b.manual).length, await T.undoDepth()], ['2 hanging areas at 35' + DEG + ' on tilted', 2, 1, d3 + 1]);
  check('...both areas outlined the same way', (await T.outlines()).areas.map((a) => [a.area, a.kind, a.colour]), [[0, 'on', 0xffffff], [1, 'on', 0xffffff]]);
  await T.hudClean('added spot');
  await T.shot('04-spot-added.png');
  xy = await T.screenOf(wall.p);
  await T.oneStep('Leaving the new area out', async () => { await page.mouse.click(xy[0], xy[1]); });
  check('a click on its outline dims just that area: "1 hanging area ... · 1 left out"',
    [(await T.card()).line, (await T.outlines()).areas.map((a) => [a.area, a.kind])], ['1 hanging area at 35' + DEG + ' on tilted · 1 left out', [[0, 'on'], [1, 'off']]]);
  await T.clickUndo();
  check('Undo: both areas again', (await T.card()).line, '2 hanging areas at 35' + DEG + ' on tilted');
  await T.clickUndo();
  check('Undo again takes the spot away', [(await T.card()).line, (await T.view()).beacons.length, await T.undoDepth()], ['1 hanging area at 35' + DEG + ' on tilted', 120, d3]);

  // =======================================================================
  console.log('\n--- 4. GENERATE: BUILDING ---');
  // =======================================================================
  await T.holdBuild();
  const d4 = await T.undoDepth();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.__held === true, null, { timeout: 120000 });
  await frames(page);
  c = await T.card();
  check('BUILDING: the button is off and reads "Building…" (the seconds only past 10)', c.go, { text: 'Building…', on: false });
  const held = /^Building (\d+) \/ (\d+) \u00b7 (\d+) %$/.exec(c.line);
  check('...the card says the phase and is locked: Angle, Style, Size, May-rest all off. Held in building, so: "Building n / N · p %", p from 50 to under 100',
    [c.state, !!held && +held[1] < +held[2] && +held[3] >= 50 && +held[3] < 100, c.locked, c.controls], ['building', true, true, [false, false, false, false]]);
  await T.hudClean('building', true);
  check('...one bar is under the readout, filled to that percent, carrying the same words; the spinner is gone',
    [c.bar.shown, c.bar.indeterminate, c.bar.now, c.bar.width, c.bar.text === c.line, c.bar.phase, c.spinnerGone], [true, false, held && held[3], held && held[3] + '%', true, 'building', true]);
  check('...nothing is on the plate yet, and no Undo step yet', [(await T.sups()).length, await T.undoDepth()], [0, d4]);
  await T.shot('05-building.png');
  await page.evaluate(() => window.__release());
  await T.idle();
  await frames(page);
  check('Generate is one Undo step', await T.undoDepth(), d4 + 1);

  // =======================================================================
  console.log('\n--- 5. BUILT, REGENERATE, REMOVE, REMOVE ALL ---');
  // =======================================================================
  c = await T.card();
  s = await T.sups();
  const N = s.length, built1 = T.ids(s);
  // the card's own plural (app-supports-card.js plural): 1 support, 2 supports
  check('BUILT: "Built: N supports · held 1 · unsupported 0 · unreachable 0", N the supports on the plate',
    [c.state, c.line, N > 0], ['built', BUILT(N, 1, 0, 0), true]);
  check('...GENERATE reads REGENERATE and REMOVE ALL sits beside it; Remove (one) is shown, off until a support is picked; no rows (nothing needs a look)',
    [c.go, c.removeAll, c.remove, c.bar.shown, c.locked, c.rows.shown], [{ text: 'Regenerate', on: true }, { shown: true, on: true }, { shown: true, on: false }, false, false, false]);
  await T.hudClean('built');
  check('...every spot is held, the area is still outlined in white', [(await T.view()).beacons.every((b) => b.state === 'held'), (await T.outlines()).areas.map((a) => a.kind)], [true, ['on']]);
  check('...the supports are card supports of area 0', s.length > 0 && (await page.evaluate(() => state.models.filter((m) => m.nsoSupport).every((m) => m.nsoSupport.card && m.nsoSupport.regionId === 0))), true);
  await T.shot('06-built.png');

  await T.oneStep('Regenerate', () => page.click('#btn-sup-all'));
  s = await T.sups();
  check('REGENERATE: none of the old supports is left, and as many new ones stand', [s.length, T.ids(s).some((id) => built1.includes(id))], [N, false]);
  check('...the card reads BUILT again with the same numbers', [(await T.card()).state, (await T.card()).line], ['built', BUILT(N, 1, 0, 0)]);
  await T.clickUndo();
  check('Undo puts the old ones back, the same pieces; the card reads BUILT', [T.ids(await T.sups()), (await T.card()).state], [built1, 'built']);

  const sup = await T.supportXY();
  check('found a support the camera sees', !!sup, true);
  await page.mouse.click(sup.xy[0], sup.xy[1]);
  await frames(page);
  c = await T.card();
  check('a click on a built support picks it (the app\'s own selection); Remove is live',
    [await page.evaluate(() => window.NSO_SUPPORTS_CARD.selected()), c.remove.on, c.state], [sup.id, true, 'built']);
  await T.shot('07-support-picked.png');
  await T.oneStep('Remove', () => page.click('#btn-sup-remove'));
  s = await T.sups();
  c = await T.card();
  check('REMOVE took exactly that one', T.ids(s), built1.filter((id) => id !== sup.id));
  check('...the line follows: one fewer support, the area no longer held - it is unsupported, with a row',
    [c.line, c.rows.list.map((r) => [r.area, r.kind])], [BUILT(N - 1, 0, 1, 0), [[0, 'unsupported']]]);
  await T.clickUndo();
  check('Undo puts it back: N supports, held 1', [T.ids(await T.sups()), (await T.card()).line], [built1, BUILT(N, 1, 0, 0)]);

  await T.oneStep('Remove all', () => page.click('#btn-sup-none'));
  c = await T.card();
  check('REMOVE ALL: every support off the plate, the card back in IDLE, the area still outlined',
    [(await T.sups()).length, c.state, c.line, c.go, c.removeAll.shown, (await T.outlines()).areas.map((a) => a.kind)],
    [0, 'idle', '1 hanging area at 35' + DEG + ' on tilted', { text: 'Generate', on: true }, false, ['on']]);
  await T.clickUndo();
  check('Undo puts the same pieces back and the card reads BUILT', [T.ids(await T.sups()), (await T.card()).state], [built1, 'built']);

  // =======================================================================
  console.log('\n--- 6. every build ends in a state ---');
  // =======================================================================
  /* With supports standing (REGENERATE): a planner that throws, one that
     throws at once, one that refuses. Each leaves the supports as they were. */
  before = await T.plate();
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.setPlanner(() => Promise.reject(new Error('planner exploded'))));
  await page.click('#btn-sup-all');
  await T.idle();
  await frames(page);
  c = await T.failed('a planner that throws', before, 'planner exploded');
  check('...the old supports still stand, the card still reads BUILT\'s Regenerate', [T.ids(await T.sups()), c.state, c.go.text], [built1, 'built', 'Regenerate']);
  await T.shot('08-could-not-build.png');
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.setPlanner(() => { throw new Error('planner threw at once'); }));
  await page.click('#btn-sup-all');
  await T.idle();
  await T.failed('a planner that throws at once', before, 'planner threw at once');
  const WHY = 'Every support point is inside the piece, so there is nowhere to start a support';
  await page.evaluate((w) => window.NSO_SUPPORTS_CARD.setPlanner(() => Promise.resolve({ ok: false, reason: w + '.', inside: [] })), WHY);
  await page.click('#btn-sup-all');
  await T.idle();
  await T.failed('a planner that refuses', before, WHY);

  /* The watchdog: a planner that never answers. */
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.setPlanner(() => new Promise(() => {})));
  before = await T.plate();
  const t0 = Date.now();
  await T.lagProbe();
  await page.click('#btn-sup-all');
  await sleep(3000);
  c = await T.card();
  check('3 s in: a planner that says nothing gets "Building…" with no seconds yet, locked, the bar up and sweeping with no percent',
    [c.state, c.line, c.locked, c.bar.shown, c.bar.indeterminate, c.bar.now], ['building', 'Building…', true, true, true, null]);
  await sleep(Math.max(0, 12500 - (Date.now() - t0)));
  /* The seconds against the page's own clock, read with the card: on a slow runner the read itself can land past
     13 s, which is the runner, not the counter. */
  c = await T.card();
  const at12 = await T.lagRead(), shownS = +((c.line.match(/^Building… (\d+) s$/) || [])[1]);
  /* The readout is the whole seconds since the start, ticked once a second: it is behind by up to a second
     and a tick, and a tick can be as late as the page's thread was busy. */
  const behind = at12.elRan === null ? null : at12.elRan - shownS;
  check('past 10 s the readout counts the seconds, on the card and on the button - the seconds the build has run, to a tick',
    [shownS >= 10 && behind !== null && behind >= -0.5 && behind < 1.5 + 2 * at12.lag, c.go.text === c.line], [true, true]);
  console.log('       FINDING the readout said ' + shownS + ' s at ' + (at12.elRan === null ? '-' : at12.elRan.toFixed(1)) +
    ' s into the build on the page\'s clock (' + at12.el.toFixed(1) + ' s after the click began)');
  await T.shot('09-building-12s.png');
  await T.idle(90000);
  const wd = await T.lagRead();
  await frames(page);
  console.log('       FINDING the watchdog stopped it ' + (wd.ran === null ? 'never' : wd.ran.toFixed(2) + ' s') + ' into the build on the page\'s clock (' +
    ((Date.now() - t0) / 1000).toFixed(1) + ' s here); the page\'s thread lagged ' + wd.lag.toFixed(2) + ' s at worst');
  check('the watchdog stops a build that says nothing at 60 s (default), not before, and no later than the page\'s own lag allows (1 s + twice its worst)',
    [wd.took !== null && wd.took >= 59.5, wd.ran !== null && wd.ran - 60 < 1 + 2 * wd.lag], [true, true]);
  check('...and the bar turns into the message: gone, the readout says "Could not build"', [(await T.card()).bar.shown, (await T.card()).line.startsWith('Could not build: ')], [false, true]);
  c = await T.failed('a planner that never answers', before, 'the planner was still working after 60 s');
  check('...the old supports still stand', T.ids(await T.sups()), built1);
  await T.shot('10-timed-out.png');

  /* The card recovers: the real planner builds again, REGENERATE as ever. */
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.setPlanner(null));
  await T.oneStep('Regenerate after a timeout', () => page.click('#btn-sup-all'));
  c = await T.card();
  check('...and the real planner builds again: BUILT', [c.state, c.line], ['built', BUILT(N, 1, 0, 0)]);
  await page.close();
  }

  if (RUN.counts) {
  // =======================================================================
  console.log('\n--- 7. the three counts: held / unsupported / unreachable ---');
  // =======================================================================
  page = await freshPage([['with-tunnel.stl', WITH_TUNNEL]]);
  T = tools(page);
  const bId = await page.evaluate(() => state.placed[0].sourceId);
  await page.click('#menu-supports > summary');
  await frames(page);
  /* Into the tunnel from the front, a little above and to the side. */
  await T.look([80, 20, 15], [0.12, -1, 0.3], 150);
  c = await T.card();
  check('the box and the tunnel block: IDLE at once, "2 hanging areas at 35° on with-tunnel", each outlined in white',
    [c.state, c.line, (await T.outlines()).areas.map((a) => [a.area, a.kind])], ['idle', '2 hanging areas at 35' + DEG + ' on with-tunnel', [[0, 'on'], [1, 'on']]]);
  await T.shot('11-two-areas.png');
  await T.oneStep('Generate', () => page.click('#btn-sup-all'));
  c = await T.card();
  v = await T.view();
  const NB = (await T.sups()).length;
  /* The tunnel's ceiling (96 spots) is held only in part: the planner steers
     out of the tunnel's mouths to the 24 spots by them and cannot reach the
     72 between. An area the build held in part gives its lost spots an area
     of their own (app-supports-card.js effective(), supports-curved-sheet,
     #265 - an area read "unreachable" whole for its lost spots, the arc of
     simple_overhang.3mf for three at its foot): the mouths read held, the
     middle is Area 3, unreachable. Before #265 this section expected the
     whole ceiling one unreachable area. */
  check('BUILT: "held 2 · unsupported 0 · unreachable 1" - the plate cannot reach the tunnel ceiling\'s middle; the spots by its mouths are held',
    [c.state, c.line, NB > 0], ['built', BUILT(NB, 2, 0, 1), true]);
  check('...the stats behind the line, and the three add up to every area', [v.stats.held, v.stats.unsupported, v.stats.unreachable, v.stats.held + v.stats.unsupported + v.stats.unreachable === v.areas.length],
    [2, 0, 1, true]);
  check('...the ceiling split where the build left off: its 24 spots by the mouths held, its 72 between an area of their own',
    [v.areas.length, v.areas[1].count, v.areas[1].kind, v.areas[2].count, v.areas[2].kind], [3, 24, 'held', 72, 'unreachable']);
  check('...the unreachable area stays outlined in red; the held ones are white',
    (await T.outlines()).areas.map((a) => [a.area, a.kind, a.colour]), [[0, 'on', 0xffffff], [1, 'on', 0xffffff], [2, 'red', 0xff2d2d]]);
  check('...one row under the readout, for the area that needs a look', [c.rows.shown, c.rows.list.map((r) => [r.area, r.kind, r.text])],
    [true, [[2, 'unreachable', 'Area 3 · unreachable · no route to the plate · ' + v.areas[2].count + ' spots']]]);
  await T.hudClean('built, one unreachable');
  const dist0 = (await T.areaInView(2)).dist;
  await T.look([0, 0, 0], [1, 1, 1], 400);                     // somewhere else, so the row has to bring it back
  await page.click('#sup-rows button[data-area="2"]');
  await frames(page);
  const fr = await T.areaInView(2);
  check('a click on the row frames the area: its middle is in the middle of the view, and the camera has come in',
    [Math.abs(fr.x) < 0.1, Math.abs(fr.y) < 0.1, fr.dist < 200], [true, true, true]);
  await T.shot('12-row-framed.png');
  const dX = await T.undoDepth();
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.toggleArea(2));
  await frames(page);
  c = await T.card();
  check('leaving the unreachable area out after the build moves it to unsupported: held 2 · unsupported 1 · unreachable 0, row "left out"',
    [c.line, c.rows.list.map((r) => [r.area, r.kind, r.text.includes('left out')]), (await T.outlines()).areas.map((a) => [a.area, a.kind]), await T.undoDepth()],
    [BUILT(NB, 2, 1, 0), [[2, 'unsupported', true]], [[0, 'on'], [1, 'on'], [2, 'off']], dX + 1]);
  await T.clickUndo();
  check('Undo puts the red outline and the unreachable count back', [(await T.card()).line, (await T.outlines()).areas[2].kind], [BUILT(NB, 2, 0, 1), 'red']);
  await T.oneStep('Remove all', () => page.click('#btn-sup-none'));

  /* An area left out BEFORE the build is unsupported too. */
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.toggleArea(1));
  await frames(page);
  await T.oneStep('Generate with the tunnel left out', () => page.click('#btn-sup-all'));
  c = await T.card();
  v = await T.view();
  check('GENERATE with an area left out: held 1 · unsupported 1 · unreachable 0, with a row for it',
    [c.line, c.rows.list.map((r) => [r.area, r.kind, r.text.includes('left out')])], [BUILT((await T.sups()).length, 1, 1, 0), [[1, 'unsupported', true]]]);
  check('...nothing was built for it: every support is of area 0', await page.evaluate(() => state.models.filter((m) => m.nsoSupport).every((m) => m.nsoSupport.regionId === 0)), true);
  await page.close();

  // =======================================================================
  console.log('\n--- 8. selecting a piece while the card is open detects there ---');
  // =======================================================================
  const TUNNEL_ONLY = stl(tunnelBlock(0, 40, 30));
  page = await freshPage([['tilted.stl', TILTED], ['tunnel.stl', TUNNEL_ONLY]]);
  T = tools(page);
  const ids = await page.evaluate(() => state.placed.map((p) => p.sourceId));
  await page.evaluate(() => selectPlaced(-1));
  await page.click('#menu-supports > summary');
  await frames(page);
  c = await T.card();
  check('two pieces, none selected: the card asks for one, GENERATE off, nothing outlined',
    [c.state, c.line, c.go.on, await T.outlines()], ['pick', 'Click a piece to see where it needs holding.', false, null]);
  const centreOf = (id) => page.evaluate((id) => {
    const n = new THREE.Box3().setFromObject(state.placed.find((q) => q.sourceId === id).mesh).getCenter(new THREE.Vector3()).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return [r.left + (n.x + 1) / 2 * r.width, r.top + (1 - n.y) / 2 * r.height];
  }, id);
  await T.look([0, 0, 0], [0.3, -1, 1.4], 260);
  const dSel = await T.undoDepth();
  const cA = await centreOf(ids[0]);
  await page.mouse.click(cA[0], cA[1]);
  await frames(page);
  c = await T.card();
  check('a click on the first piece detects there at once: "1 hanging area at 35° on tilted", outlined, nothing generated',
    [c.state, c.line, (await T.outlines()).kids, (await T.sups()).length, await T.undoDepth()], ['idle', '1 hanging area at 35' + DEG + ' on tilted', 1, 0, dSel]);
  await T.shot('13-select-a.png');
  await page.evaluate((i) => selectPlaced(i), 1);
  await page.waitForFunction((id) => window.NSO_SUPPORTS_CARD.host() === id, ids[1], { timeout: 10000 });
  await frames(page);
  c = await T.card();
  v = await T.view();
  check('selecting the other piece in the app (the Pieces list) moves the card there: its own areas, outlined, at once',
    [c.state, c.line.endsWith(' on tunnel'), v.areas.length, (await T.outlines()).kids], ['idle', true, v.areas.length, v.areas.length]);
  await T.shot('14-select-b.png');
  await page.close();
  }

  if (RUN.builds) {
  // =======================================================================
  console.log('\n--- 9. the wedge: library/v9_mirror_factory.stl ---');
  // =======================================================================
  const WEDGE = Array.from(await readFile(join(ROOT, 'library', 'v9_mirror_factory.stl')));
  page = await freshPage([['v9_mirror_factory.stl', WEDGE]]);
  T = tools(page);
  const wId = await page.evaluate(() => state.placed[0].sourceId);
  await T.lookAtPiece(wId, [0.3, -1, 0.9], 330);
  const tOpen = Date.now();
  await page.click('#menu-supports > summary');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().state === 'idle', null, { timeout: 30000 });
  await frames(page);
  const openMs = Date.now() - tOpen;
  c = await T.card();
  v = await T.view();
  check('opening Supports on the wedge detects at once: 10 hanging areas outlined, nothing generated',
    [c.state, c.line, (await T.outlines()).kids, (await T.sups()).length, await T.undoDepth()], ['idle', '10 hanging areas at 35' + DEG + ' on v9_mirror_factory', 10, 0, 0]);
  console.log('       detect on open: ' + openMs + ' ms, ' + v.beacons.length + ' spots in ' + v.areas.length + ' areas; biggest area ' + Math.max(...v.areas.map((a) => a.count)) + ' spots');
  await T.shot('15-wedge-detected.png');
  await page.fill('#sup-angle', '60');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().angle === 60, null, { timeout: 15000 });
  await frames(page);
  c = await T.card();
  v = await T.view();
  check('the angle re-detects on the wedge too: at the old default 60°, 25 areas, 427 spots (326 at 35°)',
    [c.line, v.beacons.length], ['25 hanging areas at 60' + DEG + ' on v9_mirror_factory', 427]);
  await page.fill('#sup-angle', '35');
  await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.view().angle === 35, null, { timeout: 15000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await frames(page);

  /* The build that used to hang: the 377 spots under the slab (at 60 deg; 317
     at 35) took the planner minutes (nso_support_aim.js's inside test walked
     every triangle on every probe). With the spatial index it takes seconds,
     so Generate over all 10 areas ENDS BUILT, inside the default 60 s watchdog. The watchdog path is
     covered by section 8's planner that never answers, not by this piece. */
  before = await T.plate();
  const wedgeSpots = (await T.view()).beacons.length;
  const wedgeCal0 = await pace.inPage(page);
  await T.watch();
  const tb = Date.now();
  await T.oneStep('Generate over all 10 areas', () => page.click('#btn-sup-all'));
  const buildMs = Date.now() - tb;
  const wedgeRun = await T.unwatch();
  /* The build's own time - its last message, from the start of the job - over the loops run either side of it. */
  const wedgeCal = (wedgeCal0 + await pace.inPage(page)) / 2;
  const wedgeMs = wedgeRun.log.length ? wedgeRun.log[wedgeRun.log.length - 1].ms : buildMs;
  console.log(pace.finding('the wedge build', { ms: wedgeMs, cal: wedgeCal, loops: wedgeMs / wedgeCal }));
  await frames(page);
  c = await T.card();
  v = await T.view();
  const nSup = (await T.sups()).length;
  console.log('       BUILT: ' + c.line + '  (' + (buildMs / 1000).toFixed(1) + ' s); stats ' + JSON.stringify(v.stats));
  check('Generate over all 10 areas ends BUILT, inside the watchdog and well inside the old planner\'s minutes: under ' + WEDGE_BUILD_LOOPS + ' calibration loops',
    [c.state, c.bar.shown, c.locked, wedgeMs / wedgeCal < WEDGE_BUILD_LOOPS], ['built', false, false, true]);
  check('...with the three counts pinned, which add up to all 10 areas',
    [v.stats.held, v.stats.unsupported, v.stats.unreachable, v.stats.held + v.stats.unsupported + v.stats.unreachable], [WEDGE_HELD, WEDGE_UNSUPPORTED, WEDGE_UNREACHABLE, 10]);
  check('...the line is the three counts', c.line, BUILT(nSup, v.stats.held, v.stats.unsupported, v.stats.unreachable));
  check('...a row for every area that is not held', c.rows.list.length, v.stats.unsupported + v.stats.unreachable);
  await T.shot('17-wedge-built.png');

  /* The progress of that build: at least 10 updates, counted the way a person sees them (a change of
     phase, done or total - a repeat of the last message is a beat, not an update). */
  const updates = wedgeRun.log.filter((m, i) => !i || key(m) !== key(wedgeRun.log[i - 1])).length;
  check('the wedge build showed at least 10 progress updates', updates >= 10, true);
  progressChecks('the wedge build', wedgeRun.log, wedgeSpots);
  frameChecks('the wedge build, as a person saw it', wedgeRun.frames);
  /* The planner's own cadence: gaps between the times the WORKER posted (the page may take a message up later,
     busy drawing a frame). The planning and building loops beat every 200 ms; the stretches that cannot
     (the first detect, the pad gaps) are single calls. There is no welding: the parts come back as shells. */
  const sentGaps = (ph) => { const q = wedgeRun.log.filter((m) => ph.includes(m.phase)); return q.slice(1).map((m, i) => m.sent - q[i].sent); };
  const gaps = sentGaps(['planning', 'building']).sort((a, b) => a - b);
  /* The work in a gap is the gap less the beat; held to loops, the beat share and the longest silence mean what
     250 ms and 2 s meant on this box, on any runner. */
  const unit = (g) => Math.max(0, g - HEARTBEAT_MS) / wedgeCal;
  const over = gaps.filter((g) => unit(g) > LATE_UNIT_LOOPS).length, longest = unit(gaps[gaps.length - 1]);
  console.log('       ' + updates + ' updates in ' + (buildMs / 1000).toFixed(1) + ' s; planner gaps (planning + building): median ' + gaps[gaps.length >> 1] +
    ' ms, max ' + gaps[gaps.length - 1] + ' ms, ' + over + ' of ' + gaps.length + ' late by more than ' + LATE_UNIT_LOOPS + ' loops (' +
    Math.round(LATE_UNIT_LOOPS * wedgeCal) + ' ms here); the longest silence ' + longest.toFixed(2) + ' loops of work');
  check('the planner is heard from every beat in all but a handful of its messages, and never goes quiet for more than ' + SILENCE_UNIT_LOOPS + ' loops of work',
    // 5%, not 2%: a CI runner starved for CPU stretched 25 of 686 beats past 250 ms (the build took 37 s, not 23 s)
    // while never going quiet for a second; a planner that stopped beating would put nearly all of them over.
    // 6.3 loops is the 2 s it was, not the 1 s before that, for now: since supports-print-1 (#256) the sheet / cap
    // planning posts nothing for ~1.2 s on the wedge (622 ms before it). Ticket supports-progress-cadence posts
    // progress inside the sheet step and puts this back under 1 s (2.8 loops). The 60 s watchdog (section 12) is unchanged.
    [over <= Math.ceil(gaps.length * 0.05), longest < SILENCE_UNIT_LOOPS], [true, true]);

  /* Escape in the middle of planning, on the real worker: REGENERATE over the standing supports, stopped at once. */
  const standing = T.ids(await T.sups());
  await page.evaluate(() => { window.__terminated = 0; const t = Worker.prototype.terminate; Worker.prototype.terminate = function () { window.__terminated++; return t.call(this); }; });
  before = await T.plate();
  await T.watch();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => { const q = window.NSO_SUPPORTS_CARD.progress(); return q && q.phase === 'planning' && q.done > 0; }, null, { timeout: 60000 });
  c = await T.card();
  check('REGENERATE over the wedge, the bar live in planning: the line is "Planning n / ' + wedgeSpots + ' · p %", REGENERATE and REMOVE ALL are off',
    [new RegExp('^Planning \\d+ / ' + wedgeSpots + ' \u00b7 \\d+ %$').test(c.line), c.go.on, c.removeAll.shown, c.removeAll.on], [true, false, true, false]);
  await T.shot('18a-wedge-planning.png');
  await page.keyboard.press('Escape');
  await T.idle(20000);
  await frames(page);
  const nAtStop = await T.logLen();
  c = await T.card();
  check('Escape: the card says "Build cancelled - nothing was added", the bar gone, the status line cleared, the card live and still BUILT',
    [c.line, c.bar.shown, c.status, c.locked, c.state, c.go.on], ['Build cancelled - nothing was added', false, '', false, 'built', true]);
  check('...the worker was terminated', await page.evaluate(() => window.__terminated >= 1), true);
  const nowPlate = await T.plate();
  check('...the plate is exactly as before, Undo has nothing new, the old supports stand', [nowPlate.placed, nowPlate.models, nowPlate.undo, nowPlate.top, T.ids(await T.sups())],
    [before.placed, before.models, before.undo, before.top, standing]);
  await sleep(1500);
  check('...and the stopped worker says nothing more: no message after Escape, the plate still untouched',
    [await T.logLen(), (await T.plate()).undo], [nAtStop, before.undo]);
  await T.unwatch();
  await T.shot('18b-wedge-escape.png');
  await page.close();
  }

  if (RUN.counts) {
  // =======================================================================
  console.log('\n--- 10. PROGRESS: one bar, the phase word, a percent only where there is a count ---');
  // =======================================================================
  page = await freshPage([['tilted.stl', TILTED]]);
  T = tools(page);
  const pId = await page.evaluate(() => state.placed[0].sourceId);
  await T.lookAtPiece(pId, DIR, 105);
  await page.click('#menu-supports > summary');
  await frames(page);
  const boxSpots = (await T.view()).beacons.length;
  await T.watch();
  await T.oneStep('Generate, watched', () => page.click('#btn-sup-all'));
  const boxRun = await T.unwatch();
  progressChecks('the box build', boxRun.log, boxSpots);
  frameChecks('the box build, as a person saw it', boxRun.frames);
  c = await T.card();
  check('...and it ends BUILT: the bar gone, the status line cleared', [c.state, c.bar.shown, c.status], ['built', false, '']);
  const builtIds = T.ids(await T.sups());

  /* REGENERATE with the worker's messages held in building: the bar is live, and nothing that changes the plate can be pressed. */
  await T.holdBuild();
  before = await T.plate();
  await page.click('#btn-sup-all');
  await page.waitForFunction(() => window.__held === true, null, { timeout: 120000 });
  await frames(page);
  c = await T.card();
  check('while the bar is live REGENERATE and REMOVE ALL are shown and off, Remove is off, Angle / Style / Size / May-rest are off, the card is locked',
    [c.go.on, c.removeAll.shown, c.removeAll.on, c.remove.on, c.controls, c.locked, c.bar.shown], [false, true, false, false, [false, false, false, false], true, true]);
  await page.evaluate(() => { for (const id of ['btn-sup-all', 'btn-sup-none', 'btn-sup-remove']) document.getElementById(id).click(); });
  await frames(page);
  check('...a click on any of them (even forced) does nothing: no second build, nothing taken off, nothing new in Undo',
    [(await T.card()).state, T.ids(await T.sups()), (await T.plate()).undo], ['building', builtIds, before.undo]);
  await T.shot('19-regenerating-held.png');

  /* Escape: cancelled, and the worker's late messages cannot touch the plate. */
  await page.keyboard.press('Escape');
  await T.idle(20000);
  await frames(page);
  c = await T.card();
  check('Escape cancels: "Build cancelled - nothing was added", the bar gone, the status line cleared, the card live and still BUILT',
    [c.line, c.bar.shown, c.status, c.locked, c.state, c.go.on, c.go.text], ['Build cancelled - nothing was added', false, '', false, 'built', true, 'Regenerate']);
  let now = await T.plate();
  check('...the plate is exactly as before, Undo has nothing new, the old supports stand', [now.placed, now.models, now.undo, now.top, T.ids(await T.sups())],
    [before.placed, before.models, before.undo, before.top, builtIds]);
  await page.evaluate(() => window.__release());
  await sleep(2500);
  now = await T.plate();
  check('...and when the held messages are handed over afterwards they change nothing: same plate, same Undo, still "Build cancelled"',
    [now.placed, now.models, now.undo, T.ids(await T.sups()), (await T.card()).line], [before.placed, before.models, before.undo, builtIds, 'Build cancelled - nothing was added']);
  await T.shot('20-cancelled.png');
  await T.oneStep('Regenerate after a cancel', () => page.click('#btn-sup-all'));
  check('...the card builds again straight after: BUILT', [(await T.card()).state, (await T.card()).line], ['built', BUILT((await T.sups()).length, 1, 0, 0)]);

  /* A planner that reports nonsense is not believed: a count that goes backwards, past its total, an unknown
     phase, an earlier phase. Only what makes sense reaches the bar. Then it refuses, and the bar is the message. */
  await page.evaluate((n) => {
    window.NSO_SUPPORTS_CARD.setPlanner((soup, opts) => new Promise((resolve) => {
      const say = opts.onProgress, wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const steps = [{ phase: 'planning', done: Math.round(n / 4), total: n }, { phase: 'planning', done: 3, total: n },
        { phase: 'planning', done: n * 9, total: n }, { phase: 'planning', done: -1, total: n }, { phase: 'sweeping', done: 1, total: 2 },
        { phase: 'detecting', done: null, total: null }, { phase: 'planning', done: n, total: n }];
      (async () => { for (const m of steps) { say(m); await wait(120); } await wait(400); resolve({ ok: false, reason: 'seam done', inside: [] }); })();
    }));
  }, boxSpots);
  before = await T.plate();
  await T.watch();
  await page.click('#btn-sup-all');
  await T.idle();
  await frames(page);
  const seamRun = await T.unwatch();
  check('a planner that reports nonsense: the bar was told only what makes sense - ' + Math.round(boxSpots / 4) + ' / ' + boxSpots + ' (a quarter of planning, 13 % of the bar), then ' + boxSpots + ' / ' + boxSpots + ' (planning done, 50 %)',
    /* a repeat of the last message is a beat, not an update */
    seamRun.log.filter((m, i) => !i || key(m) !== key(seamRun.log[i - 1])).map((m) => [m.phase, m.done, m.total, m.percent]), [['planning', Math.round(boxSpots / 4), boxSpots, Math.round(50 * Math.round(boxSpots / 4) / boxSpots)], ['planning', boxSpots, boxSpots, 50]]);
  frameChecks('...as a person saw it', seamRun.frames);
  await T.failed('the refusal after it', before, 'seam done');
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.setPlanner(null));
  await page.close();
  }

  if (RUN.builds) {
  // =======================================================================
  console.log('\n--- 11. THE CLAMP: one bar to 100 %, Building moving from the start ---');
  // =======================================================================
  page = await freshPage([['clamp_body.stl', await standingClamp()]]);
  T = tools(page);
  await page.click('#menu-supports > summary');
  await page.waitForFunction(() => /hanging area/.test(window.NSO_SUPPORTS_CARD.view().count), null, { timeout: 60000 });
  c = await T.card();
  const clampSpots = (await T.view()).beacons.length;
  check('the clamp, standing: detected at once at the card\'s defaults', /^\d+ hanging areas? at 35° on clamp_body/.test(c.line), true);
  console.log('       ' + c.line + ', ' + clampSpots + ' spots');
  const clampCal0 = await pace.inPage(page);
  await T.watch();
  const tc = Date.now();
  await T.oneStep('Generate on the clamp', () => page.click('#btn-sup-all'));
  const clampMs = Date.now() - tc;
  const clampRun = await T.unwatch();
  const clampCal = (clampCal0 + await pace.inPage(page)) / 2;
  const clampBuildMs = clampRun.log.length ? clampRun.log[clampRun.log.length - 1].ms : clampMs;
  console.log(pace.finding('the clamp build', { ms: clampBuildMs, cal: clampCal, loops: clampBuildMs / clampCal }));
  c = await T.card();
  const clampSups = (await T.sups()).length;
  const distinct = (ph) => new Set(clampRun.log.filter((m) => m.phase === ph && m.done != null).map((m) => m.done)).size;
  const span = (ph) => { const q = clampRun.log.filter((m) => m.phase === ph); return q.length ? ((q[q.length - 1].sent - q[0].sent) / 1000).toFixed(1) + ' s' : '-'; };
  const firstB = clampRun.log.filter((m) => m.phase === 'building'), bTotal = firstB.length ? firstB[0].total : 0;
  console.log('       ' + c.line + ' in ' + (clampMs / 1000).toFixed(1) + ' s: planning ' + span('planning') + ' (' + distinct('planning') + ' counts), building ' +
    span('building') + ' (' + distinct('building') + ' counts of ' + bTotal + ')');
  check('the clamp ends BUILT with supports added, inside ' + CLAMP_BUILD_LOOPS + ' calibration loops', [c.state, clampSups > 0, clampBuildMs / clampCal < CLAMP_BUILD_LOOPS], ['built', true, true]);
  check('...the bar reached 100 %', Math.max(...clampRun.log.map((m) => m.percent == null ? -1 : m.percent)), 100);
  check('...with at least 3 distinct Planning counts and 3 distinct Building counts on the way', [distinct('planning') >= 3, distinct('building') >= 3], [true, true]);
  /* the sheet is planned before the first trunk: its tips are counted, so the first second of building is not a still bar */
  const b1 = firstB.length ? firstB.filter((m) => m.sent - firstB[0].sent <= FIRST_SECOND_LOOPS * clampCal) : [];
  check('...Building moves within its first ' + FIRST_SECOND_LOOPS + ' loops (a second on this box: the sheet\'s tips are counted while it is planned)', new Set(b1.map((m) => m.done)).size >= 3, true);
  progressChecks('the clamp build', clampRun.log, clampSpots);
  frameChecks('the clamp build, as a person saw it', clampRun.frames);
  await T.shot('21-clamp-built.png');
  await page.close();
  }

  if (RUN.watchdog) {
  // =======================================================================
  console.log('\n--- 12. THE WATCHDOG IS SILENCE ---');
  // =======================================================================
  page = await freshPage([['tilted.stl', TILTED]]);
  T = tools(page);
  await page.click('#menu-supports > summary');
  await frames(page);
  const chatSpots = (await T.view()).beacons.length;
  /* A planner that is slow but says so: a count every 5 s for 90 s, then its own refusal. */
  await page.evaluate((n) => {
    window.NSO_SUPPORTS_CARD.setPlanner((soup, opts) => new Promise((resolve) => {
      let k = 0;
      const tick = setInterval(() => {
        k++;
        opts.onProgress({ phase: 'planning', done: Math.min(n - 1, k), total: n });
        if (k >= 18) { clearInterval(tick); resolve({ ok: false, reason: 'slow but said so', inside: [] }); }
      }, 5000);
    }));
  }, chatSpots);
  before = await T.plate();
  await T.lagProbe();
  await page.click('#btn-sup-all');
  await sleep(65000);
  c = await T.card();
  check('a planner that posts every 5 s is still running at 65 s, past the 60 s watchdog: "Planning n / N", locked',
    [c.state, /^Planning \d+ \/ \d+ · \d+ %$/.test(c.line), c.locked], ['building', true, true]);
  await T.idle(60000);
  const p12 = await T.lagRead();
  await frames(page);
  console.log('       FINDING it ended ' + (p12.took === null ? 'never' : p12.took.toFixed(2) + ' s') + ' after the click, its last message at ' +
    (p12.lastMsg === null ? '-' : p12.lastMsg.toFixed(2) + ' s') + ' (' + p12.msgs + ' messages), the page\'s thread lagging ' + p12.lag.toFixed(2) + ' s at worst');
  check('...and is not stopped: at 90 s it ends with its own answer, not the watchdog\'s - on its last message, within the page\'s own lag',
    [p12.took !== null && p12.took >= 89, p12.endAfterMsg !== null && p12.endAfterMsg < 1 + 2 * p12.lag], [true, true]);
  await T.failed('...a planner that was slow but said so', before, 'slow but said so');
  /* The ceiling: a build that keeps reporting but never ends is stopped at it (here 8 s, by the seam). */
  await page.evaluate(() => {
    window.NSO_SUPPORTS_CARD.ceilingMs(8000);
    window.NSO_SUPPORTS_CARD.setPlanner((soup, opts) => new Promise(() => {
      let k = 0;
      setInterval(() => opts.onProgress({ phase: 'planning', done: Math.min(1 + (k++ % 2), 2), total: 3 }), 500);
    }));
  });
  await T.lagProbe();
  await page.click('#btn-sup-all');
  await T.idle(30000);
  const pc = await T.lagRead();
  await frames(page);
  console.log('       FINDING the ceiling stopped it ' + (pc.ran === null ? 'never' : pc.ran.toFixed(2) + ' s') + ' into the build, the page\'s thread lagging ' +
    pc.lag.toFixed(2) + ' s at worst');
  check('a build that keeps reporting but never ends is stopped at the ceiling, not before, and no later than the page\'s own lag allows',
    [pc.took !== null && pc.took >= 7.5, pc.ran !== null && pc.ran - 8 < 1 + 2 * pc.lag], [true, true]);
  await T.failed('...the runaway', before, 'the build was still running after 8 s');
  check('...the ceiling is 10 min by default', await page.evaluate(() => [window.NSO_SUPPORTS_CARD.ceilingMs(0), window.NSO_SUPPORTS_CARD.watchdogMs()]), [600000, 60000]);
  await page.evaluate(() => window.NSO_SUPPORTS_CARD.setPlanner(null));
  await page.close();
  }

  // =======================================================================
  console.log('\n--- the build ---');
  // =======================================================================
  check('nothing hit the CDN unrouted', cdn.filter((x) => x.startsWith('UNROUTED')), []);
  check('no uncaught page errors', errors, []);
  await browser.close();
  served.srv.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
