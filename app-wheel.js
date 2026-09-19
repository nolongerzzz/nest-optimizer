// ===================== Pottery Wheel: throw a vessel on an axis =============
// Sections 1-7 are headless: no DOM, no Three.js, no app state, so the same
// file runs under node for the self-test (tools/nso_wheel_test.js) and under a
// classic script tag in the browser. Section 8 is the commit half and the UI.
//
// Speaks rawTris on the way out - the flat Float32Array triangle soup, 9
// floats per triangle, Z up, millimetres, that Cut, Soften, Sculpt and Extend
// all pass around. It does NOT speak rawTris on the way in. A thrown piece is
// held as its MERIDIAN PROFILE and revolved fresh on every update, because
// that is what makes the two constraints below cheap enough to run live.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
// ---------------------------------------------------------------------------
// A potter's wheel. A ball of clay, centred on the axis, is opened, pulled and
// trimmed into a vessel. Four moves, in the order a potter makes them:
//
//   1. BALL   a smooth centred sphere, sized from the target vessel's height
//             by Pappus's centroid theorem (section 3).
//   2. OPEN   one push down the middle. The single outer profile becomes TWO -
//             outer and inner - and everything after this point is a shell.
//   3. PULL   drag-shape the profile at ANY height, not only the top edge.
//             The drag points are spline-fitted, never left faceted, and the
//             form is revolved to a clean solid on every update.
//   4. TRIM   clean the excess off the base once the form is set.
//
// Plus one move that is not this file's work and is not reimplemented here:
// RIM EXTENSION calls Extend (app-extend.js) directly. Adding height at the
// current top edge is exactly an axis-preserving stretch of a straight wall,
// which Extend already does bit-for-bit and already gates. See section 7.
//
// ---------------------------------------------------------------------------
// THE TWO CONSTRAINTS, enforced on every single update
// ---------------------------------------------------------------------------
// A potter cannot conjure clay and cannot pull a wall thinner than the clay
// will stand. Both are real, both are enforced here, and neither is a dead end:
//
//   MATERIAL BUDGET   ceiling = the starting ball + everything explicitly
//     added - everything trimmed away. The live form can never exceed it.
//     Refusing says what to do next: extend the rim, or add clay here.
//
//   WALL FLOOR        the canonical nozzle-safety floor from nso_thickness.js.
//     NOT a second opinion, NOT a copy of the number: NSO_Thickness.floorFor()
//     is the only place the floor comes from, and this file refuses to load a
//     piece at all if that module is missing, rather than falling back to a
//     literal that would drift from it. Refusing says what to do next too.
//
// Both refusals follow the house contract the sculpt tier set: `ok` is false,
// `reason` is set, and `piece` is the ORIGINAL piece object, so a caller can
// swap unconditionally without checking.
//
// ---------------------------------------------------------------------------
// OUT OF SCOPE for this first version, named so the next ticket does not have
// to re-derive it
// ---------------------------------------------------------------------------
//   1. NON-SYMMETRIC APPENDAGES - handles, spouts, feet, lugs. Everything here
//      is a solid of revolution held as one meridian profile, and that
//      representation cannot express a handle at all. Adding one means a
//      boolean union against a non-revolved body, which is Join's job and a
//      separate ticket. Real, deferred, deliberately absent.
//   2. CENTRING AN ARBITRARY / ASYMMETRIC STARTING MESH. The wheel starts from
//      a ball it generates itself, which is centred by construction. Taking an
//      imported piece and finding the axis it wants to spin about is a real
//      problem (a covariance axis, a radial-variance minimiser and a decision
//      about what to do with the material that does not fit) and it is not
//      solved here. Real, deferred, deliberately absent.
//   3. RE-ENTRANT FORMS. The profile is r as a function of z, so a closed-in
//      neck is fine and a torus section is not. A form that doubles back on
//      itself in z needs a parametric meridian and a different set of gates.

/* =====================================================================
   1. The floor comes from one place

   nso_thickness.js is the canonical answer to "is this thick enough to
   print?" and floorFor(nozzle) is its stated floor: nozzle x 1.05, which is
   0.42 mm at a 0.4 mm nozzle. This file does not carry that number, does not
   re-derive it, and does not default around it. If the module is absent the
   wheel refuses to start - a silent literal here is exactly how the repo
   ended up with seven copies of this question last time.
   ===================================================================== */

function NSO_wheelThickness() {
  if (typeof NSO_Thickness !== 'undefined' && NSO_Thickness) return NSO_Thickness;
  if (typeof window !== 'undefined' && window.NSO_Thickness) return window.NSO_Thickness;
  return null;
}

function NSO_wheelFloor(nozzle) {
  var T = NSO_wheelThickness();
  if (!T || typeof T.floorFor !== 'function') {
    throw new Error('nso_thickness.js is not loaded - the Pottery Wheel takes its ' +
                    'wall floor from NSO_Thickness.floorFor() and will not invent one');
  }
  return T.floorFor(nozzle);
}

/* =====================================================================
   2. Profile primitives

   A profile is an array of { z, r }, sorted by ASCENDING z, r >= 0. The
   outer profile runs from the base upward; the inner profile, once the piece
   is opened, runs from the cavity floor upward. Both are dense - a pull moves
   sample radii, it does not re-tessellate - so every gate below is a scan.
   ===================================================================== */

var NSO_WHEEL_EPS = 1e-6;

function NSO_wheelClone(profile) {
  var out = new Array(profile.length);
  for (var i = 0; i < profile.length; i++) out[i] = { z: profile[i].z, r: profile[i].r };
  return out;
}

function NSO_wheelSpan(profile) {
  return { lo: profile[0].z, hi: profile[profile.length - 1].z };
}

/* Keep a profile honest about where it starts and stops.

   A pull clamps radii at zero, so a displacement that reaches the base can
   drive several consecutive samples at the bottom of the form to r = 0. The
   revolve then quite correctly emits nothing for a band whose two ends are
   both on the axis - so the SOLID starts higher than the profile says it
   does, while the analytic volume, which also gets zero out of those
   segments, still agrees. Profile and mesh part company silently, and the
   first thing to notice is the build-volume check reporting a height the
   piece does not have.

   Found by tools/nso_wheel_canonical_check.js comparing the checker's bbox
   against the profile's own span: a pulled bowl claimed a base at z = 0 and
   the mesh started at z = 0.112. Tidying every profile on its way into a
   piece is the fix - one axis point at each end, and never two.           */
function NSO_wheelTidy(profile) {
  if (!profile || profile.length < 2) return profile;
  var lo = 0, hi = profile.length - 1;
  while (lo + 1 < hi && profile[lo + 1].r <= NSO_WHEEL_EPS) lo++;
  while (hi - 1 > lo && profile[hi - 1].r <= NSO_WHEEL_EPS) hi--;
  if (lo === 0 && hi === profile.length - 1) return profile;
  var out = profile.slice(lo, hi + 1);
  /* Pin a collapsed end exactly onto the axis - 1e-9 of radius is a sliver
     ring, not a pole - but never zero an end that was always a real radius,
     such as the rim of an opened piece. */
  if (out[0].r <= NSO_WHEEL_EPS) out[0] = { z: out[0].z, r: 0 };
  var last = out.length - 1;
  if (out[last].r <= NSO_WHEEL_EPS) out[last] = { z: out[last].z, r: 0 };
  return out;
}

/* r at an arbitrary height, by linear interpolation between samples. Outside
   the profile's own span it clamps to the nearer end rather than
   extrapolating, because extrapolating a wall past the rim invents material. */
function NSO_wheelRadiusAt(profile, z) {
  var n = profile.length;
  if (!n) return 0;
  if (z <= profile[0].z) return profile[0].r;
  if (z >= profile[n - 1].z) return profile[n - 1].r;
  var lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    var mid = (lo + hi) >> 1;
    if (profile[mid].z <= z) lo = mid; else hi = mid;
  }
  var dz = profile[hi].z - profile[lo].z;
  if (dz <= NSO_WHEEL_EPS) return profile[hi].r;
  var t = (z - profile[lo].z) / dz;
  return profile[lo].r + t * (profile[hi].r - profile[lo].r);
}

