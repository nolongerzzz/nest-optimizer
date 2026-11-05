/* Extract selection - the target face's region off a piece, onto the plate as
   its own standalone object. Delete painted's non-destructive twin.

   ---------------------------------------------------------------------------
   WHICH PAINT THIS READS
   ---------------------------------------------------------------------------
   The SELECT list - the pink target, `nsoMaskSelected(m)`, the same list Skin
   face and Delete painted read. Not the exclude list. docs/HANDOFF.md, "The
   SELECT list is an operand; the EXCLUDE list is still only a veto", puts it
   as two questions, and this answers both:

       What does this act ON?   -> the SELECT list (the pink target).
       What must it not touch?  -> the EXCLUDE list (the yellow), always.

   PAINT SCOPE: SUB-REGION - see docs/HANDOFF.md "Scoping". The veto is asked
   about THIS face only, through the raw plane the pick recorded, exactly as
   Delete asks it, and the stand-down wording matches Delete's word for word.
   Paint on any other face is none of this operation's business - and here
   that holds twice over, because the source piece is not written to at all.

   COPY, NOT CUT. Delete removes the target's triangles from the piece; this
   copies them onto the plate and leaves the piece byte-identical. Removing the
   region from the source is the riskier operation and Delete already owns it;
   nothing here writes to `m.rawTris`, `m.geometry` or the paint.

   ---------------------------------------------------------------------------
   WHICH TRIANGLES, AND WHAT COMES OUT
   ---------------------------------------------------------------------------
   `NSO_PaintDelete.select(rawTris, entries)` is the one selector that turns a
   painted entry list into the triangles it covers. Delete owns that file; this
   reads it rather than keeping a second copy of "which triangles did that click
   cover" - two copies of that reasoning is the drift docs/HANDOFF.md warns
   about under "Read the list, never re-derive it".

   What it hands back is a SURFACE: the triangles on the target's plane. A
   surface is not an object - no volume, nothing to print, nothing to export as
   a solid - so the extracted piece is that patch given a wall: the target's
   triangles as its outer face, an inward copy as its inner face, and a rim
   closing the two along the patch boundary. The outer face is the target's
   triangles vertex for vertex, so nothing of the selection is dropped and
   nothing else of the source comes along.

   The inward copy offsets each welded vertex along the area-weighted average
   of the patch triangles meeting at it, mitred by 1/cos so a patch that turns
   a corner still comes out WALL_MM thick on both sides of it. That average is
   what makes the result one closed shell rather than a pile of loose slabs:
   where two patch triangles share an edge the edge is used twice, no rim is
   built there, and the shell carries on across it.

   The rim is built on boundary edges only - edges the welded patch uses once.
   Every edge of the result is then used exactly twice by construction: an
   interior patch edge by two outer triangles and two inner ones, a boundary
   edge by its outer/inner triangle and its rim, the rim diagonal by the two
   rim triangles, and the rim upright by the rims of the two boundary edges
   meeting at that vertex. NSO_edgeStats is the check, not the claim, and it
   runs BEFORE anything reaches the plate.

   ---------------------------------------------------------------------------
   DROP ONTO PLATE
   ---------------------------------------------------------------------------
   Deliberately the same five calls Extract bit makes, in the same order, from
   soupToCenteredGeo through to placeModelMovable - that subsystem is not
   touched here, it is copied. A piece that arrives this way is a first-class
   model: it is in state.models, it has rawTris/rawAxis/centerOffset so the raw
   engines will take it, it is on the plate as a movable piece, and one Undo
   removes it.                                                              */
(function () {
  // A real printable wall, and the same 1.2mm Extract bit lays its voxel
  // lattice on. Clamped down on a piece too small to give it away, and never
  // below WALL_MIN - anything thinner is not a part, it is a sliver.
  const WALL_MM = 1.2;
  const WALL_MIN = 0.4;
  const WALL_FRAC = 0.25;       // at most a quarter of the piece's shortest side
  const MITRE_MAX = 3;          // cap the 1/cos blow-up on a sharp crease
  const Q = 1e4;                // 0.1 micron weld buckets, as NSO_edgeStats uses

  function say(msg, bad) {
    if (typeof setStatus === 'function') setStatus(msg, !!bad);
  }
  function fail(msg) {
    say('Extract selection failed - ' + msg, true);
    return { ok: false, reason: msg };
  }
  function faceName(face) {
    if (typeof nsoMaskFaceName === 'function') return nsoMaskFaceName(face);
    return 'that face';
  }

  /* raw (zup) <-> display, the one mapping app-mask.js and
     displayGeometryToRawSoup already write down. Display is the raw soup
     rotated -90deg about X: d = [x, z, -y]. */
  function rawSoupToDisplay(raw) {
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 3) {
      out[i] = raw[i]; out[i + 1] = raw[i + 2]; out[i + 2] = -raw[i + 1];
    }
    return out;
  }

  /* The triangles `hit` marks, pulled out of a raw soup as a soup of their
     own. `hit` is NSO_PaintDelete.select's per-triangle flag array. */
  function gather(rawTris, hit) {
    const out = [];
    const n = (rawTris.length / 9) | 0;
    for (let t = 0; t < n; t++) {
      if (!hit[t]) continue;
      for (let k = 0; k < 9; k++) out.push(rawTris[t * 9 + k]);
    }
    return new Float32Array(out);
  }

  /* patch soup (flat, 9 per triangle) -> closed shell soup. Returns
     { soup, tris, boundary } or { why } with the reason it could not close. */
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

    /* Vertex normals from the DISTINCT face directions meeting at each vertex,
       averaged unweighted - not an area-weighted average of the triangles.

       The difference is not cosmetic and it is not a tie-break. Area weighting
       makes the offset direction depend on how a flat face happened to be
       triangulated: at the corner of two quads, the vertex that is a corner of
       two triangles on one face and one on the other gets pulled toward the
       face with two, the mitre stops being the bisector, and the wall comes
       out `wall` thick off one face and 2x that off the other. Measured: a
       two-face patch on a 20mm box closed fine but enclosed 1227.2mm^3 where
       the mitred L is 931.2. Deduplicating by direction first makes the result
       depend on the patch's SHAPE alone, which is what a mitre means, and a
       sliver on a face contributes nothing extra because it is not a new
       direction. */
    const fn = [];
    const vdirs = [];
    for (let i = 0; i < pts.length; i++) vdirs.push([]);
    const addDir = function (list, f) {
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (g[0]*f[0] + g[1]*f[1] + g[2]*f[2] > 0.999) return;   // same face
      }
      list.push(f);
    };
    for (let t = 0; t < tris.length; t++) {
      const A = pts[tris[t][0]], B = pts[tris[t][1]], C = pts[tris[t][2]];
      const ux = B[0]-A[0], uy = B[1]-A[1], uz = B[2]-A[2];
      const vx = C[0]-A[0], vy = C[1]-A[1], vz = C[2]-A[2];
      const x = uy*vz - uz*vy, y = uz*vx - ux*vz, z = ux*vy - uy*vx;
      const L = Math.hypot(x, y, z);
      const f = L > 1e-12 ? [x/L, y/L, z/L] : null;
      fn.push(f);
      if (!f) continue;
      for (let v = 0; v < 3; v++) addDir(vdirs[tris[t][v]], f);
    }
    const vn = [];
    for (let i = 0; i < pts.length; i++) {
      const dirs = vdirs[i];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < dirs.length; k++) { x += dirs[k][0]; y += dirs[k][1]; z += dirs[k][2]; }
      const L = Math.hypot(x, y, z);
      // Directions that cancel: a knife edge taken from both sides. There is
      // no single direction to back this vertex off along, so say so rather
      // than emit a shell that folds through itself.
      if (!(L > 1e-9)) return { why: 'the selection folds back on itself - no wall direction at one corner' };
      vn.push([x/L, y/L, z/L]);
    }
    // Mitre: back off far enough along the averaged direction that the wall is
    // `wall` thick measured off every face that meets there.
    const scale = [];
    for (let i = 0; i < pts.length; i++) {
      const n = vn[i], dirs = vdirs[i];
      let s = 1;
      for (let k = 0; k < dirs.length; k++) {
        const f = dirs[k];
        const d = n[0]*f[0] + n[1]*f[1] + n[2]*f[2];
        const q = d > 1e-6 ? Math.min(MITRE_MAX, 1 / d) : MITRE_MAX;
        if (q > s) s = q;
      }
      scale.push(s);
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
      // outer face: the target's triangles, untouched and still facing out
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

  /* The wall this piece can afford, measured off its own raw soup. */
  function wallFor(rawTris) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < rawTris.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const q = rawTris[i + k];
        if (q < lo[k]) lo[k] = q;
        if (q > hi[k]) hi[k] = q;
      }
    }
    const shortest = Math.min(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]);
    let w = WALL_MM;
    if (isFinite(shortest) && shortest > 0) w = Math.min(w, shortest * WALL_FRAC);
    return Math.max(WALL_MIN, w);
  }

  /* The button. Reads the pink target, copies its region onto the plate, and
     does not write one byte back to the source piece. */
  window.nsoExtractSelection = function () {
    const m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!m) { say('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
    if (!m.rawTris || m.rawAxis !== 'zup') {
      say('Extract selection needs a raw piece - split, wrap or boolean it first', true);
      return { ok: false, reason: 'no rawTris' };
    }
    if (typeof NSO_PaintDelete === 'undefined' || !NSO_PaintDelete ||
        typeof NSO_PaintDelete.select !== 'function') {
      say('Extract selection is unavailable - nso_paint_delete.js did not load', true);
      return { ok: false, reason: 'module missing' };
    }

    const face = (typeof nsoMaskSelected === 'function') ? nsoMaskSelected(m) : null;
    if (!face) {
      say('Extract selection needs a target face - Paint Selected, click the face, then Extract selection', true);
      return { ok: false, reason: 'no target' };
    }

    /* PAINT SCOPE: SUB-REGION - see docs/HANDOFF.md "Scoping". Asked about
       THIS face only, through the raw plane the pick recorded. Same veto and
       same words as Delete: the yellow means protected wherever it is read. */
    const excluded = (typeof nsoMaskIsExcludedRaw === 'function') &&
      nsoMaskIsExcludedRaw(m, face.n, face.d, face.axisIdx, face.keepMin, face.inner);
    if (excluded) {
      const n = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
      say('Extract selection stood down - ' + n + ' painted face(s); ' + faceName(face) +
          ' is painted excluded. Paint wins: clear the exclude paint on it to extract it.', true);
      return { ok: false, reason: 'target is painted excluded', painted: n };
    }

    const placed = (state.placed || []).find(function (p) {
      return p && p.sourceId === m.id && p.mesh;
    });
    if (!placed) return fail('that piece is not on the plate');

    let sel;
    try {
      sel = NSO_PaintDelete.select(m.rawTris, [face]);
    } catch (err) {
      return fail('could not read the target (' + ((err && err.message) || err) + ')');
    }
    if (!sel || !sel.count) {
      return fail(faceName(face) + ' covers no triangle on this piece - repaint the target');
    }

    const wall = wallFor(m.rawTris);
    const patch = gather(m.rawTris, sel.hit);
    const shell = shellFromPatch(patch, wall);
    if (!shell || !shell.soup) return fail(shell && shell.why ? shell.why : 'could not close the selection');

    // Cheap self-check before anything reaches the plate: the app's own
    // topology count on the soup we are about to hand over. A shell that is
    // not closed is not a part, and refusing here leaves the plate exactly as
    // it was rather than putting a broken piece on it.
    if (typeof NSO_edgeStats === 'function') {
      const st = NSO_edgeStats(shell.soup);
      if (st.open || st.nm) {
        return fail('the shell came out open (' + st.open + ' open, ' + st.nm +
                    ' non-manifold edges) - piece and plate unchanged');
      }
    }

    // ---- the drop-onto-plate mechanism, as Extract bit does it ----
    const display = rawSoupToDisplay(shell.soup);
    // The centring soupToCenteredGeo is about to apply, worked out here so the
    // new piece can carry where it came from. Provenance, not scaffolding: it
    // is what lets anything downstream line the extracted region back up
    // against the face it was taken off.
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < display.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const q = display[i + k];
        if (q < lo[k]) lo[k] = q;
        if (q > hi[k]) hi[k] = q;
      }
    }
    const offset = { x: -(lo[0] + hi[0]) / 2, y: -(lo[1] + hi[1]) / 2, z: -(lo[2] + hi[2]) / 2 };

    const geo = soupToCenteredGeo(display);
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

    /* The target is NOT consumed. Delete clears it because the plane it named
       is not a face of the piece any more; here the face is still exactly
       where it was, so clearing it would be a change to a piece this feature
       promises not to touch - and extracting the same region twice is a
       reasonable thing to want. */
    say('Extract selection ok - ' + faceName(face) + ', ' + shell.tris + ' tri(s), ' +
        wall.toFixed(2) + 'mm wall, solid ' +
        size.x.toFixed(1) + 'x' + size.y.toFixed(1) + 'x' + size.z.toFixed(1) +
        ' mm on the plate - source piece unchanged');
    return { ok: true, id: id, tris: shell.tris, boundary: shell.boundary, wall: wall };
  };

  /* Exposed so tools/nso_wire_extract_sel_test.js can put the shell builder
     under geometry the one-face UI cannot reach - a patch that turns a corner,
     which is where the mitred vertex normal earns its place. */
  window.NSO_ExtractSelection = { shellFromPatch: shellFromPatch, wallFor: wallFor };

  function bind() {
    const b = document.getElementById('btn-extract-sel');
    if (!b || b.dataset.nsoWired === '1') return;
    b.addEventListener('click', function () { window.nsoExtractSelection(); });
    b.dataset.nsoWired = '1';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else setTimeout(bind, 0);
})();
