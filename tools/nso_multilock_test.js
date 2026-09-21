/* Multi-piece position lock and the plate lock, proven through the real
   controls.
     node tools/nso_multilock_test.js      exit 0 = every gate held

   The ticket behind this check came from live testing: "only one piece can be
   locked at a time, and there's no way to select/drag other pieces while one
   is locked". The audit answer is in section 1 - the flag was never
   one-at-a-time and the viewport was never frozen - so this file exists to
   PIN that, not to assert it, and to cover the two things that were actually
   missing: a plate-wide lock, and a repack that does not walk over a lock.

   What is pinned, on three box-20mm pieces A / B / C:

   1. AUDIT. Three pieces, locked one after another. Each lock lands on its
      own model object, the pieces not yet locked keep no tag and no outline,
      and after every lock the still-free pieces are selected by a REAL click
      and moved by a REAL 80 px drag. Orbit is measured on the plate before
      any lock, with one lock, with three, and straight after a refused drag:
      the camera moves every time, so nothing about a lock freezes the
      viewport.
   2. All three locked at once: three tags, three outlines, three refused
      drags, count reads 3, and each unlocks on its own without touching the
      others.
   3. THE PLATE LOCK is a different thing from three piece locks. With ONE
      piece locked, Lock plate refuses a drag on every piece including the two
      that carry no flag; `state.models.map(m => m.posLock)` is unchanged by
      locking AND by unlocking the plate; after Unlock plate the two free
      pieces drag again and the one locked piece still does not. Undo of a
      plate lock is its own entry and leaves the piece locks alone.
   4. PACKING AROUND A LOCK. Optimize plate with two pieces locked: the locked
      pieces keep their exact x/z and their exact mesh object, the free piece
      is repacked, nothing overlaps, and the status names the pieces that did
      not move. With the plate locked, Optimize is refused and nothing moves
      at all.
   5. The move surface under a plate lock is the same nine paths the piece
      lock gates - drag, nudge, Raise/Lower and the six pose buttons - each
      refused on an UNLOCKED piece, with no undo entry and the refusal named.
   6. Export is untouched: the STL is byte-identical with nothing locked,
      with pieces locked, and with the plate locked. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-multilock-'));

/* ---- in-page helpers ---- */
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });

const ADJ = ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-flip-over', 'btn-tip-face', 'btn-to-plate',
             'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn',
             'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back'];

/* Everything the two locks touch, for one piece, plus the plate-wide bits. */
const pose = (page, id) => page.evaluate(([id, ADJ]) => {
  const idx = state.placed.findIndex(p => p && p.sourceId === id);
  const p = state.placed[idx];
  const m = state.models.find(mm => mm.id === id);
  const row = document.querySelector(`#model-list .model-item[data-edit-id="${id}"]`);
  const btn = document.getElementById('btn-lock-pos');
  const pbtn = document.getElementById('btn-plate-lock');
  return {
    idx, x: p.x, z: p.z, liftY: p.liftY || 0, rotY: p.rotY || 0,
    tipX: p.tipX || 0, tipZ: p.tipZ || 0, tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0,
    mesh: p.mesh ? p.mesh.uuid : null,
    locked: !!m.posLock, acc: nsoPosLocked(m), held: nsoPosHeld(p),
    outline: !!(p.mesh && p.mesh.children.find(c => c.userData && c.userData.nsoLockOutline)),
    tag: !!(row && row.querySelector('.tag-locked')),
    plateLock: nsoPlateLocked(), count: nsoPosLockCount(),
    allLocks: state.models.map(x => !!x.posLock),
    btn: { disabled: btn.disabled, text: btn.textContent, pressed: btn.getAttribute('aria-pressed') },
    pbtn: { disabled: pbtn.disabled, text: pbtn.textContent, pressed: pbtn.getAttribute('aria-pressed') },
    listPlate: document.getElementById('model-list').classList.contains('is-plate-locked'),
    border: state.plateBorder ? state.plateBorder.material.color.getHex() : null,
    adjustDisabled: ADJ.map(i => document.getElementById(i).disabled),
    adjustStatus: (document.getElementById('adjust-status') || {}).textContent,
    selected: state.selectedIndex, undoDepth: state.undoStack.length,
    status: document.getElementById('status').textContent
  };
}, [id, ADJ]);
const POSE_KEYS = ['x', 'z', 'liftY', 'rotY', 'tipX', 'tipZ', 'tiltX', 'tiltZ'];
const same = (a, b, keys) => keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));

