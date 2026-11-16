/* ============================================================
   nso_interlock.js - keys and their sockets, as solids.
   docs/INTERLOCK.md. Headless: no DOM, no Three.js, no app state; the page
   loads it as window.NSO_Interlock and node requires it
   (tools/nso_interlock_test.js). The editor that places one is
   app-asm-editor.js.

   A KEY is what stands proud of a face; its SOCKET is the hole that takes it.
   Three shapes, each sized by what a caliper reads:

     tongue   a rectangular bar            length x width x height
     pin      a round peg                  diameter x height
     snap     a tongue with a 45-degree    length x width x height, catch
              ridge down each long side,
              and a socket grooved to
              take it

   Every solid is built in its own frame - x along the length, y across the
   width, z out of the face the key stands on, z = 0 ON that face - and then
   carried to wherever it goes by place().

   WHAT THE NUMBERS MEAN
     height   how far the key stands proud of its own face.
     ease     a 45-degree chamfer round the tip, so it finds the socket. All
              four top edges of a tongue, the rim of a pin; on a snap the two
              long edges only (its section is drawn once and run the length).
     fit      clearance per side between key and socket: the socket is the key
              grown by `fit` on every side wall. 0.10 is what the model this
              was written from uses (25.0 into 25.2).
     catch    how far a snap's ridge stands out of its side. The ridge is a
              45-degree triangle both ways - it rides in, and with a pull it
              rides out - so it prints either way up without support.

   WHAT IS NOT A NUMBER THE USER TYPES
     embed    the key starts this far INSIDE the piece it is added to, so the
              union bites solid material and never rests on a coplanar skin.
     pre      the socket starts this far BEFORE the face it is cut into, for
              the same reason on the subtract.
   Both are given by the caller, who knows where the faces are.

   Every builder returns a flat Float32Array, 9 numbers a triangle, closed,
   outward-wound (checked by signed volume as it is built, not assumed).
   ============================================================ */
