function updateJoinUI() {
  const a = state.models.find(function (x) { return x.id === state.editId && state.joinSession; });
  const b = state.models.find(function (x) { return x.id === state.joinPartnerId; });
  const c = state.models.find(function (x) { return x.id === state.joinThirdId; });
  const nameA = document.getElementById('join-name-a');
  const nameB = document.getElementById('join-name-b');
  const nameC = document.getElementById('join-name-c');
  const slotA = document.getElementById('join-slot-a');
  const slotB = document.getElementById('join-slot-b');
  const slotC = document.getElementById('join-slot-c');
  const step = document.getElementById('join-step');
  const btn = document.getElementById('btn-join');
  if (nameA) {
    const face = state.joinFaceA;
    nameA.textContent = (state.joinSession && state.editId && a)
      ? (a.name + (face ? ' · ' + face.axis.toUpperCase() + (face.sign > 0 ? '+' : '-') : ''))
      : 'Pick piece A';
  }
  if (nameB) {
    const face = state.joinFaceB;
    nameB.textContent = b
      ? (b.name + (face ? ' · ' + face.axis.toUpperCase() + (face.sign > 0 ? '+' : '-') : ''))
      : 'Pick piece B';
  }
  if (nameC) {
    const face = state.joinFaceC;
    nameC.textContent = c
      ? (c.name + (face ? ' · ' + face.axis.toUpperCase() + (face.sign > 0 ? '+' : '-') : ''))
      : 'Pick piece C (optional)';
  }
  const faceBtn = document.getElementById('btn-join-faces');
  if (faceBtn) {
    faceBtn.classList.toggle('tool-active', !!state.joinUseFaces);
    faceBtn.textContent = state.joinUseFaces ? 'Faces ON — click cut walls' : 'Lock faces (optional)';
  }
  if (slotA) {
    slotA.classList.toggle('filled-a', !!(state.joinSession && state.editId));
    slotA.classList.toggle('armed', state.joinArmed === 'a');
  }
  if (slotB) {
    slotB.classList.toggle('filled-b', !!state.joinPartnerId);
    slotB.classList.toggle('armed', state.joinArmed === 'b');
  }
  if (slotC) {
    slotC.classList.toggle('filled-c', !!state.joinThirdId);
    slotC.classList.toggle('armed', state.joinArmed === 'c');
  }
  if (btn) btn.disabled = !(state.joinSession && state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const btnSub = document.getElementById('btn-subtract');
  if (btnSub) btnSub.disabled = !(state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const alignBtn = document.getElementById('btn-join-align');
  if (alignBtn) alignBtn.disabled = !(state.joinSession && state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const readyJoin = !!(state.joinSession && state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const cx = document.getElementById('btn-join-cx');
  const cz = document.getElementById('btn-join-cz');
  if (cx) cx.disabled = !readyJoin;
  if (cz) cz.disabled = !readyJoin;
  // Center lock rides the same A+B precondition; its own module owns the
  // armed/target label on the pick button.
  if (window.NSO_CenterLock) window.NSO_CenterLock.syncUI();
  // Same for the card's gap rows, toggle and readout (app-join-triple.js),
  // off the very same A/B/C slots.
  if (window.NSO_TripleJoin) window.NSO_TripleJoin.syncUI();
  if (step) {
    if (!state.joinSession) step.textContent = '1. Start Join';
    else if (state.joinArmed === 'a') step.textContent = '2. Click piece A on the plate or list';
    else if (!state.editId) step.textContent = '2. Click Pick A';
    else if (state.joinArmed === 'b') step.textContent = '3. Click piece B on the plate or list';
    else if (!state.joinPartnerId) step.textContent = '3. Click Pick B';
    else if (state.joinArmed === 'c') step.textContent = '4. Click piece C on the plate or list';
    else if (state.joinThirdId) step.textContent = '4. Set a gap per junction, then JOIN';
    else step.textContent = '4. Set the A-B gap (or none), then JOIN';
  }
  paintJoinHighlights();
}

function assignJoinClick(id, face) {
  if (id == null) return;
  if (!state.joinSession || !state.joinArmed) return;
  const useFace = face || null;
  if (state.joinArmed === 'a') {
    if (id === state.joinPartnerId) { state.joinPartnerId = null; state.joinFaceB = null; }
    if (id === state.joinThirdId) { state.joinThirdId = null; state.joinFaceC = null; }
    state.editId = id;
    state.joinHullId = id;
    state.joinFaceA = useFace;
    state.cutT = 0.5;
    state.joinArmed = null;
  } else if (state.joinArmed === 'b') {
    if (id === state.editId) return;
    if (id === state.joinThirdId) { state.joinThirdId = null; state.joinFaceC = null; }
    state.joinPartnerId = id;
    state.joinFaceB = useFace;
    state.joinArmed = null;
  } else if (state.joinArmed === 'c') {
    /* Three DISTINCT pieces, or the sequence is not a sequence: C == A would
       ask the second junction to seat A onto B having just seated B onto A,
       and C == B would ask B to seat onto itself. Refusing the click leaves
       the slot armed, so the next click can be the right piece. */
    if (id === state.editId || id === state.joinPartnerId) return;
    state.joinThirdId = id;
    state.joinFaceC = useFace;
    state.joinArmed = null;
  }
  renderModelList();
  updateEditSize();
  updateJoinUI();
}

function startJoinSession() {
  if (state.cutterOpen) closeCutter(true);
  state.joinSession = true;
  state.joinArmed = null;
  state.joinPartnerId = null;
  state.joinHullId = null;
  state.joinFaceA = null;
  state.joinFaceB = null;
  state.joinThirdId = null;
  state.joinFaceC = null;
  state.joinSlideAxis = null;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  state.editId = null;
  state.selectedIndex = -1;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  renderModelList();
  updateJoinUI();
}

/* No Start Join: the Join column is the switch. Opening it starts the session
   (startJoinSession, what the button ran) and shows the Join card, with its
   slots, at once; shutting it with the column button again, with Escape, or by
   the leave-tool gesture is Cancel (clearJoinSlots). A session already
   live is kept as it is: Seat, Align and Center lock work on the A and B the
   Join card holds, so opening one of THEIR columns shuts this one and leaves
   the session standing - returning to Join finds the slots as they were. (The
   card's Cancel clears the slots and leaves the card open.) A MutationObserver
   on `open`, for the reason the one-panel rule below gives. */
function joinWireCard() {
  const menu = document.getElementById('menu-joins');
  if (!menu || menu.dataset.nsoWired === '1') return;
  menu.dataset.nsoWired = '1';
  const anotherOpen = function () {
    return Array.prototype.some.call(document.querySelectorAll('.vp-menu[open]'),
      function (d) { return d !== menu && !menu.contains(d); });
  };
  const show = function () {
    if (!state.joinSession) startJoinSession();
  };
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      if (menu.open) show();
      else if (!anotherOpen()) clearJoinSlots();
    }).observe(menu, { attributes: true, attributeFilter: ['open'] });
  }
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !menu.open) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    menu.open = false;
  });
  if (menu.open) show();
}

function armJoinSlot(slot) {
  if (!state.joinSession) startJoinSession();
  state.joinArmed = slot;
  updateJoinUI();
}

function clearJoinSlots() {
  state.joinSession = false;
  state.joinArmed = null;
  state.joinPartnerId = null;
  state.joinHullId = null;
  state.joinFaceA = null;
  state.joinFaceB = null;
  state.joinThirdId = null;
  state.joinFaceC = null;
  state.joinUseFaces = false;
  state.joinSlideAxis = null;
  // The Center lock target was picked on a piece in slot A; leaving Join
  // retires it with the slot. Seat here aims at a point on slot A the same
  // way, so it goes with it.
  state.centerLockArmed = false;
  state.centerLockTarget = null;
  if (typeof window.nsoSeatHereDisarm === 'function') window.nsoSeatHereDisarm();
  else state.seatHereArmed = false;
  removeFaceHelper();
  renderModelList();
  updateEditSize();
  updateJoinUI();
}

/**
 * Subtract: keep A's triangles that lie outside B, drop the ones inside B,
 * weld the cut, then close only small stray loops the clip/weld introduces
 * (weld-tolerance slivers) -- never the cavity itself. B's shell is fully
 * discarded. This is a triangle-soup boolean by centroid + ray-parity, not
 * a true CSG: a triangle straddling B's own skin, or a non-manifold/open B
 * (no bottom cap on the bit), can misclassify near the boundary.
 */
/* ============================================================
   NSO shared math — no ES modules, r147, Safari-safe
   ============================================================ */

var NSO_EPS = 1e-7;

/* NSO_soupLen: nso_csg.js */

/* ---- 1. World soup from a PLACED mesh (position + quaternion + scale + lift) ---- */

function meshToWorldSoup(placed, extraLift) {
  if (!placed || !placed.geometry) return new Float32Array(0);

  placed.updateWorldMatrix(true, false);
  var m = placed.matrixWorld.clone();

  // "lift" applied after the matrix (if your pipeline keeps it separate)
  if (extraLift) {
    var lm = new THREE.Matrix4().makeTranslation(
      extraLift.x || 0, extraLift.y || 0, extraLift.z || 0
    );
    m.premultiply(lm);
  }

  var g = placed.geometry;
  var pos = g.attributes && g.attributes.position;
  if (!pos) return new Float32Array(0);

  var idx = g.index ? g.index.array : null;
  var triCount = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  var out = new Float32Array(triCount * 9);

  var v = new THREE.Vector3();
  var w = 0;
  for (var t = 0; t < triCount; t++) {
    for (var k = 0; k < 3; k++) {
      var vi = idx ? idx[t * 3 + k] : (t * 3 + k);
      v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      v.applyMatrix4(m);
      out[w++] = v.x; out[w++] = v.y; out[w++] = v.z;
    }
  }
  return out;
}

/* Back-compat shim so old call sites keep working. Prefer meshToWorldSoup. */
function NSO_geomToWorldSoup(geometry, px, py, pz, quatOrEuler, scale) {
  var m = new THREE.Matrix4();
  var q = new THREE.Quaternion();
  if (quatOrEuler) {
    if (quatOrEuler.isQuaternion) q.copy(quatOrEuler);
    else if (quatOrEuler.isEuler) q.setFromEuler(quatOrEuler);
  }
  var s = scale ? (scale.isVector3 ? scale : new THREE.Vector3(scale, scale, scale))
                : new THREE.Vector3(1, 1, 1);
  m.compose(new THREE.Vector3(px || 0, py || 0, pz || 0), q, s);

  var fake = { geometry: geometry, matrixWorld: m, updateWorldMatrix: function () {} };
  return meshToWorldSoup(fake);
}

/* Rotates a RAW ('zup') soup by a placed piece's CURRENT pose - rotation
   only, no translation, about the piece's own origin (raw soups, like the
   display geometry they come from, are centered there).

   Planar fuse (Join Route 0) works on raw soups on purpose - the same caps
   in display/placed space carry kerf-offset seed vertices that break exact
   congruence (see the route's own comment in joinSelectedModels). But raw
   and display axes differ by a fixed permutation (displayGeometryToRawSoup:
   raw = (x, -z, y)), while a piece's pose (mesh.quaternion, built by
   applyMeshRotation) is defined in DISPLAY space. Applying it to raw
   coordinates directly would rotate around the wrong axes, so each vertex
   is round-tripped through display space: raw -> display -> rotate ->
   raw. Identity pose in, unchanged soup out. */
function NSO_rotateRawSoupByPlacedPose(soup, placed) {
  if (!soup || !soup.length) return soup;
  if (!placed || !placed.mesh || typeof nsoPlacedIsPosed !== 'function' || !nsoPlacedIsPosed(placed)) return soup;
  var q = placed.mesh.quaternion;
  var out = new Float32Array(soup.length);
  var v = new THREE.Vector3();
  for (var i = 0; i < soup.length; i += 3) {
    var rx = soup[i], ry = soup[i + 1], rz = soup[i + 2];
    v.set(rx, rz, -ry);          // raw -> display
    v.applyQuaternion(q);
    out[i] = v.x; out[i + 1] = -v.z; out[i + 2] = v.y;   // display -> raw
  }
  return out;
}

/* ---- soup <-> geometry ---- */

