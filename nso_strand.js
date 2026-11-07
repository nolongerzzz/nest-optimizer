/* ============================================================
   Strand - follow a cord. The Cut tool's "Follow strand": THREE-free and
   DOM-free, so the whole file runs under node (tools/nso_strand_test.js); the
   app layer is app-cut.js (cutFollow*).

   What it answers
   ---------------
   A spiral of cord has no one "square" cut: the blade that stands square across
   the strand here is turned from the one that stands square across it a
   quarter-turn on. To slice a spiral like salami, the blade has to be put
   square across the strand wherever it is, and then moved along the strand by a
   chosen step. That needs two things, both here:
     traceAt  - at a point on / in a strand: where the strand's centre is and
                which way it runs (the section's centre, and the direction in
                which a plane through it cuts the smallest section);
     advance  - the same, one step further along: the centre line is marched
                forward in small steps, each re-centred on the strand's own
                section, so it stays on the cord round a bend and across the gaps
                earlier cuts left.

   Everything is in ONE frame (the app passes the piece's WORLD soup), 9 floats a
   triangle. Directions are unit [x,y,z]. `up` is the plate vertical.

   A strand's section by a plane is a closed outline; its centre is the outline
   weighted by length (the cord's section is round or a plain rectangle, for which
   that is the centre). The direction comes from the surface's normals (they all lie
   square to a tube's axis), then is tightened from the centres of the sections a
   little ahead and a little behind.
   ============================================================ */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;
  /* Triangles further than this from the point of interest are not looked at: a section is local. */
  var NEAR_MM = 14;

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  /* The triangles with any part within `r` of `p`: their boxes against p's box. */
  function near(soup, p, r) {
    var out = [];
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var lo0 = Math.min(soup[t], soup[t + 3], soup[t + 6]), hi0 = Math.max(soup[t], soup[t + 3], soup[t + 6]);
      if (hi0 < p[0] - r || lo0 > p[0] + r) continue;
      var lo1 = Math.min(soup[t + 1], soup[t + 4], soup[t + 7]), hi1 = Math.max(soup[t + 1], soup[t + 4], soup[t + 7]);
      if (hi1 < p[1] - r || lo1 > p[1] + r) continue;
      var lo2 = Math.min(soup[t + 2], soup[t + 5], soup[t + 8]), hi2 = Math.max(soup[t + 2], soup[t + 5], soup[t + 8]);
      if (hi2 < p[2] - r || lo2 > p[2] + r) continue;
      for (var k = 0; k < 9; k++) out.push(soup[t + k]);
    }
    return out;
  }

  /* The plane n.x = d through the triangles `tris` (a flat array, 9 a triangle): its outlines, one per separate blob.
     Each is { segs:[[a,b]...], c: centre (length-weighted), reach: largest distance of its outline from c }.
     The crossing on an edge is computed from the edge's ends in a fixed order, so the two triangles that share an
     edge land on the same point to the last bit and the blobs join without a tolerance (as nso_notch.js does). */
  function sections(tris, n, d) {
    var id = new Map(), parent = [], pts = [], segs = [];
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function node(p) {
      var k = Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5) + ',' + Math.round(p[2] * 1e5);
      var i = id.get(k);
      if (i === undefined) { i = parent.length; parent.push(i); pts.push(p); id.set(k, i); }
      return i;
    }
    function crossing(a, b, sa, sb) {
      var lo = a, hi = b, slo = sa, shi = sb;
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) { lo = b; hi = a; slo = sb; shi = sa; }
      var t = slo / (slo - shi);
      return [lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t, lo[2] + (hi[2] - lo[2]) * t];
    }
    for (var t = 0; t + 8 < tris.length; t += 9) {
      var v = [[tris[t], tris[t + 1], tris[t + 2]], [tris[t + 3], tris[t + 4], tris[t + 5]], [tris[t + 6], tris[t + 7], tris[t + 8]]];
      var s = [dot(n, v[0]) - d, dot(n, v[1]) - d, dot(n, v[2]) - d];
      var up = [s[0] >= 0, s[1] >= 0, s[2] >= 0];
      var cnt = (up[0] ? 1 : 0) + (up[1] ? 1 : 0) + (up[2] ? 1 : 0);
      if (cnt === 0 || cnt === 3) continue;
      var odd = cnt === 1 ? (up[0] ? 0 : up[1] ? 1 : 2) : (!up[0] ? 0 : !up[1] ? 1 : 2);
      var o1 = (odd + 1) % 3, o2 = (odd + 2) % 3;
      var ia = node(crossing(v[odd], v[o1], s[odd], s[o1])), ib = node(crossing(v[odd], v[o2], s[odd], s[o2]));
      if (ia === ib) continue;
      segs.push([ia, ib]);
      var ra = find(ia), rb = find(ib);
      if (ra !== rb) parent[rb] = ra;
    }
    var by = new Map(), list = [];
    for (var q = 0; q < segs.length; q++) {
      var r = find(segs[q][0]), c = by.get(r);
      if (!c) { c = { segs: [], c: null, reach: 0, area: 0 }; by.set(r, c); list.push(c); }
      c.segs.push([pts[segs[q][0]], pts[segs[q][1]]]);
    }
    list.forEach(function (c) {
      var L = 0, sx = 0, sy = 0, sz = 0;
      c.segs.forEach(function (g) {
        var l = len(sub(g[1], g[0])), m = mul(add(g[0], g[1]), 0.5);
        L += l; sx += m[0] * l; sy += m[1] * l; sz += m[2] * l;
      });
      c.c = L > 0 ? [sx / L, sy / L, sz / L] : c.segs[0][0];
      c.segs.forEach(function (g) {
        c.reach = Math.max(c.reach, len(sub(g[0], c.c)), len(sub(g[1], c.c)));
        // The outline's area, as the fan of triangles from its centre (right for a section that is star-shaped about it:
        // a cord's is). A section that a cut face has sliced part-way, or that a plane grazes, is far from a whole one.
        c.area += len(cross(sub(g[0], c.c), sub(g[1], c.c))) / 2;
      });
    });
    return list;
  }

  /* Distance from q to an outline (to its segments). */
  function outlineDist(c, q) {
    var best = Infinity;
    for (var i = 0; i < c.segs.length; i++) {
      var a = c.segs[i][0], b = c.segs[i][1], ab = sub(b, a), l2 = dot(ab, ab);
      var t = l2 > 0 ? dot(sub(q, a), ab) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var e = sub(add(a, mul(ab, t)), q), d2 = dot(e, e);
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  /* The outline a point on or in a strand belongs to: the nearest outline. */
  function loopAt(tris, p, n) {
    var L = sections(tris, n, dot(n, p)), best = null, bd = Infinity;
    for (var i = 0; i < L.length; i++) {
      var d = outlineDist(L[i], p);
      if (d < bd) { bd = d; best = L[i]; }
    }
    return best;
  }

  /* The outline whose CENTRE is nearest p, if within `tol` (and, given `area`, a whole section of the cord: within 5% under or 6% over
     that area - a plane square to a bend that clips the wall of a nick near it cuts a section 7-10% short): marching asks "is there strand where I expect it". */
  function loopNearCentre(tris, p, n, tol, area) {
    var L = sections(tris, n, dot(n, p)), best = null, bd = tol;
    for (var i = 0; i < L.length; i++) {
      if (area && (L[i].area < 0.95 * area || L[i].area > 1.06 * area)) continue;   // not a whole section of this cord
      var d = len(sub(L[i].c, p));
      if (d <= bd) { bd = d; best = L[i]; }
    }
    return best;
  }

  /* The direction a strand runs at p, from the surface around p: every normal of a tube lies square to its axis, so the
     axis is the direction the surface's normals cover least. Two steps, because a click near the cord's end brings the
     flat cap's normals (which lie ALONG the axis) into the patch, and an average over all of them is dragged off:
       1. the axis most of the surface agrees on - the cross product of two normals is square to both, so each pair of
          sampled normals proposes an axis, and the one square to the most surface area (inliers) wins;
       2. the inliers' covariance, smallest eigenvector (power iteration on tr(M) I - M), for the exact direction.
     Only a rough direction is needed: traceAt tightens it from the cord's own sections. (Taken from the outline of the
     smallest section instead it is fooled by a plane that grazes the surface or the cord's end.) */
  function directionAt(tris, p, rho) {
    rho = rho || 2.5;
    var U = [], W = [];
    for (var t = 0; t + 8 < tris.length; t += 9) {
      var a = [tris[t], tris[t + 1], tris[t + 2]], b = [tris[t + 3], tris[t + 4], tris[t + 5]], c = [tris[t + 6], tris[t + 7], tris[t + 8]];
      if (len(sub(mul(add(add(a, b), c), 1 / 3), p)) > rho) continue;
      var nn = cross(sub(b, a), sub(c, a)), l = len(nn);
      if (l < 1e-12) continue;
      U.push([nn[0] / l, nn[1] / l, nn[2] / l]); W.push(l / 2);
    }
    if (!U.length) return null;
    function pca(idx) {
      var M = [0, 0, 0, 0, 0, 0];
      idx.forEach(function (i) {
        var u = U[i], w = W[i];
        M[0] += w * u[0] * u[0]; M[1] += w * u[0] * u[1]; M[2] += w * u[0] * u[2];
        M[3] += w * u[1] * u[1]; M[4] += w * u[1] * u[2]; M[5] += w * u[2] * u[2];
      });
      var tr = M[0] + M[3] + M[5];
      var B = [[tr - M[0], -M[1], -M[2]], [-M[1], tr - M[3], -M[4]], [-M[2], -M[4], tr - M[5]]];
      var v = norm([0.577, 0.5771, 0.5773]);
      for (var i = 0; i < 200; i++) {
        var nv = norm([dot(B[0], v), dot(B[1], v), dot(B[2], v)]);
        if (len(nv) === 0) break;
        v = nv;
      }
      return v;
    }
    var all = U.map(function (_, i) { return i; });
    if (U.length < 4) return pca(all);
    var stride = Math.max(1, Math.floor(U.length / 60)), samp = [];
    for (var i = 0; i < U.length; i += stride) samp.push(i);
    var best = null, bs = -1;
    for (var x = 0; x < samp.length; x++) for (var y = x + 1; y < samp.length; y++) {
      var ax = cross(U[samp[x]], U[samp[y]]);
      if (len(ax) < 0.25) continue;                               // nearly parallel normals propose nothing
      ax = norm(ax);
      var score = 0;
      for (var k = 0; k < U.length; k += Math.max(1, Math.floor(U.length / 400))) if (Math.abs(dot(U[k], ax)) < 0.08) score += W[k];
      if (score > bs) { bs = score; best = ax; }
    }
    if (!best) return pca(all);
    var inl = all.filter(function (k) { return Math.abs(dot(U[k], best)) < 0.2; });
    return inl.length >= 3 ? pca(inl) : best;
  }

  /* A direction is a line; give it a sense that does not depend on where it was found (+x, else +z, else +y). */
  function canonical(t) {
    var s = Math.abs(t[0]) > 1e-6 ? t[0] : Math.abs(t[2]) > 1e-6 ? t[2] : t[1];
    return s < 0 ? mul(t, -1) : t;
  }

  /* The strand at p (a point on its surface or inside it): its centre `c`, which way it runs `t`, and the size of its
     section square to that, read against `up`: `top` is the point of the section highest along up, `h` its height, `w`
     its width (across t and up), `r` its largest reach. `opts.hint` (a direction) skips the sweep and fixes the sense;
     `opts.within` (mm) says p is an expected centre and refuses a strand whose centre there is further off than that.
     Null if there is no strand within reach of p. */
  function traceAt(soup, p, opts) {
    opts = opts || {};
    var up = opts.up || [0, 1, 0];
    var tris = opts.tris || near(soup, p, opts.near || NEAR_MM);
    var n = opts.hint ? norm(opts.hint) : directionAt(tris, p, opts.rho);
    if (!n) return null;
    var l0 = loopAt(tris, p, n);
    if (!l0) return null;
    // `within`: p is where the strand's centre is expected, not a point on its surface. A gap (the kerf of an earlier
    // cut) has no strand at p, and the nearest outline there belongs to another turn of the spiral: that is no answer.
    if (opts.within && len(sub(l0.c, p)) > opts.within) return null;
    var c = l0.c, r = l0.reach, A = null;
    // Re-centre and re-aim: the centres a little ahead and a little behind say which way the strand really runs
    // (an outline of an oblique plane is centred on the axis, so they sit on it).
    for (var it = 0; it < 3; it++) {
      var lc = loopAt(tris, c, n);
      if (!lc) break;
      c = lc.c; r = lc.reach;
      // The whole section's area is known once the plane is square to the cord (the first pass, aimed by the normals,
      // is close); the neighbours either side must match it, or they are a cut face's partial section.
      if (it > 0 || !A) A = lc.area;
      var d = Math.max(0.8, 0.5 * r);
      var ahead = loopNearCentre(tris, add(c, mul(n, d)), n, 1.2 * r + d, A);
      var back = loopNearCentre(tris, sub(c, mul(n, d)), n, 1.2 * r + d, A);
      var t = ahead && back ? sub(ahead.c, back.c) : ahead ? sub(ahead.c, c) : back ? sub(c, back.c) : null;
      if (!t || len(t) < 1e-6) break;
      var tn = norm(t);
      n = dot(tn, n) < 0 ? mul(tn, -1) : tn;
    }
    var fin = loopAt(tris, c, n);
    if (!fin) return null;
    c = fin.c;
    // A point on a strand's surface is within a section's reach of its centre; further off and the centre belongs to
    // another turn (a click on the flat end of a cord, whose plane has no section of its own to find).
    if (!opts.hint && len(sub(c, p)) > 1.5 * fin.reach + 0.5) return null;
    var hi = -Infinity, lo = Infinity, wl = Infinity, wh = -Infinity, side = norm(cross(n, up));
    fin.segs.forEach(function (g) {
      g.forEach(function (q) {
        var e = sub(q, c), u = dot(e, up), s = dot(e, side);
        if (u > hi) hi = u; if (u < lo) lo = u; if (s < wl) wl = s; if (s > wh) wh = s;
      });
    });
    if (opts.hint) { if (dot(n, opts.hint) < 0) n = mul(n, -1); } else n = canonical(n);
    return { c: c, t: n, r: fin.reach, top: add(c, mul(up, hi)), bottom: add(c, mul(up, lo)), h: hi - lo, w: wh - wl };
  }

  /* From centre `c` running along unit `t`, `dist` further along the strand: the new centre and direction. The
     centre line is marched in steps of about half a millimetre, each re-centred on the strand's own section, so it
     keeps to the cord round a bend; where there is no strand (a kerf an earlier cut left, up to `opts.gap` mm) it
     carries straight on. -> { c, t, moved, end } : `end` is set when the strand stops short of `dist` (`moved` is how
     far it got). Null if `c` is not on a strand. */
  function advance(soup, c, t, dist, opts) {
    opts = opts || {};
    var up = opts.up || [0, 1, 0], gap = opts.gap == null ? 1.5 : opts.gap, step = opts.step || 0.5;
    var tris = near(soup, add(c, mul(t, dist / 2)), dist / 2 + (opts.near || 8));
    var here = loopAt(tris, c, t);
    if (!here) return null;
    var r = here.reach, area = here.area, tol = Math.max(0.9 * r, 1);
    var cur = c, dir = norm(t), done = 0, good = 0, blind = 0, end = false;
    while (done < dist - 1e-9) {
      var ds = Math.min(step, dist - done), p = add(cur, mul(dir, ds));
      var l = loopNearCentre(tris, p, dir, tol, area);
      if (l) {
        var chord = norm(sub(l.c, cur));
        dir = norm(add(mul(dir, 0.5), mul(chord, 0.5)));
        cur = l.c; blind = 0; done += ds; good = done;
      } else {
        if (blind + ds > gap + 1e-9) { end = true; break; }
        blind += ds; cur = p; done += ds;
      }
    }
    // Gaps are crossed, not stopped in: a march that finishes with no strand under it has run off the end (or into a
    // kerf), and the cord there is nothing to stand a blade on.
    if (end || blind) return { c: cur, t: dir, moved: good, end: true };
    // The centre line is on the cord to within the mesh's noise; the direction is read afresh there, where it is wanted
    // - unless the centre is in a gap (no cord to read), where the marched one stands.
    var fin = traceAt(soup, cur, { hint: dir, up: up, tris: tris });
    if (fin && len(sub(fin.c, cur)) > 0.5) fin = null;
    return fin ? { c: fin.c, t: fin.t, moved: dist, end: false, size: fin } : { c: cur, t: dir, moved: dist, end: false, blind: true };
  }

  /* The strand's centre line either side of `c` (running along unit `t`), out to `opts.maxTurn` degrees of turning (90) or
     `opts.maxLen` mm (60) each way, or where the strand stops: the section a slider or a drag can be moved through
     without asking the mesh again. Marched as `advance` does it (steps of `opts.step` mm, each re-centred on a whole
     section of the cord, gaps up to `opts.gap` crossed straight) but kept: -> { samples, sMin, sMax } where each sample is
       { c, t, s, ok }  centre, direction (along +s: the sense `t` was given in), arc length from c, and whether there
                        is strand there (ok false across a kerf: the blade is not stood in a gap).
     Directions are the central difference of the centres a mm either side - the centres are good to 0.01 mm, which makes
     that good to under a degree. s = 0 is `c` itself. Null if `c` is not on a strand. */
  function centreline(soup, c, t, opts) {
    opts = opts || {};
    var step = opts.step || 0.5, maxTurn = (opts.maxTurn || 90) * DEG, maxLen = opts.maxLen || 60;
    var gap = opts.gap == null ? 2.5 : opts.gap;
    var pre = near(soup, c, maxLen + 10);
    var t0 = norm(t);
    var here = loopAt(near(pre, c, 6), c, t0);
    if (!here) return null;
    var area = here.area, tol = Math.max(0.9 * here.reach, 1);
    function side(sign) {
      var out = [], cur = c, dir = mul(t0, sign), len = 0, blind = 0, tail = 0;
      while (len < maxLen) {
        var p = add(cur, mul(dir, step));
        var l = loopNearCentre(near(pre, p, 5), p, dir, tol, area);
        if (l) {
          var chord = norm(sub(l.c, cur));
          dir = norm(add(mul(dir, 0.5), mul(chord, 0.5)));
          len += len3(sub(l.c, cur)); cur = l.c; blind = 0; tail = out.length + 1;
          out.push({ c: cur, ok: true });
        } else {
          blind += step;
          if (blind > gap + 1e-9) break;                       // the strand has ended
          len += step; cur = p;
          out.push({ c: cur, ok: false });
        }
        if (Math.acos(Math.max(-1, Math.min(1, dot(dir, mul(t0, sign))))) >= maxTurn) break;
      }
      return out.slice(0, tail);                               // never end in a gap
    }
    var f = side(1), b = side(-1), pts = [];
    for (var i = b.length - 1; i >= 0; i--) pts.push(b[i]);
    var i0 = pts.length;
    pts.push({ c: c, ok: true });
    f.forEach(function (q) { pts.push(q); });
    // arc length from c, and the directions
    var s = new Array(pts.length), k;
    s[i0] = 0;
    for (k = i0 + 1; k < pts.length; k++) s[k] = s[k - 1] + len3(sub(pts[k].c, pts[k - 1].c));
    for (k = i0 - 1; k >= 0; k--) s[k] = s[k + 1] - len3(sub(pts[k + 1].c, pts[k].c));
    var w = Math.max(1, Math.round(1 / step));                // a mm either side
    var samples = pts.map(function (q, i) {
      var a = pts[Math.max(0, i - w)].c, z = pts[Math.min(pts.length - 1, i + w)].c;
      var tt = norm(sub(z, a));                                 // the points run along +s, so this does too
      return { c: q.c, t: tt, s: s[i], ok: q.ok };
    });
    // The last w samples at each end have only one side to difference, which reads the direction half a baseline
    // early (a few degrees on a tight bend): carry the direction on from the two interior samples instead.
    var n = samples.length;
    if (n > 3 * w + 1) {
      for (k = 0; k < w; k++) {
        var m1 = w, m0 = 2 * w;                                 // two interior samples at the start, w apart
        var tb = add(samples[m1].t, mul(sub(samples[m1].t, samples[m0].t), (m1 - k) / w));
        samples[k].t = norm(tb);
        var e1 = n - 1 - w, e0 = n - 1 - 2 * w, ke = n - 1 - k;
        var te = add(samples[e1].t, mul(sub(samples[e1].t, samples[e0].t), (ke - e1) / w));
        samples[ke].t = norm(te);
      }
    }
    var oks = samples.filter(function (q) { return q.ok; });
    return { samples: samples, sMin: oks[0].s, sMax: oks[oks.length - 1].s };
  }
  function len3(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }

  var api = { NEAR_MM: NEAR_MM, near: near, sections: sections, loopAt: loopAt, directionAt: directionAt, traceAt: traceAt, advance: advance, centreline: centreline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NSO_Strand = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
