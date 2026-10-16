/*
 * Lift on the plate - the SUBTRACT card's LIFT verb.
 * The app side of nso_lift_auto.js (Lift 2) and nso_lift_curved.js (Lift 3);
 * the engine is unchanged, only where and how it is driven.
 * READ docs/LIFT.md FIRST (section 7 is this file).
 * ----------------------------------------------------------------------------
 *
 * ARM. Lift on a selected piece runs detection ONCE: the rolling-ball height
 * map (NSO_LiftAuto.analyse, { curved: true }) looking straight down onto the
 * piece, from the face it lies with up. The result is cached per piece soup
 * (a WeakMap keyed by m.rawTris) until the piece changes, so an Undo that
 * puts a soup back finds its features already read. The card says
 * "N features found" - liftable, and standing out more than "How far out
 * counts" (default 0.42 mm, NSO_Thickness.floorFor(0.4), as G-scope had it).
 *
 * PICK (the default). Hovering the piece outlines the feature under the
 * cursor; the island is the engine's (an island whose surround leans more
 * than 35 degrees off the view is refused by it, and said so). A click lifts
 * it. Shift-click gathers several, and they lift together when Shift is let
 * go. Each click, or each Shift group, is one Undo.
 *
 * STRIP. One button: a short untick list of what was found, grouped (e.g.
 * "line x1 . large shape x1 (12 parts) . dots x20 . bare plate"), Confirm /
 * Cancel. Confirm lifts every ticked feature in one step, one Undo.
 *
 * WHAT A LIFT DOES. As G-scope's Lift did, unchanged: the piece keeps its
 * place and id and becomes the leftover plate (NSO_sculptCommitRaw, every
 * other triangle bit for bit, flat - or on a curved base, the surface round
 * it carried across - where each feature stood); each feature becomes its
 * own closed piece named "<piece> - lifted N", an ordinary piece (Pieces
 * list, Move, Join, Export, Remove). One 'featureSwap' Undo step (Detach's)
 * puts it all back.
 *
 * WHERE A LIFTED PIECE LANDS: exactly where it stood. It takes the parent's
 * pose and sits over the spot it came off, every triangle where the parent
 * drew it - so a feature on top of a slab is left in the air above the bed,
 * resting on the leftover plate, and stays there (liftY, the floating state
 * app-grab-drop.js describes) until it is grabbed and dropped, or sent To
 * plate. It used to go onto free plate beside the parent (nsoFreeSpot).
 *
 * FRAME. The map runs on the piece's RAW soup (m.rawTris), the frame the
 * pieces are made in. The view is the world's up carried into that frame
 * through the piece's mesh, so a piece lying as it was made reads straight
 * down raw +Z. The display mesh is the same triangles in the same order
 * (rawResultToDisplayGeometry / the importer), checked before a hover or a
 * click is read off it.
 *
 * PAINT SCOPE: WHOLE-PIECE, per the scoping rule in docs/HANDOFF.md. A lift
 * replaces the piece's soup: the lifted features' faces leave it and a cap is
 * added where they stood, so a painted face could lose its triangles or gain
 * new ones. nsoMaskCount(m) > 0 stands it down and names the count.
 *
 * NON-SOLID SCOPE: the leftover plate is gated on staying closed only when
 * the source was closed (nso_lift_auto.js); every lifted piece must be
 * closed. nsoNonSolid(m) is not read.
 *
 * G-scope's Features row (app-gscope-lift.js) reads the same cache through
 * NSO_LIFT_PLATE.detectSoup, so the two always count the same features.
 *
 * ANY FACE (docs/LIFT.md section 7, "Any face"). While Lift is armed the base
 * face is the face under the cursor. The top face - the one the piece lies
 * with up - is the default, read at arm time exactly as above. Hovering a
 * planar face that does not look up (a side wall) reads THAT face: the same
 * rolling ball, looking down that face's own normal, seeded on the face's own
 * biggest triangles. The card's count, Pick, Strip and the outlines follow it.
 *   - a triangle that belongs to a feature of the face being read leaves the
 *     face alone (the cursor is on the thing, not on a new face);
 *   - a face is a base only if it is at least FACE_MIN_FRAC of the piece's
 *     surface (a leaf's end, a cylinder's facet is not a face to read from);
 *   - the cursor over the viewport but off the piece goes back to the top; the
 *     cursor leaving the viewport for the card keeps the face, so Strip strips
 *     what was shown;
 *   - one read per face, cached per soup (and a face is named by its plane, not
 *     a triangle number, so it survives a lift or an Undo);
 *   - what it says goes to the card only: the HUD does not repeat it.
 *
 * CURVED SURFACE (nso_lift_curved.js, `surface`). A CLICK on a triangle that is on no planar face (a vase's
 * wall, a curved cheek) reads the SURFACE REGION it is in: grown from that triangle while the surface stays
 * smooth, creases stopping it. What stands on it, attached only through it, is the feature list - the card,
 * Pick and Strip work as on a face - and a lift cuts along the surface and fills flush. Only a click reads
 * it (a read takes seconds on a big mesh); a hover never does, and the cursor off the piece keeps it.
 * Planar faces are read exactly as before.
 */
/* global THREE, state, setStatus, addModel, placeModelMovable, pushUndo, applyMeshRotation,
          meshLocalBox3, nsoMaskCount, NSO_sculptCommitRaw, rawResultToDisplayGeometry,
          computeCenterOffsetFromRaw, rawFlatCapLoops, renderModelList, updateOptimizeButton,
          updateEditSize, updateAdjustUI, selectPlaced, nsoHelpers */
'use strict';

