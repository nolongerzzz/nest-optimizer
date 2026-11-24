/* ============================================================
   nso_boss.js - a step, a boss or a wedge: an outline stood out of a face.
   docs/BOSS.md. Headless: no DOM, no THREE, no app state. The page loads it as
   window.NSO_Boss and node requires it (tools/nso_boss_test.js). The editor
   that places one is app-boss.js (ADD > Step / Boss).

   WHAT IT MAKES. An outline - a rectangle with rounded corners, a circle, or
   points you put down yourself (NSO_CustomShape's outline, so every corner
   keeps its own radius) - stood out of a face by `height`. With a RAMP the
   top is not flat: it rises out of the face at `ramp` degrees from one side
   of the outline (the thin end) until it reaches `height`, then runs flat.
   That one number is three shapes:

     ramp 0                    a flat-topped step / boss / pad
     ramp 45, short height     a ledge whose underside is a 45 degree slope -
                               the pop-out at the top of a riser, printable on
                               a wall without support when the thin end is down
     ramp under 90 and a       a wedge: the whole outline a slope - a wall
     height it never reaches   thickened at an angle

   Built in its own frame: x, y on the face (x along the length), z out of
   it, z = 0 ON the face. place() (NSO_Interlock's) carries it anywhere.

   WHAT THE CALLER GIVES THAT THE USER DOES NOT TYPE
     embed   the solid starts this far INSIDE the piece (z = -embed), so the
             union bites solid material and never rests on a coplanar skin.
   And one number neither types: at the thin end of a ramp the top starts DIP
   below the face, so the ramp crosses the face cleanly instead of meeting it
   along an edge (a 0.02 mm sliver the union cuts away).

   THE MESH. The outline's corners, the crease where a ramp turns flat cut
   into it, one triangulation of the outline (NSO_CDT) used for the bottom and
   - with every triangle the crease crosses split along it - for the top, at
   each corner's own height; and a wall round the outline between the two. The
   top is exact: on each side of the crease the height is linear, and every
   top triangle lies on one side. Closed by construction, outward-wound
   (checked by signed volume as it is built).
   ============================================================ */
