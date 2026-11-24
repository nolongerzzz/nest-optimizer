/* ============================================================
   nso_mesh_edges.js - round or bevel chosen straight edges of ANY piece.

   nso_box_edges.js does this for a plain box, where every edge is one of
   twelve and the result is a clip. A piece with a notch, a ledge, a step or a
   divider is not a box, and Soften used to refuse it outright. This kernel
   takes any closed piece made of flat faces:

   THE EDGES. Every mesh edge whose two triangles bend by more than FEATURE_DEG
   is a sharp edge. Sharp edges that run on in a straight line between the same
   two face planes are one LINE - the thing the card draws and a click picks.
   Each line knows its two faces (normal n, the in-face direction u away from
   the edge) and whether it is CONVEX (material inside the angle: an outside
   corner, the rim of a notch) or CONCAVE (air inside the angle: an inside
   corner, where a wall meets a floor).

   THE TOOL. Across a line the round is the 2D profile between the two faces
   and an arc of radius R tangent to both (Bevel: the straight chord). That
   profile, run along the line, is a prism:

     - convex  : the prism is the material to TAKE AWAY (subtract);
     - concave : the prism is the material to ADD (union) - a fillet.

   Faces need not be square to each other; the tangent setback is
   d = R / tan(phi/2) for the angle phi between the faces.

   THE ENDS. A line ends somewhere, and what is past the end decides the cut:

     - past the end is the outside (convex) / the inside (concave): the prism
       runs on past it, so the end face trims it - an edge that runs out
       through the top of a wall is rounded all the way out;
     - another picked line of the same kind meets it there on a shared face:
       the two prisms mitre on the bisecting plane, so a rounded rim turns a
       corner without a step (the inside corner of a notch, an L of walls);
     - otherwise: cut square at the end.

   THE FIT. Each line's setback is held to half the width of the material (or
   the air) across each of its faces, measured by a ray from the middle of the
   line, so a 2 mm wall can take R 1 from both sides and a picked edge cannot
   bite through it. The status says when a radius was clamped.

   Headless: a flat triangle soup in, cutter / filler soups out (the app runs
   them through the boolean kernel). No THREE, no DOM.
   ============================================================ */
(function (root) {
  'use strict';

  var FEATURE_DEG = 20;           // two triangles bending more than this make a sharp edge
  var WELD = 1e4;                 // the seal test's weld grid
  var NA_ROUND = 12;              // chords per quarter turn, as the box kernels sample
  var MIN_LEN = 1e-3;

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; }

  /* ---------------------------------------------------------------
     Ray queries on the soup (parity inside test, nearest hit)
     --------------------------------------------------------------- */
  function rayHits(soup, o, d, cb) {
    var n = (soup.length / 9) | 0;
    for (var t = 0; t < n; t++) {
      var k = t * 9;
      var ax = soup[k], ay = soup[k + 1], az = soup[k + 2];
      var e1x = soup[k + 3] - ax, e1y = soup[k + 4] - ay, e1z = soup[k + 5] - az;
      var e2x = soup[k + 6] - ax, e2y = soup[k + 7] - ay, e2z = soup[k + 8] - az;
      var px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      var det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      var inv = 1 / det;
      var sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
      var u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      var v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      var tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > 1e-7) cb(tt);
    }
  }
  var RAY_DIRS = [norm([0.5773, 0.5812, 0.5734]), norm([-0.6123, 0.3317, 0.7176]), norm([0.2711, -0.8423, 0.4659])];
  function inside(soup, p) {
    var votes = 0;
    for (var i = 0; i < RAY_DIRS.length; i++) {
      var c = 0;
      rayHits(soup, p, RAY_DIRS[i], function () { c++; });
      if (c & 1) votes++;
    }
    return votes >= 2;
  }
  function nearestHit(soup, o, d) {
    var best = Infinity;
    rayHits(soup, o, d, function (t) { if (t < best) best = t; });
    return best;
  }

  /* ---------------------------------------------------------------
     The sharp straight lines of a soup
     --------------------------------------------------------------- */
  function findLines(soup, opts) {
    opts = opts || {};
    var cosF = Math.cos((opts.featureDeg || FEATURE_DEG) * Math.PI / 180);
    var n = (soup.length / 9) | 0;
    var vid = new Map(), P = [];
    var key = function (x, y, z) { return Math.round(x * WELD) + '|' + Math.round(y * WELD) + '|' + Math.round(z * WELD); };
    var T = new Int32Array(n * 3), N = [];
    for (var t = 0; t < n; t++) {
      for (var c = 0; c < 3; c++) {
        var o = t * 9 + c * 3, k = key(soup[o], soup[o + 1], soup[o + 2]);
        var id = vid.get(k);
        if (id === undefined) { id = P.length; vid.set(k, id); P.push([soup[o], soup[o + 1], soup[o + 2]]); }
        T[t * 3 + c] = id;
      }
      var a = P[T[t * 3]], b = P[T[t * 3 + 1]], cc = P[T[t * 3 + 2]];
      var nn = cross(sub(b, a), sub(cc, a)), l = len(nn);
      N.push(l > 1e-12 ? mul(nn, 1 / l) : null);
    }
    // undirected edge -> its triangles
    var E = new Map();
    for (t = 0; t < n; t++) {
      if (!N[t]) continue;
      for (c = 0; c < 3; c++) {
        var i0 = T[t * 3 + c], i1 = T[t * 3 + (c + 1) % 3];
        if (i0 === i1) continue;
        var ek = i0 < i1 ? i0 + '_' + i1 : i1 + '_' + i0;
        var rec = E.get(ek);
        if (!rec) { rec = { a: Math.min(i0, i1), b: Math.max(i0, i1), tris: [] }; E.set(ek, rec); }
        rec.tris.push(t);
      }
    }
    var feats = [];
    E.forEach(function (r) {
      if (r.tris.length !== 2) return;
      var tA = r.tris[0], tB = r.tris[1], nA = N[tA], nB = N[tB];
      if (dot(nA, nB) > cosF) return;
      var pa = P[r.a], pb = P[r.b], dv = sub(pb, pa), L = len(dv);
      if (L < 1e-9) return;
      var dir = mul(dv, 1 / L);
      var third = function (tt) {
        for (var q = 0; q < 3; q++) { var vi = T[tt * 3 + q]; if (vi !== r.a && vi !== r.b) return P[vi]; }
        return null;
      };
      var u1 = norm(cross(nA, dir)), u2 = norm(cross(nB, dir));
      var qa = third(tA), qb = third(tB);
      if (!qa || !qb) return;
      if (dot(u1, sub(qa, pa)) < 0) u1 = mul(u1, -1);
      if (dot(u2, sub(qb, pa)) < 0) u2 = mul(u2, -1);
      feats.push({ a: r.a, b: r.b, dir: dir, n1: nA, n2: nB, u1: u1, u2: u2 });
    });
    // chain: shared vertex, collinear, same two planes
    var parent = feats.map(function (_, i) { return i; });
    var find = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    var byV = new Map();
    feats.forEach(function (f, i) {
      [f.a, f.b].forEach(function (v) { var l = byV.get(v); if (!l) byV.set(v, l = []); l.push(i); });
    });
    var samePlanes = function (f, g) {
      var c1 = dot(f.n1, g.n1) > 0.99999 && dot(f.n2, g.n2) > 0.99999;
      var c2 = dot(f.n1, g.n2) > 0.99999 && dot(f.n2, g.n1) > 0.99999;
      return c1 || c2;
    };
    byV.forEach(function (list) {
      for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
        var f = feats[list[i]], g = feats[list[j]];
        if (Math.abs(dot(f.dir, g.dir)) < 0.99999 || !samePlanes(f, g)) continue;
        var ri = find(list[i]), rj = find(list[j]);
        if (ri !== rj) parent[ri] = rj;
      }
    });
    var groups = new Map();
    feats.forEach(function (f, i) { var r = find(i); var g = groups.get(r); if (!g) groups.set(r, g = []); g.push(f); });
    var lines = [];
    groups.forEach(function (g) {
      var f = g[0], o = P[f.a], lo = Infinity, hi = -Infinity;
      g.forEach(function (h) {
        [h.a, h.b].forEach(function (v) { var s = dot(sub(P[v], o), f.dir); if (s < lo) lo = s; if (s > hi) hi = s; });
      });
      if (hi - lo < MIN_LEN) return;
      var p0 = add(o, mul(f.dir, lo)), p1 = add(o, mul(f.dir, hi));
      var convex = dot(f.n1, f.u2) < 0;
      var phi = Math.acos(Math.max(-1, Math.min(1, dot(f.u1, f.u2))));
      lines.push({ p0: p0, p1: p1, dir: f.dir, len: hi - lo, n1: f.n1, n2: f.n2, u1: f.u1, u2: f.u2,
                   convex: convex, phi: phi, segs: g.length });
    });
    // a fixed order, so a line's number is the same every time the same soup is read
    lines.sort(function (A, B) {
      for (var k = 0; k < 3; k++) { if (Math.abs(A.p0[k] - B.p0[k]) > 1e-6) return A.p0[k] - B.p0[k]; }
      for (k = 0; k < 3; k++) { if (Math.abs(A.p1[k] - B.p1[k]) > 1e-6) return A.p1[k] - B.p1[k]; }
      return 0;
    });
    lines.forEach(function (l, i) { l.id = i; });
    return lines;
  }

  /* ---------------------------------------------------------------
     The profile across one line, at R
     --------------------------------------------------------------- */
  function profile(L, R, mode, e) {
    var half = L.phi / 2;
    var d = R / Math.tan(half);
    var bis = norm(add(L.u1, L.u2));
    var s = L.convex ? 1 : -1;            // which way is out of the work: air for a cut, material for a fill
    var C = [0, 0, 0];
    var T1 = mul(L.u1, d), T2 = mul(L.u2, d);
    var pts = [];
    pts.push(sub(C, mul(bis, e)));
    pts.push(add(T1, mul(L.n1, s * e)));
    pts.push(T1);
    if (mode === 'chamfer') {
      // the straight chord, nothing between
    } else {
      var O = mul(bis, R / Math.sin(half));
      var a0 = sub(T1, O), a1 = sub(T2, O);
      var turn = Math.PI - L.phi;
      var k = Math.max(2, Math.ceil(NA_ROUND * turn / (Math.PI / 2)));
      // slerp a0 -> a1 about O
      var ang = Math.acos(Math.max(-1, Math.min(1, dot(a0, a1) / (R * R))));
      var sn = Math.sin(ang);
      for (var i = 1; i < k; i++) {
        var f = i / k;
        var w0 = Math.sin((1 - f) * ang) / sn, w1 = Math.sin(f * ang) / sn;
        pts.push(add(O, add(mul(a0, w0), mul(a1, w1))));
      }
    }
    pts.push(T2);
    pts.push(add(T2, mul(L.n2, s * e)));
    return { pts: pts, d: d, extent: d + 2 * e };
  }

  /* ---------------------------------------------------------------
     A prism along the line, each profile point with its own start/end
     --------------------------------------------------------------- */
  function prismSoup(base, dir, pts, t0, t1) {
    var n = pts.length, out = [];
    var A = pts.map(function (p, i) { return add(base, add(p, mul(dir, t0[i]))); });
    var B = pts.map(function (p, i) { return add(base, add(p, mul(dir, t1[i]))); });
    var tri = function (a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]);
    }
    for (i = 1; i < n - 1; i++) { tri(A[0], A[i + 1], A[i]); tri(B[0], B[i], B[i + 1]); }
    var soup = new Float32Array(out);
    if (volume(soup) < 0) flip(soup);
    return soup;
  }
  function volume(s) {
    var v = 0;
    for (var t = 0; t + 8 < s.length; t += 9) {
      v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
            s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
    }
    return v;
  }
  function flip(s) {
    for (var t = 0; t + 8 < s.length; t += 9) {
      for (var k = 0; k < 3; k++) { var x = s[t + 3 + k]; s[t + 3 + k] = s[t + 6 + k]; s[t + 6 + k] = x; }
    }
  }

  function samePlane(nA, pA, nB, pB) {
    return dot(nA, nB) > 0.99999 && Math.abs(dot(nA, sub(pB, pA))) < 1e-3;
  }
  function near(a, b) { return len(sub(a, b)) < 1e-3; }

  /* ---------------------------------------------------------------
     The tools: one prism per picked line
     specs: [{ id, R, mode }]  ->  { cuts: [soup], fills: [soup], build }
     --------------------------------------------------------------- */
  function edgeTools(soup, lines, specs) {
    var byId = new Map();
    lines.forEach(function (l) { byId.set(l.id, l); });
    var picked = [];
    specs.forEach(function (s) {
      var L = byId.get(s.id);
      if (L && s.R > 0) picked.push({ L: L, R: s.R, mode: s.mode === 'chamfer' ? 'chamfer' : 'fillet', id: s.id });
    });
    var build = { requested: specs.length, edges: picked.length, clamped: [], convex: 0, concave: 0, ends: { run: 0, mitre: 0, square: 0 } };
    // the fit: half the width across each face, measured from the line's middle - half,
    // so the edge on the far side of a thin wall can still take as much
    picked.forEach(function (pk) {
      var L = pk.L, mid = mul(add(L.p0, L.p1), 0.5), half = L.phi / 2;
      var dWant = pk.R / Math.tan(half), dMax = Infinity;
      var del = Math.min(0.01, L.len * 0.01);
      [[L.u1, L.n1], [L.u2, L.n2]].forEach(function (un) {
        // just under the face for a cut, just over it for a fill, heading across the face
        var o = add(mid, add(mul(un[0], del), mul(un[1], (L.convex ? -1 : 1) * del)));
        var w = nearestHit(soup, o, un[0]);
        if (!isFinite(w)) return;
        w += del;
        dMax = Math.min(dMax, w / 2);
      });
      // held short of the limit: two rounds that meet exactly in the middle leave a knife edge
      // with no width, which the kernel cannot keep as a solid
      var d = dWant <= dMax * 0.9 ? dWant : dMax * 0.9;
      pk.Rused = d * Math.tan(half);
      if (pk.Rused < pk.R - 1e-6) build.clamped.push({ id: pk.id, asked: pk.R, got: pk.Rused });
    });
    var cuts = [], fills = [];
    picked.forEach(function (pk) {
      var L = pk.L;
      if (!(pk.Rused > 1e-4)) return;
      var e = Math.max(0.02, Math.min(0.2, pk.Rused * 0.1));
      var pr = profile(L, pk.Rused, pk.mode, e);
      var pts = pr.pts, reach = pr.extent * 1.5 + 0.2;
      var t0 = pts.map(function () { return 0; }), t1 = pts.map(function () { return L.len; });
      // the two ends: p0 (out is -dir), p1 (out is +dir)
      [0, 1].forEach(function (end) {
        var V = end ? L.p1 : L.p0, out = end ? L.dir : mul(L.dir, -1), inn = mul(out, -1);
        // is the space just past the end the outside (cut) / the inside (fill), across the profile?
        var probes = [mul(add(L.u1, L.u2), 0.2 * pr.d), add(mul(L.u1, 0.6 * pr.d), mul(L.u2, 0.06 * pr.d)),
                      add(mul(L.u2, 0.6 * pr.d), mul(L.u1, 0.06 * pr.d))];
        var runOn = true;
        for (var pi = 0; pi < probes.length && runOn; pi++) {
          for (var di = 0; di < 3 && runOn; di++) {
            var tt = [Math.min(0.02, reach / 4), reach / 2, reach][di];
            var q = add(V, add(probes[pi], mul(out, tt)));
            var inS = inside(soup, q);
            if (L.convex ? inS : !inS) runOn = false;
          }
        }
        var partners = [];
        if (!runOn) {
          picked.forEach(function (ot) {
            if (ot === pk || ot.L.convex !== L.convex) return;
            var at = near(ot.L.p0, V) ? 0 : (near(ot.L.p1, V) ? 1 : -1);
            if (at < 0) return;
            var shares = samePlane(L.n1, L.p0, ot.L.n1, ot.L.p0) || samePlane(L.n1, L.p0, ot.L.n2, ot.L.p0) ||
                         samePlane(L.n2, L.p0, ot.L.n1, ot.L.p0) || samePlane(L.n2, L.p0, ot.L.n2, ot.L.p0);
            if (!shares) return;
            var b = at === 0 ? ot.L.dir : mul(ot.L.dir, -1);     // along the other line, away from V
            if (dot(b, inn) > 0.9999) return;
            partners.push(sub(inn, b));
          });
        }
        if (runOn) build.ends.run++; else if (partners.length) build.ends.mitre++; else build.ends.square++;
        pts.forEach(function (p, i) {
          var P0 = add(L.p0, p);                             // this profile point at t = 0
          if (runOn) {
            if (end) t1[i] = L.len + reach; else t0[i] = -reach;
          } else if (partners.length) {
            // as far past V as the mitre planes allow, never past `reach`
            var lim = reach;
            partners.forEach(function (w) {
              // keep dot(P0 + t dir - V, w) >= 0
              var dw = dot(L.dir, w), c0 = dot(sub(P0, V), w);
              if (Math.abs(dw) < 1e-9) return;
              var tb = -c0 / dw;                             // the t where this point meets the plane
              var past = end ? tb - L.len : -tb;             // how far past V that is
              lim = Math.min(lim, past);
            });
            if (end) t1[i] = L.len + lim; else t0[i] = -lim;
          }
        });
      });
      for (var i = 0; i < pts.length; i++) if (t1[i] - t0[i] < 1e-4) t1[i] = t0[i] + 1e-4;
      var prism = prismSoup(L.p0, L.dir, pts, t0, t1);
      if (L.convex) { cuts.push(prism); build.convex++; } else { fills.push(prism); build.concave++; }
      pk.d = pr.d;
    });
    build.perEdge = picked.map(function (pk) { return { id: pk.id, R: pk.R, Rused: pk.Rused, convex: pk.L.convex, mode: pk.mode }; });
    return { cuts: cuts, fills: fills, build: build };
  }

  /* Planes of a soup, for telling a face the fill made from one the piece had. */
  function planeSet(soup) {
    var out = [], n = (soup.length / 9) | 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9, a = [soup[o], soup[o + 1], soup[o + 2]];
      var nn = cross(sub([soup[o + 3], soup[o + 4], soup[o + 5]], a), sub([soup[o + 6], soup[o + 7], soup[o + 8]], a));
      var l = len(nn);
      if (l < 1e-12) continue;
      nn = mul(nn, 1 / l);
      var d = dot(nn, a), seen = false;
      for (var i = 0; i < out.length && !seen; i++) if (dot(out[i].n, nn) > 0.99999 && Math.abs(out[i].d - d) < 1e-3) seen = true;
      if (!seen) out.push({ n: nn, d: d });
    }
    return out;
  }
  function hasPlane(set, n, p) {
    var d = dot(n, p);
    for (var i = 0; i < set.length; i++) if (dot(set[i].n, n) > 0.99999 && Math.abs(set[i].d - d) < 1e-3) return true;
    return false;
  }
  function onLine(A, B) {          // B lies along A (same line, same two planes) and overlaps it
    if (A.convex !== B.convex || Math.abs(dot(A.dir, B.dir)) < 0.99999) return false;
    var pl = function (n, p, L) { return samePlane(n, p, L.n1, L.p0) || samePlane(n, p, L.n2, L.p0); };
    if (!pl(A.n1, A.p0, B) || !pl(A.n2, A.p0, B)) return false;
    var off = sub(B.p0, A.p0), perp = sub(off, mul(A.dir, dot(off, A.dir)));
    if (len(perp) > 1e-3) return false;
    var s0 = dot(sub(B.p0, A.p0), A.dir), s1 = dot(sub(B.p1, A.p0), A.dir);
    return Math.max(s0, s1) > 1e-3 && Math.min(s0, s1) < A.len - 1e-3;
  }

  /* The whole job: specs [{ id, R, mode }] on the lines of `soup`, through a
     boolean pair (async, { ok, soup, reason }). -> Promise { ok, soup, build, reason }

     Fills go first. Where a picked rim runs into a fillet that was just added
     (the rims of a notch meeting its rounded inside corner), the rim is read
     again off the filled piece and carried round the fillet's curve, so the
     fillet's end is rounded with it instead of standing proud as a fin. */
  function runOnce(soup, specs, union, subtract, opts) {
    opts = opts || {};
    var lines = opts.lines || findLines(soup);
    var tools = edgeTools(soup, lines, specs);
    var build = tools.build;
    var seq = function (work, list, op) {
      var i = 0;
      var step = function (w) {
        if (i >= list.length) return Promise.resolve({ ok: true, soup: w });
        var tool = list[i++];
        return Promise.resolve(op(w, tool)).then(function (r) {
          if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'the boolean refused' };
          return step(r.soup);
        });
      };
      return step(work);
    };
    // all the tools of one kind are made one solid first, then applied once: two prisms that
    // meet on a mitre share a face, and taken one at a time they would leave that face behind
    // as a sheet of zero thickness
    var once = function (work, list, op) {
      if (!list.length) return Promise.resolve({ ok: true, soup: work });
      return seq(list[0], list.slice(1), union).then(function (m) {
        if (!m.ok) return m;
        return Promise.resolve(op(work, m.soup)).then(function (r) {
          return (r && r.ok) ? r : { ok: false, reason: (r && r.reason) || 'the boolean refused' };
        });
      });
    };
    if (!tools.fills.length || !tools.cuts.length) {
      return once(soup, tools.fills, union).then(function (r) {
        if (!r.ok) return { ok: false, reason: r.reason, build: build };
        return once(r.soup, tools.cuts, subtract).then(function (r2) {
          return r2.ok ? { ok: true, soup: r2.soup, build: build } : { ok: false, reason: r2.reason, build: build };
        });
      });
    }
    var byId = new Map();
    lines.forEach(function (l) { byId.set(l.id, l); });
    var before = planeSet(soup);
    return once(soup, tools.fills, union).then(function (r) {
      if (!r.ok) return { ok: false, reason: r.reason, build: build };
      var filled = tidy(r.soup), lines2 = findLines(filled), specs2 = [], taken = new Set();
      var take = function (L2, sp) {
        if (taken.has(L2.id)) return;
        taken.add(L2.id);
        specs2.push({ id: L2.id, R: sp.R, mode: sp.mode });
      };
      var seeds = [];
      specs.forEach(function (sp) {
        var L = byId.get(sp.id);
        if (!L || !L.convex) return;
        lines2.forEach(function (L2) { if (onLine(L, L2)) { take(L2, sp); seeds.push({ L: L2, sp: sp }); } });
      });
      // carry each rim on round a fillet: convex lines on one of its faces, the other face new
      var carried = 0;
      while (seeds.length) {
        var sd = seeds.pop();
        [sd.L.p0, sd.L.p1].forEach(function (V) {
          lines2.forEach(function (L2) {
            if (taken.has(L2.id) || !L2.convex) return;
            if (!near(L2.p0, V) && !near(L2.p1, V)) return;
            var shared = samePlane(L2.n1, L2.p0, sd.L.n1, sd.L.p0) || samePlane(L2.n1, L2.p0, sd.L.n2, sd.L.p0) ? 1 :
                         (samePlane(L2.n2, L2.p0, sd.L.n1, sd.L.p0) || samePlane(L2.n2, L2.p0, sd.L.n2, sd.L.p0) ? 2 : 0);
            if (!shared) return;
            var other = shared === 1 ? L2.n2 : L2.n1;
            if (hasPlane(before, other, L2.p0)) return;      // that face was the piece's own: not a fillet's
            take(L2, sd.sp); carried++;
            seeds.push({ L: L2, sp: sd.sp });
          });
        });
      }
      build.carried = carried;
      var t2 = edgeTools(filled, lines2, specs2);
      build.ends = t2.build.ends;
      return once(filled, t2.cuts, subtract).then(function (r2) {
        return r2.ok ? { ok: true, soup: r2.soup, build: build } : { ok: false, reason: r2.reason, build: build };
      });
    });
  }

  /* Open and over-shared edges on the seal test's weld grid (nsoSealScore's count). */
  function seal(soup) {
    var q = WELD, use = new Map();
    var vk = function (i) { return Math.round(soup[i] * q) + '|' + Math.round(soup[i + 1] * q) + '|' + Math.round(soup[i + 2] * q); };
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var K = [vk(t), vk(t + 3), vk(t + 6)];
      for (var e = 0; e < 3; e++) {
        var a = K[e], b = K[(e + 1) % 3];
        if (a === b) continue;
        var k = a < b ? a + '~' + b : b + '~' + a;
        use.set(k, (use.get(k) || 0) + 1);
      }
    }
    var open = 0, nm = 0;
    use.forEach(function (c) { if (c % 2) open++; if (c > 2) nm++; });
    return { open: open, nm: nm };
  }

  /* The kernel's answer on the seal test's grid. Where a tool's face passes exactly through a
     corner of the piece the kernel can hand back two copies of that corner a rounding error
     apart, joined by a needle triangle of no area. Snapped to the grid the copies are one point
     and the needle has two equal corners: it is dropped, and what is left is the skin. */
  function tidy(soup) {
    var out = new Float32Array(soup.length), w = 0;
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var k = [];
      for (var c = 0; c < 3; c++) {
        var x = Math.round(soup[t + c * 3] * WELD), y = Math.round(soup[t + c * 3 + 1] * WELD), z = Math.round(soup[t + c * 3 + 2] * WELD);
        k.push([x, y, z]);
      }
      var eq = function (a, b) { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; };
      if (eq(k[0], k[1]) || eq(k[1], k[2]) || eq(k[0], k[2])) continue;
      for (c = 0; c < 3; c++) for (var j = 0; j < 3; j++) out[w++] = k[c][j] / WELD;
    }
    return out.slice(0, w);
  }

  /* runOnce, and again a hair smaller when it does not come out sealed. Two rounds that
     happen to meet exactly on a corner of the piece touch there along a line or a point -
     solid, but not a clean skin - and a radius a fraction smaller pulls them apart. */
  function run(soup, specs, union, subtract, opts) {
    var base = seal(soup), tries = [1, 0.995, 0.98, 0.95], i = 0, first = null;
    var next = function () {
      var k = tries[i++];
      var sp = specs.map(function (s) { return { id: s.id, R: s.R * k, mode: s.mode }; });
      return runOnce(soup, sp, union, subtract, opts).then(function (r) {
        if (r.ok) {
          r.soup = tidy(r.soup);
          var sc = seal(r.soup);
          r.build.sealed = sc.open <= base.open && sc.nm <= base.nm;
          r.build.shrunk = k;
          if (!first) first = r;
          if (r.build.sealed) return r;
        }
        if (i < tries.length) return next();
        return first || r;
      });
    };
    return next();
  }

  var api = { lines: findLines, tools: edgeTools, run: run, seal: seal, tidy: tidy, inside: inside, FEATURE_DEG: FEATURE_DEG };
  root.NSO_MeshEdges = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