/* Shortest distance from a point to a profile, treated as a polyline in the
   (r, z) half-plane. This is the PERPENDICULAR distance, which is the wall
   thickness; the radial difference outer(z) - inner(z) is not, and on a
   flared bowl it over-reports by 1/cos(wall angle). Measured, not assumed:
   the self-test carries a 45 degree cone where the two differ by 41%. */
function NSO_wheelDistToProfile(r, z, profile) {
  var best = Infinity;
  for (var i = 0; i + 1 < profile.length; i++) {
    var ar = profile[i].r, az = profile[i].z;
    var br = profile[i + 1].r, bz = profile[i + 1].z;
    var dr = br - ar, dz = bz - az;
    var len2 = dr * dr + dz * dz;
    var t = len2 > 0 ? (((r - ar) * dr + (z - az) * dz) / len2) : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var qr = ar + t * dr, qz = az + t * dz;
    var d = Math.hypot(r - qr, z - qz);
    if (d < best) best = d;
  }
  return best;
}

/* =====================================================================
   3. Volume, and Pappus's centroid theorem

   Both directions of the same theorem, and this is the one place the ball
   size comes from.

   SIZING (section 3a). The vessel the potter is aiming at is approximated as
   a THIN SHELL: a wall of thickness t swept along the meridian, plus a floor
   of the same thickness. Pappus's second theorem gives the volume of a solid
   of revolution as 2*pi*rho*A, where A is the area of the generating region
   in the half-plane and rho is that region's centroid radius. For a wall
   strip of arc length L at mean radius rho, A = L*t, so V = 2*pi*rho*L*t.
   For the floor - a rectangle r in [0, R], z in [0, t] - the centroid radius
   is R/2 and the area is R*t, so V = 2*pi*(R/2)*(R*t) = pi*R^2*t, which is
   the disc it should be. One theorem, both parts.

   MEASURING (section 3b). The live form's volume is NOT estimated. Green's
   theorem turns 2*pi*(integral of r dA) over the meridian region into a
   contour integral, pi * (contour integral of r^2 dz), which is exact for a
   polyline meridian: each segment contributes
       (z2 - z1) * (r1^2 + r1*r2 + r2^2) / 3.
   That is the same identity as 2*pi*rho*A - not an approximation of it - so
   the number the budget is kept in and the number the ball was sized by are
   the same quantity computed the same way. The self-test computes both forms
   independently and asserts they agree to 1e-9 relative.
   ===================================================================== */

/* The closed meridian loop, in traversal order: up the outside, across the
   rim, down the inside. Both ends sit on the axis (r = 0), so the closing
   segment along the axis contributes nothing to any integral below. */
function NSO_wheelMeridian(piece) {
  var loop = NSO_wheelClone(piece.outer);
  if (piece.inner && piece.inner.length) {
    for (var i = piece.inner.length - 1; i >= 0; i--) {
      loop.push({ z: piece.inner[i].z, r: piece.inner[i].r });
    }
  }
  return loop;
}

/* pi * contour integral of r^2 dz around the closed meridian. */
function NSO_wheelVolume(piece) {
  var loop = NSO_wheelMeridian(piece);
  var n = loop.length;
  if (n < 2) return 0;
  var acc = 0;
  for (var i = 0; i < n; i++) {
    var a = loop[i], b = loop[(i + 1) % n];
    acc += (b.z - a.z) * (a.r * a.r + a.r * b.r + b.r * b.r) / 3;
  }
  return Math.PI * acc;
}

/* The same volume by the OTHER face of Pappus: 2*pi*rho*A, with A from the
   shoelace and rho from the first moment. Kept as a callable rather than a
   test-only helper because it is the form the sizing uses, and a caller that
   wants the centroid radius of a thrown form has nowhere else to get it. */
function NSO_wheelPappus(piece) {
  var loop = NSO_wheelMeridian(piece);
  var n = loop.length;
  var area = 0, moment = 0;
  for (var i = 0; i < n; i++) {
    var a = loop[i], b = loop[(i + 1) % n];
    area += 0.5 * (a.r * b.z - b.r * a.z);
    /* integral of r dA = contour integral of (r^2 / 2) dz */
    moment += 0.5 * (b.z - a.z) * (a.r * a.r + a.r * b.r + b.r * b.r) / 3;
  }
  /* moment is the integral of r dA; rho = moment / area. */
  var rho = (Math.abs(area) > NSO_WHEEL_EPS) ? (moment / area) : 0;
  return { area: area, centroidR: rho, volume: 2 * Math.PI * rho * area };
}

/* ------------------------------------------------------- 3a. ball sizing */

/* Defaults, every one of them STATED rather than measured, and every one
   overridable. They are called out individually because a stated default that
   reads like a measured constant is how this repo ended up with a `4` that
   meant two different things.

   WALL_DEFAULT 3.0 mm: a typical thrown stoneware wall, and comfortably clear
     of the 0.42 mm nozzle floor, so the floor is a guard and not the default.
   WASTE_DEFAULT 0.30: real throwing waste - the hump left on the wheel head,
     the trimmings off the foot, water take-up, and the clay the potter's
     hands keep. 30% is the low end of what a production potter allows. It is
     a margin, not a fudge: without it the budget runs out mid-pull on a
     vessel the arithmetic said was exactly sized, which is the worst possible
     moment to find out.
   ASPECT_DEFAULT 0.5: target radius = height/2 when no radius is stated, i.e.
     a vessel as wide as it is tall. */
var NSO_WHEEL_WALL_DEFAULT = 3.0;
var NSO_WHEEL_WASTE_DEFAULT = 0.30;
var NSO_WHEEL_ASPECT_DEFAULT = 0.5;

/* opts: height (required, mm), radius, wall, waste, nozzle. */
function NSO_wheelSizeBall(opts) {
  opts = opts || {};
  var H = opts.height;
  if (!(typeof H === 'number' && isFinite(H) && H > 0)) {
    return { ok: false, reason: 'target height must be a positive number of millimetres' };
  }
  var R = (typeof opts.radius === 'number' && opts.radius > 0)
    ? opts.radius : H * NSO_WHEEL_ASPECT_DEFAULT;
  var t = (typeof opts.wall === 'number' && opts.wall > 0) ? opts.wall : NSO_WHEEL_WALL_DEFAULT;
  var waste = (typeof opts.waste === 'number' && opts.waste >= 0) ? opts.waste : NSO_WHEEL_WASTE_DEFAULT;
  var floor = NSO_wheelFloor(opts.nozzle);

  if (t < floor) {
    return {
      ok: false,
      reason: 'a ' + t.toFixed(3) + ' mm wall is under the ' + floor.toFixed(3) +
        ' mm nozzle floor - nothing thrown at that wall could be printed. ' +
        'Ask for a thicker wall, or a finer nozzle.'
    };
  }
  if (2 * t >= 2 * R) {
    return {
      ok: false,
      reason: 'a ' + t.toFixed(3) + ' mm wall leaves no cavity in a ' + R.toFixed(3) +
        ' mm radius vessel - that is a solid rod, not a pot'
    };
  }

  /* Pappus on the wall strip: L = H (a straight wall of the target height),
     centroid radius = R - t/2 (the strip's mid-thickness), A = L*t. */
  var wallRho = R - t / 2;
  var wallV = 2 * Math.PI * wallRho * (H * t);
  /* Pappus on the floor rectangle: r in [0, R], z in [0, t]. */
  var floorRho = R / 2;
  var floorV = 2 * Math.PI * floorRho * (R * t);

  var shell = wallV + floorV;
  var need = shell * (1 + waste);
  var a = Math.cbrt(3 * need / (4 * Math.PI));

  return {
    ok: true,
    height: H, radius: R, wall: t, waste: waste, nozzle_floor: floor,
    wall_volume: wallV, floor_volume: floorV,
    shell_volume: shell,
    ball_volume: need,
    ball_radius: a,
    reason: 'target ' + H.toFixed(1) + ' x ' + (2 * R).toFixed(1) + ' mm, ' +
      t.toFixed(2) + ' mm wall: shell ' + shell.toFixed(1) + ' mm^3, +' +
      Math.round(waste * 100) + '% waste = ' + need.toFixed(1) + ' mm^3, ' +
      'ball radius ' + a.toFixed(3) + ' mm'
  };
}

