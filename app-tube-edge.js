// ===================== Tube edge: the card =====================
// The geometry is nso_tube_edge.js (headless, tools/nso_tube_edge_test.js);
// this file is the card on it, in Finish -> Shape, beside Bend.
// docs/TUBE-EDGE.md.
//
// Flare, Roll or Neck; Way Out or In for the first two (a Roll refuses In:
// not yet); Walls (Both, Outside only, Bore only) for Flare and Neck; then
// the verb's numbers:
//   Flare  Length, Angle and Δr (linked: edit either, the other follows;
//          below 0 turns it in), Profile Straight or Trumpet
//   Roll   Radius, Angle (90 / 180 / 270 offered, any typed up to 360)
//   Neck   Length, Δr (below 0 pinches, above 0 bulges), Profile Smooth or
//          Funnel - nso_tube_neck.js, a band anywhere along the tube
// and Set or Cancel.
//
// While the card is open:
//   - a GHOST of the result sits on the piece, drawn as Bend's is (amber,
//     0.75), from the very soup Set would commit: every change runs
//     NSO_tubeEdgeRaw and the ghost is what came back. A refusal takes the
//     ghost away and the readout says why;
//   - an amber RING marks the end being treated, drawn through the piece -
//     for Neck, two rings mark the band's two ends and a third its waist
//     (the handles, below);
//   - a click on the piece picks the end nearest the click (captured ahead
//     of select-and-drag, so the click does not move the piece). Bend's
//     "where" interaction, for an end. For Neck the click is where the band
//     is centred, along the tube.
//   - NECK HANDLES: three rings on the tube, each one a grab. The two END
//     rings are the band's length: drag one along the axis and the Length
//     changes by twice the move, the centre held. The WAIST ring is Δr: drag
//     it toward the axis to pinch, away to bulge. The BAND - anywhere between
//     the end rings - drags along the axis and moves the neck; a press on it
//     that does not travel is still the click that centres the band there.
//     Steps of 0.5 mm, 0.1 with Shift (the Length moves two steps, one per
//     end). Arrow keys: Up / Down move the band 1 mm along the axis (Up is
//     the way the axis goes up the screen), Left / Right Δr -1 / +1; Shift
//     0.1 - Rotate's rails convention. Escape puts a drag back where it
//     started, and with no drag shuts the card. Hover names the handle's
//     value in the readout. The Length / Δr fields are the readouts: the
//     handles write them and the ghost follows, as typing does. A press on a
//     handle is taken at the window, ahead of app-core and OrbitControls, so
//     no drag here ever orbits the camera.
//   - FLARE HANDLE: one LIP ring where the lip will be. Drag it toward or
//     away from the axis and that is Δr (inward below 0); along the axis and
//     that is the Length - both at once, each in the same steps as Neck's.
//     Left / Right are Δr, Up / Down the Length (Up the way the axis goes up
//     the screen); Escape and Shift as Neck's. A drag writes Length and Δr
//     (Angle follows) and sets Way back to Out: the sign is Δr's.
//   - WALLS moves the handles onto the face that moves: the bore with Bore
//     only, the outside with Outside only; with Both, Flare's lip ring is on
//     the wall's mid-line and Neck's rings on the outside, as they were.
//     Hover names the face (Wall, Outside, Bore).
//
// Set commits through the sculpt commit (undo type 'tubeEdgeReplace', or
// 'tubeNeckReplace' for a neck), so one Undo puts the whole piece back, and
// the piece re-seats on the plate the way any bake does. Several necks on one
// tube are several Sets, each its own Undo.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: the end
// face is taken out and the wall rebuilt past it, and the commit re-seats the
// whole piece, so no paint can be promised to land where it was. Any paint
// stands it down, naming the count: nsoMaskCount(m) is the whole test.

var TUBE_EDGE_GHOST_COLOR = 0xf59e0b;      // Bend's ghost
var TUBE_EDGE_RING_COLOR = 0xffc83d;       // Bend's marker frame
var TUBE_EDGE_RENDER_ORDER = 20;
var TUBE_EDGE_WAIST_COLOR = 0xff8a3d;      // the neck's waist ring, told from its two ends
var TUBE_EDGE_HOT_COLOR = 0xffffff;        // the handle under the pointer, or in hand
var TUBE_NECK_STEP_MM = 0.5;               // a drag's step (the fields' own)
var TUBE_NECK_KEY_MM = 1;                  // an arrow key
var TUBE_NECK_FINE_MM = 0.1;               // either, with Shift
var TUBE_NECK_HIT_PX = 8;                  // how near a ring the pointer must be to take it
var TUBE_NECK_SLOP_PX = 4;                 // a press on the band that travels less is a click

function NSO_teUI() {
  if (typeof state === 'undefined') return {};
  if (!state.tubeEdge) {
    state.tubeEdge = { open: false, modelId: null, soup: null, read: null, point: null, result: null, key: '',
                       ghost: null, ring: null, raf: 0, lead: 'angle', readVerb: '', hidPiece: null,
                       drag: null, hover: null, said: null };
  }
  return state.tubeEdge;
}
function NSO_teEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_teModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_teMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : (state.previewMesh || null);
}
// Raw (z up) -> the piece's display frame: (x, z, -y) - centerOffset.
function NSO_teRawToDisplay(m, p) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [p[0] - o.x, p[2] - o.y, -p[1] - o.z];
}
function NSO_teDisplayToRaw(m, d) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [d.x + o.x, -(d.z + o.z), d.y + o.y];
}

/* The card's numbers as NSO_tubeEdgeRaw opts. */
function NSO_teOpts() {
  function num(id) { var el = NSO_teEl(id); return el && el.value !== '' ? +el.value : null; }
  function val(id, d) { var el = NSO_teEl(id); return el ? el.value : d; }
  var B = NSO_teUI(), verb = val('sel-te-verb', 'flare');
  // Walls (Both / Outside only / Bore only), Neck's and Flare's: the card's
  // sel-te-walls when it has one, Both when it does not
  var walls = val('sel-te-walls', 'both');
  if (verb === 'neck') {
    return { verb: 'neck', point: B.point, length: num('inp-te-neck-length'), dr: num('inp-te-neck-dr'),
             profile: val('sel-te-neck-profile', 'smooth'), walls: walls };
  }
  var o = { verb: verb, direction: val('sel-te-dir', 'out'), point: B.point };
  if (verb === 'flare') {
    o.length = num('inp-te-length'); o.profile = val('sel-te-profile', 'straight'); o.walls = walls;
    if (B.lead === 'dr') o.dr = num('inp-te-dr'); else o.angle = num('inp-te-angle');
  } else {
    o.radius = num('inp-te-radius'); o.angle = num('inp-te-roll-angle');
  }
  return o;
}

