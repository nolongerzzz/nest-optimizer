/* nso_assemble.js - Attach: seat one generated piece onto another, along the
   direction straight-line auto-aim works out.

   Loads as a classic script (window.NSO_Assemble) and as a Node module, the
   same way nso_support_aim.js and nso_stock.js do.

   ---------------------------------------------------------------------------
   THIS FILE IS CONNECTIVE TISSUE. There is no new geometry maths in it and
   there must never be any.
   ---------------------------------------------------------------------------

   Four shipped, tested pieces do all of the work and are CALLED, not copied:

     NSO_Stock.make            (nso_stock.js)          builds the two solids
     NSO_SupportAim.nearestBase(nso_support_aim.js)    which way, from where,
                                                       and is the line clear
     NSO_SupportAim.place      (nso_support_aim.js)    bakes the turn in
     NSO_extendRaw             (app-extend.js)         lengthens along +Z
     NSO_Thickness.floorFor    (nso_thickness.js)      the one wall floor
     NSO_unionSoups            (app-join.js)           the boolean - NOT called
                                                       from here, see "The
                                                       union is the caller's"

   What is left for this file is one sentence: the arm has to be SEATED, not
   merely aimed, and nothing in the aim module seats anything.

   ---------------------------------------------------------------------------
   WHY THE AIM MODULE CANNOT DO THIS ON ITS OWN - the finding, up front
   ---------------------------------------------------------------------------

   nso_support_aim.js's published composite call is aim(point, bases, opts).
   It builds its OWN solid: buildStrut() returns prism(side, seed), a square
   post, and there is no opts.soup. So a caller holding a piece it wants
   aimed - a Stock cylinder, a Stock box, an imported bit - cannot use aim()
   at all. It has to drop to the two halves, nearestBase() and place(), and
   write the sentence between them itself. That sentence is this file.

   And the sentence is not "call one then the other", because of the gap:

   place(soup, from, dir) puts the solid's local origin exactly ON the base
   surface. Local +Z becomes `dir`, local (0,0,0) becomes `from`. For a
   support that is right - a strut is meant to touch its target, not enter
   it - and aim()'s only engagement control, tipEngageMm, is at the far end,
   the TIP. For an assembly the overlap has to be at the near end, the ROOT,
   and there is no root-side control anywhere in that module.

   ZERO ENGAGEMENT IS A COIN FLIP, and which way it lands depends on the
   body's curvature. Measured with the same module calls, the same 8.453 mm
   cylinder arm, the shipped NSO_unionSoups (tools/nso_assemble_test.js §2):

     | body face                        | engage 0 -> union |
     |----------------------------------|-------------------|
     | box, flat face, straight on      | 1 part, PASS      |
     | box, flat face, 30 deg oblique   | 1 part, PASS      |
     | cylinder, flat top               | 1 part, PASS      |
     | cylinder, CURVED flank           | 2 parts, REFUSED  |

   The last row is the whole ticket. The arm's base cap is flat and the
   flank is not, so the disc rests on one facet of the 96-gon and the rest
   of its rim floats off the surface. The kernel is right to say the pieces
   do not touch, and the failure surfaces three calls downstream, out of
   NSO_unionSoups, as "the two pieces do not touch" - which reads like a bad
   aim and is not one.

   ---------------------------------------------------------------------------
   THE SEAT DEPTH IS MEASURED, NOT GUESSED, AND NOT NEW MATHS EITHER
   ---------------------------------------------------------------------------

   The right depth is "far enough that the WHOLE base rim is under the
   surface, plus one extrusion line". Both halves come from code that is
   already here:

     rootGapMm   the distance from the body's surface to the furthest-out
                 point of the arm's base rim. That is a nearest-point query
                 on a soup, and nso_support_aim.js already exposes exactly
                 that query: nearestBase(point, [{kind:'piece', soup}]) calls
                 closestOnSoup and reports `length`. So the rim points are
                 handed BACK to the same function that found the foot. No
                 second distance routine exists in this file.

     marginMm    NSO_Thickness.floorFor(nozzle) - nozzle x 1.05, 0.42 mm at a
                 0.4 nozzle. The same floor nso_support_aim.js, nso_skin.js
                 and tools/mesh_validate.py use, and for the same reason: a
                 joint shallower than one extrusion line is a joint the
                 slicer does not print. There is no literal here and no
                 default to fall back on - without nso_thickness.js this file
                 refuses, exactly as buildStrut() does.

     engageMm    rootGapMm + marginMm, unless the caller names one.

   rootGapMm is the root-side mirror of aim()'s tipPenetrationMm, and it is
   reported for the same stated reason: a rim floating 0.02 mm off a face is
   nothing and one floating 2 mm off is a support glued to air, and nothing
   downstream can tell those apart without the number.

   ---------------------------------------------------------------------------
   SINKING THE ARM SHORTENS IT - so Extend puts the length back
   ---------------------------------------------------------------------------

   A Stock arm's length is not a reach, it is the answer to a material
   sizing: NSO_Stock solved for it so the primitive holds a stated volume.
   Sink it by engageMm and the part you can see is engageMm shorter than the
   figure the Stock card printed.

   So by default the arm is grown by exactly engageMm FIRST, along its own
   local +Z, by NSO_extendRaw - and the order is nso_support_aim.js's order,
   for nso_support_aim.js's reason: grow on a cardinal axis, THEN turn. Turn
   first and there is no axis left for Extend to make its cross-section
   promise about. Nothing here reimplements a stretch.

   Extend refuses a piece with no straight axis - a Stock sphere, for one -
   and that refusal is passed through in Extend's own words rather than
   worked around. The seat still happens; the exposed length is then
   engageMm short and `keptLength` is false, which is a statement, not a
   silent difference.

   ---------------------------------------------------------------------------
   THE UNION IS THE CALLER'S
   ---------------------------------------------------------------------------

   NSO_unionSoups (app-join.js) is async, it loads a WASM kernel, and it
   lives in a file that needs THREE. This module is THREE-free and
   synchronous so it can be node-tested without a browser, so it returns the
   arm SEATED and stops there. The caller hands the two soups to the kernel
   it already has. app-assemble.js does it in the page;
   tools/nso_assemble_test.js does it in node against the same shipped
   adapter, spliced out of app-join.js rather than retyped.

   ---------------------------------------------------------------------------
   WHAT THE CALLER OWES: the arm's local frame
   ---------------------------------------------------------------------------

   place() maps local +Z onto the aim and local (0,0,0) onto the foot, so an
   arm is attachable iff its attach axis is +Z and its base sits on z = 0.
   That is not an assumption about this file's callers - it is what
   NSO_Stock.make() produces for all three shapes (centred on the axis,
   resting on z = 0) and what nso_support_aim.js's own prism() produces. It
   is CHECKED rather than trusted: baseOf() measures where the placed base
   cap actually landed relative to the foot and refuses by name when it is
   not there, so a solid modelled around its own centre is turned away
   instead of being seated half inside the body.

   PAINT SCOPE: NONE, for this module. It reads two soups and writes
   neither: what comes back is a NEW soup for the arm. The piece the arm is
   aimed at is never modified here. app-assemble.js, which DOES replace the
   body's geometry with the union, carries the paint check and declares its
   own scope - see docs/HANDOFF.md, "Scoping".
   ===================================================================== */
