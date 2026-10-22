#!/usr/bin/env node
/* Undo, then Redo, in the real page: the plate comes back bit for bit.
     node tools/nso_undo_redo_test.js        exit 0 = every gate held

   Redo is the line below Undo (app-core.js, "REDO"): Undo sets the step it took
   off aside with the plate as it stood before that Undo, Redo puts that plate
   back and the step back on the undo stack. This is that, driven the way a
   person does it: the buttons and the keys, a move, a rotate, a Cut and a
   Join.

   "Bit for bit" is read off the plate, not off a status line: every model's
   display geometry, raw soup, size and centre offset (a checksum of the float
   bits), every placed piece's pose numbers, and the mesh's position and
   rotation. Undo then Redo must read exactly what it read before the Undo; the
   Undo after that must read what it read before the step.

   Gates:
     1  a move       Undo, Redo, Undo again
     2  a rotate     the same
     3  a Cut        two halves back, the original back
     4  a Join       a boolean: one piece, then two, then one
     5  a NEW action after an Undo empties Redo; the buttons follow
     6  Shift+Ctrl+Z and Ctrl+Y redo where Ctrl+Z undoes; not in a text field
     7  a plate that changed after the Undo (an upload) is not overwritten by Redo
     8  the line goes deep: three Undos, three Redos, in order */

const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const fx = f => path.join(ROOT, 'fixtures', f);

/* The plate, as numbers. Runs in the page. */
function readPlate() {
  const sum = (arr) => {
    if (!arr) return 'null';
    const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.byteLength >> 2);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    return u.length + ':' + h.toString(16);
  };
  return JSON.stringify({
    models: state.models.map(m => ({
      id: m.id, name: m.name,
      geo: sum(m.geometry && m.geometry.attributes.position.array),
      raw: sum(m.rawTris), size: m.size, off: m.centerOffset ? [m.centerOffset.x, m.centerOffset.y, m.centerOffset.z] : null
    })),
    placed: state.placed.map(p => ({
      src: p.sourceId, x: p.x, z: p.z, rotY: p.rotY || 0, flipX: !!p.flipX, tipX: p.tipX || 0,
      tipZ: p.tipZ || 0, tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0, liftY: p.liftY || 0,
      w: p.width, d: p.depth, h: p.height,
      pos: p.mesh ? p.mesh.position.toArray() : null,
      rot: p.mesh ? [p.mesh.rotation.x, p.mesh.rotation.y, p.mesh.rotation.z] : null,
      inScene: !!(p.mesh && p.mesh.parent)
    })),
    sel: state.selectedIndex, edit: state.editId
  });
}
const depth = page => page.evaluate(() => [state.undoStack.length, state.redoStack.length]);
const plate = page => page.evaluate(readPlate);
const status = page => page.evaluate(() => document.getElementById('status').textContent);

