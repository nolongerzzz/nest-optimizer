/* Drive check: Thicken in / out through the REAL controls, end to end.
     node tools/nso_thicken_drive_check.js               local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_thicken_drive_check.js

   Same standard as tools/nso_skin_drive_check.js: every step is a click on
   the shipped UI (the Add menu's Thicken out / Thicken in arming a live ghost,
   the slider, Set, Cancel, a click on a face of the piece, Undo), and the file
   checked is the one the browser downloaded via "Download selected STL",
   through tools/mesh_validate.py. The checks that are NOT clicks (painting a
   face, reading the raw-soup flag, reading what the ghost holds) are named as
   such in their labels.

   Sections 1-7 are the engine's own pins (the two live-test defects of
   2026-09-16), now reached THROUGH the live control - a bake is Set after the
   ghost, a refusal is the readout under the slider with Set greyed:
     1. no waffle - the triangle count does not change; a sphere's vertices
        all land on the offset radius; planar faces stay planar
     2. the right side, and only that side, moves - on the open box (2 mm
        walls, open top) Thicken in moves the cavity wall and floor by exactly
        1.5 and leaves the outer bbox untouched; Thicken out grows the outer
        bbox by 1.5 per side and leaves the cavity where it was
   plus: volume matches the analytic figure, watertight before and after,
   0 piercing, a solid with no pocket refuses "in" and pushes no undo, an
   offset bigger than the feature is refused with the piece unchanged, an
   inward-wound STL still thickens outward, and paint stands it down.

   Sections 8-12 are the live control itself (docs/handoff/thicken-live.md):
     8.  the slider's ghost tracks the value - what the ghost holds is what
         _thickenOffsetSoup returns at that number, and the piece is untouched
     9.  Set bakes exactly the ghost - the piece's triangles are the ghost's,
         bit for bit; one Undo
     10. Cancel (and Escape, and the button again) leaves the piece alone
     11. per-face - a click on a wall thickens that wall only, outer and inner;
         a wall on the wrong side for the verb is refused in words
     12. Hollow's number box takes a click and a typed number, and Hollow runs
         on it */

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
  // btn-export-model moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('btn-export-model'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-model')]);
  const file = path.join(out, label + '.stl');
  await dl.saveAs(file);
  return { file, v: meshValidate(file), tris: parseSTL(fs.readFileSync(file)) };
}
const setMm = (page, v) => page.evaluate(v => {
  const s = document.getElementById('inp-thicken-mm');
  s.value = String(v);
  s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
}, v);
const live = page => page.evaluate(() => nsoThickenLive.info());
const liveOn = page => page.evaluate(() => nsoThickenLive.on());
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const rawOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris));
/* A slider position as the user's keys give it: Home, then the arrows. Every
   press is a real keyboard event, so every one fires the slider's own input
   and change. */
async function slideTo(page, mm) {
  await page.focus('#inp-thicken-mm');
  await page.keyboard.press('Home');
  const min = await page.evaluate(() => +document.getElementById('inp-thicken-mm').min);
  const n = Math.round((mm - min) / 0.1);
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight');
  return page.evaluate(() => +document.getElementById('inp-thicken-mm').value);
}
/* Thicken through the live control: the button arms, the slider is set to mm,
   Set bakes. A refusal is the readout (the ghost is up, Set is greyed) and is
   returned in place of a status line; the control is left armed, so the next
   call puts it away first. Programmatic slider moves fire input and change like
   a user's would; section 8 is where the slider is driven by key and mouse. */
async function thicken(page, mode, mm) {
  if (await liveOn(page)) await page.click('#btn-thicken-cancel');
  await setMm(page, mm);
  await page.click('#btn-thicken-' + mode);
  if (!(await liveOn(page))) return statusOf(page);          // stood down at arm time (paint)
  const i = await live(page);
  if (!i.ok || i.gateWhy) {
    check('  ...Set is greyed while the ghost is refused', await page.isDisabled('#btn-thicken-set'));
    return i.readout;
  }
  await page.click('#btn-thicken-set');
  await page.waitForFunction(() => !nsoThickenLive.on(), null, { timeout: 120000 });
  return statusOf(page);
}
async function undo(page) { await page.click('#btn-undo'); await page.waitForTimeout(150); }

