/* Stock live editing: the Scale card adjusts the piece a tile dropped, in place.
   node tools/nso_stock_live_test.js      exit 0 = every gate held

   Stock used to carry its own live fields and a session that re-sized the
   block it made. The card is a shelf of tiles now (app-stock.js) and Scale is
   how a dropped piece is sized, so the scenario this suite was written for is
   driven through Scale's live fields instead: drop a block, move it and
   rotate it by hand, size it, and confirm the position, the pose and the
   identity all survive.

   WHAT "THE SAME OBJECT" MEANS HERE, stated up front so the checks below read
   honestly. A Scale commit goes through NSO_sculptCommitRaw, which is what
   every bake in this app goes through. That function replaces the piece's
   geometry and REBUILDS its THREE.Mesh - for a dropped shape exactly as for
   Smooth, Extend, Fatten, Hollow and the Pottery Wheel. So what is asserted
   as stable is the PIECE: the model id, its index in the model list, the
   placed entry and its index, its x / z, its pose fields, and the selection.
   The Mesh uuid is asserted to change, because it does, and a check that
   pretended otherwise would be a check that broke the moment anyone read it.

   Also asserted: the things that must NOT happen. No second piece appears,
   no undo entry per keystroke, and a tile click never edits the piece that
   was selected when it was pressed.

   Every shape's own row is driven in section 3, which is also the proof that
   a dropped piece is TAGGED: Scale's shape rows (nso_shapes.js) read the
   parameters off the tag, and a piece that lost it would be refitted from its
   mesh or not offered the row at all. */

const path = require('path');
const { withApp, openMenuFor, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Everything that is supposed to survive an adjustment, in one read. */
const shot = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x && x.id === i);
  const k = state.placed.findIndex(p => p && p.sourceId === i);
  const p = k >= 0 ? state.placed[k] : null;
  if (!m) return null;
  let sum = 0;
  for (let q = 0; q < m.rawTris.length; q++) sum += Math.abs(m.rawTris[q]);
  return {
    modelId: m.id, modelIndex: state.models.indexOf(m), name: m.name,
    tris: m.rawTris.length / 9, sum: +sum.toFixed(4),
    size: [+m.size.x.toFixed(4), +m.size.y.toFixed(4), +m.size.z.toFixed(4)],
    placedIndex: k,
    x: p ? +p.x.toFixed(4) : null, z: p ? +p.z.toFixed(4) : null,
    rotY: p ? (p.rotY || 0) : null, tipX: p ? (p.tipX || 0) : null,
    tiltX: p ? (p.tiltX || 0) : null, flipX: p ? !!p.flipX : null,
    body: p ? nsoPieceBodyQ(p).toArray().map(v => +v.toFixed(9)) : null,
    meshUuid: p && p.mesh ? p.mesh.uuid : null,
    editId: state.editId, selectedIndex: state.selectedIndex,
    outlined: state.selectedIndex >= 0 && state.placed[state.selectedIndex]
      ? state.placed[state.selectedIndex].sourceId : null,
    models: state.models.length,
    sceneChildren: state.modelGroup.children.length,
    undo: state.undoStack.length,
    undoTypes: (state.undoStack || []).map(e => e.type).join(','),
    status: document.getElementById('status').textContent.slice(0, 160)
  };
}, id);

const openShelf = async page => {
  const open = await page.evaluate(() => ({
    gen: document.getElementById('menu-gen').open,
    stock: document.querySelector('#menu-gen .vp-stock-menu').open
  }));
  if (!open.gen) await page.click('#menu-gen > summary');
  if (!open.stock) await page.click('#menu-gen .vp-stock-menu > summary');
};
/* A tile click; the id of the piece it dropped. */
const drop = async (page, shape) => {
  await openShelf(page);
  await page.click('#btn-stock-' + shape);
  return page.evaluate(() => state.models[state.models.length - 1].id);
};
const fresh = page => page.evaluate(() => {
  clearPlateOnly();
  state.models.length = 0; state.editId = null; state.selectedIndex = -1; state.undoStack.length = 0;
  renderModelList(); updateUndoBtn();
});