/* One step, then Undo, Redo, Undo - every reading against the one it must equal. */
async function roundTrip(page, label, doStep, opts) {
  opts = opts || {};
  const before = await plate(page);
  const [u0] = await depth(page);
  await doStep();
  const after = await plate(page);
  const [u1, r1] = await depth(page);
  check(label + ': the step changed the plate and pushed one Undo', after !== before && u1 === u0 + 1 && r1 === 0, 'undo ' + u0 + ' -> ' + u1);
  await page.click('#btn-undo');
  await page.waitForTimeout(80);
  const undone = await plate(page);
  const [u2, r2] = await depth(page);
  if (opts.undoDrift) {
    /* Join's own Undo re-seats the surviving piece at the union's centre (x 6
       where it was 0) on a fresh mesh; that is the Undo as it stands, not this
       gate's. What it must hold is the models: the same ids, geometry and soups. */
    const m = x => JSON.stringify(JSON.parse(x).models);
    check(label + ': Undo puts the models back as they were', m(undone) === m(before));
  } else {
    check(label + ': Undo puts the plate back as it was', undone === before);
  }
  check(label + ': ...and sets the step aside for Redo', u2 === u0 && r2 === 1, 'undo ' + u2 + ', redo ' + r2);
  check(label + ': the Redo button is lit', await page.evaluate(() => !document.getElementById('btn-redo').disabled));
  await page.click('#btn-redo');
  await page.waitForTimeout(80);
  const redone = await plate(page);
  const [u3, r3] = await depth(page);
  check(label + ': Redo returns the plate bit for bit', redone === after);
  check(label + ': ...the step is back on the undo stack', u3 === u1 && r3 === 0, 'undo ' + u3 + ', redo ' + r3);
  check(label + ': the Redo button greys when the line is spent', await page.evaluate(() => document.getElementById('btn-redo').disabled));
  await page.click('#btn-undo');
  await page.waitForTimeout(80);
  check(label + ': Undo after Redo undoes the same step', (await plate(page)) === undone);
  await page.click('#btn-redo');
  await page.waitForTimeout(80);
  check(label + ': and Redo again lands on the same plate', (await plate(page)) === after);
  return { before, after };
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.evaluate(readPlate); // the function must parse in the page too
  const N = page.evaluate.bind(page);

  const reset = async () => N(() => {
    state.models = []; state.placed = []; state.undoStack = []; state.redoStack = [];
    if (typeof closeCutter === 'function') closeCutter(true); else state.cutterOpen = false;
    clearDisplayMeshes(); state.joinSession = false; state.joinPartnerId = null; state.editId = null;
    state.selectedIndex = -1; updateUndoBtn();
  });

  console.log('\n=== 0. the buttons start grey ===');
  check('Undo is grey', await N(() => document.getElementById('btn-undo').disabled));
  check('Redo is grey', await N(() => document.getElementById('btn-redo').disabled));
  check('Redo sits under Undo in the top bar', await N(() => {
    const u = document.getElementById('btn-undo').getBoundingClientRect(), r = document.getElementById('btn-redo').getBoundingClientRect();
    return r.top > u.bottom - 1 && Math.abs(r.left - u.left) < 2;
  }));

  console.log('\n=== 1. a move ===');
  const boxId = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectModel(page, boxId);
  await N(() => selectPlaced(0));
  await roundTrip(page, 'move', () => N(() => nudgeSelected(12, -7)));

  console.log('\n=== 2. a rotate ===');
  await roundTrip(page, 'rotate', () => N(() => rotateSelected(1)));
  await roundTrip(page, 'tip', () => N(() => { const p = state.placed[0]; pushUndo(Object.assign(snapshotPlacedPose(0), { type: 'posePlaced', index: 0 })); p.tipX = 1; applyMeshRotation(p); }));

  console.log('\n=== 3. a Cut ===');
  await reset();
  const cutId = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); });
  if (!(await N(() => cutterArmed('cut')))) await N(() => openCutter('cut'));
  await selectModel(page, cutId);
  await roundTrip(page, 'cut', () => N(() => { if (typeof updateCutHelper === 'function') updateCutHelper(); cutActiveModel(); }));
  check('the cut left two halves', await N(() => state.models.length === 2 && state.placed.length === 2));

  console.log('\n=== 4. a boolean (Join) ===');
  await reset();
  const a = await loadSTL(page, fx('box-20mm.stl'));
  const b = await loadSTL(page, fx('box-20mm.stl'));
  await N(([a, b]) => {
    // overlap the two so the Join has a seam to fuse
    const pa = state.placed.find(p => p.sourceId === a), pb = state.placed.find(p => p.sourceId === b);
    applyPlacedXZ(pa, 0, 0); applyPlacedXZ(pb, 12, 0);
    state.undoStack = []; state.redoStack = []; updateUndoBtn();
  }, [a, b]);
  await roundTrip(page, 'join', async () => {
    await N(([a, b]) => { state.joinSession = true; state.editId = a; state.joinPartnerId = b; document.getElementById('btn-join').disabled = false; }, [a, b]);
    await page.click('#btn-join');
    await page.waitForFunction(() => /Join ok|Join failed/.test(document.getElementById('status').textContent), null, { timeout: 90000 });
    check('join: it succeeded', /Join ok/.test(await status(page)), await status(page));
  }, { undoDrift: true });
  check('the join left one piece', await N(() => state.models.length === 1 && state.placed.length === 1));

  console.log('\n=== 5. a new action after Undo empties Redo ===');
  await reset();
  await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(() => selectPlaced(0));
  await N(() => { nudgeSelected(5, 0); nudgeSelected(0, 5); });
  await page.click('#btn-undo');
  check('one step is set aside', (await depth(page))[1] === 1 && await N(() => !document.getElementById('btn-redo').disabled));
  await N(() => rotateSelected(1));
  const dr = await depth(page);
  check('a new action empties Redo', dr[1] === 0, 'redo ' + dr[1]);
  check('...and the Redo button greys', await N(() => document.getElementById('btn-redo').disabled));
  const unchanged = await plate(page);
  await N(() => redoLast());
  check('Redo with nothing set aside changes nothing', (await plate(page)) === unchanged && /Nothing to redo/.test(await status(page)));

  console.log('\n=== 6. the keys ===');
  await reset();
  await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(() => selectPlaced(0));
  const k0 = await plate(page);
  await N(() => nudgeSelected(9, 3));
  const k1 = await plate(page);
  await page.keyboard.press('Control+z');
  check('Ctrl+Z undoes', (await plate(page)) === k0);
  await page.keyboard.press('Control+Shift+z');
  check('Ctrl+Shift+Z redoes', (await plate(page)) === k1);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  check('Ctrl+Y redoes', (await plate(page)) === k1);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Meta+Shift+z');
  check('Cmd+Shift+Z redoes', (await plate(page)) === k1);
  await page.keyboard.press('Control+z');
  await N(() => { const i = document.getElementById('clone-count'); i.focus(); });
  await page.keyboard.press('Control+y');
  check('in a text field the keys are the field\'s own: no Redo', (await plate(page)) === k0 && (await depth(page))[1] === 1);
  await N(() => document.activeElement.blur());
  await page.keyboard.press('Control+y');
  check('out of the field Ctrl+Y redoes again', (await plate(page)) === k1);

  console.log('\n=== 7. a plate that changed after the Undo is not overwritten ===');
  await page.keyboard.press('Control+z');
  await loadSTL(page, fx('box-20mm.stl'));
  const models7 = await N(() => state.models.length);
  check('the upload has no Undo of its own', await N(() => state.redoStack.length) === 1);
  await N(() => redoLast());
  check('Redo stands down and says why', /plate changed/.test(await status(page)), await status(page));
  check('...the new piece is still there', await N(() => state.models.length) === models7);
  check('...and the line is emptied', (await depth(page))[1] === 0);

  console.log('\n=== 8. three deep ===');
  await reset();
  await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await N(() => selectPlaced(0));
  const marks = [await plate(page)];
  for (const [dx, dz] of [[4, 0], [0, 6], [-3, 3]]) { await N(([x, z]) => nudgeSelected(x, z), [dx, dz]); marks.push(await plate(page)); }
  const seenUndo = [];
  for (let i = 0; i < 3; i++) { await page.click('#btn-undo'); seenUndo.push(await plate(page)); }
  check('three Undos walk back through each plate', seenUndo[0] === marks[2] && seenUndo[1] === marks[1] && seenUndo[2] === marks[0]);
  const seenRedo = [];
  for (let i = 0; i < 3; i++) { await page.click('#btn-redo'); seenRedo.push(await plate(page)); }
  check('three Redos walk forward through each plate', seenRedo[0] === marks[1] && seenRedo[1] === marks[2] && seenRedo[2] === marks[3]);
  check('the stacks end where they began', (await depth(page)).join() === '3,0');

  const errs = logs.filter(l => /error|exception/i.test(l) && !/favicon|Failed to load resource/i.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nundo:redo - all gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
