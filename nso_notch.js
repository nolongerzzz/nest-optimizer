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

  /* The blade's three sizes, clamped to what can be built. */
  function sizes(p) {
    p = p || {};
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
    var w = Number(p.width), d = Number(p.depth), k = Number(p.kerf);
    if (!(k >= MIN_KERF_MM)) return 'the kerf is under ' + MIN_KERF_MM + ' mm - a slot that thin cannot be printed or cut';
    if (!(w >= MIN_WIDTH_MM)) return 'the blade is under ' + MIN_WIDTH_MM + ' mm wide';
    if (!(d >= MIN_DEPTH_MM)) return 'the blade reaches under ' + MIN_DEPTH_MM + ' mm in';
    return '';
  }

  var round = function (v) { return Math.round(v * 100) / 100; };

  /* The status line for a finished notch. */
  function report(o) {
    return 'Notch cut - blade ' + round(o.width) + ' wide x ' + round(o.depth) + ' deep, kerf ' + round(o.kerf) +
      ' mm - ' + round(o.removed) + ' mm³ removed' +
      (o.shells > 1 ? ' - the slot severs the piece into ' + o.shells + ' bodies (still one piece: Split to parts separates them)' : '');
  }

  var api = {
    MIN_KERF_MM: MIN_KERF_MM, MIN_WIDTH_MM: MIN_WIDTH_MM, MIN_DEPTH_MM: MIN_DEPTH_MM,
    OVERSHOOT_MM: OVERSHOOT_MM, LEAN_MIN: LEAN_MIN, DEFAULTS: DEFAULTS,
    sizes: sizes, entryFor: entryFor, bladeBox: bladeBox, boxSoup: boxSoup,
    transformSoup: transformSoup, refusal: refusal, report: report
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NSO_Notch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
