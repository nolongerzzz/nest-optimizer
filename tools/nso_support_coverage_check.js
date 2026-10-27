#!/usr/bin/env node
/* SUPPORT COVERAGE: how much of each contact surface has support right under it, on the plate as the card builds it.
     node tools/nso_support_coverage_check.js             the six reference heads, aligned and turned
     node tools/nso_support_coverage_check.js --yaws=20,35,12,28,40,8     the heads turned about z by these (deg), in the fixture's order
     npm run support:coverage

   The question the sheet's own gates do not ask: wherever the part's underside needs holding (nso_support_beacons.js, the card's 35 deg, with its
   footprints and the finer look), is there support just below it - a face of the stack within 1.5 mm under the surface, straight down? The
   footprint is sampled every 0.5 mm; a sample is HELD when a support triangle lies under it between 0.02 and 1.5 mm; the share is the card's
   result for the piece, not what Bambu laid (docs/SUPPORT-FOOTPRINT.md section 2 has that). It is the number to watch while the tips and the
   branches change: a sheet that hangs over the air, or a surface no tip stands under, is a share that does not rise.

   Built the way the card builds a plate (tools/nso_support_plate_lib.js: the card's own file in a vm), so the occluders of the other pieces are
   in the build: the same head costs more on a plate than alone. The seconds are printed with it (support:plate's gate 1 is the same build).

   Gates are floors for what the build holds today (the card lays the region plate, docs/SUPPORT-FOOTPRINT.md section 9: the interface and the
   transition from each footprint and the surface's height, so the share does not depend on how the piece is turned): the Base, the Circular, the
   Sphere and the Negative Spheres, aligned and turned, and that turning moves none of them by more than 15 points; the Oblique where its stair
   stands, and a ceiling on the plate's seconds. The one FINDING left is the Oblique turned off the two angles its stair stands at (0 and 75 deg:
   the stair's lines follow the sheet's line angles); it is the stair's, not the region plate's, and is reported and not held. */
'use strict';
const path = require('path');
const lib = require('./nso_support_plate_lib.js');
const SB = require('../nso_support_beacons.js');

const ROOT = lib.ROOT;
const FIXTURE = path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf');
const args = process.argv.slice(2);
const yawArg = args.find(a => a.startsWith('--yaws='));
const TURNED = (yawArg ? yawArg.slice(7) : '20,35,12,28,40,8').split(',').map(Number);
const ANGLE = 35;                    // the card's default
const STEP = 0.5, UNDER_MIN = 0.02, UNDER_MAX = 1.5;

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};
const finding = (name, detail) => console.log('  FINDING ' + name + (detail ? '   ' + detail : ''));

function inLoops(loops, x, y) {
  let inn = false;
  for (const L of loops) for (let q = 0, w = L.length - 1; q < L.length; w = q++)
    if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
  return inn;
}
/* the z of every face a vertical line at (x, y) crosses */
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
const turn = (positions, deg) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  let cx = 0, cy = 0, n = 0;
  for (let k = 0; k < positions.length; k += 3) { cx += positions[k]; cy += positions[k + 1]; n++; }
  cx /= n; cy /= n;
  const out = new Float32Array(positions.length);
  for (let k = 0; k < positions.length; k += 3) {
    const x = positions[k] - cx, y = positions[k + 1] - cy;
    out[k] = cx + x * c - y * s; out[k + 1] = cy + x * s + y * c; out[k + 2] = positions[k + 2];
  }
  return out;
};
/* the share of the piece's footprint with support just under it */
function share(body, support) {
  const det = SB.detect(body, { pitch: 3, angleDeg: ANGLE, skipList: [], footprint: true, seedPitchMm: SB.SEED_PITCH_PRODUCT_MM || 1, insetMm: SB.INSET_PRODUCT_MM || 1 });
  let total = 0, held = 0;
  det.regions.forEach(R => {
    if (!R.footprint || !R.beacons || !R.beacons.length) return;
    const loops = R.footprint.loops, xs = [], ys = [];
    loops.forEach(L => L.forEach(q => { xs.push(q[0]); ys.push(q[1]); }));
    const zLow = Math.min(...R.beacons.map(b => b.z));
    for (let x = Math.min(...xs) + STEP / 2; x < Math.max(...xs); x += STEP) for (let y = Math.min(...ys) + STEP / 2; y < Math.max(...ys); y += STEP) {
      if (!inLoops(loops, x, y)) continue;
      const up = hitsAt(body, x, y).filter(z => z > zLow - 0.6 && z < zLow + 3).sort((a, b) => a - b);
      if (!up.length) continue;
      total++;
      if (hitsAt(support, x, y).some(z => z < up[0] - UNDER_MIN && z > up[0] - UNDER_MAX)) held++;
    }
  });
  return { total, held, pct: total ? 100 * held / total : 0, mm2: total * STEP * STEP };
}

