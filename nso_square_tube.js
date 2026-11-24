// ===================== Square tubes: Reducer, Neck and Branch on a square tube =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_square_tube_test.js) and under a classic script tag in
// the browser, where Shape → Tubes with its SQUARE TUBES toggle on
// (app-tube-edge.js) calls it. docs/TUBE-EDGE.md, "Square tubes".
//
// Tubes' Reducer, Neck and Branch, for a tube whose section is a square wall
// round a square bore - the trunk and the branches of a tree support drawn
// as square tubes. Loaded after nso_tube_edge.js (its exact-bit weld, flat
// face finder, frame and volume), nso_bend.js (the topology counter) and
// nso_rod_branch.js (the tube branch's three booleans and their gates); it
// carries no copy of any of them.
//
// THE END. A flat face (Tube edge's face finder) with two boundary loops,
// each a SQUARE: exactly four corners (a turn of more than ~1° between its
// neighbours), every other point on the line between two corners, four equal
// sides (within max(0.02 mm, 0.2%)) at right angles, the two concentric and
// their sides parallel, the inner the smaller. That gives the centre, the
// axis (the face's own normal: outward), the outside's half-side a, the
// bore's half-side b, the wall t = a - b and the frame: e1 along a side of
// the outside, e2 = axis × e1. A point's "square radius" is its Chebyshev
// distance from the axis in that frame, max(|x|, |y|): every point of a side
// face is at a (outside) or b (bore).
//
// THE RADIAL LINE of a square. Scaling about the axis keeps a square a
// square: a vertex (x, y) of a loop of half-side r goes to (x, y)·r'/r on the
// loop of half-side r'. That is each vertex's own radial line, as a round
// tube's is: every new ring is the old ring's vertices carried along theirs,
// so station 0 is the loop itself (the same float32 bits) and the new wall
// shares the old one's edges - no weld, no lip, no step.
//
// REDUCER: the open end becomes a square pipe of side S2 and bore side B2.
//   Over a Transition of T mm each face goes from its own half-side to its
//   target, Straight (a frustum: a plane per side) or Trumpet (tangent to the
//   tube at the ring, its half-side changing as the square of the length -
//   sampled so no chord sags 0.01 mm), then straight on for Run mm, its end
//   square and open. The wall at the run is (S2 - B2) / 2 exactly; through
//   the transition it is measured, square to the faces, and held to the
//   nozzle-safety floor (nso_thickness.js). The lip is laid side by side
//   between the two last rings (a ladder per side, corner to corner).
// NECK: a band of Length centred where the tube is clicked (blank: its
//   middle) - the wall moved in (Δ < 0, a pinch) or out (a bulge) by Δ, a
//   change of HALF-SIDE. Smooth: a cosine, tangent to the tube at both ends.
//   Funnel: straight in to the waist and out. Walls Both carries the wall's
//   section: the two faces are offsets t/2 either side of the mid-wall's
//   curve (Funnel's corners mitred), so the wall square to its faces is t
//   wherever the curve turns no tighter than t/2 (refused otherwise, with the
//   Length it needs). Outside only / Bore only move that face alone and keep
//   the other bit for bit, held to the floor. The triangles of each face the
//   band crosses are taken out - grown until they run between two whole
//   rings of the face's vertices (a Stock square tube's: its rings) - and the
//   lower ring is carried up through the stations; the last station is
//   zipped to the upper ring side by side. Everything else is copied bit for
//   bit.
// BRANCH: press on a side face and drag outward - a square tube pulled out of
//   the wall: Side, Bore side, Tip side (a taper keeps its wall to the tip),
//   Length and Angle (20° - 160° off the tube's axis, in the plane of the
//   axis and the pressed face's normal). Its square is turned to the parent's
//   face: two of its sides square to that face, two parallel to the axis's
//   plane, so a 90° branch is a square tee and a 45° one a square wye. The
//   press is moved along the face, if need be, so the branch's foot stays on
//   that one face. Welded with Tubes → Branch's own three booleans
//   (nso_rod_branch.js NSO_rbWeldTube: the branch's outside less the parent's
//   bore, that added, the branch's bore taken out through the near wall and
//   out past its tip) and gated as it is: one solid, closed and 2-manifold,
//   the Euler characteristic down by exactly 2 (the bore opens through), the
//   volume grown by no more than the branch's outside solid. The branch's tip
//   is an open square end: a Reducer, a Neck or a branch reads it, so
//   branches grow off branches.
//
// GATES, on the output buffer (Reducer and Neck): topology - nothing opened,
// doubled or mis-wound, the Euler characteristic unchanged (Bend's counter,
// NSO_bendTopology); the volume change against the frustum sum (each band of
// a square between two parallel squares is planar side by side, so the
// prismatoid formula is exact): within 1e-3.
//
// REFUSALS, in words, the piece unchanged: no open square end (a round tube
// is Tubes with the toggle off; a solid square bar, a rectangle, each by
// name); a bore under 2 nozzle widths across; a wall under the floor; a face
// steeper than 75°; a neck past either end, too short to carry the wall, or
// over a stretch that is not straight square tube (a neck, a branch, a
// reducer already there); a branch as wide as the face, or wider.
//
// PAINT SCOPE: WHOLE-PIECE - the caller's (app-tube-edge.js), as Tubes'.

var NSO_SQ_TOL_MM = 0.02;            // a square: sides equal, centres together, points on their side, within this...
var NSO_SQ_TOL_FRAC = 2e-3;          // ...or this × the side, whichever is more
var NSO_SQ_CORNER_SIN = 0.017;       // a loop point turning more than ~1° is a corner
var NSO_SQ_RIGHT_COS = 0.01;         // a corner within ~0.6° of square
var NSO_SQ_LEVEL_MM = 1e-4;          // a ring: every vertex this close to one height along the axis
var NSO_SQ_SAG_MM = 0.01;            // chord sag on every curved run of the new wall
var NSO_SQ_MAX_SLOPE_DEG = 75;       // no new face steeper than this off the axis
var NSO_SQ_NOZZLES = 2;              // a bore (or a branch) at least 2 nozzle widths across
var NSO_SQ_VOLUME_TOL = 1e-3;
var NSO_SQ_MAX_STEPS = 512;
var NSO_SQ_BURY_MM = 0.05;           // a branch's root this far inside the parent's wall, all round
var NSO_SQ_SAME_MM = 0.05;           // a press this close to a face is on it
var NSO_SQ_RING_MM = 2;              // a new square tube's rings and side points, at most this far apart

function NSO_sqFmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
function NSO_sqNozzle(opts) {
  if (opts && typeof opts.nozzle === 'number' && opts.nozzle > 0) return opts.nozzle;
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  return (T && T.NOZZLE_DEFAULT > 0) ? T.NOZZLE_DEFAULT : 0.4;
}
function NSO_sqFloor(nozzle) {
  var f = (typeof NSO_teFloor === 'function') ? NSO_teFloor(nozzle) : null;
  return f != null ? f : 1.05 * nozzle;
}
function NSO_sqDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function NSO_sqCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function NSO_sqUnit(a) { var L = Math.hypot(a[0], a[1], a[2]); return [a[0] / L, a[1] / L, a[2] / L]; }
// a point of the end's frame: C + x e1 + y e2 + h axis
function NSO_sqAt(E, x, y, h) {
  var C = E.center, e1 = E.e1, e2 = E.e2, n = E.axis;
  return [C[0] + x * e1[0] + y * e2[0] + h * n[0], C[1] + x * e1[1] + y * e2[1] + h * n[1], C[2] + x * e1[2] + y * e2[2] + h * n[2]];
}
// a point's coordinates in the end's frame: { x, y, h, r (the square radius) }
function NSO_sqLocal(E, p) {
  var C = E.center, w = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
  var x = NSO_sqDot(w, E.e1), y = NSO_sqDot(w, E.e2);
  return { x: x, y: y, h: NSO_sqDot(w, E.axis), r: Math.max(Math.abs(x), Math.abs(y)) };
}
function NSO_sqTol(half) { return Math.max(NSO_SQ_TOL_MM, NSO_SQ_TOL_FRAC * 2 * half); }

/* =====================================================================
   1. Read the ends: flat faces bounded by squares
   ===================================================================== */

/* One loop of 2D points: is it a square? { ok, why, corners: [loop index],
   center, half, dir (unit, along its first side), area (signed) }. */
function NSO_sqLoopSquare(p2) {
  var n = p2.length, res = { ok: false, why: '', corners: [] };
  if (n < 4) { res.why = 'fewer than 4 points'; return res; }
  var area = 0;
  for (var i = 0; i < n; i++) { var a = p2[i], b = p2[(i + 1) % n]; area += a[0] * b[1] - a[1] * b[0]; }
  res.area = area / 2;
  for (var k = 0; k < n; k++) {
    var P = p2[(k + n - 1) % n], Q = p2[k], R = p2[(k + 1) % n];
    var ux = Q[0] - P[0], uy = Q[1] - P[1], vx = R[0] - Q[0], vy = R[1] - Q[1];
    var lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!(lu > 1e-9) || !(lv > 1e-9)) continue;
    var s = (ux * vy - uy * vx) / (lu * lv), c = (ux * vx + uy * vy) / (lu * lv);
    if (Math.abs(s) > NSO_SQ_CORNER_SIN || c < 0) res.corners.push(k);
  }
  if (res.corners.length !== 4) { res.why = res.corners.length + '-cornered'; res.nCorners = res.corners.length; return res; }
  var C = res.corners.map(function (j) { return p2[j]; }), sides = [], dirs = [];
  for (var q = 0; q < 4; q++) {
    var A = C[q], B = C[(q + 1) % 4], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    sides.push(L); dirs.push([(B[0] - A[0]) / L, (B[1] - A[1]) / L]);
  }
  var mean = (sides[0] + sides[1] + sides[2] + sides[3]) / 4, tol = NSO_sqTol(mean / 2);
  res.sides = sides; res.half = mean / 2; res.nCorners = 4;
  res.center = [(C[0][0] + C[1][0] + C[2][0] + C[3][0]) / 4, (C[0][1] + C[1][1] + C[2][1] + C[3][1]) / 4];
  res.dir = dirs[0];
  for (var r = 0; r < 4; r++) {
    var d0 = dirs[r], d1 = dirs[(r + 1) % 4];
    if (Math.abs(d0[0] * d1[0] + d0[1] * d1[1]) > NSO_SQ_RIGHT_COS) { res.why = 'not square-cornered'; return res; }
  }
  // every other point on the side between its two corners
  for (var m = 0; m < 4; m++) {
    var i0 = res.corners[m], i1 = res.corners[(m + 1) % 4], A2 = p2[i0], dd = dirs[m];
    for (var j2 = (i0 + 1) % n; j2 !== i1; j2 = (j2 + 1) % n) {
      var w = p2[j2], off = Math.abs((w[0] - A2[0]) * dd[1] - (w[1] - A2[1]) * dd[0]);
      if (off > tol) { res.why = 'curved between its corners'; return res; }
    }
  }
  var lo = Math.min.apply(null, sides), hi = Math.max.apply(null, sides);
  if (hi - lo > tol) { res.why = 'a rectangle'; res.rect = [NSO_sqFmt(Math.max(sides[0], sides[2])), NSO_sqFmt(Math.max(sides[1], sides[3]))]; return res; }
  res.ok = true;
  return res;
}

