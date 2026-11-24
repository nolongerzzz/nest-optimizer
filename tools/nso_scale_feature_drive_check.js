/* The Scale card's Feature size section (app-scale-feature.js,
   nso_feature_size.js, docs/FEATURE-SIZE.md), through the real app and real
   clicks on the plate.
     node tools/nso_scale_feature_drive_check.js        exit 0 = every gate held

   Pieces: tools/nso_feature_fixture.js's plate with two 25 x 5 x 4 tongues,
   and its block with a 20 x 5.2 x 4 slot. Pinned:
   1. Feature size arms on the selected piece and ghosts it; a click on a
      tongue picks it (25 x 5 x 4 in the boxes), Shift-click on the other adds
      it, a click on the plate's face is refused in words.
   2. Typing 20.08 in Length draws the ghost (the two tongues, green) and
      leaves the piece untouched; Set (Enter) bakes it as ONE Undo; both
      tongues measure 20.08 on the baked piece; mesh_validate.py passes it; the
      section stays on the same two tongues, now 20.08.
   3. Undo puts the piece back bit for bit.
   4. Keep ends under its floor is refused in words, Set greyed; Stretch takes it.
   5. Escape drops it, the piece untouched; touching the card's own rows puts
      it away; the mm | in toggle shows inches.
   6. The slot: a click on its floor is a recess (Depth 4); Length 25.2 bakes;
      a Depth that would break out through the bottom is refused by the
      pierce gate, in words. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, openMenuFor, ROOT } = require('./nso_app_harness');
const FX = require('./nso_feature_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-3 : t);
const meshValidate = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));

const info = page => page.evaluate(() => nsoScaleFeature.info());
const hash = (page, id) => page.evaluate(i => { const s = state.models.find(x => x.id === i).rawTris; let h = 0; for (let k = 0; k < s.length; k++) h = (h * 31 + Math.round(s[k] * 1e4)) | 0; return h + ':' + s.length; }, id);
/* the screen point over a raw-frame point of the active piece */
const screenOfRaw = (page, p) => page.evaluate(pt => {
  const m = getActiveModel(), mesh = cutMeshOf(m);
  mesh.updateMatrixWorld(true);
  const q = nsoLocalPointFromRaw(nsoRawFrameOf(m), pt);
  const v = new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(mesh.matrixWorld).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, p);
async function clickRaw(page, p, shift) {
  const s = await screenOfRaw(page, p);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(s.x, s.y);
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
}
async function type(page, k, v) { await page.fill('#scale-feature-' + k, String(v)); await page.dispatchEvent('#scale-feature-' + k, 'input'); await page.waitForTimeout(150); }
/* the scene from straight above, the card shut out of the way for clicks */
async function lookDown(page) {
  await page.evaluate(() => {
    const b = new THREE.Box3().setFromObject(cutMeshOf(getActiveModel())), c = b.getCenter(new THREE.Vector3());
    state.camera.position.set(c.x + 0.01, c.y + 160, c.z + 40);
    if (state.controls) { state.controls.target.copy(c); state.controls.update(); }
    state.camera.lookAt(c);
    state.camera.updateMatrixWorld(true);
  });
}

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scale-feature-'));
  fs.writeFileSync(path.join(tmp, 'plate.stl'), FX.stl(FX.plateWithTongues()));
  fs.writeFileSync(path.join(tmp, 'slot.stl'), FX.stl(FX.blockWithSlot()));
  const id = await loadSTL(page, path.join(tmp, 'plate.stl'));
  await selectModel(page, id);
  const h0 = await hash(page, id), depth0 = await page.evaluate(() => state.undoStack.length);

  console.log('1. arm and pick');
  await openMenuFor(page, '#btn-scale-feature');
  await page.click('#btn-scale-feature');
  let i = await info(page);
  check('armed on the selected piece', i && i.modelId === id);
  check('the piece is a ghost', await page.evaluate(() => cutMeshOf(getActiveModel()).material.opacity < 0.5));
  /* the card hangs over the left of the canvas: click with it shut, the section still armed */
  await page.evaluate(() => { document.getElementById('menu-scale').open = false; });
  i = await info(page);
  check('shutting the card puts it away', !i);
  await openMenuFor(page, '#btn-scale-feature');
  await page.click('#btn-scale-feature');
  await lookDown(page);
  await clickRaw(page, [0, -33.5, 6]);
  i = await info(page);
  check('a click on a tongue picks it: raised 25 x 5 x 4', i && i.picked.length === 1 && i.picked[0].kind === 'raised' && near(i.picked[0].length, 25) && near(i.picked[0].width, 5) && near(i.picked[0].height, 4),
    JSON.stringify(i && i.picked));
  check('the boxes say 25, 5, 4', (await page.inputValue('#scale-feature-length')) === '25' && (await page.inputValue('#scale-feature-width')) === '5' && (await page.inputValue('#scale-feature-height')) === '4');
  await clickRaw(page, [0, 33.5, 6], true);
  i = await info(page);
  check('Shift-click adds the other tongue', i && i.picked.length === 2, i && i.readout);
  await clickRaw(page, [15, 0, 2]);
  const st = await page.evaluate(() => document.getElementById('status').textContent);
  check('a click on the plate\'s face is refused in words, the picks kept', /not a feature/.test(st) && (await info(page)).picked.length === 2, st);

  console.log('2. ghost and Set');
  await type(page, 'length', 20.08);
  i = await info(page);
  check('the ghost is drawn and the resize is good', i.ok && i.drawn.moved, i.reason);
  check('both previewed at 20.08', i.sizes && i.sizes.every(z => near(z.length, 20.08)), JSON.stringify(i.sizes));
  check('nothing changed under the ghost', await hash(page, id) === h0 && await page.evaluate(() => state.undoStack.length) === depth0);
  check('Set is live', !(await page.isDisabled('#btn-scale-feature-set')));
  await page.press('#scale-feature-length', 'Enter');
  await page.waitForTimeout(300);
  check('Enter set it: one Undo step', await page.evaluate(() => state.undoStack.length) === depth0 + 1);
  check('...labelled Feature size', await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type) === 'featureSizeReplace');
  const baked = await page.evaluate(i => Array.from(state.models.find(x => x.id === i).rawTris), id);
  const bf = FX.topology(new Float32Array(baked));
  check('the baked piece is closed and wound', bf.bad === 0 && bf.degenerate === 0, JSON.stringify(bf));
  const f = path.join(tmp, 'baked.stl');
  fs.writeFileSync(f, FX.stl(new Float32Array(baked)));
  const v = meshValidate(f);
  check('mesh_validate.py passes it', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 && v.self_intersection.pierce === 0,
    JSON.stringify({ open: v.open_edges, nm: v.nonmanifold_edges, deg: v.degenerate_tris, pierce: v.self_intersection.pierce }));
  check('volume down by 2 x 4.92 x 5 x 4', near(Math.abs(v.signed_volume), Math.abs(FX.volume(FX.plateWithTongues())) - 2 * 4.92 * 20, 0.05), v.signed_volume);
  i = await info(page);
  check('still armed on the same two tongues, now 20.08', i && i.picked.length === 2 && i.picked.every(p => near(p.length, 20.08)), JSON.stringify(i && i.picked));

  console.log('3. Undo');
  await page.click('#btn-scale-feature-cancel');
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(200);
  check('Undo puts the piece back bit for bit', await hash(page, id) === h0);

  console.log('4. the Keep ends floor, and Stretch');
  await page.click('#btn-scale-feature');
  await lookDown(page);
  await clickRaw(page, [0, -33.5, 6]);
  await type(page, 'length', 5);
  i = await info(page);
  check('5 mm with the ends kept is refused, in words', !i.ok && /7\.50/.test(i.note), i.note);
  check('...Set greyed', await page.isDisabled('#btn-scale-feature-set'));
  await page.click('#btn-scale-feature-stretch');
  await page.waitForTimeout(150);
  i = await info(page);
  check('Stretch takes it', i.ok && i.mode === 'stretch' && near(i.sizes[0].length, 5), i.reason);

  console.log('5. Escape, the card\'s rows, inches');
  await page.press('#scale-feature-length', 'Escape');
  check('Escape puts it away, the piece untouched', !(await info(page)) && await hash(page, id) === h0);
  await page.click('#btn-scale-feature');
  await lookDown(page);
  await clickRaw(page, [0, -33.5, 6]);
  await page.focus('#scale-length');
  check('touching the card\'s own rows puts it away', !(await info(page)));
  await page.click('#btn-scale-unit-in');
  await page.click('#btn-scale-feature');
  await lookDown(page);
  await clickRaw(page, [0, -33.5, 6]);
  await page.waitForTimeout(100);
  check('in inches the box reads 25 mm as 0.984', (await page.inputValue('#scale-feature-length')) === '0.984', await page.inputValue('#scale-feature-length'));
  await type(page, 'length', 0.8);
  i = await info(page);
  check('...and 0.8 in is 20.32 mm', i.ok && near(i.sizes[0].length, 20.32), JSON.stringify(i.sizes));
  await page.click('#btn-scale-feature-cancel');
  await page.click('#btn-scale-unit-mm');

  console.log('6. a slot');
  const id2 = await loadSTL(page, path.join(tmp, 'slot.stl'));
  await selectModel(page, id2);
  await openMenuFor(page, '#btn-scale-feature');
  await page.click('#btn-scale-feature');
  await page.click('#btn-scale-feature-keep');
  await lookDown(page);
  await clickRaw(page, [0, 0, 6]);
  i = await info(page);
  check('a click on the slot floor picks a recess 20 x 5.2 x 4', i && i.picked.length === 1 && i.picked[0].kind === 'recessed' && near(i.picked[0].length, 20) && near(i.picked[0].width, 5.2) && near(i.picked[0].height, 4),
    JSON.stringify(i && i.picked));
  check('its third box is Depth', (await page.textContent('#scale-feature-label-height')) === 'Depth');
  await type(page, 'height', 12);
  await page.waitForTimeout(600);
  i = await info(page);
  check('a Depth through the bottom is refused, in words', !i.ok && /cut into another part|past|fold/.test(i.note), i.note);
  await type(page, 'height', 4);
  await type(page, 'length', 25.2);
  await page.waitForTimeout(600);
  i = await info(page);
  check('Length 25.2 previews', i.ok && near(i.sizes[0].length, 25.2), i.reason);
  await page.click('#btn-scale-feature-set');
  await page.waitForTimeout(300);
  i = await info(page);
  check('...and bakes', i && near(i.picked[0].length, 25.2), JSON.stringify(i && i.picked));
  await page.click('#btn-scale-feature-cancel');

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|net::ERR/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\nFAIL - ' + fails + ' gate(s)' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});
