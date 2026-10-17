#!/usr/bin/env node
/* Lift on the plate - the Subtract card's LIFT, driven through the REAL app
   in headless Chromium at 1280 x 800.

     node tools/nso_lift_plate_drive_check.js                      exit 0 = every gate held
     node tools/nso_lift_plate_drive_check.js tools/lift-plate-out ...and keep the screenshots
                                                                  (npm run lift:plate-shots;
                                                                  gitignored, never committed)

   The fixture is generated (tools/nso_lift_plate_fixtures.js, the Barocke
   plate: a line, a plant of 12 parts, 20 dots) and goes in through the app's
   own Import. Every hover and click is a real pointer event on the main
   canvas at the screen point of a triangle the app drew; every button and
   tick box is a real click in the Subtract card.

     1. arm Lift on the selected plate: detection runs once, the card says
        "22 features found"; arming again is the cache
     2. hover: the feature under the cursor is outlined
     3. a click lifts one dot: the plate repaired and closed, the new piece
        exactly where it stood (in the air over the plate, on the leftover
        paper), volumes add up, ONE undo step; Ctrl+Z restores both
     4. Shift-click two dots, let go of Shift: one step, two pieces, each
        where it stood
     5. Strip: the grouped list, untick the dots, Confirm: the line and the
        plant lift, where they stood; the dots stay; one Undo step
     6. the lifted piece is an ordinary piece: Move, then Join
     7. (G-scope's Features row left G-scope with the SELECT ticket)
     8. refusals in words: a painted piece, nothing found
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_plate_fixtures.js');
const AFX = require('./nso_lift_auto_fixtures.js');
const L = require('./nso_lift_plate_drive_lib.js');
const { rawTriNear, status, readout, card, raw, plateState, pieceInfo, overlaps, frameOn, hoverTri, clickTri, ctrlZ, waitRead, featureOf, selectRow } = L;
const C = L.makeCheck(), check = C.check;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-plate-drive-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const BAR = FX.barocke();
const BAR_STL = path.join(TMP, 'barocke-plate.stl'), BOX_STL = path.join(TMP, 'plain-box.stl');
writeSTL(BAR_STL, BAR.soup);
writeSTL(BOX_STL, AFX.box(20, 20, 6));

const dots = BAR.truth.filter(t => t.kind === 'dot');
const T_DOT0 = rawTriNear(BAR.soup, dots[0].center[0], dots[0].center[1], 3.5, 3.7);
const T_DOT1 = rawTriNear(BAR.soup, dots[1].center[0], dots[1].center[1], 3.5, 3.7);
const T_DOT2 = rawTriNear(BAR.soup, dots[2].center[0], dots[2].center[1], 3.5, 3.7);
const T_PAPER = rawTriNear(BAR.soup, 60, 20, 2.99, 3.01);

const shots = L.shooter(OUT, KEEP, ROOT), shot = shots.plate;

/* Where the host draws feature `fid`'s own triangles, before it is lifted:
   their world box. A piece that lands where it stood has this box (its cap
   adds nothing outside it). */
