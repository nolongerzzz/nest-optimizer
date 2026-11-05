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
     deep. `a` is bladeBox's argument less what this fills in. */
  function notchBox(a, cluster) {
    var lo = cluster.min[a.wAxis], hi = cluster.max[a.wAxis];
    var edge = a.sign < 0 ? cluster.max[a.dAxis] : cluster.min[a.dAxis];
    var spec = {
      axis: a.axis, dAxis: a.dAxis, wAxis: a.wAxis, sign: a.sign, plane: a.plane,
      wCentre: (lo + hi) / 2, dStart: edge,
      width: hi - lo + 2 * NOTCH_MARGIN_MM, depth: a.depth, kerf: a.kerf
    };
    return { box: bladeBox(spec), spec: spec, edge: edge };
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
    sizes: sizes, entryFor: entryFor, sectionClusters: sectionClusters, nearestCluster: nearestCluster, notchBox: notchBox,
    NOTCH_DEFAULTS: NOTCH_DEFAULTS, NOTCH_MARGIN_MM: NOTCH_MARGIN_MM, bladeBox: bladeBox, boxSoup: boxSoup,
    transformSoup: transformSoup, refusal: refusal, report: report
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NSO_Notch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
