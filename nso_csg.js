/* ============================================================
   nso_csg.js - the boolean kernel, and where a boolean runs.

   Loads as a classic script: on the page, in the boolean worker (nso_work.js
   importScripts it), and in node (tools/nso_csg_node.js runs it in a vm).
   No DOM, no app state. THREE is read only by buildCutVolume, which the page
   and the worker both have.

   WHAT IS HERE. Everything the kernel route of Join, Subtract, Attach, Connect,
   Bridge and the support booleans stood on, moved out of app-join.js and
   app-finish.js UNCHANGED (git shows the move, not a rewrite): NSO_CSG, the weld
   helpers, the edge and manifold counts, and the three booleans' bodies. Three
   of them were renamed, because their old names are now the doors:

       NSO_unionCore       was NSO_unionSoups
       NSO_subtractCore    was NSO_subtractSoups
       NSO_punchCore       was subtractSoupBFromA
       nsoUnionCore, nsoSubtractCore   were nsoUnionSoups, nsoSubtractSoups (app-finish.js)

   WHERE A BOOLEAN RUNS. NSO_unionSoups, NSO_subtractSoups, subtractSoupBFromA,
   nsoUnionSoups and nsoSubtractSoups (and NSO_Crop.crop, nso_crop.js) keep their
   names, arguments and results. Each is async and each goes through NSO_boolRun:

     - both soups under NSO_BoolConfig.bigTris (50,000 triangles): the page's own
       thread, exactly as before, through the same async call. No round trip.
     - otherwise: a worker (NSO_Work channel 'bool'). The page copies the soups,
       posts the copies as transferables, the worker runs the SAME core on them and
       posts the result back moved, not copied. The page's thread stays free.
     - no worker to be had (node, a browser without one, a file not on the page):
       the page's thread, as before.

   While a worker runs: NSO_BoolBusy (app-bool-busy.js) shows the bar and the
   seconds, with no invented percent. Escape ends it (NSO_boolCancelAll): the
   worker is terminated and the next job starts a fresh one, and the caller gets
   the op's own refusal shape with cancelled: true - the piece is untouched, the
   result never arrives. A job that outlasts NSO_BoolConfig.watchdogMs (120 s) is
   ended the same way, with timedOut: true and a refusal in plain words.
   ============================================================ */

function NSO_soupLen(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }

/* ============================================================
   subtractSoupBFromA — soup-level pocket cut  (patched)
   ============================================================ */
/* =====================================================================
   NSO_CSG -- real solid boolean kernel adapter (Manifold, WASM)
   New code. Does not replace or call any existing centroid/ray logic.

   Loaded via dynamic import() from jsDelivr at call time (no bundler in
   this app). To vendor for real instead of CDN-loading:
     1. npm i manifold-3d
     2. copy node_modules/manifold-3d/manifold.js and manifold.wasm into
        your repo (e.g. /vendor/manifold/)
     3. point NSO_CSG_URL at that local manifold.js path
   The rest of this adapter is unchanged either way.
   ===================================================================== */

var NSO_CSG_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.3/manifold.js';

var NSO_CSG = (function () {
  var _wasmPromise = null;
  var _loading = false;    // the first load is a download the page can be clicked through (app-beds.js reads it)

  function load() {
    if (!_wasmPromise) {
      _loading = true;
      _wasmPromise = import(NSO_CSG_URL)
        .then(function (mod) { return (mod.default || mod)(); })
        .then(function (wasm) { wasm.setup(); _loading = false; return wasm; })
        .catch(function (err) {
          _wasmPromise = null; // don't cache a permanent failure -- allow retry next call
          _loading = false;
          throw err;
        });
    }
    return _wasmPromise;
  }

  // world-space triangle soup (Float32Array, 9 floats/tri, no shared index)
  // -> wasm Manifold. Calls Mesh.merge() to weld coincident corner
  // vertices, since soup has none shared -- this is what lets Manifold see
  // the input as a solid instead of N disconnected triangles.
  function soupToManifold(wasm, soup) {
    var n = (soup.length / 9) | 0;
    var vertProperties = (soup instanceof Float32Array) ? soup.slice() : new Float32Array(soup);
    var triVerts = new Uint32Array(n * 3);
    for (var i = 0; i < n * 3; i++) triVerts[i] = i;
    var mesh = new wasm.Mesh({ numProp: 3, vertProperties: vertProperties, triVerts: triVerts });
    mesh.merge();
    return new wasm.Manifold(mesh);
  }

  function manifoldToSoup(manifold) {
    var mesh = manifold.getMesh();
    var vp = mesh.vertProperties;
    var tv = mesh.triVerts;
    var numProp = mesh.numProp || 3;
    var out = new Float32Array(tv.length * 3);
    var w = 0;
    for (var t = 0; t < tv.length; t++) {
      var vi = tv[t] * numProp;
      out[w++] = vp[vi]; out[w++] = vp[vi + 1]; out[w++] = vp[vi + 2];
    }
    return out;
  }

  // Builds a solid box (as a real Manifold, via Manifold.cube) bounding the
  // region it's safe to cut into: from just outside the bit's own outer tip
  // (frame.capCoord, frame.axis/sign -- the bit's own local AABB, NOT the
  // hull's), inward along frame.punch, stopping `minWall` short of wherever
  // hull A's actual surface is found by ray-casting the real soup. This is
  // deliberately NOT based on frame.box for depth -- frame.box is the bit's
  // own bounding box (sized to the bit, ~mm), not the hull's, so it can't
  // tell us how thick the hull's wall actually is; only a real hit test
  // against aWorld can.
  // Samples 5 points across the bit's own footprint (center + 4 inset
  // corners) and takes the worst (shortest) safe depth, so a tilted or
  // uneven wall doesn't get punched through at one corner.
  // Returns a world-space Manifold, or null if the bit doesn't reach the
  // hull anywhere, or there's no room to cut within minWall.
  function buildCutVolume(wasm, frame, aWorld, minWall) {
    var axis = frame.axis, sign = frame.sign;
    var axB = (axis + 1) % 3, axC = (axis + 2) % 3;
    var box = frame.box; // bit's own local AABB -- used only for lateral (cross-section) sizing below

    var basisX = new THREE.Vector3(), basisY = new THREE.Vector3(), basisZ = new THREE.Vector3();
    frame.matrix.extractBasis(basisX, basisY, basisZ);
    var axisScale = [basisX, basisY, basisZ][axis].length() || 1; // local-unit -> world-mm for the punch axis

    var centerLocal = new THREE.Vector3();
    box.getCenter(centerLocal);
    centerLocal.setComponent(axis, frame.capCoord); // bit's own outer-tip face, centered on its cross-section

    var punch = frame.punch; // world unit vector, tip -> into the hull (already computed correctly upstream)
    var halfB = (box.max.getComponent(axB) - box.min.getComponent(axB)) / 2;
    var halfC = (box.max.getComponent(axC) - box.min.getComponent(axC)) / 2;
    var shrink = 0.85; // stay a little inboard of the bit's true edge for the probe rays
    var offsets = [
      [0, 0], [halfB * shrink, halfC * shrink], [halfB * shrink, -halfC * shrink],
      [-halfB * shrink, halfC * shrink], [-halfB * shrink, -halfC * shrink]
    ];

    var mouthPadWorld = Math.max(1, frame.span * 0.1);
    var lv = new THREE.Vector3(), wp = new THREE.Vector3();
    var minFarWorld = Infinity, anySample = false;

    for (var i = 0; i < offsets.length; i++) {
      lv.copy(centerLocal);
      lv.setComponent(axB, centerLocal.getComponent(axB) + offsets[i][0]);
      lv.setComponent(axC, centerLocal.getComponent(axC) + offsets[i][1]);
      wp.copy(lv).applyMatrix4(frame.matrix);
      var ox = wp.x - punch.x * mouthPadWorld, oy = wp.y - punch.y * mouthPadWorld, oz = wp.z - punch.z * mouthPadWorld;
      var hits = NSO_rayHitsSoup(aWorld, ox, oy, oz, punch.x, punch.y, punch.z);
      if (!hits.length) continue;
      var farWorld = hits[hits.length - 1] - mouthPadWorld; // distance from the tip (wp) to the far wall
      if (farWorld <= 0) continue;
      anySample = true;
      if (farWorld < minFarWorld) minFarWorld = farWorld;
    }

    if (!anySample) return null; // bit doesn't actually reach the hull anywhere along the punch direction

    var depthWorld = minFarWorld - minWall;
    if (depthWorld <= 0.2) return null; // no safe room to cut

    var depthLocal = depthWorld / axisScale;
    var mouthPadLocal = mouthPadWorld / axisScale;

    var lo = new THREE.Vector3(), hi = new THREE.Vector3();
    var lateralPad = Math.max(0.5, frame.span * 0.05);
    lo.setComponent(axB, box.min.getComponent(axB) - lateralPad);
    hi.setComponent(axB, box.max.getComponent(axB) + lateralPad);
    lo.setComponent(axC, box.min.getComponent(axC) - lateralPad);
    hi.setComponent(axC, box.max.getComponent(axC) + lateralPad);

    var outerLocal = frame.capCoord + sign * mouthPadLocal;   // just outside the bit's own tip
    var innerLocal = frame.capCoord - sign * depthLocal;      // depthWorld into the hull, minWall short of its far wall
    if (sign > 0) { lo.setComponent(axis, innerLocal); hi.setComponent(axis, outerLocal); }
    else { lo.setComponent(axis, outerLocal); hi.setComponent(axis, innerLocal); }

    var size = new THREE.Vector3().subVectors(hi, lo);
    var center = new THREE.Vector3().addVectors(lo, hi).multiplyScalar(0.5);
    var localTranslate = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
    var worldMat = frame.matrix.clone().multiply(localTranslate);

    var cube = wasm.Manifold.cube([Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3)], true);
    return cube.transform(Array.from(worldMat.elements));
  }

  return {
    load: load,
    loading: function () { return _loading; },
    soupToManifold: soupToManifold,
    manifoldToSoup: manifoldToSoup,
    buildCutVolume: buildCutVolume
  };
})();

