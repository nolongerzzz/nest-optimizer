/* Position lock (app-poslock.js), proven through the real controls.
     node tools/nso_poslock_test.js        exit 0 = every gate held

   What is pinned, on fixtures box_hull_80x40x20-2 (A), box-20mm (B) and a
   second box-20mm (C) that stays free:

   1. The flag is per piece, visible (list tag, teal outline on the mesh,
      button label, greyed move/pose buttons, adjust-status line), undoable,
      and set by nobody but the user.
   2. A locked piece refuses a REAL drag - Playwright's mouse pressed on the
      piece and pulled 80 px - and says so; the same gesture unlocked moves
      it (the control, or the refusal proves nothing), and Undo puts it back.
   3. The nudge primitive a drag calls, the arrow keys, Raise/Lower and every
      pose button leave a locked piece exactly where it is, push no undo
      entry, and name the refusal.
   4. Seat (support) on a LOCKED B still seats it (the user pressed Seat);
      Skin face on a LOCKED A still bakes it, and the lock and its outline
      survive the mesh swap. Then the drag is refused again with the seated
      relation intact.
   5. A clone of a locked piece starts unlocked.
   6. Export plate, STL and 3MF, with A and B locked and C free: the
      canonical checker sees three closed shells, 0 piercing, 0 coplanar,
      the 0.18 mm seat gap in the file; and the STL is byte-identical with
      everything unlocked and again with everything locked - the lock is
      not in the file. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-poslock-'));

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
function parseSTL(buf) {
  const n = buf.readUInt32LE(80), tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12, t = [];
    for (let k = 0; k < 3; k++) t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    tris.push(t);
  }
  return tris;
}
function edgeShells(tris) {
  const parent = tris.map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = v => v.map(c => Math.round(c * 1e4)).join('_');
  const owner = new Map();
  tris.forEach((t, i) => {
    const k = t.map(key);
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) union(owner.get(ek), i); else owner.set(ek, i);
    }
  });
  const g = new Map();
  tris.forEach((t, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(t); });
  return [...g.values()].map(list => {
    let zmin = Infinity, zmax = -Infinity;
    for (const t of list) for (const v of t) { if (v[2] < zmin) zmin = v[2]; if (v[2] > zmax) zmax = v[2]; }
    return { tris: list.length, zmin, zmax };
  }).sort((a, b) => a.zmin - b.zmin);
}

/* ---- in-page helpers ---- */
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });

const ADJ = ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-roll', 'btn-raise', 'btn-lower',
             'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn', 'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back'];
/* everything the lock touches, for one piece */
const pose = (page, id) => page.evaluate(([id, ADJ]) => {
  const idx = state.placed.findIndex(p => p && p.sourceId === id);
  const p = state.placed[idx];
  const m = state.models.find(mm => mm.id === id);
  const outline = p.mesh.children.find(c => c.userData && c.userData.nsoLockOutline);
  const btn = document.getElementById('btn-lock-pos');
  const row = document.querySelector(`#model-list .model-item[data-edit-id="${id}"]`);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return {
    idx, x: p.x, z: p.z, liftY: p.liftY || 0, rotY: p.rotY || 0, tipX: p.tipX || 0, tipZ: p.tipZ || 0, tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0,
    meshPos: p.mesh.position.toArray(), box: [bb.min.toArray(), bb.max.toArray()],
    locked: !!m.posLock, acc: nsoPosLocked(m), accPlaced: nsoPosLockedPlaced(p),
    outline: !!outline, outlineOnCurrentMesh: !!outline && outline.parent === p.mesh,
    tag: !!(row && row.querySelector('.tag-locked')), rowClass: row ? row.className : null,
    btn: { disabled: btn.disabled, text: btn.textContent, pressed: btn.getAttribute('aria-pressed'), cls: btn.className },
    adjustDisabled: ADJ.map(i => document.getElementById(i).disabled),
    adjustStatus: (document.getElementById('adjust-status') || {}).textContent,
    selected: state.selectedIndex, undoDepth: state.undoStack.length, rawTris: m.rawTris.length / 9,
    status: document.getElementById('status').textContent
  };
}, [id, ADJ]);
const same = (a, b, keys) => keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
const POSE_KEYS = ['x', 'z', 'liftY', 'rotY', 'tipX', 'tipZ', 'tiltX', 'tiltZ', 'meshPos', 'box'];

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
/* the app's move primitive - what a viewport drag calls - NOT a click */
async function moveTo(page, id, x, z) {
  await page.evaluate(([id, x, z]) => {
    const idx = state.placed.findIndex(p => p && p.sourceId === id);
    selectPlaced(idx);
    const p = state.placed[idx];
    nudgeSelected(x - p.x, z - p.z);
  }, [id, x, z]);
}
const selectRow = (page, id) => page.click(`.model-item[data-edit-id="${id}"]`);
async function exportPlate(page, format, label) {
  await page.selectOption('#export-format', format);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  check(label + ': "Export plate" (' + format.toUpperCase() + ') downloaded ' + download.suggestedFilename(),
    new RegExp('\\.' + format + '$').test(download.suggestedFilename()));
  return file;
}