/* =====================================================================
   4. The ball

   A smooth centred sphere resting on z = 0, generated AS A PROFILE rather
   than as a mesh, so every later move is a profile edit. Sampled uniformly in
   polar angle, which puts more z-resolution where the curvature is - the
   poles - than uniform-in-z sampling would.
   ===================================================================== */

var NSO_WHEEL_PROFILE_N = 96;   // meridian samples on the starting ball
var NSO_WHEEL_SEGMENTS = 96;    // radial segments in the revolve

function NSO_wheelBall(opts) {
  opts = opts || {};
  var sized = NSO_wheelSizeBall(opts);
  if (!sized.ok) return { ok: false, reason: sized.reason, piece: null };

  var a = sized.ball_radius;
  var n = Math.max(24, Math.round(opts.profileN || NSO_WHEEL_PROFILE_N));
  var outer = new Array(n + 1);
  for (var i = 0; i <= n; i++) {
    /* phi from the south pole (0) to the north pole (pi). */
    var phi = Math.PI * i / n;
    outer[i] = { z: a - a * Math.cos(phi), r: a * Math.sin(phi) };
  }
  /* Pin the poles to the axis exactly - sin(pi) is 1.2e-16, not 0, and an
     r of 1.2e-16 makes a sliver ring instead of a fan. */
  outer[0].r = 0; outer[0].z = 0;
  outer[n].r = 0; outer[n].z = 2 * a;

  var piece = {
    outer: outer,
    inner: null,
    nozzle: (typeof opts.nozzle === 'number' && opts.nozzle > 0) ? opts.nozzle : 0.4,
    wall: sized.wall,
    segments: Math.max(12, Math.round(opts.segments || NSO_WHEEL_SEGMENTS)),
    target: { height: sized.height, radius: sized.radius },
    budget: { start: 0, added: 0, trimmed: 0 },
    ops: ['ball']
  };
  /* The budget's starting figure is the volume of the ball AS BUILT, not the
     figure the sizing asked for. The profile is a 96-gon approximation of a
     semicircle, so it is a fraction under the true sphere, and charging the
     potter for clay that is not on the wheel would let the very first pull
     look affordable when it is not. */
  piece.budget.start = NSO_wheelVolume(piece);
  piece.sizing = sized;
  /* Every move's reason leads with the move's own name, because the reason IS
     the status line the potter reads - see NSO_wheelRun. */
  return { ok: true, reason: 'Ball centred - ' + sized.reason, piece: piece };
}

/* =====================================================================
   5. Revolve

   Profile -> a closed triangle soup, Z up, rebuilt from scratch on every
   update. The band rule is one rule and the degenerate cases fall out of it
   rather than being special-cased by shape.

   For consecutive meridian points i, i+1 and angular steps j, j+1:

       A = P(i, j)      B = P(i, j+1)
       D = P(i+1, j)    C = P(i+1, j+1)

   emit (A, B, C) and (A, C, D), dropping whichever is degenerate when a ring
   sits on the axis. The outward normal that falls out of that ordering is
   (dz, -dr) in the (r, z) half-plane, which is correct for every part of the
   loop at once: the outer wall (dz > 0, dr = 0) faces out, the rim annulus
   (dz = 0, dr < 0) faces up, the base (dz = 0, dr > 0) faces down, and the
   inner wall - traversed downward, so dz < 0 - faces in. Nothing in the
   revolve knows which part of the vessel it is building.
   ===================================================================== */

/* opts.precise returns the soup as a plain Array of float64 instead of a
   Float32Array. The app never wants it - rawTris is float32 everywhere and a
   piece that is not float32 would compare unequal against its own export -
   but anything MEASURING the revolve does: storing these coordinates as
   float32 moves the mesh's signed volume by a few parts in 1e8, which is
   enough to hide whether the tessellation itself is exact. See finding 1 in
   docs/POTTERY-WHEEL.md. */
function NSO_wheelRevolve(piece, opts) {
  opts = opts || {};
  var seg = Math.max(12, Math.round(opts.segments || piece.segments || NSO_WHEEL_SEGMENTS));
  var loop = NSO_wheelMeridian(piece);
  var n = loop.length;

  var cos = new Array(seg), sin = new Array(seg);
  for (var j = 0; j < seg; j++) {
    var th = 2 * Math.PI * j / seg;
    cos[j] = Math.cos(th); sin[j] = Math.sin(th);
  }

  var tris = [];
  function push(p, q, s) {
    tris.push(p[0], p[1], p[2], q[0], q[1], q[2], s[0], s[1], s[2]);
  }
  function pt(k, j) {
    var L = loop[k];
    return [L.r * cos[j], L.r * sin[j], L.z];
  }

  for (var i = 0; i + 1 < n; i++) {
    var r0 = loop[i].r, r1 = loop[i + 1].r;
    if (r0 <= NSO_WHEEL_EPS && r1 <= NSO_WHEEL_EPS) continue;   // both on the axis
    for (var jj = 0; jj < seg; jj++) {
      var k = (jj + 1) % seg;
      var A = pt(i, jj), B = pt(i, k), C = pt(i + 1, k), D = pt(i + 1, jj);
      if (r0 > NSO_WHEEL_EPS) push(A, B, C);
      if (r1 > NSO_WHEEL_EPS) push(A, C, D);
    }
  }
  /* The closing segment from the last loop point back to the first runs along
     the axis (both ends have r = 0 by construction), so it generates nothing
     and the surface is already closed. */
  return opts.precise ? tris : new Float32Array(tris);
}

/* =====================================================================
   6. The two constraints

   Both run on every update, both refuse with a next action rather than a
   verdict, and both are cheap: one scan of the profile each.
   ===================================================================== */

function NSO_wheelBudget(piece) {
  var b = piece.budget;
  var ceiling = b.start + b.added - b.trimmed;
  var live = NSO_wheelVolume(piece);
  return {
    start: b.start, added: b.added, trimmed: b.trimmed,
    ceiling: ceiling, live: live, headroom: ceiling - live
  };
}

/* The wall the piece actually has, everywhere it has one.

   An unopened ball has no wall and no cavity, so there is nothing to be thin
   and `pass` is true with `min_mm` null - a solid is not a failed shell.

   Three separate measurements, because they fail for three different reasons
   and a potter fixes them three different ways:
     wall  - perpendicular distance between the two walls
     floor - cavity floor down to the base
     rim   - the annulus across the top edge                              */