/* Angle and Δr are one number said two ways over the Length: edit either,
   the other follows; a new Length keeps whichever was edited last. */
function NSO_teLink(from) {
  var B = NSO_teUI(), L = NSO_teEl('inp-te-length'), A = NSO_teEl('inp-te-angle'), D = NSO_teEl('inp-te-dr');
  if (!L || !A || !D) return;
  if (from === 'angle' || from === 'dr') B.lead = from;
  var len = +L.value;
  if (!(len > 0)) return;
  if (B.lead === 'dr') {
    if (D.value === '' || !isFinite(+D.value)) return;
    A.value = String(Math.round(Math.atan2(+D.value, len) * 180 / Math.PI * 10) / 10);
  } else {
    if (A.value === '' || !isFinite(+A.value)) return;
    D.value = String(Math.round(len * Math.tan(+A.value * Math.PI / 180) * 100) / 100);
  }
}

/* ---------------------------------------------------------------- drawing */

function NSO_teRemoveGhost() {
  var B = NSO_teUI();
  if (B.ghost) {
    if (B.ghost.parent) B.ghost.parent.remove(B.ghost);
    if (B.ghost.geometry) B.ghost.geometry.dispose();
    if (B.ghost.material) B.ghost.material.dispose();
    B.ghost = null;
  }
  // a neck's ghost hid the piece it stands in: show it again
  if (B.hidPiece) { B.hidPiece.visible = true; B.hidPiece = null; }
}
function NSO_teRemoveRing() {
  var B = NSO_teUI();
  if (B.ring) {
    if (B.ring.parent) B.ring.parent.remove(B.ring);
    B.ring.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    B.ring = null;
  }
}
function NSO_teClear() { NSO_teRemoveGhost(); NSO_teRemoveRing(); }

// hidePiece: a neck's ghost lies inside the piece wherever it pinches, so
// while it is up the piece itself is hidden (the ghost is the whole result,
// and the band's rings mark where it changed); NSO_teRemoveGhost shows it.
function NSO_teSetGhost(m, tris, hidePiece) {
  NSO_teRemoveGhost();
  if (typeof THREE === 'undefined' || !state.scene || !tris || typeof rawResultToDisplayGeometry !== 'function') return;
  var geo = rawResultToDisplayGeometry(tris, m.centerOffset);
  var g = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: TUBE_EDGE_GHOST_COLOR, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  g.name = 'tubeEdgeGhost';
  g.userData.tubeEdgeGhost = true;
  g.userData.skipXray = true;
  g.matrixAutoUpdate = false;
  nsoHelpers.attach(state.scene, g, 'tube-edge');
  NSO_teUI().ghost = g;
  var mesh = hidePiece ? NSO_teMeshOf(m) : null;
  if (mesh && mesh.visible) { mesh.visible = false; NSO_teUI().hidPiece = mesh; }
  NSO_teFollow();
}

// The end being treated: its two circles, amber, read through the piece.
function NSO_teSetRing(m, end) {
  NSO_teRemoveRing();
  if (typeof THREE === 'undefined' || !state.scene || !end) return;
  var group = new THREE.Group();
  group.name = 'tubeEdgeRing';
  group.matrixAutoUpdate = false;
  var C = end.center, e1 = end.frame.e1, e2 = end.frame.e2;
  [end.Ro, end.Ri].forEach(function (r) {
    var pts = [];
    for (var i = 0; i < 96; i++) {
      var a = 2 * Math.PI * i / 96, c = Math.cos(a) * r, s = Math.sin(a) * r;
      pts.push(NSO_teRawToDisplay(m, [C[0] + c * e1[0] + s * e2[0], C[1] + c * e1[1] + s * e2[1], C[2] + c * e1[2] + s * e2[2]]));
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: TUBE_EDGE_RING_COLOR, transparent: true, depthTest: false, depthWrite: false }));
    line.renderOrder = TUBE_EDGE_RENDER_ORDER; line.userData.skipXray = true; line.userData.tubeEdgeRing = true;
    line.raycast = function () {}; line.frustumCulled = false;
    group.add(line);
  });
  // Flare's handle: the lip ring, where the moving face's lip will be
  var g = NSO_teFlareGeom(), B = NSO_teUI();
  if (g) {
    var hot = B.drag ? B.drag.handle : B.hover;
    group.add(NSO_teCircle(m, g, NSO_teAxisPoint(g, g.h0), g.Rl, hot === 'lip' ? TUBE_EDGE_HOT_COLOR : TUBE_EDGE_WAIST_COLOR, 'lip', TUBE_EDGE_WAIST_COLOR));
  }
  group.userData.center = NSO_teRawToDisplay(m, C);
  nsoHelpers.attach(state.scene, group, 'tube-edge');
  NSO_teUI().ring = group;
  NSO_teFollow();
}
// One handle circle: centre O (raw), radius rad, in the plane of g.e1 / g.e2.
function NSO_teCircle(m, g, O, rad, color, handle, baseColor) {
  var pts = [];
  for (var i = 0; i < 96; i++) {
    var ang = 2 * Math.PI * i / 96, c = Math.cos(ang) * rad, s = Math.sin(ang) * rad;
    pts.push(NSO_teRawToDisplay(m, [O[0] + c * g.e1[0] + s * g.e2[0], O[1] + c * g.e1[1] + s * g.e2[1], O[2] + c * g.e1[2] + s * g.e2[2]]));
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: color, transparent: true, depthTest: false, depthWrite: false }));
  line.renderOrder = TUBE_EDGE_RENDER_ORDER; line.userData.skipXray = true; line.userData.tubeEdgeRing = true;
  line.userData.teHandle = handle; line.userData.teColor = baseColor;
  line.raycast = function () {}; line.frustumCulled = false;
  return line;
}

/* The neck as the handles see it, from the read and the card - not from the
   last result, so the rings stay up (and can be dragged back) through a
   refusal: the axis, the centre h0 (mm along the axis from the end it was
   read off; B.point projected, else the middle), the band's ends ha / hb,
   the wall's outside radius there and the waist's (Ro + Δr). Null when there
   is no tube read or no Length to draw. */
