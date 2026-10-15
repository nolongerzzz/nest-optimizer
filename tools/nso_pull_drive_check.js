#!/usr/bin/env node
/* Pull, driven through the REAL app at 1280x800: real index.html, real script
   tags, real pointer events, real Undo.
     node tools/nso_pull_drive_check.js            exit 0 = every gate held
     PULL_SHOTS=dir node tools/nso_pull_drive_check.js   also writes screenshots
     npm run pull:drive

   The geometry is proven headless in tools/nso_pull_test.js. What this file
   proves is the gesture: the button, the slider that is the Brush's, a press
   and drag that moves the real mesh live, a click that drops a pin, Shift that
   turns the drag along the normal, release that commits one Undo step, Escape
   that puts the piece back, a refusal said in words with the piece unchanged,
   and the mutual disarm with the Brush.

   Every drag is page.mouse.down / move / ... / up, to pixels projected from the
   piece's own geometry through the app's own camera. The pieces are generated
   here and loaded through the real file input: a Stock tube D20 wall 1.6 (the
   shipped revolve, the same file the page would make), a 0.8 mm one, and the
   12-triangle box. The big outputs go through tools/mesh_validate.py --gate. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const STOCK = require('../nso_stock.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.PULL_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-pull-drive-'));
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const f3 = v => (Math.round(v * 1000) / 1000).toString();

const tubeSoup = (wall, h) => STOCK.revolve(STOCK.profileTube(10, 10 - wall, h), 96);
function stl(name, soup) { const f = path.join(TMP, name + '.stl'); writeSTL(f, soup, name); return f; }

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

// Frame the piece from above and in front (+z is toward the camera).
async function frame(page, elevDeg, dist, aim) {
  await page.evaluate(([elev, dist, aim]) => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    if (aim) c.y += aim;
    const e = elev * Math.PI / 180;
    state.controls.target.copy(c);
    state.camera.position.set(c.x + dist * Math.cos(e) * 0.12, c.y + dist * Math.sin(e), c.z + dist * Math.cos(e));
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  }, [elevDeg, dist, aim || 0]);
}

// Close in on a raw point of the piece (for the screenshot).
async function lookAtRaw(page, raw, dist, elevDeg) {
  const w = (await rawInfo(page, raw)).world;
  await page.evaluate(([w, dist, elev]) => {
    const e = elev * Math.PI / 180;
    state.controls.target.set(w[0], w[1], w[2]);
    state.camera.position.set(w[0], w[1] + dist * Math.sin(e), w[2] + dist * Math.cos(e));
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  }, [w, dist, elevDeg]);
}

/* Where a raw point of the selected piece is on screen, computed here from the
   raw soup and the mesh's own transform - not by asking the app. Also the
   camera's right vector in world space and the pixels per mm there. */
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
  const px = toPx(w), px1 = toPx(w.clone().add(right));
  return { x: px.x, y: px.y, world: [w.x, w.y, w.z], right: [right.x, right.y, right.z], ppm: Math.hypot(px1.x - px.x, px1.y - px.y) };
}, raw);

/* The pixel a world point lands on. */
const worldToPx = (page, w) => page.evaluate(([x, y, z]) => {
  const rect = state.renderer.domElement.getBoundingClientRect();
  const q = new THREE.Vector3(x, y, z).project(state.camera);
  return { x: rect.left + (q.x + 1) / 2 * rect.width, y: rect.top + (1 - q.y) / 2 * rect.height };
}, w);

/* Does a ray through that pixel land on the piece, and where (in raw)? A drive
   test that presses beside the model and asserts "nothing happened" passes for
   the wrong reason. */
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

/* A drag: press at `from`, step to `to`, and (unless `hold`) release. */
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

/* The soup as the page holds it now, and a bit-exact copy kept for later. */
const keepSoup = page => page.evaluate(() => { window.__kept = Float32Array.from(getActiveModel().rawTris); window.__keptRef = getActiveModel().rawTris; return window.__kept.length / 9; });
const sameAsKept = page => page.evaluate(() => {
  const a = getActiveModel().rawTris, b = window.__kept;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
});
/* The extent of the geometry the screen is drawing, per axis: what a live
   preview that actually moves must change (a status line saying "6 mm" over a
   piece that sits still would otherwise pass). */