function NSO_soupToGeometry(soup) {
  var g = new THREE.BufferGeometry();
  var arr = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function NSO_soupToLocal(worldSoup, mesh) {
  mesh.updateWorldMatrix(true, false);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var out = new Float32Array(worldSoup.length);
  var v = new THREE.Vector3();
  for (var i = 0; i < worldSoup.length; i += 3) {
    v.set(worldSoup[i], worldSoup[i + 1], worldSoup[i + 2]).applyMatrix4(inv);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}

/* ---- ray parity (point inside closed soup) ---- */

function NSO_rayTri(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  var det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  var inv = 1 / det;
  var tx = ox - ax, ty = oy - ay, tz = oz - az;
  var u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  var vv = (dx * qx + dy * qy + dz * qz) * inv;
  if (vv < 0 || u + vv > 1) return -1;
  var tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return (tt > 1e-6) ? tt : -1;
}

/* 3 skew rays, majority vote — kills the coplanar/edge ghosting on voxel plugs */
var NSO_RAYS = [
  [0.5773502, 0.5127110, 0.6350210],
  [-0.4472136, 0.7071068, 0.5477226],
  [0.3015113, -0.6030227, 0.7385489]
];

function NSO_pointInsideSoup(soup, x, y, z) {
  var votes = 0;
  for (var r = 0; r < 3; r++) {
    var dx = NSO_RAYS[r][0], dy = NSO_RAYS[r][1], dz = NSO_RAYS[r][2];
    var hits = 0;
    for (var i = 0; i < soup.length; i += 9) {
      if (NSO_rayTri(x, y, z, dx, dy, dz,
        soup[i], soup[i + 1], soup[i + 2],
        soup[i + 3], soup[i + 4], soup[i + 5],
        soup[i + 6], soup[i + 7], soup[i + 8]) > 0) hits++;
    }
    if (hits & 1) votes++;
  }
  return votes >= 2;
}

/* ---- box-likeness detection in the plug's own local frame ---- */

function NSO_localAABB(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox.clone();
}

/* True only if every face normal is axis-aligned AND its verts sit on the
   matching AABB face. A stepped / slotted / smooth plug returns false. */
function NSO_isBoxLike(geometry, box) {
  var pos = geometry.attributes && geometry.attributes.position;
  if (!pos) return false;
  var idx = geometry.index ? geometry.index.array : null;
  var triCount = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  if (triCount < 12) return false;

  var size = new THREE.Vector3(); box.getSize(size);
  var tol = Math.max(size.x, size.y, size.z) * 1e-3;

  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  var ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  var lo = [box.min.x, box.min.y, box.min.z];
  var hi = [box.max.x, box.max.y, box.max.z];

  for (var t = 0; t < triCount; t++) {
    var i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
    b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
    c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-16) continue;
    n.normalize();

    var comp = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    var ax = comp[0] > comp[1] ? (comp[0] > comp[2] ? 0 : 2) : (comp[1] > comp[2] ? 1 : 2);
    if (comp[ax] < 0.999) return false;

    var av = [a.x, a.y, a.z][ax], bv = [b.x, b.y, b.z][ax], cv = [c.x, c.y, c.z][ax];
    var onLo = Math.abs(av - lo[ax]) < tol && Math.abs(bv - lo[ax]) < tol && Math.abs(cv - lo[ax]) < tol;
    var onHi = Math.abs(av - hi[ax]) < tol && Math.abs(bv - hi[ax]) < tol && Math.abs(cv - hi[ax]) < tol;
    if (!onLo && !onHi) return false;
  }
  return true;
}

/* ---- clip one triangle against an AABB, keep the OUTSIDE fragments ---- */

function NSO_splitPolyByAxisPlane(poly, axis, sign, val, inPoly, outPoly) {
  inPoly.length = 0; outPoly.length = 0;
  var n = poly.length;
  for (var i = 0; i < n; i++) {
    var p = poly[i], q = poly[(i + 1) % n];
    var fp = sign * (p.getComponent(axis) - val);
    var fq = sign * (q.getComponent(axis) - val);
    if (fp <= 0) inPoly.push(p.clone()); else outPoly.push(p.clone());
    if ((fp > 0) !== (fq > 0)) {
      var d = fp - fq;
      var s = (Math.abs(d) < NSO_EPS) ? 0.5 : (fp / d);
      var m = new THREE.Vector3().lerpVectors(p, q, s);
      inPoly.push(m.clone()); outPoly.push(m.clone());
    }
  }
}

function NSO_fanTriangulate(poly, sink) {
  if (poly.length < 3) return;
  for (var i = 1; i + 1 < poly.length; i++) {
    var a = poly[0], b = poly[i], c = poly[i + 1];
    var abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    var acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    var cx = aby * acz - abz * acy, cy = abz * acx - abx * acz, cz = abx * acy - aby * acx;
    if (cx * cx + cy * cy + cz * cz < 1e-18) continue; // degenerate sliver
    sink.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
}

/* Returns fragments of the triangle lying OUTSIDE the box. Empty = fully inside. */
function NSO_clipTriOutsideAABB(a, b, c, box, sink) {
  var planes = [
    [0, 1, box.max.x], [0, -1, box.min.x],
    [1, 1, box.max.y], [1, -1, box.min.y],
    [2, 1, box.max.z], [2, -1, box.min.z]
  ];
  var cur = [a.clone(), b.clone(), c.clone()];
  var inP = [], outP = [];
  for (var p = 0; p < 6; p++) {
    if (cur.length < 3) return;
    NSO_splitPolyByAxisPlane(cur, planes[p][0], planes[p][1], planes[p][2], inP, outP);
    if (outP.length >= 3) NSO_fanTriangulate(outP, sink);
    cur = inP.slice();
  }
  // whatever survived all 6 planes is strictly inside the box -> dropped
}

/* ============================================================
   2. subtractSoupBFromA — soup-level pocket cut
   ============================================================
   aWorld : hull soup, world space
   bWorld : plug soup, world space
   opts   : { plugMatrix, plugLocalBox, mode:'auto'|'box'|'centroid', wallShrink }
   Returns { ok, soup, mode, reason, hullTris, wallTris }
   ============================================================ */

/* ============================================================
   NSO rounded-hull Seat + Subtract
   Adds: hull signed-distance grid, plug frame, corner projection,
         rim clip of plug walls to hull skin.
   ============================================================ */

/* ---- hull signed-distance grid (convex-ish hull assumption) ---- */


function NSO_closestPointOnTri(p, a, b, c, out) {
  var ab = new THREE.Vector3().subVectors(b, a);
  var ac = new THREE.Vector3().subVectors(c, a);
  var ap = new THREE.Vector3().subVectors(p, a);
  var d1 = ab.dot(ap), d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  var bp = new THREE.Vector3().subVectors(p, b);
  var d3 = ab.dot(bp), d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  var vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
  var cp = new THREE.Vector3().subVectors(p, c);
  var d5 = ab.dot(cp), d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  var vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
  var va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    var w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(new THREE.Vector3().subVectors(c, b), w);
  }
  var den = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(ab, vb * den).addScaledVector(ac, vc * den);
}

function NSO_buildHullGrid(soup) {
  var n = (soup.length / 9) | 0;
  var mn = new THREE.Vector3(Infinity, Infinity, Infinity);
  var mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  var i, k;
  for (i = 0; i < soup.length; i += 3) {
    if (soup[i] < mn.x) mn.x = soup[i]; if (soup[i] > mx.x) mx.x = soup[i];
    if (soup[i + 1] < mn.y) mn.y = soup[i + 1]; if (soup[i + 1] > mx.y) mx.y = soup[i + 1];
    if (soup[i + 2] < mn.z) mn.z = soup[i + 2]; if (soup[i + 2] > mx.z) mx.z = soup[i + 2];
  }
  var size = new THREE.Vector3().subVectors(mx, mn);
  var span = Math.max(size.x, size.y, size.z) || 1;
  var res = Math.max(4, Math.min(40, Math.round(Math.cbrt(n) * 1.2)));
  var cell = span / res;

  var center = new THREE.Vector3().addVectors(mn, mx).multiplyScalar(0.5);

  /* outward-oriented per-tri normals */
  var nrm = new Float32Array(n * 3);
  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  var e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nv = new THREE.Vector3(), cen = new THREE.Vector3();
  for (i = 0; i < n; i++) {
    var o = i * 9;
    a.set(soup[o], soup[o + 1], soup[o + 2]);
    b.set(soup[o + 3], soup[o + 4], soup[o + 5]);
    c.set(soup[o + 6], soup[o + 7], soup[o + 8]);
    e1.subVectors(b, a); e2.subVectors(c, a);
    nv.crossVectors(e1, e2);
    if (nv.lengthSq() < 1e-18) { nrm[i * 3] = 0; nrm[i * 3 + 1] = 1; nrm[i * 3 + 2] = 0; continue; }
    nv.normalize();
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(center);
    if (nv.dot(cen) < 0) nv.negate();
    nrm[i * 3] = nv.x; nrm[i * 3 + 1] = nv.y; nrm[i * 3 + 2] = nv.z;
  }

  var buckets = {};
  function key(ix, iy, iz) { return ix + ',' + iy + ',' + iz; }
  for (i = 0; i < n; i++) {
    var oo = i * 9;
    var tminx = Math.min(soup[oo], soup[oo + 3], soup[oo + 6]);
    var tmaxx = Math.max(soup[oo], soup[oo + 3], soup[oo + 6]);
    var tminy = Math.min(soup[oo + 1], soup[oo + 4], soup[oo + 7]);
    var tmaxy = Math.max(soup[oo + 1], soup[oo + 4], soup[oo + 7]);
    var tminz = Math.min(soup[oo + 2], soup[oo + 5], soup[oo + 8]);
    var tmaxz = Math.max(soup[oo + 2], soup[oo + 5], soup[oo + 8]);
    var x0 = Math.floor((tminx - mn.x) / cell), x1 = Math.floor((tmaxx - mn.x) / cell);
    var y0 = Math.floor((tminy - mn.y) / cell), y1 = Math.floor((tmaxy - mn.y) / cell);
    var z0 = Math.floor((tminz - mn.z) / cell), z1 = Math.floor((tmaxz - mn.z) / cell);
    for (var gx = x0; gx <= x1; gx++)
      for (var gy = y0; gy <= y1; gy++)
        for (var gz = z0; gz <= z1; gz++) {
          var kk = key(gx, gy, gz);
          if (!buckets[kk]) buckets[kk] = [];
          buckets[kk].push(i);
        }
  }
  return { soup: soup, n: n, min: mn, cell: cell, buckets: buckets, nrm: nrm, center: center, span: span };
}

/* negative = inside. Returns { d, p, n } or null if hull is empty. */
var NSO__cp = new THREE.Vector3();
var NSO__ta = new THREE.Vector3(), NSO__tb = new THREE.Vector3(), NSO__tc = new THREE.Vector3();

function NSO_signedDistToHull(grid, x, y, z) {
  if (!grid || !grid.n) return null;
  var p = new THREE.Vector3(x, y, z);
  var cx = Math.floor((x - grid.min.x) / grid.cell);
  var cy = Math.floor((y - grid.min.y) / grid.cell);
  var cz = Math.floor((z - grid.min.z) / grid.cell);

  var best = Infinity, bestTri = -1, bestPt = new THREE.Vector3();
  var maxR = 32;
  for (var r = 0; r <= maxR; r++) {
    var found = false;
    for (var dx = -r; dx <= r; dx++)
      for (var dy = -r; dy <= r; dy++)
        for (var dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          var list = grid.buckets[(cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)];
          if (!list) continue;
          found = true;
          for (var li = 0; li < list.length; li++) {
            var ti = list[li], o = ti * 9;
            NSO__ta.set(grid.soup[o], grid.soup[o + 1], grid.soup[o + 2]);
            NSO__tb.set(grid.soup[o + 3], grid.soup[o + 4], grid.soup[o + 5]);
            NSO__tc.set(grid.soup[o + 6], grid.soup[o + 7], grid.soup[o + 8]);
            NSO_closestPointOnTri(p, NSO__ta, NSO__tb, NSO__tc, NSO__cp);
            var d2 = NSO__cp.distanceToSquared(p);
            if (d2 < best) { best = d2; bestTri = ti; bestPt.copy(NSO__cp); }
          }
        }
    /* stop once the found radius is guaranteed to enclose the true nearest */
    if (bestTri >= 0 && found && Math.sqrt(best) <= r * grid.cell) break;
    if (bestTri >= 0 && r >= 3) break;
  }
  if (bestTri < 0) return null;

  var nx = grid.nrm[bestTri * 3], ny = grid.nrm[bestTri * 3 + 1], nz = grid.nrm[bestTri * 3 + 2];
  var d = (x - bestPt.x) * nx + (y - bestPt.y) * ny + (z - bestPt.z) * nz;
  return { d: d, p: bestPt, nx: nx, ny: ny, nz: nz };
}

/* ---- plug frame: which local box face is the outer face ---- */

/* Does a corner ray from this face find the hull at all?

   The same existence question NSO_nearestSkinHit answers - a hit at t > 0
   along the punch or back along it - but it stops at the first one instead of
   ranking them, because the axis chooser only needs to know whether the face
   can see the hull, not where. */
function NSO_seatRayReaches(soup, o, dir) {
  var i, t;
  for (i = 0; i < soup.length; i += 9) {
    t = NSO_rayTri(o.x, o.y, o.z, dir.x, dir.y, dir.z,
      soup[i], soup[i + 1], soup[i + 2], soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t > 0) return true;
  }
  for (i = 0; i < soup.length; i += 9) {
    t = NSO_rayTri(o.x, o.y, o.z, -dir.x, -dir.y, -dir.z,
      soup[i], soup[i + 1], soup[i + 2], soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t > 0) return true;
  }
  return false;
}

/* Would the corner-ray fit be able to work off this candidate face? Asked the
   way the fit itself asks it: the four corners of that face, inset by
   NSO_SEAT_RAY_INSET exactly as NSO_seatRayOrigins does, each cast along that
   candidate's punch. All four, because the fit refuses on the first miss. */
function NSO_seatFaceReaches(matrix, box, axis, sign, normal, aWorld) {
  var corners = NSO_outerFaceCorners({
    matrix: matrix, box: box, axis: axis, sign: sign,
    capCoord: (sign > 0) ? box.max.getComponent(axis) : box.min.getComponent(axis)
  });
  var origins = NSO_seatRayOrigins(corners);
  var punch = normal.clone().negate();
  for (var i = 0; i < origins.length; i++) {
    if (!NSO_seatRayReaches(aWorld, origins[i], punch)) return false;
  }
  return true;
}

/* ============================================================
   NSO_plugFrame  (patched — shape-agnostic axis selection)

   THE CENTROID VECTOR IS A TIE-BREAK, NOT A DIRECTION.

   The six candidate faces are ranked by what a step out of and into each one
   meets: out of the hull and into it is a real seat axis (2), out of it only
   is a bit standing clear (1), and into it is the wrong way round (-1). Only
   when two candidates share a rank does `outward` - hull bbox centre to bit
   centre - decide, and it is scaled to 0.01 to say so.

   A bit standing clear of the hull puts ALL SIX candidates on rank 1: nothing
   steps into a hull the bit is nowhere near. That is not an unusual pose, it
   is the pose the seat deliberately creates - NSO_raiseBuriedBitClear lifts a
   dragged bit 5 mm above the hull's top before every seat - so the whole
   decision fell to the tie-break, and the tie-break is a centroid vector. Drag
   the bit across a wide flat target and the plan offset overtakes the height
   difference: on the 80 x 40 x 20 library hull with the 12 x 8 x 8 library
   bit, past 19 mm off centre `outward` leans +X, the chooser calls the bit's
   +X face the outer face, and the fit punches sideways through empty air ~13
   mm above the hull. Every corner ray misses and the seat refuses with
   "corner 0 missed hull along punch axis" - corner 0 only because it is the
   one tested first. Over half of that target's top face was unseatable, with
   both Seat buttons, for any bit. See tools/nso_seat_box_on_box_test.js.

   So when the rank ties at the top, ask the question the fit is about to ask:
   can the corner rays off this face find the hull at all? A face whose rays
   all land stays in; one whose rays fly off into space is dropped, and
   `outward` breaks whatever tie is left, exactly as before. Ranks are
   untouched, the reach test only ever runs on a tie, and it can only change
   the answer where the losing face was one the fit would have refused.
   ============================================================ */
/* The bit's frame is the piece's frame - pieceFrame (nso-bounds.js), the one
   every tool reads: its footprint's long side, the plate vertical and its
   short side. A pose is baked into the geometry when it ends (app-core.js
   nsoBakePlacedPose), so the geometry's own box is the box of a turned piece,
   not the piece's: its faces stand off it in the air. The box here is the
   bit's box in the frame's axes, carried by matrix x basis. A bit whose frame
   is its own axes (each frame axis one of them, either sense - a piece lying
   square) keeps its own box exactly: null basis.

   HELD for the geometry. The basis is in the mesh's own terms, so it turns
   with the mesh, and it is kept for as long as the mesh has that geometry:
   a seat's fit turns the bit on its mesh step by step and asks for its frame
   at every step, and the frame it fits by must be the one it started from,
   not one re-measured off the half-turned bit (as a drag holds its frame from
   press to release). A pose action bakes into new geometry, and the frame is
   measured again off that. */
function NSO_plugBasis(bitMesh) {
  if (typeof nsoBounds === 'undefined' || !nsoBounds.pieceFrame) return null;
  var g = bitMesh.geometry, pos = g && g.attributes && g.attributes.position;
  var held = bitMesh.userData.nsoPlugBasis;
  if (held && held.g === g && held.pos === pos && held.version === (pos ? pos.version : -1)) {
    return held.basis ? held.basis.clone() : null;
  }
  var f = nsoBounds.pieceFrame(bitMesh);
  var basis = null;
  if (f) {
    var inv = new THREE.Matrix4().copy(bitMesh.matrixWorld).invert();
    var e = [f.long, f.up, f.short].map(function (v) { return v.clone().transformDirection(inv); });
    var onAxis = e.every(function (v) {
      return Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) > 1 - 1e-9;
    });
    basis = onAxis ? null : new THREE.Matrix4().makeBasis(e[0], e[1], e[2]);
  }
  bitMesh.userData.nsoPlugBasis = { g: g, pos: pos, version: pos ? pos.version : -1, basis: basis };
  return basis ? basis.clone() : null;
}
function NSO_boxInBasis(geometry, basis) {
  var pos = geometry.attributes.position, el = basis.elements, box = new THREE.Box3(), v = new THREE.Vector3();
  var c = [[el[0], el[1], el[2]], [el[4], el[5], el[6]], [el[8], el[9], el[10]]];
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    box.expandByPoint(v.set(c[0][0] * x + c[0][1] * y + c[0][2] * z,
                            c[1][0] * x + c[1][1] * y + c[1][2] * z,
                            c[2][0] * x + c[2][1] * y + c[2][2] * z));
  }
  return box;
}
function NSO_plugFrame(bitMesh, hullCenterWorld, aWorld) {
  bitMesh.updateWorldMatrix(true, false);
  var basis = NSO_plugBasis(bitMesh);
  var box = basis ? NSO_boxInBasis(bitMesh.geometry, basis) : NSO_localAABB(bitMesh.geometry);
  var M = bitMesh.matrixWorld.clone();
  if (basis) M.multiply(basis);

  var plugCenterLocal = new THREE.Vector3();
  box.getCenter(plugCenterLocal);
  var plugCenterWorld = plugCenterLocal.clone().applyMatrix4(M);

  var nm = new THREE.Matrix3().getNormalMatrix(M);
  var extent = new THREE.Vector3();
  box.getSize(extent);

  var outward = new THREE.Vector3().subVectors(plugCenterWorld, hullCenterWorld || plugCenterWorld);
  if (outward.lengthSq() < 1e-12) outward.set(0, 1, 0);
  outward.normalize();

  var haveSoup = aWorld && NSO_soupLen(aWorld);
  var cand = new THREE.Vector3(), probeOut = new THREE.Vector3(), probeIn = new THREE.Vector3();
  var cands = [];

  for (var a = 0; a < 3; a++) {
    var half = Math.max(extent.getComponent(a) * 0.5, 0.5);
    var margin = half + Math.max(0.75, half * 0.25);
    for (var s = -1; s <= 1; s += 2) {
      cand.set(0, 0, 0).setComponent(a, s).applyMatrix3(nm).normalize();
      var rank, tie;
      if (haveSoup) {
        probeOut.copy(plugCenterWorld).addScaledVector(cand, margin);
        probeIn.copy(plugCenterWorld).addScaledVector(cand, -margin);
        var outOK = !NSO_pointInsideSoup(aWorld, probeOut.x, probeOut.y, probeOut.z);
        var inOK = NSO_pointInsideSoup(aWorld, probeIn.x, probeIn.y, probeIn.z);
        /* real seat axis: stepping out clears the hull AND stepping in stays
           inside it. Local + shape-agnostic, so it holds on a stepped/
           non-convex hull, unlike a single whole-hull centroid vector. */
        rank = (outOK && inOK) ? 2 : (outOK ? 1 : -1);
        tie = cand.dot(outward) * 0.01; // tie-break only
      } else {
        rank = 0;
        tie = cand.dot(outward);
      }
      cands.push({ a: a, s: s, n: cand.clone(), rank: rank, tie: tie });
    }
  }

  /* the top rank, and - when more than one candidate shares it - only those
     of them whose corner rays actually find the hull */
  var i, topRank = -Infinity;
  for (i = 0; i < cands.length; i++) if (cands[i].rank > topRank) topRank = cands[i].rank;
  var pool = [];
  for (i = 0; i < cands.length; i++) if (cands[i].rank === topRank) pool.push(cands[i]);
  if (haveSoup && pool.length > 1) {
    var reaching = [];
    for (i = 0; i < pool.length; i++) {
      if (NSO_seatFaceReaches(M, box, pool[i].a, pool[i].s, pool[i].n, aWorld)) reaching.push(pool[i]);
    }
    if (reaching.length) pool = reaching;
  }

  /* first of the best, in the candidate order the loop above built */
  var best = pool[0];
  for (i = 1; i < pool.length; i++) if (pool[i].tie > best.tie) best = pool[i];
  var axis = best.a, sign = best.s, bestN = best.n;

  return {
    matrix: M,
    inv: new THREE.Matrix4().copy(M).invert(),
    box: box,
    axis: axis,
    sign: sign,
    outerNormal: bestN.clone(),
    punch: bestN.clone().negate(),
    capCoord: (sign > 0) ? box.max.getComponent(axis) : box.min.getComponent(axis),
    span: Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  };
}

/* The four corners of the plug's local box face at `coord` on the frame
   axis, in world space. Outer face = capCoord; mating face = the opposite
   face of the same box. */
function NSO_faceCornersAt(frame, coord) {
  var a = frame.axis, u = (a + 1) % 3, v = (a + 2) % 3;
  var lo = [frame.box.min.x, frame.box.min.y, frame.box.min.z];
  var hi = [frame.box.max.x, frame.box.max.y, frame.box.max.z];
  var quad = [[lo[u], lo[v]], [hi[u], lo[v]], [hi[u], hi[v]], [lo[u], hi[v]]];
  var out = [];
  for (var i = 0; i < 4; i++) {
    var p = new THREE.Vector3();
    p.setComponent(a, coord);
    p.setComponent(u, quad[i][0]);
    p.setComponent(v, quad[i][1]);
    out.push(p.applyMatrix4(frame.matrix));
  }
  return out;
}

function NSO_outerFaceCorners(frame) {
  return NSO_faceCornersAt(frame, frame.capCoord);
}

/* The face that looks at the hull - the one a breakaway piece rests on. */
function NSO_matingFaceCorners(frame) {
  var coord = (frame.sign > 0) ? frame.box.min.getComponent(frame.axis)
                               : frame.box.max.getComponent(frame.axis);
  return NSO_faceCornersAt(frame, coord);
}

/* ---- ray vs soup, nearest hit either direction ---- */

function NSO_nearestSkinHit(soup, o, dir) {
  var bestT = Infinity, sgn = 0;
  var i;
  for (i = 0; i < soup.length; i += 9) {
    var t = NSO_rayTri(o.x, o.y, o.z, dir.x, dir.y, dir.z,
      soup[i], soup[i + 1], soup[i + 2],
      soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t > 0 && t < bestT) { bestT = t; sgn = 1; }
  }
  for (i = 0; i < soup.length; i += 9) {
    var t2 = NSO_rayTri(o.x, o.y, o.z, -dir.x, -dir.y, -dir.z,
      soup[i], soup[i + 1], soup[i + 2],
      soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t2 > 0 && t2 < bestT) { bestT = t2; sgn = -1; }
  }
  if (sgn === 0) return null;
  return o.clone().addScaledVector(dir, bestT * sgn);
}

