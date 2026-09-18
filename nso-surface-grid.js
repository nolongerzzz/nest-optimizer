/* ============================================================
   NSO surface grid — grid lines that lie ON a surface
   no ES modules, browser-global like the rest of the app

   A ruler drawn on the piece that something is being placed onto:
   the Seat / Join target. The lines have to sit on the REAL surface,
   which on this app's pieces is often not a plane - a rounded hull,
   a dome, a filleted lid. Projecting a flat grid down onto a curved
   top and calling it close enough is what this file exists to avoid:
   a line that floats over a dome tells you nothing about where the
   bit above it will actually land.

   HOW, and why not by raycasting.
   app-join.js already follows a real skin, per point: NSO_nearestSkinHit
   fires one ray per plug corner at the hull soup and takes the nearest
   crossing. That is exact, and it is the right shape for four corners.
   A grid is thousands of points, and one ray per point over the whole
   soup is O(points x triangles) for a thing that is redrawn every time
   the pairing changes.

   So the grid is the dual of that ray: instead of asking "where does
   this vertical line meet the surface", each triangle is asked "which
   grid planes cross you, and along what segment". Plane vs triangle is
   closed-form, one pass over the soup, and the answer is a chord OF the
   triangle - so every point emitted is a point of the surface itself,
   flat or curved, with no projection and no sampling error. Curvature
   shows up for free as the per-triangle break in each line.

   Only up-facing triangles take part: the grid marks the top surface,
   the one a piece placed above lands on. "Up" is passed in, because the
   caller knows the piece's orientation and this file knows no THREE.

   Soup convention, same as the rest of NSO: a flat array of floats,
   9 per triangle, [x,y,z] x3, no index.

   Nothing here reads or writes app state, geometry or export data. It
   takes numbers and returns numbers.
   ============================================================ */

/* Spacing ladder: the numbers a person measures in. A grid at 6.67mm
   is arithmetically fine and useless to read against - the whole point
   of the aid is that you can count squares and say "two and a half over". */
var NSO_GRID_LADDER = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500];

/** Nice round spacing that puts about `target` divisions across `extent` mm. */
function NSO_gridSpacing(extent, target) {
  var t = (target > 0 && isFinite(target)) ? target : 12;
  if (!(extent > 0) || !isFinite(extent)) return 1;
  var raw = extent / t;
  for (var i = 0; i < NSO_GRID_LADDER.length; i++) {
    if (NSO_GRID_LADDER[i] >= raw) return NSO_GRID_LADDER[i];
  }
  return NSO_GRID_LADDER[NSO_GRID_LADDER.length - 1];
}

function NSO_gridDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** Unit normal of one triangle, or null if it is degenerate. */
function NSO_gridTriNormal(s, o) {
  var ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
  var vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
  var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(L > 1e-12)) return null;
  return [nx / L, ny / L, nz / L];
}

/**
 * Extent of the up-facing part of a soup, measured along u and v from origin.
 * Returns null when nothing faces up.
 *   opts: { up, u, v, origin, minDot }
 */
function NSO_surfaceGridBounds(soup, opts) {
  if (!soup || !soup.length) return null;
  var up = opts.up, u = opts.u, v = opts.v;
  var org = opts.origin || [0, 0, 0];
  var minDot = (opts.minDot != null) ? opts.minDot : 0.12;
  var uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
  var yLo = Infinity, yHi = -Infinity, faces = 0;
  for (var o = 0; o + 8 < soup.length; o += 9) {
    var n = NSO_gridTriNormal(soup, o);
    if (!n || NSO_gridDot(n, up) < minDot) continue;
    faces++;
    for (var k = 0; k < 3; k++) {
      var p = [soup[o + k * 3] - org[0], soup[o + k * 3 + 1] - org[1], soup[o + k * 3 + 2] - org[2]];
      var su = NSO_gridDot(p, u), sv = NSO_gridDot(p, v), sy = NSO_gridDot(p, up);
      if (su < uLo) uLo = su;
      if (su > uHi) uHi = su;
      if (sv < vLo) vLo = sv;
      if (sv > vHi) vHi = sv;
      if (sy < yLo) yLo = sy;
      if (sy > yHi) yHi = sy;
    }
  }
  if (!faces) return null;
  return { faces: faces, u: [uLo, uHi], v: [vLo, vHi], up: [yLo, yHi] };
}

/* One family of parallel planes vs one triangle.
   s0..s2 are the three vertices' coordinates along the plane direction,
   already measured from the grid origin. Emits the chord where each plane
   k * spacing crosses the triangle - a segment whose endpoints are points
   OF the triangle, which is what makes the line follow the surface. */
