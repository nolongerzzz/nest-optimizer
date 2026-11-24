/* ============================================================
   Thicken out / Thicken in, live - the app layer over app-finish.js's
   _thickenOffsetSoup / thickenSelectedModel.

   The engine is not touched and is not asked anything new. What was a button
   that baked the number in a box is a slider that shows the result first:

     Thicken out / Thicken in   arm it. The piece turns to a ghost and the
                                faces that would move are drawn where they
                                would land - the wall growing out, or into the
                                cavity.
     slider                     the mm. Every move re-runs _thickenOffsetSoup
                                with that number: the same call, the same
                                arguments, Set makes. The 1.5 that used to be a
                                number box is its readout (the ARROWS on the
                                Thicken row still step it).
     click a face               just that wall thickens - the surface the click
                                landed on, grown across creases shallower than
                                THICKEN_SMOOTH_DEG (the engine's own idea of
                                "one surface"): a box's face, a cylinder's whole
                                side. On a sheet whose edges are rounded (no
                                crease anywhere between its two faces) just the
                                face clicked - its rims are held (growWall).
                                Click it again, or Whole piece, for the
                                whole piece. None picked is the whole piece.
     Set                        thickenSelectedModel(mode, mm, { mayMove }) -
                                the SAME function the buttons used to call, with
                                the wall as the engine's own mayMove filter
                                (added for Fatten; "a 0 forbids that face from
                                moving"). Deterministic, so the soup it bakes is
                                the ghost's soup bit for bit; every gate it ever
                                had (paint, inversion, piercing) is still its.
                                One Undo, 'thickenReplace', as before.
     Cancel / Escape            drops the ghost; the piece was never touched.

   Per-face needed no engine call that did not exist: mayMove is the filter.

   FILLING A NOTCH (docs/handoff/thicken-fill-a-notch.md): a wall in a notch,
   slot or pocket is an INSIDE face to the engine, so only Thicken in moves it.
   A click on a wall therefore takes the side the wall is on: arm Thicken out,
   click a notch wall, and the verb flips to Thicken in (and says so) rather
   than refusing - both verbs only ever ADD material to the wall, so the click
   already says which one. With a wall picked the slider runs to the piece's own
   size, not 8 mm (a notch is often wider than that); the engine is still the
   limit and refuses past the opposite wall in words ("more than the feature it
   grows into"). The ghost draws the material the wall would add as a solid
   slab (the wall's old position swept to its new one), not only the faces that
   land. A verb button pressed by hand with a wall already picked keeps the
   engine's own refusal.

   NOT SLOWED: only _thickenOffsetSoup runs on a slider move. The piercing
   check (NSO_Repair, the slow part) runs when the slider is let go, so a
   ghost that Set would refuse says so before Set is pressed, and Set stays
   greyed.

   PAINT SCOPE: WHOLE-PIECE, as for Thicken (docs/HANDOFF.md, "Scoping"). A
   painted face stands the control down at arm time with Thicken's own words.
   ============================================================ */
