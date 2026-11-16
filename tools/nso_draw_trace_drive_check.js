/* Draw: trace a piece, draw on its border, and fur its wall out (docs/DRAW.md, "Trace a piece")
   through the real app.
     node tools/nso_draw_trace_drive_check.js        exit 0 = every gate held
   Screenshots go to tools/draw-out/ (git-ignored).

   Piece: a wall 2 x 40 x 30 (x, plate y, height) - the thin wall of a bent sheet, the case this was asked for.
   Pinned:
   1. Trace: the wall's outline goes under the sheet in plate millimetres - its box is the piece's plan box.
   2. A rectangle dragged from near the traced corner starts exactly on it (edge snap).
   3. Connect opens with the drawing already where it was drawn: on the plate under the wall, the ghost's
      plan box the drawn rectangle's (plate y = world -z), its foot on the plate - and it follows the piece
      if the piece moved after the trace.
   4. Piece height: the ghost stands the wall's full height - 0.02 mm over it, said in the readout: a top flush
      with the wall's is a seam the kernel union leaves non-manifold (measured on a real Thicken output).
   5. Dragging the +x handle stretches it: the -x side stays put, Stretch reads the new %.
   6. Weld: one piece, the volume worked by hand (wall + block - their overlap), mesh_validate.py clean;
      one Undo puts the wall back. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openMenuFor, ROOT } = require('./nso_app_harness');
const FX = require('./nso_feature_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-3 : t);
const meshValidate = file => JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 }));
const OUT = path.join(__dirname, 'draw-out');

function box(sx, sy, sz) {
  const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]].map(p => [p[0] - sx / 2, p[1] - sy / 2, p[2]]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  f.forEach(t => t.forEach(i => out.push(...v[i])));
  return new Float32Array(out);
}
const info = page => page.evaluate(() => NSO_AsmEditor.info());
const dc = async page => (await info(page)).lock;
const at = (page, id, pt) => page.evaluate(([i, p]) => NSO_AsmEditor.screenOf(i, p), [id, pt]);
const plate = page => page.evaluate(() => state.placed.filter(p => p && p.mesh).map(p => {
  p.mesh.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(p.mesh), s = meshToWorldSoup(p.mesh);
  let v = 0;
  for (let i = 0; i < s.length; i += 9) v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  return { id: p.sourceId, min: b.min.toArray(), max: b.max.toArray(), vol: Math.abs(v / 6) };
}));
async function shot(page, name) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, name + '.png') }); }

withApp(async (page) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-trace-'));
  const tbk = process.env.TRACE_BLOCK && process.env.TRACE_BLOCK.split(',').map(Number);
  const file = process.env.TRACE_STL || path.join(tmp, 'wall.stl');
  if (!process.env.TRACE_STL) fs.writeFileSync(file, FX.stl(box(2, 40, 30)));
  const W = await loadSTL(page, file);
  await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); applyPlacedXZ(p, 10, 5); }, W);
  await page.evaluate(() => { try { localStorage.removeItem('nso.sketch.v1'); } catch (e) {} NSO_DrawEditor.setSketch({ height: 1.5, objects: [] }); });
  const P0 = (await plate(page)).find(p => p.id === W);
  /* the wall's plan box, plate mm: x as world x, y as world -z */
  const pb = { x0: P0.min[0], x1: P0.max[0], y0: -P0.max[2], y1: -P0.min[2] };

  console.log('1. trace');
  await page.click('#menu-connect > summary');
  await page.click('#btn-draw-editor');
  await page.waitForTimeout(300);
  const tr = await page.evaluate(id => NSO_DrawEditor.trace(id), W);
  check('Trace lays the wall\'s outline under the sheet', tr.ok && tr.trace && tr.trace.loops.length >= 1, JSON.stringify(tr.trace && tr.trace.box));
  const tb = tr.trace.box;
  check('...in plate millimetres: its box is the piece\'s plan box', near(tb.x0, pb.x0, 1e-3) && near(tb.x1, pb.x1, 1e-3) && near(tb.y0, pb.y0, 1e-3) && near(tb.y1, pb.y1, 1e-3), JSON.stringify(tb) + ' vs ' + JSON.stringify(pb));
  check('...cut half way up its height (15 of 30)', near(tr.trace.at, (P0.max[1] - P0.min[1]) / 2, 1e-3), tr.trace.at);

  console.log('2. draw on its border');
  await page.click('#dr-kind-fill');
  await page.click('#dr-tool-rect');
  const sp = p => page.evaluate(q => NSO_DrawEditor.screenOf(q), p);
  const c = [pb.x1, pb.y1];                                       // the wall's outer top-right corner, plate mm
  const s0 = await sp(c), s1 = await sp([pb.x1 + 10, pb.y1 - 20]);
  await page.mouse.move(s0[0] + 3, s0[1] - 2); await page.mouse.down();
  await page.mouse.move((s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2); await page.mouse.move(s1[0], s1[1]); await page.mouse.up();
  await page.waitForTimeout(150);
  let sk = await page.evaluate(() => NSO_DrawEditor.sketch());
  const rp = sk.objects[0] && sk.objects[0].pts, hasCorner = rp && rp.some(p => near(p[0], c[0], 1e-6) && near(p[1], c[1], 1e-6));
  if (!tbk) check('a rectangle started 3 px off the traced corner starts exactly on it', hasCorner, JSON.stringify(rp));
  await shot(page, '4-trace-editor');
  /* the block for the weld: x from the wall's middle (1 mm into its 2) out 10, 20 long */
  const mx = (pb.x0 + pb.x1) / 2, my = (pb.y0 + pb.y1) / 2;
  /* TRACE_BLOCK=x0,y0,x1,y1 (mm from the piece's plan box's low corner): another block, for a piece of your own */
  if (tbk) await page.evaluate(([b, q]) => { const k = NSO_DrawEditor.sketch(); k.objects = [{ kind: 'fill', pts: [[q.x0 + b[0], q.y0 + b[1]], [q.x0 + b[2], q.y0 + b[1]], [q.x0 + b[2], q.y0 + b[3]], [q.x0 + b[0], q.y0 + b[3]]] }]; NSO_DrawEditor.setSketch(k); }, [tbk, pb]);
  else await page.evaluate(([x, y]) => { const k = NSO_DrawEditor.sketch(); k.objects = [{ kind: 'fill', pts: [[x, y - 10], [x + 10, y - 10], [x + 10, y + 10], [x, y + 10]] }]; NSO_DrawEditor.setSketch(k); }, [mx, my]);
  await page.click('#dr-done');

  console.log('3. Connect: where it was drawn');
  /* the piece moves after the trace: the drawing follows it */
  await page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); applyPlacedXZ(p, p.x + 4, p.z); }, W);
  const P1 = (await plate(page)).find(p => p.id === W);
  await openMenuFor(page, '#btn-draw-connect');
  await page.click('#btn-draw-connect');
  await page.waitForTimeout(400);
  let L = await dc(page);
  check('it opens already placed, on the plate under the wall', L.step === 'set' && L.host && L.host.plate && L.host.id === W, JSON.stringify(L.host));
  const mx1 = mx + 4;
  if (!tbk) check('the ghost\'s plan box is the drawn rectangle, moved with the piece (x +4)', L.plan && near(L.plan.box.min[0], mx1, 1e-3) && near(L.plan.box.max[0], mx1 + 10, 1e-3) &&
        near(-L.plan.box.max[2], my - 10, 1e-3) && near(-L.plan.box.min[2], my + 10, 1e-3), JSON.stringify(L.plan && L.plan.box));
  check('its foot is the plate the wall stands on', near(L.plan.box.min[1], P1.min[1], 1e-3), L.plan.box.min[1] + ' vs ' + P1.min[1]);
  check('nothing on the plate changed', near((await plate(page)).find(p => p.id === W).vol, P1.vol, 1e-6));

  console.log('4. piece height');
  if (process.env.TRACE_H) { await page.fill('#dc-height', process.env.TRACE_H); await page.dispatchEvent('#dc-height', 'change'); } else await page.click('#dc-fullh');
  L = await dc(page);
  if (!process.env.TRACE_H) check('Piece height: the ghost stands from the plate to the wall\'s top (0.02 over it: a flush top is a seam the weld cannot close)', near(L.plan.box.max[1], P1.max[1] + 0.02, 1e-3) && near(L.height, P1.max[1] - P1.min[1], 0.01), L.plan.box.max[1] + ' vs ' + P1.max[1]);
  if (!process.env.TRACE_H) check('...and says so', L.plan.notes.some(n => /0\.02 mm over/.test(n)), JSON.stringify(L.plan.notes));

  console.log('5. stretch by its handle');
  await page.evaluate(() => NSO_AsmEditor.view([0, 300, 1]));
  const hx = L.handles.find(h => h.k === 'x+');
  const g0 = await at(page, W, hx.at), g1 = await at(page, W, [hx.at[0] + 5, hx.at[1], hx.at[2]]);
  await page.mouse.move(g0.x, g0.y); await page.mouse.down();
  await page.mouse.move((g0.x + g1.x) / 2, (g0.y + g1.y) / 2); await page.mouse.move(g1.x, g1.y); await page.mouse.up();
  await page.waitForTimeout(150);
  L = await dc(page);
  if (!tbk) check('dragging the +x handle 5 mm: the far side follows, the wall side stays', near(L.plan.box.min[0], mx1, 1e-3) && near(L.plan.box.max[0], mx1 + 15, 0.11), JSON.stringify([L.plan.box.min[0], L.plan.box.max[0]]));
  if (!tbk) check('...Stretch ↔ reads 150%, ↕ untouched', near(L.sx, 150, 1.1) && L.sy === 100 && near(+(await page.inputValue('#dc-sx')), L.sx, 1e-6), L.sx + ' / ' + L.sy);
  await page.fill('#dc-sx', '150'); await page.dispatchEvent('#dc-sx', 'change');
  L = await dc(page);
  const blockW = L.plan.box.max[0] - L.plan.box.min[0];
  await page.evaluate(() => NSO_AsmEditor.view([-120, 140, 200]));
  await shot(page, '5-trace-ghost');

  console.log('6. weld');
  const d0 = await page.evaluate(() => state.undoStack.length);
  await page.click('#dc-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 120000 });
  await page.waitForTimeout(200);
  L = await dc(page);
  const after = (await plate(page)).find(p => p.id === W), H = P1.max[1] - P1.min[1];
  check('it worked', L.last && L.last.ok, JSON.stringify(L.last));
  if (!process.env.TRACE_STL) {
    const want = 2 * 40 * 30 + blockW * 20 * (H + 0.02) - 1 * 20 * H;     // the block stands 0.02 over the wall's top; they overlap only up to it
    check('the wall is furred out: wall + block - their overlap', after && near(after.vol, want, 0.05), after && after.vol.toFixed(3) + ' vs ' + want.toFixed(3));
  } else console.log('    (' + process.env.TRACE_STL + ': ' + P1.vol.toFixed(2) + ' -> ' + after.vol.toFixed(2) + ' mm³)');
  check('one Undo step, the piece where it was', (await page.evaluate(() => state.undoStack.length)) === d0 + 1 && near(after.min[1], P1.min[1], 1e-3));
  const out = path.join(tmp, 'furred.stl');
  fs.writeFileSync(out, FX.stl(new Float32Array(await page.evaluate(id => Array.from(meshToWorldSoup(state.placed.find(p => p.sourceId === id).mesh)), W))));
  const mv = meshValidate(out);
  check('mesh_validate.py: closed, manifold, no degenerate, nothing piercing', mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.degenerate_tris === 0 && mv.self_intersection.pierce === 0,
        JSON.stringify({ o: mv.open_edges, nm: mv.nonmanifold_edges, d: mv.degenerate_tris, p: mv.self_intersection && mv.self_intersection.pierce }));
  await page.evaluate(() => NSO_AsmEditor.view([-120, 140, 200]));
  await shot(page, '6-trace-welded');
  await page.click('#asm-undo');
  await page.waitForTimeout(300);
  check('one Undo puts the wall back', near((await plate(page)).find(p => p.id === W).vol, P1.vol, 1e-3));
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