function NSO_wheelWall(piece, opts) {
  opts = opts || {};
  var floor = NSO_wheelFloor(opts.nozzle !== undefined ? opts.nozzle : piece.nozzle);
  var rep = {
    kind: 'thrown-wall',
    nozzle_mm: (opts.nozzle !== undefined ? opts.nozzle : piece.nozzle),
    threshold_mm: floor,
    min_mm: null, at: null,
    wall_mm: null, floor_mm: null, rim_mm: null,
    pass: true, reason: ''
  };
  if (!piece.inner || !piece.inner.length) {
    rep.reason = 'solid - no cavity yet, nothing to be thin';
    return rep;
  }

  var outer = piece.outer, inner = piece.inner;
  var best = Infinity, bestAt = null;

  /* Every inner sample against the whole outer polyline, and the reverse.
     Both directions, because the nearest point on a polyline is not a
     symmetric relation once the two walls have different sample spacing. */
  var i;
  for (i = 0; i < inner.length; i++) {
    var d = NSO_wheelDistToProfile(inner[i].r, inner[i].z, outer);
    if (d < best) { best = d; bestAt = { z: inner[i].z, r: inner[i].r, side: 'inner' }; }
  }
  for (i = 0; i < outer.length; i++) {
    var d2 = NSO_wheelDistToProfile(outer[i].r, outer[i].z, inner);
    if (d2 < best) { best = d2; bestAt = { z: outer[i].z, r: outer[i].r, side: 'outer' }; }
  }
  rep.wall_mm = best;

  /* The floor: cavity centre down to the base. Both sit on the axis. */
  rep.floor_mm = inner[0].z - outer[0].z;

  /* The rim: the annulus between the two profiles' top samples. It is a loop
     EDGE, not a point-to-polyline distance, so the scan above cannot see it -
     the nearest point on the other wall from the outer rim sample IS the
     inner rim sample, at exactly the rim width, so in practice the scan does
     catch it; measured separately anyway so the refusal can name it. */
  var oTop = outer[outer.length - 1], iTop = inner[inner.length - 1];
  rep.rim_mm = Math.hypot(oTop.r - iTop.r, oTop.z - iTop.z);

  var cands = [
    { mm: rep.wall_mm, what: 'wall', at: bestAt },
    { mm: rep.floor_mm, what: 'floor', at: { z: outer[0].z, r: 0, side: 'base' } },
    { mm: rep.rim_mm, what: 'rim', at: { z: oTop.z, r: oTop.r, side: 'rim' } }
  ];
  var worst = cands[0];
  for (i = 1; i < cands.length; i++) if (cands[i].mm < worst.mm) worst = cands[i];
  rep.min_mm = worst.mm;
  rep.at = worst.at;
  rep.thinnest = worst.what;
  rep.pass = worst.mm >= floor - 1e-4;
  rep.reason = rep.pass
    ? ('thinnest ' + worst.what + ' ' + worst.mm.toFixed(3) + ' mm, floor ' + floor.toFixed(3) + ' mm')
    : (worst.what + ' is ' + worst.mm.toFixed(3) + ' mm at z = ' + worst.at.z.toFixed(2) +
       ' mm - under the ' + floor.toFixed(3) + ' mm floor for a ' +
       rep.nozzle_mm + ' mm nozzle');
  return rep;
}

/* The one gate every move goes through. Takes a CANDIDATE piece and either
   blesses it or hands back the original with a reason that names the move.

   Both refusals are written as a next action on purpose. "Out of material"
   with nothing after it is a dead end; a potter whose ball has run out
   wedges on more clay or pulls the rim up, and both of those are moves this
   file supports, so the message says so. */
function NSO_wheelGate(original, candidate, what) {
  if (!candidate.outer || candidate.outer.length < 2) {
    return { ok: false, piece: original, reason: what + ' would leave no form at all' };
  }
  var bud = NSO_wheelBudget(candidate);
  if (!(bud.live > 0)) {
    return {
      ok: false, piece: original,
      reason: what + ' would collapse the piece to nothing (' + bud.live.toFixed(3) +
        ' mm^3) - pull less, or start again from a ball'
    };
  }
  if (bud.headroom < -1e-6) {
    return {
      ok: false,
      piece: original,
      reason: what + ' needs ' + (-bud.headroom).toFixed(1) + ' mm^3 more clay than is on the ' +
        'wheel (' + bud.live.toFixed(1) + ' of ' + bud.ceiling.toFixed(1) + ' mm^3) - ' +
        'out of material: extend the rim or add clay here to continue',
      budget: bud
    };
  }
  var wall;
  try {
    wall = NSO_wheelWall(candidate);
  } catch (err) {
    return { ok: false, piece: original, reason: what + ' could not check the wall: ' + err.message };
  }
  if (!wall.pass) {
    return {
      ok: false,
      piece: original,
      reason: what + ' would take the ' + wall.thinnest + ' to ' + wall.min_mm.toFixed(3) +
        ' mm at z = ' + wall.at.z.toFixed(2) + ' mm, under the ' + wall.threshold_mm.toFixed(3) +
        ' mm nozzle floor - pull less here, or add clay at this height first',
      wall: wall, budget: bud
    };
  }
  return { ok: true, piece: candidate, reason: '', budget: bud, wall: wall };
}

/* =====================================================================
   7. The moves
   ===================================================================== */

/* ------------------------------------------------------------ 7a. OPEN

   One push down the middle. Before it the piece has ONE profile and is a
   solid; after it the piece has TWO and is a shell. That is the whole of
   what Open does, and it is why it is its own move rather than the first
   pull: everything downstream - the wall gate, the meridian loop, the
   revolve's inner surface - branches on whether `inner` exists.

   THE CAVITY IS DEFINED BY THE WALL, NOT BY A RADIAL SUBTRACTION, and that
   distinction is the whole of this function. The obvious implementation -
   inner(z) = outer(z) - wall - is wrong, and wrong by a lot: a radial
   subtraction leaves a PERPENDICULAR wall of `wall * cos(slope)`, so on a
   ball the wall thins toward the base exactly where a thrown pot is already
   weakest. Measured on the default 3 mm open of a 30 mm ball: 1.31 mm of real
   wall where 3.00 was asked for, a 56% shortfall, and the shortfall goes to
   zero wall at the base itself.

   So the inner surface is defined as the locus of points at perpendicular
   distance `wall` inside the outer surface:

       inner(z) = the largest r <= outer(z) with dist((r, z), outer) >= wall

   found by bisection, which needs no offset curve, cannot fold, and handles
   the corner at the base for free - the same predicate that keeps the wall
   off the side also keeps the cavity floor exactly `wall` above the base.
   Where even the axis is closer than `wall` to the outer surface there is no
   cavity at that height and the piece stays solid there, which is what the
   -1 return means.

   opts: radius  the opening's own radius (default: as wide as the wall allows)
         base    clay left under the cavity (default: the natural `wall`)
         depth   alternative to base - cavity depth measured down from the rim
         wall    overrides the piece's                                       */
function NSO_wheelInnerAt(outer, z, wall, iters) {
  var rOut = NSO_wheelRadiusAt(outer, z);
  if (rOut <= NSO_WHEEL_EPS) return -1;
  if (NSO_wheelDistToProfile(0, z, outer) < wall) return -1;   // solid at this height
  var lo = 0, hi = rOut;
  var n = iters || 28;
  for (var i = 0; i < n; i++) {
    var mid = 0.5 * (lo + hi);
    if (NSO_wheelDistToProfile(mid, z, outer) >= wall) lo = mid; else hi = mid;
  }
  return lo;
}

/* The cavity that a given outer profile will hold at a given wall thickness,
   between a floor and a rim. Shared by Open (which derives the floor and rim
   from the ball) and by a reshaping Pull (which keeps the ones it already
   has), so there is one definition of "what is the inside of this pot".

   o: wall, floorZ, rimZ, radius (optional clamp), n (samples). */
function NSO_wheelInnerFor(outer, o) {
  var wall = o.wall, floorZ = o.floorZ, rimZ = o.rimZ;
  var radius = (typeof o.radius === 'number' && o.radius > 0) ? o.radius : Infinity;
  var n = Math.max(24, Math.round(o.n || NSO_WHEEL_PROFILE_N));
  if (!(rimZ > floorZ + NSO_WHEEL_EPS)) {
    return { ok: false, reason: 'the cavity floor is at or above the rim' };
  }
  var inner = [{ z: floorZ, r: 0 }];
  for (var i = 0; i <= n; i++) {
    var z = floorZ + (rimZ - floorZ) * (i / n);
    if (i === 0) continue;                       // the axis point above is the floor
    var ri = NSO_wheelInnerAt(outer, z, wall, o.iters);
    if (ri < 0) ri = 0;
    inner.push({ z: z, r: Math.min(radius, ri) });
  }
  if (inner.length < 3) return { ok: false, reason: 'the cavity came out too shallow to hold a wall' };
  return { ok: true, inner: inner };
}