/* What a flat face is, as a square end: { kind: 'open' | 'closed' | 'rect' |
   'round' | 'other', ... } and for 'open': center, axis, a, b, wallMm, e1, e2,
   outer / inner (vertex ids), face. */
function NSO_sqClassFace(W, F, region) {
  var L = NSO_teFaceLoops(W, F, region), P = W.P, out = { face: F, kind: 'other', loops: L.loops };
  if (L.tangled || !L.loops.length || L.loops.length > 2) return out;
  var fr = NSO_teFrame(F.n), o = F.origin;
  var fits = L.loops.map(function (lp) {
    var p2 = lp.v.map(function (v) {
      var x = P[v * 3] - o[0], y = P[v * 3 + 1] - o[1], z = P[v * 3 + 2] - o[2];
      return [x * fr.e1[0] + y * fr.e1[1] + z * fr.e1[2], x * fr.e2[0] + y * fr.e2[1] + z * fr.e2[2]];
    });
    var sq = NSO_sqLoopSquare(p2);
    sq.ids = lp.v;
    return sq;
  });
  function to3(c2) { return [o[0] + c2[0] * fr.e1[0] + c2[1] * fr.e2[0], o[1] + c2[0] * fr.e1[1] + c2[1] * fr.e2[1], o[2] + c2[0] * fr.e1[2] + c2[1] * fr.e2[2]]; }
  var oi = fits.length === 2 && Math.abs(fits[1].area) > Math.abs(fits[0].area) ? 1 : 0, fo = fits[oi];
  if (fo.center) out.center = to3(fo.center);
  if (fo.nCorners === 0 || fo.nCorners >= 12) { out.kind = 'round'; return out; }
  if (!fo.ok) { out.kind = fo.why === 'a rectangle' ? 'rect' : 'other'; out.why = fo.why; out.rect = fo.rect; return out; }
  if (fits.length === 1) { out.kind = 'closed'; out.a = fo.half; return out; }
  var fi = fits[1 - oi];
  if (!fi.ok) { out.kind = fi.why === 'a rectangle' ? 'rect' : 'other'; out.why = 'its bore is ' + fi.why; return out; }
  var tol = NSO_sqTol(fo.half), ecc = Math.hypot(fo.center[0] - fi.center[0], fo.center[1] - fi.center[1]);
  var cr = Math.abs(fo.dir[0] * fi.dir[1] - fo.dir[1] * fi.dir[0]), dt = Math.abs(fo.dir[0] * fi.dir[0] + fo.dir[1] * fi.dir[1]);
  if (!(fi.half < fo.half) || ecc > tol || Math.min(cr, dt) > NSO_SQ_RIGHT_COS) { out.kind = 'other'; out.why = 'its bore is off-centre or turned'; return out; }
  var e1 = to3([fo.dir[0], fo.dir[1]]), oo = to3([0, 0]);
  e1 = NSO_sqUnit([e1[0] - oo[0], e1[1] - oo[1], e1[2] - oo[2]]);
  out.kind = 'open';
  out.axis = F.n;
  out.e1 = e1; out.e2 = NSO_sqCross(F.n, e1);
  out.a = fo.half; out.b = fi.half; out.wallMm = fo.half - fi.half;
  out.outer = fo.ids; out.inner = fi.ids;
  return out;
}

/* Every flat face of the piece read as a square end, the soup welded once:
   { ok, reason, weld, faces, open: [ends], closed, rect, round }. */
function NSO_squareTubeEnds(soup) {
  var res = { ok: false, reason: '', soup: soup };
  if (typeof NSO_teWeld !== 'function' || typeof NSO_teFaces !== 'function') {
    res.reason = 'nso_tube_edge.js must be loaded - square tubes read their ends with its face finder and carry no copy of it';
    return res;
  }
  if (!soup || soup.length < 9 || soup.length % 9) { res.reason = 'not a triangle soup'; return res; }
  var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  if (!(NSO_teVolume(f32, [0, 0, 0]) > 0)) { res.reason = 'the piece is wound inside out (its volume reads negative) - Repair it first'; return res; }
  var W = NSO_teWeld(f32), FF = NSO_teFaces(W);
  res.f32 = f32; res.weld = W; res.faces = FF; res.open = []; res.closed = 0; res.rect = 0; res.round = 0;
  FF.faces.forEach(function (F) {
    if (F.tris.length < 2) return;
    var c = NSO_sqClassFace(W, F, FF.region);
    if (c.kind === 'open') res.open.push(c);
    else if (c.kind === 'closed') res.closed++;
    else if (c.kind === 'rect') res.rect++;
    else if (c.kind === 'round') res.round++;
  });
  res.ok = true;
  return res;
}
function NSO_sqNoEndWords(E, verb) {
  var s = 'it works on a square tube, read off an open, square end (a square wall round a square bore) - this piece has none';
  if (E.round) s += ' (it has a round end: a round tube is Tubes with Square tubes off)';
  else if (E.closed) s += ' (its square end is closed: a solid square bar)';
  else if (E.rect) s += ' (its end is a rectangle, not a square)';
  return s;
}
function NSO_sqEnds(soup, opts) {
  return opts && opts.ends && opts.ends.soup === soup ? opts.ends : NSO_squareTubeEnds(soup);
}

/* The end nearest opts.point (raw), or the one standing highest.
   Returns { ok, reason, end, ends }. */
function NSO_squareTubeRead(soup, opts) {
  opts = opts || {};
  var E = NSO_sqEnds(soup, opts), res = { ok: false, reason: '', ends: E };
  if (!E.ok) { res.reason = E.reason; return res; }
  if (!E.open.length) { res.reason = NSO_sqNoEndWords(E, opts.verb || 'Square tubes'); return res; }
  var best = null, p = opts.point;
  E.open.forEach(function (c) {
    var score;
    if (p) {
      var q = NSO_sqLocal(c, p), dr = Math.max(0, q.r - c.a, c.b - q.r);
      score = Math.hypot(Math.max(0, q.h), dr) + Math.max(0, -q.h);
    } else score = -c.center[2];
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && c.a > best.c.a)) best = { c: c, score: score };
  });
  res.ok = true; res.end = best.c;
  res.reason = 'square end ' + NSO_sqFmt(2 * best.c.a) + ' / bore ' + NSO_sqFmt(2 * best.c.b) + ' (wall ' + NSO_sqFmt(best.c.wallMm) + ')';
  return res;
}

/* =====================================================================
   2. Building: rings, lofts and side-by-side zips
   ===================================================================== */

/* A ring's vertex ids sorted round the axis (a square is star-shaped about
   its centre, so its loop order is its angle order), with each one's
   coordinates in the end's frame. */
function NSO_sqRing(W, E, ids) {
  var P = W.P;
  var ring = ids.map(function (v) {
    var p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], q = NSO_sqLocal(E, p);
    return { v: v, p: p, x: q.x, y: q.y, h: q.h, ang: Math.atan2(q.y, q.x) };
  });
  ring.sort(function (A, B) { return A.ang - B.ang; });
  return ring;
}
/* The ring carried along its radial lines: half-side r, height h. */
function NSO_sqCarry(E, ring, r0, r, h) {
  var k = r / r0;
  return ring.map(function (q) { return { p: NSO_sqAt(E, q.x * k, q.y * k, h), x: q.x * k, y: q.y * k }; });
}
/* The outward normal of the square's side a 2D point (or an edge's middle) is on. */
function NSO_sqSideN(E, x, y) {
  if (Math.abs(x) >= Math.abs(y)) return x >= 0 ? E.e1 : [-E.e1[0], -E.e1[1], -E.e1[2]];
  return y >= 0 ? E.e2 : [-E.e2[0], -E.e2[1], -E.e2[2]];
}
/* One triangle into out, turned so its normal leans along want. */
function NSO_sqTri(out, A, B, C, want) {
  var u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  var n = NSO_sqCross(u, v);
  if (NSO_sqDot(n, want) < 0) { var t = B; B = C; C = t; }
  out.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
}
/* The bands between successive rings of one face (each ring the same
   vertices carried, in angle order): sgn +1 the outside, -1 the bore. */
function NSO_sqLoft(out, E, rings, sgn) {
  for (var i = 0; i + 1 < rings.length; i++) {
    var A = rings[i], B = rings[i + 1], n = A.length;
    for (var j = 0; j < n; j++) {
      var j1 = (j + 1) % n, N = NSO_sqSideN(E, (A[j].x + A[j1].x) / 2, (A[j].y + A[j1].y) / 2);
      var want = [sgn * N[0], sgn * N[1], sgn * N[2]];
      NSO_sqTri(out, A[j].p, A[j1].p, B[j1].p, want);
      NSO_sqTri(out, A[j].p, B[j1].p, B[j].p, want);
    }
  }
}
/* A ring's points side by side: { 'x+': [{ p, t }], ... } each sorted along
   its side (t from -1 to 1). A point within tolerance of a corner is the
   corner - in both its sides - only if it is its quadrant's nearest to the
   ideal corner; any other goes to the one side it is nearer. */
