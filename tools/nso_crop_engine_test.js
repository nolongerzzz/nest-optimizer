#!/usr/bin/env node
/* Crop's copy engine (nso_crop.js): copy what a shape holds out of a piece.
     node tools/nso_crop_engine_test.js        exit 0 = every gate held

   The engine is the shipped file, run in a vm context beside the shipped
   boolean-kernel adapter (tools/nso_csg_node.js), the way nso_crop_move_test.js
   runs app-crop.js. Section 8 then drives the same file in the real app.

   HOW A VOLUME IS CHECKED. Never by the kernel that made it. The oracle here
   (rayVolume) is a different method on different geometry: it fires vertical
   rays through a grid, finds where each enters and leaves the piece's mesh
   (even-odd, so no winding is trusted), and measures how much of that is
   inside the shape's z-interval - for the IDEAL shape, a true circle or
   sphere, not the kernel's polygon of it. A copy must land within 0.5% of it.
   Exact identities back it where they exist: a piece cut into two copies and
   added back is the piece, a skin and its core are the piece, a shape round the
   whole piece is the piece to the last bit of float32.

     1. box, cylinder (all three axes) and sphere crops of the hinge and a
        stock tube: closed, no slivers, volume = the oracle within 0.5%,
        the original byte-identical afterwards, and the result passes the
        canonical checker (tools/mesh_validate.py), self-intersection included
     2. plan agrees with run, and builds nothing
     3. a posed piece (toRaw): shapes are placed where the piece is SEEN
     4. Piece crop: another piece is the cutter
     5. Outline crop: a tube's rim at offsets (0, 0.8) is the wall ring; the
        bore's rim is the other way round; the hinge's silhouette gives its skin
        both ways (inside it, and outside it on a plate)
     6. the rim finder on its own
     7. refusals, in words, and nothing changed
     8. the real app: "<name> crop N" on the plate, in place, one Undo
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { csgContext } = require('./nso_csg_node.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const Stock = require('../nso_stock.js');

const ROOT = path.resolve(__dirname, '..');
const ctx = csgContext();
ctx.window = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'nso_crop.js'), 'utf8'), ctx, { filename: 'nso_crop.js' });
const C = ctx.NSO_Crop;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
const f3 = v => (+v).toFixed(3);
const pct = (a, b) => (100 * Math.abs(a - b) / Math.abs(b));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-crop-engine-'));
let seq = 0;

/* ---- fixtures ------------------------------------------------------------- */

const HINGE = readSTL(path.join(ROOT, 'library', 'hinge_knuckle_box.stl'));       // 18 x 8 x 8, five knuckles
const TUBE_R = 12, TUBE_RI = 8, TUBE_H = 20, TUBE_SEG = 96;
const TUBE = Stock.revolve(Stock.profileTube(TUBE_R, TUBE_RI, TUBE_H), TUBE_SEG);  // a stock tube on the plate, axis z

function boxSoup(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}

const bytes = soup => Buffer.from(soup.buffer, soup.byteOffset, soup.byteLength).toString('base64');

/* A piece's soup in P, given the P -> raw map as rotation about z by `deg`
   then a translation: raw = Rz(deg) P + t. Written out here, not the engine's. */
function toRawOf(deg, t) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}
function rawToP(raw, deg, t) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    const x = raw[i] - t[0], y = raw[i + 1] - t[1];
    out[i] = c * x + s * y; out[i + 1] = -s * x + c * y; out[i + 2] = raw[i + 2] - t[2];
  }
  return out;
}

/* ---- the oracle: vertical rays through the piece, against the ideal shape --- */

function caster(soup) {
  const cell = 1, grid = new Map(), T = [];
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const ax = soup[o], ay = soup[o + 1], az = soup[o + 2], bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5],
          cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
    const det = (by - ay) * (cx - ax) - (bx - ax) * (cy - ay);
    if (Math.abs(det) < 1e-12) continue;                       // a wall: a vertical ray never crosses it
    const t = { ax, ay, az, bx, by, bz, cx, cy, cz, det };
    const i = T.length; T.push(t);
    for (let gx = Math.floor(Math.min(ax, bx, cx) / cell); gx <= Math.floor(Math.max(ax, bx, cx) / cell); gx++) {
      for (let gy = Math.floor(Math.min(ay, by, cy) / cell); gy <= Math.floor(Math.max(ay, by, cy) / cell); gy++) {
        const k = gx + ',' + gy;
        let l = grid.get(k);
        if (!l) { l = []; grid.set(k, l); }
        l.push(i);
      }
    }
  }
  return function (x, y) {
    const l = grid.get(Math.floor(x / cell) + ',' + Math.floor(y / cell));
    if (!l) return [];
    const zs = [];
    for (const i of l) {
      const t = T[i];
      const u = ((y - t.ay) * (t.cx - t.ax) - (x - t.ax) * (t.cy - t.ay)) / t.det;     // weight of b
      const v = ((t.by - t.ay) * (x - t.ax) - (t.bx - t.ax) * (y - t.ay)) / t.det;     // weight of c
      if (u > 0 && v > 0 && u + v < 1) zs.push(t.az + u * (t.bz - t.az) + v * (t.cz - t.az));
    }
    zs.sort((a, b) => a - b);
    const iv = [];
    for (let k = 0; k + 1 < zs.length; k += 2) iv.push([zs[k], zs[k + 1]]);
    return iv;
  };
}

function overlap(A, B) {
  let s = 0;
  for (const a of A) for (const b of B) s += Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  return s;
}

/* The ideal shape as a function (x, y) -> z-intervals, in P, and its xy box. */
function shapeFn(sh) {
  const yaw = (sh.yaw || 0) * Math.PI / 180, cs = Math.cos(yaw), sn = Math.sin(yaw);
  const local = (x, y) => { const dx = x - sh.c[0], dy = y - sh.c[1]; return [cs * dx + sn * dy, -sn * dx + cs * dy]; };
  if (sh.kind === 'box') {
    const R = Math.hypot(sh.h[0], sh.h[1]);
    return { lo: [sh.c[0] - R, sh.c[1] - R], hi: [sh.c[0] + R, sh.c[1] + R], fn: (x, y) => {
      const [u, v] = local(x, y);
      return Math.abs(u) <= sh.h[0] && Math.abs(v) <= sh.h[1] ? [[sh.c[2] - sh.h[2], sh.c[2] + sh.h[2]]] : [];
    } };
  }
  if (sh.kind === 'sphere') {
    return { lo: [sh.c[0] - sh.r, sh.c[1] - sh.r], hi: [sh.c[0] + sh.r, sh.c[1] + sh.r], fn: (x, y) => {
      const d2 = (x - sh.c[0]) ** 2 + (y - sh.c[1]) ** 2;
      if (d2 >= sh.r * sh.r) return [];
      const w = Math.sqrt(sh.r * sh.r - d2);
      return [[sh.c[2] - w, sh.c[2] + w]];
    } };
  }
  const axis = sh.axis || 'z', R = Math.hypot(sh.r, sh.hl);
  return { lo: [sh.c[0] - R, sh.c[1] - R], hi: [sh.c[0] + R, sh.c[1] + R], fn: (x, y) => {
    const [u, v] = local(x, y);
    if (axis === 'z') return u * u + v * v <= sh.r * sh.r ? [[sh.c[2] - sh.hl, sh.c[2] + sh.hl]] : [];
    const along = axis === 'x' ? u : v, across = axis === 'x' ? v : u;
    if (Math.abs(along) > sh.hl || Math.abs(across) >= sh.r) return [];
    const w = Math.sqrt(sh.r * sh.r - across * across);
    return [[sh.c[2] - w, sh.c[2] + w]];
  } };
}

