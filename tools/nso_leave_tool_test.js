#!/usr/bin/env node
/* Double-click the plate to leave whatever tool you're in - driven in the
   real page, with real double-clicks.

   node tools/nso_leave_tool_test.js                exit 0 = every gate held
   LEAVE_TOOL_SHOTS=dir node tools/nso_leave_tool_test.js   also screenshots

   THE FLOW, as a person runs it: open Cut, Split, double-click the plate;
   open Rotate, double-click; Start Join, pick A, double-click; Finish ->
   Soften, double-click; G-scope, Click to select region, double-click (back
   to orbit), double-click (G-scope closed). Then Carve armed and a
   double-click; then a double-click on Rotate's 90 button, which must stay
   two clicks. Undo at the end.

   Every step holds the same three things: what was live is gone, the pieces
   did not move, and the selection and the Undo stack are what they were. A
   double-click is two clicks first, so the plate point is found by asking
   the scene - on the canvas, on the plate, under no piece - rather than
   picked by hand, and the tests that a click there changes nothing are part
   of each step rather than an assumption. */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const SHOTS = process.env.LEAVE_TOOL_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let shotNo = 0;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await page.waitForTimeout(400);

  const shot = async (name) => {
    if (!SHOTS) return;
    shotNo++;
    const f = path.join(SHOTS, String(shotNo).padStart(2, '0') + '-' + name + '.png');
    await page.screenshot({ path: f });
    console.log('  shot ' + path.basename(f));
  };

  /* Everything a leave must not change. */
  const snap = () => page.evaluate(() => ({
    sel: state.selectedIndex,
    edit: state.editId,
    undo: state.undoStack.length,
    models: state.models.length,
    poses: state.placed.map(p => [p.sourceId, +(p.x || 0).toFixed(4), +(p.z || 0).toFixed(4),
      +(p.rotY || 0).toFixed(6), +(p.tiltX || 0).toFixed(6), +(p.tiltZ || 0).toFixed(6),
      +(p.liftY || 0).toFixed(4)].join(','))
  }));
  const sameAs = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const held = (label, before, after) => {
    check(label + ': pieces did not move', sameAs(before.poses, after.poses),
      sameAs(before.poses, after.poses) ? '' : JSON.stringify({ before: before.poses, after: after.poses }));
    check(label + ': selection kept', before.sel === after.sel && before.edit === after.edit,
      'sel ' + before.sel + '->' + after.sel + ', editId ' + before.edit + '->' + after.edit);
    check(label + ': Undo stack untouched', before.undo === after.undo && before.models === after.models,
      'undo ' + before.undo + '->' + after.undo);
  };

  /* A point on the main canvas that is the plate and nothing else: the canvas
     is the element there, the plate is under it, and no piece is - nor any of
     Rotate's arrowheads, which app-core hit-tests ahead of everything and
     which, at the bed-sized rings (45% of the bed), reach well out over the
     plate. A double-click there is two arrowhead clicks, not empty plate. */
  const platePoint = () => page.evaluate(() => {
    const c = state.renderer.domElement;
    const r = c.getBoundingClientRect();
    const plateAt = (x, y) => {
      const ev = { clientX: x, clientY: y };
      if (document.elementFromPoint(x, y) !== c) return false;
      if (!hitPlateSurface(ev)) return false;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      if (state.raycaster.intersectObjects(state.modelGroup.children, true).length) return false;
      const rot = state.scene.getObjectByName('nso-rotate-handles');
      return !(rot && rot.visible && state.raycaster.intersectObjects(rot.children, true)
        .some(h => h.object && h.object.userData.nsoRotateHandle));
    };
    let best = null;
    for (let fy = 0.55; fy <= 0.9; fy += 0.05) {
      for (let fx = 0.2; fx <= 0.8; fx += 0.05) {
        const x = Math.round(r.left + fx * r.width), y = Math.round(r.top + fy * r.height);
        if (plateAt(x, y)) {
          const d = Math.abs(fx - 0.5) + Math.abs(fy - 0.7);
          if (!best || d < best.d) best = { x, y, d };
        }
      }
    }
    return best;
  });
  /* The screen point of a placed piece's centre, for a real click on it. */
  const pieceAt = (i) => page.evaluate((idx) => {
    const p = state.placed[idx];
    const box = new THREE.Box3().setFromObject(p.mesh);
    const v = box.getCenter(new THREE.Vector3()).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), y: Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height) };
  }, i);
  const dblPlate = async () => {
    const pt = await platePoint();
    if (!pt) throw new Error('no clear plate point on the canvas');
    await page.mouse.dblclick(pt.x, pt.y);
    await page.waitForTimeout(250);
  };

  /* ------------------------------------------------------------------ 0 */
  console.log('\n=== 0. the gesture exists, and with nothing live it touches nothing ===');
  {
    const r = await page.evaluate(() => ({
      fn: typeof window.leaveTool,
      api: !!(window.nsoInputMode && window.nsoInputMode.leaveTool === window.leaveTool)
    }));
    check('leaveTool() is on the page and on nsoInputMode', r.fn === 'function' && r.api);
    const before = await snap();
    const left = await page.evaluate(() => window.leaveTool());
    check('nothing live -> nothing closed', Array.isArray(left) && left.length === 0, JSON.stringify(left));
    held('idle leave', before, await snap());
  }

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. open Cut, Split, double-click the plate ===');
  {
    await page.click('#menu-cut > summary');
    await page.click('#btn-cutter-open');
    const pc = await pieceAt(0);
    await page.mouse.click(pc.x, pc.y);
    await page.waitForFunction(() => !!state.cutHelper, null, { timeout: 5000 });
    await page.click('#btn-cut');
    await page.waitForFunction(() => state.placed.length === 2 && state.cutterOpen, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const before = await snap();
    await shot('cut-after-split');
    check('cutter live after Split', await page.evaluate(() => state.cutterOpen && document.getElementById('menu-cut').open));
    await dblPlate();
    const r = await page.evaluate(() => ({
      cutter: state.cutterOpen, menu: document.getElementById('menu-cut').open,
      helper: !!state.cutHelper, closeBtn: document.getElementById('btn-cutter-close').disabled
    }));
    await shot('cut-dblclick-closed');
    check('cutter closed', !r.cutter && !r.helper, JSON.stringify(r));
    check('Cut menu shut and its Close button idle', !r.menu && r.closeBtn);
    check('both halves still on the plate', (await snap()).poses.length === 2);
    held('Cut', before, await snap());

    /* closeCutter is the one close path that deselects - its Close button
       means "done with this piece" too. The gesture leaves the tool, not the
       piece: a half picked while the cutter is live is still picked after. */
    await page.click('#menu-cut > summary');
    await page.click('#btn-cutter-open');
    const ph = await pieceAt(1);
    await page.mouse.click(ph.x, ph.y);
    await page.waitForFunction(() => state.cutterOpen && state.selectedIndex === 1 && !!state.cutHelper, null, { timeout: 5000 });
    const before2 = await snap();
    await shot('cut-reopened-half-picked');
    await dblPlate();
    await shot('cut-dblclick-half-still-picked');
    check('cutter closed again', await page.evaluate(() => !state.cutterOpen && !state.cutHelper &&
      !document.getElementById('menu-cut').open));
    held('Cut with a half picked', before2, await snap());
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. open Rotate, double-click ===');
  {
    const pc = await pieceAt(0);
    await page.mouse.click(pc.x, pc.y);
    await page.waitForTimeout(200);
    await page.click('#menu-rotate > summary');
    await page.waitForTimeout(250);
    const guide = () => page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return !!(g && g.visible && g.children.length);
    });
    check('Rotate guide drawn on the selected piece', await guide());
    const before = await snap();
    await shot('rotate-open');
    await dblPlate();
    await shot('rotate-dblclick-closed');
    check('Rotate guide gone', !(await guide()));
    check('Rotate menu shut, nobody owns the input',
      await page.evaluate(() => !document.getElementById('menu-rotate').open && nsoInputMode.active() === null));
    held('Rotate', before, await snap());
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Start Join, pick A, double-click ===');
  {
    await page.evaluate(() => document.getElementById('btn-join-start').scrollIntoView());
    await page.click('#btn-join-start');
    await page.click('#join-slot-a');
    const pc = await pieceAt(0);
    await page.mouse.click(pc.x, pc.y);
    await page.waitForTimeout(250);
    const a = await page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
    check('Join live with A picked', a.session && a.a != null && a.b == null, JSON.stringify(a));
    await page.click('#join-slot-b');      // B armed and waiting for its click
    const before = await snap();
    await shot('join-a-picked');
    await dblPlate();
    await shot('join-dblclick-ended');
    const r = await page.evaluate(() => ({
      session: state.joinSession, armed: state.joinArmed, b: state.joinPartnerId,
      hull: state.joinHullId, faceA: state.joinFaceA,
      slotA: document.getElementById('join-name-a').textContent
    }));
    check('Join ended, picks cleared', !r.session && r.armed == null && r.b == null && r.hull == null && r.faceA == null,
      JSON.stringify(r));
    held('Join', before, await snap());
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. Finish -> Soften, double-click ===');
  {
    const pc = await pieceAt(0);
    await page.mouse.click(pc.x, pc.y);
    await page.waitForTimeout(200);
    await openFinishMenu(page);
    await page.click('#btn-soften');
    await page.waitForTimeout(150);
    check('Soften armed, waiting for a face', await page.evaluate(() => state.softenArmed === true));
    const before = await snap();
    await shot('soften-armed');
    await dblPlate();
    await shot('soften-dblclick-closed');
    const r = await page.evaluate(() => ({
      armed: state.softenArmed, finish: document.querySelector('.vp-finish-menu').open, pick: state.facePick
    }));
    check('Soften disarmed', r.armed === false);
    check('Finish overlay closed', r.finish === false);
    held('Soften', before, await snap());
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. G-scope: Click to select region, double-click, double-click ===');
  {
    const before = await snap();
    await page.click('#btn-microscope');
    await page.waitForFunction(() => window.NSO_MICROSCOPE && window.NSO_MICROSCOPE.isOpen(), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.click('#ms-mode-select');
    const modeOf = () => page.evaluate(() => ({
      open: NSO_MICROSCOPE.isOpen(),
      orbit: document.getElementById('ms-mode-orbit').classList.contains('active'),
      select: document.getElementById('ms-mode-select').classList.contains('active')
    }));
    check('G-scope open, region pick armed', (m => m.open && m.select && !m.orbit)(await modeOf()));
    await shot('gscope-select-region');
    /* G-scope's canvas, at a corner the part does not reach - a click on the
       part in select mode drops a capture box, which is the click doing its
       job, not the gesture. */
    const gp = await page.evaluate(() => {
      const c = document.querySelector('#microscope canvas');
      const r = c.getBoundingClientRect();
      for (let fy = 0.92; fy > 0.5; fy -= 0.04) {
        for (let fx = 0.08; fx < 0.5; fx += 0.04) {
          const x = Math.round(r.left + fx * r.width), y = Math.round(r.top + fy * r.height);
          if (document.elementFromPoint(x, y) === c) return { x, y };
        }
      }
      return null;
    });
    check('a clear point on G-scope\'s canvas', !!gp);
    await page.mouse.dblclick(gp.x, gp.y);
    await page.waitForTimeout(250);
    const m1 = await modeOf();
    await shot('gscope-dblclick-orbit');
    check('first double-click: back to orbit, G-scope still open', m1.open && m1.orbit && !m1.select, JSON.stringify(m1));
    await page.mouse.dblclick(gp.x, gp.y);
    await page.waitForTimeout(250);
    const m2 = await modeOf();
    await shot('gscope-dblclick-closed');
    check('second double-click: G-scope closed', !m2.open, JSON.stringify(m2));
    check('G-scope rail button off', await page.evaluate(() => !document.getElementById('btn-microscope').classList.contains('is-on')));
    held('G-scope', before, await snap());
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. Carve armed, double-click ===');
  {
    await openFinishMenu(page);
    await page.click('#btn-carve');
    check('Carve armed', await page.evaluate(() => state.carveArmed === true));
    const before = await snap();
    await shot('carve-armed');
    await dblPlate();
    await shot('carve-dblclick-disarmed');
    const r = await page.evaluate(() => ({
      armed: state.carveArmed, pressed: document.getElementById('btn-carve').getAttribute('aria-pressed'),
      finish: document.querySelector('.vp-finish-menu').open
    }));
    check('Carve disarmed through its button', r.armed === false && r.pressed === 'false', JSON.stringify(r));
    check('Finish overlay closed with it', r.finish === false);
    held('Carve', before, await snap());
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. a double-click on Rotate\'s 90 button is two clicks ===');
  let rotBefore;
  {
    const pc = await pieceAt(0);
    await page.mouse.click(pc.x, pc.y);
    await page.waitForTimeout(200);
    await page.click('#menu-rotate > summary');
    await page.waitForTimeout(200);
    rotBefore = await page.evaluate(() => ({
      rotY: state.placed[state.selectedIndex].rotY || 0, undo: state.undoStack.length, sel: state.selectedIndex
    }));
    await page.dblclick('#btn-rot-right');
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => ({
      rotY: state.placed[state.selectedIndex].rotY || 0, undo: state.undoStack.length,
      menu: document.getElementById('menu-rotate').open,
      guide: (g => !!(g && g.children.length))(state.scene.getObjectByName('nso-rotate-handles'))
    }));
    await shot('rotate90-dblclick');
    check('piece turned 180', Math.abs(r.rotY - rotBefore.rotY - Math.PI) < 1e-9,
      ((r.rotY - rotBefore.rotY) * 180 / Math.PI).toFixed(3) + ' deg');
    check('nothing closed: Rotate menu and guide still up', r.menu && r.guide, JSON.stringify(r));
    check('two Undo steps, one per click', r.undo === rotBefore.undo + 2, rotBefore.undo + '->' + r.undo);
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. Undo works at the end of the run ===');
  {
    await page.click('#btn-undo');
    await page.waitForTimeout(150);
    await page.click('#btn-undo');
    await page.waitForTimeout(250);
    const r = await page.evaluate((i) => ({
      rotY: state.placed[i].rotY || 0, undo: state.undoStack.length
    }), rotBefore.sel);
    await shot('undo-after-run');
    check('two Undos put the turn back', Math.abs(r.rotY - rotBefore.rotY) < 1e-9 && r.undo === rotBefore.undo,
      'rotY ' + r.rotY.toFixed(4) + ', undo ' + r.undo);
    await page.click('#btn-undo');
    await page.waitForTimeout(500);
    check('one more Undo takes back the Split',
      await page.evaluate(() => state.placed.length === 1), 'placed ' + await page.evaluate(() => state.placed.length));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });
