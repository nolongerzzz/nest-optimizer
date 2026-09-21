/* Seat against a curved / irregular target - the TASK 1 AUDIT.
   node tools/nso_seat_curved_audit.js     exit 0 = every finding still holds
   npm run seat:curved-audit

   The question this answers, and nothing else: what does the SHIPPED Seat do
   today when the target is not a flat axis-aligned face? Does it refuse the
   way it refuses a straddle, does it silently produce a wrong pose, or
   something else?

   Every number is measured through the REAL app in real Chromium - the
   shipped Seat flush / Seat (support) buttons and the shipped core
   NSO_seatFlushBitToHull - against the repository's real curved fixtures.
   Nothing here is asserted from reading source.

   The gap is measured as the TRUE MINIMUM DISTANCE between the two surfaces
   (tools/nso_soup_distance.js). Every Seat check before this one measured its
   gap as a bounding-box difference along one axis, which is exact for two
   boxes and meaningless against a dome: the closest approach between a flat
   face and a sphere is at the pole, and between a flat face and a groove at
   the groove's rim, and neither is any box extreme.

   The answer, in one line: BOTH. The corner-ray fit refuses outright in the
   common case (the target falls away from a flat footprint, so the rays
   overhang and miss), and in the cases where the rays do land it succeeds
   with the gap reported as asked for while the real clearance is something
   else - or reports a plain sphere to the user as a printed relief.       */

'use strict';

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { soupMinDistance } = require('./nso_soup_distance');

const fx = f => path.join(ROOT, 'fixtures', f);
const lib = f => path.join(ROOT, 'library', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f4 = v => (Number.isFinite(v) ? v.toFixed(4) : String(v));

/* ---- staging, in the page ----
   Both pieces go through applyMeshRotation, so width / height / depth are
   never stale: a pose field set on one stage and cleared on the next has to
   re-measure the box or every distance below is taken against the wrong
   footprint. `tipZ` is the app's OWN quarter-turn field, which the export
   chain carries, so a bit stood on end this way is an ordinary piece. */
const stageAbove = ([a, b, clear, tipZ, offX]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  [pA, pB].forEach(p => {
    p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.flipX = false; p.liftY = 0;
  });
  pA.x = 0; pA.z = 0;
  applyMeshRotation(pA);
  settlePlacedOnBed(pA);
  pA.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  pB.x = offX || 0; pB.z = 0;
  if (tipZ) pB.tipZ = tipZ;
  applyMeshRotation(pB);
  pB.liftY = Math.max(0, bbA.max.y + clear - 0.2);
  applyMeshRotation(pB);
  pB.mesh.updateMatrixWorld(true);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  document.getElementById('status').textContent = '';
  const bbB = new THREE.Box3().setFromObject(pB.mesh);
  return { hullTop: +bbA.max.y.toFixed(4), bitBottom: +bbB.min.y.toFixed(4),
           bitBox: [pB.width, pB.height, pB.depth] };
};

/* What the seat's own internals say about the pairing, before anything moves */
const internals = ([a, b, off]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const hull = meshToWorldSoup(pA.mesh);
  if (!pA.mesh.geometry.boundingBox) pA.mesh.geometry.computeBoundingBox();
  const hc = new THREE.Vector3();
  pA.mesh.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(pA.mesh.matrixWorld);
  const fr = NSO_plugFrame(pB.mesh, hc, hull);
  const origins = NSO_seatRayOrigins(NSO_outerFaceCorners(fr));
  const missed = origins.reduce((n, o) => n + (NSO_nearestSkinHit(hull, o, fr.punch) ? 0 : 1), 0);
  const probe = NSO_seatTipsProbe(hull, pB.mesh, hc);
  const str = NSO_seatStraddle(hull, pB.mesh, hc, off === undefined ? 0.18 : off);
  return {
    axis: fr.axis, sign: fr.sign, outerNormal: fr.outerNormal.toArray().map(v => +v.toFixed(3)),
    missed: missed,
    tipsRise: probe ? +probe.rise.toFixed(4) : null,
    straddle: str ? { proudBy: +str.proudBy.toFixed(3), corners: str.corners } : null
  };
};

/* The core, run directly so the result object can be read, plus both soups
   so the true gap is measured on the geometry the scene actually holds. */
const seatCore = ([a, b, opts]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  const q0 = pB.mesh.quaternion.clone();
  const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, opts);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const dq = pB.mesh.quaternion.clone().multiply(q0.clone().invert());
  return {
    ok: !!(r && r.ok), reason: (r && r.reason) || null,
    mode: r && r.mode, reference: r && r.reference,
    tipRise: r && r.tipRise, gapAchieved: r && r.gapAchieved, maxResidual: r && r.maxResidual,
    tiltDeg: 2 * Math.acos(Math.min(1, Math.abs(dq.w))) * 180 / Math.PI,
    quatChanged: !near0(dq),
    soupA: Array.from(meshToWorldSoup(pA.mesh)), soupB: Array.from(meshToWorldSoup(pB.mesh))
  };
  function near0(q) { return Math.abs(Math.abs(q.w) - 1) < 1e-12; }
};