function NSO_teNeckGeom() {
  var B = NSO_teUI(), m = NSO_teModel();
  if (!m || !B.read || !B.read.ok || B.readVerb !== 'neck' || NSO_teVerb() !== 'neck') return null;
  var tb = B.read.tube, C = tb.center, a = tb.axis;
  var NL = NSO_teEl('inp-te-neck-length'), ND = NSO_teEl('inp-te-neck-dr');
  var L = NL ? +NL.value : NaN, dr = ND && ND.value !== '' ? +ND.value : 0;
  if (!(L > 0) || !isFinite(L)) return null;
  if (!isFinite(dr)) dr = 0;
  var h0 = (tb.hMin + tb.hMax) / 2, walls = NSO_teWallsVal(), atEnd = null;
  if (B.point) h0 = (B.point[0] - C[0]) * a[0] + (B.point[1] - C[1]) * a[1] + (B.point[2] - C[2]) * a[2];
  // one face: a band that reaches an end is laid from it, Length in (the
  // engine's socket / spigot, nso_tube_neck.js) - and drawn there
  if (walls !== 'both' && L < tb.lengthMm && h0 >= tb.hMin - 1e-4 && h0 <= tb.hMax + 1e-4 && (h0 + L / 2 >= tb.hMax - 1e-6 || h0 - L / 2 <= tb.hMin + 1e-6)) {
    atEnd = h0 + L / 2 >= tb.hMax - 1e-6 ? 'top' : 'bottom';
    h0 = atEnd === 'top' ? tb.hMax - L / 2 : tb.hMin + L / 2;
  }
  // the band's own radii once a preview has read them there, else the end's
  var bd = B.result && B.result.band && B.result.band.Ro != null ? B.result.band : null;
  var Ro = bd ? bd.Ro : tb.endRo, Ri = bd ? bd.Ri : tb.endRi;
  // the handles sit on the face that moves: the bore with Bore only, else the outside
  var Rf = walls === 'bore' ? Ri : Ro;
  return { kind: 'neck', m: m, tube: tb, C: C, a: a, e1: tb.frame.e1, e2: tb.frame.e2, h0: h0, L: L, dr: dr, walls: walls, atEnd: atEnd,
           ha: h0 - L / 2, hb: h0 + L / 2, Ro: Ro, Ri: Ri, Rf: Rf, Rw: Math.max(0.05, Rf + dr) };
}
function NSO_teWallsVal() { var el = NSO_teEl('sel-te-walls'); return el && el.value ? el.value : 'both'; }

/* Flare as its handle sees it, from the read end and the card (so the lip
   ring stays up through a refusal): the Length, the signed Δr (Way In turns
   a positive one in, as the engine does), and the lip ring - the face that
   moves (the mid-line with Both) stood Δr off its line at u = L, laid in the
   wall's own frame (nso_tube_edge.js's NSO_teToMeridian). h0 is the lip's
   height along the end's outward axis, Rl its radius. Null with no end read
   or no Length. */
function NSO_teFlareGeom() {
  var B = NSO_teUI(), m = NSO_teModel();
  if (!m || !B.read || !B.read.ok || !B.read.end || B.readVerb !== 'end' || NSO_teVerb() !== 'flare') return null;
  var end = B.read.end, EL = NSO_teEl('inp-te-length'), EA = NSO_teEl('inp-te-angle'), ED = NSO_teEl('inp-te-dr'), DIR = NSO_teEl('sel-te-dir');
  var L = EL ? +EL.value : NaN, dr;
  if (!(L > 0) || !isFinite(L)) return null;
  if (B.lead === 'dr') dr = ED && ED.value !== '' ? +ED.value : 0;
  else dr = EA && EA.value !== '' ? L * Math.tan(+EA.value * Math.PI / 180) : 0;
  if (!isFinite(dr)) dr = 0;
  if (DIR && DIR.value === 'in' && dr > 0) dr = -dr;
  var walls = NSO_teWallsVal(), t = end.wallMm, lean = end.leanDeg * Math.PI / 180;
  var u0 = Math.max(0, -end.rimMm * Math.sin(lean)), v0 = walls === 'bore' ? -t : walls === 'outside' ? 0 : -t / 2;
  var lip = NSO_teToMeridian(end, lean, [v0 + dr, u0 + L]);
  return { kind: 'flare', m: m, end: end, C: end.center, a: end.axis, e1: end.frame.e1, e2: end.frame.e2, L: L, dr: dr, walls: walls,
           h0: lip[1], Rl: Math.max(0.05, lip[0]) };
}
// The handles' geometry, whichever verb has them.
function NSO_teGeom() { return NSO_teNeckGeom() || NSO_teFlareGeom(); }
function NSO_teAxisPoint(g, h) { return [g.C[0] + h * g.a[0], g.C[1] + h * g.a[1], g.C[2] + h * g.a[2]]; }

// The neck's handles: the outside circle at each end of the band ('a' the
// lower end along the axis, 'b' the upper) and the waist's ('waist').
function NSO_teSetNeckRings(m) {
  NSO_teRemoveRing();
  var g = NSO_teNeckGeom();
  if (typeof THREE === 'undefined' || !state.scene || !g) return;
  var B = NSO_teUI(), hot = B.drag ? B.drag.handle : B.hover;
  var group = new THREE.Group();
  group.name = 'tubeEdgeRing';
  group.matrixAutoUpdate = false;
  [['a', g.ha, g.Rf, TUBE_EDGE_RING_COLOR], ['b', g.hb, g.Rf, TUBE_EDGE_RING_COLOR], ['waist', g.h0, g.Rw, TUBE_EDGE_WAIST_COLOR]].forEach(function (q) {
    var pts = [], O = NSO_teAxisPoint(g, q[1]), rad = q[2], e1 = g.e1, e2 = g.e2;
    for (var i = 0; i < 96; i++) {
      var ang = 2 * Math.PI * i / 96, c = Math.cos(ang) * rad, s = Math.sin(ang) * rad;
      pts.push(NSO_teRawToDisplay(m, [O[0] + c * e1[0] + s * e2[0], O[1] + c * e1[1] + s * e2[1], O[2] + c * e1[2] + s * e2[2]]));
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: hot === q[0] ? TUBE_EDGE_HOT_COLOR : q[3], transparent: true, depthTest: false, depthWrite: false }));
    line.renderOrder = TUBE_EDGE_RENDER_ORDER; line.userData.skipXray = true; line.userData.tubeEdgeRing = true;
    line.userData.teHandle = q[0]; line.userData.teColor = q[3];
    line.raycast = function () {}; line.frustumCulled = false;
    group.add(line);
  });
  group.userData.center = NSO_teRawToDisplay(m, NSO_teAxisPoint(g, g.h0));
  group.userData.band = [g.ha, g.hb];
  group.userData.waist = { h: g.h0, r: g.Rw };
  state.scene.add(group);
  B.ring = group;
  NSO_teFollow();
}
// Light the handle under the pointer (or in hand), the others their own colour.
function NSO_teLight(handle) {
  var B = NSO_teUI();
  if (!B.ring) return;
  B.ring.children.forEach(function (o) {
    if (o.userData.teHandle) o.material.color.setHex(o.userData.teHandle === handle ? TUBE_EDGE_HOT_COLOR : o.userData.teColor);
  });
}

