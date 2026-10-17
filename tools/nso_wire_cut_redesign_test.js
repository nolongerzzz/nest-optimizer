/* The Cut card redesign, driven through the real app with real clicks.
     node tools/nso_wire_cut_redesign_test.js    exit 0 = every gate held

   WHAT CHANGED (app-cut.js, app-core.js, app-join.js, app-crop.js, index.html)
     - Cut and Crop are two cards. The card is the switch: opening Cut arms
       the cutter, closing it (or opening any other panel) disarms it. No
       Open / Close, no Cut X / Cut Z.
     - A click on a piece drops the blade where the click landed, SQUARE to
       the piece's longest dimension as it lies (its own geometry box, so a
       pose on the plate is carried along): the cut is to length.
     - The mitre wheel turns the plane's heading about the plate vertical;
       the cut is made on a copy turned into the cut frame and both halves
       are turned back, so the piece stays put and only the face is angled.
     - The mitre wheel has − / + buttons under it: 1 degree a press, Shift
       0.1, Alt 5; held, they repeat after 400 ms at 10 a second. The wheel's
       handle, the Mitre number (one decimal when it isn't whole) and the
       blade all follow each press, as they follow a drag.
     - The slider, ← / → and the number box move the blade along the length,
       on a 0.1 mm grid: ← / → step 0.1 mm, 1 mm with Shift held.
     - Cut is a clean split on both engines: the halves meet exactly at the
       plane and add back to the piece; the readout shows each side's true
       length. One Undo restores the original.

   GATES
     1. opening the Cut card arms the cutter, closing it disarms it, opening
        another panel disarms it; the old buttons are gone.
     2. a click on an un-posed piece (a post standing on end, and a bar lying
        along Z) drops a square blade at the click; Cut makes a face square
        to the piece in world space, sides adding back to the length.
     3. the same on a TIPPED piece (Stand, then a tilt): the blade and the cut
        face are square to the piece in world space; the halves keep its pose.
     4. the mitre wheel, dragged by its handle: the face is angled by the
        dial, on the raw and the display route; each half keeps the piece's
        orientation (every other face as it was), the halves meet exactly.
     4b. the mitre − / + buttons: 1°, Shift 0.1° and Alt 5°, each way, from
        square and from 30°, across the 0/360 wrap and with no drift over
        ten 0.1° presses; after every press the wheel's handle, the number,
        the readout and the blade all say the same angle. A key press steps
        once; a held button keeps stepping, in order, and stops on release
        (order only - the 400 ms / 10 a second cadence is not asserted).
     5. the slider and ← / → move the blade in 0.1 mm steps (Shift: 1 mm);
        the number tracks, to one decimal.
     6. Cut splits cleanly (raw and display route: lengths add back, no
        kerf, faces meet) and one Undo restores the original bit for bit.
     7. Crop works from its own card, with no blade.                        */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf } = require('./nso_app_harness');
const { openJoin } = require('./nso_join_card');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function box(Lx, Wy, Hz) {
  const o = [];
  const q = (a, b, c, d) => o.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, Wy, 0], [Lx, Wy, 0], [Lx, 0, 0]); q([0, 0, Hz], [Lx, 0, Hz], [Lx, Wy, Hz], [0, Wy, Hz]);
  q([0, 0, 0], [Lx, 0, 0], [Lx, 0, Hz], [0, 0, Hz]); q([0, Wy, 0], [0, Wy, Hz], [Lx, Wy, Hz], [Lx, Wy, 0]);
  q([0, 0, 0], [0, 0, Hz], [0, Wy, Hz], [0, Wy, 0]); q([Lx, 0, 0], [Lx, Wy, 0], [Lx, Wy, Hz], [Lx, 0, Hz]);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-cut-redesign-'));
function stl(name, soup) {
  const f = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  return f;
}

