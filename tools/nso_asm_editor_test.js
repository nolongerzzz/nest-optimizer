/* The assembly editor (app-asm-editor.js, docs/ASSEMBLE-EDITOR.md), through the
   real app and real clicks.
     node tools/nso_asm_editor_test.js        exit 0 = every gate held

   Hull = fixtures/box_hull_80x40x20-2.stl, bit = fixtures/box-20mm.stl,
   pip = fixtures/hinge_pip.stl (18 x 16 x 8, a real mesh, not a box).
   Every pick is a pixel: the check asks the editor where a world point on a
   piece is on the screen (NSO_AsmEditor.screenOf) and clicks there, the way a
   person does. Nothing is set in the editor's state behind its back.

   What is pinned:
   1. The card: one Assemble column, Open editor on top, the Join, Seat and
      Align cards as its three sections, their controls id for id; the three
      old columns are gone. Opening the column starts the Join session.
   2. Opening the editor moves nothing: every piece on the plate is === as it
      was, the undo stack is as deep as it was.
   3. Two clicks: the face to attach, then where it goes. The ghost is there
      on the hover, before the second click. After it the ghost sits face to
      face, touching, kept inside the face - a click by a corner lands flush
      in that corner - and the plate has still not moved.
   4. The pad: centre is the centre, the four corner cells are the four
      corners, flush on both edges. Where I clicked goes back. A nudge is its
      step. Four quarter turns come back round.
   5. Place with a gap: the bit ends 0.18 mm above the hull (2e-6), the seat
      is recorded, Weld is off while there is an air gap, and ONE Undo puts
      the bit back === where it was.
   6. Weld into one: one piece where there were two, a real union - through
      tools/mesh_validate.py --json: one closed shell, 0 open, 0 non-manifold,
      0 piercing, volume = hull + bit. ONE Undo puts both pieces back, raw
      triangles value for value (the hull on Join's own Undo baseline).
   7. A mate that turns the piece: the hull attached by a side face is turned a
      quarter and baked into its own axes; one Undo restores its triangles.
      Then a real mesh (the pip), by the face it rests on, welded: the checker
      passes the union.
   8. A mate that would hang under the plate raises the piece it goes on by
      exactly what is needed, and says so; one Undo restores both.
   9. Escape steps back one pick at a time and then returns; the plate's own
      shortcuts do not act while the editor is open. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

/* ---- in-page helpers ---- */
const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  if (!p) return null;
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const m = state.models.find(x => x.id === id);
  let h = 0;
  for (let i = 0; i < m.rawTris.length; i++) h = (h * 31 + Math.round(m.rawTris[i] * 1e4)) | 0;
  return { x: p.x, z: p.z, liftY: p.liftY || 0, pos: p.mesh.position.toArray(), quat: p.mesh.quaternion.toArray(),
           min: bb.min.toArray(), max: bb.max.toArray(), raw: h, tris: m.rawTris.length / 9, seat: p.seat || null };
}, id);
const samePose = (p, q) => !!p && !!q && JSON.stringify([p.x, p.z, p.liftY, p.pos, p.quat, p.min, p.max, p.raw]) ===
                                         JSON.stringify([q.x, q.z, q.liftY, q.pos, q.quat, q.min, q.max, q.raw]);
