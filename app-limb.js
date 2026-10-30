/* Limb - grab a branch anywhere along it, then stretch it or bend it.

   The app layer over nso_limb.js (the tree, the limb, the move and its guards)
   and nso_densify.js (the subdivision). Full write-up: docs/LIMB.md.
   Shape -> Limb.

   WHY IT IS NOT EXTEND OR PULL. Extend needs one straight X, Y or Z axis, and a
   tree has none. Pull's falloff is a ball in space, so it takes the twig beside
   the one you grabbed. Limb finds the branch by walking the surface from the
   trunk's foot: everything from the grab outward is carried whole, the stretch
   of branch between the grab and the fork below it is the flex zone, and
   nothing else moves.

   THE GESTURE
     ARM      select a piece, press Limb. Hover a branch: a ring marks the loop
              the grab would take, a line runs down to the hinge at the fork
              below it (the stretch of the limb that will flex).
     DRAG     press on a branch and drag. After a few pixels the flex zone is
              densified (1 mm), and the centre of the ring under the press follows
              the cursor in the VIEW PLANE - the limb leans and lengthens to
              reach it. Everything beyond the ring rides with it, rigid.
                 plain    Stretch + bend: land the ring on the cursor
                 Shift    Extend only: just the part of the drag along the limb
                 Alt      Bend only: swing the limb towards the cursor, its length held
              (the three buttons in the panel are the same choice, held.)
     RELEASE  is Set. One Undo step. There is no Set button.
     ESCAPE   mid-drag puts the piece back exactly.
     CLICK    picks a limb without moving it; the Extend / Bend numbers in the
              panel then apply to it. A grab is a limb picked and moved in one.
     REACH    0 (the default): the flex zone runs down to the fork. A number:
              only that many mm below the grab flex, so the bend is tighter.

   THE PREVIEW IS NOT A COMMIT. During the drag the placed mesh shows a throwaway
   geometry; m.rawTris is untouched. A refused move, a cancelled one and a lost
   pointer all end by putting the original geometry back. Only a move that clears
   the guards (nso_limb.js: fold, self-intersection) is committed, through
   NSO_sculptCommitRaw - the commit the Brush, Smooth, Foam and Pull use.

   PAINT SCOPE: SUB-REGION (docs/HANDOFF.md, "Scoping"). Limb moves the vertices of
   the limb and nothing else, so it checks only the painted faces those vertices
   lie on, where they were and where they went; paint elsewhere on the piece does
   not stop it. The planes come from nsoMaskPlaneList (read, never re-derived), and
   the test is the Brush's own NSO_brushPaintCheck. OPERAND: NONE - the operand is
   a gesture, so the SELECT list is never read; the EXCLUDE list always is.
   NON-SOLID: not read - Limb moves vertices and neither opens nor closes an edge.

   A SUPPORT PIECE (m.nsoSupport) is refused at the press: supports are
   generated, not sculpted. The root is the lowest part of the piece, so a tree
   lying on its side must be stood up first (Tip -> Stand).
*/
if (typeof document !== 'undefined') (function () {
  'use strict';

  var DRAG_PX = 4;                // a press that moves less than this is a click
  var SEGMENTS = 48;
  var MARK_ORDER = 61;
  var MARK_COLOR = 0xff8a3d, HINGE_COLOR = 0xffffff;   // orange: the tree's own colours are blue and cyan

  var armed = false;
  var mode = 'free';              // 'free' | 'extend' | 'bend'
  var pending = null;             // a press that is not yet a click or a drag
  var session = null;             // the live grab
  var selected = null;            // a limb picked by a click: { modelId, point:[raw] }
  var marker = null, markerKey = '';
  var cache = { tris: null, ctx: null };

  function model() { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
  function say(t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); }
  function el(id) { return document.getElementById(id); }
  function round(v, n) { var k = Math.pow(10, n || 2); return Math.round(v * k) / k; }

  /* ---- raw <-> local, measured off the piece the way app-pull.js does it: the
     display mesh is the raw soup turned -90 deg about X and centred on its
     bounding box. */
  function frameOf(m) {
    if (!m || !m.rawTris || !m.rawTris.length) return null;
    var r = m.rawTris;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < r.length; i += 3) {
      var d = [r[i], r[i + 2], -r[i + 1]];
      for (var k = 0; k < 3; k++) {
        if (d[k] < lo[k]) lo[k] = d[k];
        if (d[k] > hi[k]) hi[k] = d[k];
      }
    }
    return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
  }
  function rawPointFromLocal(f, p) {
    var d = [p[0] + f.c[0], p[1] + f.c[1], p[2] + f.c[2]];
    return [d[0], -d[2], d[1]];
  }
  function localFromRaw(f, r) { return [r[0] - f.c[0], r[2] - f.c[1], -r[1] - f.c[2]]; }
  function rawDirFromLocal(v) { return [v[0], -v[2], v[1]]; }

  /* ---- the controls ---- */
  function reach() {
    var s = el('inp-limb-reach'), v = s ? parseFloat(s.value) : 0;
    return v > 0 ? v : 0;
  }
  function syncReach() {
    var o = el('out-limb-reach');
    if (o) o.textContent = reach() > 0 ? reach().toFixed(0) + ' mm' : 'to the fork';
  }
  function setMode(m) {
    mode = m;
    ['free', 'extend', 'bend'].forEach(function (k) {
      var b = el('btn-limb-mode-' + k);
      if (b) { b.classList.toggle('is-on', k === m); b.setAttribute('aria-pressed', k === m ? 'true' : 'false'); }
    });
  }
  function readout(text, bad) {
    var r = el('limb-readout');
    if (!r) return;
    r.textContent = text;
    r.classList.toggle('is-bad', !!bad);
  }
  function setLabel() {
    var b = el('btn-limb');
    if (b) {
      b.classList.toggle('is-armed', armed);
      b.setAttribute('aria-pressed', armed ? 'true' : 'false');
      b.setAttribute('aria-expanded', armed ? 'true' : 'false');
      b.textContent = armed ? 'Limb: on' : 'Limb';
    }
    var pnl = el('limb-panel');
    if (pnl) pnl.hidden = !armed;
    var ap = el('btn-limb-apply');
    if (ap) ap.disabled = !selected;
  }
  /* Which way the Bend number leans the limb, as the camera sees it. */
  function leanRaw(p) {
    var sel = el('sel-limb-lean'), key = sel ? sel.value : 'right';
    var cam = state.camera;
    cam.updateMatrixWorld();
    var right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    var up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    var fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
    var w = { right: right, left: right.clone().negate(), up: up, down: up.clone().negate(), away: fwd, near: fwd.clone().negate() }[key] || right;
    var inv = new THREE.Matrix4().copy(p.mesh.matrixWorld).invert();
    var l = w.clone().transformDirection(inv);
    return rawDirFromLocal([l.x, l.y, l.z]);
  }

  function placedOf(m) {
    if (!m || !state.placed) return null;
    return state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; }) || null;
  }

  /* ---- what the hover shows: the loop a grab would take and the limb below it ---- */
  function rawToWorld(pl, f, r) {
    var l = localFromRaw(f, r);
    return pl.mesh.localToWorld(new THREE.Vector3(l[0], l[1], l[2]));
  }
  function clearMarker() {
    if (!marker) return;
    if (marker.parent) marker.parent.remove(marker);
    marker.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    marker = null; markerKey = '';
  }
  function drawMarker(m, probe, key) {
    clearMarker();
    if (!probe || !probe.ok || typeof THREE === 'undefined' || !state || !state.scene) return;
    var pl = placedOf(m), f = frameOf(m);
    if (!pl || !f) return;
    pl.mesh.updateMatrixWorld();
    var A = probe.A, Q = probe.Q, u = probe.u0;
    var any = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var e1 = [u[1] * any[2] - u[2] * any[1], u[2] * any[0] - u[0] * any[2], u[0] * any[1] - u[1] * any[0]];
    var l1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = e1.map(function (x) { return x / l1; });
    var e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
    var rad = Math.max(0.6, (probe.radius || 1) * 1.35), pts = [];
    for (var i = 0; i < SEGMENTS; i++) {
      var a = i / SEGMENTS * Math.PI * 2, c = Math.cos(a) * rad, s = Math.sin(a) * rad;
      pts.push(rawToWorld(pl, f, [A[0] + e1[0] * c + e2[0] * s, A[1] + e1[1] * c + e2[1] * s, A[2] + e1[2] * c + e2[2] * s]));
    }
    var mat = function (op) { return new THREE.LineBasicMaterial({ color: MARK_COLOR, depthTest: false, transparent: true, opacity: op }); };
    var ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat(1));
    var wa = rawToWorld(pl, f, A), wq = rawToWorld(pl, f, Q);
    // The bone is a thin tube, not a line: a line is one pixel wide and the
    // limb is ten, so it would vanish into the surface it runs along.
    var axis = wa.clone().sub(wq), boneLen = axis.length();
    var bone = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(0.12, rad * 0.12), Math.max(0.12, rad * 0.12), boneLen, 8, 1),
      new THREE.MeshBasicMaterial({ color: MARK_COLOR, depthTest: false, transparent: true, opacity: 0.85 }));
    bone.position.copy(wq).add(wa).multiplyScalar(0.5);
    bone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    var dot = function (p, col, r) {
      var d = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 1 }));
      d.position.copy(p); d.renderOrder = MARK_ORDER + 1; return d;
    };
    marker = new THREE.Group();
    ring.renderOrder = MARK_ORDER + 1; bone.renderOrder = MARK_ORDER;
    marker.add(ring); marker.add(bone);
    marker.add(dot(wa, MARK_COLOR, Math.max(0.55, rad * 0.45)));       // the handle: where the cursor takes hold
    marker.add(dot(wq, HINGE_COLOR, Math.max(0.45, rad * 0.35)));      // the hinge: where the limb meets its fork
    nsoHelpers.attach(state.scene, marker, 'limb');
    markerKey = key;
  }

  function ctxFor(m) {
    if (cache.tris !== m.rawTris) cache = { tris: m.rawTris, ctx: NSO_Limb.context(m.rawTris) };
    return cache.ctx;
  }

  /* ---- picking ---- */
  function pick(event) {
    if (!state || !state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent !== 'function') return null;
    setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.faceIndex == null || !h.face) continue;
      var obj = h.object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx !== 'number' || !state.placed[idx]) continue;
      var placed = state.placed[idx];
      var m = state.models.find(function (mm) { return mm.id === placed.sourceId; });
      if (!m || !m.rawTris || m.rawAxis !== 'zup') continue;
      return { hit: h, placed: placed, idx: idx, m: m, mesh: placed.mesh };
    }
    return null;
  }
  /* The pressed point in the piece's raw frame. */
  function rawHit(p) {
    var f = frameOf(p.m);
    if (!f) return null;
    p.mesh.updateMatrixWorld();
    var lp = p.mesh.worldToLocal(p.hit.point.clone());
    return { frame: f, point: rawPointFromLocal(f, [lp.x, lp.y, lp.z]) };
  }

  /* ---- the live preview, written straight from the indexed mesh (Pull's, verbatim in idea):
     the centring is captured once at the press and held for the whole drag, so
     the piece does not slide out from under the cursor as its extent changes;
     the commit goes through the normal path and re-centres properly. */
  function writeDisplay(s, verts) {
    var S = s.S, mesh = S.mesh, pos = S.pos, c = s.frame.c, arr = s.disp, tri = mesh.tri;
    function tri9(t) {
      var o = t * 9;
      for (var v = 0; v < 3; v++) {
        var i = tri[t * 3 + v] * 3, q = o + v * 3;
        arr[q] = pos[i] - c[0];
        arr[q + 1] = pos[i + 2] - c[1];
        arr[q + 2] = -pos[i + 1] - c[2];
      }
    }
    var t;
    if (!verts) { for (t = 0; t < mesh.triCount; t++) tri9(t); return; }
    s.drawStamp++;
    for (var i = 0; i < verts.length; i++) {
      var v2 = verts[i];
      for (var j = S.vtStart[v2]; j < S.vtStart[v2 + 1]; j++) {
        var t2 = S.vtList[j];
        if (s.triSeen[t2] === s.drawStamp) continue;
        s.triSeen[t2] = s.drawStamp;
        tri9(t2);
      }
    }
  }
  function makePreviewGeometry(s) {
    var geo = new THREE.BufferGeometry();
    // BufferAttribute, not Float32BufferAttribute: that one COPIES the array, and
    // every later write to s.disp would be to a buffer the GPU never sees.
    geo.setAttribute('position', new THREE.BufferAttribute(s.disp, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
  function redraw(s) {
    var attr = s.previewGeo.getAttribute('position');
    attr.needsUpdate = true;
    s.previewGeo.computeVertexNormals();
    s.previewGeo.computeBoundingSphere();
  }
  /* An announcement the watch log can hear (nso-watch.js). */
  function note(phase, s, why) {
    try {
      window.dispatchEvent(new CustomEvent('nso:op', { detail: {
        phase: phase, op: 'limb', model: s && s.m ? s.m.id : null, reason: why || null } }));
    } catch (e) { /* never let the announcement touch the drag */ }
  }

  /* ---- where the cursor has taken the grab: the plane through the pressed
     point, square to the camera; the cursor's ray meets it. */
  function cursorRay(event) {
    setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster.ray;
  }
  function displacementWorld(s, event) {
    var P0 = s.pressWorld, ray = cursorRay(event);
    var camDir = new THREE.Vector3();
    state.camera.getWorldDirection(camDir);
    var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, P0);
    var hit = new THREE.Vector3();
    if (!ray.intersectPlane(plane, hit)) return new THREE.Vector3();
    return hit.sub(P0);
  }
  function rawDisplacement(s, vWorld) {
    var l0 = s.mesh.worldToLocal(s.pressWorld.clone());
    var l1 = s.mesh.worldToLocal(s.pressWorld.clone().add(vWorld));
    return rawDirFromLocal([l1.x - l0.x, l1.y - l0.y, l1.z - l0.z]);
  }
  function modeOf(event) {
    if (event && event.shiftKey) return 'extend';
    if (event && event.altKey) return 'bend';
    return mode;
  }
  var MODE_WORDS = { free: 'stretch + bend', extend: 'extend only', bend: 'bend only', numbers: 'by the numbers' };

  /* ---- the grab ---- */
  function revert(s, text, bad) {
    note('discard', s, text);
    if (s.mesh && s.origGeometry) s.mesh.geometry = s.origGeometry;
    if (s.previewGeo) { s.previewGeo.dispose(); s.previewGeo = null; }
    if (text) { say(text, bad !== false); readout(text, bad !== false); }
  }
  function releaseControls(event) {
    if (state.controls) state.controls.enabled = true;
    try {
      if (event && event.target && event.target.releasePointerCapture && event.pointerId != null)
        event.target.releasePointerCapture(event.pointerId);
    } catch (e) { /* the capture may already be gone */ }
  }
  function ready() {
    if (typeof NSO_Limb === 'undefined' || typeof NSO_Densify === 'undefined') {
      say('Limb needs nso_limb.js and nso_densify.js - nothing changed', true);
      return false;
    }
    return true;
  }

  function beginGrab(pd, event) {
    var p = pd.p, m = p.m;
    if (!ready()) return false;
    var h = rawHit(p);
    if (!h) { say('Limb needs a raw piece - split, wrap or boolean it first', true); return false; }
    var ctx = ctxFor(m);
    var S = NSO_Limb.prepare(m.rawTris, h.point, { ctx: ctx, reach: reach() });
    if (!S.ok) { say('Limb refused - ' + S.reason + ' - piece unchanged', true); readout('Limb refused - ' + S.reason, true); return false; }
    p.mesh.updateMatrixWorld();
    session = {
      m: m, mesh: p.mesh, idx: p.idx, frame: h.frame, S: S,
      origGeometry: p.mesh.geometry, previewGeo: null,
      pressWorld: p.hit.point.clone(),
      disp: new Float32Array(S.mesh.triCount * 9), triSeen: new Int32Array(S.mesh.triCount), drawStamp: 1,
      D: [0, 0, 0], how: mode, moves: 0
    };
    writeDisplay(session);
    session.previewGeo = makePreviewGeometry(session);
    p.mesh.geometry = session.previewGeo;
    note('preview', session);
    clearMarker();
    var dens = NSO_Densify.say(S.densify);
    var txt = 'Limb - ' + NSO_Limb.describe(S) + (S.reachClipped ? ' (reach cut to the fork)' : '') + '; ' + dens +
              '. Drag to move it; Shift extends only, Alt bends only; release to set, Esc to cancel';
    say(txt); readout(txt);
    return true;
  }

  function sayMove(s, r) {
    var txt = 'Limb (' + MODE_WORDS[s.how] + '): ' + (r.angleDeg > 0.05 ? 'bent ' + round(r.angleDeg, 1).toFixed(1) + '°' : 'straight') +
      ', ' + (r.ext >= 0 ? '+' : '') + round(r.ext, 2).toFixed(2) + ' mm' +
      (r.clampedAngle ? ' - bend capped at ' + round(r.maxAngle * 180 / Math.PI, 0).toFixed(0) + '° by this limb\'s width' : '') +
      (r.clampedLen ? ' - shortening stops at ' + Math.round(NSO_Limb.MIN_ZONE_FRAC * 100) + '% of the zone' : '') +
      ' - release to set, Esc to cancel';
    say(txt); readout(txt);
  }
  function updateGrab(event) {
    var s = session;
    s.D = rawDisplacement(s, displacementWorld(s, event));
    s.how = modeOf(event);
    var r = NSO_Limb.displaceTo(s.S, s.D, s.how);
    s.last = r;
    writeDisplay(s, s.S.touched);
    redraw(s);
    s.moves++;
    sayMove(s, r);
  }

  /* PAINT SCOPE: SUB-REGION - see the header. */
  function paintStandDown(m, S) {
    var planes = (typeof nsoMaskPlaneList === 'function') ? nsoMaskPlaneList(m) : [];
    if (!planes || !planes.length || typeof NSO_brushPaintCheck !== 'function') return null;
    var pts = [];
    for (var i = 0; i < S.touched.length; i++) {
      var o = S.touched[i] * 3;
      pts.push(S.basePos[o], S.basePos[o + 1], S.basePos[o + 2], S.pos[o], S.pos[o + 1], S.pos[o + 2]);
    }
    var chk = NSO_brushPaintCheck(planes, new Float64Array(pts));
    if (!chk.any) return null;
    var names = chk.painted.map(function (pl) { return NSO_brushPaintName(pl); });
    return 'Limb stood down - ' + chk.painted.length + ' painted face(s); the limb reaches ' +
      names.join(', ') + '. Limb moves those vertices, so it cannot hold that face still. ' +
      'Clear the paint there, or grab a limb that does not reach it (paint elsewhere on the piece does not stop it).';
  }

  /* The guards, the commit and the words, for a drag and for the numbers alike.
     `s` carries m, mesh, S, how, last and (a drag only) the preview to put away. */
  function settle(s) {
    var S = s.S, r = s.last;
    if (!r || (Math.abs(r.ext) < 1e-6 && r.angleDeg < 1e-4)) { revert(s, 'Limb: the limb did not move - piece unchanged', false); return false; }
    var stand = paintStandDown(s.m, S);
    if (stand) { revert(s, stand, true); return false; }
    var res;
    try { res = NSO_Limb.finish(S, { repair: window.NSO_Repair }); }
    catch (err) { revert(s, 'Limb refused - the checks threw (' + ((err && err.message) || err) + ') - piece unchanged', true); return false; }
    if (!res.ok) { revert(s, 'Limb refused - ' + res.reason + ' - piece unchanged', true); return false; }
    // The original geometry goes back before the commit, so the undo entry
    // carries the piece as it was and not the throwaway preview.
    if (s.mesh && s.origGeometry) s.mesh.geometry = s.origGeometry;
    if (s.previewGeo) { s.previewGeo.dispose(); s.previewGeo = null; }
    var rep = res.report;
    var txt = 'Limb set - ' + (rep.angleDeg > 0.05 ? 'bent ' + round(rep.angleDeg, 1).toFixed(1) + '°, ' : '') +
      (rep.extend >= 0 ? 'extended ' : 'shortened ') + round(Math.abs(rep.extend), 2).toFixed(2) + ' mm' +
      ' (' + MODE_WORDS[s.how] + '); ' + rep.moved + ' vertices moved, the limb\'s ' + round(rep.zone, 1) + ' mm flex zone' +
      (rep.reach < rep.zone - 1e-9 ? ' held to its last ' + round(rep.reach, 1) + ' mm' : '') +
      '; ' + NSO_Densify.say(rep.densify) +
      '; self-intersections ' + rep.pierce.before + '→' + rep.pierce.after +
      '; tris ' + rep.trisBefore + '→' + rep.trisAfter + '. One Undo puts it back.';
    var done = (typeof NSO_sculptCommitRaw === 'function')
      ? NSO_sculptCommitRaw(s.m, res.tris, 'limbReplace', txt) : false;
    if (done === false) { say('Limb has nowhere to commit - app-sculpt.js is not loaded', true); return false; }
    /* For the checks (tools/nso_limb_drive_check.js): what the last move was. */
    window.nsoLimbLast = { report: rep, last: r, how: s.how, status: txt, S: S };
    readout(txt);
    selected = null;
    clearMarker();
    setLabel();
    return true;
  }

  function endGrab(commit, event) {
    var s = session;
    session = null; pending = null;
    releaseControls(event);
    if (!s) return;
    if (!commit) { revert(s, 'Limb cancelled - piece unchanged', false); return; }
    settle(s);
  }

  /* ---- the numbers: the picked limb, moved by what the panel says ---- */
  function applyNumbers() {
    if (!armed || !selected || session) return;
    if (!ready()) return;
    var m = state.models.find(function (x) { return x && x.id === selected.modelId; });
    var p = placedOf(m);
    if (!m || !p || !m.rawTris) { say('Limb: the picked limb is gone - pick it again', true); selected = null; setLabel(); return; }
    var ext = parseFloat((el('inp-limb-ext') || {}).value), bend = parseFloat((el('inp-limb-bend') || {}).value);
    if (!isFinite(ext)) ext = 0;
    if (!isFinite(bend)) bend = 0;
    if (ext === 0 && bend === 0) { readout('Type an Extend (mm, negative shortens) and/or a Bend (degrees) first.', true); return; }
    var S = NSO_Limb.prepare(m.rawTris, selected.point, { ctx: ctxFor(m), reach: reach() });
    if (!S.ok) { say('Limb refused - ' + S.reason + ' - piece unchanged', true); readout('Limb refused - ' + S.reason, true); return; }
    p.mesh.updateMatrixWorld();
    var r = NSO_Limb.displaceBy(S, ext, bend, leanRaw({ mesh: p.mesh }));
    var s = { m: m, mesh: p.mesh, S: S, how: 'numbers', last: r, origGeometry: null, previewGeo: null };
    if (r.clampedAngle) say('Limb: the bend was capped at ' + round(r.maxAngle * 180 / Math.PI, 0).toFixed(0) + '° by this limb\'s width');
    settle(s);
  }

  /* ---- pointer events ---- */
  window.nsoLimbTakesPointer = function (event) {
    if (!armed || !event || event.button !== 0) return false;
    if (state.cutterOpen || state.joinSession) return false;
    return !!pick(event);
  };

  function onDown(event) {
    if (!armed || event.button !== 0) return;
    if (state.cutterOpen || state.joinSession) return;
    var p = pick(event);
    if (!p) return;
    event.stopPropagation();
    event.preventDefault();
    if (typeof selectPlaced === 'function' && p.m.id !== state.editId) selectPlaced(p.idx);
    if (p.m.nsoSupport) {
      var t = 'Limb refused - that is a support piece; supports are generated, not sculpted. Grab the piece it holds up instead - piece unchanged';
      say(t, true); readout(t, true);
      return;
    }
    pending = { p: p, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    if (state.controls) state.controls.enabled = false;
    try { if (event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId); } catch (e) { /* synthetic */ }
  }

  function showHover(p) {
    if (!ready()) return;
    var key = p.m.id + ':' + p.hit.faceIndex + ':' + p.m.rawTris.length;
    if (key === markerKey && marker) return;
    var h = rawHit(p);
    if (!h) return;
    var ctx = ctxFor(p.m);
    if (!ctx || !ctx.ok) { clearMarker(); return; }
    drawMarker(p.m, NSO_Limb.probe(ctx, h.point), key);
  }
  function showSelected() {
    if (!selected) { clearMarker(); return; }
    var m = state.models.find(function (x) { return x && x.id === selected.modelId; });
    if (!m || !ready()) return;
    var ctx = ctxFor(m);
    if (ctx && ctx.ok) drawMarker(m, NSO_Limb.probe(ctx, selected.point), 'sel');
  }

  function onMove(event) {
    if (!armed) return;
    if (session) { updateGrab(event); return; }
    if (pending) {
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < DRAG_PX) return;
      var pd = pending;
      pending = null;
      if (!beginGrab(pd, event)) { releaseControls(event); return; }
      updateGrab(event);
      return;
    }
    var p = pick(event);
    if (!p) { showSelected(); return; }
    showHover(p);
  }

  function onUp(event) {
    if (session) { endGrab(true, event); return; }
    if (pending) {
      var pd = pending;
      pending = null;
      releaseControls(event);
      var h = rawHit(pd.p);
      if (!h) return;
      selected = { modelId: pd.p.m.id, point: h.point };
      showSelected();
      setLabel();
      var txt = 'Limb picked - type an Extend and/or a Bend in the panel and press Apply, or drag it';
      say(txt); readout(txt);
    }
  }
  function onCancel(event) {
    if (session) { endGrab(false, event); return; }
    if (pending) { pending = null; releaseControls(event); }
  }

  /* ---- arming: one armed tool at a time, through the button, as Pull does ---- */
  function disarmOthers() {
    if (state.maskPaint) {
      var paintBtn = el(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      var brushBtn = el('btn-brush');
      if (brushBtn) brushBtn.click();
      else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (typeof window.nsoPullArmed === 'function' && window.nsoPullArmed()) {
      var pullBtn = el('btn-pull');
      if (pullBtn) pullBtn.click();
      else if (typeof window.nsoPullSetArmed === 'function') window.nsoPullSetArmed(false);
    }
    if (state.carveArmed) {
      var carveBtn = el('btn-carve');
      if (carveBtn) carveBtn.click(); else state.carveArmed = false;
    }
    if (state.measureOn) {
      var measureBtn = el('btn-measure');
      if (measureBtn) measureBtn.click(); else state.measureOn = false;
    }
    if (state.seatHereArmed) {
      var seatBtn = el('btn-seat-here');
      if (seatBtn) seatBtn.click(); else state.seatHereArmed = false;
    }
    if (state.centerLockArmed) {
      var clockBtn = el('btn-center-lock-pick');
      if (clockBtn) clockBtn.click(); else state.centerLockArmed = false;
    }
    if (window.nsoFoam && window.nsoFoam.on && window.nsoFoam.on()) window.nsoFoam.cancel();
    ['btn-bend', 'btn-tube-edge'].forEach(function (id) {
      var b = el(id);
      if (b && b.getAttribute('aria-expanded') === 'true') b.click();
    });
    state.softenArmed = false;
    state.capArmed = false;
    if (typeof clearFacePick === 'function') clearFacePick();
  }

  function enter() {
    var m = model();
    if (!m || !m.rawTris || m.rawAxis !== 'zup') {
      say('Limb needs a raw piece - select one (split, wrap or boolean it first if it is not)', true);
      return;
    }
    armed = true;
    disarmOthers();
    setLabel();
    syncReach();
    var txt = 'Limb armed. Hover a branch to see what a grab would take; press and drag it to stretch and bend it ' +
              '(Shift: extend only, Alt: bend only); click to pick it for the numbers. Click the button again to stop';
    say(txt); readout('Press and drag a branch: the ring under the press follows the cursor and everything beyond it rides along.');
  }
  function exit() {
    if (session) endGrab(false);
    pending = null;
    releaseControls();
    armed = false;
    selected = null;
    clearMarker();
    cache = { tris: null, ctx: null };
    if (window.nsoLimbLast) window.nsoLimbLast.S = null;
    setLabel();
    say('Limb off');
  }
  function toggle() { if (armed) exit(); else enter(); }

  window.nsoLimbArmed = function () { return armed; };
  window.nsoLimbSetArmed = function (on) { if (!!on !== armed) toggle(); };
  /* For the checks: what Limb is holding right now. */
  window.nsoLimbState = function () {
    return { armed: armed, dragging: !!session, mode: mode, picked: !!selected, marker: !!marker,
             reach: reach(), last: session && session.last ? session.last : null };
  };
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('limb', {
    live: function () { return armed; }, close: exit,
    clear: function () { clearMarker(); },
    refresh: function () { clearMarker(); showSelected(); }
  });

  function bind() {
    var b = el('btn-limb');
    if (b && !b._limbBound) { b.addEventListener('click', toggle); b._limbBound = true; }
    ['free', 'extend', 'bend'].forEach(function (k) {
      var mb = el('btn-limb-mode-' + k);
      if (mb && !mb._limbBound) { mb.addEventListener('click', function () { setMode(k); }); mb._limbBound = true; }
    });
    var rs = el('inp-limb-reach');
    if (rs && !rs._limbBound) { rs.addEventListener('input', syncReach); rs._limbBound = true; }
    var ap = el('btn-limb-apply');
    if (ap && !ap._limbBound) { ap.addEventListener('click', applyNumbers); ap._limbBound = true; }
    var can = el('btn-limb-cancel');
    if (can && !can._limbBound) {
      can.addEventListener('click', function () {
        if (session) endGrab(false);
        else if (selected) { selected = null; clearMarker(); setLabel(); readout('Pick cleared.'); }
        else if (armed) exit();
      });
      can._limbBound = true;
    }
    setMode(mode);
    syncReach();
    setLabel();
    if (!state || !state.renderer || !state.renderer.domElement || state._limbBound) return;
    state._limbBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (session) endGrab(false);
      else if (pending) onCancel();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