// Möller-Trumbore ray/triangle-soup intersection. Returns sorted hit
// distances (t along the ray from origin, direction assumed unit length)
// for every triangle the ray crosses -- used to find where a punch ray
// actually enters/exits hull A's real surface, in place of any bounding
// box guess.
function NSO_rayHitsSoup(soup, ox, oy, oz, dx, dy, dz) {
  var hits = [];
  var n = (soup.length / 9) | 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
    var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
    var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    var pvx = dy * e2z - dz * e2y, pvy = dz * e2x - dx * e2z, pvz = dx * e2y - dy * e2x;
    var det = e1x * pvx + e1y * pvy + e1z * pvz;
    if (Math.abs(det) < 1e-9) continue;
    var invDet = 1 / det;
    var tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
    var u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    var qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
    var v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    var tt = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
    if (tt > 1e-6) hits.push(tt);
  }
  hits.sort(function (a, b) { return a - b; });
  return hits;
}

function NSO_errMsg(err) {
  return (err && err.message) ? String(err.message) : String(err);
}

// Open-edge / non-manifold-edge counts for a triangle soup. Vertex welding
// is by coordinate rounding (0.1 micron buckets), not topology -- this is a
// diagnostic count for the status line, not a watertight/valid claim.
function NSO_edgeStats(soup) {
  var n = (soup.length / 9) | 0;
  var q = 1e4;
  function key(o) {
    return Math.round(soup[o] * q) + '_' + Math.round(soup[o + 1] * q) + '_' + Math.round(soup[o + 2] * q);
  }
  var map = new Map();
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var k = [key(o), key(o + 3), key(o + 6)];
    for (var e = 0; e < 3; e++) {
      var a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;   // a sliver's zero-length edge is not a hole
      var ek = a < b ? (a + '|' + b) : (b + '|' + a);
      map.set(ek, (map.get(ek) || 0) + 1);
    }
  }
  var open = 0, nm = 0;
  map.forEach(function (count) {
    if (count === 1) open++;
    else if (count > 2) nm++;
  });
  return { open: open, nm: nm };
}

/* =====================================================================
   Exact topology, straight off the kernel's own indexed mesh.

   NSO_edgeStats has to weld by rounded position, because a soup carries no
   shared indices. Where two surfaces meet tangentially - two wrapped cubes
   kissing flat on flat - the union legitimately holds distinct vertices a
   fraction of a micron apart, and rounding merges them, so edges that are
   each used twice read as one edge used four times. That phantom is what
   refused a join whose result was a perfect solid: one part, genus 0,
   volume exactly A + B, 0 open and 0 non-manifold by index.

   A Manifold result already knows its own topology, so ask it instead of
   guessing from positions.
   ===================================================================== */
function NSO_manifoldStats(man) {
  var out = { open: 0, nm: 0, parts: 1, exact: false };
  try {
    var mesh = man.getMesh();
    var tv = mesh.triVerts;
    var em = new Map();
    for (var t = 0; t < tv.length; t += 3) {
      var k = [tv[t], tv[t + 1], tv[t + 2]];
      for (var e = 0; e < 3; e++) {
        var a = k[e], b = k[(e + 1) % 3];
        if (a === b) continue;
        var ek = a < b ? (a + '_' + b) : (b + '_' + a);
        em.set(ek, (em.get(ek) || 0) + 1);
      }
    }
    em.forEach(function (c) { if (c === 1) out.open++; else if (c > 2) out.nm++; });
    if (typeof man.decompose === 'function') {
      var bits = man.decompose();
      out.parts = bits.length;
      for (var i = 0; i < bits.length; i++) bits[i].delete();
    }
    out.exact = true;
  } catch (err) { out.exact = false; }
  return out;
}

