/* DRAW (app-draw-editor.js, app-draw-connect.js, nso_sketch.js; docs/DRAW.md)
   through the real app: the card, the Draw editor's sheet with real pointer
   strokes, and the Connect stage with real clicks and drags.
     node tools/nso_draw_drive_check.js        exit 0 = every gate held
   Screenshots go to tools/draw-out/ (git-ignored).

   Pieces: two boxes 30 x 30 x 10, 16 mm apart on the plate.
   Pinned:
   1. The column button is named Draw. Opening it arms nothing on the plate;
      opening its "Anchors on the plate" section arms Connect's picks, as the
      card did, and shutting the section disarms them.
   2. Draw editor: a pencil drag makes one Drawing Line; the Rectangle tool
      as a Drawing Fill makes a second; the Objects list shows both; typing W
      scales what is picked; Ctrl+Z steps it back; a bow-tie fill is drawn red
      and named in the readout.
   3. Connect: a click on box A's top picks it, the ghost stands on it and
      nothing on the plate changed; dragging the ghost moves it on the face;
      typed offsets carry it across onto box B, and both are lit as reached.
   4. Weld in across both: one piece in their place, mesh_validate.py passes
      it, its volume is both boxes plus the line's part above the faces; one
      Undo puts both back.
   5. Cut in on a wall: the box loses the drawing's volume (a fill 10 x 4, 1
      deep), it stays where it was, one Undo.
   6. Own piece: a new piece, the boxes untouched; one Undo.
   7. Escape steps back, Return closes. */
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
async function click(page, id, pt) { const s = await at(page, id, pt); await page.mouse.move(s.x, s.y); await page.waitForTimeout(120); await page.mouse.click(s.x, s.y); await page.waitForTimeout(150); }
async function type(page, k, v) { await page.fill('#dc-' + k, String(v)); await page.dispatchEvent('#dc-' + k, 'change'); await page.waitForTimeout(80); }
const plate = page => page.evaluate(() => state.placed.filter(p => p && p.mesh).map(p => {
  p.mesh.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(p.mesh), s = meshToWorldSoup(p.mesh);
  let v = 0;
  for (let i = 0; i < s.length; i += 9) v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  return { id: p.sourceId, name: (state.models.find(m => m.id === p.sourceId) || {}).name, min: b.min.toArray(), max: b.max.toArray(), vol: Math.abs(v / 6), tris: s.length / 9 };
}));
const undoDepth = page => page.evaluate(() => state.undoStack.length);
async function shot(page, name) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, name + '.png') }); }

