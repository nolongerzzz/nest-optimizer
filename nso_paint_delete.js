/* NSO_PaintDelete - remove the geometry under the paint.
 *
 * Standalone, no DOM, no Three.js: the same file runs in the page and under
 * node, exactly like NSO_Repair.js. The app half lives in app-paint-delete.js.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * mask6 already has two paint lists (app-mask.js):
 *
 *   faceMask.exclude  the YELLOW - "no bake may touch this face"
 *   faceMask.select   the PINK   - "this face is my target", at most one
 *
 * This module is a consumer of the SECOND list. It deletes the triangles under
 * the pink. It never deletes anything under the yellow - a target that is also
 * painted excluded stands the delete down, the same way Skin face stands down
 * (app-skin.js). So the standing rule in docs/HANDOFF.md - "a painted /
 * excluded face stays untouched by ANY bake mechanism" - holds here word for
 * word: the exclude list is still a veto, and deletion is not an exception to
 * it. What changed is only that the SELECT list now has a second consumer.
 *
 * PAINT SCOPE: SUB-REGION. The operand is one identifiable face (or the one
 * shell that face belongs to), so the exclude test is scoped to THAT face,
 * through nsoMaskIsExcludedRaw with the raw plane the pick recorded. Paint
 * anywhere else on the piece does not block it, because every other face is
 * left exactly as it was, plane included. Same rule as Smooth's whole-piece
 * stand-down at a different scope, not a laxer reading - see docs/HANDOFF.md
 * "Scoping" and docs/PAINT-DELETE.md.
 *
 * ---------------------------------------------------------------------------
 * WHICH TRIANGLES GO
 * ---------------------------------------------------------------------------
 * Exactly the ones the pink covers. That is not a restatement of intent, it is
 * the implementation: the predicate below is app-mask.js buildOverlay's
 * predicate transcribed from display space into raw space, clause for clause -
 * an outer face is "this raw axis and side, all three corners on the piece's
 * own current extreme", a pocket wall is "this raw axis and side, all three
 * corners on its own stored plane", and a patch with no axis to name falls
 * back to the stored raw plane through its first corner. A destructive
 * operation that removed a triangle the user could not see highlighted would
 * be a different operation from the one they pressed the button for, so the
 * drive check asserts removedTris === the pink count on real fixtures rather
 * than trusting this comment.
 *
 * Two modes, both named by the caller, neither inferred from the geometry:
 *
 *   'face'   the painted face's own triangles, and nothing else. This opens
 *            the mesh along the rim of what it removed. That is the intent,
 *            not a failure - see the gate.
 *   'shell'  every triangle of the edge-connected component that face belongs
 *            to. Deleting a loose blob, an internal shell, a second body a
 *            boolean left behind. Watertightness cannot legitimately change
 *            here, so the gate holds it fixed.
 *
 * ---------------------------------------------------------------------------
 * THE GATE
 * ---------------------------------------------------------------------------
 * Same shape as NSO_Repair's: measure, act on a trial copy, measure again,
 * and hand the caller's own array straight back if any clause fails, so
 * "unchanged" is checkable by identity and not just by value.
 *
 * The clauses, and what actually trips each one (every case named here is a
 * shipped fixture, asserted in tools/nso_paint_delete_test.js):
 *
 *   nothing        the paint resolved to no triangles - a stale plane after a
 *                  bake, or a target on a piece that has since been rebuilt.
 *   empty          the delete would leave no triangles at all. 39644 in
 *                  'shell' mode: the whole file is one edge-connected
 *                  component, so "delete this shell" is "delete the piece".
 *   arithmetic     this module's own prediction of the cut's odd-edge count
 *                  disagrees with NSO_Repair's independent measurement of the
 *                  mesh actually produced. Two code paths, one answer; when
 *                  they differ the mesh is not understood and nothing is
 *                  committed. This clause is about this module being right,
 *                  not about the geometry being acceptable.
 *   shatter        'face' mode split the piece into more bodies than it
 *                  started with - 39644's inner Z+ face at 6, or box_open's
 *                  top, which is the only thing holding the pocket liner to
 *                  the outer shell. Two loose bodies on the plate is not what
 *                  "delete this face" asked for; the caller wanted 'shell'.
 *   selfInt        the result crosses itself more than the input did.
 *                  Deleting triangles alone cannot do this - two survivors
 *                  that did not cross before still do not. Sealing can, and
 *                  does: fanning out-box-round-r05's 5-edge rim shut puts one
 *                  piercing pair in. NSO_Repair's own gate normally catches
 *                  that first and declines the fill; this clause is the
 *                  backstop, and the suite proves it fires by handing the
 *                  seal `sealOptions: { gate: false }` and watching this one
 *                  refuse anyway.
 *   nonManifold    an edge used by three or more faces where there was not
 *                  one before. Same shape of backstop.
 *   shellOpened    a 'shell' delete left more odd edges behind than it found.
 *                  Whole bodies share no edge with the bodies that stay -
 *                  that is what made them separate components - so a rise
 *                  means the selection was not the shell it was taken for.
 *                  This, and not "the result must be closed", is what a shell
 *                  delete owes: a piece that was already open stays as open
 *                  as it was and no more.
 *   watertight     the result is open and the caller said it must not be. On
 *                  by default whenever a seal was asked for, because a seal
 *                  IS that request. Off by default otherwise, in both modes -
 *                  in 'face' because opening the rim is the operation, in
 *                  'shell' because a deliberately open piece
 *                  (docs/NON-SOLID.md) is where "get that loose sheet off"
 *                  comes up most.
 *
 * "Breaks watertightness in an unintended way" is the last three between
 * them: the rim a face delete opens is intended, counted before the cut and
 * checked against the cut afterwards. A shell delete opening anything is not.
 * A seal that leaves the piece neither cut nor closed is not. And a rim the
 * shipped repair can only close by crossing the piece is not - there the
 * whole delete is handed back, the caller's own array, untouched.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var VERSION = 'NSO_PaintDelete/1.0.0';

  /* Must match app-mask.js. The overlay and the delete have to agree on what
   * "the same face" means or the pink and the cut diverge; tools/
   * nso_paint_delete_test.js asserts both files still carry these numbers. */
  var N_TOL = 0.02;   // normals this close count as the same face
  var D_TOL = 0.05;   // mm, plane offsets this close count as the same face

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function triCount(rawTris) { return Math.floor(rawTris.length / 9); }

  // Unit normal of raw triangle t, or null when it has no area.
  function triNormal(r, t) {
    var o = t * 9;
    var ux = r[o + 3] - r[o], uy = r[o + 4] - r[o + 1], uz = r[o + 5] - r[o + 2];
    var vx = r[o + 6] - r[o], vy = r[o + 7] - r[o + 1], vz = r[o + 8] - r[o + 2];
    var x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    var L = Math.sqrt(x * x + y * y + z * z);
    return L > 1e-12 ? [x / L, y / L, z / L] : null;
  }

  // The piece's own extreme on a raw axis, the value rawExtremeOf gives the
  // face pick. Read off the CURRENT soup, never cached: an outer face that a
  // bake moved is still the outer face, and the overlay tracks it the same way
  // by reading the display bounding box every repaint.
  function rawExtreme(r, axisIdx, keepMin) {
    var best = keepMin ? Infinity : -Infinity;
    for (var i = axisIdx; i < r.length; i += 3) {
      if (keepMin ? (r[i] < best) : (r[i] > best)) best = r[i];
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * The selector - app-mask.js buildOverlay, in raw space
   * ------------------------------------------------------------------ */

  /* One painted entry -> the test a triangle has to pass. Returns null for an
   * entry this soup has no face for. `axisAt` is where the face sits along its
   * raw axis; for an outer face that is measured now, for a pocket wall it is
   * the plane the click recorded. */
  function faceTest(r, e) {
    if (e == null) return null;
    if (e.axisIdx == null) {
      // No axis to name - a fillet, a curved end, a recessed patch. The
      // overlay matches these on the stored raw plane through the triangle's
      // FIRST corner only, so this does too: the set that disappears is the
      // set that was pink, and a half-painted face is not a thing the user
      // can see to consent to.
      if (!e.n || e.n.length !== 3 || !isFinite(e.d)) return null;
      return { kind: 'plane', n: [e.n[0], e.n[1], e.n[2]], d: e.d };
    }
    var a = e.axisIdx | 0;
    if (a < 0 || a > 2) return null;
    var keepMin = !!e.keepMin;
    var at = e.inner ? (keepMin ? -e.d : e.d) : rawExtreme(r, a, keepMin);
    if (!isFinite(at)) return null;
    return { kind: 'axis', axisIdx: a, keepMin: keepMin, at: at, inner: !!e.inner };
  }

  function matchesAxis(r, t, n, f) {
    // dominant component on this axis, pointing the way the click named
    if (Math.abs(n[f.axisIdx]) < 0.999) return false;
    if ((n[f.axisIdx] >= 0 ? 1 : -1) !== (f.keepMin ? -1 : 1)) return false;
    var o = t * 9;
    // all three corners on the face's own plane, exactly as onPlane() asks
    return Math.abs(r[o + f.axisIdx] - f.at) < D_TOL &&
           Math.abs(r[o + 3 + f.axisIdx] - f.at) < D_TOL &&
           Math.abs(r[o + 6 + f.axisIdx] - f.at) < D_TOL;
  }

  function matchesPlane(r, t, n, f) {
    if (Math.abs(n[0] - f.n[0]) >= N_TOL) return false;
    if (Math.abs(n[1] - f.n[1]) >= N_TOL) return false;
    if (Math.abs(n[2] - f.n[2]) >= N_TOL) return false;
    var o = t * 9;
    var d = n[0] * r[o] + n[1] * r[o + 1] + n[2] * r[o + 2];
    return Math.abs(d - f.d) < D_TOL;
  }

  /* Which triangles the paint covers. `entries` is what nsoMaskSnapshot hands
   * back for a list - the select list for a delete, but the shape is the same
   * for either list and the tests exercise both. */
  function select(rawTris, entries) {
    var n = triCount(rawTris);
    var hit = new Uint8Array(n);
    var perFace = [];
    var total = 0;
    var tests = [];
    var i;
    for (i = 0; i < (entries ? entries.length : 0); i++) {
      var f = faceTest(rawTris, entries[i]);
      perFace.push({
        axisIdx: entries[i] && entries[i].axisIdx != null ? entries[i].axisIdx : null,
        keepMin: entries[i] ? !!entries[i].keepMin : false,
        inner: entries[i] ? !!entries[i].inner : false,
        d: entries[i] ? entries[i].d : null,
        resolved: !!f,
        tris: 0
      });
      if (f) tests.push({ f: f, at: perFace.length - 1 });
    }
    for (var t = 0; t < n; t++) {
      var nrm = triNormal(rawTris, t);
      // A zero-area triangle has no normal, so no face can claim it and none
      // is ever deleted by paint. It stays, and the degenerate count the gate
      // reads is unmoved by that - Repair is what removes those.
      if (!nrm) continue;
      for (i = 0; i < tests.length; i++) {
        var test = tests[i].f;
        var ok = test.kind === 'axis' ? matchesAxis(rawTris, t, nrm, test)
                                      : matchesPlane(rawTris, t, nrm, test);
        if (!ok) continue;
        if (!hit[t]) { hit[t] = 1; total++; }
        perFace[tests[i].at].tris++;
        break;
      }
    }
    return { hit: hit, count: total, perFace: perFace };
  }

  /* ------------------------------------------------------------------ *
   * Edge connectivity, for 'shell' mode and for the odd-edge prediction
   * ------------------------------------------------------------------ */

  /* Triangle -> triangle across a SHARED EDGE, never across a shared corner.
   * That distinction is the whole of shell mode: two shells meeting at a
   * bowtie vertex share no edge and are two components, which is the same
   * answer NSO_Repair.analyze gives, so "delete this shell" and the component
   * count in the report cannot disagree. Vertex identity comes from
   * NSO_Repair._weldToIndexed, which preserves triangle order (face slot
   * t*3+v), so a welded face index IS a raw triangle index. */
  function edgeMap(welded, nTri) {
    var faces = welded.mesh.faces;
    var map = Object.create(null);
    for (var t = 0; t < nTri; t++) {
      for (var v = 0; v < 3; v++) {
        var a = faces[t * 3 + v], b = faces[t * 3 + (v + 1) % 3];
        if (a === b) continue;   // a collapsed edge connects nothing
        var k = a < b ? (a + '_' + b) : (b + '_' + a);
        if (!map[k]) map[k] = [];
        map[k].push(t);
      }
    }
    return map;
  }

  // Component id per triangle, by edge connectivity.
  function componentsOf(edges, nTri) {
    var comp = new Int32Array(nTri);
    for (var i = 0; i < nTri; i++) comp[i] = -1;
    var adj = Object.create(null);
    var k;
    for (k in edges) {
      var list = edges[k];
      for (var a = 0; a < list.length; a++) {
        if (!adj[list[a]]) adj[list[a]] = [];
        for (var b = 0; b < list.length; b++) if (b !== a) adj[list[a]].push(list[b]);
      }
    }
    var next = 0;
    for (var s = 0; s < nTri; s++) {
      if (comp[s] >= 0) continue;
      var id = next++;
      var stack = [s];
      while (stack.length) {
        var t = stack.pop();
        if (comp[t] >= 0) continue;
        comp[t] = id;
        var nb = adj[t];
        if (!nb) continue;
        for (var j = 0; j < nb.length; j++) if (comp[nb[j]] < 0) stack.push(nb[j]);
      }
    }
    return { comp: comp, count: next };
  }

  /* How many odd edges the survivors will have, counted from the edge map
   * before anything is removed. Independent of NSO_Repair.analyze, which is
   * the point: the gate compares the two. */
  function predictOdd(edges, keep) {
    var odd = 0;
    for (var k in edges) {
      var list = edges[k], c = 0;
      for (var i = 0; i < list.length; i++) if (keep[list[i]]) c++;
      if (c !== 0 && c !== 2) odd++;
    }
    return odd;
  }

  function compact(rawTris, keep, kept) {
    var out = new Float32Array(kept * 9);
    var w = 0;
    for (var t = 0; t < keep.length; t++) {
      if (!keep[t]) continue;
      for (var k = 0; k < 9; k++) out[w * 9 + k] = rawTris[t * 9 + k];
      w++;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * commit
   * ------------------------------------------------------------------ */

  function commit(rawTris, entries, options) {
    var opts = options || {};
    var mode = opts.mode === 'shell' ? 'shell' : 'face';
    var Repair = opts.repair || global.NSO_Repair;
    var gateOn = opts.gate !== false;
    /* Sealing is a request for a closed solid, so it carries the closed-solid
     * demand with it. A seal that declines, or one that fans a rim shut and
     * leaves the piece open anyway, then reverts the whole delete rather than
     * handing back a piece that is neither cut nor closed.
     *
     * Shell mode does NOT default to this, and the difference matters. What a
     * shell delete owes is that it opened nothing - which is the clause below,
     * measured against the input. Demanding a closed RESULT instead would
     * refuse every shell delete on a piece that was already open, and a piece
     * that is deliberately open (docs/NON-SOLID.md) is exactly where "get that
     * loose sheet off" comes up most. */
    var requireWatertight = opts.requireWatertight != null
      ? !!opts.requireWatertight
      : !!opts.seal;

    var report = {
      version: VERSION,
      mode: mode,
      applied: false,
      declined: false,
      reason: null,
      faces: entries ? entries.length : 0,
      removedTris: 0,
      removedFaces: [],
      componentsRemoved: 0,
      gate: {
        blocked: [],
        requireWatertight: requireWatertight,
        selfIntBefore: 0, selfIntAfter: 0,
        oddBefore: 0, oddAfter: 0, oddPredicted: 0,
        nmBefore: 0, nmAfter: 0,
        compBefore: 0, compAfter: 0
      },
      before: null,
      cut: null,      // the mesh the delete alone produced, sealed or not
      seal: null,     // NSO_Repair's own verdict when opts.seal asked for one
      after: null,
      rejected: null,
      triDelta: 0,
      volumeDelta: 0,
      volumeDeltaRel: 0
    };

    try {
      if (!Repair || typeof Repair.inspect !== 'function' ||
          typeof Repair._weldToIndexed !== 'function') {
        report.reason = 'NSO_Repair is not loaded - no metrics, so no gate, so no delete';
        report.declined = true;
        return { rawTris: rawTris, report: report, ok: false };
      }
      if (!rawTris || typeof rawTris.length !== 'number') {
        report.reason = 'no geometry';
        report.declined = true;
        return { rawTris: rawTris, report: report, ok: false };
      }
      if (rawTris.length < 9 || rawTris.length % 9 !== 0) {
        report.reason = 'raw soup is not a whole number of triangles (' + rawTris.length + ' floats)';
        report.declined = true;
        return { rawTris: rawTris, report: report, ok: false };
      }
      for (var q = 0; q < rawTris.length; q++) {
        if (!isFinite(rawTris[q])) {
          report.reason = 'non-finite coordinate at float ' + q;
          report.declined = true;
          return { rawTris: rawTris, report: report, ok: false };
        }
      }
      if (!entries || !entries.length) {
        report.reason = 'nothing painted - paint a target face first';
        report.declined = true;
        return { rawTris: rawTris, report: report, ok: true };
      }

      var nTri = triCount(rawTris);
      var weldTol = opts.weldTol != null ? opts.weldTol : Repair.WELD_TOL;

      report.before = Repair.inspect(rawTris, { weldTol: weldTol });
      report.gate.selfIntBefore = report.before.selfIntersections;
      report.gate.oddBefore = report.before.oddEdges;
      report.gate.nmBefore = report.before.nonManifoldEdges;
      report.gate.compBefore = report.before.components;

      var sel = select(rawTris, entries);
      report.removedFaces = sel.perFace;

      var welded = Repair._weldToIndexed(rawTris, weldTol);
      var edges = edgeMap(welded, nTri);
      var comps = componentsOf(edges, nTri);

      // 'shell' grows the selection to whole components; 'face' leaves it be.
      var drop = sel.hit;
      if (mode === 'shell') {
        var doomed = Object.create(null);
        for (var t0 = 0; t0 < nTri; t0++) if (sel.hit[t0]) doomed[comps.comp[t0]] = true;
        var nDoomed = 0;
        for (var c0 in doomed) { nDoomed++; }
        report.componentsRemoved = nDoomed;
        drop = new Uint8Array(nTri);
        for (var t1 = 0; t1 < nTri; t1++) if (doomed[comps.comp[t1]]) drop[t1] = 1;
      }

      var keep = new Uint8Array(nTri);
      var kept = 0, removed = 0;
      for (var t2 = 0; t2 < nTri; t2++) {
        if (drop[t2]) removed++;
        else { keep[t2] = 1; kept++; }
      }
      report.removedTris = removed;

      function settle(applied, finalMetrics) {
        if (applied) {
          report.after = finalMetrics;
          report.triDelta = finalMetrics.tris - report.before.tris;
          report.volumeDelta = finalMetrics.volume - report.before.volume;
        } else {
          report.after = report.before;
          report.rejected = finalMetrics || null;
          report.triDelta = 0;
          report.volumeDelta = 0;
        }
        report.volumeDeltaRel = report.before.volume !== 0
          ? report.volumeDelta / Math.abs(report.before.volume) : 0;
      }

      if (removed === 0) {
        report.declined = true;
        report.reason = 'the paint covers no geometry on this piece - ' +
                        'the plane it named is not a face here any more';
        report.gate.blocked.push('nothing');
        settle(false, null);
        return { rawTris: rawTris, report: report, ok: true };
      }
      if (kept === 0) {
        report.declined = true;
        report.reason = 'delete would remove every triangle - piece unchanged';
        report.gate.blocked.push('empty');
        settle(false, null);
        return { rawTris: rawTris, report: report, ok: true };
      }

      report.gate.oddPredicted = predictOdd(edges, keep);

      var out = compact(rawTris, keep, kept);
      var cutMetrics = Repair.inspect(out, { weldTol: weldTol });
      report.cut = cutMetrics;

      /* The arithmetic cross-check belongs HERE, on the mesh the delete
       * itself produced, before any seal has moved an edge. It is the one
       * clause that is about this module being right rather than about the
       * geometry being acceptable. */
      if (gateOn && cutMetrics.oddEdges !== report.gate.oddPredicted) {
        report.declined = true;
        report.gate.blocked.push('arithmetic');
        report.reason = 'gate: arithmetic: predicted ' + report.gate.oddPredicted +
                        ' odd edges, the cut measures ' + cutMetrics.oddEdges;
        settle(false, cutMetrics);
        return { rawTris: rawTris, report: report, ok: true };
      }

      /* Optional seal. The rim a face delete opens is closed by the SHIPPED
       * repair - NSO_Repair.commit, the same pass the Seal card's Repair
       * checkbox runs - and not by a hole filler of this module's own. That
       * is deliberate twice over. It is the code that is already regression
       * gated, and its own rule about seams ("hole fill will not close a seam
       * the repair opened", docs/NSO_Repair.md) is exactly right here: the rim
       * IS in its input, so it is a hole it may fill, and anything this delete
       * did not open it still will not bridge.
       *
       * It is also the only path on which the self-intersection clause below
       * can fire on real geometry. Deleting triangles cannot make two
       * survivors cross; fanning a non-planar rim shut absolutely can. */
      var finalMetrics = cutMetrics;
      var outSealed = out;
      if (opts.seal) {
        /* The seal's own options are the caller's - `sealOptions` goes
         * straight to NSO_Repair.commit. Turning ITS gate off does not turn
         * this one off: the clauses below still measure the sealed mesh
         * against the piece we started from, which is how the suite proves
         * the self-intersection clause here is a real backstop and not
         * decoration riding on NSO_Repair's gate. */
        var sealOpts = { weldTol: weldTol };
        if (opts.sealOptions) {
          for (var so in opts.sealOptions) sealOpts[so] = opts.sealOptions[so];
        }
        var rep = Repair.commit(out, sealOpts);
        report.seal = {
          ok: rep.ok,
          applied: rep.report.applied,
          declined: rep.report.declined,
          reason: rep.report.reason,
          holesFilled: rep.report.counts ? rep.report.counts.holesFilled : 0,
          holeTrisAdded: rep.report.counts ? rep.report.counts.holeTrisAdded : 0
        };
        outSealed = rep.rawTris;
        finalMetrics = rep.report.applied
          ? Repair.inspect(outSealed, { weldTol: weldTol })
          : cutMetrics;
      }

      report.gate.selfIntAfter = finalMetrics.selfIntersections;
      report.gate.oddAfter = finalMetrics.oddEdges;
      report.gate.nmAfter = finalMetrics.nonManifoldEdges;
      report.gate.compAfter = finalMetrics.components;

      if (gateOn) {
        var bad = null;

        if (finalMetrics.selfIntersections > report.gate.selfIntBefore) {
          bad = 'self-intersections ' + report.gate.selfIntBefore + ' -> ' +
                finalMetrics.selfIntersections;
          report.gate.blocked.push('selfInt');
        } else if (finalMetrics.nonManifoldEdges > report.gate.nmBefore) {
          bad = 'non-manifold edges ' + report.gate.nmBefore + ' -> ' +
                finalMetrics.nonManifoldEdges;
          report.gate.blocked.push('nonManifold');
        } else if (finalMetrics.degenerateTris > report.before.degenerateTris) {
          bad = 'degenerate triangles ' + report.before.degenerateTris + ' -> ' +
                finalMetrics.degenerateTris;
          report.gate.blocked.push('degenerate');
        } else if (mode === 'face' && finalMetrics.components > report.before.components) {
          bad = 'deleting that face splits the piece into ' + finalMetrics.components +
                ' bodies (was ' + report.before.components + ') - ' +
                'delete the shell instead, or leave it';
          report.gate.blocked.push('shatter');
        } else if (mode === 'shell' && finalMetrics.components >= report.before.components) {
          bad = 'shell delete removed ' + removed + ' triangles but the piece still has ' +
                finalMetrics.components + ' component(s) - the selection was not a whole shell';
          report.gate.blocked.push('shatter');
        } else if (mode === 'shell' && finalMetrics.oddEdges > report.gate.oddBefore) {
          /* Taking whole bodies away cannot legitimately open an edge on the
           * bodies that stay - they never shared one, which is what made them
           * separate components. If the count rose, the selection was not the
           * shell it was taken for. */
          bad = 'shell delete opened edges on what was left: ' + report.gate.oddBefore +
                ' -> ' + finalMetrics.oddEdges + ' odd';
          report.gate.blocked.push('shellOpened');
        } else if (requireWatertight && !finalMetrics.watertight) {
          bad = 'the result is open (' + finalMetrics.openEdges + ' open, ' +
                finalMetrics.nonManifoldEdges + ' non-manifold) and a closed solid was required';
          report.gate.blocked.push('watertight');
        } else if (!isFinite(finalMetrics.volume)) {
          bad = 'volume not finite';
          report.gate.blocked.push('volume');
        }

        if (bad) {
          report.declined = true;
          report.reason = 'gate: ' + bad;
          settle(false, finalMetrics);
          return { rawTris: rawTris, report: report, ok: true };
        }
      }

      settle(true, finalMetrics);
      report.applied = true;
      report.reason = 'deleted ' + removed + ' triangle(s)' +
                      (mode === 'shell' ? ' (' + report.componentsRemoved + ' shell(s))' : '') +
                      (report.seal
                        ? (report.seal.applied
                            ? ', sealed (' + report.seal.holesFilled + ' hole(s), +' +
                              report.seal.holeTrisAdded + ' tris)'
                            : ', seal declined (' + report.seal.reason + ')')
                        : '');
      return { rawTris: outSealed, report: report, ok: true };

    } catch (err) {
      report.applied = false;
      report.declined = true;
      report.reason = 'internal error: ' + ((err && err.message) || err);
      report.error = String((err && err.stack) || err);
      return { rawTris: rawTris, report: report, ok: false };
    }
  }

  global.NSO_PaintDelete = {
    VERSION: VERSION,
    N_TOL: N_TOL,
    D_TOL: D_TOL,
    commit: commit,
    select: select,
    /* Exposed for tools/nso_paint_delete_test.js, which holds the component
     * count here against NSO_Repair.analyze's. */
    _componentsOf: componentsOf,
    _edgeMap: edgeMap,
    _rawExtreme: rawExtreme
  };

})(typeof window !== 'undefined' ? window : this);
