/* nso_stock.js - new stock: a correctly-sized primitive to start from.

   Loads as a classic script (window.NSO_Stock) and as a Node module
   (require('../nso_stock.js')). No DOM, no Three.js, no app state - the same
   rule nso_printer.js and nso_thickness.js follow, and the reason this file
   can be the one place the arithmetic lives.

   ---------------------------------------------------------------------------
   WHAT THIS IS, AND WHERE IT CAME FROM
   ---------------------------------------------------------------------------
   The Pottery Wheel's first move is BALL: work out how much clay a target
   vessel actually needs, add a real waste margin, and hand back a sphere of
   exactly that volume. The arithmetic in that move was never about spheres.
   It is:

       target dimensions  ->  estimated shell / material volume
                          ->  + waste margin
                          ->  solve for the primitive's defining measurement

   and only the last arrow knows what shape is being made. So the first two
   arrows live here, shape-agnostic, and the third is one closed form per
   shape. app-wheel.js keeps BALL - it calls size() with shape 'sphere' and
   carries no copy of the sizing.

   Every other tool that starts from a blank block - Carve, Hollow, auto-aim
   support, Skin, a Join against a solid - wants the same thing and had
   nowhere to get it. That is what this is for: one "new stock" step before
   any of them, with the stock sized for the job rather than eyeballed.

   ---------------------------------------------------------------------------
   THE ESTIMATE IS PAPPUS, AND IT IS THE SAME ESTIMATE
   ---------------------------------------------------------------------------
   The target is approximated as a THIN SHELL: a wall of thickness t swept
   along the meridian, plus a floor of the same thickness. Pappus's second
   theorem gives a solid of revolution's volume as 2*pi*rho*A, where A is the
   generating region's area in the half-plane and rho its centroid radius:

     wall strip   A = H*t,  rho = R - t/2   ->  V = 2*pi*(R - t/2)*(H*t)
     floor rect   r in [0, R], z in [0, t]: rho = R/2, A = R*t
                  ->  V = 2*pi*(R/2)*(R*t) = pi*R^2*t, the disc it should be

   One theorem, both parts, and the floor's closed form falls out rather than
   being written down separately. This is the wheel's arithmetic moved, not
   re-derived: tools/nso_stock_test.js pins the numbers against the figures
   docs/POTTERY-WHEEL.md published before the move.

   THE TARGET IS DESCRIBED AS A HEIGHT AND A RADIUS whatever shape the stock
   is, because that is what the shell estimate takes. Its bounding box is
   therefore 2R x 2R x H, and that is the box the build-volume gate checks.

   ---------------------------------------------------------------------------
   SOLVING FOR THE DEFINING MEASUREMENT - one closed form per shape
   ---------------------------------------------------------------------------
   With `need` mm^3 of stock to make:

     sphere     need = 4/3 pi a^3            ->  a = cbrt(3*need / (4*pi))
     box        sides in proportion x:y:z, scale s
                need = s^3 * x*y*z           ->  s = cbrt(need / (x*y*z))
     cylinder   ratio k = height / diameter, so h = 2*k*r
                need = pi r^2 h = 2 pi k r^3 ->  r = cbrt(need / (2*pi*k))
     cone       k as above, taper t = rTop / r (0 is a true point, t < 1)
                need = (2 pi k / 3)(1+t+t^2) r^3
                                             ->  r = cbrt(3*need / (2*pi*k*(1+t+t^2)))
     tube       k as above, wall fraction w of the outer radius, 0 < w < 1
                need = 2 pi k (1-(1-w)^2) r^3
                                             ->  r = cbrt(need / (2*pi*k*(1-(1-w)^2)))
     torus      tube ratio q = a / R, 0 < q < 1
                need = 2 pi^2 R a^2 = 2 pi^2 q^2 R^3
                                             ->  R = cbrt(need / (2*pi^2*q^2))
     capsule    k as above but strictly > 1; barrel 2r(k-1) plus two caps
                need = 2 pi (k - 1/3) r^3    ->  r = cbrt(need / (2*pi*(k - 1/3)))
     ellipsoid  k as above; semi-axes r, r, c with c = k r
                need = 4/3 pi k r^3          ->  r = cbrt(3*need / (4*pi*k))

   EVERY ONE IS EXACT, which is worth saying plainly: the primitive's analytic
   volume IS `need`, to the last bit the cube root allows, and the self-test
   asserts that per shape rather than trusting the algebra. That exactness is
   the entry fee for being in this list at all - see the audit in docs/STOCK.md
   for the shapes that cannot pay it and are deferred rather than approximated.

   ---------------------------------------------------------------------------
   WHERE THE SECOND MEASUREMENT COMES FROM
   ---------------------------------------------------------------------------
   Five shapes take a HEIGHT OVER A DIAMETER, and all five read it the same
   way, through ratioFor(): explicit `opts.ratio`, then a reference piece, then
   the target's own height over its own diameter. A box's second measurement is
   three numbers rather than one and keeps its own copy of that order.

   Three second measurements are NOT a height over a diameter and take a stated
   default instead of the target's proportions, because the target has nothing
   to say about them: a cone's `taper`, a tube's `tubeWall`, a torus's
   `tubeRatio`. A torus in particular can never be as tall as it is wide -
   h/d = q/(1+q) < 1 for every legal q - so there is no ratio to read.

   One place where the two rules meet: a CAPSULE cannot be as short as it is
   wide either (at h/d = 1 it is a sphere), so it takes the target's own ratio
   only when the target is taller than it is wide, and DEFAULTS.capsuleRatio
   when it is not. An explicitly asked-for ratio at or under 1 is refused
   rather than rounded up, because that is somebody asking for something the
   shape cannot be.

   WHAT IS ON THE PLATE IS A SHADE LESS, and the report says by how much.
   Two separate deficits, neither of them an error:

     polygon_factor   a revolve at n segments inscribes an n-gon in every
                      circle, so the mesh holds n*sin(2pi/n)/(2pi) of the
                      solid. 0.9993 at n = 96. A box has no such factor and
                      its is exactly 1.
     built_volume     a CURVED meridian is itself an n-gon inscribed in the
                      curve, so the solid as built is under the one that was
                      asked for by a further amount. The sphere and the
                      ellipsoid lose 0.027% at n = 96, the capsule 0.014%
                      (half its meridian is straight), and the torus exactly
                      the polygon factor again - Pappus on a regular n-gon
                      inscribed in the tube circle puts its centroid at the
                      circle's own centre. A STRAIGHT meridian is exact, so
                      for the cylinder, the cone and the tube - and for the
                      box, which is not a meridian at all - built_volume IS
                      the analytic volume.

   The mesh holds built_volume x polygon_factor, exactly, for all eight -
   which is what tools/nso_stock_canonical_check.js gates on, against a volume
   the CHECKER measured rather than one this file computed.

   ---------------------------------------------------------------------------
   THE WASTE MARGIN IS A PARAMETER
   ---------------------------------------------------------------------------
   `opts.waste` is a fraction, default 0.30 - the figure the wheel shipped,
   now stated in exactly one place instead of two. It is a real margin: on a
   60 mm target it is the difference between a 21.341 mm ball and a 23.292 mm
   one. What it means depends on what the stock is for - throwing waste on a
   wheel, the skin a carve takes off, the allowance a support strut wants -
   which is precisely why it is an argument and not a constant. 0 is legal and
   means "exactly the shell estimate, no allowance"; the gates below still run.

   ---------------------------------------------------------------------------
   THE BUILD VOLUME IS CHECKED AT GENERATION TIME
   ---------------------------------------------------------------------------
   Not at export, and not by a watcher that notices afterwards. Two boxes are
   put to nso_printer.js before any geometry is built:

     the TARGET box     2R x 2R x H. Over the machine and it is a hard refusal
                        - no waste setting, no shape and no later edit can
                        make a piece that cannot physically exist.
     the STOCK box      the primitive's own bounding box. Over the machine and
                        it is a refusal too, downgraded to a warning by
                        opts.warnOnly for a caller that means to scale or cut
                        the block down before it prints.

   The distinction is the point. A target that does not fit is a dead end; a
   stock block that does not fit is a block that needs cutting up, which is
   Cut's job and a legitimate thing to want.

   Without nso_printer.js loaded there is no gate and no guess: `fit` is null
   and a named warning says so.

   ---------------------------------------------------------------------------
   THE WALL FLOOR IS NOT THIS FILE'S TO INVENT
   ---------------------------------------------------------------------------
   NSO_Thickness.floorFor(nozzle) is the only place the nozzle-safety floor
   comes from. This file carries no 0.42, no nozzle * 1.05 and no default to
   fall back on: loaded without nso_thickness.js it THROWS on the first sizing
   rather than guessing, the same contract app-wheel.js has always had.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   SHAPES                          the eight above, in that order
   DEFAULTS                        the frozen wall / waste / aspect figures,
                                   plus the three second measurements a target
                                   cannot supply
   floor(nozzle)                   -> mm, via NSO_Thickness.floorFor
   shell(opts)                     -> the Pappus thin-shell estimate alone
   size(opts)                      -> the full sizing report, no geometry
   make(opts)                      -> { ok, reason, soup, sizing, fit, warnings }
   proportionsFrom(rawTris, opts)  -> proportions off a reference piece
   revolve(loop, segments, opts)   -> a closed meridian loop, revolved
   polygonFactor(segments)         -> n*sin(2pi/n)/(2pi)
   profileSphere(a, n)             -> the sphere meridian
   profileCylinder(r, h)           -> the cylinder meridian
   profileCone(r, h, rTop)         -> the cone / frustum meridian
   profileTube(rOut, rIn, h)       -> the tube meridian, closed off the axis
   profileTorus(R, a, n)           -> the torus meridian, closed off the axis
   profileCapsule(r, h, n)         -> the capsule meridian
   profileEllipsoid(r, c, n)       -> the spheroid meridian; profileSphere is
                                      its c = r case and delegates to it
   boxSoup(sx, sy, sz, opts)       -> twelve triangles, centred, resting on z = 0

   ---------------------------------------------------------------------------
   OUT OF SCOPE, named so the next ticket does not re-derive it
   ---------------------------------------------------------------------------
   1. THE SHAPES THAT CANNOT SOLVE A CLOSED FORM. Cones and tubes WERE on this
      list and are now built, along with the torus, the capsule and the
      ellipsoid, because each turned out to be one exact closed form and one
      meridian - which is the bar. What is still out, and why, is audited in
      full in docs/STOCK.md, "Which shapes are cheap". In short:

        rounded block     the Minkowski sum of a box and a sphere. Its volume
                          IS closed-form, but solving it for a scale with a
                          FIXED fillet radius is a general cubic, and it is not
                          a solid of revolution, so it needs a real fillet
                          mesher rather than a meridian. Two separate reasons,
                          either one enough.
        superellipsoid    volume needs the Beta function. A closed form only if
                          a special function counts as one; it does not here.
        swept / helical   a coil, a screw, a spring. Its volume is closed-form
                          only CONDITIONALLY - a constant section swept along a
                          polyline holds A x centreline length exactly, and the
                          mitre wedges cancel, while the sweep does not overlap
                          itself or fold a mitre inside out; a coil at a tight
                          pitch does both. And it is not a meridian either way:
                          that is nso_path_sweep.js's job, and the path is
                          three more inputs before there is one defining
                          measurement to solve for.
        lattice / gyroid  no closed form at all; the volume fraction is
                          measured, not solved.
        polyhedra         a Platonic solid or an n-gon prism DOES have an exact
                          closed form. What it does not have is a meridian:
                          each needs its own vertex table, which is a different
                          kind of addition from the eight above. A prism is
                          also very nearly `cylinder` at a low segment count.

      The rule the list above follows, stated once: a shape belongs here when
      its volume solves EXACTLY for one defining measurement and its surface is
      one r-as-a-function-of-z meridian. Everything else is a different ticket,
      not a rounding error to be absorbed.
   2. PLACING THE STOCK. Everything here is generated centred on the axis and
      resting on z = 0. Where it goes on the plate is the packer's business
      (packModels in app-core.js), and a piece that only fits the machine on
      the diagonal is nso_printer.js's stated non-answer, not this file's.
   3. SIZING FROM A TARGET MESH. proportionsFrom() reads a reference piece's
      PROPORTIONS, never its volume. "Make me stock big enough to carve this
      exact model out of" needs the model's own bounding box and a decision
      about stock allowance per face, which is a real ticket and not this one.
   4. A SHELL ESTIMATE FOR A NON-REVOLVED TARGET. The estimate is a solid of
      revolution's wall plus floor, whatever shape the STOCK is. A target that
      is genuinely a box with six walls has a longer perimeter than the circle
      inscribed in it - 8R against 2*pi*R - so this estimate comes out about
      18-20% UNDER what such a target needs. That is the unsafe direction and
      it is measured rather than waved at: tools/nso_stock_test.js prints the
      shortfall across five targets and gates on the default waste margin
      still covering it. A box shell estimate is one more closed form and a
      `target` option to pick it, and it is not here. See finding 3 in
      docs/STOCK.md.
*/