/* ------------------------------------------------------- the neck handles */

// The pointer's ray in the piece's raw frame: { o, d }, d a unit vector.
function NSO_teRawRay(m, clientX, clientY) {
  var mesh = NSO_teMeshOf(m);
  if (!mesh || !state.raycaster || !state.camera || !state.renderer) return null;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  mesh.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var o = state.raycaster.ray.origin.clone().applyMatrix4(inv);
  var p = state.raycaster.ray.origin.clone().add(state.raycaster.ray.direction).applyMatrix4(inv).sub(o);
  var O = NSO_teDisplayToRaw(m, o), d = [p.x, -p.z, p.y], n = Math.hypot(d[0], d[1], d[2]);
  return n > 0 ? { o: O, d: [d[0] / n, d[1] / n, d[2] / n] } : null;
}
// A raw point on the screen, in client pixels.
function NSO_teScreen(m, raw) {
  var mesh = NSO_teMeshOf(m);
  var v = new THREE.Vector3().fromArray(NSO_teRawToDisplay(m, raw)).applyMatrix4(mesh.matrixWorld).project(state.camera);
  var r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, z: v.z };
}

/* What is under the pointer: the nearest ring within TUBE_NECK_HIT_PX on
   screen (Neck's 'a', 'b', 'waist'; Flare's 'lip'), else for a neck 'band'
   when the ray meets the tube between the end rings, else null.
   NSO_teNeckHitAt also gives the raw point taken hold of (on the ring, or
   where the ray meets the tube). */
function NSO_teNeckHit(clientX, clientY) { var h = NSO_teNeckHitAt(clientX, clientY); return h ? h.handle : null; }
function NSO_teNeckHitAt(clientX, clientY) {
  var B = NSO_teUI(), g = NSO_teGeom();
  if (!g || !B.ring || !NSO_teMeshOf(g.m)) return null;
  var best = null, bd = TUBE_NECK_HIT_PX;
  var rings = g.kind === 'flare' ? [['lip', g.h0, g.Rl]] : [['a', g.ha, g.Rf], ['b', g.hb, g.Rf], ['waist', g.h0, g.Rw]];
  rings.forEach(function (q) {
    var O = NSO_teAxisPoint(g, q[1]), prev = null, prevRaw = null;
    for (var i = 0; i <= 48; i++) {
      var ang = 2 * Math.PI * i / 48, c = Math.cos(ang) * q[2], s = Math.sin(ang) * q[2];
      var raw = [O[0] + c * g.e1[0] + s * g.e2[0], O[1] + c * g.e1[1] + s * g.e2[1], O[2] + c * g.e1[2] + s * g.e2[2]];
      var P = NSO_teScreen(g.m, raw);
      if (prev && P.z < 1 && prev.z < 1) {
        var ex = P.x - prev.x, ey = P.y - prev.y, L2 = ex * ex + ey * ey;
        var t = L2 > 0 ? Math.max(0, Math.min(1, ((clientX - prev.x) * ex + (clientY - prev.y) * ey) / L2)) : 0;
        var d = Math.hypot(clientX - prev.x - t * ex, clientY - prev.y - t * ey);
        // the waist wins a tie: at Δr 0 it is the one ring inside the band
        if (d < bd || (d <= bd && q[0] === 'waist')) {
          bd = d;
          best = { handle: q[0], at: [prevRaw[0] + t * (raw[0] - prevRaw[0]), prevRaw[1] + t * (raw[1] - prevRaw[1]), prevRaw[2] + t * (raw[2] - prevRaw[2])] };
        }
      }
      prev = P; prevRaw = raw;
    }
  });
  if (best || g.kind === 'flare') return best;
  // the band: the ray against the cylinder the tube's outside makes there
  var ray = NSO_teRawRay(g.m, clientX, clientY);
  if (!ray) return null;
  var R = Math.max(g.Ro, g.Rw), a = g.a, w = [ray.o[0] - g.C[0], ray.o[1] - g.C[1], ray.o[2] - g.C[2]];
  var da = ray.d[0] * a[0] + ray.d[1] * a[1] + ray.d[2] * a[2], wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  var dp = [ray.d[0] - da * a[0], ray.d[1] - da * a[1], ray.d[2] - da * a[2]], wp = [w[0] - wa * a[0], w[1] - wa * a[1], w[2] - wa * a[2]];
  var A = dp[0] * dp[0] + dp[1] * dp[1] + dp[2] * dp[2], Bq = 2 * (dp[0] * wp[0] + dp[1] * wp[1] + dp[2] * wp[2]);
  var Cq = wp[0] * wp[0] + wp[1] * wp[1] + wp[2] * wp[2] - R * R, disc = Bq * Bq - 4 * A * Cq;
  if (!(A > 1e-12) || disc < 0) return null;
  var t0 = (-Bq - Math.sqrt(disc)) / (2 * A);
  if (!(t0 > 0)) return null;
  var h = wa + t0 * da;
  if (!(h >= g.ha && h <= g.hb)) return null;
  return { handle: 'band', at: [ray.o[0] + t0 * ray.d[0], ray.o[1] + t0 * ray.d[1], ray.o[2] + t0 * ray.d[2]] };
}

/* The plane a drag is read on: it holds the axis's direction and faces the
   camera as near as such a plane can. On it, a pointer is h (mm along the
   axis) and s (mm out from the axis line). The band and the end rings are
   read on the plane through the point taken hold of, so that point stays
   under the pointer as it slides; the waist on the plane through the axis
   itself, so "toward the axis" is toward the axis as it is seen, from
   anywhere on the ring. */
function NSO_teDragPlane(g, ray, through) {
  var a = g.a, da = ray.d[0] * a[0] + ray.d[1] * a[1] + ray.d[2] * a[2];
  var n = [ray.d[0] - da * a[0], ray.d[1] - da * a[1], ray.d[2] - da * a[2]], L = Math.hypot(n[0], n[1], n[2]);
  if (!(L > 1e-6)) return null;                     // looking straight down the axis
  return { O: through || g.C, C: g.C, a: a, n: [n[0] / L, n[1] / L, n[2] / L] };
}
function NSO_teOnPlane(pl, ray) {
  var dn = ray.d[0] * pl.n[0] + ray.d[1] * pl.n[1] + ray.d[2] * pl.n[2];
  if (Math.abs(dn) < 1e-9) return null;
  var t = ((pl.O[0] - ray.o[0]) * pl.n[0] + (pl.O[1] - ray.o[1]) * pl.n[1] + (pl.O[2] - ray.o[2]) * pl.n[2]) / dn;
  var v = [ray.o[0] + t * ray.d[0] - pl.C[0], ray.o[1] + t * ray.d[1] - pl.C[1], ray.o[2] + t * ray.d[2] - pl.C[2]];
  var h = v[0] * pl.a[0] + v[1] * pl.a[1] + v[2] * pl.a[2];
  return { h: h, s: Math.hypot(v[0] - h * pl.a[0], v[1] - h * pl.a[1], v[2] - h * pl.a[2]) };
}