(function (root) {
  'use strict';

  /* Half a micron. Below this a placed base cap is "at the foot" - the gate
     is against a solid modelled around its centre, which misses by half its
     own length, not by float noise. */
  var BASE_TOL_MM = 5e-4;

  /* The rim is every vertex of the base cap. A cap vertex is one whose
     projection onto the aim is within this of the lowest such projection.
     Same order as BASE_TOL_MM and for the same reason. */
  var RIM_TOL_MM = 5e-4;

  var DEFAULTS = {
    baseTolMm: BASE_TOL_MM,
    rimTolMm: RIM_TOL_MM,
    keepLength: true
  };

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len3(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len3(a); return L > 1e-15 ? [a[0] / L, a[1] / L, a[2] / L] : null; }
  function finite3(p) {
    return !!p && p.length === 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
  }
  function triCount(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }

  /* ---------------------------------------------------------------- deps

     Every dependency is looked up the same way nso_support_aim.js looks its
     own up: an explicit opts override first (so a test can inject), then the
     global the page loads. A missing one is a refusal BY NAME, never a
     fallback - a second copy of a floor or a stretch is the thing this file
     exists not to be. */
  function dep(opts, key, globalName, probe) {
    var v = (opts && opts[key]) || (root && root[globalName]) ||
            (typeof globalThis !== 'undefined' ? globalThis[globalName] : null);
    if (!v) return null;
    if (probe && !probe(v)) return null;
    return v;
  }
  function aimDep(opts) {
    return dep(opts, 'aim', 'NSO_SupportAim', function (a) {
      return typeof a.nearestBase === 'function' && typeof a.place === 'function';
    });
  }
  function extendDep(opts) {
    var e = (opts && opts.extendRaw) || (root && root.NSO_extendRaw) ||
            (typeof globalThis !== 'undefined' ? globalThis.NSO_extendRaw : null);
    return (typeof e === 'function') ? e : null;
  }

  /* The margin, and the whole of it. nso_thickness.js is the one source; this
     file carries no 0.42, no nozzle * 1.05 and no default. Loaded without it,
     a caller who named no marginMm is refused. */
  function margin(opts) {
    opts = opts || {};
    if (typeof opts.marginMm === 'number' && isFinite(opts.marginMm) && opts.marginMm >= 0) {
      return { ok: true, mm: opts.marginMm, source: 'caller-supplied marginMm' };
    }
    var T = dep(opts, 'thickness', 'NSO_Thickness', function (t) {
      return typeof t.floorFor === 'function';
    });
    if (!T) {
      return { ok: false, mm: 0, source: null,
        reason: 'nso_thickness.js is not loaded, so the one-extrusion-line seat margin ' +
                'cannot be established - refusing rather than inventing one. Load it, or ' +
                'pass opts.marginMm with a measured extrusion width.' };
    }
    return { ok: true, mm: T.floorFor(opts.nozzle), source: 'NSO_Thickness.floorFor' };
  }

  /* ------------------------------------------------------------- the rim

     Where the arm's base cap landed, in world space, after a trial place()
     at zero engagement. Returned as the set of distinct vertices at the
     near end, plus how far off the foot's own plane that end sits - which
     is the gate on the caller's local frame. */
  function baseOf(placedSoup, from, dir, opts) {
    opts = opts || {};
    var tol = (opts.baseTolMm == null) ? BASE_TOL_MM : +opts.baseTolMm;
    var rimTol = (opts.rimTolMm == null) ? RIM_TOL_MM : +opts.rimTolMm;
    var n = triCount(placedSoup);
    if (!n) return { ok: false, reason: 'the arm has no triangles' };

    var lo = Infinity, hi = -Infinity, i, s;
    for (i = 0; i < n * 9; i += 3) {
      s = (placedSoup[i] - from[0]) * dir[0] +
          (placedSoup[i + 1] - from[1]) * dir[1] +
          (placedSoup[i + 2] - from[2]) * dir[2];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (Math.abs(lo) > tol) {
      return { ok: false, offsetMm: lo,
        reason: 'the arm\'s near end sits ' + lo.toFixed(4) + ' mm from the foot after ' +
          'placing, not on it - place() maps the solid\'s LOCAL ORIGIN onto the foot, so ' +
          'an attachable arm has its attach axis on +Z and its base on z = 0. That is what ' +
          'NSO_Stock.make() and NSO_SupportAim\'s own prism() both produce; a solid modelled ' +
          'around its own centre is not attachable as it stands.' };
    }

    var pts = [], seen = {}, q = 1 / Math.max(rimTol, 1e-9);
    for (i = 0; i < n * 9; i += 3) {
      s = (placedSoup[i] - from[0]) * dir[0] +
          (placedSoup[i + 1] - from[1]) * dir[1] +
          (placedSoup[i + 2] - from[2]) * dir[2];
      if (s - lo > rimTol) continue;
      var k = Math.round(placedSoup[i] * q) + ',' +
              Math.round(placedSoup[i + 1] * q) + ',' +
              Math.round(placedSoup[i + 2] * q);
      if (seen[k]) continue;
      seen[k] = 1;
      pts.push([placedSoup[i], placedSoup[i + 1], placedSoup[i + 2]]);
    }
    return { ok: true, points: pts, offsetMm: lo, lengthMm: hi - lo };
  }

  /* --------------------------------------------------------- the root gap

     How far the base rim floats off the body. Every rim point goes back
     through the SAME query that found the foot in the first place -
     nearestBase against the body as a piece - so there is exactly one
     nearest-point-on-a-soup implementation in play, and it is
     nso_support_aim.js's.

     The max over the rim is the number that matters: sink the arm by that
     much and no part of the rim is left outside the body.

     The distance is UNSIGNED - nearestBase measures to the surface and does
     not say which side of it the point is on - so on a concave face, where a
     rim point can already be inside the material, the gap reads as the
     distance back out to the skin and the seat comes out deeper than it
     needed to be. Deeper is the safe direction (the joint is still one
     solid), it is bounded by the concavity's own depth, and opts.engageMm
     overrides it. Naming it here rather than adding a sign test, because a
     signed query is a second implementation of the thing this file exists
     not to have a second implementation of. */
  function rootGap(bodySoup, rimPoints, opts) {
    opts = opts || {};
    var SA = aimDep(opts);
    if (!SA) {
      return { ok: false, reason: 'nso_support_aim.js is not loaded - its nearestBase is the ' +
        'nearest-point query this file measures the seat with, and nothing here reimplements one' };
    }
    var bases = [{ kind: 'piece', soup: bodySoup, id: 'body' }];
    var worst = 0, per = [], i;
    for (i = 0; i < rimPoints.length; i++) {
      /* minLength 0 so a rim point already ON the surface reads 0 rather
         than being rejected as "no room for a support here" - that is the
         strut question, and this is not it. */
      var nb = SA.nearestBase(rimPoints[i], bases, { minLength: 0 });
      if (!nb.ok) {
        /* nearestBase only fails here when the point coincides with the
           surface, which is a gap of zero and the answer we want. */
        per.push(0);
        continue;
      }
      per.push(nb.length);
      if (nb.length > worst) worst = nb.length;
    }
    return { ok: true, gapMm: worst, per: per, points: rimPoints.length };
  }

  /* ------------------------------------------------------------- attach

     opts, in the two shapes a caller actually has:

       target: [x,y,z]      the point the arm's free end should reach. The
                            headless shape: you know where the tip goes.
       at: [x,y,z]          the attachment point on the body, and
       dir: [x,y,z]         the way out of it. The APP's shape: a raycast hit
                            carries both, and the face normal is the only
                            place an outward direction comes from - see
                            "finding 4" in docs/ASSEMBLE.md. The target is
                            then at + dir x the arm's own length.

       engageMm             override the measured seat depth
       marginMm / nozzle    the margin on top of the measured gap
       keepLength           grow the arm by engageMm first, default true
       footTolMm            how far auto-aim's foot may sit from `at` before
                            the attach is refused; default the arm's own
                            half-width
       obstacles            soups the line must not cross; the body is added
       aim / extendRaw / thickness   injectable dependencies
  */
  function attach(bodySoup, armSoup, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'deps' };

    var SA = aimDep(opts);
    if (!SA) {
      out.reason = 'nso_support_aim.js is not loaded - its nearestBase is the direction ' +
        'finder and its place() is the bake, and this file is the sentence between them';
      return out;
    }
    if (!triCount(bodySoup)) { out.reason = 'the body has no triangles'; return out; }
    if (!triCount(armSoup)) { out.reason = 'the arm has no triangles'; return out; }

    /* ---- 1. where the arm's free end has to get to ---- */
    out.stage = 'target';
    var armLen = armSpan(armSoup);
    if (!(armLen > 0)) { out.reason = 'the arm has no extent along its own +Z'; return out; }
    out.armLengthMm = armLen;

    var target = null, at = null, want = null;
    if (opts.target) {
      if (!finite3(opts.target)) { out.reason = 'opts.target is not a finite 3-vector'; return out; }
      target = [opts.target[0], opts.target[1], opts.target[2]];
    } else if (opts.at && opts.dir) {
      if (!finite3(opts.at)) { out.reason = 'opts.at is not a finite 3-vector'; return out; }
      want = unit(opts.dir);
      if (!want) { out.reason = 'opts.dir is not a usable direction'; return out; }
      at = [opts.at[0], opts.at[1], opts.at[2]];
      target = [at[0] + want[0] * armLen, at[1] + want[1] * armLen, at[2] + want[2] * armLen];
    } else {
      out.reason = 'attach needs either opts.target (where the free end goes) or ' +
        'opts.at + opts.dir (the point on the body and the way out of it)';
      return out;
    }
    out.target = target;

    /* ---- 2. auto-aim's direction-finding, unaltered ----

       The body is both the base and an obstacle. Both ends of the segment
       are excluded from the blockage test by nearestBase's own epsilon, so
       the body's own surface at the foot is not read as blocking - that is
       the thing the arm is attaching to. A line that has to pass THROUGH
       the body to reach the target is refused, in nearestBase's words, and
       it should be: that is a curving path, which is out of scope there by
       name and out of scope here for the same reason. */
    out.stage = 'aim';
    var obstacles = [bodySoup].concat(opts.obstacles || []);
    var nb = SA.nearestBase(target, [{ kind: 'piece', soup: bodySoup, id: opts.bodyId || 'body' }],
                            { obstacles: obstacles, minLength: opts.minLength });
    out.aim = nb;
    if (!nb.ok) { out.reason = nb.reason; return out; }
    out.from = nb.from;
    out.dir = nb.dir;
    out.reachMm = nb.length;

    /* The foot auto-aim found is the nearest point on the body to the
       target, which on a picked attachment point should be the picked point
       itself. When it is not, the pick and the aim disagree - the user
       clicked one place and the arm would grow out of another - and that is
       reported rather than silently resolved in the aim's favour. */
    if (at) {
      var drift = len3(sub(nb.from, at));
      out.footDriftMm = drift;
      var footTol = (opts.footTolMm == null) ? Math.max(armWidth(armSoup) * 0.5, 1e-3)
                                             : +opts.footTolMm;
      if (drift > footTol) {
        out.reason = 'the point picked on the body and the nearest point to the aim are ' +
          drift.toFixed(3) + ' mm apart (over the ' + footTol.toFixed(3) + ' mm allowed): ' +
          'along that direction the arm would grow out of somewhere else. Pick a point the ' +
          'arm can leave straight, or pass opts.target and aim it yourself.';
        return out;
      }
    }

    /* ---- 3. trial seat at zero engagement, to find the rim ---- */
    out.stage = 'rim';
    var trial = SA.place(armSoup, nb.from, nb.dir, opts);
    if (!trial.ok) { out.reason = trial.reason; return out; }
    var base = baseOf(trial.soup, nb.from, nb.dir, opts);
    if (!base.ok) { out.reason = base.reason; out.baseOffsetMm = base.offsetMm; return out; }
    out.rimPoints = base.points.length;

    /* ---- 4. the measured seat depth ---- */
    out.stage = 'seat';
    var gap = rootGap(bodySoup, base.points, opts);
    if (!gap.ok) { out.reason = gap.reason; return out; }
    out.rootGapMm = gap.gapMm;

    var engage;
    if (typeof opts.engageMm === 'number' && isFinite(opts.engageMm)) {
      if (opts.engageMm < 0) { out.reason = 'engageMm must not be negative - a gap is not a seat'; return out; }
      engage = opts.engageMm;
      out.marginMm = null;
      out.marginSource = 'caller-supplied engageMm';
      out.seatedProud = engage < gap.gapMm;
    } else {
      var mg = margin(opts);
      if (!mg.ok) { out.reason = mg.reason; return out; }
      engage = gap.gapMm + mg.mm;
      out.marginMm = mg.mm;
      out.marginSource = mg.source;
      out.seatedProud = false;
    }
    out.engageMm = engage;

    /* ---- 5. put the length back, along +Z, BEFORE the turn ---- */
    out.stage = 'grow';
    var work = armSoup, kept = false, grown = null;
    var keep = (opts.keepLength == null) ? DEFAULTS.keepLength : !!opts.keepLength;
    if (keep && engage > 0) {
      var ext = extendDep(opts);
      if (!ext) {
        out.growWarning = 'app-extend.js is not loaded, so the arm cannot be lengthened to ' +
          'cover the seat - nothing here reimplements a stretch. The seat still happens and ' +
          'the exposed arm is ' + engage.toFixed(3) + ' mm shorter than its sized length.';
      } else {
        grown = ext(armSoup, { axis: 'z', length: armLen + engage, gate: true,
                               lengthUlps: opts.lengthUlps });
        if (grown.ok) { work = grown.tris; kept = true; }
        else {
          /* Extend's words, verbatim. A Stock sphere has no straight axis and
             is refused here for exactly the reason Extend refuses it; wrapping
             that in a new sentence is how two vocabularies for one event
             start - nso_support_aim.js's grow() makes the same point. */
          out.growWarning = 'the arm would not grow to cover the seat: ' + grown.reason;
        }
      }
    }
    out.grow = grown;
    out.keptLength = kept;

    /* ---- 6. the real seat: the same place(), a foot sunk by engageMm ---- */
    out.stage = 'place';
    var root = [nb.from[0] - nb.dir[0] * engage,
                nb.from[1] - nb.dir[1] * engage,
                nb.from[2] - nb.dir[2] * engage];
    var pl = SA.place(work, root, nb.dir, opts);
    out.place = pl;
    if (!pl.ok) { out.reason = pl.reason; return out; }

    out.ok = true;
    out.stage = 'done';
    out.soup = pl.soup;
    out.root = root;
    out.turnedDeg = pl.turnedDeg;
    out.exposedLengthMm = (kept ? armLen + engage : armLen) - engage;
    out.tip = [root[0] + nb.dir[0] * (kept ? armLen + engage : armLen),
               root[1] + nb.dir[1] * (kept ? armLen + engage : armLen),
               root[2] + nb.dir[2] * (kept ? armLen + engage : armLen)];
    out.reason = describe(out);
    return out;
  }

  /* The arm's own extent along +Z, which is what place() will lay along the
     aim, and its widest cross-section, which sets the default foot
     tolerance. Bounding-box reads, not a shape opinion. */
  function armSpan(soup) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 2; i < soup.length; i += 3) {
      if (soup[i] < lo) lo = soup[i];
      if (soup[i] > hi) hi = soup[i];
    }
    return (isFinite(lo) && isFinite(hi)) ? hi - lo : 0;
  }
  function armWidth(soup) {
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) {
      for (var k = 0; k < 2; k++) {
        if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
        if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
      }
    }
    return Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  }

  function describe(r) {
    if (!r) return '';
    if (!r.ok) return 'attach failed at the ' + r.stage + ' stage: ' + r.reason;
    var s = 'seated ' + r.engageMm.toFixed(3) + ' mm into the body (' +
      r.rootGapMm.toFixed(3) + ' mm rim gap' +
      (r.marginMm == null ? '' : ' + ' + r.marginMm.toFixed(3) + ' mm margin, ' + r.marginSource) +
      '), aimed along [' + r.dir.map(function (c) { return c.toFixed(4); }).join(', ') +
      '], ' + r.turnedDeg.toFixed(2) + ' deg turn baked in, ' +
      r.exposedLengthMm.toFixed(3) + ' mm of arm proud of the surface';
    if (r.keptLength) s += ' (length restored by Extend)';
    if (r.growWarning) s += ' - ' + r.growWarning;
    if (r.seatedProud) s += ' - NOTE: the asked engagement is under the ' +
      r.rootGapMm.toFixed(3) + ' mm rim gap, so part of the rim is still off the surface';
    return s;
  }

  var API = {
    DEFAULTS: DEFAULTS,
    attach: attach,
    rootGap: rootGap,
    baseOf: baseOf,
    armSpan: armSpan,
    armWidth: armWidth,
    margin: margin,
    describe: describe
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Assemble = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
