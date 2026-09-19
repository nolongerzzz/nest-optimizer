/* Seat refuses a bit the target face cuts through, instead of collapsing the
   part of it that stands proud.
     node tools/nso_seat_overhang_test.js      exit 0 = every gate held

   The report: a bit sitting across a hull WALL - some of it proud of the
   wall, the rest already inside the hull - seats "successfully". All four
   corner rays land on that one wall, the fit is happy, and the seat drives
   the 6 mm that stood proud down to 0.01 mm, leaving the bit buried as a plug
   through the face and the status line reading "Seated". Lift the same bit to
   the top of the wall, or slide it to the vertical edge, and the identical
   placement refuses with "corner N missed hull along punch axis" - the 2-of-4
   and 1-of-4 cases the seat has always refused.

   Hull = fixtures/box_hull_80x40x20-2.stl (80 x 40, 20 tall on the plate),
   bit = fixtures/hinge_knuckle_box.stl (18 x 8 x 8 - shorter than the hull's
   wall, so a wall CAN shadow all four corner rays; the 20 mm cube cannot be
   put in this pose at all, which is why the defect survived the Seat-gap and
   Seat-align suites).

   What is pinned:
   1. The reported case, through the real buttons: Seat flush and Seat
      (support) both refuse with the straddle reason and leave the bit exactly
      where it was - pose, liftY and the exported plate STL byte-identical.
   2. Consistency with the refusals that already worked: the same bit lifted
      to the top of the wall (2 of 4 rays miss) and at the vertical edge
      (1 of 4) refuse as before, and all three refusals leave the bit
      untouched and push exactly one undo entry.
   3. No silent collapse anywhere: a 504-placement sweep - four walls, seven
      heights, nine depths, both modes. Nothing seats while the face cuts
      through the bit, every refusal restores the pose exactly, and the probe
      itself moves nothing.
   4. Legitimate flush seats are untouched: the Seat-gap golden pose and status
      to 1e-9, the side plug (bit clear of the wall, driven in to 0.01 proud),
      the buried plug re-seat (bit wholly inside, pulled out to 0.01 proud),
      and seating twice in a row - the 0.01 mm the flush seat itself leaves
      standing proud must never read as an overhang.
   5. Legitimate gap seats are untouched: -0.18 through the slider with the
      export run through tools/mesh_validate.py --json (two closed shells,
      0 piercing, 0 coplanar, 0.18 mm apart), +0.05 and 0 re-seated from their
      own result, and a gap seat against a wall.
   6. NSO_seatStraddle itself: pure (moves nothing), null on every legitimate
      pose, and the refusal carries straddle.proudBy / .depth / .corners.
   7. The gate cannot pass vacuously: with the probe stubbed out, the same
      placement still produces the shipped 6 mm -> 0.01 mm burial. */

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

/* The Seat-gap suite's golden flush pose, unchanged by this work. */
const GOLDEN_FLUSH = {
  position: [0, 10.309999237060548, 0],
  quaternion: [0, 0, 0, 1],
  liftY: 0.10999923706054915,
  status: 'Seated - proud 0.01mm, skin error 0.00mm - Subtract'
};
const STRADDLE_RE = /^Seat failed - bit straddles that hull face - (\d+\.\d\d)mm of it stands proud and the rest is already inside\. Move it clear of the face \(or fully inside\) and seat again$/;
const MISSED_RE = /^Seat failed - corner \d missed hull along punch axis$/;

/* ---- STL helpers, stdlib only (as in nso_seat_gap_test.js) ---- */
function parseBinarySTL(buf) {
  const n = buf.readUInt32LE(80);
  const tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const t = [];
    for (let k = 0; k < 3; k++) t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    tris.push(t);
  }
  return tris;
}
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
    let zmin = Infinity, zmax = -Infinity, xmax = -Infinity;
    for (const t of list) for (const v of t) {
      if (v[2] < zmin) zmin = v[2];
      if (v[2] > zmax) zmax = v[2];
      if (v[0] > xmax) xmax = v[0];
    }
    return { tris: list.length, zmin, zmax, xmax };
  }).sort((a, b) => a.zmin - b.zmin);
}
function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

/* ---- in-page helpers ---- */

/* Hull squared onto the bed baseline (the pose Seat (support) settles it to
   anyway), bit put at an exact world centre, upright, liftY kept honest. */