function NSO_sqSides(R, r) {
  var tol = NSO_sqTol(r), S = { 'x+': [], 'x-': [], 'y+': [], 'y-': [] }, corner = {};
  R.forEach(function (q, i) {
    var dx = Math.abs(Math.abs(q.x) - r), dy = Math.abs(Math.abs(q.y) - r);
    if (dx <= tol && dy <= tol) {
      var k = (q.x > 0 ? 1 : 0) + (q.y > 0 ? 2 : 0);
      if (corner[k] == null || dx + dy < corner[k].d) corner[k] = { i: i, d: dx + dy };
    }
  });
  var isC = {};
  Object.keys(corner).forEach(function (k) { isC[corner[k].i] = true; });
  R.forEach(function (q, i) {
    var dx = Math.abs(Math.abs(q.x) - r), dy = Math.abs(Math.abs(q.y) - r);
    var onX = dx <= tol && (isC[i] || dy > tol || dx < dy), onY = dy <= tol && (isC[i] || dx > tol || dy <= dx);
    if (onX) S[q.x > 0 ? 'x+' : 'x-'].push({ p: q.p, t: q.y / r });
    if (onY) S[q.y > 0 ? 'y+' : 'y-'].push({ p: q.p, t: q.x / r });
  });
  Object.keys(S).forEach(function (k) { S[k].sort(function (A, B) { return A.t - B.t; }); });
  return S;
}
/* Two loops of squares on one axis (any counts, corners in both), zipped
   side by side: a ladder per side between its two corners, each triangle
   turned along want(sideNormal). Each ring is [{ p, x, y }]; r0 / r1 the two
   half-sides. */
function NSO_sqZip(out, E, P0, r0, P1, r1, want) {
  var SIDES = [[0, 1], [0, -1], [1, 1], [1, -1]];   // [the fixed coordinate (0: x, 1: y), its sign]
  var S0 = NSO_sqSides(P0, r0), S1 = NSO_sqSides(P1, r1);
  SIDES.forEach(function (sd) {
    var key = (sd[0] === 0 ? 'x' : 'y') + (sd[1] > 0 ? '+' : '-'), A = S0[key], B = S1[key];
    var N = sd[0] === 0 ? E.e1 : E.e2, w = want([sd[1] * N[0], sd[1] * N[1], sd[1] * N[2]]);
    var i = 0, j = 0;
    while (i + 1 < A.length || j + 1 < B.length) {
      var goA = j + 1 >= B.length || (i + 1 < A.length && A[i + 1].t <= B[j + 1].t);
      if (goA) { NSO_sqTri(out, A[i].p, A[i + 1].p, B[j].p, w); i++; }
      else { NSO_sqTri(out, A[i].p, B[j + 1].p, B[j].p, w); j++; }
    }
  });
}

/* The soup with some triangles left out, every other one copied bit for bit,
   and the new ones added after. */
function NSO_sqAssemble(f32, drop, extra) {
  var n = f32.length / 9, keep = 0;
  for (var t = 0; t < n; t++) if (!drop[t]) keep++;
  var out = new Float32Array(keep * 9 + extra.length), o = 0;
  for (var q = 0; q < n; q++) {
    if (drop[q]) continue;
    for (var k = 0; k < 9; k++) out[o++] = f32[q * 9 + k];
  }
  for (var e = 0; e < extra.length; e++) out[o++] = extra[e];
  return out;
}

/* The volume between a square face's profile [[h, r], ...] and its straight
   line r0: Σ ∫ 4(r² - r0²) dh, each band a prismatoid (exact: a band of a
   square between two parallel squares is planar side by side). */
function NSO_sqProfileVolume(prof, r0) {
  var v = 0;
  for (var i = 0; i + 1 < prof.length; i++) {
    var dh = prof[i + 1][0] - prof[i][0], r1 = prof[i][1], r2 = prof[i + 1][1];
    v += 4 * dh * (r1 * r1 + r1 * r2 + r2 * r2) / 3 - 4 * dh * r0 * r0;
  }
  return v;
}
/* The least distance between two polylines in the meridian ([[h, r], ...]). */
function NSO_sqPolyDist(A, B) {
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  var best = Infinity;
  [[A, B], [B, A]].forEach(function (q) {
    q[0].forEach(function (p) { for (var i = 0; i + 1 < q[1].length; i++) best = Math.min(best, segDist(p, q[1][i], q[1][i + 1])); });
  });
  return best;
}
function NSO_sqMaxSlopeDeg(prof) {
  var s = 0;
  for (var i = 0; i + 1 < prof.length; i++) {
    var dh = prof[i + 1][0] - prof[i][0], dr = prof[i + 1][1] - prof[i][1];
    if (Math.abs(dr) > 1e-12) s = Math.max(s, Math.atan2(Math.abs(dr), Math.abs(dh)) * 180 / Math.PI);
  }
  return s;
}
function NSO_sqGates(res, f32, out, ref, want) {
  if (typeof NSO_bendTopology === 'function') {
    var T0 = NSO_bendTopology(f32), T1 = NSO_bendTopology(out);
    res.topology = { before: T0, after: T1 };
    if (T1.open > T0.open || T1.nm > T0.nm || T1.flip > T0.flip || T1.euler !== T0.euler) {
      res.reason = 'internal: the new wall did not close up with the old (open ' + T0.open + ' → ' + T1.open + ', non-manifold ' + T0.nm + ' → ' + T1.nm +
        ', mis-wound ' + T0.flip + ' → ' + T1.flip + ', Euler ' + T0.euler + ' → ' + T1.euler + ')';
      return false;
    }
  }
  var v0 = NSO_teVolume(f32, ref), v1 = NSO_teVolume(out, ref), dv = v1 - v0;
  res.volume = { before: v0, after: v1, change: dv, expected: want };
  if (Math.abs(dv - want) > NSO_SQ_VOLUME_TOL * Math.max(1, Math.abs(want), 0.01 * Math.abs(v0))) {
    res.reason = 'internal: the volume changed by ' + NSO_sqFmt(dv, 3) + ' mm³ where the frusta say ' + NSO_sqFmt(want, 3);
    return false;
  }
  return true;
}

/* =====================================================================
   3. Reducer
   ===================================================================== */

/* A face's half-side from r1 to r2 over T (Straight or Trumpet), then a run:
   [[u, r], ...] from u = 0. steps: how many for the transition. */
function NSO_sqReducerProfile(r1, r2, T, run, prof, steps) {
  var P = [[0, r1]];
  if (T > 0) {
    for (var i = 1; i <= steps; i++) {
      var s = i / steps, f = prof === 'trumpet' ? s * s : s;
      P.push([T * s, r1 + (r2 - r1) * f]);
    }
  }
  if (run > 0) P.push([T + run, r2]);
  return P;
}

/* opts: point (raw: the end nearest it; else the top end), side2 / bore2
   (the new pipe's outside and bore, mm across), transitionMm, runMm,
   profile 'straight' | 'trumpet', nozzle, ends. Returns { ok, reason, tris,
   end, reducer: { a1, b1, a2, b2, T, run, profile, angleOuterDeg,
   angleBoreDeg, wallMm, wallEndMm, kind }, counts, volume, topology }. */
