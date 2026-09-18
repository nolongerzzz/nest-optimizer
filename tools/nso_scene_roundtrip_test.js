/* Scene round trip through the shipped app.
   node tools/nso_scene_roundtrip_test.js      exit 0 = every value came back

   The module-level half lives in tools/3mf-test/scene-check.js (the transform
   chain, the schema, the rejects). This is the other half: a REAL plate built
   through the real controls, exported through the real Export plate 3MF
   button, the app wiped, the file re-opened through the real file input, and
   every value compared against what the scene held before.

   THE PLATE, one piece per state type, nothing at a default:

     hull   box_hull_80x40x20-2.stl, yawed 0.7 rad, banked -12 deg, lifted
            4.25 mm, off-centre - and LOCKED (app-poslock.js), with its top
            face PAINTED EXCLUDED and a side face PAINTED SELECTED
            (app-mask.js, through nsoMaskToggleAt / nsoMaskSelectAt, the same
            entry points a viewport click reaches)
     bit    box-20mm.stl, SEATED on the hull at gap -0.18 mm through the
            Seat (support) button and its slider (app-join.js)
     clip   box-20mm.stl, tipped and rolled, SKINNED with a crosshatch on one
            face (app-skin.js) and flagged NON-SOLID (app-nonsolid.js)

   plus the PLATE LOCK over all three, and the plate preset itself.

   Then, separately: a file Bambu Studio wrote (fixtures/3mf/pa_pattern.3mf)
   goes through the same import, and has to land as ordinary geometry - no
   scene block, no error, nothing that assumes one. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const Scene = require(path.join(ROOT, 'nso-3mf-scene.js'));

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
};
const section = t => console.log('\n=== ' + t + ' ===');

/* Same tolerance as tools/nso_export_roundtrip_test.js: above Float32 ULP at
   plate scale, far below anything a slicer acts on. */
const TOL = 5e-5;
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= (tol == null ? TOL : tol);
const nearAll = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  a.every((v, i) => near(v, b[i], tol));

const GAP = -0.18;
const HULL_POSE = { rotY: 0.7, tiltZ: -12, liftY: 4.25 };
const HULL_XZ = { x: -28.5, z: 21.75 };
const CLIP_POSE = { tipX: 1, tipZ: 2, tiltX: 7.5, liftY: 1.5 };
const CLIP_XZ = { x: 46.25, z: -33.5 };

// ---------------------------------------------------------------------------
// in-page helpers
// ---------------------------------------------------------------------------

/* Stage the bit above the hull and open a Join session, the way
   tools/nso_seat_gap_test.js does, so Seat (support) has a pair to work on. */
const stageSeat = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.liftY = 0;
  pA.mesh.position.set(pA.x, pA.height / 2 + 0.3, pA.z);
  pA.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  pB.liftY = 0; pB.x = pA.x; pB.z = pA.z;
  pB.mesh.quaternion.identity();
  pB.mesh.position.set(pA.x, bbA.max.y + 5 + pB.height / 2, pA.z);
  pB.mesh.updateMatrixWorld(true);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  return true;
};

/* Paint through the app's own entry points, with the raycast spelled out
   instead of coming from a pointer event. `nsoMaskToggleAt` / `nsoMaskSelectAt`
   are exactly what the viewport click handler calls. */
const paintFaces = (id) => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  const m = state.models.find(x => x.id === id);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const c = new THREE.Vector3(); bb.getCenter(c);
  const ray = new THREE.Raycaster();

  // straight down onto the top face -> exclude it
  ray.set(new THREE.Vector3(c.x, bb.max.y + 50, c.z), new THREE.Vector3(0, -1, 0));
  const top = ray.intersectObject(p.mesh, false);
  if (top.length) window.nsoMaskToggleAt(m, p.mesh, top[0]);

  // in from +X onto a side face -> make it the selected target
  ray.set(new THREE.Vector3(bb.max.x + 50, c.y, c.z), new THREE.Vector3(-1, 0, 0));
  const side = ray.intersectObject(p.mesh, false);
  if (side.length) window.nsoMaskSelectAt(m, p.mesh, side[0]);

  return { excluded: window.nsoMaskCount(m), selected: window.nsoMaskSelectCount(m) };
};

