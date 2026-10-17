/* Rotate rings - three full rings on the selected piece, one per axis of the
   PLATE, each turned by the arrowheads it carries.

   WHAT WAS WRONG WITH THE ARC AND THE TRACKBALL. Three things, and each one
   made the control say one thing and do another:

   1. THE GUIDE AND THE MOTION DISAGREED. A pose is stored as Euler angles
      that applyMeshRotation composes in a fixed order -

          mesh.rotation.set(tipX*90 + tiltX + flip,  rotY,  tipZ*90 + tiltZ)

      - an XYZ Euler, so the matrix is Rx * Ry * Rz. Writing rotY moves the
      MIDDLE factor, which turns the piece about the Y axis as Rx has already
      tilted it. The handle wrote rotY and drew a flat ring, so on a pitched
      piece the arc showed one axis and the piece turned about another.
   2. THE DIAL HAD NO VIEW TERM. It mapped the pointer's screen angle straight
      to degrees, so from the far side of the plate the same circle on screen
      turned the piece the other way.
   3. THE MAGNETIC DETENT pulled the piece up to 4.5 degrees off the pointer,
      everywhere in the travel.

   WHAT THIS DOES INSTEAD.

   Turn is about the plate's vertical; the two leans are about the PIECE's
   own axes as it lies - the ring on its own X and the ring on its own Z - so
   each lean ring is drawn in the piece's frame and the ring you grab is the
   motion you get (frameOf). A Turn step is premultiplied onto the piece's
   orientation, a lean step postmultiplied (turned), and either way the
   result is decomposed back into the SAME pose fields,
   in the same XYZ order applyMeshRotation composes them in (writePose below).
   Nothing that reads those fields has to know this file exists: export, Undo
   snapshots, Join's NSO_rotateRawSoupByPlacedPose, Mirror and the Tip menu
   all read the fields or the mesh applyMeshRotation builds from them, and
   both say exactly what this wrote. tipX, tipZ and flipX are NEVER written
   here: they stay the whole quarter-turn counts Tip 90 and Roll 90 step, and
   the continuous part goes in tiltX, rotY and tiltZ.

   WHAT THE LEANS ARE CALLED follows the piece's footprint (leanMap). "Lean
   front/back" is the lean that tips the piece ALONG the long dimension of its
   footprint as it lies - its two ends rise and fall - and "Lean side/side"
   tips it ACROSS - one long edge rises. The rings themselves do not move:
   they stay on the piece's own X and Z, and a ring's id ('fb' = own X, 'ss' =
   own Z) names that axis, as Tilt and the checks have always called it. Only
   which ring carries which NAME, colour and card row is looked up, from the
   footprint, every time it is asked - so a Turn, a Tip, a Scale or a bake
   that changes the footprint changes the names with no event to forget. A
   footprint within 5% of square has no long side: there the old mapping
   stands (front/back = own X). During a drag the names are held, so the ring
   in your hand does not change colour under it.

   THE DARTS sit on a major (45 degree) tick of their ring, the one nearest the
   camera, and nowhere between ticks. They stay on it until the camera has
   orbited 10 degrees past the half-way point to the next one, then re-seat
   there (seatFor). Only a drag carries them off a tick - they ride the piece
   under the pointer - and releasing puts them back on one. A click or an
   arrow key turns the PIECE a step; the darts stay where they are.

   The drag is still a dial - the pointer's angle about the ring's projected
   centre - but signed by which side of the ring the camera is on (the dot of
   the look vector with the ring's axis), so clockwise on screen is clockwise
   on the piece from every side. See dialSign.

   THE DETENTS live on the ring's own ticks, every 45 degrees (the quarters are
   the long ones), in the ring's frame - the one the scale is painted in. They
   do not depend on where the drag began or where the darts sit: the piece's
   angle on the ring (ringAngleDeg) is absolute, so inside 3 degrees of a
   detent the piece sits ON it, and outside the piece is exactly where the
   pointer says. Only during a drag. The tick the piece is within that window
   of is lit (litTick), drag or rest, and the readout says which angle it
   sits on. A click is always exactly 1 degree (0.1 with Shift). The 90
   buttons keep the quarter-turn snap alone (hardSnapDeg). */