const stage = ([a, b, x, y, z]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.liftY = 0; settlePlacedOnBed(pA); pA.mesh.updateMatrixWorld(true);
  pB.mesh.quaternion.identity();
  pB.x = x; pB.z = z;
  pB.mesh.position.set(x, y, z);
  pB.mesh.updateMatrixWorld(true);
  const bbB = new THREE.Box3().setFromObject(pB.mesh);
  pB.liftY = Math.max(0, bbB.min.y - 0.2);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  document.getElementById('status').textContent = '';
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  return { hull: [bbA.min.toArray(), bbA.max.toArray()], bit: [bbB.min.toArray(), bbB.max.toArray()] };
};

const pose = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  const bbB = new THREE.Box3().setFromObject(pB.mesh);
  const inter = bbB.clone().intersect(bbA);
  const s = inter.isEmpty() ? new THREE.Vector3() : inter.getSize(new THREE.Vector3());
  return {
    pos: pB.mesh.position.toArray(), quat: pB.mesh.quaternion.toArray(),
    x: pB.x, z: pB.z, liftY: pB.liftY || 0,
    min: bbB.min.toArray(), max: bbB.max.toArray(),
    hullMin: bbA.min.toArray(), hullMax: bbA.max.toArray(),
    insideVol: s.x * s.y * s.z,
    status: document.getElementById('status').textContent,
    undoDepth: state.undoStack.length
  };
};

/* What "Export plate STL" writes, as base64. */
const exportPlate = () => {
  const buf = geometryToBinarySTL(buildCombinedGeometry());
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/* One core seat, with the straddle probe and the geometry around it. Restores
   the bit, so a sweep never carries a pose into the next placement. */
const coreTrial = ([a, b, opts]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  const before = new THREE.Box3().setFromObject(pB.mesh);
  const vol = box => {
    const i = box.clone().intersect(bbA);
    if (i.isEmpty()) return 0;
    const s = i.getSize(new THREE.Vector3());
    return s.x * s.y * s.z;
  };
  const soup = meshToWorldSoup(pA.mesh);
  if (!pA.mesh.geometry.boundingBox) pA.mesh.geometry.computeBoundingBox();
  const hc = new THREE.Vector3();
  pA.mesh.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(pA.mesh.matrixWorld);
  const off = (opts.gap !== undefined) ? -opts.gap : opts.proud;

  const savedPos = pB.mesh.position.clone(), savedQuat = pB.mesh.quaternion.clone();
  const st = NSO_seatStraddle(soup, pB.mesh, hc, off);
  const stPure = pB.mesh.position.equals(savedPos) && pB.mesh.quaternion.equals(savedQuat);

  /* how far the bit stands proud of the hull along the seat's outer normal */
  const fr = NSO_plugFrame(pB.mesh, hc, soup);
  const n = fr.outerNormal.clone();
  const ext = (box) => {
    let mx = -Infinity;
    for (const X of [box.min.x, box.max.x]) for (const Y of [box.min.y, box.max.y]) for (const Z of [box.min.z, box.max.z])
      mx = Math.max(mx, new THREE.Vector3(X, Y, Z).dot(n));
    return mx;
  };
  const proudBefore = ext(before) - ext(bbA);
  const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, opts);
  pB.mesh.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(pB.mesh);
  const out = {
    ok: !!(r && r.ok), reason: r && r.reason,
    straddle: r && r.straddle ? { proudBy: r.straddle.proudBy, depth: r.straddle.depth, corners: r.straddle.corners } : null,
    probe: st ? { proudBy: st.proudBy, depth: st.depth, corners: st.corners } : null, probePure: stPure,
    normal: n.toArray(), proudBefore: proudBefore, proudAfter: ext(after) - ext(bbA),
    insideBefore: vol(before), insideAfter: vol(after),
    min: after.min.toArray(), max: after.max.toArray(),
    moved: savedPos.distanceTo(pB.mesh.position),
    restored: false
  };
  out.restored = out.ok || (pB.mesh.position.equals(savedPos) && pB.mesh.quaternion.equals(savedQuat));
  pB.mesh.position.copy(savedPos); pB.mesh.quaternion.copy(savedQuat); pB.mesh.updateMatrixWorld(true);
  return out;
};

