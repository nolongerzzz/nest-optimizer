#!/usr/bin/env node
/* ============================================================
   tools/nso_support_bambu_joins.js - THE JOINS OF BAMBU'S OWN TREE
   (supports-thinning-1; docs/SUPPORT-GRIDPACK.md section 8).

   The custom tree builds its joins to Bambu's numbers. This tool measures
   them from a sliced project's G-code: no angle and no thickness here is
   invented, and nso_support_gridpack.js's JOINS table is this tool's answer.

     node tools/nso_support_bambu_joins.js [file.gcode.3mf ...]
         default: fixtures/supports/simple_overhang_bambu.gcode.3mf (the P1S
         slice of the same part is the same tree). Prints every join and the ranges.
     node tools/nso_support_bambu_joins.js --json   the same as JSON

   HOW. Every `Support` extrusion of a layer is drawn on a 0.1 mm raster at
   its line width; what the loops close round is filled; the connected
   pieces are the layer's ISLANDS (area, centroid, principal axes). Islands
   of layer k and k+1 are linked where their cells overlap. A JOIN, read
   going up the tree, is an island that has two or more islands above it
   (the first layer where one piece has become several, or one piece several
   in the layer before). Measured at each join:

     parent    the island under the split, the average of its last 3 layers;
               its diameter is the circle of equal area (2 sqrt(A / pi)).
     child_i   each island above, the average of its first 3 layers after the
               split; its diameter likewise.
     ratio     parent / child diameter, for the widest child ("the parent
               against the child that carries on"), and parent / sqrt(sum of
               the children's diameters squared) ("the parent against the
               children's total area").
     lean      each side's direction is the line through its islands'
               centroids over the 3 mm (15 layers) on its side of the split:
               the parent's below it, a child's above it. Its angle off
               vertical, and the BRANCH ANGLE: the angle between a child's
               direction and the parent's (both seen going UP, so a branch
               that carries straight on is 0 deg).
     fan       the angle between two children's directions at a split.

   Only a join whose parent and children each stand at least MIN_RUN layers
   as single islands is kept (a join that is a layer of contact between two
   unrelated pieces is not a branch). Layers with a part's cut (an island
   touching the part's own first layers) do not exist for Support features.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AUD = require('./nso_slicer_audit.js');

const ROOT = path.join(__dirname, '..');
const CELL = 0.1;          /* mm: the raster */
const RUN = 2;             /* layers averaged on each side of a join */
const SPAN_LAYERS = 12;    /* layers (2.4 mm at 0.2) a direction is read over */
const MIN_RUN = 4;         /* layers a piece must stand to be a branch */
const TAPER_MIN = 40;      /* layers (8 mm) a stretch must stand to fit a taper: a trunk; shorter stretches between joins absorb a neighbour and read wrong */

/* a .gcode.3mf is a zip: Metadata/plate_1.gcode out of it, with no library */
function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), nm = buf.toString('utf8', p + 46, p + 46 + nl);
    if (nm === name) {
      const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28), data = buf.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nl + el + cl;
  }
  throw new Error(name + ' not in the zip');
}

function layersOf(gcode) {
  const lw = +(/; support_line_width = ([\d.]+)/.exec(gcode) || [0, 0.42])[1];
  const byZ = new Map();
  AUD.extrusions(gcode).filter(m => m.feat === 'Support').forEach(m => {
    if (!byZ.has(m.z)) byZ.set(m.z, []);
    byZ.get(m.z).push(m);
  });
  return { lw, zs: [...byZ.keys()].sort((a, b) => a - b), byZ };
}

/* the islands of one layer: { area, cx, cy, ax, ay (principal axis, unit), a, b (semi-axes of the equal-moment ellipse), cells: Set } */
function islandsOf(moves, lw, box) {
  const W = Math.ceil((box[2] - box[0]) / CELL) + 8, H = Math.ceil((box[3] - box[1]) / CELL) + 8;
  const g = new Uint8Array(W * H), r = Math.ceil(lw / 2 / CELL);
  const put = (x, y) => {
    const i = Math.round((x - box[0]) / CELL) + 4, j = Math.round((y - box[1]) / CELL) + 4;
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) if (a * a + b * b <= r * r + 0.5) g[(j + b) * W + i + a] = 1;
  };
  for (const m of moves) {
    const P = m.pts || [[m.x0, m.y0], [m.x1, m.y1]];
    for (let q = 0; q + 1 < P.length; q++) {
      const n = Math.max(1, Math.ceil(Math.hypot(P[q + 1][0] - P[q][0], P[q + 1][1] - P[q][1]) / (CELL / 2)));
      for (let s = 0; s <= n; s++) put(P[q][0] + (P[q + 1][0] - P[q][0]) * s / n, P[q][1] + (P[q + 1][1] - P[q][1]) * s / n);
    }
  }
  /* fill what the loops close: flood the outside, everything else is solid */
  const out = new Uint8Array(W * H), st = [0];
  out[0] = 1;
  while (st.length) {
    const c = st.pop(), x = c % W, y = (c - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const k = ny * W + nx;
      if (!out[k] && !g[k]) { out[k] = 1; st.push(k); }
    }
  }
  const lab = new Int32Array(W * H).fill(-1), isl = [];
  for (let s = 0; s < W * H; s++) {
    if (out[s] || lab[s] >= 0) continue;
    const id = isl.length, cells = [];
    lab[s] = id; st.push(s);
    while (st.length) {
      const c = st.pop(); cells.push(c);
      const x = c % W, y = (c - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (!out[k] && lab[k] < 0) { lab[k] = id; st.push(k); }
      }
    }
    let sx = 0, sy = 0;
    cells.forEach(c => { const x = c % W, y = (c - x) / W; sx += x; sy += y; });
    const cx = sx / cells.length, cy = sy / cells.length;
    let xx = 0, yy = 0, xy = 0;
    cells.forEach(c => { const x = c % W - cx, y = (c - (c % W)) / W - cy; xx += x * x; yy += y * y; xy += x * y; });
    xx /= cells.length; yy /= cells.length; xy /= cells.length;
    const tr = xx + yy, de = Math.sqrt(Math.max(0, (xx - yy) * (xx - yy) / 4 + xy * xy)), l1 = tr / 2 + de, l2 = Math.max(0, tr / 2 - de);
    const th = 0.5 * Math.atan2(2 * xy, xx - yy);
    isl.push({ id, cells, area: cells.length * CELL * CELL, cx: box[0] + (cx - 4) * CELL, cy: box[1] + (cy - 4) * CELL,
               ax: Math.cos(th), ay: Math.sin(th), a: 2 * Math.sqrt(l1) * CELL, b: 2 * Math.sqrt(l2) * CELL });
  }
  return { isl, lab, W, H };
}

function measure(file) {
  const buf = fs.readFileSync(file);
  const gcode = unzipEntry(buf, 'Metadata/plate_1.gcode').toString('utf8');
  const { lw, zs, byZ } = layersOf(gcode);
  const pts = [];
  for (const z of zs) for (const m of byZ.get(z)) (m.pts || [[m.x0, m.y0], [m.x1, m.y1]]).forEach(p => pts.push(p));
  const box = [Math.min(...pts.map(p => p[0])) - 1, Math.min(...pts.map(p => p[1])) - 1, Math.max(...pts.map(p => p[0])) + 1, Math.max(...pts.map(p => p[1])) + 1];
  const L = zs.map(z => ({ z, ...islandsOf(byZ.get(z), lw, box) }));
  /* links up: island of layer k -> islands of layer k+1 whose cells overlap */
  const up = L.map(() => new Map()), down = L.map(() => new Map());
  for (let k = 0; k + 1 < L.length; k++) {
    const A = L[k], B = L[k + 1];
    A.isl.forEach(ia => {
      const hit = new Set();
      ia.cells.forEach(c => { const j = B.lab[c]; if (j >= 0) hit.add(j); });
      up[k].set(ia.id, [...hit]);
      hit.forEach(j => { if (!down[k + 1].has(j)) down[k + 1].set(j, []); down[k + 1].get(j).push(ia.id); });
    });
  }
  const dEq = I => 2 * Math.sqrt(I.area / Math.PI);
  /* a straight run of single-parent single-child islands from (k, id) in direction dir (+1 up, -1 down), up to n layers */
  const run = (k, id, dir, n) => {
    const out = [{ k, i: L[k].isl[id] }];
    let kk = k, ii = id;
    for (let s = 0; s < n; s++) {
      const nx = dir > 0 ? up[kk].get(ii) : (down[kk].get(ii) || []);
      if (!nx || nx.length !== 1) break;
      const back = dir > 0 ? (down[kk + 1].get(nx[0]) || []) : (up[kk - 1].get(nx[0]) || []);
      if (back.length !== 1) break;
      kk += dir; ii = nx[0];
      out.push({ k: kk, i: L[kk].isl[ii] });
    }
    return out;
  };
  const dirOf = (r, dir) => {      /* unit 3D vector of a run, seen going UP, from its centroids (least squares in z) */
    if (r.length < 3) return null;
    const zc = r.map(q => L[q.k].z), mz = zc.reduce((a, b) => a + b, 0) / zc.length;
    let sxx = 0, sxz = 0, syz = 0;
    r.forEach((q, n) => { const dz = zc[n] - mz; sxx += dz * dz; });
    const mx = r.reduce((a, q) => a + q.i.cx, 0) / r.length, my = r.reduce((a, q) => a + q.i.cy, 0) / r.length;
    r.forEach((q, n) => { const dz = zc[n] - mz; sxz += dz * (q.i.cx - mx); syz += dz * (q.i.cy - my); });
    const v = [sxz / sxx, syz / sxx, 1], l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
  const off = a => Math.acos(Math.max(-1, Math.min(1, a[2]))) * 180 / Math.PI;
  const avgD = r => r.reduce((a, q) => a + dEq(q.i), 0) / r.length;
  const joins = [];
  for (let k = 1; k + 1 < L.length; k++) {
    L[k].isl.forEach(ip => {
      const ch = up[k].get(ip.id) || [];
      /* a join: this island has two or more above it, each standing on this one alone */
      if (ch.length < 2) return;
      if (ch.some(j => (down[k + 1].get(j) || []).length !== 1)) return;
      /* the parent's run below, the children's runs above */
      const pr = run(k, ip.id, -1, SPAN_LAYERS);
      if (pr.length < MIN_RUN) return;
      const crs = ch.map(j => run(k + 1, j, +1, SPAN_LAYERS));
      if (crs.some(r => r.length < MIN_RUN)) return;
      /* the parent's average over its last RUN layers (the join layer and those below), a child's over its first RUN */
      const pD = avgD(pr.slice(0, RUN)), cD = crs.map(r => avgD(r.slice(0, RUN)));
      const pDir = dirOf(pr.slice().reverse(), +1), cDir = crs.map(r => dirOf(r, +1));
      if (!pDir || cDir.some(d => !d)) return;
      const wide = Math.max(...cD), sumsq = Math.sqrt(cD.reduce((a, d) => a + d * d, 0));
      joins.push({
        z: L[k].z, at: [ip.cx, ip.cy], n: ch.length,
        parentD: pD, childD: cD, ratioWidest: pD / wide, ratioTotal: pD / sumsq,
        parentLean: off(pDir), childLean: cDir.map(off), branchAngle: cDir.map(d => ang(d, pDir)),
        fan: ch.length > 1 ? Math.max(...cDir.flatMap((a, i) => cDir.slice(i + 1).map(b => ang(a, b)))) : 0,
        parentAxis: pr[0].i.b > 0 ? pr[0].i.a / pr[0].i.b : 1
      });
    });
  }
  /* THE TAPER: a stretch of at least TAPER_MIN layers where one island has one island above it and one below, its diameter fitted against z.
     The slope is the growth going DOWN (mm of diameter per mm); the half-angle is atan(slope / 2), what Bambu calls the branch diameter angle. */
  const tapers = [];
  for (let k = 0; k < L.length; k++) {
    L[k].isl.forEach(i0 => {
      const dn = down[k].get(i0.id) || [];
      const startsRun = k === 0 || dn.length !== 1 || (up[k - 1].get(dn[0]) || []).length !== 1;
      if (!startsRun) return;
      const r = run(k, i0.id, +1, 400);
      if (r.length < TAPER_MIN) return;
      const zs2 = r.map(q => L[q.k].z), ds = r.map(q => dEq(q.i)), n = r.length;
      const mz = zs2.reduce((a, b) => a + b, 0) / n, md = ds.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0;
      r.forEach((q, j) => { sxy += (zs2[j] - mz) * (ds[j] - md); sxx += (zs2[j] - mz) * (zs2[j] - mz); });
      const slope = -sxy / sxx;
      tapers.push({ z0: zs2[0], z1: zs2[n - 1], layers: n, dTop: ds[n - 1], dBottom: ds[0], slope, halfAngleDeg: Math.atan(slope / 2) * 180 / Math.PI });
    });
  }
  return { file: path.relative(ROOT, file), lw, layers: zs.length, joins, tapers };
}

function stats(a) {
  const s = a.slice().sort((x, y) => x - y), q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: s.length, min: s[0], p10: q(0.1), median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}
function summary(res) {
  const J = res.flatMap(r => r.joins);
  const f = k => J.flatMap(j => Array.isArray(j[k]) ? j[k] : [j[k]]);
  return {
    joins: J.length,
    branchAngleDeg: stats(f('branchAngle')), childLeanDeg: stats(f('childLean')), parentLeanDeg: stats(f('parentLean')), fanDeg: stats(J.map(j => j.fan)),
    parentD: stats(f('parentD')), childD: stats(f('childD')),
    ratioWidest: stats(f('ratioWidest')), ratioTotal: stats(f('ratioTotal')),
    taperHalfAngleDeg: stats(res.flatMap(r => r.tapers).map(t => t.halfAngleDeg)),
    byChildren: [2, 3, 4].map(n => ({ children: n, joins: J.filter(j => j.n === n).length,
      ratioWidest: J.filter(j => j.n === n).length ? stats(J.filter(j => j.n === n).map(j => j.ratioWidest)) : null,
      ratioTotal: J.filter(j => j.n === n).length ? stats(J.filter(j => j.n === n).map(j => j.ratioTotal)) : null }))
  };
}

module.exports = { measure, summary, stats, _layersOf: layersOf, _islandsOf: islandsOf, _unzipEntry: unzipEntry };

if (require.main === module) {
  const args = process.argv.slice(2), json = args.includes('--json');
  const files = args.filter(a => !a.startsWith('--'));
  /* simple_overhang_p1s.gcode.3mf is the same slice on the P1S profile, moved on the plate: the same 7 joins to 0.01 mm; it is not counted twice */
  if (!files.length) files.push(path.join(ROOT, 'fixtures/supports/simple_overhang_bambu.gcode.3mf'));
  const res = files.map(measure);
  if (json) { console.log(JSON.stringify({ res, summary: summary(res) }, null, 1)); process.exit(0); }
  const f = (v, d) => (+v).toFixed(d == null ? 2 : d);
  res.forEach(r => {
    console.log(`\n${r.file}: ${r.layers} support layers, line ${r.lw} mm, ${r.joins.length} joins`);
    r.joins.forEach(j => console.log(`  z ${f(j.z, 1).padStart(5)}  at ${j.at.map(v => f(v, 1)).join(',').padEnd(13)}  ${j.n} up  parent d ${f(j.parentD)}  children d ${j.childD.map(v => f(v)).join('/')}  ` +
      `parent/widest ${f(j.ratioWidest)}  parent/total ${f(j.ratioTotal)}  lean parent ${f(j.parentLean, 1)}  children ${j.childLean.map(v => f(v, 1)).join('/')}  branch angle ${j.branchAngle.map(v => f(v, 1)).join('/')}  fan ${f(j.fan, 1)}`));
  });
  const s = summary(res), line = (name, t) => console.log(`  ${name.padEnd(22)} n ${String(t.n).padStart(3)}  min ${f(t.min)}  p10 ${f(t.p10)}  median ${f(t.median)}  p90 ${f(t.p90)}  max ${f(t.max)}`);
  console.log(`\nSUMMARY (${s.joins} joins)`);
  line('branch angle (deg)', s.branchAngleDeg); line('child lean (deg)', s.childLeanDeg); line('parent lean (deg)', s.parentLeanDeg); line('fan (deg)', s.fanDeg);
  line('parent diameter (mm)', s.parentD); line('child diameter (mm)', s.childD);
  line('taper half-angle (deg)', s.taperHalfAngleDeg);
  line('parent / widest child', s.ratioWidest); line('parent / total children', s.ratioTotal);
  s.byChildren.forEach(b => { if (b.joins) { console.log(`  ${b.children} children: ${b.joins} joins`); line('  parent / widest', b.ratioWidest); line('  parent / total', b.ratioTotal); } });
}
