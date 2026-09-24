// ===================== Crop, stage 1: remove a slab and rejoin =====================
// Sections 1-4 are headless: no DOM, no Three.js, no app state, so the same
// file runs under node (tools/nso_crop_test.js) and as a classic script in the
// browser. Section 5 is the app wiring and the movable box.
//
// Speaks rawTris, the flat triangle soup with 9 floats per triangle, in the
// raw (file) frame, the same soup Cut, Extend and Mirror pass around.
//
// WHAT IT DOES. A box selects a slab of the piece along one axis. Everything
// inside the slab goes. The part past the slab slides back along that axis by
// the slab's length, so it meets the near part at the near face, and the two
// are sealed into one closed piece. The piece comes out shorter by exactly the
// box length. That slide is part of "crop out a middle section", not a
// repositioning: nothing moves sideways or turns, and the near part does not
// move at all. Lining up two sections that do not match (a lateral offset, a
// twist) is Stage 2 and is not here.
//
// WHAT IT REUSES, and why it does not use the obvious two pieces:
//   - The clip at both box faces is Cut's own seam-safe clip, rawCutOpen in
//     app-cut.js: weld the input, snap near-plane vertices onto the plane,
//     clip, weld the on-plane points on their float32 positions. It is the
//     part of rawCut before the cap. rawCut is now rawCutOpen + the cap, so
//     the two tools cannot drift apart.
//   - Where a cap is needed, it is Cut's cap routine, rawFlatCapLoop (Cut's
//     ear clipper), fed a loop the same way rawCut feeds it.
//   - The finish is Cut's rawSplitDegenerates.
//   Measured, before writing any of this: capping both pieces with rawCut and
//   handing them to Join does not work. Join's planar fuse (NSO_planarFusePair)
//   refused a plain box, "no congruent triangle found". Each wall quad is two
//   triangles, and its diagonal crosses the two box faces at different points,
//   so the two sections have the same outline but different vertices on it.
//   The Manifold union (NSO_unionSoups) closed pin, the slotted block, the
//   star prism and the hinge. It left box_closed.stl and v9_mirror_factory.stl
//   non-manifold with inconsistent winding by tools/mesh_validate.py. So the
//   joint is sealed here, directly, on the two open boundaries (section 3).
//
// OUT OF SCOPE, refused by name rather than half-done:
//   1. A box that does not cover the whole cross-section. That would cut a
//      pocket, which is Carve's job. Crop removes full slabs only.
//   2. A joint whose step face would need a hole, e.g. the far section sits
//      wholly inside the near one without touching its outline. Cut's cap
//      routine fills simple loops only (a tube section is a known Cut
//      limitation). Two sections that are the same, tubes included, need no
//      cap and are fine.
//   3. Repositioning, alignment and anything else Stage 2 owns.

/* =====================================================================
   1. Small helpers
   ===================================================================== */

var NSO_CROP_TOL = 1e-4;   // Cut's RAW_CUT_WELD_TOL; the checker's weld radius

function NSO_cropBounds(soup) {
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soup.length; i++) {
    var k = i % 3, v = soup[i];
    if (v < lo[k]) lo[k] = v;
    if (v > hi[k]) hi[k] = v;
  }
  return { lo: lo, hi: hi };
}

// Signed volume of a closed soup (divergence theorem about the origin).
function NSO_cropVolume(s) {
  var v = 0;
  for (var o = 0; o + 8 < s.length; o += 9) {
    v += s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7]) - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6]) +
         s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]);
  }
  return v / 6;
}

// Volume of an OPEN piece whose only opening lies in the plane coord[k] = c:
// the flux of F = (x_k - c) e_k, which is zero across that plane, so the
// missing cap adds nothing. Lets the gate know what the sealed result must
// enclose without building any cap to measure it.
function NSO_cropOpenVolume(s, k, c) {
  var v = 0;
  for (var o = 0; o + 8 < s.length; o += 9) {
    var a = o, b = o + 3, d = o + 6;
    var ux = s[b] - s[a], uy = s[b+1] - s[a+1], uz = s[b+2] - s[a+2];
    var vx = s[d] - s[a], vy = s[d+1] - s[a+1], vz = s[d+2] - s[a+2];
    var n = k === 0 ? uy * vz - uz * vy : k === 1 ? uz * vx - ux * vz : ux * vy - uy * vx;
    v += ((s[a+k] + s[b+k] + s[d+k]) / 3 - c) * n / 2;
  }
  return v;
}

// Exact-key edge census: every directed edge must occur once and its reverse
// once. That one test is closed + manifold + consistently wound, on the very
// float32 values an exported STL will carry.
function NSO_cropEdgeCensus(f32) {
  function pk(o) { return f32[o] + ',' + f32[o+1] + ',' + f32[o+2]; }
  var dir = new Map(), degenerate = 0;
  for (var t = 0; t + 8 < f32.length; t += 9) {
    var ka = pk(t), kb = pk(t + 3), kc = pk(t + 6);
    if (ka === kb || kb === kc || ka === kc) { degenerate++; continue; }
    var e = [ka + '>' + kb, kb + '>' + kc, kc + '>' + ka];
    for (var i = 0; i < 3; i++) dir.set(e[i], (dir.get(e[i]) || 0) + 1);
  }
  var open = 0, repeated = 0;
  dir.forEach(function (n, key) {
    if (n > 1) repeated += n - 1;
    var p = key.split('>');
    if (!dir.has(p[1] + '>' + p[0])) open++;
  });
  return { open: open, repeated: repeated, degenerate: degenerate, edges: dir.size };
}

