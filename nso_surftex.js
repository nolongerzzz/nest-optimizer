/* nso_surftex.js - Surface wrap: lay ONE feature - a ball, spike, pyramid, bump, dent or line - over a face, as many times as the
   spacing asks, and bake the result into the mesh. docs/SURFTEX.md.

   Loads as a classic script (window.NSO_SurfTex) and as a Node module (needs nso_cdt.js and nso_weave.js). No DOM, no THREE.
   The soup is the app's usual triangle soup (9 numbers a triangle, counter-clockwise from outside).

     NSO_SurfTex.regions(soup, opts)          -> { M, list }    the piece cut into smooth faces, each fitted: plane / cylinder / sphere / free
     NSO_SurfTex.apply(soup, picks, params)   -> { ok, soup, stats, perFace } | { ok: false, reason }
     NSO_SurfTex.resolve(params)              -> the full parameter set (defaults, density -> spacing)
     NSO_SurfTex.PRESETS                      -> the named skins (nso_surftex_presets.js)

   THE IDEA. A wrap is a single feature (the MOTIF), a lattice (the LAYOUT) and a face. Nothing about it depends on which face:

     1. The face is a smooth region of the mesh (a flood over neighbouring triangles whose normals differ by less than `crease`).
        It is fitted - plane, cylinder (outside or a bore), sphere, or free (anything else a view along its mean normal can see
        whole) - and the fit says how to unroll it: a CHART, a map from the face to the plane, and its inverse, the LIFT.
          plane     identity                         cylinder  unrolled: x = arc length, y = along the axis (periodic when it wraps)
          sphere    stereographic about the pole     free      orthographic along the mean normal, height from the face itself
     2. Tile centres come off the lattice (grid / stagger / hex / diamond) in the chart - on a cylinder the column count is made
        a whole number, so the wrap closes; on a sphere the rows are latitude rings with as many tiles as fit. A tile that does not
        fit whole inside the face (clear of the rim by `margin`) is left out: the rim is held, corner for corner.
     3. Each tile brings its own points: the apex, the footprint's corners, the rings between - exactly the points the feature
        is made of - and its footprint edges and ridge lines as FORCED edges. The rest of the face is filled with a coarse hex of
        points (fine enough that a chord never strays more than ~0.03 mm from a curved face).
     4. All of it is triangulated at once by a constrained Delaunay triangulation (nso_cdt.js) in the chart, the rim edges as the
        outline - so the new patch meets the old mesh at the rim corner for corner, with no weld and no boolean.
     5. Every point is lifted back onto the face and moved along the face's normal by its height (plus for a ball, a spike, a ridge;
        minus for a dent, a groove). Rim points do not move. The patch replaces the face's triangles.

   WHAT IT NEEDS: a face whose outline is a clean loop (or two, for a cylinder's side) - what a lasso-free flood gives on a clean
   mesh - and room: a tile that would cross the outline is not placed. A tile is never allowed to overlap its neighbour: if the size
   asked is more than the spacing allows, every footprint is shrunk together until they touch, and the readout says so.

   PAINT SCOPE: NOT APPLICABLE here - this file reads a soup and returns a new one. The app's card carries the paint check (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var CDT = root && root.NSO_CDT ? root.NSO_CDT : null;
  if (!CDT && typeof module !== 'undefined' && typeof require === 'function') { try { CDT = require('./nso_cdt.js'); } catch (e) { CDT = null; } }
  var Weave = root && root.NSO_Weave ? root.NSO_Weave : null;
  if (!Weave && typeof module !== 'undefined' && typeof require === 'function') { try { Weave = require('./nso_weave.js'); } catch (e) { Weave = null; } }

  var DEG = Math.PI / 180, TAU = 2 * Math.PI;

  var DEFAULTS = {
    motif: 'spike',     // 'spike' | 'ball' | 'bump' | 'dent' | 'line'
    size: 4,            // footprint across (u), mm: a cone's / ball's / dent's diameter, a pyramid's side, a line's width
    sizeV: 0,           // footprint along (v), mm: 0 = as `size` (a line: the row pitch, so lines run on end to end)
    sides: 0,           // spike: 0 a round cone, 3..8 an n-sided pyramid (4: square)
    rot: 0,             // degrees, turns every feature about the face's normal
    height: 3,          // mm a ball / spike / bump / ridge stands off the face
    depth: 0.6,         // mm a dent / groove goes into it
    curve: 1,           // spike profile: 1 straight, < 1 blunt (a soft tip), > 1 needle
    profile: 'tri',     // line: 'tri' | 'round' | 'flat'
    ridge: true,        // line: a ridge (true) or a groove (false)
    taper: -1,          // line: mm the ends slope down over; -1 = none when lines run end to end, else half the width
    layout: 'grid',     // 'grid' | 'stagger' | 'hex' | 'diamond'
    spacing: 5,         // mm between feature centres across (u)
    spacingV: 0,        // mm between rows (v): 0 = as `spacing` (hex: the equilateral row pitch)
    density: 0,         // features per cm2: when > 0 it sets the spacing
    angle: 0,           // degrees: turns the whole lattice (flat and free faces)
    margin: 0.4,        // mm a feature stays clear of the face's rim
    fillStep: 0,        // mm: the coarse points between features (0 = chosen from the curvature)
    crease: 30,         // degrees: neighbouring triangles turned more than this are different faces
    maxTiles: 40000,
    maxPoints: 700000
  };

  function V3(x, y, z) { return [x, y, z]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
  function unit(a) { var L = len(a); return L > 1e-300 ? [a[0] / L, a[1] / L, a[2] / L] : [0, 0, 1]; }
  function refuse(reason, extra) { var r = { ok: false, reason: reason }; for (var k in extra || {}) r[k] = extra[k]; return r; }
  function fmt(x, d) { var k = Math.pow(10, d == null ? 1 : d); return (Math.round(x * k) / k).toFixed(d == null ? 1 : d); }
  function jitter(i) { var x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; }
  function anyPerp(n) { var a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return unit(cross(n, a)); }

  /* ------------------------------------------------------------------ parameters */

  /* The full parameter set. Density, when given, is the spacing: the lattice cell is spacing x row pitch, and a cm2 holds 100 / (cell). */
  function resolve(p) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in p || {}) if (p[k] !== undefined && p[k] !== null && !(typeof p[k] === 'number' && isNaN(p[k]))) o[k] = p[k];
    o.motif = ['spike', 'ball', 'bump', 'dent', 'line'].indexOf(o.motif) >= 0 ? o.motif : 'spike';
    o.layout = ['grid', 'stagger', 'hex', 'diamond'].indexOf(o.layout) >= 0 ? o.layout : 'grid';
    o.sides = Math.max(0, Math.min(8, Math.round(o.sides)));
    if (o.sides === 1 || o.sides === 2) o.sides = 3;
    var aspect = o.layout === 'hex' ? 0.8660254 : o.layout === 'diamond' ? 0.5 : 1;
    if (o.density > 0) {
      var vr = o.spacingV > 0 && o.spacing > 0 ? o.spacingV / o.spacing : 1;
      o.spacing = Math.sqrt(100 / (o.density * aspect * vr));
      if (o.spacingV > 0) o.spacingV = o.spacing * vr;
    }
    o.spacing = Math.max(0.05, o.spacing);
    var sv = o.spacingV > 0 ? o.spacingV : o.spacing;
    o.rowPitch = o.layout === 'hex' ? (o.spacingV > 0 ? o.spacingV : o.spacing * 0.8660254) : o.layout === 'diamond' ? sv / 2 : sv;
    o.offsetRows = o.layout !== 'grid';
    o.size = Math.max(0.05, o.size);
    if (o.motif === 'line') {
      if (!(o.sizeV > 0)) o.sizeV = o.layout === 'diamond' ? sv : (o.layout === 'hex' ? o.rowPitch : sv);
    } else if (!(o.sizeV > 0)) o.sizeV = o.size;
    o.height = Math.max(0.01, o.height); o.depth = Math.max(0.01, o.depth);
    o.curve = Math.max(0.2, Math.min(4, o.curve));
    o.margin = Math.max(0, o.margin);
    if (o.motif === 'line') {
      var cont = o.sizeV >= sv - 1e-9;
      o.taperMm = o.taper >= 0 ? o.taper : (cont ? 0 : o.size / 2);
    }
    return o;
  }

  /* ------------------------------------------------------------------ the motif */

  /* One feature in its own frame: a = across (u), b = along (v), h = off the face. `f` scales the footprint (the overlap fit).
     -> { outline: [[a, b]] convex, ccw; samples: [[a, b, h]]; segs: [[i, j]] forced edges among the samples; rc: circumradius } */
  function ringCount(rx, ry) { var m = Math.max(rx, ry); return Math.max(12, Math.min(40, Math.round(Math.PI * 2 * m / 0.9 / 4) * 4)); }

  function motifModel(o, f) {
    var W = o.size * f, L = o.sizeV * f, rx = W / 2, ry = L / 2, rot = o.rot * DEG, cr = Math.cos(rot), sr = Math.sin(rot);
    var samples = [], segs = [], outline = [], i, j;
    function S(a, b, h) { samples.push([a, b, h]); return samples.length - 1; }
    function G(i0, j0) { if (i0 !== j0) segs.push([i0, j0]); }
    var H = o.motif === 'dent' ? -o.depth : o.motif === 'line' && !o.ridge ? -o.depth : o.height;
    var ns, apex, rings, k;

    if (o.motif === 'spike' && o.sides >= 3) {                        // an n-sided pyramid; `size` is the side
      var n = o.sides, Rc = W / (2 * Math.sin(Math.PI / n)), Rcy = L / (2 * Math.sin(Math.PI / n)), corners = [];
      apex = S(0, 0, H);
      for (i = 0; i < n; i++) {
        var ang = Math.PI / n + TAU * i / n;
        corners.push(S(Rc * Math.cos(ang), Rcy * Math.sin(ang), 0));
        outline.push([Rc * Math.cos(ang), Rcy * Math.sin(ang)]);
      }
      for (i = 0; i < n; i++) { G(apex, corners[i]); G(corners[i], corners[(i + 1) % n]); }
    } else if (o.motif === 'line') {
      var across = [], hs = [];
      if (o.profile === 'round') {
        for (k = 0; k <= 6; k++) { var ph = Math.PI - k * Math.PI / 6; across.push(rx * Math.cos(ph)); hs.push(Math.abs(H) * Math.sin(ph) * (H < 0 ? -1 : 1)); }
        across[0] = -rx; across[6] = rx; hs[0] = 0; hs[6] = 0;
      } else if (o.profile === 'flat') {
        var tw = rx * 0.5; across = [-rx, -tw, tw, rx]; hs = [0, H, H, 0];
      } else { across = [-rx, 0, rx]; hs = [0, H, 0]; }
      var bs = [-ry], tp = Math.min(o.taperMm * f, ry * 0.95);
      if (tp > 1e-6) bs.push(-ry + tp);
      var step = 3, mid0 = bs[bs.length - 1], mid1 = tp > 1e-6 ? ry - tp : ry, nm = Math.max(1, Math.ceil((mid1 - mid0) / step));
      for (k = 1; k < nm; k++) bs.push(mid0 + (mid1 - mid0) * k / nm);
      if (tp > 1e-6) bs.push(ry - tp);
      bs.push(ry);
      var grid = [];
      for (j = 0; j < bs.length; j++) {
        var row = [], scale = (tp > 1e-6 && (j === 0 || j === bs.length - 1)) ? 0 : 1;
        for (i = 0; i < across.length; i++) row.push(S(across[i], bs[j], hs[i] * scale));
        grid.push(row);
      }
      for (j = 0; j < grid.length; j++) for (i = 0; i < across.length; i++) {
        if (i + 1 < across.length) G(grid[j][i], grid[j][i + 1]);
        if (j + 1 < grid.length) G(grid[j][i], grid[j + 1][i]);
      }
      outline = [[-rx, -ry], [rx, -ry], [rx, ry], [-rx, ry]];
    } else {                                                          // round: cone, ball, bump, dent
      ns = ringCount(rx, ry);
      var prof;
      if (o.motif === 'ball' || o.motif === 'dent') {
        var Hm = Math.min(Math.abs(H), rx * 0.999), th = 2 * Math.atan(Hm / rx), Rb = rx / Math.sin(th), sgn = H < 0 ? -1 : 1;
        rings = 6;
        prof = function (q) { var t = q * th; return { r: Math.sin(t) / Math.sin(th), h: sgn * Rb * (Math.cos(t) - Math.cos(th)) * (Math.abs(H) / Hm) }; };
        // q runs 0 (apex) .. 1 (the rim); the sphere is stepped by angle, so the rings bunch where it is steep
      } else if (o.motif === 'bump') {
        rings = 5;
        prof = function (q) { var c = Math.cos(q * Math.PI / 2); return { r: q, h: H * c * c }; };
      } else {                                                         // a round spike
        rings = Math.abs(o.curve - 1) < 1e-6 ? 1 : 4;
        prof = function (q) { return { r: q, h: H * Math.pow(1 - q, o.curve) }; };
      }
      var P0 = prof(0);
      apex = S(0, 0, P0.h);
      var prev = null;
      for (k = 1; k <= rings; k++) {
        var pr = prof(k / rings), cur = [];
        for (i = 0; i < ns; i++) { var an = TAU * i / ns; cur.push(S(rx * pr.r * Math.cos(an), ry * pr.r * Math.sin(an), k === rings ? 0 : pr.h)); }
        for (i = 0; i < ns; i++) {
          G(cur[i], cur[(i + 1) % ns]);
          G(prev ? prev[i] : apex, cur[i]);
        }
        prev = cur;
      }
      for (i = 0; i < ns; i++) { var an2 = TAU * i / ns; outline.push([rx * Math.cos(an2), ry * Math.sin(an2)]); }
    }
    // turn the whole motif
    function turn(p) { return [p[0] * cr - p[1] * sr, p[0] * sr + p[1] * cr]; }
    for (i = 0; i < samples.length; i++) { var t = turn(samples[i]); samples[i] = [t[0], t[1], samples[i][2]]; }
    for (i = 0; i < outline.length; i++) outline[i] = turn(outline[i]);
    var rc = 0;
    for (i = 0; i < outline.length; i++) rc = Math.max(rc, Math.hypot(outline[i][0], outline[i][1]));
    return { outline: outline, samples: samples, segs: segs, rc: rc };
  }

  /* ------------------------------------------------------------------ the welded mesh, the faces, the fits */

  function prepare(soup) { return Weave.prepare(soup); }

  /* Smooth faces: neighbouring triangles whose normals are within `crease` of each other. */
  function regions(soup, opts) {
    var o = opts || {}, crease = o.crease != null ? o.crease : DEFAULTS.crease, minArea = o.minArea != null ? o.minArea : 1;
    var M = prepare(soup), cosT = Math.cos(crease * DEG), label = new Int32Array(M.n).fill(-1), list = [], s0, q = [], qh, t, k;
    for (s0 = 0; s0 < M.n; s0++) {
      if (label[s0] >= 0 || !(M.area[s0] > 0)) continue;
      var id = list.length, tris = [], area = 0;
      q.length = 0; q.push(s0); label[s0] = id; qh = 0;
      while (qh < q.length) {
        t = q[qh++]; tris.push(t); area += M.area[t];
        for (k = 0; k < 3; k++) {
          var nb = M.nbr[3 * t + k];
          if (nb < 0 || label[nb] >= 0 || !(M.area[nb] > 0)) continue;
          var d = M.nrm[3 * t] * M.nrm[3 * nb] + M.nrm[3 * t + 1] * M.nrm[3 * nb + 1] + M.nrm[3 * t + 2] * M.nrm[3 * nb + 2];
          if (d < cosT) continue;
          label[nb] = id; q.push(nb);
        }
      }
      var mask = new Uint8Array(M.n);
      for (k = 0; k < tris.length; k++) mask[tris[k]] = 1;
      list.push({ id: id, mask: mask, tris: Int32Array.from(tris), area: area });
    }
    list = list.filter(function (r) { return r.area >= minArea; });
    list.sort(function (a, b) { return b.area - a.area; });
    list.forEach(function (r, i) { r.id = i; r.fit = fitRegion(M, r); r.label = describe(r); });
    return { M: M, list: list };
  }

  function describe(r) {
    var f = r.fit, a = fmt(r.area, 0) + ' mm²';
    if (f.kind === 'plane') return 'Flat face · ' + a;
    if (f.kind === 'cylinder') return (f.concave ? 'Bore Ø' + fmt(2 * f.R, 1) : 'Cylinder Ø' + fmt(2 * f.R, 1)) + ' · ' + a;
    if (f.kind === 'sphere') return (f.concave ? 'Hollow sphere R' : 'Sphere R') + fmt(f.R, 1) + ' · ' + a;
    return 'Contoured face · ' + a;
  }

  function eig3(C) {            // Jacobi eigenvalues / vectors of a symmetric 3x3 -> { w: [..], v: [[col0], [col1], [col2]] }
    var A = [C[0].slice(), C[1].slice(), C[2].slice()], Vm = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], it, p, q, r;
    for (it = 0; it < 40; it++) {
      p = 0; q = 1; var mx = Math.abs(A[0][1]);
      if (Math.abs(A[0][2]) > mx) { p = 0; q = 2; mx = Math.abs(A[0][2]); }
      if (Math.abs(A[1][2]) > mx) { p = 1; q = 2; mx = Math.abs(A[1][2]); }
      if (mx < 1e-14) break;
      var th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (r = 0; r < 3; r++) { var arp = A[r][p], arq = A[r][q]; A[r][p] = c * arp - s * arq; A[r][q] = s * arp + c * arq; }
      for (r = 0; r < 3; r++) { var apr = A[p][r], aqr = A[q][r]; A[p][r] = c * apr - s * aqr; A[q][r] = s * apr + c * aqr; }
      for (r = 0; r < 3; r++) { var vrp = Vm[r][p], vrq = Vm[r][q]; Vm[r][p] = c * vrp - s * vrq; Vm[r][q] = s * vrp + c * vrq; }
    }
    var w = [A[0][0], A[1][1], A[2][2]], cols = [[Vm[0][0], Vm[1][0], Vm[2][0]], [Vm[0][1], Vm[1][1], Vm[2][1]], [Vm[0][2], Vm[1][2], Vm[2][2]]];
    return { w: w, v: cols };
  }

  function solveN(A, b) {       // Gaussian elimination with pivoting, small dense
    var n = b.length, i, j, k;
    for (i = 0; i < n; i++) {
      var piv = i;
      for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      if (Math.abs(A[piv][i]) < 1e-300) return null;
      var tmp = A[i]; A[i] = A[piv]; A[piv] = tmp; var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      for (j = i + 1; j < n; j++) { var fct = A[j][i] / A[i][i]; for (k = i; k < n; k++) A[j][k] -= fct * A[i][k]; b[j] -= fct * b[i]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var sx = b[i]; for (j = i + 1; j < n; j++) sx -= A[i][j] * x[j]; x[i] = sx / A[i][i]; }
    return x;
  }

  /* What a face is: plane, cylinder, sphere or free. */
  function fitRegion(M, reg) {
    var tris = reg.tris, P = M.P, t, k, i;
    var sn = [0, 0, 0], vseen = new Map(), vs = [];
    for (i = 0; i < tris.length; i++) {
      t = tris[i];
      sn[0] += M.area[t] * M.nrm[3 * t]; sn[1] += M.area[t] * M.nrm[3 * t + 1]; sn[2] += M.area[t] * M.nrm[3 * t + 2];
      for (k = 0; k < 3; k++) { var v = M.vid[3 * t + k]; if (!vseen.has(v)) { vseen.set(v, 1); vs.push(v); } }
    }
    var mean = unit(sn), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], cen = [0, 0, 0];
    vs.forEach(function (v) { for (var a = 0; a < 3; a++) { var x = P[3 * v + a]; if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x; cen[a] += x / vs.length; } });
    var diag = len(sub(hi, lo)), out = { kind: 'free', dir: mean, diag: diag, lo: lo, hi: hi, centroid: cen };
    // plane
    var cosP = Math.cos(1.0 * DEG), planar = true, dmax = 0;
    for (i = 0; i < tris.length && planar; i++) {
      t = tris[i];
      if (M.nrm[3 * t] * mean[0] + M.nrm[3 * t + 1] * mean[1] + M.nrm[3 * t + 2] * mean[2] < cosP) planar = false;
    }
    if (planar) {
      for (i = 0; i < vs.length; i++) dmax = Math.max(dmax, Math.abs((P[3 * vs[i]] - cen[0]) * mean[0] + (P[3 * vs[i] + 1] - cen[1]) * mean[1] + (P[3 * vs[i] + 2] - cen[2]) * mean[2]));
      if (dmax < 1e-3 + 1e-4 * diag) { out.kind = 'plane'; out.n = mean; out.origin = cen; return out; }
    }
    // cylinder: the normals all stand across one axis
    var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], tot = 0;
    for (i = 0; i < tris.length; i++) {
      t = tris[i]; var nn = [M.nrm[3 * t], M.nrm[3 * t + 1], M.nrm[3 * t + 2]];
      for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) C[r][c] += M.area[t] * nn[r] * nn[c];
      tot += M.area[t];
    }
    var E = eig3(C), order = [0, 1, 2].sort(function (a, b) { return E.w[a] - E.w[b]; });
    if (E.w[order[0]] / tot < 0.002) {
      var axis = unit(E.v[order[0]]), eref = anyPerp(axis), eperp = cross(axis, eref);
      var D = [], b3 = [], pts2 = [], zlo = Infinity, zhi = -Infinity;
      var m = [0, 0, 0];
      vs.forEach(function (v) { var d0 = [P[3 * v] - cen[0], P[3 * v + 1] - cen[1], P[3 * v + 2] - cen[2]]; pts2.push([dot(d0, eref), dot(d0, eperp), dot(d0, axis)]); });
      // Kasa circle fit in the plane across the axis
      var AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atb = [0, 0, 0];
      pts2.forEach(function (p) {
        var row = [p[0], p[1], 1], rhs = -(p[0] * p[0] + p[1] * p[1]);
        for (var a = 0; a < 3; a++) { for (var b = 0; b < 3; b++) AtA[a][b] += row[a] * row[b]; Atb[a] += row[a] * rhs; }
      });
      var sol = solveN(AtA, Atb);
      if (sol) {
        var cx = -sol[0] / 2, cy = -sol[1] / 2, R2 = cx * cx + cy * cy - sol[2];
        if (R2 > 0) {
          var R = Math.sqrt(R2), rres = 0;
          pts2.forEach(function (p) { rres = Math.max(rres, Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - R)); if (p[2] < zlo) zlo = p[2]; if (p[2] > zhi) zhi = p[2]; });
          if (rres < 0.004 * R + 2e-3 && R > 0.2) {
            var c0 = add(add(cen, mul(eref, cx)), mul(eperp, cy)), conc = 0;
            for (i = 0; i < tris.length; i++) {
              t = tris[i];
              var tc = M.centroidOf ? M.centroidOf(t) : [(P[3 * M.vid[3 * t]] + P[3 * M.vid[3 * t + 1]] + P[3 * M.vid[3 * t + 2]]) / 3, (P[3 * M.vid[3 * t] + 1] + P[3 * M.vid[3 * t + 1] + 1] + P[3 * M.vid[3 * t + 2] + 1]) / 3, (P[3 * M.vid[3 * t] + 2] + P[3 * M.vid[3 * t + 1] + 2] + P[3 * M.vid[3 * t + 2] + 2]) / 3];
              var rad = sub(tc, c0); rad = sub(rad, mul(axis, dot(rad, axis)));
              conc += M.area[t] * (M.nrm[3 * t] * rad[0] + M.nrm[3 * t + 1] * rad[1] + M.nrm[3 * t + 2] * rad[2]) / (len(rad) + 1e-12);
            }
            c0 = add(c0, mul(axis, 0));
            out.kind = 'cylinder'; out.axis = axis; out.c0 = c0; out.R = R; out.concave = conc < 0; out.eref = eref; out.eperp = eperp;
            out.cenAxial = 0; return out;
          }
        }
      }
    }
    // sphere: |p - c|^2 = R^2, linear in (c, R^2 - |c|^2)
    var AtA4 = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], Atb4 = [0, 0, 0, 0];
    vs.forEach(function (v) {
      var d0 = [P[3 * v] - cen[0], P[3 * v + 1] - cen[1], P[3 * v + 2] - cen[2]], row = [2 * d0[0], 2 * d0[1], 2 * d0[2], 1], rhs = d0[0] * d0[0] + d0[1] * d0[1] + d0[2] * d0[2];
      for (var a = 0; a < 4; a++) { for (var b = 0; b < 4; b++) AtA4[a][b] += row[a] * row[b]; Atb4[a] += row[a] * rhs; }
    });
    var s4 = solveN(AtA4, Atb4);
    if (s4) {
      var Rs2 = s4[3] + s4[0] * s4[0] + s4[1] * s4[1] + s4[2] * s4[2];
      if (Rs2 > 0) {
        var Rs = Math.sqrt(Rs2), cs = [cen[0] + s4[0], cen[1] + s4[1], cen[2] + s4[2]], sres = 0, conv = 0, okn = 0;
        vs.forEach(function (v) { sres = Math.max(sres, Math.abs(Math.hypot(P[3 * v] - cs[0], P[3 * v + 1] - cs[1], P[3 * v + 2] - cs[2]) - Rs)); });
        if (sres < 0.004 * Rs + 2e-3 && Rs > 0.2 && Rs < 1e5) {
          for (i = 0; i < tris.length; i++) {
            t = tris[i];
            var tc2 = [(P[3 * M.vid[3 * t]] + P[3 * M.vid[3 * t + 1]] + P[3 * M.vid[3 * t + 2]]) / 3, (P[3 * M.vid[3 * t] + 1] + P[3 * M.vid[3 * t + 1] + 1] + P[3 * M.vid[3 * t + 2] + 1]) / 3, (P[3 * M.vid[3 * t] + 2] + P[3 * M.vid[3 * t + 1] + 2] + P[3 * M.vid[3 * t + 2] + 2]) / 3];
            var rd = unit(sub(tc2, cs)), dd = M.nrm[3 * t] * rd[0] + M.nrm[3 * t + 1] * rd[1] + M.nrm[3 * t + 2] * rd[2];
            conv += M.area[t] * dd; if (Math.abs(dd) > 0.9) okn += M.area[t];
          }
          if (okn > 0.95 * tot) { out.kind = 'sphere'; out.c = cs; out.R = Rs; out.concave = conv < 0; return out; }
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ surfaces: the chart and its lift */

  function loopPoints(M, loop) { return loop.map(function (v) { return [M.P[3 * v], M.P[3 * v + 1], M.P[3 * v + 2]]; }); }

  /* Each surface: { kind, chartOf(p3), lift(x, y) -> { p, n }, frame(x, y) -> { e1, e2 }, offsetXY(cx, cy, a, b) -> [x, y], period (0 or C) }. */
  function planeSurface(fit) {
    var n = fit.n, e1 = Math.abs(n[0]) < 0.99 ? unit(sub([1, 0, 0], mul(n, n[0]))) : unit(sub([0, 1, 0], mul(n, n[1]))), e2 = cross(n, e1), O = fit.origin;
    return {
      kind: 'plane', period: 0,
      chartOf: function (p) { var d = sub(p, O); return [dot(d, e1), dot(d, e2)]; },
      lift: function (x, y) { return { p: add(add(O, mul(e1, x)), mul(e2, y)), n: n }; },
      frame: function () { return { e1: e1, e2: e2 }; },
      offsetXY: function (cx, cy, a, b) { return [cx + a, cy + b]; }
    };
  }

  function cylinderSurface(fit) {
    var R = fit.R, ax = fit.axis, c0 = fit.c0, er = fit.eref, ep = fit.eperp, sg = fit.concave ? -1 : 1;
    return {
      kind: 'cylinder', period: TAU * R, R: R, axis: ax,
      chartOf: function (p) { var d = sub(p, c0); return [R * Math.atan2(dot(d, ep), dot(d, er)), dot(d, ax)]; },
      lift: function (x, y) {
        var th = x / R, r = add(mul(er, Math.cos(th)), mul(ep, Math.sin(th)));
        return { p: add(add(c0, mul(r, R)), mul(ax, y)), n: mul(r, sg) };
      },
      frame: function (x) { var th = x / R; return { e1: add(mul(er, -Math.sin(th)), mul(ep, Math.cos(th))), e2: ax }; },
      offsetXY: function (cx, cy, a, b) { return [cx + a, cy + b]; }
    };
  }

  /* Stereographic about the pole direction A, projected from the antipode: a circle on the sphere is a circle in the chart, so a
     Delaunay triangulation of the chart is the Delaunay triangulation on the sphere. */
  function sphereSurface(fit, A) {
    var c = fit.c, R = fit.R, sg = fit.concave ? -1 : 1, er = anyPerp(A), ep = cross(A, er);
    function frameAt(az, th) {
      var r = add(mul(er, Math.cos(az)), mul(ep, Math.sin(az)));
      return { r: r, east: add(mul(er, -Math.sin(az)), mul(ep, Math.cos(az))), up: add(mul(A, Math.cos(th)), mul(r, Math.sin(th))), north: add(mul(A, -Math.sin(th)), mul(r, Math.cos(th))) };
    }
    var S = {
      kind: 'sphere', period: 0, R: R, A: A, c: c,
      chartOf: function (p) {
        var d = unit(sub(p, c)), th = Math.acos(Math.max(-1, Math.min(1, dot(d, A)))), az = Math.atan2(dot(d, ep), dot(d, er)), rho = 2 * R * Math.tan(th / 2);
        return [rho * Math.cos(az), rho * Math.sin(az)];
      },
      lift: function (x, y) {
        var rho = Math.hypot(x, y), th = 2 * Math.atan(rho / (2 * R)), az = Math.atan2(y, x), fr = frameAt(az, th);
        return { p: add(c, mul(fr.up, R)), n: mul(fr.up, sg) };
      },
      frame: function (x, y) {
        var rho = Math.hypot(x, y), th = 2 * Math.atan(rho / (2 * R)), az = Math.atan2(y, x), fr = frameAt(az, th);
        return { e1: fr.east, e2: mul(fr.north, -1) };
      },
      offsetXY: function (cx, cy, a, b) {
        var l = S.lift(cx, cy), fr = S.frame(cx, cy), up = unit(sub(l.p, c));
        var p = unit(sub(add(add(l.p, mul(fr.e1, a)), mul(fr.e2, b)), c)); p = add(c, mul(p, R));
        return S.chartOf(p);
      }
    };
    return S;
  }

  /* A face seen from above: a view along its mean normal, the height and the normal read off the face itself. */
  function freeSurface(M, reg, fit) {
    var d = fit.dir, u = anyPerp(d), v = cross(d, u), O = fit.centroid, P = M.P, tris = reg.tris, i, k;
    // vertex normals over the face
    var vn = new Map();
    for (i = 0; i < tris.length; i++) {
      var t = tris[i];
      for (k = 0; k < 3; k++) {
        var vv = M.vid[3 * t + k], a = vn.get(vv);
        if (!a) { a = [0, 0, 0]; vn.set(vv, a); }
        a[0] += M.area[t] * M.nrm[3 * t]; a[1] += M.area[t] * M.nrm[3 * t + 1]; a[2] += M.area[t] * M.nrm[3 * t + 2];
      }
    }
    vn.forEach(function (a, key) { var q = unit(a); a[0] = q[0]; a[1] = q[1]; a[2] = q[2]; });
    // a bin grid over the chart
    var xs = [], tri2 = [], lox = Infinity, loy = Infinity, hix = -Infinity, hiy = -Infinity, ed = 0;
    for (i = 0; i < tris.length; i++) {
      var tt = tris[i], pp = [];
      for (k = 0; k < 3; k++) {
        var id = M.vid[3 * tt + k], p3 = [P[3 * id], P[3 * id + 1], P[3 * id + 2]], dd = sub(p3, O);
        pp.push({ id: id, x: dot(dd, u), y: dot(dd, v), z: dot(dd, d), p: p3 });
      }
      tri2.push(pp);
      pp.forEach(function (q) { if (q.x < lox) lox = q.x; if (q.x > hix) hix = q.x; if (q.y < loy) loy = q.y; if (q.y > hiy) hiy = q.y; });
      ed += Math.hypot(pp[0].x - pp[1].x, pp[0].y - pp[1].y);
    }
    var cell = Math.max(0.5, ed / tri2.length * 2), nx = Math.max(1, Math.ceil((hix - lox) / cell)), ny = Math.max(1, Math.ceil((hiy - loy) / cell));
    while (nx * ny > 4e6) { cell *= 1.5; nx = Math.max(1, Math.ceil((hix - lox) / cell)); ny = Math.max(1, Math.ceil((hiy - loy) / cell)); }
    var bins = new Array(nx * ny);
    tri2.forEach(function (pp, ti) {
      var x0 = Math.min(pp[0].x, pp[1].x, pp[2].x), x1 = Math.max(pp[0].x, pp[1].x, pp[2].x), y0 = Math.min(pp[0].y, pp[1].y, pp[2].y), y1 = Math.max(pp[0].y, pp[1].y, pp[2].y);
      for (var gx = Math.max(0, Math.floor((x0 - lox) / cell)); gx <= Math.min(nx - 1, Math.floor((x1 - lox) / cell)); gx++)
        for (var gy = Math.max(0, Math.floor((y0 - loy) / cell)); gy <= Math.min(ny - 1, Math.floor((y1 - loy) / cell)); gy++) {
          var b = bins[gx * ny + gy]; if (!b) b = bins[gx * ny + gy] = []; b.push(ti);
        }
    });
    function locate(x, y) {
      var gx = Math.floor((x - lox) / cell), gy = Math.floor((y - loy) / cell);
      if (gx < 0) gx = 0; if (gy < 0) gy = 0; if (gx >= nx) gx = nx - 1; if (gy >= ny) gy = ny - 1;
      var b = bins[gx * ny + gy], best = null, bestZ = -Infinity, bestSlack = Infinity, bestOff = null;
      if (!b) return null;
      for (var q = 0; q < b.length; q++) {
        var pp = tri2[b[q]], den = (pp[1].y - pp[2].y) * (pp[0].x - pp[2].x) + (pp[2].x - pp[1].x) * (pp[0].y - pp[2].y);
        if (Math.abs(den) < 1e-14) continue;
        var l0 = ((pp[1].y - pp[2].y) * (x - pp[2].x) + (pp[2].x - pp[1].x) * (y - pp[2].y)) / den, l1 = ((pp[2].y - pp[0].y) * (x - pp[2].x) + (pp[0].x - pp[2].x) * (y - pp[2].y)) / den, l2 = 1 - l0 - l1;
        var slack = Math.min(l0, l1, l2), z = l0 * pp[0].z + l1 * pp[1].z + l2 * pp[2].z;
        if (slack >= -1e-9) { if (z > bestZ || best === null || bestSlack < 0) { best = { pp: pp, l: [l0, l1, l2] }; bestZ = z; bestSlack = 0; } }
        else if (best === null && slack > -1e-3 && slack > -bestSlack) { /* just outside: a fallback for a point on the rim */ }
      }
      return best;
    }
    return {
      kind: 'free', period: 0, d: d, u: u, v: v,
      chartOf: function (p) { var dd = sub(p, O); return [dot(dd, u), dot(dd, v)]; },
      lift: function (x, y) {
        var h = locate(x, y);
        if (!h) return null;
        var pp = h.pp, l = h.l, p = [0, 0, 0], n = [0, 0, 0];
        for (var q = 0; q < 3; q++) {
          var nv = vn.get(pp[q].id);
          p[0] += l[q] * pp[q].p[0]; p[1] += l[q] * pp[q].p[1]; p[2] += l[q] * pp[q].p[2];
          n[0] += l[q] * nv[0]; n[1] += l[q] * nv[1]; n[2] += l[q] * nv[2];
        }
        return { p: p, n: unit(n) };
      },
      frame: function (x, y) {
        var l = this.lift(x, y); if (!l) return { e1: u, e2: v };
        var e1 = unit(sub(u, mul(l.n, dot(u, l.n)))); return { e1: e1, e2: cross(l.n, e1) };
      },
      offsetXY: function (cx, cy, a, b) {
        var l = this.lift(cx, cy); if (!l) return [cx + a, cy + b];
        var e1 = unit(sub(u, mul(l.n, dot(u, l.n)))), e2 = cross(l.n, e1);
        return this.chartOf(add(add(l.p, mul(e1, a)), mul(e2, b)));
      }
    };
  }

  /* ------------------------------------------------------------------ geometry helpers */

  function polyArea2(p) { var a = 0; for (var i = 0, n = p.length; i < n; i++) { var q = p[(i + 1) % n]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a; }

  function pipEvenOdd(loops, x, y) {
    var inside = false;
    for (var l = 0; l < loops.length; l++) {
      var L = loops[l];
      for (var i = 0, j = L.length - 1; i < L.length; j = i++) {
        var xi = L[i][0], yi = L[i][1], xj = L[j][0], yj = L[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
    }
    return inside;
  }

  /* Distance from a point to a set of 3D segments, by a hash grid. */
  function segIndex(segs, cell) {
    var g = new Map();
    function key(i, j, k) { return i + ',' + j + ',' + k; }
    segs.forEach(function (s, si) {
      var lo = [Math.min(s[0][0], s[1][0]), Math.min(s[0][1], s[1][1]), Math.min(s[0][2], s[1][2])], hi = [Math.max(s[0][0], s[1][0]), Math.max(s[0][1], s[1][1]), Math.max(s[0][2], s[1][2])];
      for (var i = Math.floor(lo[0] / cell); i <= Math.floor(hi[0] / cell); i++) for (var j = Math.floor(lo[1] / cell); j <= Math.floor(hi[1] / cell); j++) for (var k = Math.floor(lo[2] / cell); k <= Math.floor(hi[2] / cell); k++) {
        var kk = key(i, j, k), a = g.get(kk); if (!a) { a = []; g.set(kk, a); } a.push(si);
      }
    });
    return function (p, reach) {          // the smallest distance, looking `reach` out; Infinity when none is that near
      var best = Infinity, r = Math.ceil(reach / cell), ci = Math.floor(p[0] / cell), cj = Math.floor(p[1] / cell), ck = Math.floor(p[2] / cell);
      for (var i = ci - r; i <= ci + r; i++) for (var j = cj - r; j <= cj + r; j++) for (var k = ck - r; k <= ck + r; k++) {
        var a = g.get(key(i, j, k)); if (!a) continue;
        for (var q = 0; q < a.length; q++) {
          var s = segs[a[q]], ab = sub(s[1], s[0]), ap = sub(p, s[0]), L2 = dot(ab, ab), t = L2 > 0 ? Math.max(0, Math.min(1, dot(ap, ab) / L2)) : 0;
          var d = len(sub(p, add(s[0], mul(ab, t)))); if (d < best) best = d;
        }
      }
      return best;
    };
  }

  function satOverlap(A, B) {               // two convex polygons [[x, y]]: do their interiors overlap (more than a hair)?
    var polys = [A, B], eps = 1e-6;
    for (var w = 0; w < 2; w++) {
      var P = polys[w];
      for (var i = 0; i < P.length; i++) {
        var q = P[(i + 1) % P.length], nx = q[1] - P[i][1], ny = P[i][0] - q[0], L = Math.hypot(nx, ny);
        if (L < 1e-12) continue;
        nx /= L; ny /= L;
        var a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, k;
        for (k = 0; k < A.length; k++) { var d = A[k][0] * nx + A[k][1] * ny; if (d < a0) a0 = d; if (d > a1) a1 = d; }
        for (k = 0; k < B.length; k++) { var e = B[k][0] * nx + B[k][1] * ny; if (e < b0) b0 = e; if (e > b1) b1 = e; }
        if (a1 <= b0 + eps || b1 <= a0 + eps) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ one face */

  /* Tile centres on the lattice, in the chart. -> [{ x, y }] (before any is tested against the rim). */
  function latticeCentres(S, fit, o, chartLoops, C, ph) {
    ph = ph || [0, 0];
    var out = [], i, j, px = o.spacing, py = o.rowPitch, off = o.offsetRows;
    var lox = Infinity, loy = Infinity, hix = -Infinity, hiy = -Infinity;
    chartLoops.forEach(function (L) { L.forEach(function (p) { if (p[0] < lox) lox = p[0]; if (p[0] > hix) hix = p[0]; if (p[1] < loy) loy = p[1]; if (p[1] > hiy) hiy = p[1]; }); });
    if (S.kind === 'cylinder' && C) {                                   // wraps: a whole number of columns
      var N = Math.max(1, Math.round(C / px)); px = C / N; var rows = Math.ceil((hiy - loy) / py) + 2, ymid = (loy + hiy) / 2;
      for (j = -rows; j <= rows; j++) {
        var yy = ymid + (j + ph[1]) * py;
        if (yy < loy - py || yy > hiy + py) continue;
        for (i = 0; i < N; i++) out.push({ x: o.x0 + (i + (off && (j & 1) ? 0.5 : 0)) * px, y: yy, i: i, j: j });
      }
      return { tiles: out, px: px };
    }
    if (S.kind === 'sphere') {                                          // latitude rings from the pole
      var R = S.R, dth = py / R, thMax = fit.thMax, k, ring;
      for (k = 0; k * dth <= thMax + 1e-9; k++) {
        var th = k * dth, cnt = k === 0 ? 1 : Math.max(3, Math.round(TAU * R * Math.sin(th) / px)), ph = off && (k & 1) ? 0.5 : 0;
        for (i = 0; i < cnt; i++) {
          var az = TAU * (i + ph) / cnt, rho = 2 * R * Math.tan(th / 2);
          out.push({ x: rho * Math.cos(az), y: rho * Math.sin(az), ring: k, az: az });
        }
      }
      return { tiles: out, px: px };
    }
    // plane, free, partial cylinder: a lattice turned by `angle` about the chart's middle
    var cxm = (lox + hix) / 2, cym = (loy + hiy) / 2, ca = Math.cos(o.angle * DEG), sa = Math.sin(o.angle * DEG), rad = Math.hypot(hix - lox, hiy - loy) / 2 + px + py;
    var nI = Math.ceil(rad / px) + 1, nJ = Math.ceil(rad / py) + 1;
    for (j = -nJ; j <= nJ; j++) for (i = -nI; i <= nI; i++) {
      var lx = (i + ph[0] + (off && (j & 1) ? 0.5 : 0)) * px, ly = (j + ph[1]) * py, X = cxm + lx * ca - ly * sa, Y = cym + lx * sa + ly * ca;
      if (X < lox - px || X > hix + px || Y < loy - py || Y > hiy + py) continue;
      out.push({ x: X, y: Y, i: i, j: j });
    }
    return { tiles: out, px: px };
  }

  /* The wrap of one face. -> { ok, newP: [[x,y,z]] (non-rim corners), T: Int32Array (ids < M.nV: the mesh's; >= M.nV: nOld + index into newP, offset by `base`), ... } */
  function wrapFace(M, reg, o, base) {
    var fit = reg.fit, t0 = Date.now(), i, j, k;
    var mask = reg.mask, loopsRes = Weave.boundaryLoops(M, mask), notes = [];
    var mask2 = mask;
    if (!loopsRes.ok && /whole piece/.test(loopsRes.reason) && fit.kind === 'sphere') {
      // a closed sphere: leave a small cap at the far pole as the outline, so there is a rim to hold
      var Az = [0, 0, 1], cut = Math.cos((180 - 14) * DEG);
      mask2 = new Uint8Array(mask);
      for (i = 0; i < reg.tris.length; i++) {
        var t = reg.tris[i], cc = [(M.P[3 * M.vid[3 * t]] + M.P[3 * M.vid[3 * t + 1]] + M.P[3 * M.vid[3 * t + 2]]) / 3, (M.P[3 * M.vid[3 * t] + 1] + M.P[3 * M.vid[3 * t + 1] + 1] + M.P[3 * M.vid[3 * t + 2] + 1]) / 3, (M.P[3 * M.vid[3 * t] + 2] + M.P[3 * M.vid[3 * t + 1] + 2] + M.P[3 * M.vid[3 * t + 2] + 2]) / 3];
        if (dot(unit(sub(cc, fit.c)), Az) < cut) mask2[t] = 0;
      }
      loopsRes = Weave.boundaryLoops(M, mask2);
      notes.push('the bottom 14° of the sphere is left plain (the outline the wrap is held at)');
    }
    if (!loopsRes.ok) return refuse(loopsRes.reason);
    var loops = loopsRes.loops, tris = [];
    for (i = 0; i < M.n; i++) if (mask2[i]) tris.push(i);
    if (fit.kind === 'free') {
      var worst = 0, tot = 0;
      tris.forEach(function (t) { tot += M.area[t]; if (M.nrm[3 * t] * fit.dir[0] + M.nrm[3 * t + 1] * fit.dir[1] + M.nrm[3 * t + 2] * fit.dir[2] < 0.2) worst += M.area[t]; });
      if (worst > 0.02 * tot) return refuse('this face folds over itself when seen along its own normal (' + fmt(100 * worst / tot, 0) + '% of it is steeper than 78°) - try a smaller crease angle to split it, or wrap a flatter part');
    }
    var regFor = { tris: Int32Array.from(tris), mask: mask2 };
    // the surface
    var S;
    if (fit.kind === 'plane') S = planeSurface(fit);
    else if (fit.kind === 'cylinder') S = cylinderSurface(fit);
    else if (fit.kind === 'sphere') {
      var Asp = [0, 0, 1];
      if (loops.length) {                 // a cap: the pole is the cap's own middle
        var mn = [0, 0, 0], wsum = 0;
        tris.forEach(function (t) { var cc = [(M.P[3 * M.vid[3 * t]] + M.P[3 * M.vid[3 * t + 1]] + M.P[3 * M.vid[3 * t + 2]]) / 3, (M.P[3 * M.vid[3 * t] + 1] + M.P[3 * M.vid[3 * t + 1] + 1] + M.P[3 * M.vid[3 * t + 2] + 1]) / 3, (M.P[3 * M.vid[3 * t] + 2] + M.P[3 * M.vid[3 * t + 1] + 2] + M.P[3 * M.vid[3 * t + 2] + 2]) / 3], rd = unit(sub(cc, fit.c)); mn = add(mn, mul(rd, M.area[t])); wsum += M.area[t]; });
        var mlen = len(mn) / (wsum || 1);
        Asp = mlen > 0.05 ? unit(mn) : [0, 0, 1];
        if (mlen > 0.05 && Math.abs(Asp[2]) > 0.985 && fit.R) Asp = [0, 0, Asp[2] > 0 ? 1 : -1];
        if (loopsRes.loops.length && mlen <= 0.05) Asp = [0, 0, 1];
      }
      // the farthest corner from the pole: the chart's reach
      var thMax = 0;
      loops.forEach(function (L) { L.forEach(function (v) { var rd = unit(sub([M.P[3 * v], M.P[3 * v + 1], M.P[3 * v + 2]], fit.c)); thMax = Math.max(thMax, Math.acos(Math.max(-1, Math.min(1, dot(rd, Asp))))); }); });
      fit = Object.assign({}, fit, { thMax: thMax });
      if (thMax > 172 * DEG) return refuse('the face reaches too near the far pole for the sphere chart');
      S = sphereSurface(fit, Asp);
      if (fit.concave) S.concaveFlag = true;
    } else {
      S = freeSurface(M, regFor, fit);
    }
    // chart outline
    var period = S.period, C = 0, periodic = false, chartLoops = [], loopInfo = [];
    function unwrapLoop(L) {
      var pts = loopPoints(M, L).map(function (p) { return S.chartOf(p); }), out = [pts[0].slice()], r = fit.R;
      for (var q = 1; q < pts.length; q++) {
        var x = pts[q][0], px0 = out[q - 1][0];
        while (x - px0 > period / 2) x -= period;
        while (x - px0 < -period / 2) x += period;
        out.push([x, pts[q][1]]);
      }
      var closeDx = out[0][0] + 0 - out[out.length - 1][0], tail = pts[0][0];
      var xe = tail; while (xe - out[out.length - 1][0] > period / 2) xe -= period; while (xe - out[out.length - 1][0] < -period / 2) xe += period;
      return { pts: out, span: xe - out[0][0] };
    }
    if (S.kind === 'cylinder') {
      var infos = loops.map(function (L) { return unwrapLoop(L); });
      var wraps = infos.filter(function (inf) { return Math.abs(Math.abs(inf.span) - period) < 1e-3 * period; });
      if (loops.length === 2 && wraps.length === 2 && infos[0].span * infos[1].span < 0) periodic = true;
      else if (wraps.length) return refuse('this cylinder face wraps all the way round but has ' + loops.length + ' outlines - it should have two, one at each end');
      C = periodic ? period : 0;
      chartLoops = infos.map(function (inf) { return inf.pts; });
      loopInfo = infos;
    } else {
      chartLoops = loops.map(function (L) { return loopPoints(M, L).map(function (p) { return S.chartOf(p); }); });
      if (S.kind === 'cylinder') { }
    }
    // the surface chord: how far apart the coarse fill may be
    var curvR = S.kind === 'cylinder' || S.kind === 'sphere' ? S.R : (fit.diag || 100);
    var motif0 = motifModel(o, 1);
    var fillStep = o.fillStep > 0 ? o.fillStep : (S.kind === 'plane' ? Math.max(2, o.spacing) : Math.max(0.7, Math.min(3, Math.sqrt(8 * curvR * 0.03))));
    fillStep = Math.min(fillStep, Math.max(1, o.spacing * 1.2));
    var sx0 = 0;
    if (periodic) {
      o = Object.assign({}, o);
      o.x0 = chartLoops[0][0][0];
    }
    // tile centres
    var lat = latticeCentres(S, fit, o, chartLoops, C, [0, 0]);
    var cand = lat.tiles;
    if (cand.length > o.maxTiles * 4) return refuse('that spacing would put more than ' + o.maxTiles + ' features on this face - raise the spacing or lower the density');
    // inside test + rim distance
    var rimSegs = [];
    loops.forEach(function (L) { var pp = loopPoints(M, L); for (var q = 0; q < pp.length; q++) rimSegs.push([pp[q], pp[(q + 1) % pp.length]]); });
    var rimDist = rimSegs.length ? segIndex(rimSegs, Math.max(1, o.margin * 2, motif0.rc * 2)) : function () { return Infinity; };
    var ymin = -Infinity, ymax = Infinity;
    if (periodic) { ymin = Math.min(chartLoops[0][0][1], chartLoops[1][0][1]); ymax = Math.max(chartLoops[0][0][1], chartLoops[1][0][1]); }
    function placed(tile, f) {            // does the whole footprint (scaled f) stand inside the face, `margin` clear of the rim?
      var m = motifModel(o, f), pts = m.outline, step = Math.max(1, Math.floor(pts.length / 12));
      for (var q = 0; q < pts.length; q += step) {
        var xy = S.offsetXY(tile.x, tile.y, pts[q][0], pts[q][1]);
        if (periodic) { if (xy[1] < ymin + o.margin || xy[1] > ymax - o.margin) return false; continue; }
        if (!pipEvenOdd(chartLoops, xy[0], xy[1])) return false;
        var l = S.lift(xy[0], xy[1]); if (!l) return false;
        if (rimDist(l.p, o.margin + 1e-6) < o.margin) return false;
      }
      return true;
    }
    var f = 1, tiles = cand.filter(function (t) { return placed(t, 1); }), skipped = cand.length - tiles.length;
    if (S.kind !== 'sphere' && cand.length <= 6000) {            // the lattice may start half a pitch over: whichever phase puts more whole features on the face
      var phases = S.kind === 'cylinder' && periodic ? [[0, 0.5]] : [[0.5, 0], [0, 0.5], [0.5, 0.5]];
      phases.forEach(function (ph) {
        var c2 = latticeCentres(S, fit, o, chartLoops, C, ph).tiles, t2 = c2.filter(function (t) { return placed(t, 1); });
        if (t2.length > tiles.length) { tiles = t2; skipped = c2.length - t2.length; cand = c2; }
      });
    }
    if (!tiles.length) return refuse('no feature fits whole inside this face (clear of its edge by ' + fmt(o.margin, 2) + ' mm) - a smaller size, spacing or margin');
    if (tiles.length > o.maxTiles) return refuse(fmt(tiles.length, 0) + ' features on this face is more than the ' + o.maxTiles + ' the tool will lay - raise the spacing or lower the density');
    // overlap: shrink every footprint together until they touch
    var tileFrames = tiles.map(function (t) { var l = S.lift(t.x, t.y); var fr = S.frame(t.x, t.y); return { l: l, fr: fr }; });
    function outlines3(ff) {
      var m = motifModel(o, ff);
      return tiles.map(function (t, ti) {
        var fr = tileFrames[ti];
        return m.outline.map(function (p) { var xy = S.offsetXY(t.x, t.y, p[0], p[1]), l = S.lift(xy[0], xy[1]); return l ? l.p : fr.l.p; });
      });
    }
    function overlaps(ff) {
      var m = motifModel(o, ff), reach = 2 * m.rc + 1e-6, cell = Math.max(reach, 0.5), grid = new Map();
      tiles.forEach(function (t, ti) {
        var p = tileFrames[ti].l.p, key = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell) + ',' + Math.floor(p[2] / cell), a = grid.get(key);
        if (!a) { a = []; grid.set(key, a); } a.push(ti);
      });
      var out3 = outlines3(ff);
      for (var a2 = 0; a2 < tiles.length; a2++) {
        var p = tileFrames[a2].l.p, ci = Math.floor(p[0] / cell), cj = Math.floor(p[1] / cell), ck = Math.floor(p[2] / cell), n0 = tileFrames[a2].l.n, e1 = tileFrames[a2].fr.e1, e2 = cross(n0, e1);
        for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) for (var dk = -1; dk <= 1; dk++) {
          var arr = grid.get((ci + di) + ',' + (cj + dj) + ',' + (ck + dk)); if (!arr) continue;
          for (var q = 0; q < arr.length; q++) {
            var b2 = arr[q]; if (b2 <= a2) continue;
            var pb = tileFrames[b2].l.p; if (len(sub(pb, p)) > reach) continue;
            var A = out3[a2].map(function (v) { var d = sub(v, p); return [dot(d, e1), dot(d, e2)]; }), B = out3[b2].map(function (v) { var d = sub(v, p); return [dot(d, e1), dot(d, e2)]; });
            if (satOverlap(A, B)) return true;
          }
        }
      }
      return false;
    }
    var shrunk = 1;
    if (tiles.length > 1 && overlaps(1)) {
      var lo = 0.05, hi = 1;
      for (k = 0; k < 14; k++) { var mid = (lo + hi) / 2; if (overlaps(mid)) hi = mid; else lo = mid; }
      f = lo; shrunk = lo;
      tiles = tiles.filter(function (t) { return placed(t, f); });
      if (f < 0.995) notes.push('the features overlapped at the size asked, so every footprint was scaled to ' + Math.round(f * 100) + '% (they touch)');
    }
    if (S.kind !== 'plane' && S.kind !== 'cylinder' && (shrunk < 1 || o.size >= o.spacing * 0.995 || o.sizeV >= o.rowPitch * 0.995)) {
      // features that touch: on a sphere or a contoured face every tile has its own tangent frame, so two footprints that share an edge do not
      // quite share it (a few hundredths of a mm) and their forced edges would cross. A 2% gap between them is honest and keeps them apart.
      f *= 0.98;
      tiles = tiles.filter(function (t) { return placed(t, f); });
    }
    var motif = motifModel(o, f);
    tileFrames = tiles.map(function (t) { return { l: S.lift(t.x, t.y), fr: S.frame(t.x, t.y) }; });
    // ---- the points
    var span = 1, lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    chartLoops.forEach(function (L) { L.forEach(function (p) { if (p[0] < lx0) lx0 = p[0]; if (p[0] > lx1) lx1 = p[0]; if (p[1] < ly0) ly0 = p[1]; if (p[1] > ly1) ly1 = p[1]; }); });
    span = Math.max(lx1 - lx0, ly1 - ly0, 1);
    // corners of neighbouring features that are one corner (footprints that touch on a plane or a cylinder) are within a micron of each other
    var WELD = 1e-3;
    var bx = [], by = [], bh = [], brim = [], cellMap = new Map(), x0 = periodic ? o.x0 : 0, segsSoft = [];
    function wrapX(x) { if (!periodic) return { x: x, w: 0 }; var w = Math.floor((x - x0 + WELD) / C); return { x: x - w * C, w: w }; }
    function pointId(x, y, h, rimId) {         // -> { id, w }: points within a micron are one point
      var wx = wrapX(x), ci = Math.floor(wx.x / WELD), cj = Math.floor(y / WELD), id, di, dj, a, q;
      for (di = -1; di <= 1; di++) for (dj = -1; dj <= 1; dj++) {
        a = cellMap.get((ci + di) + ',' + (cj + dj)); if (!a) continue;
        for (q = 0; q < a.length; q++) if (Math.abs(bx[a[q]] - wx.x) < WELD && Math.abs(by[a[q]] - y) < WELD) {
          if (rimId != null && brim[a[q]] < 0) brim[a[q]] = rimId;
          return { id: a[q], w: wx.w };
        }
      }
      id = bx.length; bx.push(wx.x); by.push(y); bh.push(h); brim.push(rimId == null ? -1 : rimId);
      var kk = ci + ',' + cj, arr = cellMap.get(kk); if (!arr) { arr = []; cellMap.set(kk, arr); } arr.push(id);
      return { id: id, w: wx.w };
    }
    // rim corners
    var hardSegs = [], rimEdgeCount = 0, rimChains = [];
    loops.forEach(function (L, li) {
      var cp = chartLoops[li], refs = [];
      for (var q = 0; q < L.length; q++) refs.push(pointId(cp[q][0], cp[q][1], 0, L[q]));
      var chain = [];
      for (q = 0; q < L.length; q++) {
        var a = refs[q], b = refs[(q + 1) % L.length];
        var dkw = periodic ? (q === L.length - 1 ? (loopInfo[li].span > 0 ? 1 : -1) : 0) : 0;
        chain.push({ a: a, b: b });
      }
      rimChains.push({ refs: refs, li: li });
    });
    // tiles' points
    var tileRefs = [];
    for (i = 0; i < tiles.length; i++) {
      var t = tiles[i], refs = new Array(motif.samples.length);
      for (j = 0; j < motif.samples.length; j++) {
        var s = motif.samples[j], xy = S.offsetXY(t.x, t.y, s[0], s[1]);
        refs[j] = pointId(xy[0], xy[1], s[2], null);
        if (bh[refs[j].id] !== s[2] && Math.abs(bh[refs[j].id]) < Math.abs(s[2])) bh[refs[j].id] = s[2];
      }
      tileRefs.push(refs);
      motif.segs.forEach(function (sg) { var A = refs[sg[0]], B = refs[sg[1]]; if (A.id === B.id) return; segsSoft.push([A, B]); });
    }
    // the coarse fill between them: kept out of every footprint, judged in 3D (a chart can stretch)
    var tcell = Math.max(fillStep, motif.rc * 2), tgrid = new Map(), tcen3 = [];
    tiles.forEach(function (t, ti) {
      var p = tileFrames[ti].l.p, key = Math.floor(p[0] / tcell) + ',' + Math.floor(p[1] / tcell) + ',' + Math.floor(p[2] / tcell), a = tgrid.get(key);
      if (!a) { a = []; tgrid.set(key, a); } a.push(p);
    });
    function nearTile(p, r) {
      var ci = Math.floor(p[0] / tcell), cj = Math.floor(p[1] / tcell), ck = Math.floor(p[2] / tcell), rr = Math.ceil((r + motif.rc) / tcell);
      for (var di = -rr; di <= rr; di++) for (var dj = -rr; dj <= rr; dj++) for (var dk = -rr; dk <= rr; dk++) {
        var a = tgrid.get((ci + di) + ',' + (cj + dj) + ',' + (ck + dk)); if (!a) continue;
        for (var q = 0; q < a.length; q++) if (len(sub(a[q], p)) < motif.rc + r) return true;
      }
      return false;
    }
    var fillN = 0, hs = fillStep, hsy = fillStep * 0.8660254, clearR = hs * 0.55, fillList = [];
    if (S.kind === 'sphere') {                                         // even in 3D: latitude rings, not a lattice on the stretched chart
      var dthF = hsy / S.R, kF;
      for (kF = 0; kF * dthF <= fit.thMax + 1e-9; kF++) {
        var thF = kF * dthF, cntF = kF === 0 ? 1 : Math.max(3, Math.round(TAU * S.R * Math.sin(thF) / hs)), rhoF = 2 * S.R * Math.tan(thF / 2);
        for (i = 0; i < cntF; i++) { var azF = TAU * (i + (kF & 1 ? 0.5 : 0)) / cntF; fillList.push([rhoF * Math.cos(azF), rhoF * Math.sin(azF)]); }
      }
    } else {
      var fnI = Math.ceil((lx1 - lx0) / hs) + 1, fnJ = Math.ceil((ly1 - ly0) / hsy) + 1;
      if (fnI * fnJ > o.maxPoints) return refuse('this face is too big for a fill step of ' + fmt(hs, 2) + ' mm');
      for (j = 0; j <= fnJ; j++) for (i = 0; i <= fnI; i++) fillList.push([lx0 + (i + (j & 1 ? 0.5 : 0)) * hs, ly0 + j * hsy]);
    }
    for (var fi = 0; fi < fillList.length; fi++) {
      var fx = fillList[fi][0], fy = fillList[fi][1];
      var lf = null;
      if (periodic) { if (fx >= x0 + C - 1e-9 || fx < x0 - 1e-9) continue; if (fy < ymin + clearR || fy > ymax - clearR) continue; lf = S.lift(fx, fy); }
      else {
        if (!pipEvenOdd(chartLoops, fx, fy)) continue;
        lf = S.lift(fx, fy); if (!lf) continue;
        if (rimDist(lf.p, clearR) < clearR) continue;
      }
      if (nearTile(lf.p, clearR)) continue;
      pointId(fx, fy, 0, null); fillN++;
    }
    var nb = bx.length;
    if (nb * (periodic ? 3 : 1) > o.maxPoints) return refuse('that is ' + fmt(nb, 0) + ' points - more than the tool will triangulate (' + o.maxPoints + '): raise the spacing');
    // ---- triangulate
    var copies = periodic ? [-1, 0, 1] : [0], pts = [], pidx = new Map();
    function P_(id, k) { var key = id + ':' + k, v = pidx.get(key); if (v !== undefined) return v; v = pts.length; pidx.set(key, v); pts.push([bx[id] + k * C + jitter(id) * 1e-7 * span, by[id] + jitter(id + 7919) * 1e-7 * span]); pidxInfo.push([id, k]); return v; }
    var pidxInfo = [];
    var segs = [], nHard = 0;
    if (periodic) {
      // the rim chains over five periods; the tiles and the fill over the middle three
      var chainsPts = [];
      rimChains.forEach(function (rc) {
        var li = rc.li, refs = rc.refs, dir = loopInfo[li].span > 0 ? 1 : -1, order = refs.map(function (r, q) { return q; }), ux = loopInfo[li].pts.map(function (p) { return p[0]; });
        if (dir < 0) order.reverse();
        // both chains start within half a period of the same x, or the closing edges at the two ends would slant across the features
        var mOff = Math.round((ux[order[0]] - x0) / C), seq = [];
        for (var kk = -2; kk <= 2; kk++) for (var q2 = 0; q2 < order.length; q2++) {
          var q3 = order[q2], r = refs[q3];
          // this element sits at unwrapped x = ux[q3] (+ kk periods), which is wrapped copy r.w off the base
          seq.push(P_(r.id, r.w + kk - mOff));
        }
        chainsPts.push(seq);
      });
      // the chain sequence is by unwrapped x; two chains: bottom (smaller y) first
      chainsPts.sort(function (a, b) { return by[pidxInfo[a[0]][0]] - by[pidxInfo[b[0]][0]]; });
      var bot = chainsPts[0], top = chainsPts[1];
      for (i = 0; i + 1 < bot.length; i++) segs.push([bot[i], bot[i + 1]]);
      for (i = 0; i + 1 < top.length; i++) segs.push([top[i], top[i + 1]]);
      segs.push([bot[bot.length - 1], top[top.length - 1]]);
      segs.push([bot[0], top[0]]);
      nHard = segs.length;
    } else {
      rimChains.forEach(function (rc) {
        var refs = rc.refs;
        for (i = 0; i < refs.length; i++) segs.push([P_(refs[i].id, 0), P_(refs[(i + 1) % refs.length].id, 0)]);
      });
      nHard = segs.length;
    }
    // tiles + fill, in every copy
    for (var ci = 0; ci < copies.length; ci++) {
      var kk = copies[ci];
      for (i = 0; i < tileRefs.length; i++) {
        var refs2 = tileRefs[i];
        for (j = 0; j < refs2.length; j++) P_(refs2[j].id, refs2[j].w + kk);
      }
      for (i = 0; i < segsSoft.length; i++) {
        var A = segsSoft[i][0], B = segsSoft[i][1];
        segs.push([P_(A.id, A.w + kk), P_(B.id, B.w + kk)]);
      }
    }
    // every other base point (the fill, the rim in the middle copies) in the middle copies
    for (i = 0; i < nb; i++) for (ci = 0; ci < copies.length; ci++) P_(i, copies[ci]);
    var res = CDT.triangulate(pts, segs, nHard);
    if (res.reason) return refuse('the triangulation failed: ' + res.reason + (res.badSeg != null ? ' (edge ' + res.badSeg + ')' : ''));
    // ---- the patch: triangles, lifted
    var Tri = res.tris, keepTri = [], cx0 = x0, cx1 = x0 + C;
    for (i = 0; i < Tri.length; i += 3) {
      var ia = pidxInfo[Tri[i]], ib = pidxInfo[Tri[i + 1]], ic = pidxInfo[Tri[i + 2]];
      if (periodic) {                 // each triangle is kept in the one copy where its lowest-numbered corner is in the middle period
        var lowK = ia[0] < ib[0] && ia[0] < ic[0] ? ia[1] : ib[0] < ic[0] ? ib[1] : ic[1];
        if (lowK !== 0) continue;
      }
      if (ia[0] === ib[0] || ib[0] === ic[0] || ia[0] === ic[0]) continue;
      keepTri.push(ia[0], ib[0], ic[0]);
    }
    // base positions and normals of every non-rim point, then the heights
    var pos = new Array(nb), nrm = new Array(nb), baseP = new Array(nb);
    for (i = 0; i < nb; i++) {
      if (brim[i] >= 0) { var v = brim[i]; pos[i] = baseP[i] = [M.P[3 * v], M.P[3 * v + 1], M.P[3 * v + 2]]; nrm[i] = null; continue; }
      var lf2 = S.lift(bx[i], by[i]);
      if (!lf2) return refuse('a point of the wrap fell off the face (' + fmt(bx[i], 2) + ', ' + fmt(by[i], 2) + ') - the face is not a clean surface along its view');
      baseP[i] = lf2.p; nrm[i] = lf2.n;
      pos[i] = bh[i] ? add(lf2.p, mul(lf2.n, bh[i])) : lf2.p;
    }
    // orientation: the lifted base triangle's own normal against the face's, voted
    var vote = 0, nOuter = 0;
    for (i = 0; i < keepTri.length; i += 3) {
      var a0 = baseP[keepTri[i]], b0 = baseP[keepTri[i + 1]], c0 = baseP[keepTri[i + 2]], gn = cross(sub(b0, a0), sub(c0, a0)), L = len(gn);
      if (!(L > 1e-12)) continue;
      var nf = null;
      for (j = 0; j < 3 && !nf; j++) nf = nrm[keepTri[i + j]];
      if (!nf) continue;
      var dd = dot(gn, nf) / L; if (Math.abs(dd) < 0.3) continue;
      vote += dd > 0 ? 1 : -1; nOuter++;
    }
    var flip = vote < 0;
    if (!nOuter) return refuse('could not tell which way the new surface faces');
    var T = new Int32Array(keepTri.length);
    for (i = 0; i < keepTri.length; i += 3) {
      var ids = [keepTri[i], keepTri[i + 1], keepTri[i + 2]];
      if (flip) { var tmpv = ids[1]; ids[1] = ids[2]; ids[2] = tmpv; }
      for (j = 0; j < 3; j++) T[i + j] = ids[j];
    }
    // ids: base point -> rim vertex id, or a new corner
    var newIndex = new Int32Array(nb).fill(-1), newP = [], gid = new Int32Array(nb);
    for (i = 0; i < nb; i++) {
      if (brim[i] >= 0) gid[i] = brim[i];
      else { newIndex[i] = newP.length; gid[i] = M.nV + base + newP.length; newP.push(pos[i]); }
    }
    var G = new Int32Array(T.length), used = new Uint8Array(nb);
    for (i = 0; i < T.length; i++) { G[i] = gid[T[i]]; used[T[i]] = 1; }
    // drop corners no triangle uses (a fill point on a skipped corner of the periodic copies)
    var remap = new Int32Array(newP.length).fill(-1), newP2 = [];
    for (i = 0; i < nb; i++) if (newIndex[i] >= 0 && used[i]) { remap[newIndex[i]] = newP2.length; newP2.push(pos[i]); }
    for (i = 0; i < T.length; i++) { var g = G[i]; if (g >= M.nV + base) G[i] = M.nV + base + remap[g - M.nV - base]; }
    var hmax = 0, hmin = 0;
    for (i = 0; i < nb; i++) if (used[i]) { if (bh[i] > hmax) hmax = bh[i]; if (bh[i] < hmin) hmin = bh[i]; }
    return {
      ok: true, newP: newP2, T: G, maskUsed: mask2, kind: fit.kind, concave: !!fit.concave,
      stats: { tiles: tiles.length, skipped: skipped, scale: f, points: nb, tris: G.length / 3, oldTris: tris.length, rimCorners: loops.reduce(function (s, L) { return s + L.length; }, 0), hmax: hmax, hmin: hmin, periodic: periodic, px: lat.px, ms: Date.now() - t0, notes: notes, fillStep: fillStep, flip: flip }
    };
  }

  /* ------------------------------------------------------------------ the whole thing */

  /* picks: the entries of regions().list to wrap (or their ids), with the regions() result they came from.
     -> { ok, soup, stats, perFace } */
  function apply(soup, reg, picks, params) {
    if (!CDT || !Weave) return refuse('the mesher (nso_cdt.js / nso_weave.js) is not loaded');
    var o = resolve(params), M = reg.M, list = reg.list, i, chosen = [];
    picks.forEach(function (p) { var r = typeof p === 'number' ? list.filter(function (q) { return q.id === p; })[0] : p; if (r) chosen.push(r); });
    if (!chosen.length) return refuse('no face is picked');
    var results = [], base = 0, perFace = [];
    for (i = 0; i < chosen.length; i++) {
      var r = wrapFace(M, chosen[i], o, base);
      if (!r.ok) return refuse((chosen.length > 1 ? chosen[i].label + ': ' : '') + r.reason);
      base += r.newP.length; results.push(r);
      perFace.push({ id: chosen[i].id, label: chosen[i].label, kind: r.kind, stats: r.stats });
    }
    var removed = new Uint8Array(M.n), nNew = 0, newTri = 0;
    results.forEach(function (r) { for (var t = 0; t < M.n; t++) if (r.maskUsed[t]) removed[t] = 1; newTri += r.T.length / 3; });
    var keep = 0;
    for (i = 0; i < M.n; i++) if (!removed[i]) keep++;
    var out = new Float32Array(9 * (keep + newTri)), q = 0, t;
    for (t = 0; t < M.n; t++) { if (removed[t]) continue; out.set(soup.subarray(9 * t, 9 * t + 9), q); q += 9; }
    var offs = 0;
    results.forEach(function (r) {
      for (var a = 0; a < r.T.length; a++) {
        var id = r.T[a];
        if (id < M.nV) { out[q++] = M.P[3 * id]; out[q++] = M.P[3 * id + 1]; out[q++] = M.P[3 * id + 2]; }
        else { var np = null, ri = id - M.nV, acc = 0; for (var rr = 0; rr < results.length; rr++) { if (ri < acc + results[rr].newP.length) { np = results[rr].newP[ri - acc]; break; } acc += results[rr].newP.length; } out[q++] = np[0]; out[q++] = np[1]; out[q++] = np[2]; }
      }
    });
    var tot = { tiles: 0, tris: 0, hmax: 0, hmin: 0 };
    perFace.forEach(function (f) { tot.tiles += f.stats.tiles; tot.tris += f.stats.tris; tot.hmax = Math.max(tot.hmax, f.stats.hmax); tot.hmin = Math.min(tot.hmin, f.stats.hmin); });
    return { ok: true, soup: out, stats: tot, perFace: perFace, params: o, removed: keep === M.n ? 0 : M.n - keep, added: newTri };
  }

  var API = { DEFAULTS: DEFAULTS, resolve: resolve, regions: regions, apply: apply, motifModel: motifModel, fitRegion: fitRegion, _wrapFace: wrapFace };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_SurfTex = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
