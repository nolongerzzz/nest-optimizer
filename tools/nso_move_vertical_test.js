#!/usr/bin/env node
/* The Move menu: the guidance arrows, and vertical placement mode.
     node tools/nso_move_vertical_test.js       exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await page.waitForTimeout(500);
  await page.evaluate(() => { selectPlaced(0); document.getElementById('menu-move').open = true; });
  await page.waitForTimeout(300);

  const api = await page.evaluate(() => typeof window.nsoMoveVertical);
  check('the module is on the page', api === 'object', 'typeof = ' + api);
  const K = await page.evaluate(() => ({ step: window.nsoMoveVertical.step,
                                         margin: window.nsoMoveVertical.camMargin }));

  /* A fixed screen pixel is not a fair probe here: this mode swings the
     camera to eye level, and the row of pixels that hit the bed under a
     three-quarter view sit on the horizon under a level one. So aim at the
     piece's own footprint - project (x, 0, z) back to a client point, and
     the ray through it lands on the bed by construction, whichever camera
     is looking. The same point is then used on both sides of the checkbox,
     which is what makes the refusal mean anything: one click point, refused
     while the mode is on and accepted once it is off. */
  await page.evaluate(() => {
    window.__plateClick = () => {
      const r = state.renderer.domElement.getBoundingClientRect();
      const p = state.placed[0];
      const v = new THREE.Vector3(p.x, 0, p.z).project(state.camera);
      return { clientX: r.left + (v.x + 1) / 2 * r.width,
               clientY: r.top + (1 - v.y) / 2 * r.height };
    };
  });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. four arrows, drawn and NOT clickable ===');
  {
    const a = await page.evaluate(() => {
      const mv = window.nsoMoveVertical;
      mv.refreshArrows();
      const g = state.scene.getObjectByName('nso-move-arrows');
      const names = g ? g.children.map(c => c.userData.nsoMoveArrow) : [];
      /* The real question is not "is there a listener" but "can the picker
         ever return one of these". Raycast the whole scene through an arrow
         and see what comes back. */
      const hitsAnArrow = (() => {
        if (!g || !g.children.length) return null;
        const c = g.children[0];
        const w = c.getWorldPosition(new THREE.Vector3());
        const dir = w.clone().sub(state.camera.position).normalize();
        const rc = new THREE.Raycaster(state.camera.position.clone(), dir);
        return rc.intersectObjects(state.scene.children, true)
          .some(h => h.object && h.object.userData.nsoMoveArrow);
      })();
      return { count: g ? g.children.length : 0, names: names,
               pickable: mv.arrowsPickable(), hitsAnArrow: hitsAnArrow,
               visible: !!(g && g.visible) };
    });
    check('four arrows are drawn around the piece', a.count === 4 && a.visible,
      a.count + ': ' + a.names.join(', '));
    check('one for each direction', ['fwd', 'back', 'left', 'right']
      .every(n => a.names.indexOf(n) !== -1), a.names.join(', '));
    check('none of them carries a working raycast', a.pickable === false);
    check('...so a ray aimed straight at one cannot return it - decoration, provably',
      a.hitsAnArrow === false, String(a.hitsAnArrow));

    const shut = await page.evaluate(() => {
      document.getElementById('menu-move').open = false;
      window.nsoMoveVertical.refreshArrows();
      const g = state.scene.getObjectByName('nso-move-arrows');
      const r = { visible: !!(g && g.visible) };
      document.getElementById('menu-move').open = true;
      window.nsoMoveVertical.refreshArrows();
      r.backAgain = !!(state.scene.getObjectByName('nso-move-arrows').visible);
      return r;
    });
    check('they are shown while Move is open and put away when it is not',
      !shut.visible && shut.backAgain, JSON.stringify(shut));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. the checkbox: camera, slider, and drag going off ===');
  {
    const c = await page.evaluate(() => {
      const mv = window.nsoMoveVertical;
      mv.setOn(false);
      const p = state.placed[0];
      const before = { cam: state.camera.position.clone(),
                       slider: document.getElementById('move-vert-wrap').hidden };
      mv.setOn(true);
      const plate = getCurrentPlate();
      const camR = Math.hypot(state.camera.position.x, state.camera.position.z);
      return {
        wasHidden: before.slider,
        on: mv.on(),
        checkbox: document.getElementById('chk-move-vertical').checked,
        camMoved: state.camera.position.distanceTo(before.cam) > 1,
        camY: +state.camera.position.y.toFixed(6),
        pieceY: +p.mesh.position.y.toFixed(6),
        camR: +camR.toFixed(2),
        plateHalf: Math.max(plate.w, plate.d) / 2,
        sliderShown: !document.getElementById('move-vert-wrap').hidden,
        dragRefused: startMoveDrag(0, window.__plateClick()) === false,
        dragging: !!state.moveDragging,
        why: (document.getElementById('status') || {}).textContent || ''
      };
    });
    check('the slider is hidden until the box is ticked', c.wasHidden);
    check('ticking it turns the mode on', c.on && c.checkbox);
    check('the camera moves', c.camMoved);
    /* Horizon: the eye is at the piece's own height, so the view is level
       with it rather than looking down - which is the only way a gap between
       two stacked pieces is visible at all. */
    check('...to eye level with the piece - a horizon view, not a top-down one',
      near(c.camY, c.pieceY, 1e-6), 'cam y ' + c.camY + ' vs piece y ' + c.pieceY);
    check('...positioned just beyond the plate edge',
      c.camR > c.plateHalf && near(c.camR, c.plateHalf + K.margin, 1),
      c.camR + ' mm out, plate half ' + c.plateHalf + ' + margin ' + K.margin);
    check('the slider appears', c.sliderShown);
    check('free drag is genuinely off - startMoveDrag refuses and nothing begins',
      c.dragRefused && !c.dragging, JSON.stringify({ refused: c.dragRefused, dragging: c.dragging }));
    /* Matched on the refusal's own wording, not just the word "vertical" -
       the line the mode writes when it switches on also carries that, so a
       loose match here would pass with the guard taken out. */
    check('...and it says why, rather than failing silently',
      /clear the box/i.test(c.why), c.why);

    const off = await page.evaluate(() => {
      const mv = window.nsoMoveVertical;
      const camDuring = state.camera.position.clone();
      mv.setOn(false);
      return { on: mv.on(),
               checkbox: document.getElementById('chk-move-vertical').checked,
               sliderHidden: document.getElementById('move-vert-wrap').hidden,
               dragOk: startMoveDrag(0, window.__plateClick()) !== false,
               camKept: state.camera.position.distanceTo(camDuring) < 1e-6 };
    });
    await page.evaluate(() => { if (state.moveDragging) endMoveDrag(); });
    check('unticking turns it off and hides the slider',
      !off.on && !off.checkbox && off.sliderHidden, JSON.stringify(off));
    /* The control for the assertion above: the very same click point, on the
       very same piece, now starts a drag. Without this pair the refusal
       could just as well have been a ray that missed the bed. */
    check('...drag works again - same click point, now accepted', off.dragOk);
    check('...and the camera stays where it ended up, no snap back', off.camKept);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. the step is meaningfully smaller than what it replaced ===');
  {
    const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    const oldLift = (core.match(/function liftSelected[\s\S]*?const step = (\d+(?:\.\d+)?)/) || [])[1];
    const nudge = (core.match(/const NUDGE_MM = (\d+(?:\.\d+)?)/) || [])[1];
    check('the new step is 0.25 mm', K.step === 0.25, K.step + ' mm');
    check('...which is smaller than the 2 mm click increment it replaces',
      Number(oldLift) === 2 && K.step < Number(oldLift) / 4,
      'was ' + oldLift + ' mm a click, now ' + K.step + ' mm - ' +
      (Number(oldLift) / K.step) + 'x finer');
    check('...and smaller than the horizontal nudge too', K.step < Number(nudge),
      'NUDGE_MM ' + nudge + ' vs ' + K.step);

    const l = await page.evaluate(() => {
      const mv = window.nsoMoveVertical, p = state.placed[0];
      mv.setOn(true);
      p.liftY = 0; applyMeshRotation(p);
      const one = (mv.lift(1), p.liftY);
      for (let i = 0; i < 3; i++) mv.lift(1);
      const four = p.liftY;
      mv.lift(-1);
      const back = p.liftY;
      p.liftY = 0; applyMeshRotation(p);
      mv.lift(-1);
      const floor = p.liftY;
      return { one: one, four: four, back: back, floor: floor };
    });
    check('one press lifts exactly one step', near(l.one, 0.25, 1e-9), l.one + ' mm');
    check('four presses make a millimetre', near(l.four, 1, 1e-9), l.four + ' mm');
    check('down takes one back off', near(l.back, 0.75, 1e-9), l.back + ' mm');
    check('it will not go below the plate', near(l.floor, 0, 1e-9), l.floor + ' mm');
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. left/right move relative to the NEAREST other piece ===');
  {
    const s = await page.evaluate(() => {
      const mv = window.nsoMoveVertical;
      const p = state.placed[0], q = state.placed[1];
      /* Put the neighbour somewhere deliberately off-axis, so "perpendicular
         to the line between them" and "a world axis" cannot be confused. */
      q.x = p.x + 30; q.z = p.z + 40; applyMeshRotation(q);
      const ax = mv.lateralAxis();
      const tx = q.x - p.x, tz = q.z - p.z, len = Math.hypot(tx, tz);
      const dot = (ax.x * tx + ax.z * tz) / len;
      const bx = p.x, bz = p.z;
      mv.strafe(1);
      const d1 = { dx: p.x - bx, dz: p.z - bz };
      mv.strafe(-1);
      const backX = p.x, backZ = p.z;
      /* Move the neighbour and the frame must follow it - that is what makes
         this situational rather than a fixed axis dressed up. */
      q.x = p.x - 50; q.z = p.z; applyMeshRotation(q);
      const ax2 = mv.lateralAxis();
      return { ax: { x: +ax.x.toFixed(6), z: +ax.z.toFixed(6) }, dot: +dot.toFixed(9),
               d1: { dx: +d1.dx.toFixed(6), dz: +d1.dz.toFixed(6) },
               len: +Math.hypot(d1.dx, d1.dz).toFixed(6),
               returnErr: +Math.hypot(backX - bx, backZ - bz).toFixed(9),
               neighbourDist: +len.toFixed(6),
               ax2: { x: +ax2.x.toFixed(6), z: +ax2.z.toFixed(6) },
               hasRef: !!ax.ref };
    });
    check('the frame is taken from another piece, not a world axis', s.hasRef);
    check('the axis is exactly perpendicular to the line joining them',
      near(s.dot, 0, 1e-9), 'dot = ' + s.dot);
    check('a press moves one step along it', near(s.len, 0.25, 1e-6),
      s.len + ' mm, (' + s.d1.dx + ', ' + s.d1.dz + ')');
    check('...and it is NOT a world axis - both components move',
      Math.abs(s.d1.dx) > 1e-9 && Math.abs(s.d1.dz) > 1e-9, JSON.stringify(s.d1));
    /* Not bit-exact, and it should not be. The reference is the nearest piece
       as it stands *now*, so the first press rotates the line between them by
       step/distance radians and the press back is taken along the new line.
       Four presses therefore trace a very shallow arc around the neighbour
       rather than a straight run - which is the behaviour asked for, a live
       reference rather than a frame latched once. The error that leaves is
       bounded by step x step/distance: here 0.25 x 0.25/50 = 0.00125 mm,
       a two-hundredth of one press. */
    const arcBound = 0.25 * 0.25 / s.neighbourDist;
    check('the opposite press brings it back to well within a hundredth of a step',
      s.returnErr < 0.01 * 0.25 + arcBound,
      s.returnErr + ' mm off, arc bound ' + arcBound.toFixed(6) + ' mm');
    check('moving the neighbour moves the frame with it - situational, as asked',
      JSON.stringify(s.ax) !== JSON.stringify(s.ax2),
      JSON.stringify(s.ax) + ' -> ' + JSON.stringify(s.ax2));

    const alone = await page.evaluate(() => {
      const keep = state.placed.slice(1);
      state.placed.length = 1;
      const ax = window.nsoMoveVertical.lateralAxis();
      keep.forEach(k => state.placed.push(k));
      return { x: ax.x, z: ax.z, ref: !!ax.ref };
    });
    check('with nothing else on the plate it falls back to X and says so',
      alone.x === 1 && alone.z === 0 && !alone.ref, JSON.stringify(alone));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the keys, scoped, with hold-to-repeat ===');
  {
    const k = await page.evaluate(() => {
      const mv = window.nsoMoveVertical, p = state.placed[0];
      const menu = document.getElementById('menu-move');
      const fire = (key, repeat) => document.dispatchEvent(new KeyboardEvent('keydown',
        { key: key, repeat: !!repeat, bubbles: true, cancelable: true }));
      const zero = () => { p.liftY = 0; applyMeshRotation(p); };
      const out = {};
      mv.setOn(true); menu.open = true;
      zero(); fire('ArrowUp');   out.up = p.liftY;
      zero(); fire('ArrowUp'); fire('ArrowDown'); out.upDown = p.liftY;
      zero(); for (let i = 0; i < 8; i++) fire('ArrowUp', true);
      out.held8 = p.liftY;
      const bx = p.x, bz = p.z;
      out.legs = [];
      for (let i = 0; i < 4; i++) {
        const lx = p.x, lz = p.z;
        fire('ArrowRight', true);
        out.legs.push(+Math.hypot(p.x - lx, p.z - lz).toFixed(9));
      }
      out.heldRight = +Math.hypot(p.x - bx, p.z - bz).toFixed(6);
      /* OFF: the mode is what claims these keys, so with the box clear they
         are not ours even with the menu open. */
      mv.setOn(false); zero(); fire('ArrowUp');
      out.offMode = p.liftY;
      /* SHUT: and neither with the mode on but the menu closed. */
      mv.setOn(true); menu.open = false; zero(); fire('ArrowUp');
      out.menuShut = p.liftY;
      menu.open = true; mv.setOn(false);
      return out;
    });
    check('up lifts one step', near(k.up, 0.25, 1e-9), k.up + ' mm');
    check('up then down nets zero', near(k.upDown, 0, 1e-9), k.upDown + ' mm');
    check('holding up keeps lifting - 8 repeats give 2 mm', near(k.held8, 2, 1e-9), k.held8 + ' mm');
    /* Each repeat is one exact step; the net is a hair under 4 x 0.25 because
       the sideways frame follows the neighbour between presses (see 4). */
    check('holding right keeps sliding - every repeat is one exact step',
      k.legs.length === 4 && k.legs.every(l => near(l, 0.25, 1e-9)), k.legs.join(', '));
    check('...and four of them come to 1 mm across',
      near(k.heldRight, 1, 1e-3), k.heldRight + ' mm');
    check('with the mode OFF the arrows are not ours', near(k.offMode, 0, 1e-9), k.offMode + ' mm');
    check('with the Move menu SHUT they are not ours either',
      near(k.menuShut, 0, 1e-9), k.menuShut + ' mm');
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. Raise / Lower are gone, and nothing still points at them ===');
  {
    const gone = await page.evaluate(() => ({
      raise: !!document.getElementById('btn-raise'),
      lower: !!document.getElementById('btn-lower'),
      box: !!document.getElementById('chk-move-vertical'),
      inMenu: [...document.querySelectorAll('#menu-move button, #menu-move input')].map(e => e.id)
    }));
    check('neither button is on the page', !gone.raise && !gone.lower);
    check('the checkbox is there instead', gone.box, gone.inMenu.join(', '));
    ['app-core.js', 'app-poslock.js', 'app-join.js'].forEach(f => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      check(f + ' no longer names them', !/'btn-raise'|'btn-lower'/.test(src));
    });
    const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    check('liftSelected() is still there - a retired button is not a deleted function',
      /function liftSelected\(/.test(core));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
