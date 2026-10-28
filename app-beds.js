/* app-beds.js - up to six plates (beds) in one scene. docs/BEDS.md is the contract.

   THE ONE IDEA. state.models, state.placed, state.undoStack, state.redoStack,
   state.editId, state.plateLock and the children of state.modelGroup ARE THE
   ACTIVE BED'S. Every tool, card and function in the app already reads those, so
   none of them can reach a piece on another bed: the other beds' lists are not
   there to be read. Making another bed active swaps the lists, moves the meshes
   across, and nothing else needs to know.

   The active bed stands at the world origin, as the one plate always did, so
   every coordinate in the app (a pick, a drag, a pose, an export) is the active
   bed's own and a piece's x / z mean the same wherever its bed sits. The other
   beds stand beside it in Bambu Studio's order - 1 2 3 across the back row, 4 5 6
   across the front row under them - one gap apart, and a change of active bed
   moves the camera by the step the beds move, so on screen nothing moves. This is
   G-scope's own scheme (app-microscope.js, "Two plates, side by side").

   An inactive bed keeps: its lists and stacks, a group at its offset holding its
   piece meshes, and its floor (the shared plate material, its own grid, border,
   corner ticks and label). With one bed none of that exists and the app is what it
   was.

   A piece moved between beds is two Undo entries that name each other (bedMoveOut
   on the bed it left, bedMoveIn on the bed it landed on), because each bed has its
   own Undo line. Undo on either one puts the piece back in a single step, provided
   the other half is the last step of its own bed; otherwise it says which bed to
   undo first. A move is not redoable. */
