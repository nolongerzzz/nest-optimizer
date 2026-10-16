#!/usr/bin/env node
/* Lift, phase 1's fixtures - driven through the REAL app in headless Chromium.

     node tools/nso_lift_drive_check.js                exit 0 = every gate held
     node tools/nso_lift_drive_check.js tools/lift-out ...and keep the screenshots
                                                       (npm run lift:shots; gitignored,
                                                       never committed - they go in the PR)

   The fixtures are generated here (tools/nso_lift_fixtures.js) and go in
   through the app's own Import; the Picture slabs are made by Gen+ -> Picture
   from the relief fixtures the relief tests use, and sent to the plate by
   G-scope's Export to plate. Lift is worked on the plate, from the Subtract
   card (app-lift-plate.js): every hover and click is a real pointer event on
   the main canvas at the screen point of a triangle the app drew. G-scope's
   row is Features, read-only (app-gscope-lift.js).

     1. G-scope's Features row on the plate: 56 features, outlined, the
        grouped list, no action buttons; a click on G-scope's canvas lifts
        nothing
     2. arm Lift on the plate: 56 found. Shift-click the ring and the cap, let
        go: ONE step. The piece keeps its id and becomes the plate: closed,
        flat where they stood, every other triangle bit for bit; two new
        closed pieces exactly where they stood (on the leftover paper, in the
        air over the bed), the ring's bore open; volumes add up, each the
        generator's
     3. Ctrl+Z: the piece is bit for bit what it was, both pieces gone, the
        undo stack as before, 56 again (from the cache)
     4. the slider: at 0.7 the dots are not offered, and a click on one says
        why in words; back to the default
     5. Strip all 56: the top is one flat face again, the volumes add up; one
        Ctrl+Z puts all of it back
     6. a cylinder standing up: its top is flat and nothing is found, in words
     7. the Picture slab, camera.png and the line-drawing scan: Lift reads
        what stands on the paper, Strip lifts it, closed, undo
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_fixtures.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-drive-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const L = require('./nso_lift_plate_drive_lib.js');
const { readout, card, raw, plateState, pieceInfo, overlaps, added, sameSoup, volumeOf, frameOn, hoverTri, clickTri, ctrlZ,
        waitRead, armOn, disarm, featureOf, topTriOf, setSlider, strip, openScopeOnPlate, features, clickScopeTri, frameScope, dropPieces } = L;
const C = L.makeCheck(), check = C.check;

/* ---- fixtures, written as STL for the app's own Import ---- */
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array, Int32Array, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const PL = FX.plate(ctx.rawFlatCapLoops);
const PLATE_STL = path.join(TMP, 'lift-plate.stl');
writeSTL(PLATE_STL, PL.soup);
const CYL_STL = path.join(TMP, 'lift-cylinder.stl');
writeSTL(CYL_STL, FX.cylinder(10, 20, 48));
// the triangles to aim at, by their raw index
const triCentroidZ = (s, t) => (s[t * 9 + 2] + s[t * 9 + 5] + s[t * 9 + 8]) / 3;
function rawTriNear(s, x, y, z, up) {
  let best = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    const nz = (s[o + 3] - s[o]) * (s[o + 7] - s[o + 1]) - (s[o + 4] - s[o + 1]) * (s[o + 6] - s[o]);
    if (up && nz <= 0) continue;
    const cx = (s[o] + s[o + 3] + s[o + 6]) / 3, cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3, cz = triCentroidZ(s, t);
    if (z != null && Math.abs(cz - z) > 1e-6) continue;
    const d = Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
const T_TOP = rawTriNear(PL.soup, 26, 26, 3, true);         // free plate top, a corner
const T_RING = rawTriNear(PL.soup, 13.5, 18, 3.8, true);    // the ring's top
const T_CAP = rawTriNear(PL.soup, -12, -5, null, true);     // the cap's top
const T_DOT = rawTriNear(PL.soup, -18, 18, 3.6, true);      // the middle dot's top

const shots = L.shooter(OUT, KEEP, ROOT);
const islandsAt = page => page.evaluate(() => { const A = NSO_LIFT_PLATE.analysis(); return A ? A.islands.length : null; });

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const V0 = 10800 + PL.truth.reduce((s, t) => s + t.volume, 0);

  /* ============================================ 1. G-scope: Features, read-only */
  console.log('\n=== 1. G-scope: the Features row on the plate ===');
  const plateId = await loadSTL(page, PLATE_STL);
  const SRC = await raw(page, plateId);
  check('the plate came in through Import as one piece', SRC.length / 9 === PL.soup.length / 9, (SRC.length / 9) + ' triangles');
  await openScopeOnPlate(page);
  const f1 = await features(page);
  check('G-scope\'s sidebar has the Features row on the plate, on this piece', f1.title === 'Features' && f1.shown && f1.piece && f1.piece.sourceId === plateId);
  check('it counts 56 features, standing out more than 0.42 mm, grouped', f1.count === 56 && /^56 features found on lift-plate, standing out more than 0\.42 mm: lines ×2 · large shape ×1 · dots ×53\./.test(f1.read), f1.read);
  check('the grouped list, one row a group', f1.rows.join(' | ') === 'Lineslines ×2 | Large shapeslarge shape ×1 | Dotsdots ×53', f1.rows.join(' | '));
  check('each group outlined over the piece', f1.lines === 3, f1.lines + ' outlines');
  check('nothing to press: no Pick base face, no Lift, no Remove, no Clear choice, no slider', f1.controls === 0 &&
    await page.evaluate(() => ['ms-btn-lift-mode', 'ms-btn-lift', 'ms-btn-lift-remove', 'ms-btn-lift-clear', 'ms-lift-height', 'ms-lift-tab-strip'].every(id => !document.getElementById(id))));
  await frameScope(page, plateId, 1.8);
  const u1 = await plateState(page);
  await clickScopeTri(page, plateId, T_RING);
  check('a click on the ring in G-scope lifts nothing: the piece and the undo stack as they were', sameSoup(await raw(page, plateId), SRC) &&
    JSON.stringify((await plateState(page)).models) === JSON.stringify(u1.models) && (await plateState(page)).undo === u1.undo);
  await frameScope(page, plateId);
  await shots.scope(page, '1-plate-features-in-gscope');
  await page.evaluate(() => NSO_MICROSCOPE.close());

  /* ============================= 2. Lift on the plate: Shift-click ring and cap */
  console.log('\n=== 2. Lift on the plate: Shift-click the ring and the cap ===');
  const def = await page.evaluate(() => [NSO_LIFT_PLATE.minHeight(), document.getElementById('lift-height').value,
    document.getElementById('lift-height-read').textContent, NSO_Thickness.floorFor(0.4)]);
  check('"How far out counts" starts at NSO_Thickness.floorFor(0.4) = 0.42 mm', def[0] === 0.42 && +def[1] === 0.42 && def[2] === '0.42 mm' && def[3] === 0.42, def.join(' / '));
  check('armed on the plate: "56 features found", the same count as G-scope', (await armOn(page, plateId)) === '56 features found');
  check('the card read the same cache G-scope filled', (await page.evaluate(() => NSO_LIFT_PLATE.detection().cached)) === true);
  await frameOn(page, plateId);
  const fRing = await featureOf(page, T_RING), fCap = await featureOf(page, T_CAP);
  await hoverTri(page, plateId, T_RING);
  check('hovering the ring outlines it', (await page.evaluate(() => NSO_LIFT_PLATE.hover())) === fRing && fRing >= 0);
  const before = await plateState(page);
  await page.keyboard.down('Shift');
  await clickTri(page, plateId, T_RING);
  await clickTri(page, plateId, T_CAP);
  const pend = await page.evaluate(() => NSO_LIFT_PLATE.pending().slice().sort((a, b) => a - b));
  check('Shift-clicks gather the ring and the cap', JSON.stringify(pend) === JSON.stringify([fRing, fCap].sort((a, b) => a - b)), JSON.stringify(pend));
  await shots.plate(page, '2-plate-ring-and-cap-gathered');
  await page.keyboard.up('Shift');
  await waitRead(page, /Lifted|refused|failed/);
  const after = await plateState(page), r2 = await readout(page);
  check('letting go lifts both, and says one Undo puts them back', /^Lifted 2 features off lift-plate/.test(r2) && /One Undo \(Ctrl\+Z\) puts it all back/.test(r2), r2.slice(0, 200));
  const add2 = added(before, after);
  check('two new pieces, named after the piece they came off', add2.length === 2 && add2.every(m => /^lift-plate - lifted \d+$/.test(m.name)), add2.map(m => m.name).join(', '));
  check('the original piece kept its id and is still the one on the plate', after.models.some(m => m.id === plateId) && after.placed.some(p => p.id === plateId));
  check('exactly ONE undo step was pushed', after.undo === before.undo + 1, before.undo + ' -> ' + after.undo);
  const LEFT = await raw(page, plateId), hostInfo = await pieceInfo(page, plateId);
  check('the plate is closed and manifold', hostInfo.closed && hostInfo.degen === 0, hostInfo.tris + ' tris, chi ' + hostInfo.chi);
  const srcT = SRC.length / 9, leftT = LEFT.length / 9;
  let k = 0, same = 0;
  for (let t = 0; t < srcT && k < leftT; t++) {
    let eq = true;
    for (let q = 0; q < 9; q++) if (SRC[t * 9 + q] !== LEFT[k * 9 + q]) { eq = false; break; }
    if (eq) { k++; same++; }
  }
  let flatNew = true;
  for (let t = k; t < leftT; t++) for (let q = 0; q < 3; q++) if (Math.abs(LEFT[t * 9 + q * 3 + 2] - 3) > 1e-6) flatNew = false;
  const ringT = PL.truth.find(t => t.kind === 'ring'), capT = PL.truth.find(t => t.kind === 'cap');
  check('every triangle it kept is the source\'s, in order, bit for bit', same === srcT - ringT.tris - capT.tris,
    same + ' of ' + srcT + ' kept; ' + (ringT.tris + capT.tris) + ' lifted');
  check('everything new on it lies flat in z = 3: flat where they stood', flatNew && leftT - k > 0, (leftT - k) + ' new triangles');
  const pcs = [];
  for (const m of add2) pcs.push(await pieceInfo(page, m.id));
  const ringPc = pcs.find(p => p.chi === 0), capPc = pcs.find(p => p.chi === 2);
  check('both lifted pieces are closed and manifold', pcs.every(p => p.closed && p.degen === 0), pcs.map(p => p.tris + ' tris chi ' + p.chi).join('; '));
  check('the ring lifted as a ring: its bore open (chi 0)', !!ringPc);
  check('the volumes add up: plate + pieces = the original', Math.abs(hostInfo.volume + pcs.reduce((s, p) => s + p.volume, 0) - V0) < 1e-6 * V0,
    hostInfo.volume.toFixed(3) + ' + ' + pcs.map(p => p.volume.toFixed(3)).join(' + '));
  check('...each piece is the volume the generator built', ringPc && capPc && Math.abs(ringPc.volume - ringT.volume) < 1e-5 && Math.abs(capPc.volume - capT.volume) < 1e-5,
    ringPc && capPc ? ringPc.volume.toFixed(4) + ' / ' + capPc.volume.toFixed(4) : '');
  const hostFp = hostInfo.fp;
  check('each new piece stays where it stood: over the plate, on the paper 3 mm over its bottom, clear of each other',
    pcs.every(p => overlaps(p.fp, hostFp) && Math.abs(p.yMin - hostInfo.yMin - 3) < 1e-3) && !overlaps(pcs[0].fp, pcs[1].fp),
    pcs.map(p => 'x ' + ((p.fp.minx + p.fp.maxx) / 2).toFixed(1) + ' z ' + ((p.fp.minz + p.fp.maxz) / 2).toFixed(1) + ' bottom ' + p.yMin.toFixed(3)).join('; '));
  check('...in the air: liftY says how far over the bed (the floating state)', (await page.evaluate(ids => ids.every(id => {
    const p = state.placed.find(q => q && q.sourceId === id);
    return Math.abs(new THREE.Box3().setFromObject(p.mesh).min.y - 0.2 - (p.liftY || 0)) < 1e-6 && p.liftY > 2.9;
  }), add2.map(m => m.id))));
  check('the card read the plate again: 54 left', (await card(page)).count === '54 features found' && (await islandsAt(page)) === 54);
  await shots.plate(page, '3-plate-after-lift');

  /* =================================================== 3. Undo */
  console.log('\n=== 3. one Ctrl+Z ===');
  await ctrlZ(page);
  const undone = await plateState(page);
  check('the piece is bit for bit what it was', sameSoup(await raw(page, plateId), SRC));
  check('both lifted pieces are gone, from the list and the plate', undone.models.length === before.models.length && undone.placed.length === before.placed.length);
  check('the undo stack is back where it was', undone.undo === before.undo, undone.undo + '');
  check('the card counts 56 again, from the cache, and says so', (await card(page)).count === '56 features found' &&
    (await page.evaluate(() => NSO_LIFT_PLATE.detection().cached)) && /Undo: Lift reverted/.test(await readout(page)), await readout(page));

  /* =================================================== 4. the slider */
  console.log('\n=== 4. "How far out counts" ===');
  await setSlider(page, 0.7);
  const off7 = await page.evaluate(() => NSO_LIFT_PLATE.offered().map(id => +NSO_LIFT_PLATE.analysis().islands[id].heightMm.toFixed(2)).sort());
  check('at 0.70 only the ring (0.8) and the cap (1.5) are offered', JSON.stringify(off7) === '[0.8,1.5]', JSON.stringify(off7));
  check('the card says 2, the read-out how many are lower', (await card(page)).count === '2 features found' && /54 lower, not offered/.test(await readout(page)), await readout(page));
  const b4 = await plateState(page);
  await clickTri(page, plateId, T_DOT);
  const rDot = await readout(page);
  check('a click on a 0.6 mm dot lifts nothing and says why', /stands out only 0\.60 mm, not more than 0\.70 mm/.test(rDot) && (await plateState(page)).undo === b4.undo, rDot);
  await shots.plate(page, '4-plate-slider-0.70');
  await setSlider(page, 0.42);

  /* =================================================== 5. Strip all */
  console.log('\n=== 5. Strip: all 56 ===');
  const b5 = await plateState(page);
  await strip(page, []);
  const a5 = await plateState(page), add5 = added(b5, a5);
  check('all 56 lift, in ONE step', add5.length === 56 && a5.undo === b5.undo + 1, add5.length + ' pieces');
  const flat = await page.evaluate(id => {
    const m = state.models.find(q => q.id === id);
    const s = m.rawTris;
    let seed = -1;                       // a triangle of the top, facing up
    for (let t = 0; t < s.length / 9 && seed < 0; t++) {
      const o = t * 9, nz = (s[o + 3] - s[o]) * (s[o + 7] - s[o + 1]) - (s[o + 4] - s[o + 1]) * (s[o + 6] - s[o]);
      if (s[o + 2] === 3 && s[o + 5] === 3 && s[o + 8] === 3 && nz > 0) seed = t;
    }
    const A = NSO_Lift.analyse(s, seed);
    return { ok: A.ok, islands: A.islands.length, area: A.base.areaMm2, vol: NSO_Lift.volume(m.rawTris), c: NSO_Lift.census(m.rawTris) };
  }, plateId);
  check('the plate\'s top is one flat face again: 3600 mm^2, nothing on it', flat.ok && flat.islands === 0 && Math.abs(flat.area - 3600) < 1e-6, JSON.stringify({ i: flat.islands, a: flat.area }));
  let vSum = 0, allClosed = true;
  for (const m of add5) { const p = await pieceInfo(page, m.id); vSum += p.volume; if (!p.closed) allClosed = false; }
  check('all 56 pieces are closed; the card finds nothing left', allClosed && (await card(page)).count === '0 features found');
  check('plate + 56 pieces = the original, to float32 tolerance', Math.abs(flat.vol + vSum - V0) < 1e-6 * V0, flat.vol.toFixed(3) + ' + ' + vSum.toFixed(3));
  await page.evaluate(() => { if (typeof framePlateHome === 'function') framePlateHome(); });
  await shots.plate(page, '5-plate-all-lifted');
  await ctrlZ(page);
  const u5 = await plateState(page);
  check('one Ctrl+Z puts all of it back', u5.models.length === b5.models.length && u5.undo === b5.undo && sameSoup(await raw(page, plateId), SRC));
  await disarm(page);

  /* =================================================== 6. a cylinder */
  console.log('\n=== 6. a cylinder standing up ===');
  const cylId = await loadSTL(page, CYL_STL);
  const b6 = await plateState(page);
  check('armed on the cylinder: nothing found', (await armOn(page, cylId)) === '0 features found');
  check('...said in words, and nothing changes', /^Nothing found on lift-cylinder: nothing stands out of its top more than 0\.32 mm\./.test(await readout(page)) &&
    JSON.stringify(await plateState(page)) === JSON.stringify(b6), await readout(page));
  await disarm(page);
  await dropPieces(page, [cylId, plateId]);

  /* =================================================== 7. the Picture slab */
  for (const [file, cardIn, label] of [['camera.png', { width: 40, detail: 0.4, levels: '2' }, 'photo'],
                                       ['line-drawing-scan.jpg', { width: 60, detail: 0.4, levels: '2' }, 'scan']]) {
    console.log('\n=== 7. the Picture slab: ' + file + ' (' + label + '), Levels ' + cardIn.levels + ', ' + cardIn.width + ' mm at ' + cardIn.detail + ' ===');
    await page.evaluate(() => { const g = document.getElementById('menu-gen'); g.open = true; document.getElementById('menu-relief').open = true; });
    await page.setInputFiles('#relief-file', path.join(ROOT, 'fixtures', 'relief', file));
    await page.waitForFunction(w => { const q = window.nsoReliefPicture(); return q && q.name === w; }, file, { timeout: 60000 });
    await page.fill('#inp-relief-width', String(cardIn.width));
    await page.fill('#inp-relief-detail', String(cardIn.detail));
    await page.selectOption('#sel-relief-levels', cardIn.levels);
    await page.evaluate(() => window.nsoReliefMake());
    const slabId = await page.evaluate(() => {
      const d = NSO_MICROSCOPE.getDoc();
      NSO_MICROSCOPE.selectObjects([d.objects[0].name]);
      return NSO_MICROSCOPE.exportToPlate();
    });
    await page.evaluate(() => { NSO_MICROSCOPE.close(); document.querySelectorAll('details[open]').forEach(d => { d.open = false; }); });
    check(label + ': the slab is on the plate, through G-scope\'s Export to plate', slabId != null);
    const S0 = await raw(page, slabId);
    const cnt = await armOn(page, slabId);
    const SA = await page.evaluate(() => {
      const A = NSO_LIFT_PLATE.analysis(), st = {};
      A.islands.forEach(I => { st[I.status] = (st[I.status] || 0) + 1; });
      return { st, offered: NSO_LIFT_PLATE.offered(), heights: NSO_LIFT_PLATE.offered().map(id => A.islands[id].heightMm) };
    });
    const rs = await readout(page);
    check(label + ': Lift reads what stands on the paper, and counts it', SA.offered.length > 0 && cnt === SA.offered.length + ' feature' + (SA.offered.length === 1 ? '' : 's') + ' found', cnt);
    check(label + ': each offered stands out more than 0.42 mm', SA.heights.every(h => h > 0.42), SA.offered.length + ' offered, up to ' + Math.max(...SA.heights).toFixed(2) + ' mm');
    check(label + ': what can\'t be lifted is counted, with the reason in words', !(Object.keys(SA.st).some(k => k !== 'ok')) || /can't be lifted - \d+: /.test(rs), JSON.stringify(SA.st));
    await frameOn(page, slabId, 1.3);
    await shots.plate(page, '6-' + label + '-slab-armed');
    const sb = await plateState(page);
    await strip(page, []);
    const sa = await plateState(page), sNew = added(sb, sa), sHost = await pieceInfo(page, slabId);
    let sv = 0, sClosed = true;
    for (const m of sNew) { const p = await pieceInfo(page, m.id); sv += p.volume; if (!p.closed) sClosed = false; }
    const v0 = await volumeOf(page, S0);
    check(label + ': Strip made one closed piece per feature, one undo step', sNew.length === SA.offered.length && sClosed && sa.undo === sb.undo + 1, sNew.length + ' pieces');
    check(label + ': the slab stays closed and the volumes add up', sHost.closed && Math.abs(sHost.volume + sv - v0) < 1e-6 * v0,
      sHost.volume.toFixed(3) + ' + ' + sv.toFixed(3) + ' = ' + v0.toFixed(3));
    await page.evaluate(() => { if (typeof framePlateHome === 'function') framePlateHome(); });
    await shots.plate(page, '7-' + label + '-plate-after-strip');
    await ctrlZ(page);
    const su = await plateState(page);
    check(label + ': one Ctrl+Z puts the slab back bit for bit and takes the pieces off',
      sameSoup(await raw(page, slabId), S0) && su.models.length === sb.models.length && su.undo === sb.undo);
    await disarm(page);
    await dropPieces(page, [slabId]);
  }

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
