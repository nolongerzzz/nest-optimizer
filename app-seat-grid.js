/* Surface grid on the Seat / Join target — the piece something is being
   placed ONTO gets a faint grid drawn on its top surface, so the piece going
   above it can be lined up against something. After app-join.js.

   WHOSE GRID IT IS
   A pairing has a lower piece and an upper one. In this app that is Join's
   A and B: A is the hull / target (state.editId while a join session is
   live, which is also what Seat flush and Subtract take as the hull), B is
   the bit that gets seated onto it. The grid belongs to A only. It is never
   drawn on B, and a piece that stops being A loses it on the same refresh
   that gave it to whoever is A now.

   WHERE THE LINES COME FROM
   nso-surface-grid.js slices the target's own triangles with the grid planes
   and hands back the chords, so every point of every line is a point of the
   real surface - a dome gets a grid that bends over it, not a flat one
   hanging above it. This file only decides which piece, which way is up, and
   how it is drawn.

   WHAT IT IS NOT
   It is paint on a face, the way app-mask.js's yellow is: an overlay object
   with its own geometry, raycast disabled so it cannot be picked in place of
   the piece, and no reach into the piece's geometry, rawTris, or anything
   export reads. Removing every line changes nothing but the picture.

   NOT A CHILD OF THE PIECE, and that is the whole of why.
   app-sel-outline.js, app-poslock.js and app-defects.js all hang their helper
   off `p.mesh`, and get "it follows a drag" for free. They can: an outline,
   a lock cage and a defect mark all lie exactly on the geometry, so they add
   nothing to it. This one cannot. Its lines are lifted a hair off the face to
   keep out of the depth fight (below), and `THREE.Box3.setFromObject` walks
   children - so a grid parented to the piece makes the piece MEASURE bigger
   by the lift. That is not hypothetical: it moved seven Seat gates by exactly
   0.1375mm, the lift on an 80x40x20 hull. The app itself is immune (it asks
   meshLocalBox3, which reads the mesh's own geometry), but "the piece's box"
   is a thing anything may reasonably ask for, and a drawing that changes the
   answer is a drawing that is not purely visual.

   So the grid sits in state.modelGroup with the piece's transform copied onto
   it, which is what app-mask.js's paint does and, it turns out, why. Nothing
   under the piece has volume, and `setFromObject` reads the same with the
   grid up as down. The price is the one thing a child got free - keeping up
   with a move - and it is paid by copying the pose, not by rebuilding: see
   syncPose below. The lines are still computed in the piece's own space and
   on its own axes, so what a square reads stays true as the piece turns. */
(function () {
  'use strict';

  /* Above the inspect cage (16) and the armed-face highlight (20), below the
     face paint (40): the paint is the answer to a question the user asked,
     the grid is a background aid, and a face that is both painted out and
     under the grid should read as painted out. */
  var GRID_RENDER_ORDER = 24;
  var UP_MIN = 0.12;          // cos: steeper than ~83 deg is a wall, not a top
  var TARGET_DIVISIONS = 12;  // squares across the wider side, before rounding
  var SQUARE_TOL = 0.966;     // ~15 deg: still "standing square" on that axis
  var GRID_COLOR = 0xe0f2fe, GRID_OPACITY = 0.3;
  var AXIS_COLOR = 0xffffff, AXIS_OPACITY = 0.55;
  var MODES = ['auto', 'on', 'off'];
  var LABELS = {
    auto: 'Surface grid: auto',
    on: 'Surface grid: on',
    off: 'Surface grid: off'
  };
  var NOTES = {
    auto: 'Surface grid: auto - shown on the Join / Seat target (piece A)',
    on: 'Surface grid: on - shown on the target, or on the selected piece',
    off: 'Surface grid: off'
  };

  function st() { return (typeof state !== 'undefined' && state) ? state : null; }
  function noop() {}

  function modeOf() {
    var s = st();
    var m = s && s.seatGridMode;
    return (MODES.indexOf(m) !== -1) ? m : 'auto';
  }

  /* The lower piece of the current pairing, or null.

     auto: only a live Join session names a target, and the target is A. B is
     the piece being placed and never gets the grid - asked for it directly,
     the answer is still A's grid.
     on:  with no session running, the selected piece stands in as the target,
     which is the on-demand half of the toggle. */
  function targetPlaced() {
    var s = st();
    if (!s || !s.placed || !s.placed.length) return null;
    var mode = modeOf();
    if (mode === 'off') return null;
    if (s.joinSession && s.editId != null && s.editId !== s.joinPartnerId) {
      for (var i = 0; i < s.placed.length; i++) {
        var p = s.placed[i];
        if (p && p.mesh && p.sourceId === s.editId) return p;
      }
      return null;
    }
    if (mode === 'on') {
      var sel = s.placed[s.selectedIndex];
      if (!sel || !sel.mesh) return null;
      if (s.joinSession && sel.sourceId === s.joinPartnerId) return null;
      return sel;
    }
    return null;
  }

  /* The mesh's own triangles, as the soup the slicer wants. Read off the live
     geometry every rebuild - after a bake or a boolean the piece is a new
     mesh, and a grid built from a remembered soup would be a grid of the
     piece that used to be there. */
  function soupOf(geo) {
    var pos = geo && geo.attributes && geo.attributes.position;
    if (!pos || !pos.count) return null;
    var idx = geo.index;
    var n = idx ? idx.count : pos.count;
    if (n < 3) return null;
    var out = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var v = idx ? idx.getX(i) : i;
      out[i * 3] = pos.getX(v);
      out[i * 3 + 1] = pos.getY(v);
      out[i * 3 + 2] = pos.getZ(v);
    }
    return out;
  }

  /* Two directions for the line families, perpendicular to up. A piece
     standing square on the plate - which is all of them, unless it has been
     tipped - gets its own two axes, so the squares run parallel to its edges
     and an offset can be read off them. A piece at some angle to its own
     axes falls back to any pair perpendicular to up. */
  function planeAxes(up) {
    var cand = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    var best = 0;
    for (var i = 1; i < 3; i++) {
      if (Math.abs(cand[i].dot(up)) > Math.abs(cand[best].dot(up))) best = i;
    }
    if (Math.abs(cand[best].dot(up)) > SQUARE_TOL) {
      return { u: cand[(best + 1) % 3], v: cand[(best + 2) % 3] };
    }
    var u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(u.dot(up)) > 0.9) u.set(0, 0, 1);
    u.addScaledVector(up, -u.dot(up)).normalize();
    var v = new THREE.Vector3().crossVectors(up, u).normalize();
    return { u: u, v: v };
  }

  function addLines(group, pts, color, opacity) {
    if (!pts || !pts.length) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    /* depthTest on: the grid belongs to the surface it is drawn on, so a
       piece sitting over it hides the part it covers - which is the point,
       the aid is for judging what is still uncovered. depthWrite off so it
       never leaves depth of its own for the piece's other helpers to test
       against. */
    var m = new THREE.LineBasicMaterial({
      color: color, transparent: true, opacity: opacity,
      depthTest: true, depthWrite: false
    });
    var line = new THREE.LineSegments(g, m);
    line.renderOrder = GRID_RENDER_ORDER;
    /* The grid is a picture of the surface, not a surface. app-core.js picks
       with intersectObjects(modelGroup.children, TRUE), so without this a
       Join, Soften or paint click that lands on a grid line hits the line
       instead of the piece - and since the grid stands beside the piece
       rather than under it, the walk up to placedIndex finds nothing at all
       and the click is simply lost. Same reason app-mask.js's paint,
       app-poslock.js's cage and app-defects.js's marks are all deaf. */
    line.raycast = noop;
    line.userData.nsoHelper = true;
    line.userData.skipXray = true;
    group.add(line);
  }

  function build(placed) {
    if (typeof THREE === 'undefined' || typeof NSO_surfaceGridLines !== 'function') return null;
    var mesh = placed && placed.mesh;
    var geo = mesh && mesh.geometry;
    var soup = soupOf(geo);
    if (!soup) return null;

    mesh.updateMatrixWorld(true);
    /* World up, said in the mesh's own space: a piece that has been tipped or
       rolled still gets the grid on the face that is actually facing the sky,
       because that is the face the piece above will land on. */
    var q = new THREE.Quaternion();
    mesh.getWorldQuaternion(q);
    var up = new THREE.Vector3(0, 1, 0).applyQuaternion(q.invert()).normalize();
    var ax = planeAxes(up);

    if (!geo.boundingBox) geo.computeBoundingBox();
    var size = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    var lift = Math.max(0.03, size.length() * 0.0015);

    var res = NSO_surfaceGridLines(soup, {
      up: [up.x, up.y, up.z],
      u: [ax.u.x, ax.u.y, ax.u.z],
      v: [ax.v.x, ax.v.y, ax.v.z],
      minDot: UP_MIN,
      target: TARGET_DIVISIONS,
      lift: lift
    });
    if (!res || !res.count) return null;

    var group = new THREE.Group();
    group.name = 'seatGrid';
    group.renderOrder = GRID_RENDER_ORDER;
    group.userData.nsoHelper = true;
    group.userData.seatGrid = { sourceId: placed.sourceId, spacing: res.spacing,
                                segments: res.count, faces: res.faces };
    addLines(group, res.grid, GRID_COLOR, GRID_OPACITY);
    addLines(group, res.axis, AXIS_COLOR, AXIS_OPACITY);
    if (!group.children.length) return null;
    return group;
  }

  var current = null;   // { group, key, mesh, sourceId }

  function clear() {
    if (!current) return;
    var g = current.group;
    if (g.parent) g.parent.remove(g);
    for (var i = 0; i < g.children.length; i++) {
      var c = g.children[i];
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    current = null;
  }

  /* The grid stands beside the piece rather than under it, so it has to be
     told when the piece moves. This is the whole of that: three copies, no
     geometry touched, cheap enough to sit on a pointermove. */
  function syncPose() {
    if (!current || !current.mesh) return;
    current.group.position.copy(current.mesh.position);
    current.group.quaternion.copy(current.mesh.quaternion);
    current.group.scale.copy(current.mesh.scale);
  }

  /* What the grid was built from. Anything in here changing means the lines
     would come out different, so they are built again; nothing else does. A
     drag or a nudge changes none of it - only the pose, which syncPose copies
     without rebuilding a line. */
  function keyOf(placed) {
    var mesh = placed.mesh, geo = mesh.geometry;
    var pos = geo && geo.attributes && geo.attributes.position;
    var q = mesh.quaternion;
    var r = function (n) { return Math.round(n * 1e4) / 1e4; };
    return [placed.sourceId, mesh.uuid, geo ? geo.uuid : '-', pos ? pos.count : 0,
            pos ? pos.version : 0, r(q.x), r(q.y), r(q.z), r(q.w)].join('|');
  }

  function refresh() {
    var placed = targetPlaced();
    if (!placed) { clear(); return null; }
    var key = keyOf(placed);
    /* Still in the scene, still the same piece: a repack empties modelGroup,
       so being in it is part of being current. */
    if (current && current.key === key && current.mesh === placed.mesh &&
        current.group.parent === state.modelGroup) {
      syncPose();
      return current.group;
    }
    clear();
    if (!state.modelGroup) return null;
    var group;
    try {
      group = build(placed);
    } catch (e) {
      console.warn('[seat-grid] build failed', e);
      return null;
    }
    if (!group) return null;
    current = { group: group, key: key, mesh: placed.mesh, sourceId: placed.sourceId };
    syncPose();
    state.modelGroup.add(group);
    return group;
  }

  /* ---- what the tests and the rest of the app can ask ---- */

  window.nsoSeatGridRefresh = refresh;

  window.nsoSeatGridInfo = function () {
    var placed = targetPlaced();
    var live = !!(current && current.group && current.group.parent);
    var d = (live && current.group.userData.seatGrid) || null;
    return {
      mode: modeOf(),
      targetId: placed ? placed.sourceId : null,
      visible: live,
      onSourceId: live ? current.sourceId : null,
      spacing: d ? d.spacing : 0,
      segments: d ? d.segments : 0,
      faces: d ? d.faces : 0
    };
  };

  window.nsoSeatGridSetMode = function (mode) {
    var s = st();
    if (!s || MODES.indexOf(mode) === -1) return modeOf();
    s.seatGridMode = mode;
    refresh();
    setLabel();
    return mode;
  };

  /* ---- the button ---- */

  function setLabel() {
    var btn = document.getElementById('btn-seat-grid');
    if (!btn) return;
    var mode = modeOf();
    btn.textContent = LABELS[mode];
    btn.classList.toggle('tool-active', mode === 'on');
    btn.classList.toggle('is-off', mode === 'off');
  }

  function cycle() {
    var next = MODES[(MODES.indexOf(modeOf()) + 1) % MODES.length];
    window.nsoSeatGridSetMode(next);
    if (typeof setStatus === 'function') setStatus(NOTES[next]);
  }

  /* ---- when it is rebuilt ----
     paintJoinHighlights is the app's own "the pairing changed, restate who is
     who" call: every join slot change, every Cancel, every selection and
     every completed boolean goes through it. Hanging the grid off it means
     the grid changes hands exactly when the roles do, with no second list of
     hooks to keep in step. selectPlaced and applyMeshRotation are wrapped too
     - the first for picking outside a join session, the second because
     turning a piece over changes which face is up. */
  function wrap(name, after) {
    var prev = window[name];
    if (typeof prev !== 'function' || prev._seatGridWrapped) return;
    var next = function () {
      var out = prev.apply(this, arguments);
      try { after(); } catch (e) { console.warn('[seat-grid] ' + name, e); }
      return out;
    };
    next._seatGridWrapped = true;
    window[name] = next;
  }

  function wrapAll() {
    wrap('paintJoinHighlights', refresh);
    wrap('selectPlaced', refresh);
    wrap('applyMeshRotation', refresh);
    wrap('clearPlaced', clear);
    // Every drag, nudge, magnet and bed settle goes through applyPlacedXZ.
    // Nothing is rebuilt here - the pose is copied and that is all.
    wrap('applyPlacedXZ', syncPose);
  }

  function bind() {
    wrapAll();
    var btn = document.getElementById('btn-seat-grid');
    if (btn && !btn._seatGridBound) {
      btn.addEventListener('click', cycle);
      btn._seatGridBound = true;
    }
    setLabel();
    refresh();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
    setTimeout(bind, 0);
  }
})();