var NSO_BEDS = (function () {
  'use strict';

  var MAX_BEDS = 6;
  var COLS = 3;                    // 1 2 3 across the back row, then 4 5 6
  var GAP_FRAC = 0.2;              // the gap between neighbours, of the plate's longer side (Bambu Studio's 1.2 stride)
  var LIT = 0x38bdf8, DIM = 0x3a404c;      // G-scope's outline colours (FLOOR_LIT, FLOOR_DIM)
  var CLICK_SLOP = 4;              // px a press may travel and still be a click
  var NOOP = function () {};

  var beds = [];                   // the layout, in number order; beds[0] is Plate 1
  var active = 0;
  var bedSeq = 0, moveSeq = 0;
  var pressed = null;              // a left press that started on a bed that is not active
  var activeLabel = null;          // the active bed's label, in the scene at the origin
  var refused = false;             // the last movePiece said no, in words, and that is what the status line should keep
  var sized = null, resized = false;   // the plate size the floors were last built to, and whether it has just changed

  function say(msg, err) { if (typeof setStatus === 'function') setStatus(msg, !!err); }

  // ---------------------------------------------------------------- the beds

  function newBed() {
    return {
      id: ++bedSeq, group: null, pieces: null, floor: null,
      models: [], placed: [], undoStack: [], redoStack: [], editId: null, plateLock: false, blockers: []
    };
  }

  /* The first bed is the live state; it exists from the first time anyone asks. */
  function ensure() {
    if (!beds.length) { beds.push(newBed()); active = 0; }
  }

  function groupsOf(b) {
    if (!b.group) {
      b.group = new THREE.Group();
      b.group.name = 'nsoBed:' + b.id;
      b.pieces = new THREE.Group();
      b.pieces.name = 'nsoBedPieces:' + b.id;
      b.group.add(b.pieces);
    }
    return b;
  }

  function count() { return beds.length || 1; }
  function activeIndex() { return beds.length ? active : 0; }
  function activeNumber() { return activeIndex() + 1; }
  function bedById(id) { for (var i = 0; i < beds.length; i++) if (beds[i].id === id) return beds[i]; return null; }
  function indexOfBed(b) { return beds.indexOf(b); }
  function holder(b) { return b === beds[active] ? state : b; }     // whose lists are the bed's right now

  // ---------------------------------------------------------------- the layout

  function plate() { return getCurrentPlate(); }
  function gapMm() { var p = plate(); return GAP_FRAC * Math.max(p.w, p.d); }
  function strideX() { return plate().w + gapMm(); }
  function strideZ() { return plate().d + gapMm(); }
  function slotOf(i) { return { col: i % COLS, row: Math.floor(i / COLS) }; }

  /* Where bed i's centre is, in the frame of bed `from` (the active one when left out). */
  function offsetOf(i, from) {
    var a = slotOf(i), b = slotOf(from == null ? active : from);
    return { x: (a.col - b.col) * strideX(), z: (a.row - b.row) * strideZ() };
  }

  /* Every bed's rectangle, in the active bed's frame. */
  function layoutBox() {
    var p = plate(), minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (var i = 0; i < count(); i++) {
      var o = offsetOf(i);
      minx = Math.min(minx, o.x - p.w / 2); maxx = Math.max(maxx, o.x + p.w / 2);
      minz = Math.min(minz, o.z - p.d / 2); maxz = Math.max(maxz, o.z + p.d / 2);
    }
    return { minx: minx, maxx: maxx, minz: minz, maxz: maxz,
             cx: (minx + maxx) / 2, cz: (minz + maxz) / 2, w: maxx - minx, d: maxz - minz };
  }

  /* WHERE THE CAMERA STANDS to see every bed: in front of the block and above it, looking at its centre, as
     Bambu Studio's plate view does (1 2 3 reads left to right, 4 5 6 under them), far enough back that the
     whole block is in the frame at the camera's own aspect. One bed never comes here: its framing is the
     app's own (framePlateHome). */
  function frameView(camera) {
    var L = layoutBox(), vfov = (camera && camera.fov ? camera.fov : 45) * Math.PI / 180;
    var aspect = (camera && camera.aspect) || 1.5, e = 52 * Math.PI / 180, az = 8 * Math.PI / 180;
    var th = Math.tan(vfov / 2);
    var screenH = L.d * Math.sin(e) + 70 * Math.cos(e);
    var dist = Math.max((L.w / 2 * 1.45) / (th * aspect), (screenH / 2 * 1.3) / th);   // wide: the left column covers the edge of the view
    return {
      target: { x: L.cx, y: 6, z: L.cz },
      position: { x: L.cx + dist * Math.cos(e) * Math.sin(az), y: dist * Math.sin(e), z: L.cz + dist * Math.cos(e) * Math.cos(az) },
      distance: dist
    };
  }

  /* How far the farthest bed's centre stands from the active one: what the orbit leash adds to its reach. */
  function layoutReach() {
    var r = 0;
    for (var i = 0; i < beds.length; i++) { var o = offsetOf(i); r = Math.max(r, Math.hypot(o.x, o.z)); }
    return r;
  }

  /* The bed whose rectangle holds (x, z) in the active frame, not counting the active one; -1 for none. */
  function bedAt(x, z) {
    var p = plate();
    for (var i = 0; i < beds.length; i++) {
      if (i === active) continue;
      var o = offsetOf(i);
      if (Math.abs(x - o.x) <= p.w / 2 && Math.abs(z - o.z) <= p.d / 2) return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------- the floors

  function floorLabel(text, side) {
    var c = document.createElement('canvas');
    c.width = 512; c.height = 80;
    var g = c.getContext('2d');
    g.font = '600 50px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#e2e8f0';
    g.fillText(text, 4, 42);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var w = Math.min(60, side * 0.4), h = w * 80 / 512;
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide
    }));
    m.rotation.x = -Math.PI / 2;
    m.userData.w = w; m.userData.h = h; m.userData.skipXray = true;
    return m;
  }

  /* G-scope's place for it: lying on the floor in front of the bed, at its left. */
  function seatLabel(label, p) {
    label.position.set(-p.w / 2 + label.userData.w / 2, 0.02, p.d / 2 + label.userData.h / 2 + 1.5);
  }

  function disposeTree(o) {
    o.traverse(function (n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material && !n.userData.sharedMaterial) {
        if (n.material.map) n.material.map.dispose();
        n.material.dispose();
      }
    });
  }

  /* An inactive bed's floor: the shared plate material on its own plane, a grid, a dim border, the
     corner ticks and its label - the same furniture buildPlateMesh gives the active one. */
  function buildFloor(i) {
    var p = plate();
    var g = new THREE.Group();
    g.name = 'nsoBedFloor:' + (i + 1);
    var geo = new THREE.PlaneGeometry(p.w, p.d);
    var mesh = new THREE.Mesh(geo, state.plateMesh.material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    mesh.userData.sharedMaterial = true;
    mesh.userData.skipXray = true;
    g.add(mesh);
    var grid = buildPlateGrid(p);
    grid.visible = plateGridWantsVisible();
    g.add(grid);
    var border = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: DIM }));
    border.rotation.x = -Math.PI / 2;
    border.position.y = 0.3;
    g.add(border);
    var tickMat = new THREE.LineBasicMaterial({ color: 0xfbbf24 });
    var tl = Math.min(p.w, p.d) * 0.06, hw = p.w / 2, hd = p.d / 2;
    [[[-hw, 0.35, -hd], [-hw + tl, 0.35, -hd], [-hw, 0.35, -hd + tl]],
     [[hw, 0.35, -hd], [hw - tl, 0.35, -hd], [hw, 0.35, -hd + tl]],
     [[-hw, 0.35, hd], [-hw + tl, 0.35, hd], [-hw, 0.35, hd - tl]],
     [[hw, 0.35, hd], [hw - tl, 0.35, hd], [hw, 0.35, hd - tl]]].forEach(function (pts) {
      var tg = new THREE.BufferGeometry().setFromPoints(pts.map(function (v) { return new THREE.Vector3(v[0], v[1], v[2]); }));
      g.add(new THREE.Line(tg, tickMat));
    });
    var label = floorLabel('Plate ' + (i + 1), Math.min(p.w, p.d));
    seatLabel(label, p);
    label.material.opacity = 0.45;
    g.add(label);
    return g;
  }

  /* buildPlateMesh has just built the active bed's floor at the origin. Rebuild everyone else's, and the
     labels, which exist only while there is more than one bed. */
  function afterPlateBuilt() {
    var p0 = plate();
    if (sized && (sized.w !== p0.w || sized.d !== p0.d)) resized = true;
    sized = { w: p0.w, d: p0.d };
    if (activeLabel) {
      if (activeLabel.parent) activeLabel.parent.remove(activeLabel);
      disposeTree(activeLabel);
      activeLabel = null;
    }
    beds.forEach(function (b) {
      if (b.floor) {
        if (b.floor.parent) b.floor.parent.remove(b.floor);
        disposeTree(b.floor);
        b.floor = null;
      }
    });
    if (beds.length < 2 || !state.plateMesh) return;
    var p = plate();
    activeLabel = floorLabel('Plate ' + (active + 1), Math.min(p.w, p.d));
    seatLabel(activeLabel, p);
    activeLabel.raycast = NOOP;
    state.scene.add(activeLabel);
    beds.forEach(function (b, i) {
      if (i === active) return;
      groupsOf(b);
      b.floor = buildFloor(i);
      b.grids = [];
      b.floor.traverse(function (n) { if (n.userData && n.userData.plateGrid) b.grids.push(n); });
      b.group.add(b.floor);
    });
    layoutGroups();
    // buildPlateMesh drew the active border lit; it is the only lit one
    if (state.plateBorder && state.plateBorder.material) state.plateBorder.material.color.setHex(LIT);
  }

  function setGridVisible(on) {
    beds.forEach(function (b, i) {
      if (i === active || !b.grids) return;
      b.grids.forEach(function (n) { n.visible = on; });
    });
  }

  /* Every inactive bed's group where it stands now; the active bed's is out of the scene. */
  function layoutGroups() {
    beds.forEach(function (b, i) {
      if (!b.group) return;
      if (i === active) { if (b.group.parent) b.group.parent.remove(b.group); return; }
      var o = offsetOf(i);
      b.group.position.set(o.x, 0, o.z);
      if (b.group.parent !== state.scene) state.scene.add(b.group);
      b.group.updateMatrixWorld(true);
    });
  }

  // ---------------------------------------------------------------- busy

  /* Why the active bed may not change right now, or null. A job that will put its result onto "the plate"
     when it finishes must finish on the bed it started on. */
  function busyReason() {
    if (state.moveDragging) return 'Finish the drag first.';
    if (typeof NSO_BoolBusy !== 'undefined' && NSO_BoolBusy.active && NSO_BoolBusy.active())
      return 'A boolean is still running - wait for it, or press Escape, before changing plate.';
    if (typeof NSO_SUPPORTS_CARD !== 'undefined' && NSO_SUPPORTS_CARD.busy && NSO_SUPPORTS_CARD.busy())
      return 'Supports are still building - wait for them, or press Escape, before changing plate.';
    if (typeof NSO_CSG !== 'undefined' && NSO_CSG.loading && NSO_CSG.loading())
      return 'The boolean kernel is still loading - wait for it before changing plate.';
    if (state.importsPending > 0)
      return 'A file is still being read or a big piece indexed - wait for it before changing plate.';
    return null;
  }

  // ---------------------------------------------------------------- switching

  function moveChildren(from, to) {
    while (from.children.length) to.add(from.children[0]);
  }

  /* Every tool closed and every helper gone, while the pieces they were drawn on are still the plate's. */
  function closeEverything(why) {
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.teardown(why);
    if (state.cutterOpen && typeof closeCutter === 'function') closeCutter(false);
    if (typeof clearJoinSlots === 'function') clearJoinSlots();
    if (typeof clearFacePick === 'function') clearFacePick();
  }

  function stash(b) {
    if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
    state.selectedIndex = -1;
    groupsOf(b);
    b.models = state.models; b.placed = state.placed;
    b.undoStack = state.undoStack; b.redoStack = state.redoStack;
    b.editId = state.editId; b.plateLock = !!state.plateLock;
    b.blockers = state.supportBlockers || [];        // the Supports Blockers (app-support-blockers.js) stand on their own bed
    moveChildren(state.modelGroup, b.pieces);
  }

  function load(b) {
    groupsOf(b);
    state.models = b.models; state.placed = b.placed;
    state.undoStack = b.undoStack; state.redoStack = b.redoStack;
    state.editId = b.editId; state.plateLock = !!b.plateLock;
    state.supportBlockers = b.blockers || [];
    b.models = b.placed = b.undoStack = b.redoStack = null; b.blockers = null;
    moveChildren(b.pieces, state.modelGroup);
    state.selectedIndex = -1;
    state.moveIndex = -1;
    state.cutT = 0.5;
    state.previewMesh = null;
  }

  function refreshUI() {
    var stats = document.getElementById('stats');
    if (stats && stats.classList) stats.classList.add('hidden');
    renderModelList();
    updateOptimizeButton();
    updateEditSize();
    updateCutterUI();
    updateAdjustUI();
    updateUndoBtn();
    if (typeof nsoMaskRepaint === 'function') nsoMaskRepaint();
    if (typeof nsoPosLockRefresh === 'function') nsoPosLockRefresh();
    syncButtons();
  }

  function shiftView(dx, dz) {
    if (!state.camera || !state.controls || (!dx && !dz)) return;
    state.controls.enableDamping = false;
    state.controls.update();
    state.controls.enableDamping = true;
    state.camera.position.x += dx; state.camera.position.z += dz;
    state.controls.target.x += dx; state.controls.target.z += dz;
    state.controls.update();
  }

  /* Make bed i the active one. discard: the bed that was active is gone (Delete plate), so it is not stashed. */
  function swap(i, o) {
    o = o || {};
    var old = o.discard ? null : beds[active];
    var d = old ? offsetOf(i, active) : null;
    if (old) {
      if (o.teardown !== false) closeEverything('plate-switch');
      stash(old);
    }
    active = i;
    load(beds[i]);
    layoutGroups();
    buildPlateMesh();                 // the active floor at the origin; afterPlateBuilt does the rest
    if (d) shiftView(-d.x, -d.z);
    refreshUI();
  }

  function activate(i, opts) {
    ensure();
    if (i < 0 || i >= beds.length) return false;
    if (i === active) return true;
    var why = busyReason();
    if (why) { say(why, true); return false; }
    swap(i, opts);
    say('Plate ' + (i + 1) + ' is active - the Pieces card, every tool and Export act on it.');
    return true;
  }

  function add() {
    ensure();
    if (beds.length >= MAX_BEDS) {
      say('Six plates is the most - right-click a plate > Delete plate to make room.', true);
      return false;
    }
    var why = busyReason();
    if (why) { say(why, true); return false; }
    beds.push(newBed());
    swap(beds.length - 1);
    framePlateHome();                 // every plate in view, now there is one more
    say('Plate ' + beds.length + ' added and active - empty. Import, or drag a piece onto it.');
    return true;
  }

  /* DELETE PLATE: the active bed and its pieces go (the wipe Clear plate does, for this bed only; no Undo),
     the beds after it move up one number, and the next one becomes active. */
  function deleteActive() {
    ensure();
    if (beds.length < 2) { say('Only one plate - there is nothing to delete.', true); return false; }
    var why = busyReason();
    if (why) { say(why, true); return false; }
    var gone = active, n = gone + 1;
    clearPlateOnly();
    var dead = beds.splice(gone, 1)[0];
    if (dead.group) { if (dead.group.parent) dead.group.parent.remove(dead.group); }
    var next = Math.min(gone, beds.length - 1);
    swap(next, { discard: true });
    framePlateHome();
    say('Plate ' + n + ' deleted with its pieces - Plate ' + (next + 1) + ' is active. There is no Undo for that.');
    return true;
  }

  function canDelete() { return count() > 1; }

  /* A plate size change clears the plate (updatePlateInfo); it applies to every bed, each wiped the way the
     active one is: the pieces come off, the models stay. */
  function plateSizeChanged() {
    if (!resized) return;             // the same size again (a 3MF restoring its plate preset): the other beds are left alone
    resized = false;
    beds.forEach(function (b, i) {
      if (i === active || !b.placed) return;
      b.placed.forEach(function (p) {
        if (p && p.mesh) {
          if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
          if (p.mesh.material) {
            if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(function (m) { m.dispose(); });
            else p.mesh.material.dispose();
          }
        }
      });
      b.placed = [];
      if (b.pieces) while (b.pieces.children.length) b.pieces.remove(b.pieces.children[0]);
    });
  }

  // ---------------------------------------------------------------- clicks

  /* Which bed is under the pointer: the active bed's floor, or any other bed's floor, label or piece. */
  function pickBed(event) {
    if (beds.length < 2 || !state.renderer || !state.camera) return -1;
    setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var targets = [state.plateMesh, state.modelGroup];
    beds.forEach(function (b, i) { if (i !== active && b.group) targets.push(b.group); });
    var hits = state.raycaster.intersectObjects(targets.filter(Boolean), true);
    for (var h = 0; h < hits.length; h++) {
      var o = hits[h].object;
      if (o === state.plateMesh) return active;
      for (var n = o; n; n = n.parent) {
        if (n === state.modelGroup) return active;
        for (var j = 0; j < beds.length; j++) if (beds[j].group === n) return j;
      }
    }
    return -1;
  }

  /* A left press that reached the floor or the background (a piece, or a tool, would have taken it
     earlier). If it is on a bed that is not active, remember it: a click there makes that bed active, a
     drag orbits and activates nothing - the press itself changes nothing, so orbit and selection are as ever. */
  function notePress(event) {
    pressed = null;
    if (beds.length < 2) return;
    var i = pickBed(event);
    if (i < 0 || i === active) return;
    pressed = { id: beds[i].id, x: event.clientX, y: event.clientY };
  }

  function releasePress(event) {
    var p = pressed;
    pressed = null;
    if (!p || !event || event.type === 'pointercancel' || event.button !== 0) return;
    if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > CLICK_SLOP) return;
    var b = bedById(p.id);
    if (b) activate(indexOfBed(b));
  }

  /* A right click on a bed that is not active makes it active first: Delete plate acts on the active one. */
  function activateUnder(event) {
    if (beds.length < 2) return false;
    var i = pickBed(event);
    if (i < 0 || i === active) return false;
    return activate(i);
  }

  /* The bed a flat drag was dropped over: the one the piece's own origin (p.x, p.z) is over, other than the
     active bed; -1 when it is over the active bed or over no bed. */
  function dropTarget(p, from) {
    if (beds.length < 2 || !p) return -1;
    var pl = plate();
    // a piece that started off its own bed (placed past the edge, say) is being moved about, not carried off it
    if (from && (Math.abs(from.x) > pl.w / 2 || Math.abs(from.z) > pl.d / 2)) return -1;
    return bedAt(p.x, p.z);
  }

  // ---------------------------------------------------------------- moving a piece between beds

  function takeOff(b, p, m) {
    var h = holder(b);
    var pi = h.placed.indexOf(p); if (pi >= 0) h.placed.splice(pi, 1);
    var mi = m ? h.models.indexOf(m) : -1; if (mi >= 0) h.models.splice(mi, 1);
    if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
    h.placed.forEach(function (q, i) { if (q.mesh) q.mesh.userData.placedIndex = i; });
    if (b === beds[active]) {
      state.selectedIndex = -1;
      if (m && state.editId === m.id) state.editId = null;
      if (m && state.joinPartnerId === m.id) state.joinPartnerId = null;
    }
  }

  function putOn(p, m, placedIndex, modelIndex) {
    if (m && state.models.indexOf(m) < 0) state.models.splice(Math.min(Math.max(modelIndex, 0), state.models.length), 0, m);
    state.placed.splice(Math.min(Math.max(placedIndex, 0), state.placed.length), 0, p);
    if (p.mesh) state.modelGroup.add(p.mesh);
    reindexPlacedMeshes();
    return state.placed.indexOf(p);
  }

  /* A piece that cannot go alone: another piece on this bed is the same model (a quantity of several), it has
     supports (their own pieces, tied to it by id), or it is a support. They stay together, so none is moved. */
  function moveRefusal(p, m) {
    if (!m) return null;
    var name = p.name || m.name || 'This piece';
    if (state.placed.some(function (q) { return q !== p && q.sourceId === p.sourceId; }))
      return name + ' has copies of the same model on this plate - it stays here (a model moves between plates whole).';
    if (m.nsoSupport) return name + ' is a support - supports stay with the piece they hold up.';
    if (state.models.some(function (x) { return x.nsoSupport && x.nsoSupport.hostSourceId === m.id; }))
      return name + ' has supports on this plate - remove them first, or they would be left holding up nothing.';
    return null;
  }

  /* The piece at index idx of the active bed, dropped over bed `to`: it keeps its pose, lands on that bed's
     floor where it was let go, joins that bed's Pieces list and that bed becomes active. `from` is the pose
     it was picked up in. Two Undo entries, one on each bed's line (see the head of this file). */
  function movePiece(idx, to, from) {
    var p = state.placed[idx], T = beds[to], S = beds[active];
    refused = false;
    if (!p || !p.mesh || !T || !S || T === S) return false;
    var m = p.sourceId != null ? state.models.find(function (x) { return x.id === p.sourceId; }) || null : null;
    var why = busyReason();
    if (why) { say(why, true); refused = true; return false; }
    var tied = moveRefusal(p, m);
    if (tied) { say(tied, true); refused = true; return false; }
    var off = offsetOf(to);
    var tx = p.x - off.x, tz = p.z - off.z;
    var id = ++moveSeq;
    closeEverything('plate-move');
    pushUndo({
      type: 'bedMoveOut', moveId: id, toBed: T.id, index: idx, modelIndex: m ? state.models.indexOf(m) : -1,
      model: m, item: p, pose: { x: from.x, z: from.z, meshY: from.meshY }, onUndone: NOOP
    });
    if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
    takeOff(S, p, m);
    swap(to, { teardown: false });
    p.x = tx; p.z = tz;
    p.mesh.position.x = tx; p.mesh.position.z = tz;
    var at = putOn(p, m, state.placed.length, state.models.length);
    settlePlacedOnBed(p);
    nsoInvalidatePlacedBounds(p);
    pushUndo({
      type: 'bedMoveIn', moveId: id, fromBed: S.id, index: at, modelIndex: m ? state.models.indexOf(m) : -1,
      model: m, item: p, onUndone: NOOP
    });
    selectPlaced(at);
    say('Moved ' + (p.name || 'the piece') + ' to Plate ' + (to + 1) + ' - Plate ' + (to + 1) +
        ' is active. One Undo (Ctrl+Z) puts it back.');
    return true;
  }

  /* UNDO of a move, from either half. The piece goes back to the bed it left, at the pose it left in, and
     that bed is active. The other half must be the last step of its own bed's line - a move cannot be taken
     back from under later steps on that bed, whose numbers it would shift. Returns { refused } when it
     could not, with the entry put back; { gone } when the other half no longer exists, and then the entry
     is just dropped (it can no longer be undone). */
  function undoMove(entry) {
    var isIn = entry.type === 'bedMoveIn';
    var why = busyReason();
    if (why) {
      state.undoStack.push(entry);
      updateUndoBtn();
      say(why, true);
      return { refused: true };
    }
    var other = bedById(isIn ? entry.fromBed : entry.toBed);
    var partner = isIn ? 'bedMoveOut' : 'bedMoveIn';
    var at = -1;
    if (other && other !== beds[active]) {
      for (var k = other.undoStack.length - 1; k >= 0; k--) {
        var e = other.undoStack[k];
        if (e && e.type === partner && e.moveId === entry.moveId) { at = k; break; }
      }
    }
    if (at < 0) {
      say('Undo: that move can no longer be undone - the other plate\'s history it belongs to is gone.', true);
      updateUndoBtn();
      return { gone: true };
    }
    if (at !== other.undoStack.length - 1) {
      state.undoStack.push(entry);
      updateUndoBtn();
      say('Undo the later steps on Plate ' + (indexOfBed(other) + 1) + ' first - the move is under them.', true);
      return { refused: true };
    }
    closeEverything('plate-move');
    var partnerEntry = other.undoStack.pop();
    var out = isIn ? partnerEntry : entry;
    var S = isIn ? other : beds[active];
    var T = isIn ? beds[active] : other;
    var p = entry.item, m = entry.model;
    if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
    takeOff(T, p, m);
    if (S !== beds[active]) swap(indexOfBed(S), { teardown: false });
    var back = putOn(p, m, out.index, out.modelIndex);
    p.x = out.pose.x; p.z = out.pose.z;
    applyPlacedXZ(p, p.x, p.z);
    restoreMeshY(p, out.pose.meshY);
    nsoInvalidatePlacedBounds(p);
    selectPlaced(back);
    updateUndoBtn();
    say('Undo: moved ' + (p.name || 'the piece') + ' back to Plate ' + (indexOfBed(S) + 1));
    return { ok: true };
  }

  // ---------------------------------------------------------------- what the other beds hold

  /* The lists and stacks of the beds that are not active, for the geometry lifecycle: a geometry one of
     them still names is not disposed. */
  function stashedRoots() {
    var out = [];
    beds.forEach(function (b, i) {
      if (i === active) return;
      [b.models, b.placed, b.undoStack, b.redoStack].forEach(function (r) { if (r) out.push(r); });
    });
    return out;
  }

  /* For the checks and the report: one row per bed. */
  function info() {
    ensure();
    return beds.map(function (b, i) {
      var on = i === active, h = holder(b);
      return { number: i + 1, id: b.id, active: on, models: h.models.length, placed: h.placed.length,
               undo: h.undoStack.length, redo: h.redoStack.length };
    });
  }

  // ---------------------------------------------------------------- the + plate button

  function syncButtons() {
    var btn = document.getElementById('btn-add-plate');
    if (btn) {
      var full = count() >= MAX_BEDS;
      btn.disabled = full;
      btn.title = full ? 'Six plates is the most' : 'Add a plate (up to six): 1 2 3 across the back, 4 5 6 in front';
    }
    if (typeof nsoCtxMenuRefresh === 'function') nsoCtxMenuRefresh();
  }

  function wire() {
    var btn = document.getElementById('btn-add-plate');
    if (btn && btn.dataset.nsoWired !== '1') {
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', add);
    }
    syncButtons();
  }
  if (typeof document !== 'undefined' && document.getElementById) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  return {
    MAX: MAX_BEDS,
    count: count, activeIndex: activeIndex, activeNumber: activeNumber, canDelete: canDelete,
    add: add, activate: activate, deleteActive: deleteActive, movePiece: movePiece, refused: function () { return refused; }, undoMove: undoMove,
    afterPlateBuilt: afterPlateBuilt, setGridVisible: setGridVisible, plateSizeChanged: plateSizeChanged,
    layoutBox: layoutBox, frameView: frameView, layoutReach: layoutReach, offsetOf: offsetOf, bedAt: bedAt,
    pickBed: pickBed, notePress: notePress, releasePress: releasePress, activateUnder: activateUnder,
    dropTarget: dropTarget, busyReason: busyReason, stashedRoots: stashedRoots, info: info
  };
})();
if (typeof window !== 'undefined') window.NSO_BEDS = NSO_BEDS;
