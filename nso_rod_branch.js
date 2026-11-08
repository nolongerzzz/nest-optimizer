// ===================== Rod branch: a cylinder pulled out of a rod's wall =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_rod_branch_test.js) and under a classic script tag in
// the browser, where the Cylinders card's second verb (app-tube-edge.js)
// calls it. docs/TUBE-EDGE.md, "Cylinders → Branch".
//
// BRANCH: a press on the side of a rod is where a branch grows from. The
// branch is a round rod of its own - Ø at its root, Tip Ø at its end (blank:
// the same, a cylinder; less: a shoot that tapers) - standing out of the wall
// Length mm (measured along the branch from the wall), at Angle off the rod's
// axis: 90 straight out, under 90 leaning toward the end the rod's axis was
// read off (its upper end, as Neck reads it), over 90 toward the other. Its
// direction round the rod is the press's own.
//
// THE PARENT is any rod with a flat, round, closed end - the trunk, or a
// branch made here (its tip is such an end), so branches grow off branches.
// Of every closed round end on the piece (Tube edge's face reader, its
// 'closed' kind) the one taken is the one whose axis the press sits round:
// the press behind that end (not on it) and as near its circle's radius as
// any. Two ends of one straight rod (the top and the bottom) read the same
// wall: the higher one is taken, so Angle means the same on either. The
// rod's radius AT THE PRESS is the press's own distance from that axis (a
// tapered branch is thinner there than at its tip's circle).
//
// THE SOLID: a frustum of revolution about the branch's own axis, its root a
// flat disc buried in the parent and its tip a flat disc - which the next
// branch reads its axis off. The root disc sits back along the branch from
// the wall by just enough that the whole disc is inside the parent's
// cylinder (the depth is solved, below), so the junction is closed all round
// and nothing pokes out of the far side of a thin parent. Up to the wall the
// branch keeps its root Ø; from the wall it runs to its Tip Ø. Its rings are
// cut so no chord sags more than NSO_RB_SAG_MM (at least 24, at most 192),
// and from the wall out it is ringed about as often as its facets are wide
// (0.5 - 2 mm apart): near-square facets, so Limb bends it with no needle
// triangles to turn inside out (one facet from the wall to the tip did).
//
// THE UNION is the app's own boolean on the Manifold kernel (nso_csg.js's
// nsoUnionSoups - the plain kernel add, as Fill uses it; NSO_unionSoups, Join's,
// first welds both inputs at 0.08 mm, which collapsed the slivers an earlier
// branch's junction leaves and made the next union non-manifold), so the branch
// is welded to the wall along the curve the two surfaces cross in, and the
// result is one closed solid that Limb reads as a tree: the branch a limb, its
// root the fork.
//
// THE PARENT'S WALL round the junction is subdivided first (nso_densify.js,
// NSO_RB_FINE_MM over the junction's reach + NSO_RB_FINE_MARGIN_MM): a Stock
// rod's wall triangles run its whole length, the union cuts them into slivers
// tens of mm long at the junction, and Limb's own subdivision of its flex
// zone (the same module) then left those with open edges or triangles under
// the slicer's weld. Cut from 0.7 mm triangles, the junction's triangles are
// small, and Limb has nothing there to split (its spacing is 1 mm). BUT that
// subdivision, run on a wall an earlier branch's union already cut, has been
// seen to break it the same way; so the subdivided wall is used only when it
// is provably as clean as the wall it came from - the same open, doubled and
// mis-wound edge counts (Bend's counter) and no more piercing pairs
// (NSO_Repair, the BVH Limb's pierce guard uses) - and the union goes ahead on
// the wall as it was otherwise (plan.fine says which). Without nso_densify.js
// or NSO_Repair the wall goes as it is.
//
// THE GATES, on the output: as many solids as the piece was (the branch
// merged into it, not lying beside it), closed and 2-manifold (Bend's
// counter, NSO_bendTopology), and the volume: it grows, by no more
// than the branch's whole solid and by no less than half of what stands
// outside the wall (the frustum from the wall to the tip) - a branch that did
// not come out of the wall, or one that swallowed the piece, is refused.
//
// REFUSALS, before anything is built, in words, the piece unchanged:
//   - no flat round end anywhere on the piece to read a rod's axis off;
//   - the press on an end face, not the side;
//   - the branch as wide as the rod at the press, or wider;
//   - a root or a tip under 2 nozzle widths across;
//   - Length 0 or less; Angle outside 20° - 160°.
//
// PAINT SCOPE: WHOLE-PIECE - the caller's (app-tube-edge.js), as Neck's.

var NSO_RB_SAG_MM = 0.01;           // chord sag of the branch's round faces
var NSO_RB_MIN_SEG = 24;
var NSO_RB_MAX_SEG = 192;
var NSO_RB_MIN_DEG = 20;            // Angle: off the parent's axis, at least...
var NSO_RB_MAX_DEG = 160;           // ...and at most
var NSO_RB_NOZZLES = 2;             // root and tip: at least 2 nozzle widths across
var NSO_RB_BURY_MM = 0.05;          // the root disc this far inside the parent's wall, all round
var NSO_RB_SAME_LINE_MM = 0.05;     // two ends read the same wall within this
var NSO_RB_MAX_TRIS = 2000000;
var NSO_RB_RING_MIN_MM = 0.5;       // rings along the branch: about as far apart as its facets are wide,
var NSO_RB_RING_MAX_MM = 2;         // ...held between these
var NSO_RB_MAX_RINGS = 400;
var NSO_RB_TIP_RING_MM = 0.75;      // the tip disc's rings: every edge under Limb's 1 mm spacing
var NSO_RB_FINE_MM = 0.7;           // the parent's wall round the junction, subdivided to this before the union...
var NSO_RB_FINE_MARGIN_MM = 2;      // ...over the junction's own reach plus this, when that comes back clean

function NSO_rbFmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
function NSO_rbNozzle(opts) {
  if (opts && typeof opts.nozzle === 'number' && opts.nozzle > 0) return opts.nozzle;
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  return (T && T.NOZZLE_DEFAULT > 0) ? T.NOZZLE_DEFAULT : 0.4;
}

/* =====================================================================
   1. Read the parent: the rod the press is on
   ===================================================================== */

/* The piece's flat, round, closed ends (Tube edge's face reader), welded
   once: { ok, reason, soup, weld, closed: [classed faces], open (how many
   open round ends) }. A hover asks the same piece many questions - read it
   once and hand it back as opts.ends. */
