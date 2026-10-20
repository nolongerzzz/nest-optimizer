// ===================== Tube edge: Reducer, Flare and Roll on the open end of a tube =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_tube_edge_test.js) and under a classic script tag in
// the browser, where the Tube edge card (app-tube-edge.js) calls it.
// docs/TUBE-EDGE.md.
//
// Two verbs on the open end of a tube, the same family as Bend: the wall's
// section is carried exactly. Bend sweeps it along a path; here it is swept
// round the tube's own axis - a surface of revolution - along a meridian
// curve that starts at the end ring:
//
//   FLARE   the wall turns outward (Δr > 0) or inward (Δr < 0, or Way In)
//           over a length: Straight (a cone) or Trumpet (a parabolic ease-in:
//           tangent to the tube at the ring, its radius growing as the square
//           of the height). Inward is the outward construction mirrored
//           across the mid-wall line: the bore leads, standing |Δr| in at the
//           lip, and the outside goes round it a wall away.
//   ROLL    the wall curls outward round a bead of a given radius, through
//           an angle (90, 180, 270 or any up to 360).
//
// THE PICK. The end is a flat face of the piece bounded by two concentric
// circles: an annulus, the open end of a tube. The flat faces are found the
// way a cap is: edge-connected triangles in one plane (NSO_TE_PLANE_TOL_MM).
// Each face's boundary loops are read with the section reader's own fit -
// NSO_sectionClassLoop / NSO_sectionFitCircle (nso_section.js), the very
// test that calls a ring round and states its tolerance - so "circular" means
// here what it means to Scale's ring verbs and to Bend. The mid-length
// reader itself (NSO_sectionRead) is not used: it needs a constant section
// over 90% of the length, which a thrown vessel does not have, and the end
// is what is being read. A face with one round loop is a closed end; a face
// whose loops are not round is not circular; both refuse in words.
//
// THE WALL at the end is read off the triangles that meet the ring: their
// normals give the wall's direction in the meridian (the half-plane through
// the axis). On a tube that is the axis; on a thrown vessel the rim may lean,
// and the profile is laid in the wall's own frame - Length runs along the
// wall's direction at the ring, Angle and Δr are measured from that line.
// Wall thickness t = rim width × cos(lean).
//
// THE SECTION CARRIED EXACTLY. One reference curve Q is laid on the side of
// the bend's centre (the outside face, for an outward turn); the other face is
// its offset by t on the convex side. An offset away from the centre of
// curvature never cusps, and the distance between a curve and its offset is t
// everywhere - the wall's thickness through the new section is the tube's
// wall, to the tessellation (gated at 0.02 mm). The straight cone has a crease
// on the outside face; its inside face goes round that crease on an arc of
// radius t (a round join), so the wall holds t through the corner too and
// there is no lip.
//
// WALLS (Flare's opts.walls): Both (the default) carries the section as
// above. Outside only / Bore only moves that face alone - it stands Δr off
// its own line at the lip, a cone or a trumpet - while the other face runs
// on along its own line to the same lip, its radius unmoved; the wall's
// thickness changes from t at the ring to t ∓ |Δr| at the lip, refused in
// words under the nozzle-safety floor (nso_thickness.js) or where the faces
// would cross. The lip rule is the same in every mode: square to the wall at
// u = L.
//
// RUN (Flare's opts.runMm, 0 by default and then byte-identical to before):
// a straight tube on past the lip - fat pipe, cone, skinny pipe (a reducer)
// or the reverse (an expander). Its outside and bore are exactly the lip's,
// it runs parallel to the axis for Run mm from the lip's plane and is cut
// square to the axis, open. Its wall is the lip's width, whatever the flare
// left it. One more station on each face: the lip ring's vertices carried up
// their own lines, so the run shares the lip ring's edges and the lip face
// moves to the run's end. A Trumpet's lip is not parallel to the axis, so the
// run meets it at the trumpet's lip angle. A Roll has no lip direction to run
// along and refuses a Run in words.
//
// REDUCER (NSO_TubeEdge.reducer, NSO_tubeEdgeReducer): the end defined by
// its result. The end of the tube becomes a pipe of outside od2 and bore id2
// after a transition of T mm (along the wall, as Flare's Length), then runs
// straight on for R mm, parallel to the axis, and ends square and open. Each
// face is built DIRECTLY from its own ring point to its own target - a cone
// (Straight) or the ease-in tangent at the ring (Trumpet) - so the wall at the
// run is (od2 - id2) / 2 exactly: nothing is carried, and there is no lip to
// cut. Its wall square to the faces through the transition is measured and
// held to nso_thickness.js's floor. od2 > Ø1 is an expander, < a reducer;
// id2 at the tube's bore is Outside only, od2 at its Ø is Bore only.
// FLARE is the reducer's wrapper: Way / Angle / Δr / Walls / Length / Run are
// converted into od2 / id2 / T / R, the Ø each face's lip always had. One
// face (Walls) was always two faces built directly, so it is the reducer's
// direct section. Both is the reducer's carried section (Flare's only: the
// moving face to its target, the other its offset a wall away, cut square to
// the wall at T - the old lip cut, and the old run off it). The wrapper hands
// the Δr over with the Ø it made, so the faces are built from the same
// numbers to the bit: every Flare hash pinned before the reducer still holds.
//
// THE WELD. Every vertex of the two end loops keeps its own radial line: a
// station of the new wall is that vertex moved by (Δr, Δh) along its own
// radial direction and the axis. Station 0 IS the loop - the same float32
// bits - so the new wall shares the end loops' edges and the join needs no
// weld. The end face is taken out and replaced by the new wall; every other
// triangle is copied bit for bit.
//
// THE GATES, on the output buffer: topology (open / non-manifold / flipped /
// zero-area may not rise, Euler unchanged), the added volume against Pappus
// (π∮r²dh of the new meridian region, times the polygon factor), and the
// wall: every station of each face against the other face's polyline.
//
// REFUSALS, before anything is built, in words, the piece unchanged:
//   - no round open end (closed, not circular, a tangled outline)
//   - inward: the bore at the lip under 2 nozzle widths across
//   - one face: the wall at the lip under nso_thickness.js's floor, or the
//     faces crossing
//   - the thin-wall rule: an outward turn takes the wall's material from the
//     ring's mid-wall radius r out to R', stretching it round its hoop by
//     R'/r. Sheet that stretches thins in proportion: t·r/R'. Refused when
//     that is under 2 nozzle widths.
//   - touching: the new wall may come no closer than one nozzle width to the
//     piece it was made from, or to itself.
//
// PAINT SCOPE: WHOLE-PIECE - the caller's (app-tube-edge.js), as Bend's.

var NSO_TE_SAG_MM = 0.01;            // chord sag on every curved face of the new wall
var NSO_TE_WALL_TOL_MM = 0.02;       // wall through the new section vs the tube's wall
var NSO_TE_STRETCH_NOZZLES = 2;      // the thin-wall rule: stretched wall >= 2 nozzle widths
var NSO_TE_GAP_NOZZLES = 1;          // closest the new wall may come to the piece or itself
var NSO_TE_BORE_NOZZLES = 2;         // a bore turned or moved inward: at least 2 nozzle widths across at the lip
var NSO_TE_ZONE_GAPS = 2.5;          // the ring's own neighbourhood, in gaps (see the clearance)
var NSO_TE_PLANE_TOL_MM = 1e-4;      // one flat end face: every vertex this close to its plane
var NSO_TE_MAX_LEAN_DEG = 30;        // the wall at the ring, off the axis
var NSO_TE_PARALLEL_DEG = 5;         // the wall's two faces at the ring, off each other
var NSO_TE_MAX_FLARE_DEG = 75;
var NSO_TE_MAX_ROLL_DEG = 360;
var NSO_TE_VOLUME_TOL = 5e-3;        // added volume vs Pappus
var NSO_TE_MAX_TRIS = 2000000;
var NSO_TE_CLEAR_EVALS = 4000000;    // clearance budget: distance evaluations
var NSO_TE_CLEAR_RES_MM = 0.01;      // clearance: pieces this small (circumradius) are called on their centre
var NSO_TE_SAME_MM = 1e-4;           // a reducer's new Ø this close to the tube's own is the tube's own (that face stays)

var NSO_teF32 = (typeof Math.fround === 'function') ? Math.fround
  : function (x) { var a = new Float32Array(1); a[0] = x; return a[0]; };
function NSO_teFmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
function NSO_teDeg(x) { return x * 180 / Math.PI; }
function NSO_teRad(x) { return x * Math.PI / 180; }

function NSO_teNozzle(opts) {
  if (opts && typeof opts.nozzle === 'number' && opts.nozzle > 0) return opts.nozzle;
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  return (T && T.NOZZLE_DEFAULT > 0) ? T.NOZZLE_DEFAULT : 0.4;
}
// (not NSO_teSigned: app-tube-edge.js has one of that name, loaded after this file)
function NSO_teSignedDp(x, dp) { return (x > 0 ? '+' : x < 0 ? '−' : '') + NSO_teFmt(Math.abs(x), dp); }

/* WALLS, Flare's and Neck's: which of the wall's faces the verb moves.
   'both' (the default, and what every verb did before Walls) carries the
   section, the wall's thickness kept; 'outside' or 'bore' moves that face
   alone by Δr and leaves the other exactly where it was, so the wall's
   thickness changes through the section. null: not one of the three. */
var NSO_TE_WALLS_WORDS = { both: 'Both', outside: 'Outside only', bore: 'Bore only' };
function NSO_teWalls(opts) {
  var w = opts && opts.walls;
  if (w == null || w === '' || w === 'both') return 'both';
  return (w === 'outside' || w === 'bore') ? w : null;
}

/* RUN, Flare's: mm of straight tube on past the lip. Blank or 0 is no run
   (and the flare is what it was before Run); NaN: not a length. */
function NSO_teRun(opts) {
  var r = opts && opts.runMm;
  if (r == null || r === '') return 0;
  r = +r;
  return (isFinite(r) && r >= 0) ? r : NaN;
}

/* The nozzle-safety floor, nso_thickness.js's (one extrusion line), or null
   when that file is not loaded - there is no copy of it here. */
function NSO_teFloor(nozzle) {
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  return (T && typeof T.floorFor === 'function') ? T.floorFor(nozzle) : null;
}

/* One face moved by dr against the other, a wall t apart: the wall it leaves
   (the bore moving out, or the outside in, thins it), refused in words when
   the faces would cross or the wall would go under the floor. `where` names
   the place the wall is thinnest (' at the waist', ' at the lip'). Returns
   { ok, reason, wallMm, floorMm }. */
function NSO_teOneFaceWall(walls, t, dr, nozzle, where) {
  var floor = NSO_teFloor(nozzle), left = walls === 'bore' ? t - dr : t + dr;
  var res = { ok: false, reason: '', wallMm: left, floorMm: floor };
  if (floor == null) {
    res.reason = 'nso_thickness.js must be loaded - a one-face move is held to its nozzle-safety floor, and carries no copy of it';
    return res;
  }
  var face = walls === 'bore' ? 'bore' : 'outside', most = t - floor;
  var tail = most > 0 ? '. This wall lets its ' + face + ' move ' + (walls === 'bore' ? 'out' : 'in') + ' by ' + NSO_teFmt(Math.floor(most * 100) / 100) + ' mm at most'
                      : '. This ' + NSO_teFmt(t) + ' mm wall is at the floor already: its ' + face + ' may only move ' + (walls === 'bore' ? 'in' : 'out');
  if (!(left > 1e-9)) {
    res.reason = face + ' ' + NSO_teSignedDp(dr) + ' mm would carry the ' + face + ' through the other face of a ' + NSO_teFmt(t) +
      ' mm wall - the faces would cross' + tail;
    return res;
  }
  if (left < floor - 1e-9) {
    res.reason = face + ' ' + NSO_teSignedDp(dr) + ' mm would leave a ' + NSO_teFmt(left) + ' mm wall' + (where || '') + '; the floor is ' +
      NSO_teFmt(floor) + ' mm (nso_thickness.js: one extrusion line at a ' + nozzle + ' mm nozzle)' + tail;
    return res;
  }
  res.ok = true;
  return res;
}

