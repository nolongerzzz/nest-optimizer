/* End-to-end evidence for the plate reference grid and grid-snap, driven
   through the real app.
   node tools/nso_wire_grid_test.js        exit 0 = every gate held

   Four things are under test, in the order the feature was asked for:
     1. the grid is plate furniture - world-aligned, fixed to the bed, and it
        does not move or rotate with any piece;
     2. visibility is on / off / auto, and auto tracks active positioning;
     3. grid-snap is a soft pull during the drag, not a lock;
     4. the grid is invisible to raycasts, and the two controls are
        independent of one another. */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Places a piece on the plate the way a load does, and returns its index. */
const placeOne = async (page, file) => {
  const id = await loadSTL(page, fx(file));
  await selectModel(page, id);
  await page.evaluate(() => { runOptimize(); });
  await page.waitForFunction(() => state.placed.length > 0, null, { timeout: 30000 });
  return 0;
};

/* Runs the app's own drag resolver for a cursor at (x, z) and reports where
   the piece actually landed. This is the real path: onCanvasPointerMove ->
   dragMovePlaced -> resolveDragPose. */
const dragTo = (page, idx, x, z) => page.evaluate(([i, tx, tz]) => {
  const p = state.placed[i];
  resolveDragPose(p, i, p.x, p.z, tx, tz);
  return { x: p.x, z: p.z };
}, [idx, x, z]);