async function seatSupport(page, value) {
  await page.evaluate(v => {
    const el = document.getElementById('seat-gap');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
  await page.click('#btn-seat-support');
}

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-seat-overhang-'));
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('hinge_knuckle_box.stl'));
  const idC = await loadSTL(page, fx('box-20mm.stl'));
  const ids = [idA, idB];

  /* The reported placement: the knuckle across the hull's +X wall at
     mid-height - 6 mm of it proud of the wall, the other 12 mm inside. */
  const STRADDLE = [37, 10.2, 0];

  console.log('\n--- 1. the reported case, through the real buttons ---');
  let s = await page.evaluate(stage, [idA, idB, ...STRADDLE]);
  console.log('  staged: hull ' + JSON.stringify(s.hull) + ' bit ' + JSON.stringify(s.bit));
  check('staged across the +X wall: 6 mm proud of x=40, 12 mm inside the hull',
    near(s.bit[1][0] - s.hull[1][0], 6, 1e-9) && s.bit[0][0] < s.hull[1][0], JSON.stringify(s.bit));
  const before = await page.evaluate(pose, ids);
  const stlBefore = await page.evaluate(exportPlate);

  await page.click('#btn-seat-flush');
  const flush = await page.evaluate(pose, ids);
  console.log('  status: ' + flush.status);
  check('Seat flush refuses and names the overhang', STRADDLE_RE.test(flush.status), flush.status);
  check('... the number it names is the 6.00 mm that stood proud',
    STRADDLE_RE.test(flush.status) && STRADDLE_RE.exec(flush.status)[1] === '6.00', flush.status);
  check('... the bit did not move (position, quaternion, x/z, liftY)',
    flush.pos.every((v, i) => v === before.pos[i]) && flush.quat.every((v, i) => v === before.quat[i]) &&
    flush.x === before.x && flush.z === before.z && flush.liftY === before.liftY,
    JSON.stringify(flush.pos) + ' ' + flush.liftY);
  check('... the 6 mm is still standing proud, not driven to 0.01',
    near(flush.max[0] - flush.hullMax[0], 6, 1e-9), flush.max[0] - flush.hullMax[0]);
  check('... the plate export is byte-identical', (await page.evaluate(exportPlate)) === stlBefore);

  await page.evaluate(stage, [idA, idB, ...STRADDLE]);
  await seatSupport(page, -0.18);
  const sup = await page.evaluate(pose, ids);
  console.log('  status: ' + sup.status);
  check('Seat (support) at -0.18 refuses the same pose the same way', STRADDLE_RE.test(sup.status), sup.status);
  check('... and leaves the bit exactly where it was',
    sup.pos.every((v, i) => v === before.pos[i]) && sup.liftY === before.liftY, JSON.stringify(sup.pos));
  check('... the export is byte-identical', (await page.evaluate(exportPlate)) === stlBefore);

  /* Before this fix the same two clicks read "Seated": prove the pose the
     defect produced is the one the refusal prevents. */
  const wouldBe = await page.evaluate(([a, b]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
    const savedPos = pB.mesh.position.clone(), savedQuat = pB.mesh.quaternion.clone();
    const real = NSO_seatStraddle;
    NSO_seatStraddle = function () { return null; };          // the shipped behaviour
    const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, { proud: 0.01 });
    NSO_seatStraddle = real;
    pB.mesh.updateMatrixWorld(true);
    const bbA = new THREE.Box3().setFromObject(pA.mesh);
    const bbB = new THREE.Box3().setFromObject(pB.mesh);
    pB.mesh.position.copy(savedPos); pB.mesh.quaternion.copy(savedQuat); pB.mesh.updateMatrixWorld(true);
    return { ok: r.ok, proud: bbB.max.x - bbA.max.x, inside: bbB.min.x > bbA.min.x && bbB.max.x <= bbA.max.x + 0.02 };
  }, ids);
  check('without the guard the seat still does exactly what was reported: 6 mm -> 0.01 mm, bit buried',
    wouldBe.ok && near(wouldBe.proud, 0.01, 2e-6) && wouldBe.inside, JSON.stringify(wouldBe));

  console.log('\n--- 2. the refusals that already worked, from the same placement ---');
  const family = [
    ['lifted to the top of the wall: 2 of 4 rays miss', [37, 17, 0], MISSED_RE],
    ['at the vertical edge x=40 z=20: 1 of 4 rays hits', [37, 10.2, 20], MISSED_RE],
    ['across the wall at mid-height: all 4 rays hit', STRADDLE, STRADDLE_RE]
  ];
  for (const [name, at, re] of family) {
    const st0 = await page.evaluate(stage, [idA, idB, ...at]);
    const p0 = await page.evaluate(pose, ids);
    const stl0 = await page.evaluate(exportPlate);
    await page.click('#btn-seat-flush');
    const p1 = await page.evaluate(pose, ids);
    check(name + ' -> refused', re.test(p1.status), p1.status);
    check('   ... bit untouched and the export byte-identical',
      p1.pos.every((v, i) => v === p0.pos[i]) && p1.liftY === p0.liftY && (await page.evaluate(exportPlate)) === stl0,
      JSON.stringify(st0.bit));
    check('   ... one undo entry, the same as every other refused seat', p1.undoDepth === p0.undoDepth + 1, p1.undoDepth - p0.undoDepth);
  }

  console.log('\n--- 3. sweep: no placement collapses an overhang, in either mode ---');
  const walls = [
    { name: '+X', at: (d, h) => [40 - 9 + d, h, 0] },
    { name: '-X', at: (d, h) => [-40 + 9 - d, h, 0] },
    { name: '+Z', at: (d, h) => [0, h, 20 - 4 + d] },
    { name: '-Z', at: (d, h) => [0, h, -20 + 4 - d] }
  ];
  const heights = [6, 8, 10.2, 12, 14, 17, 20.2];
  const depths = [-3, 0, 3, 6, 9, 12, 15, 18, 21];
  let seated = 0, refusedStraddle = 0, refusedMiss = 0, collapsed = 0, notRestored = 0, impure = 0, bad = [];
  for (const mode of [{ proud: 0.01 }, { gap: -0.18 }]) {
    for (const w of walls) {
      for (const h of heights) {
        for (const d of depths) {
          const at = w.at(d, h);
          await page.evaluate(stage, [idA, idB, ...at]);
          const r = await page.evaluate(coreTrial, [idA, idB, mode]);
          if (!r.probePure) impure++;
          if (!r.restored) notRestored++;
          if (r.ok) {
            seated++;
            /* a seat may bury a bit that was clear of the face (the plug
               workflow) - it may never eat material that stood proud while
               the rest was already inside */
            if (r.probe) { collapsed++; bad.push(w.name + ' h' + h + ' d' + d + ' ' + JSON.stringify(mode)); }
          } else if (/straddles/.test(r.reason || '')) {
            refusedStraddle++;
            if (!(r.straddle && r.straddle.proudBy > 0 && r.straddle.depth > 0 && r.straddle.corners >= 1 && r.straddle.corners <= 4)) {
              bad.push('no straddle detail at ' + w.name + ' h' + h + ' d' + d);
            }
          } else refusedMiss++;
        }
      }
    }
  }
  console.log('  ' + (seated + refusedStraddle + refusedMiss) + ' placements: ' + seated + ' seated, ' +
    refusedStraddle + ' refused as a straddle, ' + refusedMiss + ' refused on a missed corner');
  check('no placement seats while the face cuts through the bit', collapsed === 0, bad.slice(0, 4).join(' | '));
  check('every straddle refusal carries proudBy and depth', bad.length === 0, bad.slice(0, 4).join(' | '));
  check('the straddle probe never moves the bit', impure === 0, impure);
  check('every refused seat put the bit back exactly', notRestored === 0, notRestored);
  check('legitimate seats are still reachable across the sweep', seated > 100, seated);
  check('the defect class is real and covered', refusedStraddle > 100, refusedStraddle);

  console.log('\n--- 4. flush seats that must still work ---');
  /* the Seat-gap suite's golden case: the 20 mm cube staged 5 mm above */
  await page.evaluate(([a, c]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pC = state.placed.find(p => p && p.sourceId === c && p.mesh);
    pA.liftY = 0;
    pA.mesh.position.set(pA.x, pA.height / 2 + 0.3, pA.z);
    pA.mesh.updateMatrixWorld(true);
    const bbA = new THREE.Box3().setFromObject(pA.mesh);
    pC.liftY = 0; pC.x = pA.x; pC.z = pA.z;
    pC.mesh.quaternion.identity();
    pC.mesh.position.set(pA.x, bbA.max.y + 5 + pC.height / 2, pA.z);
    pC.mesh.updateMatrixWorld(true);
    state.joinSession = true; state.editId = a; state.joinPartnerId = c;
    document.getElementById('status').textContent = '';
  }, [idA, idC]);
  await page.click('#btn-seat-flush');
  const golden = await page.evaluate(pose, [idA, idC]);
  check('the Seat-gap golden flush status is unchanged', golden.status === GOLDEN_FLUSH.status, golden.status);
  check('the golden pose holds to 1e-9',
    golden.pos.every((v, i) => near(v, GOLDEN_FLUSH.position[i], 1e-9)) &&
    golden.quat.every((v, i) => near(v, GOLDEN_FLUSH.quaternion[i], 1e-12)) &&
    near(golden.liftY, GOLDEN_FLUSH.liftY, 1e-9), JSON.stringify(golden.pos) + ' ' + golden.liftY);
  /* and seating it again must not read the 0.01 it just left as an overhang */
  await page.click('#btn-seat-flush');
  const golden2 = await page.evaluate(pose, [idA, idC]);
  check('Seat flush twice in a row: still seated, same pose ===',
    golden2.status === GOLDEN_FLUSH.status && golden2.pos.every((v, i) => v === golden.pos[i]) && golden2.liftY === golden.liftY,
    golden2.status);

  /* the side plug: the knuckle clear of the +X wall, driven in to 0.01 proud */
  const sideClear = [52, 10.2, 0];
  let st = await page.evaluate(stage, [idA, idB, ...sideClear]);
  check('staged clear of the +X wall by 3 mm', near(st.bit[0][0] - st.hull[1][0], 3, 1e-9), st.bit[0][0] - st.hull[1][0]);
  await page.click('#btn-seat-flush');
  const side = await page.evaluate(pose, ids);
  console.log('  status: ' + side.status);
  check('side plug seat still works', /^Seated - proud 0\.01mm/.test(side.status), side.status);
  check('... outer face 0.01 mm proud of the wall, body inside the hull - a plug through that face',
    near(side.max[0] - side.hullMax[0], 0.01, 2e-6) && side.min[0] > side.hullMin[0], side.max[0] - side.hullMax[0]);
  /* Seating it again must not read the 0.01 mm the seat itself left standing
     proud as an overhang. Pinned at the core: the button's own second click on
     a SIDE plug refuses with "corner 0 missed hull along punch axis" both with
     this guard and without it - NSO_raiseBuriedBitClear counts the seated plug
     as buried (its footprint is inside the hull's, to the 0.05 pad its +X face
     now sits within), lifts it above the hull's top, and the corner that is
     0.01 mm past the top face's edge misses. That is the raise heuristic, older
     than this work and untouched by it; see the known limits in docs. */
  const sideAgain = await page.evaluate(coreTrial, [idA, idB, { proud: 0.01 }]);
  check('... and the core re-seats it, it does not become a refusal',
    sideAgain.ok && sideAgain.probe === null && near(sideAgain.proudAfter, 0.01, 2e-6),
    sideAgain.reason || sideAgain.proudAfter);

  /* the buried plug: wholly inside the wall, pulled back out to 0.01 proud */
  await page.evaluate(stage, [idA, idB, 30, 10.2, 0]);
  const buriedCore = await page.evaluate(coreTrial, [idA, idB, { proud: 0.01 }]);
  check('a bit wholly inside the hull still seats out to 0.01 proud (no straddle)',
    buriedCore.ok && buriedCore.probe === null && near(buriedCore.proudAfter, 0.01, 2e-6),
    buriedCore.reason || buriedCore.proudAfter);

  console.log('\n--- 5. gap seats that must still work ---');
  await page.evaluate(([a, c]) => {
    const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
    const pC = state.placed.find(p => p && p.sourceId === c && p.mesh);
    pA.liftY = 0; settlePlacedOnBed(pA); pA.mesh.updateMatrixWorld(true);
    const bbA = new THREE.Box3().setFromObject(pA.mesh);
    pC.liftY = 0; pC.x = pA.x; pC.z = pA.z;
    pC.mesh.quaternion.identity();
    pC.mesh.position.set(pA.x, bbA.max.y + 5 + pC.height / 2, pA.z);
    pC.mesh.updateMatrixWorld(true);
    state.joinSession = true; state.editId = a; state.joinPartnerId = c;
    document.getElementById('status').textContent = '';
  }, [idA, idC]);
  await seatSupport(page, -0.18);
  const g18 = await page.evaluate(pose, [idA, idC]);
  console.log('  status: ' + g18.status);
  check('the locked easy-release seat is unchanged',
    g18.status === 'Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)', g18.status);
  check('scene: mating face 0.18 mm above the hull skin (2e-6)', near(g18.min[1] - g18.hullMax[1], 0.18, 2e-6), g18.min[1] - g18.hullMax[1]);
  /* three pieces are loaded; park the knuckle far down the bed so the export
     gates see the hull and the seated cube alone */
  await page.evaluate(([b]) => {
    const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
    pB.x = 300; pB.z = 0; pB.liftY = 0;
    pB.mesh.position.set(300, 4.2, 0);
    pB.mesh.updateMatrixWorld(true);
  }, [idB]);
  const b64 = await page.evaluate(exportPlate);
  const file = path.join(tmp, 'gap018.stl');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  const mv = meshValidate(file);
  console.log('  mesh_validate: open ' + mv.open_edges + ', pierce ' + mv.self_intersection.pierce +
    ', coplanar ' + mv.self_intersection.coplanar + ', bbox_size ' + JSON.stringify(mv.bbox_size));
  check('export after the -0.18 seat: watertight, 0 piercing, 0 coplanar',
    mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.self_intersection.pierce === 0 && mv.self_intersection.coplanar === 0,
    JSON.stringify([mv.open_edges, mv.self_intersection.pierce, mv.self_intersection.coplanar]));
  const sh = shells(parseBinarySTL(fs.readFileSync(file))).filter(x => x.xmax < 100);
  check('export: the hull and the seated cube are two closed shells 0.18 mm apart (1e-5)',
    sh.length === 2 && near(sh[1].zmin - sh[0].zmax, 0.18, 1e-5), sh.length + ' / ' + (sh.length === 2 ? sh[1].zmin - sh[0].zmax : '-'));

  for (const [v, want] of [[0.05, 'Seated - overlap 0.05mm'], [0, 'Seated - touching, gap 0.00mm']]) {
    await seatSupport(page, v);
    const p1 = await page.evaluate(pose, [idA, idC]);
    await seatSupport(page, v);                       // from its own result, not a fresh stage
    const p2 = await page.evaluate(pose, [idA, idC]);
    check('gap ' + v + ' seats and re-seats from its own result',
      p1.status.indexOf(want) === 0 && p2.status.indexOf(want) === 0 && p2.pos.every((q, i) => near(q, p1.pos[i], 2e-6)),
      p2.status);
  }

  await page.evaluate(stage, [idA, idB, 52, 10.2, 0]);
  await seatSupport(page, -0.18);
  const sideGap = await page.evaluate(pose, ids);
  console.log('  status: ' + sideGap.status);
  check('a gap seat against the wall still works',
    /^Seated - air gap 0\.18mm/.test(sideGap.status) && near(sideGap.min[0] - sideGap.hullMax[0], 0.18, 2e-6),
    sideGap.min[0] - sideGap.hullMax[0]);

  console.log('\n--- 6. the probe itself ---');
  await page.evaluate(stage, [idA, idB, ...STRADDLE]);
  const probe = await page.evaluate(coreTrial, [idA, idB, { proud: 0.01 }]);
  check('NSO_seatStraddle reports 6.00 mm proud of an 18 mm deep bit, all four corners cut',
    probe.probe && near(probe.probe.proudBy, 6, 1e-6) && near(probe.probe.depth, 18, 1e-6) && probe.probe.corners === 4,
    JSON.stringify(probe.probe));
  check('the refusal carries the same numbers',
    probe.straddle && near(probe.straddle.proudBy, 6, 1e-6) && near(probe.straddle.depth, 18, 1e-6), JSON.stringify(probe.straddle));
  check('the refused seat moved nothing', !probe.ok && probe.moved === 0 && probe.restored, probe.moved);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + tmp);
  if (fails) { console.log('\n' + fails + ' GATE(S) FAILED'); process.exit(1); }
  console.log('\nall gates held');
}).catch(e => { console.error('TEST FAIL', e); process.exit(1); });
