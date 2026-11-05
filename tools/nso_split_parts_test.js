#!/usr/bin/env node
/* Split to parts (nso_split_parts.js, app-split-parts.js).
     node tools/nso_split_parts_test.js        exit 0 = every gate held
   (npm run split:parts)

   Every fixture is generated here (tools/nso_split_parts_fixtures.js) or is the
   repo's own fixtures/features/feature-hull_hinge.stl, lifted by the real engines.

   ENGINE (node only)
     1. the hinge as Lift hands it over (two shells): 2 parts, each closed and
        manifold, the triangle counts sum to the original, every triangle comes
        back bit for bit in its original order, none twice, the input untouched
     2. a hollow box (2 shells): REFUSED - 1 part - in words, nothing returned
        to build from
     3. three loose cubes: 3 parts
     4. shells that only touch are separate parts: face to face, along an edge, at
        a corner (cavityShells alone reads the first two as one shell)
     5. a cavity goes with the part it is in: a box with a rattling cube in its
        cavity is 2 parts, and when the cube is itself hollow its small cavity
        stays with the cube, not the box round it
     6. one cube, an empty soup, a plain Array input
   APP (the real page, headless Chromium)
     7. selecting the hinge: the card says "2 parts" before the button is pressed;
        a hollow box says "1 part" and pressing refuses it, nothing changed
     8. pressing Split on the hinge: the original piece is gone, two pieces named
        "<name> part 1" and "part 2", each closed, in the same place as the
        original drew them (the union of their boxes is the original's box), part
        1 selected; ONE Undo puts the original back - the same soup, bit for bit -
        and selects it again */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SP = require(path.join(ROOT, 'nso_split_parts.js'));
const L = require(path.join(ROOT, 'nso_lift.js'));
const FX = require('./nso_split_parts_fixtures.js');
const { writeSTL } = require('./nso_stl_io.js');
const LIB = require('./nso_lift_plate_drive_lib.js');
const C = LIB.makeCheck(), check = C.check;

const closed = soup => { const c = L.census(soup); return c.closed && c.degen === 0; };
const triKey = (s, t) => Array.from(s.slice(t * 9, t * 9 + 9)).join();
const sum = a => a.reduce((x, y) => x + y, 0);

/* Every triangle of `src` is in exactly one part, parts keep the source's order. */
function conserved(src, parts) {
  const where = new Map();
  for (let t = 0; t < src.length / 9; t++) { const k = triKey(src, t); (where.get(k) || where.set(k, []).get(k)).push(t); }
  const seen = new Set();
  let ordered = true, found = 0;
  for (const p of parts) {
    let prev = -1;
    for (let t = 0; t < p.soup.length / 9; t++) {
      const hits = where.get(triKey(p.soup, t));
      const at = hits && hits.find(h => !seen.has(h));
      if (at === undefined) return { ok: false, ordered: false };
      seen.add(at); found++;
      if (at < prev) ordered = false;
      prev = at;
    }
  }
  return { ok: found === src.length / 9 && seen.size === src.length / 9, ordered };
}

console.log('\n=== 1. the hinge, as Lift hands it over ===');
const HG = FX.hingeLifted();
const hinge = HG.soup, hingeCopy = Float32Array.from(hinge);
check('the lifted hinge is ONE closed piece of two shells (the fixture is what the card is for)',
  closed(hinge) && SP.analyse(hinge).shells === 2, hinge.length / 9 + ' tris');
const rh = SP.split(hinge);
check('it splits: 2 parts', rh.ok && rh.parts.length === 2 && rh.words === '2 parts', rh.words + ' - ' + rh.reason);
check('each part is closed and manifold, no degenerate triangle', rh.parts.every(p => closed(p.soup)),
  rh.parts.map(p => JSON.stringify((({ tris, open, nm, degen }) => ({ tris, open, nm, degen }))(L.census(p.soup)))).join(' '));
