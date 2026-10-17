/* Drive check: Patch follows the surround, through the REAL app.
 *
 *   node tools/nso_patch_drive_check.js            (npm run patch:drive)
 *
 * tools/nso_patch_test.js holds the engine to its gate in node. This drives the half that
 * exists only in a browser - the pieces loaded, the fix pressed through app-patch.js's
 * nsoRepairRun (the one commit path the Findings card and ADD > Patch share), the readout the
 * person reads - and takes the before / after screenshots, to the git-ignored tools/patch-out/
 * (never committed):
 *
 *   shredded-1-before.png, -2-after.png, -3-after-wire.png     the user's sphere, one hole at a time
 *   r15-1-before.png, -2-cap.png, -3-patch.png, -4-patch-wire.png    the generated R 15 sphere, holes
 *                                  of O 2, 5, 9 and 14 mm: before, the flat cap (what Patch used to
 *                                  do to a flat rim), and Patch now
 *
 * and holds, in the page: the readout names every hole's size, the fit and how far the fill is
 * from it; the new geometry is the engine's, byte for byte (the page and node agree); every fill
 * vertex is within 0.05 mm of the sphere; the piece is closed and manifold; one Undo puts it back
 * bit for bit.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const P = require('../nso_patch.js');
const FX = require('./nso_patch_fixtures.js');

const SHOTS = path.join(__dirname, 'patch-out');
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function selectPiece(page, id) {
  await selectModel(page, id);
  await page.evaluate(i => {
    const idx = state.placed.findIndex(p => p && p.sourceId === i);
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
  }, id);
}
const rawSoup = (page, id) => page.evaluate(i => Array.from(getModelRawSoup(state.models.find(x => x.id === i))), id).then(a => new Float32Array(a));
const undoDepth = page => page.evaluate(() => state.undoStack.length);
/* raw (x, y, z) -> the display frame the camera lives in: (x, z, -y) */
const toDisplayDir = v => [v[0], v[2], -v[1]];

/* The camera at distance `dist` from the piece's middle, on the side of `dir` (display frame). */
async function aim(page, dir, dist) {
  await page.evaluate(([d, dd]) => {
    const m = getActiveModel(), p = state.placed.find(q => q && q.sourceId === m.id);
    p.mesh.updateMatrixWorld(true);
    const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
    const v = new THREE.Vector3(d[0], d[1], d[2]).normalize();
    state.controls.target.copy(c);
    state.camera.position.copy(c.clone().add(v.multiplyScalar(dd)));
    state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
  }, [dir, dist]);
}
async function wire(page, on) {
  await page.evaluate(w => {
    const m = getActiveModel(), p = state.placed.find(q => q && q.sourceId === m.id);
    p.mesh.material.wireframe = w; p.mesh.material.needsUpdate = true;
  }, on);
}
async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.querySelectorAll('details.vp-menu').forEach(x => { x.open = false; }));
  await page.waitForTimeout(700);
  const box = await page.evaluate(() => { const r = state.renderer.domElement.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  await page.screenshot({ path: path.join(SHOTS, name), clip: box });
  return path.join('tools', 'patch-out', name);
}
const dirOfLoop = (loop, centre) => {
  const s = [0, 0, 0];
  loop.pts.forEach(p => { const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]], l = Math.hypot(...d); for (let k = 0; k < 3; k++) s[k] += d[k] / l; });
  return toDisplayDir(s);
};
const offFrom = (soup, from, to, centre, R) => {
  let worst = 0;
  for (let t = from; t < to; t++) for (let k = 0; k < 3; k++) {
    const o = t * 9 + k * 3;
    worst = Math.max(worst, Math.abs(Math.hypot(soup[o] - centre[0], soup[o + 1] - centre[1], soup[o + 2] - centre[2]) - R));
  }
  return worst;
};