function NSO_teFmtMm(v) {
  var r = Math.round(v * 100) / 100;
  return Math.abs(r * 10 - Math.round(r * 10)) < 1e-6 ? r.toFixed(1) : r.toFixed(2);
}
function NSO_teSigned(v) { var s = NSO_teFmtMm(Math.abs(v)); return (v > 0 ? '+' : v < 0 ? '−' : '') + s; }
// A handle's value, in words: what hover and a drag put in the readout.
var NSO_TE_FACE_WORDS = { both: 'Wall', outside: 'Outside', bore: 'Bore' };
function NSO_teHandleText(handle) {
  var g = NSO_teGeom();
  if (!g) return '';
  // the face the handle moves, first: "Bore Δr +3.0 mm"
  var face = NSO_TE_FACE_WORDS[g.walls] || 'Wall';
  if (handle === 'lip') return face + ' Δr ' + NSO_teSigned(g.dr) + ' mm, Length ' + NSO_teFmtMm(g.L) + ' mm';
  if (handle === 'waist') return face + ' Δr ' + NSO_teSigned(g.dr) + ' mm';
  if (handle === 'band') return 'Centre ' + NSO_teFmtMm(Math.max(0, -g.h0)) + ' mm in';
  return 'Length ' + NSO_teFmtMm(g.L) + ' mm';
}
// The readout with a handle's value in front of what the preview said.
function NSO_teSayHandle(handle) {
  var B = NSO_teUI(), last = B.said || { text: '—', bad: false }, t = NSO_teHandleText(handle);
  var el = NSO_teEl('te-readout');
  if (el) { el.textContent = t ? t + ' · ' + last.text : last.text; el.classList.toggle('is-bad', !!last.bad); }
}

/* Set the neck to { h0, L, dr } (any left out stay): the band's centre goes
   in B.point (on the axis), the numbers in the fields - the fields are the
   readouts - and the preview runs, as it does for typing. The band is kept on
   the tube: the centre and the Length stop where an end ring meets an end. */
function NSO_teNeckSet(v) {
  var B = NSO_teUI(), g = NSO_teNeckGeom();
  if (!g) return false;
  var tb = g.tube, L = v.L != null ? v.L : g.L, h0 = v.h0 != null ? v.h0 : g.h0, dr = v.dr != null ? v.dr : g.dr;
  L = Math.max(TUBE_NECK_FINE_MM, L);
  if (g.atEnd && v.L != null && v.h0 == null) {
    // a step at an end grows and shrinks from that end, which stays put
    L = Math.min(L, tb.lengthMm - TUBE_NECK_FINE_MM);
    h0 = g.atEnd === 'top' ? tb.hMax - L / 2 : tb.hMin + L / 2;
  } else if (L <= tb.lengthMm) {
    if (v.h0 != null) h0 = Math.min(tb.hMax - L / 2, Math.max(tb.hMin + L / 2, h0));
    else if (v.L != null) L = Math.min(L, 2 * Math.min(h0 - tb.hMin, tb.hMax - h0));
  }
  dr = Math.max(-g.Rf, dr);
  B.point = NSO_teAxisPoint(g, h0);
  var NL = NSO_teEl('inp-te-neck-length'), ND = NSO_teEl('inp-te-neck-dr');
  if (NL && v.L != null) NL.value = NSO_teFmtMm(L);
  if (ND && v.dr != null) ND.value = NSO_teFmtMm(dr);
  NSO_tePreview();
  return true;
}
/* Set the flare to { L, dr } (either left out stays): the Length and a
   signed Δr in the fields - the fields are the readouts; Angle follows - and
   Way back to Out, the sign being Δr's now. The preview runs, as for typing. */
function NSO_teFlareSet(v) {
  var g = NSO_teFlareGeom();
  if (!g) return false;
  var L = Math.max(TUBE_NECK_FINE_MM, v.L != null ? v.L : g.L), dr = v.dr != null ? v.dr : g.dr;
  var EL = NSO_teEl('inp-te-length'), ED = NSO_teEl('inp-te-dr'), DIR = NSO_teEl('sel-te-dir');
  if (EL) EL.value = NSO_teFmtMm(L);
  if (ED) ED.value = NSO_teFmtMm(dr);
  if (DIR) DIR.value = 'out';
  NSO_teLink('dr');
  NSO_tePreview();
  return true;
}
// Snap a move to its step: whole steps of the move, so a centre the click put
// off the grid keeps its fraction.
function NSO_teSnap(d, fine) { var st = fine ? TUBE_NECK_FINE_MM : TUBE_NECK_STEP_MM; return Math.round(d / st) * st; }

// Which way Up goes along the axis: +1 when the axis runs up the screen.
function NSO_teUpSign(g) {
  var p = NSO_teScreen(g.m, NSO_teAxisPoint(g, g.h0)), q = NSO_teScreen(g.m, NSO_teAxisPoint(g, g.h0 + 1));
  if (Math.abs(q.y - p.y) > 1e-3) return q.y < p.y ? 1 : -1;
  var up = NSO_teRawToDisplay(g.m, [g.C[0] + g.a[0], g.C[1] + g.a[1], g.C[2] + g.a[2]])[1] - NSO_teRawToDisplay(g.m, g.C)[1];
  return up >= 0 ? 1 : -1;
}
// One arrow key: 'up' / 'down' move the band (a flare: its Length),
// 'left' / 'right' Δr.
function NSO_teNeckKey(key, fine) {
  var g = NSO_teGeom();
  if (!g) return false;
  var st = fine ? TUBE_NECK_FINE_MM : TUBE_NECK_KEY_MM;
  if (g.kind === 'flare') {
    if (key === 'left' || key === 'right') NSO_teFlareSet({ dr: Math.round((g.dr + (key === 'right' ? st : -st)) * 100) / 100 });
    else NSO_teFlareSet({ L: Math.round((g.L + (key === 'up' ? 1 : -1) * NSO_teUpSign(g) * st) * 100) / 100 });
    NSO_teSayHandle('lip');
    return true;
  }
  if (key === 'left' || key === 'right') {
    NSO_teNeckSet({ dr: Math.round((g.dr + (key === 'right' ? st : -st)) * 100) / 100 });
    NSO_teSayHandle('waist');
  } else {
    NSO_teNeckSet({ h0: g.h0 + (key === 'up' ? 1 : -1) * NSO_teUpSign(g) * st });
    NSO_teSayHandle('band');
  }
  return true;
}

