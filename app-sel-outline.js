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

  /* A BIG PIECE's outline is made by nso_edges.js in a worker. three's
     EdgesGeometry takes 5.4 s of the page's thread at 947,000 triangles, and
     refreshOutline runs on every selection, To plate, cutter opening and pose
     change. The piece is selected at once; the white edge appears when the
     worker has it (a second or two) and is kept per geometry version, so the
     next refresh of the same piece is immediate. */
  const bigEdges = new WeakMap();       // geometry -> { arr, version, count, edges }
  const bigJobs = new WeakMap();        // placed entry -> the running job
  function isBig(g) {
    const pos = g && g.attributes && g.attributes.position;
    return !!(pos && !g.index && window.NSO_BVH && window.NSO_BVH.isBig(pos.count / 3) &&
              window.NSO_Work && window.NSO_Work.isAvailable() && window.NSO_Edges);
  }
  function drawOutline(p, edges) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(edges, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, depthTest: false, depthWrite: false,
      transparent: true, opacity: 1
    });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 12;
    line.name = 'selOutline';
    line.raycast = function () {};
    p.mesh.add(line);
    p.outline = line;
  }
  function refreshBigOutline(p) {
    const g = p.mesh.geometry, pos = g.attributes.position;
    const hit = bigEdges.get(g);
    if (hit && hit.arr === pos.array && hit.version === pos.version && hit.count === pos.count) {
      drawOutline(p, hit.edges);
      return;
    }
    const old = bigJobs.get(p);
    if (old) old.cancel();
    const job = window.NSO_Work.run('edges', ['nso_edges.js'], 'NSO_Edges.edgesOfTransfer', [pos.array, 15]);
    bigJobs.set(p, job);
    const arr = pos.array, version = pos.version, count = pos.count;
    job.promise.then(function (edges) {
      if (bigJobs.get(p) !== job) return;
      bigJobs.delete(p);
      const now = p.mesh && p.mesh.geometry && p.mesh.geometry.attributes.position;
      if (!now || p.mesh.geometry !== g || now.array !== arr || now.version !== version) return;
      bigEdges.set(g, { arr: arr, version: version, count: count, edges: edges });
      if (state.placed[state.selectedIndex] === p && !p.outline) drawOutline(p, edges);
    }, function (err) { console.warn('refreshOutline', err); });
  }

  window.refreshOutline = function refreshOutline(p) {
    if (!p) return;
    stripOutline(p);
    if (!p.mesh || !p.mesh.geometry) return;
    if (!state || state.placed[state.selectedIndex] !== p) return;
    if (isBig(p.mesh.geometry)) { refreshBigOutline(p); return; }
    try {
      const edges = new THREE.EdgesGeometry(p.mesh.geometry, 15);
      // depthWrite off: with depthTest already off these lines pass every
      // depth check, so writing depth would leave a hidden edge's z sitting
      // in front of the face it crosses and reject whatever is drawn after
      // it - which is how this outline was cutting holes in the paint.
      const mat = new THREE.LineBasicMaterial({
        color: 0xffffff, depthTest: false, depthWrite: false,
        transparent: true, opacity: 1
      });
      const line = new THREE.LineSegments(edges, mat);
      line.renderOrder = 12;
      line.name = 'selOutline';
      line.raycast = function () {};
      p.mesh.add(line);
      p.outline = line;
    } catch (e) {
      console.warn('refreshOutline', e);
    }
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