function NSO_rodBranchEnds(soup) {
  var res = { ok: false, reason: '', soup: soup };
  var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  if (!(NSO_teVolume(f32, [0, 0, 0]) > 0)) { res.reason = 'the piece is wound inside out (its volume reads negative) - Repair it first'; return res; }
  var W = NSO_teWeld(f32), FF = NSO_teFaces(W), closed = [], openList = [];
  FF.faces.forEach(function (F) {
    var c = NSO_teClassFace(W, F, FF.region);
    if (c.kind === 'closed' && c.center) closed.push(c);
    else if (c.kind === 'open' && c.center) openList.push(c);
  });
  res.ok = true; res.weld = W; res.closed = closed; res.open = openList.length; res.openList = openList;
  return res;
}

/* opts.point [x, y, z] raw: the press. opts.ends: a NSO_rodBranchEnds of this soup. Returns { ok, reason, ends (how many
   closed round ends the piece has), parent: { center, axis (outward, toward
   the end read), Ro (its end's radius), frame } } and, with a point, at:
   { h (along the axis from the end, <= 0 behind it), r (the rod's radius
   there: the press's distance from the axis), e (the radial direction),
   S (the press on the axis's circle of radius r) }. */
function NSO_rodBranchRead(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '' };
  if (typeof NSO_teWeld !== 'function' || typeof NSO_teClassFace !== 'function') {
    res.reason = 'nso_tube_edge.js must be loaded - Branch reads the rod\'s end with its face reader and carries no copy of it';
    return res;
  }
  if (typeof NSO_sectionClassLoop !== 'function') {
    res.reason = 'nso_section.js must be loaded - the rod\'s end is read with its circle fit and carries no copy of it';
    return res;
  }
  if (!soup || soup.length < 9 || soup.length % 9) { res.reason = 'not a triangle soup'; return res; }
  var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  res.soup = soup;
  var E = opts.ends && opts.ends.soup === soup ? opts.ends : NSO_rodBranchEnds(soup);
  if (!E.ok) { res.reason = E.reason; return res; }
  var tube = !!opts.tube, W = E.weld, closed = tube ? E.openList : E.closed, open = E.open, noun = tube ? 'tube' : 'rod';
  res.weld = W; res.tube = tube;
  res.ends = closed.length;
  if (!closed.length) {
    res.reason = tube
      ? 'Tube branch grows out of a tube, and reads the tube\'s axis off an open, round end (a ring round a bore) - this piece has none' +
        (E.closed.length ? ' (its round end is closed: a solid rod is branched from Shape → Cylinders)' : '')
      : 'Branch grows out of a rod, and reads the rod\'s axis off a flat, round end - this piece has none' +
        (open ? ' (its round end is open: a tube is branched from Shape → Tubes)' : '');
    return res;
  }
  var p = opts.point;
  if (!p) {
    // no press yet: the end standing highest, the bigger on a tie (Neck's pick)
    var top = null;
    closed.forEach(function (c) {
      if (!top || c.center[2] > top.center[2] + 1e-9 || (Math.abs(c.center[2] - top.center[2]) <= 1e-9 && c.Ro > top.Ro)) top = c;
    });
    res.ok = true; res.parent = NSO_rbParent(top);
    res.reason = closed.length + ' round end(s) to grow from - press on the side of a ' + noun + ' where the branch goes';
    return res;
  }
  // every end the press sits behind, scored by how far it is off that end's circle
  var cands = [];
  closed.forEach(function (c) {
    var n = c.face.n, C = c.center, w = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    var h = w[0] * n[0] + w[1] * n[1] + w[2] * n[2];
    var rv = [w[0] - h * n[0], w[1] - h * n[1], w[2] - h * n[2]], r = Math.hypot(rv[0], rv[1], rv[2]);
    cands.push({ c: c, h: h, r: r, rv: rv, score: Math.abs(r - c.Ro), behind: h < -NSO_RB_SAME_LINE_MM });
  });
  var on = cands.filter(function (q) { return Math.abs(q.h) <= NSO_RB_SAME_LINE_MM && q.r <= q.c.Ro + NSO_RB_SAME_LINE_MM; });
  var behind = cands.filter(function (q) { return q.behind; });
  behind.sort(function (x, y) { return x.score - y.score || x.h - y.h; });
  if (on.length && (!behind.length || behind[0].score > NSO_RB_SAME_LINE_MM)) {
    res.reason = 'that is the ' + noun + '\'s ' + (tube ? 'open' : 'flat') + ' end (Ø' + NSO_rbFmt(2 * on[0].c.Ro) + ') - press on its side, where the branch grows out of the wall';
    return res;
  }
  if (!behind.length) { res.reason = 'that press is not on the side of a ' + noun + (tube ? ' with an open, round end' : ' with a flat, round end'); return res; }
  var best = behind[0];
  // the same wall read from the rod's other end: the higher end, so Angle reads one way
  behind.forEach(function (q) {
    if (q === best || Math.abs(q.score - best.score) > NSO_RB_SAME_LINE_MM) return;
    var n0 = best.c.face.n, n1 = q.c.face.n;
    if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] > -0.9999) return;
    if (Math.abs(q.r - best.r) > NSO_RB_SAME_LINE_MM) return;
    if (q.c.center[2] > best.c.center[2] + 1e-6) best = q;
  });
  if (!(best.r > 1e-6)) { res.reason = 'that press is on the ' + noun + '\'s axis, not its side'; return res; }
  // a press on a tube's bore, not its outside: the branch grows out of the outside
  if (tube && best.score > NSO_RB_SAME_LINE_MM && Math.abs(best.r - best.c.Ri) < Math.abs(best.r - best.c.Ro)) {
    res.reason = 'that is the tube\'s bore - press on its outside, where the branch grows out of the wall';
    return res;
  }
  // a straight rod is a polygon: a press on a facet's flat reads up to
  // R (1 - cos(pi / n)) inside its circle - that is the rod's own radius
  var nLoop = best.c.loops && best.c.loops[0] ? best.c.loops[0].v.length : 0;
  if (nLoop >= 12 && best.r >= best.c.Ro * Math.cos(Math.PI / nLoop) - NSO_RB_SAME_LINE_MM / 2 && best.r <= best.c.Ro + NSO_RB_SAME_LINE_MM / 2) {
    best.r = best.c.Ro; best.score = 0;
  }
  var par = NSO_rbParent(best.c), a = par.axis, C = par.center;
  var rl = Math.hypot(best.rv[0], best.rv[1], best.rv[2]), e = [best.rv[0] / rl, best.rv[1] / rl, best.rv[2] / rl];
  res.ok = true; res.parent = par;
  res.at = { h: best.h, r: best.r, e: e, offMm: best.score,
             S: [C[0] + best.h * a[0] + best.r * e[0], C[1] + best.h * a[1] + best.r * e[1], C[2] + best.h * a[2] + best.r * e[2]] };
  // a tube's bore at the press: its wall carried from the end (a taper keeps the wall)
  if (tube) res.at.ri = best.r - (par.Ro - par.Ri);
  res.reason = 'on a Ø' + NSO_rbFmt(2 * best.r) + (tube ? ' / bore Ø' + NSO_rbFmt(2 * res.at.ri) + ' tube, ' : ' rod, ') +
    NSO_rbFmt(-best.h) + ' mm in from its Ø' + NSO_rbFmt(2 * par.Ro) + ' end';
  return res;
}
function NSO_rbParent(c) {
  return { center: c.center, axis: c.face.n, Ro: c.Ro, Ri: c.Ri || 0, open: c.kind === 'open', frame: c.frame || NSO_teFrame(c.face.n) };
}