/* Volume of (piece soup in P) inside `cutter` = { lo, hi, fn }, by a grid of rays. The
   grid is offset by an amount no mesh coordinate here is a multiple of, so no
   ray runs along an edge. */
function rayVolume(soupP, cutter, step) {
  const cast = caster(soupP);
  const b = C.bounds(soupP);
  const x0 = Math.max(cutter.lo[0], b.lo[0]), x1 = Math.min(cutter.hi[0], b.hi[0]);
  const y0 = Math.max(cutter.lo[1], b.lo[1]), y1 = Math.min(cutter.hi[1], b.hi[1]);
  let v = 0;
  for (let x = x0 + step * 0.5 + 0.00312; x < x1; x += step) {
    for (let y = y0 + step * 0.5 + 0.00271; y < y1; y += step) {
      const A = cutter.fn(x, y);
      if (!A.length) continue;
      v += overlap(cast(x, y), A);
    }
  }
  return v * step * step;
}
const meshCutter = soupP => { const b = C.bounds(soupP), cast = caster(soupP); return { lo: [b.lo[0], b.lo[1]], hi: [b.hi[0], b.hi[1]], fn: cast }; };

/* ---- the canonical checker ------------------------------------------------- */

function validate(soup) {
  const f = path.join(TMP, 'r' + (seq++) + '.stl');
  writeSTL(f, soup);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'], { maxBuffer: 1 << 30 }).toString());
  const si = j.self_intersection || { pierce: 0, coplanar: 0 };
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic + ' pierce ' + si.pierce + ' coplanar ' + si.coplanar;
  j.clean = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
            j.degenerate_tris === 0 && si.pierce === 0 && si.coplanar === 0;
  return j;
}

/* One crop, every gate: closed, no slivers, original untouched, and (when an
   oracle is given) the volume within tol of it. Returns the result. */
async function crop(label, piece, shape, expect) {
  expect = expect || {};
  const before = bytes(piece.rawTris), beforeTo = piece.toRaw ? piece.toRaw.join(',') : '';
  const srcBefore = shape.source && shape.source.rawTris ? bytes(shape.source.rawTris) : null;
  const r = await C.run(piece, shape);
  check(label + ': made a copy', r.ok, r.ok ? r.faces + ' faces, ' + f3(r.volumeMm3) + ' mm3' : r.reason);
  if (!r.ok) return r;
  const cen = C.census(r.tris);
  check(label + ': closed manifold, no slivers', cen.open === 0 && cen.repeated === 0 && cen.degenerate === 0 && cen.slivers === 0 &&
    cen.welded.open === 0 && cen.welded.repeated === 0 && cen.welded.collapsed === 0,
    'open ' + cen.open + ' repeated ' + cen.repeated + ' degenerate ' + cen.degenerate + ' slivers ' + cen.slivers + ' (welded: open ' +
    cen.welded.open + ' repeated ' + cen.welded.repeated + ' collapsed ' + cen.welded.collapsed + '), ' + cen.edges + ' edges');
  check(label + ': the original is byte-identical afterwards',
    bytes(piece.rawTris) === before && (piece.toRaw ? piece.toRaw.join(',') : '') === beforeTo &&
    (srcBefore === null || bytes(shape.source.rawTris) === srcBefore));
  if (expect.volume != null) {
    const tol = expect.tol || 0.5;
    check(label + ': volume within ' + tol + '% of the oracle', pct(r.volumeMm3, expect.volume) <= tol,
      f3(r.volumeMm3) + ' vs ' + f3(expect.volume) + ' (' + f3(pct(r.volumeMm3, expect.volume)) + '%)');
  }
  if (expect.validate) {
    const j = validate(r.tris);
    check(label + ': tools/mesh_validate.py, self-intersection included', j.clean, j.summary);
  }
  return r;
}

(async () => {
  const hingeVol = C.volume(HINGE), tubeVol = C.volume(TUBE);
  const tubeP = { rawTris: TUBE }, hingeP = { rawTris: HINGE };
  console.log('\nfixtures: the hinge (library/hinge_knuckle_box.stl) ' + HINGE.length / 9 + ' tris ' + f3(hingeVol) +
    ' mm3, a stock tube R' + TUBE_R + ' r' + TUBE_RI + ' h' + TUBE_H + ' (' + TUBE_SEG + ' sides) ' + TUBE.length / 9 + ' tris ' + f3(tubeVol) + ' mm3');
  check('the fixtures are closed to begin with', C.census(HINGE).open === 0 && C.census(TUBE).open === 0);
  check('...and the oracle reads a piece it is given: the whole hinge, by rays, is its own volume',
    pct(rayVolume(HINGE, shapeFn({ kind: 'box', c: [9, 4, 4], h: [30, 30, 30] }), 0.02), hingeVol) < 0.3,
    f3(rayVolume(HINGE, shapeFn({ kind: 'box', c: [9, 4, 4], h: [30, 30, 30] }), 0.02)) + ' vs ' + f3(hingeVol));

  /* =========================================================================
     1. the shapes, on the hinge and the tube
     ========================================================================= */
  console.log('\n=== 1a. box crops ===');
  const boxes = [
    ['hinge, a slab through the middle', hingeP, HINGE, { kind: 'box', c: [9, 4, 4], h: [3, 5, 5] }, 0.02],
    ['hinge, a corner of it (cuts the bores)', hingeP, HINGE, { kind: 'box', c: [4.5, 6, 6], h: [3, 3.5, 3] }, 0.02],
    ['hinge, yawed 30 degrees across it', hingeP, HINGE, { kind: 'box', c: [9, 4, 4], h: [4, 2.5, 3.2], yaw: 30 }, 0.02],
    ['tube, a block off one wall', tubeP, TUBE, { kind: 'box', c: [9, 0, 10], h: [4, 5, 7] }, 0.02],
    ['tube, yawed 25 degrees across the wall', tubeP, TUBE, { kind: 'box', c: [0, 9, 8], h: [6, 3, 6], yaw: 25 }, 0.02]
  ];
  for (const [label, piece, soup, sh, step] of boxes) {
    await crop(label, piece, sh, { volume: rayVolume(soup, shapeFn(sh), step), validate: true });
  }
  // The identity that needs no oracle: two boxes that meet are the piece between them, added back.
  {
    const a = await C.run(hingeP, { kind: 'box', c: [4.5, 4, 4], h: [4.5, 5, 5] });
    const b = await C.run(hingeP, { kind: 'box', c: [13.5, 4, 4], h: [4.5, 5, 5] });
    check('hinge, cut in two at x = 9 and added back: exactly the hinge', a.ok && b.ok && near(a.volumeMm3 + b.volumeMm3, hingeVol, 1e-3),
      a.ok && b.ok ? f3(a.volumeMm3) + ' + ' + f3(b.volumeMm3) + ' = ' + f3(a.volumeMm3 + b.volumeMm3) + ' vs ' + f3(hingeVol) : '');
    const all = await crop('hinge, a box round all of it', hingeP, { kind: 'box', c: [9, 4, 4], h: [20, 20, 20] }, { volume: hingeVol, tol: 1e-4 });
    check('...is the hinge to the last triangle', all.ok && all.faces === HINGE.length / 9, all.ok ? all.faces + ' faces vs ' + HINGE.length / 9 : '');
  }

  console.log('\n=== 1b. cylinder crops, on all three axes ===');
  const cyls = [
    ['hinge, a vertical cylinder', hingeP, HINGE, { kind: 'cylinder', c: [6.3, 4, 4], r: 3.2, hl: 6 }, 0.015],
    ['hinge, along x, through the knuckles', hingeP, HINGE, { kind: 'cylinder', c: [9, 4, 4], r: 3.5, hl: 12, axis: 'x' }, 0.015],
    ['hinge, along y, short', hingeP, HINGE, { kind: 'cylinder', c: [10.8, 4, 4], r: 2.6, hl: 2.5, axis: 'y' }, 0.015],
    ['hinge, along x, yawed 20 degrees', hingeP, HINGE, { kind: 'cylinder', c: [9, 4, 4], r: 2.4, hl: 6, axis: 'x', yaw: 20 }, 0.015],
    ['tube, coaxial and inside the wall (r 10)', tubeP, TUBE, { kind: 'cylinder', c: [0, 0, 10], r: 10, hl: 6 }, 0.03],
    ['tube, across it along x, through both walls', tubeP, TUBE, { kind: 'cylinder', c: [0, 0, 10], r: 3, hl: 15, axis: 'x' }, 0.02],
    ['tube, along y, off the axis', tubeP, TUBE, { kind: 'cylinder', c: [3, 0, 8], r: 4, hl: 9, axis: 'y' }, 0.02]
  ];
  for (const [label, piece, soup, sh, step] of cyls) {
    await crop(label, piece, sh, { volume: rayVolume(soup, shapeFn(sh), step), validate: true });
  }
  // The coaxial cylinder has a closed form: pi (10^2 - 8^2) x height, the tube a polygon of 96 sides.
  {
    const r = await C.run(tubeP, { kind: 'cylinder', c: [0, 0, 10], r: 10, hl: 6 });
    const want = Math.PI * (100 - 64) * 12;
    check('tube, coaxial r 10 x 12 mm: pi (10^2 - 8^2) x 12 within 0.5%', r.ok && pct(r.volumeMm3, want) < 0.5,
      r.ok ? f3(r.volumeMm3) + ' vs ' + f3(want) : r.reason);
  }

  console.log('\n=== 1c. sphere crops ===');
  const sphs = [
    ['hinge, a sphere in the middle', hingeP, HINGE, { kind: 'sphere', c: [9, 4, 4], r: 4.4 }, 0.015],
    ['hinge, off one end', hingeP, HINGE, { kind: 'sphere', c: [2, 3, 5], r: 5 }, 0.015],
    ['tube, centred on its axis', tubeP, TUBE, { kind: 'sphere', c: [0, 0, 10], r: 9.5 }, 0.02],
    ['tube, off the axis, cutting wall and bore', tubeP, TUBE, { kind: 'sphere', c: [8, 4, 12], r: 6 }, 0.02]
  ];
  for (const [label, piece, soup, sh, step] of sphs) {
    await crop(label, piece, sh, { volume: rayVolume(soup, shapeFn(sh), step), validate: true });
  }
  {
    // Sphere on the tube's axis: V = integral over z of the annulus-and-disc overlap, a closed form in one variable.
    const R = 9.5, zc = 10, n = 4000;
    let want = 0;
    for (let i = 0; i < n; i++) {
      const z = (i + 0.5) / n * TUBE_H, d = z - zc;
      if (Math.abs(d) >= R) continue;
      const rho = Math.sqrt(R * R - d * d);
      want += Math.PI * (Math.min(rho, TUBE_R) ** 2 - Math.min(rho, TUBE_RI) ** 2) * (TUBE_H / n);
    }
    const r = await C.run(tubeP, { kind: 'sphere', c: [0, 0, 10], r: R });
    check('tube, sphere on its axis: the one-variable integral, within 0.5%', r.ok && pct(r.volumeMm3, want) < 0.5,
      r.ok ? f3(r.volumeMm3) + ' vs ' + f3(want) : r.reason);
  }

  /* =========================================================================
     2. plan
     ========================================================================= */
  console.log('\n=== 2. plan: the same answer, nothing built ===');
  {
    const sh = { kind: 'box', c: [9, 4, 4], h: [3, 5, 5] };
    const p = await C.plan(hingeP, sh), r = await C.run(hingeP, sh);
    check('plan answers { ok, faces, volumeMm3, bbox, text }', p.ok && isFinite(p.faces) && isFinite(p.volumeMm3) && p.bbox && p.bbox.lo && p.bbox.hi && typeof p.text === 'string',
      p.text);
    check('plan builds no mesh', p.tris === undefined && p.census === undefined);
    check('plan\'s faces are the copy\'s faces', p.faces === r.faces, p.faces + ' vs ' + r.faces);
    check('plan\'s volume is the copy\'s', pct(p.volumeMm3, r.volumeMm3) < 1e-4, f3(p.volumeMm3) + ' vs ' + f3(r.volumeMm3));
    check('plan\'s bbox is the copy\'s', [0, 1, 2].every(k => near(p.bbox.lo[k], r.bbox.lo[k], 1e-4) && near(p.bbox.hi[k], r.bbox.hi[k], 1e-4)),
      JSON.stringify(p.bbox.lo.map(f3)) + ' ' + JSON.stringify(p.bbox.hi.map(f3)));
    check('the copy is as big as the shape holds: x 6..12 (a 6 mm slab), y and z the hinge\'s',
      near(r.bbox.lo[0], 6, 1e-4) && near(r.bbox.hi[0], 12, 1e-4) && near(r.bbox.hi[1], 8, 1e-4) && near(r.bbox.hi[2], 8, 1e-4));
    const p2 = await C.plan(hingeP, { kind: 'box', c: [100, 0, 0], h: [1, 1, 1] });
    check('plan refuses what run refuses, in the same words', !p2.ok && /holds nothing/.test(p2.reason), p2.reason);
  }

  /* =========================================================================
     3. a posed piece
     ========================================================================= */
  console.log('\n=== 3. a posed piece: the shape is where the piece is seen ===');
  {
    const deg = 90, t = [30, -12, 5];
    const posed = { rawTris: HINGE, toRaw: toRawOf(deg, t) };
    const inP = rawToP(HINGE, deg, t);
    const bP = C.bounds(inP);
    const mid = k => (bP.lo[k] + bP.hi[k]) / 2;
    const sh = { kind: 'box', c: [mid(0), mid(1) + 2, mid(2)], h: [4.5, 3, 4], yaw: 15 };          // in P, across the middle of where the hinge is seen
    check('(the hinge as seen is 8 across x and 18 across y: turned a quarter on the plate)',
      near(bP.hi[0] - bP.lo[0], 8, 1e-4) && near(bP.hi[1] - bP.lo[1], 18, 1e-4), JSON.stringify(bP.lo.map(f3)) + JSON.stringify(bP.hi.map(f3)));
    const want = rayVolume(inP, shapeFn(sh), 0.02);
    const r = await crop('posed hinge, a yawed box', posed, sh, { volume: want, validate: true });
    // the copy comes back in the piece's own raw frame; seen through toRaw it lies inside the box
    if (r.ok) {
      const seen = rawToP(r.tris, deg, t), cs = Math.cos(-15 * Math.PI / 180), sn = Math.sin(-15 * Math.PI / 180);
      let worst = 0;
      for (let i = 0; i < seen.length; i += 3) {
        const dx = seen[i] - sh.c[0], dy = seen[i + 1] - sh.c[1];
        const u = cs * dx - sn * dy, v = sn * dx + cs * dy;
        worst = Math.max(worst, Math.abs(u) - sh.h[0], Math.abs(v) - sh.h[1], Math.abs(seen[i + 2] - sh.c[2]) - sh.h[2]);
      }
      check('...and every vertex of the copy, seen through the pose, is inside the box', worst < 1e-3, 'worst ' + worst.toExponential(2) + ' mm outside');
    }
    const ball = { kind: 'sphere', c: [mid(0), mid(1) - 3, mid(2)], r: 4.5 };
    await crop('posed hinge, a sphere', posed, ball, { volume: rayVolume(inP, shapeFn(ball), 0.02) });
    const sing = await C.run({ rawTris: HINGE, toRaw: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }, { kind: 'box', c: [0, 0, 0], h: [1, 1, 1] });
    check('a pose that cannot be undone is refused in words', !sing.ok && /singular/.test(sing.reason), sing.reason);
  }

  /* =========================================================================
     4. Piece
     ========================================================================= */
  console.log('\n=== 4. Piece: another piece is the cutter ===');
  {
    // the tube stood across the hinge: P frame, the tube moved by (9, 4, -6), the hinge as it is
    const place = [9, 4, -6];
    const tubeMoved = new Float32Array(TUBE.length);
    for (let i = 0; i < TUBE.length; i += 3) { tubeMoved[i] = TUBE[i] + place[0]; tubeMoved[i + 1] = TUBE[i + 1] + place[1]; tubeMoved[i + 2] = TUBE[i + 2] + place[2]; }
    const want = rayVolume(HINGE, meshCutter(tubeMoved), 0.02);
    const r = await crop('hinge, cropped by the tube across it', hingeP, { kind: 'piece', source: tubeMoved }, { volume: want, validate: true });
    // the same cutter as a piece-like with its own pose: nothing about the answer changes
    const t = [7, 3, 1], deg = 40;
    const tubeRaw = (() => {
      const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), out = new Float32Array(tubeMoved.length);
      for (let i = 0; i < out.length; i += 3) {
        out[i] = c * tubeMoved[i] - s * tubeMoved[i + 1] + t[0]; out[i + 1] = s * tubeMoved[i] + c * tubeMoved[i + 1] + t[1]; out[i + 2] = tubeMoved[i + 2] + t[2];
      }
      return out;
    })();
    const r2 = await C.run(hingeP, { kind: 'piece', source: { rawTris: tubeRaw, toRaw: toRawOf(deg, t) } });
    check('...the cutter given with its own pose is the same copy', r.ok && r2.ok && pct(r2.volumeMm3, r.volumeMm3) < 0.01,
      r2.ok ? f3(r2.volumeMm3) + ' vs ' + f3(r.volumeMm3) : r2.reason);
    const self = await C.run(hingeP, { kind: 'piece', source: hingeP });
    check('a piece cropped by itself is the whole piece', self.ok && pct(self.volumeMm3, hingeVol) < 1e-4, self.ok ? f3(self.volumeMm3) : self.reason);
    const miss = await C.run(hingeP, { kind: 'piece', source: boxSoup([100, 100, 100], [110, 110, 110]) });
    check('a cutter that does not touch it holds nothing', !miss.ok && /holds nothing/.test(miss.reason), miss.reason);
  }

  /* =========================================================================
     5. Outline
     ========================================================================= */
  console.log('\n=== 5. Outline: a tube\'s rim, the bore\'s rim, the hinge\'s skin ===');
  // A triangle with two corners on the circle of radius rad at height z.
  function rimTri(soup, rad, z) {
    for (let t = 0; t < soup.length / 9; t++) {
      let on = 0;
      for (let k = 0; k < 3; k++) {
        if (near(soup[t * 9 + k * 3 + 2], z, 1e-4) && near(Math.hypot(soup[t * 9 + k * 3], soup[t * 9 + k * 3 + 1]), rad, 1e-3)) on++;
      }
      if (on === 2) return t;
    }
    return -1;
  }
  const outerTri = rimTri(TUBE, TUBE_R, TUBE_H), boreTri = rimTri(TUBE, TUBE_RI, TUBE_H);
  check('(found a triangle on the outer rim and one on the bore\'s)', outerTri >= 0 && boreTri >= 0, outerTri + ' / ' + boreTri);
  const apo = r => r * Math.cos(Math.PI / TUBE_SEG);       // the polygon's face is a little inside the circle
  {
    // d1 = 0, d2 = 0.8: the ring inside the outer rim, 0.8 wide
    const r = await crop('tube, outer rim, offsets (0, 0.8)', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: outerTri, d1: 0, d2: 0.8 },
      { volume: Math.PI * (TUBE_R ** 2 - (TUBE_R - 0.8) ** 2) * TUBE_H, tol: 1, validate: true });
    if (r.ok) {
      const b = r.bbox;
      check('...the wall ring: as wide as the tube, as tall, and every vertex between R-0.8 and R',
        near(b.hi[0] - b.lo[0], 2 * TUBE_R, 0.02) && near(b.hi[2] - b.lo[2], TUBE_H, 1e-4) &&
        (() => { let lo = 1e9, hi = 0; for (let i = 0; i < r.tris.length; i += 3) { const d = Math.hypot(r.tris[i], r.tris[i + 1]); lo = Math.min(lo, d); hi = Math.max(hi, d); } return lo > TUBE_R - 0.8 - 0.05 && hi < TUBE_R + 1e-3; })());
      const polyRing = TUBE_SEG * Math.tan(Math.PI / TUBE_SEG) * (apo(TUBE_R) ** 2 - (apo(TUBE_R) - 0.8) ** 2) * TUBE_H;
      check('...and against the same ring worked out on the tube\'s own 96-sided polygon, within 0.1%', pct(r.volumeMm3, polyRing) < 0.1,
        f3(r.volumeMm3) + ' vs ' + f3(polyRing));
    }
    // across the rim: 0.5 either side, so half of it is outside the tube and the copy is the 0.5 inside
    await crop('tube, outer rim, offsets (0.5, 0.5)', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: outerTri, d1: 0.5, d2: 0.5 },
      { volume: Math.PI * (TUBE_R ** 2 - (TUBE_R - 0.5) ** 2) * TUBE_H, tol: 1 });
    // the bore's rim grown 0.8 outward: the bore's inner skin
    await crop('tube, the bore\'s rim, offsets (0.8, 0)', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: boreTri, d1: 0.8, d2: 0 },
      { volume: Math.PI * ((TUBE_RI + 0.8) ** 2 - TUBE_RI ** 2) * TUBE_H, tol: 1, validate: true });
    // between the two rims, by the bore's loop taken inward as well: a 1.6 ring across the bore wall
    await crop('tube, the bore\'s rim, offsets (0.8, 0.8)', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: boreTri, d1: 0.8, d2: 0.8 },
      { volume: Math.PI * ((TUBE_RI + 0.8) ** 2 - TUBE_RI ** 2) * TUBE_H, tol: 1 });
    // the exact boundary: d1 = d2 = 0 is the footprint itself, the whole tube seen from its outer rim
    const whole = await crop('tube, outer rim, offsets (0, 0): the exact boundary', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: outerTri, d1: 0, d2: 0 }, { volume: tubeVol, tol: 1e-4 });
    check('...a disc through the whole tube: the tube itself, bore and all', whole.ok && whole.faces === TUBE.length / 9, whole.ok ? whole.faces + ' faces' : '');
    // z range: only the top 5 mm of the ring
    await crop('tube, outer rim ring, heights 15..20', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: outerTri, d1: 0, d2: 0.8, z1: 15, z2: 20 },
      { volume: Math.PI * (TUBE_R ** 2 - (TUBE_R - 0.8) ** 2) * 5, tol: 1 });
    // the ring that is the whole wall, on the polygon's own faces: the cutter's inner wall is nearly the bore itself
    const sliver = await crop('tube, outer rim, offsets (0, 4): the ring the width of the whole wall', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: outerTri, d1: 0, d2: 4 },
      { volume: tubeVol, tol: 0.5 });
    check('...with no sliver where the cutter\'s wall grazes the bore', sliver.ok && sliver.census.slivers === 0 && sliver.parts === 1,
      sliver.ok ? sliver.parts + ' part(s), ' + sliver.dropped + ' dropped' : sliver.reason);
    // the other way: the cutter's inner wall 0.001 mm inside the material, a film of wall left out along the bore
    const film = await crop('tube, outer rim, offsets (0, 3.997): the cutter\'s wall a hair inside the bore\'s', tubeP,
      { kind: 'outline', source: TUBE, mode: 'rim', tri: outerTri, d1: 0, d2: 3.997 },
      { volume: tubeVol, tol: 0.5 });
    check('...no sliver, no speck', film.ok && film.census.slivers === 0, film.ok ? film.parts + ' part(s), ' + film.dropped + ' dropped' : film.reason);
  }
  {
    // Silhouette is the default mode. Seen from above a tube is an annulus (the bore is see-through),
    // so its band at (0, 0.8) is a skin at both edges: the outer wall's and the bore's.
    const r = await C.run(tubeP, { kind: 'outline', source: TUBE, d1: 0, d2: 0.8 });
    const want = Math.PI * (TUBE_R ** 2 - (TUBE_R - 0.8) ** 2 + (TUBE_RI + 0.8) ** 2 - TUBE_RI ** 2) * TUBE_H;
    check('a tube\'s silhouette (the default) is an annulus: (0, 0.8) is a skin at the outer wall and at the bore', r.ok && pct(r.volumeMm3, want) < 1,
      r.ok ? f3(r.volumeMm3) + ' vs ' + f3(want) : r.reason);
  }
  {
    // A plain bar 18 x 8 x 8 standing on a plate: every number is a sum of rectangles and quarter circles.
    const bar = { rawTris: boxSoup([0, 0, 0], [18, 8, 8]) };
    const plate = boxSoup([0, 0, 0], [60, 40, 4]);
    const barAt = { rawTris: bar.rawTris, toRaw: toRawOf(0, [-21, -16, 0]) };        // seen at 21..39 x 16..24, on the plate
    const wantRing = (2 * (18 + 8) + Math.PI) * 4;                                  // a 1 mm frame round 18 x 8, corners round, 4 mm tall
    const ring = await crop('plate round a bar, silhouette, offsets (1, 0): the skin outside it', { rawTris: plate },
      { kind: 'outline', source: barAt, d1: 1, d2: 0 }, { volume: wantRing, tol: 0.2, validate: true });
    check('...a frame round the footprint, the corners round: (2 (18 + 8) + pi) x 4 mm',
      ring.ok && pct(ring.volumeMm3, wantRing) < 0.2, ring.ok ? f3(ring.volumeMm3) + ' vs ' + f3(wantRing) : ring.reason);
    const wantAcross = (2 * (18 + 8) + Math.PI + 2 * (18 + 8) - 4) * 4;             // and 1 mm inside the edge as well: 18 x 8 less 16 x 6
    const across = await C.run({ rawTris: plate }, { kind: 'outline', source: barAt, d1: 1, d2: 1 });
    check('...(1, 1) is the frame across the boundary, 1 mm either side', across.ok && pct(across.volumeMm3, wantAcross) < 0.2,
      across.ok ? f3(across.volumeMm3) + ' vs ' + f3(wantAcross) : across.reason);
    const zr = await C.run({ rawTris: plate }, { kind: 'outline', source: barAt, d1: 1, d2: 0, z1: 1, z2: 3 });
    check('...between heights 1 and 3 it is half as tall', zr.ok && pct(zr.volumeMm3, wantRing / 2) < 0.2, zr.ok ? f3(zr.volumeMm3) : zr.reason);
    const solid = await C.run({ rawTris: plate }, { kind: 'outline', source: barAt, d1: 1, d2: 0, solid: true });
    check('solid: the whole footprint grown by 1 (the old card\'s Grow), not the frame', solid.ok && pct(solid.volumeMm3, (18 * 8 + 2 * (18 + 8) + Math.PI) * 4) < 0.2,
      solid.ok ? f3(solid.volumeMm3) : solid.reason);
    const exact = await C.run({ rawTris: plate }, { kind: 'outline', source: barAt });
    check('(0, 0) is the footprint exactly: 18 x 8 x 4, the corners square', exact.ok && near(exact.volumeMm3, 18 * 8 * 4, 1e-3) && exact.faces === 12,
      exact.ok ? f3(exact.volumeMm3) + ' mm3, ' + exact.faces + ' faces' : exact.reason);
    // the bar cropped by its own silhouette, inward: a skin 1 mm deep, a rectangular frame 18 x 8 less 16 x 6, 8 tall
    const skin = await crop('bar, its own silhouette, offsets (0, 1): the skin inside it', bar,
      { kind: 'outline', source: bar, d1: 0, d2: 1 }, { volume: (18 * 8 - 16 * 6) * 8, tol: 0.05, validate: true });
    check('...a frame: genus 1', skin.ok && validate(skin.tris).euler_characteristic === 0, skin.ok ? 'chi ' + validate(skin.tris).euler_characteristic : skin.reason);
  }
  {
    // The hinge's silhouette from above (five knuckles, not a rectangle). What is exact is that the skin and what it
    // leaves are the hinge, and that the footprint copy has the area of the footprint, which the rays measure.
    const skin = await crop('hinge, silhouette, offsets (0, 1): its skin', hingeP,
      { kind: 'outline', source: HINGE, d1: 0, d2: 1 }, { validate: true });
    const core = await C.run(hingeP, { kind: 'outline', source: HINGE, d1: 0, d2: 1, solid: true });
    check('...skin + the core it leaves (the footprint shrunk by 1) is the hinge', skin.ok && core.ok && near(skin.volumeMm3 + core.volumeMm3, hingeVol, 5e-3),
      skin.ok && core.ok ? f3(skin.volumeMm3) + ' + ' + f3(core.volumeMm3) + ' = ' + f3(skin.volumeMm3 + core.volumeMm3) + ' vs ' + f3(hingeVol) : '');
    if (skin.ok) {
      const b = skin.bbox, hb = C.bounds(HINGE);
      check('...as long, wide and tall as the hinge, and less of it', [0, 1, 2].every(k => near(b.lo[k], hb.lo[k], 1e-4) && near(b.hi[k], hb.hi[k], 1e-4)) && skin.volumeMm3 < hingeVol,
        f3(skin.volumeMm3) + ' of ' + f3(hingeVol) + ' mm3');
    }
    const skinHalf = await C.run(hingeP, { kind: 'outline', source: HINGE, d1: 0, d2: 0.5 });
    check('a 0.5 mm skin holds less than the 1 mm one, which holds less than the hinge', skinHalf.ok && skin.ok && skinHalf.volumeMm3 < skin.volumeMm3 && skin.volumeMm3 < hingeVol,
      skinHalf.ok && skin.ok ? f3(skinHalf.volumeMm3) + ' < ' + f3(skin.volumeMm3) + ' < ' + f3(hingeVol) : '');
    // The footprint is under 4 mm across somewhere (each knuckle is 3.6 long), so a 2 mm skin leaves no core to
    // take away: the skin is the whole footprint, which is the whole hinge.
    const skin2 = await C.run(hingeP, { kind: 'outline', source: HINGE, d1: 0, d2: 2 });
    check('a 2 mm skin on a footprint 3.6 mm across at its narrowest is the whole hinge, not a refusal', skin2.ok && pct(skin2.volumeMm3, hingeVol) < 1e-3,
      skin2.ok ? f3(skin2.volumeMm3) + ' vs ' + f3(hingeVol) : skin2.reason);
    // outside: on a plate it stands on, the +1 skin. Footprint area by rays; skin = (grown footprint) - footprint, exactly.
    const plate = boxSoup([0, 0, 0], [60, 40, 4]);
    const hingeAt = { rawTris: HINGE, toRaw: toRawOf(0, [-21, -16, 0]) };
    const cast = caster(HINGE), step = 0.02;
    let hits = 0;
    for (let x = 0.0031; x < 18; x += step) for (let y = 0.0027; y < 8; y += step) if (cast(x, y).length) hits++;
    const areaF = hits * step * step;
    const fp = await C.run({ rawTris: plate }, { kind: 'outline', source: hingeAt });
    check('the hinge\'s footprint on the plate, (0, 0): the area the rays see, x 4 mm', fp.ok && pct(fp.volumeMm3, areaF * 4) < 0.3,
      fp.ok ? f3(fp.volumeMm3) + ' vs ' + f3(areaF * 4) + ' (area ' + f3(areaF) + ' mm2)' : fp.reason);
    const out1 = await crop('plate round the hinge, silhouette, offsets (1, 0): its skin outside', { rawTris: plate },
      { kind: 'outline', source: hingeAt, d1: 1, d2: 0 }, { validate: true });
    const grown = await C.run({ rawTris: plate }, { kind: 'outline', source: hingeAt, d1: 1, d2: 0, solid: true });
    check('...skin + the footprint is the footprint grown by 1', out1.ok && fp.ok && grown.ok && near(out1.volumeMm3 + fp.volumeMm3, grown.volumeMm3, 5e-3),
      out1.ok && fp.ok && grown.ok ? f3(out1.volumeMm3) + ' + ' + f3(fp.volumeMm3) + ' = ' + f3(out1.volumeMm3 + fp.volumeMm3) + ' vs ' + f3(grown.volumeMm3) : '');
    check('...and a frame round it: no part of the hinge\'s footprint is in it', out1.ok && fp.ok && out1.volumeMm3 > 0 && out1.volumeMm3 < grown.volumeMm3);
  }

  /* =========================================================================
     6. the rim finder
     ========================================================================= */
  console.log('\n=== 6. the rim finder ===');
  {
    const o = C.rimLoop(TUBE, outerTri), i = C.rimLoop(TUBE, boreTri);
    check('a triangle on the end face with an edge on the outer circle takes the outer loop', o.loop && o.loop.length === TUBE_SEG &&
      o.loop.every(p => near(Math.hypot(p[0], p[1]), TUBE_R, 1e-3) && near(p[2], TUBE_H, 1e-4)), o.loop ? o.loop.length + ' points' : o.reason);
    check('...and the bore\'s takes the bore', i.loop && i.loop.length === TUBE_SEG && i.loop.every(p => near(Math.hypot(p[0], p[1]), TUBE_RI, 1e-3)),
      i.loop ? i.loop.length + ' points' : i.reason);
    check('...the face is the 96-gon annulus, two loops on it', o.loops === 2 && i.loops === 2, o.loops + ' loops');
    // a triangle on the tube's wall: the face is the wall all the way round, its loops are the top and bottom circles
    let wallTri = -1;
    for (let t = 0; t < TUBE.length / 9 && wallTri < 0; t++) {
      const zs = [TUBE[t * 9 + 2], TUBE[t * 9 + 5], TUBE[t * 9 + 8]];
      if (zs.every(z => z > 1 && z < TUBE_H - 1 || z === 0 || z === TUBE_H) && Math.max(...zs) - Math.min(...zs) > 5 &&
          [0, 1, 2].every(k => near(Math.hypot(TUBE[t * 9 + k * 3], TUBE[t * 9 + k * 3 + 1]), TUBE_R, 1e-3))) wallTri = t;
    }
    const w = C.rimLoop(TUBE, wallTri);
    check('a triangle on the outer wall finds the wall, and a circle of R 12 at its edge', w.loop && w.loop.length === TUBE_SEG &&
      w.loop.every(p => near(Math.hypot(p[0], p[1]), TUBE_R, 1e-3)), w.loop ? w.loop.length + ' points, ' + w.loops + ' loops' : w.reason);
    // a box face: the rim is the 4 corners
    const bx = C.rimLoop(boxSoup([0, 0, 0], [10, 6, 4]), 2);
    check('a box\'s top face has a rim of 4 corners, 60 mm2', bx.loop && bx.loop.length === 4 && near(Math.abs(bx.area), 60, 1e-6), bx.loop ? bx.loop.length + ' corners, ' + f3(Math.abs(bx.area)) + ' mm2' : bx.reason);
    const sph = Stock.revolve(Stock.profileSphere(5, 32), 64);
    const sr = C.rimLoop(sph, 100);
    check('a sphere has no rim: it is a closed surface all the way round', !sr.loop && /no edge|closed surface/.test(sr.reason || ''), sr.reason);
    check('a triangle that is not there is refused', !!C.rimLoop(TUBE, 99999).reason && !!C.rimLoop(TUBE, -1).reason);
  }

  /* =========================================================================
     7. refusals
     ========================================================================= */
  console.log('\n=== 7. refusals: only a shape that holds nothing, or a result that is not closed ===');
  {
    const snap = bytes(HINGE);
    const cases = [
      ['a box nowhere near the piece', hingeP, { kind: 'box', c: [60, 60, 60], h: [2, 2, 2] }, /holds nothing/],
      ['a sphere in the air above it', hingeP, { kind: 'sphere', c: [9, 4, 30], r: 5 }, /holds nothing/],
      ['a cylinder that passes beside it', hingeP, { kind: 'cylinder', c: [9, 20, 4], r: 3, hl: 20, axis: 'x' }, /holds nothing/],
      ['a box inside the bore, where there is no material', tubeP, { kind: 'box', c: [0, 0, 10], h: [3, 3, 5] }, /holds nothing/],
      ['the band outside the hinge\'s own outline, cropped from the hinge', hingeP, { kind: 'outline', source: HINGE, d1: 1, d2: 0 }, /holds nothing/],
      ['a box with a negative half-size', hingeP, { kind: 'box', c: [9, 4, 4], h: [-1, 2, 2] }, /half-sizes above 0/],
      ['a box with no centre', hingeP, { kind: 'box', h: [1, 1, 1] }, /needs a centre/],
      ['a centre that is not a number', hingeP, { kind: 'sphere', c: [NaN, 0, 0], r: 2 }, /needs a centre/],
      ['a cylinder with no length', hingeP, { kind: 'cylinder', c: [0, 0, 0], r: 2, hl: 0 }, /half-length/],
      ['a cylinder on the w axis', hingeP, { kind: 'cylinder', c: [0, 0, 0], r: 2, hl: 2, axis: 'w' }, /axis is x, y or z/],
      ['a sphere of radius 0', hingeP, { kind: 'sphere', c: [0, 0, 0], r: 0 }, /radius above 0/],
      ['a shape that is not one', hingeP, { kind: 'torus' }, /unknown shape/],
      ['no shape at all', hingeP, null, /no shape/],
      ['a Piece with no other piece', hingeP, { kind: 'piece' }, /another piece/],
      ['an outline with a negative offset', hingeP, { kind: 'outline', source: HINGE, d1: -1 }, /distance of 0 or more/],
      ['an outline with one height', hingeP, { kind: 'outline', source: HINGE, z1: 1 }, /both heights/],
      ['an outline with its heights upside down', hingeP, { kind: 'outline', source: HINGE, z1: 5, z2: 1 }, /z1 below z2/],
      ['a rim with no triangle', hingeP, { kind: 'outline', source: HINGE, mode: 'rim' }, /needs tri/],
      ['a rim on a triangle that is not there', hingeP, { kind: 'outline', source: HINGE, mode: 'rim', tri: 99999 }, /not a triangle of that piece/],
      ['an outline of a source with no outline from above (only walls)', hingeP, { kind: 'outline', source: new Float32Array([0, 0, 0, 0, 0, 5, 0, 0, 3]) }, /no outline/],
      ['an outline of nothing', hingeP, { kind: 'outline', source: new Float32Array(0) }, /no source|no outline/],
      ['a ring wider than the whole footprint is the whole footprint, not a refusal: d2 = 50 on the hinge', hingeP, { kind: 'outline', source: HINGE, d1: 0, d2: 50 }, null]
    ];
    for (const [label, piece, shape, re] of cases) {
      const r = await C.run(piece, shape);
      if (re) check(label + ': refused in words', !r.ok && re.test(r.reason || '') && r.tris === undefined, r.ok ? 'it made a copy' : r.reason);
      else check(label + ': copied the whole piece', r.ok && pct(r.volumeMm3, hingeVol) < 1e-3, r.ok ? f3(r.volumeMm3) : r.reason);
    }
    const none = await C.run({ rawTris: new Float32Array(0) }, { kind: 'box', c: [0, 0, 0], h: [1, 1, 1] });
    check('an empty piece is refused', !none.ok && /empty piece/.test(none.reason), none.reason);
    const nul = await C.run(null, { kind: 'box', c: [0, 0, 0], h: [1, 1, 1] });
    check('no piece at all is refused', !nul.ok && /empty piece/.test(nul.reason), nul.reason);
    // a source piece the kernel will not take as a solid
    const open = HINGE.slice(0, HINGE.length - 18);        // two triangles short
    const op = await C.run(hingeP, { kind: 'piece', source: open });
    check('a Piece cutter that is not a closed solid is refused in words, or healed and still closed',
      op.ok ? C.census(op.tris).open === 0 : /closed solid/.test(op.reason), op.ok ? 'healed: ' + f3(op.volumeMm3) : op.reason);
    const opened = await C.run({ rawTris: open }, { kind: 'box', c: [9, 4, 4], h: [3, 5, 5] });
    check('a piece the kernel will not take as a closed solid is refused in words, or healed and still closed',
      opened.ok ? C.census(opened.tris).open === 0 : /closed solid/.test(opened.reason), opened.ok ? 'healed: ' + f3(opened.volumeMm3) : opened.reason);
    check('after all of those the hinge is still byte for byte what it was', bytes(HINGE) === snap);
    const openCensus = C.census(open);
    check('the closed test itself counts an open soup open (so a result that was not closed would be refused)', openCensus.open > 0, openCensus.open + ' open edges');
  }

  /* =========================================================================
     8. the real app
     ========================================================================= */
  console.log('\n=== 8. the real app: "<name> crop N" on the plate, in place, one Undo ===');
  let withApp, loadSTL, selectModel;
  try { ({ withApp, loadSTL, selectModel } = require('./nso_app_harness')); }
  catch (e) { check('the app harness loads', false, e.message); }
  if (withApp) {
    await withApp(async (page, logs) => {
      const id = await loadSTL(page, path.join(ROOT, 'library', 'hinge_knuckle_box.stl'));
      await selectModel(page, id);
      const ready = await page.evaluate(() => typeof NSO_Crop === 'object' && typeof NSO_Crop.copy === 'function');
      check('NSO_Crop is loaded by the page', ready);

      const snapshot = () => page.evaluate(hid => {
        const m = state.models.find(x => x.id === hid);
        return { raw: Array.from(m.rawTris), pos: Array.from(m.geometry.attributes.position.array), off: m.centerOffset,
                 models: state.models.length, placed: state.placed.length, undo: state.undoStack.length,
                 names: state.models.map(x => x.name) };
      }, id);
      const host = await snapshot();
      const shape = { kind: 'box', c: null, h: [3, 12, 12] };

      // where the piece is seen: the middle of its world box, in P
      const centreP = () => page.evaluate(hid => {
        const p = state.placed.find(q => q.sourceId === hid);
        const b = new THREE.Box3().setFromObject(p.mesh), c = b.getCenter(new THREE.Vector3());
        return [c.x, -c.z, c.y];
      }, id);
      const copyOnce = (sh) => page.evaluate(async ([hid, sh2]) => {
        const r = await NSO_Crop.copy(state.models.find(x => x.id === hid), sh2);
        return r.ok ? { ok: true, id: r.id, name: r.name, faces: r.faces, volumeMm3: r.volumeMm3, text: r.text } : r;
      }, [id, sh]);
      // the copy's vertices where the plate has them, and where the original puts the same raw points
      const placement = (hostId, copyId) => page.evaluate(([hid, cid]) => {
        const hm = state.models.find(x => x.id === hid), cm = state.models.find(x => x.id === cid);
        const hp = state.placed.find(q => q.sourceId === hid), cp = state.placed.find(q => q.sourceId === cid);
        hp.mesh.updateMatrixWorld(true); cp.mesh.updateMatrixWorld(true);
        const pos = cp.mesh.geometry.attributes.position, off = hm.centerOffset, v = new THREE.Vector3();
        let worst = 0, n = Math.min(pos.count, 3000);
        for (let i = 0; i < n; i++) {
          const rx = cm.rawTris[i * 3], ry = cm.rawTris[i * 3 + 1], rz = cm.rawTris[i * 3 + 2];
          const want = new THREE.Vector3(rx - off.x, rz - off.y, -ry - off.z).applyMatrix4(hp.mesh.matrixWorld);
          v.fromBufferAttribute(pos, i).applyMatrix4(cp.mesh.matrixWorld);
          worst = Math.max(worst, v.distanceTo(want));
        }
        return { worst: worst, n: n, selected: state.placed[state.selectedIndex] === cp, liftHost: hp.liftY || 0, liftCopy: cp.liftY || 0 };
      }, [hostId, copyId]);

      const c0 = await centreP();
      shape.c = [c0[0], c0[1], c0[2]];
      const r1 = await copyOnce(shape);
      check('copy: a box through the middle of the hinge on the plate', r1.ok, r1.ok ? r1.text : r1.reason);
      const after = await snapshot();
      check('the copy is named "<name> crop 1"', r1.ok && r1.name === 'hinge_knuckle_box crop 1', r1.name);
      check('it is a new model on the plate, and nothing else was added', after.models === host.models + 1 && after.placed === host.placed + 1, after.models + ' models, ' + after.placed + ' placed');
      check('the original is byte-identical: its soup, its drawn mesh, its centre offset',
        JSON.stringify(after.raw) === JSON.stringify(host.raw) && JSON.stringify(after.pos) === JSON.stringify(host.pos) && JSON.stringify(after.off) === JSON.stringify(host.off));
      const pl = await placement(id, r1.id);
      check('it lands in place: each of its vertices is where the original puts the same point (' + pl.n + ' checked)', pl.worst < 1e-3, 'worst ' + pl.worst.toExponential(2) + ' mm');
      check('...and it is the selected piece, ready to grab', pl.selected);
      const g1 = await page.evaluate(i => { const m = state.models.find(x => x.id === i); return { raw: Array.from(m.rawTris), axis: m.rawAxis, off: m.centerOffset, solid: NSO_Crop.census(m.rawTris) }; }, r1.id);
      check('its raw soup is the closed engine result, a raw piece the other tools take', g1.axis === 'zup' && g1.off && g1.solid.open === 0 && g1.solid.repeated === 0 && g1.solid.slivers === 0,
        g1.raw.length / 9 + ' tris');
      check('...and encloses exactly what the engine said', near(NSO_vol(g1.raw), r1.volumeMm3, 1e-3), f3(NSO_vol(g1.raw)) + ' vs ' + f3(r1.volumeMm3));

      // Undo removes it, and only it
      await page.evaluate(() => undoLastStep());
      const undone = await snapshot();
      check('one Undo removes the copy from the list and the plate', undone.models === host.models && undone.placed === host.placed && undone.undo === host.undo, undone.models + ' models, ' + undone.placed + ' placed, ' + undone.undo + ' undo steps');
      check('...and the original is still byte-identical', JSON.stringify(undone.raw) === JSON.stringify(host.raw));
      await selectModel(page, id);

      // a posed original: turned on the plate, then lifted
      await page.evaluate(hid => {
        const p = state.placed.find(q => q.sourceId === hid);
        applyPlacedOrientation(p, { rotY: 0.6, tipX: 0, tipZ: 0, tiltX: 0, tiltZ: 0, flipX: false, liftY: 3 });
      }, id);
      const c1 = await centreP();
      const r2 = await copyOnce({ kind: 'box', c: c1, h: [2.5, 20, 20], yaw: 25 });
      check('copy: a yawed box through the hinge, turned and lifted on the plate', r2.ok, r2.ok ? r2.text : r2.reason);
      const pl2 = await placement(id, r2.id);
      check('a turned, lifted original: the copy still lands in place', pl2.worst < 1e-3, 'worst ' + pl2.worst.toExponential(2) + ' mm');
      check('...at the height the original is at', near(pl2.liftCopy, pl2.liftHost, 1e-3), f3(pl2.liftCopy) + ' vs ' + f3(pl2.liftHost));
      // seen from above, the copy is the slab the yawed box held: its bbox in P is the box's
      const seen = await page.evaluate(i => {
        const p = state.placed.find(q => q.sourceId === i);
        const g = p.mesh.geometry.attributes.position, v = new THREE.Vector3(); p.mesh.updateMatrixWorld(true);
        const out = [];
        for (let k = 0; k < g.count; k++) { v.fromBufferAttribute(g, k).applyMatrix4(p.mesh.matrixWorld); out.push([v.x, -v.z, v.y]); }
        return out;
      }, r2.id);
      const cy = Math.cos(-25 * Math.PI / 180), sy = Math.sin(-25 * Math.PI / 180);
      let across = 0;
      for (const q of seen) { const dx = q[0] - c1[0], dy = q[1] - c1[1]; across = Math.max(across, Math.abs(cy * dx - sy * dy)); }
      check('...and across the yawed box\'s own x it reaches its half-size 2.5, no further', near(across, 2.5, 5e-3), f3(across) + ' mm');

      const r3 = await copyOnce({ kind: 'sphere', c: c1, r: 3 });
      check('a second copy is "crop 2"', r3.ok && r3.name === 'hinge_knuckle_box crop 2', r3.name || r3.reason);
      const withTwo = await snapshot();
      const r4 = await copyOnce({ kind: 'box', c: [500, 500, 500], h: [1, 1, 1] });
      const refused = await snapshot();
      check('a shape that holds nothing is refused in words, with the plate and the Undo stack unchanged',
        !r4.ok && /holds nothing/.test(r4.reason) && refused.models === withTwo.models && refused.placed === withTwo.placed && refused.undo === withTwo.undo,
        r4.reason);
      const status = await page.evaluate(() => document.getElementById('status').textContent);
      check('...and the status line says so', /^Crop refused - nothing changed \(.*holds nothing/.test(status), status);
      // a Piece cutter and an Outline read from another piece on the plate, as drawn
      const stockId = await page.evaluate(hid => {
        const bid = addModel('block', new THREE.BoxGeometry(20, 6, 14), { silent: false });
        const hp = state.placed.find(q => q.sourceId === hid), bp = state.placed.find(q => q.sourceId === bid);
        bp.mesh.position.x = hp.mesh.position.x; bp.mesh.position.z = hp.mesh.position.z; bp.x = hp.x; bp.z = hp.z;
        bp.mesh.updateMatrixWorld(true);
        return bid;
      }, id);
      check('(a second piece put on the plate, over the hinge, to crop with)', stockId != null);
      await selectModel(page, id);
      const r5 = await copyOnce({ kind: 'piece', pieceId: stockId });
      check('a Piece shape named by pieceId reads that piece as drawn', r5.ok && r5.volumeMm3 > 1, r5.ok ? r5.text : r5.reason);
      const r6 = await copyOnce({ kind: 'outline', pieceId: id, d1: 0, d2: 1 });
      check('an Outline taken from the same piece being cropped: its own skin', r6.ok, r6.ok ? r6.text : r6.reason);
      const errs = logs.filter(l => l.startsWith('[pageerror]'));
      check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
    });
  }

  function NSO_vol(arr) { return C.volume(Float32Array.from(arr)); }

  console.log('\n' + (fail ? 'FAIL (' + fail + ' failed, ' + pass + ' ok)' : 'PASS (' + pass + ' ok)'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(2); });
