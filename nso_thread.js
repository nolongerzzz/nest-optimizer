/* nso_thread.js - Threads: one helical-thread engine, and the pieces built on it - threaded rods, bolts and
   nuts, pipe/fitting ends (male and female, straight and tapered), and the cutter for a tapped hole.
   docs/THREADS.md.

   Headless: no DOM, no THREE, no boolean kernel. Loads as a classic script (window.NSO_Thread) and as a
   Node module; tools/nso_thread_test.js drives it. app-fasteners.js (Gen+ > Fasteners), app-fittings.js
   (Gen+ > Fittings) and nso_punch.js (Punch > Thread) are the callers.

   ---------------------------------------------------------------------------
   THE SURFACE
   ---------------------------------------------------------------------------
   A single-start thread is one function of two numbers: its radius at angle theta and height z is
   f(s), s = z - hand * P * theta / 2pi, f periodic with the pitch P. f is a trapezoid - a crest flat at
   the major radius, two flanks at the thread's half-angle, a root flat at the minor radius - so the
   whole surface is a grid whose rows are the profile's four corner points, each row a helix:

       vertex (i, row)   theta_i = 2pi i / N,    z = u_b + k P + hand * P * i / N,    r = r_b (+ taper)

   Column N is column 0 one pitch up (row + hand * 4), which closes the grid on itself without a seam
   and without a single T-junction. The grid is built a couple of turns longer than asked and CLIPPED to
   the two flat planes z0 and z1, in one pass: every triangle becomes its part of the slab, a crossing
   point is made once per grid edge and shared by both its triangles (same bits, so the clipped surface
   is watertight). The cut at a plane is a closed curve r(theta) - star-shaped about the axis - so it is
   closed with a fan from the axis (a rod's end) or an annulus to the bore (a nut's, a pipe's), the
   annulus walked by angle between the two loops.

   THE PIECE
   A piece is a stack of SEGMENTS between planes, each with an outer surface and perhaps an inner one (a
   bore): a hex head, then a thread; a hex collar with a thread bore at one end and a plain bore through
   the rest. Where two segments meet, the faces between their outer loops (and their bores') close the
   step; it is refused if two loops cross (a step must be nested). The outer surfaces are: a plain
   circle, a regular polygon (a hex), or a thread. Nothing is unioned, subtracted or repaired: the mesh is
   closed, 2-manifold and wound outward as it is made.

   THE FIT
   An EXTERNAL thread is the profile at its nominal size: a Ø8 bolt's crests are Ø8. An INTERNAL thread (a
   nut's bore, a socket, a tapped hole's cutter) is the same profile with a radial `fit` added (0.2 mm
   default - a printed thread, loose enough to turn) at crests and roots alike. So a bolt and a nut of
   one size, made here, turn on each other, and a hole made by Punch takes the bolt Fasteners makes.

   FAMILIES (profile = crest flat, root flat, flank angle; all truncated more than the standard's, for a
   nozzle):
       metric     60 deg, crest P/8, depth 0.6134 P (root flat P/6); coarse M2..M30, and a fine pitch each
       whitworth  55 deg, crest P/6, depth 0.6403 P (root flat P/6); G (BSP parallel) pipe threads, which
                  seal with a washer or tape, not by the thread
       npt        60 deg, crest P/10, depth 0.6928 P; TAPERED 1:16 on the diameter, NPT pipe sizes
   Sizes outside the tables are a typed major Ø and pitch.

   PAINT SCOPE: NOT APPLICABLE here - this file builds new pieces from numbers; nothing of a model is read
   or written. The apps that place them carry their own checks (docs/HANDOFF.md). */

