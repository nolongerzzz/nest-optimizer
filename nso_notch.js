/* ============================================================
   Notch - the Cut tool's SIZED blade: the geometry core. THREE-free and
   DOM-free, so the whole file runs under node (tools/nso_notch_test.js); the
   app layer is app-cut.js (cutNotchAt).

   Why this exists
   ---------------
   The Cut blade is a full plane: it splits whatever is in its path, all of it,
   all the way through, and it has no thickness. Two things that cannot say:
     - "cut here, between these two things" - a blade smaller than the piece's
       section, so what lies elsewhere in the path is not touched;
     - "cut into this face, not through it" - a notch.
   Both are one thing: a blade that is a finite rectangle in the cut plane, and
   a solid, because a cut that stops partway has a floor and so has a width.
   (A zero-thickness slit in the middle of a solid is not a manifold.) So the
   sized blade is a BOX - kerf thick along the cut plane's normal, `width`
   across it and `depth` along the way it enters - and the cut is that box
   subtracted from the piece. The full blade is untouched and stays a clean
   split; the sized one is a different operation with a different result (one
   piece with a slot in it, or - if the slot severs it - the pieces it leaves).

   Cut frame
   ---------
   Everything here is in the CUT frame of app-cut.js: the piece's frame turned
   so the cut plane is axis-aligned. `axis` (0/1/2) is the plane's normal; the
   other two axes lie in the plane. The blade ENTERS the piece along one of
   them (`dAxis`) in direction `sign` (+1 = toward +coordinate), and is
   `width` wide along the third (`wAxis`).

   The entry follows the face that was clicked: the blade goes in against that
   face's normal, along whichever in-plane axis the normal leans on most. A
   face lying (nearly) in the cut plane has no in-plane lean to read, so the
   blade comes down from above instead - the plate vertical - which is what a
   person pointing at a front face means.
   ============================================================ */