check('the triangle counts sum to the original', sum(rh.parts.map(p => p.soup.length / 9)) === hinge.length / 9,
  rh.parts.map(p => p.soup.length / 9).join(' + ') + ' = ' + hinge.length / 9);
const cv = conserved(hinge, rh.parts);
check('every triangle comes back bit for bit, once, in its original order', cv.ok && cv.ordered);
check('the input soup was never written to', hinge.every((v, i) => v === hingeCopy[i]));
check('the parts are two separate solids (volumes add up to the original)',
  Math.abs(sum(rh.parts.map(p => L.volume(p.soup))) - L.volume(hinge)) < 1e-3 * Math.abs(L.volume(hinge)),
  rh.parts.map(p => L.volume(p.soup).toFixed(2)).join(' + ') + ' vs ' + L.volume(hinge).toFixed(2));

console.log('\n=== 2. a hollow box is one part ===');
const hb = FX.hollowBox(), rb = SP.split(hb);
check('refused: ok false, "1 part"', !rb.ok && rb.words === '1 part' && rb.parts.length === 1, rb.words);
check('...it has 2 shells, 1 hollow', rb.shells === 2 && rb.cavities === 1, rb.shells + ' shells, ' + rb.cavities + ' hollow');
check('...in words, nothing changed, and nothing to build from', /Nothing to split/.test(rb.reason) && /1 part/.test(rb.reason) &&
  /hollow/.test(rb.reason) && /Nothing changed/.test(rb.reason) && rb.parts.every(p => !p.soup), rb.reason);
check('the card\'s readout says it before the button: "1 part (2 shells, 1 hollow kept with its part)"',
  SP.describe(SP.analyse(hb)) === '1 part (2 shells, 1 hollow kept with its part)', SP.describe(SP.analyse(hb)));

console.log('\n=== 3. three loose cubes ===');
const lc = FX.looseCubes(), r3 = SP.split(lc);
check('3 parts, "3 parts"', r3.ok && r3.parts.length === 3 && r3.words === '3 parts', r3.words);
check('each is one closed cube of 12 triangles', r3.parts.every(p => p.soup.length / 9 === 12 && closed(p.soup)));
check('...in the original order, bit for bit', conserved(lc, r3.parts).ok && conserved(lc, r3.parts).ordered);

console.log('\n=== 4. shells that only touch are separate parts ===');
[['face to face', FX.touchingFace()], ['along an edge', FX.touchingEdge()], ['at a corner', FX.touchingCorner()]].forEach(([what, s]) => {
  const r = SP.split(s);
  check('two cubes ' + what + ': 2 parts, 12 triangles each', r.ok && r.parts.length === 2 && r.parts.every(p => p.soup.length / 9 === 12), r.words);
  check('...each a closed cube on its own', r.ok && r.parts.every(p => closed(p.soup)));
  check('...every triangle kept, in order', r.ok && conserved(s, r.parts).ok && conserved(s, r.parts).ordered);
});

console.log('\n=== 5. a cavity goes with the part it is in ===');
const cb = FX.captiveBall(), rc = SP.split(cb);
check('a box with a cube rattling in its cavity: 2 parts', rc.ok && rc.parts.length === 2, rc.words);
const big = rc.parts.find(p => p.soup.length / 9 === 24), small = rc.parts.find(p => p.soup.length / 9 === 12);
check('...the box keeps its cavity (24 triangles, 2 shells, 1 hollow); the cube is 12 and alone', !!big && !!small && big.shells === 2 && big.cavities === 1 && small.shells === 1,
  rc.parts.map(p => p.soup.length / 9 + 't/' + p.shells + 's').join(' '));
check('...the cube is NOT a hollow (it is wound outward and sits in the cavity, not in material)', rc.cavities === 1);
const hc = FX.hollowInCavity(), rhc = SP.split(hc);
check('the cube itself hollow: still 2 parts', rhc.ok && rhc.parts.length === 2, rhc.words);
check('...each holds ONE cavity: 24 + 24 triangles (the small cavity went to the cube, not the box round it)',
  rhc.parts.every(p => p.soup.length / 9 === 24 && p.shells === 2 && p.cavities === 1), rhc.parts.map(p => p.soup.length / 9 + 't/' + p.shells + 's').join(' '));