/* LIMB ON A ROD (nso_limb.js, opts.hint). Limb finds a limb by walking the
   surface from the piece's foot, and round a fat or slanted junction that
   reading skews: its bone leans off the rod's axis and its fork's loop is
   ragged, so even a straight Extend sheared the junction. On a rod with a
   flat, round tip - every branch Branch makes, and the trunk - the answer is
   exact, and this is it: the rod the grab is on (NSO_rodBranchRead), its
   axis the bone, and the HINGE a millimetre past the last place, going down
   from the grab, where the surface within the rod's radius stops being the
   rod's own (a triangle whose face is not the rod's - square-ish to its
   radius, at the radius the rod has there: straight, or the taper from its
   tip to the grab). Between the hinge and the grab the flex zone is clean
   rod. Returns { ok, reason, axis (toward the tip), center (the tip's),
   hGrab, hHinge (along the axis from the tip, <= 0), radius }. */
var NSO_RB_HINGE_MM = 1;            // the hinge, this far past the junction
function NSO_rodLimbHint(soup, point, ends) {
  // a rod (flat tip) or a tube (open tip, Tubes → Branch's): whichever's wall the grab sits on more nearly
  var rr = NSO_rodBranchRead(soup, { point: point, ends: ends }), rt = NSO_rodBranchRead(soup, { point: point, ends: ends, tube: true });
  var rd = rr.ok && rr.at && (!(rt.ok && rt.at) || rr.at.offMm <= rt.at.offMm) ? rr : rt;
  if (!rd.ok || !rd.at) return { ok: false, reason: rr.reason || rt.reason || 'not on a rod' };
  var W = rd.weld, P = W.P, a = rd.parent.axis, C = rd.parent.center, hG = rd.at.h, rG = rd.at.r, Ro = rd.parent.Ro;
  var wall = rd.tube ? rd.parent.Ro - rd.parent.Ri : 0;      // a tube's bore is the rod's own face too, a wall in
  function R(h) { return hG < -1e-9 ? Ro + (rG - Ro) * h / hG : rG; }     // the rod's radius at h: tip to grab, run on
  var top = -Infinity;
  for (var t = 0; t < W.n; t++) {
    if (W.degen[t]) continue;
    var i0 = W.vid[t * 3] * 3, i1 = W.vid[t * 3 + 1] * 3, i2 = W.vid[t * 3 + 2] * 3;
    var cx = (P[i0] + P[i1] + P[i2]) / 3 - C[0], cy = (P[i0 + 1] + P[i1 + 1] + P[i2 + 1]) / 3 - C[1], cz = (P[i0 + 2] + P[i1 + 2] + P[i2 + 2]) / 3 - C[2];
    var h = cx * a[0] + cy * a[1] + cz * a[2];
    if (!(h < hG)) continue;
    var ex = cx - h * a[0], ey = cy - h * a[1], ez = cz - h * a[2], r = Math.hypot(ex, ey, ez), Rh = R(h);
    if (r > Rh + 1.5) continue;                                          // off the rod: the parent beyond it
    var nr = r > 1e-9 ? (W.N[t * 3] * ex + W.N[t * 3 + 1] * ey + W.N[t * 3 + 2] * ez) / r : 0;
    if (nr >= 0.9 && Math.abs(r - Rh) <= Math.max(0.05, 0.03 * Rh)) continue;   // the rod's own face
    if (wall > 0 && nr <= -0.9 && Math.abs(r - (Rh - wall)) <= Math.max(0.05, 0.03 * Rh)) continue;   // a tube's bore
    [i0, i1, i2].forEach(function (o) {
      var hv = (P[o] - C[0]) * a[0] + (P[o + 1] - C[1]) * a[1] + (P[o + 2] - C[2]) * a[2];
      if (hv < hG && hv > top) top = hv;
    });
  }
  if (!isFinite(top)) return { ok: false, reason: 'no end to the rod below the grab' };
  return { ok: true, axis: a, center: C, hGrab: hG, hHinge: top + NSO_RB_HINGE_MM, radius: rG, tipR: Ro, tube: !!rd.tube };
}

/* =====================================================================
   2. The branch: its axis, its depth and its solid
   ===================================================================== */

/* How deep the root disc goes: the branch leaves the parent's wall (radius r)
   at angle A off the parent's axis; a disc of radius rb square to it, its
   centre e back along the branch, has its rim at
       x = (r - e sin A) + rb cos A cos t,   y = rb sin t      (x radial, y round)
   and is wholly inside radius r - bury when the farthest rim point is.
   The least such e, by bisection between the wall (e = 0) and the axis
   (e = r / sin A, the disc centred on it, where the rim is nearest); NaN when
   even there the rim reaches the wall (a branch too wide for its angle). */
function NSO_rbDepth(r, rb, A, bury, rLim) {
  var sA = Math.sin(A), cA = Math.cos(A), lim = (rLim == null ? r : rLim) - bury;
  function far(e) {
    var X = r - e * sA, best = 0;
    for (var k = 0; k < 360; k++) {
      var t = Math.PI * k / 180, x = X + rb * cA * Math.cos(t), y = rb * Math.sin(t);
      var d = x * x + y * y; if (d > best) best = d;
    }
    return Math.sqrt(best);
  }
  var hi = r / sA;
  if (far(hi) > lim) return NaN;
  var lo = 0;
  for (var i = 0; i < 60; i++) { var mid = (lo + hi) / 2; if (far(mid) > lim) lo = mid; else hi = mid; }
  return hi;
}

