/* Face exclude paint. Runs after the boolean; Soften, the wrap replay and
   Align all read the same set.

   A face is stored as a PLANE in the piece's own raw space, never as a list
   of triangles. Triangle marks do not survive anything: a bake and a boolean
   both hand back a freshly triangulated mesh, and marks keyed on centroids
   would land on nothing. A plane survives all of it, and it is what the wrap,
   the per-face soften and Align already reason about. It is also what keeps a
   pocket wall separate from the outer shell it is parallel to - same normal,
   different offset, so the two never merge into one blob.

   The display mesh is the raw soup rotated -90deg about X and then centred,
   so raw <-> local is fixed apart from that centring, and the centring is
   measured off the piece itself rather than assumed - a piece that came back
   from a boolean was rebuilt from its own display geometry, and one that came
   from a bake was not. */
(function () {
  const N_TOL = 0.02;   // normals this close count as the same face
  const D_TOL = 0.05;   // mm, plane offsets this close count as the same face

  function activeModel() {
    return (typeof getActiveModel === 'function') ? getActiveModel() : null;
  }
  function maskOf(m) {
    if (!m) return null;
    if (!m.faceMask || !Array.isArray(m.faceMask.exclude)) m.faceMask = { exclude: [] };
    return m.faceMask;
  }

  /* raw -> local display, measured off this piece so it holds for both a
     baked mesh and one rebuilt by the kernel. */
  function frameOf(m) {
    if (!m || !m.rawTris || !m.rawTris.length) return null;
    const r = m.rawTris;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < r.length; i += 3) {
      const d = [r[i], r[i + 2], -r[i + 1]];   // the -90deg X rotation
      for (let k = 0; k < 3; k++) {
        if (d[k] < lo[k]) lo[k] = d[k];
        if (d[k] > hi[k]) hi[k] = d[k];
      }
    }
    return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
  }
  function rawPointFromLocal(f, p) {
    const d = [p[0] + f.c[0], p[1] + f.c[1], p[2] + f.c[2]];
    return [d[0], -d[2], d[1]];
  }
  function rawDirFromLocal(v) { return [v[0], -v[2], v[1]]; }
  function localPointFromRaw(f, p) {
    return [p[0] - f.c[0], p[2] - f.c[1], -p[1] - f.c[2]];
  }
  function localDirFromRaw(v) { return [v[0], v[2], -v[1]]; }

  function samePlane(a, b) {
    return Math.abs(a.n[0] - b.n[0]) < N_TOL && Math.abs(a.n[1] - b.n[1]) < N_TOL &&
           Math.abs(a.n[2] - b.n[2]) < N_TOL && Math.abs(a.d - b.d) < D_TOL;
  }
  function indexOfPlane(mask, pl) {
    for (let i = 0; i < mask.exclude.length; i++) if (samePlane(mask.exclude[i], pl)) return i;
    return -1;
  }

  /* ---- what everything downstream asks ---- */

  // A raw-space plane: outward unit normal n, offset d (n . p = d).
  window.nsoMaskIsExcludedRaw = function (m, n, d) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude || !mask.exclude.length) return false;
    return indexOfPlane(mask, { n: n, d: d }) >= 0;
  };
  // The face a Soften pick names: the outer plane on rawAxisIdx, min side if
  // rawKeepMin, max side otherwise.
  window.nsoMaskIsExcludedPick = function (m, rawAxisIdx, rawKeepMin, rawPlane) {
    if (rawAxisIdx == null || rawPlane == null) return false;
    const n = [0, 0, 0];
    n[rawAxisIdx] = rawKeepMin ? -1 : 1;
    return window.nsoMaskIsExcludedRaw(m, n, rawKeepMin ? -rawPlane : rawPlane);
  };
  // A wall Align found, given in world space on the piece's own mesh.
  window.nsoMaskIsExcludedWorld = function (m, mesh, wn, wp) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude || !mask.exclude.length) return false;
    const f = frameOf(m);
    if (!f || !mesh) return false;
    mesh.updateMatrixWorld(true);
    const e = mesh.matrixWorld.elements;
    // rigid placement: local = world - translation (no rotation is applied to
    // placed pieces, and a rotated one simply will not match, which is safe)
    const lp = [wp[0] - e[12], wp[1] - e[13], wp[2] - e[14]];
    const rp = rawPointFromLocal(f, lp);
    const rn = rawDirFromLocal(wn);
    return window.nsoMaskIsExcludedRaw(m, rn, rn[0] * rp[0] + rn[1] * rp[1] + rn[2] * rp[2]);
  };
  window.nsoMaskCount = function (m) {
    return (m && m.faceMask && m.faceMask.exclude) ? m.faceMask.exclude.length : 0;
  };
  window.nsoMaskSnapshot = function (m) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude) return null;
    return mask.exclude.map(function (p) { return { n: p.n.slice(), d: p.d }; });
  };
  window.nsoMaskRestore = function (m, snap) {
    if (!m) return;
    m.faceMask = { exclude: snap ? snap.map(function (p) { return { n: p.n.slice(), d: p.d }; }) : [] };
    repaint();
    if (typeof window.nsoMaskHudRefresh === 'function') window.nsoMaskHudRefresh();
  };

  /* ---- picking a face ---- */

  // The plane under the cursor, in raw space, plus the display triangles that
  // sit on it. Coplanar AND connected, so a pocket floor never joins up with
  // a parallel patch somewhere else on the piece.
  function faceUnderCursor(m, mesh, hit) {
    const geo = mesh.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos || hit.faceIndex == null) return null;
    const nTri = (pos.count / 3) | 0;
    const P = function (t, v) {
      const i = t * 3 + v;
      return [pos.getX(i), pos.getY(i), pos.getZ(i)];
    };
    const nrm = function (t) {
      const a = P(t, 0), b = P(t, 1), c = P(t, 2);
      const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
      const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
      const x = uy*vz - uz*vy, y = uz*vx - ux*vz, z = ux*vy - uy*vx;
      const L = Math.hypot(x, y, z);
      return L > 1e-12 ? [x/L, y/L, z/L] : null;
    };
    const seed = hit.faceIndex;
    if (seed < 0 || seed >= nTri) return null;
    const n0 = nrm(seed);
    if (!n0) return null;
    const a0 = P(seed, 0);
    const d0 = n0[0]*a0[0] + n0[1]*a0[1] + n0[2]*a0[2];
    // vertex -> triangles, so the flood can only cross a shared corner
    const Q = 1e4, vmap = new Map();
    const vk = function (p) { return Math.round(p[0]*Q)+'|'+Math.round(p[1]*Q)+'|'+Math.round(p[2]*Q); };
    const flat = [];
    for (let t = 0; t < nTri; t++) {
      const n = nrm(t);
      if (!n || n[0]*n0[0] + n[1]*n0[1] + n[2]*n0[2] < 0.999) continue;
      const a = P(t, 0);
      if (Math.abs(n0[0]*a[0] + n0[1]*a[1] + n0[2]*a[2] - d0) > D_TOL) continue;
      flat.push(t);
      for (let v = 0; v < 3; v++) {
        const k = vk(P(t, v));
        if (!vmap.has(k)) vmap.set(k, []);
        vmap.get(k).push(t);
      }
    }
    if (!flat.length) return null;
    const keep = new Set(), stack = [seed];
    while (stack.length) {
      const t = stack.pop();
      if (keep.has(t)) continue;
      keep.add(t);
      for (let v = 0; v < 3; v++) {
        const nb = vmap.get(vk(P(t, v)));
        if (!nb) continue;
        for (let i = 0; i < nb.length; i++) if (!keep.has(nb[i])) stack.push(nb[i]);
      }
    }
    const f = frameOf(m);
    if (!f) return null;
    const rn = rawDirFromLocal(n0);
    const rp = rawPointFromLocal(f, a0);
    return {
      plane: { n: rn, d: rn[0]*rp[0] + rn[1]*rp[1] + rn[2]*rp[2] },
      tris: keep
    };
  }

  /* ---- the yellow over every excluded face ---- */

  let overlay = null;
  function clearOverlay() {
    if (overlay && overlay.parent) overlay.parent.remove(overlay);
    if (overlay && overlay.geometry) overlay.geometry.dispose();
    if (overlay && overlay.material) overlay.material.dispose();
    overlay = null;
  }
  function repaint() {
    clearOverlay();
    const m = activeModel();
    const mask = m && m.faceMask;
    if (!m || !mask || !mask.exclude.length) return;
    const placed = state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; });
    if (!placed) return;
    const f = frameOf(m);
    const geo = placed.mesh.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos || !f) return;
    const verts = [];
    const nTri = (pos.count / 3) | 0;
    /* The paint sits a hair proud of the face it marks. Coincident with it
       the depth buffer cannot separate the two and the yellow comes out
       mottled or gone; lifted along the face normal it wins cleanly, and
       because it still respects depth a face painted on the far side stays
       behind the solid instead of floating over the front of it. Scaled to
       the piece so a 200mm plate and a 5mm chip both get a lift that reads
       as nothing. */
    let plo = [Infinity, Infinity, Infinity], phi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < pos.count; v++) {
      const q = [pos.getX(v), pos.getY(v), pos.getZ(v)];
      for (let k = 0; k < 3; k++) {
        if (q[k] < plo[k]) plo[k] = q[k];
        if (q[k] > phi[k]) phi[k] = q[k];
      }
    }
    const lift = Math.max(0.01, 0.0015 * Math.hypot(phi[0]-plo[0], phi[1]-plo[1], phi[2]-plo[2]));
    for (let t = 0; t < nTri; t++) {
      const A = [pos.getX(t*3), pos.getY(t*3), pos.getZ(t*3)];
      const B = [pos.getX(t*3+1), pos.getY(t*3+1), pos.getZ(t*3+1)];
      const C = [pos.getX(t*3+2), pos.getY(t*3+2), pos.getZ(t*3+2)];
      const ux=B[0]-A[0], uy=B[1]-A[1], uz=B[2]-A[2];
      const vx=C[0]-A[0], vy=C[1]-A[1], vz=C[2]-A[2];
      let x=uy*vz-uz*vy, y=uz*vx-ux*vz, z=ux*vy-uy*vx;
      const L = Math.hypot(x,y,z);
      if (!(L > 1e-12)) continue;
      x/=L; y/=L; z/=L;
      const rn = rawDirFromLocal([x,y,z]);
      const rp = rawPointFromLocal(f, A);
      if (!window.nsoMaskIsExcludedRaw(m, rn, rn[0]*rp[0]+rn[1]*rp[1]+rn[2]*rp[2])) continue;
      const lx = x*lift, ly = y*lift, lz = z*lift;
      verts.push(A[0]+lx, A[1]+ly, A[2]+lz,
                 B[0]+lx, B[1]+ly, B[2]+lz,
                 C[0]+lx, C[1]+ly, C[2]+lz);
    }
    if (!verts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    /* Flat, unlit, full strength yellow - no transparency to wash it out and
       no lighting to shade it, so a painted face is the same signal colour
       whichever way the piece is turned and reads across a room. Front side
       only: the paint faces out, the way the face it marks does. */
    overlay = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffdd00, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    }));
    overlay.position.copy(placed.mesh.position);
    overlay.quaternion.copy(placed.mesh.quaternion);
    overlay.scale.copy(placed.mesh.scale);
    overlay.renderOrder = 21;
    if (state.modelGroup) state.modelGroup.add(overlay);
  }
  window.nsoMaskRepaint = repaint;

  /* ---- paint mode ---- */

  /* The HUD line. It reads the HUD tag at rest and gains the running count
     while a paint session is live, so the count is on the same line a photo
     of the HUD already shows. Paint never relabels itself into Done - it
     stays Paint faces and just lights up; Done is its own button. */
  const HUD_TAG = 'HUD mask4';
  function hud(text) {
    const el = document.getElementById('adjust-status');
    if (el) el.textContent = text;
  }
  function hudPaint() {
    const n = window.nsoMaskCount(activeModel());
    hud(HUD_TAG + ' \u2014 ' + n + (n === 1 ? ' face excluded' : ' faces excluded'));
  }
  /* Done is a state on this button, not a row of its own: Paint faces while
     idle, and while a session is live it says so and how to stop. */
  const PAINT_IDLE = 'Paint faces';
  const PAINT_LIVE = 'Painting\u2026 click to stop';
  function setLabel() {
    const btn = document.getElementById('btn-mask-paint');
    if (!btn) return;
    btn.classList.toggle('is-armed', !!state.maskPaint);
    btn.textContent = state.maskPaint ? PAINT_LIVE : PAINT_IDLE;
  }
  function enterPaint() {
    const m = activeModel();
    if (!m || !m.rawTris) {
      setStatus('Paint needs a raw piece - split, wrap or boolean it first', true);
      return;
    }
    state.maskPaint = true;
    state.softenArmed = false;
    state.capArmed = false;
    if (typeof clearFacePick === 'function') clearFacePick();
    repaint();
    setLabel();
    hudPaint();
    setStatus('Paint faces - click a face to exclude it, click again to include. Done when finished');
  }
  function exitPaint() {
    state.maskPaint = false;
    setLabel();
    hud(HUD_TAG);
    setStatus('Paint off - ' + window.nsoMaskCount(activeModel()) + ' face(s) excluded');
  }
  function togglePaint() {
    if (state.maskPaint) exitPaint(); else enterPaint();
  }
  window.nsoMaskHudRefresh = function () {
    if (state.maskPaint) hudPaint(); else hud(HUD_TAG);
  };

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

  // Toggle the face under the cursor. Nothing here moves the piece, and a
  // pick that resolves to no face leaves both the mesh and the paint alone.
  window.nsoMaskToggleAt = function (m, mesh, hit) {
    if (!m || !m.rawTris) {
      setStatus('Paint needs a raw piece - split, wrap or boolean it first', true);
      return false;
    }
    const face = faceUnderCursor(m, mesh, hit);
    if (!face) {
      setStatus('No face under that click - nothing changed', true);
      return false;
    }
    const mask = maskOf(m);
    const prev = window.nsoMaskSnapshot(m);
    const at = indexOfPlane(mask, face.plane);
    if (at >= 0) mask.exclude.splice(at, 1);
    else mask.exclude.push(face.plane);
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'maskReplace', modelId: m.id, prevMask: prev });
    }
    repaint();
    window.nsoMaskHudRefresh();
    setStatus((at >= 0 ? 'Included' : 'Excluded') + ' that face (' + face.tris.size +
              ' tris) - ' + mask.exclude.length + ' face(s) excluded');
    return true;
  };

  function bind() {
    const btn = document.getElementById('btn-mask-paint');
    if (btn && !btn._maskBound) { btn.addEventListener('click', togglePaint); btn._maskBound = true; }
    const clr = document.getElementById('btn-mask-clear');
    if (clr && !clr._maskBound) {
      clr.addEventListener('click', function () {
        const m = activeModel();
        if (!m) return;
        const prev = window.nsoMaskSnapshot(m);
        if (typeof pushUndo === 'function') pushUndo({ type: 'maskReplace', modelId: m.id, prevMask: prev });
        m.faceMask = { exclude: [] };
        repaint();
        window.nsoMaskHudRefresh();
        setStatus('Paint cleared - 0 faces excluded');
      });
      clr._maskBound = true;
    }
    if (!state.renderer || !state.renderer.domElement || state._maskBound) return;
    state._maskBound = true;
    state.renderer.domElement.addEventListener('pointerdown', function (event) {
      if (!state.maskPaint || event.button !== 0) return;
      const hit = hitFace(event);
      if (!hit) return;
      event.stopPropagation();
      event.preventDefault();
      let obj = hit.object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx !== 'number' || !state.placed[idx]) return;
      const placed = state.placed[idx];
      const m = state.models.find(function (mm) { return mm.id === placed.sourceId; });
      window.nsoMaskToggleAt(m, placed.mesh, hit);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(function () { bind(); setLabel(); }, 0);
})();
