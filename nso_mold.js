/* nso_mold.js - a two-piece interlocking silicone mold from one piece.

   Loads as a classic script (window.NSO_Mold) and as a Node module
   (require('../nso_mold.js')). No DOM, no Three.js, no app state - the rule
   nso_stock.js and nso_printer.js follow. It does no boolean and no cut of
   its own: those are handed in as a `kernel` (build() below), which in the app
   is the code that is already shipped -

       kernel.subtract(a, b)           Subtract B from A  (NSO_subtractSoups, app-join.js)
       kernel.union(a, b)              NSO_unionSoups, app-join.js
       kernel.cutSide(soup, axisIdx, plane, keepMin)
                                       the Cut engine's clean split, one side
                                       (cutOneSide -> rawCut, app-cut.js)

   so the mold is made of the same Subtract and the same Cut the rest of the
   app uses and a hole in either is found once, not twice. docs/MOLD.md.

   FRAME. Every soup here is a Float32Array of triangles (9 floats each), in
   the WORLD frame the plate is drawn in: x and z across the plate, y UP. The
   piece "as it lies" - its pose included - is the mold orientation; nothing in
   here turns the piece. The block around it is axis-aligned in that frame;
   only the parting plane may be tilted.

   THE PARTING PLANE. Horizontal to start, through the middle of the piece's
   height. `mm` is, as on the Cut card, how far the plane is from the piece's low
   end where it crosses the piece's centre line; tilt and heading lean its
   normal (tilt degrees off vertical, toward heading degrees clockwise seen from
   above, 0 = toward -z, the top of the screen). Half A is the side the normal
   points to (up), half B the other. Pull A along +normal, B along -normal.

   LOCKS. A face of the piece locks a half when that half cannot be drawn off
   it: on A's side of the plane a face looking away from A's pull (normal . n <
   0), on B's side a face looking away from B's pull (normal . n > 0). Faces
   within LOCK_EPS of square to the pull (a vertical wall, no draft) do not
   count - silicone pulls off those. A triangle the plane crosses is cut by it
   and each part is judged on its own side. A warning, never a refusal.

   WHAT build() DOES, in order
     block  = box around the piece, Wall each side, Top/bottom above and below
     cavity = block - piece - sprue - vent        (Subtract, three times)
     A, B   = the cavity block cut at the plane   (Cut, clean split: the two
              faces mate exactly)
     A     += four cones; B -= four sockets, 0.2 mm radial fit gap, at the
              parting face's corners, inset Wall/2
     A is then turned over about the x axis, so BOTH halves lie parting face up
     with their flat block faces on the plate - an open mold - and each can be
     printed without supports.
   The piece is read and never written. */
