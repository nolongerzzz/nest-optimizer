/* Mold, in the real page.
   node tools/nso_mold_drive_check.js        exit 0 = every gate held

   index.html and every app-*.js in Chromium at 1280 x 800 (tools/nso_app_harness.js).
   A Stock sphere Ø30 is made with the Stock card, Gen+ -> Mold is opened as a
   person opens it, and then: the blade (slider, <- number ->, dial, tilt) and the
   plane it draws; the lock count and the tint; a real mouse click on the piece
   moving the pour point; Generate; the two pieces on the plate beside the
   original, closed and manifold (the halves are pulled back out of the page and
   put through tools/mesh_validate.py); one Undo removing both, Regenerate
   replacing a pair; the refusals in words (an open mesh, a block bigger than
   the plate, keys that would not fit); and the open pair photographed.

   The geometry's own numbers (cavity volume, key positions, mating faces, the
   sprue and vent by point-in-solid) are tools/nso_mold_test.js's job; here the
   page is asked to agree with it, and to do the page's part. The screenshot is
   written to tools/mold-out/. */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const lib = require('./nso_mold_testlib.js');

const OUT = path.join(__dirname, 'mold-out');
fs.mkdirSync(OUT, { recursive: true });

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, t) => Math.abs(a - b) <= t;
const f = (v, d) => (+v).toFixed(d == null ? 2 : d);

const setF = (page, v) => page.evaluate(o => {
  for (const id of Object.keys(o)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!o[id];
    else el.value = o[id] === null ? '' : String(o[id]);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, v);

/* What a person sees and what the page holds, in one read. */
const look = page => page.evaluate(() => {
  const L = window.nsoMold.layer(), pl = window.nsoMold.plan();
  const g = n => (L && L.getObjectByName(n)) || null;
  const pos = n => { const o = g(n); return o ? Array.from(o.geometry.attributes.position.array) : null; };
  const txt = id => (document.getElementById(id) || {}).textContent;
  const v = id => (document.getElementById(id) || {}).value;
  return {
    armed: window.nsoMold.armed(), target: window.nsoMold.target(),
    names: L ? L.children.map(c => c.name) : [],
    lockText: txt('mold-lock'), pourText: txt('mold-pour'), readout: txt('mold-readout'), status: txt('mold-status'),
    btn: txt('btn-mold-make'), btnDisabled: document.getElementById('btn-mold-make').disabled,
    slider: v('mold-slider'), mm: v('mold-mm'), heading: v('mold-heading'), tilt: v('mold-tilt'),
    dialDeg: txt('mold-dial-deg'), dialTurn: document.getElementById('mold-dial-turn').getAttribute('transform'),
    frame: pos('moldBladeFrame'), lockTris: pos('moldLock') ? pos('moldLock').length / 9 : 0,
    marker: g('moldPourMarker') ? g('moldPourMarker').position.toArray() : null,
    layerVisible: !!(L && L.visible),
    plan: pl && {
      ok: pl.ok, refusals: pl.refusals, warnings: pl.warnings, lock: pl.lock.areaMm2,
      n: pl.plane.n, c: pl.plane.c, mm: pl.plane.mm, lo: pl.plane.lo, hi: pl.plane.hi, p0: pl.plane.p0,
      block: pl.block.size, bounds: pl.bounds, pour: pl.pour && pl.pour.ok ? { point: pl.pour.point, dir: pl.pour.dir, auto: pl.pour.auto, len: pl.pour.lengthMm } : null,
      vent: pl.vent && pl.vent.ok ? pl.vent.point : null
    },
    planPour: (() => { const e = document.getElementById('mold-plan-pour'); return e ? [+e.getAttribute('data-x'), +e.getAttribute('data-z')] : null; })()
  };
});

const pieces = page => page.evaluate(() => state.placed.map(p => ({
  id: p.sourceId, name: p.name, x: p.x, z: p.z, w: p.width, d: p.depth, h: p.height,
  open: (() => { const r = NSO_Repair.inspect(state.models.find(m => m.id === p.sourceId).rawTris, { selfIntersections: false }); return [r.openEdges, r.nonManifoldEdges, r.degenerateTris]; })()
})));

const sumOf = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i); let s = 0;
  for (let k = 0; k < m.rawTris.length; k++) s += m.rawTris[k] * (k % 7 + 1);
  return { n: m.rawTris.length / 9, s };
}, id);

