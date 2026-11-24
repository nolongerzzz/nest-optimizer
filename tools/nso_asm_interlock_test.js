/* The assembly editor's Interlock tab (app-asm-interlock.js, nso_interlock.js,
   docs/INTERLOCK.md), through the real app and real clicks and drags.
     node tools/nso_asm_interlock_test.js        exit 0 = every gate held

   Hull = fixtures/box_hull_80x40x20-2.stl, bit = fixtures/box-20mm.stl.

   What is pinned:
   1. The card's Interlocks & pins button opens the editor on the Interlock
      tab, with every piece on its own and nothing on the plate moved.
   2. One piece: a click on a face with nothing seated on it says so and makes
      the key only. The four edge distances are what the key's box measures
      off the face's edges; a typed distance puts the key's edge exactly there.
   3. Dragging the key moves it on the face without turning the view, lands on
      a 0.1 mm step, and lands on the centre line when dropped near it.
   4. Apply, key only: the piece grows by the key and its body does not move;
      mesh_validate.py passes it; the volume gained is the key's above the
      face; one Undo puts it back ===.
   5. Socket here, one piece: a pin hole of the typed diameter + 2 fit, to the
      typed depth + fit; "goes through" removes the full thickness. Volumes by
      hand; the box does not change.
   6. A pair: with the bit Placed on the hull, a click on the hull's top finds
      the bit seated there. Apply adds the key to the hull and cuts the slot in
      the bit: the slot is the key grown by the fit on every side, the volume
      removed is the slot's by hand, neither body moves, both pass the checker,
      and one Undo restores both.
   7. The same over a 0.18 seat gap: the slot is shallower by the gap.
   8. Socket here on a pair: the socket goes into the clicked piece and the
      key onto the seated one, pointing in.
   9. A snap tab pair passes the checker on both pieces; a snap too short for
      its catch is refused in words with Apply off.
  10. Escape steps back, then returns. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const meshValidate = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));

const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  if (!p) return null;
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh), m = state.models.find(x => x.id === id);
  let h = 0;
  for (let i = 0; i < m.rawTris.length; i++) h = (h * 31 + Math.round(m.rawTris[i] * 1e4)) | 0;
  return { x: p.x, z: p.z, liftY: p.liftY || 0, pos: p.mesh.position.toArray(), min: bb.min.toArray(), max: bb.max.toArray(), raw: h };
}, id);
const same = (p, q) => JSON.stringify(p) === JSON.stringify(q);
const rawStl = id => {
  const m = state.models.find(x => x.id === id), s = m.rawTris, n = s.length / 9;
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + t * 50 + 12 + k * 4, s[t * 9 + k], true);
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let q = 0; q < bytes.length; q += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(q, q + 0x8000));
  return btoa(bin);
};
const info = page => page.evaluate(() => NSO_AsmEditor.info());
const lock = async page => (await info(page)).lock;
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const edStatus = page => page.evaluate(() => document.getElementById('asm-ed-status').textContent);
const readout = page => page.evaluate(() => document.getElementById('asm-il-readout').textContent);
const view = (page, dir) => page.evaluate(d => NSO_AsmEditor.view(d), dir);
const ABOVE = [-0.5, 1, 0.7];
const at = (page, id, pt) => page.evaluate(([i, p]) => NSO_AsmEditor.screenOf(i, p), [id, pt]);
async function click(page, id, pt) { const s = await at(page, id, pt); await page.mouse.move(s.x, s.y); await page.waitForTimeout(120); await page.mouse.click(s.x, s.y); await page.waitForTimeout(120); }
const idle = page => page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 90000 });
async function type(page, id, v) { await page.fill('#asm-il-' + id, String(v)); await page.dispatchEvent('#asm-il-' + id, 'change'); await page.waitForTimeout(60); }
const centre = (p, y) => [(p.min[0] + p.max[0]) / 2, y, (p.min[2] + p.max[2]) / 2];
const gon = r => 64 / 2 * r * r * Math.sin(2 * Math.PI / 64);        // the area of the 64-sided pin

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-asm-interlock-'));
  const shots = path.join(ROOT, 'tools', 'asm-editor-out');
  fs.mkdirSync(shots, { recursive: true });
  const validate = async (id, tag) => { const f = path.join(tmp, tag + '.stl'); fs.writeFileSync(f, Buffer.from(await page.evaluate(rawStl, id), 'base64')); return meshValidate(f); };
  const clean = v => v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 && v.self_intersection.pierce === 0;
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  await page.evaluate(() => state.placed.forEach(p => applyPlacedXZ(p, p.x, p.z)));
  const a0 = await pose(page, idA), b0 = await pose(page, idB);
  const depth0 = await undoDepth(page);
  const volA = (await validate(idA, 'a0')).signed_volume, volB = (await validate(idB, 'b0')).signed_volume;

  /* ---------- 1 ---------- */
  console.log('\n--- 1. the card button opens the Interlock tab ---');
  await page.click('#menu-assemble > summary');
  check('the card has Interlocks & pins', await page.evaluate(() => { const b = document.getElementById('btn-asm-interlock'); return !!b && !!b.closest('#asm-card'); }));
  await page.click('#btn-asm-interlock');
  await page.waitForFunction(() => NSO_AsmEditor.isOpen() && NSO_AsmEditor.info().mode === 'lock');
  let i = await info(page);
  check('the editor is open on Interlock, at its first step, both pieces on the stage', i.lock.step === 'host' && i.pieces.length === 2);
  check('the Interlock tab is lit and its panel showing, the Mate panel hidden', await page.evaluate(() =>
    document.getElementById('asm-tab-lock').classList.contains('is-on') && !document.getElementById('asm-lock-body').hidden && document.getElementById('asm-mate-body').hidden));
  check('nothing on the plate moved', same(a0, await pose(page, idA)) && same(b0, await pose(page, idB)) && (await undoDepth(page)) === depth0);

  /* ---------- 2 ---------- */
  console.log('\n--- 2. one piece: a key on the bit\'s top ---');
  await view(page, ABOVE);
  await click(page, idB, [b0.min[0] + 6, b0.max[1], b0.min[2] + 7]);
  let L = await lock(page);
  check('the clicked face is the bit\'s top; nothing is seated on it', L.step === 'set' && L.host.id === idB && L.host.normal[1] > 0.99 && L.partner === null);
  check('the panel says it makes the key only', /Nothing is seated on this face/.test(await page.evaluate(() => document.getElementById('asm-il-alone').textContent)));
  await type(page, 'length', 10); await type(page, 'width', 4); await type(page, 'height', 3); await type(page, 'ease', 0.4);
  check('with no socket to cut, Fit and "goes through" are not offered', await page.evaluate(() => document.getElementById('asm-il-f-fit').hidden && document.getElementById('asm-il-through-row').hidden));
  L = await lock(page);
  check('the plan: a key on the bit, no socket', L.plan.keyTo === idB && L.plan.cutTo === null);
  const kb = L.plan.keyBox, r = L.host.rect;
  const spanU = Math.max(kb.max[0] - kb.min[0], 0), spanW = kb.max[2] - kb.min[2];
  check('the four distances add up across the face: d + key + b and a + key + c are the face (1e-6)',
    near(L.plan.edges.d + L.plan.edges.b + (spanU > spanW ? 10 : 4), 20, 1e-5) && near(L.plan.edges.a + L.plan.edges.c + (spanU > spanW ? 4 : 10), 20, 1e-5), JSON.stringify(L.plan.edges));
  await type(page, 'd', 3.5);
  await type(page, 'a', 2.25);
  L = await lock(page);
  check('typed distances are exact: d = 3.5, a = 2.25 (1e-6)', near(L.plan.edges.d, 3.5, 1e-6) && near(L.plan.edges.a, 2.25, 1e-6), JSON.stringify(L.plan.edges));
  const kb2 = L.plan.keyBox;
  const gaps = [kb2.min[0] - b0.min[0], b0.max[0] - kb2.max[0], kb2.min[2] - b0.min[2], b0.max[2] - kb2.max[2]].map(v => +v.toFixed(4)).sort((x, y) => x - y);
  check('...and the key\'s own box stands 3.5 and 2.25 from two edges of the bit (1e-4)', gaps.some(v => near(v, 3.5, 1e-4)) && gaps.some(v => near(v, 2.25, 1e-4)), gaps.join(' '));
  check('the key stands 3 above the face and bites 0.4 into the piece', near(kb2.max[1] - b0.max[1], 3, 1e-5) && near(b0.max[1] - kb2.min[1], 0.4, 1e-5));
  await page.screenshot({ path: path.join(shots, 'il-2-key.png') });

  /* ---------- 3 ---------- */
  console.log('\n--- 3. drag it ---');
  const before = await lock(page);
  const mid = [(kb2.min[0] + kb2.max[0]) / 2, kb2.max[1], (kb2.min[2] + kb2.max[2]) / 2];
  const s0 = await at(page, idB, mid), s1 = await at(page, idB, [mid[0] + 2.37, mid[1], mid[2] + 1.61]);
  const viewBefore = await at(page, idB, [b0.min[0], b0.min[1], b0.min[2]]);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move((s0.x + s1.x) / 2, (s0.y + s1.y) / 2, { steps: 4 }); await page.mouse.move(s1.x, s1.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(150);
  L = await lock(page);
  const viewAfter = await at(page, idB, [b0.min[0], b0.min[1], b0.min[2]]);
  check('the key moved with the pointer', Math.hypot(L.cu - before.cu, L.cv - before.cv) > 1, Math.hypot(L.cu - before.cu, L.cv - before.cv));
  check('the view did not turn under the drag', near(viewBefore.x, viewAfter.x, 1e-6) && near(viewBefore.y, viewAfter.y, 1e-6));
  const tenth = v => near(v * 10, Math.round(v * 10), 1e-5);
  check('it landed on 0.1 mm steps from the face\'s edges', tenth(L.plan.edges.d) && tenth(L.plan.edges.c), JSON.stringify(L.plan.edges));
  /* drop it 0.4 mm off the middle of the face: it lands on the middle */
  const kb3 = L.plan.keyBox, mid3 = [(kb3.min[0] + kb3.max[0]) / 2, kb3.max[1], (kb3.min[2] + kb3.max[2]) / 2];
  const c3 = centre(b0, b0.max[1]);
  const p0 = await at(page, idB, mid3), p1 = await at(page, idB, [c3[0] + 0.4, mid3[1], c3[2] - 0.3]);
  await page.mouse.move(p0.x, p0.y); await page.mouse.down(); await page.mouse.move(p1.x, p1.y, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  L = await lock(page);
  check('dropped near the middle of the face, it lands on the middle (1e-6)', near(L.plan.edges.a, L.plan.edges.c, 1e-6) && near(L.plan.edges.b, L.plan.edges.d, 1e-6), JSON.stringify(L.plan.edges));
  check('and through all of it the plate has not moved', same(b0, await pose(page, idB)) && (await undoDepth(page)) === depth0);

  /* ---------- 4 ---------- */
  console.log('\n--- 4. Apply: the key alone ---');
  await page.click('#asm-il-apply'); await idle(page);
  console.log('  editor: ' + await edStatus(page));
  let b = await pose(page, idB);
  check('the bit is 3 mm taller, and its body has not moved (1e-5)',
    near(b.max[1], b0.max[1] + 3, 1e-5) && [0, 1, 2].every(k => near(b.min[k], b0.min[k], 1e-5)) && near(b.max[0], b0.max[0], 1e-5) && near(b.max[2], b0.max[2], 1e-5), JSON.stringify([b.min, b.max]));
  let v = await validate(idB, 'b4');
  check('canonical checker: closed, manifold, one solid, nothing pierces', clean(v) && v.euler_characteristic === 2, `open ${v.open_edges} nm ${v.nonmanifold_edges} chi ${v.euler_characteristic}`);
  const keyAbove = 10 * 4 * (3 - 0.4) + 0.4 / 6 * (10 * 4 + 4 * 9.6 * 3.6 + 9.2 * 3.2);
  check('volume gained = the key above the face, by hand (0.01)', near(v.signed_volume - volB, keyAbove, 0.01), (v.signed_volume - volB) + ' vs ' + keyAbove);
  check('one press, one Undo entry; the editor is back at step 1', (await undoDepth(page)) === depth0 + 1 && (await lock(page)).step === 'host');
  await page.click('#asm-undo');
  check('one Undo puts the bit back ===', same(b0, await pose(page, idB)) && (await undoDepth(page)) === depth0);

  /* ---------- 5 ---------- */
  console.log('\n--- 5. Socket here, one piece: a pin hole ---');
  await view(page, ABOVE);
  await click(page, idB, centre(b0, b0.max[1]));
  await page.click('#asm-il-make-socket'); await page.click('#asm-il-shape-pin');
  await type(page, 'diameter', 6); await type(page, 'height', 5); await type(page, 'fit', 0.2); await type(page, 'ease', 0);
  L = await lock(page);
  check('the plan: a socket in the bit, no key', L.plan.cutTo === idB && L.plan.keyTo === null && near(L.plan.socketDepth, 5.2, 1e-5), JSON.stringify(L.plan.socketDepth));
  check('the readout names the hole: diameter + 2 fit, depth + fit', /hole ⌀6\.40 × 5\.20 deep in box-20mm/.test(await readout(page)), await readout(page));
  await page.click('#asm-il-apply'); await idle(page);
  v = await validate(idB, 'b5');
  check('volume removed = the 64-gon of radius 3.2 x 5.2 (0.01)', near(volB - v.signed_volume, gon(3.2) * 5.2, 0.01), (volB - v.signed_volume) + ' vs ' + gon(3.2) * 5.2);
  check('the checker passes it, and the bit\'s box is === what it was', clean(v) && same(b0.min, (await pose(page, idB)).min) && same(b0.max, (await pose(page, idB)).max));
  await page.click('#asm-undo');
  await click(page, idB, centre(b0, b0.max[1]));
  await page.check('#asm-il-through');
  check('goes through: the readout says so', /× through in box-20mm/.test(await readout(page)), await readout(page));
  await page.click('#asm-il-apply'); await idle(page);
  v = await validate(idB, 'b5t');
  check('through: volume removed = the 64-gon x the bit\'s 20 mm (0.02); a hole through a block is chi 0',
    near(volB - v.signed_volume, gon(3.2) * 20, 0.02) && clean(v) && v.euler_characteristic === 0, (volB - v.signed_volume) + ' chi ' + v.euler_characteristic);
  await page.click('#asm-undo');
  await page.click('#asm-il-chip');
  check('undone: the bit is back ===', same(b0, await pose(page, idB)) && (await undoDepth(page)) === depth0);

  /* ---------- 6 ---------- */
  console.log('\n--- 6. a pair: the bit Placed on the hull, a tongue between them ---');
  await page.click('#asm-tab-mate');
  await view(page, ABOVE);
  await click(page, idB, centre(b0, b0.max[1]));
  await page.click('#asm-underside');
  await click(page, idA, [a0.min[0] + 30, a0.max[1], (a0.min[2] + a0.max[2]) / 2]);
  if (await page.evaluate(() => document.getElementById('asm-gap-on').checked)) await page.uncheck('#asm-gap-on');
  await page.click('#asm-place'); await idle(page);
  const a1 = await pose(page, idA), b1 = await pose(page, idB);
  check('Mate: the bit is placed on the hull, touching', near(b1.min[1], a1.max[1], 2e-6));
  const depth1 = await undoDepth(page);
  await page.click('#asm-tab-lock');
  i = await info(page);
  check('Interlock: the two are shown apart again, so the face between them can be clicked', i.mode === 'lock' && i.visible.length === 2);
  await view(page, ABOVE);
  const under = [(b1.min[0] + b1.max[0]) / 2, a1.max[1], (b1.min[2] + b1.max[2]) / 2];
  await click(page, idA, under);
  await page.click('#asm-il-make-key'); await page.click('#asm-il-shape-tongue');
  await type(page, 'length', 10); await type(page, 'width', 4); await type(page, 'height', 3); await type(page, 'ease', 0.4); await type(page, 'fit', 0.1);
  if (await page.evaluate(() => document.getElementById('asm-il-through').checked)) await page.uncheck('#asm-il-through');
  L = await lock(page);
  check('the hull\'s top is the face, and the bit is found seated on it at gap 0', L.host.id === idA && L.partner && L.partner.id === idB && near(L.partner.gap, 0, 1e-5), JSON.stringify(L.partner));
  check('the panel offers to cut the socket in the bit, ticked', await page.evaluate(() => !document.getElementById('asm-il-pair-row').hidden && document.getElementById('asm-il-pair').checked && /box-20mm is seated on it/.test(document.getElementById('asm-il-pair-text').textContent)));
  check('the plan: key on the hull, socket in the bit', L.plan.keyTo === idA && L.plan.cutTo === idB && L.plan.pair === true);
  const K = L.plan.keyBox, C = L.plan.cutBox;
  check('the socket is the key grown by the fit on every side (1e-5)', [0, 2].every(k => near(K.min[k] - C.min[k], 0.1, 1e-5) && near(C.max[k] - K.max[k], 0.1, 1e-5)), JSON.stringify([K, C]));
  check('...and 0.1 deeper than the key is tall', near(C.max[1] - K.max[1], 0.1, 1e-5) && near(L.plan.socketDepth, 3.1, 1e-5));
  check('the key is under the bit: its box is inside the bit\'s footprint', K.min[0] > b1.min[0] && K.max[0] < b1.max[0] && K.min[2] > b1.min[2] && K.max[2] < b1.max[2]);
  await page.screenshot({ path: path.join(shots, 'il-6-pair.png') });
  await page.click('#asm-il-apply'); await idle(page);
  console.log('  editor: ' + await edStatus(page));
  let a = await pose(page, idA); b = await pose(page, idB);
  check('the hull is 3 mm taller and its body has not moved (1e-5)', near(a.max[1], a1.max[1] + 3, 1e-5) && [0, 1, 2].every(k => near(a.min[k], a1.min[k], 1e-5)), JSON.stringify([a.min, a.max]));
  check('the bit\'s box is what it was: it has not moved (1e-5)', [0, 1, 2].every(k => near(b.min[k], b1.min[k], 1e-5) && near(b.max[k], b1.max[k], 1e-5)), JSON.stringify([b.min, b.max]));
  const va = await validate(idA, 'a6'), vb = await validate(idB, 'b6');
  check('canonical checker passes both pieces', clean(va) && clean(vb), `hull open ${va.open_edges} nm ${va.nonmanifold_edges}; bit open ${vb.open_edges} nm ${vb.nonmanifold_edges}`);
  check('hull: volume gained = the key above the face (0.01)', near(va.signed_volume - volA, keyAbove, 0.01), va.signed_volume - volA);
  check('bit: volume removed = 10.2 x 4.2 x 3.1 (0.01)', near(volB - vb.signed_volume, 10.2 * 4.2 * 3.1, 0.01), volB - vb.signed_volume);
  check('one press, one Undo entry for both pieces', (await undoDepth(page)) === depth1 + 1);
  check('the app\'s status says what was done', /^Interlock: Tongue 10\.00 × 4\.00 × 3\.00 added to box_hull.*slot 10\.20 × 4\.20 × 3\.10 deep cut in box-20mm, 0\.10 fit per side/.test(await page.evaluate(() => document.getElementById('status').textContent)));
  await page.click('#asm-undo');
  check('one Undo restores both, ===', same(a1, await pose(page, idA)) && same(b1, await pose(page, idB)) && (await undoDepth(page)) === depth1);

  /* ---------- 8 (on the same seat) ---------- */
  console.log('\n--- 8. Socket here on the pair: the socket in the hull, the key on the bit ---');
  await view(page, ABOVE);
  await click(page, idA, under);
  await page.click('#asm-il-make-socket');
  L = await lock(page);
  check('the plan turns round: socket in the hull, key on the bit', L.plan.cutTo === idA && L.plan.keyTo === idB);
  check('the key points down into the hull: 3 below the face, biting 0.4 up into the bit', near(a1.max[1] - L.plan.keyBox.min[1], 3, 1e-5) && near(L.plan.keyBox.max[1] - a1.max[1], 0.4, 1e-5), JSON.stringify(L.plan.keyBox));
  await page.click('#asm-il-apply'); await idle(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('the bit now reaches 3 mm down into the hull, its body where it was (1e-5)', near(b.min[1], b1.min[1] - 3, 1e-5) && near(b.max[1], b1.max[1], 1e-5) && near(b.min[0], b1.min[0], 1e-5) && near(b.min[2], b1.min[2], 1e-5), JSON.stringify([b.min, b.max]));
  check('the hull\'s box is what it was', [0, 1, 2].every(k => near(a.min[k], a1.min[k], 1e-5) && near(a.max[k], a1.max[k], 1e-5)));
  const va8 = await validate(idA, 'a8'), vb8 = await validate(idB, 'b8');
  check('checker passes both; bit gained the key, hull lost the slot (0.01)', clean(va8) && clean(vb8) && near(vb8.signed_volume - volB, keyAbove, 0.01) && near(volA - va8.signed_volume, 10.2 * 4.2 * 3.1, 0.01),
    (vb8.signed_volume - volB) + ' / ' + (volA - va8.signed_volume));
  await page.click('#asm-undo');
  check('one Undo restores both', same(a1, await pose(page, idA)) && same(b1, await pose(page, idB)));

  /* ---------- 9 ---------- */
  console.log('\n--- 9. a snap tab; and one that cannot be built ---');
  await view(page, ABOVE);
  await click(page, idA, under);
  await page.click('#asm-il-make-key'); await page.click('#asm-il-shape-snap');
  await type(page, 'length', 8); await type(page, 'width', 3); await type(page, 'height', 1.2); await type(page, 'catch', 0.5);
  check('a snap too short for its catch: the reason in words, Apply off',
    /needs a height of at least 2\.00 mm/.test(await readout(page)) && await page.evaluate(() => document.getElementById('asm-il-apply').disabled), await readout(page));
  await type(page, 'height', 4);
  check('tall enough: Apply on', await page.evaluate(() => !document.getElementById('asm-il-apply').disabled), await readout(page));
  await page.screenshot({ path: path.join(shots, 'il-9-snap.png') });
  await page.click('#asm-il-apply'); await idle(page);
  console.log('  editor: ' + await edStatus(page));
  const va9 = await validate(idA, 'a9'), vb9 = await validate(idB, 'b9');
  check('the snap tab and its grooved slot: the checker passes both pieces', clean(va9) && clean(vb9), `hull open ${va9.open_edges} nm ${va9.nonmanifold_edges} deg ${va9.degenerate_tris}; bit open ${vb9.open_edges} nm ${vb9.nonmanifold_edges} deg ${vb9.degenerate_tris}`);
  const sec = 3 * 4 - 2 * (0.4 * 0.4 / 2) + 2 * (1 * 0.5 / 2);
  check('hull: volume gained = the snap\'s section x its length (0.01)', near(va9.signed_volume - volA, 8 * sec, 0.01), (va9.signed_volume - volA) + ' vs ' + 8 * sec);
  await page.click('#asm-undo');

  /* ---------- 7 ---------- */
  console.log('\n--- 7. over a 0.18 seat gap ---');
  await page.click('#asm-tab-mate');
  await page.click('#asm-undo');                                     // the Place
  await view(page, ABOVE);
  const bb = await pose(page, idB);
  await click(page, idB, centre(bb, bb.max[1]));
  await page.click('#asm-underside');
  await click(page, idA, [a0.min[0] + 30, a0.max[1], (a0.min[2] + a0.max[2]) / 2]);
  await page.check('#asm-gap-on');
  await page.click('#asm-place'); await idle(page);
  const b7 = await pose(page, idB), a7 = await pose(page, idA);
  await page.click('#asm-tab-lock');
  await view(page, ABOVE);
  await click(page, idA, [(b7.min[0] + b7.max[0]) / 2, a7.max[1], (b7.min[2] + b7.max[2]) / 2]);
  await page.click('#asm-il-shape-tongue');
  await type(page, 'length', 10); await type(page, 'width', 4); await type(page, 'height', 3);
  L = await lock(page);
  check('the bit is found seated at a 0.18 gap', L.partner && L.partner.id === idB && near(L.partner.gap, 0.18, 1e-5), JSON.stringify(L.partner));
  check('the socket is shallower by the gap: 3.1 - 0.18 = 2.92', near(L.plan.socketDepth, 2.92, 1e-5), L.plan.socketDepth);
  await page.click('#asm-il-apply'); await idle(page);
  const vb7 = await validate(idB, 'b7');
  check('bit: volume removed = 10.2 x 4.2 x 2.92 (0.01), checker passes', near(volB - vb7.signed_volume, 10.2 * 4.2 * 2.92, 0.01) && clean(vb7), volB - vb7.signed_volume);
  b = await pose(page, idB);
  check('the bit still stands 0.18 above the hull\'s face (1e-5)', near(b.min[1] - a7.max[1], 0.18, 1e-5), b.min[1] - a7.max[1]);

  /* ---------- 10 ---------- */
  console.log('\n--- 10. Escape ---');
  await view(page, ABOVE);
  const bNow = await pose(page, idB);
  await click(page, idB, centre(bNow, bNow.max[1]));
  check('picked', (await lock(page)).step === 'set');
  await page.keyboard.press('Escape');
  check('Escape: back to the first step', (await lock(page)).step === 'host' && (await info(page)).visible.length === 2);
  await page.keyboard.press('Escape');
  check('Escape: returned to the plate', (await info(page)).open === false);

  const errs = logs.filter(l => l.startsWith('[pageerror]') || /^\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('ASM INTERLOCK TEST FAIL', e); process.exit(1); });