const PAGE = `
window.__pieceMesh = id => (state.placed.find(p => p && p.sourceId === id) || {}).mesh || null;
/* The piece's long axis in world space: its own longest box axis through
   its mesh's rotation. */
window.__longWorld = function (id) {
  const m = state.models.find(x => x.id === id), mesh = __pieceMesh(id);
  const bb = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  const s = bb.getSize(new THREE.Vector3());
  let a = 'x'; if (s.z > s[a]) a = 'z'; if (s.y > s[a]) a = 'y';
  mesh.updateMatrixWorld(true);
  const e = new THREE.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0).transformDirection(mesh.matrixWorld);
  return { axis: a, dir: e.toArray(), span: s[a], quat: mesh.quaternion.toArray() };
};
/* A world point on the piece, at fraction f along its long axis, on the
   face nearest the camera, projected to the screen. */
window.__screenAt = function (id, f) {
  const m = state.models.find(x => x.id === id), mesh = __pieceMesh(id);
  const bb = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  const L = __longWorld(id).axis;
  mesh.updateMatrixWorld(true);
  const c = bb.getCenter(new THREE.Vector3());
  c[L] = bb.min[L] + f * (bb.max[L] - bb.min[L]);
  const w = c.clone().applyMatrix4(mesh.matrixWorld);
  const ray = new THREE.Raycaster(state.camera.position.clone(), w.clone().sub(state.camera.position).normalize());
  const hit = ray.intersectObject(mesh, false)[0];
  const p = hit ? hit.point : w;
  const v = p.clone().project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
  const local = p.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  return { x: sx, y: sy, mmAlong: local[L] - bb.min[L],
           onCanvas: document.elementFromPoint(sx, sy) === state.renderer.domElement };
};
/* The blade as it stands: its normal and centre in world space. */
window.__blade = function () {
  if (!state.cutHelper) return null;
  const b = state.cutHelper.children.find(c => c.userData.cutBlade);
  b.updateMatrixWorld(true);
  return { n: new THREE.Vector3(0, 0, 1).transformDirection(b.matrixWorld).toArray(),
           p: new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray() };
};
const __flat = g => Array.from((g.index ? g.toNonIndexed() : g).attributes.position.array);
/* Cut through the real button. The halves as the cut made them (in the
   piece's own frame, before they are centred and laid out), their pieces on
   the plate, and the source's world matrix, all captured. */
window.__cut = function (id) {
  const m = state.models.find(x => x.id === id);
  const mesh = __pieceMesh(id);
  mesh.updateMatrixWorld(true);
  const src = { Mw: mesh.matrixWorld.toArray(), quat: mesh.quaternion.toArray(), soup: __flat(m.geometry),
                raw: m.rawTris ? Array.from(m.rawTris) : null };
  let got = null;
  const orig = window.cutSplitAt;
  window.cutSplitAt = function (model, info) {
    const r = orig.apply(this, arguments);
    got = { left: __flat(r.left), right: __flat(r.right), engine: r.engine, axis: info.axis, deg: info.deg || 0,
            mm: info.mm, span: info.span };
    return r;
  };
  const before = state.models.map(x => x.id);
  try { document.getElementById('btn-cut').click(); } finally { window.cutSplitAt = orig; }
  const status = document.getElementById('status').textContent;
  const fresh = state.models.filter(x => !before.includes(x.id));
  const plate = fresh.map(x => {
    const e = state.placed.find(p => p && p.sourceId === x.id);
    return { name: x.name, id: x.id, quat: e ? e.mesh.quaternion.toArray() : null,
             pos: e ? e.mesh.position.toArray() : null };
  });
  return { status, got, src, plate, models: state.models.length, undo: state.undoStack.length };
};
/* Undo through the real button; the piece that comes back. */
window.__undo = function () {
  document.getElementById('btn-undo').click();
  const m = state.models[state.models.length - 1];
  return { models: state.models.length, soup: __flat(m.geometry), raw: m.rawTris ? Array.from(m.rawTris) : null,
           id: m.id, status: document.getElementById('status').textContent };
};
window.__addDisplayPiece = function (soup, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(soup), 3));
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  const id = addModel(name, g, { keepSelection: true, silent: true });
  const m = state.models.find(x => x.id === id);
  placeModelMovable(m, 0, 0);
  return id;
};
window.__clearAll = function () { document.getElementById('btn-clear').click(); };
`;

/* Geometry, in node. */
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
};
// Column-major Matrix4 elements applied to a point / a direction.
const applyM = (e, p) => [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
                          e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
                          e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]];
const applyD = (e, p) => [e[0] * p[0] + e[4] * p[1] + e[8] * p[2],
                          e[1] * p[0] + e[5] * p[1] + e[9] * p[2],
                          e[2] * p[0] + e[6] * p[1] + e[10] * p[2]];
function tris(soup) {
  const out = [];
  for (let t = 0; t < soup.length; t += 9) {
    const a = soup.slice(t, t + 3), b = soup.slice(t + 3, t + 6), c = soup.slice(t + 6, t + 9);
    const n = V.cross(V.sub(b, a), V.sub(c, a));
    const area = V.len(n) / 2;
    if (area < 1e-9) continue;
    out.push({ a, b, c, n: V.norm(n), area });
  }
  return out;
}
const volume = soup => {
  let v = 0;
  for (let t = 0; t < soup.length; t += 9) {
    const a = soup.slice(t, t + 3), b = soup.slice(t + 3, t + 6), c = soup.slice(t + 6, t + 9);
    v += V.dot(a, V.cross(b, c)) / 6;
  }
  return v;
};
/* The cut face of a half (in the piece's frame): every triangle lying on the
   plane through `p` with normal `n`. Its normal (area-weighted) and area. */
function capOf(soup, p, n) {
  let area = 0; const acc = [0, 0, 0]; const keys = new Set();
  for (const T of tris(soup)) {
    if ([T.a, T.b, T.c].some(q => Math.abs(V.dot(V.sub(q, p), n)) > 1e-3)) continue;
    area += T.area;
    for (let k = 0; k < 3; k++) acc[k] += T.n[k] * T.area;
    [T.a, T.b, T.c].forEach(q => keys.add(q.join(',')));
  }
  return { area, n: area ? V.norm(acc) : null, keys };
}
const angleDeg = (a, b) => Math.acos(Math.min(1, Math.abs(V.dot(V.norm(a), V.norm(b))))) * 180 / Math.PI;
const quatSame = (a, b) => Math.abs(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) - 1) < 1e-9;