/* =====================================================================
   2. The box: bounding box -> slab -> affected faces

   A box is { axisIdx, min: [x,y,z], max: [x,y,z] } in the raw frame, or just
   { axisIdx, lo, hi } for a slab whose sides are open. The box's extent on
   axisIdx is the slab. Every face the slab touches must lie inside the box's
   other two extents, otherwise the box is a pocket and is refused.

   faces: removed  - all three corners strictly inside the slab: deleted
          clipped  - crosses a box face: Cut's clip trims it
          kept     - untouched
   ===================================================================== */
function NSO_cropResolveBox(rawTris, box) {
  var out = { ok: false, reason: '' };
  if (!rawTris || rawTris.length < 9) { out.reason = 'empty piece'; return out; }
  if (!box || !(box.axisIdx === 0 || box.axisIdx === 1 || box.axisIdx === 2)) {
    out.reason = 'box needs an axis (0, 1 or 2)'; return out;
  }
  var k = box.axisIdx;
  var lo = box.min ? box.min[k] : box.lo, hi = box.max ? box.max[k] : box.hi;
  if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) { out.reason = 'box ends must be numbers with start < end'; return out; }
  // The planes are float32 values, so the joint face lands on a coordinate
  // an STL can hold and the far part's slide is exact at the joint.
  lo = Math.fround(lo); hi = Math.fround(hi);
  var b = NSO_cropBounds(rawTris);
  out.axisIdx = k; out.lo = lo; out.hi = hi; out.pieceLo = b.lo[k]; out.pieceHi = b.hi[k];
  var tol = NSO_CROP_TOL;
  if (!(lo > b.lo[k] + 2 * tol) || !(hi < b.hi[k] - 2 * tol)) {
    out.reason = 'the box must lie inside the piece along ' + 'XYZ'[k] + ' (' + b.lo[k] + ' .. ' + b.hi[k] +
      '); it runs ' + lo + ' .. ' + hi + '. A box over an end is a trim - use Cut';
    return out;
  }
  if (!(hi - lo > 2 * tol)) { out.reason = 'the box is thinner than the weld radius'; return out; }
  var removed = 0, clipped = 0, kept = 0, outside = 0;
  var o1 = (k + 1) % 3, o2 = (k + 2) % 3;
  for (var t = 0; t + 8 < rawTris.length; t += 9) {
    var c0 = rawTris[t + k], c1 = rawTris[t + 3 + k], c2 = rawTris[t + 6 + k];
    var mn = Math.min(c0, c1, c2), mx = Math.max(c0, c1, c2);
    if (mx < lo || mn > hi) { kept++; continue; }
    if (mn > lo && mx < hi) removed++; else clipped++;
    if (box.min && box.max) {
      for (var v = 0; v < 3; v++) {
        var p = t + v * 3;
        if (rawTris[p + o1] < box.min[o1] - tol || rawTris[p + o1] > box.max[o1] + tol ||
            rawTris[p + o2] < box.min[o2] - tol || rawTris[p + o2] > box.max[o2] + tol) { outside++; break; }
      }
    }
  }
  if (outside) {
    out.reason = 'the box does not cover the whole cross-section: ' + outside + ' face(s) in the slab reach outside it. ' +
      'Crop removes a full slab; a partial box would cut a pocket';
    return out;
  }
  out.faces = { removed: removed, clipped: clipped, kept: kept };
  out.ok = true;
  return out;
}

/* =====================================================================
   3. Sealing the joint

   After the slide both open boundaries lie in one plane, coord[k] = lo.
   Near part: region P, walls below. Far part: region Q, walls above.
   The sealed surface is
     - P and Q overlap: nothing. Those boundary edges pair up and the walls
       run straight through.
     - P outside Q: a step face on the near part, facing +k.
     - Q outside P: a step face on the far part, facing -k.
   Steps:
     a. weld the joint points of both parts together (2x Cut's weld radius,
        on float32 positions, as rawSnapPlanePoints does for one cut)
     b. split every open boundary edge at any joint point lying on it and at
        every crossing with the other part's boundary. The wall triangle that
        owns the edge is fanned from its off-plane corner, so no T-junction
        is left anywhere. This is what the planar fuse cannot do: it needs
        the two sections to have the same vertices, and a prism's two cuts
        never do.
     c. whatever edge still has no reverse twin borders a step face. Each is
        classed P-outside-Q or Q-outside-P by where its midpoint lies, walked
        into loops per class, and capped with Cut's rawFlatCapLoop.
   ===================================================================== */

