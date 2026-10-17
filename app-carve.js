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

   Click or drag
   -------------
   A press opens a stroke and the release decides: a click punches the blade
   in once (carveAt), a drag cuts one continuous groove along it
   (carveStrokeOn - NSO_Carve.planStroke's swept section and end blades,
   unioned and subtracted in one boolean, one Undo).
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

  /* One click-owning mode at a time, the same contract app-measure.js states
     and app-mask.js, app-brush.js and app-seat-surface.js all keep. Carve is
     asked second in app-core's pointerdown routing - right after paint - so
     paint left armed when Carve goes live is not queued behind it, it never
     fires again: paint keeps taking the click and Carve's button sits lit and
     dead. This used to name only Seat here.

     Paint and the other two with a button go off THROUGH the button, so
     aria-pressed and the armed class follow rather than being written behind
     its back; state.centerLockArmed stays a flag write on purpose, as it does
     in every other disarmOthers, because btn-center-lock-pick refuses to
     cancel once the Join pair it needs is gone. */
  function disarmOthers() {
    if (state.maskPaint) {
      var paintBtn = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (state.seatHereArmed) {
      var seatBtn = $('btn-seat-here');
      if (seatBtn) seatBtn.click();
      else state.seatHereArmed = false;
    }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      var brushBtn = $('btn-brush');
      if (brushBtn) brushBtn.click();
      else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (typeof window.nsoPullArmed === 'function' && window.nsoPullArmed()) {
      var pullBtn = $('btn-pull');
      if (pullBtn) pullBtn.click();
      else if (typeof window.nsoPullSetArmed === 'function') window.nsoPullSetArmed(false);
    }
    if (state.measureOn) {
      var measureBtn = $('btn-measure');
      if (measureBtn) measureBtn.click();
      else state.measureOn = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    state.centerLockArmed = false;
  }

  function setArmed(on) {
    state.carveArmed = !!on;
    var btn = $('btn-carve');
    if (btn) {
      btn.setAttribute('aria-pressed', state.carveArmed ? 'true' : 'false');
      btn.classList.toggle('is-armed', state.carveArmed);
    }
    if (state.carveArmed) {
      disarmOthers();
      say('Carve armed - click a face, an edge or a corner to punch, or drag to cut a groove. Click Carve again to stop.');
    } else {
      if (stroke) endStroke(false);
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
     paint answers, for the same reason.

     The press no longer cuts. It opens a STROKE, the way the Brush's press
     does: the drag collects the surface under the pointer, and the release
     decides. A release within CLICK_PX of the press is a click and punches the
     blade in once at the press point, exactly as Carve always has; anything
     longer is a groove - the blade swept along the stroke, one cut, one Undo.
     The preview line follows the pointer while the button is held. */
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
    beginStroke(t, event);
    return true;
  };

  /* ---- the stroke: press, drag, release ---- */

  /* Under this many screen pixels from the press, a release is a click. */
  var CLICK_PX = 4;
  var stroke = null;

  function sampleOf(t) {
    var n = t.hit.face ? t.hit.face.normal.clone().transformDirection(t.hit.object.matrixWorld).normalize() : null;
    var p = t.hit.point;
    return { point: [p.x, p.y, p.z], normal: n ? [n.x, n.y, n.z] : null };
  }

  function drawPreview(s) {
    if (!state.scene || typeof THREE === 'undefined') return;
    var pts = s.samples.map(function (q) {
      var n = q.normal || [0, 0, 0];
      return new THREE.Vector3(q.point[0] + n[0] * 0.05, q.point[1] + n[1] * 0.05, q.point[2] + n[2] * 0.05);
    });
    if (pts.length < 2) return;
    if (!s.line) {
      s.line = new THREE.Line(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xff7a1a, depthTest: false, transparent: true }));
      s.line.renderOrder = 999;
      s.line.userData.carveStroke = true;
      state.scene.add(s.line);
    }
    s.line.geometry.dispose();
    s.line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  function dropPreview(s) {
    if (!s || !s.line) return;
    if (s.line.parent) s.line.parent.remove(s.line);
    s.line.geometry.dispose();
    s.line.material.dispose();
    s.line = null;
  }

  function beginStroke(t, event) {
    stroke = {
      target: t, index: t.index, samples: [sampleOf(t)],
      x0: event.clientX, y0: event.clientY, moved: 0, line: null
    };
    if (state.controls) state.controls.enabled = false;
    try { if (event.target && event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId); } catch (e) {}
    say('Carve - drag to cut a groove, let go to cut it; a click punches. Esc cancels.');
  }

  function onStrokeMove(event) {
    var s = stroke;
    if (!s) return;
    s.moved = Math.max(s.moved, Math.hypot(event.clientX - s.x0, event.clientY - s.y0));
    var t = hitPiece(event);
    if (!t || t.index !== s.index) return;
    s.samples.push(sampleOf(t));
    drawPreview(s);
  }

  function endStroke(commit) {
    var s = stroke;
    stroke = null;
    if (!s) return;
    dropPreview(s);
    if (state.controls) state.controls.enabled = true;
    if (!commit) { say('Carve cancelled - piece unchanged'); return; }
    busy = true;
    var isClick = s.moved < CLICK_PX;
    /* do the work off the event so a slow boolean never blocks the pointer
       handler */
    setTimeout(function () {
      var job = isClick ? carveAt(s.target) : carveStrokeOn(s.target.placed, s.samples, s.target);
      Promise.resolve(job).then(function (r) { window.nsoCarveLast = r || null; })
        .catch(function (e) {
          say('Carve failed - ' + ((e && e.message) ? e.message : e), true);
        }).then(function () { busy = false; });
    }, 0);
  }

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

  /* The weld at GATE_WELD every carve result gets before it is committed -
     why, measured, is written at its call in carveAt. Returns the soup to
     commit, how many seam slivers the weld collapsed, and the tolerance. */
  function weldForGate(soup) {
    var welded = soup, dropped = 0, weldTol = null;
    if (typeof NSO_buildAdjacency === 'function' && typeof NSO_adjacencyToRaw === 'function') {
      var adj = NSO_buildAdjacency(soup, { tol: GATE_WELD, rawTol: true });
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
    return { soup: welded, dropped: dropped, weldTol: weldTol };
  }

  /* One carve. Returns the plan + numbers so the check can drive it headlessly
     and read what happened, not just the status text. */
  async function carveAt(target) {
    if (!window.NSO_Carve) { say('Carve needs nso_carve.js', true); return null; }
    var placed = target.placed;
    var model = state.models.find(function (m) { return m && m.id === placed.sourceId; });
    if (!model || !placed.mesh) { say('Carve: that piece is not on the plate', true); return null; }
    var overlap = (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? nsoOverlap.refusalOfModels([model]) : '';
    if (overlap) { say('Carve refused - ' + overlap + ' - piece unchanged', true); return { ok: false, reason: overlap }; }

    var blade = currentBlade();
    var depth = numOf($('carve-depth'), 1);
    var roll = numOf($('carve-roll'), 0);
    var params = currentParams(blade, depth);

    placed.mesh.updateMatrixWorld(true);
    var hullSoup = meshToWorldSoup(placed.mesh);
    var pt = target.hit.point;

    var planned = NSO_Carve.plan(hullSoup, [pt.x, pt.y, pt.z], blade, params, { depth: depth, roll: roll });
    if (!planned.ok) { say('Carve: ' + planned.reason, true); return { ok: false, reason: planned.reason }; }

    /* THE LIVE WALL GATE - proactive, before the kernel is even loaded.

       This is a SECOND layer, independent of the cutClearance() warning below,
       and the two catch different failures. cutClearance() asks whether the cut
       SEVERS a member - whether the bit runs out the far side - and is
       deliberately a warning and never a refusal, because Local-Carve's corner
       gouge severs a wall on purpose (docs/LOCAL-CARVE.md 3c). This asks the
       question nothing in the carve path asks at all: how much wall is under
       this point, and does a cut this deep leave enough of it to print? A cut
       that stops well short of the far face, severs nothing, and leaves 0.2 mm
       standing passes every check that already exists and comes out of the
       slicer as a hole.

       So this one REFUSES, and it does so here - before the CSG kernel is
       loaded and before anything is committed - rather than reporting after
       the fact. The probe is NSO_Thickness.prepare() on the piece's own world
       soup: one weld, one grid, one query, all on this click. */
    var gate = null;
    if (typeof NSO_Thickness !== 'undefined' && typeof NSO_Thickness.prepare === 'function') {
      try {
        var probe = NSO_Thickness.prepare(hullSoup, {});
        if (probe) {
          gate = probe.strokeGate({ point: [pt.x, pt.y, pt.z], depth: depth, label: 'carve' });
        }
      } catch (e) { gate = null; }
    }
    if (gate && !gate.ok) {
      var refusal = NSO_Thickness.strokeRefusal(gate);
      say(refusal, true);
      return { ok: false, reason: refusal, gate: gate, planned: planned };
    }

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
    var wd = weldForGate(res.soup), welded = wd.soup, dropped = wd.dropped, weldTol = wd.weldTol;

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
    var wallNote = (gate && gate.measured)
      ? 'wall ' + (Math.round(gate.wall_mm * 1000) / 1000) + ' mm, ' +
        (Math.round(gate.residual_mm * 1000) / 1000) + ' mm left (floor ' +
        (Math.round(gate.threshold_mm * 1000) / 1000) + ')'
      : '';
    var status = NSO_Carve.carveReport(planned, removed, intended) +
      ' - open edges ' + res.openBefore + '→' + res.openAfter +
      ', non-manifold ' + res.nmBefore + '→' + res.nmAfter +
      (dropped ? ', welded away ' + dropped + ' seam sliver' + (dropped === 1 ? '' : 's') : '') +
      (wallNote ? ' - ' + wallNote : '') +
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

  /* The nozzle the groove's wall floor is two widths of. The app has no
     printer-wide nozzle setting; 0.4 is the one every other floor here quotes
     (NSO_Thickness's default). */
  var STROKE_NOZZLE = 0.4;

  /* One groove: the blade swept along a drag. Same shape of answer as
     carveAt, so the check reads both the same way.

     Not through subtractSoupBFromA, and deliberately: that path's safety box
     reserves minWall along ONE punch axis from ONE blade frame, and a groove
     has a frame per segment. The wall question it answers is asked here
     instead, along the whole stroke and before the kernel is even loaded, by
     NSO_Carve.strokeWallGate - which is stricter: it refuses, it does not
     clip. What is left is the plain boolean: piece minus the union of the
     groove's pieces, in the same kernel, welded and committed the way a punch
     is. */
  async function carveStrokeOn(placed, samples, pressTarget) {
    if (!window.NSO_Carve || !NSO_Carve.planStroke) { say('Carve needs nso_carve.js', true); return null; }
    var model = state.models.find(function (m) { return m && m.id === placed.sourceId; });
    if (!model || !placed.mesh) { say('Carve: that piece is not on the plate', true); return null; }
    var overlap = (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? nsoOverlap.refusalOfModels([model]) : '';
    if (overlap) { say('Carve refused - ' + overlap + ' - piece unchanged', true); return { ok: false, reason: overlap, stroke: true }; }

    var blade = currentBlade();
    var depth = numOf($('carve-depth'), 1);
    var params = currentParams(blade, depth);

    placed.mesh.updateMatrixWorld(true);
    var hullSoup = meshToWorldSoup(placed.mesh);
    var planned = NSO_Carve.planStroke(hullSoup, samples, blade, params, { depth: depth });
    if (!planned.ok && planned.short && pressTarget) return carveAt(pressTarget);
    if (!planned.ok) { say('Carve: ' + planned.reason, true); return { ok: false, reason: planned.reason, stroke: true }; }

    /* THE WALL GATE, before the kernel: two nozzle widths, the whole stroke. */
    var wall = null;
    if (typeof NSO_Thickness !== 'undefined' && typeof NSO_Thickness.prepare === 'function') {
      try {
        var probe = NSO_Thickness.prepare(hullSoup, {});
        if (probe) wall = NSO_Carve.strokeWallGate(probe, planned, { nozzle: STROKE_NOZZLE });
      } catch (e) { wall = null; }
    }
    if (wall && !wall.ok) {
      var refusal = NSO_Carve.strokeRefusalText(wall, STROKE_NOZZLE);
      say(refusal, true);
      return { ok: false, reason: refusal, wall: wall, planned: planned, stroke: true };
    }

    var wasm;
    try { wasm = await NSO_CSG.load(); }
    catch (err) {
      say('Carve: CSG kernel failed to load - ' + ((err && err.message) ? err.message : err), true);
      return { ok: false, reason: 'kernel', stroke: true };
    }

    var before = NSO_edgeStats(hullSoup);
    var manA = null, groove = null, inter = null, result = null, parts = [];
    var out = null;
    try {
      var aIn = hullSoup;
      if (typeof weldSoupVerts === 'function') {
        try { aIn = weldSoupVerts(hullSoup, NSO_weldEpsFor(hullSoup, 0.08)); } catch (e0) { aIn = hullSoup; }
      }
      manA = NSO_CSG.soupToManifold(wasm, aIn);
      if (manA.status && manA.status() !== 'NoError') throw new Error('piece rejected by the kernel: ' + manA.status());
      for (var i = 0; i < planned.pieces.length; i++) {
        var m = NSO_CSG.soupToManifold(wasm, planned.pieces[i]);
        if (m.status && m.status() !== 'NoError') { m.delete(); throw new Error('groove piece ' + i + ' rejected: ' + m.status()); }
        parts.push(m);
      }
      groove = parts[0];
      for (i = 1; i < parts.length; i++) {
        var u = groove.add(parts[i]);
        if (groove !== parts[0]) groove.delete();
        groove = u;
      }
      inter = manA.intersect(groove);
      var intended = inter.volume();
      if (!(intended > NOOP_FLOOR)) {
        var miss = 'the groove does not reach the piece at depth ' + depth + ' mm';
        say('Carve: ' + miss, true);
        return { ok: false, reason: miss, planned: planned, stroke: true };
      }
      result = manA.subtract(groove);
      if (result.status() !== 'NoError') throw new Error('subtract rejected by kernel: ' + result.status());
      if (result.isEmpty()) throw new Error('subtract produced an empty solid');
      var removed = manA.volume() - result.volume();
      var soup = NSO_CSG.manifoldToSoup(result);
      var exact = NSO_manifoldStats(result);
      var after = exact.exact ? { open: exact.open, nm: exact.nm } : NSO_edgeStats(soup);
      out = { soup: soup, removed: removed, intended: intended, after: after };
    } catch (err) {
      var why = (err && err.message) ? err.message : String(err);
      say('Carve failed - ' + why, true);
      return { ok: false, reason: why, planned: planned, stroke: true };
    } finally {
      if (manA) manA.delete();
      if (inter) inter.delete();
      if (result) result.delete();
      if (groove && groove !== parts[0]) groove.delete();
      parts.forEach(function (p) { p.delete(); });
    }

    var wd = weldForGate(out.soup);
    var geo = soupToCenteredGeo(wd.soup);
    var raw = displayGeometryToRawSoup(geo);
    var status = NSO_Carve.strokeReport(planned, out.removed, out.intended) +
      ' - open edges ' + before.open + '→' + out.after.open +
      ', non-manifold ' + before.nm + '→' + out.after.nm +
      (wd.dropped ? ', welded away ' + wd.dropped + ' seam sliver' + (wd.dropped === 1 ? '' : 's') : '') +
      (wall ? ' - wall: ' + wall.reason + ' (two ' + STROKE_NOZZLE + ' mm nozzle widths)' : '');
    if (!NSO_sculptCommitRaw(model, raw, 'carveReplace', status)) {
      say('Carve: could not commit the result', true);
      return { ok: false, reason: 'commit failed', planned: planned, stroke: true };
    }
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    return {
      ok: true, stroke: true, planned: planned, removed: out.removed, intended: out.intended,
      openAfter: out.after.open, nmAfter: out.after.nm, status: status, wall: wall,
      dropped: wd.dropped, trisOut: wd.soup.length / 9
    };
  }

  /* Exposed so tools/nso_carve_drag_check.js can run a groove from given
     samples without a pointer; the drag path and this path run the same
     carveStrokeOn. samples: [{ point:[x,y,z], normal:[x,y,z] }], world. */
  window.nsoCarveStrokeAt = function (sourceId, samples) {
    var idx = state.placed.findIndex(function (p) { return p && p.sourceId === sourceId; });
    if (idx < 0) return Promise.resolve({ ok: false, reason: 'piece not on the plate' });
    if (busy) return Promise.resolve({ ok: false, reason: 'a carve is already running' });
    busy = true;
    return Promise.resolve(carveStrokeOn(state.placed[idx], samples, null))
      .then(function (r) { busy = false; return r; }, function (e) { busy = false; throw e; });
  };
  window.nsoCarveBusy = function () { return busy || !!stroke; };

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
    if (!window._carveStrokeBound) {
      window._carveStrokeBound = true;
      window.addEventListener('pointermove', onStrokeMove);
      window.addEventListener('pointerup', function () { if (stroke) endStroke(true); });
      window.addEventListener('pointercancel', function () { if (stroke) endStroke(false); });
      window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && stroke) endStroke(false); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