(function (root) {
  'use strict';

  var SHAPES = ['sphere', 'box', 'cylinder', 'cone', 'tube', 'torus', 'capsule', 'ellipsoid'];
  var EPS = 1e-6;

  /* Every default STATED rather than measured, and every one overridable.
     These are the figures app-wheel.js used to carry; they live here now so
     there is one copy and not two.

     WALL 3.0 mm      a typical thrown stoneware wall, and comfortably clear of
                      the 0.42 mm nozzle floor, so the floor is a guard and
                      not the default.
     WASTE 0.30       real throwing waste - the hump left on the wheel head,
                      the trimmings off the foot, water take-up, and the clay
                      the potter's hands keep. The low end of what a production
                      potter allows.
     ASPECT 0.5       target radius = height/2 when no radius is stated, i.e. a
                      target as wide as it is tall.
     SEGMENTS 96      radial segments in the revolve, matching the wheel's, so
                      a sphere from here and a ball from there are the same
                      mesh and not merely the same size.
     PROFILE_N 96     meridian samples on a revolved profile. */
  var DEFAULTS = {
    wall: 3.0,
    waste: 0.30,
    aspect: 0.5,
    segments: 96,
    profileN: 96,
    /* THE SECOND MEASUREMENT for the shapes whose second measurement cannot be
       read off the target. Every other shape takes the target's own height
       over its diameter, which needs no inventing because it is the thing
       being aimed at; these three cannot, and a stated figure beats a silent
       one. See "Where the second measurement comes from" below.

       TAPER 0        a cone's top radius over its base radius. 0 is a true
                      point, which is what "cone" means with nothing else said.
       TUBE_WALL 0.25 a tube's wall as a fraction of its outer radius - a
                      quarter of the way in. Thick enough to cut into, and it
                      still leaves half the diameter as a hole.
       TORUS_TUBE 0.35  a torus's tube radius over its ring radius. A ring
                      rather than a bicycle inner tube, and comfortably clear
                      of the 1.0 at which the hole closes up.
       CAPSULE_RATIO 2  a capsule's total height over its diameter: twice as
                      tall as it is wide, the shortest thing anybody would
                      call a capsule rather than a ball. */
    taper: 0,
    tubeWall: 0.25,
    torusTube: 0.35,
    capsuleRatio: 2
  };

  /* ---------------------------------------------------------------- floor */

  function thickness() {
    if (typeof NSO_Thickness !== 'undefined' && NSO_Thickness) return NSO_Thickness;
    if (root && root.NSO_Thickness) return root.NSO_Thickness;
    return null;
  }

  function floor(nozzle) {
    var T = thickness();
    if (!T || typeof T.floorFor !== 'function') {
      throw new Error('nso_thickness.js is not loaded - new stock takes its wall floor ' +
                      'from NSO_Thickness.floorFor() and will not invent one');
    }
    return T.floorFor(nozzle);
  }

  function printerModule() {
    if (typeof NSO_Printer !== 'undefined' && NSO_Printer) return NSO_Printer;
    if (root && root.NSO_Printer) return root.NSO_Printer;
    return null;
  }

  function detectAxis() {
    if (typeof NSO_extendDetectAxis === 'function') return NSO_extendDetectAxis;
    if (root && typeof root.NSO_extendDetectAxis === 'function') return root.NSO_extendDetectAxis;
    return null;
  }

  function positive(v) { return (typeof v === 'number' && isFinite(v) && v > 0); }

  /* ------------------------------------------------ the shell estimate */

  /* The Pappus thin-shell estimate on its own, so a caller that wants the
     material figure without a primitive attached can have it. Both halves are
     returned separately because they are two applications of one theorem and a
     caller checking the arithmetic wants to see them apart. */
  function shell(opts) {
    opts = opts || {};
    var H = opts.height;
    if (!positive(H)) {
      return { ok: false, reason: 'target height must be a positive number of millimetres' };
    }
    var R = positive(opts.radius) ? opts.radius : H * DEFAULTS.aspect;
    var t = positive(opts.wall) ? opts.wall : DEFAULTS.wall;
    var f = positive(opts.floor) ? opts.floor : floor(opts.nozzle);
    /* The verb in the refusal below. A general module has no business calling
       everything "thrown", and the Pottery Wheel has every business saying it:
       BALL passes 'thrown' so its refusal reads exactly as it always has. */
    var verb = opts.what ? String(opts.what) : 'made';

    if (t < f) {
      return {
        ok: false,
        reason: 'a ' + t.toFixed(3) + ' mm wall is under the ' + f.toFixed(3) +
          ' mm nozzle floor - nothing ' + verb + ' at that wall could be printed. ' +
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

    return {
      ok: true,
      height: H, radius: R, wall: t, nozzle_floor: f,
      wall_volume: wallV, floor_volume: floorV,
      shell_volume: wallV + floorV
    };
  }

  /* ------------------------------------------- proportions off a reference */

  /* "Make the stock the shape this piece is" - the sensible default when the
     caller has a piece in hand and no opinion about proportions.

     NSO_extendDetectAxis (app-extend.js) is what decides whether the reference
     HAS a shape worth copying. That is not decoration: it refuses a blob and a
     piece that is curved or tapered on every axis, and either of those is a
     reference whose bounding box means nothing. Its census has already walked
     the soup once and carries each axis's extent, so the proportions come
     straight off it rather than from a second pass. One of its refusals is NOT
     a refusal here - see the note in the body.

     The reference's OWN orientation is kept. Standing a long axis up is a pose
     decision, the app has pose buttons that own it, and quietly rotating
     somebody's stock would be a surprise the next tool pays for. */
  function proportionsFrom(rawTris, opts) {
    opts = opts || {};
    var detect = detectAxis();
    if (!detect) {
      return { ok: false, reason: 'app-extend.js is not loaded - reading proportions off a ' +
        'reference piece is NSO_extendDetectAxis, and this file does not carry its own copy ' +
        'of an axis detector; pass explicit proportions instead' };
    }
    var det = detect(rawTris, opts);
    /* ONE OF EXTEND'S REFUSALS IS NOT A REFUSAL HERE. `ambiguous` means two or
       three axes are equally straight AND within tieFrac of the same length -
       a cube, or a square-section bar. Extend refuses it because it cannot
       tell which axis to LENGTHEN, which is Extend's question. It is not this
       one: a cube's proportions are 1 : 1 : 1 and reading them off is exactly
       right. So the ambiguous case is taken, with the longest of the tied axes
       standing in as the dominant one; every other refusal - not a soup,
       curved or tapered on every axis, dominant axis off-cardinal - is a
       reference whose bounding box genuinely means nothing, and is passed
       straight through with Extend's own wording. */
    if (!det.ok && !det.ambiguous) {
      return { ok: false, reason: 'no proportions to read off that piece - ' + det.reason,
               detect: det };
    }
    var c = det.census;
    if (!det.ok) {
      var longest = c.slice().sort(function (a, b) { return b.extent - a.extent; })[0];
      det = { ok: true, census: c, axis: longest.axis, axisIdx: longest.axisIdx,
              best: longest, ambiguous: true, reason: det.reason };
    }
    var p = { x: c[0].extent, y: c[1].extent, z: c[2].extent };
    if (!(p.x > EPS && p.y > EPS && p.z > EPS)) {
      return { ok: false, reason: 'that reference piece is flat on at least one axis (' +
        p.x.toFixed(3) + ' x ' + p.y.toFixed(3) + ' x ' + p.z.toFixed(3) +
        ' mm) - a zero side has no proportion', detect: det };
    }
    /* height / diameter for a cylinder, read the same way: the extent along
       the dominant axis against the wider of the two across it, because that
       is the diameter a cylinder wrapping this piece would need. */
    var across = [p.x, p.y, p.z];
    across.splice(det.axisIdx, 1);
    return {
      ok: true,
      proportions: p,
      axis: det.axis, axisIdx: det.axisIdx,
      ambiguous: !!det.ambiguous,
      ratio: [p.x, p.y, p.z][det.axisIdx] / Math.max(across[0], across[1]),
      reason: 'proportions ' + p.x.toFixed(2) + ' : ' + p.y.toFixed(2) + ' : ' + p.z.toFixed(2) +
        ' mm off the reference piece, ' + (det.ambiguous ? 'no one axis dominant, longest is '
          : 'dominant axis ') + det.axis
    };
  }

  /* ------------------------------------------------------------- sizing */

  /* height / diameter, from the first of three places that has one:

       1. explicit        opts.ratio
       2. a reference     the dominant axis over the wider of the two across it
       3. the target      its own height over its own diameter - a default that
                          needs no inventing, because it is the thing being
                          aimed at rather than a number picked to look sensible

     This order was the cylinder's and is now shared by every shape whose
     second measurement is a height over a diameter: cylinder, cone, tube,
     capsule, ellipsoid. A box's second measurement is three numbers rather
     than one and keeps its own copy of the order; a sphere has none; a torus's
     is not a height over a diameter at all. */
  function ratioFor(opts, ref, sh) {
    if (positive(opts.ratio)) return { k: +opts.ratio, from: 'as asked' };
    if (ref) return { k: ref.ratio, from: 'off the reference piece (dominant axis ' + ref.axis + ')' };
    return { k: sh.height / (2 * sh.radius), from: 'the target\'s own height over diameter' };
  }

  /* opts:
       shape      'sphere' | 'box' | 'cylinder'; default 'sphere'
       height     target height, mm - REQUIRED
       radius     target radius, mm; default height * 0.5
       wall       target wall, mm; default 3.0
       waste      margin as a fraction; default 0.30, 0 is legal
       nozzle     nozzle diameter; sets the wall floor via nso_thickness.js
       floor      the floor itself, for a caller that has already resolved it
       proportions  box only: { x, y, z }, any positive scale
       ratio      cylinder only: height / diameter
       like       a reference rawTris; proportions / ratio read off it
       segments, profileN   tessellation, defaults 96 / 96
       printer    an nso_printer.js profile; or plate + plateOver to resolve one
       warnOnly   a stock block over the build volume warns instead of refusing
  */
  function size(opts) {
    opts = opts || {};
    var shape = opts.shape || 'sphere';
    if (SHAPES.indexOf(shape) < 0) {
      return { ok: false, reason: 'unknown stock shape "' + shape + '" - this version makes ' +
        SHAPES.join(', ') };
    }
    var sh = shell(opts);
    if (!sh.ok) return { ok: false, reason: sh.reason };

    var waste = (typeof opts.waste === 'number' && isFinite(opts.waste) && opts.waste >= 0)
      ? opts.waste : DEFAULTS.waste;
    var need = sh.shell_volume * (1 + waste);

    var rep = {
      ok: true,
      shape: shape,
      height: sh.height, radius: sh.radius, wall: sh.wall,
      waste: waste, nozzle_floor: sh.nozzle_floor,
      wall_volume: sh.wall_volume, floor_volume: sh.floor_volume,
      shell_volume: sh.shell_volume,
      need_volume: need,
      warnings: []
    };

    /* A reference piece answers both shapes' "what proportions?" question, so
       it is read once, before the per-shape branch. A sphere has no
       proportions to take, so a reference handed to one is refused by name
       rather than read and quietly dropped. */
    var ref = null;
    if (opts.like && shape === 'sphere') {
      return { ok: false, reason: 'a sphere has one measurement, so there are no proportions ' +
        'to read off a reference piece - ask for a box or a cylinder, or drop the reference' };
    }
    /* A torus refuses one for a different reason, and it is worth separating:
       a sphere has nothing to read, while a torus has a second measurement
       that a bounding box cannot express. Its tube ratio is how FAT the ring
       is, and the widest and deepest extents of a reference piece say nothing
       about that - a ring and a solid disc of the same proportions read
       identically. Reading it anyway would put a plausible number on an
       unanswerable question. */
    if (opts.like && shape === 'torus') {
      return { ok: false, reason: 'a torus is measured by its tube radius over its ring radius, ' +
        'so there are no proportions to read off a reference piece - a bounding box cannot say ' +
        'how fat the ring is. Give the tube ratio directly, or drop the reference' };
    }
    if (opts.like) {
      ref = proportionsFrom(opts.like, opts.likeOpts || {});
      if (!ref.ok) return { ok: false, reason: ref.reason };
      rep.reference = { axis: ref.axis, proportions: ref.proportions, ratio: ref.ratio };
    }

    var segments = Math.max(12, Math.round(positive(opts.segments) ? opts.segments : DEFAULTS.segments));
    rep.segments = segments;
    /* Meridian samples. Resolved here rather than inside each branch because
       five of the eight shapes have a curved meridian now, and a second copy
       of a clamp is a second place for it to drift. Only the shapes that
       actually sample a curve report it. */
    var profN = Math.max(24, Math.round(positive(opts.profileN) ? opts.profileN : DEFAULTS.profileN));

    if (shape === 'sphere') {
      var a = Math.cbrt(3 * need / (4 * Math.PI));
      rep.measure = { radius: a, diameter: 2 * a };
      rep.size = { x: 2 * a, y: 2 * a, z: 2 * a };
      rep.profileN = profN;
      rep.volume = 4 / 3 * Math.PI * a * a * a;
      /* A SPHERE IS THE ONE SHAPE WHOSE MERIDIAN IS ALSO AN APPROXIMATION.
         The profile is an n-gon inscribed in the semicircle, so the solid as
         built is a shade under the sphere that was asked for - a separate
         deficit from the 96-gon cross-section every revolved shape has. Both
         are reported, because the mesh holds built_volume x polygon_factor
         and nothing else, and a caller charging a material budget wants the
         figure that is actually there. This is the same distinction
         app-wheel.js draws when it opens the budget at the ball AS BUILT. */
      rep.built_volume = loopVolume(profileSphere(a, rep.profileN));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'radius ' + a.toFixed(3) + ' mm';

    } else if (shape === 'box') {
      /* Proportions, in order: explicit, then a reference piece, then the
         target's own bounding box - 2R wide and deep, H tall - which is the
         default that needs no inventing, because it is the thing being aimed
         at rather than a number picked to look reasonable. */
      var prop = null, propFrom = '';
      if (opts.proportions) {
        prop = {
          x: +opts.proportions.x, y: +opts.proportions.y, z: +opts.proportions.z
        };
        if (!(positive(prop.x) && positive(prop.y) && positive(prop.z))) {
          return { ok: false, reason: 'box proportions must be three positive numbers - got ' +
            JSON.stringify(opts.proportions) };
        }
        propFrom = 'as asked';
      } else if (ref) {
        prop = ref.proportions;
        propFrom = 'off the reference piece (dominant axis ' + ref.axis + ')';
      } else {
        prop = { x: 2 * sh.radius, y: 2 * sh.radius, z: sh.height };
        propFrom = 'the target\'s own bounding box';
      }
      var s = Math.cbrt(need / (prop.x * prop.y * prop.z));
      rep.measure = {
        x: s * prop.x, y: s * prop.y, z: s * prop.z,
        scale: s, proportions: prop, proportions_from: propFrom
      };
      rep.size = { x: rep.measure.x, y: rep.measure.y, z: rep.measure.z };
      rep.volume = rep.measure.x * rep.measure.y * rep.measure.z;
      /* A box is six flat faces: the mesh IS the analytic solid, with no
         inscribed-polygon deficit to account for on either axis. */
      rep.built_volume = rep.volume;
      rep.polygon_factor = 1;
      rep.measure_text = rep.measure.x.toFixed(3) + ' x ' + rep.measure.y.toFixed(3) +
        ' x ' + rep.measure.z.toFixed(3) + ' mm (' + propFrom + ')';

    } else if (shape === 'cylinder') {
      /* Ratio, in order: explicit, then a reference piece, then the target's
         own height over its diameter - ratioFor(), which four more shapes
         below now share rather than each carrying that order again. */
      var cy = ratioFor(opts, ref, sh);
      if (!positive(cy.k)) {
        return { ok: false, reason: 'cylinder height/diameter ratio must be positive - got ' + opts.ratio };
      }
      var r = Math.cbrt(need / (2 * Math.PI * cy.k));
      var h = 2 * cy.k * r;
      rep.measure = { radius: r, diameter: 2 * r, height: h, ratio: cy.k, ratio_from: cy.from };
      rep.size = { x: 2 * r, y: 2 * r, z: h };
      rep.volume = Math.PI * r * r * h;
      /* A cylinder's meridian is four straight segments, so it is EXACT - the
         only deficit is the 96-gon cross-section, which polygon_factor holds. */
      rep.built_volume = loopVolume(profileCylinder(r, h));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'radius ' + r.toFixed(3) + ' mm x ' + h.toFixed(3) + ' mm tall (ratio ' +
        cy.k.toFixed(3) + ', ' + cy.from + ')';

    } else if (shape === 'cone') {
      /* A cone, and a truncated one for free. The frustum term (1 + t + t^2)
         is exactly 1 at t = 0, so a true point costs nothing to carry and a
         draft angle costs one option:

             need = (pi h / 3)(r^2 + r*rTop + rTop^2),  rTop = t*r,  h = 2kr
                  = (2 pi k / 3)(1 + t + t^2) r^3
             ->  r = cbrt(3*need / (2*pi*k*(1 + t + t^2)))

         t = 1 IS a cylinder and is refused as such. A second name for a shape
         that already has one is how two shapes quietly drift apart. */
      var cn = ratioFor(opts, ref, sh);
      if (!positive(cn.k)) {
        return { ok: false, reason: 'cone height/diameter ratio must be positive - got ' + opts.ratio };
      }
      var taper = (opts.taper == null) ? DEFAULTS.taper : +opts.taper;
      if (!(isFinite(taper) && taper >= 0 && taper < 1)) {
        return { ok: false, reason: 'a cone taper is the top radius over the base radius, so it ' +
          'sits in [0, 1) - 0 is a true point and 1 is a cylinder, which is its own shape. Got ' +
          opts.taper };
      }
      var frustum = 1 + taper + taper * taper;
      var rc = Math.cbrt(3 * need / (2 * Math.PI * cn.k * frustum));
      var hc = 2 * cn.k * rc;
      var rTop = taper * rc;
      rep.measure = { radius: rc, diameter: 2 * rc, top_radius: rTop, height: hc,
                      ratio: cn.k, ratio_from: cn.from, taper: taper };
      rep.size = { x: 2 * rc, y: 2 * rc, z: hc };
      rep.volume = Math.PI * hc / 3 * (rc * rc + rc * rTop + rTop * rTop);
      /* Straight meridian, like the cylinder's: as-built IS the analytic
         volume, and the 96-gon cross-section is the only deficit. */
      rep.built_volume = loopVolume(profileCone(rc, hc, rTop));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'base radius ' + rc.toFixed(3) + ' mm x ' + hc.toFixed(3) +
        ' mm tall (ratio ' + cn.k.toFixed(3) + ', ' + cn.from +
        (taper > 0 ? '; top radius ' + rTop.toFixed(3) + ' mm' : '') + ')';

    } else if (shape === 'tube') {
      /* A cylinder with the middle taken out, the wall given as a fraction w
         of the outer radius:

             need = pi (r^2 - r_in^2) h,  r_in = r(1 - w),  h = 2kr
                  = 2 pi k (1 - (1 - w)^2) r^3
             ->  r = cbrt(need / (2*pi*k*(1 - (1 - w)^2)))

         A fraction rather than millimetres on purpose: the wall has to scale
         with the block, and an absolute wall would have to be re-checked
         against a radius that is not known until after it is solved for. */
      var tb = ratioFor(opts, ref, sh);
      if (!positive(tb.k)) {
        return { ok: false, reason: 'tube height/diameter ratio must be positive - got ' + opts.ratio };
      }
      var wf = (opts.tubeWall == null) ? DEFAULTS.tubeWall : +opts.tubeWall;
      if (!(isFinite(wf) && wf > 0 && wf < 1)) {
        return { ok: false, reason: 'a tube wall is a fraction of the outer radius, so it sits ' +
          'strictly between 0 and 1 - at 1 there is no hole left and the shape is a cylinder, ' +
          'which is its own shape. Got ' + opts.tubeWall };
      }
      var solidF = 1 - (1 - wf) * (1 - wf);
      var rt = Math.cbrt(need / (2 * Math.PI * tb.k * solidF));
      var ht = 2 * tb.k * rt;
      var rIn = rt * (1 - wf);
      rep.measure = { radius: rt, diameter: 2 * rt, inner_radius: rIn, height: ht,
                      ratio: tb.k, ratio_from: tb.from, wall_fraction: wf, tube_wall: rt - rIn };
      rep.size = { x: 2 * rt, y: 2 * rt, z: ht };
      rep.volume = Math.PI * (rt * rt - rIn * rIn) * ht;
      /* Straight meridian again, so exact - but the FIRST profile here whose
         loop does not start and end on the axis. See profileTube. */
      rep.built_volume = loopVolume(profileTube(rt, rIn, ht));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'outer radius ' + rt.toFixed(3) + ' mm, bore ' + rIn.toFixed(3) +
        ' mm, ' + ht.toFixed(3) + ' mm tall (ratio ' + tb.k.toFixed(3) + ', ' + tb.from +
        '; wall ' + (rt - rIn).toFixed(3) + ' mm = ' + (wf * 100).toFixed(0) + '% of the radius)';

    } else if (shape === 'torus') {
      /* Pappus again, and this time on the primitive rather than the target:
         a circle of radius `a` whose centre is `R` from the axis sweeps

             need = 2 pi^2 R a^2,  a = qR  ->  need = 2 pi^2 q^2 R^3
             ->  R = cbrt(need / (2*pi^2*q^2))

         q is the only second measurement here that is NOT a height over a
         diameter, and it cannot be one: a torus is never as tall as it is
         wide - h/d = q/(1+q) < 1 for every legal q - so the target's own
         proportions have nothing to say and DEFAULTS.torusTube stands in. */
      var q = (opts.tubeRatio == null) ? DEFAULTS.torusTube : +opts.tubeRatio;
      if (!(isFinite(q) && q > 0 && q < 1)) {
        return { ok: false, reason: 'a torus tube ratio is the tube radius over the ring radius, ' +
          'so it sits strictly between 0 and 1 - at 1 the hole closes up, and past it the ' +
          'surface passes through itself. Got ' + opts.tubeRatio };
      }
      var Rq = Math.cbrt(need / (2 * Math.PI * Math.PI * q * q));
      var aq = q * Rq;
      rep.profileN = profN;
      rep.measure = { ring_radius: Rq, tube_radius: aq, diameter: 2 * (Rq + aq), height: 2 * aq,
                      tube_ratio: q,
                      tube_ratio_from: (opts.tubeRatio == null ? 'the stated default' : 'as asked') };
      rep.size = { x: 2 * (Rq + aq), y: 2 * (Rq + aq), z: 2 * aq };
      rep.volume = 2 * Math.PI * Math.PI * Rq * aq * aq;
      /* A CURVED meridian, so as-built is under analytic exactly as a
         sphere's is - and by the same factor, which is not a coincidence:
         Pappus on a regular n-gon inscribed in the tube circle puts its
         centroid at the circle's own centre, so the as-built torus is
         n*sin(2pi/n)/(2pi) of the true one. */
      rep.built_volume = loopVolume(profileTorus(Rq, aq, profN));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'ring radius ' + Rq.toFixed(3) + ' mm, tube radius ' + aq.toFixed(3) +
        ' mm, ' + (2 * (Rq + aq)).toFixed(3) + ' mm across (tube ratio ' + q.toFixed(3) + ', ' +
        rep.measure.tube_ratio_from + ')';

    } else if (shape === 'capsule') {
      /* A cylinder with a hemisphere on each end. Total height H = 2kr, so the
         barrel is 2r(k - 1) and

             need = pi r^2 * 2r(k - 1) + 4/3 pi r^3 = 2 pi r^3 (k - 1/3)
             ->  r = cbrt(need / (2*pi*(k - 1/3)))
      */
      var cp = ratioFor(opts, ref, sh);
      if (!positive(cp.k)) {
        return { ok: false, reason: 'capsule height/diameter ratio must be positive - got ' + opts.ratio };
      }
      /* A capsule cannot be as short as it is wide: at h/d = 1 it IS a sphere.
         So the target's own height over diameter, which every other shape here
         takes, is only available when the target is taller than it is wide -
         and when it is not, DEFAULTS.capsuleRatio stands in rather than a
         refusal, because "a capsule for this squat target" has an obvious
         answer and it is not "no". An explicitly ASKED-FOR ratio at or under 1
         is a different thing and is refused: that is somebody saying something
         the shape cannot do, and quietly rounding it up would hide it. */
      if (cp.k <= 1) {
        if (positive(opts.ratio) || ref) {
          return { ok: false, reason: 'a capsule is a cylinder with a hemisphere on each end, so ' +
            'its height over its diameter has to be MORE than 1 - at exactly 1 it is a sphere, ' +
            'and that is its own shape. Got ' + cp.k.toFixed(3) + ', ' + cp.from };
        }
        cp = { k: DEFAULTS.capsuleRatio, from: 'the stated default - the target\'s own ' +
               (sh.height / (2 * sh.radius)).toFixed(3) + ' is not taller than it is wide' };
      }
      var rp = Math.cbrt(need / (2 * Math.PI * (cp.k - 1 / 3)));
      var hp = 2 * cp.k * rp;
      rep.profileN = profN;
      rep.measure = { radius: rp, diameter: 2 * rp, height: hp, barrel: hp - 2 * rp,
                      ratio: cp.k, ratio_from: cp.from };
      rep.size = { x: 2 * rp, y: 2 * rp, z: hp };
      rep.volume = Math.PI * rp * rp * (hp - 2 * rp) + 4 / 3 * Math.PI * rp * rp * rp;
      rep.built_volume = loopVolume(profileCapsule(rp, hp, profN));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'radius ' + rp.toFixed(3) + ' mm x ' + hp.toFixed(3) +
        ' mm tall (ratio ' + cp.k.toFixed(3) + ', ' + cp.from + '; ' +
        (hp - 2 * rp).toFixed(3) + ' mm barrel between the caps)';

    } else {
      /* ellipsoid - a spheroid, a sphere stretched or squashed along the axis
         it stands on. Semi-axes r, r, c with c = kr:

             need = 4/3 pi r^2 c = 4/3 pi k r^3  ->  r = cbrt(3*need / (4*pi*k))

         k = 1 is LEGAL here, unlike the cone's taper of 1 and the capsule's
         ratio of 1. Those two are a different shape wearing a second name at
         the end of their range; a sphere is the MIDDLE of this one, and
         refusing the middle of a continuous family is the worse surprise. It
         also comes out bit-identical to the sphere branch, which the self-test
         asserts rather than assumes. */
      var el = ratioFor(opts, ref, sh);
      if (!positive(el.k)) {
        return { ok: false, reason: 'ellipsoid height/diameter ratio must be positive - got ' + opts.ratio };
      }
      var re = Math.cbrt(3 * need / (4 * Math.PI * el.k));
      var ce = el.k * re;
      rep.profileN = profN;
      rep.measure = { radius: re, diameter: 2 * re, semi_height: ce, height: 2 * ce,
                      ratio: el.k, ratio_from: el.from };
      rep.size = { x: 2 * re, y: 2 * re, z: 2 * ce };
      rep.volume = 4 / 3 * Math.PI * re * re * ce;
      rep.built_volume = loopVolume(profileEllipsoid(re, ce, profN));
      rep.polygon_factor = polygonFactor(segments);
      rep.measure_text = 'radius ' + re.toFixed(3) + ' mm x ' + (2 * ce).toFixed(3) +
        ' mm tall (ratio ' + el.k.toFixed(3) + ', ' + el.from + ')';
    }

    /* Does the stock at least contain the thing it is stock FOR? A sphere
       sized for a 60 mm vessel is 46.6 mm across, because clay is plastic and
       a potter pulls it taller - correct for a wheel, wrong for a block a
       carve has to fit inside. Reported per shape rather than decided here:
       which of those two a caller is doing is not something this file knows. */
    rep.target_box = { x: 2 * sh.radius, y: 2 * sh.radius, z: sh.height };
    rep.encloses_target =
      rep.size.x >= rep.target_box.x - EPS &&
      rep.size.y >= rep.target_box.y - EPS &&
      rep.size.z >= rep.target_box.z - EPS;

    rep.reason = 'target ' + sh.height.toFixed(1) + ' x ' + (2 * sh.radius).toFixed(1) + ' mm, ' +
      sh.wall.toFixed(2) + ' mm wall: shell ' + sh.shell_volume.toFixed(1) + ' mm^3, +' +
      Math.round(waste * 100) + '% waste = ' + need.toFixed(1) + ' mm^3, ' +
      shape + ' ' + rep.measure_text;

    /* ------------------------------------------- the build-volume gate */
    var gate = fitGate(rep, opts);
    if (!gate.ok) return { ok: false, reason: gate.reason, fit: gate.fit, target_fit: gate.target_fit };
    rep.fit = gate.fit;
    rep.target_fit = gate.target_fit;
    rep.checked_build_volume = !!gate.fit;
    for (var w = 0; w < gate.warnings.length; w++) rep.warnings.push(gate.warnings[w]);
    /* Warnings are NOT folded into `reason`. `reason` is the sizing, and one
       caller - app-wheel.js's BALL, which has its own live build-volume
       readout in NSO_wheelStatus and passes no printer here - puts that string
       in front of the user verbatim. A warning appended to it would change
       what the Pottery Wheel says without anything asking it to. Surfacing
       warnings is the caller's job; app-stock.js does it in the status line. */
    return rep;
  }

  /* The printer this sizing is measured against: an explicit profile, or a
     plate id resolved through nso_printer.js, or nothing at all. Nothing at
     all is a named warning, never a guessed machine - a build-volume check
     against the wrong printer is worse than no check, because it reads as a
     pass. */
  function resolvePrinter(opts) {
    var P = printerModule();
    if (!P) return null;
    if (opts.printer) return opts.printer;
    if (opts.plate) return P.resolve(opts.plate, opts.plateOver || null);
    return null;
  }

  function fitGate(rep, opts) {
    var out = { ok: true, fit: null, target_fit: null, warnings: [], reason: '' };
    var P = printerModule();
    var p = resolvePrinter(opts);
    if (!P || !p) {
      out.warnings.push(P
        ? 'no printer given, so nothing was checked against a build volume'
        : 'nso_printer.js is not loaded, so nothing was checked against a build volume');
      return out;
    }

    /* The TARGET first. A target over the machine is a dead end: no waste
       setting, no shape and no later edit makes a piece that cannot exist. */
    var tf = P.fit(rep.target_box, p, opts.fitOpts || {});
    out.target_fit = tf;
    if (!tf.fits) {
      out.ok = false;
      out.reason = 'that target cannot be printed on ' + p.name + ' at all - ' + tf.reason +
        '. The stock would be ' + rep.measure_text + ', but the finished ' +
        rep.height.toFixed(1) + ' x ' + (2 * rep.radius).toFixed(1) +
        ' mm piece does not fit the machine. Pick a smaller target, or a bigger plate.';
      out.fit = P.fit(rep.size, p, opts.fitOpts || {});
      return out;
    }

    /* Then the STOCK. Over the machine and it is a block that needs cutting
       up before it prints - a legitimate thing to want, so warnOnly downgrades
       it, and the refusal names Cut rather than just saying no. */
    var sf = P.fit(rep.size, p, opts.fitOpts || {});
    out.fit = sf;
    if (!sf.fits) {
      var line = 'the ' + rep.shape + ' this target needs is too big for ' + p.name +
        ' - ' + sf.reason;
      if (opts.warnOnly) {
        out.warnings.push(line + ' (generated anyway: split it with Cut before printing)');
      } else {
        out.ok = false;
        out.reason = line + '. Lower the waste margin, pick a shape that stands up better, ' +
          'or generate it anyway and split it with Cut.';
        return out;
      }
    }
    return out;
  }

  /* --------------------------------------------------------- geometry */

  /* An n-gon inscribed in a circle holds n*sin(2pi/n)/(2pi) of it, and every
     term of a solid-of-revolution volume integral is an r^2 term, so the
     revolved mesh holds exactly that fraction of the solid its meridian
     describes. One place, because seven of the eight shapes report it. */
  function polygonFactor(segments) {
    return segments * Math.sin(2 * Math.PI / segments) / (2 * Math.PI);
  }

  /* The meridian of an ellipsoid of revolution - semi-axes r, r, c - resting
     on z = 0 and sampled uniformly in POLAR ANGLE, which puts more
     z-resolution where the curvature is, at the poles, than uniform-in-z
     sampling would.

     profileSphere is the c = r case of this and delegates to it rather than
     keeping its own loop: with c === r === a every operation below is the
     arithmetic the sphere's own loop used to do, in the same order, so the
     wheel's ball is still bit-identical - which tools/nso_stock_test.js
     section 7 asserts on the float32 soup rather than taking on trust. */
  function profileEllipsoid(r, c, n) {
    n = Math.max(24, Math.round(n || DEFAULTS.profileN));
    var out = new Array(n + 1);
    for (var i = 0; i <= n; i++) {
      var phi = Math.PI * i / n;                 // south pole (0) to north pole (pi)
      out[i] = { z: c - c * Math.cos(phi), r: r * Math.sin(phi) };
    }
    /* Pin the poles to the axis exactly - sin(pi) is 1.2e-16, not 0, and an r
       of 1.2e-16 makes a sliver ring instead of a fan. */
    out[0].r = 0; out[0].z = 0;
    out[n].r = 0; out[n].z = 2 * c;
    return out;
  }

  /* The meridian of a sphere of radius a. */
  function profileSphere(a, n) {
    return profileEllipsoid(a, a, n);
  }

  /* The meridian of a cone, or of a truncated one: up the axis at the base,
     out along the base, up the slant to the top radius, and in along the top.
     Four points, and a TRUE cone - rTop = 0 - simply has its last two
     coincide, which the revolve drops as a degenerate band rather than
     needing a case of its own. */
  function profileCone(r, h, rTop) {
    return [{ z: 0, r: 0 }, { z: 0, r: r }, { z: h, r: rTop || 0 }, { z: h, r: 0 }];
  }

  /* The meridian of a tube - a cylinder with the bore taken out: the base
     annulus, up the outside, in along the top annulus, and down the inside.

     FIVE POINTS FOR FOUR SEGMENTS, and the fifth is the first repeated. Every
     other profile in this file starts and ends ON THE AXIS, so the closing
     segment the revolve does not emit runs along the axis and generates
     nothing - which is why revolve can leave it out. This loop never touches
     the axis, so its closing segment is the inner wall, and leaving it to be
     inferred would hand back an open solid. It is written down instead. */
  function profileTube(rOut, rIn, h) {
    return [{ z: 0, r: rIn }, { z: 0, r: rOut }, { z: h, r: rOut },
            { z: h, r: rIn }, { z: 0, r: rIn }];
  }

  /* The meridian of a torus: the circle of radius a whose centre sits a above
     the plate and R out from the axis, closed the same way profileTube is and
     for the same reason.

     Sampled from theta = -pi/2 so that i = 0 is EXACTLY the bottom of the
     tube - Math.sin(-pi/2) is -1 to the bit, so the piece rests on z = 0 for
     any n rather than only for the multiples of four that happen to land a
     sample there. */
  function profileTorus(R, a, n) {
    n = Math.max(24, Math.round(n || DEFAULTS.profileN));
    var out = new Array(n + 1);
    for (var i = 0; i < n; i++) {
      var th = -Math.PI / 2 + 2 * Math.PI * i / n;
      out[i] = { z: a + a * Math.sin(th), r: R + a * Math.cos(th) };
    }
    out[0].z = 0;
    out[n] = { z: out[0].z, r: out[0].r };
    return out;
  }

  /* The meridian of a capsule: a hemisphere of radius r up from the plate, the
     barrel wall, and a hemisphere back down to the axis at the total height h.
     Half the meridian samples to each cap, so a capsule and a sphere at the
     same profileN are sampled at the same angular pitch. */
  function profileCapsule(r, h, n) {
    n = Math.max(24, Math.round(n || DEFAULTS.profileN));
    var m = Math.max(12, Math.round(n / 2));
    var barrel = h - 2 * r;
    var out = [], i, phi;
    for (i = 0; i <= m; i++) {                    // south pole to the equator
      phi = Math.PI / 2 * i / m;
      out.push({ z: r - r * Math.cos(phi), r: r * Math.sin(phi) });
    }
    for (i = 0; i <= m; i++) {                    // the top cap's equator to its pole
      phi = Math.PI / 2 * i / m;
      out.push({ z: r + barrel + r * Math.sin(phi), r: r * Math.cos(phi) });
    }
    out[0].r = 0; out[0].z = 0;
    out[out.length - 1].r = 0; out[out.length - 1].z = h;
    return out;
  }

  /* The meridian of a cylinder, as a closed loop: up the axis at the base, out
     along the floor, up the wall, in along the top. Four points, and the
     revolve's one band rule turns them into a base fan, a wall and a top fan
     without knowing which is which. */
  function profileCylinder(r, h) {
    return [{ z: 0, r: 0 }, { z: 0, r: r }, { z: h, r: r }, { z: h, r: 0 }];
  }

  /* pi * contour integral of r^2 dz around a closed meridian loop - the exact
     volume of the solid that loop revolves into, for a POLYLINE meridian.
     Green's theorem turns 2*pi*(integral of r dA) into that contour integral,
     and each segment contributes (z2 - z1)*(r1^2 + r1*r2 + r2^2)/3. Same
     identity as 2*pi*rho*A, not an approximation of it - and the same one
     app-wheel.js keeps its material budget in. */
  function loopVolume(loop) {
    var n = loop.length, acc = 0;
    if (n < 2) return 0;
    for (var i = 0; i < n; i++) {
      var a = loop[i], b = loop[(i + 1) % n];
      acc += (b.z - a.z) * (a.r * a.r + a.r * b.r + b.r * b.r) / 3;
    }
    return Math.PI * acc;
  }

  /* A closed meridian loop -> a closed triangle soup, Z up, millimetres.

     THIS IS THE POTTERY WHEEL'S REVOLVE, moved here rather than copied:
     app-wheel.js builds its meridian (up the outside, across the rim, down the
     inside) and hands it straight to this function. One tessellator, so a
     sphere generated here and a ball thrown there are bit-identical rather
     than merely the same size - which tools/nso_stock_test.js asserts on the
     float32 soup, not on a volume.

     For consecutive meridian points i, i+1 and angular steps j, j+1:

         A = P(i, j)      B = P(i, j+1)
         D = P(i+1, j)    C = P(i+1, j+1)

     emit (A, B, C) and (A, C, D), dropping whichever is degenerate when a ring
     sits on the axis. The outward normal that falls out of that ordering is
     (dz, -dr) in the (r, z) half-plane, which is correct for every part of the
     loop at once: an outer wall (dz > 0, dr = 0) faces out, a rim annulus
     (dz = 0, dr < 0) faces up, a base (dz = 0, dr > 0) faces down, and an
     inner wall - traversed downward, so dz < 0 - faces in. Nothing in the
     revolve knows which part of the shape it is building.

     opts.precise returns a plain Array of float64 instead of a Float32Array.
     The app never wants it - rawTris is float32 everywhere - but anything
     MEASURING the revolve does: float32 storage moves a signed volume by a few
     parts in 1e8, which is enough to hide whether the tessellation is exact. */
  function revolve(loop, segments, opts) {
    opts = opts || {};
    var seg = Math.max(12, Math.round(segments || DEFAULTS.segments));
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
      if (r0 <= EPS && r1 <= EPS) continue;             // both on the axis
      for (var jj = 0; jj < seg; jj++) {
        var k = (jj + 1) % seg;
        var A = pt(i, jj), B = pt(i, k), C = pt(i + 1, k), D = pt(i + 1, jj);
        if (r0 > EPS) push(A, B, C);
        if (r1 > EPS) push(A, C, D);
      }
    }
    /* The closing segment from the last loop point back to the first runs
       along the axis (both ends have r = 0 by construction on every profile
       this file builds, and on the wheel's meridian too), so it generates
       nothing and the surface is already closed. */
    return opts.precise ? tris : new Float32Array(tris);
  }

  /* A box: centred on x and y, resting on z = 0, twelve triangles, outward
     normals. No revolve - a box is not a solid of revolution and pretending
     otherwise would put a 96-gon where six flat faces belong. */
  function boxSoup(sx, sy, sz, opts) {
    opts = opts || {};
    var x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2, z0 = 0, z1 = sz;
    var v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],   // 0..3 bottom
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]    // 4..7 top
    ];
    /* Each quad as two triangles, wound counter-clockwise seen from outside. */
    var quads = [
      [0, 3, 2, 1],   // bottom, normal -z
      [4, 5, 6, 7],   // top,    normal +z
      [0, 1, 5, 4],   // front,  normal -y
      [2, 3, 7, 6],   // back,   normal +y
      [1, 2, 6, 5],   // right,  normal +x
      [3, 0, 4, 7]    // left,   normal -x
    ];
    var t = [];
    for (var q = 0; q < quads.length; q++) {
      var a = v[quads[q][0]], b = v[quads[q][1]], c = v[quads[q][2]], d = v[quads[q][3]];
      t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      t.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
    return opts.precise ? t : new Float32Array(t);
  }

  /* ------------------------------------------------------------- make */

  /* size(), then the geometry for whichever shape it sized. The sizing report
     rides along on the result, because every number a caller might want to put
     in a status line or a manifest is already in it. */
  function make(opts) {
    opts = opts || {};
    var sizing = size(opts);
    if (!sizing.ok) {
      return { ok: false, reason: sizing.reason, soup: null, sizing: sizing,
               fit: sizing.fit || null };
    }
    var precise = !!opts.precise;
    var m = sizing.measure;
    var opt = { precise: precise };
    var soup;
    /* One profile per shape and ONE revolve under all of them - the box is the
       only entry here that is not a solid of revolution. Adding a shape is a
       closed form and a meridian, which is the whole claim of this file. */
    if (sizing.shape === 'sphere') {
      soup = revolve(profileSphere(m.radius, sizing.profileN), sizing.segments, opt);
    } else if (sizing.shape === 'cylinder') {
      soup = revolve(profileCylinder(m.radius, m.height), sizing.segments, opt);
    } else if (sizing.shape === 'cone') {
      soup = revolve(profileCone(m.radius, m.height, m.top_radius), sizing.segments, opt);
    } else if (sizing.shape === 'tube') {
      soup = revolve(profileTube(m.radius, m.inner_radius, m.height), sizing.segments, opt);
    } else if (sizing.shape === 'torus') {
      soup = revolve(profileTorus(m.ring_radius, m.tube_radius, sizing.profileN),
                     sizing.segments, opt);
    } else if (sizing.shape === 'capsule') {
      soup = revolve(profileCapsule(m.radius, m.height, sizing.profileN), sizing.segments, opt);
    } else if (sizing.shape === 'ellipsoid') {
      soup = revolve(profileEllipsoid(m.radius, m.semi_height, sizing.profileN),
                     sizing.segments, opt);
    } else {
      soup = boxSoup(m.x, m.y, m.z, opt);
    }
    return {
      ok: true,
      reason: sizing.reason,
      soup: soup,
      sizing: sizing,
      size: sizing.size,
      fit: sizing.fit,
      warnings: sizing.warnings
    };
  }

  var API = {
    SHAPES: SHAPES,
    DEFAULTS: DEFAULTS,
    floor: floor,
    shell: shell,
    size: size,
    make: make,
    proportionsFrom: proportionsFrom,
    revolve: revolve,
    polygonFactor: polygonFactor,
    profileSphere: profileSphere,
    profileCylinder: profileCylinder,
    profileCone: profileCone,
    profileTube: profileTube,
    profileTorus: profileTorus,
    profileCapsule: profileCapsule,
    profileEllipsoid: profileEllipsoid,
    boxSoup: boxSoup
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Stock = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
