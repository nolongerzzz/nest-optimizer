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
 * CONSUMERS. The round and tapered support branches (nso_support_tree.js,
 * nso_support_aim.js), Stock (nso_stock.js), and G-scope's solid view and
 * Export as solid (nso-gcode-solid.js), which sweeps each continuous run of a
 * sliced toolpath - and is the reason for `sweepClosed` and `failAt`.
 * Bend (nso_bend.js) carries a piece's own section round an arc with
 * `sweepArc` - radial stations, any number of loops, convex or not - and is
 * the reason for it and for `sectionLoops`; docs/CURVING-PATH.md section 8. This
 * file itself has no UI, no bake and no undo entry. See the paint-scope note
 * at the bottom.
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
          ok: false, failAt: { point: k + 1, kind: 'short' },
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
          ok: false, failAt: { point: j, kind: 'reversal' },
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
        return { ok: false, failAt: { point: v, kind: 'reversal' }, reason: 'path doubles back on itself at point ' + v + '; no bisector plane exists' };
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
   *   scales     [s0, s1]                 optional, a STRAIGHT (2-point) path only:
   *                                       the profile is scaled by s0 at the start
   *                                       and s1 at the end - a frustum. Exact for
   *                                       the same reason the prism is: every rail
   *                                       j runs from P0 + s0*o_j to P1 + s1*o_j,
   *                                       all of them pass through the one apex
   *                                       where the scale reaches 0, so each wall
   *                                       quad lies in a plane through that apex
   *                                       and is planar (wallPlanarity measures
   *                                       it). Refused on a path with joints: a
   *                                       mitre ring is computed from rails that
   *                                       are parallel to their segment, and a
   *                                       tapered rail is not.
   *
   * Returns { ok, reason, tris, rings, stats }. On refusal `tris` is null and
   * `reason` names the specific rail or joint that stopped it - never a bare
   * "could not build". Path refusals also carry `failAt`, the same place in
   * machine form - `{ point: v }` (a joint or a too-short step ending at
   * point v) or `{ segment: k }` (a segment the miters ate) - so a caller
   * that splits a long path where it cannot be swept does not parse prose.
   */
  function sweep(opts) {
    opts = opts || {};
    var prof = opts.profile;
    var pc = profileCheck(prof);
    if (!pc.ok) return { ok: false, reason: pc.reason, tris: null };

    var fr = buildFrames(opts.points, opts);
    if (!fr.ok) return { ok: false, reason: fr.reason, failAt: fr.failAt, tris: null };

    var pts = fr.pts, segs = fr.segs, frames = fr.frames, joints = fr.joints;
    var M = prof.length, N = pts.length;
    var scales = null;
    if (opts.scales != null) {
      if (N !== 2) {
        return { ok: false, tris: null, reason: 'scales (a taper) is only exact on a straight 2-point path; ' +
          'this one has ' + N + ' points, and a mitre ring needs rails parallel to their segment' };
      }
      scales = [+opts.scales[0], +opts.scales[1]];
      if (!(scales[0] > 0 && scales[1] > 0)) {
        return { ok: false, tris: null, reason: 'scales must both be positive, got ' + JSON.stringify(opts.scales) };
      }
    }
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
    var sc0 = scales ? scales[0] : 1, sc1 = scales ? scales[1] : 1;
    for (var j0 = 0; j0 < M; j0++) r0.push(add(pts[0], mul(off(0, j0), sc0)));
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
            ok: false, tris: null, failAt: { point: v, kind: 'seam' },
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
    for (var jL = 0; jL < M; jL++) rL.push(add(pts[N - 1], mul(off(lastK, jL), sc1)));
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
            ok: false, tris: null, failAt: { segment: k, kind: 'eaten' },
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
        scales: scales ? scales.slice() : null,
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
  // the closed sweep - a loop with no caps
  // ===========================================================================

  /**
   * Evaluate a CLOSED path + profile into a watertight ring-shaped soup: the
   * path runs P0 .. P(N-1) and back to P0, every vertex is a mitred joint, and
   * there are no caps at all. Same options as `sweep` except `scales` (a taper
   * has no meaning round a loop) - pass the points WITHOUT repeating P0.
   *
   * It is `sweep` itself, run on the path unrolled once past the start
   * (P0 .. P(N-1), P0, P1), so every ring - the one at P0 included - is built
   * and gated by exactly the code the open sweep uses. Two things are then
   * checked that an open path never has to face:
   *
   *   - HOLONOMY. The frame carried all the way round must come back to the
   *     frame it started with, or the ring at P0 (computed from the last
   *     segment's frame) does not meet the walls of segment 0 (built from the
   *     first). A loop in one plane closes exactly: every joint rotates about
   *     the plane's normal, which fixes the seed `up` when that is the normal.
   *     A twisted space loop does not, and is refused by name rather than
   *     twisted to fit.
   *   - SEGMENT 0's RAILS, which the unrolled sweep checked against its flat
   *     start ring; round a loop they start at the mitred ring at P0 instead.
   *
   * Returns the same shape as `sweep`, with `closed: true`.
   */
  function sweepClosed(opts) {
    opts = opts || {};
    if (opts.scales != null) return { ok: false, tris: null, reason: 'a closed sweep cannot taper' };
    var P = opts.points;
    if (!Array.isArray(P) || P.length < 3) {
      return { ok: false, tris: null, reason: 'a closed path needs at least 3 points, got ' + (P ? P.length : 0) };
    }
    var unrolled = P.slice();
    unrolled.push(P[0], P[1]);
    var o = {};
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
    o.points = unrolled;
    var sw = sweep(o);
    if (!sw.ok) return sw;

    var N = P.length, M = opts.profile.length;
    var minRailUlps = opts.minRailUlps == null ? 8 : opts.minRailUlps;
    var seamUlps = opts.seamUlps == null ? 8 : opts.seamUlps;

    // Holonomy: frame N is segment 0 again, reached the long way round.
    var f0 = sw.frames[0], fN = sw.frames[N];
    var drift = Math.max(dist(f0.r, fN.r), dist(f0.s, fN.s));
    // The frame vectors are unit length, so the gap they open at the rails is
    // drift * (profile reach); gate THAT against the float32 grid at the ring.
    var reach = 0;
    for (var j = 0; j < M; j++) reach = Math.max(reach, Math.hypot(opts.profile[j][0], opts.profile[j][1]));
    var ringP0 = sw.rings[N];
    var tol = seamUlps * ulpAt(ringP0[0]);
    if (drift * reach > tol) {
      return {
        ok: false, tris: null,
        reason: 'the loop does not close its frame: carried once round it comes back rotated by ' +
                drift.toExponential(3) + ' (a ' + (drift * reach).toExponential(3) + ' mm gap at the rails, ' +
                'limit ' + tol.toExponential(3) + ' mm). A loop that lies in one plane always closes; a space loop in general does not'
      };
    }

    // Rings of the loop: joints at P1 .. P(N-1), then P0.
    var rings = sw.rings.slice(1, N + 1);   // index i is the ring at P(i+1), last is P0
    // Segment 0 runs from the ring at P0 to the ring at P1.
    var u0 = sw.segs[0].u;
    for (var jj = 0; jj < M; jj++) {
      var a = rings[N - 1][jj], b = rings[0][jj];
      var adv = dot(sub(b, a), u0);
      var floor = minRailUlps * Math.max(ulpAt(a), ulpAt(b));
      if (!(adv > floor)) {
        return {
          ok: false, tris: null,
          reason: 'the miter has eaten segment 0 on rail ' + jj + ' round the loop: it advances ' +
                  adv.toExponential(3) + ' mm (floor ' + floor.toExponential(3) + ' mm)'
        };
      }
    }

    var tris = new Float32Array(2 * M * N * 9);
    var w = 0;
    function emit(p, q, r) {
      tris[w++] = p[0]; tris[w++] = p[1]; tris[w++] = p[2];
      tris[w++] = q[0]; tris[w++] = q[1]; tris[w++] = q[2];
      tris[w++] = r[0]; tris[w++] = r[1]; tris[w++] = r[2];
    }
    // Segment k of the loop runs from the ring at P(k) to the ring at P(k+1);
    // the ring at P(k) is rings[k - 1], and P0's is rings[N - 1].
    for (var k = 0; k < N; k++) {
      var A = rings[(k + N - 1) % N], B = rings[k];
      for (var jw = 0; jw < M; jw++) {
        var j2 = (jw + 1) % M;
        emit(A[jw], A[j2], B[j2]);
        emit(A[jw], B[j2], B[jw]);
      }
    }
    var pathLen = 0;
    for (var ks = 0; ks < N; ks++) pathLen += sw.segs[ks].len;
    var st = {};
    for (var sk in sw.stats) if (Object.prototype.hasOwnProperty.call(sw.stats, sk)) st[sk] = sw.stats[sk];
    st.tris = 2 * M * N;
    st.rings = N;
    st.pathLength = pathLen;
    st.holonomy = drift;
    return {
      ok: true, reason: '', closed: true, tris: tris,
      pts: sw.pts.slice(0, N), rings: rings, frames: sw.frames.slice(0, N),
      segs: sw.segs.slice(0, N), joints: sw.joints.slice(0, N), stats: st
    };
  }

  // ===========================================================================
  // the arc sweep - a section carried rigidly round a circular arc
  //
  // `sweep` mitres: its joint rings sit in bisector planes and are the profile
  // stretched by 1/cos(turn/2) (F4 in docs/CURVING-PATH.md), and it takes one
  // convex profile. A BEND cannot use either half of that. Its promise is that
  // the section is held exact, so every ring here is the section itself, moved
  // by a rotation about the bend axis - a RADIAL station, never a mitre - and
  // its section is whatever the piece has: an outline with holes (a tube), a
  // non-convex outline (a channel, an L), several outlines at once.
  //
  // What makes that possible is giving up the cap. `sweep` needs convexity for
  // two things: the proof that a mitred ring cannot self-cross (a rigid image of
  // a simple loop is simple, so there is nothing to prove here), and the cap
  // fan from the path point (an arc sweep is spliced between two halves of an
  // existing piece and has no caps). So `sweepArc` emits walls only.
  //
  // The arc, in the frame it is given:
  //
  //   origin  a point on the CENTRE LINE at the start of the arc
  //   u       the tangent there (the piece's axis, pointing at the far end)
  //   d       the direction the piece folds TOWARD; the centre of curvature is
  //           origin + R d, and the bend axis is b = u x d
  //   R       the centre line's radius;  theta  the angle (0, pi]
  //
  // A point is named by s along u, h along d and g along b, all from origin.
  // On the arc (0 < s < L = R theta) it lands at radius R - h from the bend
  // axis, turned by phi = s / R:
  //
  //   origin + u (R - h) sin(phi) + d (R - (R - h) cos(phi)) + b g
  //
  // and past it (s >= L) the TAIL turns rigidly with the arc's end:
  //
  //   origin + u ((R - h) sin(theta) + (s - L) cos(theta))
  //          + d (R - (R - h) cos(theta) + (s - L) sin(theta)) + b g
  //
  // which in (s - L, h) is a rotation by theta plus a translation - rigid. A
  // point with s <= 0 does not move. R - h is the only thing that can go wrong:
  // at R - h <= 0 the inside face reaches the bend axis and turns inside out.
  // ===========================================================================

  var HALF_PI = Math.PI / 2;

  /** cos and sin, exact at whole quarter turns (Math.cos(pi/2) is 6e-17). */
  function trigExact(a) {
    var q = a / HALF_PI, k = Math.round(q);
    if (Math.abs(q - k) < 1e-12) {
      var m = ((k % 4) + 4) % 4;
      return [[1, 0], [0, 1], [-1, 0], [0, -1]][m];
    }
    return [Math.cos(a), Math.sin(a)];
  }

  /**
   * Normalise and check an arc. Returns { ok, reason, o, u, d, b, R, theta, L,
   * c, s } with c, s the end's cos and sin (exact at quarter turns).
   */
  function arcFrame(arc) {
    if (!arc) return { ok: false, reason: 'no arc given' };
    var o = arc.origin, u = arc.tangent, d = arc.toward, R = +arc.radius, th = +arc.angle;
    if (!o || !u || !d) return { ok: false, reason: 'an arc needs origin, tangent and toward' };
    if (!(R > 0) || !isFinite(R)) return { ok: false, reason: 'arc radius must be a positive number, got ' + arc.radius };
    if (!(th > 0) || !(th <= Math.PI + 1e-12)) return { ok: false, reason: 'arc angle must be in (0, pi], got ' + arc.angle };
    var uu = norm(u), dd = norm(d);
    if (!(len(uu) > 0) || !(len(dd) > 0)) return { ok: false, reason: 'tangent and toward must be non-zero' };
    if (Math.abs(dot(uu, dd)) > 1e-12) return { ok: false, reason: 'toward must be perpendicular to the tangent' };
    var cs = trigExact(th);
    return { ok: true, o: [+o[0], +o[1], +o[2]], u: uu, d: dd, b: cross(uu, dd), R: R, theta: th,
             L: R * th, c: cs[0], s: cs[1] };
  }

  /** h and g of a point: its offsets along d and b from the frame origin. */
  function arcHG(F, p) {
    var q = sub(p, F.o);
    return [dot(q, F.d), dot(q, F.b)];
  }

  /**
   * A point on the station at fraction t of the arc (phi = t theta). `p` is the
   * point's UNBENT position on that station's plane; only its h and g are read.
   * t === 0 returns p itself, untouched; t === 1 is `arcTail`, so a ring at
   * either end of the arc is bit for bit the point the rest of the piece puts
   * there.
   */
  function arcPoint(F, p, t) {
    if (t === 0) return p;
    if (t === 1) return arcTail(F, p);
    var hg = arcHG(F, p), rho = F.R - hg[0], phi = t * F.theta;
    var su = rho * Math.sin(phi), sd = F.R - rho * Math.cos(phi);
    return [F.o[0] + F.u[0] * su + F.d[0] * sd + F.b[0] * hg[1],
            F.o[1] + F.u[1] * su + F.d[1] * sd + F.b[1] * hg[1],
            F.o[2] + F.u[2] * su + F.d[2] * sd + F.b[2] * hg[1]];
  }

  /** A point past the arc (s >= L), turned rigidly with the arc's end. */
  function arcTail(F, p) {
    var q = sub(p, F.o);
    var s2 = dot(q, F.u) - F.L, h = dot(q, F.d), g = dot(q, F.b), rho = F.R - h;
    var su = rho * F.s + s2 * F.c, sd = F.R - rho * F.c + s2 * F.s;
    return [F.o[0] + F.u[0] * su + F.d[0] * sd + F.b[0] * g,
            F.o[1] + F.u[1] * su + F.d[1] * sd + F.b[1] * g,
            F.o[2] + F.u[2] * su + F.d[2] * sd + F.b[2] * g];
  }

  /**
   * How many equal steps the arc is cut into. Two limits, the tighter wins:
   *
   *   sag      the chord between two stations on the OUTERMOST radius rOut dips
   *            at most sagMm (default 0.02 mm) inside the true arc:
   *            rOut (1 - cos(step / 2)) <= sagMm.
   *   volume   between two stations every point of the section runs along a
   *            chord, so the slab holds A rho_c sin(step) where the true arc
   *            holds A rho_c step: short by step^2 / 6. volFrac (default 5e-4)
   *            caps that, so the volume the arc encloses is A x the length its
   *            centroid travels to within 0.05%, however small the radius.
   *            (The sag rule alone lets it reach 0.4% on a tight fold.)
   */
  function arcSteps(theta, rOut, opts) {
    opts = opts || {};
    if (opts.steps != null) return Math.max(1, opts.steps | 0);
    var sag = opts.sagMm == null ? 0.02 : +opts.sagMm;
    var volFrac = opts.volFrac == null ? 5e-4 : +opts.volFrac;
    var dSag = rOut > sag / 2 ? 2 * Math.acos(Math.max(-1, 1 - sag / rOut)) : Math.PI;
    var dVol = Math.sqrt(6 * volFrac);
    return Math.max(1, Math.ceil(theta / Math.min(dSag, dVol) - 1e-9));
  }

  /**
   * Sweep section loops round an arc. Walls only - no caps.
   *
   *   opts.arc        { origin, tangent, toward, radius, angle } (see above)
   *   opts.loops      the section at the START of the arc: an array of closed
   *                   loops of 3D points, all on the plane s = 0. Any number of
   *                   loops, convex or not. Each runs counter-clockwise about
   *                   +u in the (d, b) plane when its material is inside it (an
   *                   outline) and clockwise when it is outside (a bore): the
   *                   material is on the loop's left. The outward wall of the
   *                   segment p -> q then faces (q - p) x u.
   *   opts.loopsEnd   optional, the same loops on the plane s = L, still
   *                   unbent. Point j of a loop may sit anywhere along the
   *                   section between the two ends (a wall triangle's diagonal
   *                   crosses the section at a different place on each plane);
   *                   station i takes the straight blend at t = i / n, which is
   *                   on the same wall. Default: the start loops moved by L u.
   *   opts.minInsideMm  the smallest radius a point may end at; default 0
   *   opts.steps / sagMm / volFrac   see arcSteps
   *
   * Ring 0 is opts.loops itself (the same arrays), ring n is arcTail of
   * opts.loopsEnd: a caller that runs its own geometry through arcTail gets
   * the identical numbers, so the splice needs no weld tolerance.
   *
   * Returns { ok, reason, tris, rings[i][loop][j], steps, stats }.
   */
  function sweepArc(opts) {
    opts = opts || {};
    var F = arcFrame(opts.arc);
    if (!F.ok) return { ok: false, reason: F.reason, tris: null };
    var A = opts.loops;
    if (!Array.isArray(A) || !A.length) return { ok: false, reason: 'no section loops', tris: null };
    var B = opts.loopsEnd;
    if (B == null) {
      B = A.map(function (lp) { return lp.map(function (p) { return add(p, mul(F.u, F.L)); }); });
    }
    if (!Array.isArray(B) || B.length !== A.length) return { ok: false, reason: 'loopsEnd does not match loops', tris: null };

    // Radii, orientation.
    var rIn = Infinity, rOut = -Infinity, inAt = null, area = 0, M = 0;
    for (var l = 0; l < A.length; l++) {
      var lp = A[l];
      if (!Array.isArray(lp) || lp.length < 3) return { ok: false, reason: 'section loop ' + l + ' has fewer than 3 points', tris: null };
      if (!Array.isArray(B[l]) || B[l].length !== lp.length) return { ok: false, reason: 'loopsEnd[' + l + '] does not match loops[' + l + ']', tris: null };
      M += lp.length;
      for (var e = 0; e < 2; e++) {
        var L2 = e ? B[l] : lp;
        for (var j = 0; j < L2.length; j++) {
          var hg = arcHG(F, L2[j]), rho = F.R - hg[0];
          if (rho < rIn) { rIn = rho; inAt = { loop: l, point: j }; }
          if (rho > rOut) rOut = rho;
        }
      }
      for (var j2 = 0; j2 < lp.length; j2++) {
        var p = arcHG(F, lp[j2]), q = arcHG(F, lp[(j2 + 1) % lp.length]);
        area += (p[0] * q[1] - q[0] * p[1]) / 2;
      }
    }
    if (!(area > 0)) {
      return { ok: false, tris: null, reason: 'section loops are wound the wrong way (net area ' + area.toExponential(3) +
               ' about +u): an outline runs counter-clockwise, a bore clockwise' };
    }
    var minIn = opts.minInsideMm == null ? 0 : +opts.minInsideMm;
    if (!(rIn > minIn)) {
      return { ok: false, tris: null, failAt: inAt, rInside: rIn,
               reason: 'the inside of the section would end ' + (rIn <= 0 ? (-rIn).toFixed(4) + ' mm past the bend axis - it turns inside out'
                 : rIn.toFixed(4) + ' mm from the bend axis, under the ' + minIn + ' mm floor') +
                 ' (radius ' + F.R + ' mm to the centre line)' };
    }

    var n = arcSteps(F.theta, rOut, opts);
    var rings = [];
    for (var i = 0; i <= n; i++) {
      var t = i === n ? 1 : i / n, ring = [];
      for (var l2 = 0; l2 < A.length; l2++) {
        var out = [];
        for (var j3 = 0; j3 < A[l2].length; j3++) {
          var a = A[l2][j3], b2 = B[l2][j3];
          var pt = (t === 0) ? a : (t === 1) ? b2
            : [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t, a[2] + (b2[2] - a[2]) * t];
          out.push(arcPoint(F, pt, t));
        }
        ring.push(out);
      }
      rings.push(ring);
    }

    var nTri = 2 * M * n;
    var tris = new Float32Array(nTri * 9), w = 0;
    function emit(a, b, c) {
      tris[w++] = a[0]; tris[w++] = a[1]; tris[w++] = a[2];
      tris[w++] = b[0]; tris[w++] = b[1]; tris[w++] = b[2];
      tris[w++] = c[0]; tris[w++] = c[1]; tris[w++] = c[2];
    }
    for (var k = 0; k < n; k++) {
      for (var l3 = 0; l3 < A.length; l3++) {
        var RA = rings[k][l3], RB = rings[k + 1][l3], m = RA.length;
        for (var jw = 0; jw < m; jw++) {
          var j4 = (jw + 1) % m;
          emit(RA[jw], RA[j4], RB[j4]);
          emit(RA[jw], RB[j4], RB[jw]);
        }
      }
    }
    var step = F.theta / n;
    return {
      ok: true, reason: '', tris: tris, rings: rings, steps: n, frame: F,
      stats: { tris: nTri, steps: n, stepRad: step, rInside: rIn, rOutside: rOut,
               sagMm: rOut * (1 - Math.cos(step / 2)), loops: A.length, points: M, sectionArea: area }
    };
  }

  // ===========================================================================
  // measurement helpers - used by the self-test, and deliberately independent
  // of the construction above. They read the emitted buffer and nothing else.
  // ===========================================================================

  /**
   * Slice a triangle soup with a plane. Returns every loop of section points,
   * each chained end to end - one for a rod, an outer and a bore for a tube -
   * or null if the cut does not fall apart into closed loops. Loops come in
   * the order their first point was met, unoriented; `loopArea` measures each.
   *
   * This is how the cross-section promise is CHECKED rather than asserted: it
   * forgets how the mesh was made and measures the solid that came out.
   */
  function sectionLoops(tris, point, normal, opts) {
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

    // Nodes are found through a grid whose cell is the largest weld distance
    // any point here can have, so two points close enough to weld are in the
    // same or neighbouring cells. Among those, the LOWEST-numbered node within
    // its weld distance wins - exactly the node a scan of every node in order
    // would return; the grid only skips the ones too far away to matter.
    var cell = 0;
    for (var cc = 0; cc < cuts.length; cc++) {
      cell = Math.max(cell, weldUlps * ulpAt(cuts[cc][0]), weldUlps * ulpAt(cuts[cc][1]));
    }
    if (!(cell > 0)) cell = 1e-12;
    var nodes = [], grid = new Map();
    function cellKey(i, j, k) { return i + ',' + j + ',' + k; }
    function nodeFor(p) {
      var ci = Math.floor(p[0] / cell), cj = Math.floor(p[1] / cell), ck = Math.floor(p[2] / cell), best = -1;
      for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) for (var dk = -1; dk <= 1; dk++) {
        var bucket = grid.get(cellKey(ci + di, cj + dj, ck + dk));
        if (!bucket) continue;
        for (var b = 0; b < bucket.length; b++) {
          var i = bucket[b];
          if ((best < 0 || i < best) && near(nodes[i].p, p)) best = i;
        }
      }
      if (best >= 0) return best;
      nodes.push({ p: p, links: [] });
      var key = cellKey(ci, cj, ck);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(nodes.length - 1);
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

    // Every node has degree 2, so the segments fall apart into closed loops:
    // walk each one from its lowest unvisited node.
    var used = new Array(nSeg), seen = new Array(nodes.length), loops = [];
    for (var start = 0; start < nodes.length; start++) {
      if (seen[start]) continue;
      var loop = [], at = start;
      for (;;) {
        seen[at] = true;
        loop.push(nodes[at].p);
        var lk = nodes[at].links, go = null;
        for (var z = 0; z < lk.length; z++) if (!used[lk[z].seg]) { go = lk[z]; break; }
        if (!go) break;
        used[go.seg] = true;
        at = go.other;
        if (at === start) break;
      }
      if (at !== start || loop.length < 3) return null;   // a chain that does not close
      loops.push(loop);
    }
    return loops;
  }

  /**
   * One loop, or null: `sectionLoops` for a section that must be a single
   * closed outline (a solid profile). A tube's section is two loops and reads
   * null here; ask `sectionLoops` for it.
   */
  function sectionLoop(tris, point, normal, opts) {
    var loops = sectionLoops(tris, point, normal, opts);
    return (loops && loops.length === 1) ? loops[0] : null;
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
    sweepClosed: sweepClosed,
    arcFrame: arcFrame,
    arcPoint: arcPoint,
    arcTail: arcTail,
    arcSteps: arcSteps,
    sweepArc: sweepArc,
    sectionLoop: sectionLoop,
    sectionLoops: sectionLoops,
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
