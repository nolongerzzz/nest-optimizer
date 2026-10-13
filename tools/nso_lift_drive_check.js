#!/usr/bin/env node
/* Lift, phase 1 - driven through the REAL app in headless Chromium.

     node tools/nso_lift_drive_check.js                exit 0 = every gate held
     node tools/nso_lift_drive_check.js tools/lift-out ...and keep the screenshots
                                                       (npm run lift:shots; gitignored,
                                                       never committed - they go in the PR)

   The fixtures are generated here (tools/nso_lift_fixtures.js) and go in
   through the app's own Import; the Picture slabs are made by Gen+ -> Picture
   from the relief fixtures the relief tests use, and sent to the plate by
   G-scope's Export to plate. Every pick is a real click on G-scope's canvas,
   at the screen point of a triangle G-scope itself drew.

     1. the plate: Pick base face, a click on the top - the plane, 56 details
        coloured by height, the read-out in words
     2. a click chooses the ring, Shift-click adds the cap; Lift. The piece
        keeps its id and becomes the plate: closed, flat where they stood, every
        other triangle bit for bit; two new closed pieces on free plate beside
        it, the ring's bore open; volumes add up; ONE undo step
     3. Ctrl+Z: the piece is bit for bit what it was, both pieces gone, the
        undo stack as before, G-scope redrawn over the plate as it is
     4. the slider: at 0.7 the dots are not offered, and a click on one says
        why in words; back to the default
     5. lift all 56: the top is one flat face again, the volumes add up; one
        Ctrl+Z puts all of it back
     6. a curved face: refused in plain words, nothing on the plate changes
     7. the Picture slab, camera.png and the line-drawing scan: base on the
        paper, the islands offered, lift, closed, undo
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

let fails = 0, passes = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (cond) passes++; else { fails++; FAILED.push(name); }
}

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

/* ---- page helpers ---- */

/* The screen point of a triangle's centroid, as G-scope draws it. */
const screenOfTri = (page, objName, tri) => page.evaluate(([name, t]) => {
  const MS = NSO_MICROSCOPE, d = MS.getDoc(), o = d.objects.find(x => x.name === name || x.sourceId === name);
  if (!o) return null;
  const P = o.positions, c = [0, 0, 0];
  for (let k = 0; k < 3; k++) for (let q = 0; q < 3; q++) c[q] += P[t * 9 + k * 3 + q] / 3;
  const v = MS.getView();
  v.camera.updateMatrixWorld(true);
  const p = MS.toView(c[0], c[1], c[2]).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
}, [objName, tri]);

async function clickTri(page, objName, tri, shift) {
  const at = await screenOfTri(page, objName, tri);
  if (!at) throw new Error('no screen point for ' + objName + ' #' + tri);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(at.x, at.y);
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
}

/* Look down at the piece from above and a little in front - or, side, from
   in front and level with its middle. */
async function frame(page, sourceId, dist, side) {
  await page.evaluate(([sid, dist, side]) => {
    const MS = NSO_MICROSCOPE, d = MS.getDoc(), o = d.objects.find(x => x.sourceId === sid);
    const b = o.bounds, v = MS.getView();
    const c = MS.toView((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, side ? (b.minZ + b.maxZ) / 2 : b.maxZ);
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, side ? b.maxZ - b.minZ : 0);
    v.controls.target.copy(c);
    if (side) v.camera.position.set(c.x, c.y + span * 0.3, c.z + span * (dist || 2));
    else v.camera.position.set(c.x, c.y + span * (dist || 0.8), c.z + span * 0.75);
    v.controls.update();
  }, [sourceId, dist, !!side]);
  await page.waitForTimeout(250);
}

