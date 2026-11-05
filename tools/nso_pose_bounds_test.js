/* A piece's bounds after a bake - the lowest point is the lowest VERTEX.
     node tools/nso_pose_bounds_test.js        exit 0 = every gate held

   Driven through the real app in headless Chromium (library/box_hull_80x40x20
   as the target, library/box_bit_12x8x8 as the piece), every drag a real
   press-carry-release, every button a real click.

   THE REPORT
   After a drop onto a piece seats and BAKES a turn into the piece's own axes
   ("turned 5.7 degrees and baked into its own axes"), its height readings go
   wrong: To plate says "Already on the plate", Vertical reads 0.00 mm, and the
   piece sits in the air.

   WHAT WAS WRONG. Not a stale cache. meshLocalBox3 was the geometry's bounding
   box with the pose matrix applied to its eight corners, which is the piece's
   world box only while the corners are vertices. A baked geometry's bounding
   box is the tight box of the TURNED soup; put the piece's own pose on it
   (every piece that has been tipped or tilted has one) and the corners swing
   out past the vertices, so the "lowest point" is below the lowest vertex by
   millimetres. That number feeds To plate, liftY (what Vertical reads) and
   Tip on face's landing, and applyMeshRotation and both exporters placed the
   piece by half the recorded height, which is only right for a posed box
   centred on its origin. nso-bounds.js measures the vertices instead, and
   nsoInvalidatePieceBounds is the one call every geometry rewrite goes through.

   What is pinned:
   1. The box is the vertices' box: for an unposed piece, a quarter-turned one,
      a tilted box, and a baked piece posed again, against a brute-force pass.
      The old corner method is measured too, and is out by millimetres on the
      last one (so this cannot pass on a piece that never showed the bug).
   2. Seat on a tilted corner through a drop's seat: the seat turns the piece
      and bakes it, and the clearance it measures on the surfaces is the 0.18 mm
      that was asked for (it was 1.2 - 3.8 mm out on a posed piece). The plate
      drag is flat since move-flat (#280) - only Lift's drop seats, and only a
      piece Lift left in the air - so the seat is the one a drop makes
      (app-grab-drop.js's seat: NSO_seatPieceAt, Drop's words and Undo).
   3. Carry it flat, then raise it with Vertical: liftY is the true height over
      the bed, and the Vertical slider reads it.
   4. To plate: the lowest vertex lands on the bed baseline, the status gives
      the true drop distance, the export's lowest point is 0, and a second
      press is a truthful "Already on the plate".
   5. Tip on face onto a side face of the baked piece: that face is down, the
      lowest vertex is on the bed.
   6. The invalidation: an edit in place that announces nothing is invisible to
      the cache until nsoInvalidatePieceBounds, which also re-reads the piece's
      width / depth / height; and a bake (NSO_sculptCommitRaw) and the Undo of
      the drop both leave the readings true.
   7. The pose snapshot an Undo copies still puts the piece where it was. */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v));

const BED = 0.2;          // the baseline every piece's bottom is squared onto
const TOL = 1e-3;

/* In the page: the piece's true lowest / highest vertex (brute force, every
   vertex through the matrix) and what the old corner method said. */
const MEASURE = `(id) => {
  const p = state.placed.find(q => q && q.sourceId === id);
  p.mesh.updateMatrixWorld(true);
  const P = p.mesh.geometry.attributes.position, e = p.mesh.matrixWorld, v = new THREE.Vector3();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(e);
    for (let a = 0; a < 3; a++) { const c = a === 0 ? v.x : a === 1 ? v.y : v.z; if (c < lo[a]) lo[a] = c; if (c > hi[a]) hi[a] = c; }
  }
  const g = p.mesh.geometry; g.computeBoundingBox();
  const corners = g.boundingBox.clone().applyMatrix4(e);
  const app = meshLocalBox3(p.mesh);
  return { lo, hi, liftY: p.liftY || 0, h: p.height, w: p.width, d: p.depth,
           oldMinY: corners.min.y, appMinY: app.min.y, appMaxY: app.max.y, appMinX: app.min.x, appMaxX: app.max.x,
           q: p.mesh.quaternion.toArray(), pos: p.mesh.position.toArray() };
}`;
const measure = (page, id) => page.evaluate(`(${MEASURE})(${id})`);

