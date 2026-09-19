/* Stock live editing: the card adjusts the piece it made, in place.
   node tools/nso_stock_live_test.js      exit 0 = every gate held

   The scenario the ticket named, driven end to end in the real app: place a
   block, move it and rotate it by hand, nudge a parameter, and confirm the
   position, the pose and the identity all survive.

   WHAT "THE SAME OBJECT" MEANS HERE, stated up front so the checks below read
   honestly. An adjustment goes through NSO_sculptCommitRaw, which is what
   every bake in this app already goes through. That function replaces the
   piece's geometry and REBUILDS its THREE.Mesh - for Stock exactly as for
   Smooth, Extend, Fatten, Hollow and the Pottery Wheel. So what is asserted
   as stable is the PIECE: the model id, its index in the model list, the
   placed entry and its index, its x / z, its pose fields, and the selection.
   The Mesh uuid is asserted to change, because it does, and a check that
   pretended otherwise would be a check that broke the moment anyone read it.

   Also asserted: the things that must NOT happen. No second piece appears, no
   undo entry per keystroke, and an adjustment never overwrites work another
   tool has done to the block. */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const setF = (page, v) => page.evaluate(o => {
  for (const id of Object.keys(o)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!o[id];
    else el.value = o[id] === null ? '' : String(o[id]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, v);

/* Everything that is supposed to survive an adjustment, in one read. */
const shot = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x && x.id === i);
  const k = state.placed.findIndex(p => p && p.sourceId === i);
  const p = k >= 0 ? state.placed[k] : null;
  if (!m) return null;
  let sum = 0;
  for (let q = 0; q < m.rawTris.length; q++) sum += m.rawTris[q];
  return {
    modelId: m.id, modelIndex: state.models.indexOf(m), name: m.name,
    tris: m.rawTris.length / 9, sum: +sum.toFixed(4),
    size: [+m.size.x.toFixed(4), +m.size.y.toFixed(4), +m.size.z.toFixed(4)],
    placedIndex: k,
    x: p ? +p.x.toFixed(4) : null, z: p ? +p.z.toFixed(4) : null,
    rotY: p ? (p.rotY || 0) : null, tipX: p ? (p.tipX || 0) : null,
    tiltX: p ? (p.tiltX || 0) : null, flipX: p ? !!p.flipX : null,
    meshUuid: p && p.mesh ? p.mesh.uuid : null,
    editId: state.editId, selectedIndex: state.selectedIndex,
    outlined: state.selectedIndex >= 0 && state.placed[state.selectedIndex]
      ? state.placed[state.selectedIndex].sourceId : null,
    models: state.models.length,
    sceneChildren: state.modelGroup.children.length,
    undo: state.undoStack.length,
    session: window.nsoStockSession ? window.nsoStockSession() : null,
    undoTypes: (state.undoStack || []).map(e => e.type).join(','),
    status: document.getElementById('status').textContent.slice(0, 160)
  };
}, id);

const openStock = page => page.evaluate(() => {
  for (let n = document.getElementById('btn-stock-make'); n; n = n.parentElement) {
    if (n.tagName === 'DETAILS') n.open = true;
  }
});

