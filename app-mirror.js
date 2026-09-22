// ===================== Mirror: exact reflection across one plane =====================
// Headless geometry only until the commit half. No DOM, no Three.js, no app
// state, so the same file runs under node (tools/nso_mirror_test.js) and under
// a classic script tag. The commit half reuses NSO_sculptCommitRaw.
//
// Speaks rawTris, the flat Float32Array triangle soup with 9 floats per
// triangle that Cut, Extend and Join all pass around. The result is that same
// kind of soup: an ordinary piece. Nothing in here is a special "mirrored
// piece" type, and nothing in here calls Align, Join, or Soften.
//
// WHAT THIS IS. Reflect the piece across a plane perpendicular to one axis.
// The axis defaults to the piece's own dominant axis, detected by
// NSO_extendDetectAxis (app-extend.js) — the same function Extend uses, called,
// not copied. The plane defaults to the clean-band cut NSO_extendBands would
// stretch through, which is the plane a Cut at that band leaves behind. Pass
// opts.plane to name a different one, including 0, which is X→−X (or Y→−Y,
// Z→−Z) exactly.
//
// The reflection is x → 2*plane − x on the chosen axis. The other two
// coordinates are copied bit for bit, the same promise Extend makes about a
// cross-section, and a gate compares them element by element. A second gate
// requires the reflection to round-trip in float32: reflecting again must
// return every axis coordinate unchanged. A plane that cannot do that is
// refused. The tool does not snap the plane and does not ship an approximation.
//
// Winding is swapped (two corners of every triangle) after the reflection.
// A mirror is an improper isometry, so the wound soup would come back inside
// out; the swap puts the normals back outward and the signed volume back to
// the sign it arrived with. The piece Join and the canonical checker then see
// is a normal solid.
//
// OUT OF SCOPE, named so the next ticket does not bolt it on:
//
//   1. SOFTEN. Round, Bevel, Corners, Paint-exclude finishes — none of them.
//      This file does not load them, call them, or share a code path with
//      them. The opposite-end sequence is cut band, Mirror, Align, Join.
//
//   2. ALIGN AND JOIN. Both already consume an ordinary piece. Mirror does
//      not pre-position a partner and does not fuse. See docs/MIRROR.md for
//      the sequence that composes the four without any of them knowing about
//      the others.
//
//   3. OFF-CARDINAL PLANES. The bit-for-bit promise on the other two axes is
//      only deliverable when the plane is perpendicular to X, Y or Z. An
//      oblique plane is not a feature of this tool. NSO_extendDetectAxis
//      refuses an off-cardinal dominant axis in its own words; pass opts.axis
//      only when you mean a coordinate axis.

/* =====================================================================
   1. Resolve the axis and the plane

   Axis: NSO_extendDetectAxis. A missing detector is a refusal, not a second
   implementation. A cube, a sphere, a tapered piece with no dominant axis —
   whatever Extend refuses, Mirror refuses, unless opts.axis forces one.

   Plane: opts.plane when the caller passed one (0 is a real plane, so the
   test is != null, not truthiness). Otherwise the clean-band cut. Otherwise
   the midpoint of the extent. Whichever one is chosen has to be an exact
   float32 mirror plane for THIS soup, or the call refuses.
   ===================================================================== */

function NSO_mirrorReflectCoord(c, plane) {
  if (typeof NSO_extendFround !== 'function') return NaN;
  return NSO_extendFround(2 * plane - c);
}

// True when reflecting every vertex on axisIdx across plane and reflecting
// again returns the original float32 coordinate, for every vertex.
function NSO_mirrorRoundTrips(rawTris, axisIdx, plane) {
  var n = (rawTris.length / 9) | 0;
  var misses = 0, worst = 0, example = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var v = 0; v < 3; v++) {
      var c = rawTris[o + v * 3 + axisIdx];
      var reflected = NSO_mirrorReflectCoord(c, plane);
      var back = NSO_mirrorReflectCoord(reflected, plane);
      if (back !== c || !isFinite(reflected)) {
        misses++;
        var err = Math.abs(back - c);
        if (err >= worst) { worst = err; example = c; }
      }
    }
  }
  return { ok: misses === 0, misses: misses, worst: worst, example: example };
}

