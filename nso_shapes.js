// ===================== Shape rows: capsule, sphere / ellipsoid, torus =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_shape_scale_test.js) and under a classic script tag in
// the browser, where the Scale card asks it which rows a piece gets.
//
// WHAT THIS IS. Three Stock shapes whose numbers are not a section along a
// straight run, so nso_section.js reads all three as `other` (a capsule's
// domes break its run; a sphere and a torus are curved all over) and the card
// could only offer whole-piece scaling. Each gets rows that change ONE thing:
//
//   capsule     Length    the straight band between the hemispheres, by
//                         Extend's own band stretch (NSO_extendRaw, axis and
//                         cut forced) - the ends never deform.
//               Diameter  the whole cross-section, length kept: each
//                         hemisphere is scaled about its own centre, which
//                         slides in or out along the axis so the poles stay
//                         where they are, and the band between takes up the
//                         difference. The ends stay hemispheres.
//   sphere /    A · B · C three independent axis lengths, the piece's own X,
//   ellipsoid             Y and Z. Each row is an exact scale along that axis
//                         about the centre; the other two coordinates of every
//                         vertex are not written. A sphere is an ellipsoid with
//                         three equal axes, and Stock's x:y:z is the same thing.
//   torus       Ring Ø    the tube's centreline diameter. Every vertex moves
//                         by ΔR away from the axis within its own meridian, so
//                         the tube section is unchanged - exactly, not to a
//                         tolerance.
//               Tube Ø    the tube section about its own centreline, ring Ø
//                         kept. A solid tube is scaled; a hollow one moves both
//                         its surfaces by the same amount, so the wall is kept.
//
// WHERE THE SHAPE COMES FROM, in order:
//   1. A Stock piece is TAGGED: app-stock.js hands its sizing report to
//      NSO_shapeTagStock against the model's own rawTris array, and every row
//      here re-tags the soup it produces. The tag is keyed on the soup's
//      identity (a WeakMap), so any other tool's bake - which always replaces
//      rawTris with a new array - leaves no stale tag behind, and Undo, which
//      puts the old array back, finds the old tag with it.
//   2. Anything else is RECOGNISED off its vertices (NSO_shapeRecognise),
//      using the section reader's axis where it has one (a capsule's: Extend's
//      detector names it). Each fit states its tolerance and every miss says
//      what it measured.
//
// REFUSALS, each in words:
//   a wall thinner than 2 nozzle widths - a solid piece's thinnest section,
//     a hollow one's wall - where the row would make it so (a piece already
//     under it that the row leaves no thinner is not this file's refusal)
//   a torus whose tube would reach the axis (Tube Ø, or a Ring Ø shrink)
//   a capsule Length under 2× its radius (Length, or a Diameter over its length)
//
// Cylinder, cone and tube are NOT here: they keep the rows nso_section.js and
// nso_ring.js already give them (Length / Diameter / Wall).

var NSO_SHAPE_TOL_FLOOR_MM = 0.05;   // nso_section.js's floor, the same figure
var NSO_SHAPE_TOL_FRAC = 0.01;       // of the shape's smallest radius
var NSO_SHAPE_CENTROID_K = 3;        // a facet's centroid may sit this many tolerances off
var NSO_SHAPE_WALL_NOZZLES = 2;      // the thin-wall refusal: 2 nozzle widths
var NSO_SHAPE_MAX_PASSES = 4;        // A · B · C's float32 correction budget

var NSO_shapeTags = (typeof WeakMap === 'function') ? new WeakMap() : null;

