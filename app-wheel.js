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
//   MATERIAL SIZING   the ball's size comes from nso_stock.js - the same
//     shape-agnostic "target -> shell estimate -> waste margin -> solve for the
//     defining measurement" New stock uses for a box or a cylinder. NOT a copy
//     of it: loaded without that module this file refuses by name rather than
//     re-deriving Pappus. See docs/STOCK.md.
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

/* The top of the PIECE, not of one profile. On a bowl the outer profile ends at the
   rim and so does the inner; on a lipped plate the highest point is the top face's
   end on the INNER profile, a little above where the outside stops. Anything that
   reports how tall the piece is (the status line, the build-volume check, the
   canonical checker's bbox) reads this. */
function NSO_wheelTopZ(piece) {
  var t = piece.outer[piece.outer.length - 1].z;
  if (piece.inner && piece.inner.length) t = Math.max(t, piece.inner[piece.inner.length - 1].z);
  return t;
}
function NSO_wheelHeightOf(piece) { return NSO_wheelTopZ(piece) - piece.outer[0].z; }

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
    var qr = ar + t * dr - r, qz = az + t * dz - z;
    var d = qr * qr + qz * qz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
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

/* THE SIZING IS NOT THIS FILE'S ANY MORE, and that is deliberate.

   "Target dimension -> estimated shell volume -> waste margin -> solve for the
   primitive's defining measurement" was never about spheres. It is now
   nso_stock.js, shape-agnostic, and BALL is one call into it with shape
   'sphere'. The defaults went with it - the 3.0 mm wall, the 30% waste, the
   0.5 aspect are stated once, in NSO_Stock.DEFAULTS, instead of once here and
   once there. See docs/STOCK.md.

   What stays here is the wheel's own vocabulary: `ball_radius` rather than
   `measure.radius`, and a reason line that says "ball" because a potter reads
   it. Byte-for-byte the same line it always said - tools/nso_stock_test.js
   pins it against the figures docs/POTTERY-WHEEL.md published before the
   move, and tools/nso_wheel_test.js still checks every number in it.

   No build volume is asked for here. The wheel has its own LIVE build-volume
   readout (NSO_wheelStatus -> NSO_wheelFitReport), which runs on every update
   rather than only at the ball, so passing a printer into the sizing would
   put the same warning in twice and change what BALL says. */
function NSO_wheelStock() {
  if (typeof NSO_Stock !== 'undefined' && NSO_Stock) return NSO_Stock;
  if (typeof window !== 'undefined' && window.NSO_Stock) return window.NSO_Stock;
  throw new Error('nso_stock.js is not loaded - the ball sizing is NSO_Stock.size() and ' +
                  'this file does not carry its own copy of the Pappus arithmetic');
}

