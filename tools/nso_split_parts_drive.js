#!/usr/bin/env node
/* Split to parts - driven through the REAL app in headless Chromium at 1280 x 800.

     node tools/nso_split_parts_drive.js                       exit 0 = every gate held
     node tools/nso_split_parts_drive.js some/other/dir        ...screenshots there instead
   (npm run split:parts-drive; screenshots go to tools/split-parts-out/, which
   is git-ignored and never committed)

   The fixture is the print-in-place hinge as Lift hands it over: the knuckle
   with its leaf, lifted off fixtures/features/feature-hull_hinge.stl's +Y wall
   by the real engines (tools/nso_split_parts_fixtures.js hingeLifted), and
   brought in through the app's own Import. Every press is a real click on the
   card's button, every grab a real press on the canvas, every carry a run of
   real pointer moves, every drop a real release.

     1. the piece selected: the Subtract card says "2 parts" beside the button
     2. press Split to parts: two pieces, "hinge part 1" and "hinge part 2", in
        place (the union of their boxes is the original's box), the original gone,
        part 1 selected, the readout naming the result
     3. grab part 2 - a part nobody selected - and drop it on the plate elsewhere:
        it is a piece like any other (grabbed, carried, set down on the bed, one
        Undo step), and part 1 never moved
     4. Undo the drop, then Undo the split: the original is back, bit for bit,
        selected */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, closeTopMenus, openMenuFor, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_split_parts_fixtures.js');
const L = require('./nso_lift_plate_drive_lib.js');
const { status, plateState, ctrlZ, selectRow, raw, sameSoup } = L;
const C = L.makeCheck(), check = C.check;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-split-parts-drive-'));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'tools', 'split-parts-out');
fs.mkdirSync(OUT, { recursive: true });
const shot = L.shooter(OUT, true, ROOT).plate;

const HINGE_STL = path.join(TMP, 'hinge.stl');
writeSTL(HINGE_STL, FX.hingeLifted().soup);

const near = (a, b, tol) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= tol);
const piece = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id);
  if (!p) return null;
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray(), liftY: p.liftY || 0, x: p.x, z: p.z };
}, id);
const card = page => page.evaluate(() => ({ count: document.getElementById('split-count').textContent,
  read: document.getElementById('split-readout').textContent, disabled: document.getElementById('btn-split-parts').disabled }));
const screenOf = (page, w) => page.evaluate(w => {
  state.camera.updateMatrixWorld(true);
  const q = new THREE.Vector3(w[0], w[1], w[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}, w);

/* Look at several pieces at once from above and in front, all of them in view. */
async function frameAll(page, ids, up) {
  await page.evaluate(([ids, up]) => {
    const bb = new THREE.Box3();
    ids.forEach(id => bb.union(new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh)));
    const c = bb.getCenter(new THREE.Vector3()), span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, bb.max.y - bb.min.y);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + span * 0.2, c.y + span * up, c.z + span * 0.7);
    state.controls.update();
  }, [ids, up || 1.1]);
  await page.waitForTimeout(300);
}

/* A screen point that is on piece `id` - the first triangle whose centre, projected,
   the app's own raycast hits as that piece, on the canvas and not under a menu. */
const pointOn = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array;
  p.mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
  const rect = state.renderer.domElement.getBoundingClientRect(), cam = state.camera.position, rc = new THREE.Raycaster();
  const sc = [];
  for (let t = 0; t < P.length / 9; t++) {
    const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]).applyMatrix4(p.mesh.matrixWorld));
    const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3), nrm = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const f = nrm.dot(cam.clone().sub(cen).normalize());
    if (f > 0.3) sc.push({ cen, f });
  }
  sc.sort((x, y) => y.f - x.f);
  for (const s of sc.slice(0, 800)) {
    const q = s.cen.clone().project(state.camera);
    if (Math.abs(q.x) > 0.85 || Math.abs(q.y) > 0.85) continue;
    const x = rect.left + (q.x + 1) / 2 * rect.width, y = rect.top + (1 - q.y) / 2 * rect.height;
    if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
    rc.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
    const hit = rc.intersectObjects(state.modelGroup.children, true).find(h => h.faceIndex != null);
    if (hit && hit.object === p.mesh) return { x, y };
  }
  return null;
}, id);

