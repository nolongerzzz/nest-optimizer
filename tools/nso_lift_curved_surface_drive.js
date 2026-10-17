#!/usr/bin/env node
/* Lift off a curved SURFACE REGION, driven through the REAL app in headless Chromium at 1280 x 800,
   on two real files of about a million triangles each.

     node tools/nso_lift_curved_surface_drive.js        exit 0 = every gate held (or the files are not here: skipped)

   The files are not committed (too big). Put them in tools/fixtures-local/ (git-ignored):
     ButVase.3mf      947,444 triangles, one closed shell: a pitcher with a handle, vines, leaves and butterflies
     medusa_mask.3mf  986,666 triangles: a mask with snakes; one open shell and six stray triangles
   Without them this drive says so and exits 0.

   Each file goes in through the app's own Import. Lift is armed (the Subtract card), a CLICK on a
   triangle of the curved wall reads the surface region it is in, the card says what stands on it, a
   hover outlines one feature, a click lifts it. Every point is a real pointer event at the screen point
   of a triangle the app drew, checked unoccluded first.

     the vase   click the wall -> the surface; "lift the handle" (reports what the surface read says of
                it, and whether it can come off); lift one butterfly - closed piece, vase closed, volumes
                add up, ONE undo step, Ctrl+Z puts the vase back bit for bit
     the mask   click the smooth skin of the face -> the surface; lift the biggest feature it offers - same gates
                (the mask is not closed to begin with: it must be no less closed afterwards). The chin ornament,
                the obvious choice, is read and refused in words: its root wraps 67 degrees round the chin, and a fill
                that steep is not true (3.9 mm off the surface it should follow)

   It reports triangle counts, how long each step took (the click that reads the surface, the lift) and
   whether each piece came off whole. Screenshots go to tools/lift-curved-out/ (git-ignored, never
   committed). */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const L = require('./nso_lift_plate_drive_lib.js');
const { status, readout, card, plateState, ctrlZ, selectRow } = L;
const C = L.makeCheck(), check = C.check;

const LOCAL = path.join(ROOT, 'tools', 'fixtures-local');
const FILES = {
  vase: { file: path.join(LOCAL, 'ButVase.3mf'), tris: 947444, seed: 156184, aim: [110.094, 84.185, 70.166], hash: 3526839365 },
  mask: { file: path.join(LOCAL, 'medusa_mask.3mf'), tris: 986666, seed: 571789, aim: [127.805, 90.129, 31.766], hash: 1543568445 }
};
const ONLY = process.argv[2] === 'vase' || process.argv[2] === 'mask' ? process.argv[2] : null;
const missing = Object.keys(FILES).filter(k => !fs.existsSync(FILES[k].file) || (ONLY && k !== ONLY));
if (missing.length === Object.keys(FILES).length && !ONLY) {
  console.log('SKIPPED: ' + Object.values(FILES).map(f => path.relative(ROOT, f.file)).join(' and ') + ' not found.');
  console.log('These real files are not committed (too big); copy them to tools/fixtures-local/ to run this drive.');
  process.exit(0);
}

const OUT = path.join(ROOT, 'tools', 'lift-curved-out');
fs.mkdirSync(OUT, { recursive: true });
const shots = L.shooter(OUT, true, ROOT), shot = shots.plate;
const REPORT = [];
const sec = ms => (ms / 1000).toFixed(1) + ' s';

/* ---- helpers ---------------------------------------------------------- */

/* Where the time goes: the page's long tasks (main thread blocked over 50 ms) since the last call, in ms. */
const blocked = async page => {
  await page.waitForTimeout(250);
  const lt = await page.evaluate(() => (window.__lt || []).splice(0));
  const sum = lt.reduce((a, b) => a + b, 0), top = lt.slice().sort((a, b) => b - a).slice(0, 4);
  return { n: lt.length, sum, top, words: lt.length + ' long tasks, ' + (sum / 1000).toFixed(1) + ' s of main thread (longest ' + top.map(x => (x / 1000).toFixed(1)).join(', ') + ' s)' };
};
const watchBlocked = page => page.evaluate(() => {
  window.__lt = [];
  try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); } catch (e) { /* no long-task API */ }
});