withApp(async (page) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-draw-'));
  fs.writeFileSync(path.join(tmp, 'boxA.stl'), FX.stl(box(30, 30, 10)));
  fs.writeFileSync(path.join(tmp, 'boxB.stl'), FX.stl(box(30, 30, 10)));
  const A = await loadSTL(page, path.join(tmp, 'boxA.stl'));
  const B = await loadSTL(page, path.join(tmp, 'boxB.stl'));
  await page.evaluate(([a, b]) => {
    state.placed.forEach(p => { if (p.sourceId === a) applyPlacedXZ(p, -23, 0); if (p.sourceId === b) applyPlacedXZ(p, 23, 0); });
  }, [A, B]);
  await page.evaluate(() => { try { localStorage.removeItem('nso.sketch.v1'); } catch (e) {} NSO_DrawEditor.setSketch({ height: 1.5, objects: [] }); });

  console.log('1. the card is Draw; the anchors are its second section');
  check('the column button is named Draw', (await page.textContent('#menu-connect > summary')).trim() === 'Draw');
  await page.click('#menu-connect > summary');
  await page.waitForTimeout(200);
  check('opening the card arms no anchor picks', await page.evaluate(() => !state.connect || !state.connect.open));
  check('Draw editor is the card\'s first button, Connect its second', await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#draw-card > button')).map(x => x.id);
    return b[0] === 'btn-draw-editor' && b[1] === 'btn-draw-connect';
  }));
  await page.click('#connect-sec-classic > summary');
  await page.waitForTimeout(200);
  check('opening "Anchors on the plate" arms them', await page.evaluate(() => state.connect.open && !document.getElementById('connect-panel').hidden));
  await page.click('#connect-sec-classic > summary');
  await page.waitForTimeout(200);
  check('shutting it disarms them', await page.evaluate(() => !state.connect.open));

  console.log('2. the Draw editor');
  await page.click('#btn-draw-editor');
  await page.waitForTimeout(300);
  check('it opens over the app', await page.evaluate(() => NSO_DrawEditor.isOpen() && !document.getElementById('draw-editor').hidden));
  const sp = p => page.evaluate(q => NSO_DrawEditor.screenOf(q), p);
  /* a pencil stroke: a gentle wave 40 mm long */
  let s = await sp([-20, 0]);
  await page.mouse.move(s[0], s[1]); await page.mouse.down();
  for (let i = 1; i <= 40; i++) { const q = await sp([-20 + i, 2 * Math.sin(i / 6)]); await page.mouse.move(q[0], q[1]); }
  await page.mouse.up();
  await page.waitForTimeout(150);
  let sk = await page.evaluate(() => NSO_DrawEditor.sketch());
  check('a pencil drag is one Drawing Line', sk.objects.length === 1 && sk.objects[0].kind === 'line', JSON.stringify(sk.objects.map(o => o.kind)));
  check('...smoothed: far fewer points than the pointer gave', sk.objects[0].pts.length < 40 && sk.objects[0].pts.length >= 2, sk.objects[0].pts.length);
  await page.focus('#dr-canvas'); await page.keyboard.press('Escape');      // drop the pick: Process type then sets the next object
  check('Escape drops the pick, the editor stays', await page.evaluate(() => NSO_DrawEditor.isOpen() && NSO_DrawEditor.info().sel.length === 0));
  await page.click('#dr-kind-fill');
  check('...so Drawing Fill changed nothing drawn', (await page.evaluate(() => NSO_DrawEditor.sketch())).objects[0].kind === 'line');
  await page.click('#dr-tool-rect');
  s = await sp([-10, 10]); let e2 = await sp([10, 20]);
  await page.mouse.move(s[0], s[1]); await page.mouse.down(); await page.mouse.move((s[0] + e2[0]) / 2, (s[1] + e2[1]) / 2); await page.mouse.move(e2[0], e2[1]); await page.mouse.up();
  await page.waitForTimeout(150);
  sk = await page.evaluate(() => NSO_DrawEditor.sketch());
  check('the Rectangle tool as Drawing Fill makes a fill', sk.objects.length === 2 && sk.objects[1].kind === 'fill');
  check('the Objects list shows both, newest first', await page.evaluate(() => {
    const r = Array.from(document.querySelectorAll('#dr-objects .dr-obj-kind')).map(x => x.textContent);
    return r.length === 2 && /Drawing Fill/.test(r[0]) && /Drawing Line/.test(r[1]);
  }));
  check('W and H read what is picked (20 x 10)', near(+(await page.inputValue('#dr-w')), 20, 0.01) && near(+(await page.inputValue('#dr-h')), 10, 0.01));
  await page.fill('#dr-w', '30'); await page.dispatchEvent('#dr-w', 'change'); await page.waitForTimeout(100);
  check('typed W 30, aspect locked: H 15', near(+(await page.inputValue('#dr-h')), 15, 0.01));
  await shot(page, '1-editor');
  await page.focus('#dr-canvas');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check('Ctrl+Z steps it back to 20 x 10', near(+(await page.inputValue('#dr-w')), 20, 0.01));
  await page.evaluate(() => { const k = NSO_DrawEditor.sketch(); k.objects.push({ kind: 'fill', name: 'Bow', pts: [[40, 0], [50, 10], [50, 0], [40, 10]] }); NSO_DrawEditor.setSketch(k); });
  check('a bow-tie fill is red and named in the readout', await page.evaluate(() => document.getElementById('dr-readout').classList.contains('is-bad') && /Bow.*crosses itself/.test(document.getElementById('dr-readout').textContent) && document.getElementById('dr-connect').disabled));
  await page.focus('#dr-canvas'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Escape (twice: the pick, then the editor) closes it', await page.evaluate(() => !NSO_DrawEditor.isOpen()));

  /* the drawing for the connect checks: one straight line, 60 long, 3 wide, 2 tall */
  await page.evaluate(() => NSO_DrawEditor.setSketch({ height: 2, objects: [{ kind: 'line', pts: [[-30, 0], [30, 0]], width: 3 }] }));

  console.log('3. Connect: the face, the ghost, free movement');
  const before = await plate(page), d0 = await undoDepth(page);
  await openMenuFor(page, '#btn-draw-connect');
  await page.click('#btn-draw-connect');
  await page.waitForTimeout(400);
  let I = await info(page);
  check('Connect opens the stage on its own mode, titled Draw · Connect', I.open && I.mode === 'drawconnect' && (await page.textContent('#asm-ed-title')) === 'Draw · Connect');
  const pa = before.find(p => p.id === A), pb = before.find(p => p.id === B);
  check('the stage shows the plate as it stands (one offset for both)', await page.evaluate(([a, b]) => {
    const sa = NSO_AsmEditor.screenOf(a, [0, 0, 0]), sb = NSO_AsmEditor.screenOf(b, [0, 0, 0]);
    return sa && sb && Math.abs(sa.x - sb.x) < 1 && Math.abs(sa.y - sb.y) < 1;
  }, [A, B]));
  await page.evaluate(() => NSO_AsmEditor.view([0, 300, 1]));
  const topA = [(pa.min[0] + pa.max[0]) / 2 - 5, pa.max[1], (pa.min[2] + pa.max[2]) / 2];
  await click(page, A, topA);
  let L = await dc(page);
  check('a click on A\'s top picks it', L.step === 'set' && L.host && L.host.id === A && near(L.host.normal[1], 1), JSON.stringify(L.host && L.host.normal));
  check('the ghost stands on it; nothing on the plate changed', L.plan && L.plan.ghost && (await undoDepth(page)) === d0 &&
        JSON.stringify((await plate(page)).map(p => p.vol.toFixed(4))) === JSON.stringify(before.map(p => p.vol.toFixed(4))));
  check('the ghost stands 2 out of the face, 0.4 into it', near(L.plan.box.max[1], pa.max[1] + 2, 1e-3) && near(L.plan.box.min[1], pa.max[1] - 0.4, 1e-3), JSON.stringify(L.plan.box));
  /* drag the ghost: from its middle, 6 mm along world x */
  const mid = [(L.plan.box.min[0] + L.plan.box.max[0]) / 2, pa.max[1] + 2, (L.plan.box.min[2] + L.plan.box.max[2]) / 2];
  const g0 = await at(page, A, mid), g1 = await at(page, A, [mid[0] + 6, mid[1], mid[2]]);
  const cu0 = L.cu, cv0 = L.cv;
  await page.mouse.move(g0.x, g0.y); await page.mouse.down();
  await page.mouse.move((g0.x + g1.x) / 2, (g0.y + g1.y) / 2); await page.mouse.move(g1.x, g1.y); await page.mouse.up();
  await page.waitForTimeout(150);
  L = await dc(page);
  const moved = (L.plan.box.min[0] + L.plan.box.max[0]) / 2 - mid[0];
  check('dragging the ghost moves it on the face (6 mm along x)', near(moved, 6, 0.25) && (L.cu !== cu0 || L.cv !== cv0), moved.toFixed(3));
  /* the line along world x, centred between the boxes: type it */
  const u = L.host.u, v = L.host.v, mu = (L.host.rect.u0 + L.host.rect.u1) / 2, mv = (L.host.rect.v0 + L.host.rect.v1) / 2;
  const want = [0, pa.max[1], (pa.min[2] + pa.max[2]) / 2];
  const deg = Math.abs(u[0]) > 0.9 ? (u[0] > 0 ? 0 : 180) : (v[0] > 0 ? 90 : 270);
  await type(page, 'deg', deg);
  await type(page, 'u', (want[0] * u[0] + want[1] * u[1] + want[2] * u[2] - mu).toFixed(3));
  await type(page, 'v', (want[0] * v[0] + want[1] * v[1] + want[2] * v[2] - mv).toFixed(3));
  L = await dc(page);
  check('typed: the line runs from A over the gap onto B (x -30..30)', near(L.plan.box.min[0], -31.5, 0.02) && near(L.plan.box.max[0], 31.5, 0.02), JSON.stringify(L.plan.box));
  check('both boxes are lit as reached', L.plan.touched.length === 2 && L.plan.touched.indexOf(A) >= 0 && L.plan.touched.indexOf(B) >= 0, JSON.stringify(L.plan.touched));
  check('the Apply button says it connects', /connect/i.test(await page.textContent('#dc-apply')));
  await page.evaluate(() => NSO_AsmEditor.view([-120, 140, 200]));
  await shot(page, '2-connect-ghost');

  console.log('4. Weld in across both');
  await page.click('#dc-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 120000 });
  await page.waitForTimeout(200);
  L = await dc(page);
  let after = await plate(page);
  check('it worked', L.last && L.last.ok, JSON.stringify(L.last));
  check('one piece in place of the two', after.length === before.length - 1 && !after.some(p => p.id === A || p.id === B), JSON.stringify(after.map(p => p.name)));
  check('one Undo step', (await undoDepth(page)) === d0 + 1);
  const joined = after.find(p => p.id !== A && p.id !== B && before.every(q => q.id !== p.id));
  /* the line above the faces: the 16 mm gap at full section (3 wide, round end-caps outside the boxes), 2 tall
     on the boxes, the span over the gap 2.4 deep (it hangs 0.4 below the faces' plane there) */
  if (joined) {
    const n = 2 * Math.ceil(180 / 15), disc = 0.5 * n * 1.5 * 1.5 * Math.sin(2 * Math.PI / n);
    const lineArea = 60 * 3 + disc, gap = 16 * 3, onTop = lineArea - gap;
    const wantVol = 2 * 9000 + onTop * 2 + gap * 2.4;
    check('its volume is both boxes and the line above the faces', near(joined.vol, wantVol, 0.5), joined.vol.toFixed(3) + ' vs ' + wantVol.toFixed(3));
    const file = path.join(tmp, 'welded.stl');
    const soup = await page.evaluate(id => Array.from(meshToWorldSoup(state.placed.find(p => p.sourceId === id).mesh)), joined.id);
    fs.writeFileSync(file, FX.stl(new Float32Array(soup)));
    const mv2 = meshValidate(file);
    check('mesh_validate.py: closed, manifold, no degenerate, nothing piercing', mv2.open_edges === 0 && mv2.nonmanifold_edges === 0 && mv2.degenerate_tris === 0 && mv2.self_intersection.pierce === 0, JSON.stringify(mv2).slice(0, 300));
  } else check('the joined piece is on the plate', false);
  await page.evaluate(() => NSO_AsmEditor.view([-120, 140, 200]));
  await shot(page, '3-welded');
  await page.click('#asm-undo');
  await page.waitForTimeout(300);
  after = await plate(page);
  check('one Undo puts both back', after.some(p => p.id === A) && after.some(p => p.id === B) && after.length === before.length &&
        after.every(p => { const q = before.find(x => x.id === p.id); return q && near(p.vol, q.vol, 1e-3) && near(p.min[0], q.min[0], 1e-3); }));

  console.log('5. Cut in on a wall');
  await page.evaluate(() => NSO_DrawEditor.setSketch({ height: 1, objects: [{ kind: 'fill', pts: [[-5, -2], [5, -2], [5, 2], [-5, 2]] }] }));
  await page.click('#dc-op-cut');
  await page.evaluate(() => NSO_AsmEditor.view([0, 40, 300]));
  const pa2 = (await plate(page)).find(p => p.id === A);
  await click(page, A, [(pa2.min[0] + pa2.max[0]) / 2, 5, pa2.max[2]]);
  L = await dc(page);
  check('a wall picked (+z), the cut ghost goes into it', L.step === 'set' && near(L.host.normal[2], 1) && near(L.plan.box.min[2], pa2.max[2] - 1, 1e-3) && near(L.plan.box.max[2], pa2.max[2] + 0.4, 1e-3), JSON.stringify(L.plan && L.plan.box));
  const d1 = await undoDepth(page);
  await page.click('#dc-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 120000 });
  await page.waitForTimeout(200);
  after = await plate(page);
  const cutA = after.find(p => p.id === A);
  check('cut: A loses 10 x 4 x 1', cutA && near(pa2.vol - cutA.vol, 40, 0.05), cutA && (pa2.vol - cutA.vol).toFixed(4));
  check('...stays where it was, one Undo', cutA && near(cutA.min[0], pa2.min[0], 1e-3) && near(cutA.max[2], pa2.max[2], 1e-3) && (await undoDepth(page)) === d1 + 1);
  await page.click('#asm-undo');
  await page.waitForTimeout(300);
  check('Undo restores A', near((await plate(page)).find(p => p.id === A).vol, pa2.vol, 1e-3));

  console.log('6. Own piece');
  await page.click('#dc-op-place');
  await page.evaluate(() => NSO_AsmEditor.view([0, 300, 1]));
  const pb2 = (await plate(page)).find(p => p.id === B);
  await click(page, B, [(pb2.min[0] + pb2.max[0]) / 2, pb2.max[1], (pb2.min[2] + pb2.max[2]) / 2]);
  const n0 = (await plate(page)).length, d2 = await undoDepth(page);
  await page.click('#dc-apply');
  await page.waitForFunction(() => !NSO_AsmEditor.info().busy, null, { timeout: 60000 });
  await page.waitForTimeout(200);
  after = await plate(page);
  const own = after.find(p => !before.some(q => q.id === p.id) && p.id !== A && p.id !== B);
  check('a new piece, 10 x 4 x 1, the boxes untouched', after.length === n0 + 1 && own && near(own.vol, 40, 0.01) && near(after.find(p => p.id === B).vol, pb2.vol, 1e-4), own && own.vol);
  check('...sitting on B\'s top', own && near(own.min[1], pb2.max[1], 0.02), own && own.min[1]);
  check('one Undo', (await undoDepth(page)) === d2 + 1);
  await page.click('#asm-undo');
  await page.waitForTimeout(300);
  check('Undo takes it off', (await plate(page)).length === n0);

  console.log('7. Escape, Return');
  await click(page, B, [(pb2.min[0] + pb2.max[0]) / 2, pb2.max[1], (pb2.min[2] + pb2.max[2]) / 2]);
  await page.keyboard.press('Escape');
  check('Escape steps back to the face pick', (await dc(page)).step === 'host');
  await page.click('#asm-return');
  await page.waitForTimeout(200);
  check('Return closes the stage', !(await info(page)).open);
}).then(() => {
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