/* opts: height (required, mm), radius, wall, waste, nozzle. */
function NSO_wheelSizeBall(opts) {
  opts = opts || {};
  /* The floor first, and from NSO_Thickness as it has always been: a context
     with no nso_thickness.js must still refuse by naming that module, not the
     next one down the chain. */
  var floor = NSO_wheelFloor(opts.nozzle);
  var sized = NSO_wheelStock().size({
    shape: 'sphere',
    height: opts.height, radius: opts.radius, wall: opts.wall,
    waste: opts.waste, floor: floor, what: 'thrown'
  });
  if (!sized.ok) return { ok: false, reason: sized.reason };

  var a = sized.measure.radius;
  return {
    ok: true,
    height: sized.height, radius: sized.radius, wall: sized.wall,
    waste: sized.waste, nozzle_floor: sized.nozzle_floor,
    wall_volume: sized.wall_volume, floor_volume: sized.floor_volume,
    shell_volume: sized.shell_volume,
    ball_volume: sized.need_volume,
    ball_radius: a,
    stock: sized,
    reason: 'target ' + sized.height.toFixed(1) + ' x ' + (2 * sized.radius).toFixed(1) + ' mm, ' +
      sized.wall.toFixed(2) + ' mm wall: shell ' + sized.shell_volume.toFixed(1) + ' mm^3, +' +
      Math.round(sized.waste * 100) + '% waste = ' + sized.need_volume.toFixed(1) + ' mm^3, ' +
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

/* THE STANDARD BALL. Nobody should have to name the vessel they want before
   they have touched the clay: with no target height the wheel starts from one
   ball of a fixed size, big enough to press into a plate or open into a bowl,
   and anything bigger is built from there by adding clay (Rim +). 25 mm radius
   is 65.4 cm^3: pressed to the 3 mm wall it is a 166 mm disc, which still fits
   the smallest machine in nso_printer.js, and opened it is a hand-sized bowl.
   A target height (H, optionally R) still sizes the ball by Pappus's theorem,
   exactly as before - that route is now the option, not the way in.          */
var NSO_WHEEL_DEFAULT_BALL_RADIUS = 25;   // mm

function NSO_wheelDefaultBall(opts) {
  opts = opts || {};
  /* The floor first, from NSO_Thickness, as every other route does: a context
     with no nso_thickness.js must refuse by naming that module. */
  var floor = NSO_wheelFloor(opts.nozzle);
  var dflt = NSO_wheelStock().DEFAULTS || {};
  var wall = (typeof opts.wall === 'number' && opts.wall > 0) ? opts.wall : (dflt.wall || 3);
  if (wall < floor) {
    return { ok: false, reason: 'a ' + wall.toFixed(3) + ' mm wall is under the ' + floor.toFixed(3) +
      ' mm nozzle floor - nothing thrown that thin could be printed' };
  }
  var a = (typeof opts.ballRadius === 'number' && opts.ballRadius > 0) ? opts.ballRadius : NSO_WHEEL_DEFAULT_BALL_RADIUS;
  var vol = 4 / 3 * Math.PI * a * a * a;
  return {
    ok: true,
    height: 2 * a, radius: a, wall: wall, waste: 0, nozzle_floor: floor,
    ball_volume: vol, ball_radius: a,
    reason: 'standard ball, radius ' + a.toFixed(1) + ' mm (' + (vol / 1000).toFixed(1) +
      ' cm^3 of clay) - flatten it for a plate or open it for a bowl'
  };
}

function NSO_wheelBall(opts) {
  opts = opts || {};
  var sized = (typeof opts.height === 'number' && opts.height > 0)
    ? NSO_wheelSizeBall(opts) : NSO_wheelDefaultBall(opts);
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

   Meridian -> a closed triangle soup, Z up, rebuilt from scratch on every
   update.

   THE TESSELLATOR IS NSO_Stock.revolve, not a copy of it. This file builds
   the meridian - up the outside, across the rim, down the inside - and hands
   that loop over; the band rule, the winding and the axis special cases are
   all one function now, shared with the primitives nso_stock.js generates.
   That is what makes "a sphere from new stock and a ball from the wheel are
   the same mesh" a structural fact rather than a coincidence two tests happen
   to agree on. The band rule itself is documented where it lives.
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
  return NSO_wheelStock().revolve(NSO_wheelMeridian(piece), seg, { precise: !!opts.precise });
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
         conserve         keep the clay: the volume the pull added or took is
                          taken out of or put into the HEIGHT (every z scaled
                          about the base by V0/V1). Off by default for now, so
                          the strict API still pins the ceiling behaviour; the
                          Wheel's buttons and live ghost use it.

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

/* More samples where a pull will move the wall. A profile has only as many samples as its
   history left it - a pressed, opened piece's tall wall might have a dozen - and a pull of
   20 mm moves each of them by a different amount, so the wall between two samples is a
   straight facet however smooth the curve that moved them (measured: a turn of 86 degrees
   between neighbouring segments on a 24 mm pull, against 8 with no pull). So inside the
   band the pull reaches, every segment longer than `step` is cut into pieces no longer
   than it IN HEIGHT. They lie on the segment they cut, so the shape does not change;
   horizontal runs (a flat face) are left alone, since a pull moves them all together. */
function NSO_wheelRefineBand(profile, zLo, zHi, step) {
  var out = [{ z: profile[0].z, r: profile[0].r }];
  for (var i = 1; i < profile.length; i++) {
    var a = profile[i - 1], b = profile[i];
    if (Math.abs(b.z - a.z) > 1e-6 && Math.max(a.z, b.z) >= zLo && Math.min(a.z, b.z) <= zHi) {
      /* by HEIGHT, not by length: a pull moves a sample by a function of its z, so a segment that covers
         little z (the near-flat underside of a pressed edge) gains nothing from being cut finer */
      var n = Math.ceil(Math.abs(b.z - a.z) / step);
      for (var k = 1; k < n; k++) {
        var t = k / n;
        out.push({ z: a.z + t * (b.z - a.z), r: a.r + t * (b.r - a.r) });
      }
    }
    out.push({ z: b.z, r: b.r });
  }
  return out;
}

/* The two falloff curves a pull can use, 1 at the pull and 0 at u = 1 and beyond (compact
   support: the base and the rim stay exactly where they were).
     biweight  (1 - u^2)^2     the strict API's, as it always was
     cosine    (1 + cos(pi u))/2   Tube Edge's SMOOTH neck (nso_tube_neck.js): there the mid-wall
                               follows r = r_mid + dr (1 - cos(2 pi s / L)) / 2 over a band of
                               length L, which IS this with u = |s - L/2| / (L/2) and a taper of
                               L/2 - tangent where it leaves the wall, rounded at the waist,
                               easing in and out the same way. The Wheel's pull uses it, so a pull
                               and a Tube Edge neck of the same Δr and length are the same curve. */
function NSO_wheelFalloff(kind) {
  if (kind === 'cosine') return function (u) { return (1 + Math.cos(Math.PI * u)) / 2; };
  return function (u) { var k = 1 - u * u; return k * k; };
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
  var falloff = NSO_wheelFalloff(opts.kernel);
  function disp(z) {
    if (z >= pLo && z <= pHi) return fit(z) - NSO_wheelRadiusAt(piece.outer, z);
    var u, edge;
    if (z < pLo) { u = (pLo - z) / taper; edge = dLo; } else { u = (z - pHi) / taper; edge = dHi; }
    if (u >= 1) return 0;
    return edge * falloff(u);
  }

  var outer = NSO_wheelClone(piece.outer);
  var band = null;
  if (opts.refine) {
    /* How fine? The falloff bends hardest where its curvature is (pi^2/2) amp / taper^2, and the turn
       between neighbouring segments is about that curvature times their spacing; keeping it under
       ~4 degrees (0.07 rad) gives a step of 0.07 taper^2 / (4.93 amp). A narrow, deep pull needs a
       fine wall (down to 0.04 mm), a broad shallow one hardly any (up to 1 mm); and never more than
       ~260 samples across the band, so a rebuild stays fast. */
    var amp = Math.max(Math.abs(dLo), Math.abs(dHi), 1);
    for (var q = 0; q < path.length; q++) amp = Math.max(amp, Math.abs(path[q].r - NSO_wheelRadiusAt(piece.outer, path[q].z)));
    var want = Math.min(1, Math.max(0.04, 0.07 * taper * taper / (4.93 * amp)));
    band = { lo: pLo - taper, hi: pHi + taper,
             step: (typeof opts.refineStep === 'number' && opts.refineStep > 0) ? opts.refineStep : want };
    band.step = Math.max(band.step, (Math.min(band.hi, span.hi) - Math.max(band.lo, span.lo)) / 260);
    outer = NSO_wheelRefineBand(outer, band.lo, band.hi, band.step);
  }
  var movedMax = 0;
  for (i = 0; i < outer.length; i++) {
    /* The two ends of the profile sit ON the axis and must stay there: a pole
       or a base centre with r > 0 is a hole in the solid. */
    if (outer[i].r <= NSO_WHEEL_EPS) continue;
    var dd = disp(outer[i].z);
    if (Math.abs(dd) > movedMax) movedMax = Math.abs(dd);
    outer[i].r = Math.max(0, outer[i].r + dd);
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
      if (band) inner = NSO_wheelRefineBand(inner, band.lo, band.hi, band.step);
      if (opts.carryInner !== false) {
        for (i = 0; i < inner.length; i++) {
          if (inner[i].r <= NSO_WHEEL_EPS) continue;
          inner[i].r = Math.max(0, inner[i].r + disp(inner[i].z));
        }
      }
    }
  }

  /* A pull that moved nothing is not a pull. Asking above the rim (or below
     the base) used to come back "ok" with the piece unchanged, which looks
     like it worked. */
  var moved = movedMax;
  /* reshapeWall rebuilds the INSIDE from the outside, which is an action even
     when the outside does not move (straightening a wall that is straight). */
  if (moved < 1e-6 && !opts.reshapeWall) {
    return { ok: false, piece: piece, reason: 'Pulling at z = ' + pLo.toFixed(1) + ' mm moves nothing - ' +
      'the piece only spans z = ' + span.lo.toFixed(1) + ' to ' + span.hi.toFixed(1) + ' mm' };
  }

  var tOuter = NSO_wheelTidy(outer), tInner = NSO_wheelTidy(inner);
  var heightNote = '';
  if (opts.conserve) {
    /* THE CLAY IS CONSERVED (docs/POTTERY-WHEEL.md "Direction"). The wall
       moved, so the volume changed; the clay for it comes out of - or goes
       into - the HEIGHT. Volume is linear in height for a fixed r(z) (every
       term of the contour integral is a dz), so scaling every z about the base
       by V0/V1 restores it exactly: pull the wall out and the piece sits a
       little lower, push it in and it stands a little taller. Without this a
       pull on a clay-conserving piece has zero headroom and fails whenever it
       goes outward, and quietly destroys clay whenever it goes inward. */
    var V0 = NSO_wheelVolume(piece);
    var V1 = NSO_wheelVolume({ outer: tOuter, inner: tInner });
    if (!(V1 > 0)) {
      return { ok: false, piece: piece, reason: 'Pulling at z = ' + pLo.toFixed(1) + ' mm would collapse the piece - pull less' };
    }
    var sc = V0 / V1;
    if (sc < 0.25 || sc > 4) {
      return { ok: false, piece: piece, reason: 'Pulling at z = ' + pLo.toFixed(1) + ' mm would change the height ' +
        'by more than four times to keep the clay - pull less' };
    }
    var zb = tOuter[0].z;
    var scaleZ = function (prof) {
      if (!prof) return prof;
      return prof.map(function (q) { return { z: zb + (q.z - zb) * sc, r: q.r }; });
    };
    var hBefore = span.hi - span.lo;
    tOuter = scaleZ(tOuter); tInner = scaleZ(tInner);
    heightNote = ', height ' + hBefore.toFixed(1) + ' -> ' + (hBefore * sc).toFixed(1) + ' mm to keep the clay';
  }

  var cand = {
    outer: tOuter, inner: tInner,
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['pull'])
  };

  var g = NSO_wheelGate(piece, cand, 'Pulling at z = ' + pLo.toFixed(1) +
    (dragSpan > 1e-6 ? ('-' + pHi.toFixed(1)) : '') + ' mm');
  if (!g.ok) return g;
  g.reason = 'Pulled z ' + pLo.toFixed(1) + '-' + pHi.toFixed(1) + ' mm through ' +
    path.length + ' drag point(s), ' + (g.budget.headroom).toFixed(1) + ' mm^3 of clay left' + heightNote;
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

/* ------------------------------------------------------------ 7e. FLATTEN

   Press the ball down onto the wheel. The top comes down, and because the
   clay has nowhere else to go the piece spreads: a sphere becomes an oblate
   bulge, then a disc with a flat core and a rounded edge, and its diameter
   grows by exactly as much as the height was given up.

   THE CLAY IS CONSERVED. This is the first move that is held to the volume of
   the piece it started from rather than to the budget's ceiling: the new form
   is SOLVED so its volume equals the live volume, and the diameter is what
   falls out. (The decision, and the same rule for Open and Pull to follow, is
   in docs/POTTERY-WHEEL.md "Direction".) The solve is a bisection on this
   file's own NSO_wheelVolume - the polygon the revolve will tessellate - and
   it keeps the LOW side of the bracket, so the new form can never come out a
   rounding error over the old one and trip the budget gate on a ball whose
   headroom is exactly zero.

   THE FAMILY. A pressed ball is a rounded slab of height h: a flat core of
   radius c (top and bottom), and an edge that is a half-ellipse of horizontal
   semi-axis e and vertical semi-axis h/2. Pressure p runs from 0 (the ball) to
   1 (the thinnest disc the wall allows). The edge goes from the widest
   ellipsoid the volume will hold (c = 0, which is the oblate bulge) to a full
   half-circle of radius h/2:

       e(p) = h/2 + (eMax(h) - h/2) * (1 - p)^2           c solved from V

   eMax(h) is the c = 0 ellipsoid of that height, so e never exceeds it and c
   is never negative: there is no clamp to get wrong, and p = 0 is a ball
   again. The height is the user's one number (the drag, later); the pressure
   is derived from it, so a drag back UP un-presses along the same family.

   The base stays where it was. Flatten presses a SOLID: an opened piece has a
   cavity floor and a rim a flat press would crush, so it refuses and says to
   flatten first. It does not need to be a ball - any solid is squashed to the
   same family from its own volume - but a piece taller than a ball of that
   much clay cannot be reached by pressing, and refuses.

   opts: height     the pressed height in mm (the top of the piece), OR
         pressure   0..1, how far between the ball and the thinnest disc
         (neither: the thinnest disc the wall allows)                      */
var NSO_WHEEL_FLAT_EDGE_N = 40;   // samples round the rounded edge
var NSO_WHEEL_FLAT_FACE_N = 12;   // samples across each flat face

/* The pressed form as an outer profile: bottom axis, flat bottom out to c,
   round the edge, flat top back in to the axis. Both faces are horizontal, so
   consecutive samples share a z - the same shape Trim's flat base already
   writes, and the revolve takes it as a flat annulus. */
function NSO_wheelDiscProfile(z0, h, e, c, edgeN, faceN) {
  var out = [{ z: z0, r: 0 }], i;
  var core = c > 1e-9;
  if (core) for (i = 1; i <= faceN; i++) out.push({ z: z0, r: c * i / faceN });
  for (i = 1; i <= edgeN; i++) {
    var f = -Math.PI / 2 + Math.PI * i / edgeN;
    out.push({ z: z0 + h / 2 + (h / 2) * Math.sin(f), r: c + e * Math.cos(f) });
  }
  /* cos(pi/2) is 6e-17, not 0: pin the last edge sample so the top is exactly
     the flat face's rim (core) or exactly the pole (no core). */
  out[out.length - 1] = { z: z0 + h, r: core ? c : 0 };
  if (core) for (i = 1; i <= faceN; i++) out.push({ z: z0 + h, r: c * (1 - i / faceN) });
  return out;
}

/* The pressed form of volume V at height h, from the base at z0.
   Returns { ok, outer, e, c, diameter, pressure, hTop, hMin } or a refusal. */
function NSO_wheelFlatSolve(V, z0, h, hMin, opts) {
  opts = opts || {};
  var edgeN = Math.max(12, Math.round(opts.edgeN || NSO_WHEEL_FLAT_EDGE_N));
  var faceN = Math.max(2, Math.round(opts.faceN || NSO_WHEEL_FLAT_FACE_N));
  function vol(hh, e, c) {
    return NSO_wheelVolume({ outer: NSO_wheelDiscProfile(z0, hh, e, c, edgeN, faceN), inner: null });
  }
  /* The tallest the family goes: the c = 0, e = h/2 ellipsoid IS a ball, so the
     height at which that holds exactly V. Grown then bisected - no cube root
     here, because the ball arithmetic is nso_stock.js's and not this file's. */
  var hi = Math.max(1, hMin), lo = 0, i;
  while (vol(hi, hi / 2, 0) < V && hi < 1e6) hi *= 2;
  for (i = 0; i < 80; i++) { var m = 0.5 * (lo + hi); if (vol(m, m / 2, 0) <= V) lo = m; else hi = m; }
  var hTop = lo;
  if (!(hTop > hMin + 1e-9)) {
    return { ok: false, reason: 'this much clay is only ' + hTop.toFixed(2) + ' mm tall as a ball - ' +
      'no thicker than the ' + hMin.toFixed(2) + ' mm wall, so there is nothing to press' };
  }
  if (h > hTop + 1e-9) {
    return { ok: false, reason: 'a ' + h.toFixed(2) + ' mm height is taller than a ball of this much clay ' +
      '(' + hTop.toFixed(2) + ' mm) - Flatten only presses down' };
  }
  if (h < hMin - 1e-9) {
    return { ok: false, reason: 'a ' + h.toFixed(2) + ' mm disc is thinner than the ' + hMin.toFixed(2) +
      ' mm wall - flatten to no less than that, or ask for a thinner wall' };
  }
  h = Math.min(hTop, Math.max(hMin, h));
  var p = (hTop - h) / (hTop - hMin);

  /* The widest c = 0 ellipsoid of this height that holds no more than V. */
  var eLo = 0, eHi = Math.sqrt(3 * V / (2 * Math.PI * h)) * 1.2 + 1;
  for (i = 0; i < 80; i++) { var me = 0.5 * (eLo + eHi); if (vol(h, me, 0) <= V) eLo = me; else eHi = me; }
  var eMax = eLo;
  var e = h / 2 + Math.max(0, eMax - h / 2) * (1 - p) * (1 - p);

  var cLo = 0, cHi = Math.sqrt(V / (Math.PI * h)) + 1;
  if (vol(h, e, 0) > V) { cHi = 0; }          // already no room for a core: the bulge itself
  for (i = 0; i < 80 && cHi > 0; i++) { var mc = 0.5 * (cLo + cHi); if (vol(h, e, mc) <= V) cLo = mc; else cHi = mc; }
  var c = cLo;
  if (c < 1e-9) c = 0;
  return {
    ok: true, outer: NSO_wheelDiscProfile(z0, h, e, c, edgeN, faceN),
    height: h, e: e, c: c, diameter: 2 * (c + e), pressure: p, hTop: hTop, hMin: hMin
  };
}

function NSO_wheelFlatten(piece, opts) {
  opts = opts || {};
  if (piece.inner) {
    return { ok: false, piece: piece, reason: 'this piece is already open - Flatten presses a solid; ' +
      'flatten first, then open it' };
  }
  var wall = piece.wall;
  var nozzleFloor = NSO_wheelFloor(piece.nozzle);
  if (wall < nozzleFloor) {
    return { ok: false, piece: piece, reason: 'a ' + wall.toFixed(3) + ' mm wall is under the ' +
      nozzleFloor.toFixed(3) + ' mm nozzle floor - nothing pressed that thin could be printed' };
  }
  var V = NSO_wheelVolume(piece);
  if (!(V > 0)) return { ok: false, piece: piece, reason: 'there is no clay on the wheel to press' };
  var z0 = piece.outer[0].z;

  var h = opts.height;
  if (!(typeof h === 'number' && isFinite(h))) {
    if (typeof opts.pressure === 'number' && isFinite(opts.pressure)) {
      /* Pressure picks a height inside the family, so it needs hTop first. */
      var probe = NSO_wheelFlatSolve(V, z0, wall, wall, opts);
      if (!probe.ok) return { ok: false, piece: piece, reason: 'Flatten: ' + probe.reason };
      var pp = Math.min(1, Math.max(0, opts.pressure));
      h = probe.hTop - pp * (probe.hTop - wall);
    } else {
      h = wall;        // nothing asked: as flat as the wall allows
    }
  }
  var s = NSO_wheelFlatSolve(V, z0, h, wall, opts);
  if (!s.ok) return { ok: false, piece: piece, reason: 'Flatten: ' + s.reason };

  var cand = {
    outer: s.outer, inner: null,
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['flatten']),
    press: { h: s.height, e: s.e, c: s.c }          // what Lip needs to know it has a plate to lift
  };
  var g = NSO_wheelGate(piece, cand, 'Flattening to ' + s.height.toFixed(2) + ' mm');
  if (!g.ok) return g;
  g.height = s.height;
  g.diameter = s.diameter;
  g.pressure = s.pressure;
  g.reason = 'Flattened to ' + s.height.toFixed(1) + ' mm thick, ' + s.diameter.toFixed(1) +
    ' mm across (' + Math.round(s.pressure * 100) + '% pressed), clay conserved';
  return g;
}

/* ------------------------------------------------------------ 7e2. LIP

   The perimeter of a flat plate, lifted into a rim with a flared transition - the
   way a plate's edge rises. The plate is a constant-thickness slab of the thickness
   it was pressed to; out to the START radius it stays flat, and from there its
   MIDLINE turns up along a smooth curve - the heading eases in as sin^2 (so the
   underside leaves the flat tangent, with no crease), holds a lift angle to the rim,
   and the slab is swept along it, so the thickness is the plate's all the way. The
   rim ends in a rounded edge.

   THE CLAY IS CONSERVED. Bending a slab inward shortens its reach, so the plate does
   not simply keep its diameter: the length of the bent part is SOLVED so the volume is
   what it was (bisection, low side kept, as Flatten does), and the diameter is what
   falls out - a hair under the flat plate's.

   THE HEIGHT IS ASKED FOR, THE ANGLE IS SOLVED: the lift angle is whatever makes the
   midline rise the asked height over that length (capped at 70 degrees, and said so
   when it bites). The flare is the length of the transition as a fraction of the bent
   length, lengthened where it would fold the top surface (the top face is the INSIDE of
   the bend; a radius of curvature under half the thickness cusps it).

   A lipped plate is an opened piece: outer = the underside up round the rim's outside,
   inner = the top face. Both rise monotonically, so the whole wheel (gate, revolve,
   guide lines, Pull, Trim) takes it as it takes a bowl. The rim is closed by a short
   chord - 0.6 of the thickness - so the wall gate has a real rim to measure.

   opts: height (mm the rim rises), at (0..1, where the lift starts, as a fraction of the
         plate's radius), flare (0..1), clamp (true: cap what cannot be had and say so) */
var NSO_WHEEL_LIP_MAX_DEG = 70;
var NSO_WHEEL_LIP_STEPS = 96;

/* How far the midline rises over length Sb for a lift angle th and transition length Ls. */
function NSO_wheelLipRise(th, Sb, Ls) {
  /* The same midpoint steps the profile is built with, so the rise solved for IS the rise drawn. */
  var n = NSO_WHEEL_LIP_STEPS, ds = Sb / n, rise = 0;
  for (var i = 0; i < n; i++) {
    var u = Math.min(1, (i + 0.5) * ds / Ls);
    rise += ds * Math.sin(th * Math.pow(Math.sin(Math.PI / 2 * u), 2));
  }
  return rise;
}

/* The lift angle and transition length for a rise H over bent length Sb. */
function NSO_wheelLipShape(h, H, Sb, flare) {
  var thMax = NSO_WHEEL_LIP_MAX_DEG * Math.PI / 180;
  var Ls = Math.max(1e-6, flare * Sb), th = 0, clamped = false, lengthened = false;
  for (var pass = 0; pass < 3; pass++) {
    if (NSO_wheelLipRise(thMax, Sb, Ls) < H) { th = thMax; clamped = true; }
    else {
      clamped = false;
      var lo = 0, hi = thMax;
      for (var i = 0; i < 26; i++) { var mid = 0.5 * (lo + hi); if (NSO_wheelLipRise(mid, Sb, Ls) < H) lo = mid; else hi = mid; }
      th = 0.5 * (lo + hi);
    }
    /* the top face is the inside of the bend: keep its radius of curvature >= h/2 */
    var Lneed = th * (Math.PI / 2) * h / 1.6;
    if (Ls < Lneed) { Ls = Lneed; lengthened = true; } else break;
  }
  return { th: th, Ls: Ls, clamped: clamped, lengthened: lengthened };
}

/* The lipped plate's two profiles. */
function NSO_wheelLipProfile(z0, h, r0, Sb, Ls, th) {
  var N = NSO_WHEEL_LIP_STEPS, rho = h / 2;
  var outer = [{ z: z0, r: 0 }, { z: z0, r: r0 }];
  var inner = [{ z: z0 + h, r: 0 }, { z: z0 + h, r: r0 }];
  function theta(s) { var u = Math.min(1, s / Ls); return th * Math.pow(Math.sin(Math.PI / 2 * u), 2); }
  var r = r0, zm = z0 + h / 2, s = 0, ds = Sb / N, i;
  for (i = 1; i <= N; i++) {
    var a = theta(s + ds / 2);
    r += ds * Math.cos(a); zm += ds * Math.sin(a); s += ds;
    var a1 = theta(s);
    outer.push({ z: zm - rho * Math.cos(a1), r: r + rho * Math.sin(a1) });
    inner.push({ z: zm + rho * Math.cos(a1), r: r - rho * Math.sin(a1) });
  }
  /* The rim: round arcs of radius h/2 about the midline's end, left a chord of 0.6 h
     apart. psi is measured from the top normal round towards the tip; the top arc stops
     where it is highest (psi = the end heading) so the inner profile keeps rising. */
  var te = theta(Sb), cs = Math.cos(te), sn = Math.sin(te);
  var gap = 2 * Math.asin(0.6), psiI = te, psiO = psiI + gap, K = 10, k;
  function at(psi) {
    return { r: r + rho * (Math.sin(psi) * cs - Math.cos(psi) * sn), z: zm + rho * (Math.sin(psi) * sn + Math.cos(psi) * cs) };
  }
  for (k = 1; k <= K; k++) inner.push(at(psiI * k / K));
  for (k = 1; k <= K; k++) outer.push(at(Math.PI - (Math.PI - psiO) * k / K));
  return { outer: outer, inner: inner, endHeading: te };
}

function NSO_wheelLip(piece, opts) {
  opts = opts || {};
  if (piece.inner) {
    return { ok: false, piece: piece, reason: 'this piece is already open - Lip lifts the edge of a flat plate; close Deep first' };
  }
  var pr = piece.press;
  if (!pr) {
    return { ok: false, piece: piece, reason: 'Lip lifts the edge of a pressed plate - press the ball flat first (drag Thick down)' };
  }
  if (!(pr.c >= pr.h)) {
    return { ok: false, piece: piece, reason: 'this is a thick bulge, not a plate (flat across ' + (2 * pr.c).toFixed(1) +
      ' mm, ' + pr.h.toFixed(1) + ' mm thick) - press it flatter to give Lip a plate to lift' };
  }
  var H = opts.height;
  if (!(typeof H === 'number' && H > 1e-9)) {
    return { ok: false, piece: piece, reason: 'Lip needs a height to lift the rim by' };
  }
  var V = NSO_wheelVolume(piece), z0 = piece.outer[0].z, h = pr.h, R0 = pr.c + pr.e;
  var at = (typeof opts.at === 'number') ? Math.min(0.95, Math.max(0.05, opts.at)) : 0.6;
  var flare = (typeof opts.flare === 'number') ? Math.min(1, Math.max(0.05, opts.flare)) : 0.5;
  var r0 = at * R0;

  function build(Sb) {
    var sh = NSO_wheelLipShape(h, H, Sb, flare);
    var pf = NSO_wheelLipProfile(z0, h, r0, Sb, sh.Ls, sh.th);
    return { sh: sh, pf: pf, vol: NSO_wheelVolume({ outer: pf.outer, inner: pf.inner }) };
  }
  var lo = 0.5, hi = 4 * R0 + 4 * H, i;
  if (build(lo).vol > V) {
    return { ok: false, piece: piece, reason: 'Lip starting at ' + (at * 100).toFixed(0) + '% of the radius leaves no clay to lift - start it further out' };
  }
  if (build(hi).vol < V) {
    return { ok: false, piece: piece, reason: 'Lip could not use all the clay - lift less' };
  }
  for (i = 0; i < 38; i++) { var mid = 0.5 * (lo + hi); if (build(mid).vol <= V) lo = mid; else hi = mid; }
  var b = build(lo);
  if (b.sh.clamped && !opts.clamp) {
    return { ok: false, piece: piece, reason: 'a ' + H.toFixed(1) + ' mm lip would need the rim to lean past ' + NSO_WHEEL_LIP_MAX_DEG +
      ' degrees over this length - lift less, or start it further in' };
  }
  var cand = {
    outer: b.pf.outer, inner: b.pf.inner,
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['lip']),
    press: piece.press            // still a pressed plate: the rim handle needs to know
  };
  var g = NSO_wheelGate(piece, cand, 'Lipping');
  if (!g.ok) return g;
  var rMax = 0, j;
  for (j = 0; j < cand.outer.length; j++) if (cand.outer[j].r > rMax) rMax = cand.outer[j].r;
  for (j = 0; j < cand.inner.length; j++) if (cand.inner[j].r > rMax) rMax = cand.inner[j].r;
  /* The rise is the rim's highest point above the plate's own top face - the top of the
     inner arc, where the top face stops rising - which is what the slider asks for. */
  var zTop = 0;
  for (j = 0; j < cand.inner.length; j++) if (cand.inner[j].z > zTop) zTop = cand.inner[j].z;
  for (j = 0; j < cand.outer.length; j++) if (cand.outer[j].z > zTop) zTop = cand.outer[j].z;
  g.diameter = 2 * rMax; g.flatDiameter = 2 * R0; g.rise = zTop - (z0 + h);
  g.angle = b.sh.th * 180 / Math.PI; g.endAngle = b.pf.endHeading * 180 / Math.PI;
  g.flareLength = b.sh.Ls; g.clamped = b.sh.clamped; g.lengthened = b.sh.lengthened;
  g.reason = 'Lip raised ' + g.rise.toFixed(1) + ' mm' + (b.sh.clamped ? ' (of ' + H.toFixed(1) + ' asked - the rim cannot lean past ' + NSO_WHEEL_LIP_MAX_DEG + ' degrees over this length)' : '') +
    ', flaring over ' + b.sh.Ls.toFixed(1) + ' mm' + (b.sh.lengthened ? ' (lengthened so the top face does not fold)' : '') +
    ' to ' + g.angle.toFixed(1) + ' degrees; diameter ' + (2 * R0).toFixed(1) + ' -> ' + g.diameter.toFixed(1) + ' mm, clay conserved';
  return g;
}

