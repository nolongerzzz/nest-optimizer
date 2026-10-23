#!/usr/bin/env node
/* Shells as pieces - driven through the REAL app in headless Chromium at 1280 x 800.

     node tools/nso_shells_drive.js                      exit 0 = every gate held
     node tools/nso_shells_drive.js some/other/dir       ...screenshots there instead
   (npm run shells:drive; screenshots go to tools/shells-out/)

   Every press is a real click on the real control, every hover and click on a piece a real pointer move and press.

     A. box_closed (library/box_closed.stl: a tray and a lid laid through each other, 74 piercing pairs)
        Split to parts -> 2 pieces, each with no piercing pair, every triangle where the original drew it; Undo
     B. Lift armed on box_closed: "2 shells found"; hover the lid -> the whole lid is outlined; click -> the lid is out
        intact, the box left whole, nothing moved, no cut; one Undo puts it back, bit for bit, in place
     C. Check & Repair > Findings: SPLIT SHELLS beside MERGE SHELLS on the overlapping-shells row (screenshot); SPLIT
        SHELLS makes the very pieces Split to parts does and the check passes on both; one Undo; MERGE SHELLS unchanged
     D. a hollow box: "1 part", Lift reads it exactly as it always did (shells off or on, the same words)
     E. a piece with a free second shell: Split -> 2 pieces; Lift reads 2 shells
     F. Export: the two overlapping pieces -> the one line (STL and 3MF), the file still written; moved apart -> the
        status line is what it always was
     G. the vase (generated: a lathe body with a handle shell through its wall; tools/fixtures-local/ has the user's own,
        used when NSO_SHELLS_VASE or tools/fixtures-local/vase.stl|3mf is there): Lift on the handle -> handle out
        intact, body left whole; the time of that lift against the time of the arm as it was (reported) */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, openMenuFor, openFinishMenu, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const SX = require('./nso_shells_fixtures.js');
const FX = require('./nso_split_parts_fixtures.js');
const L = require('./nso_lift_plate_drive_lib.js');
const { plateState, ctrlZ, selectRow, raw, sameSoup } = L;
const C = L.makeCheck(), check = C.check;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-shells-drive-'));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'tools', 'shells-out');
fs.mkdirSync(OUT, { recursive: true });
const shot = L.shooter(OUT, true, ROOT).plate;

const BOX_STL = path.join(ROOT, 'library', 'box_closed.stl');
const HOLLOW_STL = path.join(ROOT, 'fixtures', 'box_cavity_30.stl');
const TWO_STL = path.join(TMP, 'two-bodies.stl'); writeSTL(TWO_STL, SX.twoBodies().soup);
const VASE_STL = path.join(TMP, 'vase.stl');
const VASE = SX.vase({ segs: 600, rings: 150, nU: 200, nV: 36 });
writeSTL(VASE_STL, VASE.soup);
const LOCAL = ['vase.stl', 'vase.3mf', 'boolean-vase.3mf'].map(f => path.join(ROOT, 'tools', 'fixtures-local', f)).concat(process.env.NSO_SHELLS_VASE || []).filter(f => fs.existsSync(f))[0];

/* A piece's triangles as drawn in the world, each as a sorted list of its corners to 1e-3 mm: positions, compared as sets. */
const worldSet = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id);
  if (!p) return null;
  p.mesh.updateMatrixWorld(true);
  const P = p.mesh.geometry.attributes.position.array, out = [], v = new THREE.Vector3();
  for (let t = 0; t < P.length / 9; t++) {
    const c = [0, 1, 2].map(k => { v.set(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]).applyMatrix4(p.mesh.matrixWorld); return v.x.toFixed(3) + ',' + v.y.toFixed(3) + ',' + v.z.toFixed(3); });
    out.push(c.sort().join('|'));
  }
  return out;
}, id);
const sameSet = (a, b) => { if (!a || !b || a.length !== b.length) return false; const s = a.slice().sort(), t = b.slice().sort(); return s.every((x, i) => x === t[i]); };
const report = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), r = NSO_Defects.locate(m.rawTris, {});
  return { pierce: r.pierce, overlapShells: r.overlapShells, verdict: r.verdict, tris: m.rawTris.length / 9, closed: NSO_Lift.census(m.rawTris).closed };
}, id);
const info = (page, id) => L.pieceInfo(page, id);
/* A piece's soup as one number-and-length pair (FNV-1a over its bytes), so a 3 M-float vase is compared without crossing the wire. */
const soupSig = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), u = new Uint32Array(m.rawTris.buffer, m.rawTris.byteOffset, m.rawTris.length);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h + ':' + u.length;
}, id);
const liftCard = page => page.evaluate(() => ({ count: document.getElementById('lift-count').textContent, read: document.getElementById('lift-readout').textContent }));
const splitCard = page => page.evaluate(() => ({ count: document.getElementById('split-count').textContent, read: document.getElementById('split-readout').textContent }));