/* How many separate solids a soup is: its triangles joined across edges whose
   two ends weld bit for bit (NSO_teWeld). */
function NSO_rbShells(f32) {
  var W = NSO_teWeld(f32), n = W.n, par = new Int32Array(n);
  for (var i = 0; i < n; i++) par[i] = i;
  function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
  for (var t = 0; t < n; t++) for (var k = 0; k < 3; k++) {
    var r = t * 3 + k, id = W.cornerEdge[r], o = W.eA[id] === r ? W.eB[id] : W.eA[id];
    if (o >= 0) { var a = find(t), b = find((o / 3) | 0); if (a !== b) par[a] = b; }
  }
  var c = 0;
  for (var q = 0; q < n; q++) if (find(q) === q) c++;
  return c;
}

/* A frustum of revolution as a closed soup, wound outward: about the axis d
   from the root centre B, the profile [[t, radius], ...] (t along d; the
   first and last are the flat ends). n segments, frame (u, v) square to d. */
function NSO_rbRevolve(B, d, u, v, prof, n, phase, tipStep) {
  var out = [], ring = [];
  for (var i = 0; i < prof.length; i++) {
    var t = prof[i][0], rr = prof[i][1], R = [];
    for (var j = 0; j < n; j++) {
      var th = 2 * Math.PI * (j + (phase || 0)) / n, cs = Math.cos(th) * rr, sn = Math.sin(th) * rr;
      R.push([B[0] + t * d[0] + cs * u[0] + sn * v[0], B[1] + t * d[1] + cs * u[1] + sn * v[1], B[2] + t * d[2] + cs * u[2] + sn * v[2]]);
    }
    ring.push(R);
  }
  function push(P, Q, Rr) { out.push(P[0], P[1], P[2], Q[0], Q[1], Q[2], Rr[0], Rr[1], Rr[2]); }
  // the sides: ring i to ring i+1, outward with u x v = d
  for (var i2 = 0; i2 + 1 < ring.length; i2++) {
    for (var j2 = 0; j2 < n; j2++) {
      var j3 = (j2 + 1) % n, A0 = ring[i2][j2], A1 = ring[i2][j3], B0 = ring[i2 + 1][j2], B1 = ring[i2 + 1][j3];
      push(A0, A1, B1); push(A0, B1, B0);
    }
  }
  // the two discs. The root (buried: the union takes it out) a fan from its
  // centre, facing back along d. The TIP in concentric rings (tipStep apart),
  // facing on along d: a fan of rim-to-centre needles is what Limb's
  // subdivision would split (and nso_densify.js's needle zip has broken), so
  // every tip edge stays under its spacing; the rim is still one round loop,
  // so the tip still reads as a flat, round end for the next branch.
  var c0 = [B[0] + prof[0][0] * d[0], B[1] + prof[0][0] * d[1], B[2] + prof[0][0] * d[2]], L = prof.length - 1;
  var c1 = [B[0] + prof[L][0] * d[0], B[1] + prof[L][0] * d[1], B[2] + prof[L][0] * d[2]];
  for (var k = 0; k < n; k++) push(c0, ring[0][(k + 1) % n], ring[0][k]);
  var rT = prof[L][1], K = Math.max(1, Math.ceil(rT / (tipStep || rT))), disc = [ring[L]];
  for (var q = 1; q < K; q++) {
    var rq = rT * (K - q) / K, Rq = [];
    for (var j4 = 0; j4 < n; j4++) {
      var th4 = 2 * Math.PI * (j4 + (phase || 0)) / n, c4 = Math.cos(th4) * rq, s4 = Math.sin(th4) * rq;
      Rq.push([c1[0] + c4 * u[0] + s4 * v[0], c1[1] + c4 * u[1] + s4 * v[1], c1[2] + c4 * u[2] + s4 * v[2]]);
    }
    disc.push(Rq);
  }
  for (var q2 = 0; q2 + 1 < disc.length; q2++) {
    for (var j5 = 0; j5 < n; j5++) {
      var j6 = (j5 + 1) % n, O0 = disc[q2][j5], O1 = disc[q2][j6], I0 = disc[q2 + 1][j5], I1 = disc[q2 + 1][j6];
      push(O0, O1, I1); push(O0, I1, I0);
    }
  }
  var inner = disc[disc.length - 1];
  for (var k2 = 0; k2 < n; k2++) push(c1, inner[k2], inner[(k2 + 1) % n]);
  return new Float32Array(out);
}

/* opts: point (raw, the press), dia (root Ø, mm), tipDia (blank: dia),
   length (mm out of the wall, along the branch), angle (° off the parent's
   axis: 90 square out; less leans toward the end read), nozzle, read (a
   NSO_rodBranchRead of this soup at this point).
   Returns { ok, reason, read, branch: { soup, root, wall, tip, dir, rootR,
   tipR, depthMm, segments, volumeMm3, outsideMm3 }, ... } - no union. */
