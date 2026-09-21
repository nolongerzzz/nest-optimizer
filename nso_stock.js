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

   All three are exact, which is worth saying plainly: the primitive's
   analytic volume IS `need`, to the last bit the cube root allows, and the
   self-test asserts that per shape rather than trusting the algebra.

   WHAT IS ON THE PLATE IS A SHADE LESS, and the report says by how much.
   Two separate deficits, neither of them an error:

     polygon_factor   a revolve at n segments inscribes an n-gon in every
                      circle, so the mesh holds n*sin(2pi/n)/(2pi) of the
                      solid. 0.9993 at n = 96. A box has no such factor and
                      its is exactly 1.
     built_volume     the SPHERE's meridian is itself an n-gon inscribed in a
                      semicircle, so the solid as built is under the sphere
                      that was asked for by another 0.027% at n = 96. A
                      cylinder's meridian is four straight segments and a
                      box's is not a meridian at all, so for those two
                      built_volume IS the analytic volume.

   The mesh holds built_volume x polygon_factor, exactly, for all three -
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
   SHAPES                          ['sphere', 'box', 'cylinder']
   DEFAULTS                        the frozen wall / waste / aspect figures
   floor(nozzle)                   -> mm, via NSO_Thickness.floorFor
   shell(opts)                     -> the Pappus thin-shell estimate alone
   size(opts)                      -> the full sizing report, no geometry
   make(opts)                      -> { ok, reason, soup, sizing, fit, warnings }
   proportionsFrom(rawTris, opts)  -> proportions off a reference piece
   revolve(loop, segments, opts)   -> a closed meridian loop, revolved
   profileSphere(a, n)             -> the sphere meridian
   profileCylinder(r, h)           -> the cylinder meridian
   boxSoup(sx, sy, sz, opts)       -> twelve triangles, centred, resting on z = 0

   ---------------------------------------------------------------------------
   OUT OF SCOPE, named so the next ticket does not re-derive it
   ---------------------------------------------------------------------------
   1. CONES, TUBES AND ROUNDED BLOCKS. Three shapes, each with one closed
      form and one tessellation, is the whole of this version. A cone is two
      lines in profileCylinder's place and a tube is three; neither is here,
      because neither has been asked for and an unused shape is an untested
      shape. The revolve underneath takes any r-as-a-function-of-z meridian,
      so adding one is a profile and a closed form, not a new mechanism.
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

  var SHAPES = ['sphere', 'box', 'cylinder'];
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
    profileN: 96
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
    if (opts.like) {
      ref = proportionsFrom(opts.like, opts.likeOpts || {});
      if (!ref.ok) return { ok: false, reason: ref.reason };
      rep.reference = { axis: ref.axis, proportions: ref.proportions, ratio: ref.ratio };
    }

    var segments = Math.max(12, Math.round(positive(opts.segments) ? opts.segments : DEFAULTS.segments));
    rep.segments = segments;

    if (shape === 'sphere') {
      var a = Math.cbrt(3 * need / (4 * Math.PI));
      rep.measure = { radius: a, diameter: 2 * a };
      rep.size = { x: 2 * a, y: 2 * a, z: 2 * a };
      rep.profileN = Math.max(24, Math.round(positive(opts.profileN) ? opts.profileN : DEFAULTS.profileN));
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
      rep.polygon_factor = segments * Math.sin(2 * Math.PI / segments) / (2 * Math.PI);
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

    } else {
      /* cylinder. Ratio, in order: explicit, then a reference piece, then the
         target's own height over its diameter. */
      var k, kFrom;
      if (positive(opts.ratio)) { k = +opts.ratio; kFrom = 'as asked'; }
      else if (ref) { k = ref.ratio; kFrom = 'off the reference piece (dominant axis ' + ref.axis + ')'; }
      else { k = sh.height / (2 * sh.radius); kFrom = 'the target\'s own height over diameter'; }
      if (!positive(k)) {
        return { ok: false, reason: 'cylinder height/diameter ratio must be positive - got ' + opts.ratio };
      }
      var r = Math.cbrt(need / (2 * Math.PI * k));
      var h = 2 * k * r;
      rep.measure = { radius: r, diameter: 2 * r, height: h, ratio: k, ratio_from: kFrom };
      rep.size = { x: 2 * r, y: 2 * r, z: h };
      rep.volume = Math.PI * r * r * h;
      /* A cylinder's meridian is four straight segments, so it is EXACT - the
         only deficit is the 96-gon cross-section, which polygon_factor holds. */
      rep.built_volume = loopVolume(profileCylinder(r, h));
      rep.polygon_factor = segments * Math.sin(2 * Math.PI / segments) / (2 * Math.PI);
      rep.measure_text = 'radius ' + r.toFixed(3) + ' mm x ' + h.toFixed(3) + ' mm tall (ratio ' +
        k.toFixed(3) + ', ' + kFrom + ')';
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

  /* The meridian of a sphere of radius a, resting on z = 0, sampled uniformly
     in POLAR ANGLE - which puts more z-resolution where the curvature is, at
     the poles, than uniform-in-z sampling would. */
  function profileSphere(a, n) {
    n = Math.max(24, Math.round(n || DEFAULTS.profileN));
    var out = new Array(n + 1);
    for (var i = 0; i <= n; i++) {
      var phi = Math.PI * i / n;                 // south pole (0) to north pole (pi)
      out[i] = { z: a - a * Math.cos(phi), r: a * Math.sin(phi) };
    }
    /* Pin the poles to the axis exactly - sin(pi) is 1.2e-16, not 0, and an r
       of 1.2e-16 makes a sliver ring instead of a fan. */
    out[0].r = 0; out[0].z = 0;
    out[n].r = 0; out[n].z = 2 * a;
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
    var soup;
    if (sizing.shape === 'sphere') {
      soup = revolve(profileSphere(sizing.measure.radius, sizing.profileN),
                     sizing.segments, { precise: precise });
    } else if (sizing.shape === 'cylinder') {
      soup = revolve(profileCylinder(sizing.measure.radius, sizing.measure.height),
                     sizing.segments, { precise: precise });
    } else {
      soup = boxSoup(sizing.measure.x, sizing.measure.y, sizing.measure.z, { precise: precise });
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
    profileSphere: profileSphere,
    profileCylinder: profileCylinder,
    boxSoup: boxSoup
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Stock = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