function NSO_cropSeal(trisA, trisB, k, plane, tol, info) {
  var o1 = (k + 1) % 3, o2 = (k + 2) % 3;   // right-handed: o1 x o2 = +k
  function key(p) { return p[0] + ',' + p[1] + ',' + p[2]; }
  function onPlane(p) { return p[k] === plane; }
  var tris = [];                       // { v: [p,p,p], side: 0 near | 1 far }
  trisA.forEach(function (v) { tris.push({ v: v, side: 0 }); });
  trisB.forEach(function (v) { tris.push({ v: v, side: 1 }); });

  // a. weld the joint points of both parts
  var pts = [], seen = new Map();
  tris.forEach(function (T) {
    T.v.forEach(function (p) {
      if (!onPlane(p)) return;
      var kk = key(p);
      if (!seen.has(kk)) { seen.set(kk, pts.length / 3); pts.push(p[0], p[1], p[2]); }
    });
  });
  var rep = rawWeldPoints(pts, 2 * tol);
  var canon = new Map();
  seen.forEach(function (i, kk) {
    var r = rep[i];
    var q = [pts[r*3], pts[r*3+1], pts[r*3+2]];
    q[k] = plane;
    canon.set(kk, q);
  });
  var merged = 0;
  var welded = [];
  tris.forEach(function (T) {
    var v = T.v.map(function (p) {
      if (!onPlane(p)) return p;
      var q = canon.get(key(p));
      if (q !== p && key(q) !== key(p)) merged++;
      return q;
    });
    var a = key(v[0]), b = key(v[1]), c = key(v[2]);
    if (a === b || b === c || a === c) return;
    welded.push({ v: v, side: T.side });
  });
  tris = welded;
  info.jointPointsMerged = merged;

  function to2(p) { return [p[o1], p[o2]]; }
  function orient(a, b, c) { return (b[0]-a[0]) * (c[1]-a[1]) - (b[1]-a[1]) * (c[0]-a[0]); }

  // Directed on-plane edges with no reverse twin, over both parts together.
  function openEdges() {
    var dir = new Map();
    for (var i = 0; i < tris.length; i++) {
      var v = tris[i].v;
      for (var e = 0; e < 3; e++) {
        var a = v[e], b = v[(e+1)%3];
        if (!onPlane(a) || !onPlane(b)) continue;
        var kk = key(a) + '>' + key(b);
        var list = dir.get(kk);
        if (list) list.push([i, e]); else dir.set(kk, [[i, e]]);
      }
    }
    var open = [], repeated = 0;
    dir.forEach(function (list, kk) {
      if (list.length > 1) repeated += list.length - 1;
      var p = kk.split('>');
      if (dir.has(p[1] + '>' + p[0])) return;
      for (var j = 0; j < list.length; j++) {
        var T = tris[list[j][0]], e = list[j][1];
        open.push({ tri: list[j][0], e: e, a: T.v[e], b: T.v[(e+1)%3], side: T.side });
      }
    });
    return { open: open, repeated: repeated };
  }

  // b. split open edges at joint points on them and at crossings
  info.tJunctionSplits = 0; info.crossings = 0;
  var rounds = 0;
  for (;;) {
    if (++rounds > 64) throw new Error('joint split did not settle');
    var oe = openEdges();
    if (oe.repeated) {
      throw new Error('the two parts overlap along the joint (' + oe.repeated + ' repeated edge(s))');
    }
    var open = oe.open;
    if (!open.length) break;
    var jp = new Map();
    open.forEach(function (E) { jp.set(key(E.a), E.a); jp.set(key(E.b), E.b); });
    var jpl = Array.from(jp.values()).sort(function (p, q) { return p[o1] - q[o1]; });
    var jpu = jpl.map(function (p) { return p[o1]; });
    function firstAtLeast(u) {
      var l = 0, h = jpu.length;
      while (l < h) { var m = (l + h) >> 1; if (jpu[m] < u) l = m + 1; else h = m; }
      return l;
    }
    var splits = new Map();     // edge index -> [{p, t}]
    function addSplit(ei, p, t) {
      var L = splits.get(ei);
      if (!L) { L = []; splits.set(ei, L); }
      for (var i = 0; i < L.length; i++) if (key(L[i].p) === key(p)) return;
      L.push({ p: p, t: t });
    }
    // T-junctions: a joint point lying on an open edge, clear of its ends
    open.forEach(function (E, ei) {
      var a = to2(E.a), b = to2(E.b);
      var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
      var from = firstAtLeast(Math.min(a[0], b[0]) - tol);
      var umax = Math.max(a[0], b[0]) + tol;
      var vmin = Math.min(a[1], b[1]) - tol, vmax = Math.max(a[1], b[1]) + tol;
      for (var j = from; j < jpl.length && jpu[j] <= umax; j++) {
        var p = jpl[j], q = to2(p);
        if (q[1] < vmin || q[1] > vmax) continue;
        var s = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy);
        if (s * L <= tol * L2 || s * L >= L2 * L - tol * L2) continue;   // within tol of an end
        if (Math.abs(orient(a, b, q)) > tol * L) continue;               // off the line
        addSplit(ei, p, s / L2);
      }
    });
    var tCount = 0;
    splits.forEach(function (L) { tCount += L.length; });
    // Crossings between the near part's and the far part's open edges
    if (!tCount) {
      var A = [], B = [];
      open.forEach(function (E, ei) { (E.side === 0 ? A : B).push(ei); });
      for (var ia = 0; ia < A.length; ia++) {
        var Ea = open[A[ia]], a1 = to2(Ea.a), a2 = to2(Ea.b);
        var la = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
        for (var ib = 0; ib < B.length; ib++) {
          var Eb = open[B[ib]], b1 = to2(Eb.a), b2 = to2(Eb.b);
          if (Math.max(b1[0], b2[0]) < Math.min(a1[0], a2[0]) || Math.min(b1[0], b2[0]) > Math.max(a1[0], a2[0]) ||
              Math.max(b1[1], b2[1]) < Math.min(a1[1], a2[1]) || Math.min(b1[1], b2[1]) > Math.max(a1[1], a2[1])) continue;
          var lb = Math.hypot(b2[0] - b1[0], b2[1] - b1[1]);
          var d1 = orient(a1, a2, b1) / la, d2 = orient(a1, a2, b2) / la;
          var d3 = orient(b1, b2, a1) / lb, d4 = orient(b1, b2, a2) / lb;
          if (!((d1 > tol && d2 < -tol) || (d1 < -tol && d2 > tol))) continue;
          if (!((d3 > tol && d4 < -tol) || (d3 < -tol && d4 > tol))) continue;
          var t = d3 / (d3 - d4);
          var p = [0, 0, 0];
          p[k] = plane;
          p[o1] = Math.fround(a1[0] + (a2[0] - a1[0]) * t);
          p[o2] = Math.fround(a1[1] + (a2[1] - a1[1]) * t);
          var pq = to2(p);
          var ta = ((pq[0] - a1[0]) * (a2[0] - a1[0]) + (pq[1] - a1[1]) * (a2[1] - a1[1])) / (la * la);
          var tb = ((pq[0] - b1[0]) * (b2[0] - b1[0]) + (pq[1] - b1[1]) * (b2[1] - b1[1])) / (lb * lb);
          addSplit(A[ia], p, ta);
          addSplit(B[ib], p, tb);
          info.crossings++;
        }
      }
    }
    if (!splits.size) break;
    info.tJunctionSplits += tCount;
    // Fan each split edge's wall triangle from its off-plane corner.
    var drop = new Set(), add = [];
    splits.forEach(function (L, ei) {
      var E = open[ei];
      if (drop.has(E.tri)) return;          // a triangle has one on-plane edge
      L.sort(function (x, y) { return x.t - y.t; });
      var T = tris[E.tri], w = T.v[(E.e + 2) % 3];
      var chain = [E.a].concat(L.map(function (s) { return s.p; }), [E.b]);
      for (var i = 0; i + 1 < chain.length; i++) add.push({ v: [chain[i], chain[i+1], w], side: T.side });
      drop.add(E.tri);
    });
    tris = tris.filter(function (T, i) { return !drop.has(i); }).concat(add);
  }

  // c. class the edges still open, walk them into loops, cap each loop
  var rest = openEdges().open;
  info.stepEdges = rest.length;
  var caps = [];
  info.capLoops = 0; info.capTris = 0;
  if (rest.length) {
    // Each part's own outline, for point-in-region tests.
    var own = [[], []];
    var ownDir = [new Map(), new Map()];
    tris.forEach(function (T) {
      for (var e = 0; e < 3; e++) {
        var a = T.v[e], b = T.v[(e+1)%3];
        if (!onPlane(a) || !onPlane(b)) continue;
        ownDir[T.side].set(key(a) + '>' + key(b), [a, b]);
      }
    });
    [0, 1].forEach(function (s) {
      ownDir[s].forEach(function (ab, kk) {
        var p = kk.split('>');
        if (!ownDir[s].has(p[1] + '>' + p[0])) own[s].push([to2(ab[0]), to2(ab[1])]);
      });
    });
    function inside(q, outline) {
      var c = false;
      for (var i = 0; i < outline.length; i++) {
        var a = outline[i][0], b = outline[i][1];
        if ((a[1] > q[1]) !== (b[1] > q[1])) {
          var x = a[0] + (q[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
          if (x > q[0]) c = !c;
        }
      }
      return c;
    }
    // +1: near part outside the far one (step faces +k); -1: the reverse.
    var byClass = { '1': [], '-1': [] };
    rest.forEach(function (E) {
      var a = to2(E.a), b = to2(E.b), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      var inOther = inside(m, own[1 - E.side]);
      var cls = E.side === 0 ? (inOther ? -1 : 1) : (inOther ? 1 : -1);
      byClass[cls].push(E);
    });
    [1, -1].forEach(function (cls) {
      var edges = byClass[cls];
      if (!edges.length) return;
      var outs = new Map();
      edges.forEach(function (E, i) {
        var kk = key(E.a);
        var L = outs.get(kk);
        if (L) L.push(i); else outs.set(kk, [i]);
      });
      var used = new Uint8Array(edges.length);
      for (var s = 0; s < edges.length; s++) {
        if (used[s]) continue;
        var loop = [], cur = s, guard = 0;
        while (!used[cur] && guard++ <= edges.length) {
          used[cur] = 1;
          var E = edges[cur];
          loop.push(E.a);
          var cand = (outs.get(key(E.b)) || []).filter(function (j) { return !used[j] || j === s; });
          if (!cand.length) { cur = -1; break; }
          if (cand.length > 1) {
            // Two step faces of one class touch at this point. Keep to the
            // face being walked: the next edge is the one that turns least
            // away from it (face on the right for +1 in wall order, left
            // for -1; see the header of this section).
            var r = to2(E.a), pb = to2(E.b);
            var ra = Math.atan2(r[1] - pb[1], r[0] - pb[0]);
            var best = -1, bestAng = Infinity;
            cand.forEach(function (j) {
              var q = to2(edges[j].b);
              var ang = Math.atan2(q[1] - pb[1], q[0] - pb[0]) - ra;
              if (cls < 0) ang = -ang;
              while (ang <= 0) ang += 2 * Math.PI;
              while (ang > 2 * Math.PI) ang -= 2 * Math.PI;
              if (ang < bestAng) { bestAng = ang; best = j; }
            });
            cur = best;
          } else cur = cand[0];
        }
        if (cur !== s) throw new Error('a step-face outline at the joint does not close');
        if (loop.length < 3) throw new Error('a step-face outline at the joint has ' + loop.length + ' point(s)');
        // Wall order runs clockwise seen from +k for a +k face, counter-
        // clockwise for a -k face. A loop the other way round is a hole.
        var area = 0;
        for (var i = 0; i < loop.length; i++) {
          var p = to2(loop[i]), q = to2(loop[(i + 1) % loop.length]);
          area += p[0] * q[1] - q[0] * p[1];
        }
        area /= 2;
        if (area * cls > 0) {
          throw new Error('the joint needs a step face with a hole in it (the far section sits inside the near one ' +
            'or the reverse); Cut’s cap fills simple outlines only');
        }
        var cap = rawFlatCapLoop(loop, k, plane, cls < 0);
        var capArea = 0;
        for (var c = 0; c < cap.length; c += 9) {
          var A2 = to2([cap[c], cap[c+1], cap[c+2]]), B2 = to2([cap[c+3], cap[c+4], cap[c+5]]), C2 = to2([cap[c+6], cap[c+7], cap[c+8]]);
          capArea += Math.abs(orient(A2, B2, C2)) / 2;
        }
        if (Math.abs(capArea - Math.abs(area)) > 1e-6 * Math.max(1, Math.abs(area))) {
          throw new Error('a step face did not triangulate cleanly (cap ' + capArea + ' vs outline ' + Math.abs(area) + ' mm^2)');
        }
        caps.push(cap);
        info.capLoops++;
        info.capTris += cap.length / 9;
      }
    });
  }

  var out = [];
  tris.forEach(function (T) { out.push(T.v[0][0], T.v[0][1], T.v[0][2], T.v[1][0], T.v[1][1], T.v[1][2], T.v[2][0], T.v[2][1], T.v[2][2]); });
  caps.forEach(function (cap) { for (var i = 0; i < cap.length; i++) out.push(cap[i]); });
  return out;
}

/* =====================================================================
   4. NSO_cropRaw(rawTris, opts) -> { ok, reason, tris, ... }

   opts.box    a box as in section 2, or
   opts.axisIdx, opts.lo, opts.hi   the slab directly.
   On refusal ok is false and tris is the input soup object.
   ===================================================================== */
function NSO_cropRaw(rawTris, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: rawTris };
  var box = opts.box || { axisIdx: opts.axisIdx, lo: opts.lo, hi: opts.hi };
  var sel = NSO_cropResolveBox(rawTris, box);
  res.box = sel;
  if (!sel.ok) { res.reason = sel.reason; return res; }
  var k = sel.axisIdx, lo = sel.lo, hi = sel.hi, d = hi - lo, tol = NSO_CROP_TOL;
  res.axisIdx = k; res.axis = 'xyz'[k]; res.lo = lo; res.hi = hi; res.removedLength = d;
  res.faces = sel.faces;

  // Cut's own clip at both box faces. keepMin true keeps coord >= plane.
  var near = rawCutOpen(rawTris, k, lo, false);
  var far = rawCutOpen(rawTris, k, hi, true);
  if (!near || !far) { res.reason = 'a side of the box keeps nothing'; return res; }
  // A triangle lying IN a box face survives rawCutOpen only when it faces the
  // removed side (rawSnapPlanePoints): a flat face of the piece the box face
  // lands on, or seam slivers snapped onto it. Either way it is already cap,
  // i.e. part of that side's section, not wall. Take it out and the section
  // outline is the open boundary again, as for any other box face. It adds
  // nothing to the open volume below, since x_k - c is 0 on it.
  function toTris(flat, plane) {
    var out = [], inPlane = 0;
    for (var t = 0; t + 8 < flat.length; t += 9) {
      var v = [[flat[t], flat[t+1], flat[t+2]], [flat[t+3], flat[t+4], flat[t+5]], [flat[t+6], flat[t+7], flat[t+8]]];
      if (v[0][k] === plane && v[1][k] === plane && v[2][k] === plane) { inPlane++; continue; }
      out.push(v);
    }
    return { tris: out, inPlane: inPlane };
  }
  var A = toTris(near, lo), B = toTris(far, hi);
  res.inPlaneDropped = A.inPlane + B.inPlane;
  if (!A.tris.length || !B.tris.length) { res.reason = 'a side of the box keeps nothing'; return res; }
  var volNear = NSO_cropOpenVolume(near, k, lo), volFar = NSO_cropOpenVolume(far, k, hi);

  // Slide the far part back by the box length. The planes are float32, so
  // hi - d is exactly lo: the far joint lands on the near joint bit for bit.
  B.tris.forEach(function (v) {
    for (var i = 0; i < 3; i++) {
      var p = v[i].slice();
      p[k] = p[k] === hi ? lo : Math.fround(p[k] - d);
      v[i] = p;
    }
  });

  var info = {};
  var sealed;
  try { sealed = NSO_cropSeal(A.tris, B.tris, k, lo, tol, info); }
  catch (err) { res.reason = (err && err.message) || String(err); res.joint = info; return res; }
  res.joint = info;
  var out = rawSplitDegenerates(new Float32Array(sealed));

  // Gate on the result, on the float32 values it will be saved as.
  var census = NSO_cropEdgeCensus(out);
  res.census = census;
  if (census.open || census.repeated || census.degenerate) {
    res.reason = 'the sealed piece is not closed (open ' + census.open + ', repeated ' + census.repeated +
      ', degenerate ' + census.degenerate + ')';
    return res;
  }
  var vol = NSO_cropVolume(out), want = volNear + volFar;
  res.volumeBefore = NSO_cropVolume(rawTris); res.volumeAfter = vol; res.volumeExpected = want;
  if (!(Math.abs(vol - want) <= 1e-5 * Math.max(1, Math.abs(want)))) {
    res.reason = 'the sealed piece encloses ' + vol + ' mm^3, the two kept parts ' + want + ' mm^3';
    return res;
  }
  var bIn = NSO_cropBounds(rawTris), bOut = NSO_cropBounds(out);
  res.lengthBefore = bIn.hi[k] - bIn.lo[k];
  res.lengthAfter = bOut.hi[k] - bOut.lo[k];
  res.ok = true;
  res.tris = out;
  return res;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_cropRaw: NSO_cropRaw, NSO_cropResolveBox: NSO_cropResolveBox,
    NSO_cropEdgeCensus: NSO_cropEdgeCensus, NSO_cropVolume: NSO_cropVolume };
}