function NSO_rodBranchPlan(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: 'branch' };
  if (!opts.point) { res.reason = 'press on the side of the rod where the branch grows out, and drag it out'; return res; }
  var tube = !!opts.tube;
  var rd = opts.read && opts.read.ok && opts.read.soup === soup && opts.read.at && opts.read.pointKey === String(opts.point) && !!opts.read.tube === tube ? opts.read
         : NSO_rodBranchRead(soup, { point: opts.point, tube: tube });
  rd.pointKey = String(opts.point);
  res.read = rd;
  if (!rd.ok) { res.reason = rd.reason; return res; }
  var nozzle = NSO_rbNozzle(opts), at = rd.at, par = rd.parent, r = at.r;
  res.nozzleMm = nozzle;
  var dia = +opts.dia, tip = (opts.tipDia == null || opts.tipDia === '') ? dia : +opts.tipDia, L = +opts.length, deg = +opts.angle;
  if (opts.dia == null || opts.dia === '' || !(dia > 0) || !isFinite(dia)) { res.reason = 'enter the branch\'s Ø in mm, more than 0'; return res; }
  if (!(tip > 0) || !isFinite(tip)) { res.reason = 'enter the branch\'s tip Ø in mm, more than 0 (blank: the same as its Ø)'; return res; }
  if (opts.length == null || opts.length === '' || !(L > 0) || !isFinite(L)) { res.reason = 'enter how far the branch stands out of the wall, in mm, more than 0'; return res; }
  if (opts.angle == null || opts.angle === '' || !isFinite(deg)) { res.reason = 'enter the branch\'s angle off the rod, in degrees (90: straight out)'; return res; }
  if (deg < NSO_RB_MIN_DEG - 1e-9 || deg > NSO_RB_MAX_DEG + 1e-9) {
    res.reason = 'an angle of ' + NSO_rbFmt(deg, 1) + '° off the rod - a branch stands ' + NSO_RB_MIN_DEG + '° to ' + NSO_RB_MAX_DEG +
      '° off it (90: straight out; under 90 it leans toward the rod\'s upper end, over 90 away)';
    return res;
  }
  var floor = NSO_RB_NOZZLES * nozzle;
  if (dia < floor - 1e-9 || tip < floor - 1e-9) {
    res.reason = 'a Ø' + NSO_rbFmt(Math.min(dia, tip)) + ' ' + (tip < dia ? 'tip' : 'branch') + ' is under ' + NSO_rbFmt(floor) + ' mm across (' +
      NSO_RB_NOZZLES + ' nozzle widths at a ' + NSO_rbFmt(nozzle, 1) + ' mm nozzle)';
    return res;
  }
  var noun = tube ? 'tube' : 'rod';
  if (!(dia < 2 * r - 2 * NSO_RB_BURY_MM)) {
    res.reason = 'a Ø' + NSO_rbFmt(dia) + ' branch is as wide as the ' + noun + ' it would grow from (Ø' + NSO_rbFmt(2 * r) + ' there) or wider - ' +
      'a branch is narrower than its ' + noun + ': Ø' + NSO_rbFmt(Math.floor((2 * r - 2 * NSO_RB_BURY_MM - 0.005) * 100) / 100) + ' at most here';
    return res;
  }
  // A TUBE's branch is a tube: its bore (opts.boreDia, at the wall) runs into the parent's
  var bore = null, ri = tube ? at.ri : 0;
  if (tube) {
    bore = +opts.boreDia;
    if (opts.boreDia == null || opts.boreDia === '' || !(bore > 0) || !isFinite(bore)) { res.reason = 'enter the branch\'s bore Ø in mm, more than 0'; return res; }
    var wallFloor = (typeof NSO_teFloor === 'function' && NSO_teFloor(nozzle)) || NSO_RB_NOZZLES * nozzle;
    var wallB = (dia - bore) / 2;
    if (!(wallB >= wallFloor - 1e-9)) {
      res.reason = 'a Ø' + NSO_rbFmt(dia) + ' branch with a Ø' + NSO_rbFmt(bore) + ' bore has a ' + NSO_rbFmt(Math.max(0, wallB)) + ' mm wall - under the ' +
        NSO_rbFmt(wallFloor) + ' mm floor (nso_thickness.js, a ' + NSO_rbFmt(nozzle, 1) + ' mm nozzle): its bore is Ø' + NSO_rbFmt(dia - 2 * wallFloor) + ' at most';
      return res;
    }
    if (tip - (dia - bore) < NSO_RB_NOZZLES * nozzle - 1e-9) {
      res.reason = 'a Ø' + NSO_rbFmt(tip) + ' tip keeping the ' + NSO_rbFmt(wallB) + ' mm wall leaves a Ø' + NSO_rbFmt(Math.max(0, tip - (dia - bore))) +
        ' bore there - under ' + NSO_rbFmt(NSO_RB_NOZZLES * nozzle) + ' mm across: make the tip wider';
      return res;
    }
    if (!(bore < 2 * ri - 2 * NSO_RB_BURY_MM)) {
      res.reason = 'a Ø' + NSO_rbFmt(bore) + ' bore is as wide as the tube\'s own (Ø' + NSO_rbFmt(2 * ri) + ' there) or wider - its foot would cut the far wall: Ø' +
        NSO_rbFmt(Math.floor((2 * ri - 2 * NSO_RB_BURY_MM - 0.005) * 100) / 100) + ' at most here';
      return res;
    }
  }
  var A = deg * Math.PI / 180, a = par.axis, e = at.e;
  var d = [Math.cos(A) * a[0] + Math.sin(A) * e[0], Math.cos(A) * a[1] + Math.sin(A) * e[1], Math.cos(A) * a[2] + Math.sin(A) * e[2]];
  // the branch's frame: u in the plane of the axis and d (square to d), v = d x u
  var u = [Math.cos(A) * e[0] - Math.sin(A) * a[0], Math.cos(A) * e[1] - Math.sin(A) * a[1], Math.cos(A) * e[2] - Math.sin(A) * a[2]];
  u = [-u[0], -u[1], -u[2]];
  var v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  var rb = dia / 2, rt = tip / 2, depth = NSO_rbDepth(r, rb, A, NSO_RB_BURY_MM), S = at.S;
  if (!isFinite(depth)) {
    res.reason = 'a Ø' + NSO_rbFmt(dia) + ' branch at ' + NSO_rbFmt(deg, 0) + '° is too wide to root in a Ø' + NSO_rbFmt(2 * r) +
      ' rod - its foot, square to it, would show through the wall: make it narrower, or stand it nearer 90°';
    return res;
  }
  var Bc = [S[0] - depth * d[0], S[1] - depth * d[1], S[2] - depth * d[2]];
  var rMax = Math.max(rb, rt), n = Math.round(Math.PI / Math.acos(1 - NSO_RB_SAG_MM / Math.max(rMax, 2 * NSO_RB_SAG_MM)));
  n = Math.max(NSO_RB_MIN_SEG, Math.min(NSO_RB_MAX_SEG, Math.ceil(n / 4) * 4));
  var prof = [[0, rb], [depth, rb]], chord = 2 * Math.PI * Math.min(rb, rt) / n;
  var step = Math.max(NSO_RB_RING_MIN_MM, Math.min(NSO_RB_RING_MAX_MM, chord));
  var nr = Math.max(1, Math.min(NSO_RB_MAX_RINGS, Math.ceil(L / step)));
  for (var q = 1; q <= nr; q++) prof.push([depth + L * q / nr, rb + (rt - rb) * q / nr]);
  // the facets turned off the press's own meridian (by opts.phase of a facet,
  // half by default): a branch vertex on that plane lies on the parent's own
  // vertex column when the press is (a Stock rod pressed at 0°, 120°, 240°),
  // and the kernel answers that exact touch with a doubled edge
  var phase = opts.phase == null ? 0.5 : +opts.phase;
  var bsoup = NSO_rbRevolve(Bc, d, u, v, prof, n, phase, tube ? null : NSO_RB_TIP_RING_MM);
  var tubeParts = null;
  if (tube) {
    // the BORE: a frustum rooted inside the parent's bore (its whole root disc
    // there, so it cuts only the near wall) and run 1 mm past the tip, ringed
    // as the outside is, facet for facet; the tip keeps the wall
    var rib = bore / 2, rit = rt - (rb - rib), dB = NSO_rbDepth(r, rib, A, NSO_RB_BURY_MM, ri);
    if (!isFinite(dB)) {
      res.reason = 'a Ø' + NSO_rbFmt(bore) + ' bore at ' + NSO_rbFmt(deg, 0) + '° does not fit inside the Ø' + NSO_rbFmt(2 * ri) +
        ' bore it would open into - its foot would cut the far wall: make it narrower, or stand it nearer 90°';
      return res;
    }
    var Bb = [S[0] - dB * d[0], S[1] - dB * d[1], S[2] - dB * d[2]], pb = [[0, rib], [dB, rib]], slope = (rit - rib) / L;
    // (no ring on the tip's plane: one there lies on the tip face, and the
    // kernel answers that exact touch with doubled edges - the last stretch
    // runs straight through it, out past the tip)
    for (var qb = 1; qb < nr; qb++) pb.push([dB + L * qb / nr, rib + (rit - rib) * qb / nr]);
    pb.push([dB + L + 1, rit + slope]);
    // the TRIM: the parent's bore, 0.02 mm wider (so no face of it lies on the
    // parent's), along the parent's axis over the junction - taken out of the
    // branch's outside first, so the branch fills nothing inside the bore
    var hS = at.h, half = depth + rb + 2, rTrim = ri + 0.02, a0 = par.axis, C0 = par.center;
    var Ta = [C0[0] + (hS - half) * a0[0], C0[1] + (hS - half) * a0[1], C0[2] + (hS - half) * a0[2]];
    var tf = NSO_teFrame(a0);
    tubeParts = {
      bore: NSO_rbRevolve(Bb, d, u, v, pb, n, phase, null),
      trim: NSO_rbRevolve(Ta, a0, tf.e1, tf.e2, [[0, rTrim], [2 * half, rTrim]], NSO_RB_MAX_SEG, 0.5, null),
      boreR: rib, boreTipR: rit, boreDepthMm: dB, parentBoreR: ri, wallMm: rb - rib
    };
  }
  var pf = n * Math.sin(2 * Math.PI / n) / (2 * Math.PI);
  var outside = pf * Math.PI * L * (rb * rb + rb * rt + rt * rt) / 3, whole = outside + pf * Math.PI * rb * rb * depth;
  var T = [S[0] + L * d[0], S[1] + L * d[1], S[2] + L * d[2]];
  if (tubeParts) outside -= pf * Math.PI * L * (tubeParts.boreR * tubeParts.boreR + tubeParts.boreR * tubeParts.boreTipR + tubeParts.boreTipR * tubeParts.boreTipR) / 3;
  res.branch = { tube: tubeParts, phase: phase, soup: bsoup, root: Bc, wall: S, tip: T, dir: d, u: u, v: v, rootR: rb, tipR: rt, depthMm: depth, segments: n, rings: nr,
                 volumeMm3: whole, outsideMm3: outside, lengthMm: L, angleDeg: deg, parentR: r };
  res.ok = true;
  res.reason = NSO_rodBranchDescribe(res);
  return res;
}

/* One line: "Branch Ø7.50 → Ø5.00 tip, 30.0 mm out at 45° off a Ø30.84 rod, 20.00 mm in from its end". */
function NSO_rodBranchDescribe(r) {
  var b = r.branch, at = r.read.at, tb = b.tube;
  if (tb) {
    return 'Tube branch Ø' + NSO_rbFmt(2 * b.rootR) + ' / bore Ø' + NSO_rbFmt(2 * tb.boreR) + ' (wall ' + NSO_rbFmt(tb.wallMm) + ')' +
      (Math.abs(b.tipR - b.rootR) > 1e-9 ? ' → Ø' + NSO_rbFmt(2 * b.tipR) + ' tip' : '') + ', ' + NSO_rbFmt(b.lengthMm, 1) + ' mm out at ' +
      NSO_rbFmt(b.angleDeg, 0) + '° off a Ø' + NSO_rbFmt(2 * b.parentR) + ' / Ø' + NSO_rbFmt(2 * tb.parentBoreR) + ' tube, ' + NSO_rbFmt(-at.h) + ' mm in from its end';
  }
  return 'Branch Ø' + NSO_rbFmt(2 * b.rootR) + (Math.abs(b.tipR - b.rootR) > 1e-9 ? ' → Ø' + NSO_rbFmt(2 * b.tipR) + ' tip' : '') + ', ' +
    NSO_rbFmt(b.lengthMm, 1) + ' mm out at ' + NSO_rbFmt(b.angleDeg, 0) + '° off a Ø' + NSO_rbFmt(2 * b.parentR) + ' rod, ' +
    NSO_rbFmt(-at.h) + ' mm in from its end';
}

/* =====================================================================
   3. The branch, welded on
   ===================================================================== */

/* The parent with its wall round the junction subdivided, or the parent as
   it was when that is not provably as clean (see the header). */
function NSO_rbFineHost(f32, b) {
  var DZ = (typeof NSO_Densify !== 'undefined') ? NSO_Densify : null;
  var RP = (typeof NSO_Repair !== 'undefined' && NSO_Repair._selfIntersectionDetail) ? NSO_Repair : null;
  if (!DZ || typeof DZ.region !== 'function' || !RP || typeof NSO_bendTopology !== 'function') return f32;
  var A = b.angleDeg * Math.PI / 180, reach = b.rootR / Math.sin(A) + b.rootR + NSO_RB_FINE_MARGIN_MM;
  var reg;
  try { reg = DZ.region(f32, { c: b.wall, r: reach }, { spacing: NSO_RB_FINE_MM }); } catch (e) { return f32; }
  if (!reg || !reg.ok || !reg.changed) return f32;
  // a wall an earlier union cut is slivers, and bisecting slivers balloons
  // (27,000 triangles became 115,000 round one tube branch): not this way
  if (reg.mesh.triCount > 2 * (f32.length / 9) + 20000) return f32;
  var fine = DZ.toSoup(reg.mesh), T0 = NSO_bendTopology(f32), T1 = NSO_bendTopology(fine);
  if (T1.open !== T0.open || T1.nm !== T0.nm || T1.flip !== T0.flip || T1.euler !== T0.euler) return f32;
  // piercing pairs, counted only near the junction (nothing else moved)
  var c = b.wall, r2 = (reach + 3) * (reach + 3);
  function near(s) {
    var o = [];
    for (var i = 0; i < s.length; i += 9) {
      var x = (s[i] + s[i + 3] + s[i + 6]) / 3 - c[0], y = (s[i + 1] + s[i + 4] + s[i + 7]) / 3 - c[1], z = (s[i + 2] + s[i + 5] + s[i + 8]) / 3 - c[2];
      if (x * x + y * y + z * z <= r2) for (var k = 0; k < 9; k++) o.push(s[i + k]);
    }
    return new Float32Array(o);
  }
  function pierce(s) { var m = DZ.weld(s, 1e-9); return RP._selfIntersectionDetail({ pos: m.pos, faces: m.tri }).pierce; }
  return pierce(near(fine)) <= pierce(near(f32)) ? fine : f32;
}

/* The welded piece as the canonical checker counts it (tools/mesh_validate.py
   welds at 1e-4 mm): open, doubled and mis-wound edges, and triangles that
   weld collapses. The kernel can leave two vertices closer than that which
   are not one: exactly closed, but not to a slicer. */
function NSO_rbSlicerTopology(s) {
  var DZ = (typeof NSO_Densify !== 'undefined') ? NSO_Densify : null;
  if (!DZ) return null;
  var m = DZ.weld(s, 1e-4), tri = m.tri, nv = m.vertCount, E = new Map();
  for (var t = 0; t < m.triCount; t++) for (var k = 0; k < 3; k++) {
    var a = tri[t * 3 + k], b = tri[t * 3 + (k + 1) % 3], key = a < b ? a * nv + b : b * nv + a, e = E.get(key);
    if (!e) { e = [0, 0]; E.set(key, e); }
    e[0]++; if (a < b) e[1]++;
  }
  var open = 0, nm = 0, flip = 0;
  E.forEach(function (e) { if (e[0] === 1) open++; else if (e[0] > 2) nm++; else if (e[1] !== 1) flip++; });
  return { open: open, nm: nm, flip: flip, dropped: ((s.length / 9) | 0) - m.triCount };
}
function NSO_rbSlicerBad(s) {
  var T = NSO_rbSlicerTopology(s);
  return T && (T.open || T.nm || T.flip || T.dropped) ? T : null;
}
/* A kernel result with triangles thinner than that weld (an edge under 1e-4
   mm), and nothing else wrong at it: welded as a slicer would weld it - those
   vertices merged, those triangles dropped, no vertex moved 0.1 µm - which is
   closed exactly. Anything else at that weld: null (the caller retries). */
function NSO_rbSlicerClean(s) {
  var T = NSO_rbSlicerTopology(s);
  if (!T || !T.dropped) return s;
  if (T.open || T.nm || T.flip) return null;
  return NSO_Densify.toSoup(NSO_Densify.weld(s, 1e-4));
}

/* As NSO_rodBranchPlan, then the union (opts.union: a function (a, b) ->
   Promise of { ok, soup, reason }; the app's nsoUnionSoups when not given)
   and the gates. Promise of { ok, reason, tris, branch, counts,
   volume, topology }. */
var NSO_RB_PHASES = [0.5, 0.27, 0.73];   // the facets' turn, a try at a time (see the plan)
function NSO_rodBranchRaw(soup, opts) {
  opts = opts || {};
  var tries = opts.phase != null ? [+opts.phase] : NSO_RB_PHASES, k = 0;
  function attempt() {
    var o = {};
    for (var key in opts) o[key] = opts[key];
    o.phase = tries[k];
    return NSO_rbWeld(soup, o).then(function (r) {
      // a kernel answer that is not one clean solid: the facets turned, once more
      if (!r.ok && r.retry && ++k < tries.length) return attempt();
      if (r) r.tries = k + 1;
      return r;
    });
  }
  return attempt();
}
function NSO_rbWeld(soup, opts) {
  var plan = NSO_rodBranchPlan(soup, opts);
  if (!plan.ok) return Promise.resolve(plan);
  if (plan.branch.tube) return NSO_rbWeldTube(soup, opts, plan);
  var union = opts.union || (typeof nsoUnionSoups === 'function' ? nsoUnionSoups : null);
  if (!union) { plan.ok = false; plan.reason = 'nso_csg.js must be loaded - the branch is welded on with the app\'s boolean'; return Promise.resolve(plan); }
  var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup), b = plan.branch;
  var host = NSO_rbFineHost(f32, b);
  plan.fine = host !== f32;
  return Promise.resolve(union(host, b.soup, { label: 'Branch' })).then(function (u) {
    var res = plan;
    res.tris = soup;
    res.ok = false;
    if (!u || !u.ok || !u.soup) {
      res.reason = 'the boolean refused the branch' + (u && u.reason ? ' (' + u.reason + ')' : '');
      if (u && u.cancelled) res.cancelled = true;
      return res;
    }
    var out = NSO_rbSlicerClean((u.soup instanceof Float32Array) ? u.soup : new Float32Array(u.soup));
    if (!out) { res.reason = 'internal: the welded piece has edges a slicer\'s weld (1e-4 mm) would double or open'; res.retry = true; return res; }
    res.counts = { trisIn: f32.length / 9, trisOut: out.length / 9, branchTris: b.soup.length / 9, parts: u.parts };
    if (res.counts.trisOut > NSO_RB_MAX_TRIS) { res.reason = 'the result would have ' + res.counts.trisOut + ' triangles, past the ' + NSO_RB_MAX_TRIS + ' limit'; return res; }
    var sh0 = NSO_rbShells(f32), sh1 = NSO_rbShells(out);
    res.shells = { before: sh0, after: sh1 };
    if (sh1 !== sh0) {
      res.reason = sh1 > sh0 ? 'the branch did not join the rod - it would lie beside it as a solid of its own'
                             : 'internal: the piece went from ' + sh0 + ' solid(s) to ' + sh1;
      return res;
    }
    if (typeof NSO_bendTopology === 'function') {
      var T1 = NSO_bendTopology(out);
      res.topology = T1;
      if (T1.open || T1.nm) { res.reason = 'internal: the welded piece is not closed (open ' + T1.open + ', non-manifold ' + T1.nm + ')'; res.retry = true; return res; }
    }
    var bad = NSO_rbSlicerBad(out);
    if (bad) { res.reason = 'internal: the welded piece has vertices closer than a slicer\'s weld (at 1e-4 mm: open ' + bad.open + ', doubled ' + bad.nm + ', collapsed ' + bad.dropped + ')'; res.retry = true; return res; }
    var v0 = NSO_teVolume(f32, b.wall), v1 = NSO_teVolume(out, b.wall), dv = v1 - v0;
    res.volume = { before: v0, after: v1, change: dv, branch: b.volumeMm3, outside: b.outsideMm3 };
    if (!(dv >= 0.5 * b.outsideMm3 && dv <= b.volumeMm3 * 1.005 + 1e-3)) {
      res.reason = 'internal: the piece grew by ' + NSO_rbFmt(dv, 1) + ' mm³ - a branch adds between ' + NSO_rbFmt(0.5 * b.outsideMm3, 1) +
        ' and ' + NSO_rbFmt(b.volumeMm3, 1) + ' mm³ (half what stands out of the wall, and its whole solid)';
      return res;
    }
    res.ok = true;
    res.tris = out;
    res.reason = NSO_rodBranchDescribe(res);
    return res;
  });
}

/* A TUBE's branch, welded on in three booleans: the branch's outside less the
   trim (so it fills nothing inside the parent's bore), that added to the tube,
   and the branch's bore taken out (it cuts the near wall, opening the branch
   into the parent's bore, and runs out past the tip). opts.subtract: a function
   (a, b) -> Promise of { ok, soup, reason }; the app's nsoSubtractSoups when
   not given. THE GATES: one solid as before, closed and 2-manifold, and its
   Euler characteristic down by exactly 2 - one more handle: the branch's bore
   joins the parent's and opens at the tip (a bore blind at either end would
   leave it as it was) - and the volume grown, by no more than the branch's
   wall standing out of the parent. */
function NSO_rbWeldTube(soup, opts, plan) {
  var union = opts.union || (typeof nsoUnionSoups === 'function' ? nsoUnionSoups : null);
  var subtract = opts.subtract || (typeof nsoSubtractSoups === 'function' ? nsoSubtractSoups : null);
  if (!union || !subtract) { plan.ok = false; plan.reason = 'nso_csg.js must be loaded - the branch is welded on with the app\'s boolean'; return Promise.resolve(plan); }
  var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup), b = plan.branch, tb = b.tube;
  var host = NSO_rbFineHost(f32, b);
  plan.fine = host !== f32;
  var res = plan;
  res.tris = soup; res.ok = false;
  function refused(step, u) {
    res.reason = 'the boolean refused the branch at its ' + step + (u && u.reason ? ' (' + u.reason + ')' : '');
    if (u && u.cancelled) res.cancelled = true;
    return res;
  }
  function soupOf(u) { return (u.soup instanceof Float32Array) ? u.soup : new Float32Array(u.soup); }
  return Promise.resolve(subtract(b.soup, tb.trim, { label: 'Tube branch' })).then(function (u1) {
    if (!u1 || !u1.ok || !u1.soup) return refused('trim', u1);
    return Promise.resolve(union(host, soupOf(u1), { label: 'Tube branch' })).then(function (u2) {
      if (!u2 || !u2.ok || !u2.soup) return refused('weld', u2);
      return Promise.resolve(subtract(soupOf(u2), tb.bore, { label: 'Tube branch' })).then(function (u3) {
        if (!u3 || !u3.ok || !u3.soup) return refused('bore', u3);
        var out = NSO_rbSlicerClean(soupOf(u3));
        if (!out) { res.reason = 'internal: the welded piece has edges a slicer\'s weld (1e-4 mm) would double or open'; res.retry = true; return res; }
        res.counts = { trisIn: f32.length / 9, trisOut: out.length / 9, branchTris: b.soup.length / 9 };
        if (res.counts.trisOut > NSO_RB_MAX_TRIS) { res.reason = 'the result would have ' + res.counts.trisOut + ' triangles, past the ' + NSO_RB_MAX_TRIS + ' limit'; return res; }
        var sh0 = NSO_rbShells(f32), sh1 = NSO_rbShells(out);
        res.shells = { before: sh0, after: sh1 };
        if (sh1 !== sh0) {
          res.reason = sh1 > sh0 ? 'the branch did not join the tube - it would lie beside it as a solid of its own' : 'internal: the piece went from ' + sh0 + ' solid(s) to ' + sh1;
          return res;
        }
        if (typeof NSO_bendTopology === 'function') {
          var T0 = NSO_bendTopology(f32), T1 = NSO_bendTopology(out);
          res.topology = { before: T0, after: T1 };
          if (T1.open || T1.nm) { res.reason = 'internal: the welded piece is not closed (open ' + T1.open + ', non-manifold ' + T1.nm + ')'; res.retry = true; return res; }
          if (T1.euler !== T0.euler - 2) {
            res.reason = 'internal: the branch\'s bore did not open through - from the tube\'s bore out to its tip (Euler ' + T0.euler + ' → ' + T1.euler + ', a through bore makes it ' + (T0.euler - 2) + ')';
            res.retry = true;
            return res;
          }
        }
        var bad = NSO_rbSlicerBad(out);
        if (bad) { res.reason = 'internal: the welded piece has vertices closer than a slicer\'s weld (at 1e-4 mm: open ' + bad.open + ', doubled ' + bad.nm + ', collapsed ' + bad.dropped + ')'; res.retry = true; return res; }
        var v0 = NSO_teVolume(f32, b.wall), v1 = NSO_teVolume(out, b.wall), dv = v1 - v0;
        res.volume = { before: v0, after: v1, change: dv, outside: b.outsideMm3, whole: b.volumeMm3 };
        if (!(dv > 0 && dv <= b.volumeMm3 * 1.005 + 1e-3)) {
          res.reason = 'internal: the piece grew by ' + NSO_rbFmt(dv, 1) + ' mm³ - a tube branch adds more than nothing and no more than its outside solid (' +
            NSO_rbFmt(b.volumeMm3, 1) + ' mm³)';
          return res;
        }
        res.ok = true;
        res.tris = out;
        res.reason = NSO_rodBranchDescribe(res);
        return res;
      });
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_rodBranchEnds: NSO_rodBranchEnds, NSO_rodLimbHint: NSO_rodLimbHint, NSO_rodBranchRead: NSO_rodBranchRead, NSO_rodBranchPlan: NSO_rodBranchPlan, NSO_rodBranchRaw: NSO_rodBranchRaw,
                     NSO_rodBranchDescribe: NSO_rodBranchDescribe, NSO_rbDepth: NSO_rbDepth, NSO_rbShells: NSO_rbShells };
}
