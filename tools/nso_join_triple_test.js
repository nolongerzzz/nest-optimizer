/* Triple join: three pieces, two junctions, one press - driven through the
   real app.
     node tools/nso_join_triple_test.js        exit 0 = every gate held

   The claim the feature rests on is that it adds NO positioning math: each
   junction is Center lock followed by Seat (support), called exactly as their
   own buttons call them, and all the triple decides is the order and which
   gap goes with which seam. So the load-bearing gates here are the two that
   compare the sequence against the buttons it is made of:

     3. vertical  - the pose the triple leaves B in is bit-for-bit the pose
                    "Center lock" + "Seat (support)" leave B in by hand;
     7. horizontal- the pose the triple leaves B in is bit-for-bit the pose
                    "Center Z" + "Seat (support)" leave B in by hand.

   Around those:
     1. three pieces picked through the shipped slots, C distinct from A and B;
     2. vertical stack, two DIFFERENT gaps, each measured at its own seam;
     4. the first junction survives the second - B does not fall back to the
        bed when seatBitAtGap settles its host;
     5. mixed gap/solid: a real -0.18 air gap at one seam and a +0.05 weld at
        the other, in one press, then the reverse - the two gaps are two
        numbers, not one used twice;
     6. the full range end to end: -0.25 through 0 through +0.05;
     8. horizontal sequence, the two gaps measured along the run, cross axis
        centred at both seams;
     9. the plate exports through the normal path (Format -> Export plate),
        STL through the canonical checker and 3MF through 3D/3dmodel.model,
        with both junction gaps measured in the FILE;
    10. guards: two pieces is not a triple, C may not be A or B, horizontal
        refuses a pair that is already stacked, a junction that cannot seat
        stops the sequence and says what is still seated;
    11. Undo: four entries, lock/seat/lock/seat, and backing all four out puts
        every piece back where it started. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pieces3MF } = require('./3mf-test/pieces-3mf.js');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { openJoin } = require('./nso_join_card');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-join-triple-'));

/* ---- STL / 3MF readers, stdlib only (same shape as nso_multi_export_check) ---- */
function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
function parseSTL(buf) {
  const n = buf.readUInt32LE(80), tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12, t = [];
    for (let k = 0; k < 3; k++) t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    tris.push(t);
  }
  return tris;
}
function triStats(list) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of list) for (const v of t) for (let a = 0; a < 3; a++) {
    if (v[a] < mn[a]) mn[a] = v[a];
    if (v[a] > mx[a]) mx[a] = v[a];
  }
  return { tris: list.length, min: mn, max: mx,
           centre: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] };
}
/* shells by shared edges - two solids a gap apart share no edge */
function edgeShells(tris) {
  const parent = tris.map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = v => v.map(c => Math.round(c * 1e4)).join('_');
  const owner = new Map();
  tris.forEach((t, i) => {
    const k = t.map(key);
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) union(owner.get(ek), i); else owner.set(ek, i);
    }
  });
  const g = new Map();
  tris.forEach((t, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(t); });
  return [...g.values()].map(triStats);
}
/* one entry per piece, in plate space (tools/3mf-test/pieces-3mf.js reads the
   project envelope's object parts and build items) */
function objects3MF(file) {
  const objs = [];
  for (const p of pieces3MF(file)) {
    const verts = p.verts;
    if (!verts.length) continue;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let a = 0; a < 3; a++) { if (v[a] < mn[a]) mn[a] = v[a]; if (v[a] > mx[a]) mx[a] = v[a]; }
    objs.push({ id: p.id, verts: verts.length, min: mn, max: mx });
  }
  return objs;
}

/* ---- in-page helpers: the same primitives the Seat and Center-lock suites drive ---- */
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const waitStatus = (page, re) => page.waitForFunction(
  src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });

/* Every placed piece as the viewport shows it, plus the pose fields the
   exports read, so a pose can be compared bit-for-bit across two routes. */
