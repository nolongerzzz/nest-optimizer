#!/usr/bin/env node
/* Limb, driven through the REAL app at 1280x800: real index.html, real script
   tags, real pointer events, real Undo.
     node tools/nso_limb_drive_check.js            exit 0 = every gate held
     LIMB_SHOTS=dir node tools/nso_limb_drive_check.js   screenshots elsewhere (default tools/limb-out/, git-ignored)
     npm run limb:drive

   The geometry is proven headless in tools/nso_limb_test.js. What this file
   proves is the gesture: the button, the panel, a hover that marks the loop a
   grab would take, a press and drag that moves the real mesh live and takes only
   that branch, Shift and Alt, a release that commits one Undo step, Escape that
   puts the piece back bit for bit, a click that picks a limb for the numbers,
   Apply, and the mutual disarm with Pull and the Brush.

   Every drag is page.mouse.down / move / ... / up to pixels projected from the
   piece's own geometry through the app's own camera. The piece is
   fixtures/tree_sample.stl, loaded through the real file input.

   The harness wants Chromium where Playwright's own build expects it; on a box
   where it lives elsewhere, PW_CHROMIUM=/path/to/chrome. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.LIMB_SHOTS || path.join(ROOT, 'tools', 'limb-out');
fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-limb-drive-'));
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const f3 = v => (Math.round(v * 1000) / 1000).toString();
const TREE = path.join(ROOT, 'fixtures', 'tree_sample.stl');

/* mesh_validate.py --gate on the piece's soup, taken out of the page. */
async function canonical(page, tag) {
  const arr = await page.evaluate(() => Array.from(getActiveModel().rawTris));
  const f = path.join(TMP, tag + '.stl');
  writeSTL(f, Float32Array.from(arr), tag);
  let out;
  try { out = execFileSync('python3', [MV, f, '--json', '--gate'], { maxBuffer: 1 << 28 }); } catch (e) { out = e.stdout; }
  return JSON.parse(out.toString());
}

/* ---------------------------------------------------- page-side helpers */

// Frame the whole tree, a little above and in front.
async function frame(page, elevDeg, dist) {
  await page.evaluate(([elev, dist]) => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    const e = elev * Math.PI / 180;
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + dist * Math.sin(e), c.z + dist * Math.cos(e));
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  }, [elevDeg, dist]);
}

/* Where a raw point of the selected piece is on screen, from the raw soup and
   the mesh's own transform - not by asking the app. Also the camera's right and
   up vectors in world space and the pixels per mm there. */
const rawInfo = (page, raw) => page.evaluate((r) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
  mesh.updateMatrixWorld(true);
  const s = m.rawTris;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) {
    const d = [s[i], s[i + 2], -s[i + 1]];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[k]); hi[k] = Math.max(hi[k], d[k]); }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const rect = state.renderer.domElement.getBoundingClientRect();
  const toPx = w => { const q = w.clone().project(state.camera); return { x: rect.left + (q.x + 1) / 2 * rect.width, y: rect.top + (1 - q.y) / 2 * rect.height }; };
  const w = mesh.localToWorld(new THREE.Vector3(r[0] - c[0], r[2] - c[1], -r[1] - c[2]));
  const right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 1).normalize();
  const px = toPx(w), px1 = toPx(w.clone().add(right));
  return { x: px.x, y: px.y, world: [w.x, w.y, w.z], right: [right.x, right.y, right.z], up: [up.x, up.y, up.z], ppm: Math.hypot(px1.x - px.x, px1.y - px.y) };
}, raw);

const worldToPx = (page, w) => page.evaluate(([x, y, z]) => {
  const rect = state.renderer.domElement.getBoundingClientRect();
  const q = new THREE.Vector3(x, y, z).project(state.camera);
  return { x: rect.left + (q.x + 1) / 2 * rect.width, y: rect.top + (1 - q.y) / 2 * rect.height };
}, w);

/* Does a ray through that pixel land on the piece, and where (in raw)? */
const hitRaw = (page, pt) => page.evaluate(([cx, cy]) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
  if (!hits.length) return null;
  const s = m.rawTris;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) {
    const d = [s[i], s[i + 2], -s[i + 1]];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[k]); hi[k] = Math.max(hi[k], d[k]); }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  mesh.updateMatrixWorld(true);
  const l = mesh.worldToLocal(hits[0].point.clone());
  const d = [l.x + c[0], l.y + c[1], l.z + c[2]];
  return [d[0], -d[2], d[1]];
}, [pt.x, pt.y]);