(function (root) {
  'use strict';

  var DEFAULTS = {
    nozzle: 0.4,
    fit: 0.2,             // internal thread: radial clearance, mm
    chordMm: 0.5,         // longest facet round a thread's outside
    minColumns: 36, maxColumns: 240,
    plainSides: 96,       // sides of a plain circle (a bore, a shank, a collar)
    minDepthNozzles: 0.5, // a thread shallower than this many nozzle widths is refused (it cannot form)
    softPitchNozzles: 2   // ...and one finer than this many gets a note: it will print as a rough groove
  };
  /* A plain shank stands this far over the thread's crests: the step between the two outlines must be wider than either's chord sag (a few
     microns), or the ring that closes it grazes the thread's wall. 0.1 mm does not print. */
  var SHANK_STEP = 0.1;
  var SNAP = 3e-4;        // mm: a thread vertex this near a clip plane is moved onto it (0.3 um). The app welds at 1e-4 (NSO_Repair.WELD_TOL, mesh_validate.py), so a
                          // crossing point closer than that to a vertex would be welded into it and leave a sliver; nothing is left within 3 times that

  var FAMILY = {
    metric:    { label: 'ISO metric 60°',            angle: 60, crest: 1 / 8,  depth: 0.61343,  taper: 0 },
    whitworth: { label: 'Whitworth 55° (G, BSP parallel)', angle: 55, crest: 1 / 6,  depth: 0.640327, taper: 0 },
    npt:       { label: 'NPT 60° taper 1:16',         angle: 60, crest: 0.1,    depth: 0.6928,   taper: 1 / 16 }
  };

  /* ----------------------------------------------------------- size tables */
  var SIZES = {};
  function addSize(id, family, major, pitch, note) { SIZES[id] = { id: id, family: family, major: major, pitch: pitch, note: note || '' }; }
  [['M2', 2, 0.4], ['M2.5', 2.5, 0.45], ['M3', 3, 0.5], ['M4', 4, 0.7], ['M5', 5, 0.8], ['M6', 6, 1], ['M8', 8, 1.25], ['M10', 10, 1.5],
   ['M12', 12, 1.75], ['M14', 14, 2], ['M16', 16, 2], ['M18', 18, 2.5], ['M20', 20, 2.5], ['M24', 24, 3], ['M30', 30, 3.5]].forEach(function (s) { addSize(s[0], 'metric', s[1], s[2], 'coarse'); });
  [['M8x1', 8, 1], ['M10x1.25', 10, 1.25], ['M10x1', 10, 1], ['M12x1.5', 12, 1.5], ['M12x1.25', 12, 1.25], ['M14x1.5', 14, 1.5], ['M16x1.5', 16, 1.5],
   ['M18x1.5', 18, 1.5], ['M20x1.5', 20, 1.5], ['M24x2', 24, 2], ['M30x2', 30, 2]].forEach(function (s) { addSize(s[0], 'metric', s[1], s[2], 'fine'); });
  [['G1/8', 9.728, 28], ['G1/4', 13.157, 19], ['G3/8', 16.662, 19], ['G1/2', 20.955, 14], ['G3/4', 26.441, 14], ['G1', 33.249, 11],
   ['G1-1/4', 41.910, 11], ['G1-1/2', 47.803, 11], ['G2', 59.614, 11]].forEach(function (s) { addSize(s[0], 'whitworth', s[1], 25.4 / s[2], s[2] + ' TPI'); });
  [['NPT1/8', 10.287, 27], ['NPT1/4', 13.716, 18], ['NPT3/8', 17.145, 18], ['NPT1/2', 21.336, 14], ['NPT3/4', 26.670, 14], ['NPT1', 33.401, 11.5],
   ['NPT1-1/4', 42.164, 11.5], ['NPT1-1/2', 48.260, 11.5], ['NPT2', 60.325, 11.5]].forEach(function (s) { addSize(s[0], 'npt', s[1], 25.4 / s[2], s[2] + ' TPI'); });

  /* nut / head dimensions (ISO 4032 / 4017 / 4762), by metric major. Sizes not here take the fit below. */
  var HW = {
    2:   { nutAF: 4,   nutM: 1.6,  headAF: 4,   headK: 1.4, capD: 3.8, capK: 2,  sock: 1.5 },
    2.5: { nutAF: 5,   nutM: 2,    headAF: 5,   headK: 1.7, capD: 4.5, capK: 2.5, sock: 2 },
    3:   { nutAF: 5.5, nutM: 2.4,  headAF: 5.5, headK: 2,   capD: 5.5, capK: 3,  sock: 2.5 },
    4:   { nutAF: 7,   nutM: 3.2,  headAF: 7,   headK: 2.8, capD: 7,   capK: 4,  sock: 3 },
    5:   { nutAF: 8,   nutM: 4.7,  headAF: 8,   headK: 3.5, capD: 8.5, capK: 5,  sock: 4 },
    6:   { nutAF: 10,  nutM: 5.2,  headAF: 10,  headK: 4,   capD: 10,  capK: 6,  sock: 5 },
    8:   { nutAF: 13,  nutM: 6.8,  headAF: 13,  headK: 5.3, capD: 13,  capK: 8,  sock: 6 },
    10:  { nutAF: 16,  nutM: 8.4,  headAF: 16,  headK: 6.4, capD: 16,  capK: 10, sock: 8 },
    12:  { nutAF: 18,  nutM: 10.8, headAF: 18,  headK: 7.5, capD: 18,  capK: 12, sock: 10 },
    14:  { nutAF: 21,  nutM: 12.8, headAF: 21,  headK: 8.8, capD: 21,  capK: 14, sock: 12 },
    16:  { nutAF: 24,  nutM: 14.8, headAF: 24,  headK: 10,  capD: 24,  capK: 16, sock: 14 },
    18:  { nutAF: 27,  nutM: 15.8, headAF: 27,  headK: 11.5, capD: 27, capK: 18, sock: 14 },
    20:  { nutAF: 30,  nutM: 18,   headAF: 30,  headK: 12.5, capD: 30, capK: 20, sock: 17 },
    24:  { nutAF: 36,  nutM: 21.5, headAF: 36,  headK: 15,  capD: 36, capK: 24, sock: 19 },
    30:  { nutAF: 46,  nutM: 25.6, headAF: 46,  headK: 18.7, capD: 45, capK: 30, sock: 22 }
  };
  function hardware(major) {
    var h = HW[major];
    if (h) return h;
    var r1 = function (x) { return Math.round(x * 10) / 10; };
    return { nutAF: r1(1.5 * major + 1), nutM: r1(0.8 * major), headAF: r1(1.5 * major + 1), headK: r1(0.65 * major), capD: r1(1.5 * major), capK: major, sock: r1(0.8 * major) };
  }

  /* ------------------------------------------------------------- helpers */
  function fmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
  function num(x) { return (x == null || x === '' || !isFinite(+x)) ? null : +x; }
  function floorFor(nozzle) {
    var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : (root && root.NSO_Thickness) || null;
    if (T && typeof T.floorFor === 'function') return T.floorFor(nozzle);
    return nozzle * 1.05;                                    // nso_thickness.js's own: one extrusion line
  }
  function nozzleOf(o) { return (o && typeof o.nozzle === 'number' && o.nozzle > 0) ? o.nozzle : DEFAULTS.nozzle; }
  function columnsFor(r) {
    var n = Math.max(DEFAULTS.minColumns, Math.min(DEFAULTS.maxColumns, Math.ceil(2 * Math.PI * Math.max(r, 0.1) / DEFAULTS.chordMm)));
    return Math.ceil(n / 4) * 4;                             // a multiple of 4: the quarter-turns are vertex columns
  }

  /* ----------------------------------------------------------------- spec */
  /* What a thread is called: its table id, unless the Ø or pitch was changed from the table's (then it is a thread of its own, named
     by its numbers: M7x1.5, Ø21.5x1.8). */
  function nameOf(base, major, pitch) {
    var tr = function (x) { return String(Math.round(x * 100) / 100); };
    var same = base.id && Math.abs(major - base.major) < 0.0051 && Math.abs(pitch - base.pitch) < 0.0051;
    if (same) return base.id;
    return (base.family === 'metric' ? 'M' : 'Ø') + tr(major) + 'x' + tr(pitch);
  }

  /* A thread as numbers. size: a table id ('M8', 'G1/2', 'NPT3/4') or { family, major, pitch }; o: { pitch, major,
     angle, hand 'right'|'left', nozzle }. Resolves { ok, reason, note, spec }. */
  function spec(size, o) {
    o = o || {};
    var res = { ok: false, reason: '', note: '' };
    var base = null;
    if (size && typeof size === 'object') base = { id: size.id || '', family: size.family || 'metric', major: num(size.major), pitch: num(size.pitch) };
    else if (typeof size === 'string' && SIZES[size]) base = SIZES[size];
    else if (typeof size === 'string' && SIZES[size.toUpperCase()]) base = SIZES[size.toUpperCase()];
    if (!base) { res.reason = 'unknown thread size "' + size + '" - one of ' + Object.keys(SIZES).join(', ') + ', or a major Ø and pitch'; return res; }
    var fam = FAMILY[base.family];
    if (!fam) { res.reason = 'unknown thread family "' + base.family + '"'; return res; }
    var major = num(o.major) != null ? num(o.major) : base.major, pitch = num(o.pitch) != null ? num(o.pitch) : base.pitch;
    if (!(major > 0)) { res.reason = 'enter the thread\'s major Ø in mm, more than 0'; return res; }
    if (!(pitch > 0)) { res.reason = 'enter the thread\'s pitch in mm, more than 0'; return res; }
    if (pitch >= major / 2) { res.reason = 'a pitch of ' + fmt(pitch) + ' mm is too coarse for a Ø' + fmt(major) + ' thread - under a quarter of the Ø'; return res; }
    var angle = num(o.angle) != null ? num(o.angle) : fam.angle;
    if (!(angle >= 20 && angle <= 90)) { res.reason = 'a thread angle of ' + fmt(angle, 1) + '° is outside 20° to 90°'; return res; }
    var hand = (o.hand === 'left' || o.hand === -1) ? -1 : 1;
    var nozzle = nozzleOf(o);
    var tn = Math.tan(angle * Math.PI / 360);
    var fc = fam.crest * pitch, h = fam.depth * pitch, fr = pitch - fc - 2 * h * tn;
    if (fr < pitch * 0.02) {                                // a steep flank at a wide angle: keep a root flat, give the depth up
      fr = pitch * 0.05;
      h = (pitch - fc - fr) / (2 * tn);
    }
    var w = h * tn;
    var R = major / 2;
    if (h >= R - 0.3) { res.reason = 'a ' + fmt(pitch) + ' mm pitch cuts ' + fmt(h) + ' mm deep - too deep for a Ø' + fmt(major) + ' thread'; return res; }
    if (h < DEFAULTS.minDepthNozzles * nozzle - 1e-9) {
      res.reason = 'a ' + fmt(pitch) + ' mm pitch is only ' + fmt(h, 3) + ' mm deep - under ' + DEFAULTS.minDepthNozzles + ' of a ' + nozzle + ' mm nozzle; it would not form. Use a pitch of at least ' +
        fmt(Math.ceil(DEFAULTS.minDepthNozzles * nozzle / fam.depth * 100) / 100) + ' mm';
      return res;
    }
    if (pitch < DEFAULTS.softPitchNozzles * nozzle - 1e-9) {
      res.note = 'a ' + fmt(pitch) + ' mm pitch is finer than a ' + nozzle + ' mm nozzle resolves well (' + fmt(DEFAULTS.softPitchNozzles * nozzle) + ' mm and up prints cleanly) - expect a rough thread, and try it before relying on it';
    }
    res.ok = true;
    res.spec = {
      id: nameOf(base, major, pitch), family: base.family, familyLabel: fam.label, major: major, pitch: pitch, angle: angle, hand: hand, R: R, P: pitch,
      h: h, fc: fc, fr: fr, w: w, minor: major - 2 * h, slope: fam.taper / 2, taper: fam.taper, nozzle: nozzle, note: base.note || ''
    };
    return res;
  }

  /* ----------------------------------------------------------------- mesh */
  function Mesh() { this.x = []; this.y = []; this.z = []; this.t = []; }
  Mesh.prototype.v = function (x, y, z) { this.x.push(x); this.y.push(y); this.z.push(z); return this.x.length - 1; };
  Mesh.prototype.tri = function (a, b, c) { this.t.push(a, b, c); };
  Mesh.prototype.soup = function () {
    var t = this.t, n = t.length / 3, out = new Float32Array(n * 9), q = 0;
    for (var i = 0; i < t.length; i++) { out[q++] = this.x[t[i]]; out[q++] = this.y[t[i]]; out[q++] = this.z[t[i]]; }
    return out;
  };
  Mesh.prototype.flipFrom = function (start) {          // reverse the winding of every triangle from index `start`
    for (var i = start; i < this.t.length; i += 3) { var b = this.t[i + 1]; this.t[i + 1] = this.t[i + 2]; this.t[i + 2] = b; }
  };
  function ang(M, h) { return Math.atan2(M.y[h], M.x[h]); }
  function sortLoop(M, loop) {
    var a = loop.map(function (h) { return { h: h, a: ang(M, h) }; });
    a.sort(function (p, q) { return p.a - q.a; });
    return a.map(function (e) { return e.h; });
  }
  function dedupe(a) { var seen = {}, out = []; a.forEach(function (h) { if (!seen[h]) { seen[h] = 1; out.push(h); } }); return out; }
  function loopsEqual(M, A, B) {
    if (!A || !B || A.length !== B.length) return false;
    var a = sortLoop(M, A), b = sortLoop(M, B);
    for (var i = 0; i < a.length; i++) if (Math.abs(M.x[a[i]] - M.x[b[i]]) > 1e-9 || Math.abs(M.y[a[i]] - M.y[b[i]]) > 1e-9) return false;
    return true;
  }
  function maxRadius(M, L) { var m = 0; L.forEach(function (h) { m = Math.max(m, Math.hypot(M.x[h], M.y[h])); }); return m; }
  function minRadius(M, L) {                             // the nearest the loop's EDGES come to the axis (a hex's flats, not its corners)
    var m = Infinity, n = L.length;
    for (var i = 0; i < n; i++) {
      var a = L[i], b = L[(i + 1) % n], ax = M.x[a], ay = M.y[a], dx = M.x[b] - ax, dy = M.y[b] - ay, d2 = dx * dx + dy * dy;
      var t = d2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / d2)) : 0;
      m = Math.min(m, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return m;
  }
  /* +1 A encloses B, -1 B encloses A, 0 the same loop; throws if they cross. null is the axis (a point). */
  function nest(M, A, B) {
    if (!A && !B) return 0;
    if (!A) return -1;
    if (!B) return 1;
    var As = sortLoop(M, A), Bs = sortLoop(M, B);
    if (loopsEqual(M, As, Bs)) return 0;
    var tol = 1e-6;
    if (minRadius(M, As) > maxRadius(M, Bs) + tol) return 1;
    if (minRadius(M, Bs) > maxRadius(M, As) + tol) return -1;
    throw new Error('two outlines at a step cross (Ø ' + fmt(2 * minRadius(M, As)) + '..' + fmt(2 * maxRadius(M, As)) + ' against Ø ' + fmt(2 * minRadius(M, Bs)) + '..' + fmt(2 * maxRadius(M, Bs)) + ') - a step must be nested');
  }

  /* The ring between two loops (outer, inner), or a disc when inner is null, as triangles facing +z (facing = 1) or -z. */
  function fan(M, center, loop, facing) {
    var L = sortLoop(M, loop), n = L.length;
    for (var i = 0; i < n; i++) {
      var a = L[i], b = L[(i + 1) % n];
      if (facing > 0) M.tri(center, a, b); else M.tri(center, b, a);
    }
  }
  function annulus(M, outer, inner, facing) {
    var A = sortLoop(M, outer), B = sortLoop(M, inner), n = A.length, m = B.length, TAU = 2 * Math.PI;
    var a0 = ang(M, A[0]), j0 = 0, best = Infinity, j;
    function wrap(x) { x = x % TAU; return x < 0 ? x + TAU : x; }
    for (j = 0; j < m; j++) {                             // start the walk where the two loops are angularly nearest
      var d = Math.abs(((ang(M, B[j]) - a0 + 3 * Math.PI) % TAU + TAU) % TAU - Math.PI);
      if (d < best) { best = d; j0 = j; }
    }
    B = B.slice(j0).concat(B.slice(0, j0));
    var ta = [], tb = [], i;
    for (i = 0; i < n; i++) ta.push(a0 + wrap(ang(M, A[i]) - a0));
    ta.push(a0 + TAU);
    var b0 = a0 + (((ang(M, B[0]) - a0 + Math.PI) % TAU + TAU) % TAU - Math.PI);
    for (j = 0; j < m; j++) tb.push(b0 + wrap(ang(M, B[j]) - ang(M, B[0])));
    tb.push(b0 + TAU);
    i = 0; j = 0;
    while (i < n || j < m) {
      var advA = (i < n) && (j >= m || ta[i + 1] <= tb[j + 1]);
      var Ai = A[i % n], Bj = B[j % m];
      if (advA) {
        var A2 = A[(i + 1) % n];
        if (facing > 0) M.tri(Ai, A2, Bj); else M.tri(Ai, Bj, A2);
        i++;
      } else {
        var B2 = B[(j + 1) % m];
        if (facing > 0) M.tri(Ai, B2, Bj); else M.tri(Ai, Bj, B2);
        j++;
      }
    }
  }

  /* --------------------------------------------------------------- surfaces
     Each has make(M, z0, z1) -> { lo, hi }: the loops of mesh vertices at the two planes, and the side's triangles
     added to M wound OUTWARD (as the boundary of the solid inside it). */

  /* a plain circle: r is the FLAT's distance from the axis (the apothem), so a pin of radius r goes in; slope is dr/dz */
  function circle(r, o) {
    o = o || {};
    return {
      kind: 'circle', r: r,
      make: function (M, z0, z1) {
        var n = Math.max(12, Math.round(o.sides || DEFAULTS.plainSides)), k = 1 / Math.cos(Math.PI / n), s = o.slope || 0;
        var rl = (r) * k, rh = (r + s * (z1 - z0)) * k, lo = [], hi = [], i;
        for (i = 0; i < n; i++) {
          var t = 2 * Math.PI * i / n + (o.rot || 0), c = Math.cos(t), sn = Math.sin(t);
          lo.push(M.v(rl * c, rl * sn, z0)); hi.push(M.v(rh * c, rh * sn, z1));
        }
        for (i = 0; i < n; i++) { var j = (i + 1) % n; M.tri(lo[i], lo[j], hi[j]); M.tri(lo[i], hi[j], hi[i]); }
        return { lo: lo, hi: hi };
      }
    };
  }
  /* a regular polygon of n sides, across flats `af` (a hex nut's size), a corner on +x unless rot. Each side is cut into
     collinear pieces - the same shape - so its outline has about as many points round it as a thread's, and the annulus
     walked between the two stays near-radial (a 60 degree edge walked as one chord crosses a small bore). */
  function polygon(n, af, o) {
    o = o || {};
    return {
      kind: 'polygon', n: n, af: af,
      make: function (M, z0, z1) {
        var Rc = af / 2 / Math.cos(Math.PI / n), lo = [], hi = [], i, q, sub = Math.max(1, Math.ceil((o.points || 120) / n));
        for (i = 0; i < n; i++) {
          var t0 = 2 * Math.PI * i / n + (o.rot || 0), t1 = 2 * Math.PI * (i + 1) / n + (o.rot || 0);
          var x0 = Rc * Math.cos(t0), y0 = Rc * Math.sin(t0), x1 = Rc * Math.cos(t1), y1 = Rc * Math.sin(t1);
          for (q = 0; q < sub; q++) {
            var f = q / sub, x = x0 + (x1 - x0) * f, y = y0 + (y1 - y0) * f;
            lo.push(M.v(x, y, z0)); hi.push(M.v(x, y, z1));
          }
        }
        var m = lo.length;
        for (i = 0; i < m; i++) { var j = (i + 1) % m; M.tri(lo[i], lo[j], hi[j]); M.tri(lo[i], hi[j], hi[i]); }
        return { lo: lo, hi: hi };
      }
    };
  }

  /* A surface given as a radius at every (angle, height): r = fn(theta, z), sampled on `cols` columns round and the heights `rows(z0, z1)`
     gives (bottom to top, z0 and z1 included). A knurled or fluted head is one: its grooves are r(theta), its rounded or chamfered edges
     r(z). Any fn is a single radius per (theta, z), so the surface is closed by its two end rings and cannot fold. */
  function field(fn, o) {
    return {
      kind: 'field',
      make: function (M, z0, z1) {
        var n = Math.max(12, o.cols | 0), zs = o.rows(z0, z1), lo = [], hi = [], rings = [], i, j;
        for (j = 0; j < zs.length; j++) {
          var ring = [];
          for (i = 0; i < n; i++) {
            var t = 2 * Math.PI * i / n, r = fn(t, zs[j]);
            ring.push(M.v(r * Math.cos(t), r * Math.sin(t), zs[j]));
          }
          rings.push(ring);
        }
        for (j = 0; j + 1 < rings.length; j++) {
          var A = rings[j], C = rings[j + 1];
          for (i = 0; i < n; i++) { var k = (i + 1) % n; M.tri(A[i], A[k], C[k]); M.tri(A[i], C[k], C[i]); }
        }
        lo = rings[0]; hi = rings[rings.length - 1];
        return { lo: lo, hi: hi };
      }
    };
  }

  /* The heights a head's rows sit at: fine (`step`) through each edge zone of height `edge`, one row between. */
  function edgeRows(edge, step) {
    return function (z0, z1) {
      var H = z1 - z0, e = Math.min(edge, H / 2), zs = [], q, nE = Math.max(2, Math.ceil(e / step));
      for (q = 0; q <= nE; q++) zs.push(z0 + e * q / nE);
      if (H - 2 * e > 1e-6) for (q = 0; q <= nE; q++) zs.push(z1 - e + e * q / nE);
      else for (q = 1; q <= nE; q++) zs.push(z0 + e + (H - e) * q / nE);
      return zs.filter(function (z, k) { return k === 0 || z - zs[k - 1] > 1e-6; });
    };
  }

  /* THUMB HEADS - the two on the screws they were measured from (docs/THREADS.md, "Thumb heads"):

     KNURLED: a cylinder with `n` round-bottomed grooves (each a circular cutter of sagitta `depth` across `width` of its period), its edges a
     45 degree chamfer `edge` deep at the faces blended into the side by a round of radius 2 x edge. r = min(grooved(theta), edge(z)): the
     grooves fade out into the chamfer. (Measured: Ø32, 25 grooves 1.03 deep, 3 mm chamfer into a 6 mm round.)

     FLUTED: `n` convex lobes (circular arcs) over shallow round valleys `depth` below them, filleted together; its edges a chamfer `edge`
     deep at the faces sloping at 36 degrees off the axis, and the flutes run through it a quarter as deep. (Measured: Ø26.2, 13 lobes 1.25
     deep, a 2.43 mm chamfer at a 0.726 slope.) */
  function knurledFn(R, n, depth, width, edge) {
    var per = 2 * Math.PI / n, phw = Math.max(0.05, Math.min(0.95, width)) * per / 2;
    var a = R * Math.sin(phw), rg = (a * a + depth * depth) / (2 * depth), cx = (R - depth) + rg;
    var rho = 2 * edge, t = rho * Math.tan(Math.PI / 8), zLine = Math.max(0, edge - t / Math.SQRT2), zArc = edge + t;
    function groove(th) {
      var ph = ((th % per) + per) % per; if (ph > per / 2) ph -= per;
      if (Math.abs(ph) >= phw) return R;
      var uc = cx * Math.cos(ph), disc = uc * uc - cx * cx + rg * rg;
      return disc > 0 ? Math.min(R, uc - Math.sqrt(disc)) : R;
    }
    function edgeR(zd) {
      if (zd >= zArc) return R;
      if (zd <= zLine) return R - edge + zd;
      var dz = zd - (edge + t); return (R - rho) + Math.sqrt(Math.max(0, rho * rho - dz * dz));
    }
    return { fn: function (th, z, H) { var zd = Math.min(z, H - z); return Math.min(groove(th), edgeR(zd)); }, edgeZone: zArc, minFace: Math.min(R - depth, R - edge) };
  }
  function flutedFn(R, n, depth, edge) {
    var per = 2 * Math.PI / n, Rv = R - depth, frac = 0.75, phe = frac * per / 2, k = Math.min(0.4, depth * 0.5);
    // a lobe: a circle of radius rho centred D = R - rho out, wide enough to come down to the valley at +-phe
    function lobeAt(ph, rho) { var D = R - rho, s = D * Math.sin(ph), q = rho * rho - s * s; return q > 0 ? D * Math.cos(ph) + Math.sqrt(q) : -Infinity; }
    var lo = 1e-3, hi = R;
    for (var it = 0; it < 60; it++) { var mid = (lo + hi) / 2; if (lobeAt(phe, mid) > Rv) hi = mid; else lo = mid; }
    var rho = (lo + hi) / 2, slopeE = Math.tan(36 * Math.PI / 180), zEdge = edge / slopeE, wave = 0.25;
    var lift = (Math.sqrt(depth * depth + k * k) - depth) / 2;
    function prof(th) {
      var ph = ((th % per) + per) % per; if (ph > per / 2) ph -= per;
      var a = lobeAt(ph, rho), b = Rv;
      if (!isFinite(a)) return b - lift;                                         // past the lobe's reach: the valley
      return (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2 - lift;          // a smooth max, less what it adds at a crest: the crest is R                // the lobe and the valley, filleted together (a smooth max)
    }
    return { fn: function (th, z, H) {
      var zd = Math.min(z, H - z), p = prof(th);
      if (zd >= zEdge) return p;
      var cone = R - edge + zd * slopeE;
      return Math.min(p, cone - wave * (R - p));
    }, edgeZone: zEdge, minFace: R - edge - wave * depth };
  }

  /* the helical thread. o: { offset (radial, mm: an internal thread's fit), slope (dr/dz, a taper), phase (0..1 of a pitch),
     columns, bevelLo / bevelHi { len, angle } }.

     A BEVEL is a cone the thread is held inside at that end: r <= rTip + (distance from the end) * tan(angle), rTip = R - len * tan(angle),
     so the cone meets the crests `len` mm from the end and the end face is a disc of radius rTip. It is applied to every grid vertex's
     radius - the surface stays one function r(theta, z), so it is still closed, still wound outward and cannot fold - and the grid gets
     finer rows (each profile segment cut so no row is more than max(0.15, P / 16) mm from the next) so the cone is drawn smooth. With no
     bevel the rows are the profile's four corners, exactly as before. */
  function thread(sp, o) {
    o = o || {};
    var off = o.offset || 0, slope = o.slope || 0;
    var bLo = o.bevelLo && o.bevelLo.len > 0 ? o.bevelLo : null, bHi = o.bevelHi && o.bevelHi.len > 0 ? o.bevelHi : null;
    return {
      kind: 'thread', spec: sp,
      make: function (M, z0, z1) {
        var P = sp.P, hand = sp.hand, N = o.columns || columnsFor(sp.R + off);
        var corner = [0, sp.fr, sp.fr + sp.w, sp.fr + sp.w + sp.fc, P], cr = [sp.R - sp.h + off, sp.R - sp.h + off, sp.R + off, sp.R + off, sp.R - sp.h + off];
        var ub = [], rb = [], step = (bLo || bHi) ? Math.max(0.15, P / 16) : Infinity;
        for (var g = 0; g < 4; g++) {                        // each profile segment, cut into equal rows when a bevel wants them
          var seg = corner[g + 1] - corner[g], nsub = isFinite(step) ? Math.max(1, Math.ceil(seg / step - 1e-9)) : 1;
          for (var q0 = 0; q0 < nsub; q0++) { var f0 = q0 / nsub; ub.push(corner[g] + seg * f0); rb.push(cr[g] + (cr[g + 1] - cr[g]) * f0); }
        }
        var B = ub.length, shortDiag = !!(bLo || bHi) && hand > 0;          // (left hand: A-C is already the shorter one)
        var tanLo = bLo ? Math.tan(bLo.angle * Math.PI / 180) : 0, tanHi = bHi ? Math.tan(bHi.angle * Math.PI / 180) : 0;
        var tipLo = bLo ? sp.R + off - bLo.len * tanLo : 0, tipHi = bHi ? sp.R + off - bHi.len * tanHi : 0;
        var ph = (o.phase || 0) * P;
        var kmin = Math.floor((z0 - 2 * P) / P) - 1, kmax = Math.ceil((z1 + 2 * P) / P) + 1, rows = (kmax - kmin + 1) * B, TOT = N * rows;
        var X = new Float64Array(TOT), Y = new Float64Array(TOT), Z = new Float64Array(TOT), row, i;
        for (row = 0; row < rows; row++) {
          var b = row % B, k = kmin + Math.floor(row / B);
          for (i = 0; i < N; i++) {
            var th = 2 * Math.PI * i / N, z = ub[b] + k * P + hand * P * i / N + ph, id = row * N + i;
            if (Math.abs(z - z0) < SNAP) z = z0; else if (Math.abs(z - z1) < SNAP) z = z1;      // a vertex a hair off a plane IS on it: crossing points that close would collapse in float32
            var r = rb[b] + slope * (z - z0);
            // the cone runs on past the end (the rows there are clipped away, but the crossing points on the end face are interpolated
            // from them: a cone held flat beyond the end would lift the face's rim off the cone)
            if (bHi) r = Math.min(r, Math.max(0.05, tipHi + (z1 - z) * tanHi));
            if (bLo) r = Math.min(r, Math.max(0.05, tipLo + (z - z0) * tanLo));
            X[id] = r * Math.cos(th); Y[id] = r * Math.sin(th); Z[id] = z;
          }
        }
        function vid(ci, rw) {                              // column N is column 0 one pitch up
          if (ci === N) { ci = 0; rw += hand * B; }
          return (rw < 0 || rw >= rows) ? -1 : rw * N + ci;
        }
        var remap = new Map(), crossed = new Map(), onLo = [], onHi = [];
        function vh(id) {
          var h = remap.get(id);
          if (h === undefined) {
            h = M.v(X[id], Y[id], Z[id]); remap.set(id, h);
            if (Math.abs(Z[id] - z0) < 1e-12) onLo.push(h);
            if (Math.abs(Z[id] - z1) < 1e-12) onHi.push(h);
          }
          return h;
        }
        function cx(ia, ib, plane) {
          var lo = ia < ib ? ia : ib, hi = ia < ib ? ib : ia, key = (lo * TOT + hi) * 2 + plane, h = crossed.get(key);
          if (h !== undefined) return h;
          var c = plane ? z1 : z0, t = (c - Z[lo]) / (Z[hi] - Z[lo]);
          h = M.v(X[lo] + t * (X[hi] - X[lo]), Y[lo] + t * (Y[hi] - Y[lo]), c);
          crossed.set(key, h); (plane ? onHi : onLo).push(h);
          return h;
        }
        function tri(ia, ib, ic) {
          var za = Z[ia], zb = Z[ib], zc = Z[ic], mn = Math.min(za, zb, zc), mx = Math.max(za, zb, zc);
          if (mx <= z0 || mn >= z1) return;
          if (mn >= z0 && mx <= z1) { M.tri(vh(ia), vh(ib), vh(ic)); return; }
          var ids = [ia, ib, ic], poly = [], e;
          for (e = 0; e < 3; e++) {
            var a = ids[e], bb = ids[(e + 1) % 3], pa = Z[a], pb = Z[bb];
            if (pa >= z0 && pa <= z1) poly.push(vh(a));
            var cr = [];
            if ((pa < z0 && pb > z0) || (pa > z0 && pb < z0)) cr.push([(z0 - pa) / (pb - pa), 0]);
            if ((pa < z1 && pb > z1) || (pa > z1 && pb < z1)) cr.push([(z1 - pa) / (pb - pa), 1]);
            if (cr.length === 2 && cr[1][0] < cr[0][0]) cr.reverse();
            for (var q = 0; q < cr.length; q++) poly.push(cx(a, bb, cr[q][1]));
          }
          for (var f = 1; f + 1 < poly.length; f++) M.tri(poly[0], poly[f], poly[f + 1]);
        }
        for (i = 0; i < N; i++) {
          for (row = 0; row + 1 < rows; row++) {
            var A = vid(i, row), Bq = vid(i + 1, row), C = vid(i + 1, row + 1), D = vid(i, row + 1);
            if (A < 0 || Bq < 0 || C < 0 || D < 0) continue;
            // the quad's shorter diagonal: column i+1 is a pitch / N higher (right hand), so B-D is shorter than A-C. A long, thin
            // triangle across a sheared quad sags off a curved surface - on a bevel's cone the next row's triangles came within its sag.
            if (shortDiag) { tri(A, Bq, D); tri(Bq, C, D); } else { tri(A, Bq, C); tri(A, C, D); }
          }
        }
        return { lo: dedupe(onLo), hi: dedupe(onHi) };
      }
    };
  }

  /* ------------------------------------------------------------- assemble */
  /* segs: bottom to top, [{ z0, z1, outer: surface, inner: surface | null }]. Returns { soup, mesh }. */
  function assemble(segs) {
    var M = new Mesh(), built = [], s;
    for (s = 0; s < segs.length; s++) {
      var g = segs[s], o = g.outer.make(M, g.z0, g.z1), inn = null;
      if (g.inner) {
        var start = M.t.length;
        inn = g.inner.make(M, g.z0, g.z1);
        M.flipFrom(start);                                  // a bore's wall faces the axis
      }
      built.push({ outer: o, inner: inn, z0: g.z0, z1: g.z1 });
    }
    function disc(z, loop, facing) { fan(M, M.v(0, 0, z), loop, facing); }
    function ring(outer, inner, facing, z) { if (inner) annulus(M, outer, inner, facing); else disc(z, outer, facing); }
    for (s = 0; s <= segs.length; s++) {
      var Lw = s > 0 ? built[s - 1] : null, Up = s < segs.length ? built[s] : null, z = Lw ? Lw.z1 : Up.z0;
      if (Lw && Up && Math.abs(Lw.z1 - Up.z0) > 1e-9) throw new Error('segments must meet: ' + Lw.z1 + ' against ' + Up.z0);
      if (!Lw) { ring(Up.outer.lo, Up.inner && Up.inner.lo, -1, z); continue; }
      if (!Up) { ring(Lw.outer.hi, Lw.inner && Lw.inner.hi, 1, z); continue; }
      var co = nest(M, Lw.outer.hi, Up.outer.lo);           // the outsides: the wider one's step faces away from the narrower
      if (co > 0) annulus(M, Lw.outer.hi, Up.outer.lo, 1);
      else if (co < 0) annulus(M, Up.outer.lo, Lw.outer.hi, -1);
      var Li = Lw.inner && Lw.inner.hi, Ui = Up.inner && Up.inner.lo;
      var ci = nest(M, Li, Ui);                              // the bores: the wider bore's step faces the narrower one's wall
      if (ci > 0) { ring(Li, Ui, -1, z); }                    // lower bore wider: the upper has more material, its underside shows
      else if (ci < 0) { ring(Ui, Li, 1, z); }                // upper bore wider: the lower's top shows
    }
    return { soup: M.soup(), mesh: M };
  }

  function volumeOf(s) {
    var v = 0;
    for (var o = 0; o < s.length; o += 9) {
      v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
    }
    return v / 6;
  }

  /* =============================================================== PIECES */

  function sizeOf(o, dflt) {
    var id = o.size || dflt;
    return spec(id, { major: o.major, pitch: o.pitch, angle: o.angle, hand: o.hand, nozzle: o.nozzle });
  }
  function fitOf(o) { var f = num(o && o.fit); return f == null ? DEFAULTS.fit : f; }
  function finish(res, soup, info, text) { res.ok = true; res.soup = soup; res.info = info; res.volumeMm3 = volumeOf(soup); res.reason = text; return res; }

  /* A bevel asked for: { len, angle } or null. o.bevel is its length along the axis (mm, 0 or blank: none), o.bevelAngle its angle off the
     axis (degrees, default 45). Refused in words if it would take the end below a third of the thread's radius or is longer than `room`. */
  function bevelOf(o, sp, room, what) {
    var len = num(o.bevel), ang = num(o.bevelAngle);
    if (!(len > 0)) return { ok: true, b: null };
    if (ang == null) ang = 45;
    if (!(ang >= 15 && ang <= 75)) return { ok: false, reason: 'a bevel angle of ' + fmt(ang, 1) + '° is outside 15° to 75° off the axis' };
    var tip = sp.R - len * Math.tan(ang * Math.PI / 180);
    if (tip < sp.R / 3) {
      return { ok: false, reason: 'a ' + fmt(len, 1) + ' mm bevel at ' + fmt(ang, 0) + '° would take the end down to Ø' + fmt(Math.max(0, 2 * tip)) + ' - under a third of the Ø' + fmt(sp.major) + '; make it at most ' +
        fmt(Math.floor((sp.R * 2 / 3) / Math.tan(ang * Math.PI / 180) * 10) / 10, 1) + ' mm' };
    }
    if (len > room + 1e-9) return { ok: false, reason: 'a ' + fmt(len, 1) + ' mm bevel is longer than the ' + what + ' leaves room for (' + fmt(Math.max(0, room), 1) + ' mm)' };
    return { ok: true, b: { len: len, angle: ang, tipDiaMm: 2 * tip } };
  }
  /* The bevel that just clears the roots: the end comes down to a quarter of the thread's depth inside its root, at 45 degrees. */
  function bevelDefault(size, o) { var r = spec(size, o || {}); return r.ok ? Math.round(1.25 * r.spec.h * 10) / 10 : 1; }
  function bevelText(b) { return b ? ', bevelled end (' + fmt(b.len, 1) + ' mm at ' + fmt(b.angle, 0) + '°, end Ø' + fmt(b.tipDiaMm, 1) + ')' : ''; }

  /* A threaded rod. o: { size, length, hand, major/pitch overrides, slope (dr/dz: a pipe thread's taper, e.g. -spec.slope to
     narrow toward the free end at z = length; 0, a straight rod, by default), bevel, bevelAngle (both ends) } */
  function rod(o) {
    o = o || {};
    var res = { ok: false, reason: '' }, r = sizeOf(o, 'M8');
    if (!r.ok) { res.reason = r.reason; return res; }
    var sp = r.spec, L = num(o.length) != null ? num(o.length) : 40;
    if (!(L >= sp.P)) { res.reason = 'a rod shorter than one pitch (' + fmt(sp.P) + ' mm) has no thread - make it at least ' + fmt(Math.ceil(sp.P * 2 * 10) / 10, 1) + ' mm'; return res; }
    var bv = bevelOf(o, sp, (L - sp.P) / 2, 'rod');
    if (!bv.ok) { res.reason = bv.reason; return res; }
    var out = assemble([{ z0: 0, z1: L, outer: thread(sp, { slope: num(o.slope) || 0, bevelLo: bv.b, bevelHi: bv.b }), inner: null }]);
    var info = { kind: 'rod', size: sp.id, spec: sp, lengthMm: L, majorMm: sp.major, minorMm: sp.minor, pitchMm: sp.P, hand: sp.hand > 0 ? 'right' : 'left', note: r.note, bevel: bv.b };
    return finish(res, out.soup, info, 'Threaded rod ' + sp.id + ' (' + sp.familyLabel + '), Ø' + fmt(sp.major) + ' / root Ø' + fmt(sp.minor) + ', pitch ' + fmt(sp.P) + ' mm, ' +
      (sp.hand > 0 ? 'right' : 'left') + '-hand, ' + fmt(L, 1) + ' mm long' + (bv.b ? ', both ends bevelled (' + fmt(bv.b.len, 1) + ' mm at ' + fmt(bv.b.angle, 0) + '°)' : '') + (r.note ? ' - note: ' + r.note : ''));
  }

  /* The thumb heads' own sizes for a thread of major Ø D, from the two screws they were measured on (docs/THREADS.md). */
  function thumbDefaults(style, D) {
    var r1 = function (x) { return Math.round(x * 10) / 10; };
    if (style === 'knurled') { var Dk = r1(2 * D + 2); return { headD: Dk, headK: r1(1.2 * D + 2), count: Math.max(6, Math.round(Math.PI * Dk / 4)), depth: r1(Math.max(0.6, Math.min(2, 0.032 * Dk))), edge: r1(0.094 * Dk) }; }
    var Df = r1(1.3 * D + 1);
    return { headD: Df, headK: r1(D + 1), count: Math.max(5, Math.round(Math.PI * Df / 6.3)), depth: r1(Math.max(0.5, 0.048 * Df)), edge: r1(0.093 * Df) };
  }

  /* A bolt, head down on the bed. o: { size, length (the shank, under the head), head 'hex'|'socket'|'knurled'|'fluted', hand, headAF, headK,
     headD, count, depth, edge (a thumb head's), shank (the plain, unthreaded part of the length, next to the head), bevel, bevelAngle (the
     free end) } */
  function bolt(o) {
    o = o || {};
    var res = { ok: false, reason: '' }, r = sizeOf(o, 'M8');
    if (!r.ok) { res.reason = r.reason; return res; }
    var sp = r.spec, L = num(o.length) != null ? num(o.length) : 25, hw = hardware(sp.major);
    var head = ['socket', 'knurled', 'fluted'].indexOf(o.head) >= 0 ? o.head : 'hex';
    if (!(L >= sp.P)) { res.reason = 'a shank shorter than one pitch (' + fmt(sp.P) + ' mm) has no thread'; return res; }
    var sh = num(o.shank) || 0;
    if (sh < 0) { res.reason = 'a plain shank of ' + fmt(sh, 1) + ' mm is refused - 0 or more'; return res; }
    if (L - sh < 2 * sp.P - 1e-9) { res.reason = 'a ' + fmt(sh, 1) + ' mm plain shank leaves ' + fmt(Math.max(0, L - sh), 1) + ' mm of thread - under two pitches (' + fmt(2 * sp.P, 1) + ' mm); make the shank at most ' + fmt(Math.max(0, L - 2 * sp.P), 1) + ' mm'; return res; }
    var bv = bevelOf(o, sp, L - sh - sp.P, 'thread');
    if (!bv.ok) { res.reason = bv.reason; return res; }
    var threadSeg = function (z) { return { z0: z, z1: k0 + L, outer: thread(sp, { bevelHi: bv.b }), inner: null }; };
    var shankSeg = function (z) { return sh > 0 ? [{ z0: z, z1: z + sh, outer: circle(sp.R + SHANK_STEP), inner: null }] : []; };   // a hair over the crests, so the step to the thread is nested
    var segs, k0, extra = (sh > 0 ? ', ' + fmt(sh, 1) + ' mm plain shank' : '') + bevelText(bv.b);
    var tail = function () { return ', pitch ' + fmt(sp.P) + ' mm, ' + (sp.hand > 0 ? 'right' : 'left') + '-hand' + extra; };
    var infoBase = { kind: 'bolt', size: sp.id, spec: sp, head: head, lengthMm: L, shankMm: sh, bevel: bv.b, majorMm: sp.major, pitchMm: sp.P, note: r.note };
    if (head === 'hex') {
      var af = num(o.headAF) != null ? num(o.headAF) : hw.headAF, k = num(o.headK) != null ? num(o.headK) : hw.headK;
      if (!(af / 2 > sp.R + 0.3)) { res.reason = 'a hex head ' + fmt(af) + ' across flats does not clear a Ø' + fmt(sp.major) + ' shank - make it over ' + fmt(sp.major + 0.6) + ' mm'; return res; }
      if (!(k > 0)) { res.reason = 'the head needs a height, more than 0'; return res; }
      k0 = k;
      segs = [{ z0: 0, z1: k, outer: polygon(6, af), inner: null }].concat(shankSeg(k), [threadSeg(k + sh)]);
      return finish(res, assemble(segs).soup, Object.assign(infoBase, { headAF: af, headK: k }),
        'Hex bolt ' + sp.id + ' × ' + fmt(L, 1) + ' (' + sp.familyLabel + '): ' + fmt(af, 1) + ' across flats, head ' + fmt(k, 1) + ' mm' + tail() + ', head down on the bed' + (r.note ? ' - note: ' + r.note : ''));
    }
    if (head === 'knurled' || head === 'fluted') {
      var dfl = thumbDefaults(head, sp.major);
      var D = num(o.headD) != null ? num(o.headD) : dfl.headD, K = num(o.headK) != null ? num(o.headK) : dfl.headK;
      var n = num(o.count) != null ? Math.round(num(o.count)) : dfl.count, dep = num(o.depth) != null ? num(o.depth) : dfl.depth, ed = num(o.edge) != null ? num(o.edge) : dfl.edge;
      var word = head === 'knurled' ? 'grooves' : 'flutes';
      if (!(n >= 3 && n <= 200)) { res.reason = 'a thumb head has 3 to 200 ' + word + ', not ' + n; return res; }
      if (!(dep > 0) || dep > D / 6) { res.reason = 'a ' + word.slice(0, -1) + ' depth of ' + fmt(dep, 1) + ' mm is outside 0 to a sixth of the head\'s Ø (' + fmt(D / 6, 1) + ' mm)'; return res; }
      if (!(ed >= 0)) { res.reason = 'the head\'s edge must be 0 mm or more'; return res; }
      var hf = head === 'knurled' ? knurledFn(D / 2, n, dep, 0.45, Math.max(ed, 1e-3)) : flutedFn(D / 2, n, dep, Math.max(ed, 1e-3));
      if (hf.minFace < sp.R + 0.3 + (sh > 0 ? SHANK_STEP : 0)) {
        res.reason = 'a Ø' + fmt(D, 1) + ' ' + head + ' head with a ' + fmt(ed, 1) + ' mm edge comes in to Ø' + fmt(2 * hf.minFace, 1) + ' at its face - it does not clear the Ø' + fmt(sp.major) + ' thread; make the head wider or the edge smaller';
        return res;
      }
      if (!(K >= 2 * hf.edgeZone + 0.2)) { res.reason = 'a ' + fmt(K, 1) + ' mm tall head is too short for two ' + fmt(hf.edgeZone, 1) + ' mm edges - make it at least ' + fmt(Math.ceil((2 * hf.edgeZone + 0.2) * 10) / 10, 1) + ' mm, or the edge smaller'; return res; }
      var per = head === 'knurled' ? 16 : 24, cols = Math.min(960, n * per);
      var surf = field(function (th, z) { return hf.fn(th, z, K); }, { cols: cols, rows: edgeRows(hf.edgeZone, 0.25) });
      k0 = K;
      segs = [{ z0: 0, z1: K, outer: surf, inner: null }].concat(shankSeg(K), [threadSeg(K + sh)]);
      var out;
      try { out = assemble(segs); } catch (e) { res.reason = 'internal: ' + e.message; return res; }
      return finish(res, out.soup, Object.assign(infoBase, { headD: D, headK: K, count: n, depth: dep, edge: ed }),
        (head === 'knurled' ? 'Knurled' : 'Fluted') + ' thumb screw ' + sp.id + ' × ' + fmt(L, 1) + ' (' + sp.familyLabel + '): head Ø' + fmt(D, 1) + ' × ' + fmt(K, 1) + ', ' + n + ' ' + word + ' ' + fmt(dep, 1) +
        ' deep, ' + fmt(ed, 1) + ' mm ' + (head === 'knurled' ? 'rounded chamfer' : 'chamfer') + ' at its edges' + tail() + ', head down on the bed' + (r.note ? ' - note: ' + r.note : ''));
    }
    var D2 = num(o.headD) != null ? num(o.headD) : hw.capD, K2 = num(o.headK) != null ? num(o.headK) : hw.capK, sk = num(o.socketAF) != null ? num(o.socketAF) : hw.sock;
    var depth = Math.min(K2 * 0.6, Math.max(sk * 0.8, 1.2)), floor = floorFor(sp.nozzle);
    if (!(D2 / 2 > sp.R + 0.3)) { res.reason = 'a Ø' + fmt(D2) + ' head does not clear a Ø' + fmt(sp.major) + ' shank'; return res; }
    if (K2 - depth < floor) { res.reason = 'the head is ' + fmt(K2) + ' mm tall - too thin for a ' + fmt(depth, 1) + ' mm socket and a ' + fmt(floor) + ' mm floor under it'; return res; }
    var sockCirc = sk / Math.cos(Math.PI / 6) / 2;
    if (D2 / 2 - sockCirc < floor) { res.reason = 'a ' + fmt(sk, 1) + ' hex socket leaves ' + fmt(D2 / 2 - sockCirc) + ' mm of head round it - under the ' + fmt(floor) + ' mm floor'; return res; }
    k0 = K2;
    segs = [
      { z0: 0, z1: depth, outer: circle(D2 / 2), inner: polygon(6, sk) },        // the socket, open on the bed
      { z0: depth, z1: K2, outer: circle(D2 / 2), inner: null }
    ].concat(shankSeg(K2), [threadSeg(K2 + sh)]);
    return finish(res, assemble(segs).soup, Object.assign(infoBase, { headD: D2, headK: K2, socketAF: sk, socketDepth: depth }),
      'Socket-head bolt ' + sp.id + ' × ' + fmt(L, 1) + ' (' + sp.familyLabel + '): head Ø' + fmt(D2, 1) + ' × ' + fmt(K2, 1) + ' with a ' + fmt(sk, 1) + ' hex socket ' + fmt(depth, 1) +
      ' deep (open on the bed)' + tail() + (r.note ? ' - note: ' + r.note : ''));
  }

  /* A nut. o: { size, thickness, shape 'hex'|'round', af (across flats / Ø), fit, hand }. Its bore is the bolt's profile + fit. */
  function nut(o) {
    o = o || {};
    var res = { ok: false, reason: '' }, r = sizeOf(o, 'M8');
    if (!r.ok) { res.reason = r.reason; return res; }
    var sp = r.spec, hw = hardware(sp.major), fit = fitOf(o), shape = o.shape === 'round' ? 'round' : 'hex';
    var af = num(o.af) != null ? num(o.af) : hw.nutAF, m = num(o.thickness) != null ? num(o.thickness) : hw.nutM, floor = floorFor(sp.nozzle);
    if (fit < 0) { res.reason = 'a fit of ' + fmt(fit) + ' mm is refused - it is the clearance added to the thread, 0 or more'; return res; }
    if (!(m >= sp.P)) { res.reason = 'a nut thinner than one pitch (' + fmt(sp.P) + ' mm) does not engage - make it at least ' + fmt(Math.ceil(sp.P * 2 * 10) / 10, 1) + ' mm'; return res; }
    var wallOut = (shape === 'hex' ? af / 2 : af / 2) - (sp.R + fit);
    if (wallOut < floor) {
      res.reason = 'a ' + fmt(af, 1) + ' ' + (shape === 'hex' ? 'across-flats' : 'Ø') + ' nut leaves ' + fmt(Math.max(0, wallOut)) + ' mm of wall round a Ø' + fmt(sp.major + 2 * fit) + ' thread - under the ' + fmt(floor) +
        ' mm floor; make it at least ' + fmt(2 * (sp.R + fit + floor) + 0.05, 1);
      return res;
    }
    var out = assemble([{ z0: 0, z1: m, outer: shape === 'hex' ? polygon(6, af) : circle(af / 2), inner: thread(sp, { offset: fit }) }]);
    return finish(res, out.soup, { kind: 'nut', size: sp.id, spec: sp, shape: shape, af: af, thicknessMm: m, fitMm: fit, boreMajorMm: sp.major + 2 * fit, boreMinorMm: sp.minor + 2 * fit, pitchMm: sp.P, note: r.note },
      (shape === 'hex' ? 'Hex' : 'Round') + ' nut ' + sp.id + ' (' + sp.familyLabel + '): ' + fmt(af, 1) + (shape === 'hex' ? ' across flats' : ' Ø') + ', ' + fmt(m, 1) + ' mm thick, bore Ø' + fmt(sp.major + 2 * fit) +
      ' (the bolt\'s + ' + fmt(fit) + ' mm fit), pitch ' + fmt(sp.P) + ' mm, ' + (sp.hand > 0 ? 'right' : 'left') + '-hand' + (r.note ? ' - note: ' + r.note : ''));
  }

  /* The solid that cuts a threaded hole: a threaded rod with the internal fit added, standing on z = 0 and running to
     `length`. Mapped into the part by the caller (Punch). o: { fit, slope (dr/dz; a tapered hole narrows with depth),
     phase }. Resolves { ok, soup, info } or a refusal. */
  function cutter(size, length, o) {
    o = o || {};
    var res = { ok: false, reason: '' }, r = (size && size.spec && size.ok) ? size : spec(size, o);
    if (!r.ok) { res.reason = r.reason; return res; }
    var sp = r.spec, fit = fitOf(o);
    if (!(length > 0)) { res.reason = 'the thread needs a depth, more than 0'; return res; }
    var slope = o.slope != null ? o.slope : 0;
    var out = assemble([{ z0: 0, z1: length, outer: thread(sp, { offset: fit, slope: slope, phase: o.phase || 0 }), inner: null }]);
    res.ok = true; res.soup = out.soup;
    res.info = { kind: 'cutter', size: sp.id, spec: sp, fitMm: fit, majorMm: sp.major + 2 * fit, minorMm: sp.minor + 2 * fit, lengthMm: length };
    res.note = r.note;
    return res;
  }

  /* The pipe pieces: a hex collar with a thread at either or both ends, a flow bore through.
     kind: nipple (male | male), coupler (female | female), adapter (male below | female above), plug (male, solid, hex head),
           cap (female, closed end).
     o: { kind, size, size2 (the upper end's, for an adapter), thread (length of each thread), collar (the hex's length),
          af, bore (flow Ø), wall, fit, nozzle } */
  function fitting(o) {
    o = o || {};
    var res = { ok: false, reason: '' }, kind = o.kind || 'nipple';
    if (['nipple', 'coupler', 'adapter', 'plug', 'cap'].indexOf(kind) < 0) { res.reason = 'a fitting is a nipple, coupler, adapter, plug or cap'; return res; }
    var r1 = sizeOf(o, 'G1/2');
    if (!r1.ok) { res.reason = r1.reason; return res; }
    var r2 = r1;
    if (kind === 'adapter' && o.size2) {
      r2 = spec(o.size2, { nozzle: o.nozzle, hand: o.hand });
      if (!r2.ok) { res.reason = r2.reason; return res; }
    }
    var sp1 = r1.spec, sp2 = r2.spec, fit = fitOf(o), nozzle = sp1.nozzle, floor = floorFor(nozzle);
    var wall = num(o.wall) != null ? num(o.wall) : Math.max(1.6, floor);
    if (wall < floor - 1e-9) { res.reason = 'a ' + fmt(wall) + ' mm wall is under the nozzle-safety floor of ' + fmt(floor) + ' mm (' + nozzle + ' mm nozzle)'; return res; }
    var Lt = num(o.thread) != null ? num(o.thread) : Math.max(8, Math.min(25, Math.round(6 * Math.max(sp1.P, sp2.P))));
    var Lc = num(o.collar) != null ? num(o.collar) : Math.max(5, Math.round(0.4 * sp1.major));
    if (!(Lt >= sp1.P * 2 && Lt >= sp2.P * 2)) { res.reason = 'a thread length of ' + fmt(Lt, 1) + ' mm is under two pitches - the thread needs at least ' + fmt(Math.ceil(2 * Math.max(sp1.P, sp2.P) * 10) / 10, 1) + ' mm'; return res; }
    if (!(Lc > 0)) { res.reason = 'the collar needs a length, more than 0'; return res; }
    // the ends, lowest first: which kind, and which thread
    var ends = { nipple: [['male', sp1], ['male', sp1]], coupler: [['female', sp1], ['female', sp1]], adapter: [['male', sp1], ['female', sp2]],
                 plug: [['male', sp1]], cap: [['female', sp1]] }[kind];
    var solid = (kind === 'plug' || kind === 'cap');
    // the collar's hex clears every male crest by 0.2 mm and leaves a wall round every female bore
    var afMin = 0;
    ends.forEach(function (e) {
      if (e[0] === 'male') afMin = Math.max(afMin, 2 * (e[1].R + 0.2));
      else afMin = Math.max(afMin, 2 * (e[1].R + fit + wall));
    });
    var af = num(o.af) != null ? num(o.af) : Math.ceil((afMin + 1) * 2) / 2;
    if (af < afMin - 1e-9) { res.reason = 'a ' + fmt(af, 1) + ' across-flats collar leaves under ' + fmt(wall) + ' mm of wall round the thread - make it at least ' + fmt(afMin, 1); return res; }
    // the flow bore: a wall's worth of ledge under every thread - a male's root (its wall), a female's crests (the ledge a thread cannot
    // be cut across: a bore between a thread's crests and roots would cross it)
    var bore = num(o.bore), capR = Infinity, capEnd = null;
    ends.forEach(function (e) {
      var c = e[1].minor / 2 + (e[0] === 'female' ? fit : 0) - wall;
      if (c < capR) { capR = c; capEnd = e; }
    });
    if (!solid) {
      var boreMax = 2 * capR;
      if (bore == null) bore = Math.floor(boreMax * 2) / 2;
      if (bore < 2 * nozzle - 1e-9) { res.reason = 'the flow bore would be Ø' + fmt(Math.max(0, bore)) + ' - under 2 nozzle widths (' + fmt(2 * nozzle) + ' mm); this thread is too small for a pipe fitting with a ' + fmt(wall) + ' mm wall'; return res; }
      if (bore / 2 > capR + 1e-9) {
        var left = capR + wall - bore / 2;
        res.reason = 'a Ø' + fmt(bore) + ' bore ' + (left > 0 ? 'leaves ' + fmt(left) + ' mm under' : 'cuts into') + ' the thread\'s ' + (capEnd[0] === 'male' ? 'root' : 'crests') + ' - ' + (left > 0 ? 'under the ' + fmt(wall) + ' mm wall' : 'there is no wall left') + '; make the bore at most ' + fmt(boreMax) + ' mm';
        return res;
      }
    }
    var rf = solid ? 0 : bore / 2;
    // taper: a tapered male narrows toward its free end, a tapered female opens toward its mouth
    var taper = function (sp, end, sideLow) { return sp.slope ? (end === 'male' ? (sideLow ? 1 : -1) : (sideLow ? -1 : 1)) * sp.slope : 0; };
    var segs = [], z = 0;
    function addThreadMale(sp, sideLow) {
      segs.push({ z0: z, z1: z + Lt, outer: thread(sp, { slope: taper(sp, 'male', sideLow) }), inner: solid ? null : circle(rf) });
      z += Lt;
    }
    function addCollar(inner) { segs.push({ z0: z, z1: z + Lc, outer: polygon(6, af), inner: inner }); z += Lc; }
    function addFemale(sp, sideLow) {
      segs.push({ z0: z, z1: z + Lt, outer: polygon(6, af), inner: thread(sp, { offset: fit, slope: taper(sp, 'female', sideLow) }) });
      z += Lt;
    }
    if (kind === 'nipple') { addThreadMale(sp1, true); addCollar(circle(rf)); addThreadMale(sp1, false); }
    else if (kind === 'coupler') { addFemale(sp1, true); addCollar(circle(rf)); addFemale(sp1, false); }
    else if (kind === 'adapter') { addThreadMale(sp1, true); addCollar(circle(rf)); addFemale(sp2, false); }
    else if (kind === 'plug') { addThreadMale(sp1, true); addCollar(null); }
    else if (kind === 'cap') { addCollar(null); addFemale(sp1, false); }
    var out;
    try { out = assemble(segs); } catch (e) { res.reason = 'internal: ' + e.message; return res; }
    var info = { kind: kind, size: sp1.id, size2: kind === 'adapter' ? sp2.id : null, spec: sp1, spec2: kind === 'adapter' ? sp2 : null, af: af, boreMm: solid ? 0 : bore, wallMm: wall, threadMm: Lt, collarMm: Lc,
                 fitMm: fit, heightMm: z, notes: [r1.note, r2 !== r1 ? r2.note : ''].filter(Boolean) };
    var what = { nipple: 'Nipple', coupler: 'Coupler', adapter: 'Adapter', plug: 'Plug', cap: 'Cap' }[kind];
    var ends = kind === 'nipple' ? 'male ' + sp1.id + ' at both ends' : kind === 'coupler' ? 'female ' + sp1.id + ' at both ends' : kind === 'adapter' ? 'male ' + sp1.id + ' below, female ' + sp2.id + ' above' :
               kind === 'plug' ? 'male ' + sp1.id + ', solid' : 'female ' + sp1.id + ', closed end down';
    return finish(res, out.soup, info, what + ': ' + ends + ' (' + sp1.familyLabel + '), ' + fmt(af, 1) + ' hex collar' + (solid ? '' : ', Ø' + fmt(bore) + ' bore') + ', ' + fmt(z, 1) + ' mm tall' +
      (info.notes.length ? ' - note: ' + info.notes.join('; ') : ''));
  }

  /* A slip-on sleeve that takes a tube at one end and carries a thread at the other: the tube goes in (bore = its Ø + 2 gap,
     a ledge stops it), the far end is a male spigot or a female socket, a hex collar between. o: { tubeOd, tubeWall, gap,
     depth, end 'male'|'female', size, thread, collar, bore } */
  function sleeve(o) {
    o = o || {};
    var res = { ok: false, reason: '' };
    var r = sizeOf(o, 'G1/2');
    if (!r.ok) { res.reason = r.reason; return res; }
    var sp = r.spec, nozzle = sp.nozzle, floor = floorFor(nozzle), fit = fitOf(o), end = o.end === 'female' ? 'female' : 'male';
    var od = num(o.tubeOd), tw = num(o.tubeWall), gap = num(o.gap);
    if (!(od > 0)) { res.reason = 'enter the tube\'s outside Ø in mm, more than 0'; return res; }
    if (!(tw > 0)) { res.reason = 'enter the tube\'s wall in mm, more than 0'; return res; }
    if (gap == null) gap = 0.25;
    if (gap < 0) { res.reason = 'a fit gap of ' + fmt(gap) + ' mm is refused - it is the clearance round the tube, 0 or more'; return res; }
    var depth = num(o.depth) != null ? num(o.depth) : Math.max(8, Math.min(30, Math.round(0.75 * od * 2) / 2));
    if (!(depth > 0)) { res.reason = 'the depth the tube goes in must be more than 0'; return res; }
    var wall = Math.max(tw, floor);
    var Lt = num(o.thread) != null ? num(o.thread) : Math.max(8, Math.min(25, Math.round(6 * sp.P)));
    var Lc = num(o.collar) != null ? num(o.collar) : Math.max(4, Math.round(0.3 * sp.major));
    if (!(Lt >= 2 * sp.P)) { res.reason = 'a thread length of ' + fmt(Lt, 1) + ' mm is under two pitches - at least ' + fmt(Math.ceil(2 * sp.P * 10) / 10, 1) + ' mm'; return res; }
    var tubeBoreR = od / 2 - tw, sleeveIn = od / 2 + gap, sleeveOut = sleeveIn + wall;
    // the flow bore: the tube's own; a male spigot holds it inside the thread's root less a wall
    var rootR = sp.minor / 2, boreMax = end === 'male' ? 2 * (rootR - wall) : 2 * (rootR + fit - wall);   // a ledge's wall under the thread's root (male) or crests (female)
    var bore = num(o.bore) != null ? num(o.bore) : Math.min(2 * tubeBoreR, Math.floor(boreMax * 2) / 2);
    if (bore < 2 * nozzle - 1e-9) { res.reason = 'the flow bore would be Ø' + fmt(Math.max(0, bore)) + ' - under 2 nozzle widths (' + fmt(2 * nozzle) + ' mm); the ' + sp.id + ' thread is too small to carry a tube this size'; return res; }
    if (bore / 2 > boreMax / 2 + 1e-9) { var left2 = boreMax / 2 + wall - bore / 2; res.reason = 'a Ø' + fmt(bore) + ' bore ' + (left2 > 0 ? 'leaves ' + fmt(left2) + ' mm under' : 'cuts into') + ' the ' + sp.id + ' thread\'s ' + (end === 'male' ? 'root' : 'crests') + ' - ' + (left2 > 0 ? 'under the ' + fmt(wall) + ' mm wall' : 'there is no wall left') + '; at most Ø' + fmt(boreMax); return res; }
    if (bore / 2 >= sleeveIn) { res.reason = 'the flow bore Ø' + fmt(bore) + ' is as wide as the tube\'s socket - there would be no ledge for the tube to stop on'; return res; }
    var afMin = 2 * Math.max(sleeveOut, end === 'male' ? sp.R + 0.2 : sp.R + fit + wall) + 0.001;
    var af = num(o.af) != null ? num(o.af) : Math.ceil((afMin + 1) * 2) / 2;
    if (af < afMin - 1e-9) { res.reason = 'a ' + fmt(af, 1) + ' across-flats collar is too small - at least ' + fmt(afMin, 1); return res; }
    var segs = [], z = 0;
    segs.push({ z0: 0, z1: depth, outer: circle(sleeveOut), inner: circle(sleeveIn) }); z = depth;       // the tube's socket, open end down
    var slopeM = sp.slope ? -sp.slope : 0, slopeF = sp.slope ? sp.slope : 0;
    if (end === 'male') {
      segs.push({ z0: z, z1: z + Lc, outer: polygon(6, af), inner: circle(bore / 2) }); z += Lc;
      segs.push({ z0: z, z1: z + Lt, outer: thread(sp, { slope: slopeM }), inner: circle(bore / 2) }); z += Lt;
    } else {
      segs.push({ z0: z, z1: z + Lc, outer: polygon(6, af), inner: circle(bore / 2) }); z += Lc;
      segs.push({ z0: z, z1: z + Lt, outer: polygon(6, af), inner: thread(sp, { offset: fit, slope: slopeF }) }); z += Lt;
    }
    var out;
    try { out = assemble(segs); } catch (e) { res.reason = 'internal: ' + e.message; return res; }
    var info = { kind: 'sleeve', end: end, size: sp.id, spec: sp, tubeOdMm: od, tubeWallMm: tw, gapMm: gap, depthMm: depth, sleeveInMm: sleeveIn, sleeveOutMm: sleeveOut, boreMm: bore, af: af, threadMm: Lt, collarMm: Lc,
                 fitMm: fit, heightMm: z, note: r.note };
    return finish(res, out.soup, info, 'Threaded end for a Ø' + fmt(od) + ' tube: a ' + fmt(depth, 1) + ' mm sleeve (bore Ø' + fmt(2 * sleeveIn) + ', ' + fmt(gap) + ' mm clear all round, a ledge for the tube to stop on), then a hex collar, then a ' +
      end + ' ' + sp.id + ' thread (' + sp.familyLabel + ') with a Ø' + fmt(bore) + ' bore through - ' + fmt(z, 1) + ' mm tall, the tube end down' + (r.note ? ' - note: ' + r.note : ''));
  }

  var API = {
    DEFAULTS: DEFAULTS, FAMILY: FAMILY, SIZES: SIZES, sizeIds: function () { return Object.keys(SIZES); }, hardware: hardware,
    spec: spec, rod: rod, bolt: bolt, nut: nut, thumbDefaults: thumbDefaults, bevelDefault: bevelDefault, fitting: fitting, sleeve: sleeve, cutter: cutter, columnsFor: columnsFor,
    // building blocks, for the callers that stack their own
    surfaces: { thread: thread, circle: circle, polygon: polygon }, assemble: assemble, volume: volumeOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Thread = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
