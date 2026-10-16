#!/usr/bin/env node
/* Lift reads features off ANY planar face - the face under the cursor - driven
   through the REAL app in headless Chromium at 1280 x 800.

     node tools/nso_lift_any_face_drive_check.js                      exit 0 = every gate held
     node tools/nso_lift_any_face_drive_check.js tools/lift-any-face-out   ...and keep the screenshots
                                                                      (npm run lift:any-face-shots;
                                                                      gitignored, never committed)

   Two pieces, both through the app's own Import:
     fixtures/features/feature-hull_hinge.stl  a 120 x 70 x 40 box with a
        print-in-place knuckle hinge on its +Y wall. Looking down at the top
        there is nothing to lift; looking at the +Y wall there is one thing,
        the knuckle, and the moving leaf, free of the wall, comes with it as a
        captured part (lift:assembly; before it was found and said "can't be
        lifted").
     the Barocke plate (tools/nso_lift_plate_fixtures.js)  the top face is
        what lift:plate reads and must still be.
   Every hover and click is a real pointer event on the main canvas at the
   screen point of a triangle the app drew, checked unoccluded first; every
   button is a real click in the Subtract card.

     1. armed on the hinge hull: the top face reads 0
     2. hover the +Y wall: the card reads THAT face - "1 feature found" - and
        the face is tinted; first read, then cached
     3. hover the knuckle: it is outlined, a feature of the wall
     4. a click lifts the knuckle: closed pieces, volumes add up, ONE undo
        step; Ctrl+Z puts it back bit for bit and the wall's count is the cache
     5. the lifted knuckle, grabbed and dropped, stays where it was dropped
     6. Strip strips the wall: "line x1 + 1 captured part", ONE undo step; on the top it is off
     7. the cursor off the piece goes back to the top; off the viewport onto
        the card, the face stays
     8. a wall with nothing on it: "Nothing stands out from this face." - one
        line - on the card, not repeated by the HUD
     9. the Barocke plate: the top face reads what lift:plate reads
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_plate_fixtures.js');
const L = require('./nso_lift_plate_drive_lib.js');
const { rawTriNear, status, readout, card, raw, plateState, pieceInfo, overlaps, added, sameSoup, hoverTri, clickTri,
        ctrlZ, waitRead, armOn, disarm, frameOn, dropPieces } = L;
const C = L.makeCheck(), check = C.check;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-any-face-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const HULL_STL = path.join(ROOT, 'fixtures', 'features', 'feature-hull_hinge.stl');
const BAR = FX.barocke();
const BAR_STL = path.join(TMP, 'barocke-plate.stl');
writeSTL(BAR_STL, BAR.soup);
const dots = BAR.truth.filter(t => t.kind === 'dot');
const T_DOT0 = rawTriNear(BAR.soup, dots[0].center[0], dots[0].center[1], 3.5, 3.7);
const T_PAPER = rawTriNear(BAR.soup, 60, 20, 2.99, 3.01);

const shots = L.shooter(OUT, KEEP, ROOT), shot = shots.plate;
const NOTHING = 'Nothing stands out from this face.';
const WALL_VIEW = [0, 0.62, -0.72];     // the +Y wall from behind and above, the hinge in front of it

/* ---- helpers local to this check ------------------------------------ */

/* The triangles of `S` that look along unit `nrm` and lie on the plane
   coordinate `axis` = `val`, the ones nearest (a, b) in the other two axes first. */
function wallTris(S, nrm, axis, val, a, b) {
  const other = [0, 1, 2].filter(k => k !== axis), out = [];
  for (let t = 0; t < S.length / 9; t++) {
    const o = t * 9;
    const ux = S[o + 3] - S[o], uy = S[o + 4] - S[o + 1], uz = S[o + 5] - S[o + 2];
    const vx = S[o + 6] - S[o], vy = S[o + 7] - S[o + 1], vz = S[o + 8] - S[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, Ln = Math.hypot(cx, cy, cz);
    if (!(Ln > 1e-9) || (cx * nrm[0] + cy * nrm[1] + cz * nrm[2]) / Ln < 0.999) continue;
    const c = [0, 1, 2].map(k => (S[o + k] + S[o + 3 + k] + S[o + 6 + k]) / 3);
    if (Math.abs(c[axis] - val) > 0.02) continue;
    out.push({ t, d: Math.hypot(c[other[0]] - a, c[other[1]] - b) });
  }
  return out.sort((p, q) => p.d - q.d).map(x => x.t);
}

/* Look at a piece from `dir` (display axes, in spans), the whole of it in view. */
async function frameDir(page, id, dir) {
  await page.evaluate(([id, dir]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, bb.max.y - bb.min.y);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + span * dir[0], c.y + span * dir[1], c.z + span * dir[2]);
    state.controls.update();
  }, [id, dir]);
  await page.waitForTimeout(250);
}