/* How far inside its own face a corner ray starts.

   Every corner of the bit's outer face sits exactly on the bit's silhouette,
   so a ray that leaves one runs along the edge of whatever the bit's own box
   is flush with. Two pieces settled side by side on the bed are flush by
   construction - settlePlacedOnBed puts both world-box bottoms on 0.2 - and
   the bottom corner rays then travel along the hull's bottom edge, where
   NSO_rayTri needs a strictly interior barycentric hit and misses: the seat
   refused every horizontal seat with "corner 0 missed hull along punch axis"
   while the very same pieces, the bit raised by any amount, seated fine.

   One micron along the face's own diagonal moves the origin off that edge and
   nowhere else. It is ~100x the Float32 vertex noise a plate-sized coordinate
   carries (~1e-5 mm; the graze that lost the bed case measures ~1e-9), and
   1/10 of the gap slider's 0.01 mm step, 1/100 of NSO_SEAT_STRADDLE_TOL, so
   no offset the seat can express sees a different point. It is a fraction of
   the way to the face centre, never a fixed step, so a sub-millimetre bit
   still samples inside its own face rather than past it. */
var NSO_SEAT_RAY_INSET = 0.001;

function NSO_seatRayOrigins(corners) {
  var mid = new THREE.Vector3(), i;
  for (i = 0; i < corners.length; i++) mid.add(corners[i]);
  mid.multiplyScalar(1 / corners.length);
  var out = [];
  for (i = 0; i < corners.length; i++) {
    var dir = mid.clone().sub(corners[i]);
    var len = dir.length();
    out.push(len > 1e-12
      ? corners[i].clone().addScaledVector(dir, Math.min(0.25, NSO_SEAT_RAY_INSET / len))
      : corners[i].clone());
  }
  return out;
}

/* Newell normal of an ordered quad */
function NSO_newellNormal(pts) {
  var n = new THREE.Vector3();
  for (var i = 0; i < pts.length; i++) {
    var c = pts[i], d = pts[(i + 1) % pts.length];
    n.x += (c.y - d.y) * (c.z + d.z);
    n.y += (c.z - d.z) * (c.x + d.x);
    n.z += (c.x - d.x) * (c.y + d.y);
  }
  if (n.lengthSq() < 1e-16) return null;
  return n.normalize();
}

/* ============================================================
   SEAT — corner projection + best-fit tilt on a curved hull
   opts: { proud:0.4, maxTiltDeg:20, iterations:3, liftHull, liftBit }
         or { gap: -0.18, ... }

   Two ways to say where the bit goes, never both:

   proud  The bit's OUTER face (the one facing away from the hull) ends up
          this far outside the hull skin. This is the plug workflow: the bit
          is buried in the hull with its face just proud, then Subtract
          carves the pocket. The Seat flush button has always called this
          with proud 0.01 - that is the only thing "Seat 0.01" ever set.

   gap    The bit's MATING face (the one facing the hull) ends up off the
          hull skin by this much, in the breakaway-coupon sign convention
          locked in tools/breakaway_coupons.py:
              negative = air gap of that size between skin and bit
              positive = the bit penetrates the hull by that much
              0        = touching
          So a breakaway piece at the locked easy-release value is
          { gap: -0.18 }. Nothing else is different: same corner rays, same
          tilt fit, same translate-along-the-fitted-normal.

   Both modes report per-corner residuals against the requested offset.
   gap mode also reports gapAchieved / gapMin / gapMax, measured from the
   mating face after the last iteration, in the same sign convention.

   Either mode refuses, moving nothing, unless the bit is clear of the face it
   is seated to (or wholly inside it): a corner ray that misses says so, and so
   does a bit the face cuts through - see NSO_seatStraddle.

   REFERENCE SURFACE in gap mode: the skin's TIPS, not its base plane.
   A hull face that carries a contact skin (nso_skin.js - a rib lattice,
   ridges, a ring) has two surfaces: the base plane the four corner rays
   find when a corner happens to sit over a valley, and the tips plane the
   relief actually presents to the bit. "Gap 0" for a breakaway piece means
   the tips just touch B's face; a seat measured from the base plane would
   bury B in the relief by the full skin height and print a solid fuse.
   So before fitting, gap mode measures the hull's outermost point along
   the bit's normal over the bit's footprint (NSO_Skin.supportExtreme, every
   hull triangle clipped to the footprint), and compares it with the plane
   the corner rays would give. If the tips stand more than
   NSO_SEAT_TIPS_TOL above that plane the surface is a skin: B is seated
   against the tips, untilted, and the result says reference: 'tips' with
   tipRise. A flat hull measures a rise of Float32 noise and takes the
   corner-ray path unchanged, byte for byte (reference: 'plane').
   ============================================================ */

/* a relief is at least one printed layer tall; Float32 flat-face noise is ~1e-6 */
var NSO_SEAT_TIPS_TOL = 0.01;

/* How much of the bit may sit across the target face before the seat calls it
   an overhang rather than its own handiwork. A flush seat leaves the outer
   face 0.01 mm proud of the skin and the gap slider's overlap end (+0.05)
   leaves the mating face 0.05 mm inside it, so both of those must re-seat,
   not refuse; anything past this is a real protrusion the user put there. */
var NSO_SEAT_STRADDLE_TOL = 0.1;

/* How far off a GAP seat may end up and still be called a seat.

   The gap slider runs -0.25 .. +0.05, so 0.25 mm is the largest offset the
   control can ask for at all. A seat whose own read-back says the reference
   face landed further than that from the offset requested has not done what
   the slider said, whatever else it did, and "Seated" is the wrong word for
   it. Every seat the suites pin measures 0.00; this only ever fires where the
   fit did not converge.

   Gap mode only. `proud` mode is the plug seat, and its residual on a curve is
   a measured, deliberately-pinned limitation (docs/SEAT-SURFACE.md finding c,
   tools/nso_seat_curved_audit.js section 3) rather than a failure to place -
   changing it would retire a finding this repo is still carrying. */
var NSO_SEAT_GAP_RESIDUAL_LIMIT = 0.25;

/* What a gap seat says when it did not land where it was asked to. Names the
   two numbers, because "Seat failed" on its own says nothing about whether the
   pieces or the pose are the problem. */
function NSO_seatResidualReason(resid, gap) {
  return 'the fit ended ' + resid.toFixed(2) + ' mm off the '
    + Math.abs(Number(gap)).toFixed(2) + ' mm that was asked for - the surface under '
    + 'the bit is too steeply angled to the bit for the corner-ray fit to settle on it. '
    + 'Square the two up (Tip on face, or the Tilt arrows) and seat again';
}

/* The bed baseline, in Float: a settled world-box bottom lands on 0.2 to
   within rounding, so a lift measured back off it can come out a hair
   negative with nothing wrong. See the clamp in seatBitAtGap. */
var NSO_SEAT_BED_EPS = 1e-6;

/* The pose the corner-ray fit is built for: the bit approaches the target face
   from OUTSIDE it (a staged plug, a bit raised clear, a side seat), or lies
   wholly inside it (a plug being re-seated). Either way the seat slides the
   bit along the punch axis and nothing that stood proud is lost.

   A bit that STRADDLES the face - part of it standing proud, the rest already
   inside the hull - is neither. Over the hull's TOP face that pose is the bed
   drag NSO_raiseBuriedBitClear undoes, and where it cannot (a bit overhanging
   the footprint) a corner ray misses and the seat refuses. Against a vertical
   WALL nothing raises it, and when the wall happens to shadow all four corner
   rays the fit is perfectly happy: the seat drives every millimetre that stood
   proud into the hull, leaves the bit buried as a plug through that face, and
   reports "Seated". One corner further out the very same placement refuses
   with "corner N missed hull along punch axis". So refuse here too, and name
   the overhang that is in the way.

   Measured the way the fit measures, and judged one corner at a time: d is how
   far an OUTER face corner stands outside the skin along the punch, and the
   bit's depth along that axis is how far its mating face trails behind that
   corner. d >= depth: that corner's column is clear of the face and only
   approaches it. d <= what was asked for: it is at or inside the face already.
   Between the two the face cuts through the bit there, and seating would eat
   the difference. Per corner, because a hit BEHIND the ray's origin reads as a
   negative d, and a corner that far off must not combine with a clear corner
   somewhere else to look like a straddle that is not there.

   Pure - moves nothing. Returns null when no corner is cut, or when a corner
   misses the hull entirely (the fit's own refusal says so, as it always has). */
function NSO_seatStraddle(hull, bitMesh, hullCenter, off) {
  var fr = NSO_plugFrame(bitMesh, hullCenter, hull);
  var corners = NSO_outerFaceCorners(fr);
  var origins = NSO_seatRayOrigins(corners);
  var depth = fr.box.max.getComponent(fr.axis) - fr.box.min.getComponent(fr.axis);
  var cut = 0, proudBy = -Infinity;
  for (var i = 0; i < 4; i++) {
    var h = NSO_nearestSkinHit(hull, origins[i], fr.punch);
    if (!h) return null;
    var d = corners[i].clone().sub(h).dot(fr.outerNormal);
    if (d > off + NSO_SEAT_STRADDLE_TOL && d < depth - NSO_SEAT_STRADDLE_TOL) {
      cut++;
      if (d > proudBy) proudBy = d;
    }
  }
  if (!cut) return null;
  return { proudBy: proudBy, corners: cut, depth: depth, normal: fr.outerNormal.clone() };
}

/* The tips probe: null when the hull under the bit is flat (or NSO_Skin is
   not loaded), else { s, sPlane, rise, point, hits }. Pure - moves nothing.

   THE RELIEF IS MEASURED AGAINST THE PLANE OF THE FOUR HITS, NOT THEIR MEAN.

   `rise` picks which of the two seats runs. Over NSO_SEAT_TIPS_TOL the bit is
   set against the tips UNTILTED; under it the corner-ray fit runs and tilts
   the bit onto the face. So `rise` has to answer one question and only that
   one: does the surface under the bit stand proud of the face the corner rays
   found?

   It used to be `ext.s - mean(hit . n)` - an extreme height against an AVERAGE
   height, both along the BIT's own normal. Those two agree only while the face
   is square to that normal. Tilt either piece by one press of the Tilt arrows
   and the four hits sit at four different heights along n, their mean lands at
   the middle of the face, and the highest point of that same FLAT face stands
   above the mean by half the face's rise across the footprint: 1.07 mm at 15
   degrees, 2.31 mm at 30, 4.00 mm at 45, on the plain flat top of
   library/box_hull_80x40x20.stl. Every one of those is a hundred times
   NSO_SEAT_TIPS_TOL, so a flat box top was called a contact skin and seated
   with the tilt fit skipped: the bit left parallel to the plate, hanging off
   the high edge of the slope and touching nothing, at a true shell-to-shell
   separation of 0.174 / 0.156 / 0.127 mm while the status line read
   `measured -0.180mm, skin error 0.00mm`. The tips path measures its own
   residuals against the very extreme it positioned from, so that wrong seat
   read exactly like a right one. See tools/nso_seat_tilted_face_test.js.

   The plane through the four hits is the quantity that was meant, and the fit
   already builds it - NSO_newellNormal of the hit quad is the plane it tilts
   onto. A flat face at ANY angle puts its own extreme point IN that plane, so
   the rise comes out as Float32 noise and the corner-ray path runs, byte for
   byte as it did before the tips reference existed. A real relief still stands
   its tip height proud of the plane its valleys' rays found, so the skin case
   is untouched. A hit quad with no Newell normal, or one so edge-on to the
   bit's own normal that the projection means nothing, keeps the old mean -
   which is what a four-hit average is for. */
function NSO_seatTipsProbe(hull, bitMesh, hullCenter) {
  if (typeof NSO_Skin === 'undefined' || !NSO_Skin || !NSO_Skin.supportExtreme) return null;
  var fr = NSO_plugFrame(bitMesh, hullCenter, hull);
  var mating = NSO_matingFaceCorners(fr), outer = NSO_outerFaceCorners(fr);
  var nrm = fr.outerNormal;
  var fp = [], i;
  for (i = 0; i < 4; i++) fp.push([mating[i].x, mating[i].y, mating[i].z]);
  var sOuter = outer[0].dot(nrm);
  var ext = NSO_Skin.supportExtreme(hull, fp, [nrm.x, nrm.y, nrm.z], { sMax: sOuter });
  if (!ext) return null;
  var hits = [], sSum = 0;
  var oRay = NSO_seatRayOrigins(outer);
  for (i = 0; i < 4; i++) {
    var h = NSO_nearestSkinHit(hull, oRay[i], fr.punch);
    if (!h) return null;
    hits.push(h);
    sSum += h.dot(nrm);
  }
  var sPlane = sSum / 4;
  var extPt = new THREE.Vector3(ext.point[0], ext.point[1], ext.point[2]);
  var rise = ext.s - sPlane;              /* the fallback, and what it used to be */
  var nFit = NSO_newellNormal(hits);
  if (nFit) {
    if (nFit.dot(nrm) < 0) nFit.negate();
    if (nFit.dot(nrm) > 1e-3) {
      var hitC = new THREE.Vector3();
      for (i = 0; i < 4; i++) hitC.add(hits[i]);
      hitC.multiplyScalar(0.25);
      rise = extPt.clone().sub(hitC).dot(nFit);
    }
  }
  return { s: ext.s, sPlane: sPlane, rise: rise, point: extPt, hits: hits };
}

function NSO_seatFlushBitToHull(hullMesh, bitMesh, opts) {
  opts = opts || {};
  var proud = (opts.proud === undefined) ? 0.4 : opts.proud;
  var maxTilt = ((opts.maxTiltDeg === undefined) ? 20 : opts.maxTiltDeg) * Math.PI / 180;
  var iters = opts.iterations || 3;

  var hasGap = (opts.gap !== undefined && opts.gap !== null);
  var gap = hasGap ? Number(opts.gap) : null;
  if (hasGap && !isFinite(gap)) return { ok: false, reason: 'gap must be a finite number of mm' };
  if (hasGap && (opts.proud !== undefined || opts.lip !== undefined)) {
    return { ok: false, reason: 'give gap or proud/lip, not both' };
  }

  if (!hullMesh || !bitMesh) return { ok: false, reason: 'missing mesh' };

  var hull = meshToWorldSoup(hullMesh, opts.liftHull);
  if (!hull.length) return { ok: false, reason: 'empty hull' };
  var hullSoup = hull;

  /* save for fail-safe restore */
  var savedPos = bitMesh.position.clone();
  var savedQuat = bitMesh.quaternion.clone();

  hullMesh.updateWorldMatrix(true, false);
  if (!hullMesh.geometry.boundingBox) hullMesh.geometry.computeBoundingBox();
  var hullCenter = new THREE.Vector3();
  hullMesh.geometry.boundingBox.getCenter(hullCenter);
  hullCenter.applyMatrix4(hullMesh.matrixWorld);

  var lastFit = null, lastCorners = null, lastHits = null;
  var lip = (opts.lip !== undefined) ? Number(opts.lip) : null;
  var bitDepth = 0;
  if (lip != null && isFinite(lip)) {
    var frame0 = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    bitDepth = frame0.box.max.getComponent(frame0.axis) - frame0.box.min.getComponent(frame0.axis);
    proud = -(Math.max(bitDepth, lip) - lip);
  }

  /* The face the offset is measured from, and how far outside the skin it
     must land. A gap is measured from the mating face and its sign is the
     coupon convention (negative = air), so it flips to "outside the skin". */
  var refInner = hasGap;
  var off = hasGap ? -gap : proud;

  /* a bit already cut by the face it is being seated to: refuse, never
     collapse the part of it that stands proud - see NSO_seatStraddle */
  var straddle = NSO_seatStraddle(hull, bitMesh, hullCenter, off);
  if (straddle) {
    return { ok: false, straddle: straddle,
      reason: 'bit straddles that hull face - ' + straddle.proudBy.toFixed(2)
        + 'mm of it stands proud and the rest is already inside. Move it clear of the face'
        + ' (or fully inside) and seat again' };
  }

  /* gap mode: is the surface under the bit a skin? measure before moving */
  var probe = hasGap ? NSO_seatTipsProbe(hull, bitMesh, hullCenter) : null;
  if (probe && probe.rise > NSO_SEAT_TIPS_TOL) {
    var frT = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var nT = frT.outerNormal.clone();
    var cmT = NSO_matingFaceCorners(frT);
    var faceS = 0;
    for (var m0 = 0; m0 < 4; m0++) faceS += cmT[m0].dot(nT);
    faceS /= 4;
    /* mating face lands `off` outside the tips along the bit's own normal; no tilt */
    bitMesh.position.addScaledVector(nT, (probe.s + off) - faceS);
    bitMesh.updateMatrixWorld(true);

    /* the same hull the fit was given, so the read-back cannot pick a
       different face than the seat just used - see the note on frameF */
    var frR = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var cmR = NSO_matingFaceCorners(frR), coR = NSO_outerFaceCorners(frR);
    var residT = [], maxT = 0, tMin = Infinity, tMax = -Infinity, tSum = 0;
    for (var r0 = 0; r0 < 4; r0++) {
      var dvT = cmR[r0].dot(nT) - probe.s;      /* outside the tips = positive */
      residT.push(dvT);
      if (Math.abs(dvT - off) > maxT) maxT = Math.abs(dvT - off);
      tSum += dvT; if (dvT < tMin) tMin = dvT; if (dvT > tMax) tMax = dvT;
    }
    if (maxT > NSO_SEAT_GAP_RESIDUAL_LIMIT) {
      bitMesh.position.copy(savedPos);
      bitMesh.quaternion.copy(savedQuat);
      bitMesh.updateMatrixWorld(true);
      return { ok: false, residual: maxT, reason: NSO_seatResidualReason(maxT, gap) };
    }
    return {
      ok: true,
      mode: 'gap',
      reference: 'tips',
      tipRise: probe.rise,
      tipsPoint: probe.point,
      normal: nT,
      corners: coR,
      hits: probe.hits,
      cornerResidual: residT,
      maxResidual: maxT,
      undo: { position: savedPos, quaternion: savedQuat },
      gap: gap,
      gapAchieved: -(tSum / 4),
      gapMin: -tMax,
      gapMax: -tMin
    };
  }

  for (var it = 0; it < iters; it++) {
    var frame = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var corners = NSO_outerFaceCorners(frame);
    var rayFrom = NSO_seatRayOrigins(corners);
    var punch = frame.punch;

    var hits = [];
    for (var i = 0; i < 4; i++) {
      var h = NSO_nearestSkinHit(hull, rayFrom[i], punch);
      if (!h) {
        bitMesh.position.copy(savedPos);
        bitMesh.quaternion.copy(savedQuat);
        bitMesh.updateMatrixWorld(true);
        return { ok: false, reason: 'corner ' + i + ' missed hull along punch axis' };
      }
      hits.push(h);
    }

    var nFit = NSO_newellNormal(hits);
    if (!nFit) {
      bitMesh.position.copy(savedPos);
      bitMesh.quaternion.copy(savedQuat);
      bitMesh.updateMatrixWorld(true);
      return { ok: false, reason: 'degenerate hit quad' };
    }
    if (nFit.dot(frame.outerNormal) < 0) nFit.negate();

    /* ---- tilt: rotate outer normal onto the fitted plane normal, clamped ---- */
    var q = new THREE.Quaternion().setFromUnitVectors(frame.outerNormal, nFit);
    var ang = 2 * Math.acos(Math.min(1, Math.max(-1, q.w)));
    if (ang > maxTilt) {
      q.slerp(new THREE.Quaternion(), 0); // no-op guard for old three builds
      q = new THREE.Quaternion().slerpQuaternions
        ? new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), q, maxTilt / ang)
        : new THREE.Quaternion().copy(q); // r147 has slerpQuaternions
    }

    var pivot = new THREE.Vector3();
    for (var c = 0; c < 4; c++) pivot.add(corners[c]);
    pivot.multiplyScalar(0.25);

    bitMesh.quaternion.premultiply(q);
    var rel = new THREE.Vector3().subVectors(bitMesh.position, pivot).applyQuaternion(q);
    bitMesh.position.copy(pivot).add(rel);
    bitMesh.updateMatrixWorld(true);

    /* ---- translate along the fitted normal only (preserves Center X/Z) ---- */
    var frame2 = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var corners2 = refInner ? NSO_matingFaceCorners(frame2) : NSO_outerFaceCorners(frame2);
    var faceC = new THREE.Vector3();
    for (var c2 = 0; c2 < 4; c2++) faceC.add(corners2[c2]);
    faceC.multiplyScalar(0.25);

    var hitC = new THREE.Vector3();
    for (var h2 = 0; h2 < 4; h2++) hitC.add(hits[h2]);
    hitC.multiplyScalar(0.25);

    var target = hitC.clone().addScaledVector(nFit, off);
    var along = target.clone().sub(faceC).dot(nFit);
    bitMesh.position.addScaledVector(nFit, along);
    bitMesh.updateMatrixWorld(true);

    lastFit = nFit; lastCorners = corners2; lastHits = hits;
  }

  /* residual report: how far each corner of the reference face ends up from
     the skin, against the offset that was asked for */
  /* THE READ-BACK ASKS THE HULL, EXACTLY AS THE FIT DID.

     This call used to omit the hull soup. Without it NSO_plugFrame has no
     hull to probe and falls all the way back to the raw centroid rule - bit
     centre minus hull bbox centre - which is the rule the fit itself stopped
     trusting. So the report could name a different face than the seat had
     just worked off: on the 80 x 40 library hull, a bit seated 25 mm off
     centre was measured against its +X face, every corner ray missed, and
     every number below went quietly soft - cornerResidual all NaN, maxResidual
     left at its initial 0, gapAchieved NaN. seatBitAtGap then prints the gap
     that was ASKED for as the one it MEASURED, and "skin error 0.00mm", on a
     seat nothing checked. A wrong seat and a right one read identically.

     Handing it hullSoup is the whole fix: the read-back and the fit now ask
     one question of one hull, so the residuals describe the face the bit was
     actually seated against. */
  var frameF = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
  var cf = NSO_outerFaceCorners(frameF);
  var cfRay = NSO_seatRayOrigins(cf);
  var cref = refInner ? NSO_matingFaceCorners(frameF) : cf;
  var resid = [], maxResid = 0, dMin = Infinity, dMax = -Infinity, dSum = 0, dN = 0;
  for (var r = 0; r < 4; r++) {
    /* Rays leave the OUTER corners, as they did in the fit, and the mating
       face is read off by subtracting the bit's depth along the normal. A
       ray cast from a corner that sits exactly on the skin (gap 0) would
       miss that face - the hit filter rejects t = 0 - and report the far
       side of the hull instead. */
    var hh = NSO_nearestSkinHit(hull, cfRay[r], frameF.punch);
    var dv = hh ? cf[r].clone().sub(hh).dot(frameF.outerNormal) : NaN;
    if (refInner && isFinite(dv)) dv -= cf[r].clone().sub(cref[r]).dot(frameF.outerNormal);
    resid.push(dv);
    if (isFinite(dv) && Math.abs(dv - off) > maxResid) maxResid = Math.abs(dv - off);
    if (isFinite(dv)) { dN++; dSum += dv; if (dv < dMin) dMin = dv; if (dv > dMax) dMax = dv; }
  }

  if (hasGap && maxResid > NSO_SEAT_GAP_RESIDUAL_LIMIT) {
    bitMesh.position.copy(savedPos);
    bitMesh.quaternion.copy(savedQuat);
    bitMesh.updateMatrixWorld(true);
    return { ok: false, residual: maxResid, reason: NSO_seatResidualReason(maxResid, gap) };
  }

  var out = {
    ok: true,
    mode: hasGap ? 'gap' : 'proud',
    reference: 'plane',
    tipRise: probe ? probe.rise : 0,
    normal: lastFit ? lastFit.clone() : frameF.outerNormal.clone(),
    corners: cf,
    hits: lastHits,
    cornerResidual: resid,
    maxResidual: maxResid,
    undo: { position: savedPos, quaternion: savedQuat }
  };
  if (hasGap) {
    /* back into the coupon convention: outside the skin = negative gap */
    out.gap = gap;
    out.gapAchieved = dN ? -(dSum / dN) : NaN;
    out.gapMin = dN ? -dMax : NaN;
    out.gapMax = dN ? -dMin : NaN;
  } else {
    out.proud = proud;
  }
  return out;
}