/* the piece's centre on screen, for a real mouse gesture */
const centreOf = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id);
  const v = new THREE.Vector3();
  p.mesh.getWorldPosition(v);
  v.project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height,
           inCanvas: v.x > -1 && v.x < 1 && v.y > -1 && v.y < 1 };
}, id);
async function dragPiece(page, id, dx, dy) {
  const c = await centreOf(page, id);
  if (!c.inCanvas) throw new Error('piece ' + id + ' is off screen at ' + JSON.stringify(c));
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}
async function clickPiece(page, id) {
  const c = await centreOf(page, id);
  if (!c.inCanvas) throw new Error('piece ' + id + ' is off screen');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
}
/* A real left-drag on a clear patch of plate, the gesture that orbits. */
async function orbitDelta(page) {
  const before = await page.evaluate(() => state.camera.position.toArray());
  const pt = await page.evaluate(() => {
    const r = state.renderer.domElement.getBoundingClientRect();
    for (let fy = 0.55; fy < 0.95; fy += 0.04) {
      for (let fx = 0.12; fx < 0.92; fx += 0.04) {
        const x = r.left + fx * r.width, y = r.top + fy * r.height;
        state.pointer.x = ((x - r.left) / r.width) * 2 - 1;
        state.pointer.y = -((y - r.top) / r.height) * 2 + 1;
        state.raycaster.setFromCamera(state.pointer, state.camera);
        const plate = [state.plateMesh, state.plateGrid, state.plateBorder].filter(Boolean);
        const onPlate = state.raycaster.intersectObjects(plate, false).length > 0;
        const onPiece = state.modelGroup && state.raycaster.intersectObjects(state.modelGroup.children, false).length > 0;
        if (onPlate && !onPiece) return { x, y };
      }
    }
    return null;
  });
  if (!pt) return -1;
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + 110, pt.y - 45, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const after = await page.evaluate(() => state.camera.position.toArray());
  return Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
}
/* the app's move primitive - what a viewport drag calls - NOT a click */
const moveTo = (page, id, x, z) => page.evaluate(([id, x, z]) => {
  const idx = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(idx);
  const p = state.placed[idx];
  nudgeSelected(x - p.x, z - p.z);
}, [id, x, z]);
const selectRow = (page, id) => page.click(`.model-item[data-edit-id="${id}"]`);
const lockPiece = async (page, id) => { await selectRow(page, id); await page.click('#btn-lock-pos'); };

async function exportPlate(page, label) {
  // export-format moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl')
  ]);
  // folded back: this check clicks the canvas, and an open panel
  // hangs over the top of the viewport where some of those land.
  await page.evaluate(() => document.querySelectorAll('.viewport-overlay-topbar details').forEach(d => { d.open = false; }));
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  return file;
}

