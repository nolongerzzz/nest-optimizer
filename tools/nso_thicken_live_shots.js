/* Screenshots of the live Thicken control, into tools/thicken-live-out/.
     node tools/nso_thicken_live_shots.js

   Not a test step - nothing is asserted here (tools/nso_thicken_drive_check.js
   is the gate); this is the evidence the ticket asked to see. Every state is
   reached by the same clicks a person makes: the Add card's Thicken button,
   the slider, a click on a face, Set.

     1-ghost-out-1.5.png        Thicken out armed on the open box, slider at 1.5:
                                the piece a ghost, the wall growing out in green
     2-ghost-out-3.png          the same, slider at 3 - the ghost follows
     3-ghost-in-2.png           Thicken in at 2: the cavity walls closing in
     4-after-set-in-2.png       after Set: baked, solid again, ghost gone
     5-per-face-out-picked.png  Thicken out with the +x wall clicked: that wall
                                lit (blue), only it growing
     6-per-face-after-set.png   after Set: the one wall, 61.5 long
     7-per-face-in-floor.png    Thicken in with the cavity floor clicked from
                                above: the floor rising, the walls as they were */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

const OUT = path.join(__dirname, 'thicken-live-out');
fs.mkdirSync(OUT, { recursive: true });
const fx = f => path.join(ROOT, 'fixtures', f);

const frame = (page, from, zoom) => page.evaluate(([f, z]) => {
  const m = getActiveModel(), ms = cutMeshOf(m);
  ms.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(ms), c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() * z;
  state.controls.target.copy(c);
  state.camera.position.set(c.x + f[0] * r, c.y + f[1] * r, c.z + f[2] * r);
  state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
  // the Add card holds the left of the canvas: slide the view so the piece sits right of it
  const d = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(-r * 0.22);
  state.controls.target.add(d); state.camera.position.add(d); state.controls.update(); state.camera.updateMatrixWorld(true);
}, [from, zoom]);
const screenOfRaw = (page, p) => page.evaluate(pt => {
  const m = getActiveModel(), ms = cutMeshOf(m), f = nsoRawFrameOf(m), q = nsoLocalPointFromRaw(f, pt);
  ms.updateMatrixWorld(true);
  const v = new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(ms.matrixWorld).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, p);
const realClick = async (page, at) => {
  await page.mouse.move(at.x - 4, at.y - 4); await page.mouse.move(at.x, at.y);
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(200);
};
async function slideTo(page, mm) {
  await page.focus('#inp-thicken-mm');
  await page.keyboard.press('Home');
  const min = await page.evaluate(() => +document.getElementById('inp-thicken-mm').min);
  for (let i = 0, n = Math.round((mm - min) / 0.1); i < n; i++) await page.keyboard.press('ArrowRight');
}
const shot = async (page, name) => {
  // the Findings card opens on its own after a bake; it is not what these are of
  await page.evaluate(() => { const b = document.getElementById('btn-findings-close'); if (b && !document.getElementById('findings-card').hidden) b.click(); });
  await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, name) }); console.log('  wrote ' + name); };
const rawBox = page => page.evaluate(() => {
  const r = getActiveModel().rawTris, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < r.length; i += 3) for (let k = 0; k < 3; k++) { if (r[i + k] < lo[k]) lo[k] = r[i + k]; if (r[i + k] > hi[k]) hi[k] = r[i + k]; }
  return { lo, hi };
});

withApp(async page => {
  await page.setViewportSize({ width: 1180, height: 780 });
  const id = await loadSTL(page, fx('box_open.stl')); await selectModel(page, id);
  await page.evaluate(() => { document.getElementById('menu-add').open = true; });

  console.log('ghost, Thicken out');
  await frame(page, [0.9, 0.75, 1.0], 1.15);
  await page.click('#btn-thicken-out');
  await shot(page, '1-ghost-out-1.5.png');
  await slideTo(page, 3);
  await shot(page, '2-ghost-out-3.png');
  await page.click('#btn-thicken-cancel');

  console.log('ghost, Thicken in, then Set');
  await frame(page, [0.35, 1.1, 0.9], 1.15);
  await page.click('#btn-thicken-in');
  await slideTo(page, 2);
  await shot(page, '3-ghost-in-2.png');
  await page.click('#btn-thicken-set');
  await page.waitForFunction(() => !nsoThickenLive.on());
  await shot(page, '4-after-set-in-2.png');
  await page.click('#btn-undo'); await page.waitForTimeout(200);

  console.log('per-face, Thicken out');
  const bb = await rawBox(page), mid = [0, 1, 2].map(k => (bb.lo[k] + bb.hi[k]) / 2);
  await frame(page, [0.9, 0.75, 1.0], 1.15);
  await page.click('#btn-thicken-out');
  await slideTo(page, 3);
  await realClick(page, await screenOfRaw(page, [bb.hi[0], mid[1], mid[2]]));
  await shot(page, '5-per-face-out-picked.png');
  await page.click('#btn-thicken-set');
  await page.waitForFunction(() => !nsoThickenLive.on());
  await shot(page, '6-per-face-after-set.png');
  await page.click('#btn-undo'); await page.waitForTimeout(200);

  console.log('per-face, Thicken in');
  await frame(page, [0.05, 1.5, 0.45], 1.15);
  await page.click('#btn-thicken-in');
  await slideTo(page, 3);
  await realClick(page, await screenOfRaw(page, [mid[0], mid[1], bb.lo[2] + 2]));
  await shot(page, '7-per-face-in-floor.png');
  await page.click('#btn-thicken-cancel');
}).catch(e => { console.error(e); process.exit(1); });
