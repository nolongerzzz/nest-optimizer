/* nso_skin_patch.js - a skin pattern as its own printable object, not baked
   onto the face of a host block.

   Loads as a classic script (window.NSO_SkinPatch) and as a Node module
   (require('../nso_skin_patch.js')). Pure geometry on top of nso_skin.js: no
   DOM, no Three.js, a mesh is the app's raw soup (9 numbers per triangle,
   Z up, millimetres).

   ---------------------------------------------------------------------------
   WHY THIS IS A MODULE AND NOT A FLAG ON applySkinToFace
   ---------------------------------------------------------------------------
   The audit is written out in full at nso_skin.js, "the relief, without a
   host"; the two sentences that decide the design are these.

   The relief IS built as an independent structure - crosshatchPlan and
   zigzagPlan return a height field, gridRelief and ringRelief read only a
   frame and its perimeter bookkeeping, and the same 30 x 30 face gives
   bit-identical relief triangles on a 30x30x8 block and a 30x30x2 plate.

   But that structure is a zero-thickness OPEN SHEET: Euler 1, 196 / 116 / 96
   open edges, bbox height exactly the skin height and nothing underneath.
   gridRelief emits the top surface and the walls between cells; the back and
   the watertightness come from the host. So the extraction path is NOT
   "keep the relief triangles and drop the rest" - what that yields has no
   thickness and no back, and a slicer has nothing to print.

   The path that works is the one freeLayerShell already takes for a free
   second layer: give the relief A HOST OF ITS OWN. Both variants below do
   that, each in the way its own job needs.

   ---------------------------------------------------------------------------
   THE TWO VARIANTS
   ---------------------------------------------------------------------------
   'bordered'  the washer. A closed TRAY - a rectangular rim standing on a
               floor membrane - whose POCKET FLOOR carries the relief. The
               pocket floor is skinned by NSO_Skin.applySkinToFace itself,
               through the shipped inner-face path (findFace's plane offset,
               the one a selected pocket floor already uses), so every line
               of the seam work, the perimeter subdivision and the wall
               re-fanning is the validated code and none of it is copied
               here. Self-contained and handleable: the rim is solid, stands
               PROUD of the tips, and takes the handling so the relief does
               not. One closed shell, Euler 2.
   'sandwich'  the double-sided washer, for a sandwich test. The same
               prismatic rib lattice, with NO FLOOR MEMBRANE ANYWHERE and a
               perimeter FRAME rib instead of a proud rim, so the pattern
               faces outward on BOTH the +Z and the -Z face and the two
               contacts are equal by construction. See "why bordered is the
               wrong piece for a sandwich" below.
   'loose'     the raw patch. The pattern's own features as SOLID BODIES and
               nothing else: no rim, no backing plate, matching the sample
               footprint. Built from the height field patternPlan hands out -
               the solid region { 0 <= z <= h(u,v), h(u,v) > 0 } meshed as a
               cell complex over the plan's own grid, which is watertight by
               construction because the raised set is a union of grid cells
               and every face between a solid cell and an empty one is
               emitted exactly once. The ring, which has no height field, is
               built as what it is: a closed tapered annulus.

               A pattern whose features do not touch each other is several
               loose sticks and not a patch you can pick up - the zigzag's
               ridges are parallel and share nothing. So 'loose' adds TIES:
               cross-ribs, at the pattern's own rib width, merged into the
               same height field so they are part of the one body rather
               than a second thing resting on it. ties: 0 turns them off and
               a zigzag patch then comes back as its ridges, separately,
               which buildPatch reports as `components` rather than hiding.

   ---------------------------------------------------------------------------
   WHY 'bordered' IS THE WRONG PIECE FOR A SANDWICH TEST, AND 'sandwich' IS
   ---------------------------------------------------------------------------
   The bordered washer is a closed TRAY: a solid 0.6 mm floor membrane with
   the relief on ONE side of it. Put it between two cubes and only the top
   cube meets rib tips - the bottom cube meets a flat solid plate 30 x 30 mm
   across, which welds on contact area alone no matter how the pattern
   performs. The measurement that comes back is the floor's, not the
   pattern's. bordered is unchanged and stays exactly what it is; it is simply
   a one-sided piece and a sandwich needs a two-sided one.

   'sandwich' is that piece, and it is two-sided BY CONSTRUCTION rather than
   by being built twice:

     no floor       every cell is either empty top-to-bottom or solid
                    top-to-bottom. There is no membrane to weld against.
     prismatic      a crosshatch rib has a rectangular section, so the solid
                    is a straight extrusion of the rib footprint. Its z = 0
                    face and its z = height face are THE SAME SET. The two
                    contact areas are therefore not merely similar, they are
                    one number, and the test asserts them equal rather than
                    trusting the symmetry.
     frame, not rim the perimeter is closed by one more RIB, at the pattern's
                    own rib width and the pattern's own height - not by a rim
                    standing proud. A proud rim would hold the two cubes off
                    the pattern entirely and measure itself; a rim flush with
                    the tips would add ~138 mm2 of solid contact per face on a
                    30 x 30 piece and swamp the lattice. A 0.42 mm frame rib
                    adds what any other rib adds, and its job is only to stop
                    the outermost ribs ending in free air.
     no sliver      ribIntervals CENTRES its ribs in the free span, so the
                    leftover at each end is generally not zero - at 0.84 pitch
                    on 30 mm it is 0.09 mm, which would be an unprintable
                    channel between the frame and the first rib. The frame is
                    therefore widened to MEET the first rib (plan.ivU/ivV say
                    where that is) instead of being left at its nominal width.
                    Reported as `frame` so the number that got built is the
                    number you can read.

   Prismatic is a real restriction and it is enforced, not assumed: the
   zigzag tapers from a 1.2 mm base to a 0.42 mm tip, so its underside is a
   wide flat base and its two faces are NOT the same pattern; the ring has no
   height field at all. Both are refused by name with that reason rather than
   built lopsided.

   ---------------------------------------------------------------------------
   THICKNESS - every figure reused, none invented
   ---------------------------------------------------------------------------
   MIN_WALL   0.42 mm, one extrusion line at a 0.4 nozzle. nso_skin.js's own
              crosshatch rib default and the threshold mesh_validate.py
              --min-wall carries (docs/NON-SOLID.md section 4). Every wall
              this module ADDS is at least this, and buildPatch reports
              minWall so the number is checkable rather than claimed.
   FLOOR      0.6 mm, freeLayerShell's `sheet` default - three 0.2 layers,
              the same figure as the crosshatch and zigzag skin height. This
              is the bordered variant's floor membrane.
   RIM        1.2 mm wall, the crosshatch `pitch` default: the rim is the one
              part of either variant meant to be handled, so it is the
              thickest figure the patterns already use, not a new one.
   PROUD      0.6 mm, FLOOR again: how far the rim's top stands above the
              relief's tips, so a finger or a caliper meets the rim first.
   SIZE       30 x 30 mm, A_SIZE from tools/nso_skin_samples.js - "matching
              the existing sample sizes" means exactly the face the committed
              skin samples skin.

   ---------------------------------------------------------------------------
   THE NON-SOLID FLAG - what is measured, and what is the user's call
   ---------------------------------------------------------------------------
   NON-SOLID SCOPE: PER PIECE, NEVER INFERRED (docs/NON-SOLID.md). This module
   does not read an edge count to decide anything and does not set the flag;
   it reports `closed` and `components` from its own construction and hands
   `nonSolidAdvised` to the caller, which is a recommendation, not a
   measurement of intent. app-skin-patch.js turns that into a flag only for
   the case the user asked for by choosing it.

   Measured for both variants, all three patterns (tools/nso_skin_patch_test.js
   holds these): every patch is a CLOSED shell - 0 open edges, 0 non-manifold,
   0 degenerate, 0 piercing - so neither variant needs the flag to pass the
   ordinary closure check, and section 3's "declare --non-solid if
   intentional" is not what is standing between these files and a pass. They
   pass --gate and --gate --non-solid alike; the wall/gap check the flag turns
   on is the interesting one and they pass that too.

   Where it is still the right call, and why 'loose' therefore defaults to
   ADVISED: a loose patch is a free-standing lattice of one-extrusion-line
   ribs, which is the printable-fabric case docs/NON-SOLID.md names, and with
   ties: 0 a zigzag patch is genuinely several separate components. Repair's
   dropOrphanComponents deletes an open component of <= max(4, 1%) triangles
   when a closed one exists, and peelFlaps eats a strand end: a loose patch
   that ever loses its closure - a rib split, a hand edit, an import round
   trip through a lossy writer - is exactly the piece those stages would
   quietly trim. The flag is what stands them down. The bordered variant is
   NOT advised: its rim closes and stiffens it, it is one shell by
   construction, and flagging it would only remove a check it passes.
*/
(function (root) {
  'use strict';

  var Skin = (typeof module !== 'undefined' && module.exports)
    ? require('./nso_skin.js')
    : (root && root.NSO_Skin);

  /* ------------------------------------------------------------ vectors */
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function pushTri(out, a, b, c) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  /* push a triangle wound so its normal points along `want`; drop it if flat */
  function pushOriented(out, a, b, c, want) {
    var n = cross(sub(b, a), sub(c, a));
    if (len(n) < 1e-14) return false;
    if (dot(n, want) < 0) pushTri(out, a, c, b); else pushTri(out, a, b, c);
    return true;
  }
  /* a quad p00 p10 p11 p01, split on the p00-p11 diagonal, facing `want` */
  function pushQuad(out, p00, p10, p11, p01, want) {
    var n = pushOriented(out, p00, p10, p11, want);
    return pushOriented(out, p00, p11, p01, want) || n;
  }

  /* ------------------------------------------------------ the numbers */

  /* Every figure here is already in the repo; see the header. */
  var MIN_WALL = 0.42;   /* nso_skin.js crosshatch rib / mesh_validate --min-wall */
  var FLOOR = 0.6;       /* freeLayerShell sheet default = 3 x 0.2 layers */
  var RIM = 1.2;         /* crosshatch pitch default */
  var PROUD = 0.6;       /* FLOOR again: rim top above the tips */
  var SIZE = 30;         /* A_SIZE.x/y, tools/nso_skin_samples.js */

  /* The relief's own margin, per variant, because the two want opposite
     things and neither wants the pattern's default.

     bordered: MIN_WALL, and it MUST be positive. With margin 0 the pattern
     runs to the pocket's edge and its end walls land IN THE PLANE of the
     pocket wall - the same collision freeLayerShell already guards its sheet
     against ("it also keeps the sheet's side walls OUT of the piece's own
     face planes"). Measured here before the guard: 2488 piercing pairs on the
     bordered crosshatch and 868 on the zigzag, the ridge end caps at the
     pocket edge (z 0.6 -> 1.2 at y = 1.2) sharing a plane with the pocket
     wall's own fan (z 0.6 -> 1.8 at y = 1.2). Closure was fine throughout -
     0 open edges, Euler 2 - which is why this needs the self-intersection
     check to see it at all. One extrusion line of flat floor between the
     pattern and the rim is enough and is a figure the repo already has.

     loose: 0. There is no wall to collide with - the pattern IS the object -
     and 0 is what makes the patch the full 30 x 30 the samples are. (The
     crosshatch still fills it edge to edge: a cell at u < the first rib is
     raised anyway when its v falls in a V rib, so the lattice spans the whole
     footprint rather than stopping at the outermost rib.) */
  var VARIANT_MARGIN = { bordered: MIN_WALL, loose: 0, sandwich: 0 };

  /* loose only: a vertical FOOT of `back` mm under each feature's own base
     footprint - not a plate, nothing in the gaps between features, so the
     patch still has no backing and no frame.

     Why it exists, measured: a pattern whose section TAPERS meets the
     underside of a loose patch at an acute angle, and the perpendicular
     distance from that flank to its own underside is under one extrusion
     line however wide the feature's base is. The zigzag's flank rises 0.6 mm
     over 0.39 mm - 33 degrees off vertical - and mesh_validate.py's wall/gap
     check read 0.367 mm on all 30 flanks (15 ridges x 2), from the flank's
     centroid at z 0.200 straight down to the bottom face under the crest.
     The ridge is 1.2 mm wide at its base and every printed layer of it is at
     least 0.42 mm, so it slices; but those two surfaces really do close to
     0.367 mm, and on a free-standing patch that feather edge at the build
     plate is a real artefact and not a measuring quirk to argue away. One
     extrusion line of vertical foot replaces the feather with a wall: the
     flank then starts from the top of the foot and its inward ray crosses
     0.42 mm of solid before it leaves.

     Per pattern, because only the zigzag needs it and a foot is not free -
     it makes the coupon taller than the sample skin it came from:
       crosshatch  0     prismatic ribs, vertical walls, reads 0.42 as it is
       zigzag      0.42  the 33-degree wedge above
       ring        0     taper 0.2 mm over 1.0 mm, 11 degrees off vertical,
                         reads 0.566 as it is
     Every one is a parameter; `back` overrides. */
  /* keyed by FAMILY, read through fam() - a preset inherits its family's foot */
  var LOOSE_BACK = { crosshatch: 0, zigzag: MIN_WALL, ring: 0 };

  var VARIANTS = {
    bordered: 'the pattern inside a solid rim - a washer, one closed shell',
    loose: 'the pattern\'s features alone, solid, no rim and no backing plate',
    sandwich: 'double-sided - the pattern on BOTH faces, no floor, a frame rib instead of a rim'
  };

  var DEFAULTS = {
    variant: 'bordered',
    pattern: 'crosshatch',
    params: null,        /* the pattern's own; null takes nso_skin.js's defaults */
    W: SIZE, D: SIZE,    /* footprint, mm */
    floor: FLOOR,        /* bordered: the membrane under the relief */
    rim: RIM,            /* bordered: rim wall */
    proud: PROUD,        /* bordered: rim top above the relief tips */
    margin: null,        /* relief inset; null = the variant's own, see VARIANT_MARGIN */
    back: null,          /* loose: vertical foot under the features; null = LOOSE_BACK */
    ties: null,          /* loose: cross-ribs. null = as many as the pattern needs */
    tie: null,           /* loose: tie width; null = MIN_WALL, one extrusion line */
    frame: null          /* sandwich: perimeter rib width; null = MIN_WALL, widened to meet rib 1 */
  };

  function withDefaults(opts) {
    var out = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k) && opts[k] != null) out[k] = opts[k];
    return out;
  }

  /* The two sections a pattern's own feature has: `base`, the wall the slicer
     lays down and the one a free-standing feature stands on, and `tip`, what
     that wall has tapered to at the contact. The crosshatch rib is
     rectangular so the two are equal; the zigzag and the ring taper on
     purpose - minimal contact is the whole point of them - and their tips are
     narrower than one extrusion line by design (the ring's shipped wallTip is
     0.4). So the one-line guard is on `base` only, and `tip` is REPORTED,
     never gated: mesh_validate.py's wall/gap check measures from face
     centroids and is the authority on what a taper actually prints as. */
  function featureWall(name, p) {
    var f = fam(name);
    if (f === 'crosshatch') return { base: p.rib, tip: p.rib };
    if (f === 'zigzag') return { base: p.base, tip: p.tip };
    return { base: p.wallBase, tip: p.wallTip };   /* ring */
  }

  /* Every dispatch below is on the FAMILY, so a preset name like
     `crosshatch-fine` needs no entry of its own anywhere in this file. */
  function fam(name) {
    return (Skin && Skin.familyOf) ? Skin.familyOf(name) : name;
  }

  /* ------------------------------------------------- the bordered tray */

  /* A closed tray in the XY plane: outer W x D standing on z = 0, a pocket
     inset by `rim` whose floor is at z = floor and whose rim top is at
     z = top. The pocket floor's plane offset is `floor`, which is the handle
     applySkinToFace is given.

     Built as a HEIGHT FIELD over the 3 x 3 grid [0,i0,i1,W] x [0,j0,j1,D] -
     the eight ring cells at `top`, the middle cell at `floor` - and handed to
     looseGrid, the same solid builder the loose variant uses. Not for
     elegance: a tray written out as "one bottom quad, four outer wall quads,
     a rim frame, four pocket walls" leaves T-JUNCTIONS, and it is worth
     recording what they cost, because the mesh looks right in a viewer.
     Measured on the first version of this function: the rim frame's inner
     edge ran the full width while the pocket walls only met part of it, so
     the bare 28-triangle tray came back with 16 open edges, 10 piercing
     pairs and Euler -2, and every bordered patch inherited them (2590
     piercing pairs on the crosshatch). On the 3 x 3 grid every cell edge is
     shared by exactly two cells, so there is no unmatched edge to leave. */
  function traySoup(W, D, floor, rim, top) {
    var fr = Skin.planeFrame([0, 0, 0], [1, 0, 0], [0, 1, 0], W, D);
    if (typeof fr === 'string') return fr;
    var i0 = rim, i1 = W - rim, j0 = rim, j1 = D - rim;
    var out = [];
    looseGrid(fr, [0, i0, i1, W], [0, j0, j1, D], function (u0, u1, v0, v1) {
      var mid = (u0 + u1) / 2 > i0 && (u0 + u1) / 2 < i1 &&
                (v0 + v1) / 2 > j0 && (v0 + v1) / 2 < j1;
      var h = mid ? floor : top;
      return [h, h, h, h];
    }, out, 0);
    return new Float32Array(out);
  }

  function buildBordered(o) {
    var name = o.pattern;
    if (!Skin.PATTERNS[name]) return 'unknown pattern "' + name + '"';
    var p = Skin.withDefaults(name, o.params);
    if (!(p.height > 0)) return 'height must be positive';
    if (!(o.floor >= MIN_WALL)) return 'the floor membrane must be at least ' + MIN_WALL + ' mm (one extrusion line)';
    if (!(o.rim >= MIN_WALL)) return 'the rim wall must be at least ' + MIN_WALL + ' mm (one extrusion line)';
    if (!(o.proud >= 0)) return 'proud must not be negative (the rim would sit below the tips)';
    var pw = o.W - 2 * o.rim, pd = o.D - 2 * o.rim;
    if (!(pw > MIN_WALL) || !(pd > MIN_WALL)) {
      return 'a ' + o.rim + ' mm rim leaves no pocket in ' + o.W + ' x ' + o.D + ' mm';
    }
    var top = o.floor + p.height + o.proud;
    var tray = traySoup(o.W, o.D, o.floor, o.rim, top);
    /* the pocket floor by its own plane offset, not by "the outermost +Z
       face" - which is the rim's top. This is findFace's plane argument and
       the shipped pocket-floor path. */
    var r = Skin.applySkinToFace(tray, {
      dir: [0, 0, 1], plane: o.floor, pattern: name,
      params: Object.assign({}, o.params || {}, { margin: o.margin }),
      mode: 'raise'
    });
    if (!r.ok) return 'bordered: ' + r.reason;
    return {
      tris: r.tris,
      variant: 'bordered',
      pattern: name, params: r.params, describe: r.describe,
      W: o.W, D: o.D, height: top,             /* overall Z extent */
      floor: o.floor, rim: o.rim, proud: o.proud, margin: o.margin,
      pocket: { W: pw, D: pd, floorZ: o.floor },
      rimTopZ: top, tipsZ: o.floor + r.tipHeight, tipHeight: r.tipHeight,
      tipArea: r.tipArea,
      /* every wall this variant adds, thinnest first - the rim and the floor
         membrane; the pattern's own is featureWall */
      minWall: Math.min(o.rim, o.floor, featureWall(name, r.params).base),
      tipWall: featureWall(name, r.params).tip,
      closed: true, components: 1,
      nonSolidAdvised: false,
      skin: r
    };
  }

  /* --------------------------------------------------- the loose patch */

  /* Ties: cross-ribs along U at `n` evenly spaced v positions, `w` wide, at
     the pattern's full height, so a pattern whose features are parallel comes
     out as ONE body. Returned as v intervals; merged into the height field by
     looseGrid, never as separate geometry resting on it. */
  function tieIntervals(D, w, n, margin) {
    if (!(n > 0) || !(w > 0)) return [];
    var lo = margin, hi = D - margin;
    if (!(hi - lo > w)) return [];
    var iv = [];
    if (n === 1) { var c = (lo + hi) / 2; return [[c - w / 2, c + w / 2]]; }
    for (var i = 0; i < n; i++) {
      var s = lo + (hi - lo - w) * i / (n - 1);
      iv.push([s, s + w]);
    }
    return iv;
  }
  function inAny(x, iv) {
    for (var i = 0; i < iv.length; i++) if (x > iv[i][0] && x < iv[i][1]) return true;
    return false;
  }
  function mergeBreaks(a, b, eps) {
    var all = a.concat(b).sort(function (x, y) { return x - y; });
    var out = [];
    for (var i = 0; i < all.length; i++) if (!out.length || all[i] - out[out.length - 1] > eps) out.push(all[i]);
    return out;
  }

  /* The solid region { (u,v,z) : 0 <= z <= h(u,v), h(u,v) > 0 } over the
     plan's grid, as a closed soup.

     Watertight by construction, and the reason is worth stating: the raised
     set is a union of GRID CELLS, so every face of the solid lies on a cell
     face. A cell contributes a top (at its heights) and a bottom (at 0) when
     it is raised; a grid edge contributes a wall when its two cells disagree
     - one raised and one not, or two raised to different heights. Every such
     face is emitted exactly once and no other, so every edge of the result is
     shared by exactly two triangles. A cell whose four node heights are not
     all equal (a zigzag flank) keeps its own bilinear top, which is why the
     sawtooth section survives instead of being stepped: nothing here
     resamples the height field, it reads the plan's own nodes. */
  function looseGrid(fr, breaksU, breaksV, cellHeights, out, back) {
    /* `back`: a vertical foot under the SOLID cells only. A cell is solid iff
       the PATTERN raises it - max(h) > 0 - so the foot follows the feature
       footprint and the gaps between features stay empty. Lifting every cell
       instead (the first version of this) turns the foot into a full backing
       plate, which is the one thing the loose variant must not have. */
    var lift = back || 0;
    var nu = breaksU.length - 1, nv = breaksV.length - 1;
    var U = fr.U, V = fr.V, N = fr.N, c0 = fr.c[0];
    var negU = scale(U, -1), negV = scale(V, -1);
    function P(u, v, h) {
      var q = add(c0, add(scale(U, u), scale(V, v)));
      return h === 0 ? q : add(q, scale(N, h));
    }
    var H = new Array(nu * nv), i, j, k;
    var hmax = 0, tipArea = 0, solidCells = 0, vol = 0, crossings = 0;

    /* Per-NODE height sets, and why they are the whole trick.

       A wall is emitted per grid edge, and a node where three or more
       distinct heights meet then gets vertical edges of different lengths
       from the walls around it - a T-junction, and the mesh is open although
       every surface is present. Measured when the foot was first added: the
       corner where a tie cell (top 1.02), a flank cell (top 0.42 at that
       node) and an empty cell (nothing, so the underside at 0) meet produced
       one 0 -> 1.02 edge against a 0 -> 0.42 and a 0.42 -> 1.02, and the
       loose zigzag came back with 180 open edges and 30 piercing pairs while
       ties alone and a foot alone were each clean.

       The fix: collect at every node every height any incident cell gives it,
       plus 0 for the underside, and split each wall at the levels of its two
       end nodes, clamped to that wall's own vertical span. Two walls sharing
       a node then subdivide any span they share identically, because they
       split on the same set. gridRelief upstream emits one quad per edge and
       is correct only because the shipped patterns never put a third height
       on a node (all-or-nothing cells for the crosshatch, a continuous field
       for the zigzag); a foot does, so this builder cannot borrow that
       assumption. */
    var nodeH = new Array((nu + 1) * (nv + 1));
    function node(i2, j2) { return j2 * (nu + 1) + i2; }
    for (k = 0; k < nodeH.length; k++) nodeH[k] = [0];
    function noteH(i2, j2, h) {
      var arr = nodeH[node(i2, j2)];
      for (var q = 0; q < arr.length; q++) if (Math.abs(arr[q] - h) < 1e-9) return;
      arr.push(h);
    }

    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h = cellHeights(breaksU[i], breaksU[i + 1], breaksV[j], breaksV[j + 1]);
      var top = Math.max(h[0], h[1], h[2], h[3]);
      if (top > 1e-12) {
        if (lift) h = [h[0] + lift, h[1] + lift, h[2] + lift, h[3] + lift];
        H[j * nu + i] = h;
        if (top > hmax) hmax = top;
        noteH(i, j, h[0]); noteH(i + 1, j, h[1]);
        noteH(i + 1, j + 1, h[2]); noteH(i, j + 1, h[3]);
      } else {
        H[j * nu + i] = null;                        /* null = empty cell */
      }
    }
    for (k = 0; k < nodeH.length; k++) nodeH[k].sort(function (a, b) { return a - b; });

    /* tops and bottoms */
    var ht = hmax + lift;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h4 = H[j * nu + i];
      if (!h4) continue;
      solidCells++;
      var u0 = breaksU[i], u1 = breaksU[i + 1], v0 = breaksV[j], v1 = breaksV[j + 1];
      pushQuad(out, P(u0, v0, h4[0]), P(u1, v0, h4[1]), P(u1, v1, h4[2]), P(u0, v1, h4[3]), N);
      pushQuad(out, P(u0, v0, 0), P(u1, v0, 0), P(u1, v1, 0), P(u0, v1, 0), scale(N, -1));
      var area = (u1 - u0) * (v1 - v0);
      vol += area * (h4[0] + h4[1] + h4[2] + h4[3]) / 4;
      if (Math.abs(h4[0] - ht) < 1e-9 && Math.abs(h4[1] - ht) < 1e-9 &&
          Math.abs(h4[2] - ht) < 1e-9 && Math.abs(h4[3] - ht) < 1e-9) tipArea += area;
    }

    /* One wall, as a ZIPPER between two independently subdivided vertical
       edges. ptA/ptB place a point at height z on each end; a is one side's
       profile along the edge, b the other's.

       Each end edge is split at ITS OWN node's levels and nothing else. The
       first attempt split both ends at the union of the two nodes' levels,
       which is wrong in the same way as not splitting at all: a level that
       belongs to node A then puts a vertex on node B's edge that B's other
       walls know nothing about. Measured - the untied zigzag went from clean
       to 180 open edges, the flank's wall splitting the shared edge at 0.42
       while the crest's wall next to it left it whole. Splitting per node and
       zippering the strip between the two chains keeps every shared edge
       identical, the way ringRelief already zips its floor to the rectangle. */
    function chain(nodeIdx, lo, hi) {
      var src = nodeH[nodeIdx], ch = [lo], q;
      for (q = 0; q < src.length; q++) if (src[q] > lo + 1e-9 && src[q] < hi - 1e-9) ch.push(src[q]);
      if (hi > lo + 1e-9) ch.push(hi);
      return ch;
    }
    function wall(nA, nB, ptA, ptB, a0, a1, b0, b1, side) {
      if (Math.abs(a0 - b0) < 1e-12 && Math.abs(a1 - b1) < 1e-12) return;
      if ((a0 - b0) * (a1 - b1) < -1e-18) crossings++;      /* see the note below */
      var A = chain(nA, Math.min(a0, b0), Math.max(a0, b0)).map(ptA);
      var B = chain(nB, Math.min(a1, b1), Math.max(a1, b1)).map(ptB);
      var want = (a0 + a1) > (b0 + b1) ? side : scale(side, -1);
      var i2 = 0, j2 = 0;
      while (i2 < A.length - 1 || j2 < B.length - 1) {
        if (j2 >= B.length - 1) { pushOriented(out, A[i2], A[i2 + 1], B[j2], want); i2++; }
        else if (i2 >= A.length - 1) { pushOriented(out, A[i2], B[j2 + 1], B[j2], want); j2++; }
        else if (dot(sub(A[i2 + 1], A[0]), N) <= dot(sub(B[j2 + 1], B[0]), N)) {
          pushOriented(out, A[i2], A[i2 + 1], B[j2], want); i2++;
        } else { pushOriented(out, A[i2], B[j2 + 1], B[j2], want); j2++; }
      }
    }

    /* walls on the u = const grid lines */
    for (i = 0; i <= nu; i++) for (j = 0; j < nv; j++) {
      var L = i > 0 ? H[j * nu + i - 1] : null, R = i < nu ? H[j * nu + i] : null;
      if (!L && !R) continue;
      var u = breaksU[i], w0 = breaksV[j], w1 = breaksV[j + 1];
      wall(node(i, j), node(i, j + 1),
        (function (uu, vv) { return function (z) { return P(uu, vv, z); }; })(u, w0),
        (function (uu, vv) { return function (z) { return P(uu, vv, z); }; })(u, w1),
        L ? L[1] : 0, L ? L[2] : 0, R ? R[0] : 0, R ? R[3] : 0, U);
    }
    /* walls on the v = const grid lines */
    for (j = 0; j <= nv; j++) for (i = 0; i < nu; i++) {
      var B = j > 0 ? H[(j - 1) * nu + i] : null, T = j < nv ? H[j * nu + i] : null;
      if (!B && !T) continue;
      var v = breaksV[j], x0 = breaksU[i], x1 = breaksU[i + 1];
      wall(node(i, j), node(i + 1, j),
        (function (uu, vv) { return function (z) { return P(uu, vv, z); }; })(x0, v),
        (function (uu, vv) { return function (z) { return P(uu, vv, z); }; })(x1, v),
        B ? B[3] : 0, B ? B[2] : 0, T ? T[0] : 0, T ? T[1] : 0, V);
    }
    /* A crossing - two adjacent cells whose height difference changes sign
       along their shared edge - would need a vertex in the MIDDLE of the edge,
       which the cell tops above do not have, so it would be a T-junction of
       its own. No pattern here produces one (a tie row is flat and the
       patterns' own fields do not cross), and the count is carried out so a
       future pattern that does cannot do it silently. */
    return { hmax: hmax, back: lift, tipArea: tipArea, solidCells: solidCells,
             volume: vol, crossings: crossings };
  }

  /* The ring as its own body: a closed tapered annulus, the same tapered wall
     ringRelief builds, closed underneath by a bottom annulus instead of by a
     host's face. Topologically a torus, so Euler 0 - that is a closed shell,
     not an open one. */
  function looseRing(fr, p, out, back) {
    var zb = back || 0;   /* the ring rides on a foot of its own base section */
    if (p.wallTip > p.wallBase || p.wallTip <= 0) return 'ring wall must taper: 0 < wallTip <= wallBase';
    if (p.wallBase >= p.rOut) return 'ring wall thicker than its radius';
    var half = Math.min(fr.W, fr.D) / 2;
    if (p.rOut > half) return 'ring r ' + p.rOut + ' does not fit a ' + fr.W.toFixed(2) + ' x ' + fr.D.toFixed(2) + ' patch';
    var seg = Math.max(12, p.segments | 0);
    var taper = (p.wallBase - p.wallTip) / 2;
    var rOut0 = p.rOut, rOut1 = p.rOut - taper;
    var rIn0 = p.rOut - p.wallBase, rIn1 = rIn0 + taper;
    var h = p.height;
    var U = fr.U, V = fr.V, N = fr.N;
    var C = add(fr.c[0], add(scale(U, fr.W / 2), scale(V, fr.D / 2)));
    function circle(r, z) {
      var pts = [], k, th, q;
      for (k = 0; k < seg; k++) {
        th = 2 * Math.PI * k / seg;
        q = add(C, add(scale(U, r * Math.cos(th)), scale(V, r * Math.sin(th))));
        if (z) q = add(q, scale(N, z));
        pts.push(q);
      }
      return pts;
    }
    var o0 = circle(rOut0, zb), o1 = circle(rOut1, zb + h), i1 = circle(rIn1, zb + h), i0 = circle(rIn0, zb);
    var ob = circle(rOut0, 0), ib = circle(rIn0, 0);   /* the foot's underside */
    var radial = [], k2;
    for (k2 = 0; k2 < seg; k2++) {
      var t = 2 * Math.PI * k2 / seg;
      radial.push(add(scale(U, Math.cos(t)), scale(V, Math.sin(t))));
    }
    function strip(A, B, wantFn) {
      for (var k = 0; k < seg; k++) {
        var k1 = (k + 1) % seg, w = wantFn(k);
        pushOriented(out, A[k], A[k1], B[k1], w);
        pushOriented(out, A[k], B[k1], B[k], w);
      }
    }
    strip(o0, o1, function (k) { return radial[k]; });                /* outer wall */
    strip(o1, i1, function () { return N; });                         /* top annulus */
    strip(i1, i0, function (k) { return scale(radial[k], -1); });     /* inner wall */
    if (zb > 0) {
      strip(o0, ob, function (k) { return radial[k]; });              /* foot, outer */
      strip(ib, i0, function (k) { return scale(radial[k], -1); });   /* foot, inner */
    }
    strip(ib, ob, function () { return scale(N, -1); });              /* bottom annulus */
    return {
      hmax: h, tipArea: Math.PI * (rOut1 * rOut1 - rIn1 * rIn1),
      rOutTop: rOut1, rInTop: rIn1,
      volume: Math.PI * h * ((rOut0 * rOut0 - rIn0 * rIn0) + (rOut1 * rOut1 - rIn1 * rIn1)) / 2,
      crossings: 0
    };
  }

  function buildLoose(o) {
    var name = o.pattern;
    if (!Skin.PATTERNS[name]) return 'unknown pattern "' + name + '"';
    var p = Skin.withDefaults(name, o.params);
    if (!(p.height > 0)) return 'height must be positive';
    var fw = featureWall(name, p);
    if (!(fw.base >= MIN_WALL - 1e-9)) {
      return 'loose: the pattern\'s feature wall is ' + fw.base + ' mm at the base, under the ' + MIN_WALL +
        ' mm one line - a loose patch has nothing else holding it';
    }
    var back = o.back == null ? (LOOSE_BACK[fam(name)] || 0) : o.back;
    if (!(back >= 0)) return 'loose: back must not be negative';
    if (back > 0 && back < MIN_WALL - 1e-9) {
      return 'loose: the foot is a wall of its own - ' + back + ' mm is under the ' + MIN_WALL + ' mm one line';
    }
    var fr = Skin.planeFrame([0, 0, 0], [1, 0, 0], [0, 1, 0], o.W, o.D);
    if (typeof fr === 'string') return 'loose: ' + fr;
    var out = [], info, ties = [], tieW = 0;
    if (fam(name) === 'ring') {
      info = looseRing(fr, p, out, back);
      if (typeof info === 'string') return 'loose: ' + info;
    } else {
      var plan = Skin.patternPlan(name, Object.assign({}, o.params || {}, { margin: o.margin }), fr, 0);
      if (typeof plan === 'string') return 'loose: ' + plan;
      /* Ties. A crosshatch's ribs cross, so it needs none; a zigzag's ridges
         are parallel and need two to be one patch. Explicit ties: 0 turns
         them off and the result reports the components that leaves. */
      var n = o.ties == null ? (fam(name) === 'zigzag' ? 2 : 0) : (o.ties | 0);
      /* a tie is a rib, so it is one extrusion line wide - the crosshatch's
         own rib figure - not the ridge's base width it crosses */
      tieW = o.tie == null ? MIN_WALL : o.tie;
      if (n > 0 && !(tieW >= MIN_WALL - 1e-9)) {
        return 'loose: a tie is a wall of its own - ' + tieW + ' mm is under the ' + MIN_WALL + ' mm one line';
      }
      ties = tieIntervals(o.D, tieW, n, o.margin);
      if (n > 0 && !ties.length) return 'loose: ' + n + ' tie(s) ' + tieW + ' mm wide do not fit a ' + o.D + ' mm patch';
      var bv = plan.breaksV.slice(), q;
      for (q = 0; q < ties.length; q++) bv.push(ties[q][0], ties[q][1]);
      var breaksV = mergeBreaks(bv, [], 1e-9);
      var patternCells = plan.cellHeights, hTie = p.height;
      var cells = ties.length ? function (u0, u1, v0, v1) {
        var a = patternCells(u0, u1, v0, v1);
        if (!inAny((v0 + v1) / 2, ties)) return a;
        if (u0 < o.margin - 1e-9 || u1 > o.W - o.margin + 1e-9) return a;  /* a tie stops at the margin too */
        return [Math.max(a[0], hTie), Math.max(a[1], hTie), Math.max(a[2], hTie), Math.max(a[3], hTie)];
      } : patternCells;
      info = looseGrid(fr, plan.breaksU, breaksV, cells, out, back);
      info.margin = plan.margin;
      if (plan.ribsU != null) { info.ribsU = plan.ribsU; info.ribsV = plan.ribsV; }
      if (plan.ridges != null) info.ridges = plan.ridges;
    }
    var tris = new Float32Array(out);
    return {
      tris: tris,
      variant: 'loose',
      pattern: name, params: p, describe: Skin.PATTERNS[name].describe(p),
      W: o.W, D: o.D, margin: o.margin,
      height: info.hmax + back, tipHeight: info.hmax, tipsZ: info.hmax + back, tipArea: info.tipArea,
      back: back,
      ties: ties.length, tieWidth: ties.length ? tieW : 0,
      /* a loose patch adds nothing to the pattern but its ties, so the
         thinnest wall in the file IS the pattern's own feature */
      minWall: Math.min.apply(null, [fw.base].concat(ties.length ? [tieW] : []).concat(back > 0 ? [back] : [])),
      tipWall: fw.tip,
      closed: true,
      components: countComponents(tris),
      nonSolidAdvised: true,
      info: info
    };
  }

  /* ------------------------------------------------ the sandwich washer

     Double-sided: the pattern on the +Z face AND the -Z face, nothing solid
     in between. The whole piece is one height field with a common base at
     z = 0 - every solid cell runs the full height, every empty cell is empty
     the whole way through - so it is built by looseGrid, unmodified, with
     back 0, and it is watertight for exactly the reason the loose variant is.

     That common base is the entire design. A rim standing proud, or a frame
     recessed below the tips, would need a per-cell FLOOR as well as a per-cell
     top, which looseGrid does not have and which would mean two exposed
     strips per grid edge instead of one. A prismatic lattice needs neither:
     hold every solid cell at the same height and the piece is symmetric about
     its own mid-plane for free. */
  function buildSandwich(o) {
    var name = o.pattern;
    if (!Skin.PATTERNS[name]) return 'unknown pattern "' + name + '"';
    /* Prismatic only, and refused by name rather than built lopsided. */
    if (fam(name) === 'ring') {
      return 'sandwich: ring has no height field - it builds its own surface, and a floorless ' +
        'frame would leave the annulus floating. Use bordered for the ring.';
    }
    if (fam(name) !== 'crosshatch') {
      return 'sandwich: "' + name + '" is not prismatic - it tapers, so its underside is a wide ' +
        'flat base and its two faces are not the same pattern. A sandwich piece has to present ' +
        'the SAME contact on both faces; only the crosshatch family does.';
    }
    var p = Skin.withDefaults(name, o.params);
    if (!(p.height > 0)) return 'height must be positive';
    var fw = featureWall(name, p);
    if (!(fw.base >= MIN_WALL - 1e-9)) {
      return 'sandwich: the pattern\'s rib is ' + fw.base + ' mm, under the ' + MIN_WALL +
        ' mm one line - nothing else is holding this piece together';
    }
    var frame0 = o.frame == null ? MIN_WALL : o.frame;
    if (!(frame0 >= MIN_WALL - 1e-9)) {
      return 'sandwich: the frame is a rib of its own - ' + frame0 + ' mm is under the ' +
        MIN_WALL + ' mm one line';
    }
    var fr = Skin.planeFrame([0, 0, 0], [1, 0, 0], [0, 1, 0], o.W, o.D);
    if (typeof fr === 'string') return 'sandwich: ' + fr;

    /* The lattice, inset by the nominal frame width. */
    var plan = Skin.patternPlan(name, Object.assign({}, o.params || {}, { margin: frame0 }), fr, 0);
    if (typeof plan === 'string') return 'sandwich: ' + plan;
    if (!plan.ivU || !plan.ivU.length || !plan.ivV || !plan.ivV.length) {
      return 'sandwich: no ribs fit a ' + o.W + ' x ' + o.D + ' mm patch at pitch ' + p.pitch;
    }
    /* ...widened to MEET the outermost rib, so the centring leftover does not
       become a sliver channel between the frame and rib 1. */
    var fU = plan.ivU[0][0], fV = plan.ivV[0][0];
    if (!(fU * 2 < o.W) || !(fV * 2 < o.D)) {
      return 'sandwich: a ' + round3(fU) + ' mm frame leaves no lattice in ' + o.W + ' x ' + o.D + ' mm';
    }
    var h = p.height, cells = plan.cellHeights;
    var W = o.W, D = o.D;
    function sandwichCells(u0, u1, v0, v1) {
      var um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      if (um < fU || um > W - fU || vm < fV || vm > D - fV) return [h, h, h, h];
      return cells(u0, u1, v0, v1);
    }
    var out = [];
    var info = looseGrid(fr, plan.breaksU, plan.breaksV, sandwichCells, out, 0);
    info.margin = 0;
    info.ribsU = plan.ribsU; info.ribsV = plan.ribsV;
    var tris = new Float32Array(out);

    /* The frame's own share of the contact, analytically - so the pattern's
       share is a number and not "the rest of it". */
    var frameArea = W * D - (W - 2 * fU) * (D - 2 * fV);
    return {
      tris: tris,
      variant: 'sandwich',
      pattern: name, params: p,
      describe: Skin.PATTERNS[name].describe(p),
      W: W, D: D, margin: 0,
      height: info.hmax, tipHeight: info.hmax, tipsZ: info.hmax,
      /* ONE contact number, because the top face set and the bottom face set
         are the same set - the solid is a straight extrusion of it. The test
         measures both off the mesh rather than taking this on trust. */
      tipArea: info.tipArea,
      topArea: info.tipArea, bottomArea: info.tipArea,
      frame: fU, frameV: fV, frameNominal: frame0, frameArea: frameArea,
      patternArea: info.tipArea - frameArea,
      back: 0, ties: 0, tieWidth: 0,
      floor: 0, proud: 0,
      minWall: Math.min(fw.base, fU, fV),
      tipWall: fw.tip,
      closed: true,
      components: countComponents(tris),
      /* Same call as loose, and for the same reason: a free-standing
         one-extrusion-line lattice is docs/NON-SOLID.md's printable-fabric
         case, and the flag is what stands Repair's trimming stages down. */
      nonSolidAdvised: true,
      info: info
    };
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  /* The soup's bounding-box size, measured. */
  function extentOf(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, k;
    for (i = 0; i < soup.length; i += 3) {
      for (k = 0; k < 3; k++) {
        if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
        if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
      }
    }
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }

  /* Edge-connected components, the same union-find the drive checks use on a
     downloaded STL - reported, not gated on: a zigzag with ties: 0 is
     several ridges by construction and says so. */
  function countComponents(soup) {
    var n = (soup.length / 9) | 0;
    var parent = new Array(n), i;
    for (i = 0; i < n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function uni(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
    function vk(t, k) {
      var o = t * 9 + k * 3;
      return Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
    }
    var owner = new Map();
    for (i = 0; i < n; i++) {
      var k3 = [vk(i, 0), vk(i, 1), vk(i, 2)];
      for (var e = 0; e < 3; e++) {
        var a = k3[e], b = k3[(e + 1) % 3];
        var ek = a < b ? a + '|' + b : b + '|' + a;
        if (owner.has(ek)) uni(owner.get(ek), i); else owner.set(ek, i);
      }
    }
    var roots = new Set();
    for (i = 0; i < n; i++) roots.add(find(i));
    return roots.size;
  }

  /* ------------------------------------------------------------- apply */

  /* buildPatch(opts) -> { ok, reason?, tris, ... } - never a half-result.
     opts: see DEFAULTS. variant 'bordered' | 'loose'. */
  function buildPatch(opts) {
    var o = withDefaults(opts);
    if (!Skin || !Skin.PATTERNS) return { ok: false, reason: 'NSO_Skin not loaded' };
    if (!VARIANTS[o.variant]) {
      return { ok: false, reason: 'unknown variant "' + o.variant + '" (bordered, loose or sandwich)' };
    }
    if (!(o.W > 0) || !(o.D > 0)) return { ok: false, reason: 'the patch footprint must be positive' };
    if (o.margin != null && !(o.margin >= 0)) return { ok: false, reason: 'margin must not be negative' };
    if (o.margin == null) o.margin = VARIANT_MARGIN[o.variant];
    if (o.variant === 'bordered' && !(o.margin > 0)) {
      return { ok: false, reason: 'a bordered patch needs margin > 0 - at margin 0 the pattern\'s ' +
        'end walls land in the pocket wall\'s own plane (see VARIANT_MARGIN)' };
    }
    /* The sandwich has no empty inset to set: the band a margin would leave
       open is exactly what its FRAME fills. Taking a `margin` here and
       quietly ignoring it would be the worse of the two options, so it is
       refused by name and pointed at the knob that does the job. */
    if (o.variant === 'sandwich' && opts && opts.margin != null) {
      return { ok: false, reason: 'a sandwich patch has no margin - the band a margin would leave ' +
        'open is what its frame fills. Use `frame` to set the perimeter rib\'s width.' };
    }
    var r = o.variant === 'bordered' ? buildBordered(o)
          : o.variant === 'sandwich' ? buildSandwich(o)
          : buildLoose(o);
    if (typeof r === 'string') return { ok: false, reason: r };
    r.ok = true;
    r.variantDescribe = VARIANTS[o.variant];
    r.tris_count = (r.tris.length / 9) | 0;
    r.extent = extentOf(r.tris);   /* measured, not the footprint asked for -
       a loose ring is 2 x rOut across and says so rather than claiming the
       30 x 30 frame it was laid out in */
    r.describeFull = r.variant === 'bordered'
      ? (r.describe + ', in a ' + r.rim + ' mm rim ' + r.proud + ' mm proud of the tips, on a ' +
         r.floor + ' mm floor - ' + r.W + ' x ' + r.D + ' x ' + r.rimTopZ.toFixed(2) + ' mm')
      : r.variant === 'sandwich'
      ? (r.describe + ', double-sided in a ' + round3(r.frame) + ' mm frame rib, no floor - ' +
         r.extent.map(function (x) { return x.toFixed(2); }).join(' x ') + ' mm, ' +
         r.tipArea.toFixed(2) + ' mm\u00b2 contact on EACH face (' +
         r.patternArea.toFixed(2) + ' pattern + ' + r.frameArea.toFixed(2) + ' frame), ' +
         r.components + ' component(s), walls ' + round3(r.minWall) + ' mm')
      : (r.describe + ', loose' + (r.ties ? ' on ' + r.ties + ' tie(s) ' + r.tieWidth + ' mm wide' : ', untied') +
         (r.back ? ' over a ' + r.back + ' mm foot' : '') +
         ' - ' + r.extent.map(function (x) { return x.toFixed(2); }).join(' x ') + ' mm, ' + r.components + ' component(s), walls ' +
         r.minWall + (r.tipWall < r.minWall ? ' tapering to ' + r.tipWall : '') + ' mm');
    return r;
  }

  var api = {
    MIN_WALL: MIN_WALL, FLOOR: FLOOR, RIM: RIM, PROUD: PROUD, SIZE: SIZE,
    VARIANTS: VARIANTS, VARIANT_MARGIN: VARIANT_MARGIN, LOOSE_BACK: LOOSE_BACK, DEFAULTS: DEFAULTS,
    familyOf: fam,
    withDefaults: withDefaults,
    traySoup: traySoup,
    buildPatch: buildPatch,
    extentOf: extentOf,
    countComponents: countComponents
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SkinPatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