const hashOf = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), s = m.rawTris, u = new Uint32Array(s.buffer, s.byteOffset, s.length);
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
  return h;
}, id);
/* census and volume of a piece by the numeric-hash census (the string-keyed one is too slow at a million triangles) */
const infoOf = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id);
  if (!m) return null;
  const c = NSO_LiftAuto.census(m.rawTris);
  return { id, name: m.name, tris: c.tris, closed: c.closed, open: c.open, nm: c.nm, degen: c.degen, volume: NSO_Lift.volume(m.rawTris) };
}, id);
const analysisNow = page => page.evaluate(() => {
  const A = NSO_LIFT_PLATE.analysis(), f = NSO_LIFT_PLATE.face();
  if (!A) return null;
  return { engine: A.engine || 'lift', planar: !!A.planar, face: f ? { key: f.key, surf: !!f.surf } : null, region: A.region ? A.region.tris.length : 0,
    ms: A.ms ? Math.round(A.ms.total) : null,
    islands: A.islands.map(I => ({ id: I.id, status: I.status, tris: I.tris.length, parts: I.partCount || 0, height: +I.heightMm.toFixed(2), area: +I.areaMm2.toFixed(0),
      groups: (I.groups || []).length, reason: I.status === 'ok' ? '' : (I.reason || ''), box: I.bounds ? I.bounds.hi.map((h, k) => +(h - I.bounds.lo[k]).toFixed(1)) : null })),
    offered: NSO_LIFT_PLATE.offered() };
});

/* The first of `tris` the app's own raycast hits as itself, on the canvas and not under a menu: { t, x, y } or null.
   `tris` may be long; only the first `limit` that face the camera are tried. */
const visibleTri = (page, id, tris, limit) => page.evaluate(([id, tris, limit]) => {
  const p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array;
  p.mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
  const rect = state.renderer.domElement.getBoundingClientRect(), cam = state.camera.position, rc = new THREE.Raycaster();
  const sc = [];
  for (const t of tris) {
    const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]).applyMatrix4(p.mesh.matrixWorld));
    const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const nrm = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const f = nrm.dot(cam.clone().sub(cen).normalize());
    if (f > 0.5) sc.push({ t, cen, f });
  }
  sc.sort((x, y) => y.f - x.f);
  for (const s of sc.slice(0, limit)) {
    const q = s.cen.clone().project(state.camera);
    if (Math.abs(q.x) > 0.9 || Math.abs(q.y) > 0.9) continue;
    const x = rect.left + (q.x + 1) / 2 * rect.width, y = rect.top + (1 - q.y) / 2 * rect.height;
    if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
    rc.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
    const hit = rc.intersectObjects(state.modelGroup.children, true).find(h => h.faceIndex != null);
    if (hit && hit.faceIndex === s.t && hit.object === p.mesh) return { t: s.t, x, y };
  }
  return null;
}, [id, tris, limit || 200]);

/* the triangles of the smooth surface region round `seed` that lie within r of `at` (raw frame), nearest first - what a
   person clicking the wall there would be on, not a rough patch beside it */
const regionNear = (page, id, seed, at, r) => page.evaluate(([id, seed, at, r]) => {
  const s = state.models.find(q => q.id === id).rawTris, M = NSO_LiftAuto.index(s);
  const R = NSO_LiftCurved.surface.region(M, seed, NSO_LiftCurved.surface.DEFAULTS), out = [];
  for (let t = 0, n = s.length / 9; t < n; t++) {
    if (!R.inR[t]) continue;
    const d = Math.hypot((s[t * 9] + s[t * 9 + 3] + s[t * 9 + 6]) / 3 - at[0], (s[t * 9 + 1] + s[t * 9 + 4] + s[t * 9 + 7]) / 3 - at[1], (s[t * 9 + 2] + s[t * 9 + 5] + s[t * 9 + 8]) / 3 - at[2]);
    if (d < r) out.push([d, t]);
  }
  return { n: R.tris.length, tris: out.sort((a, b) => a[0] - b[0]).map(x => x[1]) };
}, [id, seed, at, r]);