const clickSeat = async (page, ids, selector, gap) => {
  if (gap !== undefined) {
    await page.evaluate(v => {
      const el = document.getElementById('seat-gap');
      el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, gap);
  }
  await page.click(selector);
  return page.evaluate(() => document.getElementById('status').textContent);
};

const trueGap = r => soupMinDistance(r.soupA, r.soupB).dist;

/* ================================================================= */

withApp(async (page, logs) => {
  const idSphere = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  const idGroove = await loadSTL(page, fx('fixture_groove_concave.stl'));
  const idBlob = await loadSTL(page, fx('fixture_blob_organic.stl'));
  const idBox = await loadSTL(page, fx('box-20mm.stl'));
  const idPin = await loadSTL(page, fx('pin.stl'));
  const idBit = await loadSTL(page, lib('box_bit_12x8x8.stl'));
  const idFlat = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));

  console.log('\n=== 0. the control: a flat axis-aligned target, so every number has a baseline ===');
  {
    await page.evaluate(stageAbove, [idFlat, idBox, 5]);
    const r = await page.evaluate(seatCore, [idFlat, idBox, { gap: -0.18 }]);
    const g = trueGap(r);
    console.log('  reference=' + r.reference + '  gapAchieved=' + f4(r.gapAchieved) +
      '  TRUE minimum distance=' + f4(g));
    check('a flat target seats, on the corner-ray plane path', r.ok && r.reference === 'plane', r.reason || r.reference);
    check('the true minimum surface distance IS the requested 0.18 mm (2e-5)', near(g, 0.18, 2e-5), f4(g));
    check('no rotation is written', !r.quatChanged, f4(r.tiltDeg));
  }

  console.log('\n=== 1. FINDING: the corner-ray gate is the wall. A curved target falls away from a');
  console.log('       flat footprint, the rays overhang it, and the seat REFUSES - both buttons ===');
  {
    const cases = [
      ['20 mm bit centred over the 20 mm sphere', idSphere, idBox, 0],
      ['12x8x8 bit 5 mm off the sphere\'s crown', idSphere, idBit, 5],
      ['12x8x8 bit over the genus-1 groove', idGroove, idBit, 0],
      ['20 mm bit over the organic blob', idBlob, idBox, 0]
    ];
    for (const [label, hull, bit, offX] of cases) {
      await page.evaluate(stageAbove, [hull, bit, 5, 0, offX]);
      const ins = await page.evaluate(internals, [hull, bit]);
      const gapRes = await page.evaluate(seatCore, [hull, bit, { gap: -0.18 }]);
      await page.evaluate(stageAbove, [hull, bit, 5, 0, offX]);
      const proudRes = await page.evaluate(seatCore, [hull, bit, { proud: 0.01 }]);
      console.log('  ' + label + ': corner rays missed ' + ins.missed + ' of 4');
      check('  ' + label + ' - gap mode refuses, naming the ray',
        !gapRes.ok && /corner \d missed hull along punch axis/.test(gapRes.reason || ''), gapRes.reason);
      check('  ' + label + ' - Seat flush refuses the same way',
        !proudRes.ok && /corner \d missed hull along punch axis/.test(proudRes.reason || ''), proudRes.reason);
      check('  ' + label + ' - a refusal moves nothing', !gapRes.quatChanged && !proudRes.quatChanged);
    }
    await page.evaluate(stageAbove, [idSphere, idBox, 5]);
    const status = await clickSeat(page, null, '#btn-seat-support', '-0.18');
    check('the shipped Seat (support) button says exactly that',
      /^Seat failed - corner \d missed hull along punch axis/.test(status), status);
    await page.evaluate(stageAbove, [idSphere, idBox, 5]);
    const status2 = await clickSeat(page, null, '#btn-seat-flush');
    check('and so does Seat flush',
      /^Seat failed - corner \d missed hull along punch axis/.test(status2), status2);
  }

  console.log('\n=== 2. FINDING: where the rays DO land, the gap path measures the right minimum -');
  console.log('       and describes a plain sphere to the user as a printed relief ===');
  {
    await page.evaluate(stageAbove, [idSphere, idBit, 5]);
    const ins = await page.evaluate(internals, [idSphere, idBit]);
    const r = await page.evaluate(seatCore, [idSphere, idBit, { gap: -0.18 }]);
    const g = trueGap(r);
    console.log('  corner rays missed ' + ins.missed + ' of 4; tips probe rise ' + ins.tipsRise +
      ' mm (NSO_SEAT_TIPS_TOL is 0.01)');
    console.log('  reference=' + r.reference + '  tipRise=' + f4(r.tipRise) +
      '  gapAchieved=' + f4(r.gapAchieved) + '  TRUE=' + f4(g));
    check('all four rays land on the crown', ins.missed === 0, ins.missed);
    check('the seat succeeds, on the SKIN-TIPS branch', r.ok && r.reference === 'tips', r.reason || r.reference);
    check('the measurement is right: the true minimum IS 0.18 mm (2e-5)', near(g, 0.18, 2e-5), f4(g));
    check('but the piece is NOT oriented to the surface - it is only translated',
      !r.quatChanged, f4(r.tiltDeg));
    await page.evaluate(stageAbove, [idSphere, idBit, 5]);
    const status = await clickSeat(page, null, '#btn-seat-support', '-0.18');
    console.log('  status: ' + status);
    check('a bare sphere is reported as a skin with a relief height',
      / - from skin tips, relief 3\.\d\dmm above the base plane/.test(status), status);
  }

  console.log('\n=== 3. FINDING: the flush path has no tips probe at all, so on a curve it reports');
  console.log('       success with a residual many times the offset it was asked for ===');
  {
    await page.evaluate(stageAbove, [idSphere, idPin, 5, 1]);
    const ins = await page.evaluate(internals, [idSphere, idPin]);
    const r = await page.evaluate(seatCore, [idSphere, idPin, { proud: 0.01 }]);
    console.log('  rod on end over the crown: rays missed ' + ins.missed + ' of 4, reference=' + r.reference +
      ', maxResidual=' + f4(r.maxResidual) + ' against a requested 0.01');
    check('the rod-on-end seats', r.ok, r.reason);
    check('on the corner-ray PLANE path - proud mode never probes the tips', r.reference === 'plane', r.reference);
    check('and the residual is more than 10x the 0.01 mm that was asked for',
      r.maxResidual > 0.1, f4(r.maxResidual));
  }

  console.log('\n=== 4. FINDING: the footprint is the bit\'s BOX face, not its contact outline, so');
  console.log('       the reported gap and the real clearance part company ===');
  {
    /* fixtures/pin.stl is a cylinder: its 3 x 3 box face over-reaches the
       circle that actually touches, so the support extreme can be found under
       a corner of the square that no part of the rod occupies. On a sphere's
       crown that corner is never the extreme - the pole is, and the pole is
       dead centre of the footprint, inside the circle - so the over-reach
       needs a surface that rises off-axis. The blob is that surface, and the
       same fixture shows the error in BOTH directions. */
    await page.evaluate(stageAbove, [idBlob, idPin, 5, 1]);
    const r1 = await page.evaluate(seatCore, [idBlob, idPin, { gap: -0.18 }]);
    const g1 = trueGap(r1);
    console.log('  round rod on the blob: reported ' + f4(r1.gapAchieved) + ', TRUE ' + f4(g1));
    check('round rod: the seat reports the gap it was asked for', r1.ok && near(r1.gapAchieved, -0.18, 1e-6), f4(r1.gapAchieved));
    check('  ...and the true clearance is LARGER - the box footprint over-reaches the rod',
      g1 > 0.19, f4(g1));

    /* the sphere's crown is the control for that: dead-centre extreme, so the
       square footprint and the round rod agree and there is no error to find */
    await page.evaluate(stageAbove, [idSphere, idPin, 5, 1]);
    const r1b = await page.evaluate(seatCore, [idSphere, idPin, { gap: -0.18 }]);
    const g1b = trueGap(r1b);
    console.log('  control - round rod on the sphere crown: TRUE ' + f4(g1b));
    check('  ...and on the sphere crown the same rod is exact, so the error is the',
      near(g1b, 0.18, 2e-5), 'footprint shape, not the rod: ' + f4(g1b));

    await page.evaluate(stageAbove, [idBlob, idBit, 5]);
    const r2 = await page.evaluate(seatCore, [idBlob, idBit, { gap: -0.18 }]);
    const g2 = trueGap(r2);
    console.log('  flat bit on the blob: reported ' + f4(r2.gapAchieved) + ', TRUE ' + f4(g2));
    check('blob: the seat reports the gap it was asked for', r2.ok && near(r2.gapAchieved, -0.18, 1e-6), f4(r2.gapAchieved));
    check('  ...and the true clearance is SMALLER - the blob rises outside the footprint',
      g2 < 0.178, f4(g2));
    console.log('  => neither error is noise: the whole easy-release window is 0.05 mm wide, and');
    console.log('     these are ' + f4(Math.abs(g1 - 0.18)) + ' mm and ' + f4(Math.abs(g2 - 0.18)) + ' mm.');
  }

  console.log('\n=== 5. FINDING: there is no way to aim at a point - and two frames already exist ===');
  {
    const api = await page.evaluate(() => ({
      core: typeof NSO_seatFlushBitToHull,
      coreArgs: String(NSO_seatFlushBitToHull).slice(0, 60),
      carveProbe: !!(window.NSO_Carve && window.NSO_Carve.probeTarget),
      carvePlace: !!(window.NSO_Carve && window.NSO_Carve.placeBlade),
      skinSupport: !!(window.NSO_Skin && window.NSO_Skin.supportExtreme),
      skinFrame: !!(window.NSO_Skin && window.NSO_Skin.planeFrame)
    }));
    console.log('  ' + api.coreArgs.replace(/\s+/g, ' '));
    check('the shipped core takes (hullMesh, bitMesh, opts) and no target point',
      /function NSO_seatFlushBitToHull\(hullMesh, bitMesh, opts\)/.test(api.coreArgs), api.coreArgs);
    check('REUSABLE: NSO_Carve.probeTarget builds a frame at an arbitrary point on any surface',
      api.carveProbe && api.carvePlace);
    check('REUSABLE: NSO_Skin.supportExtreme measures a surface over a quad footprint',
      api.skinSupport && api.skinFrame);
  }

  console.log('\n=== 6. FINDING: a free orientation does not survive the export, so the shipped');
  console.log('       tilt fit cannot be gated through the canonical checker at all ===');
  {
    const r = await page.evaluate(([a, b]) => {
      const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
      const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
      [pA, pB].forEach(p => { p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.flipX = false; });
      pA.x = 0; pA.z = 0; pA.liftY = 0; applyMeshRotation(pA);
      pB.x = 0; pB.z = 0; pB.liftY = 30; applyMeshRotation(pB);
      /* exactly what the shipped tilt fit does: a free rotation onto the mesh */
      pB.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
      pB.mesh.updateMatrixWorld(true);
      const scene = new THREE.Box3().setFromObject(pB.mesh).getSize(new THREE.Vector3()).toArray();
      /* exactly what Export plate writes */
      const geo = pB.geometry.clone();
      const tip = (pB.tipX || 0) * (Math.PI / 2) + ((pB.tiltX || 0) * Math.PI / 180);
      if (tip) geo.rotateX(tip);
      if (pB.rotY) geo.rotateY(pB.rotY);
      geo.translate(pB.x, pB.height / 2 + (pB.liftY || 0), pB.z);
      geo.computeBoundingBox();
      return {
        scene: scene,
        exported: geo.boundingBox.getSize(new THREE.Vector3()).toArray(),
        pose: { rotY: pB.rotY || 0, tipX: pB.tipX || 0, tiltX: pB.tiltX || 0, tipZ: pB.tipZ || 0, tiltZ: pB.tiltZ || 0 },
        reads: /quaternion/.test(String(buildCombinedGeometry))
      };
    }, [idFlat, idBox]);
    console.log('  scene box    ' + JSON.stringify(r.scene.map(v => +v.toFixed(3))));
    console.log('  exported box ' + JSON.stringify(r.exported.map(v => +v.toFixed(3))));
    check('a 0.3 rad tilt is 5 mm of extra height in the scene', r.scene[1] > 25, f4(r.scene[1]));
    check('...and is absent from what Export plate writes', near(r.exported[1], 20, 1e-3), f4(r.exported[1]));
    check('...because the pose fields carry no free rotation',
      Object.values(r.pose).every(v => v === 0), JSON.stringify(r.pose));
    check('...and buildCombinedGeometry never reads the mesh quaternion', r.reads === false);
  }

  console.log('\n--- page errors ---');
  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log(fails ? '\n' + fails + ' finding(s) no longer hold - re-read the audit' : '\nevery finding holds');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