async function shotScope(page, name) {
  await page.evaluate(() => { NSO_MICROSCOPE.flushView(); document.getElementById('ms-lift-row').scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(400);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log('   [screenshot] ' + (KEEP ? path.relative(ROOT, file) : name));
}
async function shotPlate(page, name) {
  await page.evaluate(() => { if (typeof clearSelectionOutline === 'function') clearSelectionOutline(); state.renderer.render(state.scene, state.camera); });
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => { const b = state.renderer.domElement.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, clip: { x: r.x, y: r.y, width: r.w, height: r.h } });
  console.log('   [screenshot] ' + (KEEP ? path.relative(ROOT, file) : name));
}

const readout = page => page.evaluate(() => document.getElementById('ms-lift-read').textContent);
const raw = (page, id) => page.evaluate(id => { const m = state.models.find(q => q.id === id); return m ? Array.from(m.rawTris) : null; }, id);
const plateState = page => page.evaluate(() => ({
  models: state.models.map(m => ({ id: m.id, name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : 0 })),
  placed: state.placed.map(p => ({ id: p.sourceId, x: p.x, z: p.z })),
  undo: state.undoStack.length
}));
/* The app's own view of a piece: closed?, volume, footprint, on the bed? */
const pieceInfo = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), p = state.placed.find(q => q && q.sourceId === id);
  if (!m) return null;
  const c = NSO_Lift.census(m.rawTris);
  const fp = p ? placedFootprint(p) : null;
  const plate = getCurrentPlate();
  const bb = p && p.mesh ? new THREE.Box3().setFromObject(p.mesh) : null;
  return { id, name: m.name, tris: c.tris, closed: c.closed, degen: c.degen, chi: c.chi, volume: NSO_Lift.volume(m.rawTris),
           fp, onBed: fp ? (fp.minx >= -plate.w / 2 - 1e-6 && fp.maxx <= plate.w / 2 + 1e-6 && fp.minz >= -plate.d / 2 - 1e-6 && fp.maxz <= plate.d / 2 + 1e-6) : false,
           yMin: bb ? bb.min.y : null, size: [m.size.x, m.size.y, m.size.z] };
}, id);
const overlap = (a, b) => Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx) > 0.01 && Math.min(a.maxz, b.maxz) - Math.max(a.minz, b.minz) > 0.01;