/* The export's lowest point: buildCombinedGeometry writes Z up, plate at 0. */
const exportMinZ = (page, id) => page.evaluate(id => {
  const all = state.placed;
  state.placed = all.filter(q => q && q.sourceId === id);       // the piece alone
  try {
    const P = buildCombinedGeometry().attributes.position;
    let m = Infinity;
    for (let i = 0; i < P.count; i++) m = Math.min(m, P.getZ(i));
    return m;
  } finally { state.placed = all; }
}, id);

const screenOf = (page, w) => page.evaluate(w => {
  state.camera.updateMatrixWorld(true);
  const q = new THREE.Vector3(w[0], w[1], w[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}, w);
async function carry(page, a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(a.x + (b.x - a.x) * k / 12, a.y + (b.y - a.y) * k / 12);
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(250);
}
const status = page => page.evaluate(() => document.getElementById('status').textContent);
/* A drop onto a piece, as app-grab-drop.js's seat makes it: NSO_seatPieceAt at the point let go
   over, with Drop's words and its Undo. A plate drag no longer reaches it (move-flat, #280). */
const dropSeat = (page, onto, id, point) => page.evaluate(([onto, id, point]) => {
  const T = state.placed.find(q => q && q.sourceId === onto), p = state.placed.find(q => q && q.sourceId === id);
  const nm = q => '"' + ((state.models.find(m => m.id === q.sourceId) || {}).name || 'piece') + '"';
  const r = NSO_seatPieceAt(T, point, p, { undoType: 'dropSeatReplace' },
    { verb: 'Drop', a: nm(T), b: nm(p), seated: 'Dropped onto ' + nm(T) + ': seated' });
  if (r && r.ok && r.applied) {
    if (typeof refreshOutline === 'function') refreshOutline(p);
    setStatus(r.applied.status + '. One Undo (Ctrl+Z) puts it back.');
  }
  return !!(r && r.ok);
}, [onto, id, point]);
const centreOf = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id);
  const b = meshLocalBox3(p.mesh);
  return [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
}, id);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const hull = await loadSTL(page, path.join(ROOT, 'library', 'box_hull_80x40x20.stl'));
  const bit = await loadSTL(page, path.join(ROOT, 'library', 'box_bit_12x8x8.stl'));

  /* ------------------------------------------------ 1. the box is the vertices' */
  console.log('\n=== 1. the world box is the box of the vertices ===');
  const poses = [
    ['an unposed piece', {}],
    ['a quarter turn (tip 90)', { tipX: 1 }],
    ['a tilted box', { tiltX: 15, tiltZ: 9, rotY: 0.4 }]
  ];
  for (const [name, pose] of poses) {
    await page.evaluate(([id, pose]) => {
      const p = state.placed.find(q => q && q.sourceId === id);
      p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; p.flipX = false; p.liftY = 0;
      Object.assign(p, pose);
      applyMeshRotation(p); settlePlacedOnBed(p);
    }, [bit, pose]);
    const m = await measure(page, bit);
    check(name + ': meshLocalBox3 is the vertices\' box', near(m.appMinY, m.lo[1], TOL) && near(m.appMaxY, m.hi[1], TOL) &&
      near(m.appMinX, m.lo[0], TOL) && near(m.appMaxX, m.hi[0], TOL),
      'min y ' + f3(m.appMinY) + ' vs ' + f3(m.lo[1]));
    check(name + ': lowest vertex on the bed baseline', near(m.lo[1], BED, TOL), f3(m.lo[1]));
  }

  /* ------------------------------------- 2. seat on a tilted corner, through a drop */
  console.log('\n=== 2. drop it on a tilted corner: the seat bakes a turn, and seats true ===');
  const setup = await page.evaluate(([hull, bit]) => {
    const ph = state.placed.find(q => q && q.sourceId === hull), pb = state.placed.find(q => q && q.sourceId === bit);
    ph.tiltX = 15; ph.tiltZ = 0; ph.x = 0; ph.z = 0; applyMeshRotation(ph); settlePlacedOnBed(ph);
    // the bit carries a pose of its own, as any piece that has been tipped does
    pb.tiltX = 10; pb.tiltZ = 7; pb.rotY = 0.5; pb.liftY = 0;
    applyMeshRotation(pb); applyPlacedXZ(pb, 70, 40);
    state.camera.position.set(0, 90, 130); state.controls.target.set(0, 12, 0);
    state.camera.lookAt(0, 12, 0); state.controls.update();
    // the high corner of the slope: a ray down onto the hull near +x
    ph.mesh.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(new THREE.Vector3(24, 200, -8), new THREE.Vector3(0, -1, 0));
    return { corner: rc.intersectObject(ph.mesh, false)[0].point.toArray() };
  }, [hull, bit]);
  const before = await measure(page, bit);
  check('the bit starts posed (its box is not centred on its origin\'s axes)', Math.abs(before.q[0]) + Math.abs(before.q[2]) > 0.05,
    JSON.stringify(before.q.map(v => +v.toFixed(3))));
  await dropSeat(page, hull, bit, setup.corner);
  const seated = await status(page);
  const turned = /turned ([0-9.]+) degrees and baked into its own axes/.exec(seated);
  check('the drop seats and BAKES a turn into the piece\'s axes', !!turned && +turned[1] > 0.5, (seated.match(/turned.*axes/) || [seated])[0]);
  const clr = /clearance ([0-9.]+)mm/.exec(seated);
  check('the clearance it measured on the surfaces is the 0.18 mm asked for', !!clr && near(+clr[1], 0.18, 0.005), clr && clr[1]);
  let s = await measure(page, bit);
  check('seated: liftY is the true height of the lowest vertex over the baseline', near(s.liftY, s.lo[1] - BED, TOL),
    'liftY ' + f3(s.liftY) + ' vs ' + f3(s.lo[1] - BED));
  check('seated: the corner method is out by more than a millimetre (the bug was real here)', Math.abs(s.oldMinY - s.lo[1]) > 0.5,
    f3(s.oldMinY) + ' vs ' + f3(s.lo[1]));

  /* ------------------------------------------------ 3. drag it into the air */
  console.log('\n=== 3. carry it flat, raise it with Vertical: liftY and Vertical read the true height ===');
  const c1 = await centreOf(page, bit), p1 = await screenOf(page, c1), up0 = s.liftY;
  await carry(page, p1, { x: p1.x + 60, y: p1.y + 40 });
  s = await measure(page, bit);
  check('a flat drag off the hull keeps the height it was seated at', near(s.liftY, up0, 1e-6) && near(s.liftY, s.lo[1] - BED, TOL),
    'liftY ' + f3(s.liftY) + ' (seated ' + f3(up0) + ') vs ' + f3(s.lo[1] - BED));
  await page.evaluate(id => {
    selectPlaced(state.placed.findIndex(q => q && q.sourceId === id));
    document.getElementById('menu-move').open = true;
    const chk = document.getElementById('chk-move-vertical');
    chk.checked = true; chk.dispatchEvent(new Event('change'));
  }, bit);
  await page.waitForTimeout(150);
  await page.evaluate(() => { const sl = document.getElementById('move-vert-slider'); sl.value = '30'; sl.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(150);
  s = await measure(page, bit);
  check('Vertical raised it into the air', s.liftY > 20, 'liftY ' + f3(s.liftY));
  check('in the air: liftY is the true height of the lowest vertex', near(s.liftY, s.lo[1] - BED, TOL),
    'liftY ' + f3(s.liftY) + ' vs ' + f3(s.lo[1] - BED));
  const read = await page.evaluate(() => document.getElementById('move-vert-read').textContent);
  check('Vertical reads the true height', near(parseFloat(read), s.lo[1] - BED, 0.006), read + ' vs ' + f3(s.lo[1] - BED));
  await page.evaluate(() => { const chk = document.getElementById('chk-move-vertical'); chk.checked = false; chk.dispatchEvent(new Event('change')); });
  // Vertical put the eye at the horizon and a menu over the view: put both back
  await page.evaluate(() => {
    document.getElementById('menu-move').open = false;
    state.camera.position.set(0, 90, 130); state.controls.target.set(0, 12, 0);
    state.camera.lookAt(0, 12, 0); state.controls.update();
  });
  const zUp = await exportMinZ(page, bit);
  check('the export writes the lowest vertex at its height over the plate', near(zUp, s.liftY, TOL), f3(zUp) + ' vs ' + f3(s.liftY));

  /* ------------------------------------------------ 4. To plate */
  console.log('\n=== 4. To plate lands the lowest vertex on the bed ===');
  const was = s.lo[1];
  await page.evaluate(() => document.getElementById('btn-to-plate').click());
  await page.waitForTimeout(100);
  s = await measure(page, bit);
  const msg = await status(page);
  check('the lowest vertex of the actual geometry is on the bed baseline', near(s.lo[1], BED, TOL), f3(s.lo[1]));
  check('the status reports the true drop distance', near(parseFloat((/down ([0-9.]+) mm/.exec(msg) || [])[1]), was - BED, 0.006), msg);
  check('liftY is 0 and the export\'s lowest point is 0', near(s.liftY, 0, 1e-9) && near(await exportMinZ(page, bit), 0, TOL), f3(await exportMinZ(page, bit)));
  await page.evaluate(() => document.getElementById('btn-to-plate').click());
  check('a second press is a truthful "Already on the plate"', (await status(page)) === 'Already on the plate', await status(page));

  /* ------------------------------------------------ 5. Tip on face */
  console.log('\n=== 5. Tip on face lands the face ===');
  const face = await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id);
    // To plate took it straight down, which is inside the hull's footprint: clear of it first
    applyPlacedXZ(p, 70, 40);
    p.mesh.updateMatrixWorld(true);
    const b = meshLocalBox3(p.mesh), c = b.getCenter(new THREE.Vector3());
    // a side face the camera can see: a ray along +x at the piece's middle hits its -x face
    const rc = new THREE.Raycaster(new THREE.Vector3(b.min.x - 50, c.y, c.z), new THREE.Vector3(1, 0, 0));
    const h = rc.intersectObject(p.mesh, false)[0];
    const n = h.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(p.mesh.matrixWorld)).normalize();
    return { n: n.toArray(), point: h.point.toArray() };
  }, bit);
  await page.evaluate(id => { selectPlaced(state.placed.findIndex(q => q && q.sourceId === id)); }, bit);
  await page.evaluate(() => nsoTipOrient.setArmed(true));
  const fs = await screenOf(page, face.point);
  await page.mouse.click(fs.x, fs.y);
  await page.waitForTimeout(150);
  s = await measure(page, bit);
  const faceDown = await page.evaluate(([id]) => {
    // the face that was clicked is the one now against the plate: its triangle's normal points straight down
    const p = state.placed.find(q => q && q.sourceId === id);
    p.mesh.updateMatrixWorld(true);
    const n = new THREE.Matrix3().getNormalMatrix(p.mesh.matrixWorld);
    const P = p.mesh.geometry.attributes.position, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let best = null;
    for (let i = 0; i + 2 < P.count; i += 3) {
      a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, i + 1); c.fromBufferAttribute(P, i + 2);
      const nn = b.clone().sub(a).cross(c.clone().sub(a)).normalize().applyMatrix3(n).normalize();
      if (nn.y < -0.9999) best = nn;
    }
    return best ? best.y : null;
  }, [bit]);
  check('a face of the piece is flat against the plate (its normal points straight down)', faceDown !== null && faceDown < -0.9999, (await status(page)));
  check('Tip on face: the lowest vertex is on the bed baseline', near(s.lo[1], BED, TOL), f3(s.lo[1]));
  check('...and the export\'s lowest point is 0', near(await exportMinZ(page, bit), 0, TOL), f3(await exportMinZ(page, bit)));

  /* ------------------------------------------------ 6. the invalidation */
  console.log('\n=== 6. one invalidation: in-place edits, a bake, and an Undo ===');
  const ed = await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id);
    const g = p.mesh.geometry;
    const truth = () => {
      p.mesh.updateMatrixWorld(true);
      const P = g.attributes.position, v = new THREE.Vector3(), bb = new THREE.Box3();
      for (let i = 0; i < P.count; i++) bb.expandByPoint(v.fromBufferAttribute(P, i).applyMatrix4(p.mesh.matrixWorld));
      return bb.getSize(new THREE.Vector3()).y;
    };
    const h0 = meshLocalBox3(p.mesh).getSize(new THREE.Vector3()).y;
    // stretch y in place and tell nobody: no needsUpdate, no recompute
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) P.array[i * 3 + 1] *= 2;
    const want = truth();
    const stale = meshLocalBox3(p.mesh).getSize(new THREE.Vector3()).y;
    const ret = nsoInvalidatePieceBounds(p);
    const fresh = meshLocalBox3(p.mesh).getSize(new THREE.Vector3()).y;
    const hStretched = p.height;
    for (let i = 0; i < P.count; i++) P.array[i * 3 + 1] /= 2;
    nsoInvalidatePieceBounds(p);
    return { h0, stale, fresh, want, ret: ret && ret.y, hStretched, hBack: p.height, back: meshLocalBox3(p.mesh).getSize(new THREE.Vector3()).y };
  }, bit);
  check('an edit that announces nothing is not seen by the cache...', near(ed.stale, ed.h0, 1e-6) && Math.abs(ed.want - ed.h0) > 0.3,
    f3(ed.stale) + ' (truth now ' + f3(ed.want) + ')');
  check('...until nsoInvalidatePieceBounds, which re-measures it', near(ed.fresh, ed.want, 1e-3) && near(ed.ret, ed.fresh, 1e-9),
    f3(ed.fresh) + ' vs ' + f3(ed.want));
  check('and the piece\'s height is re-read off the posed box, then back', near(ed.hStretched, ed.want, 1e-3) && near(ed.hBack, ed.back, 1e-6) && near(ed.back, ed.h0, 1e-3),
    f3(ed.hStretched) + ' / ' + f3(ed.hBack));

  // a bake through the shared commit, on a posed piece in the air
  const bake = await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id), m = state.models.find(q => q.id === id);
    p.liftY = 30; applyMeshRotation(p);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3);
    const raw = m.rawTris, out = new Float32Array(raw.length), v = new THREE.Vector3();
    for (let i = 0; i < raw.length; i += 3) { v.set(raw[i], raw[i + 1], raw[i + 2]).applyQuaternion(q); out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; }
    return NSO_sculptCommitRaw(m, out, 'seatSurfaceReplace', null);
  }, bit);
  s = await measure(page, bit);
  check('a bake through NSO_sculptCommitRaw leaves liftY true', bake && near(s.liftY, 30, 1e-9) && near(s.lo[1], BED + 30, TOL),
    'lowest vertex ' + f3(s.lo[1]) + ', liftY ' + f3(s.liftY));
  check('...and the recorded height is the posed box\'s', near(s.h, s.hi[1] - s.lo[1], TOL), f3(s.h) + ' vs ' + f3(s.hi[1] - s.lo[1]));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(100);
  s = await measure(page, bit);
  check('Undo of the bake: the lowest vertex is where the record says', near(s.lo[1], BED + s.liftY, TOL),
    f3(s.lo[1]) + ' vs ' + f3(BED + s.liftY));

  /* ------------------------------------------------ 7. the drop's Undo */
  console.log('\n=== 7. the Undo of a drop puts the piece back where it was ===');
  await page.evaluate(() => { if (nsoTipOrient.armed()) nsoTipOrient.setArmed(false); });
  await page.evaluate(([hull, bit]) => {
    const pb = state.placed.find(q => q && q.sourceId === bit);
    pb.tipX = 0; pb.tipZ = 0; pb.tiltX = 10; pb.tiltZ = 7; pb.rotY = 0.5; pb.liftY = 0;
    applyMeshRotation(pb); applyPlacedXZ(pb, 70, 40);
    state.undoStack.length = 0; updateUndoBtn();
  }, [hull, bit]);
  const b0 = await measure(page, bit);
  await dropSeat(page, hull, bit, setup.corner);
  const seated2 = await status(page);
  check('the second drop seats and bakes too', /baked into its own axes/.test(seated2), seated2.slice(0, 120));
  const depthBefore = await page.evaluate(() => state.undoStack.length);
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(150);
  const b1 = await measure(page, bit);
  check('one Undo: it is back where it was picked up', depthBefore === 1 && near(b1.lo[1], b0.lo[1], TOL) && near(b1.liftY, b0.liftY, TOL) &&
    near(b1.pos[0], b0.pos[0], 1e-3) && near(b1.pos[2], b0.pos[2], 1e-3),
    'depth ' + depthBefore + ', lowest ' + f3(b1.lo[1]) + ' vs ' + f3(b0.lo[1]));
  check('...its recorded height is the posed box\'s again', near(b1.h, b1.hi[1] - b1.lo[1], TOL), f3(b1.h) + ' vs ' + f3(b1.hi[1] - b1.lo[1]));

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exitCode = 1; });
