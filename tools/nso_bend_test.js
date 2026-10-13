#!/usr/bin/env node
// Headless self-test for nso_bend.js (Bend) and the arc sweep it rides on
// (nso_path_sweep.js's sweepArc).
//
//   node tools/nso_bend_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order, so the browser files
// stay free of any node idiom. Every fixture is generated here. Every number is
// measured on the OUTPUT soup by code that does not share the bend's own: the
// sections are sliced out of it with NSO_PathSweep.sectionLoops, the tail is
// checked against a Rodrigues rotation written below, the topology is welded
// on exact float32 keys by a counter written below.
//
// Prints a table at the end; the PR quotes it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'nso_path_sweep.js', 'app-cut.js', 'app-sculpt.js', 'app-extend.js', 'nso_section.js', 'nso_bend.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_bendRaw, NSO_bendRead, NSO_PathSweep: S, NSO_extendRaw, rawCut } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const f32 = Math.fround;
const TABLE = [];

/* ------------------------------------------------------------------ fixtures */

// A closed prism along X from x0 to x1. `loops` are 2D (y, z) loops with the
// material on their left about +X: outlines counter-clockwise, bores
// clockwise. `caps(x, far)` returns the cap triangles at one end.
function prism(loops, x0, x1, caps) {
  const t = [];
  for (const lp of loops) {
    for (let i = 0; i < lp.length; i++) {
      const p = lp[i], q = lp[(i + 1) % lp.length];
      const p0 = [x0, p[0], p[1]], q0 = [x0, q[0], q[1]], p1 = [x1, p[0], p[1]], q1 = [x1, q[0], q[1]];
      t.push(p0, q0, q1, p0, q1, p1);
    }
  }
  for (const tri of caps(x1, true)) t.push(...tri);
  for (const tri of caps(x0, false)) t.push(tri[0], tri[2], tri[1]);
  return new Float32Array(t.flat());
}
// Cap a single outline by a fan from point index `apex` (or from a centre).
function fanCaps(loop, centre) {
  return (x, far) => {
    const out = [];
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      out.push([[x, centre[0], centre[1]], [x, p[0], p[1]], [x, q[0], q[1]]]);
    }
    return out;
  };
}
function vertexFanCaps(loop, apex) {
  return (x, far) => {
    const out = [], n = loop.length, c = loop[apex];
    for (let i = 1; i < n - 1; i++) {
      const p = loop[(apex + i) % n], q = loop[(apex + i + 1) % n];
      out.push([[x, c[0], c[1]], [x, p[0], p[1]], [x, q[0], q[1]]]);
    }
    return out;
  };
}
// Annulus caps between an outline (CCW) and a bore given CCW with the same
// point count, corresponding points at the same angle.
function annulusCaps(outer, innerCcw) {
  return (x, far) => {
    const out = [], n = outer.length;
    for (let i = 0; i < n; i++) {
      const O0 = outer[i], O1 = outer[(i + 1) % n], I0 = innerCcw[i], I1 = innerCcw[(i + 1) % n];
      out.push([[x, O0[0], O0[1]], [x, O1[0], O1[1]], [x, I1[0], I1[1]]]);
      out.push([[x, O0[0], O0[1]], [x, I1[0], I1[1]], [x, I0[0], I0[1]]]);
    }
    return out;
  };
}
const circle = (cy, cz, r, n, ph) => Array.from({ length: n }, (_, i) => {
  const a = (ph || 0) + 2 * Math.PI * i / n; return [cy + r * Math.cos(a), cz + r * Math.sin(a)];
});
const rect = (y0, z0, y1, z1) => [[y0, z0], [y1, z0], [y1, z1], [y0, z1]];

// The plate: the classic 12-triangle box, every wall one diagonal-split quad.
function box(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap(t => t.flatMap(i => v[i])));
}
const plate = () => box(0, 0, 0, 150, 60, 3);
function rectTube(len) {
  const O = rect(0, 0, 20, 12), I = rect(2, 2, 18, 10);
  return prism([O, I.slice().reverse()], 0, len, annulusCaps(O, I));
}
function roundTube(len, n, rO, rI) {
  const O = circle(20, 10, rO || 8, n || 48), I = circle(20, 10, rI || 6, n || 48);
  return prism([O, I.slice().reverse()], 0, len, annulusCaps(O, I));
}
function rod(len, n, r) {
  const O = circle(0, 6, r || 5, n || 48);
  return prism([O], 0, len, fanCaps(O, [0, 6]));
}
// A non-convex section: an angle iron, 20 x 20, 3 thick.
function angleIron(len) {
  const L = [[0, 0], [20, 0], [20, 3], [3, 3], [3, 20], [0, 20]];
  return prism([L], 0, len, vertexFanCaps(L, 3));
}
// A bar whose top ramps up between x 60 and 90: no clean band there.
function rampBar() {
  const P = [[0, 0], [150, 0], [150, 3], [90, 3], [60, 6], [0, 6]];   // in (x, z)
  const t = [];
  // side walls y = 0 (normal -y) and y = 40 (normal +y), fanned from the
  // ramp's foot (90, 3), which sees every other corner.
  const apex = 3, n = P.length;
  for (let i = 1; i < n - 1; i++) {
    const a = P[apex], b = P[(apex + i) % n], c = P[(apex + i + 1) % n];
    t.push([a[0], 0, a[1]], [c[0], 0, c[1]], [b[0], 0, b[1]]);
    t.push([a[0], 40, a[1]], [b[0], 40, b[1]], [c[0], 40, c[1]]);
  }
  for (let i = 0; i < n; i++) {
    const p = P[i], q = P[(i + 1) % n];
    t.push([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], 40, q[1]]);
    t.push([p[0], 0, p[1]], [q[0], 40, q[1]], [p[0], 40, p[1]]);
  }
  return orient(new Float32Array(t.flat()));
}
// A plate whose top rises 1 mm over its length: straight sides, no band.
function wedgePlate() {
  const s = box(0, 0, 0, 150, 60, 3);
  for (let i = 0; i < s.length; i += 3) if (s[i + 2] > 0 && s[i] > 0) s[i + 2] = 4;
  return s;
}
// A plate with a tab hanging under its far end: folded flat, the tab lands
// in the near half.
function plateWithTab() {
  const a = box(0, 0, 0, 150, 60, 3);
  // tab: a block glued under the far end, x 140..150, z -12..0, as one closed
  // piece: rebuild the plate's far end as an L in (x, z), extruded along y.
  const P = [[0, 0], [140, 0], [140, -12], [150, -12], [150, 3], [0, 3]];
  const t = [], n = P.length;
  for (let i = 1; i < n - 1; i++) {
    const A0 = P[1], b = P[(1 + i) % n], c = P[(1 + i + 1) % n];
    t.push([A0[0], 0, A0[1]], [c[0], 0, c[1]], [b[0], 0, b[1]]);
    t.push([A0[0], 60, A0[1]], [b[0], 60, b[1]], [c[0], 60, c[1]]);
  }
  for (let i = 0; i < n; i++) {
    const p = P[i], q = P[(i + 1) % n];
    t.push([p[0], 0, p[1]], [q[0], 0, q[1]], [q[0], 60, q[1]]);
    t.push([p[0], 0, p[1]], [q[0], 60, q[1]], [p[0], 60, p[1]]);
  }
  return orient(new Float32Array(t.flat()));
}
// Wind a hand-built soup outward: flip every triangle if its volume is negative.
function orient(s) {
  if (volume(s) > 0) return s;
  for (let o = 0; o < s.length; o += 9) for (let c = 0; c < 3; c++) { const t = s[o + 3 + c]; s[o + 3 + c] = s[o + 6 + c]; s[o + 6 + c] = t; }
  return s;
}
function turnZ(soup, deg) {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180), o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { o[i] = soup[i] * c - soup[i + 1] * s; o[i + 1] = soup[i] * s + soup[i + 1] * c; o[i + 2] = soup[i + 2]; }
  return o;
}
// A 100k-triangle rod: 64 sides, each end cap a polar grid of fine rings.
function detailedRod(len, rings) {
  const n = 64, r = 5, t = [];
  const ring = j => circle(0, 6, r * j / rings, n);
  const O = ring(rings);
  for (let i = 0; i < n; i++) {
    const p = O[i], q = O[(i + 1) % n];
    t.push([0, p[0], p[1]], [0, q[0], q[1]], [len, q[0], q[1]], [0, p[0], p[1]], [len, q[0], q[1]], [len, p[0], p[1]]);
  }
  for (const [x, far] of [[len, true], [0, false]]) {
    for (let j = 0; j < rings; j++) {
      const A = j === 0 ? null : ring(j), B = ring(j + 1);
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        const tri = A ? [[[x, A[i][0], A[i][1]], [x, B[i][0], B[i][1]], [x, B[i2][0], B[i2][1]]],
                         [[x, A[i][0], A[i][1]], [x, B[i2][0], B[i2][1]], [x, A[i2][0], A[i2][1]]]]
                      : [[[x, 0, 6], [x, B[i][0], B[i][1]], [x, B[i2][0], B[i2][1]]]];
        for (const tr of tri) far ? t.push(...tr) : t.push(tr[0], tr[2], tr[1]);
      }
    }
  }
  return new Float32Array(t.flat());
}

/* ------------------------------------------------------- independent probes */

