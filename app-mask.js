/* Face include / exclude paint — runs AFTER boolean, before Soften.
   Mask lives on the library model. Soften reads nsoMaskScaleAtRaw. */
(function () {
  const ANGLE_COS = Math.cos(28 * Math.PI / 180);
  const KEY_Q = 200;

  function activeModel() {
    if (typeof getActiveModel === 'function') return getActiveModel();
    return null;
  }

  function ensureMask(m) {
    if (!m.faceMask) m.faceMask = { include: new Set(), exclude: new Set() };
    return m.faceMask;
  }

  function triKeyFromSoup(soup, t) {
    const i0 = t * 9;
    if (i0 + 8 >= soup.length) return null;
    const cx = (soup[i0] + soup[i0 + 3] + soup[i0 + 6]) / 3;
    const cy = (soup[i0 + 1] + soup[i0 + 4] + soup[i0 + 7]) / 3;
    const cz = (soup[i0 + 2] + soup[i0 + 5] + soup[i0 + 8]) / 3;
    return Math.round(cx * KEY_Q) + ':' + Math.round(cy * KEY_Q) + ':' + Math.round(cz * KEY_Q);
  }

  function buildAdj(geo) {
    const pos = geo.index ? null : geo.attributes.position;
    if (!pos) return { count: 0, adj: [], normals: [] };
    const count = (pos.count / 3) | 0;
    const normals = [];
    const edge = new Map();
    function ek(a, b) {
      const ka = Math.round(a.x * KEY_Q) + ',' + Math.round(a.y * KEY_Q) + ',' + Math.round(a.z * KEY_Q);
      const kb = Math.round(b.x * KEY_Q) + ',' + Math.round(b.y * KEY_Q) + ',' + Math.round(b.z * KEY_Q);
      return ka < kb ? ka + '~' + kb : kb + '~' + ka;
    }
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < count; t++) {
      va.fromBufferAttribute(pos, t * 3);
      vb.fromBufferAttribute(pos, t * 3 + 1);
      vc.fromBufferAttribute(pos, t * 3 + 2);
      ab.subVectors(vb, va);
      ac.subVectors(vc, va);
      n.crossVectors(ab, ac).normalize();
      normals.push(n.clone());
      [[va, vb], [vb, vc], [vc, va]].forEach(function (pair) {
        const k = ek(pair[0], pair[1]);
        if (!edge.has(k)) edge.set(k, []);
        edge.get(k).push(t);
      });
    }
    const adj = Array.from({ length: count }, function () { return []; });
    edge.forEach(function (list) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          adj[list[i]].push(list[j]);
          adj[list[j]].push(list[i]);
        }
      }
    });
    return { count: count, adj: adj, normals: normals };
  }

  function flood(geoCache, seed) {
    const out = new Set();
    if (seed < 0 || seed >= geoCache.count) return out;
    const stack = [seed];
    const n0 = geoCache.normals[seed];
    while (stack.length) {
      const t = stack.pop();
      if (out.has(t)) continue;
      const n = geoCache.normals[t];
      if (n0.dot(n) < ANGLE_COS) continue;
      out.add(t);
      const nbr = geoCache.adj[t];
      for (let i = 0; i < nbr.length; i++) stack.push(nbr[i]);
    }
    return out;
  }

  function rawIndexForDisplayTri(m, faceIndex) {
    if (!m || !m.rawTris) return faceIndex;
    const n = (m.rawTris.length / 9) | 0;
    if (faceIndex >= 0 && faceIndex < n) return faceIndex;
    return faceIndex;
  }

  window.nsoMaskScaleAtRaw = function (m, p) {
    if (!m || !m.faceMask || !m.rawTris || !p) return 1;
    const inc = m.faceMask.include;
    const exc = m.faceMask.exclude;
    if ((!inc || !inc.size) && (!exc || !exc.size)) return 1;
    const soup = m.rawTris;
    const n = (soup.length / 9) | 0;
    const near = [];
    for (let t = 0; t < n; t++) {
      const i0 = t * 9;
      for (let v = 0; v < 3; v++) {
        const dx = soup[i0 + v * 3] - p[0];
        const dy = soup[i0 + v * 3 + 1] - p[1];
        const dz = soup[i0 + v * 3 + 2] - p[2];
        if (dx * dx + dy * dy + dz * dz < 4e-4) {
          near.push(t);
          break;
        }
      }
    }
    if (!near.length) return (inc && inc.size) ? 0 : 1;
    if (exc && exc.size) {
      for (let i = 0; i < near.length; i++) {
        const k = triKeyFromSoup(soup, near[i]);
        if (k && exc.has(k)) return 0;
      }
    }
    if (inc && inc.size) {
      let ok = false;
      for (let i = 0; i < near.length; i++) {
        const k = triKeyFromSoup(soup, near[i]);
        if (k && inc.has(k)) { ok = true; break; }
      }
      if (!ok) return 0;
    }
    return 1;
  };

  let overlay = null;
  function clearOverlay() {
    if (overlay && overlay.parent) overlay.parent.remove(overlay);
    if (overlay && overlay.geometry) overlay.geometry.dispose();
    overlay = null;
  }

  function paintOverlay(mesh, faceSet, color) {
    clearOverlay();
    if (!mesh || !faceSet || !faceSet.size) return;
    const src = mesh.geometry;
    const pos = src.attributes.position;
    if (!pos) return;
    const g = new THREE.BufferGeometry();
    const verts = new Float32Array(faceSet.size * 9);
    let w = 0;
    faceSet.forEach(function (t) {
      for (let v = 0; v < 3; v++) {
        verts[w++] = pos.getX(t * 3 + v);
        verts[w++] = pos.getY(t * 3 + v);
        verts[w++] = pos.getZ(t * 3 + v);
      }
    });
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthTest: false
    });
    overlay = new THREE.Mesh(g, mat);
    overlay.position.copy(mesh.position);
    overlay.quaternion.copy(mesh.quaternion);
    overlay.scale.copy(mesh.scale);
    overlay.renderOrder = 20;
    if (state.modelGroup) state.modelGroup.add(overlay);
  }

  function applyPaint(hit, mode, subtract) {
    const mesh = hit.object;
    let obj = mesh;
    while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
    const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
    if (typeof idx !== 'number' || !state.placed[idx]) return;
    selectPlaced(idx);
    const placed = state.placed[idx];
    const m = state.models.find(function (mm) { return mm.id === placed.sourceId; });
    if (!m || !m.rawTris) {
      if (typeof setStatus === 'function') setStatus('Mask needs a raw piece (post-boolean / split)', true);
      return;
    }
    const faceIndex = hit.faceIndex;
    if (faceIndex == null) return;
    const cache = buildAdj(mesh.geometry);
    const faces = flood(cache, faceIndex);
    const mask = ensureMask(m);
    const target = mode === 'include' ? mask.include : mask.exclude;
    const other = mode === 'include' ? mask.exclude : mask.include;
    faces.forEach(function (t) {
      const rawT = rawIndexForDisplayTri(m, t);
      const k = triKeyFromSoup(m.rawTris, rawT);
      if (!k) return;
      if (subtract) target.delete(k);
      else {
        target.add(k);
        other.delete(k);
      }
    });
    paintOverlay(mesh, faces, mode === 'include' ? 0xf59e0b : 0x38bdf8);
    if (typeof setStatus === 'function') {
      setStatus((mode === 'include' ? 'Include ' : 'Exclude ') +
        faces.size + ' faces · inc ' + mask.include.size + ' · exc ' + mask.exclude.size);
    }
  }

  function hitFace(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].object === overlay) continue;
      if (hits[i].faceIndex == null) continue;
      return hits[i];
    }
    return null;
  }

  function setPaintMode(mode) {
    state.maskPaint = (state.maskPaint === mode) ? null : mode;
    state.softenArmed = false;
    state.capArmed = false;
    const inc = document.getElementById('btn-mask-inc');
    const exc = document.getElementById('btn-mask-exc');
    if (inc) inc.classList.toggle('is-armed', state.maskPaint === 'include');
    if (exc) exc.classList.toggle('is-armed', state.maskPaint === 'exclude');
    if (typeof setStatus === 'function') {
      if (!state.maskPaint) setStatus('Mask paint off');
      else setStatus(state.maskPaint === 'include'
        ? 'Paint INCLUDE — drag the faces to soften'
        : 'Paint EXCLUDE — drag the flange / keep-sharp faces');
    }
  }

  function clearMask() {
    const m = activeModel();
    if (m) m.faceMask = { include: new Set(), exclude: new Set() };
    clearOverlay();
    if (typeof setStatus === 'function') setStatus('Mask cleared');
  }

  function bind() {
    const inc = document.getElementById('btn-mask-inc');
    const exc = document.getElementById('btn-mask-exc');
    const clr = document.getElementById('btn-mask-clear');
    if (inc) inc.addEventListener('click', function () { setPaintMode('include'); });
    if (exc) exc.addEventListener('click', function () { setPaintMode('exclude'); });
    if (clr) clr.addEventListener('click', clearMask);

    if (!state.renderer || !state.renderer.domElement) return;
    const el = state.renderer.domElement;
    el.addEventListener('pointerdown', function (event) {
      if (!state.maskPaint || event.button !== 0) return;
      const hit = hitFace(event);
      if (!hit) return;
      event.stopPropagation();
      event.preventDefault();
      applyPaint(hit, state.maskPaint, event.altKey);
      state._maskDrag = true;
    }, true);
    el.addEventListener('pointermove', function (event) {
      if (!state.maskPaint || !state._maskDrag) return;
      const hit = hitFace(event);
      if (hit) applyPaint(hit, state.maskPaint, event.altKey);
    }, true);
    window.addEventListener('pointerup', function () { state._maskDrag = false; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