const openMold = async page => {
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; });
  const open = await page.evaluate(() => document.getElementById('menu-mold').open);
  if (!open) await page.click('#menu-mold > summary');
  await page.waitForFunction(() => window.nsoMold && window.nsoMold.armed() && window.nsoMold.plan(), null, { timeout: 15000 });
};

const waitGenerated = (page, was) => page.waitForFunction(w => {
  const p = window.nsoMold.pair();
  return !window.nsoMold.busy() && p && (!w || p.ids.join() !== w);
}, was || null, { timeout: 90000 });

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);

  console.log('\n=== 1. A Stock sphere Ø30 from the Stock shelf; Gen+ -> Mold on it ===');
  const H = await page.evaluate(() => {
    let lo = 5, hi = 300;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2, r = NSO_Stock.size({ shape: 'sphere', height: mid, waste: 0 });
      if (r.measure.radius < 15) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  });
  // The Stock shelf's own drop, asked for a Ø30 ball (a tile drops the default size).
  await page.evaluate(h => nsoStockShelf.drop('sphere', { height: h, wall: 3, waste: 0 }), H);
  const sphId = await page.evaluate(() => state.models[state.models.length - 1].id);
  const sph = await page.evaluate(i => { const m = state.models.find(x => x.id === i); return { name: m.name, size: [m.size.x, m.size.y, m.size.z] }; }, sphId);
  check('the Stock shelf made a sphere Ø30', sph.size.every(v => near(v, 30, 0.05)), JSON.stringify(sph.size.map(v => +v.toFixed(3))));
  const sphBefore = await sumOf(page, sphId);
  const sphPlaced = await page.evaluate(i => { const p = state.placed.find(q => q.sourceId === i); return { x: p.x, z: p.z }; }, sphId);

  await page.evaluate(() => { state.selectedIndex = state.placed.length - 1; selectPlaced(state.placed.length - 1); });
  await page.evaluate(() => { document.getElementById('menu-gen').open = true; });
  check('the Mold entry is in Gen+, with its own card, beside Wheel, Stock and Picture',
    await page.evaluate(() => ['Wheel', 'Stock', 'Picture', 'Mold'].every(t => [...document.querySelectorAll('#menu-gen > .vp-menu-body > details > summary')].some(s => s.textContent.trim() === t))));
  await openMold(page);
  let L = await look(page);
  check('opening the card arms Mold on the selected piece', L.armed && L.target === sphId, 'target ' + L.target);
  check('the card says the block: 50.0 × 50.0 × 60.0 mm', /block 50\.0 × 50\.0 × 60\.0 mm/.test(L.status), L.status);
  check('the blade is drawn at the middle of the height, level: the plane is y = bottom + 15', near(L.plan.mm, 15, 1e-9) && L.plan.n.join() === '0,1,0' && near(L.plan.p0[1], L.plan.bounds.min[1] + 15, 1e-6),
    'mm ' + L.plan.mm + ', y ' + f(L.plan.p0[1], 3));
  check('the helpers are in the scene: block, blade, its frame, the keys, the sprue, the vent and the pour marker',
    ['moldBlock', 'moldBlade', 'moldBladeFrame', 'moldKeys', 'moldSprue', 'moldVent', 'moldPourMarker'].every(n => L.names.includes(n)), L.names.join(','));
  check('the pour marker sits at the cavity\'s highest point', L.plan.pour.auto && L.marker && L.marker.every((v, i) => near(v, L.plan.pour.point[i], 1e-4)) && near(L.plan.pour.point[1] - L.plan.bounds.max[1], 0, 1e-3),
    'marker ' + L.marker.map(v => f(v, 2)).join(', '));
  check('the card shows the pour point as a marker, in its plan view', L.planPour && near(L.planPour[0], L.plan.pour.point[0], 0.01) && near(L.planPour[1], L.plan.pour.point[2], 0.01));
  check('the lock count is on the card, "0 mm² would lock" at the mid-plane of a sphere', L.lockText === '0 mm² would lock' && L.lockTris === 0, L.lockText);
  check('the card is the Cut card\'s controls: slider, ← number →, dial',
    await page.evaluate(() => !!(document.getElementById('mold-slider') && document.getElementById('btn-mold-nudge-m') && document.getElementById('mold-mm') && document.getElementById('btn-mold-nudge-p') && document.getElementById('mold-dial'))));
  check('Generate is ready and says so', !L.btnDisabled && L.btn === 'Generate mold');
  // the piece fits the card on screen
  const box = await page.evaluate(() => { const r = document.getElementById('btn-mold-make').getBoundingClientRect(); return [r.top, r.bottom, window.innerHeight]; });
  check('the whole card, Generate included, is on screen at 1280 × 800', box[1] <= box[2] && box[0] > 0, 'button ' + f(box[0], 0) + '..' + f(box[1], 0) + ' of ' + box[2]);

  console.log('\n=== 2. the blade: slider, nudge, number, dial, tilt ===');
  const bottom = L.plan.bounds.min[1];
  await page.evaluate(() => { const s = document.getElementById('mold-slider'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  L = await look(page);
  check('the slider moves the plane to 8.0 mm; the number follows', near(L.plan.mm, 8, 1e-9) && L.mm === '8.0' && near(parseFloat(L.slider), 8, 1e-9));
  check('the lock count goes up, and the locking faces are tinted on the piece', /^\d+ mm² would lock$/.test(L.lockText) && L.plan.lock > 100 && L.lockTris > 100, L.lockText + ', ' + L.lockTris + ' tinted triangles');
  check('the blade is drawn at the plane: its frame is on y = bottom + 8', L.frame && L.frame.length >= 24 && [1, 4, 7, 10, 13, 16, 19, 22].every(i => near(L.frame[i], bottom + 8, 1e-3)),
    'frame y ' + f(L.frame[1], 3));
  await page.click('#btn-mold-nudge-p');
  L = await look(page);
  check('→ nudges the plane up 0.1 mm', near(L.plan.mm, 8.1, 1e-9) && L.mm === '8.1', L.mm);
  await page.click('#btn-mold-nudge-m', { modifiers: ['Shift'] });
  L = await look(page);
  check('Shift-← nudges it down 1 mm', near(L.plan.mm, 7.1, 1e-9) && L.mm === '7.1', L.mm);
  await setF(page, { 'mold-mm': 15 });
  L = await look(page);
  check('typing 15 in the number puts it back at the mid-plane: 0 mm² would lock', near(L.plan.mm, 15, 1e-9) && L.lockText === '0 mm² would lock' && L.lockTris === 0, L.lockText);
  await setF(page, { 'mold-mm': 500 });
  L = await look(page);
  check('the number is held to the range (1 mm in from the end)', near(L.plan.mm, L.plan.hi, 1e-9) && near(L.plan.hi, L.plan.bounds.size[1] - 1, 0.1), 'hi ' + L.plan.hi);
  await setF(page, { 'mold-mm': 15 });

  // the dial: a real drag on the wheel
  const dial = await page.evaluate(() => { const r = document.getElementById('mold-dial').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 }; });
  await page.mouse.move(dial.x + dial.r * 0.8, dial.y);                 // 3 o'clock = 90 deg clockwise
  await page.mouse.down();
  L = await look(page);
  check('pressing the dial at 3 o\'clock sets the lean to 90°', L.heading === '90' && L.dialDeg === '90°' && /rotate\(90 /.test(L.dialTurn), L.heading + ' ' + L.dialTurn);
  await page.mouse.move(dial.x, dial.y + dial.r * 0.8);                 // dragged round to 6 o'clock
  await page.mouse.up();
  L = await look(page);
  check('dragged round to 6 o\'clock: 180°', L.heading === '180' && L.dialDeg === '180°', L.heading);
  await setF(page, { 'mold-heading': 90, 'mold-tilt': 20 });
  L = await look(page);
  const tau = 20 * Math.PI / 180;
  check('Tilt 20°, leaning toward 90°: the plane\'s normal is (sin 20, cos 20, 0)', near(L.plan.n[0], Math.sin(tau), 1e-9) && near(L.plan.n[1], Math.cos(tau), 1e-9) && near(L.plan.n[2], 0, 1e-9),
    L.plan.n.map(v => f(v, 4)).join(', '));
  check('the blade drawn on the tilted plane: every frame corner satisfies n·p = c',
    L.frame.length >= 18 && Array.from({ length: L.frame.length / 3 }, (_, i) => Math.abs(L.plan.n[0] * L.frame[i * 3] + L.plan.n[1] * L.frame[i * 3 + 1] + L.plan.n[2] * L.frame[i * 3 + 2] - L.plan.c)).every(d => d < 1e-3));
  check('the plane still crosses the centre line at the slider\'s height', near(L.plan.n[0] * L.plan.p0[0] + L.plan.n[1] * L.plan.p0[1] + L.plan.n[2] * L.plan.p0[2], L.plan.c, 1e-9) && near(L.plan.p0[1], bottom + 15, 1e-6));
  await setF(page, { 'mold-tilt': 0, 'mold-heading': 0 });
  L = await look(page);
  check('Tilt 0 puts it level again', L.plan.n.join() === '0,1,0');

  console.log('\n=== 3. a real click on the piece moves the pour point ===');
  const aim = await page.evaluate(() => {
    // the screen spot of a point on the upper sphere, 40 deg up and 30 deg round, and the canvas box
    const pl = window.nsoMold.plan(), c = [(pl.bounds.min[0] + pl.bounds.max[0]) / 2, (pl.bounds.min[1] + pl.bounds.max[1]) / 2, (pl.bounds.min[2] + pl.bounds.max[2]) / 2];
    const el = 40 * Math.PI / 180, az = 30 * Math.PI / 180, r = 15;
    const P = new THREE.Vector3(c[0] + r * Math.cos(el) * Math.cos(az), c[1] + r * Math.sin(el), c[2] + r * Math.cos(el) * Math.sin(az));
    const q = P.clone().project(state.camera), rect = state.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (q.x + 1) / 2 * rect.width, y: rect.top + (1 - q.y) / 2 * rect.height, P: P.toArray(), c };
  });
  await page.mouse.click(aim.x, aim.y);
  L = await look(page);
  const hitP = L.plan.pour.point, dc = Math.hypot(hitP[0] - aim.c[0], hitP[1] - aim.c[1], hitP[2] - aim.c[2]);
  check('the click moves the pour point onto the piece where it landed', !L.plan.pour.auto && near(dc, 15, 0.1) && Math.hypot(hitP[0] - aim.P[0], hitP[1] - aim.P[1], hitP[2] - aim.P[2]) < 1.5,
    'pour (' + hitP.map(v => f(v, 2)).join(', ') + '), ' + f(dc, 3) + ' mm from the centre');
  check('  ... the marker in the scene and in the card\'s plan view are there', L.marker.every((v, i) => near(v, hitP[i], 1e-4)) && near(L.planPour[0], hitP[0], 0.01) && near(L.planPour[1], hitP[2], 0.01));
  const cand = [['+y', L.plan.bounds.max[1] + 15 - hitP[1]], [hitP[0] > aim.c[0] ? '+x' : '-x', Math.abs((hitP[0] > aim.c[0] ? L.plan.bounds.max[0] + 10 : L.plan.bounds.min[0] - 10) - hitP[0])],
    [hitP[2] > aim.c[2] ? '+z' : '-z', Math.abs((hitP[2] > aim.c[2] ? L.plan.bounds.max[2] + 10 : L.plan.bounds.min[2] - 10) - hitP[2])]].sort((a, b) => a[1] - b[1])[0];
  check('  ... the sprue re-routes straight to the nearest outer face', L.plan.pour.dir === cand[0] && near(L.plan.pour.len, cand[1], 1e-6), L.plan.pour.dir + ' ' + f(L.plan.pour.len, 3) + ' mm; nearest by hand: ' + cand[0] + ' ' + f(cand[1], 3));
  check('  ... and the card says where the pour is now', /where you clicked/.test(L.pourText), L.pourText);
  await page.click('#btn-mold-pour-reset');
  L = await look(page);
  check('Pour: top puts it back at the highest point', L.plan.pour.auto && L.plan.pour.dir === '+y', L.pourText);
  // the click on empty plate is not the card's
  await page.mouse.click(1100, 700);
  L = await look(page);
  check('a click off the piece leaves the pour alone', L.plan.pour.auto);

  console.log('\n=== 4. Generate: two pieces beside the original, one Undo ===');
  const t0 = Date.now();
  await page.click('#btn-mold-make');
  await waitGenerated(page, null);
  const dt = Date.now() - t0;
  let P = await pieces(page);
  const nameA = sph.name + ' mold A', nameB = sph.name + ' mold B';
  const A = P.find(p => p.name === nameA), B = P.find(p => p.name === nameB), orig = P.find(p => p.id === sphId);
  check('two new pieces on the plate, named "<piece> mold A" and "<piece> mold B"', P.length === 3 && !!A && !!B, P.map(p => p.name).join(', ') + ' (' + dt + ' ms)');
  check('the original stays: same triangles, same place', JSON.stringify(await sumOf(page, sphId)) === JSON.stringify(sphBefore) && orig && orig.x === sphPlaced.x && orig.z === sphPlaced.z);
  const clear = (p, q) => Math.abs(p.x - q.x) >= (p.w + q.w) / 2 + 3.9 || Math.abs(p.z - q.z) >= (p.d + q.d) / 2 + 3.9;
  check('beside the original, clear of it and of each other, on the bed', clear(A, orig) && clear(B, orig) && clear(A, B) &&
    [A, B].every(p => Math.abs(p.x) + p.w / 2 <= 90 + 1e-6 && Math.abs(p.z) + p.d / 2 <= 90 + 1e-6), P.map(p => p.name + ' (' + f(p.x, 1) + ', ' + f(p.z, 1) + ')').join('; '));
  check('both halves closed and manifold by the page\'s checker', [A, B].every(p => p.open[0] === 0 && p.open[1] === 0 && p.open[2] === 0), JSON.stringify([A.open, B.open]));
  check('each half is a 50 × 50 mm block, 30 mm and 33 mm tall (A with its cones)', near(A.w, 50, 0.01) && near(A.d, 50, 0.01) && near(B.w, 50, 0.01) && near(B.d, 50, 0.01) && near(B.h, 30, 0.01) && near(A.h, 33, 0.01),
    'A ' + f(A.w, 2) + ' x ' + f(A.d, 2) + ' x ' + f(A.h, 2) + ', B ' + f(B.w, 2) + ' x ' + f(B.d, 2) + ' x ' + f(B.h, 2));
  const raws = await page.evaluate(ids => ids.map(i => Array.from(state.models.find(m => m.id === i).rawTris)), [A.id, B.id]);
  for (const [n, r] of [['A', raws[0]], ['B', raws[1]]]) {
    const v = lib.validate(new Float32Array(r), null, { selfint: true });
    check('half ' + n + ', taken back out of the page, passes tools/mesh_validate.py (self-intersection included)', v.verdict === 'PASS' && v.open_edges === 0 && v.nonmanifold_edges === 0 && v.inconsistent_winding_edges === 0 && v.degenerate_tris === 0, v.summary);
  }
  const M = require('../nso_mold.js');
  const vA = M.volume(new Float32Array(raws[0])), vB = M.volume(new Float32Array(raws[1]));
  const kv = M.keyVolumes({}), pv = await page.evaluate(i => { const m = state.models.find(x => x.id === i); const s = m.rawTris; let v6 = 0; const r = [s[0], s[1], s[2]];
    for (let o = 0; o + 8 < s.length; o += 9) { const a = [s[o] - r[0], s[o + 1] - r[1], s[o + 2] - r[2]], b = [s[o + 3] - r[0], s[o + 4] - r[1], s[o + 5] - r[2]], c = [s[o + 6] - r[0], s[o + 7] - r[1], s[o + 8] - r[2]];
      v6 += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]); } return v6 / 6; }, sphId);
  const cavity = 50 * 50 * 60 - vA - vB + 4 * (kv.cone - kv.socket);
  const plan0 = await page.evaluate(() => window.nsoMold.plan());
  const wantC = pv + Math.PI * 16 * plan0.pour.lengthMm + Math.PI * 2.25 * plan0.vent.ch.lengthMm;
  check('the cavity is the sphere + the sprue + the vent within 0.5 % (halves read back out of the page)', Math.abs(cavity - wantC) / wantC < 0.005, f(cavity, 1) + ' vs ' + f(wantC, 1) + ' mm³');
  const msg = await page.evaluate(() => document.getElementById('status').textContent);
  check('the status line says what was made and that one Undo removes both', /mold A/.test(msg) && /mold B/.test(msg) && /One Undo/.test(msg), msg.slice(0, 120));
  L = await look(page);
  check('the button now says Regenerate', L.btn === 'Regenerate mold');
  const idsFirst = await page.evaluate(() => window.nsoMold.pair().ids.join());

  // the open pair, photographed: the card shut, both halves in view beside the sphere
  await page.evaluate(() => { document.getElementById('menu-mold').open = false; document.getElementById('menu-gen').open = false; });
  // a closer, higher view over the three pieces, so the cavities, cones and sockets read
  await page.evaluate(() => {
    const ps = state.placed.map(p => ({ x: p.x, z: p.z, w: p.width, d: p.depth }));
    const x0 = Math.min(...ps.map(p => p.x - p.w / 2)), x1 = Math.max(...ps.map(p => p.x + p.w / 2));
    const z0 = Math.min(...ps.map(p => p.z - p.d / 2)), z1 = Math.max(...ps.map(p => p.z + p.d / 2));
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, span = Math.max(x1 - x0, z1 - z0);
    state.controls.target.set(cx, 8, cz);
    state.camera.position.set(cx + span * 0.1, span * 1.45, cz + span * 1.3);
    state.controls.update();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'mold-open-pair.png') });
  check('the open pair is photographed', fs.statSync(path.join(OUT, 'mold-open-pair.png')).size > 20000, 'tools/mold-out/mold-open-pair.png');
  await openMold(page);

  console.log('\n=== 5. Regenerate replaces the pair; Undo takes it away, once ===');
  const at1 = await pieces(page);
  await page.click('#btn-mold-make');
  await waitGenerated(page, idsFirst);
  const at2 = await pieces(page);
  const idsSecond = await page.evaluate(() => window.nsoMold.pair().ids.join());
  check('Regenerate: still one pair (three pieces), the new pair\'s ids, in the places the old pair had',
    at2.length === 3 && idsSecond !== idsFirst && [nameA, nameB].every(n => { const o = at1.find(p => p.name === n), q = at2.find(p => p.name === n); return o && q && near(o.x, q.x, 1e-6) && near(o.z, q.z, 1e-6); }),
    at2.map(p => p.name).join(', '));
  check('  ... the old pair\'s models are gone from the model list too', await page.evaluate(ids => !ids.split(',').some(i => state.models.some(m => m.id === +i)), idsFirst));
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  let afterUndo = await pieces(page);
  const idsNow = await page.evaluate(() => window.nsoMold.pair() && window.nsoMold.pair().ids.join());
  check('one Undo takes the regenerated pair off and puts the first one back', afterUndo.length === 3 && idsNow === idsFirst && !(await page.evaluate(ids => ids.split(',').some(i => state.models.some(m => m.id === +i)), idsSecond)),
    afterUndo.map(p => p.name).join(', '));
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
  afterUndo = await pieces(page);
  check('one more Undo removes BOTH halves; the original is the only piece left, untouched', afterUndo.length === 1 && afterUndo[0].id === sphId && JSON.stringify(await sumOf(page, sphId)) === JSON.stringify(sphBefore) &&
    (await page.evaluate(() => state.models.length)) === 1, afterUndo.map(p => p.name).join(', '));
  L = await look(page);
  check('the card goes back to Generate mold, still armed on the piece', L.btn === 'Generate mold' && L.armed && L.target === sphId && !L.btnDisabled, L.btn);

  console.log('\n=== 6. the piece as it lies: a pose changes the block ===');
  await page.evaluate(() => nsoStockShelf.drop('box', { height: 40, radius: 20, wall: 3, waste: 0, proportions: { x: 2, y: 1, z: 1 } }));
  await page.waitForTimeout(300);
  const boxId = await page.evaluate(() => state.models[state.models.length - 1].id);
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); selectPlaced(k); }, boxId);
  await openMold(page);
  await page.waitForFunction(i => window.nsoMold.target() === i, boxId, { timeout: 5000 });
  L = await look(page);
  check('selecting another piece retargets the card; the plane starts at its middle', L.target === boxId && near(L.plan.mm, L.plan.bounds.size[1] / 2, 0.05), 'target ' + L.target + ', mm ' + L.mm);
  const b0 = L.plan.bounds.size.slice();
  check('a box tilted 20° with the blade: the plane follows the slider', await (async () => {
    let ok = true;
    for (const mm of [5, 12, 20]) {
      await setF(page, { 'mold-heading': 90, 'mold-tilt': 20, 'mold-mm': mm });
      const q = await look(page), m2 = Math.min(Math.max(mm, q.plan.lo), q.plan.hi);
      const onLine = q.plan.n[0] * q.plan.p0[0] + q.plan.n[1] * q.plan.p0[1] + q.plan.n[2] * q.plan.p0[2] - q.plan.c;
      if (!(near(q.plan.mm, m2, 1e-9) && near(onLine, 0, 1e-9) && near(q.plan.p0[1], q.plan.bounds.min[1] + m2, 1e-6) && q.plan.lock > 0)) ok = false;
    }
    return ok;
  })(), 'mm 5, 12, 20: on the centre line, lock > 0 each time');
  await setF(page, { 'mold-tilt': 0, 'mold-heading': 0, 'mold-mm': b0[1] / 2 });
  L = await look(page);
  check('...and the same level box at its mid-plane: 0 mm² would lock', L.lockText === '0 mm² would lock', L.lockText);
  await page.evaluate(() => document.getElementById('btn-rot-right').click());
  await page.waitForFunction(b => { const p = window.nsoMold.plan(); return p && Math.abs(p.bounds.size[0] - b[2]) < 0.01; }, b0, { timeout: 5000 });
  L = await look(page);
  check('turned 90° on the plate, the block turns with it: X and Z swap', near(L.plan.bounds.size[0], b0[2], 0.01) && near(L.plan.bounds.size[2], b0[0], 0.01) && !near(b0[0], b0[2], 0.01),
    'was ' + b0.map(v => f(v, 1)).join(' x ') + ', now ' + L.plan.bounds.size.map(v => f(v, 1)).join(' x '));

  console.log('\n=== 7. refusals, in words ===');
  await setF(page, { 'mold-wall': 6 });
  L = await look(page);
  check('Wall 6 mm: keys that would not fit - the card says so, and the minimum wall; Generate is off', /minimum wall/.test(L.readout) && /8\.4 mm/.test(L.readout) && L.btnDisabled, L.readout);
  const before7 = (await pieces(page)).length;
  const r7 = await page.evaluate(() => window.nsoMold.generate());
  check('  ... and Generate from the API is refused with that text, nothing made', r7.ok === false && /minimum wall/.test(r7.reason) && (await pieces(page)).length === before7);
  await setF(page, { 'mold-wall': 10 });

  await page.evaluate(() => document.getElementById('menu-mold').open = false);
  const bigId = await page.evaluate(() => {
    const S = NSO_Stock, soup = S.revolve(S.profileSphere(85, 96), 96);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
    return addModelFromZUpGeometry('Big', g);
  });
  await page.evaluate(i => { const k = state.placed.findIndex(p => p.sourceId === i); if (k < 0) placeModelMovable(state.models.find(m => m.id === i), 0, 0); selectPlaced(state.placed.findIndex(p => p.sourceId === i)); }, bigId);
  await openMold(page);
  await page.waitForFunction(i => window.nsoMold.target() === i, bigId, { timeout: 5000 });
  L = await look(page);
  const bs = L.plan.block;
  check('a piece too big for the plate once the block is added: refused, naming the size', !L.plan.ok && /Too big for the plate/.test(L.readout) && /190\.0 x 190\.0 x 200\.0 mm/.test(L.readout) && /180 x 180/.test(L.readout) && L.btnDisabled, L.readout);
  const r8 = await page.evaluate(() => window.nsoMold.generate());
  check('  ... Generate refuses the same way and makes nothing', r8.ok === false && /Too big/.test(r8.reason) && (await pieces(page)).every(p => !/Big mold/.test(p.name)));
  await page.evaluate(() => document.getElementById('menu-mold').open = false);

  const openId = await loadSTL(page, path.join(ROOT, 'fixtures', 'open', 'open_clip.stl'));
  await page.evaluate(i => { selectPlaced(state.placed.findIndex(p => p.sourceId === i)); }, openId);
  await openMold(page);
  await page.waitForFunction(i => window.nsoMold.target() === i, openId, { timeout: 5000 });
  L = await look(page);
  check('a piece that is not closed: refused in words', !L.plan.ok && /not closed/.test(L.readout) && L.btnDisabled, L.readout);
  const r9 = await page.evaluate(() => window.nsoMold.generate());
  check('  ... Generate makes nothing and says so', r9.ok === false && /not closed/.test(r9.reason) && /refused/.test(await page.evaluate(() => document.getElementById('status').textContent)));

  console.log('\n=== 8. the card is the switch ===');
  await page.evaluate(() => document.getElementById('menu-mold').open = false);
  await page.waitForTimeout(100);
  L = await look(page);
  check('shut the card: Mold is off and every helper is gone', !L.armed && !L.layerVisible && L.names.length === 0, L.names.join(',') || 'no helpers');
  await openMold(page);
  await page.evaluate(() => document.getElementById('menu-gen').open = false);
  await page.waitForTimeout(100);
  L = await look(page);
  check('shut Gen+ with the card open: Mold is off too', !L.armed && L.names.length === 0);
  const errs = logs.filter(l => /^\[pageerror\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\nFAILED  ' + fails + ' gate(s)' : '\nPASSED');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('DRIVE CRASH', e); process.exit(2); });