/* =====================================================================
   Weld tolerance that cannot eat the piece's own detail.

   Both booleans pre-weld their input so a sloppy imported STL reads as a
   solid. A wrapped surface is far finer than those fixed tolerances: the
   ring beside each corner ball's pole carries 0.034 mm edges, so welding a
   wrap1 cube at 0.08 drops 128 triangles and at 0.22 drops 432. Cap the ask
   at a third of the shortest real edge in the soup - coincident and
   near-coincident vertices still merge, real geometry never does. An
   imported mesh has normal-length edges and keeps the tolerance it always
   had.

   The shortest edge is a MINIMUM, though, and a minimum is an outlier
   statistic: one degenerate sliver anywhere sets the tolerance for every
   other triangle. On fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl
   2 edges out of 98,586 measure 1.499e-5 while the next-shortest is
   1.272e-4 - 8.5x longer. The strict minimum drags the cap to 4.997e-6, and
   at that tolerance the float32 rounding in the STL keeps vertex pairs
   apart and the part reads as 1402 open edges. It is not open: anywhere in
   2e-5 .. 3e-4 it welds to V-E+F = 2, 0 open, 0 non-manifold. Two slivers
   cost a sound mesh its topology, and both booleans then fail it.

   So reject the slivers before taking the minimum, and tell them from real
   fine detail by the gap that separates them: walk up the sorted edge
   lengths and cut at the first jump of GAPx or more. Two bounds keep that
   honest. Only the bottom 0.1% of edges may be called slivers - past that a
   short edge is the piece's feature scale, not a defect (a wrapped surface
   at 0.034 mm is pervasive, not an outlier), and the strict minimum is
   right. And 0.1% is zero until a mesh has 1000 edges, so small parts keep
   the exact tolerance they always had. GAP sits on a 3x..8x plateau where
   the tape lands on the same 4.24e-5 that NSO_buildAdjacency picks for it
   independently; 4 is the middle of that plateau.

   Same split that NSO_sculptWeldTol (app-sculpt.js) proved - slivers apart
   from pervasive fine detail - but keyed off the mesh's own edge
   distribution rather than off `want`, because the booleans ask for 0.08
   and 0.22, far above the feature scale of the meshes that carry slivers.
   ===================================================================== */
function NSO_weldEpsFor(soup, want) {
  var n = (soup && soup.length) ? (soup.length / 9) | 0 : 0;
  if (!n) return want;
  var lens = new Float64Array(n * 3), m = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var e = 0; e < 3; e++) {
      var a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      var L = Math.hypot(soup[a] - soup[b], soup[a + 1] - soup[b + 1], soup[a + 2] - soup[b + 2]);
      if (L > 1e-9) lens[m++] = L;
    }
  }
  if (!m) return want;
  lens = lens.subarray(0, m);
  lens.sort();
  var SLIVER_FRAC = 0.001;   // at most the bottom 0.1% of edges may be called slivers
  var SLIVER_GAP = 4;        // a sliver sits >= 4x below the next edge up
  var limit = (m * SLIVER_FRAC) | 0;   // 0 below 1000 edges: small parts unchanged
  var cut = 0;
  for (var i = 0; i < limit; i++) {
    if (lens[i + 1] >= lens[i] * SLIVER_GAP) { cut = i + 1; break; }
  }
  return Math.min(want, lens[cut] / 3);
}

/* =====================================================================
   Union two world soups with the same kernel Subtract already uses.

   Returns { ok, soup, parts, partsA, partsB, reason }.

   "DID THEY TOUCH" IS A DROP IN THE COMPONENT COUNT, NOT A COUNT OF ONE.

   This used to gate on `parts === 1`, and that was wrong for any piece with
   an internal void. Manifold's decompose() counts topologically disconnected
   components, and a hollowed piece is TWO of them - the outer skin and the
   cavity skin - before anything is joined to it at all. Measured: the shell
   nso_hollow.js makes from a 26 mm Stock box, unioned with a cube 100 mm
   away that it plainly does not touch, decomposes into THREE. So a sound
   union of a hollowed body with an arm came back as 2 and was rejected with
   "the two pieces do not touch", which was false: the volume showed the
   overlap correctly subtracted and the checker passed the result.

   That refusal reached Join's kernel route and Attach alike, so Hollow and
   Join were two independently-correct tools that could never be used
   together - see docs/INTEGRATION.md, finding 1.

   The question the gate actually means to ask is "did A and B become one
   thing", and the answer is that the union has fewer components than the two
   inputs had between them. On two solids that is the old test exactly
   (1 + 1 -> 1); on a hollow body it is 2 + 1 -> 2; and a genuine miss still
   fails it, because nothing merged and the counts simply add.

   A caller with its own opinion gets partsA / partsB reported alongside.
   ===================================================================== */
async function NSO_unionCore(aWorld, bWorld) {
  if (!NSO_soupLen(aWorld) || !NSO_soupLen(bWorld)) return { ok: false, reason: 'empty soup' };
  var wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) }; }
  var manA = null, manB = null, out = null;
  try {
    var aIn = aWorld, bIn = bWorld;
    if (typeof weldSoupVerts === 'function') {
      try { aIn = weldSoupVerts(aWorld, NSO_weldEpsFor(aWorld, 0.08)); } catch (e0) { aIn = aWorld; }
      try { bIn = weldSoupVerts(bWorld, NSO_weldEpsFor(bWorld, 0.08)); } catch (e1) { bIn = bWorld; }
    }
    manA = NSO_CSG.soupToManifold(wasm, aIn);
    if (manA.status && manA.status() !== 'NoError') throw new Error('A rejected: ' + manA.status());
    manB = NSO_CSG.soupToManifold(wasm, bIn);
    if (manB.status && manB.status() !== 'NoError') throw new Error('B rejected: ' + manB.status());
    out = manA.add(manB);
    if (out.status() !== 'NoError') throw new Error('union rejected by kernel: ' + out.status());
    if (out.isEmpty()) throw new Error('union produced empty solid');
    var parts = 1;
    if (typeof out.decompose === 'function') {
      var bits = out.decompose();
      parts = bits.length;
      for (var i = 0; i < bits.length; i++) bits[i].delete();
    }
    var st = NSO_manifoldStats(out);
    parts = st.exact ? st.parts : parts;

    /* What the two inputs were worth on their own, asked of the kernel in
       exactly the same way. Without these the result's count means nothing:
       2 is a miss between two solids and a clean join on a hollow body. */
    var sa = NSO_manifoldStats(manA), sb = NSO_manifoldStats(manB);
    var partsA = sa.exact ? sa.parts : 1;
    var partsB = sb.exact ? sb.parts : 1;
    /* Fall back to the old test only when the kernel could not tell us what
       an input was worth - a guessed 1 is not evidence, and refusing is the
       safe side of a guess. */
    var merged = (st.exact && sa.exact && sb.exact)
      ? (parts < partsA + partsB)
      : (parts === 1);
    return { ok: merged, parts: parts, partsA: partsA, partsB: partsB,
             soup: NSO_CSG.manifoldToSoup(out),
             stats: st.exact ? { open: st.open, nm: st.nm } : null,
             reason: merged ? '' : 'the two pieces do not touch' +
               ((partsA + partsB > 2)
                 ? ' (A is ' + partsA + ' shell(s), B is ' + partsB + '; the union is still ' +
                   parts + ', so nothing merged)'
                 : '') };
  } catch (err) {
    return { ok: false, reason: NSO_errMsg(err) };
  } finally {
    if (manA) manA.delete();
    if (manB) manB.delete();
    if (out) out.delete();
  }
}