const featureBox = (page, hostId, fid) => page.evaluate(([id, f]) => {
  const p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array;
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3(), v = new THREE.Vector3();
  NSO_LIFT_PLATE.analysis().islands[f].tris.forEach(t => {
    for (let k = 0; k < 3; k++) bb.expandByPoint(v.set(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]).applyMatrix4(p.mesh.matrixWorld));
  });
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, [hostId, fid]);
/* A lifted piece as drawn: its world box and the floating record. */
const drawnBox = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id), bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray(), liftY: p.liftY || 0 };
}, id);
/* Same box to within `tol` on every side. */
const sameBox = (a, b, tol) => a && b && [0, 1, 2].every(k => Math.abs(a.min[k] - b.min[k]) <= tol && Math.abs(a.max[k] - b.max[k]) <= tol);
const hostBottom = (page, id) => page.evaluate(id => new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh).min.y, id);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  /* ======================================================== 1. arm Lift */
  console.log('\n=== 1. arm Lift on the Barocke plate ===');
  const plateId = await loadSTL(page, BAR_STL);
  const SRC = await raw(page, plateId);
  check('the Barocke plate came in through Import', SRC.length === BAR.soup.length, SRC.length / 9 + ' triangles');
  await selectRow(page, plateId);
  const c0 = await card(page);
  check('Lift is a verb in the Subtract card, off, its panel hidden', !c0.armed && !c0.panel &&
    await page.evaluate(() => !!document.querySelector('#menu-bit #btn-lift')));
  const t0 = Date.now();
  await page.click('#btn-lift');
  await page.waitForFunction(() => /features? found|nothing read/.test(document.getElementById('lift-count').textContent), null, { timeout: 60000 });
  const c1 = await card(page), r1 = await readout(page);
  const det1 = await page.evaluate(() => NSO_LIFT_PLATE.detection());
  check('armed on the selected piece: the card says "22 features found"', c1.armed && c1.panel && c1.count === '22 features found', c1.count + ' (' + (Date.now() - t0) + ' ms)');
  check('detection ran once, not from the cache', det1.ok && det1.cached === false, det1.ms + ' ms');
  check('the read-out gives the grouped breakdown', /22 features found on .* standing out more than 0\.42 mm: line ×1 · large shape ×1 \(12 parts\) · dots ×20\./.test(r1), r1);
  check('"How far out counts" at the default 0.42', c1.slider === '0.42');
  await page.click('#btn-lift');
  check('Lift off: the panel shuts', !(await card(page)).panel);
  await page.click('#btn-lift');
  const det1b = await page.evaluate(() => NSO_LIFT_PLATE.detection());
  check('armed again on the same piece: the cache, not a second read', det1b.ok && det1b.cached === true && (await card(page)).count === '22 features found');

  /* ============================================================= 2. hover */
  console.log('\n=== 2. hover outlines the feature under the cursor ===');
  await frameOn(page, plateId);
  const fDot0 = await featureOf(page, T_DOT0);
  await hoverTri(page, plateId, T_DOT0);
  const h2 = await page.evaluate(() => ({ hover: NSO_LIFT_PLATE.hover(), kids: NSO_LIFT_PLATE.layer().children.map(c => c.type + ':' + c.material.color.getHexString()) }));
  check('hovering a dot outlines that dot (yellow outline and fill)', h2.hover === fDot0 && h2.hover >= 0 &&
    h2.kids.includes('LineSegments:facc15') && h2.kids.includes('Mesh:facc15'), JSON.stringify(h2));
  check('...the read-out names it', /^A dot, 0\.60 mm high/.test(await readout(page)), await readout(page));
  await hoverTri(page, plateId, T_PAPER);
  check('hovering the bare plate outlines nothing', (await page.evaluate(() => NSO_LIFT_PLATE.hover())) === -1);
  const fPlant = await featureOf(page, rawTriNear(BAR.soup, BAR.truth.find(t => t.kind === 'plant').leaves[4][0], BAR.truth.find(t => t.kind === 'plant').leaves[4][1], 3.7, 3.9));
  await hoverTri(page, plateId, rawTriNear(BAR.soup, BAR.truth.find(t => t.kind === 'plant').leaves[4][0], BAR.truth.find(t => t.kind === 'plant').leaves[4][1], 3.7, 3.9));
  check('hovering a leaf outlines the whole plant, one feature', (await page.evaluate(() => NSO_LIFT_PLATE.hover())) === fPlant &&
    (await page.evaluate(id => NSO_LIFT_PLATE.analysis().islands[id].group, fPlant)) === 'large', await readout(page));
  await shot(page, '1-hover-outline');

  /* ================================================== 3. a click lifts one */
  console.log('\n=== 3. a click lifts one dot ===');
  const b3 = await plateState(page);
  const v0 = await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), SRC);
  const box3 = await featureBox(page, plateId, fDot0), bed3 = await hostBottom(page, plateId);
  await clickTri(page, plateId, T_DOT0);
  await waitRead(page, /Lifted|refused|failed/);
  const r3 = await readout(page), a3 = await plateState(page);
  const added3 = a3.models.filter(m => !b3.models.some(b => b.id === m.id));
  check('a click on the dot lifts it, said in words', /^Lifted 1 feature off barocke-plate/.test(r3) && /One Undo \(Ctrl\+Z\) puts it all back/.test(r3), r3.slice(0, 180));
  check('one new piece, named after the plate', added3.length === 1 && /- lifted \d+$/.test(added3[0].name), added3.map(m => m.name).join(', '));
  check('exactly ONE undo step', a3.undo === b3.undo + 1, b3.undo + ' -> ' + a3.undo);
  const host3 = await pieceInfo(page, plateId), pc3 = added3.length ? await pieceInfo(page, added3[0].id) : null;
  check('the plate keeps its id and is repaired: closed, no degenerate faces', host3 && host3.closed && host3.degen === 0, host3 && host3.tris + ' tris');
  const d3 = pc3 ? await drawnBox(page, pc3.id) : null;
  check('the dot is a closed piece, exactly where it stood: the box the plate drew it in', pc3 && pc3.closed && sameBox(d3, box3, 1e-3),
    d3 && JSON.stringify(d3.min.map(v => +v.toFixed(3))) + ' vs ' + JSON.stringify(box3.min.map(v => +v.toFixed(3))));
  check('...over its own spot on the plate, in the air on the paper: its bottom 3 mm over the plate\'s, liftY says so',
    pc3 && overlaps(pc3.fp, host3.fp) && Math.abs(d3.min[1] - bed3 - BAR.paper) < 1e-3 && Math.abs(d3.liftY - (d3.min[1] - 0.2)) < 1e-6,
    d3 && 'bottom ' + d3.min[1].toFixed(3) + ', plate ' + bed3.toFixed(3) + ', liftY ' + d3.liftY.toFixed(3));
  check('...and the read-out says it stays where it stood, in the air', /stays where it stood/.test(r3) && /in the air, 3\.\d\d mm over the bed/.test(r3), r3.slice(0, 400));
  check('plate + piece = the original', pc3 && Math.abs(host3.volume + pc3.volume - v0) < 1e-6 * v0, host3.volume.toFixed(3) + ' + ' + (pc3 && pc3.volume.toFixed(3)) + ' = ' + v0.toFixed(3));
  check('the card now counts 21', (await card(page)).count === '21 features found');
  await ctrlZ(page);
  const U3 = await raw(page, plateId), u3 = await plateState(page);
  check('one Ctrl+Z: the plate bit for bit, the piece gone, the undo stack as before',
    U3.length === SRC.length && U3.every((v, i) => v === SRC[i]) && u3.models.length === b3.models.length && u3.undo === b3.undo);
  const det3 = await page.evaluate(() => NSO_LIFT_PLATE.detection());
  check('...and the card counts 22 again, from the cache', (await card(page)).count === '22 features found' && det3.cached === true, await readout(page));

  /* =============================================== 4. Shift-click two dots */
  console.log('\n=== 4. Shift-click two dots, one step ===');
  const b4 = await plateState(page);
  await page.keyboard.down('Shift');
  await clickTri(page, plateId, T_DOT1);
  await clickTri(page, plateId, T_DOT2);
  const p4 = await page.evaluate(() => NSO_LIFT_PLATE.pending().length);
  check('Shift held: two dots gathered, nothing lifted yet', p4 === 2 && (await plateState(page)).undo === b4.undo, p4 + ' gathered');
  await page.keyboard.up('Shift');
  await waitRead(page, /Lifted|refused|failed/);
  const a4 = await plateState(page), added4 = a4.models.filter(m => !b4.models.some(b => b.id === m.id));
  check('letting go of Shift lifts both in ONE step', added4.length === 2 && a4.undo === b4.undo + 1, added4.length + ' pieces, ' + b4.undo + ' -> ' + a4.undo);
  let c4 = true;
  const host4 = await pieceInfo(page, plateId);
  for (const m of added4) { const p = await pieceInfo(page, m.id), d = await drawnBox(page, m.id); if (!p.closed || !overlaps(p.fp, host4.fp) || !(d.liftY > 2.9)) c4 = false; }
  check('...both closed, each where it stood over the plate; the card counts 20', c4 && (await card(page)).count === '20 features found');
  await ctrlZ(page);
  const U4 = await raw(page, plateId);
  check('one Ctrl+Z puts both back, bit for bit', U4.every((v, i) => v === SRC[i]) && (await plateState(page)).models.length === b4.models.length);

  /* ============================================================= 5. Strip */
  console.log('\n=== 5. Strip: untick the dots, Confirm ===');
  await page.click('#btn-lift-strip');
  const c5 = await card(page);
  check('Strip opens a short list, every group ticked', c5.strip && c5.rows.length === 3 && c5.rows.every(r => r.checked),
    c5.rows.map(r => r.text).join(' | '));
  check('the grouped breakdown: line ×1 · large shape ×1 (12 parts) · dots ×20 · bare plate', c5.sum === 'line ×1 · large shape ×1 (12 parts) · dots ×20 · bare plate', c5.sum);
  check('Confirm says how many: 22', c5.go === 'Confirm – lift 22', c5.go);
  await page.click('#lift-strip-rows input[data-group="dots"]');
  await page.waitForTimeout(150);
  const c5b = await card(page);
  check('dots unticked: the plate keeps 20, Confirm lifts 2', c5b.sum === 'line ×1 · large shape ×1 (12 parts) · the plate keeps 20' && c5b.go === 'Confirm – lift 2', c5b.sum + ' / ' + c5b.go);
  await page.click('#btn-lift-strip-cancel');
  check('Cancel shuts the list and changes nothing', !(await card(page)).strip && (await plateState(page)).undo === b4.undo);
  await page.click('#btn-lift-strip');
  await page.click('#lift-strip-rows input[data-group="dots"]');
  const b5 = await plateState(page);
  await page.click('#btn-lift-strip-go');
  await waitRead(page, /Lifted|refused|failed/);
  const a5 = await plateState(page), added5 = a5.models.filter(m => !b5.models.some(b => b.id === m.id));
  const host5 = await pieceInfo(page, plateId);
  let v5 = 0, c5c = true;
  for (const m of added5) { const p = await pieceInfo(page, m.id), d = await drawnBox(page, m.id); v5 += p.volume; if (!p.closed || !overlaps(p.fp, host5.fp) || !(d.liftY > 2.9)) c5c = false; }
  check('Confirm lifts the line and the plant: two pieces, ONE undo step', added5.length === 2 && a5.undo === b5.undo + 1, added5.map(m => m.name).join(', '));
  check('...closed, each where it stood over the plate; the plate closed; volumes add up', c5c && host5.closed && Math.abs(host5.volume + v5 - v0) < 1e-6 * v0,
    host5.volume.toFixed(3) + ' + ' + v5.toFixed(3) + ' = ' + v0.toFixed(3));
  const g5 = await page.evaluate(() => NSO_LIFT_PLATE.groups(NSO_LIFT_PLATE.analysis(), NSO_LIFT_PLATE.minHeight()).list.map(G => G.key + ' ' + G.ids.length));
  check('the 20 dots stay on the plate, nothing else', (await card(page)).count === '20 features found' && g5.join() === 'dots 20', g5.join());
  await page.click('#btn-lift');
  await frameOn(page, plateId);
  await page.evaluate(() => { clearSelectionOutline(); state.selectedIndex = -1; state.camera.position.y += 40; state.controls.update(); });
  await shot(page, '2-plate-after-strip');

  /* ======================================== 6. an ordinary piece: Move, Join */
  console.log('\n=== 6. the lifted piece: Move, Join ===');
  const lineId = added5.find(m => /lifted/.test(m.name) && true).id;
  const plantId = added5.find(m => m.id !== lineId).id;
  check('the lifted pieces are in the Pieces list', await page.evaluate(ids => ids.every(id => !!document.querySelector('.model-item[data-edit-id="' + id + '"]')), [lineId, plantId]));
  await selectRow(page, lineId);
  const m6a = await pieceInfo(page, lineId);
  await page.evaluate(() => nudgeSelected(5, 0));
  const m6b = await pieceInfo(page, lineId);
  check('Move: it moves 5 mm across the plate', Math.abs(m6b.x - m6a.x - 5) < 1e-9 && m6b.z === m6a.z, m6a.x.toFixed(2) + ' -> ' + m6b.x.toFixed(2));
  const before6 = await plateState(page);
  const vLine = m6b.volume, vPlant = (await pieceInfo(page, plantId)).volume;
  await page.click('#btn-join-start');
  await page.click('#join-slot-a'); await selectRow(page, plantId);
  await page.click('#join-slot-b'); await selectRow(page, lineId);
  await page.evaluate(([a, b]) => {           // B laid over A, as Join's own slide would
    const pa = state.placed.find(p => p.sourceId === a), i = state.placed.findIndex(p => p.sourceId === b);
    selectPlaced(i); nudgeSelected(pa.x - state.placed[i].x, pa.z - state.placed[i].z);
  }, [plantId, lineId]);
  await page.evaluate(() => { const b = document.getElementById('btn-join'); b.disabled = false; });
  await page.click('#btn-join');
  await page.waitForFunction(() => /Join ok|Join failed|refused/i.test(document.getElementById('status').textContent), null, { timeout: 90000 });
  const s6 = await status(page), a6 = await plateState(page);
  check('Join: the line and the plant join into one piece', /Join ok/.test(s6) && a6.models.length === before6.models.length - 1, s6.slice(0, 160));

  /* ======================================================= 7. back past the strip */
  /* (G-scope's read-only Features row was section 7's other half; it left G-scope
     with the SELECT ticket, docs/GSCOPE-SELECT.md.) */
  console.log('\n=== 7. back past the strip ===');
  let presses = 0;                        // the join, the move, the strip - however many steps each took
  while ((await plateState(page)).undo > b5.undo && presses < 8) { await ctrlZ(page); presses++; }
  const u7 = await raw(page, plateId);
  check('Ctrl+Z back past the strip: the plate bit for bit again', u7.length === SRC.length && u7.every((v, i) => v === SRC[i]), presses + ' presses');

  /* ====================================================== 8. refusals */
  console.log('\n=== 8. refusals in words ===');
  const boxId = await loadSTL(page, BOX_STL);
  await selectRow(page, boxId);
  await page.click('#btn-lift');
  await page.waitForTimeout(200);
  check('a plain box: nothing found, in words', (await card(page)).count === '0 features found' &&
    /^Nothing found on plain-box: nothing stands out of its top more than 0\.32 mm\./.test(await readout(page)), await readout(page));
  await page.click('#btn-lift');
  await page.evaluate(id => { const m = state.models.find(q => q.id === id); m.faceMask = { exclude: [{ axis: 'y', side: 1 }] }; }, plateId);
  await selectRow(page, plateId);
  const u8 = (await plateState(page)).undo;
  await page.click('#btn-lift');
  await page.waitForTimeout(200);
  const r8 = await readout(page);
  check('a painted piece: stood down, in words, nothing read', /^Lift stood down - 1 painted face\(s\) on "barocke-plate"/.test(r8) && (await card(page)).count === '—' &&
    (await plateState(page)).undo === u8, r8);
  await page.click('#btn-lift');
  await page.evaluate(id => { delete state.models.find(q => q.id === id).faceMask; }, plateId);
  await page.evaluate(id => { const m = state.models.find(q => q.id === id); m.__raw = m.rawTris; m.rawTris = null; }, plateId);
  await page.click('#btn-lift');
  await page.waitForTimeout(200);
  check('a piece with no raw soup: refused, in words', /^Lift needs a raw piece - "barocke-plate" has no untransformed soup\. Nothing changed\./.test(await readout(page)), await readout(page));
  await page.click('#btn-lift');
  await page.evaluate(id => { const m = state.models.find(q => q.id === id); m.rawTris = m.__raw; delete m.__raw; }, plateId);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
