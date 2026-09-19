/* Seat with a variable gap, proven through the real app and the canonical
   checker.   node tools/nso_seat_gap_test.js        exit 0 = every gate held

   Hull = fixtures/box_hull_80x40x20-2.stl (80 x 40, 20 tall on the plate),
   bit = fixtures/box-20mm.stl, staged centred above the hull's top face.

   What is pinned:
   1. Regression - the flush plug seat the Seat flush button has always done
      ({ proud: 0.01 }, blank gap field) lands on the pose captured before
      this change, to 1e-9, with the same status line and the same liftY.
   2. The locked easy-release case - gap -0.18 through the real button. The
      scene shows the bit's mating face 0.18 mm above the hull skin, the
      plate export (buildCombinedGeometry, what "Export plate STL" writes)
      is run through tools/mesh_validate.py --json: two closed shells, no
      piercing, no coplanar contact, and the shells measured off the STL are
      0.18 mm apart. Same relation from the 3MF object builder.
   3. Sign convention matches tools/breakaway_coupons.py: +0.05 puts the bit
      into the hull (the checker sees piercing pairs), 0 puts it touching
      (coplanar contact, which an air gap never produces).
   4. Misuse fails loudly: gap + proud together, a non-numeric field. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* Pose the pre-change build produced for the flush seat on this pairing
   (captured 2026-09-16 before any edit to app-join.js). The 0.00999924 is
   0.01 through the hull's Float32 soup, not a fault. */
const GOLDEN_FLUSH = {
  position: [0, 10.309999237060548, 0],
  quaternion: [0, 0, 0, 1],
  liftY: 0.10999923706054915,
  status: 'Seated - proud 0.01mm, skin error 0.00mm - Subtract'
};

/* ---- STL helpers, stdlib only ---- */
function parseBinarySTL(buf) {
  const n = buf.readUInt32LE(80);
  const tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const t = [];
    for (let k = 0; k < 3; k++) {
      t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    }
    tris.push(t);
  }
  return tris;
}