(function (root) {
  'use strict';

  /* Under a nozzle width a slot cannot be printed, and a blade under a
     fraction of a millimetre is a number typed wrong. */
  var MIN_KERF_MM = 0.2;
  var MIN_WIDTH_MM = 0.2;
  var MIN_DEPTH_MM = 0.2;
  var MAX_MM = 1000;
  /* The blade starts this far OUT of the surface it is aimed at, so its edge
     is never coplanar with the face (a coplanar face is the one place a
     boolean is allowed to leave a skin of zero thickness). */
  var OVERSHOOT_MM = 1;
  /* Below this lean the clicked face is read as lying in the cut plane. */
  var LEAN_MIN = 0.35;

  var DEFAULTS = { width: 10, depth: 3, kerf: 1 };

  function clampNum(v, lo, hi, fallback) {
    v = Number(v);
    if (!isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  /* Notch mode: the blade is fitted across the strand, so the user sets only
     how long the nick is ALONG the strand (the kerf) and how far in from its
     edge it goes. The margin is the clear space left either side of the
     strand's section so the cut is clean across it. */
  var NOTCH_DEFAULTS = { width: 1, depth: 1 };
  var NOTCH_MARGIN_MM = 0.5;

  /* The blade's three sizes, clamped to what can be built. */
  function sizes(p) {
    p = p || {};
    if (p.mode === 'notch') {
      return {
        width: DEFAULTS.width,          // replaced by the strand's own width (notchBox)
        depth: clampNum(p.ndepth, MIN_DEPTH_MM, MAX_MM, NOTCH_DEFAULTS.depth),
        kerf: clampNum(p.nwidth, MIN_KERF_MM, MAX_MM, NOTCH_DEFAULTS.width)
      };
    }
    return {
      width: clampNum(p.width, MIN_WIDTH_MM, MAX_MM, DEFAULTS.width),
      depth: clampNum(p.depth, MIN_DEPTH_MM, MAX_MM, DEFAULTS.depth),
      kerf: clampNum(p.kerf, MIN_KERF_MM, MAX_MM, DEFAULTS.kerf)
    };
  }

  /* Which way the blade goes in.
       axis    the plane's normal, 0|1|2
       normal  the clicked face's outward normal in the cut frame, or null
       up      the plate vertical in the cut frame
     -> { dAxis, wAxis, sign } */
  function entryFor(axis, normal, up) {
    var a = (axis + 1) % 3, b = (axis + 2) % 3;
    var best = null;
    if (normal) {
      var na = Math.abs(normal[a]), nb = Math.abs(normal[b]);
      var len = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]) || 1;
      if (Math.max(na, nb) / len >= LEAN_MIN) {
        var d = na >= nb ? a : b;
        best = { dAxis: d, sign: normal[d] > 0 ? -1 : 1 };       // against the face
      }
    }
    if (!best) {
      var upv = up || [0, 1, 0];
      var d2 = Math.abs(upv[a]) >= Math.abs(upv[b]) ? a : b;
      best = { dAxis: d2, sign: upv[d2] > 0 ? -1 : 1 };           // downward
    }
    best.wAxis = best.dAxis === a ? b : a;
    return best;
  }

  /* The blade box in the cut frame.
       a = { axis, dAxis, wAxis, sign, plane, wCentre, dStart, width, depth, kerf }
     plane   where the cut plane sits (cut-frame coordinate on `axis`)
     wCentre the blade's centre across its width
     dStart  the surface the blade is aimed at, on `dAxis`
     -> { min:[x,y,z], max:[x,y,z] }                                       */
  function bladeBox(a) {
    var s = sizes(a);
    var min = [0, 0, 0], max = [0, 0, 0];
    min[a.axis] = a.plane - s.kerf / 2;  max[a.axis] = a.plane + s.kerf / 2;
    min[a.wAxis] = a.wCentre - s.width / 2;  max[a.wAxis] = a.wCentre + s.width / 2;
    var from = a.dStart - a.sign * OVERSHOOT_MM, to = a.dStart + a.sign * s.depth;
    min[a.dAxis] = Math.min(from, to);  max[a.dAxis] = Math.max(from, to);
    return { min: min, max: max };
  }

  /* A closed, outward-wound box as a soup (Float32Array, 9 floats a triangle). */
  function boxSoup(box) {
    var x0 = box.min[0], y0 = box.min[1], z0 = box.min[2];
    var x1 = box.max[0], y1 = box.max[1], z1 = box.max[2];
    var o = [];
    function q(a, b, c, d) { o.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
                                    a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]); }
    q([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);   // -z
    q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);   // +z
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);   // -y
    q([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);   // +y
    q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);   // -x
    q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);   // +x
    return new Float32Array(o);
  }

  /* Carry a soup through a 4x4 matrix (column-major, THREE's elements order).
     A matrix that mirrors (negative determinant) turns triangles inside out,
     so their vertex order is reversed to keep the box outward-wound. */
  function transformSoup(soup, m) {
    var det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) +
              m[8] * (m[1] * m[6] - m[5] * m[2]);
    var flip = det < 0;
    var out = new Float32Array(soup.length);
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var v = [];
      for (var k = 0; k < 3; k++) {
        var x = soup[t + k * 3], y = soup[t + k * 3 + 1], z = soup[t + k * 3 + 2];
        v.push([m[0] * x + m[4] * y + m[8] * z + m[12],
                m[1] * x + m[5] * y + m[9] * z + m[13],
                m[2] * x + m[6] * y + m[10] * z + m[14]]);
      }
      var order = flip ? [0, 2, 1] : [0, 1, 2];
      for (var j = 0; j < 3; j++) {
        out[t + j * 3] = v[order[j]][0];
        out[t + j * 3 + 1] = v[order[j]][1];
        out[t + j * 3 + 2] = v[order[j]][2];
      }
    }
    return out;
  }

  /* Why this blade cannot be used, or '' when it can. */
  function refusal(p) {
    p = p || {};
    var notch = p.mode === 'notch';
    var w = notch ? 1 : Number(p.width), d = Number(notch ? p.ndepth : p.depth), k = Number(notch ? p.nwidth : p.kerf);
    if (!(k >= MIN_KERF_MM)) return 'the ' + (notch ? 'notch width' : 'kerf') + ' is under ' + MIN_KERF_MM + ' mm - a slot that thin cannot be printed or cut';
    if (!(w >= MIN_WIDTH_MM)) return 'the blade is under ' + MIN_WIDTH_MM + ' mm wide';
    if (!(d >= MIN_DEPTH_MM)) return 'the ' + (notch ? 'notch' : 'blade') + ' reaches under ' + MIN_DEPTH_MM + ' mm in';
    return '';
  }

