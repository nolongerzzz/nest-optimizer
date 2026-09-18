/* Drive check: Thicken in / out through the REAL controls, end to end.
     node tools/nso_thicken_drive_check.js               local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_thicken_drive_check.js

   Same standard as tools/nso_skin_drive_check.js: every step is a click on
   the shipped UI (the Finish menu opened, the mm box filled, the Thicken
   button, Undo), and the file checked is the one the browser downloaded via
   "Download selected STL", through tools/mesh_validate.py. The two checks
   that are NOT clicks (painting a face, reading the raw-soup flag) are named
   as such in their labels.

   What it pins (the two live-test defects of 2026-09-16):
     1. no waffle - the triangle count does not change; a sphere's vertices
        all land on the offset radius; planar faces stay planar
     2. the right side, and only that side, moves - on the open box (2 mm
        walls, open top) Thicken in moves the cavity wall and floor by exactly
        1.5 and leaves the outer bbox untouched; Thicken out grows the outer
        bbox by 1.5 per side and leaves the cavity where it was
   plus: volume matches the analytic figure, watertight before and after,
   0 piercing, a solid with no pocket refuses "in" and pushes no undo, an
   offset bigger than the feature is refused with the piece unchanged, an
   inward-wound STL still thickens outward, and paint stands it down. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const lib = f => path.join(ROOT, 'library', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-thicken-drive-'));

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
function parseSTL(buf) {
  const n = buf.readUInt32LE(80), tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12, t = [];
    for (let k = 0; k < 3; k++) t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    tris.push(t);
  }
  return tris;
}
/* every crossing of an axis-parallel ray through the mesh, as offsets from
   the mesh's minimum on that axis (the export is centred, so absolute
   coordinates mean nothing; wall positions relative to the outside do) */
function crossings(tris, axis, p) {
  const a = axis, b = (axis + 1) % 3, c = (axis + 2) % 3;
  let mn = Infinity; for (const t of tris) for (const v of t) if (v[a] < mn) mn = v[a];
  const hits = [];
  for (const t of tris) {
    const [A, B, C] = t;
    const d1 = (p[0] - B[b]) * (A[c] - B[c]) - (A[b] - B[b]) * (p[1] - B[c]);
    const d2 = (p[0] - C[b]) * (B[c] - C[c]) - (B[b] - C[b]) * (p[1] - C[c]);
    const d3 = (p[0] - A[b]) * (C[c] - A[c]) - (C[b] - A[b]) * (p[1] - A[c]);
    if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (Math.abs(n[a]) < 1e-9) continue;
    hits.push(A[a] - (n[b] * (p[0] - A[b]) + n[c] * (p[1] - A[c])) / n[a] - mn);
  }
  hits.sort((x, y) => x - y);
  const u = []; for (const h of hits) if (!u.length || Math.abs(h - u[u.length - 1]) > 1e-3) u.push(h);
  return u;
}
const sameList = (got, want, tol) => got.length === want.length && got.every((v, i) => near(v, want[i], tol));
const fmt = l => '[' + l.map(v => v.toFixed(4)).join(', ') + ']';
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', euler ' + v.euler_characteristic +
  ', pierce ' + v.self_intersection.pierce + ', vol ' + v.signed_volume.toFixed(2) + ', bbox ' + v.bbox_size.map(x => x.toFixed(3)).join(' x ');

const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);

async function download(page, label) {
  page.once('dialog', d => d.accept());
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-model')]);
  const file = path.join(out, label + '.stl');
  await dl.saveAs(file);
  return { file, v: meshValidate(file), tris: parseSTL(fs.readFileSync(file)) };
}
async function thicken(page, mode, mm) {
  await page.fill('#inp-thicken-mm', String(mm));
  await page.evaluate(() => { document.getElementById('status').textContent = 'wait'; });
  await page.click('#btn-thicken-' + mode);
  await page.waitForFunction(() => document.getElementById('status').textContent !== 'wait', null, { timeout: 120000 });
  return statusOf(page);
}
async function undo(page) { await page.click('#btn-undo'); await page.waitForTimeout(150); }