async function openScopeOnPlate(page) {
  await page.evaluate(() => { if (NSO_MICROSCOPE.isOpen()) NSO_MICROSCOPE.close(); });
  await page.click('#btn-microscope');
  // G-scope reopens on the document it had (Picture's slab, before it was a
  // piece); its sidebar's "Read the plate" is the way back to the plate.
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
  if (await page.evaluate(() => !(NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().source === 'plate'))) await page.click('#ms-btn-plate');
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().source === 'plate', null, { timeout: 30000 });
  await page.waitForTimeout(300);
}
async function liftMode(page, wantOn) {
  const isOn = await page.evaluate(() => NSO_GSCOPE_LIFT.isOn());
  if (isOn !== wantOn) await page.click('#ms-btn-lift-mode');
}
async function ctrlZ(page) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });

  /* =================================================== 1. the plate, the base */
  console.log('\n=== 1. the plate: Pick base face, a click on the top ===');
  const plateId = await loadSTL(page, PLATE_STL);
  const SRC = await raw(page, plateId);
  check('the plate came in through Import as one closed piece', SRC.length / 9 === PL.soup.length / 9, (SRC.length / 9) + ' triangles');
  await openScopeOnPlate(page);
  const rowShown = await page.evaluate(() => getComputedStyle(document.getElementById('ms-lift-row')).display !== 'none');
  check('G-scope\'s sidebar has the Lift section on a mesh document', rowShown);
  const defH = await page.evaluate(() => [NSO_GSCOPE_LIFT.minHeight(), document.getElementById('ms-lift-height').value,
    document.getElementById('ms-lift-height-read').textContent, NSO_Thickness.floorFor(0.4)]);
  check('"How far out counts" starts at NSO_Thickness.floorFor(0.4) = 0.42 mm', defH[0] === 0.42 && +defH[1] === 0.42 && defH[2] === '0.42 mm' && defH[3] === 0.42, defH.join(' / '));
  await liftMode(page, true);
  check('Pick base face arms the mode', await page.evaluate(() => NSO_GSCOPE_LIFT.isOn() &&
    document.getElementById('ms-btn-lift-mode').getAttribute('aria-pressed') === 'true'));
  const objName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, plateId);
  await frame(page, plateId);
  await shotScope(page, '1-plate-in-gscope');
  await frame(page, plateId, 1.8);
  await clickTri(page, objName, T_TOP);
  const A1 = await page.evaluate(() => {
    const A = NSO_GSCOPE_LIFT.analysis();
    return A ? { n: A.plane.n, d: A.plane.d, islands: A.islands.length, ok: A.liftable, offered: NSO_GSCOPE_LIFT.offered().length,
      area: A.base.areaMm2, layer: NSO_GSCOPE_LIFT.layer().children.length } : null;
  });
  const r1 = await readout(page);
  check('a real click on the top picks it: the plane is z = 3', A1 && A1.n[2] === 1 && A1.d === 3, A1 && ('n ' + A1.n + ' d ' + A1.d));
  check('56 details stand on it, all offered at 0.42', A1 && A1.islands === 56 && A1.offered === 56, A1 && (A1.islands + ' / ' + A1.offered));
  check('they are drawn over the piece: the base tinted, the details by height', A1 && A1.layer >= 2, A1 && (A1.layer + ' overlay meshes'));
  check('the read-out says it in words', /Base: the top face at z 3\.00/.test(r1) && /56 details stand out more than 0\.42 mm \(0\.50 - 1\.50 mm\)/.test(r1), r1);
  await frame(page, plateId);
  await shotScope(page, '2-plate-base-picked');
  await frame(page, plateId, 1.8);

  /* =========================================== 2. choose the ring and the cap, Lift */
  console.log('\n=== 2. a click chooses the ring, Shift-click adds the cap, Lift ===');
  await clickTri(page, objName, T_RING);
  let ch = await page.evaluate(() => NSO_GSCOPE_LIFT.chosen().map(id => NSO_GSCOPE_LIFT.analysis().islands[id].loops.length));
  check('a click on the ring chooses the ring alone', ch.length === 1 && ch[0] === 2, JSON.stringify(ch));
  await clickTri(page, objName, T_CAP, true);
  ch = await page.evaluate(() => NSO_GSCOPE_LIFT.chosen().map(id => +NSO_GSCOPE_LIFT.analysis().islands[id].heightMm.toFixed(3)).sort());
  check('Shift-click on the cap adds it', ch.length === 2 && ch.indexOf(1.5) >= 0 && ch.indexOf(0.8) >= 0, JSON.stringify(ch));
  const liftBtn = await page.evaluate(() => { const b = document.getElementById('ms-btn-lift'); return [b.disabled, b.textContent]; });
  check('the Lift button is ready and counts them', !liftBtn[0] && liftBtn[1] === 'Lift 2', liftBtn.join(' '));
  await frame(page, plateId);
  await shotScope(page, '3-plate-ring-and-cap-chosen');
  const before = await plateState(page);
  await page.click('#ms-btn-lift');
  await page.waitForFunction(() => /Lifted|refused|failed/.test(document.getElementById('ms-lift-read').textContent), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const after = await plateState(page);
  const r2 = await readout(page);
  check('Lift says what it did, and that one Undo puts it back', /^Lifted 2 details off/.test(r2) && /One Undo \(Ctrl\+Z\) puts it all back/.test(r2), r2.slice(0, 200));
  const added = after.models.filter(m => !before.models.some(b => b.id === m.id));
  check('two new pieces, named after the piece they came off', added.length === 2 && added.every(m => /^lift-plate - lifted \d+$/.test(m.name)), added.map(m => m.name).join(', '));
  check('the original piece kept its id and is still the one on the plate', after.models.some(m => m.id === plateId) && after.placed.some(p => p.id === plateId));
  check('exactly ONE undo step was pushed', after.undo === before.undo + 1, before.undo + ' -> ' + after.undo);
  const LEFT = await raw(page, plateId);
  const hostInfo = await pieceInfo(page, plateId);
  check('the plate is closed and manifold', hostInfo.closed && hostInfo.degen === 0, hostInfo.tris + ' tris, chi ' + hostInfo.chi);
  // every triangle not lifted is the source's, in order, bit for bit; what is new lies flat in z = 3, facing up
  const srcT = SRC.length / 9, leftT = LEFT.length / 9;
  let k = 0, same = 0;
  for (let t = 0; t < srcT && k < leftT; t++) {
    let eq = true;
    for (let q = 0; q < 9; q++) if (SRC[t * 9 + q] !== LEFT[k * 9 + q]) { eq = false; break; }
    if (eq) { k++; same++; }
  }
  let flatNew = true;
  for (let t = k; t < leftT; t++) for (let q = 0; q < 3; q++) if (LEFT[t * 9 + q * 3 + 2] !== 3) flatNew = false;
  const ringT = PL.truth.find(t => t.kind === 'ring'), capT = PL.truth.find(t => t.kind === 'cap');
  check('every triangle it kept is the source\'s, in order, bit for bit', same === srcT - ringT.tris - capT.tris,
    same + ' of ' + srcT + ' kept; ' + (ringT.tris + capT.tris) + ' lifted');
  check('everything new on it lies flat in z = 3: flat where they stood', flatNew && leftT - k > 0, (leftT - k) + ' new triangles');
  const pcs = [];
  for (const m of added) pcs.push(await pieceInfo(page, m.id));
  const ringPc = pcs.find(p => p.chi === 0), capPc = pcs.find(p => p.chi === 2);
  check('both lifted pieces are closed and manifold', pcs.every(p => p.closed && p.degen === 0), pcs.map(p => p.tris + ' tris chi ' + p.chi).join('; '));
  check('the ring lifted as a ring: its bore open (chi 0)', !!ringPc);
  check('the volumes add up: plate + pieces = the original', Math.abs(hostInfo.volume + pcs.reduce((s, p) => s + p.volume, 0) - (10800 + PL.truth.reduce((s, t) => s + t.volume, 0))) < 1e-6 * 10903,
    hostInfo.volume.toFixed(3) + ' + ' + pcs.map(p => p.volume.toFixed(3)).join(' + '));
  check('...each piece is the volume the generator built', ringPc && capPc && Math.abs(ringPc.volume - ringT.volume) < 1e-5 && Math.abs(capPc.volume - capT.volume) < 1e-5,
    ringPc && capPc ? ringPc.volume.toFixed(4) + ' / ' + capPc.volume.toFixed(4) : '');
  const hostFp = await page.evaluate(id => placedFootprint(state.placed.find(p => p.sourceId === id)), plateId);
  check('each new piece sits on the bed (settlePlacedOnBed\'s 0.2), on free plate, clear of the plate and of each other',
    pcs.every(p => p.onBed && Math.abs(p.yMin - 0.2) < 1e-6 && !overlap(p.fp, hostFp)) && !overlap(pcs[0].fp, pcs[1].fp),
    pcs.map(p => 'x ' + ((p.fp.minx + p.fp.maxx) / 2).toFixed(1) + ' z ' + ((p.fp.minz + p.fp.maxz) / 2).toFixed(1) + ' bottom ' + p.yMin.toFixed(3)).join('; '));
  check('...beside it: nearer the plate piece than the far side of the bed', pcs.every(p => {
    const cx = (p.fp.minx + p.fp.maxx) / 2, cz = (p.fp.minz + p.fp.maxz) / 2, hx = (hostFp.minx + hostFp.maxx) / 2, hz = (hostFp.minz + hostFp.maxz) / 2;
    return Math.hypot(cx - hx, cz - hz) < 60;
  }));
  const A2 = await page.evaluate(() => { const A = NSO_GSCOPE_LIFT.analysis(); return A ? [A.islands.length, NSO_GSCOPE_LIFT.offered().length] : null; });
  check('G-scope re-read the plate and the base stays picked: 54 details left', A2 && A2[0] === 54 && A2[1] === 54, JSON.stringify(A2));
  await frame(page, plateId, 1.1);
  await shotScope(page, '4-plate-after-lift-gscope');
  await page.evaluate(() => NSO_MICROSCOPE.close());
  await page.waitForTimeout(200);
  await shotPlate(page, '5-plate-after-lift-plate');
  await openScopeOnPlate(page);

  /* =================================================== 3. Undo */
  console.log('\n=== 3. one Ctrl+Z ===');
  await ctrlZ(page);
  const undone = await plateState(page);
  const BACK = await raw(page, plateId);
  check('the piece is bit for bit what it was', BACK.length === SRC.length && BACK.every((v, i) => v === SRC[i]));
  check('both lifted pieces are gone, from the list and the plate', undone.models.length === before.models.length && undone.placed.length === before.placed.length);
  check('the undo stack is back where it was', undone.undo === before.undo, undone.undo + '');
  const A3 = await page.evaluate(() => { const A = NSO_GSCOPE_LIFT.analysis(); return A ? A.islands.length : null; });
  check('G-scope is redrawn over the plate as it is now: 56 details again', A3 === 56, A3 + '');
  check('...and says so', /Undo: Lift reverted/.test(await readout(page)), await readout(page));

  /* =================================================== 4. the slider */
  console.log('\n=== 4. "How far out counts" ===');
  await page.evaluate(() => { const s = document.getElementById('ms-lift-height'); s.value = '0.7'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  const off7 = await page.evaluate(() => NSO_GSCOPE_LIFT.offered().map(id => +NSO_GSCOPE_LIFT.analysis().islands[id].heightMm.toFixed(2)).sort());
  check('at 0.70 only the ring (0.8) and the cap (1.5) are offered', JSON.stringify(off7) === '[0.8,1.5]', JSON.stringify(off7));
  check('the read-out says how many are lower', /2 details stand out more than 0\.70 mm/.test(await readout(page)) && /54 lower, not offered/.test(await readout(page)), await readout(page));
  await frame(page, plateId);
  await shotScope(page, '6-plate-slider-0.70');
  await frame(page, plateId, 1.8);
  await clickTri(page, objName, T_DOT);
  const rDot = await readout(page);
  check('a click on a 0.6 mm dot says why it is not offered', /stands out only 0\.60 mm, not more than 0\.70 mm/.test(rDot) &&
    (await page.evaluate(() => NSO_GSCOPE_LIFT.chosen().length)) === 0, rDot);
  await page.evaluate(() => { const s = document.getElementById('ms-lift-height'); s.value = '0.42'; s.dispatchEvent(new Event('input', { bubbles: true })); });

  /* =================================================== 5. lift all */
  console.log('\n=== 5. lifting all 56 ===');
  const b5 = await plateState(page);
  const all = await page.evaluate(() => { const r = NSO_GSCOPE_LIFT.lift(NSO_GSCOPE_LIFT.offered()); return { ok: r.ok, n: r.addedIds && r.addedIds.length, reason: r.reason, off: r.spots && r.spots.filter(s => !s.onBed).length }; });
  check('all 56 lift, through the same path as the button', all.ok && all.n === 56, all.reason && all.reason.slice(0, 120));
  const flat = await page.evaluate(([id, seed]) => {
    const m = state.models.find(q => q.id === id), A = NSO_Lift.analyse(m.rawTris, seed);
    return { ok: A.ok, islands: A.islands.length, area: A.base.areaMm2, vol: NSO_Lift.volume(m.rawTris), c: NSO_Lift.census(m.rawTris) };
  }, [plateId, T_TOP < 0 ? 0 : (await page.evaluate(() => NSO_GSCOPE_LIFT.analysis() ? NSO_GSCOPE_LIFT.analysis().seed : -1))]);
  check('the plate\'s top is one flat face again: 3600 mm^2, nothing on it', flat.ok && flat.islands === 0 && Math.abs(flat.area - 3600) < 1e-6, JSON.stringify({ i: flat.islands, a: flat.area }));
  const a5 = await plateState(page);
  const newIds = a5.models.filter(m => !b5.models.some(b => b.id === m.id)).map(m => m.id);
  let vSum = 0, allClosed = true;
  for (const id of newIds) { const p = await pieceInfo(page, id); vSum += p.volume; if (!p.closed) allClosed = false; }
  check('all 56 pieces are closed', allClosed && newIds.length === 56);
  check('plate + 56 pieces = the original, to float32 tolerance', Math.abs(flat.vol + vSum - (10800 + PL.truth.reduce((s, t) => s + t.volume, 0))) < 1e-6 * 10903,
    flat.vol.toFixed(3) + ' + ' + vSum.toFixed(3));
  check('one undo step for all of it', a5.undo === b5.undo + 1);
  await page.evaluate(() => NSO_MICROSCOPE.close());
  await page.evaluate(() => { if (typeof framePlateHome === 'function') framePlateHome(); });
  await page.waitForTimeout(300);
  await shotPlate(page, '7-plate-all-lifted');
  await openScopeOnPlate(page);
  await ctrlZ(page);
  const u5 = await plateState(page);
  const BACK5 = await raw(page, plateId);
  check('one Ctrl+Z puts all of it back', u5.models.length === b5.models.length && u5.undo === b5.undo &&
    BACK5.length === SRC.length && BACK5.every((v, i) => v === SRC[i]));

  /* =================================================== 6. a curved face */
  console.log('\n=== 6. a curved face ===');
  await page.evaluate(() => NSO_MICROSCOPE.close());
  const cylId = await loadSTL(page, CYL_STL);
  const CYL = await raw(page, cylId);
  let sideTri = -1;
  // a side facet facing the camera (world -Y, which G-scope draws toward the viewer)
  for (let t = 0; t < CYL.length / 9 && sideTri < 0; t++) {
    const o = t * 9, ny = (CYL[o + 5] - CYL[o + 2]) * (CYL[o + 6] - CYL[o]) - (CYL[o + 3] - CYL[o]) * (CYL[o + 8] - CYL[o + 2]);
    const cx = (CYL[o] + CYL[o + 3] + CYL[o + 6]) / 3, cy = (CYL[o + 1] + CYL[o + 4] + CYL[o + 7]) / 3;
    if (Math.abs(CYL[o + 2] - CYL[o + 8]) + Math.abs(CYL[o + 2] - CYL[o + 5]) > 1 && cy < -9 && Math.abs(cx) < 2 && ny < 0) sideTri = t;
  }
  await openScopeOnPlate(page);
  await liftMode(page, true);
  const cylName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, cylId);
  const b6 = await plateState(page);
  const hostBefore = await page.evaluate(() => NSO_GSCOPE_LIFT.host());
  await frame(page, cylId, 2.2, true);
  await clickTri(page, cylName, sideTri);
  const r6 = await readout(page);
  check('a click on the cylinder\'s side is refused in plain words', /Lift needs a flat face, and this one is curved/.test(r6) && /Nothing changed/.test(r6), r6);
  const a6 = await plateState(page);
  check('...and nothing changes: same pieces, same undo stack, the base picked before still picked',
    JSON.stringify(a6) === JSON.stringify(b6) && JSON.stringify(await page.evaluate(() => NSO_GSCOPE_LIFT.host())) === JSON.stringify(hostBefore));
  await shotScope(page, '8-curved-refused');
  await page.evaluate(() => NSO_MICROSCOPE.close());
  // off the plate: the cylinder and the plate go, the slabs come next
  await page.evaluate(ids => { ids.forEach(id => { const i = state.placed.findIndex(p => p.sourceId === id); if (i >= 0) { state.placed[i].mesh.parent.remove(state.placed[i].mesh); state.placed.splice(i, 1); } }); state.models = state.models.filter(m => ids.indexOf(m.id) < 0); state.placed.forEach((p, i) => { p.mesh.userData.placedIndex = i; }); }, [cylId, plateId]);

  /* =================================================== 7. the Picture slab */
  for (const [file, card, label] of [['camera.png', { width: 40, detail: 0.4, levels: '2' }, 'photo'],
                                     ['line-drawing-scan.jpg', { width: 60, detail: 0.4, levels: '2' }, 'scan']]) {
    console.log('\n=== 7. the Picture slab: ' + file + ' (' + label + '), Levels ' + card.levels + ', ' + card.width + ' mm at ' + card.detail + ' ===');
    await page.evaluate(() => { const g = document.getElementById('menu-gen'); g.open = true; document.getElementById('menu-relief').open = true; });
    await page.setInputFiles('#relief-file', path.join(ROOT, 'fixtures', 'relief', file));
    await page.waitForFunction(w => { const q = window.nsoReliefPicture(); return q && q.name === w; }, file, { timeout: 60000 });
    await page.fill('#inp-relief-width', String(card.width));
    await page.fill('#inp-relief-detail', String(card.detail));
    await page.selectOption('#sel-relief-levels', card.levels);
    await page.evaluate(() => window.nsoReliefMake());
    const slabId = await page.evaluate(() => {
      const d = NSO_MICROSCOPE.getDoc();
      NSO_MICROSCOPE.selectObjects([d.objects[0].name]);
      return NSO_MICROSCOPE.exportToPlate();
    });
    await page.evaluate(() => { document.querySelectorAll('details[open]').forEach(d => { d.open = false; }); });
    check(label + ': the slab is on the plate, through G-scope\'s Export to plate', slabId != null);
    const SL = await raw(page, slabId);
    // a paper triangle (z = 2, facing up) near the top middle
    const sw = card.width;
    let paper = -1, bd = Infinity;
    for (let t = 0; t < SL.length / 9; t++) {
      if (!(SL[t * 9 + 2] === 2 && SL[t * 9 + 5] === 2 && SL[t * 9 + 8] === 2)) continue;
      const o = t * 9, nz = (SL[o + 3] - SL[o]) * (SL[o + 7] - SL[o + 1]) - (SL[o + 4] - SL[o + 1]) * (SL[o + 6] - SL[o]);
      if (nz <= 0) continue;
      const cx = (SL[o] + SL[o + 3] + SL[o + 6]) / 3, cy = (SL[o + 1] + SL[o + 4] + SL[o + 7]) / 3;
      const dd = Math.hypot(cx - sw / 2, cy - sw * 0.85 * (label === 'scan' ? 0.75 : 1));
      if (dd < bd) { bd = dd; paper = t; }
    }
    await openScopeOnPlate(page);
    await liftMode(page, true);
    const sName = await page.evaluate(id => NSO_MICROSCOPE.getDoc().objects.find(o => o.sourceId === id).name, slabId);
    await frame(page, slabId, 0.85);
    await shotScope(page, '9-' + label + '-slab-in-gscope');
    await frame(page, slabId, 1.8);                  // aim from above: nothing raised hides the paper
    await clickTri(page, sName, paper);
    const SA = await page.evaluate(() => {
      const A = NSO_GSCOPE_LIFT.analysis();
      if (!A) return null;
      const st = {};
      A.islands.forEach(I => { st[I.status] = (st[I.status] || 0) + 1; });
      return { d: A.plane.d, tol: A.plane.tolMm, n: A.plane.n, st, offered: NSO_GSCOPE_LIFT.offered(), heights: NSO_GSCOPE_LIFT.offered().map(id => A.islands[id].heightMm),
               tris: NSO_GSCOPE_LIFT.offered().map(id => A.islands[id].triangles) };
    });
    const rs = await readout(page);
    check(label + ': a click on the paper picks the base at z = 2 (to the plane\'s tolerance)', SA && Math.abs(SA.d - 2) <= SA.tol && SA.n[2] === 1, rs + ' (d ' + (SA && SA.d) + ')');
    check(label + ': what runs down the slab\'s sides is part of the body, said in words', SA && (!SA.st.edge || /over the edge of the face: part of the body/.test(rs)), JSON.stringify(SA && SA.st));
    check(label + ': details are offered, each standing out more than 0.42 mm', SA && SA.offered.length > 0 && SA.heights.every(h => h > 0.42),
      SA && (SA.offered.length + ' offered, up to ' + Math.max(...SA.heights).toFixed(2) + ' mm'));
    await frame(page, slabId, 0.85);
    await shotScope(page, '10-' + label + '-slab-base-picked');
    await frame(page, slabId, 1.8);
    // the biggest few, by a real click and Shift-clicks on each
    const order = SA.offered.map((id, i) => ({ id, tris: SA.tris[i] })).sort((a, b) => b.tris - a.tris).slice(0, label === 'scan' ? 4 : 2);
    for (let i = 0; i < order.length; i++) {
      const tri = await page.evaluate(id => {
        const A = NSO_GSCOPE_LIFT.analysis(), I = A.islands[id];
        // the island's highest-facing triangle: the one a camera above sees
        let best = I.tris[0], bz = -Infinity;
        const M = A.M;
        I.tris.forEach(t => { const z = (M.V[M.tv[t * 3]][2] + M.V[M.tv[t * 3 + 1]][2] + M.V[M.tv[t * 3 + 2]][2]) / 3; if (z > bz && M.n[t * 3 + 2] > 0.5) { bz = z; best = t; } });
        return best;
      }, order[i].id);
      await clickTri(page, sName, tri, i > 0);
    }
    const sch = await page.evaluate(() => NSO_GSCOPE_LIFT.chosen().slice().sort((a, b) => a - b));
    check(label + ': the chosen islands are the ones clicked', JSON.stringify(sch) === JSON.stringify(order.map(o => o.id).sort((a, b) => a - b)), JSON.stringify(sch));
    await frame(page, slabId, 0.85);
    await shotScope(page, '11-' + label + '-slab-chosen');
    const sb = await plateState(page);
    const S0 = await raw(page, slabId);
    await page.click('#ms-btn-lift');
    await page.waitForFunction(() => /Lifted|refused|failed/.test(document.getElementById('ms-lift-read').textContent), null, { timeout: 120000 });
    const sa = await plateState(page);
    const sNew = sa.models.filter(m => !sb.models.some(b => b.id === m.id));
    const sHost = await pieceInfo(page, slabId);
    let sv = 0, sClosed = true;
    for (const m of sNew) { const p = await pieceInfo(page, m.id); sv += p.volume; if (!p.closed || !p.onBed) sClosed = false; }
    const v0 = await page.evaluate(s => NSO_Lift.volume(new Float32Array(s)), S0);
    check(label + ': Lift made one closed piece per island, each on the bed', sNew.length === order.length && sClosed, sNew.length + ' pieces');
    check(label + ': the slab stays closed and the volumes add up', sHost.closed && Math.abs(sHost.volume + sv - v0) < 1e-6 * v0,
      sHost.volume.toFixed(3) + ' + ' + sv.toFixed(3) + ' = ' + v0.toFixed(3));
    await frame(page, slabId, 0.85);
    await shotScope(page, '12-' + label + '-slab-after-lift');
    await page.evaluate(() => NSO_MICROSCOPE.close());
    await page.evaluate(() => { if (typeof framePlateHome === 'function') framePlateHome(); });
    await shotPlate(page, '13-' + label + '-plate-after-lift');
    await openScopeOnPlate(page);
    await ctrlZ(page);
    const S1 = await raw(page, slabId);
    const su = await plateState(page);
    check(label + ': one Ctrl+Z puts the slab back bit for bit and takes the pieces off',
      S1.length === S0.length && S1.every((v, i) => v === S0[i]) && su.models.length === sb.models.length && su.undo === sb.undo);
    await page.evaluate(() => NSO_MICROSCOPE.close());
    await page.evaluate(id => { const i = state.placed.findIndex(p => p.sourceId === id); if (i >= 0) { state.placed[i].mesh.parent.remove(state.placed[i].mesh); state.placed.splice(i, 1); } state.models = state.models.filter(m => m.id !== id); }, slabId);
  }

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (fails) { console.log('FAILED: ' + FAILED.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