/* =====================================================================
   Subtract one world soup from another - the plain boolean, no plug frame.

   Returns { ok, soup, parts, removedMm3, reason }.

   subtractSoupBFromA below is a PUNCH: it clips the bit to a safety box built
   from a plug frame and reserves a wall along the punch axis, which is right
   for a port cut and meaningless for a volume already known to be safe to
   remove. This is the other case. Its caller is the hollow support tree
   (nso_support_tree.js, hollowTree): every bore it removes is its own part
   shrunk inward by exactly one wall, so the removal needs no second opinion
   about walls - only the kernel, the same welds as the union, and proof that
   something was removed.

   A result that removed nothing is refused rather than reported ok, for the
   reason subtractSoupBFromA refuses one: a caller that believes a bore went
   in when it did not is the silent failure worth guarding.
   ===================================================================== */
async function NSO_subtractCore(aWorld, bWorld) {
  if (!NSO_soupLen(aWorld) || !NSO_soupLen(bWorld)) return { ok: false, soup: aWorld, reason: 'empty soup' };
  var wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, soup: aWorld, reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) }; }
  var manA = null, manB = null, out = null;
  try {
    var aIn = aWorld, bIn = bWorld;
    if (typeof weldSoupVerts === 'function') {
      try { aIn = weldSoupVerts(aWorld, NSO_weldEpsFor(aWorld, 0.08)); } catch (e0) { aIn = aWorld; }
      try { bIn = weldSoupVerts(bWorld, NSO_weldEpsFor(bWorld, 0.08)); } catch (e1) { bIn = bWorld; }
    }
    manA = NSO_CSG.soupToManifold(wasm, aIn);
    if (manA.status && manA.status() !== 'NoError') throw new Error('A rejected: ' + manA.status());
    manB = NSO_CSG.soupToManifold(wasm, bIn);
    if (manB.status && manB.status() !== 'NoError') throw new Error('B rejected: ' + manB.status());
    out = manA.subtract(manB);
    if (out.status() !== 'NoError') throw new Error('subtract rejected by kernel: ' + out.status());
    if (out.isEmpty()) throw new Error('subtract produced an empty solid');
    var removed = manA.volume() - out.volume();
    if (!(removed > 1e-9)) {
      throw new Error('removed ~0 volume (' + removed.toExponential(3) + ' mm^3) - B is not inside A');
    }
    var st = NSO_manifoldStats(out);
    return { ok: true, soup: NSO_CSG.manifoldToSoup(out), parts: st.exact ? st.parts : null,
             removedMm3: removed, stats: st.exact ? { open: st.open, nm: st.nm } : null, reason: '' };
  } catch (err) {
    return { ok: false, soup: aWorld, reason: NSO_errMsg(err) };
  } finally {
    if (manA) manA.delete();
    if (manB) manB.delete();
    if (out) out.delete();
  }
}

/* =====================================================================
   REPLACEMENT: subtractSoupBFromA
   Was: homemade ray/AABB pocket clipper (centroid filter + wall raycast).
   Now: real solid boolean via Manifold. Async (WASM load + compute).
   Same fail-safe contract: any failure returns { ok:false, soup: aWorld },
   caller leaves A untouched.
   ===================================================================== */
/* =====================================================================
   NOZZLE-SAFETY READOUT FOR A CUT  (NSO_Thickness.cutClearance)

   buildCutVolume reserves `minWall` along the punch axis ALONE, so at an edge
   or a corner - where two or three faces are load-bearing - it stops short of
   the far wall on one axis and says nothing about the others. Measured on
   fixtures/box_open.stl: a corner bite takes the whole 2 mm near wall and the
   result still gates clean, because SEVERING a wall removes material rather
   than thinning it. No check on the finished mesh can see that (docs/
   WALL-THICKNESS.md, docs/LOCAL-CARVE.md 3c) - it has to be asked before the
   cut, against every axis.

   This is a REPORT, not a veto. Nothing about whether the cut runs, what it
   removes, or whether it is reported as ok may depend on it:

     - it is computed from `aWorld`, the hull as it is BEFORE the cut, and from
       the box the cut actually occupies, so it reads the same question the
       cut is about to answer;
     - every failure path returns null, because a measurement that cannot be
       taken must not fail a cut that is otherwise sound;
     - the caller appends NSO_Thickness.cutWarning() to its own status line and
       commits either way.

   A hard refusal would be wrong here, not merely unfriendly: a corner gouge
   that cuts through a wall is exactly what Local-Carve's blade is FOR. The
   honest answer is to make the cut and say what it did.
   ===================================================================== */
function cutClearanceFor(aWorld, cutManifold, frame, opts) {
  try {
    var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
    if (!T || typeof T.cutClearance !== 'function') return null;
    if (!aWorld || !aWorld.length || !cutManifold) return null;

    /* The world AABB of the volume actually removed - manB n safetyBox, not the
       raw bit, so the probe is asked about the cut that happens rather than the
       one that was requested. For a rotated bit the AABB is conservative: it
       can over-report a wall at risk, never under-report one. */
    var cutSoup = NSO_CSG.manifoldToSoup(cutManifold);
    if (!cutSoup || cutSoup.length < 9) return null;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < cutSoup.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        var v = cutSoup[i + a];
        if (!(v === v)) return null;              // NaN in the cut box: measure nothing
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
      }
    }
    for (var b = 0; b < 3; b++) if (!isFinite(lo[b]) || !isFinite(hi[b])) return null;

    /* Severing the axis the bit punches along is what a through hole IS, so
       cutClearance reports it instead of failing it. Naming that axis is only
       honest while the punch really is axis-aligned: a skew punch has no one
       axis, and naming its dominant one would excuse a severance it does not
       account for. 15 degrees is the tolerance because that is the app's own
       pose granularity (applyMeshRotation's tilt step); past it, no axis is
       named and a severance anywhere is reported. */
    var through = null;
    var punch = frame && frame.punch;
    if (punch) {
      var AX = ['x', 'y', 'z'], best = -1, bestV = -1;
      for (var k = 0; k < 3; k++) {
        var m = Math.abs(Number(punch[AX[k]]));
        if (m === m && m > bestV) { bestV = m; best = k; }
      }
      if (best >= 0 && bestV >= 0.9659) through = AX[best];   // cos 15 deg
    }

    /* No minWall override: the floor here is the NOZZLE floor - what the
       slicer can still print - which is a different quantity from the cut's
       own `minWall` reservation (1.0 mm of stand-off for the safety box).
       Passing the latter would ask the wrong question. */
    var rep = T.cutClearance(aWorld, lo, hi, {
      through: through,
      nozzle: (opts && typeof opts.nozzle === 'number') ? opts.nozzle : T.NOZZLE_DEFAULT
    });
    /* The box actually measured, carried on the report so a check can re-run
       the probe at a denser sweep - or a bug report can be reproduced - without
       re-deriving the AABB from the kernel solids, which no longer exist by
       the time a caller sees this. */
    if (rep) { rep.cut_lo = lo; rep.cut_hi = hi; }
    return rep;
  } catch (e) {
    console.warn('[subtract] clearance probe skipped:', (e && e.message) ? e.message : e);
    return null;
  }
}

