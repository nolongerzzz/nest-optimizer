function updateJoinUI() {
  const a = state.models.find(function (x) { return x.id === state.editId && state.joinSession; });
  const b = state.models.find(function (x) { return x.id === state.joinPartnerId; });
  const nameA = document.getElementById('join-name-a');
  const nameB = document.getElementById('join-name-b');
  const slotA = document.getElementById('join-slot-a');
  const slotB = document.getElementById('join-slot-b');
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
  if (step) {
    if (!state.joinSession) step.textContent = '1. Start Join';
    else if (state.joinArmed === 'a') step.textContent = '2. Click piece A on the plate or list';
    else if (!state.editId) step.textContent = '2. Click Pick A';
    else if (state.joinArmed === 'b') step.textContent = '3. Click piece B on the plate or list';
    else if (!state.joinPartnerId) step.textContent = '3. Click Pick B';
    else step.textContent = '4. Align / slide B along the wall, then Complete Join';
  }
  paintJoinHighlights();
}

function assignJoinClick(id, face) {
  if (id == null) return;
  if (!state.joinSession || !state.joinArmed) return;
  const useFace = face || null;
  if (state.joinArmed === 'a') {
    if (id === state.joinPartnerId) { state.joinPartnerId = null; state.joinFaceB = null; }
    state.editId = id;
    state.joinHullId = id;
    state.joinFaceA = useFace;
    state.cutT = 0.5;
    state.joinArmed = null;
  } else if (state.joinArmed === 'b') {
    if (id === state.editId) return;
    state.joinPartnerId = id;
    state.joinFaceB = useFace;
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
  state.joinSlideAxis = null;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  state.editId = null;
  state.selectedIndex = -1;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  renderModelList();
  updateJoinUI();
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
  state.joinUseFaces = false;
  state.joinSlideAxis = null;
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

function NSO_soupLen(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }

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

/* ============================================================
   NSO_plugFrame  (patched — shape-agnostic axis selection)
   ============================================================ */
function NSO_plugFrame(bitMesh, hullCenterWorld, aWorld) {
  bitMesh.updateWorldMatrix(true, false);
  var box = NSO_localAABB(bitMesh.geometry);
  var M = bitMesh.matrixWorld.clone();

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
  var axis = 1, sign = 1, bestN = new THREE.Vector3(0, 1, 0);
  var cand = new THREE.Vector3(), probeOut = new THREE.Vector3(), probeIn = new THREE.Vector3();
  var bestScore = -Infinity;

  for (var a = 0; a < 3; a++) {
    var half = Math.max(extent.getComponent(a) * 0.5, 0.5);
    var margin = half + Math.max(0.75, half * 0.25);
    for (var s = -1; s <= 1; s += 2) {
      cand.set(0, 0, 0).setComponent(a, s).applyMatrix3(nm).normalize();
      var score;
      if (haveSoup) {
        probeOut.copy(plugCenterWorld).addScaledVector(cand, margin);
        probeIn.copy(plugCenterWorld).addScaledVector(cand, -margin);
        var outOK = !NSO_pointInsideSoup(aWorld, probeOut.x, probeOut.y, probeOut.z);
        var inOK = NSO_pointInsideSoup(aWorld, probeIn.x, probeIn.y, probeIn.z);
        /* real seat axis: stepping out clears the hull AND stepping in stays
           inside it. Local + shape-agnostic, so it holds on a stepped/
           non-convex hull, unlike a single whole-hull centroid vector. */
        score = (outOK && inOK) ? 2 : (outOK ? 1 : -1);
        score += cand.dot(outward) * 0.01; // tie-break only
      } else {
        score = cand.dot(outward);
      }
      if (score > bestScore) { bestScore = score; axis = a; sign = s; bestN.copy(cand); }
    }
  }

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

function NSO_outerFaceCorners(frame) {
  var a = frame.axis, u = (a + 1) % 3, v = (a + 2) % 3;
  var lo = [frame.box.min.x, frame.box.min.y, frame.box.min.z];
  var hi = [frame.box.max.x, frame.box.max.y, frame.box.max.z];
  var quad = [[lo[u], lo[v]], [hi[u], lo[v]], [hi[u], hi[v]], [lo[u], hi[v]]];
  var out = [];
  for (var i = 0; i < 4; i++) {
    var p = new THREE.Vector3();
    p.setComponent(a, frame.capCoord);
    p.setComponent(u, quad[i][0]);
    p.setComponent(v, quad[i][1]);
    out.push(p.applyMatrix4(frame.matrix));
  }
  return out;
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
   ============================================================ */

function NSO_seatFlushBitToHull(hullMesh, bitMesh, opts) {
  opts = opts || {};
  var proud = (opts.proud === undefined) ? 0.4 : opts.proud;
  var maxTilt = ((opts.maxTiltDeg === undefined) ? 20 : opts.maxTiltDeg) * Math.PI / 180;
  var iters = opts.iterations || 3;

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

  for (var it = 0; it < iters; it++) {
    var frame = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var corners = NSO_outerFaceCorners(frame);
    var punch = frame.punch;

    var hits = [];
    for (var i = 0; i < 4; i++) {
      var h = NSO_nearestSkinHit(hull, corners[i], punch);
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
    var corners2 = NSO_outerFaceCorners(frame2);
    var faceC = new THREE.Vector3();
    for (var c2 = 0; c2 < 4; c2++) faceC.add(corners2[c2]);
    faceC.multiplyScalar(0.25);

    var hitC = new THREE.Vector3();
    for (var h2 = 0; h2 < 4; h2++) hitC.add(hits[h2]);
    hitC.multiplyScalar(0.25);

    var target = hitC.clone().addScaledVector(nFit, proud);
    var along = target.clone().sub(faceC).dot(nFit);
    bitMesh.position.addScaledVector(nFit, along);
    bitMesh.updateMatrixWorld(true);

    lastFit = nFit; lastCorners = corners2; lastHits = hits;
  }

  /* residual report: how far each corner ends up from the skin */
  var frameF = NSO_plugFrame(bitMesh, hullCenter);
  var cf = NSO_outerFaceCorners(frameF);
  var resid = [], maxResid = 0;
  for (var r = 0; r < 4; r++) {
    var hh = NSO_nearestSkinHit(hull, cf[r], frameF.punch);
    var dv = hh ? cf[r].clone().sub(hh).dot(frameF.outerNormal) : NaN;
    resid.push(dv);
    if (isFinite(dv) && Math.abs(dv - proud) > maxResid) maxResid = Math.abs(dv - proud);
  }

  return {
    ok: true,
    normal: lastFit ? lastFit.clone() : frameF.outerNormal.clone(),
    corners: cf,
    hits: lastHits,
    cornerResidual: resid,
    maxResidual: maxResid,
    undo: { position: savedPos, quaternion: savedQuat }
  };
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

/* ============================================================
   subtractSoupBFromA — soup-level pocket cut  (patched)
   ============================================================ */
/* =====================================================================
   NSO_CSG -- real solid boolean kernel adapter (Manifold, WASM)
   New code. Does not replace or call any existing centroid/ray logic.

   Loaded via dynamic import() from jsDelivr at call time (no bundler in
   this app). To vendor for real instead of CDN-loading:
     1. npm i manifold-3d
     2. copy node_modules/manifold-3d/manifold.js and manifold.wasm into
        your repo (e.g. /vendor/manifold/)
     3. point NSO_CSG_URL at that local manifold.js path
   The rest of this adapter is unchanged either way.
   ===================================================================== */

var NSO_CSG_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.3/manifold.js';

var NSO_CSG = (function () {
  var _wasmPromise = null;

  function load() {
    if (!_wasmPromise) {
      _wasmPromise = import(NSO_CSG_URL)
        .then(function (mod) { return (mod.default || mod)(); })
        .then(function (wasm) { wasm.setup(); return wasm; })
        .catch(function (err) {
          _wasmPromise = null; // don't cache a permanent failure -- allow retry next call
          throw err;
        });
    }
    return _wasmPromise;
  }

  // world-space triangle soup (Float32Array, 9 floats/tri, no shared index)
  // -> wasm Manifold. Calls Mesh.merge() to weld coincident corner
  // vertices, since soup has none shared -- this is what lets Manifold see
  // the input as a solid instead of N disconnected triangles.
  function soupToManifold(wasm, soup) {
    var n = (soup.length / 9) | 0;
    var vertProperties = (soup instanceof Float32Array) ? soup.slice() : new Float32Array(soup);
    var triVerts = new Uint32Array(n * 3);
    for (var i = 0; i < n * 3; i++) triVerts[i] = i;
    var mesh = new wasm.Mesh({ numProp: 3, vertProperties: vertProperties, triVerts: triVerts });
    mesh.merge();
    return new wasm.Manifold(mesh);
  }

  function manifoldToSoup(manifold) {
    var mesh = manifold.getMesh();
    var vp = mesh.vertProperties;
    var tv = mesh.triVerts;
    var numProp = mesh.numProp || 3;
    var out = new Float32Array(tv.length * 3);
    var w = 0;
    for (var t = 0; t < tv.length; t++) {
      var vi = tv[t] * numProp;
      out[w++] = vp[vi]; out[w++] = vp[vi + 1]; out[w++] = vp[vi + 2];
    }
    return out;
  }

  // Builds a solid box (as a real Manifold, via Manifold.cube) bounding the
  // region it's safe to cut into: from just outside the bit's own outer tip
  // (frame.capCoord, frame.axis/sign -- the bit's own local AABB, NOT the
  // hull's), inward along frame.punch, stopping `minWall` short of wherever
  // hull A's actual surface is found by ray-casting the real soup. This is
  // deliberately NOT based on frame.box for depth -- frame.box is the bit's
  // own bounding box (sized to the bit, ~mm), not the hull's, so it can't
  // tell us how thick the hull's wall actually is; only a real hit test
  // against aWorld can.
  // Samples 5 points across the bit's own footprint (center + 4 inset
  // corners) and takes the worst (shortest) safe depth, so a tilted or
  // uneven wall doesn't get punched through at one corner.
  // Returns a world-space Manifold, or null if the bit doesn't reach the
  // hull anywhere, or there's no room to cut within minWall.
  function buildCutVolume(wasm, frame, aWorld, minWall) {
    var axis = frame.axis, sign = frame.sign;
    var axB = (axis + 1) % 3, axC = (axis + 2) % 3;
    var box = frame.box; // bit's own local AABB -- used only for lateral (cross-section) sizing below

    var basisX = new THREE.Vector3(), basisY = new THREE.Vector3(), basisZ = new THREE.Vector3();
    frame.matrix.extractBasis(basisX, basisY, basisZ);
    var axisScale = [basisX, basisY, basisZ][axis].length() || 1; // local-unit -> world-mm for the punch axis

    var centerLocal = new THREE.Vector3();
    box.getCenter(centerLocal);
    centerLocal.setComponent(axis, frame.capCoord); // bit's own outer-tip face, centered on its cross-section

    var punch = frame.punch; // world unit vector, tip -> into the hull (already computed correctly upstream)
    var halfB = (box.max.getComponent(axB) - box.min.getComponent(axB)) / 2;
    var halfC = (box.max.getComponent(axC) - box.min.getComponent(axC)) / 2;
    var shrink = 0.85; // stay a little inboard of the bit's true edge for the probe rays
    var offsets = [
      [0, 0], [halfB * shrink, halfC * shrink], [halfB * shrink, -halfC * shrink],
      [-halfB * shrink, halfC * shrink], [-halfB * shrink, -halfC * shrink]
    ];

    var mouthPadWorld = Math.max(1, frame.span * 0.1);
    var lv = new THREE.Vector3(), wp = new THREE.Vector3();
    var minFarWorld = Infinity, anySample = false;

    for (var i = 0; i < offsets.length; i++) {
      lv.copy(centerLocal);
      lv.setComponent(axB, centerLocal.getComponent(axB) + offsets[i][0]);
      lv.setComponent(axC, centerLocal.getComponent(axC) + offsets[i][1]);
      wp.copy(lv).applyMatrix4(frame.matrix);
      var ox = wp.x - punch.x * mouthPadWorld, oy = wp.y - punch.y * mouthPadWorld, oz = wp.z - punch.z * mouthPadWorld;
      var hits = NSO_rayHitsSoup(aWorld, ox, oy, oz, punch.x, punch.y, punch.z);
      if (!hits.length) continue;
      var farWorld = hits[hits.length - 1] - mouthPadWorld; // distance from the tip (wp) to the far wall
      if (farWorld <= 0) continue;
      anySample = true;
      if (farWorld < minFarWorld) minFarWorld = farWorld;
    }

    if (!anySample) return null; // bit doesn't actually reach the hull anywhere along the punch direction

    var depthWorld = minFarWorld - minWall;
    if (depthWorld <= 0.2) return null; // no safe room to cut

    var depthLocal = depthWorld / axisScale;
    var mouthPadLocal = mouthPadWorld / axisScale;

    var lo = new THREE.Vector3(), hi = new THREE.Vector3();
    var lateralPad = Math.max(0.5, frame.span * 0.05);
    lo.setComponent(axB, box.min.getComponent(axB) - lateralPad);
    hi.setComponent(axB, box.max.getComponent(axB) + lateralPad);
    lo.setComponent(axC, box.min.getComponent(axC) - lateralPad);
    hi.setComponent(axC, box.max.getComponent(axC) + lateralPad);

    var outerLocal = frame.capCoord + sign * mouthPadLocal;   // just outside the bit's own tip
    var innerLocal = frame.capCoord - sign * depthLocal;      // depthWorld into the hull, minWall short of its far wall
    if (sign > 0) { lo.setComponent(axis, innerLocal); hi.setComponent(axis, outerLocal); }
    else { lo.setComponent(axis, outerLocal); hi.setComponent(axis, innerLocal); }

    var size = new THREE.Vector3().subVectors(hi, lo);
    var center = new THREE.Vector3().addVectors(lo, hi).multiplyScalar(0.5);
    var localTranslate = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
    var worldMat = frame.matrix.clone().multiply(localTranslate);

    var cube = wasm.Manifold.cube([Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3)], true);
    return cube.transform(Array.from(worldMat.elements));
  }

  return {
    load: load,
    soupToManifold: soupToManifold,
    manifoldToSoup: manifoldToSoup,
    buildCutVolume: buildCutVolume
  };
})();

// Möller-Trumbore ray/triangle-soup intersection. Returns sorted hit
// distances (t along the ray from origin, direction assumed unit length)
// for every triangle the ray crosses -- used to find where a punch ray
// actually enters/exits hull A's real surface, in place of any bounding
// box guess.
function NSO_rayHitsSoup(soup, ox, oy, oz, dx, dy, dz) {
  var hits = [];
  var n = (soup.length / 9) | 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
    var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
    var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    var pvx = dy * e2z - dz * e2y, pvy = dz * e2x - dx * e2z, pvz = dx * e2y - dy * e2x;
    var det = e1x * pvx + e1y * pvy + e1z * pvz;
    if (Math.abs(det) < 1e-9) continue;
    var invDet = 1 / det;
    var tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
    var u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    var qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
    var v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    var tt = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
    if (tt > 1e-6) hits.push(tt);
  }
  hits.sort(function (a, b) { return a - b; });
  return hits;
}

function NSO_errMsg(err) {
  return (err && err.message) ? String(err.message) : String(err);
}

// Open-edge / non-manifold-edge counts for a triangle soup. Vertex welding
// is by coordinate rounding (0.1 micron buckets), not topology -- this is a
// diagnostic count for the status line, not a watertight/valid claim.
function NSO_edgeStats(soup) {
  var n = (soup.length / 9) | 0;
  var q = 1e4;
  function key(o) {
    return Math.round(soup[o] * q) + '_' + Math.round(soup[o + 1] * q) + '_' + Math.round(soup[o + 2] * q);
  }
  var map = new Map();
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var k = [key(o), key(o + 3), key(o + 6)];
    for (var e = 0; e < 3; e++) {
      var a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;   // a sliver's zero-length edge is not a hole
      var ek = a < b ? (a + '|' + b) : (b + '|' + a);
      map.set(ek, (map.get(ek) || 0) + 1);
    }
  }
  var open = 0, nm = 0;
  map.forEach(function (count) {
    if (count === 1) open++;
    else if (count > 2) nm++;
  });
  return { open: open, nm: nm };
}

/* =====================================================================
   Exact topology, straight off the kernel's own indexed mesh.

   NSO_edgeStats has to weld by rounded position, because a soup carries no
   shared indices. Where two surfaces meet tangentially - two wrapped cubes
   kissing flat on flat - the union legitimately holds distinct vertices a
   fraction of a micron apart, and rounding merges them, so edges that are
   each used twice read as one edge used four times. That phantom is what
   refused a join whose result was a perfect solid: one part, genus 0,
   volume exactly A + B, 0 open and 0 non-manifold by index.

   A Manifold result already knows its own topology, so ask it instead of
   guessing from positions.
   ===================================================================== */
function NSO_manifoldStats(man) {
  var out = { open: 0, nm: 0, parts: 1, exact: false };
  try {
    var mesh = man.getMesh();
    var tv = mesh.triVerts;
    var em = new Map();
    for (var t = 0; t < tv.length; t += 3) {
      var k = [tv[t], tv[t + 1], tv[t + 2]];
      for (var e = 0; e < 3; e++) {
        var a = k[e], b = k[(e + 1) % 3];
        if (a === b) continue;
        var ek = a < b ? (a + '_' + b) : (b + '_' + a);
        em.set(ek, (em.get(ek) || 0) + 1);
      }
    }
    em.forEach(function (c) { if (c === 1) out.open++; else if (c > 2) out.nm++; });
    if (typeof man.decompose === 'function') {
      var bits = man.decompose();
      out.parts = bits.length;
      for (var i = 0; i < bits.length; i++) bits[i].delete();
    }
    out.exact = true;
  } catch (err) { out.exact = false; }
  return out;
}

/* =====================================================================
   Weld tolerance that cannot eat the piece's own detail.

   Both booleans pre-weld their input so a sloppy imported STL reads as a
   solid. A wrapped surface is far finer than those fixed tolerances: the
   ring beside each corner ball's pole carries 0.034 mm edges, so welding a
   wrap1 cube at 0.08 drops 128 triangles and at 0.22 drops 432. Cap the ask
   at a third of the shortest real edge in the soup - coincident and
   near-coincident vertices still merge, real geometry never does. An
   imported mesh has normal-length edges and keeps the tolerance it always
   had.
   ===================================================================== */
function NSO_weldEpsFor(soup, want) {
  var n = (soup && soup.length) ? (soup.length / 9) | 0 : 0;
  if (!n) return want;
  var minE = Infinity;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var e = 0; e < 3; e++) {
      var a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      var L = Math.hypot(soup[a] - soup[b], soup[a + 1] - soup[b + 1], soup[a + 2] - soup[b + 2]);
      if (L > 1e-9 && L < minE) minE = L;
    }
  }
  if (!isFinite(minE)) return want;
  return Math.min(want, minE / 3);
}

/* =====================================================================
   Union two world soups with the same kernel Subtract already uses.

   Returns { ok, soup, parts, reason }. parts > 1 means the two pieces do
   not actually touch, so there is nothing to join - the caller treats that
   as a miss and falls back, it is not a result.
   ===================================================================== */
async function NSO_unionSoups(aWorld, bWorld) {
  if (!NSO_soupLen(aWorld) || !NSO_soupLen(bWorld)) return { ok: false, reason: 'empty soup' };
  var wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) }; }
  var manA = null, manB = null, out = null;
  try {
    var aIn = aWorld, bIn = bWorld;
    if (typeof weldSoupVerts === 'function') {
      try { aIn = weldSoupVerts(aWorld, NSO_weldEpsFor(aWorld, 0.08)); } catch (e0) { aIn = aWorld; }
      try { bIn = weldSoupVerts(bWorld, NSO_weldEpsFor(bWorld, 0.08)); } catch (e1) { bIn = bWorld; }
    }
    manA = NSO_CSG.soupToManifold(wasm, aIn);
    if (manA.status && manA.status() !== 'NoError') throw new Error('A rejected: ' + manA.status());
    manB = NSO_CSG.soupToManifold(wasm, bIn);
    if (manB.status && manB.status() !== 'NoError') throw new Error('B rejected: ' + manB.status());
    out = manA.add(manB);
    if (out.status() !== 'NoError') throw new Error('union rejected by kernel: ' + out.status());
    if (out.isEmpty()) throw new Error('union produced empty solid');
    var parts = 1;
    if (typeof out.decompose === 'function') {
      var bits = out.decompose();
      parts = bits.length;
      for (var i = 0; i < bits.length; i++) bits[i].delete();
    }
    var st = NSO_manifoldStats(out);
    parts = st.exact ? st.parts : parts;
    return { ok: parts === 1, parts: parts, soup: NSO_CSG.manifoldToSoup(out),
             stats: st.exact ? { open: st.open, nm: st.nm } : null,
             reason: parts === 1 ? '' : 'the two pieces do not touch' };
  } catch (err) {
    return { ok: false, reason: NSO_errMsg(err) };
  } finally {
    if (manA) manA.delete();
    if (manB) manB.delete();
    if (out) out.delete();
  }
}