const extent = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
  const a = p.mesh.geometry.attributes.position.array, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[i + k]); hi[k] = Math.max(hi[k], a[i + k]); }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
});
const geometryTris = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
  return p.mesh.geometry.attributes.position.count / 3;
});

/* The thinnest and thickest wall under every moved vertex (the same
   measurement tools/nso_pull_test.js makes, in the page, on the soup the app
   now holds). */
const wallRange = (page, rimZ) => page.evaluate((rimZ) => {
  const S = window.nsoPullLast.S, soup = getActiveModel().rawTris;
  const P = NSO_Thickness.prepare(soup, {});
  const m = S.mesh, pos = S.pos, nrm = new Float64Array(m.vertCount * 3);
  for (let t = 0; t < m.triCount; t++) {
    const a = m.tri[t * 3] * 3, b = m.tri[t * 3 + 1] * 3, c = m.tri[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { nrm[i] += cx; nrm[i + 1] += cy; nrm[i + 2] += cz; }
  }
  let lo = Infinity, hi = 0, n = 0;
  const stride = Math.max(1, Math.floor(S.moved.length / 12000));
  for (let q = 0; q < S.moved.length; q += stride) {
    const v = S.moved[q] * 3, L = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]);
    if (!(L > 0) || Math.abs(nrm[v + 2] / L) > 0.35 || pos[v + 2] > rimZ) continue;
    const w = P.wallAt([pos[v], pos[v + 1], pos[v + 2]], { normal: [nrm[v] / L, nrm[v + 1] / L, nrm[v + 2] / L], probe: 2.2 });
    if (!w.measured) continue;
    n++; if (w.mm < lo) lo = w.mm; if (w.mm > hi) hi = w.mm;
  }
  return { lo, hi, n };
}, rimZ);

const edgeStats = page => page.evaluate(() => { const s = NSO_edgeStats(getActiveModel().rawTris); return { open: s.open, nm: s.nm }; });
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const clickUndo = async page => { await page.click('#btn-undo'); await page.waitForTimeout(250); };