withApp(async (page, logs) => {
  console.log('\n=== 1. the grid is plate furniture, world-aligned and flat ===');
  const built = await page.evaluate(() => {
    const g = state.plateGrid;
    if (!g) return null;
    const box = new THREE.Box3().setFromObject(g);
    const p = getCurrentPlate();
    return {
      isGroup: !!g.isGroup,
      inScene: g.parent === state.scene,
      underModelGroup: (function () {
        for (let n = g.parent; n; n = n.parent) if (n === state.modelGroup) return true;
        return false;
      })(),
      rot: [g.rotation.x, g.rotation.y, g.rotation.z],
      y: g.position.y,
      sets: g.children.length,
      spanX: box.max.x - box.min.x,
      spanZ: box.max.z - box.min.z,
      thickness: box.max.y - box.min.y,
      plate: { w: p.w, d: p.d }
    };
  });
  check('a grid exists on the plate', !!built);
  check('it lives directly in the scene, not under modelGroup',
        built.inScene && !built.underModelGroup);
  check('it is world-aligned - no rotation of its own',
        built.rot.every(r => Math.abs(r) < 1e-9), JSON.stringify(built.rot));
  check('it is flat: zero extent in Y, so no curvature to handle',
        built.thickness < 1e-6, built.thickness.toExponential(2));
  check('it sits in the plate plane, just above the bed',
        built.y > 0 && built.y < 0.3, 'y = ' + built.y);
  check('it spans the real plate, not a square of max(w, d)',
        Math.abs(built.spanX - built.plate.w) < 10.001 &&
        Math.abs(built.spanZ - built.plate.d) < 10.001,
        built.spanX + ' x ' + built.spanZ + ' on a ' +
        built.plate.w + ' x ' + built.plate.d + ' plate');
  check('minor and major line sets both drawn', built.sets === 2, built.sets + ' sets');

  // A square plate cannot tell w from d, so prove the clip on a rectangular one.
  const rect = await page.evaluate(() => {
    const prev = state.plate;
    state.plate = 'prusa';                       // 250 x 210
    buildPlateMesh();
    const b = new THREE.Box3().setFromObject(state.plateGrid);
    const out = { spanX: b.max.x - b.min.x, spanZ: b.max.z - b.min.z };
    state.plate = prev;
    buildPlateMesh();
    return out;
  });
  check('on a rectangular plate it is rectangular too, not a square of max(w, d)',
        rect.spanX > rect.spanZ && rect.spanX <= 250 && rect.spanZ <= 210 &&
        rect.spanX >= 240 && rect.spanZ >= 200,
        rect.spanX + ' x ' + rect.spanZ + ' on a 250 x 210 plate');

  console.log('\n=== 2. it does not move or rotate with any piece ===');
  const idx = await placeOne(page, 'box-20mm.stl');
  const before = await page.evaluate(() => {
    const b = new THREE.Box3().setFromObject(state.plateGrid);
    return { min: b.min.toArray(), max: b.max.toArray() };
  });
  const moved = await page.evaluate((i) => {
    const p = state.placed[i];
    applyPlacedXZ(p, p.x + 37, p.z - 23);
    rotateActiveModelY(45);
    const b = new THREE.Box3().setFromObject(state.plateGrid);
    return { min: b.min.toArray(), max: b.max.toArray(), piece: { x: p.x, z: p.z } };
  }, idx);
  const same = before.min.every((v, i) => Math.abs(v - moved.min[i]) < 1e-9) &&
               before.max.every((v, i) => Math.abs(v - moved.max[i]) < 1e-9);
  check('piece moved and rotated, grid did not budge', same,
        'piece now at ' + moved.piece.x.toFixed(1) + ', ' + moved.piece.z.toFixed(1));

  console.log('\n=== 3. visibility: on / off / auto ===');
  const vis = async (mode) => page.evaluate((m) => {
    if (m) setGridMode(m);
    applyGridVisibility();
    return { mode: state.gridMode, visible: state.plateGrid.visible };
  }, mode);
  const vOn = await vis('on');
  check('on  -> drawn', vOn.visible === true);
  const vOff = await vis('off');
  check('off -> not drawn', vOff.visible === false);
  const vAutoIdle = await vis('auto');
  check('auto, nothing being positioned -> not drawn', vAutoIdle.visible === false);
  const vAutoDrag = await page.evaluate(() => {
    state.moveDragging = true;
    applyGridVisibility();
    const on = state.plateGrid.visible;
    state.moveDragging = false;
    applyGridVisibility();
    return { during: on, after: state.plateGrid.visible };
  });
  check('auto, piece being dragged -> drawn', vAutoDrag.during === true);
  check('auto, drag released -> back to not drawn', vAutoDrag.after === false);
  const vAutoNudge = await page.evaluate(() => {
    holdGridAuto();
    return state.plateGrid.visible;
  });
  check('auto, just nudged -> drawn for a beat', vAutoNudge === true);

  console.log('\n=== 4. the grid is invisible to raycasts ===');
  const rayHits = await page.evaluate(() => {
    setGridMode('on');
    applyGridVisibility();
    const g = state.plateGrid;
    // Fire straight down the Y axis at the plate centre, where lines cross.
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, -1, 0));
    const onGrid = ray.intersectObject(g, true).length;
    const onPlate = ray.intersectObject(state.plateMesh, false).length;
    const noopRaycast = g.children.every(c => c.raycast === gridNeverRaycast);
    return { onGrid, onPlate, noopRaycast };
  });
  check('a ray through the grid returns no hits', rayHits.onGrid === 0,
        rayHits.onGrid + ' hits');
  check('the same ray still hits the bed, so picking is unharmed',
        rayHits.onPlate > 0, rayHits.onPlate + ' hits');
  check('every line set carries the no-op raycast', rayHits.noopRaycast);
  const pickTargets = await page.evaluate(() => {
    // hitPlateSurface builds its own target list; assert the grid is not on it
    // by making every OTHER plate object unhittable and checking the miss.
    const src = hitPlateSurface.toString();
    return { listsGrid: /targets\.push\(state\.plateGrid\)/.test(src) };
  });
  check('hitPlateSurface does not list the grid as a target',
        pickTargets.listsGrid === false);

  console.log('\n=== 5. grid-snap: off by default, and a pull not a lock ===');
  const snapDefault = await page.evaluate(() => state.gridSnap);
  check('snap is off by default', snapDefault === false);

  // With snap off the resolver must be the identity on an isolated piece.
  await page.evaluate(() => { setGridSnap(false); });
  const free = await dragTo(page, idx, 33.3, -17.7);
  check('snap off -> the piece goes exactly where the cursor is',
        Math.abs(free.x - 33.3) < 1e-6 && Math.abs(free.z + 17.7) < 1e-6,
        free.x.toFixed(4) + ', ' + free.z.toFixed(4));

  await page.evaluate(() => { setGridSnap(true); });
  const snapOn = await page.evaluate(() => state.gridSnap);
  check('snap on', snapOn === true);

  // Sweep the cursor across one grid line in 0.25 mm steps and watch the piece.
  const sweep = [];
  for (let c = 25.0; c <= 35.0001; c += 0.25) {
    const at = await dragTo(page, idx, Math.round(c * 1e6) / 1e6, 0);
    sweep.push({ cursor: Math.round(c * 1e6) / 1e6, piece: at.x });
  }
  const step = await page.evaluate(() => GRID_STEP_MM);
  const pulls = sweep.map(s => s.piece - s.cursor);
  const maxPull = Math.max(...pulls.map(Math.abs));
  console.log('   cursor -> piece across the ' + step + ' mm line at x = 30:');
  sweep.filter((_, i) => i % 4 === 0).forEach(s =>
    console.log('     ' + s.cursor.toFixed(2).padStart(6) + ' -> ' +
                s.piece.toFixed(3).padStart(7) +
                '   pull ' + (s.piece - s.cursor).toFixed(3)));

  check('the pull is toward the line, never away from it',
        sweep.every(s => {
          const near = Math.round(s.cursor / step) * step;
          const d = s.cursor - near;
          const dd = s.piece - near;
          if (Math.abs(d) < 1e-9) return Math.abs(dd) < 1e-9;
          return Math.sign(dd) === Math.sign(d) && Math.abs(dd) <= Math.abs(d) + 1e-9;
        }));
  check('the largest pull it can apply is small and bounded',
        maxPull > 0.2 && maxPull < step / 4,
        maxPull.toFixed(3) + ' mm on a ' + step + ' mm grid');
  const monotonic = sweep.every((s, i) => i === 0 || s.piece > sweep[i - 1].piece + 1e-9);
  check('strictly monotonic: the piece always follows the cursor, so it is ' +
        'never locked and can always be dragged off a line', monotonic);
  const onLine = sweep.find(s => Math.abs(s.cursor - 30) < 1e-9);
  check('a cursor exactly on the line leaves the piece exactly on it',
        onLine && Math.abs(onLine.piece - 30) < 1e-9,
        onLine ? onLine.piece.toFixed(6) : 'not sampled');
  const far = await dragTo(page, idx, 35, 0);
  check('at the cell boundary the pull has faded to nothing',
        Math.abs(far.x - 35) < 1e-6, far.x.toFixed(6));
  // Sitting right on a line, drag a long way off it. The assist is still
  // acting at the far end (42.4 is inside the pull of the line at 40), so the
  // test is not that the piece lands exactly under the cursor - it is that the
  // piece goes nearly the whole way and crosses a line on the trip. Nothing
  // holds it back.
  const away = await dragTo(page, idx, 30.0, 0);
  const awayMore = await dragTo(page, idx, 42.4, 0);
  const cursorTravel = 42.4 - 30.0;
  const pieceTravel = awayMore.x - away.x;
  check('a long drag away from a line is not held back',
        pieceTravel > cursorTravel * 0.9 && awayMore.x > 40,
        away.x.toFixed(3) + ' -> ' + awayMore.x.toFixed(3) + ', ' +
        (100 * pieceTravel / cursorTravel).toFixed(1) + '% of the cursor travel, ' +
        'over the line at 40');

  console.log('\n=== 6. snap applies during the drag, not only on release ===');
  const duringDrag = await page.evaluate((i) => {
    const p = state.placed[i];
    // The exact call chain a pointer move takes, with no release involved.
    state.moveDragging = true;
    state.moveIndex = i;
    resolveDragPose(p, i, p.x, p.z, 31.2, 0);
    const mid = { x: p.x, meshX: p.mesh.position.x };
    state.moveDragging = false;
    return mid;
  }, idx);
  check('the pull is already applied mid-drag, before any pointer-up',
        Math.abs(duringDrag.x - 31.2) > 1e-6 && duringDrag.x < 31.2,
        '31.200 -> ' + duringDrag.x.toFixed(3));
  check('the drawn mesh carries the pulled position too, so it is visible ' +
        'as it happens', Math.abs(duringDrag.meshX - duringDrag.x) < 1e-9);
  const onRelease = await page.evaluate((i) => {
    const p = state.placed[i];
    const beforeUp = p.x;
    state.moveDragging = true;
    state.moveIndex = i;
    state.moveUndoFrom = { index: i, x: 0, z: 0 };
    endMoveDrag();
    return { beforeUp, afterUp: p.x };
  }, idx);
  check('release adds no second, harder snap of its own',
        Math.abs(onRelease.afterUp - onRelease.beforeUp) < 1e-9,
        onRelease.beforeUp.toFixed(3) + ' -> ' + onRelease.afterUp.toFixed(3));

  console.log('\n=== 7. the two controls are independent ===');
  const combos = await page.evaluate(() => {
    const out = [];
    [['off', false], ['off', true], ['on', false], ['on', true],
     ['auto', false], ['auto', true]].forEach(([mode, snap]) => {
      // snap first, then mode, so the one-time promotion cannot mask the state
      setGridSnap(snap);
      setGridMode(mode);
      state.moveDragging = false;
      applyGridVisibility();
      out.push({ asked: mode + '/' + (snap ? 'snap' : 'free'),
                 mode: state.gridMode, snap: state.gridSnap,
                 visible: state.plateGrid.visible });
    });
    return out;
  });
  combos.forEach(c => console.log('     ' + c.asked.padEnd(12) +
    ' -> mode ' + c.mode.padEnd(5) + ' snap ' + String(c.snap).padEnd(5) +
    ' drawn ' + c.visible));
  check('grid visible with snap off is reachable',
        combos.some(c => c.mode === 'on' && c.snap === false && c.visible === true));
  check('snap on with the grid off is reachable - the controls really are ' +
        'independent', combos.some(c => c.mode === 'off' && c.snap === true &&
                                        c.visible === false));

  const promote = await page.evaluate(() => {
    setGridSnap(false);
    setGridMode('off');
    setGridSnap(true);                    // turning snap on from a hidden grid
    const after = { mode: state.gridMode, snap: state.gridSnap,
                    status: (document.getElementById('status') || {}).textContent || '' };
    setGridMode('off');                   // and the user can put it back
    return { after, back: { mode: state.gridMode, snap: state.gridSnap } };
  });
  check('turning snap on from a hidden grid promotes the grid to auto once',
        promote.after.mode === 'auto' && promote.after.snap === true,
        promote.after.status.trim());
  check('and the user can set the grid straight back to off, snap intact',
        promote.back.mode === 'off' && promote.back.snap === true);

  console.log('\n=== 8. the controls are wired to the real UI ===');
  const ui = await page.evaluate(() => {
    const sel = document.getElementById('grid-show');
    const chk = document.getElementById('chk-grid-snap');
    if (!sel || !chk) return null;
    setGridMode('auto');
    setGridSnap(false);
    sel.value = 'on';
    sel.dispatchEvent(new Event('change'));
    const afterSel = state.gridMode;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    const afterChk = state.gridSnap;
    return {
      options: Array.from(sel.options).map(o => o.value),
      afterSel, afterChk,
      defaultUnchecked: chk.defaultChecked === false
    };
  });
  check('#grid-show and #chk-grid-snap both present', !!ui);
  check('the select offers exactly on / off / auto',
        ui && ui.options.slice().sort().join(',') === 'auto,off,on',
        ui ? ui.options.join(', ') : '');
  check('changing the select drives the grid', ui && ui.afterSel === 'on', ui && ui.afterSel);
  check('ticking the box drives snap', ui && ui.afterChk === true);
  check('the snap box ships unticked', ui && ui.defaultUnchecked);

  console.log('\n=== 9. nothing broke on the way ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  const stillPicks = await page.evaluate(() => {
    setGridMode('on');
    applyGridVisibility();
    state.raycaster.setFromCamera({ x: 0, y: 0 }, state.camera);
    return state.raycaster.intersectObjects([state.plateMesh], false).length;
  });
  check('the bed is still pickable with the grid drawn over it', stillPicks > 0);

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  if (fails) process.exit(1);
}).catch(e => { console.error('GRID TEST FAIL', e); process.exit(1); });