const scene = () => state.placed.map((p, i) => {
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { i, id: p.sourceId, name: p.name, x: p.x, z: p.z, liftY: p.liftY || 0,
           pos: p.mesh.position.toArray(), quat: p.mesh.quaternion.toArray(),
           min: bb.min.toArray(), max: bb.max.toArray(),
           seat: p.seat ? { gap: p.seat.gap, kind: p.seat.kind, measured: p.seat.measured } : null };
});
const byId = (s, id) => s.find(p => p.id === id);
const samePose = (a, b) => a && b
  && a.pos.every((v, k) => v === b.pos[k])
  && a.quat.every((v, k) => v === b.quat[k])
  && a.x === b.x && a.z === b.z && a.liftY === b.liftY;

/* the app's own move primitive - what a viewport drag calls */
const moveTo = (page, id, x, z) => page.evaluate(([id, x, z]) => {
  const idx = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(idx);
  const p = state.placed[idx];
  nudgeSelected(x - p.x, z - p.z);
}, [id, x, z]);

/* Pick the three slots through the shipped buttons and list rows. */
async function pickTrio(page, idA, idB, idC) {
  await openJoin(page);
  await page.click('#join-slot-a');
  await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.click('#join-slot-b');
  await page.click(`.model-item[data-edit-id="${idB}"]`);
  if (idC != null) {
    await page.click('#join-slot-c');
    await page.click(`.model-item[data-edit-id="${idC}"]`);
  }
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId,
                                b: state.joinPartnerId, c: state.joinThirdId,
                                runDisabled: document.getElementById('btn-join-triple').disabled }));
}
/* A range input's value, set the way the UI sets it, with the app's own
   input event so the readout follows. */
const setRange = (page, id, v) => page.evaluate(([id, v]) => {
  const el = document.getElementById(id);
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, v]);
const setMode = (page, m) => page.selectOption('#triple-mode', m);

async function runTriple(page, mode, gapAB, gapBC) {
  await setMode(page, mode);
  await setRange(page, 'triple-gap-ab', gapAB);
  await setRange(page, 'triple-gap-bc', gapBC);
  await clearStatus(page);
  await page.click('#btn-join-triple');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0, null, { timeout: 60000 });
  return statusOf(page);
}
const undoTimes = async (page, n) => {
  for (let i = 0; i < n; i++) await page.evaluate(() => undoLast());
};

/* The two seam gaps a VERTICAL stack shows, measured off the world boxes:
   the clear air between B's underside and A's top, and C's and B's. A
   positive gap (overlap) comes back negative, which is what the coupon sign
   convention means by it. */
const vertSeam = (lower, upper) => upper.min[1] - lower.max[1];
/* the same along the run axis for a HORIZONTAL sequence */
const horizSeam = (left, right) => right.min[0] - left.max[0];

