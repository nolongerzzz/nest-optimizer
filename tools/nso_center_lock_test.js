/* Evidence for Center lock, driven through the real app in Chromium:
   index.html, every app-*.js, the real buttons, the real canvas clicks.

     node tools/nso_center_lock_test.js      exit 0 = every gate held

   Three things are under test.

   1. EXACTNESS. Center lock is a pure XZ translation, so after it runs B's
      reference point must BE the target, not merely near it. Both reference
      points are recomputed here from the mesh's own geometry and world
      matrix - not by calling the app's helpers - so a wrong helper cannot
      agree with itself. The gate is 1e-6 mm, which is float noise on a
      plate measured in hundreds of millimetres.

   2. KNOWN GEOMETRY. The fixtures are boxes of stated size, so the values
      the app should land on are known in advance and asserted as numbers,
      not just as "A and B now match": box-20mm is 20x20x20 centred on its
      own origin, lid_strap is 60x48x2.4 with a step that pulls its volume
      centroid exactly 20/7 mm off its box centre. That offset is what separates
      the two reference modes - if centroid mode silently fell back to the
      bounding box, the two modes would land on the same spot and the test
      would say so.

   3. COMPOSITION. Center lock is the rough step, not a replacement for the
      fine ones. So after a lock, Align and Seat are each called and must
      behave exactly as they do from any other pose: Align still finds a
      wall and snaps B's edge to it (which MOVES B off the lock - that is
      the point), and Seat still reports its own result rather than failing
      on a pose Center lock left inconsistent. The XZ that Align produces
      from a locked pose is compared against the XZ Align produces when it
      is handed the same starting pose directly. */

const path = require('path');
const { withApp, loadSTL, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const EPS = 1e-6;          // mm - exactness gate
let fails = 0;

function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
}
function near(name, got, want, tol, detail) {
  const d = Math.abs(got - want);
  check(name, d <= tol,
    'got ' + got.toFixed(9) + ' want ' + want.toFixed(9) + ' (|d|=' + d.toExponential(2) + ')'
    + (detail ? ' ' + detail : ''));
  return d;
}

/* ---------------------------------------------------------------- page-side

   Reference points recomputed from scratch, deliberately NOT by calling
   meshLocalBox3 / NSO_CenterLock.refPointXZ. Injected once per page. */
const PROBE = `
window.__probe = {
  soup: function (mesh) {
    mesh.updateMatrixWorld(true);
    var g = mesh.geometry, pos = g.attributes.position;
    var idx = g.index ? g.index.array : null;
    var n = idx ? idx.length : pos.count;
    var out = new Float64Array(n * 3);
    var v = new THREE.Vector3();
    for (var i = 0; i < n; i++) {
      var vi = idx ? idx[i] : i;
      v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(mesh.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  },
  box: function (mesh) {
    var s = window.__probe.soup(mesh);
    var mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity,
        mny = Infinity, mxy = -Infinity;
    for (var i = 0; i < s.length; i += 3) {
      if (s[i] < mnx) mnx = s[i];       if (s[i] > mxx) mxx = s[i];
      if (s[i+1] < mny) mny = s[i+1];   if (s[i+1] > mxy) mxy = s[i+1];
      if (s[i+2] < mnz) mnz = s[i+2];   if (s[i+2] > mxz) mxz = s[i+2];
    }
    return { x: (mnx + mxx) / 2, z: (mnz + mxz) / 2,
             w: mxx - mnx, h: mxy - mny, d: mxz - mnz,
             minx: mnx, maxx: mxx, minz: mnz, maxz: mxz, miny: mny };
  },
  centroid: function (mesh) {
    var s = window.__probe.soup(mesh);
    var V = 0, cx = 0, cz = 0;
    for (var t = 0; t < s.length / 9; t++) {
      var o = t * 9;
      var ax = s[o], ay = s[o+1], az = s[o+2];
      var bx = s[o+3], by = s[o+4], bz = s[o+5];
      var gx = s[o+6], gy = s[o+7], gz = s[o+8];
      var det = ax*(by*gz - bz*gy) - ay*(bx*gz - bz*gx) + az*(bx*gy - by*gx);
      var v = det / 6;
      V += v; cx += v * (ax+bx+gx) / 4; cz += v * (az+bz+gz) / 4;
    }
    return { x: cx / V, z: cz / V, V: V };
  },
  ref: function (mesh, mode) {
    return mode === 'centroid' ? window.__probe.centroid(mesh) : window.__probe.box(mesh);
  },
  placedBy: function (id) {
    return state.placed.find(function (p) { return p && p.sourceId === id && p.mesh; });
  }
};
`;