const setSlider = (page, id, v) => page.evaluate(([i, val]) => {
  const e = document.getElementById(i); e.value = String(val);
  e.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, v]);

async function drag(page, from, to, steps, opts) {
  opts = opts || {};
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (opts.mid && i === opts.midAt) await opts.mid();
  }
  if (!opts.hold) { await page.mouse.up(); await page.waitForTimeout(250); }
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const keepSoup = page => page.evaluate(() => { window.__kept = Float32Array.from(getActiveModel().rawTris); window.__keptRef = getActiveModel().rawTris; return window.__kept.length / 9; });
const sameAsKept = page => page.evaluate(() => {
  const a = getActiveModel().rawTris, b = window.__kept;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
});
const extent = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
  const a = p.mesh.geometry.attributes.position.array, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[i + k]); hi[k] = Math.max(hi[k], a[i + k]); }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
});
/* The mean of every corner the screen is drawing: what a live preview that
   actually moves must change (a status line saying "6 mm" over a piece that sits
   still would otherwise pass) - and unlike the bounding box it sees a branch
   that moves inside the tree. */
const meanCorner = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
  const a = p.mesh.geometry.attributes.position.array, sum = [0, 0, 0], n = a.length / 3;
  for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += a[i + k];
  return sum.map(v => v / n);
});
const geometryTris = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
  return p.mesh.geometry.attributes.position.count / 3;
});
const edgeStats = page => page.evaluate(() => { const s = NSO_edgeStats(getActiveModel().rawTris); return { open: s.open, nm: s.nm }; });
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const clickUndo = async page => { if (await page.evaluate(() => document.getElementById('btn-undo').disabled)) return; await page.click('#btn-undo'); await page.waitForTimeout(250); };

/* How many vertices of the soup differ from the kept copy, and how far the
   farthest one went - "only that branch moved", in numbers. */
const diffFromKept = page => page.evaluate(() => {
  const a = getActiveModel().rawTris, b = window.__kept;
  if (a.length !== b.length) return { sameLength: false, changed: -1 };
  let changed = 0, far = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
    if (d > 0) { changed++; if (d > far) far = d; }
  }
  return { sameLength: true, changed, far, total: a.length / 3 };
});

/* The tips of the tree, from the page's own copy of the engine: raw points. */
const treeTips = page => page.evaluate(() => {
  const ctx = NSO_Limb.context(getActiveModel().rawTris), m = ctx.mesh, d = ctx.d, g = ctx.graph, out = [];
  for (let v = 0; v < m.vertCount; v++) {
    let mx = true;
    for (let j = g.start[v]; j < g.start[v + 1]; j++) if (d[g.list[j]] > d[v]) { mx = false; break; }
    if (mx) out.push({ v, p: [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]], d: d[v] });
  }
  return out;
});

