#!/usr/bin/env node
/* A pick mode lets go of the pointer: left-drag orbits after Set and after
   Escape, for every column verb that has one. Driven in the real page.
     node tools/nso_pick_release_test.js        exit 0 = every gate held

   THE RULE. Orbit is gated in app-core.js's onCanvasPointerDown:
   setOrbitFromPlate(true) is reached only by a press that no armed tool took
   first, and every press an armed tool takes leaves enableRotate off. So a
   tool whose claim outlives its verb - a flag left armed, a card left open
   that still answers a press, a press recorded and never released - leaves
   the view dead to a left-drag, and the next thing the user tries is the
   right button. A tool's claim on the pointer ends when its verb completes,
   on Escape, and when its card closes; this is that, as one gate for the lot.

   THE ROSTER, each driven the way a person does it - the button, real clicks
   on the canvas, the card's own Set - and read the same way after each step:
     Patch, Cap, Soften, Carve, Lift, Paint        (Add / Subtract / Surface)
     Close, Bridge, Connect, Thicken               (the cards with a Set)
     Punch                                         (Subtract: a card that stays armed)
     Text                                          (its own menu is the card; open = armed)
     Supports                                      (Assisted: Circles started, a circle drawn, stopped; Erase after a build)
   Cap has no button on the page today (btn-cap is not in index.html); its
   arm is capSelectedModel(), the function the button was wired to.

   For each verb, three readings, each a REAL left-drag from bare plate:
     1. ARMED          the tool is up and has taken nothing yet
     2. AFTER THE VERB the pick has been made and, where there is a Set, Set
                       pressed - the tool has done its work
     3. AFTER ESCAPE   the tool re-armed if its verb put it away, then Escape
   A reading passes when the drag ORBITED: the camera turned about a target
   that did not move (a pan moves the target; a dead drag moves nothing), the
   controls are enabled, and nothing the tool owns is still holding a press.
   The press-hold state read is each tool's own: Bridge / Connect / Close keep
   a `press` record between pointerdown and pointerup; none may outlive it.

   PICK_ONLY=Bridge,Connect runs just those rows; PICK_DEBUG=1 prints a card's
   readout after the two picks. Escape is REPORTED per verb, not gated: the
   gate is the drag, and which tools Escape puts away is a separate question. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const NSO_Stock = require('../nso_stock.js');
const L = require('./nso_bridge_testlib.js');

/* THREE STEPS, ONE FILE. The roster's rows are independent (each clears the plate and loads its own piece), so CI runs
   them as pick:release-edit / -paint-lift / -cards, ~70-85 s each here where the whole was ~216 s (374 s on CI). The
   baseline (0) and the closing no-page-errors check run in every one; no flag runs all twelve rows. */
const STEPS = { edit: 'Patch,Cap,Soften,Carve', 'paint-lift': 'Paint,Lift', cards: 'Close,Bridge,Connect,Thicken,Punch,Text,Supports' };
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const STEP_ROWS = onlyArg ? STEPS[onlyArg.slice('--only='.length)] : null;
if (onlyArg && !STEP_ROWS) { console.error('nso_pick_release_test: ' + onlyArg + ' is not --only=' + Object.keys(STEPS).join('|')); process.exit(2); }

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-pick-release-'));
const fx = f => path.join(ROOT, 'fixtures', f);

function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
/* support:beacons' tilted box (40 x 30 x 10, underside at 30 deg): the Supports card has spots on it in Assisted. */
function tiltedBoxSoup() {
  const lo = [0, 0, 0], hi = [40, 30, 10], T = 30 * Math.PI / 180;
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) {
    const q = v[i];
    out.push(q[0] * Math.cos(T) - q[2] * Math.sin(T), q[1], q[0] * Math.sin(T) + q[2] * Math.cos(T));
  }
  return out;
}
const tiltedBox = () => writeSTL('tilted.stl', tiltedBoxSoup());
const stockTube = () => writeSTL('tube.stl', NSO_Stock.revolve(NSO_Stock.profileTube(10, 8.4, 30), 96));
const sphereSTL = nm => writeSTL(nm + '.stl', L.sphere([0, 0, 8], 8, 32, 16));

/* ---- the page ------------------------------------------------------------ */

