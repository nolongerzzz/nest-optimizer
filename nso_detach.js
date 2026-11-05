/* nso_detach.js - Detach a detected feature from its hull, and put it back
   somewhere else.

   Loads as a classic script (window.NSO_Detach) and as a Node module. No DOM,
   no Three.js: a mesh is the app's raw soup (9 numbers per triangle, Z up, mm).

   READ docs/DETACH.md FIRST - it has the audit, the numbers, and the limits.

   ---------------------------------------------------------------------------
   WHAT IT IS, AND HOW IT DIFFERS FROM CROP
   ---------------------------------------------------------------------------
   Crop (app-crop.js) takes a BOX out of a piece and closes what is left: a
   slab slides back (stage 1), or a region moves and is reconnected to what it
   lands against, trimmed, touched or bridged (stage 2). The box is the
   user's and says nothing about the part.

   Detach starts from a feature the part is known to HAVE - today a flange,
   found by nso_flange.js - and uses what detection measured about it: the
   root plane, the neck wall the flange comes off, and where that wall steps.
   The hull is capped ON ITS OWN WALL, so what is left is the part as if the
   flange had never been there, not a part with a scar where it was cut. And
   the flange comes away as a real, closed piece in its own frame, ready to be
   seated somewhere else by Assemble's attach (reattach, below). Nothing is
   bridged, because nothing is left with a gap to bridge.

   ---------------------------------------------------------------------------
   THIS FILE IS CONNECTIVE TISSUE. There is no new geometry maths in it.
   ---------------------------------------------------------------------------

     NSO_Flange.extract   (nso_flange.js)   the flange, cut 2 um clear of the
                                            outermost neck wall, as validated
     rawCut / rawCutOpen  (app-cut.js)      every cut, and every cap: rawCut
                                            caps with rawFlatCapLoops
     NSO_cropSeal         (app-crop.js)     splices hull pieces cut at
                                            different planes - Crop stage 1's
                                            seal, step faces and all
     rawSplitDegenerates  (app-cut.js)      the finish
     NSO_cropEdgeCensus / NSO_cropVolume    the gate
     NSO_Assemble.attach  (nso_assemble.js) the seat, for reattach

   ---------------------------------------------------------------------------
   WHY THE HULL IS NOT ONE CUT
   ---------------------------------------------------------------------------
   The clamp bar's neck wall (library/v9_mirror_factory.stl) is not one plane.
   It is three: y = -2.0103 beyond the -X Mirror-Join seam, -1.9987 between
   the seams, -1.9897 beyond the +X seam. It steps 10 um at each seam. A hull
   capped on any single plane either keeps a skin of flange (13.5 um between
   the seams and 22.5 um beyond +X, on the flange's own cut plane) or is
   shaved off its own wall below the flange (a plane further in cuts the whole
   neck, not only the root). nso_flange.js now reports the wall's pieces
   (flange.cut.pieces). The hull is cut once per piece, each cut flush with
   its piece. The results are cut apart at the steps, and the pieces are sealed
   back together with Crop's seal. The seal re-makes the step faces, so the
   root cap is a 10 um staircase that follows the wall exactly. A wall that is
   one plane, the usual case, is one rawCut and no splice.

   PAINT SCOPE: NONE, for this module. It reads soups and writes none.
   app-detach.js replaces the piece and declares its own scope.
   ===================================================================== */
(function (root) {
  'use strict';

  var TOL = 1e-4;              // Cut's RAW_CUT_WELD_TOL, the checker's weld radius
  var STEP_TOL = 1e-3;         // mm two wall pieces may miss meeting by, along the root
  var TRACE_TOL = 1e-5;        // mm of float noise a hull vertex may stand past its wall

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]); return l ? [a[0] / l, a[1] / l, a[2] / l] : null; }
  function clean(a) { return a.map(function (x) { return Math.abs(x) < 1e-12 ? 0 : x; }); }

  function dep(deps, name) {
    var v = (deps && deps[name]) || (root && root[name]) ||
            (typeof globalThis !== 'undefined' ? globalThis[name] : null);
    return v || null;
  }
  function need(deps, names) {
    var got = {}, missing = [];
    names.forEach(function (n) { var v = dep(deps, n); if (v) got[n] = v; else missing.push(n); });
    return { got: got, missing: missing };
  }

  /* Rows of a rotation, applied as p' = M p. Rows that are signed unit axes
     (the clamp bar: X, -Y, -Z) move every coordinate exactly. */
  function turn(soup, M, transpose) {
    var out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      var x = soup[i], y = soup[i + 1], z = soup[i + 2];
      if (!transpose) {
        out[i] = M[0][0] * x + M[0][1] * y + M[0][2] * z;
        out[i + 1] = M[1][0] * x + M[1][1] * y + M[1][2] * z;
        out[i + 2] = M[2][0] * x + M[2][1] * y + M[2][2] * z;
      } else {
        out[i] = M[0][0] * x + M[1][0] * y + M[2][0] * z;
        out[i + 1] = M[0][1] * x + M[1][1] * y + M[2][1] * z;
        out[i + 2] = M[0][2] * x + M[1][2] * y + M[2][2] * z;
      }
    }
    return out;
  }

  function triArea(s, o) {
    var ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
    var vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }

  /* Crop's toTris: triangles as [p,p,p], minus any lying IN the joint plane.
     rawCutOpen keeps an in-plane triangle only when it faces the removed side
     (a flat face the plane lands on exactly - here the wall's step face at a
     Mirror-Join seam). It is section, not wall, and the seal re-makes it. */
  function openTris(flat, k, plane) {
    var out = [];
    for (var t = 0; t + 8 < flat.length; t += 9) {
      var v = [[flat[t], flat[t + 1], flat[t + 2]], [flat[t + 3], flat[t + 4], flat[t + 5]],
               [flat[t + 6], flat[t + 7], flat[t + 8]]];
      if (v[0][k] === plane && v[1][k] === plane && v[2][k] === plane) continue;
      out.push(v);
    }
    return out;
  }

  /* -------------------------------------------------------------------------
     detach(soup, flange, deps) -> { ok, reason, hull, piece, wall, volumes, ... }

     `flange` is one entry of NSO_Flange.detect(soup).flanges.
     `deps` may name rawCut, rawCutOpen, rawSplitDegenerates, NSO_cropSeal,
     NSO_cropEdgeCensus, NSO_cropVolume and NSO_Flange; any not named is
     looked up on the page (window), where app-cut.js, app-crop.js and
     nso_flange.js put them.

     On refusal ok is false, reason says why in words, and nothing is made.
     ---------------------------------------------------------------------- */
  function detach(soup, flange, deps) {
    var t0 = Date.now();
    var out = { ok: false, reason: '', stage: 'deps' };
    var D = need(deps, ['rawCut', 'rawCutOpen', 'rawSplitDegenerates', 'NSO_cropSeal',
                        'NSO_cropEdgeCensus', 'NSO_cropVolume', 'NSO_Flange']);
    if (D.missing.length) {
      out.reason = 'Detach needs ' + D.missing.join(', ') + ' (app-cut.js, app-crop.js, nso_flange.js) - ' +
        'every cut, cap and seal here is theirs';
      return out;
    }
    var d = D.got;
    if (!soup || soup.length < 36) { out.reason = 'no geometry'; return out; }
    if (!flange || !flange.cut || !flange.axis) {
      out.reason = 'not a detected flange - run NSO_Flange.detect on this piece first';
      return out;
    }
    var cut = flange.cut;
    if (!cut.snapped || !cut.pieces || !cut.pieces.length) {
      out.reason = 'no neck wall was found beside the flange\'s root, so there is no wall of the ' +
        'hull\'s own to cap it flush with';
      return out;
    }

    /* ---- 1. the flange, exactly as the Flange tab lifts it ---- */
    out.stage = 'extract';
    var ex = d.NSO_Flange.extract(soup, flange, d.rawCut);
    if (!ex.ok) { out.reason = 'the flange would not lift out: ' + ex.reason; return out; }

    /* ---- 2. the working frame: along the root, out of the body, and the
       third axis. Right-handed: rows E, N, E x N. ---- */
    out.stage = 'frame';
    var N = clean(cut.normal), E = clean(cut.along || cross(flange.axis, N));
    var C = clean(cross(E, N));
    var M = [E, N, C];
    var ws = turn(soup, M, false);

    /* ---- 3. the wall pieces, in order along the root ---- */
    var pieces = cut.pieces.slice().sort(function (a, b) { return a.lo - b.lo; });
    for (var i = 0; i + 1 < pieces.length; i++) {
      var gap = pieces[i + 1].lo - pieces[i].hi;
      if (Math.abs(gap) > STEP_TOL) {
        out.reason = 'the neck wall is ' + pieces.length + ' flat pieces that do not meet end to end ' +
          'along the root (' + (gap > 0 ? 'a gap' : 'an overlap') + ' of ' + Math.abs(gap).toFixed(4) +
          ' mm between pieces ' + (i + 1) + ' and ' + (i + 2) + ') - Detach follows a wall ' +
          'that steps, not one that interleaves';
        out.wall = { pieces: pieces };
        return out;
      }
    }
    /* Planes and steps on float32 values: the soup is float32, rawCut's
       output is float32, and a step compared in double against a vertex
       rounded to float32 misses it by a micron and reads a seam vertex as
       standing past the wall by the whole 10 um step. */
    var planes = pieces.map(function (p) { return Math.fround(p.offset); });
    var steps = [];
    for (i = 0; i + 1 < pieces.length; i++) steps.push(Math.fround(pieces[i].hi));
    out.wall = { pieces: pieces, steps: steps };

    /* ---- 4. the hull: one rawCut per wall piece, spliced at the steps ---- */
    out.stage = 'hull';
    var H;
    try {
      H = planes.map(function (w) {
        var h = d.rawCut(ws, 1, w, false);               // keep N.p <= wall: the body side
        if (!h) throw new Error('the cut on the wall at ' + w.toFixed(4) + ' mm kept nothing');
        return h;
      });
    } catch (err) {
      out.reason = 'the hull would not cap on its wall: ' + ((err && err.message) || err);
      return out;
    }
    var hull = H[0], seals = [];
    try {
      for (i = 1; i < H.length; i++) {
        var s = steps[i - 1];
        var nearOpen = d.rawCutOpen(hull, 0, s, false), farOpen = d.rawCutOpen(H[i], 0, s, true);
        if (!nearOpen || !farOpen) throw new Error('a side of the step at ' + s.toFixed(4) + ' keeps nothing');
        var info = { at: s };
        var sealed = d.NSO_cropSeal(openTris(nearOpen, 0, s), openTris(farOpen, 0, s), 0, s, TOL, info);
        seals.push(info);
        hull = d.rawSplitDegenerates(new Float32Array(sealed));
      }
    } catch (err2) {
      out.reason = 'the hull\'s pieces would not seal at the wall\'s steps: ' + ((err2 && err2.message) || err2);
      out.seals = seals;
      return out;
    }
    out.seals = seals;

    /* ---- 5. the gate, on the float32 values it will be saved as ---- */
    out.stage = 'gate';
    var census = d.NSO_cropEdgeCensus(hull);
    out.census = census;
    if (census.open || census.repeated || census.degenerate) {
      out.reason = 'the hull is not closed (open ' + census.open + ', repeated ' + census.repeated +
        ', degenerate ' + census.degenerate + ')';
      return out;
    }
    /* No trace: no vertex of the hull stands past its own wall piece toward
       where the flange was. At a step the higher of the two is allowed. */
    var trace = 0;
    for (i = 0; i < hull.length; i += 3) {
      var a = hull[i], n = hull[i + 1], k = 0;
      while (k + 1 < pieces.length && a > steps[k]) k++;
      var allowed = planes[k];
      if (k < steps.length && a === steps[k]) allowed = Math.max(allowed, planes[k + 1]);
      if (n - allowed > trace) trace = n - allowed;
    }
    out.traceMm = trace;
    if (trace > TRACE_TOL) {
      out.reason = 'the hull still stands ' + (trace * 1000).toFixed(2) + ' um past its own wall';
      return out;
    }
    hull = turn(hull, M, true);
    /* Back out of a frame that is not an axis permutation, float32 rounds
       every vertex again: the census is asked again on what is handed back. */
    census = d.NSO_cropEdgeCensus(hull);
    if (census.open || census.repeated || census.degenerate) {
      out.census = census;
      out.reason = 'the hull did not survive the turn back into the part\'s frame (open ' + census.open +
        ', repeated ' + census.repeated + ', degenerate ' + census.degenerate + ')';
      return out;
    }

    /* ---- 6. the piece, in Assemble's frame: root face on z = 0, reaching
       along +Z, the plate normal on +Y. Rows E, A, N (E x A = N). ---- */
    out.stage = 'piece';
    var A = clean(flange.axis);
    var L = [E, A, N];
    var loc = turn(ex.positions, L, false);
    var zmin = Infinity;
    for (i = 2; i < loc.length; i += 3) if (loc[i] < zmin) zmin = loc[i];
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (i = 0; i < loc.length; i += 3) {
      if (loc[i + 2] - zmin > TOL) continue;
      for (k = 0; k < 2; k++) { if (loc[i + k] < lo[k]) lo[k] = loc[i + k]; if (loc[i + k] > hi[k]) hi[k] = loc[i + k]; }
    }
    var c0 = (lo[0] + hi[0]) / 2, c1 = (lo[1] + hi[1]) / 2;
    for (i = 0; i < loc.length; i += 3) {
      loc[i] = Math.fround(loc[i] - c0); loc[i + 1] = Math.fround(loc[i + 1] - c1);
      /* The root cap is on the cut plane. Turned through a frame that is not
         an axis permutation, float32 leaves it a hair off; put it back ON
         z = 0, as rawCutOpen snaps a near-plane vertex onto its plane. */
      var z = loc[i + 2] - zmin;
      loc[i + 2] = z <= TOL ? 0 : Math.fround(z);
    }
    var rootArea = 0;
    for (i = 0; i < loc.length; i += 9) {
      if (loc[i + 2] === 0 && loc[i + 5] === 0 && loc[i + 8] === 0) rootArea += triArea(loc, i);
    }
    var origin = [c0 * E[0] + c1 * A[0] + zmin * N[0], c0 * E[1] + c1 * A[1] + zmin * N[1],
                  c0 * E[2] + c1 * A[2] + zmin * N[2]];

    /* ---- 7. accounting: source = hull + flange + the sliver between the
       flange's cut (2 um clear of the OUTERMOST wall piece) and each piece.
       Anything more means the root plane took body that is not the flange. */
    var vSrc = d.NSO_cropVolume(soup), vHull = d.NSO_cropVolume(hull), vPiece = d.NSO_cropVolume(ex.positions);
    var sliver = vSrc - vHull - vPiece;
    var worst = 0;
    pieces.forEach(function (p) { worst = Math.max(worst, cut.offset - p.offset); });
    var sliverMax = worst * rootArea;
    out.volumes = { source: vSrc, hull: vHull, piece: vPiece, sliver: sliver, sliverMax: sliverMax };
    var slack = 1e-6 * Math.max(1, Math.abs(vSrc)) + 1e-3;
    if (sliver < -slack || sliver > sliverMax + slack) {
      out.reason = 'the pieces do not add up: the hull and the flange leave ' + sliver.toFixed(3) +
        ' mm^3 of the part unaccounted for, against at most ' + sliverMax.toFixed(3) + ' mm^3 between the ' +
        'flange\'s cut and the wall - the root plane takes something that is not the flange';
      return out;
    }

    out.ok = true;
    out.stage = 'done';
    out.hull = hull;
    out.piece = {
      soup: ex.positions,               // where it was, in the part's frame
      local: loc,                        // Assemble's frame: root on z = 0, reach +Z, plate normal +Y
      frame: { origin: origin, rows: L, along: E, up: A, out: N },
      rootArea: rootArea,
      thickness: flange.thickness,
      reachMm: hiZ(loc),
      volume: vPiece
    };
    out.ms = Date.now() - t0;
    out.reason = describe(out);
    return out;
  }

  function hiZ(s) { var h = -Infinity; for (var i = 2; i < s.length; i += 3) if (s[i] > h) h = s[i]; return h; }

  /* The piece back where it came from: frame.origin + rows^T * local. */
  function toWorld(piece, local) {
    var f = piece.frame, R = f.rows, o = f.origin;
    var out = turn(local || piece.local, R, true);
    for (var i = 0; i < out.length; i += 3) {
      out[i] = Math.fround(out[i] + o[0]); out[i + 1] = Math.fround(out[i + 1] + o[1]); out[i + 2] = Math.fround(out[i + 2] + o[2]);
    }
    return out;
  }

  /* -------------------------------------------------------------------------
     reattach(bodySoup, piece, opts, deps) -> NSO_Assemble.attach's result

     The detached piece, seated on bodySoup by Assemble's attach, unaltered:
     the measured seat (rim gap + one extrusion line), Extend putting the
     length back, place() baking the turn. Two options make it take a real
     piece rather than a generated arm, both attach's own:

       footAt   `at` is the root's point on the body. Auto-aim's foot (the
                body point nearest the TIP) is right for an arm grown along a
                face normal and wrong for a plate that cantilevers over
                something nearer its tip than its root.
       up       where the plate's normal should point. Default: the way it
                pointed before it was detached (frame.up).

     opts: at, dir (required); up, engageMm, marginMm, nozzle, obstacles.
     The union is the caller's, as for attach: NSO_unionSoups is async and
     lives in app-join.js.
     ---------------------------------------------------------------------- */
  function reattach(bodySoup, piece, opts, deps) {
    opts = opts || {};
    var AS = dep(deps, 'NSO_Assemble');
    if (!AS || typeof AS.attach !== 'function') {
      return { ok: false, stage: 'deps', reason: 'Reattach needs nso_assemble.js - its attach is the seat' };
    }
    if (!piece || !piece.local || !piece.frame) {
      return { ok: false, stage: 'deps', reason: 'nothing detached to put back - Detach a feature first' };
    }
    var o = {};
    for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key)) o[key] = opts[key];
    o.footAt = true;
    if (!o.up) o.up = piece.frame.up;
    if (!o.extendRaw) o.extendRaw = extendRoot;
    return AS.attach(bodySoup, piece.local, o);
  }

  /* Extend's contract - ext(soup, { axis: 'z', length }) -> { ok, tris,
     reason } - met at the ROOT, which is where attach's seat needs the
     length. attach sinks the piece by engageMm and grows it by the same
     amount first so the part left proud is the part that was there. It
     grows it with NSO_extendRaw, which stretches a band of constant cross
     section somewhere along the axis. A detached flange has none it will
     take: its top and bottom are long slivers from root to tip, and the
     clamp bar's flange ends follow the bar's rounded ends, so Extend refuses
     it (measured: "none clean; widest (3.7442 mm) failed because 12
     straddling triangle(s) are slivers"). Its ROOT, though, is a flat cap
     square to the reach, cut by rawCut. So the constant section is there by
     construction: the cap moves down by the growth, and each edge of its
     outline is walled straight down. That band is inside the body once the
     piece is seated. Then everything is lifted so the base is on z = 0 again,
     as Extend leaves it. */
  function extendRoot(soup, opts) {
    opts = opts || {};
    if ((opts.axis || 'z') !== 'z') return { ok: false, reason: 'the root grows along +Z only', tris: soup };
    var zlo = Infinity, zhi = -Infinity, i;
    for (i = 2; i < soup.length; i += 3) { if (soup[i] < zlo) zlo = soup[i]; if (soup[i] > zhi) zhi = soup[i]; }
    var add = +opts.length - (zhi - zlo);
    if (!(add > 0)) return { ok: false, reason: 'the root grows, it does not shrink', tris: soup };
    function key(o) { return soup[o] + ',' + soup[o + 1] + ',' + soup[o + 2]; }
    var capEdges = new Map(), rest = [], cap = [];
    for (var t = 0; t + 8 < soup.length; t += 9) {
      if (soup[t + 2] === zlo && soup[t + 5] === zlo && soup[t + 8] === zlo) {
        cap.push(t);
        for (var e = 0; e < 3; e++) {
          var a = t + e * 3, b = t + ((e + 1) % 3) * 3;
          capEdges.set(key(a) + '>' + key(b), [a, b]);
        }
      } else rest.push(t);
    }
    if (!cap.length) return { ok: false, reason: 'the piece has no flat root face on its low end', tris: soup };
    var out = [];
    function put(x, y, z) { out.push(x, y, Math.fround(z + add)); }
    rest.forEach(function (t0) { for (var k = 0; k < 9; k += 3) put(soup[t0 + k], soup[t0 + k + 1], soup[t0 + k + 2]); });
    cap.forEach(function (t0) { for (var k = 0; k < 9; k += 3) put(soup[t0 + k], soup[t0 + k + 1], zlo - add); });
    var walls = 0;
    capEdges.forEach(function (ab, kk) {
      var p = kk.split('>');
      if (capEdges.has(p[1] + '>' + p[0])) return;          // inside the cap
      var a = ab[0], b = ab[1];
      /* a->b is the cap's own edge; the wall above it holds b->a. The new
         wall holds a->b at the old root and b'->a' at the new one. */
      put(soup[a], soup[a + 1], zlo); put(soup[b], soup[b + 1], zlo); put(soup[b], soup[b + 1], zlo - add);
      put(soup[a], soup[a + 1], zlo); put(soup[b], soup[b + 1], zlo - add); put(soup[a], soup[a + 1], zlo - add);
      walls++;
    });
    var f32 = new Float32Array(out);
    return { ok: true, tris: f32, lengthBefore: zhi - zlo, lengthAfter: zhi - zlo + add,
      reason: 'grew the root by ' + add.toFixed(3) + ' mm: its flat cap moved down and ' + walls +
        ' outline edge(s) walled straight to it' };
  }

  /* After the caller's union: did the piece meet the body ONLY at its seat?
     The overlap the union took out is body + seated - union. The seat is at
     most engageMm of the root's own prism; anything past that is the piece
     running into the body somewhere else. It is refused, because Reattach
     puts a piece back and does not trim one. That is Crop stage 2's job. */
  function unionCheck(bodySoup, seatedSoup, unionSoup, attachResult, piece, deps) {
    var V = dep(deps, 'NSO_cropVolume');
    if (!V) return { ok: false, reason: 'unionCheck needs NSO_cropVolume (app-crop.js)' };
    var vb = V(bodySoup), vs = V(seatedSoup), vu = V(unionSoup);
    var overlap = vb + vs - vu;
    var seatMax = attachResult.engageMm * piece.rootArea;
    var slack = 1e-6 * Math.max(1, vb) + 1e-3;
    var r = { overlap: overlap, seatMax: seatMax, body: vb, seated: vs, union: vu };
    r.ok = overlap > -slack && overlap <= seatMax + slack;
    r.reason = r.ok
      ? 'the piece meets the body at its seat only (' + overlap.toFixed(3) + ' mm^3 of ' +
        seatMax.toFixed(3) + ' at most)'
      : (overlap <= -slack
        ? 'the union came out bigger than body + piece (' + overlap.toFixed(3) + ' mm^3)'
        : 'the piece runs into the body past its seat: ' + overlap.toFixed(3) + ' mm^3 overlap against ' +
          seatMax.toFixed(3) + ' mm^3 for the seat');
    return r;
  }

  /* The union's finish, Crop stage 2's own: weld at Cut's radius, then split
     what float32 made zero-area. Measured on the clamp bar: the raw union of
     the hull and the reattached flange comes out closed by the kernel's own
     count but 2 non-manifold / 5 inconsistent by the canonical checker,
     whose 1e-4 weld joins vertices the union left closer than that. Welded
     here at the same radius, it passes, self-intersection included. */
  function finishUnion(unionSoup, deps) {
    var D = need(deps, ['rawWeldSoup', 'rawSplitDegenerates', 'NSO_cropEdgeCensus']);
    if (D.missing.length) return { ok: false, reason: 'the finish needs ' + D.missing.join(', ') };
    var d = D.got;
    var soup = d.rawSplitDegenerates(new Float32Array(d.rawWeldSoup(unionSoup, TOL)));
    var census = d.NSO_cropEdgeCensus(soup);
    var ok = !census.open && !census.repeated && !census.degenerate;
    return { ok: ok, soup: soup, census: census,
      reason: ok ? 'closed, manifold, consistently wound' : 'the union is not closed after the weld (open ' +
        census.open + ', repeated ' + census.repeated + ', degenerate ' + census.degenerate + ')' };
  }

  function describe(r) {
    if (!r) return '';
    if (!r.ok) return 'Detach refused at the ' + r.stage + ' stage: ' + r.reason;
    var p = r.wall.pieces;
    return 'Detached a ' + r.piece.thickness.toFixed(2) + ' mm flange (' + r.volumes.piece.toFixed(1) +
      ' mm^3). The hull is capped on its own wall' +
      (p.length > 1 ? ', ' + p.length + ' pieces stepping at ' +
        r.wall.steps.map(function (s) { return s.toFixed(3); }).join(' / ') : '') +
      ', 0 um proud. ' + r.volumes.sliver.toFixed(2) + ' mm^3 lies between the two (the flange is cut 2 um ' +
      'clear of the outermost wall piece)';
  }

  var api = {
    detach: detach,
    reattach: reattach,
    unionCheck: unionCheck,
    finishUnion: finishUnion,
    extendRoot: extendRoot,
    toWorld: toWorld,
    describe: describe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Detach = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