function NSO_wheelOpen(piece, opts) {
  opts = opts || {};
  if (piece.inner) {
    return { ok: false, piece: piece, reason: 'this piece is already open - Open is the first cavity, once' };
  }
  var span = NSO_wheelSpan(piece.outer);
  var top = span.hi, bottom = span.lo;
  var wall = (typeof opts.wall === 'number' && opts.wall > 0) ? opts.wall : piece.wall;
  var nozzleFloor = NSO_wheelFloor(piece.nozzle);
  if (wall < nozzleFloor) {
    return { ok: false, piece: piece, reason: 'a ' + wall.toFixed(3) + ' mm wall is under the ' +
      nozzleFloor.toFixed(3) + ' mm nozzle floor - nothing opened that thin could be printed' };
  }

  var n = Math.max(48, Math.round(opts.profileN || piece.outer.length));
  var zs = new Array(n + 1), rs = new Array(n + 1);
  var i, offMax = -1, zWide = null;
  for (i = 0; i <= n; i++) {
    var z = bottom + (top - bottom) * (i / n);
    zs[i] = z;
    rs[i] = NSO_wheelInnerAt(piece.outer, z, wall);
    if (rs[i] > offMax) { offMax = rs[i]; zWide = z; }
  }
  if (offMax <= NSO_WHEEL_EPS) {
    return {
      ok: false, piece: piece,
      reason: 'a ' + wall.toFixed(2) + ' mm wall leaves no cavity anywhere in this ball - ' +
        'throw a bigger ball, or ask for a thinner wall'
    };
  }

  var radius = (typeof opts.radius === 'number' && opts.radius > 0) ? opts.radius : offMax;
  if (radius > offMax + 1e-9) {
    return {
      ok: false, piece: piece,
      reason: 'a ' + radius.toFixed(2) + ' mm opening would break through a ' + wall.toFixed(2) +
        ' mm wall - the widest this ball will take is ' + offMax.toFixed(2) + ' mm. ' +
        'Open narrower, or pull the wall out first.'
    };
  }

  /* The rim: the highest height at which the cavity is still at least as wide
     as the opening. Above it the wall closes in, so that is where the potter's
     fingers come out and where the piece is cut off. */
  var rimZ = zWide;
  for (i = 0; i <= n; i++) if (zs[i] >= zWide && rs[i] >= radius - 1e-9) rimZ = zs[i];

  /* The floor: the lowest height at which a cavity exists at all - which the
     bisection already put exactly `wall` above the base - raised if the potter
     asked for a thicker base or a shallower opening. */
  var natural = null;
  for (i = 0; i <= n; i++) if (rs[i] >= 0 && natural === null) natural = zs[i];
  var floorZ = natural;
  if (typeof opts.base === 'number' && isFinite(opts.base)) floorZ = Math.max(floorZ, bottom + opts.base);
  if (typeof opts.depth === 'number' && isFinite(opts.depth)) floorZ = Math.max(floorZ, rimZ - opts.depth);

  if (rimZ - floorZ <= NSO_WHEEL_EPS) {
    return {
      ok: false, piece: piece,
      reason: 'that leaves no depth to open - the cavity floor at ' + floorZ.toFixed(2) +
        ' mm is at or above the rim at ' + rimZ.toFixed(2) + ' mm. Open deeper, or leave less base.'
    };
  }

  var built = NSO_wheelInnerFor(piece.outer, {
    wall: wall, floorZ: floorZ, rimZ: rimZ, radius: radius, n: n
  });
  if (!built.ok) return { ok: false, piece: piece, reason: built.reason + ' - open deeper' };
  var inner = built.inner;

  /* The outer profile is cut off at the rim: everything above it was the top
     of the ball, and opening pushed it aside. It is still ON the wheel - the
     budget ceiling does not move - so a later pull can bring it back out. */
  var outerCut = [];
  for (i = 0; i < piece.outer.length; i++) {
    if (piece.outer[i].z < rimZ - NSO_WHEEL_EPS) outerCut.push({ z: piece.outer[i].z, r: piece.outer[i].r });
  }
  outerCut.push({ z: rimZ, r: NSO_wheelRadiusAt(piece.outer, rimZ) });

  var cand = {
    outer: outerCut,
    inner: inner,
    nozzle: piece.nozzle, wall: wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['open'])
  };
  var depth = rimZ - floorZ;
  var g = NSO_wheelGate(piece, cand, 'Opening ' + depth.toFixed(1) + ' mm deep');
  if (!g.ok) return g;
  g.depth = depth;
  g.radius = radius;
  g.reason = 'Opened ' + depth.toFixed(1) + ' mm deep, ' + radius.toFixed(2) +
    ' mm cavity radius, ' + (floorZ - bottom).toFixed(2) + ' mm base, rim at z = ' + rimZ.toFixed(2) + ' mm';
  return g;
}

/* ------------------------------------------------------------ 7b. PULL

   Drag-shape the profile at ANY height. The drag is a list of points the
   pointer visited in the (z, r) half-plane; they are sparse, unevenly spaced
   and noisy, and connecting them straight would leave the vessel faceted -
   which is the whole reason this is a spline fit and not a polyline.

   The interpolant is a MONOTONE cubic Hermite (Fritsch-Carlson), not a
   Catmull-Rom, and the choice is load-bearing rather than taste. Catmull-Rom
   overshoots between unevenly spaced points, and an overshoot in r is a bulge
   the potter did not make - near the axis it can be a NEGATIVE radius, which
   is a profile that crosses itself and revolves into an inside-out shell.
   Fritsch-Carlson cannot overshoot by construction: it clamps each node's
   slope into the interval the neighbouring secants allow. The price is C1
   instead of C2 and a flat spot at a local extremum, neither of which is
   visible at 96 meridian samples.

   Outside the dragged range the displacement tapers to zero over `taper` mm
   with a compact biweight kernel (1 - u^2)^2, so a pull at the belly leaves
   the base and the rim EXACTLY where they were. Compact support is the point:
   a Gaussian never reaches zero, and a base that drifts by a micron on every
   pull is a base that no longer sits flat on the plate.

   opts: points [{z, r}]  the drag path, OR
         z, dr            a single pull of dr millimetres at height z
         taper            falloff distance, default 2x the drag's own span
         carryInner       false to hold the inner wall still (default true:
                          the wall thickness rides along, which is what a
                          potter's fingers do - inside and outside move as a
                          pair)
         reshapeWall      rebuild the inside as a true perpendicular offset of
                          the new outside, instead of carrying it radially

   TWO WAYS TO CARRY THE INSIDE, and the difference is not cosmetic.

   The default, `carryInner`, adds the same radial displacement to both walls.
   It is one pass over the samples, it is what a live 60 Hz drag can afford,
   and it holds the RADIAL gap exactly - which is the right answer wherever
   the wall is near-vertical and an approximation everywhere else, because the
   perpendicular wall is the radial gap times the cosine of the wall's slope.

   `reshapeWall` throws the inside away and rebuilds it from the new outside
   by the same bisection Open uses, so the perpendicular wall comes out exact
   everywhere. It costs a bisection per sample - some milliseconds, not some
   microseconds - so it is opt-in rather than the default, and it is what a
   pull that means to leave a STRAIGHT wall must use: a vertical outside
   carried radially leaves a non-vertical inside, and rim extension then has
   no clean band to insert height into. Measured: pulling a vessel's upper
   wall vertical with the default leaves Extend refusing at 384 of 384
   straddling triangles oblique; with reshapeWall it inserts cleanly.

   Either way the gate measures the PERPENDICULAR wall and refuses on that,
   so the cheap path cannot quietly ship a thin pot - it can only refuse a
   pull the expensive path would have allowed.                              */
