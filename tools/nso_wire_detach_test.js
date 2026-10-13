/* Detach / Reattach, driven through the real app.
   node tools/nso_wire_detach_test.js        exit 0 = every gate held

   Real index.html, real script tags, real clicks. The geometry proofs live
   in tools/nso_detach_test.js; this file proves the part only the page can:

     1. the Cut menu carries Detach flange and Reattach, wired, and app-core
        asks Reattach about clicks;
     2. Detach on the clamp bar (library/v9_mirror_factory.stl) from the
        button: the piece becomes the hull where it stood, and the flange
        lands beside it as its own piece. Both match the Node run triangle
        for triangle, and both pass the canonical checker. One Undo puts the
        bar back value for value and takes the flange off the plate;
     3. Reattach from a real mouse click on the canvas, at the mirror-opposite
        position: the flange is used up, the hull carries it, the result
        passes the canonical checker with self-intersection, and one Undo
        puts back both the hull and the flange piece;
     4. the refusals fire from the page: a piece with no flange, paint on
        either tool's piece, and a click on a face the plate cannot come out of.

   Screenshots land in tools/detach-out/. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, closeTopMenus, ROOT } = require('./nso_app_harness');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const OUT = path.join(__dirname, 'detach-out');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
function validate(soup, name, selfint) {
  const f = path.join(OUT, 'wire-' + name + '.stl');
  writeSTL(f, Float32Array.from(soup));
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'];
  if (!selfint) args.push('--no-selfint');
  const j = JSON.parse(execFileSync('python3', args, { maxBuffer: 64 << 20 }).toString());
  const si = j.self_intersection;
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' +
    j.inconsistent_winding_edges + ' chi ' + j.euler_characteristic + (si ? ' pierce ' + si.pierce : '');
  return j;
}

// The Node run, for "the page does what the module does".
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array, Float64Array,
  Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN, Date,
  NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')) };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['app-cut.js', 'nso_planar_fuse.js', 'app-crop.js', 'nso_seat_surface.js', 'nso_support_aim.js',
                 'nso_assemble.js', 'nso_flange.js', 'nso_detach.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const V9 = path.join(ROOT, 'library', 'v9_mirror_factory.stl');
const v9 = readSTL(V9);
const nodeDet = ctx.NSO_Detach.detach(v9, ctx.NSO_Flange.detect(v9).flanges[0]);
const sumOf = (s) => { let t = 0; for (let i = 0; i < s.length; i++) t += s[i]; return t; };

const measure = (page, id) => page.evaluate(mid => {
  const m = state.models.find(x => x && x.id === mid);
  if (!m) return null;
  const s = m.rawTris;
  let v = 0, sum = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
          s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  for (let i = 0; i < s.length; i++) sum += s[i];
  const st = NSO_edgeStats(s);
  return { tris: s.length / 9, sum, volume: v, open: st.open, nm: st.nm, name: m.name,
           detached: !!m.detached, placed: state.placed.some(p => p && p.sourceId === mid) };
}, id);
const rawOf = (page, id) => page.evaluate(mid => Array.from(state.models.find(x => x && x.id === mid).rawTris), id);
const modelIds = page => page.evaluate(() => state.models.map(m => m.id));
const openCutter = async page => {
  // Crop (and Detach under it) has its own card; opening it arms Crop.
  const open = await page.evaluate(() => document.getElementById('menu-crop').open);
  if (!open) await page.click('#menu-crop > summary');
  if (!(await page.evaluate(() => state.cutterOpen && state.cutTool === 'crop'))) await page.evaluate(() => openCutter('crop'));
};
/* An oblique view of the plate for the screenshots: the flange side and
   the top at once. */
const frameOblique = page => page.evaluate(() => {
  const box = new THREE.Box3();
  state.placed.forEach(p => { if (p && p.mesh) box.expandByObject(p.mesh); });
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length();
  state.camera.position.copy(c.clone().add(new THREE.Vector3(0.35, 0.55, 0.75).normalize().multiplyScalar(r * 0.95)));
  state.controls.target.copy(c);
  state.camera.lookAt(c);
  state.controls.update();
  state.renderer.render(state.scene, state.camera);
});
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent),
  re.source, { timeout: 120000 });