/* Two fixtures on the plate, Join started, A and B picked - the same state
   the Center X / Center Z / Align / Seat buttons all require. */
async function setup(page, fileA, fileB) {
  await page.evaluate(() => {
    state.models = []; state.placed = []; state.undoStack = [];
    if (state.modelGroup) {
      while (state.modelGroup.children.length) {
        state.modelGroup.remove(state.modelGroup.children[0]);
      }
    }
    clearJoinSlots();
  });
  const idA = await loadSTL(page, fx(fileA));
  const idB = await loadSTL(page, fx(fileB));
  // placedIndex is stamped at push time; a wiped plate has to renumber.
  await page.evaluate(() => {
    state.placed.forEach((p, i) => { if (p && p.mesh) p.mesh.userData.placedIndex = i; });
  });
  await page.click('#btn-join-start');
  await page.evaluate(([a, b]) => {
    state.joinArmed = 'a'; assignJoinClick(a);
    state.joinArmed = 'b'; assignJoinClick(b);
  }, [idA, idB]);
  return { idA, idB };
}

const setMode = (page, mode) =>
  page.selectOption('#center-lock-ref', mode);

const poseOf = (page, id, mode) => page.evaluate(([i, m]) => {
  const p = window.__probe.placedBy(i);
  const r = window.__probe.ref(p.mesh, m);
  const bx = window.__probe.box(p.mesh);
  return { x: p.x, z: p.z, refx: r.x, refz: r.z, box: bx, meshX: p.mesh.position.x, meshZ: p.mesh.position.z };
}, [id, mode]);

/* --------------------------------------------------------------- the suite */

