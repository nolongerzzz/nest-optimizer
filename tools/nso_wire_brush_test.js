#!/usr/bin/env node
/* End-to-end evidence for the Brush, driven through the REAL app in headless
   Chromium with REAL pointer events.
   node tools/nso_wire_brush_test.js        exit 0 = every gate held

   This is the check the headless suite cannot be: tools/nso_brush_test.js
   proves the geometry, but the brush is the first thing in this app that
   needs a press, a drag and a release to mean one operation, and none of that
   exists until index.html, app-core.js's pointer arbitration and
   app-brush.js's stroke session are all in the same page together. So every
   stroke below is page.mouse.down / move / move / ... / up on the canvas, at
   coordinates projected from the piece's own geometry, and the assertions are
   made against the app's real state afterwards. */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0, passes = 0;
const FAILED = [];
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (cond) passes++; else { fails++; FAILED.push(name); }
};

/* The app's own view of the selected piece. */
const measure = page => page.evaluate(() => {
  const m = getActiveModel();
  const s = m.rawTris;
  const st = NSO_edgeStats(s);
  let v = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    v += (s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
        - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
        + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]));
  }
  const p = state.placed.find(q => q && q.sourceId === m.id);
  return {
    tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
    size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) },
    x: p ? +p.x.toFixed(4) : null, z: p ? +p.z.toFixed(4) : null
  };
});

/* Client pixels for a point on the TOP of the selected piece, offset by
   (dx, dz) millimetres in world space. Projected through the app's own camera
   so the test never hard-codes a pixel. */
