/* nso_foam_gun.js - the GUN: point at a gap, spray, it fills from plate to face.

   Loads as a classic script (window.NSO_FoamGun) and as a Node module
   (require('../nso_foam_gun.js')). No DOM, no Three.js, no app state. A mesh is
   the app's raw soup (9 numbers per triangle, millimetres). docs/FOAM-GUN.md.

   ---------------------------------------------------------------------------
   WHAT IT IS
   ---------------------------------------------------------------------------
   A spray-foam gun, no box. The click's ray goes into a gap - a slot, a crack,
   a notch, the space between two welded parts - and meets the gap's wall. Just
   short of that hit, in the air the ray came through, is the SEED. The gun
   fills the gap the seed is in, layer by layer along the plate's vertical
   (`up`), down to the plate (or the gap's floor) and up to the face (or the
   gap's ceiling). A gap that opens to the side is filled out to the piece's
   outer surface: its mouth is closed across.

   It is the forgiving tool. foamBox (nso_foam.js) is exact and refuses what it
   cannot do exactly; the gun works on the pieces welds and unions leave - float
   noise on a flat face, needle triangles, a wall pinched to nothing. It does not
   promise that faces it did not reach come back bit for bit: the foam is
   unioned into the piece by the boolean kernel (manifold-3d, nso_csg.js), which
   lays the mesh again where they meet. What it does promise: the result is one
   closed 2-manifold the kernel built, nothing added outside the piece's own
   outline (the closed mouth aside), and the volume it says it added.

   ---------------------------------------------------------------------------
   THE MODEL
   ---------------------------------------------------------------------------
   frame    up becomes +Z. Unposed, up is raw +Z.
   section  the piece cut at a height (Manifold.slice): its material, 2D.
   gaps     at a height: the empty space the section's outline holds - the holes
            in it - after the outline is CLOSED by a radius r (grown by r, shrunk
            by r): a mouth narrower than 2r is shut, a wider one is not. r is the
            smallest of R_LADDER that puts the seed in a gap at least
            POCKET_MIN x r^2 in area (closing also rounds every inside corner by
            r; a corner is not a gap), read at the seed's height, then held for
            every height. r = 0 is a gap closed all round
            (a slot); a notch takes the r its mouth needs. Past the ladder's top
            (or a quarter of the piece's smaller width) the seed is in open air
            and the gun says so.
   slabs    the piece's height cut at every height a corner of it lies on (heights
            within 1e-4 mm of each other are one, the weld radius), and no slab
            taller than STEP. A slab's gap is read at its middle height: exact for
            walls that stand straight up, as a weld of plates' do; a slanted wall
            is followed in steps of STEP.
   pocket   the gap the seed is in, in its slab; then, slab by slab up and down,
            the gaps of the next slab that overlap the pocket so far. It ends
            where a slab has none (the gap's ceiling or floor, in material) or at
            the piece's end (the face, or the plate).
   foam     each slab's pocket, grown 0.03 mm into the walls (and no further out
            than the closed outline), stood up its slab's height. At the plate
            and the face it overshoots by 0.05 mm and the result is trimmed back
            to the piece's own end height: a flat face spread over float noise
            then never leaves a hair-thin tunnel along the foam's edge.
   amount   0..100: the foam rises from the pocket's bottom; at `amount` it is
            cut flat at that fraction of the pocket's height.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   spray(piece, aim, opts) -> Promise of { ok, changed, mesh, foam, up, addedVolume, level,
                                          span, reachesPlate, reachesFace, bridge,
                                          slabs, reason, kind }
       piece { rawTris }   the soup in raw axes
       aim   { point, dir } the click's hit on the piece and the ray's direction,
                            both raw
       opts  { up, amount (default 100), wasm (manifold-3d, else NSO_CSG.load()),
               preview (default true: also hand back `foam`, the foam alone, raw),
               skipList (paint: a painted face the foam would reach stands it
               down), timings }
       kind: 'set' | 'air' | 'notSolid' | 'painted' | 'kernel' | 'nothing'
   pocket(piece, aim, opts) -> Promise of the same reading without building the
       foam: { ok, span, reachesPlate, reachesFace, bridge, slabs, reason }

   Refusals follow the house contract: ok false, a reason in plain words, `mesh`
   the ORIGINAL soup.
*/
(function (root) {
  'use strict';

  var EPS_SEED = 0.02;        // mm: the seed is this far back along the ray from the hit
  var WELD = 1e-4;            // mm: the weld radius - heights this close are one
  var STEP = 0.5;             // mm: the tallest slab
  var GROW = 0.03;            // mm: the foam reaches this far into the walls it fills against
  var OVER = 0.05;            // mm: overshoot at the plate and the face, trimmed back
  var R_LADDER = [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4];
  var MIN_AREA = 1e-6;        // mm^2: a gap smaller than this is no gap
  var SIMPLIFY = 1e-4;        // mm: a section's corners this close to a straight run are dropped
  var POCKET_MIN = 8;         // a pocket behind a mouth of 2r holds at least this x r^2
  var PLATE_REACH = 0.5;      // mm: a gap whose bottom is this close to the plate, over air, drops to it

  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function grouped(x) {
    var s = String(Math.round(x)), neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    for (var i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + ',' + s.slice(i);
    return (neg ? '-' : '') + s;
  }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  /* A right-handed frame (e1, e2, n) with n = up; a raw axis gives a signed
     permutation, exact in floating point. */
  function frameFor(up) {
    var u = norm(up || [0, 0, 1]) || [0, 0, 1], k;
    for (k = 0; k < 3; k++) {
      if (Math.abs(u[k]) > 1 - 1e-9) {
        var n = [0, 0, 0]; n[k] = u[k] > 0 ? 1 : -1;
        var e1 = [0, 0, 0], e2;
        e1[(k + 1) % 3] = 1;
        e2 = cross(n, e1);
        return { e1: e1, e2: e2, n: n, identity: k === 2 && n[2] === 1 };
      }
    }
    var helper = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    var a = norm(cross(helper, u)), b = cross(u, a);
    return { e1: a, e2: b, n: u, identity: false };
  }
  function toF(F, p) {
    return [p[0] * F.e1[0] + p[1] * F.e1[1] + p[2] * F.e1[2],
            p[0] * F.e2[0] + p[1] * F.e2[1] + p[2] * F.e2[2],
            p[0] * F.n[0] + p[1] * F.n[1] + p[2] * F.n[2]];
  }
  function fromF(F, q) {
    return [q[0] * F.e1[0] + q[1] * F.e2[0] + q[2] * F.n[0],
            q[0] * F.e1[1] + q[1] * F.e2[1] + q[2] * F.n[1],
            q[0] * F.e1[2] + q[1] * F.e2[2] + q[2] * F.n[2]];
  }

  function wasmOf(opts) {
    if (opts && opts.wasm) return Promise.resolve(opts.wasm);
    var C = root && root.NSO_CSG;
    if (C && typeof C.load === 'function') return C.load();
    return Promise.reject(new Error('the boolean kernel (manifold-3d) is not loaded'));
  }

  function soupToManifold(W, soup, F) {
    var nt = Math.floor(soup.length / 9), vp = new Float32Array(nt * 9), tv = new Uint32Array(nt * 3), i;
    for (i = 0; i < nt * 3; i++) {
      var q = F.identity ? [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]] : toF(F, [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]]);
      vp[i * 3] = q[0]; vp[i * 3 + 1] = q[1]; vp[i * 3 + 2] = q[2]; tv[i] = i;
    }
    var mesh = new W.Mesh({ numProp: 3, vertProperties: vp, triVerts: tv });
    mesh.merge();
    return new W.Manifold(mesh);
  }
  function manifoldToSoup(m, F) {
    var mesh = m.getMesh(), tv = mesh.triVerts, vp = mesh.vertProperties, np = mesh.numProp || 3;
    var out = new Float32Array(tv.length * 3);
    for (var i = 0; i < tv.length; i++) {
      var o = tv[i] * np, q = [vp[o], vp[o + 1], vp[o + 2]];
      if (!F.identity) q = fromF(F, q);
      out[i * 3] = q[0]; out[i * 3 + 1] = q[1]; out[i * 3 + 2] = q[2];
    }
    /* Two of the kernel's corners can land on one float32 point: a triangle
       with a repeated corner has no area and joins nothing - it goes. */
    var keep = 0;
    for (var t = 0; t < out.length / 9; t++) {
      var o = t * 9, same = function (a, b) { return out[o + a] === out[o + b] && out[o + a + 1] === out[o + b + 1] && out[o + a + 2] === out[o + b + 2]; };
      if (same(0, 3) || same(3, 6) || same(0, 6)) continue;
      if (keep !== t) out.copyWithin(keep * 9, o, o + 9);
      keep++;
    }
    return keep * 9 === out.length ? out : out.slice(0, keep * 9);
  }

  /* The piece's corner heights, one per run within WELD (the run's most
     common height), sorted. */
  function cornerHeights(m) {
    var mesh = m.getMesh(), vp = mesh.vertProperties, np = mesh.numProp || 3, n = vp.length / np, zs = new Float64Array(n);
    for (var i = 0; i < n; i++) zs[i] = vp[i * np + 2];
    zs.sort();
    var out = [], s = 0;
    while (s < n) {
      var e = s + 1;
      while (e < n && zs[e] - zs[s] <= WELD) e++;
      var best = zs[s], bestN = 0, run = 0;
      for (var k = s; k < e; k++) {
        run = (k > s && zs[k] === zs[k - 1]) ? run + 1 : 1;
        if (run > bestN) { bestN = run; best = zs[k]; }
      }
      out.push({ z: best, lo: zs[s], hi: zs[e - 1] });
      s = e;
    }
    return out;
  }

  function inRing(x, y, ring) {
    var c = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j], ax = a[0] !== undefined ? a[0] : a.x, ay = a[1] !== undefined ? a[1] : a.y,
          bx = b[0] !== undefined ? b[0] : b.x, by = b[1] !== undefined ? b[1] : b.y;
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) c = !c;
    }
    return c;
  }
  /* Is (x, y) in a cross-section: inside an odd number of its contours. */
  function csHas(cs, x, y) {
    var polys = cs.toPolygons(), inside = false;
    for (var i = 0; i < polys.length; i++) if (inRing(x, y, polys[i])) inside = !inside;
    return inside;
  }
  function ringArea(r) {
    var a = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var p = r[i], q = r[j], px = p[0] !== undefined ? p[0] : p.x, py = p[1] !== undefined ? p[1] : p.y,
          qx = q[0] !== undefined ? q[0] : q.x, qy = q[1] !== undefined ? q[1] : q.y;
      a += (qx - px) * (qy + py);
    }
    return a / 2;
  }

  /* The section's outline closed by r, its holes filled: the space the piece
     holds at this height, material and gaps together. */
  function heldAt(W, S, r) {
    var C = r > 0 ? S.offset(r, 'Round').offset(-r, 'Round') : S;
    var polys = C.toPolygons(), outer = [];
    for (var i = 0; i < polys.length; i++) if (ringArea(polys[i]) > 0) outer.push(polys[i]);
    var held = outer.length ? new W.CrossSection(outer, 'Positive') : new W.CrossSection([], 'Positive');
    if (C !== S) C.delete();
    return held;
  }

  /* One slab's gaps: { held, gaps: [CrossSection...] }. */
  function gapsAt(W, m, z, r) {
    var S0 = m.slice(z), S = S0.simplify(SIMPLIFY);
    S0.delete();
    var held = heldAt(W, S, r), cand = held.subtract(S), parts = cand.decompose(), gaps = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].area() > MIN_AREA) gaps.push(parts[i]); else parts[i].delete();
    }
    S.delete(); cand.delete();
    return { held: held, gaps: gaps };
  }
  function overlaps(a, b) {
    var x = a.intersect(b), ar = x.area();
    x.delete();
    return ar > MIN_AREA;
  }
  /* Same shape: their difference both ways is under MIN_AREA. */
  function sameShape(a, b) {
    if (Math.abs(a.area() - b.area()) > MIN_AREA) return false;
    var d1 = a.subtract(b), d2 = b.subtract(a), same = d1.area() < MIN_AREA && d2.area() < MIN_AREA;
    d1.delete(); d2.delete();
    return same;
  }
  function unionAll(W, list) {
    if (!list.length) return new W.CrossSection([], 'Positive');
    if (list.length === 1) return list[0].translate([0, 0]);
    return W.CrossSection.union(list);
  }

  function refusal(soup, kind, reason) {
    return { ok: false, changed: false, kind: kind, mesh: soup, addedVolume: 0, reason: reason };
  }

  /* The reading: frame, seed, bridge radius, slabs and the pocket in each.
     -> { ok, ... } with live wasm objects in `live` (the caller deletes them). */
  function read(W, soup, aim, opts) {
    var F = frameFor(opts.up);
    var m = soupToManifold(W, soup, F);
    if (m.status() !== 'NoError' || m.isEmpty()) {
      var st = m.status();
      m.delete();
      return { ok: false, kind: 'notSolid', reason: 'the piece is not one closed solid the kernel can read (' + st + ') - Check & repair it first' };
    }
    var bb = m.boundingBox(), zmin = bb.min[2], zmax = bb.max[2];
    var d = norm(aim.dir), p = aim.point;
    if (!d || !p) { m.delete(); return { ok: false, kind: 'air', reason: 'no aim - click on the piece, into a gap' }; }
    var sp = [p[0] - d[0] * EPS_SEED, p[1] - d[1] * EPS_SEED, p[2] - d[2] * EPS_SEED];
    var seed = F.identity ? sp : toF(F, sp);
    if (!(seed[2] > zmin && seed[2] < zmax)) {
      m.delete();
      return { ok: false, kind: 'air', reason: 'that click is above or below the piece - aim into a gap, at its wall' };
    }

    /* Slabs: corner heights, welded, then cut to STEP. */
    var H = cornerHeights(m), zs = [];
    for (var i = 0; i < H.length; i++) zs.push(H[i].z);
    zs[0] = zmin; zs[zs.length - 1] = zmax;
    var cuts = [zs[0]];
    for (i = 1; i < zs.length; i++) {
      var a = zs[i - 1], b = zs[i], k = Math.ceil((b - a) / STEP - 1e-9);
      for (var q = 1; q < k; q++) cuts.push(a + (b - a) * q / k);
      cuts.push(b);
    }
    var nS = cuts.length - 1, js = -1;
    for (i = 0; i < nS; i++) if (seed[2] >= cuts[i] && seed[2] <= cuts[i + 1]) { js = i; break; }
    if (js < 0) js = 0;
    var mid = function (j) { return (cuts[j] + cuts[j + 1]) / 2; };

    /* The bridge: the smallest r that puts the seed in a gap, at the seed's slab. */
    var w = Math.min(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]), rMax = Math.max(0.05, w / 4);
    var r = -1, first = null, held0 = null;
    for (i = 0; i < R_LADDER.length && R_LADDER[i] <= rMax; i++) {
      var G = gapsAt(W, m, mid(js), R_LADDER[i]), hit = null;
      for (var g = 0; g < G.gaps.length; g++) {
        /* A closing also rounds every inside corner by r - about 0.21 r^2 of
           "gap" in a corner that is not one. A pocket behind a mouth is far
           bigger than its mouth: less than POCKET_MIN x r^2 is a corner. */
        var ok = !hit && csHas(G.gaps[g], seed[0], seed[1]) && (R_LADDER[i] === 0 || G.gaps[g].area() >= POCKET_MIN * R_LADDER[i] * R_LADDER[i]);
        if (ok) hit = G.gaps[g]; else G.gaps[g].delete();
      }
      if (hit) { r = R_LADDER[i]; first = hit; held0 = G.held; break; }
      G.held.delete();
    }
    if (r < 0) {
      m.delete();
      return { ok: false, kind: 'air', reason: 'that click is not in a gap - the space there is open to the outside wider than ' +
               f1(2 * Math.min(rMax, R_LADDER[R_LADDER.length - 1])) + ' mm. Aim into a slot, a crack or a notch, at its wall' };
    }

    /* The pocket, slab by slab from the seed's, down and up. */
    var pockets = new Array(nS), helds = new Array(nS);
    pockets[js] = first; helds[js] = held0;
    var lo = js, hi = js;
    for (var dir = -1; dir <= 1; dir += 2) {
      var prev = first, j = js + dir;
      while (j >= 0 && j < nS) {
        var Gj = gapsAt(W, m, mid(j), r), keep = [];
        for (g = 0; g < Gj.gaps.length; g++) { if (overlaps(Gj.gaps[g], prev)) keep.push(Gj.gaps[g]); else Gj.gaps[g].delete(); }
        if (!keep.length) { Gj.held.delete(); break; }
        var u = unionAll(W, keep);
        for (g = 0; g < keep.length; g++) keep[g].delete();
        pockets[j] = u; helds[j] = Gj.held; prev = u;
        if (dir < 0) lo = j; else hi = j;
        j += dir;
      }
    }
    /* Plate: a gap that ends just above the plate over air (a part of the
       piece standing a hair proud of the plate) drops to the plate - the foam
       stands on the plate the way spray foam does. Its bottom slab's pocket
       carries down, inside that slab's held outline. */
    var plate = lo === 0;
    if (!plate && cuts[lo] - zmin <= PLATE_REACH) {
      var air = true;
      for (j = lo - 1; j >= 0 && air; j--) {
        var Sb = m.slice(mid(j)), x = pockets[lo].intersect(Sb), ar = x.area();
        Sb.delete(); x.delete();
        if (ar > 0.01 * pockets[lo].area()) air = false;
      }
      if (air) {
        for (j = lo - 1; j >= 0; j--) { pockets[j] = pockets[lo].translate([0, 0]); helds[j] = helds[lo].translate([0, 0]); }
        lo = 0; plate = true;
      }
    }
    return { ok: true, F: F, m: m, cuts: cuts, lo: lo, hi: hi, pockets: pockets, helds: helds, r: r, zmin: zmin, zmax: zmax,
             reachesPlate: plate, reachesFace: hi === nS - 1, nS: nS };
  }
  function release(R) {
    if (!R || !R.ok) return;
    for (var i = 0; i < R.nS; i++) { if (R.pockets[i]) R.pockets[i].delete(); if (R.helds[i]) R.helds[i].delete(); }
    R.m.delete();
  }

  /* Paint: a painted face the foam would reach stands it down. A face is reached
     when its centre lies within GROW of the foam's slabs' pocket at its height. */
  function paintedReached(soup, skip, R) {
    if (!skip || !skip.length) return null;
    for (var s = 0; s < skip.length; s++) {
      var t = skip[s], ti = typeof t === 'number' ? t : (t && t.index);
      if (ti == null) continue;
      var o = ti * 9, c = [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
      if (!R.F.identity) c = toF(R.F, c);
      for (var j = R.lo; j <= R.hi; j++) {
        if (c[2] < R.cuts[j] - GROW || c[2] > R.cuts[j + 1] + GROW) continue;
        var grown = R.pockets[j].offset(2 * GROW, 'Round'), hit = csHas(grown, c[0], c[1]);
        grown.delete();
        if (hit) return { index: ti };
      }
    }
    return null;
  }

  function pocket(piece, aim, opts) {
    opts = opts || {};
    var soup = piece && (piece.rawTris || piece.soup || piece);
    return wasmOf(opts).then(function (W) {
      var R = read(W, soup, aim || {}, opts);
      if (!R.ok) return { ok: false, kind: R.kind, reason: 'GUN: ' + R.reason + '. Nothing changed.' };
      var out = { ok: true, span: [R.cuts[R.lo], R.cuts[R.hi + 1]], reachesPlate: R.reachesPlate, reachesFace: R.reachesFace,
                  bridge: R.r, slabs: R.hi - R.lo + 1 };
      release(R);
      return out;
    });
  }

  function spray(piece, aim, opts) {
    opts = opts || {};
    var soup = piece && (piece.rawTris || piece.soup || piece);
    var skip = piece && piece.skipList !== undefined ? piece.skipList : opts.skipList;
    var amount = opts.amount == null ? 100 : Math.max(0, Math.min(100, +opts.amount));
    if (!soup || soup.length < 9) return Promise.resolve(refusal(soup, 'nothing', 'GUN: there is no piece to spray. Nothing changed.'));
    return wasmOf(opts).then(function (W) {
      var R = read(W, soup, aim || {}, opts);
      if (!R.ok) return refusal(soup, R.kind, 'GUN: ' + R.reason + '. Nothing changed.');
      var made = [], result = null;
      try {
        var zlo = R.cuts[R.lo], zhi = R.cuts[R.hi + 1], level = zlo + amount / 100 * (zhi - zlo);
        var base = { ok: true, changed: false, kind: 'nothing', mesh: soup, addedVolume: 0, level: level, span: [zlo, zhi],
                     reachesPlate: R.reachesPlate, reachesFace: R.reachesFace, bridge: R.r, slabs: R.hi - R.lo + 1, amount: amount };
        if (amount <= 0 || level <= zlo + WELD) { base.reason = 'GUN: the amount is 0 - nothing to set. Nothing changed.'; return base; }
        var pa = paintedReached(soup, skip, R);
        if (pa) {
          return Object.assign(refusal(soup, 'painted', 'GUN stood down - a painted face is one the foam would fill against. ' +
                 'Paint elsewhere does not matter; clear this face\'s paint to spray here. Nothing changed.'), { painted: pa });
        }

        /* The foam: each slab's pocket, grown into the walls but kept inside
           the closed outline, stood up its slab's height. */
        /* Slabs whose pockets are the same shape go up as one prism: a gap
           with straight walls is one extrusion, plate to face. */
        var runs = [];
        for (var j = R.lo; j <= R.hi; j++) {
          if (R.cuts[j] >= level) break;
          var last = runs[runs.length - 1];
          if (last && sameShape(R.pockets[last.j1], R.pockets[j]) && sameShape(R.helds[last.j1], R.helds[j])) last.j1 = j;
          else runs.push({ j0: j, j1: j });
        }
        var slabs = [];
        for (var ri = 0; ri < runs.length; ri++) {
          var run = runs[ri], z0 = R.cuts[run.j0], z1 = R.cuts[run.j1 + 1];
          if (run.j0 === R.lo) z0 -= R.reachesPlate ? OVER : GROW;
          if (run.j1 === R.hi) z1 += R.reachesFace ? OVER : GROW;
          else z1 += GROW;                                            // runs overlap: no shared face to weld
          if (z1 > level && level < zhi - WELD) z1 = level;
          var grown = R.pockets[run.j0].offset(GROW, 'Miter'), area = grown.intersect(R.helds[run.j0]);
          made.push(grown, area);
          var ex = area.extrude(z1 - z0).translate([0, 0, z0]);
          made.push(ex);
          slabs.push(ex);
        }
        if (!slabs.length) { base.reason = 'GUN: the amount is too small to fill anything yet. Nothing changed.'; return base; }
        var foam = slabs.length === 1 ? slabs[0] : W.Manifold.union(slabs);
        if (slabs.length > 1) made.push(foam);
        var u = R.m.add(foam);
        made.push(u);
        /* Back to the piece's own ends: the overshoot goes. */
        var t1 = u.trimByPlane([0, 0, -1], -R.zmax), t2 = t1.trimByPlane([0, 0, 1], R.zmin);
        made.push(t1, t2);
        if (t2.status() !== 'NoError' || t2.isEmpty()) return refusal(soup, 'kernel', 'GUN: the kernel could not weld the foam in (' + t2.status() + '). Nothing changed.');
        /* Corners closer than the weld radius - the input's own needles and
           the kernel's cut corners beside them - fold together, so the piece
           reads the same welded at 1e-4 mm as it does exactly. */
        if (typeof t2.simplify === 'function') { var t3 = t2.simplify(WELD); made.push(t3); if (t3.status() === 'NoError' && !t3.isEmpty()) t2 = t3; }
        var added = t2.volume() - R.m.volume();
        if (!(added > 1e-9)) { base.reason = 'GUN: nothing was filled - the gap is already solid there. Nothing changed.'; return base; }
        var mesh = manifoldToSoup(t2, R.F), foamSoup = null;
        if (opts.preview !== false) {
          var f1 = foam.trimByPlane([0, 0, -1], -R.zmax), f2 = f1.trimByPlane([0, 0, 1], R.zmin);
          made.push(f1, f2);
          foamSoup = manifoldToSoup(f2, R.F);
        }
        result = { ok: true, changed: true, kind: 'set', mesh: mesh, foam: foamSoup, up: R.F.n.slice(), addedVolume: added, level: level, span: [zlo, zhi],
                   reachesPlate: R.reachesPlate, reachesFace: R.reachesFace, bridge: R.r, slabs: R.hi - R.lo + 1, amount: amount,
                   genusBefore: R.m.genus(), genusAfter: t2.genus() };
        result.reason = words(result);
        return result;
      } finally {
        for (var i = 0; i < made.length; i++) { try { made[i].delete(); } catch (e) { /* already gone */ } }
        release(R);
      }
    });
  }

  function words(r) {
    var ends = r.reachesPlate && r.reachesFace ? 'from the plate to the face' :
               r.reachesPlate ? 'from the plate up to the gap\'s ceiling' :
               r.reachesFace ? 'from the gap\'s floor up to the face' : 'from the gap\'s floor to its ceiling';
    var full = r.amount >= 100 ? ', ' + ends : ' (' + Math.round(r.amount) + '% of the way, ' + ends.replace(/^from /, 'rising from ') + ')';
    return 'Foam sprayed - ' + grouped(r.addedVolume) + ' mm³ into the gap' + full +
           (r.bridge > 0 ? '; its ' + f1(2 * r.bridge) + ' mm mouth closed flush with the outside' : '') + '.';
  }
  function readout(added) { return '+' + grouped(added) + ' mm³'; }

  var api = { spray: spray, pocket: pocket, readout: readout, frameFor: frameFor,
              STEP: STEP, GROW: GROW, OVER: OVER, R_LADDER: R_LADDER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_FoamGun = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
