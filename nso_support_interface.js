/* ============================================================
   nso_support_interface.js - where a support MEETS the piece: an air gap and
   a breakaway interface, instead of a tip driven into the overhang.

   Loads as a classic script (window.NSO_SupportInterface) and as a Node
   module. No DOM, no THREE. Soups are the app's raw convention: 9 floats per
   triangle, Z up, millimetres. The booleans are the app's own
   (NSO_unionSoups / NSO_subtractSoups, app-join.js), passed in or found by
   name - nothing here reimplements them.

   ---------------------------------------------------------------------------
   WHAT WAS WRONG, MEASURED
   ---------------------------------------------------------------------------
   Every support this repo aimed so far ended ON the overhang: the aim lands
   its tip on the contact point, by design (nso_support_aim.js). On the tape
   piece every tip - the strut and all five of the region-1 tree - stops at
   plate z 18.042, which is inside 0.2 mm layer 91 (18.0 - 18.2), with no
   air between support and piece. Bambu Studio reported exactly that: the
   tree and the piece overlapping at layer 91. And none of those supports had
   an interface at all - bulk structure all the way up.

   ---------------------------------------------------------------------------
   WHAT THIS BUILDS, AT EVERY TIP
   ---------------------------------------------------------------------------
        piece  ---------------------------------   underside, z_u
               air gap: GAP_MM (0.18), the true minimum distance
        layer 2  |  |  |  |    lines one way           \  NSO_Crosshatch:
        layer 1  ---------     lines across layer 2    /  one direction per layer
        bulk     (the trunk or branch, CUT flat at the interface's underside)

   THE GAP is the repo's own easy-release figure: the Seat (support) slider's
   -0.18, "an air gap of that size" (nso_seat_surface.js, docs/SEAT-SURFACE.md;
   the convention locked in tools/breakaway_coupons.py). It is measured the
   way the seat solve measures it: as the TRUE MINIMUM DISTANCE between the
   two surfaces, not a vertical offset - and it is measured over the whole
   support, not only at the tips, because a flank that grazes the piece is the
   same conflict as a tip that touches it. At 0.2 mm layers a 0.18 mm gap is
   one empty slicer layer between interface and piece - what Bambu's own
   support_top_z_distance of 0.2 gives.

   THE INTERFACE is nso_crosshatch.js, unchanged: two layers, each ONE
   direction of 0.42 mm lines at a 1.2 mm pitch, the second across the first -
   the construction that module exists for, because a layer that runs both
   ways welds to the one above it instead of crossing it (its header carries
   the measurement). Layer height = the print's layer height, so each
   interface layer is exactly one slicer layer. The patch is sized to the tip
   it sits on: REPEATS lines each way, so every layer-1 line crosses the cut
   tip and is carried by it - a line that misses the tip would be printed in
   mid-air. It is centred where the support's own axis crosses the
   interface's underside, not on the contact point, so a leaning branch
   carries its patch squarely.

   THE BULK is cut flat at the interface's underside - a box removed above
   that plane over the patch's footprint - so the tip's own flat cap, which
   stands proud of a level cut on any leaning branch, cannot reach into the
   gap. On a bored tree the cut opens the bore upward; the interface lines
   bridge it, which is what a real tree support's interface does over its
   tube.

   JOINING. Layer 2 is lowered EPS_MM into layer 1 and layer 1 set EPS_MM into
   the cut, so each join is an overlap the kernel can merge rather than two
   faces meeting on a plane of zero thickness - the same reason
   nso_support_tree.js sinks a branch root into its trunk. 2 microns, far
   below anything printed.

   ---------------------------------------------------------------------------
   THE LADDER, per tip, when the patch comes too close to the piece
   ---------------------------------------------------------------------------
   A patch is tested on its own before it is joined: if any of it is nearer
   the piece than the gap (a wall beside the contact, a step in the
   underside), it drops to 1 repeat each way - a cross, still carried by the
   tip - and if that is too close too, the tip gets NO interface: its bulk is
   cut at the gap line instead and the tip is named in `stations`. The gap is
   never given up to fit an interface.

   API
   ---------------------------------------------------------------------------
   DEFAULTS
   finish(bulkSoup, stations, piece, opts) -> Promise {
       ok, soup, stations:[...], minDistanceMm, reason }
     stations: [{ label, contact:[x,y,z], from:[x,y,z], to:[x,y,z] }]
       contact  where the support was aimed, ON the underside
       from/to  the support's own axis near its tip (for the patch centre)
     opts: gapMm, layerMm, widthMm, pitchMm, repeats, unionSoups,
           subtractSoups, crosshatch, thickness
   minDistance(soupA, soupB, opts) -> { mm, at }  sampled true minimum distance
   ============================================================ */
