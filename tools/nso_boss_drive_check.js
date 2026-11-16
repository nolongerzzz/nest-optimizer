/* Step / Boss (app-boss.js, nso_boss.js, docs/BOSS.md) through the real app:
   the ADD card's button, the editor it opens, real clicks and drags.
     node tools/nso_boss_drive_check.js        exit 0 = every gate held

   Piece: tools/nso_feature_fixture.js's block, 32 x 40 x 10 with a slot.
   Pinned:
   1. ADD > Step / Boss opens the editor on its own: titled Step / Boss, no
      tabs; the Assemble editor has no Step / Boss tab.
   2. A click on the block's side face picks it; the ghost stands on it before
      anything on the plate changes; the four distances are what the ghost's
      box measures off the face's edges, and a typed distance is exact.
   3. Dragging the ghost moves it on the face, on a 0.1 mm step.
   4. Ramp 45 from the bottom: the ghost's top rises from its bottom edge.
   5. Apply: one Undo, the piece does not move, mesh_validate.py passes it,
      the volume gained is the step's above the face; Undo restores it.
   6. Drawn: four white points on the face; dragging one moves that corner.
   7. Escape steps back, Return closes and gives the focus back to the button. */
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

const info = page => page.evaluate(() => NSO_AsmEditor.info());
const boss = async page => (await info(page)).lock;
const at = (page, id, pt) => page.evaluate(([i, p]) => NSO_AsmEditor.screenOf(i, p), [id, pt]);
async function click(page, id, pt) { const s = await at(page, id, pt); await page.mouse.move(s.x, s.y); await page.waitForTimeout(120); await page.mouse.click(s.x, s.y); await page.waitForTimeout(150); }
async function type(page, k, v, ev) { await page.fill('#boss-' + k, String(v)); await page.dispatchEvent('#boss-' + k, ev || 'input'); await page.waitForTimeout(80); }
const pose = (page, id) => page.evaluate(i => {
  const p = state.placed.find(q => q && q.sourceId === i && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh), m = state.models.find(x => x.id === i);
  let h = 0;
  for (let k = 0; k < m.rawTris.length; k++) h = (h * 31 + Math.round(m.rawTris[k] * 1e4)) | 0;
  return { min: bb.min.toArray(), max: bb.max.toArray(), raw: h };
}, id);
const rawSoup = (page, id) => page.evaluate(i => Array.from(state.models.find(x => x.id === i).rawTris), id);

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-boss-'));
  fs.writeFileSync(path.join(tmp, 'block.stl'), FX.stl(FX.blockWithSlot()));
  const id = await loadSTL(page, path.join(tmp, 'block.stl'));
  await selectModel(page, id);
  await page.evaluate(() => state.placed.forEach(p => applyPlacedXZ(p, p.x, p.z)));
  const p0 = await pose(page, id), depth0 = await page.evaluate(() => state.undoStack.length);
  const vol0 = Math.abs(FX.volume(new Float32Array(await rawSoup(page, id))));

  console.log('1. its own editor');
  await openMenuFor(page, '#btn-boss');
  await page.click('#btn-boss');
  await page.waitForTimeout(300);
  let I = await info(page);
  check('ADD > Step / Boss opens the editor on its mode', I.open && I.mode === 'boss');
  check('titled Step / Boss, no tabs shown', (await page.textContent('#asm-ed-title')) === 'Step / Boss' && await page.evaluate(() => document.getElementById('asm-ed-tabs').hidden));
  check('there is no Step / Boss tab among the tabs', await page.evaluate(() => !document.getElementById('asm-tab-boss')));

  console.log('2. pick a face, the ghost, distances');
  /* the block's +x side (world x = max), half way up and across */
  await page.evaluate(() => NSO_AsmEditor.view([300, 60, 60]));
  const wb = p0;
  const side = [wb.max[0], (wb.min[1] + wb.max[1]) / 2, (wb.min[2] + wb.max[2]) / 2];
  await click(page, id, side);
  let B = await boss(page);
  check('a click on the side picks it', B.step === 'set' && B.host && near(B.host.normal[0], 1), JSON.stringify(B.host && B.host.normal));
  check('the ghost stands on it, nothing on the plate changed', B.plan && B.plan.ghost && (await pose(page, id)).raw === p0.raw && await page.evaluate(() => state.undoStack.length) === depth0);
  check('the ghost stands out of the face by its height (3), from 0.4 inside', near(B.plan.box.max[0], wb.max[0] + 3, 1e-3) && near(B.plan.box.min[0], wb.max[0] - 0.4, 1e-3), JSON.stringify(B.plan.box));
  check('on a wall the face is upright: v points up, so a is its top edge', B.host.v[1] > 0.99, JSON.stringify(B.host.v));
  await type(page, 'width', 4);
  await type(page, 'd', 5, 'change'); await type(page, 'c', 2, 'change');
  B = await boss(page);
  check('typed d = 5, c = 2: exact', near(B.plan.edges.d, 5, 1e-6) && near(B.plan.edges.c, 2, 1e-6), JSON.stringify(B.plan.edges));
  /* on a side face v is up: c is the bottom edge, so the ghost's bottom is 2 above the block's */
  check('...the ghost\'s box says so (2 up from the bottom)', near(B.plan.box.min[1], wb.min[1] + 2, 1e-3) && near(B.plan.box.max[1], wb.min[1] + 6, 1e-3), B.plan.box.min[1] + ' vs ' + wb.min[1]);

  console.log('3. drag');
  const c0 = { u: B.cu, v: B.cv };
  const ghostMid = [(B.plan.box.min[0] + B.plan.box.max[0]) / 2 + 1.4, (B.plan.box.min[1] + B.plan.box.max[1]) / 2, (B.plan.box.min[2] + B.plan.box.max[2]) / 2];
  const s0 = await at(page, id, ghostMid), s1 = await at(page, id, [ghostMid[0], ghostMid[1] + 3, ghostMid[2]]);
  const view0 = await page.evaluate(() => NSO_AsmEditor.info().solution);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down();
  await page.mouse.move((s0.x + s1.x) / 2, (s0.y + s1.y) / 2, { steps: 4 }); await page.mouse.move(s1.x, s1.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(150);
  B = await boss(page);
  check('dragging moved it on the face', Math.abs(B.cu - c0.u) + Math.abs(B.cv - c0.v) > 1, JSON.stringify([c0, B.cu, B.cv]));
  check('...on a 0.1 mm step from the edge', near(Math.round(B.plan.edges.c * 10) / 10, B.plan.edges.c, 1e-6) || near(Math.round(B.plan.edges.d * 10) / 10, B.plan.edges.d, 1e-6), JSON.stringify(B.plan.edges));
  await type(page, 'd', 5, 'change'); await type(page, 'c', 2, 'change');

  console.log('4. a ledge');
  await type(page, 'ramp', 45); await type(page, 'height', 2);
  B = await boss(page);
  check('ramp 45, thin end at the bottom: it rises toward the top (rampDir along +v)', B.plan && B.thin === 'down' && near(Math.abs(B.plan.rampDir), 90, 1e-6) && B.plan.crease != null && near(B.plan.box.max[0], wb.max[0] + 2, 1e-3), JSON.stringify(B.plan));
  check('the readout names it', /ramp 45/.test(await page.textContent('#boss-readout')));

  console.log('5. Apply');
  const above = B.plan.above;
  await page.click('#boss-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 90000 });
  B = await boss(page);
  check('applied', B.last && B.last.ok, JSON.stringify(B.last));
  check('one Undo step, labelled Step / Boss', await page.evaluate(() => state.undoStack.length) === depth0 + 1 && await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type) === 'bossReplace');
  const p1 = await pose(page, id);
  check('the piece did not move: its body box on the -x side is where it was', near(p1.min[0], p0.min[0], 1e-3) && near(p1.min[1], p0.min[1], 1e-3) && near(p1.max[0], p0.max[0] + 2, 1e-3), JSON.stringify([p0.min, p1.min, p1.max]));
  const f = path.join(tmp, 'boss.stl');
  fs.writeFileSync(f, FX.stl(new Float32Array(await rawSoup(page, id))));
  const v = meshValidate(f);
  check('mesh_validate.py passes it', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 && v.self_intersection.pierce === 0,
    JSON.stringify({ open: v.open_edges, nm: v.nonmanifold_edges, deg: v.degenerate_tris, pierce: v.self_intersection.pierce }));
  check('the volume gained is the step\'s above the face', near(Math.abs(v.signed_volume) - vol0, above, 0.05), (Math.abs(v.signed_volume) - vol0).toFixed(3) + ' vs ' + above.toFixed(3));
  check('the stage is back at step 1', B.step === 'host');
  await page.click('#asm-undo');
  await page.waitForTimeout(300);
  check('Undo restores the piece', (await pose(page, id)).raw === p0.raw);

  console.log('6. Drawn');
  await click(page, id, side);
  await page.click('#boss-outline-custom');
  await page.waitForTimeout(100);
  B = await boss(page);
  check('Drawn starts from the rectangle: four points', B.points && B.points.length === 4, JSON.stringify(B.points));
  /* drag point 3 (the +x +y corner of the outline) outward along u by ~4 mm */
  const pw = await page.evaluate(() => {
    const L = NSO_AsmEditor.info().lock, h = L.host, p = L.points[2];
    const a = L.deg * Math.PI / 180, x = p[0] * Math.cos(a) - p[1] * Math.sin(a), y = p[0] * Math.sin(a) + p[1] * Math.cos(a);
    const pt = (u, v) => [0, 1, 2].map(k => h.u[k] * u + h.v[k] * v + h.normal[k] * (h.d + 0.05));
    return [pt(L.cu + x, L.cv + y), pt(L.cu + x + 4, L.cv + y)];
  });
  const a0 = await at(page, id, pw[0]), a1 = await at(page, id, pw[1]);
  await page.mouse.move(a0.x, a0.y); await page.mouse.down(); await page.mouse.move(a1.x, a1.y, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  const B2 = await boss(page);
  check('dragging a point moves that corner', B2.pick === 2 && near(B2.points[2][0], B.points[2][0] + 4, 0.25) && near(B2.points[0][0], B.points[0][0], 1e-9), JSON.stringify([B.points[2], B2.points[2]]));
  check('the ghost follows: a 5-sided shape still builds', B2.plan && B2.plan.ghost, JSON.stringify(B2.plan && B2.plan.error));
  await page.click('#boss-pt-add');
  check('+ point adds one after the picked one', (await boss(page)).points.length === 5);

  console.log('7. Escape, Return');
  await page.keyboard.press('Escape');
  check('Escape steps back to step 1', (await boss(page)).step === 'host');
  await page.click('#asm-return');
  check('Return closes it', !(await info(page)).open);
  check('...and the focus is back on Step / Boss', await page.evaluate(() => document.activeElement && document.activeElement.id) === 'btn-boss');
  await page.click('#btn-asm-open').catch(() => {});
  await page.waitForTimeout(200);
  if ((await info(page)).open) {
    check('the Assemble editor wears its own title and tabs again', (await page.textContent('#asm-ed-title')) === 'Assemble' && await page.evaluate(() => !document.getElementById('asm-ed-tabs').hidden));
    await page.click('#asm-return');
  }

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|net::ERR/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log(fails ? '\nFAIL - ' + fails + ' gate(s)' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});
