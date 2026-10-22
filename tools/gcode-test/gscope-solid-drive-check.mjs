#!/usr/bin/env node
/**
 * nest-optimizer / tools/gcode-test / gscope-solid-drive-check.mjs
 *
 * G-scope's solid view and "Export as solid", driven through the real app in
 * headless Chromium - real clicks on the real buttons, the real Mirror at the
 * end. The headless proofs (runs, the closed sweep, every shell through the
 * canonical checker) are tools/gcode-test/gscope-solid-check.js.
 *
 *   1  THE TOGGLE. Toolpath | Solid in the Render row: shown for a slice,
 *      hidden for a mesh document. Solid draws the swept shells of exactly
 *      the moves the toolpath view draws, switches the lines' material off
 *      (still raycastable), and back again. View only: plate, undo stack and
 *      downloads untouched; the selection survives the round trip.
 *   2  IT FOLLOWS THE FILTERS. The slider, "only", Clear from view: the solid
 *      shown is the solid of the moves shown, rebuilt from the chain cache.
 *      A real click on a line in solid mode still picks that one move.
 *   3  VOLUME. The same selection in both views: the toolpath export's
 *      volume, the solid export's volume, and the Isolate detail meshes in
 *      each mode - equal, up to the counted seam closures.
 *   4  EXPORT AS SOLID, END TO END. The button puts a piece on the plate;
 *      its rawTris pass tools/mesh_validate.py --gate; the real Mirror button
 *      reflects it; the mirrored piece passes the gate too, same volume, one
 *      Undo restores it. Then a stacked 45-loop selection through the same
 *      route - fused where the loops touch, passing the gate - and Inner + Outer
 *      wall on every layer through "Solid STL": the fused solid, triangle for
 *      triangle, passing the gate. One run downloads exactly as swept.
 *   5  SCREENSHOTS, each asserted to be a drawn frame, to tools/gscope-out/.
 *
 * Usage: node tools/gcode-test/gscope-solid-drive-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serveRoot, routeCdn, mkCheck, launchOpts, ROOT } from '../cth-test/browser-lib.mjs';
import gscopeCards from '../nso_gscope_cards.js';        // opens the card a G-scope control lives in, before the click

const check = mkCheck();
const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';
const CUBE = 'fixtures/box-20mm.stl';
const SHOTS = join(ROOT, 'tools', 'gscope-out');

function soupToSTL(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return b;
}

function validate(file) {
  let out;
  try {
    out = execFileSync('python3', [join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
      { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  return { open: r.open_edges, nm: r.nonmanifold_edges, degen: r.degenerate_tris,
           pierce: (r.self_intersection || {}).pierce || 0, volume: r.signed_volume, verdict: r.verdict };
}

async function frames(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/* A real click made while a big slice is live in G-scope. G-scope redraws
   every frame, and under headless Chromium's software GL the whole tabletop
   slice costs ~2.5 s a frame on a quiet box (measured: this click took 23.4 s
   unthrottled, and hit Playwright's 30 s default at 2x CPU throttle - the
   exact TimeoutError CI shard 6 kept reporting at this click, on a8a4ea2 and
   after). A real mouse click queues behind several of those frames, so the
   default is sized for a light page, not this one. Only the clicks made with
   tabletop on screen use this; every other click keeps the 30 s default, so a
   genuine hang elsewhere still fails fast.
   The budget is also counted in FRAMES: HEAVY_CLICK_FRAMES of this page's own
   frame time, measured once tabletop is up (heavyFrame) - 150 s at the 2.5 s a
   frame it was sized on - so a runner whose frames are slower than that gets as
   many frames, not as many seconds. The seconds it had stay the floor: 150 s
   for a heavy click, and for the waits made with tabletop on screen
   (heavy(HEAVY_WAIT_FRAMES), 60 s at 2.5 s a frame) the light page's 30 s,
   which is at least what each of them had (10, 15 or 30 s). So no budget here
   is shorter than it was; on a slow runner, it is longer. */
