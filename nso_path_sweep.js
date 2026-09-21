/*
 * NSO curving-path sweep - the first multi-segment path primitive in the app.
 * ==========================================================================
 *
 * WHY THIS FILE EXISTS
 *
 * Every geometry the app builds today is placed by ONE rigid transform. The
 * plate pose is nine loose scalars on a placed entry - `x`, `z`, `rotY`,
 * `flipX`, `tipX`, `tipZ`, `tiltX`, `tiltZ`, `liftY` - read back by
 * `applyMeshRotation()` in app-core.js as a fixed-order XYZ Euler plus a
 * bounding-box-derived rest height. It says where a whole piece sits. It has
 * no tangent, no frame, no sequence and no composition rule, so it cannot
 * describe "this shape follows that route". See docs/CURVING-PATH.md for the
 * full audit.
 *
 * A curving support branch needs the thing the pose record is not: an ordered
 * run of oriented stations, each carrying a cross-section, evaluated into
 * triangles. That is what this file is.
 *
 * WHAT IT IS
 *
 * A mitred polyline sweep. Give it N >= 2 path points and one closed convex
 * 2D profile; it emits a watertight, 2-manifold triangle soup in the app's
 * usual format (Float32Array, 9 floats per triangle, no shared index).
 *
 * The correctness argument is Extend's, carried round a corner. Extend holds a
 * cross-section exactly because a triangle whose normal satisfies `n.u = 0`
 * lies in a plane CONTAINING `u`, so sliding its vertices along `u` leaves it
 * in that same plane. Here the same fact does the same work per segment: for
 * segment k every side wall is a planar quad whose plane contains the segment
 * direction `u_k`, because its four corners lie on two rails parallel to
 * `u_k`. Growth along the segment is therefore exact in the same sense, and
 * the only new question is what happens where two segments meet.
 *
 * At a joint the two segments are cut by their common BISECTOR plane. That
 * choice is forced, not preferred, and it is what makes the seam exact:
 *
 *   - rail j of the incoming segment and rail j of the outgoing segment both
 *     lie in the same plane parallel to the bend plane (their components along
 *     the bend axis are equal, because the frame is carried across the joint by
 *     the minimal rotation, which fixes that axis);
 *   - two non-parallel coplanar lines meet in exactly one point;
 *   - that point is on the bisector plane.
 *
 * So the ring at a joint is ONE ring, reached identically from either side.
 * There is no seam to weld, no duplicated vertex, and no tolerance involved -
 * `sweep()` computes each joint ring from the incoming rail and then gates it
 * against the outgoing rail, in float32 ULPs, and refuses if they disagree.
 *
 * WHAT IT DOES NOT PROMISE, AND WHY
 *
 * The cross-section taken PERPENDICULAR to the path is exact everywhere inside
 * a segment. In the bisector plane at a joint it is not: it is the profile
 * stretched by 1/cos(theta/2) along the bend direction, where theta is the turn
 * angle. That is inherent to mitring a constant cross-section through a corner,
 * not a defect of this implementation, and it cannot be removed - only bought
 * down, quadratically, by replacing a corner with an arc of n chords
 * (`arcSubdivide`). docs/CURVING-PATH.md carries the measured table.
 *
 * NOT WIRED IN. No UI, no bake, no undo entry. This file is a primitive and a
 * self-test; wiring is a later ticket. See the paint-scope note at the bottom.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_PathSweep = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ===========================================================================
  // float32 spacing
  //
  // Every tolerance below is counted in ULPs of the float32 grid AT THE
  // COORDINATE MAGNITUDE IN PLAY, never in millimetres. A fixed millimetre gate
  // is either too tight far from the origin or too loose near it: the same
  // sweep built at x = 0 and at x = 1400 differs in representable spacing by
  // more than four orders of magnitude, and the soup is stored as float32
  // whatever the maths ran in.
  // ===========================================================================

  var _f32 = new Float32Array(2);
  var _i32 = new Int32Array(_f32.buffer);

  function ulp32(x) {
    _f32[0] = Math.abs(x);
    if (_f32[0] === 0) { _i32[0] = 1; return _f32[0]; }   // smallest subnormal
    if (!isFinite(_f32[0])) return Infinity;
    var a = _f32[0];
    _i32[0] += 1;
    var up = _f32[0] - a;
    _f32[0] = a;
    return up;
  }

  /** ULP scale appropriate to a point: driven by its largest coordinate. */
  function ulpAt(p) {
    return ulp32(Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])));
  }

  // ===========================================================================
  // small vector helpers (plain arrays, float64 throughout)
  // ===========================================================================

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.hypot(a[0], a[1], a[2]); }
  function norm(a) { var L = len(a); return L > 0 ? [a[0] / L, a[1] / L, a[2] / L] : [0, 0, 0]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  /**
   * Rotate `v` by the MINIMAL rotation carrying unit `from` onto unit `to`.
   *
   * This is discrete parallel transport, and it is the whole reason the frame
   * does not twist: the rotation axis is `from x to`, so any component of the
   * frame along that axis is fixed, and no roll is injected. A frame built from
   * a fixed world up-vector instead would twist arbitrarily and would go
   * singular wherever the path ran parallel to that up-vector.
   *
   * Returns null for an exact reversal (to = -from), where the minimal rotation
   * is not defined: there is no distinguished axis, so there is no answer to
   * pick. `buildFrames` turns that into a named refusal rather than a guess.
   */
  function rotateMin(v, from, to) {
    var ax = cross(from, to);
    var s = len(ax);
    var c = dot(from, to);
    if (s <= 1e-14) {
      if (c > 0) return v.slice();     // same direction - identity
      return null;                     // reversal - undefined axis
    }
    ax = mul(ax, 1 / s);
    var ang = Math.atan2(s, c);
    var ca = Math.cos(ang), sa = Math.sin(ang);
    // Rodrigues
    var t1 = mul(v, ca);
    var t2 = mul(cross(ax, v), sa);
    var t3 = mul(ax, dot(ax, v) * (1 - ca));
    return add(add(t1, t2), t3);
  }

  /** A unit vector perpendicular to unit `u`, chosen deterministically. */
  function anyPerp(u) {
    var ax = Math.abs(u[0]), ay = Math.abs(u[1]), az = Math.abs(u[2]);
    var e = (ax <= ay && ax <= az) ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
    return norm(cross(u, e));
  }

  // ===========================================================================
  // profiles
  // ===========================================================================

  /**
   * Regular n-gon of circumradius r, CCW in the (r, s) frame.
   *
   * CCW about +tangent is the orientation the wall winding below assumes; see
   * `sweep`. `phase` rotates the profile in its own plane, which is the one
   * knob that changes where the mesh seam lands without changing the solid.
   */
  function profileRegular(n, r, phase) {
    if (!(n >= 3)) throw new Error('a profile needs at least 3 points');
    var out = [];
    var ph = phase || 0;
    for (var i = 0; i < n; i++) {
      var a = ph + (2 * Math.PI * i) / n;
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return out;
  }

  /** Signed area of a closed 2D polygon. Positive means CCW. */
  function polyArea(p) {
    var a = 0;
    for (var i = 0, n = p.length; i < n; i++) {
      var q = p[(i + 1) % n];
      a += p[i][0] * q[1] - q[0] * p[i][1];
    }
    return a / 2;
  }

  /**
   * Is the polygon convex, CCW, and does it strictly contain the origin?
   *
   * All three matter and each buys something concrete:
   *   - CONVEX: the ring at a joint is an AFFINE image of the profile (the
   *     miter shift is a linear functional of the profile point), and an affine
   *     image of a convex polygon is convex, so a joint ring can never
   *     self-cross. That is a proof, not a check, and it is why the only
   *     self-intersection gate needed is the per-rail one in `sweep`.
   *   - CCW: fixes the outward winding of every wall triangle.
   *   - ORIGIN INSIDE: the end caps fan from the path endpoint itself, so the
   *     fan is only valid if the endpoint is inside its own ring.
   */
  function profileCheck(p) {
    if (!Array.isArray(p) || p.length < 3) return { ok: false, reason: 'profile needs at least 3 points' };
    var n = p.length;
    var area = polyArea(p);
    if (!(area > 0)) {
      return { ok: false, reason: 'profile is not counter-clockwise (signed area ' + area.toFixed(6) + '); reverse it' };
    }
    for (var i = 0; i < n; i++) {
      var a = p[i], b = p[(i + 1) % n], c = p[(i + 2) % n];
      var cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (!(cr > 0)) {
        return {
          ok: false,
          reason: 'profile is not strictly convex at point ' + ((i + 1) % n) +
                  ' (cross ' + cr.toExponential(3) + '); a mitred sweep proves it cannot ' +
                  'self-cross at a joint only for a convex section'
        };
      }
      // origin strictly left of every edge <=> strictly inside a CCW convex polygon
      var side = (b[0] - a[0]) * (0 - a[1]) - (b[1] - a[1]) * (0 - a[0]);
      if (!(side > 0)) {
        return {
          ok: false,
          reason: 'profile does not strictly contain its own origin (edge ' + i +
                  '); the end caps fan from the path endpoint, which must be inside the ring'
        };
      }
    }
    return { ok: true, area: area, n: n };
  }

  // ===========================================================================
  // frames
  // ===========================================================================

  /**
   * Segment directions and one rotation-minimizing frame per segment.
   *
   * Returns { ok, reason, pts, segs:[{u,len}], frames:[{r,s}], joints:[...] }.
   * `joints[i]` describes path vertex i+1 (the interior ones): bisector normal
   * `m`, turn angle `turn` in radians, and `miter` = 1/cos(turn/2).
   */
  function buildFrames(points, opts) {
    opts = opts || {};
    if (!Array.isArray(points) || points.length < 2) {
      return { ok: false, reason: 'a path needs at least 2 points, got ' + (points ? points.length : 0) };
    }
    var pts = points.map(function (p) { return [+p[0], +p[1], +p[2]]; });
    for (var i = 0; i < pts.length; i++) {
      if (!isFinite(pts[i][0]) || !isFinite(pts[i][1]) || !isFinite(pts[i][2])) {
        return { ok: false, reason: 'path point ' + i + ' is not finite' };
      }
    }

    var segs = [];
    for (var k = 0; k + 1 < pts.length; k++) {
      var d = sub(pts[k + 1], pts[k]);
      var L = len(d);
      // A segment shorter than a few float32 ULPs of where it sits has no
      // reliable direction at all - normalising it amplifies pure rounding.
      var minL = 8 * Math.max(ulpAt(pts[k]), ulpAt(pts[k + 1]));
      if (!(L > minL)) {
        return {
          ok: false,
          reason: 'path points ' + k + ' and ' + (k + 1) + ' are ' + L.toExponential(3) +
                  ' mm apart, under the ' + minL.toExponential(3) +
                  ' mm float32 floor at that magnitude; drop the duplicate'
        };
      }
      segs.push({ u: mul(d, 1 / L), len: L });
    }

    // Seed frame on segment 0, then carry it across every joint by the minimal
    // rotation. `opts.up` only picks the seed; it never constrains later
    // segments, so there is no direction the path is forbidden to take.
    var r0;
    if (opts.up) {
      var up = norm(opts.up);
      var proj = sub(up, mul(segs[0].u, dot(up, segs[0].u)));
      if (len(proj) < 1e-9) {
        return { ok: false, reason: 'opts.up is parallel to the first segment; it cannot seed a frame there' };
      }
      r0 = norm(proj);
    } else {
      r0 = anyPerp(segs[0].u);
    }
    var frames = [{ r: r0, s: cross(segs[0].u, r0) }];
    for (var j = 1; j < segs.length; j++) {
      var rr = rotateMin(frames[j - 1].r, segs[j - 1].u, segs[j].u);
      if (!rr) {
        return {
          ok: false,
          reason: 'path doubles back on itself at point ' + j +
                  ' (segments ' + (j - 1) + ' and ' + j + ' are exactly opposite); ' +
                  'a 180 degree reversal has no bisector plane and no minimal rotation'
        };
      }
      // Re-orthogonalise against the new direction. The rotation is exact in
      // real arithmetic; this removes the float drift it leaves behind, so the
      // frame stays orthonormal over a long path instead of slowly shearing.
      rr = norm(sub(rr, mul(segs[j].u, dot(rr, segs[j].u))));
      frames.push({ r: rr, s: cross(segs[j].u, rr) });
    }

    var joints = [];
    for (var v = 1; v + 1 < pts.length; v++) {
      var a = segs[v - 1].u, b = segs[v].u;
      var mv = add(a, b);
      var mL = len(mv);
      if (mL < 1e-9) {
        return { ok: false, reason: 'path doubles back on itself at point ' + v + '; no bisector plane exists' };
      }
      var m = mul(mv, 1 / mL);
      var turn = Math.atan2(len(cross(a, b)), dot(a, b));
      var cosHalf = dot(b, m);         // = cos(turn/2), and equals dot(a, m)
      joints.push({ at: v, m: m, turn: turn, cosHalf: cosHalf, miter: 1 / cosHalf });
    }

    return { ok: true, pts: pts, segs: segs, frames: frames, joints: joints };
  }

  // ===========================================================================
  // arc subdivision
  // ===========================================================================

  /**
   * Replace every interior corner with a tangent circular arc of `radius`,
   * sampled as `segments` chords.
   *
   * This is the only lever that reduces miter stretch, and it is worth being
   * precise about what it buys: one corner of turn angle t mitred once stretches
   * the section by 1/cos(t/2); split into n chords each joint stretches by
   * 1/cos(t/2n), which is 1 + t^2/(8n^2) + O(n^-4) - quadratic in n once n is
   * large enough for the small-angle form to hold.
   *
   * It buys ACCURACY AND ONLY ACCURACY. It does not make a tight corner
   * buildable, and the arithmetic says why. A single miter needs `r*tan(t/2)`
   * of segment either side of the corner, where `r` is how far the profile
   * reaches in the bend plane. An arc of radius R needs `R*tan(t/2)` of tangent
   * for the same corner, and its own chords are only buildable while
   * `R*cos(t/2n) > r`, so R must exceed r. R > r makes `R*tan(t/2)` strictly
   * bigger than `r*tan(t/2)`: rounding a corner costs MORE segment than
   * mitring it, never less. Measured in tools/nso_path_sweep_test.js.
   *
   * That R > r bound is not an artefact either - it is the same constraint a
   * real bent tube has. You cannot bend a tube round a radius smaller than the
   * tube, because the inside wall would have to pass through itself.
   */
  function arcSubdivide(points, opts) {
    opts = opts || {};
    var radius = opts.radius;
    var nseg = opts.segments == null ? 4 : (opts.segments | 0);
    if (!(radius > 0)) return { ok: false, reason: 'arcSubdivide needs a positive radius' };
    if (!(nseg >= 1)) return { ok: false, reason: 'arcSubdivide needs at least 1 segment per corner' };

    var base = buildFrames(points, opts);
    if (!base.ok) return base;
    if (base.joints.length === 0) return { ok: true, pts: base.pts.slice(), tangent: [] };

    var pts = base.pts, segs = base.segs;

    // Tangent length per corner, and the budget check. Two corners sharing a
    // segment must both fit inside it, so the test is on the sum, not on each
    // corner alone - a corner that fits on its own can still be impossible.
    var T = [];
    for (var i = 0; i < base.joints.length; i++) {
      var t = base.joints[i].turn;
      T.push(radius * Math.tan(t / 2));
    }
    for (var k = 0; k < segs.length; k++) {
      var need = (k === 0 ? 0 : T[k - 1]) + (k === segs.length - 1 ? 0 : T[k]);
      if (need > segs[k].len) {
        return {
          ok: false,
          reason: 'radius ' + radius + ' mm does not fit: segment ' + k + ' is ' +
                  segs[k].len.toFixed(4) + ' mm and its corners want ' + need.toFixed(4) +
                  ' mm of tangent; shorten the radius or lengthen the segment'
        };
      }
    }

    var out = [pts[0].slice()];
    var tangents = [];
    for (var v = 1; v + 1 < pts.length; v++) {
      var jn = base.joints[v - 1];
      var uPrev = segs[v - 1].u, uNext = segs[v].u;
      var tl = T[v - 1];
      var A = add(pts[v], mul(uPrev, -tl));
      var B = add(pts[v], mul(uNext, tl));
      // Centre: perpendicular to the incoming leg at A, toward the turn.
      var inward = norm(sub(uNext, mul(uPrev, dot(uNext, uPrev))));
      var C = add(A, mul(inward, radius));
      var axis = norm(cross(uPrev, uNext));
      var spoke = sub(A, C);
      out.push(A);
      for (var c = 1; c < nseg; c++) {
        var ang = (jn.turn * c) / nseg;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var rot = add(add(mul(spoke, ca), mul(cross(axis, spoke), sa)),
                      mul(axis, dot(axis, spoke) * (1 - ca)));
        out.push(add(C, rot));
      }
      out.push(B);
      tangents.push({ at: v, tangent: tl, turn: jn.turn, centre: C, A: A, B: B });
    }
    out.push(pts[pts.length - 1].slice());
    return { ok: true, pts: out, tangent: tangents };
  }

  // ===========================================================================
  // the sweep
  // ===========================================================================

  /**
   * Evaluate a path + profile into a watertight triangle soup.
   *
   * opts:
   *   points     [[x,y,z], ...]           required, >= 2
   *   profile    [[u,v], ...]             required, convex CCW, origin inside
   *   up         [x,y,z]                  optional frame seed on segment 0
   *   seamUlps   number (default 8)       joint-ring agreement gate, in float32 ULPs
   *   minRailUlps number (default 8)      per-rail forward-progress floor, in ULPs
   *
   * Returns { ok, reason, tris, rings, stats }. On refusal `tris` is null and
   * `reason` names the specific rail or joint that stopped it - never a bare
   * "could not build".
   */
  function sweep(opts) {
    opts = opts || {};
    var prof = opts.profile;
    var pc = profileCheck(prof);
    if (!pc.ok) return { ok: false, reason: pc.reason, tris: null };

    var fr = buildFrames(opts.points, opts);
    if (!fr.ok) return { ok: false, reason: fr.reason, tris: null };

    var pts = fr.pts, segs = fr.segs, frames = fr.frames, joints = fr.joints;
    var M = prof.length, N = pts.length;
    var seamUlps = opts.seamUlps == null ? 8 : opts.seamUlps;
    var minRailUlps = opts.minRailUlps == null ? 8 : opts.minRailUlps;

    /** Profile point j, lifted into segment k's frame. */
    function off(k, j) {
      return add(mul(frames[k].r, prof[j][0]), mul(frames[k].s, prof[j][1]));
    }

    // --- rings -------------------------------------------------------------
    // Ring 0 and ring N-1 are flat perpendicular sections. Every interior ring
    // is the bisector-plane miter, computed from the INCOMING rail and then
    // gated against the OUTGOING one.
    var rings = [];
    var worstSeam = 0, worstSeamUlp = 0, worstSeamAt = -1;

    var r0 = [];
    for (var j0 = 0; j0 < M; j0++) r0.push(add(pts[0], off(0, j0)));
    rings.push(r0);

    for (var v = 1; v + 1 < N; v++) {
      var jn = joints[v - 1];
      var kIn = v - 1, kOut = v;
      var ring = [];
      for (var j = 0; j < M; j++) {
        var oIn = off(kIn, j);
        // Walk the incoming rail from the path vertex to the bisector plane.
        var tIn = -dot(oIn, jn.m) / dot(segs[kIn].u, jn.m);
        var p = add(add(pts[v], oIn), mul(segs[kIn].u, tIn));

        // Independent recomputation down the outgoing rail. In real arithmetic
        // these are the same point; measuring the gap is the only way to know
        // the frame really was carried across by a rotation that fixes the bend
        // axis, rather than assuming it.
        var oOut = off(kOut, j);
        var tOut = -dot(oOut, jn.m) / dot(segs[kOut].u, jn.m);
        var q = add(add(pts[v], oOut), mul(segs[kOut].u, tOut));

        var gap = dist(p, q);
        var tol = seamUlps * ulpAt(p);
        if (gap > worstSeam) { worstSeam = gap; worstSeamAt = v; }
        var inUlps = gap / Math.max(ulpAt(p), Number.MIN_VALUE);
        if (inUlps > worstSeamUlp) worstSeamUlp = inUlps;
        if (gap > tol) {
          return {
            ok: false, tris: null,
            reason: 'joint ring at path point ' + v + ' does not close on rail ' + j +
                    ': incoming and outgoing rails disagree by ' + gap.toExponential(3) +
                    ' mm (' + inUlps.toFixed(2) + ' float32 ULPs, limit ' + seamUlps + ')'
          };
        }
        ring.push(p);
      }
      rings.push(ring);
    }

    var rL = [];
    var lastK = segs.length - 1;
    for (var jL = 0; jL < M; jL++) rL.push(add(pts[N - 1], off(lastK, jL)));
    rings.push(rL);

    // --- the one self-intersection gate that is not a proof -----------------
    // A joint ring is an affine image of a convex profile, so it is convex and
    // cannot self-cross: that much is settled by `profileCheck`. What is NOT
    // settled is whether the miter ate the segment. The inside of a bend pushes
    // its ring BACKWARDS along the rail, and once that push exceeds the segment
    // length the wall inverts and the solid turns itself inside out. The test is
    // per rail and local: every rail must still run forwards.
    var worstMargin = Infinity, worstMarginAt = null;
    for (var k = 0; k < segs.length; k++) {
      for (var jj = 0; jj < M; jj++) {
        var a = rings[k][jj], b = rings[k + 1][jj];
        var adv = dot(sub(b, a), segs[k].u);
        var floor = minRailUlps * Math.max(ulpAt(a), ulpAt(b));
        if (adv < worstMargin) { worstMargin = adv; worstMarginAt = { seg: k, rail: jj }; }
        if (!(adv > floor)) {
          return {
            ok: false, tris: null,
            reason: 'the miter has eaten segment ' + k + ' on rail ' + jj + ': it advances ' +
                    adv.toExponential(3) + ' mm along the segment (floor ' + floor.toExponential(3) +
                    ' mm). The bend is too sharp for this section over this segment length: ' +
                    'lengthen the segment, or thin the profile. Rounding the corner with ' +
                    'arcSubdivide() will NOT help - an arc of radius R needs R*tan(turn/2) of ' +
                    'tangent where the miter needs r*tan(turn/2), and R has to exceed r.'
          };
        }
      }
    }

    // --- triangles ---------------------------------------------------------
    // 2*M per segment for the walls, M per cap. Winding is outward throughout;
    // the self-test checks that by signed volume rather than by argument.
    var nTri = 2 * M * segs.length + 2 * M;
    var tris = new Float32Array(nTri * 9);
    var w = 0;
    function emit(a, b, c) {
      tris[w++] = a[0]; tris[w++] = a[1]; tris[w++] = a[2];
      tris[w++] = b[0]; tris[w++] = b[1]; tris[w++] = b[2];
      tris[w++] = c[0]; tris[w++] = c[1]; tris[w++] = c[2];
    }

    // start cap, normal along -u0, fanned from the path start
    for (var cs = 0; cs < M; cs++) {
      emit(pts[0], rings[0][(cs + 1) % M], rings[0][cs]);
    }
    // walls
    for (var kw = 0; kw < segs.length; kw++) {
      var A = rings[kw], B = rings[kw + 1];
      for (var jw = 0; jw < M; jw++) {
        var j2 = (jw + 1) % M;
        emit(A[jw], A[j2], B[j2]);
        emit(A[jw], B[j2], B[jw]);
      }
    }
    // end cap, normal along +u_last, fanned from the path end
    for (var ce = 0; ce < M; ce++) {
      emit(pts[N - 1], rings[N - 1][ce], rings[N - 1][(ce + 1) % M]);
    }

    var pathLen = 0;
    for (var ks = 0; ks < segs.length; ks++) pathLen += segs[ks].len;

    return {
      ok: true,
      reason: '',
      tris: tris,
      pts: pts,
      rings: rings,
      frames: frames,
      segs: segs,
      joints: joints,
      stats: {
        tris: nTri,
        rings: rings.length,
        profilePts: M,
        profileArea: pc.area,
        pathLength: pathLen,
        worstSeamMm: worstSeam,
        worstSeamUlps: worstSeamUlp,
        worstSeamAt: worstSeamAt,
        worstRailAdvanceMm: worstMargin,
        worstRailAt: worstMarginAt,
        maxMiter: joints.reduce(function (m, j) { return Math.max(m, j.miter); }, 1),
        maxTurnDeg: joints.reduce(function (m, j) { return Math.max(m, j.turn * 180 / Math.PI); }, 0)
      }
    };
  }

  // ===========================================================================
  // measurement helpers - used by the self-test, and deliberately independent
  // of the construction above. They read the emitted buffer and nothing else.
  // ===========================================================================

  /**
   * Slice a triangle soup with a plane. Returns the loop of section points,
   * chained end to end, or null if the cut is not one closed loop.
   *
   * This is how the cross-section promise is CHECKED rather than asserted: it
   * forgets how the mesh was made and measures the solid that came out.
   */
  function sectionLoop(tris, point, normal, opts) {
    opts = opts || {};
    var n = norm(normal);
    var d0 = dot(n, point);
    // Two tolerances, both derived from the float32 grid at the coordinate
    // magnitude in play, neither fixed:
    //
    //   weldUlps   how close two section points must be to be the same point.
    //              A fixed 1e-7 mm looks generous and is not - the soup is
    //              float32 and one ULP at 20 mm is already 1.9e-6 mm, so a
    //              fixed gate silently splits ring vertices in two and the loop
    //              never closes. Same lesson as NSO_weldEpsFor and
    //              NSO_sculptWeldTol, reached from a third direction.
    //
    //   planeUlps  how near the plane a vertex must be to count as ON it.
    //              This one is not an optimisation, it is the whole reason the
    //              most important measurement here is possible at all: the
    //              section that matters most is the one taken EXACTLY in a
    //              joint's bisector plane, and there a whole ring of vertices
    //              lies in the plane, scattered a few float32 ULPs either side
    //              of it. Treating those as ordinary crossings loses the ring
    //              vertices that sit on the bend axis, where the residual is
    //              pure noise with no sign to trust.
    var weldUlps = opts.weldUlps == null ? 32 : opts.weldUlps;
    var planeUlps = opts.planeUlps == null ? 16 : opts.planeUlps;
    var near = function (p, q) { return dist(p, q) <= weldUlps * Math.max(ulpAt(p), ulpAt(q)); };

    var cuts = [];
    var nt = tris.length / 9;
    for (var t = 0; t < nt; t++) {
      var v = [
        [tris[t * 9], tris[t * 9 + 1], tris[t * 9 + 2]],
        [tris[t * 9 + 3], tris[t * 9 + 4], tris[t * 9 + 5]],
        [tris[t * 9 + 6], tris[t * 9 + 7], tris[t * 9 + 8]]
      ];
      var sd = [0, 0, 0], cl = [0, 0, 0], zeros = [];
      for (var i = 0; i < 3; i++) {
        sd[i] = dot(n, v[i]) - d0;
        var eps = planeUlps * ulpAt(v[i]);
        cl[i] = sd[i] > eps ? 1 : (sd[i] < -eps ? -1 : 0);
        if (cl[i] === 0) zeros.push(i);
      }
      if (zeros.length === 3) continue;                  // coplanar face, skip
      if (zeros.length === 2) {
        // A section EDGE lying in the plane. Its twin arrives from the triangle
        // on the other side of it and is dropped by the dedupe below.
        cuts.push([v[zeros[0]], v[zeros[1]]]);
        continue;
      }
      var xs = [];
      for (var e = 0; e < 3; e++) {
        var i0 = e, i1 = (e + 1) % 3;
        if (cl[i0] * cl[i1] >= 0) continue;              // no strict crossing
        var f = sd[i0] / (sd[i0] - sd[i1]);
        xs.push([v[i0][0] + (v[i1][0] - v[i0][0]) * f,
                 v[i0][1] + (v[i1][1] - v[i0][1]) * f,
                 v[i0][2] + (v[i1][2] - v[i0][2]) * f]);
      }
      if (zeros.length === 1) {
        // One vertex on the plane. It is a section point only if the other two
        // straddle; otherwise the plane merely touches the corner.
        if (xs.length === 1) cuts.push([v[zeros[0]], xs[0]]);
        continue;
      }
      if (xs.length === 2) cuts.push(xs);
    }
    if (cuts.length < 3) return null;

    var nodes = [];
    function nodeFor(p) {
      for (var i = 0; i < nodes.length; i++) if (near(nodes[i].p, p)) return i;
      nodes.push({ p: p, links: [] });
      return nodes.length - 1;
    }
    // Coincident duplicates are dropped, not treated as a second edge - see the
    // planeUlps note: in a bisector plane both adjacent segments hand back the
    // same ring edge.
    var nSeg = 0;
    for (var c = 0; c < cuts.length; c++) {
      var a0 = nodeFor(cuts[c][0]), a1 = nodeFor(cuts[c][1]);
      if (a0 === a1) continue;
      var dup = false;
      for (var d = 0; d < nodes[a0].links.length; d++) if (nodes[a0].links[d].other === a1) dup = true;
      if (dup) continue;
      nodes[a0].links.push({ seg: nSeg, other: a1 });
      nodes[a1].links.push({ seg: nSeg, other: a0 });
      nSeg++;
    }
    if (nSeg < 3) return null;
    for (var k = 0; k < nodes.length; k++) if (nodes[k].links.length !== 2) return null;

    var used = new Array(nSeg);
    var loop = [];
    var at = 0;
    for (var step = 0; step < nSeg; step++) {
      loop.push(nodes[at].p);
      var lk = nodes[at].links;
      var go = null;
      for (var z = 0; z < lk.length; z++) if (!used[lk[z].seg]) { go = lk[z]; break; }
      if (!go) break;
      used[go.seg] = true;
      at = go.other;
    }
    if (loop.length !== nSeg || at !== 0) return null;   // not one closed loop
    return loop;
  }

  /** Area of a planar 3D loop, via the vector area. */
  function loopArea(loop, normal) {
    var n = norm(normal);
    var acc = [0, 0, 0];
    for (var i = 0; i < loop.length; i++) {
      acc = add(acc, cross(loop[i], loop[(i + 1) % loop.length]));
    }
    return Math.abs(dot(acc, n)) / 2;
  }

  /**
   * Largest out-of-plane deviation over the four corners of each wall quad.
   *
   * Zero is the claim - a wall quad on a constant-section segment is exactly
   * planar - and this is what turns that claim into a number. It is also the
   * probe that shows where a TAPERED sweep stops being planar.
   */
  function wallPlanarity(rings) {
    var worst = 0, at = null;
    for (var k = 0; k + 1 < rings.length; k++) {
      var A = rings[k], B = rings[k + 1], M = A.length;
      for (var j = 0; j < M; j++) {
        var j2 = (j + 1) % M;
        var p0 = A[j], p1 = A[j2], p2 = B[j2], p3 = B[j];
        var nrm = cross(sub(p1, p0), sub(p2, p0));
        var L = len(nrm);
        if (L === 0) continue;
        var dev = Math.abs(dot(sub(p3, p0), mul(nrm, 1 / L)));
        if (dev > worst) { worst = dev; at = { seg: k, rail: j }; }
      }
    }
    return { worst: worst, at: at };
  }

  return {
    ulp32: ulp32,
    profileRegular: profileRegular,
    profileCheck: profileCheck,
    polyArea: polyArea,
    buildFrames: buildFrames,
    arcSubdivide: arcSubdivide,
    sweep: sweep,
    sectionLoop: sectionLoop,
    loopArea: loopArea,
    wallPlanarity: wallPlanarity,
    _v: { sub: sub, add: add, mul: mul, dot: dot, cross: cross, len: len, norm: norm, dist: dist }
  };

  /*
   * PAINT SCOPE: NOT APPLICABLE (generator, not a bake)
   *
   * Per the scoping rule in docs/HANDOFF.md, a paint-aware feature is one that
   * modifies an existing piece, and it must declare whether it acts on a
   * sub-region or on the whole piece. This file does neither: it takes numbers
   * and returns a NEW soup, and it never reads, writes or touches a placed
   * model. There is no face on any existing piece it could move, so there is
   * nothing for a skip list to protect.
   *
   * That changes the moment a ticket wires this to a piece - attaching a branch
   * to a surface, or fusing one in. The attaching feature is the paint-aware
   * one, it inherits the rule, and it takes a row in the HANDOFF roster and a
   * label in its own source. This file does not, and must not, pre-empt that
   * decision: which category it lands in depends on whether the attachment has
   * an identifiable footprint on the target, which is a question about the
   * attachment, not about the sweep.
   */
});