/* =====================================================================
   5. App wiring: the box, the button, the commit

   The Crop row lives in the Cut menu and works on the piece the cutter is
   on, along the cutter's axis (resolveAxis), so the box and the red line
   always agree about which way the piece runs. The box is given as two
   distances from the piece's low end, in the frame the Cut readout uses,
   and mapped to the raw frame with Cut's own mapPlaneToRaw.

   The box in the viewport is optional (the "Box" tick). It is drawn in the
   piece's own frame, so it follows any pose. Drag its body to slide it
   along the axis; drag either end face to move that end.

   PAINT SCOPE: WHOLE-PIECE, the same answer Extend gives. Every face past
   the box slides, so no face there can be promised untouched. Any paint
   stands the whole bake down, naming the count. nsoMaskCount(m) is the test.
   ===================================================================== */

var NSO_CROP_MIN_MM = 0.5;   // keep at least this much on each side, and in the box

function NSO_cropState() {
  if (typeof state === 'undefined') return {};
  if (!state.crop) state.crop = { startMm: null, endMm: null, show: false, forId: null };
  return state.crop;
}

// The slab in display terms for model m, defaulting to the middle fifth.
function NSO_cropDisplaySlab(m) {
  if (!m || !m.geometry || !m.geometry.attributes || !m.geometry.attributes.position) return null;
  var axis = resolveAxis(m);
  var bb = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  var origin = axis === 'x' ? bb.min.x : bb.min.z;
  var span = axis === 'x' ? bb.max.x - bb.min.x : bb.max.z - bb.min.z;
  if (!(span > 0)) return null;
  var cs = NSO_cropState();
  // A new piece, a new axis, or this piece's length changed under the box
  // (another bake): start again from the middle fifth.
  if (cs.forId !== m.id || cs.axis !== axis || !(cs.endMm <= span - NSO_CROP_MIN_MM)) {
    cs.forId = m.id; cs.axis = axis;
    cs.startMm = Math.round(span * 0.4 * 10) / 10;
    cs.endMm = Math.round(span * 0.6 * 10) / 10;
  }
  return { axis: axis, bbox: bb, origin: origin, span: span, startMm: cs.startMm, endMm: cs.endMm };
}