/* ------------------------------------------------------------ 7f. SLIDERS
   What the live sliders (app-wheel-live.js) need from the geometry, kept here
   so it is headless and tested: the piece a move starts from, a Pull that
   stops where the clay or the wall runs out, a ball that can be resized, and
   the range each slider may say for the piece on the wheel.                */

var NSO_WHEEL_OP_OF = { flatten: 'flatten', open: 'open', trim: 'trim', rim: 'extendRim', pull: 'pull' };

/* The piece a move starts from. Open, Trim and Rim + are ONE adjustable thing
   each, so dragging their slider again starts from the piece as it was before
   the last one - it adjusts, it does not stack a second. Flatten is a function
   of the clay and needs no base; Pull accumulates, as pulls do. */
function NSO_wheelBaseOf(piece, history, move) {
  var last = piece.ops[piece.ops.length - 1];
  if ((move === 'open' || move === 'trim' || move === 'rim') && history && history.length >= 2 &&
      last === NSO_WHEEL_OP_OF[move]) {
    return history[history.length - 2].piece;
  }
  return piece;
}

/* A Pull that does as much of what was asked as the clay and the wall allow.
   Pull is refused whole when it would need clay the wheel does not have or
   would thin the wall under the nozzle floor, which made it fail more often
   than it worked. This finds the largest pull in the same direction that
   passes the SAME gate (bisection on the amount: both limits only get worse
   as the pull gets bigger) and says what stopped it. Used by the live ghost
   and by what releasing it sets; NSO_wheelPull itself still refuses whole.
   It CONSERVES the clay by default (opts.conserve, see NSO_wheelPull), so the
   budget never stops it - the wall and the height limit do.
   opts: z, dr (a single pull)                                              */
function NSO_wheelPullClamped(piece, opts) {
  opts = Object.assign({ conserve: true }, opts || {});
  var full = NSO_wheelPull(piece, opts);
  if (full.ok) { full.asked = 1; full.got = 1; return full; }
  if (!(typeof opts.z === 'number' && typeof opts.dr === 'number') || opts.points) return full;
  /* The refusal's own words are the limit: out of clay, or a wall under the floor. */
  var limit = /out of material/.test(full.reason) ? 'the clay on the wheel ran out'
            : /nozzle floor/.test(full.reason) ? 'the wall reached the nozzle floor'
            : /four times/.test(full.reason) ? 'the height would have to change too much to keep the clay'
            : null;
  if (!limit) return full;
  var lo = 0, hi = 1, best = null, i;
  for (i = 0; i < 24; i++) {
    var mid = 0.5 * (lo + hi);
    var r = NSO_wheelPull(piece, { z: opts.z, dr: opts.dr * mid, taper: opts.taper, reshapeWall: opts.reshapeWall, conserve: opts.conserve,
                                   kernel: opts.kernel, refine: opts.refine, refineStep: opts.refineStep });
    if (r.ok) { lo = mid; best = r; } else hi = mid;
  }
  if (!best || !(lo > 1e-3)) {
    full.limit = limit;
    return full;           // not even a hair of it fits: refused as before
  }
  best.asked = 1; best.got = lo; best.limit = limit;
  best.clamped = true;
  best.reason = 'Pulled ' + (opts.dr * lo).toFixed(2) + ' of ' + opts.dr.toFixed(2) + ' mm at z = ' +
    opts.z.toFixed(1) + ' mm - stopped there because ' + limit;
  return best;
}

/* BALL, resized. Only while the ball is untouched: once anything has been done
   to it there is no "the ball" left to resize, and the sliders then set the
   NEXT ball instead. */
function NSO_wheelIsPristine(piece) {
  return !!piece && piece.ops.length === 1 && piece.ops[0] === 'ball';
}

function NSO_wheelReball(piece, opts) {
  if (!NSO_wheelIsPristine(piece)) {
    return { ok: false, piece: piece, reason: 'the ball has been worked already - these set the next ball' };
  }
  var r = NSO_wheelBall(opts);
  if (!r.ok) return { ok: false, piece: piece, reason: r.reason };
  r.reason = r.reason.replace(/^Ball centred/, 'Ball resized');
  return r;
}

/* One entry for every move, on whichever piece the caller says: the
   dispatcher NSO_wheelRun and the live preview both use it, so a preview can
   never show something the commit would not do. */
function NSO_wheelApply(move, piece, opts) {
  if (move === 'flatten') return NSO_wheelFlatten(piece, opts);
  if (move === 'open') return NSO_wheelOpen(piece, opts);
  if (move === 'pull') return opts && opts.clamp ? NSO_wheelPullClamped(piece, opts) : NSO_wheelPull(piece, opts);
  if (move === 'trim') return NSO_wheelTrim(piece, opts);
  if (move === 'rim') return NSO_wheelExtendRim(piece, opts);
  if (move === 'reball') return NSO_wheelReball(piece, opts);
  if (move === 'lip') return NSO_wheelLip(piece, opts);
  return { ok: false, piece: piece, reason: 'unknown move ' + move };
}

function NSO_wheelStep(x, step, up) {
  var k = Math.round(1 / step);
  return up ? Math.ceil(x * k - 1e-9) / k : Math.floor(x * k + 1e-9) / k;
}

/* The range each slider may say for this piece (history: the session's, for
   the "adjust the last one" bases). A slider whose move cannot be done right
   now comes back { on: false, why } and is drawn disabled, with the reason as
   its tooltip - never silently dead.                                       */
function NSO_wheelRanges(piece, history) {
  var out = {
    pristine: NSO_wheelIsPristine(piece),
    flatten: { on: false }, open: { on: false }, pull: { on: false },
    trim: { on: false }, rim: { on: false }
  };
  if (!piece) {
    var none = 'nothing on the wheel - drop a ball first';
    out.flatten.why = out.open.why = out.pull.why = out.trim.why = out.rim.why = none;
    return out;
  }
  var span = NSO_wheelSpan(piece.outer);
  var rMax = 0, i;
  for (i = 0; i < piece.outer.length; i++) if (piece.outer[i].r > rMax) rMax = piece.outer[i].r;
  var floor = NSO_wheelFloor(piece.nozzle);

  /* Flatten: from the ball's own height down to the wall. */
  if (piece.inner) {
    out.flatten.why = 'this piece is already open - Flatten presses a solid';
  } else {
    var s = NSO_wheelFlatSolve(NSO_wheelVolume(piece), span.lo, piece.wall, piece.wall);
    if (!s.ok) out.flatten.why = s.reason;
    else {
      out.flatten = {
        on: true, step: 0.1,
        min: NSO_wheelStep(piece.wall, 0.1, true), max: NSO_wheelStep(s.hTop, 0.1, false),
        value: Math.min(s.hTop, Math.max(piece.wall, span.hi - span.lo))
      };
    }
  }

  /* Open: from a little to as deep as the ball will take. */
  var base = NSO_wheelBaseOf(piece, history, 'open');
  if (base.inner) {
    out.open.why = 'this piece is already open, and something has been done since';
  } else {
    var o = NSO_wheelOpen(base, {});
    if (!o.ok) out.open.why = o.reason;
    else {
      var maxDepth = NSO_wheelStep(o.depth, 0.1, false);
      var now = piece.inner ? (piece.outer[piece.outer.length - 1].z - piece.inner[0].z) : o.depth;
      out.open = { on: true, step: 0.1, min: 1, max: maxDepth, value: Math.min(maxDepth, Math.max(1, now)) };
    }
  }

  /* Pull: any height on the piece, and a swing about half the widest radius. */
  var swing = Math.max(5, NSO_wheelStep(rMax / 2, 0.5, false));
  out.pull = {
    on: true, step: 0.5,
    zMin: NSO_wheelStep(span.lo, 0.5, true), zMax: NSO_wheelStep(span.hi, 0.5, false),
    drMin: -swing, drMax: swing
  };

  /* Trim: from where the base is now up to what the cavity or the thickness leaves. */
  var tbase = NSO_wheelBaseOf(piece, history, 'trim');
  var tspan = NSO_wheelSpan(tbase.outer);
  var tmax = tbase.inner ? tbase.inner[0].z - floor - 0.1 : tspan.hi - floor - 0.1;
  if (tmax <= tspan.lo + 0.1) out.trim.why = 'nothing to take off the base - the piece is already as thin as the floor allows';
  else out.trim = { on: true, step: 0.1, min: NSO_wheelStep(tspan.lo, 0.1, true), max: NSO_wheelStep(tmax, 0.1, false),
                    value: NSO_wheelStep(span.lo, 0.1, true) };

  /* Rim +: height added at the rim. It needs a straight wall; the slider says
     what the refusal says when there is not one. */
  out.rim = { on: true, step: 0.5, min: 0, max: 60, value: 0 };
  return out;
}

/* ------------------------------------------------------------ 7g. THE RECIPE

   THE PIECE IS A RECIPE, NOT A PILE OF BAKED STEPS. Every slider on the card
   is a live value in one recipe, and the form is REBUILT from the ball, in the
   order a potter works, every time any of them moves:

       ball  ->  press (Thick)  ->  open (Deep) or lip (Lip)  ->  pull (where, how
       far, how soft)  ->  trim  ->  rim +

   Nothing is baked into the profile, so nothing shuts a slider off: dragging
   Thick after the bowl is open re-presses the ball and opens it again on the new
   shape; dragging H resizes the ball under everything else. A stage that cannot
   be done at the current values is CLAMPED to what it can do - never refused -
   and says so in `notes`, so a slider is never dead, only limited, and the
   reason is on screen. The ranges each slider may say come out of the same pass
   (`ranges`), because they depend on what is upstream of them.

   The clay is conserved by the first four stages (Trim takes clay away and Rim +
   adds it, and both say so). Open used to throw the top of the ball away; here it
   does not (NSO_wheelOpenKeep).

   recipe = {
     base    null, or a piece to start from instead of a ball (what the strict
             move API bakes into: NSO_wheelRun)
     ball    { height, radius, wall, nozzle } - blank is the standard ball
     thick   null (unpressed) or the pressed thickness, mm
     depth   0 (not opened) or how far the finger goes in, mm
     pull    { z: fraction of the height, dr: mm, wide: falloff as a fraction of
               the height }
     trim    mm taken off the base, 0 for none
     rim     mm added at the rim, 0 for none
   }                                                                         */
/* SEVERAL PULLS. `recipe.pull` is the first; `recipe.more` holds up to three more (slots 2-4), each { z, dr, wide }. They are
   applied in order, each as a fraction of the piece AS IT THEN IS, so a neck and a belly and a collar are one recipe, and each
   conserves the clay and is held by the wall on its own. NSO_wheelPullSlot reads or makes a slot with its defaults. */
var NSO_WHEEL_MAX_PULLS = 4;
var NSO_WHEEL_PULL_DEFAULT_Z = [0.5, 0.8, 0.3, 0.95];
function NSO_wheelPullSlot(recipe, i, make) {
  if (i === 0) return recipe.pull || (make ? (recipe.pull = { z: 0.5, dr: 0, wide: 0.4 }) : { z: 0.5, dr: 0, wide: 0.4 });
  var arr = recipe.more || (make ? (recipe.more = []) : []);
  if (arr[i - 1]) return arr[i - 1];
  var d = { z: NSO_WHEEL_PULL_DEFAULT_Z[i] == null ? 0.5 : NSO_WHEEL_PULL_DEFAULT_Z[i], dr: 0, wide: 0.25 };
  if (make) { while (arr.length < i - 1) arr.push({ z: 0.5, dr: 0, wide: 0.25 }); arr[i - 1] = d; }
  return d;
}

function NSO_wheelNewRecipe(ball) {
  return {
    base: null,
    ball: Object.assign({ height: undefined, radius: undefined, wall: undefined, nozzle: undefined }, ball || {}),
    thick: null, open: 0, tall: 1,
    lip: { h: 0, at: 0.6, flare: 0.5 },
    pull: { z: 0.5, dr: 0, wide: 0.4 },
    more: [],
    trim: 0, rim: 0
  };
}

function NSO_wheelCloneRecipe(r) {
  return {
    base: r.base, ball: Object.assign({}, r.ball), thick: r.thick, open: r.open || 0, tall: r.tall || 1,
    lip: Object.assign({ h: 0, at: 0.6, flare: 0.5 }, r.lip || {}),
    pull: Object.assign({}, r.pull), more: (r.more || []).map(function (m) { return Object.assign({}, m); }),
    trim: r.trim, rim: r.rim
  };
}

/* A recipe with nothing done, on top of a piece that is already what it is. */
function NSO_wheelRecipeOn(piece) {
  var r = NSO_wheelNewRecipe({});
  r.base = piece;
  return r;
}

/* Insert a sample where a profile crosses z, so that scaling everything above
   it is a true stretch of that part (a segment straddling the split would
   otherwise change slope instead of stretching). */
function NSO_wheelSplitAt(profile, z) {
  if (!profile) return profile;
  var out = [], i;
  for (i = 0; i < profile.length; i++) {
    var a = profile[i];
    if (i > 0) {
      var b = profile[i - 1];
      if (b.z < z - 1e-9 && a.z > z + 1e-9) {
        var t = (z - b.z) / (a.z - b.z);
        out.push({ z: z, r: b.r + t * (a.r - b.r) });
      }
    }
    out.push({ z: a.z, r: a.r });
  }
  return out;
}

/* Stretch what is ABOVE zSplit until the volume is Vtarget, leaving what is below it (the base)
   exactly as it was - and do it on a RAMP, not a hard split.

   The first version scaled every height above the split by one factor s, which is exact (volume is
   linear in s) but leaves a crease: the profile just below the split keeps its slope and the profile
   just above has it divided by s - on a pressed ball's rounded edge, stretched fourteen-fold, a 35
   degree kink in the outside wall at the foot, in every opened piece. So the stretch now eases in:

       z' = z + a G(z)        G(z) = the integral of smoothstep((t - zSplit) / band) from zSplit to z

   which is the base untouched at the split, the full stretch (1 + a) from `band` above it, and a
   slope that changes smoothly in between. Every height moves by a quantity LINEAR in the amplitude
   a, so every term of the volume is too, and two evaluations (a = 0 and a = 1) still give a exactly.
   The profile is cut finer over the ramp first (on the segments it lies on: no shape change) so the
   ramp is drawn rather than guessed at. Returns { s: the full factor 1 + a, a, outer, inner } or null. */
function NSO_wheelStretchAbove(piece, zSplit, Vtarget, opts) {
  opts = opts || {};
  var top = Math.max(piece.outer[piece.outer.length - 1].z, piece.inner ? piece.inner[piece.inner.length - 1].z : -Infinity);
  var band = (typeof opts.band === 'number' && opts.band >= 0) ? opts.band : 0.6 * Math.max(0, top - zSplit);
  var step = Math.max(0.05, Math.max(0, top - zSplit) / 240);
  var outer0 = NSO_wheelSplitAt(piece.outer, zSplit), inner0 = NSO_wheelSplitAt(piece.inner, zSplit);
  if (band > 1e-9) {
    outer0 = NSO_wheelRefineBand(outer0, zSplit, zSplit + band, step);
    if (inner0) inner0 = NSO_wheelRefineBand(inner0, zSplit, zSplit + band, step);
  }
  function G(z) {
    var d = z - zSplit;
    if (d <= 0) return 0;
    if (!(band > 1e-9)) return d;                              // a hard split: the old behaviour
    var u = d / band;
    return u >= 1 ? d - band / 2 : band * (u * u * u - u * u * u * u / 2);
  }
  function scale(prof, a) {
    return prof && prof.map(function (q) { return q.z > zSplit + 1e-9 ? { z: q.z + a * G(q.z), r: q.r } : { z: q.z, r: q.r }; });
  }
  function vol(a) { return NSO_wheelVolume({ outer: scale(outer0, a), inner: scale(inner0, a) }); }
  var v0 = vol(0), up = vol(1) - v0;
  if (!(up > 1e-9)) return null;
  var a = (Vtarget - v0) / up;
  /* The guard is only for nonsense. A thin shell really does need a large stretch to give back the clay its
     cavity displaced (x49 on a 0.8 mm opening of a 10.9 mm disc, with the old hard split too), so it sits well
     clear of that: the wall and height gates downstream are what refuse a form that cannot be built. */
  if (!(1 + a > 0.05) || !(1 + a < 1000)) return null;
  return { s: 1 + a, a: a, outer: scale(outer0, a), inner: scale(inner0, a) };
}

/* OPEN, keeping the clay. NSO_wheelOpen cuts the cavity and throws the top of
   the ball away (it stays in the budget, but not on the wheel). The clay a
   finger pushes aside does not vanish - it rises - so what the cavity displaced
   goes back as height on the WALLS: everything above the cavity floor is stretched
   until the volume is what it was, and the base under it is untouched.
   opts as NSO_wheelOpen (depth = how far the finger goes in). */
function NSO_wheelOpenKeep(piece, opts) {
  var V0 = NSO_wheelVolume(piece);
  var o = NSO_wheelOpen(piece, opts);
  if (!o.ok) return o;
  var c = o.piece;
  var st = NSO_wheelStretchAbove(c, c.inner[0].z, V0);
  if (!st) return { ok: false, piece: piece, reason: 'Open could not keep the clay - open less' };
  var cand = {
    outer: NSO_wheelTidy(st.outer), inner: NSO_wheelTidy(st.inner),
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['open'])
  };
  var g = NSO_wheelGate(piece, cand, 'Opening');
  if (!g.ok) return g;
  g.depth = cand.outer[cand.outer.length - 1].z - cand.inner[0].z;
  g.push = o.depth;
  g.stretch = st.s;
  g.reason = 'Opened ' + o.depth.toFixed(1) + ' mm in, walls risen to ' + g.depth.toFixed(1) +
    ' mm deep (x' + st.s.toFixed(2) + ') to keep the clay';
  return g;
}

/* ------------------------------------------------------------ 7a2. OPEN, SOFT

   The Wheel's Open. NSO_wheelOpen / NSO_wheelOpenKeep above are the strict move: they
   open the piece AS WIDE AS THE WALL ALLOWS and throw the dome away, so ANY opening - 0.1 mm of it -
   is the whole bowl, with the dome stood up as straight walls. On a slider that is a cliff: a squished
   ball became a vase bottom in the first pixel, and a Flatten drag past the point where a disc can hold a cavity
   did the same.

   Soft Open is ONE family with no cliff in it, from the closed piece (u = 0) to the widest bowl the
   wall allows (u = 1):

     mouth     u of the widest mouth the shape can hold. The rim sits where the outside is as wide as
               the mouth needs (on the dome of a ball; on the flat top of a plate, which keeps its top),
     depth     u of the way from the rim down to the floor the wall allows - the cavity is a dimple
               (an ellipsoid, round like a thumb) that turns into the bowl's own inside as u -> 1,
     the clay  the whole shell is scaled up, about the middle of its base, until the volume is what it was.
               The clay the cavity and the cut-off dome displaced does not vanish - the piece grows, the way a
               pressed disc's diameter does - so a ball opens to a ROUND bowl, not a tube, and Wall (which is
               never scaled) is the lever for how thin it is.

   Every quantity goes to zero as u goes to zero, so the piece before the first opening and after it are the
   same piece to within a dimple. Pure; the strict API is untouched. */
var NSO_WHEEL_SOFT_MIN_MOUTH = 0.2;
/* The slider is not u itself: the clay a mouth needs grows with the CUBE of how open it is, so the last tenth of a
   linear slider doubled the bowl. This eases the end - u = 1 - (1 - p)^1.5 - so equal drags change the piece by
   comparable amounts. */
var NSO_WHEEL_OPEN_CURVE = 1.5;
function NSO_wheelOpenU(p) {
  p = Math.max(0, Math.min(1, p));
  return 1 - Math.pow(1 - p, NSO_WHEEL_OPEN_CURVE);
}
function NSO_wheelOpenP(u) {            // and back: a drag on the mouth is in u, the slider is in p
  u = Math.max(0, Math.min(1, u));
  return 1 - Math.pow(1 - u, 1 / NSO_WHEEL_OPEN_CURVE);
}      // mm of mouth radius below which there is nothing to open

function NSO_wheelSoftPrep(outer) {
  var n = outer.length, r = new Float64Array(n), z = new Float64Array(n), iw = 0, i;
  for (i = 0; i < n; i++) { r[i] = outer[i].r; z[i] = outer[i].z; }
  for (i = 0; i < n; i++) if (r[i] >= r[iw] - 1e-9) iw = i;
  return { n: n, r: r, z: z, iw: iw };
}

/* Distance from (r, z) to the outside cut off at the point g along it (g = segment + fraction). */
function NSO_wheelSoftCut(pp, g) {
  var seg = Math.min(Math.floor(g), pp.n - 2), t = g - seg;
  return { seg: seg, r: pp.r[seg] + t * (pp.r[seg + 1] - pp.r[seg]), z: pp.z[seg] + t * (pp.z[seg + 1] - pp.z[seg]) };
}
function NSO_wheelSoftDist(pp, cut, r, z) {
  var best = Infinity, i, ar, az, br, bz, dr, dz, len2, t, qr, qz, d;
  for (i = 0; i <= cut.seg; i++) {
    ar = pp.r[i]; az = pp.z[i];
    if (i < cut.seg) { br = pp.r[i + 1]; bz = pp.z[i + 1]; } else { br = cut.r; bz = cut.z; }
    dr = br - ar; dz = bz - az;
    len2 = dr * dr + dz * dz;
    t = len2 > 0 ? (((r - ar) * dr + (z - az) * dz) / len2) : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    qr = ar + t * dr - r; qz = az + t * dz - z;
    d = qr * qr + qz * qz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/* The widest mouth a rim at g can have: the largest radius at the rim's height that is a wall's thickness
   from the rest of the outside. -1 where there is no room. */
function NSO_wheelSoftMouth(pp, g, wall) {
  var cut = NSO_wheelSoftCut(pp, g);
  if (NSO_wheelSoftDist(pp, cut, 0, cut.z) < wall) return -1;
  var lo = 0, hi = cut.r;
  for (var i = 0; i < 26; i++) {
    var mid = 0.5 * (lo + hi);
    if (NSO_wheelSoftDist(pp, cut, mid, cut.z) >= wall) lo = mid; else hi = mid;
  }
  return lo;
}

/* Where along the outside the rim can be widest, and how wide: { g, rho } or null. The mouth is -1 where there is no
   room (too near the base), so on a plate it JUMPS from -1 to its widest at the foot of the edge: a coarse scan finds
   where, the jump is bisected to its edge, and a golden-section pass polishes a smooth peak (a ball's equator). */
function NSO_wheelSoftReach(pp, wall) {
  var lo = pp.iw, hi = pp.n - 1, m = 24, k, g, v, fs = [], gs = [];
  var best = -2, bg = lo;
  function note(gg, vv) { if (vv > best) { best = vv; bg = gg; } }
  for (k = 0; k <= m; k++) {
    g = lo + (hi - lo) * k / m;
    v = NSO_wheelSoftMouth(pp, g, wall);
    gs.push(g); fs.push(v); note(g, v);
  }
  if (!(best > 0)) return null;
  for (k = 1; k <= m; k++) {
    if (fs[k - 1] <= 0 && fs[k] > 0) {
      var ga0 = gs[k - 1], gb0 = gs[k];
      for (var q = 0; q < 28; q++) {
        var gq = 0.5 * (ga0 + gb0);
        if (NSO_wheelSoftMouth(pp, gq, wall) > 0) gb0 = gq; else ga0 = gq;
      }
      note(gb0, NSO_wheelSoftMouth(pp, gb0, wall));
    }
  }
  var kb = Math.round((bg - lo) / (hi - lo) * m);
  var a = gs[Math.max(0, kb - 1)], b = gs[Math.min(m, kb + 1)], gr = 0.6180339887;
  var c = b - gr * (b - a), d = a + gr * (b - a), fc = NSO_wheelSoftMouth(pp, c, wall), fd = NSO_wheelSoftMouth(pp, d, wall);
  note(c, fc); note(d, fd);
  for (k = 0; k < 18; k++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = NSO_wheelSoftMouth(pp, c, wall); note(c, fc); }
    else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = NSO_wheelSoftMouth(pp, d, wall); note(d, fd); }
  }
  g = bg; v = best;
  /* The widest mouth is not always a usable one: on a plate it is at the very foot of the edge, a wall above the
     base, where there is no depth to open. Take the HIGHEST rim that is within 1% of the widest - on a ball that is
     a hair up the dome, on a plate it is the top face. */
  var floorMouth = v * 0.99, ga = g, gb = hi;
  if (NSO_wheelSoftMouth(pp, gb, wall) < floorMouth) {
    for (k = 0; k < 32; k++) {
      var gm = 0.5 * (ga + gb);
      if (NSO_wheelSoftMouth(pp, gm, wall) >= floorMouth) ga = gm; else gb = gm;
    }
    g = ga;
  } else g = gb;
  v = NSO_wheelSoftMouth(pp, g, wall);
  return v > 0 ? { g: g, rho: v } : null;
}

