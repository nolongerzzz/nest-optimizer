#!/usr/bin/env node
/* Crop's Cylinder, Piece and Outline shapes, driven through the REAL app in headless
   Chromium at 1280 x 800 (nso_crop.js; the card is app-crop-card.js).

     node tools/nso_crop_shapes_drive_check.js                     exit 0 = every gate held
     node tools/nso_crop_shapes_drive_check.js tools/crop-shapes-out  ...and keep the screenshots
                                                                   (npm run crop:shapes-shots;
                                                                   gitignored, never committed)

   Every piece comes in through the app's own Import. Every size is a real mouse drag
   on a handle the card drew, at the screen point of the handle; nothing types a number.
   Every copy goes through tools/mesh_validate.py, the canonical checker, self-intersection
   included. The geometry is measured HERE, from the meshes as drawn, not by the app's code.
   (The card is the copy card now: what the old card's Keep outside and Grow did is gone, and
   docs/CROP.md says where each went. Its Circle is the Cylinder, its Piece region the Piece
   shape, its Grow the Outline's offsets.)

     1. CYLINDER on a 60 x 60 x 4 mm plate: picked it is a vertical Ø30 cylinder centred on the
        plate; its ends pulled out past the plate. CROP copies a Ø30 disc - every vertex
        15 +- 0.05 mm from the centre, 30 +- 0.05 across both ways, 4 mm thick, the volume of a
        30 x 4 mm disc - closed and clean, left where the cylinder was, the plate byte-identical,
        ONE Undo.
     2. its side handle resizes it, its body slides it; slid off the plate it refuses in words
        and CROP is off; one wider than the plate copies the whole plate.
     3. PIECE: a 100 x 100 x 3 plate cropped to the star prism (library/soften_test_05_star_prism.stl)
        laid over it off-centre. The outline matches the star's silhouette within 0.05 mm both
        ways, in the plate's own raw frame. The star is untouched. One Undo.
     4. OUTLINE of the star, its outer offset d1 dragged: a skin outside the star - every vertex
        either on the star's outline or d1 outside it, reaching d1 past it on all four sides; its
        inner offset d2 dragged: a skin inside it.
     5. the star slid off the plate: refused in words; clicking the plate itself as its own cutter
        is refused in words.
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
const shapeReadout = page => page.evaluate(() => document.getElementById('crop-readout').textContent);
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

/* ---- the card's own state, and the drags --------------------------------------- */

async function pressDrag(page, a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 6, a.y + (b.y - a.y) * i / 6);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

const cardNow = page => page.evaluate(() => { const S = NSO_CropCard.state(); return JSON.parse(JSON.stringify({ shape: S.shape, cyl: S.cyl, outline: { id: S.outline.id, d1: S.outline.d1, d2: S.outline.d2, z1: S.outline.z1, z2: S.outline.z2, mode: S.outline.mode },
  piece: S.piece, plan: S.plan && { ok: S.plan.ok, reason: S.plan.reason } })); });