withApp(async (page, logs) => {
  await page.addScriptTag({ content: PAGE });
  const armed = () => page.evaluate(() => ({ open: !!state.cutterOpen, tool: state.cutTool || null,
    blade: !!state.cutHelper, card: document.getElementById('menu-cut').open,
    crop: document.getElementById('menu-crop').open }));
  const clickSummary = async id => { await page.click('#' + id + ' > summary'); await page.waitForTimeout(30); };
  const ensureCut = async () => {
    if (!(await page.evaluate(() => document.getElementById('menu-cut').open))) await clickSummary('menu-cut');
  };
  const shutCut = async () => {
    if (await page.evaluate(() => document.getElementById('menu-cut').open)) await clickSummary('menu-cut');
  };
  const clickPieceAt = async (id, f) => {
    const s = await page.evaluate(([id, f]) => __screenAt(id, f), [id, f]);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(30);
    return s;
  };

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the card is the switch ===');
  {
    const gone = await page.evaluate(() => ['btn-cutter-open', 'btn-cutter-close', 'btn-cut-axis-x', 'btn-cut-axis-z',
      'btn-yaw-left', 'btn-yaw-right', 'btn-yaw-left-90', 'btn-yaw-right-90'].filter(id => document.getElementById(id)));
    check('no Open / Close, no Cut X / Cut Z, no yaw buttons', gone.length === 0, gone.join(', ') || 'none');
    // The card, top to bottom: the mitre dial (with its typed box and
    // Square, and the − / + buttons under it), the slider, ← number →, Cut. (The right-side-out offer is
    // hidden until a Cut refuses an inside-out piece.)
    const order = await page.evaluate(() => [...document.querySelectorAll('#cutter-tools button, #cutter-tools input, #cutter-tools svg')]
      .filter(e => !e.hidden).map(e => e.id));
    check('the Cut card is: mitre dial, − / +, slider, ← number →, Cut',
      order.join(' ') === 'cut-miter-dial cut-miter-deg btn-cut-square btn-cut-miter-minus btn-cut-miter-plus cut-slider btn-cut-nudge-m cut-mm btn-cut-nudge-p btn-cut',
      order.join(' '));
    const cards = await page.evaluate(() => ({
      cut: !!document.querySelector('.vp-shell-col > #menu-cut'), crop: !!document.querySelector('.vp-shell-col > #menu-crop'),
      cropInCut: !!document.querySelector('#menu-cut #btn-crop, #menu-cut #btn-crop-lockin'),
      cutBtn: (document.getElementById('btn-cut') || {}).textContent,
      arrows: [(document.getElementById('btn-cut-nudge-m') || {}).textContent, (document.getElementById('btn-cut-nudge-p') || {}).textContent],
      spin: getComputedStyle(document.getElementById('cut-mm')).appearance
    }));
    check('Cut and Crop are two cards in the column; Crop\'s controls are not in Cut',
      cards.cut && cards.crop && !cards.cropInCut, JSON.stringify(cards));
    check('one button, "Cut"; ← and →; the mm box has no stepper',
      cards.cutBtn === 'Cut' && cards.arrows.join(' ') === '← →' && cards.spin === 'textfield',
      cards.cutBtn + ' / ' + cards.arrows.join(' ') + ' / ' + cards.spin);
    const s0 = await armed();
    check('at load the cutter is off', !s0.open && !s0.card, JSON.stringify(s0));
    await clickSummary('menu-cut');
    const s1 = await armed();
    check('opening the Cut card arms the cutter', s1.open && s1.tool === 'cut' && s1.card, JSON.stringify(s1));
    await clickSummary('menu-cut');
    const s2 = await armed();
    check('closing the Cut card disarms it', !s2.open && !s2.card && !s2.blade, JSON.stringify(s2));
    await clickSummary('menu-cut');
    await clickSummary('menu-scale');
    const s3 = await armed();
    check('opening another panel (Scale) shuts Cut and disarms it', !s3.open && !s3.card, JSON.stringify(s3));
    await clickSummary('menu-scale');
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. a click drops a square blade; Cut is square to the piece (un-posed) ===');
  // A post standing on end (longest is vertical: the old Cut X / Z could not
  // cut it to length), and a bar lying along display Z.
  const SQUARE = [['post', box(10, 12, 50), 0.3], ['barZ', box(12, 60, 8), 0.7]];
  for (const [name, soup, f] of SQUARE) {
    await page.evaluate(() => __clearAll());
    const id = await loadSTL(page, stl(name + '.stl', soup));
    await ensureCut();
    const s = await clickPieceAt(id, f);
    check(name + ': the click point is on the canvas', s.onCanvas);
    const L = await page.evaluate(id => __longWorld(id), id);
    const b = await page.evaluate(() => __blade());
    const st = await page.evaluate(() => ({ mm: getCutMm(), input: document.getElementById('cut-mm').value,
      readout: document.getElementById('cut-readout').textContent, editId: state.editId }));
    check(name + ': the click selected the piece and dropped the blade', !!b && st.editId === id, JSON.stringify(st));
    if (!b) continue;
    check(name + ': the blade is square to the piece\'s length (' + L.axis + ' as it lies)',
      angleDeg(b.n, L.dir) < 1e-6, angleDeg(b.n, L.dir).toExponential(1) + '°');
    check(name + ': the blade is where the click landed (' + s.mmAlong.toFixed(2) + ' mm)',
      Math.abs(st.mm - s.mmAlong) <= 0.051, 'blade ' + st.mm + ' mm, box ' + st.input);
    check(name + ': the readout is the two true lengths, no kerf',
      st.readout.indexOf(st.mm.toFixed(1) + ' mm | ' + (L.span - st.mm).toFixed(1) + ' mm') >= 0, st.readout);
    const r = await page.evaluate(id => __cut(id), id);
    check(name + ': Cut made two pieces', !!r.got && r.models === 2, r.status);
    if (!r.got) continue;
    const e = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[r.got.axis];
    const P = [0, 0, 0]; P['xyz'.indexOf(r.got.axis)] = undefined;
    const lo = Math.min(...r.src.soup.filter((_, i) => i % 3 === 'xyz'.indexOf(r.got.axis)));
    const plane = [0, 0, 0]; plane['xyz'.indexOf(r.got.axis)] = lo + r.got.mm;
    const capA = capOf(r.got.left, plane, e), capB = capOf(r.got.right, plane, e);
    const nW = capA.n && applyD(r.src.Mw, capA.n);
    check(name + ': the cut face is square to the piece in world space',
      !!nW && angleDeg(nW, L.dir) < 1e-6, nW ? angleDeg(nW, L.dir).toExponential(1) + '°' : 'no face');
    check(name + ': the halves keep the piece\'s pose', r.plate.every(p => p.quat && quatSame(p.quat, r.src.quat)));
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. a TIPPED piece: square to the piece in world space ===');
  {
    await page.evaluate(() => __clearAll());
    const id = await loadSTL(page, stl('bar60.stl', box(60, 12, 8)));
    // Stand it on end, then bank and tilt it: the pose the Tip menu writes,
    // on the mesh, off every plate axis.
    await page.evaluate(id => selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)), id);
    await page.click('#btn-tip');
    await page.click('#btn-bank-up');
    await page.click('#btn-bank-up');
    await page.click('#btn-tilt-up');
    const L = await page.evaluate(id => __longWorld(id), id);
    const tipped = Math.acos(Math.min(1, Math.abs(L.dir[1]))) * 180 / Math.PI;
    check('the bar is tipped off the plate axes (' + tipped.toFixed(1) + '° from vertical)',
      tipped > 1 && tipped < 89 && L.axis === 'x',
      JSON.stringify(L.dir.map(v => +v.toFixed(3))));
    await ensureCut();
    const s = await clickPieceAt(id, 0.4);
    const b = await page.evaluate(() => __blade());
    check('the click dropped the blade on the tipped bar', !!b && s.onCanvas);
    if (b) {
      check('the blade is square to the tipped bar in world space', angleDeg(b.n, L.dir) < 1e-4,
        angleDeg(b.n, L.dir).toExponential(1) + '°');
      const mm = await page.evaluate(() => getCutMm());
      check('the blade is where the click landed (' + s.mmAlong.toFixed(2) + ' mm)', Math.abs(mm - s.mmAlong) <= 0.051, mm + ' mm');
      const r = await page.evaluate(id => __cut(id), id);
      check('Cut made two pieces', !!r.got && r.models === 2, r.status);
      if (r.got) {
        const lo = Math.min(...r.src.soup.filter((_, i) => i % 3 === 0));
        const capA = capOf(r.got.left, [lo + r.got.mm, 0, 0], [1, 0, 0]);
        const capB = capOf(r.got.right, [lo + r.got.mm, 0, 0], [1, 0, 0]);
        const nW = capA.n && applyD(r.src.Mw, capA.n);
        check('the cut face is square to the tipped bar in world space, the whole 12 x 8 section',
          !!nW && angleDeg(nW, L.dir) < 1e-4 && Math.abs(capA.area - 96) < 1e-3 && Math.abs(capB.area - 96) < 1e-3,
          (nW ? angleDeg(nW, L.dir).toExponential(1) + '°, ' : 'no face, ') + capA.area.toFixed(3) + ' / ' + capB.area.toFixed(3) + ' mm²');
        check('both halves keep the tipped pose', r.plate.length === 2 && r.plate.every(p => p.quat && quatSame(p.quat, r.src.quat)));
      }
    }
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the mitre wheel: an angled face, the piece stays put ===');
  for (const route of ['raw', 'display']) {
    await page.evaluate(() => __clearAll());
    await shutCut();
    const id = route === 'raw'
      ? await loadSTL(page, stl('bar60m.stl', box(60, 12, 8)))
      : await page.evaluate(soup => __addDisplayPiece(soup, 'bar-display'), box(60, 12, 8));
    await ensureCut();
    await clickPieceAt(id, 0.5);
    await page.evaluate(() => setCutMm(30));
    // Drag the handle round the rail from 0° to 30°.
    const pts = await page.evaluate(() => {
      const d = document.getElementById('cut-miter-dial').getBoundingClientRect();
      const h = document.getElementById('cut-dial-handle').getBoundingClientRect();
      const cx = d.left + d.width / 2, cy = d.top + d.height / 2, R = d.width * 0.4;
      const at = deg => ({ x: cx + R * Math.sin(deg * Math.PI / 180), y: cy - R * Math.cos(deg * Math.PI / 180) });
      return { handle: { x: h.left + h.width / 2, y: h.top + h.height / 2 }, path: [5, 10, 15, 20, 25, 30].map(at) };
    });
    await page.mouse.move(pts.handle.x, pts.handle.y);
    await page.mouse.down();
    for (const p of pts.path) await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    const dial = await page.evaluate(() => ({ deg: state.cutMiterDeg, text: document.getElementById('cut-dial-deg').textContent,
      typed: document.getElementById('cut-miter-deg').value, readout: document.getElementById('cut-readout').textContent }));
    check(route + ': dragging the handle round the rail set the mitre to about 30°',
      Math.abs(dial.deg - 30) <= 1 && dial.text === dial.deg + '°' && dial.typed === String(dial.deg),
      JSON.stringify(dial));
    const deg = dial.deg;
    const L = await page.evaluate(id => __longWorld(id), id);
    const b = await page.evaluate(() => __blade());
    // Clockwise seen from above: the bar's X turned about +Y by -deg.
    const want = [Math.cos(-deg * Math.PI / 180), 0, -Math.sin(-deg * Math.PI / 180)];
    check(route + ': the blade stands on the mitre', !!b && angleDeg(b.n, want) < 1e-4,
      b ? angleDeg(b.n, want).toExponential(1) + '° off; ' + angleDeg(b.n, L.dir).toFixed(3) + '° from the bar' : 'no blade');
    const r = await page.evaluate(id => __cut(id), id);
    check(route + ': Cut made two pieces on the ' + route + ' engine', !!r.got && r.got.engine === route && r.got.deg === deg, r.status);
    if (!r.got) continue;
    const nL = [Math.cos(-deg * Math.PI / 180), 0, -Math.sin(-deg * Math.PI / 180)];   // piece frame = world (un-posed)
    // The plane Cut used: n.x = (the piece's lowest n.v) + mm. mm is the blade's travel
    // along its own axis, on a 0.1 grid, so after the turn the plane crosses the centre
    // line (centred bar: y = z = 0) within half a grid step along n of the 30 mm it was
    // turned about - that is asserted, not assumed.
    const lo = Math.min(...r.src.soup.filter((_, i) => i % 3 === 0));
    let nMin = Infinity;
    for (let i = 0; i < r.src.soup.length; i += 3) nMin = Math.min(nMin, V.dot(nL, r.src.soup.slice(i, i + 3)));
    const d = nMin + r.got.mm;
    const c = nL.map(v => v * d);  // a point on the plane
    const cross = d / nL[0];       // where it meets the centre line, x
    check(route + ': the plane still crosses the centre line at the 30 mm it was turned about, to the grid (' +
      (cross - lo).toFixed(3) + ' mm)', Math.abs(cross - lo - 30) <= 0.05 / Math.cos(deg * Math.PI / 180) + 1e-6);
    const capA = capOf(r.got.left, c, nL), capB = capOf(r.got.right, c, nL);
    const wantArea = 96 / Math.cos(deg * Math.PI / 180);
    check(route + ': each half has one angled face on the plane, the whole section (' + wantArea.toFixed(2) + ' mm²)',
      !!capA.n && !!capB.n && angleDeg(capA.n, nL) < 1e-3 && angleDeg(capB.n, nL) < 1e-3 &&
      Math.abs(capA.area - wantArea) < 1e-3 * wantArea && Math.abs(capB.area - wantArea) < 1e-3 * wantArea,
      capA.area.toFixed(3) + ' / ' + capB.area.toFixed(3) + ' mm²');
    check(route + ': the halves meet exactly - the same cut-face vertices on both',
      capA.keys.size > 0 && capA.keys.size === capB.keys.size && [...capA.keys].every(k => capB.keys.has(k)),
      capA.keys.size + ' / ' + capB.keys.size + ' vertices');
    // The piece stays put: every face but the cut one keeps an original normal.
    const orig = tris(r.src.soup).map(T => T.n);
    const kept = soup => tris(soup).filter(T => Math.abs(V.dot(V.sub(T.a, c), nL)) > 1e-3 ||
      Math.abs(V.dot(V.sub(T.b, c), nL)) > 1e-3 || Math.abs(V.dot(V.sub(T.c, c), nL)) > 1e-3)
      .every(T => orig.some(n => angleDeg(n, T.n) < 1e-3 && V.dot(n, T.n) > 0));
    check(route + ': both halves keep the piece\'s orientation (every other face as it was)',
      kept(r.got.left) && kept(r.got.right));
    const vs = volume(r.src.soup), va = volume(r.got.left), vb = volume(r.got.right);
    check(route + ': the halves add back to the piece (volume)', Math.abs(va + vb - vs) < 1e-3 * vs,
      va.toFixed(3) + ' + ' + vb.toFixed(3) + ' vs ' + vs.toFixed(3));
    check(route + ': the halves on the plate keep the piece\'s pose', r.plate.every(p => p.quat && quatSame(p.quat, r.src.quat)));
    await page.evaluate(() => setCutMiter(0));
  }

  /* ------------------------------------------------------------------ 4b */
  console.log('\n=== 4b. the mitre − / + buttons: 1°, Shift 0.1°, Alt 5°, both ways; wheel, number and blade agree ===');
  {
    await page.evaluate(() => __clearAll());
    await shutCut();
    const id = await loadSTL(page, stl('bar60b.stl', box(60, 12, 8)));
    await ensureCut();
    await clickPieceAt(id, 0.5);
    await page.evaluate(() => setCutMm(30));
    /* What each surface shows, read as a user sees it: the handle's rendered
       position on the wheel (its screen matrix, so the real rotation; Chrome
       keeps those in float32, hence the 1e-3° slack - a step is 0.1°), the
       wheel's number, the typed box, the readout, and the blade's normal. */
    const surfaces = () => page.evaluate(() => {
      const dial = document.getElementById('cut-miter-dial');
      const at = (el, x, y) => new DOMPoint(x, y).matrixTransform(el.getScreenCTM());
      const c = at(dial, 50, 50), h = at(document.getElementById('cut-dial-handle'), 50, 10);
      return { state: state.cutMiterDeg,
               handle: (Math.atan2(h.x - c.x, -(h.y - c.y)) * 180 / Math.PI + 360) % 360,
               text: document.getElementById('cut-dial-deg').textContent,
               field: document.getElementById('cut-miter-deg').value,
               aria: dial.getAttribute('aria-valuenow'),
               readout: document.getElementById('cut-readout').textContent,
               blade: __blade() };
    });
    const agree = async (what, want) => {
      const s = await surfaces();
      const off = ((s.handle - want + 540) % 360) - 180;
      const nWant = [Math.cos(-want * Math.PI / 180), 0, -Math.sin(-want * Math.PI / 180)];
      const bladeOff = s.blade ? angleDeg(s.blade.n, nWant) : NaN;
      const readoutOk = want ? s.readout.includes(', mitre ' + want + '°') : !/mitre/.test(s.readout);
      check(what + ' -> ' + want + '°: wheel, number, readout and blade agree',
        s.state === want && Math.abs(off) < 1e-3 && s.text === want + '°' && s.field === String(want) &&
        s.aria === String(want) && bladeOff < 1e-4 && readoutOk,
        'state ' + s.state + ', handle ' + s.handle.toFixed(6) + '°, wheel "' + s.text + '", box "' + s.field +
        '", blade ' + bladeOff.toExponential(1) + '° off');
    };
    // A press is a real mouse down / up on the button with the real modifier
    // key held. (Not page.click: on this software-GL page each costs about
    // 0.3 s in stability frames, and a press here costs 0.1.)
    const centreOf = sel => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    const at = { 1: await centreOf('#btn-cut-miter-plus'), '-1': await centreOf('#btn-cut-miter-minus') };
    const press = async (sign, mod) => {
      if (mod) await page.keyboard.down(mod);
      await page.mouse.move(at[sign].x, at[sign].y);
      await page.mouse.down();
      await page.mouse.up();
      if (mod) await page.keyboard.up(mod);
    };
    const run = async seq => {
      for (const [sign, mod, want] of seq) {
        await press(sign, mod);
        await agree((mod ? mod + '-' : '') + (sign > 0 ? '+' : '−'), want);
      }
    };
    const typeMitre = async v => { await page.fill('#cut-miter-deg', String(v)); await page.dispatchEvent('#cut-miter-deg', 'change'); };

    const geo = await page.evaluate(() => {
      const d = document.getElementById('cut-miter-dial').getBoundingClientRect();
      const a = document.getElementById('btn-cut-miter-minus').getBoundingClientRect();
      const b = document.getElementById('btn-cut-miter-plus').getBoundingClientRect();
      return { dial: [d.left, d.right, d.bottom], mid: (a.left + b.right) / 2, dialMid: (d.left + d.right) / 2,
               inside: a.left >= d.left - 0.01 && b.right <= d.right + 0.01, top: Math.min(a.top, b.top) - d.bottom };
    });
    check('the buttons sit under the wheel, centred on its base, inside its width',
      Math.abs(geo.mid - geo.dialMid) < 0.5 && geo.inside && geo.top >= 0 && geo.top < 14, JSON.stringify(geo));

    await agree('start', 0);
    await run([[1, '', 1], [-1, '', 0], [1, 'Shift', 0.1], [-1, 'Shift', 0], [1, 'Alt', 5], [-1, 'Alt', 0]]);
    await typeMitre(30);
    await agree('typed', 30);
    await run([[1, '', 31], [-1, '', 30], [1, 'Shift', 30.1], [1, '', 31.1], [1, 'Alt', 36.1], [-1, 'Alt', 31.1],
               [-1, '', 30.1], [-1, 'Shift', 30]]);
    await run([[-1, 'Shift', 29.9], [1, 'Shift', 30], [-1, 'Alt', 25], [1, 'Alt', 30]]);
    await typeMitre(0);
    await run([[-1, 'Shift', 359.9], [1, 'Shift', 0], [-1, '', 359], [1, '', 0], [-1, 'Alt', 355], [1, 'Alt', 0]]);
    await typeMitre(30);
    for (let i = 0; i < 10; i++) await press(1, 'Shift');
    await agree('ten Shift-+ presses (no drift)', 31);

    // From the keyboard: Enter on the focused button is one press, Shift-Enter a Shift press.
    await page.focus('#btn-cut-miter-plus');
    await page.keyboard.press('Enter');
    await agree('Enter on +', 32);
    await page.keyboard.press('Shift+Enter');
    await agree('Shift-Enter on +', 32.1);
    await page.click('#btn-cut-square');
    await agree('Square', 0);

    // Held: a step at once, then it keeps stepping, in order, until release. Order
    // only - no millisecond cadence, which a loaded runner cannot keep.
    await page.evaluate(() => {
      window.__steps = [];
      new MutationObserver(() => window.__steps.push(state.cutMiterDeg)).observe(
        document.getElementById('cut-miter-dial'), { attributes: true, attributeFilter: ['aria-valuenow'] });
    });
    const c = at[1];
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.waitForTimeout(1000);
    await page.mouse.up();
    const held = await page.evaluate(() => window.__steps.slice());
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ n: window.__steps.length, deg: state.cutMiterDeg }));
    check('held: it stepped once and then repeated (at least two steps)', held.length >= 2, held.length + ' steps');
    check('...every step one whole degree up from the last, in order: no skip, repeat or reversal',
      held.every((d, i) => d === 1 + i), held.join(' '));
    check('...and releasing stops it', after.n === held.length, held.length + ' steps at release, ' + after.n + ' 300 ms later');
    await agree('after the hold', after.deg);
    await page.click('#btn-cut-square');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the slider and ← / → move the blade in 0.1 mm steps; the number tracks ===');
  {
    await page.evaluate(() => __clearAll());
    const id = await loadSTL(page, stl('bar60s.stl', box(60, 12, 8)));
    await ensureCut();
    await clickPieceAt(id, 0.5);
    const read = () => page.evaluate(() => ({ mm: getCutMm(), input: document.getElementById('cut-mm').value,
      slider: document.getElementById('cut-slider').value, blade: __blade().p,
      readout: document.getElementById('cut-readout').textContent }));
    await page.evaluate(() => { const s = document.getElementById('cut-slider'); s.value = '20'; s.dispatchEvent(new Event('input')); });
    const a = await read();
    check('the slider put the blade at 20.0 and the number says so', a.mm === 20 && a.input === '20.0' && +a.slider === 20,
      JSON.stringify({ mm: a.mm, input: a.input, slider: a.slider }));
    const sl = await page.evaluate(() => { const s = document.getElementById('cut-slider');
      return { step: s.step, min: +s.min, max: +s.max }; });
    check('the slider runs the whole piece at 0.1 mm resolution',
      sl.step === '0.1' && sl.min === 1 && sl.max === 59, JSON.stringify(sl));
    await page.evaluate(() => { const s = document.getElementById('cut-slider'); s.value = '20.3'; s.dispatchEvent(new Event('input')); });
    const a3 = await read();
    check('the slider stops at 20.3: blade and number on the tenth', a3.mm === 20.3 && a3.input === '20.3' && +a3.slider === 20.3,
      JSON.stringify({ mm: a3.mm, input: a3.input, slider: a3.slider }));
    await page.evaluate(() => { const s = document.getElementById('cut-slider'); s.value = '20'; s.dispatchEvent(new Event('input')); });
    await page.click('#btn-cut-nudge-p');
    const b = await read();
    const step = V.len(V.sub(b.blade, a.blade));
    check('→ moved it 0.1 mm along the piece; number and slider follow',
      b.mm === 20.1 && b.input === '20.1' && +b.slider === 20.1 && Math.abs(step - 0.1) < 1e-4,
      b.input + ', blade moved ' + step.toFixed(4) + ' mm');
    await page.click('#btn-cut-nudge-m');
    await page.click('#btn-cut-nudge-m');
    const c = await read();
    check('← ← moved it back 0.2 mm', c.mm === 19.9 && c.input === '19.9', c.input);
    await page.click('#btn-cut-nudge-p', { modifiers: ['Shift'] });
    const e = await read();
    const big = V.len(V.sub(e.blade, c.blade));
    check('Shift-→ moved it 1.0 mm', e.mm === 20.9 && e.input === '20.9' && +e.slider === 20.9 && Math.abs(big - 1) < 1e-4,
      e.input + ', blade moved ' + big.toFixed(4) + ' mm');
    await page.click('#btn-cut-nudge-m', { modifiers: ['Shift'] });
    await page.click('#btn-cut-nudge-m', { modifiers: ['Shift'] });
    const f = await read();
    check('Shift-← Shift-← moved it back 2.0 mm', f.mm === 18.9 && f.input === '18.9', f.input);
    await page.fill('#cut-mm', '33.3');
    await page.dispatchEvent('#cut-mm', 'change');
    const d = await read();
    check('a typed 33.3 moves the blade; the slider follows', d.mm === 33.3 && +d.slider === 33.3, d.slider);
    check('the readout tracks: 33.3 mm | 26.7 mm', /33\.3 mm \| 26\.7 mm/.test(d.readout), d.readout);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. Cut is a clean split on both engines; one Undo restores ===');
  for (const route of ['raw', 'display']) {
    await page.evaluate(() => __clearAll());
    await shutCut();
    const id = route === 'raw'
      ? await loadSTL(page, stl('bar8.stl', box(8, 12, 6)))
      : await page.evaluate(soup => __addDisplayPiece(soup, 'short-display'), box(8, 12, 6));
    await ensureCut();
    await clickPieceAt(id, 0.5);
    // the piece is 12 long along display Z here; put the blade at 4
    await page.evaluate(() => setCutMm(4));
    const ro = await page.evaluate(() => document.getElementById('cut-readout').textContent);
    check(route + ': readout "4.0 mm | 8.0 mm" - each side\'s true length, no kerf subtracted', /4\.0 mm \| 8\.0 mm/.test(ro), ro);
    const r = await page.evaluate(id => __cut(id), id);
    check(route + ': Cut made two pieces, one Undo step', !!r.got && r.models === 2 && r.got.engine === route, r.status);
    if (!r.got) continue;
    const ai = 'xyz'.indexOf(r.got.axis);
    const span = soup => { const v = soup.filter((_, i) => i % 3 === ai); return [Math.min(...v), Math.max(...v)]; };
    const S = span(r.src.soup), A = span(r.got.left), B = span(r.got.right);
    check(route + ': the halves are 4 and 8 long and add back to 12 exactly - no kerf, no gap, no overlap',
      Math.abs((A[1] - A[0]) - 4) < 1e-5 && Math.abs((B[1] - B[0]) - 8) < 1e-5 && A[1] === B[0] && A[0] === S[0] && B[1] === S[1],
      'A ' + A.map(v => v.toFixed(5)).join('..') + ', B ' + B.map(v => v.toFixed(5)).join('..'));
    check(route + ': the status names the true lengths', /-A4 4\.0 mm \+ .*-B4 8\.0 mm/.test(r.status) && !/kerf/.test(r.status), r.status);
    const vs = volume(r.src.soup), va = volume(r.got.left), vb = volume(r.got.right);
    check(route + ': volumes add back exactly', Math.abs(va + vb - vs) < 1e-6 * vs, va + ' + ' + vb + ' vs ' + vs);
    const u = await page.evaluate(() => __undo());
    const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    check(route + ': one Undo puts the original back (one piece, the same triangles)',
      u.models === 1 && same(u.soup, r.src.soup) && (route === 'display' || same(u.raw, r.src.raw)), u.status);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. Crop works from its own card ===');
  {
    await page.evaluate(() => __clearAll());
    await shutCut();
    const id = await loadSTL(page, stl('bar60c.stl', box(60, 12, 8)));
    await clickSummary('menu-crop');
    const s = await armed();
    check('opening the Crop card arms Crop, with no blade and Cut shut', s.open && s.tool === 'crop' && !s.blade && !s.card && s.crop,
      JSON.stringify(s));
    await clickPieceAt(id, 0.5);
    const sel = await page.evaluate(() => ({ editId: state.editId, blade: !!state.cutHelper,
      disabled: document.getElementById('btn-crop').disabled, ro: document.getElementById('crop-readout').textContent }));
    check('a click picks the piece for Crop; still no blade; the card asks for a shape, CROP off',
      sel.editId === id && !sel.blade && sel.disabled && /^Pick a shape/.test(sel.ro), JSON.stringify(sel));
    // The card is a Shape row and a button now (docs/CROP.md): pick Box, CROP copies what it holds.
    await page.click('#btn-crop-shape-box');
    await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 30000 });
    const rb = await page.evaluate(() => document.getElementById('crop-readout').textContent);
    check('Box: it stands on the piece and the readout says what it holds', /^Box [\d.]+ × [\d.]+ × [\d.]+ mm · holds \d+ faces/.test(rb), rb);
    const lenBefore = await page.evaluate(id => state.models.find(m => m.id === id).size.x, id);
    await page.click('#btn-crop');
    await page.waitForFunction(() => state.models.length === 2, null, { timeout: 30000 });
    const st = await statusOf(page);
    const after = await page.evaluate(id => ({ len: state.models.find(m => m.id === id).size.x, names: state.models.map(m => m.name) }), id);
    check('CROP copied it: a new piece "<name> crop 1", the original still 60 long', /^Crop: "bar60c crop 1"/.test(st) && after.names[1] === 'bar60c crop 1' && Math.abs(after.len - lenBefore) < 1e-9 && Math.abs(after.len - 60) < 1e-3,
      st.slice(0, 120));
    await clickSummary('menu-crop');
    const s2 = await armed();
    check('closing the Crop card disarms it', !s2.open && !s2.crop, JSON.stringify(s2));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. cut, then Join the halves: the original back ===');
  for (const [name, soup, f] of [['box20', box(20, 20, 20), 0.35], ['bar60', box(60, 12, 8), 0.4]]) {
    await page.evaluate(() => __clearAll());
    await shutCut();
    const id = await loadSTL(page, stl(name + 'j.stl', soup));
    const orig = await page.evaluate(id => Array.from(state.models.find(x => x.id === id).rawTris), id);
    await ensureCut();
    await clickPieceAt(id, f);
    const r = await page.evaluate(id => __cut(id), id);
    check(name + ': cut into two', !!r.got && r.plate.length === 2, r.status);
    if (r.plate.length !== 2) continue;
    // Join through its own card, picking A and B on the plate with the mouse.
    await openJoin(page);
    await page.click('#join-slot-a');
    await clickPieceAt(r.plate[0].id, 0.5);
    await page.click('#join-slot-b');
    await clickPieceAt(r.plate[1].id, 0.5);
    await page.click('#btn-join');
    await page.waitForFunction(() => /Join ok|Join failed|Join refused/.test(document.getElementById('status').textContent),
      null, { timeout: 60000 }).catch(() => {});
    const j = await page.evaluate(() => {
      const m = state.models.length === 1 ? state.models[0] : null;
      const e = m && typeof NSO_edgeStats === 'function' ? NSO_edgeStats(m.rawTris) : null;
      return { status: document.getElementById('status').textContent, models: state.models.length,
               raw: m ? Array.from(m.rawTris) : null, open: e ? e.open : null, nm: e ? e.nm : null };
    });
    check(name + ': Join made one piece of the two halves', j.models === 1 && /Join ok/.test(j.status), j.status);
    if (!j.raw) continue;
    const spans = t => [0, 1, 2].map(a => { const v = t.filter((_, i) => i % 3 === a); return Math.max(...v) - Math.min(...v); });
    const area = t => tris(t).reduce((a, T) => a + T.area, 0);
    const So = spans(orig), Sj = spans(j.raw);
    check(name + ': the joined piece is the original - size, volume and surface, closed',
      So.every((v, i) => Math.abs(v - Sj[i]) < 1e-4) && Math.abs(volume(j.raw) - volume(orig)) < 1e-6 * volume(orig) &&
      Math.abs(area(j.raw) - area(orig)) < 1e-6 * area(orig) && j.open === 0 && j.nm === 0,
      'size ' + Sj.map(v => v.toFixed(4)).join(' x ') + ' vs ' + So.map(v => v.toFixed(4)).join(' x ') +
      ', volume ' + volume(j.raw).toFixed(4) + ' vs ' + volume(orig).toFixed(4) +
      ', area ' + area(j.raw).toFixed(4) + ' vs ' + area(orig).toFixed(4) + ', open ' + j.open + ', nm ' + j.nm + '; ' + j.status);
    await page.evaluate(() => { if (state.joinSession && typeof clearJoinSlots === 'function') clearJoinSlots(); });
    await page.evaluate(() => document.querySelectorAll('.vp-menu[open]').forEach(d => { d.open = false; }));
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. a flipped pose record: each half lands where its part was ===');
  {
    // A piece whose record carries flipX (a scene 3MF puts one back): the
    // halves must land on the side of the plate their part of the piece was
    // on, not swapped across the cut.
    await page.evaluate(() => __clearAll());
    await shutCut();
    const id = await loadSTL(page, stl('barZf.stl', box(12, 60, 8)));
    await page.evaluate(id => {
      const p = state.placed.find(q => q && q.sourceId === id);
      p.flipX = true;
      applyMeshRotation(p);
    }, id);
    await ensureCut();
    await clickPieceAt(id, 0.25);
    const r = await page.evaluate(id => __cut(id), id);
    check('the flipped bar is cut', !!r.got && r.plate.length === 2, r.status);
    if (r.got && r.plate.length === 2) {
      const ctr = soup => { const c = [0, 1, 2].map(a => { const v = soup.filter((_, i) => i % 3 === a); return (Math.max(...v) + Math.min(...v)) / 2; }); return applyM(r.src.Mw, c); };
      const wA = ctr(r.got.left), wB = ctr(r.got.right);
      const A = r.plate.find(p => /-A\d+$/.test(p.name)), B = r.plate.find(p => /-B\d+$/.test(p.name));
      const dWorld = V.sub(wB, wA), dPlate = V.sub(B.pos, A.pos);
      check('A and B sit on the plate the way round they were in the piece (not swapped)',
        V.dot([dWorld[0], 0, dWorld[2]], [dPlate[0], 0, dPlate[2]]) > 0 &&
        Math.abs(Math.abs(dPlate[2]) - (Math.abs(dWorld[2]) + 8)) < 1e-3,
        'piece B-A ' + dWorld.map(v => v.toFixed(2)).join(', ') + '; plate B-A ' + dPlate.map(v => v.toFixed(2)).join(', '));
    }
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
