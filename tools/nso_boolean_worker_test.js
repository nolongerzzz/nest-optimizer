#!/usr/bin/env node
/* The boolean-worker gate (bool:worker): the boolean kernel runs in a worker, and the page stays free.
     node tools/nso_boolean_worker_test.js                 exit 0 = every gate held
     node tools/nso_boolean_worker_test.js --shots dir     screenshots (default tools/boolean-out)
     npm run bool:worker

   Every boolean (Crop's copy, Subtract, Join, Connect, Bridge, the fills) used to run on the thread the page
   is painted by, so a big piece froze the tab for the whole run. nso_csg.js now sends a big one to a worker
   (nso_work.js, channel 'bool') and awaits it; a small one still runs on the page's thread, through the same
   async call. This drives the REAL app on the big-mesh gate's 1,000,000-triangle sphere.

     1. ROUTING AND BYTES. Two boxes (12 triangles each) never reach the worker. Past the threshold the same call
        does, and the answer is the in-thread core's, byte for byte: union, subtract, the plug punch with a real
        plug frame (three.js objects over the boundary as numbers and back), the two fills, and the overlapping-
        shells measure and merge (nso-helpers.js nsoOverlap: work as is).
     2. CROP ON THE SPHERE, through the Crop card: the plan and the copy both run in the worker; the main thread
        has NO stretch of JS over 100 ms through either (the profiler reads the app's own time, as big:mesh does);
        the card shows the bar and "Cropping… N s", no percent; the copy lands, and it is the bytes the main
        thread's own cropCore makes of the same piece and shape.
     3. ESCAPE during a plan, and during the copy, ends the job: the worker is terminated, the plate is as it
        was (same pieces, same undo stack, same geometry), the card still holds its shape, and the next crop runs
        (a fresh worker).
     4. THE WATCHDOG ends a run that outlasts it, in plain words, and the plate is as it was.

   WHAT "JS" MEANS HERE: see tools/nso_big_mesh_lib.js - the page draws with software GL in this browser, which
   costs the main thread ~0.4 s a frame per million triangles whatever the app does, so the gate reads the
   stretches where JS was on the stack, and prints the browser's raw long tasks beside them. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const L = require('./nso_big_mesh_lib');

const argv = process.argv.slice(2);
const SHOTS = path.resolve(argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : path.join(__dirname, 'boolean-out'));
fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && detail !== '' ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-bool-worker-'));
const SPHERE = path.join(TMP, 'sphere_1M.stl');
const TRIS = L.writeSphereSTL(SPHERE, 1000, 501, 40, true);     // outward: a solid the kernel can cut
console.log('piece: ' + TRIS.toLocaleString() + ' triangles');

const fmt = r => `js ${r.jsMs.toFixed(0)} ms, longest run ${r.maxJsMs.toFixed(0)} ms, browser long tasks ${r.longTasks.length} (max ${Math.max(0, ...r.longTasks)} ms)`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- in-page helpers ---------------------------------------------------- */

