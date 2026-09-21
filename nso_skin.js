/* nso_skin.js - apply a contact "skin" (a fine relief pattern) onto the flat
   rectangular faces of a closed triangle soup - one face, several faces (the
   wrap), or two patterns stacked (the double skin) - and measure a skinned
   surface the way Seat needs it: by its contact TIPS, not its base plane.

   Loads as a classic script (window.NSO_Skin) and as a Node module
   (require('../nso_skin.js')). No DOM, no Three.js: a mesh is the app's raw
   soup, a Float32Array/Array of 9 numbers per triangle, in whatever axes the
   caller uses (the app's rawTris are Z up, millimetres, untranslated).

   ---------------------------------------------------------------------------
   WHAT THIS IS FOR - breakaway support through minimal contact
   ---------------------------------------------------------------------------
   A breakaway piece B is printed on top of a support block A. The weld between
   them is decided at the interface: a flat A face fuses B on solidly, an air
   gap never fuses (skin_join_test, validated separately). In between is
   genuine minimal contact: A's face carries a relief whose TIPS are all that
   B's face touches. This module makes that relief on A, on one face, in
   place, as a single closed shell. It does not touch B and it does not merge
   anything.

   ---------------------------------------------------------------------------
   THE TWO SURFACES A SKINNED FACE HAS
   ---------------------------------------------------------------------------
   base plane  the original flat face of A (before the skin), and the floor
               between the relief features afterwards
   tips plane  the plane the relief's highest points lie in - rib tops, ring
               top, ridge crests. In 'raise' mode it is `height` above the
               base plane; in 'recess' mode it IS the base plane and the
               valleys are cut down.

   "Flush / gap 0" for a breakaway piece means B's face sits ON THE TIPS. A
   seat that measures from the base plane buries B in the relief by the full
   skin height and prints a solid fuse, which is exactly the failure this
   module exists to avoid. supportExtreme() below is the measurement Seat
   uses: the hull's outermost point along the bit's normal, taken over the
   bit's footprint only, with every hull triangle clipped to that footprint
   first so a rib whose end vertices lie outside the footprint still counts
   where it passes under the bit.

   ---------------------------------------------------------------------------
   PATTERNS (all dimensions mm, heights along the face's outward normal)
   ---------------------------------------------------------------------------
   crosshatch  rib lattice: ribs along both in-plane axes, rectangular section
               `rib` wide, `pitch` apart, `height` tall, coplanar tops. The
               "fine mesh" skin. Contact = the lattice's top area. Defaults
               are one extrusion line wide (0.42 at a 0.4 nozzle - thinner and
               the slicer drops the rib, the coupon doc's rule), 1.2 pitch,
               0.6 tall (three 0.2 layers). NOTE: the physical reference
               (v8_FINAL's printed interface) is not in this repo as geometry,
               so these are stated defaults, every one a parameter.
               RIBS BOTH WAYS IN ONE LAYER IS A RELIEF, NOT A PRINTED
               LAYER, and the difference only shows when something is STACKED
               on it. Here it is right: the mating piece is a flat plate, so
               the tip area IS the contact and tipContactArea measures it. Set
               a second PATTERNED layer on it and it is wrong - a 90 degree
               copy's underside is the same lattice as the tips beneath it, so
               the two coincide instead of crossing and 519.750 mm^2, every
               square millimetre of tip, welds in a SINGLE patch; no other
               crossing angle rescues it either (measured,
               tools/nso_raster_line_audit.js parts 4-5). For a two-layer
               breakaway interface use nso_crosshatch.js, which builds this
               same pattern at this same pitch and rib the way a printer does -
               one direction per layer, two layers, the second crossing the
               first: 110.2500 mm^2 in 625 isolated crossings.
               docs/CROSSHATCH.md.
   crosshatch-fine
               the same lattice at 0.84 pitch instead of 1.2 - a PRESET, not a
               second builder (see `family` at PATTERNS). 1.43x the ribs per
               axis, leaving a 0.42 channel between them, which is exactly one
               extrusion line at a 0.4 nozzle and therefore the floor: tighter
               and the slicer fills the gap in. 0.4 NOZZLE ONLY - at a 0.6
               nozzle one line is 0.63, so 0.42 of air fuses, which is why
               `crosshatch` at 1.2 is still the default.
               docs/SKIN-CROSSHATCH-PITCH.md has the measurements.
   zigzag      parallel ridges with a trapezoid (sawtooth) section: `base`
               wide at the floor, `tip` wide at the crest, `height` tall,
               `pitch` apart, running along the face's second axis. Contact =
               the crests. The "line contact" family.
   ring        the coupon anchor tip: one tapered ring centred on the face,
               outer radius `rOut`, wall `wallBase` at the floor tapering to
               `wallTip` at the top, `height` tall. Contact = the thin annulus
               at the top. Raise mode only.

   mode 'raise' (default) adds the relief on top of the face; A grows by
   `height`. mode 'recess' cuts the valleys into A instead; the tips stay in
   the original face plane. `margin` keeps the pattern off the face edges
   (default: one pitch for the grid patterns, one wall for the ring).

   ---------------------------------------------------------------------------
   HOW THE FACE IS REPLACED (why the result is one watertight shell)
   ---------------------------------------------------------------------------
   findFace picks the planar face whose normal best matches the requested
   direction (the outermost one if several are parallel). Its boundary loop
   must reduce to a rectangle: 4 corners, right angles. The face triangles are
   removed and a relief surface is built over the same rectangle, whose
   perimeter is the ORIGINAL loop at height 0. Every perimeter vertex the
   relief introduces along a side is also inserted into the wall triangles
   that share that side (each such wall triangle becomes a fan), so no
   T-junction is left behind: every edge of the result is shared by exactly
   two triangles. Perimeter points are computed once, by the same lerp along
   the original corners, and reused bit-for-bit on both sides of the seam.

   applySkinToFace never returns a half-result: on any refusal the input soup
   is returned untouched with ok:false and a reason.

   ---------------------------------------------------------------------------
   SEVERAL FACES AT ONCE - the wrap
   ---------------------------------------------------------------------------
   applySkinWrap skins a list of faces (or all six axis faces) one after
   another on the growing soup. "Wrap" in this app's own sense, the one
   Soften's Full wrap has: all six faces of a box instead of the one you
   picked. NOT a curved wrap - every face is still a flat rectangle and a
   cylinder's side is still refused; docs/HANDOFF.md, "the OTHER wrap",
   records what a curved one would take.

   It is only correct because the SEAM between two skinned faces closes. Two
   opposite faces share no edge and always worked; two adjacent ones left 28
   open, 28 non-manifold and 28 degenerate on a 20 mm cube, from two causes
   now fixed and gated: the side parameter epsilon was absolute where the
   soup it reads is float32 (see makeSides), and the relief perimeter was
   never subdivided at the points the other face's relief put on the shared
   edge (see fanRelief).

   ---------------------------------------------------------------------------
   TWO LAYERS - the double skin
   ---------------------------------------------------------------------------
   Skinning an already-skinned face is refused, correctly: its tips are
   hundreds of separate rib tops, not one rectangle ("face boundary is not a
   single loop"). So a second layer is not a second pass. Two readings, both
   built, chosen by opts.layer2:

   composed  (layer2.free false) layer 2 rides on layer 1's TIPS in the same
             pass over one merged grid: h = h1 + (layer-1 tip ? h2 : 0). ONE
             closed shell, no flag, grid patterns only, raise only. The
             contact is the INTERSECTION of the two tip sets, so how much it
             shrinks is the second pattern's business - zigzag crests take a
             crosshatch to ~29%, a second crosshatch to ~84%, and layer 2 at
             layer 1's own parameters leaves it exactly where it was and only
             makes the relief taller. layer1TipArea rides on the result next
             to tipArea so a caller can say which happened.
   free      (layer2.free true) layer 2 is its OWN shell: a sheet resting on
             layer 1's tips carrying its own relief, a second breakaway
             interface. The piece then has TWO shells and stops being a closed
             solid, which is what the non-solid flag is for - the result says
             nonSolid: true and the caller is expected to set it. The sheet is
             inset to layer 1's margin so its walls stay out of the piece's
             own face planes. It bridges tip to tip when it prints.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   NSO_Skin.PATTERNS                      { name: { defaults, describe } }
   NSO_Skin.findFace(soup, dir, plane?)   -> face | null
                                          plane: optional offset n.p = plane;
                                          given, the group on THAT plane is
                                          taken instead of the outermost one
   NSO_Skin.applySkinToFace(soup, {
       dir: [x,y,z],                      face direction (outward normal)
       plane: number,                     optional, see findFace
       pattern: 'crosshatch'|'crosshatch-fine'|'zigzag'|'ring',
       params: {...},                     pattern parameters (see defaults)
       mode: 'raise'|'recess',
       layer2: {                          optional second layer
         pattern, params,                 its own smaller defaults, LAYER2_DEFAULTS
         free: bool,                      false: composed. true: its own shell
         sheet, gap, inset } })           free only (mm; gap 0 = resting on
                                          the tips, inset defaults to layer
                                          1's margin)
     -> { ok, reason?, tris, face, tipHeight, tipsPlane, basePlane,
          tipArea, reliefTris, params, pattern, mode, layers, shells,
          layer2?, layer1TipArea?, layer1TipsPlane?, freeLayer?, nonSolid? }
   NSO_Skin.applySkinWrap(soup, {
       faces: [{dir, plane?}, ...] | 'box',   default 'box' (six axis faces)
       skipUnskinnable: bool,             leave a face that cannot take a
                                          skin alone and name it, instead of
                                          standing the whole wrap down
       ...everything applySkinToFace takes })
     -> { ok, reason?, tris, faces[], skipped[], count, asked, tipArea,
          shells, nonSolid, describe }
   NSO_Skin.supportExtreme(soup, footprintCorners[4], normal, opts)
     -> { s, point, inside } | null      max of p.normal over soup within the
                                          footprint prism (opts.sMax caps it)
   NSO_Skin.tipContactArea(soup, footprintCorners, normal, sTips, tol)
     -> mm^2 of soup triangles lying in the tips plane, clipped to footprint
*/
(function (root) {
  'use strict';
  var PLANE_TOL = 0.05;   /* mm - a select entry's offset vs a face group's, same D_TOL as app-mask.js */

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
  /* a*(1-t) + b*t: exact a at t=0 and exact b at t=1, which a + t*(b-a) is not */
  function lerp(a, b, t) {
    var s = 1 - t;
    return [a[0] * s + b[0] * t, a[1] * s + b[1] * t, a[2] * s + b[2] * t];
  }
  function triAreaVec(a, b, c) { return scale(cross(sub(b, a), sub(c, a)), 0.5); }

  function triCount(soup) { return (soup.length / 9) | 0; }
  function vtx(soup, t, k) { var o = t * 9 + k * 3; return [soup[o], soup[o + 1], soup[o + 2]]; }
  function pushTri(out, a, b, c) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  /* push a triangle wound so its normal points along `want`; drop it if flat */
  function pushOriented(out, a, b, c, want) {
    var n = cross(sub(b, a), sub(c, a));
    var L = len(n);
    if (L < 1e-14) return false;
    if (dot(n, want) < 0) pushTri(out, a, c, b); else pushTri(out, a, b, c);
    return true;
  }
  function vkey(p) {
    return Math.round(p[0] * 1e4) + '_' + Math.round(p[1] * 1e4) + '_' + Math.round(p[2] * 1e4);
  }

  /* ------------------------------------------------------------ patterns

     `family` says which builder a pattern name uses, so a name can be a
     PRESET - the same geometry at different numbers - instead of a fourth
     builder. Everything downstream dispatches on the family, never on the
     name, which is what lets `crosshatch-fine` exist without touching
     crosshatchPlan, gridRelief or any caller that already handles the three
     shipped names.

     WHY A PRESET AND NOT A UI FIELD. `pitch` was ALREADY a parameter here -
     PATTERNS.crosshatch.defaults.pitch, merged by withDefaults, read by
     crosshatchPlan - and nothing was hardcoded. What was missing is a way to
     REACH it: index.html's #skin-pattern is a name-only select and no caller
     in app-skin.js or app-skin-patch.js has ever passed `params`, so from the
     app's seat 1.2 was the only pitch there was. A named preset is therefore
     the smallest thing that closes the gap: it arrives through the select
     every Skin control already reads, and the 1.2 default is untouched.

     crosshatch-fine's 0.84 is NOT a taste figure. The open channel a
     crosshatch leaves is pitch - rib, and with the rib held at one extrusion
     line the tightest pitch that still leaves a full line of air is
     rib + line = 0.42 + 0.42. Measured on the built mesh rather than
     asserted - see tools/nso_skin_fine_test.js, which rays the channel
     directly - and it is a 0.4-NOZZLE FIGURE: at a 0.6 nozzle one line is
     0.63 (nso_thickness.floorFor) and the same sum is 1.05, which is why the
     shipped 1.2 default is where it is and why it is the one that stays
     default. docs/SKIN-CROSSHATCH-PITCH.md carries the whole table. */
  var PATTERNS = {
    crosshatch: {
      family: 'crosshatch',
      defaults: { pitch: 1.2, rib: 0.42, height: 0.6, margin: null },
      describe: function (p) {
        return 'crosshatch lattice, rib ' + p.rib + ' mm, pitch ' + p.pitch + ' mm, ' + p.height + ' mm tall';
      }
    },
    /* The tighter-pitch preset. Same builder, same rib, same height as
       `crosshatch`; only the pitch moves, 1.2 -> 0.84, which is 1.43x the rib
       density and leaves exactly one 0.4-nozzle extrusion line of air between
       neighbouring ribs. 0.4 nozzle only. */
    'crosshatch-fine': {
      family: 'crosshatch',
      defaults: { pitch: 0.84, rib: 0.42, height: 0.6, margin: null },
      describe: function (p) {
        return 'fine crosshatch lattice, rib ' + p.rib + ' mm, pitch ' + p.pitch + ' mm (' +
          round3(p.pitch - p.rib) + ' mm channel), ' + p.height + ' mm tall';
      }
    },
    zigzag: {
      family: 'zigzag',
      defaults: { pitch: 2.0, base: 1.2, tip: 0.42, height: 0.6, margin: null },
      describe: function (p) {
        return 'sawtooth ridges, base ' + p.base + ' -> tip ' + p.tip + ' mm, pitch ' + p.pitch + ' mm, ' + p.height + ' mm tall';
      }
    },
    ring: {
      family: 'ring',
      defaults: { rOut: 5.0, wallBase: 0.8, wallTip: 0.4, height: 1.0, segments: 96, margin: null },
      describe: function (p) {
        return 'tapered ring, r ' + p.rOut + ' mm, wall ' + p.wallBase + ' -> ' + p.wallTip + ' mm, ' + p.height + ' mm tall';
      }
    }
  };

  function round3(x) { return Math.round(x * 1000) / 1000; }

  /* Which builder a pattern name uses. An unknown name answers with itself so
     every caller's existing "unknown pattern" refusal still fires. */
  function familyOf(name) {
    return (PATTERNS[name] && PATTERNS[name].family) || name;
  }

  /* The one grid dispatch, by family. */
  function gridPlan(name, fr, p, shift) {
    return familyOf(name) === 'crosshatch' ? crosshatchPlan(fr, p, shift) : zigzagPlan(fr, p, shift);
  }

  /* Layer 2 of a double skin: the same patterns at a smaller scale, so the
     second layer lands several features across one of layer 1's tips instead
     of one more rib exactly on top of it - layer 2 at layer 1's parameters
     only makes layer 1 taller, it does not shrink the contact. Stated
     defaults like layer 1's, every one a parameter. margin is 0 because
     layer 2 rides on layer 1's tips, which are already inside layer 1's own
     margin; it needs no rim of its own. */
  var LAYER2_DEFAULTS = {
    crosshatch: { pitch: 0.7, rib: 0.42, height: 0.3, margin: 0 },
    /* Stated rather than left to the PATTERNS fallback, which would hand
       layer 2 a null margin where the layer-2 convention is 0. The pitch does
       NOT tighten further: layer 2 is meant to land several features across
       one of layer 1's tips, and a fine crosshatch's tip is already one
       extrusion line wide, so there is nothing to land across. It stays at
       its own 0.84 and only the height halves. */
    'crosshatch-fine': { pitch: 0.84, rib: 0.42, height: 0.3, margin: 0 },
    zigzag: { pitch: 0.9, base: 0.5, tip: 0.25, height: 0.3, margin: 0 },
    ring: { rOut: 2.5, wallBase: 0.6, wallTip: 0.3, height: 0.5, margin: 0 }
  };

  function withDefaults(name, params) {
    var d = PATTERNS[name].defaults, out = {}, k;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    if (params) for (k in params) if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null) out[k] = params[k];
    return out;
  }

  /* Layer 2's parameters: its own smaller defaults, then whatever the
     caller named. Never layer 1's - the two layers are independent. */
  function withLayer2Defaults(name, params) {
    var d = LAYER2_DEFAULTS[name] || PATTERNS[name].defaults, out = {}, k;
    for (k in PATTERNS[name].defaults) if (Object.prototype.hasOwnProperty.call(PATTERNS[name].defaults, k)) out[k] = PATTERNS[name].defaults[k];
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    if (params) for (k in params) if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null) out[k] = params[k];
    return out;
  }

  /* ------------------------------------------------------------ face pick */

  /* Planar faces whose normal is within 30 degrees of dir, grouped by plane. */
  function findFace(soup, dir, plane) {
    var d = unit(dir);
    if (len(d) === 0) return null;
    /* plane (optional): the face's own offset n.p = plane, as a face select
       records it (app-mask.js). With it, the pick is the coplanar group ON
       that plane, not the outermost one along dir - which is what lets an
       explicitly selected pocket floor win over the hull face above it. */
    var wantPlane = (typeof plane === 'number' && isFinite(plane)) ? plane : null;
    var n = triCount(soup);
    var groups = [];
    for (var t = 0; t < n; t++) {
      var a = vtx(soup, t, 0), b = vtx(soup, t, 1), c = vtx(soup, t, 2);
      var nv = cross(sub(b, a), sub(c, a));
      var L = len(nv);
      if (L < 1e-14) continue;
      nv = scale(nv, 1 / L);
      var dd = dot(nv, d);
      if (dd < 0.866) continue;
      var off = dot(nv, a);
      var g = null;
      for (var i = 0; i < groups.length; i++) {
        if (dot(groups[i].n, nv) > 1 - 1e-6 && Math.abs(groups[i].d - off) < 1e-4) { g = groups[i]; break; }
      }
      if (!g) { g = { n: nv, d: off, dotDir: dd, tris: [], area: 0 }; groups.push(g); }
      g.tris.push(t);
      g.area += L * 0.5;
    }
    if (!groups.length) return null;
    var best = null;
    for (var k = 0; k < groups.length; k++) {
      var gk = groups[k];
      if (wantPlane !== null && Math.abs(gk.d - wantPlane) > PLANE_TOL) continue;
      if (!best || gk.dotDir > best.dotDir + 1e-4 ||
          (Math.abs(gk.dotDir - best.dotDir) <= 1e-4 && gk.d > best.d)) best = gk;
    }
    return best;
  }

  /* Boundary loop of a set of triangles: edges used once, walked in the
     winding direction. Null unless it is exactly one loop. */
  function boundaryLoop(soup, tris) {
    var count = new Map(), dir = new Map(), pts = new Map();
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var v = [vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)];
      var k = [vkey(v[0]), vkey(v[1]), vkey(v[2])];
      for (var e = 0; e < 3; e++) {
        var ka = k[e], kb = k[(e + 1) % 3];
        if (ka === kb) continue;
        if (!pts.has(ka)) pts.set(ka, v[e]);
        var ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        count.set(ek, (count.get(ek) || 0) + 1);
        dir.set(ek, [ka, kb]);
      }
    }
    var next = new Map(), nEdges = 0;
    count.forEach(function (c, ek) {
      if (c !== 1) return;
      var ab = dir.get(ek);
      if (next.has(ab[0])) { nEdges = -1; return; }
      next.set(ab[0], ab[1]);
      nEdges++;
    });
    if (nEdges < 3) return null;
    var start = next.keys().next().value, cur = start, loop = [], guard = 0;
    do {
      loop.push(pts.get(cur));
      cur = next.get(cur);
      if (cur === undefined) return null;
      if (++guard > nEdges + 1) return null;
    } while (cur !== start);
    if (loop.length !== nEdges) return null;
    return loop;
  }

  /* Drop collinear points; keep the corners. */
  function corners(loop) {
    var pts = loop.slice(), changed = true;
    while (changed && pts.length > 3) {
      changed = false;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[(i + pts.length - 1) % pts.length], q = pts[i], r = pts[(i + 1) % pts.length];
        var a = sub(q, p), b = sub(r, q);
        var la = len(a), lb = len(b);
        if (la < 1e-9 || len(cross(a, b)) < 1e-6 * la * lb) { pts.splice(i, 1); changed = true; break; }
      }
    }
    return pts;
  }

  /* --------------------------------------------- rectangle face frame */

  /* Returns { c: [c0,c1,c2,c3] CCW seen from +N, U, V, N, W, D } or a reason string. */
  function rectFrame(soup, face) {
    var loop = boundaryLoop(soup, face.tris);
    if (!loop) return 'face boundary is not a single loop';
    var cs = corners(loop);
    if (cs.length !== 4) return 'face is not a rectangle (' + cs.length + ' corners)';
    var e0 = sub(cs[1], cs[0]), e1 = sub(cs[2], cs[1]), e2 = sub(cs[3], cs[2]), e3 = sub(cs[0], cs[3]);
    var es = [e0, e1, e2, e3];
    for (var i = 0; i < 4; i++) {
      var a = es[i], b = es[(i + 1) % 4];
      if (Math.abs(dot(a, b)) > 1e-4 * len(a) * len(b)) return 'face corners are not right angles';
    }
    var nrm = unit(cross(e0, e1));
    if (dot(nrm, face.n) < 0) { cs.reverse(); cs.unshift(cs.pop()); nrm = scale(nrm, -1); }
    /* after a reverse the corner order is c0,c3,c2,c1 -> rotate so c0 stays first */
    e0 = sub(cs[1], cs[0]);
    var U = unit(e0), W = len(e0);
    var Vd = sub(cs[3], cs[0]);
    var V = unit(Vd), D = len(Vd);
    var N = unit(cross(U, V));
    if (dot(N, face.n) < 0.999) return 'face frame is not right-handed';
    if (W < 1e-6 || D < 1e-6) return 'face is degenerate';
    return { c: cs, U: U, V: V, N: N, W: W, D: D };
  }

  /* ------------------------------------------- perimeter bookkeeping */

  /* Sides run c0->c1 (v=0), c1->c2 (u=W), c2->c3 (v=D, u decreasing),
     c3->c0 (u=0, v decreasing). A side keeps sorted params t in [0,1] and
     the exact point for each; the same point object is what both the relief
     perimeter and the wall fans use. */
  /* side.eps is the seam tolerance `tol` (mm) expressed in THIS side's
     parameter. A fixed epsilon in t was right while a face was only ever
     skinned once from exact corners; it is wrong on a second face, because
     the soup it reads came back as a Float32Array, so a param recomputed
     from a stored point differs from the exact one that placed it by ~1e-7
     of the span. At 1e-9 the same point then registers twice, and the fan
     over it emits a zero-length edge - 28 degenerate triangles and 56 odd
     edges on two adjacent faces of a 20 mm cube, measured. */
  function makeSides(fr, tol) {
    var sides = [];
    for (var k = 0; k < 4; k++) {
      var a = fr.c[k], b = fr.c[(k + 1) % 4];
      var L = len(sub(b, a));
      sides.push({ a: a, b: b, ts: [0, 1], pts: [a, b],
                   eps: (L > 1e-9 && tol > 0) ? Math.max(1e-9, tol / L) : 1e-9 });
    }
    return sides;
  }
  function sideInsert(side, t, exactPt) {
    var eps = side.eps || 1e-9;
    if (t <= eps || t >= 1 - eps) return t <= eps ? side.pts[0] : side.pts[side.pts.length - 1];
    for (var i = 0; i < side.ts.length; i++) {
      if (Math.abs(side.ts[i] - t) < eps) return side.pts[i];
      if (side.ts[i] > t) {
        var p = exactPt || lerp(side.a, side.b, t);
        side.ts.splice(i, 0, t); side.pts.splice(i, 0, p);
        return p;
      }
    }
    return null;
  }
  /* param of point p along side, or null if not on the side segment */
  function sideParam(side, p, tol) {
    var ab = sub(side.b, side.a), L2 = dot(ab, ab);
    var t = dot(sub(p, side.a), ab) / L2;
    if (t < -1e-7 || t > 1 + 1e-7) return null;
    var foot = lerp(side.a, side.b, Math.min(1, Math.max(0, t)));
    if (len(sub(p, foot)) > tol) return null;
    return Math.min(1, Math.max(0, t));
  }

  /* Wall triangles that own a sub-segment of a side get their existing
     mid-side vertices registered, so the relief perimeter meets them. */
  function registerWallVertices(soup, faceSet, sides, tol) {
    var n = triCount(soup);
    for (var t = 0; t < n; t++) {
      if (faceSet.has(t)) continue;
      var v = [vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)];
      for (var e = 0; e < 3; e++) {
        var p = v[e], q = v[(e + 1) % 3];
        for (var k = 0; k < 4; k++) {
          var tp = sideParam(sides[k], p, tol), tq = sideParam(sides[k], q, tol);
          if (tp === null || tq === null) continue;
          sideInsert(sides[k], tp, p);
          sideInsert(sides[k], tq, q);
        }
      }
    }
  }

  /* The chain p -> q along whichever side it lies on, through every point
     registered on that side between them. Null when the edge is on no side.
     Consecutive points closer than `tol` collapse: a point registered from a
     float32 vertex and the exact break that placed it are the same point,
     and a chain step between them would be a zero-length edge. */
  function sideChain(p, q, sides, tol) {
    for (var k = 0; k < sides.length; k++) {
      var side = sides[k];
      var tp = sideParam(side, p, tol), tq = sideParam(side, q, tol);
      if (tp === null || tq === null) continue;
      var lo = Math.min(tp, tq), hi = Math.max(tp, tq), eps = side.eps || 1e-9;
      var mids = [];
      for (var i = 0; i < side.ts.length; i++) {
        if (side.ts[i] > lo + eps && side.ts[i] < hi - eps) mids.push(side.pts[i]);
      }
      if (tp > tq) mids.reverse();
      var chain = [p];
      for (var c = 0; c < mids.length; c++) {
        if (len(sub(mids[c], chain[chain.length - 1])) > tol && len(sub(mids[c], q)) > tol) chain.push(mids[c]);
      }
      chain.push(q);
      return chain;
    }
    return null;
  }

  /* One triangle, re-emitted so every registered side point on any of its
     edges is a vertex of it.
       no split edge   the triangle as it stands (legacy: a wall whose edge
                       lies on a side is re-emitted from that edge, which
                       rotates its vertex order - kept bit for bit so a face
                       skinned on its own comes out exactly as before)
       one split edge  the fan from the vertex opposite it
       two or three    split at the centroid first, so each piece has one
                       split edge and the three interior edges stay paired.
                       This is the corner cell where two skinned faces meet. */
  function fanTri(v, sides, tol, out, legacyRotate) {
    var chains = [null, null, null], first = -1, split = -1, nSplit = 0;
    for (var e = 0; e < 3; e++) {
      var ch = sideChain(v[e], v[(e + 1) % 3], sides, tol);
      chains[e] = ch;
      if (!ch) continue;
      if (first < 0) first = e;
      if (ch.length > 2) { if (split < 0) split = e; nSplit++; }
    }
    if (nSplit > 1) {
      var g = scale(add(add(v[0], v[1]), v[2]), 1 / 3);
      for (var e2 = 0; e2 < 3; e2++) {
        var ch2 = chains[e2] || [v[e2], v[(e2 + 1) % 3]];
        for (var c2 = 0; c2 + 1 < ch2.length; c2++) pushTri(out, ch2[c2], ch2[c2 + 1], g);
      }
      return 1;
    }
    var e0 = split >= 0 ? split : (legacyRotate ? first : -1);
    if (e0 < 0) { pushTri(out, v[0], v[1], v[2]); return 0; }
    var ch0 = chains[e0], apex = v[(e0 + 2) % 3];
    for (var c = 0; c + 1 < ch0.length; c++) pushTri(out, ch0[c], ch0[c + 1], apex);
    return 1;
  }

  /* Replace every wall triangle that shares a piece of a side with a fan
     over the side's registered points. */
  function fanWalls(soup, faceSet, sides, tol, out) {
    var n = triCount(soup), used = 0;
    for (var t = 0; t < n; t++) {
      if (faceSet.has(t)) continue;
      used += fanTri([vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)], sides, tol, out, true);
    }
    return used;
  }

  /* The same pass over the relief that was just built. Its perimeter knows
     its own breaks; when the face shares an edge with a face skinned before
     it, the seam also carries that relief's perimeter points, and the two
     must meet on every one of them. On a face skinned alone this inserts
     nothing and re-emits the relief triangle for triangle. */
  function fanRelief(relief, sides, tol, out) {
    var n = (relief.length / 9) | 0, used = 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      used += fanTri([[relief[o], relief[o + 1], relief[o + 2]],
                      [relief[o + 3], relief[o + 4], relief[o + 5]],
                      [relief[o + 6], relief[o + 7], relief[o + 8]]], sides, tol, out, false);
    }
    return used;
  }

  /* --------------------------------------------------- grid relief */

  /* A vertical wall between two cells sharing the edge P0->P1, heights
     (a0,a1) on side A and (b0,b1) on the other; sideA points from the edge
     into cell A. The wall faces the lower side. */
  function wallBetween(out, P0, P1, a0, a1, b0, b1, sideA, N) {
    var d0 = a0 - b0, d1 = a1 - b1;
    if (Math.abs(d0) < 1e-12 && Math.abs(d1) < 1e-12) return;
    if (d0 * d1 < 0) {
      var t = d0 / (d0 - d1);
      var Pc = lerp(P0, P1, t), hc = a0 + (a1 - a0) * t;
      wallBetween(out, P0, Pc, a0, hc, b0, hc, sideA, N);
      wallBetween(out, Pc, P1, hc, a1, hc, b1, sideA, N);
      return;
    }
    var want = (d0 + d1) > 0 ? scale(sideA, -1) : sideA;
    var A0 = add(P0, scale(N, a0)), A1 = add(P1, scale(N, a1));
    var B0 = add(P0, scale(N, b0)), B1 = add(P1, scale(N, b1));
    pushOriented(out, A0, A1, B1, want);
    pushOriented(out, A0, B1, B0, want);
  }

  function gridRelief(fr, sides, breaksU, breaksV, cellHeights, out) {
    var nu = breaksU.length - 1, nv = breaksV.length - 1;
    var W = fr.W, D = fr.D, N = fr.N, U = fr.U, V = fr.V, c0 = fr.c[0];
    /* one base point per grid node, perimeter nodes shared with the sides */
    var base = new Array((nu + 1) * (nv + 1));
    function idx(i, j) { return j * (nu + 1) + i; }
    var i, j;
    for (j = 0; j <= nv; j++) {
      for (i = 0; i <= nu; i++) {
        var u = breaksU[i], v = breaksV[j], p;
        if (j === 0) p = sideInsert(sides[0], u / W);
        else if (j === nv) p = sideInsert(sides[2], 1 - u / W);
        else if (i === 0) p = sideInsert(sides[3], 1 - v / D);
        else if (i === nu) p = sideInsert(sides[1], v / D);
        else p = add(c0, add(scale(U, u), scale(V, v)));
        base[idx(i, j)] = p;
      }
    }
    var H = new Array(nu * nv);
    var tipArea = 0, hmax = -Infinity;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h = cellHeights(breaksU[i], breaksU[i + 1], breaksV[j], breaksV[j + 1]);
      H[j * nu + i] = h;
      for (var q = 0; q < 4; q++) if (h[q] > hmax) hmax = h[q];
    }
    function lift(p, h) { return h === 0 ? p : add(p, scale(N, h)); }
    var reliefStart = out.length;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h4 = H[j * nu + i];
      var p00 = lift(base[idx(i, j)], h4[0]), p10 = lift(base[idx(i + 1, j)], h4[1]);
      var p11 = lift(base[idx(i + 1, j + 1)], h4[2]), p01 = lift(base[idx(i, j + 1)], h4[3]);
      pushOriented(out, p00, p10, p11, N);
      pushOriented(out, p00, p11, p01, N);
      if (Math.abs(h4[0] - hmax) < 1e-9 && Math.abs(h4[1] - hmax) < 1e-9 &&
          Math.abs(h4[2] - hmax) < 1e-9 && Math.abs(h4[3] - hmax) < 1e-9) {
        tipArea += (breaksU[i + 1] - breaksU[i]) * (breaksV[j + 1] - breaksV[j]);
      }
    }
    var negU = scale(U, -1), negV = scale(V, -1);
    /* walls on vertical grid lines */
    for (i = 0; i <= nu; i++) for (j = 0; j < nv; j++) {
      var P0 = base[idx(i, j)], P1 = base[idx(i, j + 1)];
      var L = i > 0 ? H[j * nu + i - 1] : null, R = i < nu ? H[j * nu + i] : null;
      var a0 = L ? L[1] : 0, a1 = L ? L[2] : 0;   /* left cell's right edge */
      var b0 = R ? R[0] : 0, b1 = R ? R[3] : 0;   /* right cell's left edge */
      wallBetween(out, P0, P1, a0, a1, b0, b1, negU, N);
    }
    /* walls on horizontal grid lines */
    for (j = 0; j <= nv; j++) for (i = 0; i < nu; i++) {
      var Q0 = base[idx(i, j)], Q1 = base[idx(i + 1, j)];
      var B = j > 0 ? H[(j - 1) * nu + i] : null, T = j < nv ? H[j * nu + i] : null;
      var c0h = B ? B[3] : 0, c1h = B ? B[2] : 0;  /* bottom cell's top edge */
      var d0h = T ? T[0] : 0, d1h = T ? T[1] : 0;  /* top cell's bottom edge */
      wallBetween(out, Q0, Q1, c0h, c1h, d0h, d1h, negV, N);
    }
    return { tipArea: tipArea, hmax: hmax, reliefTris: (out.length - reliefStart) / 9 };
  }

  /* rib intervals centred on a span L, inset by margin */
  function ribIntervals(L, rib, pitch, margin) {
    var free = L - 2 * margin;
    if (free < rib) return [];
    var k = Math.floor((free - rib) / pitch) + 1;
    var total = (k - 1) * pitch + rib;
    var start = (L - total) / 2;
    var iv = [];
    for (var i = 0; i < k; i++) iv.push([start + i * pitch, start + i * pitch + rib]);
    return iv;
  }
  function inAny(x, ivs) {
    for (var i = 0; i < ivs.length; i++) if (x > ivs[i][0] && x < ivs[i][1]) return true;
    return false;
  }
  function uniqSorted(arr) {
    arr.sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < arr.length; i++) if (!out.length || arr[i] - out[out.length - 1] > 1e-9) out.push(arr[i]);
    return out;
  }
  function withinSpan(arr, L) {
    var out = [0];
    for (var i = 0; i < arr.length; i++) if (arr[i] > 1e-9 && arr[i] < L - 1e-9) out.push(arr[i]);
    out.push(L);
    return uniqSorted(out);
  }

  /* In recess mode the margin band is a rim left at the original plane: the
     valleys stop short of the face edge, so the block's side walls are never
     duplicated. Recess therefore needs margin > 0. */
  function rimCheck(margin, shift) {
    if (shift < 0 && !(margin > 0)) return 'recess needs a margin > 0 (the rim the valleys stop at)';
    return null;
  }
  function isRim(u0, u1, v0, v1, W, D, margin) {
    var um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    return um < margin || um > W - margin || vm < margin || vm > D - margin;
  }

  function crosshatchPlan(fr, p, shift) {
    var margin = p.margin == null ? p.pitch : p.margin;
    var bad = rimCheck(margin, shift);
    if (bad) return bad;
    var ivU = ribIntervals(fr.W, p.rib, p.pitch, margin);
    var ivV = ribIntervals(fr.D, p.rib, p.pitch, margin);
    if (!ivU.length || !ivV.length) return 'face too small for the crosshatch (rib ' + p.rib + ', margin ' + margin + ')';
    var bu = [margin, fr.W - margin], bv = [margin, fr.D - margin], i;
    for (i = 0; i < ivU.length; i++) bu.push(ivU[i][0], ivU[i][1]);
    for (i = 0; i < ivV.length; i++) bv.push(ivV[i][0], ivV[i][1]);
    var h = p.height;
    return {
      breaksU: withinSpan(bu, fr.W), breaksV: withinSpan(bv, fr.D),
      cellHeights: function (u0, u1, v0, v1) {
        if (isRim(u0, u1, v0, v1, fr.W, fr.D, margin)) return [0, 0, 0, 0];
        var raised = inAny((u0 + u1) / 2, ivU) || inAny((v0 + v1) / 2, ivV);
        var z = (raised ? h : 0) + shift;
        return [z, z, z, z];
      },
      ribsU: ivU.length, ribsV: ivV.length, margin: margin,
      /* The rib spans themselves, published so a caller that has to BUTT
         something against the outermost rib can find it instead of guessing
         from breaksU. ribIntervals centres k ribs in the free span, so the
         first one starts at ivU[0][0] >= margin and the leftover is split
         evenly at the two ends - a sliver channel a frame has to swallow.
         Read-only: the plan owns these. */
      ivU: ivU, ivV: ivV
    };
  }

  function zigzagPlan(fr, p, shift) {
    var margin = p.margin == null ? p.pitch : p.margin;
    var bad = rimCheck(margin, shift);
    if (bad) return bad;
    if (p.tip > p.base) return 'zigzag tip must not be wider than its base';
    var ridges = ribIntervals(fr.W, p.base, p.pitch, margin);
    if (!ridges.length) return 'face too small for the zigzag ridges (base ' + p.base + ', margin ' + margin + ')';
    if (fr.D - 2 * margin <= 0) return 'face too small for the zigzag ridges (margin ' + margin + ')';
    var bu = [margin, fr.W - margin], i;
    var flank = (p.base - p.tip) / 2;
    for (i = 0; i < ridges.length; i++) {
      var b0 = ridges[i][0], b1 = ridges[i][1];
      bu.push(b0, b0 + flank, b1 - flank, b1);
    }
    var v0m = margin, v1m = fr.D - margin;
    var h = p.height;
    function profile(u) {
      for (var k = 0; k < ridges.length; k++) {
        var b0 = ridges[k][0], b1 = ridges[k][1];
        if (u < b0 || u > b1) continue;
        if (flank < 1e-12) return h;
        if (u < b0 + flank) return h * (u - b0) / flank;
        if (u > b1 - flank) return h * (b1 - u) / flank;
        return h;
      }
      return 0;
    }
    return {
      breaksU: withinSpan(bu, fr.W), breaksV: withinSpan([v0m, v1m], fr.D),
      cellHeights: function (u0, u1, v0, v1) {
        if (isRim(u0, u1, v0, v1, fr.W, fr.D, margin)) return [0, 0, 0, 0];
        var h0 = profile(u0) + shift, h1 = profile(u1) + shift;
        return [h0, h1, h1, h0];
      },
      ridges: ridges.length, margin: margin
    };
  }

  /* --------------------------------------------------- ring relief */

  function ringRelief(fr, sides, p, out) {
    var margin = p.margin == null ? p.wallBase : p.margin;
    var half = Math.min(fr.W, fr.D) / 2;
    if (p.rOut + margin > half) return 'ring r ' + p.rOut + ' + margin ' + margin + ' does not fit a ' + fr.W.toFixed(2) + ' x ' + fr.D.toFixed(2) + ' face';
    if (p.wallTip > p.wallBase || p.wallTip <= 0) return 'ring wall must taper: 0 < wallTip <= wallBase';
    if (p.wallBase >= p.rOut) return 'ring wall thicker than its radius';
    var seg = Math.max(12, p.segments | 0);
    var taper = (p.wallBase - p.wallTip) / 2;
    var rOut0 = p.rOut, rOut1 = p.rOut - taper;
    var rIn0 = p.rOut - p.wallBase, rIn1 = rIn0 + taper;
    var h = p.height;
    var U = fr.U, V = fr.V, N = fr.N;
    var C = add(fr.c[0], add(scale(U, fr.W / 2), scale(V, fr.D / 2)));
    var reliefStart = out.length;

    function circle(r, z) {
      var pts = [];
      for (var k = 0; k < seg; k++) {
        var th = 2 * Math.PI * k / seg;
        var q = add(C, add(scale(U, r * Math.cos(th)), scale(V, r * Math.sin(th))));
        if (z) q = add(q, scale(N, z));
        pts.push(q);
      }
      return pts;
    }
    var out0 = circle(rOut0, 0), out1 = circle(rOut1, h), in1 = circle(rIn1, h), in0 = circle(rIn0, 0);
    var radial = [];
    for (var k = 0; k < seg; k++) {
      var th = 2 * Math.PI * k / seg;
      radial.push(add(scale(U, Math.cos(th)), scale(V, Math.sin(th))));
    }
    function strip(A, B, wantFn) {
      for (var k = 0; k < seg; k++) {
        var k1 = (k + 1) % seg, w = wantFn(k);
        pushOriented(out, A[k], A[k1], B[k1], w);
        pushOriented(out, A[k], B[k1], B[k], w);
      }
    }
    strip(out0, out1, function (k) { return radial[k]; });                 /* outer wall */
    strip(out1, in1, function () { return N; });                          /* top annulus */
    strip(in1, in0, function (k) { return scale(radial[k], -1); });       /* inner wall */
    for (var f = 0; f < seg; f++) pushOriented(out, C, in0[f], in0[(f + 1) % seg], N); /* floor disk */

    /* the floor outside the ring: zipper between the rectangle loop and out0 */
    var rectPts = [];
    var hw = fr.W / 2, hd = fr.D / 2;
    for (var s = 0; s < seg; s++) {
      var ang = 2 * Math.PI * s / seg, cs = Math.cos(ang), sn = Math.sin(ang);
      var tEdge = Math.min(Math.abs(cs) > 1e-12 ? hw / Math.abs(cs) : Infinity,
                           Math.abs(sn) > 1e-12 ? hd / Math.abs(sn) : Infinity);
      var x = cs * tEdge, y = sn * tEdge;   /* local, centred */
      var pt;
      if (Math.abs(Math.abs(x) - hw) < 1e-9 * Math.max(1, hw)) {
        /* on a u = const side: right side (k=1) runs v 0->D, left (k=3) runs v D->0 */
        if (x > 0) pt = sideInsert(sides[1], (y + hd) / fr.D);
        else pt = sideInsert(sides[3], 1 - (y + hd) / fr.D);
      } else {
        /* on a v = const side: bottom (k=0) runs u 0->W, top (k=2) runs u W->0 */
        if (y < 0) pt = sideInsert(sides[0], (x + hw) / fr.W);
        else pt = sideInsert(sides[2], 1 - (x + hw) / fr.W);
      }
      if (pt) rectPts.push(pt);
    }
    /* every registered side point, in CCW order, with its angle about C */
    var loopPts = [];
    for (var sd = 0; sd < 4; sd++) {
      var side = sides[sd];
      for (var q = 0; q < side.pts.length - 1; q++) loopPts.push(side.pts[q]);
    }
    function angleOf(pt) {
      var d = sub(pt, C);
      var a = Math.atan2(dot(d, V), dot(d, U));
      return a < 0 ? a + 2 * Math.PI : a;
    }
    var rect = loopPts.map(function (pt) { return { p: pt, a: angleOf(pt) }; })
      .sort(function (x, y) { return x.a - y.a; });
    var inner = out0.map(function (pt, k) { return { p: pt, a: 2 * Math.PI * k / seg }; });
    var i = 0, j = 0, nr = rect.length, ni = inner.length;
    var steps = nr + ni;
    for (var st = 0; st < steps; st++) {
      var aR = rect[(i + 1) % nr].a + (i + 1 >= nr ? 2 * Math.PI : 0);
      var aI = inner[(j + 1) % ni].a + (j + 1 >= ni ? 2 * Math.PI : 0);
      if (i < nr && (j >= ni || aR <= aI)) {
        pushOriented(out, rect[i % nr].p, rect[(i + 1) % nr].p, inner[j % ni].p, N);
        i++;
      } else {
        pushOriented(out, rect[i % nr].p, inner[(j + 1) % ni].p, inner[j % ni].p, N);
        j++;
      }
    }
    var tipArea = Math.PI * (rOut1 * rOut1 - rIn1 * rIn1);
    return { tipArea: tipArea, hmax: h, reliefTris: (out.length - reliefStart) / 9, margin: margin,
             rOutTop: rOut1, rInTop: rIn1 };
  }

  /* ------------------------------------------- layered (double) skin */

  /* Two patterns in ONE pass, on one merged grid, layer 2 riding on layer 1's
     TIPS:  h(cell) = h1(cell) + (cell is a layer-1 tip ? h2(cell) : 0).
     The floor between layer 1's features keeps its height and only the
     surface B would have touched is skinned again, so the contact area can
     only shrink. The result is still ONE closed shell - nothing about the
     piece's closure changes, and no flag is needed for it.

     Why one pass and not two calls: a skinned face is no longer a face.
     applySkinToFace's second pass over its own output refuses with "face
     boundary is not a single loop" (the tips are hundreds of separate rib
     tops, not one rectangle), and that refusal is correct - measured, not
     assumed. Composition happens in the height field, where both patterns
     are still plans. */
  function mergeBreaks(a, b, eps) {
    var all = a.concat(b);
    all.sort(function (x, y) { return x - y; });
    var out = [];
    for (var i = 0; i < all.length; i++) if (!out.length || all[i] - out[out.length - 1] > eps) out.push(all[i]);
    return out;
  }
  /* Layer 1's own contact area, measured over the MERGED grid so it is the
     same measurement the composite's tipArea is - what the contact would
     have been with layer 1 alone. */
  function layer1TipArea(fr, breaksU, breaksV, cells1, h1max) {
    if (typeof cells1 !== 'function') return 0;
    var area = 0;
    for (var j = 0; j + 1 < breaksV.length; j++) {
      for (var i = 0; i + 1 < breaksU.length; i++) {
        var h = cells1(breaksU[i], breaksU[i + 1], breaksV[j], breaksV[j + 1]);
        var tip = true;
        for (var k = 0; k < 4; k++) if (Math.abs(h[k] - h1max) > 1e-9) { tip = false; break; }
        if (tip) area += (breaksU[i + 1] - breaksU[i]) * (breaksV[j + 1] - breaksV[j]);
      }
    }
    return area;
  }

  function composePlans(plan1, plan2, h1max, eps) {
    return {
      breaksU: mergeBreaks(plan1.breaksU, plan2.breaksU, eps),
      breaksV: mergeBreaks(plan1.breaksV, plan2.breaksV, eps),
      cellHeights: function (u0, u1, v0, v1) {
        var a = plan1.cellHeights(u0, u1, v0, v1);
        for (var k = 0; k < 4; k++) if (Math.abs(a[k] - h1max) > 1e-9) return a;
        var b = plan2.cellHeights(u0, u1, v0, v1);
        return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
      },
      margin: plan1.margin, ribsU: plan1.ribsU, ribsV: plan1.ribsV, ridges: plan1.ridges
    };
  }

  /* ------------------------------------------- free layer (its own shell) */

  /* A closed box in the face's frame: u0..u1 x v0..v1, h0..h1 along N. */
  function boxSoup(fr, u0, u1, v0, v1, h0, h1) {
    function P(u, v, h) {
      return add(fr.c[0], add(add(scale(fr.U, u), scale(fr.V, v)), scale(fr.N, h)));
    }
    var b = [P(u0, v0, h0), P(u1, v0, h0), P(u1, v1, h0), P(u0, v1, h0)];
    var t = [P(u0, v0, h1), P(u1, v0, h1), P(u1, v1, h1), P(u0, v1, h1)];
    var out = [], negN = scale(fr.N, -1), k, k1, want;
    pushOriented(out, b[0], b[1], b[2], negN);
    pushOriented(out, b[0], b[2], b[3], negN);
    pushOriented(out, t[0], t[1], t[2], fr.N);
    pushOriented(out, t[0], t[2], t[3], fr.N);
    for (k = 0; k < 4; k++) {
      k1 = (k + 1) % 4;
      want = cross(sub(b[k1], b[k]), fr.N);
      pushOriented(out, b[k], b[k1], t[k1], want);
      pushOriented(out, b[k], t[k1], t[k], want);
    }
    return new Float32Array(out);
  }

  /* The OTHER reading of a double skin: layer 2 as a sheet that rests on
     layer 1's tips and carries its own relief on top - a second breakaway
     interface, free-hanging, not fused to the piece. It is its own closed
     shell, built as a slab and skinned through this same engine, so the
     piece it joins carries TWO shells and stops being a closed solid. That
     is not a defect to hide: it is exactly what the non-solid flag is for
     (docs/NON-SOLID.md), and the caller is handed `nonSolid: true` to say so.
     Printing note, stated rather than measured: the sheet bridges from tip
     to tip, so its first layer prints over air. */
  function freeLayerShell(fr, hRest, basePlane, opts2) {
    var name = opts2.pattern || 'crosshatch';
    if (!PATTERNS[name]) return 'free layer: unknown pattern "' + name + '"';
    var sheet = opts2.sheet == null ? 0.6 : opts2.sheet;
    var gap = opts2.gap == null ? 0 : opts2.gap;
    /* The sheet is inset by layer 1's margin by default, which is where
       layer 1's features stop anyway - so the sheet covers the tips and
       nothing else. It also keeps the sheet's side walls OUT of the piece's
       own face planes: flush with them, they join those faces' coplanar
       groups, and the next face pick then sees two loops where it needs one
       ("face boundary is not a single loop" - measured on a wrap that put a
       free layer on +Z and then asked for +X). */
    var inset = opts2.inset == null ? (opts2.margin || 0) : opts2.inset;
    if (!(sheet > 0)) return 'free layer: sheet thickness must be positive';
    if (!(gap >= 0)) return 'free layer: gap must not be negative (it would sink into layer 1)';
    if (!(inset >= 0)) return 'free layer: inset must not be negative';
    var u0 = inset, u1 = fr.W - inset, v0 = inset, v1 = fr.D - inset;
    if (!(u1 - u0 > 1e-6) || !(v1 - v0 > 1e-6)) return 'free layer: inset ' + inset + ' leaves no sheet on a ' + fr.W.toFixed(2) + ' x ' + fr.D.toFixed(2) + ' face';
    var h0 = hRest + gap, h1 = h0 + sheet;
    var box = boxSoup(fr, u0, u1, v0, v1, h0, h1);
    var r = applySkinToFace(box, { dir: fr.N, pattern: name, params: opts2.params, mode: 'raise' });
    if (!r.ok) return 'free layer: ' + r.reason;
    return {
      tris: r.tris,
      shellTris: (r.tris.length / 9) | 0,
      pattern: name, params: r.params, describe: r.describe,
      sheet: sheet, gap: gap, inset: inset,
      restsOnPlane: basePlane + h0,
      sheetTopPlane: basePlane + h1,
      tipsPlane: r.tipsPlane,
      tipHeight: r.tipHeight,
      tipArea: r.tipArea,
      nonSolid: true
    };
  }

  /* ------------------------------------------------------- apply */

  function applySkinToFace(soup, opts) {
    opts = opts || {};
    var res = { ok: false, tris: soup };
    var name = opts.pattern || 'crosshatch';
    if (!PATTERNS[name]) { res.reason = 'unknown pattern "' + name + '"'; return res; }
    var p = withDefaults(name, opts.params);
    var mode = opts.mode || 'raise';
    if (mode !== 'raise' && mode !== 'recess') { res.reason = 'mode must be raise or recess'; return res; }
    if (!(p.height > 0)) { res.reason = 'height must be positive'; return res; }
    if (!soup || triCount(soup) < 4) { res.reason = 'empty soup'; return res; }
    /* layer 2: composed onto layer 1's tips (one shell), or free - its own
       shell resting on them. Two readings of "double skin", both built, and
       the caller says which; see composePlans and freeLayerShell. */
    var l2 = opts.layer2 || null;
    var layered = !!(l2 && l2.pattern !== 'off' && l2.pattern !== false);
    var l2name = layered ? (l2.pattern || 'crosshatch') : null;
    if (layered && !PATTERNS[l2name]) { res.reason = 'unknown layer 2 pattern "' + l2name + '"'; return res; }
    var freeReq = !!(layered && l2.free);
    if (freeReq && mode !== 'raise') { res.reason = 'a free second layer is raise-only (it rests on layer 1\'s tips)'; return res; }
    var tol = 1e-4;          /* mm - the seam tolerance, see makeSides */
    var dir = opts.dir || [0, 0, 1];
    var face = findFace(soup, dir, opts.plane);
    if (!face) {
      res.reason = (typeof opts.plane === 'number')
        ? 'no flat face on the selected plane (n.p = ' + opts.plane.toFixed(3) + ') within 30 degrees of its normal'
        : 'no flat face within 30 degrees of the requested direction';
      return res;
    }
    var fr = rectFrame(soup, face);
    if (typeof fr === 'string') { res.reason = fr; return res; }

    var faceSet = new Set(face.tris);
    var sides = makeSides(fr, tol);
    registerWallVertices(soup, faceSet, sides, tol);

    var relief = [];
    var info;
    var shift = mode === 'recess' ? -p.height : 0;
    /* layer 2, composed: it rides on layer 1's tips in the SAME pass, so the
       two are one height field and one shell. Only the grid patterns have a
       height field to compose; the ring builds its own surface, which is why
       it can only carry a free layer, not a composed one. */
    var p2 = null;
    if (layered && !freeReq) {
      if (mode !== 'raise') { res.reason = 'a composed second layer is raise-only (it is built on layer 1\'s tips)'; return res; }
      if (familyOf(name) === 'ring' || familyOf(l2name) === 'ring') {
        res.reason = 'a composed second layer needs two grid patterns (crosshatch or zigzag); ring has no height field to compose - use a free layer for it';
        return res;
      }
      p2 = withLayer2Defaults(l2name, l2.params);
      if (!(p2.height > 0)) { res.reason = 'layer 2 height must be positive'; return res; }
    }
    if (familyOf(name) === 'ring') {
      if (mode === 'recess') { res.reason = 'ring is raise-only'; return res; }
      info = ringRelief(fr, sides, p, relief);
      if (typeof info === 'string') { res.reason = info; return res; }
    } else {
      var plan = gridPlan(name, fr, p, shift);
      if (typeof plan === 'string') { res.reason = plan; return res; }
      if (p2) {
        var plan2 = gridPlan(l2name, fr, p2, 0);
        if (typeof plan2 === 'string') { res.reason = 'layer 2: ' + plan2; return res; }
        var cells1 = plan.cellHeights;
        plan = composePlans(plan, plan2, p.height, tol);
        plan.layer1Cells = cells1;
      }
      info = gridRelief(fr, sides, plan.breaksU, plan.breaksV, plan.cellHeights, relief);
      if (p2) info.layer1TipArea = layer1TipArea(fr, plan.breaksU, plan.breaksV, plan.layer1Cells, p.height);
      info.margin = plan.margin;
      if (plan.ribsU != null) { info.ribsU = plan.ribsU; info.ribsV = plan.ribsV; }
      if (plan.ridges != null) info.ridges = plan.ridges;
    }

    var out = [];
    var fanned = fanWalls(soup, faceSet, sides, tol, out);
    var reliefFanned = fanRelief(relief, sides, tol, out);

    /* the composite's own tips, not layer 1's stated height: with a composed
       layer 2 the highest cell is h1 + h2, and gridRelief measured it. */
    var tipsOffset = mode === 'recess' ? 0 : (p2 ? info.hmax : p.height);
    var freeLayer = null;
    if (freeReq) {
      freeLayer = freeLayerShell(fr, tipsOffset, face.d, {
        pattern: l2name, params: l2.params, sheet: l2.sheet, gap: l2.gap, inset: l2.inset,
        margin: info.margin
      });
      if (typeof freeLayer === 'string') { res.reason = freeLayer; return res; }
      for (var f = 0; f < freeLayer.tris.length; f++) out.push(freeLayer.tris[f]);
    }
    res.ok = true;
    res.tris = new Float32Array(out);
    res.pattern = name;
    res.mode = mode;
    res.params = p;
    res.face = { n: fr.N, d: face.d, corners: fr.c, W: fr.W, D: fr.D, tris: face.tris.length };
    res.basePlane = face.d;
    res.tipsPlane = face.d + tipsOffset;
    res.tipHeight = p2 ? info.hmax : p.height;
    res.tipArea = info.tipArea;
    res.shells = 1;
    res.layers = layered ? 2 : 1;
    if (p2) {
      /* The composed contact is the INTERSECTION of the two tip sets, so it
         can only shrink - but it shrinks by however much layer 2's own tips
         are sparse, and two patterns whose features line up (a crosshatch on
         a crosshatch at a harmonic pitch, measured: 182.07 -> 182.07 mm² on
         a 20 mm cube) leave it exactly where it was and only make the relief
         taller. Layer 1's own tip area rides on the result next to the
         composite's so a caller can say which happened instead of implying a
         reduction that is not there. */
      res.layer1TipArea = info.layer1TipArea;
      res.layer2 = { pattern: l2name, params: p2, mode: 'composed',
                     describe: PATTERNS[l2name].describe(p2),
                     height: p2.height, tipsPlane: res.tipsPlane, tipArea: info.tipArea,
                     contactRatio: info.layer1TipArea > 0 ? info.tipArea / info.layer1TipArea : null };
    }
    if (freeLayer) {
      /* the outermost contact surface is now the free layer's tips - that is
         the plane Seat has to measure to, so it is what tipsPlane reports.
         Layer 1's own tips stay on the result as layer1TipsPlane. */
      res.layer1TipsPlane = face.d + tipsOffset;
      res.layer1TipArea = info.tipArea;
      res.tipsPlane = freeLayer.tipsPlane;
      res.tipHeight = freeLayer.tipsPlane - face.d;
      res.tipArea = freeLayer.tipArea;
      res.freeLayer = freeLayer;
      res.layer2 = { pattern: freeLayer.pattern, params: freeLayer.params, mode: 'free',
                     describe: freeLayer.describe, height: freeLayer.params.height,
                     tipsPlane: freeLayer.tipsPlane, tipArea: freeLayer.tipArea };
      res.shells = 2;
      res.nonSolid = true;
    }
    res.reliefTris = info.reliefTris;
    res.wallTrisFanned = fanned;
    res.reliefTrisFanned = reliefFanned;
    res.info = info;
    res.describe = PATTERNS[name].describe(p) + (mode === 'recess' ? ', recessed' : '') +
      (res.layer2 ? (res.layer2.mode === 'free'
        ? ' + a free layer on its tips (' + res.layer2.describe + ', ' + freeLayer.sheet + ' mm sheet)'
        : ' + ' + res.layer2.describe + ' on its tips') : '');
    return res;
  }

  /* --------------------------------------------------------- wrap */

  /* The six axis faces, in the order the wrap takes them. */
  var BOX_DIRS = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

  function dirName(d) {
    for (var a = 0; a < 3; a++) {
      if (Math.abs(d[a]) > 0.999 && Math.abs(d[(a + 1) % 3]) < 1e-3 && Math.abs(d[(a + 2) % 3]) < 1e-3) {
        return (d[a] < 0 ? '-' : '+') + 'XYZ'[a];
      }
    }
    return '[' + d.map(function (c) { return (+c).toFixed(3); }).join(', ') + ']';
  }

  /* Skin SEVERAL faces of one piece in one action - the wrap, in the same
     sense as Soften's Full wrap ("one click wraps all six faces of a box").
     Not a curved wrap: every face still has to be a flat rectangle, and a
     cylinder's side is refused exactly as it was before. See docs/HANDOFF.md,
     "Skin wrap", for what a curved one would take.

     opts: everything applySkinToFace takes, plus
       faces            [{ dir, plane? }, ...], or 'box' for the six axis
                        faces (the default)
       skipUnskinnable  true: a face with no flat pick, or one whose boundary
                        is not a rectangle, is left alone and named in
                        res.skipped. false (the default): it stands the whole
                        wrap down.

     Faces are skinned one after another on the growing soup - that is the
     whole implementation. It is only correct because the seam between two
     skinned faces closes: the second face's relief perimeter is subdivided
     at the first's points (sideChain / fanRelief). Before that, two adjacent
     faces of a 20 mm cube left 28 open and 28 non-manifold edges.

     Never a half-wrap: a refusal on a face that was asked for returns the
     ORIGINAL soup, with the reason and the face that refused. */
  function applySkinWrap(soup, opts) {
    opts = opts || {};
    var res = { ok: false, tris: soup, faces: [], skipped: [] };
    if (!soup || triCount(soup) < 4) { res.reason = 'empty soup'; return res; }
    var want = opts.faces;
    if (!want || want === 'box') want = BOX_DIRS.map(function (d) { return { dir: d }; });
    if (!want.length) { res.reason = 'no faces asked for'; return res; }
    var skip = !!opts.skipUnskinnable;
    var asked = want.length;
    var cur = soup, i, faces = [], skipped = [], tipArea = 0;
    /* Every face's plane is resolved up front, on the ORIGINAL soup, and
       handed to each pick explicitly. Neither raise nor recess moves another
       face's plane, so these stay true for the whole wrap - and the pick can
       then never drift onto something an earlier face added: a rib wall
       parallel to the face, or a free layer standing above it. */
    var resolved = [];
    for (i = 0; i < want.length; i++) {
      var w0 = want[i] || {};
      var d0 = w0.dir || [0, 0, 1];
      var nm0 = w0.name || dirName(d0);
      var plane0 = w0.plane;
      if (plane0 == null) {
        var f0 = findFace(soup, d0);
        if (!f0) {
          if (skip) { skipped.push({ name: nm0, dir: d0, reason: 'no flat face within 30 degrees' }); continue; }
          res.reason = 'the ' + nm0 + ' face refused: no flat face within 30 degrees';
          res.faceRefused = nm0;
          return res;
        }
        plane0 = f0.d;
      }
      resolved.push({ dir: d0, plane: plane0, name: nm0 });
    }
    want = resolved;
    for (i = 0; i < want.length; i++) {
      var req = want[i];
      var d = req.dir;
      var nm = req.name;
      var r = applySkinToFace(cur, {
        dir: d, plane: req.plane, pattern: opts.pattern, params: opts.params,
        mode: opts.mode, layer2: opts.layer2
      });
      if (!r.ok) {
        if (skip) { skipped.push({ name: nm, dir: d, reason: r.reason }); continue; }
        res.reason = 'the ' + nm + ' face refused: ' + r.reason;
        res.faceRefused = nm;
        res.faces = faces;
        return res;                       /* res.tris is still the input soup */
      }
      cur = r.tris;
      tipArea += r.tipArea;
      faces.push({
        name: nm, dir: d, basePlane: r.basePlane, tipsPlane: r.tipsPlane,
        tipHeight: r.tipHeight, tipArea: r.tipArea, reliefTris: r.reliefTris,
        W: r.face.W, D: r.face.D, layers: r.layers, freeLayer: r.freeLayer || null,
        describe: r.describe
      });
    }
    res.asked = asked;
    if (!faces.length) {
      res.reason = 'no face of this piece can take a skin' +
        (skipped.length ? ' (' + skipped.map(function (x) { return x.name + ': ' + x.reason; }).join('; ') + ')' : '');
      res.skipped = skipped;
      return res;
    }
    res.ok = true;
    res.tris = cur;
    res.faces = faces;
    res.skipped = skipped;
    res.count = faces.length;
    res.tipArea = tipArea;
    res.pattern = opts.pattern || 'crosshatch';
    res.mode = opts.mode || 'raise';
    res.layers = faces[0].layers;
    res.shells = 1 + faces.reduce(function (n, f) { return n + (f.freeLayer ? 1 : 0); }, 0);
    res.nonSolid = res.shells > 1;
    res.describe = faces[0].describe + ' on ' + faces.length + ' face' + (faces.length === 1 ? '' : 's') +
      ' (' + faces.map(function (f) { return f.name; }).join(', ') + ')';
    return res;
  }

  /* ------------------------------------------- tips measurement */

  /* Sutherland-Hodgman clip of a polygon (array of {u,v,s}) against
     lo <= key <= hi. */
  function clipAxis(poly, key, lo, hi) {
    function clipOne(input, inside, at) {
      var outp = [];
      for (var i = 0; i < input.length; i++) {
        var cur = input[i], prev = input[(i + input.length - 1) % input.length];
        var ci = inside(cur), pi = inside(prev);
        if (ci) {
          if (!pi) outp.push(at(prev, cur));
          outp.push(cur);
        } else if (pi) outp.push(at(prev, cur));
      }
      return outp;
    }
    function isect(a, b, bound) {
      var t = (bound - a[key]) / (b[key] - a[key]);
      var r = { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, s: a.s + (b.s - a.s) * t };
      r[key] = bound;
      return r;
    }
    var p1 = clipOne(poly, function (q) { return q[key] >= lo; }, function (a, b) { return isect(a, b, lo); });
    if (!p1.length) return p1;
    return clipOne(p1, function (q) { return q[key] <= hi; }, function (a, b) { return isect(a, b, hi); });
  }

  function footprintFrame(cornersFp, normal) {
    var o = cornersFp[0];
    var Uv = sub(cornersFp[1], o), Vv = sub(cornersFp[3], o);
    var W = len(Uv), D = len(Vv);
    var U = unit(Uv), V = unit(Vv);
    var N = unit(normal);
    return { o: o, U: U, V: V, N: N, W: W, D: D };
  }

  /* The soup's extreme along `normal` inside the prism over the footprint
     rectangle (4 corners, any order around it, as the app's face corners).
     opts.sMax: ignore anything beyond this along the normal (the bit's own
     far face, so a hull that wraps around the bit is not mistaken for the
     surface under it). Returns null if nothing of the soup lies under the
     footprint. */
  function supportExtreme(soup, cornersFp, normal, opts) {
    opts = opts || {};
    var f = footprintFrame(cornersFp, normal);
    var sMax = (opts.sMax == null) ? Infinity : opts.sMax;
    var best = -Infinity, bestPt = null, inside = 0;
    var n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var poly = [];
      var allBeyond = true;
      for (var k = 0; k < 3; k++) {
        var p = vtx(soup, t, k), d = sub(p, f.o);
        var s = dot(p, f.N);             /* absolute, p . normal */
        if (s <= sMax + 1e-6) allBeyond = false;
        poly.push({ u: dot(d, f.U), v: dot(d, f.V), s: s });
      }
      if (allBeyond) continue;
      poly = clipAxis(poly, 'u', 0, f.W);
      if (poly.length < 3) continue;
      poly = clipAxis(poly, 'v', 0, f.D);
      if (poly.length < 3) continue;
      inside++;
      for (var q = 0; q < poly.length; q++) {
        if (poly[q].s <= sMax + 1e-6 && poly[q].s > best) {
          best = poly[q].s;
          var inPlane = add(f.o, add(scale(f.U, poly[q].u), scale(f.V, poly[q].v)));
          bestPt = add(inPlane, scale(f.N, poly[q].s - dot(inPlane, f.N)));
        }
      }
    }
    if (!bestPt) return null;
    return { s: best, point: bestPt, inside: inside };
  }

  /* Area (mm^2) of soup triangles that lie in the plane p.normal = sTips
     (within tol), clipped to the footprint. The real contact patch. */
  function tipContactArea(soup, cornersFp, normal, sTips, tol) {
    tol = tol || 1e-6;
    var f = footprintFrame(cornersFp, normal);
    var s0 = sTips;
    var area = 0, n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var poly = [], ok = true;
      for (var k = 0; k < 3 && ok; k++) {
        var pk = vtx(soup, t, k), d = sub(pk, f.o);
        var s = dot(pk, f.N);
        if (Math.abs(s - s0) > tol) ok = false;
        poly.push({ u: dot(d, f.U), v: dot(d, f.V), s: s });
      }
      if (!ok) continue;
      poly = clipAxis(poly, 'u', 0, f.W);
      if (poly.length < 3) continue;
      poly = clipAxis(poly, 'v', 0, f.D);
      if (poly.length < 3) continue;
      var a = 0;
      for (var q = 0; q < poly.length; q++) {
        var r = poly[(q + 1) % poly.length];
        a += poly[q].u * r.v - r.u * poly[q].v;
      }
      area += Math.abs(a) / 2;
    }
    return area;
  }

  /* ------------------------------------ the relief, without a host

     AUDIT (for nso_skin_patch.js, 2026-09-17): the relief IS already built as
     an independent structure, and pattern generation is NOT welded to the
     fusion step. crosshatchPlan / zigzagPlan are pure functions of a frame and
     their parameters - they return a height field, not geometry - and
     gridRelief / ringRelief read only that frame and its `sides`, never the
     soup being skinned. Measured, not assumed: the relief triangles of the
     same 30 x 30 +Z face come out bit-identical on a 30x30x8 block and on a
     30x30x2 plate (9402 crosshatch / 434 zigzag / 864 ring triangles, every
     one equal), while the host wall fans differ.

     What that independent structure is NOT is a printable object. Taken on its
     own the relief is a ZERO-THICKNESS OPEN SHEET: Euler 1, 196 / 116 / 96
     open edges, bbox height exactly the skin height with nothing below it.
     gridRelief emits the top surface and the walls BETWEEN cells and stops;
     the back, and the watertightness, come from the HOST (fanWalls re-emits
     the rest of its shell, and the host body is the floor). So "export the
     pattern alone" cannot be a matter of keeping the relief triangles and
     dropping the others - the thing that comes out has no thickness.

     The path that works is the one freeLayerShell already takes for the free
     second layer: give the relief A HOST OF ITS OWN and skin that. These two
     exports are what a caller needs to do it for a host this module never
     saw - a frame built from numbers instead of from a face's boundary loop,
     and the height field behind it. They hand out a frame and a plan, never
     geometry: the caller decides what closes the back. nso_skin_patch.js is
     the first such caller. */

  /* A frame for a rectangle that is not a face of any soup: rectFrame's
     output, built from numbers. origin is the c0 corner, U/V the in-plane
     axes (normalised here; V is squared against U), W/D the spans. */
  function planeFrame(origin, U, V, W, D) {
    var u = unit(U);
    var v = unit(sub(V, scale(u, dot(u, V))));   /* V squared against U */
    if (len(u) === 0 || len(v) === 0) return 'planeFrame: U and V must be non-zero and not parallel';
    if (!(W > 1e-6) || !(D > 1e-6)) return 'planeFrame: W and D must be positive';
    var N = unit(cross(u, v));
    var c0 = [origin[0], origin[1], origin[2]];
    return { c: [c0, add(c0, scale(u, W)), add(c0, add(scale(u, W), scale(v, D))), add(c0, scale(v, D))],
             U: u, V: v, N: N, W: W, D: D };
  }

  /* The height field a grid pattern is, over `fr`: { breaksU, breaksV,
     cellHeights(u0,u1,v0,v1) -> [h00,h10,h11,h01], margin, ... } or a reason
     string. shift is applySkinToFace's own: 0 to raise, -height to recess.
     `ring` has no height field (ringRelief builds its surface directly) and is
     refused here by name rather than silently. */
  function patternPlan(name, params, fr, shift) {
    if (!PATTERNS[name]) return 'unknown pattern "' + name + '"';
    if (familyOf(name) === 'ring') return 'ring has no height field - it builds its surface directly (see ringRelief)';
    if (typeof fr === 'string' || !fr || !(fr.W > 0)) return 'patternPlan needs a frame (see planeFrame)';
    var p = withDefaults(name, params);
    if (!(p.height > 0)) return 'height must be positive';
    var plan = gridPlan(name, fr, p, shift || 0);
    if (typeof plan === 'string') return plan;
    plan.params = p;
    return plan;
  }

  var api = {
    PATTERNS: PATTERNS,
    familyOf: familyOf,
    withDefaults: withDefaults,
    LAYER2_DEFAULTS: LAYER2_DEFAULTS,
    BOX_DIRS: BOX_DIRS,
    findFace: findFace,
    planeFrame: planeFrame,
    patternPlan: patternPlan,
    applySkinToFace: applySkinToFace,
    applySkinWrap: applySkinWrap,
    withLayer2Defaults: withLayer2Defaults,
    supportExtreme: supportExtreme,
    tipContactArea: tipContactArea
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Skin = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