/* Open the Scale card and wait for it to read the selected piece - and, given
   a field, for that field's row to be on it (the card is showing the NEW
   piece's rows, not the last piece's). */
const scaleCard = async (page, field) => {
  await openMenuFor(page, '#scale-readout');
  await page.waitForFunction(f => {
    if (document.getElementById('scale-readout').dataset.stale !== '0') return false;
    if (!f) return true;
    const row = document.getElementById(f).closest('[id$="-row"]');
    return !!row && getComputedStyle(row).display !== 'none';
  }, field || null, { timeout: 30000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
};
/* Type a value into one of Scale's live fields and leave it with Tab, which is
   what commits it. Resolves once the piece's soup has changed. */
const scaleType = async (page, id, field, value) => {
  await scaleCard(page, field);
  const before = await shot(page, id);
  await openMenuFor(page, '#' + field);
  await page.focus('#' + field);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(value));
  await page.keyboard.press('Tab');
  await page.waitForFunction(([i, sum]) => {
    const m = state.models.find(x => x && x.id === i);
    let s = 0;
    for (let q = 0; q < m.rawTris.length; q++) s += Math.abs(m.rawTris[q]);
    return +s.toFixed(4) !== sum;
  }, [id, before.sum], { timeout: 30000 });
  await page.waitForTimeout(150);
  return before;
};

withApp(async (page, logs) => {
  await page.waitForTimeout(400);

  console.log('\n=== 1. a tile drops a block, selects it, and it is on the plate to be sized ===');
  let id = null, made = null;
  {
    id = await drop(page, 'box');
    made = await shot(page, id);
    check('one block on the plate', made.models === 1 && made.sceneChildren === 1,
      made.models + ' model(s), ' + made.sceneChildren + ' in the scene');
    check('28.453 mm cube, the default drop', Math.abs(made.size[0] - 28.4527) < 1e-3, JSON.stringify(made.size));
    check('it is SELECTED, and both halves of "selected" agree',
      made.editId === id && made.outlined === id, 'editId ' + made.editId + ', outlined ' + made.outlined);
    check('and it is the one undo step the drop made', made.undoTypes === 'addModels', '[' + made.undoTypes + ']');
  }

  console.log('\n=== 2. THE SCENARIO: move it, rotate it, then size it in Scale ===');
  let posed = null;
  {
    /* Move and rotate the way a person does - a drag across the plate and the
       yaw / tip buttons, through the app's own handlers. */
    await page.evaluate(i => {
      const k = state.placed.findIndex(p => p && p.sourceId === i);
      selectPlaced(k);
      applyPlacedXZ(state.placed[k], 40, -25);
    }, id);
    await page.evaluate(() => { const e = document.getElementById('btn-rot-right'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-rot-right');   /* yaw 90 */
    await page.evaluate(() => { const e = document.getElementById('btn-tilt-up'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-tilt-up');     /* pitch one step */
    posed = await shot(page, id);
    /* re-pinned (pose-bake): the yaw and the pitch are baked into the block's
       geometry when each press ends, so the pose is its BODY (nsoPieceBodyQ),
       not rotY. */
    check('the block has been moved and posed by hand',
      posed.x === 40 && posed.z === -25 && Math.abs(posed.body[3]) < 1 - 1e-6,
      'x ' + posed.x + ', z ' + posed.z + ', body ' + JSON.stringify(posed.body));

    /* pose-bake: the yaw and the pitch are baked into the block, so its raw
       axes no longer run along it. Scale reads it AS IT LIES (pieceFrame):
       Length and Width along the level long and short sides of its footprint,
       Height the plate vertical - all three rows, with those numbers, worked
       out here from the block's own vertices in the world. */
    await scaleCard(page, 'scale-height');
    const rows = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      p.mesh.updateMatrixWorld(true);
      const pos = p.mesh.geometry.attributes.position, pts = [];
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < pos.count; k++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(p.mesh.matrixWorld);
        pts.push([v.x, v.z]); lo = Math.min(lo, v.y); hi = Math.max(hi, v.y);
      }
      let best = null;                                   // the footprint: narrowest rectangle round the shadow
      for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
        const dx = pts[b][0] - pts[a][0], dz = pts[b][1] - pts[a][1], l = Math.hypot(dx, dz);
        if (l < 1e-6) continue;
        const d = [dx / l, dz / l], n = [-d[1], d[0]];
        const ext = u => { const t = pts.map(q => q[0] * u[0] + q[1] * u[1]); return Math.max(...t) - Math.min(...t); };
        const e1 = ext(d), e2 = ext(n);
        if (!best || e1 * e2 < best.area - 1e-9) best = { area: e1 * e2, L: Math.max(e1, e2), W: Math.min(e1, e2) };
      }
      const val = id => +document.getElementById(id).value;
      return { hidden: ['scale-length-row', 'scale-width-row', 'scale-height-row'].map(r => document.getElementById(r).hidden),
               shown: { L: val('scale-length'), W: val('scale-width'), H: val('scale-height') },
               want: { L: best.L, W: best.W, H: hi - lo } };
    }, id);
    check('a leaned block still shows Length, Width and Height', rows.hidden.every(h => !h), JSON.stringify(rows.hidden));
    check('...with the numbers as it lies: footprint long, footprint short, the vertical',
      Math.abs(rows.shown.L - rows.want.L) < 0.051 && Math.abs(rows.shown.W - rows.want.W) < 0.051 && Math.abs(rows.shown.H - rows.want.H) < 0.051,
      'shown ' + JSON.stringify(rows.shown) + ', as it lies ' + JSON.stringify({ L: +rows.want.L.toFixed(3), W: +rows.want.W.toFixed(3), H: +rows.want.H.toFixed(3) }));

    /* The adjustment: Height 28.453 -> 40, a Scale field, no button. */
    await scaleType(page, id, 'scale-height', 40);
    const after = await shot(page, id);
    console.log('   size ' + JSON.stringify(posed.size) + ' -> ' + JSON.stringify(after.size) + '   ' + after.status.slice(0, 90));

    check('the block really did change size', after.sum !== posed.sum && Math.abs(after.size[1] - posed.size[1]) > 1, JSON.stringify(after.size));
    check('NO second piece was spawned', after.models === 1 && after.sceneChildren === 1,
      after.models + ' model(s), ' + after.sceneChildren + ' in the scene');
    check('IDENTITY survives: same model id, same place in the list, same name',
      after.modelId === posed.modelId && after.modelIndex === posed.modelIndex && after.name === posed.name,
      'id ' + after.modelId + ', index ' + after.modelIndex + ', "' + after.name + '"');
    check('POSITION survives: same placed entry, same index, same x / z',
      after.placedIndex === posed.placedIndex && after.x === posed.x && after.z === posed.z,
      'placed[' + after.placedIndex + '] at x ' + after.x + ', z ' + after.z);
    check('ROTATION survives: yaw, tip and tilt all still on the piece (its body, baked)',
      JSON.stringify(after.body) === JSON.stringify(posed.body) &&
      after.rotY === posed.rotY && after.tipX === posed.tipX && after.tiltX === posed.tiltX && after.flipX === posed.flipX,
      'body ' + JSON.stringify(after.body));
    check('SELECTION survives, and both halves still agree',
      after.editId === id && after.outlined === id, 'editId ' + after.editId + ', outlined ' + after.outlined);

    /* Stated rather than hidden: the Mesh is rebuilt, exactly as it is for
       every other bake in this app. The PIECE is what is stable. */
    check('the THREE.Mesh is rebuilt, as NSO_sculptCommitRaw does for every bake',
      after.meshUuid !== posed.meshUuid, 'a new Mesh, in the same placed entry');
  }

  console.log('\n=== 3. every shape\'s own row edits the same piece ===');
  {
    /* A row per shape, and a value that is not the default. The cone has no
       dimension row of its own (Scale reads it as curved all over), so its
       whole-piece scale is what is driven. */
    const ROW = {
      box: ['scale-length', 40], cylinder: ['scale-rod-diameter', 40], sphere: ['scale-ell-a', 45],
      capsule: ['scale-cap-length', 70], ellipsoid: ['scale-ell-c', 60], torus: ['scale-torus-ring', 50],
      tube: ['scale-ring-outer', 50], cone: ['scale-factor', 1.5]
    };
    for (const sh of Object.keys(ROW)) {
      await fresh(page);
      const sid = await drop(page, sh);
      const was = await shot(page, sid);
      const tagged = await page.evaluate(i => { const m = state.models.find(x => x.id === i); return !!NSO_shapeTagOf(m.rawTris); }, sid);
      await scaleType(page, sid, ROW[sh][0], ROW[sh][1]);
      const now = await shot(page, sid);
      console.log('   ' + sh.padEnd(10) + ROW[sh][0].padEnd(20) + ROW[sh][1] + '   ' + JSON.stringify(was.size) + ' -> ' + JSON.stringify(now.size) + (tagged ? '   (tagged)' : ''));
      check(sh + ' ' + ROW[sh][0] + ' ' + ROW[sh][1] + ': the piece changed and it is still the same piece',
        now.sum !== was.sum && now.modelId === sid && now.models === 1 && now.sceneChildren === 1 &&
        now.placedIndex === was.placedIndex && now.x === was.x && now.z === was.z && now.editId === sid,
        now.tris + ' tris at x ' + now.x + ', z ' + now.z);
      /* one tag-carrying shape per row family: the rows that read the tag */
      if (['sphere', 'capsule', 'ellipsoid', 'torus'].includes(sh)) {
        check('  ...and a dropped ' + sh + ' arrived tagged, so its row read parameters, not a fit', tagged);
      }
    }
  }

  console.log('\n=== 4. one undo entry per size, one Undo puts the block back ===');
  {
    await fresh(page);
    const sid = await drop(page, 'box');
    const a = await shot(page, sid);
    await scaleType(page, sid, 'scale-width', 40);
    const b = await shot(page, sid);
    check('one Scale commit left ONE entry on top of the drop, not one per keystroke',
      b.undo === a.undo + 1 && /^addModels,/.test(b.undoTypes), '[' + b.undoTypes + ']');
    await page.click('#btn-undo');
    await page.waitForFunction(([i, sum]) => {
      const m = state.models.find(x => x && x.id === i);
      let s = 0;
      for (let q = 0; q < m.rawTris.length; q++) s += Math.abs(m.rawTris[q]);
      return +s.toFixed(4) === sum;
    }, [sid, a.sum], { timeout: 30000 });
    const c = await shot(page, sid);
    check('one Undo puts the block back as it was dropped',
      Math.abs(c.size[0] - a.size[0]) < 1e-3 && c.modelId === sid && c.models === 1, JSON.stringify(c.size) + ' vs ' + JSON.stringify(a.size));
    await page.click('#btn-undo');
    const d = await shot(page, sid);
    check('...and the next Undo takes the drop itself back off the plate', d === null && (await page.evaluate(() => state.placed.length)) === 0);
  }

  console.log('\n=== 5. NEGATIVE CONTROL - a tile click never edits the piece that was selected ===');
  {
    await fresh(page);
    const sid = await drop(page, 'cylinder');
    await scaleType(page, sid, 'scale-height', 50);
    const before = await shot(page, sid);
    const id2 = await drop(page, 'box');
    const after = await shot(page, sid);
    const b2 = await shot(page, id2);
    check('the cylinder is untouched by the next drop: same geometry, same place, same pose',
      after.sum === before.sum && after.tris === before.tris && after.x === before.x && after.z === before.z && after.rotY === before.rotY,
      'checksum ' + (after.sum === before.sum ? 'identical' : 'DRIFTED'));
    check('...and the box is a new piece, selected', b2.modelId === id2 && b2.models === 2 && b2.editId === id2 && b2.outlined === id2);
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  check('no console errors across the whole session', errs.length === 0,
    errs.slice(0, 3).map(e => e.slice(0, 120)).join(' | '));

  console.log('\n' + (fails ? 'FAILED ' + fails : 'PASSED') + '  (tools/nso_stock_live_test.js)');
  if (fails) process.exit(1);
});