const HEAVY_CLICK_FRAMES = 60, HEAVY_WAIT_FRAMES = 24;
const HEAVY_CLICK_MS = 150000, WAIT_MS = 30000;
let FRAME_MS = 2500;
const heavy = (frames, floor = WAIT_MS) => Math.max(floor, Math.round(frames * FRAME_MS));
async function heavyFrame(page) {
  FRAME_MS = await page.evaluate(() => new Promise((r) => {
    const t = [];
    const f = () => { t.push(performance.now()); if (t.length < 4) requestAnimationFrame(f); else r((t[3] - t[0]) / 3); };
    requestAnimationFrame(f);
  }));
  console.log(`       FINDING tabletop on screen: ${Math.round(FRAME_MS)} ms a frame; a heavy click may take ${Math.round(heavy(HEAVY_CLICK_FRAMES, HEAVY_CLICK_MS) / 1000)} s, a heavy wait ${Math.round(heavy(HEAVY_WAIT_FRAMES) / 1000)} s`);
}
function heavyClick(page, sel) { return page.click(sel, { timeout: heavy(HEAVY_CLICK_FRAMES, HEAVY_CLICK_MS) }); }

async function shot(page, file, label, target = 'scope') {
  if (target === 'scope') await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  await frames(page);
  const path = join(SHOTS, file);
  await page.locator(target === 'scope' ? '#microscope' : 'body').screenshot({ path });
  const px = await page.evaluate((t) => {
    let r, scene, cam;
    if (t === 'scope') { const v = window.NSO_MICROSCOPE.getView(); r = v.renderer; scene = v.scene; cam = v.camera; }
    else { r = state.renderer; scene = state.scene; cam = state.camera; }
    r.render(scene, cam);
    const gl = r.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const seen = new Set();
    let lit = 0;
    for (let i = 0; i < buf.length; i += 4 * 97) {
      seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
      if (buf[i] > 0x20 || buf[i + 1] > 0x20 || buf[i + 2] > 0x20) lit++;
    }
    return { distinct: seen.size, lit, w, h };
  }, target);
  const size = (await stat(path)).size;
  check(`${label}: screenshot is a drawn view`, px.distinct > 6 && px.lit > 20 && px.w > 300 && px.h > 300, true);
  console.log(`       ${file}  ${px.w}x${px.h}, ${px.distinct} colours, ${px.lit} lit, ${(size / 1024).toFixed(0)} kB`);
}

const plateSnapshot = (page) => page.evaluate(() => ({
  models: state.models.map((m) => [m.id, m.name, m.rawTris ? m.rawTris.length : 0]),
  undo: state.undoStack.length,
}));

/** Volume of every mesh in a three.js group, in its own (view) space - a rotation keeps volume. */
const groupVolume = (page, which) => page.evaluate((w) => {
  const v = window.NSO_MICROSCOPE.getView();
  let vol = 0, n = 0;
  const g = w === 'detail' ? v.detailGroup : v.overviewGroup;
  g.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const p = o.geometry.attributes.position.array;
    n++;
    for (let t = 0; t < p.length; t += 9) {
      vol += p[t] * (p[t + 4] * p[t + 8] - p[t + 5] * p[t + 7]) - p[t + 1] * (p[t + 3] * p[t + 8] - p[t + 5] * p[t + 6]) +
             p[t + 2] * (p[t + 3] * p[t + 7] - p[t + 4] * p[t + 6]);
    }
  });
  return { vol: vol / 6, meshes: n };
}, which);

const geomVolume = (page, solid) => page.evaluate((s) => {
  const g = window.NSO_MICROSCOPE.geometry(s);
  const p = g.attributes.position.array;
  let vol = 0;
  for (let t = 0; t < p.length; t += 9) {
    vol += p[t] * (p[t + 4] * p[t + 8] - p[t + 5] * p[t + 7]) - p[t + 1] * (p[t + 3] * p[t + 8] - p[t + 5] * p[t + 6]) +
           p[t + 2] * (p[t + 3] * p[t + 7] - p[t + 4] * p[t + 6]);
  }
  return { vol: vol / 6, tris: p.length / 9, stats: s ? g.userData.solid : null };
}, solid);