/* =====================================================================
   REPLACEMENT: subtractSoupBFromA
   Was: homemade ray/AABB pocket clipper (centroid filter + wall raycast).
   Now: real solid boolean via Manifold. Async (WASM load + compute).
   Same fail-safe contract: any failure returns { ok:false, soup: aWorld },
   caller leaves A untouched.
   ===================================================================== */
async function subtractSoupBFromA(aWorld, bWorld, opts) {
  opts = opts || {};
  var na = NSO_soupLen(aWorld), nb = NSO_soupLen(bWorld);
  if (!na || !nb) return { ok: false, soup: aWorld, reason: 'empty soup' };

  var frame = opts.plugFrame || null;
  if (!frame) return { ok: false, soup: aWorld, reason: 'no plug frame (bit not oriented against hull)' };

  var minWall = (opts.minWall === undefined) ? 1.0 : opts.minWall;
  var before = NSO_edgeStats(aWorld);

  var wasm;
  try {
    wasm = await NSO_CSG.load();
  } catch (err) {
    return { ok: false, soup: aWorld, mode: 'manifold', reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) };
  }

  var manA = null, manB = null, safetyBox = null, bClipped = null, result = null;
  try {
    var aIn = aWorld, bIn = bWorld;
    if (typeof weldSoupVerts === 'function') {
      try { aIn = weldSoupVerts(aWorld, NSO_weldEpsFor(aWorld, 0.08)); } catch (e0) { aIn = aWorld; }
      try { bIn = weldSoupVerts(bWorld, NSO_weldEpsFor(bWorld, 0.08)); } catch (e1) { bIn = bWorld; }
    }
    try { manA = NSO_CSG.soupToManifold(wasm, aIn); }
    catch (eA) { throw new Error('hull rejected: ' + ((eA && eA.message) ? eA.message : eA)); }
    if (manA.status && manA.status() !== 'NoError') throw new Error('hull rejected: ' + manA.status());

    try { manB = NSO_CSG.soupToManifold(wasm, bIn); }
    catch (eB) { throw new Error('bit rejected: ' + ((eB && eB.message) ? eB.message : eB)); }
    if (manB.status && manB.status() !== 'NoError') throw new Error('bit rejected: ' + manB.status());

    safetyBox = NSO_CSG.buildCutVolume(wasm, frame, aWorld, minWall);
    if (!safetyBox) throw new Error('bit does not reach hull A along the punch direction, or no room within minWall');

    bClipped = manB.intersect(safetyBox);
    if (bClipped.isEmpty()) throw new Error('bit does not reach hull within safe wall margin');

    result = manA.subtract(bClipped);
    if (result.status() !== 'NoError') throw new Error('subtract rejected by kernel: ' + result.status());
    if (result.isEmpty()) throw new Error('subtract produced empty solid');

    // No-op guard: a "successful" boolean that removed ~nothing (e.g. the
    // bit doesn't actually touch the hull's outer skin, so the safety-box
    // clip missed it) must NOT be reported as ok -- that would let the
    // caller delete B and leave A silently unchanged. Compare solid
    // volume, not triangle count (retriangulation can shuffle tri count
    // even on a true no-op).
    var volBefore = manA.volume();
    var volAfter = result.volume();
    var removedVol = volBefore - volAfter;
    var noopEps = Math.max(1e-3, volBefore * 1e-4); // absolute floor + 0.01% of hull volume
    if (removedVol <= noopEps) {
      throw new Error('removed ~0 volume (' + removedVol.toFixed(4) +
        ' mm^3) -- bit likely does not touch the hull skin; check placement');
    }

    var outTris = result.numTri();
    var soup = NSO_CSG.manifoldToSoup(result);
    var exact = NSO_manifoldStats(result);
    var after = exact.exact ? { open: exact.open, nm: exact.nm } : NSO_edgeStats(soup);

    console.log('[subtract] kernel=manifold tris', manA.numTri(), '->', outTris,
      'open', before.open, '->', after.open, 'nonManifold', before.nm, '->', after.nm);

    return {
      ok: true,
      soup: soup,
      mode: 'manifold',
      hullTris: outTris,
      openBefore: before.open, nmBefore: before.nm,
      openAfter: after.open, nmAfter: after.nm
    };
  } catch (err) {
    var why = NSO_errMsg(err);
    console.warn('[subtract] failed:', why);
    return { ok: false, soup: aWorld, mode: 'manifold', reason: why };
  } finally {
    if (manA) manA.delete();
    if (manB) manB.delete();
    if (safetyBox) safetyBox.delete();
    if (bClipped) bClipped.delete();
    if (result) result.delete();
  }
}

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

  let newGeo = null;
  try {
    placedA.mesh.updateMatrixWorld(true);
    placedB.mesh.updateMatrixWorld(true);
    const aWorld = meshToWorldSoup(placedA.mesh);
    const bWorld = meshToWorldSoup(placedB.mesh);
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
    if (!res || !res.ok || !res.soup || res.soup.length < 9) {
      throw new Error((res && res.reason) ? res.reason : 'result empty');
    }
    newGeo = soupToCenteredGeo(res.soup);
    window.__nestSubtractMsg = 'Subtract ok - open edges ' +
      res.openBefore + '→' + res.openAfter +
      ', non-manifold ' + res.nmBefore + '→' + res.nmAfter;
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
    setStatus('Start Join, Pick A and B, then Center', true);
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
    setStatus('Start Join, pick hull A and tunnel B, then Flip port', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  hull.updateMatrixWorld(true);
  bit.updateMatrixWorld(true);
  const hc = new THREE.Vector3();
  if (!hull.geometry.boundingBox) hull.geometry.computeBoundingBox();
  hull.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(hull.matrixWorld);
  const aWorld = (typeof meshToWorldSoup === 'function') ? meshToWorldSoup(placedA) : null;
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

function seatFlushBitToHull() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Start Join, A = hull, B = bit, then Seat flush', true);
    return;
  }
  const placedA = state.placed.find(function (p) { return p && p.sourceId === idA && p.mesh; });
  const placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both hull and bit must be on the plate', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  const res = NSO_seatFlushBitToHull(placedA.mesh, placedB.mesh, { proud: 0.01 });
  if (!res || !res.ok) {
    setStatus('Seat failed - ' + ((res && res.reason) || 'pieces unchanged'), true);
    return;
  }
  placedB.x = placedB.mesh.position.x;
  placedB.z = placedB.mesh.position.z;
  const baseY = (placedB.height || placedB.mesh.geometry.boundingBox && (placedB.mesh.geometry.boundingBox.max.y - placedB.mesh.geometry.boundingBox.min.y) || 10) / 2 + 0.2;
  placedB.liftY = Math.max(0, placedB.mesh.position.y - baseY);
  applyPlacedXZ(placedB, placedB.x, placedB.z);
  var resid = (res.maxResidual != null && isFinite(res.maxResidual)) ? res.maxResidual : 0;
  setStatus('Seated - proud 0.01mm, skin error ' + resid.toFixed(2) + 'mm - Subtract');
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
    let n = 0, sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const h = NSO_nearestSkinHit(hull, corners[i], frame.punch);
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

function extractBitFromSelected() {
  const p = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
  const model = p && p.sourceId != null
    ? state.models.find(function (m) { return m.id === p.sourceId; })
    : getActiveModel();
  if (!p || !p.mesh || !model || !model.geometry) {
    setStatus('Select a tile on the plate first', true);
    return;
  }
  const py = p.mesh.position.y;
  const soupPiece = geomToWorldSoup(model.geometry, p.x, py, p.z);
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
  setStatus('Extract bit ok - solid ' + size.x.toFixed(1) + 'x' + size.y.toFixed(1) + 'x' + size.z.toFixed(1) + ' mm');
}

async function joinSelectedModels() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Start Join, Pick A, Pick B, then Complete Join', true);
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
      joinSoupA = meshToWorldSoup(mA);
      joinSoupB = meshToWorldSoup(mB);
      if (!NSO_soupLen(joinSoupA) || !NSO_soupLen(joinSoupB)) joinSoupA = joinSoupB = null;
    } catch (e) { joinSoupA = joinSoupB = null; }
  }
  let before = { open: 0, nm: 0 };
  if (joinSoupA && joinSoupB) {
    const bA = NSO_edgeStats(joinSoupA), bB = NSO_edgeStats(joinSoupB);
    before = { open: bA.open + bB.open, nm: bA.nm + bB.nm };
  }
  const score = (st) => st.open + st.nm;

  // Route 1: the geometry path this has always used. It strips the facing cap
  // off at a plane and welds, which is right for two square-split halves and
  // is kept bit-identical for them.
  let legacyGeo = null, legacyStats = null, legacyWhy = '';
  try {
    if (placedA && placedB) {
      const yA = placedA.mesh ? placedA.mesh.position.y : 0;
      const yB = placedB.mesh ? placedB.mesh.position.y : 0;
      const seated = Math.abs(yA - yB) > 3.5;
      if (seated && typeof meshToWorldSoup === 'function') {
        const sa = meshToWorldSoup(placedA);
        const sb = meshToWorldSoup(placedB);
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
  if (joinSoupA && joinSoupB && (!legacyStats || score(legacyStats) > score(before))) {
    try {
      setStatus('Joining (loading CSG kernel)...');
      const u = await NSO_unionSoups(joinSoupA, joinSoupB);
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
  if (legacyGeo && (!kernelStats || score(legacyStats) <= score(kernelStats))) {
    newGeo = legacyGeo; after = legacyStats; route = 'plate weld';
  } else if (kernelGeo) {
    newGeo = kernelGeo; after = kernelStats; route = 'kernel union'; exact = kernelExact;
  }
  if (!newGeo) {
    const why = legacyWhy || kernelWhy || 'pieces unchanged';
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
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateAdjustUI();
  updateUndoBtn();
  removeFaceHelper();
  setStatus('Join ok (' + route + ') - open edges ' + before.open + '\u2192' + after.open +
            ', non-manifold ' + before.nm + '\u2192' + after.nm);
}


function splitBothSides(model, axis, leftPlane, rightPlane) {
  const alreadySplit = /-[AB]\d+$/i.test(model.name || '');
  // 2nd+ cuts: clip the DISPLAY mesh at the slider plane. Raw mapping on a
  // half still in original-file coordinates misses the plane and looks like
  // "Split does nothing."
  if (!alreadySplit && model.rawTris && model.rawAxis === 'zup' && model.centerOffset) {
    try {
      const mapL = mapPlaneToRaw(model, axis, leftPlane, true);
      const mapR = mapPlaneToRaw(model, axis, rightPlane, false);
      if (!mapL || !mapR) throw new Error('no raw mapping');
      const rawL = rawCut(model.rawTris, mapL.axisIdx, mapL.plane, mapL.keepMin);
      const rawR = rawCut(model.rawTris, mapR.axisIdx, mapR.plane, mapR.keepMin);
      if (!rawL || !rawR) throw new Error('rawCut empty side');
      return {
        left: rawResultToDisplayGeometry(rawL, model.centerOffset),
        right: rawResultToDisplayGeometry(rawR, model.centerOffset),
        engine: 'raw',
        rawA: rawL,
        centerOffsetA: computeCenterOffsetFromRaw(rawL),
        rawB: rawR,
        centerOffsetB: computeCenterOffsetFromRaw(rawR)
      };
    } catch (err) {
      console.warn('[rawCut] fallback to display clip:', err.message);
    }
  }
  return {
    left: clipGeometrySide(model.geometry, axis, leftPlane, true),
    right: clipGeometrySide(model.geometry, axis, rightPlane, false),
    engine: 'display'
  };
}

function cutActiveModel() {
  try {
  if (!state.cutterOpen) {
    setStatus('Open cutter first', true);
    return;
  }
  const m = getActiveModel();
  if (!m) {
    setStatus('Load an STL first', true);
    return;
  }
  const info = getCutPlaneForSplit(m);
  if (!info) {
    setStatus('Cannot resolve cut plane - reopen cutter', true);
    return;
  }
  const axis = info.axis;
  const plateAxis = info.plateAxis || axis;
  const span = info.span;
  const plane = info.plane;
  // Distance from min end - must match readout
  const cutMm = (plane - info.origin);
  if (span < MIN_CUT_SIDE_MM * 2) {
    setStatus('Piece too short to cut (need >= ' + (MIN_CUT_SIDE_MM * 2) + ' mm along cut axis)', true);
    return;
  }
  if (cutMm < MIN_CUT_SIDE_MM || cutMm > span - MIN_CUT_SIDE_MM) {
    setStatus('Keep >= ' + MIN_CUT_SIDE_MM + ' mm on each side of the red plane', true);
    return;
  }
  // Kerf band centered on red line - middle slab discarded so halves have a real gap
  const halfKerf = KERF_MM * 0.5;
  const leftPlane = plane - halfKerf;
  const rightPlane = plane + halfKerf;
  const pair = splitBothSides(m, axis, leftPlane, rightPlane);
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
  layoutAfterSplit(sourcePose, poseById, sourceId, modelA, modelB, plateAxis, stayA, stayB);
  state.cutterOpen = true;
  state.editId = null;
  removeCutHelper();
  state.previewMesh = null;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  updateCutterUI();
  updateUndoBtn();

  const sum = mL.along + mR.along;
  const loss = span - sum;
  setStatus(
    'Cut @ ' + cutMm.toFixed(1) + ' mm (kerf ' + KERF_MM + ' mm) -> ' +
    nameA + ' ' + mL.along.toFixed(1) + ' mm + ' + nameB + ' ' + mR.along.toFixed(1) +
    ' mm [' + pair.engine + ']. List: ' + state.models.length + ' models. Undo: ' + state.undoStack.length + '.' +
    (Math.abs(loss) > KERF_MM + 1.5 ? ' ! loss ' + loss.toFixed(1) + ' mm' : '')
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

function exportActiveModel() {
  const m = getActiveModel();
  if (!m || !m.geometry) {
    setStatus('Select a model in the list first (click its name), then Download selected model STL', true);
    return;
  }
  try {
    let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    if (!geo.attributes || !geo.attributes.position) {
      setStatus('Model has no mesh data to export', true);
      return;
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
      return;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(mapped, 3));
    const buffer = geometryToBinarySTL(out);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const safe = String(m.name || 'piece').replace(/[\/\?%*:|"<>]/g, '_');
    let filename = safe + '.stl';
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
      'Downloaded ' + filename + ' (' + Math.floor(mapped.length / 9) + ' tris' +
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
  el.className = 'status' + (isError ? ' error' : ' success');
}

function updatePlateInfo() {
  const p = getCurrentPlate();
  document.getElementById('plate-dims').textContent = `${p.w} x ${p.d} mm`;
  document.getElementById('plate-area').textContent = `${(p.w * p.d).toLocaleString()} mm2`;
  if (state.ready) {
    buildPlateMesh();
    clearPlaced();
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
  document.getElementById('btn-clear').addEventListener('click', () => {
    state.models = [];
    state.editId = null;
    state.cutT = 0.5;
    state.cutterOpen = false;
    state.editYawDragging = false;
    state.cutDragging = false;
    clearUndo();
    clearDisplayMeshes();
    renderModelList();
    clearPlaced();
    removeCutHelper();
    state.previewMesh = null;
    state.selectedIndex = -1;
    updateAdjustUI();
    updateOptimizeButton();
    updateEditSize();
    updateCutterUI();
    const fi = document.getElementById('file-input');
    if (fi) fi.value = '';
    setStatus('Cleared - click drop zone to load an STL again');
  });
  document.getElementById('btn-export-stl').addEventListener('click', exportSTLs);

  // Manual adjust
  document.getElementById('btn-rot-left').addEventListener('click', () => rotateSelected(-1));
  document.getElementById('btn-rot-right').addEventListener('click', () => rotateSelected(1));
  document.getElementById('btn-flip').addEventListener('click', () => flipSelected());
  document.getElementById('btn-tip').addEventListener('click', () => tipSelected());
  const btnRoll = document.getElementById('btn-roll');
  if (btnRoll) btnRoll.addEventListener('click', () => rollSelected());
  const btnRaise = document.getElementById('btn-raise');
  if (btnRaise) btnRaise.addEventListener('click', () => liftSelected(1));
  const btnLower = document.getElementById('btn-lower');
  if (btnLower) btnLower.addEventListener('click', () => liftSelected(-1));
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
  document.querySelectorAll('.vp-menu').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      document.querySelectorAll('.vp-menu').forEach(function (o) {
        if (o !== d) o.open = false;
      });
    });
  });

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
  updateUndoBtn();

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undoLast();
      return;
    }
    if (state.cutterOpen && getActiveModel()) {
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
  const btnCutterOpen = document.getElementById('btn-cutter-open');
  if (btnCutterOpen) btnCutterOpen.addEventListener('click', openCutter);
  const btnCutterClose = document.getElementById('btn-cutter-close');
  if (btnCutterClose) btnCutterClose.addEventListener('click', () => closeCutter(false));
  const btnCut = document.getElementById('btn-cut');
  if (btnCut) btnCut.addEventListener('click', cutActiveModel);
  const btnArray = document.getElementById('btn-array');
  if (btnArray) btnArray.addEventListener('click', arrayActiveModel);
  const btnExportModel = document.getElementById('btn-export-model');
  if (btnExportModel) btnExportModel.addEventListener('click', exportActiveModel);
  const btnSoften = document.getElementById('btn-soften');
  if (btnSoften) btnSoften.addEventListener('click', softenSelectedModel);
  const btnCapFace = document.getElementById('btn-cap');
  if (btnCapFace) btnCapFace.addEventListener('click', capSelectedModel);

  const btnSeal = document.getElementById('btn-seal');
  if (btnSeal) btnSeal.addEventListener('click', sealSelectedModel);
  const btnSolidify = document.getElementById('btn-solidify');
  if (btnSolidify) btnSolidify.addEventListener('click', solidifySelectedModel);
  const btnThickenOut = document.getElementById('btn-thicken-out');
  if (btnThickenOut) btnThickenOut.addEventListener('click', thickenOutSelectedModel);
  const btnThickenIn = document.getElementById('btn-thicken-in');
  if (btnThickenIn) btnThickenIn.addEventListener('click', thickenInSelectedModel);

  const btnJoin = document.getElementById('btn-join');
  if (btnJoin) {
    var joinBusy = false;
    btnJoin.addEventListener('click', function () {
      if (joinBusy) return;
      joinBusy = true;
      var prevLabel = btnJoin.textContent;
      btnJoin.disabled = true;
      btnJoin.textContent = 'Joining...';
      Promise.resolve(joinSelectedModels()).catch(function (err) {
        console.warn('[join] unexpected error:', err);
        setStatus('Join failed - unexpected error', true);
      }).then(function () {
        joinBusy = false;
        btnJoin.disabled = false;
        btnJoin.textContent = prevLabel;
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
  const btnFlipPort = document.getElementById('btn-flip-port');
  if (btnFlipPort) btnFlipPort.addEventListener('click', flipPortOnPunch);
  const btnCap = document.getElementById('btn-cap-open');
  if (btnCap) btnCap.addEventListener('click', capSelectedOpenFaces);
  const btnJoinClear = document.getElementById('btn-join-clear');
  if (btnJoinClear) btnJoinClear.addEventListener('click', clearJoinSlots);
  const btnJoinStart = document.getElementById('btn-join-start');
  if (btnJoinStart) btnJoinStart.addEventListener('click', startJoinSession);
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
  const btnJoinFaces = document.getElementById('btn-join-faces');
  if (btnJoinFaces) btnJoinFaces.style.display = 'none';
  const slotA = document.getElementById('join-slot-a');
  if (slotA) slotA.addEventListener('click', function () { armJoinSlot('a'); });
  const slotB = document.getElementById('join-slot-b');
  if (slotB) slotB.addEventListener('click', function () { armJoinSlot('b'); });
  const btnYawL = document.getElementById('btn-yaw-left');
  const btnYawR = document.getElementById('btn-yaw-right');
  const btnYawL90 = document.getElementById('btn-yaw-left-90');
  const btnYawR90 = document.getElementById('btn-yaw-right-90');
  if (btnYawL) btnYawL.addEventListener('click', () => rotateActiveModelY(-15));
  if (btnYawR) btnYawR.addEventListener('click', () => rotateActiveModelY(15));
  if (btnYawL90) btnYawL90.addEventListener('click', () => rotateActiveModelY(-90));
  if (btnYawR90) btnYawR90.addEventListener('click', () => rotateActiveModelY(90));

  function setCutAxisLock(axis) {
    state.cutAxis = axis;
    const sel = document.getElementById('edit-axis');
    if (sel) sel.value = axis;
    const bx = document.getElementById('btn-cut-axis-x');
    const bz = document.getElementById('btn-cut-axis-z');
    if (bx) bx.classList.toggle('tool-active', axis === 'x');
    if (bz) bz.classList.toggle('tool-active', axis === 'z');
    if (state.cutterOpen && getActiveModel()) {
      const mesh = getCutterTargetMesh();
      if (mesh) state.previewMesh = mesh;
      buildCutHelper();
      updateCutHelper();
      syncCutUI();
    }
    setStatus('Blade axis ' + axis.toUpperCase());
  }
  const btnAx = document.getElementById('btn-cut-axis-x');
  const btnAz = document.getElementById('btn-cut-axis-z');
  if (btnAx) btnAx.addEventListener('click', function () { setCutAxisLock('x'); });
  if (btnAz) btnAz.addEventListener('click', function () { setCutAxisLock('z'); });
  const axisSel = document.getElementById('edit-axis');
  if (axisSel) axisSel.addEventListener('change', function () {
    setCutAxisLock(axisSel.value === 'z' ? 'z' : axisSel.value === 'x' ? 'x' : 'auto');
  });
  const slider = document.getElementById('cut-slider');
  if (slider) slider.addEventListener('input', () => {
    const m = getActiveModel();
    const span = m ? getCutSpan(m) : 100;
    const raw = Math.min(0.98, Math.max(0.02, Number(slider.value) / 100));
    state.cutT = snapCutT(raw, span);
    syncCutUI();
    updateCutHelper();
  });
  const cutMm = document.getElementById('cut-mm');
  if (cutMm) cutMm.addEventListener('change', () => setCutMm(Number(cutMm.value)));
  const nudgeM = document.getElementById('btn-cut-nudge-m');
  if (nudgeM) nudgeM.addEventListener('click', () => setCutMm(getCutMm() - 1));
  const nudgeP = document.getElementById('btn-cut-nudge-p');
  if (nudgeP) nudgeP.addEventListener('click', () => setCutMm(getCutMm() + 1));
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