const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
const homeView = page => page.evaluate(() => {
  state.controls.target.set(0, 0, 0);
  state.camera.position.set(0, 150, 190);
  state.camera.lookAt(0, 0, 0);
  state.controls.update();
  state.camera.updateMatrixWorld(true);
});
const selectPiece = (page, id) => page.evaluate(i => {
  state.editId = i;
  const idx = state.placed.findIndex(p => p && p.sourceId === i);
  if (idx >= 0) selectPlaced(idx);
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
}, id);
const placeAt = (page, id, x, z) => page.evaluate(([i, x, z]) => {
  const p = state.placed.find(q => q && q.sourceId === i);
  p.x = x; p.z = z; p.mesh.position.x = x; p.mesh.position.z = z; p.mesh.updateMatrixWorld(true);
}, [id, x, z]);
// The screen point of the top of a piece's box (its centre, at the top face).
const topOf = (page, id) => page.evaluate(i => {
  const p = state.placed.find(q => q && q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh);
  const v = b.getCenter(new THREE.Vector3()); v.y = b.max.y;
  state.camera.updateMatrixWorld(true);
  v.project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
}, id);
const clickAt = async (page, s) => {
  await page.mouse.move(s.x - 3, s.y - 3);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);
};
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const status = page => page.evaluate(() => document.getElementById('status').textContent);

/* A pixel of bare plate: on the canvas (nothing of the page over it), on the
   plate, on no piece, and on nothing a pick tool would take. */
const barePlate = page => page.evaluate(() => {
  const r = state.renderer.domElement.getBoundingClientRect();
  const nothing = e => {
    if (pickPlacedIndexFromEvent(e) >= 0) return false;
    if (typeof NSO_bridgeTargetAt === 'function') { try { if (NSO_bridgeTargetAt(e)) return false; } catch (err) { /* none */ } }
    return true;
  };
  for (let z = 60; z <= 150; z += 10) for (let x = -170; x <= 170; x += 10) {
    const v = new THREE.Vector3(x, 0, z).project(state.camera);
    const e = { clientX: r.left + (v.x * 0.5 + 0.5) * r.width, clientY: r.top + (-v.y * 0.5 + 0.5) * r.height };
    if (e.clientX < r.left + 420 || e.clientX > r.right - 60 || e.clientY < r.top + 120 || e.clientY > r.bottom - 50) continue;
    if (document.elementFromPoint(e.clientX, e.clientY) !== state.renderer.domElement) continue;
    if (hitPlateSurface(e) && nothing(e)) return { x: e.clientX, y: e.clientY };
  }
  return null;
});

/* What each tool holds between a pointerdown and its pointerup. A press kept
   past its release is a tool still claiming the pointer. */
const heldPress = page => page.evaluate(() => {
  const held = [];
  if (state.bridge && state.bridge.press) held.push('bridge.press');
  if (state.connect && state.connect.press) held.push('connect.press');
  if (state.close && state.close.press) held.push('close.press');
  if (state.moveDragging) held.push('moveDragging');
  if (state.cutDragging) held.push('cutDragging');
  if (state.editYawDragging) held.push('editYawDragging');
  if (state.rightPress) held.push('rightPress');
  return held;
});

/* One reading: put the camera home, left-drag across bare plate with a real
   mouse, and say what the camera did. ORBITED = the view turned and the
   target stayed; PANNED = the target moved; DEAD = neither. */
async function reading(page, label) {
  await homeView(page);
  await frames(page, 2);
  const bp = await barePlate(page);
  if (!bp) { check(label + ': a bare plate pixel to drag from', false); return null; }
  const before = await page.evaluate(() => ({ q: state.camera.quaternion.toArray(), t: state.controls.target.toArray() }));
  await page.mouse.move(bp.x, bp.y);
  await page.mouse.down();
  const down = await page.evaluate(() => ({ rot: state.controls.enableRotate, on: state.controls.enabled }));
  for (let i = 1; i <= 14; i++) await page.mouse.move(bp.x + i * 8, bp.y + i * 3);
  await page.mouse.up();
  await frames(page, 4);
  const after = await page.evaluate(() => ({ q: state.camera.quaternion.toArray(), t: state.controls.target.toArray(), on: state.controls.enabled }));
  const turned = Math.max(...after.q.map((v, i) => Math.abs(v - before.q[i])));
  const slid = Math.hypot(...after.t.map((v, i) => v - before.t[i]));
  const kind = turned > 1e-3 && slid < 1e-3 ? 'ORBITED' : slid >= 1e-3 ? 'PANNED' : 'DEAD';
  const held = await heldPress(page);
  check(label + ': left-drag on the plate orbits', kind === 'ORBITED' && down.rot && down.on && after.on && !held.length,
        kind + ', rotate ' + down.rot + ' at the press, controls ' + (after.on ? 'on' : 'OFF') +
        (held.length ? ', still holding ' + held.join(', ') : '') + ', turned ' + turned.toFixed(4) + ', target moved ' + slid.toFixed(4));
  return kind;
}