/* =====================================================================
   1. Topology of the input: an exact-bit weld and the edge table
   ===================================================================== */

function NSO_teWeld(soup) {
  var n = (soup.length / 9) | 0, refs = n * 3;
  var bits = new Uint32Array(soup.buffer, soup.byteOffset, n * 9);
  var size = 1; while (size < refs * 2) size <<= 1;
  var table = new Int32Array(size).fill(-1), keys = new Uint32Array(refs * 3), vid = new Int32Array(refs), nv = 0;
  var imul = Math.imul;
  for (var i = 0; i < refs; i++) {
    var x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
    if (x === 0x80000000) x = 0; if (y === 0x80000000) y = 0; if (z === 0x80000000) z = 0;
    var h = imul(x ^ imul(y, 0x9e3779b1) ^ imul(z, 0x85ebca77), 0xc2b2ae3d);
    h = (h ^ (h >>> 15)) & (size - 1);
    for (;;) {
      var e = table[h];
      if (e < 0) { table[h] = nv; keys[nv * 3] = x; keys[nv * 3 + 1] = y; keys[nv * 3 + 2] = z; vid[i] = nv++; break; }
      if (keys[e * 3] === x && keys[e * 3 + 1] === y && keys[e * 3 + 2] === z) { vid[i] = e; break; }
      h = (h + 1) & (size - 1);
    }
  }
  var P = new Float64Array(nv * 3);
  for (var r = 0; r < refs; r++) { var v = vid[r]; P[v * 3] = soup[r * 3]; P[v * 3 + 1] = soup[r * 3 + 1]; P[v * 3 + 2] = soup[r * 3 + 2]; }
  // edges: corner r = 3t + k is the edge vid[3t+k] -> vid[3t+(k+1)%3]
  var emap = new Map(), eA = [], eB = [], eC = [], cornerEdge = new Int32Array(refs);
  for (var t = 0; t < n; t++) for (var k = 0; k < 3; k++) {
    var a = vid[t * 3 + k], b = vid[t * 3 + (k + 1) % 3];
    var key = a < b ? a * nv + b : b * nv + a, id = emap.get(key);
    if (id === undefined) { id = eA.length; emap.set(key, id); eA.push(-1); eB.push(-1); eC.push(0); }
    if (eC[id] === 0) eA[id] = t * 3 + k; else if (eC[id] === 1) eB[id] = t * 3 + k;
    eC[id]++;
    cornerEdge[t * 3 + k] = id;
  }
  // unit normals, and which triangles have no area
  var N = new Float64Array(n * 3), degen = new Uint8Array(n);
  for (var q = 0; q < n; q++) {
    var i0 = vid[q * 3] * 3, i1 = vid[q * 3 + 1] * 3, i2 = vid[q * 3 + 2] * 3;
    var ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2];
    var wx = P[i2] - P[i0], wy = P[i2 + 1] - P[i0 + 1], wz = P[i2 + 2] - P[i0 + 2];
    var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, L = Math.hypot(nx, ny, nz);
    if (!(L > 1e-14)) { degen[q] = 1; continue; }
    N[q * 3] = nx / L; N[q * 3 + 1] = ny / L; N[q * 3 + 2] = nz / L;
  }
  return { n: n, nv: nv, vid: vid, P: P, eA: eA, eB: eB, eC: eC, cornerEdge: cornerEdge, N: N, degen: degen };
}

/* The triangle across corner r's edge, or -1 (open, or more than two). */
function NSO_teAcross(W, r) {
  var id = W.cornerEdge[r];
  if (W.eC[id] !== 2) return -1;
  var o = W.eA[id] === r ? W.eB[id] : W.eA[id];
  return (o / 3) | 0;
}

/* =====================================================================
   2. The flat faces and their loops
   ===================================================================== */

/* Every flat face: edge-connected triangles whose every vertex lies within
   NSO_TE_PLANE_TOL_MM of the seed's plane and whose normal agrees with it. */
function NSO_teFaces(W) {
  var n = W.n, P = W.P, vid = W.vid, N = W.N, region = new Int32Array(n).fill(-1), faces = [];
  for (var s = 0; s < n; s++) {
    if (region[s] >= 0 || W.degen[s]) continue;
    var nx = N[s * 3], ny = N[s * 3 + 1], nz = N[s * 3 + 2], v0 = vid[s * 3] * 3;
    var d = nx * P[v0] + ny * P[v0 + 1] + nz * P[v0 + 2];
    var id = faces.length, mem = [s], q = 0;
    region[s] = id;
    while (q < mem.length) {
      var t = mem[q++];
      for (var k = 0; k < 3; k++) {
        var u = NSO_teAcross(W, t * 3 + k);
        if (u < 0 || region[u] >= 0) continue;
        if (!W.degen[u] && nx * N[u * 3] + ny * N[u * 3 + 1] + nz * N[u * 3 + 2] < 0.999) continue;
        var flat = true;
        for (var c = 0; c < 3 && flat; c++) {
          var vi = vid[u * 3 + c] * 3;
          if (Math.abs(nx * P[vi] + ny * P[vi + 1] + nz * P[vi + 2] - d) > NSO_TE_PLANE_TOL_MM) flat = false;
        }
        if (!flat) continue;
        region[u] = id; mem.push(u);
      }
    }
    faces.push({ id: id, tris: mem, n: [nx, ny, nz], d: d, origin: [P[v0], P[v0 + 1], P[v0 + 2]] });
  }
  return { faces: faces, region: region };
}

/* A face's boundary, as closed loops of vertex ids in the order its own
   triangles walk them (material on the left about the face normal). */
function NSO_teFaceLoops(W, F, region) {
  var next = new Map(), tangled = 0, edges = 0;
  for (var i = 0; i < F.tris.length; i++) {
    var t = F.tris[i];
    for (var k = 0; k < 3; k++) {
      var u = NSO_teAcross(W, t * 3 + k);
      if (u >= 0 && region[u] === F.id) continue;
      var a = W.vid[t * 3 + k], b = W.vid[t * 3 + (k + 1) % 3];
      if (next.has(a)) tangled++;
      next.set(a, { b: b, corner: t * 3 + k });
      edges++;
    }
  }
  var loops = [], seen = new Set();
  next.forEach(function (e, a) {
    if (seen.has(a)) return;
    var lp = [], corners = [], v = a, guard = 0;
    while (!seen.has(v) && next.has(v) && guard++ <= edges) {
      seen.add(v); lp.push(v); corners.push(next.get(v).corner); v = next.get(v).b;
    }
    if (v !== a) tangled++;
    loops.push({ v: lp, corners: corners });
  });
  return { loops: loops, tangled: tangled, edges: edges };
}

/* An orthonormal frame in a plane: e1, e2 with e1 x e2 = n. */
function NSO_teFrame(n) {
  var ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  var ref = (ax <= ay && ax <= az) ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
  var e1 = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]];
  var L = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / L, e1[1] / L, e1[2] / L];
  var e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return { e1: e1, e2: e2 };
}

/* What a face is, as an end: { kind: 'open' | 'closed' | 'shape' | 'loops' |
   'tangled', ... }. Only loops of 12 or more points are fitted - a round loop
   needs 23 to pass the section reader's 1% tolerance. */
function NSO_teClassFace(W, F, region) {
  var L = NSO_teFaceLoops(W, F, region), P = W.P;
  var out = { face: F, loops: L.loops, kind: 'tangled', corners: [] };
  if (L.tangled || !L.loops.length) return out;
  var fr = NSO_teFrame(F.n), o = F.origin;
  out.frame = fr;
  out.fits = L.loops.map(function (lp) {
    var p2 = lp.v.map(function (v) {
      var x = P[v * 3] - o[0], y = P[v * 3 + 1] - o[1], z = P[v * 3 + 2] - o[2];
      return [x * fr.e1[0] + y * fr.e1[1] + z * fr.e1[2], x * fr.e2[0] + y * fr.e2[1] + z * fr.e2[2]];
    });
    var area = 0;
    for (var i = 0; i < p2.length; i++) { var a = p2[i], b = p2[(i + 1) % p2.length]; area += a[0] * b[1] - a[1] * b[0]; }
    var corners = (typeof NSO_sectionCorners === 'function') ? NSO_sectionCorners(p2).length : p2.length;
    var cls = p2.length >= 12 ? NSO_sectionClassLoop(p2) : null;
    return { p2: p2, area: area / 2, corners: corners, cls: cls, round: !!(cls && cls.cls === 'round') };
  });
  var f = out.fits;
  if (f.length === 1) {
    out.kind = f[0].round ? 'closed' : 'flat';
    out.corners = [f[0].corners];
  } else if (f.length === 2) {
    var oi = Math.abs(f[0].area) >= Math.abs(f[1].area) ? 0 : 1, ii = 1 - oi;
    out.corners = [f[oi].corners, f[ii].corners];
    if (!f[oi].round || !f[ii].round) { out.kind = 'shape'; out.outerIdx = oi; return NSO_teFaceGeom(out); }
    var co = f[oi].cls.circle, ci = f[ii].cls.circle;
    var ecc = Math.hypot(co.center[0] - ci.center[0], co.center[1] - ci.center[1]);
    if (!(ci.r < co.r) || ecc > ci.tolMm) { out.kind = 'eccentric'; out.eccMm = ecc; out.outerIdx = oi; return NSO_teFaceGeom(out); }
    out.kind = 'open'; out.outerIdx = oi; out.innerIdx = ii; out.eccMm = ecc;
    out.Ro = co.r; out.Ri = ci.r;
    out.windingOk = f[oi].area > 0 && f[ii].area < 0;
  } else out.kind = 'loops';
  return NSO_teFaceGeom(out);
}

/* The face's centre in 3D and a characteristic size, for picking. */
function NSO_teFaceGeom(c) {
  var F = c.face, fr = c.frame, o = F.origin, f = c.fits;
  if (!f || !f.length) return c;
  var oi = c.outerIdx != null ? c.outerIdx : 0, fit = f[oi].cls ? f[oi].cls.circle : null, cen2;
  if (fit && (c.kind === 'open' || c.kind === 'closed')) cen2 = fit.center;
  else {
    var sx = 0, sy = 0; f[oi].p2.forEach(function (p) { sx += p[0]; sy += p[1]; });
    cen2 = [sx / f[oi].p2.length, sy / f[oi].p2.length];
  }
  c.center2 = cen2;
  c.center = [o[0] + cen2[0] * fr.e1[0] + cen2[1] * fr.e2[0], o[1] + cen2[0] * fr.e1[1] + cen2[1] * fr.e2[1],
              o[2] + cen2[0] * fr.e1[2] + cen2[1] * fr.e2[2]];
  if (c.kind === 'closed') c.Ro = fit.r;
  return c;
}

/* Distance from a point to a face read as an end. Round ends by their
   annulus; anything else by its loops' points (only for the refusal). */
function NSO_teFaceDistance(c, p) {
  var n = c.face.n, C = c.center;
  var w = [p[0] - C[0], p[1] - C[1], p[2] - C[2]], h = w[0] * n[0] + w[1] * n[1] + w[2] * n[2];
  var rr = Math.hypot(w[0] - h * n[0], w[1] - h * n[1], w[2] - h * n[2]);
  if (c.kind === 'open' || c.kind === 'closed') {
    var lo = c.kind === 'open' ? c.Ri : 0, dr = Math.max(0, lo - rr, rr - c.Ro);
    return Math.hypot(h, dr);
  }
  var best = Infinity, fr = c.frame, o = c.face.origin;
  c.fits.forEach(function (f) { f.p2.forEach(function (q) {
    var X = o[0] + q[0] * fr.e1[0] + q[1] * fr.e2[0], Y = o[1] + q[0] * fr.e1[1] + q[1] * fr.e2[1], Z = o[2] + q[0] * fr.e1[2] + q[1] * fr.e2[2];
    best = Math.min(best, Math.hypot(p[0] - X, p[1] - Y, p[2] - Z));
  }); });
  return best;
}

/* =====================================================================
   3. Read the end
   ===================================================================== */