/* Press at screen point a, carry to b in steps, and (unless `hold`) let go. */
async function carry(page, a, b, opts) {
  opts = opts || {};
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const n = opts.steps || 14;
  for (let k = 1; k <= n; k++) {
    await page.mouse.move(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(120);
  if (!opts.hold) { await page.mouse.up(); await page.waitForTimeout(300); }
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on('dialog', d => d.accept().catch(() => {}));

  console.log('\n=== 1. the piece selected: the card says how many parts ===');
  const hingeId = await loadSTL(page, HINGE_STL);
  await selectRow(page, hingeId);
  await page.waitForFunction(() => /^\d+ parts?$/.test(document.getElementById('split-count').textContent), null, { timeout: 15000 });
  await openMenuFor(page, '#btn-split-parts');
  await frameAll(page, [hingeId], 1.0);
  const c1 = await card(page);
  check('"2 parts" beside the button, the button on, before it is pressed', c1.count === '2 parts' && !c1.disabled, JSON.stringify(c1));
  check('...and the readout says what it is', /^2 parts - Split to parts makes one piece of each/.test(c1.read), c1.read);
  await shot(page, '1-before-the-card-says-2-parts');

  console.log('\n=== 2. press Split to parts ===');
  const orig = await raw(page, hingeId), ob = await piece(page, hingeId), S0 = await plateState(page);
  await page.click('#btn-split-parts');
  await page.waitForFunction(() => /^Split /.test(document.getElementById('split-readout').textContent), null, { timeout: 15000 });
  const S1 = await plateState(page);
  const parts = S1.models.filter(m => /^hinge part \d+$/.test(m.name));
  check('two pieces, "hinge part 1" and "hinge part 2"; the original is gone', parts.length === 2 && parts[0].name === 'hinge part 1' && parts[1].name === 'hinge part 2' &&
    !S1.models.some(m => m.id === hingeId), S1.models.map(m => m.name).join(' | '));
  const [P1, P2] = parts.map(p => p.id);
  const b1 = await piece(page, P1), b2 = await piece(page, P2);
  const un = { min: [0, 1, 2].map(k => Math.min(b1.min[k], b2.min[k])), max: [0, 1, 2].map(k => Math.max(b1.max[k], b2.max[k])) };
  check('in place: the union of the two boxes is the original\'s box', near(un.min, ob.min, 0.01) && near(un.max, ob.max, 0.01));
  const sel = await page.evaluate(() => ({ id: state.placed[state.selectedIndex] && state.placed[state.selectedIndex].sourceId, edit: state.editId }));
  check('part 1 is selected', sel.id === P1 && sel.edit === P1, JSON.stringify(sel));
  const c2 = await card(page);
  check('the card keeps the result in words while part 1 stays selected', /^Split hinge into 2 parts: "hinge part 1", "hinge part 2"/.test(c2.read), c2.read.slice(0, 100));
  check('the Pieces list has both parts as rows', await page.evaluate(() => ['hinge part 1', 'hinge part 2'].every(n => Array.from(document.querySelectorAll('#model-list .model-item .name')).some(e => e.textContent === n))));
  await closeTopMenus(page);
  await frameAll(page, [P1, P2], 1.0);
  await page.evaluate(() => { clearSelectionOutline(); });
  await shot(page, '2-split-two-parts-in-place');

  console.log('\n=== 3. grab part 2 and drop it on the plate elsewhere ===');
  const grab = await pointOn(page, P2);
  check('a point on part 2 can be pressed', !!grab, JSON.stringify(grab));
  const aim = [b2.max[0] + 30, 0.2, (b2.min[2] + b2.max[2]) / 2 + 22];
  const to = await screenOf(page, aim);
  const u3 = (await plateState(page)).undo;
  await carry(page, grab, to, { hold: true });
  const mid = await page.evaluate(() => ({ active: nsoGrab.active(), mode: nsoGrab.mode(), status: document.getElementById('status').textContent }));
  check('part 2 is carried like any piece: the grab is live and says it will set it down on the plate', mid.active && mid.mode === 'plate' && /^Over the plate - let go to set/.test(mid.status), mid.status);
  await shot(page, '3-part-2-mid-drag');
  await page.mouse.up();
  await page.waitForTimeout(350);
  const d2 = await piece(page, P2), d1 = await piece(page, P1);
  check('let go: part 2 is on the plate - its bottom on the bed, liftY 0', Math.abs(d2.min[1] - 0.2) < 1e-6 && d2.liftY === 0, 'bottom ' + d2.min[1].toFixed(4));
  check('...and elsewhere: it moved off where it stood', Math.hypot(d2.x - b2.x, d2.z - b2.z) > 10, 'moved ' + Math.hypot(d2.x - b2.x, d2.z - b2.z).toFixed(1) + ' mm');
  check('part 1 did not move', near(d1.min, b1.min, 1e-9) && near(d1.max, b1.max, 1e-9));
  check('the drop is one Undo step, said as a move (it was already on the bed)', (await plateState(page)).undo === u3 + 1 && /^Moved model/.test(await status(page)), await status(page));
  await frameAll(page, [P1, P2], 1.2);
  await page.evaluate(() => { clearSelectionOutline(); state.selectedIndex = -1; });
  await shot(page, '4-part-2-dropped-elsewhere');

  console.log('\n=== 4. Undo the drop, then Undo the split ===');
  await ctrlZ(page);
  const e2 = await piece(page, P2);
  check('one Ctrl+Z: part 2 is back where the split put it', near(e2.min, b2.min, 1e-6) && near(e2.max, b2.max, 1e-6) && (await plateState(page)).undo === u3);
  await ctrlZ(page);
  const S2 = await plateState(page), back = await raw(page, hingeId);
  check('the next Ctrl+Z: the original piece is back, the parts are gone', S2.models.some(m => m.id === hingeId) && !S2.models.some(m => /^hinge part/.test(m.name)) &&
    S2.undo === S0.undo, S2.models.map(m => m.name).join(' | '));
  check('...the same soup, bit for bit, in the same place', sameSoup(back, orig) && near((await piece(page, hingeId)).min, ob.min, 1e-6));
  check('...and selected', await page.evaluate(id => state.placed[state.selectedIndex] && state.placed[state.selectedIndex].sourceId === id, hingeId));
  await frameAll(page, [hingeId], 1.0);
  await shot(page, '5-undone-the-original-is-back');

  const errs = logs.filter(l => /^\[pageerror\]/.test(l));
  check('no page errors', errs.length === 0, errs.join(' | '));
}).then(() => {
  console.log('\n' + (C.fails ? C.fails + ' FAILED: ' + C.failed.join('; ') : 'all ' + C.passes + ' gates held'));
  process.exit(C.fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