withApp(async (page, logs) => {
  console.log('app: ' + page.url());

  console.log('\n=== 0. both toggles are on the page, and the two concepts are separate accessors ===');
  const mod = await page.evaluate(() => ({
    piece: typeof nsoPosLocked, placed: typeof nsoPosLockedPlaced, plate: typeof nsoPlateLocked,
    held: typeof nsoPosHeld, count: typeof nsoPosLockCount, set: typeof nsoPlateLockSet,
    btn: !!document.getElementById('btn-lock-pos'), pbtn: !!document.getElementById('btn-plate-lock'),
    pbtnDisabled: document.getElementById('btn-plate-lock').disabled,
    pbtnText: document.getElementById('btn-plate-lock').textContent,
    plateFlag: state.plateLock
  }));
  check('nsoPosLocked / nsoPlateLocked / nsoPosHeld / nsoPosLockCount / nsoPlateLockSet all exist',
    mod.piece === 'function' && mod.plate === 'function' && mod.held === 'function' &&
    mod.count === 'function' && mod.set === 'function', JSON.stringify(mod));
  check('both buttons are in the viewport bar; Lock plate starts disabled and unpressed',
    mod.btn && mod.pbtn && mod.pbtnDisabled === true && /Lock plate$/.test(mod.pbtnText), mod.pbtnText);
  check('state.plateLock starts false', mod.plateFlag === false, String(mod.plateFlag));

  const idA = await loadSTL(page, fx('box-20mm.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const idC = await loadSTL(page, fx('box-20mm.stl'));
  // three pieces well clear of one another, so a drag never magnets onto a neighbour
  await moveTo(page, idA, -55, -45);
  await moveTo(page, idB, 0, 0);
  await moveTo(page, idC, 55, 45);
  const NAMES = { [idA]: 'A', [idB]: 'B', [idC]: 'C' };

  console.log('\n=== 1. AUDIT: is the lock one-at-a-time, and does it freeze the viewport? ===');
  const orbit0 = await orbitDelta(page);
  check('orbit before any lock: a plate drag moves the camera', orbit0 > 1, f3(orbit0));

  const order = [[idA, 'A'], [idB, 'B'], [idC, 'C']];
  for (let k = 0; k < order.length; k++) {
    const [id, name] = order[k];
    await lockPiece(page, id);
    const s = await pose(page, id);
    check('lock ' + name + ': its own flag set, count now ' + (k + 1),
      s.locked && s.outline && s.tag && s.count === k + 1, 'count ' + s.count);
    // every piece NOT yet locked must still be free, selectable and draggable
    for (let j = k + 1; j < order.length; j++) {
      const [oid, oname] = order[j];
      const f0 = await pose(page, oid);
      check('  ' + oname + ' carries no flag of its own while ' + (k + 1) + ' other piece(s) are locked',
        !f0.locked && !f0.outline && !f0.tag && !f0.held);
      await clickPiece(page, oid);
      const f1 = await pose(page, oid);
      check('  ' + oname + ' is selected by a real click', f1.selected === f1.idx, 'selected ' + f1.selected);
      check('  ' + oname + "'s toolbar is live while other pieces are locked",
        f1.adjustDisabled.every(d => d === false) && !f1.btn.disabled && /Lock position$/.test(f1.btn.text), f1.btn.text);
      await clearStatus(page);
      await dragPiece(page, oid, 80, 0);
      const f2 = await pose(page, oid);
      const moved = Math.hypot(f2.x - f1.x, f2.z - f1.z);
      check('  ' + oname + ' is moved by a real 80 px drag: ' + f3(moved) + ' mm',
        moved > 1 && /^Moved model #\d+$/.test(f2.status), f2.status);
    }
    const orbitK = await orbitDelta(page);
    check('  orbit still works with ' + (k + 1) + ' piece(s) locked', orbitK > 1, f3(orbitK));
  }
  // and straight after a refusal
  await clearStatus(page);
  await dragPiece(page, idA, 70, 0);
  check('a refused drag on locked A names the refusal', /^Locked - drag refused/.test(await statusOf(page)), await statusOf(page));
  const orbitAfter = await orbitDelta(page);
  check('orbit still works immediately after a REFUSED drag', orbitAfter > 1, f3(orbitAfter));
  await clickPiece(page, idB);
  const bAfter = await pose(page, idB);
  check('B is still selectable immediately after a refused drag on A', bAfter.selected === bAfter.idx);

  console.log('\n=== 2. three locks at once, each independent ===');
  let a = await pose(page, idA), b = await pose(page, idB), c = await pose(page, idC);
  check('all three flags set, three tags, three outlines, count 3',
    JSON.stringify(a.allLocks) === '[true,true,true]' && a.outline && b.outline && c.outline &&
    a.tag && b.tag && c.tag && a.count === 3, JSON.stringify(a.allLocks) + ' count ' + a.count);
  for (const [id, name] of order) {
    await clearStatus(page);
    const p0 = await pose(page, id);
    await dragPiece(page, id, -70, 25);
    const p1 = await pose(page, id);
    check('drag on locked ' + name + ': unchanged, no undo, refusal named',
      same(p0, p1, POSE_KEYS) && p1.undoDepth === p0.undoDepth &&
      new RegExp('^Locked - drag refused on ').test(p1.status), p1.status);
  }
  // unlock the middle one only
  await lockPiece(page, idB);
  b = await pose(page, idB);
  check('unlocking B leaves A and C locked (count 2), B free',
    JSON.stringify(b.allLocks) === '[true,false,true]' && b.count === 2 && !b.outline && !b.tag,
    JSON.stringify(b.allLocks));
  const bm0 = await pose(page, idB);
  await dragPiece(page, idB, 60, 0);
  const bm1 = await pose(page, idB);
  check('  ...and B drags again between two locked neighbours',
    Math.hypot(bm1.x - bm0.x, bm1.z - bm0.z) > 1, f3(Math.hypot(bm1.x - bm0.x, bm1.z - bm0.z)));
  // back to exactly one lock for the plate-lock section
  await lockPiece(page, idC);
  const only = await pose(page, idA);
  check('down to one piece lock (A), count 1',
    JSON.stringify(only.allLocks) === '[true,false,false]' && only.count === 1, JSON.stringify(only.allLocks));

  console.log('\n=== 3. the plate lock: one action, all pieces, and NOT three piece locks ===');
  const beforePlate = (await pose(page, idA)).allLocks;
  const undoBefore = (await pose(page, idA)).undoDepth;
  await clearStatus(page);
  await page.click('#btn-plate-lock');
  await selectRow(page, idA);       // read the per-piece toggle against A's own flag
  a = await pose(page, idA); b = await pose(page, idB); c = await pose(page, idC);
  console.log('    status: ' + a.status);
  check('state.plateLock is on; one undo entry', a.plateLock && a.undoDepth === undoBefore + 1, a.undoDepth - undoBefore);
  check('it set NO per-piece flag - the flags are exactly what they were',
    JSON.stringify(a.allLocks) === JSON.stringify(beforePlate) && a.count === 1, JSON.stringify(a.allLocks));
  check('the two unflagged pieces are HELD without being locked',
    b.held && c.held && !b.locked && !c.locked && !b.tag && !c.tag && !b.outline && !c.outline);
  check('the button reads Unlock plate, aria-pressed true', /Unlock plate$/.test(a.pbtn.text) && a.pbtn.pressed === 'true', a.pbtn.text);
  check('the per-piece toggle is disabled, and still reports A\'s own flag',
    a.btn.disabled === true && /Unlock position$/.test(a.btn.text), a.btn.text);
  check('  ...and reports B\'s own flag as unset when B is selected',
    /Lock position$/.test((await (async () => { await selectRow(page, idB); return pose(page, idB); })()).btn.text));
  check('the plate border turned teal, the model list is marked held',
    a.border === 0x2dd4bf && a.listPlate, '0x' + (a.border || 0).toString(16));
  check('all 15 move/pose buttons greyed whatever is selected', (await pose(page, idB)).adjustDisabled.every(d => d));
  check('adjust-status says the plate is locked', /^Plate locked - 3 pieces held/.test((await pose(page, idB)).adjustStatus),
    (await pose(page, idB)).adjustStatus);
  check('status names the count, what is refused, and that the piece locks are untouched',
    /^Plate locked - all 3 pieces held in this arrangement/.test(a.status) &&
    /Optimize plate are refused on every piece/.test(a.status) &&
    /1 per-piece lock untouched underneath/.test(a.status), a.status);

  for (const [id, name] of order) {
    await clearStatus(page);
    const p0 = await pose(page, id);
    await dragPiece(page, id, -60, 30);
    const p1 = await pose(page, id);
    check('drag on ' + name + ' under the plate lock: unchanged, no undo, plate named',
      same(p0, p1, POSE_KEYS) && p1.undoDepth === p0.undoDepth &&
      /^Plate locked - drag refused on .* press Unlock plate to move anything$/.test(p1.status), p1.status);
  }
  // the per-piece toggle stands down rather than half-working
  await clearStatus(page);
  await page.evaluate(() => document.getElementById('btn-lock-pos').click());
  check('clicking the (disabled) per-piece toggle under a plate lock changes nothing',
    JSON.stringify((await pose(page, idA)).allLocks) === JSON.stringify(beforePlate));

  console.log('\n--- unlock the plate: the piece locks come back exactly as they were ---');
  await clearStatus(page);
  await page.click('#btn-plate-lock');
  a = await pose(page, idA); b = await pose(page, idB);
  console.log('    status: ' + a.status);
  check('plate lock off, piece flags identical to before it was ever on',
    !a.plateLock && JSON.stringify(a.allLocks) === JSON.stringify(beforePlate), JSON.stringify(a.allLocks));
  check('border back to plate cyan, list no longer marked', a.border === 0x38bdf8 && !a.listPlate, '0x' + (a.border || 0).toString(16));
  check('status says one piece is still locked on its own', /1 piece is still locked on their own/.test(a.status), a.status);
  const u0 = await pose(page, idB);
  await dragPiece(page, idB, 55, 0);
  const u1 = await pose(page, idB);
  check('the unflagged B drags again', Math.hypot(u1.x - u0.x, u1.z - u0.z) > 1, f3(Math.hypot(u1.x - u0.x, u1.z - u0.z)));
  await clearStatus(page);
  const l0 = await pose(page, idA);
  await dragPiece(page, idA, 55, 0);
  const l1 = await pose(page, idA);
  check('the still-locked A does not, and names its OWN lock, not the plate',
    same(l0, l1, POSE_KEYS) && /^Locked - drag refused/.test(l1.status), l1.status);

  console.log('\n--- undo of a plate lock is its own entry ---');
  await page.click('#btn-plate-lock');
  check('plate locked again', (await pose(page, idA)).plateLock);
  await page.click('#btn-undo');
  const un = await pose(page, idA);
  check('Undo clears the plate lock and leaves the piece locks alone',
    !un.plateLock && JSON.stringify(un.allLocks) === JSON.stringify(beforePlate) &&
    /^Undo: plate lock cleared/.test(un.status), un.status);

  console.log('\n=== 4. Optimize plate packs AROUND the locked pieces ===');
  await lockPiece(page, idC);           // A and C locked, B free
  const packLocks = (await pose(page, idA)).allLocks;
  check('going into the repack: A and C locked, B free', JSON.stringify(packLocks) === '[true,false,true]', JSON.stringify(packLocks));
  const pre = { a: await pose(page, idA), b: await pose(page, idB), c: await pose(page, idC) };
  await clearStatus(page);
  await page.click('#btn-optimize');
  await page.waitForFunction(() => !/^Optimizing/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const post = { a: await pose(page, idA), b: await pose(page, idB), c: await pose(page, idC) };
  console.log('    status: ' + post.a.status);
  check('the repack did not fail', !/failed/i.test(post.a.status), post.a.status);
  check('locked A kept its exact x/z AND its exact mesh object',
    post.a.x === pre.a.x && post.a.z === pre.a.z && post.a.mesh === pre.a.mesh,
    f3(pre.a.x) + ',' + f3(pre.a.z) + ' -> ' + f3(post.a.x) + ',' + f3(post.a.z));
  check('locked C kept its exact x/z AND its exact mesh object',
    post.c.x === pre.c.x && post.c.z === pre.c.z && post.c.mesh === pre.c.mesh,
    f3(pre.c.x) + ',' + f3(pre.c.z) + ' -> ' + f3(post.c.x) + ',' + f3(post.c.z));
  check('the free B was repacked (new mesh, new place)', post.b.mesh !== pre.b.mesh);
  check('both locks and both outlines survived the repack',
    post.a.locked && post.c.locked && post.a.outline && post.c.outline && post.a.count === 2, 'count ' + post.a.count);
  check('status names the pieces that did not move', /around 2 locked pieces, which did not move/.test(post.a.status), post.a.status);
  const overlap = await page.evaluate(() => {
    const fps = state.placed.map(p => placedFootprint(p));
    for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) {
      if (footprintsOverlap(fps[i], fps[j])) return [i, j];
    }
    return null;
  });
  check('no two pieces overlap after the repack', overlap === null, JSON.stringify(overlap));
  check('three pieces still on the plate, indices restamped',
    await page.evaluate(() => state.placed.length === 3 &&
      state.placed.every((p, i) => p.mesh && p.mesh.userData.placedIndex === i)));
  // and the repacked piece is still draggable, the locked ones still are not
  const rb0 = await pose(page, idB);
  await clickPiece(page, idB);
  await dragPiece(page, idB, 40, 0);
  const rb1 = await pose(page, idB);
  check('the repacked B still drags', Math.hypot(rb1.x - rb0.x, rb1.z - rb0.z) > 1, f3(Math.hypot(rb1.x - rb0.x, rb1.z - rb0.z)));

  console.log('\n--- and with the PLATE locked, Optimize is refused outright ---');
  await page.click('#btn-plate-lock');
  const snapBefore = await page.evaluate(() => state.placed.map(p => [p.x, p.z, p.mesh.uuid]));
  await clearStatus(page);
  await page.click('#btn-optimize');
  await page.waitForTimeout(600);
  const snapAfter = await page.evaluate(() => state.placed.map(p => [p.x, p.z, p.mesh.uuid]));
  check('Optimize under a plate lock: refused by name',
    /^Plate locked - Optimize refused/.test(await statusOf(page)), await statusOf(page));
  check('  ...and not one piece moved or was rebuilt', JSON.stringify(snapBefore) === JSON.stringify(snapAfter));
  check('  ...and the Optimize button is left usable', !(await page.evaluate(() => document.getElementById('btn-optimize').disabled)));

  console.log('\n=== 5. every gated path is refused on an UNLOCKED piece while the plate is locked ===');
  await selectRow(page, idB);           // B carries no flag of its own
  check('B selected and carries no flag of its own', !(await pose(page, idB)).locked);
  const attempts = [
    ['nudgeSelected(5, 0)', () => nudgeSelected(5, 0), /nudge refused/],
    ['liftSelected(1)  (Raise)', () => liftSelected(1), /raise\/lower refused/],
    ['liftSelected(-1) (Lower)', () => liftSelected(-1), /raise\/lower refused/],
    ['rotateSelected(1) (yaw 90)', () => rotateSelected(1), /yaw refused/],
    ['flipSelected() (Edge)', () => flipSelected(), /edge flip refused/],
    ['tipSelected() (Tip)', () => tipSelected(), /tip refused/],
    ['rollSelected() (Flat)', () => rollSelected(), /roll refused/],
    ['bankSelected(1) (Bank +)', () => bankSelected(1), /bank refused/],
    ['tiltSelected(1) (Pitch +)', () => tiltSelected(1), /pitch refused/]
  ];
  for (const [label, fn, re] of attempts) {
    await clearStatus(page);
    const p0 = await pose(page, idB);
    await page.evaluate('(' + fn.toString() + ')()');
    const p1 = await pose(page, idB);
    check(label + ' on the unflagged B: unchanged, no undo, "Plate locked" named',
      same(p0, p1, POSE_KEYS) && p1.undoDepth === p0.undoDepth &&
      /^Plate locked - /.test(p1.status) && re.test(p1.status), p1.status);
  }

  console.log('\n=== 6. neither lock reaches the exported file ===');
  await page.click('#btn-plate-lock');          // plate off
  await lockPiece(page, idA);                    // A off
  await lockPiece(page, idC);                    // C off
  check('nothing locked, plate free',
    JSON.stringify(await page.evaluate(() => [state.models.map(m => !!m.posLock), state.plateLock])) === '[[false,false,false],false]',
    JSON.stringify(await page.evaluate(() => [state.models.map(m => !!m.posLock), state.plateLock])));
  const stlFree = await exportPlate(page, 'free');
  await lockPiece(page, idA);
  await lockPiece(page, idB);
  await lockPiece(page, idC);
  check('all three pieces locked', (await pose(page, idA)).count === 3);
  const stlPieces = await exportPlate(page, 'pieces');
  await page.click('#btn-plate-lock');
  check('plate locked on top', (await pose(page, idA)).plateLock);
  const stlPlate = await exportPlate(page, 'plate');
  check('STL with three piece locks is byte-identical to the free export (' + fs.statSync(stlFree).size + ' bytes)',
    fs.readFileSync(stlFree).equals(fs.readFileSync(stlPieces)));
  check('STL with the plate locked too is byte-identical - neither lock is in the file',
    fs.readFileSync(stlFree).equals(fs.readFileSync(stlPlate)));
  check('export button still enabled with everything locked',
    !(await page.evaluate(() => document.getElementById('btn-export-stl').disabled)));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + out);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
