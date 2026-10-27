#!/usr/bin/env node
/* THE PAINT BRUSH and THE RAFT SWITCH of the Supports card (docs/SUPPORT-FOOTPRINT.md section 10).
     node tools/nso_support_paint_test.js
     npm run support:paint

   A stroke over the piece asks for supports where it goes: tips right under it, and the raft laid to the brush's edge. Checked on the Negative Sphere at
   the card's 30 deg: the surface the card's own build leaves bare (its rim's slivers, read the way support:coverage reads them) is painted over, the
   piece is built again, and the same points are read - more of them held, none with support nearer than the gap (the build does not cross the line),
   and the stroke is one Undo. The raft switch: off, the build is the sheet from the tips alone (fewer lines on the Circular's dome). */
'use strict';
const path = require('path');
const lib = require('./nso_support_plate_lib.js');
const SB = require('../nso_support_beacons.js');

const FIXTURE = path.join(lib.ROOT, 'fixtures', 'supports', 'supp_ref.3mf');
const ANGLE = 30, STEP = 0.5, UNDER_MIN = 0.02, UNDER_MAX = 1.5, GAP = 0.18;
let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : '')); };

function inLoops(loops, x, y) {
  let inn = false;
  for (const L of loops) for (let q = 0, w = L.length - 1; q < L.length; w = q++)
    if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
  return inn;
}
function hitsAt(soup, x, y) {
  const out = [];
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i], ay = soup[i + 1], bx = soup[i + 3], by = soup[i + 4], cx = soup[i + 6], cy = soup[i + 7];
    if (x < Math.min(ax, bx, cx) || x > Math.max(ax, bx, cx) || y < Math.min(ay, by, cy) || y > Math.max(ay, by, cy)) continue;
    const den = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / den, v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / den;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    out.push(soup[i + 2] + u * (soup[i + 5] - soup[i + 2]) + v * (soup[i + 8] - soup[i + 2]));
  }
  return out;
}
/* the footprint's samples (every 0.5 mm, with the surface's height over each) the card's build leaves bare, and the ones it holds */
function samplesOf(body, support) {
  const det = SB.detect(body, { pitch: 3, angleDeg: ANGLE, skipList: [], footprint: true, seedPitchMm: SB.SEED_PITCH_PRODUCT_MM || 1, insetMm: SB.INSET_PRODUCT_MM || 1 });
  const out = [];
  det.regions.forEach(R => {
    if (!R.footprint || !R.beacons || !R.beacons.length) return;
    const loops = R.footprint.loops, xs = [], ys = [];
    loops.forEach(L => L.forEach(q => { xs.push(q[0]); ys.push(q[1]); }));
    const zLow = Math.min(...R.beacons.map(b => b.z));
    for (let x = Math.min(...xs) + STEP / 2; x < Math.max(...xs); x += STEP) for (let y = Math.min(...ys) + STEP / 2; y < Math.max(...ys); y += STEP) {
      if (!inLoops(loops, x, y)) continue;
      const up = hitsAt(body, x, y).filter(z => z > zLow - 0.6 && z < zLow + 3).sort((a, b) => a - b);
      if (!up.length) continue;
      out.push({ x, y, z: up[0], held: support ? hitsAt(support, x, y).some(z => z < up[0] - UNDER_MIN && z > up[0] - UNDER_MAX) : null });
    }
  });
  return out;
}
const heldAt = (support, pts) => pts.filter(p => hitsAt(support, p.x, p.y).some(z => z < p.z - UNDER_MIN && z > p.z - UNDER_MAX)).length;
const crossing = (support, pts) => pts.filter(p => hitsAt(support, p.x, p.y).some(z => z > p.z - (GAP - 0.03) && z < p.z + 0.01)).length;
const supportOf = (app, id) => Float32Array.from([].concat(...app.supportsOf(id).map(m => Array.from(app.soupOf(m.id)))));