/* ============================================================
   SUBTRACT — box clip hull, rim-clip plug walls to the skin
   ============================================================ */

/* clip a triangle to the region inside the hull (d < 0), curved boundary
   located by bisection along edges. Fan-triangulates into sink. */
function NSO_clipTriInsideHull(grid, A, B, C, sink) {
  var pts = [A, B, C];
  var ds = [];
  var k;
  for (k = 0; k < 3; k++) {
    var r = NSO_signedDistToHull(grid, pts[k].x, pts[k].y, pts[k].z);
    ds.push(r ? r.d : 1);
  }
  var nIn = (ds[0] < 0 ? 1 : 0) + (ds[1] < 0 ? 1 : 0) + (ds[2] < 0 ? 1 : 0);
  if (nIn === 0) return 0;
  if (nIn === 3) {
    sink.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
    return 1;
  }

  var poly = [];
  for (k = 0; k < 3; k++) {
    var p = pts[k], q = pts[(k + 1) % 3];
    var dp = ds[k], dq = ds[(k + 1) % 3];
    if (dp < 0) poly.push(p.clone());
    if ((dp < 0) !== (dq < 0)) {
      /* bisect for the true skin crossing */
      var lo = p.clone(), hi = q.clone();
      if (dp >= 0) { lo = q.clone(); hi = p.clone(); } // lo is inside
      var mid = new THREE.Vector3();
      for (var b = 0; b < 12; b++) {
        mid.addVectors(lo, hi).multiplyScalar(0.5);
        var rr = NSO_signedDistToHull(grid, mid.x, mid.y, mid.z);
        if (rr && rr.d < 0) lo.copy(mid); else hi.copy(mid);
      }
      poly.push(lo.clone().add(hi).multiplyScalar(0.5));
    }
  }
  if (poly.length < 3) return 0;
  var before = sink.length;
  NSO_fanTriangulate(poly, sink);
  return (sink.length - before) / 9;
}



function NSO_wallHitsAlong(soup, ox, oy, oz, dir, maxDist) {
  var hits = [];
  if (!soup || !dir) return hits;
  for (var i = 0; i < soup.length; i += 9) {
    var t = NSO_rayTri(ox, oy, oz, dir.x, dir.y, dir.z,
      soup[i], soup[i + 1], soup[i + 2],
      soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t > 1e-3 && t < maxDist) hits.push(t);
  }
  hits.sort(function (a, b) { return a - b; });
  var uniq = [];
  for (var h = 0; h < hits.length; h++) {
    if (!uniq.length || hits[h] - uniq[uniq.length - 1] > 0.15) uniq.push(hits[h]);
  }
  return uniq;
}

function NSO_farWallMarch(grid, ox, oy, oz, dir, maxDist, tol) {
  var d0 = NSO_signedDistToHull(grid, ox, oy, oz);
  if (!d0) return null;
  var t0 = 0;
  if (d0.d >= 0) {
    var seek = 0, found = false, guard0 = 0;
    while (seek < maxDist && guard0 < 400) {
      guard0++;
      seek += Math.max(tol * 4, 0.15);
      var s0 = NSO_signedDistToHull(grid, ox + dir.x * seek, oy + dir.y * seek, oz + dir.z * seek);
      if (s0 && s0.d < 0) { t0 = seek; d0 = s0; found = true; break; }
    }
    if (!found) return null;
  }

  var t = t0, cur = d0.d, guard = 0;
  while (t < maxDist && guard < 2000) {
    guard++;
    var step = Math.max(Math.abs(cur), tol);
    var tNext = t + step;
    var s = NSO_signedDistToHull(grid, ox + dir.x * tNext, oy + dir.y * tNext, oz + dir.z * tNext);
    if (!s) return null;
    if (s.d >= 0) {
      var lo = t, hi = tNext;
      for (var b = 0; b < 12 && (hi - lo) > tol; b++) {
        var mid = (lo + hi) * 0.5;
        var sm = NSO_signedDistToHull(grid, ox + dir.x * mid, oy + dir.y * mid, oz + dir.z * mid);
        if (!sm || sm.d < 0) lo = mid; else hi = mid;
      }
      return { dist: hi };
    }
    t = tNext; cur = s.d;
  }
  return null;
}

/* The boolean kernel - NSO_CSG, the weld and edge helpers, the union / subtract / punch cores and
   the worker dispatch under NSO_unionSoups, NSO_subtractSoups and subtractSoupBFromA - lives in
   nso_csg.js, a file the page and the boolean worker (nso_work.js) both load. */

/* =====================================================================
   REPLACEMENT: subtractBFromA
   Same selection checks, same undo shape (subtractReplace), same mesh
   swap/cleanup as before. Only change: awaits the now-async subtract,
   and the status/log line reflects open-edge/NM counts instead of the
   old wall-clearance readout.
   ===================================================================== */
async function subtractBFromA() {
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (idA == null || idB == null || idA === idB) {
    setStatus('Select hull A and bit B', true);
    return;
  }
  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  if (!modelA || !modelB) {
    setStatus('Select hull A and bit B', true);
    return;
  }
  const placedA = state.placed.find(p => p && p.sourceId === idA);
  const placedB = state.placed.find(p => p && p.sourceId === idB);
  if (!placedA || !placedB || !placedA.mesh || !placedB.mesh) {
    setStatus('Select hull A and bit B', true);
    return;
  }
  // Work as is (nso-helpers.js, nsoOverlap): a piece whose shells overlap goes to the kernel as those shells
  // merged into one solid. A is replaced by the result anyway; B is used up.
  const solSub = (typeof nsoOverlap !== 'undefined' && nsoOverlap)
    ? await nsoOverlap.solids([modelA, modelB], (m, i) => { const pl = i ? placedB : placedA; return { geometry: pl.mesh.geometry, mesh: pl.mesh }; })
    : { ok: true, list: [], note: '' };
  if (!solSub.ok) {
    setStatus(solSub.cancelled ? 'Subtract stopped - nothing was changed' : 'Subtract refused - ' + solSub.reason + ' - A and B unchanged', !solSub.cancelled);
    return;
  }

  let newGeo = null;
  try {
    placedA.mesh.updateMatrixWorld(true);
    placedB.mesh.updateMatrixWorld(true);
    const aWorld = (solSub.list[0] && solSub.list[0].merged) ? solSub.list[0].world : meshToWorldSoup(placedA.mesh);
    const bWorld = (solSub.list[1] && solSub.list[1].merged) ? solSub.list[1].world : meshToWorldSoup(placedB.mesh);
    placedA.mesh.updateMatrixWorld(true);
    if (!placedA.mesh.geometry.boundingBox) placedA.mesh.geometry.computeBoundingBox();
    const hullCenter = new THREE.Vector3();
    placedA.mesh.geometry.boundingBox.getCenter(hullCenter);
    hullCenter.applyMatrix4(placedA.mesh.matrixWorld);
    const frame = NSO_plugFrame(placedB.mesh, hullCenter, aWorld);

    setStatus('Subtracting (loading CSG kernel)...');
    const res = await subtractSoupBFromA(aWorld, bWorld, {
      plugFrame: frame,
      minWall: 1.0
    });
    if (res && (res.cancelled || res.timedOut)) {
      setStatus(res.cancelled ? 'Subtract stopped - nothing was changed' : 'Subtract stopped - ' + res.reason, !res.cancelled);
      return;
    }
    if (!res || !res.ok || !res.soup || res.soup.length < 9) {
      throw new Error((res && res.reason) ? res.reason : 'result empty');
    }
    newGeo = soupToCenteredGeo(res.soup);
    window.__nestSubtractMsg = 'Subtract ok - open edges ' +
      res.openBefore + '→' + res.openAfter +
      ', non-manifold ' + res.nmBefore + '→' + res.nmAfter;
    /* The nozzle-safety finding rides the SUCCESS line as one more ' - '
       clause, the way the defect overlay appends "(counted, not painted)" and
       Skin appends "two shells: flagged non-solid": the cut is done and kept,
       and this says what it cost. isError stays false - a finding is not a
       failure, and the cut is not reverted. cutWarning() is '' on a cut that
       leaves a printable wall, so an ordinary cut reads exactly as before. */
    var cutWarn = (typeof NSO_Thickness !== 'undefined' && res.clearance)
      ? NSO_Thickness.cutWarning(res.clearance) : '';
    if (cutWarn) window.__nestSubtractMsg += ' - ' + cutWarn;
    if (solSub.note) window.__nestSubtractMsg += ' - ' + solSub.note;
  } catch (err) {
    const why = (err && err.message) ? String(err.message) : 'unknown';
    console.warn('[subtract] failed:', why);
    setStatus('Subtract failed - ' + why, true);
    return;
  }

  pushUndo({
    type: 'subtractReplace',
    aId: idA,
    aPrevMask: (typeof nsoMaskSnapshot === 'function') ? nsoMaskSnapshot(modelA) : undefined,
    aPrevGeometry: modelA.geometry.clone(),
    aPrevRawTris: modelA.rawTris,
    aPrevRawAxis: modelA.rawAxis,
    aPrevCenterOffset: modelA.centerOffset,
    aPrevSize: { x: modelA.size.x, y: modelA.size.y, z: modelA.size.z },
    aPrevPose: (placedA && typeof nsoPlacedPoseSnapshot === 'function') ? nsoPlacedPoseSnapshot(placedA) : null,
    bSnapshot: {
      id: modelB.id,
      name: modelB.name,
      geometry: modelB.geometry.clone(),
      quantity: modelB.quantity || 1,
      size: { x: modelB.size.x, y: modelB.size.y, z: modelB.size.z },
      orientedGeometry: null,
      rawTris: modelB.rawTris || null,
      rawAxis: modelB.rawAxis || null,
      centerOffset: modelB.centerOffset || null
    },
    poseB: { x: placedB.x, z: placedB.z },
    placedBIndex: state.placed.indexOf(placedB)
  });

  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  const rawOut = displayGeometryToRawSoup(newGeo);

  modelA.geometry = newGeo;
  modelA.rawTris = rawOut;
  modelA.rawAxis = 'zup';
  modelA.centerOffset = computeCenterOffsetFromRaw(rawOut);
  modelA.size = { x: size2.x, y: size2.y, z: size2.z };

  state.models = state.models.filter(x => x.id !== idB);
  if (placedB.mesh && state.modelGroup) {
    state.modelGroup.remove(placedB.mesh);
    if (placedB.mesh.material) {
      if (Array.isArray(placedB.mesh.material)) placedB.mesh.material.forEach(mt => mt.dispose());
      else placedB.mesh.material.dispose();
    }
  }
  state.placed = state.placed.filter(p => p !== placedB);
  reindexPlacedMeshes();

  state.joinPartnerId = null;
  state.joinThirdId = null;
  state.joinFaceC = null;
  state.joinSession = false;
  state.joinArmed = null;

  if (placedA.mesh && state.modelGroup) {
    state.modelGroup.remove(placedA.mesh);
    if (placedA.mesh.material) {
      if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
      else placedA.mesh.material.dispose();
    }
  }
  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
    emissive: 0x0a3a5c, emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(modelA.geometry, mat);
  mesh.position.set(placedA.x, modelA.size.y / 2 + 0.3, placedA.z);
  mesh.userData.sourceId = modelA.id;
  mesh.userData.placedIndex = state.placed.indexOf(placedA);
  state.modelGroup.add(mesh);
  placedA.mesh = mesh;
  placedA.geometry = modelA.geometry;
  placedA.width = modelA.size.x;
  placedA.depth = modelA.size.z;
  placedA.height = modelA.size.y;
  // The difference was taken in world space, so A's pose is in the geometry
  // now and the mesh above is built at identity. Clear the record to match,
  // or the next bake re-applies it on top (see nsoClearPlacedPose).
  if (typeof nsoClearPlacedPose === 'function') nsoClearPlacedPose(placedA);

  updateEditSize();
  renderModelList();
  updateAdjustUI();
  updateUndoBtn();
  removeFaceHelper();
  updateJoinUI();
  setStatus(window.__nestSubtractMsg || 'Subtract ok');
}

