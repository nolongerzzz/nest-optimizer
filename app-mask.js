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
  // Above every helper that draws on the piece: the selected outline (12),
  // the inspect cage (16) and the armed-face highlight (20). The paint is the
  // answer to "which faces did I pick", so nothing is allowed over it.
  const PAINT_RENDER_ORDER = 40;

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
  /* Two entries are the same face when the click that made them named the
     same raw face - axis and side, recorded at the click and never worked
     out again. The plane comparison is the fallback for a recessed wall,
     which has no axis and side to name, and for the bare planes Align asks
     about. */
  function sameFace(a, b) {
    if (a.axisIdx != null && b.axisIdx != null) {
      if (a.axisIdx !== b.axisIdx || !!a.keepMin !== !!b.keepMin) return false;
      // Outer faces are one per axis and side. A pocket has more faces on the
      // same axis and side as the hull, so an inner face is only the same
      // face when it is on the same plane too - that is what keeps a click on
      // a pocket wall off the outer face behind it.
      if (a.inner || b.inner) return Math.abs(a.d - b.d) < D_TOL;
      return true;
    }
    return samePlane(a, b);
  }
  function indexOfPlane(mask, pl) {
    for (let i = 0; i < mask.exclude.length; i++) if (sameFace(mask.exclude[i], pl)) return i;
    return -1;
  }

  /* ---- what everything downstream asks ---- */

  // A raw-space plane: outward unit normal n, offset d (n . p = d).
  window.nsoMaskIsExcludedRaw = function (m, n, d, axisIdx, keepMin, inner) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude || !mask.exclude.length) return false;
    return indexOfPlane(mask, { n: n, d: d,
      axisIdx: (axisIdx == null ? null : axisIdx),
      keepMin: (axisIdx == null ? null : !!keepMin),
      inner: !!inner }) >= 0;
  };
  // The face a Soften pick names: the outer plane on rawAxisIdx, min side if
  // rawKeepMin, max side otherwise.
  window.nsoMaskIsExcludedPick = function (m, rawAxisIdx, rawKeepMin, rawPlane, inner) {
    if (rawAxisIdx == null || rawPlane == null) return false;
    const n = [0, 0, 0];
    n[rawAxisIdx] = rawKeepMin ? -1 : 1;
    return window.nsoMaskIsExcludedRaw(m, n, rawKeepMin ? -rawPlane : rawPlane,
                                       rawAxisIdx, rawKeepMin, inner);
  };
  /* The faces the paint took out, as the raw axis and side each click named:
     [axisIdx][0 for the min side]. Null if any painted face is a recessed
     wall, which has no axis and side and is not a face the whole-solid wrap
     can name. Nothing here derives anything - it reads back what the click
     recorded. */
  window.nsoMaskFaces = function (m) {
    const mask = m && m.faceMask;
    const sq = [[false,false],[false,false],[false,false]];
    if (!mask || !mask.exclude || !mask.exclude.length) return sq;
    for (let i = 0; i < mask.exclude.length; i++) {
      const e = mask.exclude[i];
      if (e.axisIdx == null || e.inner) return null;
      sq[e.axisIdx][e.keepMin ? 0 : 1] = true;
    }
    return sq;
  };
  /* Every painted face as the click recorded it: the raw axis, the side its
     normal points to, the plane it sits on, and whether it is a face inside
     the piece rather than one of the outer six. This is the whole skip list -
     a hull face and a pocket wall are the same kind of thing here, and the
     wrap decides which is which by where the plane is, not by a second guess
     at what the user meant. Null if any painted face has no axis and side to
     name, which is the caller's cue to leave the wrap alone. */
  window.nsoMaskFaceList = function (m) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude) return [];
    const out = [];
    for (let i = 0; i < mask.exclude.length; i++) {
      const e = mask.exclude[i];
      if (e.axisIdx == null) return null;
      out.push({ axisIdx: e.axisIdx, keepMin: !!e.keepMin, d: e.d, inner: !!e.inner });
    }
    return out;
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
  function copyEntry(p) {
    return { n: p.n.slice(), d: p.d,
             axisIdx: (p.axisIdx == null ? null : p.axisIdx),
             keepMin: (p.axisIdx == null ? null : !!p.keepMin),
             dispAxis: (p.dispAxis == null ? null : p.dispAxis),
             dispSign: (p.dispAxis == null ? null : p.dispSign),
             dispPlane: (p.dispPlane == null ? null : p.dispPlane),
             inner: !!p.inner };
  }
  window.nsoMaskSnapshot = function (m) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude) return null;
    return mask.exclude.map(copyEntry);
  };
  window.nsoMaskRestore = function (m, snap) {
    if (!m) return;
    m.faceMask = { exclude: snap ? snap.map(copyEntry) : [] };
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
    // Vertex n of triangle t, through the index buffer when there is one.
    // Reading t*3+v straight out of the position buffer on indexed geometry
    // walks off onto some unrelated triangle, and the paint lands on a face
    // nobody clicked.
    const idx = geo.index;
    const nTri = ((idx ? idx.count : pos.count) / 3) | 0;
    const P = function (t, v) {
      const i = idx ? idx.getX(t * 3 + v) : (t * 3 + v);
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
    if (!m || !mask || !mask.exclude.length) return 0;
    const placed = state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; });
    if (!placed) return 0;
    const f = frameOf(m);
    const geo = placed.mesh.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos || !f) return 0;
    const verts = [];
    const nTri = (pos.count / 3) | 0;
    /* The faces the clicks named, in the display space this mesh is already
       in: no mapping, no centring, nothing re-derived. A triangle is painted
       when its own normal is the face's normal and it sits on that face's
       plane, which is read off this mesh every time so it is still right
       after a bake has rebuilt the piece. A pocket wall names the same axis
       and side as the hull face behind it, so it carries its own plane too
       and only the wall lights up. A patch with no axis to name at all falls
       back to the stored raw plane below. */
    const faceSet = {}, innerFaces = [];
    let anyPlaneOnly = false;
    for (let i = 0; i < mask.exclude.length; i++) {
      const e = mask.exclude[i];
      if (e.dispAxis == null) { anyPlaneOnly = true; continue; }
      if (e.inner) innerFaces.push(e);
      else faceSet[e.dispAxis + ':' + (e.dispSign > 0 ? '+' : '-')] = true;
    }
    let glo = [Infinity, Infinity, Infinity], ghi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < pos.count; v++) {
      const q = [pos.getX(v), pos.getY(v), pos.getZ(v)];
      for (let k = 0; k < 3; k++) {
        if (q[k] < glo[k]) glo[k] = q[k];
        if (q[k] > ghi[k]) ghi[k] = q[k];
      }
    }
    const onPlane = function (A, B, C, a, plane) {
      return Math.abs(A[a] - plane) < D_TOL && Math.abs(B[a] - plane) < D_TOL &&
             Math.abs(C[a] - plane) < D_TOL;
    };
    const onNamedFace = function (A, B, C, nx, ny, nz) {
      const na = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
      let a = 0;
      if (na[1] > na[a]) a = 1;
      if (na[2] > na[a]) a = 2;
      if (na[a] < 0.999) return false;
      const sg = ([nx, ny, nz][a] >= 0) ? 1 : -1;
      // an outer face: this axis and side, on the piece's own outer plane
      if (faceSet[a + ':' + (sg > 0 ? '+' : '-')] &&
          onPlane(A, B, C, a, sg > 0 ? ghi[a] : glo[a])) return true;
      // a pocket wall: this axis and side, on its own plane, which is why a
      // click inside the pocket cannot light up the hull face behind it
      for (let i = 0; i < innerFaces.length; i++) {
        const e = innerFaces[i];
        if (e.dispAxis !== a || (e.dispSign > 0 ? 1 : -1) !== sg) continue;
        if (onPlane(A, B, C, a, e.dispPlane)) return true;
      }
      return false;
    };
    /* The paint is the face's own triangles, in the face's own place. It used
       to be pushed a hair along the normal to win the depth test; polygon
       offset does that in the depth buffer instead, without moving anything,
       so the yellow cannot hang over the edge onto the face next door. On a
       pocket that mattered: a floor lifted a hair stood proud of its walls
       and put a yellow hairline on all four of them, and which walls you
       could see changed as the piece turned. */
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
      if (!onNamedFace(A, B, C, x, y, z)) {
        if (!anyPlaneOnly) continue;
        const rn = rawDirFromLocal([x,y,z]);
        const rp = rawPointFromLocal(f, A);
        if (!window.nsoMaskIsExcludedRaw(m, rn, rn[0]*rp[0]+rn[1]*rp[1]+rn[2]*rp[2])) continue;
      }
      verts.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    }
    if (!verts.length) return 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    /* Flat, unlit, full strength yellow - no lighting to shade it, so a
       painted face is the same signal colour whichever way the piece is
       turned and reads across a room. Front side only: the paint faces out,
       the way the face it marks does.

       It is drawn LAST, after every helper on the piece. The white selected
       outline, the inspect cage and the armed-face highlight are all
       transparent, and three renders the whole transparent pass after the
       whole opaque one - so an opaque paint, whatever its renderOrder, was
       always painted over by lines drawn later, and which lines crossed
       which face changed as the piece turned. Opaque-looking but in the
       transparent pass at a renderOrder above all of them, the paint is on
       top of them instead, and the same skip list looks the same from every
       camera. depthWrite off so it never leaves depth of its own behind for
       the helpers to test against; depthTest on so a face painted on the far
       side stays behind the solid. */
    overlay = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffdd00, side: THREE.FrontSide,
      transparent: true, opacity: 1, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8
    }));
    overlay.position.copy(placed.mesh.position);
    overlay.quaternion.copy(placed.mesh.quaternion);
    overlay.scale.copy(placed.mesh.scale);
    overlay.renderOrder = PAINT_RENDER_ORDER;
    /* The paint is paint, not a surface. It sits on the face it marks, so a
       ray can land on it as readily as on the piece, and without this a
       Soften pick on a painted face hits the yellow instead - the click lands
       on nothing and the face never gets to say it is painted out. */
    overlay.raycast = function () {};
    if (state.modelGroup) state.modelGroup.add(overlay);
    return verts.length / 9;
  }
  window.nsoMaskRepaint = repaint;

  /* ---- paint mode ---- */

  /* The HUD line. It reads the HUD tag at rest and gains the running count
     while a paint session is live, so the count is on the same line a photo
     of the HUD already shows. Paint never relabels itself into Done - it
     stays Paint faces and just lights up; Done is its own button. */
  const HUD_TAG = 'HUD mask6';
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
    // The face under the cursor is nsoFaceFromHit's answer - the same call
    // the Soften pick makes on the same triangle. What it says is recorded
    // whole: the raw axis and side the wrap will skip, the display face the
    // yellow will cover, and the plane Align reads. One pick, written down
    // once, so nothing downstream has to work out which face was meant.
    let entry = null, name = 'that face';
    const face = (typeof nsoFaceFromHit === 'function') ? nsoFaceFromHit(m, mesh, hit) : null;
    if (face && face.flat && isFinite(face.rawPlane) && isFinite(face.rawAt)) {
      // Outer face or pocket wall, one code path: the axis and side come from
      // the same call either way, and the plane says which face on that axis
      // and side it is. A pocket wall is a real face of the piece after a
      // Subtract - it just is not the outer one, and after a Subtract the
      // outer one may not even be there any more.
      const n = [0, 0, 0];
      n[face.rawAxisIdx] = face.rawKeepMin ? -1 : 1;
      const at = face.outer ? face.rawPlane : face.rawAt;
      entry = {
        n: n, d: face.rawKeepMin ? -at : at,
        axisIdx: face.rawAxisIdx, keepMin: !!face.rawKeepMin,
        dispAxis: face.dispAxis, dispSign: face.dispSign,
        dispPlane: face.outer ? face.localPlane : face.localHit,
        inner: !face.outer
      };
      name = (face.outer ? 'the ' : 'the inner ') +
             'XYZ'.charAt(face.dispAxis) + (face.dispSign > 0 ? '+' : '-') + ' face' +
             (face.outer ? '' : ' at ' + face.localHit.toFixed(2));
    } else {
      // Not flat enough to name an axis - a fillet, a curved end. Stored as
      // the coplanar patch under the cursor, and the wrap declines the
      // whole-solid route when it sees one.
      const patch = faceUnderCursor(m, mesh, hit);
      if (!patch) {
        setStatus('No face under that click - nothing changed', true);
        return false;
      }
      entry = { n: patch.plane.n, d: patch.plane.d,
                axisIdx: null, keepMin: null, dispAxis: null, dispSign: null };
      name = 'that recessed face (' + patch.tris.size + ' tris)';
    }
    const mask = maskOf(m);
    const prev = window.nsoMaskSnapshot(m);
    const at = indexOfPlane(mask, entry);
    if (at >= 0) mask.exclude.splice(at, 1);
    else mask.exclude.push(entry);
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'maskReplace', modelId: m.id, prevMask: prev });
    }
    const painted = repaint();
    window.nsoMaskHudRefresh();
    setStatus((at >= 0 ? 'Included ' : 'Excluded ') + name +
              (at >= 0 ? '' : ' (' + painted + ' tris yellow)') +
              ' - ' + mask.exclude.length + ' face(s) excluded');
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
