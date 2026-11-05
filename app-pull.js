/* Pull - direct manipulation: grab a spot on a piece and drag it.

   The app layer over nso_pull.js (the field and its guards) and nso_densify.js
   (the subdivision). Full write-up: docs/PULL.md. Shape -> Pull.

   THE GESTURE
     ARM      select a piece, press Pull. The Brush's size slider is the
              falloff radius (1-50 mm, 12 by default); the panel's slider is
              the same value, mirrored.
     CLICK    a plain click on the piece drops a PIN: a spot that holds still.
              Pins are drawn as a small red anchor with their radius, stay
              until Clear pins or until Pull is left, and each keeps the radius
              the slider had when it was placed.
     DRAG     press-and-drag a spot to GRAB it. After the first few pixels the
              triangles under the grab are densified to 0.5 mm (once, reported
              in the status line) and the real mesh follows the cursor, live:
              the grab moves in the VIEW PLANE (the plane through the grab,
              square to the camera), or with Shift held ALONG THE SURFACE
              NORMAL at the grab, in or out.
     THIS SIDE ONLY  a checkbox, off by default. Off: a wall moves as one
              section (each vertex paired with the one through the wall, both
              moving by the same amount). On: the falloff is measured along the
              surface and only the skin under the grab moves. Read at the press.
     RELEASE  is Set. One Undo step. There is no Set button.
     ESCAPE   mid-drag puts the piece back exactly. Cancel does the same and
              leaves the tool; Clear pins takes the pins off.

   THE PREVIEW IS NOT A COMMIT. During the drag the placed mesh is shown a
   throwaway geometry; m.geometry and m.rawTris are untouched. A refused pull,
   a cancelled one and a lost pointer all end by putting the original geometry
   back. Only a pull that clears the guards is committed, through
   NSO_sculptCommitRaw - the same commit the Brush, Smooth and Foam use.

   PAINT SCOPE: SUB-REGION (docs/HANDOFF.md, "Scoping"). Pull moves the
   vertices inside the grab's radius and nothing else, so it checks only the
   painted faces those vertices lie on; paint elsewhere on the piece does not
   stop it. A vertex lying ON an excluded plane counts as touching that face.
   The planes come from nsoMaskPlaneList (read, never re-derived), and the test
   is the Brush's own NSO_brushPaintCheck. OPERAND: NONE - the operand is a
   gesture, so the SELECT list is never read; the EXCLUDE list always is.
   NON-SOLID: not read - Pull moves vertices and neither opens nor closes an
   edge, so a piece flagged non-solid is pulled like any other.

   A SUPPORT PIECE (m.nsoSupport) is refused at the press: supports are
   generated, not sculpted. Out of scope: twisting, other falloff shapes,
   pulling across two pieces, and undo of individual pins.
*/
if (typeof document !== 'undefined') (function () {
  'use strict';

  var DRAG_PX = 4;                // a press that moves less than this is a click
  var SEGMENTS = 64;
  var RING_ORDER = 60;
  var PIN_ORDER = 62;
  var PIN_MM = 0.9;               // the anchor's radius, mm
  var RING_COLOR = 0x38bdf8, PIN_COLOR = 0xff4d4d;

  var armed = false;
  var pending = null;             // a press that is not yet a click or a drag
  var session = null;            // the live grab
  var pins = [];                 // { c:[raw], n:[raw normal], r }
  var pinModel = null;
  var ring = null, ringVisible = false;
  var pinGroup = null;
  var pinPose = '';              // the piece's world matrix when the anchors were drawn

  function model() { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
  function say(t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); }
  function el(id) { return document.getElementById(id); }
  function round(v, n) { var k = Math.pow(10, n || 2); return Math.round(v * k) / k; }

  /* ---- raw <-> local, measured off the piece the way app-brush.js does it:
     the display mesh is the raw soup turned -90 deg about X and centred on its
     bounding box, so the transform is fixed apart from that centring. */
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
  function localDirFromRaw(v) { return [v[0], v[2], -v[1]]; }

  /* ---- the controls ---- */
  function brushSlider() { return el('inp-brush-size'); }
  function radius() {
    var b = brushSlider(), r = b ? parseFloat(b.value) : 12;
    return (r > 0) ? Math.min(50, Math.max(1, r)) : 12;
  }
  function syncSize(from) {
    var b = brushSlider(), p = el('inp-pull-size');
    if (from === 'pull' && b && p) {
      b.value = p.value;
      b.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (b && p) p.value = b.value;
    var o = el('out-pull-size');
    if (o) o.textContent = radius().toFixed(0) + ' mm';
    if (ring && ringVisible && !session) buildRing(radius());
  }
  /* "This side only", read when a grab begins (not mid-drag). */
  function sideOnly() { var c = el('chk-pull-side'); return !!(c && c.checked); }
  function modeWords(s) {
    return s.S.mode === 'side' ? 'this side only' : (s.S.partnered ? 'wall as one section, ' + s.S.partnered + ' paired' : 'no wall under it');
  }
  function readout(text, bad) {
    var r = el('pull-readout');
    if (!r) return;
    r.textContent = text;
    r.classList.toggle('is-bad', !!bad);
  }
  function setLabel() {
    var b = el('btn-pull');
    if (b) {
      b.classList.toggle('is-armed', armed);
      b.setAttribute('aria-pressed', armed ? 'true' : 'false');
      b.setAttribute('aria-expanded', armed ? 'true' : 'false');
      b.textContent = armed ? 'Pull: on' : 'Pull';
    }
    var pnl = el('pull-panel');
    if (pnl) pnl.hidden = !armed;
    var c = el('btn-pull-clear');
    if (c) c.disabled = !pins.length;
  }

  /* ---- helpers drawn in the scene: the radius ring and the pins ---- */
  function placedOf(m) {
    if (!m || !state.placed) return null;
    return state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; }) || null;
  }
  function ringGeometry(rad) {
    var pts = [];
    for (var i = 0; i < SEGMENTS; i++) {
      var a = (i / SEGMENTS) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * rad, Math.sin(a) * rad, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }
  function buildRing(rad) {
    if (typeof THREE === 'undefined' || !state || !state.scene) return;
    var geo = ringGeometry(rad);
    if (!ring) {
      ring = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
        color: RING_COLOR, depthTest: false, transparent: true, opacity: 0.9 }));
      ring.renderOrder = RING_ORDER;
      ring.visible = false;
    } else {
      if (ring.geometry) ring.geometry.dispose();
      ring.geometry = geo;
    }
    if (ring.parent !== state.scene) nsoHelpers.attach(state.scene, ring, 'pull');
  }
  function placeRing(point, normalWorld, rad) {
    buildRing(rad);
    if (!ring) return;
    ring.position.copy(point).addScaledVector(normalWorld, 0.05);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normalWorld.clone().normalize());
    ring.visible = true;
    ringVisible = true;
  }
  function hideRing() { if (ring) ring.visible = false; ringVisible = false; }
  // Out of the scene altogether: leaving the tool leaves nothing of it behind.
  function dropRing() {
    hideRing();
    if (!ring) return;
    if (ring.parent) ring.parent.remove(ring);
    if (ring.geometry) ring.geometry.dispose();
    if (ring.material) ring.material.dispose();
    ring = null;
  }

  function clearPinMarks() {
    if (!pinGroup) return;
    if (pinGroup.parent) pinGroup.parent.remove(pinGroup);
    pinGroup.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    pinGroup = null;
  }
  /* Redraw every pin from its RAW position, through the piece's current frame
     and pose: a commit swaps the mesh and re-centres it, an Undo swaps it
     back, and either leaves a marker placed from the old frame in the wrong
     place. Raw coordinates are what a pin keeps. */
  function drawPins() {
    clearPinMarks();
    var b = el('btn-pull-clear');
    if (b) b.disabled = !pins.length;
    if (!armed || !pins.length || typeof THREE === 'undefined' || !state || !state.scene) return;
    var m = state.models.find(function (x) { return x && x.id === pinModel; });
    var pl = placedOf(m), f = frameOf(m);
    if (!pl || !f) return;
    pl.mesh.updateMatrixWorld();
    pinPose = pl.mesh.matrixWorld.elements.join(',');
    pinGroup = new THREE.Group();
    pins.forEach(function (pn) {
      var lc = localFromRaw(f, pn.c);
      var wp = pl.mesh.localToWorld(new THREE.Vector3(lc[0], lc[1], lc[2]));
      var ln = localDirFromRaw(pn.n);
      var wn = new THREE.Vector3(ln[0], ln[1], ln[2]).transformDirection(pl.mesh.matrixWorld).normalize();
      var dot = new THREE.Mesh(new THREE.SphereGeometry(PIN_MM, 14, 10),
        new THREE.MeshBasicMaterial({ color: PIN_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
      dot.position.copy(wp);
      dot.renderOrder = PIN_ORDER;
      var rg = new THREE.LineLoop(ringGeometry(pn.r),
        new THREE.LineBasicMaterial({ color: PIN_COLOR, depthTest: false, transparent: true, opacity: 0.45 }));
      rg.position.copy(wp).addScaledVector(wn, 0.05);
      rg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), wn);
      rg.renderOrder = PIN_ORDER - 1;
      pinGroup.add(dot); pinGroup.add(rg);
    });
    nsoHelpers.attach(state.scene, pinGroup, 'pull');
  }
  function clearPins(why) {
    var n = pins.length;
    pins = []; pinModel = null;
    clearPinMarks();
    var b = el('btn-pull-clear');
    if (b) b.disabled = true;
    if (why && n) say('Pull: ' + n + ' pin' + (n === 1 ? '' : 's') + ' cleared');
    return n;
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

  /* The pressed point and surface normal, in the piece's raw frame. */
  function rawHit(p) {
    var f = frameOf(p.m);
    if (!f) return null;
    p.mesh.updateMatrixWorld();
    var lp = p.mesh.worldToLocal(p.hit.point.clone());
    var ln = p.hit.face.normal.clone().normalize();
    return {
      frame: f,
      point: rawPointFromLocal(f, [lp.x, lp.y, lp.z]),
      normal: rawDirFromLocal([ln.x, ln.y, ln.z]),
      normalWorld: ln.clone().transformDirection(p.mesh.matrixWorld).normalize()
    };
  }

  /* ---- the live preview, written straight from the indexed mesh ----
     The centring is captured once at the press and held for the whole drag, so
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
    /* BufferAttribute, not Float32BufferAttribute: that one COPIES the array it
       is handed, and then every write to s.disp below would be to a buffer the
       GPU never sees - the status line would say 6 mm and the piece would sit
       still. This one holds s.disp itself. */
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

  /* An announcement the watch log can hear (nso-watch.js), as the Brush's. */
  function note(phase, s, why) {
    try {
      window.dispatchEvent(new CustomEvent('nso:op', { detail: {
        phase: phase, op: 'pull', model: s && s.m ? s.m.id : null, reason: why || null } }));
    } catch (e) { /* never let the announcement touch the drag */ }
  }

  /* ---- where the cursor has taken the grab ----
     VIEW PLANE: the plane through the pressed point, square to the camera; the
     cursor's ray meets it, and the grab's displacement is that point minus the
     pressed one. SHIFT: the displacement is along the surface normal, by the
     amount that puts the grab's screen position nearest the cursor. */
  function cursorRay(event) {
    setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster.ray;
  }
  function toScreen(v, rect) {
    var q = v.clone().project(state.camera);
    return { x: rect.left + (q.x + 1) / 2 * rect.width, y: rect.top + (1 - q.y) / 2 * rect.height };
  }
  function displacementWorld(s, event) {
    var P0 = s.pressWorld;
    if (event.shiftKey) {
      var rect = state.renderer.domElement.getBoundingClientRect();
      var a = toScreen(P0, rect), b = toScreen(P0.clone().add(s.normalWorld), rect);
      var nx = b.x - a.x, ny = b.y - a.y;                    // px per mm along the normal
      var dx = event.clientX - s.startX, dy = event.clientY - s.startY;
      var cam = state.camera.position.clone().sub(P0).normalize();
      var len2 = nx * nx + ny * ny;
      var ppm = s.pxPerMm;
      var sMm;
      if (len2 > Math.pow(0.35 * ppm, 2)) sMm = (dx * nx + dy * ny) / len2;
      else sMm = -dy / ppm * (s.normalWorld.dot(cam) >= 0 ? 1 : -1);   // looking down the normal: up is out
      return s.normalWorld.clone().multiplyScalar(sMm);
    }
    var ray = cursorRay(event);
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

  function beginGrab(pd, event) {
    var p = pd.p, m = p.m;
    if (typeof NSO_Pull === 'undefined' || typeof NSO_Densify === 'undefined') {
      say('Pull needs nso_pull.js and nso_densify.js - nothing changed', true);
      return false;
    }
    var h = rawHit(p);
    if (!h) { say('Pull needs a raw piece - split, wrap or boolean it first', true); return false; }
    var engPins = pins.filter(function () { return pinModel === m.id; })
                      .map(function (pn) { return { c: pn.c.slice(), r: pn.r }; });
    var rad = radius();
    var side = sideOnly();
    var S = NSO_Pull.prepare(m.rawTris, { c: h.point, r: rad }, engPins, { nozzle: 0.4, sideOnly: side });
    if (!S.ok) { say('Pull refused - ' + S.reason + ' - piece unchanged', true); return false; }

    var rect = state.renderer.domElement.getBoundingClientRect();
    var a = toScreen(p.hit.point, rect);
    var rightV = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0);
    var b = toScreen(p.hit.point.clone().add(rightV), rect);
    p.mesh.updateMatrixWorld();
    session = {
      m: m, mesh: p.mesh, idx: p.idx, frame: h.frame, S: S, radius: rad, side: side,
      origGeometry: p.mesh.geometry, previewGeo: null,
      pressWorld: p.hit.point.clone(), normalWorld: h.normalWorld, normalRaw: h.normal,
      startX: pd.x, startY: pd.y,
      pxPerMm: Math.max(0.5, Math.hypot(b.x - a.x, b.y - a.y)),
      disp: new Float32Array(S.mesh.triCount * 9), triSeen: new Int32Array(S.mesh.triCount), drawStamp: 1,
      D: [0, 0, 0], shift: false, moves: 0
    };
    writeDisplay(session);
    session.previewGeo = makePreviewGeometry(session);
    p.mesh.geometry = session.previewGeo;
    note('preview', session);
    hideRing();
    var dens = NSO_Densify.say(S.densify) + ' (' + modeWords(session) + ')';
    say('Pull - ' + dens + '; drag to pull (Shift: along the normal), release to set, Esc to cancel');
    readout(dens.charAt(0).toUpperCase() + dens.slice(1) + '. ' + engPins.length + ' pin' +
            (engPins.length === 1 ? '' : 's') + ' hold.');
    return true;
  }

  function updateGrab(event) {
    var s = session;
    var vWorld = displacementWorld(s, event);
    var D = rawDisplacement(s, vWorld);
    s.shift = !!event.shiftKey;
    s.D = D;
    NSO_Pull.displace(s.S, D);
    writeDisplay(s, s.S.zone);
    redraw(s);
    s.moves++;
    var mm = Math.hypot(D[0], D[1], D[2]);
    var txt = 'Pulling ' + round(mm, 2).toFixed(2) + ' mm ' + (s.shift ? 'along the normal' : 'in the view plane') +
              ' (' + modeWords(s) + ') - release to set, Esc to cancel';
    say(txt); readout(txt);
  }

  /* PAINT SCOPE: SUB-REGION - see the header. The vertices that move are the
     whole affected set; they are tested against the excluded planes both where
     they were and where they went. */
  function paintStandDown(s) {
    var planes = (typeof nsoMaskPlaneList === 'function') ? nsoMaskPlaneList(s.m) : [];
    if (!planes || !planes.length || typeof NSO_brushPaintCheck !== 'function') return null;
    var S = s.S, pts = [];
    for (var i = 0; i < S.moved.length; i++) {
      var o = S.moved[i] * 3;
      pts.push(S.basePos[o], S.basePos[o + 1], S.basePos[o + 2], S.pos[o], S.pos[o + 1], S.pos[o + 2]);
    }
    var chk = NSO_brushPaintCheck(planes, new Float64Array(pts));
    if (!chk.any) return null;
    var names = chk.painted.map(function (pl) { return NSO_brushPaintName(pl); });
    return 'Pull stood down - ' + chk.painted.length + ' painted face(s); the grab reaches ' +
      names.join(', ') + '. Pull moves those vertices, so it cannot hold that face still. ' +
      'Clear the paint there, or pull somewhere else (paint elsewhere on the piece does not stop it).';
  }

  function endGrab(commit, event) {
    var s = session;
    session = null; pending = null;
    releaseControls(event);
    if (!s) return;

    if (!commit) { revert(s, 'Pull cancelled - piece unchanged', false); return; }
    var D = s.D;
    if (!(Math.hypot(D[0], D[1], D[2]) > 1e-6)) { revert(s, 'Pull: the grab did not move - piece unchanged', false); return; }

    var stand = paintStandDown(s);
    if (stand) { revert(s, stand, true); return; }

    var R = (typeof window !== 'undefined') ? window.NSO_Repair : null;
    var res;
    try { res = NSO_Pull.finish(s.S, D, { repair: R }); }
    catch (err) { revert(s, 'Pull refused - the checks threw (' + ((err && err.message) || err) + ') - piece unchanged', true); return; }
    if (!res.ok) { revert(s, 'Pull refused - ' + res.reason + ' - piece unchanged', true); return; }

    // The original geometry goes back before the commit, so the undo entry
    // carries the piece as it was and not the throwaway preview.
    if (s.mesh && s.origGeometry) s.mesh.geometry = s.origGeometry;
    if (s.previewGeo) { s.previewGeo.dispose(); s.previewGeo = null; }

    var rep = res.report, mm = Math.hypot(D[0], D[1], D[2]);
    var txt = 'Pull set - ' + round(mm, 2).toFixed(2) + ' mm ' + (s.shift ? 'along the normal' : 'in the view plane') +
      ', ' + rep.moved + ' vertices moved over a ' + s.radius.toFixed(0) + ' mm radius' +
      (s.S.pins.length ? ', ' + s.S.pins.length + ' pin' + (s.S.pins.length === 1 ? '' : 's') : '') +
      ' (' + modeWords(s) + ')' +
      '; ' + NSO_Densify.say(rep.densify) +
      (rep.wall && rep.wall.thinnest != null
        ? '; thinnest wall under the move ' + round(rep.wall.thinnest, 3) + ' mm (floor ' + round(rep.wall.floor, 3) +
          ', ' + rep.wall.stations + ' stations' + (rep.wall.every > 1 ? ', every ' + rep.wall.every + 'th vertex' : '') + ')'
        : '') +
      '; self-intersections ' + rep.pierce.before + '→' + rep.pierce.after +
      '; tris ' + rep.trisBefore + '→' + rep.trisAfter + '. One Undo puts it back.';
    var done = (typeof NSO_sculptCommitRaw === 'function')
      ? NSO_sculptCommitRaw(s.m, res.tris, 'pullReplace', txt) : false;
    if (done === false) { say('Pull has nowhere to commit - app-sculpt.js is not loaded', true); return; }
    /* For the checks (tools/nso_pull_drive_check.js): what the last pull was.
       S carries the densified base and the final positions; it is dropped the
       next time a pull is prepared and when Pull is left. */
    window.nsoPullLast = { report: rep, D: D, shift: s.shift, grab: s.S.grab, pins: s.S.pins,
                           radius: s.radius, status: txt, normalRaw: s.normalRaw, S: s.S, side: s.side };
    readout(txt);
    drawPins();                     // the piece was swapped and re-centred: redraw the anchors
    syncSize();
  }

  /* ---- a click is a pin ---- */
  function addPin(pd) {
    var p = pd.p, h = rawHit(p);
    if (!h) { say('Pull needs a raw piece - split, wrap or boolean it first', true); return; }
    if (pinModel != null && pinModel !== p.m.id) clearPins();
    pinModel = p.m.id;
    pins.push({ c: h.point, n: h.normal, r: radius() });
    drawPins();
    var txt = 'Pull: pin ' + pins.length + ' set (' + radius().toFixed(0) + ' mm) - it holds this spot still; Clear pins takes them off';
    say(txt); readout(txt);
  }

  /* ---- pointer events ---- */
  window.nsoPullTakesPointer = function (event) {
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
      var t = 'Pull refused - that is a support piece; supports are generated, not sculpted. Pull the piece it holds up instead - piece unchanged';
      say(t, true); readout(t, true);
      return;
    }
    pending = { p: p, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    if (state.controls) state.controls.enabled = false;
    try { if (event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId); } catch (e) { /* synthetic */ }
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
    if (!p) { hideRing(); return; }
    p.mesh.updateMatrixWorld();
    // The anchors are in the scene, not on the mesh (a child would widen every
    // bounding box taken of the piece), so a piece that has been moved or
    // turned since they were drawn gets them redrawn on it.
    if (pins.length && pinGroup && p.m.id === pinModel && p.mesh.matrixWorld.elements.join(',') !== pinPose) drawPins();
    var nW = p.hit.face.normal.clone().transformDirection(p.mesh.matrixWorld).normalize();
    placeRing(p.hit.point, nW, radius());
  }

  function onUp(event) {
    if (session) { endGrab(true, event); return; }
    if (pending) {
      var pd = pending;
      pending = null;
      releaseControls(event);
      addPin(pd);
    }
  }
  function onCancel(event) {
    if (session) { endGrab(false, event); return; }
    if (pending) { pending = null; releaseControls(event); }
  }

  /* ---- arming ----
     One armed tool at a time, and the convention is app-brush.js's: a tool that
     HAS a button is turned off THROUGH the button, never by writing its state
     flag behind its back. Every other tool does the same for Pull. */
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
    if (typeof window.nsoLimbArmed === 'function' && window.nsoLimbArmed()) {
      var limbBtn = el('btn-limb');
      if (limbBtn) limbBtn.click();
      else if (typeof window.nsoLimbSetArmed === 'function') window.nsoLimbSetArmed(false);
    }
    if (window.nsoFoam && window.nsoFoam.on && window.nsoFoam.on()) window.nsoFoam.cancel();
    // The other Shape panels are sessions of their own; one is open at a time.
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
      say('Pull needs a raw piece - select one (split, wrap or boolean it first if it is not)', true);
      return;
    }
    armed = true;
    disarmOthers();
    setLabel();
    syncSize();
    var txt = 'Pull armed - falloff ' + radius().toFixed(0) + ' mm. Press and drag a spot on the piece to pull it ' +
              '(Shift: along the normal); click to pin. Click the button again to stop';
    say(txt); readout('Press and drag on the piece to pull; click to pin.');
  }
  function exit() {
    if (session) endGrab(false);
    pending = null;
    releaseControls();
    armed = false;
    dropRing();
    clearPins();
    if (window.nsoPullLast) window.nsoPullLast.S = null;
    setLabel();
    say('Pull off');
  }
  function toggle() { if (armed) exit(); else enter(); }

  window.nsoPullArmed = function () { return armed; };
  window.nsoPullSetArmed = function (on) { if (!!on !== armed) toggle(); };
  /* For the checks: what Pull is holding right now. */
  window.nsoPullState = function () {
    return { armed: armed, dragging: !!session, pins: pins.map(function (pn) { return { c: pn.c.slice(), r: pn.r }; }),
             pinModel: pinModel, ring: ringVisible };
  };
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('pull', {
    live: function () { return armed; }, close: exit,
    clear: function () { dropRing(); clearPinMarks(); },
    refresh: function () { hideRing(); drawPins(); }
  });

  function bind() {
    var b = el('btn-pull');
    if (b && !b._pullBound) { b.addEventListener('click', toggle); b._pullBound = true; }
    var clr = el('btn-pull-clear');
    if (clr && !clr._pullBound) {
      clr.addEventListener('click', function () { if (!session) { clearPins(true); readout('Pins cleared.'); } });
      clr._pullBound = true;
    }
    var can = el('btn-pull-cancel');
    if (can && !can._pullBound) {
      can.addEventListener('click', function () { if (session) endGrab(false); else if (armed) exit(); });
      can._pullBound = true;
    }
    var ps = el('inp-pull-size'), bs = brushSlider();
    if (ps && !ps._pullBound) {
      ps.addEventListener('input', function () { syncSize('pull'); });
      ps._pullBound = true;
    }
    if (bs && !bs._pullMirror) {
      bs.addEventListener('input', function () { syncSize('brush'); });
      bs.addEventListener('change', function () { syncSize('brush'); });
      bs._pullMirror = true;
    }
    syncSize('brush');
    setLabel();
    if (!state || !state.renderer || !state.renderer.domElement || state._pullBound) return;
    state._pullBound = true;
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