/* ---- Strands: the separate pieces of material a plane crosses ----------
   Cut a spiral of cord with a plane and the section is not one shape but one
   blob per turn the plane crosses. A blade that takes "what it holds" takes
   every turn in its box. To take ONE, the section is split into its blobs and
   the one under the click is the strand.

   `soup` is in the cut frame (9 floats a triangle), `axis` the plane's normal.
   Each triangle the plane crosses gives one segment; segments that share an
   end are one blob. The crossing point on an edge is computed from the edge's
   two ends in a fixed order, so the two triangles that share the edge land on
   the same point to the last bit, and the blobs join without a tolerance.
   -> [{ min:[x,y,z], max:[x,y,z], pts:[[x,y,z] ...] }]  (pts: the blob's outline) */
  function sectionClusters(soup, axis, plane) {
    var id = new Map(), parent = [], pts = [], segs = [];
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function node(p) {
      var k = Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5) + ',' + Math.round(p[2] * 1e5);
      var i = id.get(k);
      if (i === undefined) { i = parent.length; parent.push(i); pts.push(p); id.set(k, i); }
      return i;
    }
    function cross(a, b) {                       // the plane's point on edge a-b, ends in a fixed order
      var lo = a, hi = b;
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) { lo = b; hi = a; }
      var t = (plane - lo[axis]) / (hi[axis] - lo[axis]);
      var p = [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t];
      p[axis] = plane;
      return p;
    }
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var v = [[soup[t], soup[t + 1], soup[t + 2]], [soup[t + 3], soup[t + 4], soup[t + 5]], [soup[t + 6], soup[t + 7], soup[t + 8]]];
      var up = [v[0][axis] >= plane, v[1][axis] >= plane, v[2][axis] >= plane];
      var n = (up[0] ? 1 : 0) + (up[1] ? 1 : 0) + (up[2] ? 1 : 0);
      if (n === 0 || n === 3) continue;
      var odd = n === 1 ? (up[0] ? 0 : up[1] ? 1 : 2) : (!up[0] ? 0 : !up[1] ? 1 : 2);   // the lone vertex
      var o1 = (odd + 1) % 3, o2 = (odd + 2) % 3;
      var ia = node(cross(v[odd], v[o1])), ib = node(cross(v[odd], v[o2]));
      segs.push([ia, ib]);
      var ra = find(ia), rb = find(ib);
      if (ra !== rb) parent[rb] = ra;
    }
    var by = new Map();
    for (var i = 0; i < parent.length; i++) {
      var r = find(i), c = by.get(r);
      if (!c) { c = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], pts: [], segs: [] }; by.set(r, c); }
      for (var k = 0; k < 3; k++) { if (pts[i][k] < c.min[k]) c.min[k] = pts[i][k]; if (pts[i][k] > c.max[k]) c.max[k] = pts[i][k]; }
      c.pts.push(pts[i]);
    }
    for (var q = 0; q < segs.length; q++) by.get(find(segs[q][0])).segs.push([pts[segs[q][0]], pts[segs[q][1]]]);
    return Array.from(by.values());
  }

  /* The blob whose outline passes nearest `q` (a point on the plane, cut frame):
     a click lands ON a strand's surface, so its own outline is the near one.
     Distance is to the outline's SEGMENTS, not its corners: a click in the
     middle of a long flat face is far from its own corners and can be close to
     a neighbour's. -> { index, dist } or null. */
  function nearestCluster(clusters, q) {
    function segD2(a, b) {
      var abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      var l2 = abx * abx + aby * aby + abz * abz;
      var t = l2 > 0 ? ((q[0] - a[0]) * abx + (q[1] - a[1]) * aby + (q[2] - a[2]) * abz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var dx = a[0] + abx * t - q[0], dy = a[1] + aby * t - q[1], dz = a[2] + abz * t - q[2];
      return dx * dx + dy * dy + dz * dz;
    }
    var best = null;
    for (var i = 0; i < clusters.length; i++) {
      var d2 = Infinity, S = clusters[i].segs;
      for (var j = 0; j < S.length; j++) { var e = segD2(S[j][0], S[j][1]); if (e < d2) d2 = e; }
      if (!best || d2 < best.d2) best = { index: i, d2: d2 };
    }
    return best ? { index: best.index, dist: Math.sqrt(best.d2) } : null;
  }

  /* Notch mode: the blade fitted to one strand. The strand's section is
     `cluster`; the blade is as wide across as the strand plus the margin, and
     goes in from the strand's own edge on the side it enters from, `depth`
     deep. `a` is bladeBox's argument less what this fills in.

     That holds for a strand: a cord, a bar - a section with no inside to it.
     A section that has an inside (a channel, a U, a slot in a wall) is one
     blob too, but its bounding box is not the wall that was clicked: the notch
     went in from the far outer edge and across the whole part. So when the
     section is not convex and the click is known (a.wCentre, a.dStart: the
     click carried onto the plane), the notch is fitted to the FACE under the
     click instead (faceRun): as wide as that face runs across, going in from
     it. Where the face ends in an inside corner the notch stops flush with
     the wall it meets; where it ends at an outside corner it runs the margin
     past, into air. */
  function notchBox(a, cluster) {
    var lo = cluster.min[a.wAxis], hi = cluster.max[a.wAxis];
    var edge = a.sign < 0 ? cluster.max[a.dAxis] : cluster.min[a.dAxis];
    var width = hi - lo + 2 * NOTCH_MARGIN_MM, centre = (lo + hi) / 2, face = null;
    if (a.wCentre != null && a.dStart != null && !sectionConvex(cluster, a.wAxis, a.dAxis)) {
      face = faceRun(cluster, a);
      if (face) { edge = face.edge; width = face.hi - face.lo; centre = (face.lo + face.hi) / 2; }
    }
    var spec = {
      axis: a.axis, dAxis: a.dAxis, wAxis: a.wAxis, sign: a.sign, plane: a.plane,
      wCentre: centre, dStart: edge, width: width, depth: a.depth, kerf: a.kerf
    };
    return { box: bladeBox(spec), spec: spec, edge: edge, face: face };
  }

  /* The section's outline as flat arrays in (w, u): w across, u = sign * d,
     so "going in" is always +u. */
  function outlineWU(cluster, wAxis, dAxis, sign) {
    var S = cluster.segs, n = S.length, w0 = new Float64Array(n), u0 = new Float64Array(n),
        w1 = new Float64Array(n), u1 = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      w0[i] = S[i][0][wAxis]; u0[i] = sign * S[i][0][dAxis];
      w1[i] = S[i][1][wAxis]; u1[i] = sign * S[i][1][dAxis];
    }
    return { n: n, w0: w0, u0: u0, w1: w1, u1: u1 };
  }

  /* Where the line across at `w` crosses the outline, sorted by u. Half-open
     on w so a line through a vertex counts the two segments there once. */
  function crossingsAt(O, w) {
    var out = [];
    for (var i = 0; i < O.n; i++) {
      var a = O.w0[i], b = O.w1[i];
      if (a === b) continue;
      var lo = a < b ? a : b, hi = a < b ? b : a;
      if (!(w >= lo && w < hi)) continue;
      out.push(O.u0[i] + (O.u1[i] - O.u0[i]) * (w - a) / (b - a));
    }
    out.sort(function (x, y) { return x - y; });
    return out;
  }

  /* Convex (near enough): no line across, either way, meets the outline more
     than twice. Sampled; a cord, a bar or a rounded strand passes, a channel
     or a U does not. */
  function sectionConvex(cluster, wAxis, dAxis) {
    var axes = [[wAxis, dAxis], [dAxis, wAxis]], SAMPLES = 48;
    for (var k = 0; k < 2; k++) {
      var O = outlineWU(cluster, axes[k][0], axes[k][1], 1);
      var lo = cluster.min[axes[k][0]], hi = cluster.max[axes[k][0]];
      if (!(hi > lo)) continue;
      for (var s = 1; s < SAMPLES; s++) {
        var w = lo + (hi - lo) * (s + 0.37) / SAMPLES;    // off the round numbers a modelled vertex sits on
        if (crossingsAt(O, w).length > 2) return false;
      }
    }
    return true;
  }

  /* The face under the click, on the plane: from the click's column, step
     across while the surface the blade would go in through stays on the
     clicked face - an entry into the material, turning less than FACE_TURN off
     the line it started on. Returns its ends across (margin included where the
     end is open) and its outermost point on the way in, or null when the
     click's column has no surface to go in through. */
  var FACE_STEP_MM = 0.1, FACE_TURN = Math.tan(30 * Math.PI / 180), FACE_SNAP_MM = 2;
  function faceRun(cluster, a) {
    var O = outlineWU(cluster, a.wAxis, a.dAxis, a.sign);
    var u0 = a.sign * a.dStart, w0 = a.wCentre;
    /* The entry into material in column w nearest uExp: crossings sorted by u, the even ones go in. */
    function entryNear(w, uExp, tol) {
      var c = crossingsAt(O, w), best = null;
      for (var i = 0; i < c.length; i += 2) {
        var e = Math.abs(c[i] - uExp);
        if (e <= tol && (best === null || e < Math.abs(best - uExp))) best = c[i];
      }
      return best;
    }
    var start = entryNear(w0, u0, FACE_SNAP_MM);
    if (start === null) return null;
    var span = (cluster.max[a.wAxis] - cluster.min[a.wAxis]) + 1;
    var ends = [], uMin = start;
    for (var dir = -1; dir <= 1; dir += 2) {
      /* The face runs at the slope of its first step out of the click. A step stays on it while the
         surface there heads within FACE_TURN of that slope, so a gently curved face is followed until it
         has turned that far, and a corner - a fillet included - is not walked round. */
      var first = entryNear(w0 + dir * FACE_STEP_MM, start, FACE_STEP_MM * FACE_TURN + 1e-6);
      var ang0 = Math.atan(first === null ? 0 : (first - start) / FACE_STEP_MM);
      var TURN = Math.atan(FACE_TURN);
      var onFace = function (wFrom, uFrom, w) {
        var r = Math.abs(w - wFrom);
        if (!(r > 0)) return uFrom;
        var u = entryNear(w, uFrom + Math.tan(ang0) * r, r * 4 + 1e-4);
        if (u === null) return null;
        return Math.abs(Math.atan((u - uFrom) / r) - ang0) <= TURN + 1e-9 ? u : null;
      };
      var wg = w0, ug = start;
      while (Math.abs(wg - w0) < span) {
        var u = onFace(wg, ug, wg + dir * FACE_STEP_MM);
        if (u === null) break;
        wg += dir * FACE_STEP_MM; ug = u;
        if (u < uMin) uMin = u;
      }
      // the end lies between wg (on the face) and one step on (off it): halve onto it
      var g = wg, b = wg + dir * FACE_STEP_MM, ugEnd = ug;
      for (var it = 0; it < 20; it++) {
        var m = (g + b) / 2, um = onFace(wg, ug, m);
        if (um === null) b = m; else { g = m; ugEnd = um; }
      }
      ends.push({ w: g, u: ugEnd, dir: dir });
      if (ugEnd < uMin) uMin = ugEnd;
    }
    /* Margin: past an open end - nothing in the blade's way beyond it - the
       blade runs on into air so the nick is clean across. Past an inside
       corner there is material in the way: the notch stops flush there. */
    var depth = a.depth;
    function clearAt(w) {
      var c = crossingsAt(O, w), lo = uMin - OVERSHOOT_MM, hi = uMin + depth;
      var inside = 0;
      for (var i = 0; i < c.length; i++) {
        if (c[i] <= lo) { inside ^= 1; continue; }
        if (c[i] < hi) return false;                      // the outline passes through the blade's band
        break;
      }
      return !inside;                                      // and no material spans the band whole
    }
    /* Material at u in column w: an odd number of crossings before it. */
    function insideAt(w, u) {
      var c = crossingsAt(O, w), k = 0;
      while (k < c.length && c[k] < u) k++;
      return (k & 1) === 1;
    }
    /* An inside corner: past the end the surface falls back toward the blade (a fillet, a chamfer) into
       the wall the face meets, and there the material stands in front of where the blade starts. The
       notch is carried through the fillet to that wall, flush with it - stopped short, a fin of the
       fillet would be left standing. -> the wall's w, or null where the end is an outside corner. */
    var FILLET_MAX_MM = 5;
    function wallPast(e) {
      var w = e.w, u = e.u, front = uMin - OVERSHOOT_MM / 2;
      for (var i = 0; i * FACE_STEP_MM < FILLET_MAX_MM; i++) {
        var w2 = w + e.dir * FACE_STEP_MM;
        if (insideAt(w2, front)) {
          var g = w, b = w2;
          for (var it = 0; it < 20; it++) { var m = (g + b) / 2; if (insideAt(m, front)) b = m; else g = m; }
          return b;
        }
        var c = crossingsAt(O, w2), nu = null;
        for (var j = 0; j < c.length; j += 2) if (c[j] <= u + 1e-6 && c[j] >= front) nu = c[j];
        if (nu === null) return null;
        w = w2; u = nu;
      }
      return null;
    }
    var out = [], closed = [];
    for (var k = 0; k < 2; k++) {
      var e = ends[k], wall = wallPast(e), w2 = e.w + e.dir * NOTCH_MARGIN_MM;
      if (wall !== null) { out.push(wall); closed.push(true); continue; }
      closed.push(false);
      out.push(clearAt(w2) && clearAt(e.w + e.dir * NOTCH_MARGIN_MM / 2) ? w2 : e.w);
    }
    var wlo = Math.min(out[0], out[1]), whi = Math.max(out[0], out[1]);
    if (!(whi - wlo >= MIN_WIDTH_MM)) return null;
    return { lo: wlo, hi: whi, edge: a.sign * uMin,
             open: [!closed[0] && out[0] !== ends[0].w, !closed[1] && out[1] !== ends[1].w], wall: closed };
  }

  /* The section's edge nearest `q` (a point on the plane, cut frame) and the
     way it faces out, in the plane: where a blade goes in when the face
     clicked gives no way in - it lies in the cut plane (a flat blade and the
     top of a wall). The click is over the wall, so the wall's nearest side is
     the one meant. -> { point:[x,y,z], normal:[x,y,z] } or null.            */
  function edgeEntry(clusters, axis, q) {
    var a = (axis + 1) % 3, b = (axis + 2) % 3, best = null;
    for (var i = 0; i < clusters.length; i++) {
      var S = clusters[i].segs;
      for (var j = 0; j < S.length; j++) {
        var p0 = S[j][0], p1 = S[j][1];
        var ta = p1[a] - p0[a], tb = p1[b] - p0[b], l2 = ta * ta + tb * tb;
        if (!(l2 > 1e-14)) continue;
        var t = ((q[a] - p0[a]) * ta + (q[b] - p0[b]) * tb) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var ca = p0[a] + ta * t, cb = p0[b] + tb * t, d2 = (ca - q[a]) * (ca - q[a]) + (cb - q[b]) * (cb - q[b]);
        if (!best || d2 < best.d2) best = { d2: d2, ca: ca, cb: cb, ta: ta, tb: tb, l: Math.sqrt(l2) };
      }
    }
    if (!best) return null;
    // Material at (pa, pb): an odd number of the outline's crossings on a line from it toward +a.
    function inside(pa, pb) {
      var n = 0;
      for (var i = 0; i < clusters.length; i++) {
        var S = clusters[i].segs;
        for (var j = 0; j < S.length; j++) {
          var u = S[j][0], v = S[j][1];
          if ((u[b] > pb) === (v[b] > pb)) continue;
          var x = u[a] + (v[a] - u[a]) * (pb - u[b]) / (v[b] - u[b]);
          if (x > pa) n++;
        }
      }
      return (n & 1) === 1;
    }
    var na = -best.tb / best.l, nb = best.ta / best.l, EPS = 0.02;
    if (inside(best.ca + na * EPS, best.cb + nb * EPS)) { na = -na; nb = -nb; }
    var point = [0, 0, 0], normal = [0, 0, 0];
    point[axis] = q[axis]; point[a] = best.ca; point[b] = best.cb;
    normal[a] = na; normal[b] = nb;
    return { point: point, normal: normal, dist: Math.sqrt(best.d2) };
  }

  var round = function (v) { return Math.round(v * 100) / 100; };

  /* The status line for a finished notch. */
  function report(o) {
    return (o.notch ? 'Notch cut - ' + round(o.kerf) + ' mm wide x ' + round(o.depth) + ' mm deep nick into the strand\'s edge'
                    : 'Sized cut - blade ' + round(o.width) + ' wide x ' + round(o.depth) + ' deep, kerf ' + round(o.kerf) + ' mm') +
      ' - ' + round(o.removed) + ' mm³ removed' +
      (o.strands > 1 ? ' - one strand of ' + o.strands + ' in the blade' : '') +
      (o.shells > 1 ? ' - the slot severs the piece into ' + o.shells + ' bodies (still one piece: Split to parts separates them)' : '');
  }

  var api = {
    MIN_KERF_MM: MIN_KERF_MM, MIN_WIDTH_MM: MIN_WIDTH_MM, MIN_DEPTH_MM: MIN_DEPTH_MM,
    OVERSHOOT_MM: OVERSHOOT_MM, LEAN_MIN: LEAN_MIN, DEFAULTS: DEFAULTS,
    sizes: sizes, entryFor: entryFor, sectionClusters: sectionClusters, nearestCluster: nearestCluster, notchBox: notchBox, edgeEntry: edgeEntry, faceRun: faceRun, sectionConvex: sectionConvex,
    NOTCH_DEFAULTS: NOTCH_DEFAULTS, NOTCH_MARGIN_MM: NOTCH_MARGIN_MM, bladeBox: bladeBox, boxSoup: boxSoup,
    transformSoup: transformSoup, refusal: refusal, report: report
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NSO_Notch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