/* opts.point  [x, y, z] in the raw frame: the end nearest it. Blank: the
               round end standing highest (its centre's raw Z).
   Returns { ok, reason, end } - end: { center, axis (outward), Ro, Ri, wallMm,
   leanDeg, outer, inner (vertex ids), ... }. */
function NSO_tubeEdgeRead(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '' };
  if (!soup || soup.length < 9 || soup.length % 9) { res.reason = 'not a triangle soup'; return res; }
  if (typeof NSO_sectionClassLoop !== 'function') {
    res.reason = 'nso_section.js must be loaded - the end ring is read with its circle fit and carries no copy of it';
    return res;
  }
  res.soup = soup;
  if (!(soup instanceof Float32Array)) soup = new Float32Array(soup);
  var W = NSO_teWeld(soup);
  res.weld = W;
  // Inside-out soups would turn every face's normal inward.
  var vol = 0;
  for (var o9 = 0; o9 < soup.length; o9 += 9) {
    vol += soup[o9] * (soup[o9 + 4] * soup[o9 + 8] - soup[o9 + 5] * soup[o9 + 7]) -
           soup[o9 + 1] * (soup[o9 + 3] * soup[o9 + 8] - soup[o9 + 5] * soup[o9 + 6]) +
           soup[o9 + 2] * (soup[o9 + 3] * soup[o9 + 7] - soup[o9 + 4] * soup[o9 + 6]);
  }
  if (!(vol > 0)) { res.reason = 'the piece is wound inside out (its volume reads negative) - Repair it first'; return res; }

  var FF = NSO_teFaces(W);
  res.faceCount = FF.faces.length;
  var classed = [], round = [];
  FF.faces.forEach(function (F) {
    var c = NSO_teClassFace(W, F, FF.region);
    classed.push(c);
    if (c.kind === 'open' || c.kind === 'closed') round.push(c);
  });
  var pt = opts.point;
  function pick(list) {
    if (!list.length) return null;
    var best = null, bd = Infinity;
    list.forEach(function (c) {
      if (!c.center) return;
      var d = pt ? NSO_teFaceDistance(c, pt) : -c.center[2];
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && c.face.tris.length > best.face.tris.length)) { bd = d; best = c; }
    });
    return best;
  }
  var c = pick(round);
  if (!c) {
    var any = pick(classed.filter(function (q) { return q.kind !== 'tangled'; }));
    res.reason = NSO_teNoEndWords(any);
    return res;
  }
  res.candidates = round.length;
  if (c.kind === 'closed') {
    res.reason = 'that end is closed - a flat Ø' + NSO_teFmt(2 * c.Ro) + ' face with no opening. Flare and Roll work on ' +
      'the open end of a tube (a ring with a bore through it)' + (round.some(function (q) { return q.kind === 'open'; })
        ? ' - click the open end' : '');
    return res;
  }
  if (!c.windingOk) { res.reason = 'the end face is wound against the rest of the piece - Repair it first'; return res; }

  // ---- the end, in 3D ----
  var a = c.face.n, C = c.center, P = W.P;
  var outer = c.loops[c.outerIdx], inner = c.loops[c.innerIdx];
  var end = { center: C, axis: a, Ro: c.Ro, Ri: c.Ri, rimMm: c.Ro - c.Ri, face: c.face.tris, frame: c.frame,
              outer: outer.v, inner: inner.v, outerCorners: outer.corners, innerCorners: inner.corners,
              fitOuter: c.fits[c.outerIdx].cls.circle, fitInner: c.fits[c.innerIdx].cls.circle, eccMm: c.eccMm };

  // ---- the wall at the ring: the faces that meet it, in the meridian ----
  function lean(loop, corners, isOuter) {
    var sw = 0, sa = 0, worstFace = 0;
    for (var i = 0; i < loop.length; i++) {
      var u = NSO_teAcross(W, corners[i]);
      if (u < 0) return { bad: 'the end ring has an open or shared edge' };
      var A = loop[i] * 3, B = loop[(i + 1) % loop.length] * 3;
      var M = [(P[A] + P[B]) / 2 - C[0], (P[A + 1] + P[B + 1]) / 2 - C[1], (P[A + 2] + P[B + 2]) / 2 - C[2]];
      var h = M[0] * a[0] + M[1] * a[1] + M[2] * a[2];
      var e = [M[0] - h * a[0], M[1] - h * a[1], M[2] - h * a[2]], el = Math.hypot(e[0], e[1], e[2]);
      e = [e[0] / el, e[1] / el, e[2] / el];
      var Nn = [W.N[u * 3], W.N[u * 3 + 1], W.N[u * 3 + 2]];
      var nr = Nn[0] * e[0] + Nn[1] * e[1] + Nn[2] * e[2], nh = Nn[0] * a[0] + Nn[1] * a[1] + Nn[2] * a[2];
      var ang = isOuter ? Math.atan2(-nh, nr) : Math.atan2(nh, -nr);   // + = leaning outward
      var len = Math.hypot(P[B] - P[A], P[B + 1] - P[A + 1], P[B + 2] - P[A + 2]);
      sw += len; sa += len * ang;
      worstFace = Math.max(worstFace, Math.abs(ang));
    }
    return { deg: NSO_teDeg(sa / sw), worstDeg: NSO_teDeg(worstFace) };
  }
  var lo = lean(outer.v, outer.corners, true), li = lean(inner.v, inner.corners, false);
  if (lo.bad || li.bad) { res.reason = lo.bad || li.bad; return res; }
  end.leanOuterDeg = lo.deg; end.leanInnerDeg = li.deg;
  if (Math.max(lo.worstDeg, li.worstDeg) > 90 - 1e-6 || Math.abs(lo.deg) > NSO_TE_MAX_LEAN_DEG || Math.abs(li.deg) > NSO_TE_MAX_LEAN_DEG) {
    res.reason = 'the wall meets the end face ' + NSO_teFmt(Math.max(Math.abs(lo.deg), Math.abs(li.deg)), 1) + '° off the tube\'s axis - ' +
      'more than ' + NSO_TE_MAX_LEAN_DEG + '°, so this is not the end of a tube wall (a chamfer, a lip or a flange meets it there)';
    return res;
  }
  if (Math.abs(lo.deg - li.deg) > NSO_TE_PARALLEL_DEG) {
    res.reason = 'the wall tapers at the end - its outside runs ' + NSO_teFmt(lo.deg, 1) + '° and its inside ' + NSO_teFmt(li.deg, 1) +
      '° off the axis, more than ' + NSO_TE_PARALLEL_DEG + '° apart, so it has no one thickness to carry';
    return res;
  }
  end.leanDeg = (lo.deg + li.deg) / 2;
  end.wallMm = end.rimMm * Math.cos(NSO_teRad(end.leanDeg));
  res.ok = true;
  res.end = end;
  res.reason = 'open end Ø' + NSO_teFmt(2 * end.Ro) + ' outer / Ø' + NSO_teFmt(2 * end.Ri) + ' bore, wall ' + NSO_teFmt(end.wallMm);
  return res;
}

function NSO_teNoEndWords(c) {
  var tail = '. Flare and Roll work on the open, circular end of a tube.';
  if (!c) return 'there is no flat end face on this piece to read' + tail;
  var sides = function (k) { return k + '-sided'; };
  if (c.kind === 'flat') return 'that end is closed - a flat ' + sides(c.corners[0]) + ' face with no opening, not a circular ring' + tail;
  if (c.kind === 'shape') {
    return 'that end is not circular - its outline is ' + (c.fits[c.outerIdx].round ? 'round' : 'a ' + sides(c.corners[0]) + ' polygon') +
      ' and its bore ' + (c.fits[1 - c.outerIdx].round ? 'round' : 'a ' + sides(c.corners[1]) + ' polygon') + tail;
  }
  if (c.kind === 'eccentric') return 'that end\'s bore is ' + NSO_teFmt(c.eccMm, 2) + ' mm off centre - not a ring of one wall' + tail;
  if (c.kind === 'loops') return 'that end face has ' + c.loops.length + ' separate outlines, not one ring' + tail;
  return 'that end face is tangled' + tail;
}

/* =====================================================================
   4. The profile: two meridian curves and the region between them

   Laid in the wall's own frame at the ring, (v, u): u along the wall's
   direction, v its outward normal; the outside face's ring point Po is the
   origin and the inside face's Pi sits at (-t, u_i), u_i = -rim·sin(lean).
   The new section starts square to the wall at u0 = max(0, u_i); the face
   whose ring point is lower first runs straight on to it.
   ===================================================================== */

function NSO_teArcSteps(radius, sweep) {
  if (!(sweep > 0)) return 0;
  var c = 1 - NSO_TE_SAG_MM / Math.max(radius, NSO_TE_SAG_MM * 2);
  var dmax = 2 * Math.acos(Math.max(-1, Math.min(1, c)));
  return Math.max(2, Math.ceil(sweep / Math.min(dmax, NSO_teRad(10))));
}

/* The two faces of a flare turning OUTWARD by dr (> 0) through th over L,
   pushed onto O, I and mid, which start at their u0 points. The outside is
   the reference face (the cone's crease, the trumpet's curve), the inside
   its offset a wall t away on the convex side. Returns { ok, reason,
   lipAngleDeg }. */
function NSO_teFlareFaces(O, I, mid, t, u0, L, dr, th, prof) {
  var res = { ok: false, reason: '' };
  if (prof === 'straight') {
    // outside: one cone line. Inside: round the crease K on an arc of
    // radius t, then the cone line's offset to the lip plane u0 + L.
    var sp = (L - t * Math.sin(th)) / Math.cos(th);
    if (!(sp > 1e-6)) {
      res.reason = 'a ' + NSO_teFmt(L) + ' mm flare is too short to turn a ' + NSO_teFmt(t) + ' mm wall through ' + NSO_teFmt(NSO_teDeg(th), 1) +
        '° - its inside face needs ' + NSO_teFmt(t * Math.sin(th) + 0.01) + ' mm or more';
      return res;
    }
    O.push([dr, u0 + L]);
    var na = NSO_teArcSteps(t, th);
    for (var i = 1; i <= na; i++) { var ps = th * i / na; I.push([-t * Math.cos(ps), u0 + t * Math.sin(ps)]); }
    var ie = I[I.length - 1];
    I.push([ie[0] + sp * Math.sin(th), u0 + L]);
    for (var j = 0; j <= na; j++) { var pm = th * j / na; mid.push([-t / 2 * Math.cos(pm), u0 + t / 2 * Math.sin(pm)]); }
    mid.push([-t / 2 * Math.cos(th) + ((L - t / 2 * Math.sin(th)) / Math.cos(th)) * Math.sin(th), u0 + L]);
    res.lipAngleDeg = NSO_teDeg(th);
  } else {
    // Trumpet: v = dr (s / L)^2 along u = u0 + s. Stations at equal turns of
    // the tangent, psi in [0, psiE], so the step sags most at the lip,
    // where the curve is flattest, and the turn per step is the same.
    var psiE = Math.atan(2 * dr / L), p = 2 * dr / L;
    var rhoLip = Math.pow(1 + p * p, 1.5) * L * L / (2 * dr);
    var ns = Math.max(6, NSO_teArcSteps(rhoLip + t, psiE));
    var inner = [];
    for (var k = 1; k <= ns; k++) {
      var psi = psiE * k / ns, s = k === ns ? L : L * L * Math.tan(psi) / (2 * dr);
      var v = dr * (s / L) * (s / L);
      O.push([v, u0 + s]);
      inner.push([v - t * Math.cos(psi), u0 + s + t * Math.sin(psi)]);
      mid.push([v - t / 2 * Math.cos(psi), u0 + s + t / 2 * Math.sin(psi)]);
    }
    // the inside face, cut by the lip plane u0 + L
    var prev = I[I.length - 1];
    for (var m = 0; m < inner.length; m++) {
      var q = inner[m];
      if (q[1] >= u0 + L) {
        var f = (u0 + L - prev[1]) / (q[1] - prev[1]);
        if (f > 1e-9) I.push([prev[0] + f * (q[0] - prev[0]), u0 + L]);
        else I[I.length - 1] = [prev[0], u0 + L];
        break;
      }
      I.push(q); prev = q;
    }
    if (I[I.length - 1][1] < u0 + L - 1e-9) { res.reason = 'internal: the trumpet\'s inside face did not reach its lip'; return res; }
    res.lipAngleDeg = NSO_teDeg(psiE);
  }
  res.ok = true;
  return res;
}

