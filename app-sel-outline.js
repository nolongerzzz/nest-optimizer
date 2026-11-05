/* Selected-piece white edge overlay + Soften reapply-from-source. After app-core.js. */
(function () {
  const prevUpdatePlate = window.updatePlateInfo;
  window.updatePlateInfo = function () {
    if (!document.getElementById('plate-dims') && !document.getElementById('plate-area')) return;
    if (typeof prevUpdatePlate === 'function') {
      try { prevUpdatePlate(); } catch (e) { console.warn('updatePlateInfo', e); }
    }
  };

  function stripOutline(p) {
    if (!p || !p.outline) return;
    if (p.mesh) p.mesh.remove(p.outline);
    if (p.outline.geometry) p.outline.geometry.dispose();
    if (p.outline.material) p.outline.material.dispose();
    p.outline = null;
  }

  /* THE OUTLINE IS A THING OF THE GEOMETRY, NOT OF THE POSE.
     The white edge is EdgesGeometry(geometry, 15), in the mesh's own frame, a child of the mesh. On a 191,000-triangle
     piece building it is 0.8 - 1.8 s of the page's thread, and it used to be built again for every select, yaw, tip,
     tilt, Undo and Redo - twice in a pose op (the bake's own refresh, then the verb's) - and on every move of a Rotate
     ring drag. None of those changes the edges; a turn only moves them. So:

       1. The edge set is kept PER GEOMETRY (edgeCache), keyed the way nso-bounds.js keys a box: the geometry, its
          position array, that attribute's version and size. Selecting a piece again is a lookup.
       2. A turn that is baked into the geometry (nsoBakePlacedPose, and its Undo and Redo) hands the edges to the new
          geometry with the very matrix it applied to the vertices (nsoOutlineCarry): nothing is rebuilt.
       3. refreshOutline does nothing when the outline on the piece is already the geometry's - which is every call
          that follows a move, a lift, a pose in hand or a second ask for the same thing. "Exactly one update per op"
          is that, not a count each caller keeps.
       4. A piece of OUTLINE_WORKER_TRIS (50,000) triangles or more is built in a worker (nso_edges.js, the bit-for-bit
          copy of three's loop); the piece is selected at once and the edge appears when the worker answers. A job for
          the geometry already running is not started twice, and an answer is kept even if the piece has moved on, so
          the Undo that goes back to it finds it. The threshold is the outline's own: NSO_BVH.BIG_TRIS (300,000) is
          the BVH's and is not touched. */
  const OUTLINE_WORKER_TRIS = 50000;
  let edgeCache = new WeakMap();        // geometry -> { arr, version, count, edges }
  const jobs = new WeakMap();           // placed entry -> { uuid, arr, version, job }

  function positionOf(g) { return g && g.attributes && g.attributes.position; }
  function cacheGet(g) {
    const pos = positionOf(g), hit = pos && edgeCache.get(g);
    return (hit && hit.arr === pos.array && hit.version === pos.version && hit.count === pos.count) ? hit.edges : null;
  }
  function cachePut(g, edges) {
    const pos = positionOf(g);
    if (pos) edgeCache.set(g, { arr: pos.array, version: pos.version, count: pos.count, edges: edges });
  }
  /* The outline on screen is this geometry's (only plain values on it: it is scanned for geometries it names). */
  function isFor(line, g) {
    const k = line && line.userData && line.userData.nsoEdgesOf, pos = positionOf(g);
    return !!(k && pos && k.uuid === g.uuid && k.arr === pos.array && k.version === pos.version && k.count === pos.count);
  }
  function selected(p) { return typeof state !== 'undefined' && !!state && !!state.placed && state.placed[state.selectedIndex] === p; }

  /* true when this geometry's edges go to the worker: the outline's own threshold, or (`now`: a caller that wants the
     line on screen before it returns - the Supports card lighting every piece) the old rule, the BVH's big piece */
  function useWorker(g, now) {
    const pos = positionOf(g);
    if (!pos || g.index) return false;
    if (!(window.NSO_Work && window.NSO_Edges && window.NSO_Work.canRun(['nso_edges.js']))) return false;
    const tris = pos.count / 3;
    return tris >= (now ? (window.NSO_BVH ? window.NSO_BVH.BIG_TRIS : Infinity) : OUTLINE_WORKER_TRIS);
  }

  function drawOutline(p, g, edges) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(edges, 3));
    // depthWrite off: with depthTest already off these lines pass every
    // depth check, so writing depth would leave a hidden edge's z sitting
    // in front of the face it crosses and reject whatever is drawn after
    // it - which is how this outline was cutting holes in the paint.
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, depthTest: false, depthWrite: false,
      transparent: true, opacity: 1
    });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 12;
    line.name = 'selOutline';
    line.raycast = function () {};
    const pos = positionOf(g);
    line.userData.nsoEdgesOf = { uuid: g.uuid, arr: pos.array, version: pos.version, count: pos.count };
    p.mesh.add(line);
    p.outline = line;
  }

  function buildHere(g) {
    const eg = new THREE.EdgesGeometry(g, 15);
    const edges = eg.attributes.position.array;
    eg.dispose();
    cachePut(g, edges);
    return edges;
  }

  function buildInWorker(p, g) {
    const pos = positionOf(g), arr = pos.array, version = pos.version;
    const live = jobs.get(p);
    if (live && live.uuid === g.uuid && live.arr === arr && live.version === version) return;   // already on its way
    if (live) live.job.cancel();
    const job = window.NSO_Work.run('edges', ['nso_edges.js'], 'NSO_Edges.edgesOfTransfer', [arr, 15]);
    const rec = { uuid: g.uuid, arr: arr, version: version, job: job };
    jobs.set(p, rec);
    function stillMine() {
      const now = positionOf(g);
      return !!now && now.array === arr && now.version === version;
    }
    function show(edges) {
      if (p.mesh && p.mesh.geometry === g && selected(p) && !p.outline && stillMine()) drawOutline(p, g, edges);
    }
    job.promise.then(function (edges) {
      if (jobs.get(p) === rec) jobs.delete(p);
      if (stillMine()) cachePut(g, edges);              // kept even if the piece has moved on: Undo finds it
      show(edges);
    }, function (err) {
      if (jobs.get(p) === rec) jobs.delete(p);
      console.warn('refreshOutline: the worker failed, building here', err);
      try { if (stillMine() && p.mesh && p.mesh.geometry === g && selected(p) && !p.outline) show(cacheGet(g) || buildHere(g)); }
      catch (e) { console.warn('refreshOutline', e); }
    });
  }

  window.refreshOutline = function refreshOutline(p, opts) {
    if (!p) return;
    const g = p.mesh && p.mesh.geometry;
    if (!g || !positionOf(g)) { stripOutline(p); return; }
    if (!selected(p)) { stripOutline(p); return; }
    if (p.outline && p.outline.parent === p.mesh && isFor(p.outline, g)) return;       // already this geometry's
    stripOutline(p);
    try {
      let edges = cacheGet(g);
      if (!edges) {
        if (useWorker(g, opts && opts.now)) { buildInWorker(p, g); return; }
        edges = buildHere(g);
      }
      drawOutline(p, g, edges);
    } catch (e) {
      console.warn('refreshOutline', e);
    }
  };

  /* A pose bake moved a piece's vertices by `m` (a 4 x 4, column-major, v -> M v): hand its edges to `toGeo`, the
     geometry it is about to put on the piece, the same way. Called by nsoBakePlacedPose (with the bake's matrix), by
     Undo (with its inverse) and by Redo, while the piece still wears the geometry the edges are of. The source is the
     geometry's kept edge set, or the outline on screen when that is what there is. Not done when the target already
     has an edge set, or when the matrix does not take the one geometry to the other: a sample of vertices is held
     against `toGeo`'s own, and an edit that really changed the shape is built, not carried. */
  window.nsoOutlineCarry = function nsoOutlineCarry(p, toGeo, m) {
    const from = p && p.mesh && p.mesh.geometry, fp = positionOf(from), tp = positionOf(toGeo);
    if (!fp || !tp || from === toGeo || fp.count !== tp.count || !m) return false;
    if (cacheGet(toGeo)) return true;
    let src = cacheGet(from);
    if (!src && p.outline && isFor(p.outline, from)) src = p.outline.geometry.attributes.position.array;
    if (!src || !src.length) return false;
    const a = fp.array, b = tp.array, n = fp.count;
    const e = m.elements || m;
    const x = i => e[0] * a[i] + e[4] * a[i + 1] + e[8] * a[i + 2] + e[12];
    const y = i => e[1] * a[i] + e[5] * a[i + 1] + e[9] * a[i + 2] + e[13];
    const z = i => e[2] * a[i] + e[6] * a[i + 1] + e[10] * a[i + 2] + e[14];
    for (let k = 0; k < 24; k++) {
      const i = Math.floor(k * (n - 1) / 23) * 3;
      if (Math.abs(x(i) - b[i]) > 1e-3 || Math.abs(y(i) - b[i + 1]) > 1e-3 || Math.abs(z(i) - b[i + 2]) > 1e-3) return false;
    }
    const out = new Float32Array(src.length);
    const e0 = e[0], e1 = e[1], e2 = e[2], e4 = e[4], e5 = e[5], e6 = e[6], e8 = e[8], e9 = e[9], e10 = e[10],
          e12 = e[12], e13 = e[13], e14 = e[14];
    for (let i = 0; i < src.length; i += 3) {
      const sx = src[i], sy = src[i + 1], sz = src[i + 2];
      out[i] = e0 * sx + e4 * sy + e8 * sz + e12;
      out[i + 1] = e1 * sx + e5 * sy + e9 * sz + e13;
      out[i + 2] = e2 * sx + e6 * sy + e10 * sz + e14;
    }
    cachePut(toGeo, out);
    return true;
  };

  /* For the checks: the kept edge sets and the worker threshold. */
  window.NSO_Outline = {
    WORKER_TRIS: OUTLINE_WORKER_TRIS,
    cached: function (g) { return !!cacheGet(g); },
    forgetAll: function () { edgeCache = new WeakMap(); }
  };

  const prevSelect = window.selectPlaced;
  window.selectPlaced = function (idx) {
    if (typeof prevSelect === 'function') prevSelect(idx);
    const p = state && state.placed && state.placed[idx];
    if (p) window.refreshOutline(p);
    // Selecting writes its own line into #adjust-status, which is where the
    // paint keeps its running count. Put the count back, so the number on
    // screen is the length of the skip list and not whatever was clicked
    // last.
    if (typeof window.nsoMaskHudRefresh === 'function') window.nsoMaskHudRefresh();
  };

  function copyRaw(src) {
    if (!src) return null;
    return (typeof src.slice === 'function') ? src.slice() : new Float32Array(src);
  }

  function captureSoftenBase(m) {
    if (!m || !m.rawTris || m.softenBaseRaw) return;
    m.softenBaseRaw = copyRaw(m.rawTris);
    m.softenBaseAxis = m.rawAxis || 'zup';
    m.softenBaseOffset = m.centerOffset;
  }

  function wrapApply() {
    if (typeof window.applySoftenOnFace !== 'function') return;
    if (window.applySoftenOnFace._reapplyWrapped) return;
    const prevApply = window.applySoftenOnFace;
    window.applySoftenOnFace = function (face) {
      // The finish script owns the Soften base now: it records every clicked
      // face against it and replays the whole list in one bake, so restoring
      // here would throw the earlier faces away on the second click. It still
      // bakes from the base and never stacks mesh on mesh.
      const m = typeof getActiveModel === 'function' ? getActiveModel() : null;
      if (m && m.rawTris && !m.softenRun) captureSoftenBase(m);
      return prevApply(face);
    };
    window.applySoftenOnFace._reapplyWrapped = true;
  }

  wrapApply();
  document.addEventListener('DOMContentLoaded', wrapApply);
  setTimeout(wrapApply, 0);
})();