/* The first of `tris` (in order, or most-facing-the-camera first) that the
   app's own raycast hits as itself, on the canvas and not under a menu:
   { t, x, y } or null. */
const visibleTri = (page, id, tris, byFacing) => page.evaluate(([id, tris, byFacing]) => {
  const p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array;
  p.mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
  const rect = state.renderer.domElement.getBoundingClientRect(), cam = state.camera.position, rc = new THREE.Raycaster();
  const sc = tris.map(t => {
    const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]).applyMatrix4(p.mesh.matrixWorld));
    const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const nrm = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    return { t, cen, f: nrm.dot(cam.clone().sub(cen).normalize()) };
  }).filter(s => s.f > 0.3);
  if (byFacing) sc.sort((x, y) => y.f - x.f);
  for (const s of sc.slice(0, 600)) {
    const q = s.cen.clone().project(state.camera);
    if (Math.abs(q.x) > 0.9 || Math.abs(q.y) > 0.9) continue;
    const x = rect.left + (q.x + 1) / 2 * rect.width, y = rect.top + (1 - q.y) / 2 * rect.height;
    if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
    rc.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
    const hit = rc.intersectObjects(state.modelGroup.children, true).find(h => h.faceIndex != null);
    if (hit && hit.faceIndex === s.t && hit.object === p.mesh) return { t: s.t, x, y };
  }
  return null;
}, [id, tris, !!byFacing]);

/* A canvas point with no piece under it. */
const emptyPoint = page => page.evaluate(() => {
  const rect = state.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster();
  for (const [u, v] of [[0.55, 0.06], [0.5, 0.94], [0.7, 0.9], [0.4, 0.08], [0.9, 0.5], [0.6, 0.97]]) {
    const x = rect.left + u * rect.width, y = rect.top + v * rect.height;
    if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
    rc.setFromCamera(new THREE.Vector2(u * 2 - 1, 1 - v * 2), state.camera);
    if (!rc.intersectObjects(state.modelGroup.children, true).some(h => h.faceIndex != null)) return { x, y };
  }
  return null;
});

