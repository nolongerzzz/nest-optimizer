#!/usr/bin/env node
/* Crop a box out of a real big 3MF, timed, with the page watched while the worker has it.
     node tools/nso_boolean_3mf_drive.js [file.3mf] [--shots dir] [--main]
     npm run bool:3mf

   The file is the butterfly vase from the boolean-worker ticket: two objects, 1,460,928 + 1,440 triangles. It is not
   in the repo (24 MB); the default path is tools/fixtures-local/boolean-vase.3mf (git-ignored), or NSO_BOOLEAN_3MF, or
   the first argument. Without it this prints a notice and exits 0, as lift:curved-surface-drive does.

   It imports the file through the app's own Import, picks the Crop card's Box, puts it across the vase's wall (a box
   in the middle of a vase holds air), lets the plan run, presses CROP, and writes to tools/boolean-out/ (git-ignored).
   THE VASE FAILS THE OVERLAP GUARD: its shells cross at 4 places (the unmodified app says "has overlapping shells (4
   piercing pairs)" after a 36 s freeze), so the first CROP is refused, now behind a "Checking\u2026" bar with the page
   alive. The drive records that, then overrides the guard (the drive's doing, nothing in the app) so the boolean itself
   is timed:
     3mf-1-before.png    the vase on the plate, nothing cut
     3mf-2-during.png    the card three seconds into the copy: "Cropping… 3 s", the bar under it, the page alive
     3mf-3-after.png     the copy landed, selected, where it was cut from
     3mf-4-bit-only.png  the original hidden, so the copy shows alone
     3mf-summary.json    the numbers: import, plan and copy wall time, the longest stretch of JS on the page's thread
   --main also makes the same copy on the page's thread (cropCore), for the freeze the worker takes away: the page
   does not respond for that long, and the bytes are compared. */

const fs = require('fs');
const path = require('path');
const { withApp, ROOT } = require('./nso_app_harness');
const L = require('./nso_big_mesh_lib');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const SHOTS = path.resolve(flag('--shots') ? argv[argv.indexOf('--shots') + 1] : path.join(__dirname, 'boolean-out'));
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--shots');
const FILE = path.resolve(positional[0] || process.env.NSO_BOOLEAN_3MF || path.join(__dirname, 'fixtures-local', 'boolean-vase.3mf'));
if (!fs.existsSync(FILE)) {
  console.log('SKIPPED: no 3MF at ' + FILE + ' (give a path, or set NSO_BOOLEAN_3MF, or put the vase at tools/fixtures-local/boolean-vase.3mf)');
  process.exit(0);
}
fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const secs = ms => (ms / 1000).toFixed(1) + ' s';

