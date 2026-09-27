/* Join drops a turned piece's rotation on two of its three combination
   routes. Driven through the real app: a real Split (or two real, unrelated
   pieces), a real pose, a real Join.
     node tools/nso_wire_join_pose_test.js       exit 0 = every gate held

   THE DEFECT. joinSelectedModels (app-join.js) tries three routes in turn -
   planar fuse, plate weld, kernel union - and, whichever one lands, clears
   the winning piece's placed pose afterwards (nsoClearPlacedPose, added by
   the Mirror pose-preservation fix in a3bcbea) on the premise, spelled out
   in app-core.js's own comment on that function: every route either bakes
   the current pose into the drawn geometry, or draws fresh and unposed on
   purpose - so clearing the record is always safe.

   That premise held for kernel union (it builds from meshToWorldSoup, the
   piece's FULL current transform) but not for the other two:
     - planar fuse built its congruence search and its output from
       getModelRawSoup - raw, local, pose ignored outright.
     - plate weld's non-seated branch (joinHalvesOnPlate) built its soup
       with geomToWorldSoup(geometry, x, y, z) - TRANSLATION only, no
       rotation.
   So a piece rotated (rotY, flipX, tipX/tiltX, tipZ/tiltZ) before Join came
   out of these two routes unturned, and the pose was then cleared off the
   record to match - not desynced (Mirror's bug), just gone, with nothing
   left even claiming it. A THIRD, separate bug in the same function - the
   seated sub-branch of plate weld called meshToWorldSoup(placedA) instead
   of placedA.mesh and crashed on every real call, always falling back to
   kernel union (which happens to preserve pose correctly) - is fixed
   alongside since it is the same mistake one branch over, but it is a loud
   crash, not a silent drop, and section 4 below is what actually exercises
   it.

   THE FIX. app-join.js gains NSO_rotateRawSoupByPlacedPose (round-trips a
   raw vertex through display space to apply a piece's CURRENT
   mesh.quaternion, since raw and display axes differ by a fixed
   permutation) and calls it on both raw soups before planar fuse's mating
   search. joinHalvesOnPlate (app-finish.js) now reads each piece's full
   world transform via meshToWorldSoup(placed.mesh) - exactly what kernel
   union already used - instead of geomToWorldSoup's translation-only
   shortcut. For a pose that keeps the piece axis-aligned (a 90/180/270 turn,
   a flip) both routes keep working and now correctly turn the result; for a
   free tilt, planar fuse's axis-based mating search and plate weld's
   axis-based cap stripping correctly find nothing to align and decline -
   exactly the sane behaviour, since a piece really is no longer flush with
   its mate once tipped - and Join falls through to kernel union, which
   handles any orientation via a real boolean union.

   THE MEASUREMENT. Not a picture and not "does the record match the mesh"
   (Mirror's own regression test asks exactly that and passes right through
   this bug undetected - both record and mesh agree, on the WRONG shape).
   Instead: read the WORLD-SPACE triangles straight off each piece's placed
   mesh - bypassing Join entirely - to build an independent "expected"
   bounding box for A (at its current, posed transform) unioned with B.
   Tilting any piece, symmetric or not, generically inflates its axis-
   aligned bounding box, so this needs no specially-crafted asymmetric
   fixture: box-20mm.stl, the repo's own known-good fuse fixture, is enough.
   Compare that expected box against the real Join output's world bbox. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* A plain box with no face congruent to box-20mm.stl's, same 20mm height
   (stays clear of the height-difference threshold that would otherwise pick
   the seated sub-branch when a non-seated case is wanted). */
function writeBox(file, sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
             [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  let s = 'solid box\n';
  for (const t of f) {
    s += 'facet normal 0 0 0\nouter loop\n';
    for (const i of t) s += 'vertex ' + v[i].join(' ') + '\n';
    s += 'endloop\nendfacet\n';
  }
  fs.writeFileSync(file, s + 'endsolid box\n');
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-join-pose-'));
const OTHER_BOX = path.join(tmp, 'other_box.stl');
writeBox(OTHER_BOX, 35, 20, 12);

/* ---- in-page probes: world-space AABB straight off a placed mesh's own
   triangles, entirely independent of any Join code. ---- */
function worldBBoxOf(id) {
  const p = state.placed.find(q => q && q.sourceId === id);
  p.mesh.updateMatrixWorld(true);
  const pos = p.mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld);
    const c = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
  }
  return { lo, hi };
}
function worldBBoxOfActive() {
  const p = state.placed.find(q => q && q.sourceId === state.editId);
  p.mesh.updateMatrixWorld(true);
  const pos = p.mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld);
    const c = [v.x, v.y, v.z];
    for (let k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
  }
  return { lo, hi };
}
function unionBB(a, b) {
  return { lo: [0,1,2].map(k => Math.min(a.lo[k], b.lo[k])), hi: [0,1,2].map(k => Math.max(a.hi[k], b.hi[k])) };
}
function bboxSize(bb) { return [0,1,2].map(k => bb.hi[k] - bb.lo[k]); }

