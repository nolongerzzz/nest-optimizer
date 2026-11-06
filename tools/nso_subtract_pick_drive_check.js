#!/usr/bin/env node
/* Subtract B from A picks its own A and B - no trip to the Join card.
     node tools/nso_subtract_pick_drive_check.js

   The run, as a person does it, with real clicks on the canvas:
     open Subtract -> press Subtract B from A -> click A -> click B
       -> move B into A by hand -> press Subtract B from A.

   GATES
     1. Pressing it with two pieces on the plate starts the picks: A is waited for,
        the button reads as armed, a line says what to click, and the Join card was
        never opened.
     2. Clicking A takes it and arms B with no second press; clicking B takes it.
     3. With both taken the line says to move B, and B can be dragged on the plate.
     4. The second press cuts: A is replaced, B is used up, one Undo puts both back,
        and the run is over (no session, nothing armed).
     5. Pressing it while it waits for a click stops the run and changes nothing.
     6. Shutting the card to nothing ends the run; shutting it for another column
        (Move, to put B in place) leaves it standing.
     7. One piece on the plate: refused in words, no run started.
     8. A and B already picked (the Join card's way, or a script's) are cut by the
        first press, as before.                                                    */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  if (!cond) fails++;
};

const HULL = path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl');
const BIT = path.join(ROOT, 'library', 'box_bit_12x8x8.stl');

/* Where a placed piece shows on the canvas, in page pixels. */
const screenOf = (page, sourceId, dx, dz) => page.evaluate(([id, ox, oz]) => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(p.mesh);
  const c = box.getCenter(new THREE.Vector3());
  c.x += ox || 0; c.z += oz || 0;
  c.project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
}, [sourceId, dx || 0, dz || 0]);

const snap = page => page.evaluate(() => ({
  session: !!state.joinSession, flow: !!state.subtractFlow, armed: state.joinArmed,
  a: state.editId, b: state.joinPartnerId,
  models: state.models.map(m => m.id),
  btnArmed: document.getElementById('btn-subtract').classList.contains('is-armed'),
  btnDisabled: document.getElementById('btn-subtract').disabled,
  line: (document.getElementById('subtract-readout') || {}).textContent,
  lineShown: !!document.getElementById('subtract-readout') && !document.getElementById('subtract-readout').hidden,
  joinCardOpen: !!document.getElementById('menu-joins').open,
  status: document.getElementById('status').textContent
}));

const openSubtract = page => page.evaluate(() => { document.getElementById('menu-bit').open = true; });
const press = page => page.evaluate(() => document.getElementById('btn-subtract').click());
const triCount = (page, id) => page.evaluate(i => { const g = state.models.find(m => m.id === i).geometry; return g.index ? g.index.count / 3 : g.attributes.position.count / 3; }, id);