function NSO_gridSliceTri(soup, o, s, spacing, out, axisOut, lift, n, eps) {
  var sLo = Math.min(s[0], s[1], s[2]), sHi = Math.max(s[0], s[1], s[2]);
  var kLo = Math.ceil((sLo - eps) / spacing), kHi = Math.floor((sHi + eps) / spacing);
  // A triangle wider than the whole grid would be a sign the caller passed a
  // spacing of ~0; the bound keeps a bad call cheap rather than hanging.
  if (!(kHi - kLo < 100000)) return 0;
  var made = 0;
  for (var k = kLo; k <= kHi; k++) {
    var t = k * spacing;
    var px = [], py = [], pz = [];
    for (var e = 0; e < 3; e++) {
      var a = e, b = (e + 1) % 3;
      var da = s[a] - t, db = s[b] - t;
      if (da === 0) {
        px.push(soup[o + a * 3]); py.push(soup[o + a * 3 + 1]); pz.push(soup[o + a * 3 + 2]);
      } else if (db !== 0 && (da < 0) !== (db < 0)) {
        var w = da / (da - db);
        px.push(soup[o + a * 3] + w * (soup[o + b * 3] - soup[o + a * 3]));
        py.push(soup[o + a * 3 + 1] + w * (soup[o + b * 3 + 1] - soup[o + a * 3 + 1]));
        pz.push(soup[o + a * 3 + 2] + w * (soup[o + b * 3 + 2] - soup[o + a * 3 + 2]));
      }
    }
    if (px.length < 2) continue;
    // Three hits means a vertex sat exactly on the plane; the chord is the
    // farthest-apart pair either way.
    var iA = 0, iB = 1, best = -1;
    for (var i = 0; i < px.length; i++) {
      for (var j = i + 1; j < px.length; j++) {
        var dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > best) { best = d2; iA = i; iB = j; }
      }
    }
    if (!(best > 1e-18)) continue;
    /* Lifted off the face along the face's own normal. The paint in
       app-mask.js gets the same job done with polygonOffset and moves
       nothing - but polygon offset is for polygons, and these are lines,
       so the depth buffer would not hear about it. The lift is tenths of
       a hair, it is applied to the OVERLAY's vertices only, and the piece
       it is drawn on is never touched. */
    var dst = (k === 0 && axisOut) ? axisOut : out;
    dst.push(px[iA] + n[0] * lift, py[iA] + n[1] * lift, pz[iA] + n[2] * lift);
    dst.push(px[iB] + n[0] * lift, py[iB] + n[1] * lift, pz[iB] + n[2] * lift);
    made++;
  }
  return made;
}

/**
 * Grid lines lying on the up-facing surface of a triangle soup.
 *
 * opts:
 *   up        unit vector the grid calls "up", in the soup's own space
 *   u, v      unit vectors the two line families run across (perpendicular
 *             to each other; each grid plane contains `up`)
 *   origin    where line 0 of each family sits; default: centre of the
 *             up-facing surface, so the centre cross marks its middle
 *   spacing   mm between lines; default: a ladder value near `target`
 *   target    wanted divisions across the wider side (default 12)
 *   minDot    how steeply a triangle may face and still count (default 0.12)
 *   lift      mm to raise the emitted points along each triangle's normal
 *   maxSegments  hard cap, so a pathological mesh cannot lock the tab up
 *
 * returns { grid, axis, spacing, origin, count, faces, clipped } where grid
 * and axis are flat [x,y,z, x,y,z] segment-endpoint pairs - axis holds the
 * two centre lines, grid the rest.
 */
function NSO_surfaceGridLines(soup, opts) {
  opts = opts || {};
  var up = opts.up || [0, 1, 0];
  var u = opts.u || [1, 0, 0];
  var v = opts.v || [0, 0, 1];
  var minDot = (opts.minDot != null) ? opts.minDot : 0.12;
  var lift = (opts.lift != null) ? opts.lift : 0;
  var maxSeg = (opts.maxSegments > 0) ? opts.maxSegments : 60000;
  var empty = { grid: [], axis: [], spacing: 0, origin: [0, 0, 0], count: 0, faces: 0, clipped: false };
  if (!soup || soup.length < 9) return empty;

  var b = NSO_surfaceGridBounds(soup, { up: up, u: u, v: v, minDot: minDot });
  if (!b) return empty;

  /* Anchored on the middle of the top surface, not on the piece's bounding
     box: the question the grid answers is "is this centred / how far off is
     it", and the answer is read against the face you can see. */
  var org = opts.origin;
  if (!org) {
    var cu = (b.u[0] + b.u[1]) / 2, cv = (b.v[0] + b.v[1]) / 2;
    org = [cu * u[0] + cv * v[0], cu * u[1] + cv * v[1], cu * u[2] + cv * v[2]];
  }
  var spacing = opts.spacing;
  if (!(spacing > 0)) {
    spacing = NSO_gridSpacing(Math.max(b.u[1] - b.u[0], b.v[1] - b.v[0]), opts.target);
  }

  var grid = [], axis = [];
  var eps = spacing * 1e-9;
  var count = 0, clipped = false;
  for (var o = 0; o + 8 < soup.length; o += 9) {
    var n = NSO_gridTriNormal(soup, o);
    if (!n || NSO_gridDot(n, up) < minDot) continue;
    var su = [], sv = [];
    for (var k = 0; k < 3; k++) {
      var p = [soup[o + k * 3] - org[0], soup[o + k * 3 + 1] - org[1], soup[o + k * 3 + 2] - org[2]];
      su.push(NSO_gridDot(p, u));
      sv.push(NSO_gridDot(p, v));
    }
    count += NSO_gridSliceTri(soup, o, su, spacing, grid, axis, lift, n, eps);
    count += NSO_gridSliceTri(soup, o, sv, spacing, grid, axis, lift, n, eps);
    if (count > maxSeg) { clipped = true; break; }
  }
  return { grid: grid, axis: axis, spacing: spacing, origin: org,
           count: count, faces: b.faces, clipped: clipped };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NSO_GRID_LADDER: NSO_GRID_LADDER,
    NSO_gridSpacing: NSO_gridSpacing,
    NSO_gridTriNormal: NSO_gridTriNormal,
    NSO_surfaceGridBounds: NSO_surfaceGridBounds,
    NSO_surfaceGridLines: NSO_surfaceGridLines
  };
}