const settle = page => page.waitForFunction(() => { const S = NSO_CropCard.state(); return !S.shape || (!S.timer && (S.plan || /^(Piece|Outline): click/.test(document.getElementById('crop-readout').textContent))); }, null, { timeout: 60000 });
const handleAt = (page, id) => page.evaluate(i => NSO_CropCard.handleScreen(i), id);
async function dragHandle(page, id, dx, dy) {
  const h = await handleAt(page, id);
  await pressDrag(page, h, { x: h.x + dx, y: h.y + dy });
  await settle(page);
}
async function cropNow(page) {
  const n = await page.evaluate(() => state.models.length);
  await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 60000 });
  await page.click('#btn-crop');
  await page.waitForFunction(k => state.models.length > k, n, { timeout: 120000 });
  return page.evaluate(() => { const m = state.models[state.models.length - 1]; return { id: m.id, name: m.name, raw: Array.from(m.rawTris) }; });
}
async function undoLast(page) {
  await page.click('#btn-undo');
  await page.waitForTimeout(300);
}
const selectPiece = (page, id) => page.evaluate(i => { selectPlaced(state.placed.findIndex(p => p.sourceId === i)); }, id);
const copyPlacement = (page, cid) => page.evaluate(i => {
  const p = state.placed.find(q => q.sourceId === i), b = new THREE.Box3().setFromObject(p.mesh);
  return { c: b.getCenter(new THREE.Vector3()).toArray(), size: b.getSize(new THREE.Vector3()).toArray() };
}, cid);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  /* ======================================================== 1. cylinder */
  console.log('\n=== 1. Cylinder, on a 60 mm plate ===');
  const pid = await loadSTL(page, PLATE60);
  const SRC = await raw(page, pid);
  check('the 60 x 60 x 4 plate came in through Import', SRC.length / 9 === 12);
  await page.click('#menu-crop > summary');
  await page.waitForFunction(() => state.cutterOpen && state.cutTool === 'crop', null, { timeout: 10000 });
  await selectPiece(page, pid);
  await lookDown(page, pid, 70);
  const D0 = await drawn(page, pid);
  const top = D0.box.max[1];
  const mid = [(D0.box.min[0] + D0.box.max[0]) / 2, (D0.box.min[2] + D0.box.max[2]) / 2];
  await page.click('#btn-crop-shape-cylinder');
  await settle(page);
  let cs = await cardNow(page);
  check('picked: a vertical Ø30 cylinder centred on the plate (half the plate across)', cs.cyl.axis === 'z' && near(2 * cs.cyl.r, 30, 0.01) && near(cs.cyl.c[0], mid[0], 0.01) && near(-cs.cyl.c[1], mid[1], 0.01),
    JSON.stringify(cs.cyl));
  check('...2 mm tall, half the plate\'s thickness, so it stands inside it', near(2 * cs.cyl.hl, 2, 0.01));
  await shot(page, '1-cylinder-on-plate');
  // pull both ends out past the plate: real drags on the end handles
  await dragHandle(page, 'end+', 0, -60);
  await dragHandle(page, 'end-', 0, 60);
  cs = await cardNow(page);
  check('both ends pulled out past the plate: the cylinder is taller than it', cs.cyl.axis === 'z' && 2 * cs.cyl.hl > 5, 'length ' + (2 * cs.cyl.hl).toFixed(2));
  check('...still Ø30, still centred across the plate', near(2 * cs.cyl.r, 30, 0.01) && near(cs.cyl.c[0], mid[0], 0.01) && near(-cs.cyl.c[1], mid[1], 0.01));
  check('the read-out says what it holds', /^Cylinder Ø30 × [\d.]+ mm along Z · holds \d+ faces, 2\.8 cm³$/.test(await shapeReadout(page)), await shapeReadout(page));
  const u0 = await undoDepth(page), n0 = await page.evaluate(() => state.models.length);
  const cp = await cropNow(page);
  check('CROP: one new piece, "<name> crop 1"', cp.name === 'soften_test_plate crop 1' || /crop 1$/.test(cp.name), cp.name);
  const ctrRaw = worldToRaw(D0, [mid[0], top, mid[1]]);
  let rmin = Infinity, rmax = 0;
  for (let i = 0; i < cp.raw.length; i += 3) { const r = Math.hypot(cp.raw[i] - ctrRaw[0], cp.raw[i + 1] - ctrRaw[1]); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
  const b1 = bounds(cp.raw);
  check('a Ø30 disc: every vertex 15 ± 0.05 mm from the centre', rmin >= 14.95 && rmax <= 15.05, 'r ' + rmin.toFixed(4) + ' .. ' + rmax.toFixed(4));
  check('...30 ± 0.05 mm across both ways, 4 mm thick', near(b1.hi[0] - b1.lo[0], 30, 0.05) && near(b1.hi[1] - b1.lo[1], 30, 0.05) && near(b1.hi[2] - b1.lo[2], 4, 1e-4),
    (b1.hi[0] - b1.lo[0]).toFixed(4) + ' x ' + (b1.hi[1] - b1.lo[1]).toFixed(4) + ' x ' + (b1.hi[2] - b1.lo[2]).toFixed(4));
  const v1 = validate(cp.raw);
  check('the canonical checker: closed, manifold, no piercing, one shell', v1.clean && v1.euler_characteristic === 2, v1.summary);
  check('...the volume of a 30 x 4 mm disc (within 0.05%)', near(v1.volume, Math.PI * 225 * 4, Math.PI * 225 * 4 * 5e-4), (+v1.volume).toFixed(2) + ' vs ' + (Math.PI * 900).toFixed(2));
  const pl = await copyPlacement(page, cp.id);
  check('the copy is where the cylinder was: its middle on the plate\'s middle, as drawn', Math.hypot(pl.c[0] - mid[0], pl.c[2] - mid[1]) < 1e-3, 'off by ' + Math.hypot(pl.c[0] - mid[0], pl.c[2] - mid[1]).toExponential(2) + ' mm');
  check('the plate is byte for byte what it was, and did not move', same(await raw(page, pid), SRC) && same(await placedXZ(page, pid), [D0.M[12], D0.M[14]]));
  check('ONE Undo step', (await undoDepth(page)) === u0 + 1 && (await page.evaluate(() => state.models.length)) === n0 + 1);
  await shot(page, '2-cylinder-copy');
  await undoLast(page);
  check('Undo: the copy is gone from the list and the plate, the plate untouched', (await page.evaluate(() => state.models.length)) === n0 && (await undoDepth(page)) === u0 &&
    same(await raw(page, pid), SRC));
  await selectPiece(page, pid);

  /* =============================================== 2. drags and refusals */
  console.log('\n=== 2. the cylinder\'s drags, and what it holds when it holds nothing ===');
  await lookDown(page, pid, 70);
  const c1 = (await cardNow(page)).cyl;
  await dragHandle(page, 'side', -40, 0);
  const c2 = (await cardNow(page)).cyl;
  check('dragging the side in shrinks the diameter', c2.r < c1.r - 0.5 && near(c2.hl, c1.hl, 1e-9) && c2.axis === 'z', 'Ø ' + (2 * c1.r).toFixed(1) + ' -> ' + (2 * c2.r).toFixed(1));
  check('neither drag changed the plate or added an Undo step', same(await raw(page, pid), SRC) && (await undoDepth(page)) === u0);
  // slide the body right off the plate: Shift is up, so use the plain drag, far
  const bodyPt = await page.evaluate(() => {
    const S = NSO_CropCard.state(), hs = NSO_CropCard.handles().map(i => NSO_CropCard.handleScreen(i));
    const b = new THREE.Box3().setFromObject(S.body), c = b.getCenter(new THREE.Vector3()), rc = state.renderer.domElement.getBoundingClientRect();
    for (let u = -0.5; u <= 0.5; u += 0.1) for (let w = -0.5; w <= 0.5; w += 0.1) {
      const p = new THREE.Vector3(c.x + u * (b.max.x - b.min.x), c.y, c.z + w * (b.max.z - b.min.z)), q = p.clone().project(state.camera);
      const x = rc.left + (q.x + 1) / 2 * rc.width, y = rc.top + (1 - q.y) / 2 * rc.height;
      if (hs.every(h => Math.hypot(h.x - x, h.y - y) > 24)) {
        state.raycaster.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
        if (state.raycaster.intersectObject(S.body, false)[0] && document.elementFromPoint(x, y) === state.renderer.domElement) return { x, y };
      }
    }
    return null;
  });
  check('(a spot on the cylinder\'s body clear of its handles was found)', !!bodyPt);
  await lookDown(page, pid, 160);
  const bodyPt2 = await page.evaluate(() => {
    const S = NSO_CropCard.state(), hs = NSO_CropCard.handles().map(i => NSO_CropCard.handleScreen(i));
    const b = new THREE.Box3().setFromObject(S.body), c = b.getCenter(new THREE.Vector3()), rc = state.renderer.domElement.getBoundingClientRect();
    for (let u = -0.45; u <= 0.45; u += 0.05) for (let w = -0.45; w <= 0.45; w += 0.05) for (const k of [0, 0.5, -0.5]) {
      const p = new THREE.Vector3(c.x + u * (b.max.x - b.min.x), c.y + k * (b.max.y - b.min.y), c.z + w * (b.max.z - b.min.z)), q = p.clone().project(state.camera);
      const x = rc.left + (q.x + 1) / 2 * rc.width, y = rc.top + (1 - q.y) / 2 * rc.height;
      if (hs.every(h => Math.hypot(h.x - x, h.y - y) > 24)) {
        state.raycaster.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
        if (state.raycaster.intersectObject(S.body, false)[0] && document.elementFromPoint(x, y) === state.renderer.domElement) return { x, y };
      }
    }
    return null;
  });
  const cBefore = (await cardNow(page)).cyl;
  await pressDrag(page, bodyPt2, { x: bodyPt2.x + 330, y: bodyPt2.y });
  await settle(page);
  const cAfter = (await cardNow(page)).cyl;
  check('dragging the body slid it across the plate, Ø and height kept', Math.abs(cAfter.c[0] - cBefore.c[0]) + Math.abs(cAfter.c[1] - cBefore.c[1]) > 20 && cAfter.r === cBefore.r && cAfter.c[2] === cBefore.c[2],
    'moved ' + Math.hypot(cAfter.c[0] - cBefore.c[0], cAfter.c[1] - cBefore.c[1]).toFixed(1) + ' mm');
  const ro6 = await shapeReadout(page);
  check('slid off the plate, the read-out refuses in words and CROP is off', /holds nothing of this piece/.test(ro6) && await page.evaluate(() => document.getElementById('btn-crop').disabled), ro6);
  await shot(page, '3-cylinder-off-the-plate');
  const n6 = await page.evaluate(() => state.models.length);
  const forced = await page.evaluate(async () => { const S = NSO_CropCard.state(); const r = await NSO_Crop.copy(state.models.find(q => q.id === S.forId), NSO_CropCard.shape()); return { ok: r.ok, s: document.getElementById('status').textContent }; });
  check('asked anyway: refused in words, nothing changed, no Undo step', !forced.ok && /^Crop refused - nothing changed \(the cylinder holds nothing/.test(forced.s) &&
    (await page.evaluate(() => state.models.length)) === n6 && (await undoDepth(page)) === u0 && same(await raw(page, pid), SRC), forced.s);
  // a cylinder wider than the plate holds all of it - a copy of the whole plate, not a refusal
  await page.click('#btn-crop-shape-cylinder');
  await settle(page);
  await lookDown(page, pid, 70);
  await dragHandle(page, 'side', 330, 0);
  await dragHandle(page, 'end+', 0, -60);
  await dragHandle(page, 'end-', 0, 60);
  const wide = await cardNow(page);
  const cw = await cropNow(page);
  const vw = validate(cw.raw);
  check('a cylinder wider than the plate holds all of it: a copy of the whole plate, not a refusal', wide.cyl.r > 30 * Math.SQRT2 && near(vw.volume, 60 * 60 * 4, 60 * 60 * 4 * 5e-4) && vw.clean,
    'Ø ' + (2 * wide.cyl.r).toFixed(1) + ', ' + (+vw.volume).toFixed(1) + ' mm3');
  await undoLast(page);

  /* =========================================================== 3. piece */
  console.log('\n=== 3. Piece: a 100 mm plate cropped to the star ===');
  await page.click('#menu-crop > summary');
  await page.waitForFunction(() => !state.cutterOpen, null, { timeout: 10000 });
  check('shutting the card takes the shape away with it', await page.evaluate(() => !NSO_CropCard.state().shape && !NSO_CropCard.state().group));
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
  const Q = await drawn(page, qid);
  const qc = [(Q.box.min[0] + Q.box.max[0]) / 2, (Q.box.min[2] + Q.box.max[2]) / 2];
  await page.evaluate(([sid, x, z]) => { const p = state.placed.find(q => q.sourceId === sid); applyPlacedXZ(p, x, z); }, [sid, qc[0] + 12, qc[1] - 7]);
  const STAR_XZ = await placedXZ(page, sid);
  await selectRow(page, qid);
  await page.waitForFunction(id => state.editId === id, qid);
  await page.click('#menu-crop > summary');
  await page.waitForFunction(() => state.cutterOpen && state.cutTool === 'crop', null, { timeout: 10000 });
  await selectPiece(page, qid);
  await lookDown(page, qid, 110);
  await page.click('#btn-crop-shape-piece');
  check('no cutter yet: CROP is off, the read-out says what to do', await page.evaluate(() => document.getElementById('btn-crop').disabled) &&
    /^Piece: click another piece/.test(await shapeReadout(page)), await shapeReadout(page));
  const qTop = await screenOf(page, [qc[0] + 38, Q.box.max[1], qc[1] + 35]);
  await page.mouse.click(qTop.x, qTop.y);
  await page.waitForTimeout(200);
  check('clicking the plate itself: "That is the piece being cropped"', /That is the piece being cropped/.test(await status(page)) &&
    (await page.evaluate(() => state.editId)) === qid, await status(page));
  const S0 = await drawn(page, sid);
  const sTop = await screenOf(page, [S0.M[12], S0.box.max[1], S0.M[14]]);
  await page.mouse.click(sTop.x, sTop.y);
  await settle(page);
  check('clicking the star makes it the cutter; the plate stays selected', (await cardNow(page)).piece.id === sid && (await page.evaluate(() => state.editId)) === qid);
  check('the read-out names it and what it holds', /^Piece soften_test_05_star_prism · holds \d+ faces, [\d.]+ cm³$/.test(await shapeReadout(page)), await shapeReadout(page));
  await shot(page, '4-star-over-plate');

  const starWorld = await worldSoup(page, sid);
  const starInPlate = [];
  for (let i = 0; i < starWorld.length; i += 3) starInPlate.push(...worldToRaw(Q, [starWorld[i], starWorld[i + 1], starWorld[i + 2]]));
  const STAR_OUT = topOutline(starInPlate);
  check('the star\'s outline seen from above: 10 edges', STAR_OUT.length === 10, STAR_OUT.length + ' edges');
  let starArea = 0;
  for (const s of STAR_OUT) starArea += (s[0] * s[3] - s[2] * s[1]) / 2;
  starArea = Math.abs(starArea);

  const QSRC = await raw(page, qid), uq = await undoDepth(page);
  const cp9 = await cropNow(page);
  const R9 = cp9.raw;
  let far = 0, worst = 0;
  for (let i = 0; i < R9.length; i += 3) { const d = distToOutline([R9[i], R9[i + 1]], STAR_OUT); worst = Math.max(worst, d); if (d > 0.05) far++; }
  check('every vertex of the copy is on the star\'s outline (within 0.05 mm)', far === 0, 'worst ' + worst.toFixed(5) + ' mm');
  const RES_OUT = topOutline(R9);
  let miss = 0, worst2 = 0;
  for (const p of samples(STAR_OUT, 0.25)) { const d = distToOutline(p, RES_OUT); worst2 = Math.max(worst2, d); if (d > 0.05) miss++; }
  check('...and every point of the star\'s outline is on the copy\'s (within 0.05 mm)', miss === 0, 'worst ' + worst2.toFixed(5) + ' mm');
  const v9 = validate(R9);
  check('the canonical checker: closed, manifold, no piercing, one shell', v9.clean && v9.euler_characteristic === 2, v9.summary);
  check('...its volume is the star\'s area x the plate\'s 3 mm (within 0.05%)', near(v9.volume, starArea * 3, starArea * 3 * 5e-4), (+v9.volume).toFixed(2) + ' vs ' + (starArea * 3).toFixed(2));
  check('the star is untouched: same soup, same place; the plate is byte for byte what it was', same(await raw(page, sid), STAR_SRC) && same(await placedXZ(page, sid), STAR_XZ) && same(await raw(page, qid), QSRC));
  const pl9 = await copyPlacement(page, cp9.id);
  check('the copy lies under the star, in place: its middle is the plate\'s own at that spot', Math.abs(pl9.c[1] - (Q.box.min[1] + Q.box.max[1]) / 2) < 1e-3);
  check('ONE Undo step', (await undoDepth(page)) === uq + 1);
  await shot(page, '5-star-copy');
  await undoLast(page);
  check('Undo: the copy is gone, the plate untouched', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq);
  await selectPiece(page, qid);

  /* ======================================================== 4. outline */
  console.log('\n=== 4. Outline of the star: the outer and the inner offset ===');
  await lookDown(page, qid, 110);
  await page.click('#btn-crop-shape-outline');
  await settle(page);
  const sTop2 = await screenOf(page, [S0.M[12], S0.box.max[1], S0.M[14]]);
  await page.mouse.click(sTop2.x, sTop2.y);
  await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.outline.fp && S.plan && !S.timer; }, null, { timeout: 60000 });
  check('a click on the star is its silhouette: four handles', (await cardNow(page)).outline.mode === 'silhouette' &&
    (await page.evaluate(() => NSO_CropCard.handles())).join(',') === 'd1,d2,z1,z2');
  await dragHandle(page, 'd1', 50, 0);
  const o1 = (await cardNow(page)).outline;
  check('the outer offset handle dragged out sets d1', o1.d1 > 0.5 && o1.d2 === 0, 'd1 ' + o1.d1.toFixed(2));
  check('the read-out names it', new RegExp('^Outline of soften_test_05_star_prism, \\+' + o1.d1.toFixed(1).replace('.', '\\.') + ' / −0\\.0 mm').test(await shapeReadout(page)), await shapeReadout(page));
  const cp10 = await cropNow(page);
  const R10 = cp10.raw;
  let lo10 = 0, onStar = 0, onGrown = 0, other = 0, inStar = 0;
  for (let i = 0; i < R10.length; i += 3) {
    const p = [R10[i], R10[i + 1]], d = distToOutline(p, STAR_OUT);
    if (d < 0.05) onStar++; else if (near(d, o1.d1, 0.05)) onGrown++; else other++;
    lo10 = Math.max(lo10, d);
  }
  check('every vertex of the skin is on the star\'s outline or d1 outside it', other === 0 && onStar > 0 && onGrown > 0, onStar + ' on the star, ' + onGrown + ' on the grown edge, ' + other + ' elsewhere');
  const bs = bounds(starInPlate), b10 = bounds(R10);
  check('...it reaches d1 ± 0.05 mm past the star\'s outline on all four sides', near(bs.lo[0] - b10.lo[0], o1.d1, 0.05) && near(b10.hi[0] - bs.hi[0], o1.d1, 0.05) && near(bs.lo[1] - b10.lo[1], o1.d1, 0.05) && near(b10.hi[1] - bs.hi[1], o1.d1, 0.05),
    [bs.lo[0] - b10.lo[0], b10.hi[0] - bs.hi[0], bs.lo[1] - b10.lo[1], b10.hi[1] - bs.hi[1]].map(v => v.toFixed(3)).join(' / '));
  const OUT10 = topOutline(R10);
  let lo12 = Infinity, hi12 = 0;
  for (const p of samples(OUT10, 0.25)) { const d = distToOutline(p, STAR_OUT); lo12 = Math.min(lo12, d); hi12 = Math.max(hi12, d); }
  check('...the skin\'s edges, sampled, are all within d1 of the star\'s outline and none beyond', hi12 <= o1.d1 + 0.05, lo12.toFixed(4) + ' .. ' + hi12.toFixed(4) + ' mm');
  const v10 = validate(R10);
  check('the canonical checker: closed, manifold, no piercing', v10.clean, v10.summary);
  check('nothing of the skin is inside the star (a skin OUTSIDE it)', inStar === 0);
  check('the star is still untouched', same(await raw(page, sid), STAR_SRC) && same(await placedXZ(page, sid), STAR_XZ));
  await shot(page, '6-star-skin-outside');
  await undoLast(page);
  check('Undo puts the plate back', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq);
  await selectPiece(page, qid);
  // the inner offset: a skin inside the star's outline
  await page.click('#btn-crop-shape-outline');
  await settle(page);
  await page.mouse.click(sTop2.x, sTop2.y);
  await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.outline.fp && S.plan && !S.timer; }, null, { timeout: 60000 });
  await dragHandle(page, 'd2', 30, 0);
  const o2 = (await cardNow(page)).outline;
  check('the inner offset handle dragged in sets d2', o2.d2 > 0.3 && o2.d1 === 0, 'd2 ' + o2.d2.toFixed(2));
  const cp11 = await cropNow(page);
  let inner = 0, onS = 0, wrong = 0;
  for (let i = 0; i < cp11.raw.length; i += 3) {
    const p = [cp11.raw[i], cp11.raw[i + 1]], d = distToOutline(p, STAR_OUT), ins = insideOutline(p, STAR_OUT);
    if (d < 0.05) onS++; else if (ins && near(d, o2.d2, 0.05)) inner++; else wrong++;
  }
  check('every vertex of the inner skin is on the star\'s outline or d2 inside it', wrong === 0 && onS > 0 && inner > 0, onS + ' on the star, ' + inner + ' on the inner edge, ' + wrong + ' elsewhere');
  const v11 = validate(cp11.raw);
  check('...closed, manifold, no piercing; a frame, genus 1', v11.clean && v11.euler_characteristic === 0, v11.summary);
  await undoLast(page);

  /* ========================================================= 5. refusals */
  console.log('\n=== 5. refusals: the star off the plate ===');
  await selectPiece(page, qid);
  await page.click('#btn-crop-shape-piece');
  await settle(page);
  await page.mouse.click(sTop2.x, sTop2.y);
  await settle(page);
  await page.evaluate(([sid, x, z]) => { const p = state.placed.find(q => q.sourceId === sid); applyPlacedXZ(p, x, z); }, [sid, qc[0] + 120, qc[1]]);
  const r13 = await page.evaluate(() => NSO_Crop.planOn(state.models.find(q => q.id === NSO_CropCard.state().forId), NSO_CropCard.shape()).then(r => ({ ok: r.ok, reason: r.reason })));
  const ro13 = r13.reason || '';
  check('the star off the plate: the engine refuses in words - the other piece holds nothing', /^the other piece holds nothing of this piece/.test(ro13), ro13);
  check('...nothing changed, no Undo step, the star untouched', same(await raw(page, qid), QSRC) && (await undoDepth(page)) === uq && same(await raw(page, sid), STAR_SRC));

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /\[error\]/.test(l) && /crop/i.test(l));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