(function () {
  'use strict';

  var GHOST_OPACITY = 0.2;
  var MOVE_EPS = 1e-6;            // mm: a vertex that moved less than this has not moved
  var CLICK_PX = 5, CLICK_MS = 600;
  var SLIDER_MAX_WHOLE = 8;       // mm: the whole piece (the slider's own max in index.html)
  var SLIDER_MAX_WALL_CAP = 200;  // mm: a picked wall may run to the piece's size, never past this
  var SHEET_PAIRED_FRAC = 0.6;    // a smooth surface this much paired across a wall (by area) is a sheet's two sides

  var on = false, mode = 'out';
  var m = null, soupRef = null, geoRef = null, usingRaw = false, mesh = null;
  var group = null, movedObj = null, edgeObj = null, wallObj = null, slabObj = null, slabEdgeObj = null;
  var sizeMm = 0;                 // the piece's longest extent: what a picked wall's slider runs to
  var ghostSaved = null;
  var topo = null;                // { soupRef, nf, tri, fn, outer, vertFaces } for the wall pick
  var wall = null;                // { mayMove: Uint8Array, count, seed }
  var last = null;                // { mode, mm, wall, res, soup, gateWhy }
  var dirty = false, raf = 0;
  var press = null;
  var pierceBase = null;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function engineReady() {
    return typeof _thickenOffsetSoup === 'function' && typeof thickenSelectedModel === 'function' &&
           typeof _thickenIndex === 'function' && typeof _thickenFaceNormals === 'function' &&
           typeof _thickenClassifyOuter === 'function';
  }

  function slider() { return $('inp-thicken-mm'); }
  function mmNow() {
    var v = parseFloat((slider() || {}).value);
    return isFinite(v) && v > 0 ? v : 1.5;
  }
  function fmt(v) { return (Math.round(v * 100) / 100).toString(); }
  function extentOf(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) for (var k = 0; k < 3; k++) {
      if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
      if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
    }
    return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  }

  /* ---------------------------------------------------------------
     The piece
     --------------------------------------------------------------- */

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : null;
  }

  /* The soup Thicken works on - thickenSelectedModel's own choice, so the
     ghost and the bake read the same triangles. */
  function soupOfModel(model) {
    if (model.rawTris && model.rawAxis === 'zup') return { soup: model.rawTris, raw: true };
    var geo = model.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    var pos = geo.attributes.position, index = geo.index, out = [];
    if (index) for (var i = 0; i < index.count; i++) { var vi = index.getX(i); out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi)); }
    else for (var j = 0; j < pos.count; j++) out.push(pos.getX(j), pos.getY(j), pos.getZ(j));
    return out.length >= 9 ? { soup: new Float32Array(out), raw: false } : null;
  }

  /* Soup triangles -> the piece mesh's own frame (app-foam.js's localGeo). */
  function localGeo(soup) {
    var f = (usingRaw && typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(m) : null;
    var n = soup.length / 3, pos = new Float32Array(soup.length);
    for (var i = 0; i < n; i++) {
      var p = [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]];
      var q = f ? nsoLocalPointFromRaw(f, p) : p;
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }

  function disposeObj(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }

  function ghost(onOff) {
    var mats = mesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    if (onOff) {
      ghostSaved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite,
                 depthTest: mt.depthTest, wireframe: mt.wireframe };
      }) };
      mesh.userData.skipXray = true;
      mats.forEach(function (mt) {
        mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true;
        mt.wireframe = false; mt.needsUpdate = true;
      });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) {
        s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite;
        s.mt.depthTest = s.depthTest; s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
      });
      if (mesh) mesh.userData.skipXray = ghostSaved.skip;
      ghostSaved = null;
    }
  }

  /* ---------------------------------------------------------------
     The wall: what "a face" is for this control
     --------------------------------------------------------------- */

  function topology() {
    if (topo && topo.soupRef === soupRef) return topo;
    var ix = _thickenIndex(soupRef);
    var fn = _thickenFaceNormals(ix.pos, ix.tri);
    var sign = fn.signedVolume < 0 ? -1 : 1;
    var outer = _thickenClassifyOuter(ix.pos, ix.tri, fn, sign);
    var nf = ix.tri.length / 3, nv = ix.pos.length / 3, vertFaces = new Array(nv);
    for (var f = 0; f < nf; f++) {
      if (!fn.ok[f]) continue;
      for (var k = 0; k < 3; k++) { var v = ix.tri[f * 3 + k]; (vertFaces[v] || (vertFaces[v] = [])).push(f); }
    }
    /* edge neighbours (a face's up-to-three faces across its edges), for the
       curvature walk: a corner can be shared by hundreds of cap triangles */
    var edgeOf = new Map(), adj = new Int32Array(nf * 3).fill(-1);
    for (var e = 0; e < nf; e++) {
      if (!fn.ok[e]) continue;
      for (var j = 0; j < 3; j++) {
        var a = ix.tri[e * 3 + j], b = ix.tri[e * 3 + (j + 1) % 3], key = a < b ? a * nv + b : b * nv + a;
        var other = edgeOf.get(key);
        if (other === undefined) edgeOf.set(key, e * 3 + j);
        else if (other >= 0) { adj[e * 3 + j] = (other / 3) | 0; adj[other] = e; edgeOf.set(key, -1); }
      }
    }
    topo = { soupRef: soupRef, nf: nf, pos: ix.pos, tri: ix.tri, fn: fn, outer: outer, vertFaces: vertFaces,
             adj: adj, partner: new Int32Array(nf).fill(-2) };
    return topo;
  }

  /* The clicked triangle grown across creases shallower than the engine's own
     THICKEN_SMOOTH_DEG, through shared corners as _thickenClassifyOuter walks
     them. A box face is its coplanar patch (the next face is 90 degrees away);
     a cylinder's side is the whole side.

     THE BACK OF A SHEET (a wall with rounded edges, a plate filleted all
     round): the crease rule alone finds no edge between its two faces - the
     surface turns 180 degrees round the rim a degree or two at a time - so a
     click on the front took the back as well, and "one wall" was the whole
     piece. So the smooth surface is split into the two sides of the wall:
     every face is paired with the face straight across the material from it
     (partnerOf), and the click's side is grown nearest-first over the surface
     while each face it takes hands its partner to the other side. The rim
     between them belongs to neither and is held (see the patches below). A
     surface that is not mostly pairs - a cylinder, a sphere, a box face, a
     chunky smooth part - is all one wall, as before. */
  function growWall(seed) {
    var T = topology(), n = T.fn.n;
    var cosSmooth = Math.cos((typeof THICKEN_SMOOTH_DEG === 'number' ? THICKEN_SMOOTH_DEG : 45) * Math.PI / 180);
    function smooth(f, g) { return n[f * 3] * n[g * 3] + n[f * 3 + 1] * n[g * 3 + 1] + n[f * 3 + 2] * n[g * 3 + 2] > cosSmooth; }
    function eachNeighbour(f, fnc) {
      for (var k = 0; k < 3; k++) {
        var list = T.vertFaces[T.tri[f * 3 + k]];
        for (var i = 0; i < list.length; i++) if (list[i] !== f && smooth(f, list[i])) fnc(list[i]);
      }
    }
    /* the smooth surface the click is on */
    var R = new Uint8Array(T.nf), stack = [seed], members = [];
    R[seed] = 1;
    while (stack.length) {
      var f = stack.pop(); members.push(f);
      eachNeighbour(f, function (g) { if (!R[g]) { R[g] = 1; stack.push(g); } });
    }
    /* partners both ways: f's ray may land on h while h's lands beside f */
    var across = new Array(T.nf);
    for (var w = 0; w < members.length; w++) {
      var mf0 = members[w], pf = partnerOf(T, mf0);
      if (pf < 0 || !R[pf]) continue;
      (across[mf0] || (across[mf0] = [])).push(pf);
      (across[pf] || (across[pf] = [])).push(mf0);
    }
    function pairOf(f) { return across[f] ? across[f][0] : -1; }

    /* a click on the rim itself is on neither side: start from the nearest
       face that has one */
    var start = seed;
    if (pairOf(seed) < 0) {
      var near = nearest(T, seed, R, eachNeighbour, function (g) { return pairOf(g) >= 0; });
      if (near >= 0) start = near;
    }
    /* Only a surface that IS two sides of a wall is split: most of it (by
       area) has a face across from it. A chunky smooth part has a few chance
       pairs (a ray that happens to cross a narrow neck) - splitting it on
       those would break one surface into scraps. A sheet is over 90 percent
       pairs; such a part is under a third. */
    var areaAll = 0, areaPaired = 0;
    for (var z = 0; z < members.length; z++) {
      areaAll += T.fn.area[members[z]];
      if (pairOf(members[z]) >= 0) areaPaired += T.fn.area[members[z]];
    }
    if (pairOf(start) < 0 || areaPaired < SHEET_PAIRED_FRAC * areaAll) {
      return { mayMove: R, count: members.length, seed: seed, split: false };   // one wall, as before
    }

    var SIDE = 1, BACK = 2, label = new Uint8Array(T.nf), done = new Uint8Array(T.nf);
    var dist = new Float64Array(T.nf).fill(Infinity), heap = new Heap();
    function offer(g, d, l) { if (!done[g] && d < dist[g]) { dist[g] = d; label[g] = l; heap.push(g, d); } }
    offer(start, 0, SIDE);
    while (heap.size()) {
      var e = heap.pop(), h = e.f;
      if (done[h] || e.d > dist[h]) continue;
      done[h] = 1;
      var ps = across[h];
      if (ps) for (var pi = 0; pi < ps.length; pi++) offer(ps[pi], dist[h], label[h] === SIDE ? BACK : SIDE);
      eachNeighbour(h, function (g) { offer(g, dist[h] + centroidGap(T, h, g), label[h]); });
    }
    /* The faces with no partner come in patches: a corner of one side
       tighter than the wall is thick (a fillet in a step) is bounded by that
       side alone and moves with it; a rim joins the two sides and is HELD -
       the side stops where it runs tangent into the rim, a crease the engine
       resolves (the rim's edge moves half the offset), where a cut down the
       rim's middle leaves two faces a few degrees apart with different
       targets, and the solve throws the corners between them across the
       piece. Which side a patch goes to never depends on where the click was. */
    var patch = new Int32Array(T.nf).fill(-1), touches = [];
    for (var q = 0; q < members.length; q++) {
      var r0 = members[q];
      if (patch[r0] >= 0 || pairOf(r0) >= 0) continue;
      var id = touches.length, ps2 = [r0], tch = 0;
      patch[r0] = id;
      while (ps2.length) {
        var u = ps2.pop();
        eachNeighbour(u, function (g) {
          if (pairOf(g) >= 0) { tch |= label[g]; return; }
          if (patch[g] < 0) { patch[g] = id; ps2.push(g); }
        });
      }
      touches.push(tch);
    }
    var may = new Uint8Array(T.nf), count = 0;
    for (var m = 0; m < members.length; m++) {
      var mm = members[m], side = patch[mm] < 0 ? label[mm] : touches[patch[mm]];
      if (side === SIDE) { may[mm] = 1; count++; }
    }
    return { mayMove: may, count: count, seed: seed, split: true };
  }

  /* Nearest face of R (over the surface) that passes test, or -1. */
  function nearest(T, from, R, eachNeighbour, test) {
    var dist = new Float64Array(T.nf).fill(Infinity), done = new Uint8Array(T.nf), heap = new Heap();
    dist[from] = 0; heap.push(from, 0);
    while (heap.size()) {
      var e = heap.pop(), f = e.f;
      if (done[f] || e.d > dist[f]) continue;
      done[f] = 1;
      if (test(f)) return f;
      eachNeighbour(f, function (g) {
        if (!R[g]) return;
        var d = dist[f] + centroidGap(T, f, g);
        if (d < dist[g]) { dist[g] = d; heap.push(g, d); }
      });
    }
    return -1;
  }

  /* The face straight across the material from f, when f is one side of a
     wall: the ray from f into the piece lands on a face that looks the other
     way, d deep, and the surface turns less than 0.8 rad within 3d/4 of f. A
     cylinder's or a sphere's far side is 2R deep and its surface turns more
     than a radian within 1.5R, so a round side has no partner and stays one
     wall; a sheet's back is a thickness deep on a surface that bends far more
     gently, so it does. Under the depth, so only the faces within half a
     millimetre or so of a 2 mm sheet's rim see the rim's bend. A ray
     that cuts a corner and lands on the same side's skin round a bend finds
     a face looking across, not back, and is no partner either. -1 for none. */
  function partnerOf(T, f) {
    if (T.partner[f] !== -2) return T.partner[f];
    var res = -1, hit = T.fn.ok[f] ? rayInto(T, f) : null;
    if (hit) {
      var n = T.fn.n, f3 = f * 3, h3 = hit.face * 3;
      if (n[f3] * n[h3] + n[f3 + 1] * n[h3 + 1] + n[f3 + 2] * n[h3 + 2] < -0.7 &&
          !bendsWithin(T, f, hit.t * 0.75, 0.8)) res = hit.face;
    }
    T.partner[f] = res;
    return res;
  }

  function centroids(T) {
    if (T.cen) return T.cen;
    var p = T.pos, c = new Float64Array(T.nf * 3);
    for (var f = 0; f < T.nf; f++) {
      var a = T.tri[f * 3] * 3, b = T.tri[f * 3 + 1] * 3, d = T.tri[f * 3 + 2] * 3;
      c[f * 3] = (p[a] + p[b] + p[d]) / 3; c[f * 3 + 1] = (p[a + 1] + p[b + 1] + p[d + 1]) / 3; c[f * 3 + 2] = (p[a + 2] + p[b + 2] + p[d + 2]) / 3;
    }
    return (T.cen = c);
  }
  function centroid(T, f) { var c = centroids(T); return [c[f * 3], c[f * 3 + 1], c[f * 3 + 2]]; }
  function centroidGap(T, f, g) {
    var c = centroids(T), dx = c[f * 3] - c[g * 3], dy = c[f * 3 + 1] - c[g * 3 + 1], dz = c[f * 3 + 2] - c[g * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  /* Does the surface turn more than maxTurn radians within `span` of f?
     Walked over the same smooth surface, nearest first, with each step
     measured ACROSS the shared edge (centroid to edge line, edge line to
     centroid): the distance along the edge does not count, so a strip the
     full height of a wall is one narrow step, not a third of its height. A
     one-ring estimate would be noise on a fine mesh (a profile swept in
     strips 0.04 mm wide puts a degree of twist between a quad's two
     triangles). Stops as soon as the turn is passed, so a sphere is decided
     at its first ring. */
  function bendsWithin(T, f, span, maxTurn) {
    var cosSmooth = Math.cos((typeof THICKEN_SMOOTH_DEG === 'number' ? THICKEN_SMOOTH_DEG : 45) * Math.PI / 180);
    var n = T.fn.n, cen = centroids(T), p = T.pos, cosMax = Math.cos(maxTurn);
    var dist = new Map([[f, 0]]), heap = new Heap(), visits = 0;
    function toLine(c, a, b) {                   // distance from centroid c to the line through vertices a, b
      var ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
      var wx = cen[c] - p[a], wy = cen[c + 1] - p[a + 1], wz = cen[c + 2] - p[a + 2];
      var cx = ey * wz - ez * wy, cy = ez * wx - ex * wz, cz = ex * wy - ey * wx;
      var el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      return el > 0 ? Math.sqrt(cx * cx + cy * cy + cz * cz) / el : 0;
    }
    heap.push(f, 0);
    while (heap.size() && visits < 4000) {
      var e = heap.pop(), h = e.f;
      if (e.d > dist.get(h)) continue;
      visits++;
      for (var k = 0; k < 3; k++) {
        var g = T.adj[h * 3 + k];
        if (g < 0) continue;
        if (n[h * 3] * n[g * 3] + n[h * 3 + 1] * n[g * 3 + 1] + n[h * 3 + 2] * n[g * 3 + 2] <= cosSmooth) continue;
        var a = T.tri[h * 3 + k] * 3, b = T.tri[h * 3 + (k + 1) % 3] * 3;
        var d = e.d + toLine(h * 3, a, b) + toLine(g * 3, a, b);
        if (d > span) continue;
        var was = dist.get(g);
        if (was !== undefined && was <= d) continue;
        if (n[f * 3] * n[g * 3] + n[f * 3 + 1] * n[g * 3 + 1] + n[f * 3 + 2] * n[g * 3 + 2] < cosMax) return true;
        dist.set(g, d); heap.push(g, d);
      }
    }
    return false;
  }

  /* First face the ray from f's centroid straight into the material meets. */
  function rayInto(T, f) {
    var s = T.fn.signedVolume < 0 ? -1 : 1, o = centroid(T, f);
    var dx = -T.fn.n[f * 3] * s, dy = -T.fn.n[f * 3 + 1] * s, dz = -T.fn.n[f * 3 + 2] * s;
    var cand = null;
    if (typeof NSO_BVH !== 'undefined' && NSO_BVH && NSO_BVH.indexFor) {
      var ix = NSO_BVH.indexFor(soupRef, false, 0);
      if (ix) cand = NSO_BVH.rayCandidates(ix, o[0], o[1], o[2], dx, dy, dz, Infinity, T.rayBuf || (T.rayBuf = []));
    }
    var p = T.pos, best = null, n = cand ? cand.length : T.nf;
    for (var i = 0; i < n; i++) {
      var g = cand ? cand[i] : i;
      if (g === f || !T.fn.ok[g]) continue;
      var a = T.tri[g * 3] * 3, b = T.tri[g * 3 + 1] * 3, c = T.tri[g * 3 + 2] * 3;
      var e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      var e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      var hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      var det = e1x * hx + e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      var inv = 1 / det, sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2];
      var u = (sx * hx + sy * hy + sz * hz) * inv;
      if (u < 0 || u > 1) continue;
      var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      var v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-6 && (!best || t < best.t)) best = { face: g, t: t };
    }
    return best;
  }

  /* A binary min-heap of { f, d } on d. */
  function Heap() { this.a = []; }
  Heap.prototype.size = function () { return this.a.length; };
  Heap.prototype.push = function (f, d) {
    var a = this.a, x = { f: f, d: d }, i = a.length; a.push(x);
    while (i > 0) { var p = (i - 1) >> 1; if (a[p].d <= d) break; a[i] = a[p]; i = p; }
    a[i] = x;
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], x = a.pop(), n = a.length, i = 0;
    if (!n) return top;
    for (;;) {
      var l = 2 * i + 1, r = l + 1, m = i, dm = x.d;
      if (l < n && a[l].d < dm) { m = l; dm = a[l].d; }
      if (r < n && a[r].d < dm) m = r;
      if (m === i) break;
      a[i] = a[m]; i = m;
    }
    a[i] = x;
    return top;
  };

  /* Pick the wall under a click. Every layer the ray crosses is a candidate:
     Thicken in wants the pocket wall behind the outside skin, so the first
     face on the asked side wins; when none is, the first face is taken and the
     engine says it is on the wrong side. */
  function pickWall(event) {
    if (!on || !mesh || !state.camera || !state.renderer) return false;
    var r = state.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, state.camera);
    mesh.updateMatrixWorld(true);
    var hits = rc.intersectObject(mesh, false).filter(function (h) { return h.faceIndex != null; });
    if (!hits.length) return false;
    var geo = mesh.geometry, nTri = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) | 0;
    if (nTri !== soupRef.length / 9) {
      say('Thicken: the picture of this piece and its triangles disagree - click Whole piece to thicken all of it', true);
      return false;
    }
    var T = topology();
    var want = mode === 'out' ? 1 : 0, seed = -1;
    for (var i = 0; i < hits.length; i++) {
      var f = hits[i].faceIndex;
      if (f < T.nf && T.fn.ok[f] && T.outer[f] === want) { seed = f; break; }
    }
    if (seed < 0) for (var j = 0; j < hits.length; j++) { var g = hits[j].faceIndex; if (g < T.nf && T.fn.ok[g]) { seed = g; break; } }
    if (seed < 0) return false;
    if (wall && wall.mayMove[seed]) clearWall();
    else {
      setWall(growWall(seed));
      followWallSide(T.outer[seed] === 1 ? 'out' : 'in');
    }
    return true;
  }

  /* The wall you clicked is on one side only. A notch / pocket wall is an inside
     face (Thicken in grows it into the gap); an outer skin is Thicken out's. Both
     add material, so the click already says which verb - take it. */
  function followWallSide(want) {
    if (want === mode) return;
    mode = want;
    showPanel(true);
    say(want === 'in'
      ? 'Thicken in - that wall faces a notch or pocket, so it grows into the gap'
      : 'Thicken out - that wall is on the outside, so it grows outward');
  }

  /* The slider's top: 8 mm for the whole piece (the skin), the piece's own size
     for one picked wall - a notch can be wider than 8. */
  function syncRange() {
    var s = slider();
    if (!s) return;
    var max = SLIDER_MAX_WHOLE;
    if (on && wall && sizeMm > SLIDER_MAX_WHOLE) max = Math.min(SLIDER_MAX_WALL_CAP, Math.ceil(sizeMm));
    if (+s.max !== max) {
      s.max = String(max);
      if (parseFloat(s.value) > max) s.value = String(max);
    }
  }

  function setWall(w) { wall = w; dirty = true; }
  function clearWall() { wall = null; dirty = true; }

  /* ---------------------------------------------------------------
     The ghost
     --------------------------------------------------------------- */

  function clearDrawn() {
    disposeObj(movedObj); movedObj = null;
    disposeObj(edgeObj); edgeObj = null;
    disposeObj(wallObj); wallObj = null;
    disposeObj(slabObj); slabObj = null;
    disposeObj(slabEdgeObj); slabEdgeObj = null;
  }

  function redraw() {
    dirty = false;
    clearDrawn();
    syncRange();
    var mm = mmNow();
    var res;
    try { res = _thickenOffsetSoup(soupRef, mode, mm, wall ? { mayMove: wall.mayMove } : undefined); }
    catch (e) { res = { reason: (e && e.message) || 'error' }; }
    last = { mode: mode, mm: mm, wall: wall, res: res, soup: res && res.soup ? res.soup : null, gateWhy: null, gated: false };

    if (last.soup) {
      var out = [], n = soupRef.length / 9;
      for (var t = 0; t < n; t++) {
        var moved = false;
        for (var k = 0; k < 9; k++) if (Math.abs(last.soup[t * 9 + k] - soupRef[t * 9 + k]) > MOVE_EPS) { moved = true; break; }
        if (moved) for (var q = 0; q < 9; q++) out.push(last.soup[t * 9 + q]);
      }
      last.movedTris = out.length / 9;
      if (out.length) {
        var g = localGeo(new Float32Array(out));
        g.computeVertexNormals();
        movedObj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
          color: 0x4ade80, emissive: 0x14532d, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0,
          transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false }));
        movedObj.renderOrder = 42;
        group.add(movedObj);
        edgeObj = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20),
          new THREE.LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.95, depthTest: false }));
        edgeObj.renderOrder = 43;
        group.add(edgeObj);
      }
    }
    if (wall && last.soup) drawSlab();
    if (wall) {
      var wt = [];
      for (var f = 0; f < wall.mayMove.length; f++) if (wall.mayMove[f]) for (var c = 0; c < 9; c++) wt.push(soupRef[f * 9 + c]);
      wallObj = new THREE.Mesh(localGeo(new Float32Array(wt)), new THREE.MeshBasicMaterial({
        color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }));
      wallObj.renderOrder = 44;
      group.add(wallObj);
    }
    readout();
  }

  /* The material a picked wall would ADD, as a solid: the wall's rim swept from
     where it stands to where it lands. Only the patch's boundary edges are swept
     (a wall of many triangles has no sheets inside it). The faces that land are
     already the green; this is what fills the gap between. */
  function drawSlab() {
    var T = topology(), soup = last.soup, nf = T.nf, edges = Object.create(null), tris = [];
    function key(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    for (var f = 0; f < nf; f++) {
      if (!wall.mayMove[f]) continue;
      for (var k = 0; k < 3; k++) {
        var e = key(T.tri[f * 3 + k], T.tri[f * 3 + (k + 1) % 3]);
        edges[e] = edges[e] ? edges[e] + 1 : 1;
      }
    }
    function pt(arr, f, k) { return [arr[f * 9 + k * 3], arr[f * 9 + k * 3 + 1], arr[f * 9 + k * 3 + 2]]; }
    for (var t = 0; t < nf; t++) {
      if (!wall.mayMove[t]) continue;
      for (var c = 0; c < 3; c++) {
        var d = (c + 1) % 3;
        if (edges[key(T.tri[t * 3 + c], T.tri[t * 3 + d])] !== 1) continue;
        var a0 = pt(soupRef, t, c), b0 = pt(soupRef, t, d), a1 = pt(soup, t, c), b1 = pt(soup, t, d);
        Array.prototype.push.apply(tris, a0.concat(b0, b1, a0, b1, a1));
      }
    }
    if (!tris.length) return;
    var g = localGeo(new Float32Array(tris));
    g.computeVertexNormals();
    slabObj = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0x86efac, side: THREE.DoubleSide, transparent: true, opacity: 0.3, depthWrite: false }));
    slabObj.renderOrder = 41;
    group.add(slabObj);
    slabEdgeObj = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20),
      new THREE.LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.7, depthTest: false }));
    slabEdgeObj.renderOrder = 43;
    group.add(slabEdgeObj);
  }

  /* Would Set be refused for piercing? The slow check, run on release. */
  function gate() {
    if (!on || !last || !last.soup) return;
    if (last.gated) return;
    last.gated = true;
    try {
      if (typeof NSO_Repair !== 'undefined' && NSO_Repair && typeof NSO_Repair.inspect === 'function') {
        if (pierceBase == null) pierceBase = NSO_Repair.inspect(soupRef).selfIntersections;
        var after = NSO_Repair.inspect(last.soup).selfIntersections;
        if (after > pierceBase) last.gateWhy = 'the moved faces would cross the piece (piercing pairs ' + pierceBase + '→' + after + ')';
      }
    } catch (e) { /* the bake runs the same check and says so */ }
    readout();
  }

  function readout() {
    var mm = mmNow();
    var read = $('thicken-read'), lr = $('thicken-level-read'), ro = $('thicken-readout'), set = $('btn-thicken-set'),
        whole = $('btn-thicken-whole');
    if (read) read.textContent = fmt(mm);
    if (lr) lr.textContent = fmt(mm);
    if (!on || !last) {
      if (set) set.disabled = true;
      if (whole) whole.disabled = true;
      return;
    }
    var res = last.res, text, bad = false;
    if (res && res.soup) {
      var side = mode === 'out' ? 'outer' : 'inner';
      text = 'Thicken ' + mode + ' ' + fmt(mm) + ' mm - ' + res.moved + ' ' + side + ' face(s) move, ' + res.held + ' held' +
             (wall ? ' (one wall: ' + wall.count + ' triangle(s) picked)' : ' (whole piece)');
      if (last.gateWhy) { text = 'Thicken ' + mode + ' ' + fmt(mm) + ' mm refused - ' + last.gateWhy; bad = true; }
    } else {
      var why = (res && res.reason) || 'piece unchanged';
      /* The engine's filter refusal is about the caller; for the person it is "that wall is on the other side". */
      if (wall && /^no face on the asked side survives/.test(why)) {
        why = 'the wall you picked is on the ' + (mode === 'out' ? 'inside' : 'outside') + ' - Thicken ' +
              (mode === 'out' ? 'in' : 'out') + ' moves it; click another face, or Whole piece';
      }
      text = 'Thicken ' + mode + ' ' + fmt(mm) + ' mm refused - ' + why;
      bad = true;
    }
    if (ro) { ro.textContent = text; ro.classList.toggle('is-refused', bad); }
    if (set) set.disabled = bad;
    if (whole) whole.disabled = !wall;
  }

  /* ---------------------------------------------------------------
     Arm / put away
     --------------------------------------------------------------- */

  function showPanel(v) {
    var p = $('thicken-panel');
    if (p) p.hidden = !v;
    [['btn-thicken-out', 'out'], ['btn-thicken-in', 'in']].forEach(function (x) {
      var b = $(x[0]);
      if (!b) return;
      var lit = !!v && mode === x[1];
      b.classList.toggle('is-on', lit);
      b.setAttribute('aria-pressed', lit ? 'true' : 'false');
    });
  }

  function arm(which) {
    if (!engineReady()) { say('Thicken needs app-finish.js', true); return { ok: false }; }
    if (on) {
      if (which === mode) { cancel(); return { ok: true, left: true }; }
      mode = which;                       // the other verb: same wall, same mm
      showPanel(true);
      dirty = true; redraw(); gate();
      return { ok: true, switched: true };
    }
    var model = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!model) { say('Select a piece first', true); return { ok: false, reason: 'no piece' }; }
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(model) : 0;
    if (painted > 0) {
      say('Thicken stood down - ' + painted + ' painted face(s); the rim of the moving side ' +
          'is shared with the held faces, so no face can be promised untouched. Clear paint to thicken.', true);
      return { ok: false, reason: 'painted faces: ' + painted };
    }
    var src = soupOfModel(model);
    if (!src) { say('Thicken failed - piece unchanged', true); return { ok: false, reason: 'no soup' }; }
    var ms = meshOf(model);
    if (!ms) { say('Thicken: put the piece on the plate first. Nothing changed.', true); return { ok: false, reason: 'not placed' }; }

    on = true; mode = which;
    m = model; soupRef = src.soup; geoRef = model.geometry; usingRaw = src.raw; mesh = ms;
    wall = null; topo = null; pierceBase = null; last = null;
    sizeMm = extentOf(soupRef);
    openView();
    showPanel(true);
    redraw(); gate();
    say('Thicken ' + mode + ' - slide to see it on the piece; click a face to thicken just that wall; Set bakes it, Cancel drops it.');
    tick();
    return { ok: true };
  }

  function openView() {
    group = new THREE.Group();
    group.userData.skipXray = true;
    group.userData.nsoThickenGroup = true;
    nsoHelpers.attach(mesh, group, 'thicken');
    ghost(true);
  }
  function closeView() {
    clearDrawn();
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
  }

  function teardown() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    closeView();
    showPanel(false);
    on = false;
    syncRange();                                  // the slider goes back to the whole piece's 8 mm
    m = null; soupRef = null; geoRef = null; mesh = null; topo = null; wall = null; last = null; press = null; pierceBase = null;
    readout();
  }

  function cancel(quiet) {
    if (!on) return false;
    teardown();
    if (!quiet) say('Thicken cancelled - nothing changed');
    return true;
  }

  /* The piece moved on under the panel (another selection, an Undo, a bake):
     the ghost no longer describes it. */
  function stale() {
    if (!on) return false;
    var cur = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    var same = cur === m && (usingRaw ? m.rawTris === soupRef : m.geometry === geoRef) && meshOf(m) === mesh;
    if (!same) {
      cancel(true);
      say('Thicken put away - the piece or the selection changed under it. Nothing was set.');
      return true;
    }
    return false;
  }

  function tick() {
    raf = 0;
    if (!on) return;
    if (stale()) return;
    if (dirty) redraw();
    raf = requestAnimationFrame(tick);
  }

  /* ---------------------------------------------------------------
     Set
     --------------------------------------------------------------- */

  function set() {
    if (!on) return { ok: false, reason: 'Thicken is not armed' };
    if (stale()) return { ok: false, reason: 'the piece changed - Thicken put away' };
    if (dirty) redraw();
    if (!last || !last.soup) { say('Thicken ' + mode + ' ' + fmt(mmNow()) + ' mm refused - ' + ((last && last.res && last.res.reason) || 'nothing to set') + '; piece unchanged', true); return { ok: false }; }
    var ghostSoup = last.soup, picked = wall, kind = mode, mm = last.mm, keepMesh = mesh, keepModel = m;
    closeView();                                  // the bake swaps the piece's mesh under the ghost
    var opts = picked ? {
      mayMove: picked.mayMove,
      note: function () { return ' (one wall: ' + picked.count + ' triangle(s) picked)'; }
    } : undefined;
    var r = thickenSelectedModel(kind, mm, opts);
    if (r && r.ok) {
      teardown();
      r.ghostSoup = ghostSoup;
      return r;
    }
    // refused (the piercing gate, most likely): the piece is as it was; put the ghost back
    if (on && meshOf(keepModel) === keepMesh) { openView(); dirty = true; redraw(); if (last) { last.gateWhy = (r && r.reason) || 'refused'; last.gated = true; readout(); } }
    else teardown();
    return r || { ok: false };
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onDown(event) {
    if (!on || event.button !== 0) { press = null; return; }
    press = { x: event.clientX, y: event.clientY, t: performance.now() };
  }
  /* A click, not a drag: the press lands where it let go, quickly. A drag is
     the orbit or a move and is nobody's pick. */
  function onUp(event) {
    var p = press; press = null;
    if (!p || !on || event.button !== 0) return;
    var cv = state.renderer && state.renderer.domElement;
    if (!cv || event.target !== cv) return;
    if (Math.abs(event.clientX - p.x) > CLICK_PX || Math.abs(event.clientY - p.y) > CLICK_PX) return;
    if (performance.now() - p.t > CLICK_MS) return;
    if (stale()) return;
    if (pickWall(event)) { redraw(); gate(); }
  }

  function bind() {
    [['btn-thicken-out', function () { arm('out'); }], ['btn-thicken-in', function () { arm('in'); }],
     ['btn-thicken-set', function () { set(); }], ['btn-thicken-cancel', function () { cancel(); }],
     ['btn-thicken-whole', function () { if (on) { clearWall(); redraw(); gate(); } }]].forEach(function (x) {
      var e = $(x[0]);
      if (e && e.dataset.nsoWired !== '1') { e.dataset.nsoWired = '1'; e.addEventListener('click', x[1]); }
    });
    var s = slider();
    if (s && s.dataset.nsoWired !== '1') {
      s.dataset.nsoWired = '1';
      s.addEventListener('input', function () { readout(); if (on) dirty = true; });
      s.addEventListener('change', function () { if (on) { if (dirty) redraw(); gate(); } });
    }
    if (typeof state === 'undefined' || !state.renderer || !state.renderer.domElement || state._thickenBound) return;
    state._thickenBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', function () { press = null; });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && on) cancel(); });
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('thicken', {
    live: function () { return on; },
    close: function () { cancel(); }
  });

  /* For the drive checks and leaveTool: the same paths the controls run. */
  window.nsoThickenLive = {
    arm: arm, cancel: cancel, set: set,
    on: function () { return on; },
    info: function () {
      return on ? {
        mode: mode, mm: mmNow(), wall: wall ? { count: wall.count, seed: wall.seed } : null,
        ok: !!(last && last.soup), reason: last && last.res && last.res.reason, gateWhy: last && last.gateWhy,
        moved: last && last.res ? last.res.moved : null, held: last && last.res ? last.res.held : null,
        movedTris: last ? last.movedTris : null, soup: last ? last.soup : null,
        sliderMax: +(slider() || {}).max, slab: !!slabObj,
        readout: ($('thicken-readout') || {}).textContent, modelId: m.id
      } : null;
    },
    pickTriangle: function (seed) {                  // for a check that names a triangle rather than aiming a click
      if (!on) return false;
      if (wall && wall.mayMove[seed]) clearWall();
      else { setWall(growWall(seed)); followWallSide(topology().outer[seed] === 1 ? 'out' : 'in'); }
      redraw(); gate();
      return true;
    },
    objects: function () { return { group: group, moved: movedObj, edges: edgeObj, wall: wallObj, slab: slabObj, mesh: mesh }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
