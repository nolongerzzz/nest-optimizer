/* Mirror keeps the piece's facing: driven through the real app.
     node tools/nso_wire_mirror_orient_test.js      exit 0 = every gate held

   THE DEFECT. Mirror came out turned a full 180 degrees on real pieces while
   its placement stayed right. The reflection itself was never wrong - it
   writes one raw coordinate and the other two bit for bit, and the tests in
   tools/nso_mirror_test.js prove that. The extra half turn came from the
   placed record. Join (and Subtract) draw their result at identity but left
   the pose the pieces had before - rotY, flipX, tipX ... - on the record.
   Nothing on screen showed it. Mirror bakes through NSO_sculptCommitRaw,
   which honours the record, re-applied that stale pose, and an A that had
   been edge-flipped (rotY = pi) or flipped (flipX) before the Join came
   out of the Mirror turned 180 degrees about Y or X. The raw-frame finish
   bakes (Seal, Solidify, Thicken, Soften, Cap) and a geometry Undo had the
   mirror image of the same fault: they drew the piece unposed while the
   record kept its pose, so the next Mirror put the pose back on.

   THE MEASUREMENT. Not a picture. A marked, deliberately asymmetric block
   (a bar with a tab on one corner, so no two of its faces look alike) is
   read off the live mesh in WORLD space before and after. Mirror keeps
   triangle order and swaps corners 1 and 2, so every world vertex after has
   a known partner before. A least-squares fit of the 3x3 map between them
   is the transform the user actually saw. Taking out the one reflection that
   was asked for - across the world plane the raw axis maps to - leaves a
   rotation, and that rotation must be the identity: 0 degrees. Translation
   is allowed; the world box centre is checked too, since placement was
   never the bug and must not become one.                                  */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* ---- the marked block ------------------------------------------------- */
function boxTris(x0, y0, z0, x1, y1, z1, out) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  for (const t of f) out.push(t.map(i => v[i]));
}
function writeMarkedBlock(file) {
  const tris = [];
  boxTris(0, 0, 0, 60, 10, 6, tris);    // the bar, long in X
  boxTris(50, 7, 6, 58, 10, 9, tris);   // the mark: +X end, +Y side, on top
  let s = 'solid marked\n';
  for (const t of tris) {
    s += 'facet normal 0 0 0\nouter loop\n';
    for (const p of t) s += 'vertex ' + p.join(' ') + '\n';
    s += 'endloop\nendfacet\n';
  }
  fs.writeFileSync(file, s + 'endsolid marked\n');
}

/* ---- the fit ------------------------------------------------------------ */
const mul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
          [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
/* before/after: world vertex lists straight off the mesh, 3 per triangle.
   n: world normal of the plane the user asked to mirror across. Returns the
   rotation left over once that reflection is taken out, in degrees. */
function residualDegrees(before, after, n) {
  const P = [], Q = [];
  for (let t = 0; t < before.length / 3; t++) {
    const partner = [0, 2, 1];                 // the winding swap
    for (let c = 0; c < 3; c++) { P.push(before[t * 3 + partner[c]]); Q.push(after[t * 3 + c]); }
  }
  const mean = A => A.reduce((s, p) => [s[0] + p[0] / A.length, s[1] + p[1] / A.length, s[2] + p[2] / A.length], [0, 0, 0]);
  const cp = mean(P), cq = mean(Q);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < P.length; i++) {
    const p = P[i].map((x, k) => x - cp[k]), q = Q[i].map((x, k) => x - cq[k]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) { M[a][b] += p[a] * p[b]; N[a][b] += q[a] * p[b]; }
  }
  const L = mul(N, inv3(M));
  const S = [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? 1 : 0) - 2 * n[i] * n[j]));
  const R = mul(S, L);                         // S is its own inverse
  const cos = Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2));
  return Math.acos(cos) * 180 / Math.PI;
}

/* ---- in-page probes ----------------------------------------------------- */
// World vertices, the world normal raw X maps to, the world box centre, and
// how far the mesh's rotation is from the one the record describes.
const probe = id => {
  const p = state.placed.find(q => q && q.sourceId === id);
  p.mesh.updateMatrixWorld(true);
  const pos = p.mesh.geometry.attributes.position;
  const v = new THREE.Vector3(), world = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(p.mesh.matrixWorld);
    world.push([v.x, v.y, v.z]);
  }
  // raw X is display X (the zup->display turn is about X), then the mesh turns it
  const n = new THREE.Vector3(1, 0, 0).applyQuaternion(p.mesh.quaternion);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const c = new THREE.Vector3(); bb.getCenter(c);
  const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
  const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
  const qRec = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(tip + (p.flipX ? Math.PI : 0), p.rotY || 0, roll, 'XYZ'));
  const recordVsMesh = qRec.angleTo(p.mesh.quaternion) * 180 / Math.PI;
  return {
    world, n: [n.x, n.y, n.z], centre: [c.x, c.z],
    recordVsMesh,
    meshTurn: p.mesh.quaternion.angleTo(new THREE.Quaternion()) * 180 / Math.PI,
    record: { rotY: p.rotY || 0, flipX: !!p.flipX, tipX: p.tipX || 0, tipZ: p.tipZ || 0,
              tiltX: p.tiltX || 0, tiltZ: p.tiltZ || 0, liftY: p.liftY || 0 }
  };
};
const pose = ([id, fields]) => {
  const p = state.placed.find(q => q && q.sourceId === id);
  Object.assign(p, fields);
  applyMeshRotation(p);
};
const mirror = id => {
  state.editId = id;
  const r = NSO_mirrorSelectedModel({ plane: 0, axis: 'x' });
  return { ok: r.ok, reason: r.reason || '' };
};
const reset = () => { state.models = []; state.placed = []; state.undoStack = []; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-mirror-orient-'));
const BLOCK = path.join(tmp, 'marked_block.stl');
writeMarkedBlock(BLOCK);

async function mirrorAndMeasure(page, id, label) {
  const b = await page.evaluate(probe, id);
  const m = await page.evaluate(mirror, id);
  check(label + ': Mirror committed', m.ok, m.reason);
  if (!m.ok) return;
  const a = await page.evaluate(probe, id);
  const deg = residualDegrees(b.world, a.world, b.n);
  check(label + ': rotation beyond the requested reflection is 0', deg < 0.01, deg.toFixed(4) + ' deg');
  const dc = Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]);
  check(label + ': plate position unchanged', dc < 1e-3, 'moved ' + dc.toExponential(2) + ' mm');
  check(label + ': record still describes the mesh', a.recordVsMesh < 0.01, a.recordVsMesh.toFixed(4) + ' deg');
}

