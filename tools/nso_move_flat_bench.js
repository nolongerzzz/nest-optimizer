#!/usr/bin/env node
/* Move's plate drag, timed: ms per pointer move while a piece is carried across the plate, and ms from
   pointerup to the piece at rest. Driven in the real page with real mouse events.

     node tools/nso_move_flat_bench.js            prints the two tables
     node tools/nso_move_flat_bench.js --json f   ...and writes the numbers to f

   NOT a gate (no pass/fail, not in the test chain): a measurement, run before and after a change to the
   drag, on the same box.

   WHAT IS TIMED. Two listeners on window bracket the app's own: a capture listener stamps the clock when an event
   starts, a bubble listener added after the app's stamps it when the app's handlers have returned. The difference is
   the app's JS for that event - the page's frame (software GL here, ~0.4 s per million triangles) is not in it, and
   is printed apart as "to next frame".

   THE PIECES. library/box_closed.stl; and the vase - tools/fixtures-local/boolean-vase.3mf (git-ignored, 24 MB) when it
   is there, else a 1,000,000-triangle UV sphere standing in for it (marked "stand-in" in the table).

   THE DRAG. A real press on the piece, 40 real moves of the pointer across bare plate (a plate-plane run of 40 mm
   toward the front, clear of the other piece), a real release. Each scene is dragged REPS times; the tables give the
   median and mean of the moves over all runs, the 95th percentile, the worst, and the median release. The page's clock
   is coarsened to 0.1 ms, so a median of 0.200 means 'about 0.2'; the mean is the fine figure.            */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const BM = require('./nso_big_mesh_lib.js');

const MOVES = 40, REPS = 3, RUN_MM = 40;
const jsonAt = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-move-flat-bench-'));
const BOX = path.join(ROOT, 'library', 'box_closed.stl');
const VASE3MF = path.join(__dirname, 'fixtures-local', 'boolean-vase.3mf');
const haveVase = fs.existsSync(VASE3MF);
const VASE_LABEL = haveVase ? 'vase' : 'vase (stand-in: 1,000,000-triangle sphere)';
let VASE = VASE3MF;
if (!haveVase) { VASE = path.join(TMP, 'vase-standin.stl'); BM.writeSphereSTL(VASE, 1000, 501, 30, true); }

const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const p95 = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : NaN; };
const f = (x, d) => (+x).toFixed(d == null ? 3 : d);

async function install(page) {
  await page.evaluate(() => {
    window.__t = { move: [], up: [], upFrame: [], cur: null };
    const stamp = {};
    ['pointermove', 'pointerup'].forEach(ty => {
      window.addEventListener(ty, () => { stamp[ty] = performance.now(); }, true);
      window.addEventListener(ty, () => {
        const dt = performance.now() - stamp[ty];
        if (!window.__t.cur) return;
        if (ty === 'pointermove') window.__t.cur.move.push(dt);
        else {
          window.__t.cur.up = dt;
          const t0 = stamp[ty];
          requestAnimationFrame(() => requestAnimationFrame(() => { window.__t.cur.upFrame = performance.now() - t0; }));
        }
      }, false);
    });
  });
}

async function loadBig(page, file) {
  const before = await page.evaluate(() => state.models.length);
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(n => state.models.length > n && state.placed.some(p => p && p.mesh && p.sourceId === state.models[state.models.length - 1].id),
    before, { timeout: 600000, polling: 200 });
  await page.waitForTimeout(2500);
  // the vase 3MF carries two objects: the big one is the vase
  return page.evaluate(n => state.models.slice(n).sort((a, b) =>
    (b.rawTris ? b.rawTris.length : 0) - (a.rawTris ? a.rawTris.length : 0))[0].id, before);
}

async function setUp(page, id, x, z) {
  await page.evaluate(([id, x, z]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    applyPlacedXZ(p, x, z);
    p.mesh.updateMatrixWorld(true);
  }, [id, x, z]);
}

async function view(page) {
  await page.evaluate(() => {
    state.controls.target.set(0, 0, 0);
    state.camera.position.set(0, 190, 150);
    state.camera.lookAt(0, 0, 0);
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  });
}