async function frame(page, id, dir, up) {
  await page.evaluate(([id, dir, up]) => {
    const p = state.placed.find(q => q && q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, bb.max.y - bb.min.y);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + dir[0] * span, c.y + up * span, c.z + dir[1] * span);
    state.controls.update();
  }, [id, dir, up]);
  await page.waitForTimeout(250);
}
/* A raw triangle of shell `sid` of the armed piece that the app's own raycast finds from the camera (so a real pointer on it hits it). */
const visibleTriOfShell = (page, id, sid) => page.evaluate(([id, sid]) => {
  const S = NSO_LIFT_PLATE.shells(), p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array;
  p.mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
  const rect = state.renderer.domElement.getBoundingClientRect(), rc = new THREE.Raycaster(), step = Math.max(1, Math.floor(S.shells[sid].faces.length / 400));
  for (let i = 0; i < S.shells[sid].faces.length; i += step) {
    const t = S.shells[sid].faces[i], c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(new THREE.Vector3(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]));
    c.multiplyScalar(1 / 3).applyMatrix4(p.mesh.matrixWorld);
    const q = c.clone().project(state.camera);
    if (Math.abs(q.x) > 0.9 || Math.abs(q.y) > 0.9) continue;
    const x = rect.left + (q.x + 1) / 2 * rect.width, y = rect.top + (1 - q.y) / 2 * rect.height;
    if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
    rc.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
    const hit = rc.intersectObjects(state.modelGroup.children, true).find(h => h.faceIndex != null);
    if (hit && hit.object === p.mesh && hit.faceIndex === t) return t;
  }
  return -1;
}, [id, sid]);