/* Everything the scene block claims to carry, read straight off the live app.
   Keyed by position on the plate, which is what the file preserves. */
const snapshot = () => state.placed.map((p, i) => {
  const m = state.models.find(x => x.id === p.sourceId) || null;
  const mask = (m && window.nsoMaskSnapshot) ? window.nsoMaskSnapshot(m) : null;
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return {
    name: p.name,
    x: p.x, z: p.z, liftY: p.liftY || 0,
    rotY: p.rotY || 0, flipX: !!p.flipX,
    tipX: p.tipX || 0, tipZ: p.tipZ || 0,
    tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0,
    width: p.width, depth: p.depth, height: p.height,
    worldBox: [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z],
    locked: !!(window.nsoPosLocked && window.nsoPosLocked(m)),
    nonSolid: !!(window.nsoNonSolid && window.nsoNonSolid(m)),
    seat: p.seat || null,
    skin: m ? (m.skin || null) : null,
    paint: mask,
    centerOffset: m && m.centerOffset ? [m.centerOffset.x, m.centerOffset.y, m.centerOffset.z] : null,
    rawCount: (m && m.rawTris) ? m.rawTris.length : 0,
    raw: (m && m.rawTris) ? Array.from(m.rawTris) : null
  };
});

const plateSnapshot = () => ({
  preset: state.plate,
  plateLock: !!(window.nsoPlateLocked && window.nsoPlateLocked()),
  pieces: state.placed.length,
  models: state.models.length
});

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-scene-rt-'));
  page.on('dialog', d => d.accept());   // the "restore this plate?" confirm

  // -----------------------------------------------------------------------
  section('build a real plate');
  // -----------------------------------------------------------------------
  const wired = await page.evaluate(() => ({
    scene: typeof window.NSO3MFScene,
    poslock: typeof window.nsoPosLockSet,
    nonsolid: typeof window.nsoNonSolidSet,
    mask: typeof window.nsoMaskToggleAt,
    skin: typeof NSO_skinFaceOfModel,
    seat: !!document.getElementById('btn-seat-support')
  }));
  check('every module the scene block reads is loaded',
    wired.scene === 'object' && wired.poslock === 'function' && wired.nonsolid === 'function' &&
    wired.mask === 'function' && wired.skin === 'function' && wired.seat, JSON.stringify(wired));

  const idHull = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idBit = await loadSTL(page, fx('box-20mm.stl'));
  const idClip = await loadSTL(page, fx('box-20mm.stl'));
  eq('three pieces on the plate', await page.evaluate(() => state.placed.length), 3);

  // ---- the seated pair, through the real button and the real slider ----
  await page.evaluate(stageSeat, [idHull, idBit]);
  await page.evaluate(v => {
    const el = document.getElementById('seat-gap');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, GAP);
  await page.click('#btn-seat-support');
  const seated = await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id);
    return { seat: p.seat || null, status: document.getElementById('status').textContent };
  }, idBit);
  check('Seat (support) seated the bit at the slider gap',
    seated.seat && seated.seat.gap === GAP && seated.seat.kind === 'support',
    JSON.stringify(seated.seat) + ' | ' + seated.status);
  check('and it named the piece it seated against', seated.seat && /box_hull/.test(seated.seat.partnerName),
    seated.seat && seated.seat.partnerName);
  await page.evaluate(() => { state.joinSession = false; state.joinPartnerId = null; });

  // ---- the skin, through the function the Skin face button calls ----
  // Baked BEFORE the clip is posed, and that order matters: NSO_sculptCommitRaw
  // rebuilds the placed mesh unrotated, so a bake after a pose leaves the drawn
  // mesh and the pose bookkeeping disagreeing until the next pose change. That
  // is the app's behaviour today and it predates the scene block - every
  // exporter already reads the bookkeeping, so a file written in that state
  // already disagrees with the viewport. Posing after the bake keeps this
  // check on the round trip rather than on that.
  const skinned = await page.evaluate(id => {
    state.editId = id;
    const m = state.models.find(x => x.id === id);
    const r = NSO_skinFaceOfModel(m, { pattern: 'crosshatch' });
    return { ok: !!r.ok, reason: r.reason || null, skin: m.skin || null, tris: m.rawTris.length / 9 };
  }, idClip);
  check('Skin face baked a crosshatch onto the clip', skinned.ok, skinned.reason);
  check('and it left a record of what it baked',
    skinned.skin && skinned.skin.pattern === 'crosshatch' && skinned.skin.scope === 'face' &&
    skinned.skin.faces.length === 1, JSON.stringify(skinned.skin));

  await page.evaluate(id => {
    window.nsoNonSolidSet(state.models.find(x => x.id === id), true);
  }, idClip);

  // ---- poses ----
  await page.evaluate(([id, pose, xz]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    applyPlacedOrientation(p, pose);
    applyPlacedXZ(p, xz.x, xz.z);
  }, [idHull, HULL_POSE, HULL_XZ]);
  await page.evaluate(([id, pose, xz]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    applyPlacedOrientation(p, pose);
    applyPlacedXZ(p, xz.x, xz.z);
  }, [idClip, CLIP_POSE, CLIP_XZ]);

  // ---- the paint, on the hull ----
  const painted = await page.evaluate(paintFaces, idHull);
  check('hull carries one excluded face and one selected target',
    painted.excluded === 1 && painted.selected === 1, JSON.stringify(painted));

  // ---- the locks ----
  await page.evaluate(id => {
    window.nsoPosLockSet(state.models.find(x => x.id === id), true);
  }, idHull);
  await page.evaluate(() => { window.nsoPlateLockSet(true); });

  const before = await page.evaluate(snapshot);
  const plateBefore = await page.evaluate(plateSnapshot);
  check('the plate is locked and one piece is locked under it',
    plateBefore.plateLock && before.filter(p => p.locked).length === 1,
    JSON.stringify({ plate: plateBefore.plateLock, pieces: before.map(p => p.locked) }));
  check('every state type is present on the plate before the export',
    before.some(p => p.locked) && before.some(p => p.seat) && before.some(p => p.skin) &&
    before.some(p => p.nonSolid) && before.some(p => p.paint && p.paint.exclude.length) &&
    before.some(p => p.paint && p.paint.select.length),
    JSON.stringify(before.map(p => ({
      n: p.name, lock: p.locked, seat: !!p.seat, skin: !!p.skin, ns: p.nonSolid,
      ex: p.paint ? p.paint.exclude.length : 0, sel: p.paint ? p.paint.select.length : 0
    }))));

  // -----------------------------------------------------------------------
  section('export through the Export plate 3MF button');
  // -----------------------------------------------------------------------
  await page.evaluate(() => {
    const sel = document.getElementById('export-format');
    sel.value = '3mf';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  check('the button produced a .3mf', /\.3mf$/.test(file), path.basename(file));
  const exportStatus = await page.evaluate(() => document.getElementById('status').textContent);
  check('the status line says the scene went with it', /scene saved/.test(exportStatus), exportStatus);

  // read the block back in node, off the file on disk
  const R = require(path.join(ROOT, 'nso-3mf-read.js'));
  const read = await R.parse3MF(new Uint8Array(fs.readFileSync(file)), { name: path.basename(file) });
  check('the archive carries a scene block', typeof read.sceneJson === 'string');
  const parsed = Scene.parse(read.sceneJson);
  eq('one scene object per piece', parsed.objects.length, 3);
  eq('the plate preset and its lock are in the file',
     [parsed.plate.id, parsed.plate.locked], ['a1mini', true]);

  // -----------------------------------------------------------------------
  section('wipe the app');
  // -----------------------------------------------------------------------
  await page.evaluate(() => { window.nsoPlateLockSet(false); });
  await page.click('#btn-clear');
  const wiped = await page.evaluate(plateSnapshot);
  eq('nothing left: no pieces, no library, no plate lock',
     [wiped.pieces, wiped.models, wiped.plateLock], [0, 0, false]);

  // -----------------------------------------------------------------------
  section('re-open the file');
  // -----------------------------------------------------------------------
  const bytes = Array.from(fs.readFileSync(file));
  await page.evaluate(([b, n]) => { handleFiles([new File([new Uint8Array(b)], n)]); },
                      [bytes, path.basename(file)]);
  await page.waitForFunction(() => state.placed.length === 3, null, { timeout: 60000 });
  await page.waitForTimeout(150);

  const after = await page.evaluate(snapshot);
  const plateAfter = await page.evaluate(plateSnapshot);
  const importStatus = await page.evaluate(() => document.getElementById('status').textContent);
  check('the status line reports a restore, not a load', /Restored 3 piece/.test(importStatus), importStatus);

  section('every value, piece by piece');
  eq('plate preset', plateAfter.preset, plateBefore.preset);
  eq('plate lock', plateAfter.plateLock, plateBefore.plateLock);
  eq('piece count', plateAfter.pieces, plateBefore.pieces);

  before.forEach((b, i) => {
    const a = after[i];
    const tag = b.name + ':';
    eq(tag + ' name', a.name, b.name);
    check(tag + ' position x/z', nearAll([a.x, a.z], [b.x, b.z]), JSON.stringify([a.x, a.z, b.x, b.z]));
    check(tag + ' lift', near(a.liftY, b.liftY), a.liftY + ' vs ' + b.liftY);
    check(tag + ' pose angles',
      nearAll([a.rotY, a.tipX, a.tipZ, a.tiltX, a.tiltZ], [b.rotY, b.tipX, b.tipZ, b.tiltX, b.tiltZ]),
      JSON.stringify([a.rotY, a.tipX, a.tipZ, a.tiltX, a.tiltZ]) + ' vs ' +
      JSON.stringify([b.rotY, b.tipX, b.tipZ, b.tiltX, b.tiltZ]));
    eq(tag + ' flipX', a.flipX, b.flipX);
    check(tag + ' footprint', nearAll([a.width, a.depth, a.height], [b.width, b.depth, b.height], 1e-3),
      JSON.stringify([a.width, a.depth, a.height]) + ' vs ' + JSON.stringify([b.width, b.depth, b.height]));
    // the pose bookkeeping could agree while the piece sits somewhere else;
    // the world box is where the viewport actually draws it
    check(tag + ' the piece is drawn where it was', nearAll(a.worldBox, b.worldBox, 1e-3),
      JSON.stringify(a.worldBox.map(v => +v.toFixed(4))) + ' vs ' +
      JSON.stringify(b.worldBox.map(v => +v.toFixed(4))));

    eq(tag + ' lock', a.locked, b.locked);
    eq(tag + ' non-solid', a.nonSolid, b.nonSolid);
    eq(tag + ' seat record', a.seat, b.seat);
    eq(tag + ' skin record', a.skin, b.skin);
    eq(tag + ' paint, excluded list', a.paint && a.paint.exclude, b.paint && b.paint.exclude);
    eq(tag + ' paint, selected list', a.paint && a.paint.select, b.paint && b.paint.select);
    check(tag + ' centerOffset', nearAll(a.centerOffset, b.centerOffset, 1e-3),
      JSON.stringify(a.centerOffset) + ' vs ' + JSON.stringify(b.centerOffset));

    // and the mesh itself, in the frame the raw-space state is expressed in
    if (a.rawCount !== b.rawCount) {
      check(tag + ' rawTris count', false, a.rawCount / 9 + ' triangles vs ' + b.rawCount / 9);
    } else {
      let worst = 0;
      for (let k = 0; k < b.raw.length; k++) worst = Math.max(worst, Math.abs(a.raw[k] - b.raw[k]));
      check(tag + ' rawTris come back in the same frame, ' + (b.rawCount / 9) + ' triangles',
        worst <= TOL, 'max ' + worst.toExponential(2) + ' mm');
    }
  });

  // -----------------------------------------------------------------------
  section('re-opening onto a plate that already has pieces');
  // -----------------------------------------------------------------------
  // The destructive path: the plate is not empty, so the import asks first.
  // This run accepts (page.on('dialog') above), and the answer has to be a
  // replaced plate, not a doubled one. Declining takes the geometry-only
  // fallback - tools/nso_export_roundtrip_test.js drives that side.
  await page.evaluate(() => { window.nsoPlateLockSet(false); });
  await page.evaluate(([b, n]) => { handleFiles([new File([new Uint8Array(b)], n)]); },
                      [bytes, path.basename(file)]);
  await page.waitForTimeout(400);
  const again = await page.evaluate(plateSnapshot);
  eq('the plate was replaced, not doubled', again.pieces, 3);
  eq('and the plate lock came back with it', again.plateLock, true);

  // -----------------------------------------------------------------------
  section('a file with no scene block - straight from Bambu Studio');
  // -----------------------------------------------------------------------
  await page.evaluate(() => { window.nsoPlateLockSet(false); });
  await page.click('#btn-clear');
  const foreign = path.join(ROOT, 'fixtures', '3mf', 'pa_pattern.3mf');
  const fbytes = Array.from(fs.readFileSync(foreign));
  await page.evaluate(([b, n]) => { handleFiles([new File([new Uint8Array(b)], n)]); },
                      [fbytes, 'pa_pattern.3mf']);
  await page.waitForFunction(() => state.models.length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(150);
  const plain = await page.evaluate(() => ({
    models: state.models.length,
    placed: state.placed.length,
    status: document.getElementById('status').textContent,
    locked: !!(window.nsoPlateLocked && window.nsoPlateLocked()),
    anyState: state.models.some(m => m.skin || m.posLock || m.nonSolid ||
      (m.faceMask && (m.faceMask.exclude.length || m.faceMask.select.length))),
    seats: state.placed.filter(p => p.seat).length
  }));
  check('it imports as ordinary geometry', plain.models === 1 && plain.placed === 1,
        JSON.stringify({ models: plain.models, placed: plain.placed }));
  check('nothing claims to have been restored', !/Restored/.test(plain.status), plain.status);
  check('no state was invented for it', !plain.anyState && plain.seats === 0 && !plain.locked,
        JSON.stringify({ anyState: plain.anyState, seats: plain.seats, plateLock: plain.locked }));

  // one more: the app's own file, but with the block gone - the same route
  const NSO3MF = require(path.join(ROOT, 'nso-3mf.js'));
  const bare = await NSO3MF.build3MF({
    objects: [{ name: 'plain', vertices: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 10],
                triangles: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2] }],
    profileId: 'default', plateName: 'Bambu A1 Mini'
  });
  await page.click('#btn-clear');
  await page.evaluate(([b, n]) => { handleFiles([new File([new Uint8Array(b)], n)]); },
                      [Array.from(bare.bytes), 'no-scene.3mf']);
  await page.waitForFunction(() => state.models.length > 0, null, { timeout: 30000 });
  const bareIn = await page.evaluate(() => ({
    models: state.models.length,
    status: document.getElementById('status').textContent
  }));
  check('an NSO 3MF written without a scene imports as geometry too',
        bareIn.models === 1 && !/Restored/.test(bareIn.status), bareIn.status);

  // -----------------------------------------------------------------------
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors anywhere in the run', errs.length === 0, errs.join(' | '));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + (fails ? fails + ' FAILED' : 'scene round trip: every value came back'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('scene round trip crashed:', e); process.exit(1); });
