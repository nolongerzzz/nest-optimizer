#!/usr/bin/env node
/* Close, driven through the real app, for its screenshots: real index.html,
   real script tags, real hover, real clicks, real Undo.
     node tools/nso_close_shots.js            exit 0 = every gate held
     node tools/nso_close_shots.js dir        ...and the screenshots, into dir

   The geometry is proven headless in tools/nso_close_test.js (close:test, in
   npm test). This is the card end to end - Close in ADD, the hover outline,
   a click picking the rim and filling Thick from the wall, the ghost, Inset,
   a refusal in words, Set, one Undo - on a Stock tube, an open box and a
   sphere with a hole. Not a test step: the ticket kept the suite to
   close:test. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.argv[2] || process.env.CLOSE_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-close-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const NSO_Stock = require('../nso_stock.js');
const stockTube = (rOut, wall, h) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), 96);
// An open box: outer X x Y x H, walls w, floor f, open at z = H (tools/nso_close_test.js's).
function openBox(X, Y, H, w, f) {
  const t = [], quad = (a, b, c, d) => { t.push(a, b, c, a, c, d); };
  const i0 = w, i1 = X - w, j0 = w, j1 = Y - w;
  quad([0, 0, 0], [0, Y, 0], [X, Y, 0], [X, 0, 0]);
  quad([0, 0, 0], [X, 0, 0], [X, 0, H], [0, 0, H]); quad([X, 0, 0], [X, Y, 0], [X, Y, H], [X, 0, H]);
  quad([X, Y, 0], [0, Y, 0], [0, Y, H], [X, Y, H]); quad([0, Y, 0], [0, 0, 0], [0, 0, H], [0, Y, H]);
  quad([0, 0, H], [X, 0, H], [i1, j0, H], [i0, j0, H]); quad([X, 0, H], [X, Y, H], [i1, j1, H], [i1, j0, H]);
  quad([X, Y, H], [0, Y, H], [i0, j1, H], [i1, j1, H]); quad([0, Y, H], [0, 0, H], [i0, j0, H], [i0, j1, H]);
  quad([i0, j0, H], [i1, j0, H], [i1, j0, f], [i0, j0, f]); quad([i1, j0, H], [i1, j1, H], [i1, j1, f], [i1, j0, f]);
  quad([i1, j1, H], [i0, j1, H], [i0, j1, f], [i1, j1, f]); quad([i0, j1, H], [i0, j0, H], [i0, j0, f], [i0, j1, f]);
  quad([i0, j0, f], [i1, j0, f], [i1, j1, f], [i0, j1, f]);
  return new Float32Array(t.flat());
}
function holedSphere(a) {
  const s = NSO_Stock.revolve(NSO_Stock.profileSphere(a, 48), 64), keep = [];
  for (let o = 0; o < s.length; o += 9) if (Math.max(s[o + 2], s[o + 5], s[o + 8]) <= 1.85 * a) for (let k = 0; k < 9; k++) keep.push(s[o + k]);
  return new Float32Array(keep);
}

const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris).join(','));
const cardState = page => page.evaluate(() => {
  const B = state.close || {}, el = id => document.getElementById(id);
  return {
    open: !!B.open, panelShown: !el('close-panel').hidden, inAdd: !!el('btn-close').closest('#menu-add'),
    thick: el('inp-close-thick').value, inset: el('inp-close-inset').value,
    readout: el('close-readout').textContent, bad: el('close-readout').classList.contains('is-bad'), goDisabled: el('btn-close-go').disabled,
    ghost: !!(B.ghost && B.ghost.parent), pick: !!(B.pick && B.pick.parent), hover: !!(B.hover && B.hover.parent),
    hoverLoops: B.hover ? B.hover.userData.loops : null, pickLoops: B.pick ? B.pick.userData.loops : null,
    ghostTris: B.ghost ? B.ghost.geometry.attributes.position.count / 3 : 0,
    resultTris: B.result && B.result.ok ? B.result.tris.length / 9 : 0
  };
});
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}
// Look down on the piece from above and to one side.
async function frame(page, elevDeg, dist) {
  await page.evaluate(([elev, dist]) => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    const e = elev * Math.PI / 180;
    state.controls.target.copy(c);
    state.camera.position.set(c.x + dist * Math.cos(e) * 0.7, c.y + dist * Math.sin(e), c.z + dist * Math.cos(e) * 0.7);
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  }, [elevDeg, dist]);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log('   screenshot ' + path.join(SHOTS, name));
}
const screenOf = (page, raw) => page.evaluate((raw) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
  mesh.updateMatrixWorld(true);
  const o = m.centerOffset, local = new THREE.Vector3(raw[0] - o.x, raw[2] - o.y, -raw[1] - o.z);
  const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  const x = r.left + (w.x + 1) / 2 * r.width, y = r.top + (1 - w.y) / 2 * r.height;
  return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
}, raw);
const frames = (page, n) => page.evaluate((n) => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

withApp(async (page, logs) => {
  console.log('\n=== 1. Close in ADD, on a Stock tube Ø20 wall 1.6 x 30 ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', stockTube(10, 1.6, 30)));
  await selectModel(page, tubeId);
  const before = await soupOf(page);
  await page.click('#btn-close');
  await page.waitForFunction(() => state.close && state.close.open, null, { timeout: 15000 });
  let P = await cardState(page);
  check('Close is in ADD; its card opens with the hint', P.inAdd && P.panelShown && /Click an open end/.test(P.readout) && P.goDisabled, P.readout);

  console.log('\n=== 2. hover outlines the rim ===');
  await frame(page, 50, 75);
  const rimPt = await screenOf(page, [9.2, 0, 30]);
  check('the rim is on the canvas', rimPt.onCanvas, JSON.stringify(rimPt));
  await page.mouse.move(rimPt.x - 3, rimPt.y - 3);
  await page.mouse.move(rimPt.x, rimPt.y);
  await page.waitForFunction(() => state.close.hover, null, { timeout: 10000 });
  await frames(page, 2);
  P = await cardState(page);
  check('hover: both loops of the rim outlined, said in words', P.hover && P.hoverLoops && P.hoverLoops[0] === 96 && P.hoverLoops[1] === 96 &&
    /Under the pointer: a Ø16\.80 opening, wall 1\.60 mm/.test(P.readout), P.readout);
  await shot(page, 'close-hover.png');
  const sidePt = await screenOf(page, [0, -10, 12]);
  await page.mouse.move(sidePt.x, sidePt.y);
  await page.waitForFunction(() => !state.close.hover, null, { timeout: 10000 });
  P = await cardState(page);
  check('hover on the outside wall: no outline, and why', !P.hover && /no opening/.test(P.readout), P.readout);
  check('hovering changes nothing', (await soupOf(page)) === before);

  console.log('\n=== 3. a click picks the rim: Thick = the wall, the ghost ===');
  await page.mouse.click(rimPt.x, rimPt.y);
  await page.waitForFunction(() => state.close.result, null, { timeout: 15000 });
  P = await cardState(page);
  console.log('   readout: ' + P.readout);
  check('Thick prefilled with the wall, 1.6', P.thick === '1.6', P.thick);
  check('flush, said in words', /lid 1\.60 mm, flush with the rim, across a Ø16\.80 opening/.test(P.readout) && !P.bad, P.readout);
  check('the ghost is the soup Set would commit; the rim marked', P.ghost && P.ghostTris === P.resultTris && P.pick && P.pickLoops[1] === 96);
  check('the click did not move or select-drag the piece', (await soupOf(page)) === before);
  await shot(page, 'close-ghost.png');

  console.log('\n=== 4. Inset, and a refusal ===');
  await setField(page, 'inp-close-inset', '2');
  P = await cardState(page);
  check('Inset 2: 2.00 mm below the rim', /lid 1\.60 mm, 2\.00 mm below the rim/.test(P.readout) && P.ghost, P.readout);
  await setField(page, 'inp-close-thick', '0.6');
  P = await cardState(page);
  check('Thick 0.6: refused, under 2 nozzle widths; no ghost, Set off', P.bad && /under 2 nozzle widths/.test(P.readout) && !P.ghost && P.goDisabled, P.readout);
  await setField(page, 'inp-close-thick', '1.6');
  await setField(page, 'inp-close-inset', '0');

  console.log('\n=== 5. Set, then one Undo ===');
  const expect = await page.evaluate(() => Array.from(state.close.result.tris).join(','));
  await page.click('#btn-close-go');
  await page.waitForFunction(() => /Close done|Close refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await statusOf(page);
  console.log('   status: ' + st);
  const after = await page.evaluate(() => { const m = getActiveModel(); return { T: NSO_bendTopology(m.rawTris), soup: Array.from(m.rawTris).join(','), h: m.size.y }; });
  check('status: Close done, with the numbers', /Close done - lid 1\.60 mm, flush with the rim, across a Ø16\.80 opening/.test(st), st);
  check('the piece is the ghost\'s soup, bit for bit; closed, 2-manifold', after.soup === expect && after.T.open === 0 && after.T.nm === 0 && after.T.flip === 0);
  check('still 30 mm tall', Math.abs(after.h - 30) < 1e-3, after.h.toFixed(3));
  P = await cardState(page);
  check('the card closed', !P.open && !P.ghost && !P.pick && !P.panelShown);
  await frame(page, 50, 75);
  await shot(page, 'close-tube-capped.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const st2 = await statusOf(page);
  check('Undo names Close; the soup is back, coordinate for coordinate', /Undo: Close reverted/.test(st2) && (await soupOf(page)) === before, st2);

  console.log('\n=== 6. an open box ===');
  const boxId = await loadSTL(page, writeSTL('box.stl', openBox(40, 30, 20, 1.6, 2)));
  await selectModel(page, boxId);
  await page.click('#btn-close');
  await page.waitForFunction(() => state.close && state.close.open, null, { timeout: 15000 });
  await frame(page, 55, 95);
  const boxPt = await screenOf(page, [20, 0.8, 20]);
  await page.mouse.click(boxPt.x, boxPt.y);
  await page.waitForFunction(() => state.close.result, null, { timeout: 15000 });
  P = await cardState(page);
  check('the box rim: a rectangular opening, Thick 1.6, the lid previewed', P.thick === '1.6' && /across a 26\.80 × 36\.80 opening/.test(P.readout) && P.ghost, P.readout);
  await shot(page, 'close-box-ghost.png');
  await page.click('#btn-close-go');
  await page.waitForFunction(() => /Close done|Close refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st3 = await statusOf(page);
  check('box: Close done', /Close done - lid 1\.60 mm, flush with the rim/.test(st3), st3);
  await shot(page, 'close-box-capped.png');

  console.log('\n=== 7. a hole in a sphere: Patch, not Close ===');
  const sphId = await loadSTL(page, writeSTL('sphere.stl', holedSphere(10)));
  await selectModel(page, sphId);
  await page.click('#btn-close');
  await page.waitForFunction(() => state.close && state.close.open, null, { timeout: 15000 });
  await frame(page, 60, 70);
  const nearHole = await page.evaluate(() => {
    const s = getActiveModel().rawTris;
    for (let o = 0; o < s.length; o += 9) if (Math.max(s[o + 2], s[o + 5], s[o + 8]) > 18.2) return [(s[o] + s[o + 3] + s[o + 6]) / 3, (s[o + 1] + s[o + 4] + s[o + 7]) / 3, (s[o + 2] + s[o + 5] + s[o + 8]) / 3];
    return null;
  });
  await page.evaluate((p) => { state.close.point = p; state.close.tri = null; NSO_closeLoad(); }, nearHole);
  P = await cardState(page);
  check('refused in words, naming Patch; nothing to Set', P.bad && P.readout === "Close: that edge isn't an open end — Patch repairs holes" && P.goDisabled && !P.ghost, P.readout);
  await page.click('#btn-close-cancel');

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