(function (root) {
  'use strict';

  var ROUND_SEGMENTS = 64;
  var DIP = 0.02;
  var OUTLINES = ['rect', 'round', 'custom'];
  var MAX_RAMP = 85;

  function num(x, d) { x = +x; return isFinite(x) ? x : d; }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function CS() { return root.NSO_CustomShape || (typeof require === 'function' ? tryReq('./nso_custom_shape.js') : null); }
  function CDT() { return root.NSO_CDT || (typeof require === 'function' ? tryReq('./nso_cdt.js') : null); }
  function tryReq(p) { try { return require(p); } catch (e) { return null; } }

  /* ---------------- the spec ---------------- */

  var DEFAULTS = { outline: 'rect', length: 20, width: 10, radius: 1, diameter: 10, height: 3, ramp: 0, rampDir: 90 };

  function check(spec) {
    spec = spec || {};
    var s = {
      outline: OUTLINES.indexOf(spec.outline) >= 0 ? spec.outline : DEFAULTS.outline,
      length: num(spec.length, DEFAULTS.length), width: num(spec.width, DEFAULTS.width),
      radius: Math.max(0, num(spec.radius, DEFAULTS.radius)), diameter: num(spec.diameter, DEFAULTS.diameter),
      height: num(spec.height, DEFAULTS.height), ramp: num(spec.ramp, 0), rampDir: num(spec.rampDir, DEFAULTS.rampDir),
      points: Array.isArray(spec.points) ? spec.points.map(function (p) { return { x: num(p.x, 0), y: num(p.y, 0), r: Math.max(0, num(p.r, 0)) }; }) : []
    };
    if (!(s.height > 0)) return { ok: false, reason: 'Height must be more than 0' };
    if (s.ramp < 0 || s.ramp > MAX_RAMP) return { ok: false, reason: 'Ramp is an angle from the face, 0 (none) to ' + MAX_RAMP + ' degrees' };
    if (s.outline === 'rect') {
      if (!(s.length > 0) || !(s.width > 0)) return { ok: false, reason: 'Length and Width must be more than 0' };
      if (s.radius > Math.min(s.length, s.width) / 2 + 1e-9) return { ok: false, reason: 'the corner radius can be at most half the narrower side (' + f2(Math.min(s.length, s.width) / 2) + ' mm)' };
    }
    if (s.outline === 'round' && !(s.diameter > 0)) return { ok: false, reason: 'Diameter must be more than 0' };
    if (s.outline === 'custom' && s.points.length < 3) return { ok: false, reason: 'a drawn outline needs at least 3 points' };
    return { ok: true, spec: s };
  }

  /* ---------------- the outline ---------------- */

  function signedArea(L) {
    var a = 0;
    for (var i = 0; i < L.length; i++) { var p = L[i], q = L[(i + 1) % L.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }

  /* The outline, counter-clockwise, its box centred on 0. -> { ok, loop } */
  function outline(spec) {
    var c = check(spec);
    if (!c.ok) return c;
    var s = c.spec, L;
    if (s.outline === 'round') {
      L = [];
      for (var i = 0; i < ROUND_SEGMENTS; i++) {
        var a = 2 * Math.PI * i / ROUND_SEGMENTS;
        L.push([s.diameter / 2 * Math.cos(a), s.diameter / 2 * Math.sin(a)]);
      }
    } else {
      var lib = CS();
      if (!lib) return { ok: false, reason: 'nso_custom_shape.js did not load' };
      var pts = s.outline === 'rect'
        ? [[-s.length / 2, -s.width / 2], [s.length / 2, -s.width / 2], [s.length / 2, s.width / 2], [-s.length / 2, s.width / 2]].map(function (p) { return { x: p[0], y: p[1], r: s.radius }; })
        : s.points;
      var r = lib.outline({ points: pts, sides: pts.map(function () { return { wall: 1, bulge: 0 }; }), mode: 'solid', height: 1 });
      if (!r.ok) return { ok: false, reason: 'the outline: ' + r.reason, at: r.at };
      L = r.outer.map(function (p) { return [p[0], p[1]]; });
    }
    /* tidy: no repeated corner, counter-clockwise, the box centred */
    var T = [];
    L.forEach(function (p) { var q = T[T.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) T.push(p); });
    while (T.length > 2 && Math.hypot(T[0][0] - T[T.length - 1][0], T[0][1] - T[T.length - 1][1]) <= 1e-7) T.pop();
    if (T.length < 3) return { ok: false, reason: 'the outline has no area' };
    if (signedArea(T) < 0) T.reverse();
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    T.forEach(function (p) { lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); });
    var cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    return { ok: true, loop: T.map(function (p) { return [p[0] - cx, p[1] - cy]; }), spec: s, shift: [-cx, -cy] };
  }

  /* ---------------- the height over the outline ---------------- */

  /* t(x, y): the top's height. Flat: height. Ramp: rising from the thin end
     (the outline's lowest point along rampDir) at `ramp` degrees, capped at
     height. -> { at(p), crease (s value or null), dir } */
  function topOf(s, loop) {
    if (!(s.ramp > 0)) return { at: function () { return s.height; }, crease: null };
    var a = s.rampDir * Math.PI / 180, d = [Math.cos(a), Math.sin(a)], k = Math.tan(s.ramp * Math.PI / 180);
    var s0 = Infinity, s1 = -Infinity;
    loop.forEach(function (p) { var w = p[0] * d[0] + p[1] * d[1]; if (w < s0) s0 = w; if (w > s1) s1 = w; });
    var sc = s0 + (s.height + DIP) / k;
    return {
      dir: d, s0: s0, s1: s1, k: k,
      along: function (p) { return p[0] * d[0] + p[1] * d[1]; },
      at: function (p) { return Math.min(s.height, (p[0] * d[0] + p[1] * d[1] - s0) * k - DIP); },
      crease: sc < s1 - 1e-6 ? sc : null,
      top: Math.min(s.height, (s1 - s0) * k - DIP)
    };
  }

  /* ---------------- building ---------------- */

  /* opts.embed: how far below the face the solid starts (>= 0). */
  function build(spec, opts) {
    opts = opts || {};
    var o = outline(spec);
    if (!o.ok) return o;
    var s = o.spec, embed = Math.max(0, num(opts.embed, 0.4));
    var lib = CDT();
    if (!lib) return { ok: false, reason: 'nso_cdt.js did not load' };
    var loop = o.loop.map(function (p) { return p.slice(); }), H = topOf(s, loop);

    /* the crease, cut into the outline where it crosses a side */
    if (H.crease != null) {
      var sc = H.crease, cut = [];
      for (var i = 0; i < loop.length; i++) {
        var p = loop[i], q = loop[(i + 1) % loop.length];
        cut.push(p);
        var a = H.along(p) - sc, b = H.along(q) - sc;
        if ((a < -1e-9 && b > 1e-9) || (a > 1e-9 && b < -1e-9)) {
          var t = a / (a - b);
          cut.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
      loop = cut;
    }
    var n = loop.length, segs = [];
    for (var j = 0; j < n; j++) segs.push([j, (j + 1) % n]);
    var tr = lib.triangulate(loop, segs);
    if (!tr || !tr.tris) return { ok: false, reason: 'the outline could not be filled' + (tr && tr.reason ? ': ' + tr.reason : '') };
    if (tr.split) return { ok: false, reason: 'the outline touches itself' };
    var tris = tr.tris;

    var out = [];
    function T(a, za, b, zb, c, zc) { out.push(a[0], a[1], za, b[0], b[1], zb, c[0], c[1], zc); }

    /* bottom, facing down */
    for (var q2 = 0; q2 < tris.length; q2 += 3) {
      var A = loop[tris[q2]], B = loop[tris[q2 + 1]], C = loop[tris[q2 + 2]];
      T(A, -embed, C, -embed, B, -embed);
    }
    /* top, facing up - split along the crease where it crosses a triangle */
    var pts = loop.slice(), splitAt = new Map();
    function side(p) { if (H.crease == null) return 0; var w = H.along(p) - H.crease; return w > 1e-9 ? 1 : (w < -1e-9 ? -1 : 0); }
    function mid(i0, i1) {
      var key = i0 < i1 ? i0 + '_' + i1 : i1 + '_' + i0, k = splitAt.get(key);
      if (k != null) return k;
      var p = pts[i0], q = pts[i1], a = H.along(p) - H.crease, b = H.along(q) - H.crease, t = a / (a - b);
      pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      splitAt.set(key, pts.length - 1);
      return pts.length - 1;
    }
    function up(i0, i1, i2) { var a = pts[i0], b = pts[i1], c = pts[i2]; T(a, H.at(a), b, H.at(b), c, H.at(c)); }
    for (var q3 = 0; q3 < tris.length; q3 += 3) {
      var t3 = [tris[q3], tris[q3 + 1], tris[q3 + 2]], sd = t3.map(function (k) { return side(pts[k]); });
      var hasPos = sd.indexOf(1) >= 0, hasNeg = sd.indexOf(-1) >= 0;
      if (!(hasPos && hasNeg)) { up(t3[0], t3[1], t3[2]); continue; }
      /* turn it so the lone corner (or the one on the crease) is first */
      var r = 0;
      for (var z = 0; z < 3; z++) {
        var s0 = sd[z], s1 = sd[(z + 1) % 3], s2 = sd[(z + 2) % 3];
        if (s0 === 0 || (s1 === s2 && s0 !== s1)) { r = z; break; }
      }
      var i0 = t3[r], i1 = t3[(r + 1) % 3], i2 = t3[(r + 2) % 3];
      if (sd[r] === 0) {                                  // on the crease: one cut, two triangles
        var m = mid(i1, i2);
        up(i0, i1, m); up(i0, m, i2);
      } else {                                            // a lone corner: a triangle and a quad
        var m1 = mid(i0, i1), m2 = mid(i0, i2);
        up(i0, m1, m2); up(m1, i1, i2); up(m1, i2, m2);
      }
    }
    /* the wall: counter-clockwise outline, so outward is to the right */
    for (var w = 0; w < n; w++) {
      var P0 = loop[w], P1 = loop[(w + 1) % n], h0 = H.at(P0), h1 = H.at(P1);
      T(P0, -embed, P1, -embed, P1, h1);
      T(P0, -embed, P1, h1, P0, h0);
    }
    var soup = new Float32Array(out);
    var vol = signedVolume(soup);
    if (vol < 0) {
      for (var f = 0; f < soup.length; f += 9) for (var k2 = 0; k2 < 3; k2++) { var x = soup[f + 3 + k2]; soup[f + 3 + k2] = soup[f + 6 + k2]; soup[f + 6 + k2] = x; }
      vol = -vol;
    }
    return { ok: true, soup: soup, volume: vol, loop: o.loop, spec: s, embed: embed,
             top: H.crease == null ? (s.ramp > 0 ? H.top : s.height) : s.height, crease: H.crease, ramped: s.ramp > 0 };
  }

  function signedVolume(s) {
    var v = 0;
    for (var i = 0; i < s.length; i += 9) {
      v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7])
         - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6])
         + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
    }
    return v / 6;
  }

  /* The outline's box once turned by deg on the face: { u0, u1, v0, v1 } about its middle. */
  function span(loop, deg) {
    var a = num(deg, 0) * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    var r = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
    loop.forEach(function (p) {
      var x = p[0] * co - p[1] * si, y = p[0] * si + p[1] * co;
      if (x < r.u0) r.u0 = x; if (x > r.u1) r.u1 = x; if (y < r.v0) r.v0 = y; if (y > r.v1) r.v1 = y;
    });
    return r;
  }

  /* A solid built here, carried to where it goes (NSO_Interlock.place's rule):
     o the point on the face under the outline's middle, u and v the face's
     directions, n out of the face, deg the turn about n. */
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

  function describe(spec) {
    var c = check(spec);
    if (!c.ok) return c.reason;
    var s = c.spec, what;
    if (s.outline === 'round') what = 'round boss ⌀' + f2(s.diameter);
    else if (s.outline === 'rect') what = 'step ' + f2(s.length) + ' × ' + f2(s.width);
    else what = 'drawn step (' + s.points.length + ' points)';
    return what + ', ' + f2(s.height) + ' tall' + (s.ramp > 0 ? ', ramp ' + f2(s.ramp) + '°' : '');
  }

  var API = {
    check: check, outline: outline, build: build, span: span, place: place, describe: describe, signedVolume: signedVolume,
    OUTLINES: OUTLINES.slice(), DEFAULTS: DEFAULTS, DIP: DIP, MAX_RAMP: MAX_RAMP
  };
  root.NSO_Boss = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
