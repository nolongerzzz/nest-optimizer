/* nso_cut_plate_drive_check.js - the Cut card's WHOLE PLATE blade, driven through the real app (index.html + every
   app-*.js) in real Chromium.
     node tools/nso_cut_plate_drive_check.js        exit 0 = every gate held

   THE ASK. "Uniformly shorten an entire plate of pieces, to make print testing go faster - shorten the pillar on all
   pieces. A cut plate option: one big blade on a vertical slider, in Cut."

   The plate: three pieces - a T (5 mm pillar + slab, 14 tall), a standing tube (12 tall), a stub (4 tall) - and, for
   the gates that need it, a fourth, the T lifted 20 mm.

   GATES
     1. The Blade row has a fourth button, Whole plate. Pressing it shows the Height slider, Keep above / Keep below
        and a readout; the per-piece dials, slider and readout stand down; the per-piece blade is gone and a level
        blade (a helper, never exported) stands across the plate at the slider's height and moves with it.
     2. The slider runs from 1 mm to the tallest piece less 1; the readout counts the pieces the blade crosses and
        names the ones it leaves.
     3. A real click on a piece picks it and does NOT drop the per-piece blade or start a drag.
     4. Keep above at 4: every piece the blade crosses is exactly 4 mm shorter (world box), sits on the plate, has not
        moved in x or z, is one closed piece (0 open, 0 non-manifold more than before); the stub is left alone; the
        press is ONE Undo, Undo gives every piece back vertex for vertex, Redo cuts it again.
     5. Keep below at 6 keeps the feet: the blade's height is the new height.
     6. A piece standing 20 mm up is passed under; one the blade crosses is cut at ITS foot + the height.
     7. A turned piece (tipped on its side) is set first and then cut level in the WORLD, in the same Undo.
     8. Painted faces stand the press down, naming the piece, and change nothing.
     9. Other blades are untouched: Full blade still splits one piece into two; leaving Whole plate puts the per-piece
        controls back; closing the card takes the blade away.                                                       */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');
const { tee, tube, writeSTL } = require('./nso_cut_plate_pieces');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.02 : tol);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cut-plate-'));
const FILES = {
  tee: writeSTL(path.join(TMP, 'tee.stl'), tee(10, 4)),
  tube: writeSTL(path.join(TMP, 'tube.stl'), tube(12, 32)),
  stub: writeSTL(path.join(TMP, 'stub.stl'), tee(2, 2))
};

/* what the plate looks like: per piece, its world box height and foot, the centre of its box in x / z, its raw
   triangle count, its checker census and its raw soup's checksum */
const snap = page => page.evaluate(() => state.models.map(m => {
  const p = state.placed.find(q => q.sourceId === m.id);
  p.mesh.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(p.mesh);
  const r = NSO_Repair.inspect(m.rawTris, { selfIntersections: false });
  let sum = 0;
  for (let i = 0; i < m.rawTris.length; i++) sum += m.rawTris[i] * ((i % 7) + 1);
  return { id: m.id, name: m.name, h: b.max.y - b.min.y, foot: b.min.y, cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2,
           tris: m.rawTris.length / 9, open: r.openEdges, nm: r.nonManifoldEdges, sum: sum, lift: p.liftY || 0 };
}));
const byName = (s, n) => s.find(x => x.name === n);
const status = page => page.textContent('#status');
const plateBlade = page => page.evaluate(() => {
  const g = state.modelGroup.children.find(c => c.name === 'cutPlateBlade');
  return g ? { y: g.position.y, helper: window.nsoHelpers.isHelper(g), sheetPick: (() => { let hit = false; g.traverse(o => { if (o.raycast && o.raycast.toString().length > 30) hit = true; }); return hit; })() } : null;
});
const setHeight = async (page, v) => { await page.fill('#cut-plate-height', String(v)); await page.waitForTimeout(150); };
const readout = page => page.textContent('#cut-plate-readout');
const reopen = async page => {
  await page.evaluate(() => { const m = document.getElementById('menu-cut'); m.open = false; });
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.getElementById('menu-cut').open = true; });
  await page.waitForTimeout(250);
  await page.click('#btn-cut-blade-plate');
  await page.waitForTimeout(300);
};

