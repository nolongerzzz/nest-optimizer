/* nso_split_parts.js - SPLIT TO PARTS: a piece made of several shells becomes
   one piece per part.

   Loads as a classic script (window.NSO_SplitParts) and as a Node module
   (require('../nso_split_parts.js')). Speaks the app's raw soup: a
   Float32Array/Array of 9 numbers per triangle, Z up, millimetres. No DOM, no
   Three.js. Needs nso_hollow.js (cavityShells) and nso_shells.js, loaded before it.

   WHAT A PART IS
     A part is an OUTER shell plus the cavity shells inside it. An inner shell
     wholly contained in another is a hollow, not a part: it stays with its
     outer. "A cavity" is nso_hollow.js cavityShells()'s word - inward-wound
     and sitting in material, Fill's own reading and the one definition in the
     repo - so this file asks there and carries no second copy of the test.
     A captive SOLID (a rattle's ball, a pin through a knuckle) is wound
     outward and is not a cavity: it is a part of its own, which is the point
     of splitting a print-in-place assembly.

     A shell that CROSSES another (box_closed: a tray and a lid laid through each
     other; a vase and the handle shell through its body) is a part whatever the
     winding says: nso_shells.js asks, and a crossing shell is never a hollow.
     (docs/SHELLS-AS-PIECES.md)

     Touching-but-separate shells are separate parts. cavityShells joins faces
     across any shared welded edge, so two cubes set face to face on one grid
     read as one shell there. Here the shells are re-cut along the surface: an
     edge used by exactly two faces joins them; an edge used by more (two
     shells meeting along it) is resolved by the order its faces come round the
     edge, each wedge of material pairing the two faces that bound it. Shells
     that meet only at a corner share no edge and were never one.

   THE CONTRACT
     analyse(soup, opts)   -> { ok, parts, shells, cavities, tris, words, reason }
         parts: [{ id, faces, shells, cavities, tris }], ordered by the first
         triangle each owns; ok is true only when there are TWO or more.
         `words` is "1 part" / "3 parts" - what the card says before the
         button is pressed. A refusal (one part, empty piece) is ok false with
         a reason in plain words and nothing else changed.
     split(soup, opts)     -> analyse() plus parts[i].soup: a new Float32Array
         per part, its triangles copied bit for bit in their original order.
         The input is never written to. Every triangle of the input lands in
         exactly one part, so the counts sum to the original.
     splitFrom(a, soup)    -> the same, for an analysis already made (split is
         analyse followed by this).
     describe(a)           -> "3 parts" / "1 part (2 shells, ...)": the readout.

   PAINT SCOPE: WHOLE-PIECE (docs/HANDOFF.md, "Scoping") - decided in the app
   layer (app-split-parts.js): the original piece leaves and new pieces come,
   so no painted face could be held still. The engine takes no mask. */