var NSO_LIFT_PLATE = (function () {
  var MAP_OPTS = { curved: true };          // Lift 3: a base that bends is followed
  var UP_DEG = 20;                          // a seed face looks within this of the view
  var BIN_MM = 0.05;                        // seed faces binned by height, this fine
  var FACE_MIN_FRAC = 0.02;                 // a face is a base if it is this much of the piece's surface
  var FACE_SEEDS = 3;                       // a face is seeded on its biggest triangles, this many
  var HOVER = 0xfacc15, PENDING = 0xff2bd6, FOUND = 0x38bdf8, FACE = 0xa78bfa;

  function LA() { return typeof window !== 'undefined' ? window.NSO_LiftAuto : null; }
  function LF() { return typeof window !== 'undefined' ? window.NSO_Lift : null; }
  function LS() { return typeof window !== 'undefined' && window.NSO_LiftCurved ? window.NSO_LiftCurved.surface : null; }
  /** The engine that read analysis `a`: the surface's own, else Lift 2 / 3's. */
  function engineOf(a) { return a && a.engine === 'surface' ? LS() : LA(); }
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function f2(x) { return (+x).toFixed(2); }

  // =========================================================================
  // Detection, cached per soup
  // =========================================================================

  var cache = new WeakMap();               // soup -> Map(read key -> r)

  function nkey(n) { return n.map(function (x) { return x.toFixed(6); }).join(','); }

  /** Seed triangles for the map: faces looking within UP_DEG of the view,
      binned by height; the bins with the most area first (the face the
      details stand on is the biggest one looking up), then the single
      biggest such triangle. */
  function seeds(soup, n) {
    var bins = new Map(), cosUp = Math.cos(UP_DEG * Math.PI / 180), bestT = -1, bestA = 0;
    for (var o = 0, t = 0; o + 8 < soup.length; o += 9, t++) {
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      var L = Math.hypot(cx, cy, cz);
      if (!(L > 1e-12)) continue;
      if ((cx * n[0] + cy * n[1] + cz * n[2]) / L < cosUp) continue;
      var h = ((soup[o] + soup[o + 3] + soup[o + 6]) * n[0] + (soup[o + 1] + soup[o + 4] + soup[o + 7]) * n[1] +
               (soup[o + 2] + soup[o + 5] + soup[o + 8]) * n[2]) / 3;
      var k = Math.round(h / BIN_MM), b = bins.get(k);
      if (!b) { b = { area: 0, t: -1, a: 0 }; bins.set(k, b); }
      b.area += L / 2;
      if (L / 2 > b.a) { b.a = L / 2; b.t = t; }
      if (L / 2 > bestA) { bestA = L / 2; bestT = t; }
    }
    var out = Array.from(bins.values()).sort(function (a, b) { return b.area - a.area; })
      .slice(0, 4).map(function (b) { return b.t; });
    if (bestT >= 0 && out.indexOf(bestT) < 0) out.push(bestT);
    return out;
  }

  /** One read per soup and key: the second call is the first call's answer.
      A read that throws is a refusal in words, kept like any other. */
  function cachedRead(soup, key, make) {
    var per = soup && cache.get(soup), hit = per && per.get(key);
    if (hit) return Object.assign({}, hit, { cached: true });
    var r;
    try { r = make(); } catch (err) {
      console.error('[lift]', err);
      r = { ok: false, refused: 'error', reason: 'Lift: could not read this face (' + ((err && err.message) || err) + '). Nothing changed.' };
    }
    if (soup) { if (!per) { per = new Map(); cache.set(soup, per); } per.set(key, r); }
    return Object.assign({}, r, { cached: false });
  }

  /**
   * The features on `soup`, looking down `n` (default raw +Z): the top face,
   * the default. Once per soup and view.
   * -> { ok, A, seed, ms, cached } or { ok: false, refused, reason }.
   */
  function detectSoup(soup, n) {
    n = n || [0, 0, 1];
    return cachedRead(soup, 'v:' + nkey(n), function () { return detectNow(soup, n); });
  }

  function detectNow(soup, n) {
    var t0 = Date.now();
    if (!LA()) return { ok: false, refused: 'deps', reason: 'Lift needs nso_lift_auto.js. Nothing changed.' };
    if (!soup || soup.length < 36) return { ok: false, refused: 'empty', reason: 'Lift: there is no mesh to lift from. Nothing changed.' };
    var S = seeds(soup, n);
    if (!S.length) {
      return { ok: false, refused: 'noface', reason: 'Lift: this piece has no face looking up for details to stand on. Nothing changed.' };
    }
    return readSeeds(soup, n, S, t0);
  }

  /** Try the seeds in turn: the first read with islands wins, else the
      first read that found none, else the last refusal. */
  function readSeeds(soup, n, S, t0) {
    var M = LA().index(soup), empty = null, last = null;
    for (var i = 0; i < S.length; i++) {
      var r = LA().analyse(soup, S[i], Object.assign({ M: M, normal: n }, MAP_OPTS));
      if (r.ok && r.islands.length) return { ok: true, A: r, seed: S[i], ms: Date.now() - t0 };
      if (r.ok && !empty) empty = r;
      if (!r.ok) last = r;
    }
    if (empty) return { ok: true, A: empty, seed: empty.seed, ms: Date.now() - t0 };
    return { ok: false, refused: last && last.refused, reason: 'Lift: ' + ((last && last.reason) || 'nothing to read') + '. Nothing changed.' };
  }

  // =========================================================================
  // Planar faces: which face a triangle is on, and a read of that face
  // =========================================================================

  var planeCache = new WeakMap();          // soup -> { groups: Map(normal key -> { n, bins }), total }

  function r3(x) { return Math.round(x * 1000) / 1000 + 0; }

  /** The plane of raw triangle `t`: { nk, k, key, n (unit), area }, or null for
      a degenerate one. The key is the normal to 3 places and the height along
      it in BIN_MM steps; the height is read off the exact normal so a plane
      stays one plane however far from the origin it lies. */
  function triPlane(s, t) {
    var o = t * 9;
    var ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
    var vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
    var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    var L = Math.hypot(cx, cy, cz);
    if (!(L > 1e-12)) return null;
    var nx = cx / L, ny = cy / L, nz = cz / L;
    var h = ((s[o] + s[o + 3] + s[o + 6]) * nx + (s[o + 1] + s[o + 4] + s[o + 7]) * ny + (s[o + 2] + s[o + 5] + s[o + 8]) * nz) / 3;
    var nk = r3(nx) + ',' + r3(ny) + ',' + r3(nz), k = Math.round(h / BIN_MM);
    return { nk: nk, k: k, key: nk + '|' + k, n: [nx, ny, nz], area: L / 2 };
  }

  /** Every triangle sorted into its plane, once per soup. */
  function planesOf(soup) {
    var hit = planeCache.get(soup);
    if (hit) return hit;
    var groups = new Map(), total = 0;
    for (var t = 0, nt = Math.floor(soup.length / 9); t < nt; t++) {
      var tp = triPlane(soup, t);
      if (!tp) continue;
      total += tp.area;
      var g = groups.get(tp.nk);
      if (!g) { g = { n: tp.n, bins: new Map() }; groups.set(tp.nk, g); }
      var b = g.bins.get(tp.k);
      if (!b) { b = { area: 0, tris: [] }; g.bins.set(tp.k, b); }
      b.area += tp.area; b.tris.push(t);
    }
    hit = { groups: groups, total: total };
    planeCache.set(soup, hit);
    return hit;
  }

  /** The face named by `key`: { n, area, tris } over the plane's bin and the
      two beside it (a plane at the edge of a bin is not split in two), or null
      when the soup has no such face. */
  function planeByKey(soup, key) {
    var at = String(key).split('|'), g = planesOf(soup).groups.get(at[0]), k = +at[1];
    if (!g) return null;
    var out = { n: g.n, area: 0, tris: [] };
    for (var d = -1; d <= 1; d++) {
      var b = g.bins.get(k + d);
      if (b) { out.area += b.area; out.tris = out.tris.concat(b.tris); }
    }
    return out.tris.length ? out : null;
  }

  /** The `n` biggest of `tris`, biggest first. */
  function biggest(soup, tris, n) {
    var sc = tris.map(function (t) {
      var o = t * 9;
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      return { t: t, a: Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) };
    });
    sc.sort(function (a, b) { return b.a - a.a; });
    return sc.slice(0, n).map(function (x) { return x.t; });
  }

  /**
   * The features standing out of one planar face - `f` is { key } from
   * faceOfTri - looking straight down its normal. Once per soup and face.
   */
  function detectFace(soup, f) {
    return cachedRead(soup, 'f:' + f.key, function () {
      var t0 = Date.now();
      if (!LA()) return { ok: false, refused: 'deps', reason: 'Lift needs nso_lift_auto.js. Nothing changed.' };
      var pl = soup && soup.length >= 36 ? planeByKey(soup, f.key) : null;
      if (!pl) return { ok: false, refused: 'noface', reason: 'Lift: that face is not on this piece any more. Nothing changed.' };
      return readSeeds(soup, pl.n, biggest(soup, pl.tris, FACE_SEEDS), t0);
    });
  }

  var indexMemo = new WeakMap();           // soup -> NSO_LiftAuto.index(soup): the weld is the biggest cost of a read

  /** The triangle a surface was read from, found again in `soup`: the same index when it still has that
      centroid, else the triangle with it (a lift keeps the surface the cursor was on, but not its numbering). */
  function surfaceSeed(soup, f) {
    var nt = Math.floor(soup.length / 9);
    function cen(t, a) { return (soup[t * 9 + a] + soup[t * 9 + 3 + a] + soup[t * 9 + 6 + a]) / 3; }
    function at(t) { return t >= 0 && t < nt && Math.abs(cen(t, 0) - f.c[0]) < 1e-6 && Math.abs(cen(t, 1) - f.c[1]) < 1e-6 && Math.abs(cen(t, 2) - f.c[2]) < 1e-6; }
    if (at(f.tri)) return f.tri;
    for (var t = 0; t < nt; t++) if (at(t)) return t;
    return -1;
  }

  /**
   * The features standing on the curved SURFACE a click read - `f` is { tri, c } from faceOfTri - once per
   * soup and surface (the key is the clicked triangle).
   */
  function detectSurface(soup, f) {
    return cachedRead(soup, 's:' + f.tri, function () {
      var t0 = Date.now(), CV = LS();
      if (!CV || !LA()) return { ok: false, refused: 'deps', reason: 'Lift needs nso_lift_curved.js. Nothing changed.' };
      var tri = soup && soup.length >= 36 ? surfaceSeed(soup, f) : -1;
      if (tri < 0) return { ok: false, refused: 'noface', reason: 'Lift: that surface is not on this piece any more. Nothing changed.' };
      var M = indexMemo.get(soup);
      if (!M) { M = LA().index(soup); indexMemo.set(soup, M); }
      var A = CV.analyse(soup, tri, { M: M });
      if (!A.ok) return { ok: false, refused: A.refused, reason: 'Lift: ' + A.reason + '. Nothing changed.' };
      return { ok: true, A: A, seed: tri, ms: Date.now() - t0 };
    });
  }

  /**
   * The base face for raw triangle `tri` of `soup`, the view being `view`:
   *   'top'  - it looks up (within UP_DEG of the view): the default face;
   *   { key, n, area } - a planar face to read from;
   *   null   - too small to be a base (a leaf's end, a facet of a curve).
   */
  function faceOfTri(soup, tri, view, click) {
    var tp = soup && tri >= 0 ? triPlane(soup, tri) : null;
    if (!tp) return null;
    var pl = planeByKey(soup, tp.key), face = !!pl && pl.area >= FACE_MIN_FRAC * planesOf(soup).total;
    /* A click on a triangle that is on no planar face reads the curved surface it is in. */
    if (click && !face) {
      var o = tri * 9;
      return { surf: true, tri: tri, key: 's:' + tri,
        c: [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3] };
    }
    if (tp.n[0] * view[0] + tp.n[1] * view[1] + tp.n[2] * view[2] >= Math.cos(UP_DEG * Math.PI / 180)) return 'top';
    if (!face) return null;
    return { key: tp.key, n: pl.n, area: pl.area };
  }

  /** Liftable, and standing out more than minH. */
  function offered(A, minH) { return A ? LA().offered(A, minH) : []; }

  // =========================================================================
  // The grouped breakdown (Strip's list, G-scope's Features)
  // =========================================================================

  var WORDS = { dots: ['dot', 'dots'], lines: ['line', 'lines'], large: ['large shape', 'large shapes'] };
  var KEYS = ['lines', 'large', 'dots'];

  /** Per group: the offered ids, and how many parts the necks divide its
      large shapes into (data from the engine; nothing is split). */
  function groups(A, minH) {
    var g = {};
    KEYS.forEach(function (k) { g[k] = { key: k, ids: [], parts: 0, held: 0 }; });
    var cant = 0, low = 0, off = new Set(offered(A, minH));
    (A ? A.islands : []).forEach(function (I) {
      if (I.status !== 'ok') { cant++; return; }
      if (!off.has(I.id)) { low++; return; }
      var G = g[I.group] || g.large;
      G.ids.push(I.id);
      G.parts += (I.necks && I.necks.parts) || 1;
      G.held += I.partCount || 0;
    });
    return { list: KEYS.map(function (k) { return g[k]; }).filter(function (G) { return G.ids.length; }), cant: cant, low: low };
  }

  function groupWords(G) {
    var n = G.ids.length;
    return (n === 1 ? WORDS[G.key][0] : WORDS[G.key][1]) + ' ×' + n + (G.parts > n ? ' (' + G.parts + ' parts)' : '') +
      (G.held ? ' + ' + capturedWords(G.held) : '');
  }

  function capturedWords(k) { return k + ' captured part' + (k === 1 ? '' : 's'); }

  /** The card's count line when features come with captured parts: what was
      found, in plain words. '' when nothing does. */
  function assemblyWords(A, minH) {
    var held = [];
    offered(A, minH).forEach(function (id) { var I = A.islands[id]; if (I.partCount) held.push(I); });
    if (!held.length) return '';
    var k = held.reduce(function (s2, I) { return s2 + I.partCount; }, 0);
    if (held.length === 1 && offered(A, minH).length === 1) {
      var I0 = held[0];
      return (WORDS[I0.group] ? 'a ' + WORDS[I0.group][0] : 'a feature') + ' with ' + capturedWords(k);
    }
    return held.length + ' with captured parts (' + k + ' in all)';
  }

  /** "line x1 . large shape x1 (12 parts) . dots x20 . bare plate", for the
      groups ticked; the last item is what the plate is left as. */
  function breakdown(A, minH, tickedKeys) {
    var gs = groups(A, minH), parts = [], kept = 0;
    gs.list.forEach(function (G) {
      if (!tickedKeys || tickedKeys[G.key] !== false) parts.push(groupWords(G));
      else kept += G.ids.length;
    });
    kept += gs.cant + gs.low;
    parts.push(kept ? 'the plate keeps ' + kept : 'bare plate');
    return parts.join(' · ');
  }

  // =========================================================================
  // The card
  // =========================================================================

  var armed = false;
  var targetId = null;                      // the piece's model id
  var D = null;                             // the read of the face being read (detectSoup's or detectFace's answer)
  var face = null;                          // the face under the cursor { key, n, area }; null = the top, the default
  var minH = null;
  var hoverId = -1;
  var pending = new Set();                  // a Shift group, not yet lifted
  var stripOpen = false;
  var stripTicks = { dots: true, lines: true, large: true };
  var busy = false;
  var layer = null;
  var lastMsg = '';

  function defaultMin() { return LF() ? LF().defaultMinHeight() : 0.42; }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }
  function placedOf(id) { return (state.placed || []).find(function (p) { return p && p.sourceId === id; }) || null; }
  function A() { return D && D.ok ? D.A : null; }

  /** The card's line only: what the HUD must not repeat. */
  function sayCard(msg, bad) {
    lastMsg = msg;
    var r = $('lift-readout');
    if (r) { r.textContent = msg; r.classList.toggle('carve-bad', !!bad); }
  }
  function say(msg, bad) {
    sayCard(msg, bad);
    if (typeof setStatus === 'function') setStatus(msg, !!bad);
  }
  function fail(msg) { say(msg, true); return { ok: false, reason: msg }; }

  /** The world's up, in the piece's raw frame (raw = display (x, -z, y)). */
  function viewOf(p) {
    if (!p || !p.mesh || typeof THREE === 'undefined') return [0, 0, 1];
    p.mesh.updateMatrixWorld(true);
    var q = new THREE.Quaternion();
    p.mesh.getWorldQuaternion(q);
    var u = new THREE.Vector3(0, 1, 0).applyQuaternion(q.invert());
    var n = [u.x, -u.z, u.y];
    return n.map(function (x) { return Math.abs(x) < 1e-6 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-6 ? Math.sign(x) : x; });
  }

  /** Why this piece cannot be lifted from, in words; null when it can. */
  function refusalFor(m, p) {
    if (!m || !p) return 'Lift works on pieces on the plate - that is not one. Nothing changed.';
    if (!(m.rawTris && m.rawAxis === 'zup')) {
      return 'Lift needs a raw piece - "' + m.name + '" has no untransformed soup. Nothing changed.';
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return 'Lift stood down - ' + painted + ' painted face(s) on "' + m.name + '"; the piece gets a new soup and cannot ' +
        'hold a face still. Clear paint to lift.';
    }
    var g = p.mesh && p.mesh.geometry, pos = g && g.attributes && g.attributes.position;
    if (!pos || g.index || pos.count * 3 !== m.rawTris.length) {
      return 'Lift: "' + m.name + '" on the plate does not match its own mesh - nothing changed.';
    }
    return null;
  }

  /** The read of the face being read on a piece: the top (the default), or the
      face under the cursor. A face that has gone from the soup (a lift took
      its last stand, an Undo) falls back to the top. */
  function readTarget(m, p) {
    if (face) {
      var r = face.surf ? detectSurface(m.rawTris, face) : detectFace(m.rawTris, face);
      if (r.refused !== 'noface') return r;
      face = null;
    }
    return detectSoup(m.rawTris, viewOf(p));
  }

  /** Point the card at a piece: read it (or its cached read) and say so. */
  function target(id) {
    var m = modelOf(id), p = placedOf(id);
    clearHover(); pending = new Set(); closeStrip(true);
    face = null;
    var why = refusalFor(m, p);
    if (why) { targetId = null; D = null; draw(); sync(); return fail(why); }
    targetId = id;
    D = readTarget(m, p);
    syncSlider();
    draw(); sync();
    if (!D.ok) return fail(D.reason);
    say(readout());
    return { ok: true, count: offered(A(), minH).length, cached: D.cached, ms: D.ms };
  }

  /** Re-read the target if its soup changed (a lift, an Undo, any edit). */
  function refresh() {
    if (!armed || targetId == null) { draw(); sync(); return; }
    var m = modelOf(targetId), p = placedOf(targetId);
    if (!m || !p) { targetId = null; D = null; face = null; clearHover(); draw(); sync(); return; }
    D = readTarget(m, p);
    if (hoverId >= 0 && !(A() && A().islands[hoverId])) hoverId = -1;
    syncSlider(); draw(); sync();
  }

  function readout() {
    if (!armed) return 'Lift off.';
    if (targetId == null) return 'Lift: click a piece on the plate to find what stands on it.';
    if (!D || !D.ok) return D ? D.reason : '';
    var m = modelOf(targetId), a = A(), gs = groups(a, minH), n = offered(a, minH).length;
    var parts = [];
    if (face && !a.islands.length) return 'Nothing stands out from this face.';
    if (!a.islands.length) {
      parts.push('Nothing found on ' + m.name + ': nothing stands out of its top more than ' + f2(a.map.thresholdMm) + ' mm.');
      return parts.join(' ');
    }
    parts.push(n + ' feature' + (n === 1 ? '' : 's') + ' found on ' + m.name + ' standing out more than ' + f2(minH) + ' mm' +
      (n ? ': ' + gs.list.map(groupWords).join(' · ') : '') + '.');
    if (gs.low) parts.push(gs.low + ' lower, not offered.');
    if (gs.cant) {
      var why = {};
      a.islands.forEach(function (I) { if (I.status !== 'ok') { var k = I.status === 'slant' ? cantWords({ status: 'slant' }) : cantWords(I); why[k] = (why[k] || 0) + 1; } });
      parts.push(gs.cant + ' can\'t be lifted - ' + Object.keys(why).map(function (k) { return why[k] + ': ' + k; }).join('; ') + '.');
    }
    if (pending.size) parts.push(pending.size + ' gathered - let go of Shift to lift ' + (pending.size === 1 ? 'it' : 'them') + ' in one step.');
    else if (n) parts.push('Hover a feature to see it; click lifts it, Shift-click gathers several. Or Strip.');
    return parts.join(' ');
  }

  function syncSlider() {
    if (minH == null) minH = defaultMin();
    var s = $('lift-height'), rd = $('lift-height-read');
    if (s) {
      var top = 0, a = A();
      if (a) a.islands.forEach(function (I) { if (I.status === 'ok' && I.heightMm > top) top = I.heightMm; });
      s.max = String(Math.max(1, Math.ceil(Math.max(top, minH) * 100 + 1) / 100));
      s.value = String(minH);
    }
    if (rd) rd.textContent = f2(minH) + ' mm';
  }

  function setMinHeight(h) {
    var v = +h;
    if (!(v >= 0) || !isFinite(v)) return minH;
    minH = v;
    var off = new Set(offered(A(), minH));
    pending.forEach(function (id) { if (!off.has(id)) pending.delete(id); });
    syncSlider(); draw(); sync();
    if (armed && D) say(readout());
    return minH;
  }

  function sync() {
    var b = $('btn-lift');
    if (b) { b.setAttribute('aria-pressed', armed ? 'true' : 'false'); b.classList.toggle('is-armed', armed); }
    var panel = $('lift-panel');
    if (panel) panel.hidden = !armed;
    var a = A(), n = offered(a, minH).length, asm = armed && targetId != null && D && D.ok ? assemblyWords(a, minH) : '';
    var c = $('lift-count');
    if (c) c.textContent = !armed || targetId == null ? '—' : !D || !D.ok ? 'nothing read' :
      n + ' feature' + (n === 1 ? '' : 's') + ' found' + (asm ? ' \u2014 ' + asm : '');
    var sb = $('btn-lift-strip');
    if (sb) sb.disabled = !(armed && n && !busy);
    syncStrip();
    var r = $('lift-readout');
    if (r && armed && !busy && lastMsg !== r.textContent) r.textContent = lastMsg || readout();
  }

  // =========================================================================
  // Arming
  // =========================================================================

  /** One click-owning mode at a time, as Carve's disarmOthers. */
  function disarmOthers() {
    if (state.carveArmed) { var c = $('btn-carve'); if (c) c.click(); else state.carveArmed = false; }
    if (state.maskPaint) {
      var paintBtn = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (state.seatHereArmed) { var s = $('btn-seat-here'); if (s) s.click(); else state.seatHereArmed = false; }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      var br = $('btn-brush');
      if (br) br.click(); else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (typeof window.nsoPullArmed === 'function' && window.nsoPullArmed()) {
      var pl = $('btn-pull');
      if (pl) pl.click(); else if (typeof window.nsoPullSetArmed === 'function') window.nsoPullSetArmed(false);
    }
    if (state.measureOn) { var mb = $('btn-measure'); if (mb) mb.click(); else state.measureOn = false; }
    state.softenArmed = false;
    state.capArmed = false;
    state.centerLockArmed = false;
  }

  function setArmed(on) {
    on = !!on;
    if (on === armed) { sync(); return armed; }
    armed = on;
    if (!armed) {
      clearHover(); pending = new Set(); closeStrip(true);
      targetId = null; D = null; face = null;
      draw(); sync();
      say('Lift off.');
      return armed;
    }
    disarmOthers();
    if (minH == null) minH = defaultMin();
    var p = state.placed && state.placed[state.selectedIndex];
    if (p && p.sourceId != null) target(p.sourceId);
    else { targetId = null; D = null; draw(); sync(); say(readout()); }
    return armed;
  }

  // =========================================================================
  // The pointer: hover outlines, click lifts, Shift-click gathers
  // =========================================================================

  /** The piece and raw triangle under a pointer event, or null. */
  function hitAt(ev) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    var rect = state.renderer.domElement.getBoundingClientRect();
    var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1, ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
    var hits = rc.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      var p = typeof idx === 'number' ? state.placed[idx] : null;
      if (p && p.sourceId != null) return { placed: p, id: p.sourceId, tri: hits[i].faceIndex };
    }
    return null;
  }

  /** The feature at raw triangle `tri` of the target: { id, I } or null. */
  function featureAt(tri) {
    var a = A();
    if (!a || !(tri >= 0)) return null;
    var id = a.islandOf[tri];
    return id >= 0 ? { id: id, I: a.islands[id] } : null;
  }

  /** Why a found feature can't be lifted, in the plate's words. The engine's
      own words for 'slant' tell G-scope's user to click the face nearer it;
      on the plate the view is straight down, so the piece is what turns. */
  function cantWords(I) {
    if (I.status === 'slant') {
      return 'it stands where the piece slopes ' + (I.slantDeg != null ? (+I.slantDeg).toFixed(0) + '\u00b0' : 'too far') +
        ' away from looking up (35\u00b0 is the most Lift reads) - turn the piece so that side faces up';
    }
    return (LA().WHY[I.status] || I.reason);
  }

  /** Why a feature cannot be lifted at the slider, in words; null when it can. */
  function whyNot(I) {
    if (I.status !== 'ok') return 'Lift: that can\'t be lifted - ' + cantWords(I) + '.';
    if (!(I.heightMm > minH)) {
      return 'Lift: that stands out only ' + f2(I.heightMm) + ' mm, not more than ' + f2(minH) +
        ' mm - lower "How far out counts" to offer it.';
    }
    return null;
  }

  /* One raycast a frame, however many moves arrive in it. */
  var hoverEv = null, hoverRaf = false;
  function onMove(ev) {
    if (!armed || busy || stripOpen || targetId == null) return;
    if (ev.buttons) return;                   // orbiting or panning
    hoverEv = ev;
    if (hoverRaf) return;
    hoverRaf = true;
    requestAnimationFrame(function () {
      hoverRaf = false;
      var e = hoverEv; hoverEv = null;
      if (e && armed && !busy && !stripOpen) hoverAt(e);
    });
  }

  function hoverAt(ev) {
    var h = hitAt(ev), id = -1;
    /* Only a pointer over the viewport itself picks a face: crossing the
       card or a menu on the way to a button leaves the face as it was. */
    var onCanvas = !!state.renderer && ev.target === state.renderer.domElement;
    if (h && h.id === targetId) {
      if (onCanvas) settleFace(h);
      var f = featureAt(h.tri);
      if (f) id = f.id;
    } else if (onCanvas && face && !face.surf) {
      setFace(null);                            // off the piece: the top is the default (a curved surface read by a click stays)
    }
    setHover(id);
  }

  /** Read from another face: null is the top. Gathered features belong to the
      face they were gathered on, so they are dropped. Said on the card only. */
  function setFace(f) {
    if ((f ? f.key : null) === (face ? face.key : null)) return false;
    var m = modelOf(targetId), p = placedOf(targetId);
    if (!m || !p) return false;
    face = f;
    hoverId = -1; pending = new Set();
    D = readTarget(m, p);
    syncSlider(); draw(); sync();
    sayCard(readout(), !!(D && !D.ok));
    /* The card now reads another face; the HUD must not keep the last one's words. */
    if (typeof setStatus === 'function') setStatus('');
    return true;
  }

  /** The cursor is on raw triangle h.tri of the target. A triangle that is
      one of the features of the face being read leaves the face alone; any
      other is on a face, which becomes the one read when it is a base. */
  function settleFace(h, click) {
    /* On a feature the cursor is on the thing, not a new face - except a click on one that cannot be lifted
       (the whole of a vase's wall is one, "it runs off the edge"): that reads the curved surface it is on. */
    var fe = A() && featureAt(h.tri);
    if (fe && !(click && fe.I.status !== 'ok')) return false;
    if (face && face.surf && A() && A().region && A().region.inR[h.tri]) return false;   // already on the surface being read
    var m = modelOf(targetId), p = placedOf(targetId);
    if (!m || !p || stripOpen || busy) return false;
    var c = faceOfTri(m.rawTris, h.tri, viewOf(p), click);
    if (c == null) return false;
    if (fe && !c.surf) return false;
    /* Only a curved surface takes a click: a planar patch is read as it always was (nothing changes). */
    if (c.surf) {
      var rs = detectSurface(m.rawTris, c);
      if (!rs.ok || !rs.A || rs.A.engine !== 'surface') return false;
    }
    /* Hovering with a curved surface read: only a planar face takes it from the surface - the top, which any
       up-looking triangle is, does not. */
    if (!click && face && face.surf && c === 'top') return false;
    return setFace(c === 'top' ? null : c);
  }

  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    draw();
    var a = A();
    if (id >= 0 && a) {
      var I = a.islands[id], why = whyNot(I);
      var r = $('lift-readout');
      var txt = why || ('A ' + (WORDS[I.group] ? WORDS[I.group][0] : 'feature') + ', ' + f2(I.heightMm) + ' mm high, ' +
        I.areaMm2.toFixed(1) + ' mm²' + ((I.necks && I.necks.parts > 1) ? ', ' + I.necks.parts + ' parts' : '') +
        (I.partCount ? ', with ' + capturedWords(I.partCount) : '') +
        ' - click to lift it, Shift-click to gather it.');
      if (r) { r.textContent = txt; r.classList.toggle('carve-bad', !!why); }
    } else if (armed) {
      var rr = $('lift-readout');
      if (rr) { rr.textContent = lastMsg || readout(); rr.classList.remove('carve-bad'); }
    }
  }
  function clearHover() { if (hoverId !== -1) { hoverId = -1; draw(); } }

  /** app-core's pointerdown asks this first (after Carve), as Carve's. */
  function takesClick(ev) {
    if (!armed || !ev || ev.button !== 0 || stripOpen) return false;
    var h = hitAt(ev);
    if (!h) return false;
    if (busy) { say('Lift: the last lift is still running - one at a time', true); return true; }
    if (h.id !== targetId) {
      // another piece: point the card at it (and select it)
      var idx = state.placed.indexOf(h.placed);
      if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
      target(h.id);
      return true;
    }
    var f = featureAt(h.tri);
    if ((!f || f.I.status !== 'ok') && settleFace(h, true)) return true; // the click read the face under it; lifting takes a second click
    if (!f) { say('Lift: nothing to lift there - ' + (offered(A(), minH).length ? 'hover a feature first.' : 'nothing is found on this piece.')); return true; }
    var why = whyNot(f.I);
    if (why) { fail(why); return true; }
    if (ev.shiftKey) { gather(f.id); return true; }
    var ids = pending.size ? Array.from(pending) : [];
    if (ids.indexOf(f.id) < 0) ids.push(f.id);
    pending = new Set();
    setTimeout(function () { lift(ids); }, 0);
    return true;
  }

  function gather(id) {
    if (pending.has(id)) pending.delete(id); else pending.add(id);
    draw(); sync();
    say(readout());
    return Array.from(pending);
  }

  function onKeyUp(ev) {
    if (ev.key !== 'Shift' || !armed || !pending.size || busy) return;
    var ids = Array.from(pending);
    pending = new Set();
    lift(ids);
  }

  // =========================================================================
  // Strip: the untick list, Confirm / Cancel
  // =========================================================================

  function openStrip() {
    if (!armed || !A() || !offered(A(), minH).length) return fail('Strip: nothing is found to lift.');
    stripOpen = true;
    stripTicks = { dots: true, lines: true, large: true };
    pending = new Set(); clearHover();
    draw(); sync();
    say('Strip: untick what stays on the plate, then Confirm. One Undo puts it all back.');
    return { ok: true, list: stripList() };
  }
  function closeStrip(quiet) {
    if (!stripOpen) return;
    stripOpen = false;
    draw(); sync();
    if (!quiet) say(readout());
  }
  function stripIds() {
    var ids = [];
    groups(A(), minH).list.forEach(function (G) { if (stripTicks[G.key] !== false) ids = ids.concat(G.ids); });
    return ids;
  }
  function stripList() { return breakdown(A(), minH, stripTicks); }
  function setStripGroup(key, v) {
    if (!(key in stripTicks)) return null;
    stripTicks[key] = !!v;
    draw(); sync();
    return stripList();
  }
  function confirmStrip() {
    if (!stripOpen) return fail('Strip: open the list first.');
    var ids = stripIds();
    if (!ids.length) return fail('Strip: nothing is ticked - nothing changed.');
    stripOpen = false;
    return lift(ids, 'strip');
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function syncStrip() {
    var box = $('lift-strip');
    if (!box) return;
    box.hidden = !(armed && stripOpen);
    if (box.hidden) return;
    var gs = groups(A(), minH), rows = $('lift-strip-rows');
    if (rows) {
      rows.innerHTML = gs.list.map(function (G) {
        return '<label class="lift-strip-row"><input type="checkbox" data-group="' + G.key + '"' +
          (stripTicks[G.key] !== false ? ' checked' : '') + ' /> ' + esc(groupWords(G)) + '</label>';
      }).join('') + (gs.cant ? '<p class="lift-strip-note">' + gs.cant + ' can\'t be lifted - they stay.</p>' : '') +
        (gs.low ? '<p class="lift-strip-note">' + gs.low + ' lower than ' + f2(minH) + ' mm - they stay.</p>' : '');
    }
    var sum = $('lift-strip-sum');
    if (sum) sum.textContent = stripList();
    var go = $('btn-lift-strip-go'), n = stripIds().length;
    if (go) { go.disabled = !n || busy; go.textContent = 'Confirm – lift ' + n; }
  }

  // =========================================================================
  // Lift: the swap, the pieces, one Undo
  // =========================================================================

  /** Take pieces off the plate and out of the model list. No undo step. */
  function takeOff(ids) {
    var drop = new Set(ids);
    state.placed.forEach(function (p) { if (p && drop.has(p.sourceId) && p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
  }

  function lift(ids, how) {
    if (busy) return { ok: false, reason: 'busy' };
    var want = (ids || []).slice();
    var a = A();
    if (!armed || !a || targetId == null) return fail('Lift: arm Lift on a piece first.');
    if (!want.length) return fail('Lift: nothing is chosen - nothing changed.');
    for (var w = 0; w < want.length; w++) {
      var I0 = a.islands[want[w]];
      if (!I0) return fail('Lift: no such feature - nothing changed.');
      var why = whyNot(I0);
      if (why) return fail(why);
    }
    var m = modelOf(targetId), placed = placedOf(targetId);
    var refused = refusalFor(m, placed);
    if (refused) return fail(refused);
    // the features must be this soup's: a cached read is, anything else is read again first
    var cur = readTarget(m, placed);
    if (!cur.ok || cur.A !== a) { D = cur; refresh(); return fail('Lift: "' + m.name + '" changed since it was read - read again, try once more. Nothing changed.'); }
    busy = true;
    clearHover();
    try {
      var deps = { rawFlatCapLoops: window.rawFlatCapLoops || (typeof rawFlatCapLoops === 'function' ? rawFlatCapLoops : null) };
      var r = engineOf(a).lift(m.rawTris, a, want, deps);
      if (!r.ok) return fail('Lift refused - nothing changed: ' + r.reason);

      /* The pieces first, so a failure to add one leaves the plate alone. */
      var added = [], names = [];
      for (var i = 0; i < r.pieces.length; i++) {
        var pc = r.pieces[i];
        var name = (m.name || 'piece') + ' - lifted ' + (pc.id + 1);
        var id = addModel(name, rawResultToDisplayGeometry(pc.soup), {
          rawTris: pc.soup, rawAxis: 'zup', centerOffset: computeCenterOffsetFromRaw(pc.soup),
          keepSelection: true, silent: true
        });
        if (id == null) {
          takeOff(added);
          return fail('Lift refused - nothing changed: feature ' + (pc.id + 1) + ' is too small to be a piece ' +
            '(under 0.1 mm across one way)');
        }
        added.push(id); names.push(name);
      }

      var nCurved = r.pieces.filter(function (pc2) { return pc2.fill; }).length;
      var where = nCurved ? (nCurved === want.length ? '' : 'flat where ' + (want.length - nCurved === 1 ? 'one' : 'some') + ' stood on a flat face, ') +
        'the surface round ' + (want.length === 1 ? 'it' : 'them') + ' carried across where ' + (want.length === 1 ? 'it' : 'they') +
        ' stood and welded to it at the rim' : 'flat where ' + (want.length === 1 ? 'it' : 'they') + ' stood';
      var heldN = r.pieces.reduce(function (s2, pc3) { return s2 + (pc3.parts || 0); }, 0);
      var txt = 'Lifted ' + r.pieces.length + ' feature' + (r.pieces.length === 1 ? '' : 's') + ' off ' + m.name +
        (heldN ? ' with ' + capturedWords(heldN) + ' (still separate shells, gaps as they were)' : '') +
        ' (' + r.volumes.pieces.toFixed(2) + ' mm³): it is ' + where + ', every other triangle as it was, and ' +
        (r.pieces.length === 1 ? 'the new piece stays' : 'the new pieces stay') + ' where ' + (r.pieces.length === 1 ? 'it' : 'they') +
        ' stood' + ' - grab ' + (r.pieces.length === 1 ? 'it' : 'one') + ' to drop it somewhere else. One Undo (Ctrl+Z) puts it all back.';
      if (r.notes && r.notes.length) txt += ' Note: ' + r.notes.join('; ') + '.';
      var before0 = state.undoStack.length;
      if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(m, r.plate, 'liftReplace', txt)) {
        takeOff(added);
        return fail('Lift refused - nothing changed: the commit was rejected');
      }
      var rep = state.undoStack.length > before0 ? state.undoStack.pop() : null;
      pushUndo({ type: 'featureSwap', replace: rep, addedIds: added.slice(), removed: [], label: 'Undo: Lift reverted',
        onUndone: afterUndo });

      /* Each new piece exactly where it stood on the parent, as the parent
         is drawn now (the commit rebuilt its mesh). */
      var spots = [];
      added.forEach(function (id2) {
        var made = modelOf(id2);
        var entry = placeModelMovable(made, placed.x, placed.z);
        if (!entry) return;
        spots.push(landInPlace(entry, made, m, placedOf(m.id)));
      });
      if (typeof renderModelList === 'function') renderModelList();
      if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
      if (typeof updateEditSize === 'function') updateEditSize();
      if (typeof updateAdjustUI === 'function') updateAdjustUI();

      var up = spots.filter(function (s) { return s && s.liftY > 0; });
      if (up.length === 1 && r.pieces.length === 1) {
        txt += ' It is in the air, ' + f2(up[0].liftY) + ' mm over the bed, and stays there until dropped or sent To plate.';
      } else if (up.length) {
        txt += ' ' + (up.length === r.pieces.length ? 'They are' : up.length + ' are') +
          ' in the air over the bed, and stay there until dropped or sent To plate.';
      }
      busy = false;
      refresh();
      var left = offered(A(), minH).length;
      say(txt + ' ' + left + ' feature' + (left === 1 ? '' : 's') + ' left on it.');
      return { ok: true, lift: r, addedIds: added, names: names, hostId: m.id, spots: spots, how: how || 'pick', reason: txt };
    } catch (err) {
      console.error('[lift]', err);
      return fail('Lift failed - nothing changed (' + ((err && err.message) || err) + ')');
    } finally {
      busy = false;
      sync();
    }
  }

  /** Put a lifted piece where it stood on `host`: the parent's pose, and
      the mesh where the parent draws those same raw triangles. Both soups
      are in the parent's raw frame; each display mesh is that soup turned
      (raw (x, y, z) -> (x, z, -y)) and centred on its own box, so the
      piece's origin is the parent's moved by the difference of the two
      centres, carried through the parent's rotation. Its height above the
      bed is what it is - liftY records it, the floating state. */
  function landInPlace(entry, made, hostModel, host) {
    if (!host || !host.mesh) return null;
    ['rotY', 'rotated', 'flipX', 'tipX', 'tipZ', 'tiltX', 'tiltZ'].forEach(function (k) { entry[k] = host[k]; });
    entry.liftY = 0;
    applyMeshRotation(entry);
    var cH = hostModel.centerOffset, cN = made.centerOffset;
    host.mesh.updateMatrixWorld(true);
    var at = host.mesh.localToWorld(new THREE.Vector3(cN.x - cH.x, cN.y - cH.y, cN.z - cH.z));
    entry.mesh.quaternion.copy(host.mesh.quaternion);
    entry.mesh.position.copy(at);
    entry.mesh.updateMatrixWorld(true);
    entry.x = at.x; entry.z = at.z;
    var lift = meshLocalBox3(entry.mesh).min.y - 0.2;
    entry.liftY = lift > 1e-6 ? lift : 0;
    return { x: at.x, y: at.y, z: at.z, liftY: entry.liftY };
  }

  /** The Lift step was undone: the piece is back with its old soup, whose
      features are still in the cache. */
  function afterUndo() {
    pending = new Set(); hoverId = -1; stripOpen = false;
    refresh();
    if (armed) say('Undo: Lift reverted - the piece and its features are back as they were. ' + readout());
  }

  // =========================================================================
  // Drawing: every found feature outlined faintly, the hovered one bright,
  // a Shift group filled
  // =========================================================================

  function ensureLayer() {
    if (!state.scene || typeof THREE === 'undefined') return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'liftPlate'; layer.renderOrder = 9; }
    if (layer.parent !== state.scene) {
      if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, layer, 'lift-plate');
      else state.scene.add(layer);
    }
    return layer;
  }
  /* The tint of a read surface can be hundreds of thousands of triangles: built once per read, not per redraw. */
  var tint = null;
  function dropTint() {
    if (!tint) return;
    if (tint.mesh.geometry) tint.mesh.geometry.dispose();
    if (tint.mesh.material) tint.mesh.material.dispose();
    tint = null;
  }
  function clearLayer() {
    if (!layer) return;
    for (var i = layer.children.length - 1; i >= 0; i--) {
      var c = layer.children[i];
      layer.remove(c);
      if (tint && c === tint.mesh) continue;
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    if (tint && !(face && face.surf && A() === tint.A)) dropTint();
  }

  /** The outline of a set of triangles: the edges only one of them uses. */
  function outlineOf(P, tris) {
    var seen = new Map(), key = function (o) { return P[o].toFixed(4) + ',' + P[o + 1].toFixed(4) + ',' + P[o + 2].toFixed(4); };
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var a = t * 9 + k * 3, b = t * 9 + ((k + 1) % 3) * 3, ka = key(a), kb = key(b);
        var e = ka < kb ? ka + '|' + kb : kb + '|' + ka, s = seen.get(e);
        if (s) s.n++; else seen.set(e, { n: 1, a: a, b: b });
      }
    });
    var out = [];
    seen.forEach(function (s) { if (s.n === 1) out.push(P[s.a], P[s.a + 1], P[s.a + 2], P[s.b], P[s.b + 1], P[s.b + 2]); });
    return out;
  }

  function lines(arr, colour, opacity) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity: opacity, depthTest: false }));
  }
  function fill(P, tris, colour, opacity) {
    var pos = new Float32Array(tris.length * 9);
    tris.forEach(function (t, i) { for (var k = 0; k < 9; k++) pos[i * 9 + k] = P[t * 9 + k]; });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: opacity, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  }

  /** A feature's triangles and, behind them, those of the parts it holds. */
  function withParts(I) {
    var out = I.tris;
    (I.parts || []).forEach(function (P) { out = out.concat(P.tris); });
    return out;
  }

  function draw() {
    if (!ensureLayer()) return;
    clearLayer();
    layer.visible = armed;
    var a = A(), p = targetId != null ? placedOf(targetId) : null;
    if (!armed || !a || !p || !p.mesh) return;
    var P = p.mesh.geometry.attributes.position.array;
    if (P.length !== modelOf(targetId).rawTris.length) return;
    p.mesh.updateMatrixWorld(true);
    layer.matrixAutoUpdate = false;
    layer.matrix.copy(p.mesh.matrixWorld);
    layer.matrixWorldNeedsUpdate = true;
    var off = offered(a, minH), all = [];
    if (face && face.surf) {
      if (!tint || tint.A !== a) { dropTint(); tint = { A: a, mesh: fill(P, a.region.tris, FACE, 0.3) }; }
      layer.add(tint.mesh);
    } else if (face) {
      var fp = planeByKey(modelOf(targetId).rawTris, face.key);
      if (fp) layer.add(fill(P, fp.tris, FACE, 0.38));
    }
    var stripSet = stripOpen ? new Set(stripIds()) : null;
    off.forEach(function (id) { if (id !== hoverId && !pending.has(id)) all = all.concat(a.islands[id].tris); });
    if (all.length) layer.add(lines(outlineOf(P, all), FOUND, stripOpen ? 0.35 : 0.55));
    if (stripSet && stripSet.size) {
      var ticked = [];
      stripSet.forEach(function (id) { ticked = ticked.concat(withParts(a.islands[id])); });
      layer.add(fill(P, ticked, PENDING, 0.55));
    }
    if (pending.size) {
      var g = [];
      pending.forEach(function (id) { g = g.concat(withParts(a.islands[id])); });
      layer.add(fill(P, g, PENDING, 0.6));
      layer.add(lines(outlineOf(P, g), PENDING, 1));
    }
    if (hoverId >= 0 && a.islands[hoverId]) {
      var I = a.islands[hoverId], ok = !whyNot(I);
      layer.add(fill(P, withParts(I), ok ? HOVER : 0xb91c1c, 0.45));
      layer.add(lines(outlineOf(P, I.tris), ok ? HOVER : 0xef4444, 1));
    }
  }

  // =========================================================================
  // Wiring
  // =========================================================================

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('lift-plate', {
    live: function () { return armed; },
    close: function () { setArmed(false); },
    clear: clearLayer,
    refresh: function () { draw(); }
  });

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    minH = defaultMin();
    bind('btn-lift', 'click', function () { setArmed(!armed); });
    bind('btn-lift-strip', 'click', function () { openStrip(); });
    bind('btn-lift-strip-go', 'click', function () { confirmStrip(); });
    bind('btn-lift-strip-cancel', 'click', function () { closeStrip(); });
    bind('lift-strip-rows', 'change', function (e) {
      var k = e.target && e.target.getAttribute && e.target.getAttribute('data-group');
      if (k) setStripGroup(k, e.target.checked);
    });
    bind('lift-height', 'input', function () { setMinHeight(parseFloat($('lift-height').value)); });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { if (pending.size) { pending = new Set(); draw(); sync(); } });
    syncSlider();
    sync();
  }

  if (typeof window !== 'undefined') window.nsoLiftTakesClick = takesClick;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    detectSoup: detectSoup,
    detectFace: detectFace,
    detectSurface: detectSurface,
    faceOfTri: faceOfTri,
    face: function () { return face ? (face.surf ? { key: face.key, surf: true, tri: face.tri } : { key: face.key, n: face.n.slice(), area: face.area }) : null; },
    viewFor: function (id) { return viewOf(placedOf(id)); },
    groups: groups,
    groupWords: groupWords,
    breakdown: breakdown,
    setArmed: setArmed,
    isArmed: function () { return armed; },
    target: target,
    targetId: function () { return targetId; },
    analysis: A,
    detection: function () { return D ? { ok: D.ok, cached: D.cached, ms: D.ms, seed: D.seed, reason: D.reason } : null; },
    offered: function () { return offered(A(), minH); },
    count: function () { return offered(A(), minH).length; },
    setMinHeight: setMinHeight,
    minHeight: function () { return minH; },
    hover: function () { return hoverId; },
    setHover: setHover,
    pending: function () { return Array.from(pending); },
    lift: lift,
    openStrip: openStrip,
    closeStrip: closeStrip,
    setStripGroup: setStripGroup,
    stripList: stripList,
    confirmStrip: confirmStrip,
    readout: readout,
    layer: function () { return layer; }
  };
})();

if (typeof window !== 'undefined') window.NSO_LIFT_PLATE = NSO_LIFT_PLATE;