(async () => {
  await withApp(async (page, logs) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const tube16 = stl('tube16', tubeSoup(1.6, 60));
    const tube08 = stl('tube08', tubeSoup(0.8, 60));
    const box12 = stl('box12', STOCK.boxSoup(20, 20, 20));

    /* ============================================================== 1 */
    console.log('\n=== 1. the button, the slider that is the Brush\'s, the panel ===');
    const idTube = await loadSTL(page, tube16);
    await selectModel(page, idTube);
    const ui = await page.evaluate(() => {
      const g = i => document.getElementById(i);
      const b = g('btn-pull'), sz = g('inp-pull-size'), br = g('inp-brush-size');
      return {
        inShape: !!(b && b.closest('#menu-shape')), label: b && b.textContent.trim(),
        panelHidden: g('pull-panel').hidden,
        size: sz && { min: sz.min, max: sz.max, value: sz.value, type: sz.type },
        brush: br && br.value, out: g('out-pull-size').textContent,
        clear: !!g('btn-pull-clear'), cancel: !!g('btn-pull-cancel'), clearOff: g('btn-pull-clear').disabled,
        api: [typeof window.nsoPullTakesPointer, typeof window.nsoPullArmed, typeof window.nsoPullSetArmed],
        engine: [typeof NSO_Pull, typeof NSO_Densify]
      };
    });
    check('Pull sits in Shape', ui.inShape && ui.label === 'Pull', ui.label);
    check('its panel is shut until the tool is armed', ui.panelHidden);
    check('falloff slider is 1-50 mm, 12 by default, and is the Brush\'s value', ui.size && ui.size.type === 'range' && ui.size.min === '1' && ui.size.max === '50' &&
          ui.size.value === '12' && ui.brush === '12' && /12 mm/.test(ui.out), JSON.stringify(ui.size) + ' brush ' + ui.brush + ' ' + ui.out);
    check('Clear pins starts disabled, and Cancel is the only other button', ui.clear && ui.cancel && ui.clearOff);
    check('app-core can ask whether Pull owns a press; engine and densify are loaded', ui.api.every(t => t === 'function') && ui.engine.every(t => t === 'object'), ui.api.join(',') + ' / ' + ui.engine.join(','));
    await setSlider(page, 'inp-brush-size', 20);
    let mir = await page.evaluate(() => [document.getElementById('inp-pull-size').value, document.getElementById('out-pull-size').textContent]);
    check('moving the Brush slider moves the Pull slider', mir[0] === '20' && /20 mm/.test(mir[1]), mir.join(' '));
    await setSlider(page, 'inp-pull-size', 35);
    mir = await page.evaluate(() => [document.getElementById('inp-brush-size').value, document.getElementById('out-brush-size').textContent]);
    check('and the Pull slider moves the Brush\'s', mir[0] === '35' && /35 mm/.test(mir[1]), mir.join(' '));
    await setSlider(page, 'inp-pull-size', 12);

    await page.click('#btn-pull');
    let st = await page.evaluate(() => ({ armed: nsoPullArmed(), hidden: document.getElementById('pull-panel').hidden, cls: document.getElementById('btn-pull').classList.contains('is-armed') }));
    check('pressing Pull arms it, opens the panel and lights the button', st.armed && !st.hidden && st.cls);
    await page.click('#btn-brush');
    st = await page.evaluate(() => ({ pull: nsoPullArmed(), brush: nsoBrushArmed(), hidden: document.getElementById('pull-panel').hidden }));
    check('arming the Brush stands Pull down, through its button', !st.pull && st.brush && st.hidden);
    await page.click('#btn-pull');
    st = await page.evaluate(() => ({ pull: nsoPullArmed(), brush: nsoBrushArmed() }));
    check('and arming Pull stands the Brush down', st.pull && !st.brush);
    await page.click('#btn-pull');
    check('pressing it again turns it off', !(await page.evaluate(() => nsoPullArmed())));

    /* ============================================================== 2 */
    console.log('\n=== 2. Stock tube D20 wall 1.6 - grab the lip, pull 6 mm outward in the view plane ===');
    await frame(page, 38, 120, -8);
    await setSlider(page, 'inp-pull-size', 50);
    await page.click('#btn-pull');
    const lipRaw = [9.2, 0, 60];
    const lip = await rawInfo(page, lipRaw);
    const hit = await hitRaw(page, lip);
    check('the lip is under the cursor', hit && dist3(hit, lipRaw) < 0.5, hit ? hit.map(f3).join(', ') : 'missed the piece');
    const target = await worldToPx(page, lip.world.map((v, i) => v + 6 * lip.right[i]));
    await keepSoup(page);
    const trisBefore = await geometryTris(page);
    const depth0 = await undoDepth(page);
    let midInfo = null;
    const ext0 = await extent(page);
    await drag(page, lip, target, 14, { midAt: 9, mid: async () => {
      midInfo = await page.evaluate(() => {
        const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
        return { status: document.getElementById('status').textContent, dragging: nsoPullState().dragging,
                 tris: p.mesh.geometry.attributes.position.count / 3, sameRaw: m.rawTris === window.__keptRef,
                 undo: state.undoStack.length };
      });
      midInfo.ext = await extent(page);
    } });
    check('mid-drag the status line says it is pulling', /Pulling [\d.]+ mm in the view plane/.test(midInfo.status), midInfo.status);
    check('the real mesh is the live preview (densified), not the original', midInfo.dragging && midInfo.tris > trisBefore * 10, trisBefore + ' -> ' + midInfo.tris + ' triangles on screen');
    const grew = Math.max(midInfo.ext[0] - ext0[0], midInfo.ext[1] - ext0[1], midInfo.ext[2] - ext0[2]);
    check('and it MOVES: the drawn piece is wider by the pull so far', grew > 2, ext0.map(f3).join('x') + ' -> ' + midInfo.ext.map(f3).join('x'));
    check('and nothing is committed yet: rawTris untouched, no Undo step', midInfo.sameRaw && midInfo.undo === depth0);
    st = await statusOf(page);
    check('release sets it (no Set button): one Undo step', (await undoDepth(page)) === depth0 + 1 && /^Pull set/.test(st), st.slice(0, 160));
    check('the status line reports the densify', /densified to 0\.5 mm spacing \(768→\d+ triangles\)/.test(st));
    const L = await page.evaluate(() => {
      const L = window.nsoPullLast, S = L.S;
      const gv = S.grab.v, base = [S.basePos[gv * 3], S.basePos[gv * 3 + 1], S.basePos[gv * 3 + 2]], pos = [S.pos[gv * 3], S.pos[gv * 3 + 1], S.pos[gv * 3 + 2]];
      const soup = getActiveModel().rawTris;
      // a vertex of the committed soup sits where the grab went
      let best = Infinity;
      for (let i = 0; i < soup.length; i += 3) best = Math.min(best, Math.hypot(soup[i] - pos[0], soup[i + 1] - pos[1], soup[i + 2] - pos[2]));
      // the original coarse vertices past the radius are bit-for-bit still there
      const have = new Set();
      for (let i = 0; i < soup.length; i += 3) have.add(soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2]);
      const orig = window.__kept; let far = 0, kept = 0;
      for (let i = 0; i < orig.length; i += 3) {
        if (Math.hypot(orig[i] - base[0], orig[i + 1] - base[1], orig[i + 2] - base[2]) >= L.radius) { far++; if (have.has(orig[i] + ',' + orig[i + 1] + ',' + orig[i + 2])) kept++; }
      }
      // the field is the bell at every vertex the grab reaches
      const bell = (d, r) => { const t = 1 - d / r; return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); };
      const Dm = Math.hypot(...L.D); let worst = 0, beyond = 0, beyondMoved = 0;
      for (let v = 0; v < S.mesh.vertCount; v++) {
        const b = [S.basePos[v * 3], S.basePos[v * 3 + 1], S.basePos[v * 3 + 2]];
        const d = Math.hypot(b[0] - base[0], b[1] - base[1], b[2] - base[2]);
        const disp = Math.hypot(S.pos[v * 3] - b[0], S.pos[v * 3 + 1] - b[1], S.pos[v * 3 + 2] - b[2]);
        worst = Math.max(worst, Math.abs(disp - Dm * bell(d, L.radius)));
        if (d >= L.radius) { beyond++; if (disp !== 0) beyondMoved++; }
      }
      return { D: L.D, Dm, radius: L.radius, gvMoved: Math.hypot(pos[0] - base[0], pos[1] - base[1], pos[2] - base[2]), best, far, kept, worst, beyond, beyondMoved, shift: L.shift };
    });
    check('the pull was 6 mm', Math.abs(L.Dm - 6) < 0.1, f3(L.Dm) + ' mm');
    check('the lip moved 6 mm at the grab', Math.abs(L.gvMoved - L.Dm) < 1e-6 && L.best < 1e-4, f3(L.gvMoved) + ' mm; a vertex of the committed soup is ' + L.best.toExponential(1) + ' mm from where it went');
    check('0 mm at the radius and beyond', L.beyond > 0 && L.beyondMoved === 0 && L.worst < 1e-9, L.beyond + ' vertices at or past ' + L.radius + ' mm none moved; worst bell error ' + L.worst.toExponential(1));
    check('the tube\'s far end is bit-for-bit where it was', L.far > 0 && L.far === L.kept, L.kept + ' of ' + L.far);
    const wr = await wallRange(page, 59.4);
    /* The slope bound at 50 mm is 1.6 / sqrt(1 + (1.5 x 6 / 50)^2) = 1.575; the
       difference in displacement between a wall's inside and outside takes
       about 0.03 more, and a pull driven by pixels is not exactly along +x. */
    check('the wall is no thinner than 1.54 mm anywhere under the move (1.6 - 0.06)', wr.n > 500 && wr.lo >= 1.54, f3(wr.lo) + ' .. ' + f3(wr.hi) + ' mm at ' + wr.n + ' stations');
    console.log('        (informational) thicker than 1.65 on the far side of the tube, by shear: ' + f3(wr.lo) + ' .. ' + f3(wr.hi) + ' mm (docs/PULL.md)');
    const es = await edgeStats(page);
    check('manifold: no open or non-manifold edge', es.open === 0 && es.nm === 0, JSON.stringify(es));
    const mv = await canonical(page, 'tube-pull');
    check('mesh_validate.py --gate PASS', mv.verdict === 'PASS', mv.triangles + ' triangles; ' + (mv.verdict_fails || []).join('; '));
    await clickUndo(page);
    check('one Undo restores the soup exactly', (await sameAsKept(page)) && (await undoDepth(page)) === depth0);
    check('and the mesh on screen', (await geometryTris(page)) === trisBefore, (await geometryTris(page)) + ' triangles');
    await page.click('#btn-pull');    // off

    /* ============================================================== 3 */
    console.log('\n=== 3. pin one side of the lip, pull the other (screenshot mid-drag) ===');
    await setSlider(page, 'inp-pull-size', 30);
    await page.click('#btn-pull');
    const pinRaw = [9.2, 0, 60], grabRaw = [-9.2, 0, 60];
    await lookAtRaw(page, [0, 0, 56], 62, 30);        // in close on the lip: the screenshot is of this
    const pinPx = await rawInfo(page, pinRaw), grabPx = await rawInfo(page, grabRaw);
    const pinHit = await hitRaw(page, pinPx), grabHit = await hitRaw(page, grabPx);
    check('both lips are under their cursors', pinHit && grabHit && dist3(pinHit, pinRaw) < 0.5 && dist3(grabHit, grabRaw) < 0.5);
    await page.mouse.click(pinPx.x, pinPx.y);
    await page.waitForTimeout(200);
    const ps = await page.evaluate(() => {
      const helpers = nsoHelpers.live().filter(o => nsoHelpers.ownerOf(o) === 'pull');
      return { s: nsoPullState(), helpers: helpers.length, marks: helpers.reduce((n, o) => n + o.children.length, 0), clearOff: document.getElementById('btn-pull-clear').disabled, status: document.getElementById('status').textContent };
    });
    check('a click drops a pin: one pin, radius 30, the anchor is in the scene, Clear pins is live', ps.s.pins.length === 1 && ps.s.pins[0].r === 30 && ps.marks === 2 && !ps.clearOff, JSON.stringify({ pins: ps.s.pins.length, r: ps.s.pins[0] && ps.s.pins[0].r, marks: ps.marks }));
    check('and says so', /pin 1 set/.test(ps.status), ps.status);
    check('a click does not move the piece or commit anything', (await undoDepth(page)) === depth0 && (await sameAsKept(page)));
    await keepSoup(page);
    const tgt = await worldToPx(page, grabPx.world.map((v, i) => v - 6 * grabPx.right[i]));
    await drag(page, grabPx, tgt, 16, { hold: true });
    await page.waitForTimeout(200);
    if (SHOTS) {
      await page.screenshot({ path: path.join(SHOTS, 'pull-drag-pin.png') });
      console.log('        screenshot -> ' + path.join(SHOTS, 'pull-drag-pin.png'));
    }
    const midPin = await page.evaluate(() => document.getElementById('status').textContent);
    check('mid-drag with the pin set the status line is live', /Pulling [\d.]+ mm/.test(midPin), midPin);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const P = await page.evaluate(() => {
      const L = window.nsoPullLast, S = L.S, pv = S.pins[0].v;
      const dd = (v) => Math.hypot(S.pos[v * 3] - S.basePos[v * 3], S.pos[v * 3 + 1] - S.basePos[v * 3 + 1], S.pos[v * 3 + 2] - S.basePos[v * 3 + 2]);
      let near = 0, worst = 0;
      for (let v = 0; v < S.mesh.vertCount; v++) {
        if (Math.hypot(S.basePos[v * 3] - S.pins[0].c[0], S.basePos[v * 3 + 1] - S.pins[0].c[1], S.basePos[v * 3 + 2] - S.pins[0].c[2]) <= 1) { near++; worst = Math.max(worst, dd(v)); }
      }
      // the same drag with no pin, on the same densified mesh
      const free = NSO_Pull.prepare(window.__kept, { c: L.grab.at, r: L.radius }, [], {});
      NSO_Pull.displace(free, L.D);
      let bi = -1, bd = Infinity;
      for (let v = 0; v < free.mesh.vertCount; v++) {
        const d = Math.hypot(free.basePos[v * 3] - S.pins[0].c[0], free.basePos[v * 3 + 1] - S.pins[0].c[1], free.basePos[v * 3 + 2] - S.pins[0].c[2]);
        if (d < bd) { bd = d; bi = v; }
      }
      const unpinned = Math.hypot(free.pos[bi * 3] - free.basePos[bi * 3], free.pos[bi * 3 + 1] - free.basePos[bi * 3 + 1], free.pos[bi * 3 + 2] - free.basePos[bi * 3 + 2]);
      return { pinMoved: dd(pv), near, worst, unpinned, grabMoved: dd(S.grab.v), D: Math.hypot(...L.D), pins: S.pins.length, status: L.status };
    });
    check('the pull was 6 mm', Math.abs(P.D - 6) < 0.1, f3(P.D) + ' mm');
    check('the pinned side is within 0.02 mm of its start', P.pinMoved <= 0.02, f3(P.pinMoved) + ' mm');
    check('and so is everything within 1 mm of it', P.near > 10 && P.worst <= 0.02, P.near + ' vertices, worst ' + f3(P.worst) + ' mm');
    check('without the pin that spot would have moved', P.unpinned > 1, f3(P.unpinned) + ' mm');
    check('the grab still moved the full distance', Math.abs(P.grabMoved - P.D) < 1e-6, f3(P.grabMoved) + ' mm');
    check('the status line counts the pin', /1 pin/.test(P.status), P.status.slice(0, 140));
    const stillPin = await page.evaluate(() => ({ n: nsoPullState().pins.length, marks: nsoHelpers.live().filter(o => nsoHelpers.ownerOf(o) === 'pull').reduce((n, o) => n + o.children.length, 0) }));
    check('the pin stays after the pull, and its anchor is redrawn on the new mesh', stillPin.n === 1 && stillPin.marks === 2);
    const mvp = await canonical(page, 'tube-pin');
    check('mesh_validate.py --gate PASS', mvp.verdict === 'PASS', mvp.triangles + ' triangles; ' + (mvp.verdict_fails || []).join('; '));
    await clickUndo(page);
    check('Undo restores the soup exactly, and the pin is still there', (await sameAsKept(page)) && (await page.evaluate(() => nsoPullState().pins.length)) === 1);
    await page.click('#btn-pull-clear');
    const cleared = await page.evaluate(() => ({ n: nsoPullState().pins.length, marks: nsoHelpers.live().filter(o => nsoHelpers.ownerOf(o) === 'pull').reduce((n, o) => n + o.children.length, 0), off: document.getElementById('btn-pull-clear').disabled }));
    check('Clear pins takes them off', cleared.n === 0 && cleared.marks === 0 && cleared.off);

    /* ============================================================== 4 */
    console.log('\n=== 4. Shift-drag moves the grab along the surface normal ===');
    await setSlider(page, 'inp-pull-size', 12);
    await frame(page, 38, 120, -8);
    const wallRaw = [0, -10, 40], wallN = [0, -1, 0];       // outer wall facing the camera
    const wallPx = await rawInfo(page, wallRaw);
    const wallHit = await hitRaw(page, wallPx);
    check('the wall is under the cursor', wallHit && dist3(wallHit, wallRaw) < 0.5, wallHit ? wallHit.map(f3).join(', ') : 'missed');
    // world position 3 mm out along the normal, raw (0,-1,0) = world +z
    const out3 = await worldToPx(page, [wallPx.world[0], wallPx.world[1], wallPx.world[2] + 3]);
    await keepSoup(page);
    await page.keyboard.down('Shift');
    await drag(page, wallPx, out3, 12);
    await page.keyboard.up('Shift');
    st = await statusOf(page);
    const SN = await page.evaluate(() => { const L = window.nsoPullLast; return { D: L.D, n: L.normalRaw, shift: L.shift, status: L.status }; });
    const Dn = Math.hypot(...SN.D), cos = (SN.D[0] * SN.n[0] + SN.D[1] * SN.n[1] + SN.D[2] * SN.n[2]) / Dn / Math.hypot(...SN.n);
    check('Shift-drag set a pull along the normal', SN.shift && /along the normal/.test(st), st.slice(0, 120));
    check('3 mm out, along the surface normal at the grab', Math.abs(Dn - 3) < 0.1 && cos > 0.9995, f3(Dn) + ' mm, cos(angle to the normal) ' + cos.toFixed(5));
    await clickUndo(page);
    check('Undo puts it back', await sameAsKept(page));
    await page.click('#btn-pull');   // off

    /* ============================================================== 5 */
    console.log('\n=== 5. a coarse box (12 triangles) - densified under the grab, a smooth bump ===');
    const idBox = await loadSTL(page, box12);
    await selectModel(page, idBox);
    await frame(page, 40, 70, 0);
    await page.click('#btn-pull');
    const topRaw = [0, 0, 20];
    const topPx = await rawInfo(page, topRaw);
    const topHit = await hitRaw(page, topPx);
    check('the top of the box is under the cursor', topHit && dist3(topHit, topRaw) < 0.6, topHit ? topHit.map(f3).join(', ') : 'missed');
    const trisBox = await keepSoup(page);
    const up3 = await worldToPx(page, [topPx.world[0], topPx.world[1] + 3, topPx.world[2]]);
    await page.keyboard.down('Shift');
    await drag(page, topPx, up3, 12);
    await page.keyboard.up('Shift');
    st = await statusOf(page);
    const B = await page.evaluate(() => {
      const L = window.nsoPullLast, S = L.S, soup = getActiveModel().rawTris;
      const bell = (d, r) => { const t = 1 - d / r; return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); };
      const Dm = Math.hypot(...L.D); let h1 = null, worst = 0, n = 0;
      for (let v = 0; v < S.mesh.vertCount; v++) {
        if (S.basePos[v * 3 + 2] !== 20) continue;
        const d = Math.hypot(S.basePos[v * 3] - S.grab.c[0], S.basePos[v * 3 + 1] - S.grab.c[1]);
        if (d >= L.radius) continue;
        n++; worst = Math.max(worst, Math.abs((S.pos[v * 3 + 2] - 20) - Dm * bell(d, L.radius)));
        if (d > 0.9 && d < 1.1 && h1 === null) h1 = S.pos[v * 3 + 2] - 20;
      }
      return { before: L.report.trisBefore, after: soup.length / 9, Dm, h1, worst, n, status: L.status };
    });
    check('the 12-triangle box was densified under the grab', B.before === 12 && B.after > 5000 && /densified to 0\.5 mm spacing/.test(st), B.before + ' -> ' + B.after + ' triangles');
    check('the bump is 3 mm x bell(distance) on the top face - smooth, not a kink', Math.abs(B.Dm - 3) < 0.1 && B.n > 1000 && B.worst < 1e-9 && B.h1 > 0.96 * B.Dm,
          f3(B.Dm) + ' mm peak, ' + B.n + ' vertices, worst error ' + B.worst.toExponential(1) + ', 1 mm from the peak still ' + f3(B.h1) + ' mm');
    const esb = await edgeStats(page);
    check('manifold: no open or non-manifold edge', esb.open === 0 && esb.nm === 0, JSON.stringify(esb));
    const mvb = await canonical(page, 'box-bump');
    check('mesh_validate.py --gate PASS', mvb.verdict === 'PASS', mvb.triangles + ' triangles; ' + (mvb.verdict_fails || []).join('; '));
    await clickUndo(page);
    check('Undo restores the 12 triangles exactly', await sameAsKept(page));
    await page.click('#btn-pull');   // off

    /* ============================================================== 6 */
    console.log('\n=== 6. a 0.8 mm wall pulled 2 mm - refused in words, the piece unchanged ===');
    const idThin = await loadSTL(page, tube08);
    await selectModel(page, idThin);
    await frame(page, 38, 120, -8);
    await page.click('#btn-pull');
    const lip8 = await rawInfo(page, [9.6, 0, 60]);
    await keepSoup(page);
    const geo0 = await geometryTris(page), d6 = await undoDepth(page);
    const t2 = await worldToPx(page, lip8.world.map((v, i) => v + 2 * lip8.right[i]));
    await drag(page, lip8, t2, 10);
    st = await statusOf(page);
    check('refused, in words', /^Pull refused - it would leave [\d.]+ mm of wall .* under the 0\.8 mm floor \(two 0\.4 mm nozzle widths\) - piece unchanged$/.test(st), st);
    check('the piece is unchanged: same soup, same mesh on screen, no Undo step', (await sameAsKept(page)) && (await geometryTris(page)) === geo0 && (await undoDepth(page)) === d6);
    check('and the tool is not left mid-drag', !(await page.evaluate(() => nsoPullState().dragging)));

    /* ============================================================== 7 */
    console.log('\n=== 7. Escape mid-drag puts it back ===');
    await selectModel(page, idTube);
    await frame(page, 38, 120, -8);
    await setSlider(page, 'inp-pull-size', 12);
    const lipE = await rawInfo(page, [9.2, 0, 60]);
    await keepSoup(page);
    const geoE = await geometryTris(page), dE = await undoDepth(page);
    const tE = await worldToPx(page, lipE.world.map((v, i) => v + 4 * lipE.right[i]));
    await drag(page, lipE, tE, 10, { hold: true });
    let live = await page.evaluate(() => ({ dragging: nsoPullState().dragging, tris: getActiveModel() && state.placed.find(q => q.sourceId === getActiveModel().id).mesh.geometry.attributes.position.count / 3 }));
    check('mid-drag the mesh on screen is the live preview', live.dragging && live.tris > geoE * 5, geoE + ' -> ' + live.tris + ' triangles');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    live = await page.evaluate(() => ({ dragging: nsoPullState().dragging, tris: state.placed.find(q => q.sourceId === getActiveModel().id).mesh.geometry.attributes.position.count / 3 }));
    st = await statusOf(page);
    check('Escape restores the piece: the original mesh is back on screen', !live.dragging && live.tris === geoE && /Pull cancelled - piece unchanged/.test(st), st);
    await page.mouse.up();
    await page.waitForTimeout(200);
    check('and the release afterwards commits nothing', (await sameAsKept(page)) && (await undoDepth(page)) === dE);

    /* ============================================================== 8 */
    console.log('\n=== 8. a support piece is refused ===');
    await page.evaluate(() => { getActiveModel().nsoSupport = true; });
    const lipS = await rawInfo(page, [9.2, 0, 60]);
    const tS = await worldToPx(page, lipS.world.map((v, i) => v + 4 * lipS.right[i]));
    await drag(page, lipS, tS, 6);
    st = await statusOf(page);
    check('refused at the press, in words', /^Pull refused - that is a support piece/.test(st), st);
    check('and nothing moved', (await sameAsKept(page)) && (await geometryTris(page)) === geoE && (await undoDepth(page)) === dE);
    await page.evaluate(() => { getActiveModel().nsoSupport = false; });
    await page.click('#btn-pull');   // off
    check('turning Pull off drops the ring and any pins', await page.evaluate(() => nsoHelpers.live().filter(o => nsoHelpers.ownerOf(o) === 'pull').length === 0));

    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  });
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });
