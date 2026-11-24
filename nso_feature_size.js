/* ============================================================
   nso_feature_size.js - find a feature on a piece (a tab, a boss, a slot, a
   pocket) and size it, leaving the rest of the piece where it was.
   docs/FEATURE-SIZE.md. Headless: no DOM, no THREE, no app state. The page
   loads it as window.NSO_FeatureSize and node requires it
   (tools/nso_feature_size_test.js). The card on it is app-scale-feature.js,
   in the Scale card.

   WHY. A tab on a lid fitted its slot; the slotted piece was then scaled and
   the slot shrank with it. Scale resizes a whole piece, Offset moves every
   wall; neither resizes ONE feature. This does:

     find(soup, tri)          the feature the clicked triangle is on
     measure(soup, region)    its frame and its Length x Width x Height
     resize(soup, regions, target, mode)
                              a new soup with each feature at the target size,
                              each about its own middle, its foot kept on the
                              face it stands on

   ---------------------------------------------------------------------------
   WHAT A FEATURE IS
   ---------------------------------------------------------------------------
   A RAISED feature (a tab, a boss, a rib) is the faces you can walk across
   from the clicked one without stepping over an inside corner - a CONCAVE
   crease sharper than CREASE_DEG. A tongue's bottom, its four sides and its
   eased edges are one walk; the corner where its sides meet the plate is
   concave, so the walk stops there. A RECESSED feature (a slot, a pocket, a
   bore) is the same walk with the crease reversed: across inside corners,
   stopping at outside ones, so a slot's floor and walls are the feature and
   the rim round its mouth is where it stops.

   'auto' tries raised first. A raised walk that finds nothing standing proud
   of its own edge (a slot's floor, walked as raised, is a flat patch with no
   height) or that takes most of the piece is not a feature, and recessed is
   tried. A walk that takes over half of the piece's area is refused either
   way: that is the piece, not something on it.

   THE FOOT is where the walk stopped: the feature's boundary edges. It must
   be flat (within FOOT_TOL), because the foot moves only in its own plane -
   a tab's foot slides across the face it stands on, and the face's triangles
   round it stretch to follow. Its plane gives the feature's frame:
     n   the foot's normal, pointing the way the feature goes (out of the face
         for a tab, into the piece for a slot), so every height is >= 0
     u   in the plane, along the feature's length (the long side of the
         smallest rectangle round it, as the face frame in app-asm-editor.js
         is found), v = n x u across it
     Length, Width   the rectangle; Height   how far the feature goes along n.

   ---------------------------------------------------------------------------
   HOW IT RESIZES - two modes
   ---------------------------------------------------------------------------
   'keep' (the default) MOVES THE ENDS. The outer 30% of each half of the
   feature (BAND) moves out or in by half the change, rigidly, as the end of a
   box does: a 25 mm tongue made 20 has each end moved 2.5 mm in. Corners,
   ease chamfers, fillets and a rounded tip inside that band keep their size
   and shape; the middle 70% stretches (or squeezes) to meet the ends. Height
   moves the top 30% by the whole change and stretches the rest from the foot;
   the foot never moves along n. The least it goes down to is 30% of the size
   (the band meets the middle); Stretch has no such floor.

   'stretch' SCALES the feature about its middle (Length, Width) and about its
   foot (Height). A round pin made thicker stays round this way; under 'keep'
   it would become a stadium.

   ONLY THE FEATURE'S VERTICES MOVE. The faces round the foot share the foot's
   vertices, so they stretch to follow and the piece stays closed - no
   triangle is added or removed, the topology is the input's.

   REFUSED, in words, with nothing changed:
     - a fold: a triangle that would turn over (shrinking a side past the
       middle, or the foot past a corner of the face round it)
     - a vertex in two of the picked features
     - a size that is not a number above zero
   ============================================================ */