const escape = async page => {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
};

/* ---- the roster ----------------------------------------------------------- *
 * arm(page)    puts the tool up through its own button (or arming function)
 * verb(page)   does the work with real clicks, and Set where the card has one;
 *              resolves once the tool has finished (an Undo step, a status)
 * rearm(page)  optional: put the tool up again if the verb put it away
 * isArmed(page) read-only, for the report
 */

async function viewHole(page, id) {
  // Frame the sphere's hole and return the screen point of its loop.
  return page.evaluate(() => {
    const p = state.placed.find(q => q && q.sourceId === getActiveModel().id), st = nsoPatchState(), a = st.loops[0].anchor;
    p.mesh.updateMatrixWorld(true);
    const m = getActiveModel(), raw = getModelRawSoup(m);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < raw.length; i += 3) { const d = [raw[i], raw[i + 2], -raw[i + 1]]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d[k]); hi[k] = Math.max(hi[k], d[k]); } }
    p.mesh.geometry.computeBoundingBox();
    const bb = p.mesh.geometry.boundingBox, off = [0, 1, 2].map(k => (bb.min.getComponent(k) + bb.max.getComponent(k)) / 2 - (lo[k] + hi[k]) / 2);
    const w = new THREE.Vector3(a[0] + off[0], a[2] + off[1], -a[1] + off[2]).applyMatrix4(p.mesh.matrixWorld);
    const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
    const dir = w.clone().sub(c).normalize();
    state.controls.target.copy(w);
    state.camera.position.copy(w.clone().add(dir.multiplyScalar(12)));
    state.camera.lookAt(w); state.controls.update(); state.camera.updateMatrixWorld(true);
    const v = w.clone().project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  });
}

/* Look down on a piece's top face so a click on its centre lands on it, with
   the drop-downs' side of the canvas clear. */
async function lookDown(page, id) {
  await page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
    state.controls.target.copy(c);
    state.camera.position.set(c.x + 8, c.y + 70, c.z + 55);
    state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
  }, id);
  await frames(page, 2);
}