/* The opened piece at one scale of the outside (the wall is not scaled). { outer, inner, rho, rimZ, floorZ } or null. */
function NSO_wheelSoftShape(outerPts, wall, u) {
  var pp = NSO_wheelSoftPrep(outerPts);
  var reach = NSO_wheelSoftReach(pp, wall);
  if (!reach || !(reach.rho > NSO_WHEEL_SOFT_MIN_MOUTH)) return null;
  var rho = u * reach.rho, g = reach.g, i, k;
  if (rho < NSO_WHEEL_SOFT_MIN_MOUTH) return null;
  if (u < 1 - 1e-9) {
    var lo = reach.g, hi = pp.n - 1;
    for (k = 0; k < 34; k++) {
      var mid = 0.5 * (lo + hi);
      if (NSO_wheelSoftMouth(pp, mid, wall) >= rho) lo = mid; else hi = mid;
    }
    g = lo;
  }
  var cut = NSO_wheelSoftCut(pp, g);
  var trunc = [];
  for (i = 0; i <= cut.seg; i++) trunc.push({ z: pp.z[i], r: pp.r[i] });
  trunc.push({ z: cut.z, r: cut.r });
  var zlo = pp.z[0], zl = zlo, zh = cut.z;
  for (k = 0; k < 30; k++) {
    var zm = 0.5 * (zl + zh);
    if (NSO_wheelSoftDist(pp, cut, 0, zm) >= wall) zh = zm; else zl = zm;
  }
  /* How deep: the cavity goes down toward the floor the wall allows faster than the mouth widens (a bottle is a narrow mouth over
     a deep hollow), and how wide it gets below the mouth: it flares out at a slope that grows with u until the wall's own offset
     stops it. Both go to zero with u, so a touch of Open is a thin shallow bore, not a hollow ball behind a pinhole. */
  var nat = zh, full = cut.z - nat, depth = full * Math.pow(u, 0.6), floorZ = cut.z - depth;
  if (!(depth > 0.05)) return null;
  var slope = 2.2 * u;
  var spread = rho + slope * depth;                   // how wide the hollow is at its floor, before the wall stops it
  var zs = [], m = 22, phi;
  for (k = 0; k <= m; k++) {
    phi = (Math.PI / 2) * k / m;
    zs.push(floorZ + depth * (1 - Math.cos(phi)));
    zs.push(floorZ + depth * k / m);
  }
  zs.sort(function (a, b) { return a - b; });
  /* a thumb's ellipsoid at the floor, squaring off into the bowl's own inside as u -> 1 */
  var pw = 2 + 12 * Math.pow(u, 4);
  var inner = [{ z: floorZ, r: 0 }], last = floorZ;
  for (k = 1; k < zs.length; k++) {
    var z = Math.min(zs[k], cut.z);
    if (z <= last + 1e-6) continue;
    var h = (z - floorZ) / depth;
    var dish = spread * Math.pow(Math.max(0, 1 - Math.pow(Math.max(0, 1 - h), pw)), 1 / pw);
    var flare = rho + slope * (cut.z - z);
    var ri = NSO_wheelInnerAt(trunc, z, wall, 22);
    if (ri < 0) ri = 0;
    inner.push({ z: z, r: Math.min(dish, flare, ri) });
    last = z;
  }
  if (inner.length < 3) return null;
  return { outer: trunc, inner: inner, rho: rho, rhoMax: reach.rho, rimZ: cut.z, floorZ: floorZ, depth: cut.z - floorZ };
}

/* Grow the outside by s about the middle of its base. `tall` changes the shape of the growth, not its size: heights
   times sqrt(tall) and radii over sqrt(tall) is a volume-preserving stretch, so tall = 1 is the plain scale and any
   other tall asks for the same clay in a taller (or squatter) vessel. */
function NSO_wheelScaleOuter(outer, s, tall) {
  var z0 = outer[0].z, k = Math.sqrt(tall || 1), sz = s * k, sr = s / k;
  return outer.map(function (q) { return { z: z0 + (q.z - z0) * sz, r: q.r * sr }; });
}

/* How wide a mouth this closed piece could be given, or why not. */
function NSO_wheelOpenReach(piece) {
  if (piece.inner) return { ok: false, reason: 'this piece is already open' };
  var floor = NSO_wheelFloor(piece.nozzle);
  if (piece.wall < floor) {
    return { ok: false, reason: 'a ' + piece.wall.toFixed(3) + ' mm wall is under the ' + floor.toFixed(3) +
      ' mm nozzle floor - nothing opened that thin could be printed' };
  }
  var reach = NSO_wheelSoftReach(NSO_wheelSoftPrep(piece.outer), piece.wall);
  /* a mouth is not enough: the cavity needs a floor a wall above the base AND a rim above that - a plate two walls
     thick has the first and not the second */
  var full = reach && reach.rho > NSO_WHEEL_SOFT_MIN_MOUTH ? NSO_wheelSoftShape(piece.outer, piece.wall, 1) : null;
  if (!full) {
    return { ok: false, reason: 'a ' + piece.wall.toFixed(2) + ' mm wall leaves no room for a mouth in this shape - ' +
      'press it less, or ask for a thinner wall' };
  }
  return { ok: true, rho: reach.rho, mouth: 2 * reach.rho, depth: full.depth };
}

/* OPEN, softly, keeping the clay. opts: u (0..1, default 1). */
function NSO_wheelOpenSoft(piece, opts) {
  opts = opts || {};
  var u = Math.max(0, Math.min(1, typeof opts.u === 'number' ? opts.u : 1));
  var rc = NSO_wheelOpenReach(piece);
  if (!rc.ok) return { ok: false, piece: piece, reason: rc.reason };
  var V0 = NSO_wheelVolume(piece), tgt = V0 * (1 - 1e-7), wall = piece.wall;
  var tall = Math.max(0.25, Math.min(8, typeof opts.tall === 'number' && opts.tall > 0 ? opts.tall : 1));
  function at(s) {
    var sh = NSO_wheelSoftShape(s === 1 && tall === 1 ? piece.outer : NSO_wheelScaleOuter(piece.outer, s, tall), wall, u);
    if (!sh) return null;
    sh.s = s; sh.V = NSO_wheelVolume({ outer: sh.outer, inner: sh.inner });
    return sh;
  }
  var a = at(1);
  /* below a dimple's worth the piece is simply not opened yet - not a refusal, there is just nothing to show */
  if (!a) return { ok: true, piece: piece, u: u, tiny: true, reason: '', budget: NSO_wheelBudget(piece) };
  var best = a;
  if (a.V < tgt) {
    var s0 = 1, e0 = a, s1 = Math.pow(tgt / a.V, 1 / 3), e1 = at(s1), it = 0;
    while (e1 && it < 16) {
      it++;
      best = e1;
      if (e1.V <= V0 && V0 - e1.V < 3e-7 * V0) break;
      var p = Math.log(e1.V / e0.V) / Math.log(s1 / s0);
      if (!(p > 0.3 && p < 8)) p = 3;
      var s2 = s1 * Math.pow(tgt / e1.V, 1 / p);
      if (!(s2 > 0) || s2 > 1e3) break;
      var e2 = at(s2), tries = 0;
      while (!e2 && tries++ < 6) { s2 = 0.5 * (s1 + s2); e2 = at(s2); }
      if (!e2) { e1 = null; break; }
      s0 = s1; e0 = e1; s1 = s2; e1 = e2;
    }
    if (!e1 || best.V > V0) {
      return { ok: false, piece: piece, reason: 'Open could not keep the clay - open less' };
    }
  }
  var cand = {
    outer: NSO_wheelTidy(best.outer), inner: NSO_wheelTidy(best.inner),
    nozzle: piece.nozzle, wall: piece.wall, segments: piece.segments,
    target: piece.target, sizing: piece.sizing,
    budget: { start: piece.budget.start, added: piece.budget.added, trimmed: piece.budget.trimmed },
    ops: piece.ops.concat(['open'])
  };
  var g = NSO_wheelGate(piece, cand, 'Opening');
  if (!g.ok) return g;
  g.u = u; g.s = best.s; g.mouth = 2 * best.rho; g.mouthMax = 2 * best.rhoMax; g.depth = best.depth;
  g.reason = 'Opened ' + (u * 100).toFixed(0) + '% - a ' + g.mouth.toFixed(1) + ' mm mouth, ' + best.depth.toFixed(1) +
    ' mm deep, the shell grown x' + best.s.toFixed(2) + ' to keep the clay';
  return g;
}

/* ------------------------------------------------------------ 7k. PUTTING A PIECE BACK ON THE WHEEL

   A piece that has been baked is just a mesh. If it was a solid of revolution it can be put back: cut it with a plane
   through its axis, and the cut IS the meridian the wheel works with.

     axis      the vertical through the middle of the footprint (the wheel's own pieces have it at x = y = 0)
     the cut   the mesh cut by the half-plane at a handful of angles, each a polyline from the axis at the foot to the axis
               at the top (or the floor). The plane is a hair off any meridian so it passes through the ring vertices
               instead of along their edges - the radii are the mesh's own, not a chord's short of them
     round?    the cuts are laid on top of each other; if the outside differs between angles by more than a few hundredths
               of the radius it is not round, and says by how much and where
     split     a solid is one outline. A vessel is the outside up to the rim and the inside from the floor to the rim; the
               rim is the flat across the top (two points at the top height) or the short chord across the wall at the top
     overhang  both walls must rise: a lip rolled back under itself is a profile the wheel cannot hold, and is refused by name
     rim       the wheel needs a rim as wide as the nozzle floor; a rounded or knife-edge one is cut down to where it is

   The result is a piece with `ops: ['loaded']` and the clay it has, ready to sit under a recipe (NSO_wheelRecipeOn). Pure.
   Round trip on the wheel's own pieces: the outside comes back to within a micron and the volume exactly (the analytic one). */
var NSO_WHEEL_RELATHE_ANGLES = 8;

/* The half-plane cut at angle theta about (cx, cy): the segments of the surface in the plane, as [r0, z0, r1, z1], r >= 0. */
function NSO_wheelCutSegments(tris, cx, cy, theta) {
  var dx = Math.cos(theta), dy = Math.sin(theta), nx = -dy, ny = dx;
  var nT = (tris.length / 9) | 0, segs = [], t, k;
  var X = [0, 0, 0], Y = [0, 0, 0], Z = [0, 0, 0], D = [0, 0, 0];
  for (t = 0; t < nT; t++) {
    var o = t * 9;
    for (k = 0; k < 3; k++) {
      X[k] = tris[o + 3 * k]; Y[k] = tris[o + 3 * k + 1]; Z[k] = tris[o + 3 * k + 2];
      D[k] = (X[k] - cx) * nx + (Y[k] - cy) * ny;
      if (D[k] === 0) D[k] = 1e-12;
    }
    var p0 = D[0] > 0, p1 = D[1] > 0, p2 = D[2] > 0;
    if (p0 === p1 && p1 === p2) continue;
    var pts = [];
    for (k = 0; k < 3; k++) {
      var a = k, b = (k + 1) % 3;
      if ((D[a] > 0) !== (D[b] > 0)) {
        var u = D[a] / (D[a] - D[b]);
        var px = X[a] + u * (X[b] - X[a]), py = Y[a] + u * (Y[b] - Y[a]), pz = Z[a] + u * (Z[b] - Z[a]);
        pts.push((px - cx) * dx + (py - cy) * dy, pz);
      }
    }
    if (pts.length !== 4) continue;
    var s0 = pts[0], z0 = pts[1], s1 = pts[2], z1 = pts[3];
    if (s0 < 0 && s1 < 0) continue;
    if (s0 < 0) { var w0 = (0 - s0) / (s1 - s0); z0 = z0 + w0 * (z1 - z0); s0 = 0; }
    else if (s1 < 0) { var w1 = (0 - s1) / (s0 - s1); z1 = z1 + w1 * (z0 - z1); s1 = 0; }
    segs.push([s0, z0, s1, z1]);
  }
  return segs;
}

/* Join segments end to end into the one outline. Endpoints within `q` of each other are one point (the plane passes a
   hair from the ring vertices, so every vertex is met twice, a few thousandths of a millimetre apart). Returns
   { chain: [{r, z}], covered } - covered is the fraction of the cut's length the chain accounts for - or null. */
function NSO_wheelChainSegments(segs, q) {
  var cell = {}, nodes = [];
  function node(r, z) {
    var ci = Math.floor(r / q), cj = Math.floor(z / q), di, dj, list, i;
    for (di = -1; di <= 1; di++) for (dj = -1; dj <= 1; dj++) {
      list = cell[(ci + di) + ',' + (cj + dj)];
      if (!list) continue;
      for (i = 0; i < list.length; i++) if (Math.abs(list[i].r - r) <= q && Math.abs(list[i].z - z) <= q) return list[i];
    }
    var nd = { r: r, z: z, adj: [], seen: false };
    (cell[ci + ',' + cj] = cell[ci + ',' + cj] || []).push(nd);
    nodes.push(nd);
    return nd;
  }
  var total = 0, i;
  for (i = 0; i < segs.length; i++) {
    var a = node(segs[i][0], segs[i][1]), b = node(segs[i][2], segs[i][3]);
    if (a === b) continue;
    if (a.adj.indexOf(b) < 0) a.adj.push(b);
    if (b.adj.indexOf(a) < 0) b.adj.push(a);
    total += Math.hypot(segs[i][2] - segs[i][0], segs[i][3] - segs[i][1]);
  }
  /* the ends are the nodes with one neighbour; start at the lowest */
  var start = null;
  for (i = 0; i < nodes.length; i++) if (nodes[i].adj.length === 1 && (start === null || nodes[i].z < start.z)) start = nodes[i];
  if (!start) return null;
  var chain = [], cur = start, prev = null, len = 0;
  while (cur) {
    cur.seen = true;
    chain.push({ r: cur.r, z: cur.z });
    var best = null, bestTurn = Infinity;
    for (i = 0; i < cur.adj.length; i++) {
      var nb = cur.adj[i];
      if (nb.seen) continue;
      var turn = 0;
      if (prev) {
        var a1 = Math.atan2(cur.z - prev.z, cur.r - prev.r), a2 = Math.atan2(nb.z - cur.z, nb.r - cur.r);
        turn = Math.abs(a2 - a1); if (turn > Math.PI) turn = 2 * Math.PI - turn;
      }
      if (turn < bestTurn) { bestTurn = turn; best = nb; }
    }
    if (best) len += Math.hypot(best.r - cur.r, best.z - cur.z);
    prev = cur; cur = best;
  }
  return { chain: chain, covered: total > 0 ? len / total : 0 };
}

/* Fewer points on a smooth outline without leaving it by more than `tol`. */
function NSO_wheelSimplify(pts, tol) {
  if (pts.length < 3) return pts;
  var keep = new Array(pts.length), stack = [[0, pts.length - 1]], i;
  for (i = 0; i < pts.length; i++) keep[i] = false;
  keep[0] = keep[pts.length - 1] = true;
  while (stack.length) {
    var seg = stack.pop(), a = pts[seg[0]], b = pts[seg[1]], dmax = 0, imax = -1;
    var dr = b.r - a.r, dz = b.z - a.z, L = Math.hypot(dr, dz);
    for (i = seg[0] + 1; i < seg[1]; i++) {
      var d = L > 0 ? Math.abs((pts[i].r - a.r) * dz - (pts[i].z - a.z) * dr) / L : Math.hypot(pts[i].r - a.r, pts[i].z - a.z);
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > tol && imax > 0) { keep[imax] = true; stack.push([seg[0], imax], [imax, seg[1]]); }
  }
  return pts.filter(function (p, k) { return keep[k]; });
}

/* The outside's radius at height z on a polyline (the largest, where it crosses more than once). */
function NSO_wheelMaxRadiusAt(chain, z) {
  var best = null;
  for (var i = 0; i + 1 < chain.length; i++) {
    var a = chain[i], b = chain[i + 1];
    if ((a.z - z) * (b.z - z) > 0) continue;
    var r = Math.abs(b.z - a.z) < 1e-12 ? Math.max(a.r, b.r) : a.r + (b.r - a.r) * (z - a.z) / (b.z - a.z);
    if (best === null || r > best) best = r;
  }
  return best;
}

/* tris: a flat triangle soup, z up. opts: nozzle, segments, tolerance (mm of roundness allowed, default the larger of
   0.3 mm and 0.6% of the radius). Returns { ok, piece, report } or { ok: false, reason }. */
function NSO_wheelRelathe(tris, opts) {
  opts = opts || {};
  var nT = tris && tris.length ? (tris.length / 9) | 0 : 0, i;
  if (nT < 12) return { ok: false, reason: 'that piece has no surface to read (' + nT + ' triangles)' };
  var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (i = 0; i < tris.length; i += 3) {
    var x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
  }
  var cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2, H = zmax - zmin;
  var rBox = Math.max(xmax - xmin, ymax - ymin) / 2;
  if (!(H > 0.5) || !(rBox > 0.5)) return { ok: false, reason: 'that piece is too small to put on the wheel' };
  var q = Math.max(1e-3, 2e-4 * Math.max(H, 2 * rBox));
  var nAng = NSO_WHEEL_RELATHE_ANGLES, cuts = [], j;
  for (j = 0; j < nAng; j++) {
    var segs = NSO_wheelCutSegments(tris, cx, cy, (2 * Math.PI * j / nAng) + 1e-4 + 0.0137 * j);
    var ch = NSO_wheelChainSegments(segs, q);
    if (!ch || ch.chain.length < 3) return { ok: false, reason: 'its section through the axis is not one clean outline - it is not a single solid of revolution' };
    if (ch.covered < 0.97) return { ok: false, reason: 'its section through the axis is broken into more than one outline (' + Math.round(ch.covered * 100) + '% joined) - a hole through the axis, a second cavity or a loose part is not something the wheel can hold' };
    cuts.push(ch.chain);
  }
  /* round? the outside at 48 heights, every angle against every other */
  var dev = 0, devAt = 0, rMax = 0;
  for (i = 0; i <= 48; i++) {
    var zz = zmin + H * (0.002 + 0.996 * i / 48), lo = Infinity, hi = -Infinity, okAll = true;
    for (j = 0; j < nAng; j++) {
      var rr = NSO_wheelMaxRadiusAt(cuts[j], zz);
      if (rr === null) { okAll = false; break; }
      if (rr < lo) lo = rr; if (rr > hi) hi = rr;
    }
    if (!okAll) continue;
    if (hi > rMax) rMax = hi;
    if (hi - lo > dev) { dev = hi - lo; devAt = zz - zmin; }
  }
  var tol = (typeof opts.tolerance === 'number' && opts.tolerance > 0) ? opts.tolerance : Math.max(0.3, 0.006 * rMax);
  if (dev > tol) {
    return { ok: false, deviation: dev,
      reason: 'it is not round about its vertical axis: the outside differs by ' + dev.toFixed(2) + ' mm between angles ' +
        devAt.toFixed(1) + ' mm up (the wheel allows ' + tol.toFixed(2) + ' mm) - stand it upright, or it is not a thrown shape' };
  }
  /* the section nearest the vertices: the one that encloses the most */
  var bestJ = 0, bestA = -1;
  for (j = 0; j < nAng; j++) {
    var c = cuts[j], area = 0;
    for (i = 0; i + 1 < c.length; i++) area += 0.5 * (c[i].r * c[i + 1].z - c[i + 1].r * c[i].z);
    area = Math.abs(area);
    if (area > bestA) { bestA = area; bestJ = j; }
  }
  var chain = cuts[bestJ];
  var axisTol = Math.max(2 * q, 0.02);
  if (chain[0].r > axisTol || chain[chain.length - 1].r > axisTol) {
    return { ok: false, reason: 'its outline does not meet the axis at both ends - a hole through the middle (a ring or a pipe) is not something the wheel can throw' };
  }
  chain[0].r = 0; chain[chain.length - 1].r = 0;
  if (chain.length > 360) chain = NSO_wheelSimplify(chain, Math.max(0.01, H * 1e-4));

  /* closed, or a vessel? a vessel's outline rises to the rim and comes back down to a floor below it */
  var floor = NSO_wheelFloor(opts.nozzle), n = chain.length, zTop = -Infinity, ztol = Math.max(1e-4, 2e-5 * H);
  for (i = 0; i < n; i++) if (chain[i].z > zTop) zTop = chain[i].z;
  var outer, inner = null, a, b, notes = [];
  if (chain[n - 1].z >= zTop - ztol) {
    outer = chain.slice();
  } else {
    var first = -1, last = -1;
    for (i = 0; i < n; i++) if (chain[i].z >= zTop - ztol) { if (first < 0) first = i; last = i; }
    if (first < last) { a = first; b = last; }                     // a flat across the top: outer ends at a, inner starts at b
    else {                                                         // one point at the top: the chord is the neighbour that spans the wall
      var drPrev = first > 0 ? Math.abs(chain[first].r - chain[first - 1].r) : 0;
      var drNext = first + 1 < n ? Math.abs(chain[first + 1].r - chain[first].r) : 0;
      if (drPrev > drNext) { a = first - 1; b = first; } else { a = first; b = first + 1; }
    }
    if (a < 1 || b > n - 2) return { ok: false, reason: 'it has no wall to speak of - the rim is at the axis' };
    outer = chain.slice(0, a + 1);
    inner = chain.slice(b).reverse();
  }
  /* both walls rise */
  function rises(pr, name) {
    var worst = 0, at = 0, k;
    for (k = 1; k < pr.length; k++) if (pr[k - 1].z - pr[k].z > worst) { worst = pr[k - 1].z - pr[k].z; at = pr[k].z - zmin; }
    if (worst > Math.max(0.05, 1e-3 * H)) {
      return 'the ' + name + ' folds back under itself by ' + worst.toFixed(2) + ' mm at ' + at.toFixed(1) +
        ' mm up - the wheel holds profiles that only rise (no overhang, no curled lip)';
    }
    for (k = 1; k < pr.length; k++) if (pr[k].z < pr[k - 1].z) pr[k].z = pr[k - 1].z;
    return null;
  }
  var bad = rises(outer, 'outside') || (inner && rises(inner, 'inside'));
  if (bad) return { ok: false, reason: bad };
  /* a rim the nozzle can print: as wide as the floor, or cut down to where it is */
  if (inner) {
    var oT = outer[outer.length - 1], iT = inner[inner.length - 1], cutBy = 0;
    if (Math.hypot(oT.r - iT.r, oT.z - iT.z) < floor) {
      var zc = Math.min(oT.z, iT.z), step = Math.max(0.02, H * 0.0005), found = false;
      for (var tries = 0; tries < 400 && zc > inner[0].z + step && zc > outer[0].z + step; tries++) {
        zc -= step;
        var ro = NSO_wheelRadiusAt(outer, zc), ri = NSO_wheelRadiusAt(inner, zc);
        if (ro - ri >= 1.15 * floor) { found = true; break; }          // a margin: the wall is measured across, not along the radius
      }
      if (!found) return { ok: false, reason: 'its rim is thinner than the ' + floor.toFixed(2) + ' mm nozzle floor all the way down - there is no flat to stand a wall on' };
      cutBy = Math.max(oT.z, iT.z) - zc;
      var keepO = outer.filter(function (p) { return p.z < zc - 1e-9; }), keepI = inner.filter(function (p) { return p.z < zc - 1e-9; });
      keepO.push({ z: zc, r: NSO_wheelRadiusAt(outer, zc) });
      keepI.push({ z: zc, r: NSO_wheelRadiusAt(inner, zc) });
      outer = keepO; inner = keepI;
      notes.push('the rim was rounded or sharper than the nozzle floor; cut flat ' + cutBy.toFixed(2) + ' mm down');
    }
  }
  outer = NSO_wheelTidy(outer);
  if (inner) inner = NSO_wheelTidy(inner);
  var piece = {
    outer: outer, inner: inner, nozzle: opts.nozzle, wall: 3, segments: Math.max(12, Math.round(opts.segments || NSO_WHEEL_SEGMENTS)),
    target: null, sizing: null, ops: ['loaded'], budget: { start: 0, added: 0, trimmed: 0 }
  };
  piece.budget.start = NSO_wheelVolume(piece);
  /* the wall it has: the middle of how far each inner point is from the outside (a closed piece: the standard 3 mm) */
  if (inner) {
    var ds = [];
    for (i = 0; i < inner.length; i++) if (inner[i].r > 1e-6) ds.push(NSO_wheelDistToProfile(inner[i].r, inner[i].z, outer));
    ds.sort(function (p, r) { return p - r; });
    if (ds.length) piece.wall = Math.max(floor, ds[Math.floor(ds.length / 2)]);
  } else {
    piece.wall = Math.max(floor, 3);
  }
  var wall = NSO_wheelWall(piece);
  return { ok: true, piece: piece, notes: notes, report: {
    deviation: dev, tolerance: tol, axis: { x: cx, y: cy }, height: H, widest: 2 * rMax, open: !!inner, points: outer.length + (inner ? inner.length : 0),
    volume: piece.budget.start, wall: wall, angles: nAng
  } };
}

function NSO_wheelFirstSentence(reason) {
  var i = reason.indexOf(' - ');
  return i > 0 ? reason.slice(0, i) : reason;
}

/* Build the form a recipe describes. Never refuses a stage that has a smaller
   version of itself: it clamps, and says so. Returns
     { ok, piece, notes: [..], ranges: { thick, open, pull, trim, rim }, ball: <reason> }
   or { ok: false, reason } if there is no ball to start from.               */