withApp(async (page, logs) => {
  console.log('app: ' + page.url());

  /* ============ 1. three pieces, three slots ============ */
  console.log('\n=== 1. three pieces picked through the shipped slots ===');
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const idC = await loadSTL(page, fx('box-20mm.stl'));
  check('three distinct pieces on the plate', idA !== idB && idB !== idC && idA !== idC,
    [idA, idB, idC].join(', '));

  let picked = await pickTrio(page, idA, idB, null);
  check('with only A and B picked the triple Run button is disabled', picked.runDisabled === true);
  await page.click('#join-slot-c');
  await page.click(`.model-item[data-edit-id="${idA}"]`);
  let armed = await page.evaluate(() => ({ c: state.joinThirdId, armed: state.joinArmed }));
  check('C may not be A - the click is refused and the slot stays armed',
    armed.c === null && armed.armed === 'c', JSON.stringify(armed));
  await page.click(`.model-item[data-edit-id="${idB}"]`);
  armed = await page.evaluate(() => ({ c: state.joinThirdId, armed: state.joinArmed }));
  check('C may not be B either', armed.c === null && armed.armed === 'c', JSON.stringify(armed));
  await page.click(`.model-item[data-edit-id="${idC}"]`);
  // Settle all three on the bed baseline before anything is measured, and
  // put them somewhere known while we are at it. A piece that was dropped and
  // never moved sits 0.1 mm above the settled baseline; Seat's own
  // settlePlacedOnBed(host) takes that out on the first seat, which is
  // existing Seat behaviour (see the note in seatBitAtGap) and would read
  // here as the sequence having moved A.
  await moveTo(page, idA, 0, 0);
  await moveTo(page, idB, 40, 0);
  await moveTo(page, idC, -40, 30);
  await pickTrio(page, idA, idB, idC);
  picked = await page.evaluate(() => ({ a: state.editId, b: state.joinPartnerId, c: state.joinThirdId,
    runDisabled: document.getElementById('btn-join-triple').disabled,
    label: document.getElementById('join-name-c').textContent,
    filled: document.getElementById('join-slot-c').classList.contains('filled-c') }));
  check('A, B and C are the three pieces, in order',
    picked.a === idA && picked.b === idB && picked.c === idC, JSON.stringify([picked.a, picked.b, picked.c]));
  check('the C slot names the piece it holds', /box-20mm/i.test(picked.label), picked.label);
  check('the C slot reads as filled', picked.filled === true);
  check('and the Run button is live', picked.runDisabled === false);

  const start = await page.evaluate(scene);

  /* ============ 2. vertical stack, two different gaps ============ */
  console.log('\n=== 2. vertical stack: two junctions, two different gaps, one press ===');
  let status = await runTriple(page, 'vertical', -0.18, -0.05);
  check('one press reports both seams', /^Joined A-B-C stacked/.test(status), status);
  check('...naming the A-B gap', /A-B air gap 0\.18mm/.test(status), status);
  check('...and the B-C gap, which is a different number', /B-C air gap 0\.05mm/.test(status), status);
  let s = await page.evaluate(scene);
  let A = byId(s, idA), B = byId(s, idB), C = byId(s, idC);
  check('B sits over A, centred', near(B.min[0] + B.max[0], A.min[0] + A.max[0], 1e-6)
    && near(B.min[2] + B.max[2], A.min[2] + A.max[2], 1e-6),
    'B centre (' + f3((B.min[0] + B.max[0]) / 2) + ',' + f3((B.min[2] + B.max[2]) / 2) + ')');
  check('C sits over B, centred', near(C.min[0] + C.max[0], B.min[0] + B.max[0], 1e-6)
    && near(C.min[2] + C.max[2], B.min[2] + B.max[2], 1e-6),
    'C centre (' + f3((C.min[0] + C.max[0]) / 2) + ',' + f3((C.min[2] + C.max[2]) / 2) + ')');
  check('the A-B seam is the 0.18 that seam was asked for', near(vertSeam(A, B), 0.18, 2e-3), f3(vertSeam(A, B)));
  check('the B-C seam is the 0.05 that seam was asked for', near(vertSeam(B, C), 0.05, 2e-3), f3(vertSeam(B, C)));
  check('A never moved - it is the piece everything else came to', samePose(A, byId(start, idA)));
  check('each piece carries its own seat record',
    B.seat && B.seat.gap === -0.18 && C.seat && C.seat.gap === -0.05,
    JSON.stringify([B.seat, C.seat]));

  /* ============ 3. the sequence IS the two buttons ============ */
  console.log('\n=== 3. junction one is Center lock + Seat (support), bit for bit ===');
  const tripleB = byId(s, idB);
  await undoTimes(page, 4);
  let back = await page.evaluate(scene);
  check('four undos put all three pieces back where they started',
    samePose(byId(back, idA), byId(start, idA))
    && samePose(byId(back, idB), byId(start, idB))
    && samePose(byId(back, idC), byId(start, idC)));
  // now the same junction by hand, through the two shipped buttons
  await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; updateJoinUI(); }, [idA, idB]);
  await clearStatus(page);
  await page.click('#btn-center-lock');
  await waitStatus(page, /Center locked/);
  await setRange(page, 'seat-gap', -0.18);
  await clearStatus(page);
  await page.click('#btn-seat-support');
  await waitStatus(page, /Seated/);
  const handB = byId(await page.evaluate(scene), idB);
  check('Center lock + Seat (support) by hand land B on the very same pose',
    samePose(handB, tripleB),
    'hand ' + JSON.stringify(handB.pos) + ' vs triple ' + JSON.stringify(tripleB.pos));
  check('...and the same liftY, to the last bit', handB.liftY === tripleB.liftY,
    handB.liftY + ' vs ' + tripleB.liftY);
  await undoTimes(page, 2);

  /* ============ 4. junction one survives junction two ============ */
  console.log('\n=== 4. the first seam survives the second ===');
  await runTriple(page, 'vertical', -0.18, -0.05);
  s = await page.evaluate(scene);
  A = byId(s, idA); B = byId(s, idB); C = byId(s, idC);
  check('B is still 0.18 above A after C was seated onto B', near(vertSeam(A, B), 0.18, 2e-3), f3(vertSeam(A, B)));
  check('B did NOT fall back to the bed when its own seat settled it as a host',
    B.min[1] > 20, 'B underside at ' + f3(B.min[1]));
  check('B carries the A-B seat record, not the B-C one',
    B.seat.gap === -0.18 && C.seat.gap === -0.05, JSON.stringify([B.seat.gap, C.seat.gap]));
  await undoTimes(page, 4);

  /* ============ 5. mixed: a real gap at one seam, a weld at the other ============ */
  console.log('\n=== 5. mixed gap / solid in one press, both ways round ===');
  status = await runTriple(page, 'vertical', -0.18, 0.05);
  s = await page.evaluate(scene);
  A = byId(s, idA); B = byId(s, idB); C = byId(s, idC);
  check('status names an air gap AND an overlap', /A-B air gap 0\.18mm/.test(status) && /B-C overlap 0\.05mm/.test(status), status);
  check('A-B is a real 0.18 air gap', near(vertSeam(A, B), 0.18, 2e-3), f3(vertSeam(A, B)));
  check('B-C is solid: C penetrates B by 0.05', near(vertSeam(B, C), -0.05, 2e-3), f3(vertSeam(B, C)));
  await undoTimes(page, 4);

  status = await runTriple(page, 'vertical', 0.05, -0.18);
  s = await page.evaluate(scene);
  A = byId(s, idA); B = byId(s, idB); C = byId(s, idC);
  check('reversed: the weld is now the FIRST seam', near(vertSeam(A, B), -0.05, 2e-3), f3(vertSeam(A, B)));
  check('...and the air gap the second', near(vertSeam(B, C), 0.18, 2e-3), f3(vertSeam(B, C)));
  check('one gap is not the other used twice',
    Math.abs(vertSeam(A, B) - vertSeam(B, C)) > 0.2, f3(vertSeam(A, B)) + ' vs ' + f3(vertSeam(B, C)));
  await undoTimes(page, 4);

  /* ============ 6. the full range, end to end ============ */
  console.log('\n=== 6. the full slider range at either seam ===');
  for (const [gAB, gBC] of [[-0.25, 0.05], [0, -0.25], [0.05, 0]]) {
    await runTriple(page, 'vertical', gAB, gBC);
    s = await page.evaluate(scene);
    A = byId(s, idA); B = byId(s, idB); C = byId(s, idC);
    check('A-B ' + gAB + ' / B-C ' + gBC + ': A-B seam', near(vertSeam(A, B), -gAB, 2e-3), f3(vertSeam(A, B)));
    check('A-B ' + gAB + ' / B-C ' + gBC + ': B-C seam', near(vertSeam(B, C), -gBC, 2e-3), f3(vertSeam(B, C)));
    await undoTimes(page, 4);
  }

  /* ============ 7 & 8. horizontal ============ */
  console.log('\n=== 7. horizontal: the rough step IS Center Z, bit for bit ===');
  // three pieces in a row along X, each off the centre line in Z so the
  // cross-axis centring has something to do
  const stageRow = async () => {
    await moveTo(page, idA, 0, 0);
    await moveTo(page, idB, 60, 7);
    await moveTo(page, idC, 115, -5);
    // nudgeSelected goes through selectPlaced, which writes state.editId -
    // that IS slot A, so staging retires the picks and they go back on.
    await pickTrio(page, idA, idB, idC);
  };
  await stageRow();
  const rowStart = await page.evaluate(scene);
  await runTriple(page, 'horizontal', -0.18, -0.05);
  let rowTriple = await page.evaluate(scene);
  const hTripleB = byId(rowTriple, idB);
  await undoTimes(page, 4);
  await page.evaluate(([a, b]) => { state.editId = a; state.joinPartnerId = b; updateJoinUI(); }, [idA, idB]);
  await clearStatus(page);
  await page.click('#btn-join-cz');
  await waitStatus(page, /Centered on face Z/);
  await setRange(page, 'seat-gap', -0.18);
  await clearStatus(page);
  await page.click('#btn-seat-support');
  await waitStatus(page, /Seated/);
  const hHandB = byId(await page.evaluate(scene), idB);
  check('Center Z + Seat (support) by hand land B on the very same pose',
    samePose(hHandB, hTripleB),
    'hand ' + JSON.stringify(hHandB.pos) + ' vs triple ' + JSON.stringify(hTripleB.pos));
  await undoTimes(page, 2);

  console.log('\n=== 8. horizontal sequence: two seams along the run ===');
  await stageRow();
  status = await runTriple(page, 'horizontal', -0.18, 0.05);
  check('one press reports a row, not a stack', /^Joined A-B-C in a row/.test(status), status);
  s = await page.evaluate(scene);
  A = byId(s, idA); B = byId(s, idB); C = byId(s, idC);
  check('A-B is a real 0.18 air gap along the run', near(horizSeam(A, B), 0.18, 2e-3), f3(horizSeam(A, B)));
  check('B-C is solid: C penetrates B by 0.05', near(horizSeam(B, C), -0.05, 2e-3), f3(horizSeam(B, C)));
  check('B is centred on A across the run', near(B.min[2] + B.max[2], A.min[2] + A.max[2], 1e-6),
    f3((B.min[2] + B.max[2]) / 2) + ' vs ' + f3((A.min[2] + A.max[2]) / 2));
  check('C is centred on B across the run', near(C.min[2] + C.max[2], B.min[2] + B.max[2], 1e-6),
    f3((C.min[2] + C.max[2]) / 2) + ' vs ' + f3((B.min[2] + B.max[2]) / 2));
  check('every piece is still on the bed - a row is not a stack',
    near(A.min[1], 0.2, 1e-3) && near(B.min[1], 0.2, 1e-3) && near(C.min[1], 0.2, 1e-3),
    [A.min[1], B.min[1], C.min[1]].map(f3).join(', '));
  check('A never moved', samePose(A, byId(rowStart, idA)));

  /* ============ 9. the plate exports through the normal path ============ */
  console.log('\n=== 9. Format -> Export plate, with both seams measured in the FILE ===');
  const beforeExport = await page.evaluate(scene);
  await page.click('#btn-join-clear');
  const exportPlate = async (format, label) => {
    await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.selectOption('#export-format', format);
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('#btn-export-stl')
    ]);
    const file = path.join(out, label + '_' + dl.suggestedFilename());
    await dl.saveAs(file);
    check(label + ': downloaded ' + dl.suggestedFilename(), new RegExp('\\.' + format + '$').test(dl.suggestedFilename()));
    return file;
  };
  const expectTris = meshValidate(fx('box_hull_80x40x20-2.stl')).triangles
                   + 2 * meshValidate(fx('box-20mm.stl')).triangles;

  /* The mixed row that is on the plate right now: 0.18 mm of air at one seam
     and a deliberate 0.05 mm weld at the other. A weld IS an intersection, so
     the canonical checker is expected to report piercing pairs here - that is
     the feature, not a defect, and the all-air export below is where a clean
     verdict is demanded. What must hold either way is that each piece is
     still its own closed shell and both seams are in the file at the number
     the seam was asked for. */
  const mixFile = await exportPlate('stl', 'row-mixed');
  const mvMix = meshValidate(mixFile);
  check('mixed row: every piece exports as a closed shell',
    mvMix.open_edges === 0 && mvMix.nonmanifold_edges === 0 && mvMix.non_solid === false,
    'open ' + mvMix.open_edges + ', nonmanifold ' + mvMix.nonmanifold_edges);
  check('mixed row: Euler characteristic 6 = three closed shells', mvMix.euler_characteristic === 6, mvMix.euler_characteristic);
  check('mixed row: triangle count = the three pieces, nothing fused or dropped',
    mvMix.triangles === expectTris, mvMix.triangles + ' vs ' + expectTris);
  check('mixed row: the weld is really solid - the checker sees the two shells piercing',
    mvMix.self_intersection.pierce > 0, mvMix.self_intersection.pierce + ' piercing pairs');
  const shells = edgeShells(parseSTL(fs.readFileSync(mixFile))).sort((a, b) => a.min[0] - b.min[0]);
  check('mixed row: three separate shells in the file', shells.length === 3, shells.length);
  if (shells.length === 3) {
    const gap1 = shells[1].min[0] - shells[0].max[0];
    const gap2 = shells[2].min[0] - shells[1].max[0];
    check('mixed row: the A-B air gap is in the file', near(gap1, 0.18, 3e-3), f3(gap1));
    check('mixed row: the B-C weld is in the file, as an overlap', near(gap2, -0.05, 3e-3), f3(gap2));
  }
  const mfFile = await exportPlate('3mf', 'row-mixed');
  const objs = objects3MF(mfFile).sort((a, b) => a.min[0] - b.min[0]);
  check('mixed row: three objects in the 3MF', objs.length === 3, objs.length);
  if (objs.length === 3) {
    const g1 = objs[1].min[0] - objs[0].max[0];
    const g2 = objs[2].min[0] - objs[1].max[0];
    check('mixed row: 3MF carries the same A-B gap', near(g1, 0.18, 3e-3), f3(g1));
    check('mixed row: 3MF carries the same B-C overlap', near(g2, -0.05, 3e-3), f3(g2));
  }
  const afterExport = await page.evaluate(scene);
  check('exporting moved nothing',
    [idA, idB, idC].every(id => samePose(byId(afterExport, id), byId(beforeExport, id))));

  /* Two real gaps, no weld: the file a slicer gets from an ordinary triple
     join, through the canonical checker with nothing to excuse. */
  await stageRow();
  await runTriple(page, 'horizontal', -0.18, -0.05);
  const airScene = await page.evaluate(scene);
  await page.click('#btn-join-clear');
  const airFile = await exportPlate('stl', 'row-air');
  const mvAir = meshValidate(airFile);
  console.log('    mesh_validate: tris ' + mvAir.triangles + ', open ' + mvAir.open_edges
    + ', nonmanifold ' + mvAir.nonmanifold_edges + ', euler ' + mvAir.euler_characteristic
    + ', pierce ' + mvAir.self_intersection.pierce + ', coplanar ' + mvAir.self_intersection.coplanar);
  check('air row: the canonical checker passes outright', mvAir.verdict === 'PASS',
    mvAir.verdict + ' ' + JSON.stringify(mvAir.verdict_fails));
  check('air row: 0 piercing and 0 coplanar pairs - nothing touches anything',
    mvAir.self_intersection.pierce === 0 && mvAir.self_intersection.coplanar === 0,
    mvAir.self_intersection.pierce + '/' + mvAir.self_intersection.coplanar);
  check('air row: three closed shells', mvAir.euler_characteristic === 6 && mvAir.open_edges === 0,
    mvAir.euler_characteristic);
  const airShells = edgeShells(parseSTL(fs.readFileSync(airFile))).sort((a, b) => a.min[0] - b.min[0]);
  check('air row: both seams are in the file, each at its own number',
    airShells.length === 3
    && near(airShells[1].min[0] - airShells[0].max[0], 0.18, 3e-3)
    && near(airShells[2].min[0] - airShells[1].max[0], 0.05, 3e-3),
    airShells.length === 3
      ? f3(airShells[1].min[0] - airShells[0].max[0]) + ' / ' + f3(airShells[2].min[0] - airShells[1].max[0])
      : airShells.length + ' shells');
  check('air row: the scene the file came from is the row the sequence built',
    near(horizSeam(byId(airScene, idA), byId(airScene, idB)), 0.18, 2e-3)
    && near(horizSeam(byId(airScene, idB), byId(airScene, idC)), 0.05, 2e-3));

  /* ============ 10. guards ============ */
  console.log('\n=== 10. guards ===');
  await pickTrio(page, idA, idB, null);
  await clearStatus(page);
  let refused = await page.evaluate(() => NSO_TripleJoin.run());
  check('two pieces is not a triple - run() refuses', refused === false);
  check('...and says what is missing', /pick three different pieces/.test(await statusOf(page)), await statusOf(page));

  // horizontal on a pair that is already stacked one over the other
  await moveTo(page, idB, 0, 0);
  await pickTrio(page, idA, idB, idC);
  await setMode(page, 'horizontal');
  const stackedBefore = await page.evaluate(scene);
  await clearStatus(page);
  refused = await page.evaluate(() => NSO_TripleJoin.run());
  check('horizontal refuses a pair that already sits on the same spot', refused === false);
  check('...and says so', /same spot/.test(await statusOf(page)), await statusOf(page));
  const stackedAfter = await page.evaluate(scene);
  check('...having moved nothing',
    [idA, idB, idC].every(id => samePose(byId(stackedAfter, id), byId(stackedBefore, id))));

  // a second junction that cannot seat: C is the 80x40 hull, far wider than B
  const idWide = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await moveTo(page, idA, 0, 0);
  await moveTo(page, idB, 40, 0);
  await moveTo(page, idWide, -80, 60);
  await pickTrio(page, idA, idB, idWide);
  await clearStatus(page);
  const stopped = await runTriple(page, 'vertical', -0.18, -0.18);
  const sStop = await page.evaluate(scene);
  const stopB = byId(sStop, idB), stopA = byId(sStop, idA);
  if (/stopped at B-C/.test(stopped)) {
    check('a junction that cannot seat stops the sequence', true, stopped);
    check('...and says the first seam is seated and was left alone', /A-B is seated at/.test(stopped), stopped);
    check('...and the first seam really is still 0.18', near(vertSeam(stopA, stopB), 0.18, 2e-3), f3(vertSeam(stopA, stopB)));
  } else {
    // the seat took it after all: then it must be a real seat, at the gap asked for
    const stopC = byId(sStop, idWide);
    check('the wide third piece seated after all - then it is at its own gap',
      /^Joined A-B-C stacked/.test(stopped) && near(vertSeam(stopB, stopC), 0.18, 2e-3),
      stopped + ' seam ' + f3(vertSeam(stopB, stopC)));
  }

  /* ============ 11. undo depth ============ */
  console.log('\n=== 11. undo: four entries, the same four the two junctions leave by hand ===');
  await page.click('#btn-join-clear');
  await moveTo(page, idA, 0, 0);
  await moveTo(page, idB, 40, 0);
  await moveTo(page, idC, -40, 30);
  await pickTrio(page, idA, idB, idC);
  const depth0 = await page.evaluate(() => state.undoStack.length);
  const pre = await page.evaluate(scene);
  await runTriple(page, 'vertical', -0.18, -0.05);
  const depth1 = await page.evaluate(() => state.undoStack.length);
  check('a triple join leaves exactly four undo entries: lock, seat, lock, seat',
    depth1 - depth0 === 4, depth1 - depth0);
  await undoTimes(page, 4);
  const post = await page.evaluate(scene);
  check('and four undos put every piece back',
    [idA, idB, idC].every(id => samePose(byId(post, id), byId(pre, id))));

  /* ============ 12. no gate: the Join column is the switch ============ */
  console.log('\n=== 12. no Start Join: the column button starts the session and shows the Join card ===');
  await page.click('#btn-join-clear');
  await page.evaluate(() => document.querySelectorAll('.vp-menu').forEach(d => { d.open = false; }));
  const jstate = () => page.evaluate(() => ({ session: state.joinSession, col: document.getElementById('menu-joins').open,
    card: document.getElementById('menu-join').open, abc: document.getElementById('menu-abc').open,
    slots: (() => { const e = document.getElementById('join-slot-a'), b = e.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return b.height > 0 && !!hit && e.contains(hit); })(),
    a: state.editId, b: state.joinPartnerId }));
  check('there is no #btn-join-start, and no button in the column card but the real ones',
    await page.evaluate(() => !document.getElementById('btn-join-start') &&
      ['join-slot-a', 'join-slot-b', 'join-slot-c', 'btn-join', 'btn-join-clear'].every(id => document.getElementById(id))));
  let J = await jstate();
  check('shut: no session, the slots not on screen', !J.session && !J.col && !J.slots, JSON.stringify(J));
  await page.click('#menu-joins > summary');
  J = await jstate();
  check('one click on the column button: session live, the Join card open, its slots on screen',
    J.session && J.col && J.card && !J.abc && J.slots && J.a == null && J.b == null, JSON.stringify(J));
  await page.click('#join-slot-a'); await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.click('#join-slot-b'); await page.click(`.model-item[data-edit-id="${idB}"]`);
  await page.click('#menu-joins > summary');
  J = await jstate();
  check('the column button again shuts it: the session is Cancelled (B\'s pick gone, the slots off screen)',
    !J.session && !J.col && !J.slots && J.b == null, JSON.stringify(J));
  check('...and the Cancel Join teardown ran (A\'s slot reads empty)',
    await page.evaluate(() => document.getElementById('join-name-a').textContent === 'Pick piece A'));
  await page.click('#menu-joins > summary');
  await page.click('#join-slot-a'); await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.keyboard.press('Escape');
  J = await jstate();
  check('Escape shuts the card and ends the session', !J.session && !J.col, JSON.stringify(J));
  await page.click('#menu-joins > summary');
  await page.click('#join-slot-a'); await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.click('#join-slot-b'); await page.click(`.model-item[data-edit-id="${idB}"]`);
  await page.click('#menu-seat > summary');
  J = await jstate();
  check('another column button shuts the card but leaves the A and B it holds for Seat, Align and Center lock',
    !J.col && J.session && J.a === idA && J.b === idB, JSON.stringify(J));
  await page.click('#menu-joins > summary');
  J = await jstate();
  check('...and coming back to Join finds them as they were, not restarted', J.col && J.session && J.a === idA && J.b === idB, JSON.stringify(J));
  await page.click('#btn-join-clear');
  J = await jstate();
  check('Cancel Join stays in the card: session off, the card still open', !J.session && J.col, JSON.stringify(J));
  await page.click('#join-slot-a');
  check('...and a slot click starts a session again', (await jstate()).session);
  await page.click('#menu-joins > summary');

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nfiles: ' + out);
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