function centerJoinAxis(axis) {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Open JOIN, Pick A and B, then Center', true);
    return;
  }
  const placedA = state.placed.find(function (q) { return q && q.sourceId === idA && q.mesh; });
  const placedB = state.placed.find(function (q) { return q && q.sourceId === idB && q.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both pieces must be on the plate', true);
    return;
  }
  placedA.mesh.updateMatrixWorld(true);
  placedB.mesh.updateMatrixWorld(true);
  const ba = meshLocalBox3(placedA.mesh);
  const bb = meshLocalBox3(placedB.mesh);
  const cax = (ba.min.x + ba.max.x) / 2;
  const caz = (ba.min.z + ba.max.z) / 2;
  const cbx = (bb.min.x + bb.max.x) / 2;
  const cbz = (bb.min.z + bb.max.z) / 2;
  const punchIsX = Math.abs(cbx - cax) >= Math.abs(cbz - caz);
  if (axis === 'x' && punchIsX) {
    setStatus('Center X would pull the plug into the hull - use Center Z on this face', true);
    return;
  }
  if (axis === 'z' && !punchIsX) {
    setStatus('Center Z would pull the plug into the hull - use Center X on this face', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  let nx = placedB.x, nz = placedB.z;
  if (axis === 'x') nx += (cax - cbx);
  else nz += (caz - cbz);
  applyPlacedXZ(placedB, nx, nz);
  setStatus(axis === 'x' ? 'Centered on face X' : 'Centered on face Z');
}


function flipPortOnPunch() {
  const placedB = state.placed.find(p => p && p.sourceId === state.joinPartnerId);
  const placedA = state.placed.find(p => p && p.sourceId === state.editId);
  const bit = placedB && placedB.mesh;
  const hull = placedA && placedA.mesh;
  if (!bit || !hull) {
    setStatus('Open JOIN, pick hull A and tunnel B, then Flip port', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  hull.updateMatrixWorld(true);
  bit.updateMatrixWorld(true);
  const hc = new THREE.Vector3();
  if (!hull.geometry.boundingBox) hull.geometry.computeBoundingBox();
  hull.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(hull.matrixWorld);
  /* The MESH, not the placed record. meshToWorldSoup bakes matrixWorld into
     the soup, so only a mesh can answer it - a placed record carries a
     `geometry` (which gets it past the guard) but no updateWorldMatrix, and
     the call died on `placed.updateWorldMatrix is not a function` before
     NSO_plugFrame ever saw a hull. `hull` is placedA.mesh and was already
     updated two lines up, which is the same pair reportJoinFlushGap uses. */
  const aWorld = (typeof meshToWorldSoup === 'function') ? meshToWorldSoup(hull) : null;
  const frame = NSO_plugFrame(bit, hc, aWorld);
  const axis = frame.outerNormal && frame.outerNormal.lengthSq() > 1e-8
    ? frame.outerNormal.clone().normalize()
    : new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  bit.quaternion.premultiply(q);
  bit.updateMatrixWorld(true);
  if (placedB.rotY == null) placedB.rotY = 0;
  setStatus('Port flipped 180 on punch - Seat flush again');
}

/* A bit whose underside is below the hull's top while its footprint lies
   inside the hull's is buried in the hull. A drag along the bed puts it
   there - drag never lifts - and so does a Raise that stops short of the
   top. The plug frame reads the open air BELOW the plate as clear of the
   hull and seats such a bit downward into it: the core answers "held at
   plate level: gap NOT as requested" and the bit never moves (the live
   "Seat does not seat" report). Nothing can ever seat below the plate, so
   the bit is raised clear of the hull's top first and seats from above -
   the pose the corner-ray fit is built for. XZ and the bit's quaternion are
   untouched, only its lift; the seat then measures its own lift from the
   result, as it always has. Returns the pose to put back on a failed seat
   (null = nothing was moved). Not a core change: NSO_seatFlushBitToHull is
   byte-identical, so its pinned poses hold. */
var NSO_SEAT_CLEARANCE = 5;   /* mm above the hull's top - the staged pose the seat checks use */
function NSO_raiseBuriedBitClear(placedA, placedB) {
  if (!placedA || !placedB || !placedA.mesh || !placedB.mesh) return null;
  placedA.mesh.updateMatrixWorld(true);
  placedB.mesh.updateMatrixWorld(true);
  const ba = meshLocalBox3(placedA.mesh);
  const bb = meshLocalBox3(placedB.mesh);
  const TOL = 0.05;   /* the pad meshBandExtent allows a wall */
  const within = bb.min.x >= ba.min.x - TOL && bb.max.x <= ba.max.x + TOL
              && bb.min.z >= ba.min.z - TOL && bb.max.z <= ba.max.z + TOL;
  if (!within) return null;
  if (bb.min.y >= ba.max.y - 1e-6) return null;   /* already above the hull */
  const before = { position: placedB.mesh.position.clone(), quaternion: placedB.mesh.quaternion.clone(), liftY: placedB.liftY || 0 };
  /* settlePlacedOnBed puts the world box bottom on 0.2 + liftY */
  placedB.liftY = ba.max.y + NSO_SEAT_CLEARANCE - 0.2;
  settlePlacedOnBed(placedB);
  placedB.mesh.updateMatrixWorld(true);
  return before;
}
function NSO_restoreRaisedBit(placedB, before) {
  if (!before || !placedB || !placedB.mesh) return;
  placedB.mesh.position.copy(before.position);
  placedB.mesh.quaternion.copy(before.quaternion);
  placedB.liftY = before.liftY;
  placedB.mesh.updateMatrixWorld(true);
}

/* Seat flush's proud value. One constant so the seat, the status line and the
   record the scene block reads cannot say three different numbers. */
const SEAT_FLUSH_PROUD = 0.01;

/* What a Seat leaves behind on the piece it moved.

   Neither seat could be read back before this: the gap lived on the slider and
   the result lived in the pose. The record is what the 3MF scene block writes
   (nso-3mf-scene.js) so a reopened plate says which gap a pair was seated at
   instead of only where the two pieces happen to sit. It is descriptive - the
   pose is still the truth, and nothing re-seats from it. Cleared by a fresh
   seat, which overwrites it. */
function NSO_recordSeat(placedB, placedA, info) {
  if (!placedB || !info || !isFinite(Number(info.gap))) return;
  placedB.seat = {
    gap: Number(info.gap),
    kind: info.kind === 'flush' ? 'flush' : 'support',
    partnerName: (placedA && placedA.name) ? placedA.name : '',
    partnerIndex: (typeof state !== 'undefined' && state.placed) ? state.placed.indexOf(placedA) : null,
    measured: isFinite(Number(info.measured)) ? Number(info.measured) : null,
    residual: isFinite(Number(info.residual)) ? Number(info.residual) : null,
    reference: info.reference === 'tips' ? 'tips' : 'face'
  };
}

function seatFlushBitToHull() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Open JOIN, A = hull, B = bit, then Seat flush', true);
    return;
  }
  const placedA = state.placed.find(function (p) { return p && p.sourceId === idA && p.mesh; });
  const placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both hull and bit must be on the plate', true);
    return;
  }
  // Seat flush is the flush plug seat this button has always done: outer
  // face 0.01 mm proud of A's skin, then Subtract. It never reads the gap
  // slider - that belongs to Seat (support).
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  const raised = NSO_raiseBuriedBitClear(placedA, placedB);
  const res = NSO_seatFlushBitToHull(placedA.mesh, placedB.mesh, { proud: SEAT_FLUSH_PROUD });
  if (!res || !res.ok) {
    NSO_restoreRaisedBit(placedB, raised);
    setStatus('Seat failed - ' + ((res && res.reason) || 'pieces unchanged'), true);
    return;
  }
  placedB.x = placedB.mesh.position.x;
  placedB.z = placedB.mesh.position.z;
  // where the origin sits with B's lowest point on the baseline: nsoBelowOrigin
  // under it, which is half the height only for a posed box centred on it
  const baseY = nsoBelowOrigin(placedB.mesh, placedB.height ||
    (placedB.mesh.geometry.boundingBox && (placedB.mesh.geometry.boundingBox.max.y - placedB.mesh.geometry.boundingBox.min.y)) || 10) + 0.2;
  placedB.liftY = Math.max(0, placedB.mesh.position.y - baseY);
  applyPlacedXZ(placedB, placedB.x, placedB.z);
  var resid = (res.maxResidual != null && isFinite(res.maxResidual)) ? res.maxResidual : 0;
  NSO_recordSeat(placedB, placedA, {
    gap: SEAT_FLUSH_PROUD, kind: 'flush', measured: null, residual: resid, reference: res.reference
  });
  setStatus('Seated - proud ' + SEAT_FLUSH_PROUD + 'mm, skin error ' + resid.toFixed(2) + 'mm - Subtract');
}

/* Seat (support): B's mating face at the gap the slider shows, coupon sign
   convention - negative = air gap, positive = overlap, 0 = touching. */
function seatSupportBitToHull() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Open JOIN, A = hull, B = bit, then Seat (support)', true);
    return;
  }
  const placedA = state.placed.find(function (p) { return p && p.sourceId === idA && p.mesh; });
  const placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both hull and bit must be on the plate', true);
    return;
  }
  /* The oversized-washer export mode, and only while it is explicitly armed:
     a washer wider than its target has corner rays standing over open air, so
     the corner-ray fit below refuses it whatever gap is asked for. Armed, the
     placement goes through the measured-clearance seat instead and that
     refusal becomes a line on the status line - see app-oversize-washer.js.
     Unarmed, this is one property read and everything below is unchanged. */
  if (window.NSO_OversizeWasher && window.NSO_OversizeWasher.armed()) {
    window.NSO_OversizeWasher.seat(placedA, placedB);
    return;
  }
  const gap = readSeatGapInput();
  if (!isFinite(gap)) {
    setStatus('Seat gap slider is missing or out of range - nothing seated', true);
    return;
  }
  return seatBitAtGap(placedA, placedB, gap);
}

/* The gap slider's value in mm, or NaN when the slider is missing or its
   value is outside its own range (a range input clamps user input, so that
   only happens to a value set from code). Never a silent fallback.

   `id` names which gap input to read, defaulting to the card's own slider.
   Triple join's two per-junction gaps go through this same reader rather
   than a copy of these rules: two inputs that disagreed with the slider
   about what -0.18 means is not a bug anyone would think to look for. */
function readSeatGapInput(id) {
  const el = document.getElementById(id || 'seat-gap');
  if (!el) return NaN;
  const v = Number(el.value);
  const lo = Number(el.min), hi = Number(el.max);
  if (!isFinite(v)) return NaN;
  if (isFinite(lo) && v < lo - 1e-9) return NaN;
  if (isFinite(hi) && v > hi + 1e-9) return NaN;
  // step is 0.01: snap what we send so the seat asks for exactly the number
  // the readout shows, not -0.18000000000000002
  return Math.round(v * 100) / 100;
}

function NSO_formatSeatGap(v) {
  if (!isFinite(v)) return '-';
  const r = Math.round(v * 100) / 100;
  const s = r.toFixed(2);
  return (r > 0 ? '+' : '') + (r === 0 ? '0.00' : s) + ' mm';
}

/* Keep the readout on the exact slider value; called on every input event
   and once at start-up so the default (-0.18, mid easy-release) is shown. */
function updateSeatGapReadout(id, outId) {
  const out = document.getElementById(outId || 'seat-gap-value');
  if (!out) return;
  out.textContent = NSO_formatSeatGap(readSeatGapInput(id));
}

/* Seat B's mating face `gap` mm off A's skin (coupon convention) and make
   the plate record match, so the export writes the same relation the
   scene shows.

   Returns what it did: { ok, gap, measured, residual, reference, clamped } on
   a seat, { ok: false, reason } on a refusal. The button never needed a
   return value - the status line IS its report - but a caller that chains
   seats (app-join-triple.js) has to know whether to run the next one, and
   scraping the status text for that would make the wording load-bearing.
   Purely additive: the status line and every pose this writes are unchanged,
   which is what the Seat suites pin. */
function seatBitAtGap(placedA, placedB, gap) {
  // Both pieces on the bed baseline settlePlacedOnBed uses, the way Align
  // edges does through matchPlacedBottoms. A piece that was dropped and never
  // moved sits 0.1 mm higher than a settled one; liftY is measured from the
  // settled baseline and is what the exports write, so with A left where it
  // was dropped that 0.1 would land in the exported gap. Not acceptable when
  // the whole easy-release window is 0.05 mm wide.
  settlePlacedOnBed(placedA);
  placedA.mesh.updateMatrixWorld(true);

  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  // A bit buried in the hull (dragged over it along the bed) seats from
  // above, never down into the plate - see NSO_raiseBuriedBitClear.
  const raised = NSO_raiseBuriedBitClear(placedA, placedB);
  const res = NSO_seatFlushBitToHull(placedA.mesh, placedB.mesh, { gap: gap });
  if (!res || !res.ok) {
    NSO_restoreRaisedBit(placedB, raised);
    const why = (res && res.reason) || 'pieces unchanged';
    setStatus('Seat failed - ' + why, true);
    return { ok: false, reason: why };
  }
  placedB.x = placedB.mesh.position.x;
  placedB.z = placedB.mesh.position.z;
  // liftY is exactly what settlePlacedOnBed needs to put the bit back where
  // Seat left it: it sets y so the world box bottom lands on 0.2 + liftY.
  const bb = meshLocalBox3(placedB.mesh);
  let lift = bb.min.y - 0.2;
  let clamped = false;
  /* A horizontal seat slides the bit along the bed and never changes its
     height, so a bit that was already settled comes back with a lift of
     -1e-16: the bed baseline in Float, not a piece the seat pushed into the
     plate. Only a sink the seat could actually express is worth the warning -
     the slider's own 0.01 mm step is the smallest of those, and this epsilon
     is four orders below it. */
  if (lift < -NSO_SEAT_BED_EPS) { clamped = true; lift = 0; }
  else if (lift < 0) lift = 0;
  placedB.liftY = lift;
  applyPlacedXZ(placedB, placedB.x, placedB.z);

  const resid = (res.maxResidual != null && isFinite(res.maxResidual)) ? res.maxResidual : 0;
  const got = isFinite(res.gapAchieved) ? res.gapAchieved : gap;
  NSO_recordSeat(placedB, placedA, {
    gap: gap, kind: 'support', measured: got, residual: resid, reference: res.reference
  });
  let what;
  if (gap < 0) what = 'air gap ' + Math.abs(gap).toFixed(2) + 'mm';
  else if (gap > 0) what = 'overlap ' + gap.toFixed(2) + 'mm';
  else what = 'touching, gap 0.00mm';
  // measured value keeps its sign so a wrong-way seat can never read as right
  let msg = 'Seated - ' + what + ' (measured ' + (got > 0 ? '+' : '') + got.toFixed(3) + 'mm, skin error ' + resid.toFixed(2) + 'mm)';
  // A skinned hull: say so, and say how far the tips stand off the base
  // plane, so a seat that silently measured from the wrong surface could
  // never read the same as one that measured from the tips.
  if (res.reference === 'tips') msg += ' - from skin tips, relief ' + res.tipRise.toFixed(2) + 'mm above the base plane';
  if (clamped) msg += ' - bit would sink below the plate, held at plate level: gap NOT as requested';
  setStatus(msg, clamped);
  /* A clamped seat did NOT land on the gap it was asked for, and says so. A
     chained caller must treat that as a failure, not a seat with a caveat -
     the whole point of a per-junction gap is that the junction is at it. */
  return {
    ok: !clamped, gap: gap, measured: got, residual: resid,
    reference: res.reference, clamped: clamped,
    reason: clamped ? 'bit would sink below the plate, held at plate level: gap NOT as requested' : ''
  };
}




function reportJoinFlushGap() {
  if (!state.joinSession) return false;
  const idB = state.joinPartnerId;
  let idA = state.joinHullId != null ? state.joinHullId : state.editId;
  if (idA == null || idB == null) return false;
  if (idA === idB) {
    idA = state.joinHullId;
    if (idA == null || idA === idB) return false;
  }
  const placedA = state.placed.find(function (q) { return q && q.sourceId === idA && q.mesh; });
  const placedB = state.placed.find(function (q) { return q && q.sourceId === idB && q.mesh; });
  if (!placedA || !placedB) return false;
  try {
    placedA.mesh.updateMatrixWorld(true);
    placedB.mesh.updateMatrixWorld(true);
    const hull = meshToWorldSoup(placedA.mesh);
    if (!hull || !hull.length) return false;
    if (!placedA.mesh.geometry.boundingBox) placedA.mesh.geometry.computeBoundingBox();
    const hullCenter = new THREE.Vector3();
    placedA.mesh.geometry.boundingBox.getCenter(hullCenter);
    hullCenter.applyMatrix4(placedA.mesh.matrixWorld);
    const frame = NSO_plugFrame(placedB.mesh, hullCenter, hull);
    const corners = NSO_outerFaceCorners(frame);
    const rayFrom = NSO_seatRayOrigins(corners);
    let n = 0, sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const h = NSO_nearestSkinHit(hull, rayFrom[i], frame.punch);
      if (!h) continue;
      const d = corners[i].clone().sub(h).dot(frame.outerNormal);
      if (!isFinite(d)) continue;
      n++; sum += d; if (d < mn) mn = d; if (d > mx) mx = d;
    }
    if (!n) {
      setStatus('Flush - no skin hit under bit');
      return true;
    }
    const mid = sum / n;
    let tag = 'gap';
    if (mid > 0.15) tag = 'outside';
    else if (mid < -0.15) tag = 'buried';
    else tag = 'flush';
    setStatus('Flush ' + mid.toFixed(2) + 'mm (' + tag + ')  min ' + mn.toFixed(2) + '  max ' + mx.toFixed(2));
    return true;
  } catch (err) {
    return false;
  }
}

function soupAxisBox(min, max) {
  const x0 = min.x, y0 = min.y, z0 = min.z;
  const x1 = max.x, y1 = max.y, z1 = max.z;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [5, 4, 7, 5, 7, 6],
    [4, 0, 3, 4, 3, 7],
    [1, 5, 6, 1, 6, 2],
    [3, 2, 6, 3, 6, 7],
    [4, 5, 1, 4, 1, 0]
  ];
  const out = [];
  for (let f = 0; f < faces.length; f++) {
    const idx = faces[f];
    for (let k = 0; k < 6; k++) {
      const pt = v[idx[k]];
      out.push(pt[0], pt[1], pt[2]);
    }
  }
  return new Float32Array(out);
}

// New helper: 6-connected flood fill over the empty-cell grid, returns the
// largest connected empty region as index-space min/max (or null if the
// grid has no empty cells at all).
function NSO_floodFillLargestEmptyCluster(empty, nx, ny, nz) {
  const total = nx * ny * nz;
  const visited = new Uint8Array(total);
  const stackX = new Int32Array(total);
  const stackY = new Int32Array(total);
  const stackZ = new Int32Array(total);
  const idx3 = function (ix, iy, iz) { return (ix * ny + iy) * nz + iz; };

  let best = null;

  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const startIdx = idx3(ix, iy, iz);
        if (!empty[startIdx] || visited[startIdx]) continue;

        let sp = 0;
        stackX[sp] = ix; stackY[sp] = iy; stackZ[sp] = iz; sp++;
        visited[startIdx] = 1;

        let size = 0;
        let minIx = ix, minIy = iy, minIz = iz;
        let maxIx = ix, maxIy = iy, maxIz = iz;

        while (sp > 0) {
          sp--;
          const cx = stackX[sp], cy = stackY[sp], cz = stackZ[sp];
          size++;
          if (cx < minIx) minIx = cx; if (cx > maxIx) maxIx = cx;
          if (cy < minIy) minIy = cy; if (cy > maxIy) maxIy = cy;
          if (cz < minIz) minIz = cz; if (cz > maxIz) maxIz = cz;

          if (cx > 0) { const n = idx3(cx - 1, cy, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx - 1; stackY[sp] = cy; stackZ[sp] = cz; sp++; } }
          if (cx < nx - 1) { const n = idx3(cx + 1, cy, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx + 1; stackY[sp] = cy; stackZ[sp] = cz; sp++; } }
          if (cy > 0) { const n = idx3(cx, cy - 1, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy - 1; stackZ[sp] = cz; sp++; } }
          if (cy < ny - 1) { const n = idx3(cx, cy + 1, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy + 1; stackZ[sp] = cz; sp++; } }
          if (cz > 0) { const n = idx3(cx, cy, cz - 1); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy; stackZ[sp] = cz - 1; sp++; } }
          if (cz < nz - 1) { const n = idx3(cx, cy, cz + 1); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy; stackZ[sp] = cz + 1; sp++; } }
        }

        if (!best || size > best.size) {
          best = { size: size, minIx: minIx, minIy: minIy, minIz: minIz, maxIx: maxIx, maxIy: maxIy, maxIz: maxIz };
        }
      }
    }
  }

  return best;
}