(function (root) {
  'use strict';

  var GAP_MM = 0.18;          /* Seat (support) -0.18: the easy-release air gap */
  var LAYER_MM = 0.2;         /* one interface layer = one slicer layer */
  var PITCH_MM = 1.2;         /* nso_crosshatch.js's shipped pitch */
  var REPEATS = 2;            /* lines each way; 2 x 1.2 mm pitch crosses a 2 mm tip twice */
  var EPS_MM = 0.002;         /* the joining overlap - see JOINING */

  function mod(opts, key, name) {
    return (opts && opts[key]) || (root && root[name]) ||
           (typeof globalThis !== 'undefined' && globalThis[name]) || null;
  }

  /* ---------------------------------------------------------- distance */

  /* True minimum distance between two closed soups, sampled densely where it
     matters. Both are piecewise planar, so the minimum sits at a vertex of one
     against a face of the other, or edge against edge. So: every vertex of each
     against the other, then every edge and face of A that came within reach,
     resampled at `step`. The answer is an upper bound on the truth that closes
     on it as `step` shrinks; the step is reported. */
  function minDistance(TH, A, B, opts) {
    opts = opts || {};
    var step = opts.step || 0.05, reach = opts.reach || 1.0;
    var PB = TH.prepare(B, {}), PA = TH.prepare(A, {});
    var best = { mm: Infinity, at: null };
    function probe(P, p) {
      var nr = P.nearest(p, best.mm < Infinity ? Math.min(best.mm, reach) + 1e-9 : reach);
      if (nr && nr.dist < best.mm) best = { mm: nr.dist, at: p.slice() };
      return nr ? nr.dist : Infinity;
    }
    var near = [];
    for (var f = 0; f < PA.tris.length; f++) {
      var T = PA.tris[f], d = Infinity;
      for (var k = 0; k < 3; k++) d = Math.min(d, probe(PB, T[k]));
      var c = [(T[0][0] + T[1][0] + T[2][0]) / 3, (T[0][1] + T[1][1] + T[2][1]) / 3, (T[0][2] + T[1][2] + T[2][2]) / 3];
      d = Math.min(d, probe(PB, c));
      if (d < reach) near.push(f);
    }
    /* B's vertices against A: the vertex-of-B-on-face-of-A case. Only B's
       vertices inside A's box grown by `reach` can matter. */
    var lo = PA.lo, hi = PA.hi;
    for (var g = 0; g < PB.tris.length; g++) {
      for (var j = 0; j < 3; j++) {
        var v = PB.tris[g][j];
        if (v[0] < lo[0] - reach || v[0] > hi[0] + reach || v[1] < lo[1] - reach || v[1] > hi[1] + reach ||
            v[2] < lo[2] - reach || v[2] > hi[2] + reach) continue;
        probe(PA, v);
      }
    }
    /* THE FACES OF A THAT CAME CLOSE, subdivided with a bound rather than
       gridded: a triangle whose centroid is d from B and whose points are all
       within R of that centroid cannot come nearer than d - R, so it is split
       only while d - R could still beat the best found, down to `step`. A
       support's side faces run the length of a trunk; a flat grid at `step`
       over one of those is tens of thousands of probes for the same answer. */
    function refine(P0, P1, P2, depth) {
      var c = [(P0[0] + P1[0] + P2[0]) / 3, (P0[1] + P1[1] + P2[1]) / 3, (P0[2] + P1[2] + P2[2]) / 3];
      var R = Math.max(dist(c, P0), dist(c, P1), dist(c, P2));
      var d = probe(PB, c);
      var bound = Math.min(best.mm, reach);
      if (d - R > bound || R < step / 2 || depth > 24) return;
      var m01 = mid(P0, P1), m12 = mid(P1, P2), m20 = mid(P2, P0);
      refine(P0, m01, m20, depth + 1); refine(m01, P1, m12, depth + 1);
      refine(m20, m12, P2, depth + 1); refine(m01, m12, m20, depth + 1);
    }
    for (var n = 0; n < near.length; n++) {
      var U = PA.tris[near[n]];
      refine(U[0], U[1], U[2], 0);
    }
    best.step = step;
    return best;
  }
  function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
  function mid(p, q) { return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]; }

  /* ----------------------------------------------------------- geometry */

  function box(lo, hi) {
    var v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    var f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    var out = new Float32Array(f.length * 9), w = 0;
    for (var i = 0; i < f.length; i++) for (var k = 0; k < 3; k++) {
      var p = v[f[i][k]]; out[w++] = p[0]; out[w++] = p[1]; out[w++] = p[2];
    }
    return out;
  }

  /* Where the support's axis crosses the plane z. */
  function axisAt(from, to, z) {
    var dz = to[2] - from[2];
    if (Math.abs(dz) < 1e-12) return [to[0], to[1]];
    var t = (z - from[2]) / dz;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  }

  /* One two-layer crosshatch patch, centred on (cx, cy), underside at zBase. */
  function patch(CH, cx, cy, zBase, o, repeats) {
    var span = CH.spanFor(repeats, o.pitch, o.width);
    var b = CH.build({ W: span, D: span, pitch: o.pitch, width: o.width, height: o.layer,
                       angle: o.angle, ends: 'turn', baseZ: zBase, fit: 'nearest' });
    if (!b.ok) return { ok: false, reason: b.reason };
    var l1 = b.layers[0].tris, l2 = b.layers[1].tris;
    var dx = cx - b.spanU / 2, dy = cy - b.spanV / 2;
    var out = new Float32Array(l1.length + l2.length);
    for (var i = 0; i < l1.length; i += 3) { out[i] = l1[i] + dx; out[i + 1] = l1[i + 1] + dy; out[i + 2] = l1[i + 2]; }
    for (var j = 0; j < l2.length; j += 3) {
      var w = l1.length + j;
      out[w] = l2[j] + dx; out[w + 1] = l2[j + 1] + dy; out[w + 2] = l2[j + 2] - o.eps;   /* into layer 1 */
    }
    return {
      ok: true, soup: out, layer1: l1.length / 9, layerSoups: [out.subarray(0, l1.length), out.subarray(l1.length)],
      span: b.spanU, repeats: repeats,
      census: [b.layers[0].census, b.layers[1].census],
      lineDirections: [b.layers[0].lineDirection, b.layers[1].lineDirection],
      crossings: b.crossings, contactPerCrossing: b.contactPerCrossing
    };
  }

  function finish(bulk, stations, piece, opts) {
    opts = opts || {};
    var TH = mod(opts, 'thickness', 'NSO_Thickness');
    var CH = mod(opts, 'crosshatch', 'NSO_Crosshatch');
    var U = mod(opts, 'unionSoups', 'NSO_unionSoups');
    var S = mod(opts, 'subtractSoups', 'NSO_subtractSoups');
    if (!TH || !CH || typeof U !== 'function' || typeof S !== 'function') {
      return Promise.resolve({ ok: false, reason: 'needs nso_thickness.js, nso_crosshatch.js and app-join.js ' +
        '(NSO_unionSoups, NSO_subtractSoups) - none of them is reimplemented here' });
    }
    var o = {
      gap: opts.gapMm == null ? GAP_MM : +opts.gapMm,
      layer: opts.layerMm == null ? LAYER_MM : +opts.layerMm,
      width: opts.widthMm == null ? TH.floorFor(opts.nozzle) : +opts.widthMm,
      pitch: opts.pitchMm == null ? PITCH_MM : +opts.pitchMm,
      repeats: opts.repeats == null ? REPEATS : (opts.repeats | 0),
      angle: opts.angle == null ? 0 : +opts.angle,
      eps: EPS_MM
    };
    if (!(o.gap > 0)) return Promise.resolve({ ok: false, reason: 'the gap must be a positive air gap, got ' + o.gap });

    /* ---- plan every station, and test each patch against the piece ---- */
    var PP = TH.prepare(piece, {});
    var plans = stations.map(function (st) {
      /* THE UNDERSIDE over the whole patch, not only at the contact: the
         lowest point of the piece straight above the footprint, by vertical
         rays - so an underside that slopes a little over the patch sets the
         height, not the one point the aim landed on. Only within ONE LAYER of
         the contact: anything lower is a lip or a wall beside the tip, and
         dropping the whole stack under it would leave the contact itself
         unsupported, the gap there grown to whatever the lip's depth is. That
         is the ladder's job, below. */
      var zu = st.contact[2], half0 = CH.spanFor(o.repeats, o.pitch, o.width) / 2 + 0.2;
      for (var gx = -half0; gx <= half0 + 1e-9; gx += half0 / 4) {
        for (var gy = -half0; gy <= half0 + 1e-9; gy += half0 / 4) {
          var hs = PP.hitsAlong([st.contact[0] + gx, st.contact[1] + gy, st.contact[2] - 1], [0, 0, 1], 2);
          if (hs.length) { var zz = st.contact[2] - 1 + hs[0]; if (zz < zu && zz > st.contact[2] - o.layer) zu = zz; }
        }
      }
      var zTop = zu - o.gap, zBase = zTop - 2 * o.layer;
      var c = axisAt(st.from, st.to, zBase);
      var rec = { label: st.label, contact: st.contact.slice(), zUnderside: zu, zTop: zTop, zBase: zBase,
                  centre: c, repeats: 0, interface: false, tried: [] };
      for (var r = o.repeats; r >= 1; r--) {
        var pt = patch(CH, c[0], c[1], zBase, o, r);
        if (!pt.ok) { rec.tried.push({ repeats: r, why: pt.reason }); continue; }
        var d = minDistance(TH, pt.soup, piece, { reach: o.gap * 4 });
        /* THE GAP IS SOLVED, not set: an underside that is not quite level
           over the patch brings its top nearer than the vertical offset, so
           the stack is lowered by the shortfall until the TRUE distance is
           the gap - the seat solve's rule. Only a shortfall straight above
           is solved this way; a wall beside the patch is the ladder's job. */
        for (var sv = 0; sv < 4 && d.mm < o.gap - 1e-5 && d.mm > o.gap * 0.5 && d.at[2] >= zTop - 2 * o.eps - 1e-3; sv++) {
          var drop = o.gap - d.mm + 1e-4;
          zTop -= drop; zBase -= drop; rec.zTop = zTop; rec.zBase = zBase; rec.solvedDropMm = (rec.solvedDropMm || 0) + drop;
          c = axisAt(st.from, st.to, zBase); rec.centre = c;
          pt = patch(CH, c[0], c[1], zBase, o, r);
          d = minDistance(TH, pt.soup, piece, { reach: o.gap * 4 });
        }
        if (d.mm >= o.gap - 1e-5) {
          rec.interface = true; rec.repeats = r; rec.span = pt.span; rec.patch = pt; rec.patchDistanceMm = d.mm;
          break;
        }
        rec.tried.push({ repeats: r, why: 'a ' + pt.span.toFixed(3) + ' mm patch comes ' + d.mm.toFixed(4) +
          ' mm from the piece at [' + d.at.map(function (v) { return v.toFixed(3); }).join(', ') + '], under the ' +
          o.gap + ' mm gap' });
      }
      /* The cut: at the interface's underside where there is one, at the gap
         line where there is not. Over the patch's footprint plus the tip's own
         lean - see THE BULK. */
      /* Sized to the FULL patch whatever patch was chosen: the box has to take
         the whole tip off, and a 1x1 patch's footprint (0.81 mm half-width) is
         narrower than a 2 mm tip - measured, a ring of the tip left standing
         0.05 mm off a lip beside it. */
      var half = CH.spanFor(o.repeats, o.pitch, o.width) / 2 + 0.2;
      rec.cutZ = rec.interface ? zBase + o.eps : zTop;
      rec.cutBox = box([c[0] - half, c[1] - half, rec.cutZ], [c[0] + half, c[1] + half, zu + 50]);
      return rec;
    });

    /* ---- cut, then join, then measure ---- */
    var acc = bulk;
    var chain = Promise.resolve();
    plans.forEach(function (rec) {
      chain = chain.then(function () {
        return S(acc, rec.cutBox).then(function (d) {
          rec.cutOk = !!(d && d.ok); rec.cutRemovedMm3 = d && d.removedMm3;
          if (d && d.ok) acc = d.soup;
          else rec.cutWhy = (d && d.reason) || 'no reason';
        });
      });
    });
    plans.forEach(function (rec) {
      if (!rec.interface) return;
      chain = chain.then(function () {
        /* The two layers are joined to EACH OTHER first. Handed over as one
           soup of two overlapping shells, the kernel takes the overlap as
           given - measured: 48 piercing pairs on one 2x2 patch - so the
           patch is made one solid before it meets the bulk. */
        return U(rec.patch.layerSoups[0], rec.patch.layerSoups[1]).then(function (pu) {
          if (!pu || !pu.ok) { rec.joined = false; rec.joinWhy = 'the two layers would not join: ' + ((pu && pu.reason) || ''); return null; }
          return U(acc, pu.soup);
        }).then(function (u) {
          if (u === null) return;
          rec.joined = !!(u && u.ok);
          if (u && u.ok) acc = u.soup;
          else rec.joinWhy = (u && u.reason) || 'no reason';
        });
      });
    });
    return chain.then(function () {
      var bad = plans.filter(function (r) { return !r.cutOk || (r.interface && !r.joined); });
      var d = minDistance(TH, acc, piece, { reach: o.gap * 4 });
      var ok = !bad.length;
      var withIf = plans.filter(function (r) { return r.interface; }).length;
      var ok = ok && d.mm >= o.gap - 1e-5;
      return {
        ok: ok, soup: acc, stations: plans, minDistanceMm: d.mm, minDistanceAt: d.at, sampleStepMm: d.step,
        gapMm: o.gap, layerMm: o.layer, widthMm: o.width, pitchMm: o.pitch,
        reason: (ok ? '' : 'NOT OK - ') + withIf + ' of ' + plans.length + ' tip(s) carry a two-layer crosshatch interface' +
          (withIf < plans.length ? ' (' + plans.filter(function (r) { return !r.interface; })
            .map(function (r) { return r.label; }).join(', ') + ' cut at the gap instead)' : '') +
          '; closest approach to the piece ' + d.mm.toFixed(4) + ' mm (gap ' + o.gap + ')' +
          (bad.length ? '; failed: ' + bad.map(function (r) { return r.label + ' ' + (r.cutWhy || r.joinWhy); }).join('; ') : '')
      };
    });
  }

  var api = {
    DEFAULTS: { gapMm: GAP_MM, layerMm: LAYER_MM, pitchMm: PITCH_MM, repeats: REPEATS, epsMm: EPS_MM },
    finish: finish,
    minDistance: function (A, B, opts) { return minDistance(mod(opts, 'thickness', 'NSO_Thickness'), A, B, opts); },
    _patch: function (cx, cy, zBase, o, repeats) { return patch(mod(o, 'crosshatch', 'NSO_Crosshatch'), cx, cy, zBase, o, repeats); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportInterface = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
