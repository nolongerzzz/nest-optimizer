#!/usr/bin/env node
/* Lift keeps an assembly together - driven through the REAL app in headless
   Chromium at 1280 x 800.

     node tools/nso_lift_assembly_drive_check.js                      exit 0 = every gate held
     node tools/nso_lift_assembly_drive_check.js tools/lift-assembly-out   ...and keep the screenshots
                                                                      (npm run lift:assembly-shots;
                                                                      gitignored, never committed)

   THE RULE (docs/LIFT.md section 8). A lifted feature brings every shell of the
   piece that is not connected to the base body and is captured by it: the shell
   lies within the feature's box inflated by 2 mm, or its box overlaps the
   feature's. They come as separate shells of ONE piece, with their original
   gaps - never fused. The parent is repaired only where the feature stood.

   Three pieces, all through the app's own Import (shells counted here by a union-find
   of exact corners, which shares no code with the engine):
     fixtures/features/feature-hull_hinge.stl  a print-in-place knuckle hinge on
        the +Y wall. TWO shells: the hull with its fixed knuckles and pin, and the
        moving knuckle + leaf. (The ticket expected two captured parts and three
        shells; this file has one and two - see docs/LIFT.md section 8.)
     tools/nso_lift_assembly_fixtures.js posts()  a plate with post A (two collars on
        it: 2 captured parts -> 3 shells), post B (one collar -> 2 shells) and a
        stray cube that nothing holds
     ...stray()  the same plate with the stray cube alone

     1. the hinge's +Y wall: the card says what it found; the leaf is no longer a
        "can't be lifted"; hovering the leaf is hovering the feature; the HUD
        clears when the card's reading changes
     2. a click lifts the knuckle with the leaf: one piece, two shells, gaps as they
        were, the parent closed and manifold and one shell; one Undo, bit for bit
     3. the lifted piece exported (a 3MF, the real download): one object, two shells
     4. Strip does the same; the top of the hull still refuses the leaf
     5. the posts: 2 features, 3 captured parts; the stray is still "can't be lifted"
     6. Pick on post A: one piece with THREE shells; one Undo
     7. Shift-click both posts: two pieces (3 shells, 2 shells), one step, one Undo
     8. Strip lifts both; the export of post A's piece is one object of 3 shells
     9. a plate with a lone floating shell: nothing found, still refused, nothing changes
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const AF = require('./nso_lift_assembly_fixtures.js');
const L = require('./nso_lift_plate_drive_lib.js');
const { rawTriNear, status, readout, card, raw, plateState, pieceInfo, overlaps, added, sameSoup, hoverTri, clickTri,
        ctrlZ, waitRead, armOn, disarm, frameOn, dropPieces, selectRow } = L;
const C = L.makeCheck(), check = C.check;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-assembly-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const shots = L.shooter(OUT, KEEP, ROOT), shot = shots.plate;

/* The fixtures: the cut engine's cap triangulates the plate's top round the posts. */
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array, Int32Array, Uint8Array, Error, Infinity, NaN, isFinite };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const POSTS = AF.posts(ctx.rawFlatCapLoops), STRAY = AF.stray(ctx.rawFlatCapLoops);
const HULL_STL = path.join(ROOT, 'fixtures', 'features', 'feature-hull_hinge.stl');
const POSTS_STL = path.join(TMP, 'posts.stl'), STRAY_STL = path.join(TMP, 'stray.stl');
writeSTL(POSTS_STL, POSTS.soup);
writeSTL(STRAY_STL, STRAY.soup);

const WALL_VIEW = [0, 0.62, -0.72];     // the +Y wall from behind and above, the hinge in front of it
const NOTHING = 'Nothing stands out from this face.';

/* ---- shells, counted here and not by the engine ---------------------- */