function NSO_wheelBuild(recipe) {
  var notes = [], R = {}, piece, ballReason = '';
  if (recipe.base) piece = recipe.base;
  else {
    var b = NSO_wheelBall(recipe.ball || {});
    if (!b.ok) return { ok: false, reason: b.reason };
    piece = b.piece; ballReason = b.reason;
  }
  var floor = NSO_wheelFloor(piece.nozzle);

  /* 1. PRESS */
  if (!piece.inner) {
    var span0 = NSO_wheelSpan(piece.outer);
    var probe = NSO_wheelFlatSolve(NSO_wheelVolume(piece), span0.lo, piece.wall, piece.wall);
    if (probe.ok) {
      R.thick = { min: piece.wall, max: probe.hTop };
      if (recipe.thick != null && recipe.thick < probe.hTop - 1e-6) {
        var f = NSO_wheelFlatten(piece, { height: Math.max(piece.wall, recipe.thick) });
        if (f.ok) piece = f.piece; else notes.push(NSO_wheelFirstSentence(f.reason));
      }
    } else {
      R.thick = { min: 0, max: 0, why: probe.reason };
    }
  } else {
    R.thick = { min: 0, max: 0, why: 'this piece is already open' };
    if (recipe.thick != null) notes.push('Thick: this piece is already open');
  }

  /* 2. OPEN: one soft family from closed (0) to the widest bowl the wall allows (1) */
  if (!piece.inner) {
    var rc = NSO_wheelOpenReach(piece);
    if (rc.ok) {
      R.open = { max: 1, mouth: rc.mouth };
      if (recipe.open > 1e-9) {
        var os = NSO_wheelOpenSoft(piece, { u: NSO_wheelOpenU(recipe.open), tall: recipe.tall || 1 });
        if (os.ok) {
          piece = os.piece;
          if (os.s) R.open.scale = os.s;
          if (recipe.open > 1 + 1e-6) notes.push('Open limited to 100%');
        } else notes.push('Open: ' + NSO_wheelFirstSentence(os.reason));
      }
    } else {
      R.open = { max: 0, why: rc.reason };
      if (recipe.open > 1e-9) notes.push('Open: ' + NSO_wheelFirstSentence(rc.reason));
    }
  } else {
    R.open = { max: 0, why: 'already open' };
  }

  R.tall = { min: 0.5, max: 4 };
  if (recipe.base && recipe.base.inner) R.tall.why = 'this piece is already open - Tall shapes how a ball opens';
  else if (!(recipe.open > 1e-9 && piece.inner && piece.ops.indexOf('open') >= 0)) R.tall.why = 'Tall shapes how the piece opens - raise Open first';

  /* 2b. LIP: the edge of a pressed plate lifted into a rim. A plate that is open is
     not a plate, so Lip stands down for Deep (the slider says so). */
  var lp = recipe.lip || {};
  if (piece.inner) {
    R.lip = { max: 0, why: 'an opened piece has no flat plate to lift - Lip is for plates (Deep 0)' };
    if (lp.h > 1e-9) notes.push('Lip: an opened piece has no flat plate to lift');
  } else if (!piece.press) {
    R.lip = { max: 0, why: 'press the ball into a plate first (drag Thick down)' };
    if (lp.h > 1e-9) notes.push('Lip: press the ball into a plate first');
  } else if (!(piece.press.c >= piece.press.h)) {
    R.lip = { max: 0, why: 'this is a thick bulge, not a plate - press it flatter' };
    if (lp.h > 1e-9) notes.push('Lip: press it flatter - this is a bulge, not a plate');
  } else {
    var lipMax = Math.max(1, NSO_wheelStep((piece.press.c + piece.press.e) * 0.5, 0.5, false));
    R.lip = { max: lipMax };
    if (lp.h > 1e-9) {
      var lr = NSO_wheelLip(piece, { height: Math.min(lp.h, lipMax), at: lp.at, flare: lp.flare, clamp: true });
      if (lr.ok) {
        piece = lr.piece;
        if (lr.clamped) notes.push('Lip limited to ' + lr.rise.toFixed(1) + ' mm - the rim cannot lean further over this length');
        if (lr.lengthened) notes.push('Flare lengthened so the top face does not fold');
      } else notes.push(NSO_wheelFirstSentence(lr.reason));
    }
  }

  /* 3. PULL (one or several) */
  var sp = NSO_wheelSpan(piece.outer), rMax = 0, i;
  for (i = 0; i < piece.outer.length; i++) if (piece.outer[i].r > rMax) rMax = piece.outer[i].r;
  R.pull = { swing: Math.max(5, NSO_wheelStep(rMax / 2, 0.5, false)), slots: NSO_WHEEL_MAX_PULLS };
  for (var slot = 0; slot < NSO_WHEEL_MAX_PULLS; slot++) {
    var pl = NSO_wheelPullSlot(recipe, slot, false);
    if (!(Math.abs(pl.dr || 0) > 1e-9)) continue;
    var sp2 = NSO_wheelSpan(piece.outer);
    var pz = sp2.lo + (pl.z == null ? 0.5 : pl.z) * (sp2.hi - sp2.lo);
    var pw = Math.max(1, (pl.wide == null ? 0.4 : pl.wide) * (sp2.hi - sp2.lo));
    /* the Smooth neck's own curve (Tube Edge), with the wall sampled finely enough to draw it */
    var pr = NSO_wheelPullClamped(piece, { z: pz, dr: pl.dr, taper: pw, kernel: 'cosine', refine: true });
    var tag = slot > 0 ? 'Pull ' + (slot + 1) + ': ' : '';
    if (pr.ok) { piece = pr.piece; if (pr.clamped) notes.push(tag + pr.reason); }
    else notes.push(tag + NSO_wheelFirstSentence(pr.reason));
  }

  /* 4. TRIM */
  var ts = NSO_wheelSpan(piece.outer);
  var tmax = piece.inner ? piece.inner[0].z - floor - 0.1 : ts.hi - floor - 0.1;
  R.trim = { max: Math.max(0, tmax - ts.lo) };
  if (recipe.trim > 1e-9) {
    var zt = Math.min(ts.lo + recipe.trim, tmax);
    if (zt > ts.lo + 1e-6) {
      var t = NSO_wheelTrim(piece, { z: zt });
      if (t.ok) {
        piece = t.piece;
        if (ts.lo + recipe.trim > tmax + 1e-6) notes.push('Trim limited to ' + (tmax - ts.lo).toFixed(1) + ' mm');
      } else notes.push(NSO_wheelFirstSentence(t.reason));
    } else notes.push('Trim: nothing to take off the base');
  }

  /* 5. RIM + */
  R.rim = { max: 60 };
  if (recipe.rim > 1e-9) {
    var rm = NSO_wheelExtendRim(piece, { delta: recipe.rim });
    if (rm.ok) piece = rm.piece;
    else notes.push('Rim + needs a straight wall' + (/best run is ([\d.]+) mm/.test(rm.reason) ? ' (the best run is ' + /best run is ([\d.]+) mm/.exec(rm.reason)[1] + ' mm)' : ''));
  }
  return { ok: true, piece: piece, notes: notes, ranges: R, ball: ballReason };
}

/* ------------------------------------------------------------ 7h. THE WHITE EDGE
   The selected piece wears a white edge (app-sel-outline.js) built from the angles
   between its triangles, and a smooth piece has none sharper than 15 degrees - a
   thrown ball, a pressed disc, a rounded bowl have NOTHING to draw, which is why the
   edge came and went as the sliders moved the shape between creased and smooth. A
   revolved piece knows its own profile, so the helper is drawn from that instead:

     rings       at every crease of the profile (a turn of more than 9 degrees), at
                 both ends of each wall, and a few evenly spaced along the smooth
                 parts, so a curve reads as a curve
     meridians   eight lines round the piece (every 45 degrees), up the outside and
                 down the inside

   in the geometry's own frame: x, z about its centre, y up from its bottom. `frame`
   is { cx, cz, y0 } - the display geometry's bounding box. Pure, so it is tested. */
var NSO_WHEEL_GUIDE_TURN = 9;      // degrees: a corner of the profile
var NSO_WHEEL_GUIDE_SMOOTH = 5;    // evenly spaced rings on the smooth stretches
var NSO_WHEEL_GUIDE_MERIDIANS = 8;

function NSO_wheelGuideLines(piece, frame) {
  var n = Math.max(12, piece.segments || NSO_WHEEL_SEGMENTS);
  var zLo = NSO_wheelSpan(piece.outer).lo;
  var out = [];
  function pt(r, z, k) {
    var th = 2 * Math.PI * k / n;
    return [frame.cx + r * Math.cos(th), frame.y0 + (z - zLo), frame.cz - r * Math.sin(th)];
  }
  function seg(a, b) { out.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
  function ring(r, z) {
    if (!(r > 1e-6)) return;
    for (var k = 0; k < n; k++) seg(pt(r, z, k), pt(r, z, (k + 1) % n));
  }
  function meridian(chain, k) {
    for (var i = 0; i + 1 < chain.length; i++) {
      var a = chain[i], b = chain[i + 1];
      if (a.r < 1e-9 && b.r < 1e-9) continue;
      seg(pt(a.r, a.z, k), pt(b.r, b.z, k));
    }
  }
  var chains = [piece.outer];
  if (piece.inner && piece.inner.length > 1) chains.push(piece.inner);

  chains.forEach(function (chain) {
    if (!chain || chain.length < 2) return;
    var want = {}, i;
    want[0] = true; want[chain.length - 1] = true;
    /* creases: where the direction of the profile turns */
    for (i = 1; i + 1 < chain.length; i++) {
      var ax = chain[i].r - chain[i - 1].r, az = chain[i].z - chain[i - 1].z;
      var bx = chain[i + 1].r - chain[i].r, bz = chain[i + 1].z - chain[i].z;
      var la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 1e-9 || lb < 1e-9) continue;
      var c = (ax * bx + az * bz) / (la * lb);
      if (Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI > NSO_WHEEL_GUIDE_TURN) want[i] = true;
    }
    /* a few evenly spaced along the length, so a smooth curve still shows its shape */
    var cum = [0];
    for (i = 1; i < chain.length; i++) cum.push(cum[i - 1] + Math.hypot(chain[i].r - chain[i - 1].r, chain[i].z - chain[i - 1].z));
    var L = cum[cum.length - 1];
    if (L > 1e-9) {
      for (var j = 1; j <= NSO_WHEEL_GUIDE_SMOOTH; j++) {
        var target = L * j / (NSO_WHEEL_GUIDE_SMOOTH + 1), best = 1;
        for (i = 1; i + 1 < chain.length; i++) if (Math.abs(cum[i] - target) < Math.abs(cum[best] - target)) best = i;
        want[best] = true;
      }
    }
    var lastR = -1, lastZ = -1;
    Object.keys(want).map(Number).sort(function (p, q) { return p - q; }).forEach(function (idx) {
      var q = chain[idx];
      if (Math.abs(q.r - lastR) < 1e-6 && Math.abs(q.z - lastZ) < 1e-6) return;   // the same ring twice
      ring(q.r, q.z); lastR = q.r; lastZ = q.z;
    });
  });
  var step = n / NSO_WHEEL_GUIDE_MERIDIANS;
  for (var m = 0; m < NSO_WHEEL_GUIDE_MERIDIANS; m++) {
    var k = Math.round(m * step);
    chains.forEach(function (chain) { meridian(chain, k); });
  }
  return new Float32Array(out);
}

/* Make a geometry wear this piece's guide lines (the hook app-sel-outline.js reads). */
function NSO_wheelWear(geo, piece) {
  if (!geo || !piece) return;
  geo.userData = geo.userData || {};
  geo.userData.nsoEdges = function (g) {
    if (!g.boundingBox) g.computeBoundingBox();
    var bb = g.boundingBox;
    return NSO_wheelGuideLines(piece, { cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, y0: bb.min.y });
  };
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
  if (typeof NSO_sculptCommitRaw !== 'function') return false;
  var done = NSO_sculptCommitRaw(m, working, 'wheelReplace', statusText);
  /* The commit throws the piece's mesh away and builds a new one, and the white
     edge on the selected piece is a child of the OLD mesh - so without this it
     went off at every release until the piece was selected again. */
  if (done !== false) NSO_wheelOutline(m);
  return done;
}

/* Put the selected piece's white edge back on whatever geometry its mesh wears now,
   drawn from the piece's own profile (section 7h) - on a smooth piece the house
   crease rule has nothing to draw. `piece` defaults to the wheel's. Forces a rebuild
   when the geometry already carried an outline (one made before it wore its lines). */
function NSO_wheelOutline(m, piece) {
  if (typeof refreshOutline !== 'function' || typeof state === 'undefined' || !state || !state.placed || !m) return;
  piece = piece || NSO_wheelSession;
  for (var i = 0; i < state.placed.length; i++) {
    var e = state.placed[i];
    if (!e || e.sourceId !== m.id) continue;
    var g = e.mesh && e.mesh.geometry;
    if (g && piece) {
      var had = g.userData && typeof g.userData.nsoEdges === 'function';
      NSO_wheelWear(g, piece);
      if (!had && e.outline) {
        if (e.outline.parent) e.outline.parent.remove(e.outline);
        if (e.outline.geometry) e.outline.geometry.dispose();
        if (e.outline.material) e.outline.material.dispose();
        e.outline = null;
        if (typeof NSO_Outline !== 'undefined' && NSO_Outline.forget) NSO_Outline.forget(g);
      }
    }
    refreshOutline(e);
    return;
  }
}

/* The live session. One thrown piece at a time, held here rather than on the
   model, because the profile is the wheel's state and the model only ever
   sees the revolved result. */
var NSO_wheelSession = null;

/* WHERE THE SESSION LIVES. The profile above is the wheel's state; this is
   the piece on the plate it belongs to. A thrown piece is a piece of its own
   (Ball drops one, the way Stock does), and every move after it acts on THAT
   piece - never on whatever happens to be selected, which is how a move used
   to bake the wheel's form onto an unrelated piece.

     modelId  the piece the wheel threw
     history  the form the wheel held after each step, with the triangles it
              wrote for it: { piece, soup }, oldest first

   Undo puts a piece's triangles back by reference, so "is the piece still
   what the wheel last wrote?" is an identity test on `soup`. If Undo took it
   back to an earlier step the session rewinds to that step; if something else
   changed it (another tool, a Scale), the session ENDS rather than overwrite
   that work - Stock's rule (docs/handoff/stock-live-editing-...).            */
var NSO_wheelHome = null;

/* The live sliders (app-wheel-live.js) register themselves here: `end` drops any
   preview (so a real move, a new ball or an Undo-sync is never drawn over a
   preview that has moved on) and `refresh` re-reads every slider's range from
   the piece. Absent in the headless suites, so every call is guarded. */
var NSO_wheelUI = null;
function NSO_wheelLiveEnd() {
  if (NSO_wheelUI && typeof NSO_wheelUI.end === 'function') NSO_wheelUI.end();
}
function NSO_wheelUiRefresh() {
  if (NSO_wheelUI && typeof NSO_wheelUI.refresh === 'function') NSO_wheelUI.refresh();
}

function NSO_wheelSay(msg, bad) {
  if (typeof setStatus === 'function') setStatus(msg, !!bad);
}

function NSO_wheelModel() {
  if (!NSO_wheelHome || typeof state === 'undefined' || !state || !state.models) return null;
  var id = NSO_wheelHome.modelId;
  return state.models.find(function (x) { return x && x.id === id; }) || null;
}

function NSO_wheelEnd(why) {
  NSO_wheelSession = null;
  NSO_wheelHome = null;
  NSO_wheelSay(why, true);
  return { ok: false, reason: why, ended: true };
}

/* Is the piece on the plate still the form the wheel holds? Rewinds to an
   earlier step after an Undo; ends the session if the piece was changed by
   anything else or is gone. Returns { ok, model } or a refusal (status set). */
function NSO_wheelSync() {
  if (!NSO_wheelSession || !NSO_wheelHome) {
    NSO_wheelSay('Nothing on the wheel - throw a ball first', true);
    return { ok: false, reason: 'no session' };
  }
  var m = NSO_wheelModel();
  if (!m) {
    return NSO_wheelEnd('The piece on the wheel is gone - throw a new ball to start again');
  }
  var h = NSO_wheelHome.history;
  if (h[h.length - 1].soup !== m.rawTris) {
    var i = h.length - 2;
    while (i >= 0 && h[i].soup !== m.rawTris) i--;
    if (i < 0) {
      return NSO_wheelEnd('Wheel stood down - ' + (m.name || 'the piece') + ' was changed by something ' +
        'other than the wheel since it was last thrown, and the wheel will not overwrite that. ' +
        'Throw a new ball to start again.');
    }
    NSO_wheelHome.history = h.slice(0, i + 1);   // Undo took it back to here
    NSO_wheelSession = h[i].piece;
    NSO_wheelHome.recipe = h[i].recipe || NSO_wheelRecipeOn(h[i].piece);
  }
  return { ok: true, model: m };
}

/* Select the wheel's own piece, so what the move is about to change is what
   the person is looking at. */
function NSO_wheelSelect(m) {
  if (typeof state === 'undefined' || !state.placed || typeof selectPlaced !== 'function') return;
  var idx = -1;
  for (var i = 0; i < state.placed.length; i++) {
    if (state.placed[i] && state.placed[i].sourceId === m.id) { idx = i; break; }
  }
  /* The slot AND the edit target: the rest of the UI acts on the active model,
     which can be a different piece from the selected slot. */
  var active = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (idx >= 0 && (state.selectedIndex !== idx || active !== m)) selectPlaced(idx);
}