withApp(async (page, logs) => {
  await page.waitForTimeout(400);

  console.log('\n=== 1. the row is there and wired ===');
  {
    const w = await page.evaluate(() => {
      const d = document.getElementById('btn-detach'), r = document.getElementById('btn-reattach');
      const cut = document.getElementById('menu-crop');
      return { d: !!d, r: !!r, wired: d && r && d.dataset.nsoWired === '1' && r.dataset.nsoWired === '1',
               inCut: !!(cut && d && cut.contains(d) && cut.contains(r)), rDisabled: r && r.disabled,
               core: typeof window.NSO_Detach, flange: typeof window.NSO_Flange, run: typeof window.nsoDetachRun,
               at: typeof window.nsoReattachAt, hook: typeof window.nsoReattachTakesClick,
               pick: typeof window.nsoAttachRawPick };
    });
    check('the Crop card carries Detach flange and Reattach, wired', w.d && w.r && w.wired && w.inCut, JSON.stringify(w));
    check('Reattach is disabled until something is detached', w.rDisabled === true);
    check('nso_detach.js, nso_flange.js and app-detach.js are loaded', w.core === 'object' && w.flange === 'object' &&
      w.run === 'function' && w.at === 'function');
    check('it answers app-core\'s click question, and reuses Attach\'s click mapping', w.hook === 'function' && w.pick === 'function');
  }

  console.log('\n=== 2. Detach the clamp bar\'s flange, from the button ===');
  const id = await loadSTL(page, V9);
  await openCutter(page);
  await selectModel(page, id);
  const before = await measure(page, id);
  const ids0 = await modelIds(page);
  await page.click('#btn-detach');
  await waitStatus(page, /Detach/);
  const st = await statusOf(page);
  check('status reports the detach', /^Detached a 2\.94 mm flange/.test(st), st.slice(0, 140));
  const ids1 = await modelIds(page);
  const flangeId = ids1.find(x => !ids0.includes(x));
  const hull = await measure(page, id), flange = flangeId != null ? await measure(page, flangeId) : null;
  check('the piece stays, as the hull; the flange is a new piece beside it',
    ids1.length === ids0.length + 1 && flange && flange.placed && /- Flange$/.test(flange.name) && flange.detached,
    ids0.length + ' -> ' + ids1.length + ' pieces, "' + (flange && flange.name) + '"');
  check('the hull is the Node run\'s, triangle for triangle',
    hull.tris === nodeDet.hull.length / 9 && Math.abs(hull.sum - sumOf(nodeDet.hull)) < 1e-6,
    hull.tris + ' tris, volume ' + hull.volume.toFixed(3) + ' (node ' + nodeDet.volumes.hull.toFixed(3) + ')');
  check('the flange is the Node run\'s, triangle for triangle',
    flange.tris === nodeDet.piece.soup.length / 9 && Math.abs(flange.sum - sumOf(nodeDet.piece.soup)) < 1e-6,
    flange.tris + ' tris, ' + flange.volume.toFixed(3) + ' mm^3');
  const hv = validate(await rawOf(page, id), 'hull', true);
  const fv = validate(await rawOf(page, flangeId), 'flange', true);
  check('the page\'s hull passes the canonical checker, self-intersection included',
    hv.verdict === 'PASS' && hv.self_intersection.pierce === 0, hv.summary);
  check('the page\'s flange passes it too', fv.verdict === 'PASS' && fv.self_intersection.pierce === 0, fv.summary);
  check('Reattach is now enabled', !(await page.evaluate(() => document.getElementById('btn-reattach').disabled)));
  await closeTopMenus(page);
  await frameOblique(page);
  await page.screenshot({ path: path.join(OUT, 'wire-1-detached.png') });
  await openCutter(page);

  await page.click('#btn-undo');
  const undone = await measure(page, id);
  const ids2 = await modelIds(page);
  check('one Undo puts the bar back value for value and takes the flange off the plate',
    undone.tris === before.tris && undone.sum === before.sum && ids2.length === ids0.length &&
    !(await page.evaluate(fid => state.placed.some(p => p && p.sourceId === fid), flangeId)),
    undone.tris + ' tris, checksum ' + (undone.sum === before.sum ? 'identical' : 'DRIFTED') + ', ' + ids2.length + ' pieces');
  check('  ...and names what it undid', /Undo: Detach reverted/.test(await statusOf(page)), await statusOf(page));

  // Again, for the Reattach.
  await selectModel(page, id);
  await page.click('#btn-detach');
  await waitStatus(page, /^Detached/);
  const fid = (await modelIds(page)).find(x => !ids0.includes(x));
  const hullBefore = await measure(page, id);
  const flangeBefore = await measure(page, fid);

  console.log('\n=== 3. Reattach from a real click, at the mirror-opposite position ===');
  {
    // Where the Node run seats the root: the mirrored root, back along -Y to the body.
    const o = nodeDet.piece.frame.origin;
    const mir = [o[0], -o[1], o[2]];
    const t = ctx.NSO_SupportAim._nearestHit([nodeDet.hull], mir, [0, -1, 0], 0, 20);
    const atRaw = [mir[0], mir[1] - t, mir[2]];
    await closeTopMenus(page);
    // Look at that point from the +Y side (raw), so the pixel's ray meets it
    // the way the Node ray did.
    const sp = await page.evaluate(([mid, raw]) => {
      const m = state.models.find(x => x && x.id === mid);
      const p = state.placed.find(x => x && x.sourceId === mid);
      const f = nsoRawFrameOf(m);
      const lp = nsoLocalPointFromRaw(f, raw), ld = nsoLocalDirFromRaw([0, 1, 0]);
      p.mesh.updateMatrixWorld(true);
      const W = p.mesh.localToWorld(new THREE.Vector3(lp[0], lp[1], lp[2]));
      const D = new THREE.Vector3(ld[0], ld[1], ld[2]).transformDirection(p.mesh.matrixWorld);
      state.camera.position.copy(W.clone().addScaledVector(D, 150));
      state.controls.target.copy(W);
      state.camera.lookAt(W);
      state.controls.update();
      state.renderer.render(state.scene, state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      const v = W.clone().project(state.camera);
      const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
      return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
    }, [id, atRaw]);
    check('the pixel aimed at is on the canvas', sp.onCanvas, sp.x.toFixed(1) + ', ' + sp.y.toFixed(1));
    await page.click('#btn-reattach').catch(async () => {
      await page.evaluate(() => { const e = document.getElementById('btn-reattach'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
      await page.click('#btn-reattach');
    });
    const armed = await page.evaluate(() => ({ a: !!state.reattachArmed, s: document.getElementById('status').textContent }));
    check('Reattach arms', armed.a && /click the point on a piece/.test(armed.s), armed.s.slice(0, 90));
    await closeTopMenus(page);
    await page.mouse.click(sp.x, sp.y);
    await waitStatus(page, /Reattached|Reattach refused|Reattach failed|Reattach stood down/);
    const rs = await statusOf(page);
    check('the click reattached it', /^Reattached/.test(rs), rs.slice(0, 220));
    const after = await measure(page, id);
    const idsAfter = await modelIds(page);
    check('the flange piece is used up: it is part of the hull now', !idsAfter.includes(fid) && idsAfter.includes(id),
      idsAfter.length + ' pieces');
    check('seated at its root, full length', /seated 0\.91\d mm/.test(rs) && /full length/.test(rs));
    check('the hull carries it: + the flange, less its seat', Math.abs(after.volume - (hullBefore.volume + flangeBefore.volume +
      nodeDet.piece.rootArea * 0.916 - 496.1)) < 2, hullBefore.volume.toFixed(1) + ' -> ' + after.volume.toFixed(1));
    const rv = validate(await rawOf(page, id), 'reattached', true);
    check('the result passes the canonical checker, self-intersection included',
      rv.verdict === 'PASS' && rv.self_intersection.pierce === 0 && rv.euler_characteristic === 2, rv.summary);
    const armedAfter = await page.evaluate(() => !!state.reattachArmed);
    check('Reattach disarms itself once it has put the piece back', !armedAfter);
    await page.evaluate(() => { state.selectedIndex = -1; if (typeof clearSelectionOutline === 'function') clearSelectionOutline(); });
    await frameOblique(page);
    await page.screenshot({ path: path.join(OUT, 'wire-2-reattached.png') });

    await page.click('#btn-undo');
    const u1 = await measure(page, id), u2 = await measure(page, fid);
    check('one Undo puts back the hull AND the flange piece, value for value',
      u1 && u2 && u1.sum === hullBefore.sum && u1.tris === hullBefore.tris && u2.sum === flangeBefore.sum && u2.placed,
      (u1 && u1.tris) + ' / ' + (u2 && u2.tris) + ' tris');
    check('  ...and names what it undid', /Undo: Reattach reverted/.test(await statusOf(page)));
  }

  console.log('\n=== 4. refusals, from the page ===');
  {
    // The top of the bar faces along the flange's own plate normal.
    const top = await page.evaluate(([mid, fidd]) => {
      const p = state.placed.find(x => x && x.sourceId === mid);
      const m = state.models.find(x => x && x.id === mid);
      const f = nsoRawFrameOf(m);
      const lp = nsoLocalPointFromRaw(f, [0, -1, 10.4693832]);
      p.mesh.updateMatrixWorld(true);
      const W = p.mesh.localToWorld(new THREE.Vector3(lp[0], lp[1], lp[2]));
      const ln = nsoLocalDirFromRaw([0, 0, 1]);
      return { point: W.toArray(), normal: ln };
    }, [id, fid]);
    const bTop = await measure(page, id);
    const r0 = await page.evaluate(([mid, h]) => window.nsoReattachAt(state.placed.find(x => x && x.sourceId === mid),
      h.point, h.normal, null).then(r => ({ ok: r.ok, reason: r.reason })), [id, top]);
    check('a click on the top face: refused, a flat plate cannot come out of it',
      !r0.ok && /faces along the flange's own plate normal/.test(r0.reason) && (await measure(page, id)).sum === bTop.sum, r0.reason);
    // Paint on the target stands Reattach down.
    await page.evaluate(mid => { state.models.find(x => x.id === mid).faceMask = { exclude: [{ axisIdx: 2, keepMin: false, n: [0, 0, 1], d: 10.4693832 }], select: [] }; }, id);
    const r1 = await page.evaluate(([mid, h]) => window.nsoReattachAt(state.placed.find(x => x && x.sourceId === mid),
      h.point, h.normal, null).then(r => ({ ok: r.ok, reason: r.reason })), [id, top]);
    check('paint on the target stands Reattach down, naming the count', !r1.ok && /Reattach stood down - 1 painted face/.test(r1.reason), r1.reason);
    // ...and Detach.
    const r2 = await page.evaluate(mid => window.nsoDetachRun(mid), id);
    check('paint stands Detach down, naming the count', !r2.ok && /Detach stood down - 1 painted face/.test(r2.reason), r2.reason);
    await page.evaluate(mid => { state.models.find(x => x.id === mid).faceMask = { exclude: [], select: [] }; }, id);
    // A piece with no flange.
    const bx = await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    const bb = await measure(page, bx);
    const r3 = await page.evaluate(mid => window.nsoDetachRun(mid), bx);
    check('a piece with no flange: nothing to detach, and it says why', !r3.ok && /nothing to detach - Flange: none detected/.test(r3.reason) &&
      (await measure(page, bx)).sum === bb.sum, r3.reason);
  }

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors on the page', errs.length === 0, errs.slice(0, 3).map(e => e.text).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' + fails : 'PASSED') + '  (tools/nso_wire_detach_test.js)');
  if (fails) process.exit(1);
});