/* One drag of piece `id`: press on it, MOVES real moves, release. */
async function drag(page, id) {
  const route = await page.evaluate(([id, mm]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    const proj = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    };
    // press where the piece's top is; the plate-plane run is the same point carried `mm` toward the front
    const a = proj(c.x, b.max.y, c.z), e = proj(c.x, b.max.y, c.z + mm);
    return { a, e, x0: p.x, z0: p.z, liftY: p.liftY || 0, undo: state.undoStack.length };
  }, [id, RUN_MM]);
  await page.evaluate(() => { window.__t.cur = { move: [], up: NaN, upFrame: NaN }; });
  await page.mouse.move(route.a.x, route.a.y);
  await page.mouse.down();
  await page.mouse.move(route.a.x + 1, route.a.y + 1);      // inside the slop: nothing yet
  for (let k = 1; k <= MOVES; k++) {
    await page.mouse.move(route.a.x + (route.e.x - route.a.x) * k / MOVES, route.a.y + (route.e.y - route.a.y) * k / MOVES);
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForFunction(() => Number.isFinite(window.__t.cur.upFrame), null, { timeout: 120000, polling: 100 });
  const t = await page.evaluate(() => window.__t.cur);
  const end = await page.evaluate(([id, route]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    p.mesh.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(p.mesh);
    return { dz: p.z - route.z0, dx: p.x - route.x0, bottom: b.min.y, liftY: p.liftY || 0, undo: state.undoStack.length - route.undo };
  }, [id, route]);
  return { moves: t.move, up: t.up, upFrame: t.upFrame, end };
}

async function scene(page, label, id, reps) {
  const runs = [];
  for (let r = 0; r < reps; r++) {
    // back to the start so every run is the same run
    const home = await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); return p.__home || (p.__home = { x: p.x, z: p.z }); }, id);
    await setUp(page, id, home.x, home.z);
    await page.waitForTimeout(300);
    runs.push(await drag(page, id));
  }
  const moves = [].concat(...runs.map(r => r.moves)), ups = runs.map(r => r.up), frames = runs.map(r => r.upFrame);
  const row = { scene: label, moves: moves.length, moveMed: med(moves), moveMean: mean(moves), moveP95: p95(moves), moveMax: Math.max.apply(null, moves),
                moveFirst: med(runs.map(r => r.moves[0])), upMed: med(ups), upMax: Math.max.apply(null, ups), frameMed: med(frames),
                end: runs[runs.length - 1].end };
  console.log('  ' + label.padEnd(52) + 'move ' + f(row.moveMed) + ' ms (mean ' + f(row.moveMean) + ', p95 ' + f(row.moveP95) + ', first ' + f(row.moveFirst) + ')   release ' + f(row.upMed) +
    ' ms   next frame ' + f(row.frameMed, 0) + ' ms   ended dz ' + f(row.end.dz, 1) + ' liftY ' + f(row.end.liftY, 3) + ' bottom ' + f(row.end.bottom, 3) + ' undo +' + row.end.undo);
  return row;
}

(async () => {
  const rows = [];
  console.log('Move plate drag - ' + MOVES + ' moves x ' + REPS + ' runs; vase is ' + VASE_LABEL);
  await withApp(async page => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await install(page);
    const box = await loadSTL(page, BOX);
    await setUp(page, box, 40, -20); await view(page); await page.waitForTimeout(500);
    rows.push(await scene(page, 'box_closed, alone', box, REPS));
    const vase = await loadBig(page, VASE);
    await setUp(page, vase, -50, -20); await setUp(page, box, 50, -20); await view(page); await page.waitForTimeout(800);
    await page.evaluate(([a, b]) => { [a, b].forEach(id => { const p = state.placed.find(q => q && q.sourceId === id); p.__home = { x: p.x, z: p.z }; }); }, [box, vase]);
    rows.push(await scene(page, 'box_closed, ' + VASE_LABEL + ' on the plate', box, REPS));
    rows.push(await scene(page, VASE_LABEL + ', box_closed on the plate', vase, REPS));
  });
  await withApp(async page => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await install(page);
    const vase = await loadBig(page, VASE);
    await setUp(page, vase, 0, -20); await view(page); await page.waitForTimeout(800);
    rows.push(await scene(page, VASE_LABEL + ', alone', vase, REPS));
  });
  console.log('\n| scene | ms / pointer move (median) | mean | p95 | worst | first move | ms pointerup -> at rest | to next frame |');
  console.log('|---|---|---|---|---|---|---|---|');
  rows.forEach(r => console.log('| ' + r.scene + ' | ' + f(r.moveMed) + ' | ' + f(r.moveMean) + ' | ' + f(r.moveP95) + ' | ' + f(r.moveMax) + ' | ' + f(r.moveFirst) + ' | ' + f(r.upMed) + ' | ' + f(r.frameMed, 0) + ' |'));
  if (jsonAt) fs.writeFileSync(jsonAt, JSON.stringify(rows, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
