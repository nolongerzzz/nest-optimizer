/* nso_skin_band.js - the OTHER wrap: a conformal skin over a CURVED face.

   Loads as a classic script (window.NSO_SkinBand) and as a Node module
   (require('../nso_skin_band.js')). No DOM, no Three.js. A mesh is the app's
   raw soup, a Float32Array/Array of 9 numbers per triangle.

   This is the ticket docs/HANDOFF.md parked as "the OTHER wrap: a skin on a
   curved face", built to the shape that audit laid out. Read that section
   first; this header says what changed and what it costs.

   ---------------------------------------------------------------------------
   WHAT BLOCKED IT, AND WHAT EACH BLOCKER COST
   ---------------------------------------------------------------------------
   The audit named three, and all three are real - none of them was a missing
   parameter or a tolerance that could be loosened:

   1. PLANE-EXACT GROUPING. `NSO_Skin.findFace` groups triangles by exact
      plane (`|g.d - off| < 1e-4` with parallel normals), so a tessellated
      cylinder is one group per facet, not one surface. A 64-facet cylinder
      side is 64 faces to that finder, each one a tall thin rectangle.
      -> replaced here by `findBand`: a DEVELOPABLE-BAND finder. It does not
         group by plane at all. It finds the one axis every facet normal is
         perpendicular to, checks the whole soup really is a cylinder about
         it, and hands back the band as ONE surface with its own (u, v)
         parameters - u arc length around, v along the axis.

   2. THE RECTANGLE REQUIREMENT. `rectFrame` needs the face boundary to
      reduce to 4 corners at right angles. No curved patch has one; a closed
      band does not even have a single boundary loop - it has TWO, the cap
      rims. `fixture_sphere_curved.stl` is refused with
      `face is not a rectangle (3 corners)`, and that refusal is correct and
      stays.
      -> replaced here by the band's own frame. The boundary is the two rim
         loops, and the seam bookkeeping is done against those loops rather
         than against four straight sides (see `makeRim` below, which is
         `makeSides` for a closed polyline).

   3. SINGLE-NORMAL LIFTING. `gridRelief` lifts every node along one constant
      `N` (`lift(p, h) = p + N*h`), and `wallBetween` takes the same constant.
      Over a curved base that is not a skin, it is a slab: the pattern would
      stand off the surface everywhere except where it was tangent.
      -> replaced here by a PER-NODE normal. `bandRelief` lifts node i along
         the radial direction at that node's own angle, and the walls take a
         normal at each end. That is the one substantive change to the relief
         maths, and it is the whole of "conformal": at h = 0 the surface is
         the original facets bit for bit, and above it every point moves
         straight out from the axis.

   ---------------------------------------------------------------------------
   WHAT IS REUSED UNCHANGED - the pattern plans
   ---------------------------------------------------------------------------
   `NSO_Skin.patternPlan` is called here with no modification, on a frame from
   `NSO_Skin.planeFrame` whose W is the band's CIRCUMFERENCE and whose D is
   its axial length. The rib intervals were always a 1D problem per axis, so
   a plan built over an unrolled band is the same plan. crosshatch and zigzag
   both come through; `ring` has no height field and is refused by name.

   Two adapter layers sit between that plan and the band, and they are the
   only places this file touches the pattern:

   a. THE SEAM IS NOT A MARGIN. A flat face keeps the pattern off all four
      edges with `margin`. A band has no edges in u - it closes on itself -
      so a margin in u would be a bald stripe down the cylinder, which is the
      opposite of a wrap. So the plan is always built with `margin: 0` and
      the pitch is SNAPPED to an exact divisor of the circumference:
      `k = round(C / pitch)`, `pitch = C / k`. With margin 0, `ribIntervals`
      centres k ribs in C and leaves exactly half a gap at each end, so the
      wrap-around gap is one full `pitch - rib` and the pattern is periodic.
      The snap is reported (`pitchAsked` / `pitch`), never silent: a pattern
      that does not divide the circumference cannot close, and rounding it
      quietly would put a seam defect where the ticket asked for a wrap.
      The snapped pitch is used axially too, so the lattice stays square.

   b. THE AXIAL MARGIN IS THIS FILE'S. The plan is built on a frame of height
      `D - 2*margin` and shifted up by `margin`, and two rim rows at height 0
      are added at v in [0, margin] and [D - margin, D]. That is what keeps
      the relief's perimeter ON the original rim loops, which is what lets
      the caps stay where they are.

   ---------------------------------------------------------------------------
   WHY THE RESULT IS ONE WATERTIGHT SHELL
   ---------------------------------------------------------------------------
   Same discipline as the flat seam, in a different frame:

   - The base of the relief is the ORIGINAL faceted surface, not an idealised
     cylinder. A node at angle t sits on the chord of the facet that contains
     t, interpolated between the two real mesh vertices. At h = 0 the relief
     reproduces the facets exactly, so the rim rows meet the cap rims on the
     nose.
   - `breaksU` is MERGED with the band's own facet angles before anything is
     built, so every grid node column lands on or inside one facet and no
     original rim vertex is skipped. Splitting a cell at an extra u break
     cannot change the pattern: `cellHeights` is evaluated at midpoints and
     the zigzag profile is piecewise linear with its breakpoints already in.
   - Every u break the relief introduces is registered on BOTH rims, and
     every cap triangle that owns a piece of a rim is re-emitted as a fan
     over the rim's registered points (`fanCapTri`). So no T-junction is
     left behind, exactly as `fanWalls` does for a flat face.
   - u wraps: node column `nu` IS node column 0. There is no seam column and
     no duplicated vertex ring, which is why the wrap closes rather than
     nearly closing.

   ---------------------------------------------------------------------------
   CONTACT AREA ON A CURVED FACE - the number that is easy to get wrong
   ---------------------------------------------------------------------------
   A flat skin's contact is the plan area of its tip cells, because the tips
   are a translate of the base. On a cylinder they are not: a tip cell that
   is `du` by `dv` on the base surface is `du * (r + h) / r` by `dv` once it
   has been lifted h clear of a radius-r surface. Three numbers come back, and
   the caller is expected to quote the first:

     tipArea          (r+h)/r * sum(du*dv)        the real contact area, on
                                                  the tip surface, against a
                                                  mating part that follows the
                                                  curve. THIS is the number a
                                                  caller quotes.
     tipAreaUnrolled  sum(du*dv)                  the same cells measured on
                                                  the unrolled band - exactly
                                                  what the flat engine's
                                                  tipArea would have said, and
                                                  6.0% LOW on the shipped
                                                  fixture (r 10, h 0.6)
     tipAreaFaceted   sum(2(r+h)sin(du/2r) * dv)  the same cells as the mesh
                                                  really carries them, on
                                                  chords rather than arcs -
                                                  the closed form for what
                                                  summing the exported
                                                  triangles gives, so a
                                                  checker has something exact
                                                  to compare a measurement to

   The suite gates all three against the exported STL, because "the flat
   number is close enough" is exactly the assumption that makes a breakaway
   interface print solid.

   Relief volume has the same curvature term and the same trap:
     V = (raised plan area) * h * (1 + h / (2r))
   The `h / (2r)` is the whole difference between a skin on a cylinder and a
   skin on a plane; at r 10, h 0.6 it is 3%.

   ---------------------------------------------------------------------------
   SCOPE - stated, not discovered
   ---------------------------------------------------------------------------
   - ONE curved primitive: a cylinder. Not an arbitrary developable band and
     not a free-form surface. A sphere is doubly curved, has no single axis
     and is refused by name, as it already was.
   - The cylinder's side must be a single ring of facets between the two cap
     rims. A side tessellated into several rings up the axis is refused and
     named rather than guessed at - the rim bookkeeping below assumes the
     band's only vertices are its two rims.
   - Raise only. Recess cuts valleys into the face and needs a rim at the
     original surface to stop at; on a band the u direction has no rim, and
     inventing one is the bald stripe again.
   - Seat against a curved contact is OUT OF SCOPE and is its own ticket.
     `NSO_Skin.supportExtreme` translates along one normal and explicitly
     does not tilt-fit a skin; a curved interface has no single contact
     plane. Nothing in this file touches Seat, and nothing here should be
     read as having answered that question. See docs/CURVED-SKIN.md.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   NSO_SkinBand.findBand(soup, opts?)   -> band | reason string
   NSO_SkinBand.bandPlan(band, opts)    -> plan | reason string
   NSO_SkinBand.applyBandSkin(soup, opts)
     -> { ok, reason?, tris, band, pattern, params, pitch, pitchAsked,
          ribsU, ribsV, margin, tipHeight, tipArea, tipAreaUnrolled,
          tipAreaFaceted, reliefTris, capTrisFanned, volumeAdded,
          describe }
   NSO_SkinBand.measureBand(soup, band, tipRadius, tol)
     -> measured tip / base / cap areas straight off a soup, for a checker
*/
(function (root) {
  'use strict';

  /* ------------------------------------------------------------ vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 0 ? scale(a, 1 / L) : [0, 0, 0]; }
  function lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function triCount(soup) { return (soup.length / 9) | 0; }
  function vtx(soup, t, k) { var o = t * 9 + k * 3; return [soup[o], soup[o + 1], soup[o + 2]]; }
  function pushTri(out, a, b, c) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  function pushOriented(out, a, b, c, want) {
    var n = cross(sub(b, a), sub(c, a));
    if (dot(n, want) >= 0) pushTri(out, a, b, c); else pushTri(out, a, c, b);
  }
  var TAU = Math.PI * 2;
  /* Never returns TAU: a tiny negative angle rounds to exactly TAU once TAU
     is added back, and 0 and TAU are the same point on a rim. One registered
     twice is one open edge. */
  function wrapAngle(t) { t = t % TAU; if (t < 0) t += TAU; return t >= TAU ? 0 : t; }

  /* Enclosed signed volume of a soup - positive for an outward-wound solid. */
  function soupVolume(soup) {
    var n = triCount(soup), v = 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      v += soup[o] * (soup[o + 4] * soup[o + 8] - soup[o + 5] * soup[o + 7])
         - soup[o + 1] * (soup[o + 3] * soup[o + 8] - soup[o + 5] * soup[o + 6])
         + soup[o + 2] * (soup[o + 3] * soup[o + 7] - soup[o + 4] * soup[o + 6]);
    }
    return v / 6;
  }

  /* --------------------------------------------------- the band's axis

     Jacobi eigen-decomposition of the symmetric 3x3 area-weighted normal
     covariance sum(area * n n^T). For a cylinder with two flat caps the
     axis A is always an exact eigenvector: the caps contribute 2*pi*r^2 to
     A A^T and the side contributes pi*r*h to each direction perpendicular to
     it, so the matrix is c1*A A^T + c2*(I - A A^T) whatever the tessellation
     phase. WHICH of the three eigenvalues is A's depends on the aspect ratio
     (2r vs h), so all three eigenvectors are tried as candidates rather than
     assuming the smallest. That is why this is a fit and not a guess at the
     world axes: a cylinder lying on its side, or tipped, is found the same
     way as an upright one.                                                */
  function jacobiEig3(m) {
    var a = [[m[0][0], m[0][1], m[0][2]], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]];
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 64; sweep++) {
      var off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
      if (off < 1e-24) break;
      for (var p = 0; p < 2; p++) {
        for (var q = p + 1; q < 3; q++) {
          if (Math.abs(a[p][q]) < 1e-30) continue;
          var th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          var sg = th >= 0 ? 1 : -1;
          var t = sg / (Math.abs(th) + Math.sqrt(th * th + 1));
          var c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (var k = 0; k < 3; k++) {
            var akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (k = 0; k < 3; k++) {
            var apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
            var vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    var out = [];
    for (var i = 0; i < 3; i++) out.push({ value: a[i][i], vec: unit([v[0][i], v[1][i], v[2][i]]) });
    out.sort(function (x, y) { return x.value - y.value; });
    return out;
  }

  /* Two unit vectors perpendicular to A, right-handed: U x V = A. */
  function frameFor(A) {
    var seed = Math.abs(A[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var U = unit(cross(seed, A));
    var V = cross(A, U);
    return { U: U, V: V };
  }

  /* --------------------------------------------------- the band finder */

  /* Is the whole soup a cylinder about `A`? Returns a band or a reason.

     Deliberately strict, and every refusal names what it saw. The audit's
     rule for the flat finder holds here: a shape that is only nearly the one
     the engine was written for is some other shape, and skinning it would
     put relief where the owner did not ask for it.                        */
  function cylinderAbout(soup, A, tol) {
    var n = triCount(soup);
    var fr = frameFor(A), U = fr.U, V = fr.V;
    var i, t, k;

    /* axial extent and a 2D centre from the projected bbox */
    var wLo = Infinity, wHi = -Infinity, uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
    for (t = 0; t < n; t++) {
      for (k = 0; k < 3; k++) {
        var p = vtx(soup, t, k);
        var w = dot(p, A), pu = dot(p, U), pv = dot(p, V);
        if (w < wLo) wLo = w; if (w > wHi) wHi = w;
        if (pu < uLo) uLo = pu; if (pu > uHi) uHi = pu;
        if (pv < vLo) vLo = pv; if (pv > vHi) vHi = pv;
      }
    }
    var D = wHi - wLo;
    if (!(D > tol)) return 'the piece has no extent along this axis';
    var cu = (uLo + uHi) / 2, cv = (vLo + vHi) / 2;
    var rGuess = Math.max(uHi - uLo, vHi - vLo) / 2;
    if (!(rGuess > tol)) return 'the piece has no radius about this axis';

    /* Refine the centre and the radius on the points that are actually out at
       the rim (a cap's interior fan vertices sit at any radius and would drag
       a plain mean inwards). Three Gauss-Newton steps on the algebraic circle
       residual is plenty from a bbox start. */
    var pts = [];
    for (t = 0; t < n; t++) {
      for (k = 0; k < 3; k++) {
        var q = vtx(soup, t, k), qu = dot(q, U) - cu, qv = dot(q, V) - cv;
        if (Math.hypot(qu, qv) > 0.6 * rGuess) pts.push([dot(q, U), dot(q, V)]);
      }
    }
    if (pts.length < 9) return 'too few points out at the radius to fit a circle';
    var r = rGuess;
    for (var it = 0; it < 3; it++) {
      var sr = 0;
      for (i = 0; i < pts.length; i++) sr += Math.hypot(pts[i][0] - cu, pts[i][1] - cv) || 1e-12;
      var mr = sr / pts.length;
      /* one Landau step: move the centre by the mean of (distance - mean
         radius) along each point's own radial direction */
      var gu = 0, gv = 0;
      for (i = 0; i < pts.length; i++) {
        var eu = pts[i][0] - cu, ev = pts[i][1] - cv, e = Math.hypot(eu, ev) || 1e-12;
        gu += (e - mr) * (eu / e); gv += (e - mr) * (ev / e);
      }
      cu += gu / pts.length; cv += gv / pts.length;
      r = mr;
    }
    var worst = 0;
    for (i = 0; i < pts.length; i++) {
      var wu = pts[i][0] - cu, wv = pts[i][1] - cv;
      worst = Math.max(worst, Math.abs(Math.hypot(wu, wv) - r));
    }
    if (worst > tol) {
      return 'not a cylinder about this axis - the rim points are off a circle by ' +
             worst.toFixed(4) + ' mm (tolerance ' + tol + ')';
    }

    var origin = add(scale(U, cu), scale(V, cv));   /* a point on the axis, at w = 0 */
    function radiusOf(p) {
      var q = sub(p, origin);
      return Math.hypot(dot(q, U), dot(q, V));
    }
    function angleOf(p) {
      var q = sub(p, origin);
      return wrapAngle(Math.atan2(dot(q, V), dot(q, U)));
    }

    /* Every triangle is a cap or a side facet, and nothing else. */
    var bandTris = [], capTris = [], caps = { lo: 0, hi: 0 };
    for (t = 0; t < n; t++) {
      var a0 = vtx(soup, t, 0), b0 = vtx(soup, t, 1), c0 = vtx(soup, t, 2);
      var nv = cross(sub(b0, a0), sub(c0, a0));
      var L = len(nv);
      if (L < 1e-14) continue;                       /* a degenerate sliver carries no surface */
      nv = scale(nv, 1 / L);
      var axial = Math.abs(dot(nv, A));
      var ws = [dot(a0, A), dot(b0, A), dot(c0, A)];
      if (axial > 0.999) {
        var atLo = ws[0] < wLo + tol && ws[1] < wLo + tol && ws[2] < wLo + tol;
        var atHi = ws[0] > wHi - tol && ws[1] > wHi - tol && ws[2] > wHi - tol;
        if (!atLo && !atHi) return 'a flat facet that is neither cap plane - this is not a plain cylinder';
        if (atLo) caps.lo++; else caps.hi++;
        capTris.push(t);
      } else if (axial < 1e-3) {
        var rs = [radiusOf(a0), radiusOf(b0), radiusOf(c0)];
        if (Math.abs(rs[0] - r) > tol || Math.abs(rs[1] - r) > tol || Math.abs(rs[2] - r) > tol) {
          return 'a side facet whose vertices are not on the cylinder (radius ' +
                 rs[0].toFixed(3) + '/' + rs[1].toFixed(3) + '/' + rs[2].toFixed(3) + ' vs ' + r.toFixed(3) + ')';
        }
        for (k = 0; k < 3; k++) {
          if (ws[k] > wLo + tol && ws[k] < wHi - tol) {
            return 'the cylinder side is tessellated into more than one ring up the axis - ' +
                   'this engine is scoped to a single ring between the two rims';
          }
        }
        bandTris.push(t);
      } else {
        return 'a facet whose normal is neither along the axis nor across it - ' +
               'a cone, a fillet or a doubly curved surface, not a cylinder';
      }
    }
    if (!caps.lo || !caps.hi) return 'the cylinder has no cap on one end';
    if (bandTris.length < 6) return 'too few side facets to be a cylinder wall';

    /* The rims, as the mesh really has them. Angles are the facet corners. */
    var lo = new Map(), hi = new Map();
    for (i = 0; i < bandTris.length; i++) {
      for (k = 0; k < 3; k++) {
        var vp = vtx(soup, bandTris[i], k);
        var th = angleOf(vp), key = Math.round(th * 1e6);
        (dot(vp, A) < (wLo + wHi) / 2 ? lo : hi).set(key, { th: th, p: vp });
      }
    }
    var loArr = Array.from(lo.values()).sort(function (x, y) { return x.th - y.th; });
    var hiArr = Array.from(hi.values()).sort(function (x, y) { return x.th - y.th; });
    if (loArr.length !== hiArr.length) {
      return 'the two rims carry different vertex counts (' + loArr.length + ' vs ' + hiArr.length + ')';
    }
    /* A prism with few enough sides is not a curved surface, it is a set of
       flat rectangular faces - and those are exactly what
       `NSO_Skin.applySkinWrap` already skins, one face at a time, with a real
       rectangle frame and a real single normal. A 20 mm cube passes every
       test above about a face axis (its eight corners do lie on a cylinder of
       radius r*sqrt(2)), so this floor is what separates the two engines
       rather than an arbitrary neatness rule. Below it, say which engine the
       piece belongs to instead of banding it badly. */
    if (loArr.length < 12) {
      return (loArr.length === 8 || loArr.length === 11 ? 'an ' : 'a ') +
             loArr.length + '-sided prism, not a cylinder - its sides are flat ' +
             'rectangular faces, which Skin wrap already covers one face at a time';
    }
    for (i = 0; i < loArr.length; i++) {
      if (Math.abs(loArr[i].th - hiArr[i].th) > 1e-4) {
        return 'the two rims are not aligned facet for facet - the side is not a straight prism';
      }
      var gap = (i + 1 < loArr.length ? loArr[i + 1].th : loArr[0].th + TAU) - loArr[i].th;
      if (gap > Math.PI / 3) {
        return 'a ' + (gap * 180 / Math.PI).toFixed(1) + ' degree gap between side facets - ' +
               'the band does not go all the way round';
      }
    }

    /* Parameters are RELATIVE angles: phi = theta - theta0, with theta0 the
       band's own first facet vertex. phi is then in [0, TAU) with 0 exactly
       on a real vertex, strictly ascending around the loop, and with no wrap
       inside the range a node column can land in - u in [0, C) maps to
       phi = u / r with no modulo at all. Parametrising by the absolute angle
       instead puts the wrap somewhere arbitrary in the middle of the list and
       registers the seam point twice, which is one open edge. */
    var theta0 = loArr[0].th;
    return {
      A: A, U: U, V: V, origin: origin, r: r, wLo: wLo, wHi: wHi, D: D,
      circumference: TAU * r,
      theta0: theta0,
      thetas: loArr.map(function (x) { return x.th; }),
      phis: loArr.map(function (x) { return wrapAngle(x.th - theta0); }),
      rimLoPts: loArr.map(function (x) { return x.p; }),
      rimHiPts: hiArr.map(function (x) { return x.p; }),
      bandTris: bandTris, capTris: capTris,
      facets: loArr.length,
      radiusOf: radiusOf, angleOf: angleOf,
      phiOf: function (p) { return wrapAngle(angleOf(p) - theta0); }
    };
  }

  /* The band, or a reason string naming what stopped it. */
  function findBand(soup, opts) {
    opts = opts || {};
    var tol = opts.tol == null ? 1e-3 : opts.tol;
    if (!soup || triCount(soup) < 8) return 'empty soup';
    var n = triCount(soup), m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var t = 0; t < n; t++) {
      var a = vtx(soup, t, 0), b = vtx(soup, t, 1), c = vtx(soup, t, 2);
      var nv = cross(sub(b, a), sub(c, a));
      var L = len(nv);
      if (L < 1e-14) continue;
      var u = scale(nv, 1 / L);
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) m[i][j] += 0.5 * L * u[i] * u[j];
    }
    var eig = jacobiEig3(m), reasons = [];
    for (var e = 0; e < 3; e++) {
      var got = cylinderAbout(soup, eig[e].vec, tol);
      if (typeof got !== 'string') return got;
      reasons.push(got);
    }
    /* Report the candidate that got furthest, not all three: three near
       identical refusals read as noise and hide which axis was even tried. */
    reasons.sort(function (x, y) { return y.length - x.length; });
    return 'not a cylinder this engine can band: ' + reasons[0];
  }

  /* -------------------------------------------------- rim bookkeeping

     `makeSides` for a CLOSED polyline. A rim's parameter is the angle about
     the axis, which is monotone around the loop and needs no arc-length
     bookkeeping; the point AT an angle is the chord interpolation between
     the two real mesh vertices either side of it, so a point inserted here
     is on the original surface rather than on an idealised circle. That is
     what keeps the relief's rim rows welded to the caps.

     The epsilon is the seam tolerance in this rim's parameter, the same
     shape `makeSides` uses: `tol` mm at radius r is `tol / r` in angle.   */
  function makeRim(band, pts, tol) {
    return {
      band: band, w: dot(pts[0], band.A),
      ts: band.phis.slice(), pts: pts.slice(),
      base: band.phis.slice(), basePts: pts.slice(),
      eps: Math.max(1e-9, tol / Math.max(band.r, 1e-6))
    };
  }
  /* The point on the rim at relative angle phi, by chord interpolation
     between the two ORIGINAL vertices that bracket it. */
  function rimPointAt(rim, phi) {
    var band = rim.band, base = rim.base, nb = base.length;
    var i = nb - 1;
    for (var k = 0; k + 1 < nb; k++) {
      if (phi >= base[k] - 1e-12 && phi <= base[k + 1] + 1e-12) { i = k; break; }
    }
    var a = rim.basePts[i], b = rim.basePts[(i + 1) % nb];
    var th = band.theta0 + phi;
    /* s along the chord a->b where the ray at angle th crosses it */
    var au = dot(sub(a, band.origin), band.U), av = dot(sub(a, band.origin), band.V);
    var bu = dot(sub(b, band.origin), band.U), bv = dot(sub(b, band.origin), band.V);
    var du = Math.cos(th), dv = Math.sin(th);
    var ca = au * dv - av * du;
    var cb = (bu - au) * dv - (bv - av) * du;
    var s = Math.abs(cb) < 1e-15 ? 0 : -ca / cb;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    return lerp(a, b, s);
  }
  /* Register relative angle phi on the rim and return the point there. */
  function rimInsert(rim, phi) {
    var eps = rim.eps;
    if (phi >= TAU - eps) phi = 0;
    for (var i = 0; i < rim.ts.length; i++) {
      if (Math.abs(rim.ts[i] - phi) < eps) return rim.pts[i];
      if (rim.ts[i] > phi) {
        var p = rimPointAt(rim, phi);
        rim.ts.splice(i, 0, phi); rim.pts.splice(i, 0, p);
        return p;
      }
    }
    var q = rimPointAt(rim, phi);
    rim.ts.push(phi); rim.pts.push(q);
    return q;
  }
  /* The relative angle of p on this rim, or null if p is not on it. */
  function rimParam(rim, p, tol) {
    var band = rim.band;
    if (Math.abs(dot(p, band.A) - rim.w) > tol) return null;
    var phi = band.phiOf(p);
    if (len(sub(p, rimPointAt(rim, phi))) > tol) return null;
    return phi;
  }
  /* p -> q along whichever rim both sit on, through every registered angle
     between them, taking the SHORT way round (a triangle edge never spans
     more than half the cylinder). Null when the edge is on no rim. */
  function rimChain(p, q, rims, tol) {
    for (var k = 0; k < rims.length; k++) {
      var rim = rims[k];
      var tp = rimParam(rim, p, tol), tq = rimParam(rim, q, tol);
      if (tp === null || tq === null) continue;
      var d = shortWay(tq - tp);
      var mids = [], eps = rim.eps, i;
      for (i = 0; i < rim.ts.length; i++) {
        var rel = shortWay(rim.ts[i] - tp);
        if (d > 0 ? (rel > eps && rel < d - eps) : (rel < -eps && rel > d + eps)) {
          mids.push({ rel: rel, p: rim.pts[i] });
        }
      }
      mids.sort(function (x, y) { return d > 0 ? x.rel - y.rel : y.rel - x.rel; });
      var chain = [p];
      for (i = 0; i < mids.length; i++) {
        if (len(sub(mids[i].p, chain[chain.length - 1])) > tol && len(sub(mids[i].p, q)) > tol) chain.push(mids[i].p);
      }
      chain.push(q);
      return chain;
    }
    return null;
  }
  function shortWay(d) {
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return d;
  }

  /* One cap triangle, re-emitted so every registered rim point on any of its
     edges is a vertex of it. Same three cases `fanTri` has, for the same
     reason: two or three split edges are split at the centroid first so the
     interior edges stay paired. */
  function fanCapTri(v, rims, tol, out) {
    var chains = [null, null, null], split = -1, nSplit = 0;
    for (var e = 0; e < 3; e++) {
      var ch = rimChain(v[e], v[(e + 1) % 3], rims, tol);
      chains[e] = ch;
      if (ch && ch.length > 2) { if (split < 0) split = e; nSplit++; }
    }
    if (nSplit === 0) { pushTri(out, v[0], v[1], v[2]); return 0; }
    if (nSplit > 1) {
      var g = scale(add(add(v[0], v[1]), v[2]), 1 / 3);
      for (var e2 = 0; e2 < 3; e2++) {
        var ch2 = chains[e2] || [v[e2], v[(e2 + 1) % 3]];
        for (var c2 = 0; c2 + 1 < ch2.length; c2++) pushTri(out, ch2[c2], ch2[c2 + 1], g);
      }
      return 1;
    }
    var ch0 = chains[split], apex = v[(split + 2) % 3];
    for (var c = 0; c + 1 < ch0.length; c++) pushTri(out, ch0[c], ch0[c + 1], apex);
    return 1;
  }

  /* ------------------------------------------------------ the relief

     `gridRelief` with two changes and nothing else: u wraps (node column nu
     IS node column 0, so there is no seam), and every lift takes the node's
     OWN outward normal instead of one constant N.                        */

  /* A wall between two cells sharing the edge P0->P1, with a normal at each
     END. `gridRelief`'s wallBetween takes one N for the whole wall, which is
     right on a plane and wrong here: on a constant-v grid line the two ends
     of the wall are at different angles about the axis. The sign-crossing
     split is kept - a zigzag flank crosses zero inside a cell. */
  function wallBetween2(out, P0, P1, N0, N1, a0, a1, b0, b1, sideA) {
    var d0 = a0 - b0, d1 = a1 - b1;
    if (Math.abs(d0) < 1e-12 && Math.abs(d1) < 1e-12) return;
    if (d0 * d1 < 0) {
      var t = d0 / (d0 - d1);
      var Pc = lerp(P0, P1, t), Nc = unit(lerp(N0, N1, t)), hc = a0 + (a1 - a0) * t;
      wallBetween2(out, P0, Pc, N0, Nc, a0, hc, b0, hc, sideA);
      wallBetween2(out, Pc, P1, Nc, N1, hc, a1, hc, b1, sideA);
      return;
    }
    var want = (d0 + d1) > 0 ? scale(sideA, -1) : sideA;
    var A0 = add(P0, scale(N0, a0)), A1 = add(P1, scale(N1, a1));
    var B0 = add(P0, scale(N0, b0)), B1 = add(P1, scale(N1, b1));
    /* A wall that runs out to nothing at one end is a TRIANGLE, not a quad.
       Emitting it as a quad anyway puts a zero-area triangle in the soup and
       uses one of its edges three times - 124 odd and 124 non-manifold edges
       on the zigzag band, measured, because a sawtooth flank starts at height
       zero on every ridge. Both grid patterns reach this: the zigzag at each
       flank, and `wallBetween2`'s own sign-crossing split, which always
       produces a wall whose far end is a point. */
    var EPS = 1e-12;
    if (Math.abs(a0 - b0) < EPS && Math.abs(a1 - b1) < EPS) return;
    if (Math.abs(a0 - b0) < EPS) { pushOriented(out, A0, A1, B1, want); return; }
    if (Math.abs(a1 - b1) < EPS) { pushOriented(out, A0, B0, B1, want); return; }
    pushOriented(out, A0, A1, B1, want);
    pushOriented(out, A0, B1, B0, want);
  }

  function bandRelief(band, rims, breaksU, breaksV, cellHeights, out) {
    var nu = breaksU.length - 1;          /* node column nu wraps to 0 */
    var nv = breaksV.length - 1;
    var r = band.r, A = band.A, U = band.U, V = band.V;
    var theta0 = band.theta0;
    var i, j;

    /* per-node-column parameter and outward normal. PHI is the relative angle
       the rims are keyed on (u / r, no modulo needed - breaksU stops short of
       C); TH is the absolute angle the radial direction is built from. */
    var PHI = new Array(nu), TH = new Array(nu), NRM = new Array(nu);
    for (i = 0; i < nu; i++) {
      PHI[i] = breaksU[i] / r;
      var th = theta0 + PHI[i];
      TH[i] = th;
      NRM[i] = add(scale(U, Math.cos(th)), scale(V, Math.sin(th)));
    }

    /* base points: the rim rows come off the rims (so they sit on the
       ORIGINAL loop), the interior rows are interpolated between them, which
       on a straight prism is the exact surface. */
    var base = new Array(nu * (nv + 1));
    function idx(i2, j2) { return j2 * nu + (i2 % nu); }
    for (i = 0; i < nu; i++) {
      var pLo = rimInsert(rims[0], PHI[i]);
      var pHi = rimInsert(rims[1], PHI[i]);
      base[idx(i, 0)] = pLo;
      base[idx(i, nv)] = pHi;
      for (j = 1; j < nv; j++) base[idx(i, j)] = lerp(pLo, pHi, breaksV[j] / band.D);
    }

    var H = new Array(nu * nv), hmax = -Infinity;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h = cellHeights(breaksU[i], breaksU[i + 1], breaksV[j], breaksV[j + 1]);
      H[j * nu + i] = h;
      for (var q = 0; q < 4; q++) if (h[q] > hmax) hmax = h[q];
    }
    function lift(i2, p, h) { return h === 0 ? p : add(p, scale(NRM[i2 % nu], h)); }

    var start = out.length;
    var tipPlan = 0, tipFaceted = 0;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h4 = H[j * nu + i];
      var p00 = lift(i, base[idx(i, j)], h4[0]);
      var p10 = lift(i + 1, base[idx(i + 1, j)], h4[1]);
      var p11 = lift(i + 1, base[idx(i + 1, j + 1)], h4[2]);
      var p01 = lift(i, base[idx(i, j + 1)], h4[3]);
      /* outward is away from the axis: the cell's own mean radial direction */
      var wantN = add(NRM[i], NRM[(i + 1) % nu]);
      pushOriented(out, p00, p10, p11, wantN);
      pushOriented(out, p00, p11, p01, wantN);
      if (Math.abs(h4[0] - hmax) < 1e-9 && Math.abs(h4[1] - hmax) < 1e-9 &&
          Math.abs(h4[2] - hmax) < 1e-9 && Math.abs(h4[3] - hmax) < 1e-9) {
        var du = breaksU[i + 1] - breaksU[i], dv = breaksV[j + 1] - breaksV[j];
        tipPlan += du * dv;
        /* and the same cell as the MESH really carries it: the two triangles
           just emitted. That is what summing an exported STL gives, so the
           checker has a closed form to compare a measurement against rather
           than a tolerance to argue about. */
        tipFaceted += 0.5 * len(cross(sub(p10, p00), sub(p11, p00)))
                    + 0.5 * len(cross(sub(p11, p00), sub(p01, p00)));
      }
    }

    /* walls on the constant-u grid lines: both ends share one normal, so
       these are planar and take NRM[i] twice */
    for (i = 0; i < nu; i++) {
      var left = (i + nu - 1) % nu;
      for (j = 0; j < nv; j++) {
        var P0 = base[idx(i, j)], P1 = base[idx(i, j + 1)];
        var Lc = H[j * nu + left], Rc = H[j * nu + i];
        /* into the LEFT cell is backwards along the tangent at this angle */
        var tangent = add(scale(U, -Math.sin(TH[i])), scale(V, Math.cos(TH[i])));
        wallBetween2(out, P0, P1, NRM[i], NRM[i], Lc[1], Lc[2], Rc[0], Rc[3], scale(tangent, -1));
      }
    }
    /* walls on the constant-v grid lines: the two ends are at different
       angles, so each end takes its own normal */
    var negA = scale(A, -1);
    for (j = 0; j <= nv; j++) for (i = 0; i < nu; i++) {
      var Q0 = base[idx(i, j)], Q1 = base[idx(i + 1, j)];
      var B = j > 0 ? H[(j - 1) * nu + i] : null, T = j < nv ? H[j * nu + i] : null;
      var c0h = B ? B[3] : 0, c1h = B ? B[2] : 0;
      var d0h = T ? T[0] : 0, d1h = T ? T[1] : 0;
      wallBetween2(out, Q0, Q1, NRM[i], NRM[(i + 1) % nu], c0h, c1h, d0h, d1h, negA);
    }

    return {
      hmax: hmax,
      tipAreaUnrolled: tipPlan,
      tipArea: tipPlan * (r + hmax) / r,
      tipAreaFaceted: tipFaceted,
      reliefTris: (out.length - start) / 9,
      nodesU: nu, rowsV: nv
    };
  }

  /* ----------------------------------------------------- the plan */

  function skinApi() {
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./nso_skin.js'); } catch (e) { /* browser-style load below */ }
    }
    return (root && root.NSO_Skin) || null;
  }

  /* Merge extra breaks into a sorted list. Splitting a cell cannot change
     the pattern - `cellHeights` reads midpoints and the zigzag profile is
     piecewise linear with its own breakpoints already present - so this is
     free, and it is what makes every grid node land on or inside one facet. */
  function mergeSorted(a, b, eps) {
    var all = a.concat(b).sort(function (x, y) { return x - y; }), out = [];
    for (var i = 0; i < all.length; i++) if (!out.length || all[i] - out[out.length - 1] > eps) out.push(all[i]);
    return out;
  }

  /* The band's (u, v) plan: the flat pattern plan, unchanged, plus the two
     adapters this file owns - the snapped circumferential pitch and the
     axial margin rows. Returns the plan or a reason string. */
  function bandPlan(band, opts) {
    opts = opts || {};
    var Skin = skinApi();
    if (!Skin || !Skin.patternPlan) return 'nso_skin.js is not loaded - the band skin reuses its pattern plans';
    var name = opts.pattern || 'crosshatch';
    if (!Skin.PATTERNS[name]) return 'unknown pattern "' + name + '"';
    if (name === 'ring') {
      return 'ring builds its own surface and has no height field to lay out in (u, v) - ' +
             'a band takes the grid patterns (crosshatch, zigzag)';
    }
    if ((opts.mode || 'raise') !== 'raise') {
      return 'a band skin is raise-only: recess needs a rim at the original surface for the ' +
             'valleys to stop at, and a band has no rim in the wrap direction';
    }
    var p = Skin.withDefaults(name, opts.params);
    if (!(p.height > 0)) return 'height must be positive';
    if (!(p.pitch > 0)) return 'pitch must be positive';
    if (!(p.height < band.r)) return 'a relief ' + p.height + ' mm tall on a ' + band.r.toFixed(2) + ' mm radius is not a skin';

    var C = band.circumference, D = band.D;

    /* (a) snap the circumferential pitch so the pattern closes on itself */
    var pitchAsked = p.pitch;
    var k = Math.max(1, Math.round(C / pitchAsked));
    var pitch = C / k;

    /* (b) the axial margin is this file's, not the plan's */
    var margin = opts.margin == null ? pitch : opts.margin;
    if (!(margin > 0)) return 'a band skin needs an axial margin > 0 (the rim the relief stops at)';
    if (margin * 2 >= D) {
      return 'the axial margin ' + margin.toFixed(2) + ' mm leaves nothing of a ' + D.toFixed(2) + ' mm band';
    }

    var params = {};
    for (var key in p) if (Object.prototype.hasOwnProperty.call(p, key)) params[key] = p[key];
    params.pitch = pitch;
    params.margin = 0;                      /* the seam is not a margin - see the header */

    var fr = Skin.planeFrame([0, 0, 0], [1, 0, 0], [0, 1, 0], C, D - 2 * margin);
    if (typeof fr === 'string') return fr;
    var plan = Skin.patternPlan(name, params, fr, 0);
    if (typeof plan === 'string') return plan;

    /* facet angles as u, so every node column lands on or inside one facet */
    var facetU = [];
    for (var i = 1; i < band.phis.length; i++) facetU.push(band.phis[i] * band.r);
    var breaksU = mergeSorted(plan.breaksU, facetU, 1e-7);
    if (breaksU[0] > 1e-7) breaksU.unshift(0);
    while (breaksU.length > 1 && C - breaksU[breaksU.length - 1] < 1e-7) breaksU.pop();
    breaksU.push(C);

    var breaksV = [0];
    for (i = 0; i < plan.breaksV.length; i++) {
      var v = plan.breaksV[i] + margin;
      if (v > 1e-9 && v < D - 1e-9) breaksV.push(v);
    }
    breaksV.push(D - margin > breaksV[breaksV.length - 1] ? D - margin : D);
    breaksV = mergeSorted(breaksV, [margin, D - margin, D], 1e-9);

    var inner = plan.cellHeights;
    function cellHeights(u0, u1, v0, v1) {
      var vm = (v0 + v1) / 2;
      if (vm < margin || vm > D - margin) return [0, 0, 0, 0];
      return inner(u0, u1, v0 - margin, v1 - margin);
    }

    return {
      pattern: name, params: p, height: p.height,
      pitch: pitch, pitchAsked: pitchAsked, ribsAround: k, margin: margin,
      breaksU: breaksU, breaksV: breaksV, cellHeights: cellHeights,
      ribsU: plan.ribsU, ribsV: plan.ribsV, ridges: plan.ridges,
      describe: Skin.PATTERNS[name].describe(p)
    };
  }

  /* ----------------------------------------------------- the bake */

  function applyBandSkin(soup, opts) {
    opts = opts || {};
    var res = { ok: false, tris: soup };
    var tol = opts.tol == null ? 1e-4 : opts.tol;

    var band = findBand(soup, { tol: opts.findTol == null ? 1e-3 : opts.findTol });
    if (typeof band === 'string') { res.reason = band; return res; }

    var plan = bandPlan(band, opts);
    if (typeof plan === 'string') { res.reason = plan; return res; }

    var rims = [makeRim(band, band.rimLoPts, tol), makeRim(band, band.rimHiPts, tol)];

    var relief = [];
    var info = bandRelief(band, rims, plan.breaksU, plan.breaksV, plan.cellHeights, relief);

    /* Every registered rim angle must be a node column, or the relief's rim
       row would step over a point the caps carry and leave a T-junction.
       It holds by construction - the facet angles are merged into breaksU
       before anything is built - so this is the assertion that says so
       rather than a repair. */
    if (rims[0].ts.length !== info.nodesU || rims[1].ts.length !== info.nodesU) {
      res.reason = 'internal: the rim carries ' + rims[0].ts.length + '/' + rims[1].ts.length +
                   ' points against ' + info.nodesU + ' node columns - piece unchanged';
      return res;
    }

    /* the caps, re-fanned over every point the relief put on their rims */
    var out = [], fanned = 0;
    var bandSet = new Set(band.bandTris);
    var n = triCount(soup);
    for (var t = 0; t < n; t++) {
      if (bandSet.has(t)) continue;
      fanned += fanCapTri([vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)], rims, tol, out);
    }
    for (var i = 0; i < relief.length; i++) out.push(relief[i]);

    var tris = new Float32Array(out);
    res.ok = true;
    res.tris = tris;
    res.band = {
      axis: band.A, origin: band.origin, r: band.r, height: band.D,
      circumference: band.circumference, facets: band.facets,
      bandTris: band.bandTris.length, capTris: band.capTris.length
    };
    res.pattern = plan.pattern;
    res.params = plan.params;
    res.mode = 'raise';
    res.pitch = plan.pitch;
    res.pitchAsked = plan.pitchAsked;
    res.pitchSnapped = Math.abs(plan.pitch - plan.pitchAsked) > 1e-9;
    res.ribsAround = plan.ribsAround;
    res.margin = plan.margin;
    res.ribsU = plan.ribsU;
    res.ribsV = plan.ribsV;
    res.ridges = plan.ridges;
    res.tipHeight = info.hmax;
    res.tipRadius = band.r + info.hmax;
    res.tipArea = info.tipArea;
    res.tipAreaUnrolled = info.tipAreaUnrolled;
    res.tipAreaFaceted = info.tipAreaFaceted;
    res.reliefTris = info.reliefTris;
    res.capTrisFanned = fanned;
    res.nodesU = info.nodesU;
    res.rowsV = info.rowsV;
    res.volumeBefore = soupVolume(soup);
    res.volumeAfter = soupVolume(tris);
    res.volumeAdded = res.volumeAfter - res.volumeBefore;
    /* The closed form the suite gates on: the unrolled relief volume with the
       curvature term that separates a cylinder from a plane. Integrating a
       radial offset h over an arc gives (r*h + h*h/2) d(theta) d(v), so the
       relief carries a factor (1 + h/(2r)) that a flat skin does not - 3.0%
       at r 10, h 0.6, which is thirty times the faceting residual below.
       The MESH sits ~0.1% under this: its base is the inscribed prism, not
       the smooth cylinder the closed form integrates, so a little less
       material is there to be raised. The suite gates that residual rather
       than hiding it, and gates that the mesh is far closer to this value
       than to the flat `raisedArea * h`. */
    var mom = reliefMoments(plan);
    res.volumeExpected = mom.m1 + mom.m2 / (2 * band.r);
    res.volumeExpectedFlat = mom.m1;
    res.raisedArea = mom.raisedArea;
    res.describe = plan.describe + ' wrapped round a r ' + band.r.toFixed(2) +
      ' x ' + band.D.toFixed(2) + ' mm cylinder, ' + plan.ribsAround +
      ' repeats around at ' + plan.pitch.toFixed(3) + ' mm arc pitch';
    return res;
  }

  /* The two moments of the height field over the unrolled band:

       m1 = integral of h du dv        the relief's volume if the face were FLAT
       m2 = integral of h*h du dv      the curvature term's weight

     A radial offset h over a radius-r surface encloses (r*h + h*h/2) per unit
     angle per unit v, which in unrolled (u, v) is (h + h*h/(2r)). So the
     relief's volume on a cylinder is m1 + m2/(2r), and m1 alone is what a
     flat engine would predict. For a flat-topped pattern m2 = m1 * h and the
     whole thing collapses to the familiar area * h * (1 + h/(2r)); for the
     zigzag it does NOT, because most of a sawtooth is shorter than its crest,
     and using hmax there overstates the curvature term by a factor of three.

     h is bilinear over a cell, so 2x2 Gauss-Legendre integrates both moments
     exactly (h*h is degree 2 in each variable, and 2-point Gauss is exact to
     degree 3).                                                            */
  var GAUSS = [0.5 - 0.5 / Math.sqrt(3), 0.5 + 0.5 / Math.sqrt(3)];
  function reliefMoments(plan) {
    var bu = plan.breaksU, bv = plan.breaksV, m1 = 0, m2 = 0, raised = 0, h = plan.height;
    for (var j = 0; j + 1 < bv.length; j++) {
      for (var i = 0; i + 1 < bu.length; i++) {
        var c = plan.cellHeights(bu[i], bu[i + 1], bv[j], bv[j + 1]);
        var du = bu[i + 1] - bu[i], dv = bv[j + 1] - bv[j], A = du * dv;
        var sum1 = 0, sum2 = 0;
        for (var gs = 0; gs < 2; gs++) for (var gt = 0; gt < 2; gt++) {
          var sS = GAUSS[gs], tT = GAUSS[gt];
          var hv = c[0] * (1 - sS) * (1 - tT) + c[1] * sS * (1 - tT) + c[2] * sS * tT + c[3] * (1 - sS) * tT;
          sum1 += hv; sum2 += hv * hv;
        }
        m1 += A * sum1 / 4;
        m2 += A * sum2 / 4;
        raised += A * ((c[0] + c[1] + c[2] + c[3]) / 4) / h;
      }
    }
    return { m1: m1, m2: m2, raisedArea: raised };
  }
  /* The plan area of everything the pattern raises, weighted by how tall it
     is - kept as its own name because the status line quotes it. */
  function raisedArea(plan) { return reliefMoments(plan).raisedArea; }

  /* --------------------------------------------------- measurement

     Straight off a soup, with no reference to the plan that built it - this
     is what a checker points at an exported STL. Areas are summed from the
     triangles themselves, so what comes back is the FACETED area, which sits
     just below the analytic one on a curved surface and is supposed to.   */
  function measureBand(soup, band, tipRadius, tol) {
    tol = tol == null ? 1e-3 : tol;
    /* the facet sagitta: how far the inscribed prism falls inside the circle
       between two vertices. Every radius in the mesh is spread by this much. */
    var tipTol = band.r * (1 - Math.cos(Math.PI / band.facets)) + tol;
    var n = triCount(soup);
    var out = { tipArea: 0, baseArea: 0, capArea: 0, wallArea: 0, other: 0,
                tipTris: 0, baseTris: 0, capTris: 0, wallTris: 0,
                rMin: Infinity, rMax: -Infinity, wMin: Infinity, wMax: -Infinity };
    for (var t = 0; t < n; t++) {
      var a = vtx(soup, t, 0), b = vtx(soup, t, 1), c = vtx(soup, t, 2);
      var area = 0.5 * len(cross(sub(b, a), sub(c, a)));
      var rs = [band.radiusOf(a), band.radiusOf(b), band.radiusOf(c)];
      var ws = [dot(a, band.A), dot(b, band.A), dot(c, band.A)];
      for (var k = 0; k < 3; k++) {
        if (rs[k] < out.rMin) out.rMin = rs[k];
        if (rs[k] > out.rMax) out.rMax = rs[k];
        if (ws[k] < out.wMin) out.wMin = ws[k];
        if (ws[k] > out.wMax) out.wMax = ws[k];
      }
      /* Classification is by a MID-RELIEF radius, not by "at radius r + h".
         The relief's base is the inscribed prism, so a tip vertex sits at
         rho(theta) + h with rho between r*cos(half a facet) and r - a spread
         of 0.012 mm on the shipped fixture, twelve times a sane tolerance.
         Testing against r + h exactly threw away 99.9% of the tip area and
         read the contact as 1.36 mm2 where it is 1058. The bands are cleanly
         separated as long as the relief is taller than the facet sagitta,
         which findBand's facet floor already guarantees. A zigzag needs the
         all-three-vertices test rather than a midpoint one for a second
         reason: its relief is a continuous sawtooth, so a flank triangle
         straddles any midpoint threshold and would be counted as contact
         when only the crests touch - 14% high, measured.                  */
      var atCap = (Math.abs(ws[0] - band.wLo) < tol && Math.abs(ws[1] - band.wLo) < tol && Math.abs(ws[2] - band.wLo) < tol) ||
                  (Math.abs(ws[0] - band.wHi) < tol && Math.abs(ws[1] - band.wHi) < tol && Math.abs(ws[2] - band.wHi) < tol);
      var atTip = rs[0] > tipRadius - tipTol && rs[1] > tipRadius - tipTol && rs[2] > tipRadius - tipTol;
      var atBase = rs[0] < band.r + tipTol && rs[1] < band.r + tipTol && rs[2] < band.r + tipTol;
      if (atCap) { out.capArea += area; out.capTris++; }
      else if (atTip) { out.tipArea += area; out.tipTris++; }
      else if (atBase) { out.baseArea += area; out.baseTris++; }
      else { out.wallArea += area; out.wallTris++; }
    }
    return out;
  }

  var api = {
    findBand: findBand,
    reliefMoments: reliefMoments,
    bandPlan: bandPlan,
    applyBandSkin: applyBandSkin,
    measureBand: measureBand,
    raisedArea: raisedArea,
    soupVolume: soupVolume
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SkinBand = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