withApp(async (page, logs) => {
  // Thicken lives in the column's Add menu (shell v3): open it.
  await page.evaluate(() => { document.getElementById('menu-add').open = true; });

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
    check('Thicken in on a solid: the ghost is refused, the readout says every face is on the outside', /Thicken in 1.5 mm refused - no inner face/.test(s), s);
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
    check('Thicken in 1.5: refused - bigger than the knuckle gaps', /Thicken in 1.5 mm refused - 1.5 mm is more than the feature it grows into \(\d+ face\(s\) would turn inside out\)/.test(s), s);
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
    check('tape Thicken out 0.3: refused by the piercing gate (count may not rise), piece unchanged', /refused - the moved faces would cross the piece \(piercing pairs \d+→\d+\)/.test(s3), s3);
    const s4 = await thicken(page, 'in', 0.3);
    check('tape Thicken in 0.3: no pocket with a sharp rim - refused, unchanged', /refused - no inner face/.test(s4), s4);
    const a = await download(page, 'tape_after');
    check('  ...download identical in count and volume to before', a.v.triangles === b.v.triangles && near(a.v.signed_volume, b.v.signed_volume, 1e-6), summary(a.v));
  }

  /* ---------------------------------------------------------------------
     The live control. The page is at the harness's default size; the Add
     card is open at the left, so the piece is framed to the right of it. */
  const frameOn = (from) => page => page.evaluate(f => {
    const m = getActiveModel(), ms = cutMeshOf(m);
    ms.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(ms), c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length();
    state.controls.target.copy(c);
    state.camera.position.set(c.x + f[0] * r, c.y + f[1] * r, c.z + f[2] * r);
    state.camera.lookAt(c); state.controls.update(); state.camera.updateMatrixWorld(true);
    // slide the piece out from under the card: pan the view left so the piece sits right of it
    const d = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0).multiplyScalar(-r * 0.35);
    state.controls.target.add(d); state.camera.position.add(d); state.controls.update(); state.camera.updateMatrixWorld(true);
  }, from);
  const frameCorner = frameOn([0.9, 0.7, 1.1]);        // from +x, above, and the front: sees the +x wall
  const frameAbove = frameOn([0.05, 1.6, 0.35]);       // from straight above: sees the cavity floor
  /* the screen point of a raw point on the active piece, through its mesh */
  const screenOfRaw = (page, p) => page.evaluate(pt => {
    const m = getActiveModel(), ms = cutMeshOf(m), f = nsoRawFrameOf(m);
    const q = nsoLocalPointFromRaw(f, pt);
    ms.updateMatrixWorld(true);
    const v = new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(ms.matrixWorld).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, p);
  const realClick = async (page, at) => {
    await page.mouse.move(at.x - 4, at.y - 4); await page.mouse.move(at.x, at.y);
    await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(150);
  };
  const rawBox = page => page.evaluate(() => {
    const r = getActiveModel().rawTris, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < r.length; i += 3) for (let k = 0; k < 3; k++) { if (r[i + k] < lo[k]) lo[k] = r[i + k]; if (r[i + k] > hi[k]) hi[k] = r[i + k]; }
    return { lo, hi, size: [0, 1, 2].map(k => hi[k] - lo[k]) };
  });
  const rawVolume = page => page.evaluate(() => _thickenSignedVolume(getActiveModel().rawTris));
  const ghostState = page => page.evaluate(() => {
    const m = getActiveModel(), ms = cutMeshOf(m), mt = ms.material, o = nsoThickenLive.objects();
    return { opacity: mt.opacity, transparent: mt.transparent, depthWrite: mt.depthWrite, ghosted: !!ms.userData.skipXray,
             helpers: nsoHelpers.live().filter(h => nsoHelpers.ownerOf(h) === 'thicken').length, group: !!o.group, panelHidden: document.getElementById('thicken-panel').hidden,
             outOn: document.getElementById('btn-thicken-out').getAttribute('aria-pressed'), inOn: document.getElementById('btn-thicken-in').getAttribute('aria-pressed') };
  });
  /* what _thickenOffsetSoup (the engine, untouched) returns at this number on the piece as it is */
  const engineAt = (page, mode, mm) => page.evaluate(([md, v]) => Array.from(_thickenOffsetSoup(getActiveModel().rawTris, md, v).soup), [mode, mm]);
  const sameFloats = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const movedBox = page => page.evaluate(() => {
    const g = nsoThickenLive.objects().moved.geometry; g.computeBoundingBox();
    const sz = new THREE.Vector3(); g.boundingBox.getSize(sz); return [sz.x, sz.y, sz.z];
  });

  console.log('\n=== 8. the slider\'s ghost tracks the value (box_open, Thicken out) ===');
  {
    await page.click('#btn-clear-plate');                 // the box alone on the plate: a click on a wall is nobody else's
    const id = await loadSTL(page, fx('box_open.stl')); await selectModel(page, id);
    await frameCorner(page);
    const before = await rawOf(page);
    await page.evaluate(() => { window.__thickenRef = getActiveModel().rawTris; });
    await setMm(page, 1.5);
    await page.click('#btn-thicken-out');
    const a = await ghostState(page);
    check('the button arms it: panel open, Thicken out lit, the piece a ghost (opacity 0.2), one helper in the scene', !a.panelHidden && a.outOn === 'true' && a.inOn === 'false' && a.opacity === 0.2 && a.transparent && a.group && a.helpers === 1, JSON.stringify(a));
    check('the slider\'s own readout (the old number box) says 1.5, the slider\'s number', (await page.textContent('#thicken-read')) === '1.5' && (await page.inputValue('#inp-thicken-mm')) === '1.5');
    for (const v of [0.5, 1.5, 3]) {
      const got = await slideTo(page, v);
      const i = await live(page);
      const eng = await engineAt(page, 'out', got);
      check('slider at ' + v + ' (keys): the ghost IS what the engine returns at ' + got + ' (bit for bit, ' + eng.length + ' floats)', got === v && sameFloats(i.soup && Array.from(i.soup), eng));
      const sz = await movedBox(page);
      check('  ...the ghost\'s wall stands ' + v + ' mm out on every side: outer extent 60 + 2*' + v + ' x 40 + 2*' + v + ' (1e-3)', near(sz[0], 60 + 2 * v, 1e-3) && near(sz[2], 40 + 2 * v, 1e-3), sz.map(x => x.toFixed(3)).join(' x '));
      check('  ...readout box says ' + v + ', words say 58 outer faces move', (await page.textContent('#thicken-read')) === String(v) && /^Thicken out [\d.]+ mm - 58 outer face\(s\) move, 10 held \(whole piece\)$/.test(i.readout), i.readout);
    }
    // the track, with a real mouse: wherever it lands, the ghost is what the engine says at that value
    const box = await page.locator('#inp-thicken-mm').boundingBox();
    await page.mouse.click(box.x + box.width * 0.62, box.y + box.height / 2);
    const mv = await page.evaluate(() => +document.getElementById('inp-thicken-mm').value);
    const mi = await live(page), me = await engineAt(page, 'out', mv);
    check('a click on the track (' + mv + '): the ghost follows it', mv > 3 && mv < 8 && sameFloats(mi.soup && Array.from(mi.soup), me), mv);
    // the arrows on the Thicken row step the same slider
    await page.click('.thick-arrow[data-thick-step="-1"]');
    const av = await page.evaluate(() => +document.getElementById('inp-thicken-mm').value);
    const ai = await live(page);
    check('the row\'s arrow steps the slider one 0.1 and the ghost follows', near(av, mv - 0.1, 1e-9) && near(ai.mm, av, 1e-9), mv + ' -> ' + av);
    check('the piece is untouched all the while: same triangles object, no Undo step', await page.evaluate(() => getActiveModel().rawTris === window.__thickenRef) && sameFloats(await rawOf(page), before) && (await undoDepth(page)) === 0);
    await page.click('#btn-thicken-cancel');
  }

  console.log('\n=== 9. Set bakes exactly the ghost ===');
  {
    await page.click('#btn-thicken-in');
    const v = await slideTo(page, 2.0);
    const i = await live(page);
    const ghost = Array.from(i.soup), before = await rawOf(page);
    check('Thicken in at 2.0: ghost up, 10 inner faces move', v === 2 && /Thicken in 2 mm - 10 inner face\(s\) move, 58 held/.test(i.readout), i.readout);
    await page.click('#btn-thicken-set');
    await page.waitForFunction(() => !nsoThickenLive.on(), null, { timeout: 30000 });
    const baked = await rawOf(page);
    check('Set: the piece\'s triangles ARE the ghost\'s, every one of ' + ghost.length + ' floats equal', sameFloats(baked, ghost));
    check('  ...status is Thicken\'s own line', /^Thicken in 2 - 10 inner face\(s\) moved, 58 held; open 0→0, NM 0→0, piercing 0→0/.test(await statusOf(page)), await statusOf(page));
    const gs9 = await ghostState(page), ut9 = await page.evaluate(() => state.undoStack.map(e => e.type));
    check('  ...one Undo step, and the control is put away (panel shut, ghost gone, piece solid again)', ut9.length === 1 && ut9[0] === 'thickenReplace' &&
          gs9.panelHidden && gs9.opacity === 1 && !gs9.transparent && gs9.helpers === 0 && !gs9.group && gs9.outOn === 'false' && gs9.inOn === 'false', JSON.stringify(ut9) + ' ' + JSON.stringify(gs9));
    check('  ...baked 1.5 -> 2.0: cavity walls 2 -> 4 (volume 60000 - 52*32*21 = 25056, 1e-3)', near(await rawVolume(page), 25056, 1e-3), (await rawVolume(page)).toFixed(3));
    await undo(page);
    check('Undo: the original, bit for bit', sameFloats(await rawOf(page), before));
  }

  console.log('\n=== 10. Cancel leaves the piece alone ===');
  {
    await page.evaluate(() => { window.__thickenRef = getActiveModel().rawTris; });
    const before = await rawOf(page), d0 = await undoDepth(page);
    await page.click('#btn-thicken-out');
    await slideTo(page, 3);
    check('armed, slider at 3: the ghost is up', (await live(page)).mm === 3 && (await ghostState(page)).group);
    await page.click('#btn-thicken-cancel');
    const g = await ghostState(page);
    check('Cancel: the piece is the same object with the same triangles, no Undo step', await page.evaluate(() => getActiveModel().rawTris === window.__thickenRef) && sameFloats(await rawOf(page), before) && (await undoDepth(page)) === d0);
    check('  ...ghost gone, piece solid, panel shut, buttons unlit, nothing left in the scene', g.panelHidden && g.opacity === 1 && !g.transparent && g.helpers === 0 && !g.group && g.outOn === 'false', JSON.stringify(g));
    check('  ...says so', /Thicken cancelled - nothing changed/.test(await statusOf(page)), await statusOf(page));
    await page.click('#btn-thicken-in'); await page.keyboard.press('Escape');
    check('Escape does the same', !(await liveOn(page)) && (await ghostState(page)).helpers === 0 && sameFloats(await rawOf(page), before));
    await page.click('#btn-thicken-out'); await page.click('#btn-thicken-out');
    check('the same button again does the same', !(await liveOn(page)) && sameFloats(await rawOf(page), before));
    await page.click('#btn-thicken-out'); await page.click('#btn-thicken-in');
    const sw = await live(page);
    check('the other button switches verb and keeps the number: Thicken in at the same mm', sw && sw.mode === 'in' && sw.mm === (await page.evaluate(() => +document.getElementById('inp-thicken-mm').value)) && (await ghostState(page)).inOn === 'true');
    await page.click('#btn-thicken-cancel');
  }

  console.log('\n=== 11. per-face: one wall, by a click ===');
  {
    await setMm(page, 1.5);
    const bb = await rawBox(page), orig = await rawOf(page);
    const mid = [(bb.lo[0] + bb.hi[0]) / 2, (bb.lo[1] + bb.hi[1]) / 2, (bb.lo[2] + bb.hi[2]) / 2];
    // -- Thicken out, click the +x wall --
    await frameCorner(page);
    await page.click('#btn-thicken-out');
    const whole = await live(page);
    check('no face picked: the whole piece (58 faces move), Whole piece greyed', whole.wall === null && whole.moved === 58 && await page.isDisabled('#btn-thicken-whole'), whole.readout);
    await realClick(page, await screenOfRaw(page, [bb.hi[0], mid[1], mid[2]]));
    const w1 = await live(page);
    check('a click on the +x wall picks it: one wall, and only its faces move (not the 58 of the whole piece)', w1.wall && w1.wall.count >= 2 && w1.moved === w1.wall.count && w1.moved < 10 && new RegExp('one wall: ' + w1.wall.count + ' triangle\\(s\\) picked').test(w1.readout), w1.readout);
    check('  ...the wall is lit, Whole piece is live', await page.evaluate(() => !!nsoThickenLive.objects().wall) && !(await page.isDisabled('#btn-thicken-whole')));
    await realClick(page, await screenOfRaw(page, [bb.hi[0], mid[1], mid[2]]));
    const w2 = await live(page);
    check('a click on the same wall again drops it: whole piece', w2.wall === null && w2.moved === 58, w2.readout);
    await realClick(page, await screenOfRaw(page, [bb.hi[0], mid[1], mid[2]]));
    await page.click('#btn-thicken-whole');
    check('Whole piece does the same', (await live(page)).wall === null);
    await realClick(page, await screenOfRaw(page, [bb.hi[0], mid[1], mid[2]]));
    const ghostW = Array.from((await live(page)).soup);
    await page.click('#btn-thicken-set');
    await page.waitForFunction(() => !nsoThickenLive.on(), null, { timeout: 30000 });
    const baked = await rawOf(page), nb = await rawBox(page);
    check('Set: the piece is the ghost bit for bit; status names the wall', sameFloats(baked, ghostW) && new RegExp('^Thicken out 1.5 - ' + w1.wall.count + ' outer face\\(s\\) moved, ' + (68 - w1.wall.count) + ' held.*\\(one wall: ' + w1.wall.count + ' triangle\\(s\\) picked\\)').test(await statusOf(page)), await statusOf(page));
    check('  ...ONLY the +x wall moved: x 60 -> 61.5, every other extent as it was (1e-5)', near(nb.hi[0], bb.hi[0] + 1.5, 1e-5) && near(nb.lo[0], bb.lo[0], 1e-5) && [1, 2].every(k => near(nb.lo[k], bb.lo[k], 1e-5) && near(nb.hi[k], bb.hi[k], 1e-5)), nb.size.join(' x '));
    let moved = 0, stray = 0;
    for (let i = 0; i < orig.length; i += 3) {
      const d = [0, 1, 2].map(k => baked[i + k] - orig[i + k]);
      if (Math.hypot(...d) > 1e-6) { moved++; if (!(near(orig[i], bb.hi[0], 1e-4) && near(d[0], 1.5, 1e-4) && near(d[1], 0, 1e-4) && near(d[2], 0, 1e-4))) stray++; }
    }
    check('  ...every vertex that moved was on the +x wall and moved straight out by 1.5 (' + moved + ' of ' + orig.length / 3 + ' corners; ' + stray + ' stray)', moved > 0 && stray === 0);
    check('  ...volume 13632 + 40*25*1.5 = 15132 (1e-3)', near(await rawVolume(page), 15132, 1e-3), (await rawVolume(page)).toFixed(3));
    await undo(page);
    check('Undo: the original', sameFloats(await rawOf(page), orig));

    // -- Thicken in, click the cavity floor from above --
    await frameAbove(page);
    await page.click('#btn-thicken-in');
    await realClick(page, await screenOfRaw(page, [mid[0], mid[1], bb.lo[2] + 2]));
    const f1 = await live(page);
    check('Thicken in: a click down the open top picks the cavity floor - one wall, only its faces move', f1.wall && f1.wall.count >= 2 && f1.moved === f1.wall.count && f1.moved < 10, f1.readout);
    await page.click('#btn-thicken-set');
    await page.waitForFunction(() => !nsoThickenLive.on(), null, { timeout: 30000 });
    const fb = await rawOf(page); let fm = 0, fstray = 0;
    for (let i = 0; i < orig.length; i += 3) {
      const d = [0, 1, 2].map(k => fb[i + k] - orig[i + k]);
      if (Math.hypot(...d) > 1e-6) { fm++; if (!(near(orig[i + 2], bb.lo[2] + 2, 1e-4) && near(d[2], 1.5, 1e-4) && near(d[0], 0, 1e-4) && near(d[1], 0, 1e-4))) fstray++; }
    }
    check('  ...ONLY the floor moved: every vertex that moved was on the floor (z 2) and rose 1.5 (' + fm + ' corners, ' + fstray + ' stray)', fm > 0 && fstray === 0);
    check('  ...volume 13632 + 56*36*1.5 = 16656 (1e-3); whole-piece Thicken in 1.5 is 22396.5, so this is one wall', near(await rawVolume(page), 16656, 1e-3), (await rawVolume(page)).toFixed(3));
    check('  ...the outer bbox is untouched, 60 x 40 x 25', await rawBox(page).then(b => b.size.every((v, k) => near(v, [60, 40, 25][k], 1e-5))));
    await undo(page);

    // -- a wall on the wrong side for the verb: refused in words --
    await page.click('#btn-thicken-out');
    await realClick(page, await screenOfRaw(page, [mid[0], mid[1], bb.lo[2] + 2]));
    const wr = await live(page);
    check('Thicken out on the cavity floor: refused in words (the wall picked is on the inside), Set greyed, nothing baked', !wr.ok && /^Thicken out 1.5 mm refused - the wall you picked is on the inside/.test(wr.readout) && await page.isDisabled('#btn-thicken-set') && sameFloats(await rawOf(page), orig), wr.readout);
    await page.click('#btn-thicken-whole');
    check('  ...Whole piece brings the ghost back and Set with it', (await live(page)).ok && !(await page.isDisabled('#btn-thicken-set')));
    await page.click('#btn-thicken-cancel');
    check('every per-face step left no Undo step behind it but its own bake', (await undoDepth(page)) === 0);
  }

  console.log('\n=== 12. Hollow\'s number box ===');
  {
    const id = await loadSTL(page, fx('box-20mm.stl')); await selectModel(page, id);
    await page.evaluate(() => { document.getElementById('menu-bit').open = true; });
    const geo = await page.evaluate(() => { const r = document.getElementById('inp-hollow-mm').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    check('the box is a box: at least 48 px wide (it was the 24 px middle column of the Thicken row)', geo.w >= 48, geo.w + ' x ' + geo.h);
    await page.click('#inp-hollow-mm');
    check('a click on it focuses it and leaves the number alone (it stepped 2 -> 1.92 before)', (await page.inputValue('#inp-hollow-mm')) === '2' && (await page.evaluate(() => document.activeElement.id)) === 'inp-hollow-mm', await page.inputValue('#inp-hollow-mm'));
    await page.keyboard.press('Control+A'); await page.keyboard.type('3');
    check('typing a number lands in it: 3', (await page.inputValue('#inp-hollow-mm')) === '3');
    await page.keyboard.press('ArrowUp');
    check('its arrow keys step 0.1: 3.1', near(+(await page.inputValue('#inp-hollow-mm')), 3.1, 1e-9), await page.inputValue('#inp-hollow-mm'));
    await page.fill('#inp-hollow-mm', '3');
    await page.click('#btn-hollow');
    await page.waitForFunction(() => /Hollow(ed| refused| failed)/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    const hs = await statusOf(page);
    check('Hollow runs on the box\'s number: "Hollowed to a 3 mm wall"', /^Hollowed to a 3 mm wall/.test(hs), hs);
    check('  ...one Undo step', (await undoDepth(page)) === 1);
    await undo(page);
    check('  ...Hollow to safe min is on its own row, the full width, and still there', await page.evaluate(() => { const b = document.getElementById('btn-hollow-safe'), h = document.getElementById('btn-hollow'); return !!b && b.getBoundingClientRect().width > h.getBoundingClientRect().width && b.getBoundingClientRect().top > h.getBoundingClientRect().bottom - 1; }));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles in ' + out);
  console.log(fails ? '\nTHICKEN DRIVE: ' + fails + ' FAILED' : '\nTHICKEN DRIVE: all checks passed');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('THICKEN DRIVE FAIL', e); process.exit(1); });