async function extractBitFromSelected() {
  const p = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
  const model = p && p.sourceId != null
    ? state.models.find(function (m) { return m.id === p.sourceId; })
    : getActiveModel();
  if (!p || !p.mesh || !model || !model.geometry) {
    setStatus('Select a tile on the plate first', true);
    return;
  }
  // The cavity is found by even-odd inside tests, which shells laid over one
  // another turn inside out: such a piece is read as its shells merged into one
  // solid (nso-helpers.js, nsoOverlap). The piece itself is not touched.
  const solBit = (typeof nsoOverlap !== 'undefined' && nsoOverlap)
    ? await nsoOverlap.solid(model, { geometry: model.geometry }) : { ok: true, merged: false };
  if (!solBit.ok) {
    setStatus(solBit.cancelled ? 'Extract stopped - piece unchanged' : 'Extract refused - ' + solBit.reason + ' - piece unchanged', !solBit.cancelled);
    return;
  }
  const py = p.mesh.position.y;
  let soupPiece;
  if (solBit.merged) {
    soupPiece = new Float32Array(solBit.soup.length);
    for (let i = 0; i < soupPiece.length; i += 3) {
      soupPiece[i] = solBit.soup[i] + p.x; soupPiece[i + 1] = solBit.soup[i + 1] + py; soupPiece[i + 2] = solBit.soup[i + 2] + p.z;
    }
  } else {
    soupPiece = geomToWorldSoup(model.geometry, p.x, py, p.z);
  }
  if (!soupPiece || soupPiece.length < 9) {
    setStatus('Extract failed - piece unchanged', true);
    return;
  }
  p.mesh.updateMatrixWorld(true);
  const bb = meshLocalBox3(p.mesh);
  const inset = 0.45;
  const x0 = bb.min.x + inset, x1 = bb.max.x - inset;
  const y0 = bb.min.y + inset, y1 = bb.max.y - inset;
  const z0 = bb.min.z + inset, z1 = bb.max.z - inset;
  if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
    setStatus('Extract failed - tile too thin', true);
    return;
  }

  // Same sampling grid as before - cell centers on the 1.2mm lattice.
  const step = 1.2;
  const half = step * 0.49;
  const xs = [];
  for (let x = x0 + half; x <= x1 - half + 1e-6; x += step) xs.push(x);
  const ys = [];
  for (let y = y0 + half; y <= y1 - half + 1e-6; y += step) ys.push(y);
  const zs = [];
  for (let z = z0 + half; z <= z1 - half + 1e-6; z += step) zs.push(z);
  const nx = xs.length, ny = ys.length, nz = zs.length;
  if (nx < 1 || ny < 1 || nz < 1) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  const empty = new Uint8Array(nx * ny * nz);
  let emptyCount = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        if (!NSO_pointInsideSoup(soupPiece, xs[ix], ys[iy], zs[iz])) {
          empty[(ix * ny + iy) * nz + iz] = 1;
          emptyCount++;
        }
      }
    }
  }
  if (emptyCount < 4) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  // Flood-fill (6-connected) to the single largest empty region - this is
  // the fix: no more one cube per empty cell.
  const cluster = NSO_floodFillLargestEmptyCluster(empty, nx, ny, nz);
  if (!cluster || cluster.size < 4) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  // One box spanning the cluster's cell extents.
  const mn = {
    x: xs[cluster.minIx] - half,
    y: ys[cluster.minIy] - half,
    z: zs[cluster.minIz] - half
  };
  const mx = {
    x: xs[cluster.maxIx] + half,
    y: ys[cluster.maxIy] + half,
    z: zs[cluster.maxIz] + half
  };

  const bitSoup = soupAxisBox(mn, mx);
  if (!bitSoup || bitSoup.length < 9) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  const geo = soupToCenteredGeo(bitSoup);
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const rawOut = displayGeometryToRawSoup(geo);
  const id = addModel((model.name || 'tile') + '-bit', geo, {
    rawTris: rawOut,
    rawAxis: 'zup',
    centerOffset: computeCenterOffsetFromRaw(rawOut),
    keepSelection: true,
    silent: true
  });
  if (!id) {
    setStatus('Extract failed - piece unchanged', true);
    return;
  }
  pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
  const xPlace = p.x + (p.width || size.x) / 2 + size.x / 2 + 6;
  const m = state.models.find(function (mm) { return mm.id === id; });
  if (m) placeModelMovable(m, xPlace, p.z);
  setStatus('Extract bit ok - solid ' + size.x.toFixed(1) + 'x' + size.y.toFixed(1) + 'x' + size.z.toFixed(1) + ' mm' +
    (solBit.merged ? ' - ' + solBit.note : ''));
}