/* One face of a reducer, built directly: from its ring point (v0, at the last
   station pushed) dv across to v0 + dv at u0 + T. Straight: one cone line. Trumpet: the
   ease-in v = v0 + dv (s / T)^2 along u = u0 + s, tangent to the wall at the
   ring, stationed at equal turns of its tangent (Flare's trumpet, the same
   sampling). A face with nowhere to go (dv under 1e-9 mm: its target is
   where its own line already is) runs straight on along that line. */
function NSO_teDirectFace(F, v0, dv, u0, T, prof) {
  if (Math.abs(dv) <= 1e-9) { F.push([v0, u0 + T]); return; }
  if (prof === 'straight') { F.push([v0 + dv, u0 + T]); return; }
  var ad = Math.abs(dv), psE = Math.atan(2 * ad / T), pp = 2 * ad / T;
  var rhoL = Math.pow(1 + pp * pp, 1.5) * T * T / (2 * ad), nst = Math.max(6, NSO_teArcSteps(rhoL, psE));
  for (var k = 1; k <= nst; k++) {
    var s = k === nst ? T : T * T * Math.tan(psE * k / nst) / (2 * ad);
    F.push([v0 + dv * (s / T) * (s / T), u0 + s]);
  }
}

/* opts as NSO_tubeEdgeRaw. Returns { ok, reason, O, I (local [v, u] lists,
   each from its own ring point), mid (local), ... }. */
function NSO_teProfile(end, opts) {
  var res = { ok: false, reason: '' };
  var t = end.wallMm, lean = NSO_teRad(end.leanDeg), ui = -end.rimMm * Math.sin(lean), u0 = Math.max(0, ui);
  var O = [[0, 0]], I = [[-t, ui]], mid = [];
  if (u0 > 1e-9) O.push([0, u0]);
  if (u0 - ui > 1e-9) I.push([-t, u0]);
  var verb = opts.verb, run = NSO_teRun(opts);
  if (!(run >= 0)) {
    var rn = opts && opts.runMm;
    res.reason = verb === 'reducer' && isFinite(+rn) && +rn < 0
      ? 'a run of ' + NSO_teSignedDp(+rn, 1) + ' mm is refused - Run is a length along the axis, 0 or more (0: no run)'
      : 'enter a run length in mm, 0 or more (0: no run past the lip)';
    return res;
  }
  res.runMm = run;
  if (verb === 'reducer') {
    // THE REDUCER (and Flare, its wrapper, which hands in opts._flare): the
    // tube's end becomes a pipe of outside od2 and bore id2 after a transition
    // of T mm along the wall, laid in the wall's own frame as Flare's Length
    // always was. The run (Run mm on, parallel to the axis) is added by the
    // treatment, from wherever the faces end.
    var fl = opts._flare || null, prof = opts.profile === 'trumpet' ? 'trumpet' : 'straight', T;
    if (fl) T = fl.lengthMm;
    else {
      var tv = opts.transitionMm;
      if (tv == null || tv === '' || !isFinite(+tv)) { res.reason = 'enter a transition length in mm, 0 or more'; return res; }
      T = +tv;
      if (T < 0) { res.reason = 'a transition of ' + NSO_teSignedDp(T, 1) + ' mm is refused - Transition is a length along the tube, 0 or more'; return res; }
    }
    var cl = Math.cos(lean), sl = Math.sin(lean), Ro = end.Ro, Ri = end.Ri;
    // a face's local v where it ends, u0 + T along the wall, for its radius there
    var vAt = function (r) { return (r - Ro - (u0 + T) * sl) / cl; };
    var num = function (x) { return (x == null || x === '' || !isFinite(+x)) ? null : +x; };
    var od2 = num(opts.od2), id2 = num(opts.id2);
    res.reducer = { od1Mm: 2 * Ro, id1Mm: 2 * Ri, transitionMm: T, runMm: run, profile: prof };
    if (fl && opts.section === 'carried') {
      // CARRIED (Flare's Both, from its wrapper only): the face on the bend's
      // side - the outside turning out, the bore turning in - goes to its
      // target by the profile, and the other is its offset a wall t away (round
      // the cone's crease on an arc of radius t), cut square to the wall at
      // u0 + T. That is the old path's lip cut, kept exactly: the other face
      // ends where the offset meets that plane, not at a target of its own.
      var dr = od2 != null ? opts._exact.dvO : opts._exact.dvI, th = Math.atan2(Math.abs(dr), T);
      var off = od2 != null ? vAt(od2 / 2) - dr : vAt(id2 / 2) + t - dr;
      if (!(Math.abs(off) <= 1e-6)) { res.reason = 'internal: Flare\'s lip Ø and its Δr disagree by ' + off + ' mm'; return res; }
      res.flare = fl;
      res.reducer.section = 'carried';
      if (dr < 0) {
        // INWARD, both faces: the outward construction mirrored across the
        // mid-wall line, v -> -t - v. The bore is then the face on the bend's
        // side (the cone's crease, the trumpet's reference curve) and stands
        // |dr| in at the lip; the outside goes round it a wall away.
        var Oo = [[0, u0]], Io = [[-t, u0]], Mo = [];
        var mo = NSO_teFlareFaces(Oo, Io, Mo, t, u0, T, -dr, th, prof);
        if (!mo.ok) { res.reason = mo.reason; return res; }
        var mir = function (q) { return [-t - q[0], q[1]]; };
        for (var q1 = 1; q1 < Io.length; q1++) O.push(mir(Io[q1]));
        for (var q2 = 1; q2 < Oo.length; q2++) I.push(mir(Oo[q2]));
        Mo.forEach(function (q) { mid.push(mir(q)); });
        res.lipAngleDeg = mo.lipAngleDeg;
        res.inward = true;
      } else {
        var mf = NSO_teFlareFaces(O, I, mid, t, u0, T, dr, th, prof);
        if (!mf.ok) { res.reason = mf.reason; return res; }
        res.lipAngleDeg = mf.lipAngleDeg;
      }
    } else {
      // DIRECT: each face goes from its own ring point to its own target by the
      // profile; nothing is carried, so there is no offset to cusp, no crease
      // to go round and no lip to cut - the wall where they end is the targets'
      // difference exactly. A face whose target is its own Ø stays on its line.
      if (!(od2 > 0)) { res.reason = 'enter the new outside Ø in mm, more than 0'; return res; }
      if (!(id2 > 0)) { res.reason = 'enter the new bore Ø in mm, more than 0'; return res; }
      if (od2 === id2) {
        res.reason = 'a new Ø' + NSO_teFmt(od2) + ' with a bore of Ø' + NSO_teFmt(id2) + ' leaves no wall - the outside must be larger than the bore';
        return res;
      }
      if (od2 < id2) {
        res.reason = 'the faces would cross - the new outside Ø' + NSO_teFmt(od2) + ' is inside the new bore Ø' + NSO_teFmt(id2) +
          '; the outside must be larger than the bore';
        return res;
      }
      var sameO = Math.abs(od2 - 2 * Ro) <= NSO_TE_SAME_MM, sameI = Math.abs(id2 - 2 * Ri) <= NSO_TE_SAME_MM;
      if (T === 0 && !(sameO && sameI)) {
        res.reason = 'transition 0: use Scale\'s ring rows for a step - Ø' + NSO_teFmt(2 * Ro) + ' / bore Ø' + NSO_teFmt(2 * Ri) + ' → Ø' + NSO_teFmt(od2) +
          ' / bore Ø' + NSO_teFmt(id2) + ' with no length between them is a step, not a reducer. A reducer changes Ø over a transition longer than 0';
        return res;
      }
      if (T === 0 && run === 0) { res.reason = 'nothing to make - no transition and no run, and the Ø and bore are the tube\'s own'; return res; }
      // each face's move across the wall's frame, dv. From Flare, the Δr it was
      // given, exactly (its Ø is that Δr laid off and read back as a radius,
      // which may not give back the last bit), checked against the Ø
      var dvO = vAt(sameO ? Ro : od2 / 2), dvI = vAt(sameI ? Ri : id2 / 2) + t;
      if (fl) {
        var oo = dvO - opts._exact.dvO, oi = dvI - opts._exact.dvI;
        if (!(Math.abs(oo) <= 1e-6 && Math.abs(oi) <= 1e-6)) { res.reason = 'internal: Flare\'s lip Ø and its Δr disagree by ' + oo + ' / ' + oi + ' mm'; return res; }
        dvO = opts._exact.dvO; dvI = opts._exact.dvI;
      }
      if (T > 0) { NSO_teDirectFace(O, 0, dvO, u0, T, prof); NSO_teDirectFace(I, -t, dvI, u0, T, prof); }
      var ang = function (dv) { return T > 0 ? NSO_teDeg(prof === 'straight' ? Math.atan2(Math.abs(dv), T) : Math.atan(2 * Math.abs(dv) / T)) : 0; };
      var aO = ang(dvO), aI = ang(dvI);
      res.reducer.angleOuterDeg = aO; res.reducer.angleBoreDeg = aI; res.reducer.section = 'direct';
      res.reducer.kind = !sameO ? (od2 < 2 * Ro ? 'reducer' : 'expander') : !sameI ? (id2 < 2 * Ri ? 'reducer' : 'expander') : 'straight';
      res.reducer.faces = !sameO && !sameI ? 'both' : !sameO ? 'outside' : !sameI ? 'bore' : 'none';
      if (fl) {
        // Flare's Outside only / Bore only: today's one-face flare, which was
        // always two faces built directly to the same lip plane
        res.flare = fl; res.walls = fl.walls; res.oneFace = opts._oneFace;
        res.lipAngleDeg = NSO_teDeg(prof === 'straight' ? Math.atan2(Math.abs(fl.drMm), T) : Math.atan(2 * Math.abs(fl.drMm) / T));
      } else res.lipAngleDeg = Math.max(aO, aI);
      res.direct = true;
    }
  } else if (verb === 'roll') {
    var rho = +opts.radius, Phi = +opts.angle;
    if (run > 0) {
      res.reason = 'a ' + NSO_teFmt(run, 1) + ' mm run is refused on a Roll - a Roll has no lip direction to run along (the wall curls round ' +
        'its bead and stops where the Angle ends). Run is a Flare\'s: set it to 0 to roll';
      return res;
    }
    if (opts.direction === 'in' || rho < 0) {
      res.reason = 'an inward roll is not supported yet - Roll curls the wall outward only (into the bore is a later ticket)';
      return res;
    }
    if (!(rho > 0) || !isFinite(rho)) { res.reason = 'enter a roll radius in mm, more than 0'; return res; }
    if (!(Phi > 0) || !isFinite(Phi)) { res.reason = 'enter a roll angle in degrees, more than 0'; return res; }
    if (Phi > NSO_TE_MAX_ROLL_DEG + 1e-9) { res.reason = 'a roll turns at most ' + NSO_TE_MAX_ROLL_DEG + '° - a full turn brings the wall back onto itself'; return res; }
    var F = NSO_teRad(Phi), nr = NSO_teArcSteps(rho + t, F);
    for (var r = 1; r <= nr; r++) {
      var ph = F * r / nr, cph = r === nr ? Math.cos(F) : Math.cos(ph), sph = r === nr ? Math.sin(F) : Math.sin(ph);
      if (Math.abs(cph) < 1e-15) cph = 0; if (Math.abs(sph) < 1e-15) sph = 0;
      O.push([rho - rho * cph, u0 + rho * sph]);
      I.push([rho - (rho + t) * cph, u0 + (rho + t) * sph]);
    }
    for (var r2 = 0; r2 <= nr; r2++) {
      var p2 = F * r2 / nr;
      mid.push([rho - (rho + t / 2) * Math.cos(p2), u0 + (rho + t / 2) * Math.sin(p2)]);
    }
    res.roll = { radiusMm: rho, angleDeg: Phi };
    res.beadCenterLocal = [rho, u0];
    res.lipAngleDeg = Phi;
  } else {
    res.reason = 'choose Reducer, Flare or Roll';
    return res;
  }
  res.ok = true; res.O = O; res.I = I; res.mid = mid; res.u0 = u0; res.ui = ui; res.t = t; res.lean = lean;
  return res;
}