withApp(async (page, logs) => {
  /* app-ux.js re-stamps the HUD into the status line at 0 and 200 ms. */
  await page.waitForTimeout(400);
  await openStock(page);

  console.log('\n=== 1. New stock makes a block, selects it, and opens a session ===');
  let id = null, made = null;
  {
    await setF(page, { 'sel-stock-shape': 'box', 'inp-stock-height': 40, 'inp-stock-radius': 20,
      'inp-stock-wall': 3, 'inp-stock-waste': 0, 'inp-stock-prop': null,
      'chk-stock-match': false, 'chk-stock-oversize': false });
    await page.click('#btn-stock-make');
    id = await page.evaluate(() => state.models[state.models.length - 1].id);
    made = await shot(page, id);
    check('one block on the plate', made.models === 1 && made.sceneChildren === 1,
      made.models + ' model(s), ' + made.sceneChildren + ' in the scene');
    check('26.070 mm cube, as the card asked', Math.abs(made.size[0] - 26.0701) < 1e-3,
      JSON.stringify(made.size));
    check('it is SELECTED, and both halves of "selected" agree',
      made.editId === id && made.outlined === id,
      'editId ' + made.editId + ', outlined ' + made.outlined);
    check('the card has a live session on it',
      made.session && made.session.modelId === id, JSON.stringify(made.session));
  }

  console.log('\n=== 2. THE SCENARIO: move it, rotate it, then adjust a parameter ===');
  let posed = null;
  {
    /* Move and rotate the way a person does - a drag across the plate and the
       yaw / tip buttons, through the app's own handlers. */
    await page.evaluate(i => {
      const k = state.placed.findIndex(p => p && p.sourceId === i);
      selectPlaced(k);
      applyPlacedXZ(state.placed[k], 40, -25);
    }, id);
    await page.click('#btn-rot-right');   /* yaw 90 */
    await page.click('#btn-tilt-up');     /* pitch one step */
    posed = await shot(page, id);
    check('the block has been moved and posed by hand',
      posed.x === 40 && posed.z === -25 && posed.rotY !== 0,
      'x ' + posed.x + ', z ' + posed.z + ', rotY ' + posed.rotY +
      ', tipX ' + posed.tipX + ', tiltX ' + posed.tiltX);

    /* The adjustment: waste margin 0% -> 50%, on a card field, no button. */
    await setF(page, { 'inp-stock-waste': 50 });
    await page.waitForFunction(
      () => /updated in place/i.test(document.getElementById('status').textContent),
      null, { timeout: 15000 });
    const after = await shot(page, id);

    check('the block really did change size - 26.070 -> 29.843 mm',
      Math.abs(after.size[0] - 29.8434) < 1e-3,
      JSON.stringify(posed.size) + ' -> ' + JSON.stringify(after.size));
    check('NO second piece was spawned', after.models === 1 && after.sceneChildren === 1,
      after.models + ' model(s), ' + after.sceneChildren + ' in the scene');
    check('IDENTITY survives: same model id, same place in the list',
      after.modelId === posed.modelId && after.modelIndex === posed.modelIndex,
      'id ' + after.modelId + ', index ' + after.modelIndex);
    check('POSITION survives: same placed entry, same index, same x / z',
      after.placedIndex === posed.placedIndex && after.x === posed.x && after.z === posed.z,
      'placed[' + after.placedIndex + '] at x ' + after.x + ', z ' + after.z);
    check('ROTATION survives: yaw, tip and tilt all still on the piece',
      after.rotY === posed.rotY && after.tipX === posed.tipX &&
      after.tiltX === posed.tiltX && after.flipX === posed.flipX,
      'rotY ' + after.rotY + ', tipX ' + after.tipX + ', tiltX ' + after.tiltX);
    check('SELECTION survives, and both halves still agree',
      after.editId === id && after.outlined === id,
      'editId ' + after.editId + ', outlined ' + after.outlined);
    check('the session is still on the same piece',
      after.session && after.session.modelId === id, JSON.stringify(after.session));
    check('and the status says it was updated in place, not added',
      /updated in place/i.test(after.status) && !/^Added/.test(after.status),
      after.status.slice(0, 110));

    /* Stated rather than hidden: the Mesh is rebuilt, exactly as it is for
       every other bake in this app. The PIECE is what is stable. */
    check('the THREE.Mesh is rebuilt, as NSO_sculptCommitRaw does for every bake',
      after.meshUuid !== posed.meshUuid, 'a new Mesh, in the same placed entry');
  }

  console.log('\n=== 3. every control on the card edits the same piece ===');
  {
    const CASES = [
      ['height 40 -> 30', { 'inp-stock-height': 30 }],
      ['wall 3 -> 2', { 'inp-stock-wall': 2 }],
      ['shape box -> cylinder', { 'sel-stock-shape': 'cylinder', 'inp-stock-prop': 2 }],
      ['ratio 2 -> 4', { 'inp-stock-prop': 4 }],
      ['shape cylinder -> sphere', { 'sel-stock-shape': 'sphere' }],
      ['waste 50 -> 5', { 'inp-stock-waste': 5 }]
    ];
    let prev = await shot(page, id);
    for (const [label, fields] of CASES) {
      await setF(page, fields);
      await page.waitForTimeout(400);
      const now = await shot(page, id);
      check(label + ': the piece changed and it is still the same piece',
        now.sum !== prev.sum && now.modelId === id && now.models === 1 &&
        now.placedIndex === prev.placedIndex && now.x === prev.x && now.z === prev.z &&
        now.rotY === prev.rotY,
        now.tris + ' tris, ' + JSON.stringify(now.size) + ' at x ' + now.x + ', rotY ' + now.rotY);
      prev = now;
    }
  }

  console.log('\n=== 4. one undo entry for the whole session, not one per nudge ===');
  {
    const now = await shot(page, id);
    /* The two posePlaced entries are the yaw and tilt buttons this suite
       pressed in section 2 - a person's own edits, which must survive. What is
       counted here is Stock's own contribution across seven adjustments. */
    const stockEntries = now.undoTypes.split(',').filter(t => t === 'stockReplace').length;
    check('seven adjustments left ONE Stock entry on the undo stack, not seven',
      stockEntries === 1,
      stockEntries + ' stockReplace of ' + now.undo + ' total: [' + now.undoTypes + ']');
    check('  ...and the pose edits the person made are still on the stack under it',
      now.undoTypes.split(',').filter(t => t === 'posePlaced').length === 2,
      '[' + now.undoTypes + ']');
    await page.click('#btn-undo');
    const back = await shot(page, id);
    check('one Undo puts the block back as it was made',
      Math.abs(back.size[0] - made.size[0]) < 1e-3 && back.modelId === id,
      JSON.stringify(back.size) + ' vs the made ' + JSON.stringify(made.size));
    check('  ...and the status names Stock rather than some other tool',
      /Stock adjustment reverted/i.test(back.status), back.status.slice(0, 80));
    check('  ...and the piece is still where it was put, still posed',
      back.x === posed.x && back.z === posed.z && back.rotY === posed.rotY,
      'x ' + back.x + ', z ' + back.z + ', rotY ' + back.rotY);
  }

  console.log('\n=== 5. NEGATIVE CONTROLS - what an adjustment must never do ===');
  {
    /* 5a. It must not overwrite another tool's work. This is the one that
       would cost somebody real work: make a block, hollow it, then nudge a
       field. The card has to notice and stand down. */
    await page.evaluate(() => {
      for (let n = document.getElementById('btn-hollow'); n; n = n.parentElement) {
        if (n.tagName === 'DETAILS') n.open = true;
      }
    });
    await setF(page, { 'inp-hollow-wall': 2 });
    const hol = await page.evaluate(i => {
      state.editId = i;
      const r = window.nsoHollowRun('hollow');
      return { ok: r && r.ok, status: document.getElementById('status').textContent.slice(0, 120) };
    }, id);
    check('Hollow runs on the live block', hol.ok, hol.status);
    const hollowed = await shot(page, id);

    await setF(page, { 'inp-stock-waste': 10 });
    await page.waitForTimeout(500);
    const afterNudge = await shot(page, id);
    check('NEGATIVE CONTROL: nudging the card after Hollow does NOT discard the hollow',
      afterNudge.sum === hollowed.sum && afterNudge.tris === hollowed.tris,
      afterNudge.tris + ' tris, checksum ' + (afterNudge.sum === hollowed.sum ? 'identical' : 'DRIFTED'));
    check('  ...the session ended and said so, rather than going quietly inert',
      afterNudge.session === null && /changed by another tool/i.test(afterNudge.status),
      afterNudge.status.slice(0, 140));

    /* 5b. Selecting a different piece ends the session, so the card cannot
       resize a block the user has moved on from - the Match checkbox in
       particular is about the selection. */
    await setF(page, { 'sel-stock-shape': 'box', 'inp-stock-height': 40, 'inp-stock-waste': 0,
      'inp-stock-prop': null });
    await openStock(page);
    await page.click('#btn-stock-make');
    const id2 = await page.evaluate(() => state.models[state.models.length - 1].id);
    const b2 = await shot(page, id2);
    check('a new press makes a new block and moves the session to it',
      b2.session && b2.session.modelId === id2 && b2.models === 2,
      'session on ' + b2.session.modelId + ', ' + b2.models + ' models');

    const other = await loadSTL(page, fx('box-20mm.stl'));
    await page.evaluate(i => {
      const k = state.placed.findIndex(p => p && p.sourceId === i);
      if (k >= 0) selectPlaced(k); else state.editId = i;
    }, other);
    const beforeOther = await shot(page, id2);
    await setF(page, { 'inp-stock-waste': 80 });
    await page.waitForTimeout(500);
    const afterOther = await shot(page, id2);
    check('NEGATIVE CONTROL: with another piece selected, the card edits nothing',
      afterOther.sum === beforeOther.sum && afterOther.session === null,
      'checksum ' + (afterOther.sum === beforeOther.sum ? 'identical' : 'DRIFTED') +
      ', session ' + JSON.stringify(afterOther.session));

    /* 5c. A refused size leaves the block alone. The build-volume gate is the
       same one New stock applies, and it has to fire on an adjustment too. */
    await setF(page, { 'sel-stock-shape': 'box', 'inp-stock-height': 40, 'inp-stock-waste': 0 });
    await openStock(page);
    await page.click('#btn-stock-make');
    const id3 = await page.evaluate(() => state.models[state.models.length - 1].id);
    const b3 = await shot(page, id3);
    await setF(page, { 'inp-stock-height': 600 });
    await page.waitForTimeout(500);
    const r3 = await shot(page, id3);
    check('NEGATIVE CONTROL: a size the machine cannot print is refused, block unchanged',
      r3.sum === b3.sum && /refused/i.test(r3.status),
      r3.status.slice(0, 130));
    check('  ...and the session stays live, so the next valid value still works',
      r3.session && r3.session.modelId === id3, JSON.stringify(r3.session));
    await setF(page, { 'inp-stock-height': 50 });
    await page.waitForTimeout(500);
    const r4 = await shot(page, id3);
    check('  ...a valid value after a refusal updates the same piece',
      r4.sum !== b3.sum && r4.modelId === id3 && r4.placedIndex === b3.placedIndex,
      JSON.stringify(r4.size));

    /* 5d. Paint wins, per the standing rule. */
    const painted = await page.evaluate(i => {
      const m = state.models.find(x => x.id === i);
      const p = state.placed.find(q => q && q.sourceId === i && q.mesh);
      p.mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(p.mesh);
      const c = bb.getCenter(new THREE.Vector3());
      const span = bb.getSize(new THREE.Vector3()).length() + 50;
      const dv = new THREE.Vector3(0, -1, 0);
      const hits = new THREE.Raycaster(c.clone().sub(dv.clone().multiplyScalar(span)), dv)
        .intersectObject(p.mesh, true);
      if (hits.length) nsoMaskToggleAt(m, p.mesh, hits[0]);
      return nsoMaskCount(m);
    }, id3);
    const b5 = await shot(page, id3);
    await setF(page, { 'inp-stock-waste': 20 });
    await page.waitForTimeout(500);
    const r5 = await shot(page, id3);
    check('NEGATIVE CONTROL: a painted face stands the adjustment down, naming the count',
      painted === 1 && r5.sum === b5.sum && /Stock stood down - 1 painted face/.test(r5.status),
      r5.status.slice(0, 130));
  }

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors across the whole session', errs.length === 0,
    errs.slice(0, 3).map(e => e.text.slice(0, 120)).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' + fails : 'PASSED') + '  (tools/nso_stock_live_test.js)');
  if (fails) process.exit(1);
});