/* the raw triangles whose centroid is within r of `at` (raw frame), nearest first */
const trisNear = (page, id, at, r) => page.evaluate(([id, at, r]) => {
  const s = state.models.find(q => q.id === id).rawTris, out = [];
  for (let t = 0, n = s.length / 9; t < n; t++) {
    const d = Math.hypot((s[t * 9] + s[t * 9 + 3] + s[t * 9 + 6]) / 3 - at[0], (s[t * 9 + 1] + s[t * 9 + 4] + s[t * 9 + 7]) / 3 - at[1], (s[t * 9 + 2] + s[t * 9 + 5] + s[t * 9 + 8]) / 3 - at[2]);
    if (d < r) out.push([d, t]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(x => x[1]);
}, [id, at, r]);

async function frameDir(page, id, dir, zoom) {
  await page.evaluate(([id, dir, zoom]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, bb.max.y - bb.min.y) * (zoom || 1);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + span * dir[0], c.y + span * dir[1], c.z + span * dir[2]);
    state.controls.update();
  }, [id, dir, zoom || 1]);
  await page.waitForTimeout(400);
}
async function pointer(page, x, y, click) {
  await page.mouse.move(x - 4, y - 4);
  await page.mouse.move(x, y);
  if (click) { await page.mouse.down(); await page.mouse.up(); }
  await page.waitForTimeout(click ? 300 : 250);
}
/* look from each direction in turn until `tris` has a triangle the app's raycast hits as itself */
async function findView(page, id, tris, dirs, zoom) {
  for (const d of dirs) {
    await frameDir(page, id, d, zoom);
    const v = await visibleTri(page, id, tris, 120);
    if (v) return { v, dir: d };
  }
  return null;
}
const VIEWS = [[0, 0.35, 1.15], [1.15, 0.35, 0], [-1.15, 0.35, 0], [0, 0.35, -1.15], [0.8, 0.9, 0.8], [-0.8, 0.9, 0.8], [0.8, 0.9, -0.8], [-0.8, 0.9, -0.8], [0, 1.4, 0.3]];

/* ---- one file --------------------------------------------------------- */