(async () => {
  const objs = await lib.readFixture(FIXTURE);
  const o = objs.find(x => x.name === 'Support Negative Sphere.stl');
  const app = lib.makeApp();
  const ids = app.load([o]);
  app.openCard();
  app.card.angle(ANGLE);
  app.card.pick(ids[0]);
  const body = Float32Array.from(app.soupOf(ids[0]));

  console.log('\n=== 1. the card\'s own build, then the bare surface painted over ===');
  const g0 = await app.card.generate();
  check('built', g0.ok, app.head());
  const sup0 = supportOf(app, ids[0]);
  const all0 = samplesOf(body, sup0), bare = all0.filter(s => !s.held);
  console.log('        ' + all0.length + ' samples of the footprint, ' + bare.length + ' bare (' + (100 * (all0.length - bare.length) / all0.length).toFixed(0) + ' % held)');
  check('there is bare surface to paint', bare.length >= 20, String(bare.length));
  check('no paint yet', app.card.paintCount() === 0);

  /* the brush: strokes through the bare samples, row by row; a face the card was asked to hold looks down */
  const rows = {};
  bare.forEach(s => { const k = Math.round(s.y / 1.0); (rows[k] = rows[k] || []).push(s); });
  const strokes = Object.keys(rows).map(k => rows[k].sort((a, b) => a.x - b.x));
  let ok = true, last = null;
  for (const st of strokes) { last = app.card.paintStroke(st.map(s => ({ p: [s.x, s.y, s.z], n: [0, 0, -1] })), 0.8); ok = ok && last.ok; }
  check('every stroke is taken (' + strokes.length + ' strokes)', ok && app.card.paintCount() === strokes.length, app.card.paintCount() + ' counted');
  check('each stroke is one Undo step', app.state.undoStack.length >= strokes.length, String(app.state.undoStack.length));

  console.log('\n=== 2. built again, the same points read ===');
  const g1 = await app.card.generate();
  check('built with the paint', g1.ok, app.head());
  const sup1 = supportOf(app, ids[0]);
  const h0 = heldAt(sup0, bare), h1 = heldAt(sup1, bare);
  console.log('        of the ' + bare.length + ' bare points: held ' + h0 + ' before, ' + h1 + ' after');
  check('the painted points are held: 40 % or more of them (none before)', h1 >= 0.4 * bare.length && h0 === 0, (100 * h1 / bare.length).toFixed(0) + ' %');
  const all1 = samplesOf(body, sup1);
  check('the footprint as a whole holds more than it did', all1.filter(s => s.held).length > all0.filter(s => s.held).length - 1 && all1.filter(s => s.held).length >= all0.filter(s => s.held).length + 0.2 * bare.length,
    all0.filter(s => s.held).length + ' -> ' + all1.filter(s => s.held).length + ' of ' + all1.length);
  check('the raft does not cross the line: no support face within the gap of the surface at any painted point', crossing(sup1, bare) === 0, crossing(sup1, bare) + ' crossing');

  console.log('\n=== 3. Undo, Clear ===');
  const undoN = app.state.undoStack.length;
  const c = app.card.clearPaint();
  check('Clear paint takes every stroke off, one Undo step', c.ok && app.card.paintCount() === 0 && app.state.undoStack.length === undoN + 1);
  app.state.undoStack[app.state.undoStack.length - 1].onUndone && app.state.undoStack[app.state.undoStack.length - 1].onUndone();
  check('...and Undo puts them back', app.card.paintCount() === strokes.length, String(app.card.paintCount()));
  check('the brush itself: off until asked, on when asked, off when asked again', app.card.paint() === false && app.card.paint(true).on === true && app.card.paint() === true && app.card.paint(false).on === false);

  console.log('\n=== 4. the raft switch ===');
  const objs2 = await lib.readFixture(FIXTURE);
  const circ = objs2.find(x => x.name === 'Support Circular.stl');
  async function trianglesWith(raftOn) {
    const a = lib.makeApp();
    const idc = a.load([circ]);
    a.openCard();
    a.card.pick(idc[0]);
    a.el('sup-raft').checked = raftOn;
    const r = await a.card.generate();
    return { ok: r.ok, tris: supportOf(a, idc[0]).length / 9, held: samplesOf(Float32Array.from(a.soupOf(idc[0])), supportOf(a, idc[0])) };
  }
  const on = await trianglesWith(true), off = await trianglesWith(false);
  const share = (r) => 100 * r.held.filter(s => s.held).length / Math.max(1, r.held.length);
  console.log('        Circular: raft on ' + on.tris + ' triangles, ' + share(on).toFixed(0) + ' % held; off ' + off.tris + ' triangles, ' + share(off).toFixed(0) + ' % held');
  check('both build', on.ok && off.ok);
  check('the raft holds more of the dome than the sheet from the tips alone (10 points or more)', share(on) >= share(off) + 10, share(on).toFixed(0) + ' against ' + share(off).toFixed(0));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