function NSO_squareTubeReducer(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: 'reducer' };
  var rd = NSO_squareTubeRead(soup, { point: opts.point, ends: opts.ends, verb: 'Square reducer' });
  res.read = rd;
  if (!rd.ok) { res.reason = rd.reason; return res; }
  var E = rd.end, f32 = rd.ends.f32, W = rd.ends.weld, nozzle = NSO_sqNozzle(opts), floor = NSO_sqFloor(nozzle);
  res.end = E; res.nozzleMm = nozzle;
  var S2 = +opts.side2, B2 = +opts.bore2, T = opts.transitionMm == null || opts.transitionMm === '' ? NaN : +opts.transitionMm;
  var run = opts.runMm == null || opts.runMm === '' ? 0 : +opts.runMm, prof = opts.profile === 'trumpet' ? 'trumpet' : 'straight';
  if (!(S2 > 0) || !isFinite(S2)) { res.reason = 'enter the new pipe\'s side in mm, more than 0'; return res; }
  if (!(B2 > 0) || !isFinite(B2)) { res.reason = 'enter the new pipe\'s bore side in mm, more than 0'; return res; }
  if (!(T >= 0) || !isFinite(T)) { res.reason = 'enter the transition\'s length in mm, 0 or more'; return res; }
  if (!(run >= 0) || !isFinite(run)) { res.reason = 'enter the run in mm, 0 or more'; return res; }
  var a = E.a, b = E.b, a2 = S2 / 2, b2 = B2 / 2;
  if (Math.abs(a2 - a) < 1e-4) a2 = a;
  if (Math.abs(b2 - b) < 1e-4) b2 = b;
  var change = a2 !== a || b2 !== b;
  if (change && !(T > 0)) {
    res.reason = 'a transition of 0 mm would step the wall square across - give the change from ' + NSO_sqFmt(2 * a) + ' to ' + NSO_sqFmt(S2) + ' a length to happen over';
    return res;
  }
  if (!change && !(T + run > 0)) { res.reason = 'nothing to do - the new pipe is the tube\'s own size, with no transition and no run'; return res; }
  if (B2 < NSO_SQ_NOZZLES * nozzle - 1e-9) {
    res.reason = 'a bore of ' + NSO_sqFmt(B2) + ' across is under ' + NSO_sqFmt(NSO_SQ_NOZZLES * nozzle) + ' mm (' + NSO_SQ_NOZZLES + ' nozzle widths at a ' + NSO_sqFmt(nozzle, 1) + ' mm nozzle)';
    return res;
  }
  if (!(a2 - b2 >= floor - 1e-9)) {
    res.reason = 'a ' + NSO_sqFmt(S2) + ' pipe with a ' + NSO_sqFmt(B2) + ' bore has a ' + NSO_sqFmt(Math.max(0, a2 - b2)) + ' mm wall - under the ' + NSO_sqFmt(floor) +
      ' mm floor (nso_thickness.js, a ' + NSO_sqFmt(nozzle, 1) + ' mm nozzle): its bore is ' + NSO_sqFmt(S2 - 2 * floor) + ' at most';
    return res;
  }
  // the trumpet sampled so no chord sags NSO_SQ_SAG_MM: sag ≈ k h² / 8, k = 2|Δ| / T²
  var dmax = Math.max(Math.abs(a2 - a), Math.abs(b2 - b)), steps = 1;
  if (prof === 'trumpet' && T > 0 && dmax > 0) steps = Math.max(4, Math.min(NSO_SQ_MAX_STEPS, Math.ceil(Math.sqrt(dmax / (4 * NSO_SQ_SAG_MM)))));
  var PO = NSO_sqReducerProfile(a, a2, T, run, prof, steps), PI = NSO_sqReducerProfile(b, b2, T, run, prof, steps);
  var mO = PO.map(function (q) { return [q[0], q[1]]; }), mI = PI.map(function (q) { return [q[0], q[1]]; });
  var slope = Math.max(NSO_sqMaxSlopeDeg(mO), NSO_sqMaxSlopeDeg(mI));
  if (slope > NSO_SQ_MAX_SLOPE_DEG + 1e-9) {
    res.reason = 'that transition stands ' + NSO_sqFmt(slope, 1) + '° off the axis - ' + NSO_SQ_MAX_SLOPE_DEG + '° at most: give it ' +
      NSO_sqFmt(Math.ceil(10 * (prof === 'trumpet' ? 2 : 1) * dmax / Math.tan(NSO_SQ_MAX_SLOPE_DEG * Math.PI / 180)) / 10, 1) + ' mm or more';
    return res;
  }
  // the old wall below the ring, so the transition's first face is measured against it too
  var depth = Math.max(5, T + run, 4 * E.wallMm);
  var wall = NSO_sqPolyDist([[-depth, a]].concat(mO), [[-depth, b]].concat(mI));
  if (wall < floor - 1e-6) {
    res.reason = 'the wall would come to ' + NSO_sqFmt(wall) + ' mm square to its faces through the transition - under the ' + NSO_sqFmt(floor) +
      ' mm floor (nso_thickness.js, a ' + NSO_sqFmt(nozzle, 1) + ' mm nozzle): give it a longer transition, or a thicker wall';
    return res;
  }
  // build: the end face out, each loop carried through the stations, the lip zipped round
  var drop = new Uint8Array(f32.length / 9);
  E.face.tris.forEach(function (t) { drop[t] = 1; });
  var out = [];
  var ringO = NSO_sqRing(W, E, E.outer), ringI = NSO_sqRing(W, E, E.inner);
  function rings(ring, r0, P) {
    var R = [ring.map(function (q) { return { p: q.p, x: q.x, y: q.y }; })];
    for (var i = 1; i < P.length; i++) R.push(NSO_sqCarry(E, ring, r0, P[i][1], P[i][0]));
    return R;
  }
  var RO = rings(ringO, a, PO), RI = rings(ringI, b, PI);
  NSO_sqLoft(out, E, RO, 1);
  NSO_sqLoft(out, E, RI, -1);
  var top = PO[PO.length - 1][0];
  NSO_sqZip(out, E, RO[RO.length - 1], a2, RI[RI.length - 1], b2, function () { return E.axis; });
  var tris = NSO_sqAssemble(f32, drop, out);
  var want = NSO_sqProfileVolume(PO, 0) - NSO_sqProfileVolume(PI, 0);
  res.counts = { trisIn: f32.length / 9, trisOut: tris.length / 9 };
  var angO = T > 0 ? Math.atan2(Math.abs(a2 - a) * (prof === 'trumpet' ? 2 : 1), T) * 180 / Math.PI : 0;
  var angI = T > 0 ? Math.atan2(Math.abs(b2 - b) * (prof === 'trumpet' ? 2 : 1), T) * 180 / Math.PI : 0;
  res.reducer = { a1: a, b1: b, a2: a2, b2: b2, T: T, run: run, profile: prof, angleOuterDeg: angO, angleBoreDeg: angI,
                  wallMm: wall, wallEndMm: a2 - b2, lengthMm: top, steps: steps,
                  kind: a2 > a ? 'expander' : a2 < a ? 'reducer' : b2 !== b ? 'bore' : 'straight' };
  if (!NSO_sqGates(res, f32, tris, E.center, want)) return res;
  res.ok = true; res.tris = tris;
  res.reason = NSO_squareTubeDescribe(res);
  return res;
}

/* =====================================================================
   4. Neck
   ===================================================================== */

/* Which triangles are a piece of one face of the square tube: normal square
   to the axis and facing the right way, every vertex on one side of the
   square of half-side r. sgn +1 the outside, -1 the bore. */
function NSO_sqOnFace(W, E, t, r, sgn) {
  var N = W.N, nn = [N[t * 3], N[t * 3 + 1], N[t * 3 + 2]];
  if (W.degen[t] || Math.abs(NSO_sqDot(nn, E.axis)) > 1e-3) return false;
  var tol = Math.max(NSO_SQ_LEVEL_MM * 10, 2e-4 * r), side = null;
  for (var k = 0; k < 3; k++) {
    var v = W.vid[t * 3 + k], q = NSO_sqLocal(E, [W.P[v * 3], W.P[v * 3 + 1], W.P[v * 3 + 2]]);
    var s = Math.abs(Math.abs(q.x) - r) <= tol && Math.abs(q.y) <= r + tol ? (q.x > 0 ? 'x+' : 'x-') : null;
    var s2 = Math.abs(Math.abs(q.y) - r) <= tol && Math.abs(q.x) <= r + tol ? (q.y > 0 ? 'y+' : 'y-') : null;
    if (!s && !s2) return false;
    if (side == null) side = [s, s2];
    else side = [side[0] === s ? s : null, side[1] === s2 ? s2 : null];
    if (!side[0] && !side[1]) return false;
  }
  var key = side[0] || side[1], SN = key[0] === 'x' ? E.e1 : E.e2, sg = key[1] === '+' ? 1 : -1;
  return NSO_sqDot(nn, SN) * sg * sgn > 0.999;
}
/* The tube behind an end: every triangle of its outside and bore faces, and
   how far back the straight square wall runs (hMin, <= 0). */
function NSO_sqTubeOf(W, E) {
  var n = W.n, onO = new Uint8Array(n), onI = new Uint8Array(n), hMin = 0;
  for (var t = 0; t < n; t++) {
    var o = NSO_sqOnFace(W, E, t, E.a, 1), i = !o && NSO_sqOnFace(W, E, t, E.b, -1);
    if (!o && !i) continue;
    var lo = Infinity, hi = -Infinity;
    for (var k = 0; k < 3; k++) {
      var v = W.vid[t * 3 + k], h = NSO_sqLocal(E, [W.P[v * 3], W.P[v * 3 + 1], W.P[v * 3 + 2]]).h;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi > NSO_SQ_LEVEL_MM) continue;      // past the end it was read off: another piece
    if (o) onO[t] = 1; else onI[t] = 1;
    if (o) hMin = Math.min(hMin, lo);
  }
  return { onO: onO, onI: onI, hMin: hMin, lengthMm: -hMin };
}
function NSO_sqHRange(W, E, t) {
  var lo = Infinity, hi = -Infinity;
  for (var k = 0; k < 3; k++) {
    var v = W.vid[t * 3 + k], h = NSO_sqLocal(E, [W.P[v * 3], W.P[v * 3 + 1], W.P[v * 3 + 2]]).h;
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return [lo, hi];
}

/* The band [ha, hb] on one face (on: its triangles), grown until it runs
   between two whole rings: { ok, why, drop (triangles), lo, hi (heights),
   ringLo, ringHi (vertex ids) }. Every triangle near the tube the band
   crosses must be the face's or the other face's - anything else (a neck,
   a branch already there) is not straight square tube. */
function NSO_sqBandOf(W, E, tube, on, other, ha, hb) {
  var n = W.n, lvl = NSO_SQ_LEVEL_MM, HR = new Float64Array(n * 2), near = E.a + Math.max(1, E.wallMm);
  for (var t = 0; t < n; t++) { var r = NSO_sqHRange(W, E, t); HR[t * 2] = r[0]; HR[t * 2 + 1] = r[1]; }
  // what crosses the band near the tube must be wall
  for (var q = 0; q < n; q++) {
    if (on[q] || other[q] || W.degen[q]) continue;
    if (!(HR[q * 2] < hb - lvl && HR[q * 2 + 1] > ha + lvl)) continue;
    var v = W.vid[q * 3], L = NSO_sqLocal(E, [W.P[v * 3], W.P[v * 3 + 1], W.P[v * 3 + 2]]);
    if (L.r <= near) return { ok: false, why: 'crossed', h: [HR[q * 2], HR[q * 2 + 1]] };
  }
  var lo = ha, hi = hb, drop = new Uint8Array(n), grew = true;
  while (grew) {
    grew = false;
    for (var s = 0; s < n; s++) {
      if (!on[s] || drop[s]) continue;
      if (HR[s * 2] < hi - lvl && HR[s * 2 + 1] > lo + lvl) {
        drop[s] = 1; grew = true;
        if (HR[s * 2] < lo) lo = HR[s * 2];
        if (HR[s * 2 + 1] > hi) hi = HR[s * 2 + 1];
      }
    }
  }
  // the dropped triangles' open edges: every one on the lower ring or the upper
  var cnt = new Map(), ringLo = new Set(), ringHi = new Set(), bad = 0, nb = 0;
  for (var d = 0; d < n; d++) {
    if (!drop[d]) continue;
    for (var k = 0; k < 3; k++) {
      var id = W.cornerEdge[d * 3 + k];
      cnt.set(id, (cnt.get(id) || 0) + 1);
    }
  }
  cnt.forEach(function (c, id) {
    if (c !== 1) return;
    nb++;
    var r0 = W.eA[id] >= 0 ? W.eA[id] : W.eB[id], t = (r0 / 3) | 0, k = r0 % 3;
    var va = W.vid[t * 3 + k], vb = W.vid[t * 3 + (k + 1) % 3];
    var ea = NSO_sqLocal(E, [W.P[va * 3], W.P[va * 3 + 1], W.P[va * 3 + 2]]).h, eb = NSO_sqLocal(E, [W.P[vb * 3], W.P[vb * 3 + 1], W.P[vb * 3 + 2]]).h;
    if (Math.abs(ea - lo) <= lvl && Math.abs(eb - lo) <= lvl) { ringLo.add(va); ringLo.add(vb); }
    else if (Math.abs(ea - hi) <= lvl && Math.abs(eb - hi) <= lvl) { ringHi.add(va); ringHi.add(vb); }
    else bad++;
  });
  if (bad || !ringLo.size || !ringHi.size || nb !== ringLo.size + ringHi.size) return { ok: false, why: 'rings', lo: lo, hi: hi };
  return { ok: true, drop: drop, lo: lo, hi: hi, ringLo: Array.from(ringLo), ringHi: Array.from(ringHi) };
}

/* The mid-wall's curve and the faces' profiles over [ha, hb], as [[h, r], ...]
   - Smooth: r = r0 + Δ (1 - cos 2πs/L) / 2; Funnel: straight in, straight out.
   off: the face's offset from the curve along its normal (+t/2 the outside,
   -t/2 the bore, 0 the curve itself). */
function NSO_sqNeckProfile(r0, dr, ha, hb, prof, off, steps) {
  var L = hb - ha, P = [];
  if (prof === 'funnel') return [[ha, r0], [(ha + hb) / 2, r0 + dr], [hb, r0]];
  for (var k = 0; k <= steps; k++) {
    var s = L * k / steps, w = 2 * Math.PI * s / L, r = r0 + dr * (1 - Math.cos(w)) / 2;
    var rp = dr * Math.PI / L * Math.sin(w), nl = Math.hypot(1, rp);
    // the normal toward +r of the curve (h, r(h)): (-r', 1) / |.|
    P.push([ha + s - off * rp / nl, r + off / nl]);
  }
  if (off) { P[0] = [ha, r0 + off]; P[P.length - 1] = [hb, r0 + off]; }
  return P;
}

/* Funnel with Walls Both: the outside's polyline (a, then a + Δ at the waist,
   then a) and the bore's lines a wall t in from it, square to each run. At
   each corner the face on the inside of the bend is sharp - its two lines'
   meeting point K - and the other goes round K on an arc of radius t, as
   bent sheet does (Tube edge's Funnel): the wall is t square to its faces
   everywhere, the waist's outside a + Δ and its bore b + Δ exactly.
   Returns { PO, PI } over the band, as [[h, r], ...]. */
function NSO_sqFunnelFaces(a, t, dr, ha, hb) {
  var O = [[ha - 1, a], [ha, a], [(ha + hb) / 2, a + dr], [hb, a], [hb + 1, a]], seg = [];
  for (var i = 0; i + 1 < O.length; i++) {
    var dh = O[i + 1][0] - O[i][0], dd = O[i + 1][1] - O[i][1], len = Math.hypot(dh, dd);
    seg.push({ d: [dh / len, dd / len], n: [-dd / len, dh / len] });   // n: the normal toward +r
  }
  function meet(p, d, q, e) {
    var den = d[0] * e[1] - d[1] * e[0], tt = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
    return [p[0] + tt * d[0], p[1] + tt * d[1]];
  }
  function arc(K, n1, n2, s) {
    var a1 = Math.atan2(s * n1[1], s * n1[0]), a2 = Math.atan2(s * n2[1], s * n2[0]), da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    var m = Math.max(2, Math.ceil(Math.abs(da) / (2 * Math.acos(Math.max(-1, 1 - NSO_SQ_SAG_MM / t))))), P = [];
    for (var k = 0; k <= m; k++) { var an = a1 + da * k / m; P.push([K[0] + t * Math.cos(an), K[1] + t * Math.sin(an)]); }
    return P;
  }
  var PO = [], PI = [];
  for (var j = 1; j <= 3; j++) {
    var A = seg[j - 1], B = seg[j], cr = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (cr > 0) {
      // bending toward +r: the outside is on the inside of the bend, sharp at its own corner
      PO.push(O[j]);
      PI = PI.concat(arc(O[j], A.n, B.n, -1));
    } else {
      // the bore is on the inside: its two lines (the outside's, t in) meet at K
      var K = meet([O[j - 1][0] - t * A.n[0], O[j - 1][1] - t * A.n[1]], A.d, [O[j][0] - t * B.n[0], O[j][1] - t * B.n[1]], B.d);
      PI.push(K);
      PO = PO.concat(arc(K, A.n, B.n, 1));
    }
  }
  return { PO: PO, PI: PI };
}

/* opts: point (raw: where the band is centred - its projection on the axis;
   blank: the tube's middle), length, dr (half-side, mm: below 0 pinches),
   profile 'smooth' | 'funnel', walls 'both' | 'outside' | 'bore', nozzle,
   ends. Returns { ok, reason, tris, end, neck: { ... }, band, counts,
   volume, topology }. */
function NSO_squareTubeNeck(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: 'neck' };
  var E0 = NSO_sqEnds(soup, opts);
  if (!E0.ok) { res.reason = E0.reason; return res; }
  if (!E0.open.length) { res.reason = NSO_sqNoEndWords(E0, 'Square neck'); return res; }
  // the end the press is behind, on the tube's wall; else the highest end
  var E = null, best = Infinity, p = opts.point;
  E0.open.forEach(function (c) {
    var sc;
    if (p) {
      var q = NSO_sqLocal(c, p);
      sc = q.h > NSO_SQ_SAME_MM ? Infinity : Math.min(Math.abs(q.r - c.a), Math.abs(q.r - c.b));
    } else sc = -c.center[2];
    if (sc < best - 1e-9 || (Math.abs(sc - best) <= 1e-9 && E && c.center[2] > E.center[2])) { best = sc; E = c; }
  });
  if (!E) { res.reason = 'that is not on the wall of a square tube with an open end - click the tube where the neck goes'; return res; }
  var f32 = E0.f32, W = E0.weld, nozzle = NSO_sqNozzle(opts), floor = NSO_sqFloor(nozzle);
  res.end = E; res.nozzleMm = nozzle;
  var tube = NSO_sqTubeOf(W, E);
  res.tube = { lengthMm: tube.lengthMm, hMin: tube.hMin, a: E.a, b: E.b };
  var L = +opts.length, dr = +opts.dr, prof = opts.profile === 'funnel' ? 'funnel' : 'smooth';
  var walls = opts.walls === 'outside' || opts.walls === 'bore' ? opts.walls : 'both';
  if (!(L > 0) || !isFinite(L)) { res.reason = 'enter the neck\'s length in mm, more than 0'; return res; }
  if (!isFinite(dr) || opts.dr == null || opts.dr === '') { res.reason = 'enter Δ in mm: below 0 pinches the tube in, above 0 bulges it out'; return res; }
  if (dr === 0) { res.reason = 'Δ is 0 - nothing to neck'; return res; }
  var h0 = p ? NSO_sqLocal(E, p).h : tube.hMin / 2, ha = h0 - L / 2, hb = h0 + L / 2;
  if (ha < tube.hMin - 1e-6 || hb > 1e-6) {
    res.reason = 'a ' + NSO_sqFmt(L, 1) + ' mm neck centred ' + NSO_sqFmt(-h0) + ' mm in would run past the end of the tube (it is ' + NSO_sqFmt(tube.lengthMm) +
      ' mm long) - centre it at least ' + NSO_sqFmt(L / 2) + ' mm in from either end, or shorten it';
    return res;
  }
  var a = E.a, b = E.b, t = a - b, rm = (a + b) / 2;
  // the faces' profiles over the band
  var PO = null, PI = null;
  var kap = 2 * Math.PI * Math.PI * Math.abs(dr) / (L * L);   // Smooth: the curve's tightest turn
  // sampled so no chord of either face sags NSO_SQ_SAG_MM (the face on the inside of a turn turns tighter by
  // 1 / (1 - κ t/2)), at an even count so the waist is a station
  var kf = kap / Math.max(0.1, 1 - kap * (a - b) / 2);
  var steps = Math.max(8, Math.min(NSO_SQ_MAX_STEPS, Math.ceil(L / Math.sqrt(8 * NSO_SQ_SAG_MM / Math.max(kf, 1e-9)))));
  steps += steps % 2;
  if (prof === 'funnel') {
    var fs = Math.atan2(Math.abs(dr), L / 2) * 180 / Math.PI;
    if (fs > NSO_SQ_MAX_SLOPE_DEG + 1e-9) {
      res.reason = 'that funnel tapers at ' + NSO_sqFmt(fs, 1) + '° - ' + NSO_SQ_MAX_SLOPE_DEG + '° at most: make it ' +
        NSO_sqFmt(Math.ceil(20 * Math.abs(dr) / Math.tan(NSO_SQ_MAX_SLOPE_DEG * Math.PI / 180)) / 10, 1) + ' mm or longer';
      return res;
    }
  }
  if (walls === 'both') {
    if (prof === 'smooth' && kap * t / 2 >= 0.9) {
      res.reason = 'a ' + NSO_sqFmt(L, 1) + ' mm neck is too short to move a ' + NSO_sqFmt(t) + ' mm wall by ' + NSO_sqFmt(dr) +
        ' mm - its bore would fold on itself; it needs ' + NSO_sqFmt(Math.ceil(10 * Math.PI * Math.sqrt(Math.abs(dr) * t / 1.8)) / 10, 1) + ' mm or more';
      return res;
    }
    if (prof === 'funnel') { var FF = NSO_sqFunnelFaces(a, t, dr, ha, hb); PO = FF.PO; PI = FF.PI; }
    else {
      PO = NSO_sqNeckProfile(rm, dr, ha, hb, prof, t / 2, steps);
      PI = NSO_sqNeckProfile(rm, dr, ha, hb, prof, -t / 2, steps);
    }
  } else if (walls === 'outside') PO = NSO_sqNeckProfile(a, dr, ha, hb, prof, 0, steps);
  else PI = NSO_sqNeckProfile(b, dr, ha, hb, prof, 0, steps);
  if (prof === 'smooth' && walls !== 'both') {
    var ss = Math.atan(Math.abs(dr) * Math.PI / L) * 180 / Math.PI;
    if (ss > NSO_SQ_MAX_SLOPE_DEG + 1e-9) { res.reason = 'that neck stands ' + NSO_sqFmt(ss, 1) + '° off the axis at its steepest - ' + NSO_SQ_MAX_SLOPE_DEG + '° at most: make it longer'; return res; }
  }
  // the bore at the waist: at least 2 nozzle widths across
  var boreMin = Math.min.apply(null, (PI || [[0, b]]).map(function (q) { return q[1]; }));
  if (2 * boreMin < NSO_SQ_NOZZLES * nozzle - 1e-9) {
    res.reason = 'a pinch of ' + NSO_sqFmt(-dr) + ' mm would close the bore - the ' + NSO_sqFmt(2 * b) + ' bore would come to ' + NSO_sqFmt(Math.max(0, 2 * boreMin)) +
      ' at the waist, under the bore limit of ' + NSO_sqFmt(NSO_SQ_NOZZLES * nozzle) + ' (' + NSO_SQ_NOZZLES + ' nozzle widths at a ' + NSO_sqFmt(nozzle, 1) +
      ' mm nozzle). This bore pinches by ' + NSO_sqFmt(Math.max(0, b - NSO_SQ_NOZZLES * nozzle / 2)) + ' mm at most';
    return res;
  }
  // the wall through the band, square to its faces, with the straight wall either side
  var ext = Math.max(2, 2 * t);
  function full(P, r) { return [[ha - ext, r]].concat(P || [[ha, r], [hb, r]]).concat([[hb + ext, r]]); }
  var FO = full(PO, a), FI = full(PI, b), wall = NSO_sqPolyDist(FO, FI);
  for (var c1 = 0; c1 + 1 < FO.length; c1++) if (!(FO[c1 + 1][0] > FO[c1][0] - 1e-12)) wall = -1;
  for (var c2 = 0; c2 + 1 < FI.length; c2++) if (!(FI[c2 + 1][0] > FI[c2][0] - 1e-12)) wall = -1;
  if (walls === 'both' && wall < t - 0.02) wall = Math.min(wall, -1);
  if (wall < floor - 1e-6) {
    var face = walls === 'bore' ? 'bore' : 'outside';
    res.reason = walls === 'both' ? 'a ' + NSO_sqFmt(L, 1) + ' mm neck is too short to carry a ' + NSO_sqFmt(t) + ' mm wall through ' + NSO_sqFmt(dr) + ' mm - make it longer'
      : face + ' ' + (dr > 0 ? '+' : '−') + NSO_sqFmt(Math.abs(dr)) + ' mm would leave a ' + NSO_sqFmt(Math.max(0, wall)) + ' mm wall; the floor is ' + NSO_sqFmt(floor) +
        ' mm (nso_thickness.js: one extrusion line at a ' + nozzle + ' mm nozzle)';
    return res;
  }
  // the band on each face that moves, grown to whole rings
  var drop = new Uint8Array(W.n), out = [], want = 0;
  var faces = [];
  if (PO) faces.push({ P: PO, r: a, on: tube.onO, other: tube.onI, sgn: 1 });
  if (PI) faces.push({ P: PI, r: b, on: tube.onI, other: tube.onO, sgn: -1 });
  for (var fi = 0; fi < faces.length; fi++) {
    var F = faces[fi], P = F.P;
    var B = NSO_sqBandOf(W, E, tube, F.on, F.other, P[0][0], P[P.length - 1][0]);
    if (!B.ok) {
      res.reason = B.why === 'crossed'
        ? 'the wall is not straight square tube from ' + NSO_sqFmt(-B.h[1]) + ' to ' + NSO_sqFmt(-B.h[0]) + ' mm in from the end, where this neck would go (' +
          NSO_sqFmt(-hb) + ' to ' + NSO_sqFmt(-ha) + ' mm) - a neck, a branch or a reducer already there. Necks may not overlap: move it along the tube, or shorten it'
        : 'the tube\'s ' + (F.sgn > 0 ? 'outside' : 'bore') + ' does not run in whole rings round the band - its triangles must meet in square rings for a neck to be laid between them';
      return res;
    }
    for (var d = 0; d < W.n; d++) if (B.drop[d]) drop[d] = 1;
    var rLo = NSO_sqRing(W, E, B.ringLo), rHi = NSO_sqRing(W, E, B.ringHi);
    var R = [rLo.map(function (q) { return { p: q.p, x: q.x, y: q.y }; })], prof2 = [[B.lo, F.r]];
    P.forEach(function (q) {
      if (q[0] <= B.lo + 1e-3 || q[0] >= B.hi - 1e-3) return;
      R.push(NSO_sqCarry(E, rLo, F.r, q[1], q[0]));
      prof2.push([q[0], q[1]]);
    });
    prof2.push([B.hi, F.r]);
    NSO_sqLoft(out, E, R, F.sgn);
    var last = R[R.length - 1], lr = prof2[prof2.length - 2][1];
    var top = rHi.map(function (q) { return { p: q.p, x: q.x, y: q.y }; });
    (function (sg) { NSO_sqZip(out, E, last, lr, top, F.r, function (n) { return [sg * n[0], sg * n[1], sg * n[2]]; }); })(F.sgn);
    want += F.sgn * NSO_sqProfileVolume(prof2, F.r);
  }
  var tris = NSO_sqAssemble(f32, drop, out);
  res.counts = { trisIn: f32.length / 9, trisOut: tris.length / 9 };
  var waistO = PO ? (dr > 0 ? Math.max : Math.min).apply(null, PO.map(function (q) { return q[1]; })) : a;
  res.neck = { L: L, dr: dr, h0: h0, ha: ha, hb: hb, profile: prof, walls: walls, wallMm: wall, a: a, b: b,
               waistSide: 2 * waistO, waistBore: 2 * (PI ? (dr > 0 ? Math.max : Math.min).apply(null, PI.map(function (q) { return q[1]; })) : b), steps: prof === 'smooth' ? steps : 4 };
  res.band = { a: a, b: b };
  var ref = NSO_sqAt(E, 0, 0, h0);
  if (!NSO_sqGates(res, f32, tris, ref, want)) return res;
  res.ok = true; res.tris = tris;
  res.reason = NSO_squareTubeDescribe(res);
  return res;
}

/* =====================================================================
   5. Branch
   ===================================================================== */

/* opts.point (raw): the press. Returns { ok, reason, parent: { center, axis,
   Ro, Ri (half-sides), e1, e2, end }, at: { h, r, ri, e (the pressed face's
   outward normal), l (along the face, square to the axis), lat, S } } -
   Tubes → Branch's read, for a square tube (its drag reads the same names). */
function NSO_squareBranchRead(soup, opts) {
  opts = opts || {};
  var E0 = NSO_sqEnds(soup, opts), res = { ok: false, reason: '', soup: soup, tube: true, square: true };
  if (!E0.ok) { res.reason = E0.reason; return res; }
  res.ends = E0;
  if (!E0.open.length) { res.reason = NSO_sqNoEndWords(E0, 'Square branch'); return res; }
  function parentOf(c) { return { center: c.center, axis: c.axis, Ro: c.a, Ri: c.b, e1: c.e1, e2: c.e2, frame: { e1: c.e1, e2: c.e2 }, end: c, open: true }; }
  var p = opts.point;
  if (!p) {
    var top = null;
    E0.open.forEach(function (c) { if (!top || c.center[2] > top.center[2] + 1e-9 || (Math.abs(c.center[2] - top.center[2]) <= 1e-9 && c.a > top.a)) top = c; });
    res.ok = true; res.parent = parentOf(top);
    res.reason = E0.open.length + ' square end(s) to grow from - press on the side of a square tube where the branch goes';
    return res;
  }
  var cands = E0.open.map(function (c) { var q = NSO_sqLocal(c, p); return { c: c, q: q, score: Math.abs(q.r - c.a) }; });
  var on = cands.filter(function (k) { return Math.abs(k.q.h) <= NSO_SQ_SAME_MM && k.q.r <= k.c.a + NSO_SQ_SAME_MM; });
  var behind = cands.filter(function (k) { return k.q.h < -NSO_SQ_SAME_MM; }).sort(function (x, y) { return x.score - y.score || x.q.h - y.q.h; });
  if (on.length && (!behind.length || behind[0].score > NSO_SQ_SAME_MM)) {
    res.reason = 'that is the square tube\'s open end (' + NSO_sqFmt(2 * on[0].c.a) + ') - press on its side, where the branch grows out of the wall';
    return res;
  }
  if (!behind.length) { res.reason = 'that press is not on the side of a square tube with an open end'; return res; }
  var best = behind[0];
  behind.forEach(function (k) {
    if (k === best || Math.abs(k.score - best.score) > NSO_SQ_SAME_MM) return;
    if (NSO_sqDot(k.c.axis, best.c.axis) > -0.9999 || Math.abs(k.c.a - best.c.a) > NSO_SQ_SAME_MM) return;
    if (k.c.center[2] > best.c.center[2] + 1e-6) best = k;
  });
  var c = best.c, q = best.q;
  if (best.score > Math.max(NSO_SQ_SAME_MM, 0.25 * c.wallMm) && Math.abs(q.r - c.b) < Math.abs(q.r - c.a)) {
    res.reason = 'that is the tube\'s bore - press on its outside, where the branch grows out of the wall';
    return res;
  }
  // the face pressed, and where along it
  var xs = Math.abs(q.x) >= Math.abs(q.y), sg = (xs ? q.x : q.y) >= 0 ? 1 : -1;
  var e = xs ? c.e1 : c.e2, l = xs ? c.e2 : c.e1, lat = xs ? q.y : q.x;
  e = [sg * e[0], sg * e[1], sg * e[2]];
  var par = parentOf(c), C = c.center, h = q.h;
  res.ok = true; res.parent = par;
  res.at = { h: h, r: c.a, ri: c.b, e: e, l: l, lat: lat, offMm: best.score,
             S: [C[0] + h * c.axis[0] + c.a * e[0] + lat * l[0], C[1] + h * c.axis[1] + c.a * e[1] + lat * l[1], C[2] + h * c.axis[2] + c.a * e[2] + lat * l[2]] };
  res.reason = 'on a ' + NSO_sqFmt(2 * c.a) + ' / bore ' + NSO_sqFmt(2 * c.b) + ' square tube, ' + NSO_sqFmt(-h) + ' mm in from its end';
  return res;
}

/* A square prism (a frustum) as a closed soup, wound outward: about the axis
   d from the root centre B, the profile [[t, half-side], ...] (t along d; the
   first and last are flat ends), its sides along u and v (u × v = d). */
function NSO_sqPrism(B, d, u, v, prof) {
  var out = [], rings = [], Q = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  prof.forEach(function (pr) {
    rings.push(Q.map(function (s) {
      var x = s[0] * pr[1], y = s[1] * pr[1];
      return [B[0] + pr[0] * d[0] + x * u[0] + y * v[0], B[1] + pr[0] * d[1] + x * u[1] + y * v[1], B[2] + pr[0] * d[2] + x * u[2] + y * v[2]];
    }));
  });
  function push(A, Bq, Cq) { out.push(A[0], A[1], A[2], Bq[0], Bq[1], Bq[2], Cq[0], Cq[1], Cq[2]); }
  for (var i = 0; i + 1 < rings.length; i++) {
    for (var j = 0; j < 4; j++) {
      var j1 = (j + 1) % 4, A0 = rings[i][j], A1 = rings[i][j1], B0 = rings[i + 1][j], B1 = rings[i + 1][j1];
      push(A0, A1, B1); push(A0, B1, B0);
    }
  }
  var r0 = rings[0], rN = rings[rings.length - 1];
  push(r0[0], r0[2], r0[1]); push(r0[0], r0[3], r0[2]);
  push(rN[0], rN[1], rN[2]); push(rN[0], rN[2], rN[3]);
  return new Float32Array(out);
}

/* How deep along -d (from the press) a square root of half-side rb must sit
   for all four of its corners to be inside the parent's square of half-side
   lim (in the parent's frame), by bisection. NaN when no depth roots it. */
function NSO_sqDepth(par, S, d, u, v, rb, lim) {
  function fits(dep) {
    for (var s1 = -1; s1 <= 1; s1 += 2) for (var s2 = -1; s2 <= 1; s2 += 2) {
      var P = [S[0] - dep * d[0] + s1 * rb * u[0] + s2 * rb * v[0], S[1] - dep * d[1] + s1 * rb * u[1] + s2 * rb * v[1], S[2] - dep * d[2] + s1 * rb * u[2] + s2 * rb * v[2]];
      var w = [P[0] - par.center[0], P[1] - par.center[1], P[2] - par.center[2]];
      if (Math.max(Math.abs(NSO_sqDot(w, par.e1)), Math.abs(NSO_sqDot(w, par.e2))) > lim) return false;
    }
    return true;
  }
  // the deepest worth trying: the root's centre on the axis
  var w0 = [S[0] - par.center[0], S[1] - par.center[1], S[2] - par.center[2]];
  var out = Math.max(Math.abs(NSO_sqDot(w0, par.e1)), Math.abs(NSO_sqDot(w0, par.e2)));
  var sinA = Math.max(1e-6, Math.abs(Math.max(Math.abs(NSO_sqDot(d, par.e1)), Math.abs(NSO_sqDot(d, par.e2)))));
  var top = out / sinA, step = top / 64, found = NaN;
  if (fits(0)) return 0;
  for (var k = 1; k <= 64; k++) { if (fits(step * k)) { found = step * k; break; } }
  if (!isFinite(found)) return NaN;
  var hi = found, lo = Math.max(0, found - step);
  for (var i = 0; i < 50; i++) { var mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  return hi;
}

/* opts: point, dia (the branch's side at the wall, mm), boreDia (its bore's
   side), tipDia (its side at the tip; blank: dia), length (mm out of the
   wall, along the branch), angle (° off the parent's axis), nozzle, read,
   bury. Returns { ok, reason, read, branch } - no union: what the ghost shows. */
function NSO_squareBranchPlan(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: 'branch', square: true };
  if (!opts.point) { res.reason = 'press on the side of the square tube where the branch grows out, and drag it out'; return res; }
  var rd = opts.read && opts.read.ok && opts.read.square && opts.read.soup === soup && opts.read.at && opts.read.pointKey === String(opts.point) ? opts.read
         : NSO_squareBranchRead(soup, { point: opts.point, ends: opts.ends });
  rd.pointKey = String(opts.point);
  res.read = rd;
  if (!rd.ok) { res.reason = rd.reason; return res; }
  var nozzle = NSO_sqNozzle(opts), at = rd.at, par = rd.parent, a = at.r, bi = at.ri;
  res.nozzleMm = nozzle;
  var dia = +opts.dia, tip = (opts.tipDia == null || opts.tipDia === '') ? dia : +opts.tipDia, bore = +opts.boreDia, L = +opts.length, deg = +opts.angle;
  if (opts.dia == null || opts.dia === '' || !(dia > 0) || !isFinite(dia)) { res.reason = 'enter the branch\'s side in mm, more than 0'; return res; }
  if (!(tip > 0) || !isFinite(tip)) { res.reason = 'enter the branch\'s tip side in mm, more than 0 (blank: the same as its side)'; return res; }
  if (opts.boreDia == null || opts.boreDia === '' || !(bore > 0) || !isFinite(bore)) { res.reason = 'enter the branch\'s bore side in mm, more than 0'; return res; }
  if (opts.length == null || opts.length === '' || !(L > 0) || !isFinite(L)) { res.reason = 'enter how far the branch stands out of the wall, in mm, more than 0'; return res; }
  if (opts.angle == null || opts.angle === '' || !isFinite(deg)) { res.reason = 'enter the branch\'s angle off the tube, in degrees (90: straight out)'; return res; }
  var MIN = typeof NSO_RB_MIN_DEG !== 'undefined' ? NSO_RB_MIN_DEG : 20, MAX = typeof NSO_RB_MAX_DEG !== 'undefined' ? NSO_RB_MAX_DEG : 160;
  if (deg < MIN - 1e-9 || deg > MAX + 1e-9) {
    res.reason = 'an angle of ' + NSO_sqFmt(deg, 1) + '° off the tube - a branch stands ' + MIN + '° to ' + MAX + '° off it (90: straight out; under 90 it leans toward the tube\'s upper end, over 90 away)';
    return res;
  }
  var lim2 = NSO_SQ_NOZZLES * nozzle, floor = NSO_sqFloor(nozzle), wallB = (dia - bore) / 2;
  if (!(wallB >= floor - 1e-9)) {
    res.reason = 'a ' + NSO_sqFmt(dia) + ' branch with a ' + NSO_sqFmt(bore) + ' bore has a ' + NSO_sqFmt(Math.max(0, wallB)) + ' mm wall - under the ' + NSO_sqFmt(floor) +
      ' mm floor (nso_thickness.js, a ' + NSO_sqFmt(nozzle, 1) + ' mm nozzle): its bore is ' + NSO_sqFmt(dia - 2 * floor) + ' at most';
    return res;
  }
  if (bore < lim2 - 1e-9 || tip - 2 * wallB < lim2 - 1e-9) {
    res.reason = 'the branch\'s bore would be ' + NSO_sqFmt(Math.max(0, Math.min(bore, tip - 2 * wallB))) + ' across ' + (bore < lim2 ? 'at the wall' : 'at the tip (keeping the wall)') +
      ' - under ' + NSO_sqFmt(lim2) + ' mm (' + NSO_SQ_NOZZLES + ' nozzle widths): make it wider';
    return res;
  }
  var bury = opts.bury == null ? NSO_SQ_BURY_MM : +opts.bury, rb = dia / 2, rt = tip / 2;
  if (!(rb < a - bury)) {
    res.reason = 'a ' + NSO_sqFmt(dia) + ' branch is as wide as the face it would grow from (' + NSO_sqFmt(2 * a) + ') or wider - it is ' +
      NSO_sqFmt(Math.floor((2 * (a - bury) - 0.005) * 100) / 100) + ' at most here';
    return res;
  }
  if (!(bore / 2 < bi - bury)) {
    res.reason = 'a ' + NSO_sqFmt(bore) + ' bore is as wide as the tube\'s own (' + NSO_sqFmt(2 * bi) + ') or wider - its foot would cut the far wall: ' +
      NSO_sqFmt(Math.floor((2 * (bi - bury) - 0.005) * 100) / 100) + ' at most here';
    return res;
  }
  // the branch's foot kept on the face pressed: moved along it if it would run over a corner
  var latMax = Math.min(a - Math.max(rb, rt), bi - Math.max(bore / 2, rt - (rb - bore / 2))) - bury, lat = at.lat;
  if (latMax < 0) latMax = 0;
  var moved = Math.abs(lat) > latMax ? (lat > 0 ? latMax : -latMax) - lat : 0;
  lat += moved;
  var C = par.center, ax = par.axis, e = at.e, l = at.l, h = at.h;
  var S = [C[0] + h * ax[0] + a * e[0] + lat * l[0], C[1] + h * ax[1] + a * e[1] + lat * l[1], C[2] + h * ax[2] + a * e[2] + lat * l[2]];
  var A = deg * Math.PI / 180;
  var d = [Math.cos(A) * ax[0] + Math.sin(A) * e[0], Math.cos(A) * ax[1] + Math.sin(A) * e[1], Math.cos(A) * ax[2] + Math.sin(A) * e[2]];
  // the branch's frame: u in the plane of the axis and d, v along the face (u × v = d)
  var u = [Math.sin(A) * ax[0] - Math.cos(A) * e[0], Math.sin(A) * ax[1] - Math.cos(A) * e[1], Math.sin(A) * ax[2] - Math.cos(A) * e[2]];
  var v = NSO_sqCross(d, u);
  var depth = NSO_sqDepth(par, S, d, u, v, rb, a - bury);
  if (!isFinite(depth)) {
    res.reason = 'a ' + NSO_sqFmt(dia) + ' branch at ' + NSO_sqFmt(deg, 0) + '° is too wide to root in a ' + NSO_sqFmt(2 * a) +
      ' square tube - its foot would show through the wall: make it narrower, or stand it nearer 90°';
    return res;
  }
  var rib = bore / 2, rit = rt - (rb - rib), dB = NSO_sqDepth(par, S, d, u, v, rib, bi - bury);
  if (!isFinite(dB)) {
    res.reason = 'a ' + NSO_sqFmt(bore) + ' bore at ' + NSO_sqFmt(deg, 0) + '° does not fit inside the ' + NSO_sqFmt(2 * bi) +
      ' bore it would open into - its foot would cut the far wall: make it narrower, or stand it nearer 90°';
    return res;
  }
  // rings along the branch, so Limb has a body to bend: about as far apart as the branch is wide, 0.5 - 2 mm
  var step = Math.max(0.5, Math.min(NSO_SQ_RING_MM, Math.min(rb, rt))), nr = Math.max(1, Math.min(400, Math.ceil(L / step)));
  var Bc = [S[0] - depth * d[0], S[1] - depth * d[1], S[2] - depth * d[2]], pO = [[0, rb], [depth, rb]];
  for (var q = 1; q <= nr; q++) pO.push([depth + L * q / nr, rb + (rt - rb) * q / nr]);
  var Bb = [S[0] - dB * d[0], S[1] - dB * d[1], S[2] - dB * d[2]], pB = [[0, rib], [dB, rib]], slope = (rit - rib) / L;
  // (no ring on the tip's plane: the bore runs straight through it and 1 mm on - nso_rod_branch.js's reason)
  for (var qb = 1; qb < nr; qb++) pB.push([dB + L * qb / nr, rib + (rit - rib) * qb / nr]);
  pB.push([dB + L + 1, rit + slope]);
  // the TRIM: the parent's bore, 0.02 mm wider, along its axis over the junction
  var half = depth + Math.max(rb, rt) + 2, rTrim = bi + 0.02;
  var Ta = [C[0] + (h - half) * ax[0], C[1] + (h - half) * ax[1], C[2] + (h - half) * ax[2]];
  var soupB = NSO_sqPrism(Bc, d, u, v, pO);
  var tubeParts = { bore: NSO_sqPrism(Bb, d, u, v, pB), trim: NSO_sqPrism(Ta, ax, par.e1, par.e2, [[0, rTrim], [2 * half, rTrim]]),
                    boreR: rib, boreTipR: rit, boreDepthMm: dB, parentBoreR: bi, wallMm: rb - rib };
  var outside = 4 * L * (rb * rb + rb * rt + rt * rt) / 3, whole = outside + 4 * rb * rb * depth;
  outside -= 4 * L * (rib * rib + rib * rit + rit * rit) / 3;
  var T = [S[0] + L * d[0], S[1] + L * d[1], S[2] + L * d[2]];
  res.branch = { square: true, tube: tubeParts, soup: soupB, root: Bc, wall: S, tip: T, dir: d, u: u, v: v, rootR: rb, tipR: rt, depthMm: depth, rings: nr,
                 volumeMm3: whole, outsideMm3: outside, lengthMm: L, angleDeg: deg, parentR: a, movedMm: moved };
  res.ok = true;
  res.reason = NSO_squareBranchDescribe(res);
  return res;
}
function NSO_squareBranchDescribe(r) {
  var b = r.branch, tb = b.tube, at = r.read.at;
  return 'Square branch ' + NSO_sqFmt(2 * b.rootR) + ' / bore ' + NSO_sqFmt(2 * tb.boreR) + ' (wall ' + NSO_sqFmt(tb.wallMm) + ')' +
    (Math.abs(b.tipR - b.rootR) > 1e-9 ? ' → ' + NSO_sqFmt(2 * b.tipR) + ' tip' : '') + ', ' + NSO_sqFmt(b.lengthMm, 1) + ' mm out at ' +
    NSO_sqFmt(b.angleDeg, 0) + '° off a ' + NSO_sqFmt(2 * b.parentR) + ' / ' + NSO_sqFmt(2 * tb.parentBoreR) + ' square tube, ' + NSO_sqFmt(-at.h) + ' mm in from its end' +
    (Math.abs(b.movedMm) > 1e-6 ? ' (moved ' + NSO_sqFmt(Math.abs(b.movedMm)) + ' mm along the face to keep its foot on it)' : '');
}