async function main(page) {
  await page.evaluate(PROBE);
  await page.evaluate(async () => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
    /* `.vp-menu` is an EXCLUSIVE accordion: the toggle handler in app-join.js
       closes every other menu when one opens, and `toggle` fires
       ASYNCHRONOUSLY - so the blanket open above is partly undone a task
       later, and re-opening a menu that is still `open` at this instant is a
       no-op that the queued handlers then override. Let them settle, then set
       the accordion explicitly to the menu whose buttons this suite clicks.
       This was invisible while Finish was the only .vp-menu on the page. */
    await new Promise(r => setTimeout(r, 0));
    document.querySelectorAll('.vp-menu').forEach(m => {
      m.open = m.classList.contains('vp-finish-menu');
    });
    await new Promise(r => setTimeout(r, 0));
  });

  /* ---- 1. the control is wired at all ---- */
  console.log('\n[1] control is present and gated like its siblings');
  const wired = await page.evaluate(() => ({
    lock: !!document.getElementById('btn-center-lock'),
    pick: !!document.getElementById('btn-center-lock-pick'),
    sel: !!document.getElementById('center-lock-ref'),
    mod: typeof window.NSO_CenterLock,
    hook: typeof window.nsoCenterLockTakesClick,
    lockOffBefore: document.getElementById('btn-center-lock').disabled
  }));
  check('Center lock button exists', wired.lock);
  check('Pick target button exists', wired.pick);
  check('reference-mode select exists', wired.sel);
  check('NSO_CenterLock module loaded', wired.mod === 'object', wired.mod);
  check('canvas click hook exported', wired.hook === 'function', wired.hook);
  check('disabled before Join picks A and B', wired.lockOffBefore === true);

  /* ---- 2. bounding-box mode, exact, against known geometry ---- */
  console.log('\n[2] bounding-box mode lands exactly on A\'s box centre');
  let ids = await setup(page, 'lid_strap.stl', 'box-20mm.stl');
  check('enabled once A and B are picked',
    await page.evaluate(() => !document.getElementById('btn-center-lock').disabled));

  await setMode(page, 'bbox');
  // Shove A onto a deliberately unround XZ first. Landing on the origin is
  // the one answer a broken lock could reach by accident (a reset, a clamp,
  // a zeroed delta), so the target must not be the origin.
  await page.evaluate(i => {
    applyPlacedXZ(window.__probe.placedBy(i), 13.37, -7.25);
  }, ids.idA);
  const aBox = (await poseOf(page, ids.idA, 'bbox')).box;
  check('A sits off the origin, so the origin cannot be a lucky answer',
    Math.hypot(aBox.x, aBox.z) > 1, '(' + aBox.x.toFixed(3) + ', ' + aBox.z.toFixed(3) + ')');
  const bBefore = await poseOf(page, ids.idB, 'bbox');
  // The fixtures are boxes of stated size; the app may re-seat axes on
  // import, so assert the footprint is one of the two allowed spellings.
  check('A footprint is lid_strap 60x48 (or 48x60 after axis re-seat)',
    (Math.abs(aBox.w - 60) < 1e-3 && Math.abs(aBox.d - 48) < 1e-3) ||
    (Math.abs(aBox.w - 48) < 1e-3 && Math.abs(aBox.d - 60) < 1e-3),
    aBox.w.toFixed(3) + ' x ' + aBox.d.toFixed(3));
  check('B footprint is box-20mm 20x20',
    Math.abs(bBefore.box.w - 20) < 1e-3 && Math.abs(bBefore.box.d - 20) < 1e-3,
    bBefore.box.w.toFixed(3) + ' x ' + bBefore.box.d.toFixed(3));
  check('B does not already sit on the target',
    Math.hypot(bBefore.refx - aBox.x, bBefore.refz - aBox.z) > 1,
    'start offset ' + Math.hypot(bBefore.refx - aBox.x, bBefore.refz - aBox.z).toFixed(3) + 'mm');

  await page.click('#btn-center-lock');
  const bAfter = await poseOf(page, ids.idB, 'bbox');
  near('B box centre X == A box centre X', bAfter.refx, aBox.x, EPS);
  near('B box centre Z == A box centre Z', bAfter.refz, aBox.z, EPS);
  check('status reports the lock', /Center locked/.test(await statusOf(page)), await statusOf(page));
  // The delta asked for is the delta applied: placed.x moved by exactly the
  // gap that was there, so nothing clamped or rounded it on the way through.
  near('placed.x moved by exactly the X gap',
    bAfter.x - bBefore.x, aBox.x - bBefore.refx, EPS);
  near('placed.z moved by exactly the Z gap',
    bAfter.z - bBefore.z, aBox.z - bBefore.refz, EPS);
  check('placed.x and mesh.position.x stayed in step',
    Math.abs(bAfter.x - bAfter.meshX) <= EPS && Math.abs(bAfter.z - bAfter.meshZ) <= EPS);
  check('A did not move',
    JSON.stringify((await poseOf(page, ids.idA, 'bbox')).box) === JSON.stringify(aBox));

  /* ---- 3. undo puts the pose back ---- */
  console.log('\n[3] one Undo restores the pose');
  await page.evaluate(() => undoLast());
  const bUndone = await poseOf(page, ids.idB, 'bbox');
  near('undo restores placed.x', bUndone.x, bBefore.x, EPS);
  near('undo restores placed.z', bUndone.z, bBefore.z, EPS);

  /* ---- 4. centroid mode is a different point, and also exact ---- */
  console.log('\n[4] centroid mode locks on the centroid, not the box centre');
  await page.click('#btn-center-lock');   // back to the locked pose (bbox mode)
  const aCent = await page.evaluate(i => {
    const p = window.__probe.placedBy(i);
    return window.__probe.centroid(p.mesh);
  }, ids.idA);
  /* lid_strap is 60x48x2.4 with a step, built as a real boolean union by
     `fixtures: hinge and strap parts become real boolean unions` (6e0182e).
     Its in-plane centroid offset is exactly 20/7 mm and its volume exactly
     6048 mm3 - both read straight off the fixture, so if the fixture is
     rebuilt again these two gates say so rather than quietly passing on a
     shape that no longer separates the modes. */
  const STRAP_OFFSET = 20 / 7;   // 2.857142... mm, in-plane
  const STRAP_VOLUME = 6048;     // mm3
  const gap = Math.hypot(aCent.x - aBox.x, aCent.z - aBox.z);
  check('lid_strap centroid is 20/7mm off its box centre (known geometry)',
    Math.abs(gap - STRAP_OFFSET) < 2e-3,
    'gap ' + gap.toFixed(6) + 'mm, want ' + STRAP_OFFSET.toFixed(6));
  check('lid_strap reads as a closed solid (V=6048mm3)',
    Math.abs(Math.abs(aCent.V) - STRAP_VOLUME) < 1, 'V=' + aCent.V.toFixed(2));

  await setMode(page, 'centroid');
  await page.click('#btn-center-lock');
  const bCent = await page.evaluate(i => {
    const p = window.__probe.placedBy(i);
    return window.__probe.centroid(p.mesh);
  }, ids.idB);
  /* Bounding-box mode is bit-exact: it reads the world AABB straight off
     meshLocalBox3 in doubles. Centroid mode reuses meshToWorldSoup, the
     app's shared world-soup helper, which is a Float32Array - so the
     centroid carries float32 quantisation and lands within ~1e-7 mm rather
     than on the bit. That is 30 picometres on a tool whose job is to get a
     piece "close enough" for Seat to take over, so the soup is reused as-is
     rather than duplicated in double precision. These two gates pin the
     size of that error so it cannot quietly grow. */
  const dcx = near('B centroid X == A centroid X', bCent.x, aCent.x, EPS);
  const dcz = near('B centroid Z == A centroid Z', bCent.z, aCent.z, EPS);
  check('centroid error stays in float32 territory (<1e-6mm)',
    dcx < 1e-6 && dcz < 1e-6,
    'dx=' + dcx.toExponential(2) + ' dz=' + dcz.toExponential(2));
  const bCentBox = (await poseOf(page, ids.idB, 'bbox')).box;
  check('centroid mode did NOT land where bbox mode landed',
    Math.hypot(bCentBox.x - aBox.x, bCentBox.z - aBox.z) > 1e-3,
    'separation ' + Math.hypot(bCentBox.x - aBox.x, bCentBox.z - aBox.z).toFixed(4) + 'mm');
  // box-20mm is symmetric, so its own centroid and box centre coincide - the
  // whole 20/7mm separation above comes from A, as it should.
  near('box-20mm centroid == its own box centre (symmetric fixture)',
    Math.hypot(bCent.x - bCentBox.x, bCent.z - bCentBox.z), 0, 1e-6);

  /* ---- 5. a clicked target point, through the real canvas ---- */
  console.log('\n[5] picked target: a real click on A sets the lock point');
  await setMode(page, 'bbox');
  ids = await setup(page, 'lid_strap.stl', 'box-20mm.stl');
  const aBox2 = (await poseOf(page, ids.idA, 'bbox')).box;
  // Aim at a corner region of A's top face, well away from its centre, so a
  // lock onto the pick is plainly distinguishable from the default lock.
  const aim = {
    x: aBox2.minx + (aBox2.maxx - aBox2.minx) * 0.22,
    z: aBox2.minz + (aBox2.maxz - aBox2.minz) * 0.25
  };
  await page.click('#btn-center-lock-pick');
  check('pick arms', await page.evaluate(() => state.centerLockArmed === true));
  const screen = await page.evaluate(p => {
    const el = state.renderer.domElement;
    const r = el.getBoundingClientRect();
    const box = window.__probe.box(window.__probe.placedBy(state.editId).mesh);
    const v = new THREE.Vector3(p.x, box.miny + (box.h || 1), p.z).project(state.camera);
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, aim);
  await page.mouse.move(screen.x, screen.y);
  await page.mouse.down();
  await page.mouse.up();
  const picked = await page.evaluate(() => state.centerLockTarget);
  check('a target was stored', !!picked, JSON.stringify(picked));
  if (picked) {
    check('target belongs to A', picked.sourceId === ids.idA);
    check('target lies inside A\'s footprint',
      picked.x >= aBox2.minx - 1e-6 && picked.x <= aBox2.maxx + 1e-6 &&
      picked.z >= aBox2.minz - 1e-6 && picked.z <= aBox2.maxz + 1e-6,
      '(' + picked.x.toFixed(3) + ', ' + picked.z.toFixed(3) + ')');
    check('the click landed near where it aimed',
      Math.hypot(picked.x - aim.x, picked.z - aim.z) < 2,
      'aim (' + aim.x.toFixed(2) + ',' + aim.z.toFixed(2) + ') hit ('
        + picked.x.toFixed(2) + ',' + picked.z.toFixed(2) + ')');
    check('the pick disarmed itself', await page.evaluate(() => state.centerLockArmed === false));
    const bPick = await poseOf(page, ids.idB, 'bbox');
    near('B box centre X == picked X', bPick.refx, picked.x, EPS);
    near('B box centre Z == picked Z', bPick.refz, picked.z, EPS);
    check('a picked target is NOT A\'s centre',
      Math.hypot(picked.x - aBox2.x, picked.z - aBox2.z) > 1,
      'off-centre by ' + Math.hypot(picked.x - aBox2.x, picked.z - aBox2.z).toFixed(3) + 'mm');
    // Pressing the button again repeats the same lock, idempotently.
    await page.click('#btn-center-lock');
    const bAgain = await poseOf(page, ids.idB, 'bbox');
    near('a second press is a no-op (idempotent)',
      Math.hypot(bAgain.refx - picked.x, bAgain.refz - picked.z), 0, EPS);
  }

  /* ---- 6. composes with Align ---- */
  console.log('\n[6] Align after a lock behaves exactly as Align alone');
  ids = await setup(page, 'box_hull_80x40x20-2.stl', 'box-20mm.stl');
  await setMode(page, 'bbox');
  const bStart = await poseOf(page, ids.idB, 'bbox');
  await page.click('#btn-center-lock');
  const bLocked = await poseOf(page, ids.idB, 'bbox');
  check('the lock moved B', Math.hypot(bLocked.x - bStart.x, bLocked.z - bStart.z) > 1,
    'moved ' + Math.hypot(bLocked.x - bStart.x, bLocked.z - bStart.z).toFixed(3) + 'mm');
  const alignA = await page.evaluate(() => {
    const ok = alignJoinForSlide();
    return { ok: ok, status: document.getElementById('status').textContent };
  });
  const afterLockAlign = await poseOf(page, ids.idB, 'bbox');
  check('Align still succeeds from a locked pose', alignA.ok === true, alignA.status);
  check('Align then moves B on - the lock was the rough step, not the last one',
    Math.hypot(afterLockAlign.x - bLocked.x, afterLockAlign.z - bLocked.z) > 1e-6,
    'Align moved a further '
      + Math.hypot(afterLockAlign.x - bLocked.x, afterLockAlign.z - bLocked.z).toFixed(3) + 'mm');

  /* Same question from the other side: hand Align that very pose with no
     Center lock anywhere in the history. If the two agree to float precision
     then the lock leaves nothing behind for Align to trip on - it is just a
     pose, and Align reads it the way it reads any other. */
  ids = await setup(page, 'box_hull_80x40x20-2.stl', 'box-20mm.stl');
  await page.evaluate(p => {
    applyPlacedXZ(window.__probe.placedBy(state.joinPartnerId), p.x, p.z);
  }, { x: bLocked.x, z: bLocked.z });
  const alignB = await page.evaluate(() => {
    const ok = alignJoinForSlide();
    return { ok: ok, status: document.getElementById('status').textContent };
  });
  const afterPlainAlign = await poseOf(page, ids.idB, 'bbox');
  check('Align from the same pose without the lock also succeeds',
    alignB.ok === true, alignB.status);
  check('and reports the same wall', alignA.status === alignB.status,
    alignA.status + ' | ' + alignB.status);
  near('Align lands on the same X either way', afterLockAlign.x, afterPlainAlign.x, EPS);
  near('Align lands on the same Z either way', afterLockAlign.z, afterPlainAlign.z, EPS);

  /* ---- 7. composes with Seat ---- */
  console.log('\n[7] Seat after a lock runs on the pose the lock left');
  ids = await setup(page, 'box_hull_80x40x20-2.stl', 'pin.stl');
  await setMode(page, 'bbox');
  await page.click('#btn-center-lock');
  const preSeat = await poseOf(page, ids.idB, 'bbox');
  await page.click('#btn-seat-flush');
  const seatStatus = await statusOf(page);
  const postSeat = await poseOf(page, ids.idB, 'bbox');
  check('Seat reports its own verdict, not a broken pose',
    /^Seated|^Seat failed/.test(seatStatus), seatStatus);
  check('Seat left placed.x/z and mesh.position in step',
    Math.abs(postSeat.x - postSeat.meshX) <= 1e-6 &&
    Math.abs(postSeat.z - postSeat.meshZ) <= 1e-6);
  check('Center lock handed Seat a finite pose',
    isFinite(preSeat.x) && isFinite(preSeat.z) &&
    isFinite(postSeat.x) && isFinite(postSeat.z));

  /* ---- 8. the guards ---- */
  console.log('\n[8] guards');
  await page.evaluate(() => { clearJoinSlots(); });
  check('button re-disables when the Join is cleared',
    await page.evaluate(() => document.getElementById('btn-center-lock').disabled === true));
  check('a stale target is dropped with the slots',
    await page.evaluate(() => state.centerLockTarget === null));
  const noPair = await page.evaluate(() => {
    document.getElementById('status').textContent = '';
    const ok = NSO_CenterLock.run();
    return { ok: ok, status: document.getElementById('status').textContent };
  });
  check('run() with no pair refuses and says so',
    noPair.ok === false && /Start Join/.test(noPair.status), noPair.status);
}

withApp(async (page, logs) => {
  await main(page);
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) {
    console.log('\npage errors:\n' + errs.join('\n'));
    fails += errs.length;
  }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('CENTER LOCK TEST FAIL', e); process.exit(1); });
