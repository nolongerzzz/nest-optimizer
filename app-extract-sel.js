/* Extract selection — the painted region off a piece, onto the plate as its
   own standalone object.

   PAINT SCOPE: READ-ONLY CONSUMER — see docs/HANDOFF.md. The four features in
   the roster there bake the piece and so have to decide what paint stops them
   doing; this one bakes nothing. The paint is its INPUT, not a skip list, and
   the source piece is never written to, so the standing rule ("a painted face
   stays untouched by ANY bake mechanism") is honoured by construction rather
   than by a stand-down. It stands down on the absence of paint instead.

   WHAT COMES OUT
   The painted selection is a surface: the connected coplanar patches the
   clicks named, which is exactly the geometry the yellow already covers. A
   surface is not an object - it has no volume, cannot be printed and cannot
   be exported as a solid - so the extracted piece is that patch given a wall:
   the painted triangles as its outer face, an inward copy as its inner face,
   and a rim closing the two along the patch boundary. Nothing else of the
   source comes along, and nothing of the patch is left behind: the outer face
   is the painted triangles themselves, vertex for vertex.

   The inward copy offsets each welded vertex along the average of the painted
   triangles meeting at it, mitred by 1/cos so two painted faces meeting at a
   corner still come out WALL_MM thick on both. That average is what makes the
   result one closed shell instead of a pile of loose slabs: where two painted
   faces touch, they share the boundary edge, the edge is used twice, no rim
   is built there and the shell carries on around the corner.

   The rim is built on boundary edges only - edges used once by the welded
   patch. Every edge of the result is then used exactly twice by construction:
   an interior patch edge by two outer triangles and two inner ones, a
   boundary edge by its outer/inner triangle and its rim, the rim diagonal by
   the two rim triangles, and the rim upright by the rims of the two boundary
   edges meeting at that vertex. NSO_edgeStats is the check, not the claim.

   DROP ONTO PLATE
   Deliberately the same five calls Extract bit makes, in the same order, from
   soupToCenteredGeo through to placeModelMovable - that subsystem is not
   touched here, it is copied. A piece that arrives this way is a first-class
   model: it is in state.models, it has rawTris/rawAxis/centerOffset so the
   raw-mesh engines will take it, it is on the plate as a movable piece, and
   one Undo removes it. */
(function () {
  // A real printable wall, and the same 1.2mm Extract bit lays its voxel
  // lattice on. Clamped down on a piece too small to give it away, and never
  // below WALL_MIN - anything thinner is not a part, it is a sliver.
  const WALL_MM = 1.2;
  const WALL_MIN = 0.4;
  const WALL_FRAC = 0.25;       // at most a quarter of the piece's shortest side
  const MITRE_MAX = 3;          // cap the 1/cos blow-up on a sharp crease
  const Q = 1e4;                // 0.1 micron weld buckets, as NSO_edgeStats uses

  function activeModel() {
    return (typeof getActiveModel === 'function') ? getActiveModel() : null;
  }
  function placedFor(m) {
    if (!m || !state || !state.placed) return null;
    return state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; }) || null;
  }
  function fail(msg) {
    if (typeof setStatus === 'function') setStatus('Extract selection failed - ' + msg, true);
    return null;
  }

  /* patch soup (display space, flat 9-per-triangle) -> closed shell soup.
     Returns { soup, tris, walled, boundary } or null with a reason string in
     .why so the caller can say what stopped it. */
  function shellFromPatch(verts, wall) {
    const key = function (x, y, z) {
      return Math.round(x * Q) + '_' + Math.round(y * Q) + '_' + Math.round(z * Q);
    };
    const vmap = new Map(), pts = [], tris = [];
    const nTri = (verts.length / 9) | 0;
    for (let t = 0; t < nTri; t++) {
      const idx = [0, 0, 0];
      for (let v = 0; v < 3; v++) {
        const o = t * 9 + v * 3;
        const k = key(verts[o], verts[o + 1], verts[o + 2]);
        let i = vmap.get(k);
        if (i === undefined) { i = pts.length; pts.push([verts[o], verts[o + 1], verts[o + 2]]); vmap.set(k, i); }
        idx[v] = i;
      }
      // A triangle whose corners weld together has no area and no normal; it
      // would contribute two edges used once each and open the shell.
      if (idx[0] === idx[1] || idx[1] === idx[2] || idx[0] === idx[2]) continue;
      tris.push(idx);
    }
    if (!tris.length) return { why: 'the selection has no triangles with area' };

    // Area-weighted vertex normals over the painted triangles only. Weighted,
    // so a fan of slivers on one side of a vertex cannot out-vote the big
    // triangle that actually describes the face.
    const vn = [], fn = [];
    for (let i = 0; i < pts.length; i++) vn.push([0, 0, 0]);
    for (let t = 0; t < tris.length; t++) {
      const A = pts[tris[t][0]], B = pts[tris[t][1]], C = pts[tris[t][2]];
      const ux = B[0]-A[0], uy = B[1]-A[1], uz = B[2]-A[2];
      const vx = C[0]-A[0], vy = C[1]-A[1], vz = C[2]-A[2];
      const x = uy*vz - uz*vy, y = uz*vx - ux*vz, z = ux*vy - uy*vx;
      const L = Math.hypot(x, y, z);
      fn.push(L > 1e-12 ? [x/L, y/L, z/L] : null);
      for (let v = 0; v < 3; v++) {
        const n = vn[tris[t][v]];
        n[0] += x; n[1] += y; n[2] += z;
      }
    }
    for (let i = 0; i < vn.length; i++) {
      const n = vn[i], L = Math.hypot(n[0], n[1], n[2]);
      // Normals that cancel: a knife edge painted from both sides. There is no
      // single direction to back this vertex off along, so say so rather than
      // emit a shell that folds through itself.
      if (!(L > 1e-9)) return { why: 'the selection folds back on itself - no wall direction at one corner' };
      n[0] /= L; n[1] /= L; n[2] /= L;
    }
    // Mitre: back off far enough along the averaged normal that the wall is
    // `wall` thick measured off each face that meets there.
    const scale = [];
    for (let i = 0; i < vn.length; i++) scale.push(1);
    for (let t = 0; t < tris.length; t++) {
      const f = fn[t];
      if (!f) continue;
      for (let v = 0; v < 3; v++) {
        const i = tris[t][v], n = vn[i];
        const d = n[0]*f[0] + n[1]*f[1] + n[2]*f[2];
        const s = d > 1e-6 ? Math.min(MITRE_MAX, 1 / d) : MITRE_MAX;
        if (s > scale[i]) scale[i] = s;
      }
    }
    const back = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], n = vn[i], k = wall * scale[i];
      back.push([p[0] - n[0]*k, p[1] - n[1]*k, p[2] - n[2]*k]);
    }

    // Boundary = an undirected edge the welded patch uses once.
    const ecount = new Map();
    const ek = function (a, b) { return a < b ? (a + '|' + b) : (b + '|' + a); };
    for (let t = 0; t < tris.length; t++) {
      const k = tris[t];
      for (let e = 0; e < 3; e++) {
        const s = ek(k[e], k[(e + 1) % 3]);
        ecount.set(s, (ecount.get(s) || 0) + 1);
      }
    }

    const out = [];
    const push = function (A, B, C) { out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]); };
    let boundary = 0;
    for (let t = 0; t < tris.length; t++) {
      const k = tris[t];
      // outer face: the painted triangles, untouched and still facing out
      push(pts[k[0]], pts[k[1]], pts[k[2]]);
      // inner face: the same triangle on the backed-off vertices, reversed
      push(back[k[0]], back[k[2]], back[k[1]]);
      // rim, on this triangle's boundary edges, wound so it faces out of the
      // patch: see the header for why it is (a, b', b) and (a, a', b').
      for (let e = 0; e < 3; e++) {
        const a = k[e], b = k[(e + 1) % 3];
        if (ecount.get(ek(a, b)) !== 1) continue;
        boundary++;
        push(pts[a], back[b], pts[b]);
        push(pts[a], back[a], back[b]);
      }
    }
    return { soup: new Float32Array(out), tris: tris.length, boundary: boundary };
  }

  /* The wall this piece can afford. */
  function wallFor(mesh) {
    let w = WALL_MM;
    if (mesh && mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      const shortest = Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
      if (isFinite(shortest) && shortest > 0) w = Math.min(w, shortest * WALL_FRAC);
    }
    return Math.max(WALL_MIN, w);
  }

  /* The button. Reads the paint, builds the shell, drops it on the plate, and
     does not write one byte back to the source piece. */
  window.nsoExtractSelection = function () {
    const m = activeModel();
    if (!m || !m.geometry) return fail('select a piece first');
    const painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (!painted) {
      if (typeof setStatus === 'function') {
        setStatus('Extract selection needs a selection - paint the region first, then extract', true);
      }
      return null;
    }
    const placed = placedFor(m);
    if (!placed) return fail('that piece is not on the plate');

    const verts = (typeof nsoMaskPaintedTris === 'function')
      ? nsoMaskPaintedTris(m, placed.mesh) : [];
    if (!verts || verts.length < 9) {
      return fail(painted + ' face(s) painted but no triangle on the piece matches them - repaint the region');
    }

    const wall = wallFor(placed.mesh);
    const shell = shellFromPatch(verts, wall);
    if (!shell || !shell.soup) return fail(shell && shell.why ? shell.why : 'could not close the selection');

    // Cheap self-check before anything reaches the plate: the app's own
    // topology count on the soup we are about to hand over. A shell that is
    // not closed is not a part, and refusing here leaves the plate exactly as
    // it was rather than putting a broken piece on it.
    if (typeof NSO_edgeStats === 'function') {
      const st = NSO_edgeStats(shell.soup);
      if (st.open || st.nm) {
        return fail('the shell came out open (' + st.open + ' open, ' + st.nm + ' non-manifold edges) - piece and plate unchanged');
      }
    }

    // ---- the drop-onto-plate mechanism, as Extract bit does it ----
    // The centring soupToCenteredGeo is about to apply, worked out here so
    // the new piece can carry where it came from. Provenance, not scaffolding:
    // it is what lets anything downstream line the extracted region back up
    // against the face it was taken off.
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < shell.soup.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const q = shell.soup[i + k];
        if (q < lo[k]) lo[k] = q;
        if (q > hi[k]) hi[k] = q;
      }
    }
    const offset = { x: -(lo[0] + hi[0]) / 2, y: -(lo[1] + hi[1]) / 2, z: -(lo[2] + hi[2]) / 2 };

    const geo = soupToCenteredGeo(shell.soup);
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    const rawOut = displayGeometryToRawSoup(geo);
    const id = addModel((m.name || 'piece') + '-sel', geo, {
      rawTris: rawOut,
      rawAxis: 'zup',
      centerOffset: computeCenterOffsetFromRaw(rawOut),
      keepSelection: true,
      silent: true
    });
    if (!id) return fail('the extracted region is too small to be a piece');
    pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
    const xPlace = placed.x + (placed.width || size.x) / 2 + size.x / 2 + 6;
    const made = state.models.find(function (mm) { return mm.id === id; });
    if (made) {
      made.fromSelection = {
        sourceId: m.id, tris: shell.tris, boundary: shell.boundary,
        wall: wall, offset: offset
      };
      placeModelMovable(made, xPlace, placed.z);
    }

    if (typeof setStatus === 'function') {
      setStatus('Extract selection ok - ' + shell.tris + ' painted tri(s), ' +
                wall.toFixed(2) + 'mm wall, solid ' +
                size.x.toFixed(1) + 'x' + size.y.toFixed(1) + 'x' + size.z.toFixed(1) +
                ' mm on the plate - source piece unchanged');
    }
    return id;
  };

  function bind() {
    const b = document.getElementById('btn-extract-sel');
    if (!b || b.dataset.nsoWired === '1') return;
    b.addEventListener('click', function () { window.nsoExtractSelection(); });
    b.dataset.nsoWired = '1';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else setTimeout(bind, 0);
})();
