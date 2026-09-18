/* Measure — click two points on the plate, or one edge, and read the distance
   in millimetres.

   NOT A BAKE. This file writes nothing to any mesh, any rawTris, or any
   model: every object it puts in the scene has raycast() stubbed out and is
   disposed on clear, and the only model state it touches is read. So the
   paint rule in docs/HANDOFF.md ("a painted / excluded face stays untouched
   by ANY bake mechanism") has nothing to bind here - there is no skip list to
   read because there is nothing to skip. It is deliberately absent from the
   paint-scope roster for that reason; if this file ever changes geometry, it
   joins the roster in the same commit.

   WHAT IT REUSES, and from where. Nothing below is new machinery:

     * The click ray is app-core's - setPointerFromEvent + state.raycaster +
       state.pointer, exactly as app-mask.js's hitFace() uses them.
     * Standing down so a click does not also start a move drag is
       app-mask.js's nsoMaskTakesClick contract, asked by app-core's
       onCanvasPointerDown. nsoMeasureTakesClick is the same predicate for
       this tool, asked in the same place, for the same reason: app-core binds
       its listener inside initThree() while the document is still parsing and
       this file binds at DOMContentLoaded, so app-core is always the earlier
       listener and stopPropagation from there would never reach us.
     * The helper-object conventions are app-mask.js's overlay and
       app-finish.js's showPlanarHighlight / showInspectCage: an explicit
       renderOrder, depthTest/depthWrite off for lines drawn over the solid,
       raycast() stubbed to a no-op so a helper can never eat the NEXT click,
       and geometry + material disposed by the clear function.
     * The feature-edge threshold is the 15 degrees app-sel-outline.js hands
       THREE.EdgesGeometry. An edge this tool will measure is an edge the
       selection outline already draws, so what you can see is what you can
       click. It is NOT nso_carve.js's DIHEDRAL_DEG of 20: that one asks a
       different question (are these facets one smooth region a blade should
       treat as a face?) about a cluster of planes inside a blade's reach,
       and answers it for aiming a cut, not for measuring a length. Two
       thresholds, two questions - see docs/MEASURE.md section 1.
     * Drawing a transient, on-demand answer ON the mesh is what
       app-defects.js's Check piece does, and it reached the same conclusions
       independently: line layers with depthTest off, patch layers off
       app-mask.js's overlay, raycast stubbed, an explicit place in the
       renderOrder ladder, and a redraw that ends when the piece is re-baked
       under it. Where they differ is what the mark is FOR - see below.

   RENDER ORDER. The ladder on a piece, as it now stands: selected outline 12,
   inspect cage 16, armed-face highlight 20, Paint Excluded 40, Paint Selected
   41, Check piece's patches 50 and its lines 52, the position lock 999. The
   measurement goes at 30 - above the three helpers, below everything that is
   an ANSWER about the piece. That ordering is deliberate: the paint says which
   faces a bake will skip and the check says where the piece is broken, and
   both of those should beat a ruler laid over them. A measurement drawn across
   a painted or a faulty face loses, and that is the ladder working.

   UNITS. One world unit is one millimetre: buildPlateMesh() builds the plate
   as PlaneGeometry(plate.w, plate.d) with the plate's mm figures, and a piece
   is added with its geometry unscaled. The distance reported is therefore
   measured in world space and printed as mm with no conversion - and because
   it is re-measured from world space every frame, a piece that is nudged,
   rotated or re-seated updates its own measurement instead of leaving a
   stale number on screen.

   ANCHORING. An endpoint is stored as (piece, point in that piece's local
   space, the geometry it was picked on), never as a world point. Moving the
   piece moves the measurement with it; re-baking the piece hands back a
   different geometry, and a local point on the old one means nothing on the
   new one, so the measurement drops itself and says why.

   The geometry below is pure and free of THREE and the DOM, so
   tools/nso_measure_test.js can check it against fixtures on disk without a
   browser, the way cth/overlay.js's buildAimSummary is checked. */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- core
     Everything in this block speaks the app's own currency: a "soup" is a
     Float32Array of 9 floats per triangle, the same thing model.rawTris is.
     No THREE, no document, no window. */

  // 1e-4 units, the quantisation app-mask.js's coplanar flood fill welds at.
  var WELD_Q = 1e4;
  // Two faces this far apart in angle make an edge you can see, and an edge
  // app-sel-outline.js already draws. Degrees.
  var EDGE_ANGLE_DEG = 15;
  // How straight two edges must be to count as one edge for length. Degrees.
  var COLLINEAR_DEG = 0.5;

  function weldKey(x, y, z) {
    return Math.round(x * WELD_Q) + '|' + Math.round(y * WELD_Q) + '|' + Math.round(z * WELD_Q);
  }

  /* Welded vertices, per-triangle normals, and the undirected edge list with
     the triangles on either side of each edge. One pass, and the caller keeps
     the result for as long as the soup is unchanged. */
  function buildTopology(soup) {
    var nTri = (soup.length / 9) | 0;
    var verts = [];
    var ids = new Int32Array(nTri * 3);
    var byKey = new Map();
    var t, v, i, o;
    for (t = 0; t < nTri; t++) {
      for (v = 0; v < 3; v++) {
        o = t * 9 + v * 3;
        var x = soup[o], y = soup[o + 1], z = soup[o + 2];
        var k = weldKey(x, y, z);
        var id = byKey.get(k);
        if (id === undefined) {
          id = verts.length;
          verts.push([x, y, z]);
          byKey.set(k, id);
        }
        ids[t * 3 + v] = id;
      }
    }
    var normals = new Float32Array(nTri * 3);
    for (t = 0; t < nTri; t++) {
      o = t * 9;
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (L > 1e-12) { normals[t * 3] = nx / L; normals[t * 3 + 1] = ny / L; normals[t * 3 + 2] = nz / L; }
    }
    var edges = [];
    var edgeByKey = new Map();
    for (t = 0; t < nTri; t++) {
      for (v = 0; v < 3; v++) {
        var a = ids[t * 3 + v], b = ids[t * 3 + (v + 1) % 3];
        if (a === b) continue;          // a degenerate triangle has no edge here
        var lo = a < b ? a : b, hi = a < b ? b : a;
        var ek = lo + '|' + hi;
        var e = edgeByKey.get(ek);
        if (!e) { e = { a: lo, b: hi, tris: [] }; edgeByKey.set(ek, e); edges.push(e); }
        if (e.tris.indexOf(t) < 0) e.tris.push(t);
      }
    }
    // Which edges meet at a vertex - what the chain walk follows.
    var atVertex = [];
    for (i = 0; i < verts.length; i++) atVertex.push([]);
    for (i = 0; i < edges.length; i++) {
      atVertex[edges[i].a].push(i);
      atVertex[edges[i].b].push(i);
    }
    return { nTri: nTri, verts: verts, ids: ids, normals: normals, edges: edges, atVertex: atVertex };
  }

  /* An edge is worth measuring when you can see it: a boundary edge (one
     triangle, so the mesh is open there) or a crease sharper than the
     threshold. The flat diagonal that splits a box face into two triangles is
     neither, which is why clicking a 20 mm face reports 20 and not 28.28. */
  function markFeatureEdges(topo, angleDeg) {
    var cosA = Math.cos((angleDeg == null ? EDGE_ANGLE_DEG : angleDeg) * Math.PI / 180);
    for (var i = 0; i < topo.edges.length; i++) {
      var e = topo.edges[i];
      if (e.tris.length !== 2) { e.feature = true; continue; }
      var p = e.tris[0] * 3, q = e.tris[1] * 3;
      var d = topo.normals[p] * topo.normals[q] +
              topo.normals[p + 1] * topo.normals[q + 1] +
              topo.normals[p + 2] * topo.normals[q + 2];
      e.feature = d < cosA;
    }
    return topo;
  }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function len(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
  function dist(a, b) { return len(sub(a, b)); }

  // Closest point on segment ab to p, and how far away it is.
  function closestOnSegment(a, b, p) {
    var ab = sub(b, a), ap = sub(p, a);
    var d2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    var t = d2 > 1e-18 ? (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / d2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    return { point: q, t: t, dist: dist(q, p) };
  }

  /* Where the click really landed. A vertex wins over an edge and an edge
     over the bare triangle hit, both inside the same tolerance, because a
     vertex is always ON its edges and would otherwise never be reachable.
     Snapping is what makes the number match the drawing: two corners of a
     20 mm box read 20.000, not 19.7-ish. */
  function snapPoint(topo, p, tol) {
    var i, best = -1, bd = tol;
    for (i = 0; i < topo.verts.length; i++) {
      var d = dist(topo.verts[i], p);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      return { kind: 'vertex', point: topo.verts[best].slice(), dist: bd, vertex: best };
    }
    var bestE = -1, be = tol, bq = null;
    for (i = 0; i < topo.edges.length; i++) {
      if (!topo.edges[i].feature) continue;
      var c = closestOnSegment(topo.verts[topo.edges[i].a], topo.verts[topo.edges[i].b], p);
      if (c.dist < be) { be = c.dist; bestE = i; bq = c.point; }
    }
    if (bestE >= 0) return { kind: 'edge', point: bq, dist: be, edge: bestE };
    return { kind: 'face', point: p.slice(), dist: 0, edge: -1 };
  }

  /* The nearest feature edge to a point, whatever the distance. Edge mode
     asks this - the click is on a face NEAR an edge, not on the edge. */
  function nearestFeatureEdge(topo, p) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < topo.edges.length; i++) {
      if (!topo.edges[i].feature) continue;
      var c = closestOnSegment(topo.verts[topo.edges[i].a], topo.verts[topo.edges[i].b], p);
      if (c.dist < bd) { bd = c.dist; best = i; }
    }
    return best < 0 ? null : { edge: best, dist: bd };
  }

  /* One drawn edge, end to end. A mesher is free to split a 40 mm edge into
     four 10 mm pieces; a person clicking it means the 40. So from the clicked
     edge, walk both ways through collinear feature edges and add them up. The
     walk stops at a corner (nothing collinear carries on) and at a fork (more
     than one does, so there is no single honest answer). */
  function edgeChain(topo, edgeIdx, collinearDeg) {
    var e0 = topo.edges[edgeIdx];
    if (!e0) return null;
    var A = topo.verts[e0.a], B = topo.verts[e0.b];
    var dir = sub(B, A);
    var L0 = len(dir);
    if (!(L0 > 1e-12)) return null;
    dir = [dir[0] / L0, dir[1] / L0, dir[2] / L0];
    var cosC = Math.cos((collinearDeg == null ? COLLINEAR_DEG : collinearDeg) * Math.PI / 180);
    var used = {};
    used[edgeIdx] = true;
    var segs = 1, total = L0;
    var ends = [e0.a, e0.b];
    var forked = false;

    /* Outward only, and that sign matters. A T-junction - the same span
       carried by one long edge on the face one side of it and by two short
       ones on the face the other side - puts a collinear edge at the far end
       that runs straight back over the ground just covered. Accepting it on
       "collinear, either way" folds the chain back on itself and reports a
       20 mm edge as 40. So each side of the walk only ever takes a step that
       carries on the way it was already going. */
    for (var side = 0; side < 2; side++) {
      var at = ends[side];
      var want = side === 0 ? -1 : 1;
      for (;;) {
        var list = topo.atVertex[at], hits = [];
        for (var i = 0; i < list.length; i++) {
          var ei = list[i];
          if (used[ei]) continue;
          var e = topo.edges[ei];
          if (!e.feature) continue;
          var other = e.a === at ? e.b : e.a;
          var w = sub(topo.verts[other], topo.verts[at]);
          var wl = len(w);
          if (!(wl > 1e-12)) continue;
          var dot = (w[0] * dir[0] + w[1] * dir[1] + w[2] * dir[2]) / wl;
          if (dot * want >= cosC) hits.push({ ei: ei, other: other, wl: wl });
        }
        if (hits.length !== 1) { if (hits.length > 1) forked = true; break; }
        used[hits[0].ei] = true;
        total += hits[0].wl;
        segs++;
        at = hits[0].other;
      }
      ends[side] = at;
    }
    return {
      length: total,
      segments: segs,
      forked: forked,
      a: topo.verts[ends[0]].slice(),
      b: topo.verts[ends[1]].slice()
    };
  }

  // Two points, one answer, plus the per-axis deltas a print needs.
  function span(p, q) {
    var dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    return { length: Math.sqrt(dx * dx + dy * dy + dz * dz), dx: dx, dy: dy, dz: dz };
  }

  /* Three decimals under 100 mm, two above it. A 3D printer resolves microns
     in Z and roughly 0.1 mm in XY, so a fourth decimal would be noise dressed
     as precision. */
  function formatMm(v) {
    var a = Math.abs(v);
    return (a >= 100 ? v.toFixed(2) : v.toFixed(3)) + ' mm';
  }

  var CORE = {
    WELD_Q: WELD_Q,
    EDGE_ANGLE_DEG: EDGE_ANGLE_DEG,
    COLLINEAR_DEG: COLLINEAR_DEG,
    buildTopology: buildTopology,
    markFeatureEdges: markFeatureEdges,
    closestOnSegment: closestOnSegment,
    snapPoint: snapPoint,
    nearestFeatureEdge: nearestFeatureEdge,
    edgeChain: edgeChain,
    span: span,
    formatMm: formatMm,
    /* Soup + point in, measurement out. The one call a test needs to ask the
       same question the UI asks, without a browser. */
    measureEdgeAt: function (soup, p, opts) {
      var topo = markFeatureEdges(buildTopology(soup), opts && opts.angleDeg);
      var near = nearestFeatureEdge(topo, p);
      if (!near) return null;
      return edgeChain(topo, near.edge, opts && opts.collinearDeg);
    },
    snapIn: function (soup, p, tol, opts) {
      var topo = markFeatureEdges(buildTopology(soup), opts && opts.angleDeg);
      return snapPoint(topo, p, tol);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (typeof window !== 'undefined') window.NSO_Measure = CORE;

  // Node only wants the maths. Everything below needs a page.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ------------------------------------------------------------ the tool */

  // Above the outline (12), the cage (16) and the armed face (20); below the
  // paint (40), which app-mask.js reserves the top of the ladder for.
  var MEASURE_RENDER_ORDER = 30;
  // Click within this many pixels of a corner and you meant the corner.
  var SNAP_PX = 14;
  // The marker dot, in pixels, held at that size whatever the zoom.
  var DOT_PX = 4;

  var IDLE_LABEL = 'Measure';
  var LIVE_LABEL = 'Measuring… click to stop';

  var helpers = [];       // every object this file put in the scene
  var label = null;       // the HTML chip that carries the number
  var pending = null;     // the first anchor of a span, waiting for the second
  var shot = null;        // the measurement on screen
  var ticking = false;

  function el(id) { return document.getElementById(id); }
  function mode() { var s = el('sel-measure-mode'); return s && s.value === 'edge' ? 'edge' : 'span'; }

  /* ---- scene helpers: made here, disposed here, never raycastable ---- */

  function addHelper(obj) {
    obj.renderOrder = MEASURE_RENDER_ORDER;
    // The paint learned this the hard way: a helper that answers the ray eats
    // the next click, and the click lands on the helper instead of the piece.
    obj.raycast = function () {};
    state.scene.add(obj);
    helpers.push(obj);
    return obj;
  }

  function dropHelpers() {
    for (var i = 0; i < helpers.length; i++) {
      var h = helpers[i];
      if (h.parent) h.parent.remove(h);
      if (h.geometry) h.geometry.dispose();
      if (h.material) h.material.dispose();
    }
    helpers.length = 0;
  }

  function makeLine(colour) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    // depthTest off, and therefore depthWrite off too - app-sel-outline.js
    // spells out why writing depth from a line that passes every depth test
    // punches holes in whatever is drawn after it.
    return addHelper(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: colour, depthTest: false, depthWrite: false, transparent: true, opacity: 1
    })));
  }

  function makeDot(colour) {
    return addHelper(new THREE.Mesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false, depthWrite: false,
                                    transparent: true, opacity: 1 })
    ));
  }

  /* ---- the readout chip ---- */

  function ensureLabel() {
    if (label && label.isConnected) return label;
    var home = document.querySelector('.viewport-section') || document.body;
    label = document.createElement('div');
    label.id = 'measure-label';
    label.className = 'measure-label';
    label.hidden = true;
    home.appendChild(label);
    return label;
  }

  function hideLabel() { if (label) { label.hidden = true; label.textContent = ''; } }

  /* ---- world <-> mm ---- */

  /* How many mm one pixel covers at this distance from the camera. The snap
     radius and the marker size are both pixel quantities, and this is the
     only honest way to spend them in a world-space scene. */
  function mmPerPixel(worldPoint) {
    var cam = state.camera, dom = state.renderer && state.renderer.domElement;
    if (!cam || !dom || !dom.clientHeight) return 0.2;
    var d = cam.position.distanceTo(worldPoint);
    return 2 * Math.tan((cam.fov * Math.PI / 180) / 2) * d / dom.clientHeight;
  }

  /* The piece's triangles in its OWN space, welded topology and all, cached
     on the geometry so a second click on the same piece is free. A bake hands
     back a new geometry object, so the cache retires itself. Reads through
     the index buffer when there is one - app-mask.js's faceUnderCursor notes
     what happens when that is skipped: the answer lands on a triangle nobody
     clicked. */
  function topologyOf(mesh) {
    var geo = mesh.geometry;
    if (geo.userData && geo.userData.__nsoMeasureTopo) return geo.userData.__nsoMeasureTopo;
    var pos = geo.attributes && geo.attributes.position;
    if (!pos) return null;
    var idx = geo.index;
    var n = ((idx ? idx.count : pos.count) / 3) | 0;
    var soup = new Float32Array(n * 9);
    for (var t = 0; t < n; t++) {
      for (var v = 0; v < 3; v++) {
        var i = idx ? idx.getX(t * 3 + v) : (t * 3 + v);
        soup[t * 9 + v * 3] = pos.getX(i);
        soup[t * 9 + v * 3 + 1] = pos.getY(i);
        soup[t * 9 + v * 3 + 2] = pos.getZ(i);
      }
    }
    var topo = CORE.markFeatureEdges(CORE.buildTopology(soup));
    if (!geo.userData) geo.userData = {};
    geo.userData.__nsoMeasureTopo = topo;
    return topo;
  }

  /* ---- picking ---- */

  // app-mask.js's hitFace, with this file's own helpers skipped instead of
  // the paint overlay. Same ray, same raycaster, same order of business.
  function hitPiece(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (helpers.indexOf(hits[i].object) >= 0) continue;
      if (hits[i].faceIndex == null) continue;
      var obj = hits[i].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx !== 'number' || !state.placed[idx]) continue;
      return { hit: hits[i], placedIndex: idx, placed: state.placed[idx] };
    }
    return null;
  }

  /* An anchor is a point on a piece, kept in that piece's own space. It
     survives the piece being moved or turned and refuses to survive the piece
     being re-baked, which is exactly the difference between a measurement
     that follows the work and one that lies about it. */
  function anchorOf(pick, localPoint, kind) {
    return {
      sourceId: pick.placed.sourceId,
      placedIndex: pick.placedIndex,
      geom: pick.placed.mesh.geometry,
      local: localPoint.slice(),
      kind: kind
    };
  }

  function meshFor(anchor) {
    var p = state.placed[anchor.placedIndex];
    if (!p || !p.mesh || p.sourceId !== anchor.sourceId) {
      p = null;
      for (var i = 0; i < state.placed.length; i++) {
        var q = state.placed[i];
        if (q && q.mesh && q.sourceId === anchor.sourceId) { p = q; anchor.placedIndex = i; break; }
      }
    }
    if (!p || !p.mesh) return null;
    if (p.mesh.geometry !== anchor.geom) return null;   // re-baked: the point is gone
    return p.mesh;
  }

  function worldOf(anchor) {
    var mesh = meshFor(anchor);
    if (!mesh) return null;
    mesh.updateMatrixWorld();
    return mesh.localToWorld(new THREE.Vector3(anchor.local[0], anchor.local[1], anchor.local[2]));
  }

  /* ---- taking a measurement ---- */

  function clearShot(why) {
    shot = null;
    pending = null;
    dropHelpers();
    hideLabel();
    if (why) setStatus(why);
  }

  function startSpanAt(pick) {
    var mesh = pick.placed.mesh;
    mesh.updateMatrixWorld();
    var lp = mesh.worldToLocal(pick.hit.point.clone());
    var topo = topologyOf(mesh);
    var tol = mmPerPixel(pick.hit.point) * SNAP_PX;
    var snap = topo ? CORE.snapPoint(topo, [lp.x, lp.y, lp.z], tol)
                    : { kind: 'face', point: [lp.x, lp.y, lp.z] };
    return anchorOf(pick, snap.point, snap.kind);
  }

  function takeSpan(pick) {
    var a = startSpanAt(pick);
    if (!pending) {
      dropHelpers();
      hideLabel();
      shot = null;
      pending = a;
      buildSpanHelpers();
      setStatus('Measure - first point on ' + pieceName(a) + ' (' + a.kind +
                '). Click the second point.');
      tick();
      return true;
    }
    shot = { type: 'span', a: pending, b: a };
    pending = null;
    dropHelpers();
    buildSpanHelpers();
    tick();
    setStatus(describe());
    return true;
  }

  function takeEdge(pick) {
    var mesh = pick.placed.mesh;
    var topo = topologyOf(mesh);
    if (!topo) { setStatus('No geometry to measure on that piece', true); return false; }
    mesh.updateMatrixWorld();
    var lp = mesh.worldToLocal(pick.hit.point.clone());
    var near = CORE.nearestFeatureEdge(topo, [lp.x, lp.y, lp.z]);
    if (!near) {
      setStatus('No edge on that face - nothing on it meets another face at ' +
                CORE.EDGE_ANGLE_DEG + ' degrees or more', true);
      return false;
    }
    var chain = CORE.edgeChain(topo, near.edge);
    if (!chain) { setStatus('That edge has no length', true); return false; }
    dropHelpers();
    pending = null;
    shot = {
      type: 'edge',
      a: anchorOf(pick, chain.a, 'vertex'),
      b: anchorOf(pick, chain.b, 'vertex'),
      segments: chain.segments,
      forked: chain.forked
    };
    buildSpanHelpers();
    tick();
    setStatus(describe());
    return true;
  }

  /* Lime, and the choice was made by elimination against what is already on
     the plate - a measurement line is thin, it is drawn ON a piece, and it has
     to beat every one of them:

       0x38bdf8  an unselected piece's material   (app-core PIECE_COLOR)
       0xf43f5e  a SELECTED piece's material      (app-core SELECT_COLOR)
       0xffdd00  Paint Excluded                   (app-mask)
       0xf472b6  Paint Selected, the Skin target  (app-mask SELECT_COLOR)
       0xff2d2d  open edges and piercing pairs    (app-defects)
       0xff8c1a  non-manifold edges               (app-defects)
       0xc084fc  thin walls, and the Non-solid flag
       0x2dd4bf  the position lock                (app-poslock)
       0xffffff  the selected piece's edge outline (app-sel-outline)
       0xfbbf24  the plate ticks                  (app-core)

     The first cut of this was cyan, following showPlanarHighlight, and a
     screenshot showed the obvious: a cyan line on a cyan piece. Rose was the
     replacement until the merge, when SELECT_COLOR turned out to be rose too -
     the same mistake, on the piece you are most likely to be measuring. Lime
     is the one strong colour nothing on the plate claims, and it reads against
     both piece colours and against the dark plate. */
  var MEASURE_COLOUR = 0xa3e635;

  function buildSpanHelpers() {
    if (!state.scene) return;
    makeLine(MEASURE_COLOUR);
    makeDot(MEASURE_COLOUR);
    makeDot(MEASURE_COLOUR);
    ensureLabel();
  }

  function pieceName(anchor) {
    var p = state.placed[anchor.placedIndex];
    return p && p.name ? p.name : ('#' + (anchor.placedIndex + 1));
  }

  function endpoints() {
    if (shot) {
      var a = worldOf(shot.a), b = worldOf(shot.b);
      return (a && b) ? [a, b] : null;
    }
    if (pending) {
      var p = worldOf(pending);
      return p ? [p, p] : null;
    }
    return null;
  }

  function describe() {
    if (!shot) return '';
    var pts = endpoints();
    if (!pts) return '';
    var s = CORE.span([pts[0].x, pts[0].y, pts[0].z], [pts[1].x, pts[1].y, pts[1].z]);
    if (shot.type === 'edge') {
      return 'Measure - edge ' + CORE.formatMm(s.length) +
             ' (' + shot.segments + (shot.segments === 1 ? ' segment' : ' segments') +
             (shot.forked ? ', stopped at a fork' : '') + ') on ' + pieceName(shot.a);
    }
    return 'Measure - ' + CORE.formatMm(s.length) +
           '  dX ' + s.dx.toFixed(3) + '  dY ' + s.dy.toFixed(3) + '  dZ ' + s.dz.toFixed(3) +
           '  (' + shot.a.kind + ' → ' + shot.b.kind + ')';
  }

  /* One frame of upkeep: re-measure from world space, move the line, the two
     dots and the chip. Runs only while the tool has something to show. */
  function tick() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function frame() {
      ticking = false;
      if (!shot && !pending) { hideLabel(); return; }
      var pts = endpoints();
      if (!pts) {
        clearShot('Measure cleared - the piece it was on was re-baked or removed');
        return;
      }
      if (helpers.length >= 3) {
        var line = helpers[0], d0 = helpers[1], d1 = helpers[2];
        var pos = line.geometry.attributes.position;
        pos.setXYZ(0, pts[0].x, pts[0].y, pts[0].z);
        pos.setXYZ(1, pts[1].x, pts[1].y, pts[1].z);
        pos.needsUpdate = true;
        line.geometry.computeBoundingSphere();
        d0.position.copy(pts[0]);
        d1.position.copy(pts[1]);
        // Held at a constant size on screen, so a dot is a pointer and never
        // a blob big enough to hide the corner it is marking.
        d0.scale.setScalar(mmPerPixel(pts[0]) * DOT_PX);
        d1.scale.setScalar(mmPerPixel(pts[1]) * DOT_PX);
        line.visible = !!shot;
        d1.visible = !!shot;
      }
      if (shot) {
        var s = CORE.span([pts[0].x, pts[0].y, pts[0].z], [pts[1].x, pts[1].y, pts[1].z]);
        var chip = ensureLabel();
        chip.textContent = CORE.formatMm(s.length);
        chip.hidden = false;
        placeLabel(chip, pts[0].clone().add(pts[1]).multiplyScalar(0.5));
      } else {
        hideLabel();
      }
      tick();
    });
  }

  // The chip rides the midpoint of the line, in page coordinates.
  function placeLabel(chip, mid) {
    var dom = state.renderer && state.renderer.domElement;
    var host = chip.offsetParent || document.querySelector('.viewport-section');
    if (!dom || !host) return;
    var v = mid.clone().project(state.camera);
    var r = dom.getBoundingClientRect(), h = host.getBoundingClientRect();
    var x = (v.x * 0.5 + 0.5) * r.width + (r.left - h.left);
    var y = (-v.y * 0.5 + 0.5) * r.height + (r.top - h.top);
    chip.style.left = Math.round(x) + 'px';
    chip.style.top = Math.round(y) + 'px';
    chip.hidden = v.z > 1;   // behind the camera
  }

  /* ---- mode ---- */

  function setLabelState() {
    var btn = el('btn-measure');
    if (!btn) return;
    btn.classList.toggle('is-armed', !!state.measureOn);
    // Paint, Carve and Check piece all carry aria-pressed on their mode
    // buttons; this is the fourth of them and says the same thing.
    btn.setAttribute('aria-pressed', state.measureOn ? 'true' : 'false');
    btn.textContent = state.measureOn ? LIVE_LABEL : IDLE_LABEL;
  }

  /* One picking mode at a time. Paint (either list), Carve, the Soften pick
     and the Cap pick all own a click that lands on a piece, and app-core asks
     them in a fixed order - so two armed modes do not crash, they just make
     the second one silently dead. Turning them off is better than being the
     one that never fires.

     The two that have a button are turned off THROUGH the button, not by
     writing their state flag: the button carries aria-pressed and the armed
     class, and a flag set behind its back leaves a lit button that does
     nothing. state.maskPaint is false | 'exclude' | 'select' since the paint
     grew its target list, so the click has to go to whichever of the two
     paint buttons is actually live - clicking the other one would SWITCH
     paint modes rather than stop it. */
  function disarmOthers() {
    if (state.maskPaint) {
      var paintBtn = el(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (state.carveArmed) {
      var carveBtn = el('btn-carve');
      if (carveBtn) carveBtn.click();
      else state.carveArmed = false;
    }
    if (state.centerLockArmed) {
      var clockBtn = el('btn-center-lock-pick');
      if (clockBtn) clockBtn.click();
      else state.centerLockArmed = false;
    }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      var brushBtn = el('btn-brush');
      if (brushBtn) brushBtn.click();
      else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (state.seatHereArmed) {
      var seatBtn = el('btn-seat-here');
      if (seatBtn) seatBtn.click();
      else state.seatHereArmed = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    if (typeof clearFacePick === 'function') clearFacePick();
  }

  function enter() {
    state.measureOn = true;
    disarmOthers();
    setLabelState();
    setStatus(mode() === 'edge'
      ? 'Measure - click an edge to read its length. Click Measure again to stop.'
      : 'Measure - click two points. Corners and edges snap. Click Measure again to stop.');
  }

  function leave() {
    state.measureOn = false;
    clearShot(null);
    setLabelState();
    setStatus('Measure off');
  }

  function toggle() { if (state.measureOn) leave(); else enter(); }

  /* app-core's onCanvasPointerDown asks this before it starts a move drag -
     the same contract app-mask.js's nsoMaskTakesClick has, for the same
     reason. Only a click this tool would really take is claimed, so orbiting
     the plate while measuring still works. */
  window.nsoMeasureTakesClick = function (event) {
    if (!state.measureOn || !event || event.button !== 0) return false;
    return !!hitPiece(event);
  };

  // What the readout says, as data. The UI reads it for the chip; the test
  // suite reads it to check a number against a fixture's known size.
  window.nsoMeasureReadout = function () {
    if (!shot) return null;
    var pts = endpoints();
    if (!pts) return null;
    var s = CORE.span([pts[0].x, pts[0].y, pts[0].z], [pts[1].x, pts[1].y, pts[1].z]);
    return {
      type: shot.type,
      mm: s.length,
      dx: s.dx, dy: s.dy, dz: s.dz,
      // Where the two ends are right now, in world mm. Re-read every call,
      // never cached, so a piece that has been nudged since the click reports
      // where it actually is.
      a: [pts[0].x, pts[0].y, pts[0].z],
      b: [pts[1].x, pts[1].y, pts[1].z],
      kinds: [shot.a.kind, shot.b.kind],
      segments: shot.segments || 1,
      text: CORE.formatMm(s.length),
      status: describe()
    };
  };

  window.nsoMeasureClear = function () { clearShot(null); };

  function onDown(event) {
    if (!state.measureOn || event.button !== 0) return;
    var pick = hitPiece(event);
    if (!pick) return;
    event.stopPropagation();
    event.preventDefault();
    if (mode() === 'edge') takeEdge(pick); else takeSpan(pick);
  }

  function bind() {
    var btn = el('btn-measure');
    if (btn && !btn._measureBound) {
      btn.addEventListener('click', toggle);
      btn._measureBound = true;
      btn.dataset.nsoWired = '1';
    }
    var sel = el('sel-measure-mode');
    if (sel && !sel._measureBound) {
      sel.addEventListener('change', function () {
        clearShot(null);
        if (state.measureOn) enter();
      });
      sel._measureBound = true;
    }
    if (!document._measureKeys) {
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && state.measureOn) { clearShot('Measure cleared'); }
      });
      document._measureKeys = true;
    }
    if (!state.renderer || !state.renderer.domElement || state._measureBound) return;
    state._measureBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(function () { bind(); setLabelState(); }, 0);
})();