// Display slab -> raw box. Null with a reason when the raw frame cannot be
// trusted to match what the user sees.
function NSO_cropRawBox(m, slab) {
  if (!m.rawTris || m.rawAxis !== 'zup' || !m.centerOffset) return { reason: 'Crop needs a raw piece' };
  var a = mapPlaneToRaw(m, slab.axis, slab.origin + slab.startMm, false);
  var b = mapPlaneToRaw(m, slab.axis, slab.origin + slab.endMm, false);
  if (!a || !b) return { reason: 'no raw mapping for this axis' };
  var k = a.axisIdx;
  var rb = NSO_cropBounds(m.rawTris);
  // Same check Split's raw engine relies on implicitly: the raw piece's
  // extent on this axis is the extent the user is looking at.
  if (Math.abs((rb.hi[k] - rb.lo[k]) - slab.span) > 1e-3) {
    return { reason: 'the piece was turned since it was loaded, so its raw frame no longer matches the view' };
  }
  var min = rb.lo.slice(), max = rb.hi.slice();
  min[k] = Math.min(a.plane, b.plane); max[k] = Math.max(a.plane, b.plane);
  return { box: { axisIdx: k, min: min, max: max } };
}

function NSO_cropReadout(m, slab) {
  var el = document.getElementById('crop-readout');
  if (!el) return;
  if (!m || !slab) { el.textContent = '—'; return; }
  var txt = 'Box ' + slab.axis.toUpperCase() + ' ' + slab.startMm.toFixed(1) + ' → ' + slab.endMm.toFixed(1) +
    ' mm (' + (slab.endMm - slab.startMm).toFixed(1) + ' mm out) → piece ' + slab.span.toFixed(1) + ' → ' +
    (slab.span - (slab.endMm - slab.startMm)).toFixed(1) + ' mm';
  var rb = NSO_cropRawBox(m, slab);
  if (rb.box) {
    var sel = NSO_cropResolveBox(m.rawTris, rb.box);
    if (sel.ok) txt += '. ' + sel.faces.removed + ' face(s) removed, ' + sel.faces.clipped + ' clipped';
    else txt += '. ' + sel.reason;
  }
  el.textContent = txt;
}

function NSO_cropSyncUI() {
  if (typeof document === 'undefined') return;
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  var slab = m ? NSO_cropDisplaySlab(m) : null;
  var s = document.getElementById('crop-start-mm'), e = document.getElementById('crop-end-mm');
  if (slab) {
    if (s && document.activeElement !== s) s.value = slab.startMm.toFixed(1);
    if (e && document.activeElement !== e) e.value = slab.endMm.toFixed(1);
  }
  var btn = document.getElementById('btn-crop');
  if (btn) btn.disabled = !(typeof state !== 'undefined' && state.cutterOpen && m);
  NSO_cropReadout(m, slab);
  NSO_cropUpdateHelper();
}

function NSO_cropSetEnds(startMm, endMm) {
  var m = getActiveModel();
  var slab = m && NSO_cropDisplaySlab(m);
  if (!slab) return;
  var cs = NSO_cropState();
  var lo = Math.max(NSO_CROP_MIN_MM, Math.min(startMm, slab.span - 2 * NSO_CROP_MIN_MM));
  var hi = Math.min(slab.span - NSO_CROP_MIN_MM, Math.max(endMm, lo + NSO_CROP_MIN_MM));
  cs.startMm = Math.round(lo * 10) / 10;
  cs.endMm = Math.round(hi * 10) / 10;
  NSO_cropSyncUI();
}

/* ---- the box in the viewport ------------------------------------------ */

function NSO_cropTargetMesh(m) {
  var placed = (state.placed || []).find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  return (placed && placed.mesh) || state.previewMesh || null;
}

function NSO_cropRemoveHelper() {
  var h = state.cropHelper;
  if (!h) return;
  if (h.parent) h.parent.remove(h);
  h.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  state.cropHelper = null;
}

function NSO_cropUpdateHelper() {
  if (typeof state === 'undefined' || !state.scene || typeof THREE === 'undefined') return;
  NSO_cropRemoveHelper();
  var cs = NSO_cropState();
  var m = getActiveModel();
  if (!cs.show || !state.cutterOpen || !m) return;
  var slab = NSO_cropDisplaySlab(m), mesh = NSO_cropTargetMesh(m);
  if (!slab || !mesh) return;
  var bb = slab.bbox, ax = slab.axis === 'x' ? 0 : 2;
  var size = [bb.max.x - bb.min.x + 2, bb.max.y - bb.min.y + 2, bb.max.z - bb.min.z + 2];
  var center = [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2];
  var len = slab.endMm - slab.startMm;
  size[ax] = len;
  center[ax] = slab.origin + (slab.startMm + slab.endMm) / 2;

  var g = new THREE.Group();
  g.name = 'cropHelper';
  var body = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.18, depthWrite: false }));
  body.userData.cropHandle = 'body';
  g.add(body);
  var edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry),
    new THREE.LineBasicMaterial({ color: 0xb91c1c }));
  g.add(edges);
  ['start', 'end'].forEach(function (which) {
    var fs = size.slice(); fs[ax] = Math.max(0.6, Math.min(2, len * 0.2));
    var face = new THREE.Mesh(new THREE.BoxGeometry(fs[0], fs[1], fs[2]),
      new THREE.MeshBasicMaterial({ color: 0xb91c1c, transparent: true, opacity: 0.45, depthWrite: false }));
    var p = [0, 0, 0]; p[ax] = (which === 'start' ? -1 : 1) * len / 2;
    face.position.set(p[0], p[1], p[2]);
    face.userData.cropHandle = which;
    g.add(face);
  });
  mesh.updateMatrixWorld(true);
  g.matrixAutoUpdate = false;
  g.matrix.copy(mesh.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(center[0], center[1], center[2]));
  g.matrixWorldNeedsUpdate = true;
  state.scene.add(g);
  state.cropHelper = g;
}

// Pointer -> distance from the piece's low end along the axis, measured in
// the piece's own frame on the horizontal plane through its centre.
function NSO_cropMmFromPointer(m, slab, mesh) {
  state.raycaster.setFromCamera(state.pointer, state.camera);
  mesh.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var ray = state.raycaster.ray.clone().applyMatrix4(inv);
  var cy = (slab.bbox.min.y + slab.bbox.max.y) / 2;
  var hit = new THREE.Vector3();
  if (!ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -cy), hit)) return null;
  return (slab.axis === 'x' ? hit.x : hit.z) - slab.origin;
}

if (typeof document !== 'undefined') {
  (function wireCrop() {
    var drag = null;
    function onDown(ev) {
      if (ev.button !== 0 || !state.cropHelper || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      var hits = state.raycaster.intersectObject(state.cropHelper, true)
        .filter(function (h) { return h.object.userData.cropHandle; });
      if (!hits.length) return;
      var m = getActiveModel(), slab = m && NSO_cropDisplaySlab(m), mesh = m && NSO_cropTargetMesh(m);
      if (!slab || !mesh) return;
      var at = NSO_cropMmFromPointer(m, slab, mesh);
      if (at == null) return;
      // The handle is where the NEAREST hit lands: within an end slab's
      // thickness of an end, that end; anywhere else, the body. (Any hit
      // further along the ray is behind the surface the user clicked.)
      state.cropHelper.updateMatrixWorld(true);
      var local = state.cropHelper.worldToLocal(hits[0].point.clone());
      var ax = slab.axis === 'x' ? 'x' : 'z';
      var half = (slab.endMm - slab.startMm) / 2;
      var grip = Math.max(0.6, Math.min(2, half * 0.4));
      var handle = local[ax] <= -half + grip ? 'start' : local[ax] >= half - grip ? 'end' : 'body';
      drag = { handle: handle, at: at, startMm: slab.startMm, endMm: slab.endMm };
      if (state.controls) state.controls.enabled = false;
      ev.stopPropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!drag) return;
      var m = getActiveModel(), slab = m && NSO_cropDisplaySlab(m), mesh = m && NSO_cropTargetMesh(m);
      if (!slab || !mesh) { drag = null; return; }
      setPointerFromEvent(ev);
      var at = NSO_cropMmFromPointer(m, slab, mesh);
      if (at == null) return;
      var d = at - drag.at;
      if (drag.handle === 'body') {
        var len = drag.endMm - drag.startMm;
        var s = Math.max(NSO_CROP_MIN_MM, Math.min(drag.startMm + d, slab.span - NSO_CROP_MIN_MM - len));
        NSO_cropSetEnds(s, s + len);
      } else if (drag.handle === 'start') {
        NSO_cropSetEnds(drag.startMm + d, drag.endMm);
      } else {
        NSO_cropSetEnds(drag.startMm, drag.endMm + d);
      }
    }
    function onUp() {
      if (!drag) return;
      drag = null;
      if (state.controls) state.controls.enabled = true;
    }
    function wire() {
      var btn = document.getElementById('btn-crop');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try { NSO_cropSelectedModel(); }
        catch (err) {
          console.error('[crop]', err);
          setStatus('Crop failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      ['crop-start-mm', 'crop-end-mm'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', function () {
          var s = parseFloat(document.getElementById('crop-start-mm').value);
          var e = parseFloat(document.getElementById('crop-end-mm').value);
          if (isFinite(s) && isFinite(e)) NSO_cropSetEnds(s, e);
          else NSO_cropSyncUI();
        });
      });
      var chk = document.getElementById('chk-crop-box');
      if (chk) chk.addEventListener('change', function () { NSO_cropState().show = chk.checked; NSO_cropSyncUI(); });
      // Capture on the document, ahead of the canvas's own capture handler,
      // so a grab on the box never reaches select/move/orbit.
      document.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      // The box follows the cutter: same piece, same lifetime.
      if (typeof updateCutHelper === 'function') {
        var baseUpdate = updateCutHelper;
        updateCutHelper = function () { var r = baseUpdate.apply(this, arguments); NSO_cropSyncUI(); return r; };
      }
      if (typeof updateCutterUI === 'function') {
        var baseUI = updateCutterUI;
        updateCutterUI = function () { var r = baseUI.apply(this, arguments); NSO_cropSyncUI(); return r; };
      }
      NSO_cropSyncUI();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}

/* ---- the commit ---------------------------------------------------------- */

function NSO_cropCensus(soup) {
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair.inspect !== 'function') return null;
  try {
    var r = NSO_Repair.inspect(soup, { selfIntersections: false });
    return { open: r.openEdges, nm: r.nonManifoldEdges, degen: r.degenerateTris };
  } catch (e) { return null; }
}

function NSO_cropSelectedModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) { setStatus('Open the cutter and select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    setStatus('Crop stood down - ' + painted + ' painted face(s); everything past the box slides. Clear paint to crop.', true);
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var slab = NSO_cropDisplaySlab(m);
  if (!slab) { setStatus('Crop: this piece has no extent to crop', true); return { ok: false, reason: 'no extent' }; }
  var rb = NSO_cropRawBox(m, slab);
  if (!rb.box) { setStatus('Crop refused - piece unchanged (' + rb.reason + ')', true); return { ok: false, reason: rb.reason }; }
  var r = NSO_cropRaw(m.rawTris, { box: rb.box });
  if (!r.ok) { setStatus('Crop refused - piece unchanged (' + r.reason + ')', true); return r; }
  // The in-page transcription of the canonical checker, as Solidify gates.
  var before = NSO_cropCensus(m.rawTris), after = NSO_cropCensus(r.tris);
  r.canonBefore = before; r.canonAfter = after;
  if (!after) {
    setStatus('Crop unavailable - the mesh checker (NSO_Repair) is not loaded; piece unchanged', true);
    r.ok = false; r.reason = 'no checker'; return r;
  }
  if (after.open || after.nm > before.nm || after.degen > before.degen) {
    r.ok = false;
    r.reason = 'checker: open ' + after.open + ', non-manifold ' + before.nm + '→' + after.nm +
      ', degenerate ' + before.degen + '→' + after.degen;
    setStatus('Crop refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var cap = r.joint.capLoops ? r.joint.capLoops + ' step face(s) capped' : 'sections matched, no cap needed';
  var txt = 'Crop done - removed ' + slab.axis.toUpperCase() + ' ' + slab.startMm.toFixed(1) + '–' +
    slab.endMm.toFixed(1) + ' mm; piece ' + r.lengthBefore.toFixed(2) + ' → ' + r.lengthAfter.toFixed(2) +
    ' mm, one closed piece (' + cap + '; open 0, non-manifold ' + after.nm + ')';
  NSO_sculptCommitRaw(m, r.tris, 'cropReplace', txt);
  var cs = NSO_cropState();
  cs.forId = null;               // the old box would now select other geometry
  NSO_cropSyncUI();
  return r;
}