function NSO_wheelPchip(points) {
  /* points sorted, strictly ascending in z. Returns f(z). */
  var n = points.length;
  var xs = new Array(n), ys = new Array(n);
  for (var i = 0; i < n; i++) { xs[i] = points[i].z; ys[i] = points[i].r; }
  if (n === 1) return function () { return ys[0]; };

  var h = new Array(n - 1), d = new Array(n - 1);
  for (i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  var m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
    /* Weighted harmonic mean - Fritsch-Carlson's own form, which keeps the
       slope inside 3x the smaller secant and so cannot overshoot. */
    var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return function (z) {
    if (z <= xs[0]) return ys[0];
    if (z >= xs[n - 1]) return ys[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (xs[mid] <= z) lo = mid; else hi = mid; }
    var t = (z - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] +
           (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1];
  };
}

function NSO_wheelPull(piece, opts) {
  opts = opts || {};
  var pts = opts.points;
  if (!pts || !pts.length) {
    if (!(typeof opts.z === 'number' && typeof opts.dr === 'number')) {
      return { ok: false, piece: piece, reason: 'Pull needs a drag path (points) or a single z and dr' };
    }
    pts = [{ z: opts.z, r: NSO_wheelRadiusAt(piece.outer, opts.z) + opts.dr }];
  }

  /* Sort by z and merge samples that land on the same height - a pointer
     dragged straight up reports several samples per millimetre and two with
     the same z would put an infinity in the interpolant's slopes. */
  var sorted = pts.slice().sort(function (a, b) { return a.z - b.z; });
  var path = [];
  for (var i = 0; i < sorted.length; i++) {
    var p = sorted[i];
    if (!isFinite(p.z) || !isFinite(p.r)) continue;
    if (path.length && Math.abs(p.z - path[path.length - 1].z) < 1e-4) {
      path[path.length - 1] = { z: p.z, r: p.r };   // last sample at that height wins
    } else {
      path.push({ z: p.z, r: p.r });
    }
  }
  if (!path.length) return { ok: false, piece: piece, reason: 'Pull got no usable drag points' };

  var span = NSO_wheelSpan(piece.outer);
  var pLo = path[0].z, pHi = path[path.length - 1].z;
  var dragSpan = pHi - pLo;
  var taper = (typeof opts.taper === 'number' && opts.taper > 0)
    ? opts.taper
    : Math.max((span.hi - span.lo) * 0.10, dragSpan * 2, 1);

  var fit = NSO_wheelPchip(path);

  /* Displacement at a height: inside the drag, the spline minus what is
     there; outside, that edge value faded out over `taper`. */
  var dLo = fit(pLo) - NSO_wheelRadiusAt(piece.outer, pLo);
  var dHi = fit(pHi) - NSO_wheelRadiusAt(piece.outer, pHi);
  function disp(z) {
    if (z >= pLo && z <= pHi) return fit(z) - NSO_wheelRadiusAt(piece.outer, z);
    var u, edge;
    if (z < pLo) { u = (pLo - z) / taper; edge = dLo; } else { u = (z - pHi) / taper; edge = dHi; }
    if (u >= 1) return 0;
    var k = 1 - u * u;
    return edge * k * k;
  }

  var outer = NSO_wheelClone(piece.outer);
  for (i = 0; i < outer.length; i++) {
    /* The two ends of the profile sit ON the axis and must stay there: a pole
       or a base centre with r > 0 is a hole in the solid. */
    if (outer[i].r <= NSO_WHEEL_EPS) continue;
    outer[i].r = Math.max(0, outer[i].r + disp(outer[i].z));
  }

  var inner = null;
  if (piece.inner) {
    if (opts.reshapeWall) {
      var wall = (typeof opts.wall === 'number' && opts.wall > 0) ? opts.wall : piece.wall;
      var built = NSO_wheelInnerFor(outer, {
        wall: wall,
        floorZ: piece.inner[0].z,
        rimZ: outer[outer.length - 1].z,
        n: opts.profileN || piece.inner.length
      });
      if (!built.ok) {
        return { ok: false, piece: piece, reason: 'Pull could not rebuild the inside - ' + built.reason };
      }
      inner = built.inner;
    } else {
      inner = NSO_wheelClone(piece.inner);
      if (opts.carryInner !== false) {
        for (i = 0; i < inner.length; i++) {
          if (inner[i].r <= NSO_WHEEL_EPS) continue;
          inner[i].r = Math.max(0, inner[i].r + disp(inner[i].z));
        }
      }
    }
  }

  var cand = {
    outer: NSO_wheelTidy(outer), inner: NSO_wheelTidy(inner),
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['pull'])
  };

  var g = NSO_wheelGate(piece, cand, 'Pulling at z = ' + pLo.toFixed(1) +
    (dragSpan > 1e-6 ? ('-' + pHi.toFixed(1)) : '') + ' mm');
  if (!g.ok) return g;
  g.reason = 'Pulled z ' + pLo.toFixed(1) + '-' + pHi.toFixed(1) + ' mm through ' +
    path.length + ' drag point(s), ' + (g.budget.headroom).toFixed(1) + ' mm^3 of clay left';
  g.path = path;
  return g;
}

/* ------------------------------------------------------------ 7c. TRIM

   Clean the excess off the base once the form is set. Two independent edits,
   either or both:

     z     level the base at this height - everything below it comes off
     toR   cut the outer wall back to this radius, from the base up to `upTo`

   Trimmed clay is GONE, not banked: the budget ceiling drops by exactly the
   volume removed, at the same moment the live volume drops by the same
   amount, so the headroom a potter has is unchanged by trimming. That is the
   real behaviour - trimmings go in the slops bucket, they do not go back on
   the wheel - and it is asserted as an invariant in the self-test. */
function NSO_wheelTrim(piece, opts) {
  opts = opts || {};
  var span = NSO_wheelSpan(piece.outer);
  var haveZ = (typeof opts.z === 'number' && isFinite(opts.z));
  var haveR = (typeof opts.toR === 'number' && isFinite(opts.toR) && opts.toR > 0);
  if (!haveZ && !haveR) {
    return { ok: false, piece: piece, reason: 'Trim needs a base height (z) or an outer radius (toR)' };
  }

  var before = NSO_wheelVolume(piece);
  var outer = NSO_wheelClone(piece.outer);
  var nozzleFloor = NSO_wheelFloor(piece.nozzle);

  if (haveZ) {
    var z0 = opts.z;
    if (z0 <= span.lo + NSO_WHEEL_EPS) {
      return { ok: false, piece: piece, reason: 'Trim at z = ' + z0.toFixed(2) +
        ' mm is at or below the base already (' + span.lo.toFixed(2) + ' mm) - nothing to take off' };
    }
    if (z0 >= span.hi - NSO_WHEEL_EPS) {
      return { ok: false, piece: piece, reason: 'Trim at z = ' + z0.toFixed(2) +
        ' mm would take the whole piece off the wheel' };
    }
    if (piece.inner && z0 >= piece.inner[0].z - nozzleFloor) {
      return { ok: false, piece: piece, reason: 'Trim at z = ' + z0.toFixed(2) +
        ' mm would leave ' + (piece.inner[0].z - z0).toFixed(3) + ' mm of base under the cavity, ' +
        'under the ' + nozzleFloor.toFixed(3) + ' mm nozzle floor - trim shallower' };
    }
    var rAt = NSO_wheelRadiusAt(outer, z0);
    var kept = [];
    for (var i = 0; i < outer.length; i++) if (outer[i].z > z0 + NSO_WHEEL_EPS) kept.push(outer[i]);
    /* A flat base: the axis point, then straight out to the wall at z0. */
    outer = [{ z: z0, r: 0 }, { z: z0, r: rAt }].concat(kept);
  }

  if (haveR) {
    var base = outer[0].z;
    var upTo = (typeof opts.upTo === 'number' && isFinite(opts.upTo)) ? opts.upTo : (base + (span.hi - base) * 0.25);
    for (var k = 0; k < outer.length; k++) {
      if (outer[k].z > upTo + NSO_WHEEL_EPS) continue;
      if (outer[k].r <= NSO_WHEEL_EPS) continue;
      if (outer[k].r > opts.toR) outer[k].r = opts.toR;
    }
  }

  var cand = {
    outer: NSO_wheelTidy(outer), inner: piece.inner ? NSO_wheelClone(piece.inner) : null,
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['trim'])
  };

  var after = NSO_wheelVolume(cand);
  var removed = before - after;
  if (removed < -1e-6) {
    return { ok: false, piece: piece, reason: 'Trim would ADD ' + (-removed).toFixed(2) +
      ' mm^3 - that is not a trim; use Pull to move the wall out' };
  }
  cand.budget.trimmed += removed;

  var g = NSO_wheelGate(piece, cand, 'Trimming');
  if (!g.ok) return g;
  g.removed = removed;
  g.reason = 'Trimmed ' + removed.toFixed(1) + ' mm^3 off the base' +
    (haveZ ? (' (levelled at z = ' + opts.z.toFixed(2) + ' mm)') : '') +
    (haveR ? (' (foot cut back to ' + opts.toR.toFixed(2) + ' mm)') : '');
  return g;
}