function NSO_mirrorResolve(rawTris, opts) {
  opts = opts || {};
  var out = { ok: false, reason: '', detect: null, band: null };
  if (typeof NSO_extendDetectAxis !== 'function' || typeof NSO_extendFround !== 'function' ||
      typeof NSO_extendBands !== 'function' || typeof NSO_extendLengthToReach !== 'function') {
    out.reason = 'app-extend.js is not loaded - Mirror reuses its axis detector and does not carry its own';
    return out;
  }
  if (!rawTris || rawTris.length < 9 || (rawTris.length % 9) !== 0) {
    out.reason = 'not a triangle soup';
    return out;
  }
  var det = NSO_extendDetectAxis(rawTris, opts);
  out.detect = det;
  if (!det.ok) { out.reason = det.reason; return out; }
  var k = det.axisIdx;
  out.axisIdx = k;
  out.axis = det.axis;

  var scan = NSO_extendBands(rawTris, k, opts);
  out.bands = scan;
  if (scan.ok) out.band = scan.best;

  var plane, source;
  if (opts.plane != null) {
    plane = +opts.plane;
    source = 'given';
    if (!isFinite(plane)) { out.reason = 'mirror plane is not a finite number'; return out; }
  } else if (scan.ok) {
    plane = scan.best.cut;
    source = 'band';
  } else {
    var span = NSO_extendLengthToReach(rawTris, k, 0);
    plane = (span.min + span.max) / 2;
    source = 'midpoint';
    if (!isFinite(plane)) { out.reason = 'piece has no extent along ' + det.axis; return out; }
  }
  out.plane = plane;
  out.planeSource = source;

  var trip = NSO_mirrorRoundTrips(rawTris, k, plane);
  out.roundTrip = trip;
  if (!trip.ok) {
    var where = (source === 'given') ? 'opts.plane ' + plane
      : (source === 'band') ? 'the clean-band cut at ' + plane
      : 'the midpoint plane at ' + plane;
    out.reason = where + ' is not an exact float32 mirror plane along ' + det.axis +
      ' - ' + trip.misses + ' coordinate(s) do not round-trip (worst residual ' +
      trip.worst.toExponential(3) + ' mm, example ' + trip.example +
      '). Mirror does not snap the plane. Pass a plane that does, or 0 for ' +
      det.axis.toUpperCase() + '→−' + det.axis.toUpperCase();
    return out;
  }
  out.ok = true;
  return out;
}

/* =====================================================================
   2. The reflection

   One coordinate is written. The other two are never touched, and the gate
   proves it against the input buffer before the winding swap. The swap
   exchanges two corners of each triangle; it does not invent coordinates.
   Triangle count and triangle order are unchanged.

   opts.axis    force the axis, see NSO_extendDetectAxis
   opts.plane   plane coordinate along that axis. 0 is X→−X when the axis is X.
   opts.gate    default true. Topology evidence (open edges, winding count,
                volume sign) when app-sculpt.js is loaded. The cross-section
                comparison and the float32 round-trip are not skippable.

   Returns { ok, reason, tris, ... }. On refusal tris is the ORIGINAL soup,
   so the caller can swap unconditionally — the same contract NSO_extendRaw has.
   ===================================================================== */
