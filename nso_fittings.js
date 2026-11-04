/* nso_fittings.js - Fittings: a slip-on pipe cap and a 2- or 3-way splitter, each a piece of its own.

   Headless: no DOM, no THREE, no app state. Loads as a classic script (window.NSO_Fittings) and as a
   Node module; tools/nso_fittings_test.js drives it, app-fittings.js is the card on it.
   docs/FITTINGS.md.

   Both make a NEW piece. Neither edits the one that is selected: the cap is sized FROM a tube, the
   splitter may take its Ø and wall from one, and what comes back is a piece to drop on the plate -
   which Join, Connect or Seat can then put where it goes.

   ---------------------------------------------------------------------------
   CAP: a slip-on cap, the open-ended cup a plumber calls a pipe cap
   ---------------------------------------------------------------------------
   Given a tube's outside Ø and wall (read off the selected tube's open end by capFromTube, or typed):

       bore       the tube's outside Ø + 2 x gap     (gap: radial clearance, 0.25 mm: a printed slip fit)
       wall       the tube's wall                    (NOT the cap's own idea of one)
       end        the tube's wall                    (the closed end is as thick as the walls)
       depth      how far the tube goes in           (default: 0.75 x the tube's Ø, 8 to 30 mm)

   One solid of revolution, closed end DOWN on z = 0 and the open end up, so it prints without support
   and the bore is the open top. The meridian is built on the APOTHEM: a 96-gon's flats sit
   R cos(pi/96) inside its corners, so the bore is laid out at (od/2 + gap) / cos(pi/n) - its flats clear
   the tube's by exactly the gap, not its corners.

   The tube is NOT modified, and the cap is not "added to" it. They are two pieces; the tube goes in the
   cap by hand.

   ---------------------------------------------------------------------------
   SPLITTER: one trunk into 2 or 3 branches, as a piece of its own
   ---------------------------------------------------------------------------
   A trunk along +Z from z = 0 (the inlet, flat on the bed) to the JUNCTION J at z = trunkLen; `ways`
   branches leave J, each tilted `angle` degrees off the trunk's axis and straight on for branchLen,
   their ends square to their own axes and open. Two ways: in a plane, at +angle and -angle (a Y).
   Three: 120 degrees apart round the axis, all at `angle`. Printing orientation is the model's:
   trunk down, branches up and out, no bridge over 90 - angle degrees.

   HUB AND SPOKE. Outside: the trunk's cylinder, each branch's, and a sphere at J as big as the largest
   of them. Bore: the same cylinders, one wall smaller, and a sphere one wall smaller than the hub's.
   solid = union(outside) - union(bores). Every cylinder's axis passes through J, so each one's end disc
   lies inside the hub sphere and nothing is left between them; the wall is the wall everywhere that
   the surfaces are concentric (the hub), and in the straight runs. The bores of neighbouring branches
   merge into the hub's chamber and part again where they separate: a knife edge between them inside the
   crotch, as in every moulded Y.

   THE GATES, on the kernel's own result: it says NoError, is not empty, is one body (not pieces), and
   its genus is (openings - 1): the thickened surface of a sphere with `openings` holes, which is what a
   Y of three open ends is. A hub that did not merge, a branch that did not open, or an outlet that fused
   with its neighbour changes that number.

   REFUSALS, before anything is built, in words:
     - a wall under the nozzle-safety floor (nso_thickness.js)
     - a bore under 2 nozzle widths across, on any run
     - an angle outside 10 to 80 degrees
     - branch ends that would touch (the outlets must stand a millimetre clear of each other)

   The kernel is the app's own (nso_csg.js: Manifold, WASM) and is handed in: splitter(opts, wasm). */

(function (root) {
  'use strict';

  var DEFAULTS = {
    gap: 0.25,           // cap: radial clearance, mm
    segments: 96,        // cap: sides of the revolve
    capDepthMin: 8, capDepthMax: 30, capDepthPerOd: 0.75,
    od: 20, wall: 2,     // splitter: trunk outside Ø and the wall of every run
    branchOdPer: { 2: 0.75, 3: 0.65 },   // branch Ø as a fraction of the trunk's
    angle: 35,           // splitter: each branch off the trunk's axis, degrees
    trunkLen: 25, branchLen: 30,
    sides: 64,           // splitter: facets round every cylinder and the hub
    outletGap: 1,        // splitter: least clear space between two outlets' outsides, mm
    minAngle: 10, maxAngle: 80,
    maxLeanDeg: 2        // capFromTube: the tube's wall within this of its axis at the end
  };

  function fmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
  function num(x) { return (x == null || x === '' || !isFinite(+x)) ? null : +x; }

  function floorFor(nozzle) {
    var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : (root && root.NSO_Thickness) || null;
    if (!T || typeof T.floorFor !== 'function') return null;
    return T.floorFor(nozzle);
  }
  function nozzleOf(o) { return (o && typeof o.nozzle === 'number' && o.nozzle > 0) ? o.nozzle : 0.4; }
  function revolver() {
    var S = (typeof NSO_Stock !== 'undefined') ? NSO_Stock : (root && root.NSO_Stock) || null;
    return S && S.revolve ? S : null;
  }
  var NEED_FLOOR = 'nso_thickness.js must be loaded - a fitting\'s wall is held to its nozzle-safety floor, and carries no copy of it';

  /* ===================================================================== CAP */

  /* The cap's default depth for a tube of outside Ø od. */
  function capDepthFor(od) {
    return Math.round(Math.min(DEFAULTS.capDepthMax, Math.max(DEFAULTS.capDepthMin, DEFAULTS.capDepthPerOd * od)) * 2) / 2;
  }

  /* opts: { od (the tube's outside Ø, mm), wall (the tube's wall), gap, depth, endWall, segments, nozzle }.
     Returns { ok, reason, soup, info }. */
  function cap(opts) {
    opts = opts || {};
    var res = { ok: false, reason: '' };
    var rv = revolver();
    if (!rv) { res.reason = 'nso_stock.js must be loaded - the cap is a solid of revolution and uses its revolve'; return res; }
    var od = num(opts.od), wall = num(opts.wall), gap = num(opts.gap), depth = num(opts.depth), endWall = num(opts.endWall);
    var n = Math.max(12, Math.round(num(opts.segments) || DEFAULTS.segments)), nozzle = nozzleOf(opts), floor = floorFor(nozzle);
    if (floor == null) { res.reason = NEED_FLOOR; return res; }
    if (!(od > 0)) { res.reason = 'enter the tube\'s outside Ø in mm, more than 0'; return res; }
    if (!(wall > 0)) { res.reason = 'enter the wall in mm, more than 0'; return res; }
    if (gap == null) gap = DEFAULTS.gap;
    if (gap < 0) { res.reason = 'a fit gap of ' + fmt(gap) + ' mm is refused - it is the clearance round the tube, 0 or more'; return res; }
    if (endWall == null) endWall = wall;                       // the end is as thick as the walls
    if (depth == null) depth = capDepthFor(od);
    if (!(depth > 0)) { res.reason = 'the depth the tube goes in must be more than 0'; return res; }
    if (!(endWall > 0)) { res.reason = 'the end\'s thickness must be more than 0'; return res; }
    var low = wall < endWall ? wall : endWall;
    if (low < floor - 1e-9) {
      res.reason = 'a ' + fmt(low) + ' mm ' + (wall <= endWall ? 'wall' : 'end') + ' is under the nozzle-safety floor of ' + fmt(floor) +
        ' mm (nso_thickness.js: one extrusion line at a ' + nozzle + ' mm nozzle) - the cap would not print solid';
      return res;
    }
    // laid out on the apothem: a flat of the n-gon is where the radius says, a corner is 1 / cos(pi / n) out
    var k = 1 / Math.cos(Math.PI / n);
    var aIn = od / 2 + gap, aOut = aIn + wall;
    var Rin = aIn * k, Rout = aOut * k, H = depth + endWall;
    var loop = [{ z: 0, r: 0 }, { z: 0, r: Rout }, { z: H, r: Rout }, { z: H, r: Rin }, { z: endWall, r: Rin }, { z: endWall, r: 0 }];
    var soup = rv.revolve(loop, n);
    res.ok = true; res.soup = soup;
    res.info = { kind: 'cap', tubeOdMm: od, wallMm: wall, endMm: endWall, gapMm: gap, depthMm: depth, boreDiaMm: 2 * aIn, outsideDiaMm: 2 * aOut, heightMm: H,
                 segments: n, floorMm: floor };
    res.reason = 'Cap for a Ø' + fmt(od) + ' tube: bore Ø' + fmt(2 * aIn) + ' (' + fmt(gap) + ' mm clear all round), outside Ø' + fmt(2 * aOut) + ', wall ' + fmt(wall) +
      ' and closed end ' + fmt(endWall) + ' mm, ' + fmt(depth, 1) + ' mm of tube goes in - ' + fmt(H, 1) + ' mm tall, closed end down';
    return res;
  }

  /* The cap for the open end of a tube soup: its Ø and wall read off that end (NSO_tubeEdgeRead - the same
     reader Tube edge uses), then cap(). opts as cap's, plus point [x, y, z] (raw frame) to choose the end:
     the one nearest it, else the highest. The tube's wall must run square to its axis there. */
  function capFromTube(soup, opts) {
    opts = opts || {};
    var res = { ok: false, reason: '' };
    var rd = (typeof NSO_tubeEdgeRead === 'function') ? NSO_tubeEdgeRead : (root && root.NSO_tubeEdgeRead);
    if (typeof rd !== 'function') { res.reason = 'nso_tube_edge.js must be loaded - the cap reads the tube\'s end with its reader'; return res; }
    var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup || []);
    var r = rd(f32, { point: opts.point || null });
    res.read = r;
    if (!r.ok) { res.reason = r.reason.replace(/ Flare and Roll work on .*$/, ' A cap fits the open, round end of a tube.'); return res; }
    var e = r.end;
    if (Math.abs(e.leanDeg) > DEFAULTS.maxLeanDeg) {
      res.reason = 'that tube\'s wall leans ' + fmt(Math.abs(e.leanDeg), 1) + '° off its axis at the end (a flare or a taper) - a cap slips over a straight pipe, within ' +
        DEFAULTS.maxLeanDeg + '°';
      return res;
    }
    var o = {};
    for (var k in opts) if (k !== 'point') o[k] = opts[k];
    o.od = 2 * e.Ro; o.wall = e.wallMm;
    var c = cap(o);
    c.read = r; c.end = e;
    return c;
  }

  /* ================================================================ SPLITTER */

  /* The splitter's numbers as the build will use them, or why not.
     opts: { ways 2|3, od, wall, branchOd, angle, trunkLen, branchLen, nozzle, sides }. */
  function splitterSize(opts) {
    opts = opts || {};
    var res = { ok: false, reason: '' };
    var ways = +opts.ways, nozzle = nozzleOf(opts), floor = floorFor(nozzle);
    if (floor == null) { res.reason = NEED_FLOOR; return res; }
    if (ways !== 2 && ways !== 3) { res.reason = 'a splitter is 2-way or 3-way: one trunk into 2 or 3 branches'; return res; }
    var od = num(opts.od), wall = num(opts.wall), bod = num(opts.branchOd), ang = num(opts.angle), lt = num(opts.trunkLen), lb = num(opts.branchLen);
    if (od == null) od = DEFAULTS.od;
    if (wall == null) wall = DEFAULTS.wall;
    if (bod == null) bod = Math.round(od * DEFAULTS.branchOdPer[ways] * 10) / 10;
    if (ang == null) ang = DEFAULTS.angle;
    if (lt == null) lt = DEFAULTS.trunkLen;
    if (lb == null) lb = DEFAULTS.branchLen;
    var sides = Math.max(16, Math.round(num(opts.sides) || DEFAULTS.sides));
    if (!(od > 0)) { res.reason = 'enter the trunk\'s outside Ø in mm, more than 0'; return res; }
    if (!(bod > 0)) { res.reason = 'enter the branches\' outside Ø in mm, more than 0'; return res; }
    if (!(wall > 0)) { res.reason = 'enter the wall in mm, more than 0'; return res; }
    if (!(lt > 0) || !(lb > 0)) { res.reason = 'the trunk and the branches need a length, more than 0'; return res; }
    if (wall < floor - 1e-9) {
      res.reason = 'a ' + fmt(wall) + ' mm wall is under the nozzle-safety floor of ' + fmt(floor) + ' mm (nso_thickness.js: one extrusion line at a ' + nozzle + ' mm nozzle)';
      return res;
    }
    var boreMin = 2 * nozzle, bt = od - 2 * wall, bb = bod - 2 * wall;
    if (bt < boreMin - 1e-9) {
      res.reason = 'the trunk\'s bore would be Ø' + fmt(Math.max(0, bt)) + ' (Ø' + fmt(od) + ' outside, ' + fmt(wall) + ' mm wall) - under the bore limit of Ø' + fmt(boreMin) +
        ' (2 nozzle widths at a ' + nozzle + ' mm nozzle). The outside must be at least Ø' + fmt(2 * wall + boreMin);
      return res;
    }
    if (bb < boreMin - 1e-9) {
      res.reason = 'the branches\' bore would be Ø' + fmt(Math.max(0, bb)) + ' (Ø' + fmt(bod) + ' outside, ' + fmt(wall) + ' mm wall) - under the bore limit of Ø' + fmt(boreMin) +
        ' (2 nozzle widths at a ' + nozzle + ' mm nozzle). Their outside must be at least Ø' + fmt(2 * wall + boreMin);
      return res;
    }
    if (ang < DEFAULTS.minAngle - 1e-9 || ang > DEFAULTS.maxAngle + 1e-9) {
      res.reason = 'a branch angle of ' + fmt(ang, 1) + '° is outside ' + DEFAULTS.minAngle + '° to ' + DEFAULTS.maxAngle + '° off the trunk\'s axis - less and the branches are one pipe, more and they are not a splitter';
      return res;
    }
    // the outlets stand clear of each other: the distance between two ends' axes, less the branch Ø
    var th = ang * Math.PI / 180, sep = ways === 2 ? 2 * lb * Math.sin(th) : Math.sqrt(3) * lb * Math.sin(th);
    var clear = sep - bod;
    if (clear < DEFAULTS.outletGap - 1e-9) {
      var need = (bod + DEFAULTS.outletGap) / (ways === 2 ? 2 : Math.sqrt(3)) / Math.sin(th);
      res.reason = 'the ' + ways + ' outlets would ' + (clear <= 0 ? 'run into each other' : 'stand only ' + fmt(clear) + ' mm apart') + ' - at ' + fmt(ang, 1) + '° and ' + fmt(lb, 1) +
        ' mm long the branch ends are ' + fmt(sep) + ' mm between axes for Ø' + fmt(bod) + ' pipes; they need ' + fmt(DEFAULTS.outletGap) + ' mm clear. Make the branches at least ' +
        fmt(Math.ceil(need * 10) / 10, 1) + ' mm long, the angle wider, or the branches narrower';
      return res;
    }
    res.ok = true;
    res.p = { ways: ways, od: od, wall: wall, branchOd: bod, angle: ang, trunkLen: lt, branchLen: lb, sides: sides, nozzle: nozzle, floorMm: floor,
              trunkBoreMm: bt, branchBoreMm: bb, outletClearMm: clear };
    return res;
  }

  /* Build it. wasm: the Manifold kernel module (NSO_CSG.load()). Resolves { ok, reason, soup, info }. */
  async function splitter(opts, wasm) {
    var sz = splitterSize(opts), res = { ok: false, reason: sz.reason };
    if (!sz.ok) return res;
    if (!wasm || !wasm.Manifold) { res.reason = 'the boolean kernel is not loaded'; return res; }
    var p = sz.p, M = wasm.Manifold, live = [];
    function keep(m) { if (live.indexOf(m) < 0) live.push(m); return m; }       // everything made is freed once, at the end
    function cyl(r, h) { return keep(M.cylinder(h, r, r, p.sides, false)); }
    function ball(r) { return keep(M.sphere(r, p.sides)); }
    var ro = p.od / 2, rb = p.branchOd / 2, ri = ro - p.wall, rbi = rb - p.wall;
    var hubO = Math.max(ro, rb), hubI = hubO - p.wall, J = p.trunkLen;
    // each branch's direction: tilt off +Z toward +X, then turn about Z
    var az = p.ways === 2 ? [0, 180] : [0, 120, 240];
    function branch(r, h) {
      return az.map(function (a) { return keep(keep(keep(cyl(r, h)).rotate([0, p.angle, 0])).rotate([0, 0, a])).translate([0, 0, J]); });
    }
    var out = null;
    try {
      var outer = [cyl(ro, J)].concat(branch(rb, p.branchLen), [keep(ball(hubO).translate([0, 0, J]))]);
      // the bores run a unit past every open end, so each is cut through
      var inner = [keep(cyl(ri, J + 1).translate([0, 0, -1]))].concat(branch(rbi, p.branchLen + 1), [keep(ball(hubI).translate([0, 0, J]))]);
      var solid = keep(M.union(outer.map(keep)));
      var bore = keep(M.union(inner.map(keep)));
      out = solid.subtract(bore);
      var openings = p.ways + 1;
      if (out.status() !== 'NoError') { res.reason = 'internal: the kernel refused the splitter (' + out.status() + ')'; return res; }
      if (out.isEmpty()) { res.reason = 'internal: the splitter came out empty'; return res; }
      var parts = 1;
      if (typeof out.decompose === 'function') { var bodies = out.decompose(); parts = bodies.length; bodies.forEach(function (b) { b.delete(); }); }
      var genus = out.genus();
      if (parts !== 1 || genus !== openings - 1) {
        res.reason = 'internal: the splitter is ' + parts + ' body(ies) of genus ' + genus + ', not one of genus ' + (openings - 1) + ' (a thickened sphere with ' + openings +
          ' openings) - a branch did not open or two outlets fused';
        return res;
      }
      var vol = out.volume(), bb = out.boundingBox();
      res.soup = soupOf(out);
      res.ok = true;
      res.info = { kind: 'splitter', ways: p.ways, openings: openings, trunkOdMm: p.od, trunkBoreMm: p.trunkBoreMm, branchOdMm: p.branchOd, branchBoreMm: p.branchBoreMm,
                   wallMm: p.wall, angleDeg: p.angle, trunkLenMm: p.trunkLen, branchLenMm: p.branchLen, outletClearMm: p.outletClearMm, volumeMm3: vol, genus: genus,
                   bboxMin: bb.min, bboxMax: bb.max, floorMm: p.floorMm };
      res.reason = p.ways + '-way splitter: Ø' + fmt(p.od) + ' trunk (bore Ø' + fmt(p.trunkBoreMm) + ') into ' + p.ways + ' × Ø' + fmt(p.branchOd) + ' branches (bore Ø' + fmt(p.branchBoreMm) +
        ') at ' + fmt(p.angle, 0) + '°, wall ' + fmt(p.wall) + ' throughout · trunk ' + fmt(p.trunkLen, 1) + ' mm, branches ' + fmt(p.branchLen, 1) + ' mm, outlets ' + fmt(p.outletClearMm, 1) +
        ' mm apart · trunk down, branches up';
      return res;
    } catch (err) {
      res.reason = 'the splitter could not be built: ' + ((err && err.message) || err);
      return res;
    } finally {
      if (out) out.delete();
      live.forEach(function (m) { try { m.delete(); } catch (e) { /* already gone */ } });
    }
  }

  // Manifold -> a world triangle soup, 9 floats a triangle (nso_csg.js's manifoldToSoup, the same walk)
  function soupOf(man) {
    var mesh = man.getMesh(), vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp || 3;
    var s = new Float32Array(tv.length * 3), w = 0;
    for (var t = 0; t < tv.length; t++) { var v = tv[t] * np; s[w++] = vp[v]; s[w++] = vp[v + 1]; s[w++] = vp[v + 2]; }
    return s;
  }

  var API = { DEFAULTS: DEFAULTS, cap: cap, capFromTube: capFromTube, capDepthFor: capDepthFor, splitterSize: splitterSize, splitter: splitter };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Fittings = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