/* Split a soup into connected shells by exact shared vertices. */
function shells(tris) {
  const id = new Map();
  const parent = [];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const vid = v => {
    const k = v.join(',');
    if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); }
    return id.get(k);
  };
  const triV = tris.map(t => t.map(vid));
  for (const t of triV) { union(t[0], t[1]); union(t[1], t[2]); }
  const groups = new Map();
  tris.forEach((t, i) => {
    const r = find(triV[i][0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  return [...groups.values()].map(list => {
    let zmin = Infinity, zmax = -Infinity;
    for (const t of list) for (const v of t) { if (v[2] < zmin) zmin = v[2]; if (v[2] > zmax) zmax = v[2]; }
    return { tris: list.length, zmin, zmax };
  }).sort((a, b) => a.zmin - b.zmin);
}

function meshValidate(file) {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

/* ---- in-page helpers ---- */

/* Put the hull back where a file drop leaves it and the bit centred 5 mm
   above the hull, upright, no lift - the pose every case starts from. */
const stage = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.liftY = 0;
  pA.mesh.position.set(pA.x, pA.height / 2 + 0.3, pA.z);      // the drop baseline
  pA.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  pB.liftY = 0; pB.x = pA.x; pB.z = pA.z;
  pB.mesh.quaternion.identity();
  pB.mesh.position.set(pA.x, bbA.max.y + 5 + pB.height / 2, pA.z);
  pB.mesh.updateMatrixWorld(true);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  document.getElementById('status').textContent = '';
  return { hullTop: bbA.max.y, hullPosY: pA.mesh.position.y };
};

/* World-space relation between the two pieces as the scene shows it. */
const relation = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  const bbB = new THREE.Box3().setFromObject(pB.mesh);
  return {
    bitBottomMinusHullTop: bbB.min.y - bbA.max.y,
    bitTopMinusHullTop: bbB.max.y - bbA.max.y,
    hullPosY: pA.mesh.position.y,
    bitPos: pB.mesh.position.toArray(),
    bitQuat: pB.mesh.quaternion.toArray(),
    bitLiftY: pB.liftY, hullLiftY: pA.liftY || 0,
    status: document.getElementById('status').textContent,
    undoDepth: state.undoStack.length
  };
};

/* What "Export plate STL" writes, as base64, plus the 3MF object relation. */
const exportPlate = () => {
  const geo = buildCombinedGeometry();
  const buf = geometryToBinarySTL(geo);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let mf = null;
  if (window.NSO3MF && typeof buildPlacedObjects3MF === 'function') {
    const objs = buildPlacedObjects3MF().map(o => {
      let zmin = Infinity, zmax = -Infinity;
      for (let i = 2; i < o.vertices.length; i += 3) { const z = o.vertices[i]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
      return { name: o.name, zmin, zmax };
    }).sort((p, q) => p.zmin - q.zmin);
    mf = objs;
  }
  return { stl: btoa(bin), mf };
};

async function seatThroughButton(page, value) {
  await page.evaluate(v => { document.getElementById('seat-gap').value = v; }, value);
  await page.click('#btn-seat-flush');
}

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-seat-'));
  const hullVol = meshValidate(fx('box_hull_80x40x20-2.stl')).signed_volume;
  const bitVol = meshValidate(fx('box-20mm.stl')).signed_volume;
  console.log('  fixture volumes: hull ' + hullVol.toFixed(3) + ', bit ' + bitVol.toFixed(3));
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const ids = [idA, idB];

  const wired = await page.evaluate(() => ({
    input: !!document.getElementById('seat-gap'),
    btn: !!document.getElementById('btn-seat-flush'),
    core: typeof NSO_seatFlushBitToHull === 'function'
  }));
  check('Seat gap field and button are in the Join card', wired.input && wired.btn && wired.core);

  /* ---------- 1. regression: the flush plug seat is unchanged ---------- */
  console.log('\n--- flush seat (blank gap field) - must match the pre-change build ---');
  await page.evaluate(stage, ids);
  const core = await page.evaluate(([a, b]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
    const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, { proud: 0.01 });
    return { ok: r.ok, mode: r.mode, proud: r.proud, maxResidual: r.maxResidual,
             pos: pB.mesh.position.toArray(), quat: pB.mesh.quaternion.toArray(),
             keys: Object.keys(r) };
  }, ids);
  check('core { proud: 0.01 } seats ok in proud mode', core.ok && core.mode === 'proud' && core.proud === 0.01);
  check('core pose equals the golden pose (1e-9)',
    core.pos.every((v, i) => near(v, GOLDEN_FLUSH.position[i], 1e-9)) &&
    core.quat.every((v, i) => near(v, GOLDEN_FLUSH.quaternion[i], 1e-12)),
    JSON.stringify(core.pos));
  check('core skin residual is numerically zero', core.maxResidual < 1e-9, core.maxResidual);
  for (const k of ['ok', 'normal', 'corners', 'hits', 'cornerResidual', 'maxResidual', 'undo']) {
    check('result still carries "' + k + '"', core.keys.indexOf(k) !== -1);
  }

  await page.evaluate(stage, ids);
  await seatThroughButton(page, '');
  const flush = await page.evaluate(relation, ids);
  check('button status line is byte-identical', flush.status === GOLDEN_FLUSH.status, flush.status);
  check('button pose equals the golden pose (1e-9)',
    flush.bitPos.every((v, i) => near(v, GOLDEN_FLUSH.position[i], 1e-9)) &&
    flush.bitQuat.every((v, i) => near(v, GOLDEN_FLUSH.quaternion[i], 1e-12)),
    JSON.stringify(flush.bitPos));
  check('button liftY equals the golden liftY (1e-9)', near(flush.bitLiftY, GOLDEN_FLUSH.liftY, 1e-9), flush.bitLiftY);
  check('flush path leaves the hull where it was (no settle)', near(flush.hullPosY, 10.3, 1e-9), flush.hullPosY);
  check('bit outer face is 0.01 mm proud of the hull skin (Float32 skin, 2e-6)',
    near(flush.bitTopMinusHullTop, 0.01, 2e-6), flush.bitTopMinusHullTop);
  check('bit is buried to 0.01 mm from the hull floor - the plug seat, not a surface seat',
    near(flush.bitBottomMinusHullTop, -19.99, 2e-6), flush.bitBottomMinusHullTop);

  /* ---------- 2. the locked easy-release case: gap -0.18 ---------- */
  console.log('\n--- gap -0.18 (easy release) through the real button ---');
  const staged = await page.evaluate(stage, ids);
  const undoBefore = (await page.evaluate(relation, ids)).undoDepth;
  await seatThroughButton(page, '-0.18');
  const g18 = await page.evaluate(relation, ids);
  console.log('  status: ' + g18.status);
  check('status names an air gap of 0.18 mm with the measured value', /^Seated - air gap 0\.18mm \(measured -0\.180mm/.test(g18.status), g18.status);
  check('scene: bit mating face is 0.18 mm ABOVE the hull skin (air), 2e-6',
    near(g18.bitBottomMinusHullTop, 0.18, 2e-6), g18.bitBottomMinusHullTop);
  check('scene: the bit stands clear, not buried', g18.bitTopMinusHullTop > 20, g18.bitTopMinusHullTop);
  check('bit is upright (flat target, no tilt)', g18.bitQuat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)));
  check('hull was settled to the bed baseline first', near(g18.hullPosY, 10.2, 1e-9), g18.hullPosY);
  check('bit liftY is hull-relative: hull top 20 + 0.18 (2e-6)', near(g18.bitLiftY, 20.18, 2e-6), g18.bitLiftY);
  check('one undo entry was pushed', g18.undoDepth === undoBefore + 1, g18.undoDepth - undoBefore);

  const core18 = await page.evaluate(([a, b]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
    const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, { gap: -0.18 });
    return { ok: r.ok, mode: r.mode, gap: r.gap, gapAchieved: r.gapAchieved, gapMin: r.gapMin, gapMax: r.gapMax, maxResidual: r.maxResidual };
  }, ids);
  check('core reports mode gap, requested -0.18', core18.ok && core18.mode === 'gap' && core18.gap === -0.18);
  check('core gapAchieved is -0.18 in the coupon convention (2e-6)', near(core18.gapAchieved, -0.18, 2e-6), core18.gapAchieved);
  check('core gapMin..gapMax bracket -0.18 tightly', near(core18.gapMin, -0.18, 2e-6) && near(core18.gapMax, -0.18, 2e-6),
    core18.gapMin + ' .. ' + core18.gapMax);
  check('core skin residual is numerically zero', core18.maxResidual < 1e-9, core18.maxResidual);

  // The file the slicer would get, through the canonical checker.
  const exp18 = await page.evaluate(exportPlate);
  const stl18 = path.join(tmp, 'seat_gap_-0.18.stl');
  fs.writeFileSync(stl18, Buffer.from(exp18.stl, 'base64'));
  const v18 = meshValidate(stl18);
  console.log('  mesh_validate: tris ' + v18.triangles + ', open ' + v18.open_edges + ', nonmanifold ' + v18.nonmanifold_edges +
    ', volume ' + v18.signed_volume.toFixed(3) + ', bbox_size ' + JSON.stringify(v18.bbox_size) +
    ', pierce ' + v18.self_intersection.pierce + ', coplanar ' + v18.self_intersection.coplanar);
  check('export holds both shells (28 + 12 triangles)', v18.triangles === 40, v18.triangles);
  check('export is watertight: 0 open, 0 non-manifold edges', v18.open_edges === 0 && v18.nonmanifold_edges === 0);
  check('export volume is hull + bit exactly (two disjoint shells)', near(v18.signed_volume, hullVol + bitVol, 1e-3), v18.signed_volume);
  check('canonical checker: 0 piercing pairs (nothing penetrates)', v18.self_intersection.pierce === 0, v18.self_intersection.pierce);
  check('canonical checker: 0 coplanar contact (nothing touches - not silently flush)', v18.self_intersection.coplanar === 0, v18.self_intersection.coplanar);
  check('export height is 20 + 0.18 + 20 = 40.18 (1e-5)', near(v18.bbox_size[2], 40.18, 1e-5), v18.bbox_size[2]);
  const sh18 = shells(parseBinarySTL(fs.readFileSync(stl18)));
  check('export splits into exactly two shells', sh18.length === 2, sh18.length);
  if (sh18.length === 2) {
    const gapSTL = sh18[1].zmin - sh18[0].zmax;
    console.log('  STL shells: hull z ' + sh18[0].zmin + '..' + sh18[0].zmax + ', bit z ' + sh18[1].zmin + '..' + sh18[1].zmax + ', gap ' + gapSTL);
    check('exported hull rests on the plate (z 0)', near(sh18[0].zmin, 0, 1e-5), sh18[0].zmin);
    check('measured air gap in the exported STL is 0.18 mm (1e-5)', near(gapSTL, 0.18, 1e-5), gapSTL);
  }
  if (exp18.mf) {
    const gap3 = exp18.mf[1].zmin - exp18.mf[0].zmax;
    check('3MF objects carry the same 0.18 mm gap (1e-5)', exp18.mf.length === 2 && near(gap3, 0.18, 1e-5), gap3);
  } else {
    check('3MF object builder available', false, 'NSO3MF missing');
  }

  /* ---------- 3. sign convention: + is penetration, 0 is touching ---------- */
  console.log('\n--- gap +0.05 (overlap) and 0 (touching) ---');
  await page.evaluate(stage, ids);
  await seatThroughButton(page, '0.05');
  const g05 = await page.evaluate(relation, ids);
  check('+0.05 status names an overlap', /^Seated - overlap 0\.05mm \(measured \+0\.050mm/.test(g05.status), g05.status);
  check('+0.05 scene: mating face 0.05 mm BELOW the hull skin (2e-6)', near(g05.bitBottomMinusHullTop, -0.05, 2e-6), g05.bitBottomMinusHullTop);
  const exp05 = await page.evaluate(exportPlate);
  const stl05 = path.join(tmp, 'seat_gap_+0.05.stl');
  fs.writeFileSync(stl05, Buffer.from(exp05.stl, 'base64'));
  const v05 = meshValidate(stl05);
  console.log('  mesh_validate: pierce ' + v05.self_intersection.pierce + ', coplanar ' + v05.self_intersection.coplanar + ', bbox_size ' + JSON.stringify(v05.bbox_size));
  check('+0.05 export: canonical checker sees piercing pairs (the bit is in the hull)', v05.self_intersection.pierce > 0, v05.self_intersection.pierce);
  check('+0.05 export height is 20 - 0.05 + 20 = 39.95 (1e-5)', near(v05.bbox_size[2], 39.95, 1e-5), v05.bbox_size[2]);

  await page.evaluate(stage, ids);
  await seatThroughButton(page, '0');
  const g0 = await page.evaluate(relation, ids);
  check('0 status says touching', /^Seated - touching, gap 0\.00mm \(measured (\+|-)?0\.000mm/.test(g0.status), g0.status);
  check('0 scene: mating face on the hull skin (2e-6)', near(g0.bitBottomMinusHullTop, 0, 2e-6), g0.bitBottomMinusHullTop);
  const exp0 = await page.evaluate(exportPlate);
  const stl0 = path.join(tmp, 'seat_gap_0.stl');
  fs.writeFileSync(stl0, Buffer.from(exp0.stl, 'base64'));
  const v0 = meshValidate(stl0);
  console.log('  mesh_validate: pierce ' + v0.self_intersection.pierce + ', coplanar ' + v0.self_intersection.coplanar + ', bbox_size ' + JSON.stringify(v0.bbox_size));
  // At exactly 0 the bit's walls stand edge-on in the hull's top plane; the
  // checker reports that contact as piercing pairs (it has no "touching along
  // an edge" class), so the discriminator against -0.18 is the coplanar
  // contact of the two faces, which an air gap can never produce.
  check('0 export: coplanar contact seen (touching, distinct from the -0.18 air gap)', v0.self_intersection.coplanar > 0, v0.self_intersection.coplanar);
  check('0 export height is exactly 40 (1e-5)', near(v0.bbox_size[2], 40, 1e-5), v0.bbox_size[2]);

  /* ---------- 4. misuse fails loudly ---------- */
  console.log('\n--- misuse ---');
  const both = await page.evaluate(([a, b]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
    const before = pB.mesh.position.toArray();
    const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, { gap: -0.18, proud: 0.01 });
    return { ok: r.ok, reason: r.reason, moved: pB.mesh.position.toArray().some((v, i) => v !== before[i]) };
  }, ids);
  check('gap + proud together is refused, bit untouched', both.ok === false && !both.moved, both.reason);
  const nan = await page.evaluate(([a, b]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
    const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, { gap: 'abc' });
    return { ok: r.ok, reason: r.reason };
  }, ids);
  check('non-numeric gap is refused by the core', nan.ok === false, nan.reason);

  await page.evaluate(stage, ids);
  const posBefore = (await page.evaluate(relation, ids)).bitPos;
  // a number input drops junk to '' - drive the handler with the raw string instead
  await page.evaluate(() => {
    const el = document.getElementById('seat-gap');
    const saved = readSeatGapInput;
    window.readSeatGapInput = () => Number('abc');
    try { seatFlushBitToHull(); } finally { window.readSeatGapInput = saved; }
  });
  const junk = await page.evaluate(relation, ids);
  check('junk in the gap field is refused with a message, not seated flush', /Seat gap must be a number/.test(junk.status), junk.status);
  check('junk in the gap field leaves the bit where it was', junk.bitPos.every((v, i) => v === posBefore[i]));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nfiles: ' + tmp);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
