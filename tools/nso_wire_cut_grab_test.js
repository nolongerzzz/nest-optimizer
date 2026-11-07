/* The blade answers only to a press ON it, or on the piece. Real mouse, real app.
     node tools/nso_wire_cut_grab_test.js    exit 0 = every gate held

   THE BUG. The blade carried an invisible hit sheet 12 mm (full blade) / 6 mm
   (sized blade) bigger than itself on every side, so a press on the empty plate
   a grid square or two away from the blade still grabbed it and the drag moved
   the blade. The blade's own sheet and frame are pickable; that padding is gone.

   The blade carries a BALL on its top end as the place to take hold of it (the plate line that used to stand in for one is gone):
   a press on the ball grabs the blade - it does not jump it, as a click on the piece behind the ball would - and a drag from it
   slides the blade.

   GATES (seen from straight above, bar 120 x 70 x 12 along X)
     1. a click on the piece makes the blade jump there (unchanged).
     2. a press on the empty plate 8 mm and 14 mm past the blade's end, then a
        drag along the blade's travel axis, does not grab or move the blade.
     3. a press ON the blade (its edge frame, just past the piece) still grabs it
        and the drag moves it.
     3b. the ball on the blade's top end: from a diagonal camera a press on it grabs the blade (it stays where it was, where a
        click on the piece behind the ball would have moved it several mm) and a drag slides it.
     4. a sized blade (Sized blade pressed) is no easier to grab from the plate:
        a press 8 mm past the piece grabs nothing (no regression guard; the full
        blade's padding was the one that reached the plate).  */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function box(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-grab-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const PAGE = `
window.__piece = id => (state.placed.find(p => p && p.sourceId === id) || {}).mesh || null;
window.__proj = function (p) {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
};
window.__topDown = function () {
  const c = state.camera, t = state.controls.target;
  c.position.set(t.x, 190, t.z + 0.001);
  c.lookAt(t);
  state.controls.update();
};
/* The blade's frame, world space: its centre, and its half-extent along the
   across axis that lies flat on the plate (the one a plate press can reach). */
window.__bladeInfo = function () {
  const f = state.cutHelper && state.cutHelper.children.find(c => c.userData.cutFrame);
  if (!f) return null;
  const bb = new THREE.Box3().setFromObject(f);
  return { min: bb.min.toArray(), max: bb.max.toArray(), cutT: state.cutT };
};
`;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PAGE });
  const id = await loadSTL(page, stl('bar.stl', box(120, 70, 12)));
  await page.click('#menu-cut > summary');
  await page.waitForTimeout(50);
  await page.evaluate(() => __topDown());
  await page.waitForTimeout(100);

  const c0 = await page.evaluate(id => {
    const c = new THREE.Box3().setFromObject(__piece(id)).getCenter(new THREE.Vector3());
    return { c: c.toArray(), s: __proj([c.x, c.y, c.z]) };
  }, id);

  /* 1. click on the piece, off-centre along the bar. */
  const at = await page.evaluate(([c]) => __proj([c[0] + 30, c[1] + 6, c[2]]), [c0.c]);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(80);
  const b1 = await page.evaluate(() => __bladeInfo());
  check('a click on the piece drops the blade', !!b1);
  const bladeX = b1 ? (b1.min[0] + b1.max[0]) / 2 : NaN;
  check('the blade jumped to the click (30 mm along the bar)', Math.abs(bladeX - (c0.c[0] + 30)) < 1.5, 'blade x ' + bladeX.toFixed(2) + ', click x ' + (c0.c[0] + 30).toFixed(2));

  /* 3b. the ball: from an oblique camera (so the piece behind the ball is a different point from the ball's own), a press on the
     ball grabs the blade, and a drag from it slides the blade along the bar. */
  {
    await page.evaluate(() => {
      const c = state.camera, t = state.controls.target;
      c.position.set(t.x + 110, 90, t.z + 110); c.lookAt(t); state.controls.update();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const c = state.camera, t = state.controls.target; c.position.set(t.x + 110, 90, t.z + 110); c.lookAt(t); state.controls.update(); });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => { const b = new THREE.Box3().setFromObject(state.cutHelper.children.find(c => c.userData.cutBlade)); return { x: b.getCenter(new THREE.Vector3()).x, t: state.cutT }; });
    const bp = await page.evaluate(() => { const ball = state.cutHelper.children.find(c => c.userData.cutBall); ball.updateMatrixWorld(true);
      const w = new THREE.Vector3().setFromMatrixPosition(ball.matrixWorld); return { w: w.toArray(), px: __proj(w.toArray()) }; });
    await page.mouse.move(bp.px.x, bp.px.y);
    await page.mouse.down();
    const held = await page.evaluate(() => ({ dragging: state.cutDragging, x: new THREE.Box3().setFromObject(state.cutHelper.children.find(c => c.userData.cutBlade)).getCenter(new THREE.Vector3()).x }));
    check('a press on the ball takes hold of the blade', held.dragging === true);
    check('...and does not move it (a click on the piece behind the ball would have jumped it several mm)', Math.abs(held.x - before.x) < 0.3, 'blade x ' + before.x.toFixed(2) + ' -> ' + held.x.toFixed(2));
    await page.mouse.move(bp.px.x + 70, bp.px.y, { steps: 8 });
    const dragged = await page.evaluate(() => new THREE.Box3().setFromObject(state.cutHelper.children.find(c => c.userData.cutBlade)).getCenter(new THREE.Vector3()).x);
    await page.mouse.up();
    check('a drag from the ball slides the blade along the bar', Math.abs(dragged - before.x) > 5, 'moved ' + (dragged - before.x).toFixed(2) + ' mm');
    await page.evaluate(() => __topDown());
    await page.waitForTimeout(300);
  }

  /* A drag along the bar (screen x) from a plate point past the blade's far end. */
  /* A plate press that grabs nothing orbits the view (and the orbit damps out
     over a few frames): put the camera back above the bar and let it settle,
     so the pixel worked out next is the pixel pressed. */
  const settle = async () => {
    await page.evaluate(() => { __topDown(); state.controls.update(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { __topDown(); state.controls.update(); });
    await page.waitForTimeout(100);
  };
  const plateDrag = async gap => {
    await settle();
    const b = await page.evaluate(() => __bladeInfo());
    const bx = (b.min[0] + b.max[0]) / 2;
    // Past the blade's far end across the bar (world z) - and past the piece, which a sized
    // blade is narrower than (a press on the piece is a click on the piece, as it should be).
    const pz = await page.evaluate(id => new THREE.Box3().setFromObject(__piece(id)).max.z, id);
    const zEnd = Math.max(b.max[2], pz);
    const p = await page.evaluate(([x, z]) => __proj([x, 0.4, z]), [bx, zEnd + gap]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const dragging = await page.evaluate(() => state.cutDragging);
    await page.mouse.move(p.x + 40, p.y, { steps: 6 });
    await page.mouse.move(p.x + 80, p.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(40);
    const after = await page.evaluate(() => __bladeInfo());
    return { dragging, moved: Math.abs((after.min[0] + after.max[0]) / 2 - bx) };
  };
  for (const gap of [8, 14]) {
    const r = await plateDrag(gap);
    check('plate press ' + gap + ' mm past the blade grabs nothing', !r.dragging && r.moved < 0.05, 'dragging ' + r.dragging + ', blade moved ' + r.moved.toFixed(3) + ' mm');
  }

  /* 3. a press on the blade's own frame grabs it. The frame's end edge runs along
     world z at the blade's far end; press just inside it and drag along x. */
  {
    await settle();
    const b = await page.evaluate(() => __bladeInfo());
    const bx = (b.min[0] + b.max[0]) / 2;
    const p = await page.evaluate(([x, z, y]) => __proj([x, y, z]), [bx, b.max[2], (b.min[1] + b.max[1]) / 2]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const dragging = await page.evaluate(() => state.cutDragging);
    await page.mouse.move(p.x + 40, p.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(40);
    const after = await page.evaluate(() => __bladeInfo());
    const moved = (after.min[0] + after.max[0]) / 2 - bx;
    check('a press on the blade frame grabs it and the drag moves it', dragging && Math.abs(moved) > 2, 'dragging ' + dragging + ', moved ' + moved.toFixed(2) + ' mm');
  }

  /* 4. sized blade. */
  const sized = await page.$('#btn-cut-blade-sized');
  if (sized) {
    await sized.click();
    await page.waitForTimeout(100);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(100);
    const r = await plateDrag(8);
    check('sized blade: plate press 8 mm clear grabs nothing', !r.dragging && r.moved < 0.05, 'dragging ' + r.dragging + ', moved ' + r.moved.toFixed(3));
  } else {
    console.log('  note  no Sized blade control found by selector; sized gate skipped');
  }

  check('no uncaught page errors', !(logs && logs.errors && logs.errors.length), logs && logs.errors && logs.errors.join(' | '));
}).then(() => { console.log('\n----------------------------------------------------------\n' + (fails ? 'FAIL ' + fails : 'PASS')); process.exit(fails ? 1 : 0); })
  .catch(e => { console.error('HARNESS FAIL', e); process.exit(2); });