const topPoint = (page, dx, dz) => page.evaluate(([ox, oz]) => {
  const m = getActiveModel();
  const p = state.placed.find(q => q && q.sourceId === m.id);
  const v = new THREE.Vector3(p.mesh.position.x + ox,
                              p.mesh.position.y + m.size.y / 2 - 0.02,
                              p.mesh.position.z + oz);
  v.project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, [dx, dz]);

/* Does a ray through those pixels actually land on the piece? A drive test
   that misses the model and asserts "nothing changed" passes for the wrong
   reason, which is the failure mode docs/HANDOFF.md already records once. */
const hitsPiece = (page, pt) => page.evaluate(([cx, cy]) => {
  const r = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((cx - r.left) / r.width) * 2 - 1;
  state.pointer.y = -((cy - r.top) / r.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  return state.raycaster.intersectObjects(state.modelGroup.children, true).length > 0;
}, [pt.x, pt.y]);

const setCtl = (page, id, value) => page.evaluate(([i, v]) => {
  const e = document.getElementById(i);
  if (e.type === 'checkbox') e.checked = !!v; else e.value = String(v);
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

const openFinish = page => page.evaluate(() => {
  const b = document.getElementById('btn-brush');
  for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
});

/* One real stroke: press on the piece, drag across it in `steps` moves,
   release. Optionally runs `mid` while the button is still down, which is how
   the "the preview is not a commit" assertion gets made. */
async function stroke(page, from, to, steps, mid) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (mid && i === Math.ceil(steps / 2)) await mid();
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the controls exist and are wired at load ===');
  const ui = await page.evaluate(() => {
    const get = i => document.getElementById(i);
    const b = get('btn-brush'), mode = get('sel-brush-mode');
    const size = get('inp-brush-size'), force = get('inp-brush-intensity'), hard = get('chk-brush-hard');
    return {
      button: !!b, label: b ? b.textContent.trim() : null,
      modes: mode ? Array.from(mode.options).map(o => o.value) : null,
      size: size ? { min: size.min, max: size.max, value: size.value, type: size.type } : null,
      force: force ? { min: force.min, max: force.max, value: force.value, type: force.type } : null,
      hard: !!hard,
      sizeOut: (get('out-brush-size') || {}).textContent,
      forceOut: (get('out-brush-intensity') || {}).textContent,
      api: typeof window.nsoBrushTakesPointer
    };
  });
  check('#btn-brush present', ui.button, ui.label ? 'label "' + ui.label + '"' : 'missing');
  check('three modes on the toggle', JSON.stringify(ui.modes) === '["carve","emboss","smooth"]',
        JSON.stringify(ui.modes));
  check('size slider is 5-50mm', ui.size && ui.size.type === 'range' && ui.size.min === '5' && ui.size.max === '50',
        JSON.stringify(ui.size));
  check('one intensity slider, 0-1', ui.force && ui.force.type === 'range' && ui.force.min === '0' && ui.force.max === '1',
        JSON.stringify(ui.force));
  check('falloff toggle present', ui.hard);
  check('live readouts are filled in at load', /mm/.test(ui.sizeOut || '') && /\d/.test(ui.forceOut || ''),
        ui.sizeOut + ' / ' + ui.forceOut);
  check('app-core can ask whether the brush owns a press', ui.api === 'function', ui.api);

  await page.evaluate(() => {
    const v = parseFloat(document.getElementById('inp-brush-size').value);
    document.getElementById('inp-brush-size').value = String(v + 3);
    document.getElementById('inp-brush-size').dispatchEvent(new Event('input', { bubbles: true }));
  });
  const movedLabel = await page.evaluate(() => document.getElementById('out-brush-size').textContent);
  check('the size readout follows the slider', /15 mm/.test(movedLabel), movedLabel);

  console.log('\n=== 2. a real drag carves the piece - box-20mm.stl ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await openFinish(page);
  await setCtl(page, 'inp-brush-size', 6);
  await setCtl(page, 'inp-brush-intensity', 0.6);
  await setCtl(page, 'sel-brush-mode', 'carve');

  const before = await measure(page);
  console.log('   before  tris ' + before.tris + '  open ' + before.open +
              '  vol ' + before.volume.toFixed(3) + '  at (' + before.x + ', ' + before.z + ')');

  const a = await topPoint(page, -4, 0);
  const b = await topPoint(page, 4, 0);
  check('the drag start really lands on the piece', await hitsPiece(page, a),
        '(' + a.x.toFixed(0) + ', ' + a.y.toFixed(0) + ')');
  check('...and so does the drag end', await hitsPiece(page, b));

  console.log('\n=== 3. the ring follows the cursor while nothing is pressed ===');
  await page.click('#btn-brush');
  const armedStatus = await statusOf(page);
  check('the button arms and says so', /brush armed/i.test(armedStatus), armedStatus);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(60);
  const ring = await page.evaluate(() => {
    let found = null;
    state.scene.traverse(o => { if (o.isLineLoop && o.visible) found = o; });
    if (!found) return null;
    found.geometry.computeBoundingSphere();
    return { visible: found.visible, radius: +found.geometry.boundingSphere.radius.toFixed(3),
             renderOrder: found.renderOrder, picks: found.raycast.toString().length < 40 };
  });
  check('a ring is visible under the hovering cursor', !!ring && ring.visible, JSON.stringify(ring));
  check('the ring is the brush radius', ring && Math.abs(ring.radius - 6) < 0.01, ring ? ring.radius + 'mm' : '-');
  check('the ring is not raycastable, so it cannot eat its own clicks', !!ring && ring.picks);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(60);
  const offModel = await page.evaluate(() => {
    let vis = false;
    state.scene.traverse(o => { if (o.isLineLoop && o.visible) vis = true; });
    return vis;
  });
  check('the ring hides when the cursor leaves the piece', !offModel);

  console.log('\n=== 4. press, drag, release = ONE operation ===');
  let midRaw = null;
  const undoBefore = await page.evaluate(() => state.undoStack.length);
  await stroke(page, a, b, 8, async () => {
    midRaw = await page.evaluate(() => {
      const m = getActiveModel();
      const p = state.placed.find(q => q && q.sourceId === m.id);
      return { rawTris: m.rawTris.length / 9, geomIsModel: p.mesh.geometry === m.geometry,
               previewTris: p.mesh.geometry.getAttribute('position').count / 3,
               undoDepth: state.undoStack ? state.undoStack.length : null };
    });
  });
  const undoAfterStroke = await page.evaluate(() => state.undoStack.length);
  const after = await measure(page);
  const status = await statusOf(page);
  console.log('   mid-stroke: ' + JSON.stringify(midRaw));
  console.log('   after   tris ' + after.tris + '  open ' + after.open +
              '  vol ' + after.volume.toFixed(3) + '  at (' + after.x + ', ' + after.z + ')');
  console.log('   status: ' + status);

  check('mid-stroke the piece showed a preview, NOT its own geometry',
        !!midRaw && midRaw.geomIsModel === false);
  check('mid-stroke m.rawTris was still untouched - the preview is uncommitted',
        !!midRaw && midRaw.rawTris === before.tris,
        midRaw ? midRaw.rawTris + ' vs ' + before.tris : '-');
  check('mid-stroke the preview already showed the refined mesh',
        !!midRaw && midRaw.previewTris > before.tris,
        midRaw ? midRaw.previewTris + ' preview tris vs ' + before.tris + ' committed' : '-');
  check('the stroke committed and said what it did', /Carve done/.test(status), status);
  check('the geometry really changed', Math.abs(after.volume - before.volume) > 1e-3,
        before.volume.toFixed(3) + ' -> ' + after.volume.toFixed(3));
  check('carving removed material', after.volume < before.volume);
  check('refinement reached the committed piece', after.tris > before.tris,
        before.tris + ' -> ' + after.tris);
  check('the mesh did not open', after.open <= before.open, before.open + ' -> ' + after.open);
  check('no non-manifold edges appeared', after.nm <= before.nm, before.nm + ' -> ' + after.nm);
  check('the status carries the before/after the gate measured',
        /self-int 0→0/.test(status) && /T-junctions 0→0/.test(status), status);

  console.log('\n=== 5. the drag did NOT also move the piece on the plate ===');
  check('x unchanged', after.x === before.x, before.x + ' -> ' + after.x);
  check('z unchanged', after.z === before.z, before.z + ' -> ' + after.z);
  check('no "Moved model" reported over the brush status', !/Moved model/.test(status), status);

  console.log('\n=== 6. one undo puts the whole stroke back ===');
  const undoOn = await page.evaluate(() => !document.getElementById('btn-undo').disabled);
  check('undo is enabled after the stroke', undoOn);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent),
                             null, { timeout: 15000 });
  const undone = await measure(page);
  const undoStatus = await statusOf(page);
  console.log('   status: ' + undoStatus);
  check('undo names the Brush, not another bake', /Undo: Brush reverted/.test(undoStatus), undoStatus);
  check('ONE undo restores the whole stroke, not one dab of it',
        undone.tris === before.tris && Math.abs(undone.volume - before.volume) < 1e-6,
        'tris ' + undone.tris + ', vol ' + undone.volume.toFixed(3));
  const undoAfter = await page.evaluate(() => state.undoStack.length);
  check('the whole drag pushed exactly ONE undo entry, not one per dab',
        undoAfterStroke === undoBefore + 1,
        'stack ' + undoBefore + ' -> ' + undoAfterStroke + ' across a 8-move, 5-dab drag');
  check('and that one entry is spent by the single undo',
        undoAfter === undoBefore, 'stack back to ' + undoAfter);

  console.log('\n=== 7. the mode toggle actually changes the operation ===');
  await setCtl(page, 'sel-brush-mode', 'emboss');
  const eBefore = await measure(page);
  await stroke(page, a, b, 8);
  const eAfter = await measure(page);
  const eStatus = await statusOf(page);
  console.log('   status: ' + eStatus);
  check('Emboss commits and names itself', /Emboss done/.test(eStatus), eStatus);
  check('Emboss ADDS volume where Carve removed it',
        eAfter.volume > eBefore.volume,
        eBefore.volume.toFixed(3) + ' -> ' + eAfter.volume.toFixed(3));
  await page.click('#btn-undo');
  await page.waitForTimeout(120);

  await setCtl(page, 'sel-brush-mode', 'smooth');
  const sBefore = await measure(page);
  await stroke(page, a, b, 8);
  const sStatus = await statusOf(page);
  const sAfter = await measure(page);
  console.log('   status: ' + sStatus);
  check('Smooth here commits and names itself', /Smooth \(local\) done/.test(sStatus), sStatus);
  check('local Smooth changed the surface', Math.abs(sAfter.volume - sBefore.volume) > 1e-6,
        sBefore.volume.toFixed(3) + ' -> ' + sAfter.volume.toFixed(3));
  check('local Smooth is not the whole-piece Smooth - the bbox is intact',
        sAfter.size.x === sBefore.size.x && sAfter.size.z === sBefore.size.z,
        JSON.stringify(sBefore.size) + ' -> ' + JSON.stringify(sAfter.size));
  await page.click('#btn-undo');
  await page.waitForTimeout(120);
  await setCtl(page, 'sel-brush-mode', 'carve');

  console.log('\n=== 8. the falloff toggle reaches the geometry ===');
  const fBase = await measure(page);
  await setCtl(page, 'chk-brush-hard', false);
  await stroke(page, a, b, 8);
  const soft = await measure(page);
  await page.click('#btn-undo');
  await page.waitForTimeout(120);
  await setCtl(page, 'chk-brush-hard', true);
  await stroke(page, a, b, 8);
  const hard = await measure(page);
  const softLoss = fBase.volume - soft.volume, hardLoss = fBase.volume - hard.volume;
  console.log('   soft removed ' + softLoss.toFixed(3) + 'mm3, hard removed ' + hardLoss.toFixed(3) + 'mm3');
  check('hard falloff digs more than soft at the same size and force',
        hardLoss > softLoss, softLoss.toFixed(3) + ' vs ' + hardLoss.toFixed(3));
  await page.click('#btn-undo');
  await page.waitForTimeout(120);
  await setCtl(page, 'chk-brush-hard', false);

  console.log('\n=== 9. PAINT SCOPE: sub-region, through the real paint button ===');
  // Paint the top face - the one the brush is about to land on.
  await page.click('#btn-brush');                 // disarm the brush first
  await page.click('#btn-mask-paint');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
  const painted = await page.evaluate(() => nsoMaskCount(getActiveModel()));
  check('the top face is painted', painted === 1, painted + ' face(s)');
  await page.click('#btn-mask-paint');            // leave paint mode
  await page.click('#btn-brush');                 // arm the brush

  const pBefore = await measure(page);
  await stroke(page, a, b, 8);
  const pAfter = await measure(page);
  const pStatus = await statusOf(page);
  console.log('   status: ' + pStatus);
  check('a stroke onto a painted face STANDS DOWN', /Brush stood down/.test(pStatus), pStatus);
  check('...and names the face', /face/.test(pStatus) && /painted face\(s\)/.test(pStatus));
  check('...and says it is a sub-region check', /paint elsewhere on the piece does not stop it/.test(pStatus));
  check('...and the piece is untouched', pAfter.tris === pBefore.tris &&
        Math.abs(pAfter.volume - pBefore.volume) < 1e-9,
        'tris ' + pBefore.tris + ' -> ' + pAfter.tris);

  /* Now move the paint to a face the stroke never reaches. Same rule, other
     half - and the brush has to be shrunk for it, which is the point rather
     than a fudge: at r=6 on a 20mm face a drag from -4 to +4 reaches x=10,
     which IS the X+ face, and standing down there is correct. The check that
     paint elsewhere does not block has to be made with a stroke that really
     is elsewhere. */
  await page.click('#btn-brush');
  await page.click('#btn-mask-clear');
  await setCtl(page, 'inp-brush-size', 4);
  await page.waitForTimeout(80);
  const sidePt = await page.evaluate(() => {
    const m = getActiveModel();
    const p = state.placed.find(q => q && q.sourceId === m.id);
    // a point on the face nearest the camera, which is not the top face
    const v = new THREE.Vector3(p.mesh.position.x + m.size.x / 2 - 0.02,
                                p.mesh.position.y, p.mesh.position.z);
    v.project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  });
  await page.click('#btn-mask-paint');
  await page.mouse.move(sidePt.x, sidePt.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
  const sidePainted = await page.evaluate(() => nsoMaskCount(getActiveModel()));
  await page.click('#btn-mask-paint');
  await page.click('#btn-brush');
  const qBefore = await measure(page);
  const qa = await topPoint(page, -2, 0), qb = await topPoint(page, 2, 0);
  await stroke(page, qa, qb, 8);
  const qAfter = await measure(page);
  const qStatus = await statusOf(page);
  console.log('   ' + sidePainted + ' face(s) painted elsewhere; status: ' + qStatus);
  check('paint on a face the stroke never reaches does NOT stop it',
        sidePainted > 0 && /Carve done/.test(qStatus), qStatus);
  check('...and the stroke really landed', Math.abs(qAfter.volume - qBefore.volume) > 1e-3,
        qBefore.volume.toFixed(3) + ' -> ' + qAfter.volume.toFixed(3));
  check('...and the paint is still there afterwards',
        (await page.evaluate(() => nsoMaskCount(getActiveModel()))) === sidePainted);
  await page.click('#btn-undo');
  await page.click('#btn-mask-clear');
  await setCtl(page, 'inp-brush-size', 6);
  await page.waitForTimeout(120);

  console.log('\n=== 10. THE GATE, through a real drag on a real thin wall ===');
  await page.click('#btn-brush');                 // disarm before switching piece
  const lidId = await loadSTL(page, fx('lid_blank.stl'));
  await selectModel(page, lidId);
  await page.evaluate(id => {
    const i = state.placed.findIndex(p => p && p.sourceId === id);
    if (i >= 0) selectPlaced(i);
  }, lidId);
  await setCtl(page, 'inp-brush-size', 20);
  await setCtl(page, 'inp-brush-intensity', 1);
  await setCtl(page, 'chk-brush-hard', true);
  await page.click('#btn-brush');

  const lidBefore = await measure(page);
  console.log('   lid 60x40x2.4mm: tris ' + lidBefore.tris + '  vol ' + lidBefore.volume.toFixed(2));
  const la = await topPoint(page, 0, 0);
  check('the thin-wall drag lands on the lid', await hitsPiece(page, la));
  await stroke(page, la, await topPoint(page, 6, 0), 6);
  const lidAfter = await measure(page);
  const lidStatus = await statusOf(page);
  console.log('   status: ' + lidStatus);
  check('a stroke that would punch through the wall is REFUSED',
        /Brush refused/.test(lidStatus), lidStatus);
  check('...and the refusal names the self-intersection count it caught',
        /self-intersections rose \d+→\d+/.test(lidStatus), lidStatus);
  check('...and the piece is byte-for-byte unchanged',
        lidAfter.tris === lidBefore.tris && Math.abs(lidAfter.volume - lidBefore.volume) < 1e-9,
        'tris ' + lidBefore.tris + ' -> ' + lidAfter.tris +
        ', vol ' + lidBefore.volume.toFixed(4) + ' -> ' + lidAfter.volume.toFixed(4));
  check('...and no undo entry was pushed for a stroke that never happened',
        (await page.evaluate(() => state.undoStack.filter(e => e.type === 'brushReplace').length)) === 0);

  console.log('\n=== 11. disarming, and the page stayed clean ===');
  await page.click('#btn-brush');
  const offStatus = await statusOf(page);
  check('the button disarms', /Brush off/.test(offStatus), offStatus);
  const ringGone = await page.evaluate(() => {
    let vis = false;
    state.scene.traverse(o => { if (o.isLineLoop && o.visible) vis = true; });
    return !vis;
  });
  check('the ring goes away with it', ringGone);
  const dBefore = await measure(page);
  await stroke(page, la, await topPoint(page, 6, 0), 4);
  const dAfter = await measure(page);
  check('a drag with the brush disarmed does not deform anything',
        dAfter.tris === dBefore.tris && Math.abs(dAfter.volume - dBefore.volume) < 1e-9);

  console.log('\n=== 12. one armed tool at a time, both directions ===');
  /* The paint grew a second button (Paint Selected / Paint Excluded) and
     state.maskPaint became false|'exclude'|'select' while this feature was in
     flight. A disarm that clicks btn-mask-paint while 'select' is live SWITCHES
     paint modes instead of stopping it, so this pins the thing that would
     break, not just the thing that works. */
  const armState = () => page.evaluate(() => ({
    brush: typeof window.nsoBrushArmed === 'function' ? window.nsoBrushArmed() : null,
    paint: state.maskPaint,
    measure: !!state.measureOn,
    carve: !!state.carveArmed
  }));

  await page.evaluate(() => {
    const b = document.getElementById('btn-mask-select');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  await page.click('#btn-mask-select');
  const sel = await armState();
  check('Paint Selected arms as the select mode', sel.paint === 'select', JSON.stringify(sel));
  await page.click('#btn-brush');
  const afterBrush = await armState();
  check('arming the Brush turns the SELECT paint off, not into Excluded',
        afterBrush.brush === true && afterBrush.paint === false, JSON.stringify(afterBrush));

  /* NOT asserted here, on purpose: the other direction from the two PAINT
     buttons. Arming either of them disarms nothing at all - measured
     2026-09-18 on this tree, it leaves Carve and Measure armed exactly as it
     leaves the Brush armed - so it is a pre-existing gap in app-mask.js and
     not something this feature introduced or should pin. A test that asserted
     it would be asserting a bug, and would fail the day someone fixes it.
     Recorded in docs/BRUSH.md under known limits instead. */
  await page.evaluate(() => {
    if (state.maskPaint) document.getElementById(
      state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint').click();
    if (typeof window.nsoBrushArmed === 'function' && !window.nsoBrushArmed())
      document.getElementById('btn-brush').click();
  });
  const preMeasure = await armState();
  check('the Brush is armed going into the Measure check', preMeasure.brush === true,
        JSON.stringify(preMeasure));
  await page.click('#btn-measure');
  const afterMeasure = await armState();
  check('arming Measure disarms the Brush', afterMeasure.measure && afterMeasure.brush === false,
        JSON.stringify(afterMeasure));
  await page.click('#btn-brush');
  const afterReArm = await armState();
  check('and arming the Brush disarms Measure',
        afterReArm.brush === true && afterMeasure.brush === false && !afterReArm.measure,
        JSON.stringify(afterReArm));
  await page.click('#btn-brush');

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors during any of it', errs.length === 0, errs.join(' | '));

  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (fails) { console.log('failing:'); for (const f of FAILED) console.log('  - ' + f); }
  if (fails) process.exit(1);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });
