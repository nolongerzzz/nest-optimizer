/* The cutter's blade, slider, number box, readout and cut plane agree, at
   every position and at both ends, on a long piece, a piece already cut once,
   a turned piece and a rolled one.
     node tools/nso_wire_cut_blade_test.js        exit 0 = every gate held

   WHAT WAS WRONG (reproduced on this tree before the fix)
   - The plane could come no closer than 2% of the length to either end
     (snapCutT, getCutPlaneLocal, setCutMm and the slider's 2..98 range):
     6 mm on a 300 mm bar, 3 mm on its 150 mm half - so a sliver was out of
     reach on a first cut and within reach on a second.
   - Three frames: the readout used the geometry's box along the plate-axis
     letter, the blade was sized from m.size and placed in world space as if
     the piece were unrotated, and the cut carried the blade's world position
     back into the piece. On a 60 mm bar turned 90 degrees the readout said
     "6.0 of 60 mm", the blade stood outside the piece, and the plane sat at
     30 mm of a 12 mm span.

   NOW (app-cut.js cutFrame): one frame - the local axis the plate axis runs
   along, and the geometry's box in that frame - feeds all of them. The plane
   keeps CUT_END_MM (= MIN_CUT_SIDE_MM, 1 mm) from each end, on a 0.1 mm grid.

   Real app, real Split button. Each position is checked for: slider value =
   number box = readout = plane (mm from the low end); the blade's centre is
   the plane, in world space; the blade's box covers the piece's section. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function bar(L, W, Ht) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]); q([0, 0, Ht], [L, 0, Ht], [L, W, Ht], [0, W, Ht]);
  q([0, 0, 0], [L, 0, 0], [L, 0, Ht], [0, 0, Ht]); q([0, W, 0], [0, W, Ht], [L, W, Ht], [L, W, 0]);
  q([0, 0, 0], [0, 0, Ht], [0, W, Ht], [0, W, 0]); q([L, 0, 0], [L, W, 0], [L, W, Ht], [L, 0, Ht]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-blade-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

/* Everything the cutter shows, read off the page. */
const STATE = `window.__cutState = function (id) {
  const m = state.models.find(x => x.id === id);
  const info = getCutPlaneForSplit(m);
  const mesh = cutMeshOf(m);
  state.scene.updateMatrixWorld(true);
  const blade = state.cutHelper && state.cutHelper.children.find(c => c.userData.cutBlade);
  const centre = info.bbox.getCenter(new THREE.Vector3()); centre[info.axis] = info.plane;
  const planeWorld = centre.clone().applyMatrix4(mesh.matrixWorld);
  const bladeCentre = blade ? new THREE.Vector3().setFromMatrixPosition(blade.matrixWorld) : null;
  const pb = new THREE.Box3().setFromObject(mesh), bb = blade ? new THREE.Box3().setFromObject(blade) : null;
  // The world direction of the cut axis: the blade must cover the piece in
  // the two world directions across it.
  const dir = new THREE.Vector3(info.axis === 'x' ? 1 : 0, info.axis === 'y' ? 1 : 0, info.axis === 'z' ? 1 : 0)
    .transformDirection(mesh.matrixWorld);
  const along = Math.abs(dir.x) > 0.9 ? 'x' : Math.abs(dir.y) > 0.9 ? 'y' : 'z';
  const coversSection = !!bb && ['x', 'y', 'z'].filter(a => a !== along)
    .every(a => bb.min[a] <= pb.min[a] + 1e-6 && bb.max[a] >= pb.max[a] - 1e-6);
  const ro = document.getElementById('cut-readout').textContent.match(/RED LINE @ ([0-9.]+) mm/);
  return { axis: info.axis, plateAxis: info.plateAxis, span: info.span, mm: info.mm, planeMm: info.plane - info.origin,
    slider: Number(document.getElementById('cut-slider').value), sliderMin: Number(document.getElementById('cut-slider').min),
    sliderMax: Number(document.getElementById('cut-slider').max), box: Number(document.getElementById('cut-mm').value),
    readout: ro ? Number(ro[1]) : null, bladeToPlane: bladeCentre ? bladeCentre.distanceTo(planeWorld) : null,
    coversSection: coversSection, planeWorld: planeWorld.toArray() };
};`;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: STATE });

  const load = async (name, soup) => {
    await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });
    return loadSTL(page, stl(name, soup));
  };
  const open = async id => {
    await page.evaluate(() => {
      const e = document.getElementById('cutter-tools');
      for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
    });
    if (!(await page.evaluate(() => cutterArmed('cut')))) await page.evaluate(() => openCutter('cut'));
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
  };
  // The slider driven the way a user drags it: a value, then an input event.
  const slide = (v) => page.evaluate(v => {
    const s = document.getElementById('cut-slider'); s.value = String(v); s.dispatchEvent(new Event('input'));
  }, v);
  const typeMm = (v) => page.evaluate(v => {
    const s = document.getElementById('cut-mm'); s.value = String(v); s.dispatchEvent(new Event('change'));
  }, v);
  const st = id => page.evaluate(id => __cutState(id), id);

  function agree(label, s, wantMm) {
    const same = [s.slider, s.box, s.readout, s.mm].every(v => Math.abs(v - wantMm) < 1e-9) && Math.abs(s.planeMm - wantMm) < 1e-6;
    check(label + ': slider, number box, readout and plane all at ' + wantMm.toFixed(1) + ' mm', same,
      'slider ' + s.slider + ', box ' + s.box + ', readout ' + s.readout + ', plane ' + s.planeMm.toFixed(6) + ' (span ' + s.span + ', axis ' + s.axis + ')');
    check(label + ': the blade stands on the plane and spans the piece', s.bladeToPlane < 1e-4 && s.coversSection,
      'blade ' + (s.bladeToPlane == null ? 'missing' : s.bladeToPlane.toExponential(1) + ' mm from the plane') + (s.coversSection ? '' : ', SHORT of the piece'));
  }

  // Both ends, and a sweep between, of whatever piece is selected.
  async function ends(label, id, span) {
    await slide(-1000);                    // past the low end
    let s = await st(id);
    check(label + ': slider range is ' + s.sliderMin + ' .. ' + s.sliderMax + ' mm (1 mm from each end)',
      s.sliderMin === 1 && Math.abs(s.sliderMax - (Math.floor((span - 1) * 10 + 1e-9) / 10)) < 1e-9);
    agree(label + ', slider to the low end', s, 1);
    await typeMm(0.2);                     // inside the 1 mm margin
    agree(label + ', 0.2 typed', await st(id), 1);
    const top = Math.floor((span - 1) * 10 + 1e-9) / 10;
    await slide(1e6);
    agree(label + ', slider to the high end', await st(id), top);
    await typeMm(span);
    agree(label + ', full length typed', await st(id), top);
    for (const v of [1.04, 2.37, span / 3, span / 2 + 0.06, span - 1.5]) {
      await slide(v);
      const want = Math.min(top, Math.max(1, Math.round(v * 10) / 10));
      const s2 = await st(id);
      if (!([s2.slider, s2.box, s2.readout, s2.mm].every(x => Math.abs(x - want) < 1e-9) && s2.bladeToPlane < 1e-4 && s2.coversSection)) {
        agree(label + ', slider ' + v, s2, want);
      }
    }
    check(label + ': five positions between the ends agree as well', true);
  }

  // Split at the plane the cutter shows; returns the status and the two new
  // pieces' lengths along the cut.
  const split = id => page.evaluate(id => {
    const before = state.models.map(m => m.id);
    document.getElementById('btn-cut').click();
    const fresh = state.models.filter(m => !before.includes(m.id));
    return { status: document.getElementById('status').textContent, ids: fresh.map(m => m.id) };
  }, id);

  console.log('\n=== 1. a long piece: 300 x 12 x 8 bar, first cut ===');
  const a = await load('bar300.stl', bar(300, 12, 8));
  await open(a);
  await ends('bar 300', a, 300);
  await slide(-1000);
  const sA = await split(a);
  check('Split at the low end: a 1 mm cut is made, not refused', /^Cut @ 1\.0 mm/.test(sA.status) && sA.ids.length === 2, sA.status);

  console.log('\n=== 2. the piece that cut left (299 mm: a clean split): same 1 mm ends ===');
  const big = await page.evaluate(ids => {
    const ms = ids.map(i => state.models.find(m => m.id === i));
    return ms.sort((p, q) => q.size.x - p.size.x)[0].id;
  }, sA.ids);
  await open(big);
  const spanB = (await st(big)).span;
  await ends('cut once (' + spanB.toFixed(1) + ' mm)', big, spanB);
  await slide(1e6);
  const sB = await split(big);
  check('Split at the high end of the second cut is made', /^Cut @ /.test(sB.status) && sB.ids.length === 2, sB.status);

  console.log('\n=== 3. a turned piece: 60 x 12 x 8 bar, Rotate 90 deg ===');
  const c = await load('bar60t.stl', bar(60, 12, 8));
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); rotateSelected(1); }, c);
  await open(c);
  // Cut X runs across the turned bar's 12 mm width ...
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut X is gone)
  let s = await st(c);
  /* re-pinned (pose-bake): the axis letter was the bar's own 'z' / 'x' / 'y'
     under the pose on its mesh; Rotate 90 and Roll are baked into the
     geometry now, so the mesh's own axes are the plate's and the same plane
     is named by the plate axis - the spans are the same 12 / 60 / 8 */
  check('Cut X on the turned bar runs across it, span 12', s.axis === 'x' && Math.abs(s.span - 12) < 1e-6, s.axis + ' ' + s.span);
  await ends('turned, Cut X', c, 12);
  // ... and Cut Z along its 60 mm length.
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'z'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut Z is gone)
  s = await st(c);
  check('Cut Z on the turned bar runs along its length, span 60', s.axis === 'z' && Math.abs(s.span - 60) < 1e-6, s.axis + ' ' + s.span);
  await ends('turned, Cut Z', c, 60);
  // Dragging the red line on the turned piece: point the pointer at the
  // place 7.3 mm from the low end and let the app's own drag handler read it.
  const drag = await page.evaluate(id => {
    const m = state.models.find(x => x.id === id);
    const f = cutFrame(m);
    const local = f.bbox.getCenter(new THREE.Vector3()); local[f.axis] = f.origin + 7.3;
    const w = local.applyMatrix4(f.mesh.matrixWorld);
    const ndc = w.clone().project(state.camera);
    state.pointer.set(ndc.x, ndc.y);
    cutTFromPointer();
    return __cutState(id);
  }, c);
  agree('turned, Cut Z, red line dragged to 7.3 mm', drag, 7.3);
  await slide(1e6);
  const sC = await split(c);
  check('Split at the high end of the turned bar is made', /^Cut @ 59\.0 mm/.test(sC.status) && sC.ids.length === 2, sC.status);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'auto'; a.dispatchEvent(new Event('change')); });

  console.log('\n=== 4. a rolled piece: 60 x 12 x 8 bar on its side (the cut runs along its own Y) ===');
  const e = await load('bar60r.stl', bar(60, 12, 8));
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); rollSelected(); }, e);
  await open(e);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'x'; a.dispatchEvent(new Event('change')); });   // the axis lock (Cut X is gone)
  s = await st(e);
  check('Cut X on the rolled bar runs along the plate\'s X - its own Y, baked - span 8', s.axis === 'x' && Math.abs(s.span - 8) < 1e-4, s.axis + ' ' + s.span);
  await ends('rolled, Cut X', e, 8);
  await slide(-1000);
  const sE = await split(e);
  check('Split at the low end of the rolled bar is made', /^Cut @ 1\.0 mm/.test(sE.status) && sE.ids.length === 2, sE.status);
  await page.evaluate(() => { const a = document.getElementById('edit-axis'); a.value = 'auto'; a.dispatchEvent(new Event('change')); });

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