(function (root) {
  'use strict';

  var PIN_SEGMENTS = 64;
  var SHAPES = ['tongue', 'pin', 'snap'];

  /* ---------------- building ---------------- */

  function pushTri(out, a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }

  function signedVolume(s) {
    var v = 0;
    for (var i = 0; i < s.length; i += 9) {
      v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7])
         - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6])
         + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
    }
    return v / 6;
  }

  /* Outward by measurement: a solid whose signed volume came out negative is
     the same solid wound inside out, so it is turned. */
  function finish(tris) {
    var s = new Float32Array(tris);
    if (signedVolume(s) < 0) {
      for (var i = 0; i < s.length; i += 9) {
        for (var k = 0; k < 3; k++) { var t = s[i + 3 + k]; s[i + 3 + k] = s[i + 6 + k]; s[i + 6 + k] = t; }
      }
    }
    return s;
  }

  /* A stack of convex rings, each the same count of points going the same
     way round, lowest first: walls between neighbours, a fan under the first
     and over the last. */
  function stack(rings) {
    var out = [], n = rings[0].length, r, i;
    for (r = 0; r + 1 < rings.length; r++) {
      var lo = rings[r], hi = rings[r + 1];
      for (i = 0; i < n; i++) {
        var j = (i + 1) % n;
        pushTri(out, lo[i], lo[j], hi[j]);
        pushTri(out, lo[i], hi[j], hi[i]);
      }
    }
    var b = rings[0], t = rings[rings.length - 1];
    for (i = 1; i + 1 < n; i++) {
      pushTri(out, b[0], b[i + 1], b[i]);
      pushTri(out, t[0], t[i], t[i + 1]);
    }
    return finish(out);
  }

  function rectRing(len, wid, z) {
    var x = len / 2, y = wid / 2;
    return [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
  }
  function circleRing(radius, z) {
    var ring = [];
    for (var i = 0; i < PIN_SEGMENTS; i++) {
      var a = 2 * Math.PI * i / PIN_SEGMENTS;
      ring.push([radius * Math.cos(a), radius * Math.sin(a), z]);
    }
    return ring;
  }

  /* Ear clipping for a simple polygon [[y, z], ...]; returns index triples. */
  function triangulate(poly) {
    var n = poly.length, idx = [], i, area = 0;
    for (i = 0; i < n; i++) { var p = poly[i], q = poly[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
    for (i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i);          // counter-clockwise
    function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
    function inside(p, a, b, c) { return cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12; }
    var tris = [], guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      var cut = false;
      for (i = 0; i < idx.length; i++) {
        var ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
        var a = poly[ia], b = poly[ib], c = poly[ic];
        if (cross(a, b, c) <= 1e-12) continue;                                // reflex or flat: not an ear
        var clear = true;
        for (var k = 0; k < idx.length; k++) {
          var ik = idx[k];
          if (ik === ia || ik === ib || ik === ic) continue;
          if (inside(poly[ik], a, b, c)) { clear = false; break; }
        }
        if (!clear) continue;
        tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }

  /* A section [[y, z], ...] run along x from -len/2 to +len/2. The section
     is taken counter-clockwise (seen from +x), which is what makes a wall's
     own normal point out of it; the cap at +x is wound the same way and the
     cap at -x the other. */
  function extrude(sectionIn, len) {
    var section = sectionIn.slice(), n = section.length, x = len / 2, i, area = 0, out = [];
    for (i = 0; i < n; i++) { var s0 = section[i], s1 = section[(i + 1) % n]; area += s0[0] * s1[1] - s1[0] * s0[1]; }
    if (area < 0) section.reverse();
    for (i = 0; i < n; i++) {
      var p = section[i], q = section[(i + 1) % n];
      var a = [-x, p[0], p[1]], b = [-x, q[0], q[1]], c = [x, q[0], q[1]], d = [x, p[0], p[1]];
      pushTri(out, a, b, c); pushTri(out, a, c, d);
    }
    var caps = triangulate(section);
    for (i = 0; i < caps.length; i++) {
      var t = caps[i], c0 = section[t[0]], c1 = section[t[1]], c2 = section[t[2]];
      pushTri(out, [x, c0[0], c0[1]], [x, c1[0], c1[1]], [x, c2[0], c2[1]]);
      pushTri(out, [-x, c0[0], c0[1]], [-x, c2[0], c2[1]], [-x, c1[0], c1[1]]);
    }
    return finish(out);
  }

  /* ---------------- the three shapes ---------------- */

  function num(v, d) { v = Number(v); return isFinite(v) ? v : d; }

  /* The spec as it will be built, or the reason it cannot be. */
  function check(spec) {
    var s = {
      shape: SHAPES.indexOf(spec && spec.shape) >= 0 ? spec.shape : 'tongue',
      length: num(spec && spec.length, 0), width: num(spec && spec.width, 0),
      diameter: num(spec && spec.diameter, 0), height: num(spec && spec.height, 0),
      ease: Math.max(0, num(spec && spec.ease, 0)), fit: Math.max(0, num(spec && spec.fit, 0)),
      catch: Math.max(0, num(spec && spec.catch, 0))
    };
    if (!(s.height > 0)) return { ok: false, reason: 'the height must be more than 0' };
    if (s.shape === 'pin') {
      if (!(s.diameter > 0)) return { ok: false, reason: 'the diameter must be more than 0' };
      s.ease = Math.min(s.ease, s.height * 0.9, s.diameter / 2 * 0.9);
      return { ok: true, spec: s };
    }
    if (!(s.length > 0) || !(s.width > 0)) return { ok: false, reason: 'the length and the width must be more than 0' };
    s.ease = Math.min(s.ease, s.height * 0.9, s.length / 2 * 0.9, s.width / 2 * 0.9);
    if (s.shape === 'snap') {
      if (!(s.catch > 0)) return { ok: false, reason: 'a snap tab needs a catch of more than 0' };
      /* the ridge needs its own height twice over (up the ramp, down the
         ramp), a land above the face to stand on and one below the ease */
      var need = s.ease + 2 * s.catch + 2 * SNAP_LAND;
      if (s.height < need - 1e-9) {
        return { ok: false, reason: 'a ' + s.catch.toFixed(2) + ' mm catch with a ' + s.ease.toFixed(2) +
          ' mm ease needs a height of at least ' + need.toFixed(2) + ' mm' };
      }
    }
    return { ok: true, spec: s };
  }

  var SNAP_LAND = 0.3;
  /* Where a snap's ridge peaks, above the key's own face. */
  function snapPeak(s) { return s.height - s.ease - SNAP_LAND - s.catch; }

  /* The key: from z = -embed (inside the piece it is added to) to z = height. */
  function key(spec, opts) {
    var c = check(spec);
    if (!c.ok) return c;
    var s = c.spec, z0 = -Math.max(0, num(opts && opts.embed, 0)), H = s.height, e = s.ease, soup;
    if (s.shape === 'pin') {
      var r = s.diameter / 2;
      soup = e > 1e-9
        ? stack([circleRing(r, z0), circleRing(r, H - e), circleRing(r - e, H)])
        : stack([circleRing(r, z0), circleRing(r, H)]);
    } else if (s.shape === 'tongue') {
      soup = e > 1e-9
        ? stack([rectRing(s.length, s.width, z0), rectRing(s.length, s.width, H - e), rectRing(s.length - 2 * e, s.width - 2 * e, H)])
        : stack([rectRing(s.length, s.width, z0), rectRing(s.length, s.width, H)]);
    } else {
      var w = s.width / 2, k = s.catch, hb = snapPeak(s);
      var sec = [[-w, z0], [w, z0], [w, hb - k], [w + k, hb], [w, hb + k], [w, H - e]];
      if (e > 1e-9) sec.push([w - e, H], [-w + e, H]);
      sec.push([-w, H - e], [-w, hb + k], [-w - k, hb], [-w, hb - k]);
      soup = extrude(sec, s.length);
    }
    return { ok: true, soup: soup, spec: s, volume: signedVolume(soup) };
  }

  /* The socket's cutter: the key grown by `fit` on every side wall, from
     z = from (before the face it is cut into) to z = to (the socket's floor,
     or past the far side of the piece for one that goes through). A snap's
     grooves keep the ridge's own height and move out with the wall. */
  function cutter(spec, opts) {
    var c = check(spec);
    if (!c.ok) return c;
    var s = c.spec, f = s.fit, z0 = num(opts && opts.from, 0), z1 = num(opts && opts.to, s.height + f), soup;
    if (!(z1 > z0)) return { ok: false, reason: 'the socket has no depth' };
    if (s.shape === 'pin') {
      soup = stack([circleRing(s.diameter / 2 + f, z0), circleRing(s.diameter / 2 + f, z1)]);
    } else if (s.shape === 'tongue') {
      soup = stack([rectRing(s.length + 2 * f, s.width + 2 * f, z0), rectRing(s.length + 2 * f, s.width + 2 * f, z1)]);
    } else {
      var w = s.width / 2 + f, k = s.catch, hb = num(opts && opts.peak, snapPeak(s));
      if (hb - k <= z0 + 1e-6 || hb + k >= z1 - 1e-6) {
        /* the groove would break out of the socket's mouth or floor: a plain slot there */
        soup = stack([rectRing(s.length + 2 * f, 2 * w, z0), rectRing(s.length + 2 * f, 2 * w, z1)]);
      } else {
        soup = extrude([[-w, z0], [w, z0], [w, hb - k], [w + k, hb], [w, hb + k], [w, z1],
                        [-w, z1], [-w, hb + k], [-w - k, hb], [-w, hb - k]], s.length + 2 * f);
      }
    }
    return { ok: true, soup: soup, spec: s, volume: signedVolume(soup) };
  }

  /* ---------------- placing ---------------- */

  /* Half of what the key spans along the face's own two directions once it
     is turned by `deg` on the face - what an edge distance is measured to. */
  function halfSpan(spec, deg) {
    var c = check(spec);
    if (!c.ok) return { u: 0, v: 0 };
    var s = c.spec;
    if (s.shape === 'pin') return { u: s.diameter / 2, v: s.diameter / 2 };
    var a = num(deg, 0) * Math.PI / 180, co = Math.abs(Math.cos(a)), si = Math.abs(Math.sin(a));
    var L = s.length / 2, W = s.width / 2 + (s.shape === 'snap' ? s.catch : 0);
    return { u: L * co + W * si, v: L * si + W * co };
  }

  /* A solid built here, carried to where it goes: `o` is the point on the
     face under the key's middle, u and v the face's two directions, n the way
     the key points (u x v = n), deg the turn about n. A new Float32Array. */
  function place(soup, frame, deg) {
    var a = num(deg, 0) * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    var o = frame.o, u = frame.u, v = frame.v, n = frame.n, out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      var x = soup[i] * co - soup[i + 1] * si, y = soup[i] * si + soup[i + 1] * co, z = soup[i + 2];
      out[i] = o[0] + u[0] * x + v[0] * y + n[0] * z;
      out[i + 1] = o[1] + u[1] * x + v[1] * y + n[1] * z;
      out[i + 2] = o[2] + u[2] * x + v[2] * y + n[2] * z;
    }
    return out;
  }

  /* ---------------- words ---------------- */

  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function describe(spec, what) {
    var c = check(spec);
    if (!c.ok) return c.reason;
    var s = c.spec, g = what === 'socket' ? s.fit : 0;
    if (s.shape === 'pin') return (what === 'socket' ? 'hole ' : 'pin ') + '⌀' + f2(s.diameter + 2 * g) + ' × ' + f2(s.height + g);
    return (what === 'socket' ? (s.shape === 'snap' ? 'snap slot ' : 'slot ') : (s.shape === 'snap' ? 'snap tab ' : 'tongue ')) +
      f2(s.length + 2 * g) + ' × ' + f2(s.width + 2 * g) + ' × ' + f2(s.height + g);
  }

  var api = { SHAPES: SHAPES, check: check, key: key, cutter: cutter, place: place, halfSpan: halfSpan,
              describe: describe, snapPeak: snapPeak, signedVolume: signedVolume, _triangulate: triangulate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NSO_Interlock = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