/* The cursor over a handle: a resize along the axis as it lies on screen for
   an end ring, across it for the waist, a hand for the band. */
var NSO_TE_CURSORS = ['te-cur-ew', 'te-cur-nwse', 'te-cur-ns', 'te-cur-nesw', 'te-cur-grab', 'te-cur-grabbing'];
function NSO_teCursor(handle, grabbing) {
  var cv = state.renderer && state.renderer.domElement;
  if (!cv) return;
  NSO_TE_CURSORS.forEach(function (c) { cv.classList.remove(c); });
  var g = handle ? NSO_teGeom() : null;
  if (!g) return;
  if (handle === 'band' || handle === 'lip') { cv.classList.add(grabbing ? 'te-cur-grabbing' : 'te-cur-grab'); return; }
  var p = NSO_teScreen(g.m, NSO_teAxisPoint(g, g.h0)), q = NSO_teScreen(g.m, NSO_teAxisPoint(g, g.h0 + 1));
  var ang = Math.atan2(-(q.y - p.y), q.x - p.x) * 180 / Math.PI + (handle === 'waist' ? 90 : 0);
  var k = ((Math.round(ang / 45) % 4) + 4) % 4;      // 0 ew, 1 nesw, 2 ns, 3 nwse (screen y up)
  cv.classList.add(['te-cur-ew', 'te-cur-nesw', 'te-cur-ns', 'te-cur-nwse'][k]);
}
function NSO_teHover(handle) {
  var B = NSO_teUI();
  if (B.hover === handle) return;
  B.hover = handle;
  NSO_teLight(handle);
  NSO_teCursor(handle, false);
  if (handle) NSO_teSayHandle(handle);
  else if (B.said) NSO_teReadout(B.said.text, B.said.bad);
}

/* A drag. Begun on a press on a handle; the plane it is read on is fixed at
   the press (the camera does not move during it). The band's press is a
   click until it travels TUBE_NECK_SLOP_PX. */
// The fields a drag writes, so Escape can put them back as they were.
var NSO_TE_DRAG_FIELDS = ['inp-te-neck-length', 'inp-te-neck-dr', 'inp-te-length', 'inp-te-angle', 'inp-te-dr', 'sel-te-dir'];
function NSO_teDragBegin(hit, ev) {
  var B = NSO_teUI(), g = NSO_teGeom(), ray = g && NSO_teRawRay(g.m, ev.clientX, ev.clientY), handle = hit.handle;
  // the waist and the lip are read on the plane through the axis ("toward the axis")
  var pl = ray && NSO_teDragPlane(g, ray, handle === 'waist' || handle === 'lip' ? null : hit.at), at = pl && NSO_teOnPlane(pl, ray);
  if (!at) return false;
  var fields = {};
  NSO_TE_DRAG_FIELDS.forEach(function (id) { var el = NSO_teEl(id); if (el) fields[id] = el.value; });
  B.drag = { handle: handle, x0: ev.clientX, y0: ev.clientY, moved: handle !== 'band', plane: pl, at0: at,
             h0: g.h0, L: g.L, dr: g.dr,
             undo: { point: B.point ? B.point.slice() : null, fields: fields, lead: B.lead } };
  if (state.controls) state.controls.enabled = false;
  NSO_teLight(handle);
  NSO_teCursor(handle, true);
  NSO_teSayHandle(handle);
  return true;
}
function NSO_teDragMove(ev) {
  var B = NSO_teUI(), D = B.drag, g = NSO_teGeom();
  if (!D || !g) return;
  if (!D.moved) {
    if (Math.hypot(ev.clientX - D.x0, ev.clientY - D.y0) < TUBE_NECK_SLOP_PX) return;
    D.moved = true;
  }
  var ray = NSO_teRawRay(g.m, ev.clientX, ev.clientY), at = ray && NSO_teOnPlane(D.plane, ray);
  if (!at) return;
  var fine = !!ev.shiftKey, dh = NSO_teSnap(at.h - D.at0.h, fine), v;
  if (D.handle === 'lip') v = { L: Math.round((D.L + dh) * 100) / 100, dr: Math.round((D.dr + NSO_teSnap(at.s - D.at0.s, fine)) * 100) / 100 };
  else if (D.handle === 'band') v = { h0: D.h0 + dh };
  // a step at an end: the ring off the end moves its own end, the end's stays
  else if (g.atEnd && (D.handle === 'a' || D.handle === 'b')) {
    var free = g.atEnd === 'top' ? 'a' : 'b';
    v = { L: D.handle === free ? D.L + (free === 'a' ? -dh : dh) : D.L };
  }
  else if (D.handle === 'a') v = { L: D.L - 2 * dh };
  else if (D.handle === 'b') v = { L: D.L + 2 * dh };
  else v = { dr: Math.round((D.dr + NSO_teSnap(at.s - D.at0.s, fine)) * 100) / 100 };
  var key = JSON.stringify(v);
  if (key !== D.last) { D.last = key; if (D.handle === 'lip') NSO_teFlareSet(v); else NSO_teNeckSet(v); }
  NSO_teSayHandle(D.handle);
}
// End a drag: kept (a release), or put back where it began (Escape, or the
// card going away). A band press that never travelled is the placing click.
function NSO_teDragEnd(keep, ev) {
  var B = NSO_teUI(), D = B.drag;
  if (!D) return;
  B.drag = null;
  if (state.controls) state.controls.enabled = true;
  if (!keep && D.moved) {
    B.point = D.undo.point;
    B.lead = D.undo.lead;
    Object.keys(D.undo.fields).forEach(function (id) { var el = NSO_teEl(id); if (el) el.value = D.undo.fields[id]; });
    NSO_tePreview();
  } else if (keep && !D.moved && ev) {
    NSO_tePlaceAt(D.x0, D.y0);
  }
  B.hover = null;
  NSO_teLight(null);
  NSO_teCursor(null);
  if (B.said) NSO_teReadout(B.said.text, B.said.bad);
}

