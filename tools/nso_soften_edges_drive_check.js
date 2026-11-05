#!/usr/bin/env node
// Soften, Pick edges (app-soften-live.js + nso_box_edges.js): round or bevel
// just the box edges you click, each bake at its own radius.
//
//   node tools/nso_soften_edges_drive_check.js        exit 0 = every gate held
//
// Drives the real app in headless Chromium, with real clicks where a click is
// the thing being asked for. The piece is a 30 x 30 x 50 box - the Anti-Wobble
// Desk Spacer's body - and the target is its D-profile: the two long edges on
// one side at R 15 (a half-round the whole width of the box), the two on the
// other at R 3.
//
//   1  the controls    R and the slider reach 15; Pick edges is off by default;
//                      ticking it draws the box's twelve edges on the ghost
//   2  nothing picked  a style waits for an edge, and says so
//   3  two edges       two real clicks name two edges, the preview is the
//                      half-round (volume to the closed form), the bake
//                      installs the previewed soup bit for bit, ONE Undo step
//   4  a second bake   the other pair at R 3 is added to the first, not
//                      instead of it: the piece is the D, still ONE Undo step,
//                      and Undo gives the original box back
//   5  un-pick/clear   a second click on an edge takes it off; Clear takes all
//   6  refusals        Corners / Corners+edges say they have no edge to pick;
//                      a cylinder says it is not a box
//   7  Full wrap       with Pick edges off, the wrap is exactly as it was

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const E = require('../nso_box_edges.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

// a 30 x 30 x 50 box as an ASCII STL, centred, z the long way
function boxSTL(dir) {
  const lo = [-15, -15, -25], hi = [15, 15, 25];
  const V = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const F = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  let s = 'solid box\n';
  F.forEach(f => {
    const [a, b, c] = f.map(i => V[i]);
    const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n); n = n.map(v => v / l);
    s += 'facet normal ' + n.join(' ') + '\nouter loop\n' + [a, b, c].map(p => 'vertex ' + p.join(' ')).join('\n') + '\nendloop\nendfacet\n';
  });
  const p = path.join(dir, 'box-30x30x50.stl');
  fs.writeFileSync(p, s + 'endsolid box\n');
  return p;
}
const box = { lo: [-15, -15, -25], hi: [15, 15, 25], ext: [30, 30, 50] };
const volOf = (s) => {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [].slice.call(s, t, t + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const BOTTOM = [8, 10], TOP = [9, 11];                          // the long edges at low y, at high y
const wantPair = volOf(E.round(box, BOTTOM.map(id => ({ id, R: 15 }))).soup);
const wantD = volOf(E.round(box, BOTTOM.map(id => ({ id, R: 15 })).concat(TOP.map(id => ({ id, R: 3 })))).soup);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-edges-'));

  const info = () => page.evaluate(() => { const i = window.nsoSoftenLive.info(); if (i) delete i.soup; return i; });
  const undoDepth = () => page.evaluate(() => state.undoStack.length);
  const rawLen = () => page.evaluate(() => state.models[0].rawTris.length);
  const rawVol = () => page.evaluate(() => {
    const s = state.models[0].rawTris; let v = 0;
    for (let t = 0; t < s.length; t += 9) {
      v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
            s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
    }
    return v;
  });
  const planVol = () => page.evaluate(() => {
    const s = window.nsoSoftenLive.info().soup; let v = 0;
    for (let t = 0; t < s.length; t += 9) {
      v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
            s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
    }
    return v;
  });
  const seal = () => page.evaluate(() => nsoSealScore(state.models[0].rawTris));
  const waitPlan = (ms) => page.waitForFunction(() => { const i = window.nsoSoftenLive.info(); return !!(i && i.ok); }, null, { timeout: ms || 20000 });
  const waitText = (re) => page.waitForFunction(r => new RegExp(r).test(window.nsoSoftenLive.info().text || ''), re.source, { timeout: 15000 });
  const tile = (st) => page.click('#soften-shelf [data-style="' + st + '"]');
  const frames = (n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
  const openCard = async () => {
    const open = await page.evaluate(() => document.getElementById('menu-surface').open);
    if (!open) await page.click('#menu-surface > summary');
  };
  const status = () => page.evaluate(() => document.getElementById('status').textContent);
  const setR = async (v) => { await page.fill('#inp-soften-r', String(v)); await frames(2); };
  const lookAtPiece = async () => {
    await page.evaluate(() => {
      const p = state.placed[0], b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
      state.controls.target.copy(c);
      state.camera.position.set(c.x + 40, c.y + 55, c.z + 70);
      state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
    });
    await frames(3);
  };
  /* The screen point of an edge's midpoint (and a point a quarter along, for the nearest-edge test). */
  const screenOfEdge = (id) => page.evaluate((i) => {
    const segs = window.nsoSoftenLive.edgeSegments(), mesh = window.nsoSoftenLive.objects().mesh;
    const e = segs.find(s => s.id === i);
    mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
    const v = e.a.clone().add(e.b).multiplyScalar(0.5).applyMatrix4(mesh.matrixWorld).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }, id);
  const edgeAtPoint = (pt) => page.evaluate((p) => window.nsoSoftenLive.edgeAt({ clientX: p.x, clientY: p.y }), pt);
  const clickAt = async (s) => {
    await page.mouse.move(s.x - 3, s.y - 3);
    await page.mouse.move(s.x, s.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(450);
  };
  /* A real click on an edge's midpoint; says whether the click named the edge it was aimed at. */
  const clickEdge = async (id) => {
    const pt = await screenOfEdge(id);
    const hit = await edgeAtPoint(pt);
    await clickAt(pt);
    return hit === id;
  };
  const drawnEdgeObjects = () => page.evaluate(() => {
    let lines = 0, bars = 0;
    state.scene.traverse(o => {
      if (!o.userData || !o.userData.nsoSoftenGroup) return;
      o.children.forEach(c => { if (c.isLineSegments && c.renderOrder === 44) lines++; if (c.isMesh && c.renderOrder === 45) bars++; });
    });
    return { lines, bars };
  });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the controls ===');
  await loadSTL(page, boxSTL(tmp));
  await page.waitForTimeout(400);
  await page.evaluate(() => selectPlaced(0));
  await openCard();
  const undo0 = await undoDepth(), raw0 = await rawLen();
  check('the R box and the slider both reach 15', await page.evaluate(() =>
    document.getElementById('inp-soften-r').max === '15' && document.getElementById('inp-soften-slider').max === '15'));
  check('Pick edges is off by default, and its Clear button is hidden', await page.evaluate(() =>
    document.getElementById('chk-soften-edges').checked === false && document.getElementById('btn-soften-edges-clear').hidden === true));
  await page.click('#btn-soften');
  await page.waitForTimeout(300);
  await page.check('#chk-soften-edges');
  await page.waitForTimeout(200);
  const drawn = await drawnEdgeObjects();
  check('ticking it draws the box\'s twelve edges on the ghost (one line set, no bars yet)', drawn.lines === 1 && drawn.bars === 0, JSON.stringify(drawn));
  check('and the card knows it', (await info()).edgeMode === true && (await info()).edges.length === 0);
  await setR(15);
  check('R 15 is accepted and kept', await page.evaluate(() => document.getElementById('inp-soften-r').value === '15') && (await info()).R === 15);

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. nothing picked ===');
  await tile('fillet');
  await page.waitForTimeout(400);
  const i2 = await info();
  check('Round waits for an edge: no preview, no refusal', i2.ok === false && i2.needEdges === true && i2.reason == null, JSON.stringify({ ok: i2.ok, needEdges: i2.needEdges, reason: i2.reason }));
  check('the card says to click an edge', /click the edges to round/.test(i2.readout || ''), i2.readout);
  check('nothing was baked', (await undoDepth()) === undo0 && (await rawLen()) === raw0);

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. two edges: the half-round ===');
  await lookAtPiece();
  const aimed = [];
  for (const id of BOTTOM) aimed.push(await clickEdge(id));
  check('two real clicks each named the edge they were aimed at', aimed.every(Boolean), aimed.join());
  await waitPlan();
  const i3 = await info();
  check('the card holds those two edges', JSON.stringify(i3.edges.slice().sort((a, b) => a - b)) === JSON.stringify(BOTTOM), JSON.stringify(i3.edges));
  check('the preview is the edge round, not the wrap', i3.ok && i3.kind === 'edges' && i3.changedTris > 0, i3.text);
  check('the sentence says two edges at R 15', /2 edges rounded/.test(i3.text) && /2 at R 15\.00/.test(i3.text), i3.text);
  check('the preview volume is the half-round box\'s', near(await planVol(), wantPair, 0.5), (await planVol()).toFixed(1) + ' vs ' + wantPair.toFixed(1));
  check('and picked edges are drawn as bars', (await drawnEdgeObjects()).bars === 2);
  check('the piece is untouched while it previews', (await undoDepth()) === undo0 && (await rawLen()) === raw0);
  check('Clear is showing', await page.evaluate(() => document.getElementById('btn-soften-edges-clear').hidden === false));
  await page.evaluate(() => { window.__ghost = Array.from(window.nsoSoftenLive.info().soup); });
  await page.click('#btn-soften');
  await page.waitForTimeout(700);
  check('Soften bakes the soup that was on screen, bit for bit', await page.evaluate(() => {
    const g = window.__ghost, r = state.models[0].rawTris;
    if (!g || g.length !== r.length) return false;
    for (let k = 0; k < g.length; k++) if (g[k] !== r[k]) return false;
    return true;
  }));
  check('ONE Undo step', (await undoDepth()) === undo0 + 1, undo0 + ' -> ' + (await undoDepth()));
  check('the baked piece is closed', JSON.stringify(await seal()) === '{"open":0,"nm":0}', JSON.stringify(await seal()));
  check('the status says what was baked', /2 edges rounded/.test(await status()), await status());
  check('the card is put away', await page.evaluate(() => document.getElementById('soften-panel').hidden && !window.nsoSoftenLive.on()));

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. a second bake adds to the first ===');
  await page.click('#btn-soften');
  await page.waitForTimeout(300);
  check('the card opens with Pick edges still ticked and nothing picked', (await info()).edgeMode === true && (await info()).edges.length === 0);
  await tile('fillet');
  await setR(3);
  await page.waitForTimeout(300);
  check('R 3 waits for an edge again', (await info()).needEdges === true);
  await lookAtPiece();
  const aimed2 = [];
  for (const id of TOP) aimed2.push(await clickEdge(id));
  await waitPlan();
  const i4 = await info();
  check('the two top edges are named', JSON.stringify(i4.edges.slice().sort((a, b) => a - b)) === JSON.stringify(TOP), JSON.stringify(i4.edges) + ' aimed ' + aimed2.join());
  check('the preview carries both pairs, each at its own radius', /the piece carries 4/.test(i4.text) && /2 at R 15\.00/.test(i4.text) && /2 at R 3\.00/.test(i4.text), i4.text);
  check('its volume is the D-profile\'s', near(await planVol(), wantD, 0.5), (await planVol()).toFixed(1) + ' vs ' + wantD.toFixed(1));
  await page.click('#btn-soften');
  await page.waitForTimeout(700);
  check('the baked piece is the D', near(await rawVol(), wantD, 0.5), (await rawVol()).toFixed(1));
  check('and is closed', JSON.stringify(await seal()) === '{"open":0,"nm":0}');
  check('still ONE Undo step for the run', (await undoDepth()) === undo0 + 1, undo0 + ' -> ' + (await undoDepth()));
  await page.evaluate(() => undoLast());
  await page.waitForTimeout(400);
  check('Undo gives the original box back', (await rawLen()) === raw0 && near(await rawVol(), 45000, 1e-3), (await rawLen()) + ' floats, vol ' + (await rawVol()));

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. un-pick and clear ===');
  await page.evaluate(() => selectPlaced(0));
  await page.click('#btn-soften');
  await page.waitForTimeout(300);
  await tile('chamfer');
  await setR(2);
  await lookAtPiece();
  await clickEdge(BOTTOM[0]);
  await clickEdge(BOTTOM[1]);
  await waitPlan();
  check('Bevel with two picked edges previews', (await info()).ok && /Bevel 2 edges beveled/.test((await info()).text), (await info()).text);
  await clickEdge(BOTTOM[1]);
  await page.waitForTimeout(300);
  check('clicking a picked edge again takes it off', JSON.stringify((await info()).edges) === JSON.stringify([BOTTOM[0]]), JSON.stringify((await info()).edges));
  await page.click('#btn-soften-edges-clear');
  await page.waitForTimeout(300);
  check('Clear takes them all off, and the card waits for an edge again', (await info()).edges.length === 0 && (await info()).needEdges === true);
  check('Clear is hidden again, and no bars are left', await page.evaluate(() => document.getElementById('btn-soften-edges-clear').hidden) && (await drawnEdgeObjects()).bars === 0);
  check('a click that is nowhere near an edge names nothing', await (async () => {
    const mid = await screenOfEdge(BOTTOM[0]);
    await clickAt({ x: mid.x + 200, y: mid.y - 160 });
    return (await info()).edges.length === 0;
  })());

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. refusals ===');
  await clickEdge(BOTTOM[0]);
  for (const [st, word] of [['corners', 'Corners'], ['cornersedges', 'Corners\\+edges']]) {
    await tile(st);
    await page.waitForTimeout(400);
    const i = await info();
    check(st + ': says it has no edge to pick, and bakes nothing', i.ok === false && new RegExp(word + ' has no edge to pick').test(i.reason || ''), i.reason);
  }
  check('nothing was baked', (await undoDepth()) === undo0);
  await page.click('#btn-soften-cancel');
  await page.waitForTimeout(300);
  check('Cancel puts it all away', !(await page.evaluate(() => window.nsoSoftenLive.on())) && (await drawnEdgeObjects()).lines === 0);

  console.log('\n--- not a box');
  const cyl = await loadSTL(page, path.join(ROOT, 'fixtures', 'cylinder_r10h30_s64.stl'));
  await page.waitForTimeout(400);
  await page.evaluate((id) => { state.editId = id; }, cyl);
  await page.click('#btn-soften');
  await page.waitForTimeout(300);
  await tile('fillet');
  await page.waitForTimeout(500);
  const ic = await info();
  check('a cylinder: refused as not a box, with Pick edges ticked', ic && ic.ok === false && /not a plain box|Pick edges needs a plain box/.test((ic.reason || '') + (await status())), (ic && ic.reason) + ' | ' + (await status()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. Pick edges off: the wrap as it was ===');
  await page.evaluate(() => selectPlaced(0));
  await page.click('#btn-soften');
  await page.waitForTimeout(300);
  await page.uncheck('#chk-soften-edges');
  await tile('fillet');
  await setR(2);
  await waitPlan();
  const i7 = await info();
  check('every edge, as before', i7.ok && i7.kind === 'box' && /12 edges/.test(i7.text) && i7.edgeMode === false, i7.text);
  check('no edge bars or lines are drawn', (await drawnEdgeObjects()).lines === 0);
  await page.keyboard.press('Escape');

  const errs = logs.filter(l => /pageerror|^error/i.test(String(l.type || l)));
  check('no page errors', errs.length === 0, errs.slice(0, 3).map(e => JSON.stringify(e).slice(0, 200)).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });
