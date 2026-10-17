/* nso_connect.js - Connect: build a connector between two anchors, and either
   weld it into the pieces it joins or keep it as a piece of its own.
   docs/CONNECT.md.

   Bridge (nso_bridge.js) is the quick gap-fill: what is picked decides the
   shape. Connect is the builder: the two anchors are only WHERE, the card
   decides WHAT runs between them.

   Loads as a classic script (window.NSO_Connect) and as a Node module. No DOM,
   no THREE. Every soup is the app's usual triangle soup (9 numbers a
   triangle), in ONE frame for every piece: the plate's world frame, Z up
   (app-connect.js reads each placed mesh the way app-bridge.js does).

   ANCHORS are what NSO_Bridge.pick returns (face / edge / point), wrapped as
   { piece, target }. The anchor is EXACTLY the point under the pointer, on the
   surface: no snapping to a centre or a corner, whatever the pick classed it as.
     point  the point itself, the surface normal there
     face   the point, the face's normal
     edge   the point, leaving along the average of the normals of the faces that
            meet there - the two faces of an edge, the three of a corner
            (NSO_Connect.anchor works the corner out; without it, the edge's two)
   A target marked `centre` (NSO_Connect.anchor(T, target, { centre: true }); the
   card does it for a Shift-click) keeps the old centres instead: a face's
   centroid, an edge's midpoint (its full length for a Ribbon's width cap),
   leaving along the face's normal / the bisector of the edge's two faces.

   THE LEAVE-ANGLE GUARD (the line must leave a surface at least 10 degrees off
   it) is asked of the faces, not of the averaged normal. On a flat face or a
   smooth surface that is the one normal. At an edge or a corner it is asked of
   the adjoining faces: where they bend away from one another (a box's corner,
   convex) the line may go any way that is out of the solid - at least 10 degrees
   off the face it leaves nearest, so a level line between two top corners is
   valid; where they close in on it (a U's inside corner, concave) it must clear
   every one of them. The averaged normal still orients a Ribbon and a pad.

   SHAPES.
     string    Ø                       a round rod
     ribbon    width x thickness       a flat strap; its flat face is
                                       perpendicular to the average of the two
                                       anchor normals: the thickness runs along
                                       that average (what is left of it once the
                                       path direction is taken out), so a strap
                                       between two level tops lies level. Two
                                       normals facing each other average to
                                       nothing; then the strap lies level (thin
                                       along Z)
     tube      Ø x wall                a closed hollow rod: an outer rod and a
                                       sealed bore inside it, one wall clear of
                                       both ends, so the bore pierces neither
                                       anchor
     tapered   Ø at A, Ø at B          a cone between them (a true frustum)

   PATH. One field, Sag (mm, signed, default 0). 0 is straight. Positive bows
   the connector UP by that much at mid-span (an arc: a handle, a hoop),
   negative hangs it DOWN (a drape). The curve is the circular arc through both
   anchor points with that mid-span offset, in the vertical plane through the
   anchors; when the anchors are stacked straight above one another the plane
   is not defined and the arc bows away from the centroid of the piece(s)
   (a negative sag then bows toward it). Every shape sweeps along the curve,
   NSO_PathSweep.sweep taking the polyline: at most 2 mm a step, an even number
   of them so a vertex sits exactly on the apex (the mid-span offset is then
   the stated one, not a chord's worth short of it), and finer on a curve so
   tight that 2 mm would turn it more than ~15° (the mitre at a joint stretches
   a section by 1/cos(turn/2)). Ends still meet each surface at the leave
   angle: the arc is trimmed in from each anchor and the stretch from that
   point to the anchor is a straight run, 3 mm long - more when a wide connector
   leaves steeply, so that the whole length of its side that crosses the surface
   (r x tan of the leave angle, plus a mm) is straight. That straight run is what
   the leave angle is measured on and what a weld sinks along, so the weld rule
   (rim gap + sink, leave angle, closed-solid check) holds as for a straight
   connector. A Tapered connector's Ø runs linearly along the path's length.
   A curve is refused when the exposed run would pass through either piece or a
   third one, or leaves a surface too flatly.

   ENDS. One dropdown, applied to both ends (per-end later). What the
   connector's own tips look like; RESULT below still decides whether the whole
   thing is unioned with the pieces.
     weld      sunk and unioned (the default). Kept separate there is nothing
               to sink into, so it is the flush cut - ticket 1's Keep separate
     flat      cut flush at the surface plane, not sunk, no union: the Keep-
               separate cut. With Result = Weld it is refused in words - a
               flush face has nothing to weld with (it would only join where it
               happens to lie flat, and a facet-plane contact the boolean calls
               closed is not one mesh_validate does)
     pad       a disc, Ø 2.5 x the connector's local width, 0.6 mm thick, flush
               on the surface (its flat face in the plane through the anchor,
               normal to the surface), unioned with the connector. Welded to
               the piece: its foot runs down into the piece by the disc's own
               rim gap + sink. The connector runs into the middle of the disc
     ball      a sphere of Ø 1.5 x the local width centred on the anchor,
               unioned with the connector; the connector runs to the centre.
               Welded to the piece because it straddles the surface; kept
               separate the lower half of it lies inside the piece's volume
   The local width is the Ø (String, Tube), the width (Ribbon) or the Ø at that
   end (Tapered).

   RESULT.
     weld      both ends sunk and unioned exactly as Bridge's string: sunk by
               the rim gap (NSO_Assemble.rootGap) plus sinkMm, the same leave
               angle, the boolean handed in as opts.union and NSO_Bridge.weld's
               own two steps and its own closed-solid check. The tube's bore
               rides through the union as an internal void.
     separate  The connector is its own closed piece, each end cut flush with
               the plane of the surface it meets (no sink). No boolean, unless
               the ends are a pad or a ball: those are unioned with the
               connector, and only with it.

   Reused, not re-implemented:
     NSO_PathSweep.sweep / profileRegular   (nso_path_sweep.js) every profile
     NSO_Assemble.rootGap                   (nso_assemble.js) the seat depth
     NSO_Bridge.weld / topology / volume / DEFAULTS   (nso_bridge.js) the
        weld, the closed-solid check, and the sink / leave angle / clearance
     NSO_Repair._triTriIntersect            (NSO_Repair.js) "does this cross that"

   PAINT SCOPE: NOT APPLICABLE here - this file reads soups and returns new
   ones. app-connect.js, which replaces pieces, carries the paint check and its
   label (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var SHAPES = ['string', 'ribbon', 'tube', 'tapered'];
  var ENDS = ['weld', 'flat', 'pad', 'ball'];
  var TIP_PHASES = [0, 0.5, 0.25, 0.75, 0.125, 0.625];   // a pad or ball is turned this fraction of a facet on a retry
  var ENDS_WORD = { weld: 'weld', flat: 'flat', pad: 'foot pad', ball: 'ball' };
  var DEFAULTS = {
    shape: 'string',
    result: 'weld',
    ends: 'weld',
    sagMm: 0,               // Path: signed, + bows up, - hangs down, 0 straight
    stepMm: 2,              // the curve is swept in steps of at most this long
    stepTurnRad: 0.26,      // ...and finer where 2 mm would turn it more than this (R * this)
    endStraightMm: 3,       // the last stretch before each anchor is a straight run
    sagEps: 1e-9,           // a sag under this is straight
    stackedSin: 1e-3,       // anchors this nearly one above the other (sin of the tilt off Z) have no vertical plane
    padScale: 2.5,          // Foot pad: Ø = this x the connector's local width
    padThickMm: 0.6,
    ballScale: 1.5,         // Ball: Ø = this x the connector's local width
    diameterMm: 2,          // String
    widthMm: 6,             // Ribbon
    thicknessMm: 1.2,
    tubeDiaMm: 4,           // Tube
    wallMm: 0.8,
    diaAMm: 4,              // Tapered, at A
    diaBMm: 1.5,            // ... at B
    sameFaceCos: Math.cos(8 * Math.PI / 180),   // normals this near one another are one face (a corner's average counts each face once)
    sharpCos: Math.cos(30 * Math.PI / 180),     // faces meeting at more than this are a crease; a curved surface's facets are not
    cornerDeg: 15,          // a face outline turns this much or more at a corner
    cornerReachMm: 1e-3,    // faces this near the clicked point (past its distance to the edge) are the ones that meet there
    atCornerMm: 0.05,       // closer than this to a corner, the anchor is "at" it
    ribbonOverEdge: 2,      // a ribbon may be this many times its shorter anchor edge wide
    perpFloor: 0.1,         // below this the normals' average has no sideways part (a ribbon then lies level)
    stationMm: 2,           // wall triangles are cut to at most this long (see emitRod)
    boreScale: 0.999        // the "does it cross a piece" body stays this far inside the real one
  };

  /* ------------------------------------------------------------- vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 0 ? [a[0] / L, a[1] / L, a[2] / L] : null; }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function clamp1(x) { return x > 1 ? 1 : (x < -1 ? -1 : x); }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function show(x) { return (typeof NSO_sectionShow === 'function') ? NSO_sectionShow(x) : f1(x); }
  function anyPerp(u) {
    var a = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(u, a));
  }
  // v turned by the minimal rotation that carries unit `from` onto unit `to` (null for an exact reversal).
  function rotateMin(v, from, to) {
    var ax = cross(from, to), s = len(ax), c = dot(from, to);
    if (s <= 1e-14) return c > 0 ? v.slice() : null;
    ax = mul(ax, 1 / s);
    var ang = Math.atan2(s, c), ca = Math.cos(ang), sa = Math.sin(ang);
    return add(add(mul(v, ca), mul(cross(ax, v), sa)), mul(ax, dot(ax, v) * (1 - ca)));
  }
  function signed(x) { return (x < 0 ? '-' : '+') + show(Math.abs(x)); }
  function triCount(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }
  function refuse(shape, reason) { return { ok: false, kind: shape || null, reason: reason }; }

  function need(name, ok) {
    if (!ok) throw new Error('Connect needs ' + name + ' loaded - nothing here re-implements it');
  }
  function bridge() {
    need('nso_bridge.js (NSO_Bridge)', typeof NSO_Bridge !== 'undefined' && NSO_Bridge);
    return NSO_Bridge;
  }
  function sweeper() {
    need('nso_path_sweep.js (NSO_PathSweep.sweep)', typeof NSO_PathSweep !== 'undefined' && NSO_PathSweep && NSO_PathSweep.sweep);
    return NSO_PathSweep;
  }

  /* An option as a number: the named one when given, else the default. NaN
     (a blank or a word) is "not given". */
  function opt(o, k) {
    var v = (o && o[k] != null && o[k] !== '') ? +o[k] : NaN;
    return isFinite(v) ? v : DEFAULTS[k];
  }
  function bopt(o, k) {                 // Bridge's own numbers: sink, leave angle, clearance
    var v = (o && o[k] != null) ? +o[k] : NaN;
    return isFinite(v) ? v : bridge().DEFAULTS[k];
  }

  /* ------------------------------------------------------------- anchors */
  function anchorOf(end) {
    var t = end.target, k = t.kind, exact = !t.centre && !!t.point, ln = t.leaveNormal ? unit(t.leaveNormal) : null;
    // the faces that meet at the point, for the leave-angle guard (none: the one normal)
    var fs = exact && t.faceNormals && t.faceNormals.length > 1 ? t.faceNormals.map(unit) : null, rule = t.faceRule === 'any' ? 'any' : 'all';
    if (k === 'point') return { kind: k, p: t.point.slice(), n: ln || unit(t.normal), edge: null, faces: fs, rule: rule };
    if (k === 'face') return { kind: k, p: (exact ? t.point : (t.centroid || t.point)).slice(), n: ln || unit(t.normal || t.face.normal), edge: null };
    if (k === 'edge') {
      var n = ln || unit(add(t.faceNormal || [0, 0, 1], t.acrossNormal || t.faceNormal || [0, 0, 1])) || unit(t.faceNormal);
      return { kind: k, p: exact ? t.point.slice() : lerp(t.a, t.b, 0.5), n: n, faces: fs, rule: rule,
               edge: { a: t.a, b: t.b, lengthMm: t.lengthMm != null ? t.lengthMm : len(sub(t.b, t.a)) } };
    }
    return null;
  }

  /* ---------------------------------------------- the anchor, where it is

     NSO_Connect.anchor(T, target, { centre, name, cornerPickMm }): the pick, made the anchor
     Connect will use. T is the piece's NSO_Bridge.index; target is NSO_Bridge.pick's.
     Returns { target, cornerMm, text }: `target` is a copy to hand to plan() -
     with the leave direction an EDGE needs worked out at the point (the average
     of the normals of every face within reach of it, so a corner gets its three,
     not the two of the edge it was classed on) - and `text` says where, for the
     readout: "on box_closed at 2.1 mm from its corner". cornerMm is the distance
     to the nearest corner of the face or edge (null on a curved surface, which
     has none). With `centre`, the old centre / midpoint is kept and said.

     A pointer never lands exactly on a vertex. cornerPickMm is how near a corner
     counts as at it (the card passes Bridge's edge-pick distance, in mm at that
     depth): within it, the faces that meet at the corner are all averaged - the
     three of a box corner - while the anchor stays the point itself. */
  function ptTri(p, a, b, c) {                   // distance from p to the triangle abc (Ericson)
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return len(ap);
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return len(bp);
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return len(sub(p, add(a, mul(ab, d1 / (d1 - d3)))));
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return len(cp);
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return len(sub(p, add(a, mul(ac, d2 / (d2 - d6)))));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return len(sub(p, add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))))));
    var den = 1 / (va + vb + vc);
    return len(sub(p, add(a, add(mul(ab, vb * den), mul(ac, vc * den)))));
  }
  function surfaceNormal(T, p, reach) {          // the distinct faces within `reach` of p, their normals averaged
    var soup = T.soup, reps = [], t, o;
    for (t = 0; t < T.n; t++) {
      o = t * 9;
      if (Math.min(soup[o], soup[o + 3], soup[o + 6]) > p[0] + reach || Math.max(soup[o], soup[o + 3], soup[o + 6]) < p[0] - reach ||
          Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) > p[1] + reach || Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) < p[1] - reach ||
          Math.min(soup[o + 2], soup[o + 5], soup[o + 8]) > p[2] + reach || Math.max(soup[o + 2], soup[o + 5], soup[o + 8]) < p[2] - reach) continue;
      var n = [T.nrm[t * 3], T.nrm[t * 3 + 1], T.nrm[t * 3 + 2]];
      if (!(len(n) > 0.5)) continue;
      if (ptTri(p, [soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]) > reach) continue;
      if (!reps.some(function (r) { return dot(r.n, n) > DEFAULTS.sameFaceCos; })) {
        reps.push({ n: n, v: [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]] });
      }
    }
    var sum = [0, 0, 0], sharp = reps.some(function (r, i) { return reps.some(function (q, j) { return j > i && dot(r.n, q.n) < DEFAULTS.sharpCos; }); });
    reps.forEach(function (r) { sum = add(sum, r.n); });
    // Convex where every face lies behind the plane of each of the others: the vertex of a face farthest off another's plane
    // is on its back. Anything else (a face in front of one, a mix) is a way in: the line must clear them all.
    var front = false;
    reps.forEach(function (ri, i) {
      reps.forEach(function (rj, j) {
        if (i === j) return;
        var far = 0;
        ri.v.forEach(function (q) { var d = dot(rj.n, sub(q, rj.v[0])); if (Math.abs(d) > Math.abs(far)) far = d; });
        if (far > 1e-6) front = true;
      });
    });
    return { n: unit(sum), faces: reps.length, sharp: sharp, normals: reps.map(function (r) { return r.n; }), convex: reps.length > 1 && !front };
  }
  function nearestCorner(p, t) {                 // mm to the nearest corner of the face or edge under p, or null
    var best = null;
    function take(q) { var d = len(sub(p, q)); if (best == null || d < best) best = d; }
    if (t.kind === 'edge') { take(t.a); take(t.b); }
    else if (t.kind === 'face' && t.face && t.face.loops) {
      var cosT = Math.cos(rad(DEFAULTS.cornerDeg));
      t.face.loops.forEach(function (lp) {
        var pts = lp.pts, m = pts.length;
        for (var i = 0; i < m; i++) {
          var d1 = unit(sub(pts[i], pts[(i + m - 1) % m])), d2 = unit(sub(pts[(i + 1) % m], pts[i]));
          if (d1 && d2 && dot(d1, d2) < cosT) take(pts[i]);
        }
      });
    }
    return best;
  }
  function anchor(T, target, o) {
    o = o || {};
    var t = {}, k;
    for (k in target) if (Object.prototype.hasOwnProperty.call(target, k)) t[k] = target[k];
    var on = 'on ' + (o.name || 'the piece');
    if (o.centre && (t.kind === 'face' || t.kind === 'edge')) {
      t.centre = true;
      return { target: t, cornerMm: null, text: on + ', ' + (t.kind === 'face' ? 'face centre' : 'edge midpoint') };
    }
    delete t.centre;
    if (t.kind === 'point' && T && t.point && o.cornerPickMm > 0) {
      // Bridge reads a welded piece's flat faces as plain points: a crease within the pick distance is still an edge or a corner.
      var pn = surfaceNormal(T, t.point, o.cornerPickMm);
      if (pn.n && pn.sharp) { t.leaveNormal = pn.n; t.faceNormals = pn.normals; t.faceRule = pn.convex ? 'any' : 'all'; }
    }
    if (t.kind === 'edge' && T && t.point) {
      var dEdge = segDist(t.point, t.a, t.b), dCorner = Math.min(len(sub(t.point, t.a)), len(sub(t.point, t.b)));
      var atCorner = o.cornerPickMm > 0 && dCorner <= o.cornerPickMm;
      var reach = (atCorner ? Math.max(dEdge, dCorner) : dEdge) + DEFAULTS.cornerReachMm, sn = surfaceNormal(T, t.point, reach);
      if (sn.n && sn.faces >= 2) { t.leaveNormal = sn.n; t.faceNormals = sn.normals; t.faceRule = sn.convex ? 'any' : 'all'; }
    }
    var c = nearestCorner(t.point, t);
    return { target: t, cornerMm: c, text: on + (c == null ? '' : (c < DEFAULTS.atCornerMm ? ' at its corner' : ' at ' + show(c) + ' mm from its corner')) };
  }
  /* The cosine of the angle the line makes with the surface's normal as it leaves the anchor (d points away from the
     piece): bigger is more upright. At an edge or corner it is asked of each adjoining face - the one it leaves best
     (convex) or worst (concave); see the header. */
  function leaveCos(A, d) {
    if (!A.faces) return dot(d, A.n);
    var cs = A.faces.map(function (n) { return dot(d, n); });
    return A.rule === 'any' ? Math.max.apply(null, cs) : Math.min.apply(null, cs);
  }
  function withEndNormal(A, d) {
    var o = {}, k, best = null;
    for (k in A) if (Object.prototype.hasOwnProperty.call(A, k)) o[k] = A[k];
    if (A.faces) A.faces.forEach(function (n) { if (best == null || dot(d, n) > dot(d, best)) best = n; });
    o.nEnd = best || A.n;
    return o;
  }
  function segDist(p, a, b) {
    var d = sub(b, a), L2 = dot(d, d), s = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)) : 0;
    return len(sub(p, lerp(a, b, s)));
  }

  /* ------------------------------------------------------------ the shape */
  function sidesFor(r) {
    var n = Math.max(16, Math.min(96, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.01, r * 0.5) / r))));
    if (n % 2) n++;
    return n;
  }

  /* The shape's numbers, validated; or a refusal. */
  function readShape(shape, opts) {
    var s = { shape: shape };
    if (shape === 'string') {
      s.d = opt(opts, 'diameterMm');
      if (!(s.d > 0)) return refuse(shape, 'the string needs a diameter above 0 mm');
      s.rMax = s.d / 2; s.minLen = s.d;
      s.wA = s.wB = s.d;
      s.size = 'Ø' + show(s.d);
    } else if (shape === 'ribbon') {
      s.w = opt(opts, 'widthMm'); s.t = opt(opts, 'thicknessMm');
      if (!(s.w > 0) || !(s.t > 0)) return refuse(shape, 'the ribbon needs a width and a thickness above 0 mm');
      s.rMax = Math.hypot(s.w, s.t) / 2; s.minLen = Math.max(s.w, s.t);
      s.wA = s.wB = s.w;
      s.size = show(s.w) + ' × ' + show(s.t) + ' mm';
    } else if (shape === 'tube') {
      s.d = opt(opts, 'tubeDiaMm'); s.wall = opt(opts, 'wallMm');
      if (!(s.d > 0)) return refuse(shape, 'the tube needs a diameter above 0 mm');
      if (!(s.wall > 0)) return refuse(shape, 'the tube needs a wall above 0 mm');
      if (s.wall >= s.d / 2 - 1e-9) {
        return refuse(shape, 'a ' + show(s.wall) + ' mm wall leaves no bore in a Ø' + show(s.d) + ' tube - the wall has to be under half the diameter (' +
          show(s.d / 2) + ' mm)');
      }
      s.rMax = s.d / 2; s.rBore = s.d / 2 - s.wall; s.minLen = s.d;
      s.wA = s.wB = s.d;
      s.size = 'Ø' + show(s.d) + ' × ' + show(s.wall) + ' wall';
    } else if (shape === 'tapered') {
      s.dA = opt(opts, 'diaAMm'); s.dB = opt(opts, 'diaBMm');
      if (!(s.dA > 0) || !(s.dB > 0)) return refuse(shape, 'the tapered connector needs a diameter above 0 mm at both ends');
      s.rMax = Math.max(s.dA, s.dB) / 2; s.minLen = Math.max(s.dA, s.dB);
      s.wA = s.dA; s.wB = s.dB;
      s.size = 'Ø' + show(s.dA) + ' → Ø' + show(s.dB);
    } else {
      return refuse(null, 'unknown shape "' + shape + '" - String, Ribbon, Tube or Tapered');
    }
    return s;
  }

  /* The shape's frame about the axis u: e1 and e2 span the section; for a
     ribbon w (the width) is e1 and f (the thickness, the flat face's normal)
     is e2. */
  function frameFor(shape, u, nA, nB) {
    if (shape !== 'ribbon') { var e1 = anyPerp(u); return { u: u, e1: e1, e2: cross(u, e1), w: null, f: null, levelFallback: false }; }
    var avg = add(nA, nB);
    var f = sub(avg, mul(u, dot(avg, u)));
    var fallback = false;
    if (len(f) < DEFAULTS.perpFloor) {
      fallback = true;
      f = sub([0, 0, 1], mul(u, u[2]));
      if (len(f) < 1e-6) f = sub([1, 0, 0], mul(u, u[0]));
    }
    f = unit(f);
    var w = unit(cross(f, u));           // then cross(u, w) = f
    return { u: u, e1: w, e2: f, w: w, f: f, levelFallback: fallback };
  }

  function rectProfile(w, t) {
    return [[-w / 2, -t / 2], [w / 2, -t / 2], [w / 2, t / 2], [-w / 2, t / 2]];
  }

  /* The outline of the shape's section at an anchor c: the points the seat
     depth is measured with (the rim). */
  function rimAt(spec, c, fr, r) {
    var out = [], i, n, a;
    if (spec.shape === 'ribbon') {
      var hw = spec.w / 2, ht = spec.t / 2, W = fr.w, F = fr.f;
      [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]].forEach(function (q) {
        out.push(add(c, add(mul(W, q[0] * hw), mul(F, q[1] * ht))));
      });
      return out;
    }
    n = sidesFor(r);
    for (i = 0; i < n; i++) {
      a = 2 * Math.PI * i / n;
      out.push(add(c, add(mul(fr.e1, r * Math.cos(a)), mul(fr.e2, r * Math.sin(a)))));
    }
    return out;
  }

  /* One rod along `pts`, the shape's section. `up` seeds the section's frame on
     the first segment; `k` scales the section (the "does it cross a piece" body
     is the same rod, a hair slimmer); `radii` are a taper's radius at each path
     point.

     A taper on a straight (2-point) path is NSO_PathSweep's own `scales`. On a
     curve it is swept at unit radius and every ring is then scaled about its
     own path point: a mitre ring is the profile's offsets stretched in the bend
     plane, which is linear in the profile, so the scaled ring is the mitre ring
     of the scaled profile. */
  function rod(spec, up, pts, radii, k) {
    var S = sweeper(), o = { points: pts, up: up };
    k = k || 1;
    if (spec.shape === 'ribbon') o.profile = rectProfile(spec.w * k, spec.t * k);
    else if (spec.shape === 'tapered') {
      o.profile = S.profileRegular(sidesFor(spec.rMax), 1);
      if (pts.length === 2) o.scales = [radii[0] * k, radii[1] * k];
    } else {
      var r = spec.shape === 'tube' ? spec.rMax : spec.d / 2;
      o.profile = S.profileRegular(sidesFor(r), r * k);
    }
    var sw = S.sweep(o);
    if (sw.ok && spec.shape === 'tapered' && pts.length > 2) sw = taperRings(sw, radii, k);
    return sw;
  }
  function taperRings(sw, radii, k) {
    var rings = sw.rings.map(function (ring, i) {
      var c = sw.pts[i], r = radii[i] * k;
      return ring.map(function (q) { return add(c, mul(sub(q, c), r)); });
    });
    for (var i = 0; i + 1 < rings.length; i++) for (var j = 0; j < rings[i].length; j++) {
      if (!(dot(sub(rings[i + 1][j], rings[i][j]), sw.segs[i].u) > 1e-9)) {
        return { ok: false, reason: 'the taper is too wide for the curve there - its inside would fold over itself' };
      }
    }
    var out = {};
    for (var key in sw) if (Object.prototype.hasOwnProperty.call(sw, key)) out[key] = sw[key];
    out.rings = rings; out.tris = null;
    return out;
  }

  // Wind a closed soup the other way (a bore: its material is outside it).
  function flipped(soup) {
    var out = new Float32Array(soup.length);
    for (var o = 0; o < soup.length; o += 9) {
      for (var c = 0; c < 3; c++) {
        out[o + c] = soup[o + c];
        out[o + 3 + c] = soup[o + 6 + c];
        out[o + 6 + c] = soup[o + 3 + c];
      }
    }
    return out;
  }
  function concat(a, b) {
    var out = new Float32Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  /* The rod's triangles, from the sweep's own rings (NSO_PathSweep has done
     the profile, the frame and its gates), with two things the sweep's
     two-ring walls do not do:

       STATIONS. A wall triangle that runs the whole length of a long rod is
       hundreds of times longer than it is wide, and the boolean cuts it into
       slivers a ten-thousandth of a millimetre across wherever a piece's
       facets cross it. The walls are cut every `segMm` along their rails
       (a rail is a straight line, so a station on it is exact and every wall
       quad stays planar - the sweep's own argument). On a curve this is done
       between every two rings; it only bites on the straight runs at the ends.

       FLUSH ENDS. When `ends` is given, { a: [point, normal], b: [point,
       normal] }, each end ring slides along its own rail onto the plane
       through that point with that normal. The end cap, fanned from the point
       where the axis meets that plane, stays a flat polygon. Returns null when
       a rail would not reach its plane in the right order.

     Winding and the cap fan are the sweep's (start cap, walls, end cap). */
  function emitRod(sw, segMm, ends) {
    var R = sw.rings.length, M = sw.rings[0].length, j;
    var rings = sw.rings.slice();
    var apexA = sw.pts[0], apexB = sw.pts[sw.pts.length - 1];
    if (ends) {
      var r0 = [], rN = [];
      if (R === 2) {
        for (j = 0; j < M; j++) {
          var v = rings[0][j], w = rings[1][j], d = sub(w, v);
          var dA = dot(d, ends.a[1]), dB = dot(d, ends.b[1]);
          if (!(dA > 1e-9) || !(dB < -1e-9)) return null;
          var pa = add(v, mul(d, dot(sub(ends.a[0], v), ends.a[1]) / dA));
          var pb = add(v, mul(d, dot(sub(ends.b[0], v), ends.b[1]) / dB));
          if (!(dot(sub(pb, pa), d) > 0)) return null;
          r0.push(pa); rN.push(pb);
        }
      } else {
        for (j = 0; j < M; j++) {
          var v0 = rings[0][j], w0 = rings[1][j], d0 = sub(w0, v0), dA0 = dot(d0, ends.a[1]);
          var v1 = rings[R - 2][j], w1 = rings[R - 1][j], d1 = sub(w1, v1), dB1 = dot(d1, ends.b[1]);
          if (!(dA0 > 1e-9) || !(dB1 < -1e-9)) return null;
          var qa = add(v0, mul(d0, dot(sub(ends.a[0], v0), ends.a[1]) / dA0));
          var qb = add(v1, mul(d1, dot(sub(ends.b[0], v1), ends.b[1]) / dB1));
          if (!(dot(sub(w0, qa), d0) > 0) || !(dot(sub(qb, v1), d1) > 0)) return null;   // each slid ring still ends its own run
          r0.push(qa); rN.push(qb);
        }
      }
      rings[0] = r0; rings[R - 1] = rN;
      // The axis meets each end plane here (the path point itself when the plane passes through it).
      var ua = sw.segs[0].u, ub = sw.segs[sw.segs.length - 1].u;
      apexA = add(sw.pts[0], mul(ua, dot(sub(ends.a[0], sw.pts[0]), ends.a[1]) / dot(ua, ends.a[1])));
      apexB = add(sw.pts[sw.pts.length - 1], mul(ub, dot(sub(ends.b[0], sw.pts[sw.pts.length - 1]), ends.b[1]) / dot(ub, ends.b[1])));
    }
    var all = [rings[0]], total = 0, k, g;
    for (g = 0; g + 1 < R; g++) {
      var run = 0;
      for (j = 0; j < M; j++) run = Math.max(run, len(sub(rings[g + 1][j], rings[g][j])));
      var K = Math.max(1, Math.ceil(run / segMm - 1e-9));
      total += K;
      for (k = 1; k < K; k++) {
        var ring = [];
        for (j = 0; j < M; j++) ring.push(lerp(rings[g][j], rings[g + 1][j], k / K));
        all.push(ring);
      }
      all.push(rings[g + 1]);
    }
    var out = new Float32Array((2 * M * total + 2 * M) * 9), w2 = 0;
    function emit(a, b, c) {
      out[w2++] = a[0]; out[w2++] = a[1]; out[w2++] = a[2];
      out[w2++] = b[0]; out[w2++] = b[1]; out[w2++] = b[2];
      out[w2++] = c[0]; out[w2++] = c[1]; out[w2++] = c[2];
    }
    var first = all[0], last = all[all.length - 1];
    for (j = 0; j < M; j++) emit(apexA, first[(j + 1) % M], first[j]);
    for (k = 0; k + 1 < all.length; k++) {
      var Ra = all[k], Rb = all[k + 1];
      for (j = 0; j < M; j++) {
        var j2 = (j + 1) % M;
        emit(Ra[j], Ra[j2], Rb[j2]);
        emit(Ra[j], Rb[j2], Rb[j]);
      }
    }
    for (j = 0; j < M; j++) emit(apexB, last[j], last[(j + 1) % M]);
    return { tris: out, stations: total, rings: [rings[0], rings[R - 1]] };
  }

  /* ---------------------------------------------------- the ends' own solids

     A Foot pad is a disc, a Ball a sphere: closed, wound outward, built here
     and unioned with the connector by weld(). */
  function ringAbout(c, n, rad, z, phase) {
    var e1 = anyPerp(n), e2 = cross(n, e1), N = sidesFor(rad), out = [], i, a, o = add(c, mul(n, z));
    for (i = 0; i < N; i++) {
      a = 2 * Math.PI * (i + (phase || 0)) / N;
      out.push(add(o, add(mul(e1, rad * Math.cos(a)), mul(e2, rad * Math.sin(a)))));
    }
    return out;
  }
  // A closed disc about the axis n through c, from z0 to z1 along n.
  function discSoup(c, n, rad, z0, z1, phase) {
    var lo = ringAbout(c, n, rad, z0, phase), hi = ringAbout(c, n, rad, z1, phase), N = lo.length, o = 0, i;
    var bc = add(c, mul(n, z0)), tc = add(c, mul(n, z1));
    var out = new Float32Array(N * 4 * 9);
    function emit(a, b, d) {
      out[o++] = a[0]; out[o++] = a[1]; out[o++] = a[2];
      out[o++] = b[0]; out[o++] = b[1]; out[o++] = b[2];
      out[o++] = d[0]; out[o++] = d[1]; out[o++] = d[2];
    }
    for (i = 0; i < N; i++) emit(bc, lo[(i + 1) % N], lo[i]);
    for (i = 0; i < N; i++) {
      var i2 = (i + 1) % N;
      emit(lo[i], lo[i2], hi[i2]);
      emit(lo[i], hi[i2], hi[i]);
    }
    for (i = 0; i < N; i++) emit(tc, hi[i], hi[(i + 1) % N]);
    return out;
  }
  // A geodesic sphere (icosahedron, split until a chord dips under 0.02 mm), vertices on the sphere.
  function ballSoup(c, r, spin) {
    var t = (1 + Math.sqrt(5)) / 2, cs = Math.cos(spin || 0), sn = Math.sin(spin || 0);
    var V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
             [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(unit)
      .map(function (q) { return [q[0] * cs - q[1] * sn, q[0] * sn + q[1] * cs, q[2]]; });   // turned about Z by `spin`
    var F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
             [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    var levels = 0, edge = 1.1071487;                       // an icosahedron edge subtends this many radians
    while (levels < 5 && r * (1 - Math.cos(edge / 2)) > 0.02) { levels++; edge /= 2; }
    for (var l = 0; l < levels; l++) {
      var cache = {}, nf = [];
      var mid = function (a, b) {
        var key = a < b ? a + '_' + b : b + '_' + a;
        if (cache[key] === undefined) { V.push(unit(add(V[a], V[b]))); cache[key] = V.length - 1; }
        return cache[key];
      };
      F.forEach(function (f) {
        var ab = mid(f[0], f[1]), bc = mid(f[1], f[2]), ca = mid(f[2], f[0]);
        nf.push([f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]);
      });
      F = nf;
    }
    var out = new Float32Array(F.length * 9), o = 0;
    F.forEach(function (f) {
      f.forEach(function (vi) { var q = add(c, mul(V[vi], r)); out[o++] = q[0]; out[o++] = q[1]; out[o++] = q[2]; });
    });
    return out;
  }

  /* ----------------------------------------------------------------- the path

     straightPath: the line, as ticket 1 had it. arcPath: the circle through both
     anchors with sagitta |sag|, bowing along v (sign folded in), in the plane
     the chord and v span. Arc length s from A: angle th = -alpha + s / R from
     the apex, and

        point(s) = A + u (L/2 + R sin th) + v (2 R sin(s / 2R) sin(alpha - s / 2R))

     (the v term is R (cos th - cos alpha) by the product-to-sum rule, written so
     a huge R - a hair of sag over a long span - does not cancel to noise).

     which is A at s = 0, B at s = 2 R alpha, and the apex (sag h along v) at
     th = 0. alpha = atan2(L/2, R - h) runs past a right angle when h > L/2 (a
     hoop). The first and last `endStraightMm` of arc are cut off and replaced by
     the straight chord to the anchor; between them an EVEN number of equal steps
     (so a vertex lands on the apex), each at most stepMm - and no more than
     stepTurnRad of turn, which only a tight curve reaches. */
  function straightPath(A, B, u, L) {
    return { straight: true, pts: [A.p, B.p], st: [0, L], len: L, tA: u, tB: u, sagMm: 0 };
  }

  // The direction positive sag bows: up in the vertical plane through the anchors;
  // stacked one above the other, away from the centroid (+Y if that is no help).
  function bowDirection(u, A, B, centroid) {
    var v = sub([0, 0, 1], mul(u, u[2]));
    if (len(v) >= DEFAULTS.stackedSin) return unit(v);
    var h = centroid ? sub(lerp(A.p, B.p, 0.5), centroid) : [0, 0, 0];
    h = [h[0], h[1], 0];
    h = sub(h, mul(u, dot(h, u)));
    return len(h) > 1e-6 ? unit(h) : anyPerp(u);
  }

  // The volume centroid of a closed soup; the mean of its vertices when it holds no volume.
  function centroidOf(soup) {
    var n = triCount(soup), vol = 0, cx = [0, 0, 0], mean = [0, 0, 0], t, o, a, b, c, v6;
    for (t = 0; t < n; t++) {
      o = t * 9;
      a = [soup[o], soup[o + 1], soup[o + 2]]; b = [soup[o + 3], soup[o + 4], soup[o + 5]]; c = [soup[o + 6], soup[o + 7], soup[o + 8]];
      v6 = dot(a, cross(b, c));
      vol += v6 / 6;
      cx = add(cx, mul(add(add(a, b), c), v6 / 24));
      mean = add(mean, add(add(a, b), c));
    }
    if (Math.abs(vol) > 1e-9) return mul(cx, 1 / vol);
    return n ? mul(mean, 1 / (3 * n)) : [0, 0, 0];
  }

  /* The straight end is endStraightMm long (the chord from the anchor to where
     the arc resumes) - or more, when the connector is wide and leaves steeply:
     where it crosses the surface its side runs r * tan(leave angle) either side
     of the anchor along its axis, and that whole stretch (and a mm of margin)
     has to be straight, or a flush cut or a sink would reach into the bend. It is
     found by iteration: a longer straight end leaves flatter, which needs less,
     so it settles in a step or two. */
  function arcPath(A, B, u, L, sag, reach, getCentroid) {
    var h = Math.abs(sag), sgn = sag < 0 ? -1 : 1;
    var v = mul(bowDirection(u, A, B, getCentroid()), sgn);
    var R = (L * L / 4 + h * h) / (2 * h);
    var alpha = Math.atan2(L / 2, (L * L / 4 - h * h) / (2 * h));
    var arcLen = 2 * R * alpha;
    function at(s) {
      var th = -alpha + s / R;
      return add(add(A.p, mul(u, L / 2 + R * Math.sin(th))), mul(v, 2 * R * Math.sin(s / (2 * R)) * Math.sin(alpha - s / (2 * R))));
    }
    // chord c of arc -> arc length: 2 R asin(c / 2R)
    function arcOf(c) { return 2 * R * Math.asin(Math.min(1, c / (2 * R))); }
    var cap = 2 * R * Math.sin(alpha / 4);                    // the chord of a quarter of the arc
    var e = Math.min(DEFAULTS.endStraightMm, cap);
    for (var it = 0; it < 8; it++) {
      var cosA = leaveCos(A, unit(sub(at(arcOf(e)), A.p))), cosB = leaveCos(B, unit(sub(at(arcLen - arcOf(e)), B.p)));
      var tilt = function (c) { return Math.tan(Math.acos(clamp1(Math.max(c, 1e-6)))); };
      var need = Math.min(cap, Math.max(DEFAULTS.endStraightMm, reach * Math.max(tilt(cosA), tilt(cosB)) + 1));
      if (need <= e + 1e-9) break;
      e = need;
    }
    var se = arcOf(e), mid = arcLen - 2 * se;
    var step = Math.min(DEFAULTS.stepMm, R * DEFAULTS.stepTurnRad);
    var n = Math.max(2, 2 * Math.ceil(mid / (2 * step) - 1e-9));
    if (n > 600) {
      // Not sampled - but how it leaves each anchor is known, and plan() says that first (it is the likelier reason).
      return { ok: false, tA: unit(sub(at(se), A.p)), tB: unit(sub(B.p, at(arcLen - se))),
               reason: 'a sag of ' + signed(sag) + ' mm over ' + show(L) + ' mm is a curve ' + show(arcLen) + ' mm long and ' + show(R) + ' mm in radius - more than a connector can be swept round; use less sag' };
    }
    var pts = [A.p];
    for (var i = 0; i <= n; i++) pts.push(at(se + mid * i / n));
    pts.push(B.p);
    var st = [0];
    for (var k = 1; k < pts.length; k++) st.push(st[k - 1] + len(sub(pts[k], pts[k - 1])));
    return { straight: false, pts: pts, st: st, len: st[st.length - 1], tA: unit(sub(pts[1], pts[0])), tB: unit(sub(B.p, pts[pts.length - 2])),
             sagMm: sag, bow: v, radiusMm: R, halfAngle: alpha, arcMm: arcLen, endMm: e, steps: n };
  }

  /* The part of the path between arc lengths s0 and s1 from A, and the segment it
     starts in. A path vertex closer than minSeg to either cut is dropped (the
     cut then runs straight on to the next one): a sliver of a first segment
     is eaten by the mitre at its far end. */
  function cutPath(path, s0, s1, minSeg) {
    if (path.straight) return { pts: [add(path.pts[0], mul(path.tA, s0)), add(path.pts[0], mul(path.tA, s1))], st: [s0, s1], seg: 0 };
    var n = path.pts.length, k0 = 0, i;
    function seg(s) { var k = 0; while (k + 2 < n && path.st[k + 1] < s) k++; return k; }
    function at(s) {
      var k = seg(s), f = (s - path.st[k]) / (path.st[k + 1] - path.st[k]);
      return lerp(path.pts[k], path.pts[k + 1], Math.max(0, Math.min(1, f)));
    }
    k0 = seg(s0);
    var pts = [at(s0)], st = [s0];
    var m = Math.max(1e-6, minSeg || 0);
    for (i = 0; i < n; i++) if (path.st[i] > s0 + m && path.st[i] < s1 - m) { pts.push(path.pts[i]); st.push(path.st[i]); }
    pts.push(at(s1)); st.push(s1);
    return { pts: pts, st: st, seg: k0 };
  }

  /* --------------------------------------------- does this cross that */
  function boxOf(p) {
    return { lo: [Math.min(p[0][0], p[1][0], p[2][0]), Math.min(p[0][1], p[1][1], p[2][1]), Math.min(p[0][2], p[1][2], p[2][2])],
             hi: [Math.max(p[0][0], p[1][0], p[2][0]), Math.max(p[0][1], p[1][1], p[2][1]), Math.max(p[0][2], p[1][2], p[2][2])] };
  }
  function trisOf(soup) {
    var out = [], n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var o = t * 9, p = [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]];
      out.push({ p: p, box: boxOf(p) });
    }
    return out;
  }
  function soupBox(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) for (var c = 0; c < 3; c++) {
      var v = soup[i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
    }
    return { lo: lo, hi: hi };
  }
  /* Does `body` cross `piece`? NSO_Repair's own triangle test, the piece
     narrowed to the triangles near the body first. */
  function crosses(bodyTris, bodyBox, piece) {
    need('NSO_Repair.js (_triTriIntersect)', typeof NSO_Repair !== 'undefined' && NSO_Repair && NSO_Repair._triTriIntersect);
    var tt = NSO_Repair._triTriIntersect, n = triCount(piece), g = 1e-6;
    for (var t = 0; t < n; t++) {
      var o = t * 9, ok = true;
      for (var c = 0; c < 3 && ok; c++) {
        var lo = Math.min(piece[o + c], piece[o + 3 + c], piece[o + 6 + c]), hi = Math.max(piece[o + c], piece[o + 3 + c], piece[o + 6 + c]);
        if (hi < bodyBox.lo[c] - g || lo > bodyBox.hi[c] + g) ok = false;
      }
      if (!ok) continue;
      var q = [[piece[o], piece[o + 1], piece[o + 2]], [piece[o + 3], piece[o + 4], piece[o + 5]], [piece[o + 6], piece[o + 7], piece[o + 8]]], qb = boxOf(q);
      for (var i = 0; i < bodyTris.length; i++) {
        var b = bodyTris[i].box;
        if (b.hi[0] < qb.lo[0] || b.lo[0] > qb.hi[0] || b.hi[1] < qb.lo[1] || b.lo[1] > qb.hi[1] || b.hi[2] < qb.lo[2] || b.lo[2] > qb.hi[2]) continue;
        var p = bodyTris[i].p;
        if (tt(p[0], p[1], p[2], q[0], q[1], q[2])) return true;
      }
    }
    return false;
  }

  /* ----------------------------------------------------------------- plan

     pieces: [soup, ...] (world, Z up). a, b: { piece, target } with target from
     NSO_Bridge.pick on that piece's index. opts:
       shape 'string' | 'ribbon' | 'tube' | 'tapered'      result 'weld' | 'separate'
       diameterMm | widthMm, thicknessMm | tubeDiaMm, wallMm | diaAMm, diaBMm
       sagMm    signed mid-span offset of the path, 0 straight
       ends     'weld' | 'flat' | 'pad' | 'ball'
       others   soups of every other piece on the plate (a third piece in the way)
       aim      handed to NSO_Assemble.rootGap
       sinkMm / leaveDeg / clearMm   Bridge's own, defaulting to Bridge's */
  function plan(pieces, a, b, opts) {
    opts = opts || {};
    var shape = opts.shape || DEFAULTS.shape;
    if (SHAPES.indexOf(shape) < 0) return refuse(null, 'unknown shape "' + shape + '" - String, Ribbon, Tube or Tapered');
    var result = opts.result === 'separate' ? 'separate' : 'weld';
    var ends = (opts.ends == null || opts.ends === '') ? DEFAULTS.ends : opts.ends;
    if (ENDS.indexOf(ends) < 0) return refuse(shape, 'unknown ends "' + ends + '" - Weld, Flat, Foot pad or Ball');
    if (ends === 'flat' && result === 'weld') {
      return refuse(shape, 'Flat ends are cut flush with the surface and not sunk, so there is nothing to weld them with - pick Keep separate, or Weld, Foot pad or Ball ends');
    }
    var okA = a && a.target && a.target.kind, okB = b && b.target && b.target.kind;
    if (!okA || !okB) {
      return refuse(shape, (!okA && !okB) ? 'anchors A and B are both missing - pick them on the pieces'
        : 'anchor ' + (okA ? 'B' : 'A') + ' is missing - pick it on a piece');
    }
    var spec = readShape(shape, opts);
    if (spec.ok === false) return spec;
    var sag = opt(opts, 'sagMm');
    if (!(Math.abs(sag) >= DEFAULTS.sagEps)) sag = 0;

    var A = anchorOf(a), B = anchorOf(b);
    if (!A || !B || !A.n || !B.n) return refuse(shape, 'an anchor has no surface normal to leave from');

    // A ribbon is no wider than twice the shorter anchor edge it spans.
    if (shape === 'ribbon') {
      var edges = [A, B].filter(function (x) { return x.edge; }).map(function (x) { return x.edge.lengthMm; });
      if (edges.length) {
        var shortest = Math.min.apply(null, edges), cap = DEFAULTS.ribbonOverEdge * shortest;
        if (spec.w > cap + 1e-9) {
          return refuse(shape, 'a ' + show(spec.w) + ' mm wide ribbon is more than ' + DEFAULTS.ribbonOverEdge + '× the shorter anchor edge (' +
            show(shortest) + ' mm) - at most ' + show(cap) + ' mm; narrow it, or anchor on a longer edge');
        }
      }
    }

    var L = len(sub(B.p, A.p));
    if (L < spec.minLen) {
      return refuse(shape, 'the connector would be ' + show(L) + ' mm long, shorter than its own ' +
        (shape === 'ribbon' ? 'width' : 'Ø') + ' ' + show(spec.minLen) + ' - pick anchors further apart, or make it smaller');
    }
    var u = mul(sub(B.p, A.p), 1 / L);
    var leave = Math.cos(rad(bopt(opts, 'leaveDeg')));

    // The path: the line, or the arc through both anchors.
    var path;
    if (sag === 0) path = straightPath(A, B, u, L);
    else {
      path = arcPath(A, B, u, L, sag, spec.rMax, function () {
        var cs = [a.piece].concat(b.piece === a.piece ? [] : [b.piece]).map(function (i) { return centroidOf(pieces[i]); });
        return cs.length === 1 ? cs[0] : mul(add(cs[0], cs[1]), 0.5);
      });
    }
    var Lp = path.len;
    var cA = leaveCos(A, path.tA), cB = leaveCos(B, mul(path.tB, -1));
    if (!(cA > leave) || !(cB > leave)) {
      var which = !(cA > leave) ? 'first' : 'second', wc = which === 'first' ? cA : cB;
      if (path.straight) {
        return refuse(shape, 'the connector would pass through the ' + which + ' piece - from anchor ' + (which === 'first' ? 'A' : 'B') +
          ' the line to the other one runs ' + (wc <= 0 ? 'into the piece' : 'along its surface') + ', not away from it');
      }
      return refuse(shape, 'the connector would pass through the ' + which + ' piece - a sag of ' + signed(sag) + ' mm turns it so that at anchor ' +
        (which === 'first' ? 'A' : 'B') + ' it runs ' + (wc <= 0 ? 'into the piece' : 'along its surface') + ', not away from it - use less sag');
    }
    if (path.ok === false) return refuse(shape, path.reason);
    var fr = frameFor(shape, u, A.n, B.n);
    // At an edge or corner the line may leave level with a face, so a ring vertex on that face's plane (through the axis)
    // would meet the boolean exactly: turn the section half a facet, and none does.
    if ((A.faces || B.faces) && shape !== 'ribbon') {
      var half = Math.PI / sidesFor(spec.rMax), ch = Math.cos(half), sh = Math.sin(half), e1h = add(mul(fr.e1, ch), mul(fr.e2, sh));
      fr.e2 = sub(mul(fr.e2, ch), mul(fr.e1, sh)); fr.e1 = e1h;
    }
    // The normal the ends sit on: the face the line leaves best (at an edge or corner), else the one normal.
    A = withEndNormal(A, path.tA); B = withEndNormal(B, mul(path.tB, -1));

    // The frame the section carries along the curve, and what it is at each end (the rims are measured in it).
    var fa = fr, fb = fr, up = fr.e1, bf = null;
    if (!path.straight) {
      var up0 = rotateMin(fr.e1, u, path.tA) || fr.e1;
      bf = sweeper().buildFrames(path.pts, { up: up0 });
      if (!bf.ok) return refuse(shape, 'the curve could not be framed (' + bf.reason + ')');
      var frameOf = function (k) { var f = bf.frames[k]; return { u: bf.segs[k].u, e1: f.r, e2: f.s, w: f.r, f: f.s }; };
      fa = frameOf(0); fb = frameOf(bf.frames.length - 1); up = bf.frames[0].r;
    }

    // Radii of a taper, along the path: r(s), s measured from anchor A.
    var rA = spec.dA ? spec.dA / 2 : 0, rB = spec.dB ? spec.dB / 2 : 0;
    function rAt(s) { return rA + (rB - rA) * s / Lp; }

    var sink = bopt(opts, 'sinkMm'), clr = bopt(opts, 'clearMm');
    var sunk = ends === 'weld' && result === 'weld';                           // sunk into both pieces, unioned
    var flush = ends === 'flat' || (ends === 'weld' && result === 'separate'); // cut flush at the surface plane
    var padT = DEFAULTS.padThickMm;
    var gapA = 0, gapB = 0, engA = 0, engB = 0, tips = null, tipsFor = null, ropt = opts.aim ? { aim: opts.aim } : {};
    if (sunk || (ends === 'pad' && result === 'weld')) {
      need('nso_assemble.js (NSO_Assemble.rootGap)', typeof NSO_Assemble !== 'undefined' && NSO_Assemble && NSO_Assemble.rootGap);
    }
    if (sunk) {
      var rimR = function (s) { return shape === 'tapered' ? rAt(s) : spec.rMax; };
      var gA = NSO_Assemble.rootGap(pieces[a.piece], rimAt(spec, A.p, fa, rimR(0)), ropt);
      var gB = NSO_Assemble.rootGap(pieces[b.piece], rimAt(spec, B.p, fb, rimR(Lp)), ropt);
      if (!gA.ok || !gB.ok) return refuse(shape, (gA.ok ? gB : gA).reason);
      gapA = gA.gapMm; gapB = gB.gapMm; engA = gapA + sink; engB = gapB + sink;
    }

    // The swept body: the path, run on into the pieces when sunk.
    var pts = path.pts.slice(), radii = null;
    if (sunk) {
      pts[0] = sub(A.p, mul(path.tA, engA));
      pts[pts.length - 1] = add(B.p, mul(path.tB, engB));
    }
    if (shape === 'tapered') {
      radii = pts.map(function (q, i) {
        if (i === 0) return sunk ? rAt(-engA) : rA;
        if (i === pts.length - 1) return sunk ? rAt(Lp + engB) : rB;
        return rAt(path.st[i]);
      });
      if (sunk && (!(radii[0] > 0) || !(radii[radii.length - 1] > 0))) {
        return refuse(shape, 'the taper, run on into the pieces, would close to a point inside one of them - a smaller difference between the two Ø');
      }
    }
    var sw = rod(spec, up, pts, radii, 1);
    if (!sw.ok) return refuse(shape, path.straight ? sw.reason : 'the connector will not sweep round that curve (' + sw.reason + ') - use less sag, or a slimmer connector');
    // A pad's connector ends inside the disc (mid-thickness), clear of the disc's own faces; a ball's runs to its centre.
    var cut = null;
    if (flush) cut = { a: [A.p, A.nEnd], b: [B.p, B.nEnd] };
    else if (ends === 'pad') cut = { a: [add(A.p, mul(A.nEnd, padT / 2)), A.nEnd], b: [add(B.p, mul(B.nEnd, padT / 2)), B.nEnd] };
    var em = emitRod(sw, DEFAULTS.stationMm, cut);
    if (!em) return refuse(shape, 'the ends could not be cut flush with the surfaces - the connector runs too nearly along one of them');
    var web = em.tris;

    // The tube's bore: sealed, one wall clear of each surface (of a pad's disc), wound inward.
    var bore = null;
    if (shape === 'tube') {
      var bgA = sunk ? gapA : (ends === 'pad' ? padT / 2 : 0), bgB = sunk ? gapB : (ends === 'pad' ? padT / 2 : 0);
      var bd = function (c, gap) { var cos = Math.max(1e-6, c); return gap + spec.wall / cos + spec.rBore * Math.tan(Math.acos(clamp1(c))); };
      var dA = bd(cA, bgA), dB = bd(cB, bgB);
      if (dA + dB >= Lp) {
        return refuse(shape, 'the tube is too short for its bore - it needs ' + show(dA + dB) + ' mm between the anchors to keep a ' +
          show(spec.wall) + ' mm wall at each end, and has ' + show(Lp));
      }
      var bp, bup = up;
      if (path.straight) bp = [add(A.p, mul(path.tA, dA)), sub(B.p, mul(path.tA, dB))];
      else { var bc = cutPath(path, dA, Lp - dB, 0.3 * spec.rBore + 0.1); bp = bc.pts; bup = bf.frames[bc.seg].r; }
      var bs = rod({ shape: 'string', d: 2 * spec.rBore, rMax: spec.rBore }, bup, bp, null, 1);
      if (!bs.ok) return refuse(shape, bs.reason);
      bore = { fromMm: dA, toMm: Lp - dB, lengthMm: Lp - dA - dB, rBore: spec.rBore };
      web = concat(web, flipped(emitRod(bs, DEFAULTS.stationMm, null).tris));
    }

    // Foot pads and balls: closed solids of their own, unioned with the connector by weld().
    if (ends === 'pad') {
      var skirt = [0, 0], rp = [DEFAULTS.padScale * spec.wA / 2, DEFAULTS.padScale * spec.wB / 2];
      if (result === 'weld') {
        // Welded, the disc's foot runs down into the piece by its own rim gap + sink, as a connector's end would.
        var pg = [NSO_Assemble.rootGap(pieces[a.piece], ringAbout(A.p, A.nEnd, rp[0], 0), ropt),
                  NSO_Assemble.rootGap(pieces[b.piece], ringAbout(B.p, B.nEnd, rp[1], 0), ropt)];
        if (!pg[0].ok || !pg[1].ok) return refuse(shape, (pg[0].ok ? pg[1] : pg[0]).reason);
        skirt = [pg[0].gapMm + sink, pg[1].gapMm + sink];
      }
      tipsFor = function (ph) { return [discSoup(A.p, A.nEnd, rp[0], -skirt[0], padT, ph), discSoup(B.p, B.nEnd, rp[1], -skirt[1], padT, ph)]; };
    } else if (ends === 'ball') {
      tipsFor = function (ph) { return [ballSoup(A.p, DEFAULTS.ballScale * spec.wA / 2, ph * 0.09), ballSoup(B.p, DEFAULTS.ballScale * spec.wB / 2, ph * 0.09)]; };
    }
    if (tipsFor) tips = tipsFor(0);

    var plan = { ok: true, kind: shape, shape: shape, result: result, ends: ends, sagMm: sag, web: tips ? concat(concat(web, tips[0]), tips[1]) : web,
                 body: web, tips: tips, tipsFor: tipsFor, A: a, B: b, pieces: pieces, lengthMm: L, pathLengthMm: Lp, axis: u,
                 path: { straight: path.straight, points: path.pts, stationsMm: path.st, bow: path.bow || null, radiusMm: path.radiusMm || null,
                         endStraightMm: path.endMm != null ? path.endMm : null, steps: path.steps || null, startDir: path.tA, endDir: path.tB },
                 leave: [cA, cB],
                 frame: fr, anchors: [A, B], spec: spec, segments: sidesFor(spec.rMax), engageMm: sunk ? [engA, engB] : null,
                 rimGapMm: sunk ? [gapA, gapB] : null, bore: bore, endRings: em.rings, stations: em.stations };

    /* Guard: the exposed connector through a piece. It stays clear of each
       welded end by the rim gap plus how far its side runs on past the anchor
       when it leaves the surface at an angle (as Bridge's string does). A
       third piece has no end on it, so the whole run is held to it. On a curve
       the run is measured along the path. */
    var offA = gapA + spec.rMax * Math.tan(Math.acos(clamp1(cA))) + clr, offB = gapB + spec.rMax * Math.tan(Math.acos(clamp1(cB))) + clr;
    var K = DEFAULTS.boreScale;
    var others = (opts.others || []).map(function (o) { return o && o.soup ? o : { soup: o, name: null }; }).filter(function (o) { return o.soup && o.soup.length; });
    function bodyBetween(s0, s1) {
      var cp = cutPath(path, s0, s1, 0.3 * spec.rMax + 0.1);
      var c = rod(spec, path.straight ? up : bf.frames[cp.seg].r, cp.pts, radii ? cp.st.map(rAt) : null, K);
      if (!c.ok) return null;
      var ct = c.tris || emitRod(c, 1e9, null).tris;                           // a curved taper is rings only
      return { tris: trisOf(ct), box: soupBox(ct) };   // the check needs no stations: a crossing is a crossing
    }
    var what = path.straight ? 'the connector' : 'the curved connector';
    if (offA + offB < Lp) {
      var near = bodyBetween(offA, Lp - offB);
      if (near) {
        var pi = [a.piece].concat(b.piece === a.piece ? [] : [b.piece]);
        for (var i = 0; i < pi.length; i++) {
          if (crosses(near.tris, near.box, pieces[pi[i]])) {
            return refuse(shape, what + ' would pass through ' + (a.piece === b.piece ? 'the piece' : (pi[i] === a.piece ? 'the first piece' : 'the second piece')) +
              (path.straight ? ' - something stands between the two anchors' : ' - a sag of ' + signed(sag) + ' mm takes it through the piece; use less sag, or the other way'));
          }
        }
      }
    }
    if (others.length) {
      var whole = bodyBetween(0, Lp);
      var tipBodies = tips ? tips.map(function (t) { return { tris: trisOf(t), box: soupBox(t) }; }) : [];
      for (var j = 0; j < others.length; j++) {
        var nm = others[j].name ? ' (' + others[j].name + ')' : '';
        if (whole && crosses(whole.tris, whole.box, others[j].soup)) {
          return refuse(shape, 'the ' + (path.straight ? 'straight' : 'curved') + ' connector passes through a third piece' + nm +
            ' - move it out of the way, or pick anchors with a clear line between them' + (path.straight ? '' : ', or change the sag'));
        }
        for (var q = 0; q < tipBodies.length; q++) {
          if (crosses(tipBodies[q].tris, tipBodies[q].box, others[j].soup)) {
            return refuse(shape, 'the ' + ENDS_WORD[ends] + ' at anchor ' + (q ? 'B' : 'A') + ' passes through a third piece' + nm + ' - move it out of the way, or use another end');
          }
        }
      }
    }

    plan.text = describe(spec, L, result, ends, sag, Lp);
    return plan;
  }

  function describe(spec, L, result, ends, sag, pathLen) {
    var name = { string: 'String', ribbon: 'Ribbon', tube: 'Tube', tapered: 'Tapered' }[spec.shape];
    return name + ' ' + spec.size + ', ' + show(L) + ' mm between the anchors' +
      (sag ? ', sag ' + signed(sag) + ' (path ' + show(pathLen) + ' mm)' : '') +
      (ends !== 'weld' ? ', ' + ENDS_WORD[ends] + ' ends' : '') + ' · ' +
      (result === 'weld' ? 'welds into A and B' : 'kept as its own piece');
  }

  /* --------------------------------------------------------------- weld

     The ends first: a pad or a ball is unioned with the connector (A's, then
     B's; each must merge, as every union here must), and with nothing else.
     Then Weld: NSO_Bridge.weld's own two unions and closed-solid check, handed
     the boolean as opts.union. Separate: the connector is the piece, and it has
     to be closed - no boolean at all unless there were tips to join.

     A boolean can leave a sliver a few 1e-5 mm across where a cut line passes
     that close to a vertex of the disc or ball: closed to the kernel, collapsed
     to the closed-solid check (and to mesh_validate, which welds at 1e-4). It is
     a coincidence of where the facets fall, so when the result has tips the whole
     build is tried again with them turned a fraction of a facet, a handful of
     times; if none comes out clean the first kernel-clean result stands. A
     connector with no tips has nothing to turn and is built once, as before. */
  function weld(p, opts) {
    if (!p || !p.ok) return Promise.resolve(p || refuse(null, 'nothing planned'));
    var unionFn = opts && opts.union;
    function joined(attempt) {
      if (!p.tips) return Promise.resolve({ ok: true, soup: p.web, stats: null });
      var word = ENDS_WORD[p.ends];
      if (typeof unionFn !== 'function') return Promise.resolve({ ok: false, reason: 'no boolean kernel to join the ' + word + ' ends to the connector with' });
      var tips = attempt ? p.tipsFor(TIP_PHASES[attempt]) : p.tips;
      return unionFn(p.body, tips[0]).then(function (u1) {
        if (!u1 || !u1.ok) return { ok: false, reason: 'the ' + word + ' at A would not join the connector (' + ((u1 && u1.reason) || 'union failed') + ')' };
        return unionFn(u1.soup, tips[1]).then(function (u2) {
          if (!u2 || !u2.ok) return { ok: false, reason: 'the ' + word + ' at B would not join the connector (' + ((u2 && u2.reason) || 'union failed') + ')' };
          return { ok: true, soup: u2.soup, stats: u2.stats };
        });
      });
    }
    function clean(soup) {
      var t = bridge().topology(soup);
      return !(t.open || t.nm || t.badWinding || t.degenerate);
    }
    function build(attempt) {
      var again = p.tips && attempt + 1 < TIP_PHASES.length;
      return joined(attempt).then(function (j) {
        if (!j.ok) return refuse(p.kind, j.reason);
        if (p.result === 'separate') {
          var topo = bridge().topology(j.soup);
          var vol = bridge().volume(j.soup);
          if (topo.open || topo.nm || topo.badWinding || topo.degenerate || !(vol > 0)) {
            if (again) return build(attempt + 1);
            return refuse(p.kind, 'the connector would not be a closed piece (' + topo.open + ' open edge(s), ' + topo.nm +
              ' non-manifold, ' + topo.badWinding + ' wound the wrong way' + (topo.degenerate ? ', ' + topo.degenerate + ' collapsed' : '') +
              ', volume ' + vol.toFixed(3) + ') - nothing added');
          }
          return { ok: true, kind: p.kind, result: 'separate', soup: j.soup, topo: topo, kernel: j.stats, plan: p, text: p.text, volumeMm3: vol };
        }
        var q = p;
        if (p.tips) { q = {}; for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) q[k] = p[k]; q.web = j.soup; }
        return bridge().weld(q, opts).then(function (r) {
          if (r && r.ok) { r.result = 'weld'; r.plan = p; }
          if (!again || !r || !r.ok || clean(r.soup)) return r;
          return build(attempt + 1).then(function (r2) { return (r2 && r2.ok && clean(r2.soup)) ? r2 : r; });
        });
      });
    }
    return build(0);
  }

  var API = {
    SHAPES: SHAPES,
    ENDS: ENDS,
    DEFAULTS: DEFAULTS,
    plan: plan,
    anchor: anchor,
    weld: weld,
    emitRod: emitRod
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Connect = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