// The click that places the neck (or picks an end): the point on the piece
// under (x, y). False when the click misses the piece.
function NSO_tePlaceAt(clientX, clientY) {
  var B = NSO_teUI(), m = NSO_teModel(), mesh = m && NSO_teMeshOf(m);
  if (!mesh) return false;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  var hits = state.raycaster.intersectObject(mesh, false);
  if (!hits.length) return false;
  mesh.updateMatrixWorld(true);
  var local = hits[0].point.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  B.point = NSO_teDisplayToRaw(m, local);
  if (NSO_teVerb() === 'neck' && B.read && B.read.ok && B.readVerb === 'neck') NSO_tePreview(); else NSO_teLoad();
  return true;
}

function NSO_teFollow() {
  var B = NSO_teUI(), m = NSO_teModel(), mesh = m && NSO_teMeshOf(m);
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  [B.ghost, B.ring].forEach(function (o) {
    if (!o) return;
    o.matrix.copy(mesh.matrixWorld);
    o.matrixWorldNeedsUpdate = true;
  });
}

/* ---------------------------------------------------------------- the card */

function NSO_teReadout(text, bad) {
  var el = NSO_teEl('te-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  NSO_teUI().said = { text: text, bad: !!bad };     // what a handle's hover puts back
}
function NSO_teSyncRows() {
  var verb = (NSO_teEl('sel-te-verb') || {}).value || 'flare';
  ['te-flare-rows'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb !== 'flare'; });
  ['te-roll-rows'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb !== 'roll'; });
  ['te-neck-rows'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb !== 'neck'; });
  ['te-dir-row'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb === 'neck'; });
  ['te-walls-row'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb === 'roll'; });
}
function NSO_teSyncButtons() {
  var B = NSO_teUI(), go = NSO_teEl('btn-te-go');
  if (go) go.disabled = !(B.result && B.result.ok);
}

function NSO_teVerb() { return (NSO_teEl('sel-te-verb') || {}).value || 'flare'; }

// Read the selected piece (the end nearest B.point, else the top end; for a
// neck, the tube's axis) and fill the card's blank fields from the wall.
function NSO_teLoad() {
  var B = NSO_teUI(), m = NSO_teModel(), neck = NSO_teVerb() === 'neck';
  if (!m || m.id !== B.modelId) B.point = null;
  B.modelId = m ? m.id : null; B.soup = m ? m.rawTris : null; B.result = null; B.key = '';
  B.readVerb = neck ? 'neck' : 'end';
  if (!m) { B.read = null; NSO_teReadout('Select a tube to flare, roll or neck.', true); NSO_teClear(); NSO_teSyncButtons(); return; }
  var rd;
  try { rd = neck ? NSO_tubeNeckRead(m.rawTris) : NSO_tubeEdgeRead(m.rawTris, { point: B.point }); }
  catch (err) { rd = { ok: false, reason: (err && err.message) || String(err) }; }
  B.read = rd;
  if (!rd.ok) { NSO_teReadout((neck ? 'Neck: ' : 'Tube edge: ') + rd.reason, true); NSO_teClear(); NSO_teSyncButtons(); return; }
  if (neck) {
    // blank fields take defaults from the wall at the end: 7.5 walls long, in
    // by 2.5 walls (a 1.6 mm wall: 12 mm, -4)
    var tw = rd.tube.endRo - rd.tube.endRi;
    var NL = NSO_teEl('inp-te-neck-length'), ND = NSO_teEl('inp-te-neck-dr');
    if (NL && NL.value === '') NL.value = String(Math.max(4, Math.round(7.5 * tw)));
    if (ND && ND.value === '') ND.value = String(-Math.max(0.5, Math.round(5 * tw) / 2));
    NSO_teRemoveRing();
    NSO_tePreview();
    return;
  }
  {
    // blank fields take defaults from the wall; typed ones are kept
    var t = rd.end.wallMm;
    var L = NSO_teEl('inp-te-length'), A = NSO_teEl('inp-te-angle'), R = NSO_teEl('inp-te-radius'), RA = NSO_teEl('inp-te-roll-angle');
    if (L && L.value === '') L.value = String(Math.max(3, Math.round(4 * t)));
    if (A && A.value === '') A.value = '30';
    if (R && R.value === '') R.value = String(Math.max(1, Math.round(3 * t) / 2));
    if (RA && RA.value === '') RA.value = '180';
    NSO_teLink();
  }
  NSO_teSetRing(m, rd.end);
  NSO_tePreview();
}

// Run the treatment on the current numbers; show the ghost or say why not.
function NSO_tePreview() {
  var B = NSO_teUI(), m = NSO_teModel();
  if (B.open && m && B.readVerb !== (NSO_teVerb() === 'neck' ? 'neck' : 'end')) { NSO_teLoad(); return B.result; }
  if (!B.open || !m || !B.read || !B.read.ok) { NSO_teSyncButtons(); return null; }
  var o = NSO_teOpts(), neck = o.verb === 'neck';
  var key = m.id + '|' + JSON.stringify(o);
  if (B.key === key && B.soup === m.rawTris && B.result) { NSO_teSyncButtons(); return B.result; }
  o.read = B.read;
  var r;
  try { r = neck ? NSO_tubeNeckRaw(m.rawTris, o) : NSO_tubeEdgeRaw(m.rawTris, o); }
  catch (err) { r = { ok: false, reason: (err && err.message) || String(err) }; }
  B.result = r; B.key = key; B.soup = m.rawTris;
  if (neck) NSO_teSetNeckRings(m); else NSO_teSetRing(m, B.read.end);
  var aligned = (typeof NSO_bendFrameMatches === 'function') ? NSO_bendFrameMatches(m) : true;
  if (r.ok) {
    if (aligned) NSO_teSetGhost(m, r.tris, neck); else NSO_teRemoveGhost();
    NSO_teReadout(r.reason + ' · ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces' +
      (aligned ? '' : ' · (no ghost: the piece was turned since it was loaded)'));
  } else {
    NSO_teRemoveGhost();
    NSO_teReadout((neck ? 'Neck: ' : 'Tube edge: ') + r.reason, true);
  }
  NSO_teSyncButtons();
  return r;
}

function NSO_teOpen() {
  var B = NSO_teUI(), panel = NSO_teEl('te-panel'), btn = NSO_teEl('btn-tube-edge');
  if (typeof NSO_bendUI === 'function' && NSO_bendUI().open && typeof NSO_bendClose === 'function') NSO_bendClose();
  B.open = true;
  if (panel) panel.hidden = false;
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.classList.add('is-on'); }
  NSO_teSyncRows();
  NSO_teLoad();
  NSO_teTick();
}
function NSO_teClose() {
  var B = NSO_teUI(), panel = NSO_teEl('te-panel'), btn = NSO_teEl('btn-tube-edge');
  if (B.drag) NSO_teDragEnd(false);
  NSO_teHover(null);
  B.open = false; B.result = null; B.key = '';
  if (panel) panel.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
  NSO_teClear();
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
}

