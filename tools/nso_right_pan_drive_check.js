#!/usr/bin/env node
/* Right-drag pans the view: the ticket's drive-check, in the real app, with
   screenshots.

   node tools/nso_right_pan_drive_check.js [outDir]     exit 0 = every step held

   Real mouse drags with the right button (Playwright, real Chromium). A
   right press that travels more than a few pixels is a screen-space pan
   (OrbitControls RIGHT: PAN); one that does not is the click it always was -
   select the piece under the pointer and open the context menu. The pan is
   measured, not eyeballed: a point at the controls' target depth must land
   exactly where the pointer took it, whatever the orbit angle.

   Screenshots go to outDir (default docs/right-pan). The pieces are the
   80 x 40 x 20 box fixture and tape_on-edge-single, the pair the rotate-ring
   checks use. */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'right-pan'));
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const px = (a) => '(' + a[0].toFixed(2) + ', ' + a[1].toFixed(2) + ')';

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const H = window.__p = {};
    H.rect = () => { const r = state.renderer.domElement.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    H.centre = () => { const r = H.rect(); return [r[0] + r[2] / 2, r[1] + r[3] / 2]; };
    H.proj = (a) => {
      const r = H.rect();
      state.camera.updateMatrixWorld(true);
      const p = new THREE.Vector3().fromArray(a).project(state.camera);
      return [r[0] + (p.x * 0.5 + 0.5) * r[2], r[1] + (-p.y * 0.5 + 0.5) * r[3]];
    };
    /* view depth of a world point over the target's: a screen-space pan moves
       a point at depth d by (pointer travel) * dTarget / d */
    H.depthRatio = (a) => {
      state.camera.updateMatrixWorld(true);
      const v = new THREE.Vector3().fromArray(a).applyMatrix4(state.camera.matrixWorldInverse);
      return -v.z / state.camera.position.distanceTo(state.controls.target);
    };
    H.cam = () => ({
      pos: state.camera.position.toArray(), tgt: state.controls.target.toArray(),
      quat: state.camera.quaternion.toArray(),
      dist: state.camera.position.distanceTo(state.controls.target)
    });
    /* a point on bare plate, on the canvas and clear of the tool buttons: a
       left press there orbits (hitPlateSurface), it lands on no piece */
    H.barePlate = () => {
      const r = H.rect();
      for (let x = -80; x <= 80; x += 10) for (let z = -80; z <= 80; z += 10) {
        const s = H.proj([x, 0, z]), e = { clientX: s[0], clientY: s[1] };
        if (s[0] < r[0] + 90 || s[0] > r[0] + r[2] - 40 || s[1] < r[1] + 100 || s[1] > r[1] + r[3] - 40) continue;
        if (hitPlateSurface(e) && pickPlacedIndexFromEvent(e) < 0) return s;
      }
      return null;
    };
    H.menuOpen = () => !document.getElementById('ctx-menu').classList.contains('hidden');
    H.ctxLog = [];
    const c = state.renderer.domElement;
    ['pointerdown', 'pointerup', 'contextmenu'].forEach(t => c.addEventListener(t, (e) => {
      if (e.button === 2 || t === 'contextmenu') H.ctxLog.push(t);
    }, true));
  });
  const N = page.evaluate.bind(page);
  const frames = (n) => N(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
  /* Where the drag lands. With damping on, OrbitControls hands the pan over
     as a geometric series (a dampingFactor share of what is left, each
     frame), so the view converges on the full pan without ever quite
     arriving. One undamped update() applies the remainder in one go and
     zeroes it - the same flush G-scope's fitView does before it re-frames -
     so a reading is the converged pan exactly, without waiting it out. */
  const settle = async () => {
    await frames(2);
    await N(() => { const c = state.controls; c.enableDamping = false; c.update(); c.enableDamping = true; });
    await frames(1);
    return N(() => window.__p.cam());
  };
  const shot = async (name, el) => {
    await frames(3);
    const opts = { path: path.join(OUT, name + '.png') };
    if (el) await page.locator(el).screenshot(opts);
    else await page.screenshot(Object.assign(opts, { clip: { x: 300, y: 60, width: 1100, height: 800 } }));
    console.log('   [screenshot] ' + name + '.png');
  };
  const drag = async (button, x0, y0, dx, dy, steps) => {
    steps = steps || 20;
    await page.mouse.move(x0, y0);
    await page.mouse.down({ button });
    for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + dx * i / steps, y0 + dy * i / steps);
    await page.mouse.up({ button });
    await settle();
  };
  const rightDrag = (x0, y0, dx, dy, steps) => drag('right', x0, y0, dx, dy, steps);
  const undo0 = await N(() => state.undoStack.length);
  const near = (a, b, tol) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const sameQuat = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

  /* A pan in screen space, measured: the target as it was before the drag
     is a world point at the target depth, so it must end up exactly where
     the pointer took it. */
  const panCheck = async (label, x0, y0, dx, dy) => {
    const c0 = await settle();
    const before = await N(t => window.__p.proj(t), c0.tgt);
    await rightDrag(x0, y0, dx, dy);
    const c1 = await N(() => window.__p.cam());
    const after = await N(t => window.__p.proj(t), c0.tgt);
    const moved = [after[0] - before[0], after[1] - before[1]];
    check(label + ': the point at the target depth followed the pointer (' + dx + ', ' + dy + ') px to 0.5 px',
      near(moved, [dx, dy], 0.5), 'moved ' + px(moved));
    if (dx) check(label + ': drag ' + (dx > 0 ? 'right' : 'left') + ', the view slides ' + (dx > 0 ? 'right' : 'left'), Math.sign(moved[0]) === Math.sign(dx));
    if (dy) check(label + ': drag ' + (dy < 0 ? 'up' : 'down') + ', the view slides ' + (dy < 0 ? 'up' : 'down'), Math.sign(moved[1]) === Math.sign(dy));
    check(label + ': no rotation (camera orientation identical)', sameQuat(c0.quat, c1.quat));
    check(label + ': no zoom (camera-target distance identical to 1e-9)', Math.abs(c0.dist - c1.dist) < 1e-9,
      c0.dist.toFixed(6) + ' -> ' + c1.dist.toFixed(6));
    return { c0, c1 };
  };

  console.log('\n=== 1. orbit the plate off to one side, right-drag it back to centre ===');
  /* Look-at on the tape (the existing alt-click), then a real left-drag orbit
     on bare plate: the plate swings off to the side, as in the ticket. (The
     alt-click also reports "Moved model #2" in the status line though nothing
     moved - app-core's move drag starts under app-ux's look-at. Pre-existing,
     not this change; the undo check below shows nothing was pushed.) */
  const tapeAt = await N(() => window.__p.proj(state.placed[1].mesh.position.toArray()));
  await page.keyboard.down('Alt');
  await page.mouse.click(tapeAt[0], tapeAt[1]);
  await page.keyboard.up('Alt');
  await settle();
  const bare = await N(() => window.__p.barePlate());
  const camLook = await N(() => window.__p.cam());
  await drag('left', bare[0], bare[1], 40, 0, 10);
  const camOrb = await N(() => window.__p.cam());
  check('the left-drag orbited (camera turned)', !sameQuat(camLook.quat, camOrb.quat));
  const C = await N(() => window.__p.centre());
  const plate0 = await N(() => window.__p.proj([0, 0, 0]));
  const off0 = Math.hypot(plate0[0] - C[0], plate0[1] - C[1]);
  check('the plate centre is off to one side (> 150 px from the canvas centre)', off0 > 150,
    'plate centre at ' + px(plate0) + ', canvas centre ' + px(C) + ', ' + off0.toFixed(1) + ' px off');
  await N(() => { hideCtxMenu(); window.__p.ctxLog.length = 0; });
  const sel0 = await N(() => state.selectedIndex);
  await shot('01-orbited-plate-off-to-one-side');
  /* The drag that puts the plate's centre on the canvas centre: the screen
     offset, scaled by the plate centre's depth over the target's. */
  const k = await N(() => window.__p.depthRatio([0, 0, 0]));
  const want = [(C[0] - plate0[0]) * k, (C[1] - plate0[1]) * k];
  const p1 = await panCheck('back to centre', plate0[0], plate0[1], Math.round(want[0]), Math.round(want[1]));
  const plate1 = await N(() => window.__p.proj([0, 0, 0]));
  const off1 = Math.hypot(plate1[0] - C[0], plate1[1] - C[1]);
  check('the plate centre is back on the canvas centre (to 2 px - the drag is whole pixels)', off1 <= 2,
    'now ' + px(plate1) + ', ' + off1.toFixed(2) + ' px off');
  check('the pan opened no context menu', !(await N(() => window.__p.menuOpen())));
  check('the pan changed no selection', (await N(() => state.selectedIndex)) === sel0, 'selectedIndex ' + sel0);
  await shot('02-right-dragged-back-to-centre');

  console.log('\n=== 2. screen space at any orbit angle: over a piece, and over nothing ===');
  const boxAt = await N(() => window.__p.proj(state.placed[0].mesh.position.toArray()));
  await panCheck('oblique view, press on the box', boxAt[0], boxAt[1], 120, -80);
  /* a steep orbit: drag down on bare plate tips the camera up over the plate */
  const bare2 = await N(() => window.__p.barePlate());
  const camA = await N(() => window.__p.cam());
  await drag('left', bare2[0], bare2[1], 0, 120);
  const camB = await N(() => window.__p.cam());
  check('the second orbit turned the camera again', !sameQuat(camA.quat, camB.quat));
  await panCheck('steep view, press on empty background', C[0] + 420, C[1] - 330, -150, 90);
  check('undo stack untouched so far', (await N(() => state.undoStack.length)) === undo0);
  /* back to a working view for the click checks */
  await N(() => {
    state.camera.position.set(160, 180, 200); state.controls.target.set(0, 0, 0); state.controls.update();
  });
  await settle();

  console.log('\n=== 3. right-click a piece without moving: select + context menu, as before ===');
  await N(() => { selectPlaced(1); hideCtxMenu(); window.__p.ctxLog.length = 0; });
  await frames(3);
  const box2 = await N(() => window.__p.proj(state.placed[0].mesh.position.toArray()));
  const camC0 = await N(() => window.__p.cam());
  await page.mouse.move(box2[0], box2[1]);
  await page.mouse.down({ button: 'right' });
  const menuMidPress = await N(() => window.__p.menuOpen());
  await page.mouse.up({ button: 'right' });
  await frames(3);
  const ev3 = await N(() => window.__p.ctxLog.slice());
  console.log('   events: ' + ev3.join(' -> '));
  check('Chromium on Linux sends contextmenu at the press (the path that waits for the release)',
    ev3.join() === 'pointerdown,contextmenu,pointerup', ev3.join(' -> '));
  check('no menu while the button is still down (it could yet be a pan)', !menuMidPress);
  check('on release the context menu is open', await N(() => window.__p.menuOpen()));
  check('the box (piece #1) is selected', (await N(() => state.selectedIndex)) === 0);
  const ctxPos = await N(() => { const m = document.getElementById('ctx-menu'); return [parseFloat(m.style.left), parseFloat(m.style.top)]; });
  check('the menu sits at the click', near(ctxPos, box2, 1), 'menu at ' + px(ctxPos) + ', click ' + px(box2));
  check('status as before', /^Selected #1 - Delete piece or press Delete/.test(await N(() => document.getElementById('status').textContent)));
  check('the menu still holds Export and Delete', await N(() => !!document.getElementById('ctx-export') && /Delete/.test(document.getElementById('ctx-menu').textContent)));
  const camC1 = await settle();
  const tgtMove = Math.hypot(...camC0.tgt.map((x, i) => x - camC1.tgt[i]));
  check('a still right-click moves no camera (no rotation; target within 1e-6 mm)',
    sameQuat(camC0.quat, camC1.quat) && tgtMove < 1e-6, tgtMove.toExponential(2) + ' mm');
  await shot('03-right-click-piece-menu-opens');
  /* a right-click on bare background still opens nothing */
  await N(() => hideCtxMenu());
  await page.mouse.click(C[0] + 430, C[1] - 330, { button: 'right' });
  await frames(3);
  check('right-click on empty background: no menu, as before', !(await N(() => window.__p.menuOpen())));

  console.log('\n=== 4. right-press on a piece, drag 40 px, release: no menu ===');
  await N(() => { hideCtxMenu(); selectPlaced(0); window.__p.ctxLog.length = 0; });
  const tape4 = await N(() => window.__p.proj(state.placed[1].mesh.position.toArray()));
  const c4 = await settle();
  const t4 = await N(t => window.__p.proj(t), c4.tgt);
  await rightDrag(tape4[0], tape4[1], 40, 0, 8);
  const ev4 = await N(() => window.__p.ctxLog.slice());
  console.log('   events: ' + ev4.join(' -> '));
  check('the browser did send contextmenu (at the press) - and it was held', ev4.indexOf('contextmenu') >= 0);
  check('no context menu after the 40 px drag', !(await N(() => window.__p.menuOpen())));
  check('the piece under the press was NOT selected (box stays selected)', (await N(() => state.selectedIndex)) === 0);
  const t4b = await N(t => window.__p.proj(t), c4.tgt);
  check('the view panned 40 px right', near([t4b[0] - t4[0], t4b[1] - t4[1]], [40, 0], 0.5), px([t4b[0] - t4[0], t4b[1] - t4[1]]));
  await shot('04-right-drag-40px-no-menu');
  /* the slop: 3 px of jitter is still a click */
  await N(() => { hideCtxMenu(); selectPlaced(0); });
  const tape4c = await N(() => window.__p.proj(state.placed[1].mesh.position.toArray()));
  await rightDrag(tape4c[0], tape4c[1], 3, 0, 3);
  check('a 3 px wobble is still a click: menu opens, the tape is selected',
    (await N(() => window.__p.menuOpen())) && (await N(() => state.selectedIndex)) === 1);
  await N(() => hideCtxMenu());

  console.log('\n=== 5. contextmenu AFTER the release (the Windows order), through the same handlers ===');
  /* Real Chromium here only produces the press-time order, so the other one
     is fed to the app's own handlers directly: press, (move), release, then
     contextmenu. */
  const win = await N(() => {
    const at = window.__p.proj(state.placed[0].mesh.position.toArray());
    const ev = (type, x, y) => ({ type, button: 2, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    hideCtxMenu(); selectPlaced(1);
    onCanvasPointerDown(ev('pointerdown', at[0], at[1]));
    onCanvasPointerUp(ev('pointerup', at[0], at[1]));
    const before = window.__p.menuOpen();
    onCanvasContextMenu(ev('contextmenu', at[0], at[1]));
    const click = { before, menu: window.__p.menuOpen(), sel: state.selectedIndex };
    hideCtxMenu(); selectPlaced(1);
    onCanvasPointerDown(ev('pointerdown', at[0], at[1]));
    onCanvasPointerMove(ev('pointermove', at[0] + 40, at[1]));
    onCanvasPointerUp(ev('pointerup', at[0] + 40, at[1]));
    onCanvasContextMenu(ev('contextmenu', at[0] + 40, at[1]));
    const pan = { menu: window.__p.menuOpen(), sel: state.selectedIndex };
    hideCtxMenu();
    return { click, pan };
  });
  check('Windows order, still click: nothing at the release, menu + select at contextmenu',
    !win.click.before && win.click.menu && win.click.sel === 0, JSON.stringify(win.click));
  check('Windows order, 40 px drag: no menu, no select', !win.pan.menu && win.pan.sel === 1, JSON.stringify(win.pan));

  console.log('\n=== 6. Rotate open: right-drag from the arrowhead pans; the rings come along; no rotation ===');
  await N(() => { selectPlaced(0); });
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(200);
  await settle();
  const owner0 = await N(() => nsoInputMode.active());
  check('Rotate owns the input', owner0 === 'menu-rotate', owner0);
  const r0 = await N(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles');
    const p = state.placed[0]; p.mesh.updateMatrixWorld(true);
    return { q: p.mesh.quaternion.toArray(), pos: p.mesh.position.toArray(), rings: g.position.toArray(),
             h: window.nsoRotate.handleScreen('turn', 1), kids: g.children.length,
             k: window.__p.depthRatio(g.position.toArray()), ctr: window.__p.proj(g.position.toArray()) };
  });
  check('the rings are drawn', r0.kids > 0, r0.kids + ' objects');
  await shot('05-rotate-open-before-pan');
  await rightDrag(r0.h.x, r0.h.y, 150, 60);
  const r1 = await N(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles');
    const p = state.placed[0]; p.mesh.updateMatrixWorld(true);
    return { q: p.mesh.quaternion.toArray(), pos: p.mesh.position.toArray(), rings: g.position.toArray(),
             h: window.nsoRotate.handleScreen('turn', 1), kids: g.children.length,
             ctr: window.__p.proj(g.position.toArray()), dragging: window.nsoRotate.dragging() };
  });
  check('no rotation applied: the piece quaternion is identical', sameQuat(r0.q, r1.q));
  check('the piece did not move', JSON.stringify(r0.pos) === JSON.stringify(r1.pos));
  check('the rings stay on the piece (same world position)', JSON.stringify(r0.rings) === JSON.stringify(r1.rings));
  const ringMove = [r1.ctr[0] - r0.ctr[0], r1.ctr[1] - r0.ctr[1]];
  check('the rings came along on screen: moved (150, 60) px x their depth ratio (' + (1 / r0.k).toFixed(3) + ')',
    near(ringMove, [150 / r0.k, 60 / r0.k], 0.5), 'moved ' + px(ringMove));
  /* The arrowhead travels the same way but not the same distance: the ring's
     radius in mm follows the camera's distance to the piece (its steady
     on-screen size, app-rotate-handles.js), and a pan changes that distance. */
  const hMove = [r1.h.x - r0.h.x, r1.h.y - r0.h.y];
  const cosH = (hMove[0] * ringMove[0] + hMove[1] * ringMove[1]) / (Math.hypot(...hMove) * Math.hypot(...ringMove));
  check('the arrowhead moved along with them (same direction, cos > 0.99)', cosH > 0.99, 'moved ' + px(hMove) + ', cos ' + cosH.toFixed(4));
  check('no ring drag left running', r1.dragging === false);
  check('Rotate still owns the input, menu still open', (await N(() => nsoInputMode.active())) === 'menu-rotate' &&
    (await N(() => document.getElementById('menu-rotate').open)));
  check('no context menu', !(await N(() => window.__p.menuOpen())));
  await shot('06-rotate-open-after-pan-rings-came-along');
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);
  check('undo stack unchanged by every pan and right-click so far', (await N(() => state.undoStack.length)) === undo0,
    undo0 + ' -> ' + (await N(() => state.undoStack.length)));

  console.log('\n=== 7. G-scope: right-drag pans its view ===');
  await N(() => window.NSO_MICROSCOPE.openPlate());
  await page.waitForFunction(() => window.NSO_MICROSCOPE.isOpen() && window.NSO_MICROSCOPE.getDoc());
  await page.waitForTimeout(400);
  await N(() => {
    const G = window.__g = {};
    G.v = () => window.NSO_MICROSCOPE.getView();
    G.rect = () => { const r = G.v().renderer.domElement.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    G.proj = (a) => {
      const v = G.v(), r = G.rect(); v.camera.updateMatrixWorld(true);
      const p = new THREE.Vector3().fromArray(a).project(v.camera);
      return [r[0] + (p.x * 0.5 + 0.5) * r[2], r[1] + (-p.y * 0.5 + 0.5) * r[3]];
    };
    G.cam = () => { const v = G.v(); return { pos: v.camera.position.toArray(), tgt: v.controls.target.toArray(),
      quat: v.camera.quaternion.toArray(), dist: v.camera.position.distanceTo(v.controls.target) }; };
  });
  const gsettle = async () => {
    await frames(2);
    await N(() => { const c = window.__g.v().controls; c.enableDamping = false; c.update(); c.enableDamping = true; });
    await frames(1);
    return N(() => window.__g.cam());
  };
  const gpan = async (label, x0, y0, dx, dy) => {
    const c0 = await gsettle();
    const b = await N(t => window.__g.proj(t), c0.tgt);
    await page.mouse.move(x0, y0);
    await page.mouse.down({ button: 'right' });
    for (let i = 1; i <= 20; i++) await page.mouse.move(x0 + dx * i / 20, y0 + dy * i / 20);
    await page.mouse.up({ button: 'right' });
    const c1 = await gsettle();
    const a = await N(t => window.__g.proj(t), c0.tgt);
    const m = [a[0] - b[0], a[1] - b[1]];
    check(label + ': the point at the target depth followed the pointer (' + dx + ', ' + dy + ') to 0.5 px', near(m, [dx, dy], 0.5), 'moved ' + px(m));
    check(label + ': no rotation, no zoom', sameQuat(c0.quat, c1.quat) && Math.abs(c0.dist - c1.dist) < 1e-9);
  };
  const gr = await N(() => window.__g.rect());
  const gc = [gr[0] + gr[2] / 2, gr[1] + gr[3] / 2];
  check('G-scope mapping: left orbit, middle zoom, right pan, screen space',
    await N(() => { const c = window.__g.v().controls; return c.mouseButtons.LEFT === THREE.MOUSE.ROTATE &&
      c.mouseButtons.MIDDLE === THREE.MOUSE.DOLLY && c.mouseButtons.RIGHT === THREE.MOUSE.PAN && c.screenSpacePanning && c.enablePan; }));
  await shot('07-gscope-before-pan', '#microscope');
  await gpan('G-scope, orbit mode', gc[0], gc[1], 140, -70);
  await shot('08-gscope-after-right-drag-pan', '#microscope');
  /* select mode, a capture box on the part: a right-drag that starts on the
     box's own centre handle pans - the handles are left-button grabs */
  await page.click('#ms-mode-select');
  const boxes0 = await N(() => {
    const d = window.NSO_MICROSCOPE.getDoc();
    window.__g.ball = window.NSO_MICROSCOPE.addBoxAt(d.cx, d.cy, 5, 8, 3);
    return JSON.stringify(window.NSO_MICROSCOPE.boxes());
  });
  await gsettle();
  const hAt = await N(() => { const w = new THREE.Vector3(); window.__g.ball.handle.getWorldPosition(w); return window.__g.proj(w.toArray()); });
  await gpan('G-scope, select mode, press on the box handle', hAt[0], hAt[1], -110, 50);
  check('the capture box did not move or resize, and no box was dropped', (await N(() => JSON.stringify(window.NSO_MICROSCOPE.boxes()))) === boxes0);
  await N(() => window.NSO_MICROSCOPE.close());
  await page.waitForTimeout(150);

  check('undo stack unchanged by the whole run', (await N(() => state.undoStack.length)) === undo0,
    undo0 + ' -> ' + (await N(() => state.undoStack.length)));
  const errs = logs.filter(l => /^\[(pageerror|error)\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? fails + ' FAILED' : 'all right-pan drive checks passed'));
  if (fails) process.exitCode = 1;
}).catch(e => { console.error(e); process.exit(1); });