withApp(async (page, logs) => {
  console.log('app: ' + page.url());
  console.log('\n=== 0. the module is on the page ===');
  const mod = await page.evaluate(() => ({
    acc: typeof nsoPosLocked, accP: typeof nsoPosLockedPlaced, gate: typeof nsoPosLockBlocks, set: typeof nsoPosLockSet, refresh: typeof nsoPosLockRefresh,
    btn: !!document.getElementById('btn-lock-pos'), disabled: document.getElementById('btn-lock-pos') && document.getElementById('btn-lock-pos').disabled,
    text: document.getElementById('btn-lock-pos') && document.getElementById('btn-lock-pos').textContent
  }));
  check('accessors, gate, setter, refresh and the button are all there', mod.acc === 'function' && mod.accP === 'function' && mod.gate === 'function' && mod.set === 'function' && mod.refresh === 'function' && mod.btn, JSON.stringify(mod));
  check('button disabled with nothing selected, reads "Lock position"', mod.disabled === true && /Lock position$/.test(mod.text), mod.text);

  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const idC = await loadSTL(page, fx('box-20mm.stl'));
  // C well clear of the pair so nothing magnets onto it later (the move
  // primitive, not a click; C is then left alone)
  await moveTo(page, idC, 0, 60);

  console.log('\n=== 1. per piece, visible, undoable ===');
  await selectRow(page, idB);
  let b = await pose(page, idB);
  check('B selected from the list: lock button enabled, unlocked label, no tag, no outline', b.selected === b.idx && !b.btn.disabled && /Lock position$/.test(b.btn.text) && !b.tag && !b.outline && !b.locked, JSON.stringify(b.btn));
  check('adjust buttons enabled for an unlocked selection', b.adjustDisabled.every(d => d === false), b.adjustDisabled.join(','));
  const undo0 = b.undoDepth;
  await page.click('#btn-lock-pos');
  b = await pose(page, idB);
  console.log('    status: ' + b.status);
  check('click Lock position: m.posLock true, both accessors agree', b.locked && b.acc && b.accPlaced);
  check('  list row carries the locked tag and class', b.tag && /is-locked/.test(b.rowClass), b.rowClass);
  check('  teal outline child sits on the piece\'s mesh', b.outline && b.outlineOnCurrentMesh);
  check('  button reads Unlock, aria-pressed true, is-locked class', /Unlock position$/.test(b.btn.text) && b.btn.pressed === 'true' && /is-locked/.test(b.btn.cls), JSON.stringify(b.btn));
  check('  all 15 move/pose buttons greyed', b.adjustDisabled.every(d => d === true), b.adjustDisabled.join(','));
  check('  adjust-status says Locked #' + (b.idx + 1), new RegExp('^Locked #' + (b.idx + 1)).test(b.adjustStatus), b.adjustStatus);
  check('  status line says what is refused and what still works', /^Locked position - box-20mm stays put/.test(b.status) && /Seat, Center, Align and Skin still work/.test(b.status), b.status);
  check('  one undo entry pushed', b.undoDepth === undo0 + 1, b.undoDepth - undo0);
  let a = await pose(page, idA), c = await pose(page, idC);
  check('A and C are NOT locked (per piece, not global)', !a.locked && !a.tag && !a.outline && !c.locked && !c.tag && !c.outline);
  await page.click('#btn-undo');
  b = await pose(page, idB);
  check('Undo clears the lock: flag, tag, outline, button all back', !b.locked && !b.tag && !b.outline && /Lock position$/.test(b.btn.text), b.status);
  check('  ...and the move/pose buttons come back', b.adjustDisabled.every(d => d === false));
  await page.click('#btn-lock-pos');
  b = await pose(page, idB);
  check('re-locked for the rest of the run', b.locked && b.outline);

  console.log('\n=== 2. a REAL drag on the locked piece (mouse down on it, pull 80 px) ===');
  await clearStatus(page);
  const before = await pose(page, idB);
  await dragPiece(page, idB, 80, 0);
  let after = await pose(page, idB);
  console.log('    status: ' + after.status);
  check('locked: every pose field and the world box unchanged', same(before, after, POSE_KEYS), JSON.stringify([before.x, before.z]) + ' -> ' + JSON.stringify([after.x, after.z]));
  check('locked: status names the refused drag and the way out', /^Locked - drag refused on box-20mm - press Unlock position to move it$/.test(after.status), after.status);
  check('locked: no undo entry pushed by the attempt', after.undoDepth === before.undoDepth);
  check('locked: the piece is still selectable (click selected it)', after.selected === after.idx, after.selected);
  check('locked: no move drag left armed', !(await page.evaluate(() => state.moveDragging)));
  // control: unlocked, the same gesture must move it
  await page.click('#btn-lock-pos');
  await clearStatus(page);
  const ctl0 = await pose(page, idB);
  await dragPiece(page, idB, 80, 0);
  const ctl1 = await pose(page, idB);
  console.log('    control: x ' + f3(ctl0.x) + ' -> ' + f3(ctl1.x) + ', z ' + f3(ctl0.z) + ' -> ' + f3(ctl1.z) + ', status: ' + ctl1.status);
  check('control, unlocked: the same drag moves the piece', Math.hypot(ctl1.x - ctl0.x, ctl1.z - ctl0.z) > 1, f3(Math.hypot(ctl1.x - ctl0.x, ctl1.z - ctl0.z)) + ' mm');
  check('control: status reports the move', /^Moved model #\d+$/.test(ctl1.status), ctl1.status);
  check('control: one undo entry pushed', ctl1.undoDepth === ctl0.undoDepth + 1);
  await page.click('#btn-undo');
  const ctl2 = await pose(page, idB);
  check('Undo puts it back exactly', near(ctl2.x, ctl0.x, 1e-9) && near(ctl2.z, ctl0.z, 1e-9), ctl2.x + ',' + ctl2.z);
  await page.click('#btn-lock-pos');
  b = await pose(page, idB);
  check('locked again', b.locked && b.outline);

  console.log('\n=== 3. nudge primitive, arrow keys, Raise/Lower, every pose button - all refused ===');
  const attempts = [
    ['nudgeSelected(5, 0)', () => nudgeSelected(5, 0), /nudge refused/],
    ['nudgeSelected(0, -5)', () => nudgeSelected(0, -5), /nudge refused/],
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
    check(label + ': unchanged, no undo, refusal named', same(p0, p1, POSE_KEYS) && p1.undoDepth === p0.undoDepth && re.test(p1.status), p1.status);
  }
  await clearStatus(page);
  const k0 = await pose(page, idB);
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) await page.keyboard.press(key);
  const k1 = await pose(page, idB);
  check('arrow keys with the locked piece selected: unchanged, no undo (the app binds no nudge keys; pinned as a no-op)', same(k0, k1, POSE_KEYS) && k1.undoDepth === k0.undoDepth, k1.status || '(no status)');
  const btnState = await page.evaluate(ADJ => ADJ.map(i => document.getElementById(i).disabled), ADJ);
  check('the 15 toolbar buttons are all disabled while the locked piece is selected', btnState.every(d => d), btnState.join(','));
  const selA = (await (async () => { await selectRow(page, idA); return pose(page, idA); })());
  check('selecting unlocked A re-enables the toolbar and the button reads Lock position', selA.adjustDisabled.every(d => !d) && /Lock position$/.test(selA.btn.text) && !selA.btn.disabled);

  console.log('\n=== 4. Seat (support) on a LOCKED B, Skin face on a LOCKED A: not blocked; lock survives ===');
  await selectRow(page, idB);
  await page.click('#btn-lock-pos');          // unlock B to stage it (the lock refuses the move, as it should)
  b = await pose(page, idB);
  check('B unlocked for staging', !b.locked);
  await page.click('#btn-join-start');
  await page.click('#join-slot-a');
  await selectRow(page, idA);
  await page.click('#join-slot-b');
  await selectRow(page, idB);
  const j = await page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
  check('Join session holds A / B', j.session && j.a === idA && j.b === idB, JSON.stringify(j));
  a = await pose(page, idA);
  await moveTo(page, idB, a.x, a.z);
  for (let i = 0; i < 11; i++) await page.click('#btn-raise');
  b = await pose(page, idB);
  check('B staged over A, lifted 22', near(b.x, a.x, 1e-9) && near(b.z, a.z, 1e-9) && near(b.liftY, 22, 1e-9), b.liftY);
  await page.click('#btn-lock-pos');          // B selected (the Raise clicks kept it) -> lock it
  b = await pose(page, idB);
  check('B locked before Seat', b.locked && b.outline && b.selected === b.idx);
  await page.fill('#seat-gap', '-0.18');
  await clearStatus(page);
  await page.click('#btn-seat-support');
  await waitStatus(page, /^Seated|^Seat /);
  b = await pose(page, idB); a = await pose(page, idA);
  console.log('    status: ' + b.status);
  check('Seat (support) seated the LOCKED B: air gap 0.18', /^Seated - air gap 0\.18mm \(measured -0\.180mm, skin error 0\.00mm\)$/.test(b.status), b.status);
  check('  B moved to the seat: liftY 20.18, underside 0.18 above A (2e-6)', near(b.liftY, 20.18, 2e-6) && near(b.box[0][1] - a.box[1][1], 0.18, 2e-6), b.liftY + ' / ' + (b.box[0][1] - a.box[1][1]));
  check('  B is still locked, outline still on its mesh', b.locked && b.outline && b.outlineOnCurrentMesh);
  // Skin A while A is locked
  await selectRow(page, idA);
  await page.click('#btn-lock-pos');
  a = await pose(page, idA);
  check('A locked (both now locked, C free)', a.locked && a.outline && a.rawTris === 28);
  await openFinishMenu(page);   // Skin face lives in the Finish tab
  await page.selectOption('#skin-pattern', 'crosshatch');
  await clearStatus(page);
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  const a2 = await pose(page, idA);
  console.log('    status: ' + a2.status);
  check('Skin face baked the LOCKED A: crosshatch, tips +0.60', /^Skinned \+Z face - crosshatch lattice.*tips \+0\.60mm/.test(a2.status) && a2.rawTris > 1000, a2.rawTris);
  check('  A\'s x/z untouched by the bake', near(a2.x, a.x, 1e-12) && near(a2.z, a.z, 1e-12));
  check('  lock survived the mesh swap, outline re-attached to the NEW mesh', a2.locked && a2.outline && a2.outlineOnCurrentMesh);
  check('  list tag still there, button still reads Unlock', a2.tag && /Unlock position$/.test(a2.btn.text));
  await page.fill('#seat-gap', '-0.18');
  await page.click('#btn-seat-support');
  await waitStatus(page, /^Seated|^Seat /);
  b = await pose(page, idB); a = await pose(page, idA);
  console.log('    status: ' + b.status);
  check('Seat (support) again, B locked, A locked and skinned: 0.18 off the tips, relief 0.60', /from skin tips, relief 0\.60mm/.test(b.status) && near(b.liftY, 20.78, 2e-6) && near(b.box[0][1] - a.box[1][1], 0.18, 2e-6), b.liftY);
  await page.click('#btn-join-clear');
  // and a stray drag on each locked piece after all that still does nothing
  for (const [id, name] of [[idB, 'B'], [idA, 'A']]) {
    await clearStatus(page);
    const p0 = await pose(page, id);
    await dragPiece(page, id, -70, 30);
    const p1 = await pose(page, id);
    check('drag on locked ' + name + ' after Seat/Skin: refused, pose unchanged', same(p0, p1, POSE_KEYS) && /^Locked - drag refused/.test(p1.status), p1.status);
  }
  b = await pose(page, idB); a = await pose(page, idA);
  check('the seated relation is intact: 0.18 above the tips', near(b.box[0][1] - a.box[1][1], 0.18, 2e-6), b.box[0][1] - a.box[1][1]);

  console.log('\n=== 5. a clone of a locked piece starts unlocked ===');
  await selectRow(page, idB);
  const nModels = await page.evaluate(() => state.models.length);
  await page.click('#btn-clone');
  await page.waitForFunction(n => state.models.length === n + 1, nModels, { timeout: 20000 });
  const clone = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    const p = state.placed.find(q => q && q.sourceId === m.id);
    return { name: m.name, locked: !!m.posLock, outline: !!p.mesh.children.find(c => c.userData && c.userData.nsoLockOutline),
             tag: !!document.querySelector(`#model-list .model-item[data-edit-id="${m.id}"] .tag-locked`),
             lockedCount: state.models.filter(x => x.posLock).length };
  });
  check('clone "' + clone.name + '" is unlocked, no tag, no outline; still exactly two locked pieces', !clone.locked && !clone.outline && !clone.tag && clone.lockedCount === 2, JSON.stringify(clone));
  await page.click('#btn-undo');
  check('Undo removes the clone (back to three pieces)', (await page.evaluate(() => state.placed.length)) === 3);

  console.log('\n=== 6. Export plate with A and B locked, C free ===');
  const lockedNow = await page.evaluate(() => state.models.map(m => !!m.posLock));
  check('lock state going into the export: A locked, B locked, C free', JSON.stringify(lockedNow) === '[true,true,false]', JSON.stringify(lockedNow));
  const stlMixed = await exportPlate(page, 'stl', 'mixed');
  const v = meshValidate(stlMixed);
  const sh = edgeShells(parseSTL(fs.readFileSync(stlMixed)));
  console.log('    mesh_validate: tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', euler ' + v.euler_characteristic +
    ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar + ', bbox ' + JSON.stringify(v.bbox_size) + ', shells ' + sh.length);
  check('mixed export: 0 open, 0 non-manifold, Euler 6 (three closed shells), 0 piercing, 0 coplanar',
    v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 6 && v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0);
  check('mixed export: three edge-connected shells', sh.length === 3, sh.length);
  if (sh.length === 3) {
    const hull = sh.find(s => s.tris > 1000), bit = sh.filter(s => s.tris === 12).find(s => s.zmin > 1), free = sh.filter(s => s.tris === 12).find(s => s.zmin < 1);
    check('mixed export: skinned hull 20.6 tall on z 0, free cube on z 0', hull && near(hull.zmin, 0, 1e-5) && near(hull.zmax, 20.6, 1e-5) && free && near(free.zmin, 0, 1e-5), JSON.stringify(sh));
    check('mixed export: locked B 0.18 above the locked A\'s tips (1e-5)', hull && bit && near(bit.zmin - hull.zmax, 0.18, 1e-5), bit ? (bit.zmin - hull.zmax).toFixed(6) : 'no bit');
  }
  const mfMixed = await exportPlate(page, '3mf', 'mixed');
  const xml = execFileSync('unzip', ['-p', mfMixed, '3D/3dmodel.model'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  check('mixed 3MF: three objects', (xml.match(/<object /g) || []).length === 3);
  const stillLocked = await page.evaluate(() => state.models.map(m => !!m.posLock));
  check('exporting changed no lock', JSON.stringify(stillLocked) === JSON.stringify(lockedNow));
  // unlock both, export again: byte-identical
  await selectRow(page, idA); await page.click('#btn-lock-pos');
  await selectRow(page, idB); await page.click('#btn-lock-pos');
  check('everything unlocked', JSON.stringify(await page.evaluate(() => state.models.map(m => !!m.posLock))) === '[false,false,false]');
  const stlNone = await exportPlate(page, 'stl', 'none-locked');
  check('STL with nothing locked is byte-identical to the mixed export (' + fs.statSync(stlMixed).size + ' bytes)', fs.readFileSync(stlMixed).equals(fs.readFileSync(stlNone)));
  await selectRow(page, idA); await page.click('#btn-lock-pos');
  await selectRow(page, idB); await page.click('#btn-lock-pos');
  await selectRow(page, idC); await page.click('#btn-lock-pos');
  check('everything locked', JSON.stringify(await page.evaluate(() => state.models.map(m => !!m.posLock))) === '[true,true,true]');
  const stlAll = await exportPlate(page, 'stl', 'all-locked');
  check('STL with everything locked is byte-identical too - the lock is not in the file', fs.readFileSync(stlMixed).equals(fs.readFileSync(stlAll)));
  check('export button still enabled with every piece locked', !(await page.evaluate(() => document.getElementById('btn-export-stl').disabled)));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + out);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