function NSO_shapeBounds(soup) {
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soup.length; i += 3) for (var k = 0; k < 3; k++) {
    var v = soup[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
  }
  return { lo: lo, hi: hi, span: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
           center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
}

function NSO_shapeTol(r) { return Math.max(NSO_SHAPE_TOL_FLOOR_MM, NSO_SHAPE_TOL_FRAC * r); }

/* The two axes across axis k, in order. */
function NSO_shapeAcross(k) { return k === 0 ? [1, 2] : (k === 1 ? [0, 2] : [0, 1]); }

/* ---------------------------------------------------------------- tags */

function NSO_shapeTag(soup, p) {
  if (NSO_shapeTags && soup && p) NSO_shapeTags.set(soup, p);
  return p;
}

/* A Stock sizing report as shape parameters, or null for the shapes that keep
   their section rows (cylinder, cone, tube, box). Stock revolves about its Z. */
function NSO_shapeFromStock(sizing) {
  if (!sizing || !sizing.measure) return null;
  var m = sizing.measure;
  if (sizing.shape === 'capsule') return { shape: 'capsule', source: 'stock', axisIdx: 2, radius: m.radius, length: m.height };
  if (sizing.shape === 'sphere') return { shape: 'sphere', source: 'stock', semi: [m.radius, m.radius, m.radius], inner: null };
  if (sizing.shape === 'ellipsoid') {
    return { shape: 'ellipsoid', source: 'stock', semi: [m.radius, m.radius, m.semi_height], inner: null };
  }
  if (sizing.shape === 'torus') {
    return { shape: 'torus', source: 'stock', axisIdx: 2, ringR: m.ring_radius, tubeR: m.tube_radius, wall: null };
  }
  return null;
}

function NSO_shapeTagStock(soup, sizing) {
  var p = NSO_shapeFromStock(sizing);
  return p ? NSO_shapeTag(soup, p) : null;
}

/* The extents a set of parameters says the piece has, in raw X, Y, Z. */
function NSO_shapeExpectedSpan(p) {
  if (p.shape === 'capsule') {
    var c = [2 * p.radius, 2 * p.radius, 2 * p.radius]; c[p.axisIdx] = p.length; return c;
  }
  if (p.shape === 'torus') {
    var o = 2 * (p.ringR + p.tubeR), t = [o, o, o]; t[p.axisIdx] = 2 * p.tubeR; return t;
  }
  return [2 * p.semi[0], 2 * p.semi[1], 2 * p.semi[2]];
}

/* A tag, if the soup carries one AND its bounding box still says so - a tool
   that edited rawTris in place would otherwise be read by a stale tag. */
function NSO_shapeTagOf(soup) {
  var p = (NSO_shapeTags && soup) ? NSO_shapeTags.get(soup) : null;
  if (!p) return null;
  var b = NSO_shapeBounds(soup), e = NSO_shapeExpectedSpan(p);
  for (var k = 0; k < 3; k++) if (Math.abs(b.span[k] - e[k]) > 1e-4 * Math.max(1, e[k])) return null;
  return p;
}

/* ------------------------------------------------------------ recognise */

/* Every vertex within tol of the surface and every facet centroid within
   NSO_SHAPE_CENTROID_K tolerances. `dist` is the signed-ish distance of a
   point to the candidate surface. The centroid check is what keeps a
   polyhedron whose corners happen to sit on the surface - a cube's on its
   circumsphere, an octahedron's on its insphere's dual - from passing. */
function NSO_shapeSurfaceFit(soup, dist, tol) {
  var worstV = 0, worstC = 0;
  for (var t = 0; t < soup.length; t += 9) {
    for (var v = 0; v < 3; v++) {
      var o = t + 3 * v, d = Math.abs(dist(soup[o], soup[o + 1], soup[o + 2]));
      if (d > worstV) worstV = d;
    }
    var dc = Math.abs(dist((soup[t] + soup[t + 3] + soup[t + 6]) / 3, (soup[t + 1] + soup[t + 4] + soup[t + 7]) / 3,
                           (soup[t + 2] + soup[t + 5] + soup[t + 8]) / 3));
    if (dc > worstC) worstC = dc;
  }
  return { ok: worstV <= tol && worstC <= NSO_SHAPE_CENTROID_K * tol, vertexMm: worstV, centroidMm: worstC, tolMm: tol };
}

/* Distance of (x,y,z) from the ellipsoid of semi-axes s about c, along the
   ray from the centre - exact on a sphere, within the axis ratio elsewhere,
   which is all a tolerance gate needs. */
function NSO_shapeEllDist(c, s) {
  return function (x, y, z) {
    var u = x - c[0], v = y - c[1], w = z - c[2];
    var g = Math.sqrt(u * u / (s[0] * s[0]) + v * v / (s[1] * s[1]) + w * w / (s[2] * s[2]));
    var r = Math.sqrt(u * u + v * v + w * w);
    return g > 0 ? (g - 1) * r / g : -Math.min(s[0], s[1], s[2]);
  };
}

/* A solid ellipsoid, or a hollow one (a concentric inner ellipsoid facing in). */
function NSO_shapeTryEllipsoid(soup, b) {
  var s = [b.span[0] / 2, b.span[1] / 2, b.span[2] / 2], c = b.center;
  var tol = NSO_shapeTol(Math.min(s[0], s[1], s[2]));
  var outer = NSO_shapeEllDist(c, s);
  var fit = NSO_shapeSurfaceFit(soup, outer, tol);
  var inner = null;
  if (!fit.ok) {
    // Hollow: the vertices not on the outer surface, if they are all on one
    // concentric ellipsoid of their own.
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], nIn = 0;
    for (var i = 0; i < soup.length; i += 3) {
      if (Math.abs(outer(soup[i], soup[i + 1], soup[i + 2])) <= tol) continue;
      nIn++;
      for (var k = 0; k < 3; k++) { var x = soup[i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    }
    if (!nIn) return { ok: false, why: 'its outline is not an ellipsoid (' + fit.centroidMm.toFixed(2) + ' mm off between corners)' };
    var si = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    var ci = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
    var tolIn = NSO_shapeTol(Math.min(si[0], si[1], si[2]));
    if (!(si[0] > 0 && si[1] > 0 && si[2] > 0) || Math.hypot(ci[0] - c[0], ci[1] - c[1], ci[2] - c[2]) > tolIn) {
      return { ok: false, why: 'it is not an ellipsoid (' + fit.vertexMm.toFixed(2) + ' mm off at a corner)' };
    }
    var dIn = NSO_shapeEllDist(c, si);
    var both = NSO_shapeSurfaceFit(soup, function (x, y, z) {
      var a = Math.abs(outer(x, y, z)), q = Math.abs(dIn(x, y, z)); return a < q ? a : q;
    }, Math.min(tol, tolIn));
    if (!both.ok) return { ok: false, why: 'it is not an ellipsoid (' + fit.vertexMm.toFixed(2) + ' mm off at a corner)' };
    inner = si;
    fit = both;
  }
  var round = Math.max(s[0], s[1], s[2]) - Math.min(s[0], s[1], s[2]) <= tol;
  return { ok: true, p: { shape: round ? 'sphere' : 'ellipsoid', source: 'read', semi: s, inner: inner, fit: fit } };
}

/* A solid capsule along axis k: a cylinder band between two hemispheres. */
function NSO_shapeTryCapsule(soup, b, k) {
  var ac = NSO_shapeAcross(k), d0 = b.span[ac[0]], d1 = b.span[ac[1]];
  var r = (d0 + d1) / 4, L = b.span[k], tol = NSO_shapeTol(r);
  if (Math.abs(d0 - d1) > tol) return { ok: false, why: 'it is not round across its ' + 'XYZ'[k] };
  if (!(L - 2 * r > tol)) return { ok: false, why: 'it has no straight band along ' + 'XYZ'[k] };
  var cu = b.center[ac[0]], cv = b.center[ac[1]], zb = b.lo[k] + r, zt = b.hi[k] - r;
  var dist = function (x, y, z) {
    var p = [x, y, z], u = p[ac[0]] - cu, v = p[ac[1]] - cv, w = p[k], q = Math.hypot(u, v);
    if (w < zb) return Math.hypot(q, w - zb) - r;
    if (w > zt) return Math.hypot(q, w - zt) - r;
    return q - r;
  };
  var fit = NSO_shapeSurfaceFit(soup, dist, tol);
  if (!fit.ok) return { ok: false, why: 'its ends are not hemispheres on a round band (' + fit.vertexMm.toFixed(2) + ' mm off)' };
  return { ok: true, p: { shape: 'capsule', source: 'read', axisIdx: k, radius: r, length: L, fit: fit } };
}

/* A torus about axis k, solid or hollow (a second tube surface inside, facing in). */
function NSO_shapeTryTorus(soup, b, k) {
  var ac = NSO_shapeAcross(k), d0 = b.span[ac[0]], d1 = b.span[ac[1]];
  var Ro = (d0 + d1) / 4, r = b.span[k] / 2, R = Ro - r, tol = NSO_shapeTol(r);
  if (Math.abs(d0 - d1) > tol) return { ok: false, why: 'it is not round about its ' + 'XYZ'[k] };
  if (!(R - r > tol)) return { ok: false, why: 'it has no hole through it along ' + 'XYZ'[k] };
  var cu = b.center[ac[0]], cv = b.center[ac[1]], wc = b.center[k];
  var tubeD = function (x, y, z) {
    var p = [x, y, z]; return Math.hypot(Math.hypot(p[ac[0]] - cu, p[ac[1]] - cv) - R, p[k] - wc);
  };
  var fit = NSO_shapeSurfaceFit(soup, function (x, y, z) { return tubeD(x, y, z) - r; }, tol);
  var wall = null;
  if (!fit.ok) {
    var sum = 0, n = 0, i, d;
    for (i = 0; i < soup.length; i += 3) {
      d = tubeD(soup[i], soup[i + 1], soup[i + 2]);
      if (Math.abs(d - r) > tol) { sum += d; n++; }
    }
    if (!n) return { ok: false, why: 'its tube is not round (' + fit.centroidMm.toFixed(2) + ' mm off between corners)' };
    var ri = sum / n;
    if (!(ri > 0 && ri < r - tol)) return { ok: false, why: 'its tube is not round (' + fit.vertexMm.toFixed(2) + ' mm off)' };
    var tolIn = NSO_shapeTol(ri);
    var both = NSO_shapeSurfaceFit(soup, function (x, y, z) {
      var q = tubeD(x, y, z); return Math.min(Math.abs(q - r), Math.abs(q - ri));
    }, Math.min(tol, tolIn));
    if (!both.ok) return { ok: false, why: 'its tube is not round (' + fit.vertexMm.toFixed(2) + ' mm off)' };
    wall = r - ri;
    fit = both;
  }
  return { ok: true, p: { shape: 'torus', source: 'read', axisIdx: k, ringR: R, tubeR: r, wall: wall, fit: fit } };
}

/* Which of the three shapes this soup is, or null with the reasons. `section`
   is nso_section.js's reading when the caller has one: its axis is Extend's
   detector's, and a capsule is tried along it first. */
function NSO_shapeRecognise(soup, section) {
  if (!soup || soup.length < 9 || soup.length % 9 !== 0) return { ok: false, why: 'not a triangle soup' };
  var b = NSO_shapeBounds(soup);
  if (!(b.span[0] > 0 && b.span[1] > 0 && b.span[2] > 0)) return { ok: false, why: 'it is flat' };
  var whys = [];
  var e = NSO_shapeTryEllipsoid(soup, b);
  if (e.ok) return { ok: true, p: e.p };
  whys.push(e.why);
  // A capsule along the reader's axis first, then along its longest axis.
  var order = [];
  if (section && section.axisIdx >= 0) order.push(section.axisIdx);
  var longest = b.span[0] >= b.span[1] ? (b.span[0] >= b.span[2] ? 0 : 2) : (b.span[1] >= b.span[2] ? 1 : 2);
  if (order.indexOf(longest) < 0) order.push(longest);
  for (var i = 0; i < order.length; i++) {
    var c = NSO_shapeTryCapsule(soup, b, order[i]);
    if (c.ok) return { ok: true, p: c.p };
    whys.push(c.why);
  }
  // A torus lies across its shortest axis.
  var shortest = b.span[0] <= b.span[1] ? (b.span[0] <= b.span[2] ? 0 : 2) : (b.span[1] <= b.span[2] ? 1 : 2);
  var t = NSO_shapeTryTorus(soup, b, shortest);
  if (t.ok) return { ok: true, p: t.p };
  whys.push(t.why);
  return { ok: false, why: whys.join('; ') };
}

/* The tag if there is one, else the recognition. null when neither. */
function NSO_shapeRead(soup, section) {
  var tag = NSO_shapeTagOf(soup);
  if (tag) return tag;
  var r = NSO_shapeRecognise(soup, section);
  return r.ok ? NSO_shapeTag(soup, r.p) : null;
}

/* ------------------------------------------------------------- the rows */

/* Which rows a shape gets, in card order. */
var NSO_SHAPE_ROWS = {
  capsule: ['capLength', 'capDiameter'],
  sphere: ['ellA', 'ellB', 'ellC'],
  ellipsoid: ['ellA', 'ellB', 'ellC'],
  torus: ['ringDia', 'tubeDia']
};
var NSO_SHAPE_ROW_LABEL = {
  capLength: 'Length', capDiameter: 'Diameter', ellA: 'A', ellB: 'B', ellC: 'C',
  ringDia: 'Ring Ø', tubeDia: 'Tube Ø'
};

/* What each row shows now, in mm. */
function NSO_shapeRowValues(p) {
  if (!p) return {};
  if (p.shape === 'capsule') return { capLength: p.length, capDiameter: 2 * p.radius };
  if (p.shape === 'torus') return { ringDia: 2 * p.ringR, tubeDia: 2 * p.tubeR };
  return { ellA: 2 * p.semi[0], ellB: 2 * p.semi[1], ellC: 2 * p.semi[2] };
}

/* The thinnest wall a set of parameters describes: a hollow piece's wall, a
   solid one's thinnest section. */
function NSO_shapeThinnest(p) {
  if (p.shape === 'capsule') return 2 * p.radius;
  if (p.shape === 'torus') return p.wall != null ? p.wall : 2 * p.tubeR;
  if (p.inner) return Math.min(p.semi[0] - p.inner[0], p.semi[1] - p.inner[1], p.semi[2] - p.inner[2]);
  return 2 * Math.min(p.semi[0], p.semi[1], p.semi[2]);
}

/* The readout's first line, in print terms. `f` formats a length (the
   card's unit edge); default one decimal. */
function NSO_shapeReadout(p, f) {
  f = f || function (x) { return (+x).toFixed(1); };
  var from = p.source === 'stock' ? ' (Stock)' : '';
  if (p.shape === 'capsule') return 'Capsule Ø' + f(2 * p.radius) + ' · length ' + f(p.length) + ' along ' + 'XYZ'[p.axisIdx] + from;
  if (p.shape === 'torus') {
    return 'Torus ring Ø' + f(2 * p.ringR) + ' · tube Ø' + f(2 * p.tubeR) +
      (p.wall != null ? ' · wall ' + f(p.wall) : '') + from;
  }
  var t = p.shape === 'sphere' ? 'Sphere Ø' + f(2 * p.semi[0])
    : 'Ellipsoid ' + f(2 * p.semi[0]) + ' A × ' + f(2 * p.semi[1]) + ' B × ' + f(2 * p.semi[2]) + ' C';
  return t + (p.inner ? ' · wall ' + f(NSO_shapeThinnest(p)) : '') + from;
}

function NSO_shapeClone(p) {
  var q = {};
  for (var key in p) if (Object.prototype.hasOwnProperty.call(p, key) && key !== 'fit') {
    q[key] = Array.isArray(p[key]) ? p[key].slice() : p[key];
  }
  return q;
}

/* Topology of a soup on a fixed 1e-4 mm grid - the same gate Scale's own
   rows use (NSO_scaleTopoStats), inlined so this file stands alone. */
function NSO_shapeTopo(soup) {
  var q = 1e4, edges = new Map(), verts = new Map(), degen = 0;
  function key(o) { return Math.round(soup[o] * q) + '_' + Math.round(soup[o + 1] * q) + '_' + Math.round(soup[o + 2] * q); }
  for (var t = 0; t < soup.length; t += 9) {
    var k = [key(t), key(t + 3), key(t + 6)];
    for (var j = 0; j < 3; j++) verts.set(k[j], 1);
    var ux = soup[t + 3] - soup[t], uy = soup[t + 4] - soup[t + 1], uz = soup[t + 5] - soup[t + 2];
    var vx = soup[t + 6] - soup[t], vy = soup[t + 7] - soup[t + 1], vz = soup[t + 8] - soup[t + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5 < 1e-12) degen++;
    for (var e = 0; e < 3; e++) {
      var a = k[e], c = k[(e + 1) % 3];
      if (a === c) continue;
      var ek = a < c ? a + '|' + c : c + '|' + a;
      edges.set(ek, (edges.get(ek) || 0) + 1);
    }
  }
  var open = 0, nm = 0;
  edges.forEach(function (c) { if (c === 1) open++; else if (c > 2) nm++; });
  return { tris: soup.length / 9, verts: verts.size, open: open, nm: nm, degen: degen };
}

/* Apply a vertex map to every vertex. `fn(x, y, z, out)` writes the new
   position into out[0..2]; out is pre-filled with the old one, so a map that
   leaves a coordinate alone leaves its bits alone. */
function NSO_shapeMap(soup, fn) {
  var out = new Float32Array(soup.length), p = [0, 0, 0];
  for (var i = 0; i < soup.length; i += 3) {
    p[0] = soup[i]; p[1] = soup[i + 1]; p[2] = soup[i + 2];
    fn(soup[i], soup[i + 1], soup[i + 2], p);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  return out;
}

function NSO_shapeFmt(x) { return (+x).toFixed(2).replace(/\.?0+$/, ''); }

/* One row on one soup.

   p       the shape's parameters (NSO_shapeRead)
   row     a key of NSO_SHAPE_ROW_LABEL
   mm      the value the row should end up
   opts.nozzle   default NSO_Thickness.NOZZLE_DEFAULT, else 0.4

   Returns { ok, reason, tris, shape (the parameters after), before, after }.
   On refusal tris is the original soup. */
function NSO_shapeApplyRaw(soup, p, row, mm, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, row: row, mm: +mm };
  var label = NSO_SHAPE_ROW_LABEL[row] || row;
  if (!soup || soup.length < 9 || soup.length % 9 !== 0) { res.reason = 'not a triangle soup'; return res; }
  if (!p || (NSO_SHAPE_ROWS[p.shape] || []).indexOf(row) < 0) {
    res.reason = label + ' is not a row this piece has'; return res;
  }
  mm = +mm;
  if (!(isFinite(mm) && mm > 0)) { res.reason = label + ' must be a positive number of mm'; return res; }
  var before = NSO_shapeRowValues(p)[row];
  res.valueBefore = before;
  if (Math.abs(mm - before) < 1e-9 * Math.max(1, before)) {
    res.reason = 'nothing to change - ' + label + ' is already ' + NSO_shapeFmt(before) + ' mm'; return res;
  }
  var T = (typeof NSO_Thickness !== 'undefined' && NSO_Thickness) ? NSO_Thickness : null;
  var nozzle = opts.nozzle > 0 ? +opts.nozzle : (T && T.NOZZLE_DEFAULT ? T.NOZZLE_DEFAULT : 0.4);
  var wallMin = NSO_SHAPE_WALL_NOZZLES * nozzle;
  var b = NSO_shapeBounds(soup), c = b.center;
  var q = NSO_shapeClone(p), out = null, k, ac;

  if (p.shape === 'capsule') {
    k = p.axisIdx; ac = NSO_shapeAcross(k);
    var r = p.radius, L = p.length;
    if (row === 'capLength') {
      if (!(mm > 2 * r)) {
        res.reason = 'a capsule\'s length can\'t be under 2× its radius - ' + NSO_shapeFmt(mm) + ' mm is ' +
          (mm < 2 * r ? 'under' : 'exactly') + ' its ' + NSO_shapeFmt(2 * r) + ' mm diameter' +
          (mm < 2 * r ? '' : ', which is a sphere');
        return res;
      }
      if (typeof NSO_extendRaw !== 'function') { res.reason = 'app-extend.js must be loaded - Length is Extend\'s band stretch'; return res; }
      // The cut at the middle of the band, where Extend's own scan must find
      // a clean slab: the two equators bound it, so nothing on a dome moves
      // but by the one shift.
      var ex = NSO_extendRaw(soup, { axis: k, length: mm, cut: c[k] });
      if (!ex.ok) {
        // A band split by extra rings: let Extend choose its own clean band.
        var ex2 = NSO_extendRaw(soup, { axis: k, length: mm });
        if (!ex2.ok) { res.reason = ex.reason; return res; }
        ex = ex2;
      }
      out = ex.tris;
      res.extend = ex;
      q.length = NSO_shapeBounds(out).span[k];
    } else {
      var r2 = mm / 2;
      if (!(L > mm)) {
        res.reason = 'a capsule\'s length can\'t be under 2× its radius - Ø' + NSO_shapeFmt(mm) + ' is ' +
          (L < mm ? 'more than' : 'exactly') + ' its ' + NSO_shapeFmt(L) + ' mm length';
        return res;
      }
      if (mm < wallMin && mm < 2 * r) {
        res.reason = 'Ø' + NSO_shapeFmt(mm) + ' is thinner than 2 nozzle widths (' + NSO_shapeFmt(wallMin) + ' mm at a ' +
          nozzle + ' mm nozzle)';
        return res;
      }
      var f = r2 / r, zb = b.lo[k] + r, zt = b.hi[k] - r, zb2 = b.lo[k] + r2, zt2 = b.hi[k] - r2;
      var band = zt - zb, band2 = zt2 - zb2;
      out = NSO_shapeMap(soup, function (x, y, z, o) {
        var w = o[k];
        o[ac[0]] = c[ac[0]] + (o[ac[0]] - c[ac[0]]) * f;
        o[ac[1]] = c[ac[1]] + (o[ac[1]] - c[ac[1]]) * f;
        if (w <= zb) o[k] = zb2 + (w - zb) * f;
        else if (w >= zt) o[k] = zt2 + (w - zt) * f;
        else o[k] = zb2 + (w - zb) * (band2 / band);
      });
      q.radius = r2;
    }
  } else if (p.shape === 'torus') {
    k = p.axisIdx; ac = NSO_shapeAcross(k);
    var R = p.ringR, rt = p.tubeR, cu = c[ac[0]], cv = c[ac[1]], wc = c[k];
    if (row === 'ringDia') {
      var R2 = mm / 2, dR = R2 - R;
      if (!(R2 - rt > 0)) {
        res.reason = 'the tube would reach the axis - a ring Ø' + NSO_shapeFmt(mm) + ' leaves no hole inside a Ø' +
          NSO_shapeFmt(2 * rt) + ' mm tube (the smallest ring is over Ø' + NSO_shapeFmt(2 * rt) + ' mm)';
        return res;
      }
      out = NSO_shapeMap(soup, function (x, y, z, o) {
        var u = o[ac[0]] - cu, v = o[ac[1]] - cv, rho = Math.hypot(u, v);
        if (!(rho > 0)) return;
        var s = (rho + dR) / rho;
        o[ac[0]] = cu + u * s; o[ac[1]] = cv + v * s;
      });
      q.ringR = R2;
    } else {
      var r3 = mm / 2;
      if (!(r3 < R)) {
        res.reason = 'the tube would reach the axis - a tube Ø' + NSO_shapeFmt(mm) + ' on a ring Ø' + NSO_shapeFmt(2 * R) +
          ' closes the hole (the tube must stay under Ø' + NSO_shapeFmt(2 * R) + ' mm)';
        return res;
      }
      if (p.wall != null && !(r3 - p.wall > 0)) {
        res.reason = 'the tube\'s bore would close - its ' + NSO_shapeFmt(p.wall) + ' mm wall needs a tube over Ø' +
          NSO_shapeFmt(2 * p.wall) + ' mm';
        return res;
      }
      if (p.wall == null && mm < wallMin && mm < 2 * rt) {
        res.reason = 'a tube Ø' + NSO_shapeFmt(mm) + ' is thinner than 2 nozzle widths (' + NSO_shapeFmt(wallMin) +
          ' mm at a ' + nozzle + ' mm nozzle)';
        return res;
      }
      var hollow = p.wall != null, f2 = r3 / rt, dr = r3 - rt;
      out = NSO_shapeMap(soup, function (x, y, z, o) {
        var u = o[ac[0]] - cu, v = o[ac[1]] - cv, rho = Math.hypot(u, v);
        if (!(rho > 0)) return;
        var e = rho - R, w = o[k] - wc, d = Math.hypot(e, w);
        var s = hollow ? (d > 0 ? (d + dr) / d : 1) : f2;
        var rho2 = R + e * s;
        o[ac[0]] = cu + u * rho2 / rho; o[ac[1]] = cv + v * rho2 / rho;
        o[k] = wc + w * s;
      });
      q.tubeR = r3;
    }
  } else {
    k = row === 'ellA' ? 0 : (row === 'ellB' ? 1 : 2);
    var fk = mm / (2 * p.semi[k]);
    var wallAfter = p.inner ? Math.min.apply(null, [0, 1, 2].map(function (j) {
      return (p.semi[j] - p.inner[j]) * (j === k ? fk : 1);
    })) : 2 * Math.min.apply(null, [0, 1, 2].map(function (j) { return p.semi[j] * (j === k ? fk : 1); }));
    var wallBefore = NSO_shapeThinnest(p);
    if (wallAfter < wallMin && wallAfter < wallBefore) {
      res.reason = label + ' ' + NSO_shapeFmt(mm) + ' would leave ' + (p.inner ? 'a wall of ' : 'its thinnest section ') +
        NSO_shapeFmt(wallAfter) + ' mm, thinner than 2 nozzle widths (' + NSO_shapeFmt(wallMin) + ' mm at a ' +
        nozzle + ' mm nozzle)';
      return res;
    }
    // An exact scale along k about the centre. The span a float32 soup lands
    // on is a few ULPs off the quotient, so the factor is corrected off what
    // was measured - each pass from the ORIGINAL soup, best kept
    // (NSO_scaleSolve's argument, on one axis).
    var best = null, ff = fk;
    for (var pass = 0; pass < NSO_SHAPE_MAX_PASSES; pass++) {
      var ck = c[k], fNow = ff;
      var o2 = NSO_shapeMap(soup, function (x, y, z, o) { o[k] = ck + (o[k] - ck) * fNow; });
      var got = NSO_shapeBounds(o2).span[k], err = Math.abs(got - mm);
      if (!best || err < best.err) best = { tris: o2, err: err, got: got };
      if (err <= 1e-6 || !(got > 0)) break;
      ff = ff * (mm / got);
    }
    out = best.tris;
    q.semi[k] = best.got / 2;
    if (q.inner) q.inner[k] = p.inner[k] * fk;
    var sp = Math.max(q.semi[0], q.semi[1], q.semi[2]) - Math.min(q.semi[0], q.semi[1], q.semi[2]);
    q.shape = sp <= NSO_shapeTol(Math.min(q.semi[0], q.semi[1], q.semi[2])) ? 'sphere' : 'ellipsoid';
  }

  // The one gate every row shares: the mesh is the same mesh.
  var t0 = NSO_shapeTopo(soup), t1 = NSO_shapeTopo(out);
  if (t1.tris !== t0.tris || t1.verts !== t0.verts || t1.open > t0.open || t1.nm > t0.nm || t1.degen > t0.degen) {
    res.reason = 'the mesh would change (vertices ' + t0.verts + ' -> ' + t1.verts + ', open edges ' + t0.open + ' -> ' +
      t1.open + ', degenerate ' + t0.degen + ' -> ' + t1.degen + ')';
    return res;
  }
  var bAfter = NSO_shapeBounds(out);
  if (p.shape === 'capsule') q.length = bAfter.span[p.axisIdx];
  res.ok = true;
  res.tris = out;
  res.shape = NSO_shapeTag(out, q);
  res.valueAfter = NSO_shapeRowValues(q)[row];
  res.label = label;
  res.spanBefore = b.span; res.spanAfter = bAfter.span;
  res.topo = { before: t0, after: t1 };
  return res;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NSO_shapeRead: NSO_shapeRead, NSO_shapeRecognise: NSO_shapeRecognise, NSO_shapeApplyRaw: NSO_shapeApplyRaw,
    NSO_shapeTagStock: NSO_shapeTagStock, NSO_shapeTagOf: NSO_shapeTagOf, NSO_shapeReadout: NSO_shapeReadout
  };
}