async function joinSelectedModels() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Open JOIN, Pick A, Pick B, then JOIN', true);
    return;
  }
  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  if (!modelA || !modelB) {
    setStatus('Select two pieces to join', true);
    return;
  }

  const placedA = state.placed.find(p => p && p.sourceId === idA);
  const placedB = state.placed.find(p => p && p.sourceId === idB);

  // Work as is (nso-helpers.js, nsoOverlap): a piece whose shells overlap is
  // welded as those shells merged into one solid. The fuse and the plate weld
  // would stack the shells, so a merged pair goes to the kernel union alone.
  const solJoin = (typeof nsoOverlap !== 'undefined' && nsoOverlap && placedA && placedB && placedA.mesh && placedB.mesh)
    ? await nsoOverlap.solids([modelA, modelB], (m, i) => { const pl = i ? placedB : placedA; return { geometry: pl.mesh.geometry, mesh: pl.mesh }; })
    : { ok: true, list: [], note: '' };
  if (!solJoin.ok) {
    setStatus(solJoin.cancelled ? 'Join stopped - nothing was changed' : 'Join refused - ' + solJoin.reason + ' - A and B unchanged', !solJoin.cancelled);
    return;
  }
  const solidOnly = !!solJoin.note;
  const poseA = placedA ? { x: placedA.x, z: placedA.z } : { x: 0, z: 0 };
  const poseB = placedB ? { x: placedB.x, z: placedB.z } : { x: 0, z: 0 };

  // Join axis/direction from current plate positions — X is the axis
  // Split itself always uses to lay pieces out, so this matches every
  // real scenario (rejoining halves, attaching a stored end to a bar).
  // Where the two pieces start, for the seal report and for the kernel. Taken
  // before either route runs, since the plate route may nudge the poses.
  let joinSoupA = null, joinSoupB = null;
  if (placedA && placedB && typeof meshToWorldSoup === 'function') {
    try {
      // the meshes, not the placed records - only a mesh carries matrixWorld
      const mA = placedA.mesh || placedA, mB = placedB.mesh || placedB;
      if (mA.updateMatrixWorld) mA.updateMatrixWorld(true);
      if (mB.updateMatrixWorld) mB.updateMatrixWorld(true);
      joinSoupA = (solJoin.list[0] && solJoin.list[0].merged) ? solJoin.list[0].world : meshToWorldSoup(mA);
      joinSoupB = (solJoin.list[1] && solJoin.list[1].merged) ? solJoin.list[1].world : meshToWorldSoup(mB);
      if (!NSO_soupLen(joinSoupA) || !NSO_soupLen(joinSoupB)) joinSoupA = joinSoupB = null;
    } catch (e) { joinSoupA = joinSoupB = null; }
  }
  let before = { open: 0, nm: 0 };
  if (joinSoupA && joinSoupB) {
    const bA = NSO_edgeStats(joinSoupA), bB = NSO_edgeStats(joinSoupB);
    before = { open: bA.open + bB.open, nm: bA.nm + bB.nm };
  }
  const score = (st) => st.open + st.nm;

  // Route 0: real fusion. Two halves of one square cut close their shared
  // face with a cap each, to stay watertight on their own. When those caps
  // are congruent, dropping both and welding the two boundary loops is a
  // true join - the seam stops existing - instead of shoving the far piece
  // in and hiding the caps inside the solid.
  //
  // NSO_findSharedFace is the gate, and it is holistic: every cap triangle
  // on both sides must have a partner, so one unpaired triangle refuses the
  // whole fuse rather than welding the part that lined up. A pair that does
  // not qualify costs one failed detection and falls through to the routes
  // below, which is the pre-existing behaviour unchanged.
  //
  // Runs on the RAW soups, not the placed ones. A 20mm box split at 10mm has
  // clean 2-triangle caps in raw space; the same caps in display space carry
  // extra seed vertices at +/- halfKerf and a degenerate sliver, so congruence
  // detection correctly refuses them. Raw is the representation the cut
  // actually produced.
  let fuseGeo = null, fuseStats = null, fuseInfo = null, fuseWhy = '';
  const paintedJoin = (typeof nsoMaskCount === 'function')
    ? (nsoMaskCount(modelA) + nsoMaskCount(modelB)) : 0;
  if (solidOnly) {
    fuseWhy = 'overlapping shells merged - the kernel union welds them';
  } else if (typeof NSO_fuseFindMating !== 'function' || typeof NSO_planarFusePair !== 'function') {
    fuseWhy = 'fusion module not loaded';
  } else if (paintedJoin > 0) {
    // Paint wins (docs/HANDOFF.md), and the Paint faces button says so in as
    // many words: excluded faces are excluded from Join. Fusion deletes the
    // cap triangles outright and takes no skip list, so it stands down.
    //
    // PAINT SCOPE: WHOLE-PIECE, on BOTH sides. Any painted face on either
    // piece declines this route - the mating face is only found after the
    // fact, so there is no sub-region to scope to at the point of the check.
    // See the scoping rule in docs/HANDOFF.md.
    fuseWhy = paintedJoin + ' painted face(s) - fusion has no skip list';
  } else {
    try {
      // Each piece's CURRENT pose (placedA/placedB.mesh's rotation) must be
      // folded in here, not dropped: fuse hands its output straight to
      // joinSelectedModels, which then clears the pose off the record on
      // the assumption that every route's geometry already carries it (see
      // nsoClearPlacedPose's call site below). For an axis-preserving pose
      // (a 90/180/270 turn, a flip) the rotated cap still lines up and fuse
      // still finds and welds it, now correctly turned; for anything else
      // the rotated cap no longer aligns to X/Y/Z, mating search finds
      // nothing, and fuse declines - correctly, since a piece tipped at a
      // free angle is no longer flush with its mate, and no fuse route
      // should silently paper over that. Route 2 (kernel union) picks up
      // from there and handles any orientation via a real boolean union.
      const rawA = NSO_rotateRawSoupByPlacedPose(getModelRawSoup(modelA), placedA);
      const rawB = NSO_rotateRawSoupByPlacedPose(getModelRawSoup(modelB), placedB);
      if (!NSO_soupLen(rawA) || !NSO_soupLen(rawB)) {
        fuseWhy = 'no raw soup for one side';
      } else {
        const mated = NSO_fuseFindMating(rawA, rawB);
        if (!mated.ok) {
          fuseWhy = mated.reason + ' (tried ' + mated.tried + ' mating(s))';
        } else {
          const fp = NSO_planarFusePair(mated.a, mated.b, { found: mated.found });
          if (!fp.ok) {
            fuseWhy = fp.reason;
          } else {
            const fst = NSO_edgeStats(fp.soup);
            // Same rule the other routes answer to: two sealed pieces must not
            // come back as an open one.
            const rawBefore = { a: NSO_edgeStats(rawA), b: NSO_edgeStats(rawB) };
            const sealedBefore = (rawBefore.a.open + rawBefore.b.open === 0) &&
                                 (rawBefore.a.nm + rawBefore.b.nm === 0);
            if (sealedBefore && (fst.open > 0 || fst.nm > 0)) {
              fuseWhy = 'fused result not watertight (open ' + fst.open +
                        ', non-manifold ' + fst.nm + ')';
            } else {
              fuseGeo = rawResultToDisplayGeometry(fp.soup);
              fuseStats = fst;
              fuseInfo = fp.stats;
              fuseInfo.axis = mated.axis;
              fuseInfo.tried = mated.tried;
            }
          }
        }
      }
    } catch (err) {
      fuseWhy = NSO_errMsg(err);
      console.warn('[join] planar fuse failed:', fuseWhy);
    }
  }
  if (fuseInfo) {
    console.log('[join] planar fuse', fuseInfo.triIn + ' -> ' + fuseInfo.triOut +
      ' tris, caps ' + fuseInfo.capA + '+' + fuseInfo.capB + ' removed, tol ' +
      fuseInfo.tol.toExponential(3) + ', verts snapped ' + fuseInfo.vertsSnapped +
      ', mate axis ' + 'xyz'[fuseInfo.axis] + ' (' + fuseInfo.tried + ' tried)');
  } else {
    console.log('[join] planar fuse declined:', fuseWhy);
  }

  // Route 1: the geometry path this has always used. It strips the facing cap
  // off at a plane and welds, which is right for two square-split halves and
  // is kept bit-identical for them.
  let legacyGeo = null, legacyStats = null, legacyWhy = '';
  if (fuseGeo) {
    // A real fuse already landed. Skip the plate route rather than let it
    // nudge the poses to close a kerf that is no longer there.
    legacyWhy = 'not needed - planar fuse succeeded';
  } else if (solidOnly) {
    legacyWhy = 'overlapping shells merged - the kernel union welds them';
  } else try {
    if (placedA && placedB) {
      const yA = placedA.mesh ? placedA.mesh.position.y : 0;
      const yB = placedB.mesh ? placedB.mesh.position.y : 0;
      const seated = Math.abs(yA - yB) > 3.5;
      if (seated && typeof meshToWorldSoup === 'function') {
        const sa = meshToWorldSoup(placedA.mesh);
        const sb = meshToWorldSoup(placedB.mesh);
        if (!sa || !sb || sa.length < 9 || sb.length < 9) throw new Error('in-place join empty soup');
        let merged = new Float32Array(sa.length + sb.length);
        merged.set(sa, 0);
        merged.set(sb, sa.length);
        if (typeof weldSoupVerts === 'function') merged = weldSoupVerts(merged, NSO_weldEpsFor(merged, 0.22));
        if (typeof repairJoinedSoup === 'function') merged = repairJoinedSoup(merged);
        if (!merged || merged.length < 9) throw new Error('in-place join empty');
        legacyGeo = soupToCenteredGeo(merged);
        legacyStats = NSO_edgeStats(merged);
        console.log('[join] in-place weld (seated port)');
      } else {
        const axisName = detectMateAxis(placedA, placedB);
        const axisIdx = axisName === 'z' ? 2 : 0;
        legacyGeo = joinHalvesOnPlate(modelA, placedA, modelB, placedB, axisIdx);
        legacyStats = NSO_edgeStats(displayGeometryToRawSoup(legacyGeo));
      }
    } else {
      const aIsMin = poseA.x <= poseB.x;
      const rawA = getModelRawSoup(modelA);
      const rawB = getModelRawSoup(modelB);
      const joinedRaw = rawJoinPieces(aIsMin ? rawA : rawB, aIsMin ? rawB : rawA, 0);
      legacyGeo = rawResultToDisplayGeometry(joinedRaw);
      legacyStats = NSO_edgeStats(joinedRaw);
    }
  } catch (err) {
    legacyWhy = (err && err.message) ? err.message : 'failed';
    console.warn('[join] plate route failed:', legacyWhy);
  }

  // Route 2: a real union on the same kernel Subtract uses. Cutting a wrapped
  // face off at a plane leaves its rounded rim hanging, so the plate route
  // reopens a wrap - the kernel does not. Only reached when the two pieces
  // already touch; split halves parked a kerf apart come back as two parts and
  // stay with route 1, which closes that gap by moving the far half in.
  let kernelGeo = null, kernelStats = null, kernelWhy = '', kernelExact = false;
  if (!fuseGeo && joinSoupA && joinSoupB && (!legacyStats || score(legacyStats) > score(before))) {
    try {
      setStatus('Joining (loading CSG kernel)...');
      const u = await NSO_unionSoups(joinSoupA, joinSoupB);
      /* Stopped (Escape) or timed out in the worker: the whole Join stops. Falling through to another
         route would commit a join the user just said no to. */
      if (u.cancelled || u.timedOut) {
        setStatus(u.cancelled ? 'Join stopped - nothing was changed' : 'Join stopped - ' + u.reason, !u.cancelled);
        return;
      }
      if (u.ok && u.soup && u.soup.length >= 9) {
        kernelGeo = soupToCenteredGeo(u.soup);
        // the kernel's own count, not one rounded off the soup
        kernelStats = u.stats || NSO_edgeStats(u.soup);
        kernelExact = !!u.stats;
      } else {
        kernelWhy = u.reason || 'union missed';
      }
    } catch (err) {
      kernelWhy = NSO_errMsg(err);
      console.warn('[join] kernel union failed:', kernelWhy);
    }
  }

  // Keep whichever route seals better; a tie goes to the plate route so the
  // square-split rejoin it was written for comes out exactly as before.
  let newGeo = null, after = null, route = '', exact = false;
  if (fuseGeo) {
    newGeo = fuseGeo; after = fuseStats; route = 'planar fuse';
  } else if (legacyGeo && (!kernelStats || score(legacyStats) <= score(kernelStats))) {
    newGeo = legacyGeo; after = legacyStats; route = 'plate weld';
  } else if (kernelGeo) {
    newGeo = kernelGeo; after = kernelStats; route = 'kernel union'; exact = kernelExact;
  }
  if (!newGeo) {
    const why = legacyWhy || kernelWhy || fuseWhy || 'pieces unchanged';
    setStatus('Join failed - ' + why + ' - A and B unchanged', true);
    return;
  }
  // Two sealed pieces must not come back as an open one. The plate route
  // always "succeeds" - it moves the far piece in to close a kerf - so on a
  // pair that does not actually mate it would hand back a reopened wrap. If
  // both routes leave it worse sealed than it started, that is a clean fail
  // with A and B untouched, not a join. Pieces that arrive open keep the old
  // permissive behaviour; the counts are reported either way.
  // `exact` means the kernel certified this itself - one part, and open/
  // non-manifold counted over shared indices rather than rounded positions.
  // Nothing measured off the soup can overrule that.
  if (!exact && before.open === 0 && before.nm === 0 && after && (after.open > 0 || after.nm > 0)) {
    setStatus('Join failed - would reopen the pieces (open edges 0\u2192' + after.open +
              ', non-manifold 0\u2192' + after.nm + ') via ' + route +
              (kernelWhy ? '; kernel union: ' + kernelWhy : '') +
              ' - A and B unchanged', true);
    return;
  }
  console.log('[join] route', route, 'open', before.open, '->', after.open,
    'nonManifold', before.nm, '->', after.nm);

  // Snapshot BOTH pieces (full state, including plate pose) before
  // mutating anything, so Undo can fully restore two separate pieces.
  pushUndo({
    type: 'joinReplace',
    aId: idA,
    aPrevMask: (typeof nsoMaskSnapshot === 'function') ? nsoMaskSnapshot(modelA) : undefined,
    aPrevGeometry: modelA.geometry.clone(),
    aPrevRawTris: modelA.rawTris,
    aPrevRawAxis: modelA.rawAxis,
    aPrevCenterOffset: modelA.centerOffset,
    aPrevSize: { x: modelA.size.x, y: modelA.size.y, z: modelA.size.z },
    aPrevPose: (placedA && typeof nsoPlacedPoseSnapshot === 'function') ? nsoPlacedPoseSnapshot(placedA) : null,
    bSnapshot: {
      id: modelB.id,
      name: modelB.name,
      geometry: modelB.geometry.clone(),
      quantity: modelB.quantity || 1,
      size: { x: modelB.size.x, y: modelB.size.y, z: modelB.size.z },
      orientedGeometry: null,
      rawTris: modelB.rawTris || null,
      rawAxis: modelB.rawAxis || null,
      centerOffset: modelB.centerOffset || null
    },
    poseB: poseB,
    placedBIndex: placedB ? state.placed.indexOf(placedB) : -1
  });

  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  const joinedRaw = displayGeometryToRawSoup(newGeo);

  modelA.geometry = newGeo;
  modelA.rawTris = joinedRaw;
  modelA.rawAxis = 'zup';
  modelA.centerOffset = computeCenterOffsetFromRaw(joinedRaw);
  modelA.size = { x: size2.x, y: size2.y, z: size2.z };

  // Remove B from the library and the plate.
  state.models = state.models.filter(x => x.id !== idB);
  if (placedB) {
    if (placedB.mesh && state.modelGroup) {
      state.modelGroup.remove(placedB.mesh);
      if (placedB.mesh.material) {
        if (Array.isArray(placedB.mesh.material)) placedB.mesh.material.forEach(mt => mt.dispose());
        else placedB.mesh.material.dispose();
      }
    }
    state.placed = state.placed.filter(p => p !== placedB);
    reindexPlacedMeshes();
  }
  state.joinPartnerId = null;
  state.joinThirdId = null;
  state.joinFaceC = null;
  state.joinSession = false;
  state.joinArmed = null;

  // Park the union at the midpoint of the two halves.
  if (placedA) {
    const px = (poseA.x + poseB.x) / 2;
    const pz = (poseA.z + poseB.z) / 2;
    placedA.x = px;
    placedA.z = pz;
    if (placedA.mesh && state.modelGroup) {
      state.modelGroup.remove(placedA.mesh);
      if (placedA.mesh.material) {
        if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
        else placedA.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(modelA.geometry, mat);
    mesh.position.set(px, modelA.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = modelA.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedA);
    state.modelGroup.add(mesh);
    placedA.mesh = mesh;
    placedA.geometry = modelA.geometry;
    placedA.width = modelA.size.x;
    placedA.depth = modelA.size.z;
    placedA.height = modelA.size.y;
    /* The union is drawn at identity: whichever route made it, the pose A
       had is either baked into the soup (seated weld, kernel union - world
       soups) or not part of the result at all (planar fuse, plate weld -
       unposed geometry). Either way the record must stop claiming it. Left
       set, the next bake that honours the record - Mirror, through
       NSO_sculptCommitRaw - re-applies it, and an A that was edge-flipped
       before this Join comes out of that Mirror turned 180 degrees. */
    if (typeof nsoClearPlacedPose === 'function') nsoClearPlacedPose(placedA);
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateAdjustUI();
  updateUndoBtn();
  removeFaceHelper();
  setStatus('Join ok (' + route + ') - open edges ' + before.open + '\u2192' + after.open +
            ', non-manifold ' + before.nm + '\u2192' + after.nm +
            (fuseInfo ? '; seam fused, ' + fuseInfo.removed + ' cap tri(s) removed, ' +
                        fuseInfo.triIn + '\u2192' + fuseInfo.triOut + ' tris' : '') +
            (solJoin.note ? ' - ' + solJoin.note : ''));
}


// splitBothSides lives in app-cut.js: one engine (rawCut) for every Cut.

// opts.rightSideOut: the click on "Turn it right-side-out, then cut" (see
// "Cut on an inside-out piece" in app-cut.js). The Split button's click event
// carries no such field, so a plain Cut never turns anything.
function cutActiveModel(opts) {
  const rightSideOut = !!(opts && opts.rightSideOut === true);
  const offer = state.cutRightSideOutOffer;
  // Any Cut attempt answers the last offer; a refusal below makes a new one.
  if (typeof cutClearRightSideOutOffer === 'function') cutClearRightSideOutOffer();
  try {
  if (!state.cutterOpen || (state.cutTool || 'cut') !== 'cut') {
    setStatus('Open Cut first', true);
    return;
  }
  const m = getActiveModel();
  if (!m) {
    setStatus('Load an STL first', true);
    return;
  }
  const info = getCutPlaneForSplit(m);
  if (!info) {
    setStatus('Cannot resolve cut plane - reopen Cut', true);
    return;
  }
  const axis = info.axis;
  const plateAxis = info.plateAxis || axis;
  const span = info.span;
  const plane = info.plane;
  // Distance from min end - the readout's own number
  const cutMm = info.mm != null ? info.mm : (plane - info.origin);
  if (span < MIN_CUT_SIDE_MM * 2) {
    setStatus('Piece too short to cut (need >= ' + (MIN_CUT_SIDE_MM * 2) + ' mm along cut axis)', true);
    return;
  }
  if (cutMm < MIN_CUT_SIDE_MM || cutMm > span - MIN_CUT_SIDE_MM) {
    setStatus('Keep >= ' + MIN_CUT_SIDE_MM + ' mm on each side of the red plane', true);
    return;
  }
  // A clean split at the one plane (cutSplitAt, app-cut.js): the halves meet
  // exactly and add back to the piece - no kerf band comes out.
  // Turned right-side-out only on the click, only for the piece it was
  // offered for, and only when every shell of it is inside-out. The turn is
  // made on a copy; m itself stays as it is, so it is what Undo restores.
  let cutModel = m;
  if (rightSideOut) {
    if (!offer || offer.id !== m.id) {
      setStatus('Not turned: the button belongs to the inside-out piece Split last refused, and this is not it. ' +
        'Split this piece to see whether it needs turning.', true);
      return;
    }
    const verdict = cutInsideOutVerdict(m);
    if (!verdict.whole) {
      setStatus('Not turned: ' + (verdict.wrong.length
        ? cutPartlyInsideOutReason(verdict)
        : 'this piece is not inside-out') + '. The piece is unchanged.', true);
      return;
    }
    cutModel = cutRightSideOutCopy(m);
  }
  let pair;
  try {
    pair = cutSplitAt(cutModel, info);
  } catch (err) {
    if (err && err.name === 'CutRefused') {
      if (err.insideOut && !rightSideOut) {
        const verdict = cutInsideOutVerdict(m);
        if (verdict.whole) {
          cutOfferRightSideOut(m, 'Cut not made: ' + err.message + '. The piece is unchanged.');
          return;
        }
        if (verdict.wrong.length) {
          setStatus('Cut not made: ' + cutPartlyInsideOutReason(verdict) + '. The piece is unchanged.', true);
          return;
        }
      }
      setStatus('Cut not made: ' + err.message + '. The piece is unchanged - move the red plane and try again.', true);
      return;
    }
    throw err;
  }
  const left = pair.left;
  const right = pair.right;
  if (!left || !right) {
    setStatus('Cut produced an empty side - nudge the plane and retry', true);
    return;
  }

  function measure(geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    const along = axis === 'x' ? sx : axis === 'y' ? sy : sz;
    return { sx, sy, sz, along };
  }
  const mL = measure(left);
  const mR = measure(right);
  if (mL.along < 0.5 || mR.along < 0.5) {
    setStatus('Cut would leave a speck - move the red plane', true);
    return;
  }
  if (mL.sx < 0.4 || mL.sy < 0.4 || mL.sz < 0.4 || mR.sx < 0.4 || mR.sy < 0.4 || mR.sz < 0.4) {
    setStatus('Cut produced a degenerate sliver - try a different plane position', true);
    return;
  }

  left.computeBoundingBox();
  right.computeBoundingBox();
  const stayA = left.boundingBox.getCenter(new THREE.Vector3());
  const stayB = right.boundingBox.getCenter(new THREE.Vector3());
  left.center();
  right.center();
  left.computeBoundingBox();
  right.computeBoundingBox();

  const tag = Math.round(cutMm);
  const baseName = String(m.name).replace(/-[AB]\d+$/i, '');
  const nameA = baseName + '-A' + tag;
  const nameB = baseName + '-B' + tag;
  const prevEditId = state.editId;
  const prevCutT = state.cutT;
  const sourceId = m.id;

  const poseById = {};
  (state.placed || []).forEach(function (pl) {
    if (pl && pl.sourceId != null) {
      poseById[pl.sourceId] = {
        x: pl.x, z: pl.z,
        rotY: pl.rotY || 0,
        flipX: !!pl.flipX,
        tipX: pl.tipX || 0,
        tipZ: pl.tipZ || 0,
        tiltX: pl.tiltX || 0,
        tiltZ: pl.tiltZ || 0,
        liftY: pl.liftY || 0
      };
    }
  });
  const sourcePose = poseById[sourceId] || { x: 0, z: 0 };

  // One piece -> two pieces. No leftover original copy.
  const sourceSnapshot = {
    id: m.id,
    name: m.name,
    geometry: m.geometry.clone(),
    quantity: m.quantity || 1,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    orientedGeometry: null,
    // Carry the parent's raw data forward so Undo restores a model that can
    // still Split with the raw engine, not just its display geometry.
    rawTris: m.rawTris || null,
    rawAxis: m.rawAxis || null,
    centerOffset: m.centerOffset || null,
    plateX: sourcePose.x,
    plateZ: sourcePose.z
  };
  const siblingSnapshots = state.models
    .filter(x => x.id !== sourceId)
    .map(function (sib) {
      const pose = poseById[sib.id] || { x: 0, z: 0 };
      return {
        id: sib.id,
        name: sib.name,
        geometry: sib.geometry,
        quantity: sib.quantity || 1,
        size: sib.size ? { x: sib.size.x, y: sib.size.y, z: sib.size.z } : { x: 1, y: 1, z: 1 },
        orientedGeometry: null,
        rawTris: sib.rawTris || null,
        rawAxis: sib.rawAxis || null,
        centerOffset: sib.centerOffset || null,
        plateX: pose.x,
        plateZ: pose.z
      };
    });
  // Remove original FIRST
  state.models = state.models.filter(x => x.id !== sourceId);
  state.editId = null;

  const halfOptsA = pair.engine === 'raw'
    ? { keepSelection: true, silent: true, rawTris: pair.rawA, rawAxis: 'zup', centerOffset: pair.centerOffsetA }
    : { keepSelection: true, silent: true };
  const halfOptsB = pair.engine === 'raw'
    ? { keepSelection: true, silent: true, rawTris: pair.rawB, rawAxis: 'zup', centerOffset: pair.centerOffsetB }
    : { keepSelection: true, silent: true };
  const idA = addModel(nameA, left, halfOptsA);
  const idB = addModel(nameB, right, halfOptsB);
  const newIds = [idA, idB].filter(x => x != null);
  if (newIds.length < 2) {
    // Roll back if halves failed to add
    state.models.push(sourceSnapshot);
    state.editId = sourceSnapshot.id;
    setStatus('Split failed to create both halves - original restored', true);
    return;
  }

  pushUndo({
    type: 'splitReplace',
    source: sourceSnapshot,
    newIds: newIds.slice(),
    siblings: siblingSnapshots,
    editId: prevEditId,
    cutT: prevCutT
  });
  console.log('[nest] split undo pushed', state.undoStack.length, newIds);

  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  const sizeA = modelA ? (axis === 'x' ? modelA.size.x : modelA.size.z) : 0;
  const sizeB = modelB ? (axis === 'x' ? modelB.size.x : modelB.size.z) : 0;
  state.selectedIndex = -1;
  state.joinPartnerId = null;
  state.joinThirdId = null;
  state.joinFaceC = null;
  state.joinSession = false;
  state.joinArmed = null;
  state.cutT = 0.5;
  renderModelList();
  updateEditSize();
  updateOptimizeButton();

  // Close cutter view and show BOTH halves on the plate with a visible gap
  // Keep cutter open so the other piece can be selected without Close.
  // Helper moves when the user clicks a piece.
  state.cutterOpen = true;
  removeCutHelper();
  state.previewMesh = null;
  layoutAfterSplit(sourcePose, poseById, sourceId, modelA, modelB, plateAxis, stayA, stayB,
                   info.base && !info.deg && !info.bevel ? info.normalWorld : null);
  state.cutterOpen = true;
  state.editId = null;
  removeCutHelper();
  state.previewMesh = null;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  updateCutterUI();
  updateUndoBtn();

  setStatus(
    (rightSideOut ? 'Turned right-side-out (' + (cutModel.geometry.attributes.position.count / 3) +
      ' triangles reversed), then cut; one Undo puts the original back. ' : '') +
    'Cut @ ' + cutMm.toFixed(1) + ' mm' + (info.deg ? ', mitre ' + info.deg + '°' : '') + ' -> ' +
    nameA + ' ' + mL.along.toFixed(1) + ' mm + ' + nameB + ' ' + mR.along.toFixed(1) +
    ' mm [' + pair.engine + ']. List: ' + state.models.length + ' models. Undo: ' + state.undoStack.length + '.'
  );
  } catch (err) {
    console.error(err);
    setStatus('Split failed: ' + (err && err.message ? err.message : String(err)), true);
  }
}

function arrayActiveModel() {
  const m = getActiveModel();
  if (!m) {
    setStatus('Load an STL first', true);
    return;
  }
  const count = Math.max(2, Math.min(16, Number(document.getElementById('array-count').value) || 4));
  const pitch = Number(document.getElementById('array-pitch').value);
  if (!(pitch > 0.5)) {
    setStatus('Pitch must be > 0.5 mm', true);
    return;
  }
  const axis = resolveAxis(m);
  const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
  const pos = src.attributes.position;
  const out = [];
  for (let n = 0; n < count; n++) {
    const dx = axis === 'x' ? n * pitch : 0;
    const dz = axis === 'z' ? n * pitch : 0;
    for (let i = 0; i < pos.count; i++) {
      out.push(pos.getX(i) + dx, pos.getY(i), pos.getZ(i) + dz);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.center();
  addModel(m.name + '-x' + count, geo);
  setStatus('Arrayed ' + count + ' at ' + pitch + ' mm on ' + axis + '. Download that new model.');
}

/* The bytes half of "Download selected STL", with the download taken off it.

   Everything from "which model" to "which triangles survive" to the Y-up ->
   Z-up turn is export policy, and the Library's Save As has to produce the
   SAME bytes the download button produces or a saved piece is not the piece
   that was tested. So the policy lives here once and both callers run it:
   exportActiveModel() below adds the filename prompt and the download,
   app-library-save.js adds the catalog entry and the commit.

   Returns { buffer, tris, dropped, name } or null. On null it has already put
   the reason on the status line, because the two callers would word it
   identically anyway. */
function activeModelSTL() {
  const m = getActiveModel();
  if (!m || !m.geometry) {
    setStatus('Select a model in the list first (click its name), then Download selected model STL', true);
    return null;
  }
  try {
    let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    if (!geo.attributes || !geo.attributes.position) {
      setStatus('Model has no mesh data to export', true);
      return null;
    }
    // Work on a clean non-indexed clone
    if (geo === m.geometry) geo = geo.clone();
    const pos = geo.attributes.position;
    const mapped = [];
    let dropped = 0;
    const triCount = Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const verts = [];
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const i = i0 + k;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          ok = false;
          break;
        }
        // Three.js Y-up -> slicer Z-up: (x, y, z) -> (x, -z, y)
        verts.push(x, -z, y);
      }
      if (!ok) { dropped++; continue; }
      mapped.push(verts[0], verts[1], verts[2], verts[3], verts[4], verts[5], verts[6], verts[7], verts[8]);
    }
    if (mapped.length < 9) {
      setStatus('Export failed - mesh empty or invalid after cut', true);
      return null;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(mapped, 3));
    return {
      buffer: geometryToBinarySTL(out),
      tris: Math.floor(mapped.length / 9),
      dropped,
      name: String(m.name || 'piece').replace(/[\/\?%*:|"<>]/g, '_')
    };
  } catch (err) {
    console.error(err);
    setStatus('Export failed: ' + (err && err.message ? err.message : 'unknown error'), true);
    return null;
  }
}

function exportActiveModel() {
  const stl = activeModelSTL();
  if (!stl) return;
  try {
    const { buffer, tris, dropped } = stl;
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    let filename = stl.name + '.stl';
    try {
      const typed = window.prompt('Export as', filename);
      if (typed == null) {
        setStatus('Export cancelled');
        return;
      }
      filename = String(typed).trim() || filename;
      if (!/\.stl$/i.test(filename)) filename += '.stl';
      filename = filename.replace(/[\/\?%*:|"<>]/g, '_');
    } catch (e) {}
    downloadBlob(blob, filename);
    setStatus(
      'Downloaded ' + filename + ' (' + tris + ' tris' +
      (dropped ? ', skipped ' + dropped + ' bad' : '') + '). Open in Bambu Studio.'
    );
  } catch (err) {
    console.error(err);
    setStatus('Export failed: ' + (err && err.message ? err.message : 'unknown error'), true);
  }
}

// ===================== UI =====================
function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  /* Only the variant changes: the line's own classes (status-hud, the
     viewport panel) stay, which a className write would wipe. */
  el.classList.add('status');
  el.classList.toggle('error', !!isError);
  el.classList.toggle('success', !isError);
}

function updatePlateInfo() {
  const p = getCurrentPlate();
  document.getElementById('plate-dims').textContent = `${p.w} x ${p.d} mm`;
  document.getElementById('plate-area').textContent = `${(p.w * p.d).toLocaleString()} mm2`;
  if (state.ready) {
    buildPlateMesh();
    clearPlaced();
    // the size is every bed's: the others' pieces come off the plate the same way (app-beds.js)
    if (typeof NSO_BEDS !== 'undefined') NSO_BEDS.plateSizeChanged();
  }
}

function setupUI() {
  document.getElementById('plate-select').addEventListener('change', (e) => {
    state.plate = e.target.value;
    document.getElementById('custom-size').classList.toggle('hidden', state.plate !== 'custom');
    updatePlateInfo();
  });

  document.getElementById('custom-w').addEventListener('change', updatePlateInfo);
  document.getElementById('custom-d').addEventListener('change', updatePlateInfo);

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  // Click method (label-based, more reliable)
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) {
      handleFiles(e.target.files);
    }
    // Allow re-selecting the same file after clear/delete
    e.target.value = '';
  });

  // Drag and drop (secondary)
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    if (!dropZone) return;
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  if (dropZone) {
    dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      dropZone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  function isFileDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
  const viewEl = document.getElementById('viewport');
  if (viewEl) {
    viewEl.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    viewEl.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
  }

  document.getElementById('btn-optimize').addEventListener('click', runOptimize);
  document.getElementById('btn-export-stl').addEventListener('click', exportPlate);
  setupCoolingProfileUI();
  setupExportFormatUI();

  // Manual adjust
  document.getElementById('btn-rot-left').addEventListener('click', () => rotateSelected(-1));
  document.getElementById('btn-rot-right').addEventListener('click', () => rotateSelected(1));
  /* btn-flip is "Tip on side" now and app-tip-orient.js owns its click -
     bound there so the orientation maths lives in one file. flipSelected()
     (a 180 degree yaw) keeps its other callers and is not wired to a button.
     btn-roll / "Flat" is retired: Tip on face reaches the same orientation
     by picking the bottom face, and rollSelected() stays for its callers. */
  /* btn-tip is "Stand" now; app-tip-orient.js owns its click. */
  /* Raise / Lower retired: the Move menu's Vertical checkbox owns the
     vertical axis now - slider and arrow keys, in app-move-vertical.js, which
     writes liftY through its own step. liftSelected() is unchanged and still
     has its callers; the suites drive the vertical step through it directly.

     To plate is the one-press recovery those two never had, and it does NOT
     go through liftSelected: see bringSelectedToPlate in app-core.js. */
  const btnToPlate = document.getElementById('btn-to-plate');
  if (btnToPlate) btnToPlate.addEventListener('click', () => bringSelectedToPlate());
  const btnTiltUp = document.getElementById('btn-tilt-up');
  if (btnTiltUp) btnTiltUp.addEventListener('click', () => tiltSelected(1));
  const btnTiltDn = document.getElementById('btn-tilt-dn');
  if (btnTiltDn) btnTiltDn.addEventListener('click', () => tiltSelected(-1));
  const btnBankUp = document.getElementById('btn-bank-up');
  if (btnBankUp) btnBankUp.addEventListener('click', () => bankSelected(1));
  const btnBankDn = document.getElementById('btn-bank-dn');
  if (btnBankDn) btnBankDn.addEventListener('click', () => bankSelected(-1));
  document.getElementById('btn-nudge-left').addEventListener('click', () => nudgeSelected(-NUDGE_MM, 0));
  document.getElementById('btn-nudge-right').addEventListener('click', () => nudgeSelected(NUDGE_MM, 0));
  document.getElementById('btn-nudge-fwd').addEventListener('click', () => nudgeSelected(0, -NUDGE_MM));
  document.getElementById('btn-nudge-back').addEventListener('click', () => nudgeSelected(0, NUDGE_MM));

  const btnFrame = document.getElementById('btn-frame-selected');
  if (btnFrame) btnFrame.addEventListener('click', frameSelectedPiece);
  /* One panel open on the whole page. Every drop-down - the row along the
     top, the column down the left, Finish, and the menus nested in Gen+ -
     opens its panel at the same spot, so two open at once would sit on top
     of one another. Opening any of them shuts every other.

     A menu that contains the one being opened, or is contained by it, is
     left alone: Gen+ holds Wheel, Stock and Picture, and opening Wheel must
     not shut the Gen+ it lives in.

     Watched with a MutationObserver on the `open` attribute rather than a
     'toggle' listener, for the reason app-input-mode.js gives: toggle is
     dispatched in a queued task, so for a moment after a click two panels
     were open; the observer runs as a microtask, before the next event, and
     sees a programmatic `.open = true` as well as a click.

     Cut has no exemption. Opening another panel shuts Cut's panel, but the
     cutter itself is a tool, not a panel: closing the <details> leaves
     state.cutterOpen, the blade and its position exactly as they were, and
     opening Cut again shows its controls. Only the cutter going away closes
     Cut's panel by itself (updateCutterUI in app-cut.js). */
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      let opened = null;
      records.forEach(function (r) {
        const d = r.target;
        if (r.oldValue === null && d.open && d.matches('.vp-menu')) opened = d;
      });
      if (!opened) return;
      document.querySelectorAll('.vp-menu[open]').forEach(function (o) {
        if (o === opened || o.contains(opened) || opened.contains(o)) return;
        o.open = false;
      });
    }).observe(document.body, { attributes: true, subtree: true,
                                attributeFilter: ['open'], attributeOldValue: true });
  }

  const btnClearPlate = document.getElementById('btn-clear-plate');
  if (btnClearPlate) btnClearPlate.addEventListener('click', clearPlateOnly);
  const btnClone = document.getElementById('btn-clone');
  if (btnClone) btnClone.addEventListener('click', cloneSelectedModel);

  const btnDelPlaced = document.getElementById('btn-delete-placed');
  if (btnDelPlaced) btnDelPlaced.addEventListener('click', deleteSelectedPlaced);
  const ctxDel = document.getElementById('ctx-delete');
  if (ctxDel) ctxDel.addEventListener('click', () => {
    deleteSelectedPlaced();
    hideCtxMenu();
  });
  const btnDelModel = document.getElementById('btn-delete-model');
  if (btnDelModel) btnDelModel.addEventListener('click', deleteActiveModel);
  const btnUndo = document.getElementById('btn-undo');
  if (btnUndo) {
    const fireUndo = (e) => {
      e.preventDefault();
      e.stopPropagation();
      undoLast();
    };
    btnUndo.addEventListener('click', fireUndo, true);
    btnUndo.addEventListener('pointerdown', (e) => { e.stopPropagation(); }, true);
  }
  const btnRedo = document.getElementById('btn-redo');
  if (btnRedo) {
    btnRedo.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      redoLast();
    }, true);
    btnRedo.addEventListener('pointerdown', (e) => { e.stopPropagation(); }, true);
  }
  updateUndoBtn();

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // Shift+Cmd/Ctrl+Z and Ctrl+Y redo; Cmd/Ctrl+Z undoes.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y') && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      redoLast();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redoLast(); else undoLast();
      return;
    }
    if (cutterArmed('cut') && getActiveModel()) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCutMm(getCutMm() - 0.5);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCutMm(getCutMm() + 0.5);
        return;
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (state.selectedIndex >= 0 && state.placed[state.selectedIndex]) {
        deleteSelectedPlaced();
      } else if (getActiveModel()) {
        deleteActiveModel();
      }
    }
  });
  // No Open / Close buttons: the Cut and Crop cards arm and disarm the
  // cutter themselves (cutWireCards, app-cut.js).
  cutWireCards();
  const btnCut = document.getElementById('btn-cut');
  if (btnCut) btnCut.addEventListener('click', cutActiveModel);
  const btnCutRightSideOut = document.getElementById('btn-cut-right-side-out');
  if (btnCutRightSideOut) btnCutRightSideOut.addEventListener('click', cutRightSideOutClicked);
  const btnArray = document.getElementById('btn-array');
  if (btnArray) btnArray.addEventListener('click', arrayActiveModel);
  const btnExportModel = document.getElementById('btn-export-model');
  if (btnExportModel) btnExportModel.addEventListener('click', exportSelected);
  const btnSoften = document.getElementById('btn-soften');
  if (btnSoften) btnSoften.addEventListener('click', softenSelectedModel);
  const btnCapFace = document.getElementById('btn-cap');
  if (btnCapFace) btnCapFace.addEventListener('click', capSelectedModel);

  const btnSeal = document.getElementById('btn-seal');
  if (btnSeal) btnSeal.addEventListener('click', sealSelectedModel);
  const btnSolidify = document.getElementById('btn-solidify');
  if (btnSolidify) btnSolidify.addEventListener('click', solidifySelectedModel);
  // Thicken out / in are wired by app-thicken-live.js now: the button arms a live
  // ghost and Set bakes it (thickenSelectedModel, unchanged).

  const btnJoin = document.getElementById('btn-join');
  if (btnJoin) {
    var joinBusy = false;
    btnJoin.addEventListener('click', function () {
      if (joinBusy) return;
      joinBusy = true;
      var prevLabel = btnJoin.textContent;
      btnJoin.disabled = true;
      btnJoin.textContent = 'Joining...';
      // JOIN: two pieces with the A-B gap off is Complete Join; a gap or a
      // third piece is the junction sequence (app-join-triple.js, press).
      const go = window.NSO_TripleJoin ? window.NSO_TripleJoin.press : joinSelectedModels;
      new Promise(function (resolve) { resolve(go()); }).catch(function (err) {
        console.warn('[join] unexpected error:', err);
        setStatus('Join failed - unexpected error', true);
      }).then(function () {
        joinBusy = false;
        btnJoin.textContent = prevLabel;
        updateJoinUI();
      });
    });
  }
  const btnSubtract = document.getElementById('btn-subtract');
  if (btnSubtract) {
    var subtractBusy = false;
    btnSubtract.addEventListener('click', function () {
      if (subtractBusy) return;
      subtractBusy = true;
      var prevLabel = btnSubtract.textContent;
      btnSubtract.disabled = true;
      btnSubtract.textContent = 'Subtracting...';
      Promise.resolve(subtractBFromA()).catch(function (err) {
        console.warn('[subtract] unexpected error:', err);
        setStatus('Subtract failed - unexpected error', true);
      }).then(function () {
        subtractBusy = false;
        btnSubtract.disabled = false;
        btnSubtract.textContent = prevLabel;
      });
    });
  }
  const btnExtract = document.getElementById('btn-extract-bit');
  if (btnExtract) btnExtract.addEventListener('click', extractBitFromSelected);
  const btnSeat = document.getElementById('btn-seat-flush');
  if (btnSeat) btnSeat.addEventListener('click', seatFlushBitToHull);
  const btnSeatSupport = document.getElementById('btn-seat-support');
  if (btnSeatSupport) btnSeatSupport.addEventListener('click', seatSupportBitToHull);
  const seatGapSlider = document.getElementById('seat-gap');
  if (seatGapSlider) {
    /* Named wrapper, not updateSeatGapReadout itself: a listener is called
       with the Event as its first argument, and the first argument is now
       the id of the input to read. */
    const syncSeatGap = function () { updateSeatGapReadout(); };
    seatGapSlider.addEventListener('input', syncSeatGap);
    seatGapSlider.addEventListener('change', syncSeatGap);
    updateSeatGapReadout();
  }
  const btnFlipPort = document.getElementById('btn-flip-port');
  if (btnFlipPort) btnFlipPort.addEventListener('click', flipPortOnPunch);
  const btnCap = document.getElementById('btn-cap-open');
  if (btnCap) btnCap.addEventListener('click', capSelectedOpenFaces);
  const btnJoinClear = document.getElementById('btn-join-clear');
  if (btnJoinClear) btnJoinClear.addEventListener('click', clearJoinSlots);
  joinWireCard();
  const btnJoinAlign = document.getElementById('btn-join-align');
  if (btnJoinAlign) btnJoinAlign.addEventListener('click', alignJoinForSlide);
  const btnJoinCx = document.getElementById('btn-join-cx');
  if (btnJoinCx) btnJoinCx.addEventListener('click', function () { centerJoinAxis('x'); });
  const btnJoinCz = document.getElementById('btn-join-cz');
  if (btnJoinCz) btnJoinCz.addEventListener('click', function () { centerJoinAxis('z'); });
  