(function (root) {
  'use strict';

  var NODE = (typeof module !== 'undefined' && module.exports);
  var H = NODE ? require('./nso_hollow.js') : null;
  var SH = NODE ? require('./nso_shells.js') : null;

  function hollowMod() {
    if (!H && root) H = root.NSO_Hollow;
    if (!H || typeof H.cavityShells !== 'function' || typeof H.signedVolume !== 'function') {
      throw new Error('nso_split_parts.js needs nso_hollow.js (cavityShells) - a cavity is what Fill / Densify says it is');
    }
    return H;
  }

  var BOX_PAD = 1e-6;                     // a cavity's box is inside its outer's box to this
  var DIRS = [[0.2672612, 0.5345225, 0.8017837],
              [-0.6, 0.31, 0.7396621],
              [0.1805, -0.9097, 0.3727]];   // three ray directions, none along an axis or a diagonal

  function words(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function shellsMod() {
    if (!SH && root) SH = root.NSO_Shells;
    if (!SH || typeof SH.cutShells !== 'function') throw new Error('nso_split_parts.js needs nso_shells.js (the cut into shells, and which cross)');
    return SH;
  }

  /* ------------------------------------------------------------------
     Shells, cut along the surface (see the header; the cut is nso_shells.js's).
     C is cavityShells()'s result: C.P.vids are the welded corner ids of each
     triangle in the soup's own order, C.P.tris the welded positions.
     -> { n, of: Int32Array (shell per face), faces: [[face...]], odd }
     ------------------------------------------------------------------ */
  function surfaceShells(C) {
    var vids = C.P.vids, tris = C.P.tris, nf = vids.length, f, k, nv = 0;
    var ids = new Int32Array(nf * 3);
    for (f = 0; f < nf; f++) for (k = 0; k < 3; k++) {
      var v = vids[f][k];
      ids[f * 3 + k] = v;
      if (v >= nv) nv = v + 1;
    }
    var pos = new Float64Array(nv * 3);
    for (f = 0; f < nf; f++) for (k = 0; k < 3; k++) {
      var at = vids[f][k] * 3, P = tris[f][k];
      pos[at] = P[0]; pos[at + 1] = P[1]; pos[at + 2] = P[2];
    }
    return shellsMod().cutShells(ids, pos);
  }

  /* ------------------------------------------------------------------
     Which part holds a cavity: parity of a ray from a point on the cavity's
     wall against the OUTER shell's own faces, three directions and a vote.
     ------------------------------------------------------------------ */
  function rayHits(tris, faces, o, d) {
    var n = 0;
    for (var i = 0; i < faces.length; i++) {
      var T = tris[faces[i]], A = T[0], B = T[1], Cc = T[2];
      var e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
      var e2x = Cc[0] - A[0], e2y = Cc[1] - A[1], e2z = Cc[2] - A[2];
      var px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      var det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      var inv = 1 / det, tx = o[0] - A[0], ty = o[1] - A[1], tz = o[2] - A[2];
      var u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      var v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-9) n++;
    }
    return n;
  }
  function insideShell(tris, faces, pts) {
    var votes = 0, asked = 0;
    for (var p = 0; p < pts.length; p++) for (var d = 0; d < DIRS.length; d++) {
      asked++;
      if ((rayHits(tris, faces, pts[p], DIRS[d]) & 1) === 1) votes++;
    }
    return asked > 0 && votes * 2 > asked;
  }
  function samplePoints(tris, faces) {
    var out = [], step = Math.max(1, Math.floor(faces.length / 3));
    for (var i = 0; i < faces.length && out.length < 3; i += step) {
      var T = tris[faces[i]];
      out.push([(T[0][0] + T[1][0] + T[2][0]) / 3, (T[0][1] + T[1][1] + T[2][1]) / 3, (T[0][2] + T[1][2] + T[2][2]) / 3]);
    }
    return out;
  }
  function boxOf(tris, faces) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < faces.length; i++) for (var k = 0; k < 3; k++) {
      var P = tris[faces[i]][k];
      for (var a = 0; a < 3; a++) { if (P[a] < lo[a]) lo[a] = P[a]; if (P[a] > hi[a]) hi[a] = P[a]; }
    }
    return { lo: lo, hi: hi };
  }
  function boxHolds(big, small) {
    for (var a = 0; a < 3; a++) if (small.lo[a] < big.lo[a] - BOX_PAD || small.hi[a] > big.hi[a] + BOX_PAD) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */

  function empty(reason, extra) {
    var out = { ok: false, parts: [], shells: 0, cavities: 0, tris: 0, words: '0 parts', reason: reason };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  }

  function analyse(rawTris, opts) {
    var Hm = hollowMod();
    if (!rawTris || rawTris.length < 9) return empty('Nothing to split - the piece is empty.');
    var C = Hm.cavityShells(rawTris, opts);
    if (!C) return empty('Nothing to split - the piece is empty.');
    var tris = C.P.tris, nf = tris.length;

    var csOf = new Int32Array(nf);                    // cavityShells' shell per face
    C.shells.forEach(function (list, s) { for (var i = 0; i < list.length; i++) csOf[list[i]] = s; });
    var S = surfaceShells(C);
    /* Which shells cross which (nso_shells.js, on the cut just made, so both name the same faces). */
    var K = shellsMod().shells(rawTris, { cut: S, inside: false });

    // each shell: is it a cavity wall (by cavityShells), and its box and volume. A shell another one CROSSES
    // is a part, whatever its winding says - it is two solids laid through each other, not a hollow.
    var shells = S.faces.map(function (faces, s) {
      var box = boxOf(tris, faces), crosses = K.shells[s].crosses;
      return { id: s, faces: faces, cavity: !crosses.length && !!C.info[csOf[faces[0]]].cavity, crosses: crosses,
               lo: box.lo, hi: box.hi, vol: Hm.signedVolume(rawTris, faces) };
    });
    var outers = shells.filter(function (s) { return !s.cavity; });
    var cavs = shells.filter(function (s) { return s.cavity; });

    /* A cavity goes to the SMALLEST outer that holds it: a hollow ball sitting
       in the big piece's cavity is held by the ball, not by the big piece. */
    var holds = new Map();
    outers.forEach(function (o) { holds.set(o.id, []); });
    var orphans = [];
    var bySize = outers.slice().sort(function (a, b) { return Math.abs(a.vol) - Math.abs(b.vol); });
    cavs.forEach(function (c) {
      var pts = samplePoints(tris, c.faces), home = null;
      for (var i = 0; i < bySize.length; i++) {
        var o = bySize[i];
        if (!boxHolds(o, c)) continue;
        if (insideShell(tris, o.faces, pts)) { home = o; break; }
      }
      if (!home) {                                    // read as in material, yet no outer's own skin holds it
        for (var j = 0; j < bySize.length; j++) if (boxHolds(bySize[j], c)) { home = bySize[j]; break; }
      }
      if (home) holds.get(home.id).push(c); else orphans.push(c);
    });

    var parts = outers.map(function (o) {
      var mine = holds.get(o.id), faces = o.faces.slice();
      mine.forEach(function (c) { faces = faces.concat(c.faces); });
      faces.sort(function (a, b) { return a - b; });
      return { faces: faces, shells: 1 + mine.length, cavities: mine.length, crossing: o.crosses.length > 0 };
    });
    // a cavity no outer holds is not left out of the count: it is a part of its own
    orphans.forEach(function (c) { parts.push({ faces: c.faces.slice().sort(function (a, b) { return a - b; }), shells: 1, cavities: 0 }); });
    parts.sort(function (a, b) { return a.faces[0] - b.faces[0]; });
    parts.forEach(function (p, i) { p.id = i; p.tris = p.faces.length; });

    var out = {
      ok: parts.length >= 2, parts: parts, shells: shells.length, cavities: cavs.length - orphans.length,
      tris: nf, words: words(parts.length, 'part', 'parts'), reason: '',
      crossing: parts.filter(function (p) { return p.crossing; }).length
    };
    if (!out.ok) {
      var inner = shells.length - 1;
      out.reason = 'Nothing to split - this piece is 1 part' +
        (inner > 0 ? ': it has ' + words(shells.length, 'shell', 'shells') + ', but ' +
          (inner === 1 ? 'the other is a hollow inside it, not a part' : 'the other ' + inner + ' are hollows inside it, not parts')
          : ' (one shell)') + '. Nothing changed.';
    } else {
      out.reason = 'Split into ' + parts.length + ' parts' +
        (out.crossing ? ' (' + words(out.crossing, 'shell crosses', 'shells cross') + ' another, so each is a part of its own)' : '') +
        (out.cavities ? ' (' + words(out.cavities, 'hollow', 'hollows') + ' stay with the part they are in)' : '') + '.';
    }
    return out;
  }

  function split(rawTris, opts) {
    return splitFrom(analyse(rawTris, opts), rawTris);
  }

  /* split() for an analysis already in hand (the page reads a big piece in a
     worker and keeps the read): the parts' soups, copied from `rawTris`. */
  function splitFrom(a, rawTris) {
    if (!a.ok) return a;
    a.parts.forEach(function (p) {
      var soup = new Float32Array(p.faces.length * 9);
      for (var i = 0; i < p.faces.length; i++) {
        var o = p.faces[i] * 9, at = i * 9;
        for (var c = 0; c < 9; c++) soup[at + c] = rawTris[o + c];
      }
      p.soup = soup;
    });
    return a;
  }

  /* The card's readout: what the piece is, before the button is pressed. */
  function describe(a) {
    if (!a) return '';
    if (!a.parts || !a.parts.length) return a.reason || '';
    var more = a.shells !== a.parts.length
      ? ' (' + words(a.shells, 'shell', 'shells') + (a.cavities ? ', ' + words(a.cavities, 'hollow', 'hollows') + ' kept with ' + (a.cavities === 1 ? 'its' : 'their') + ' part' + (a.cavities === 1 ? '' : 's') : '') + ')'
      : '';
    return a.words + more;
  }

  var api = { analyse: analyse, split: split, splitFrom: splitFrom, describe: describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SplitParts = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