async function armShells(page, id) {
  if (await page.evaluate(() => NSO_LIFT_PLATE.isArmed())) await page.click('#btn-lift');
  await selectRow(page, id);
  const t0 = Date.now();
  await page.click('#btn-lift');
  await page.waitForFunction(() => /(features?|shells) found|nothing read|—/.test(document.getElementById('lift-count').textContent), null, { timeout: 600000 });
  return { ms: Date.now() - t0, card: await liftCard(page) };
}
const waitLifted = (page, ms) => page.waitForFunction(() => /^Lifted|^Lift (refused|failed)/.test(document.getElementById('lift-readout').textContent), null, { timeout: ms || 600000 });

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  page.on('dialog', d => d.accept().catch(() => {}));
  const readStl = p => { const b = fs.readFileSync(p), n = b.readUInt32LE(80), a = new Float32Array(n * 9); for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) a[i * 9 + k] = b.readFloatLE(84 + i * 50 + 12 + k * 4); return a; };
  const boxRaw = readStl(BOX_STL);
  const fresh = async (stl) => { const s0 = await plateState(page); await page.evaluate(() => { if (NSO_LIFT_PLATE.isArmed()) document.getElementById('btn-lift').click(); }); const ids = s0.models.map(m => m.id); if (ids.length) await L.dropPieces(page, ids); const id = await loadSTL(page, stl); await page.waitForFunction(i => state.placed.some(p => p && p.sourceId === i), id, { timeout: 120000 }); return id; };

  console.log('\n=== A. box_closed: Split to parts ===');
  let boxId = await loadSTL(page, BOX_STL);
  await selectRow(page, boxId);
  await page.waitForFunction(() => /^\d+ parts?$/.test(document.getElementById('split-count').textContent), null, { timeout: 15000 });
  await openMenuFor(page, '#btn-split-parts');
  const c1 = await splitCard(page);
  check('the card reads "2 parts" before the button is pressed', c1.count === '2 parts', JSON.stringify(c1));
  const w0 = await worldSet(page, boxId), raw0 = await raw(page, boxId), S0 = await plateState(page);
  const i0 = await info(page, boxId);
  await page.click('#btn-split-parts');
  await page.waitForFunction(() => /^Split /.test(document.getElementById('split-readout').textContent), null, { timeout: 15000 });
  const S1 = await plateState(page), parts = S1.models.filter(m => /^box_closed part \d$/.test(m.name));
  check('2 pieces, "box_closed part 1" and "part 2"; the original is gone', parts.length === 2 && !S1.models.some(m => m.id === boxId), S1.models.map(m => m.name).join(' | '));
  const reps = [];
  for (const p of parts) reps.push(await report(page, p.id));
  check('each piece has 0 piercings (the whole had 74), and passes Check', reps.every(r => r.pierce === 0 && r.verdict === 'PASS'), JSON.stringify(reps));
  check('68 + 12 triangles, both closed', parts.map(p => p.tris).join() === '68,12' && reps.every(r => r.closed));
  const wa = (await worldSet(page, parts[0].id)).concat(await worldSet(page, parts[1].id));
  check('positions unchanged: the two pieces together are the original, triangle for triangle, as drawn in the world', sameSet(wa, w0));
  check('the readout says why', /2 shells that crossed another now a piece of its own/.test((await splitCard(page)).read), (await splitCard(page)).read);
  await shot(page, 'A-split-to-parts');
  await ctrlZ(page);
  const S2 = await plateState(page);
  check('one Undo: the original is back, bit for bit, in place', S2.models.some(m => m.id === boxId) && S2.models.length === S0.models.length && sameSoup(await raw(page, boxId), raw0) && sameSet(await worldSet(page, boxId), w0));

  console.log('\n=== B. Lift armed on box_closed: the lid comes out whole ===');
  await frame(page, boxId, [0.2, 0.9], 0.9);
  const arm = await armShells(page, boxId);
  console.log('  arm: ' + arm.ms + ' ms');
  check('the card says "2 shells found"', arm.card.count === '2 shells found', arm.card.count);
  check('the readout names the shells and what a click does', /^2 shells on box_closed \(68 \+ 12 triangles\), laid through each other\./.test(arm.card.read) && /whole shell/.test(arm.card.read), arm.card.read);
  check('no height map ran: the read is the shells\'', await page.evaluate(() => NSO_LIFT_PLATE.analysis() === null && !!NSO_LIFT_PLATE.shells()));
  const lidTri = await visibleTriOfShell(page, boxId, 1);
  check('a lid face is in view', lidTri >= 0, String(lidTri));
  await L.hoverTri(page, boxId, lidTri);
  const hv = await page.evaluate(() => ({ shell: NSO_LIFT_PLATE.hoverShell(), read: document.getElementById('lift-readout').textContent, layer: NSO_LIFT_PLATE.layer().children.length }));
  check('hovering the lid outlines the whole lid (shell 2) and says so', hv.shell === 1 && hv.layer >= 2 && /^Shell 2 of 2: 12 triangles, laid through shell 1 - click to lift it out whole, no cut\./.test(hv.read), JSON.stringify(hv));
  await shot(page, 'B-lid-hovered');
  await L.clickTri(page, boxId, lidTri);
  await waitLifted(page, 60000);
  const S3 = await plateState(page), lid = L.added(S0, S3)[0];
  const lidInfo = lid && await info(page, lid.id), boxInfo = await info(page, boxId), lidRep = lid && await report(page, lid.id), boxRep = await report(page, boxId);
  check('the lid is out as a piece of 12 triangles, closed, intact', !!lid && lid.tris === 12 && lidInfo.closed && lidInfo.degen === 0 && lidRep.pierce === 0, JSON.stringify(lidInfo && { tris: lidInfo.tris, closed: lidInfo.closed }));
  check('the box is left whole: 68 triangles, closed, no piercing', boxInfo.tris === 68 && boxInfo.closed && boxRep.pierce === 0 && boxRep.verdict === 'PASS');
  const boxFaces = await raw(page, boxId), lidFaces = lid && await raw(page, lid.id);
  const eng = require('../nso_shells.js').shells(boxRaw);
  check('no cut: both are the original\'s triangles, bit for bit', sameSoup(boxFaces, Array.from(eng.shells[0].faces.flatMap(f => Array.from(boxRaw.slice(f * 9, f * 9 + 9))))) &&
    sameSoup(lidFaces, Array.from(eng.shells[1].faces.flatMap(f => Array.from(boxRaw.slice(f * 9, f * 9 + 9))))));
  const wl = (await worldSet(page, boxId)).concat(lid ? await worldSet(page, lid.id) : []);
  check('nothing moved: the box and the lid are where the box_closed drew them', sameSet(wl, w0));
  const msg = await page.evaluate(() => document.getElementById('status').textContent);
  check('the status line says a whole shell, no cut', /^Lifted shell 2 of box_closed out whole \(12 triangles/.test(msg) && /no cut and no face region/.test(msg), msg.slice(0, 120));
  await shot(page, 'B-lid-lifted');
  await ctrlZ(page);
  const S4 = await plateState(page);
  check('one Undo: the lid is gone, the box is the original, bit for bit, in place', S4.models.length === S0.models.length && sameSoup(await raw(page, boxId), raw0) && sameSet(await worldSet(page, boxId), w0) && S4.undo === S0.undo);
  await page.click('#btn-lift');                                                // Lift off

  console.log('\n=== C. Check & Repair > Findings: SPLIT SHELLS beside MERGE SHELLS ===');
  await selectRow(page, boxId);
  await openFinishMenu(page);
  await page.click('#btn-check-defects');
  await page.waitForFunction(i => window.nsoDefectsShownFor() === i && nsoFindingsState().modelId === i, boxId, { timeout: 60000 });
  const row = await page.evaluate(() => {
    const r = document.querySelector('#findings-rows .findings-row[data-kind=pierce]');
    if (!r) return null;
    return { title: r.querySelector('.findings-title').textContent, fixes: Array.from(r.querySelectorAll('.findings-item .findings-fix')).map(b => b.textContent),
             items: r.querySelectorAll('.findings-item').length, sameBox: !!r.querySelector('.findings-items'), fixAll: document.getElementById('btn-findings-fixall').textContent };
  });
  check('the overlapping-shells row has both buttons: MERGE SHELLS, SPLIT SHELLS', !!row && row.fixes.join() === 'MERGE SHELLS,SPLIT SHELLS', JSON.stringify(row));
  check('...laid out as every row is: one item line each, in the row\'s item list', row.items === 2 && row.sameBox);
  const nFix = await page.evaluate(() => document.querySelectorAll('#findings-rows .findings-item .findings-fix').length);
  check('...and Fix all (n) does not count SPLIT SHELLS (it never runs by itself)', row.fixAll === 'Fix all (' + (nFix - 1) + ')', row.fixAll + ' of ' + nFix + ' buttons');
  await page.evaluate(() => { const c = document.getElementById('findings-card'); c.scrollTop = 0; });
  await page.locator('#findings-rows .findings-row[data-kind=pierce]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const cardShot = path.join(OUT, 'C-findings-row-split-and-merge-shells.png');
  await page.locator('#findings-card').screenshot({ path: cardShot });
  console.log('   [screenshot] ' + path.relative(ROOT, cardShot));
  await shot(page, 'C-findings-card');

  const spEng = require('../nso_split_parts.js').split(boxRaw);
  const U0 = (await plateState(page)).undo;
  await page.click('#findings-rows .findings-fix[data-fix=splitShells]');
  await page.waitForFunction(() => /^Split shells:/.test(document.getElementById('findings-result').textContent), null, { timeout: 60000 });
  const S5 = await plateState(page), parts2 = S5.models.filter(m => /^box_closed part \d$/.test(m.name));
  check('SPLIT SHELLS: the same two pieces Split to parts makes (68 + 12, bit for bit)', parts2.length === 2 && !S5.models.some(m => m.id === boxId) &&
    sameSoup(await raw(page, parts2[0].id), Array.from(spEng.parts[0].soup)) && sameSoup(await raw(page, parts2[1].id), Array.from(spEng.parts[1].soup)));
  const resText = await page.evaluate(() => document.getElementById('findings-result').textContent);
  check('...the card says the finding is gone from every piece', /each where it stood - the overlapping-shells finding is gone from every one of them/.test(resText), resText);
  const doneRows = await page.evaluate(() => Array.from(document.querySelectorAll('#findings-done li')).map(l => l.textContent));
  check('...one green line per piece', doneRows.length === 2 && doneRows.every(t => /^✓ box_closed part \d — no overlapping shells, 0 piercing pairs - PASS$/.test(t)), doneRows.join(' | '));
  const reps2 = [];
  for (const p of parts2) reps2.push(await report(page, p.id));
  check('Check passes on both pieces', reps2.every(r => r.verdict === 'PASS' && r.pierce === 0 && r.overlapShells === 0), JSON.stringify(reps2));
  const noRow = [];
  for (const p of parts2) {
    await selectRow(page, p.id);
    await page.evaluate(() => { if (window.nsoDefectsShownFor() != null) window.nsoDefectsHide(); });
    await openFinishMenu(page);
    await page.click('#btn-check-defects');
    await page.waitForFunction(i => window.nsoDefectsShownFor() === i && nsoFindingsState().modelId === i, p.id, { timeout: 60000 });
    noRow.push(await page.evaluate(() => ({ pierce: !!document.querySelector('#findings-rows .findings-row[data-kind=pierce]'), clean: !!document.querySelector('#findings-rows .findings-row[data-kind=clean]') })));
  }
  check('...and each piece\'s own Check card shows no overlapping-shells row, only "Nothing wrong found"', noRow.every(r => !r.pierce && r.clean), JSON.stringify(noRow));
  await page.evaluate(() => { if (window.nsoDefectsShownFor() != null) window.nsoDefectsHide(); });
  await ctrlZ(page);
  const S6 = await plateState(page);
  check('one Undo restores the piece: the original, bit for bit', S6.models.some(m => m.id === boxId) && S6.models.length === S0.models.length && sameSoup(await raw(page, boxId), raw0) && S6.undo === U0, `undo ${S6.undo} vs ${U0}`);

  await selectRow(page, boxId);
  await openFinishMenu(page);
  await page.click('#btn-check-defects');
  await page.waitForFunction(i => window.nsoDefectsShownFor() === i && nsoFindingsState().modelId === i, boxId, { timeout: 60000 });
  await page.click('#findings-rows .findings-fix[data-fix=mergeShells]');
  await page.waitForFunction(i => state.models.find(m => m.id === i).rawTris.length !== 80 * 9, boxId, { timeout: 120000 });
  const mr = await report(page, boxId), mshell = require('../nso_shells.js').shells(Float32Array.from(await raw(page, boxId)));
  check('MERGE SHELLS unchanged: the two shells are one solid (the lid seals the tray: one part, its trapped hollow kept inside), no piercing pair', mr.pierce === 0 && mshell.parts === 1 && mr.closed, JSON.stringify(mr) + ' shells ' + mshell.n + ' ' + mshell.shells.map(x => x.tris).join('+'));
  await page.evaluate(() => { if (window.nsoDefectsShownFor() != null) window.nsoDefectsHide(); });
  await ctrlZ(page);
  check('...and one Undo puts the two shells back', sameSoup(await raw(page, boxId), raw0));

  console.log('\n=== D. a hollow box: "1 part", Lift as it always was ===');
  const hbId = await fresh(HOLLOW_STL);
  await selectRow(page, hbId);
  await page.waitForFunction(() => /^\d+ parts?$/.test(document.getElementById('split-count').textContent), null, { timeout: 15000 });
  const hc = await splitCard(page);
  check('Split reads "1 part", the hollow stays with its shell', hc.count === '1 part' && /hollow inside it, not a part/.test(hc.read) || /1 hollow kept/.test(hc.read), JSON.stringify(hc));
  const armNew = await armShells(page, hbId);
  const readNew = armNew.card;
  const shellsNew = await page.evaluate(() => NSO_LIFT_PLATE.shells());
  await page.evaluate(() => { window.__shellsKeep = window.NSO_Shells; window.NSO_Shells = null; });
  const armOld = await armShells(page, hbId);
  await page.evaluate(() => { window.NSO_Shells = window.__shellsKeep; });
  check('Lift reads it as a piece of one shell (no shell mode)', shellsNew === null && !/shells found/.test(readNew.count), JSON.stringify(readNew));
  check('...the very same count and words with the shells engine out of the way: byte-identical', readNew.count === armOld.card.count && readNew.read === armOld.card.read, JSON.stringify([readNew, armOld.card]));
  await page.click('#btn-lift');

  console.log('\n=== E. a piece with a free second shell ===');
  const twoId = await fresh(TWO_STL);
  await selectRow(page, twoId);
  await page.waitForFunction(() => /^\d+ parts?$/.test(document.getElementById('split-count').textContent), null, { timeout: 15000 });
  check('Split reads "2 parts"', (await splitCard(page)).count === '2 parts');
  const armTwo = await armShells(page, twoId);
  check('Lift reads "2 shells found" (two bodies standing apart)', armTwo.card.count === '2 shells found' && /standing apart/.test(armTwo.card.read), JSON.stringify(armTwo.card));
  await page.click('#btn-lift');
  await openMenuFor(page, '#btn-split-parts');
  await page.click('#btn-split-parts');
  await page.waitForFunction(() => /^Split /.test(document.getElementById('split-readout').textContent), null, { timeout: 15000 });
  const S7 = await plateState(page);
  check('Split -> 2 pieces, as it always did', S7.models.filter(m => /^two-bodies part \d$/.test(m.name)).length === 2, S7.models.map(m => m.name).join(' | '));

  console.log('\n=== F. Export: the one line ===');
  boxId = await fresh(BOX_STL);
  await selectRow(page, boxId);
  await page.waitForFunction(() => /^\d+ parts?$/.test(document.getElementById('split-count').textContent), null, { timeout: 15000 });
  await openMenuFor(page, '#btn-split-parts');
  await page.click('#btn-split-parts');
  await page.waitForFunction(() => /^Split /.test(document.getElementById('split-readout').textContent), null, { timeout: 15000 });
  const exportOnce = async fmt => {
    await page.evaluate(f => { const sel = document.getElementById('export-format'); sel.value = f; sel.dispatchEvent(new Event('change', { bubbles: true })); }, fmt);
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.evaluate(() => document.getElementById('btn-export-stl').click());
    const d = await dl, file = path.join(TMP, 'x-' + Date.now() + '-' + d.suggestedFilename());
    await d.saveAs(file);
    await page.waitForFunction(() => /^Downloaded /.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    return { file, bytes: fs.statSync(file).size, status: await page.evaluate(() => document.getElementById('status').textContent) };
  };
  const e1 = await exportOnce('stl');
  check('STL: the file is still written (84 + 80 x 50 bytes)', e1.bytes === 84 + 80 * 50, String(e1.bytes));
  check('STL: one line, the pieces named', / - these pieces overlap; Join before printing: box_closed part 1 \+ box_closed part 2$/.test(e1.status), e1.status);
  const e2 = await exportOnce('3mf');
  check('3MF: the file is still written', e2.bytes > 1000, String(e2.bytes));
  check('3MF: the same line', / - these pieces overlap; Join before printing: box_closed part 1 \+ box_closed part 2$/.test(e2.status), e2.status);
  /* the second half to the far side of the plate: nothing overlaps any more */
  await page.evaluate(() => { const p = state.placed.find(q => q && /part 2$/.test(q.name)); applyPlacedXZ(p, p.x + 80, p.z); });
  const e3 = await exportOnce('stl');
  check('moved apart: the status line is what it always was, no line', /^Downloaded nest_.*_2pcs\.stl$/.test(e3.status), e3.status);
  await page.evaluate(() => { const sel = document.getElementById('export-format'); sel.value = 'stl'; sel.dispatchEvent(new Event('change', { bubbles: true })); });

  console.log('\n=== G. the vase: Lift on the handle ===');
  /* TIMES are taken inside the page (performance.now around the arm and around the lift), after the piece has been
     selected and left to settle - the selection itself starts reads (Split's, Supports') that are the same whichever way
     Lift reads the piece, and Playwright's own click latency is not Lift's. */
  const settle = async id => { await selectRow(page, id); await page.waitForFunction(() => /^\d+ parts?$/.test(document.getElementById('split-count').textContent), null, { timeout: 600000 }); await page.waitForTimeout(1500); };
  const armIn = (legacy) => page.evaluate(legacy => {
    if (NSO_LIFT_PLATE.isArmed()) NSO_LIFT_PLATE.setArmed(false);
    const keep = window.NSO_Shells; if (legacy) window.NSO_Shells = null;
    const t = performance.now(); NSO_LIFT_PLATE.setArmed(true); const ms = performance.now() - t;
    window.NSO_Shells = keep;
    return { ms: Math.round(ms), count: document.getElementById('lift-count').textContent };
  }, legacy);
  let vaseId = await fresh(VASE_STL);
  const vinfo = await info(page, vaseId);
  console.log('  generated vase: ' + vinfo.tris + ' triangles (body ' + VASE.bodyTris + ', handle ' + VASE.handleTris + ')');
  await frame(page, vaseId, [1.3, 0.05], 0.15);
  await settle(vaseId);
  const before = await armIn(true);
  console.log('  before: the arm as it was (the height map over the whole vase) takes ' + before.ms + ' ms (' + before.count + ')');
  const after = await armIn(false);
  console.log('  after: the arm (the shells) takes ' + after.ms + ' ms (' + after.count + ')');
  check('armed on the vase: "2 shells found"', after.count === '2 shells found', JSON.stringify(after));
  const vs0 = await plateState(page), vsig0 = await soupSig(page, vaseId);
  /* The lift itself, timed as the arm was: synchronously in the page. (Then Undone, and done again below with the real pointer.) */
  const timed = await page.evaluate(() => { const t = performance.now(), r = NSO_LIFT_PLATE.liftShell(1, 'drive'); return { ms: Math.round(performance.now() - t), ok: !!r.ok }; });
  const total = after.ms + timed.ms;
  check('the handle shell lifts', timed.ok);
  console.log('  after: arm ' + after.ms + ' ms + the lift ' + timed.ms + ' ms = ' + total + ' ms;  before: the arm alone, ' + before.ms + ' ms');
  check('handle out (arm + lift) in under the time the arm took as it was', total < before.ms, total + ' ms vs ' + before.ms + ' ms');
  await ctrlZ(page);
  check('one Undo: the vase is back as it was, bit for bit', (await soupSig(page, vaseId)) === vsig0);

  /* The same thing with the real pointer: hover the handle, press on it. Wall-clock from the press to "Lifted" also holds
     the frames the page draws in between (headless software GL: ~0.4 s a frame at this size), which the timings above do not. */
  const hTri = await visibleTriOfShell(page, vaseId, 1);
  check('a handle face is in view', hTri >= 0, String(hTri));
  await L.hoverTri(page, vaseId, hTri);
  check('hovering the handle outlines the handle shell', await page.evaluate(() => NSO_LIFT_PLATE.hoverShell()) === 1);
  await page.evaluate(() => {
    window.__t0 = null; window.__t1 = null;
    window.addEventListener('pointerdown', () => { window.__t0 = performance.now(); }, { capture: true, once: true });
    const el = document.getElementById('lift-readout');
    new MutationObserver(() => { if (window.__t1 == null && /^Lifted/.test(el.textContent)) window.__t1 = performance.now(); }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await L.clickTri(page, vaseId, hTri);
  await waitLifted(page);
  const lifted = await page.evaluate(() => Math.round(window.__t1 - window.__t0));
  console.log('  by the pointer: press to "Lifted" ' + lifted + ' ms (frames included)');
  const vs1 = await plateState(page), handle = L.added(vs0, vs1)[0];
  const hr = handle && await report(page, handle.id), br = await report(page, vaseId);
  check('the handle is out intact: ' + VASE.handleTris + ' triangles, closed, no piercing', !!handle && handle.tris === VASE.handleTris && hr.closed && hr.pierce === 0, JSON.stringify(hr));
  check('the body is left whole: ' + VASE.bodyTris + ' triangles, closed, no piercing', br.tris === VASE.bodyTris && br.closed && br.pierce === 0, JSON.stringify(br));
  await shot(page, 'G-handle-lifted');
  await ctrlZ(page);
  check('one Undo: the vase is back as it was, bit for bit', (await soupSig(page, vaseId)) === vsig0);

  if (LOCAL) {
    console.log('\n=== G2. the local vase: ' + path.relative(ROOT, LOCAL) + ' ===');
    await L.dropPieces(page, (await plateState(page)).models.map(m => m.id));
    await page.setInputFiles('#file-input', LOCAL);
    await page.waitForFunction(() => state.models.length >= 1 && state.models.some(m => m.rawTris && m.rawTris.length / 9 > 100000), null, { timeout: 600000 });
    const big = await page.evaluate(() => state.models.reduce((a, m) => (m.rawTris.length > (a ? a.rawTris.length : 0) ? m : a), null).id);
    await frame(page, big, [1.3, 0.05], 0.15);
    await page.evaluate(() => { window.__shellsKeep = window.NSO_Shells; window.NSO_Shells = null; });
    const lb = await armShells(page, big);
    await page.evaluate(() => { window.NSO_Shells = window.__shellsKeep; });
    await page.click('#btn-lift');
    const la = await armShells(page, big);
    console.log('  the local vase: before (the arm) ' + lb.ms + ' ms: ' + lb.card.count + '; after (the arm) ' + la.ms + ' ms: ' + la.card.count);
    const sh = await page.evaluate(() => { const S = NSO_LIFT_PLATE.shells(); return S ? S.shells.map(s => ({ tris: s.tris, crosses: s.crosses, insideOf: s.insideOf, closed: s.closed })) : null; });
    console.log('  classifier reading: ' + JSON.stringify(sh));
    if (sh && sh.length > 1) {
      const handleId = sh.map((s, i) => i).sort((a, b) => sh[a].tris - sh[b].tris)[0];
      const tri = await visibleTriOfShell(page, big, handleId);
      if (tri >= 0) {
        const s0 = await plateState(page), t1 = Date.now();
        await L.clickTri(page, big, tri);
        await waitLifted(page);
        console.log('  the local vase: handle out ' + (Date.now() - t1) + ' ms after the click; arm + click ' + (la.ms + (Date.now() - t1)) + ' ms against the arm as it was, ' + lb.ms + ' ms');
        const lh = L.added(s0, await plateState(page))[0];
        check('local vase: the handle comes out intact', !!lh && (await report(page, lh.id)).closed);
      } else console.log('  (no handle face in view from this camera - not clicked)');
    }
  } else {
    console.log('\n=== G2. the local vase: SKIPPED (no tools/fixtures-local/vase.stl|vase.3mf|boolean-vase.3mf, and NSO_SHELLS_VASE unset) ===');
  }

  const errs = logs.filter(l => /^\[pageerror\]/.test(l));
  check('no page errors', errs.length === 0, errs.join(' | '));
}).then(() => {
  console.log('\n' + (C.fails ? C.fails + ' FAILED: ' + C.failed.join('; ') : 'all ' + C.passes + ' gates held'));
  process.exit(C.fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