/* -------------------------------------------------- 7d. RIM EXTENSION

   Adding height at the current top edge is an axis-preserving stretch of a
   straight wall. That is exactly what Extend (app-extend.js) does, and it
   does it bit-for-bit with a gate that proves the cross-section did not move,
   so this move CALLS Extend rather than reimplementing it. NSO_extendRaw is
   the authority for the geometry and for the refusal; the only thing done
   here is keeping the profile in step with what it returned.

   The profile side of it is exact, and the reason it is exact is Extend's own
   clean-band condition: Extend only cuts where every straddling triangle is
   perpendicular to the axis, which on a solid of revolution means the outer
   AND inner radius are constant across the cut. Inserting `delta` of a
   constant-radius band into a profile is therefore literally "shift every
   sample above the cut and add two samples at the seam". No spline, no
   resampling, no approximation.

   NSO_wheelStraightBand finds that band in profile terms FIRST, so the
   refusal a potter sees names the rim rather than a triangle census; Extend
   then finds it again, independently, in the mesh. Two agreements, and if
   they disagree the volumes will not reconcile and this move refuses. */
function NSO_wheelStraightBand(piece, opts) {
  opts = opts || {};
  var tol = (typeof opts.tol === 'number' && opts.tol > 0) ? opts.tol : 1e-3;
  var profiles = [piece.outer];
  if (piece.inner) profiles.push(piece.inner);

  /* Collect every z at which either profile has a sample, then walk upward
     keeping the run over which every profile's radius holds still. */
  var zs = [];
  for (var p = 0; p < profiles.length; p++)
    for (var i = 0; i < profiles[p].length; i++) zs.push(profiles[p][i].z);
  zs.sort(function (a, b) { return a - b; });

  var bestLo = null, bestHi = null, best = 0;
  var runLo = null, ref = null;
  for (i = 0; i < zs.length; i++) {
    var z = zs[i];
    var here = [];
    for (p = 0; p < profiles.length; p++) here.push(NSO_wheelRadiusAt(profiles[p], z));
    /* A band only counts where BOTH walls exist - below the cavity floor the
       inner profile clamps to its end value, which is not a real wall. */
    var inCavity = !piece.inner || (z >= piece.inner[0].z - NSO_WHEEL_EPS);
    var same = inCavity && ref !== null;
    if (same) {
      for (p = 0; p < here.length; p++) if (Math.abs(here[p] - ref[p]) > tol) { same = false; break; }
    }
    if (same) {
      if (z - runLo > best) { best = z - runLo; bestLo = runLo; bestHi = z; }
    } else {
      runLo = z; ref = here;
    }
  }
  /* A band shorter than this is two samples that happened to land on the same
     radius, not a straight wall, and reporting it would hand the potter a
     "there is a band" that Extend then refuses on the mesh. */
  var minBand = (typeof opts.minBand === 'number' && opts.minBand > 0) ? opts.minBand : 1.0;
  if (bestLo === null || best < minBand) {
    return {
      ok: false,
      found_mm: best,
      reason: 'no straight-walled band at least ' + minBand.toFixed(2) + ' mm tall to insert ' +
        'height into' + (best > 0 ? (' - the best run is ' + best.toFixed(3) + ' mm') : '') +
        '. The rim is curved or tapered. Pull the top of the wall straight first ' +
        '(with reshapeWall, so the INSIDE comes out straight too), then extend it.'
    };
  }
  return { ok: true, lo: bestLo, hi: bestHi, length: best, mid: (bestLo + bestHi) / 2 };
}

/* opts: delta (mm of height to add, required). */
function NSO_wheelExtendRim(piece, opts) {
  opts = opts || {};
  var delta = opts.delta;
  if (!(typeof delta === 'number' && isFinite(delta) && delta > 0)) {
    return { ok: false, piece: piece, reason: 'Rim extension needs a positive number of millimetres' };
  }
  if (typeof NSO_extendRaw !== 'function') {
    return { ok: false, piece: piece, reason: 'app-extend.js is not loaded - rim extension is Extend, ' +
      'and this file does not carry its own copy of an axis-preserving stretch' };
  }

  var band = NSO_wheelStraightBand(piece, opts);
  if (!band.ok) return { ok: false, piece: piece, reason: 'Rim extension refused - ' + band.reason };

  var soupBefore = NSO_wheelRevolve(piece);
  var ex = NSO_extendRaw(soupBefore, { axis: 'z', delta: delta, gate: opts.gate });
  if (!ex.ok) {
    return { ok: false, piece: piece, reason: 'Rim extension refused by Extend - ' + ex.reason, extend: ex };
  }

  /* Extend reports the length it actually landed, which is quantised to the
     float32 grid at the piece's own coordinate magnitude - see docs/EXTEND.md
     finding 3. Follow the measured delta, never the asked-for one, or the
     profile and the mesh part company by a ULP per extension. */
  var real = ex.lengthAfter - ex.lengthBefore;
  var cut = ex.cut;

  /* The cut has to land strictly inside every profile it is going to split.
     If it sits below the cavity floor, `shift` translates the WHOLE inner
     profile and quietly lifts the floor out of the base. NSO_wheelStraightBand
     already only reports bands inside the cavity and Extend only cuts a clean
     band, so this should be unreachable - which is exactly why it refuses
     rather than trusting that. */
  if (piece.inner &&
      (cut <= piece.inner[0].z + NSO_WHEEL_EPS ||
       cut >= piece.inner[piece.inner.length - 1].z - NSO_WHEEL_EPS)) {
    return {
      ok: false, piece: piece,
      reason: 'Rim extension refused - Extend cut at z = ' + cut.toFixed(3) +
        ' mm, outside the cavity (' + piece.inner[0].z.toFixed(3) + ' .. ' +
        piece.inner[piece.inner.length - 1].z.toFixed(3) + ' mm); inserting there ' +
        'would move the base rather than the rim',
      extend: ex
    };
  }

  function shift(profile) {
    if (!profile) return null;
    var out = [];
    var rAtCut = NSO_wheelRadiusAt(profile, cut);
    var spanLo = profile[0].z, spanHi = profile[profile.length - 1].z;
    var seam = (cut > spanLo + NSO_WHEEL_EPS) && (cut < spanHi - NSO_WHEEL_EPS);
    for (var i = 0; i < profile.length; i++) {
      var s = profile[i];
      if (s.z <= cut + NSO_WHEEL_EPS) out.push({ z: s.z, r: s.r });
    }
    if (seam) { out.push({ z: cut, r: rAtCut }); out.push({ z: cut + real, r: rAtCut }); }
    for (i = 0; i < profile.length; i++) {
      var t = profile[i];
      if (t.z > cut + NSO_WHEEL_EPS) out.push({ z: t.z + real, r: t.r });
    }
    return out;
  }

  var cand = {
    outer: shift(piece.outer), inner: shift(piece.inner),
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['extendRim'])
  };

  /* Clay added at the rim is clay the potter wedged on: it raises the
     ceiling by exactly what the form gained, so the extension is affordable
     by construction and the gate below is checking the WALL, not the budget. */
  var added = NSO_wheelVolume(cand) - NSO_wheelVolume(piece);
  if (!(added > 0)) {
    return { ok: false, piece: piece, reason: 'Rim extension did not add any material - ' +
      'the profile and Extend disagree about where the cut landed (' + cut.toFixed(4) + ' mm)' };
  }
  cand.budget.added += added;

  var g = NSO_wheelGate(piece, cand, 'Extending the rim by ' + real.toFixed(2) + ' mm');
  if (!g.ok) return g;
  g.extend = ex;
  g.added = added;
  g.reason = 'Rim extended ' + real.toFixed(2) + ' mm by Extend (cut at z = ' + cut.toFixed(2) +
    ' mm, cross-section held), +' + added.toFixed(1) + ' mm^3 of clay added';
  return g;
}

