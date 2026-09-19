/* ============================================================
   Carve — the local carving tool's app layer. After app-join.js (it calls
   NSO_CSG and subtractSoupBFromA) and after nso_carve.js (the geometry core).

   This file is thin on purpose. All the geometry lives in nso_carve.js, which
   is THREE-free and node-tested; all the boolean lives in app-join.js, which is
   unchanged. What is here is the three things that can only be done in the app:
   arm a click, lift nso_carve's plain-data frame into the THREE types
   NSO_CSG.buildCutVolume reads, and commit the result the way every other
   geometry op commits.

   Why the blade is not a placed piece
   -----------------------------------
   It is built, transformed, subtracted and dropped. It never enters
   state.models or state.placed, so:
     - it survives being used again, unlike Subtract's bit B, which
       subtractBFromA deletes on success (right for a one-shot port plug, wrong
       for a tool you place at the next edge);
     - it never meets applyMeshRotation, which rebuilds a piece's rotation from
       quantised Euler fields (90 deg yaw, 15 deg tilt/bank) and would destroy
       any free orientation the moment a pose button was pressed.
   That is the contained-pose-state decision, written down. See
   docs/LOCAL-CARVE.md, "Deferred: free orientation in the pose model".
   ============================================================ */
(function () {
  'use strict';

  /* Which shape parameters each blade exposes, and what to call them. The
     blade's `height` is NOT here: it is derived from the cut depth below, so
     "depth exceeds the blade" cannot be reached from the UI at all. */
  var FIELDS = {
    flat: [{ key: 'width', label: 'W', min: 0.2, max: 60, step: 0.1 },
           { key: 'length', label: 'L', min: 0.2, max: 60, step: 0.1 }],
    ball: [{ key: 'radius', label: 'R', min: 0.1, max: 30, step: 0.1 }],
    vee: [{ key: 'angle', label: '°', min: 10, max: 170, step: 1 },
          { key: 'length', label: 'L', min: 0.2, max: 60, step: 0.1 }]
  };

  /* The shank has to reach clear of the surface for the safety box's probe
     rays to start outside the piece, and clear of the ball's own radius so the
     gouge has a cylinder above its hemisphere. 2 mm of daylight, one rule. */
  var CLEAR = 2;

  /* Anything at or under this is a miss, not a cut. Absolute, because a carve's
     size has nothing to do with the piece's. */
  var NOOP_FLOOR = 1e-4;

  /* The weld the canonical checker uses, and therefore the weld a carve result
     has to already satisfy. tools/mesh_validate.py's default --weld. */
  var GATE_WELD = 1e-4;

  /* True while a carve is between reading the piece and committing the result. */
  var busy = false;
  function heightFor(blade, params, depth) {
    var need = depth;
    if (blade === 'ball' && params && isFinite(params.radius)) need = Math.max(need, params.radius);
    return need + CLEAR;
  }

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  function numOf(el, fallback) {
    if (!el) return fallback;
    var v = Number(el.value);
    return isFinite(v) ? v : fallback;
  }

  function currentBlade() {
    var sel = $('carve-blade');
    var name = sel ? sel.value : 'ball';
    return (window.NSO_Carve && window.NSO_Carve.BLADES[name]) ? name : 'ball';
  }

  /* The shape fields, read off the two generic inputs. They are generic because
     the three blades do not share a parameter list, and three fixed rows would
     leave two of them meaningless for every blade. */
  function currentParams(blade, depth) {
    var f = FIELDS[blade] || [], p = {}, els = [$('carve-a'), $('carve-b')], i;
    for (i = 0; i < f.length; i++) {
      p[f[i].key] = numOf(els[i], window.NSO_Carve.BLADES[blade].defaults[f[i].key]);
    }
    p.height = heightFor(blade, p, depth);
    return p;
  }

  /* Relabel and re-range the two generic inputs when the blade changes, and
     park each one on that blade's default so a value from the last blade
     cannot be read as this blade's. */
  function syncFields() {
    var blade = currentBlade();
    var f = FIELDS[blade] || [];
    var d = window.NSO_Carve.BLADES[blade].defaults;
    [['carve-a', 'carve-a-label', 0], ['carve-b', 'carve-b-label', 1]].forEach(function (row) {
      var el = $(row[0]), lab = $(row[1]), spec = f[row[2]];
      if (!el || !lab) return;
      var wrap = el.closest('label');
      if (!spec) {
        if (wrap) wrap.hidden = true;
        return;
      }
      if (wrap) wrap.hidden = false;
      lab.textContent = spec.label;
      el.min = spec.min; el.max = spec.max; el.step = spec.step;
      el.value = d[spec.key];
      el.title = blade + ': ' + spec.key + ' in mm' + (spec.key === 'angle' ? ' (degrees)' : '');
    });
    describe();
  }

  /* The blade the next click will use, in words, from the registry's own
     describe - so the readout can never drift from what gets built. */
  function describe() {
    var out = $('carve-readout');
    if (!out || !window.NSO_Carve) return;
    var blade = currentBlade();
    var depth = numOf($('carve-depth'), 1);
    var built = window.NSO_Carve.buildBlade(blade, currentParams(blade, depth));
    out.textContent = built.ok
      ? (built.describe + ' — cutting ' + depth + ' mm deep')
      : built.reason;
    out.classList.toggle('carve-bad', !built.ok);
  }

  /* ---- arming ---- */
  function setArmed(on) {
    state.carveArmed = !!on;
    var btn = $('btn-carve');
    if (btn) {
      btn.setAttribute('aria-pressed', state.carveArmed ? 'true' : 'false');
      btn.classList.toggle('is-armed', state.carveArmed);
    }
    if (state.carveArmed) {
      /* one click-owning mode at a time, the way Measure's disarmOthers does it */
      if (state.seatHereArmed) {
        var seatBtn = $('btn-seat-here');
        if (seatBtn) seatBtn.click();
        else state.seatHereArmed = false;
      }
      say('Carve armed - click a face, an edge or a corner. Click Carve again to stop.');
    } else {
      say('Carve off');
    }
  }

  function hitPiece(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = (obj && obj.userData) ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null) {
        return { hit: hits[i], index: idx, placed: state.placed[idx] };
      }
    }
    return null;
  }

  /* Asked by app-core's pointerdown, which runs first - the same predicate
     paint answers, for the same reason. */
  window.nsoCarveTakesClick = function (event) {
    if (!state.carveArmed || !event || event.button !== 0) return false;
    var t = hitPiece(event);
    if (!t) return false;
    /* One carve at a time. Each carve reads the piece's geometry, awaits the
       kernel, then commits - so two overlapping clicks would both read the
       SAME pre-cut geometry and the second commit would silently throw the
       first cut away. The whole point of this tool is that you click it
       repeatedly, so that race is reachable by ordinary use, not a corner case.
       The click is still taken (app-core must not start a move drag under it)
       and the line says why nothing happened. */
    if (busy) {
      say('Carve: the last cut is still running - one at a time', true);
      return true;
    }
    busy = true;
    /* do the work off the event so a slow boolean never blocks the pointer
       handler */
    setTimeout(function () {
      Promise.resolve(carveAt(t)).catch(function (e) {
        say('Carve failed - ' + ((e && e.message) ? e.message : e), true);
      }).then(function () { busy = false; });
    }, 0);
    return true;
  };

  /* nso_carve's plain-data frame -> the THREE types buildCutVolume reads.
     Nothing is recomputed here: axis, sign and capCoord come straight from the
     blade-local convention (+Y is out of the material), which is exactly why
     one frame serves every orientation. */
  function toPlugFrame(f) {
    var m = new THREE.Matrix4().fromArray(f.matrix);
    return {
      matrix: m,
      inv: new THREE.Matrix4().copy(m).invert(),
      box: new THREE.Box3(
        new THREE.Vector3(f.box.min[0], f.box.min[1], f.box.min[2]),
        new THREE.Vector3(f.box.max[0], f.box.max[1], f.box.max[2])
      ),
      axis: f.axis,
      sign: f.sign,
      outerNormal: new THREE.Vector3(f.outerNormal[0], f.outerNormal[1], f.outerNormal[2]),
      punch: new THREE.Vector3(f.punch[0], f.punch[1], f.punch[2]),
      capCoord: f.capCoord,
      span: f.span
    };
  }

  /* How much this blade SHOULD remove: blade n piece. Measured, not assumed,
     so the status line can say when minWall held some of it back instead of
     reporting the cut as if it went in whole. One extra intersect on a
     blade-sized solid. */
  function intendedVolume(wasm, hullSoup, bladeSoup) {
    var mA = null, mB = null, inter = null;
    try {
      mA = NSO_CSG.soupToManifold(wasm, hullSoup);
      mB = NSO_CSG.soupToManifold(wasm, bladeSoup);
      inter = mA.intersect(mB);
      return inter.volume();
    } catch (e) {
      return NaN;
    } finally {
      if (mA) mA.delete();
      if (mB) mB.delete();
      if (inter) inter.delete();
    }
  }

  /* One carve. Returns the plan + numbers so the check can drive it headlessly
     and read what happened, not just the status text. */
  async function carveAt(target) {
    if (!window.NSO_Carve) { say('Carve needs nso_carve.js', true); return null; }
    var placed = target.placed;
    var model = state.models.find(function (m) { return m && m.id === placed.sourceId; });
    if (!model || !placed.mesh) { say('Carve: that piece is not on the plate', true); return null; }

    var blade = currentBlade();
    var depth = numOf($('carve-depth'), 1);
    var roll = numOf($('carve-roll'), 0);
    var params = currentParams(blade, depth);

    placed.mesh.updateMatrixWorld(true);
    var hullSoup = meshToWorldSoup(placed.mesh);
    var pt = target.hit.point;

    var planned = NSO_Carve.plan(hullSoup, [pt.x, pt.y, pt.z], blade, params, { depth: depth, roll: roll });
    if (!planned.ok) { say('Carve: ' + planned.reason, true); return { ok: false, reason: planned.reason }; }

    var wasm;
    try { wasm = await NSO_CSG.load(); }
    catch (err) {
      say('Carve: CSG kernel failed to load - ' + ((err && err.message) ? err.message : err), true);
      return { ok: false, reason: 'kernel' };
    }
    var intended = intendedVolume(wasm, hullSoup, planned.worldSoup);

    /* Refuse a miss here, where the reason can name the blade and the depth,
       rather than letting the kernel's no-op guard report it as a placement
       problem. `intended` is the real measurement: blade n piece. */
    if (!isFinite(intended) || intended <= NOOP_FLOOR) {
      var miss = 'the blade does not reach the piece at depth ' + depth +
        ' mm (it would remove ' + (isFinite(intended) ? intended.toFixed(4) : '0') + ' mm\u00b3)';
      say('Carve: ' + miss, true);
      return { ok: false, reason: miss, planned: planned };
    }

    /* minRemoved, not the kernel's default. That default is 0.01% of the
       piece's volume, sized for a plug whose caller deletes its bit on success;
       a carve deletes nothing and is legitimately far smaller than that - the
       corner gouge above is 0.003% of an 80x40x20 block. The real check on a
       carve is `removed` against `intended`, which the status line reports. */
    var res = await subtractSoupBFromA(hullSoup, planned.worldSoup, {
      plugFrame: toPlugFrame(planned.frame),
      minWall: 1.0,
      minRemoved: NOOP_FLOOR
    });
    if (!res || !res.ok || !res.soup || res.soup.length < 9) {
      var why = (res && res.reason) ? res.reason : 'result empty';
      say('Carve failed - ' + why, true);
      return { ok: false, reason: why, planned: planned };
    }

    /* What actually came out, read off the two solids rather than trusted from
       the blade - the difference between this and `intended` is the whole of
       what minWall held back. */
    var removed = NaN, mBefore = null, mAfter = null;
    try {
      mBefore = NSO_CSG.soupToManifold(wasm, hullSoup);
      mAfter = NSO_CSG.soupToManifold(wasm, res.soup);
      removed = mBefore.volume() - mAfter.volume();
    } catch (e) { removed = NaN; }
    finally { if (mBefore) mBefore.delete(); if (mAfter) mAfter.delete(); }

    /* Weld the kernel's output before committing, and drop what the weld
       collapses. Not belt-and-braces - measured.

       A carve cuts where the blade's surface crosses the piece's own faces and
       edges, and the kernel carries positions in float32. A crossing that lands
       on a face plane at a round coordinate comes back as TWO vertices one
       float32 ULP apart: on a ball-nose corner gouge into
       fixtures/box_hull_80x40x20-2.stl, (40, 18.639208, 19.999998) and
       (40, 18.639208, 20.000000) - 1.907e-06 apart, which is 2^-19, exactly one
       ULP at magnitude 20. Four triangles carried such an edge. They are not
       degenerate (they have area), so nothing upstream drops them, and the
       kernel's own counters read 0 open / 0 non-manifold because in ITS index
       space the mesh is sound. But the canonical checker welds at 1e-4 before
       counting, as every gate in this project does, and each of those four
       triangles then collapses to a line: 4 non-manifold edges, 4 odd edges,
       10 inconsistent windings, Euler 4. The mesh was manifold only if you
       refused to weld it - it passed at --weld 1e-6 and failed at 1e-5.

       NSO_buildAdjacency is the right tool and it is already in the app: it
       welds by real DISTANCE (a vertex looks in its own cell and the 26 around
       it) rather than by rounding into a bucket, so a pair astride a bucket wall
       cannot slip through, and it drops every triangle two of whose corners
       welded together.

       At GATE_WELD, and deliberately NOT at its default feature-scale tolerance.
       NSO_sculptWeldTol's job is to protect a piece's own detail from a weld it
       did not ask for, which is exactly right for smoothing. It is the wrong
       policy for a mesh whose acceptance test is a FIXED weld: whatever the gate
       will fuse has to be fused already, or the gate is measuring a mesh that
       does not exist. Measured on a ball-nose gouge into
       fixtures/fixture_sphere_curved.stl, where the cap lands at 5.459e-05 -
       under the gate's 1e-4:
         kernel soup, no weld ... nm 4, odd 4, wind 10, Euler 4, FAIL
         welded at the 5.459e-05 cap  nm 2, odd 2, wind  5, Euler 3, FAIL
         welded at a raw 1e-4 ....... nm 0, odd 0, wind  0, Euler 2, PASS
       and the signed volume is 4155.7894 mm^3 in all three - the weld fuses
       seams, it does not remove material. The cap fused two of the four offending
       triangles and left two, which is worse than either extreme: a mesh that
       claims to be welded and still fails.

       What this costs, stated plainly: a genuine feature finer than 1e-4 mm
       would be fused. That is 0.1 micron - 4000x under a 0.4 mm nozzle, and
       under the canonical checker's own resolution, so such a feature cannot
       survive the gate by any route. If the weld ever does structural damage it
       shows up as an open or non-manifold edge in the adjacency's own counters,
       and the guard below keeps the kernel soup instead of committing it.

       Deliberately NOT done inside subtractSoupBFromA. Subtract's own outputs
       already gate clean on the inputs it ships with (docs/LOCAL-CARVE.md, §2),
       and widening the shipped boolean would move numbers other checks pin. A
       curved bit through Subtract would likely want the same treatment; that is
       its own ticket, not this one. */
    var welded = res.soup, dropped = 0, weldTol = null;
    if (typeof NSO_buildAdjacency === 'function' && typeof NSO_adjacencyToRaw === 'function') {
      var adj = NSO_buildAdjacency(res.soup, { tol: GATE_WELD, rawTol: true });
      if (adj && adj.ok && !adj.openEdges && !adj.nmEdges) {
        welded = NSO_adjacencyToRaw(adj);
        dropped = adj.droppedTris;
        weldTol = adj.weldTol;
      } else {
        console.warn('[carve] weld stood down (' +
          (adj && adj.ok ? 'it would leave ' + adj.openEdges + ' open / ' + adj.nmEdges + ' non-manifold edges'
                         : (adj && adj.reason)) + ') - committing the kernel soup as is');
      }
    }

    /* Commit exactly as Soften / Smooth / Thicken commit: one raw soup through
       the shared helper, which pushes the undo entry, swaps the geometry,
       rebuilds the mesh and repaints the mask. carveReplace is a row in
       UNDO_REPLACE_LABEL, so Undo already knows what to call it. */
    var geo = soupToCenteredGeo(welded);
    var raw = displayGeometryToRawSoup(geo);
    /* The nozzle-safety finding from the shared cut core, appended as one more
       ' - ' clause on the line that already reports what the carve removed.
       A carve is the op that MOST wants this and least wants it enforced: a
       corner gouge severing a 2 mm wall is this tool's own use case, so the
       warning is worded "reported, not blocked" and the commit below runs
       unchanged. '' on a carve that leaves a printable wall. */
    var cutWarn = (typeof NSO_Thickness !== 'undefined' && res.clearance)
      ? NSO_Thickness.cutWarning(res.clearance) : '';
    var status = NSO_Carve.carveReport(planned, removed, intended) +
      ' - open edges ' + res.openBefore + '→' + res.openAfter +
      ', non-manifold ' + res.nmBefore + '→' + res.nmAfter +
      (dropped ? ', welded away ' + dropped + ' seam sliver' + (dropped === 1 ? '' : 's') : '') +
      (cutWarn ? ' - ' + cutWarn : '');
    if (!NSO_sculptCommitRaw(model, raw, 'carveReplace', status)) {
      say('Carve: could not commit the result', true);
      return { ok: false, reason: 'commit failed', planned: planned };
    }
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    if (typeof removeFaceHelper === 'function') removeFaceHelper();

    return {
      ok: true, planned: planned, removed: removed, intended: intended,
      openAfter: res.openAfter, nmAfter: res.nmAfter, status: status,
      dropped: dropped, weldTol: weldTol, trisOut: welded.length / 9,
      /* the nozzle-safety report behind `status`'s warning clause, carried out
         so a check can assert on the verdict rather than on its wording */
      clearance: res.clearance || null
    };
  }

  /* Exposed so tools/nso_carve_test.js can drive a carve at an exact world
     point without synthesising a pointer event and a camera pose for it. The
     UI path and this path run the same carveAt. */
  window.nsoCarveAtPoint = function (sourceId, point) {
    var idx = state.placed.findIndex(function (p) { return p && p.sourceId === sourceId; });
    if (idx < 0) return Promise.resolve({ ok: false, reason: 'piece not on the plate' });
    if (busy) return Promise.resolve({ ok: false, reason: 'a carve is already running' });
    var placed = state.placed[idx];
    busy = true;
    return Promise.resolve(carveAt({
      hit: { point: new THREE.Vector3(point[0], point[1], point[2]) }, index: idx, placed: placed
    })).then(function (r) { busy = false; return r; },
       function (e) { busy = false; throw e; });
  };
  window.nsoCarveSetControls = function (o) {
    if (o.blade !== undefined && $('carve-blade')) { $('carve-blade').value = o.blade; syncFields(); }
    if (o.a !== undefined && $('carve-a')) $('carve-a').value = o.a;
    if (o.b !== undefined && $('carve-b')) $('carve-b').value = o.b;
    if (o.depth !== undefined && $('carve-depth')) $('carve-depth').value = o.depth;
    if (o.roll !== undefined && $('carve-roll')) $('carve-roll').value = o.roll;
    describe();
    return { blade: currentBlade(), depth: numOf($('carve-depth'), 1), roll: numOf($('carve-roll'), 0),
             params: currentParams(currentBlade(), numOf($('carve-depth'), 1)) };
  };

  function wire() {
    var btn = $('btn-carve');
    if (btn) btn.addEventListener('click', function () { setArmed(!state.carveArmed); });
    var sel = $('carve-blade');
    if (sel) sel.addEventListener('change', syncFields);
    ['carve-a', 'carve-b', 'carve-depth', 'carve-roll'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', describe);
    });
    syncFields();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