async function plate(objs, yaws) {
  const parts = objs.map((o, i) => yaws ? Object.assign({}, o, { positions: turn(o.positions, yaws[i % yaws.length]) }) : o);
  const app = lib.makeApp();
  const ids = app.load(parts);
  app.openCard();
  app.setPlateBox(true);
  const t0 = Date.now();
  app.click('btn-sup-all');
  await app.until(() => app.card.busy());
  await app.until(() => !app.card.busy());
  const secs = (Date.now() - t0) / 1000;
  const rows = {};
  ids.forEach((id, i) => {
    const sup = [].concat(...app.supportsOf(id).map(m => Array.from(app.soupOf(m.id))));
    rows[objs[i].name.replace(/^Support |\.stl$/g, '')] = share(Float32Array.from(app.soupOf(id)), Float32Array.from(sup));
  });
  return { secs, head: app.head(), rows };
}

(async () => {
  const objs = await lib.readFixture(FIXTURE);
  console.log('\n=== 1. the six heads on the plate, aligned as the fixture lays them ===');
  const a = await plate(objs, null);
  console.log('        ' + a.head + '   (' + a.secs.toFixed(1) + ' s)');
  for (const k of Object.keys(a.rows)) console.log('        ' + k.padEnd(18) + 'held ' + a.rows[k].pct.toFixed(0).padStart(3) + ' %   of ' + a.rows[k].mm2.toFixed(0) + ' mm2 of footprint');
  check('the Base: 80 % or more of its footprint has support under it', a.rows.Base.pct >= 80, a.rows.Base.pct.toFixed(0) + ' %');
  check('the Oblique (its stair stands at this angle): 85 % or more', a.rows.Oblique.pct >= 85, a.rows.Oblique.pct.toFixed(0) + ' %');
  const FLOOR_ALIGNED = { Circular: 80, Sphere: 90, 'Negative Sphere': 60, 'Negative Sphere2': 62 };
  for (const k of Object.keys(FLOOR_ALIGNED)) check('the ' + k + ' (the region plate): ' + FLOOR_ALIGNED[k] + ' % or more', a.rows[k].pct >= FLOOR_ALIGNED[k], a.rows[k].pct.toFixed(0) + ' %');
  check('the plate built in 45 s or less (this box 15; the runner is about 1.7 times slower; the plate was 36 s before the region plate)', a.secs <= 45, a.secs.toFixed(1) + ' s');

  console.log('\n=== 2. the same plate, the heads turned about z by ' + TURNED.join(', ') + ' deg ===');
  const b = await plate(objs, TURNED);
  console.log('        ' + b.head + '   (' + b.secs.toFixed(1) + ' s)');
  for (const k of Object.keys(b.rows)) console.log('        ' + k.padEnd(18) + 'held ' + b.rows[k].pct.toFixed(0).padStart(3) + ' %   (aligned ' + a.rows[k].pct.toFixed(0) + ' %)');
  check('the Base, turned: 80 % or more', b.rows.Base.pct >= 80, b.rows.Base.pct.toFixed(0) + ' %');
  const FLOOR_TURNED = { Circular: 70, Sphere: 90, 'Negative Sphere': 55, 'Negative Sphere2': 60 };
  for (const k of Object.keys(FLOOR_TURNED)) check('the ' + k + ', turned: ' + FLOOR_TURNED[k] + ' % or more', b.rows[k].pct >= FLOOR_TURNED[k], b.rows[k].pct.toFixed(0) + ' %');
  check('turning moves no head but the Oblique by more than 15 points (the region plate follows the surface, not the lines\' angle)',
    ['Base', 'Circular', 'Sphere', 'Negative Sphere', 'Negative Sphere2'].every(k => Math.abs(b.rows[k].pct - a.rows[k].pct) <= 15),
    ['Base', 'Circular', 'Sphere', 'Negative Sphere', 'Negative Sphere2'].map(k => k + ' ' + (b.rows[k].pct - a.rows[k].pct).toFixed(0)).join(', '));
  check('the turned plate built in 60 s or less', b.secs <= 60, b.secs.toFixed(1) + ' s');
  finding('the Oblique, turned (its stair stands at 0 and 75 deg only)', 'Oblique ' + b.rows.Oblique.pct.toFixed(0) + ' %');
  finding('the turned plate against the aligned one', b.secs.toFixed(1) + ' s against ' + a.secs.toFixed(1) + ' s');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