function projectJS([x, y, z]) {
  const M = window.NSO_MICROSCOPE, d = M.getDoc(), v = M.getView();
  const p = new THREE.Vector3(x - d.cx, z, -(y - d.cy)).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
}

async function openSlice(page) {
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  await page.setInputFiles('#file-input', join(ROOT, SLICE));
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() &&
    (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'toolpath', null, { timeout: 30000 });
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const TMP = await mkdtemp(join(tmpdir(), 'gscope-solid-'));
  const served = await serveRoot();
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  gscopeCards.install(page);
  routeCdn(page);
  const errors = [];
  let downloads = 0;
  page.on('download', () => { downloads++; });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(served.base + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 30000 });
  await page.waitForFunction(() => !!window.NSO_MICROSCOPE && !!window.NSOGcodeSolid, null, { timeout: 30000 });

  // =======================================================================
  console.log('\n--- 1. the toggle ---');
  // =======================================================================
  await openSlice(page);
  const snap0 = await plateSnapshot(page);
  const dl0 = downloads;
  const ui0 = await page.evaluate(() => ({
    row: getComputedStyle(document.getElementById('ms-render-row')).display !== 'none',
    tp: document.getElementById('ms-render-toolpath').classList.contains('active'),
    so: document.getElementById('ms-render-solid').classList.contains('active'),
    mode: window.NSO_MICROSCOPE.renderMode(),
  }));
  check('a slice shows the Render row, with Toolpath on and Solid off', [ui0.row, ui0.tp, ui0.so, ui0.mode],
    [true, true, false, 'toolpath']);
  await shot(page, 'solid-01-toolpath.png', 'the slice in the toolpath view');

  await page.click('#ms-render-solid');
  await page.evaluate(() => window.NSO_MICROSCOPE.flushView());
  const s1 = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView(), d = M.getDoc();
    const node = window.NSOGcodeSolid.buildSolid(d.parsed.moves);
    const lines = Object.values(v.overviewMeshes);
    return {
      mode: M.renderMode(),
      pressed: document.getElementById('ms-render-solid').getAttribute('aria-pressed'),
      solidFeatures: Object.keys(v.solidMeshes).sort(),
      lineFeatures: Object.keys(v.overviewMeshes).filter((k) => k !== 'Travel').sort(),
      linesDrawn: lines.filter((m) => m.material.visible).length,
      linesRaycastable: lines.filter((m) => m.visible || M.hidden().includes(m.userData.feature)).length === lines.length,
      shown: v.solidBuilt.stats, node: node.stats,
      read: document.getElementById('ms-render-read').textContent,
    };
  });
  check('Solid (real click): the toggle flips and says so', [s1.mode, s1.pressed], ['solid', 'true']);
  check('one solid mesh per drawn feature', s1.solidFeatures, s1.lineFeatures);
  check('the lines stop drawing but stay in the scene (a pick still lands on them)', [s1.linesDrawn, s1.linesRaycastable], [0, true]);
  check('the solid shown is the solid of every move - same shells, same volume as the builder run headless',
    [s1.shown.moves, s1.shown.shells, +s1.shown.solidVolume.toFixed(6)],
    [s1.node.moves, s1.node.shells, +s1.node.solidVolume.toFixed(6)]);
  check('the Render row reads what it drew', /1190 closed shells from 2895 moves/.test(s1.read) && /seam-closed/.test(s1.read), true);
  console.log('       ' + s1.read);
  await shot(page, 'solid-02-solid.png', 'the same slice as a live solid');

  // the selection survives the round trip
  await page.evaluate(() => { window.NSO_MICROSCOPE.soloGroup('Inner wall'); });
  await page.click('#ms-btn-select-visible');
  const selA = await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((s) => s.mv.index).join(','));
  await page.click('#ms-render-toolpath');
  const selB = await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((s) => s.mv.index).join(','));
  await page.click('#ms-render-solid');
  const selC = await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((s) => s.mv.index).join(','));
  check('the selection is the same moves in either view, across a round trip', [selA === selB, selB === selC, selA.split(',').length],
    [true, true, 180]);
  await page.click('#ms-render-toolpath');
  const back = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    return { solid: Object.keys(v.solidMeshes).length, drawn: Object.values(v.overviewMeshes).every((m) => m.material.visible) };
  });
  check('Toolpath (real click) puts the lines back and drops the solid', [back.solid, back.drawn], [0, true]);
  await page.evaluate(() => window.NSO_MICROSCOPE.showAll());
  await page.click('#ms-render-solid');
  check('toggling is view only: plate, undo stack and downloads untouched',
    [JSON.stringify(await plateSnapshot(page)) === JSON.stringify(snap0), downloads - dl0], [true, 0]);

  // =======================================================================
  console.log('\n--- 2. it follows the filters ---');
  // =======================================================================
  const f = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, d = M.getDoc();
    M.setZRange(20, 24);
    M.flushView();
    const shown = M.shownCount(), st = M.shownSolid().stats;
    const t0 = performance.now();
    M.setZRange(0, d.zLevels.length - 1); M.flushView();
    M.setZRange(20, 24); M.flushView();
    const again = performance.now() - t0;
    return { shown, moves: st.moves, chains: st.chains, cache: d.solidCache.size, again };
  });
  check('slider at 5 layers: the solid is of exactly the moves drawn', f.moves, f.shown);
  console.log(`       ${f.moves} moves, ${f.chains} chains; ${f.cache} chains cached; full + band redraw ${f.again.toFixed(0)} ms`);
  await shot(page, 'solid-03-slider-band.png', 'five layers of solid under the slider');
  await page.evaluate(() => { const M = window.NSO_MICROSCOPE; M.setZRange(0, M.getDoc().zLevels.length - 1); M.soloGroup('Outer wall'); M.flushView(); });
  const solo = await page.evaluate(() => {
    const v = window.NSO_MICROSCOPE.getView();
    return Object.keys(v.solidMeshes).filter((k) => v.solidMeshes[k].visible);
  });
  check('"only Outer wall": the only solid drawn is the Outer wall\'s', solo, ['Outer wall']);

  // A real click on a line, in solid mode.
  await page.click('#ms-mode-line');
  const target = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    const top = Math.max(...d.segments.filter((s) => s.feature === 'Outer wall').map((s) => s.layer));
    const s = d.segments.find((q) => q.feature === 'Outer wall' && q.layer === top && q.mv.length > 10);
    return { idx: s.mv.index, mid: [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z] };
  });
  await page.evaluate((idx) => {
    // Frame the move so a click can land on it.
    const M = window.NSO_MICROSCOPE; M.pickLine(idx); M.isolate(); M.back();
  }, target.idx);
  const px = await page.evaluate(projectJS, target.mid);
  await page.evaluate(() => window.NSO_MICROSCOPE.setSelectionMoves([]));
  await page.mouse.click(px[0], px[1]);
  const picked = await page.evaluate(() => window.NSO_MICROSCOPE.selection().map((s) => s.mv.index));
  check('in the solid view a real click on a bead still picks that one move', picked, [target.idx]);
  await shot(page, 'solid-04-picked-line.png', 'a picked move, highlighted as its own solid');
  await page.evaluate(() => window.NSO_MICROSCOPE.showAll());

  // =======================================================================
  console.log('\n--- 3. volume: the same selection in both views ---');
  // =======================================================================
  await page.evaluate(() => { window.NSO_MICROSCOPE.soloGroup('Inner wall'); window.NSO_MICROSCOPE.selectVisible(); });
  const gT = await geomVolume(page, false), gS = await geomVolume(page, true);
  const st = gS.stats;
  console.log(`       toolpath export ${gT.vol.toFixed(4)} mm3 (${gT.tris} tris) | solid export ${gS.vol.toFixed(4)} mm3 (${gS.tris} tris) | seams ${st.seamAddedMm3.toFixed(4)}`);
  check('solid export volume = toolpath export volume + the counted seam closures (rel < 1e-5)',
    Math.abs(gS.vol - (gT.vol + st.seamAddedMm3)) / gT.vol < 1e-5, true);
  check('and the builder\'s own toolpath figure is the toolpath export\'s (rel < 1e-5)',
    Math.abs(st.toolpathVolume - gT.vol) / gT.vol < 1e-5, true);
  check('the solid needs a third fewer triangles than the prisms for the same beads', gS.tris < gT.tris * 0.75, true);
  await page.click('#ms-render-toolpath');
  await page.evaluate(() => window.NSO_MICROSCOPE.isolate());
  // The toolpath view's Isolate draws the selection as-is: its lines, one per move.
  const dT = await page.evaluate(() => {
    const M = window.NSO_MICROSCOPE, v = M.getView();
    return { kinds: [...new Set(v.detailGroup.children.map((c) => c.type))],
      verts: v.detailGroup.children.reduce((a, c) => a + c.geometry.attributes.position.count, 0),
      n: M.selection().length };
  });
  await page.evaluate(() => window.NSO_MICROSCOPE.back());
  await page.click('#ms-render-solid');
  await page.evaluate(() => window.NSO_MICROSCOPE.isolate());
  const dS = await groupVolume(page, 'detail');
  await shot(page, 'solid-05-isolate-inner-wall.png', 'Isolate in the solid view: 45 Inner wall loops');
  await page.evaluate(() => window.NSO_MICROSCOPE.back());
  console.log(`       Isolate detail: toolpath ${dT.n} moves as lines | solid ${dS.vol.toFixed(4)} mm3`);
  check('Isolate in the toolpath view draws the selection as-is: one line per move',
    [dT.kinds, dT.verts], [['LineSegments'], dT.n * 2]);
  check('Isolate in the solid view holds what that view exports (rel < 1e-5)',
    Math.abs(dS.vol - gS.vol) / gS.vol < 1e-5, true);

  // =======================================================================
  console.log('\n--- 4. export as solid, end to end ---');
  // =======================================================================
  // (a) one continuous run, through the toolpath route's own doors.
  const loopIds = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    const inner = d.parsed.moves.filter((m) => m.feature === 'Inner wall');
    return window.NSOGcodeSolid.chainsOf(inner)[5].moves.map((m) => m.index);
  });
  await page.evaluate((ids) => { window.NSO_MICROSCOPE.showAll(); window.NSO_MICROSCOPE.setSelectionMoves(ids); }, loopIds);
  check('Export as solid is offered beside the toolpath export when a slice has a selection',
    [await page.isVisible('#ms-btn-export-solid-plate'), await page.isVisible('#ms-btn-export-solid-stl'),
     await page.isVisible('#ms-btn-export-plate')], [true, true, true]);
  const want1 = await page.evaluate(() => Array.from(window.NSO_MICROSCOPE.geometry(true).attributes.position.array));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ms-btn-export-solid-stl')]);
  const dlPath = join(TMP, 'dl.stl');
  await dl.saveAs(dlPath);
  const buf = await readFile(dlPath);
  check('Solid STL (real click) downloads the selection\'s solid, triangle for triangle',
    [/solid\.stl$/.test(dl.suggestedFilename()), buf.readUInt32LE(80), buf.subarray(84).equals(soupToSTL(want1).subarray(84))],
    [true, want1.length / 9, true]);
  const vDl = validate(dlPath);
  console.log('       one Inner wall run, downloaded: ' + JSON.stringify(vDl));
  check('and that file PASSES tools/mesh_validate.py --gate', [vDl.verdict, vDl.open, vDl.nm, vDl.pierce], ['PASS', 0, 0, 0]);

  // (b) a stacked, multi-run selection: every Inner wall, 45 loops, to the plate.
  await page.evaluate(() => { window.NSO_MICROSCOPE.soloGroup('Inner wall'); window.NSO_MICROSCOPE.selectVisible(); });
  const n2 = await page.evaluate(() => state.models.length);
  await page.click('#ms-btn-export-solid-plate');
  await page.waitForFunction((n) => state.models.length === n + 1, n2, { timeout: 30000 });
  const ex2 = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { id: m.id, name: m.name, raw: Array.from(m.rawTris), status: document.getElementById('status').textContent,
             open: window.NSO_MICROSCOPE.isOpen(), undoTop: state.undoStack[state.undoStack.length - 1].type };
  });
  console.log('       status: ' + ex2.status);
  check('Export as solid (real click): a new piece on the plate, G-scope closed, undo wired',
    [ex2.open, ex2.undoTop, / \(solid\)$/.test(ex2.name)], [false, 'addModels', true]);
  check('the status line says what the sweep made of it', /45 closed shells from 180 moves, 45 seam-closed loops/.test(ex2.status), true);
  // Three solids, not one: the part has no inner wall at layers 28-30, and one
  // loop between those gaps touches no other - the stack is three stacks.
  check('and what the union made of it: every junction fused, one solid per stack that really touches',
    /fused: 45 run shells -> 3 solids, 42 unions at 42 of 42 junctions \(42 stacked, 0 side by side\), 1 touching nothing, left as swept/.test(ex2.status), true);
  const fEx2 = join(TMP, 'stack-solid.stl');
  await writeFile(fEx2, soupToSTL(ex2.raw));
  const vEx2 = validate(fEx2);
  console.log('       45-loop stack on the plate: ' + JSON.stringify(vEx2));
  check('45 stacked loops on the plate PASS tools/mesh_validate.py (unfused: 504 non-manifold edges where shells met)',
    [vEx2.verdict, vEx2.open, vEx2.nm, vEx2.degen, vEx2.pierce], ['PASS', 0, 0, 0, 0]);
  check('and it holds the stack\'s material: stacked beads only touch, so the volume is the runs\' sum (rel < 1e-5)',
    Math.abs(vEx2.volume - gS.vol) / gS.vol < 1e-5, true);
  await shot(page, 'solid-06-stack-on-plate.png', 'the exported 45-loop solid on the plate', 'body');

  // (b2) two features across every layer - Inner + Outer wall - through the real Solid STL button.
  await page.click('#btn-microscope');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen(), null, { timeout: 10000 });
  const wallIds = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    return d.parsed.moves.filter((m) => m.feature === 'Inner wall' || m.feature === 'Outer wall').map((m) => m.index);
  });
  await page.evaluate((ids) => { window.NSO_MICROSCOPE.showAll(); window.NSO_MICROSCOPE.setSelectionMoves(ids); }, wallIds);
  const wantW = await page.evaluate(() => window.NSO_MICROSCOPE.fusedGeometry().then((g) =>
    ({ tris: Array.from(g.attributes.position.array), fuse: g.userData.fuse, label: window.NSO_MICROSCOPE.exportLabel() })));
  const [dlW] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#ms-btn-export-solid-stl')]);
  const dlWPath = join(TMP, 'walls.stl');
  await dlW.saveAs(dlWPath);
  const bufW = await readFile(dlWPath);
  const stW = await page.evaluate(() => document.getElementById('status').textContent);
  console.log('       ' + wantW.label);
  console.log('       status: ' + stW);
  check('Inner + Outer wall (2 features, every layer): the download is the fused solid, triangle for triangle',
    [bufW.readUInt32LE(80), bufW.subarray(84).equals(soupToSTL(wantW.tris).subarray(84))], [wantW.tris.length / 9, true]);
  check('the status line says every junction was fused and what overlap was counted once',
    /fused: 144 run shells -> 5 solids, 139 unions at 305 of 305 junctions/.test(stW) && /mm\u00b3 of overlap counted once/.test(stW), true);
  const vW = validate(dlWPath);
  console.log('       walls, downloaded: ' + JSON.stringify(vW));
  check('and that multi-run file PASSES tools/mesh_validate.py --gate', [vW.verdict, vW.open, vW.nm, vW.pierce], ['PASS', 0, 0, 0]);
  check('its volume is the runs minus their real overlap (as fuseShells measured it)',
    Math.abs(vW.volume - wantW.fuse.fusedVolume) / vW.volume < 1e-6 && wantW.fuse.overlapRemovedMm3 > 100, true);
  await page.click('#ms-close');

  // (c) Mirror, the real button, on an exported solid. Mirror reflects across
  // the piece's dominant axis and refuses a piece without one - every loop in
  // supportwithinsupport is square - so the piece comes from the other
  // committed slice: tabletop's longest seam-closed support loop that has a
  // clear long axis.
  await page.click('#btn-microscope');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen(), null, { timeout: 10000 });
  await page.evaluate(() => window.NSO_MICROSCOPE.reset());
  await page.setInputFiles('#file-input', join(ROOT, 'fixtures/3mf/tabletop.gcode.3mf'));
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() &&
    ((window.NSO_MICROSCOPE.getDoc() || {}).name || '').startsWith('tabletop'), null, { timeout: 60000 });
  await heavyFrame(page);
  const pick = await page.evaluate(() => {
    const d = window.NSO_MICROSCOPE.getDoc(), SO = window.NSOGcodeSolid;
    let best = null;
    for (const c of SO.chainsOf(d.parsed.moves)) {
      if (c.moves.length < 8) continue;
      const r = SO.sweepChain(c);
      if (r.pieces.length !== 1 || !r.pieces[0].closed) continue;
      const t = r.pieces[0].tris, lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], t[i + k]); hi[k] = Math.max(hi[k], t[i + k]); }
      const ex = [hi[0] - lo[0], hi[1] - lo[1]].sort((a, b) => b - a);
      if (ex[0] / ex[1] < 1.5) continue;
      if (!best || c.moves.length > best.ids.length) best = { ids: c.moves.map((m) => m.index), feature: c.moves[0].feature, ratio: ex[0] / ex[1] };
    }
    return best;
  });
  console.log(`       tabletop: ${pick.feature} loop, ${pick.ids.length} moves, long/short ${pick.ratio.toFixed(2)}`);
  await page.evaluate((ids) => window.NSO_MICROSCOPE.setSelectionMoves(ids), pick.ids);
  const n3 = await page.evaluate(() => state.models.length);
  await heavyClick(page, '#ms-btn-export-solid-plate');
  await page.waitForFunction((n) => state.models.length === n + 1, n3, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  const ex = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { id: m.id, raw: Array.from(m.rawTris), status: document.getElementById('status').textContent };
  });
  console.log('       status: ' + ex.status);
  check('a ' + pick.ids.length + '-move loop exports as ONE seam-closed shell',
    new RegExp('1 closed shell from ' + pick.ids.length + ' moves, 1 seam-closed loop').test(ex.status), true);
  const fEx = join(TMP, 'loop-solid.stl');
  await writeFile(fEx, soupToSTL(ex.raw));
  const vEx = validate(fEx);
  console.log('       plate piece: ' + JSON.stringify(vEx));
  check('the piece on the plate PASSES tools/mesh_validate.py --gate (open 0, non-manifold 0, pierce 0)',
    [vEx.verdict, vEx.open, vEx.nm, vEx.pierce], ['PASS', 0, 0, 0]);

  await page.evaluate(() => { const e = document.getElementById('model-list'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await heavyClick(page, `.model-item[data-edit-id="${ex.id}"]`);
  await page.evaluate(() => {
    const b = document.getElementById('btn-mirror');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach((d) => { d.open = true; });
  });
  // Blank box first: Mirror reads the piece and names its axis - the same
  // first press a user makes.
  await page.fill('#inp-mirror-plane', '');
  await heavyClick(page, '#btn-mirror');
  await page.waitForFunction(() => /Mirror/.test(document.getElementById('status').textContent), null, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  const read = await page.evaluate(() => document.getElementById('status').textContent);
  console.log('       status: ' + read);
  check('Mirror reads the exported solid and finds its dominant axis', /Mirror: this piece runs along [XYZ]/.test(read), true);
  await page.fill('#inp-mirror-plane', '0');
  await heavyClick(page, '#btn-mirror');
  await page.waitForFunction(() => /Mirror done|Mirror refused/.test(document.getElementById('status').textContent), null, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  const mir = await page.evaluate((id) => {
    const m = state.models.find((q) => q.id === id);
    return { raw: Array.from(m.rawTris), status: document.getElementById('status').textContent,
             undoTop: state.undoStack[state.undoStack.length - 1].type };
  }, ex.id);
  console.log('       status: ' + mir.status);
  check('Mirror (real click) reflects the exported solid, with its own undo entry', [/Mirror done/.test(mir.status), mir.undoTop], [true, 'mirrorReplace']);
  const fMir = join(TMP, 'loop-solid-mirrored.stl');
  await writeFile(fMir, soupToSTL(mir.raw));
  const vMir = validate(fMir);
  console.log('       mirrored   : ' + JSON.stringify(vMir));
  const axisIdx = { X: 0, Y: 1, Z: 2 }[(/along ([XYZ])/.exec(read) || [])[1]];
  const span = (r, k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < r.length; i += 3) { lo = Math.min(lo, r[i]); hi = Math.max(hi, r[i]); } return [lo, hi]; };
  const [a0, a1] = span(ex.raw, axisIdx), [b0, b1] = span(mir.raw, axisIdx);
  check('the mirrored piece PASSES the gate too: axis negated, same triangle count, same volume',
    [vMir.verdict, b0 === -a1 && b1 === -a0, mir.raw.length, Math.abs(vMir.volume - vEx.volume) < 1e-9],
    ['PASS', true, ex.raw.length, true]);
  await shot(page, 'solid-07-mirrored.png', 'the exported loop and its mirror on the plate', 'body');
  await heavyClick(page, '#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  const undone = await page.evaluate((id) => Array.from(state.models.find((q) => q.id === id).rawTris), ex.id);
  check('one Undo puts the exported solid back bit for bit', undone.length === ex.raw.length && undone.every((v, i) => v === ex.raw[i]), true);

  // A mesh document: Toolpath / Solid are disabled (they are a slice's - the
  // View card's row, docs/GSCOPE.md item 5) and there is no solid export.
  if (await page.evaluate(() => window.NSO_MICROSCOPE.isOpen())) await heavyClick(page, '#ms-close');
  const cubeBytes = Array.from(await readFile(join(ROOT, CUBE)));
  const nb = await page.evaluate(() => state.models.length);
  await page.evaluate((b) => handleFiles([new File([new Uint8Array(b)], 'cube.stl')]), cubeBytes);
  await page.waitForFunction((n) => state.models.length === n + 1, nb, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  await heavyClick(page, '#btn-microscope');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen(), null, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  // A file already under the lens stays there on reopen; Read the plate swaps to the plate.
  await heavyClick(page, '#ms-btn-plate');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: heavy(HEAVY_WAIT_FRAMES) });
  await page.evaluate(() => { const M = window.NSO_MICROSCOPE; M.selectVisible(); });
  check('a mesh document: Toolpath / Solid disabled, no Export as solid (it already is a mesh)',
    [await page.evaluate(() => ['ms-render-toolpath', 'ms-render-solid'].every((id) => document.getElementById(id).disabled)),
      await page.isVisible('#ms-btn-export-solid-plate'), await page.isVisible('#ms-btn-export-plate')],
    [true, false, true]);

  check('no page errors', errors, []);
  await browser.close();
  served.srv.close();
  await rm(TMP, { recursive: true, force: true });
  process.exit(check.report() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