(function (root) {
  'use strict';

  var DEFAULTS = {
    wallMm: 10,          // block wall, each side
    capMm: 15,           // block above and below the piece (Top/bottom)
    keyDiaMm: 6,         // cone diameter at the base (the parting face)
    keyHeightMm: 3,      // how far the cone stands proud
    keyGapMm: 0.2,       // radial fit gap, cone to socket
    keyAngleDeg: 45,     // side wall off the key's axis
    keyWebMm: 1,         // least material between a socket and the block's side
    sprueDiaMm: 8,
    ventDiaMm: 3,
    seatBelowMm: 0.3,    // a sprue / vent starts this far inside the cavity
    exitPastMm: 1,       // ... and ends this far outside the block, to open cleanly
    endMm: 1,            // the plane stays this far from the piece's ends (Cut's rule)
    segs: 48             // sides of every round feature
  };
  var LOCK_EPS = 0.02;    // sin(1.15 deg): squarer than this is no undercut

  /* ------------------------------------------------------------ vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function rad(d) { return (d * Math.PI) / 180; }
  function r1(v) { return Math.round(v * 10) / 10; }

  /* ------------------------------------------------------------- soups */
  function bounds(soup) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        var v = soup[i + a];
        if (v < mn[a]) mn[a] = v;
        if (v > mx[a]) mx[a] = v;
      }
    }
    return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }

  /* Signed volume of a triangle soup, taken about its first vertex so a piece
     far from the origin does not lose digits. Positive = faces point out. */
  function volume(soup) {
    if (!soup.length) return 0;
    var rx = soup[0], ry = soup[1], rz = soup[2], v6 = 0;
    for (var o = 0; o + 8 < soup.length; o += 9) {
      var ax = soup[o] - rx, ay = soup[o + 1] - ry, az = soup[o + 2] - rz;
      var bx = soup[o + 3] - rx, by = soup[o + 4] - ry, bz = soup[o + 5] - rz;
      var cx = soup[o + 6] - rx, cy = soup[o + 7] - ry, cz = soup[o + 8] - rz;
      v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return v6 / 6;
  }

  /* Open, non-manifold, wrongly-wound and degenerate counts. Corners are keyed
     on a 1e-4 mm grid, so the same corner written twice by a mesh (or moved by
     the same matrix twice) is one vertex. closed = a solid surface. */
  function census(soup) {
    var ids = new Map(), n = 0;
    function id(o) {
      var k = Math.round(soup[o] * 1e4) + ',' + Math.round(soup[o + 1] * 1e4) + ',' + Math.round(soup[o + 2] * 1e4);
      var v = ids.get(k);
      if (v === undefined) { v = n++; ids.set(k, v); }
      return v;
    }
    var edges = new Map(), degen = 0, tris = (soup.length / 9) | 0;
    for (var t = 0; t < tris; t++) {
      var o = t * 9, a = id(o), b = id(o + 3), c = id(o + 6);
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (a === b || b === c || a === c || (cx * cx + cy * cy + cz * cz) < 1e-16) { degen++; continue; }
      var pair = [[a, b], [b, c], [c, a]];
      for (var e = 0; e < 3; e++) {
        var p = pair[e][0], q = pair[e][1];
        var key = p < q ? p + '_' + q : q + '_' + p;
        var rec = edges.get(key);
        if (!rec) { rec = { fwd: 0, back: 0 }; edges.set(key, rec); }
        if (p < q) rec.fwd++; else rec.back++;
      }
    }
    var open = 0, nm = 0, wrong = 0;
    edges.forEach(function (r) {
      var tot = r.fwd + r.back;
      if (tot === 1) open++;
      else if (tot > 2) nm++;
      else if (r.fwd !== r.back) wrong++;
    });
    return { tris: tris, open: open, nm: nm, wrong: wrong, degen: degen,
             closed: tris > 0 && open === 0 && nm === 0 && wrong === 0 };
  }

  /* Reverse every triangle (a b c -> a c b). */
  function flipWinding(soup) {
    var out = new Float32Array(soup.length);
    for (var t = 0; t + 8 < soup.length; t += 9) {
      out[t] = soup[t]; out[t + 1] = soup[t + 1]; out[t + 2] = soup[t + 2];
      out[t + 3] = soup[t + 6]; out[t + 4] = soup[t + 7]; out[t + 5] = soup[t + 8];
      out[t + 6] = soup[t + 3]; out[t + 7] = soup[t + 4]; out[t + 8] = soup[t + 5];
    }
    return out;
  }

  function concat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Float32Array(n), w = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], w); w += list[i].length; }
    return out;
  }

  /* An axis-aligned box, faces out. */
  function boxSoup(mn, mx) {
    var v = [[mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]], [mx[0], mx[1], mn[2]], [mn[0], mx[1], mn[2]],
             [mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]], [mx[0], mx[1], mx[2]], [mn[0], mx[1], mx[2]]];
    var f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    var o = [];
    f.forEach(function (t) { t.forEach(function (i) { o.push(v[i][0], v[i][1], v[i][2]); }); });
    return new Float32Array(o);
  }

  /* An orthonormal pair across the unit axis a. */
  function across(a) {
    var h = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var u = unit(cross(a, h));
    return [u, cross(a, u)];
  }

  /* A solid of revolution about the axis through `o` along unit `a`. `prof` is
     a polyline of [radius, t] from a point on the axis to another point on it,
     t measured along a. Closed, faces out whichever way the profile ran. */
  function revolve(o, a, prof, segs) {
    var uv = across(a), u = uv[0], v = uv[1], out = [], i, s;
    function pt(r, t, k) {
      var ang = (2 * Math.PI * (k % segs)) / segs, c = Math.cos(ang) * r, sn = Math.sin(ang) * r;
      return [o[0] + a[0] * t + u[0] * c + v[0] * sn,
              o[1] + a[1] * t + u[1] * c + v[1] * sn,
              o[2] + a[2] * t + u[2] * c + v[2] * sn];
    }
    function tri(p, q, r) { out.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
    for (i = 0; i + 1 < prof.length; i++) {
      var r0 = prof[i][0], t0 = prof[i][1], r2 = prof[i + 1][0], t2 = prof[i + 1][1];
      for (s = 0; s < segs; s++) {
        var p00 = pt(r0, t0, s), p01 = pt(r0, t0, s + 1), p10 = pt(r2, t2, s), p11 = pt(r2, t2, s + 1);
        if (r0 < 1e-9 && r2 < 1e-9) continue;
        if (r0 < 1e-9) tri(p00, p10, p11);
        else if (r2 < 1e-9) tri(p00, p10, p01);
        else { tri(p00, p10, p11); tri(p00, p11, p01); }
      }
    }
    var soup = new Float32Array(out);
    return volume(soup) < 0 ? flipWinding(soup) : soup;
  }

  /* A round bar from a to b, radius r, flat ends. */
  function cylinder(a, b, r, segs) {
    var d = sub(b, a), L = len(d), ax = unit(d);
    return revolve(a, ax, [[0, 0], [r, 0], [r, L], [0, L]], segs);
  }

  /* ----------------------------------------------------- the parting plane */
  function limits(b) {
    var H = b.size[1];
    var lo = Math.ceil(DEFAULTS.endMm * 10 - 1e-9) / 10, hi = Math.floor((H - DEFAULTS.endMm) * 10 + 1e-9) / 10;
    if (!(hi >= lo)) lo = hi = Math.round(H * 5) / 10;
    return { lo: lo, hi: hi };
  }

  /* The plane for slider position `mm` (null = mid-height), tilt, heading. */
  function planeOf(b, o) {
    o = o || {};
    var lim = limits(b);
    var mm = o.mm == null ? r1(b.size[1] / 2) : r1(Number(o.mm));
    mm = Math.min(lim.hi, Math.max(lim.lo, mm));
    var tilt = Math.max(0, Math.min(60, Number(o.tiltDeg) || 0));
    var head = ((Math.round(Number(o.headingDeg) || 0) % 360) + 360) % 360;
    var tau = rad(tilt), phi = rad(head);
    var n = tilt === 0 ? [0, 1, 0]
      : [Math.sin(tau) * Math.sin(phi), Math.cos(tau), -Math.sin(tau) * Math.cos(phi)];
    var p0 = [(b.min[0] + b.max[0]) / 2, b.min[1] + mm, (b.min[2] + b.max[2]) / 2];
    return { n: n, p0: p0, c: dot(n, p0), mm: mm, lo: lim.lo, hi: lim.hi,
             tiltDeg: tilt, headingDeg: head };
  }
  function dist(plane, p) { return plane.n[0] * p[0] + plane.n[1] * p[1] + plane.n[2] * p[2] - plane.c; }

  /* The plane's height at (x, z). */
  function planeY(plane, x, z) { return (plane.c - plane.n[0] * x - plane.n[2] * z) / plane.n[1]; }

  /* Does the plane pass through the piece: some of it on each side, and the
     surface actually met by the plane (a triangle it crosses or touches)? A
     plane through the gap between two separate lumps has the piece on both
     sides and misses both. */
  function crosses(soup, plane) {
    var n = plane.n, lo = Infinity, hi = -Infinity, met = false;
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var d0 = n[0] * soup[t] + n[1] * soup[t + 1] + n[2] * soup[t + 2] - plane.c;
      var d1 = n[0] * soup[t + 3] + n[1] * soup[t + 4] + n[2] * soup[t + 5] - plane.c;
      var d2 = n[0] * soup[t + 6] + n[1] * soup[t + 7] + n[2] * soup[t + 8] - plane.c;
      var mn = Math.min(d0, d1, d2), mx = Math.max(d0, d1, d2);
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
      if (mn <= 0.01 && mx >= -0.01) met = true;
    }
    return met && lo < -0.01 && hi > 0.01;
  }

  /* The turn that lays the plane flat: R n = +y. Row-major 3x3, or null when
     the plane is already flat. */
  function laying(plane) {
    var n = plane.n;
    if (Math.abs(n[0]) < 1e-12 && Math.abs(n[2]) < 1e-12) return null;
    var k = cross(n, [0, 1, 0]), s = len(k), c = n[1];
    k = mul(k, 1 / s);
    var K = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]], R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var i = 0; i < 3; i++) {
      for (var j = 0; j < 3; j++) {
        var kk = 0;
        for (var m = 0; m < 3; m++) kk += K[i][m] * K[m][j];
        R[i][j] += s * K[i][j] + (1 - c) * kk;
      }
    }
    return R;
  }
  function turn(soup, R, back) {
    var out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      var x = soup[i], y = soup[i + 1], z = soup[i + 2];
      if (!back) {
        out[i] = R[0][0] * x + R[0][1] * y + R[0][2] * z;
        out[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z;
        out[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z;
      } else {
        out[i] = R[0][0] * x + R[1][0] * y + R[2][0] * z;
        out[i + 1] = R[0][1] * x + R[1][1] * y + R[2][1] * z;
        out[i + 2] = R[0][2] * x + R[1][2] * y + R[2][2] * z;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- locks */
  /* Clip a convex polygon (array of [x,y,z]) by the plane: [above, below]. */
  function clipPoly(poly, plane) {
    var above = [], below = [], n = poly.length, i;
    var d = poly.map(function (p) { return dist(plane, p); });
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n, p = poly[i], q = poly[j], dp = d[i], dq = d[j];
      if (dp >= 0) above.push(p);
      if (dp <= 0) below.push(p);
      if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
        var t = dp / (dp - dq), x = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
        above.push(x); below.push(x);
      }
    }
    return [above, below];
  }
  function polyArea(poly) {
    var a = [0, 0, 0];
    for (var i = 1; i + 1 < poly.length; i++) {
      var c = cross(sub(poly[i], poly[0]), sub(poly[i + 1], poly[0]));
      a[0] += c[0]; a[1] += c[1]; a[2] += c[2];
    }
    return len(a) / 2;
  }

  /* The faces that would lock a half, as { areaMm2, tris, count }. tris is a
     soup of the locking parts (a triangle the plane crosses contributes only
     its locking part), for tinting the piece. */
  function lockAnalysis(soup, plane) {
    var area = 0, out = [], count = 0, n = plane.n;
    for (var o = 0; o + 8 < soup.length; o += 9) {
      var A = [soup[o], soup[o + 1], soup[o + 2]], B = [soup[o + 3], soup[o + 4], soup[o + 5]],
          C = [soup[o + 6], soup[o + 7], soup[o + 8]];
      var cr = cross(sub(B, A), sub(C, A)), l = len(cr);
      if (l < 1e-9) continue;
      var nn = dot(cr, n) / l;
      if (Math.abs(nn) <= LOCK_EPS) continue;
      var dA = dist(plane, A), dB = dist(plane, B), dC = dist(plane, C);
      var parts = [];
      if (dA >= 0 && dB >= 0 && dC >= 0) { if (nn < 0 && (dA + dB + dC) > 0) parts.push([A, B, C]); }
      else if (dA <= 0 && dB <= 0 && dC <= 0) { if (nn > 0 && (dA + dB + dC) < 0) parts.push([A, B, C]); }
      else {
        var cl = clipPoly([A, B, C], plane);
        if (nn < 0 && cl[0].length >= 3) parts.push(cl[0]);
        if (nn > 0 && cl[1].length >= 3) parts.push(cl[1]);
      }
      for (var p = 0; p < parts.length; p++) {
        var poly = parts[p], ar = polyArea(poly);
        if (!(ar > 1e-9)) continue;
        area += ar; count++;
        for (var k = 1; k + 1 < poly.length; k++) {
          out.push(poly[0][0], poly[0][1], poly[0][2], poly[k][0], poly[k][1], poly[k][2],
                   poly[k + 1][0], poly[k + 1][1], poly[k + 1][2]);
        }
      }
    }
    return { areaMm2: area, tris: new Float32Array(out), count: count };
  }

  /* ---------------------------------------------------- the top surface of a piece */
  /* A grid of the triangles by (x, z), for "how high is the piece's top
     surface at this spot": a vertical line's highest crossing. */
  function TopIndex(soup) {
    var b = bounds(soup);
    this.soup = soup; this.min = b.min; this.max = b.max;
    var nx = 48, nz = 48;
    this.nx = nx; this.nz = nz;
    this.sx = (b.max[0] - b.min[0]) / nx || 1;
    this.sz = (b.max[2] - b.min[2]) / nz || 1;
    this.cells = new Array(nx * nz);
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var x0 = Math.min(soup[t], soup[t + 3], soup[t + 6]), x1 = Math.max(soup[t], soup[t + 3], soup[t + 6]);
      var z0 = Math.min(soup[t + 2], soup[t + 5], soup[t + 8]), z1 = Math.max(soup[t + 2], soup[t + 5], soup[t + 8]);
      var i0 = this.cx(x0), i1 = this.cx(x1), j0 = this.cz(z0), j1 = this.cz(z1);
      for (var j = j0; j <= j1; j++) {
        for (var i = i0; i <= i1; i++) {
          var c = this.cells[j * nx + i];
          if (!c) c = this.cells[j * nx + i] = [];
          c.push(t);
        }
      }
    }
  }
  TopIndex.prototype.cx = function (x) { return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.min[0]) / this.sx))); };
  TopIndex.prototype.cz = function (z) { return Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.min[2]) / this.sz))); };
  /* Height of the highest surface under/over (x, z), or null. */
  TopIndex.prototype.top = function (x, z) {
    if (x < this.min[0] - 1e-9 || x > this.max[0] + 1e-9 || z < this.min[2] - 1e-9 || z > this.max[2] + 1e-9) return null;
    var cell = this.cells[this.cz(z) * this.nx + this.cx(x)];
    if (!cell) return null;
    var S = this.soup, best = null, EPS = 1e-7;
    for (var q = 0; q < cell.length; q++) {
      var t = cell[q];
      var ax = S[t], ay = S[t + 1], az = S[t + 2], bx = S[t + 3], by = S[t + 4], bz = S[t + 5],
          cx = S[t + 6], cy = S[t + 7], cz = S[t + 8];
      var det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(det) < 1e-12) continue;
      var u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det;
      var v = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det;
      if (u < -EPS || v < -EPS || u + v > 1 + EPS) continue;
      var y = ay + u * (by - ay) + v * (cy - ay);
      if (best === null || y > best) best = y;
    }
    return best;
  };

  /* The outermost surface along unit `dir` at the point q (the largest
     coordinate along dir where the line q + s*dir meets the piece), or null.
     Moller-Trumbore over every triangle: used for the odd sprue, not the
     default one. */
  function outermost(soup, q, dir) {
    var best = null;
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var e1x = soup[t + 3] - soup[t], e1y = soup[t + 4] - soup[t + 1], e1z = soup[t + 5] - soup[t + 2];
      var e2x = soup[t + 6] - soup[t], e2y = soup[t + 7] - soup[t + 1], e2z = soup[t + 8] - soup[t + 2];
      var px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
      var det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      var tx = q[0] - soup[t], ty = q[1] - soup[t + 1], tz = q[2] - soup[t + 2];
      var u = (tx * px + ty * py + tz * pz) / det;
      if (u < -1e-7 || u > 1 + 1e-7) continue;
      var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      var w = (dir[0] * qx + dir[1] * qy + dir[2] * qz) / det;
      if (w < -1e-7 || u + w > 1 + 1e-7) continue;
      var s = (e2x * qx + e2y * qy + e2z * qz) / det;       // q + s*dir is on the triangle
      if (best === null || s > best) best = s;
    }
    return best === null ? null : dot(q, dir) + best;
  }

  /* Points on the disc of radius r across axis `dir` about `c`: the centre, a
     ring of 12, and an inner ring of 6. */
  function discPoints(c, dir, r) {
    var uv = across(dir), u = uv[0], v = uv[1], pts = [c.slice()], k, ang;
    for (k = 0; k < 12; k++) {
      ang = (2 * Math.PI * k) / 12;
      pts.push([c[0] + (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * r, c[1] + (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * r,
                c[2] + (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * r]);
    }
    for (k = 0; k < 6; k++) {
      ang = (2 * Math.PI * k) / 6;
      pts.push([c[0] + (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)) * r / 2, c[1] + (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)) * r / 2,
                c[2] + (u[2] * Math.cos(ang) + v[2] * Math.sin(ang)) * r / 2]);
    }
    return pts;
  }

  /* How far along `dir` the cavity's outermost surface reaches across the disc
     of radius r about `c` - the least of them, so a channel started
     seatBelowMm under it has its whole mouth inside the cavity. Null when the
     centre is not over the piece. dir +y is answered from the index.

     Only the samples that are part of the same surface count: one that lies
     more than SEAT_BAND_MM under the centre's is over a pocket or past an
     edge, where the mouth is over mold (a channel may bore through that), not
     over the cavity, and it must not drag the seat down into it. */
  var SEAT_BAND_MM = 1.5;
  function ceilingOver(ctx, c, dir, r) {
    var pts = discPoints(c, dir, r), hs = [], i;
    for (i = 0; i < pts.length; i++) {
      var h;
      if (dir[1] === 1) { var y = ctx.index.top(pts[i][0], pts[i][2]); h = y === null ? null : y; }
      else h = outermost(ctx.soup, pts[i], dir);
      if (i === 0 && h === null) return null;
      hs.push(h);
    }
    var least = hs[0];
    for (i = 1; i < hs.length; i++) if (hs[i] !== null && hs[i] >= hs[0] - SEAT_BAND_MM && hs[i] < least) least = hs[i];
    return least;
  }

  /* ----------------------------------------------------------- sprue, vent */
  var AXES = { '+y': [0, 1, 0], '+x': [1, 0, 0], '-x': [-1, 0, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

  /* One channel: from a seat inside the cavity, straight along `dir`, out
     past the block's face. `at` is the point on the cavity surface it serves. */
  function channel(ctx, at, dirKey, r, block) {
    var dir = AXES[dirKey], ceil = ceilingOver(ctx, at, dir, r);
    if (ceil === null) return null;
    var ai = dir[0] ? 0 : dir[1] ? 1 : 2, sgn = dir[ai];
    var face = sgn > 0 ? block.max[ai] : block.min[ai];
    var from = at.slice(), to = at.slice();
    from[ai] = sgn * (ceil - ctx.opt.seatBelowMm);       // ceil is a coordinate along dir
    to[ai] = face + sgn * ctx.opt.exitPastMm;
    return { dir: dirKey, r: r, from: from, to: to, at: at.slice(), face: face,
             lengthMm: Math.abs(face - at[ai]) };
  }

  /* Is a channel wholly on A's side of the plane (every disc point at both
     ends, 0.3 mm to spare)? */
  function channelAbove(ch, plane) {
    var dir = AXES[ch.dir], ends = [ch.from, ch.to];
    for (var e = 0; e < 2; e++) {
      var pts = discPoints(ends[e], dir, ch.r);
      for (var i = 0; i < pts.length; i++) if (dist(plane, pts[i]) < 0.3) return false;
    }
    return true;
  }

  /* The default pour spot: the cavity's highest point. A flat top, or a ring
     of equal tops, is answered by the middle of them, laid on the surface. */
  function highestPoint(ctx) {
    var S = ctx.soup, top = -Infinity, i;
    for (i = 1; i < S.length; i += 3) if (S[i] > top) top = S[i];
    var sx = 0, sz = 0, n = 0, one = null;
    for (i = 0; i < S.length; i += 3) {
      if (S[i + 1] >= top - 0.05) { sx += S[i]; sz += S[i + 2]; n++; if (!one) one = [S[i], S[i + 1], S[i + 2]]; }
    }
    var cx = sx / n, cz = sz / n, y = ctx.index.top(cx, cz);
    if (y !== null && y >= top - 0.5) return [cx, y, cz];
    // the middle of the tops is not on the piece (a ring, a rim): the top vertex nearest that middle
    var best = one, bd = Infinity;
    for (i = 0; i < S.length; i += 3) {
      if (S[i + 1] < top - 0.05) continue;
      var d = Math.hypot(S[i] - cx, S[i + 2] - cz);
      if (d < bd - 1e-9) { bd = d; best = [S[i], S[i + 1], S[i + 2]]; }
    }
    return best;
  }

  /* Every place a vent could start: a spot on the piece's top surface, clear
     of the sprue, with its whole mouth over the cavity. None of it depends on
     the parting plane, so it is read once and the plane only picks from it. */
  function ventCandidates(ctx, pour, b) {
    var o = ctx.opt, rv = o.ventDiaMm / 2, rs = o.sprueDiaMm / 2, sep = rs + rv + 1.5;
    var cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    var dx = pour.at[0] - cx, dz = pour.at[2] - cz, dl = Math.hypot(dx, dz);
    var u = dl > 1 ? [-dx / dl, -dz / dl] : [1, 0];                 // the far side from the pour
    var step = Math.max(0.5, Math.min(2, Math.max(b.size[0], b.size[2]) / 60));
    var list = [];
    for (var x = b.min[0] + rv; x <= b.max[0] - rv + 1e-9; x += step) {
      for (var z = b.min[2] + rv; z <= b.max[2] - rv + 1e-9; z += step) {
        if (Math.hypot(x - pour.at[0], z - pour.at[2]) < sep) continue;
        var y = ctx.index.top(x, z);
        if (y === null) continue;
        var at = [x, y, z], ring = discPoints(at, [0, 1, 0], rv), ok = true;
        for (var k = 1; k < ring.length && ok; k++) if (ctx.index.top(ring[k][0], ring[k][2]) === null) ok = false;
        if (!ok) continue;
        var ch = channel(ctx, at, '+y', rv, ctx.block);
        if (ch) list.push({ at: at, ch: ch, along: (x - cx) * u[0] + (z - cz) * u[1] });
      }
    }
    return list;
  }

  /* The vent: of the candidates wholly above the plane, the highest, and of
     those within 0.3 mm of it the one furthest round the far side. */
  function chooseVent(cands, plane) {
    var ok = cands.filter(function (c) { return channelAbove(c.ch, plane); }), bestY = -Infinity, best = null;
    ok.forEach(function (c) { if (c.at[1] > bestY) bestY = c.at[1]; });
    ok.forEach(function (c) {
      if (c.at[1] < bestY - 0.3) return;
      if (!best || c.along > best.along) best = c;
    });
    return best ? best.ch : null;
  }

  /* ----------------------------------------------------------------- keys */
  function keyShape(o) {
    var rb = o.keyDiaMm / 2, tan = Math.tan(rad(o.keyAngleDeg)), h = o.keyHeightMm;
    var rt = Math.max(0, rb - h * tan);
    return { rb: rb, rt: rt, h: h, g: o.keyGapMm, rs: rb + o.keyGapMm, depth: h + o.keyGapMm, tan: tan,
             maxHeight: rb / tan };
  }

  /* The four key positions on the plane: the block footprint's corners inset
     Wall/2, each with the plane's normal. */
  function keyPlaces(block, plane, o) {
    var inset = o.wallMm / 2, out = [];
    [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(function (s) {
      var x = s[0] > 0 ? block.max[0] - inset : block.min[0] + inset;
      var z = s[1] > 0 ? block.max[2] - inset : block.min[2] + inset;
      out.push({ o: [x, planeY(plane, x, z), z], a: plane.n.slice() });
    });
    return out;
  }

  /* Cone (on A, standing out of A's face toward B) and socket (in B). The stub
     of 1 mm gives the union / the subtraction a body to bite into, so the
     solid and the face are never merely touching. */
  function coneSolid(place, k) {
    var prof = [[0, 1], [k.rb, 1], [k.rb, 0]];
    if (k.rt > 1e-6) prof.push([k.rt, -k.h]);
    prof.push([0, -k.h]);
    return revolve(place.o, place.a, prof, DEFAULTS.segs);          // t>0 is into A (along +n)
  }
  function socketSolid(place, k) {
    var a = mul(place.a, -1);                                         // t>0 is into B (along -n)
    var prof = [[0, -1], [k.rs, -1], [k.rs, 0]];
    var rt = Math.max(0, k.rs - k.depth * k.tan);
    if (rt > 1e-6) prof.push([rt, k.depth]);
    prof.push([0, k.depth]);
    return revolve(place.o, a, prof, DEFAULTS.segs);
  }

  /* Exact polygonal volume of what a cone stands out of the face, and of what a
     socket takes from B (the parts either side of the face; not the stubs). */
  function frustumVolume(r0, r1, h, segs) {
    var f = (segs / 2) * Math.sin((2 * Math.PI) / segs);               // n-gon area / r^2
    return f * h * (r0 * r0 + r0 * r1 + r1 * r1) / 3;
  }
  function keyVolumes(opt) {
    var o = normalize(opt), k = keyShape(o), segs = DEFAULTS.segs;
    var rt = Math.max(0, k.rs - k.depth * k.tan);
    return { cone: frustumVolume(k.rb, k.rt, k.h, segs), socket: frustumVolume(k.rs, rt, k.depth, segs) };
  }

  /* ------------------------------------------------------------- the options */
  function normalize(opt) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opt) for (k in opt) if (opt[k] != null && isFinite(opt[k]) && (k in DEFAULTS)) o[k] = Number(opt[k]);
    o.wallMm = Math.max(0, o.wallMm); o.capMm = Math.max(0, o.capMm);
    o.keyDiaMm = Math.max(0.5, o.keyDiaMm);
    var tan = Math.tan(rad(o.keyAngleDeg));
    o.keyHeightMm = Math.max(0.1, Math.min(o.keyHeightMm, o.keyDiaMm / 2 / tan));
    return o;
  }

  /* ------------------------------------------------------------------ plan */
  /* Everything the card shows and Generate needs, with no boolean run.

     soup     the piece in world coordinates (y up), faces out
     opt      { mm, tiltDeg, headingDeg, wallMm, capMm, keyDiaMm, keyHeightMm,
                pour: [x, y, z] | null (a clicked spot on the piece) }
     env      { printer: { w, d, h } | null, cache: {} }   (cache keeps the index)

     Returns { ok, refusals[], warnings[], bounds, plane, block, lock, pour, vent,
               keys, fit } - refusals say what stops Generate, in words. */
  function plan(soup, opt, env) {
    env = env || {};
    var o = normalize(opt), b = bounds(soup), refusals = [], warnings = [];
    var cache = env.cache || {};
    if (cache.soup !== soup) { cache.soup = soup; cache.index = null; cache.census = null; cache.vol = null; cache.ventKey = null; cache.high = null; cache.routeKey = null; }
    if (!cache.census) cache.census = census(soup);
    if (cache.vol == null) cache.vol = volume(soup);
    if (!cache.index) cache.index = new TopIndex(soup);

    var plane = planeOf(b, opt || {});
    var block = { min: [b.min[0] - o.wallMm, b.min[1] - o.capMm, b.min[2] - o.wallMm],
                  max: [b.max[0] + o.wallMm, b.max[1] + o.capMm, b.max[2] + o.wallMm] };
    block.size = [block.max[0] - block.min[0], block.max[1] - block.min[1], block.max[2] - block.min[2]];
    var out = { ok: true, refusals: refusals, warnings: warnings, bounds: b, plane: plane, block: block,
                opt: o, census: cache.census, pieceMm3: cache.vol };

    // 1. the piece must be a closed solid
    var cz = cache.census;
    if (!cz.closed) {
      var why = [];
      if (cz.open) why.push(cz.open + ' open edge(s)');
      if (cz.nm) why.push(cz.nm + ' non-manifold edge(s)');
      if (cz.wrong) why.push(cz.wrong + ' wrongly-wound edge(s)');
      refusals.push('The piece is not closed (' + (why.join(', ') || 'no triangles') +
        ') - a mold needs a solid to take the shape of. Repair it first (Check & repair).');
    } else if (cache.vol < 0) {
      refusals.push('The piece is inside-out (its faces point inward), so the block cannot take its shape. ' +
        'Turn it right-side-out first (Cut offers that, or Check & repair).');
    }

    // 2. the plane must pass through the piece
    if (!crosses(soup, plane)) {
      refusals.push('The parting plane does not pass through the piece - slide it, or tilt it less, until it does.');
    }

    // 3. the block must fit the plate
    out.fit = null;
    if (env.printer) {
      var P = env.printer, w = P.w, d = P.d, h = P.h;
      var halfH = plane.tiltDeg === 0
        ? Math.max(plane.p0[1] - block.min[1], block.max[1] - plane.p0[1]) : block.size[1];
      var bx = block.size[0], bz = block.size[2];
      // the halves are laid as they come, not turned: the footprint must fit as it is
      var fits = bx <= w + 1e-6 && bz <= d + 1e-6 && (!h || halfH <= h + 1e-6);
      var turned = bx <= d + 1e-6 && bz <= w + 1e-6 && (!h || halfH <= h + 1e-6);
      out.fit = { fits: fits, block: block.size.slice(), halfH: halfH, plate: [w, d, h || null] };
      if (!fits) {
        refusals.push('Too big for the plate: the mold block would be ' + bx.toFixed(1) + ' x ' + bz.toFixed(1) + ' x ' +
          block.size[1].toFixed(1) + ' mm (the piece ' + b.size[0].toFixed(1) + ' x ' + b.size[2].toFixed(1) + ' x ' +
          b.size[1].toFixed(1) + ' mm plus the walls), and the plate takes ' + w + ' x ' + d + (h ? ' x ' + h : '') + ' mm. ' +
          (turned ? 'Turn the piece 90\u00b0 on the plate (Rotate) and it would fit.' : 'Use a smaller piece or thinner walls.'));
      }
    }

    // 4. the keys must fit the parting face
    var k = keyShape(o), places = keyPlaces(block, plane, o);
    var cosT = Math.max(0.2, plane.n[1]);
    var minWall = 2 * (k.rs / cosT + o.keyWebMm);
    out.keys = { ok: true, places: places, shape: k, minWallMm: minWall };
    var keyBad = o.wallMm + 1e-9 < minWall;
    if (!keyBad) {
      // every vertex of every cone and socket inside the block, a web to spare
      places.forEach(function (p) {
        [coneSolid(p, k), socketSolid(p, k)].forEach(function (s) {
          for (var i = 0; i < s.length; i += 3) {
            for (var a = 0; a < 3; a++) {
              if (s[i + a] < block.min[a] + o.keyWebMm - 1e-6 || s[i + a] > block.max[a] - o.keyWebMm + 1e-6) keyBad = true;
            }
          }
        });
      });
    }
    if (keyBad) {
      out.keys.ok = false;
      refusals.push('The keys would not fit the parting face: the minimum wall for a Ø' + o.keyDiaMm + ' key and its socket is ' +
        (Math.ceil(minWall * 10) / 10) + ' mm, and Wall is ' + o.wallMm + ' mm' +
        (plane.tiltDeg ? ' (and the tilted plane must stay inside the block at all four corners)' : '') +
        '. Thicken the wall or use a smaller Key Ø.');
    }
    if (opt && opt.keyHeightMm != null && Number(opt.keyHeightMm) > o.keyHeightMm + 1e-9) {
      warnings.push('Key height limited to ' + o.keyHeightMm.toFixed(1) + ' mm (a ' + o.keyAngleDeg + '° cone of Ø' + o.keyDiaMm + ' ends in a point there).');
    }

    // 5. locks (a warning)
    out.lock = lockAnalysis(soup, plane);

    // 6. the pour and the vent
    out.pour = null; out.vent = null;
    if (cz.closed && cache.vol > 0) {
      var ctx = { soup: soup, index: cache.index, opt: o, block: block };
      var sp = null, auto = true, pt = null, reason = '';
      if (opt && opt.pour) {
        auto = false;
        var res = routePour(ctx, opt.pour, plane, cache);
        if (res.ok) sp = res.ch; else reason = res.reason;
      }
      if (!sp) {
        pt = cache.high || (cache.high = highestPoint(ctx));
        if (pt) sp = channel(ctx, pt, '+y', o.sprueDiaMm / 2, block);
        if (sp && !channelAbove(sp, plane)) {
          if (auto) reason = 'The cavity\'s highest point is too close to the parting plane for a Ø' + o.sprueDiaMm + ' sprue above it.';
          sp = null;
        }
      }
      if (sp) {
        // auto: at the highest point (by default, or because the click could not be served)
        out.pour = { ok: true, auto: auto || !!reason, ch: sp, point: sp.at, dir: sp.dir, lengthMm: sp.lengthMm };
        if (!out.pour.auto) out.pour.clicked = opt.pour.slice();
        if (reason && !auto) { out.pour.note = reason; warnings.push(reason + ' The pour is back at the highest point.'); }
        var vkey = [o.sprueDiaMm, o.ventDiaMm, o.wallMm, o.capMm, sp.at.join(',')].join('|');
        if (cache.ventKey !== vkey) { cache.ventList = ventCandidates(ctx, out.pour.ch, b); cache.ventKey = vkey; }
        var vt = chooseVent(cache.ventList, plane);
        out.vent = vt ? { ok: true, ch: vt, point: vt.at } : { ok: false, reason: 'No room for a Ø' + o.ventDiaMm + ' vent on the far side of the cavity.' };
        if (!vt) warnings.push(out.vent.reason + ' The mold is made without one.');
      } else {
        out.pour = { ok: false, reason: reason || 'No place for a sprue above the parting plane.' };
        refusals.push(out.pour.reason);
      }
      out.ctx = ctx;
    }
    out.ok = refusals.length === 0;
    return out;
  }

  /* A clicked spot on the piece: the sprue goes straight to the nearest outer
     face it can reach - up, or out sideways - from a surface that looks that
     way, above the parting plane. The candidates (one per direction, nearest
     first) do not depend on the plane, so they are read once per click and the
     plane only picks from them. */
  function routePour(ctx, p, plane, cache) {
    var o = ctx.opt, r = o.sprueDiaMm / 2;
    if (dist(plane, p) < r + 0.3) {
      return { ok: false, reason: 'That spot is too close to the parting plane (or under it): the sprue needs ' +
        (r + 0.3).toFixed(1) + ' mm of mold above the plane. Click higher on the piece, or move the plane down.' };
    }
    var key = [p.join(','), o.sprueDiaMm, o.wallMm, o.capMm].join('|');
    if (!cache || cache.routeKey !== key) {
      var tries = [];
      for (var k in AXES) {
        var d = AXES[k], ai = d[0] ? 0 : d[1] ? 1 : 2, face = d[ai] > 0 ? ctx.block.max[ai] : ctx.block.min[ai];
        // it must be the piece's own outermost surface that way, or the line runs back through the piece
        var ceil = ceilingOver({ soup: ctx.soup, index: ctx.index }, p, d, 0.01);
        if (ceil === null || ceil - dot(p, d) > 0.05) continue;
        var ch = channel(ctx, p, k, r, ctx.block);
        if (ch) tries.push({ ch: ch, L: Math.abs(face - p[ai]) - (k === '+y' ? 0.5 : 0) });   // up wins a tie
      }
      tries.sort(function (a, b) { return a.L - b.L; });
      if (cache) { cache.routeKey = key; cache.routes = tries; }
      else cache = { routes: tries };
    }
    var list = cache.routes;
    for (var i = 0; i < list.length; i++) if (channelAbove(list[i].ch, plane)) return { ok: true, ch: list[i].ch };
    return { ok: false, reason: 'No straight sprue reaches the outside from there: click a surface that looks up or out, with room above the parting plane.' };
  }

  /* ------------------------------------------------------------------ build */
  function fail(reason, extra) {
    var r = { ok: false, reason: reason };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  /* The mold: { ok, A: soup, B: soup, stats } or { ok: false, reason }.
     `pl` is plan()'s result for the same soup. kernel as the header says. */
  async function build(soup, pl, kernel) {
    if (!pl || !pl.ok) return fail((pl && pl.refusals && pl.refusals[0]) || 'nothing to build');
    var o = pl.opt, plane = pl.plane, block = pl.block, k = pl.keys.shape;
    var stage = 'block';
    try {
      var blockSoup = boxSoup(block.min, block.max);
      var vBlock = volume(blockSoup);

      stage = 'cavity';
      var c = await kernel.subtract(blockSoup, soup);
      if (!c.ok) return fail('The piece could not be taken out of the block (' + c.reason + ').', { stage: stage });
      var cav = c.soup;
      var sprueSolid = null, ventSolid = null;
      stage = 'sprue';
      sprueSolid = cylinder(pl.pour.ch.from, pl.pour.ch.to, pl.pour.ch.r, DEFAULTS.segs);
      c = await kernel.subtract(cav, sprueSolid);
      if (!c.ok) return fail('The sprue could not be cut into the block (' + c.reason + ').', { stage: stage });
      cav = c.soup;
      if (pl.vent && pl.vent.ok) {
        stage = 'vent';
        ventSolid = cylinder(pl.vent.ch.from, pl.vent.ch.to, pl.vent.ch.r, DEFAULTS.segs);
        c = await kernel.subtract(cav, ventSolid);
        if (!c.ok) return fail('The vent could not be cut into the block (' + c.reason + ').', { stage: stage });
        cav = c.soup;
      }
      var vCavityBlock = volume(cav);

      stage = 'split';
      var R = laying(plane), work = R ? turn(cav, R, false) : cav;
      var cutAt = R ? plane.c : plane.c;       // R n = +y, so the plane is y = c in the laid frame
      var up, down;
      try {
        up = kernel.cutSide(work, 1, cutAt, true);
        down = kernel.cutSide(work, 1, cutAt, false);
      } catch (err) {
        return fail('The block could not be split at the parting plane (' + ((err && err.message) || err) + ').', { stage: stage });
      }
      /* The keys are made in the LAID frame, where the parting face is exactly
         y = c on both halves: a cone standing on a face that is only almost
         plane (a tilted one, after the turn back) leaves slivers behind in
         the union. Turned back last, by the one matrix, both halves' faces
         still meet. */
      stage = 'keys';
      var cLaid = Math.fround(plane.c);
      var places = pl.keys.places.map(function (p) {
        if (!R) return { o: [p.o[0], cLaid, p.o[2]], a: p.a };
        var q = turn(new Float32Array(p.o), R, false);
        return { o: [q[0], cLaid, q[2]], a: [0, 1, 0] };
      });
      var cones = concat(places.map(function (p) { return coneSolid(p, k); }));
      var sockets = concat(places.map(function (p) { return socketSolid(p, k); }));
      c = await kernel.union(up, cones);
      if (!c.ok) return fail('The keys could not be joined to half A (' + c.reason + ').', { stage: stage });
      var A = c.soup;
      c = await kernel.subtract(down, sockets);
      if (!c.ok) return fail('The sockets could not be cut into half B (' + c.reason + ').', { stage: stage });
      var B = c.soup;
      if (R) { A = turn(A, R, true); B = turn(B, R, true); }

      // both halves open: A turned over about the x axis through the block's middle
      var cy = (block.min[1] + block.max[1]) / 2, cz = (block.min[2] + block.max[2]) / 2;
      var Af = new Float32Array(A.length);
      for (var i = 0; i < A.length; i += 3) { Af[i] = A[i]; Af[i + 1] = 2 * cy - A[i + 1]; Af[i + 2] = 2 * cz - A[i + 2]; }

      var ca = census(Af), cb = census(B);
      if (!ca.closed || !cb.closed) {
        return fail('A mold half came out open (A: ' + ca.open + ' open / ' + ca.nm + ' non-manifold; B: ' + cb.open + ' open / ' +
          cb.nm + ' non-manifold) - nothing was made.', { stage: 'check', censusA: ca, censusB: cb });
      }
      var vA = volume(Af), vB = volume(B);
      return { ok: true, A: Af, B: B, openA: A, stats: {
        blockMm3: vBlock, pieceMm3: pl.pieceMm3, cavityMm3: vBlock - vCavityBlock,
        volumeA: vA, volumeB: vB, censusA: ca, censusB: cb,
        sprueMm3: volume(sprueSolid), ventMm3: ventSolid ? volume(ventSolid) : 0,
        triangles: [Af.length / 9, B.length / 9] } };
    } catch (err) {
      return fail('The mold failed at ' + stage + ' (' + ((err && err.message) || err) + ') - nothing was made.', { stage: stage });
    }
  }

  var API = {
    DEFAULTS: DEFAULTS, LOCK_EPS: LOCK_EPS,
    bounds: bounds, volume: volume, census: census, boxSoup: boxSoup, cylinder: cylinder, revolve: revolve,
    flipWinding: flipWinding, concat: concat, limits: limits, planeOf: planeOf, dist: dist, planeY: planeY,
    crosses: crosses, laying: laying, turn: turn, lockAnalysis: lockAnalysis, TopIndex: TopIndex,
    keyShape: keyShape, keyPlaces: keyPlaces, coneSolid: coneSolid, socketSolid: socketSolid, keyVolumes: keyVolumes,
    normalize: normalize, plan: plan, build: build, AXES: AXES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Mold = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