(function () {
  'use strict';

  var STEP_DEG = 1;             // one click on an arrowhead, one arrow key
  var FINE_STEP_DEG = 0.1;      // ...with Shift held
  var SNAP_STEP_DEG = 90;       // the quarter turns
  var SNAP_WITHIN_DEG = 3;      // ...and how close the hard snap catches
  var DETENT_DEG = 45;          // the drag's detents: every 45 on the ring's own scale
  var CLICK_SLOP_PX = 4;        // a press that travels less than this is a click
  var FLASH_MS = 240;           // the one flash on landing in a snap

  var DEG = 180 / Math.PI, RAD = Math.PI / 180;

  var MAJOR_DEG = 45;           // the ticks the darts may sit on
  var SEAT_HYST_DEG = 10;       // how far past the half-way point the camera goes before they move
  var SQUARE_WITHIN = 0.05;     // a footprint this close to square has no long side

  /* The three rings. `e1, e2` span the ring's plane with e1 x e2 = axis, so a
     point at angle t, c + r (cos t e1 + sin t e2), moves the right-handed
     positive way about the axis as t grows. The ids are AXES: 'turn' the
     plate's vertical, 'fb' the piece's own X, 'ss' its own Z - whatever the
     ring is called on screen (LOOKS, leanMap). */
  var RINGS = {
    turn: { frame: 'plate', axis: [0, 1, 0], e1: [0, 0, 1], e2: [1, 0, 0] },
    fb:   { frame: 'piece', local: [1, 0, 0] },
    ss:   { frame: 'piece', local: [0, 0, 1] }
  };
  /* What a ring is called, coloured and boxed as. Keyed by ROLE: 'fb' is the
     lean along the footprint's long side, 'ss' the lean across it. Colours
     match the checkboxes. */
  var LOOKS = {
    turn: { color: 0x38bdf8, css: '#38bdf8', label: 'Turn', chk: 'chk-rot-ring-turn' },
    fb:   { color: 0xf472b6, css: '#f472b6', label: 'Lean front/back', chk: 'chk-rot-ring-fb' },
    ss:   { color: 0xfbbf24, css: '#fbbf24', label: 'Lean side/side', chk: 'chk-rot-ring-ss' }
  };
  var UP = [0, 1, 0];

  /* WHICH AXIS EACH RING IS. Turn is the plate's vertical, always: it stays
     level, and a turn is about the plate however the piece lies. The two
     leans are the PIECE's own axes as it currently lies, so they turn with
     it - at rest exactly #135's rings, plate X and plate Z, and after that
     wherever the piece has taken them. The 'fb' ring is its own X, its
     length if it lies along X: its ring lies ACROSS the piece and rolls it.
     The 'ss' ring is its own Z, the line across its width: its ring runs
     ALONG the piece and tips it end-over-end. Turn a bar 45 degrees and lean
     it about its own Z: its long axis rises at the same 45 degree heading,
     with no twist. A lean about the PLATE's axis there would have swung it
     sideways as it rose. Which of the two is CALLED front/back is leanMap's
     business, not the axis's.

     frameOf gives a ring's axis A and the two vectors e1, e2 spanning its
     plane (e1 x e2 = A), in world terms, for the orientation q. For a lean
     ring e1 is kept level - the horizontal line in the ring's plane - so the
     ring's scale reads 0 with the piece's end flat and 90 with it upright,
     and turning about A itself leaves A, and so the whole frame, where it was.
     Only when A is straight up is there no level line; the piece's own most
     nearly perpendicular axis stands in. */
  function frameOf(ring, q) {
    var R = RINGS[ring];
    if (R.frame === 'plate') return { A: v3(R.axis), e1: v3(R.e1), e2: v3(R.e2) };
    var A = v3(R.local).applyQuaternion(q).normalize();
    var e1 = v3(UP).cross(A);
    if (e1.lengthSq() < 1e-12) {
      var best = null, bl = -1;
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(function (b) {
        var w = v3(b).applyQuaternion(q), l = 1 - Math.pow(w.dot(A), 2);
        if (l > bl) { bl = l; best = w; }
      });
      e1 = best.projectOnPlane(A);
    }
    e1.normalize();
    return { A: A, e1: e1, e2: A.clone().cross(e1).normalize() };
  }
  function pieceQ() {
    var p = piece();
    if (!p) return new THREE.Quaternion();
    p.mesh.updateMatrixWorld(true);
    return p.mesh.quaternion.clone();
  }
  var ORDER = ['turn', 'fb', 'ss'];

  function v3(a) { return new THREE.Vector3(a[0], a[1], a[2]); }

  /* ---- what the leans are called -------------------------------------------
     The piece's footprint as it lies: the width and depth of the box its mesh
     takes on the plate - applyMeshRotation's p.width / p.depth, measured here
     off the mesh so a bake or a Scale that rebuilt it is never out of date. */
  function footprint(p) {
    if (!p || !p.mesh || !p.mesh.geometry) return null;
    var g = p.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return null;
    p.mesh.updateMatrixWorld(true);
    var b = g.boundingBox.clone().applyMatrix4(p.mesh.matrixWorld);
    return { w: b.max.x - b.min.x, d: b.max.z - b.min.z };
  }

  /* Which of the two lean rings tips the piece ALONG the long dimension of its
     footprint. Tipping about an axis lifts the points that lie across it, so
     the along-length lean is about the horizontal line across the long side
     (plate Z for a footprint longer in X, plate X for one longer in Z); the
     ring whose axis lies the more nearly on that line is it. Returns
     { along, across, square }: ring ids, with `square` set where there is no
     long side to follow (within SQUARE_WITHIN of square, or no line to
     choose by) and the old mapping - front/back is own X - stands. */
  function leanMap(p) {
    if (drag && drag.map) return drag.map;       // held for the length of a drag
    var old = { along: 'fb', across: 'ss', square: true };
    p = p || piece();
    var fp = footprint(p);
    if (!fp) return old;
    var big = Math.max(fp.w, fp.d);
    if (!(big > 0) || Math.abs(fp.w - fp.d) <= SQUARE_WITHIN * big) return old;
    var across = fp.w > fp.d ? v3([0, 0, 1]) : v3([1, 0, 0]);
    var q = p.mesh.quaternion;
    var x = Math.abs(v3(RINGS.fb.local).applyQuaternion(q).dot(across));
    var z = Math.abs(v3(RINGS.ss.local).applyQuaternion(q).dot(across));
    if (Math.abs(x - z) < 1e-6) return old;
    return z > x ? { along: 'ss', across: 'fb', square: false }
                 : { along: 'fb', across: 'ss', square: false };
  }
  /* A ring's role - 'turn', 'fb' (the along lean) or 'ss' (the across lean) -
     and the ring that holds a role. Names, colours and card rows are looked up
     by role; everything that moves or draws is keyed by ring. */
  function roleOf(ring, map) {
    if (ring === 'turn') return 'turn';
    return (map || leanMap()).along === ring ? 'fb' : 'ss';
  }
  function ringOfRole(role, map) {
    if (role === 'turn') return 'turn';
    map = map || leanMap();
    return role === 'fb' ? map.along : map.across;
  }
  function look(ring) { return LOOKS[roleOf(ring)]; }

  /* Which way each lean tips, for the card row's tooltip. */
  var TIP_TAIL = ' Click an arrowhead to lean 1\u00b0, drag it to swing round the ring.';
  function tipFor(role, map) {
    if (role === 'turn')
      return "A ring about the plate's vertical. Click an arrowhead to turn 1\u00b0, drag it to swing round the ring.";
    if (map.square)
      return role === 'fb'
        ? "Tips the piece front over back, about its own X line: its front edge goes up as the back goes down, turning with the piece. (This footprint is square, so there is no long side to follow.)" + TIP_TAIL
        : "Tips the piece side over side, about its own Z line: one side edge goes up as the other goes down, turning with the piece. (This footprint is square, so there is no long side to follow.)" + TIP_TAIL;
    return role === 'fb'
      ? "Tips the piece along its length: its two ends go up and down, turning with the piece." + TIP_TAIL
      : "Tips the piece across its width: one long edge goes up as the other goes down, turning with the piece." + TIP_TAIL;
  }

  /* ---- which rings, for this Rotate session ------------------------------
     Turn only on every opening. The choice lasts while the menu does and is
     not saved anywhere: the teardown that runs when Rotate loses the input
     puts it back (resetSession). `shown` is keyed by ring: a ring that is
     drawn stays drawn when a Turn changes what it is called, and the box that
     is ticked moves to its new row (syncBoxes). */
  var shown = null;
  var lastTouched = null;       // the ring whose arrowhead was pressed last
  var arrowAt = {};             // ring -> angle on the ring where its arrowheads sit
  var seatIdx = {};             // ring -> the major tick the arrowheads were last seated on
  function resetSession() {
    shown = { turn: true, fb: false, ss: false };
    lastTouched = null;
    arrowAt = {};
    seatIdx = {};
    syncBoxes();
  }
  var tipSet = {};
  function syncBoxes() {
    var map = leanMap();
    ORDER.forEach(function (role) {
      var c = document.getElementById(LOOKS[role].chk);
      if (!c) return;
      var on = !!(shown && shown[ringOfRole(role, map)]);
      if (c.checked !== on) c.checked = on;
      var tip = tipFor(role, map), row = c.parentNode;
      if (row && tipSet[role] !== tip) { row.title = tip; tipSet[role] = tip; }
    });
  }
  function shownRings() { return ORDER.filter(function (k) { return shown[k]; }); }
  function setRing(k, on) {
    if (!RINGS[k]) return;
    shown[k] = !!on;
    if (!on && drag && drag.ring === k) endDrag(true);
    if (!on && lastTouched === k) lastTouched = null;
    syncBoxes();
    refresh();
  }
  /* The keyboard's ring: the one last touched, else the only one shown, else
     Turn - the ring every session starts with. */
  function activeRing() {
    var list = shownRings();
    if (lastTouched && shown[lastTouched]) return lastTouched;
    if (list.length === 1) return list[0];
    if (shown.turn) return 'turn';
    return list[0] || null;
  }

  /* ---- the piece --------------------------------------------------------- */
  function piece() {
    if (typeof state === 'undefined' || !state || !state.placed) return null;
    var p = state.placed[state.selectedIndex];
    return (p && p.mesh) ? p : null;
  }

  /* ---- Task 1: the math ------------------------------------------------- */
  function wrapPi(a) {                       // to (-pi, pi]
    a = a % (2 * Math.PI);
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function wrapDeg(d) { return wrapPi(d * RAD) * DEG; }
  function clean(v, digits) { v = +v.toFixed(digits); return v === 0 ? 0 : v; }   // no -0, no 1e-17

  /* The three Euler angles applyMeshRotation hands THREE, read off the fields
     - not recomposed into a rotation, only summed the way it sums them. */
  function fieldEuler(p) {
    return {
      x: (p.tipX || 0) * (Math.PI / 2) + (p.tiltX || 0) * RAD + (p.flipX ? Math.PI : 0),
      y: p.rotY || 0,
      z: (p.tipZ || 0) * (Math.PI / 2) + (p.tiltZ || 0) * RAD
    };
  }

  /* An orientation back to XYZ Euler angles - the order applyMeshRotation
     composes them in, so composing the answer gives this orientation back.

     Every orientation has two XYZ readings, (x, y, z) and (x+pi, pi-y, z+pi).
     THREE's own setFromQuaternion always takes the one with y in [-90, 90],
     which would turn a flat piece yawed to 100 degrees into (180, 80, 180):
     the same rotation, but rotY no longer says 100 and the 90-degree buttons,
     which add to rotY, would then turn it the other way. So the reading
     closest to the piece's current fields is kept, and a drag through 90
     comes out (0, 100, 0) as anyone reading the record would expect.

     At y = +/-90 (gimbal lock) only x+z or x-z is determined; z is held where
     it was and x takes the rest, which again keeps the fields continuous. */
  function decompose(q, prev) {
    var e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;   // column-major
    var m11 = e[0], m12 = e[4], m13 = e[8];
    var m22 = e[5], m23 = e[9];
    var m32 = e[6], m33 = e[10];
    var cy = Math.hypot(m11, m12);
    prev = prev || { x: 0, y: 0, z: 0 };
    if (cy < 1e-7) {
      var y = m13 > 0 ? Math.PI / 2 : -Math.PI / 2;
      var t = Math.atan2(m32, m22);           // x + z at +90, x - z at -90
      var z = prev.z;
      return { x: m13 > 0 ? t - z : t + z, y: y, z: z };
    }
    var a = { x: Math.atan2(-m23, m33), y: Math.atan2(m13, cy), z: Math.atan2(-m12, m11) };
    var b = { x: a.x + Math.PI, y: Math.atan2(m13, -cy), z: a.z + Math.PI };
    var dist = function (s) {
      return Math.abs(wrapPi(s.x - prev.x)) + Math.abs(wrapPi(s.y - prev.y)) +
             Math.abs(wrapPi(s.z - prev.z));
    };
    return dist(b) < dist(a) ? b : a;
  }

  /* Put an orientation on the piece, through the fields. tipX, tipZ and flipX
     are left as they are - whole quarter-turn counts that other buttons step -
     and what is left over goes in the free fields. */
  function writePose(p, q, held) {
    var e = decompose(q, fieldEuler(p));
    p.tiltX = clean(wrapDeg(e.x * DEG - (p.tipX || 0) * 90 - (p.flipX ? 180 : 0)), 9);
    p.rotY = clean(wrapPi(e.y), 12);
    p.tiltZ = clean(wrapDeg(e.z * DEG - (p.tipZ || 0) * 90), 9);
    if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
    /* Held: applyMeshRotation has set the rotation and measured the new box
       (width, depth, height all current); only its seat is undone, putting
       the bounding-sphere centre back on the pivot. */
    if (held && hold && hold.p === p) {
      p.mesh.position.copy(hold.pivot).sub(hold.cL.clone().applyQuaternion(p.mesh.quaternion));
      p.mesh.updateMatrixWorld(true);
      hold.lastPos.copy(p.mesh.position);
      hold.lastQ.copy(p.mesh.quaternion);
    }
    if (typeof refreshOutline === 'function') refreshOutline(p);
  }

  /* A turn of `deg` on a ring. Turn: R(vertical, deg) * q0, on the PLATE's
     side - about the plate, whatever q0 already is. The leans: q0 * R(own
     axis, deg), on the PIECE's side - about the piece's own axis as it lies.
     (The same thing as R(q0 * axis, deg) * q0, which is why frameOf's A is the
     axis the dial and the snap measure about.) */
  function turned(q0, ring, deg) {
    var R = RINGS[ring];
    if (R.frame === 'plate')
      return new THREE.Quaternion().setFromAxisAngle(v3(R.axis), deg * RAD).multiply(q0);
    return q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(v3(R.local), deg * RAD));
  }

  /* Where the piece stands on a ring, in degrees, for the snap to act on.

     A world-axis turn has no "rotY" to read once the piece is leaned, so this
     measures it: the piece's own axis that lies most nearly in the ring's
     plane, projected into that plane, at its angle about the ring's axis.
     That angle moves by EXACTLY d under a turn of d about the axis - the
     projection of R(axis,d) v is the projection of v turned by d - so snapping
     it to a quarter turn puts that edge of the piece square to the plate.
     Which of the piece's axes is measured is fixed when a drag starts. */
  function refAxis(q, ring) {
    var A = frameOf(ring, q).A, best = null, bestLen = -1;
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(function (b) {
      var v = v3(b).applyQuaternion(q);
      var len = 1 - Math.pow(v.dot(A), 2);
      if (len > bestLen + 1e-9) { bestLen = len; best = b; }
    });
    return best;
  }
  /* `F` is the ring's frame to measure in - for a drag, the one it started
     in, which a turn about the ring's own axis leaves unchanged anyway. */
  function ringAngleDeg(q, ring, b, F) {
    F = F || frameOf(ring, q);
    var v = v3(b).applyQuaternion(q);
    return Math.atan2(v.dot(F.e2), v.dot(F.e1)) * DEG;
  }

  /* The hard snap: within SNAP_WITHIN_DEG of a quarter turn, the quarter
     turn; anywhere else, the angle untouched. No pull on either side. */
  function inSnap(deg) {
    return Math.abs(deg - Math.round(deg / SNAP_STEP_DEG) * SNAP_STEP_DEG) <= SNAP_WITHIN_DEG;
  }
  function hardSnapDeg(deg) {
    return inSnap(deg) ? Math.round(deg / SNAP_STEP_DEG) * SNAP_STEP_DEG : deg;
  }

  /* The drag's detents: the tick of the ring's own scale (every DETENT_DEG,
     absolute, in the ring's frame) nearest `deg`, and how far off it is. */
  function detentNear(deg) {
    var k = Math.round(deg / DETENT_DEG);
    return { deg: k * DETENT_DEG, off: Math.abs(deg - k * DETENT_DEG) };
  }
  function inDetent(deg) { return detentNear(deg).off <= SNAP_WITHIN_DEG; }
  function detentSnapDeg(deg) { return inDetent(deg) ? detentNear(deg).deg : deg; }
  function tickDeg(deg) { return ((deg % 360) + 360) % 360; }     // a detent as a tick: [0, 360)

  /* The tick the piece is within the window of on a ring, as its angle in
     [0, 360) - the one that is lit - or null. A drag holds its own measured
     axis (drag.b), so the tick lit is the tick the drag snaps to. */
  function litTickOf(ring, q, F) {
    var b = drag && drag.ring === ring ? drag.b : refAxis(q, ring);
    var d = detentNear(ringAngleDeg(q, ring, b, F));
    return d.off <= SNAP_WITHIN_DEG ? tickDeg(d.deg) : null;
  }

  /* The direction of a drag. The pointer's angle about the ring's projected
     centre, in screen terms (y down, so a growing angle is clockwise), times
     the sign of look . axis. Derivation, for the record: a positive turn
     about A reads counter-clockwise to an eye looking down A from its tip -
     look . A < 0 - so there clockwise on screen is a negative turn, and the
     factor is -1; from the other side it is +1. So the same circle drawn on
     screen turns the piece the same way as the eye sees it, from either side.
     Edge-on (look . A = 0) there is no clockwise to speak of; +1 is used. */
  function dialSign(ring) {
    if (typeof state === 'undefined' || !state || !state.camera) return 1;
    var look = new THREE.Vector3();
    state.camera.getWorldDirection(look);
    var d = look.dot(frameOf(ring, pieceQ()).A);
    return d < 0 ? -1 : 1;
  }

  /* ---- turning ----------------------------------------------------------- */
  function refuse(p) {
    return typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'rotate');
  }
  function undoPoint() {
    if (typeof pushUndo !== 'function' || typeof snapshotPlacedPose !== 'function') return;
    var snap = snapshotPlacedPose(state.selectedIndex);
    /* Inside a run the mesh is held, not seated; the Undo point records the
       height this pose seats at, so Undo restores a seated pose as before. */
    if (snap && hold && holdIntact() && hold.p === state.placed[state.selectedIndex])
      snap.meshY = seatedY(hold.p);
    pushUndo(snap);
  }

  /* One step of `deg` about a ring, no snap - a click, a key. */
  function stepBy(ring, deg) {
    var p = piece();
    if (!p || !RINGS[ring]) return false;
    if (refuse(p)) return false;
    /* a key press is a click without the mouse: one run per ring and way */
    var way = deg < 0 ? -1 : 1;
    if (hold && (hold.ring !== ring || hold.dir !== way)) seat();
    undoPoint();
    startHold(p, ring, way);
    p.mesh.updateMatrixWorld(true);
    writePose(p, turned(p.mesh.quaternion.clone(), ring, deg), true);
    seatLater();
    lastTouched = ring;
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
    say(ring, deg * dialSign(ring), null);
    return true;
  }

  /* ---- dragging ----------------------------------------------------------
     A press on an arrowhead starts this. It is a click until the pointer has
     travelled CLICK_SLOP_PX; released before that, it steps one degree (a tenth with Shift) the way
     the arrowhead points. Past it, it is a dial round the ring. One Undo
     point either way, taken at the press. */
  var drag = null;

  function beginDrag(handle, x, y, cx, cy, fine) {
    var ring = handle && handle.ring ? handle.ring : handle;
    var dir = handle && handle.dir ? handle.dir : 1;
    var p = piece();
    if (!p || !RINGS[ring] || !shown[ring]) return false;
    if (refuse(p)) return false;
    /* a press on the arrowhead a run is on continues it; any other press
       puts that run down first */
    if (hold && (hold.p !== p || hold.ring !== ring || hold.dir !== dir || !holdIntact())) seat();
    undoPoint();
    startHold(p, ring, dir);
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = 0; }   // held for as long as it is pressed
    p.mesh.updateMatrixWorld(true);
    var q0 = p.mesh.quaternion.clone();
    var b = refAxis(q0, ring);
    drag = { ring: ring, dir: dir, x0: x, y0: y, cx: cx, cy: cy,
             lastA: Math.atan2(y - cy, x - cx) * DEG, raw: 0, applied: 0,
             sign: dialSign(ring), q0: q0, b: b, F: frameOf(ring, q0), map: leanMap(p),
             abs0: ringAngleDeg(q0, ring, b),
             arrow0: arrowAt[ring], moved: false, snapped: false, fine: !!fine };
    /* Starting inside a snap is not landing in one: no flash on the way out. */
    drag.snapped = inDetent(drag.abs0);
    lastTouched = ring;
    if (state.controls) state.controls.enabled = false;
    refresh();
    return true;
  }

  function moveDrag(x, y) {
    var p = piece();
    if (!drag || !p) return null;
    var a = Math.atan2(y - drag.cy, x - drag.cx) * DEG;
    var da = a - drag.lastA;
    while (da > 180) da -= 360;
    while (da < -180) da += 360;
    drag.lastA = a;
    drag.raw += drag.sign * da;
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < CLICK_SLOP_PX) return null;
    drag.moved = true;
    var want = drag.abs0 + drag.raw;
    var at = detentSnapDeg(want);
    var snapped = inDetent(want);
    if (snapped && !drag.snapped) flash();
    drag.snapped = snapped;
    drag.applied = at - drag.abs0;
    writePose(p, turned(drag.q0, drag.ring, drag.applied), true);
    if (drag.arrow0 != null) arrowAt[drag.ring] = drag.arrow0 + drag.applied * RAD;
    refresh();
    say(drag.ring, drag.applied * drag.sign, snapped ? tickDeg(at) : null, x, y);
    return { raw: drag.raw, applied: drag.applied, snapped: snapped };
  }

  /* `abandon` is the menu going away under a held arrowhead: whatever was
     dragged stays, but a press that never became a drag does not then step. */
  function endDrag(abandon) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (typeof state !== 'undefined' && state && state.controls) state.controls.enabled = true;
    if (!d.moved && !abandon) {
      /* a click: a step about the held pivot (a degree, a tenth with Shift),
         the run seated RUN_MS on. It turns the PIECE; the darts stay put. */
      var p = piece(), step = d.fine ? FINE_STEP_DEG : STEP_DEG;
      if (p) {
        p.mesh.updateMatrixWorld(true);
        writePose(p, turned(p.mesh.quaternion.clone(), d.ring, d.dir * step), true);
        say(d.ring, d.dir * step * d.sign, null);
      }
      seatLater();
    } else {
      seat();                   // a drag is put down on release; so is an abandoned press
    }
    hideReadoutSoon();
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
  }

  /* ---- the readout -------------------------------------------------------
     Degrees turned since the press, with the way it went AS SEEN FROM HERE -
     the same sense the dial reads the pointer in - so dragging a full lap
     clockwise reads 360 and on past it. Sitting on a detent it also says the
     angle of that tick on the ring ("on 90°"). The status line says the same. */
  var readout = null, readoutTimer = null, flashUntil = 0;
  function fmtDeg(d) {
    var a = Math.abs(d);
    return (Math.abs(a - Math.round(a)) < 0.05 ? Math.round(a) : a.toFixed(1)) + '°';
  }
  /* `tick` is the angle of the detent the piece sits on, or null. */
  function readoutText(ring, seenDeg, tick) {
    return look(ring).label + ' ' + fmtDeg(seenDeg) +
      (Math.abs(seenDeg) < 1e-9 ? '' : (seenDeg > 0 ? ' ⟳' : ' ⟲')) +
      (tick != null ? ' · on ' + fmtDeg(tick) : '');
  }
  function say(ring, seenDeg, tick, x, y) {
    var t = readoutText(ring, seenDeg, tick);
    lastReadout = t;
    if (typeof setStatus === 'function') setStatus('Rotate - ' + t);
    if (!readout) {
      readout = document.createElement('div');
      readout.className = 'nso-rot-readout';
      readout.setAttribute('aria-live', 'polite');
      document.body.appendChild(readout);
    }
    readout.textContent = t;
    readout.style.setProperty('--rot-accent', look(ring).css);
    if (x == null && drag) { x = drag.x0; y = drag.y0; }
    if (x == null) {
      var s = handleScreen(ring, 1);
      if (s) { x = s.x; y = s.y; }
    }
    if (x != null) { readout.style.left = (x + 16) + 'px'; readout.style.top = (y - 30) + 'px'; }
    readout.hidden = false;
    if (readoutTimer) { clearTimeout(readoutTimer); readoutTimer = null; }
    if (!drag) hideReadoutSoon();
  }
  var lastReadout = '';
  function hideReadoutSoon() {
    if (readoutTimer) clearTimeout(readoutTimer);
    readoutTimer = setTimeout(function () { if (readout && !drag) readout.hidden = true; }, 1400);
  }
  function hideReadout() {
    if (readoutTimer) { clearTimeout(readoutTimer); readoutTimer = null; }
    if (readout) readout.hidden = true;
  }
  var flashes = 0;
  function flash() {
    flashes++;
    flashUntil = Date.now() + FLASH_MS;
    setTimeout(refresh, FLASH_MS + 10);
  }

  /* ---- keyboard ----------------------------------------------------------
     One degree (a tenth with Shift) on the keyboard's ring (activeRing): Right or Up turns it
     clockwise as seen from here, Left or Down anticlockwise - the dial's own
     sense. Held down, the browser's key repeat does the repeating. */
  function nudge(dir, fine) {
    var ring = activeRing();
    if (!ring) return false;
    return stepBy(ring, dir * (fine ? FINE_STEP_DEG : STEP_DEG) * dialSign(ring));
  }
  var KEYS = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

  /* Whether this menu owns the input right now. Asked of nsoInputMode rather
     than read off `#menu-rotate.open` directly: Tilt and Move claim the same
     four arrows off their own menus, and the arbiter is what guarantees one
     press is answered once (app-input-mode.js has the whole story). */
  function menuOwnsInput() {
    if (window.nsoInputMode) return window.nsoInputMode.owns('menu-rotate');
    var d = document.getElementById('menu-rotate');
    return !!(d && d.open);
  }

  function onKeyDown(ev) {
    var k = KEYS[ev.key];
    if (!k) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!menuOwnsInput()) return;                  // the scope rule, in one line
    /* Text fields keep their arrows. A checkbox does not use them, and the
       ring boxes are exactly what has focus right after one is ticked - so
       they are let through, or adding a ring would deafen the keys. */
    var t = ev.target;
    if (t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'SELECT' ||
              t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!piece() || !activeRing()) return;
    ev.preventDefault();
    nudge(k, ev.shiftKey);
  }

  /* ---- Task 2: the rings in the scene ----------------------------------- */
  var group = null;

  function ensureGroup() {
    if (typeof THREE === 'undefined' || typeof state === 'undefined' || !state || !state.scene)
      return null;
    if (!group) {
      group = new THREE.Group();
      group.name = 'nso-rotate-handles';
      group.renderOrder = 999;
    }
    return group;
  }
  function clearGroup(g) {
    while (g.children.length) {
      var c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  /* ---- the radius --------------------------------------------------------
     One size, full stop: not one per piece, and no longer one per bed (45%
     of the bed's shorter side made an A1 Mini's rings 81 mm and a 256 mm
     bed's 115 - big hoops round small parts). 40 mm is just enough to
     enclose library/box_closed.stl: a 60 x 40 x 27.3 mm box, so its
     bounding sphere - the sphere the rings are centred on - is 38.55 mm in
     radius, and the tube's inner edge (40 - 0.64) clears it in every pose.
     A piece bigger than the rings is fine - the arrowheads are the handles,
     not the ring body. Ticks and the tube are fractions of this radius. */
  var RING_RADIUS_MM = 40;
  function ringRadius() { return RING_RADIUS_MM; }

  /* ---- the pivot -----------------------------------------------------------
     A turn is about the centre of the piece's bounding sphere - the centre
     of its own geometry's sphere, which the load centres on the mesh origin.
     applyMeshRotation then re-seats the piece on the plate from its NEW box,
     so on every step of a turn the centre rose and fell with the box, and the
     rings, sitting on it, walked away from under the pointer.

     So while a turn is in hand the pivot is HELD: taken once, at the press,
     and the piece is turned about that fixed point - free to pass through
     the plate on the way, which is expected and not clamped - with the rings
     standing on it. The piece is seated on the plate once, when the turn is
     put down, and the rings move to the seated centre in that one step.

     "In hand" is a drag from press to release, and a RUN of clicks on one
     arrowhead (or presses of one arrow key) less than RUN_MS apart: the run
     is seated RUN_MS after its last step, so fifteen clicks of a degree turn
     about one pivot and land once. A single step lands RUN_MS after it.

     The pose fields are written on every step as before - only the mesh's
     height is held - so export, Undo and everything else that reads the
     record never sees anything but a seated pose: every Undo point taken
     inside a run records the height the piece will be seated at. */
  var RUN_MS = 600;
  var hold = null;              // { p, pivot, cL, lastPos, lastQ, ring, dir, timer }
  function localCentre(mesh) {
    var g = mesh.geometry;
    if (!g) return new THREE.Vector3();
    if (!g.boundingSphere) g.computeBoundingSphere();
    return g.boundingSphere ? g.boundingSphere.center.clone() : new THREE.Vector3();
  }
  /* where the origin sits when the piece's lowest point is on the bed
     baseline: its lowest point is nsoBelowOrigin under it, which is half the
     height only for a posed box centred on the origin (nso-bounds.js) */
  function seatedY(p) {
    var below = typeof nsoBelowOrigin === 'function' ? nsoBelowOrigin(p.mesh, p.height) : (p.height || 0) / 2;
    return below + 0.2 + (p.liftY || 0);
  }
  /* the hold is still ours: the piece is exactly where the last held step
     left it - nothing else (an Undo, another tool) has moved it since */
  function holdIntact() {
    var p = hold && hold.p;
    return !!(p && p.mesh && p.mesh.position.distanceTo(hold.lastPos) < 1e-9 &&
              Math.abs(p.mesh.quaternion.dot(hold.lastQ)) > 1 - 1e-12);
  }
  function startHold(p, ring, dir) {
    if (hold && (hold.p !== p || !holdIntact())) dropHold();
    if (hold) return hold;
    p.mesh.updateMatrixWorld(true);
    var cL = localCentre(p.mesh);
    hold = { p: p, cL: cL, pivot: cL.clone().applyMatrix4(p.mesh.matrixWorld),
             lastPos: p.mesh.position.clone(), lastQ: p.mesh.quaternion.clone(),
             ring: ring, dir: dir, timer: 0 };
    return hold;
  }
  function dropHold() {
    if (hold && hold.timer) clearTimeout(hold.timer);
    hold = null;
  }
  /* Put the turn down: seat the piece on the plate, once, as
     applyMeshRotation always has, and let the rings follow in one step. */
  function seat() {
    if (!hold) return;
    var h = hold;
    var mine = holdIntact();
    dropHold();
    if (!mine) return;          // something else has already re-placed it
    if (typeof applyMeshRotation === 'function') applyMeshRotation(h.p);
    if (typeof refreshOutline === 'function') refreshOutline(h.p);
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
  }
  function seatLater() {
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    hold.timer = setTimeout(seat, RUN_MS);
  }

  /* Slim darts riding the rail, not cones sat on it: 7.5 mm long and 3.6 mm
     across the base (the old ones were 14.58 x 13.1 mm), kept as a fraction
     of the fixed radius. The grab target stays wider than the dart (HIT). */
  var ARROW_FRACTION = 7.5 / RING_RADIUS_MM;
  var ARROW_BASE = 0.24;        // base radius, x length
  var ARROW_HIT = 0.8;          // grab sphere radius, x length: the pair's spheres just touch
  function arrowSize(r) { return r * ARROW_FRACTION; }
  /* The two arrowheads sit either side of arrowAt[ring], a little apart,
     pointing away from each other along the ring. */
  function arrowGap(r) { return arrowSize(r) * 0.8 / r; }
  function ringPoint(F, r, t) {
    return F.e1.clone().multiplyScalar(Math.cos(t) * r).add(F.e2.clone().multiplyScalar(Math.sin(t) * r));
  }
  function ringTangent(F, t) {
    return F.e1.clone().multiplyScalar(-Math.sin(t)).add(F.e2.clone().multiplyScalar(Math.cos(t)));
  }

  /* WHERE THE DARTS SIT. On a major tick of their ring - every MAJOR_DEG in
     the ring's own frame, the frame the scale is drawn in - the one nearest
     the camera, which is the camera's angle about the ring's axis (its
     position, less the ring's centre, projected into the ring's plane) rounded
     to a major tick. Never between two.

     They are seated, not tracked: once on a tick they stay while the camera
     is within half a tick of it PLUS SEAT_HYST_DEG, and only past that move
     to the tick nearest now. A camera hovering at the half-way point
     therefore sits still instead of flickering between two ticks. Looking
     straight down a ring's axis there is no nearest side, and they stay
     where they are (the first time, on tick 0). `seatIdx` is the memory; it
     is written only when `commit` is set, so the camera listener can ask
     whether a move is due without making one. */
  function cameraAngleDeg(F, centre) {
    if (!state.camera) return null;
    var v = state.camera.position.clone().sub(centre);
    var u = v.dot(F.e1), w = v.dot(F.e2), len = v.length();
    return (len < 1e-9 || Math.hypot(u, w) < 1e-3 * len) ? null : Math.atan2(w, u) * DEG;
  }
  function tickCount() { return Math.round(360 / MAJOR_DEG); }
  function seatFor(ring, F, centre, commit) {
    var n = tickCount(), c = cameraAngleDeg(F, centre), k = seatIdx[ring];
    if (c != null) {
      var near = ((Math.round(c / MAJOR_DEG) % n) + n) % n;
      if (k == null || Math.abs(wrapDeg(c - k * MAJOR_DEG)) > MAJOR_DEG / 2 + SEAT_HYST_DEG) k = near;
    }
    if (k == null) k = 0;
    if (commit) seatIdx[ring] = k;
    return k;
  }

  /* ---- weights -----------------------------------------------------------
     At rest every ring is drawn the same. While one is dragged the rails get
     QUIETER, not louder: the active ring thins and goes see-through so the
     piece reads through it at the moment its angle is being judged, and the
     other two fade to a trace. The arrowhead under the pointer keeps full
     weight, so the grab point never goes soft. Colours never change - the one
     white is the snap's flash. Release, and refresh draws rest weight again. */
  var WEIGHT = {
    rest:     { tube: 1,   ring: 0.7,  arrow: 0.95, ticks: 0.85 },
    active:   { tube: 0.6, ring: 0.35, arrow: 0.35, ticks: 0.35 },
    inactive: { tube: 1,   ring: 0.12, arrow: 0.12, ticks: 0.06 }
  };
  /* A press is not yet a drag: a click on an arrowhead leaves the rails at
     rest weight, and they go quiet only once the pointer has really moved. */
  function dragging() { return !!(drag && drag.moved); }
  function weightFor(ring) {
    if (!dragging()) return WEIGHT.rest;
    return drag.ring === ring ? WEIGHT.active : WEIGHT.inactive;
  }
  function restTube(r) { return Math.max(0.3, r * 0.016); }

  function colourFor(ring) {
    var lit = drag && drag.ring === ring;
    if (lit && Date.now() < flashUntil) return { c: 0xffffff, o: 1 };
    return { c: look(ring).color, o: weightFor(ring).ring };
  }

  /* ---- the scale ---------------------------------------------------------
     Ticks on the ring's outer edge - short every 5, longer every 15, longest
     on the quarters. No numbers: the readout beside the pointer says the
     angle. All of it is in the ring's own frame (the same e1, e2 the snap
     measures in), so it turns with nothing: it is the fixed scale the piece
     turns against, and a snapped quarter turn puts the piece's measured axis
     exactly on a long tick.

     Each tick is a solid square bar, not a line: WebGL draws lines one pixel
     wide whatever is asked, which left the scale a faint fuzz behind the
     rail. The bars are as thick as a good part of the rail and drawn at
     least as solid, so the scale reads with it. All of a ring's bars are one
     mesh, one draw call; userData.nsoTickEnds keeps each tick's inner and
     outer point for the checks. */
  var TICK_STEP_DEG = 5;
  var TICK_LEN = { 5: 0.05, 15: 0.09, 90: 0.15 };      // x radius
  var TICK_WIDTH = { 5: 0.45, 15: 0.6, 90: 0.8 };      // mm, square section
  function tickClass(deg) { return deg % 90 === 0 ? 90 : deg % 15 === 0 ? 15 : 5; }
  function noRaycast() {}

  function addTicks(g, ring, F, r, w) {
    var e1 = F.e1, e2 = F.e2, A = F.A, ends = [], pos = [];
    var r0 = r + restTube(r), m = new THREE.Matrix4(), v = new THREE.Vector3();
    for (var d = 0; d < 360; d += TICK_STEP_DEG) {
      var t = d * RAD, k = tickClass(d), len = TICK_LEN[k] * r, wd = TICK_WIDTH[k];
      var u = e1.clone().multiplyScalar(Math.cos(t)).add(e2.clone().multiplyScalar(Math.sin(t)));
      var tan = A.clone().cross(u);
      ends.push(u.x * r0, u.y * r0, u.z * r0, u.x * (r0 + len), u.y * (r0 + len), u.z * (r0 + len));
      /* the bar: length along u, its square section across tan and A */
      m.makeBasis(u, tan, A).setPosition(u.clone().multiplyScalar(r0 + len / 2));
      var box = new THREE.BoxGeometry(len, wd, wd).toNonIndexed(), bp = box.attributes.position;
      for (var i = 0; i < bp.count; i++) {
        v.fromBufferAttribute(bp, i).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
      }
      box.dispose();
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    var l = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: look(ring).color, depthTest: false,
      depthWrite: false, transparent: true, opacity: w.ticks }));
    l.renderOrder = 999;
    l.raycast = noRaycast;
    l.userData.nsoRotateTicks = ring;
    l.userData.nsoTickEnds = ends;
    g.add(l);
  }

  /* The lit tick: the one tick of the ring the piece is within the snap
     window of, drawn longer and thicker than its neighbours and at full
     strength - through a drag too, when the rest of the scale has gone quiet.
     userData.nsoRotateLit is its angle; nsoTickEnds its inner and outer point. */
  var LIT_LEN = 0.2, LIT_WIDTH = 1.4;      // x radius, mm
  function addLit(g, ring, F, r, deg) {
    var t = deg * RAD, len = LIT_LEN * r, r0 = r + restTube(r);
    var u = F.e1.clone().multiplyScalar(Math.cos(t)).add(F.e2.clone().multiplyScalar(Math.sin(t)));
    var m = new THREE.Matrix4().makeBasis(u, F.A.clone().cross(u), F.A)
      .setPosition(u.clone().multiplyScalar(r0 + len / 2));
    var geo = new THREE.BoxGeometry(len, LIT_WIDTH, LIT_WIDTH);
    geo.applyMatrix4(m);
    var l = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: look(ring).color, depthTest: false,
      depthWrite: false, transparent: true, opacity: 1 }));
    l.renderOrder = 999;
    l.raycast = noRaycast;
    l.userData.nsoRotateLit = { ring: ring, deg: deg };
    l.userData.nsoTickEnds = [u.x * r0, u.y * r0, u.z * r0, u.x * (r0 + len), u.y * (r0 + len), u.z * (r0 + len)];
    g.add(l);
  }

  function addRing(g, ring, F, r) {
    var col = colourFor(ring), w = weightFor(ring);
    var tube = restTube(r) * w.tube;
    var geo = new THREE.TorusGeometry(r, tube, 6, 160);
    // Torus lies in XY with its axis on Z: carry X, Y, Z onto e1, e2, A.
    geo.applyMatrix4(new THREE.Matrix4().makeBasis(F.e1, F.e2, F.A));
    var mat = new THREE.MeshBasicMaterial({ color: col.c, depthTest: false, depthWrite: false,
                                            transparent: true, opacity: col.o });
    var m = new THREE.Mesh(geo, mat);
    m.renderOrder = 999;
    m.userData.nsoRotateRing = ring;          // the track: drawn, never a handle
    g.add(m);
    addTicks(g, ring, F, r, w);
    var lit = litTickOf(ring, pieceQ(), F);
    if (lit != null) addLit(g, ring, F, r, lit);

    var t = arrowAt[ring], h = arrowSize(r), gap = arrowGap(r);
    [1, -1].forEach(function (dir) {
      var at = t + dir * gap;
      var pos = ringPoint(F, r, at);
      var tan = ringTangent(F, at).multiplyScalar(dir);
      var handle = { ring: ring, dir: dir };
      /* the arrowhead under the pointer keeps full weight through a drag */
      var held = dragging() && drag.ring === ring && drag.dir === dir;
      var cone = new THREE.Mesh(new THREE.ConeGeometry(h * ARROW_BASE, h, 18),
        new THREE.MeshBasicMaterial({ color: held ? look(ring).color : col.c, depthTest: false,
                                      depthWrite: false, transparent: true,
                                      opacity: held ? 1 : (col.c === 0xffffff ? 1 : w.arrow) }));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
      cone.position.copy(pos);
      cone.renderOrder = 1000;
      cone.userData.nsoRotateHandle = handle;
      g.add(cone);
      /* A grab target a little bigger than the cone, drawn as nothing. The
         raycaster still finds it: it tests the geometry, not the material. */
      var hit = new THREE.Mesh(new THREE.SphereGeometry(h * ARROW_HIT, 10, 8),
        new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.copy(pos);
      hit.userData.nsoRotateHandle = handle;
      g.add(hit);
    });
  }

  /* The rings exist only while this menu owns the input. Losing it EMPTIES
     the group, disposing every geometry and material, so there is nothing
     left in the scene for app-core's pointerdown to hit - it hit-tests this
     group ahead of select-and-drag, and `visible` is the flag it trusts. */
  function refresh() {
    var g = ensureGroup();
    if (!g) return;
    clearGroup(g);
    var p = piece();
    var list = shown ? shownRings() : [];
    if (shown) syncBoxes();
    if (hold && !holdIntact()) dropHold();      // re-placed under us: nothing held any more
    if (!p || !list.length || !menuOwnsInput()) { g.visible = false; return; }
    /* A helper (nso-helpers.js): put in the scene when there are rings to
       draw, and put back here after a leave, a Clear or an Undo took it out.
       Interactive: the rings are grabbed. */
    if (g.parent !== state.scene) nsoHelpers.attach(state.scene, g, 'rotate', { interactive: true });
    hookCamera();
    g.visible = true;
    g.position.copy(ringCentre(p));
    g.updateMatrixWorld(true);
    var r = ringRadius(), q = p.mesh.quaternion.clone();
    list.forEach(function (ring) {
      var F = frameOf(ring, q);
      /* A dragged ring's darts ride the piece under the pointer (moveDrag);
         at every other moment they are seated on a major tick. */
      if (!dragging() || arrowAt[ring] == null)
        arrowAt[ring] = seatFor(ring, F, g.position, true) * MAJOR_DEG * RAD;
      addRing(g, ring, F, r);
    });
  }

  /* Rotate's rails, for the helper registry: live while the menu owns the
     input; refresh() is the one drawing path, and empties them when there is
     nothing to show. */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('rotate', { live: menuOwnsInput, refresh: refresh, clear: refresh });

  /* The camera's orbit moves the darts, so the rings are told when it moves.
     OrbitControls says 'change' on every move of the camera; the check is a
     frame and a rounding per shown ring, and it redraws only if a dart is due
     to move. Hooked from refresh(), by which time the controls exist. */
  var camHooked = null;
  function hookCamera() {
    var c = state.controls;
    if (!c || camHooked === c || typeof c.addEventListener !== 'function') return;
    camHooked = c;
    c.addEventListener('change', onCameraMoved);
  }
  function onCameraMoved() {
    var p = piece();
    if (!group || !group.visible || !shown || !p || dragging()) return;
    var q = p.mesh.quaternion;
    var due = shownRings().some(function (ring) {
      return seatFor(ring, frameOf(ring, q), group.position, false) !== seatIdx[ring];
    });
    if (due) refresh();
  }

  /* Where the rings stand: on the held pivot while a turn is in hand,
     otherwise on the piece's bounding-sphere centre as it sits. */
  function ringCentre(p) {
    if (hold && hold.p === p && holdIntact()) return hold.pivot.clone();
    p.mesh.updateMatrixWorld(true);
    return localCentre(p.mesh).applyMatrix4(p.mesh.matrixWorld);
  }

  /* An arrowhead's place on screen, in client pixels - for the checks, and
     for the readout after a key press. */
  function handleScreen(ring, dir) {
    var p = piece();
    if (!p || !state.camera || !state.renderer || arrowAt[ring] == null) return null;
    var r = ringRadius();
    var w = ringPoint(frameOf(ring, pieceQ()), r, arrowAt[ring] + (dir || 1) * arrowGap(r)).add(ringCentre(p));
    var v = w.project(state.camera);
    var c = state.renderer.domElement.getBoundingClientRect();
    return { x: c.left + (v.x * 0.5 + 0.5) * c.width, y: c.top + (-v.y * 0.5 + 0.5) * c.height };
  }
  function centreScreen() {
    var p = piece();
    if (!p || !state.camera || !state.renderer) return null;
    var v = ringCentre(p).project(state.camera);
    var c = state.renderer.domElement.getBoundingClientRect();
    return { x: c.left + (v.x * 0.5 + 0.5) * c.width, y: c.top + (-v.y * 0.5 + 0.5) * c.height };
  }

  /* ---- wiring ------------------------------------------------------------ */
  function bind() {
    if (!shown) resetSession();
    /* A row is a ROLE (Turn, Lean front/back, Lean side/side); the ring it
       ticks is whichever one holds that role now. */
    ORDER.forEach(function (role) {
      var chk = document.getElementById(LOOKS[role].chk);
      if (chk && !chk._rotBound) {
        chk._rotBound = true;
        chk.addEventListener('change', function () { setRing(ringOfRole(role), chk.checked); });
      }
    });
    syncBoxes();
    if (!document._rotKeysBound) {
      document._rotKeysBound = true;
      document.addEventListener('keydown', onKeyDown);
    }
    /* Losing the menu ends any drag in flight before the rings go - endDrag
       gives OrbitControls back - and puts the ring choice back to Turn only,
       which is what makes the next opening start fresh. */
    if (window.nsoInputMode) {
      window.nsoInputMode.register('menu-rotate', {
        activate: refresh,
        teardown: function () { if (drag) endDrag(true); seat(); hideReadout(); resetSession(); refresh(); }
      });
    }
    refresh();
  }

  window.nsoRotate = {
    rings: function () { return shownRings(); },
    setRing: setRing,
    activeRing: activeRing,
    step: function (ring, dir, fine) { return stepBy(ring, (dir < 0 ? -1 : 1) * (fine ? FINE_STEP_DEG : STEP_DEG)); },
    /* A programmatic turn of `deg` about a ring's axis - the plate's vertical
       for Turn, the piece's own X / Z for the leans - no Undo point and no
       lock check: what a click does, without the click. The pose
       buttons (app-core's rotateSelected / tiltSelected / bankSelected) call
       this and keep their own Undo, lock and status around it.

       opts.snap: land on a quarter turn if the turn ends within the hard
       snap of one - the drag's own snap, measured the drag's own way
       (ringAngleDeg on the piece's axis nearest the ring's plane), so a 90
       degree button from 2 degrees off square lands ON square and a run of
       them stays exact. Off by default: a click, a key and a tilt step are
       exactly what they say. */
    turn: function (ring, deg, opts) {
      var p = piece();
      if (!p || !RINGS[ring]) return false;
      p.mesh.updateMatrixWorld(true);
      var q0 = p.mesh.quaternion.clone();
      if (opts && opts.snap) {
        var abs0 = ringAngleDeg(q0, ring, refAxis(q0, ring));
        deg = hardSnapDeg(abs0 + deg) - abs0;
      }
      writePose(p, turned(q0, ring, deg));
      refresh();
      return true;
    },
    nudge: nudge,
    beginDrag: beginDrag, moveDrag: moveDrag, endDrag: endDrag,
    dragging: function () { return !!drag; },
    dragState: function () {
      return drag ? { ring: drag.ring, raw: drag.raw, applied: drag.applied, sign: drag.sign,
                      moved: drag.moved, snapped: drag.snapped } : null;
    },
    /* A ring's axis in the world, now: the plate's vertical for Turn, the
       piece's own Z / X as it lies for the two leans. */
    ringAxis: function (ring) { return RINGS[ring] ? frameOf(ring, pieceQ()).A.toArray() : null; },
    ringFrame: function (ring) {
      if (!RINGS[ring]) return null;
      var F = frameOf(ring, pieceQ());
      return { A: F.A.toArray(), e1: F.e1.toArray(), e2: F.e2.toArray() };
    },
    /* The piece's angle on a ring as the snap sees it (see ringAngleDeg). */
    ringAngle: function (ring) {
      var p = piece();
      if (!p) return null;
      p.mesh.updateMatrixWorld(true);
      var q = p.mesh.quaternion;
      return ringAngleDeg(q, ring, refAxis(q, ring));
    },
    /* What each lean is called now (see leanMap): the ring ids that hold the
       along-length and the across-width lean, whether the footprint is square
       enough that the old mapping stands, and any ring's name / role. */
    leanNames: function () {
      var m = leanMap();
      return { along: m.along, across: m.across, square: m.square,
               labels: { fb: look('fb').label, ss: look('ss').label },
               roles: { fb: roleOf('fb', m), ss: roleOf('ss', m) },
               tips: { fb: tipFor('fb', m), ss: tipFor('ss', m) } };
    },
    ringLabel: function (ring) { return RINGS[ring] ? look(ring).label : null; },
    ringColor: function (ring) { return RINGS[ring] ? look(ring).color : null; },
    /* Where a ring's darts are: the major tick they sit on, and the angle in
       the ring's frame they are drawn at (a drag carries it off the tick). */
    dartTick: function (ring) {
      return RINGS[ring] && seatIdx[ring] != null
        ? { index: seatIdx[ring], deg: seatIdx[ring] * MAJOR_DEG, at: arrowAt[ring] * DEG } : null;
    },
    dialSign: dialSign,
    hardSnapDeg: hardSnapDeg,
    detentSnapDeg: detentSnapDeg,
    /* The tick of a ring that is lit now - its angle in [0, 360) - or null. */
    litTick: function (ring) {
      var p = piece();
      if (!p || !RINGS[ring]) return null;
      p.mesh.updateMatrixWorld(true);
      var q = p.mesh.quaternion.clone();
      return litTickOf(ring, q, drag && drag.ring === ring ? drag.F : frameOf(ring, q));
    },
    decompose: decompose,
    readout: function () { return lastReadout; },
    readoutShown: function () { return !!(readout && !readout.hidden); },
    flashes: function () { return flashes; },
    handleScreen: handleScreen,
    centreScreen: centreScreen,
    refresh: refresh,
    handleCount: function () {
      var g = ensureGroup();
      return g ? g.children.filter(function (c) {   // arrowheads drawn, not their grab spheres
        return c.userData.nsoRotateHandle && c.material && c.material.visible;
      }).length : 0;
    },
    /* The ring radius: RING_RADIUS_MM, the same for every piece and bed. */
    ringRadius: function () { return ringRadius(); },
    /* The piece a turn is holding on its pivot (unseated) right now, or null -
       nso-watch asks, so a turn in hand is not reported as a piece off its bed. */
    holding: function () { return hold && holdIntact() ? hold.p : null; },
    pivot: function () { return hold && holdIntact() ? hold.pivot.toArray() : null; },
    ringCentre: function () { var p = piece(); return p ? ringCentre(p).toArray() : null; },
    /* Put a run down now, as its timer would. */
    seat: seat,
    weights: WEIGHT,
    ringCount: function () {
      var g = ensureGroup();
      return g ? g.children.filter(function (c) { return c.userData.nsoRotateRing; }).length : 0;
    },
    constants: { STEP_DEG: STEP_DEG, FINE_STEP_DEG: FINE_STEP_DEG, SNAP_STEP_DEG: SNAP_STEP_DEG,
                 SNAP_WITHIN_DEG: SNAP_WITHIN_DEG, DETENT_DEG: DETENT_DEG, CLICK_SLOP_PX: CLICK_SLOP_PX,
                 RING_RADIUS_MM: RING_RADIUS_MM, ARROW_FRACTION: ARROW_FRACTION,
                 ARROW_BASE: ARROW_BASE, ARROW_HIT: ARROW_HIT,
                 RUN_MS: RUN_MS, TICK_STEP_DEG: TICK_STEP_DEG, TICK_LEN: TICK_LEN, TICK_WIDTH: TICK_WIDTH,
                 MAJOR_DEG: MAJOR_DEG, SEAT_HYST_DEG: SEAT_HYST_DEG, SQUARE_WITHIN: SQUARE_WITHIN,
                 LOCAL: { fb: RINGS.fb.local, ss: RINGS.ss.local } }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
