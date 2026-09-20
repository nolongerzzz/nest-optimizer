/* Face paint: EXCLUDE and SELECT. Runs after the boolean; Soften, the wrap
   replay and Align all read the same exclude set.

   Two lists on the piece, two questions, never one flag with two meanings:
     faceMask.exclude  "is this face excluded from bakes"  - any number of
                       faces, the yellow, the skip list every bake reads
                       (nsoMaskIsExcludedRaw / nsoMaskFaceList / nsoMaskCount).
     faceMask.select   "is this my target face"            - at most ONE
                       face, the pink, read by the one consumer that takes a
                       target today, Skin face (nsoMaskSelected). Painting a
                       second face replaces the first; painting the selected
                       face again deselects it.
   A face can be on both lists. That is not a conflict: paint wins, so a bake
   aimed at a selected face that is also excluded stands down and says so.
   Both entries are recorded by the same pick (nsoFaceFromHit) in the same
   shape, and both survive a bake the same way, as planes.

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
    if (!m.faceMask || !Array.isArray(m.faceMask.exclude)) m.faceMask = { exclude: [], select: [] };
    if (!Array.isArray(m.faceMask.select)) m.faceMask.select = [];
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
  function indexIn(list, pl) {
    if (!list) return -1;
    for (let i = 0; i < list.length; i++) if (sameFace(list[i], pl)) return i;
    return -1;
  }
  function indexOfPlane(mask, pl) { return indexIn(mask.exclude, pl); }
  /* The name a status line gives an entry - the display axis and side the
     click recorded, nothing re-derived. */
  function faceName(e) {
    if (!e) return 'no face';
    if (e.dispAxis == null) return 'that recessed face';
    return (e.inner ? 'the inner ' : 'the ') + 'XYZ'.charAt(e.dispAxis) + (e.dispSign > 0 ? '+' : '-') +
           ' face' + (e.inner && e.dispPlane != null ? ' at ' + Number(e.dispPlane).toFixed(2) : '');
  }
  window.nsoMaskFaceName = faceName;

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
  /* The painted faces as PLANES, exactly as each click recorded them.

     nsoMaskFaceList above is the axis-and-side view and returns null the
     moment one entry is a recessed patch, because the whole-solid wrap has no
     way to name one. A sub-region feature (the brush) needs the opposite: it
     has a set of points and wants to know which painted faces they lie on, so
     a recessed patch is perfectly usable and must not drop the whole list.
     Same rule either way - read back what the click wrote down, never work
     out which face was meant from a normal and a bounding box. */
  window.nsoMaskPlaneList = function (m) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude) return [];
    const out = [];
    for (let i = 0; i < mask.exclude.length; i++) {
      const e = mask.exclude[i];
      out.push({ n: e.n.slice(), d: e.d,
                 axisIdx: (e.axisIdx == null ? null : e.axisIdx),
                 keepMin: (e.axisIdx == null ? null : !!e.keepMin),
                 inner: !!e.inner,
                 recessed: e.axisIdx == null });
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

  /* The raw <-> local display mapping, exported rather than copied.

     It is eight lines and this app already carries two of it (here and in
     app-brush.js), which is two too many: the -90 deg X rotation and the
     centre it is measured about have to mean the same thing everywhere or a
     click lands on one face and the bake lands on another - the exact failure
     the "read the list, never re-derive it" rule in docs/HANDOFF.md was
     written about. app-assemble.js needs it to turn a raycast hit into the
     piece's own raw axes, and takes these rather than growing a third. */
  window.nsoRawFrameOf = frameOf;
  window.nsoRawPointFromLocal = rawPointFromLocal;
  window.nsoRawDirFromLocal = rawDirFromLocal;
  window.nsoLocalPointFromRaw = localPointFromRaw;
  window.nsoLocalDirFromRaw = localDirFromRaw;

  /* ---- the SELECT list: "is this my target face" ---- */

  // The one selected face, as a copy of what the click recorded (raw plane
  // n.p = d, raw axis and side when axis-aligned, display face for the
  // pink), or null when the piece has no target. Skin face reads this.
  window.nsoMaskSelected = function (m) {
    const mask = m && m.faceMask;
    if (!mask || !mask.select || !mask.select.length) return null;
    return copyEntry(mask.select[0]);
  };
  window.nsoMaskSelectCount = function (m) {
    return (m && m.faceMask && m.faceMask.select) ? m.faceMask.select.length : 0;
  };
  window.nsoMaskIsSelectedRaw = function (m, n, d, axisIdx, keepMin, inner) {
    const mask = m && m.faceMask;
    if (!mask || !mask.select || !mask.select.length) return false;
    return indexIn(mask.select, { n: n, d: d,
      axisIdx: (axisIdx == null ? null : axisIdx),
      keepMin: (axisIdx == null ? null : !!keepMin),
      inner: !!inner }) >= 0;
  };
  /* Drop the target. A consumer calls this once it has USED the face (Skin
     replaces it with relief, so the plane it recorded is no longer a face),
     with noUndo because its own undo entry already carries the snapshot. */
  window.nsoMaskSelectClear = function (m, opts) {
    const mask = maskOf(m);
    if (!mask || !mask.select.length) return false;
    if (!(opts && opts.noUndo) && typeof pushUndo === 'function') {
      pushUndo({ type: 'maskReplace', modelId: m.id, prevMask: window.nsoMaskSnapshot(m) });
    }
    mask.select = [];
    repaint();
    if (typeof window.nsoMaskHudRefresh === 'function') window.nsoMaskHudRefresh();
    return true;
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
  /* Both lists in one snapshot, so one undo step puts back the exclude AND
     the target together. Restore also takes the older bare-array form (the
     exclude list alone, no target) - the tests and the old undo entries hand
     that in. */
  window.nsoMaskSnapshot = function (m) {
    const mask = m && m.faceMask;
    if (!mask || !mask.exclude) return null;
    return { exclude: mask.exclude.map(copyEntry),
             select: (mask.select || []).map(copyEntry) };
  };
  window.nsoMaskRestore = function (m, snap) {
    if (!m) return;
    if (Array.isArray(snap)) m.faceMask = { exclude: snap.map(copyEntry), select: [] };
    else m.faceMask = { exclude: (snap && snap.exclude) ? snap.exclude.map(copyEntry) : [],
                        select: (snap && snap.select) ? snap.select.map(copyEntry) : [] };
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

  /* ---- the yellow over every excluded face, the pink over the target ---- */

  // Pink: the one per-piece colour nothing else on the plate uses. Paint is
  // yellow, A orange, B green, non-solid purple, the lock teal, the armed
  // face cyan. Drawn over the yellow (order 41 vs 40, offset -9 vs -8) and
  // translucent, so a face that is both selected and excluded shows both.
  const SELECT_COLOR = 0xf472b6;
  const SELECT_RENDER_ORDER = 41;

  let excludeOverlay = null;   // the yellow
  let selectOverlay = null;    // the pink
  let selPainted = 0;          // triangles the pink covered on the last repaint
  function dropOverlay(o) {
    if (o && o.parent) o.parent.remove(o);
    if (o && o.geometry) o.geometry.dispose();
    if (o && o.material) o.material.dispose();
  }
  function clearOverlay() {
    dropOverlay(excludeOverlay); excludeOverlay = null;
    dropOverlay(selectOverlay); selectOverlay = null;
    selPainted = 0;
  }
  /* Rebuild both overlays for the active piece. Returns the triangle count
     under the YELLOW (the number the exclude status line reports); the pink's
     count is kept in selPainted for the select status line. */
  function repaint() {
    clearOverlay();
    const m = activeModel();
    const mask = m && m.faceMask;
    if (!m || !mask) return 0;
    const placed = state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; });
    if (!placed) return 0;
    let painted = 0;
    if (mask.exclude && mask.exclude.length) {
      const r = buildOverlay(m, placed, mask.exclude, 0xffdd00, 1, PAINT_RENDER_ORDER, -8);
      if (r) { excludeOverlay = r.mesh; painted = r.tris; }
    }
    if (mask.select && mask.select.length) {
      const r = buildOverlay(m, placed, mask.select, SELECT_COLOR, 0.7, SELECT_RENDER_ORDER, -9);
      if (r) { selectOverlay = r.mesh; selPainted = r.tris; }
    }
    return painted;
  }
  function buildOverlay(m, placed, entries, color, opacity, order, offset) {
    const f = frameOf(m);
    const geo = placed.mesh.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos || !f) return null;
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
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
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
        if (indexIn(entries, { n: rn, d: rn[0]*rp[0]+rn[1]*rp[1]+rn[2]*rp[2], axisIdx: null }) < 0) continue;
      }
      verts.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    }
    if (!verts.length) return null;
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
    const overlay = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: color, side: THREE.FrontSide,
      transparent: true, opacity: opacity, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset
    }));
    overlay.position.copy(placed.mesh.position);
    overlay.quaternion.copy(placed.mesh.quaternion);
    overlay.scale.copy(placed.mesh.scale);
    overlay.renderOrder = order;
    /* The paint is paint, not a surface. It sits on the face it marks, so a
       ray can land on it as readily as on the piece, and without this a
       Soften pick on a painted face hits the yellow instead - the click lands
       on nothing and the face never gets to say it is painted out. */
    overlay.raycast = function () {};
    if (state.modelGroup) state.modelGroup.add(overlay);
    return { mesh: overlay, tris: verts.length / 9 };
  }
  window.nsoMaskRepaint = repaint;

  /* ---- paint mode ---- */

  /* The HUD line. It reads the HUD tag at rest and gains the running count
     while a paint session is live, so the count is on the same line a photo
     of the HUD already shows. Paint never relabels itself into Done - it
     stays Paint faces and just lights up; Done is its own button. */
  const HUD_TAG = 'HUD inside4';
  function hud(text) {
    const el = document.getElementById('adjust-status');
    if (el) el.textContent = text;
  }
  function hudPaint() {
    const m = activeModel();
    const n = window.nsoMaskCount(m);
    const sel = window.nsoMaskSelected(m);
    hud(HUD_TAG + ' \u2014 ' + n + (n === 1 ? ' face excluded' : ' faces excluded') +
        (sel ? ', target ' + faceName(sel).replace(/^the /, '') : ''));
  }
  /* state.maskPaint is the live mode: false, 'exclude' (the yellow) or
     'select' (the pink). Truthy while either session is live, which is all
     app-core's click routing and the older checks ask. Each button is a
     state of its own: idle it names its mode, live it says how to stop;
     neither ever relabels itself into the other. */
  const LABELS = {
    exclude: { id: 'btn-mask-paint',  idle: 'Paint Excluded', live: 'Stop painting' },
    select:  { id: 'btn-mask-select', idle: 'Paint Selected', live: 'Stop selecting' }
  };
  function setLabel() {
    Object.keys(LABELS).forEach(function (mode) {
      const btn = document.getElementById(LABELS[mode].id);
      if (!btn) return;
      const on = state.maskPaint === mode;
      btn.classList.toggle('is-armed', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? LABELS[mode].live : LABELS[mode].idle;
    });
  }
  /* One picking mode at a time, the same contract app-measure.js states and
     app-brush.js, app-center-lock.js and app-seat-surface.js all keep. Paint
     is asked FIRST in app-core's pointerdown routing - ahead of Carve, Seat
     here, the brush and Measure - so anything still armed when paint goes
     live is not merely second in line, it never fires again: paint takes
     every click that lands on a piece and the other button stays lit and
     dead. This used to name only the three flag-only modes, which left those
     four tools exactly there.

     The ones with a button go off THROUGH the button, so aria-pressed and
     the armed class follow; a flag written behind a button's back leaves it
     lit and doing nothing. None of those four runs a disarm on its way OUT,
     so clicking them here cannot bounce back and toggle paint off again.
     Order follows app-core's routing order, for no reason but that it is the
     order a reader can check this list against.

     Paint itself is not in the list. Switching between Paint Excluded and
     Paint Selected is a mode change, not a conflict, and clicking the other
     paint button would only switch modes again. state.centerLockArmed stays
     a flag write on purpose: btn-center-lock-pick refuses to cancel once the
     Join pair it needs is gone, so the button is the less reliable way in. */
  function disarmOthers() {
    const el = (id) => document.getElementById(id);
    if (state.carveArmed) {
      const carveBtn = el('btn-carve');
      if (carveBtn) carveBtn.click();
      else state.carveArmed = false;
    }
    if (state.seatHereArmed) {
      const seatBtn = el('btn-seat-here');
      if (seatBtn) seatBtn.click();
      else state.seatHereArmed = false;
    }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      const brushBtn = el('btn-brush');
      if (brushBtn) brushBtn.click();
      else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (state.measureOn) {
      const measureBtn = el('btn-measure');
      if (measureBtn) measureBtn.click();
      else state.measureOn = false;
    }
    /* Tip on face is a click-on-a-piece picker like the rest and belongs in
       this list. It goes off through its own setArmed so the button stops
       being lit and aria-pressed follows - the contract stated at the top of
       this block. It was missing: arming Paint, Carve or the Brush left Tip
       on face armed behind them, and app-core routes its block first, so the
       click meant for the new tool re-seated the piece instead. */
    if (state.tipFaceArmed && typeof window.nsoTipOrient !== 'undefined' &&
        typeof window.nsoTipOrient.setArmed === 'function') {
      window.nsoTipOrient.setArmed(false);
    } else {
      state.tipFaceArmed = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    state.centerLockArmed = false;
  }

  /* The same contract, reachable by the other pickers rather than copied
     into each of them. Tip on face is one; anything that arms a click on a
     piece should put the rest away through this and not by hand. */
  window.nsoMaskDisarmOthers = disarmOthers;

  function enterPaint(mode) {
    const m = activeModel();
    if (!m || !m.rawTris) {
      setStatus('Paint needs a raw piece - split, wrap or boolean it first', true);
      return;
    }
    state.maskPaint = mode;
    disarmOthers();
    if (typeof clearFacePick === 'function') clearFacePick();
    repaint();
    setLabel();
    hudPaint();
    setStatus(mode === 'select'
      ? 'Paint Selected - click a face to make it the target (one face; a second click elsewhere moves it, on the same face clears it). Stop selecting when finished'
      : 'Paint Excluded - click a face to exclude it, click again to include. Stop painting when finished');
  }
  function exitPaint() {
    const was = state.maskPaint;
    const m = activeModel();
    state.maskPaint = false;
    setLabel();
    hud(HUD_TAG);
    const sel = window.nsoMaskSelected(m);
    setStatus((was === 'select' ? 'Select off - ' : 'Paint off - ') +
              window.nsoMaskCount(m) + ' face(s) excluded, target ' + (sel ? faceName(sel).replace(/^the /, '') : 'none'));
  }
  function togglePaint(mode) {
    if (state.maskPaint === mode) exitPaint(); else enterPaint(mode);
  }
  window.nsoMaskHudRefresh = function () {
    if (state.maskPaint) { hudPaint(); return; }
    /* At rest the line goes back to the HUD tag - unless a position lock has
       something to say about the piece being selected, in which case it owns
       it. This call runs AFTER updateAdjustUI (app-sel-outline.js wraps
       selectPlaced to make sure the count survives a selection), so without
       this the lock's "Locked #n" was overwritten by the bare tag every time
       a piece was clicked. */
    const lock = (typeof window.nsoPosLockHudLine === 'function') ? window.nsoPosLockHudLine() : null;
    /* And the same for a defect check that is on screen (app-defects.js): its
       verdict is the answer to "what is wrong with this piece", so clicking
       the piece to look at the marks must not be what throws the verdict
       away. It rides ALONGSIDE the lock rather than instead of it - the two
       say different things and a locked piece can also be a checked one. */
    const chk = (typeof window.nsoDefectsHudLine === 'function') ? window.nsoDefectsHudLine() : null;
    hud(chk ? (lock ? lock + ' \u2014 ' + chk : chk) : (lock || HUD_TAG));
  };

  function hitFace(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (let i = 0; i < hits.length; i++) {
      if (hits[i].object === excludeOverlay || hits[i].object === selectOverlay) continue;
      if (hits[i].faceIndex == null) continue;
      return hits[i];
    }
    return null;
  }

  /* Does paint mode own this click? Asked by app-core's pointerdown, which
     runs first and would otherwise fall through to startMoveDrag and have the
     click reported as "Moved model #N" over the paint's own status.

     It has to be asked, not asserted: app-core binds inside initThree() while
     the document is still parsing and this file binds at DOMContentLoaded, so
     app-core is always the earlier listener on the same node in the same
     capture phase. stopPropagation() from there never reached this handler,
     and stopImmediatePropagation() would stop it dead - the paint needs the
     event. One predicate, so "paint takes this click" is decided here, where
     the hit test lives, and not guessed at again in app-core. */
  window.nsoMaskTakesClick = function (event) {
    if (!state.maskPaint || !event || event.button !== 0) return false;
    return !!hitFace(event);
  };

  /* The face under the cursor as an entry, one resolver for both lists.
     Returns null (with the reason on the status line) when the click cannot
     be described as a face. */
  function entryFromHit(m, mesh, hit) {
    if (!m || !m.rawTris) {
      setStatus('Paint needs a raw piece - split, wrap or boolean it first', true);
      return null;
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
        return null;
      }
      entry = { n: patch.plane.n, d: patch.plane.d,
                axisIdx: null, keepMin: null, dispAxis: null, dispSign: null };
      name = 'that recessed face (' + patch.tris.size + ' tris)';
    }
    return { entry: entry, name: name };
  }

  // Toggle the face under the cursor on the EXCLUDE list. Nothing here moves
  // the piece, and a pick that resolves to no face leaves both the mesh and
  // the paint alone.
  window.nsoMaskToggleAt = function (m, mesh, hit) {
    const r = entryFromHit(m, mesh, hit);
    if (!r) return false;
    const entry = r.entry, name = r.name;
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

  /* Make the face under the cursor THE target (SELECT list). One face at a
     time: a click on a different face replaces the target, a click on the
     current one clears it. The exclude list is not touched either way. */
  window.nsoMaskSelectAt = function (m, mesh, hit) {
    const r = entryFromHit(m, mesh, hit);
    if (!r) return false;
    const entry = r.entry, name = r.name;
    const mask = maskOf(m);
    const prev = window.nsoMaskSnapshot(m);
    const same = indexIn(mask.select, entry) >= 0;
    const replaced = !same && mask.select.length > 0 ? faceName(mask.select[0]) : null;
    mask.select = same ? [] : [entry];
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'maskReplace', modelId: m.id, prevMask: prev });
    }
    repaint();
    window.nsoMaskHudRefresh();
    const alsoExcluded = !same && indexOfPlane(mask, entry) >= 0;
    setStatus(same
      ? 'Deselected ' + name + ' - no target face'
      : 'Selected ' + name + ' as the target (' + selPainted + ' tris pink)' +
        (replaced ? ' - replaces ' + replaced : '') +
        (alsoExcluded ? ' - it is also painted excluded, so a bake on it stands down until that paint is cleared' : '') +
        ' - Skin face will use it');
    return true;
  };

  function bind() {
    const btn = document.getElementById('btn-mask-paint');
    if (btn && !btn._maskBound) { btn.addEventListener('click', function () { togglePaint('exclude'); }); btn._maskBound = true; }
    const sel = document.getElementById('btn-mask-select');
    if (sel && !sel._maskBound) { sel.addEventListener('click', function () { togglePaint('select'); }); sel._maskBound = true; }
    // Clear paint takes both lists off the piece: every exclude and the target.
    const clr = document.getElementById('btn-mask-clear');
    if (clr && !clr._maskBound) {
      clr.addEventListener('click', function () {
        const m = activeModel();
        if (!m) return;
        const prev = window.nsoMaskSnapshot(m);
        if (typeof pushUndo === 'function') pushUndo({ type: 'maskReplace', modelId: m.id, prevMask: prev });
        m.faceMask = { exclude: [], select: [] };
        repaint();
        window.nsoMaskHudRefresh();
        setStatus('Paint cleared - 0 faces excluded, no target face');
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
      if (state.maskPaint === 'select') window.nsoMaskSelectAt(m, placed.mesh, hit);
      else window.nsoMaskToggleAt(m, placed.mesh, hit);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(function () { bind(); setLabel(); }, 0);
})();