function applyXrayToMaterial(mat) {
  if (!mat) return;
  const on = !!state.xray;
  mat.wireframe = on;
  mat.transparent = on || mat.userData.keepTransparent;
  mat.opacity = on ? 0.95 : (mat.userData.solidOpacity != null ? mat.userData.solidOpacity : 1);
  mat.depthWrite = !on;
  mat.depthTest = !on;
  if (on) {
    if (mat.userData._xraySavedEmissive == null) {
      mat.userData._xraySavedEmissive = mat.emissive ? mat.emissive.getHex() : 0;
      mat.userData._xraySavedEmissiveInt = mat.emissiveIntensity || 0;
    }
    if (mat.emissive) mat.emissive.setHex(0x7dd3fc);
    mat.emissiveIntensity = 1.1;
  } else if (mat.userData._xraySavedEmissive != null) {
    if (mat.emissive) mat.emissive.setHex(mat.userData._xraySavedEmissive);
    mat.emissiveIntensity = mat.userData._xraySavedEmissiveInt || 0;
    mat.userData._xraySavedEmissive = null;
  }
  mat.needsUpdate = true;
}

function applyXrayView() {
  const walk = function (obj) {
    if (!obj) return;
    if (obj.isMesh && obj.material) {
      if (obj === state.plateMesh || obj === state.cutHelper) return;
      if (obj.userData && obj.userData.skipXray) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(applyXrayToMaterial);
    }
    if (obj.children) obj.children.forEach(walk);
  };
  walk(state.modelGroup);
  if (state.previewMesh) walk(state.previewMesh);
  const btn = document.getElementById('btn-xray');
  if (btn) btn.classList.toggle('is-on', !!state.xray);
}

function toggleXrayView() {
  state.xray = !state.xray;
  applyXrayView();
  setStatus(state.xray ? 'X-ray on' : 'X-ray off');
}

  const btnLoadStl = document.getElementById('btn-load-stl');
  const fileInp = document.getElementById('file-input');
  if (btnLoadStl && fileInp) btnLoadStl.addEventListener('click', function () { fileInp.click(); });
const btnFrameView = document.getElementById('btn-frame-view');
  if (btnFrameView) btnFrameView.addEventListener('click', frameSelectedPiece);
  const btnXray = document.getElementById('btn-xray');
  if (btnXray) btnXray.addEventListener('click', toggleXrayView);
  // Bed grid: two controls, deliberately independent of one another.
  const selGrid = document.getElementById('plate-grid-show');
  if (selGrid) {
    selGrid.value = state.plateGridMode;
    selGrid.addEventListener('change', function () {
      setPlateGridMode(selGrid.value);
      setStatus('Bed grid ' + (state.plateGridMode === 'auto'
        ? 'auto - shown while a piece is being positioned'
        : state.plateGridMode));
    });
  }
  const chkGridSnap = document.getElementById('chk-plate-grid-snap');
  if (chkGridSnap) {
    chkGridSnap.checked = !!state.plateGridSnap;
    chkGridSnap.addEventListener('change', function () { setPlateGridSnap(chkGridSnap.checked); });
  }
  const btnJoinFaces = document.getElementById('btn-join-faces');
  if (btnJoinFaces) btnJoinFaces.style.display = 'none';
  const slotA = document.getElementById('join-slot-a');
  if (slotA) slotA.addEventListener('click', function () { armJoinSlot('a'); });
  const slotB = document.getElementById('join-slot-b');
  if (slotB) slotB.addEventListener('click', function () { armJoinSlot('b'); });
  // The yaw buttons are gone from the Cut card (the mitre wheel angles the
  // cut, the piece stays put); rotateActiveModelY stays for the yaw drag.

  // The hidden axis select: Crop's axis (resolveAxis), and the programmatic
  // cut-axis lock (cutFrame). No visible control sets either now - Cut X /
  // Cut Z are gone; the blade is square to the piece's length by itself.
  function setCutAxisLock(axis) {
    state.cutAxis = axis;
    const sel = document.getElementById('edit-axis');
    if (sel) sel.value = axis;
    if (state.cutterOpen && getActiveModel()) {
      const mesh = getCutterTargetMesh();
      if (mesh) state.previewMesh = mesh;
      buildCutHelper();
      updateCutHelper();
      syncCutUI();
    }
    setStatus('Blade axis ' + axis.toUpperCase());
  }
  const axisSel = document.getElementById('edit-axis');
  if (axisSel) axisSel.addEventListener('change', function () {
    setCutAxisLock(axisSel.value === 'z' ? 'z' : axisSel.value === 'x' ? 'x' : 'auto');
  });
  const slider = document.getElementById('cut-slider');
  if (slider) slider.addEventListener('input', () => {
    // The slider runs in mm from the low end (syncCutUI sets its range).
    setCutMm(Number(slider.value));
  });
  const cutMm = document.getElementById('cut-mm');
  if (cutMm) cutMm.addEventListener('change', () => setCutMm(Number(cutMm.value)));
  // ← / →: the blade along the piece by 0.1 mm each press, 1 mm with Shift.
  const nudgeStep = (ev) => (ev && ev.shiftKey ? CUT_NUDGE_SHIFT_MM : CUT_NUDGE_MM);
  const nudgeM = document.getElementById('btn-cut-nudge-m');
  if (nudgeM) nudgeM.addEventListener('click', (ev) => setCutMm(getCutMm() - nudgeStep(ev)));
  const nudgeP = document.getElementById('btn-cut-nudge-p');
  if (nudgeP) nudgeP.addEventListener('click', (ev) => setCutMm(getCutMm() + nudgeStep(ev)));
  cutWireMiterDial();
  updateAdjustUI();
  updateCutterUI();
}

// ===================== Boot =====================
try {
  initThree();
  setupUI();
  updatePlateInfo();
  (function () {
    function tagFrom(url, fallback) {
      if (!url) return fallback;
      const m = String(url).match(/[?&]v=([^&]+)/);
      return m ? m[1] : fallback;
    }
    const appSrc = (document.querySelector('script[src*="app-join.js"], script[src*="app.js"]') || {}).src || '';
    const cssHref = (document.querySelector('link[rel="stylesheet"][href*="styles"]') || {}).href || '';
    const appV = tagFrom(appSrc, 'no-tag');
    const cssV = tagFrom(cssHref, 'no-tag');
    const canvas = state.renderer ? (state.renderer.domElement.width + 'x' + state.renderer.domElement.height) : 'missing';
    setStatus('Ready - app ' + appV + ' / css ' + cssV + ' / ' + canvas);
    console.log('[deploy]', { app: appSrc, css: cssHref, appV: appV, cssV: cssV });
  })();
} catch (err) {
  console.error(err);
  document.body.innerHTML = '<p style="color:white;padding:40px;font-family:sans-serif">Failed to start. Check browser console.</p>';
}