/* =====================================================================
   8. App wiring

   commit() half of the house lifecycle, reusing NSO_sculptCommitRaw from
   app-sculpt.js verbatim rather than copying it - the same route Extend
   takes. The undo type is its own string so the status line names the wheel.
   ===================================================================== */

// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md, the
// question is whether this feature acts on an identifiable sub-region. It does
// not - and it is the strongest whole-piece case in the roster. Every move
// here revolves the meridian profile into a brand new triangle soup: not one
// triangle survives an update, so there is no face the wheel could promise to
// leave exactly where it was, which is precisely the promise the paint rule
// demands. So any paint anywhere on the piece stands the whole bake down,
// naming the count. nsoMaskCount(m) is the whole test.
function NSO_wheelPaintOk(m, what) {
  var paintedCount = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (paintedCount > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Pottery Wheel stood down - ' + paintedCount + ' painted face(s); ' +
                what + ' revolves a new surface and keeps none of them. Clear paint to throw.', true);
    }
    return { ok: false, reason: 'painted faces: ' + paintedCount, painted: paintedCount };
  }
  return { ok: true };
}

function NSO_wheelCommit(m, working, statusText) {
  if (typeof NSO_sculptCommitRaw === 'function') return NSO_sculptCommitRaw(m, working, 'wheelReplace', statusText);
  return false;
}

/* The live session. One thrown piece at a time, held here rather than on the
   model, because the profile is the wheel's state and the model only ever
   sees the revolved result. */
var NSO_wheelSession = null;

function NSO_wheelStatus(piece, head) {
  var bud = NSO_wheelBudget(piece);
  var span = NSO_wheelSpan(piece.outer);
  var line = head + ' - ' + (span.hi - span.lo).toFixed(1) + ' mm tall, ' +
    bud.live.toFixed(0) + ' / ' + bud.ceiling.toFixed(0) + ' mm^3 clay used';
  if (typeof NSO_Printer !== 'undefined' && typeof NSO_wheelFitReport === 'function') {
    var f = NSO_wheelFitReport(piece);
    if (f && !f.fits) line += ' - ' + NSO_Printer.describe(f);
  }
  return line;
}

/* The build-volume check, on the thrown piece's own bounding box. The wheel
   holds a profile, so the box is exact arithmetic and needs no mesh: the
   widest radius on either profile is the footprint, the profile span is the
   height. Strictly a "does it fit the machine" question - see nso_printer.js. */
function NSO_wheelFitReport(piece, printer) {
  if (typeof NSO_Printer === 'undefined' || !NSO_Printer) return null;
  var rMax = 0;
  for (var i = 0; i < piece.outer.length; i++) if (piece.outer[i].r > rMax) rMax = piece.outer[i].r;
  var span = NSO_wheelSpan(piece.outer);
  var size = { x: 2 * rMax, y: 2 * rMax, z: span.hi - span.lo };
  var p = printer;
  if (!p) {
    /* One resolution path for the whole app: app-fit.js owns it, because the
       custom plate's numbers live in the DOM and nothing should read them
       twice. Falling back only where app-fit.js is not loaded (the headless
       suites, which pass a profile in explicitly anyway). */
    if (typeof NSO_fitCurrentPrinter === 'function') p = NSO_fitCurrentPrinter();
    if (!p) {
      var id = (typeof state !== 'undefined' && state && state.plate) ? state.plate : 'a1mini';
      var over = (typeof getCurrentPlate === 'function') ? getCurrentPlate() : null;
      p = NSO_Printer.resolve(id, over ? { w: over.w, d: over.d, h: over.h } : null);
    }
  }
  return NSO_Printer.fit(size, p);
}

/* Bake whatever is on the wheel onto the selected model. */
function NSO_wheelBake(head) {
  if (!NSO_wheelSession) {
    if (typeof setStatus === 'function') setStatus('Nothing on the wheel - throw a ball first', true);
    return { ok: false, reason: 'no session' };
  }
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var soup = NSO_wheelRevolve(NSO_wheelSession);
  NSO_wheelCommit(m, soup, NSO_wheelStatus(NSO_wheelSession, head));
  return { ok: true, tris: soup };
}

/* One entry point per move, each of them: paint first, then run the headless
   move, then report its refusal verbatim or adopt the new piece and bake.

   The paint check comes BEFORE the move, not before the bake. Standing down
   after the profile has already advanced would leave the wheel holding a form
   the piece on the plate does not have - the session and the model would be
   one move apart, and the next bake would apply both at once. */
function NSO_wheelRun(move, opts, head) {
  try {
    if (move !== 'ball' && !NSO_wheelSession) {
      if (typeof setStatus === 'function') setStatus('Nothing on the wheel - throw a ball first', true);
      return { ok: false, reason: 'no session' };
    }
    var target = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (target) {
      var paint = NSO_wheelPaintOk(target, 'the wheel');
      if (!paint.ok) return paint;
    }
    var r;
    if (move === 'ball') r = NSO_wheelBall(opts);
    else if (move === 'open') r = NSO_wheelOpen(NSO_wheelSession, opts);
    else if (move === 'pull') r = NSO_wheelPull(NSO_wheelSession, opts);
    else if (move === 'trim') r = NSO_wheelTrim(NSO_wheelSession, opts);
    else if (move === 'rim') r = NSO_wheelExtendRim(NSO_wheelSession, opts);
    else return { ok: false, reason: 'unknown move ' + move };

    if (!r.ok) {
      if (typeof setStatus === 'function') setStatus(r.reason, true);
      return r;
    }
    NSO_wheelSession = r.piece;
    /* The move's own reason is the status line - it carries the numbers the
       potter needs (what was opened, what was trimmed, what Extend held) and
       NSO_wheelStatus appends the height, the budget and, when it fires, the
       build-volume warning. The caller's `head` is only a fallback. */
    NSO_wheelBake(r.reason || head);
    return r;
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[wheel]', err);
    if (typeof setStatus === 'function') {
      setStatus('Pottery Wheel failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
    }
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

/* ---------------------------------------------------------------------------
   UI entry point.

   Deliberately the four moves and nothing else. The live drag itself is wired
   to the existing pointer plumbing: a drag in the viewport with the wheel open
   collects (z, r) samples and calls NSO_wheelPull on every move, which is what
   "live" means here - the gate runs per frame, the refusal shows per frame,
   and the form is revolved to a clean solid per frame.
--------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  (function wireWheel() {
    function num(id, dflt) {
      var el = document.getElementById(id);
      var v = el ? parseFloat(el.value) : NaN;
      return (isFinite(v) && v > 0) ? v : dflt;
    }
    function on(id, fn) {
      var b = document.getElementById(id);
      if (!b || b.dataset.nsoWired === '1') return;
      b.dataset.nsoWired = '1';
      b.addEventListener('click', fn);
    }
    function wire() {
      on('btn-wheel-ball', function () {
        var h = num('inp-wheel-height', 0);
        if (!h) {
          if (typeof setStatus === 'function') setStatus('Set a target height first (mm)', true);
          return;
        }
        NSO_wheelRun('ball', {
          height: h,
          radius: num('inp-wheel-radius', undefined),
          wall: num('inp-wheel-wall', undefined),
          nozzle: num('inp-wheel-nozzle', undefined)
        }, 'Ball centred');
      });
      on('btn-wheel-open', function () {
        NSO_wheelRun('open', { depth: num('inp-wheel-depth', undefined) }, 'Opened');
      });
      on('btn-wheel-pull', function () {
        var z = num('inp-wheel-pull-z', undefined);
        var dr = parseFloat((document.getElementById('inp-wheel-pull-dr') || {}).value);
        if (!(isFinite(z) && isFinite(dr))) {
          if (typeof setStatus === 'function') setStatus('Pull needs a height and a radius change', true);
          return;
        }
        NSO_wheelRun('pull', { z: z, dr: dr }, 'Pulled');
      });
      on('btn-wheel-trim', function () {
        NSO_wheelRun('trim', { z: num('inp-wheel-trim-z', undefined) }, 'Trimmed');
      });
      on('btn-wheel-rim', function () {
        NSO_wheelRun('rim', { delta: num('inp-wheel-rim-mm', undefined) }, 'Rim extended');
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