// Exact-key topology, written here, not borrowed from the bend.
function topo(s) {
  const id = new Map(); let nv = 0;
  const vid = i => { const k = s[i] + ',' + s[i + 1] + ',' + s[i + 2]; let v = id.get(k); if (v === undefined) { v = nv++; id.set(k, v); } return v; };
  const edges = new Map(); let degen = 0;
  for (let o = 0; o < s.length; o += 9) {
    const v = [vid(o), vid(o + 3), vid(o + 6)];
    const ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
    const wx = s[o + 6] - s[o], wy = s[o + 7] - s[o + 1], wz = s[o + 8] - s[o + 2];
    if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) === 0) degen++;
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3], key = Math.min(a, b) + ':' + Math.max(a, b);
      const r = edges.get(key) || { n: 0, d: 0 }; r.n++; r.d += a < b ? 1 : -1; edges.set(key, r);
    }
  }
  let open = 0, nm = 0, flip = 0;
  for (const r of edges.values()) { if (r.n === 1) open++; else if (r.n > 2) nm++; else if (r.d !== 0) flip++; }
  return { tris: s.length / 9, verts: nv, open, nm, flip, degen, euler: nv - edges.size + s.length / 9 };
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subv = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulv = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const crossv = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function rodrigues(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return addv(addv(mulv(v, c), mulv(crossv(k, v), s)), mulv(k, dot(k, v) * (1 - c)));
}
function ptSegDist(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey);
}
function ptPolysDist(p, polys) {
  let m = Infinity;
  for (const L of polys) for (let i = 0; i < L.length; i++) m = Math.min(m, ptSegDist(p, L[i], L[(i + 1) % L.length]));
  return m;
}
// Two-way Hausdorff between two sets of closed 2D polylines (vertex to edge
// both ways - enough for polygons whose corners are on each other's edges).
function hausdorff(A, B) {
  let h = 0;
  for (const L of A) for (const p of L) h = Math.max(h, ptPolysDist(p, B));
  for (const L of B) for (const p of L) h = Math.max(h, ptPolysDist(p, A));
  return h;
}
function area2(L) { let a = 0; for (let i = 0; i < L.length; i++) { const q = L[(i + 1) % L.length]; a += L[i][0] * q[1] - q[0] * L[i][1]; } return a / 2; }
// Area and centroid of nested loops: the largest is the outline, the rest bores.
function areaCentroid(loops2) {
  const sorted = loops2.map(L => ({ L, a: Math.abs(area2(L)) })).sort((p, q) => q.a - p.a);
  let A = 0, cx = 0, cy = 0;
  sorted.forEach((x, i) => {
    const sg = i === 0 ? 1 : -1, L = x.L, s = Math.sign(area2(L));
    let ax = 0, ay = 0;
    for (let j = 0; j < L.length; j++) {
      const p = L[j], q = L[(j + 1) % L.length], cr = p[0] * q[1] - q[0] * p[1];
      ax += (p[0] + q[0]) * cr; ay += (p[1] + q[1]) * cr;
    }
    A += sg * x.a; cx += sg * s * ax / 6; cy += sg * s * ay / 6;
  });
  return { A, c: [cx / A, cy / A] };
}

/* The whole battery on one bend. `opts` as NSO_bendRaw. Returns the result. */
function verify(label, soup, opts, extra) {
  extra = extra || {};
  const copy = Float32Array.from(soup);
  const t0 = Date.now();
  const r = NSO_bendRaw(soup, opts);
  const ms = Date.now() - t0;
  check(label + ': bends', r.ok, r.ok ? r.counts.trisIn + ' -> ' + r.counts.trisOut + ' triangles, ' + r.steps + ' steps, ' + ms + ' ms' : r.reason);
  if (!r.ok) return r;
  check(label + ': the input buffer is untouched', copy.every((v, i) => Object.is(v, soup[i])));
  const out = r.tris;
  const T0 = topo(soup), T = topo(out);
  check(label + ': closed, 2-manifold, consistently wound, no zero-area faces',
        T.open === 0 && T.nm === 0 && T.flip === 0 && T.degen === 0 && T.euler === T0.euler,
        'open ' + T.open + ', non-manifold ' + T.nm + ', flipped ' + T.flip + ', zero-area ' + T.degen + ', Euler ' + T0.euler + ' -> ' + T.euler);

  const k = r.axisIdx, u = [0, 0, 0]; u[k] = 1;
  const side = /^([+\-−])(.)$/.exec(r.toward), d0 = [0, 0, 0];
  d0['XYZ'.indexOf(side[2])] = side[1] === '+' ? 1 : -1;
  const rl = (r.roll || 0) * Math.PI / 180;
  const d = rodrigues(d0, u, rl), b = crossv(u, d);
  let mn = Infinity, mx = -Infinity;
  for (let i = k; i < soup.length; i += 3) { mn = Math.min(mn, soup[i]); mx = Math.max(mx, soup[i]); }
  const W = mn + r.whereMm, R = r.radius, th = r.angleDeg * Math.PI / 180, L = R * th;
  const a = W - L / 2;

  // The section, sliced out of the INPUT at Where.
  const P = [0, 0, 0]; P[k] = W;
  const secIn = S.sectionLoops(soup, P, u);
  check(label + ': the input section reads', !!secIn, secIn ? secIn.length + ' loop(s)' : 'null');
  if (!secIn) return r;
  const hs = secIn.flat().map(p => dot(p, d));
  const mid = (Math.min(...hs) + Math.max(...hs)) / 2;
  const origin = mulv(d, mid); origin[k] = a;
  const C0 = addv(origin, mulv(d, R));
  const toHG = p => [dot(subv(p, origin), d), dot(subv(p, origin), b)];
  const sec2 = secIn.map(L2 => L2.map(toHG));

  // Every station of the arc: the plane through the bend axis at phi.
  let worst = 0, worstAt = -1, stations = 0, loopMiss = 0;
  for (let i = 0; i <= r.steps; i++) {
    const phi = th * i / r.steps;
    const ri = subv(mulv(u, Math.sin(phi)), mulv(d, Math.cos(phi))), ti = addv(mulv(u, Math.cos(phi)), mulv(d, Math.sin(phi)));
    const loops = S.sectionLoops(out, addv(C0, mulv(ri, R)), ti);
    if (!loops) { loopMiss++; continue; }
    const mine = loops.filter(L2 => { const c = L2.reduce((s, p) => addv(s, p), [0, 0, 0]); return dot(subv(mulv(c, 1 / L2.length), C0), ri) > 0; });
    if (mine.length !== sec2.length) { loopMiss++; continue; }
    const hg = mine.map(L2 => L2.map(p => { const q = subv(p, C0); return [R - dot(q, ri), dot(q, b)]; }));
    const h = hausdorff(hg, sec2);
    stations++;
    if (h > worst) { worst = h; worstAt = i; }
  }
  // ...and one station on each straight arm.
  const nearP = [0, 0, 0]; nearP[k] = (mn + a) / 2;
  const sideOf = (L2, t, rr) => { const c = mulv(L2.reduce((acc, p) => addv(acc, p), [0, 0, 0]), 1 / L2.length); return dot(subv(c, C0), rr) > 0 && dot(subv(c, C0), t) < 0; };
  const nearL0 = S.sectionLoops(out, nearP, u), nearL = nearL0 && nearL0.filter(L2 => sideOf(L2, u, mulv(d, -1)));
  const nearH = nearL ? hausdorff(nearL.map(L2 => L2.map(toHG)), sec2) : Infinity;
  check(label + ': every arc station is the section, to 1e-4 mm', loopMiss === 0 && worst <= 1e-4,
        stations + ' stations sliced, worst ' + worst.toExponential(2) + ' mm (station ' + worstAt + ')' + (loopMiss ? ', ' + loopMiss + ' unreadable' : ''));
  check(label + ': the near arm\'s section is the section', nearH <= 1e-4, nearH.toExponential(2) + ' mm');

  // The far part: an independent rigid motion - back L along u, then a turn
  // of theta about the bend axis (through C0, along b).
  const far = new Map();
  for (let i = 0; i < soup.length; i += 3) if (soup[i + k] > W) far.set(soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2], [soup[i], soup[i + 1], soup[i + 2]]);
  // Output vertices, exact and bucketed at 1e-5 mm for the near-zero case: a
  // coordinate that is 0 in real arithmetic comes out of either float64
  // formula as a few 1e-15, finer than float32's grid anywhere but at 0.
  const outKeys = new Set(), buckets = new Map();
  const bk = (x, y, z) => Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
  for (let i = 0; i < out.length; i += 3) {
    outKeys.add(out[i] + ',' + out[i + 1] + ',' + out[i + 2]);
    const b0 = bk(out[i], out[i + 1], out[i + 2]);
    if (!buckets.has(b0)) buckets.set(b0, []);
    buckets.get(b0).push([out[i], out[i + 1], out[i + 2]]);
  }
  // Within one float32 step: the bend's tail and this Rodrigues agree to
  // ~1e-14 mm, which can land the two on either side of a rounding midpoint.
  const nearOut = q => {
    const tol = 1e-9 + S.ulp32(Math.max(...q.map(Math.abs)));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const L2 = buckets.get((Math.round(q[0] * 1e5) + dx) + ',' + (Math.round(q[1] * 1e5) + dy) + ',' + (Math.round(q[2] * 1e5) + dz));
      if (L2 && L2.some(o => Math.hypot(...subv(o, q)) <= tol)) return true;
    }
    return false;
  };
  const img = p => addv(C0, rodrigues(subv(subv(p, mulv(u, L)), C0), b, th));
  const farPts = [...far.values()];
  let missing = 0, rig64 = 0, rig32 = 0, worstUlp = 0;
  const imgs = farPts.map(img);
  imgs.forEach((q, i) => {
    const key = f32(q[0]) + ',' + f32(q[1]) + ',' + f32(q[2]);
    if (!outKeys.has(key) && !nearOut(q)) missing++;
    const j = (i + 1) % farPts.length, p0 = farPts[i], p1 = farPts[j], q1 = imgs[j];
    const d0 = Math.hypot(...subv(p0, p1));
    rig64 = Math.max(rig64, Math.abs(Math.hypot(...subv(q, q1)) - d0));
    const s0 = [f32(q[0]), f32(q[1]), f32(q[2])], s1 = [f32(q1[0]), f32(q1[1]), f32(q1[2])];
    const dd = Math.abs(Math.hypot(...subv(s0, s1)) - d0);
    rig32 = Math.max(rig32, dd);
    worstUlp = Math.max(worstUlp, dd / S.ulp32(Math.max(...s0.map(Math.abs), ...s1.map(Math.abs))));
  });
  check(label + ': every far vertex is the nearest float32 to its rigid image', missing === 0,
        farPts.length + ' far vertices, ' + missing + ' not found');
  check(label + ': the far part is rigid to 1e-9 mm (float64, before storage)', rig64 <= 1e-9 && r.rigidWorstMm <= 1e-9,
        'independent ' + rig64.toExponential(2) + ', the bend\'s own ' + r.rigidWorstMm.toExponential(2));
  check(label + ': ...and stored, every distance within 2 float32 ULPs', worstUlp <= 2,
        'worst ' + rig32.toExponential(2) + ' mm = ' + worstUlp.toFixed(2) + ' ULP');

  // Volume: what came out against A x the length the centroid travels.
  const ac = areaCentroid(sec2);
  const travel = (R - ac.c[0]) * th;
  const vIn = volume(soup), vOut = volume(out);
  const zone = vOut - vIn + ac.A * L, want = ac.A * travel;
  const pieceWant = vIn - ac.A * L + want;
  check(label + ': volume = section area x centroid travel, within 0.1%',
        Math.abs(vOut - pieceWant) / pieceWant <= 1e-3 && Math.abs(zone - want) / want <= 1e-3,
        'piece ' + (100 * (vOut - pieceWant) / pieceWant).toFixed(4) + '%, the arc alone ' + (100 * (zone - want) / want).toFixed(4) +
        '% (A ' + ac.A.toFixed(3) + ' mm², centroid radius ' + (R - ac.c[0]).toFixed(3) + ' mm)');

  // The angle between the end faces: the near end face is untouched, the far
  // one is found as the vertices furthest along where it should point.
  const e = addv(mulv(u, Math.cos(th)), mulv(d, Math.sin(th)));
  // Each end is taken on its own side of the bend axis, so a 180° fold that
  // brings the two end faces level does not mix them up.
  const rTh = subv(mulv(u, Math.sin(th)), mulv(d, Math.cos(th)));
  const capN = endNormal(out, mulv(u, -1), c => dot(subv(c, C0), u) < 0 && dot(subv(c, C0), d) < 0),
        capF = endNormal(out, e, c => dot(subv(c, C0), e) > 0 && dot(subv(c, C0), rTh) > 0);
  const ang = Math.acos(Math.max(-1, Math.min(1, -dot(capN, capF)))) * 180 / Math.PI;
  check(label + ': the end faces are ' + r.angleDeg + '° apart', Math.abs(ang - r.angleDeg) <= 1e-4,
        'measured ' + ang.toFixed(6) + '°');

  TABLE.push({ label, trisIn: r.counts.trisIn, trisOut: r.counts.trisOut, steps: r.steps, ms,
               section: worst, rigid: rig64, ulp: worstUlp, vol: (zone - want) / want });
  return r;
}
// Area-weighted normal of the faces whose vertices are all furthest along e.
function endNormal(s, e, keep) {
  let top = -Infinity;
  for (let i = 0; i < s.length; i += 3) if (keep([s[i], s[i + 1], s[i + 2]])) top = Math.max(top, s[i] * e[0] + s[i + 1] * e[1] + s[i + 2] * e[2]);
  const n = [0, 0, 0];
  for (let o = 0; o < s.length; o += 9) {
    let all = keep([(s[o] + s[o + 3] + s[o + 6]) / 3, (s[o + 1] + s[o + 4] + s[o + 7]) / 3, (s[o + 2] + s[o + 5] + s[o + 8]) / 3]);
    for (let v = 0; v < 3; v++) if (top - (s[o + v * 3] * e[0] + s[o + v * 3 + 1] * e[1] + s[o + v * 3 + 2] * e[2]) > 1e-4) all = false;
    if (!all) continue;
    const c = crossv(subv([s[o + 3], s[o + 4], s[o + 5]], [s[o], s[o + 1], s[o + 2]]), subv([s[o + 6], s[o + 7], s[o + 8]], [s[o], s[o + 1], s[o + 2]]));
    n[0] += c[0]; n[1] += c[1]; n[2] += c[2];
  }
  const L = Math.hypot(...n);
  return mulv(n, 1 / L);
}
function refusal(label, soup, opts, re) {
  const r = NSO_bendRaw(soup, opts);
  check(label, !r.ok && r.tris === soup && re.test(r.reason), r.ok ? 'it bent' : r.reason);
  return r;
}

/* ===================================================================== */
console.log('\n=== 1. the arc sweep on its own: a tube (a bore) and an angle (non-convex) ===');
{
  const out = [circle(0, 0, 8, 32), circle(0, 0, 6, 32).reverse()];
  const loops = out.map(L => L.map(p => [0, p[0], p[1]]));
  const sw = S.sweepArc({ arc: { origin: [0, 0, 0], tangent: [1, 0, 0], toward: [0, 0, 1], radius: 20, angle: Math.PI / 2 }, loops });
  check('sweepArc takes a section with a hole', sw.ok, sw.ok ? sw.steps + ' steps, ' + sw.stats.tris + ' wall triangles' : sw.reason);
  check('ring 0 is the start loops themselves', sw.rings[0][0][3] === loops[0][3]);
  const wrong = S.sweepArc({ arc: { origin: [0, 0, 0], tangent: [1, 0, 0], toward: [0, 0, 1], radius: 20, angle: 1 }, loops: loops.map(L => L.slice().reverse()) });
  check('...and refuses loops wound the wrong way', !wrong.ok && /wound the wrong way/.test(wrong.reason), wrong.reason);
  const tight = S.sweepArc({ arc: { origin: [0, 0, 0], tangent: [1, 0, 0], toward: [0, 0, 1], radius: 7.5, angle: 1 }, loops });
  check('...and refuses a radius inside the section', !tight.ok && /inside out/.test(tight.reason), tight.reason);
  const Lsec = [[0, 0], [20, 0], [20, 3], [3, 3], [3, 20], [0, 20]].map(p => [0, p[0], p[1]]);
  const sw2 = S.sweepArc({ arc: { origin: [0, 0, 0], tangent: [1, 0, 0], toward: [0, 1, 0], radius: 30, angle: 2 }, loops: [Lsec] });
  check('sweepArc takes a non-convex section', sw2.ok, sw2.ok ? sw2.steps + ' steps' : sw2.reason);
  const q = S.arcTail(S.arcFrame({ origin: [0, 0, 0], tangent: [1, 0, 0], toward: [0, 0, 1], radius: 10, angle: Math.PI / 2 }), [10 * Math.PI / 2, 0, 0]);
  check('a quarter turn is exact: the tail of the arc\'s own end point', q[0] === 10 && q[1] === 0 && q[2] === 10, JSON.stringify(q));
}

console.log('\n=== 2. the five fixtures, each at 90 degrees and at 37 ===');
const FIX = [
  ['plate 3x60x150', plate, { where: 75, toward: '+Z' }],
  ['rect tube 20x12x2', () => rectTube(120), { where: 60, toward: '+Z' }],
  ['round tube 16/12', () => roundTube(120), { where: 60, toward: '+Y' }],
  ['rod 10', () => rod(100), { where: 50, toward: '-Z' }],
  ['tube Extended 80->120', () => { const e = NSO_extendRaw(roundTube(80), { length: 120 }); if (!e.ok) throw new Error(e.reason); return e.tris; },
   { where: 60, toward: '+Z' }],
  ['angle iron 20x20x3', () => angleIron(120), { where: 60, toward: '+Y' }]
];
const BENT = {};
for (const [name, make, o] of FIX) {
  for (const ang of [90, 37]) {
    const r = verify(name + ' @' + ang + '°', make(), Object.assign({ angle: ang }, o));
    if (ang === 90) BENT[name] = r;
  }
}

console.log('\n=== 3. 180 degrees, and a roll ===');
for (const [name, make, o] of FIX.slice(0, 4)) {
  // The round tube's default radius (2.5 x 16 = 40 mm) needs 126 mm of arc at
  // 180°, more than the 120 mm tube has; it folds at 20.
  verify(name + ' @180°', make(), Object.assign({ angle: 180 }, o, /round/.test(name) ? { radius: 20 } : {}));
}
verify('round tube, rolled 45°', roundTube(120), { where: 60, angle: 90, toward: '+Z', roll: 45 });
verify('rod, rolled 15°', rod(100), { where: 50, angle: 60, toward: '+Y', roll: 15 });

console.log('\n=== 4. a tight plate fold: inside radius = 1x the 3 mm thickness ===');
verify('plate tight fold @90°', plate(), { where: 75, angle: 90, toward: '+Z', radius: 4.5 });
verify('plate tight fold @180°', plate(), { where: 75, angle: 180, toward: '+Z', radius: 4.5 });

console.log('\n=== 5. the radius limit, exactly ===');
{
  const p = plate();
  const r1 = refusal('1.50 mm (half the 3 mm width) is refused', p, { where: 75, angle: 90, toward: '+Z', radius: 1.5 },
                     /tighter than half the section's 3\.00 mm width.*smallest radius that works is 1\.51 mm/);
  refusal('1.509 mm is refused', p, { where: 75, angle: 90, toward: '+Z', radius: 1.509 }, /smallest radius that works is 1\.51 mm/);
  verify('1.51 mm, the number it names, bends', p, { where: 75, angle: 90, toward: '+Z', radius: 1.51 });
  verify('1.51 mm at 180°', p, { where: 75, angle: 180, toward: '+Z', radius: 1.51 });
  const rt = refusal('the round tube names its own limit', roundTube(120), { where: 60, angle: 90, toward: '+Z', radius: 7 },
                     /smallest radius that works is 8\.01 mm/);
}

console.log('\n=== 6. refusals, in words, the piece unchanged ===');
{
  refusal('no clean band at Where (a ramp between 60 and 90 mm)', rampBar(), { where: 75, angle: 45, toward: '+Z', axis: 'x' },
          /no straight stretch at 75\.0 mm.*nearest straight stretch runs .* 15\.0 mm away/);
  refusal('the zone does not fit the band (Where 3 mm from the end)', plate(), { where: 3, angle: 90, toward: '+Z' },
          /needs 11\.8 mm of straight piece.*Move Where 3\.0 mm, to 6\.0 mm/);
  const z2 = NSO_bendRaw(plate(), { where: 6, angle: 90, toward: '+Z' });
  check('...and the Where it names is one that bends', z2.ok, z2.ok ? '' : z2.reason);
  refusal('the zone fits no band on the piece', plate(), { where: 75, angle: 180, toward: '+Y' },
          /needs 471\.2 mm.*No straight stretch on this piece is that long - the longest is 150\.0 mm; at 180° the radius can be at most 47\.68 mm/);
  refusal('the section is not constant (a wedge)', wedgePlate(), { where: 75, angle: 90, toward: '+Z', axis: 'x' },
          /section is not constant anywhere along X - it tapers/);
  const cone = (() => {
    const t = [], seg = 32, ring = (x, r) => circle(0, 0, r, seg).map(p => [x, p[0], p[1]]);
    const A = ring(0, 8), B = ring(40, 3);
    for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; t.push(A[i], B[i], B[j], A[i], B[j], A[j], [0, 0, 0], A[j], A[i], [40, 0, 0], B[i], B[j]); }
    return new Float32Array(t.flat());
  })();
  refusal('a cone (tapers all over)', cone, { where: 20, angle: 90, toward: '+Z' }, /tapered all over|no straight axis|not constant/);
  refusal('an axis that is not X, Y or Z (a rod turned 30°)', turnZ(rod(100), 30), { where: 50, angle: 90, toward: '+Z' },
          /turned 30\.0° off X, Y and Z - Bend works only along X, Y or Z/);
  const flat = NSO_bendRaw(turnZ(plate(), 30), { where: 1.5, angle: 90, toward: '+X' });
  check('a plate turned 30° about Z reads its one straight axis, its 3 mm thickness, and finds no room', !flat.ok && flat.axis === 'Z' && /No straight stretch on this piece is that long/.test(flat.reason), flat.reason);
  const sphere = readSTL(path.join(ROOT, 'fixtures', 'fixture_sphere_curved.stl'));
  refusal('a sphere: no straight axis', sphere, { where: 10, angle: 90, toward: '+Z' }, /no straight axis/);
  refusal('more than 2 million triangles (a 100k-triangle, 12,500-gon tube at 90°)', roundTube(120, 12500, 40, 36), { where: 60, angle: 90, toward: '+Z', radius: 45 },
          /would have 3,900,000 triangles, past the 2,000,000 limit - the arc needs 37 steps round 50000 section points/);
  refusal('a roll on a rectangular section', plate(), { where: 75, angle: 90, toward: '+Z', roll: 15 }, /Roll is for a round or shaped section/);
  refusal('a roll off the 15° steps', rod(100), { where: 50, angle: 90, toward: '+Z', roll: 10 }, /15° steps/);
  refusal('an angle past 180', plate(), { where: 75, angle: 181, toward: '+Z' }, /1 to 180/);
  refusal('an angle under 1', plate(), { where: 75, angle: 0.5, toward: '+Z' }, /1 to 180/);
  refusal('toward its own length', plate(), { where: 75, angle: 90, toward: '+X' }, /along its own length/);
  refusal('Where past the end', plate(), { where: 151, angle: 90, toward: '+Z' }, /inside the piece/);
  refusal('an arm folded through the body (a tab under the far end, folded flat)', plateWithTab(),
          { where: 75, angle: 180, toward: '-Z', radius: 4 }, /far arm through the piece before the bend/);
  const ok = NSO_bendRaw(plateWithTab(), { where: 75, angle: 180, toward: '-Z', radius: 9 });
  check('...and with room for the tab it folds', ok.ok, ok.ok ? 'radius 9' : ok.reason);
}

console.log('\n=== 7. a second bend on the bent piece ===');
{
  const first = NSO_bendRaw(plate(), { where: 110, angle: 90, toward: '+Z' });
  check('first bend: 90° at 110 mm', first.ok, first.ok ? '' : first.reason);
  const rd = NSO_bendRead(first.tris);
  check('the bent piece still reads its axis (X) and a straight band', rd.ok && rd.axis === 'X',
        rd.ok ? 'axis ' + rd.axis + ', bands ' + rd.bands.map(b => b.fromMm.toFixed(1) + '-' + b.toMm.toFixed(1)).join(', ') : rd.reason);
  verify('second bend: 90° at 40 mm, the other way', first.tris, { where: 40, angle: 90, toward: '-Z' });
  verify('second bend: 45° at 40 mm, across (+Y)', first.tris, { where: 40, angle: 45, toward: '+Y', radius: 40 });
  refusal('a second bend in the first one\'s arc is refused', first.tris, { where: 110, angle: 30, toward: '+Z' },
          /no straight stretch at 110\.0 mm/);
}

console.log('\n=== 8. Cut on a bent piece ===');
for (const name of ['plate 3x60x150', 'round tube 16/12']) {
  const r = BENT[name];
  if (!r || !r.ok) { check(name + ': bent first', false); continue; }
  const k = r.axisIdx, mn = 0;
  for (const plane of [r.zone.fromMm / 2, r.zone.fromMm + r.zone.lengthMm * 0.3]) {
    let A, B, err = '';
    try { A = rawCut(r.tris, k, plane, true); B = rawCut(r.tris, k, plane, false); } catch (e) { err = e.message; }
    const ta = A && topo(A), tb = B && topo(B);
    const vs = A && B ? volume(A) + volume(B) : 0, vw = volume(r.tris);
    check(name + ': Cut at X ' + plane.toFixed(2) + ' gives two closed halves', !err && ta && tb && !ta.open && !ta.nm && !tb.open && !tb.nm,
          err || ('halves ' + ta.tris + ' + ' + tb.tris + ' triangles, open ' + ta.open + '/' + tb.open));
    check(name + ': ...whose volumes add up to the piece', A && B && Math.abs(vs - vw) / vw < 1e-5,
          (vs).toFixed(3) + ' vs ' + vw.toFixed(3) + ' mm³');
  }
}

console.log('\n=== 9. triangle counts and time ===');
{
  for (const ang of [90, 180]) {
    const r = NSO_bendRaw(plate(), { where: 75, angle: ang, toward: '+Z' });
    console.log('    plate 3x60x150 @' + ang + '°: ' + r.counts.trisIn + ' -> ' + r.counts.trisOut + ' triangles (' + r.steps + ' steps x ' +
                r.counts.sectionPoints + ' section points x 2)');
    const t = NSO_bendRaw(roundTube(120), { where: 60, angle: ang, toward: '+Z', radius: 20 });
    console.log('    round tube 48-gon @' + ang + '°: ' + t.counts.trisIn + ' -> ' + t.counts.trisOut + ' triangles (' + t.steps + ' steps)');
  }
  const big = detailedRod(100, 391);
  const t0 = Date.now();
  const r = NSO_bendRaw(big, { where: 50, angle: 90, toward: '+Z' });
  const ms = Date.now() - t0;
  check('a 100k-triangle rod (detailed end caps) bends', r.ok && big.length / 9 >= 1e5,
        (big.length / 9) + ' -> ' + (r.ok ? r.counts.trisOut : '-') + ' triangles in ' + ms + ' ms' + (r.ok ? '' : ': ' + r.reason));
  TABLE.push({ label: '100k rod, 64-gon section @90°', trisIn: big.length / 9, trisOut: r.ok ? r.counts.trisOut : 0, steps: r.steps, ms });
  // A fine section is what costs: every section point is swept round every
  // step. A 4,000-gon tube (Ø80 / Ø72) is 32k triangles in and ~1.2M out; at
  // 12,500 sides (100k in) it would be 3.9M, refused above.
  const fine = roundTube(120, 4000, 40, 36);
  const t1 = Date.now();
  const r2 = NSO_bendRaw(fine, { where: 60, angle: 90, toward: '+Z', radius: 45 });
  const ms2 = Date.now() - t1;
  check('a 4,000-gon tube bends', r2.ok, (fine.length / 9) + ' -> ' + (r2.ok ? r2.counts.trisOut : '-') +
        ' triangles in ' + ms2 + ' ms' + (r2.ok ? '' : ': ' + r2.reason));
  TABLE.push({ label: 'tube, 4,000-gon section @90°', trisIn: fine.length / 9, trisOut: r2.ok ? r2.counts.trisOut : 0, steps: r2.steps, ms: ms2 });
}

console.log('\n=== 10. the reading the panel shows ===');
{
  const rd = NSO_bendRead(plate());
  check('a plate reads X, rectangular, Up first, 150 mm', rd.ok && rd.axis === 'X' && rd.rectangular && rd.sides[0].key === '+Z' && rd.lengthMm === 150);
  check('...defaults: fold Up across the 3 mm, radius 7.5, Where at the middle', rd.defaultToward === '+Z' && rd.sides[0].radiusMm === 7.5 && rd.defaultWhereMm === 75);
  const rt = NSO_bendRead(roundTube(120));
  check('a round tube reads round, not rectangular (Roll offered)', rt.ok && !rt.rectangular && rt.section.cls === 'round', rt.section && rt.section.cls);
}

console.log('\n----------------------------------------------------------');
console.log('fixture                                  tris in -> out    steps   ms   section worst   rigid f64   stored ULP   arc volume');
for (const t of TABLE) {
  console.log('  ' + t.label.padEnd(38) + String(t.trisIn).padStart(7) + ' -> ' + String(t.trisOut).padEnd(8) + String(t.steps).padStart(5) +
              String(t.ms).padStart(6) + '   ' + (t.section != null ? t.section.toExponential(2) : '-').padStart(9) + '   ' +
              (t.rigid != null ? t.rigid.toExponential(2) : '-').padStart(9) + '   ' + (t.ulp != null ? t.ulp.toFixed(2) : '-').padStart(6) +
              '      ' + (t.vol != null ? (100 * t.vol).toFixed(4) + '%' : '-'));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
