/* The Scale card's Scale zones section (app-scale-zones.js, nso_scale_zones.js,
   docs/SCALE-ZONES.md), through the real app and real clicks on the plate.
     node tools/nso_scale_zones_drive_check.js        exit 0 = every gate held

   Pieces: tools/nso_scale_zones_fixture.js's thumb screw (Ø20 head, Ø10 shaft)
   and stringing test (two pillars on a plate). Pinned:
   1. Scale zones arms on the selected piece and ghosts it; + Keep, then a real
      click on the shaft fits a red Keep cylinder round the shaft alone.
   2. Typing 150 draws the green ghost and leaves the piece untouched; the note
      names the head's sizes; Set (Enter) bakes it as ONE Undo
      (scaleZonesReplace); every shaft vertex is where it was, the head is Ø30;
      mesh_validate.py passes it; the section is armed again with its zone.
   3. Undo puts the piece back bit for bit.
   4. Dragging the zone's end handle down into the head stretches it; a
      shrink past the shaft is refused in words, Set greyed.
   5. Per axis: X and Y 150%, Z 100% - the head wider, not taller.
   6. Escape puts it away, the piece untouched, and the zone is still on the
      piece next time; Feature size puts it away.
   7. The stringing test: + Scale on one pillar, 140%: that pillar only. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, openMenuFor, ROOT } = require('./nso_app_harness');
const FX = require('./nso_scale_zones_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-3 : t);
const meshValidate = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));

const info = page => page.evaluate(() => nsoScaleZones.info());
const raw = (page, id) => page.evaluate(i => Array.from(state.models.find(x => x.id === i).rawTris), id);
const hash = (page, id) => page.evaluate(i => { const s = state.models.find(x => x.id === i).rawTris; let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + Math.round(s[k] * 1e4)) | 0; return h + ':' + s.length; }, id);
/* the raw-frame box of the active piece: the loader may have moved it, so tests read positions off it */
const rawBox = (page) => page.evaluate(() => {
  const s = getActiveModel().rawTris, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], s[i]); hi[k] = Math.max(hi[k], s[i]); }
  return { lo, hi };
});
const screenOfRaw = (page, p) => page.evaluate(pt => {
  const m = getActiveModel(), mesh = cutMeshOf(m);
  mesh.updateMatrixWorld(true);
  const q = nsoLocalPointFromRaw(nsoRawFrameOf(m), pt);
  const v = new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(mesh.matrixWorld).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, p);
/* the scene from the side and a little above, the piece in the middle */
async function lookSide(page) {
  await page.evaluate(() => {
    const b = new THREE.Box3().setFromObject(cutMeshOf(getActiveModel())), c = b.getCenter(new THREE.Vector3());
    const d = b.getSize(new THREE.Vector3()).length() * 1.6 + 20;
    state.camera.position.set(c.x + d * 0.15, c.y + d * 0.35, c.z + d);
    if (state.controls) { state.controls.target.copy(c); state.controls.update(); }
    state.camera.lookAt(c);
    state.camera.updateMatrixWorld(true);
  });
}
async function type(page, sel, v) { await page.fill(sel, String(v)); await page.dispatchEvent(sel, 'input'); await page.waitForTimeout(200); }

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scale-zones-'));
  fs.writeFileSync(path.join(tmp, 'screw.stl'), FX.stl(FX.screw()));
  fs.writeFileSync(path.join(tmp, 'pillars.stl'), FX.stl(FX.pillars()));
  const id = await loadSTL(page, path.join(tmp, 'screw.stl'));
  await selectModel(page, id);
  const h0 = await hash(page, id), depth0 = await page.evaluate(() => state.undoStack.length);
  const B0 = await rawBox(page);
  const ax = [(B0.lo[0] + B0.hi[0]) / 2, (B0.lo[1] + B0.hi[1]) / 2], z0 = B0.lo[2];   // the screw's axis and foot, raw

  console.log('1. arm, + Keep, click the shaft');
  await openMenuFor(page, '#btn-scale-zones');
  await page.click('#btn-scale-zones');
  let i = await info(page);
  check('armed on the selected piece', i && i.modelId === id);
  check('the piece is a ghost', await page.evaluate(() => cutMeshOf(getActiveModel()).material.opacity < 0.5));
  await page.click('#btn-scale-zones-keep');
  i = await info(page);
  check('+ Keep waits for a click', i.picking === 'keep' && /KEEP/.test(i.readout), i.readout);
  await lookSide(page);
  /* the shaft's front, half way up (the camera looks from +local z = -raw y) */
  const sp = await screenOfRaw(page, [ax[0], ax[1] - 5, z0 + 20]);
  await page.mouse.click(sp.x, sp.y);
  await page.waitForTimeout(300);
  i = await info(page);
  const z = i && i.zones[0];
  check('one Keep cylinder along Z, fitted round the shaft alone', z && z.kind === 'keep' && z.shape === 'cyl' && z.axis === 2 && z.r > 5 && z.r < 5.5, JSON.stringify(z));
  check('from the head\'s top to the shaft\'s end', z && near(z.c[2] - z.hl - z0, 10, 0.02) && near(z.c[2] + z.hl - z0, 30, 0.02), z && (z.c[2] - z.hl - z0).toFixed(2) + ' .. ' + (z.c[2] + z.hl - z0).toFixed(2));
  check('it is drawn, picked, with its three handles', i.drawn.zones === 1 && i.drawn.handles === 3 && i.sel === z.id, JSON.stringify(i.drawn));
  check('the list names it', /Keep · cylinder Ø10\.\d+ × 20(\.\d+)? mm, along Z/.test(await page.textContent('#scale-zones-list')), await page.textContent('#scale-zones-list'));

  console.log('2. 150%, ghost, Set');
  await type(page, '#scale-zones-all', 150);
  i = await info(page);
  check('the ghost is drawn and the scale is good', i.ok && i.drawn.result, i.reason);
  check('one part, about the join (the head\'s top)', i.parts && i.parts.length === 1 && near(i.parts[0].pivot[2] - z0, 10, 1e-3), i.parts && JSON.stringify(i.parts[0].pivot));
  check('the note names the head 20 → 30', /20 × 20 × 10 → 30 × 30 × 15/.test(i.note), i.note);
  check('nothing changed under the ghost', await hash(page, id) === h0 && await page.evaluate(() => state.undoStack.length) === depth0);
  await page.press('#scale-zones-all', 'Enter');
  await page.waitForTimeout(500);
  check('Enter set it: one Undo step', await page.evaluate(() => state.undoStack.length) === depth0 + 1);
  check('...labelled Scale zones', await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type) === 'scaleZonesReplace');
  const before = FX.screw(), baked = new Float32Array(await raw(page, id));
  /* the loader may have moved the soup: compare about the axis (the head's middle) and the shaft's end (the top) */
  const B1 = (() => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let k = 0; k < baked.length; k++) { const a = k % 3; lo[a] = Math.min(lo[a], baked[k]); hi[a] = Math.max(hi[a], baked[k]); } return { lo, hi }; })();
  check('the head is Ø30, the piece 15 + 20 tall', near(B1.hi[0] - B1.lo[0], 30, 1e-3) && near(B1.hi[2] - B1.lo[2], 35, 1e-3), (B1.hi[0] - B1.lo[0]).toFixed(3) + ' / ' + (B1.hi[2] - B1.lo[2]).toFixed(3));
  let shaftBad = 0, shaftN = 0;
  for (let k = 0; k < before.length; k += 3) {
    if (!(before[k + 2] > 10 - 1e-6 && Math.hypot(before[k], before[k + 1]) < 5 + 1e-4)) continue;
    shaftN++;
    if (!near(baked[k] - B1.lo[0] - 15, before[k], 1e-4) || !near(baked[k + 1] - B1.lo[1] - 15, before[k + 1], 1e-4) || !near(baked[k + 2] - B1.hi[2] + 30, before[k + 2], 1e-4)) shaftBad++;
  }
  check('every shaft vertex where it was (relative to the shaft\'s end)', shaftN > 0 && shaftBad === 0, shaftN + ' vertices, ' + shaftBad + ' off');
  const f = path.join(tmp, 'baked.stl');
  fs.writeFileSync(f, FX.stl(baked));
  const v = meshValidate(f);
  check('mesh_validate.py passes it', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 && v.self_intersection.pierce === 0,
    JSON.stringify({ open: v.open_edges, nm: v.nonmanifold_edges, deg: v.degenerate_tris, pierce: v.self_intersection.pierce }));
  i = await info(page);
  check('armed again, its zone kept, back at 100%', i && i.zones.length === 1 && i.zones[0].kind === 'keep' && i.factor[0] === 1, JSON.stringify(i && { z: i.zones.length, f: i.factor }));

  console.log('3. Undo');
  await page.click('#btn-scale-zones-cancel');
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(200);
  check('Undo puts the piece back bit for bit', await hash(page, id) === h0);

  console.log('4. a handle, and a refusal');
  await page.click('#btn-scale-zones');
  await lookSide(page);
  i = await info(page);
  const zid = i.zones[0].id;
  check('the zone is back on the piece', i.zones.length === 1 && i.drawn.handles === 3, JSON.stringify(i.drawn));
  const hS = await page.evaluate(q => nsoScaleZones.screenOf(q, 'end-'), zid);
  const hE = await screenOfRaw(page, [ax[0], ax[1], z0 + 5]);
  await page.mouse.move(hS.x, hS.y);
  await page.mouse.down();
  await page.mouse.move((hS.x + hE.x) / 2, (hS.y + hE.y) / 2, { steps: 4 });
  await page.mouse.move(hE.x, hE.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  i = await info(page);
  const zl = i.zones[0];
  check('dragging the bottom handle down stretched the zone into the head, its top kept', zl.c[2] - zl.hl - z0 < 8 && near(zl.c[2] + zl.hl - z0, 30, 0.05), (zl.c[2] - zl.hl - z0).toFixed(2) + ' .. ' + (zl.c[2] + zl.hl - z0).toFixed(2));
  await page.evaluate(a => { const z = nsoScaleZones.info().zones[0]; nsoScaleZones.edit(z.id, { c: [z.c[0], z.c[1], a.z0 + 20.0015], hl: 10.003 }); }, { z0 });
  await type(page, '#scale-zones-all', 40);
  i = await info(page);
  check('the head to 40% (Ø8, under the Ø10 shaft) is refused in words', !i.ok && /inside out/.test(i.note), i.note);
  check('...Set greyed', await page.isDisabled('#btn-scale-zones-set'));

  console.log('5. per axis');
  await page.check('#scale-zones-peraxis');
  await type(page, '#scale-zones-x', 150);
  await type(page, '#scale-zones-y', 150);
  await type(page, '#scale-zones-z', 100);
  i = await info(page);
  const p0 = i.parts && i.parts[0];
  check('X and Y 150%, Z 100%: the head Ø30 and still 10 tall', i.ok && near(p0.newHi[0] - p0.newLo[0], 30, 1e-3) && near(p0.newHi[2] - p0.newLo[2], 10, 1e-3), i.ok ? JSON.stringify([p0.newLo, p0.newHi]) : i.reason);
  await page.uncheck('#scale-zones-peraxis');

  console.log('6. Escape, Feature size');
  await page.press('#scale-zones-all', 'Escape');
  check('Escape puts it away, the piece untouched', !(await info(page)) && await hash(page, id) === h0);
  check('the zone stays on the piece for next time', await page.evaluate(i => (state.models.find(x => x.id === i).scaleZones || []).length, id) === 1);
  await page.click('#btn-scale-zones');
  check('armed again', !!(await info(page)));
  await page.click('#btn-scale-feature');
  check('pressing Feature size puts it away', !(await info(page)));
  await page.click('#btn-scale-feature-cancel').catch(() => {});

  console.log('7. the stringing test: one pillar');
  const id2 = await loadSTL(page, path.join(tmp, 'pillars.stl'));
  await selectModel(page, id2);
  await openMenuFor(page, '#btn-scale-zones');
  await page.click('#btn-scale-zones');
  const tri = await page.evaluate(() => {
    const s = getActiveModel().rawTris, lo = [Infinity, Infinity, Infinity];
    for (let k = 0; k < s.length; k++) lo[k % 3] = Math.min(lo[k % 3], s[k]);
    for (let t = 0; t < s.length / 9; t++) {
      const c = [0, 1, 2].map(a => (s[t * 9 + a] + s[t * 9 + 3 + a] + s[t * 9 + 6 + a]) / 3 - lo[a]);
      if (Math.abs(c[0] - 6) < 1e-3 && c[1] > 4 && c[1] < 6 && c[2] > 5) return t;
    }
    return -1;
  });
  const pr = await page.evaluate(t => nsoScaleZones.placeOnTri(t, 'scale'), tri);
  check('+ Scale on one pillar fits a box round it', pr.ok && pr.fitted && pr.zone.shape === 'box', JSON.stringify(pr.zone));
  await type(page, '#scale-zones-all', 140);
  i = await info(page);
  check('one part, 2 x 2 x 19 → 2.8 x 2.8 x 26.6', i.ok && i.parts.length === 1 && near(i.parts[0].newHi[0] - i.parts[0].newLo[0], 2.8, 1e-3) && near(i.parts[0].newHi[2] - i.parts[0].newLo[2], 26.6, 1e-3), i.ok ? i.note : i.reason);
  const h2 = await hash(page, id2);
  await page.click('#btn-scale-zones-set');
  await page.waitForTimeout(500);
  check('Set bakes it', await hash(page, id2) !== h2);
  const b2 = new Float32Array(await raw(page, id2));
  const tall = (() => { let lo = Infinity, hi = -Infinity; for (let k = 2; k < b2.length; k += 3) { lo = Math.min(lo, b2[k]); hi = Math.max(hi, b2[k]); } return hi - lo; })();
  check('the piece is 1 + 26.6 tall', near(tall, 27.6, 1e-3), tall.toFixed(3));
  await page.click('#btn-scale-zones-cancel');

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|net::ERR/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\nFAIL - ' + fails + ' gate(s)' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});