/* The shells of a soup: triangles that share a corner (exact coordinates). */
function shellsOfSoup(S) {
  const nt = S.length / 9, ids = new Map(), parent = [];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const tv = new Int32Array(nt * 3);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const o = t * 9 + k * 3, key = S[o] + ',' + S[o + 1] + ',' + S[o + 2];
    let id = ids.get(key);
    if (id === undefined) { id = parent.length; parent.push(id); ids.set(key, id); }
    tv[t * 3 + k] = id;
  }
  for (let t = 0; t < nt; t++) { const a = find(tv[t * 3]); for (let k = 1; k < 3; k++) { const b = find(tv[t * 3 + k]); if (a !== b) parent[b] = a; } }
  const by = new Map();
  for (let t = 0; t < nt; t++) { const r = find(tv[t * 3]); if (!by.has(r)) by.set(r, []); by.get(r).push(t); }
  return Array.from(by.values()).map(tris => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], verts = new Map();
    tris.forEach(t => { for (let k = 0; k < 3; k++) { const o = t * 9 + k * 3, p = [S[o], S[o + 1], S[o + 2]]; verts.set(p.join(), p); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); } } });
    return { tris, lo, hi, verts: Array.from(verts.values()) };
  });
}
/* The triangles of a shell as exact strings, sorted: two shells that are the
   same triangles, bit for bit, have the same list. */
const triKeys = (S, sh) => sh.tris.map(t => Array.from(S.slice(t * 9, t * 9 + 9)).join()).sort();
const sameKeys = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
/* The least distance between the corners of two shells. */
function gap(A, B) {
  let d = Infinity;
  for (const p of A.verts) for (const q of B.verts) { const e = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (e < d) d = e; }
  return d;
}
const bigBox = sh => (sh.hi[0] - sh.lo[0]) * (sh.hi[1] - sh.lo[1]) * (sh.hi[2] - sh.lo[2]);

/* ---- helpers shared with lift:any-face -------------------------------- */

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

/* Look straight down at several pieces at once, all of them in view. */
async function frameAll(page, ids, tilt) {
  await page.evaluate(([ids, tilt]) => {
    const bb = new THREE.Box3();
    ids.forEach(id => bb.union(new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh)));
    const c = bb.getCenter(new THREE.Vector3()), span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, bb.max.y - bb.min.y);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + span * 0.25, c.y + span * 1.05, c.z + span * (tilt == null ? 0.55 : tilt));
    state.controls.update();
  }, [ids, tilt]);
  await page.waitForTimeout(300);
}

/* The first of `tris` (in order, or most-facing-the-camera first) that the app's
   own raycast hits as itself, on the canvas and not under a menu. */
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

async function moveTo(page, x, y) {
  await page.mouse.move(x - 4, y - 4);
  await page.mouse.move(x, y);
  await page.waitForTimeout(180);
}
const faceNow = page => page.evaluate(() => { const f = NSO_LIFT_PLATE.face(); return f ? { n: f.n.map(v => +v.toFixed(3)), area: +f.area.toFixed(0) } : null; });
const isl = page => page.evaluate(() => {
  const A = NSO_LIFT_PLATE.analysis();
  return { off: NSO_LIFT_PLATE.offered(), shells: A.shells, caught: A.caught,
    list: A.islands.map(I => ({ id: I.id, s: I.status, g: I.group, parts: I.partCount || 0, cx: (I.bounds.lo[0] + I.bounds.hi[0]) / 2 })) };
});
/* The highest up-facing triangle among `tris` of soup `S`. */
function topTri(S, tris) {
  let best = tris[0], bz = -Infinity;
  tris.forEach(t => {
    const o = t * 9, nz = (S[o + 3] - S[o]) * (S[o + 7] - S[o + 1]) - (S[o + 4] - S[o + 1]) * (S[o + 6] - S[o]);
    const cz = (S[o + 2] + S[o + 5] + S[o + 8]) / 3;
    if (nz > 0 && cz > bz) { bz = cz; best = t; }
  });
  return best;
}
const tris = (page, id) => page.evaluate(id => NSO_LIFT_PLATE.analysis().islands[id].tris, id);
const strictClosed = pi => !!pi && pi.closed && pi.degen === 0;
const volOf = (page, S) => page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), Array.from(S));

/* A one-object 3MF of the selected piece, the real "Download selected 3MF":
   -> { objects, shells } read back from the file. */