function NSO_wheelNextName() {
  var top = 0;
  ((typeof state !== 'undefined' && state.models) || []).forEach(function (m) {
    var hit = m && /^Wheel (\d+)$/.exec(m.name || '');
    if (hit) top = Math.max(top, parseInt(hit[1], 10));
  });
  return 'Wheel ' + (top + 1);
}

/* Put the ball on the plate as a piece of its own - Stock's drop, step for
   step: added silently (the selection is moved below), ONE 'addModels' Undo
   entry (so Undo takes the whole piece off again), placed in the nearest free
   spot to the middle of the plate, selected. */
function NSO_wheelDrop(soup) {
  if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
    NSO_wheelSay('The wheel needs the viewport', true);
    return { ok: false, reason: 'no ingest path' };
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
  var name = NSO_wheelNextName();
  var editBefore = state.editId, cutBefore = state.cutT;
  var id = addModelFromZUpGeometry(name, g, { keepSelection: true, silent: true });
  if (id == null) {
    NSO_wheelSay('The wheel refused - the new piece looked empty', true);
    return { ok: false, reason: 'addModel refused' };
  }
  var made = state.models.find(function (x) { return x && x.id === id; });
  if (typeof pushUndo === 'function') pushUndo({ type: 'addModels', ids: [id], editId: editBefore, cutT: cutBefore });
  var want = { x: 0, z: 0 };
  var entry = (typeof placeModelMovable === 'function') ? placeModelMovable(made, want.x, want.z) : null;
  var at = { x: want.x, z: want.z, onBed: true };
  if (entry && typeof nsoFreeSpot === 'function') at = nsoFreeSpot(entry, want);
  if (entry && typeof applyPlacedXZ === 'function') applyPlacedXZ(entry, at.x, at.z);
  var idx = entry ? state.placed.indexOf(entry) : -1;
  if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
  if (typeof renderModelList === 'function') renderModelList();
  if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
  if (typeof updateEditSize === 'function') updateEditSize();
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
  return { ok: true, model: made, modelId: id, name: name, onBed: at.onBed !== false };
}

/* BALL: a new piece on the plate and a fresh session on it. Needs no selected
   piece and no size - and the session only exists once the piece does, so a
   refusal can never leave the wheel holding a form for nothing. */
function NSO_wheelThrow(opts, head) {
  NSO_wheelLiveEnd();
  /* A recipe of its own (the sliders' settings) or the plain ball of `opts`. */
  var recipe = (opts && opts.recipe) ? NSO_wheelCloneRecipe(opts.recipe) : NSO_wheelNewRecipe(opts);
  var b = NSO_wheelBuild(recipe);
  if (!b.ok) {
    NSO_wheelSay(b.reason, true);
    return { ok: false, reason: b.reason, piece: null };
  }
  var soup = NSO_wheelRevolve(b.piece);
  var d = NSO_wheelDrop(soup);
  if (!d.ok) return d;
  NSO_wheelSession = b.piece;
  NSO_wheelHome = { modelId: d.modelId, name: d.name, recipe: recipe,
                    history: [{ piece: b.piece, soup: d.model.rawTris, recipe: recipe }] };
  NSO_wheelRemember(d.model);
  NSO_wheelOutline(d.model, b.piece);     // the ball was selected on its way in, before it wore its own lines
  var line = NSO_wheelStatus(b.piece, 'Dropped ' + d.name + ' - ' + (b.ball || head || 'Ball'));
  if (b.notes.length) line += ' - ' + b.notes.join('; ');
  if (!d.onBed) line += ' - the plate has no free room left, it sits past the edge';
  NSO_wheelSay(line, !d.onBed);
  NSO_wheelUiRefresh();
  return { ok: true, piece: b.piece, reason: b.ball, recipe: recipe, notes: b.notes, modelId: d.modelId, name: d.name };
}

function NSO_wheelStatus(piece, head) {
  var bud = NSO_wheelBudget(piece);
  var line = head + ' - ' + NSO_wheelHeightOf(piece).toFixed(1) + ' mm tall, ' +
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
  var size = { x: 2 * rMax, y: 2 * rMax, z: NSO_wheelHeightOf(piece) };
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

/* Bake whatever is on the wheel onto the wheel's own piece. */
function NSO_wheelBake(head) {
  if (!NSO_wheelSession || !NSO_wheelHome) {
    NSO_wheelSay('Nothing on the wheel - throw a ball first', true);
    return { ok: false, reason: 'no session' };
  }
  var m = NSO_wheelModel();
  if (!m) return NSO_wheelEnd('The piece on the wheel is gone - throw a new ball to start again');
  var soup = NSO_wheelRevolve(NSO_wheelSession);
  var done = NSO_wheelCommit(m, soup, NSO_wheelStatus(NSO_wheelSession, head));
  if (done === false) {
    NSO_wheelSay('Pottery Wheel could not update the piece - unchanged', true);
    return { ok: false, reason: 'commit failed' };
  }
  NSO_wheelHome.history.push({ piece: NSO_wheelSession, soup: m.rawTris, recipe: NSO_wheelHome.recipe });
  NSO_wheelRemember(m);
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
    /* Ball starts a session and a piece of its own; it needs neither a
       selection nor a size. */
    if (move === 'ball') return NSO_wheelThrow(opts, head);

    var sync = NSO_wheelSync();
    if (!sync.ok) return sync;
    var target = sync.model;
    NSO_wheelSelect(target);
    var paint = NSO_wheelPaintOk(target, 'the wheel');
    if (!paint.ok) return paint;

    /* Any live preview is over: this is the real thing. */
    NSO_wheelLiveEnd();
    var base = NSO_wheelBaseOf(NSO_wheelSession, NSO_wheelHome.history, move);
    var r = NSO_wheelApply(move, base, opts);
    if (!r.ok) {
      NSO_wheelSay(r.reason, true);
      return r;
    }
    /* The move's own reason is the status line - it carries the numbers the
       potter needs (what was opened, what was trimmed, what Extend held) and
       NSO_wheelStatus appends the height, the budget and, when it fires, the
       build-volume warning. The caller's `head` is only a fallback. The
       session only advances if the piece took the bake. */
    var prev = NSO_wheelSession, prevRecipe = NSO_wheelHome.recipe;
    NSO_wheelSession = r.piece;
    /* A strict move (the API, the headless suites) BAKES: what it made is the
       new starting point and every slider goes back to neutral on top of it. The
       sliders themselves never come through here (NSO_wheelSetRecipe). */
    NSO_wheelHome.recipe = (move === 'reball') ? NSO_wheelNewRecipe(opts) : NSO_wheelRecipeOn(r.piece);
    var b = NSO_wheelBake(r.reason || head);
    if (!b.ok) {
      if (NSO_wheelSession === r.piece) NSO_wheelSession = prev;
      NSO_wheelHome.recipe = prevRecipe;
      return b;
    }
    NSO_wheelUiRefresh();
    return r;
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[wheel]', err);
    NSO_wheelSay('Pottery Wheel failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

/* THE SLIDERS' COMMIT. Build the recipe, put the result on the wheel's piece as
   one Undo step, and keep the RECIPE: nothing is baked, so every slider stays
   live and the next drag starts from the ball again. The status line says what
   the piece is and what, if anything, a limit held back. */
function NSO_wheelSameProfile(a, b) {
  function same(p, q) {
    if (!p && !q) return true;
    if (!p || !q || p.length !== q.length) return false;
    for (var i = 0; i < p.length; i++) if (Math.abs(p[i].z - q[i].z) > 1e-9 || Math.abs(p[i].r - q[i].r) > 1e-9) return false;
    return true;
  }
  return !!a && !!b && same(a.outer, b.outer) && same(a.inner, b.inner);
}

function NSO_wheelSetRecipe(recipe, head) {
  try {
    NSO_wheelLiveEnd();
    var sync = NSO_wheelSync();
    if (!sync.ok) return sync;
    var target = sync.model;
    NSO_wheelSelect(target);
    var paint = NSO_wheelPaintOk(target, 'the wheel');
    if (!paint.ok) return paint;
    var b = NSO_wheelBuild(recipe);
    if (!b.ok) { NSO_wheelSay(b.reason, true); return { ok: false, reason: b.reason, piece: NSO_wheelSession }; }
    var prev = NSO_wheelSession, prevRecipe = NSO_wheelHome.recipe;
    /* A slider that changed nothing about the shape (Pull at with Pull at 0 mm, Tall before Open, a limit that held the
       same value) is not an edit: the recipe is kept, the piece and its Undo history are left alone - and a loaded mesh
       stays the mesh it was, not its re-lathe, until something really moves. */
    if (NSO_wheelSameProfile(prev, b.piece)) {
      NSO_wheelHome.recipe = NSO_wheelCloneRecipe(recipe);
      var hh = NSO_wheelHome.history;
      hh[hh.length - 1].recipe = NSO_wheelHome.recipe;
      NSO_wheelRemember(NSO_wheelModel());
      NSO_wheelUiRefresh();
      return { ok: true, piece: prev, notes: b.notes, ranges: b.ranges, recipe: NSO_wheelHome.recipe, unchanged: true };
    }
    NSO_wheelSession = b.piece;
    NSO_wheelHome.recipe = NSO_wheelCloneRecipe(recipe);
    var bake = NSO_wheelBake((head || 'On the wheel') + (b.notes.length ? ' - ' + b.notes.join('; ') : ''));
    if (!bake.ok) {
      NSO_wheelSession = prev; NSO_wheelHome.recipe = prevRecipe;
      return bake;
    }
    NSO_wheelUiRefresh();
    return { ok: true, piece: b.piece, notes: b.notes, ranges: b.ranges, recipe: NSO_wheelHome.recipe };
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[wheel]', err);
    NSO_wheelSay('Pottery Wheel failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
    return { ok: false, reason: (err && err.message) || String(err) };
  }
}

/* WHAT THE PIECE REMEMBERS. The model carries the recipe that made it and the soup the wheel wrote, so that putting it back
   on the wheel later - after the menu was closed, or another piece was thrown - restores EVERY slider, not just a mesh. It is
   only believed while the model's triangles are still the ones the wheel wrote (identity): if anything else touched the piece,
   or Undo moved it, the memo is ignored and the piece is read from its mesh instead. Not saved with a project (a reloaded piece
   is a mesh, and is read as one). */
function NSO_wheelRemember(m) {
  if (!m || !NSO_wheelHome || !NSO_wheelSession) return;
  m.wheelMemo = { recipe: NSO_wheelCloneRecipe(NSO_wheelHome.recipe), piece: NSO_wheelSession, soup: m.rawTris };
}

/* PUT A PIECE ON THE WHEEL. The piece that is on the plate (not a new one): if it still wears the memo of the wheel that
   made it, its whole recipe comes back; otherwise it is read as a solid of revolution (NSO_wheelRelathe) and the wheel starts a
   recipe on top of what it is - Pull, Trim, Rim + and the rest work on it; Flatten / Open / Tall are for a ball and say so.
   Nothing on the plate changes until the first slider moves (then it is one Undo step, like any other). */
function NSO_wheelPutOn(m) {
  try {
    NSO_wheelLiveEnd();
    if (!m) {
      NSO_wheelSay('Select a piece to put on the wheel', true);
      return { ok: false, reason: 'nothing selected' };
    }
    if (NSO_wheelHome && NSO_wheelHome.modelId === m.id && NSO_wheelSession) {
      var sy = NSO_wheelSync();
      if (sy.ok) { NSO_wheelSay((m.name || 'The piece') + ' is already on the wheel', false); return { ok: true, already: true, piece: NSO_wheelSession }; }
    }
    var paint = NSO_wheelPaintOk(m, 'the wheel');
    if (!paint.ok) return paint;
    if (!m.rawTris || !m.rawTris.length) {
      NSO_wheelSay((m.name || 'That piece') + ' has no triangle data the wheel can read', true);
      return { ok: false, reason: 'no rawTris' };
    }
    var piece, recipe, how, notes = [], rep = null, memo = m.wheelMemo;
    if (memo && memo.soup === m.rawTris && memo.piece && memo.recipe) {
      piece = memo.piece; recipe = NSO_wheelCloneRecipe(memo.recipe); how = 'its recipe remembered';
    } else {
      var rl = NSO_wheelRelathe(m.rawTris);
      if (!rl.ok) {
        NSO_wheelSay((m.name || 'That piece') + ' cannot go on the wheel - ' + rl.reason, true);
        return rl;
      }
      piece = rl.piece; recipe = NSO_wheelRecipeOn(piece); notes = rl.notes; rep = rl.report;
      how = 'read from its mesh (round to ' + rl.report.deviation.toFixed(2) + ' mm)';
    }
    NSO_wheelSession = piece;
    NSO_wheelHome = { modelId: m.id, name: m.name, recipe: recipe, history: [{ piece: piece, soup: m.rawTris, recipe: recipe }] };
    NSO_wheelSelect(m);
    NSO_wheelOutline(m, piece);
    var line = NSO_wheelStatus(piece, 'Put ' + (m.name || 'the piece') + ' on the wheel - ' + how);
    if (notes.length) line += ' - ' + notes.join('; ');
    var wl = rep && rep.wall;
    if (wl && !wl.pass) line += ' - its ' + wl.thinnest + ' is ' + wl.min_mm.toFixed(2) + ' mm, under the ' + wl.threshold_mm.toFixed(2) + ' mm nozzle floor: edits that touch it will be refused until it is thicker';
    if (!memo || memo.soup !== m.rawTris) line += ' - Pull, Trim and Rim + work on it; Flatten, Open and Tall are for a fresh ball';
    NSO_wheelSay(line, false);
    NSO_wheelUiRefresh();
    return { ok: true, piece: piece, recipe: recipe, how: how, notes: notes, report: rep, modelId: m.id };
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[wheel]', err);
    NSO_wheelSay('Pottery Wheel failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
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
      /* The only button that is not a slider's own preset (app-wheel-live.js):
         the Starter Ball. No height, no selection, no nozzle - the standard ball
         dropped as a piece of its own; Scale and W size it. */
      on('btn-wheel-load', function () {
        NSO_wheelPutOn((typeof getActiveModel === 'function') ? getActiveModel() : null);
      });
      on('btn-wheel-ball', function () {
        NSO_wheelRun('ball', {
          ballRadius: num('rng-wheel-scale', undefined),
          wall: num('rng-wheel-wall', undefined)
        }, 'Ball centred');
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
