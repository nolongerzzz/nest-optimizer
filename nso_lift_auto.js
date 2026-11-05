/* nso_lift_auto.js - Lift 2: auto-aim and Strip. Details found from a
   top-down height map of the piece, so a base that bends gently works too.

   Loads as a classic script (window.NSO_LiftAuto) and as a Node module
   (require('../nso_lift_auto.js')). No DOM, no Three.js. After nso_lift.js,
   whose loops, caps and checks it uses unchanged.

   READ docs/LIFT.md FIRST (section "Lift 2"; section 6 for Lift 3).

   LIFT 3 - analyse(soup, tri, { curved: true }). Detection is the same. An
   island whose surround is not one flat plane is no longer refused for
   bending: its base is quadratics fitted to that surround (fitLocal), what
   comes off is what stands above THAT, and Lift / Remove make the plate good
   with nso_lift_curved.js's fill - the surrounding surface carried across,
   welded to the real neighbours at the rim. An island whose surround leans
   more than slantDeg off the view is refused ('slant'), never cut. Islands
   on a flat surround are Lift 2's exactly. Without the option, nothing here
   changes.

   ---------------------------------------------------------------------------
   THE MAP DECIDES WHERE. THE REAL MESH DECIDES WHAT.
   ---------------------------------------------------------------------------
   Phase 1 (nso_lift.js) finds details from the clicked face's coplanar
   patch, so it needs a flat base. Here:

     map      looking down the base's normal, the piece's upward-facing
              surface rasterized into a height grid, 0.25 mm per cell (made
              coarser, and said so, past about 4 million cells). Each cell
              keeps its height and the triangle that is on top there. Nothing
              is photographed: the map is the mesh, sampled.
     base     estimateBase(map): a rolling ball - a morphological opening
              with a spherical element - so it follows gentle curves and
              steps over the details. Radius: 0.2 of the piece's shorter
              footprint side, clamped to 4 - 15 mm. ONE replaceable function
              (api.estimateBase); a better estimator replaces it there.
     detail   a cell more than 0.32 mm above the base (`layerFloorMm`), so a
              print's layer steps (0.2 - 0.3 mm) never read as stepped
              details. The slider ("How far out counts") then offers an
              island standing out MORE than it, as in Phase 1 - so moving it
              filters, it never reads the map again. (opts.thresholdMm can
              raise the detection itself; nothing in the app sets it.)
     island   8-connected detail cells next to the face the click is on (the
              base cells joined to the clicked cell), gaps of one or two
              cells closed.
     its own  first, the best-fit plane of the base samples round its
     plane    footprint: cells of the face 0.75 - 2.25 mm out from it, clear
              of anything standing out, where the surface and the base
              estimate agree (so a speck too low to count, or a step's edge,
              is not a sample). If the base bends away from that plane by
              more than 0.15 mm there, THAT island is refused in words and
              the rest go on. Then, once the real triangles are known, the
              plane is refitted to the island's own root (where it meets the
              face - where the cut is), and refused the same way if that
              root is more than 0.15 mm off flat.
     what     the real triangles: those on top in the island's cells that
     comes    stand above its plane, grown edge to edge through triangles
     off      that stand above it, never across an edge lying in it. So walls
              and undercuts come with it, and two bodies that only touch in
              the map are two islands. A body that runs on past the measured
              ring is measured further and grown again (up to 12 times); two
              islands whose triangles run into each other are one body,
              merged. An island stops, all round, on its plane: never at an
              open edge, never down a side of the part (Phase 1's rule).
     lift     each island + a cap on its root loops (rawFlatCapLoops, the cut
              engine's, through Phase 1's capFor, at the island's plane) is
              its own closed piece; the plate keeps every other triangle in
              order and gains the matching cap. The cap is made of the root
              loop's own vertices, so the back lies on the island's plane to
              within the bend that was measured (at most 0.15 mm). Where the
              root is not exactly flat the cap's inside edges are re-paired
              toward Delaunay (refineCap) - the same corners and outline -
              so no sliver climbs over the walls.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   analyse(soup, seedTri, opts) -> Phase 1's shape ({ ok, M, islands,
                                   islandOf, base, plane, seed, reason }) plus
                                   kind 'map', map, groups, necks, ms
                                   (opts.curved: Lift 3 - island.fill 'curved',
                                   island.base, island.fillNotes)
   offered(A, minHeight)        -> ids: liftable and standing out more than it
   lift(soup, A, ids, deps)     -> { ok, plate, pieces, volumes, reason }
   remove(soup, A, ids, deps)   -> { ok, plate, removed, volumes, reason }
   buildMap(soup, n, opts)      -> the height grid
   estimateBase(map, opts)      -> { B, radiusMm, ... } (replaceable)
   GROUPS, groupOf(I, opts)     -> Strip's groups, by geometry only
   index(soup)                  -> the exact weld (numeric hashes; Phase 1's
                                   shape, fast enough for 0.5 M triangles)

   ASSEMBLIES (docs/LIFT.md section 8). A shell of the piece that is not
   connected to the base body and is captured by a liftable feature - inside its
   box inflated by captureMm (2 mm), or overlapping its box - goes with it:
   `assemble`, at the end of analyse, gives the feature `parts` / `partCount`,
   drops the held shell's own island and points its triangles at the feature in
   islandOf. lift / remove copy the held shells into the piece triangle for
   triangle (separate shells, original gaps, nothing fused) and take them off the
   plate. A shell nothing holds is island status 'floating'; a held shell that is
   not closed makes the feature 'capture' (refused). A piece with one shell is
   untouched by all of this. `shellsOf(M)` is exported.

   Neck splitting is NOT done here. Each large island carries `necks`: where
   a watershed on its smoothed distance transform would divide it, as data
   for the next ticket. Nothing reads it to cut.

   PAINT SCOPE: NONE, for this module. It reads soups and writes none.
*/
(function (root) {
  'use strict';

  var DEFAULTS = {
    cellMm: 0.25,          // the map's cell
    maxCells: 4e6,         // ...made coarser past this many
    ballFrac: 0.2,         // rolling ball: 0.2 of the shorter footprint side
    ballMinMm: 4,
    ballMaxMm: 15,
    ballCells: 12,         // the ball is rolled on a grid where it is this many cells across its radius
    layerFloorMm: 0.32,    // a print's layer steps (0.2 - 0.3 mm) are never details
    bendTolMm: 0.15,       // the base under one island may bend this far off its plane
    ringMm: 1.5,           // base samples this wide round each footprint...
    fringeMm: 0.6,         // ...starting this far out, clear of anything standing out
    marginMm: 0.02,        // above the island's plane = more than bend + this
    normalRadiusMm: 10,    // the view: the mean normal of the face this far round the click
    normalDeg: 60,          // ...of the triangles within this of the clicked one (walls left out)
    snapDeg: 0.5,          // ...put on an axis when it is this close to one
    steepDeg: 70,          // map cells whose surface is steeper than this off the view: walls seen
                           // nearly edge-on - not used to roll the ball or to measure a base
    widenRounds: 12,       // a body that runs on past its ring: measured further this many times
    cleanMm: 0.04,         // a base sample: surface within this of the base estimate (then 2.5x, then the threshold)
    holeCells: 2,          // enclosed gaps of at most this many cells are closed
    dotAreaMm2: 16,        // Strip: small dots are compact and no bigger than this
    thinRatio: 4,          // lines & squiggles: length / width at least this...
    lineWidthMm: 3,        // ...and no wider than this
    neckRatio: 0.7,        // necks (data only): a saddle below 0.7 of the smaller part's width
    // Lift 3 (opts.curved): a base that is not one flat plane is followed, not refused
    curved: false,
    slantDeg: 35,          // ...an island whose surround leans more than this off the view is read too slantwise
    relaxMm: 1.5,          // ...the fill relaxes from the neighbours to the base estimate over about this
    fitSigmaMm: 3,         // ...the base carried across: quadratics fitted to the surround, weighted over about this
    // Assemblies: a shell not connected to the base body is caught by a feature whose box,
    // inflated by this, holds it - or whose box it overlaps
    captureMm: 2
  };

  var BASE = 1, ABOVE = 2, BELOW = 3;

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]); return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
  function fmt(x, d) { return (+x).toFixed(d == null ? 2 : d); }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function P1() {
    if (root && root.NSO_Lift) return root.NSO_Lift;
    if (typeof require === 'function') { try { return require('./nso_lift.js'); } catch (e) { /* browser */ } }
    return null;
  }
  function LC() {
    if (root && root.NSO_LiftCurved) return root.NSO_LiftCurved;
    if (typeof require === 'function') { try { return require('./nso_lift_curved.js'); } catch (e) { /* browser */ } }
    return null;
  }
  function dep(deps, name) {
    return (deps && deps[name]) || (root && root[name]) ||
           (typeof globalThis !== 'undefined' ? globalThis[name] : null) || null;
  }

  // -------------------------------------------------------------------------
  // The weld: Phase 1's index (same fields, same rule - corners equal bit for
  // bit are one vertex, 0 and -0 alike), with numeric hashing so half a
  // million triangles weld in a fraction of a second.
  // -------------------------------------------------------------------------

  function fmix(h) {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }

  function index(soup) {
    var nt = Math.floor(soup.length / 9), nc = nt * 3;
    var X = new Float64Array(nc * 3);
    for (var i = 0; i < nc * 3; i++) X[i] = soup[i] + 0;
    var W = new Uint32Array(X.buffer);
    var size = 1; while (size < nc * 2) size <<= 1;
    var mask = size - 1, slot = new Int32Array(size).fill(-1);
    var tv = new Int32Array(nc), VX = new Float64Array(nc * 3), nv = 0;
    for (var c = 0; c < nc; c++) {
      var w = c * 6, h = 2166136261;
      for (var q = 0; q < 6; q++) { h ^= W[w + q]; h = Math.imul(h, 16777619); }
      var p = fmix(h) & mask, x = X[c * 3], y = X[c * 3 + 1], z = X[c * 3 + 2];
      for (;;) {
        var id = slot[p];
        if (id < 0) { id = nv++; slot[p] = id; VX[id * 3] = x; VX[id * 3 + 1] = y; VX[id * 3 + 2] = z; break; }
        if (VX[id * 3] === x && VX[id * 3 + 1] === y && VX[id * 3 + 2] === z) break;
        p = (p + 1) & mask;
      }
      tv[c] = id;
    }
    VX = VX.slice(0, nv * 3);
    var V = new Array(nv), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var v = 0; v < nv; v++) {
      V[v] = [VX[v * 3], VX[v * 3 + 1], VX[v * 3 + 2]];
      for (var a = 0; a < 3; a++) { if (V[v][a] < lo[a]) lo[a] = V[v][a]; if (V[v][a] > hi[a]) hi[a] = V[v][a]; }
    }
    // directed edges: a -> b owned by one triangle (-1: used twice that way)
    var E = new Int32Array(size * 3).fill(-1);             // [a, b, owner] per slot, side by side
    function ehash(a2, b2) { return fmix(Math.imul(a2, 73856093) ^ Math.imul(b2, 19349663)) & mask; }
    for (var t = 0; t < nt; t++) {
      for (var k = 0; k < 3; k++) {
        var ea = tv[t * 3 + k], eb = tv[t * 3 + (k + 1) % 3];
        if (ea === eb) continue;
        var s = ehash(ea, eb) * 3;
        for (;;) {
          if (E[s] < 0) { E[s] = ea; E[s + 1] = eb; E[s + 2] = t; break; }
          if (E[s] === ea && E[s + 1] === eb) { E[s + 2] = -1; break; }
          s += 3; if (s >= size * 3) s = 0;
        }
      }
    }
    var twinArr = new Int32Array(nc).fill(-1);
    for (t = 0; t < nt; t++) {
      for (k = 0; k < 3; k++) {
        var ra = tv[t * 3 + (k + 1) % 3], rb = tv[t * 3 + k];
        if (ra === rb) continue;
        var s2 = ehash(ra, rb) * 3;
        for (;;) {
          if (E[s2] < 0) break;
          if (E[s2] === ra && E[s2 + 1] === rb) { twinArr[t * 3 + k] = E[s2 + 2]; break; }
          s2 += 3; if (s2 >= size * 3) s2 = 0;
        }
      }
    }
    var nrm = new Float64Array(nt * 3), area = new Float64Array(nt);
    for (t = 0; t < nt; t++) {
      var i0 = tv[t * 3] * 3, i1 = tv[t * 3 + 1] * 3, i2 = tv[t * 3 + 2] * 3;
      var ux = VX[i1] - VX[i0], uy = VX[i1 + 1] - VX[i0 + 1], uz = VX[i1 + 2] - VX[i0 + 2];
      var wx = VX[i2] - VX[i0], wy = VX[i2 + 1] - VX[i0 + 1], wz = VX[i2 + 2] - VX[i0 + 2];
      var cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx, l = Math.sqrt(cx * cx + cy * cy + cz * cz);
      area[t] = l / 2;
      if (l > 0) { nrm[t * 3] = cx / l; nrm[t * 3 + 1] = cy / l; nrm[t * 3 + 2] = cz / l; }
    }
    return {
      soup: soup, nt: nt, nv: nv, V: V, VX: VX, tv: tv, twinArr: twinArr, n: nrm, area: area,
      scale: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1,
      twin: function (t2, k2) { return twinArr[t2 * 3 + k2]; }
    };
  }

  /** Phase 1's census (closed and manifold by exact corners; the same
      counts), on numeric hashes - the plate of a half-million-triangle piece
      is counted in a fraction of the time. */
  function census(soup) {
    var nt = Math.floor(soup.length / 9), nc = nt * 3;
    var X = new Float64Array(nc * 3);
    for (var i = 0; i < nc * 3; i++) X[i] = soup[i] + 0;
    var W = new Uint32Array(X.buffer), size = 1;
    while (size < nc * 2) size <<= 1;
    var mask = size - 1, slot = new Int32Array(size).fill(-1), VX = new Float64Array(nc * 3), ids = new Int32Array(nc), nv = 0;
    for (var c = 0; c < nc; c++) {
      var h = 2166136261;
      for (var q = 0; q < 6; q++) { h ^= W[c * 6 + q]; h = Math.imul(h, 16777619); }
      var p = fmix(h) & mask, x = X[c * 3], y = X[c * 3 + 1], z = X[c * 3 + 2];
      for (;;) {
        var id = slot[p];
        if (id < 0) { id = nv++; slot[p] = id; VX[id * 3] = x; VX[id * 3 + 1] = y; VX[id * 3 + 2] = z; break; }
        if (VX[id * 3] === x && VX[id * 3 + 1] === y && VX[id * 3 + 2] === z) break;
        p = (p + 1) & mask;
      }
      ids[c] = id;
    }
    var E = new Int32Array(size * 3).fill(-1), nd = 0, degen = 0;      // [a, b, count]
    function slotOf(a, b, add) {
      var s2 = (fmix(Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & mask) * 3;
      for (;;) {
        if (E[s2] < 0) { if (!add) return -1; E[s2] = a; E[s2 + 1] = b; E[s2 + 2] = 0; nd++; return s2; }
        if (E[s2] === a && E[s2 + 1] === b) return s2;
        s2 += 3; if (s2 >= size * 3) s2 = 0;
      }
    }
    for (var t = 0; t < nt; t++) {
      var a = ids[t * 3], b = ids[t * 3 + 1], d = ids[t * 3 + 2], o = t * 9;
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var wx = soup[o + 6] - soup[o], wy = soup[o + 7] - soup[o + 1], wz = soup[o + 8] - soup[o + 2];
      var cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      if (a === b || b === d || a === d || Math.sqrt(cx * cx + cy * cy + cz * cz) < 1e-12) degen++;
      E[slotOf(a, b, true) + 2]++; E[slotOf(b, d, true) + 2]++; E[slotOf(d, a, true) + 2]++;
    }
    var nm = 0, open = 0;
    for (var s3 = 0; s3 < size * 3; s3 += 3) {
      var ea = E[s3];
      if (ea < 0) continue;
      var eb = E[s3 + 1], cnt = E[s3 + 2];
      if (ea === eb) continue;
      var r = slotOf(eb, ea, false), tw = r < 0 ? 0 : E[r + 2];
      if (tw && ea > eb) continue;
      if (cnt > 1 || tw > 1) nm++;
      else if (tw === 0) open++;
    }
    return { tris: nt, verts: nv, open: open, nm: nm, degen: degen, closed: open === 0 && nm === 0, chi: nv - nd / 2 + nt };
  }

  // -------------------------------------------------------------------------
  // The view: the mean normal of the face round the click
  // -------------------------------------------------------------------------

  function baseNormal(M, seed, o) {
    var n0 = [M.n[seed * 3], M.n[seed * 3 + 1], M.n[seed * 3 + 2]];
    var c0 = centroid(M, seed), r2 = o.normalRadiusMm * o.normalRadiusMm, cmin = Math.cos(o.normalDeg * Math.PI / 180);
    var seen = new Uint8Array(M.nt), list = [seed], sum = [0, 0, 0];
    seen[seed] = 1;
    for (var i = 0; i < list.length; i++) {
      var t = list[i], a = M.area[t];
      sum[0] += a * M.n[t * 3]; sum[1] += a * M.n[t * 3 + 1]; sum[2] += a * M.n[t * 3 + 2];
      for (var k = 0; k < 3; k++) {
        var u = M.twin(t, k);
        if (u < 0 || seen[u]) continue;
        seen[u] = 1;
        if (M.n[u * 3] * n0[0] + M.n[u * 3 + 1] * n0[1] + M.n[u * 3 + 2] * n0[2] < cmin) continue;
        var cu = centroid(M, u);
        if ((cu[0] - c0[0]) * (cu[0] - c0[0]) + (cu[1] - c0[1]) * (cu[1] - c0[1]) + (cu[2] - c0[2]) * (cu[2] - c0[2]) > r2) continue;
        list.push(u);
      }
    }
    var n = norm(sum), cs = Math.cos(o.snapDeg * Math.PI / 180);
    for (var ax = 0; ax < 3; ax++) {
      if (Math.abs(n[ax]) >= cs) { var s = n[ax] > 0 ? 1 : -1; n = [0, 0, 0]; n[ax] = s; }
    }
    return n;
  }

  function centroid(M, t) {
    var a = M.V[M.tv[t * 3]], b = M.V[M.tv[t * 3 + 1]], c = M.V[M.tv[t * 3 + 2]];
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  }

  // -------------------------------------------------------------------------
  // The map: the upward-facing surface, looking down n, into a height grid
  // -------------------------------------------------------------------------

  function buildMap(soup, n, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var t0 = now();
    var fr = P1().internals.planeFrame(n), e1 = fr.e1, e2 = fr.e2;
    var nt = Math.floor(soup.length / 9), nc = nt * 3;
    var PU = new Float64Array(nc), PV = new Float64Array(nc), PW = new Float64Array(nc);
    var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (var c = 0; c < nc; c++) {
      var x = soup[c * 3], y = soup[c * 3 + 1], z = soup[c * 3 + 2];
      var u = x * e1[0] + y * e1[1] + z * e1[2], v = x * e2[0] + y * e2[1] + z * e2[2];
      PU[c] = u; PV[c] = v; PW[c] = x * n[0] + y * n[1] + z * n[2];
      if (u < umin) umin = u; if (u > umax) umax = u;
      if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
    var su = umax - umin, sv = vmax - vmin, cell = o.cellMm, words = null;
    function cells(cs) { return (Math.ceil(su / cs) + 2) * (Math.ceil(sv / cs) + 2); }
    if (cells(cell) > o.maxCells) {
      var want = cells(cell), c2 = Math.ceil(Math.sqrt(su * sv / o.maxCells) * 100) / 100;
      while (cells(c2) > o.maxCells) c2 = Math.round(c2 * 100 + 1) / 100;
      words = 'the piece is ' + fmt(su, 0) + ' x ' + fmt(sv, 0) + ' mm across, and at ' + fmt(o.cellMm) +
        ' mm per cell its height map would be ' + fmt(want / 1e6, 1) + ' million cells, over the ' +
        fmt(o.maxCells / 1e6, 0) + ' million it keeps - so it is read at ' + fmt(c2) + ' mm per cell instead';
      cell = c2;
    }
    var nu = Math.ceil(su / cell) + 2, nvv = Math.ceil(sv / cell) + 2, N = nu * nvv;
    var u0 = umin - cell, v0 = vmin - cell;            // cell centres at u0 + (i + 0.5) cell; a ring of empty cells round it
    var H = new Float32Array(N).fill(-Infinity), T = new Int32Array(N).fill(-1), steep = new Uint8Array(N);
    var inv = 1 / cell, eps = 1e-9, cosSteep = Math.cos(o.steepDeg * Math.PI / 180);
    for (var t = 0; t < nt; t++) {
      var a = t * 3, b = a + 1, d = a + 2;
      var ua = PU[a], va = PV[a], ub = PU[b], vb = PV[b], ud = PU[d], vd = PV[d];
      var ar = (ub - ua) * (vd - va) - (ud - ua) * (vb - va);
      if (!(ar > 0)) continue;                          // facing away from n, or edge-on
      var wa = PW[a], wb = PW[b], wd = PW[d], ia = 1 / ar;
      // steeper than steepDeg off the view: a wall seen nearly edge-on
      var o9 = t * 9, ax = soup[o9 + 3] - soup[o9], ay = soup[o9 + 4] - soup[o9 + 1], az = soup[o9 + 5] - soup[o9 + 2];
      var bx = soup[o9 + 6] - soup[o9], by = soup[o9 + 7] - soup[o9 + 1], bz = soup[o9 + 8] - soup[o9 + 2];
      var qx = ay * bz - az * by, qy = az * bx - ax * bz, qz = ax * by - ay * bx;
      var isSteep = ar < cosSteep * Math.sqrt(qx * qx + qy * qy + qz * qz) ? 1 : 0;
      var i0 = Math.max(0, Math.ceil((Math.min(ua, ub, ud) - u0) * inv - 0.5));
      var i1 = Math.min(nu - 1, Math.floor((Math.max(ua, ub, ud) - u0) * inv - 0.5));
      var j0 = Math.max(0, Math.ceil((Math.min(va, vb, vd) - v0) * inv - 0.5));
      var j1 = Math.min(nvv - 1, Math.floor((Math.max(va, vb, vd) - v0) * inv - 0.5));
      for (var j = j0; j <= j1; j++) {
        var cv = v0 + (j + 0.5) * cell, row = j * nu;
        for (var i = i0; i <= i1; i++) {
          var cu = u0 + (i + 0.5) * cell;
          var l0 = ((ub - cu) * (vd - cv) - (ud - cu) * (vb - cv)) * ia;
          if (l0 < -eps) continue;
          var l1 = ((ud - cu) * (va - cv) - (ua - cu) * (vd - cv)) * ia;
          if (l1 < -eps) continue;
          var l2 = 1 - l0 - l1;
          if (l2 < -eps) continue;
          var hh = l0 * wa + l1 * wb + l2 * wd, idx = row + i;
          if (hh > H[idx]) { H[idx] = hh; T[idx] = t; steep[idx] = isSteep; }
        }
      }
    }
    return {
      n: n, e1: e1, e2: e2, cell: cell, nu: nu, nv: nvv, u0: u0, v0: v0, H: H, T: T, steep: steep,
      sizeMm: [su, sv], coarsened: words, ms: now() - t0
    };
  }

  // -------------------------------------------------------------------------
  // The base under the details: a rolling ball. ONE replaceable function.
  // -------------------------------------------------------------------------

  /**
   * The rolling-ball base: a morphological opening of the height map with a
   * spherical element - erode (the highest a ball's centre can be under the
   * surface), then dilate (the top of every such ball). It follows any
   * curve gentler than the ball and steps over anything narrower than it.
   * Empty cells (no surface: outside the piece, a through-hole) are left out
   * of both, never treated as low.
   *
   * The ball is rolled on a grid where its radius is `ballCells` cells (the
   * map's cells grouped, each group read as the median of its heights), and
   * the result is read back onto the map bilinearly, never above the
   * surface. A ball 4 - 15 mm across its radius has no detail finer than
   * that to follow; the grouping is what makes it cost milliseconds.
   */
  function rollingBall(map, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var t0 = now();
    var side = Math.min(map.sizeMm[0], map.sizeMm[1]);
    var r = Math.max(o.ballMinMm, Math.min(o.ballMaxMm, o.ballFrac * side));
    var W = map.nu, Hh = map.nv, H = map.H, cell = map.cell, St = map.steep || new Uint8Array(W * Hh);
    var f = Math.max(1, Math.round(r / o.ballCells / cell)), cb = f * cell;
    var cw = Math.ceil(W / f), ch = Math.ceil(Hh / f), NC = cw * ch;
    var Hc = new Float64Array(NC).fill(NaN), buf = new Float64Array(f * f);
    for (var cj = 0; cj < ch; cj++) {
      for (var ci = 0; ci < cw; ci++) {
        var m = 0;
        for (var j = cj * f; j < Math.min(Hh, cj * f + f); j++) {
          for (var i = ci * f; i < Math.min(W, ci * f + f); i++) { var h = H[j * W + i]; if (h > -Infinity && !St[j * W + i]) buf[m++] = h; }
        }
        if (!m) continue;
        var s = Array.prototype.slice.call(buf, 0, m).sort(function (a, b) { return a - b; });
        Hc[cj * cw + ci] = m % 2 ? s[m >> 1] : (s[m / 2 - 1] + s[m / 2]) / 2;
      }
    }
    var R = r / cb, Ri = Math.floor(R), ox = [], oy = [], og = [];
    for (var dy = -Ri; dy <= Ri; dy++) {
      for (var dx = -Ri; dx <= Ri; dx++) {
        var d2 = (dx * dx + dy * dy) * cb * cb;
        if (d2 > r * r) continue;
        ox.push(dx); oy.push(dy); og.push(Math.sqrt(r * r - d2));
      }
    }
    var no = ox.length;
    // Ball centres may sit off the piece (a padded grid): empty cells hold
    // nothing up, so a ball can touch a surface that rises toward its edge.
    var P = Ri + 1, pw = cw + 2 * P, ph = ch + 2 * P;
    var E = new Float64Array(pw * ph).fill(NaN), D = new Float64Array(NC).fill(NaN);
    for (var ej = 0; ej < ph; ej++) {
      for (var ei = 0; ei < pw; ei++) {
        var best = Infinity, ci0 = ei - P, cj0 = ej - P;
        for (var q = 0; q < no; q++) {
          var x = ci0 + ox[q], y = cj0 + oy[q];
          if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
          var hv = Hc[y * cw + x] - og[q];
          if (hv < best) best = hv;
        }
        if (best < Infinity) E[ej * pw + ei] = best;
      }
    }
    for (cj = 0; cj < ch; cj++) {
      for (ci = 0; ci < cw; ci++) {
        var p2 = cj * cw + ci;
        if (!(Hc[p2] === Hc[p2])) continue;
        var top = -Infinity;
        for (var q2 = 0; q2 < no; q2++) {
          var ev = E[(cj + P + oy[q2]) * pw + (ci + P + ox[q2])] + og[q2];
          if (ev > top) top = ev;
        }
        D[p2] = top;
      }
    }
    // back onto the map: bilinear between group centres, never above the surface
    var B = new Float32Array(W * Hh).fill(NaN);
    for (j = 0; j < Hh; j++) {
      var gy = (j + 0.5) / f - 0.5, y0 = Math.floor(gy), fy = gy - y0;
      for (i = 0; i < W; i++) {
        var hh = H[j * W + i];
        if (!(hh > -Infinity)) continue;
        var gx = (i + 0.5) / f - 0.5, x0 = Math.floor(gx), fx = gx - x0, sw = 0, sv = 0;
        for (var k = 0; k < 4; k++) {
          var xx = x0 + (k & 1), yy = y0 + (k >> 1);
          if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
          var dv = D[yy * cw + xx];
          if (!(dv === dv)) continue;
          var wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
          sw += wgt; sv += wgt * dv;
        }
        var bv = sw > 1e-12 ? sv / sw : D[Math.min(ch - 1, Math.max(0, Math.round(gy))) * cw + Math.min(cw - 1, Math.max(0, Math.round(gx)))];
        if (!(bv === bv) || bv > hh) bv = hh;
        B[j * W + i] = bv;
      }
    }
    return { B: B, radiusMm: r, coarseMm: cb, ms: now() - t0,
      words: 'a rolling ball ' + fmt(r, 1) + ' mm in radius (0.2 of the piece\'s shorter side, ' + fmt(side, 1) +
        ' mm, kept within ' + o.ballMinMm + ' - ' + o.ballMaxMm + ' mm)' };
  }

  // -------------------------------------------------------------------------
  // Small grid tools
  // -------------------------------------------------------------------------

  var N8x = [1, -1, 0, 0, 1, 1, -1, -1], N8y = [0, 0, 1, -1, 1, -1, 1, -1];

  /** Exact squared Euclidean distance (in cells) to the nearest cell outside
      the mask - Felzenszwalb & Huttenlocher's two separable passes. */
  function edt(mask, w, h) {
    var INF = 1e20, g = new Float64Array(w * h), f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
    var vv = new Int32Array(Math.max(w, h)), zz = new Float64Array(Math.max(w, h) + 1);
    function pass(n) {
      var k = 0; vv[0] = 0; zz[0] = -INF; zz[1] = INF;
      for (var q = 1; q < n; q++) {
        var s = ((f[q] + q * q) - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
        while (s <= zz[k]) { k--; s = ((f[q] + q * q) - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]); }
        k++; vv[k] = q; zz[k] = s; zz[k + 1] = INF;
      }
      k = 0;
      for (q = 0; q < n; q++) { while (zz[k + 1] < q) k++; d[q] = (q - vv[k]) * (q - vv[k]) + f[vv[k]]; }
    }
    for (var x = 0; x < w; x++) {
      for (var y = 0; y < h; y++) f[y] = mask[y * w + x] ? INF : 0;
      pass(h);
      for (y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) f[x] = g[y * w + x];
      pass(w);
      for (x = 0; x < w; x++) g[y * w + x] = d[x];
    }
    return g;
  }

  /** A footprint as a padded local mask. */
  function footMask(cells, nu) {
    var i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    for (var q = 0; q < cells.length; q++) {
      var i = cells[q] % nu, j = (cells[q] - i) / nu;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
    }
    var w = i1 - i0 + 3, h = j1 - j0 + 3, m = new Uint8Array(w * h);
    for (q = 0; q < cells.length; q++) {
      var ii = cells[q] % nu, jj = (cells[q] - ii) / nu;
      m[(jj - j0 + 1) * w + (ii - i0 + 1)] = 1;
    }
    return { m: m, w: w, h: h, i0: i0 - 1, j0: j0 - 1 };
  }

  /**
   * Where a watershed on the smoothed distance transform would divide a
   * footprint (4b: DATA ONLY - nothing cuts with it). The distance transform
   * is smoothed (two 3x3 means), then flooded from the top down; two basins
   * meeting at a saddle are a neck when the saddle is under `neckRatio` of
   * the smaller basin's peak (a significant maximum - markers by
   * persistence, so plateau noise is not a part).
   */
  function necksOf(cells, map, o) {
    if (cells.length < 24) return { parts: 1, necks: [] };
    var F = footMask(cells, map.nu), w = F.w, h = F.h, m = F.m;
    var g = edt(m, w, h), D = new Float64Array(w * h);
    for (var i = 0; i < g.length; i++) D[i] = m[i] ? Math.sqrt(g[i]) : 0;
    var S = D;
    for (var pass = 0; pass < 2; pass++) {
      var S2 = new Float64Array(w * h);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var p = y * w + x;
          if (!m[p]) continue;
          var sum = 0, cnt = 0;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { var q = p + dy * w + dx; if (m[q]) { sum += S[q]; cnt++; } }
          S2[p] = sum / cnt;
        }
      }
      S = S2;
    }
    var order = [];
    for (i = 0; i < w * h; i++) if (m[i]) order.push(i);
    order.sort(function (a, b) { return S[b] - S[a]; });
    var par = new Int32Array(w * h).fill(-1), peak = new Float64Array(w * h), peakAt = new Int32Array(w * h), done = new Uint8Array(w * h);
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    var necks = [];
    order.forEach(function (p) {
      done[p] = 1; par[p] = p; peak[p] = S[p]; peakAt[p] = p;
      for (var k = 0; k < 8; k++) {
        var q = p + N8y[k] * w + N8x[k];
        if (!done[q]) continue;
        var a = find(p), b = find(q);
        if (a === b) continue;
        var lo = peak[a] < peak[b] ? a : b, hi = lo === a ? b : a;
        if (S[p] <= o.neckRatio * peak[lo] && peak[lo] - S[p] >= 1) {
          var ci = p % w, cj = (p - ci) / w, gi = ci + F.i0, gj = cj + F.j0;
          necks.push({ cell: gj * map.nu + gi, widthMm: 2 * D[p] * map.cell,
            partsMm: [2 * D[peakAt[hi]] * map.cell, 2 * D[peakAt[lo]] * map.cell] });
        }
        par[lo] = hi;
      }
    });
    necks.forEach(function (nk) {
      var gi = nk.cell % map.nu, gj = (nk.cell - gi) / map.nu, hh = map.H[nk.cell];
      var u = map.u0 + (gi + 0.5) * map.cell, v = map.v0 + (gj + 0.5) * map.cell;
      nk.atMm = [0, 1, 2].map(function (a) { return u * map.e1[a] + v * map.e2[a] + hh * map.n[a]; });
      delete nk.cell;
    });
    return { parts: necks.length + 1, necks: necks };
  }

  // -------------------------------------------------------------------------
  // Strip's groups, by geometry only
  // -------------------------------------------------------------------------

  var GROUPS = [
    { key: 'dots', label: 'Small dots', words: 'compact and small (up to 16 mm² of footprint)' },
    { key: 'lines', label: 'Lines & squiggles', words: 'long and thin (at least 4 times as long as wide, at most 3 mm wide)' },
    { key: 'large', label: 'Large shapes', words: 'everything else that can be lifted' },
    { key: 'cant', label: 'Can\'t lift', words: 'found, but not liftable - each says why' }
  ];

  function groupOf(I, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    if (I.status !== 'ok') return 'cant';
    if (I.widthMm > 0 && I.widthMm <= o.lineWidthMm && I.lengthMm / I.widthMm >= o.thinRatio) return 'lines';
    if (I.areaMm2 <= o.dotAreaMm2) return 'dots';
    return 'large';
  }

  /** Footprint measures: area, width (twice the deepest inside distance),
      length (area / width). */
  function measure(cells, map) {
    var F = footMask(cells, map.nu), g = edt(F.m, F.w, F.h), mx = 0;
    for (var i = 0; i < g.length; i++) if (g[i] > mx) mx = g[i];
    var area = cells.length * map.cell * map.cell, width = 2 * Math.sqrt(mx) * map.cell;
    return { areaMm2: area, widthMm: width, lengthMm: width > 0 ? area / width : 0 };
  }


  // -------------------------------------------------------------------------
  // Assemblies: the shells a feature holds
  // -------------------------------------------------------------------------

  /** The piece's shells: triangles joined edge to edge. -> { n, of (shell per
      triangle), tris (per shell), lo, hi (per shell, [x,y,z]), open (per
      shell: an edge with no twin) }. */
  function shellsOf(M) {
    var nt = M.nt, of = new Int32Array(nt).fill(-1), n = 0, tris = [], open = [], lo = [], hi = [];
    for (var t0 = 0; t0 < nt; t0++) {
      if (of[t0] >= 0) continue;
      var q = [t0], l = [Infinity, Infinity, Infinity], h = [-Infinity, -Infinity, -Infinity], op = false;
      of[t0] = n;
      for (var i = 0; i < q.length; i++) {
        var t = q[i];
        for (var k = 0; k < 3; k++) {
          var u = M.twin(t, k);
          if (u < 0) op = true;
          else if (of[u] < 0) { of[u] = n; q.push(u); }
          var P = M.V[M.tv[t * 3 + k]];
          for (var a = 0; a < 3; a++) { if (P[a] < l[a]) l[a] = P[a]; if (P[a] > h[a]) h[a] = P[a]; }
        }
      }
      tris.push(q); lo.push(l); hi.push(h); open.push(op);
      n++;
    }
    return { n: n, of: of, tris: tris, lo: lo, hi: hi, open: open };
  }

  /** Every shell of the piece that is not the base body and that an offered
      feature holds goes with that feature: its box, inflated by captureMm,
      holds the shell's box, or the two boxes overlap (a leaf on a pin through
      a knuckle). A shell goes with ONE feature: the nearest by box centre.
      The caught shells are not fused to anything; Lift copies them as they are.
      -> islands renumbered, `islandOf` rebuilt (a caught shell's triangles
      belong to the feature), I.parts on each feature that holds any. */
  function assemble(M, seed, islands, islandOf, o) {
    var S = shellsOf(M);
    if (S.n < 2) return { shells: S.n, islands: islands, caught: 0 };
    var baseShell = S.of[seed], pad = o.captureMm, eps = 1e-9;
    // a separate shell that no feature holds is floating - said so, not as a flaw of its footprint
    islands.forEach(function (I) {
      if (I.status === 'loops' && I.tris.length && I.tris.every(function (t) { return S.of[t] !== baseShell; })) {
        I.status = 'floating'; I.reason = WHY.floating;
      }
    });
    var feats = islands.filter(function (I) { return I.status === 'ok' && S.of[I.tris[0]] === baseShell; });
    if (!feats.length) return { shells: S.n, islands: islands, caught: 0 };
    var mine = new Map();                                  // feature -> [shell]
    for (var s = 0; s < S.n; s++) {
      if (s === baseShell) continue;
      var lo = S.lo[s], hi = S.hi[s], best = null, bd = Infinity;
      feats.forEach(function (I) {
        var fl = I.bounds.lo, fh = I.bounds.hi, within = true, over = true, d = 0;
        for (var a = 0; a < 3; a++) {
          if (lo[a] < fl[a] - pad || hi[a] > fh[a] + pad) within = false;
          if (Math.min(hi[a], fh[a]) - Math.max(lo[a], fl[a]) <= eps) over = false;
          var dc = (lo[a] + hi[a]) / 2 - (fl[a] + fh[a]) / 2;
          d += dc * dc;
        }
        if ((within || over) && d < bd) { bd = d; best = I; }
      });
      if (!best) continue;
      if (!mine.has(best)) mine.set(best, []);
      mine.get(best).push(s);
    }
    var caught = new Set(), count = 0;
    mine.forEach(function (list, I) {
      if (list.some(function (sh) { return S.open[sh]; })) { I.status = 'capture'; I.reason = WHY.capture; I.group = 'cant'; return; }
      I.parts = list.map(function (sh) {
        var tr = S.tris[sh];
        return { shell: sh, tris: tr, triangles: tr.length, bounds: { lo: S.lo[sh], hi: S.hi[sh] } };
      });
      I.partCount = list.length;
      list.forEach(function (sh) { caught.add(sh); count++; });
    });
    // a free shell's own "can't be lifted" island goes with the feature that holds it
    var kept = islands.filter(function (I) {
      return !(I.tris.length && I.tris.every(function (t) { return caught.has(S.of[t]); }));
    });
    kept.forEach(function (I, i) { I.id = i; });
    islandOf.fill(-1);
    kept.forEach(function (I) { I.tris.forEach(function (t) { islandOf[t] = I.id; }); });
    kept.forEach(function (I) {
      if (!I.parts) return;
      I.parts.forEach(function (P) { P.tris.forEach(function (t) { islandOf[t] = I.id; }); });
    });
    return { shells: S.n, islands: kept, caught: count };
  }

  // -------------------------------------------------------------------------
  // analyse
  // -------------------------------------------------------------------------

  var WHY = {
    open: 'it runs into an open edge of the mesh',
    edge: 'it runs off the edge of the face, down the side of the part - it is part of the body, not a detail on the face',
    body: 'it stands round the face rather than on it - it is the body, not a detail on the face',
    loops: 'where it meets the face does not close into clean loops',
    spill: 'it runs on past the part of the face measured round it, so no one flat cut holds it',
    nobase: 'there is too little of the face round it to measure the surface it stands on',
    bends: 'the surface under it bends too much for a flat cut',
    slant: 'it is seen too slantwise from where the face was clicked to measure the surface round it - click the face nearer it',
    capture: 'a part caught in it is not a closed solid, so the assembly would not come off whole',
    floating: 'it is a separate part, joined to nothing, and no feature on the face holds it - it does not stand on the face'
  };

  function refuse(code, reason, extra) { return Object.assign({ ok: false, refused: code, reason: reason }, extra || {}); }

  function analyse(soup, seedTri, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var T0 = now(), ms = {};
    var L1 = P1();
    if (!L1 || !L1.internals) return refuse('deps', 'Lift 2 needs nso_lift.js');
    if (!soup || soup.length < 36) return refuse('empty', 'there is no mesh to lift from');
    var t = now();
    var M = o.M || index(soup);
    ms.index = now() - t;
    var seed = seedTri | 0;
    if (!(seed >= 0 && seed < M.nt)) return refuse('seed', 'that click is not on a triangle of this piece');
    if (!(M.area[seed] > 1e-9)) return refuse('seed', 'the clicked triangle has no area - click the face itself');
    var n = o.normal ? norm(o.normal) : baseNormal(M, seed, o);
    t = now();
    var map = buildMap(soup, n, o);
    ms.map = map.ms;
    var est = api.estimateBase(map, o);
    ms.base = est.ms != null ? est.ms : now() - t - map.ms;
    t = now();
    var nu = map.nu, nvv = map.nv, NN = nu * nvv, H = map.H, B = est.B, TT = map.T, cell = map.cell;
    var thr = Math.max(o.layerFloorMm, +o.thresholdMm || 0);
    var valid = function (c) { return H[c] > -Infinity; };
    // Lift 3: a base that bends is followed instead of cut flat (per island,
    // fitLocal below; the rolling-ball estimate, read anywhere, is its
    // fallback).
    var curved = !!o.curved, Bs = curved && LC() ? LC().baseSampler(map, B) : null;
    if (curved && !Bs) return refuse('deps', 'Lift 3 needs nso_lift_curved.js');
    var det = new Uint8Array(NN);
    for (var c = 0; c < NN; c++) if (H[c] > -Infinity && H[c] - B[c] > thr) det[c] = 1;

    // ---- the clicked cell ----
    var sc = centroid(M, seed);
    var si = Math.floor((dot(sc, map.e1) - map.u0) / cell), sj = Math.floor((dot(sc, map.e2) - map.v0) / cell);
    var seedCell = -1, sbest = Infinity;
    for (var dj = -2; dj <= 2; dj++) for (var di = -2; di <= 2; di++) {
      var ii = si + di, jj = sj + dj;
      if (ii < 0 || jj < 0 || ii >= nu || jj >= nvv) continue;
      var cc = jj * nu + ii;
      if (!valid(cc)) continue;
      // the clicked triangle's own cells first, then any cell of the face, then the nearest
      var dd = di * di + dj * dj + (TT[cc] === seed && !det[cc] ? -100 : det[cc] ? 50 : 0);
      if (dd < sbest) { sbest = dd; seedCell = cc; }
    }
    if (seedCell < 0) return refuse('seed', 'that click is not on a face that can be seen looking down its own normal');
    if (det[seedCell]) {
      return refuse('onDetail', 'that click is on something standing ' + fmt(H[seedCell] - B[seedCell]) +
        ' mm out of the face, not on the face itself - click the face the details stand on');
    }

    // ---- the face: base cells joined to the clicked one (4-connected) ----
    var base = new Uint8Array(NN), Q = new Int32Array(NN), qh = 0, qt = 0;
    base[seedCell] = 1; Q[qt++] = seedCell;
    while (qh < qt) {
      var p = Q[qh++], pi = p % nu, pj = (p - pi) / nu;
      for (var k = 0; k < 4; k++) {
        var ni = pi + N8x[k], nj = pj + N8y[k];
        if (ni < 0 || nj < 0 || ni >= nu || nj >= nvv) continue;
        var np = nj * nu + ni;
        if (base[np] || det[np] || !valid(np)) continue;
        base[np] = 1; Q[qt++] = np;
      }
    }
    var baseCells = qt;

    // ---- islands: 8-connected detail cells touching the face ----
    var lab = new Int32Array(NN).fill(-1), comps = [];
    for (c = 0; c < NN; c++) {
      if (!det[c] || lab[c] >= 0) continue;
      var id = comps.length, cellsL = [c], touches = false;
      lab[c] = id;
      for (var h0 = 0; h0 < cellsL.length; h0++) {
        var cp = cellsL[h0], ci = cp % nu, cj = (cp - ci) / nu;
        for (k = 0; k < 8; k++) {
          var xi = ci + N8x[k], xj = cj + N8y[k];
          if (xi < 0 || xj < 0 || xi >= nu || xj >= nvv) continue;
          var xp = xj * nu + xi;
          if (k < 4 && base[xp]) touches = true;
          if (det[xp] && lab[xp] < 0) { lab[xp] = id; cellsL.push(xp); }
        }
      }
      comps.push({ cells: cellsL, onFace: touches, holes: [] });
    }
    // ---- enclosed gaps: single cells closed, bigger ones kept as holes ----
    var hl = new Int32Array(NN).fill(-1), nHole = 0;
    for (c = 0; c < NN; c++) {
      if (det[c] || base[c] || !valid(c) || hl[c] >= 0) continue;
      var hc = [c], adj = new Set(), open = false;
      hl[c] = nHole;
      for (var h1 = 0; h1 < hc.length; h1++) {
        var hp = hc[h1], hi2 = hp % nu, hj2 = (hp - hi2) / nu;
        for (k = 0; k < 8; k++) {
          var yi = hi2 + N8x[k], yj = hj2 + N8y[k];
          if (yi < 0 || yj < 0 || yi >= nu || yj >= nvv) { open = true; continue; }
          var yp = yj * nu + yi;
          if (!valid(yp)) { open = true; continue; }
          if (det[yp]) { adj.add(lab[yp]); continue; }
          if (k < 4 && !base[yp] && hl[yp] < 0) { hl[yp] = nHole; hc.push(yp); }
        }
      }
      nHole++;
      if (open || adj.size !== 1) continue;
      var ownerId = adj.values().next().value, owner = comps[ownerId];
      if (!owner.onFace) continue;
      if (hc.length <= o.holeCells) {
        hc.forEach(function (x) { det[x] = 1; lab[x] = ownerId; owner.cells.push(x); });
        owner.closed = (owner.closed || 0) + hc.length;
      } else owner.holes.push(hc);
    }
    var mapIslands = comps.filter(function (C) { return C.onFace; });

    // ---- near anything standing out (excluded from base samples) ----
    var Kf = Math.max(2, Math.ceil(o.fringeMm / cell)), K = Kf + Math.max(4, Math.ceil(o.ringMm / cell));
    var near = new Uint8Array(NN), dist = new Uint8Array(NN);
    qh = 0; qt = 0;
    for (c = 0; c < NN; c++) if (det[c]) { near[c] = 1; Q[qt++] = c; }
    while (qh < qt) {
      var a0 = Q[qh++], ai = a0 % nu, aj = (a0 - ai) / nu;
      if (dist[a0] >= Kf) continue;
      for (k = 0; k < 8; k++) {
        var bi = ai + N8x[k], bj = aj + N8y[k];
        if (bi < 0 || bj < 0 || bi >= nu || bj >= nvv) continue;
        var bp = bj * nu + bi;
        if (near[bp]) continue;
        near[bp] = 1; dist[bp] = dist[a0] + 1; Q[qt++] = bp;
      }
    }

    // ---- per island: ring, plane, then the real triangles ----
    var nV = M.nv, VX = M.VX, tv = M.tv;
    var VU = new Float64Array(nV), VVv = new Float64Array(nV);
    for (var v = 0; v < nV; v++) {
      VU[v] = VX[v * 3] * map.e1[0] + VX[v * 3 + 1] * map.e1[1] + VX[v * 3 + 2] * map.e1[2];
      VVv[v] = VX[v * 3] * map.e2[0] + VX[v * 3 + 1] * map.e2[1] + VX[v * 3 + 2] * map.e2[2];
    }
    function cellOfV(vi) {
      var i = Math.floor((VU[vi] - map.u0) / cell), j = Math.floor((VVv[vi] - map.v0) / cell);
      return (i < 0 || j < 0 || i >= nu || j >= nvv) ? -1 : j * nu + i;
    }
    var stamp = new Int32Array(NN), gen = 0, sd = new Uint8Array(NN);
    var sStamp = new Int32Array(nV), sVal = new Float64Array(nV), sGen = 0;
    var owner2 = new Int32Array(M.nt).fill(-1);
    var flatTol = 0.001 + 2e-6 * M.scale;
    // Lift 3: a vertex's height over an island's curved base T(u, v), along
    // the view. Where T cannot be read (off the surface): far below.
    function curvedS(T, cur) {
      return function (vi) {
        if (cur != null && sStamp[vi] === cur) return sVal[vi];
        var b = T(VU[vi], VVv[vi]);
        var x = b === b ? VX[vi * 3] * map.n[0] + VX[vi * 3 + 1] * map.n[1] + VX[vi * 3 + 2] * map.n[2] - b : -Infinity;
        if (cur != null) { sStamp[vi] = cur; sVal[vi] = x; }
        return x;
      };
    }

    function ringAndPlane(G) {
      var st = ++gen; qh = 0; qt = 0;
      var srcs = G.cells.concat(G.extra || []);
      G.holes.forEach(function (hc) { hc.forEach(function (x) { srcs.push(x); }); });
      srcs.forEach(function (x) { if (stamp[x] !== st) { stamp[x] = st; sd[x] = 0; Q[qt++] = x; } });
      var su = 0, sv = 0, n0 = 0;
      G.cells.forEach(function (x) { su += x % nu; sv += (x - x % nu) / nu; n0++; });
      var ic = su / n0, jc = sv / n0;
      var S = { n: 0, u: 0, v: 0, uu: 0, uv: 0, vv: 0, h: 0, uh: 0, vh: 0 }, ring = [];
      var cand = [];
      while (qh < qt) {
        var x = Q[qh++], xi = x % nu, xj = (x - xi) / nu;
        if (base[x] && !map.steep[x] && sd[x] > 0) cand.push(x);
        if (sd[x] >= K) continue;
        for (var kk = 0; kk < 8; kk++) {
          var yi2 = xi + N8x[kk], yj2 = xj + N8y[kk];
          if (yi2 < 0 || yj2 < 0 || yi2 >= nu || yj2 >= nvv) continue;
          var y = yj2 * nu + yi2;
          if (stamp[y] === st || !valid(y)) continue;
          stamp[y] = st; sd[y] = sd[x] + 1; Q[qt++] = y;
        }
      }
      // The base samples: cells of the face where the surface and the base
      // estimate agree (so not a speck too low to be a detail, nor a step's
      // edge), clear of anything standing out - as clean and as clear as
      // there are enough of.
      var tiers = [o.cleanMm, 2.5 * o.cleanMm, thr], need = Kf, ti = 0;
      search: for (ti = 0; ti < tiers.length; ti++) {
        for (need = Kf; need >= 1; need--) {
          var ct = tiers[ti], nd = need;
          ring = cand.filter(function (x2) { return (!near[x2] || dist[x2] > nd) && H[x2] - B[x2] <= ct; });
          if (ring.length >= 12) break search;
        }
      }
      G.ringClear = need; G.ringCleanMm = tiers[Math.min(ti, tiers.length - 1)];
      G.stamp = st;
      ring.forEach(function (x) {
        var u = ((x % nu) - ic) * cell, w = (((x - x % nu) / nu) - jc) * cell, h = H[x];
        S.n++; S.u += u; S.v += w; S.uu += u * u; S.uv += u * w; S.vv += w * w; S.h += h; S.uh += u * h; S.vh += w * h;
      });
      G.ringCells = ring.length;
      if (ring.length < 6) { G.status = 'nobase'; return; }
      // least squares h = a u + b v + c (u, v from the footprint's middle)
      var A3 = [[S.uu, S.uv, S.u], [S.uv, S.vv, S.v], [S.u, S.v, S.n]], b3 = [S.uh, S.vh, S.h];
      var sol = solve3(A3, b3);
      if (!sol) { G.status = 'nobase'; return; }
      var aa = sol[0], bb = sol[1], c0 = sol[2];
      if (Math.abs(aa) < 1e-12 && Math.abs(bb) < 1e-12) { aa = 0; bb = 0; c0 = S.h / S.n; }
      var bend = 0;
      ring.forEach(function (x) {
        var u = ((x % nu) - ic) * cell, w = (((x - x % nu) / nu) - jc) * cell;
        var r = Math.abs(H[x] - (aa * u + bb * w + c0));
        if (r > bend) bend = r;
      });
      G.bendMm = bend;
      var uc = map.u0 + (ic + 0.5) * cell, vc = map.v0 + (jc + 0.5) * cell;
      var Nw = [0, 1, 2].map(function (q) { return -aa * map.e1[q] - bb * map.e2[q] + map.n[q]; });
      Nw = norm(Nw);
      if (aa === 0 && bb === 0) Nw = map.n.slice();
      var P0 = [0, 1, 2].map(function (q) { return uc * map.e1[q] + vc * map.e2[q] + c0 * map.n[q]; });
      G.plane = { n: Nw, d: dot(P0, Nw) };
      if (curved && bend > flatTol) {
        // Lift 3: not one flat plane, so the base is followed: the surround
        // (where the rolling ball touches the surface round the footprint)
        // fitted with local quadratics and carried across (fitLocal). The
        // ball's own curve under the detail is not used - on a convex surface
        // it dips under. Where the quadratics fit the surround clearly worse
        // than the ball does, the ball's base itself. The samples: the whole
        // band round the footprint, clear of anything standing out (not only
        // its cleanest cells, which on rough paper are its lower envelope).
        var nd3 = need, band = cand.filter(function (x2) { return !near[x2] || dist[x2] > nd3; });
        if (band.length < 15) band = ring;
        var off = 0, sq = 0;
        band.forEach(function (x) { var r2 = H[x] - B[x]; sq += r2 * r2; if (Math.abs(r2) > off) off = Math.abs(r2); });
        G.curved = true; G.ringOffMm = off; G.ringRmsMm = Math.sqrt(sq / band.length);
        G.surroundMm2 = band.length * cell * cell;
        G.slantDeg = Math.acos(Math.max(-1, Math.min(1, dot(Nw, map.n)))) * 180 / Math.PI;
        if (G.slantDeg > o.slantDeg) {
          // too slantwise to cut along: found against its own plane, as
          // Lift 2 finds it (so a speck with nothing on it stays map-only),
          // shown, never cut
          G.curved = false; G.status = 'slant';
          G.tolA = Math.min(bend, o.bendTolMm) + o.marginMm + flatTol;
          return;
        }
        var qf = fitLocal(band);
        G.fitRmsMm = qf ? qf.rms : NaN; G.fitOffMm = qf ? qf.max : NaN;
        if (qf && qf.rms <= 2 * G.ringRmsMm + o.marginMm) {
          G.baseKind = 'fit'; G.baseOffMm = qf.max; G.T = qf.T;
        } else {
          G.baseKind = 'ball'; G.baseOffMm = off; G.T = Bs;
        }
        // The band that counts as on the base: the surround's spread about it,
        // three times its rms (its worst cell understates the vertices: the
        // map reads between them), kept under the detection threshold - what
        // stands out more than that is a detail.
        G.tolA = Math.min(3 * (G.baseKind === 'fit' ? G.fitRmsMm : G.ringRmsMm), 0.75 * thr) + o.marginMm + flatTol;
        return;
      }
      G.curved = false;
      G.tolA = Math.min(bend, o.bendTolMm) + o.marginMm + flatTol;
      if (bend > o.bendTolMm) G.status = 'bends';
    }

    /** The base carried across a curved footprint: quadratics h = a u^2 +
        b uv + c v^2 + d u + e v + f fitted by least squares to the ring's
        samples (the surround, where the rolling ball touches it), each at a
        node of a lattice fitSigmaMm / 2 apart, its samples weighted by
        exp(-r^2 / 2 sigma^2) from the node; read anywhere as the nodes'
        own quadratics blended bilinearly. One quadratic over a long
        footprint would not hold a cylinder's arc; the ball's own curve
        under a detail dips under a convex surface. Null when the ring
        cannot hold it. */
    function fitLocal(ring) {
      if (ring.length < 15) return null;
      var sg = o.fitSigmaMm, step = sg / 2, cut2 = 9 * sg * sg, inv2 = 1 / (2 * sg * sg);
      var SU = [], SV = [], SH = [], ulo = Infinity, uhi = -Infinity, vlo = Infinity, vhi = -Infinity;
      ring.forEach(function (x) {
        var i = x % nu, u = map.u0 + (i + 0.5) * cell, v = map.v0 + ((x - i) / nu + 0.5) * cell;
        SU.push(u); SV.push(v); SH.push(H[x]);
        if (u < ulo) ulo = u; if (u > uhi) uhi = u; if (v < vlo) vlo = v; if (v > vhi) vhi = v;
      });
      var gw = Math.max(2, Math.ceil((uhi - ulo) / step) + 1), gh = Math.max(2, Math.ceil((vhi - vlo) / step) + 1);
      var C = new Array(gw * gh), Nn = SU.length, bad = 0;
      for (var gj = 0; gj < gh; gj++) {
        for (var gi = 0; gi < gw; gi++) {
          var nu0 = ulo + gi * step, nv0 = vlo + gj * step, A6 = [], b6 = [0, 0, 0, 0, 0, 0], k6, sw = 0;
          for (k6 = 0; k6 < 6; k6++) A6.push([0, 0, 0, 0, 0, 0]);
          for (var q = 0; q < Nn; q++) {
            var x = (SU[q] - nu0) / sg, y = (SV[q] - nv0) / sg, r2 = (x * x + y * y) * sg * sg;
            if (r2 > cut2) continue;
            var w = Math.exp(-r2 * inv2), f = [x * x, x * y, y * y, x, y, 1];
            sw += w;
            for (var a = 0; a < 6; a++) { var wf = w * f[a]; b6[a] += wf * SH[q]; for (var b2 = 0; b2 <= a; b2++) A6[a][b2] += wf * f[b2]; }
          }
          for (a = 0; a < 6; a++) for (b2 = a + 1; b2 < 6; b2++) A6[a][b2] = A6[b2][a];
          var c6 = sw > 0 ? solveN(A6, b6, 1e-7 * sw) : null;
          if (!c6) { bad++; C[gj * gw + gi] = null; continue; }
          C[gj * gw + gi] = [c6[0] / (sg * sg), c6[1] / (sg * sg), c6[2] / (sg * sg), c6[3] / sg, c6[4] / sg, c6[5], nu0, nv0];
        }
      }
      // a node the ring cannot hold borrows its nearest neighbour's quadratic
      if (bad === C.length) return null;
      for (var pass = 0; bad && pass < gw + gh; pass++) {
        var C2 = C.slice();
        for (gj = 0; gj < gh; gj++) for (gi = 0; gi < gw; gi++) {
          if (C[gj * gw + gi]) continue;
          for (var k = 0; k < 4; k++) {
            var ii = gi + N8x[k], jj = gj + N8y[k];
            if (ii < 0 || jj < 0 || ii >= gw || jj >= gh || !C[jj * gw + ii]) continue;
            C2[gj * gw + gi] = C[jj * gw + ii]; bad--; break;
          }
        }
        C = C2;
      }
      function T(U, V) {
        var fx = (U - ulo) / step, fy = (V - vlo) / step;
        var x0 = Math.max(0, Math.min(gw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(gh - 2, Math.floor(fy)));
        var tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0)), sum = 0;
        for (var k2 = 0; k2 < 4; k2++) {
          var c = C[(y0 + (k2 >> 1)) * gw + x0 + (k2 & 1)], du = U - c[6], dv = V - c[7];
          var wt = ((k2 & 1) ? tx : 1 - tx) * ((k2 >> 1) ? ty : 1 - ty);
          sum += wt * (c[0] * du * du + c[1] * du * dv + c[2] * dv * dv + c[3] * du + c[4] * dv + c[5]);
        }
        return sum;
      }
      var mx = 0, ss = 0;
      for (q = 0; q < Nn; q++) { var rr = SH[q] - T(SU[q], SV[q]); ss += rr * rr; if (Math.abs(rr) > mx) mx = Math.abs(rr); }
      return { T: T, rms: Math.sqrt(ss / Nn), max: mx, nodes: gw * gh };
    }

    function grow(G, me) {
      var cur = ++sGen, N0 = G.plane.n, d0 = G.plane.d, tolA = G.tolA, st = G.stamp;
      var s = G.curved ? curvedS(G.T, cur) : function (vi) {
        if (sStamp[vi] !== cur) { sStamp[vi] = cur; sVal[vi] = VX[vi * 3] * N0[0] + VX[vi * 3 + 1] * N0[1] + VX[vi * 3 + 2] * N0[2] - d0; }
        return sVal[vi];
      };
      function cls(tt) {
        var x = s(tv[tt * 3]), y = s(tv[tt * 3 + 1]), z = s(tv[tt * 3 + 2]);
        var mn = Math.min(x, y, z), mx = Math.max(x, y, z);
        if (mn < -tolA) return BELOW;
        if (mx <= tolA) return BASE;
        return ABOVE;
      }
      function allowed(tt) {
        for (var q = 0; q < 3; q++) { var cq = cellOfV(tv[tt * 3 + q]); if (cq < 0 || stamp[cq] !== st) return false; }
        return true;
      }
      var list = [], merges = new Set(), spills = [];
      G.s = s; G.cls = cls;
      G.cells.forEach(function (x) {
        var tt = TT[x];
        if (tt < 0 || owner2[tt] === me) return;
        if (owner2[tt] >= 0) { merges.add(owner2[tt]); return; }
        if (cls(tt) !== ABOVE || !allowed(tt)) return;
        owner2[tt] = me; list.push(tt);
      });
      for (var li = 0; li < list.length; li++) {
        var tt = list[li];
        for (var kk = 0; kk < 3; kk++) {
          var va = tv[tt * 3 + kk], vb = tv[tt * 3 + (kk + 1) % 3];
          if (Math.abs(s(va)) <= tolA && Math.abs(s(vb)) <= tolA) continue;
          var u = M.twin(tt, kk);
          if (u < 0) continue;
          if (owner2[u] === me) continue;
          if (owner2[u] >= 0) { merges.add(owner2[u]); continue; }
          if (cls(u) !== ABOVE) continue;
          if (!allowed(u)) { spills.push(u); continue; }
          owner2[u] = me; list.push(u);
        }
      }
      G.tris = list;
      return { merges: merges, spills: spills };
    }

    // Pass: every island its ring, plane and triangles. Islands whose real
    // triangles run into each other are one body: merged, measured again.
    var groups = mapIslands.map(function (C, i) { return { cells: C.cells, holes: C.holes, closed: C.closed || 0, members: [i] }; });
    var live = groups.map(function (_, i) { return i; });
    var todo = live.slice();
    for (var round = 0; round < 8 + o.widenRounds && todo.length; round++) {
      var merge = [], spilled = [];
      todo.forEach(function (gi) {
        var G = groups[gi];
        G.status = null;
        ringAndPlane(G);
        if (G.status === 'slant') { grow(G, gi); return; }
        if (G.status === 'nobase' || G.status === 'bends') {
          // shown, not cut: the cells' own top triangles
          var seen = new Set();
          G.tris = [];
          G.cells.forEach(function (x) { var tt = TT[x]; if (tt >= 0 && owner2[tt] < 0 && !seen.has(tt)) { seen.add(tt); G.tris.push(tt); } });
          G.tris.forEach(function (tt) { owner2[tt] = gi; });
          return;
        }
        var gr = grow(G, gi);
        gr.merges.forEach(function (other) { merge.push([gi, other]); });
        if (gr.spills.length && (G.widened || 0) < o.widenRounds) {
          // the body runs on past the measured ring: measure further and grow again
          G.widened = (G.widened || 0) + 1;
          G.extra = G.extra || [];
          gr.spills.forEach(function (tt) { for (var q = 0; q < 3; q++) { var cq = cellOfV(tv[tt * 3 + q]); if (cq >= 0) G.extra.push(cq); } });
          spilled.push(gi);
        }
      });
      if (!merge.length && !spilled.length) break;
      spilled.forEach(function (gi) {
        if (merge.some(function (pr) { return pr[0] === gi || pr[1] === gi; })) return;
        (groups[gi].tris || []).forEach(function (tt) { if (owner2[tt] === gi) owner2[tt] = -1; });
      });
      // union, then release the merged groups' triangles and measure again
      var par = {};
      function fd(a) { while (par[a] != null && par[a] !== a) a = par[a]; return a; }
      merge.forEach(function (pr) { var a = fd(pr[0]), b = fd(pr[1]); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); });
      var into = {};
      live.forEach(function (gi) { var r0 = fd(gi); if (r0 !== gi) (into[r0] = into[r0] || []).push(gi); });
      todo = [];
      Object.keys(into).forEach(function (r0) {
        r0 = +r0;
        var G0 = groups[r0];
        [r0].concat(into[r0]).forEach(function (gi) {
          (groups[gi].tris || []).forEach(function (tt) { if (owner2[tt] === gi) owner2[tt] = -1; });
          if (gi === r0) return;
          var Gx = groups[gi];
          G0.cells = G0.cells.concat(Gx.cells); G0.holes = G0.holes.concat(Gx.holes);
          G0.members = G0.members.concat(Gx.members); G0.closed += Gx.closed;
          G0.extra = (G0.extra || []).concat(Gx.extra || []);
          Gx.dead = true;
        });
        todo.push(r0);
      });
      spilled.forEach(function (gi) { if (!groups[gi].dead && todo.indexOf(gi) < 0 && todo.indexOf(fd(gi)) < 0) todo.push(gi); });
      live = live.filter(function (gi) { return !groups[gi].dead; });
    }

    // ---- final islands: each body its own, measured and judged ----
    var islands = [], islandOf = new Int32Array(M.nt).fill(-1), ghosts = 0;
    var fr0 = L1.internals.planeFrame;
    live.forEach(function (gi) {
      var G = groups[gi];
      if (!G.tris || !G.tris.length) { ghosts++; return; }
      var comps2 = [];
      if (G.status === 'nobase' || G.status === 'bends' || G.status === 'slant') comps2 = [G.tris];
      else {
        var cmp = new Map();
        G.tris.forEach(function (tt) {
          if (cmp.has(tt)) return;
          var part = [tt], idc = comps2.length;
          cmp.set(tt, idc);
          for (var q = 0; q < part.length; q++) {
            var x = part[q];
            for (var kk = 0; kk < 3; kk++) {
              var va = tv[x * 3 + kk], vb = tv[x * 3 + (kk + 1) % 3];
              if (Math.abs(G.s(va)) <= G.tolA && Math.abs(G.s(vb)) <= G.tolA) continue;
              var u = M.twin(x, kk);
              if (u >= 0 && owner2[u] === gi && !cmp.has(u)) { cmp.set(u, idc); part.push(u); }
            }
          }
          comps2.push(part);
        });
      }
      comps2.forEach(function (tris) {
        var I = { id: islands.length, tris: tris, triangles: tris.length, mapCells: G.cells.length, closedCells: G.closed,
                  bendMm: G.bendMm, ringCells: G.ringCells, ringClear: G.ringClear, ringCleanMm: G.ringCleanMm, widened: G.widened || 0 };
        if (G.slantDeg != null) I.slantDeg = G.slantDeg;
        if (G.curved) {
          I.curved = true; I.ringOffMm = G.ringOffMm; I.ringRmsMm = G.ringRmsMm;
          I.baseKind = G.baseKind; I.baseOffMm = G.baseOffMm; I.fitRmsMm = G.fitRmsMm; I.base = G.T; I.sBase = curvedS(G.T, null);
          I.surroundMm2 = G.surroundMm2; I.roughMm = G.baseKind === 'fit' ? G.fitRmsMm : G.ringRmsMm;
        }
        tris.forEach(function (tt) { islandOf[tt] = I.id; });
        islands.push(I);
        I.status = G.status || null;
        if (G.plane) {
          I.plane = { n: G.plane.n, d: G.plane.d, tolMm: G.tolA };
          // Lift 3: a curved island's loops and fill are read looking down the view
          I.frame = G.curved ? { e1: map.e1, e2: map.e2, n: map.n } : fr0(G.plane.n);
        }
        if (!I.status) judge(I, G);
      });
    });
    function judge(I, G) {
      var inI = function (tt) { return islandOf[tt] === I.id; };
      var why = null;
      for (var q = 0; q < I.tris.length && !why; q++) {
        var tt = I.tris[q];
        for (var kk = 0; kk < 3; kk++) {
          var u = M.twin(tt, kk);
          if (u >= 0 && inI(u)) continue;
          if (u < 0) { why = 'open'; break; }
          var va = tv[tt * 3 + kk], vb = tv[tt * 3 + (kk + 1) % 3];
          var inPlane = Math.abs(G.s(va)) <= G.tolA && Math.abs(G.s(vb)) <= G.tolA;
          var cu = G.cls(u);
          if (cu === BELOW) { why = 'edge'; break; }
          if (!inPlane) { why = 'spill'; break; }
        }
      }
      if (!why) {
        I.loops = L1.internals.boundaryLoops(M, I.tris, inI, I.frame);
        if (I.loops.some(function (Lp) { return Lp.broken; })) why = 'loops';
      }
      if (!why) {
        var big = null, ra = 0;
        I.loops.forEach(function (Lp) { ra += Lp.area; if (!big || Math.abs(Lp.area) > Math.abs(big.area)) big = Lp; });
        I.rootAreaMm2 = ra;
        if (!big) why = 'loops';
        else if (!(big.area > 0)) why = 'body';
        else if (!(ra > 0)) why = 'loops';
      }
      if (!why) {
        // The cut itself: the plane refitted to the island's own root (the
        // base where it actually meets it); refused if that root is not flat
        // within the tolerance.
        var fit = rootPlane(I, G);
        I.rootBendMm = fit.bend;
        I.bendMm = Math.max(I.bendMm || 0, fit.bend);
        I.plane = { n: fit.n, d: fit.d, tolMm: G.tolA };
        if (G.curved) I.fill = 'curved';               // Lift 3: cut along the base, whatever it bends
        else {
          I.frame = L1.internals.planeFrame(fit.n);
          if (fit.bend > o.bendTolMm) why = 'bends';
        }
      }
      I.status = why || 'ok';
    }
    function rootPlane(I, G) {
      var fr = L1.internals.planeFrame(G.plane.n), seenR = new Set(), pts = [];
      I.loops.forEach(function (Lp) { Lp.verts.forEach(function (vi) { if (!seenR.has(vi)) { seenR.add(vi); pts.push(M.V[vi]); } }); });
      var S = { n: 0, u: 0, v: 0, uu: 0, uv: 0, vv: 0, h: 0, uh: 0, vh: 0 }, U = [], Vv = [], Wv = [];
      pts.forEach(function (P) { U.push(dot(P, fr.e1)); Vv.push(dot(P, fr.e2)); Wv.push(dot(P, fr.n)); });
      var mu = 0, mv = 0;
      U.forEach(function (x, i) { mu += x; mv += Vv[i]; });
      mu /= pts.length; mv /= pts.length;
      U.forEach(function (x, i) {
        var u = x - mu, v = Vv[i] - mv, h = Wv[i];
        S.n++; S.u += u; S.v += v; S.uu += u * u; S.uv += u * v; S.vv += v * v; S.h += h; S.uh += u * h; S.vh += v * h;
      });
      var sol = solve3([[S.uu, S.uv, S.u], [S.uv, S.vv, S.v], [S.u, S.v, S.n]], [S.uh, S.vh, S.h]);
      var aa = sol ? sol[0] : 0, bb = sol ? sol[1] : 0, c0 = sol ? sol[2] : S.h / S.n;
      if (Math.abs(aa) < 1e-12 && Math.abs(bb) < 1e-12) { aa = 0; bb = 0; c0 = S.h / S.n; }
      var bend = 0;
      U.forEach(function (x, i) { var r = Math.abs(Wv[i] - (aa * (x - mu) + bb * (Vv[i] - mv) + c0)); if (r > bend) bend = r; });
      if (aa === 0 && bb === 0) return { n: G.plane.n, d: c0, bend: bend };
      var N1 = norm([0, 1, 2].map(function (q) { return -aa * fr.e1[q] - bb * fr.e2[q] + fr.n[q]; }));
      var P0 = [0, 1, 2].map(function (q) { return mu * fr.e1[q] + mv * fr.e2[q] + c0 * fr.n[q]; });
      return { n: N1, d: dot(P0, N1), bend: bend };
    }

    // heights, bounds, footprints, groups, necks
    var foot = islands.map(function () { return []; });
    for (c = 0; c < NN; c++) { var tt = TT[c]; if (tt >= 0 && islandOf[tt] >= 0) foot[islandOf[tt]].push(c); }
    islands.forEach(function (I) {
      var h = 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], seenV = new Set();
      var Np = I.plane ? I.plane.n : map.n, dp = I.plane ? I.plane.d : 0;
      I.tris.forEach(function (tt) {
        for (var kk = 0; kk < 3; kk++) {
          var vi = tv[tt * 3 + kk];
          if (seenV.has(vi)) continue;
          seenV.add(vi);
          var P = M.V[vi];
          if (I.curved) { var sc2 = I.sBase(vi); if (sc2 > h) h = sc2; }
          else if (I.plane) { var sv2 = dot(P, Np) - dp; if (sv2 > h) h = sv2; }
          for (var q = 0; q < 3; q++) { if (P[q] < lo[q]) lo[q] = P[q]; if (P[q] > hi[q]) hi[q] = P[q]; }
        }
      });
      if (!I.plane || (I.curved && I.status !== 'ok')) {
        // no plane to stand on (or a curved base read only round a body that
        // cannot come off): how far the map says it stands out
        h = 0;
        foot[I.id].forEach(function (x) { if (H[x] - B[x] > h) h = H[x] - B[x]; });
      }
      I.heightMm = h;
      I.bounds = { lo: lo, hi: hi };
      I.center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      I.footCells = foot[I.id].length;
      var mz = foot[I.id].length ? measure(foot[I.id], map) : { areaMm2: 0, widthMm: 0, lengthMm: 0 };
      I.areaMm2 = mz.areaMm2; I.widthMm = mz.widthMm; I.lengthMm = mz.lengthMm;
      I.reason = I.status === 'ok' ? null : I.status === 'bends'
        ? WHY.bends + ' (it is ' + fmt(I.bendMm) + ' mm off one flat plane ' + (I.rootBendMm > o.bendTolMm ? 'where it meets the face' : 'across its footprint') +
          '; a flat cut allows ' + fmt(o.bendTolMm) + ' mm)'
        : WHY[I.status];
      if (I.status === 'slant') {
        I.reason = WHY.slant + ' (its surround leans ' + fmt(I.slantDeg, 0) + '° off the view; ' + fmt(o.slantDeg, 0) + '° is the most it reads)';
      }
      I.group = groupOf(I, o);
      I.necks = I.areaMm2 > o.dotAreaMm2 ? necksOf(foot[I.id], map, o) : { parts: 1, necks: [] };
      if (I.status === 'ok' && I.fill === 'curved') I.fillNotes = fillNotes(I, o);
    });
    ms.islands = now() - t;

    // assemblies: the free shells a feature holds go with it
    var asm = assemble(M, seed, islands, islandOf, o);
    islands = asm.islands;

    // the face, for the tint: its cells' own top triangles
    var baseList = [], seenB = new Uint8Array(M.nt);
    for (c = 0; c < NN; c++) {
      if (!base[c]) continue;
      var bt = TT[c];
      if (bt >= 0 && islandOf[bt] < 0 && !seenB[bt]) { seenB[bt] = 1; baseList.push(bt); }
    }
    var counts = { dots: 0, lines: 0, large: 0, cant: 0 };
    islands.forEach(function (I) { counts[I.group]++; });
    var A = {
      ok: true, kind: 'map', M: M, seed: seed, islands: islands, islandOf: islandOf, curved: curved, relaxMm: o.relaxMm,
      liftable: islands.filter(function (I) { return I.status === 'ok'; }).length,
      plane: { n: map.n, d: H[seedCell], tolMm: thr },
      base: { tris: baseList.length, list: baseList, areaMm2: baseCells * cell * cell, cells: baseCells },
      map: { cellMm: cell, size: [nu, nvv], cells: NN, coarsened: map.coarsened, normal: map.n,
             ballMm: est.radiusMm, ballCoarseMm: est.coarseMm, thresholdMm: thr, grid: map, B: B, det: det,
             baseMask: base, seedCell: seedCell, mapIslands: mapIslands.length, ghosts: ghosts, words: est.words, sampler: Bs },
      groups: counts, shells: asm.shells, caught: asm.caught,
      ms: Object.assign(ms, { total: now() - T0 })
    };
    A.reason = describe(A, o);
    return A;
  }

  /** Lift 3's honest ceiling, in words: where the fill matches the
      surroundings at the rim but has nothing measured to follow inside. Said,
      never refused. */
  function fillNotes(I, o) {
    var out = [], tag = 'detail ' + (I.id + 1);
    if (I.areaMm2 > I.surroundMm2) {
      out.push(tag + ' covers ' + fmt(I.areaMm2, 1) + ' mm², more than the ' + fmt(I.surroundMm2, 1) + ' mm² of clear surface measured ' +
        'round it: across its middle the surface carried under it is the base fitted to that surround - it matches what is round it, ' +
        'it cannot show what was under the detail');
    }
    if (I.baseKind === 'ball') {
      out.push('the surface round ' + tag + ' is not one smooth curve (smooth quadratic surfaces fitted to it miss it by ' + fmt(I.fitRmsMm, 3) +
        ' mm on average, the rolling-ball base by ' + fmt(I.ringRmsMm, 3) + ' mm): the fill relaxes to the rolling-ball base across it');
    }
    if (I.roughMm > o.cleanMm / 2) {
      out.push('the surface round ' + tag + ' is rough (' + fmt(I.roughMm, 3) + ' mm rms about the smooth surface fitted to it): the fill ' +
        'meets it at the rim and runs smooth across - the roughness is not made up under it');
    }
    return out;
  }

  /** A small dense system by Gauss-Jordan with partial pivots; null when a
      pivot is under eps. */
  function solveN(A, b, eps) {
    var n = b.length, m = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var p = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (!(Math.abs(m[p][c]) > eps)) return null;
      var tmp = m[c]; m[c] = m[p]; m[p] = tmp;
      for (r = 0; r < n; r++) {
        if (r === c) continue;
        var f = m[r][c] / m[c][c];
        for (var k = c; k <= n; k++) m[r][k] -= f * m[c][k];
      }
    }
    return m.map(function (row, i) { return row[n] / row[i]; });
  }

  function solve3(A, b) {
    var m = [A[0].concat([b[0]]), A[1].concat([b[1]]), A[2].concat([b[2]])];
    for (var c = 0; c < 3; c++) {
      var p = c;
      for (var r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < 1e-12 * Math.max(1, Math.abs(m[0][0]) + Math.abs(m[1][1]) + Math.abs(m[2][2]))) return null;
      var tmp = m[c]; m[c] = m[p]; m[p] = tmp;
      for (r = 0; r < 3; r++) {
        if (r === c) continue;
        var f = m[r][c] / m[c][c];
        for (var k = c; k < 4; k++) m[r][k] -= f * m[c][k];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }

  function describe(A, o) {
    var I = A.islands, ok = I.filter(function (x) { return x.status === 'ok'; });
    var why = {};
    I.forEach(function (x) { if (x.status !== 'ok') why[x.status] = (why[x.status] || 0) + 1; });
    var s = 'Read as a height map looking down the face (' + fmt(A.map.cellMm) + ' mm per cell' +
      (A.map.coarsened ? ' - ' + A.map.coarsened : '') + '); the base under the details is ' + A.map.words +
      '; anything more than ' + fmt(A.map.thresholdMm) + ' mm above it is a detail. ' +
      plural(I.length, 'detail') + ' found: ' + ok.length + ' can be lifted';
    var parts = Object.keys(why).map(function (k) { return why[k] + ' ' + (k === 'bends' ? WHY.bends : WHY[k]); });
    if (parts.length) s += '; ' + parts.join('; ');
    return s + '.';
  }

  /** Liftable, and standing out MORE than minHeight - Phase 1's rule. */
  function offered(A, minHeight) {
    if (!A || !A.ok) return [];
    var h = +minHeight || 0;
    return A.islands.filter(function (I) { return I.status === 'ok' && I.heightMm > h; }).map(function (I) { return I.id; });
  }

  // -------------------------------------------------------------------------
  // Lift and Remove: each island at its own plane, the caps the cut engine's
  // -------------------------------------------------------------------------

  /**
   * The cut engine's cap, made fit for a root that is not exactly flat. The
   * corners and the outline stay rawFlatCapLoops' own; only how the inside
   * is joined changes:
   *   1. an island corner that touches the cap's plane INSIDE the root (a
   *      pinhole down to the base, where shapes meet) becomes a corner of the
   *      cap, so the piece meets itself there at a shared corner instead of
   *      a corner pressed into the middle of a cap triangle;
   *   2. inside edges are flipped toward Delaunay (Lawson), so the cap is no
   *      long slivers: across a root that steps or bends, a sliver along one
   *      side climbs over the walls standing on the other.
   * On a flat root with nothing touching inside, a cap the ear-clipper made
   * well-shaped comes back as it was.
   */
  function refineCap(cp, I, M, touch) {
    var fr = I.frame, n = I.plane.n, d = I.plane.d, tol = I.plane.tolMm;
    var key = new Map(), P = [], X = [], Y = [];
    function vid(x, y, z) {
      var k = x + ',' + y + ',' + z, id = key.get(k);
      if (id == null) {
        id = P.length; key.set(k, id); P.push([x, y, z]);
        X.push(x * fr.e1[0] + y * fr.e1[1] + z * fr.e1[2]); Y.push(x * fr.e2[0] + y * fr.e2[1] + z * fr.e2[2]);
      }
      return id;
    }
    var T = [];
    for (var c = 0; c < cp.length; c += 9) T.push([vid(cp[c], cp[c + 1], cp[c + 2]), vid(cp[c + 3], cp[c + 4], cp[c + 5]), vid(cp[c + 6], cp[c + 7], cp[c + 8])]);
    var loopV = P.length;
    function orient(a, b, q) { return (X[b] - X[a]) * (Y[q] - Y[a]) - (Y[b] - Y[a]) * (X[q] - X[a]); }
    // 1. island corners on the plane, inside the root
    var cand = new Set();
    I.tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var q = M.V[M.tv[t * 3 + k]];
        if (Math.abs(q[0] * n[0] + q[1] * n[1] + q[2] * n[2] - d) <= tol && !key.has(q[0] + ',' + q[1] + ',' + q[2])) cand.add(M.tv[t * 3 + k]);
      }
    });
    var contacts = [];
    cand.forEach(function (vi) {
      var q = M.V[vi], id = vid(q[0], q[1], q[2]);
      for (var i = 0; i < T.length; i++) {
        var a = T[i][0], b = T[i][1], e = T[i][2];
        var o1 = orient(a, b, id), o2 = orient(b, e, id), o3 = orient(e, a, id);
        if (o1 >= 0 && o2 >= 0 && o3 >= 0) {
          if (touch && o1 > 0 && o2 > 0 && o3 > 0) T.splice(i, 1, [a, b, id], [b, e, id], [e, a, id]);
          else contacts.push(q);
          return;
        }
      }
    });
    // 2. Lawson flips on inside edges
    function ekey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }
    function incircle(a, b, e, q) {
      var ax = X[a] - X[q], ay = Y[a] - Y[q], bx = X[b] - X[q], by = Y[b] - Y[q], ex = X[e] - X[q], ey = Y[e] - Y[q];
      return (ax * ax + ay * ay) * (bx * ey - ex * by) - (bx * bx + by * by) * (ax * ey - ex * ay) + (ex * ex + ey * ey) * (ax * by - bx * ay);
    }
    for (var pass = 0; pass < 50; pass++) {
      var edges = new Map(), flips = 0;
      T.forEach(function (tr, i) { for (var k = 0; k < 3; k++) { var kk = ekey(tr[k], tr[(k + 1) % 3]); (edges.get(kk) || edges.set(kk, []).get(kk)).push(i); } });
      var dirty = new Set();
      edges.forEach(function (ts) {
        if (ts.length !== 2 || dirty.has(ts[0]) || dirty.has(ts[1])) return;
        var t1 = T[ts[0]], t2 = T[ts[1]], k1 = -1;
        for (var k = 0; k < 3; k++) if (t2.indexOf(t1[k]) < 0) k1 = k;
        var k2 = -1;
        for (k = 0; k < 3; k++) if (t1.indexOf(t2[k]) < 0) k2 = k;
        if (k1 < 0 || k2 < 0) return;
        var a = t1[(k1 + 1) % 3], b = t1[(k1 + 2) % 3], e = t1[k1], q = t2[k2];   // t1 = (e, a, b), shared edge a-b
        if (!(incircle(e, a, b, q) > 1e-12)) return;
        // the quad e-a-q-b must be strictly convex for the flip to stay inside
        if (!(orient(e, a, q) > 0 && orient(q, b, e) > 0)) return;
        if (edges.has(ekey(e, q))) return;                                       // that edge is already there
        T[ts[0]] = [e, a, q]; T[ts[1]] = [e, q, b];
        dirty.add(ts[0]); dirty.add(ts[1]); flips++;
      });
      if (!flips) break;
    }
    var out = [];
    T.forEach(function (tr) { tr.forEach(function (v) { out.push(P[v][0], P[v][1], P[v][2]); }); });
    return { cap: out, touched: touch ? P.length - loopV - contacts.length : 0, contacts: contacts };
  }

  /** The island's own triangles, then its back: the plate's cap turned over. */
  function pieceOf(soup, I, cp) {
    var ps = new Float32Array(I.tris.length * 9 + cp.length), o = 0;
    I.tris.forEach(function (t) { for (var q = 0; q < 9; q++) ps[o++] = soup[t * 9 + q]; });
    for (var c = 0; c < cp.length; c += 9) {
      ps[o++] = cp[c]; ps[o++] = cp[c + 1]; ps[o++] = cp[c + 2];
      ps[o++] = cp[c + 6]; ps[o++] = cp[c + 7]; ps[o++] = cp[c + 8];
      ps[o++] = cp[c + 3]; ps[o++] = cp[c + 4]; ps[o++] = cp[c + 5];
    }
    return ps;
  }

  function cut(soup, A, ids, deps) {
    var L1 = P1();
    if (!A || !A.ok) return { ok: false, reason: 'pick a face first' };
    var cap = dep(deps, 'rawFlatCapLoops');
    if (typeof cap !== 'function') return { ok: false, reason: 'Lift needs the cut engine (app-cut.js, rawFlatCapLoops)' };
    var want = Array.from(new Set(ids || []));
    if (!want.length) return { ok: false, reason: 'nothing is chosen - click a detail first' };
    var M = A.M, nt = M.nt, chosen = new Uint8Array(nt), pieces = [], caps = [];
    for (var w = 0; w < want.length; w++) {
      var I = A.islands[want[w]];
      if (!I) return { ok: false, reason: 'there is no detail ' + want[w] + ' on this face' };
      if (I.status !== 'ok') return { ok: false, reason: 'detail ' + (I.id + 1) + ' cannot be lifted: ' + I.reason };
      var cp, ps, pc, rf, fl = null;
      if (I.fill === 'curved') {
        // Lift 3: the surface round it carried across, welded at the rim
        var CV = LC();
        if (!CV) return { ok: false, reason: 'Lift needs nso_lift_curved.js to lift off a curved base' };
        var ear;
        try { ear = L1.internals.capFor({ M: M, plane: { n: I.frame.n, d: 0 }, frame: I.frame }, I, cap); }
        catch (err) { return { ok: false, reason: 'detail ' + (I.id + 1) + ' could not be capped (' + ((err && err.message) || err) + ')' }; }
        fl = CV.fill(A, I, ear, { relaxMm: A.relaxMm, target: I.base });
        if (!fl.ok) return { ok: false, reason: 'detail ' + (I.id + 1) + ' could not be filled under: ' + fl.reason + ' - nothing changed' };
        rf = { cap: fl.cap, touched: 0, contacts: [] };
        ps = pieceOf(soup, I, rf.cap);
        pc = census(ps);
      } else {
        try { cp = L1.internals.capFor({ M: M, plane: I.plane, frame: I.frame }, I, cap); }
        catch (err) { return { ok: false, reason: 'detail ' + (I.id + 1) + ' could not be capped (' + ((err && err.message) || err) + ')' }; }
        // the cap with the island's touching corners in it, else without them
        for (var touch = 1; touch >= 0; touch--) {
          rf = refineCap(cp, I, M, !!touch);
          ps = pieceOf(soup, I, rf.cap);
          pc = census(ps);
          if ((pc.closed && !pc.degen) || !(rf.touched > 0)) break;
        }
      }
      cp = rf.cap;
      I.tris.forEach(function (t) { chosen[t] = 1; });
      var held = 0;
      if (I.parts && I.parts.length) {
        // the shells it holds come along as they are: same corners, same gaps, not fused to anything
        var extra = 0;
        I.parts.forEach(function (P) { extra += P.tris.length * 9; });
        var whole = new Float32Array(ps.length + extra), wo = ps.length;
        whole.set(ps);
        I.parts.forEach(function (P) {
          P.tris.forEach(function (t) { chosen[t] = 1; for (var q3 = 0; q3 < 9; q3++) whole[wo++] = soup[t * 9 + q3]; });
          held++;
        });
        ps = whole;
        pc = census(ps);
      }
      if (!pc.closed || pc.degen) {
        return { ok: false, reason: 'detail ' + (I.id + 1) + ' would not come off as a closed piece (' +
          pc.open + ' open, ' + pc.nm + ' non-manifold, ' + pc.degen + ' degenerate) - nothing changed' };
      }
      var off = 0;
      if (fl) off = fl.stats.maxOffBaseMm;
      else for (var c = 0; c < cp.length; c += 3) off = Math.max(off, Math.abs(cp[c] * I.plane.n[0] + cp[c + 1] * I.plane.n[1] + cp[c + 2] * I.plane.n[2] - I.plane.d));
      pieces.push({ id: I.id, soup: ps, heightMm: I.heightMm, capTris: cp.length / 9, volume: L1.volume(ps), sharedCorners: rf.touched,
                    contacts: rf.contacts,
                    rootAreaMm2: I.rootAreaMm2, census: pc, group: I.group, backOffMm: off, plane: I.plane, parts: held,
                    fill: fl ? fl.stats : null, notes: I.fillNotes || [] });
      caps.push(cp);
    }
    var kept = 0;
    for (var t = 0; t < nt; t++) if (!chosen[t]) kept++;
    var capLen = caps.reduce(function (s, x) { return s + x.length; }, 0);
    var plate = new Float32Array(kept * 9 + capLen), p = 0;
    for (t = 0; t < nt; t++) {
      if (chosen[t]) continue;
      for (var q2 = 0; q2 < 9; q2++) plate[p++] = soup[t * 9 + q2];
    }
    caps.forEach(function (cq) { for (var i = 0; i < cq.length; i++) plate[p++] = cq[i]; });
    var src = A.sourceCensus || (A.sourceCensus = census(soup)), pl = census(plate);
    if (src.closed && (!pl.closed || pl.degen)) {
      return { ok: false, reason: 'the plate would not stay closed (' + pl.open + ' open, ' + pl.nm +
        ' non-manifold, ' + pl.degen + ' degenerate) - nothing changed' };
    }
    var vSrc = L1.volume(soup), vPlate = L1.volume(plate), vP = pieces.reduce(function (s, x) { return s + x.volume; }, 0);
    return { ok: true, plate: plate, pieces: pieces, keptTris: kept, plateCensus: pl,
             volumes: { source: vSrc, plate: vPlate, pieces: vP, residual: vSrc - vPlate - vP } };
  }

  /** Lift 3's words for where they stood, and its notes; null when every
      piece was cut flat (Lift 2's words stand). */
  function curvedWords(pieces) {
    var nc = pieces.filter(function (pc) { return pc.fill; }).length;
    if (!nc) return null;
    var notes = [];
    pieces.forEach(function (pc) { (pc.notes || []).forEach(function (s) { notes.push(s); }); });
    return { where: (nc === pieces.length ? '' : ' and is flat where ' + (pieces.length - nc === 1 ? 'one' : 'some') + ' stood on a flat face') +
      '; where ' + (nc === 1 ? 'it' : 'they') + ' stood' + (nc === pieces.length ? '' : ' on a curve') + ', the surface round ' + (nc === 1 ? 'it' : 'them') +
      ' is carried across, welded to it at the rim', notes: notes };
  }

  /** " with 2 captured parts" for the parts that went with the details; '' when none did. */
  function heldWords(pieces) {
    var k = pieces.reduce(function (s2, pc) { return s2 + (pc.parts || 0); }, 0);
    return k ? ' with ' + plural(k, 'captured part') : '';
  }

  function lift(soup, A, ids, deps) {
    var r = cut(soup, A, ids, deps);
    if (!r.ok) return r;
    var n = r.pieces.length, cw = curvedWords(r.pieces), hw = heldWords(r.pieces);
    if (cw) {
      r.notes = cw.notes;
      r.reason = 'lifted ' + plural(n, 'detail') + hw + ' (' + fmt(r.volumes.pieces) + ' mm³) off the face, each cut along the surface ' +
        'it stands on; the plate keeps ' + r.keptTris + ' of its ' + A.M.nt + ' triangles as they were' + cw.where +
        (cw.notes.length ? '. Note: ' + cw.notes.join('; ') : '');
      return r;
    }
    r.reason = 'lifted ' + plural(n, 'detail') + hw + ' (' + fmt(r.volumes.pieces) + ' mm³) off the face, each at its own ' +
      'flat cut; the plate keeps ' + r.keptTris + ' of its ' + A.M.nt + ' triangles as they were and is flat where ' +
      (n === 1 ? 'it' : 'they') + ' stood';
    return r;
  }

  /** Discard the details: the plate as Lift leaves it, and no pieces. */
  function remove(soup, A, ids, deps) {
    var r = cut(soup, A, ids, deps);
    if (!r.ok) return r;
    var n = r.pieces.length, cw = curvedWords(r.pieces), hw = heldWords(r.pieces);
    return { ok: true, plate: r.plate, keptTris: r.keptTris, plateCensus: r.plateCensus,
      removed: r.pieces.map(function (pc) { return { id: pc.id, volume: pc.volume, group: pc.group, backOffMm: pc.backOffMm, capTris: pc.capTris, fill: pc.fill }; }),
      volumes: { source: r.volumes.source, plate: r.volumes.plate, removed: r.volumes.pieces, residual: r.volumes.residual },
      notes: cw ? cw.notes : undefined,
      reason: cw ? 'removed ' + plural(n, 'detail') + hw + ' (' + fmt(r.volumes.pieces) + ' mm³); the plate keeps ' + r.keptTris +
        ' of its ' + A.M.nt + ' triangles as they were' + cw.where + (cw.notes.length ? '. Note: ' + cw.notes.join('; ') : '') :
        'removed ' + plural(n, 'detail') + hw + ' (' + fmt(r.volumes.pieces) + ' mm³); the plate keeps ' + r.keptTris +
        ' of its ' + A.M.nt + ' triangles as they were and is flat where ' + (n === 1 ? 'it' : 'they') + ' stood' };
  }

  var api = {
    DEFAULTS: DEFAULTS,
    WHY: WHY,
    GROUPS: GROUPS,
    index: index,
    buildMap: buildMap,
    rollingBall: rollingBall,
    estimateBase: function (map, opts) { return rollingBall(map, opts); },
    analyse: analyse,
    offered: offered,
    groupOf: groupOf,
    lift: lift,
    remove: remove,
    necksOf: necksOf,
    edt: edt,
    census: census,
    shellsOf: shellsOf,
    assemble: assemble
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_LiftAuto = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