async function export3mf(page, id) {
  await selectRow(page, id);
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', '3mf');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-model')]);
  const file = path.join(TMP, 'export-' + id + '.3mf');
  await dl.saveAs(file);
  await page.selectOption('#export-format', 'stl');
  const R = require(path.join(ROOT, 'nso-3mf-read.js'));
  const got = await R.parse3MF(new Uint8Array(fs.readFileSync(file)), { name: 'export.3mf' });
  const pos = got.objects[0].positions;
  return { objects: got.objects.length, tris: got.objects[0].triangleCount, shells: shellsOfSoup(Float32Array.from(pos)).length };
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on('dialog', d => d.accept().catch(() => {}));

  /* ==================================================================== 1. the hinge's wall */
  console.log('\n=== 1. the +Y wall: what the card says it found ===');
  const hullId = await loadSTL(page, HULL_STL);
  const SRC = await raw(page, hullId);
  const SHELLS = shellsOfSoup(SRC);
  SHELLS.sort((a, b) => bigBox(b) - bigBox(a));
  const [HULL_SH, LEAF_SH] = SHELLS;
  check('the hinge hull has TWO shells (this file: hull + fixed knuckles + pin, and the moving knuckle + leaf)', SHELLS.length === 2, SHELLS.map(s => s.tris.length + ' tris').join(' + '));
  await armOn(page, hullId);
  await frameDir(page, hullId, WALL_VIEW);
  const wall = wallTris(SRC, [0, 1, 0], 1, 35, -45, 20);
  const wv = await visibleTri(page, hullId, wall.slice(0, 200), false);
  check('a wall triangle clear of the hinge is in view', !!wv, JSON.stringify(wv));
  await page.evaluate(() => setStatus('(HUD before)'));
  await moveTo(page, wv.x, wv.y);
  const c1 = await card(page), r1 = await readout(page), i1 = await isl(page), f1 = await faceNow(page);
  check('the base face is the +Y wall', !!f1 && f1.n.join() === '0,1,0', JSON.stringify(f1));
  check('the card: "1 feature found - a line with 1 captured part" (count and plain words)', c1.count === '1 feature found — a line with 1 captured part', c1.count);
  check('the engine found exactly the shells the file has besides the hull: one', i1.shells === 2 && i1.caught === 1, 'shells ' + i1.shells + ', caught ' + i1.caught);
  check('the free leaf is NOT a "can\'t be lifted" any more: one feature, none refused', i1.list.length === 1 && i1.list[0].s === 'ok' && i1.list[0].parts === 1 && !/can't be lifted/.test(r1), JSON.stringify(i1.list));
  check('the read-out says it in words, no engine terms', /^1 feature found on feature-hull_hinge standing out more than 0\.42 mm: line ×1 \+ 1 captured part\./.test(r1) && !/shell|island|loops|census/i.test(r1), r1);
  check('the HUD was cleared when the card changed face (it kept "(HUD before)" before)', (await status(page)) === '', JSON.stringify(await status(page)));
  const KN = i1.off[0];
  const leafTri = await visibleTri(page, hullId, LEAF_SH.tris, true);
  check('a triangle of the leaf is in view', !!leafTri, JSON.stringify(leafTri));
  await moveTo(page, leafTri.x, leafTri.y);
  const h1 = await page.evaluate(() => NSO_LIFT_PLATE.hover());
  check('hovering the LEAF is hovering the feature: it is the knuckle\'s id, the wall still the face', h1 === KN && (await faceNow(page)).n.join() === '0,1,0', 'hover ' + h1);
  check('...the read-out names what comes with it', /^A line, 10\.50 mm high, [\d.]+ mm², with 1 captured part - click to lift it/.test(await readout(page)), await readout(page));
  await shot(page, '1-hinge-hovered-leaf');

  /* ---- the HUD clears when the card's reading changes ------------------ */
  await frameDir(page, hullId, [0.95, 0.85, 0]);
  const endW = wallTris(SRC, [1, 0, 0], 0, 60, 0, 20);
  const ev = await visibleTri(page, hullId, endW.slice(0, 200), false);
  await page.evaluate(() => setStatus('(HUD before)'));
  await moveTo(page, ev.x, ev.y);
  check('the +X end wall: the card says "Nothing stands out from this face."', (await readout(page)) === NOTHING && (await card(page)).count === '0 features found');
  check('...and the HUD is cleared, not the last face\'s text', (await status(page)) === '', JSON.stringify(await status(page)));
  await frameDir(page, hullId, WALL_VIEW);
  await page.evaluate(() => setStatus('(HUD again)'));
  await moveTo(page, wv.x, wv.y);
  check('back to the wall: the card reads it again and the HUD is cleared again', (await card(page)).count === '1 feature found — a line with 1 captured part' && (await status(page)) === '');

  /* ==================================================================== 2. a click lifts the assembly */
  console.log('\n=== 2. a click on the knuckle lifts it with its leaf ===');
  const KT = await page.evaluate(id => NSO_LIFT_PLATE.analysis().islands[id].tris, KN);
  const kv = await visibleTri(page, hullId, KT, true);
  check('a knuckle triangle is in view', !!kv, JSON.stringify(kv));
  const v0 = await volOf(page, SRC);
  const b2 = await plateState(page);
  await moveTo(page, kv.x, kv.y);
  await clickTri(page, hullId, kv.t);
  await waitRead(page, /Lifted|refused|failed/);
  const r2 = await readout(page), a2 = await plateState(page), add2 = added(b2, a2);
  check('said in words: lifted 1 feature, with its 1 captured part', /^Lifted 1 feature off feature-hull_hinge with 1 captured part/.test(r2), r2.slice(0, 140));
  check('ONE undo step and ONE new piece', a2.undo === b2.undo + 1 && add2.length === 1, b2.undo + ' -> ' + a2.undo + ', ' + add2.length + ' piece(s)');
  const PID = add2[0].id, host2 = await pieceInfo(page, hullId), pc2 = await pieceInfo(page, PID), PS = await raw(page, PID), HS = await raw(page, hullId);
  const PSH = shellsOfSoup(PS), HSH = shellsOfSoup(HS);
  check('the lifted piece is ONE piece of TWO shells, closed', PSH.length === 2 && strictClosed(pc2), PSH.length + ' shells, ' + pc2.tris + ' tris');
  const leafInPiece = PSH.find(s => sameKeys(triKeys(PS, s), triKeys(SRC, LEAF_SH)));
  check('...one shell is the leaf, every triangle exactly as it was (not fused, not moved)', !!leafInPiece);
  const knInPiece = PSH.find(s => s !== leafInPiece);
  const knSrcVerts = { verts: knInPiece.verts.filter(p => HULL_SH.verts.some(q => q[0] === p[0] && q[1] === p[1] && q[2] === p[2])) };
  const gPiece = gap(knInPiece, leafInPiece), gSrc = gap(knSrcVerts, LEAF_SH);
  check('the gap between the shells is the original\'s within 0.01 mm', Math.abs(gPiece - gSrc) < 0.01 && gPiece > 0.4, gSrc.toFixed(4) + ' -> ' + gPiece.toFixed(4) + ' mm');
  check('the parent is closed, manifold, ONE shell: only where the knuckle stood was touched',
    strictClosed(host2) && HSH.length === 1 && host2.chi === 2, host2.tris + ' tris, ' + HSH.length + ' shell(s), chi ' + host2.chi);
  check('the leaf is gone from the parent (it went with the knuckle)', !HSH.some(s => s.hi[1] > 50), 'parent top y ' + HSH[0].hi[1]);
  check('parent + piece = the original volume', Math.abs(host2.volume + pc2.volume - v0) < 1e-6 * v0, host2.volume.toFixed(3) + ' + ' + pc2.volume.toFixed(3) + ' = ' + v0.toFixed(3));
  check('the piece sits on free plate beside the parent', pc2.onBed && !overlaps(pc2.fp, host2.fp), JSON.stringify(pc2.fp));
  check('the card counts the wall afresh: 0 left', (await card(page)).count === '0 features found', (await card(page)).count);
  await frameAll(page, [hullId, PID], -0.9);
  await shot(page, '2-lifted-hinge-beside-its-hull');

  /* ---- the lifted piece exported ------------------------------------- */
  console.log('\n=== 3. export the lifted piece: one object, two shells ===');
  const ex1 = await export3mf(page, PID);
  check('the 3MF has ONE object with the piece\'s triangles', ex1.objects === 1 && ex1.tris === pc2.tris, JSON.stringify(ex1));
  check('...and that one object holds TWO shells', ex1.shells === 2, ex1.shells + ' shells');

  await ctrlZ(page);
  const U2 = await raw(page, hullId), s2 = await plateState(page);
  check('one Ctrl+Z: the parent bit for bit, the assembly gone, the undo stack as before', sameSoup(U2, SRC) && s2.models.length === b2.models.length && s2.undo === b2.undo);
  await armOn(page, hullId);
  await frameDir(page, hullId, WALL_VIEW);
  await moveTo(page, wv.x, wv.y);
  check('...and the wall counts 1 again, with its leaf', (await card(page)).count === '1 feature found — a line with 1 captured part' && (await faceNow(page)).n.join() === '0,1,0', (await card(page)).count);

  /* ==================================================================== 4. Strip, and the top face */
  console.log('\n=== 4. Strip honours it; the top face still refuses the leaf ===');
  await page.click('#btn-lift-strip');
  const c4 = await card(page);
  check('Strip lists the feature with what comes with it, and nothing kept back', c4.strip && c4.rows.length === 1 && c4.sum === 'line ×1 + 1 captured part · bare plate' && c4.go === 'Confirm – lift 1', c4.sum + ' / ' + c4.go);
  const b4 = await plateState(page);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const a4 = await plateState(page), add4 = added(b4, a4);
  const pc4 = add4.length === 1 ? await raw(page, add4[0].id) : null;
  check('Confirm: ONE piece of TWO shells, ONE undo step', add4.length === 1 && a4.undo === b4.undo + 1 && shellsOfSoup(pc4).length === 2);
  await ctrlZ(page);
  check('one Ctrl+Z: the parent bit for bit', sameSoup(await raw(page, hullId), SRC) && (await plateState(page)).models.length === b4.models.length);
  await disarm(page);
  const topCount = await armOn(page, hullId);
  const top = await isl(page);
  check('the TOP face: no feature there holds the leaf, so nothing is brought along and the read is as it was', topCount === '0 features found' && top.caught === 0 && top.list.every(i => i.s !== 'ok' && i.parts === 0) && /1 can't be lifted/.test(await readout(page)), topCount + ' / ' + (await readout(page)).slice(0, 120));
  await disarm(page);

  /* ==================================================================== 5. the posts */
  console.log('\n=== 5. the posts: two assemblies and a stray ===');
  await dropPieces(page, [hullId]);
  const postId = await loadSTL(page, POSTS_STL);
  const PSRC = await raw(page, postId), PSHELLS = shellsOfSoup(PSRC);
  check('the posts plate has FIVE shells: plate + posts, three collars, the stray cube', PSHELLS.length === 5, PSHELLS.length + '');
  const c5 = await armOn(page, postId);
  const p5 = await isl(page);
  check('armed: "2 features found - 2 with captured parts (3 in all)"', c5 === '2 features found — 2 with captured parts (3 in all)', c5);
  check('the engine: post A holds 2, post B holds 1; the stray (held by nothing) is the one "can\'t be lifted"',
    p5.list.length === 3 && p5.off.length === 2 && p5.list.filter(i => i.s !== 'ok').length === 1 &&
    p5.list.filter(i => i.s === 'ok').map(i => i.parts).sort().join() === '1,2', JSON.stringify(p5.list));
  check('the read-out: both lines, and the refusal in words', /^2 features found on posts standing out more than 0\.42 mm: large shapes? ×2 \+ 3 captured parts\. 1 can't be lifted - 1: it is a separate part, joined to nothing/.test(await readout(page)), await readout(page));
  const IDA = p5.list.find(i => i.s === 'ok' && i.cx < 0).id, IDB = p5.list.find(i => i.s === 'ok' && i.cx > 0).id, IDS = p5.list.find(i => i.s !== 'ok').id;
  await frameOn(page, postId);
  const TA = topTri(PSRC, await tris(page, IDA)), TB = topTri(PSRC, await tris(page, IDB));
  const TS = rawTriNear(PSRC, 0, 14, 11.9, 12.1);
  /* the stray: a click on it is refused in words and changes nothing */
  const b5 = await plateState(page);
  await hoverTri(page, postId, TS);
  check('hovering the stray: it is the one nothing holds - "can\'t be lifted", with the reason', (await page.evaluate(() => NSO_LIFT_PLATE.hover())) === IDS && /^Lift: that can't be lifted - it is a separate part, joined to nothing, and no feature on the face holds it/.test(await readout(page)), await readout(page));
  await clickTri(page, postId, TS);
  await page.waitForTimeout(250);
  const a5 = await plateState(page);
  check('a click on it lifts nothing: no step, no piece, the plate untouched', a5.undo === b5.undo && a5.models.length === b5.models.length && sameSoup(await raw(page, postId), PSRC));
  const refused = await page.evaluate(id => NSO_LIFT_PLATE.lift([id]), IDS);
  check('...and asking for it any other way is refused too', refused.ok === false && /can't be lifted|cannot be lifted|nothing/.test(refused.reason || ''), refused.reason);

  /* ==================================================================== 6. Pick on post A */
  console.log('\n=== 6. Pick on post A: one piece, three shells ===');
  const pv0 = await volOf(page, PSRC), pb6 = await plateState(page);
  await clickTri(page, postId, TA);
  await waitRead(page, /Lifted|refused|failed/);
  const r6 = await readout(page), pa6 = await plateState(page), add6 = added(pb6, pa6);
  check('lifted 1 feature, with its 2 captured parts, in words', /^Lifted 1 feature off posts with 2 captured parts/.test(r6), r6.slice(0, 130));
  check('ONE undo step, ONE new piece', pa6.undo === pb6.undo + 1 && add6.length === 1);
  const A6 = add6[0].id, A6S = await raw(page, A6), A6SH = shellsOfSoup(A6S), a6info = await pieceInfo(page, A6), h6 = await pieceInfo(page, postId), H6SH = shellsOfSoup(await raw(page, postId));
  check('the piece: ONE piece of THREE shells (the post and its two collars), closed', A6SH.length === 3 && strictClosed(a6info), A6SH.length + ' shells');
  const collarsSrc = PSHELLS.filter(s => s.lo[0] < -8 && s.hi[0] < -8 && s.hi[2] < 15 && s.lo[2] >= 6 && s.tris.length === 192);
  check('...both collars exactly as they were: every triangle, bit for bit', collarsSrc.length === 2 && collarsSrc.every(cs => A6SH.some(s => sameKeys(triKeys(A6S, s), triKeys(PSRC, cs)))), collarsSrc.length + ' collars in the source');
  const postShell = A6SH.find(s => !collarsSrc.some(cs => sameKeys(triKeys(A6S, s), triKeys(PSRC, cs))));
  /* the post's corners as the SOURCE has them: the plate's shell, inside the post's box */
  const srcPost = { verts: PSHELLS.find(s => s.lo[0] <= -35).verts.filter(p => p[0] >= -20 && p[0] <= -10 && p[1] >= -5 && p[1] <= 5 && p[2] >= 4) };
  const gOk = srcPost.verts.length > 20 && collarsSrc.every(cs => {
    const inPiece = A6SH.find(s => sameKeys(triKeys(A6S, s), triKeys(PSRC, cs)));
    return Math.abs(gap(postShell, inPiece) - gap(srcPost, cs)) < 0.01;
  });
  check('...the gaps between the shells are the original\'s within 0.01 mm', gOk);
  check('the parent: closed, manifold, and the post and its collars are gone - plate + post B + its collar + the stray remain',
    strictClosed(h6) && H6SH.length === 3, H6SH.length + ' shells, ' + h6.tris + ' tris');
  check('parent + piece = the original volume', Math.abs(h6.volume + a6info.volume - pv0) < 1e-6 * pv0, h6.volume.toFixed(3) + ' + ' + a6info.volume.toFixed(3) + ' = ' + pv0.toFixed(3));
  const ex6 = await export3mf(page, A6);
  check('exported: ONE object holding THREE shells', ex6.objects === 1 && ex6.shells === 3 && ex6.tris === a6info.tris, JSON.stringify(ex6));
  await ctrlZ(page);
  check('one Ctrl+Z: the plate bit for bit, the assembly gone', sameSoup(await raw(page, postId), PSRC) && (await plateState(page)).models.length === pb6.models.length && (await plateState(page)).undo === pb6.undo);
  await armOn(page, postId);

  /* ==================================================================== 7. Shift-click both */
  console.log('\n=== 7. Shift-click both posts: one step, two pieces ===');
  await frameOn(page, postId);
  const b7 = await plateState(page);
  await page.keyboard.down('Shift');
  await clickTri(page, postId, TA);
  await clickTri(page, postId, TB);
  const g7 = await page.evaluate(() => NSO_LIFT_PLATE.pending().length);
  check('Shift held: both gathered, nothing lifted yet', g7 === 2 && (await plateState(page)).undo === b7.undo, g7 + ' gathered');
  await page.keyboard.up('Shift');
  await waitRead(page, /Lifted|refused|failed/);
  const a7 = await plateState(page), add7 = added(b7, a7);
  check('letting go lifts both in ONE step, with their 3 captured parts', add7.length === 2 && a7.undo === b7.undo + 1 && /^Lifted 2 features off posts with 3 captured parts/.test(await readout(page)), add7.length + ' pieces: ' + (await readout(page)).slice(0, 90));
  const sh7 = [];
  for (const m of add7) sh7.push(shellsOfSoup(await raw(page, m.id)).length);
  check('...one piece of THREE shells, one of TWO, both closed', sh7.slice().sort().join() === '2,3' && (await Promise.all(add7.map(m => pieceInfo(page, m.id)))).every(strictClosed), sh7.join());
  const h7 = await pieceInfo(page, postId), H7SH = shellsOfSoup(await raw(page, postId));
  check('the parent is closed with only the plate and the stray left', strictClosed(h7) && H7SH.length === 2, H7SH.length + ' shells');
  const vs7 = h7.volume + (await Promise.all(add7.map(m => pieceInfo(page, m.id)))).reduce((s, p) => s + p.volume, 0);
  check('parent + pieces = the original volume', Math.abs(vs7 - pv0) < 1e-6 * pv0, vs7.toFixed(3) + ' vs ' + pv0.toFixed(3));
  await ctrlZ(page);
  check('one Ctrl+Z puts both assemblies back, bit for bit', sameSoup(await raw(page, postId), PSRC) && (await plateState(page)).models.length === b7.models.length && (await plateState(page)).undo === b7.undo);

  /* ==================================================================== 8. Strip */
  console.log('\n=== 8. Strip lifts both ===');
  await page.click('#btn-lift-strip');
  const c8 = await card(page);
  check('Strip: one row of the two, with what comes with them; the stray stays', c8.strip && c8.rows.length === 1 && /^large shapes? ×2 \+ 3 captured parts · the plate keeps 1$/.test(c8.sum) && c8.go === 'Confirm – lift 2', c8.sum + ' / ' + c8.go);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const a8 = await plateState(page), add8 = added(b7, a8);
  const sh8 = [];
  for (const m of add8) sh8.push(shellsOfSoup(await raw(page, m.id)).length);
  check('Confirm: two pieces (3 shells, 2 shells), ONE undo step', add8.length === 2 && sh8.slice().sort().join() === '2,3' && a8.undo === b7.undo + 1, sh8.join());
  await ctrlZ(page);
  check('one Ctrl+Z: bit for bit', sameSoup(await raw(page, postId), PSRC) && (await plateState(page)).models.length === b7.models.length);
  await disarm(page);

  /* ==================================================================== 9. a lone floating shell */
  console.log('\n=== 9. a plate with a lone floating shell ===');
  await dropPieces(page, [postId]);
  const strayId = await loadSTL(page, STRAY_STL);
  const SSRC = await raw(page, strayId);
  const c9 = await armOn(page, strayId);
  const p9 = await isl(page);
  check('armed: "0 features found" - nothing holds the cube, so there is nothing to bring along', c9 === '0 features found' && p9.caught === 0 && p9.list.length === 1 && p9.list[0].s !== 'ok', c9 + ' ' + JSON.stringify(p9.list));
  check('...and it says why in the read-out', /1 can't be lifted/.test(await readout(page)), await readout(page));
  await frameOn(page, strayId);
  const ST = rawTriNear(SSRC, 0, 14, 11.9, 12.1);
  const b9 = await plateState(page);
  await hoverTri(page, strayId, ST);
  check('hovering the cube: "can\'t be lifted", and why', /^Lift: that can't be lifted - it is a separate part, joined to nothing, and no feature on the face holds it/.test(await readout(page)), await readout(page));
  await clickTri(page, strayId, ST);
  await page.waitForTimeout(250);
  check('a click lifts nothing: no step, no piece, the plate bit for bit', (await plateState(page)).undo === b9.undo && (await plateState(page)).models.length === b9.models.length && sameSoup(await raw(page, strayId), SSRC));
  check('Strip stays off', (await card(page)).stripDisabled);
  await disarm(page);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
