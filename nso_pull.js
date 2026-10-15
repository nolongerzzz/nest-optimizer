/* nso_pull.js - Pull: grab a spot on a piece and drag it, the surface around
   the grab following with a soft falloff.

   Loads as a classic script (window.NSO_Pull) and as a Node module. No DOM, no
   THREE, no app state - tools/nso_pull_test.js drives it headless, and
   app-pull.js is the pointer session on top of it. See docs/PULL.md.

   THE FIELD. A pull has a GRAB (a point on the surface, a radius, a
   displacement D) and any number of PINS (a point and a radius each, which
   hold the surface still). Every vertex within the grab's radius moves by

       D * phi(v)        phi = g(v) * s(v)

   g is the grab's own falloff, the smooth bell: 1 at the centre, 0 at the
   radius, flat at both ends (bell(t) = t*t*(3 - 2t), t = 1 - d/r). s is what the
   pins leave of it. A pin holds by ITS OWN bell - 1 at the pin, 0 at the pin's
   radius - weighted by how much nearer it is than the grab:

       s = product over pins of ( 1 - bell_pin(v) * q_pin(v) )
       q_pin = w_pin / (w_pin + w_grab),   w_h = 1 / (d_h^4 + eps^4)

   so the NEAREST HANDLE WINS where radii overlap, and wins smoothly: at a pin's
   own vertex q = 1 and the bell is 1, so the vertex does not move; at the
   grab's own vertex q = 0, so the grab follows the cursor exactly even with a
   pin's radius over it; in between the two blend with no step at the border
   where "nearest" changes hands, which a hard winner-takes-all would leave as
   a cliff in the surface. phi depends only on where the vertices were and
   where the handles are, never on D - so it is worked out once, and every
   mouse move after that is `base + D * phi`.

   THE GRAB AND THE PINS SNAP to the nearest vertex of the densified mesh (the
   grab always; a pin when one is within a spacing and a bit), so "the lip moved
   6 mm at the grab" and "the pinned vertex did not move" are statements about a
   vertex, not about a point that sits inside a triangle.

   DENSIFY FIRST. A coarse mesh has no vertex to take a curve (nso_densify.js).
   prepare() subdivides the triangles inside the grab's radius to 0.5 mm, once,
   and reports what it did; a region that is already fine is left alone.

   THE GUARDS, at release, on the result and never the preview:
     WALL     a wall that would go under two nozzle widths (0.8 mm at 0.4),
              measured the way Carve measures it - NSO_Thickness.prepare() on
              the result, wallAt() along each station's own inward normal - at a
              station on every moved vertex (~0.5 mm apart, since that is the
              spacing; a very large region is sampled every k-th vertex and
              says so).
     SELF-INTERSECTION  the canonical count (NSO_Repair) over the triangles the
              move could reach, before and after on the SAME triangulation. The
              baseline is the densified mesh, not the original: densify changes
              no surface, so any count it carries is the checker's float32
              noise on a thin slanted ladder and not the pull's doing, and a
              pull must not be refused for it nor be blamed for it.
     COLLAPSE a triangle that goes to zero area is a fold; refused as one.
   A refused pull returns the words and no triangles.

   WHAT A PULL DOES TO A THIN WALL. The rule is the plain one - move by D times
   a falloff - so a wall pulled sideways is SHEARED, not bent: its two skins
   move together, and the wall is thinner measured across its new slope by
   1/sqrt(1 + slope^2), slope up to 1.5 * |D| / r. At the default 12 mm radius a
   6 mm pull of a 1.6 mm wall leaves about 1.2 mm; at 50 mm, 1.56. The guard
   above is what keeps that honest; it does not stop it. docs/PULL.md says so.

     NSO_Pull.prepare(rawTris, grab, pins, opts) -> S      (S.ok false = refused)
       grab { c:[x,y,z], r }       pins [{ c, r }]
       opts { spacing = 0.5, maxTris, nozzle = 0.4 }
     NSO_Pull.displace(S, D)       fills S.pos: base + D * phi, over S.zone
     NSO_Pull.finish(S, D, opts)   the guards -> { ok, reason, tris, report }
     NSO_Pull.pull(rawTris, spec)  all three, for a headless caller
     NSO_Pull.bell(d, r)  NSO_Pull.phiAt(grab, pins, p)
*/
(function (root) {
  'use strict';

  var Densify = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./nso_densify.js') : root.NSO_Densify;

  var SPACING = 0.5;           // mm, the densify target
  var NOZZLE = 0.4;            // mm, the one nozzle this app quotes
  var FLOOR_NOZZLES = 2;       // a wall under this many nozzle widths is refused
  var EPS4 = Math.pow(0.05, 4);
  var MAX_STATIONS = 24000;    // wall stations before sampling every k-th
  var SNAP_PIN = 1.2 * SPACING;

  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* ----------------------------------------------------------- the field */

  /* 1 at the centre, 0 at the radius and beyond, flat at both ends. */
  function bell(d, r) {
    if (!(r > 0)) return 0;
    var t = 1 - d / r;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  /* The fraction of the grab's displacement point p gets. */
  function phiAt(grab, pins, p) {
    var dx = p[0] - grab.c[0], dy = p[1] - grab.c[1], dz = p[2] - grab.c[2];
    var dg2 = dx * dx + dy * dy + dz * dz;
    var g = bell(Math.sqrt(dg2), grab.r);
    if (!(g > 0)) return 0;
    if (!pins || !pins.length) return g;
    var wg = 1 / (dg2 * dg2 + EPS4), s = 1;
    for (var i = 0; i < pins.length; i++) {
      var pn = pins[i];
      var ex = p[0] - pn.c[0], ey = p[1] - pn.c[1], ez = p[2] - pn.c[2];
      var dp2 = ex * ex + ey * ey + ez * ez;
      var b = bell(Math.sqrt(dp2), pn.r);
      if (!(b > 0)) continue;
      var wp = 1 / (dp2 * dp2 + EPS4);
      s *= 1 - b * (wp / (wp + wg));
    }
    return g * s;
  }

  /* ---------------------------------------------------------------- prepare */

  function nearestVertex(pos, V, c) {
    var best = -1, bd = Infinity;
    for (var v = 0; v < V; v++) {
      var dx = pos[v * 3] - c[0], dy = pos[v * 3 + 1] - c[1], dz = pos[v * 3 + 2] - c[2];
      var d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = v; }
    }
    return { v: best, d: Math.sqrt(bd) };
  }

  function prepare(rawTris, grab, pins, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    if (!Densify) { out.reason = 'nso_densify.js is not loaded'; return out; }
    if (!rawTris || rawTris.length < 9) { out.reason = 'empty piece'; return out; }
    if (!grab || !grab.c || !(grab.r > 0)) { out.reason = 'no grab point'; return out; }
    pins = pins || [];

    var spacing = opts.spacing > 0 ? opts.spacing : SPACING;
    var reg = Densify.region(rawTris, { c: grab.c, r: grab.r }, {
      spacing: spacing, maxTris: opts.maxTris, margin: opts.margin
    });
    if (!reg.ok) { out.reason = reg.reason; return out; }
    var mesh = reg.mesh, V = mesh.vertCount;
    var basePos = new Float64Array(mesh.pos);

    // Snap the handles to a vertex of the mesh they act on.
    var ng = nearestVertex(basePos, V, grab.c);
    var g = {
      c: [basePos[ng.v * 3], basePos[ng.v * 3 + 1], basePos[ng.v * 3 + 2]],
      r: grab.r, v: ng.v, at: grab.c.slice()
    };
    var ps = [];
    for (var i = 0; i < pins.length; i++) {
      var np = nearestVertex(basePos, V, pins[i].c);
      var snapped = np.d <= SNAP_PIN * 1.0 + 1e-9;
      ps.push({
        c: snapped ? [basePos[np.v * 3], basePos[np.v * 3 + 1], basePos[np.v * 3 + 2]] : pins[i].c.slice(),
        r: pins[i].r, v: snapped ? np.v : -1, at: pins[i].c.slice()
      });
    }

    // The zone (every vertex the grab can reach) and phi for each, once.
    var zone = [], phiList = [], moved = [];
    var p = [0, 0, 0], r2 = g.r * g.r;
    for (var v = 0; v < V; v++) {
      var dx = basePos[v * 3] - g.c[0], dy = basePos[v * 3 + 1] - g.c[1], dz = basePos[v * 3 + 2] - g.c[2];
      if (dx * dx + dy * dy + dz * dz >= r2) continue;
      p[0] = basePos[v * 3]; p[1] = basePos[v * 3 + 1]; p[2] = basePos[v * 3 + 2];
      var f = phiAt(g, ps, p);
      zone.push(v); phiList.push(f);
      if (f > 0) moved.push(v);
    }

    // Vertex -> triangles, so a live preview rewrites only what moved.
    var T = mesh.triCount, tri = mesh.tri;
    var vdeg = new Int32Array(V + 1), t, k;
    for (t = 0; t < T * 3; t++) vdeg[tri[t] + 1]++;
    for (v = 0; v < V; v++) vdeg[v + 1] += vdeg[v];
    var vtList = new Int32Array(T * 3), fill = new Int32Array(V);
    for (t = 0; t < T; t++) {
      for (k = 0; k < 3; k++) { var vv = tri[t * 3 + k]; vtList[vdeg[vv] + fill[vv]++] = t; }
    }

    return {
      ok: true, reason: '',
      mesh: mesh, basePos: basePos, pos: new Float64Array(basePos),
      grab: g, pins: ps,
      zone: new Int32Array(zone), phi: new Float64Array(phiList), moved: new Int32Array(moved),
      vtStart: vdeg, vtList: vtList,
      densify: reg.report, changed: reg.changed,
      origTris: rawTris, spacing: spacing,
      nozzle: opts.nozzle > 0 ? opts.nozzle : NOZZLE
    };
  }

  /* ---------------------------------------------------------------- displace */

  function displace(S, D) {
    var pos = S.pos, base = S.basePos, zone = S.zone, phi = S.phi;
    for (var i = 0; i < zone.length; i++) {
      var v = zone[i], o = v * 3, f = phi[i];
      pos[o] = base[o] + D[0] * f;
      pos[o + 1] = base[o + 1] + D[1] * f;
      pos[o + 2] = base[o + 2] + D[2] * f;
    }
    S.D = [D[0], D[1], D[2]];
    return S.zone;
  }

  /* ------------------------------------------------------------------ guards */

  function vertexNormals(S, pos, verts) {
    var tri = S.mesh.tri, out = new Float64Array(verts.length * 3);
    for (var q = 0; q < verts.length; q++) {
      var v = verts[q], nx = 0, ny = 0, nz = 0;
      for (var j = S.vtStart[v]; j < S.vtStart[v + 1]; j++) {
        var t = S.vtList[j] * 3;
        var a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
        var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        var wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
        nx += uy * wz - uz * wy; ny += uz * wx - ux * wz; nz += ux * wy - uy * wx;
      }
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (L > 1e-300) { out[q * 3] = nx / L; out[q * 3 + 1] = ny / L; out[q * 3 + 2] = nz / L; }
    }
    return out;
  }

  /* WALL. Returns { ok, thinnest, at, stations, every, reason }. */
  function wallGuard(S, outTris, opts) {
    var TH = opts.thickness || (typeof require === 'function' && typeof module !== 'undefined'
      ? require('./nso_thickness.js') : root.NSO_Thickness);
    var nozzle = S.nozzle, floor = (opts.minWall > 0) ? opts.minWall : FLOOR_NOZZLES * nozzle;
    var res = { ok: true, floor: floor, nozzle: nozzle, thinnest: null, at: null, stations: 0, every: 1, reason: '' };
    if (!TH || typeof TH.prepare !== 'function') {
      res.skipped = true; res.reason = 'wall check unavailable - nso_thickness.js is not loaded';
      return res;
    }
    var P = TH.prepare(outTris, { nozzle: nozzle, minWall: floor });
    if (!P) { res.skipped = true; res.reason = 'nothing to measure'; return res; }
    var verts = S.moved, n = verts.length;
    var every = Math.max(1, Math.ceil(n / (opts.maxStations || MAX_STATIONS)));
    var list = [];
    for (var i = 0; i < n; i += every) list.push(verts[i]);
    var norms = vertexNormals(S, S.pos, list);
    var probe = floor + 1;
    var thinnest = Infinity, at = null, measured = 0;
    for (var q = 0; q < list.length; q++) {
      var v = list[q], o = v * 3;
      var pt = [S.pos[o], S.pos[o + 1], S.pos[o + 2]];
      var nrm = [norms[q * 3], norms[q * 3 + 1], norms[q * 3 + 2]];
      if (!nrm[0] && !nrm[1] && !nrm[2]) continue;
      var w = P.wallAt(pt, { normal: nrm, probe: probe });
      if (!w.measured) continue;
      measured++;
      if (w.mm < thinnest) { thinnest = w.mm; at = pt; }
    }
    res.stations = list.length; res.measured = measured; res.every = every;
    if (measured) { res.thinnest = thinnest; res.at = at; }
    if (measured && thinnest < floor - 1e-4) {
      res.ok = false;
      res.reason = 'it would leave ' + round3(thinnest) + ' mm of wall near (' +
        at.map(function (x) { return round3(x); }).join(', ') + '), under the ' + round3(floor) +
        ' mm floor (two ' + round3(nozzle) + ' mm nozzle widths)';
    }
    return res;
  }

  /* The triangles the move could reach: any with a vertex within r + |D| + 1
     of the grab. A pierce needs a moved triangle on one side, and a moved
     triangle started inside r, so nothing outside that sphere can be involved
     in a NEW one. */
  function reachTriangles(S, D) {
    var reach = S.grab.r + Math.sqrt(D[0] * D[0] + D[1] * D[1] + D[2] * D[2]) + 1, r2 = reach * reach;
    var tri = S.mesh.tri, T = S.mesh.triCount, c = S.grab.c, bp = S.basePos, sel = [];
    for (var t = 0; t < T; t++) {
      for (var k = 0; k < 3; k++) {
        var o = tri[t * 3 + k] * 3;
        var dx = bp[o] - c[0], dy = bp[o + 1] - c[1], dz = bp[o + 2] - c[2];
        if (dx * dx + dy * dy + dz * dz <= r2) { sel.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]); break; }
      }
    }
    return new Int32Array(sel);
  }

  function f32(pos) {
    var o = new Float64Array(pos.length);
    for (var i = 0; i < pos.length; i++) o[i] = Math.fround(pos[i]);
    return o;
  }

  /* SELF-INTERSECTION. Same triangles, base positions against moved ones, both
     rounded to float32 because that is what the soup the checker will see
     carries. */
  function pierceGuard(S, D, opts) {
    var R = opts.repair || root.NSO_Repair;
    if (!R || typeof R._selfIntersectionDetail !== 'function') {
      return { ok: false, unavailable: true,
               reason: 'the canonical self-intersection checker (NSO_Repair) is not loaded' };
    }
    var faces = reachTriangles(S, D);
    var before = R._selfIntersectionDetail({ pos: f32(S.basePos), faces: faces }).pierce;
    var after = R._selfIntersectionDetail({ pos: f32(S.pos), faces: faces }).pierce;
    var res = { ok: after <= before, before: before, after: after, triangles: faces.length / 3 };
    if (!res.ok) {
      res.reason = 'the moved surface would pass through itself (' + after + ' self-intersecting pair' +
        (after === 1 ? '' : 's') + ' where it had ' + before + ')';
    }
    return res;
  }

  function areaOf(pos, tri, t) {
    var a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    var wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    return Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
  }

  /* COLLAPSE. Triangles touching a moved vertex that are, or have become,
     zero-area. The count may not rise. */
  function collapseGuard(S) {
    var seen = new Uint8Array(S.mesh.triCount), tri = S.mesh.tri;
    var before = 0, after = 0;
    for (var q = 0; q < S.moved.length; q++) {
      var v = S.moved[q];
      for (var j = S.vtStart[v]; j < S.vtStart[v + 1]; j++) {
        var t = S.vtList[j];
        if (seen[t]) continue;
        seen[t] = 1;
        if (areaOf(S.basePos, tri, t) <= 1e-12) before++;
        if (areaOf(S.pos, tri, t) <= 1e-12) after++;
      }
    }
    var res = { ok: after <= before, before: before, after: after };
    if (!res.ok) res.reason = 'the move would collapse ' + (after - before) + ' triangle' +
      (after - before === 1 ? '' : 's') + ' to nothing - the surface folds over itself';
    return res;
  }

  /* ------------------------------------------------------------------ finish */

  function finish(S, D, opts) {
    opts = opts || {};
    var res = { ok: false, reason: '', tris: S.origTris, report: null };
    var len = Math.sqrt(D[0] * D[0] + D[1] * D[1] + D[2] * D[2]);
    if (!(len > 1e-9)) { res.ok = true; res.noop = true; res.reason = 'the grab did not move'; return res; }
    displace(S, D);

    var outTris = Densify.toSoup(S.mesh, S.pos);

    var collapse = collapseGuard(S);
    if (!collapse.ok) { res.reason = collapse.reason; res.report = { collapse: collapse }; return res; }

    var wall = wallGuard(S, outTris, opts);
    if (!wall.ok) { res.reason = wall.reason; res.report = { wall: wall }; return res; }

    var pierce = pierceGuard(S, D, opts);
    if (!pierce.ok) { res.reason = pierce.reason; res.report = { wall: wall, pierce: pierce }; return res; }

    res.ok = true;
    res.tris = outTris;
    res.report = {
      moved: S.moved.length, zone: S.zone.length, length: len,
      densify: S.densify, wall: wall, pierce: pierce, collapse: collapse,
      trisBefore: (S.origTris.length / 9) | 0, trisAfter: S.mesh.triCount
    };
    return res;
  }

  /* One call, for a headless caller: spec { grab:{c,r}, pins:[{c,r}], D:[x,y,z] }. */
  function pull(rawTris, spec, opts) {
    var S = prepare(rawTris, spec.grab, spec.pins || [], opts);
    if (!S.ok) return { ok: false, reason: S.reason, tris: rawTris, S: S };
    displace(S, spec.D);
    var f = finish(S, spec.D, opts);
    f.S = S;
    return f;
  }

  var API = {
    SPACING: SPACING, NOZZLE: NOZZLE, FLOOR_NOZZLES: FLOOR_NOZZLES,
    bell: bell, phiAt: phiAt, prepare: prepare, displace: displace, finish: finish, pull: pull,
    vertexNormals: vertexNormals, wallGuard: wallGuard, pierceGuard: pierceGuard
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Pull = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