const ROSTER = [
  { name: 'Patch', file: () => fx('damage/shape-sphere_hole.stl'),
    arm: async page => { await page.click('#btn-patch'); },
    verb: async (page, id) => {
      const s = await viewHole(page, id);
      await page.mouse.move(s.x - 300, s.y - 200);
      await page.mouse.move(s.x, s.y, { steps: 4 });
      await page.waitForFunction(() => nsoPatchState().hover >= 0, null, { timeout: 5000 });
      await page.mouse.down(); await page.mouse.up();
      await page.waitForFunction(() => nsoPatchState().loops.length === 0, null, { timeout: 15000 });
    },
    isArmed: page => page.evaluate(() => nsoPatchState().armed) },

  { name: 'Cap', file: () => fx('box_hull_80x40x20-2.stl'),
    arm: async page => { await page.evaluate(() => capSelectedModel()); },
    verb: async (page, id) => {
      await lookDown(page, id);
      const d0 = await undoDepth(page);
      await clickAt(page, await topOf(page, id));
      await page.waitForFunction(d => state.undoStack.length > d || !state.capArmed, d0, { timeout: 30000 });
    },
    isArmed: page => page.evaluate(() => !!state.capArmed) },

  { name: 'Soften', file: () => fx('box_hull_80x40x20-2.stl'),
    arm: async page => { await page.click('#btn-soften'); },
    verb: async (page, id) => {
      await lookDown(page, id);
      const d0 = await undoDepth(page);
      await clickAt(page, await topOf(page, id));
      await page.waitForFunction(d => state.undoStack.length > d || !state.softenArmed, d0, { timeout: 60000 });
    },
    isArmed: page => page.evaluate(() => !!state.softenArmed) },

  { name: 'Carve', file: () => fx('box_hull_80x40x20-2.stl'),
    arm: async page => { await page.click('#btn-carve'); },
    verb: async (page, id) => {
      await lookDown(page, id);
      const d0 = await undoDepth(page);
      await clickAt(page, await topOf(page, id));
      await page.waitForFunction(d => state.undoStack.length > d, d0, { timeout: 90000 });
      await page.waitForTimeout(200);
    },
    isArmed: page => page.evaluate(() => !!state.carveArmed) },

  { name: 'Paint', file: () => fx('box_hull_80x40x20-2.stl'),
    arm: async page => { await page.click('#btn-mask-paint'); },
    verb: async (page, id) => {
      await lookDown(page, id);
      await clickAt(page, await topOf(page, id));
      await page.waitForFunction(i => nsoMaskCount(state.models.find(m => m.id === i)) > 0, id, { timeout: 15000 });
    },
    isArmed: page => page.evaluate(() => !!state.maskPaint) },

  { name: 'Lift', file: () => { // a slab with one dot standing on it, written once
      const FX = require('./nso_lift_plate_fixtures.js'), { writeSTL: w } = require('./nso_stl_io.js');
      const bar = FX.barocke(), f = path.join(TMP, 'barocke.stl');
      w(f, bar.soup); ROSTER[5].bar = bar; return f;
    },
    arm: async (page, id) => {
      await page.click('#btn-lift');
      await page.waitForFunction(() => /features? found|nothing read|—/.test(document.getElementById('lift-count').textContent), null, { timeout: 120000 });
    },
    verb: async (page, id) => {
      const Lib = require('./nso_lift_plate_drive_lib.js'), bar = ROSTER[5].bar;
      const dot = bar.truth.find(t => t.kind === 'dot');
      const tri = Lib.rawTriNear(bar.soup, dot.center[0], dot.center[1], 3.5, 3.7);
      await Lib.frameOn(page, id);
      const d0 = await undoDepth(page);
      await Lib.clickTri(page, id, tri);
      await page.waitForFunction(d => state.undoStack.length > d, d0, { timeout: 120000 });
      await page.waitForTimeout(300);
    },
    isArmed: page => page.evaluate(() => document.getElementById('btn-lift').getAttribute('aria-pressed') === 'true') },

  { name: 'Close', file: stockTube,
    arm: async page => {
      await page.click('#btn-close');
      await page.waitForFunction(() => state.close && state.close.open, null, { timeout: 15000 });
    },
    verb: async (page, id) => {
      // look down on the open end: the rim is the annulus at the top, radius 9.2
      await page.evaluate(() => {
        const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
        const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3()); c.y = b.max.y;
        state.controls.target.copy(c);
        state.camera.position.set(c.x + 6, c.y + 38, c.z + 28);
        state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
      });
      const s = await page.evaluate(() => {
        const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), o = m.centerOffset;
        p.mesh.updateMatrixWorld(true);
        const w = new THREE.Vector3(9.2 - o.x, 30 - o.y, -0 - o.z).applyMatrix4(p.mesh.matrixWorld).project(state.camera);
        const r = state.renderer.domElement.getBoundingClientRect();
        return { x: r.left + (w.x + 1) / 2 * r.width, y: r.top + (1 - w.y) / 2 * r.height };
      });
      await clickAt(page, s);
      await page.waitForFunction(() => state.close.result, null, { timeout: 15000 });
      await page.click('#btn-close-go');
      await page.waitForFunction(() => /Close done|Close refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
      await page.waitForFunction(() => !state.close.open, null, { timeout: 5000 }).catch(() => {});
    },
    isArmed: page => page.evaluate(() => !!(state.close && state.close.open)) },

  { name: 'Bridge', two: true,
    arm: async page => {
      await page.click('#btn-bridge');
      await page.waitForFunction(() => state.bridge && state.bridge.open, null, { timeout: 5000 });
    },
    verb: async page => {
      await twoPoints(page, 'bridge');
      const d0 = await undoDepth(page);
      await page.waitForFunction(() => !document.getElementById('btn-bridge-go').disabled, null, { timeout: 20000 });
      await page.click('#btn-bridge-go');
      await page.waitForFunction(d => state.undoStack.length > d || (state.bridge && !state.bridge.busy &&
        document.getElementById('bridge-readout').classList.contains('is-bad')), d0, { timeout: 60000 });
    },
    isArmed: page => page.evaluate(() => !!(state.bridge && state.bridge.open)) },

  { name: 'Connect', two: true,
    arm: async page => {
      await page.click('#menu-connect > summary');   // Connect opens on its column button (#218: no gate card)
      await page.waitForFunction(() => state.connect && state.connect.open, null, { timeout: 5000 });
    },
    verb: async page => {
      await twoPoints(page, 'connect');
      const d0 = await undoDepth(page);
      await page.waitForFunction(() => !document.getElementById('btn-connect-go').disabled, null, { timeout: 20000 });
      await page.click('#btn-connect-go');
      await page.waitForFunction(d => state.undoStack.length > d || (state.connect && !state.connect.busy &&
        document.getElementById('connect-readout').classList.contains('is-bad')), d0, { timeout: 60000 });
    },
    isArmed: page => page.evaluate(() => !!(state.connect && state.connect.open)) },

  // Thicken (app-thicken-live.js, Add): a live ghost, a click picks a wall, Set bakes it.
  // It takes no press at all - a click is read on pointerup and a drag is the orbit's
  // or the move's - so what this holds it to is that nothing is left claiming the
  // pointer after Set, and after Escape.
  { name: 'Thicken', file: () => fx('box_open.stl'),
    arm: async page => { await page.click('#btn-thicken-in'); },
    verb: async (page, id) => {
      await lookDown(page, id);
      const d0 = await undoDepth(page);
      await clickAt(page, await topOf(page, id));           // the cavity floor: that wall only
      await page.waitForFunction(() => { const i = nsoThickenLive.info(); return i && i.wall && i.ok; }, null, { timeout: 15000 });
      await page.click('#btn-thicken-set');
      await page.waitForFunction(d => state.undoStack.length > d && !nsoThickenLive.on(), d0, { timeout: 30000 });
    },
    isArmed: page => page.evaluate(() => nsoThickenLive.on()) },

  // Punch stays armed after PUNCH (the card waits for the next face), and its
  // handles take a press only on a hole or its ring - never on bare plate.
  { name: 'Punch', file: () => fx('box_hull_80x40x20-2.stl'),
    arm: async page => {
      await page.click('#btn-punch');
      await page.waitForFunction(() => nsoPunchState().open, null, { timeout: 5000 });
    },
    verb: async (page, id) => {
      await lookDown(page, id);
      const d0 = await undoDepth(page);
      await clickAt(page, await topOf(page, id));
      await page.waitForFunction(() => nsoPunchState().ok, null, { timeout: 15000 });
      await page.click('#btn-punch-go');
      await page.waitForFunction(d => state.undoStack.length > d && !nsoPunchState().busy, d0, { timeout: 90000 });
    },
    isArmed: page => page.evaluate(() => nsoPunchState().open) },

  // Text is armed while its menu is open (the menu is the card, no button inside it), stays
  // armed after STAMP, and takes a press only on a piece or on its own text - never bare plate.
  { name: 'Text', file: () => fx('box_hull_80x40x20-2.stl'),
    arm: async page => {
      await page.click('#menu-text > summary');
      await page.waitForFunction(() => nsoTextState().open, null, { timeout: 5000 });
      await page.fill('#inp-text', 'A');
    },
    verb: async (page, id) => {
      await lookDown(page, id);
      const d0 = await undoDepth(page);
      await clickAt(page, await topOf(page, id));
      await page.waitForFunction(() => nsoTextState().ok, null, { timeout: 15000 });
      await page.click('#btn-text-go');
      await page.waitForFunction(d => state.undoStack.length > d && !nsoTextState().busy, d0, { timeout: 90000 });
    },
    isArmed: page => page.evaluate(() => nsoTextState().open) },

  /* The Supports card's markers own the pointer only while their tool is on, and
     the tool is a switch you stop: Circles draws on the plate (so a left-drag
     there draws instead of orbiting), Erase waits for a member under the pointer
     (so a drag on bare plate still orbits). Stopped by its button and by Escape,
     the view orbits again. The armed reading is the card in Assisted with the
     Tips tool, which leaves the plate to the view. */
  { name: 'Supports', file: tiltedBox,
    arm: async page => {
      await page.evaluate(() => { const m = document.getElementById('menu-supports'); if (!m.open) m.open = true; });
      await page.waitForFunction(() => window.NSO_SUPPORTS_CARD && window.NSO_SUPPORTS_CARD.isOpen() && window.NSO_SUPPORTS_CARD.view().beacons.length > 0, null, { timeout: 30000 });
      await page.click('#sup-mode-assisted');
      await page.waitForFunction(() => window.NSO_SUPPORTS_CARD.markers().points > 0, null, { timeout: 10000 });
    },
    verb: async (page, id) => {
      const tool = () => page.evaluate(() => window.NSO_SUPPORTS_CARD.tool());
      const cam = () => page.evaluate(() => state.camera.position.toArray());
      // CIRCLES: with it on, a drag on bare plate draws a circle and the view stays put
      await homeView(page); await frames(page, 4);
      await page.click('#sup-tool-circles');
      const bp = await barePlate(page);
      check('Supports: a bare plate pixel to draw from', !!bp);
      const c0 = await cam();
      await page.mouse.move(bp.x, bp.y); await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(bp.x + i * 6, bp.y + i);
      await page.mouse.up(); await frames(page, 3);
      const c1 = await cam();
      check('Supports: Circles on - a left-drag on bare plate draws a circle and does not orbit',
        [await page.evaluate(() => window.NSO_SUPPORTS_CARD.markers().zones.length), c0.every((v, i) => Math.abs(v - c1[i]) < 1e-3)], [1, true]);
      // stopped by its button
      await page.click('#sup-tool-circles');
      check('Supports: the button stops Circles', await tool(), 'tips');
      await reading(page, 'Supports Circles stopped by its button');
      // stopped by Escape
      await page.click('#sup-tool-circles');
      await escape(page);
      check('Supports: Escape stops Circles', await tool(), 'tips');
      await reading(page, 'Supports Circles stopped by Escape');
      // ERASE, after a build (the circle only drew a circle: it is taken off, so the plate can be reached): a drag on bare plate still orbits
      await page.evaluate(() => window.NSO_SUPPORTS_CARD.removeZone(0));
      await page.click('#btn-sup-all');
      await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
      await page.waitForFunction(() => !document.getElementById('sup-tool-erase').disabled, null, { timeout: 10000 });
      await page.click('#sup-tool-erase');
      check('Supports: Erase is on after a build', await tool(), 'erase');
      await reading(page, 'Supports Erase on');
      await escape(page);
      check('Supports: Escape stops Erase', await tool(), 'tips');
      // the card closed: nothing is left claiming the plate
      await page.click('#sup-tool-circles');
      await page.evaluate(() => { document.getElementById('menu-supports').open = false; });
      await frames(page, 3);
      check('Supports: closing the card puts the markers away and the tool with them',
        await page.evaluate(() => [window.NSO_SUPPORTS_CARD.tool(), !state.scene.getObjectByName('supportsCardZones'), state.renderer.domElement.style.cursor]), ['tips', true, '']);
      await reading(page, 'Supports card closed');
    },
    isArmed: page => page.evaluate(() => window.NSO_SUPPORTS_CARD.isOpen() && window.NSO_SUPPORTS_CARD.mode() !== 'auto') }
];