async function drive(name, spec, opts) {
  const R = { name, file: path.basename(spec.file), tris: null, steps: [] };
  REPORT.push(R);
  const tStart = Date.now();
  await withApp(async (page, logs) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    page.setDefaultTimeout(600000);
    console.log('\n=== ' + name + ': ' + path.relative(ROOT, spec.file) + ' ===');
    let t0 = Date.now();
    const id = await loadSTL(page, spec.file);
    R.importMs = Date.now() - t0;
    const SRC = await infoOf(page, id), h0 = await hashOf(page, id);
    R.tris = SRC.tris;
    check(name + ': it came in through Import, ' + spec.tris + ' triangles, the file\'s own soup', SRC.tris === spec.tris && h0 === spec.hash,
      SRC.tris + ' triangles, imported in ' + sec(R.importMs) + ', hash ' + (h0 === spec.hash ? 'as read from the file' : 'DIFFERS'));
    console.log('   source: closed=' + SRC.closed + ' open=' + SRC.open + ' nm=' + SRC.nm + ' degen=' + SRC.degen + ' volume=' + SRC.volume.toFixed(1));

    /* ---- arm: the top, read as it always was ---- */
    t0 = Date.now();
    if (await page.evaluate(() => NSO_LIFT_PLATE.isArmed())) await page.click('#btn-lift');
    await selectRow(page, id);
    await page.click('#btn-lift');
    await page.waitForFunction(() => /features? found|nothing read|—/.test(document.getElementById('lift-count').textContent));
    R.armMs = Date.now() - t0;
    console.log('   armed: "' + (await card(page)).count + '" (the top, read straight down: ' + sec(R.armMs) + ')');
    await watchBlocked(page);

    /* ---- a click on the curved wall reads the surface under it ---- */
    const reg = await regionNear(page, id, spec.seed, spec.aim, 25);
    const near = reg.tris;
    check(name + ': the surface the click is aimed at has triangles round the point', near.length > 20, near.length + ' of its ' + reg.n + ' within 25 mm');
    const seen = await findView(page, id, near, VIEWS, opts.zoom);
    check(name + ': one of them is in view, unoccluded', !!seen, seen ? 'triangle ' + seen.v.t : 'none');
    if (!seen) return;
    await shot(page, name + '-surface-0-armed');
    const before = (await plateState(page)).undo;
    await blocked(page);
    t0 = Date.now();
    await pointer(page, seen.v.x, seen.v.y, true);
    await page.waitForFunction(() => { const f = NSO_LIFT_PLATE.face(); return f && f.surf && NSO_LIFT_PLATE.analysis(); });
    R.readMs = Date.now() - t0;
    R.readBlocked = await blocked(page);
    const a = await analysisNow(page), c = await card(page), r1 = await readout(page);
    check(name + ': the click read the surface under it (not the top, not a planar face)', a.engine === 'surface' && !a.planar && a.face && a.face.surf, 'region ' + a.region + ' triangles');
    check(name + ': ...reading a surface changed nothing - no undo step, no piece', (await plateState(page)).undo === before && (await plateState(page)).models.length === 1);
    R.region = a.region; R.engineMs = a.ms;
    console.log('   the click that read the surface: ' + sec(R.readMs) + ' (engine ' + sec(a.ms) + '); region ' + a.region + ' triangles; card: "' + c.count + '"');
    console.log('   ...of which the page was busy: ' + R.readBlocked.words);
    console.log('   ' + r1.slice(0, 400));
    const ok = a.islands.filter(I => I.status === 'ok'), off = a.offered;
    console.log('   features read: ' + a.islands.map(I => '#' + I.id + ' ' + (I.status === 'ok' ? 'ok ' + I.height + ' mm' : I.status) + ' ' + I.tris + ' tris').join('; '));
    await shot(page, name + '-surface-1-read');
    R.features = a.islands;

    /* ---- the pieces ---- */
    for (const goal of opts.lifts) {
      const cand = goal.pick(a);
      R.steps.push({ what: goal.what, island: cand ? cand.id : null });
      if (!cand) { console.log('   ' + goal.what + ': nothing in the read fits'); if (goal.required) check(name + ': ' + goal.what + ' is offered', false, 'nothing in the read fits'); continue; }
      const isl = a.islands[cand.id];
      if (!off.includes(cand.id)) {
        const why = isl.status !== 'ok' ? isl.reason : 'stands out only ' + isl.height + ' mm';
        console.log('   ' + goal.what + ' (#' + cand.id + ', ' + isl.tris + ' tris): NOT offered - ' + why);
        if (goal.required) check(name + ': ' + goal.what + ' is offered', false, why);
        R.steps[R.steps.length - 1].result = 'not offered: ' + why;
        continue;
      }
      const tris = await page.evaluate(id => NSO_LIFT_PLATE.analysis().islands[id].tris, cand.id);
      const view = await findView(page, id, tris, VIEWS, opts.zoom);
      check(name + ': ' + goal.what + ': a triangle of it is in view', !!view, view ? 'triangle ' + view.v.t : 'none');
      if (!view) continue;
      await pointer(page, view.v.x, view.v.y, false);
      const hov = await page.evaluate(() => NSO_LIFT_PLATE.hover());
      check(name + ': ' + goal.what + ': hover outlines it', hov === cand.id, '#' + hov + ' - ' + (await readout(page)).slice(0, 110));
      await shot(page, name + '-surface-2-' + goal.slug + '-hovered');
      const u0 = (await plateState(page)).undo, models0 = (await plateState(page)).models.length;
      await blocked(page);
      t0 = Date.now();
      await pointer(page, view.v.x, view.v.y, true);
      await page.waitForFunction(() => /^Lifted|refused|failed/.test(document.getElementById('lift-readout').textContent), null, { timeout: 600000 });
      const liftMs = Date.now() - t0;
      const liftBlocked = await blocked(page);
      const st = await plateState(page), words = await readout(page);
      const newM = st.models.filter(m => !m.id || m.id !== id).slice(models0 - 1);
      const piece = st.models.length > models0 ? st.models[st.models.length - 1] : null;
      console.log('   ' + goal.what + ' (#' + cand.id + ', ' + isl.tris + ' tris): ' + sec(liftMs) + ' - ' + words.slice(0, 220));
      console.log('   ...of which the page was busy: ' + liftBlocked.words);
      if (!piece) { check(name + ': ' + goal.what + ' came off', false, words); R.steps[R.steps.length - 1].result = 'refused: ' + words; continue; }
      const P = await infoOf(page, piece.id), V = await infoOf(page, id);
      check(name + ': ' + goal.what + ' came off as ONE closed piece', P.closed && P.degen === 0, P.tris + ' triangles, ' + P.open + ' open, ' + P.nm + ' non-manifold');
      check(name + ': ...' + (SRC.closed ? 'the ' + name + ' is still closed' : 'the ' + name + ' is no less closed than it was (open ' + SRC.open + ', non-manifold ' + SRC.nm + ', degenerate ' + SRC.degen + ')'),
        SRC.closed ? V.closed && V.degen === 0 : V.open <= SRC.open && V.nm <= SRC.nm && V.degen <= SRC.degen, V.tris + ' triangles, ' + V.open + ' open, ' + V.nm + ' nm, ' + V.degen + ' degenerate');
      check(name + ': ...volumes add up (source = remaining + piece)', Math.abs(SRC.volume - V.volume - P.volume) < 1e-3 * Math.max(1, Math.abs(P.volume)) + 0.01,
        'residual ' + (SRC.volume - V.volume - P.volume).toExponential(2) + ' mm^3; piece ' + P.volume.toFixed(2) + ' mm^3');
      check(name + ': ...ONE undo step', st.undo === u0 + 1, (st.undo - u0) + ' step(s)');
      await shot(page, name + '-surface-3-' + goal.slug + '-lifted');
      R.steps[R.steps.length - 1].result = 'came off whole: ' + P.tris + ' triangles, closed, ' + P.volume.toFixed(1) + ' mm^3 in ' + sec(liftMs);
      R.steps[R.steps.length - 1].ms = liftMs; R.steps[R.steps.length - 1].tris = P.tris; R.steps[R.steps.length - 1].blocked = liftBlocked;
      await ctrlZ(page);
      await page.waitForFunction(() => !!NSO_LIFT_PLATE.analysis(), null, { timeout: 600000 });
      const h1 = await hashOf(page, id), st2 = await plateState(page);
      check(name + ': ...Ctrl+Z puts the ' + name + ' back bit for bit, the piece gone', h1 === spec.hash && st2.models.length === models0 && st2.undo === u0, 'hash ' + (h1 === spec.hash ? 'same' : 'DIFFERENT') + ', ' + st2.models.length + ' piece(s)');
      // the surface is read again after the undo: pointing at it still works
      const a2 = await analysisNow(page);
      check(name + ': ...and its surface and features are back (the cache)', !!a2 && a2.engine === 'surface' && a2.islands.length === a.islands.length, a2 ? a2.islands.length + ' features' : 'none');
    }
    R.totalMs = Date.now() - tStart;
    const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|Failed to load resource/.test(l));
    check(name + ': no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  });
}

(async () => {
  if (FILES.vase.file && !missing.includes('vase')) {
    await drive('vase', FILES.vase, {
      zoom: 1,
      lifts: [
        { slug: 'handle', what: 'the handle (the biggest thing standing on the wall)', pick: a => a.islands.slice().sort((p, q) => (q.box ? Math.max.apply(null, q.box) : 0) - (p.box ? Math.max.apply(null, p.box) : 0)).find(I => I.status !== 'ok' || I.tris > 100000) },
        { slug: 'butterfly', required: true, what: 'one butterfly', pick: a => a.islands.filter(I => I.status === 'ok' && a.offered.includes(I.id)).sort((p, q) => q.tris - p.tris)[0] }
      ]
    });
  } else console.log('\nvase: ' + path.relative(ROOT, FILES.vase.file) + ' not found - skipped');
  if (!missing.includes('mask')) {
    await drive('mask', FILES.mask, {
      zoom: 1,
      lifts: [{ slug: 'ornament', required: true, what: 'the biggest feature the read offers (a flourish on the skin)', pick: a => a.islands.filter(I => I.status === 'ok' && a.offered.includes(I.id)).sort((p, q) => q.tris - p.tris)[0] }]
    });
  } else console.log('\nmask: ' + path.relative(ROOT, FILES.mask.file) + ' not found - skipped');

  console.log('\n=== report ===');
  REPORT.forEach(R => {
    console.log(R.name + ' (' + R.file + ', ' + R.tris + ' triangles): imported ' + sec(R.importMs) + '; armed ' + sec(R.armMs) + '; the click that read the surface ' + sec(R.readMs) +
      (R.engineMs != null ? ' (engine ' + sec(R.engineMs) + ')' : '') + '; region ' + R.region + ' triangles');
    R.steps.forEach(s => console.log('   ' + s.what + ': ' + (s.result || 'not run')));
    if (R.readBlocked) console.log('   the surface read: ' + R.readBlocked.words);
  });
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed' + (C.fails ? ' - ' + C.failed.join('; ') : ''));
  process.exit(C.fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