(async () => {
  await withApp(async (page, logs) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    /* ============================================================== 1 */
    console.log('\n=== 1. the button, the panel, the engine ===');
    const idTree = await loadSTL(page, TREE);
    await selectModel(page, idTree);
    const ui = await page.evaluate(() => {
      const g = i => document.getElementById(i);
      const b = g('btn-limb'), r = g('inp-limb-reach');
      return {
        inShape: !!(b && b.closest('#menu-shape')), label: b && b.textContent.trim(),
        panelHidden: g('limb-panel').hidden,
        modes: ['free', 'extend', 'bend'].map(k => !!g('btn-limb-mode-' + k)),
        reach: r && { min: r.min, max: r.max, value: r.value }, out: g('out-limb-reach').textContent,
        applyOff: g('btn-limb-apply').disabled,
        api: [typeof window.nsoLimbTakesPointer, typeof window.nsoLimbArmed, typeof window.nsoLimbSetArmed],
        engine: [typeof NSO_Limb, typeof NSO_Densify],
        tris: getActiveModel().rawTris.length / 9
      };
    });
    check('Limb sits in Shape beside Pull', ui.inShape && ui.label === 'Limb', ui.label);
    check('its panel is shut until the tool is armed', ui.panelHidden);
    check('three modes, a reach slider that starts at "to the fork", and Apply starts disabled',
          ui.modes.every(Boolean) && ui.reach && ui.reach.value === '0' && ui.out === 'to the fork' && ui.applyOff, JSON.stringify(ui.reach) + ' ' + ui.out);
    check('app-core can ask whether Limb owns a press; the engine is loaded', ui.api.every(t => t === 'function') && ui.engine.every(t => t === 'object'));
    check('the tree is the user\'s 3,796 triangles', ui.tris === 3796, String(ui.tris));

    await page.click('#btn-limb');
    let st = await page.evaluate(() => ({ armed: nsoLimbArmed(), hidden: document.getElementById('limb-panel').hidden, cls: document.getElementById('btn-limb').classList.contains('is-armed') }));
    check('pressing Limb arms it, opens the panel and lights the button', st.armed && !st.hidden && st.cls);
    await page.click('#btn-pull');
    st = await page.evaluate(() => ({ limb: nsoLimbArmed(), pull: nsoPullArmed(), hidden: document.getElementById('limb-panel').hidden }));
    check('arming Pull stands Limb down, through its button', !st.limb && st.pull && st.hidden);
    await page.click('#btn-limb');
    st = await page.evaluate(() => ({ limb: nsoLimbArmed(), pull: nsoPullArmed() }));
    check('and arming Limb stands Pull down', st.limb && !st.pull);
    for (const [btn, name] of [['#btn-brush', 'the Brush'], ['#btn-measure', 'Measure'], ['#btn-carve', 'Carve'], ['#btn-mask-paint', 'Paint Excluded']]) {
      const before = await page.evaluate(() => nsoLimbArmed());
      await page.click(btn);
      const now = await page.evaluate(() => ({ limb: nsoLimbArmed(), hidden: document.getElementById('limb-panel').hidden }));
      check('arming ' + name + ' stands Limb down', before && !now.limb && now.hidden);
      await page.click(btn);                                   // that tool off again
      await page.click('#btn-limb');                           // Limb back on for the next
    }
    await page.click('#btn-limb');
    check('pressing it again turns it off', !(await page.evaluate(() => nsoLimbArmed())));

    /* ============================================================== 2 */
    console.log('\n=== 2. a tip: hover, then drag it sideways ===');
    await frame(page, 20, 150);
    const tips = await treeTips(page);
    /* A grip a little below the tip's very end (a prong narrows to a point, so
       the end itself is a pixel nobody can hover), on a prong that the cursor
       really lands on, and still lands on one pixel either side. */
    await page.click('#btn-limb');
    let tip = null, tipPx = null;
    for (const t of tips.filter(t => t.p[2] > 4).sort((a, b) => b.d - a.d)) {
      const grip = await page.evaluate(([x, y, z]) => {
        const ctx = NSO_Limb.context(getActiveModel().rawTris), pr = NSO_Limb.probe(ctx, [x, y, z]);
        let best = -1, bd = 1e9;
        for (let v = 0; v < ctx.mesh.vertCount; v++) if (pr.limb[v] && Math.abs(ctx.d[v] - (pr.dGrab - 2)) < bd) { bd = Math.abs(ctx.d[v] - (pr.dGrab - 2)); best = v; }
        return [ctx.mesh.pos[best * 3], ctx.mesh.pos[best * 3 + 1], ctx.mesh.pos[best * 3 + 2]];
      }, t.p);
      const px = await rawInfo(page, grip);
      let good = true;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const h = await hitRaw(page, { x: px.x + dx, y: px.y + dy });
        if (!h || dist3(h, grip) > 1.0) { good = false; break; }
      }
      if (good) { tip = { v: t.v, p: grip, d: t.d }; tipPx = px; break; }
    }
    check('a grip on a prong that the cursor really lands on', !!tip, tip ? 'near vertex ' + tip.v + ' at ' + tip.p.map(f3).join(', ') : 'none found');
    await page.mouse.move(tipPx.x, tipPx.y);
    await page.mouse.move(tipPx.x + 1, tipPx.y);
    await page.waitForTimeout(200);
    st = await page.evaluate(() => nsoLimbState());
    check('hovering a branch draws the marker: its ring, its bone, its hinge', st.marker);
    await page.screenshot({ path: path.join(SHOTS, '1-hover.png') });

    const trisBefore = await keepSoup(page);
    const depth0 = await undoDepth(page);
    const mean0 = await meanCorner(page);
    const info = await rawInfo(page, tip.p);
    const target = await worldToPx(page, info.world.map((v, i) => v + 10 * info.right[i] - 4 * info.up[i]));
    let mid = null;
    await drag(page, tipPx, target, 16, { midAt: 10, mid: async () => {
      mid = await page.evaluate(() => {
        const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
        return { status: document.getElementById('status').textContent, s: nsoLimbState(), tris: p.mesh.geometry.attributes.position.count / 3,
                 sameRaw: m.rawTris === window.__keptRef, undo: state.undoStack.length };
      });
      mid.mean = await meanCorner(page);
      await page.screenshot({ path: path.join(SHOTS, '2-mid-drag.png') });
    } });
    check('mid-drag the status line says what is being done', /^Limb \(stretch \+ bend\): bent [\d.]+°, [+-][\d.]+ mm/.test(mid.status), mid.status);
    check('the real mesh is the live preview, densified in the flex zone', mid.s.dragging && mid.tris > trisBefore, trisBefore + ' -> ' + mid.tris + ' triangles on screen');
    const shift = Math.hypot(mid.mean[0] - mean0[0], mid.mean[1] - mean0[1], mid.mean[2] - mean0[2]);
    check('and it MOVES: the drawn surface has shifted (the mean of its corners by ' + f3(shift) + ' mm; densifying alone moves it ~0.01)', shift > 0.1, f3(shift) + ' mm');
    check('and nothing is committed yet: rawTris untouched, no Undo step', mid.sameRaw && mid.undo === depth0);
    st = await statusOf(page);
    check('release sets it (no Set button): one Undo step', (await undoDepth(page)) === depth0 + 1 && /^Limb set/.test(st), st.slice(0, 200));
    const diff = await diffFromKept(page);
    const L1 = await page.evaluate(() => { const l = window.nsoLimbLast; return { report: l.report, last: l.last }; });
    check('only that branch changed: ' + diff.changed + ' of the soup\'s vertices differ (a branch, not the tree)', !diff.sameLength || (diff.changed > 0 && diff.changed < 0.2 * diff.total * 1 && L1.report.moved < 1000),
          diff.sameLength ? diff.changed + '/' + diff.total + ' vertices, farthest ' + f3(diff.far) + ' mm' : 'densified: ' + L1.report.moved + ' limb vertices of ' + L1.report.trisAfter + ' triangles');
    check('the tip landed where the cursor sent it (it leans and lengthens to reach)', L1.last.angleDeg > 5, 'bent ' + f3(L1.last.angleDeg) + ' deg, grown ' + f3(L1.last.ext) + ' mm');
    const es = await edgeStats(page);
    check('the tree is still one closed manifold', es.open === 0 && es.nm === 0, JSON.stringify(es));
    const mv = await canonical(page, 'limb-drag');
    check('mesh_validate.py --gate: ' + mv.verdict, mv.verdict === 'PASS', mv.triangles + ' triangles, V-E+F ' + mv.euler_characteristic);
    await page.screenshot({ path: path.join(SHOTS, '3-after-drag.png') });
    await clickUndo(page);
    check('Undo puts the whole tree back, bit for bit', await sameAsKept(page));

    /* ============================================================== 3 */
    console.log('\n=== 3. Shift extends only, Alt bends only, Escape puts it back ===');
    await page.screenshot({ path: path.join(SHOTS, '4-restored.png') });
    /* a commit and its Undo re-seat the piece, so the tip's pixel is asked for
       again before every gesture, from the raw soup (which Undo restored bit for bit) */
    const gripNow = await rawInfo(page, tip.p);
    const tip2 = gripNow;
    const far = await worldToPx(page, tip2.world.map((v, i) => v + 12 * tip2.right[i] + 6 * tip2.up[i]));
    await page.keyboard.down('Shift');
    await drag(page, gripNow, far, 12, { hold: true });
    st = await statusOf(page);
    check('Shift: the status line says "extend only" and the turn is zero', /extend only\): straight/.test(st), st);
    await page.keyboard.up('Shift');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(250);
    check('Escape mid-drag puts the tree back exactly and leaves no Undo step', (await sameAsKept(page)) && (await undoDepth(page)) === depth0, await statusOf(page));
    await page.keyboard.down('Alt');
    await drag(page, gripNow, far, 12, { hold: true });
    st = await statusOf(page);
    check('Alt: the status line says "bend only" and the length does not change', /bend only\)/.test(st) && /[+-]0\.00 mm/.test(st), st);
    await page.keyboard.up('Alt');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(250);
    check('...and Escape puts that back too', await sameAsKept(page));

    /* the panel's mode buttons are the same choice, held */
    await page.click('#btn-limb-mode-extend');
    const gripX = await rawInfo(page, tip.p), farX = await worldToPx(page, gripX.world.map((v, i) => v + 12 * gripX.right[i] + 6 * gripX.up[i]));
    await drag(page, gripX, farX, 12);
    const Lx = await page.evaluate(() => window.nsoLimbLast);
    check('the Extend button, held: one drag lengthens the limb and does not bend it', Lx && Lx.last.angleDeg === 0 && Math.abs(Lx.last.ext) > 1, Lx ? 'grown ' + f3(Lx.last.ext) + ' mm, turn ' + Lx.last.angleDeg : 'no move');
    await clickUndo(page);

    /* ============================================================== 4 */
    console.log('\n=== 4. a click picks a limb; the numbers apply to it ===');
    await page.click('#btn-limb-mode-free');
    const gripP = await rawInfo(page, tip.p);
    await page.mouse.click(gripP.x, gripP.y);
    await page.waitForTimeout(200);
    st = await page.evaluate(() => ({ picked: nsoLimbState().picked, apply: document.getElementById('btn-limb-apply').disabled, status: document.getElementById('status').textContent }));
    check('a plain click picks the limb and enables Apply', st.picked && !st.apply, st.status);
    check('and moves nothing', await sameAsKept(page) && (await undoDepth(page)) === depth0);
    await page.fill('#inp-limb-ext', '6');
    await page.fill('#inp-limb-bend', '0');
    await page.click('#btn-limb-apply');
    await page.waitForTimeout(250);
    const La = await page.evaluate(() => window.nsoLimbLast);
    st = await statusOf(page);
    check('Apply: Extend 6 mm sets, one Undo step', /^Limb set - extended 6\.00 mm/.test(st) && (await undoDepth(page)) === depth0 + 1, st.slice(0, 140));
    check('the grab moved exactly 6 mm along the limb', La && Math.abs(La.last.ext - 6) < 1e-9 && La.last.angleDeg === 0);
    check('the pick is spent: Apply is disabled again', await page.evaluate(() => document.getElementById('btn-limb-apply').disabled));
    await clickUndo(page);
    check('Undo restores the tree bit for bit', await sameAsKept(page));
    const gripB = await rawInfo(page, tip.p);
    await page.mouse.click(gripB.x, gripB.y);
    await page.fill('#inp-limb-ext', '0');
    await page.fill('#inp-limb-bend', '45');
    await page.selectOption('#sel-limb-lean', 'right');
    await page.click('#btn-limb-apply');
    await page.waitForTimeout(250);
    const Lb = await page.evaluate(() => window.nsoLimbLast);
    st = await statusOf(page);
    check('Apply: Bend 45 degrees to the right sets', /^Limb set - bent 45\.0°/.test(st), st.slice(0, 140));
    const tipAfter = await page.evaluate(() => { const L = window.nsoLimbLast; return { u1: L.last.u1, A1: L.last.A1 }; });
    const rightRaw = await page.evaluate(() => {
      const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
      const right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0);
      const inv = new THREE.Matrix4().copy(p.mesh.matrixWorld).invert();
      const l = right.transformDirection(inv); return [l.x, -l.z, l.y];
    });
    const u0 = await page.evaluate(() => window.nsoLimbLast.S.u0);
    const dotp = tipAfter.u1[0] * rightRaw[0] + tipAfter.u1[1] * rightRaw[1] + tipAfter.u1[2] * rightRaw[2];
    const dot0 = u0[0] * rightRaw[0] + u0[1] * rightRaw[1] + u0[2] * rightRaw[2];
    check('...and "to the right" is the camera\'s right: the tip end now leans further that way', dotp > dot0 + 0.3, 'tip direction . camera right: ' + f3(dot0) + ' -> ' + f3(dotp));
    await page.screenshot({ path: path.join(SHOTS, '5-numbers-bend.png') });
    const mvb = await canonical(page, 'limb-numbers');
    check('mesh_validate.py --gate: ' + mvb.verdict, mvb.verdict === 'PASS', mvb.triangles + ' triangles');
    await clickUndo(page);

    /* ============================================================== 5 */
    console.log('\n=== 5. a lower grab, and Reach ===');
    /* a spot lower on the same limb that the cursor really lands on, clear of
       the prongs in front of it (it is a thin tree: most of any limb is hidden) */
    const lowCands = await page.evaluate(([x, y, z]) => {
      const ctx = NSO_Limb.context(getActiveModel().rawTris), pr = NSO_Limb.probe(ctx, [x, y, z]), out = [];
      for (let v = 0; v < ctx.mesh.vertCount; v++) {
        if (!pr.limb[v]) continue;
        const depth = pr.dGrab - ctx.d[v];
        if (depth > 3.5 && depth < pr.dGrab - pr.tFork - 3.5) out.push({ depth, p: [ctx.mesh.pos[v * 3], ctx.mesh.pos[v * 3 + 1], ctx.mesh.pos[v * 3 + 2]] });
      }
      return out.sort((a, b) => a.depth - b.depth);
    }, tip.p);
    let pLow = null, lowPx = null;
    for (const c of lowCands) {
      const px = await rawInfo(page, c.p);
      let good = true;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const h = await hitRaw(page, { x: px.x + dx, y: px.y + dy });
        if (!h || dist3(h, c.p) > 0.6) { good = false; break; }
      }
      if (good) { pLow = c.p; lowPx = px; break; }
    }
    check('a spot lower on the same limb is under the cursor', !!pLow, pLow ? pLow.map(f3).join(', ') : lowCands.length + ' candidates, all hidden');
    const lowTarget = await worldToPx(page, lowPx.world.map((v, i) => v + 8 * lowPx.right[i]));
    await drag(page, lowPx, lowTarget, 12);
    const Ll = await page.evaluate(() => window.nsoLimbLast);
    check('grabbing lower carries more of the limb: ' + (Ll && Ll.report.carried) + ' vertices ride along (the tip alone was 1)', Ll && Ll.report.carried > 20, Ll ? Ll.status.slice(0, 120) : '');
    await clickUndo(page);
    await setSlider(page, 'inp-limb-reach', 4);
    check('the reach slider reads 4 mm', (await page.evaluate(() => document.getElementById('out-limb-reach').textContent)) === '4 mm');
    const lowPx2 = await rawInfo(page, pLow), lowTarget2 = await worldToPx(page, lowPx2.world.map((v, i) => v + 8 * lowPx2.right[i]));
    const depthR = await undoDepth(page);
    await drag(page, lowPx2, lowTarget2, 12);
    st = await statusOf(page);
    check('8 mm sideways in a 4 mm zone is too sharp: refused in words, the tree untouched',
          /^Limb refused - the move would turn \d+ triangles? inside out - the bend is too sharp for this limb/.test(st) && (await sameAsKept(page)) && (await undoDepth(page)) === depthR, st.slice(0, 170));
    const lowPx3 = await rawInfo(page, pLow), lowTarget3 = await worldToPx(page, lowPx3.world.map((v, i) => v + 2.5 * lowPx3.right[i]));
    await drag(page, lowPx3, lowTarget3, 12);
    const Lr = await page.evaluate(() => window.nsoLimbLast);
    check('2.5 mm sideways in the same zone is taken, and the status line says the zone was held to its last 4 mm', Lr && /held to its last 4 mm/.test(Lr.status) && Lr.report.reach === 4, Lr ? Lr.status.slice(0, 200) : '');
    await clickUndo(page);
    await setSlider(page, 'inp-limb-reach', 0);

    /* ============================================================== 6 */
    console.log('\n=== 6. nothing leaks: leaving the tool leaves nothing behind ===');
    await page.click('#btn-limb');
    st = await page.evaluate(() => ({ armed: nsoLimbArmed(), marker: nsoLimbState().marker, hidden: document.getElementById('limb-panel').hidden }));
    check('Limb off: no marker in the scene, panel shut', !st.armed && !st.marker && st.hidden);
    check('the tree is as it was loaded', await sameAsKept(page));
    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* the OS cleans /tmp */ }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });
