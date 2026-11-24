#!/usr/bin/env node
// Soften, Pick edges on a piece that is NOT a box (app-soften-live.js +
// softenMeshEdges in app-finish.js + nso_mesh_edges.js).
//
//   node tools/nso_soften_mesh_edges_drive_check.js        exit 0 = every gate held
//
// Drives the real app in headless Chromium. The piece is a 60 x 2 x 20 wall
// with a 20 x 12 notch out of its top - the drawer wall a finger goes into -
// which Soften used to refuse ("Pick edges needs a plain box").
//
//   1  the lines     Pick edges draws the piece's sharp edges, more than a box's 12
//   2  a click       a real click on the notch floor's rim names it; Round previews
//                    it through the boolean kernel; the piece is untouched
//   3  the notch     every notch rim and both inside corners: the preview is
//                    closed, the bake installs it bit for bit, ONE Undo step
//   4  second bake   a top rim at another R is added, the notch kept: still
//                    ONE Undo step, and Undo gives the notched wall back
//   5  early press   Soften pressed while the kernel is still working bakes the
//                    preview when it lands, instead of asking to be pressed again

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL } = require('./nso_app_harness');
const { csgContext } = require('./nso_csg_node.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
function stlOf(soup, file) {
  let s = 'solid wall\n';
  for (let t = 0; t < soup.length; t += 9) {
    const a = [soup[t], soup[t + 1], soup[t + 2]], b = [soup[t + 3], soup[t + 4], soup[t + 5]], c = [soup[t + 6], soup[t + 7], soup[t + 8]];
    const u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1; n = n.map(v => v / l);
    s += 'facet normal ' + n.join(' ') + '\nouter loop\n' + [a, b, c].map(p => 'vertex ' + p.join(' ')).join('\n') + '\nendloop\nendfacet\n';
  }
  fs.writeFileSync(file, s + 'endsolid wall\n');
  return file;
}

(async () => {
  const csg = csgContext();
  const wall = await csg.nsoSubtractSoups(box([0, 0, 0], [60, 2, 20]), box([20, -1, 8], [40, 3, 21]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-mesh-edges-'));
  const stl = stlOf(wall.soup, path.join(tmp, 'notched-wall.stl'));

  await withApp(async (page, logs) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const info = () => page.evaluate(() => { const i = window.nsoSoftenLive.info(); if (i) delete i.soup; return i; });
    const undoDepth = () => page.evaluate(() => state.undoStack.length);
    const rawVol = () => page.evaluate(() => {
      const s = state.models[0].rawTris; let v = 0;
      for (let t = 0; t < s.length; t += 9) {
        v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
              s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
      }
      return v;
    });
    const seal = () => page.evaluate(() => nsoSealScore(state.models[0].rawTris));
    const planSeal = () => page.evaluate(() => nsoSealScore(window.nsoSoftenLive.info().soup));
    const waitPlan = (ms) => page.waitForFunction(() => { const i = window.nsoSoftenLive.info(); return !!(i && i.ok && !i.waiting); }, null, { timeout: ms || 30000 });
    const tile = (st) => page.click('#soften-shelf [data-style="' + st + '"]');
    const frames = (n) => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n || 2);
    const setR = async (v) => { await page.fill('#inp-soften-r', String(v)); await frames(2); };
    const status = () => page.evaluate(() => document.getElementById('status').textContent);
    const openCard = async () => {
      const open = await page.evaluate(() => document.getElementById('menu-surface').open);
      if (!open) await page.click('#menu-surface > summary');
    };
    /* The notch's lines, in the raw frame: relative to the raw bounding box, so the
       loader's centring does not matter. */
    const notchLines = () => page.evaluate(() => {
      const s = state.models[0].softenRun && state.models[0].rawTris === state.models[0].softenRun.result
        ? state.models[0].softenRun.base : state.models[0].rawTris;
      const lo = [Infinity, Infinity, Infinity];
      for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], s[i + k]);
      const rel = (p) => p.map((v, k) => v - lo[k]);
      const inN = (p) => { const q = rel(p); return q[0] > 20 - 1e-3 && q[0] < 40 + 1e-3 && q[2] > 8 - 1e-3; };
      return nsoMeshEdgeLines(s).filter(l => inN(l.p0) && inN(l.p1))
        .map(l => ({ id: l.id, convex: l.convex, a: rel(l.p0), b: rel(l.p1), len: l.len }));
    });
    const lookAt = async () => {
      await page.evaluate(() => {
        const p = state.placed[0], b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
        state.controls.target.copy(c);
        state.camera.position.set(c.x + 25, c.y + 45, c.z + 60);
        state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
      });
      await frames(3);
    };
    const screenOfEdge = (id) => page.evaluate((i) => {
      const segs = window.nsoSoftenLive.edgeSegments(), mesh = window.nsoSoftenLive.objects().mesh;
      const e = segs.find(s => s.id === i);
      mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
      const v = e.a.clone().add(e.b).multiplyScalar(0.5).applyMatrix4(mesh.matrixWorld).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    }, id);

    /* ---------------------------------------------------------------- 1 */
    console.log('\n=== 1. the lines ===');
    await loadSTL(page, stl);
    await page.waitForTimeout(400);
    await page.evaluate(() => selectPlaced(0));
    await openCard();
    const undo0 = await undoDepth(), vol0 = await rawVol();
    await page.click('#btn-soften');
    await page.waitForTimeout(300);
    await page.check('#chk-soften-edges');
    await page.waitForTimeout(200);
    const segs = await page.evaluate(() => (window.nsoSoftenLive.edgeSegments() || []).length);
    check('Pick edges draws the piece\'s sharp edges - more than a box has', segs > 12, segs + ' edges');
    await tile('fillet');
    await page.waitForTimeout(300);
    const i1 = await info();
    check('Round waits for an edge, it does not refuse the piece', i1.needEdges === true && !i1.reason, JSON.stringify({ needEdges: i1.needEdges, reason: i1.reason }));
    const notch = await notchLines();
    const rims = notch.filter(l => l.convex), corners = notch.filter(l => !l.convex);
    check('the notch reads as 8 rims and 2 inside corners', rims.length === 8 && corners.length === 2, rims.length + ' / ' + corners.length);

    /* ---------------------------------------------------------------- 2 */
    console.log('\n=== 2. a real click ===');
    await setR(0.5);
    await lookAt();
    const floor = rims.find(l => Math.abs(l.a[2] - 8) < 1e-3 && Math.abs(l.b[2] - 8) < 1e-3);
    const pt = await screenOfEdge(floor.id);
    const aimed = await page.evaluate((p) => window.nsoSoftenLive.edgeAt({ clientX: p.x, clientY: p.y }), pt);
    await page.mouse.move(pt.x - 3, pt.y - 3); await page.mouse.move(pt.x, pt.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(450);
    check('a click on the notch floor\'s rim names it', aimed === floor.id && (await info()).edges.indexOf(floor.id) >= 0, aimed + ' vs ' + floor.id);
    await waitPlan();
    const i2 = await info();
    check('the preview is the edge round', i2.ok && i2.kind === 'edges' && /1 edge rounded/.test(i2.text || ''), i2.text);
    check('the preview is closed', JSON.stringify(await planSeal()) === '{"open":0,"nm":0}');
    check('the piece is untouched while it previews', (await undoDepth()) === undo0 && Math.abs((await rawVol()) - vol0) < 1e-6);

    /* ---------------------------------------------------------------- 3 */
    console.log('\n=== 3. the whole notch ===');
    for (const l of notch) if (l.id !== floor.id) await page.evaluate((id) => window.nsoSoftenLive.pickEdge(id), l.id);
    await page.waitForTimeout(100);
    await waitPlan();
    const i3 = await info();
    check('all ten picked, the preview says so', i3.edges.length === 10 && /10 edges rounded/.test(i3.text || '') && /2 inside corners filled/.test(i3.text || ''), i3.text);
    check('the preview is closed', JSON.stringify(await planSeal()) === '{"open":0,"nm":0}', JSON.stringify(await planSeal()));
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
    const vol1 = await rawVol();
    check('material came off the rims (more than the corners put back)', vol1 < vol0 - 0.5, (vol0 - vol1).toFixed(3) + ' mm3');
    check('the status says what was baked', /10 edges rounded/.test(await status()), await status());

    /* ---------------------------------------------------------------- 4 */
    console.log('\n=== 4. a second bake adds to the first ===');
    await page.click('#btn-soften');
    await page.waitForTimeout(300);
    await tile('fillet');
    await setR(0.8);
    const allLines = await page.evaluate(() => nsoMeshEdgeLines(state.models[0].softenRun.base).length);
    const topRim = await page.evaluate(() => {
      const s = state.models[0].softenRun.base, lo = [Infinity, Infinity, Infinity];
      for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], s[i + k]);
      // the wall top's front rim left of the notch: z = 20, y = 0, x 0..20
      const l = nsoMeshEdgeLines(s).find(l => l.convex && Math.abs(l.p0[2] - lo[2] - 20) < 1e-3 && Math.abs(l.p1[2] - lo[2] - 20) < 1e-3 &&
        Math.abs(l.p0[1] - lo[1]) < 1e-3 && Math.abs(l.p1[1] - lo[1]) < 1e-3 && Math.max(l.p0[0], l.p1[0]) - lo[0] < 20 + 1e-3);
      return l ? l.id : -1;
    });
    check('the edges are read off the run\'s base: same list as before', allLines === segs && topRim >= 0, allLines + ' / ' + segs);
    await page.evaluate((id) => window.nsoSoftenLive.pickEdge(id), topRim);
    await waitPlan();
    const i4 = await info();
    check('the preview carries the notch and the new rim, each at its own R', /carries 11/.test(i4.text || '') && /10 at R 0\.50/.test(i4.text || '') && /1 at R 0\.80/.test(i4.text || ''), i4.text);
    await page.click('#btn-soften');
    await page.waitForTimeout(700);
    check('baked: closed, still ONE Undo step', JSON.stringify(await seal()) === '{"open":0,"nm":0}' && (await undoDepth()) === undo0 + 1);
    check('and more came off', (await rawVol()) < vol1 - 0.01, ((await rawVol()) - vol1).toFixed(3) + ' | ' + (await status()) + ' | on ' + (await page.evaluate(() => window.nsoSoftenLive.on())));
    await page.evaluate(() => { if (typeof undo === 'function') undo(); else document.getElementById('btn-undo').click(); });
    await page.waitForTimeout(500);
    check('Undo gives the notched wall back', Math.abs((await rawVol()) - vol0) < 1e-3 && (await undoDepth()) === undo0, (await rawVol()).toFixed(3) + ' vs ' + vol0.toFixed(3));

    /* ---------------------------------------------------------------- 5 */
    console.log('\n=== 5. Soften pressed before the preview lands ===');
    const undo5 = await undoDepth();
    await page.click('#btn-soften');
    await page.waitForTimeout(300);
    await tile('chamfer');
    await setR(0.3);
    await page.evaluate((id) => window.nsoSoftenLive.pickEdge(id), floor.id);
    const r5 = await page.evaluate(() => window.nsoSoftenLive.bake());
    check('a press while the kernel works is taken, not refused', r5.ok || r5.queued === true, JSON.stringify({ ok: r5.ok, queued: r5.queued }));
    await page.waitForFunction(() => !window.nsoSoftenLive.on(), null, { timeout: 30000 }).catch(() => {});
    check('and it bakes when the preview lands: ONE more Undo step, closed', (await undoDepth()) === undo5 + 1 &&
          JSON.stringify(await seal()) === '{"open":0,"nm":0}' && /1 edge beveled/.test(await status()), await status());

    const errs = logs.filter(l => /pageerror|^error/i.test(String(l.type || l)));
    check('no page errors', errs.length === 0, errs.slice(0, 3).map(e => JSON.stringify(e).slice(0, 200)).join(' | '));
  });
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