async function NSO_punchCore(aWorld, bWorld, opts) {
  opts = opts || {};
  var na = NSO_soupLen(aWorld), nb = NSO_soupLen(bWorld);
  if (!na || !nb) return { ok: false, soup: aWorld, reason: 'empty soup' };

  var frame = opts.plugFrame || null;
  if (!frame) return { ok: false, soup: aWorld, reason: 'no plug frame (bit not oriented against hull)' };

  var minWall = (opts.minWall === undefined) ? 1.0 : opts.minWall;
  var before = NSO_edgeStats(aWorld);

  var wasm;
  try {
    wasm = await NSO_CSG.load();
  } catch (err) {
    return { ok: false, soup: aWorld, mode: 'manifold', reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) };
  }

  var manA = null, manB = null, safetyBox = null, bClipped = null, result = null;
  var clearance = null;
  try {
    var aIn = aWorld, bIn = bWorld;
    if (typeof weldSoupVerts === 'function') {
      try { aIn = weldSoupVerts(aWorld, NSO_weldEpsFor(aWorld, 0.08)); } catch (e0) { aIn = aWorld; }
      try { bIn = weldSoupVerts(bWorld, NSO_weldEpsFor(bWorld, 0.08)); } catch (e1) { bIn = bWorld; }
    }
    try { manA = NSO_CSG.soupToManifold(wasm, aIn); }
    catch (eA) { throw new Error('hull rejected: ' + ((eA && eA.message) ? eA.message : eA)); }
    if (manA.status && manA.status() !== 'NoError') throw new Error('hull rejected: ' + manA.status());

    try { manB = NSO_CSG.soupToManifold(wasm, bIn); }
    catch (eB) { throw new Error('bit rejected: ' + ((eB && eB.message) ? eB.message : eB)); }
    if (manB.status && manB.status() !== 'NoError') throw new Error('bit rejected: ' + manB.status());

    safetyBox = NSO_CSG.buildCutVolume(wasm, frame, aWorld, minWall);
    if (!safetyBox) throw new Error('bit does not reach hull A along the punch direction, or no room within minWall');

    bClipped = manB.intersect(safetyBox);
    if (bClipped.isEmpty()) throw new Error('bit does not reach hull within safe wall margin');

    /* Measured here because this is the last point where the cut volume still
       exists as a solid and the hull is still un-cut. Purely a readout - see
       cutClearanceFor above; the cut proceeds identically whatever it says. */
    clearance = cutClearanceFor(aWorld, bClipped, frame, opts);

    result = manA.subtract(bClipped);
    if (result.status() !== 'NoError') throw new Error('subtract rejected by kernel: ' + result.status());
    if (result.isEmpty()) throw new Error('subtract produced empty solid');

    // No-op guard: a "successful" boolean that removed ~nothing (e.g. the
    // bit doesn't actually touch the hull's outer skin, so the safety-box
    // clip missed it) must NOT be reported as ok -- that would let the
    // caller delete B and leave A silently unchanged. Compare solid
    // volume, not triangle count (retriangulation can shuffle tri count
    // even on a true no-op).
    var volBefore = manA.volume();
    var volAfter = result.volume();
    var removedVol = volBefore - volAfter;
    // The default floor is sized for a PLUG: a port cutout is a large fraction
    // of the hull, and the guard has to be loose enough that float noise on a
    // 64,000 mm^3 block never reads as a real cut. A local carve is legitimately
    // smaller than that - a 1.5 mm ball gouge at a corner of the same block is
    // ~2 mm^3, or 0.003% - so a caller whose op does not depend on this guard
    // to protect a piece it is about to delete can set its own floor.
    // opts.minRemoved is that override, and absent it the behaviour is
    // unchanged: absolute floor + 0.01% of hull volume.
    var askEps = Number(opts.minRemoved);
    var noopEps = (isFinite(askEps) && askEps > 0) ? askEps : Math.max(1e-3, volBefore * 1e-4);
    if (removedVol <= noopEps) {
      throw new Error('removed ~0 volume (' + removedVol.toFixed(4) +
        ' mm^3) -- bit likely does not touch the hull skin; check placement');
    }

    var outTris = result.numTri();
    var soup = NSO_CSG.manifoldToSoup(result);
    var exact = NSO_manifoldStats(result);
    var after = exact.exact ? { open: exact.open, nm: exact.nm } : NSO_edgeStats(soup);

    console.log('[subtract] kernel=manifold tris', manA.numTri(), '->', outTris,
      'open', before.open, '->', after.open, 'nonManifold', before.nm, '->', after.nm);

    return {
      ok: true,
      soup: soup,
      mode: 'manifold',
      hullTris: outTris,
      openBefore: before.open, nmBefore: before.nm,
      openAfter: after.open, nmAfter: after.nm,
      clearance: clearance
    };
  } catch (err) {
    var why = NSO_errMsg(err);
    console.warn('[subtract] failed:', why);
    return { ok: false, soup: aWorld, mode: 'manifold', reason: why, clearance: clearance };
  } finally {
    if (manA) manA.delete();
    if (manB) manB.delete();
    if (safetyBox) safetyBox.delete();
    if (bClipped) bClipped.delete();
    if (result) result.delete();
  }
}

// Add one soup to another with the kernel the app already carries.
async function nsoUnionCore(aSoup, bSoup) {
  if (typeof NSO_CSG === 'undefined') return { ok: false, reason: 'no CSG kernel in this build' };
  let wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + (err && err.message ? err.message : err) }; }
  let A = null, B = null, out = null;
  try {
    A = NSO_CSG.soupToManifold(wasm, aSoup);
    B = NSO_CSG.soupToManifold(wasm, bSoup);
    out = A.add(B);
    if (out.status() !== 'NoError') throw new Error('kernel refused the fill: ' + out.status());
    if (out.isEmpty()) throw new Error('the fill produced nothing');
    return { ok: true, soup: NSO_CSG.manifoldToSoup(out) };
  } catch (err) {
    return { ok: false, reason: (err && err.message ? err.message : String(err)) };
  } finally {
    if (A) A.delete();
    if (B) B.delete();
    if (out) out.delete();
  }
}

// Subtract one soup from another with the kernel the app already carries.
// Nothing here reaches into the kernel; it is the same adapter Subtract and
// Join use, called on two boxes this file generated.
async function nsoSubtractCore(aSoup, bSoup) {
  if (typeof NSO_CSG === 'undefined') return { ok: false, reason: 'no CSG kernel in this build' };
  let wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + (err && err.message ? err.message : err) }; }
  let A = null, B = null, out = null;
  try {
    A = NSO_CSG.soupToManifold(wasm, aSoup);
    if (A.status && A.status() !== 'NoError') throw new Error('hull rejected: ' + A.status());
    B = NSO_CSG.soupToManifold(wasm, bSoup);
    if (B.status && B.status() !== 'NoError') throw new Error('pocket rejected: ' + B.status());
    out = A.subtract(B);
    if (out.status() !== 'NoError') throw new Error('kernel refused the cut: ' + out.status());
    if (out.isEmpty()) throw new Error('the cut left nothing');
    return { ok: true, soup: NSO_CSG.manifoldToSoup(out) };
  } catch (err) {
    return { ok: false, reason: (err && err.message ? err.message : String(err)) };
  } finally {
    if (A) A.delete();
    if (B) B.delete();
    if (out) out.delete();
  }
}