// Tube edge's session, for the helper registry (nso-helpers.js) - Bend's
// contract: leave-tool and Clear close it, an Undo under it reloads it.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('tube-edge', {
  live: function () { return !!NSO_teUI().open; },
  close: NSO_teClose,
  clear: NSO_teClear,
  refresh: NSO_teLoad
});

// Per frame while open: follow the piece, and start over when the selection
// or the piece's soup changes under the card (another bake, Undo, another piece).
function NSO_teTick() {
  var B = NSO_teUI();
  if (!B.open) return;
  // Bend and Tube edge share the piece and the click: one card at a time.
  if (typeof NSO_bendUI === 'function' && NSO_bendUI().open) { NSO_teClose(); return; }
  var m = NSO_teModel();
  if ((m ? m.id : null) !== B.modelId || (m && m.rawTris !== B.soup)) NSO_teLoad();
  else NSO_teFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_teTick) : 0;
}

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
function NSO_teSelectedModel(opts) {
  var m = NSO_teModel();
  if (!m) { if (typeof setStatus === 'function') setStatus('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Tube edge stood down - ' + painted + ' painted face(s); it rebuilds the wall and re-seats the piece. Clear paint to flare, roll or neck.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var B = NSO_teUI(), r;
  var o = opts || NSO_teOpts(), neck = o.verb === 'neck', name = neck ? 'Neck' : 'Tube edge';
  var key = m.id + '|' + JSON.stringify(o);
  if (!opts && B.result && B.key === key && B.soup === m.rawTris) r = B.result;
  else r = neck ? NSO_tubeNeckRaw(m.rawTris, o) : NSO_tubeEdgeRaw(m.rawTris, o);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus(name + ' refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt = name + ' done - ' + r.reason + '; ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces';
  NSO_sculptCommitRaw(m, r.tris, neck ? 'tubeNeckReplace' : 'tubeEdgeReplace', txt);
  return r;
}

if (typeof document !== 'undefined') {
  (function wireTubeEdge() {
    function onDown(ev) {
      var B = NSO_teUI();
      if (!B.open || ev.button !== 0 || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      if (B.drag) NSO_teDragEnd(false);
      // a neck's handle first: a ring, or the band between the end rings
      var hit = NSO_teNeckHitAt(ev.clientX, ev.clientY);
      if (hit && NSO_teDragBegin(hit, ev)) {
        // the press keeps the focus where it was; out of a field, so the
        // arrows are the handles' after the drag
        var f = document.activeElement, card = NSO_teEl('te-panel');
        if (f && card && card.contains(f) && typeof f.blur === 'function') f.blur();
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      if (!NSO_tePlaceAt(ev.clientX, ev.clientY)) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    // A drag in hand takes every move and the release, ahead of app-core's
    // window listeners; with none, a move over the canvas is a hover.
    function onMove(ev) {
      var B = NSO_teUI();
      if (B.drag) { NSO_teDragMove(ev); ev.stopImmediatePropagation(); ev.preventDefault(); return; }
      if (!B.open || NSO_teVerb() === 'roll' || !state.renderer || ev.target !== state.renderer.domElement || ev.buttons) {
        if (B.hover) NSO_teHover(null);
        return;
      }
      NSO_teHover(NSO_teNeckHit(ev.clientX, ev.clientY));
    }
    function onUp(ev) {
      var B = NSO_teUI();
      if (!B.drag) return;
      NSO_teDragEnd(ev.type === 'pointerup', ev);
      ev.stopImmediatePropagation();
    }
    // Arrows and Escape while the card is open on Neck or Flare (Rotate's
    // rails convention): text fields keep their own arrows and Escape.
    var NECK_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    function onKey(ev) {
      var B = NSO_teUI();
      if (!B.open || NSO_teVerb() === 'roll' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'Escape' && B.drag) {
        NSO_teDragEnd(false);
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      var t = ev.target, text = t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (text || (t && t.tagName === 'SELECT' && ev.key !== 'Escape')) return;
      // a top-bar menu that owns the arrows (Rotate, Tip, Move) keeps them:
      // one press is answered once (app-input-mode.js)
      var IM = window.nsoInputMode, owner = IM && IM.active && IM.active();
      if (owner && IM.registered && IM.registered().indexOf(owner) >= 0) return;
      if (ev.key === 'Escape') {
        NSO_teClose();
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      var k = NECK_KEYS[ev.key];
      if (!k || B.drag || !NSO_teGeom()) return;
      NSO_teNeckKey(k, ev.shiftKey);
      ev.preventDefault(); ev.stopImmediatePropagation();
    }
    function wire() {
      var btn = NSO_teEl('btn-tube-edge');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { if (NSO_teUI().open) NSO_teClose(); else NSO_teOpen(); });
      var go = NSO_teEl('btn-te-go'), cancel = NSO_teEl('btn-te-cancel');
      if (go) go.addEventListener('click', function () {
        try {
          var r = NSO_teSelectedModel();
          if (r && r.ok) NSO_teClose();
        } catch (err) {
          console.error('[tube edge]', err);
          if (typeof setStatus === 'function') setStatus('Tube edge failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      if (cancel) cancel.addEventListener('click', NSO_teClose);
      var verb = NSO_teEl('sel-te-verb');
      if (verb) verb.addEventListener('change', function () {
        // an end's click and a neck's are different places: a switch between
        // them starts from the default (the top end, the middle of the tube)
        var B = NSO_teUI();
        if (B.readVerb && B.readVerb !== (NSO_teVerb() === 'neck' ? 'neck' : 'end')) B.point = null;
        NSO_teSyncRows(); NSO_tePreview();
      });
      ['sel-te-dir', 'sel-te-walls', 'sel-te-profile', 'inp-te-radius', 'inp-te-roll-angle',
       'inp-te-neck-length', 'inp-te-neck-dr', 'sel-te-neck-profile'].forEach(function (id) {
        var el = NSO_teEl(id);
        if (el) el.addEventListener('change', NSO_tePreview);
      });
      [['inp-te-length', null], ['inp-te-angle', 'angle'], ['inp-te-dr', 'dr']].forEach(function (p) {
        var el = NSO_teEl(p[0]);
        if (el) el.addEventListener('change', function () { NSO_teLink(p[1]); NSO_tePreview(); });
      });
      // Capture on window: ahead of app-core's canvas handler, so a click that
      // picks the end does not also start a drag or a selection.
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      window.addEventListener('keydown', onKey, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