withApp(async (page, logs) => {
  console.log('\n=== 1. Mirror on a posed piece: the reflection, and nothing else ===');
  const POSES = [
    ['unposed', {}],
    ['edge 180 (rotY = pi)', { rotY: Math.PI }],
    ['yaw 90', { rotY: Math.PI / 2 }],
    ['flipped (flipX)', { flipX: true }],
    ['tipped on side', { tipX: 1 }],
    ['rolled', { tipZ: 1 }],
    ['free tilt + yaw', { tiltX: 30, rotY: 0.7, tiltZ: 10 }]
  ];
  for (const [label, fields] of POSES) {
    await page.evaluate(reset);
    const id = await loadSTL(page, BLOCK);
    await selectModel(page, id);
    await page.evaluate(pose, [id, fields]);
    await mirrorAndMeasure(page, id, label);
  }

  console.log('\n=== 2. pose -> Join -> Mirror: the reproduced 180 ===');
  for (const [label, fields] of [['edge 180 (rotY = pi)', { rotY: Math.PI }], ['flipped (flipX)', { flipX: true }]]) {
    await page.evaluate(reset);
    const a = await loadSTL(page, BLOCK);
    const b = await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.evaluate(([a, b, fields]) => {
      const pA = state.placed.find(p => p.sourceId === a), pB = state.placed.find(p => p.sourceId === b);
      Object.assign(pA, fields, { x: 0, z: 0 });
      applyMeshRotation(pA);
      pB.x = pA.width / 2 + 10; pB.z = 0;
      applyMeshRotation(pB);
      state.joinSession = true; state.editId = a; state.joinPartnerId = b;
    }, [a, b, fields]);
    await page.evaluate(() => joinSelectedModels());
    const joined = await page.evaluate(([a, b]) => ({
      aLeft: state.models.some(m => m.id === a), bGone: !state.models.some(m => m.id === b)
    }), [a, b]);
    check(label + ': Join landed', joined.aLeft && joined.bGone);
    const j = await page.evaluate(probe, a);
    check(label + ': after Join the record no longer claims the old pose',
      j.recordVsMesh < 0.01, 'record ' + JSON.stringify(j.record) + ', mesh turned ' + j.meshTurn.toFixed(1) + ' deg');
    await mirrorAndMeasure(page, a, label + ' + Join');

    // Undo the Mirror, then the Join: A comes back with the pose it had.
    await page.evaluate(() => { undoLast(); undoLast(); });
    const u = await page.evaluate(probe, a);
    const want = fields.rotY ? { rotY: Math.PI } : { flipX: true };
    const back = Object.keys(want).every(k => Math.abs(+u.record[k] - +want[k]) < 1e-9);
    check(label + ': Undo Join puts A\'s pose back on the record', back, JSON.stringify(u.record));
    check(label + ': ... and on the mesh', u.recordVsMesh < 0.01 && u.meshTurn > 179.9,
      'mesh turned ' + u.meshTurn.toFixed(1) + ' deg, record vs mesh ' + u.recordVsMesh.toFixed(4));
  }

  console.log('\n=== 3. Undo of a Mirror on a posed piece keeps the pose drawn ===');
  {
    await page.evaluate(reset);
    const id = await loadSTL(page, BLOCK);
    await selectModel(page, id);
    await page.evaluate(pose, [id, { rotY: Math.PI }]);
    const before = await page.evaluate(probe, id);
    await page.evaluate(mirror, id);
    await page.evaluate(() => undoLast());
    const after = await page.evaluate(probe, id);
    check('mesh after Undo matches its record', after.recordVsMesh < 0.01,
      after.recordVsMesh.toFixed(4) + ' deg');
    const same = before.world.every((p, i) => Math.hypot(p[0] - after.world[i][0], p[1] - after.world[i][1],
      p[2] - after.world[i][2]) < 1e-4);
    check('and every world vertex is back where it was', same);
  }

  console.log('\n=== 4. a raw-frame finish bake (Seal) on a posed piece, then Mirror ===');
  {
    await page.evaluate(reset);
    const id = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_open.stl'));
    await selectModel(page, id);
    await page.evaluate(pose, [id, { rotY: Math.PI }]);
    const pre = await page.evaluate(() => state.undoStack.length);
    await page.evaluate(() => sealSelectedModel());
    const sealed = await page.evaluate(n => state.undoStack.length > n, pre);
    check('Seal committed a bake', sealed, await page.evaluate(() => document.getElementById('status').textContent));
    const s = await page.evaluate(probe, id);
    check('after Seal the mesh still wears the record\'s pose', s.recordVsMesh < 0.01,
      'record ' + JSON.stringify(s.record) + ', mesh turned ' + s.meshTurn.toFixed(1) + ' deg');
    await mirrorAndMeasure(page, id, 'Seal');
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