function weldSoupVerts(soup, eps) {
  eps = eps || 0.2;
  const inv = 1 / eps;
  const map = new Map();
  const verts = [];
  function key(x, y, z) {
    return (Math.round(x * inv)) + ',' + (Math.round(y * inv)) + ',' + (Math.round(z * inv));
  }
  function vid(x, y, z) {
    const k = key(x, y, z);
    if (map.has(k)) return map.get(k);
    const id = verts.length / 3;
    verts.push(x, y, z);
    map.set(k, id);
    return id;
  }
  const out = [];
  const triCount = soup.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const a = vid(soup[i0], soup[i0 + 1], soup[i0 + 2]);
    const b = vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]);
    const c = vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8]);
    if (a === b || b === c || c === a) continue;
    out.push(verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2]);
    out.push(verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]);
    out.push(verts[c * 3], verts[c * 3 + 1], verts[c * 3 + 2]);
  }
  return new Float32Array(out);
}


/* =====================================================================
   OVERLAPPING SHELLS: THE MEASURE AND THE MERGE  (nso-helpers.js, nsoOverlap)

   A piece that is several shells laid through one another (library/box_closed.stl: a tray and a lid slab that
   overlap by 0.1 mm, 74 piercing pairs) is not one solid to the kernel. No verb refuses it for that any more: the
   verbs that need a solid (Crop's copy, Subtract, Extract bit, the welds of Join / Connect / Bridge, Carve, Attach,
   Reattach) ask nsoOverlap.solid first, which measures the piece here and, when its shells cross, merges them here
   into one solid for that operation. Both walk every triangle (the measure: 25 s on a 1,000,000-triangle piece), so
   both live in this file, which the boolean worker loads too; nso-helpers.js keeps their answers per piece and asks
   the worker for a big one. Needs NSO_Repair.js for the measure (the worker loads it too).
   ===================================================================== */

// { pierce, crossing, shells, overlapShells } for a raw soup: the checker's pairs, those that truly cross, the
// piece's shells and how many of them cross another (NSO_Repair._overlapShells); null when it cannot be asked.
function NSO_overlapMeasure(soup) {
  if (!soup || !soup.length) return null;
  if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair._selfIntersectionDetail !== 'function' ||
      typeof NSO_Repair._weldToIndexed !== 'function' || typeof NSO_Repair._overlapShells !== 'function') return null;
  var out;
  try {
    var mesh = NSO_Repair._weldToIndexed(soup, NSO_Repair.WELD_TOL).mesh;
    var d = NSO_Repair._selfIntersectionDetail(mesh, { collect: true });
    var o = NSO_Repair._overlapShells(mesh, d.pairs);
    out = { pierce: d.pierce, crossing: o.crossing, shells: o.shells, overlapShells: o.overlapShells };
  } catch (e) { return null; }
  return out;
}

/* In the worker: the measuring of the soup it was sent. */
function NSO_overlapJob(soup) { return NSO_overlapMeasure(soup); }

/* The merge: every shell of the piece, as one closed solid. The pass tools/nso_fixture_union.mjs makes, in the
   kernel the verbs use. The soup is welded as a union's input is, lifted whole (so a shell that is not closed
   stops it here: the kernel will not take an open or non-manifold mesh), split into its shells, and the shells
   that hold volume are unioned. A shell wound inward is a cavity (a hollowed piece's inner wall): it is turned
   the right way out and taken away from the union, so a hollow piece stays hollow.
   -> { ok, soup, shells, cavities, volumeMm3 } or { ok: false, reason } - the reason in words a readout can use. */
async function NSO_shellMergeCore(soup) {
  if (!NSO_soupLen(soup)) return { ok: false, reason: 'empty soup' };
  var wasm;
  try { wasm = await NSO_CSG.load(); }
  catch (err) { return { ok: false, reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) }; }
  var live = [];                                  // every kernel object made here, deleted at the end
  function keep(m) { live.push(m); return m; }
  function inward(c) {                            // a shell wound inward, turned the right way out
    var mesh = c.getMesh(), tv = mesh.triVerts.slice();
    for (var i = 0; i < tv.length; i += 3) { var t = tv[i + 1]; tv[i + 1] = tv[i + 2]; tv[i + 2] = t; }
    return keep(new wasm.Manifold(new wasm.Mesh({ numProp: mesh.numProp, vertProperties: mesh.vertProperties, triVerts: tv })));
  }
  try {
    var aIn = soup;
    try { aIn = weldSoupVerts(soup, NSO_weldEpsFor(soup, 0.08)); } catch (e0) { aIn = soup; }
    var whole = null, st0;
    try { whole = keep(NSO_CSG.soupToManifold(wasm, aIn)); st0 = whole.status(); }
    catch (e1) { st0 = NSO_errMsg(e1); }
    if (st0 !== 'NoError') {
      return { ok: false, reason: 'a shell is not closed, so there is no solid to merge (the kernel says ' + st0 + ')' };
    }
    var comps = whole.decompose(), solids = [], voids = [];
    comps.forEach(function (c) {
      keep(c);
      var v = c.volume();
      if (v > 0) solids.push(c);
      else if (v < 0) voids.push(inward(c));
    });
    if (!solids.length) return { ok: false, reason: 'no shell encloses any volume' };
    var out = solids.length === 1 ? solids[0] : keep(wasm.Manifold.union(solids));
    for (var i = 0; i < voids.length; i++) out = keep(out.subtract(voids[i]));
    var st = out.status();
    if (st !== 'NoError') return { ok: false, reason: 'the kernel would not merge them (' + st + ')' };
    if (out.isEmpty()) return { ok: false, reason: 'the merge came back empty' };
    var ms = NSO_manifoldStats(out);
    if (ms.exact && (ms.open || ms.nm)) {
      return { ok: false, reason: 'the merge came back open (' + ms.open + ' open, ' + ms.nm + ' non-manifold edges)' };
    }
    return { ok: true, soup: NSO_CSG.manifoldToSoup(out), shells: comps.length, cavities: voids.length, volumeMm3: out.volume() };
  } catch (err) {
    return { ok: false, reason: NSO_errMsg(err) };
  } finally {
    live.forEach(function (m) { try { m.delete(); } catch (e) { /* already gone */ } });
  }
}

/* In the worker: the merge of the soup it was sent, its result moved back. */
function NSO_shellMergeJob(soup) { return NSO_shellMergeCore(soup).then(NSO_boolHandBack); }


/* =====================================================================
   WHERE A BOOLEAN RUNS  (see the head of this file)
   ===================================================================== */