(async () => {
  await withApp(async (page, logs) => {
    const hullId = await loadSTL(page, HULL);
    const bitId = await loadSTL(page, BIT);
    await page.evaluate(() => { document.getElementById('menu-bit').open = true; });
    await page.waitForTimeout(200);

    console.log('1. the press starts the picks');
    let s = await snap(page);
    check('idle: the button is not armed and not greyed, no line', !s.btnArmed && !s.btnDisabled && !s.lineShown, s);
    await press(page);
    s = await snap(page);
    check('A is waited for', s.session && s.flow && s.armed === 'a', s);
    check('the button reads as armed and a line says what to click', s.btnArmed && s.lineShown && /piece A/.test(s.line), s.line);
    check('the Join card was never opened', !s.joinCardOpen);

    console.log('2. click A, click B');
    const pa = await screenOf(page, hullId);
    await page.mouse.click(pa.x, pa.y);
    s = await snap(page);
    check('A is taken', s.a === hullId, s);
    check('B is armed with no second press', s.armed === 'b' && /piece B/.test(s.line), s);
    const pb = await screenOf(page, bitId);
    await page.mouse.click(pb.x, pb.y);
    s = await snap(page);
    check('B is taken and nothing is waiting for a click', s.b === bitId && s.armed === null, s);
    check('the line says to move B and press again', /Move B/.test(s.line) && !s.btnArmed, s.line);

    console.log('3. B is moved by hand');
    const before = await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); return { x: p.mesh.position.x, z: p.mesh.position.z }; }, bitId);
    const pb2 = await screenOf(page, bitId);
    await page.mouse.move(pb2.x, pb2.y);
    await page.mouse.down();
    await page.mouse.move(pb2.x + 25, pb2.y + 12, { steps: 6 });
    await page.mouse.up();
    const after = await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); return { x: p.mesh.position.x, z: p.mesh.position.z }; }, bitId);
    s = await snap(page);
    check('dragging B moves B', Math.hypot(after.x - before.x, after.z - before.z) > 1, { before, after });
    check('...and A and B are still the picks', s.a === hullId && s.b === bitId, s);

    console.log('4. the second press cuts');
    // Put B through A's +x face, as a person's drag would leave it.
    await page.evaluate(([aId, bId]) => {
      const pa = state.placed.find(q => q.sourceId === aId), pbb = state.placed.find(q => q.sourceId === bId);
      pa.mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(pa.mesh);
      const c = box.getCenter(new THREE.Vector3());
      pbb.mesh.position.set(box.max.x, box.min.y + 6, c.z);
      pbb.mesh.updateMatrixWorld(true);
    }, [hullId, bitId]);
    const trisBefore = await triCount(page, hullId);
    const undoBefore = await page.evaluate(() => state.undoStack ? state.undoStack.length : -1);
    await press(page);
    await page.waitForFunction(() => /^Subtract (ok|refused|failed|stopped)/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    s = await snap(page);
    const trisAfter = await triCount(page, hullId);
    check('the cut ran', /^Subtract ok/.test(s.status), s.status);
    check('A was replaced by the result', trisAfter !== trisBefore, { trisBefore, trisAfter });
    check('B is used up', !s.models.includes(bitId), s.models);
    check('the run is over', !s.session && !s.flow && s.armed === null && !s.lineShown, s);
    if (undoBefore >= 0) {
      const undoAfter = await page.evaluate(() => state.undoStack.length);
      check('one Undo entry', undoAfter === undoBefore + 1, { undoBefore, undoAfter });
    }
    await page.evaluate(() => document.getElementById('btn-undo') && document.getElementById('btn-undo').click());
    await page.waitForTimeout(300);
    s = await snap(page);
    check('Undo puts both pieces back', s.models.includes(bitId) && s.models.includes(hullId), s.models);

    console.log('5. pressing while it waits stops the run');
    await press(page);
    s = await snap(page);
    check('started again', s.session && s.flow && s.armed === 'a', s);
    await press(page);
    s = await snap(page);
    check('stopped, nothing changed', !s.session && !s.flow && s.armed === null && !s.lineShown && /stopped/.test(s.status), s);

    console.log('6. shutting the card');
    await press(page);
    await page.evaluate(() => { document.getElementById('menu-bit').open = false; });
    await page.waitForTimeout(150);
    s = await snap(page);
    check('shut to nothing: the run is over', !s.session && !s.flow, s);
    await openSubtract(page);
    await press(page);
    await page.evaluate(() => {
      document.getElementById('menu-bit').open = false;
      const other = document.querySelector('#menu-move') || document.querySelector('.vp-menu:not(#menu-bit):not(#menu-joins)');
      other.open = true;
    });
    await page.waitForTimeout(150);
    s = await snap(page);
    check('shut for another column: the run stands', s.session && s.flow, s);
    await page.evaluate(() => { document.querySelectorAll('.vp-menu[open]').forEach(d => { d.open = false; }); });
    await page.waitForTimeout(150);

    console.log('8. A and B already picked are cut by the first press');
    await openSubtract(page);
    s = await snap(page);
    check('no run left over', !s.session && !s.flow, s);
    await page.evaluate(([aId, bId]) => {
      state.editId = aId; state.joinPartnerId = bId;
      const pa = state.placed.find(q => q.sourceId === aId), pbb = state.placed.find(q => q.sourceId === bId);
      pa.mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(pa.mesh);
      const c = box.getCenter(new THREE.Vector3());
      pbb.mesh.position.set(box.max.x, box.min.y + 6, c.z);
      pbb.mesh.updateMatrixWorld(true);
    }, [hullId, bitId]);
    await press(page);
    await page.waitForFunction(() => /^Subtract (ok|refused|failed|stopped)/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    s = await snap(page);
    check('cut on the first press', /^Subtract ok/.test(s.status) && !s.models.includes(bitId), s.status);

    console.log('7. one piece on the plate');
    s = await snap(page);
    await press(page);
    s = await snap(page);
    check('refused in words, no run started', !s.session && !s.flow && /two pieces/.test(s.status), s.status);

    const errs = logs.filter(l => /^\[pageerror\]/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nevery check held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