withApp(async (page, logs) => {
  console.log('patch drive check\n');

  /* ------------------------------------------------------------------ the user's sphere */
  console.log('1. the user\'s sphere: fixtures/damage/shape-sphere_holes-shredded.stl');
  {
    const file = path.join(ROOT, 'fixtures', 'damage', 'shape-sphere_holes-shredded.stl');
    const id = await loadSTL(page, file);
    await selectPiece(page, id);
    const soup0 = await rawSoup(page, id), d0 = await undoDepth(page);
    check('the page holds the file\'s triangles', same(soup0, new Float32Array(readSTL(file))), soup0.length / 9 + ' triangles');
    const C = [0, 0, 4.822], loops = P.loops(soup0);
    const big = [loops[1], loops[0]];                                   // the 64-edge loop first: the easier view
    await wire(page, false);
    await aim(page, dirOfLoop(big[0], C), 24);
    const shots = [await shot(page, 'shredded-1-before.png')];
    const res = await page.evaluate(anchors => nsoRepairRun({ fix: 'patch', anchors: anchors }), loops.map(l => l.pts[0]));
    check('Patch ran through the app, on all six loops', res.ok && res.fix === 'patch', res.reason || res.text.slice(0, 120));
    console.log('     the readout:\n       ' + res.holes.join('\n       '));
    check('one readout line per hole', res.holes.length === 6 && res.holes.every(h => /^Ø\d+\.\d mm hole: /.test(h)));
    check('the two big holes say: sphere, R 4.82', /sphere R 4\.82 mm/.test(res.holes[0]) && /sphere R 4\.82 mm/.test(res.holes[1]), res.holes.slice(0, 2).join(' | '));
    check('and every hole that found no fit says NO SURFACE FIT and what it did instead',
          res.holes.every(h => !/NO SURFACE FIT/.test(h) || /(faired from the rim slopes, not on a fit|filled FLAT)$/.test(h)));
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    check('the status line carries it', /sphere R 4\.82 mm/.test(status) && /open edges 221→0/.test(status), status.slice(0, 160));
    const soup1 = await rawSoup(page, id);
    const node = P.patch(soup0, loops.map(l => l.id));
    check('the page\'s geometry is the engine\'s, byte for byte (the page and node agree)', node.ok && same(soup1, node.soup));
    const n0 = soup0.length / 9;
    const t0 = n0, t1 = n0 + node.filled[0].tris, t2 = t1 + node.filled[1].tris;
    check('the first two fills (the big holes) stand on R 4.822 within 0.05 mm', offFrom(soup1, t0, t2, C, 4.822) < 0.05, offFrom(soup1, t0, t2, C, 4.822).toExponential(2) + ' mm');
    const topo = P.topology(soup1);
    check('closed, manifold, wound one way', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, JSON.stringify(topo));
    check('one Undo of its own type', (await undoDepth(page)) === d0 + 1 && (await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type)) === 'patchReplace');
    await aim(page, dirOfLoop(big[0], C), 24);
    shots.push(await shot(page, 'shredded-2-after.png'));
    await wire(page, true);
    shots.push(await shot(page, 'shredded-3-after-wire.png'));
    await wire(page, false);
    await page.click('#btn-undo');
    check('Undo puts the piece back bit for bit', same(await rawSoup(page, id), soup0));
    // the other big hole, from its own side
    await aim(page, dirOfLoop(big[1], C), 24);
    shots.push(await shot(page, 'shredded-4-before-other-side.png'));
    await page.evaluate(anchors => nsoRepairRun({ fix: 'patch', anchors: anchors }), loops.map(l => l.pts[0]));
    shots.push(await shot(page, 'shredded-5-after-other-side.png'));
    await wire(page, true);
    shots.push(await shot(page, 'shredded-6-after-other-side-wire.png'));
    await wire(page, false);
    console.log('     screenshots: ' + shots.join(', '));
  }

  /* ------------------------------------------------------------------ R 15 */
  console.log('\n2. a generated sphere R 15 with holes of O 2, 5, 9 and 14 mm');
  {
    const soup = FX.sphereWithHoles(), file = path.join(os.tmpdir(), 'nso-patch-drive-r15-' + process.pid + '.stl');
    writeSTL(file, soup, 'nso patch drive R15');
    let id;
    try { id = await loadSTL(page, file); } finally { try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
    await selectPiece(page, id);
    const soup0 = await rawSoup(page, id), d0 = await undoDepth(page);
    check('the page holds the fixture', same(soup0, soup), soup0.length / 9 + ' triangles');
    const loops = P.loops(soup0), anchors = loops.map(l => l.pts[0]);
    const seen = [], dir14 = toDisplayDir(FX.HOLES[3].axis), dir9 = toDisplayDir(FX.HOLES[2].axis);
    // two views: the O 14 hole from above, and the O 9 hole from the side (it is 90 degrees round)
    const views = [['14', dir14, 75], ['9', dir9, 75]];
    for (const [nm, dir, dist] of views) { await aim(page, dir, dist); seen.push(await shot(page, 'r15-1-before-' + nm + '.png')); }
    // the flat cap: what Patch did to a flat rim before the surround decided
    const cap = await page.evaluate(a => nsoRepairRun({ fix: 'cap', anchors: a }), anchors);
    check('CAP ran (the old behaviour on these flat rims)', cap.ok, cap.reason);
    for (const [nm, dir, dist] of views) { await aim(page, dir, dist); seen.push(await shot(page, 'r15-2-cap-' + nm + '.png')); }
    await page.click('#btn-undo');
    check('Undo of the cap puts it back bit for bit', same(await rawSoup(page, id), soup0));
    const res = await page.evaluate(a => nsoRepairRun({ fix: 'patch', anchors: a }), anchors);
    check('Patch ran on all four', res.ok, res.reason);
    console.log('     the readout:\n       ' + (res.holes || []).join('\n       '));
    check('one readout line per hole, each a sphere of radius ~15 with its fill within 0.05 mm of the fit',
          res.holes.length === 4 && res.holes.every(h => /sphere R 15\.\d\d mm \(fit rms 0\.00\d mm\), fill within 0\.00\d mm of it$/.test(h)), res.holes.join(' | '));
    check('in size order O 14, 9, 5, 2', ['14.0', '9.0', '5.0', '2.0'].every((d, i) => res.holes[i].indexOf('Ø' + d + ' mm') === 0), res.holes.map(h => h.slice(0, 8)).join(', '));
    const soup1 = await rawSoup(page, id), node = P.patch(soup0, loops.map(l => l.id));
    check('the page\'s geometry is the engine\'s, byte for byte', node.ok && same(soup1, node.soup));
    const worst = offFrom(soup1, soup0.length / 9, soup1.length / 9, [0, 0, 0], FX.R);
    check('every fill vertex is within 0.05 mm of R 15', worst < 0.05, worst.toExponential(2) + ' mm');
    const topo = P.topology(soup1);
    check('closed, manifold, one shell, Euler 2', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === 1 && topo.euler === 2, JSON.stringify(topo));
    check('nothing outside the holes moved: the piece\'s own triangles are kept byte for byte', same(soup1.subarray(0, soup0.length), soup0));
    check('one Undo, of its own type', (await undoDepth(page)) === d0 + 1 && (await page.evaluate(() => state.undoStack[state.undoStack.length - 1].type)) === 'patchReplace');
    for (const [nm, dir, dist] of views) { await aim(page, dir, dist); seen.push(await shot(page, 'r15-3-patch-' + nm + '.png')); }
    await wire(page, true);
    for (const [nm, dir, dist] of views) { await aim(page, dir, dist); seen.push(await shot(page, 'r15-4-patch-wire-' + nm + '.png')); }
    await wire(page, false);
    await page.click('#btn-undo');
    check('Undo puts the piece back bit for bit', same(await rawSoup(page, id), soup0));
    console.log('     screenshots: ' + seen.join(', '));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails += errs.length; }
  console.log('\n----------------------------------------------------------');
  console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });
