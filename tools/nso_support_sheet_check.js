#!/usr/bin/env node
// The interface SHEET under a support tree (nso_support_interface.js sheet(),
// built by nso_support_gridpack.js parts({ interface: true }) - the Supports
// card's build), held to the Bambu Studio references: clamp_body sliced with
// tree supports, and the top_clip_x2 coupon (baselineV2, Bambu's tree in its
// default style: tip caps, two interface layers on them, shared pads), 0.2 mm
// layers (docs/SUPPORT-INTERFACE.md).
//
//   node tools/nso_support_sheet_check.js            exit 0 = every gate held
//   node tools/nso_support_sheet_check.js --export   also writes the clamp with
//        its supports to tools/support-interface-out/clamp_body_sheet.3mf
//
// Each piece goes through the card's own pipeline, at the card's defaults
// (angle 60, Tree, 1.2 mm, rest off): detectOverhangs, planTree per area with
// the area's beacons, NSO_SupportGridpack.parts({ interface: true }), weld.
//
// PER AREA
//   1. THE STACK. Every area with a tip that meets a ceiling carries a sheet:
//      2 interface layers and NO transition layer, each one 0.2 mm layer,
//      its top GAP under the ceiling.
//   1b. THE CAPS. Every tip under the sheet ends in a flat cap 2.5 - 4 mm
//      across (narrower only where the tips stand closer than that: a cap
//      stops CAP_PART short of its neighbour, never over it), every cap's
//      nearest neighbour at most 2 mm away edge to edge, the cap's flat top
//      exactly the interface's underside (0.01 mm into it).
//   1c. THE LINES' BOXES: every line of the sheet is one straight box (two
//      ends, nothing between, 8 vertices on its own) and none is shorter than
//      2 mm.
//   2. THE LINES, read off the welded support itself (a horizontal slice at
//      each layer's middle): one direction per layer, each across the one
//      below (90 deg), line pitch 0.84 +- 0.05 mm.
//   3. THE GAP. The true minimum distance from the interface zone (the sheet,
//      every tip, 3 mm under the lowest contact) to the piece is 0.18 mm -
//      nso_support_interface.js's minDistance (the sampler finish() measures
//      with) and the exact triangle-to-triangle distance beside it.
//   4. NO TIP ABOVE THE SHEET'S UNDERSIDE: no part of the tree but the sheet
//      stands above the sheet's underside under any of its lines.
//   5. Closed, manifold, no degenerate triangle (tools/mesh_validate.py), no
//      piercing pair in the sheet (NSO_Repair.js's count, = the checker's);
//      no sheet left standing alone. The trees and feet below are held to
//      the bare build: no nearer the piece, counts reported beside its own.
//   6. THE FEET: every trunk on the plate stands on a pad, every cluster of
//      feet (within 6 mm) on ONE pad, each pad 0.18 mm or more off the piece
//      - or, inside a trunk's own end square, no nearer than the trunks
//      standing on it - and the trunks on one pad in one support (shells()).
// THE COUPON, across its two areas as the card builds them (footPads
//   'shared', then shareFeet): one pad under every cluster whatever area it
//   holds, the trees on one pad one support - so no two supports' first
//   layers touch - and the whole build under 10 s.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-interface-out');
const { readSTL, writeSTL, loadRepairModule } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const EXPORT = process.argv.includes('--export');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
/* the card's build worker's own list (app-supports-card.js ENGINE) */
for (const f of ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js',
                 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree, GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface;
const GAP = SI.DEFAULTS.gapMm, LAYER = SI.DEFAULTS.layerMm, PITCH = SI.SHEET.pitchMm, EPS = SI.DEFAULTS.epsMm;
const CARD = { skipList: [], angleDeg: 60, occluders: [], style: 'tree', restOnModel: false, sideMm: 1.2 };

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f3 = v => (+v).toFixed(3), f4 = v => (+v).toFixed(4);

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
const soupOf = (...parts) => new Float32Array([].concat(...parts));

/* clamp_body standing on its 94 mm axis, as the reference was sliced:
   (x, y, z) -> (x, -z, y), dropped onto the plate */
function standing(soup) {
  const r = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { r[i] = soup[i]; r[i + 1] = -soup[i + 2]; r[i + 2] = soup[i + 1]; }
  let mz = Infinity;
  for (let i = 2; i < r.length; i += 3) mz = Math.min(mz, r[i]);
  for (let i = 2; i < r.length; i += 3) r[i] -= mz;
  return r;
}

const PIECES = [
  ['top_clip_x2 (the 2026-10-20 coupon)', readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl')), 'coupon'],
  ['clamp_body (standing, as the reference)', standing(readSTL(path.join(ROOT, 'fixtures', 'supports', 'clamp_body.stl'))), 'clamp'],
  /* tree:interface's own fixtures */
  ['shelf', soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20])), 'shelf'],
  ['tab', soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16])), 'tab'],
  ['tall', soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26])), 'tall']
];

/* the welded support cut by the plane z: its segments */
function sliceAt(soup, z) {
  const segs = [];
  for (let i = 0; i < soup.length; i += 9) {
    const P = [[soup[i], soup[i + 1], soup[i + 2]], [soup[i + 3], soup[i + 4], soup[i + 5]], [soup[i + 6], soup[i + 7], soup[i + 8]]];
    const pts = [];
    for (let k = 0; k < 3; k++) {
      const a = P[k], b = P[(k + 1) % 3];
      if ((a[2] - z) * (b[2] - z) < 0) { const t = (z - a[2]) / (b[2] - a[2]); pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    if (pts.length === 2) segs.push(pts);
  }
  return segs;
}
/* is (x, y) under one of the level's lines (any layer)? a coarse grid of segments */
function lineIndex(level) {
  const cell = 2, g = new Map();
  for (const Ly of level.layers) for (const p of Ly.paths) for (let k = 0; k + 1 < p.length; k++) {
    const a = p[k], b = p[k + 1];
    for (let i = Math.floor(Math.min(a[0], b[0]) / cell) - 1; i <= Math.floor(Math.max(a[0], b[0]) / cell) + 1; i++)
      for (let j = Math.floor(Math.min(a[1], b[1]) / cell) - 1; j <= Math.floor(Math.max(a[1], b[1]) / cell) + 1; j++) {
        const key = i + ',' + j; if (!g.has(key)) g.set(key, []); g.get(key).push([a, b]);
      }
  }
  /* inside the strip: across it within r, along it within its ends (a line ends flush) */
  const inStrip = (p, a, b, r) => {
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey);
    if (!(L > 1e-9)) return false;
    const t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L;
    return t >= -1e-9 && t <= L + 1e-9 && Math.abs((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / L <= r;
  };
  return (x, y, r) => (g.get(Math.floor(x / cell) + ',' + Math.floor(y / cell)) || []).some(s => inStrip([x, y], s[0], s[1], r));
}

/* the lines of one layer, read off a slice: direction, pitch */
function layerLines(segs, inFoot, width) {
  const hist = new Map();
  let total = 0;
  const S = segs.filter(s => inFoot((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2));
  for (const s of S) {
    const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
    if (!(L > 1e-6)) continue;
    const deg = ((Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]) * 180 / Math.PI) % 180 + 180) % 180;
    const k = Math.round(deg) % 180;
    hist.set(k, (hist.get(k) || 0) + L); total += L;
  }
  const fam = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  if (!fam.length) return null;
  const dom = fam[0][0];
  let near = 0;
  for (const [d, L] of fam) if (Math.min(Math.abs(d - dom), 180 - Math.abs(d - dom)) <= 1) near += L;
  /* the family's own direction, not its whole-degree bin: a line at 26.57 deg
     projected on 27 smears its edges by 0.15 mm over 20 mm. Length-weighted,
     on the doubled angle (a direction, not a heading). */
  let cx = 0, cy = 0;
  for (const s of S) {
    const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
    if (!(L > 1e-6)) continue;
    const a = Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]), deg = ((a * 180 / Math.PI) % 180 + 180) % 180;
    if (Math.min(Math.abs(deg - dom), 180 - Math.abs(deg - dom)) > 1) continue;
    cx += L * Math.cos(2 * a); cy += L * Math.sin(2 * a);
  }
  const th = Math.atan2(cy, cx) / 2, nx = -Math.sin(th), ny = Math.cos(th);
  /* every edge along the direction, however short (the union fans a
     middle layer's side faces into slivers), clustered by its offset; an
     offset is an edge of a line when 1 mm of edge or more lies on it */
  const us = [];
  for (const s of S) {
    const L = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
    const deg = ((Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]) * 180 / Math.PI) % 180 + 180) % 180;
    if (!(L > 1e-6) || Math.min(Math.abs(deg - dom), 180 - Math.abs(deg - dom)) > 1) continue;
    us.push([((s[0][0] + s[1][0]) / 2) * nx + ((s[0][1] + s[1][1]) / 2) * ny, L]);
  }
  us.sort((a, b) => a[0] - b[0]);
  const clusters = [];
  for (const [u, L] of us) {
    const c = clusters[clusters.length - 1];
    if (c && u - c.last <= 0.01) { c.sum += u * L; c.len += L; c.last = u; } else clusters.push({ sum: u * L, len: L, last: u });
  }
  const uniq = clusters.filter(c => c.len >= 1).map(c => c.sum / c.len);
  /* a strip is two edges a line width apart; its centre is their middle */
  const centres = [];
  for (let i = 0; i + 1 < uniq.length; i++) {
    if (Math.abs(uniq[i + 1] - uniq[i] - width) < 0.03) { centres.push((uniq[i] + uniq[i + 1]) / 2); i++; }
  }
  const diffs = [];
  for (let i = 0; i + 1 < centres.length; i++) diffs.push(centres[i + 1] - centres[i]);
  const sorted = diffs.slice().sort((a, b) => a - b);
  const offGrid = diffs.filter(d => { const n = Math.max(1, Math.round(d / PITCH)); return Math.abs(d - n * PITCH) > 0.05; }).length;
  return { dir: +((((th * 180 / Math.PI) % 180) + 180) % 180).toFixed(2), oneDirShare: total > 0 ? near / total : 0, lines: centres.length,
           pitch: sorted.length ? sorted[0] : null, medianPitch: sorted.length ? sorted[sorted.length >> 1] : null,
           adjacent: diffs.filter(d => Math.abs(d - PITCH) <= 0.05).length, offGrid };
}

/* the triangles of A whose boxes come within r of a triangle box of B, and
   (zMin) that reach above zMin */
function cropNear(A, B, r, zMin) {
  const cell = 1, g = new Map(), BB = [];
  for (let i = 0; i < B.length; i += 9) {
    const lo = [0, 1, 2].map(k => Math.min(B[i + k], B[i + 3 + k], B[i + 6 + k]));
    const hi = [0, 1, 2].map(k => Math.max(B[i + k], B[i + 3 + k], B[i + 6 + k]));
    const id = BB.length; BB.push({ lo, hi });
    for (let x = Math.floor((lo[0] - r) / cell); x <= Math.floor((hi[0] + r) / cell); x++)
      for (let y = Math.floor((lo[1] - r) / cell); y <= Math.floor((hi[1] + r) / cell); y++)
        for (let z = Math.floor((lo[2] - r) / cell); z <= Math.floor((hi[2] + r) / cell); z++) {
          const key = x + ',' + y + ',' + z; if (!g.has(key)) g.set(key, []); g.get(key).push(id);
        }
  }
  const out = [];
  for (let i = 0; i < A.length; i += 9) {
    const lo = [0, 1, 2].map(k => Math.min(A[i + k], A[i + 3 + k], A[i + 6 + k]));
    const hi = [0, 1, 2].map(k => Math.max(A[i + k], A[i + 3 + k], A[i + 6 + k]));
    if (zMin != null && hi[2] <= zMin) continue;
    let hit = false;
    for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell) && !hit; x++)
      for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell) && !hit; y++)
        for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell) && !hit; z++) {
          const L = g.get(x + ',' + y + ',' + z);
          if (L) hit = L.some(id => {
            const b = BB[id];
            return Math.hypot(Math.max(0, lo[0] - b.hi[0], b.lo[0] - hi[0]), Math.max(0, lo[1] - b.hi[1], b.lo[1] - hi[1]),
                              Math.max(0, lo[2] - b.hi[2], b.lo[2] - hi[2])) <= r;
          });
        }
    if (hit) for (let k = 0; k < 9; k++) out.push(A[i + k]);
  }
  return new Float32Array(out);
}
function splitSoup(B, maxE) {
  const out = [];
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const m = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  function rec(a, b, c) {
    const e = [d(a, b), d(b, c), d(c, a)], k = e.indexOf(Math.max(...e));
    if (e[k] <= maxE) { out.push(...a, ...b, ...c); return; }
    if (k === 0) { const x = m(a, b); rec(a, x, c); rec(x, b, c); }
    else if (k === 1) { const x = m(b, c); rec(a, b, x); rec(a, x, c); }
    else { const x = m(c, a); rec(a, b, x); rec(x, b, c); }
  }
  for (let i = 0; i < B.length; i += 9) rec([B[i], B[i + 1], B[i + 2]], [B[i + 3], B[i + 4], B[i + 5]], [B[i + 6], B[i + 7], B[i + 8]]);
  return new Float32Array(out);
}
/* the surface of A between the planes z0 and z1, its triangles clipped at
   both (a trunk's side is one triangle from its foot to its tip) */
function band(A, z0, z1) {
  const out = [];
  function clip(poly, z, keepAbove) {
    const res = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ina = keepAbove ? a[2] >= z : a[2] <= z, inb = keepAbove ? b[2] >= z : b[2] <= z;
      if (ina) res.push(a);
      if (ina !== inb) { const t = (z - a[2]) / (b[2] - a[2]); res.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]); }
    }
    return res;
  }
  for (let i = 0; i < A.length; i += 9) {
    let poly = [[A[i], A[i + 1], A[i + 2]], [A[i + 3], A[i + 4], A[i + 5]], [A[i + 6], A[i + 7], A[i + 8]]];
    const lo = Math.min(poly[0][2], poly[1][2], poly[2][2]), hi = Math.max(poly[0][2], poly[1][2], poly[2][2]);
    if (hi < z0 || lo > z1) continue;
    if (lo < z0) poly = clip(poly, z0, true);
    if (poly.length >= 3 && hi > z1) poly = clip(poly, z1, false);
    for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1]);
  }
  return new Float32Array(out);
}
/* the surface of A in the foot layer */
function feetOf(A, z) { return band(A, -Infinity, z); }

/* the connected pieces of a soup (shared corners), and how many of them are
   one box: 8 distinct corners */
function boxesIn(soup) {
  const key = i => soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2], par = new Map();
  const find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  for (let t = 0; t < soup.length; t += 9) {
    const ks = [key(t), key(t + 3), key(t + 6)];
    ks.forEach(k => { if (!par.has(k)) par.set(k, k); });
    const a = find(ks[0]); ks.slice(1).forEach(k => { const b = find(k); if (a !== b) par.set(b, a); });
  }
  const size = new Map();
  for (const k of par.keys()) { const r = find(k); size.set(r, (size.get(r) || 0) + 1); }
  let boxes = 0, other = 0;
  size.forEach(n => { if (n === 8) boxes++; else other++; });
  return { boxes, other };
}

const REPAIR = loadRepairModule(path.join(ROOT, 'NSO_Repair.js'));
/* piercing / coplanar pairs (NSO_Repair.js, welded at 1e-6 as the checker
   below); inSheet: piercing pairs with a triangle reaching above zSheet;
   atFeet: piercing pairs wholly in the 0.2 mm foot layer */
function selfint(soup, zSheet) {
  const m = REPAIR._weldToIndexed(soup, 1e-6).mesh, d = REPAIR._selfIntersectionDetail(m, { collect: true });
  const zs = (f) => [0, 1, 2].map(k => m.pos[m.faces[f * 3 + k] * 3 + 2]);
  let inSheet = 0, atFeet = 0;
  d.pairs.forEach(p => {
    if (p.kind !== 'pierce') return;
    const za = zs(p.a), zb = zs(p.b);
    if (Math.max(...za, ...zb) > zSheet) inSheet++;
    if (Math.max(...za, ...zb) <= 0.2 + 1e-3) atFeet++;
  });
  return { pierce: d.pierce, coplanar: d.coplanar, inSheet, atFeet };
}
const validate = (file) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--weld', '1e-6', '--no-selfint'],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const csg = csgContext();
  ctx.NSO_unionSoups = csg.NSO_unionSoups; ctx.NSO_subtractSoups = csg.NSO_subtractSoups;
  const exportObjects = [];
  const report = [];

  for (const [name, piece, tag] of PIECES) {
    console.log('\n=== ' + name + ' ===');
    const T = { plan: 0, parts: 0, partsBare: 0, weld: 0, weldBare: 0 };
    const det = SA.detectOverhangs(piece, { skipList: [], angleDeg: CARD.angleDeg, occluders: [] });
    if (!det.ok || !det.beaconRegions) { check(name + ': detects', false, det.reason); continue; }
    if (tag === 'clamp') exportObjects.push({ name: 'clamp_body', soup: piece });
    /* the piece's own surface in triangles of 2 mm at most, for the sampler:
       the same surface, so the same distances - its nearest-face grid takes
       its cell from the mean triangle, and the clamp's ceilings are a few
       big triangles every probe would scan */
    const fine = splitSoup(piece, 2);
    for (const rg of det.beaconRegions) {
      const label = name + ' area ' + (rg.id + 1);
      const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'k' }));
      let t = Date.now();
      const p = ST.planTree(piece, Object.assign({}, CARD, { beacons: bs }));
      T.plan += Date.now() - t;
      if (!p.ok) { console.log('  --    ' + label + ': the planner holds nothing here (' + p.reason + ')'); continue; }
      /* the build as it was: for the time it took, and its feet */
      t = Date.now();
      const tp0 = await GP.parts(p, {});
      T.partsBare += Date.now() - t; t = Date.now();
      const w0 = await GP.weld(p, tp0, {});
      T.weldBare += Date.now() - t;
      /* the build with the sheet */
      t = Date.now();
      /* as the card builds it: the sheet's layers left as they are (weld() folds them itself) */
      const tp = await GP.parts(p, { interface: true, foldSheets: false });
      T.parts += Date.now() - t;
      if (!tp.ok) { check(label + ': builds with the sheet', false, tp.reason); continue; }
      t = Date.now();
      const w = await GP.weld(p, tp, {});
      T.weld += Date.now() - t;
      if (!w.ok) { check(label + ': welds with the sheet', false, w.reason); continue; }
      const sh = tp.sheet, c = sh.counts;
      console.log('  --    ' + label + ': ' + rg.beacons.length + ' spots, z ' +
        f3(Math.min(...rg.beacons.map(b => b.z))) + '..' + f3(Math.max(...rg.beacons.map(b => b.z))) +
        '; tips: ' + c.sheet + ' under a sheet, ' + c.gap + ' cut at the gap, ' + c.side + ' side');
      const why = {};
      sh.tips.filter(x => x.mode !== 'sheet' || x.carried === false).forEach(x => { const k = x.mode + ': ' + (x.why || 'held off its face'); why[k] = (why[k] || 0) + 1; });
      Object.keys(why).forEach(k => console.log('          ' + why[k] + ' x ' + k));

      /* 1. the stack */
      const flatTips = sh.tips.filter(x => x.mode !== 'side').length;
      if (flatTips && sh.levels.length === 0) {
        const allGapWhy = sh.tips.filter(x => x.mode === 'gap').map(x => x.why);
        console.log('          no sheet: ' + [...new Set(allGapWhy)].join('; '));
      }
      for (const L of sh.levels) {
        const roles = L.layers.map(x => x.role).join(',');
        const hs = L.layers.map(x => x.z1 - x.z0);
        const ceiling = Math.min(...L.tips.map(i => sh.tips[i].zTop)) + GAP;
        check(`${label}, sheet at ${f3(L.zTop)}: 2 interface layers and no transition layer, each one ${LAYER} mm layer, the top ${GAP} mm under the ceiling`,
          roles === 'interface,interface' && hs.every(h => Math.abs(h - LAYER) < 1e-9) &&
          Math.abs(L.layers[1].z1 - L.zTop) < 1e-6 && Math.abs(L.layers[0].z0 - L.zBase) < 1e-6,
          `${L.tips.length} tips, layers ${L.layers.map(x => f3(x.z0) + '-' + f3(x.z1)).join(' | ')}, ceiling ${f3(ceiling)}`);
        /* 1b. the caps */
        const CAP = SI.CAP, tipsHere = L.tips.map(i => sh.tips[i]), carried = tipsHere.filter(t => t.carried !== false);
        const caps = tipsHere.filter(t => t.cap).map(t => t.cap);
        const gapsOf = caps.map(c => caps.length < 2 ? null : Math.min(...caps.filter(d => d !== c).map(d => Math.hypot(d.c[0] - c.c[0], d.c[1] - c.c[1]) - (c.w + d.w) / 2)));
        const inRange = caps.filter(c => c.w >= CAP.minMm - 1e-9 && c.w <= CAP.maxMm + 1e-9).length;
        /* a cap under CAP.minMm was held short of a neighbour (tips under
           2.55 mm apart: caps never overlap) or narrowed off the piece */
        const shortOk = caps.every(c => (c.w >= CAP.minMm - 1e-9 && c.w <= CAP.maxMm + 1e-9) ||
          (c.w < CAP.minMm && /held short of a neighbour|piece|another support/.test(c.why || '')));
        const capless = carried.filter(t => !t.cap);
        const narrowWhy = {};
        caps.filter(c => c.w < CAP.minMm - 1e-9).forEach(c => { const k = (c.why || '').replace(/[\d.]+ mm away/, 'n mm away'); narrowWhy[k] = (narrowWhy[k] || 0) + 1; });
        check(`${label}, sheet at ${f3(L.zTop)}: every tip under it ends in a flat cap ${CAP.minMm} - ${CAP.maxMm} mm across, narrower only short of a neighbour or the piece`,
          caps.length > 0 && shortOk && capless.every(t => /no room for a cap/.test(t.why || '')),
          `${caps.length} caps on ${carried.length} tips (${capless.length} with no room for one); ${inRange} of ${caps.length} at ${CAP.minMm} - ${CAP.maxMm} mm, ` +
          `widths ${f3(Math.min(...caps.map(c => c.w)))} - ${f3(Math.max(...caps.map(c => c.w)))}` +
          (Object.keys(narrowWhy).length ? '; narrower: ' + Object.keys(narrowWhy).map(k => narrowWhy[k] + ' x ' + k).join(', ') : ''));
        const gs = gapsOf.filter(g => g != null);
        check(`${label}, sheet at ${f3(L.zTop)}: every cap's nearest neighbour ${CAP.gapMaxMm} mm or less away edge to edge, and none over another`,
          gs.length === 0 || (Math.max(...gs) <= CAP.gapMaxMm + 1e-9 && Math.min(...gs) >= SI.CAP.partMm - 1e-6),
          gs.length ? `nearest-neighbour gaps ${f3(Math.min(...gs))} - ${f3(Math.max(...gs))} mm` : 'one cap');
        /* measured on the parts built, not read back off the plan: I1's
           lowest point, and the top of every part that ends just above it */
        const sheetPart = tp.trunks.find(tr => tr.sheet === L.id);
        let zI1 = Infinity;
        if (sheetPart) { const s0 = sheetPart.parts[0].soup; for (let i = 2; i < s0.length; i += 3) zI1 = Math.min(zI1, s0[i]); }
        const builtCaps = [];
        tp.trunks.forEach(tr => { if (tr.sheet != null) return; tr.parts.forEach(pt => {
          if (pt.pad) return;
          let lo = Infinity, hi = -Infinity; for (let i = 2; i < pt.soup.length; i += 3) { lo = Math.min(lo, pt.soup[i]); hi = Math.max(hi, pt.soup[i]); }
          if (hi > zI1 + 5e-3 && hi < zI1 + 0.05 && hi - lo > 0.5) builtCaps.push(hi - zI1);
        }); });
        check(`${label}, sheet at ${f3(L.zTop)}: the interface's underside lies exactly on the caps (their flat tops ${SI.CAP.intoMm} mm into it), measured on the parts built`,
          builtCaps.length === caps.length && builtCaps.every(d => Math.abs(d - SI.CAP.intoMm) < 2e-5),
          `${builtCaps.length} cap part(s) for ${caps.length} cap(s), tops ${builtCaps.length ? f4(Math.min(...builtCaps)) + ' - ' + f4(Math.max(...builtCaps)) : '-'} mm into I1 (its underside at ${f4(zI1)})`);
        /* 1c. one box a line, none under 2 mm - in the plan and in the parts built */
        const sheetEntry = tp.trunks.find(tr => tr.sheet === L.id);
        const boxCounts = sheetEntry ? sheetEntry.parts.map(pt => boxesIn(pt.soup)) : [];
        check(`${label}, sheet at ${f3(L.zTop)}: every line one straight box (8 vertices, two ends), none shorter than ${SI.SHEET.minRunMm} mm`,
          L.layers.every(x => x.paths.every(q => q.length === 2 && Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) >= SI.SHEET.minRunMm - 1e-9)) &&
          boxCounts.length === L.layers.length && boxCounts.every((b, k) => b.boxes === L.layers[k].lines && b.other === 0),
          L.layers.map((x, k) => `${x.lines} lines, ${boxCounts[k] ? boxCounts[k].boxes : '-'} boxes, shortest ${f3(x.shortestMm)} mm`).join(' | '));
        /* 2. the lines, off the welded solid */
        const under = lineIndex(L);
        const lines = L.layers.map(x => layerLines(sliceAt(w.soup, (x.z0 + x.z1) / 2), (px, py) => under(px, py, 0.3), sh.widthMm));
        const dirs = lines.map(l => l ? l.dir : NaN);
        const alt = dirs.every((d, k) => k === 0 || Math.abs(Math.abs(d - dirs[k - 1]) - 90) <= 1);
        check(`${label}, sheet at ${f3(L.zTop)}: one direction per layer, each across the one below`,
          lines.every(l => l && l.oneDirShare >= 0.75) && alt,
          `layers at ${dirs.map(d => d + ' deg').join(' / ')}, one-direction share ${lines.map(l => l ? l.oneDirShare.toFixed(3) : '-').join(' / ')}`);
        const pitchOk = lines.every(l => l && l.medianPitch != null && Math.abs(l.medianPitch - PITCH) <= 0.05 && l.offGrid === 0);
        check(`${label}, sheet at ${f3(L.zTop)}: line pitch ${PITCH} +- 0.05 mm, measured on the welded support`,
          pitchOk, lines.map(l => l ? `${l.lines} lines, median ${f3(l.medianPitch)}, ${l.adjacent} adjacent pairs at ${PITCH}+-0.05, ${l.offGrid} off the pitch` : '-').join(' | '));
        report.push({ label, zTop: L.zTop, tips: L.tips.length, angle: L.lines, caps: L.caps.length, lines });
        /* 4. no tip above the sheet's underside */
        let above = 0, worst = -Infinity;
        tp.trunks.forEach(tr => {
          if (tr.sheet != null) return;
          tr.parts.forEach(pt => {
            const s = pt.soup;
            for (let i = 0; i < s.length; i += 3) {
              const z = s[i + 2];
              if (z <= L.zBase + Math.max(EPS, SI.CAP.intoMm) + 1e-4 || z > L.zTop + GAP) continue;
              if (!under(s[i], s[i + 1], 0.21 + 0.05)) continue;
              above++; worst = Math.max(worst, z - L.zBase);
            }
          });
        });
        check(`${label}, sheet at ${f3(L.zTop)}: no tip reaches above the sheet's underside (${f3(L.zBase)}) under its lines, but a cap's ${SI.CAP.intoMm} mm into it`,
          above === 0, above ? `${above} vertices, up to ${f3(worst)} mm above it` : 'every tip under it ends in its cap, or is cut flat at ' + f3(L.zBase + EPS));
      }
      /* 3. THE GAP, in two parts.
         THE INTERFACE ZONE - the sheet, every tip, and everything within
         ZONE_MM under the lowest contact - is what this build makes: its TRUE
         minimum distance to the piece, over every triangle of it, is the gap.
         Measured exactly (exactDistance: every triangle pair in reach, closed
         form) and, as a cross-check where it can be afforded, with the
         sampler finish() measures with (minDistance), at a 0.4 mm step over
         the zone's triangles within REACH of the piece, against the piece
         split into triangles of 2 mm or less (the same surface; its lookup
         grid takes its cell from the mean triangle). A flat top lying exactly
         the gap under a ceiling is the sampler's worst case - no bound prunes
         it - so on a zone of more than SAMPLE_MAX triangles near the piece
         (the clamp's area 1: 8.7 million refinements, 150 s) the exact
         distance stands alone.
         BELOW THE ZONE the trunks and the feet are the planner's, built as
         before: no nearer the piece than in the bare build (a side tip drawn
         back is farther), whatever that is (reported; under the gap is the
         planner's, not this build's). */
      t = Date.now();
      const REACH = 0.3, FOOT = 0.2 + 1e-3, ZONE_MM = 3, SAMPLE_MAX = 4000;
      const zZone = Math.min(...p.stations.map(st => st.contact[2])) - ZONE_MM;
      const zoneOf = (S) => band(S, Math.max(zZone, FOOT), Infinity), restOf = (S) => band(S, FOOT, Math.max(zZone, FOOT));
      const zone = zoneOf(w.soup), near = cropNear(zone, piece, REACH);
      const exact = SI.exactDistance(zone, piece, { reach: 1 });
      const te = Date.now() - t; t = Date.now();
      const sampled = !near.length ? { mm: Infinity, step: 0.4 }
        : near.length / 9 <= SAMPLE_MAX ? SI.minDistance(near, fine, { thickness: ctx.NSO_Thickness, reach: REACH, step: 0.4 }) : null;
      check(`${label}: the interface zone (z > ${f3(zZone)}: sheet, tips, ${ZONE_MM} mm under the lowest contact) keeps the ${GAP} mm gap - true minimum distance`,
        exact.mm >= GAP - 1e-5 && (!sampled || (sampled.mm >= GAP - 1e-5 && (sampled.mm === Infinity || Math.abs(sampled.mm - exact.mm) < 2e-3))),
        `exact ${exact.mm.toFixed(6)} mm over ${zone.length / 9} triangles (${te} ms); ` +
        (sampled ? `minDistance ${f4(sampled.mm)} mm (sampled at ${sampled.step} mm over the ${near.length / 9} within ${REACH} mm, ${Date.now() - t} ms)`
                 : `minDistance not sampled: ${near.length / 9} triangles within ${REACH} mm, over ${SAMPLE_MAX}`));
      const fmt = d => d === Infinity ? 'over 1 mm' : d.toFixed(4) + ' mm';
      const r0 = SI.exactDistance(restOf(w0.soup), piece, { reach: 1 }).mm, r1 = SI.exactDistance(restOf(w.soup), piece, { reach: 1 }).mm;
      check(`${label}: below the zone the trunks are no nearer the piece than they were`,
        r1 >= r0 - 1e-6,
        `${fmt(r1)} with the sheet, ${fmt(r0)} without` + (r1 < GAP ? ' (UNDER the gap: the planner\'s trunk, not this build - its rails are kept 0.2 mm off on rays)' : ''));
      const feet0 = SI.exactDistance(feetOf(w0.soup, FOOT), piece, { reach: 1 }).mm, feet1 = SI.exactDistance(feetOf(w.soup, FOOT), piece, { reach: 1 }).mm;
      check(`${label}: the feet are as they were - their distance to the piece unchanged by the sheet`,
        Math.abs(feet0 - feet1) < 1e-6 || (feet0 === Infinity && feet1 === Infinity),
        `${fmt(feet1)} with the sheet, ${fmt(feet0)} without` + (feet1 < GAP ? ' (UNDER the gap: a trunk\'s own end in its pad - the pads keep 0.2 mm, the planner keeps the trunk off on rays)' : ''));
      /* 6. the feet: one pad per cluster, the trunks on a pad one support */
      /* each pad against the piece, and against the trunks standing on IT:
         a pad is always under its trunks' own end squares, so where the
         planner stood one nearer the piece than the gap, that pad may come as
         near as that trunk - and no nearer */
      const padSoups = [], trunkFoot = {};
      tp.trunks.forEach(tr => { trunkFoot[tr.trunk] = tr.parts.filter(pt => !pt.pad).map(pt => feetOf(pt.soup, FOOT)); });
      let padD = Infinity, colD = Infinity, padsUnder = 0;
      tp.trunks.forEach(tr => tr.parts.forEach(pt => {
        if (!pt.pad) return;
        padSoups.push(pt.soup);
        const dP = SI.exactDistance(pt.soup, piece, { reach: 1 }).mm;
        const own = [].concat(...(pt.keys || [tr.trunk]).map(t => trunkFoot[t] || []));
        const dT = own.length ? SI.exactDistance(new Float32Array([].concat(...own.map(x => Array.from(x)))), piece, { reach: 1 }).mm : Infinity;
        if (dP < Math.min(GAP, dT) - 1e-6) padsUnder++;
        if (dP < padD) { padD = dP; colD = dT; }
      }));
      const shl = GP.shells(p, tp), solidOf = {};
      shl.solids.forEach((x, k) => x.trunks.forEach(t => { solidOf[t] = k; }));
      /* RECOUNTED HERE, not read off the engine's counters: the clusters from
         the feet (6 mm, single linkage), each foot on a built pad (its centre
         inside the pad's top face) of a trunk in its own support, and every
         cluster in one support - but for a foot the piece hems in, measured
         here: no point on rings just outside its end square stands the gap
         clear of the piece through the slab */
      const feetL = tp.feet || [], par = feetL.map((f, i) => i), find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
      for (let a = 0; a < feetL.length; a++) for (let b = a + 1; b < feetL.length; b++) if (Math.hypot(feetL[a].c[0] - feetL[b].c[0], feetL[a].c[1] - feetL[b].c[1]) <= 6 + 1e-9) par[find(a)] = find(b);
      const padParts = [];
      tp.trunks.forEach(tr => tr.parts.forEach(pt => { if (pt.pad) padParts.push({ owner: tr.trunk, soup: pt.soup }); }));
      const onTop = (soup, x, y) => {
        let zt = -Infinity; for (let i = 2; i < soup.length; i += 3) zt = Math.max(zt, soup[i]);
        for (let t = 0; t < soup.length; t += 9) {
          if (!(Math.abs(soup[t + 2] - zt) < 1e-5 && Math.abs(soup[t + 5] - zt) < 1e-5 && Math.abs(soup[t + 8] - zt) < 1e-5)) continue;
          const ax = soup[t], ay = soup[t + 1], bx = soup[t + 3], by = soup[t + 4], cx = soup[t + 6], cy = soup[t + 7];
          const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by), d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy), d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
          if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
        }
        return false;
      };
      const PR = ctx.NSO_Thickness.prepare(piece, {}), plateZ0 = p.plateZ || 0;
      const hemmedHere = f => {
        const rIn = f.r * Math.SQRT1_2;
        for (let dr = 0.05; dr <= GAP + 0.2 + 1e-9; dr += 0.05) for (let k = 0; k < 36; k++) {
          const a = 2 * Math.PI * k / 36, x = f.c[0] + (rIn + dr) * Math.cos(a), y = f.c[1] + (rIn + dr) * Math.sin(a);
          let clear = true;
          for (let z = 0.02; z <= FOOT + GAP + 1e-9 && clear; z += 0.06) {
            const q = [x, y, plateZ0 + z];
            if (PR.inside(q)) { clear = false; break; }
            const hit = PR.nearest(q, GAP); if (hit && hit.dist < GAP) clear = false;
          }
          if (clear) return false;
        }
        return true;
      };
      let offPad = 0, split = 0, hemmedN = 0;
      feetL.forEach(f => {
        const mine = padParts.filter(pd => onTop(pd.soup, f.c[0], f.c[1]));
        if (!mine.some(pd => solidOf[pd.owner] === solidOf[f.trunk]) && !hemmedHere(f)) offPad++;
      });
      const groups = {};
      feetL.forEach((f, i) => (groups[find(i)] || (groups[find(i)] = [])).push(f));
      Object.values(groups).forEach(fs => {
        const bySolid = {};
        fs.forEach(f => (bySolid[solidOf[f.trunk]] || (bySolid[solidOf[f.trunk]] = [])).push(f));
        const parts = Object.values(bySolid).sort((u, v) => v.length - u.length);
        if (parts.length < 2) return;
        if (parts.slice(1).every(pt => pt.every(hemmedHere))) hemmedN++; else split++;
      });
      const onPads = p.trunks.filter(tr => tr.landing === 'plate').length;
      check(`${label}: feet - ${tp.pads.count} pad(s) under ${onPads} trunk(s) on the plate, every cluster of feet (6 mm) in one support and every foot on a pad of it (counted here), the pads ${GAP} mm or more off the piece (or no nearer than the trunk standing there)`,
        tp.pads.count >= 1 && feetL.length === onPads && offPad === 0 && split === 0 && padsUnder === 0 && padSoups.length === tp.pads.count,
        `${Object.keys(groups).length} cluster(s), ${split} split, ${hemmedN} with a foot the piece hems in, ${offPad} foot/feet on no pad of their support (engine: ${tp.pads.clustersSplit} split); ` +
        `pads ${(tp.pads.areasMm2 || []).map(a => a.toFixed(0) + ' mm2').join(', ')}; ` +
        `closest pad to the piece ${fmt(padD)} (its own trunks ${fmt(colD)}), ${padsUnder} pad(s) nearer than the gap and their trunks; ${shl.solids.length} support(s)`);
      /* 5. solids: closed, manifold, no degenerate triangle (the canonical
         checker, tools/mesh_validate.py), and NO PIERCING PAIR IN THE SHEET:
         none with a triangle above the sheet's underside. Self-intersection
         is counted by NSO_Repair.js's BVH count, held pair-for-pair to
         mesh_validate.py by selfint:equiv - the Python pass needs more
         memory than this machine has past ~60k triangles (killed at 14 GB on
         the clamp's 190k-triangle area 1). The whole solid's counts are
         reported beside the bare build's: the planner's trees and pads carry
         their own (pre-existing; nearly all of them in the pads at z 0). */
      const file = path.join(OUT, `${tag}_area${rg.id + 1}.stl`), file0 = path.join(OUT, `${tag}_area${rg.id + 1}_bare.stl`);
      writeSTL(file, w.soup, 'NSO support with sheet ' + label);
      writeSTL(file0, w0.soup, 'NSO support without sheet ' + label);
      const v = validate(file);
      const si = selfint(w.soup, sh.levels.length ? Math.min(...sh.levels.map(L => L.zBase)) + 0.01 : Infinity), si0 = selfint(w0.soup, Infinity);
      check(`${label}: ${w.solids.length} solid(s), closed, manifold, no degenerate triangle, no piercing pair in the sheet; no sheet standing alone`,
        v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 && v.inconsistent_winding_edges === 0 &&
        si.inSheet === 0 && w.sheetsAlone === 0 && w.detached === 0,
        `${v.triangles} tris, open ${v.open_edges}, nm ${v.nonmanifold_edges}, mis-wound ${v.inconsistent_winding_edges}, degenerate ${v.degenerate_tris}; ` +
        `piercing pairs in the sheet ${si.inSheet}; whole solid pierce ${si.pierce} / coplanar ${si.coplanar} (bare ${si0.pierce} / ${si0.coplanar}, ${si0.atFeet} of its piercing in the pads); alone ${w.sheetsAlone}, detached ${w.detached}`);
      if (tag === 'clamp') w.solids.forEach((x, k) => exportObjects.push({ name: `support ${rg.id + 1}.${k + 1}`, soup: x.soup }));
    }
    console.log(`  time  ${name}: plan ${T.plan} ms; parts ${T.partsBare} -> ${T.parts} ms, weld ${T.weldBare} -> ${T.weld} ms (without -> with the sheet)`);
  }

  /* THE COUPON AS THE CARD BUILDS IT: every area planned, built with its
     trunks on their feet and no pad (app-supports-card.js PARTS_OPTS), handed
     back as shells, then the pads drawn over every area at once (shareFeet) */
  {
    console.log('\n=== top_clip_x2: the card\'s build, across its areas ===');
    const piece = PIECES.find(x => x[2] === 'coupon')[1];
    const t0 = Date.now();
    const det = SA.detectOverhangs(piece, { skipList: [], angleDeg: CARD.angleDeg, occluders: [] });
    const builds = [];
    let plateZ = 0;
    for (const rg of det.beaconRegions) {
      const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'k' }));
      const p = ST.planTree(piece, Object.assign({}, CARD, { beacons: bs }));
      if (!p.ok) continue;
      plateZ = p.plateZ;
      const tp = await GP.parts(p, { interface: true, foldSheets: false, footPads: 'shared' });
      builds.push({ p, tp, sh: GP.shells(p, tp) });
    }
    const sf = GP.shareFeet(builds.map(b => ({ solids: b.sh.solids })), piece, { plateZ });
    const ms = Date.now() - t0;
    check('top_clip_x2: the card\'s build - detect, plan, build every area, shells, shared feet - in under 10 s',
      sf.ok && ms < 10000, `${ms} ms; ${builds.length} area(s); ${sf.reason}`);
    check('top_clip_x2: every cluster of feet on one pad, whatever area its trees hold; the slab\'s and the leg\'s trees on one pad are ONE support',
      sf.ok && sf.clustersSplit === 0 && sf.objects.length === 1 && sf.objects[0].from.length === builds.reduce((n, b) => n + b.sh.solids.length, 0) && sf.pads === 1,
      sf.ok ? `${sf.pads} pad(s), ${sf.clusters} cluster(s), ${sf.objects.length} support(s): ` + sf.objects.map(o => JSON.stringify(o.from)).join(' ') : sf.reason);
    /* no two supports' first layers touch: the path conflict Bambu reported between support 1.1 and 2.2 */
    let closest = Infinity;
    for (let a = 0; a < sf.objects.length; a++) for (let b = a + 1; b < sf.objects.length; b++) {
      closest = Math.min(closest, SI.exactDistance(feetOf(sf.objects[a].soup, 0.2 + 1e-3), feetOf(sf.objects[b].soup, 0.2 + 1e-3), { reach: 1 }).mm);
    }
    check('top_clip_x2: no two supports\' first layers within 0.1 mm of each other', closest >= 0.1,
      sf.objects.length > 1 ? `closest ${closest === Infinity ? 'over 1 mm' : closest.toFixed(4) + ' mm'}` : 'one support');
  }

  if (EXPORT && exportObjects.length) {
    const NSO3MF = require(path.join(ROOT, 'nso-3mf.js'));
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    exportObjects.forEach(o => { for (let i = 0; i < o.soup.length; i += 3) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], o.soup[i + k]); hi[k] = Math.max(hi[k], o.soup[i + k]); } });
    const dx = 90 - (lo[0] + hi[0]) / 2, dy = 90 - (lo[1] + hi[1]) / 2;   /* on the middle of a 180 mm plate */
    const objects = exportObjects.map(o => {
      const s = new Float32Array(o.soup);
      for (let i = 0; i < s.length; i += 3) { s[i] += dx; s[i + 1] += dy; }
      const m = NSO3MF.indexTriangleSoup(Array.from(s));
      return { name: o.name, vertices: m.vertices, triangles: m.triangles };
    });
    const built = await NSO3MF.build3MF({ objects, plateName: 'clamp_body with interface sheets' });
    const file = path.join(OUT, 'clamp_body_sheet.3mf');
    fs.writeFileSync(file, Buffer.from(built.bytes));
    console.log('\n  wrote ' + path.relative(ROOT, file) + ' (' + objects.length + ' objects)');
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