async function moveTo(page, x, y) {
  await page.mouse.move(x - 4, y - 4);
  await page.mouse.move(x, y);
  await page.waitForTimeout(180);
}
const faceNow = page => page.evaluate(() => { const f = NSO_LIFT_PLATE.face(); return f ? { key: f.key, n: f.n.map(v => +v.toFixed(3)), area: +f.area.toFixed(0) } : null; });
const detNow = page => page.evaluate(() => NSO_LIFT_PLATE.detection());
const near = (a, b, e) => Math.abs(a - b) <= (e || 1e-6);
const kids = page => page.evaluate(() => NSO_LIFT_PLATE.layer().children.map(c => c.type + ':' + c.material.color.getHexString()));
const strictClosed = pi => !!pi && pi.closed && pi.degen === 0;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  /* ================================================ 1. the top face reads 0 */
  console.log('\n=== 1. armed on the hinge hull: the top face ===');
  const hullId = await loadSTL(page, HULL_STL);
  const SRC = await raw(page, hullId);
  check('the hinge hull came in through Import', SRC.length / 9 === 720, SRC.length / 9 + ' triangles');
  const c1 = await armOn(page, hullId);
  const det1 = await detNow(page);
  check('the top face (the default) reads 0 features', c1 === '0 features found' && det1.ok && (await faceNow(page)) === null, c1);
  check('...in the words it always had: 0 found, the one thing found is the hull\'s own edge', /^0 features found on feature-hull_hinge standing out more than 0\.42 mm\. 1 can't be lifted/.test(await readout(page)), await readout(page));
  const u1 = (await plateState(page)).undo;

  /* ======================================== 2. hovering the wall reads the wall */
  console.log('\n=== 2. hover the +Y wall: that face is read ===');
  await frameDir(page, hullId, WALL_VIEW);
  const wall = wallTris(SRC, [0, 1, 0], 1, 35, -45, 20);
  check('the +Y wall has triangles to hover', wall.length > 10, wall.length + ' on the wall');
  const wv = await visibleTri(page, hullId, wall.slice(0, 200), false);
  check('a wall triangle clear of the hinge is in view', !!wv, JSON.stringify(wv));
  await moveTo(page, wv.x, wv.y);
  const f2 = await faceNow(page), c2 = await card(page), d2 = await detNow(page), r2 = await readout(page);
  check('the base face is now the +Y wall: normal (0, 1, 0), the 4544 mm² of it', !!f2 && f2.n.join() === '0,1,0' && f2.area === 4544, JSON.stringify(f2));
  check('the card follows: "1 feature found", and what comes with it (the leaf the knuckle holds)', c2.count === '1 feature found \u2014 a line with 1 captured part' && c2.panel, c2.count);
  check('...the first read of that face, not the cache', d2.ok && d2.cached === false, d2.ms + ' ms');
  check('...the read-out says it in words: one line, the knuckle a line with its captured leaf, nothing refused',
    /^1 feature found on feature-hull_hinge standing out more than 0\.42 mm: line ×1 \+ 1 captured part\./.test(r2) && !/can't be lifted/.test(r2) && !/\n/.test(r2), r2);
  const k2 = await kids(page);
  check('the wall is tinted and the knuckle outlined', k2.includes('Mesh:a78bfa') && k2.includes('LineSegments:38bdf8'), k2.join(' '));
  check('the HUD is not made to repeat the card', (await status(page)) !== r2);
  const u2 = (await plateState(page)).undo;
  check('reading a face changes nothing: no undo step, no new piece', u2 === u1 && (await plateState(page)).models.length === 1);
  await shot(page, '1-side-wall-knuckle-outlined');
  await moveTo(page, (await emptyPoint(page)).x, (await emptyPoint(page)).y);
  check('the cursor off the piece (over the viewport): back to the top, 0 features', (await faceNow(page)) === null && (await card(page)).count === '0 features found');
  await moveTo(page, wv.x, wv.y);
  const d2b = await detNow(page);
  check('the wall again: its count straight from the cache', (await card(page)).count === '1 feature found \u2014 a line with 1 captured part' && d2b.cached === true);

  /* ============================================ 3. the knuckle is a feature */
  console.log('\n=== 3. hover the knuckle ===');
  const isl = await page.evaluate(() => { const A = NSO_LIFT_PLATE.analysis(); return { off: NSO_LIFT_PLATE.offered(), tris: A.islands.map(I => ({ s: I.status, g: I.group, tris: I.tris })) }; });
  check('one offered feature: the knuckle (a line, ok); the free leaf is no island of its own, it is held by the knuckle', isl.off.length === 1 && isl.tris[isl.off[0]].s === 'ok' && isl.tris.length === 1,
    JSON.stringify(isl.tris.map(I => I.s + ':' + I.g + ':' + I.tris.length)));
  const KN = isl.off[0];
  const kv = await visibleTri(page, hullId, isl.tris[KN].tris, true);
  check('a knuckle triangle is in view', !!kv, JSON.stringify(kv));
  await moveTo(page, kv.x, kv.y);
  const h3 = await page.evaluate(() => ({ hover: NSO_LIFT_PLATE.hover(), kids: NSO_LIFT_PLATE.layer().children.map(c => c.type + ':' + c.material.color.getHexString()) }));
  check('the knuckle is outlined (yellow), the face under it still the wall', h3.hover === KN && h3.kids.includes('LineSegments:facc15') && (await faceNow(page)).n.join() === '0,1,0', JSON.stringify(h3));
  check('...the read-out names it', /^A line, 10\.50 mm high/.test(await readout(page)), await readout(page));
  await shot(page, '2-knuckle-hovered');

  /* ====================================================== 4. a click lifts it */
  console.log('\n=== 4. a click lifts the knuckle ===');
  const v0 = await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), SRC);
  const b4 = await plateState(page);
  await clickTri(page, hullId, kv.t);
  await waitRead(page, /Lifted|refused|failed/);
  const r4 = await readout(page), a4 = await plateState(page), add4 = added(b4, a4);
  check('the click lifted the knuckle, said in words', /^Lifted 1 feature off feature-hull_hinge/.test(r4), r4.slice(0, 150));
  check('exactly ONE undo step and one new piece', a4.undo === b4.undo + 1 && add4.length === 1, b4.undo + ' -> ' + a4.undo + ', ' + add4.length + ' piece');
  const host4 = await pieceInfo(page, hullId), pc4 = add4.length ? await pieceInfo(page, add4[0].id) : null;
  check('the hull is repaired and closed; the knuckle is a closed piece on free plate beside it',
    strictClosed(host4) && strictClosed(pc4) && pc4.onBed && !overlaps(pc4.fp, host4.fp), JSON.stringify(pc4 && pc4.fp));
  check('hull + knuckle = the original volume', Math.abs(host4.volume + pc4.volume - v0) < 1e-6 * v0, host4.volume.toFixed(3) + ' + ' + pc4.volume.toFixed(3) + ' = ' + v0.toFixed(3));
  check('the card counts the wall afresh: 0 left', (await card(page)).count === '0 features found', (await card(page)).count);
  await ctrlZ(page);
  const U4 = await raw(page, hullId), s4 = await plateState(page);
  check('one Ctrl+Z: the hull bit for bit, the knuckle gone, the stack as before', sameSoup(U4, SRC) && s4.models.length === b4.models.length && s4.undo === b4.undo);
  check('...and the wall counts 1 again, still the wall, from the cache', (await card(page)).count === '1 feature found \u2014 a line with 1 captured part' && (await faceNow(page)).n.join() === '0,1,0' && (await detNow(page)).cached === true, (await card(page)).count);

  /* ================================== 5. the lifted knuckle: grab and drop */
  console.log('\n=== 5. grab the lifted knuckle and drop it ===');
  await moveTo(page, kv.x, kv.y);
  await clickTri(page, hullId, kv.t);
  await waitRead(page, /Lifted|refused|failed/);
  const s5 = await plateState(page), b5 = added(b4, s5);
  check('lifted again', b5.length === 1 && s5.undo === b4.undo + 1);
  const KID = b5[0].id;
  await disarm(page);
  const hull5 = await pieceInfo(page, hullId), kn5 = await pieceInfo(page, KID);
  await frameOn(page, KID, 1.4);
  /* Drag it to a spot well clear of the hull: no overlap, and out of the
     12 mm the app's neighbour magnet reaches (a drop inside it is pulled flush,
     which is the magnet, not the drop), on the bed. */
  const plateWD = await page.evaluate(() => { const q = getCurrentPlate(); return { w: q.w, d: q.d }; });
  const clear = (fp, o) => {
    const ox = Math.min(fp.maxx, o.maxx) - Math.max(fp.minx, o.minx), oz = Math.min(fp.maxz, o.maxz) - Math.max(fp.minz, o.minz);
    const gx = Math.max(o.minx - fp.maxx, fp.minx - o.maxx), gz = Math.max(o.minz - fp.maxz, fp.minz - o.maxz);
    if (ox > 0.01 && oz > 0.01) return false;
    if (oz > 1 && gx >= 0 && gx < 13) return false;
    if (ox > 1 && gz >= 0 && gz < 13) return false;
    return true;
  };
  const offs = [];
  for (let dx = -60; dx <= 60; dx += 5) for (let dz = -60; dz <= 60; dz += 5) if (Math.hypot(dx, dz) >= 20) offs.push([dx, dz]);
  offs.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  const cand = offs.find(([dx, dz]) => {
    const fp = { minx: kn5.fp.minx + dx, maxx: kn5.fp.maxx + dx, minz: kn5.fp.minz + dz, maxz: kn5.fp.maxz + dz };
    return fp.minx >= -plateWD.w / 2 + 1 && fp.maxx <= plateWD.w / 2 - 1 && fp.minz >= -plateWD.d / 2 + 1 && fp.maxz <= plateWD.d / 2 - 1 && clear(fp, hull5.fp);
  });
  check('there is free plate to drop it on', !!cand, JSON.stringify(cand));
  const grab = await visibleTri(page, KID, Array.from({ length: await page.evaluate(id => state.models.find(m => m.id === id).rawTris.length / 9, KID) }, (_, i) => i), true);
  check('a triangle of the lifted knuckle is in view to grab', !!grab, JSON.stringify(grab));
  const scr = await page.evaluate(([id, dx, dz, gx, gy]) => {
    /* A drag over the plate lands the piece where the pointer meets the bed,
       held by the point it was grabbed at on the plane of its own bottom
       (#190: a piece in the air - a lifted one lands in place - is held by
       the point under it, liftY up; on the bed that is the bed). So the
       release is the bed point (dx, dz) from the grab point on that plane. */
    const p = state.placed.find(q => q.sourceId === id), rect = state.renderer.domElement.getBoundingClientRect();
    const toScreen = v => { const q = v.clone().project(state.camera); return { x: rect.left + (q.x + 1) / 2 * rect.width, y: rect.top + (1 - q.y) / 2 * rect.height }; };
    const rc = new THREE.Raycaster(), ndc = new THREE.Vector2(((gx - rect.left) / rect.width) * 2 - 1, -((gy - rect.top) / rect.height) * 2 + 1);
    rc.setFromCamera(ndc, state.camera);
    const hit = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(p.liftY || 0)), new THREE.Vector3());
    const b = toScreen(new THREE.Vector3(hit.x + dx, 0, hit.z + dz));
    return { dx: b.x - gx, dy: b.y - gy, x0: p.x, z0: p.z, liftY: p.liftY || 0 };
  }, [KID, cand[0], cand[1], grab.x, grab.y]);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + scr.dx / 2, grab.y + scr.dy / 2, { steps: 6 });
  await page.mouse.move(grab.x + scr.dx, grab.y + scr.dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const dropped = await pieceInfo(page, KID);
  check('dragged: it moved the way asked, to within a millimetre', near(dropped.x - scr.x0, cand[0], 1) && near(dropped.z - scr.z0, cand[1], 1), (dropped.x - scr.x0).toFixed(2) + ', ' + (dropped.z - scr.z0).toFixed(2) + ' for ' + cand.join(', '));
  await page.waitForTimeout(500);
  const later = await pieceInfo(page, KID), rawKn = await raw(page, KID);
  check('dropped: it stays where it was dropped (x, z, height as at the drop)', later.x === dropped.x && later.z === dropped.z && later.yMin === dropped.yMin, later.x.toFixed(2) + ', ' + later.z.toFixed(2));
  check('...still a closed piece on the bed, not on the hull; one more undo step for the move', strictClosed(later) && later.onBed && !overlaps(later.fp, (await pieceInfo(page, hullId)).fp) && (await plateState(page)).undo === s5.undo + 1);
  await ctrlZ(page); await ctrlZ(page);
  const s5b = await plateState(page);
  check('two Ctrl+Z (the move, the lift): the hull as it was, the knuckle gone', sameSoup(await raw(page, hullId), SRC) && s5b.models.length === b4.models.length && s5b.undo === b4.undo);

  /* ============================================================== 6. Strip */
  console.log('\n=== 6. Strip strips the face that is read ===');
  await armOn(page, hullId);
  await frameDir(page, hullId, WALL_VIEW);
  check('on the top face Strip has nothing: it is off', (await card(page)).stripDisabled && (await card(page)).count === '0 features found');
  await moveTo(page, wv.x, wv.y);
  check('on the wall Strip is on', !(await card(page)).stripDisabled && (await card(page)).count === '1 feature found \u2014 a line with 1 captured part');
  await page.click('#btn-lift-strip');
  const c6 = await card(page);
  check('Strip lists the wall\'s: line ×1 with its captured part, and what the plate keeps', c6.strip && c6.rows.length === 1 && c6.sum === 'line ×1 + 1 captured part · bare plate' && c6.go === 'Confirm – lift 1', c6.sum + ' / ' + c6.go);
  const b6 = await plateState(page);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const a6 = await plateState(page), add6 = added(b6, a6), host6 = await pieceInfo(page, hullId);
  check('Confirm lifts the knuckle: one piece, ONE undo step, the hull closed', add6.length === 1 && a6.undo === b6.undo + 1 && strictClosed(host6), add6.map(m => m.name).join());
  await ctrlZ(page);
  check('one Ctrl+Z: the hull bit for bit', sameSoup(await raw(page, hullId), SRC) && (await plateState(page)).models.length === b6.models.length);

  /* ====================================== 7. off the piece / off the viewport */
  console.log('\n=== 7. off the piece: the top; onto the card: the face stays ===');
  await moveTo(page, wv.x, wv.y);
  check('on the wall', (await faceNow(page)) !== null && (await card(page)).count === '1 feature found \u2014 a line with 1 captured part');
  await page.hover('#btn-lift-strip');
  await page.waitForTimeout(200);
  check('the cursor onto the card (a button): the face stays, so Strip strips what was shown', (await faceNow(page)) !== null && (await card(page)).count === '1 feature found \u2014 a line with 1 captured part' && !(await card(page)).stripDisabled);
  const e7 = await emptyPoint(page);
  await moveTo(page, e7.x, e7.y);
  check('the cursor over the empty viewport: back to the top', (await faceNow(page)) === null && (await card(page)).count === '0 features found');

  /* ============================================ 8. a wall with nothing on it */
  console.log('\n=== 8. nothing stands out of this face ===');
  await frameDir(page, hullId, [0.95, 0.85, 0]);
  const end = wallTris(SRC, [1, 0, 0], 0, 60, 0, 20);
  const ev = await visibleTri(page, hullId, end.slice(0, 200), false);
  check('a triangle of the +X end wall is in view', !!ev, JSON.stringify(ev));
  await page.evaluate(() => setStatus('(HUD before)'));
  await moveTo(page, ev.x, ev.y);
  const f8 = await faceNow(page), r8 = await readout(page), s8 = await status(page);
  check('the +X end wall is the face read: normal (1, 0, 0)', !!f8 && f8.n.join() === '1,0,0', JSON.stringify(f8));
  check('the card: "Nothing stands out from this face." - that and nothing more', r8 === NOTHING && (await card(page)).count === '0 features found', JSON.stringify(r8));
  check('the HUD does not repeat it', !s8.includes('Nothing stands out'), JSON.stringify(s8));
  check('Strip is off on a face with nothing', (await card(page)).stripDisabled);
  await shot(page, '3-nothing-stands-out');
  await disarm(page);

  /* ===================================================== 9. the Barocke plate */
  console.log('\n=== 9. the Barocke plate: the top face as lift:plate reads it ===');
  await dropPieces(page, [hullId]);
  const barId = await loadSTL(page, BAR_STL);
  const c9 = await armOn(page, barId);
  const det9 = await detNow(page);
  check('armed: "22 features found", the top face, as lift:plate', c9 === '22 features found' && det9.ok && (await faceNow(page)) === null, c9);
  check('...the breakdown is lift:plate\'s', await page.evaluate(() => NSO_LIFT_PLATE.breakdown(NSO_LIFT_PLATE.analysis(), NSO_LIFT_PLATE.minHeight())) === 'line ×1 · large shape ×1 (12 parts) · dots ×20 · bare plate');
  await frameOn(page, barId);
  await hoverTri(page, barId, T_PAPER);
  check('hovering the bare paper: still the top, 22', (await faceNow(page)) === null && (await card(page)).count === '22 features found');
  await hoverTri(page, barId, T_DOT0);
  const h9 = await page.evaluate(() => ({ hover: NSO_LIFT_PLATE.hover(), a: NSO_LIFT_PLATE.analysis().islandOf }));
  check('hovering a dot: still the top, the dot outlined, 22', (await faceNow(page)) === null && h9.hover >= 0 && (await card(page)).count === '22 features found');
  await disarm(page);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
