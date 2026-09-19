/* nso_hollow.js - Hollow and Fill/Densify for ARBITRARY mesh geometry.

   Loads as a classic script (window.NSO_Hollow) and as a Node module
   (require('../nso_hollow.js')). Speaks the app's raw soup: a
   Float32Array/Array of 9 numbers per triangle, Z up, millimetres. No DOM, no
   Three.js, no CSG kernel.

   ---------------------------------------------------------------------------
   WHAT THESE TWO ARE, AND WHY NEITHER IS THE POTTERY WHEEL'S "OPEN"
   ---------------------------------------------------------------------------
   app-wheel.js already carves a cavity, and the AUDIT that preceded this file
   went looking for whether that mechanism generalises. The answer is: its
   DEFINITION does, completely, and its MECHANISM does not, at all. Both halves
   of that matter, so both are written down.

   THE DEFINITION, which is taken verbatim and is the whole of this file's
   correctness argument. NSO_wheelInnerAt's comment is explicit that the
   obvious implementation - inner = outer - wall, a radial subtraction - is
   wrong, and wrong by a lot: it leaves a PERPENDICULAR wall of wall*cos(slope),
   so on a sloped surface the wall thins exactly where the piece is weakest. It
   measured 1.31 mm of real wall where 3.00 was asked for on the default open of
   a 30 mm ball, a 56% shortfall going to zero at the base. The definition that
   is right is:

       the cavity is the set of points at perpendicular distance > wall
       from the OUTER SURFACE

   which is an EROSION of the solid by a ball of radius `wall`, and that phrase
   is dimension-free. The Wheel finds that locus by bisecting along a radial
   line in the meridian half-plane; this file finds the same locus as the
   `distance == wall` level set of the solid's distance field. Same definition,
   same guarantee, no cos(slope) anywhere.

   THE MECHANISM, which does not generalise and is not borrowed. A thrown piece
   is not a mesh at all: app-wheel.js says so in its own header - it "does NOT
   speak rawTris on the way in", it is held as a MERIDIAN PROFILE, r as a
   function of z, revolved fresh on every update, precisely because that is
   what makes the constraints cheap enough to run live. NSO_wheelInnerAt's
   bisection needs a single-valued r(z) and a known axis. Its own header lists
   what that representation cannot express: re-entrant forms, asymmetric
   appendages, and any imported mesh at all, because finding the axis an
   arbitrary piece wants to spin about is an unsolved problem there. A box, a
   bracket, a scanned blob: the Wheel's Open cannot be pointed at any of them.
   So the level set is computed on a field here, not by bisection, and the
   handful of lines that ARE shared - the floor, the weld tolerance, the ray
   code - are shared by calling nso_thickness.js rather than by copying.

   ---------------------------------------------------------------------------
   THE FLOOR COMES FROM ONE PLACE
   ---------------------------------------------------------------------------
   NSO_Thickness.floorFor(nozzle) - nozzle x 1.05, 0.42 mm at a 0.4 nozzle - is
   the only source of the safe-wall number, exactly as app-wheel.js insists.
   This file carries no literal for it and refuses to load without the module,
   because a local default is how the repo ended up with seven copies of this
   question the first time.

   Every piece of geometry this file touches also goes through that module: the
   weld, the triangle hash, the ray code and the closest-point search are all
   NSO_Thickness.prepare()'s, built once per call and walked many times. There
   is no second spatial index and no second ray-triangle test in this file.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   safeMinWall(requested, opts)  -> { mm, floor_mm, floored, reason }
   hollow(rawTris, opts)         -> { ok, soup, reason, ... }
   fill(rawTris, opts)           -> { ok, soup, reason, ... }

   Refusals follow the house contract the sculpt tier set and the Wheel kept:
   `ok` is false, `reason` is set, and `soup` is the ORIGINAL soup, so a caller
   can swap unconditionally without checking.

   ---------------------------------------------------------------------------
   LIMITS, stated rather than implied
   ---------------------------------------------------------------------------
   1. hollow() SAMPLES A FIELD. The cavity surface is a level set extracted on
      a grid whose pitch is wall/`stepsPerWall` (3 by default), so it is an
      approximation of the exact offset locus, not a proof of it. The error is
      bounded by the pitch and it is biased SAFE - see "the band" below, where
      the sampled distance is replaced by the true point-to-mesh distance
      everywhere the level set can actually fall. Validate with
      NSO_Thickness.measureMesh() on the result; tools/nso_hollow_test.js does.
   2. hollow() needs a CLOSED solid. Parity is the inside test, and parity of a
      sheet is meaningless. An open piece is refused by name, not misread.
   3. fill() is TOPOLOGICAL, not a remesh, and that is on purpose: it drops the
      shells that bound enclosed cavities and touches nothing else, so the
      outer surface comes back bit for bit and fill(hollow(X)) is X's own
      triangles rather than a resampled lookalike.
   4. fill() reads WINDING. A cavity wall is a shell wound inward - negative
      signed volume - that sits inside material. A captive separate solid is
      wound outward and survives, which is the right answer and is tested.
*/
(function (root) {
  'use strict';

  var NODE = (typeof module !== 'undefined' && module.exports);
  var T = NODE ? require('./nso_thickness.js') : null;

  /* The Wheel's rule, for the same reason: no local literal for the floor.

     Resolved on USE rather than at load, so a script tag that lands before
     nso_thickness.js is a slower first call and not a module that is
     permanently broken. index.html loads them in the right order today; the
     next person to reorder those tags should not have to know that. */
  function needThickness() {
    if (!T && root) T = root.NSO_Thickness;
    if (!T || typeof T.floorFor !== 'function' || typeof T.prepare !== 'function') {
      throw new Error('nso_hollow.js needs nso_thickness.js (floorFor + prepare) - ' +
                      'the floor and the probe come from there, never from a literal here');
    }
    return T;
  }

  var STEPS_PER_WALL = 3;    // grid pitches across the target wall
  var MAX_DIM = 160;         // nodes on the longest axis
  var MAX_NODES = 6e6;       // total field samples

  function round3(x) { return (x === null || x === undefined) ? '?' : Math.round(x * 1000) / 1000; }

  /* ===================================================================
     The floor, and the one rule that is not just "clamp to it"
     =================================================================== */

  /* What wall thickness may this piece actually be hollowed to?

     Two callers, two different questions, one answer:

       hollow(wall) asks "is this printable?" and is REFUSED under the floor.
       A user who types 0.2 mm has made a mistake and wants to hear so.

       hollow-out-to-safe-minimum asks "how thin may I go back to?" and is
       CLAMPED to the floor instead. That is the thicken -> edit -> hollow back
       out workflow: Thicken In made the wall thicker so a cut had something to
       bite into, the edit is done, and the wall should come back down. Back
       down TO WHAT is the whole question, and "whatever it was before" is the
       wrong answer whenever the piece was not printable before - which is
       exactly why somebody reached for Thicken. Restoring 0.3 mm because 0.3 mm
       is what it used to be hands back a piece the slicer will drop. So the
       restore target is a FLOOR-ed request: max(what it was, what is safe).

     `requested` is the wall asked for; `restore` is the pre-Thicken wall when
     there is one. Both are honoured upward, never downward. */
  function safeMinWall(requested, opts) {
    var TH = needThickness();
    opts = opts || {};
    var nozzle = (typeof opts.nozzle === 'number' && opts.nozzle > 0) ? opts.nozzle : TH.NOZZLE_DEFAULT;
    var floor = (typeof opts.minWall === 'number' && opts.minWall > 0) ? opts.minWall : TH.floorFor(nozzle);
    var want = 0;
    if (typeof requested === 'number' && requested > 0) want = requested;
    if (typeof opts.restore === 'number' && opts.restore > want) want = opts.restore;
    var out = {
      mm: Math.max(want, floor),
      requested: want || null,
      floor_mm: floor,
      nozzle_mm: nozzle,
      floored: false,
      reason: ''
    };
    out.floored = out.mm > want + TH.WELD_TOL;
    if (out.floored) {
      out.reason = 'stopped at the ' + round3(floor) + ' mm floor for a ' + round3(nozzle) +
        ' mm nozzle' + (want > 0 ? ', not the ' + round3(want) + ' mm asked for - ' +
        'that wall was never printable' : '');
    } else {
      out.reason = round3(out.mm) + ' mm, clear of the ' + round3(floor) + ' mm floor';
    }
    return out;
  }

  /* ===================================================================
     Geometry helpers on a raw soup
     =================================================================== */

  function boundsOf(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        var v = soup[i + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
    return { lo: lo, hi: hi };
  }

  /* Signed volume of a triangle list, the divergence-theorem sum. Positive
     when the shell is wound outward, negative when it is wound inward - which
     is the ONLY definition of "this is a cavity wall" that does not depend on
     getting a hand-written traversal order right. */
  function signedVolume(soup, faces) {
    var v = 0, n = (faces ? faces.length : soup.length / 9);
    for (var q = 0; q < n; q++) {
      var o = (faces ? faces[q] : q) * 9;
      var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
      var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
      var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
      v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx));
    }
    return v / 6;
  }

  /* Open-edge count off the probe's welded index. Parity is the inside test
     below, and parity of a sheet means nothing, so this is a precondition and
     not a nicety. */
  function openEdgeCount(vids) {
    var m = new Map();
    for (var f = 0; f < vids.length; f++) {
      var t = vids[f];
      for (var e = 0; e < 3; e++) {
        var u = t[e], w = t[(e + 1) % 3];
        var k = (u < w ? u : w) + ',' + (u < w ? w : u);
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    var open = 0;
    m.forEach(function (c) { if (c === 1) open++; });
    return open;
  }

  /* ===================================================================
     HOLLOW

     Five steps, and only the middle two are interesting:

       1. pick a grid,
       2. mark which nodes are INSIDE the solid (parity, one ray per column),
       3. give every inside node its distance to the surface,
       4. pull out the `distance == wall` level set as triangles,
       5. staple that surface, wound inward, onto the original outer triangles.

     Step 5 is why this leaves the outer surface untouched: the result is the
     input's own triangles plus a new inner shell, not a remesh of both.
     =================================================================== */

  /* Pitch: fine enough that the wall spans several samples, coarse enough that
     the grid fits. Both caps are real and both are reported, because a piece
     that hit MAX_DIM got a coarser answer than it asked for and the caller
     should be able to say so. */
  function choosePitch(span, wall, opts) {
    var steps = (opts && opts.stepsPerWall > 0) ? opts.stepsPerWall : STEPS_PER_WALL;
    var maxDim = (opts && opts.maxDim > 0) ? (opts.maxDim | 0) : MAX_DIM;
    var maxNodes = (opts && opts.maxNodes > 0) ? opts.maxNodes : MAX_NODES;
    var pitch = wall / steps;
    if (opts && opts.pitch > 0) pitch = opts.pitch;
    var capped = false, guard = 0;
    while (guard++ < 200) {
      var n = [0, 0, 0], total = 1, worst = 0;
      for (var a = 0; a < 3; a++) {
        n[a] = Math.ceil(span[a] / pitch) + 5;
        total *= n[a];
        if (n[a] > worst) worst = n[a];
      }
      if (worst <= maxDim && total <= maxNodes) break;
      pitch *= 1.25;
      capped = true;
    }
    return { pitch: pitch, capped: capped };
  }

  /* Felzenszwalb-Huttenlocher exact squared EDT, one axis at a time.
     Separable and O(n), and EXACT for the node metric - a chamfer mask is not,
     and its error is anisotropic, which on a box would put a different wall on
     the diagonal than on the face. */
  function edt1d(f, n, d, v, z) {
    var k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (var q2 = 0; q2 < n; q2++) {
      while (z[k + 1] < q2) k++;
      d[q2] = (q2 - v[k]) * (q2 - v[k]) + f[v[k]];
    }
  }

  function edt3d(seed, nx, ny, nz) {
    var N = nx * ny * nz;
    var d = new Float64Array(N);
    var maxN = Math.max(nx, ny, nz);
    var f = new Float64Array(maxN), out = new Float64Array(maxN);
    var v = new Int32Array(maxN), z = new Float64Array(maxN + 1);
    var i, j, k, idx;
    for (i = 0; i < N; i++) d[i] = seed[i];
    // x
    for (k = 0; k < nz; k++) for (j = 0; j < ny; j++) {
      var base = (k * ny + j) * nx;
      for (i = 0; i < nx; i++) f[i] = d[base + i];
      edt1d(f, nx, out, v, z);
      for (i = 0; i < nx; i++) d[base + i] = out[i];
    }
    // y
    for (k = 0; k < nz; k++) for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) f[j] = d[(k * ny + j) * nx + i];
      edt1d(f, ny, out, v, z);
      for (j = 0; j < ny; j++) d[(k * ny + j) * nx + i] = out[j];
    }
    // z
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
      for (k = 0; k < nz; k++) f[k] = d[(k * ny + j) * nx + i];
      edt1d(f, nz, out, v, z);
      for (k = 0; k < nz; k++) d[(k * ny + j) * nx + i] = out[k];
    }
    return d;
  }

  /* Surface nets: ONE vertex per sign-changing cell, placed at the average of
     that cell's edge crossings, and one quad per sign-changing node edge.

     Chosen over marching cubes deliberately. It is watertight and manifold by
     construction, it needs no 256-entry case table (which is a table nobody in
     this repo can review), and its vertices sit at the crossings rather than
     on them, which gives a smoother cavity at this pitch. The price is quads
     split into two triangles and a slightly blunter corner; neither matters on
     a surface whose whole job is to be `wall` away from another one. */
  function surfaceNets(F, nx, ny, nz, org, pitch) {
    var cx = nx - 1, cy = ny - 1, cz = nz - 1;
    var cellVert = new Int32Array(cx * cy * cz).fill(-1);
    var verts = [];
    var CO = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
    var EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    var i, j, k, e, c;
    var val = new Float64Array(8);
    for (k = 0; k < cz; k++) for (j = 0; j < cy; j++) for (i = 0; i < cx; i++) {
      var neg = 0, pos = 0;
      for (c = 0; c < 8; c++) {
        var o = CO[c];
        val[c] = F[((k + o[2]) * ny + (j + o[1])) * nx + (i + o[0])];
        if (val[c] > 0) pos++; else neg++;
      }
      if (!pos || !neg) continue;
      var sx = 0, sy = 0, sz = 0, cnt = 0;
      for (e = 0; e < 12; e++) {
        var a = EDGES[e][0], b = EDGES[e][1];
        var fa = val[a], fb = val[b];
        if ((fa > 0) === (fb > 0)) continue;
        var t = fa / (fa - fb);
        var oa = CO[a], ob = CO[b];
        sx += (oa[0] + (ob[0] - oa[0]) * t);
        sy += (oa[1] + (ob[1] - oa[1]) * t);
        sz += (oa[2] + (ob[2] - oa[2]) * t);
        cnt++;
      }
      if (!cnt) continue;
      cellVert[(k * cy + j) * cx + i] = verts.length / 3;
      verts.push(org[0] + (i + sx / cnt) * pitch,
                 org[1] + (j + sy / cnt) * pitch,
                 org[2] + (k + sz / cnt) * pitch);
    }

    var tri = [];
    function quad(a, b, c2, d2, flip) {
      if (a < 0 || b < 0 || c2 < 0 || d2 < 0) return;
      if (flip) { tri.push(a, c2, b, a, d2, c2); }
      else { tri.push(a, b, c2, a, c2, d2); }
    }
    /* An edge along +x is shared by the four cells around it; likewise y and z.
       Each loop walks its four cells anticlockwise in the plane the edge is
       normal to - (y,z) for an x edge, (z,x) for a y edge, (x,y) for a z edge -
       so the quad's normal runs along the edge, toward the positive node. The
       z loop's order is NOT the same index pattern as the other two and must
       not be copied from them: getting it wrong leaves a third of the cavity
       inside out, which the signed-volume check cannot see (the two errors
       cancel in the sum) and which measureMesh() reads as a third of the
       cavity having no wall behind it at all. Measured, on a 20 mm box: 2304
       of 6912 cavity faces unmeasured, and a cavity volume of 1355 mm3 where
       the exact answer is 4096. The caller's signed-volume check below is the
       handedness backstop, not this. */
    for (k = 1; k < cz; k++) for (j = 1; j < cy; j++) for (i = 0; i < cx; i++) {
      var i0 = (k * ny + j) * nx + i, i1 = i0 + 1;
      if ((F[i0] > 0) === (F[i1] > 0)) continue;
      quad(cellVert[((k - 1) * cy + (j - 1)) * cx + i],
           cellVert[((k - 1) * cy + j) * cx + i],
           cellVert[(k * cy + j) * cx + i],
           cellVert[(k * cy + (j - 1)) * cx + i], F[i0] > 0);
    }
    for (k = 1; k < cz; k++) for (j = 0; j < cy; j++) for (i = 1; i < cx; i++) {
      var j0 = (k * ny + j) * nx + i, j1 = j0 + nx;
      if ((F[j0] > 0) === (F[j1] > 0)) continue;
      quad(cellVert[((k - 1) * cy + j) * cx + (i - 1)],
           cellVert[(k * cy + j) * cx + (i - 1)],
           cellVert[(k * cy + j) * cx + i],
           cellVert[((k - 1) * cy + j) * cx + i], F[j0] > 0);
    }
    for (k = 0; k < cz; k++) for (j = 1; j < cy; j++) for (i = 1; i < cx; i++) {
      var k0 = (k * ny + j) * nx + i, k1 = k0 + nx * ny;
      if ((F[k0] > 0) === (F[k1] > 0)) continue;
      quad(cellVert[(k * cy + (j - 1)) * cx + (i - 1)],
           cellVert[(k * cy + (j - 1)) * cx + i],
           cellVert[(k * cy + j) * cx + i],
           cellVert[(k * cy + j) * cx + (i - 1)], F[k0] > 0);
    }

    var soup = new Float32Array(tri.length * 3);
    for (var t = 0; t < tri.length; t++) {
      soup[t * 3] = verts[tri[t] * 3];
      soup[t * 3 + 1] = verts[tri[t] * 3 + 1];
      soup[t * 3 + 2] = verts[tri[t] * 3 + 2];
    }
    return soup;
  }

  /* Carve the interior out of a solid, following the outer surface inward.

     opts: wall          the target wall thickness, mm
           mode          'exact' (default) refuses a wall under the floor;
                         'safe-min' clamps up to it instead - see safeMinWall
           restore       safe-min only: the pre-Thicken wall to aim for
           nozzle/minWall  the floor, resolved by nso_thickness.js
           stepsPerWall / pitch / maxDim   field resolution
  */
  function hollow(rawTris, opts) {
    var TH = needThickness();
    opts = opts || {};
    var mode = opts.mode === 'safe-min' ? 'safe-min' : 'exact';
    var nozzle = (typeof opts.nozzle === 'number' && opts.nozzle > 0) ? opts.nozzle : TH.NOZZLE_DEFAULT;
    var floor = (typeof opts.minWall === 'number' && opts.minWall > 0) ? opts.minWall : TH.floorFor(nozzle);

    var out = {
      ok: false, soup: rawTris, reason: '',
      mode: mode, wall_mm: null, floor_mm: floor, nozzle_mm: nozzle,
      floored: false, pitch_mm: null, pitch_capped: false,
      cavity_tris: 0, tris_before: rawTris ? (rawTris.length / 9) | 0 : 0, tris_after: 0,
      volume_before: null, volume_after: null
    };

    if (!rawTris || rawTris.length < 9) { out.reason = 'nothing to hollow - empty piece'; return out; }

    /* The target wall. This is the ONLY place the two modes differ, and the
       difference is a refusal versus a clamp, never a different number. */
    var want = (typeof opts.wall === 'number' && opts.wall > 0) ? opts.wall : null;
    if (mode === 'safe-min') {
      var s = safeMinWall(want, { nozzle: nozzle, minWall: floor, restore: opts.restore });
      out.wall_mm = s.mm;
      out.floored = s.floored;
      out.floor_note = s.reason;
    } else {
      if (want === null) { out.reason = 'Hollow needs a wall thickness in mm'; return out; }
      if (want < floor - TH.WELD_TOL) {
        out.reason = 'a ' + round3(want) + ' mm wall is under the ' + round3(floor) +
          ' mm nozzle floor for a ' + round3(nozzle) + ' mm nozzle - nothing hollowed that thin ' +
          'could be printed. Ask for ' + round3(floor) + ' mm or more, or hollow to the safe minimum.';
        return out;
      }
      out.wall_mm = want;
    }
    var wall = out.wall_mm;

    var P;
    try { P = TH.prepare(rawTris, { nozzle: nozzle, minWall: floor }); }
    catch (e) { out.reason = 'could not index the piece - ' + ((e && e.message) || e); return out; }
    if (!P) { out.reason = 'nothing to hollow - empty piece'; return out; }

    var open = openEdgeCount(P.vids);
    if (open > 0) {
      out.reason = 'Hollow needs a closed solid - this piece has ' + open + ' open edge(s). ' +
        'Seal it first; a cavity is defined by what is inside, and an open sheet has no inside.';
      return out;
    }

    var b = boundsOf(rawTris);
    var span = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];
    if (Math.min(span[0], span[1], span[2]) <= 2 * wall) {
      out.reason = 'a ' + round3(wall) + ' mm wall is thicker than half this piece (' +
        round3(Math.min(span[0], span[1], span[2])) + ' mm across its narrowest axis) - there is no ' +
        'interior left to carve. Hollow thinner, or leave it solid.';
      return out;
    }

    var cp = choosePitch(span, wall, opts);
    out.pitch_capped = cp.capped;

    /* ONE PASS AT A GIVEN PITCH. The gate below re-runs it finer, which is why
       it is a function rather than straight-line code. */
    function pass(pitch) {
    var nx = Math.ceil(span[0] / pitch) + 5;
    var ny = Math.ceil(span[1] / pitch) + 5;
    var nz = Math.ceil(span[2] / pitch) + 5;
    /* The grid origin is nudged off any round fraction of the pitch on purpose.
       Parity is decided by ray casts, and a ray that runs exactly along a face
       or exactly through a vertex is the one case parity gets wrong; every
       fixture in this repo is axis-aligned, so an un-nudged grid would line up
       with the faces of a box on every column. The offset is irrational-ish and
       far smaller than the pitch, so it moves nothing else. */
    var jitter = pitch * 0.01374;
    var org = [b.lo[0] - 2 * pitch + jitter, b.lo[1] - 2 * pitch + jitter, b.lo[2] - 2 * pitch + jitter];

    /* --- step 2: inside/outside, one ray per (i,j) column --- */
    var N = nx * ny * nz;
    var inside = new Uint8Array(N);
    var zTop = org[2] + (nz - 1) * pitch;
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var ox = org[0] + i * pitch, oy = org[1] + j * pitch;
        var hits = P.hitsAlong([ox, oy, org[2]], [0, 0, 1], (zTop - org[2]) + pitch);
        if (!hits.length) continue;
        var h = 0;
        for (var k = 0; k < nz; k++) {
          var s2 = k * pitch;
          while (h < hits.length && hits[h] <= s2) h++;
          /* h crossings are already behind us; odd means we are in material. */
          if (h & 1) inside[(k * ny + j) * nx + i] = 1;
        }
      }
    }

    /* --- step 3: distance to the surface, on the inside nodes ---
       Exact EDT first, which measures to the nearest OUTSIDE NODE and so
       over-states the true distance to the surface by at most one node
       diagonal. That is fine everywhere except where it decides the answer, so
       every node whose EDT value lands within a diagonal of `wall` - THE BAND -
       has its distance replaced by the true point-to-mesh distance from
       NSO_Thickness. The level set can only fall in the band, so the level set
       is built entirely from exact distances. */
    var seed = new Float64Array(N);
    for (var q = 0; q < N; q++) seed[q] = inside[q] ? 1e18 : 0;
    var F = edt3d(seed, nx, ny, nz);
    seed = null;   // the transform copied it; a 160^3 grid is 33 MB per array

    var diag = pitch * Math.sqrt(3);
    var band = diag + pitch;
    /* The field is written back over the squared distances in place. F[id] is a
       function of d2[id] and inside[id] alone, and each node is visited once,
       so nothing is read after it is overwritten - and a 160^3 grid does not
       need a third 33 MB array to say so. */
    var refined = 0;
    for (var kk = 0; kk < nz; kk++) {
      for (var jj = 0; jj < ny; jj++) {
        for (var ii = 0; ii < nx; ii++) {
          var id = (kk * ny + jj) * nx + ii;
          if (!inside[id]) { F[id] = -wall; continue; }
          var approx = Math.sqrt(F[id]) * pitch;
          if (Math.abs(approx - wall) <= band) {
            /* approx is an upper bound on the truth, so it is also the search
               radius: nearest() stops one ring past it instead of spiralling. */
            var nr = P.nearest([org[0] + ii * pitch, org[1] + jj * pitch, org[2] + kk * pitch],
                               approx + pitch);
            if (nr) { approx = nr.dist; refined++; }
          }
          F[id] = approx - wall;
        }
      }
    }

    var anyCavity = false;
    for (var z2 = 0; z2 < N; z2++) if (F[z2] > 0) { anyCavity = true; break; }
    if (!anyCavity) {
      return { fail: 'a ' + round3(wall) + ' mm wall leaves no cavity anywhere in this piece - ' +
        'every point inside it is within ' + round3(wall) + ' mm of the surface. Hollow thinner, ' +
        'or leave it solid.' };
    }

    /* --- step 4: the level set --- */
    var cavity = surfaceNets(F, nx, ny, nz, org, pitch);
    if (!cavity.length) {
      return { fail: 'the cavity came out with no surface at a ' + round3(pitch) +
        ' mm sample pitch - hollow thinner, or raise stepsPerWall' };
    }

    /* The winding, settled by measurement. An inner shell has to be wound
       INWARD so its normals point into the cavity, away from the material;
       that is negative signed volume, and it is what fill() looks for. The
       traversal in surfaceNets() is consistent but its handedness is not
       something to take on trust, so it is checked here and flipped if the
       check says so. */
    var cavVol = signedVolume(cavity, null);
    var rewound = false;
    if (cavVol > 0) {
      for (var f2 = 0; f2 < cavity.length; f2 += 9) {
        var tx = cavity[f2 + 3], ty = cavity[f2 + 4], tz = cavity[f2 + 5];
        cavity[f2 + 3] = cavity[f2 + 6]; cavity[f2 + 4] = cavity[f2 + 7]; cavity[f2 + 5] = cavity[f2 + 8];
        cavity[f2 + 6] = tx; cavity[f2 + 7] = ty; cavity[f2 + 8] = tz;
      }
      cavVol = -cavVol;
      rewound = true;
    }

    /* --- step 5: outer triangles, untouched, plus the inner shell --- */
    var merged = new Float32Array(rawTris.length + cavity.length);
    merged.set(rawTris, 0);
    merged.set(cavity, rawTris.length);
    return { soup: merged, cavVol: cavVol, rewound: rewound, pitch: pitch,
             band: refined, cavityTris: (cavity.length / 9) | 0 };
    }

    /* THE GATE IS ON THE RESULT, NOT ONLY ON THE REQUEST.

       Refusing a target under the floor (above) is necessary and is not
       sufficient, and the gap between the two is measurable. The cavity
       surface is a level set sampled on a grid, so the wall it actually leaves
       can land under the wall that was asked for: measured on
       fixtures/box_hull_80x40x20-2.stl at a 1.5 mm target, 1.414 mm - a 0.086 mm
       shortfall at a 0.625 mm pitch. At a 1.5 mm target that is irrelevant. At a
       target near the floor it is the whole question, and a Hollow that hands
       back a wall the slicer will drop has failed no matter how safe the number
       the user typed was.

       So the RESULT is measured with the canonical checker before it is
       returned - measureRegion over the OUTER faces, which is the side whose
       wall the floor is about and a fraction of the work of measuring the whole
       piece - and a pass that comes in thin is re-run at half the pitch before
       it is refused. A refusal names the number it actually got. */
    var maxTries = (typeof opts.maxTries === 'number' && opts.maxTries >= 1) ? (opts.maxTries | 0) : 3;
    var verify = opts.verify !== false;
    var pitch = cp.pitch, tries = 0, attempt = null, check = null;
    var nOuter = (rawTris.length / 9) | 0;
    var outerFaces = new Array(nOuter);
    for (var of2 = 0; of2 < nOuter; of2++) outerFaces[of2] = of2;

    while (tries < maxTries) {
      tries++;
      attempt = pass(pitch);
      if (attempt.fail) { out.reason = attempt.fail; return out; }
      if (!verify) break;
      check = TH.measureRegion(attempt.soup, outerFaces,
                               { nozzle: nozzle, minWall: floor, probe: Math.max(TH.PROBE_DEFAULT, wall * 4) });
      if (check.pass) break;
      if (tries < maxTries) { pitch = pitch / 2; continue; }
      out.measured_mm = check.min_mm;
      out.reason = 'Hollow refused - a ' + round3(wall) + ' mm wall came out at ' +
        round3(check.min_mm) + ' mm in ' + check.thin + ' place(s), under the ' + round3(floor) +
        ' mm floor for a ' + round3(nozzle) + ' mm nozzle, and a finer sample pitch did not fix it. ' +
        'Hollow to a thicker wall; piece unchanged.';
      return out;
    }

    out.ok = true;
    out.soup = attempt.soup;
    out.pitch_mm = attempt.pitch;
    out.tries = tries;
    out.band_nodes = attempt.band;
    out.rewound = attempt.rewound;
    out.cavity_tris = attempt.cavityTris;
    out.tris_after = (attempt.soup.length / 9) | 0;
    out.volume_before = signedVolume(rawTris, null);
    out.volume_after = out.volume_before + attempt.cavVol;
    out.cavity_volume = -attempt.cavVol;
    out.measured_mm = check ? check.min_mm : null;
    out.reason = 'Hollowed to a ' + round3(wall) + ' mm wall - ' + out.cavity_tris +
      ' cavity triangle(s) at a ' + round3(attempt.pitch) + ' mm pitch, ' +
      round3(-attempt.cavVol) + ' mm³ of interior removed' +
      (check ? ', wall measured ' + round3(check.min_mm) + ' mm against a ' + round3(floor) + ' mm floor' : '') +
      (out.floored ? ' (' + out.floor_note + ')' : '') +
      (cp.capped ? ' (pitch capped by the grid limit)' : '');
    return out;
  }

  /* ===================================================================
     FILL / DENSIFY - the inverse

     Given a hollow shell, fill the interior cavity solid. Which is to say:
     find the shells that bound enclosed cavities and delete them, because a
     solid is exactly a hollow piece with its inner surfaces gone.

     Nothing is remeshed and nothing is resampled. The outer surface comes back
     bit for bit, which is what makes fill(hollow(X)) return X's own triangles
     rather than a lookalike - and that round trip is a test, not a hope.

     A cavity wall is identified by two things together, because neither alone
     is enough:
       - it is wound INWARD (negative signed volume). A separate solid sitting
         captive inside another - a rattle's ball, a trapped bearing - is wound
         OUTWARD and is not a cavity wall, and deleting it would be wrong.
       - it sits IN MATERIAL. Stepping from its surface the way its normals do
         NOT point lands inside the solid. A mis-wound outer shell fails this
         and is left alone and reported, rather than silently deleted.
     =================================================================== */
  function fill(rawTris, opts) {
    var TH = needThickness();
    opts = opts || {};
    var out = {
      ok: false, soup: rawTris, reason: '',
      shells: 0, filled: 0, kept: 0,
      tris_before: rawTris ? (rawTris.length / 9) | 0 : 0, tris_after: 0,
      volume_before: null, volume_after: null, cavity_volume: 0
    };
    if (!rawTris || rawTris.length < 9) { out.reason = 'nothing to fill - empty piece'; return out; }

    var P = TH.prepare(rawTris, opts);
    if (!P) { out.reason = 'nothing to fill - empty piece'; return out; }
    var vids = P.vids, nf = vids.length;

    /* Shells: faces joined across shared welded EDGES. Vertices alone would
       fuse two shells that merely touch at a point. */
    var comp = new Int32Array(nf).fill(-1);
    var edge = new Map();
    for (var f = 0; f < nf; f++) {
      var t = vids[f];
      for (var e = 0; e < 3; e++) {
        var u = t[e], w = t[(e + 1) % 3];
        var key = (u < w ? u : w) + ',' + (u < w ? w : u);
        var lst = edge.get(key);
        if (!lst) { lst = []; edge.set(key, lst); }
        lst.push(f);
      }
    }
    var shells = [];
    for (var f2 = 0; f2 < nf; f2++) {
      if (comp[f2] >= 0) continue;
      var id = shells.length, stack = [f2], list = [];
      comp[f2] = id;
      while (stack.length) {
        var g = stack.pop();
        list.push(g);
        var tg = vids[g];
        for (var e2 = 0; e2 < 3; e2++) {
          var u2 = tg[e2], w2 = tg[(e2 + 1) % 3];
          var nb = edge.get((u2 < w2 ? u2 : w2) + ',' + (u2 < w2 ? w2 : u2));
          if (!nb) continue;
          for (var q = 0; q < nb.length; q++) {
            if (comp[nb[q]] < 0) { comp[nb[q]] = id; stack.push(nb[q]); }
          }
        }
      }
      shells.push(list);
    }
    out.shells = shells.length;
    if (shells.length < 2) {
      out.reason = 'nothing to fill - this piece is one shell, so it has no enclosed cavity. ' +
        'Fill removes interior surfaces; there are none here.';
      return out;
    }

    /* Is this inward-wound shell sitting in material? Sampled at several faces
       rather than one, because a single face can be a sliver whose centroid
       offset lands on the wrong side of a thin wall. */
    function enclosed(list) {
      var votes = 0, asked = 0;
      var stepN = Math.max(1, Math.floor(list.length / 9));
      for (var i = 0; i < list.length && asked < 9; i += stepN) {
        var fi = list[i], Tp = P.tris[fi];
        var Nn = P.faceNormal(fi);
        if (!Nn) continue;
        var c = [(Tp[0][0] + Tp[1][0] + Tp[2][0]) / 3,
                 (Tp[0][1] + Tp[1][1] + Tp[2][1]) / 3,
                 (Tp[0][2] + Tp[1][2] + Tp[2][2]) / 3];
        /* How far there is to step before the next surface, measured rather
           than guessed - on a cavity wall that IS the wall thickness, and a
           quarter of it is safely inside the material and safely off the face. */
        var w = P.wallAt(c, { normal: Nn });
        var step = w.measured ? Math.max(w.mm * 0.25, TH.WELD_TOL * 10) : null;
        if (step === null) continue;
        asked++;
        if (P.inside([c[0] - Nn[0] * step, c[1] - Nn[1] * step, c[2] - Nn[2] * step])) votes++;
      }
      return asked > 0 && votes * 2 > asked;
    }

    /* A DROP MASK, not a list of survivors, so the faces that stay can be
       copied in their ORIGINAL order. That is what makes fill(hollow(X)) come
       back as X's own soup rather than a permutation of it - the triangles
       would be the same set either way, but a reordered soup is not the same
       file, and the round trip is a test this suite actually runs. */
    var drop = new Uint8Array(nf);
    var removedVol = 0, filled = 0, mis = 0, kept = 0;
    for (var s = 0; s < shells.length; s++) {
      var vol = signedVolume(rawTris, shells[s]);
      if (vol < 0 && enclosed(shells[s])) {
        for (var dq = 0; dq < shells[s].length; dq++) drop[shells[s][dq]] = 1;
        removedVol += -vol;
        filled++;
        continue;
      }
      if (vol < 0) mis++;
      kept++;
    }

    if (!filled) {
      out.reason = 'nothing to fill - none of this piece\'s ' + shells.length +
        ' shell(s) bounds an enclosed cavity' +
        (mis ? ' (' + mis + ' inward-wound shell(s) are not inside material and were left alone)' : '') +
        '. A captive separate solid is not a cavity and is never removed.';
      return out;
    }

    var total = 0, i2;
    for (i2 = 0; i2 < nf; i2++) if (!drop[i2]) total++;
    var soup = new Float32Array(total * 9);
    var at = 0;
    for (i2 = 0; i2 < nf; i2++) {
      if (drop[i2]) continue;
      var o = i2 * 9;
      for (var c2 = 0; c2 < 9; c2++) soup[at + c2] = rawTris[o + c2];
      at += 9;
    }

    out.ok = true;
    out.soup = soup;
    out.filled = filled;
    out.kept = kept;
    out.tris_after = total;
    out.cavity_volume = removedVol;
    out.volume_before = signedVolume(rawTris, null);
    out.volume_after = signedVolume(soup, null);
    out.reason = 'Filled ' + filled + ' cavit' + (filled === 1 ? 'y' : 'ies') + ' - ' +
      (out.tris_before - total) + ' interior triangle(s) removed, ' +
      round3(removedVol) + ' mm³ of cavity now solid' +
      (mis ? ' (' + mis + ' inward-wound shell(s) left alone - not inside material)' : '');
    return out;
  }

  var api = {
    safeMinWall: safeMinWall,
    hollow: hollow,
    fill: fill,
    signedVolume: signedVolume,
    STEPS_PER_WALL: STEPS_PER_WALL,
    MAX_DIM: MAX_DIM
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Hollow = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