(async () => {
  const summary = { file: path.basename(FILE), bytes: fs.statSync(FILE).size };
  await withApp(async (page, logs) => {
    const cdp = await L.openProfiler(page);

    /* ---- import ---------------------------------------------------- */
    console.log('\n=== import ' + path.basename(FILE) + ' (' + (summary.bytes / 1e6).toFixed(1) + ' MB) ===');
    const t0 = Date.now();
    await page.setInputFiles('#file-input', FILE);
    // a big piece is registered, indexed and only then put on the plate: wait for a drawn piece, then for the count to hold still
    await page.waitForFunction(() => state.models.length > 0 && state.placed.some(p => p && p.mesh), null, { timeout: 600000, polling: 200 });
    let last = -1, steady = 0;
    for (let i = 0; i < 120 && steady < 6; i++) {
      await sleep(500);
      const n = await page.evaluate(() => state.models.length * 1000 + state.placed.filter(p => p && p.mesh).length);
      if (n === last) steady++; else steady = 0;
      last = n;
    }
    summary.importMs = Date.now() - t0 - 3000;
    const pieces = await page.evaluate(() => state.models.map(m => ({ id: m.id, name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : (m.geometry.attributes.position.count / 3) | 0, raw: !!m.rawTris, axis: m.rawAxis })));
    summary.pieces = pieces;
    console.log('  imported in about ' + secs(summary.importMs) + ': ' + pieces.map(p => p.name + ' (' + p.tris.toLocaleString() + ' triangles)').join('; '));
    check('the file came in as pieces on the plate', pieces.length >= 1 && (await page.evaluate(() => state.placed.length)) >= 1, pieces.length + ' piece(s)');
    const big = pieces.slice().sort((a, b) => b.tris - a.tris)[0];
    check('the big one is the vase: over a million triangles', big.tris > 1000000, big.tris.toLocaleString());
    check('...and it is a raw z-up piece the Crop card can take', big.raw && big.axis === 'zup', big.axis);

    // the camera on the vase, from a little above and to the side
    const frame = () => page.evaluate(id => {
      const p = state.placed.find(q => q.sourceId === id && q.mesh);
      const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3()), d = b.getSize(new THREE.Vector3()).length();
      state.camera.position.set(c.x + d * 0.9, c.y + d * 0.55, c.z + d * 1.15);
      state.controls.target.copy(c); state.camera.lookAt(c); state.controls.update(); state.renderer.render(state.scene, state.camera);
    }, big.id);
    await page.evaluate(i => { selectPlaced(state.placed.findIndex(q => q.sourceId === i)); }, big.id);
    await frame();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, '3mf-1-before.png') });

    /* ---- the card, the box across the wall, the plan ---------------- */
    console.log('\n=== Crop: Box across the vase\'s wall ===');
    await page.click('#menu-crop > summary');
    await page.waitForTimeout(300);
    await page.evaluate(() => NSO_CropCard.pick('box'));
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return !!S.plan && !S.timer && NSO_BoolBusy.active() === 0; }, null, { timeout: 600000, polling: 200 });
    // a box over the +X wall, a quarter of the vase tall: centred on the wall's outside face
    const box = await page.evaluate(id => {
      const p = state.placed.find(q => q.sourceId === id && q.mesh);
      const b = new THREE.Box3().setFromObject(p.mesh);
      const lo = [b.min.x, -b.max.z, b.min.y], hi = [b.max.x, -b.min.z, b.max.y];
      const h = [Math.max(6, (hi[0] - lo[0]) / 10), Math.max(6, (hi[1] - lo[1]) / 8), Math.max(6, (hi[2] - lo[2]) / 8)];
      const c = [hi[0] - h[0] * 0.6, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      NSO_CropCard.setBox(c, h);
      return { c, h, lo, hi };
    }, big.id);
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return !!S.plan && !S.timer && NSO_BoolBusy.active() === 0; }, null, { timeout: 600000, polling: 200 });
    // setBox schedules a plan; the check above can race the timer, so wait for a plan that is for this box
    await page.waitForTimeout(800);
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return !!S.plan && !S.timer && NSO_BoolBusy.active() === 0; }, null, { timeout: 600000, polling: 200 });
    const planned = await page.evaluate(() => ({ ro: document.getElementById('crop-readout').textContent, ok: NSO_CropCard.state().plan.ok }));
    console.log('  ' + planned.ro);
    check('the plan holds part of the vase', planned.ok, planned.ro);
    await frame();

    /* ---- CROP, timed, with the page watched ------------------------- */
    /* One press of CROP, watched: what the card said and showed each half second, how long, and the longest stretch of JS
       on the page's thread. */
    const press = async (label, shotName) => {
      const run = await L.measure(page, cdp, label, async () => {
        const tc = Date.now();
        await page.evaluate(() => { window.__done = false; window.__res = null; NSO_CropCard.crop().then(r => { window.__res = r; window.__done = true; }); });
        const seen = [];
        let shot = false;
        while (!(await page.evaluate(() => window.__done))) {
          const s = await page.evaluate(() => {
            const b = NSO_BoolBusy.state();
            return b && { label: b.label, line: b.line, seconds: b.seconds, bar: b.bar, ro: document.getElementById('crop-readout').textContent };
          });
          if (s) {
            seen.push(s);
            if (!shot && s.seconds >= 3 && shotName) { shot = true; await page.screenshot({ path: path.join(SHOTS, shotName) }); }
          }
          await sleep(500);
        }
        return { ms: Date.now() - tc, seen };
      });
      const res = await page.evaluate(() => window.__res);
      return { run, res, seen: run.value.seen };
    };
    const jsLine = r => 'the page\'s thread: js ' + r.jsMs.toFixed(0) + ' ms in all, longest stretch ' + r.maxJsMs.toFixed(0) + ' ms; browser long tasks ' + r.longTasks.length +
      ' (max ' + Math.max(0, ...r.longTasks) + ' ms) - software GL draws a frame in ~0.4 s per million triangles whatever the app does';

    // 1. as the app stands: the overlap guard looks at the vase first
    console.log('\n=== CROP, as the app stands: the overlap guard checks the vase first ===');
    const n0 = await page.evaluate(() => state.models.length);
    const first = await press('CROP (guard on)', '3mf-2a-checking.png');
    summary.guard = { wallMs: first.run.value.ms, ok: !!(first.res && first.res.ok), reason: first.res && first.res.reason, longestJsMs: first.run.maxJsMs, jsMs: first.run.jsMs, longTasks: first.run.longTasks,
      barSeen: first.seen.some(s => s.label === 'Checking' && s.bar), lines: first.seen.length };
    console.log('  CROP took ' + secs(first.run.value.ms) + ' and was ' + (first.res && first.res.ok ? 'done' : 'refused: ' + (first.res && first.res.reason)));
    console.log('  ' + jsLine(first.run));
    check('the vase\'s own overlapping shells are the guard\'s finding, as they were before (the unmodified app says the same after a 36 s freeze)',
      !(first.res && first.res.ok) && /has overlapping shells \(\d+ piercing pairs\)/.test((first.res && first.res.reason) || ''), first.res && first.res.reason);
    check('while it checked, the card said "Checking\u2026 N s" with the bar under it', first.seen.some(s => /^Checking\u2026 \d+ s$/.test(s.ro) && s.bar), first.seen.length + ' samples');
    check('...and no stretch of JS over 100 ms on the page\'s thread', first.run.maxJsMs < 100, first.run.maxJsMs.toFixed(0) + ' ms');
    check('nothing was added to the plate', (await page.evaluate(() => state.models.length)) === n0);

    // 2a. the boolean on its own - NSO_Crop.run, the engine the card's CROP calls once the guard has passed: no landing, no selection
    console.log('\n=== the boolean itself: NSO_Crop.run on the vase (what CROP asks the worker; no guard, no landing) ===');
    const eng = await L.measure(page, cdp, 'NSO_Crop.run', async () => {
      const t = Date.now();
      await page.evaluate(() => {
        window.__eng = null;
        const m = state.models.reduce((a, b) => (b.rawTris.length > a.rawTris.length ? b : a));
        const rs = NSO_Crop.resolve(m, NSO_CropCard.shape());
        NSO_Crop.run(rs.piece, rs.shape).then(r => { window.__eng = { ok: r.ok, faces: r.faces, reason: r.reason, tris: r.tris }; });
      });
      while (!(await page.evaluate(() => !!window.__eng))) await sleep(500);
      return Date.now() - t;
    });
    const engRes = await page.evaluate(() => ({ ok: window.__eng.ok, faces: window.__eng.faces, reason: window.__eng.reason }));
    summary.boolean = { wallMs: eng.value, ok: engRes.ok, faces: engRes.faces, longestJsMs: eng.maxJsMs, jsMs: eng.jsMs };
    console.log('  the boolean took ' + secs(eng.value) + ' (' + (engRes.ok ? engRes.faces + ' faces' : engRes.reason) + '); ' + jsLine(eng));
    check('the boolean ran in the worker and answered', engRes.ok && engRes.faces > 0, engRes.reason || engRes.faces + ' faces');
    check('NO stretch of JS over 100 ms on the page\'s thread while it ran', eng.maxJsMs < 100, eng.maxJsMs.toFixed(0) + ' ms' +
      (eng.jsRuns.length ? ' | ' + eng.jsRuns.map(r => r.ms.toFixed(0) + ' ms in ' + (r.incl[0] || ['?'])[0] + ' (self: ' + r.self.slice(0, 4).map(x => x[0].split(' @ ')[0] + ' ' + x[1].toFixed(0)).join(', ') + ')').join('; ') : ''));

    // 2b. the guard overridden, so CROP runs and lands (the drive's doing; nothing in the app)
    console.log('\n=== CROP with the guard overridden, to time the boolean ===');
    await page.evaluate(() => { window.__guard = nsoOverlap.refusalOfModelsAsync; nsoOverlap.refusalOfModelsAsync = async () => ''; });
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return !!S.plan && !S.timer && NSO_BoolBusy.active() === 0; }, null, { timeout: 600000, polling: 200 });
    await frame();
    const second = await press('CROP (guard overridden)', '3mf-2b-cropping.png');
    const run = second.run, res = second.res;
    await page.evaluate(() => { nsoOverlap.refusalOfModelsAsync = window.__guard; });
    summary.crop = { wallMs: run.value.ms, ok: !!(res && res.ok), faces: res && res.faces, name: res && res.name, longestJsMs: run.maxJsMs, jsMs: run.jsMs, longTasks: run.longTasks, guardOverridden: true };
    console.log('  CROP took ' + secs(run.value.ms) + '; ' + (res && res.ok ? res.faces + ' faces landed as "' + res.name + '"' : 'refused: ' + (res && res.reason)));
    console.log('  ' + jsLine(run));
    await page.waitForTimeout(1200);
    await frame();
    await page.screenshot({ path: path.join(SHOTS, '3mf-3-after.png') });
    check('the copy landed', res && res.ok && (await page.evaluate(() => state.models.length)) === n0 + 1, res && res.reason);
    check('the card said "Cropping\u2026 N s" with the bar while it ran', second.seen.some(s => /^Cropping\u2026 \d+ s$/.test(s.ro) && s.bar), second.seen.length + ' samples');
    /* What is left on the page's thread is the LANDING of a 20,000-face copy beside a 1.46 M-triangle host, and the app's own
       reading of the piece just selected (Split to parts' index, app-split-parts.js): not the boolean. Reported, with names. */
    console.log('  landing + selection, on the page\'s thread: longest stretch ' + run.maxJsMs.toFixed(0) + ' ms' +
      (run.jsRuns.length ? ' | ' + run.jsRuns.map(r => r.ms.toFixed(0) + ' ms in ' + (r.incl[0] || ['?'])[0] + ' (self: ' + r.self.slice(0, 4).map(x => x[0].split(' @ ')[0] + ' ' + x[1].toFixed(0)).join(', ') + ')').join('; ') : ''));
    summary.crop.landingRuns = run.jsRuns.map(r => ({ ms: Math.round(r.ms), in: (r.incl[0] || ['?'])[0], self: r.self.slice(0, 4).map(x => x[0].split(' @ ')[0] + ' ' + Math.round(x[1])) }));

    // the copy alone
    await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id && q.mesh); if (p) p.mesh.visible = false; }, big.id);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, '3mf-4-bit-only.png') });
    await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id && q.mesh); if (p) p.mesh.visible = true; }, big.id);

    /* ---- optional: the same copy on the page's thread ---------------- */
    if (flag('--main') && res && res.ok) {
      console.log('\n=== --main: the same copy on the page\'s thread, for the freeze ===');
      const main = await page.evaluate(async ([id, made]) => {
        const m = state.models.find(q => q.id === id), mine = state.models.find(q => q.id === made);
        const rs = NSO_Crop.resolve(m, NSO_CropCard.shape());
        const t = performance.now();
        const r = await NSO_Crop.cropCore(rs.piece, rs.shape, true);
        const ms = performance.now() - t;
        let same = r.ok && r.tris.length === mine.rawTris.length;
        for (let i = 0; same && i < r.tris.length; i++) if (!Object.is(r.tris[i], mine.rawTris[i])) same = false;
        return { ok: r.ok, ms, same };
      }, [big.id, res.id]);
      summary.main = main;
      console.log('  on the page\'s thread: ' + secs(main.ms) + ' with the page unresponsive (' + (main.ok ? 'finished' : 'refused') + '); worker ' + secs(run.value.ms) + ' with it responsive');
      check('the worker\'s copy is the main thread\'s bytes', main.ok && main.same);
    }

    const errs = logs.filter(l => /^\[pageerror\]/.test(l));
    check('no page error', errs.length === 0, errs.slice(0, 2).join(' | '));
  });
  fs.writeFileSync(path.join(SHOTS, '3mf-summary.json'), JSON.stringify(summary, null, 2));
  console.log('\nscreenshots and 3mf-summary.json in ' + SHOTS);
  console.log(fails ? fails + ' FAILED' : 'all held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
