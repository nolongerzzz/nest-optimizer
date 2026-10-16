// ===================== Close: a lid across an open end =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_close_test.js) and under a classic script tag in the
// browser, where the CLOSE card (app-close.js, in ADD) calls it.
// docs/CLOSE.md.
//
// THE PICK. An open end is a flat face of the piece with a hole in it: a
// tube's end annulus, an open box's rim, any rim whose face has an outer loop
// and an inner one. The face under the click is flooded out the way Tube edge
// finds its end (edge-connected, one plane, NSO_CL_PLANE_TOL_MM), and its
// boundary is walked into loops with Tube edge's own walker (NSO_teFaceLoops,
// nso_tube_edge.js, which this file needs loaded first). The outer loop runs
// counter-clockwise about the face's outward normal, every hole clockwise; the
// hole nearest the click is the opening. The loop may be any shape - round,
// square, a slot - so long as it is one closed loop, and its wall must go DOWN
// into the piece from it (a post standing on a face is not an opening).
//
// THE LID is a slab across the opening, as thick as the wall there (the
// least distance from the opening's loop to the outer loop, in the face's
// plane), flush with the rim; Inset sinks it that far below the rim. It is
// unioned to the piece, but not by a Boolean: the lid fills the opening's own
// wall between two planes parallel to the rim, so its sides ARE that wall.
// The wall's triangles are cut at the two planes, the pieces between them
// dropped, and each cut loop is closed with a flat cap - the lid's top
// (facing out of the opening) and its underside (facing into it). With no
// inset the top cap is the opening's own loop, so the rim face and the lid
// top meet at the rim. Every triangle off the opening's wall is copied bit for
// bit; the outer wall is never touched, so the piece's outside is unchanged.
// A cut point is computed once per (edge, plane) and shared by both triangles
// on that edge, so the cut needs no weld.
//
// THE GATES, on the output: every edge used exactly twice, once each way (closed
// and manifold); no triangle without area; the added volume between the two
// caps' areas times the thickness (exactly cap area x thickness when the wall
// is straight, as a tube's and a box's are).
//
// REFUSALS, before anything is built, in words, the piece unchanged:
//   - an edge that is a hole in the mesh, not a rim: "that edge isn't an open
//     end - Patch repairs holes". So is a piece with open edges anywhere: the
//     lid's caps are found as the cut's open edges, and a hole would be one.
//   - a face with no opening, an opening that is a post, a tangled outline
//   - a lid under 2 nozzle widths thick, a negative inset
//   - the lid reaching a floor or a step of the opening (it is not that deep)
//   - the lid's planes crossing more than one wall of the opening (a post
//     inside it), or the opening's wall running into the outside
//
// PAINT SCOPE: WHOLE-PIECE - the caller's (app-close.js), as Tube edge's.

var NSO_CL_PLANE_TOL_MM = 1e-3;     // one flat rim face: every vertex this close to its plane
var NSO_CL_ON_MM = 5e-4;            // a vertex this close to a cut plane is on it
var NSO_CL_MIN_NOZZLES = 2;         // a lid at least 2 nozzle widths thick
var NSO_CL_FLOOR_COS = 0.5;         // a face this flat to the rim, inside the lid, is a floor
var NSO_CL_VOLUME_TOL = 1e-3;       // added volume vs the caps' areas x thickness

function NSO_clFmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
function NSO_clNozzle(opts) {
  if (opts && typeof opts.nozzle === 'number' && opts.nozzle > 0) return opts.nozzle;
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  return (T && T.NOZZLE_DEFAULT > 0) ? T.NOZZLE_DEFAULT : 0.4;
}

/* The weld, once per soup: the card reads the same soup on every hover. */
var NSO_clWeldCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_clWeld(soup) {
  var W = NSO_clWeldCache && NSO_clWeldCache.get(soup);
  if (W) return W;
  W = NSO_teWeld(soup);
  var open = 0, nonManifold = 0;
  for (var e = 0; e < W.eC.length; e++) { if (W.eC[e] === 1) open++; else if (W.eC[e] > 2) nonManifold++; }
  W.openEdges = open; W.nonManifold = nonManifold;
  if (NSO_clWeldCache) NSO_clWeldCache.set(soup, W);
  return W;
}

/* Squared distance from p to triangle t of the weld. */
function NSO_clTriDist2(W, t, p) {
  var P = W.P, a = W.vid[t * 3] * 3, b = W.vid[t * 3 + 1] * 3, c = W.vid[t * 3 + 2] * 3;
  // Ericson's closest point on a triangle
  var ax = P[a], ay = P[a + 1], az = P[a + 2];
  var abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  var acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  var apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  var d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  var q;
  if (d1 <= 0 && d2 <= 0) q = [ax, ay, az];
  else {
    var bpx = p[0] - P[b], bpy = p[1] - P[b + 1], bpz = p[2] - P[b + 2];
    var d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    var cpx = p[0] - P[c], cpy = p[1] - P[c + 1], cpz = p[2] - P[c + 2];
    var d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    var vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = [P[b], P[b + 1], P[b + 2]];
    else if (d6 >= 0 && d5 <= d6) q = [P[c], P[c + 1], P[c + 2]];
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { var v1 = d1 / (d1 - d3); q = [ax + v1 * abx, ay + v1 * aby, az + v1 * abz]; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { var w1 = d2 / (d2 - d6); q = [ax + w1 * acx, ay + w1 * acy, az + w1 * acz]; }
    else if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      q = [P[b] + w2 * (P[c] - P[b]), P[b + 1] + w2 * (P[c + 1] - P[b + 1]), P[b + 2] + w2 * (P[c + 2] - P[b + 2])];
    } else {
      var den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
      q = [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
    }
  }
  var dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
  return dx * dx + dy * dy + dz * dz;
}

/* The triangle under the click: opts.tri when it is that close to the point
   (the raycast's face), else the nearest triangle to opts.point. */
function NSO_clPickTri(W, opts) {
  var p = opts && opts.point;
  if (!p) return -1;
  if (opts.tri != null && opts.tri >= 0 && opts.tri < W.n && !W.degen[opts.tri] &&
      NSO_clTriDist2(W, opts.tri, p) < 1e-4) return opts.tri;
  var best = -1, bd = Infinity;
  for (var t = 0; t < W.n; t++) {
    if (W.degen[t]) continue;
    var d = NSO_clTriDist2(W, t, p);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/* The flat face through triangle s: edge-connected, one plane. */
function NSO_clFace(W, s) {
  var N = W.N, P = W.P, vid = W.vid;
  var nx = N[s * 3], ny = N[s * 3 + 1], nz = N[s * 3 + 2], v0 = vid[s * 3] * 3;
  var d = nx * P[v0] + ny * P[v0 + 1] + nz * P[v0 + 2];
  var region = new Int32Array(W.n).fill(-1), mem = [s], q = 0, touchesOpen = false;
  region[s] = 0;
  while (q < mem.length) {
    var t = mem[q++];
    for (var k = 0; k < 3; k++) {
      var id = W.cornerEdge[t * 3 + k];
      if (W.eC[id] !== 2) { if (W.eC[id] === 1) touchesOpen = true; continue; }
      var u = NSO_teAcross(W, t * 3 + k);
      if (u < 0 || region[u] >= 0) continue;
      if (!W.degen[u] && nx * N[u * 3] + ny * N[u * 3 + 1] + nz * N[u * 3 + 2] < 0.9999) continue;
      var flat = true;
      for (var c = 0; c < 3 && flat; c++) {
        var vi = vid[u * 3 + c] * 3;
        if (Math.abs(nx * P[vi] + ny * P[vi + 1] + nz * P[vi + 2] - d) > NSO_CL_PLANE_TOL_MM) flat = false;
      }
      if (!flat) continue;
      region[u] = 0; mem.push(u);
    }
  }
  return { id: 0, tris: mem, n: [nx, ny, nz], d: d, region: region, touchesOpen: touchesOpen };
}

function NSO_clArea2(p2) {
  var a = 0;
  for (var i = 0, n = p2.length; i < n; i++) { var p = p2[i], q = p2[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function NSO_clSegDist(p, a, b) {
  var ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
  var t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey);
}
function NSO_clLoopDist(p, lp) {
  var m = Infinity;
  for (var i = 0, n = lp.length; i < n; i++) m = Math.min(m, NSO_clSegDist(p, lp[i], lp[(i + 1) % n]));
  return m;
}
function NSO_clInside(p, lp) {
  var c = false;
  for (var i = 0, j = lp.length - 1; i < lp.length; j = i++) {
    var a = lp[i], b = lp[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/* What the opening is, in words: Ø for a round one, w x h for a rectangle. */
function NSO_clShapeWords(p2) {
  if (typeof NSO_sectionClassLoop === 'function' && p2.length >= 4) {
    var cl = NSO_sectionClassLoop(p2);
    if (cl.cls === 'round') return { kind: 'round', text: 'a Ø' + NSO_clFmt(2 * cl.circle.r) + ' opening', dia: 2 * cl.circle.r };
    if (cl.cls === 'rectangular') return { kind: 'rectangular', text: 'a ' + NSO_clFmt(cl.rect.span[0]) + ' × ' + NSO_clFmt(cl.rect.span[1]) + ' opening' };
  }
  return { kind: 'other', text: 'a ' + NSO_clFmt(Math.abs(NSO_clArea2(p2)), 1) + ' mm² opening' };
}

/* =====================================================================
   1. Read the open end under the click
   ===================================================================== */

var NSO_CL_PATCH = "that edge isn't an open end — Patch repairs holes";

/* NSO_closeRead(soup, { point, tri }) -> { ok, reason, rim } where rim is
   { normal, planeD, frame, outer, inner (raw 3D loops, for the outline),
     innerVids, wallMm, shape, faceTris }. */
function NSO_closeRead(soup, opts) {
  opts = opts || {};
  if (!soup || soup.length < 9) return { ok: false, reason: 'no piece' };
  var W = NSO_clWeld(soup);
  var s = NSO_clPickTri(W, opts);
  if (s < 0) return { ok: false, reason: 'click an open end - a tube end, an open box\'s rim' };
  var F = NSO_clFace(W, s);
  if (F.touchesOpen) return { ok: false, reason: NSO_CL_PATCH, hole: true };
  var L = NSO_teFaceLoops(W, F, F.region);
  if (L.tangled) return { ok: false, reason: 'that face\'s outline is tangled - it is not one rim' };
  var fr = NSO_teFrame(F.n), P = W.P, e1 = fr.e1, e2 = fr.e2;
  function to2(v) { var i = v * 3; return [P[i] * e1[0] + P[i + 1] * e1[1] + P[i + 2] * e1[2], P[i] * e2[0] + P[i + 1] * e2[1] + P[i + 2] * e2[2]]; }
  var loops = L.loops.map(function (lp) { var p2 = lp.v.map(to2); return { v: lp.v, corners: lp.corners, p2: p2, area: NSO_clArea2(p2) }; });
  var outer = null, holes = [];
  loops.forEach(function (lp) {
    if (lp.area > 0) { if (!outer || lp.area > outer.area) outer = lp; }
    else holes.push(lp);
  });
  if (!holes.length) {
    // A hole in the mesh beside a closed face reads the same to the eye: name Patch.
    if (W.openEdges > 0) return { ok: false, reason: NSO_CL_PATCH, hole: true };
    return { ok: false, reason: 'that face has no opening in it - click the rim of an open end' };
  }
  if (!outer) return { ok: false, reason: 'that face has no outer edge - it is not a rim' };
  // The opening nearest the click.
  var c2 = [opts.point[0] * e1[0] + opts.point[1] * e1[1] + opts.point[2] * e1[2],
            opts.point[0] * e2[0] + opts.point[1] * e2[1] + opts.point[2] * e2[2]];
  var hole = holes[0], hd = Infinity;
  holes.forEach(function (h) { var d = NSO_clInside(c2, h.p2) ? 0 : NSO_clLoopDist(c2, h.p2); if (d < hd) { hd = d; hole = h; } });
  // The wall must go down into the piece from the hole: the triangle across
  // each of its edges has its third corner below the rim.
  var down = 0, up = 0;
  for (var i = 0; i < hole.corners.length; i++) {
    var r = hole.corners[i], u = NSO_teAcross(W, r);
    if (u < 0) continue;
    for (var k = 0; k < 3; k++) {
      var v = W.vid[u * 3 + k] * 3;
      var dep = F.d - (F.n[0] * P[v] + F.n[1] * P[v + 1] + F.n[2] * P[v + 2]);
      if (dep > NSO_CL_PLANE_TOL_MM) { down++; break; }
      if (dep < -NSO_CL_PLANE_TOL_MM) { up++; break; }
    }
  }
  if (up > down) return { ok: false, reason: 'that loop is a post standing on the face, not an opening' };
  // The wall: round in round, the difference of the two circles the section
  // reader fits; a rectangle in a rectangle, the narrower side's; else the
  // least distance across the rim, from the opening's corners to the outer edge.
  var wall = Infinity;
  if (typeof NSO_sectionClassLoop === 'function' && hole.p2.length >= 4 && outer.p2.length >= 4) {
    var ci = NSO_sectionClassLoop(hole.p2), co = NSO_sectionClassLoop(outer.p2);
    if (ci.cls === 'round' && co.cls === 'round' &&
        Math.hypot(ci.circle.center[0] - co.circle.center[0], ci.circle.center[1] - co.circle.center[1]) <= co.circle.tolMm) {
      wall = co.circle.r - ci.circle.r;
    } else if (ci.cls === 'rectangular' && co.cls === 'rectangular') {
      wall = Math.min(ci.rect.lo[0] - co.rect.lo[0], co.rect.hi[0] - ci.rect.hi[0],
                      ci.rect.lo[1] - co.rect.lo[1], co.rect.hi[1] - ci.rect.hi[1]);
    }
  }
  if (!(wall > 0) || !isFinite(wall)) {
    wall = Infinity;
    for (var j = 0; j < hole.p2.length; j++) wall = Math.min(wall, NSO_clLoopDist(hole.p2[j], outer.p2));
  }
  function to3(v) { var q = v * 3; return [P[q], P[q + 1], P[q + 2]]; }
  var shape = NSO_clShapeWords(hole.p2.slice().reverse());
  if (W.openEdges > 0) {
    return { ok: false, reason: 'the piece has ' + W.openEdges + ' open edge(s) elsewhere — Patch repairs holes first', hole: true };
  }
  if (W.nonManifold > 0) return { ok: false, reason: 'the piece has ' + W.nonManifold + ' edge(s) shared by more than two faces - Seal with Repair on first' };
  return {
    ok: true, soup: soup,
    reason: shape.text + ', wall ' + NSO_clFmt(wall) + ' mm',
    rim: {
      normal: F.n, planeD: F.d, frame: fr, wallMm: wall, shape: shape,
      outer: outer.v.map(to3), inner: hole.v.map(to3), outerVids: outer.v, innerVids: hole.v, innerCorners: hole.corners,
      faceTris: F.tris.length, pickTri: s
    }
  };
}

/* =====================================================================
   2. The lid
   ===================================================================== */

/* Ear clipping of one closed loop of 2D points, winding kept. sign is +1 for
   a counter-clockwise loop, -1 for clockwise. Returns triangles as index
   triples into the loop, or null when no ear can be found. */
function NSO_clEarClip(p2, sign) {
  var n = p2.length, idx = [], out = [];
  for (var i = 0; i < n; i++) idx.push(i);
  var span = 0;
  p2.forEach(function (p) { span = Math.max(span, Math.abs(p[0]), Math.abs(p[1])); });
  var tiny = 1e-12 * Math.max(1, span * span);
  function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
  function inTri(p, a, b, c) {
    var d1 = sign * cross(a, b, p), d2 = sign * cross(b, c, p), d3 = sign * cross(c, a, p);
    return d1 >= -tiny && d2 >= -tiny && d3 >= -tiny;
  }
  var guard = 0;
  while (idx.length > 3 && guard++ < 4 * n * n + 16) {
    var m = idx.length, found = false;
    // the vertices an ear could swallow: the ones that are not strictly convex
    var cand = [];
    for (var j = 0; j < m; j++) {
      var a = p2[idx[(j + m - 1) % m]], b = p2[idx[j]], c = p2[idx[(j + 1) % m]];
      if (sign * cross(a, b, c) <= tiny) cand.push(idx[j]);
    }
    for (var e = 0; e < m && !found; e++) {
      var ia = idx[(e + m - 1) % m], ib = idx[e], ic = idx[(e + 1) % m];
      var A = p2[ia], B = p2[ib], C = p2[ic];
      if (sign * cross(A, B, C) <= tiny) continue;
      var ok = true;
      for (var q = 0; q < cand.length && ok; q++) {
        var v = cand[q];
        if (v === ia || v === ib || v === ic) continue;
        var V = p2[v];
        if ((V[0] === A[0] && V[1] === A[1]) || (V[0] === C[0] && V[1] === C[1])) continue;
        if (inTri(V, A, B, C)) ok = false;
      }
      if (!ok) continue;
      out.push([ia, ib, ic]);
      idx.splice(e, 1);
      found = true;
    }
    if (!found) return null;
  }
  if (idx.length === 3) {
    if (sign * cross(p2[idx[0]], p2[idx[1]], p2[idx[2]]) <= tiny) return null;
    out.push([idx[0], idx[1], idx[2]]);
  }
  return out;
}

/* NSO_closeRaw(soup, { point, tri, thickness, inset, nozzle, read })
   -> { ok, reason, tris, counts, lid, rim }. On refusal tris is absent and
   the piece is unchanged. thickness blank = the wall at the rim. */
function NSO_closeRaw(soup, opts) {
  opts = opts || {};
  var rd = (opts.read && opts.read.ok && opts.read.soup === soup) ? opts.read : NSO_closeRead(soup, opts);
  if (!rd.ok) return { ok: false, reason: rd.reason, hole: !!rd.hole };
  var rim = rd.rim, W = NSO_clWeld(soup), P = W.P, vid = W.vid, n = W.n;
  var nozzle = NSO_clNozzle(opts);
  var t = (opts.thickness == null || opts.thickness === '') ? rim.wallMm : +opts.thickness;
  var inset = (opts.inset == null || opts.inset === '') ? 0 : +opts.inset;
  var floorT = NSO_CL_MIN_NOZZLES * nozzle;
  if (!isFinite(t) || !(t > 0)) return { ok: false, reason: 'give the lid a thickness in mm', rim: rim };
  if (t < floorT - 1e-9) {
    return { ok: false, rim: rim, reason: 'a lid ' + NSO_clFmt(t) + ' mm thick is under ' + NSO_CL_MIN_NOZZLES +
      ' nozzle widths (' + NSO_clFmt(floorT) + ' mm) - it would not print as a solid' };
  }
  if (!isFinite(inset) || inset < 0) return { ok: false, rim: rim, reason: 'Inset is how far below the rim the lid sits - 0 or more' };
  var Nn = rim.normal, c = rim.planeD, D1 = inset, D2 = inset + t, ON = NSO_CL_ON_MM;
  var depth = new Float64Array(W.nv);
  for (var v = 0; v < W.nv; v++) depth[v] = c - (Nn[0] * P[v * 3] + Nn[1] * P[v * 3 + 1] + Nn[2] * P[v * 3 + 2]);

  // The opening's wall above the lid's underside: flood from the triangles
  // across the opening's loop, through every triangle with a corner above D2.
  var faceSet = new Uint8Array(n);
  {
    var Fl = NSO_clFace(W, rim.pickTri);
    for (var fi = 0; fi < Fl.tris.length; fi++) faceSet[Fl.tris[fi]] = 1;
  }
  var outerSet = new Set(rim.outerVids);
  var inR = new Uint8Array(n), region = [], q = 0;
  function minDepth(tt) { return Math.min(depth[vid[tt * 3]], depth[vid[tt * 3 + 1]], depth[vid[tt * 3 + 2]]); }
  rim.innerCorners.forEach(function (r) {
    var u = NSO_teAcross(W, r);
    if (u >= 0 && !faceSet[u] && !inR[u] && minDepth(u) < D2 - ON) { inR[u] = 1; region.push(u); }
  });
  var leak = false;
  while (q < region.length) {
    var tr = region[q++];
    for (var k = 0; k < 3; k++) {
      if (outerSet.has(vid[tr * 3 + k])) leak = true;
      var u2 = NSO_teAcross(W, tr * 3 + k);
      if (u2 < 0 || inR[u2]) continue;
      if (faceSet[u2]) continue;
      if (minDepth(u2) < D2 - ON) { inR[u2] = 1; region.push(u2); }
    }
  }
  if (!region.length) return { ok: false, rim: rim, reason: 'the opening has no wall below the rim to hold a lid' };
  if (leak) return { ok: false, rim: rim, reason: 'the opening\'s wall runs out to the outside within ' + NSO_clFmt(D2) + ' mm of the rim - a lid there would not be closed by the wall' };

  // A floor or a step inside the lid's slab: the opening is not that deep.
  for (var ri = 0; ri < region.length; ri++) {
    var tq = region[ri];
    var cosN = Math.abs(W.N[tq * 3] * Nn[0] + W.N[tq * 3 + 1] * Nn[1] + W.N[tq * 3 + 2] * Nn[2]);
    if (W.degen[tq] || cosN < NSO_CL_FLOOR_COS) continue;
    var dmin = minDepth(tq), dmax = Math.max(depth[vid[tq * 3]], depth[vid[tq * 3 + 1]], depth[vid[tq * 3 + 2]]);
    if (dmax > D1 + ON && dmin < D2 - ON) {
      return { ok: false, rim: rim, reason: 'the opening has a floor or a step ' + NSO_clFmt(Math.max(dmin, 0)) +
        ' mm below the rim - a lid ' + NSO_clFmt(t) + ' mm thick' + (inset > 0 ? ' at ' + NSO_clFmt(inset) + ' mm inset' : '') +
        ' needs ' + NSO_clFmt(D2) + ' mm' };
    }
  }

  // Cut the wall at D1 and D2; keep what lies above D1 and below D2.
  var newPos = [], cutCache = new Map(), nv0 = W.nv;
  function posOf(id) { return id < nv0 ? [P[id * 3], P[id * 3 + 1], P[id * 3 + 2]] : newPos[id - nv0]; }
  function depthOf(id) { return id < nv0 ? depth[id] : newPos[id - nv0].depth; }
  function cutPoint(a, b, D, pi) {
    var lo = a < b ? a : b, hi = a < b ? b : a, key = pi + ':' + lo + ':' + hi, id = cutCache.get(key);
    if (id !== undefined) return id;
    var pl = posOf(lo), ph = posOf(hi), dl = depthOf(lo), dh = depthOf(hi), s = (D - dl) / (dh - dl);
    var np = [Math.fround(pl[0] + s * (ph[0] - pl[0])), Math.fround(pl[1] + s * (ph[1] - pl[1])), Math.fround(pl[2] + s * (ph[2] - pl[2]))];
    np.depth = D;
    id = nv0 + newPos.length; newPos.push(np); cutCache.set(key, id);
    return id;
  }
  // keep: -1 = the side above D (depth <= D), +1 = below (depth >= D)
  function clip(poly, D, keep, pi) {
    var out = [], m = poly.length;
    function side(id) { var s = depthOf(id) - D; return Math.abs(s) <= ON ? 0 : (s < 0 ? -1 : 1); }
    for (var i = 0; i < m; i++) {
      var a = poly[i], b = poly[(i + 1) % m], sa = side(a), sb = side(b);
      if (sa === 0 || sa === keep) out.push(a);
      if (sa !== 0 && sb !== 0 && sa !== sb) out.push(cutPoint(a, b, D, pi));
    }
    return out;
  }
  var kept = [];
  for (var rj = 0; rj < region.length; rj++) {
    var tz = region[rj], tri = [vid[tz * 3], vid[tz * 3 + 1], vid[tz * 3 + 2]];
    [clip(tri, D1, -1, 1), clip(tri, D2, 1, 2)].forEach(function (poly) {
      // drop a polygon that only touches the plane (all of it on the plane)
      if (poly.length < 3) return;
      for (var f = 1; f + 1 < poly.length; f++) kept.push([poly[0], poly[f], poly[f + 1]]);
    });
  }

  // The output's triangles as vertex ids: everything off the wall, then the kept pieces.
  var outTris = [];
  for (var to = 0; to < n; to++) if (!inR[to]) outTris.push([vid[to * 3], vid[to * 3 + 1], vid[to * 3 + 2]]);
  kept.forEach(function (k3) { outTris.push(k3); });

  // The cut's open edges, as the caps' loops (each open edge a->b is the cap's b->a).
  var dir = new Map();
  function ek(a, b) { return a + '>' + b; }
  outTris.forEach(function (k3) {
    for (var e = 0; e < 3; e++) { var key = ek(k3[e], k3[(e + 1) % 3]); dir.set(key, (dir.get(key) || 0) + 1); }
  });
  var capNext = new Map(), bad = 0;
  dir.forEach(function (cnt, key) {
    var ab = key.split('>'), a = +ab[0], b = +ab[1];
    if (cnt > 1) bad++;
    if (!dir.has(ek(b, a))) { if (capNext.has(b)) bad++; capNext.set(b, a); }
  });
  if (bad) return { ok: false, rim: rim, reason: 'the wall at the lid does not cut into clean loops (' + bad + ' tangled edge(s))' };
  var capLoops = [], seen = new Set();
  capNext.forEach(function (_, a0) {
    if (seen.has(a0)) return;
    var lp = [], x = a0, g = 0;
    while (!seen.has(x) && capNext.has(x) && g++ <= capNext.size) { seen.add(x); lp.push(x); x = capNext.get(x); }
    if (x !== a0) bad++;
    capLoops.push(lp);
  });
  if (bad) return { ok: false, rim: rim, reason: 'the wall at the lid does not cut into closed loops' };
  var top = [], under = [];
  for (var cl = 0; cl < capLoops.length; cl++) {
    var lp2 = capLoops[cl], d0 = depthOf(lp2[0]), onTop = Math.abs(d0 - D1) <= 2 * ON, onUnder = Math.abs(d0 - D2) <= 2 * ON;
    for (var li = 1; li < lp2.length; li++) {
      var dd = depthOf(lp2[li]);
      if (onTop && Math.abs(dd - D1) > 2 * ON) onTop = false;
      if (onUnder && Math.abs(dd - D2) > 2 * ON) onUnder = false;
    }
    if (onTop) top.push(lp2); else if (onUnder) under.push(lp2);
    else return { ok: false, rim: rim, reason: 'the cut left an opening that is not on the lid\'s planes' };
  }
  if (top.length !== 1 || under.length !== 1) {
    return { ok: false, rim: rim, reason: 'the lid would cross ' + Math.max(top.length, under.length) +
      ' walls of the opening - it has a post or a divider inside within ' + NSO_clFmt(D2) + ' mm of the rim' };
  }
  var e1 = rim.frame.e1, e2 = rim.frame.e2;
  function to2(id) { var p = posOf(id); return [p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]]; }
  var caps = [], areas = [];
  var capSets = [[top[0], 1], [under[0], -1]];
  for (var cs = 0; cs < 2; cs++) {
    var loop = capSets[cs][0], want = capSets[cs][1], p2 = loop.map(to2), A = NSO_clArea2(p2);
    if (A * want <= 0) return { ok: false, rim: rim, reason: 'the lid\'s ' + (want > 0 ? 'top' : 'underside') + ' would face the wrong way' };
    var ears = NSO_clEarClip(p2, want);
    if (!ears) return { ok: false, rim: rim, reason: 'the lid\'s ' + (want > 0 ? 'top' : 'underside') + ' outline could not be filled' };
    ears.forEach(function (e3) { caps.push([loop[e3[0]], loop[e3[1]], loop[e3[2]]]); });
    areas.push(Math.abs(A));
  }
  caps.forEach(function (k3) { outTris.push(k3); });

  // The soup.
  var outSoup = new Float32Array(outTris.length * 9);
  for (var oi = 0; oi < outTris.length; oi++) {
    for (var cc = 0; cc < 3; cc++) {
      var id3 = outTris[oi][cc], o9 = oi * 9 + cc * 3;
      if (id3 < nv0) { outSoup[o9] = P[id3 * 3]; outSoup[o9 + 1] = P[id3 * 3 + 1]; outSoup[o9 + 2] = P[id3 * 3 + 2]; }
      else { var np2 = newPos[id3 - nv0]; outSoup[o9] = np2[0]; outSoup[o9 + 1] = np2[1]; outSoup[o9 + 2] = np2[2]; }
    }
  }
  // Untouched triangles keep their own bits: copy them from the input as-is
  // (the weld maps -0 to 0; the input's own words are what the piece was).
  for (var ui = 0, uo = 0; ui < n; ui++) {
    if (inR[ui]) continue;
    for (var w9 = 0; w9 < 9; w9++) outSoup[uo * 9 + w9] = soup[ui * 9 + w9];
    uo++;
  }

  // THE GATES, on the output soup, welded afresh.
  var G = NSO_teWeld(outSoup), open = 0, nm = 0, flip = 0, degen = 0;
  for (var ge = 0; ge < G.eC.length; ge++) {
    if (G.eC[ge] === 1) open++;
    else if (G.eC[ge] > 2) nm++;
    else {
      var ra = G.eA[ge], rb = G.eB[ge];
      if (G.vid[ra] === G.vid[rb]) flip++;   // the same direction twice
    }
  }
  for (var gd = 0; gd < G.n; gd++) if (G.degen[gd]) degen++;
  if (open || nm || flip || degen) {
    return { ok: false, rim: rim, reason: 'the lid did not close the piece (' + open + ' open, ' + nm + ' non-manifold, ' +
      flip + ' flipped edge(s), ' + degen + ' face(s) without area) - piece unchanged' };
  }
  var vIn = NSO_clVolume(soup), vOut = NSO_clVolume(outSoup), added = vOut - vIn;
  var lo = Math.min(areas[0], areas[1]) * t, hi = Math.max(areas[0], areas[1]) * t;
  if (added < lo * (1 - NSO_CL_VOLUME_TOL) || added > hi * (1 + NSO_CL_VOLUME_TOL)) {
    return { ok: false, rim: rim, reason: 'the lid added ' + NSO_clFmt(added, 3) + ' mm³ where its caps say ' + NSO_clFmt(lo, 3) +
      (hi > lo * 1.0001 ? '-' + NSO_clFmt(hi, 3) : '') + ' - piece unchanged' };
  }
  var where = inset > 0 ? NSO_clFmt(inset) + ' mm below the rim' : 'flush with the rim';
  return {
    ok: true, tris: outSoup, rim: rim,
    reason: 'lid ' + NSO_clFmt(t) + ' mm, ' + where + ', across ' + rim.shape.text,
    lid: { thickness: t, inset: inset, topArea: areas[0], underArea: areas[1], volume: added, topDepth: D1, underDepth: D2 },
    counts: { trisIn: n, trisOut: outTris.length, cut: region.length, capTris: caps.length },
    volume: { before: vIn, after: vOut }
  };
}

function NSO_clVolume(s) {
  var v = 0;
  for (var o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_closeRead: NSO_closeRead, NSO_closeRaw: NSO_closeRaw };
}