check('...and the box part is the big one', rhc.parts.some(p => { const c = L.volume(p.soup); return Math.abs(c - (27000 - 8000)) < 1e-3; }) &&
  rhc.parts.some(p => Math.abs(L.volume(p.soup) - (216 - 8)) < 1e-3),
  rhc.parts.map(p => L.volume(p.soup).toFixed(1)).join(' + '));

console.log('\n=== 6. odd inputs ===');
const one = SP.split(FX.box(0, 0, 0, 10));
check('one cube: "1 part (one shell)", refused', !one.ok && one.words === '1 part' && /one shell/.test(one.reason) && SP.describe(SP.analyse(FX.box(0, 0, 0, 10))) === '1 part', one.reason);
check('an empty soup is refused in words', !SP.split(new Float32Array(0)).ok && /empty/.test(SP.split(new Float32Array(0)).reason));
check('a plain Array soup works as a Float32Array does', SP.split(Array.from(lc)).parts.length === 3);

async function app() {
  const { withApp, loadSTL } = require('./nso_app_harness');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-split-parts-'));
  const HINGE_STL = path.join(TMP, 'hinge.stl'), BOX_STL = path.join(TMP, 'hollow-box.stl');
  writeSTL(HINGE_STL, hinge);
  writeSTL(BOX_STL, hb);
  const card = page => page.evaluate(() => ({ count: document.getElementById('split-count').textContent,
    read: document.getElementById('split-readout').textContent, disabled: document.getElementById('btn-split-parts').disabled }));
  const world = (page, id) => page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id);
    const b = new THREE.Box3().setFromObject(p.mesh);
    return { min: b.min.toArray(), max: b.max.toArray(), liftY: p.liftY || 0, rotY: p.rotY || 0, flipX: !!p.flipX };
  }, id);
  const snap = page => page.evaluate(() => ({
    models: state.models.map(m => ({ id: m.id, name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : 0 })),
    placed: state.placed.map(p => p.sourceId), sel: state.selectedIndex, edit: state.editId, undo: state.undoStack.length,
    selId: state.placed[state.selectedIndex] ? state.placed[state.selectedIndex].sourceId : null }));
  const waitCount = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('split-count').textContent), re, { timeout: 15000 });

  await withApp(async (page, logs) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    page.on('dialog', d => d.accept().catch(() => {}));

    console.log('\n=== 7. the card says it before the button is pressed ===');
    const c0 = await card(page);
    check('nothing selected: the button is off, the count is a dash', c0.disabled && c0.count === '—', JSON.stringify(c0));
    const boxId = await loadSTL(page, BOX_STL);
    await LIB.selectRow(page, boxId);
    await waitCount(page, '^1 part$');
    const cBox = await card(page);
    check('the hollow box: "1 part" beside the button, and the readout says why', cBox.count === '1 part' && /hollow/.test(cBox.read), cBox.count + ' | ' + cBox.read);
    const before = await snap(page);
    await page.click('#btn-split-parts');
    await page.waitForTimeout(250);
    const after = await snap(page), cAfter = await card(page);
    check('pressing it refuses, in words, and changes nothing',
      /Nothing to split/.test(cAfter.read) && JSON.stringify(after) === JSON.stringify(before), cAfter.read);
    check('...and the status line says so too', /Nothing to split/.test(await LIB.status(page)));

    const hingeId = await loadSTL(page, HINGE_STL);
    await LIB.selectRow(page, hingeId);
    await waitCount(page, '^2 parts$');
    const cH = await card(page);
    check('the hinge: "2 parts" beside the button, before it is pressed', cH.count === '2 parts' && !cH.disabled && /^2 parts/.test(cH.read), cH.count + ' | ' + cH.read);

    console.log('\n=== 8. Split, then Undo ===');
    const S0 = await snap(page), orig = await LIB.raw(page, hingeId), ob = await world(page, hingeId);
    const placedBefore = S0.placed.length;
    await page.click('#btn-split-parts');
    await page.waitForFunction(() => /^Split /.test(document.getElementById('split-readout').textContent), null, { timeout: 15000 });
    const S1 = await snap(page);
    const made = S1.models.filter(m => /^hinge part \d+$/.test(m.name));
    check('the original is gone from the plate and the list; two pieces named "hinge part 1", "hinge part 2"',
      !S1.models.some(m => m.id === hingeId) && !S1.placed.includes(hingeId) && made.length === 2 &&
      made[0].name === 'hinge part 1' && made[1].name === 'hinge part 2' && S1.placed.length === placedBefore + 1,
      S1.models.map(m => m.name).join(' | '));
    check('the tri counts sum to the original', made[0].tris + made[1].tris === orig.length / 9, made[0].tris + ' + ' + made[1].tris + ' = ' + orig.length / 9);
    const infos = [];
    for (const m of made) infos.push(await LIB.pieceInfo(page, m.id));
    check('each part is a closed piece with no degenerate triangle', infos.every(i => i.closed && i.degen === 0));
    const w1 = await world(page, made[0].id), w2 = await world(page, made[1].id);
    const un = { min: [0, 1, 2].map(k => Math.min(w1.min[k], w2.min[k])), max: [0, 1, 2].map(k => Math.max(w1.max[k], w2.max[k])) };
    check('each is where the original drew it: the union of the two boxes IS the original\'s box (within 0.01 mm)',
      [0, 1, 2].every(k => Math.abs(un.min[k] - ob.min[k]) < 0.01 && Math.abs(un.max[k] - ob.max[k]) < 0.01),
      JSON.stringify(un.min.map(v => +v.toFixed(2))) + JSON.stringify(un.max.map(v => +v.toFixed(2))) + ' vs ' + JSON.stringify(ob.min.map(v => +v.toFixed(2))) + JSON.stringify(ob.max.map(v => +v.toFixed(2))));
    check('...and at the original\'s pose', w1.rotY === ob.rotY && w2.rotY === ob.rotY && w1.flipX === ob.flipX);
    check('part 1 is the selection (the app holds one selection, not a set)', S1.selId === made[0].id && S1.edit === made[0].id, 'sel ' + S1.selId);
    check('one Undo step was pushed', S1.undo === S0.undo + 1, S0.undo + ' -> ' + S1.undo);
    const cs = await card(page);
    check('the card reads the part now selected (a single shell: "1 part")', cs.count === '1 part', cs.count + ' | ' + cs.read);

    await LIB.ctrlZ(page);
    const S2 = await snap(page), back = await LIB.raw(page, hingeId);
    check('Undo: the original piece is back, the parts are gone', S2.models.some(m => m.id === hingeId) && !S2.models.some(m => /^hinge part/.test(m.name)) &&
      S2.placed.length === placedBefore && S2.placed.includes(hingeId), S2.models.map(m => m.name).join(' | '));
    check('...the same soup, bit for bit', LIB.sameSoup(back, orig));
    check('...in the same place, at the same height', await (async () => { const w = await world(page, hingeId); return [0, 1, 2].every(k => Math.abs(w.min[k] - ob.min[k]) < 1e-6 && Math.abs(w.max[k] - ob.max[k]) < 1e-6); })());
    check('...and selected again', S2.selId === hingeId && S2.edit === hingeId, 'sel ' + S2.selId);
    check('...the undo stack back to where it was', S2.undo === S0.undo, S2.undo + ' vs ' + S0.undo);
    await waitCount(page, '^2 parts$');
    check('...and the card reads "2 parts" again', (await card(page)).count === '2 parts');

    const errs = logs.filter(l => /^\[pageerror\]/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
}

app().then(() => {
  console.log('\n' + (C.fails ? C.fails + ' FAILED: ' + C.failed.join('; ') : 'all ' + C.passes + ' gates held'));
  process.exit(C.fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