async function joinPair(page, idA, idB) {
  await page.evaluate(([a, b]) => {
    state.joinSession = true; state.editId = a; state.joinPartnerId = b;
    document.getElementById('status').textContent = '';
  }, [idA, idB]);
  await page.evaluate(() => { document.getElementById('btn-join').disabled = false; });
  await page.click('#btn-join');
  await page.waitForFunction(() => /Join ok|Join failed/.test(document.getElementById('status').textContent),
    null, { timeout: 90000 });
  return await statusOf(page);
}

async function resetState(page) {
  await page.evaluate(() => {
    state.models = []; state.placed = []; state.undoStack = [];
    if (typeof closeCutter === 'function') closeCutter(true); else state.cutterOpen = false;
    state.joinSession = false; state.joinPartnerId = null; state.editId = null;
  });
}

/* Real Split (Cut) of a fixture into two placed halves; returns their ids. */
async function realCut(page, file) {
  await resetState(page);
  const id = await loadSTL(page, file);
  await page.evaluate(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); });
  await page.evaluate(() => { const e = document.getElementById('btn-cutter-open'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
  await selectModel(page, id);
  await page.evaluate(() => { if (typeof updateCutHelper === 'function') updateCutHelper(); cutActiveModel(); });
  return await page.evaluate(() => state.models.map(m => m.id));
}

/* Compares a real Join's world-space output against ground truth computed
   independently (both pieces' CURRENT world transforms, unioned) - proves
   whether the turn survived, not just whether the record matches the mesh. */
async function checkPoseSurvives(page, label, idA, idB) {
  const bbA = await page.evaluate(worldBBoxOf, idA);
  const bbB = await page.evaluate(worldBBoxOf, idB);
  const expSize = bboxSize(unionBB(bbA, bbB));

  const status = await joinPair(page, idA, idB);
  check(label + ': Join succeeded', /Join ok/.test(status), status);
  if (!/Join ok/.test(status)) return;

  const actSize = bboxSize(await page.evaluate(worldBBoxOfActive));
  const drift = [0, 1, 2].map(k => Math.abs(actSize[k] - expSize[k]));
  check(label + ': joined world bbox matches the posed ground truth (turn survived)',
    drift.every(d => d < 0.05),
    'expected ' + expSize.map(n => n.toFixed(2)).join('x') +
    ', actual ' + actSize.map(n => n.toFixed(2)).join('x') +
    ', status: ' + status);
  return status;
}

withApp(async (page, logs) => {
  console.log('\n=== 0. NSO_rotateRawSoupByPlacedPose: the fix\'s own math ===');
  {
    await resetState(page);
    const id = await loadSTL(page, fx('box-20mm.stl'));
    await selectModel(page, id);
    const r = await page.evaluate(id => {
      const p = state.placed.find(q => q.sourceId === id);
      const raw = new Float32Array([3, 5, 7,  0, 0, 0,  -2, 1, 4]);
      // identity pose: unchanged
      const same = NSO_rotateRawSoupByPlacedPose(raw, p);
      // rotY = 180: raw (x,y,z) -> (-x,-y,z) (see the function's own comment
      // for the raw<->display axis permutation this round-trips through)
      Object.assign(p, { rotY: Math.PI });
      applyMeshRotation(p);
      const turned = NSO_rotateRawSoupByPlacedPose(raw, p);
      return { same: Array.from(same), turned: Array.from(turned), raw: Array.from(raw) };
    }, id);
    check('identity pose leaves the raw soup unchanged', r.same.every((v, i) => Math.abs(v - r.raw[i]) < 1e-9),
      JSON.stringify(r.same));
    const want = [-3, -5, 7, 0, 0, 0, 2, -1, 4];
    check('rotY=180 negates raw X and Y, keeps raw Z', want.every((v, i) => Math.abs(v - r.turned[i]) < 1e-6),
      'got ' + JSON.stringify(r.turned) + ', want ' + JSON.stringify(want));
  }

  console.log('\n=== 1. planar fuse (real Split of box-20mm.stl), A tiltX=20 ===');
  console.log('    (a free tilt breaks axis-aligned mating on purpose - fuse should');
  console.log('     decline and fall through, and the pose must survive regardless');
  console.log('     of which route actually lands it)');
  {
    const [idA, idB] = await realCut(page, fx('box-20mm.stl'));
    await page.evaluate(a => {
      const pA = state.placed.find(p => p.sourceId === a);
      Object.assign(pA, { tiltX: 20 });
      applyMeshRotation(pA);
    }, idA);
    logs.length = 0;
    await checkPoseSurvives(page, 'fuse/tiltX=20', idA, idB);
    console.log('    route: ' + (logs.filter(l => /\[join\] route/.test(l)).pop() || '(none)'));
  }

  console.log('\n=== 2. planar fuse still fuses normally when nothing is posed ===');
  console.log('    (no regression check: same fixture, same route, no pose -');
  console.log('     volume conserved is the right invariant here, exactly as');
  console.log('     nso_wire_fuse_test.js already checks it; the halves keep');
  console.log('     their kerf allowance, so bbox size is not 20mm on the nose)');
  {
    const [idA, idB] = await realCut(page, fx('box-20mm.stl'));
    const volOf = id => page.evaluate(id => {
      const m = state.models.find(x => x.id === id); const s = m.rawTris; let v = 0;
      for (let t = 0; t < s.length / 9; t++) { const o = t * 9;
        v += (s[o]*(s[o+4]*s[o+8]-s[o+5]*s[o+7]) - s[o+1]*(s[o+3]*s[o+8]-s[o+5]*s[o+6]) + s[o+2]*(s[o+3]*s[o+7]-s[o+4]*s[o+6])); }
      return v / 6;
    }, id);
    const volA = await volOf(idA), volB = await volOf(idB);
    logs.length = 0;
    const status = await joinPair(page, idA, idB);
    check('Join ok via planar fuse', /Join ok \(planar fuse\)/.test(status), status);
    const volJ = await volOf(idA);
    check('volume is the sum of the halves (no pose, no route change)',
      Math.abs(volJ - (volA + volB)) < 1e-2, (volA + volB).toFixed(3) + ' vs ' + volJ.toFixed(3));
  }

  console.log('\n=== 3. plate weld, non-seated branch (unrelated pieces, same height), A tiltX=20 ===');
  {
    await resetState(page);
    const a = await loadSTL(page, fx('box-20mm.stl'));
    const b = await loadSTL(page, OTHER_BOX);
    await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p.sourceId === a), pB = state.placed.find(p => p.sourceId === b);
      Object.assign(pA, { tiltX: 20 }, { x: 0, z: 0 });
      applyMeshRotation(pA);
      pB.x = pA.width / 2 + pB.width / 2 + 2; pB.z = 0;
      applyMeshRotation(pB);
    }, [a, b]);
    logs.length = 0;
    const status = await checkPoseSurvives(page, 'plate-weld(non-seated)/tiltX=20', a, b);
    check('did not take the fuse route (unrelated pieces, no congruent cap)',
      !status || !/planar fuse/.test(status), status);
  }

  console.log('\n=== 4. plate weld, seated branch (one piece parked well above the');
  console.log('    other), A tiltX=20 - this sub-branch crashed on every real call');
  console.log('    before this fix (meshToWorldSoup(placedA) instead of placedA.mesh),');
  console.log('    always falling back to kernel union; confirm it now runs for real ===');
  {
    await resetState(page);
    const a = await loadSTL(page, fx('box-20mm.stl'));
    const b = await loadSTL(page, OTHER_BOX);
    await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p.sourceId === a), pB = state.placed.find(p => p.sourceId === b);
      Object.assign(pA, { tiltX: 20 }, { x: 0, z: 0 });
      applyMeshRotation(pA);
      pB.x = 0; pB.z = 0;
      applyMeshRotation(pB);
      pB.mesh.position.y = pA.mesh.position.y + 20;
      pB.mesh.updateMatrixWorld(true);
    }, [a, b]);
    logs.length = 0;
    await checkPoseSurvives(page, 'plate-weld(seated)/tiltX=20', a, b);
    check('the seated sub-branch actually ran (no crash, no silent fallback)',
      logs.some(l => /in-place weld \(seated port\)/.test(l)),
      logs.filter(l => /\[join\]/.test(l)).join(' | '));
  }

  console.log('\n=== 5. kernel union (overlapping curved shapes, no flat mating face),');
  console.log('    A tiltX=20 - was never affected; confirm it still is not ===');
  {
    await resetState(page);
    const a = await loadSTL(page, fx('fixture_sphere_curved.stl'));
    const b = await loadSTL(page, fx('fixture_sphere_curved.stl'));
    await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p.sourceId === a), pB = state.placed.find(p => p.sourceId === b);
      Object.assign(pA, { tiltX: 20 }, { x: 0, z: 0 });
      applyMeshRotation(pA);
      pB.x = pA.width * 0.3; pB.z = 0;
      applyMeshRotation(pB);
    }, [a, b]);
    logs.length = 0;
    const status = await checkPoseSurvives(page, 'kernel-union/tiltX=20', a, b);
    check('took the kernel union route', status && /kernel union/.test(status), status);
  }

  console.log('\n=== 6. nothing else broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