withApp(async (page, logs) => {
  for (const k of ['tee', 'tube', 'stub']) await loadSTL(page, FILES[k]);
  await page.waitForFunction(() => state.placed.length === 3, null, { timeout: 15000 });
  const names = await page.evaluate(() => state.models.map(m => m.name));
  console.log('  plate: ' + names.join(', '));
  const T = names.find(n => /tee/i.test(n)), U = names.find(n => /tube/i.test(n)), S = names.find(n => /stub/i.test(n));
  const before = await snap(page);
  check('the plate is a 14, a 12 and a 4 mm piece', near(byName(before, T).h, 14, 0.05) && near(byName(before, U).h, 12, 0.05) && near(byName(before, S).h, 4, 0.05),
    before.map(s => s.name + ' ' + s.h.toFixed(2)).join(', '));

  console.log('1. the card');
  await page.evaluate(() => { document.getElementById('menu-cut').open = true; });
  await page.waitForTimeout(250);
  check('the Blade row has four buttons, Whole plate the fourth', (await page.$$eval('.cut-blade-mode .btn', b => b.map(x => x.textContent.trim()))).join('|') === 'Full blade|Sized blade|Notch|Whole plate');
  check('before it is pressed, its fields are hidden', await page.$eval('#cut-plate-fields', e => e.hidden));
  await page.click('#btn-cut-blade-plate');
  await page.waitForTimeout(300);
  check('Whole plate is pressed and its fields show', (await page.getAttribute('#btn-cut-blade-plate', 'aria-pressed')) === 'true' && !(await page.$eval('#cut-plate-fields', e => e.hidden)));
  const gone = await page.evaluate(() => ['cut-slider', 'cut-miter-dial', 'cut-bevel-dial', 'cut-readout', 'cut-rotate-dial'].map(id => getComputedStyle(document.getElementById(id)).display === 'none' ||
    !document.getElementById(id).offsetParent));
  check('the per-piece slider, dials, readout and Rotate piece stand down', gone.every(Boolean), JSON.stringify(gone));
  check('no per-piece blade, a plate blade instead', await page.evaluate(() => !state.cutHelper) && !!(await plateBlade(page)));
  const pb = await plateBlade(page);
  check('the blade is a helper and cannot be picked', pb && pb.helper && !pb.sheetPick, JSON.stringify(pb));
  check('the Cut button is live with no piece picked', !(await page.$eval('#btn-cut', b => b.disabled)));
  check('the card says what it is', /Whole plate/.test(await page.textContent('#cutter-status')), await page.textContent('#cutter-status'));

  console.log('2. the slider and the readout');
  const rng = await page.evaluate(() => { const s = document.getElementById('cut-plate-height-s'); return { min: +s.min, max: +s.max }; });
  check('the slider runs 1 .. 13 (the tallest piece, 14, less 1)', near(rng.min, 1) && near(rng.max, 13), JSON.stringify(rng));
  await setHeight(page, 4);
  const r4 = await readout(page);
  check('at 4: 2 of 3 pieces cut, 4 mm shorter, the stub named as left alone',
    /@ 4\.0 mm/.test(r4) && /2 of 3 pieces cut/.test(r4) && /4\.0 mm shorter/.test(r4) && new RegExp(S).test(r4) && /14\.0 -> 10\.0/.test(r4), r4);
  check('the blade stands at the slider\'s height (plate 0.2 + 4)', near((await plateBlade(page)).y, 4.2, 1e-6), String((await plateBlade(page)).y));
  // where the blade meets the pieces it will cut: an outline of the section, on the plane, over the cut pieces only
  const sec = await page.evaluate((ids) => {
    const g = state.modelGroup.children.find(c => c.name === 'cutPlateBlade');
    const line = g.children.find(c => c.userData && c.userData.cutPlateSection);
    const a = line.geometry.attributes.position.array, boxes = ids.map(id => {
      const p = state.placed.find(q => q.sourceId === id); return new THREE.Box3().setFromObject(p.mesh);
    });
    const inBox = (b, x, z) => x >= b.min.x - 0.01 && x <= b.max.x + 0.01 && z >= b.min.z - 0.01 && z <= b.max.z + 0.01;
    const count = boxes.map(() => 0);
    let offPlane = 0;
    for (let i = 0; i < a.length; i += 3) {
      if (Math.abs(a[i + 1]) > 1e-6) offPlane++;
      const wx = a[i] + g.position.x, wz = a[i + 2] + g.position.z;
      boxes.forEach((b, k) => { if (inBox(b, wx, wz)) count[k]++; });
    }
    return { n: a.length / 3, offPlane, count };
  }, [byName(before, T).id, byName(before, U).id, byName(before, S).id]);
  check('the section outline is drawn on the plane, over the T and the tube and not the stub',
    sec.n > 8 && sec.offPlane === 0 && sec.count[0] > 0 && sec.count[1] > 0 && sec.count[2] === 0, JSON.stringify(sec));
  await setHeight(page, 9);
  check('and follows it', near((await plateBlade(page)).y, 9.2, 1e-6) && /@ 9\.0 mm/.test(await readout(page)));
  await page.fill('#cut-plate-height', '99'); await page.dispatchEvent('#cut-plate-height', 'change'); await page.waitForTimeout(150);
  check('a number past the slider is brought back to its end (13)', near(await page.$eval('#cut-plate-height', e => +e.value), 13) && near((await plateBlade(page)).y, 13.2, 1e-6));
  await setHeight(page, 4);

  console.log('3. a click on a piece');
  const at = await page.evaluate(id => {
    const p = state.placed.find(q => q.sourceId === id);
    const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    c.project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  }, before.find(s => s.name === T).id);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(250);
  const clicked = await page.evaluate(() => ({ helper: !!state.cutHelper, drag: !!state.cutDragging, edit: state.editId, plate: !!state.modelGroup.children.find(c => c.name === 'cutPlateBlade'), placed: state.placed.length }));
  check('the piece is picked, no per-piece blade drops, no drag starts, the plate blade stays, the plate is whole',
    clicked.edit === before.find(s => s.name === T).id && !clicked.helper && !clicked.drag && clicked.plate && clicked.placed === 3, JSON.stringify(clicked));

  console.log('4. Keep above at 4');
  const depth0 = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-cut');
  await page.waitForTimeout(700);
  const a = await snap(page);
  const said = await status(page);
  const shorter = n => near(byName(before, n).h - byName(a, n).h, 4, 0.05);
  check('the T and the tube are each exactly 4 mm shorter', shorter(T) && shorter(U), a.map(s => s.name + ' ' + s.h.toFixed(3)).join(', '));
  check('the stub is left alone, bit for bit', byName(a, S).sum === byName(before, S).sum && near(byName(a, S).h, 4, 0.05));
  check('every piece still stands on the plate', a.every(s => near(s.foot, byName(before, s.name).foot, 0.15) && s.lift === 0), a.map(s => s.foot.toFixed(2)).join(','));
  check('nobody moved in x or z', a.every(s => near(s.cx, byName(before, s.name).cx, 1e-3) && near(s.cz, byName(before, s.name).cz, 1e-3)),
    a.map(s => (s.cx - byName(before, s.name).cx).toFixed(4) + '/' + (s.cz - byName(before, s.name).cz).toFixed(4)).join(' '));
  check('every piece is one closed piece, no worse than it was', a.every(s => s.open === 0 && s.nm <= byName(before, s.name).nm), a.map(s => s.open + '/' + s.nm).join(' '));
  check('the status line says what happened', /Whole-plate cut @ 4\.0 mm/.test(said) && /2 of 3 pieces/.test(said) && new RegExp(S).test(said), said);
  check('ONE Undo step', (await page.evaluate(() => state.undoStack.length)) === depth0 + 1 && (await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type)) === 'stepGroup');
  check('the plate blade is still up for the next press', !!(await plateBlade(page)));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(500);
  const u = await snap(page);
  check('one Undo gives every piece back, vertex for vertex, where it stood',
    u.every(s => s.sum === byName(before, s.name).sum && near(s.h, byName(before, s.name).h, 1e-3) && near(s.cx, byName(before, s.name).cx, 1e-3) && near(s.cz, byName(before, s.name).cz, 1e-3)),
    u.map(s => s.name + ' ' + s.h.toFixed(2)).join(', '));
  check('and says so', /whole-plate cut reverted/i.test(await status(page)), await status(page));
  await page.evaluate(() => redoLast());
  await page.waitForTimeout(500);
  const rd = await snap(page);
  check('Redo cuts it again: the same shorter pieces', near(byName(rd, T).h, byName(a, T).h, 1e-3) && near(byName(rd, U).h, byName(a, U).h, 1e-3) && byName(rd, S).sum === byName(before, S).sum && byName(rd, T).sum === byName(a, T).sum,
    rd.map(s => s.name + ' ' + s.h.toFixed(2)).join(', '));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(400);
  // Redo closes every tool session (nsoHelpers.teardown, as for every helper), so the card is opened again
  check('Redo closed the card, as it does for every tool with a helper', await page.evaluate(() => !state.cutterOpen));
  await reopen(page);

  console.log('5. Keep below at 6');
  await page.click('#btn-cut-plate-below');
  await setHeight(page, 6);
  check('the readout says keep below and what goes', /keep below/.test(await readout(page)) && /off the top/.test(await readout(page)), await readout(page));
  await page.click('#btn-cut');
  await page.waitForTimeout(700);
  const b = await snap(page);
  check('the T and the tube are cut to the blade\'s height, 6 mm; the stub is lower than the blade and left alone',
    near(byName(b, T).h, 6, 0.05) && near(byName(b, U).h, 6, 0.05) && byName(b, S).sum === byName(before, S).sum, b.map(s => s.name + ' ' + s.h.toFixed(3)).join(', '));
  check('closed, and not moved', b.every(s => s.open === 0 && near(s.cx, byName(before, s.name).cx, 1e-3) && near(s.cz, byName(before, s.name).cz, 1e-3)));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(400);
  await page.click('#btn-cut-plate-above');

  console.log('6. a lifted piece');
  await page.evaluate(id => {
    const p = state.placed.find(q => q.sourceId === id);
    p.liftY = 20;
    applyMeshRotation(p);
  }, byName(before, T).id);
  await setHeight(page, 4);
  const rl = await readout(page);
  check('a piece 20 mm up is passed under: the readout names it, 1 of 3 cut',
    /1 of 3 pieces cut/.test(rl) && new RegExp(T).test(rl), rl);
  const lifted0 = await snap(page);
  await page.click('#btn-cut');
  await page.waitForTimeout(600);
  const l1 = await snap(page);
  check('the lifted piece is untouched; the tube is 4 shorter', byName(l1, T).sum === byName(lifted0, T).sum && near(byName(lifted0, U).h - byName(l1, U).h, 4, 0.05));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(300);
  await setHeight(page, 22);
  check('at 22 the blade is 2 mm up the lifted piece\'s foot (it is 20 up): its foot-to-blade is 2, so the T is cut 2 mm',
    /1 of 3 pieces cut/.test(await readout(page)) && /2\.0 mm shorter/.test(await readout(page)), await readout(page));
  await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); p.liftY = 0; applyMeshRotation(p); }, byName(before, T).id);
  await setHeight(page, 4);

  console.log('7. a turned piece');
  await page.evaluate(id => {
    const p = state.placed.find(q => q.sourceId === id);
    p.tipX = 1;                       // the tube lies on its side
    applyMeshRotation(p);
  }, byName(before, U).id);
  const tipped = await snap(page);
  check('the tube lies on its side: 12 wide, 12 tall', near(byName(tipped, U).h, 12, 0.1), byName(tipped, U).h.toFixed(2));
  const d7 = await page.evaluate(() => state.undoStack.length);
  await page.click('#btn-cut');
  await page.waitForTimeout(900);
  const t1 = await snap(page);
  check('it was set first and cut level in the world: 4 mm shorter, on the plate',
    near(byName(tipped, U).h - byName(t1, U).h, 4, 0.1) && near(byName(t1, U).foot, 0.2, 0.15), byName(t1, U).h.toFixed(3) + ' foot ' + byName(t1, U).foot.toFixed(3));
  check('and it is still ONE Undo', (await page.evaluate(() => state.undoStack.length)) === d7 + 1, 'depth ' + (await page.evaluate(() => state.undoStack.length)) + ' from ' + d7);
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(500);
  const t2 = await snap(page);
  check('Undo puts the tube back on its side', near(byName(t2, U).h, 12, 0.1) && near(byName(t2, T).h, 14, 0.05), t2.map(s => s.name + ' ' + s.h.toFixed(2)).join(', '));
  await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); p.tipX = 0; applyMeshRotation(p); }, byName(before, U).id);

  console.log('8. paint');
  await page.evaluate(id => { state.models.find(m => m.id === id).faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false }] }; }, byName(before, T).id);
  const d8 = await page.evaluate(() => state.undoStack.length);
  const s8 = await snap(page);
  await page.click('#btn-cut');
  await page.waitForTimeout(500);
  const m8 = await status(page);
  check('the press stands down, naming the piece and the reason', /not made/.test(m8) && new RegExp(T).test(m8) && /painted/.test(m8) && /Nothing changed/.test(m8), m8);
  const s9 = await snap(page);
  check('and changes nothing at all: no Undo step, every soup the same', (await page.evaluate(() => state.undoStack.length)) === d8 && s9.every(s => s.sum === byName(s8, s.name).sum));
  await setHeight(page, 12.5);       // the blade is above the stub and the tube's top; only the T is crossed - still painted
  await page.evaluate(id => { state.models.find(m => m.id === id).faceMask = null; }, byName(before, T).id);

  console.log('9. the other blades');
  await page.click('#btn-cut-blade-full');
  await page.waitForTimeout(250);
  check('leaving Whole plate: its fields and blade go, the per-piece controls are back',
    (await page.$eval('#cut-plate-fields', e => e.hidden)) && !(await plateBlade(page)) && (await page.$eval('#cut-slider', e => !!e.offsetParent || getComputedStyle(e).display !== 'none')));
  check('and the Cut button waits for a picked piece again', await page.$eval('#btn-cut', b => b.disabled) || (await page.evaluate(() => !!state.cutHelper)));
  await page.evaluate(id => selectPlaced(state.placed.findIndex(q => q.sourceId === id)), byName(before, T).id);
  await page.waitForTimeout(250);
  const n0 = await page.evaluate(() => state.models.length);
  await page.click('#btn-cut');
  await page.waitForTimeout(900);
  check('Full blade still splits one piece into two', (await page.evaluate(() => state.models.length)) === n0 + 1, 'models ' + n0 + ' -> ' + (await page.evaluate(() => state.models.length)));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(400);
  await page.click('#btn-cut-blade-plate');
  await page.waitForTimeout(250);
  check('Whole plate again: the blade is back', !!(await plateBlade(page)));
  await page.evaluate(() => { document.getElementById('menu-cut').open = false; });
  await page.waitForTimeout(300);
  check('closing the card takes the blade away and leaves the pieces', !(await plateBlade(page)) && (await page.evaluate(() => state.placed.length)) === 3);
  check('no page errors', !logs.some(l => /pageerror/.test(l)), logs.filter(l => /pageerror/.test(l)).slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