/* Two clicks, a sphere apiece, the camera free between them. */
async function twoPoints(page, which) {
  const pts = await page.evaluate(() => {
    const tops = state.placed.filter(Boolean).map(p => {
      const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
      return c;
    });
    const mid = tops[0].clone().add(tops[1]).multiplyScalar(0.5);
    state.controls.target.copy(mid);
    state.camera.position.set(mid.x, mid.y + 70, mid.z + 70);
    state.camera.lookAt(mid); state.controls.update(); state.camera.updateMatrixWorld(true);
    const r = state.renderer.domElement.getBoundingClientRect();
    // On the sides of the two balls that face each other, tipped 50 degrees up:
    // in sight of the camera, with a clear line from one to the other.
    const cp = 8 * Math.cos(50 * Math.PI / 180), sp = 8 * Math.sin(50 * Math.PI / 180);
    const left = tops[0].x < tops[1].x ? 0 : 1;
    const at = () => tops.map((c, i) => {
      const p = c.clone(); p.x += (i === left ? cp : -cp); p.y += sp;
      const v = p.project(state.camera);
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    });
    // The tool's card stays open over the left of the viewport (Connect's grew a Draw row and Attach):
    // pan the view sideways, measured, until neither point is under it.
    const open = document.querySelector('.vp-shell-menu[open] > .vp-menu-body');
    const card = open && open.getBoundingClientRect();
    const pan = (mm) => { const d = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(mm);
      state.controls.target.add(d); state.camera.position.add(d); state.controls.update(); state.camera.updateMatrixWorld(true); };
    let q = at();
    const under = (q) => card && q.some(p => p.x <= card.right + 20 && p.y <= card.bottom + 20);
    if (under(q)) { const x0 = Math.min(...q.map(p => p.x)); pan(1); const pxPerMm = Math.min(...at().map(p => p.x)) - x0; pan((card.right + 60 - x0) / pxPerMm - 1); q = at(); }
    return q;
  });
  await clickAt(page, pts[0]);
  await clickAt(page, pts[1]);
  if (process.env.PICK_DEBUG) console.log('   ' + which + ': ' + await page.evaluate(w => document.getElementById(w + '-readout').textContent, which));
}