withApp(async (page, logs) => {
  // the menu, then its groups: Thicken lives in the Shape group now
  await page.evaluate(() => {
    document.querySelector('.vp-finish-menu').open = true;
    document.querySelectorAll('.vp-finish-menu .vp-sec').forEach(d => { d.open = true; });
  });

  console.log('\n=== 1. open box (60x40x25, 2 mm walls, open top): which face moves ===');
  {
    const id = await loadSTL(page, fx('box_open.stl')); await selectModel(page, id);
    check('raw z-up soup is the path taken (not a click)', await page.evaluate(() => !!(getActiveModel().rawTris && getActiveModel().rawAxis === 'zup')));
    const b = await download(page, 'box_open_before');
    check('before: 68 tris, watertight, vol 13632', b.v.triangles === 68 && b.v.open_edges === 0 && b.v.nonmanifold_edges === 0 && near(b.v.signed_volume, 13632, 1e-3), summary(b.v));
    const wallB = crossings(b.tris, 0, [0, 0]), floorB = crossings(b.tris, 2, [0, 0]);
    check('before: wall ray reads outer 0, cavity 2..58, outer 60', sameList(wallB, [0, 2, 58, 60], 1e-4), fmt(wallB));
    check('before: floor ray reads 0..2', sameList(floorB, [0, 2], 1e-4), fmt(floorB));

    const sIn = await thicken(page, 'in', 1.5);
    check('Thicken in 1.5: status names 10 inner faces moved, 58 held', /Thicken in 1.5 - 10 inner face\(s\) moved, 58 held/.test(sIn), sIn);
    const i = await download(page, 'box_open_in');
    check('in: still 68 tris (no re-sampling), 0 open, 0 nm, Euler 2, 0 piercing', i.v.triangles === 68 && i.v.open_edges === 0 && i.v.nonmanifold_edges === 0 && i.v.euler_characteristic === 2 && i.v.self_intersection.pierce === 0, summary(i.v));
    check('in: outer bbox untouched, 60 x 40 x 25 (1e-5)', near(i.v.bbox_size[0], 60, 1e-5) && near(i.v.bbox_size[1], 40, 1e-5) && near(i.v.bbox_size[2], 25, 1e-5), i.v.bbox_size.join(' x '));
    const wallI = crossings(i.tris, 0, [0, 0]), floorI = crossings(i.tris, 2, [0, 0]);
    check('in: cavity walls moved 2 -> 3.5 and 58 -> 56.5, outer faces at 0 and 60 did not move (1e-4)', sameList(wallI, [0, 3.5, 56.5, 60], 1e-4), fmt(wallI));
    check('in: floor top moved 2 -> 3.5, outer bottom did not (1e-4)', sameList(floorI, [0, 3.5], 1e-4), fmt(floorI));
    check('in: volume 60000 - 53*33*21.5 = 22396.5 (1e-3)', near(i.v.signed_volume, 22396.5, 1e-3), i.v.signed_volume.toFixed(4));
    await undo(page);
    const u = await download(page, 'box_open_undo');
    check('Undo: back to 68 tris, vol 13632', u.v.triangles === 68 && near(u.v.signed_volume, 13632, 1e-3), summary(u.v));

    const sOut = await thicken(page, 'out', 1.5);
    check('Thicken out 1.5: status names 58 outer faces moved, 10 held', /Thicken out 1.5 - 58 outer face\(s\) moved, 10 held/.test(sOut), sOut);
    const o = await download(page, 'box_open_out');
    check('out: still 68 tris, watertight, Euler 2, 0 piercing', o.v.triangles === 68 && o.v.open_edges === 0 && o.v.nonmanifold_edges === 0 && o.v.euler_characteristic === 2 && o.v.self_intersection.pierce === 0, summary(o.v));
    check('out: bbox 63 x 43 x 28 - 1.5 on every outer face, rim top included (1e-5)', near(o.v.bbox_size[0], 63, 1e-5) && near(o.v.bbox_size[1], 43, 1e-5) && near(o.v.bbox_size[2], 28, 1e-5), o.v.bbox_size.join(' x '));
    const wallO = crossings(o.tris, 0, [0, 0]), floorO = crossings(o.tris, 2, [0, 0]);
    check('out: wall now 3.5 thick on both sides, cavity 56 wide as before (1e-4)', sameList(wallO, [0, 3.5, 59.5, 63], 1e-4), fmt(wallO));
    check('out: floor 3.5 thick - grew downward, cavity floor held (1e-4)', sameList(floorO, [0, 3.5], 1e-4), fmt(floorO));
    check('out: volume 63*43*28 - 56*36*24.5 = 26460 (1e-3)', near(o.v.signed_volume, 26460, 1e-3), o.v.signed_volume.toFixed(4));
    await undo(page);
  }

  console.log('\n=== 2. solid cube: "in" has nothing to move, "out" is exact ===');
  {
    const id = await loadSTL(page, fx('box-20mm.stl')); await selectModel(page, id);
    const s = await thicken(page, 'in', 1.5);
    check('Thicken in on a solid: refused, says every face is on the outside', /Thicken in 1.5 failed - no inner face/.test(s), s);
    check('  ...and pushed no undo (button still disabled)', !(await page.isEnabled('#btn-undo')));
    const a = await download(page, 'cube_after_in');
    check('  ...piece unchanged: 12 tris, vol 8000', a.v.triangles === 12 && near(a.v.signed_volume, 8000, 1e-6), summary(a.v));
    const s2 = await thicken(page, 'out', 1.5);
    check('Thicken out 1.5: 12 outer faces moved', /12 outer face\(s\) moved, 0 held/.test(s2), s2);
    const o = await download(page, 'cube_out');
    check('out: 23 mm cube, 12 tris, vol 12167, watertight', near(o.v.bbox_size[0], 23, 1e-5) && near(o.v.bbox_size[2], 23, 1e-5) && o.v.triangles === 12 && near(o.v.signed_volume, 12167, 1e-3) && o.v.open_edges === 0, summary(o.v));
    await undo(page);
  }

  console.log('\n=== 3. thin-wall tube (genus 1): bore is inner, skin is outer ===');
  {
    const id = await loadSTL(page, lib('soften_test_03_thinwall_tube.stl')); await selectModel(page, id);
    const b = await download(page, 'tube_before');
    const rb = crossings(b.tris, 0, [0, 0]);
    check('before: 384 tris, Euler 0, ray reads wall 0..4, bore 4..18, wall 18..22', b.v.triangles === 384 && b.v.euler_characteristic === 0 && sameList(rb, [0, 4, 18, 22], 1e-3), fmt(rb));
    const sIn = await thicken(page, 'in', 1.5);
    check('Thicken in 1.5: 96 inner (bore) faces moved, 288 held', /96 inner face\(s\) moved, 288 held/.test(sIn), sIn);
    const i = await download(page, 'tube_in');
    const ri = crossings(i.tris, 0, [0, 0]);
    check('in: bore 5.5..16.5, outside 0 and 22 untouched (3e-3)', sameList(ri, [0, 5.5, 16.5, 22], 3e-3), fmt(ri));
    check('in: 384 tris, watertight, Euler 0, 0 piercing, bbox unchanged', i.v.triangles === 384 && i.v.open_edges === 0 && i.v.nonmanifold_edges === 0 && i.v.euler_characteristic === 0 && i.v.self_intersection.pierce === 0 && near(i.v.bbox_size[0], 22, 1e-5) && near(i.v.bbox_size[2], 25, 1e-5), summary(i.v));
    check('in: volume grew 5638.73 -> 7107.43 (0.05)', near(i.v.signed_volume, 7107.43, 0.05), i.v.signed_volume.toFixed(3));
    await undo(page);
    const sOut = await thicken(page, 'out', 1.5);
    check('Thicken out 1.5: 288 outer faces moved, 96 held', /288 outer face\(s\) moved, 96 held/.test(sOut), sOut);
    const o = await download(page, 'tube_out');
    const ro = crossings(o.tris, 0, [0, 0]);
    check('out: outside grew 1.5 per side, bore still 14 wide (3e-3)', sameList(ro, [0, 5.5, 19.5, 25], 3e-3), fmt(ro));
    check('out: 28 tall (ends grew 1.5 each), watertight, 0 piercing', near(o.v.bbox_size[2], 28, 1e-5) && o.v.open_edges === 0 && o.v.self_intersection.pierce === 0 && o.v.triangles === 384, summary(o.v));
    await undo(page);
  }

  console.log('\n=== 4. tessellated sphere: smooth offset, every vertex on the new radius ===');
  {
    const id = await loadSTL(page, fx('fixture_sphere_curved.stl')); await selectModel(page, id);
    const b = await download(page, 'sphere_before');
    const s = await thicken(page, 'out', 1.5);
    check('Thicken out 1.5: all 2208 faces moved', /2208 outer face\(s\) moved, 0 held/.test(s), s);
    const o = await download(page, 'sphere_out');
    check('out: 2208 tris (no waffle), watertight, Euler 2, 0 piercing, bbox 23', o.v.triangles === 2208 && o.v.open_edges === 0 && o.v.euler_characteristic === 2 && o.v.self_intersection.pierce === 0 && near(o.v.bbox_size[0], 23, 1e-4), summary(o.v));
    const centre = [0, 1, 2].map(k => { let mn = Infinity, mx = -Infinity; for (const t of o.tris) for (const v of t) { if (v[k] < mn) mn = v[k]; if (v[k] > mx) mx = v[k]; } return (mn + mx) / 2; });
    let worst = 0;
    for (const t of o.tris) for (const v of t) { const r = Math.hypot(v[0] - centre[0], v[1] - centre[1], v[2] - centre[2]); worst = Math.max(worst, Math.abs(r - 11.5)); }
    check('out: every vertex within 0.02 of radius 11.5 (was 10)', worst < 0.02, 'worst ' + worst.toFixed(4));
    check('out: volume ratio (11.5/10)^3 = 1.520875 (1e-3)', near(o.v.signed_volume / b.v.signed_volume, 1.520875, 1e-3), (o.v.signed_volume / b.v.signed_volume).toFixed(5));
    await undo(page);
  }

  console.log('\n=== 5. inward-wound STL (library/USB_bit.stl, negative signed volume) ===');
  {
    const id = await loadSTL(page, lib('USB_bit.stl')); await selectModel(page, id);
    const b = await download(page, 'usb_before');
    check('before: signed volume is negative (wound inward), 12 tris', b.v.signed_volume < 0 && b.v.triangles === 12, b.v.signed_volume.toFixed(3));
    const s = await thicken(page, 'out', 1.5);
    check('Thicken out 1.5: 12 outer faces moved', /12 outer face\(s\) moved/.test(s), s);
    const o = await download(page, 'usb_out');
    check('out: grew 3.0 on every axis - outward despite the winding (1e-4)', [0, 1, 2].every(k => near(o.v.bbox_size[k] - b.v.bbox_size[k], 3, 1e-4)), o.v.bbox_size.join(' x '));
    check('out: winding kept as it came (still negative), |vol| = product of the grown sides (1e-2)', o.v.signed_volume < 0 && near(-o.v.signed_volume, o.v.bbox_size[0] * o.v.bbox_size[1] * o.v.bbox_size[2], 1e-2), o.v.signed_volume.toFixed(3));
    await undo(page);
  }

  console.log('\n=== 6. hinge knuckle box (real boolean union, genus 3): refusal, then a fitting offset ===');
  {
    const id = await loadSTL(page, fx('hinge_knuckle_box.stl')); await selectModel(page, id);
    const s = await thicken(page, 'in', 1.5);
    check('Thicken in 1.5: refused - bigger than the knuckle gaps', /would turn inside out\); piece unchanged/.test(s), s);
    check('  ...no undo pushed', !(await page.isEnabled('#btn-undo')));
    const a = await download(page, 'hinge_after_refusal');
    check('  ...piece unchanged: 730 tris, vol 636.10', a.v.triangles === 730 && near(a.v.signed_volume, 636.0955, 1e-3), summary(a.v));
    const s2 = await thicken(page, 'in', 0.3);
    check('Thicken in 0.3: 430 inner faces moved, 300 held', /430 inner face\(s\) moved, 300 held/.test(s2), s2);
    const i = await download(page, 'hinge_in');
    check('in 0.3: 730 tris, 0 open, 0 nm, Euler -4 kept, 0 piercing, bbox unchanged', i.v.triangles === 730 && i.v.open_edges === 0 && i.v.nonmanifold_edges === 0 && i.v.euler_characteristic === -4 && i.v.self_intersection.pierce === 0 && near(i.v.bbox_size[0], 18, 1e-5), summary(i.v));
    check('in 0.3: volume 636.10 -> 725.20 (0.05)', near(i.v.signed_volume, 725.20, 0.05), i.v.signed_volume.toFixed(3));
    await undo(page);
    const s3 = await thicken(page, 'out', 0.3);
    check('Thicken out 0.3: 300 outer faces moved, 430 held', /300 outer face\(s\) moved, 430 held/.test(s3), s3);
    const o = await download(page, 'hinge_out');
    // 5e-4: the knuckle is a tessellated cylinder, so its extreme vertex moves
    // along the averaged normal of its facets (0.3 * cos of half a facet)
    check('out 0.3: bbox 18.6 x 8.6 x 8.6 (5e-4), watertight, Euler -4, 0 piercing', near(o.v.bbox_size[0], 18.6, 5e-4) && near(o.v.bbox_size[1], 8.6, 5e-4) && near(o.v.bbox_size[2], 8.6, 5e-4) && o.v.open_edges === 0 && o.v.euler_characteristic === -4 && o.v.self_intersection.pierce === 0, summary(o.v));
    await undo(page);
  }

  console.log('\n=== 7. paint stands it down (whole-piece), and a dirty real mesh is refused, not damaged ===');
  {
    const id = await loadSTL(page, fx('box_open.stl')); await selectModel(page, id);
    await page.evaluate(() => nsoMaskRestore(getActiveModel(), [{ n: [0, 0, 1], d: 25 }]));
    const s = await thicken(page, 'in', 1.5);
    check('one painted face (set through nsoMaskRestore, not a click): Thicken stood down', /Thicken stood down - 1 painted face\(s\)/.test(s), s);
    check('  ...no undo pushed', !(await page.isEnabled('#btn-undo')));
    await page.evaluate(() => nsoMaskRestore(getActiveModel(), []));
    const s2 = await thicken(page, 'in', 1.5);
    check('paint cleared: Thicken in runs again', /10 inner face\(s\) moved/.test(s2), s2);
    await undo(page);

    const tid = await loadSTL(page, fx('tape_on-edge-single-B101_rounded_v8_FINAL.stl')); await selectModel(page, tid);
    const b = await download(page, 'tape_before');
    check('tape before: 32862 tris, 2 nm edges, piercing pairs already present', b.v.triangles === 32862 && b.v.nonmanifold_edges === 2 && b.v.self_intersection.pierce > 0, summary(b.v));
    const s3 = await thicken(page, 'out', 0.3);
    check('tape Thicken out 0.3: refused by the piercing gate (count may not rise), piece unchanged', /piercing pairs \d+→\d+\); piece unchanged/.test(s3), s3);
    const s4 = await thicken(page, 'in', 0.3);
    check('tape Thicken in 0.3: no pocket with a sharp rim - refused, unchanged', /no inner face/.test(s4), s4);
    const a = await download(page, 'tape_after');
    check('  ...download identical in count and volume to before', a.v.triangles === b.v.triangles && near(a.v.signed_volume, b.v.signed_volume, 1e-6), summary(a.v));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles in ' + out);
  console.log(fails ? '\nTHICKEN DRIVE: ' + fails + ' FAILED' : '\nTHICKEN DRIVE: all checks passed');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('THICKEN DRIVE FAIL', e); process.exit(1); });