function NSO_mirrorVolume(soup) {
  var n = (soup.length / 9) | 0, v = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
    var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function NSO_mirrorRaw(rawTris, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: rawTris };
  var resolved = NSO_mirrorResolve(rawTris, opts);
  res.resolve = resolved;
  if (!resolved.ok) { res.reason = resolved.reason; return res; }
  var k = resolved.axisIdx;
  var plane = resolved.plane;
  res.axisIdx = k;
  res.axis = resolved.axis;
  res.plane = plane;
  res.planeSource = resolved.planeSource;
  res.detect = resolved.detect;
  res.band = resolved.band;

  var out = new Float32Array(rawTris.length);
  out.set(rawTris);
  var n = (rawTris.length / 9) | 0;
  var moved = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var v = 0; v < 3; v++) {
      var idx = o + v * 3 + k;
      var c = rawTris[idx];
      var reflected = NSO_mirrorReflectCoord(c, plane);
      if (reflected !== c) moved++;
      out[idx] = reflected;
    }
  }
  res.movedVertexRefs = moved;

  var drift = 0, firstDrift = -1;
  for (var i = 0; i < rawTris.length; i++) {
    if ((i % 3) === k) continue;
    if (out[i] !== rawTris[i]) { drift++; if (firstDrift < 0) firstDrift = i; }
  }
  res.crossSectionDrift = drift;
  if (drift) {
    res.reason = 'cross-section moved: ' + drift + ' non-axis coordinate(s) differ, first at float ' + firstDrift;
    return res;
  }

  // Improper isometry → reverse orientation. Swap two corners so the solid
  // stays outward-wound. Each corner keeps the coordinates it already has.
  for (var t2 = 0; t2 < n; t2++) {
    var o2 = t2 * 9;
    var x1 = out[o2 + 3], y1 = out[o2 + 4], z1 = out[o2 + 5];
    out[o2 + 3] = out[o2 + 6]; out[o2 + 4] = out[o2 + 7]; out[o2 + 5] = out[o2 + 8];
    out[o2 + 6] = x1; out[o2 + 7] = y1; out[o2 + 8] = z1;
  }

  res.volumeBefore = NSO_mirrorVolume(rawTris);
  res.volumeAfter = NSO_mirrorVolume(out);

  if ((opts.gate == null || opts.gate) &&
      typeof NSO_buildAdjacency === 'function' && typeof NSO_sculptMetrics === 'function') {
    var adjB = NSO_buildAdjacency(rawTris, {});
    var adjA = NSO_buildAdjacency(out, {});
    res.before = NSO_sculptMetrics(rawTris, adjB);
    res.after = NSO_sculptMetrics(out, adjA);
    var bad = null;
    if (res.after.tris !== res.before.tris) bad = 'triangle count changed';
    else if (adjB.ok && adjA.ok && adjA.vertCount !== adjB.vertCount) {
      bad = 'welded vertex count changed ' + adjB.vertCount + '->' + adjA.vertCount;
    } else if (res.after.openPos > res.before.openPos) {
      bad = 'open edges rose ' + res.before.openPos + '->' + res.after.openPos;
    } else if (res.after.nmPos > res.before.nmPos) {
      bad = 'non-manifold edges rose ' + res.before.nmPos + '->' + res.after.nmPos;
    } else if (res.after.degenerate > res.before.degenerate) {
      bad = 'degenerate triangles rose ' + res.before.degenerate + '->' + res.after.degenerate;
    }
    // Enclosed volume is the origin-formula only on a closed mesh. An open
    // soup's number is a tetrahedron sum with the origin, and a mirror that
    // is not through the origin moves that sum even when the reflection is
    // exact. Gate the closed case: same sign, same magnitude.
    else if (res.before.openPos === 0 && res.after.openPos === 0) {
      var scale = Math.max(Math.abs(res.volumeBefore), 1e-9);
      if (Math.abs(res.volumeAfter - res.volumeBefore) / scale > 1e-5 ||
          (res.volumeBefore > 0 && !(res.volumeAfter > 0)) ||
          (res.volumeBefore < 0 && !(res.volumeAfter < 0))) {
        bad = 'enclosed volume changed ' + res.volumeBefore + ' → ' + res.volumeAfter +
          ' (a mirror keeps it, winding included)';
      }
    }
    if (bad) { res.reason = bad; res.tris = rawTris; return res; }
  }

  res.ok = true;
  res.tris = out;
  return res;
}

/* =====================================================================
   3. App wiring

   In-place replace of the selected piece, same commit path Extend uses.
   The model stays a normal model: rawTris, rawAxis 'zup', no mirror flag.
   Align and Join read it the way they read any other piece.

   PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md, the
   question is whether this feature acts on an identifiable sub-region. It
   does not. Every vertex off the plane changes its axis coordinate, and the
   winding swap reorders every triangle, so no face can be promised untouched.
   Any paint anywhere stands the whole bake down, naming the count.
   nsoMaskCount(m) is the whole test.
   ===================================================================== */
function NSO_mirrorSelectedModel(opts) {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) {
    if (typeof setStatus === 'function') setStatus('Mirror needs a raw piece - unchanged', true);
    return { ok: false, reason: 'no rawTris' };
  }
  var paintedCount = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (paintedCount > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Mirror stood down - ' + paintedCount + ' painted face(s); reflecting moves every vertex off the plane. Clear paint to mirror.', true);
    }
    return { ok: false, reason: 'painted faces: ' + paintedCount, painted: paintedCount };
  }
  opts = opts || {};
  var r = NSO_mirrorRaw(soupIn, opts);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus('Mirror refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var src = r.planeSource === 'band' ? 'clean-band cut'
    : r.planeSource === 'midpoint' ? 'midpoint'
    : 'given plane';
  var txt = 'Mirror done - ' + r.axis.toUpperCase() + ' across ' + r.plane +
    ' (' + src + '), cross-section unchanged (0 drifted coordinates), round-trip exact';
  NSO_mirrorCommit(m, r.tris, txt);
  return r;
}

function NSO_mirrorCommit(m, working, statusText) {
  if (typeof NSO_sculptCommitRaw === 'function') return NSO_sculptCommitRaw(m, working, 'mirrorReplace', statusText);
  return false;
}

// The number box has to show a decimal that parseFloat turns back into the
// same plane. toFixed(2) would move a cut off the exact mirror plane and the
// next click would refuse a plane the detector just accepted.
function NSO_mirrorPlaneText(plane) {
  var s = String(plane);
  if (parseFloat(s) === plane) return s;
  var p = plane.toPrecision(17);
  if (parseFloat(p) === plane) return p;
  return s;
}

if (typeof document !== 'undefined') {
  (function wireMirrorButton() {
    function wire() {
      var btn = document.getElementById('btn-mirror');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          var inp = document.getElementById('inp-mirror-plane');
          var text = inp ? String(inp.value).trim() : '';
          if (text === '') {
            var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
            var soup = (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
            if (!soup) {
              if (typeof setStatus === 'function') setStatus('Select a raw piece first', true);
              return;
            }
            var resolved = NSO_mirrorResolve(soup, {});
            if (!resolved.ok) {
              if (typeof setStatus === 'function') setStatus('Mirror refused - ' + resolved.reason, true);
              return;
            }
            if (inp) inp.value = NSO_mirrorPlaneText(resolved.plane);
            var src = resolved.planeSource === 'band' ? 'the clean-band cut'
              : 'the midpoint (no clean band)';
            if (typeof setStatus === 'function') {
              setStatus('Mirror: this piece runs along ' + resolved.axis.toUpperCase() +
                '. Plane ' + resolved.plane + ' is ' + src +
                '. Press Mirror to reflect across it, or type another plane.');
            }
            return;
          }
          var want = parseFloat(text);
          NSO_mirrorSelectedModel({ plane: want });
        } catch (err) {
          console.error('[mirror]', err);
          if (typeof setStatus === 'function') {
            setStatus('Mirror failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