/* ---- the run -------------------------------------------------------------- */

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 880 });

  /* The baseline the rest are read against: nothing armed. */
  console.log('\n=== 0. nothing armed: the reading itself works ===');
  const base = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectPiece(page, base);
  check('a bare drag orbits with no tool up', (await reading(page, 'baseline')) === 'ORBITED');
  await page.click('#btn-clear-plate');

  if (!ROSTER.every(r => Object.values(STEPS).filter(v => v.split(',').includes(r.name)).length === 1) ||
      Object.values(STEPS).join(',').split(',').length !== ROSTER.length) { console.error('nso_pick_release_test: every roster row belongs to exactly one step'); process.exit(2); }
  let n = 0;
  // PICK_ONLY=Bridge,Connect runs just those rows (the roster is slow end to end); --only=<step> runs a CI step's rows.
  const only = (STEP_ROWS || process.env.PICK_ONLY || '').split(',').filter(Boolean);
  for (const V of ROSTER.filter(r => !only.length || only.indexOf(r.name) >= 0)) {
    n++;
    console.log('\n=== ' + n + '. ' + V.name + ' ===');
    await page.evaluate(() => leaveTool());
    await page.click('#btn-clear-plate');
    await frames(page, 2);
    let id;
    if (V.two) {
      const a = await loadSTL(page, sphereSTL('sphA')), b = await loadSTL(page, sphereSTL('sphB'));
      await placeAt(page, a, -30, 0); await placeAt(page, b, 30, 0);
      await selectPiece(page, a);
      id = a;
    } else {
      id = await loadSTL(page, V.file());
      await selectPiece(page, id);
    }
    await homeView(page);
    await frames(page, 2);

    await V.arm(page, id);
    await frames(page, 2);
    check(V.name + ': armed', await V.isArmed(page));
    await reading(page, V.name + ' armed');

    await V.verb(page, id);
    await frames(page, 3);
    const errNow = logs.filter(l => /\[pageerror\]/.test(l));
    check(V.name + ': the verb ran (a step on the Undo stack, or the tool put away)',
          (await undoDepth(page)) > 0 || !(await V.isArmed(page)), await status(page));
    check(V.name + ': no page error in the verb', errNow.length === 0, errNow.slice(0, 2).join(' | '));
    await reading(page, V.name + ' after the verb');

    if (!(await V.isArmed(page))) {
      await V.arm(page, id);
      await frames(page, 2);
    }
    await escape(page);
    console.log('   (informational) Escape left ' + V.name + (await V.isArmed(page) ? ' armed' : ' put away'));
    await reading(page, V.name + ' after Escape');
  }

  const errs = logs.filter(l => /\[pageerror\]/.test(l));
  check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