/* As the plan, then Tubes → Branch's three booleans and gates (nso_rod_branch.js
   NSO_rbWeldTube; opts.union / opts.subtract as it takes them). A kernel answer
   that is not one clean solid is tried again with the root buried a little
   deeper. Promise of { ok, reason, tris, branch, counts, volume, topology }. */
var NSO_SQ_BURIES = [0.05, 0.08, 0.13];
function NSO_squareBranchRaw(soup, opts) {
  opts = opts || {};
  if (typeof NSO_rbWeldTube !== 'function') {
    return Promise.resolve({ ok: false, tris: soup, reason: 'nso_rod_branch.js must be loaded - a square branch is welded with Tubes → Branch\'s booleans' });
  }
  var k = 0;
  function attempt() {
    var o = {};
    for (var key in opts) o[key] = opts[key];
    o.bury = NSO_SQ_BURIES[k];
    o.read = null;
    var plan = NSO_squareBranchPlan(soup, o);
    if (!plan.ok) return Promise.resolve(plan);
    return NSO_rbWeldTube(soup, o, plan).then(function (r) {
      if (!r.ok && r.retry && ++k < NSO_SQ_BURIES.length) return attempt();
      if (r.ok) r.reason = NSO_squareBranchDescribe(r);
      r.tries = k + 1;
      return r;
    });
  }
  return attempt();
}

/* =====================================================================
   6. A new square tube, and the readout
   ===================================================================== */

/* A square tube standing on z = 0, its axis +Z through the origin, both ends
   open: side, bore (mm across), length. Its rings and side points at most
   NSO_SQ_RING_MM apart, so a neck has rings to lay between and Limb a body to
   bend. Returns { ok, reason, soup }. */
function NSO_squareTubeSoup(side, bore, length, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '' };
  side = +side; bore = +bore; length = +length;
  if (!(side > 0) || !(bore > 0) || !(length > 0)) { res.reason = 'a square tube needs a side, a bore and a length, each more than 0'; return res; }
  var nozzle = NSO_sqNozzle(opts), floor = NSO_sqFloor(nozzle);
  if (!((side - bore) / 2 >= floor - 1e-9)) { res.reason = 'a ' + NSO_sqFmt(side) + ' tube with a ' + NSO_sqFmt(bore) + ' bore has a wall under the ' + NSO_sqFmt(floor) + ' mm floor'; return res; }
  if (bore < NSO_SQ_NOZZLES * nozzle - 1e-9) { res.reason = 'the bore is under ' + NSO_sqFmt(NSO_SQ_NOZZLES * nozzle) + ' mm across'; return res; }
  var step = opts.step || NSO_SQ_RING_MM, E = { center: [0, 0, 0], axis: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0] };
  function loop(r, n, h) {
    var pts = [], S = [[1, -1, 0, 1], [1, 1, -1, 0], [-1, 1, 0, -1], [-1, -1, 1, 0]];   // start corner (x, y) and the way along
    S.forEach(function (s) {
      for (var i = 0; i < n; i++) {
        var f = 2 * r * i / n, x = s[0] * r + s[2] * f, y = s[1] * r + s[3] * f;
        pts.push({ p: [x, y, h], x: x, y: y });
      }
    });
    return pts;
  }
  var a = side / 2, b = bore / 2, no = Math.max(1, Math.ceil(side / step)), ni = Math.max(1, Math.ceil(bore / step)), nz = Math.max(1, Math.ceil(length / step));
  var RO = [], RI = [];
  for (var k = 0; k <= nz; k++) { var z = length * k / nz; RO.push(loop(a, no, z)); RI.push(loop(b, ni, z)); }
  var out = [];
  NSO_sqLoft(out, E, RO, 1);
  NSO_sqLoft(out, E, RI, -1);
  NSO_sqZip(out, E, RO[nz], a, RI[nz], b, function () { return [0, 0, 1]; });
  NSO_sqZip(out, E, RO[0], a, RI[0], b, function () { return [0, 0, -1]; });
  res.ok = true; res.soup = new Float32Array(out);
  res.reason = 'square tube ' + NSO_sqFmt(side) + ' / bore ' + NSO_sqFmt(bore) + ' (wall ' + NSO_sqFmt(a - b) + '), ' + NSO_sqFmt(length, 1) + ' mm long';
  return res;
}

function NSO_squareTubeDescribe(r) {
  if (r.verb === 'reducer' && r.reducer) {
    var q = r.reducer, head = { expander: 'Square expander', reducer: 'Square reducer', bore: 'Square reducer (bore only)', straight: 'Straight on' }[q.kind];
    var s = head + ': ' + NSO_sqFmt(2 * q.a1) + ' / bore ' + NSO_sqFmt(2 * q.b1) + ' → ' + NSO_sqFmt(2 * q.a2) + ' / bore ' + NSO_sqFmt(2 * q.b2);
    if (q.T > 0) s += ' over ' + NSO_sqFmt(q.T, 1) + ' mm' + (q.profile === 'trumpet' ? ', trumpet' : '') + ' (' + NSO_sqFmt(q.angleOuterDeg, 1) + '° outside, ' +
      NSO_sqFmt(q.angleBoreDeg, 1) + '° bore' + (q.profile === 'trumpet' ? ' where it ends' : '') + ')';
    if (q.run > 0) s += (q.T > 0 ? ', then ' : ' ') + NSO_sqFmt(q.run, 1) + ' mm run';
    s += ' · wall ' + NSO_sqFmt(q.a1 - q.b1) + ' → ' + NSO_sqFmt(q.wallEndMm);
    if (q.wallMm < Math.min(q.a1 - q.b1, q.wallEndMm) - 0.005) s += ' (' + NSO_sqFmt(q.wallMm) + ' at the thinnest, square to the transition\'s faces)';
    return s;
  }
  if (r.verb === 'neck' && r.neck) {
    var n = r.neck, w = { both: '', outside: ' (outside only)', bore: ' (bore only)' }[n.walls];
    return 'Square neck' + w + ': ' + (n.dr < 0 ? 'pinch ' : 'bulge ') + NSO_sqFmt(Math.abs(n.dr)) + ' mm over ' + NSO_sqFmt(n.L, 1) + ' mm, ' + n.profile + ', centred ' +
      NSO_sqFmt(-n.h0) + ' mm in · waist ' + NSO_sqFmt(n.waistSide) + ' / bore ' + NSO_sqFmt(n.waistBore) + ' · wall ' + NSO_sqFmt(n.wallMm) + ' at the thinnest';
  }
  return r.reason || '';
}

var NSO_SquareTube = { ends: NSO_squareTubeEnds, read: NSO_squareTubeRead, reducer: NSO_squareTubeReducer, neck: NSO_squareTubeNeck,
                       branchRead: NSO_squareBranchRead, branchPlan: NSO_squareBranchPlan, branch: NSO_squareBranchRaw, make: NSO_squareTubeSoup,
                       describe: NSO_squareTubeDescribe };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_SquareTube: NSO_SquareTube, NSO_squareTubeEnds: NSO_squareTubeEnds, NSO_squareTubeRead: NSO_squareTubeRead,
                     NSO_squareTubeReducer: NSO_squareTubeReducer, NSO_squareTubeNeck: NSO_squareTubeNeck, NSO_squareBranchRead: NSO_squareBranchRead,
                     NSO_squareBranchPlan: NSO_squareBranchPlan, NSO_squareBranchRaw: NSO_squareBranchRaw, NSO_squareTubeSoup: NSO_squareTubeSoup };
}