var NSO_BoolConfig = {
  bigTris: 50000,        // a boolean with either soup at or past this many triangles goes to the worker
  watchdogMs: 120000,    // a worker job that has not ended by now is stopped, and says so
  worker: true           // false: always the page's thread (a seam for the checks)
};
var NSO_boolActive = [];  // the jobs in a worker right now: { label, key, cancel(why, flag) }

/* The words a stopped job gives back. Plain, and each says the piece is as it was. */
var NSO_BOOL_STOPPED = 'stopped - nothing was changed';
function NSO_boolTimedOut() {
  var ms = NSO_BoolConfig.watchdogMs, s = Math.round(ms / 1000);
  var t = s >= 120 && s % 60 === 0 ? (s / 60) + ' minutes' : (ms < 10000 ? (ms / 1000).toFixed(1) : s) + ' seconds';
  return 'it ran longer than ' + t + ' and was stopped - nothing was changed. These pieces are too heavy for this to finish here';
}

/* The larger soup of two, in triangles. */
function NSO_boolPair(a, b) { return Math.max(NSO_soupLen(a), NSO_soupLen(b)); }

/* A copy of a typed array. A big one is copied a slice at a time with the page's thread handed back between slices:
   one memcpy of a million triangles (36 MB) is 20 to 140 ms in a single task, depending on what the allocator has to
   find, and the page must not stand still for it. */
var NSO_BOOL_COPY_SLICE = 1 << 21;     // floats a step (8 MB)
function NSO_boolCopy(v) {
  var n = v.length;
  if (n <= 2 * NSO_BOOL_COPY_SLICE || typeof setTimeout !== 'function') return Promise.resolve(v.slice());
  var c = new v.constructor(n), at = 0;
  return new Promise(function (resolve) {
    (function step() {
      var end = Math.min(n, at + NSO_BOOL_COPY_SLICE);
      c.set(v.subarray(at, end), at);
      at = end;
      if (at >= n) resolve(c); else setTimeout(step, 0);
    })();
  });
}

/* A copy of args whose typed arrays are fresh buffers, and the list of those buffers to transfer. The
   page keeps its own arrays; the copy is what moves. Objects and arrays are walked three deep.
   -> Promise of { args, transfer }. */
function NSO_BoolSlot() { this.copy = null; }       // where a typed array's copy goes when it is done
function NSO_boolPack(args) {
  var transfer = [], waits = [];
  function take(v, depth) {
    if (!v || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) {
      var slot = new NSO_BoolSlot();
      waits.push(NSO_boolCopy(v).then(function (c) { slot.copy = c; transfer.push(c.buffer); }));
      return slot;
    }
    if (depth <= 0) return v;
    if (Array.isArray(v)) {
      if (v.length > 64) return v;
      return v.map(function (x) { return take(x, depth - 1); });
    }
    if (Object.getPrototypeOf(v) === Object.prototype) {
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = take(v[k], depth - 1);
      return o;
    }
    return v;
  }
  var shaped = take(args, 4);
  function fill(v) {                  // swap each placeholder for the copy it waits on
    if (!v || typeof v !== 'object') return v;
    if (v instanceof NSO_BoolSlot) return v.copy;
    if (ArrayBuffer.isView(v)) return v;
    if (Array.isArray(v)) { if (v.length > 64) return v; return v.map(fill); }
    if (Object.getPrototypeOf(v) === Object.prototype) { var o = {}; for (var k in v) o[k] = fill(v[k]); return o; }
    return v;
  }
  return Promise.all(waits).then(function () { return { args: fill(shaped), transfer: transfer }; });
}

/* The distinct buffers behind the typed arrays in a result, for the worker to hand back. */
function NSO_boolBuffers(r) {
  var out = [];
  function walk(v, depth) {
    if (!v || typeof v !== 'object') return;
    if (ArrayBuffer.isView(v)) { if (out.indexOf(v.buffer) < 0) out.push(v.buffer); return; }
    if (depth <= 0) return;
    if (Array.isArray(v)) { if (v.length <= 64) v.forEach(function (x) { walk(x, depth - 1); }); return; }
    if (Object.getPrototypeOf(v) === Object.prototype) for (var k in v) walk(v[k], depth - 1);
  }
  walk(r, 4);
  return out;
}

/* In the worker: a finished result, its soups moved. On the page there is no NSO_Work.transfer and the
   result is returned as it is. A refusal drops the soup it carries - the page has its own. */
function NSO_boolHandBack(r) {
  if (r && r.ok === false) { delete r.soup; delete r.tris; }
  if (typeof NSO_Work === 'undefined' || typeof NSO_Work.transfer !== 'function') return r;
  return NSO_Work.transfer(r, NSO_boolBuffers(r));
}

/* The plug frame holds three.js objects, which do not cross a worker boundary as themselves. Over as numbers,
   back as three.js objects in the worker. */
function NSO_plainFrame(f) {
  var v = function (p) { return { x: p.x, y: p.y, z: p.z }; };
  return {
    matrix: Array.prototype.slice.call(f.matrix.elements),
    box: { min: v(f.box.min), max: v(f.box.max) },
    axis: f.axis, sign: f.sign,
    outerNormal: f.outerNormal ? v(f.outerNormal) : null,
    punch: v(f.punch),
    capCoord: f.capCoord, span: f.span
  };
}
function NSO_hydrateFrame(f) {
  var v = function (p) { return new THREE.Vector3(p.x, p.y, p.z); };
  var m = new THREE.Matrix4().fromArray(f.matrix);
  return {
    matrix: m, inv: new THREE.Matrix4().copy(m).invert(),
    box: new THREE.Box3(v(f.box.min), v(f.box.max)),
    axis: f.axis, sign: f.sign,
    outerNormal: f.outerNormal ? v(f.outerNormal) : null,
    punch: v(f.punch),
    capCoord: f.capCoord, span: f.span
  };
}

/* The worker's door: run an op's core on the copies it was sent. */
var NSO_BoolCore = {
  union: function (a, b) { return NSO_unionCore(a, b); },
  subtract: function (a, b) { return NSO_subtractCore(a, b); },
  punch: function (a, b, opts) {
    if (opts && opts.plugFrame && typeof THREE !== 'undefined') {
      var o = {};
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      o.plugFrame = NSO_hydrateFrame(opts.plugFrame);
      opts = o;
    }
    return NSO_punchCore(a, b, opts);
  },
  fillUnion: function (a, b) { return nsoUnionCore(a, b); },
  fillSubtract: function (a, b) { return nsoSubtractCore(a, b); },
  job: function (op) {
    var args = Array.prototype.slice.call(arguments, 1);
    return Promise.resolve(NSO_BoolCore[op].apply(null, args)).then(NSO_boolHandBack);
  }
};

/* The page's three.js, found from its own script tag, so the worker loads the very file the page did. */
function NSO_boolThreeSrc() {
  if (typeof document === 'undefined') return null;
  var el = document.querySelector('script[src*="three.min.js"]');
  return el ? el.getAttribute('src') : null;
}

/* The ops that go through NSO_boolRun. refuse(args, why) is the op's own refusal shape, the one its core
   returns when it fails; restore(r, args) puts back what a worker's refusal left out. */
var NSO_BOOL_OPS = {
  union: {
    label: 'Joining', files: function () { return ['nso_csg.js']; },
    refuse: function (a, why) { return { ok: false, reason: why }; },
    restore: function (r) { return r; }
  },
  subtract: {
    label: 'Subtracting', files: function () { return ['nso_csg.js']; },
    refuse: function (a, why) { return { ok: false, soup: a[0], reason: why }; },
    restore: function (r, a) { if (r && r.ok === false && !r.soup) r.soup = a[0]; return r; }
  },
  punch: {
    label: 'Subtracting',
    files: function () { var t = NSO_boolThreeSrc(); return t ? [t, 'nso_thickness.js', 'nso_csg.js'] : null; },
    refuse: function (a, why) { return { ok: false, soup: a[0], mode: 'manifold', reason: why, clearance: null }; },
    restore: function (r, a) { if (r && r.ok === false && !r.soup) r.soup = a[0]; return r; },
    plain: function (a) {
      var o = a[2];
      if (!o || !o.plugFrame) return a;
      var c = {};
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
      c.plugFrame = NSO_plainFrame(o.plugFrame);
      return [a[0], a[1], c];
    }
  },
  fillUnion: {
    label: 'Filling', files: function () { return ['nso_csg.js']; },
    refuse: function (a, why) { return { ok: false, reason: why }; },
    restore: function (r) { return r; }
  },
  fillSubtract: {
    label: 'Cutting', files: function () { return ['nso_csg.js']; },
    refuse: function (a, why) { return { ok: false, reason: why }; },
    restore: function (r) { return r; }
  }
};

/* Run one boolean. spec: { path, channel, files(), tris(args), label, host, key, plain(args), refuse(args, why),
   restore(r, args) }. inThread() runs the same core on the page's thread; it is the whole answer for a small
   piece, and the way out when there is no worker.
   -> Promise of the op's result. It always settles: a stopped job settles with the op's refusal shape. */
function NSO_boolRun(spec, args, inThread) {
  var W = (typeof NSO_Work !== 'undefined') ? NSO_Work : null;
  var files = null;
  if (NSO_BoolConfig.worker && W && typeof W.run === 'function' && typeof W.canRun === 'function' &&
      spec.tris(args) >= NSO_BoolConfig.bigTris) {
    files = spec.files();
  }
  if (!files || !W.canRun(files)) return Promise.resolve().then(inThread);

  var B = (typeof NSO_BoolBusy !== 'undefined') ? NSO_BoolBusy : null;
  var key = spec.key || null;
  if (key) {
    NSO_boolActive.slice().forEach(function (j) { if (j.key === key) j.cancel('replaced by a newer one', 'superseded'); });
  }
  return new Promise(function (resolve) {
    var done = false, timer = null, busy = null, job = null;
    var rec = { label: spec.label, key: key, cancel: function (why, flag) { stop(why || NSO_BOOL_STOPPED, flag || 'cancelled'); } };
    function settle(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      var at = NSO_boolActive.indexOf(rec);
      if (at >= 0) NSO_boolActive.splice(at, 1);
      if (busy) { try { busy.end(); } catch (e) { /* the bar is not the answer */ } }
      resolve(r);
    }
    function stop(why, flag) {
      if (done) return;
      if (job) job.cancel();
      var r = spec.refuse(args, why);
      r[flag] = true;
      settle(r);
    }
    /* On the bar and under the watchdog from the start: copying the soups is part of the wait. */
    NSO_boolActive.push(rec);
    if (B) busy = B.begin(spec.label, spec.host || null);
    timer = setTimeout(function () { stop(NSO_boolTimedOut(), 'timedOut'); }, NSO_BoolConfig.watchdogMs);
    NSO_boolPack(spec.plain ? spec.plain(args) : args).then(function (sent) {
      if (done) return;                 // stopped while the soups were being copied: nothing was sent
      job = W.run(spec.channel || 'bool', files, spec.path, (spec.lead || []).concat(sent.args), { transfer: sent.transfer });
      job.promise.then(function (r) {
        if (done) return;
        if (spec.restore) r = spec.restore(r, args);
        /* The worker could not load the kernel (a page that lets the page import it and not a worker): the
           page's thread can still do it, as it always did. Nothing has run. */
        if (r && r.ok === false && /kernel failed to load/.test(String(r.reason || ''))) {
          Promise.resolve().then(inThread).then(settle, function (err) { settle(spec.refuse(args, NSO_errMsg(err))); });
          return;
        }
        settle(r);
      }, function (err) {
        if (done) return;
        settle(spec.refuse(args, 'the background worker stopped (' + NSO_errMsg(err) + ') - nothing was changed'));
      });
    }, function (err) {
      settle(spec.refuse(args, NSO_errMsg(err)));
    });
  });
}

/* Stop every boolean in a worker (Escape does). The callers get their refusal and carry on. */
function NSO_boolCancelAll() {
  var jobs = NSO_boolActive.slice();
  jobs.forEach(function (j) { j.cancel(); });
  return jobs.length;
}

/* Stop the jobs started under one key (a plan the card no longer wants). */
function NSO_boolCancelKey(key) {
  var jobs = NSO_boolActive.filter(function (j) { return j.key === key; });
  jobs.forEach(function (j) { j.cancel(); });
  return jobs.length;
}

function NSO_boolSpec(op, o) {
  var base = NSO_BOOL_OPS[op], s = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) s[k] = base[k];
  s.path = 'NSO_BoolCore.job';
  s.tris = function (a) { return NSO_boolPair(a[0], a[1]); };
  if (o && o.label) s.label = o.label;
  if (o && o.host) s.host = o.host;
  s.lead = [op];
  return s;
}

/* The doors. Same names, arguments and results as ever; the third argument is optional:
   { label, host } - what the bar says ("Connecting") and the readout it sits under. */
function NSO_unionSoups(aWorld, bWorld, o) {
  var spec = NSO_boolSpec('union', o);
  return NSO_boolRun(spec, [aWorld, bWorld], function () { return NSO_unionCore(aWorld, bWorld); });
}
function NSO_subtractSoups(aWorld, bWorld, o) {
  var spec = NSO_boolSpec('subtract', o);
  return NSO_boolRun(spec, [aWorld, bWorld], function () { return NSO_subtractCore(aWorld, bWorld); });
}
function subtractSoupBFromA(aWorld, bWorld, opts) {
  var spec = NSO_boolSpec('punch', null);
  return NSO_boolRun(spec, [aWorld, bWorld, opts], function () { return NSO_punchCore(aWorld, bWorld, opts); });
}
function nsoUnionSoups(aSoup, bSoup) {
  var spec = NSO_boolSpec('fillUnion', null);
  return NSO_boolRun(spec, [aSoup, bSoup], function () { return nsoUnionCore(aSoup, bSoup); });
}
function nsoSubtractSoups(aSoup, bSoup) {
  var spec = NSO_boolSpec('fillSubtract', null);
  return NSO_boolRun(spec, [aSoup, bSoup], function () { return nsoSubtractCore(aSoup, bSoup); });
}