/* Everything below that runs in the page is a function of its own, so it can be handed to evaluate. */
function pageKit() {
  window.__k = {
    box(lo, hi) {
      const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
                 [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
      const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
      const o = [];
      for (const t of f) for (const i of t) o.push(...v[i]);
      return new Float32Array(o);
    },
    /* Two results are the same when every float of every soup is, and the rest of them serialise alike. */
    sameBytes(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
      return true;
    },
    sameResult(x, y) {
      const soups = ['soup', 'tris'];
      const rest = r => JSON.stringify(r, (k, v) => (ArrayBuffer.isView(v) ? '[' + v.length + ']' : v));
      for (const s of soups) if ((x[s] || y[s]) && !window.__k.sameBytes(x[s], y[s])) return false;
      return rest(x) === rest(y);
    },
    spy() {
      const real = NSO_Work.run;
      window.__k.calls = 0;
      NSO_Work.run = function () { window.__k.calls++; return real.apply(this, arguments); };
      window.__k.unspy = () => { NSO_Work.run = real; };
    }
  };
}

(async () => {
  await withApp(async (page, logs) => {
    const cdp = await L.openProfiler(page);
    await page.evaluate(pageKit);
    await page.evaluate(() => { window.__said = []; const o = window.setStatus; window.setStatus = function (m, b) { window.__said.push(String(m)); return o.apply(this, arguments); }; });

    /* ================================================================ 1 */
    console.log('\n=== 1. small stays on the page; big goes to the worker; the answer is the same bytes ===');
    const small = await page.evaluate(async () => {
      const K = window.__k, a = K.box([0, 0, 0], [10, 10, 10]), b = K.box([5, 5, 5], [15, 15, 15]);
      K.spy();
      const out = {};
      out.union = await NSO_unionSoups(a, b);
      out.subtract = await NSO_subtractSoups(a, b);
      out.fillU = await nsoUnionSoups(a, b);
      out.fillS = await nsoSubtractSoups(a, b);
      out.calls = K.calls;
      out.cfg = { big: NSO_BoolConfig.bigTris, dog: NSO_BoolConfig.watchdogMs };
      out.ok = [out.union, out.subtract, out.fillU, out.fillS].map(r => !!r.ok);
      K.unspy();
      return out;
    });
    check('the threshold is 50,000 triangles and the watchdog 120 s', small.cfg.big === 50000 && small.cfg.dog === 120000, JSON.stringify(small.cfg));
    check('two boxes: union, subtract and both fills answer, and none of them touched a worker', small.ok.every(Boolean) && small.calls === 0, 'ok ' + small.ok + ', worker calls ' + small.calls);

    const routed = await page.evaluate(async () => {
      const K = window.__k, a = K.box([0, 0, 0], [10, 10, 10]), b = K.box([5, 5, 5], [15, 15, 15]);
      NSO_BoolConfig.bigTris = 5;                       // every soup is "big" now: the same call, the other route
      const rows = [];
      const spec = [
        ['union', () => NSO_unionSoups(a, b), () => NSO_BoolCore.union(a, b)],
        ['subtract', () => NSO_subtractSoups(a, b), () => NSO_BoolCore.subtract(a, b)],
        ['fill union', () => nsoUnionSoups(a, b), () => NSO_BoolCore.fillUnion(a, b)],
        ['fill subtract', () => nsoSubtractSoups(a, b), () => NSO_BoolCore.fillSubtract(a, b)]
      ];
      try {
        for (const [name, viaDoor, inThread] of spec) {
          K.spy();
          const w = await viaDoor();
          const calls = K.calls; K.unspy();
          const m = await inThread();
          rows.push({ name, calls, ok: !!w.ok, same: K.sameResult(w, m), tris: (w.soup || []).length / 9 });
        }
      } finally { NSO_BoolConfig.bigTris = 50000; }
      return { rows, active: NSO_boolActive.length, busy: NSO_BoolBusy.active() };
    });
    routed.rows.forEach(r => check(r.name + ': past the threshold it goes to the worker, and is the in-thread core\'s answer byte for byte (' + r.tris + ' triangles)',
      r.calls === 1 && r.ok && r.same, 'worker calls ' + r.calls + ', ok ' + r.ok + ', same ' + r.same));
    check('nothing is left running or showing', routed.active === 0 && routed.busy === 0, 'jobs ' + routed.active + ', bars ' + routed.busy);

    // the plug punch (Subtract B from A), with a real plug frame
    const HULL = path.join(ROOT, 'fixtures', 'box_open.stl'), BIT = path.join(ROOT, 'library', 'box_bit_12x8x8.stl');
    const hid = await loadSTL(page, HULL), bid = await loadSTL(page, BIT);
    const punch = await page.evaluate(async ([hid, bid]) => {
      const K = window.__k;
      const pa = state.placed.find(p => p && p.sourceId === hid && p.mesh), pb = state.placed.find(p => p && p.sourceId === bid && p.mesh);
      pa.mesh.updateMatrixWorld(true);
      const hb = new THREE.Box3().setFromObject(pa.mesh);
      // park the bit on the hull's top +X/+Z corner, as wall:cut does
      pb.liftY = 0; applyMeshRotation(pb); pb.mesh.updateMatrixWorld(true);
      let bb = new THREE.Box3().setFromObject(pb.mesh);
      const c = bb.getCenter(new THREE.Vector3());
      pb.x += hb.max.x - c.x; pb.z += hb.max.z - c.z; pb.liftY = (hb.max.y - 3) - 0.2;
      applyMeshRotation(pb); pb.mesh.updateMatrixWorld(true);
      const aWorld = meshToWorldSoup(pa.mesh), bWorld = meshToWorldSoup(pb.mesh);
      pa.mesh.geometry.computeBoundingBox();
      const hc = pa.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(pa.mesh.matrixWorld);
      const frame = NSO_plugFrame(pb.mesh, hc, aWorld);
      const opts = { plugFrame: frame, minWall: 1.0 };
      const mine = await NSO_punchCore(aWorld, bWorld, opts);        // the core, here, with the frame as it is
      NSO_BoolConfig.bigTris = 5;
      K.spy();
      let theirs;
      try { theirs = await subtractSoupBFromA(aWorld, bWorld, opts); } finally { NSO_BoolConfig.bigTris = 50000; }
      const calls = K.calls; K.unspy();
      return { calls, ok: !!theirs.ok, mineOk: !!mine.ok, same: K.sameResult(theirs, mine), tris: (theirs.soup || []).length / 9,
               warned: !!(theirs.clearance && theirs.clearance.cut_lo), reason: theirs.reason || '' };
    }, [hid, bid]);
    check('Subtract (the plug punch, a real plug frame): in the worker, and the in-thread core\'s answer byte for byte (' + punch.tris + ' triangles)',
      punch.calls === 1 && punch.mineOk && punch.ok && punch.same, 'worker calls ' + punch.calls + ', ok ' + punch.ok + ', same ' + punch.same + ' ' + punch.reason);
    check('...with its nozzle-safety readout (the clearance probe ran in the worker too)', punch.warned);

    // overlapping shells (work as is): the measure and the merge of library/box_closed.stl, past the threshold
    // the soup handed in, not loaded: the plate stays as section 2 expects it
    const closedSoup = Array.from(require('./nso_stl_io.js').readSTL(path.join(ROOT, 'library', 'box_closed.stl')));
    const shells = await page.evaluate(async arr => {
      const K = window.__k, raw = new Float32Array(arr);
      const mineM = NSO_overlapMeasure(raw.slice()), mineS = await NSO_shellMergeCore(raw.slice());
      NSO_BoolConfig.bigTris = 5;
      K.spy();
      let m, s;
      try { m = await nsoOverlap.measureAsync(raw.slice()); s = await nsoOverlap.merge(raw.slice()); } finally { NSO_BoolConfig.bigTris = 50000; }
      const calls = K.calls; K.unspy();
      return { calls, measure: JSON.stringify(m) === JSON.stringify(mineM), m, ok: !!s.ok, same: K.sameResult(s, mineS), tris: (s.soup || []).length / 9 };
    }, closedSoup);
    check('overlapping shells: the measure and the merge go to the worker, and are the in-thread answers byte for byte (' + shells.tris + ' triangles)',
      shells.calls === 2 && shells.measure && shells.ok && shells.same, 'worker calls ' + shells.calls + ', ' + JSON.stringify(shells.m) + ', same ' + shells.same);

    /* ================================================================ 2 */
    console.log('\n=== 2. Crop on the 1,000,000-triangle sphere, through the card ===');
    const before = await page.evaluate(() => state.models.length);
    await page.setInputFiles('#file-input', SPHERE);
    await page.waitForFunction(n => state.models.length > n, before, { timeout: 120000, polling: 50 });
    // a big piece is registered, indexed and only then put on the plate (~5 s here): wait for the sphere's own mesh,
    // not for any piece's - section 1 left two small ones on the plate
    await page.waitForFunction(() => { const id = state.models[state.models.length - 1].id; return state.placed.some(p => p && p.sourceId === id && p.mesh); },
      null, { timeout: 120000, polling: 50 });
    await page.waitForTimeout(2500);
    const sid = await page.evaluate(() => state.models[state.models.length - 1].id);
    check('the piece is on the plate with all of its triangles', (await page.evaluate(i => state.models.find(m => m.id === i).rawTris.length / 9, sid)) === TRIS);
    await page.evaluate(i => { selectPlaced(state.placed.findIndex(q => q.sourceId === i)); }, sid);
    await page.click('#menu-crop > summary');
    await page.waitForTimeout(300);

    const settled = ms => page.waitForFunction(() => {
      const S = NSO_CropCard.state();
      return !!S.shape && !S.timer && !!S.plan && NSO_BoolBusy.active() === 0;
    }, null, { timeout: ms || 240000, polling: 100 });
    /* Watch the card while a job runs: what it says and shows, once every half second. */
    const watch = async (isDone, onSample) => {
      const seen = [], t0 = Date.now();
      for (let i = 0; i < 4000; i++) {
        if (Date.now() - t0 > 600000) { check('the job ended within ten minutes', false); break; }
        if (await page.evaluate(isDone)) break;
        const s = await page.evaluate(() => {
          const b = NSO_BoolBusy.state();
          return b && { label: b.label, line: b.line, seconds: b.seconds, bar: b.bar, ro: document.getElementById('crop-readout').textContent,
                        status: document.getElementById('status').textContent,
                        barBelowReadout: !!(document.getElementById('bool-progress') && document.getElementById('bool-progress').previousElementSibling === document.getElementById('crop-readout')),
                        pct: !!(document.getElementById('bool-progress') && document.getElementById('bool-progress').hasAttribute('aria-valuenow')) };
        });
        if (s) { seen.push(s); if (onSample) await onSample(s); }
        await sleep(400);
      }
      return seen;
    };

    // ---- the plan, on pick
    await page.evaluate(() => window.__planDone = false);
    const planRun = await L.measure(page, cdp, 'pick + plan', async () => {
      await page.evaluate(() => NSO_CropCard.pick('box'));
      const seen = await watch(() => { const S = NSO_CropCard.state(); return !!S.plan && !S.timer && NSO_BoolBusy.active() === 0; });
      return seen;
    });
    const planSeen = planRun.value || [];
    console.log('  (pick + plan: ' + fmt(planRun) + ', wall ' + (planRun.wallMs / 1000).toFixed(1) + ' s)');
    check('the plan ran in the worker and came back: "Box ... holds N faces"', /holds \d+ faces/.test(await page.evaluate(() => document.getElementById('crop-readout').textContent)),
      await page.evaluate(() => document.getElementById('crop-readout').textContent));
    check('while it ran the card said "Measuring…" with the bar under its readout', planSeen.some(s => s.label === 'Measuring' && s.bar && s.barBelowReadout && /^Measuring…/.test(s.ro)),
      planSeen.length + ' samples');
    check('NO main-thread JS stretch over 100 ms through the pick and the plan', planRun.maxJsMs < 100, 'longest ' + planRun.maxJsMs.toFixed(0) + ' ms' +
      (planRun.jsRuns.length ? ' | ' + planRun.jsRuns.map(r => r.ms.toFixed(0) + ' ms in ' + (r.incl[0] || ['?'])[0] + ' (self: ' + r.self.slice(0, 3).map(x => x[0].split(' @ ')[0] + ' ' + x[1].toFixed(0)).join(', ') + ')').join('; ') : ''));

    // ---- the copy
    const n0 = await page.evaluate(() => state.models.length);
    const t0 = Date.now();
    const cropRun = await L.measure(page, cdp, 'CROP', async () => {
      await page.evaluate(() => { window.__done = false; window.__res = null; NSO_CropCard.crop().then(r => { window.__res = r; window.__done = true; }); });
      return watch(() => window.__done);
    });
    const seen = cropRun.value || [], secs = ((Date.now() - t0) / 1000).toFixed(1);
    const res = await page.evaluate(() => window.__res);
    console.log('  (CROP: ' + fmt(cropRun) + ', wall ' + secs + ' s)');
    await page.screenshot({ path: path.join(SHOTS, 'gate-crop-landed.png') });
    check('CROP finished: a copy "... crop 1" is on the plate', res && res.ok && /crop 1$/.test(res.name || '') && (await page.evaluate(() => state.models.length)) === n0 + 1, JSON.stringify(res && { ok: res.ok, name: res.name, faces: res.faces }));
    check('NO main-thread JS stretch over 100 ms through the whole copy, click to landed', cropRun.maxJsMs < 100, 'longest ' + cropRun.maxJsMs.toFixed(0) + ' ms' +
      (cropRun.jsRuns.length ? ' | ' + cropRun.jsRuns.map(r => r.ms.toFixed(0) + ' ms in ' + (r.incl[0] || ['?'])[0] + ' (self: ' + r.self.slice(0, 3).map(x => x[0].split(' @ ')[0] + ' ' + x[1].toFixed(0)).join(', ') + ')').join('; ') : ''));
    check('while it ran the card said "Cropping…" and, past a second, "Cropping… N s"', seen.some(s => s.label === 'Cropping' && s.bar && s.barBelowReadout && s.ro === s.line) &&
      seen.some(s => /^Cropping… \d+ s$/.test(s.ro) && s.status === s.ro), seen.length + ' samples, last "' + (seen.length ? seen[seen.length - 1].line : '') + '"');
    check('...a sweeping bar and no invented percent: no aria-valuenow, no "%" in any line', seen.length > 0 && seen.every(s => !s.pct && !/%/.test(s.line)));
    await settled();       // the card plans again after every copy; when that is done the bar must be gone
    check('...and once it landed and the card is quiet: the bar is gone and the status line no longer counts seconds',
      await page.evaluate(() => !document.getElementById('bool-progress') && NSO_BoolBusy.active() === 0 && NSO_boolActive.length === 0 &&
        !/^(Cropping|Measuring|Checking)\u2026/.test(document.getElementById('status').textContent)),
      await page.evaluate(() => document.getElementById('status').textContent.slice(0, 80)));

    // the worker's copy is the bytes the main thread makes of the same piece and shape
    console.log('  ... the main thread makes the same copy, for the bytes (this one holds the page; it is the point)');
    const same = await page.evaluate(async ([sid, id]) => {
      const m = state.models.find(q => q.id === sid), mine = state.models.find(q => q.id === id);
      const rs = NSO_Crop.resolve(m, NSO_CropCard.shape());
      const t = performance.now();
      const r = await NSO_Crop.cropCore(rs.piece, rs.shape, true);
      return { ok: r.ok, ms: performance.now() - t, tris: r.ok ? r.tris.length / 9 : 0, same: r.ok && window.__k.sameBytes(r.tris, mine.rawTris), faces: mine.rawTris.length / 9 };
    }, [sid, res && res.id]);
    check('the copy is byte-identical to the one the main thread makes (' + same.faces + ' faces; on the page\'s thread it takes ' + (same.ms / 1000).toFixed(1) + ' s)', same.ok && same.same,
      'main ' + same.tris + ' triangles');

    // ---- a copy that lands more than a box: a cap of the sphere, so there is surface in the result
    const cap = await page.evaluate(async sid => {
      const m = state.models.find(q => q.id === sid);
      const rb = NSO_Crop.bounds(m.rawTris);
      const hi = rb.hi[2];
      const rs = NSO_Crop.resolve(m, { kind: 'box', c: [0, 0, 0], h: [1, 1, 1], yaw: 0 });
      const P = NSO_Crop.extentInP(m.rawTris, rs.piece.toRaw ? NSO_Crop.matInvert(Array.from(rs.piece.toRaw)) : null);
      const shape = { kind: 'box', c: [(P.lo[0] + P.hi[0]) / 2, (P.lo[1] + P.hi[1]) / 2, P.hi[2] - 1], h: [10, 10, 5], yaw: 0 };
      const t = performance.now();
      const viaDoor = await NSO_Crop.run(rs.piece, shape);
      const ms = performance.now() - t;
      const core = await NSO_Crop.cropCore(rs.piece, shape, true);
      return { ok: viaDoor.ok, faces: viaDoor.faces, same: viaDoor.ok && core.ok && window.__k.sameBytes(viaDoor.tris, core.tris), ms, hi };
    }, sid);
    check('a cap cut off the sphere\'s top (' + cap.faces + ' faces of its surface): the worker\'s copy is the main thread\'s bytes', cap.ok && cap.same, 'door took ' + (cap.ms / 1000).toFixed(1) + ' s');

    /* ================================================================ 3 */
    console.log('\n=== 3. Escape ends the job; the plate is as it was ===');
    /* The card follows the selection: after a crop the copy is selected, and a pick then would put the shape on the copy.
       A user clicks the piece they are cropping; so does this. */
    const pickOnOriginal = async () => {
      await page.evaluate(i => { selectPlaced(state.placed.findIndex(q => q.sourceId === i)); }, sid);
      await page.evaluate(() => NSO_CropCard.pick('box'));
    };
    const snapshot = () => page.evaluate(sid => {
      const S = NSO_CropCard.state();
      const m = state.models.find(q => q.id === sid);
      return { models: state.models.length, placed: state.placed.length, undo: state.undoStack.length, names: state.models.map(q => q.name).join('|'),
               tris: m.rawTris.length, geo: m.geometry.uuid, first: Array.from(m.rawTris.slice(0, 30)).join(','), last: Array.from(m.rawTris.slice(-30)).join(','),
               shape: S.shape };
    }, sid);
    const sameSnap = (a, b) => Object.keys(a).every(k => a[k] === b[k]);

    await settled();
    // ---- during a plan
    const snapA = await snapshot();
    await pickOnOriginal();                                       // a fresh plan after the 400 ms settle
    let planSec = null;
    for (let i = 0; i < 200 && planSec == null; i++) {
      await sleep(250);
      planSec = await page.evaluate(() => { const b = NSO_BoolBusy.state(); return b && b.label === 'Measuring' && b.seconds >= 1 ? b.seconds : null; });
    }
    check('a plan is running in the worker (the card says "Measuring… N s")', planSec != null, String(planSec));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => NSO_BoolBusy.active() === 0, null, { timeout: 15000 });
    await sleep(600);
    const afterPlan = await page.evaluate(() => ({ shape: NSO_CropCard.state().shape, plan: NSO_CropCard.state().plan && { ok: NSO_CropCard.state().plan.ok, reason: NSO_CropCard.state().plan.reason, cancelled: NSO_CropCard.state().plan.cancelled },
      ro: document.getElementById('crop-readout').textContent, jobs: NSO_boolActive.length, bar: !!document.getElementById('bool-progress') }));
    check('Escape during the plan ended it: no job, no bar, the readout says it was stopped', afterPlan.jobs === 0 && !afterPlan.bar && afterPlan.plan && !afterPlan.plan.ok && afterPlan.plan.cancelled, JSON.stringify(afterPlan));
    check('...and the card still holds its shape (Escape was the job\'s, not the card\'s)', afterPlan.shape === 'box');
    check('...the plate is as it was', sameSnap(snapA, await snapshot()));

    // ---- during the copy
    await pickOnOriginal();
    await settled();
    const snapB = await snapshot();
    await page.evaluate(() => { window.__done = false; window.__res = null; NSO_CropCard.crop().then(r => { window.__res = r; window.__done = true; }); });
    const pressed = { done: false };
    await watch(() => window.__done, async s => {
      if (s.label === 'Cropping' && s.seconds >= 2 && !pressed.done) { pressed.done = true; await page.keyboard.press('Escape'); }
    });
    await page.waitForFunction(() => window.__done, null, { timeout: 30000 });
    const esc = await page.evaluate(() => ({ res: window.__res, shape: NSO_CropCard.state().shape }));
    check('Escape pressed two seconds into the copy', pressed.done === true);
    check('the copy came back stopped, not failed: cancelled, in words, nothing made', esc.res && esc.res.ok === false && esc.res.cancelled === true && /stopped/.test(esc.res.reason || ''), JSON.stringify(esc.res));
    const said = await page.evaluate(() => window.__said.filter(m => /^Crop (stopped|refused)/.test(m)));
    check('...the status line said so: "Crop stopped - nothing changed"', said.length > 0 && said[said.length - 1] === 'Crop stopped - nothing changed', said.join(' | '));
    // the card plans again after every copy, stopped or not, so wait that out before asking what is left
    await settled();
    const quiet = await page.evaluate(() => ({ jobs: NSO_boolActive.length, bar: !!document.getElementById('bool-progress'), busy: NSO_BoolBusy.active() }));
    check('...and once it is quiet: no job, no bar, no card busy', quiet.jobs === 0 && !quiet.bar && quiet.busy === 0, JSON.stringify(quiet));
    check('...the card still holds its shape', esc.shape === 'box');
    check('...the plate is as it was: same pieces, same undo stack, same geometry', sameSnap(snapB, await snapshot()));
    await page.screenshot({ path: path.join(SHOTS, 'gate-escape.png') });

    // ---- and the next one runs: the worker was ended and a fresh one starts
    await pickOnOriginal();
    await settled();
    const again = await page.evaluate(async () => { const r = await NSO_CropCard.crop(); return { ok: r.ok, name: r.name }; });
    check('the next crop runs on a fresh worker and lands', again.ok && /crop 2$/.test(again.name || ''), JSON.stringify(again));

    /* ================================================================ 4 */
    console.log('\n=== 4. the watchdog ===');
    await pickOnOriginal();
    await settled();
    const snapC = await snapshot();
    const dog = await page.evaluate(async () => {
      NSO_BoolConfig.watchdogMs = 400;
      try {
        const t = performance.now();
        const r = await NSO_CropCard.crop();
        return { r, ms: performance.now() - t, status: document.getElementById('status').textContent, jobs: NSO_boolActive.length, bar: !!document.getElementById('bool-progress') };
      } finally { NSO_BoolConfig.watchdogMs = 120000; }
    });
    check('a run that outlasts the watchdog ends with timedOut, in plain words', dog.r && dog.r.ok === false && dog.r.timedOut === true &&
      /ran longer than [\d.]+ seconds and was stopped - nothing was changed/.test(dog.r.reason || ''), JSON.stringify(dog.r));
    check('...at the watchdog, not after the kernel (' + (dog.ms / 1000).toFixed(1) + ' s)', dog.ms < 20000);
    check('...no job, no bar; the plate is as it was', dog.jobs === 0 && !dog.bar && sameSnap(snapC, await snapshot()));
    check('the default watchdog is 120 s again, and says "2 minutes"', await page.evaluate(() => NSO_BoolConfig.watchdogMs === 120000 && /2 minutes/.test((() => { NSO_BoolConfig.watchdogMs = 120000; return NSO_boolTimedOut(); })())));

    await pickOnOriginal();
    await settled();
    const last = await page.evaluate(async () => { const r = await NSO_CropCard.crop(); return { ok: r.ok, name: r.name }; });
    check('and the crop after a timeout runs and lands', last.ok && /crop 3$/.test(last.name || ''), JSON.stringify(last));

    const errs = logs.filter(l => /^\[pageerror\]/.test(l));
    check('no page error through the run', errs.length === 0, errs.slice(0, 3).join(' | '));
  });

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