(function (root) {
  'use strict';

  var WELD = 1e4;           // positions closer than 1e-4 mm are one vertex
  var CREASE_DEG = 20;      // a crease sharper than this is a corner the walk can stop at
  var FOOT_TOL = 0.05;      // mm: the foot must lie in one plane within this
  var MAX_SHARE = 0.5;      // a "feature" with more than this share of the piece's area is the piece
  var MIN_HEIGHT = 0.05;    // mm: a raised walk with less than this standing proud is not a feature
  var SIDE_TOL = 1e-4;      // mm: a vertex this close to the middle is ON the middle and does not move
  var BAND = 0.3;           // 'keep': the outer 30% of each half moves rigidly; the middle stretches
  var MODES = ['keep', 'stretch'];

  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }

  /* ---------------- the mesh as vertices and faces ---------------- */

  function index(soup) {
    var map = new Map(), pos = [], tri = new Int32Array(soup.length / 3);
    for (var i = 0, c = 0; i < soup.length; i += 3, c++) {
      var k = Math.round(soup[i] * WELD) + ',' + Math.round(soup[i + 1] * WELD) + ',' + Math.round(soup[i + 2] * WELD);
      var id = map.get(k);
      if (id === undefined) { id = pos.length / 3; pos.push(soup[i], soup[i + 1], soup[i + 2]); map.set(k, id); }
      tri[c] = id;
    }
    var nf = tri.length / 3, N = new Float64Array(nf * 3), A = new Float64Array(nf);
    var edges = new Map();
    for (var f = 0; f < nf; f++) {
      var a = tri[f * 3] * 3, b = tri[f * 3 + 1] * 3, d = tri[f * 3 + 2] * 3;
      var ex = pos[b] - pos[a], ey = pos[b + 1] - pos[a + 1], ez = pos[b + 2] - pos[a + 2];
      var gx = pos[d] - pos[a], gy = pos[d + 1] - pos[a + 1], gz = pos[d + 2] - pos[a + 2];
      var nx = ey * gz - ez * gy, ny = ez * gx - ex * gz, nz = ex * gy - ey * gx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      A[f] = L / 2;
      if (L > 1e-14) { N[f * 3] = nx / L; N[f * 3 + 1] = ny / L; N[f * 3 + 2] = nz / L; }
      for (var k2 = 0; k2 < 3; k2++) {
        var p = tri[f * 3 + k2], q = tri[f * 3 + (k2 + 1) % 3];
        var key = p < q ? p + '_' + q : q + '_' + p;
        var list = edges.get(key);
        if (!list) edges.set(key, list = []);
        list.push(f);
      }
    }
    return { pos: pos, tri: tri, nf: nf, N: N, A: A, edges: edges };
  }

  function edgeKey(p, q) { return p < q ? p + '_' + q : q + '_' + p; }

  /* The crease between face f and its neighbour g across edge (p, q):
     0 smooth, +1 convex (an outside corner), -1 concave (an inside one). */
  function crease(ix, f, g, p, q, cosCrease) {
    var N = ix.N;
    if (N[f * 3] * N[g * 3] + N[f * 3 + 1] * N[g * 3 + 1] + N[f * 3 + 2] * N[g * 3 + 2] > cosCrease) return 0;
    var o = -1;
    for (var k = 0; k < 3; k++) { var w = ix.tri[g * 3 + k]; if (w !== p && w !== q) o = w; }
    if (o < 0) return 0;
    var P = ix.pos;
    var s = (P[o * 3] - P[p * 3]) * N[f * 3] + (P[o * 3 + 1] - P[p * 3 + 1]) * N[f * 3 + 1] + (P[o * 3 + 2] - P[p * 3 + 2]) * N[f * 3 + 2];
    return s < 0 ? 1 : -1;
  }

  /* ---------------- the walk ---------------- */

  function walk(ix, seed, kind, cosCrease) {
    var stopAt = kind === 'raised' ? -1 : 1;
    var inR = new Uint8Array(ix.nf), stack = [seed], faces = [];
    inR[seed] = 1;
    while (stack.length) {
      var f = stack.pop();
      faces.push(f);
      for (var k = 0; k < 3; k++) {
        var p = ix.tri[f * 3 + k], q = ix.tri[f * 3 + (k + 1) % 3];
        var list = ix.edges.get(edgeKey(p, q));
        if (!list || list.length !== 2) continue;            // an open or non-manifold edge: the walk does not cross it
        var g = list[0] === f ? list[1] : list[0];
        if (inR[g]) continue;
        if (crease(ix, f, g, p, q, cosCrease) === stopAt) continue;
        inR[g] = 1; stack.push(g);
      }
    }
    return { faces: faces, inR: inR };
  }

  /* ---------------- small linear algebra ---------------- */

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var L = Math.sqrt(dot(a, a)); return L > 1e-15 ? [a[0] / L, a[1] / L, a[2] / L] : [0, 0, 0]; }

  /* The eigenvector of the smallest eigenvalue of a symmetric 3x3 (Jacobi). */
  function smallestAxis(C) {
    var a = [[C[0], C[1], C[2]], [C[1], C[3], C[4]], [C[2], C[4], C[5]]];
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 50; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-18) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        var t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        var c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (var k = 0; k < 3; k++) {
          var akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (k = 0; k < 3; k++) {
          var apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (k = 0; k < 3; k++) {
          var vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
    var best = 0;
    for (var i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
    return unit([v[0][best], v[1][best], v[2][best]]);
  }

  /* ---------------- the frame ---------------- */

  /* The feature's foot, its plane, its rectangle and its height. */
  function frameOf(ix, faces, inR) {
    var P = ix.pos, foot = new Map(), footEdges = [], verts = new Map();
    faces.forEach(function (f) {
      for (var k = 0; k < 3; k++) {
        var p = ix.tri[f * 3 + k], q = ix.tri[f * 3 + (k + 1) % 3];
        verts.set(p, true);
        var list = ix.edges.get(edgeKey(p, q));
        var other = list && list.length === 2 ? (list[0] === f ? list[1] : list[0]) : -1;
        if (other < 0 || !inR[other]) { foot.set(p, true); foot.set(q, true); footEdges.push([p, q]); }
      }
    });
    if (!foot.size) return { ok: false, reason: 'it has no edge - it is a whole closed shell, not a feature on one' };
    var ids = Array.from(foot.keys()), c = [0, 0, 0];
    ids.forEach(function (i) { c[0] += P[i * 3]; c[1] += P[i * 3 + 1]; c[2] += P[i * 3 + 2]; });
    c = [c[0] / ids.length, c[1] / ids.length, c[2] / ids.length];
    var C = [0, 0, 0, 0, 0, 0];
    ids.forEach(function (i) {
      var x = P[i * 3] - c[0], y = P[i * 3 + 1] - c[1], z = P[i * 3 + 2] - c[2];
      C[0] += x * x; C[1] += x * y; C[2] += x * z; C[3] += y * y; C[4] += y * z; C[5] += z * z;
    });
    var n = smallestAxis(C);
    var flat = 0;
    ids.forEach(function (i) { flat = Math.max(flat, Math.abs(dot(sub([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c), n))); });
    if (flat > FOOT_TOL) return { ok: false, reason: 'its foot is not flat (it stands ' + f2(flat) + ' mm out of one plane) - it can only be sized where it meets a flat face' };
    /* n the way the feature goes: most of its off-foot vertices on the + side */
    var vids = Array.from(verts.keys()), hs = 0;
    vids.forEach(function (i) { hs += dot(sub([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c), n); });
    if (hs < 0) n = [-n[0], -n[1], -n[2]];
    /* the smallest rectangle round it, over the directions of its own edges */
    var t0 = Math.abs(n[0]) < 0.9 ? unit(cross(n, [1, 0, 0])) : unit(cross(n, [0, 1, 0]));
    var t1 = cross(n, t0), cands = {}, k;
    faces.forEach(function (f) {
      for (k = 0; k < 3; k++) {
        var p = ix.tri[f * 3 + k], q = ix.tri[f * 3 + (k + 1) % 3];
        var e = sub([P[q * 3], P[q * 3 + 1], P[q * 3 + 2]], [P[p * 3], P[p * 3 + 1], P[p * 3 + 2]]);
        var a = dot(e, t0), b = dot(e, t1), L = Math.hypot(a, b);
        if (L < 1e-6) continue;
        var ang = Math.atan2(b, a);
        ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
        var key = Math.round(ang * 360 / Math.PI);         // half-degree buckets
        if (key === 180) key = 0;
        if (!cands[key]) cands[key] = { ang: ang, len: 0 };
        cands[key].len += L;
      }
    });
    var list = Object.keys(cands).map(function (q) { return cands[q]; }).sort(function (a, b) { return b.len - a.len; }).slice(0, 24);
    list.push({ ang: 0, len: 0 });
    var best = null;
    list.forEach(function (cd) {
      var u = unit([t0[0] * Math.cos(cd.ang) + t1[0] * Math.sin(cd.ang), t0[1] * Math.cos(cd.ang) + t1[1] * Math.sin(cd.ang), t0[2] * Math.cos(cd.ang) + t1[2] * Math.sin(cd.ang)]);
      var v = cross(n, u), u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      vids.forEach(function (i) {
        var p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], a = dot(p, u), b = dot(p, v);
        if (a < u0) u0 = a; if (a > u1) u1 = a; if (b < v0) v0 = b; if (b > v1) v1 = b;
      });
      var area = (u1 - u0) * (v1 - v0);
      if (!best || area < best.area - 1e-9) best = { u: u, v: v, u0: u0, u1: u1, v0: v0, v1: v1, area: area };
    });
    var u = best.u, v = best.v;
    if (best.v1 - best.v0 > best.u1 - best.u0 + 1e-9) {          // u along the longer side
      var nu = v, nv = [-u[0], -u[1], -u[2]];
      best = { u: nu, v: nv, u0: best.v0, u1: best.v1, v0: -best.u1, v1: -best.u0 };
      u = nu; v = nv;
    }
    var hMax = 0;
    vids.forEach(function (i) { hMax = Math.max(hMax, dot(sub([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c), n)); });
    var cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2;
    /* the middle: the rectangle's centre, on the foot's plane */
    var dc = dot(c, n), o = [u[0] * cu + v[0] * cv + n[0] * dc, u[1] * cu + v[1] * cv + n[1] * dc, u[2] * cu + v[2] * cv + n[2] * dc];
    return {
      ok: true, o: o, u: u, v: v, n: n,
      length: best.u1 - best.u0, width: best.v1 - best.v0, height: hMax,
      footVerts: ids.length, footEdges: footEdges.length, verts: vids
    };
  }

  /* ---------------- find ---------------- */

  /* The feature the triangle `tri` of `soup` is on. opts.kind: 'auto' (the
     default), 'raised' or 'recessed'. -> { ok, kind, faces, frame, ... } */
  function find(soup, tri, opts) {
    opts = opts || {};
    var ix = opts.ix || index(soup);
    if (!(tri >= 0 && tri < ix.nf)) return { ok: false, reason: 'no triangle there' };
    if (!(ix.A[tri] > 1e-12)) return { ok: false, reason: 'that triangle has no area - click a little way off it' };
    var cosCrease = Math.cos((opts.creaseDeg || CREASE_DEG) * Math.PI / 180);
    var total = 0;
    for (var f = 0; f < ix.nf; f++) total += ix.A[f];
    var kinds = opts.kind === 'raised' || opts.kind === 'recessed' ? [opts.kind] : ['raised', 'recessed'];
    var why = [];
    for (var i = 0; i < kinds.length; i++) {
      var kind = kinds[i], w = walk(ix, tri, kind, cosCrease), area = 0;
      w.faces.forEach(function (g) { area += ix.A[g]; });
      if (area > MAX_SHARE * total) { why.push(kind + ': it takes ' + Math.round(area / total * 100) + '% of the piece'); continue; }
      var fr = frameOf(ix, w.faces, w.inR);
      if (!fr.ok) { why.push(kind + ': ' + fr.reason); continue; }
      if (fr.height < MIN_HEIGHT) { why.push(kind + ': nothing stands ' + (kind === 'raised' ? 'proud of' : 'back from') + ' its edge'); continue; }
      return { ok: true, kind: kind, seed: tri, faces: w.faces, frame: fr, area: area, share: area / total, ix: ix };
    }
    return { ok: false, reason: 'that is not a feature on the piece (' + why.join('; ') + '). Click a tab, boss, rib, slot or pocket itself.' };
  }

  /* ---------------- resize ---------------- */

  function num(x) { x = +x; return isFinite(x) ? x : NaN; }

  /* Where each vertex of one feature goes. -> { ok, moves: Map(id -> [x,y,z]) } */
  function plan(ix, R, target, mode) {
    var fr = R.frame, P = ix.pos, o = fr.o, u = fr.u, v = fr.v, n = fr.n;
    var L = target.length != null ? num(target.length) : fr.length;
    var W = target.width != null ? num(target.width) : fr.width;
    var H = target.height != null ? num(target.height) : fr.height;
    if (!(L > 0)) return { ok: false, reason: 'Length must be more than 0' };
    if (!(W > 0)) return { ok: false, reason: 'Width must be more than 0' };
    if (!(H > 0)) return { ok: false, reason: 'Height must be more than 0' };
    var sL = L / fr.length, sW = W / fr.width, sH = H / fr.height;
    var eu = fr.length / 2, ev = fr.width / 2, eh = fr.height;
    var mu = (1 - BAND) * eu, mv = (1 - BAND) * ev, mh = (1 - BAND) * eh;
    var du = (L - fr.length) / 2, dv = (W - fr.width) / 2, dh = H - fr.height;
    if (mode === 'keep') {
      if (mu + du <= SIDE_TOL) return { ok: false, reason: 'Length can come down to ' + f2(BAND * fr.length) + ' mm at the least with the ends kept. Try Stretch.' };
      if (mv + dv <= SIDE_TOL) return { ok: false, reason: 'Width can come down to ' + f2(BAND * fr.width) + ' mm at the least with the sides kept. Try Stretch.' };
      if (mh + dh <= SIDE_TOL) return { ok: false, reason: 'Height can come down to ' + f2(BAND * fr.height) + ' mm at the least with the top kept. Try Stretch.' };
    }
    /* keep: the outer BAND of each half moves as one (a side, its corners and
       its ease go together); the middle stretches to meet it */
    function keep(x, m, d) {
      var ax = Math.abs(x);
      if (ax <= SIDE_TOL) return x;
      var y = ax <= m ? ax * (m + d) / m : ax + d;
      return x < 0 ? -y : y;
    }
    var moves = new Map();
    fr.verts.forEach(function (i) {
      var d = [P[i * 3] - o[0], P[i * 3 + 1] - o[1], P[i * 3 + 2] - o[2]];
      var a = dot(d, u), b = dot(d, v), h = dot(d, n), a2, b2, h2;
      if (mode === 'stretch') { a2 = a * sL; b2 = b * sW; h2 = h * sH; }
      else {
        a2 = keep(a, mu, du); b2 = keep(b, mv, dv);
        h2 = h <= SIDE_TOL ? h : (h <= mh ? h * (mh + dh) / mh : h + dh);
      }
      if (a2 === a && b2 === b && h2 === h) return;
      moves.set(i, [P[i * 3] + u[0] * (a2 - a) + v[0] * (b2 - b) + n[0] * (h2 - h),
                    P[i * 3 + 1] + u[1] * (a2 - a) + v[1] * (b2 - b) + n[1] * (h2 - h),
                    P[i * 3 + 2] + u[2] * (a2 - a) + v[2] * (b2 - b) + n[2] * (h2 - h)]);
    });
    return { ok: true, moves: moves, target: { length: L, width: W, height: H } };
  }

  /* regions: what find() returned (one or more, on the same soup).
     target: { length, width, height } in mm (any left out keeps its size).
     mode: 'keep' (move the sides, the default) or 'stretch'.
     -> { ok, soup, moved, sizes: [{length, width, height}] } | { ok: false, reason } */
  function resize(soup, regions, target, mode) {
    if (!regions || !regions.length) return { ok: false, reason: 'no feature picked' };
    mode = MODES.indexOf(mode) >= 0 ? mode : 'keep';
    var ix = regions[0].ix || index(soup);
    var all = new Map(), i;
    for (i = 0; i < regions.length; i++) {
      var R = regions[i];
      if (!R || !R.ok) return { ok: false, reason: 'feature ' + (i + 1) + ' is not one' };
      var p = plan(ix, R, target || {}, mode);
      if (!p.ok) return { ok: false, reason: (regions.length > 1 ? 'feature ' + (i + 1) + ': ' : '') + p.reason };
      var clash = false;
      p.moves.forEach(function (to, id) { if (all.has(id)) clash = true; all.set(id, to); });
      if (clash) return { ok: false, reason: 'two of the picked features share a corner - pick them one at a time' };
    }
    var P = ix.pos, out = new Float32Array(soup.length), tri = ix.tri, N = ix.N;
    for (var c = 0; c < tri.length; c++) {
      var to = all.get(tri[c]);
      if (to) { out[c * 3] = to[0]; out[c * 3 + 1] = to[1]; out[c * 3 + 2] = to[2]; }
      else { out[c * 3] = soup[c * 3]; out[c * 3 + 1] = soup[c * 3 + 1]; out[c * 3 + 2] = soup[c * 3 + 2]; }
    }
    var folded = foldsOf(ix, out, all);
    var faceMap = null, refloored = 0;
    if (folded.list.length) {
      var rf = refloor(ix, out, regions, folded.list);
      if (!rf.ok) return { ok: false, reason: rf.edge ? rf.reason + ' - make it smaller' :
        folded.list.length + ' triangle(s) would turn over - the feature would fold into the face round it' + (rf.reason ? ' (' + rf.reason + ')' : '') + '. Make the change smaller' + (mode === 'keep' ? ', or try Stretch' : '') };
      out = rf.soup; faceMap = rf.faceMap; refloored = rf.patches;
    }
    var sizes = regions.map(function (R2) {
      var faces2 = faceMap ? R2.faces.map(function (g) { return faceMap[g]; }) : R2.faces;
      var ix2 = index(out), m2 = new Uint8Array(ix2.nf);
      faces2.forEach(function (g) { m2[g] = 1; });
      var fr = frameOf(ix2, faces2, m2);
      return fr.ok ? { length: fr.length, width: fr.width, height: fr.height } : null;
    });
    return { ok: true, soup: out, moved: folded.moved, vertices: all.size, sizes: sizes, mode: mode, refloored: refloored, faceMap: faceMap };
  }

  /* Every triangle with a moved corner that turns over (or loses nearly all
     of its area) once the corners have moved. */
  function foldsOf(ix, out, all) {
    var tri = ix.tri, N = ix.N, list = [], moved = 0;
    for (var f = 0; f < ix.nf; f++) {
      if (!(all.has(tri[f * 3]) || all.has(tri[f * 3 + 1]) || all.has(tri[f * 3 + 2]))) continue;
      moved++;
      if (!(ix.A[f] > 1e-12)) continue;
      var o9 = f * 9;
      var ex = out[o9 + 3] - out[o9], ey = out[o9 + 4] - out[o9 + 1], ez = out[o9 + 5] - out[o9 + 2];
      var gx = out[o9 + 6] - out[o9], gy = out[o9 + 7] - out[o9 + 1], gz = out[o9 + 8] - out[o9 + 2];
      var nx = ey * gz - ez * gy, ny = ez * gx - ex * gz, nz = ex * gy - ey * gx;
      var along = nx * N[f * 3] + ny * N[f * 3 + 1] + nz * N[f * 3 + 2];
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(along > 1e-9) || along < 0.5 * L) list.push(f);
    }
    return { list: list, moved: moved };
  }

  /* A foot that grows past the corners of the flat face it stands on folds
     that face's triangles. The face is flat, so its triangles say nothing but
     where its edge is: it is laid again, inside its own unchanged edge and
     round the moved foot (NSO_CDT, the triangulation Weave and Custom shape
     use). Its rim edges are the old ones, vertex for vertex, so the piece
     stays closed. Refused if a folded triangle is not on a foot's flat face,
     or the moved foot crosses the face's edge. */
  function refloor(ix, out, regions, folded) {
    var CDT = root.NSO_CDT || (typeof require === 'function' ? (function () { try { return require('./nso_cdt.js'); } catch (e) { return null; } })() : null);
    if (!CDT) return { ok: false, reason: 'nso_cdt.js did not load' };
    var P = ix.pos, tri = ix.tri, N = ix.N, nf = ix.nf;
    var inR = new Uint8Array(nf);
    regions.forEach(function (R) { R.faces.forEach(function (g) { inR[g] = 1; }); });
    function planeOf(f) {
      for (var r = 0; r < regions.length; r++) {
        var fr = regions[r].frame, n = fr.n;
        var c = Math.abs(N[f * 3] * n[0] + N[f * 3 + 1] * n[1] + N[f * 3 + 2] * n[2]);
        if (c < 0.9999) continue;
        var a = tri[f * 3] * 3, dist = P[a] * n[0] + P[a + 1] * n[1] + P[a + 2] * n[2] - dot(fr.o, n);
        if (Math.abs(dist) <= FOOT_TOL) return r;
      }
      return -1;
    }
    var inPatch = new Int32Array(nf).fill(-1), patches = [];
    for (var k = 0; k < folded.length; k++) {
      var f0 = folded[k];
      if (inR[f0]) return { ok: false, reason: 'the feature itself folds' };
      if (inPatch[f0] >= 0) continue;
      var r0 = planeOf(f0);
      if (r0 < 0) return { ok: false, reason: 'a folded triangle is not on the flat face the feature stands on' };
      var id = patches.length, faces = [], stack = [f0];
      inPatch[f0] = id;
      while (stack.length) {
        var f = stack.pop(); faces.push(f);
        for (var e = 0; e < 3; e++) {
          var p = tri[f * 3 + e], q = tri[f * 3 + (e + 1) % 3], list = ix.edges.get(edgeKey(p, q));
          if (!list || list.length !== 2) continue;
          var g = list[0] === f ? list[1] : list[0];
          if (inPatch[g] >= 0 || inR[g] || planeOf(g) !== r0) continue;
          inPatch[g] = id; stack.push(g);
        }
      }
      patches.push({ r: r0, faces: faces });
    }
    var added = [];
    for (var pi = 0; pi < patches.length; pi++) {
      var pt = patches[pi], fr = regions[pt.r].frame, u = fr.u, v = fr.v, n = fr.n;
      var sign = 0;
      pt.faces.forEach(function (g) { sign += N[g * 3] * n[0] + N[g * 3 + 1] * n[1] + N[g * 3 + 2] * n[2]; });
      /* the patch's rim: its edges with the other side outside it */
      var segsV = [], used = new Map();
      pt.faces.forEach(function (g) {
        for (var e2 = 0; e2 < 3; e2++) {
          var p2 = tri[g * 3 + e2], q2 = tri[g * 3 + (e2 + 1) % 3], l2 = ix.edges.get(edgeKey(p2, q2));
          var other = l2 && l2.length === 2 ? (l2[0] === g ? l2[1] : l2[0]) : -1;
          if (other >= 0 && inPatch[other] === pi) continue;
          segsV.push([p2, q2]); used.set(p2, true); used.set(q2, true);
        }
      });
      /* a vertex inside the patch that something else also uses cannot be dropped */
      var inner = new Map();
      pt.faces.forEach(function (g) { for (var e3 = 0; e3 < 3; e3++) { var w = tri[g * 3 + e3]; if (!used.has(w)) inner.set(w, true); } });
      for (var g2 = 0; g2 < nf && inner.size; g2++) {
        if (inPatch[g2] === pi) continue;
        for (var e4 = 0; e4 < 3; e4++) if (inner.has(tri[g2 * 3 + e4])) return { ok: false, reason: 'the face round it is joined to the rest at a lone corner' };
      }
      /* 2D, with the moved positions: the rim's corners are written in `out` */
      var where = new Map();
      for (var c = 0; c < tri.length; c++) if (used.has(tri[c]) && !where.has(tri[c])) where.set(tri[c], [out[c * 3], out[c * 3 + 1], out[c * 3 + 2]]);
      var ids = Array.from(used.keys()), slot = new Map(), pts2 = [];
      ids.forEach(function (w, i2) { var x = where.get(w); slot.set(w, i2); pts2.push([dot(x, u), dot(x, v)]); });
      var segs = segsV.map(function (sg) { return [slot.get(sg[0]), slot.get(sg[1])]; });
      if (crosses(pts2, segs)) return { ok: false, edge: true, reason: 'the foot would reach past the edge of the face it stands on' };
      var t = CDT.triangulate(pts2, segs);
      if (!t || !t.tris || t.split) return { ok: false, reason: 'the face could not be laid again' + (t && t.reason ? ': ' + t.reason : '') };
      for (var q = 0; q < t.tris.length; q += 3) {
        var A = where.get(ids[t.tris[q]]), B = where.get(ids[t.tris[q + 1]]), C = where.get(ids[t.tris[q + 2]]);
        if (sign >= 0) added.push(A, B, C); else added.push(A, C, B);
      }
    }
    var faceMap = new Int32Array(nf).fill(-1), keep = 0;
    for (var f5 = 0; f5 < nf; f5++) if (inPatch[f5] < 0) faceMap[f5] = keep++;
    var soup = new Float32Array(keep * 9 + added.length * 3), w9 = 0;
    for (var f6 = 0; f6 < nf; f6++) {
      if (inPatch[f6] >= 0) continue;
      for (var z = 0; z < 9; z++) soup[w9++] = out[f6 * 9 + z];
    }
    added.forEach(function (x) { soup[w9++] = x[0]; soup[w9++] = x[1]; soup[w9++] = x[2]; });
    /* what moved and was not laid again must still not fold */
    var ix2 = index(soup), bad = 0;
    for (var f7 = 0; f7 < keep; f7++) {
      if (ix2.A[f7] > 1e-12) continue;
      bad++;
    }
    if (bad) return { ok: false, reason: bad + ' triangle(s) left with no area' };
    return { ok: true, soup: soup, faceMap: faceMap, patches: patches.length };
  }

  /* Do any two segments cross or touch (not just meet at a shared corner)? */
  function crosses(pts, segs) {
    function o(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
    function onSeg(a, b, p) {
      var L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-12 || Math.abs(o(a, b, p)) / L > 1e-6) return false;
      var t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (L * L);
      return t > -1e-9 && t < 1 + 1e-9;
    }
    for (var i = 0; i < segs.length; i++) for (var j = i + 1; j < segs.length; j++) {
      var s = segs[i], t = segs[j];
      if (s[0] === t[0] || s[0] === t[1] || s[1] === t[0] || s[1] === t[1]) continue;
      var a = pts[s[0]], b = pts[s[1]], c = pts[t[0]], d = pts[t[1]];
      var d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      /* touching counts: a corner of one lying on the other (within 1e-6 mm) */
      if (onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b)) return true;
    }
    return false;
  }

  /* Re-measure a feature on a soup with the same triangles (after a resize). */
  function measure(soup, R) {
    var ix = index(soup), inR = new Uint8Array(ix.nf);
    R.faces.forEach(function (g) { inR[g] = 1; });
    return frameOf(ix, R.faces, inR);
  }

  function describe(fr, kind) {
    return (kind === 'recessed' ? 'recess ' : 'feature ') + f2(fr.length) + ' × ' + f2(fr.width) + ' × ' + f2(fr.height) + (kind === 'recessed' ? ' deep' : ' tall');
  }

  var API = {
    index: index, find: find, resize: resize, measure: measure, describe: describe,
    MODES: MODES.slice(), CREASE_DEG: CREASE_DEG, FOOT_TOL: FOOT_TOL, MAX_SHARE: MAX_SHARE
  };
  root.NSO_FeatureSize = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
