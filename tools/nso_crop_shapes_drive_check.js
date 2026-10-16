#!/usr/bin/env node
/* Crop's Circle and Piece regions, driven through the REAL app in headless
   Chromium at 1280 x 800 (app-crop.js sections 6 and 7).

     node tools/nso_crop_shapes_drive_check.js                     exit 0 = every gate held
     node tools/nso_crop_shapes_drive_check.js tools/crop-shapes-out  ...and keep the screenshots
                                                                   (npm run crop:shapes-shots;
                                                                   gitignored, never committed)

   Every piece comes in through the app's own Import. Every button and field
   is a real click or typed value in the Crop card; the circle's centre, its
   drags and the template pick are real pointer events on the main canvas at
   the screen point of a spot the app drew. Every result goes through
   tools/mesh_validate.py, the canonical checker, self-intersection included.

     1. CIRCLE, keep inside, on a 60 x 60 x 4 mm plate: Click centre, press on
        the plate's middle and drag out (Ø follows the drag), type Ø 30. Crop:
        a Ø30 disc - every vertex 15 ± 0.05 mm from the centre, 30 ± 0.05 mm
        across both ways, the volume of a 30 x 4 mm disc - closed and clean,
        left where the circle was, ONE Undo step that puts back the plate bit
        for bit and where it stood.
     2. CIRCLE, keep outside: the plate with a Ø30 hole - outside still
        60 x 60, the bore's vertices 15 ± 0.05 from the centre, genus 1.
     3. the circle's drags and the refusals: the rim resizes, the middle
        slides; slid off the plate it is refused in words, and Ø 200 is
        refused both ways (holds the whole piece / covers it). Nothing
        changes on a refusal, and no Undo step is added.
     4. PIECE, keep inside: a 100 x 100 x 3 plate cropped to the star prism
        (library/soften_test_05_star_prism.stl) laid over it off-centre. The
        outline matches the star's silhouette within 0.05 mm both ways, in
        the plate's own raw frame, computed here from the two meshes as drawn
        (not by the app's code). The star is untouched. One Undo.
     5. PIECE, Grow 2: the outline is 2 ± 0.05 mm outside the star's all
        round, both ways. Keep outside gives a plate with a star hole. The
        star slid off the plate is refused in words; picking the plate itself
        as its own template is refused in words.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-crop-shapes-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });
async function shot(page, name) {
  await page.waitForTimeout(300);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file });
  console.log('   [screenshot] ' + (KEEP ? path.relative(ROOT, file) : name));
}

/* ---- fixtures ------------------------------------------------------------- */

function boxSoup(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
const PLATE60 = path.join(TMP, 'plate-60.stl');
writeSTL(PLATE60, boxSoup([0, 0, 0], [60, 60, 4]));
const PLATE100 = path.join(TMP, 'plate-100.stl');
writeSTL(PLATE100, boxSoup([0, 0, 0], [100, 100, 3]));
const STAR = path.join(ROOT, 'library', 'soften_test_05_star_prism.stl');

/* ---- the canonical checker ---------------------------------------------- */

let seq = 0;
function validate(soup) {
  const f = path.join(TMP, 'r' + (seq++) + '.stl');
  writeSTL(f, new Float32Array(soup));
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
    { maxBuffer: 1 << 30 }).toString());
  const si = j.self_intersection || {};
  j.clean = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
    j.degenerate_tris === 0 && !si.pierce;
  j.volume = j.signed_volume;
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic + ' pierce ' + (si.pierce || 0) +
    ' vol ' + (+j.volume).toFixed(2);
  return j;
}

/* ---- 2D geometry, here and not the app's ----------------------------------- */

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function distToOutline(p, segs) {
  let best = Infinity;
  for (const s of segs) best = Math.min(best, segDist(p[0], p[1], s[0], s[1], s[2], s[3]));
  return best;
}
function insideOutline(p, segs) {
  let c = false;
  for (const s of segs) {
    if ((s[1] > p[1]) !== (s[3] > p[1])) {
      const x = s[0] + (p[1] - s[1]) * (s[2] - s[0]) / (s[3] - s[1]);
      if (x > p[0]) c = !c;
    }
  }
  return c;
}
/* The outline seen from above of a soup whose walls are vertical: the
   boundary edges of its up-facing triangles, as [ax, ay, bx, by]. */
function topOutline(soup) {
  const key = (x, y) => x.toFixed(4) + ',' + y.toFixed(4);
  const dir = new Map();
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1];
    const uz = soup[o + 5] - soup[o + 2], vz = soup[o + 8] - soup[o + 2];
    const nz = ux * vy - uy * vx, nn = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
    if (!(nn > 0) || nz / nn < 0.999) continue;
    for (let e = 0; e < 3; e++) {
      const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      dir.set(key(soup[a], soup[a + 1]) + '>' + key(soup[b], soup[b + 1]), [soup[a], soup[a + 1], soup[b], soup[b + 1]]);
    }
  }
  const out = [];
  dir.forEach((s, k) => { const p = k.split('>'); if (!dir.has(p[1] + '>' + p[0])) out.push(s); });
  return out;
}
function samples(segs, step) {
  const pts = [];
  for (const s of segs) {
    const L = Math.hypot(s[2] - s[0], s[3] - s[1]), n = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i < n; i++) pts.push([s[0] + (s[2] - s[0]) * i / n, s[1] + (s[3] - s[1]) * i / n]);
  }
  return pts;
}
// Column-major 4x4 times a point.
const apply = (M, x, y, z) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
function invertRigid(M) {   // a rotation + translation (the meshes here carry no scale)
  const R = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];   // columns
  const t = [M[12], M[13], M[14]];
  // inverse = R^T, -R^T t
  const out = [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, 0, 0, 0, 1];
  out[12] = -(R[0] * t[0] + R[1] * t[1] + R[2] * t[2]);
  out[13] = -(R[3] * t[0] + R[4] * t[1] + R[5] * t[2]);
  out[14] = -(R[6] * t[0] + R[7] * t[1] + R[8] * t[2]);
  return out;
}
function bounds(soup) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], soup[i]); hi[k] = Math.max(hi[k], soup[i]); }
  return { lo, hi };
}
const near = (a, b, e) => Math.abs(a - b) <= e;
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/* ---- the page ------------------------------------------------------------- */

const status = page => page.evaluate(() => document.getElementById('status').textContent);
const shapeReadout = page => page.evaluate(() => document.getElementById('crop-shape-readout').textContent);
const raw = (page, id) => page.evaluate(id => Array.from(state.models.find(m => m.id === id).rawTris), id);
const undoDepth = page => page.evaluate(() => state.undoStack.length);
const placedXZ = (page, id) => page.evaluate(id => { const p = state.placed.find(q => q.sourceId === id); return [p.x, p.z]; }, id);
const selectRow = (page, id) => page.click('.model-item[data-edit-id="' + id + '"]');

// The piece as drawn: its mesh's world matrix, its raw->display offset, its world box.
const drawn = (page, id) => page.evaluate(id => {
  const m = state.models.find(q => q.id === id), p = state.placed.find(q => q.sourceId === id);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { M: Array.from(p.mesh.matrixWorld.elements), off: m.centerOffset,
           box: { min: bb.min.toArray(), max: bb.max.toArray() } };
}, id);
// world -> raw frame of a piece drawn as `d`: local = inv(M) world; raw = (X + ox, -(Z + oz), Y + oy)
function worldToRaw(d, w) {
  const l = apply(invertRigid(d.M), w[0], w[1], w[2]);
  return [l[0] + d.off.x, -(l[2] + d.off.z), l[1] + d.off.y];
}
function rawToWorld(d, r) {
  return apply(d.M, r[0] - d.off.x, r[2] - d.off.y, -r[1] - d.off.z);
}
// A piece's triangles in world, from its drawn mesh.
const worldSoup = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q.sourceId === id), g = p.mesh.geometry, pos = g.attributes.position;
  p.mesh.updateMatrixWorld(true);
  const out = [], v = new THREE.Vector3(), n = g.index ? g.index.count : pos.count;
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, g.index ? g.index.getX(i) : i).applyMatrix4(p.mesh.matrixWorld); out.push(v.x, v.y, v.z); }
  return out;
}, id);

const screenOf = (page, w) => page.evaluate(w => {
  state.camera.updateMatrixWorld(true);
  const q = new THREE.Vector3(w[0], w[1], w[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}, w);

async function lookDown(page, id, span) {
  await page.evaluate(([id, span]) => {
    const p = state.placed.find(q => q.sourceId === id);
    const bb = new THREE.Box3().setFromObject(p.mesh), c = bb.getCenter(new THREE.Vector3());
    const s = span || Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + s * 1.25, c.z + s * 0.55);
    state.controls.update();
  }, [id, span || 0]);
  await page.waitForTimeout(250);
}

async function crop(page) {
  const before = await status(page);
  await page.click('#btn-crop-shape');
  await page.waitForFunction(b => {
    const s = document.getElementById('status').textContent;
    return s !== b && /^Crop (done|refused|failed|stood)/.test(s);
  }, before, { timeout: 120000 });
  return status(page);
}
async function ctrlZ(page) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
}
async function typeField(page, sel, v) {
  await page.fill(sel, String(v));
  await page.press(sel, 'Tab');
  await page.waitForTimeout(150);
}
async function pressDrag(page, a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 6, a.y + (b.y - a.y) * i / 6);
  await page.mouse.up();
  await page.waitForTimeout(200);
}
const circleState = page => page.evaluate(() => {
  const m = getActiveModel(), mesh = NSO_cropTargetMesh(m), c = NSO_cropCircleFor(m), w = NSO_cropCircleWorld(m, mesh);
  return { d: c.d, raw: c.raw.slice(), world: [w.x, w.y, w.z], field: document.getElementById('crop-circle-d').value };
});

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  /* ======================================================== 1. circle inside */
  console.log('\n=== 1. Circle, keep inside, on a 60 mm plate ===');
  const pid = await loadSTL(page, PLATE60);
  const SRC = await raw(page, pid);
  check('the 60 x 60 x 4 plate came in through Import', SRC.length / 9 === 12);
  await selectRow(page, pid);
  await page.click('#menu-crop > summary');
  await page.waitForFunction(() => state.cutterOpen && state.cutTool === 'crop', null, { timeout: 10000 });
  check('the Crop card opens on Box, as before', await page.evaluate(() =>
    document.getElementById('btn-crop-region-box').classList.contains('tool-active') &&
    !document.getElementById('crop-tools').hidden && document.getElementById('crop-shape-tools').hidden));
  await page.click('#btn-crop-region-circle');
  const vis = await page.evaluate(() => ({
    box: document.getElementById('crop-tools').hidden, axis: document.getElementById('crop-axis-row').hidden,
    shape: document.getElementById('crop-shape-tools').hidden, circle: document.getElementById('crop-circle-row').hidden,
    piece: document.getElementById('crop-piece-row').hidden }));
  check('Circle: its rows show, the Box rows and Piece rows do not', vis.box && vis.axis && !vis.shape && !vis.circle && vis.piece, JSON.stringify(vis));
  await lookDown(page, pid, 70);
  const D0 = await drawn(page, pid);
  const top = D0.box.max[1];
  const mid = [(D0.box.min[0] + D0.box.max[0]) / 2, top, (D0.box.min[2] + D0.box.max[2]) / 2];
  await page.click('#btn-crop-circle-place');
  check('Click centre arms one press', /Press on the piece/.test(await shapeReadout(page)), await shapeReadout(page));
  const at = await screenOf(page, mid), to = await screenOf(page, [mid[0] + 12, top, mid[2]]);
  await pressDrag(page, at, to);
  const c1 = await circleState(page);
  check('the press put the centre on the plate\'s middle', Math.hypot(c1.world[0] - mid[0], c1.world[2] - mid[2]) < 0.5,
    'centre ' + c1.world.map(v => v.toFixed(2)).join(', ') + ' vs ' + mid.map(v => v.toFixed(2)).join(', '));
  check('dragging out sized it: Ø ≈ 24 (twice the drag)', near(c1.d, 24, 0.6) && near(+c1.field, c1.d, 0.05), 'Ø ' + c1.d + ', field ' + c1.field);
  check('the press disarmed Click centre', !(await page.evaluate(() => NSO_cropShapeState().placing)));
  check('the plate was not selected away or moved by the press', (await page.evaluate(() => state.editId)) === pid && same(await placedXZ(page, pid), [D0.M[12], D0.M[14]]));
  await typeField(page, '#crop-circle-d', 30);
  const c2 = await circleState(page);
  check('typed Ø 30', c2.d === 30 && c2.field === '30.0', 'Ø ' + c2.d);
  check('the read-out says it', /^Circle Ø30\.0 mm, centre .* Keep inside/.test(await shapeReadout(page)), await shapeReadout(page));
  check('the circle is drawn, an upright cylinder through the plate', await page.evaluate(() => {
    const h = state.cropShapeHelper; if (!h || !h.parent) return false;
    const b = new THREE.Box3().setFromObject(h);
    return Math.abs(b.max.x - b.min.x - 30) < 0.01 && b.min.y < 0.3 && b.max.y > 4.3;
  }));
  await shot(page, '1-circle-on-plate');
  const u0 = await undoDepth(page);
  const s1 = await crop(page);
  check('Crop: done, kept inside the circle, one closed piece', /^Crop done - kept inside the circle Ø30\.0 mm; .* one closed piece \(open 0, non-manifold 0\)/.test(s1), s1);
  const R1 = await raw(page, pid);
  const ctrRaw = worldToRaw(D0, c2.world);
  let rmin = Infinity, rmax = 0;
  for (let i = 0; i < R1.length; i += 3) { const r = Math.hypot(R1[i] - ctrRaw[0], R1[i + 1] - ctrRaw[1]); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
  const b1 = bounds(R1);
  check('a Ø30 disc: every vertex 15 ± 0.05 mm from the centre', rmin >= 14.95 && rmax <= 15.05, 'r ' + rmin.toFixed(4) + ' .. ' + rmax.toFixed(4));
  check('...30 ± 0.05 mm across both ways, 4 mm thick', near(b1.hi[0] - b1.lo[0], 30, 0.05) && near(b1.hi[1] - b1.lo[1], 30, 0.05) && near(b1.hi[2] - b1.lo[2], 4, 1e-4),
    (b1.hi[0] - b1.lo[0]).toFixed(4) + ' x ' + (b1.hi[1] - b1.lo[1]).toFixed(4) + ' x ' + (b1.hi[2] - b1.lo[2]).toFixed(4));
  const v1 = validate(R1);
  check('the canonical checker: closed, manifold, no piercing, one shell', v1.clean && v1.euler_characteristic === 2, v1.summary);
  check('...the volume of a 30 x 4 mm disc (within 0.05%)', near(v1.volume, Math.PI * 225 * 4, Math.PI * 225 * 4 * 5e-4), (+v1.volume).toFixed(2) + ' vs ' + (Math.PI * 900).toFixed(2));
  const D1 = await drawn(page, pid);
  const ctrNow = rawToWorld(D1, ctrRaw);
  check('the disc stays where the circle was on the plate', Math.hypot(ctrNow[0] - c2.world[0], ctrNow[2] - c2.world[2]) < 1e-3,
    'moved ' + Math.hypot(ctrNow[0] - c2.world[0], ctrNow[2] - c2.world[2]).toExponential(2) + ' mm');
  check('ONE Undo step', (await undoDepth(page)) === u0 + 1);
  const c3 = await circleState(page);
  check('the circle stays on the same spot', Math.hypot(c3.world[0] - c2.world[0], c3.world[2] - c2.world[2]) < 1e-3 && c3.d === 30);
  await shot(page, '2-circle-keep-inside');
  await ctrlZ(page);
  check('Ctrl+Z: "Undo: Crop reverted", the plate back bit for bit, where it stood', /Undo: Crop reverted/.test(await status(page)) &&
    same(await raw(page, pid), SRC) && same(await placedXZ(page, pid), [D0.M[12], D0.M[14]]) && (await undoDepth(page)) === u0,
    await status(page));

  /* ======================================================= 2. circle outside */
  console.log('\n=== 2. Circle, keep outside: a Ø30 hole ===');
  await page.click('#btn-crop-keep-out');
  check('Keep outside is on, Keep inside off', await page.evaluate(() =>
    document.getElementById('btn-crop-keep-out').classList.contains('tool-active') && !document.getElementById('btn-crop-keep-in').classList.contains('tool-active')));
  const s2 = await crop(page);
  check('Crop: done, kept outside the circle', /^Crop done - kept outside the circle Ø30\.0 mm; .* one closed piece/.test(s2), s2);
  const R2 = await raw(page, pid), b2 = bounds(R2);
  check('the outside is still 60 x 60 x 4', near(b2.hi[0] - b2.lo[0], 60, 1e-4) && near(b2.hi[1] - b2.lo[1], 60, 1e-4) && near(b2.hi[2] - b2.lo[2], 4, 1e-4));
  let hmin = Infinity, hmax = 0, bore = 0;
  for (let i = 0; i < R2.length; i += 3) {
    const onOuter = near(R2[i], 0, 1e-4) || near(R2[i], 60, 1e-4) || near(R2[i + 1], 0, 1e-4) || near(R2[i + 1], 60, 1e-4);
    if (onOuter) continue;
    const r = Math.hypot(R2[i] - ctrRaw[0], R2[i + 1] - ctrRaw[1]); hmin = Math.min(hmin, r); hmax = Math.max(hmax, r); bore++;
  }
  check('the hole: every bore vertex 15 ± 0.05 mm from the centre', bore > 100 && hmin >= 14.95 && hmax <= 15.05, bore + ' vertices, r ' + hmin.toFixed(4) + ' .. ' + hmax.toFixed(4));
  const v2 = validate(R2);
  check('the canonical checker: closed, manifold, no piercing, genus 1 (a hole through)', v2.clean && v2.euler_characteristic === 0, v2.summary);
  check('...volume = plate - disc (within 0.05%)', near(v2.volume, 60 * 60 * 4 - Math.PI * 900, Math.PI * 900 * 5e-4), (+v2.volume).toFixed(2));
  check('the plate did not move', same(await placedXZ(page, pid), [D0.M[12], D0.M[14]]) || Math.hypot(...(await placedXZ(page, pid)).map((v, i) => v - [D0.M[12], D0.M[14]][i])) < 1e-6);
  await shot(page, '3-circle-keep-outside');
  await ctrlZ(page);
  check('Ctrl+Z puts the plate back', same(await raw(page, pid), SRC) && (await undoDepth(page)) === u0);

  /* =============================================== 3. drags and refusals */
  console.log('\n=== 3. the circle\'s drags, and the refusals ===');
  await lookDown(page, pid, 70);
  const rimW = [c2.world[0] + 15, top, c2.world[2]];
  await pressDrag(page, await screenOf(page, [c2.world[0] + 14.6, top + 1, c2.world[2]]), await screenOf(page, [c2.world[0] + 10, top + 1, c2.world[2]]));
  const c4 = await circleState(page);
  check('dragging the rim resizes it (in to about Ø20)', near(c4.d, 20, 1) && Math.hypot(c4.world[0] - c2.world[0], c4.world[2] - c2.world[2]) < 1e-3, 'Ø ' + c4.d);
  await pressDrag(page, await screenOf(page, [c2.world[0], top + 1, c2.world[2]]), await screenOf(page, [c2.world[0] + 8, top + 1, c2.world[2] - 5]));
  const c5 = await circleState(page);
  check('dragging the middle slides it, Ø kept', near(c5.world[0] - c2.world[0], 8, 0.6) && near(c5.world[2] - c2.world[2], -5, 0.6) && c5.d === c4.d,
    'moved ' + (c5.world[0] - c2.world[0]).toFixed(2) + ', ' + (c5.world[2] - c2.world[2]).toFixed(2));
  check('neither drag changed the plate or added an Undo step', same(await raw(page, pid), SRC) && (await undoDepth(page)) === u0);
  void rimW;
  // slide it right off the plate
  await lookDown(page, pid, 160);
  await pressDrag(page, await screenOf(page, [c5.world[0], top + 1, c5.world[2]]), await screenOf(page, [c5.world[0] + 60, top + 1, c5.world[2]]));
  const c6 = await circleState(page);
  check('slid off the plate, the read-out says so before any Crop', /The circle misses the piece\./.test(await shapeReadout(page)), await shapeReadout(page));
  await shot(page, '4-circle-off-the-plate');
  const s6 = await crop(page);
  check('Crop refuses in words: the circle misses the piece', /^Crop refused - piece unchanged \(the circle misses the piece/.test(s6), s6);
  check('...nothing changed, no Undo step', same(await raw(page, pid), SRC) && (await undoDepth(page)) === u0);
  void c6;
  await pressDrag(page, await screenOf(page, [c5.world[0] + 60, top + 1, c5.world[2]]), await screenOf(page, [c5.world[0], top + 1, c5.world[2]]));
  await typeField(page, '#crop-circle-d', 200);
  const s7 = await crop(page);
  check('Ø 200, keep outside: refused - it covers the whole piece', /^Crop refused - piece unchanged \(the circle covers the whole piece/.test(s7), s7);
  await page.click('#btn-crop-keep-in');
  const s8 = await crop(page);
  check('Ø 200, keep inside: refused - it holds the whole piece', /^Crop refused - piece unchanged \(the circle holds the whole piece/.test(s8), s8);
  check('...nothing changed, no Undo step', same(await raw(page, pid), SRC) && (await undoDepth(page)) === u0);

  /* =========================================================== 4. piece */
  console.log('\n=== 4. Piece, keep inside: a 100 mm plate cropped to the star ===');
  // Loading with the cutter open previews a piece instead of placing it, so
  // shut the card first (the 60 mm plate goes), load, and open it again.
  await page.click('#menu-crop > summary');
  await page.waitForFunction(() => !state.cutterOpen, null, { timeout: 10000 });
  check('shutting the card takes the circle away with it', await page.evaluate(() => !state.cropShapeHelper || !state.cropShapeHelper.parent));
  await page.evaluate(id => {
    const i = state.placed.findIndex(p => p.sourceId === id);
    state.placed[i].mesh.parent.remove(state.placed[i].mesh); state.placed.splice(i, 1);
    state.models = state.models.filter(m => m.id !== id);
    state.placed.forEach((p, k) => { p.mesh.userData.placedIndex = k; });
    state.selectedIndex = -1; state.editId = null;
    renderModelList();
  }, pid);
  const qid = await loadSTL(page, PLATE100);
  const sid = await loadSTL(page, STAR);
  const STAR_SRC = await raw(page, sid);
  check('the 100 mm plate and the star came in through Import', (await raw(page, qid)).length / 9 === 12 && STAR_SRC.length / 9 === 36);
  // Lay the star over the plate, off its centre - the way a drag on the plate would leave it.
  const Q = await drawn(page, qid);
  const qc = [(Q.box.min[0] + Q.box.max[0]) / 2, (Q.box.min[2] + Q.box.max[2]) / 2];
  await page.evaluate(([sid, x, z]) => { const p = state.placed.find(q => q.sourceId === sid); applyPlacedXZ(p, x, z); }, [sid, qc[0] + 12, qc[1] - 7]);
  const STAR_XZ = await placedXZ(page, sid);
  await selectRow(page, qid);
  await page.waitForFunction(id => state.editId === id, qid);
  await page.click('#menu-crop > summary');
  await page.waitForFunction(() => state.cutterOpen && state.cutTool === 'crop', null, { timeout: 10000 });
  await page.click('#btn-crop-region-piece');
  const vis2 = await page.evaluate(() => ({ circle: document.getElementById('crop-circle-row').hidden, piece: document.getElementById('crop-piece-row').hidden,
    grow: document.getElementById('crop-grow-row').hidden, growV: document.getElementById('crop-piece-grow').value }));
  check('Piece: its rows show, Grow defaults to 0', vis2.circle && !vis2.piece && !vis2.grow && vis2.growV === '0.0', JSON.stringify(vis2));
  check('no template yet: Crop is off, the read-out says what to do', await page.evaluate(() => document.getElementById('btn-crop-shape').disabled) &&
    /Press Pick piece/.test(await shapeReadout(page)), await shapeReadout(page));
  await lookDown(page, qid, 110);
  // Picking the plate itself is refused in words.
  await page.click('#btn-crop-piece-pick');
  const qTop = await screenOf(page, [qc[0] + 38, Q.box.max[1], qc[1] + 35]);   // clear of the star and of the card
  await page.mouse.click(qTop.x, qTop.y);
  await page.waitForTimeout(200);
  check('clicking the plate itself: "That is the piece being cropped"', /That is the piece being cropped/.test(await status(page)) &&
    (await page.evaluate(() => state.editId)) === qid, await status(page));
  const S0 = await drawn(page, sid);
  const sTop = await screenOf(page, [S0.M[12], S0.box.max[1], S0.M[14]]);
  await page.mouse.click(sTop.x, sTop.y);
  await page.waitForTimeout(300);
  check('clicking the star makes it the template; the plate stays selected', (await page.evaluate(() => NSO_cropShapeState().templateId)) === sid &&
    (await page.evaluate(() => state.editId)) === qid && /soften_test_05_star_prism/.test(await page.evaluate(() => document.getElementById('crop-piece-name').textContent)),
    await page.evaluate(() => document.getElementById('crop-piece-name').textContent));
  await page.waitForFunction(() => /mm² seen from above/.test(document.getElementById('crop-shape-readout').textContent), null, { timeout: 30000 });
  check('the read-out names the outline and its area', /^Outline of soften_test_05_star_prism.*, [\d.]+ mm² seen from above\. Keep inside/.test(await shapeReadout(page)), await shapeReadout(page));
  check('the outline is drawn over the plate', await page.evaluate(() => !!state.cropShapeHelper && !!state.cropShapeHelper.parent));
  await shot(page, '5-star-over-plate');

  // The star's outline in the plate's raw frame, from the two meshes as drawn.
  const starWorld = await worldSoup(page, sid);
  const starInPlate = [];
  for (let i = 0; i < starWorld.length; i += 3) starInPlate.push(...worldToRaw(Q, [starWorld[i], starWorld[i + 1], starWorld[i + 2]]));
  const STAR_OUT = topOutline(starInPlate);
  check('the star\'s outline seen from above: 10 edges', STAR_OUT.length === 10, STAR_OUT.length + ' edges');
  const starPts = STAR_OUT.map(s => [s[0], s[1]]);
  let starArea = 0;
  for (const s of STAR_OUT) starArea += (s[0] * s[3] - s[2] * s[1]) / 2;
  starArea = Math.abs(starArea);

  const QSRC = await raw(page, qid), uq = await undoDepth(page);
  const s9 = await crop(page);
  check('Crop: done, kept inside the outline of the star', /^Crop done - kept inside the outline of soften_test_05_star_prism.*; .* one closed piece/.test(s9), s9);
  const R9 = await raw(page, qid);
  let far = 0, worst = 0;
  for (let i = 0; i < R9.length; i += 3) { const d = distToOutline([R9[i], R9[i + 1]], STAR_OUT); worst = Math.max(worst, d); if (d > 0.05) far++; }
  check('every vertex of the result is on the star\'s outline (within 0.05 mm)', far === 0, 'worst ' + worst.toFixed(5) + ' mm');
  const RES_OUT = topOutline(R9);
  let miss = 0, worst2 = 0;
  for (const p of samples(STAR_OUT, 0.25)) { const d = distToOutline(p, RES_OUT); worst2 = Math.max(worst2, d); if (d > 0.05) miss++; }
  check('...and every point of the star\'s outline is on the result\'s (within 0.05 mm)', miss === 0, 'worst ' + worst2.toFixed(5) + ' mm');
  const v9 = validate(R9);
  check('the canonical checker: closed, manifold, no piercing, one shell', v9.clean && v9.euler_characteristic === 2, v9.summary);
  check('...its volume is the star\'s area x the plate\'s 3 mm (within 0.05%)', near(v9.volume, starArea * 3, starArea * 3 * 5e-4), (+v9.volume).toFixed(2) + ' vs ' + (starArea * 3).toFixed(2));
  check('the template star is untouched: same soup, same place', same(await raw(page, sid), STAR_SRC) && same(await placedXZ(page, sid), STAR_XZ));
  const Q1 = await drawn(page, qid);
  const anchor = [R9[0], R9[1], R9[2]], wNow = rawToWorld(Q1, anchor), wWas = rawToWorld(Q, anchor);
  check('the cropped plate stays where it was, under the star', Math.hypot(wNow[0] - wWas[0], wNow[2] - wWas[2]) < 1e-3);
  check('ONE Undo step', (await undoDepth(page)) === uq + 1);
  await shot(page, '6-star-keep-inside');
  await ctrlZ(page);
  check('Ctrl+Z: the plate back bit for bit, where it stood', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq &&
    same(await placedXZ(page, qid), [Q.M[12], Q.M[14]]));

  /* ========================================================== 5. grow 2 */
  console.log('\n=== 5. Piece, Grow 2; keep outside; refusals ===');
  await typeField(page, '#crop-piece-grow', 2);
  check('Grow 2 is in the read-out', /grown \+2\.0 mm/.test(await shapeReadout(page)), await shapeReadout(page));
  const s10 = await crop(page);
  check('Crop: done, the outline grown +2.0 mm', /^Crop done - kept inside the outline of soften_test_05_star_prism grown \+2\.0 mm; .* one closed piece/.test(s10), s10);
  const R10 = await raw(page, qid);
  let lo10 = Infinity, hi10 = 0, inStar = 0;
  for (let i = 0; i < R10.length; i += 3) {
    const p = [R10[i], R10[i + 1]], d = distToOutline(p, STAR_OUT);
    lo10 = Math.min(lo10, d); hi10 = Math.max(hi10, d);
    if (insideOutline(p, STAR_OUT)) inStar++;
  }
  check('every vertex of the result is 2 ± 0.05 mm outside the star\'s outline', inStar === 0 && lo10 >= 1.95 && hi10 <= 2.05, lo10.toFixed(4) + ' .. ' + hi10.toFixed(4) + ' mm, ' + inStar + ' inside');
  const OUT10 = topOutline(R10);
  let lo11 = Infinity, hi11 = 0;
  for (const p of samples(STAR_OUT, 0.25)) { const d = distToOutline(p, OUT10); lo11 = Math.min(lo11, d); hi11 = Math.max(hi11, d); }
  // At the star's notches the grown edge is two offset lines meeting, further
  // than 2 mm from the notch itself, so the star's side is "no closer than 2".
  check('...and no point of the star\'s outline comes closer than 2 - 0.05 mm to the result\'s', lo11 >= 1.95, lo11.toFixed(4) + ' .. ' + hi11.toFixed(4) + ' mm');
  const bs = bounds(starInPlate), b10 = bounds(R10);
  check('...2 mm wider all round: the outline reaches 2 ± 0.05 mm past the star\'s on all four sides',
    near(bs.lo[0] - b10.lo[0], 2, 0.05) && near(b10.hi[0] - bs.hi[0], 2, 0.05) && near(bs.lo[1] - b10.lo[1], 2, 0.05) && near(b10.hi[1] - bs.hi[1], 2, 0.05),
    [bs.lo[0] - b10.lo[0], b10.hi[0] - bs.hi[0], bs.lo[1] - b10.lo[1], b10.hi[1] - bs.hi[1]].map(v => v.toFixed(4)).join(' / '));
  let lo12 = Infinity, hi12 = 0;
  for (const p of samples(OUT10, 0.25)) { const d = distToOutline(p, STAR_OUT); lo12 = Math.min(lo12, d); hi12 = Math.max(hi12, d); }
  check('...the result\'s outline, sampled along its edges, 2 ± 0.05 mm from the star\'s', lo12 >= 1.95 && hi12 <= 2.05, lo12.toFixed(4) + ' .. ' + hi12.toFixed(4) + ' mm');
  const v10 = validate(R10);
  check('the canonical checker: closed, manifold, no piercing, one shell', v10.clean && v10.euler_characteristic === 2, v10.summary);
  check('the star is still untouched', same(await raw(page, sid), STAR_SRC) && same(await placedXZ(page, sid), STAR_XZ));
  await shot(page, '7-star-grow-2');
  await ctrlZ(page);
  check('Ctrl+Z puts the plate back', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq);

  await typeField(page, '#crop-piece-grow', 0);
  await page.click('#btn-crop-keep-out');
  const s11 = await crop(page);
  check('Keep outside: done - a plate with a star-shaped hole', /^Crop done - kept outside the outline/.test(s11), s11);
  const R11 = await raw(page, qid), v11 = validate(R11);
  check('...closed, manifold, genus 1, volume = plate - star prism (within 0.05%)', v11.clean && v11.euler_characteristic === 0 &&
    near(v11.volume, 100 * 100 * 3 - starArea * 3, starArea * 3 * 5e-4), v11.summary);
  await page.evaluate(() => { const h = state.cropShapeHelper; if (h) h.visible = false; });
  await page.evaluate(([sid, x, z]) => { const p = state.placed.find(q => q.sourceId === sid); p.mesh.visible = false; }, [sid]);
  await shot(page, '8-star-keep-outside');
  await page.evaluate(sid => { state.placed.find(q => q.sourceId === sid).mesh.visible = true; }, sid);
  await ctrlZ(page);
  check('Ctrl+Z puts the plate back', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq);

  // The star slid right off the plate.
  await page.evaluate(([sid, x, z]) => { const p = state.placed.find(q => q.sourceId === sid); applyPlacedXZ(p, x, z); NSO_cropSyncUI(); }, [sid, qc[0] + 120, qc[1]]);
  const s12 = await crop(page);
  check('the star off the plate: refused in words - the outline misses the piece', /^Crop refused - piece unchanged \(the outline misses the piece/.test(s12), s12);
  await page.evaluate(([sid, x, z]) => { const p = state.placed.find(q => q.sourceId === sid); applyPlacedXZ(p, x, z); NSO_cropSyncUI(); }, [sid, qc[0], qc[1]]);
  await typeField(page, '#crop-piece-grow', -30);
  const s13 = await crop(page);
  check('Grow -30: refused in words - it shrinks the outline to nothing', /^Crop refused - piece unchanged \(Grow -30\.00 mm shrinks the outline to nothing/.test(s13), s13);
  check('...nothing changed, no Undo step, the star untouched', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq &&
    same(await raw(page, sid), STAR_SRC));

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /\[error\]/.test(l) && /crop/i.test(l));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