const plate = async (page, ids) => { const o = {}; for (const id of ids) o[id] = await pose(page, id); return o; };
const samePlate = (a, b) => Object.keys(a).every(k => samePose(a[k], b[k]));
const info = page => page.evaluate(() => NSO_AsmEditor.info());
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const edStatus = page => page.evaluate(() => document.getElementById('asm-ed-status').textContent);
const appStatus = page => page.evaluate(() => document.getElementById('status').textContent);
const view = (page, dir) => page.evaluate(d => NSO_AsmEditor.view(d), dir);
const ABOVE = [-0.5, 1, 0.7], BELOW = [-0.3, -1, 0.5];
async function at(page, id, pt) { return page.evaluate(([i, p]) => NSO_AsmEditor.screenOf(i, p), [id, pt]); }
async function hover(page, id, pt) { const s = await at(page, id, pt); await page.mouse.move(s.x, s.y); await page.waitForTimeout(120); }
async function click(page, id, pt) { const s = await at(page, id, pt); await page.mouse.move(s.x, s.y); await page.waitForTimeout(120); await page.mouse.click(s.x, s.y); await page.waitForTimeout(120); }
const idle = page => page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 90000 });
/* the ghost's box: the part's box through the mate */
const ghostBox = (page, id) => page.evaluate(id => {
  const i = NSO_AsmEditor.info();
  const p = state.placed.find(q => q && q.sourceId === id);
  p.mesh.updateMatrixWorld(true);
  const soup = meshToWorldSoup(p.mesh), M = new THREE.Matrix4().fromArray(i.solution.matrix), v = new THREE.Vector3();
  const bb = new THREE.Box3();
  for (let k = 0; k < soup.length; k += 3) bb.expandByPoint(v.set(soup[k], soup[k + 1], soup[k + 2]).applyMatrix4(M));
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, id);
/* one piece's own triangles as a binary STL, base64 */
const rawStl = id => {
  const m = state.models.find(x => x.id === id), s = m.rawTris, n = s.length / 9;
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + t * 50 + 12 + k * 4, s[t * 9 + k], true);
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let q = 0; q < bytes.length; q += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(q, q + 0x8000));
  return btoa(bin);
};
const centre = (p, y) => [(p.min[0] + p.max[0]) / 2, y, (p.min[2] + p.max[2]) / 2];

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-asm-editor-'));
  const shots = path.join(ROOT, 'tools', 'asm-editor-out');
  fs.mkdirSync(shots, { recursive: true });
  const hullVol = meshValidate(fx('box_hull_80x40x20-2.stl')).signed_volume;
  const bitVol = meshValidate(fx('box-20mm.stl')).signed_volume;
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const idC = await loadSTL(page, fx('hinge_pip.stl'));
  const ids = [idA, idB, idC];
  /* settle every piece on the bed baseline, as any move does, so "as it was" has one meaning */
  await page.evaluate(() => state.placed.forEach(p => applyPlacedXZ(p, p.x, p.z)));

  /* ---------- 1. the card ---------- */
  console.log('\n--- 1. the Assemble card ---');
  const card = await page.evaluate(() => {
    const menu = document.getElementById('menu-assemble');
    const inSec = (id, sec) => { const el = document.getElementById(id); return !!el && !!el.closest('#' + sec); };
    return {
      column: !!menu && menu.matches('.vp-col-menu') && menu.querySelector('summary').textContent.trim(),
      gone: ['menu-joins', 'menu-seat', 'menu-align'].filter(id => document.getElementById(id)),
      open: !!document.getElementById('btn-asm-open'),
      join: ['join-slot-a', 'join-slot-b', 'join-slot-c', 'btn-join', 'btn-join-clear', 'join-gap-ab', 'join-horizontal'].every(id => inSec(id, 'asm-sec-join')),
      seat: ['btn-seat-support', 'seat-gap', 'btn-seat-here', 'chk-oversize-washer', 'btn-seat-flush', 'btn-flip-port', 'btn-seat-grid'].every(id => inSec(id, 'asm-sec-seat')),
      align: ['btn-join-align', 'btn-join-cx', 'btn-join-cz', 'btn-center-lock', 'btn-center-lock-pick', 'center-lock-ref'].every(id => inSec(id, 'asm-sec-align'))
    };
  });
  check('one Assemble column', card.column === 'Assemble', String(card.column));
  check('the Join, Seat and Align columns are gone', card.gone.length === 0, card.gone.join(','));
  check('Open editor is on the card', card.open);
  check('Join by slots holds the Join card\'s controls, id for id', card.join);
  check('Seat holds the Seat card\'s controls, id for id', card.seat);
  check('Align holds the Align card\'s controls, id for id', card.align);
  await page.click('#menu-assemble > summary');
  await page.waitForFunction(() => state.joinSession === true, null, { timeout: 5000 });
  check('opening the column starts the Join session', true);
  await page.screenshot({ path: path.join(shots, '1-card.png') });

  /* ---------- 2. opening moves nothing ---------- */
  console.log('\n--- 2. Open editor ---');
  const before = await plate(page, ids);
  const depth0 = await undoDepth(page);
  await page.click('#btn-asm-open');
  await page.waitForFunction(() => NSO_AsmEditor.isOpen(), null, { timeout: 5000 });
  let i = await info(page);
  check('the editor is open at step 1 with every piece on its stage', i.step === 'part' && ids.every(id => i.pieces.includes(id)), JSON.stringify(i.pieces));
  const cover = await page.evaluate(() => {
    const r = document.getElementById('asm-editor').getBoundingClientRect();
    const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return { full: r.width >= innerWidth && r.height >= innerHeight, top: !!el && !!el.closest('#asm-editor'),
             session: state.joinSession, menu: document.getElementById('menu-assemble').open };
  });
  check('it covers the whole app: the plate is not in sight', cover.full && cover.top);
  check('the card is shut and its Join session ended', cover.session === false && cover.menu === false, JSON.stringify(cover));
  check('nothing on the plate moved', samePlate(before, await plate(page, ids)));
  check('the undo stack is as deep as it was', (await undoDepth(page)) === depth0);
  await page.screenshot({ path: path.join(shots, '2-open.png') });

  /* ---------- 3. two clicks ---------- */
  console.log('\n--- 3. click the face to attach, click where it goes ---');
  const a = before[idA], b = before[idB];
  await view(page, BELOW);
  await click(page, idB, centre(b, b.min[1]));
  i = await info(page);
  check('click 1 on the bit\'s underside: that face is the one to attach', i.step === 'target' && i.part && i.part.id === idB && i.part.normal[1] < -0.99, JSON.stringify(i.part));
  await view(page, ABOVE);
  const corner = [a.min[0] + 3, a.max[1], a.min[2] + 3];
  await hover(page, idA, corner);
  i = await info(page);
  check('the ghost is drawn on the hover, before the second click', i.step === 'target' && i.ghost === true);
  await page.screenshot({ path: path.join(shots, '3-hover-ghost.png') });
  await click(page, idA, corner);
  i = await info(page);
  check('click 2 on the hull\'s top: step 3, only the hull and the ghost in sight',
    i.step === 'adjust' && i.target && i.target.id === idA && i.target.normal[1] > 0.99 && JSON.stringify(i.visible) === JSON.stringify([idA]) && i.ghost, JSON.stringify(i.visible));
  let g = await ghostBox(page, idB);
  check('the ghost sits on the hull\'s top, touching (1e-6)', near(g.min[1], a.max[1], 1e-6), g.min[1] - a.max[1]);
  check('a click by the corner lands flush in that corner (1e-6)', near(g.min[0], a.min[0], 1e-6) && near(g.min[2], a.min[2], 1e-6), JSON.stringify(g.min));
  check('no turn was needed', near(i.solution.turnDeg, 0, 1e-6), i.solution.turnDeg);
  check('the faces share the bit\'s whole 20 x 20', near(i.solution.contactU, 20, 1e-4) && near(i.solution.contactV, 20, 1e-4) && !i.solution.overhang);
  check('the plate has still not moved', samePlate(before, await plate(page, ids)) && (await undoDepth(page)) === depth0);
  const clicked = g;
  await page.screenshot({ path: path.join(shots, '3-adjust.png') });

  /* ---------- 4. the pad, nudge, turn ---------- */
  console.log('\n--- 4. the pad, the nudge, the quarter turn ---');
  const cell = (c, r) => `.asm-pad-cell[data-col="${c}"][data-row="${r}"]`;
  await page.click(cell(0, 0));
  g = await ghostBox(page, idB);
  check('centre cell: centred on the hull\'s top (1e-6)',
    near((g.min[0] + g.max[0]) / 2, (a.min[0] + a.max[0]) / 2, 1e-6) && near((g.min[2] + g.max[2]) / 2, (a.min[2] + a.max[2]) / 2, 1e-6));
  check('the centre cell is lit', await page.evaluate(sel => document.querySelector(sel).classList.contains('is-on'), cell(0, 0)));
  const reached = new Set();
  for (const [c, r] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    await page.click(cell(c, r));
    g = await ghostBox(page, idB);
    const fx0 = near(g.min[0], a.min[0], 1e-6) ? 'x-' : (near(g.max[0], a.max[0], 1e-6) ? 'x+' : '?');
    const fz0 = near(g.min[2], a.min[2], 1e-6) ? 'z-' : (near(g.max[2], a.max[2], 1e-6) ? 'z+' : '?');
    reached.add(fx0 + fz0);
  }
  check('the four corner cells are the four corners, flush on both edges', reached.size === 4 && ![...reached].some(k => k.includes('?')), [...reached].join(' '));
  await page.click(cell(1, 0));
  g = await ghostBox(page, idB);
  const midEdge = (near(g.min[0], a.min[0], 1e-6) || near(g.max[0], a.max[0], 1e-6)) !== (near(g.min[2], a.min[2], 1e-6) || near(g.max[2], a.max[2], 1e-6));
  check('an edge cell is flush with one edge and centred along it', midEdge, JSON.stringify([g.min, g.max]));
  const edge = g;
  await page.click('.asm-nudge-btn[data-dx="1"]');
  g = await ghostBox(page, idB);
  const moved = Math.hypot(g.min[0] - edge.min[0], g.min[2] - edge.min[2]);
  check('a nudge moves it one step (1 mm) along the face, not off it', near(moved, 1, 1e-6) && near(g.min[1], edge.min[1], 1e-9), moved);
  await page.click('#asm-pos-click');
  g = await ghostBox(page, idB);
  check('Where I clicked goes back to the clicked place', near(g.min[0], clicked.min[0], 1e-6) && near(g.min[2], clicked.min[2], 1e-6));
  const m0 = (await info(page)).solution.matrix;
  await page.click('#asm-spin-r');
  const m1 = (await info(page)).solution;
  check('a quarter turn is 90 degrees about the face', near(m1.turnDeg, 90, 1e-4), m1.turnDeg);
  for (let k = 0; k < 3; k++) await page.click('#asm-spin-r');
  const m4 = (await info(page)).solution.matrix;
  check('four quarter turns come back round (1e-6)', m0.every((v, k) => near(v, m4[k], 1e-6)));
  check('and the plate has still not moved', samePlate(before, await plate(page, ids)) && (await undoDepth(page)) === depth0);

  /* ---------- 5. Place with a gap ---------- */
  console.log('\n--- 5. gap on, Place ---');
  await page.check('#asm-gap-on');
  i = await info(page);
  check('gap on: the slider\'s -0.18, and the ghost stands off by it', i.solution.gap === -0.18 && near((await ghostBox(page, idB)).min[1] - a.max[1], 0.18, 1e-6));
  check('Weld is off while there is an air gap', await page.evaluate(() => document.getElementById('asm-weld').disabled));
  await page.click('#asm-place');
  await idle(page);
  let bb = await pose(page, idB);
  console.log('  editor: ' + await edStatus(page));
  check('the bit is 0.18 mm above the hull (2e-6)', near(bb.min[1] - a.max[1], 0.18, 2e-6), bb.min[1] - a.max[1]);
  check('flush in the clicked corner on the plate (2e-6)', near(bb.min[0], a.min[0], 2e-6) && near(bb.min[2], a.min[2], 2e-6), JSON.stringify(bb.min));
  check('liftY is hull-relative: 20.18 (2e-6)', near(bb.liftY, 20.18, 2e-6), bb.liftY);
  check('the seat is recorded on the bit at -0.18', bb.seat && bb.seat.gap === -0.18 && bb.seat.kind === 'support', JSON.stringify(bb.seat));
  check('the hull did not move', samePose(a, await pose(page, idA)));
  check('one press, one Undo entry', (await undoDepth(page)) === depth0 + 1, await undoDepth(page));
  i = await info(page);
  check('the editor is back at step 1 for the next piece', i.step === 'part' && i.part === null && i.pieces.length === 3);
  await page.click('#asm-undo');
  check('one Undo puts the bit back === where it was', samePlate(before, await plate(page, ids)) && (await undoDepth(page)) === depth0);

  /* ---------- 6. Weld into one ---------- */
  console.log('\n--- 6. Weld into one ---');
  await view(page, ABOVE);
  await click(page, idB, centre(b, b.max[1]));
  i = await info(page);
  check('click 1 on the bit\'s top: Use its underside is offered', i.part.normal[1] > 0.99 && await page.evaluate(() => !document.getElementById('asm-underside').hidden));
  await page.click('#asm-underside');
  i = await info(page);
  check('Use its underside: the face it rests on, without turning the view', i.step === 'target' && i.part.id === idB && i.part.normal[1] < -0.99);
  await click(page, idA, centre(a, a.max[1]));
  await page.click(cell(0, 0));
  check('the gap setting was kept from the last piece', await page.evaluate(() => document.getElementById('asm-gap-on').checked));
  await page.uncheck('#asm-gap-on');
  check('gap off: Weld is on', await page.evaluate(() => !document.getElementById('asm-weld').disabled));
  await page.click('#asm-weld');
  await idle(page);
  console.log('  editor: ' + await edStatus(page));
  i = await info(page);
  check('welded', i.last && i.last.welded === true && i.last.ok === true, JSON.stringify(i.last));
  const after = await page.evaluate(() => ({ models: state.models.length, placed: state.placed.filter(p => p && p.mesh).length }));
  check('one piece where there were two', after.models === 2 && after.placed === 2 && (await pose(page, idB)) === null, JSON.stringify(after));
  check('one press, one Undo entry', (await undoDepth(page)) === depth0 + 1, await undoDepth(page));
  const w = await pose(page, idA);
  check('the piece is the hull with the bit on top: 40 tall, the hull\'s footprint (1e-4)',
    near(w.max[1] - w.min[1], 40, 1e-4) && near(w.max[0] - w.min[0], 80, 1e-4) && near(w.max[2] - w.min[2], 40, 1e-4), JSON.stringify([w.min, w.max]));
  check('and it stands where the hull stood (1e-4)', near(w.min[0], a.min[0], 1e-4) && near(w.min[2], a.min[2], 1e-4), JSON.stringify(w.min));
  /* the welded piece alone, through the canonical checker */
  const stl = path.join(tmp, 'welded.stl');
  fs.writeFileSync(stl, Buffer.from(await page.evaluate(rawStl, idA), 'base64'));
  const v = meshValidate(stl);
  check('canonical checker: closed, manifold, one solid (chi 2)', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2,
    `open ${v.open_edges}, nm ${v.nonmanifold_edges}, chi ${v.euler_characteristic}`);
  check('canonical checker: nothing pierces, nothing coplanar, nothing degenerate',
    v.degenerate_tris === 0 && v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0, JSON.stringify(v.self_intersection));
  check('volume = hull + bit (0.01)', near(v.signed_volume, hullVol + bitVol, 0.01), v.signed_volume + ' vs ' + (hullVol + bitVol));
  await page.screenshot({ path: path.join(shots, '6-welded.png') });
  await page.click('#asm-return');
  check('Return closes the editor', (await info(page)).open === false && await page.evaluate(() => document.getElementById('asm-editor').hidden));
  check('the app\'s status says what was done', /^Assemble: .* welded onto /.test(await appStatus(page)), await appStatus(page));
  await page.screenshot({ path: path.join(shots, '6-plate.png') });
  await page.click('#btn-undo');
  /* Join's own Undo puts A back on the ingest baseline (y + 0.3) where a settled
     piece rests on 0.2 - as it does after the Join card's JOIN. Everything else
     is exact; the next move re-settles it, which is what the check does here. */
  let now = await plate(page, ids);
  const aBack = now[idA];
  check('ONE Undo puts both pieces back: the bit === , the hull\'s triangles value for value',
    (await undoDepth(page)) === depth0 && samePose(before[idB], now[idB]) && samePose(before[idC], now[idC]) &&
    aBack.raw === a.raw && aBack.x === a.x && aBack.z === a.z && aBack.liftY === a.liftY && JSON.stringify(aBack.quat) === JSON.stringify(a.quat) &&
    near(aBack.pos[1] - a.pos[1], 0.1, 1e-9), JSON.stringify(aBack));
  await page.evaluate(() => state.placed.forEach(p => applyPlacedXZ(p, p.x, p.z)));
  check('settled again, the plate is === as it began', samePlate(before, await plate(page, ids)));

  /* ---------- 7. a mate that turns the piece ---------- */
  console.log('\n--- 7. the hull by a side face, stood on the bit; then a real mesh welded ---');
  const c = before[idC];
  await page.click('#btn-asm-open');
  await page.waitForFunction(() => NSO_AsmEditor.isOpen());
  await view(page, ABOVE);
  await click(page, idA, [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2, a.max[2]]);
  i = await info(page);
  check('click 1 on the hull\'s +Z side face', i.step === 'target' && i.part.id === idA && i.part.normal[2] > 0.99, JSON.stringify(i.part));
  await click(page, idB, centre(b, b.max[1]));
  await page.click(cell(0, 0));
  i = await info(page);
  check('the mate turns it a quarter', near(i.solution.turnDeg, 90, 1e-4), i.solution.turnDeg);
  check('the readout says it hangs over the edge', i.solution.overhang === true && /hangs over/.test(await page.evaluate(() => document.getElementById('asm-ed-readout').textContent)));
  await page.click('#asm-place');
  await idle(page);
  const a7 = await pose(page, idA);
  console.log('  editor: ' + await edStatus(page));
  check('the hull stands on what was its side: 40 tall now (1e-4)', near(a7.max[1] - a7.min[1], 40, 1e-4), a7.max[1] - a7.min[1]);
  check('on the bit\'s top, touching (2e-6), centred over it (1e-4)',
    near(a7.min[1], b.max[1], 2e-6) && near((a7.min[0] + a7.max[0]) / 2, (b.min[0] + b.max[0]) / 2, 1e-4) && near((a7.min[2] + a7.max[2]) / 2, (b.min[2] + b.max[2]) / 2, 1e-4), JSON.stringify(a7.min));
  check('the turn is baked into its own triangles: the pose fields are as they were', a7.raw !== a.raw && JSON.stringify(a7.quat) === JSON.stringify(a.quat));
  check('one press, one Undo entry', (await undoDepth(page)) === depth0 + 1);
  await page.click('#asm-undo');
  check('one Undo restores the hull, triangles value for value', samePlate(before, await plate(page, ids)));
  /* the pip: a real mesh, by the face it rests on */
  const pipVol = meshValidate(fx('hinge_pip.stl')).signed_volume;
  await view(page, ABOVE);
  await click(page, idC, centre(c, c.max[1]));
  if (!(await page.evaluate(() => document.getElementById('asm-underside').hidden))) await page.click('#asm-underside');
  i = await info(page);
  check('the pip by its underside', i.step === 'target' && i.part.id === idC && i.part.normal[1] < -0.98, JSON.stringify(i.part));
  await click(page, idA, centre(a, a.max[1]));
  await page.click('#asm-weld');
  await idle(page);
  console.log('  editor: ' + await edStatus(page));
  i = await info(page);
  check('the pip is welded onto the hull', i.last && i.last.welded === true, JSON.stringify(i.last));
  const stl7 = path.join(tmp, 'welded-pip.stl');
  fs.writeFileSync(stl7, Buffer.from(await page.evaluate(rawStl, idA), 'base64'));
  const v7 = meshValidate(stl7);
  check('canonical checker: closed, manifold, one solid, nothing pierces',
    v7.open_edges === 0 && v7.nonmanifold_edges === 0 && v7.self_intersection.pierce === 0, `open ${v7.open_edges}, nm ${v7.nonmanifold_edges}, pierce ${v7.self_intersection.pierce}, chi ${v7.euler_characteristic}`);
  check('volume = hull + pip (0.05)', near(v7.signed_volume, hullVol + pipVol, 0.05), v7.signed_volume + ' vs ' + (hullVol + pipVol));
  await page.click('#asm-undo');
  await page.click('#asm-return');
  await page.evaluate(() => state.placed.forEach(p => applyPlacedXZ(p, p.x, p.z)));
  check('one Undo, and (settled) the plate is as it began', samePlate(before, await plate(page, ids)) && (await undoDepth(page)) === depth0);
  await page.click('#btn-asm-open');
  await page.waitForFunction(() => NSO_AsmEditor.isOpen());

  /* ---------- 8. a mate that would hang under the plate ---------- */
  console.log('\n--- 8. the hull, by its underside, on the bit\'s side face ---');
  await view(page, BELOW);
  await click(page, idA, centre(a, a.min[1]));
  await view(page, [1, 0.4, 0.3]);
  await click(page, idB, [b.max[0], (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]);
  i = await info(page);
  check('the hull\'s underside onto the bit\'s +X face', i.step === 'adjust' && i.part.id === idA && i.target.id === idB && i.target.normal[0] > 0.99, JSON.stringify(i.target));
  g = await ghostBox(page, idA);
  check('as mated the hull would hang under the plate', g.min[1] < 0.2 - 1, g.min[1]);
  await page.click('#asm-place');
  await idle(page);
  const st8 = await edStatus(page);
  console.log('  editor: ' + st8);
  const a8 = await pose(page, idA), b8 = await pose(page, idB);
  check('the bit was raised by exactly what was needed, and the status says so', near(b8.liftY, 0.2 - g.min[1], 2e-6) && /raised/.test(st8), b8.liftY + ' vs ' + (0.2 - g.min[1]));
  check('the hull rests on the plate, against the bit\'s face (2e-6)', near(a8.min[1], 0.2, 2e-6) && near(a8.min[0], b8.max[0], 2e-6), JSON.stringify(a8.min));
  check('still one Undo entry', (await undoDepth(page)) === depth0 + 1);
  await page.click('#asm-undo');
  check('one Undo restores both', samePlate(before, await plate(page, ids)) && (await undoDepth(page)) === depth0);

  /* ---------- 9. Escape, and the plate's shortcuts ---------- */
  console.log('\n--- 9. Escape and the keys ---');
  await view(page, ABOVE);
  await click(page, idB, centre(b, b.max[1]));
  await click(page, idA, centre(a, a.max[1]));
  check('picked through to step 3', (await info(page)).step === 'adjust');
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); }, idC);
  await page.keyboard.press('Delete');
  check('Delete does not reach the plate while the editor is open', (await page.evaluate(() => state.models.length)) === 3);
  await page.keyboard.press('Escape');
  check('Escape: back to step 2', (await info(page)).step === 'target');
  await page.keyboard.press('Escape');
  check('Escape: back to step 1', (await info(page)).step === 'part');
  await page.keyboard.press('Escape');
  check('Escape: returned to the plate', (await info(page)).open === false);
  check('and through all of it the plate is === as it began', samePlate(before, await plate(page, ids)) && (await undoDepth(page)) === depth0);

  const errs = logs.filter(l => l.startsWith('[pageerror]') || /^\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('ASM EDITOR TEST FAIL', e); process.exit(1); });
