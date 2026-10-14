#!/usr/bin/env node
/* Bend, driven through the real app: real index.html, real script tags, real
   clicks, real Undo.
     node tools/nso_bend_drive_check.js        exit 0 = every gate held

   The geometry is proven headless in tools/nso_bend_test.js. What this file
   proves is the panel: the button opens it next to Extend, the ghost on the
   piece is the very soup Bend commits, the marker stands on Where, a click on
   the piece sets Where, a refusal is said in words and takes the ghost away,
   Bend bakes and re-seats the piece, one Undo restores it bit for bit, Cut
   still splits a bent piece into two closed halves, and paint stands it down.
   Fixtures are generated here and written to a temp directory. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-bend-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
function box(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap(t => t.flatMap(i => v[i])));
}
const circle = (cy, cz, r, n) => Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n; return [cy + r * Math.cos(a), cz + r * Math.sin(a)]; });
function roundTube(len, n) {
  const O = circle(20, 10, 8, n), I = circle(20, 10, 6, n), t = [];
  for (const lp of [O, I.slice().reverse()]) for (let i = 0; i < lp.length; i++) {
    const p = lp[i], q = lp[(i + 1) % lp.length];
    t.push([0, p[0], p[1]], [0, q[0], q[1]], [len, q[0], q[1]], [0, p[0], p[1]], [len, q[0], q[1]], [len, p[0], p[1]]);
  }
  for (const [x, far] of [[len, true], [0, false]]) for (let i = 0; i < n; i++) {
    const O0 = O[i], O1 = O[(i + 1) % n], I0 = I[i], I1 = I[(i + 1) % n];
    for (const tr of [[[x, O0[0], O0[1]], [x, O1[0], O1[1]], [x, I1[0], I1[1]]], [[x, O0[0], O0[1]], [x, I1[0], I1[1]], [x, I0[0], I0[1]]]])
      far ? t.push(...tr) : t.push(tr[0], tr[2], tr[1]);
  }
  return new Float32Array(t.flat());
}
// 100k triangles: a 64-sided rod whose end caps are fine polar grids.
function detailedRod(len, rings) {
  const n = 64, t = [], ring = j => circle(0, 6, 5 * j / rings, n), O = ring(rings);
  for (let i = 0; i < n; i++) {
    const p = O[i], q = O[(i + 1) % n];
    t.push([0, p[0], p[1]], [0, q[0], q[1]], [len, q[0], q[1]], [0, p[0], p[1]], [len, q[0], q[1]], [len, p[0], p[1]]);
  }
  for (const [x, far] of [[len, true], [0, false]]) for (let j = 0; j < rings; j++) {
    const A = j === 0 ? null : ring(j), B = ring(j + 1);
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const tri = A ? [[[x, A[i][0], A[i][1]], [x, B[i][0], B[i][1]], [x, B[i2][0], B[i2][1]]], [[x, A[i][0], A[i][1]], [x, B[i2][0], B[i2][1]], [x, A[i2][0], A[i2][1]]]]
                    : [[[x, 0, 6], [x, B[i][0], B[i][1]], [x, B[i2][0], B[i2][1]]]];
      for (const tr of tri) far ? t.push(...tr) : t.push(tr[0], tr[2], tr[1]);
    }
  }
  return new Float32Array(t.flat());
}

const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris).join(','));
const panelState = page => page.evaluate(() => {
  const B = state.bend || {}, el = id => document.getElementById(id);
  return {
    open: !!B.open, hidden: el('bend-panel').hidden,
    where: el('inp-bend-where').value, angle: el('inp-bend-angle').value, radius: el('inp-bend-radius').value,
    radiusHint: el('inp-bend-radius').placeholder, toward: el('sel-bend-toward').value,
    options: [...el('sel-bend-toward').options].map(o => o.value + ':' + o.textContent),
    rollShown: !el('bend-roll-row').hidden,
    readout: el('bend-readout').textContent, bad: el('bend-readout').classList.contains('is-bad'),
    goDisabled: el('btn-bend-go').disabled,
    ghost: !!(B.ghost && B.ghost.parent), marker: !!(B.marker && B.marker.parent),
    ghostTris: B.ghost ? B.ghost.geometry.attributes.position.count / 3 : 0,
    resultTris: B.result && B.result.ok ? B.result.tris.length / 9 : 0,
    ghostMat: B.ghost ? { color: B.ghost.material.color.getHex(), opacity: B.ghost.material.opacity, transparent: B.ghost.material.transparent } : null,
    markerPlane: B.marker ? B.marker.userData.plane : null,
    markerDepth: B.marker ? B.marker.children.every(o => o.material.depthTest === false) : null
  };
});
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the button, in the top row\'s Bend menu (shell v2; was Finish -> Shape) ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-bend');
    const menu = b && b.closest('.vp-shell-menu');
    return { btn: !!b, wired: b && b.dataset.nsoWired === '1', menu: menu && menu.id,
             inRow: !!(menu && menu.closest('.vp-shell-row')),
             panelWithIt: !!(menu && menu.contains(document.getElementById('bend-panel'))),
             notInShape: !document.getElementById('menu-shape').contains(b),
             panelHidden: document.getElementById('bend-panel').hidden };
  });
  check('#btn-bend is in the top row\'s Bend menu, with its panel', ui.btn && ui.menu === 'menu-bend' && ui.inRow && ui.panelWithIt,
        JSON.stringify(ui));
  check('...and no longer in Shape', ui.notInShape);
  check('...wired at load, its panel shut', ui.wired && ui.panelHidden);

  console.log('\n=== 2. open on a plate 3 x 60 x 150: defaults, ghost, marker ===');
  const plateId = await loadSTL(page, writeSTL('plate.stl', box(0, 0, 0, 150, 60, 3)));
  await selectModel(page, plateId);
  await openFinishMenu(page);
  const before = await soupOf(page);
  const sizeBefore = await page.evaluate(() => getActiveModel().size.y);
  await page.click('#btn-bend');
  await page.waitForFunction(() => state.bend && state.bend.open && state.bend.result, null, { timeout: 30000 });
  let P = await panelState(page);
  console.log('   readout: ' + P.readout);
  check('the panel opens', P.open && !P.hidden);
  check('Where defaults to the middle of the straight band (75.0)', P.where === '75.0', P.where);
  check('Angle 90, Radius blank with the auto value as its hint (7.5)', P.angle === '90' && P.radius === '' && /auto 7\.5/.test(P.radiusHint), P.radiusHint);
  check('Toward offers the four sides, Up first and chosen', P.toward === '+Z' && P.options.length === 4 && /Up/.test(P.options[0]), P.options.join(' | '));
  check('no Roll for a rectangular section', !P.rollShown);
  check('the readout states the bend', /90° toward \+Z at 75\.0 mm, radius 7\.50 mm/.test(P.readout) && !P.bad, P.readout);
  check('the ghost is on the piece, the soup Bend would commit', P.ghost && P.ghostTris === P.resultTris && P.ghostTris > 12, P.ghostTris + ' triangles');
  check('...drawn as Crop\'s lifted ghost is (amber, 0.75)', P.ghostMat && P.ghostMat.color === 0xf59e0b && P.ghostMat.opacity === 0.75 && P.ghostMat.transparent);
  const wantPlane = await page.evaluate(() => 75 - getActiveModel().centerOffset.x);
  check('the marker stands across X at Where, read through the piece', P.marker && P.markerPlane.axis === 'x' &&
        Math.abs(P.markerPlane.value - wantPlane) < 1e-6 && P.markerDepth, JSON.stringify(P.markerPlane));
  const pieceUntouched = (await soupOf(page)) === before;
  check('opening the panel changes nothing', pieceUntouched);

  console.log('\n=== 3. a click on the piece sets Where ===');
  const pt = await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    state.controls.target.copy(c);
    state.camera.position.set(c.x + 0.01, c.y + 260, c.z + 0.01);
    state.controls.update();
    state.camera.updateMatrixWorld(true);
    // raw x = 40, on the plate's top face, in the piece's display frame.
    const local = new THREE.Vector3(40 - m.centerOffset.x, 3 - m.centerOffset.y, -30 - m.centerOffset.z);
    const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    const x = r.left + (w.x + 1) / 2 * r.width, y = r.top + (1 - w.y) / 2 * r.height;
    return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
  });
  check('the point is on the canvas', pt.onCanvas, JSON.stringify(pt));
  const placedBefore = await page.evaluate(() => { const p = state.placed.find(q => q.sourceId === getActiveModel().id); return [p.x, p.z]; });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => document.getElementById('inp-bend-where').value !== '75.0', null, { timeout: 10000 });
  P = await panelState(page);
  const placedAfter = await page.evaluate(() => { const p = state.placed.find(q => q.sourceId === getActiveModel().id); return [p.x, p.z]; });
  check('Where follows the click to 40 mm (within a pixel)', Math.abs(+P.where - 40) <= 0.6, P.where);
  check('...and the ghost and the marker follow it', P.ghost && /at 40\.\d mm|at 39\.\d mm/.test(P.readout) &&
        Math.abs(P.markerPlane.value - (await page.evaluate(w => w - getActiveModel().centerOffset.x, +P.where))) < 1e-6, P.readout);
  check('the click did not drag the piece', placedBefore[0] === placedAfter[0] && placedBefore[1] === placedAfter[1]);
  await setField(page, 'inp-bend-where', '75');

  console.log('\n=== 4. a refusal takes the ghost away and says why ===');
  await setField(page, 'inp-bend-radius', '1');
  P = await panelState(page);
  console.log('   readout: ' + P.readout);
  check('radius 1 is refused in words, naming the smallest that works', P.bad && /smallest radius that works is 1\.51 mm/.test(P.readout));
  check('...the ghost goes, Bend is disabled, the marker stays', !P.ghost && P.goDisabled && P.marker);
  await setField(page, 'inp-bend-where', '2');
  await setField(page, 'inp-bend-radius', '');
  P = await panelState(page);
  check('a zone that does not fit names where to move Where', P.bad && /Move Where 4\.0 mm, to 6\.0 mm/.test(P.readout), P.readout);
  await setField(page, 'inp-bend-where', '75');
  await setField(page, 'inp-bend-angle', '180');
  P = await panelState(page);
  check('180° is good again and the ghost is back', !P.bad && P.ghost && !P.goDisabled, P.readout);
  await setField(page, 'inp-bend-angle', '90');

  console.log('\n=== 5. Bend: one bake, re-seated, standing up ===');
  const expect = await page.evaluate(() => Array.from(state.bend.result.tris).join(','));
  await page.click('#btn-bend-go');
  await page.waitForFunction(() => /Bend done|Bend refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await statusOf(page);
  console.log('   status: ' + st);
  const after = await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id);
    p.mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(p.mesh);
    return { T: NSO_bendTopology(m.rawTris), h: m.size.y, minY: bb.min.y, soup: Array.from(m.rawTris).join(','),
             open: state.bend.open, ghost: !!state.bend.ghost, marker: !!state.bend.marker };
  });
  check('status: Bend done, with the numbers', /Bend done - 90° toward \+Z at 75\.0 mm, radius 7\.50 mm; 12 → 492 faces/.test(st), st);
  check('the piece is the ghost\'s soup, bit for bit', after.soup === expect);
  check('closed, 2-manifold, consistently wound', after.T.open === 0 && after.T.nm === 0 && after.T.flip === 0 && after.T.euler === 2, JSON.stringify(after.T));
  check('it now stands up off the plate, and the status says so', after.h > sizeBefore + 50 && /now stands \d+\.\d mm tall \(was 3\.0 mm\)/.test(st),
        sizeBefore.toFixed(1) + ' -> ' + after.h.toFixed(1) + ' mm');
  check('re-seated on the plate the way any bake is', after.minY >= 0 && after.minY < 1, 'lowest point at y ' + after.minY.toFixed(3));
  check('the panel closed, ghost and marker gone', !after.open && !after.ghost && !after.marker);

  console.log('\n=== 6. one Undo puts it back, bit for bit ===');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const st2 = await statusOf(page);
  check('Undo names Bend', /Undo: Bend reverted/.test(st2), st2);
  check('the whole soup is back, coordinate for coordinate', (await soupOf(page)) === before);
  check('...and its height', Math.abs((await page.evaluate(() => getActiveModel().size.y)) - sizeBefore) < 1e-9);

  console.log('\n=== 7. Cut still works on a bent piece ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', roundTube(120, 48)));
  await selectModel(page, tubeId);
  const rb = await page.evaluate(() => NSO_bendSelectedModel({ where: 60, angle: 90, toward: '+Y' }));
  check('the tube bends 90° toward +Y', rb.ok, rb.ok ? '' : rb.reason);
  await page.evaluate(() => {
    const e = document.getElementById('cutter-tools');
    for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });
  if (!(await page.evaluate(() => cutterArmed('cut')))) await page.evaluate(() => openCutter('cut'));
  const cut = await page.evaluate(id => {
    const idx = state.placed.findIndex(p => p && p.sourceId === id);
    selectPlaced(idx);
    state.cutAxis = 'x';
    state.cutT = 0.25;
    buildCutHelper();
    const before = state.models.map(m => m.id);
    document.getElementById('btn-cut').click();
    const fresh = state.models.filter(m => !before.includes(m.id));
    return { status: document.getElementById('status').textContent,
             halves: fresh.map(m => { const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
               return NSO_bendTopology(m.rawTris || new Float32Array(g.attributes.position.array)); }) };
  }, tubeId);
  console.log('   status: ' + cut.status);
  check('Split makes two pieces', cut.halves.length === 2, cut.halves.length + ' new');
  check('...each closed and 2-manifold', cut.halves.length === 2 && cut.halves.every(T => T.open === 0 && T.nm === 0 && T.flip === 0),
        cut.halves.map(T => T.tris + ' tris, open ' + T.open + ', nm ' + T.nm).join(' | '));
  await page.evaluate(() => { if (state.cutterOpen) closeCutter(true); });

  console.log('\n=== 8. paint stands it down ===');
  await selectModel(page, plateId);
  await page.evaluate(() => { getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 3, axisIdx: 2, keepMin: false, inner: false }] }; });
  const pr = await page.evaluate(() => NSO_bendSelectedModel({ where: 75, angle: 90, toward: '+Z' }));
  const st3 = await statusOf(page);
  check('declined, naming the painted count', !pr.ok && /Bend stood down - 1 painted face/.test(st3), st3);
  check('...piece unchanged', (await soupOf(page)) === before);
  await page.evaluate(() => { getActiveModel().faceMask = null; });

  console.log('\n=== 9. time, in the browser ===');
  const bigId = await loadSTL(page, writeSTL('rod100k.stl', detailedRod(100, 391)));
  await selectModel(page, bigId);
  const tm = await page.evaluate(() => {
    const s = getActiveModel().rawTris, runs = [];
    let r;
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); r = NSO_bendRaw(s, { where: 50, angle: 90, toward: '+Z' }); runs.push(performance.now() - t0); }
    const t1 = performance.now(); NSO_bendSelectedModel({ where: 50, angle: 90, toward: '+Z' }); const commit = performance.now() - t1;
    return { tris: s.length / 9, out: r.ok ? r.counts.trisOut : r.reason, runs, commit };
  });
  console.log('   ' + tm.tris + ' -> ' + tm.out + ' triangles; NSO_bendRaw ' + tm.runs.map(x => x.toFixed(0) + ' ms').join(', ') +
              '; bend + commit + redraw ' + tm.commit.toFixed(0) + ' ms');
  check('a 100k-triangle piece bends in the page', tm.tris >= 100000 && typeof tm.out === 'number', String(tm.out));

  console.log('\n=== 10. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