/* Local (v, u) from Po -> global meridian (r, h) about the end's centre. */
function NSO_teToMeridian(end, lean, q) {
  var c = Math.cos(lean), s = Math.sin(lean);
  return [end.Ro + q[0] * c + q[1] * s, -q[0] * s + q[1] * c];
}

/* =====================================================================
   5. Distances in the meridian
   ===================================================================== */

function NSO_teSegDist(p, a, b) {
  var ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
  var t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2)) : 0;
  return { d: Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey), t: t };
}

function NSO_teSegSeg(a, b, c, d) {
  function orient(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
  var o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
  return Math.min(NSO_teSegDist(a, c, d).d, NSO_teSegDist(b, c, d).d, NSO_teSegDist(c, a, b).d, NSO_teSegDist(d, a, b).d);
}

/* The wall through the new section: every station of each face, against the
   other face's polyline - skipped where the nearest point is one of the other
   face's two ends: its lip corner (the lip face, not the wall, is nearest
   there) or its ring point (the old wall below the ring is). */
function NSO_teWallCheck(Om, Im) {
  var worst = 0, lo = Infinity, hi = -Infinity, n = 0;
  function one(A, B) {
    for (var i = 0; i < A.length; i++) {
      var best = Infinity, atEnd = false;
      for (var j = 0; j + 1 < B.length; j++) {
        var r = NSO_teSegDist(A[i], B[j], B[j + 1]);
        if (r.d < best) { best = r.d; atEnd = (j + 2 === B.length && r.t >= 1 - 1e-12) || (j === 0 && r.t <= 1e-12); }
      }
      if (atEnd) continue;
      n++; if (best < lo) lo = best; if (best > hi) hi = best;
    }
  }
  one(Om, Im); one(Im, Om);
  return { lo: lo, hi: hi, n: n };
}

/* A one-face flare's wall: every station of each face but its ring point
   (the old wall's), against the other face's whole polyline. */
function NSO_teOneFaceWallCheck(Om, Im) {
  var lo = Infinity, hi = -Infinity, n = 0;
  function one(A, B) {
    for (var i = 1; i < A.length; i++) {
      var best = Infinity;
      for (var j = 0; j + 1 < B.length; j++) { var d = NSO_teSegDist(A[i], B[j], B[j + 1]).d; if (d < best) best = d; }
      n++; if (best < lo) lo = best; if (best > hi) hi = best;
    }
  }
  one(Om, Im); one(Im, Om);
  return { lo: lo, hi: hi, n: n };
}

/* A reducer's wall, square to its faces: every station of each face, the
   ring points too, against the other face's whole polyline (the closest two
   polylines come is at a station of one of them). at: where it is thinnest,
   (r, h) in the meridian - h along the axis out from the end. */
function NSO_teWallAlong(Om, Im) {
  var lo = Infinity, hi = -Infinity, n = 0, at = null;
  function one(A, B) {
    for (var i = 0; i < A.length; i++) {
      var best = Infinity;
      for (var j = 0; j + 1 < B.length; j++) { var d = NSO_teSegDist(A[i], B[j], B[j + 1]).d; if (d < best) best = d; }
      n++; if (best > hi) hi = best;
      if (best < lo - 1e-9) { lo = best; at = { r: A[i][0], h: A[i][1] }; }
    }
  }
  one(Om, Im); one(Im, Om);
  return { lo: lo, hi: hi, n: n, at: at };
}

/* =====================================================================
   6. Clearance: the new wall against the piece, and against itself

   The new wall is a surface of revolution, so the distance from any point X
   to it is a distance in X's own meridian half-plane: X -> (r, h), then the
   2D distance to the new region (0 inside). That map is 1-Lipschitz, so on a
   triangle of the piece g(centroid) - (bound) >= gap clears the whole
   triangle, and anything not cleared is split across its longest edge until
   it is, or is small enough (NSO_TE_CLEAR_RES_MM) to call on its centre - so
   the clearance is read to within twice that.

   The piece meets the new wall at the ring, and must. That contact is not a
   touch: within ZONE = 2.5 gaps of the ring segment Pi-Po, the distance has
   (ZONE - distance to the ring) added to it. The old wall just under the ring
   then reads about ZONE (its distance to the new wall plus its distance to
   the zone's edge), more than the gap, while anything outside the zone - the
   tube's wall further down, a flange, the body of a vase - is read as it is.
   g = D + E is 2-Lipschitz; the bound uses that.
   ===================================================================== */

function NSO_teClearance(soup, skip, end, poly, ring, gap) {
  var C = end.center, a = end.axis, zone = NSO_TE_ZONE_GAPS * gap, res = NSO_TE_CLEAR_RES_MM;
  var np = poly.length, PX = new Float64Array(np), PY = new Float64Array(np);
  var hmin = Infinity, hmax = -Infinity;
  for (var q = 0; q < np; q++) { PX[q] = poly[q][0]; PY[q] = poly[q][1]; if (PY[q] < hmin) hmin = PY[q]; if (PY[q] > hmax) hmax = PY[q]; }
  var Rx0 = ring[0][0], Ry0 = ring[0][1], Rex = ring[1][0] - Rx0, Rey = ring[1][1] - Ry0, RL2 = Rex * Rex + Rey * Rey;
  var evals = 0, best = { g: Infinity, at: null }, hit = null, n = (soup.length / 9) | 0, gr = 0, gh = 0;
  function g(x, y, z) {
    evals++;
    var wx = x - C[0], wy = y - C[1], wz = z - C[2], h = wx * a[0] + wy * a[1] + wz * a[2];
    var ux = wx - h * a[0], uy = wy - h * a[1], uz = wz - h * a[2], r = Math.sqrt(ux * ux + uy * uy + uz * uz);
    gr = r; gh = h;
    // distance to the region's outline, and whether (r, h) is inside it
    var d2 = Infinity, inside = false;
    for (var i = 0, j = np - 1; i < np; j = i++) {
      var ax = PX[j], ay = PY[j], ex = PX[i] - ax, ey = PY[i] - ay, L2 = ex * ex + ey * ey;
      var tt = L2 > 0 ? ((r - ax) * ex + (h - ay) * ey) / L2 : 0;
      if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
      var dx = r - ax - tt * ex, dy = h - ay - tt * ey, dd = dx * dx + dy * dy;
      if (dd < d2) d2 = dd;
      if ((PY[i] > h) !== (ay > h) && r < (ax - PX[i]) * (h - PY[i]) / (ay - PY[i]) + PX[i]) inside = !inside;
    }
    var D = inside ? 0 : Math.sqrt(d2);
    var t2 = RL2 > 0 ? ((r - Rx0) * Rex + (h - Ry0) * Rey) / RL2 : 0;
    if (t2 < 0) t2 = 0; else if (t2 > 1) t2 = 1;
    var zx = r - Rx0 - t2 * Rex, zy = h - Ry0 - t2 * Rey, dz = Math.sqrt(zx * zx + zy * zy);
    return D + (dz < zone ? zone - dz : 0);
  }
  var stack = [];
  for (var t = 0; t < n && !hit; t++) {
    if (skip[t]) continue;
    var o = t * 9, h0 = Infinity, h1 = -Infinity;
    for (var k = 0; k < 3; k++) {
      var hh = (soup[o + k * 3] - C[0]) * a[0] + (soup[o + k * 3 + 1] - C[1]) * a[1] + (soup[o + k * 3 + 2] - C[2]) * a[2];
      if (hh < h0) h0 = hh; if (hh > h1) h1 = hh;
    }
    if (h1 < hmin - gap || h0 > hmax + gap) continue;
    stack.length = 0;
    stack.push([soup[o], soup[o + 1], soup[o + 2], soup[o + 3], soup[o + 4], soup[o + 5], soup[o + 6], soup[o + 7], soup[o + 8]]);
    while (stack.length) {
      var T = stack.pop();
      var cx = (T[0] + T[3] + T[6]) / 3, cy = (T[1] + T[4] + T[7]) / 3, cz = (T[2] + T[5] + T[8]) / 3;
      var rad = Math.sqrt(Math.max((T[0] - cx) * (T[0] - cx) + (T[1] - cy) * (T[1] - cy) + (T[2] - cz) * (T[2] - cz),
                                   (T[3] - cx) * (T[3] - cx) + (T[4] - cy) * (T[4] - cy) + (T[5] - cz) * (T[5] - cz),
                                   (T[6] - cx) * (T[6] - cx) + (T[7] - cy) * (T[7] - cy) + (T[8] - cz) * (T[8] - cz)));
      var G = g(cx, cy, cz);
      if (G < best.g) best = { g: G, at: [gr, gh] };
      if (G - 2 * rad >= gap) continue;
      if (rad <= res) { if (G < gap) { hit = { g: G, r: gr, h: gh, tri: t }; break; } continue; }
      if (evals > NSO_TE_CLEAR_EVALS) return { ok: false, unfinished: true, evals: evals };
      // split the longest edge: a tube's wall is long slivers, and halving
      // all three edges would keep them slivers all the way down
      var l0 = (T[3] - T[0]) * (T[3] - T[0]) + (T[4] - T[1]) * (T[4] - T[1]) + (T[5] - T[2]) * (T[5] - T[2]);
      var l1 = (T[6] - T[3]) * (T[6] - T[3]) + (T[7] - T[4]) * (T[7] - T[4]) + (T[8] - T[5]) * (T[8] - T[5]);
      var l2 = (T[0] - T[6]) * (T[0] - T[6]) + (T[1] - T[7]) * (T[1] - T[7]) + (T[2] - T[8]) * (T[2] - T[8]);
      var e = l0 >= l1 && l0 >= l2 ? 0 : (l1 >= l2 ? 1 : 2), i0 = e * 3, i1 = ((e + 1) % 3) * 3, i2 = ((e + 2) % 3) * 3;
      var mx = (T[i0] + T[i1]) / 2, my = (T[i0 + 1] + T[i1 + 1]) / 2, mz = (T[i0 + 2] + T[i1 + 2]) / 2;
      stack.push([T[i0], T[i0 + 1], T[i0 + 2], mx, my, mz, T[i2], T[i2 + 1], T[i2 + 2]],
                 [mx, my, mz, T[i1], T[i1 + 1], T[i1 + 2], T[i2], T[i2 + 1], T[i2 + 2]]);
    }
  }
  return { ok: !hit, hit: hit, closest: best, evals: evals };
}

/* The new wall against itself: two stretches of its outline that are far
   apart along the outline (more than 2 (t + gap)) may not come within a gap.
   Only a roll can come back on itself: a flare climbs monotonically along
   the wall's direction, so every level crosses it once. */
function NSO_teSelfClearance(poly, t, gap) {
  var n = poly.length, cum = [0];
  for (var i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(poly[(i + 1) % n][0] - poly[i][0], poly[(i + 1) % n][1] - poly[i][1]));
  var per = cum[n], tau = 2 * (t + gap), worst = Infinity;
  // edge a runs cum[a]..cum[a+1] round the outline; b > a. The gap between
  // them along the outline, whichever way round is shorter:
  for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) {
    var sep = Math.min(cum[b] - cum[a + 1], per - cum[b + 1] + cum[a]);
    if (sep <= tau) continue;
    var d = NSO_teSegSeg(poly[a], poly[(a + 1) % n], poly[b], poly[(b + 1) % n]);
    if (d < worst) worst = d;
  }
  return { ok: !(worst < gap), closest: worst };
}

/* =====================================================================
   7. The treatment

   opts.verb       'flare' | 'roll'
   opts.point      [x, y, z] raw: the end nearest it (blank: the top end)
   opts.direction  'out' (the default) | 'in': a flare turns toward the axis
                   (a Roll refuses it: not yet)
   opts.walls      'both' (the default) | 'outside' | 'bore' (Flare)
   flare: opts.length (mm along the wall), opts.angle (°) or opts.dr (mm; wins
          when both are given; below 0 turns inward), opts.profile
          'straight' | 'trumpet', opts.runMm (mm of straight tube on past the
          lip, along the axis at the lip's outside and bore; 0 or blank: none)
   roll:  opts.radius (mm, the bead's inside), opts.angle (°, up to 360);
          a runMm over 0 refuses
   opts.nozzle     mm, default NSO_Thickness.NOZZLE_DEFAULT
   opts.read       a reading from NSO_tubeEdgeRead to reuse

   Returns { ok, reason, tris, ... }. On refusal tris is the ORIGINAL soup.
   ===================================================================== */
function NSO_tubeEdgeRaw(soup, opts) {
  opts = opts || {};
  if (opts.verb === 'flare') return NSO_tubeEdgeFlare(soup, opts);
  if (opts.verb === 'reducer') return NSO_tubeEdgeReducer(soup, opts.read || opts.point || null, opts);
  return NSO_teTreat(soup, opts);
}

/* THE REDUCER. end: a reading from NSO_tubeEdgeRead (reused when it is this
   soup's), a point [x, y, z] (the end nearest it), or null (the top end).
   ro: { od2, id2 (mm, the new outside and bore Ø), transitionMm, runMm,
   profile 'straight' | 'trumpet', nozzle }. Returns Flare's contract:
   { ok, reason, tris, end, wall, run, meridian, reducer, ... }; on refusal
   tris is the ORIGINAL soup. */
function NSO_tubeEdgeReducer(soup, end, ro) {
  var o = {}, k;
  ro = ro || {};
  for (k in ro) if (k !== 'read' && k !== '_flare' && k !== '_oneFace' && k !== '_exact' && k !== 'section') o[k] = ro[k];
  o.verb = 'reducer';
  // a reading that is not this soup's is read again, at ro.point
  if (end && end.ok !== undefined) o.read = end;
  else if (end && end.length === 3) o.point = end;
  else if (end && end.point) o.point = end.point;
  return NSO_teTreat(soup, o);
}

/* FLARE, a thin wrapper round the reducer: Way / Angle / Δr / Walls / Length /
   Run are converted into the reducer's od2 / id2 / transitionMm / runMm, and
   the reducer builds it. Where each face lands is where Flare always put it:
   the face that moves stood Δr off its own line at u0 + Length, in the wall's
   own frame; the other face on its line (Walls: one face) or the moving face's
   offset a wall away (Both - the reducer's carried section, cut square to the
   wall at u0 + Length, the old lip cut). Flare's own refusals are made here,
   before the reducer is called, in Flare's words. */
function NSO_tubeEdgeFlare(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: 'flare' };
  var f32in = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  var rd = opts.read && opts.read.ok && opts.read.soup === soup ? opts.read : NSO_tubeEdgeRead(f32in, opts);
  res.read = rd;
  if (!rd.ok) { res.reason = rd.reason; return res; }
  var end = rd.end, nozzle = NSO_teNozzle(opts);
  res.end = end; res.nozzleMm = nozzle;
  function no(why) { res.reason = why; return res; }
  var run = NSO_teRun(opts);
  if (!(run >= 0)) return no('enter a run length in mm, 0 or more (0: no run past the lip)');
  var L = +opts.length, prof = opts.profile === 'trumpet' ? 'trumpet' : 'straight', dr, walls = NSO_teWalls(opts);
  if (!walls) return no('Walls is Both, Outside only or Bore only');
  if (!(L > 0) || !isFinite(L)) return no('enter a flare length in mm, more than 0');
  if (opts.dr != null && opts.dr !== '' && isFinite(+opts.dr)) dr = +opts.dr;
  else if (opts.angle != null && opts.angle !== '' && isFinite(+opts.angle)) dr = L * Math.tan(NSO_teRad(+opts.angle));
  else return no('enter the flare\'s angle or its Δr');
  if (opts.direction === 'in' && dr > 0) dr = -dr;              // Way: In turns the same flare toward the axis
  if (dr === 0) return no('a 0° flare is no flare - give it an angle or a Δr: above 0 turns it out, below 0 in');
  var th = Math.atan2(Math.abs(dr), L);
  if (NSO_teDeg(th) > NSO_TE_MAX_FLARE_DEG + 1e-9) {
    return no('a ' + NSO_teFmt(NSO_teDeg(th), 1) + '° flare is past the ' + NSO_TE_MAX_FLARE_DEG + '° limit - the lip would stand out nearly flat. Use a Roll for a turned-over edge');
  }
  var t = end.wallMm, lean = NSO_teRad(end.leanDeg), u0 = Math.max(0, -end.rimMm * Math.sin(lean));
  var fl = { lengthMm: L, drMm: dr, angleDeg: NSO_teDeg(th) * (dr < 0 ? -1 : 1), profile: prof, walls: walls, runMm: run };
  // a face's Ø at the lip, from its local v there
  var lipD = function (v) { return 2 * NSO_teToMeridian(end, lean, [v, u0 + L])[0]; };
  var spec = { verb: 'reducer', read: rd, nozzle: opts.nozzle, transitionMm: L, runMm: run, profile: prof, _flare: fl };
  // the Ø are what the reducer is given; _exact carries the Δr they came
  // from to the bit, so the faces are built from the very numbers Flare always
  // built them from (the pinned hashes)
  if (walls === 'both') {
    spec.section = 'carried';
    if (dr > 0) { spec.od2 = lipD(dr); spec._exact = { dvO: dr }; }
    else { spec.id2 = lipD(-t + dr); spec._exact = { dvI: dr }; }
  } else {
    var ow = NSO_teOneFaceWall(walls, t, dr, nozzle, ' at the lip');
    if (!ow.ok) { res.oneFace = ow; return no(ow.reason); }
    spec._oneFace = ow;
    spec.od2 = lipD(walls === 'outside' ? dr : 0);
    spec.id2 = lipD(walls === 'bore' ? -t + dr : -t);
    spec._exact = { dvO: walls === 'outside' ? dr : 0, dvI: walls === 'bore' ? dr : 0 };
  }
  return NSO_teTreat(soup, spec);
}

/* The treatment, every verb's: the reducer (Flare's too), the roll. */
function NSO_teTreat(soup, opts) {
  var res = { ok: false, reason: '', tris: soup, verb: opts._flare ? 'flare' : opts.verb };
  var f32in = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  var rd = opts.read && opts.read.ok && opts.read.soup === soup ? opts.read : NSO_tubeEdgeRead(f32in, opts);
  res.read = rd;
  if (!rd.ok) { res.reason = rd.reason; return res; }
  var end = rd.end, W = rd.weld, nozzle = NSO_teNozzle(opts), gap = NSO_TE_GAP_NOZZLES * nozzle;
  res.end = end; res.nozzleMm = nozzle;

  var pr = NSO_teProfile(end, opts);
  res.profile = pr;
  if (!pr.ok) { res.reason = pr.reason; return res; }
  var t = pr.t, lean = pr.lean;
  var Pi0 = [end.Ri, 0], Po0 = [end.Ro, 0];
  var Om = pr.O.map(function (q) { return NSO_teToMeridian(end, lean, q); });
  var Im = pr.I.map(function (q) { return NSO_teToMeridian(end, lean, q); });
  Om[0] = Po0; Im[0] = Pi0;
  var Mm = pr.mid.map(function (q) { return NSO_teToMeridian(end, lean, q); });

  // ---- the run: a straight tube on past the lip, at the lip's outside and
  // bore exactly, parallel to the axis, Run mm from the lip's plane (its
  // higher corner, where a leaning wall tilts it) and cut square to the axis.
  // One more station on each face, so the run shares the lip ring's edges and
  // the lip face moves to the run's end. The flare's own checks below see the
  // flare alone (nFO / nFI stations); the region, the clearance, the volume
  // and the build see the run too ----
  var run = pr.runMm || 0, nFO = Om.length, nFI = Im.length;
  if (run > 0) {
    var lipO = Om[nFO - 1], lipI = Im[nFI - 1], hRun = Math.max(lipO[1], lipI[1]) + run;
    Om.push([lipO[0], hRun]); Im.push([lipI[0], hRun]);
    res.run = { lengthMm: run, outerRadiusMm: lipO[0], boreRadiusMm: lipI[0], wallMm: lipO[0] - lipI[0], endH: hRun,
                joinDeg: Math.abs(pr.lipAngleDeg) };
  }
  var runWords = run > 0 ? ' and down its ' + NSO_teFmt(run, 1) + ' mm run' : '';
  var own = pr.reducer && !pr.flare;          // the reducer's own, not Flare through it
  if (own) {
    // THE FLOOR, along the whole new wall - the transition and the run. The
    // faces are built directly, so the wall square to them is not the targets'
    // difference through the transition: two parallel cones a wall t apart
    // across the axis are t cos(angle) apart square to their slope. Every
    // station of each face against the other face's whole polyline - the
    // closest two polylines come is at a station of one of them.
    var lipOr = Om[nFO - 1][0], lipIr = Im[nFI - 1][0], tEnd = lipOr - lipIr, fr = NSO_teFloor(nozzle);
    pr.reducer.od2Mm = 2 * lipOr; pr.reducer.id2Mm = 2 * lipIr; pr.reducer.wallEndMm = tEnd;
    if (fr == null) { res.reason = 'nso_thickness.js must be loaded - a reducer\'s wall is held to its nozzle-safety floor, and carries no copy of it'; return res; }
    var wa = NSO_teWallAlong(Om, Im);
    res.wall = { minMm: wa.lo, maxMm: wa.hi, stations: wa.n, ringMm: t, endMm: tEnd, floorMm: fr, thinnestAt: wa.at };
    var flo = '; the floor is ' + NSO_teFmt(fr) + ' mm (nso_thickness.js: one extrusion line at a ' + nozzle + ' mm nozzle)';
    if (tEnd < fr - 1e-9) {
      res.reason = 'the wall at the end would be ' + NSO_teFmt(tEnd) + ' mm (Ø' + NSO_teFmt(2 * lipOr) + ' outside, bore Ø' + NSO_teFmt(2 * lipIr) + ')' + (run > 0 ? ', and down its ' + NSO_teFmt(run, 1) + ' mm run' : '') + flo +
        '. With this outside the bore may be Ø' + NSO_teFmt(Math.floor((2 * lipOr - 2 * fr) * 100) / 100) + ' at most';
      return res;
    }
    if (wa.lo < fr - 1e-9) {
      res.reason = 'the wall would thin to ' + NSO_teFmt(wa.lo) + ' mm in the transition, ' + NSO_teFmt(wa.at.h, 1) + ' mm out from the end (measured square to its faces, at ' +
        NSO_teFmt(pr.reducer.angleOuterDeg, 1) + '° outside and ' + NSO_teFmt(pr.reducer.angleBoreDeg, 1) + '° bore)' + flo + '. Use a longer transition';
      return res;
    }
  }

  // ---- the thin-wall rule ----
  var r0 = (end.Ro + end.Ri) / 2, rMax = r0;
  Mm.forEach(function (q) { if (q[0] > rMax) rMax = q[0]; });
  var stretch = rMax / r0, thinned = t / stretch, floor = NSO_TE_STRETCH_NOZZLES * nozzle;
  res.stretch = { factor: stretch, thinnedMm: thinned, floorMm: floor, fromMm: 2 * r0, toMm: 2 * rMax };
  if (thinned < floor - 1e-9) {
    res.reason = 'the wall is too thin to ' + (opts.verb === 'roll' ? 'roll' : 'flare') + ' that far - pushing a ' + NSO_teFmt(t) +
      ' mm wall out from Ø' + NSO_teFmt(2 * r0) + ' to Ø' + NSO_teFmt(2 * rMax) + ' (mid-wall) stretches it ' + NSO_teFmt(stretch) +
      '× round its hoop, which would thin it to ' + NSO_teFmt(thinned) + ' mm, under ' + NSO_TE_STRETCH_NOZZLES + ' nozzle widths (' +
      NSO_teFmt(floor) + ' mm at a ' + nozzle + ' mm nozzle). The rule: wall × (ring radius ÷ largest radius) must stay at or above ' +
      NSO_TE_STRETCH_NOZZLES + ' nozzle widths';
    var most = thinned > 0 ? t * r0 / floor : 0;
    if (most > r0) res.reason += ' - this wall can go out to Ø' + NSO_teFmt(2 * most) + ' mid-wall';
    else res.reason += ' - this wall is too thin to push out at all';
    return res;
  }

  // ---- the bore limit: a turn toward the axis may narrow the bore to no
  // less than 2 nozzle widths across, Neck's rule for its waist. A run's
  // bore is the lip's, so it is held to the same limit, before building ----
  var boreR = Infinity;
  Im.forEach(function (q) { if (q[0] < boreR) boreR = q[0]; });
  var boreMin = NSO_TE_BORE_NOZZLES * nozzle;
  res.lipBoreRadiusMm = Im[Im.length - 1][0];
  if (own && 2 * boreR < boreMin - 1e-5) {
    res.reason = 'that ' + (pr.reducer.kind === 'expander' ? 'expander' : 'reducer') + ' would close the bore - a new bore of Ø' + NSO_teFmt(2 * boreR) +
      ' is under the bore limit of Ø' + NSO_teFmt(boreMin) + ' (' + NSO_TE_BORE_NOZZLES + ' nozzle widths at a ' + NSO_teFmt(nozzle, 1) + ' mm nozzle)';
    return res;
  }
  if (boreR < end.Ri - 1e-9 && 2 * boreR < boreMin - 1e-5) {                 // 1e-5: a float32 radius's last bit
    res.reason = 'that flare would close the bore - the Ø' + NSO_teFmt(2 * end.Ri) + ' bore would come to ' + (boreR > 0 ? 'Ø' + NSO_teFmt(2 * boreR) : 'nothing') +
      ' at the lip' + runWords + ', under the bore limit of Ø' + NSO_teFmt(boreMin) + ' (' + NSO_TE_BORE_NOZZLES + ' nozzle widths at a ' + NSO_teFmt(nozzle, 1) +
      ' mm nozzle). Use a shorter or a shallower flare';
    return res;
  }

  // ---- the new meridian region ----
  var poly = Om.concat(Im.slice().reverse());
  var ring = [Pi0, Po0];
  if (opts.verb === 'roll') {
    var sc = NSO_teSelfClearance(poly, t, gap);
    res.selfClearanceMm = sc.closest;
    if (!sc.ok) {
      res.reason = 'rolling ' + NSO_teFmt(+opts.angle, 0) + '° brings the wall back within ' + NSO_teFmt(sc.closest) + ' mm of itself - under the ' +
        NSO_teFmt(gap) + ' mm clearance (one nozzle width)';
      return res;
    }
  }
  var skip = new Uint8Array(W.n);
  end.face.forEach(function (q) { skip[q] = 1; });
  var cl = NSO_teClearance(f32in, skip, end, poly, ring, gap);
  res.clearance = cl;
  if (!cl.ok) {
    if (cl.unfinished) { res.reason = 'the piece is too large to prove the new wall clears it (' + cl.evals + ' distance checks) - nothing was changed'; return res; }
    var what = cl.hit.h < -1e-6 ? NSO_teFmt(-cl.hit.h, 1) + ' mm below the end' : NSO_teFmt(cl.hit.h, 1) + ' mm out from the end';
    res.reason = (opts.verb === 'roll' ? 'rolling ' + NSO_teFmt(+opts.angle, 0) + '°' : 'that ' + (own ? (pr.reducer.kind === 'expander' ? 'expander' : 'reducer') : 'flare') + (run > 0 ? ' and its run' : '')) +
      (cl.hit.g <= 0 ? ' would run the new wall into the piece' : ' would bring the new wall within ' + NSO_teFmt(cl.hit.g) + ' mm of the piece') +
      ' (' + what + ', ' + NSO_teFmt(cl.hit.r, 1) + ' mm from the axis) - it may come no closer than ' + NSO_teFmt(gap) + ' mm (one nozzle width)';
    if (opts.verb === 'roll') {
      var lo = 0, hi = +opts.angle;
      for (var it = 0; it < 9; it++) {
        var midA = (lo + hi) / 2, o2 = {}; for (var kk in opts) o2[kk] = opts[kk];
        o2.angle = midA; o2.read = rd;
        var p2 = NSO_teProfile(end, o2);
        var Om2 = p2.O.map(function (q) { return NSO_teToMeridian(end, lean, q); }), Im2 = p2.I.map(function (q) { return NSO_teToMeridian(end, lean, q); });
        Om2[0] = Po0; Im2[0] = Pi0;
        var poly2 = Om2.concat(Im2.slice().reverse());
        var ok2 = NSO_teSelfClearance(poly2, t, gap).ok && NSO_teClearance(f32in, skip, end, poly2, ring, gap).ok;
        if (ok2) lo = midA; else hi = midA;
      }
      if (lo >= 1) { res.maxAngleDeg = Math.floor(lo); res.reason += '. At this radius it rolls up to ' + Math.floor(lo) + '°'; }
    } else if (own) res.reason += run > 0 ? '. Use a shorter run, or a smaller change of Ø' : '. Use a smaller change of Ø';
    else res.reason += run > 0 ? '. Use a shorter run, or a shorter or shallower flare' : '. Use a shorter or a shallower flare';
    return res;
  }

  // ---- the wall through the new section, on the construction: the flare's
  // own stations (a run's wall is the lip's width, by construction) ----
  var fO = Om.slice(0, nFO), fI = Im.slice(0, nFI);
  if (pr.walls) {
    // one face moved: the wall runs from t at the ring to the lip's wall
    // (the face moved by dr against the other's line), and nowhere under the
    // lesser of the two - every new station against the other face
    var ow = NSO_teOneFaceWallCheck(fO, fI), tl = pr.oneFace.wallMm;
    res.wall = { minMm: ow.lo, maxMm: ow.hi, stations: ow.n, wantMm: tl, ringMm: t, lipMm: tl, floorMm: pr.oneFace.floorMm };
    if (!(ow.n > 0 && ow.lo >= Math.min(t, tl) - NSO_TE_WALL_TOL_MM && ow.hi <= Math.max(t, tl) + NSO_TE_WALL_TOL_MM && ow.lo >= pr.oneFace.floorMm - NSO_TE_WALL_TOL_MM)) {
      res.reason = 'internal: the new wall reads ' + NSO_teFmt(ow.lo, 3) + '–' + NSO_teFmt(ow.hi, 3) + ' mm, not between ' + NSO_teFmt(Math.min(t, tl), 3) + ' and ' + NSO_teFmt(Math.max(t, tl), 3);
      return res;
    }
  }
  var wall = pr.walls || own ? null : NSO_teWallCheck(fO, fI);
  if (wall) res.wall = { minMm: wall.lo, maxMm: wall.hi, stations: wall.n, wantMm: t };
  if (wall && !(wall.lo >= t - NSO_TE_WALL_TOL_MM && wall.hi <= t + NSO_TE_WALL_TOL_MM)) {
    res.reason = 'internal: the new wall is ' + NSO_teFmt(wall.lo, 3) + '–' + NSO_teFmt(wall.hi, 3) + ' mm against a ' + NSO_teFmt(t, 3) + ' mm wall';
    return res;
  }

  // ---- build ----
  var built = NSO_teBuild(f32in, W, end, Om, Im);
  if (!built.ok) { res.reason = built.reason; return res; }
  var out = built.tris;
  res.counts = { trisIn: W.n, trisOut: out.length / 9, removed: end.face.length, added: built.added };
  if (res.counts.trisOut > NSO_TE_MAX_TRIS) {
    res.reason = 'the result would have ' + res.counts.trisOut + ' triangles, past the ' + NSO_TE_MAX_TRIS + ' limit';
    return res;
  }

  // ---- gates, on the output ----
  if (typeof NSO_bendTopology === 'function') {
    var T0 = NSO_bendTopology(f32in), T1 = NSO_bendTopology(out);
    res.topology = { before: T0, after: T1 };
    if (T1.open > T0.open || T1.nm > T0.nm || T1.flip > T0.flip || T1.degen > T0.degen || T1.euler !== T0.euler) {
      res.reason = 'internal: the result is not welded (open ' + T0.open + '→' + T1.open + ', non-manifold ' + T0.nm + '→' + T1.nm +
        ', flipped ' + T0.flip + '→' + T1.flip + ', zero-area ' + T0.degen + '→' + T1.degen + ', Euler ' + T0.euler + '→' + T1.euler + ')';
      return res;
    }
  }
  var vol0 = NSO_teVolume(f32in, end.center), vol1 = NSO_teVolume(out, end.center);
  var pappus = 0;
  for (var pi = 0; pi < poly.length; pi++) {
    var A = poly[pi], B = poly[(pi + 1) % poly.length];
    pappus += (B[1] - A[1]) * (A[0] * A[0] + A[0] * B[0] + B[0] * B[0]) / 3;
  }
  pappus = Math.PI * pappus;      // the outline runs up the outside, round the lip, down the inside: counter-clockwise in (r, h)
  var nSeg = end.outer.length, pf = nSeg * Math.sin(2 * Math.PI / nSeg) / (2 * Math.PI);
  res.volume = { before: vol0, after: vol1, added: vol1 - vol0, pappus: pappus * pf };
  if (!(Math.abs((vol1 - vol0) - pappus * pf) <= NSO_TE_VOLUME_TOL * Math.abs(pappus * pf))) {
    res.reason = 'internal: the added volume ' + NSO_teFmt(vol1 - vol0, 1) + ' mm³ is not the section\'s ' + NSO_teFmt(pappus * pf, 1) + ' mm³ swept round';
    return res;
  }

  var lipR = 0; Om.forEach(function (q) { if (q[0] > lipR) lipR = q[0]; });
  res.ok = true;
  res.tris = out;
  res.wallMm = t;
  res.lipOuterRadiusMm = Om[Om.length - 1][0];
  res.maxOuterRadiusMm = Math.max(lipR, Im.reduce(function (m, q) { return Math.max(m, q[0]); }, 0));
  res.lipAngleDeg = pr.lipAngleDeg;
  res.meridian = { outer: Om, inner: Im };
  if (pr.beadCenterLocal) res.beadCenter = NSO_teToMeridian(end, lean, pr.beadCenterLocal);
  if (pr.flare) res.flare = pr.flare;
  if (pr.roll) res.roll = pr.roll;
  if (pr.reducer) {
    res.reducer = pr.reducer;
    if (!own) { pr.reducer.od2Mm = 2 * Om[nFO - 1][0]; pr.reducer.id2Mm = 2 * Im[nFI - 1][0]; pr.reducer.wallEndMm = Om[nFO - 1][0] - Im[nFI - 1][0]; }
  }
  res.reason = NSO_tubeEdgeDescribe(res);
  return res;
}

function NSO_teVolume(s, ref) {
  var v = 0, rx = ref[0], ry = ref[1], rz = ref[2];
  for (var o = 0; o + 8 < s.length; o += 9) {
    var ax = s[o] - rx, ay = s[o + 1] - ry, az = s[o + 2] - rz, bx = s[o + 3] - rx, by = s[o + 4] - ry, bz = s[o + 5] - rz;
    var cx = s[o + 6] - rx, cy = s[o + 7] - ry, cz = s[o + 8] - rz;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/* The new wall: each end loop's vertices carried along their own radial
   lines through the stations, the bands between, and the lip zipped round
   between the two last rings. Everything but the end face is copied. */
function NSO_teBuild(soup, W, end, Om, Im) {
  var P = W.P, C = end.center, a = end.axis, f32 = NSO_teF32;
  function rings(loop, M, base) {
    var R = [];
    for (var i = 0; i < M.length; i++) R.push(new Float32Array(loop.length * 3));
    for (var j = 0; j < loop.length; j++) {
      var v = loop[j] * 3, X = P[v], Y = P[v + 1], Z = P[v + 2];
      var w = [X - C[0], Y - C[1], Z - C[2]], h = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
      var e = [w[0] - h * a[0], w[1] - h * a[1], w[2] - h * a[2]], el = Math.hypot(e[0], e[1], e[2]);
      e = [e[0] / el, e[1] / el, e[2] / el];
      R[0][j * 3] = X; R[0][j * 3 + 1] = Y; R[0][j * 3 + 2] = Z;
      for (var i2 = 1; i2 < M.length; i2++) {
        var dr = M[i2][0] - base[0], dh = M[i2][1] - base[1];
        R[i2][j * 3] = f32(X + dr * e[0] + dh * a[0]);
        R[i2][j * 3 + 1] = f32(Y + dr * e[1] + dh * a[1]);
        R[i2][j * 3 + 2] = f32(Z + dr * e[2] + dh * a[2]);
      }
    }
    return R;
  }
  var RO = rings(end.outer, Om, [end.Ro, 0]), RI = rings(end.inner, Im, [end.Ri, 0]);
  var nO = end.outer.length, nI = end.inner.length;
  var bandTris = 2 * nO * (Om.length - 1) + 2 * nI * (Im.length - 1), lipTris = nO + nI;
  var keep = W.n - end.face.length, out = new Float32Array((keep + bandTris + lipTris) * 9), w = 0;
  var skip = new Uint8Array(W.n);
  end.face.forEach(function (q) { skip[q] = 1; });
  for (var t = 0; t < W.n; t++) {
    if (skip[t]) continue;
    for (var k = 0; k < 9; k++) out[w++] = soup[t * 9 + k];
  }
  function put(A, i, B, j, Cc, k) {
    out[w++] = A[i * 3]; out[w++] = A[i * 3 + 1]; out[w++] = A[i * 3 + 2];
    out[w++] = B[j * 3]; out[w++] = B[j * 3 + 1]; out[w++] = B[j * 3 + 2];
    out[w++] = Cc[k * 3]; out[w++] = Cc[k * 3 + 1]; out[w++] = Cc[k * 3 + 2];
  }
  // bands: each loop in the order the end face walked it, so its first band
  // walks every ring edge the way the end face did
  function bands(R, n) {
    for (var i = 0; i + 1 < R.length; i++) {
      for (var j = 0; j < n; j++) {
        var j1 = (j + 1) % n;
        put(R[i], j, R[i], j1, R[i + 1], j1);
        put(R[i], j, R[i + 1], j1, R[i + 1], j);
      }
    }
  }
  bands(RO, nO); bands(RI, nI);
  // the lip: the last outer ring as the end face walked it (counter-clockwise
  // about the axis), the last inner ring reversed to run the same way, zipped
  // by angle in the end face's own frame
  var LO = RO[RO.length - 1], LI = RI[RI.length - 1], fr = end.frame;
  function ang(v) {
    var x = P[v * 3] - C[0], y = P[v * 3 + 1] - C[1], z = P[v * 3 + 2] - C[2];
    return Math.atan2(x * fr.e2[0] + y * fr.e2[1] + z * fr.e2[2], x * fr.e1[0] + y * fr.e1[1] + z * fr.e1[2]);
  }
  var TWO = 2 * Math.PI, base = ang(end.outer[0]);
  function rel(v) { var d = ang(v) - base; d -= TWO * Math.floor(d / TWO); return d; }
  var ao = [];
  for (var j = 0; j < nO; j++) ao.push(j === 0 ? 0 : rel(end.outer[j]));
  ao.push(TWO);
  // inner, counter-clockwise: the face walked it clockwise
  var ccw = [];
  for (var m = 0; m < nI; m++) ccw.push((nI - m) % nI);
  var m0 = 0, bestA = Infinity;
  for (var m1 = 0; m1 < nI; m1++) {
    var d0 = rel(end.inner[ccw[m1]]); if (d0 > Math.PI) d0 -= TWO;
    if (Math.abs(d0) < bestA) { bestA = Math.abs(d0); m0 = m1; }
  }
  var ai = [], prevA = null;
  for (var q = 0; q <= nI; q++) {
    var idx = ccw[(m0 + q) % nI], av = rel(end.inner[idx]);
    if (q === 0) { if (av > Math.PI) av -= TWO; }
    else { while (av <= prevA) av += TWO; }
    if (q === nI) av = ai[0] + TWO;
    ai.push(av); prevA = av;
  }
  var jo = 0, ki = 0;
  while (jo < nO || ki < nI) {
    var pO = jo % nO, pO1 = (jo + 1) % nO, qI = ccw[(m0 + ki) % nI], qI1 = ccw[(m0 + ki + 1) % nI];
    if (jo < nO && (ki >= nI || ao[jo + 1] <= ai[ki + 1])) { put(LO, pO, LO, pO1, LI, qI); jo++; }
    else { put(LO, pO, LI, qI1, LI, qI); ki++; }
  }
  if (w !== out.length) return { ok: false, reason: 'internal: built ' + w / 9 + ' triangles, planned ' + out.length / 9 };
  return { ok: true, tris: out, added: bandTris + lipTris };
}

/* One line: what was done, the numbers that matter. */
function NSO_tubeEdgeDescribe(r) {
  if (r.reducer && !r.flare) return NSO_teReducerWords(r);
  var e = r.end, s = 'Ø' + NSO_teFmt(2 * e.Ro) + ' end, wall ' + NSO_teFmt(r.wallMm) + ' held (' + NSO_teFmt(r.wall.minMm, 3) + '–' +
    NSO_teFmt(r.wall.maxMm, 3) + ' mm through the new section)';
  var ru = r.run, tr = r.flare && r.flare.profile === 'trumpet';
  // a trumpet's lip is not parallel to the axis; the run is
  var join = ru && tr ? ' · joined at ' + NSO_teFmt(ru.joinDeg, 1) + '°, the trumpet\'s lip angle (the run is parallel to the axis)' : '';
  if (r.flare && r.flare.walls && r.flare.walls !== 'both') {
    // "Bore only: Ø30.47 → Ø36.47 at the lip, outside kept Ø40.62, wall 5.08 → 2.08 · ..."
    var bo = r.flare.walls === 'bore', mv = bo ? r.meridian.inner : r.meridian.outer, kp = bo ? r.meridian.outer : r.meridian.inner;
    return NSO_TE_WALLS_WORDS[r.flare.walls] + ': Ø' + NSO_teFmt(2 * mv[0][0]) + ' → Ø' + NSO_teFmt(2 * mv[mv.length - 1][0]) + ' at the lip, ' +
      (bo ? 'outside' : 'bore') + ' kept Ø' + NSO_teFmt(2 * kp[0][0]) + ', wall ' + NSO_teFmt(r.wall.ringMm) + ' → ' + NSO_teFmt(r.wall.lipMm) +
      ' · ' + (tr ? 'Trumpet' : 'Straight') + ' flare ' + NSO_teFmt(r.flare.lengthMm, 1) + ' mm at ' +
      (r.flare.angleDeg < 0 ? NSO_teSignedDp(r.flare.angleDeg, 1) : NSO_teFmt(r.flare.angleDeg, 1)) + '° (Δr ' + NSO_teSignedDp(r.flare.drMm) + ' mm) off the Ø' + NSO_teFmt(2 * e.Ro) + ' end' +
      (ru ? ', then ' + NSO_teFmt(ru.lengthMm, 1) + ' mm run at Ø' + NSO_teFmt(2 * ru.outerRadiusMm) + ' / bore Ø' + NSO_teFmt(2 * ru.boreRadiusMm) +
            ', wall ' + NSO_teFmt(ru.wallMm) + join : '');
  }
  if (ru) {
    // "Straight flare 21.0 mm at −36.0° inward, then 30.0 mm run at Ø21.84 / bore Ø15.56 · wall 2.54 held ..."
    var inward = r.flare.drMm < 0;
    return (tr ? 'Trumpet flare ' : 'Straight flare ') + NSO_teFmt(r.flare.lengthMm, 1) + ' mm at ' +
      (inward ? NSO_teSignedDp(r.flare.angleDeg, 1) + '° inward' : NSO_teFmt(r.flare.angleDeg, 1) + '° outward') + ', then ' + NSO_teFmt(ru.lengthMm, 1) +
      ' mm run at Ø' + NSO_teFmt(2 * ru.outerRadiusMm) + ' / bore Ø' + NSO_teFmt(2 * ru.boreRadiusMm) + ' · wall ' + NSO_teFmt(r.wallMm) + ' held (' +
      NSO_teFmt(r.wall.minMm, 3) + '–' + NSO_teFmt(r.wall.maxMm, 3) + ' mm through the flare; the run\'s wall ' + NSO_teFmt(ru.wallMm) +
      ', the lip\'s width)' + join + ' · Ø' + NSO_teFmt(2 * e.Ro) + ' end';
  }
  if (r.flare && r.flare.drMm < 0) {
    return (r.flare.profile === 'trumpet' ? 'Trumpet flare ' : 'Straight flare ') + NSO_teFmt(r.flare.lengthMm, 1) + ' mm at ' +
      NSO_teSignedDp(r.flare.angleDeg, 1) + '° (Δr ' + NSO_teSignedDp(r.flare.drMm) + ' mm), inward: lip bore Ø' + NSO_teFmt(2 * r.lipBoreRadiusMm) +
      ', outside Ø' + NSO_teFmt(2 * r.lipOuterRadiusMm) + (r.flare.profile === 'trumpet' ? ', ' + NSO_teFmt(r.lipAngleDeg, 1) + '° at the lip' : '') + ' · ' + s;
  }
  if (r.flare) {
    return (r.flare.profile === 'trumpet' ? 'Trumpet flare ' : 'Straight flare ') + NSO_teFmt(r.flare.lengthMm, 1) + ' mm at ' +
      NSO_teFmt(r.flare.angleDeg, 1) + '° (Δr ' + NSO_teFmt(r.flare.drMm) + ' mm): lip Ø' + NSO_teFmt(2 * r.lipOuterRadiusMm) +
      (r.flare.profile === 'trumpet' ? ', ' + NSO_teFmt(r.lipAngleDeg, 1) + '° at the lip' : '') + ' · ' + s;
  }
  return 'Roll ' + NSO_teFmt(r.roll.angleDeg, 0) + '° round a ' + NSO_teFmt(r.roll.radiusMm) + ' mm bead: Ø' + NSO_teFmt(2 * r.maxOuterRadiusMm) +
    ' across the bead · ' + s;
}

/* The reducer's line: "Reducer: Ø43.52 / bore Ø34.82 → Ø33.26 / bore Ø26.38
   over 12.1 mm (23.0° outside, 19.2° bore), then 7.5 mm run · wall 4.35 →
   3.44". The angles are each face's, derived (a Trumpet's where it ends). */
function NSO_teReducerWords(r) {
  var q = r.reducer, e = r.end, tr = q.profile === 'trumpet';
  var head = q.kind === 'straight' ? 'Straight on' : (q.kind === 'expander' ? 'Expander' : 'Reducer') +
    (q.faces === 'outside' ? ' (outside only)' : q.faces === 'bore' ? ' (bore only)' : '');
  var s = head + ': Ø' + NSO_teFmt(q.od1Mm) + ' / bore Ø' + NSO_teFmt(q.id1Mm) + ' → Ø' + NSO_teFmt(q.od2Mm) + ' / bore Ø' + NSO_teFmt(q.id2Mm);
  if (q.transitionMm > 0) {
    s += ' over ' + NSO_teFmt(q.transitionMm, 1) + ' mm' + (tr ? ', trumpet' : '') + ' (' + NSO_teFmt(q.angleOuterDeg, 1) + '° outside, ' +
      NSO_teFmt(q.angleBoreDeg, 1) + '° bore' + (tr ? ' where it ends' : '') + ')';
  }
  if (q.runMm > 0) s += (q.transitionMm > 0 ? ', then ' : ', ') + NSO_teFmt(q.runMm, 1) + ' mm run';
  s += ' · wall ' + NSO_teFmt(r.wallMm) + ' → ' + NSO_teFmt(q.wallEndMm);
  if (r.wall.minMm < Math.min(r.wallMm, q.wallEndMm) - 0.005) s += ' (' + NSO_teFmt(r.wall.minMm) + ' at the thinnest, square to the transition\'s faces)';
  return s;
}

/* The verbs, by name, for the card. */
var NSO_TubeEdge = { read: NSO_tubeEdgeRead, raw: NSO_tubeEdgeRaw, reducer: NSO_tubeEdgeReducer, flare: NSO_tubeEdgeFlare, describe: NSO_tubeEdgeDescribe };
