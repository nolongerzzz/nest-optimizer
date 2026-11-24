/*
 * NSO colour paint - Bambu Studio's (and PrusaSlicer's) painted filament colours
 * ------------------------------------------------------------------------------
 * A Studio project painted with the colour brush stores, on each painted triangle, a
 * `paint_color` attribute (PrusaSlicer: `slic3rpe:mmu_segmentation`): a hex string that
 * encodes how the triangle was split, recursively, and the filament each leaf has.
 * docs/MULTICOLOR.md has the format and how it was checked.
 *
 *   The string is read from its LAST character to its first, one hex digit (nibble)
 *   at a time. A nibble's low two bits are the number of the triangle's sides that
 *   were split (0: a leaf). A leaf's high two bits are its state; 3 means "3 or more":
 *   the next nibble is added to 3 (so up to 18). A split triangle's high two bits are its special
 *   side, and its children follow, the last child first.
 *   A state is a filament: 0 the triangle's own (its part's or object's extruder),
 *   1 the first filament, 2 the second...
 *
 * Checked on the owner's 3-colour pyramid (2026-11-22): its leaves give bands with
 * edges at 8.438, 15.293 and 21.445 mm, and Studio changed filament at the first layer
 * whose mid-height is past each (8.6, 15.4, 21.6).
 *
 * Headless (Node and the page). window.NSO_Paint.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_Paint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }

  /**
   * The leaves of one painted triangle. a, b, c: its corners [x,y,z] in the file's order. emit(p, q, r, state) for
   * each leaf. Returns the number of leaves, or -1 for a code that does not read (a leaf of state 0 is then emitted).
   */
  function decode(code, a, b, c, emit) {
    var n = code ? code.length : 0, pos = n - 1, leaves = 0, bad = false;
    function nib() {
      if (pos < 0) { bad = true; return 0; }
      var v = parseInt(code.charAt(pos--), 16);
      if (!(v >= 0)) { bad = true; return 0; }
      return v;
    }
    function rec(p, q, r, depth) {
      if (bad) return;
      if (depth > 24) { bad = true; return; }
      var k = nib(), split = k & 3;
      if (bad) return;
      if (!split) {
        var st = k >> 2;
        if (st === 3) st = 3 + nib();          /* 3 or more: the next nibble adds on (states up to 18) */
        if (bad) return;
        leaves++;
        emit(p, q, r, st);
        return;
      }
      var sp = k >> 2, v = [p, q, r], v0 = v[sp % 3], v1 = v[(sp + 1) % 3], v2 = v[(sp + 2) % 3], ch;
      if (split === 1) {
        var m = mid(v1, v2);
        ch = [[v0, v1, m], [m, v2, v0]];
      } else if (split === 2) {
        var m1 = mid(v0, v1), m2 = mid(v0, v2);
        ch = [[v0, m1, m2], [m1, v1, v2], [v2, m2, m1]];
      } else {
        var n1 = mid(v0, v1), n2 = mid(v1, v2), n3 = mid(v2, v0);
        ch = [[v0, n1, n3], [n1, v1, n2], [n2, v2, n3], [n1, n2, n3]];
      }
      for (var i = ch.length - 1; i >= 0; i--) rec(ch[i][0], ch[i][1], ch[i][2], depth + 1);
    }
    if (!n) { emit(a, b, c, 0); return 1; }
    rec(a, b, c, 0);
    if (bad) { emit(a, b, c, 0); return -1; }
    return leaves;
  }

  /**
   * A piece's paint, from the reader's per-triangle codes: { codes, flip, ext, colours } - or null when no triangle
   * is painted and no part has its own filament. codes[i]: triangle i's code or null; flip[i]: 1 when the reader
   * swapped its last two corners (a mirroring transform), so the file's order is (0, 2, 1); ext[i]: the filament of
   * its state 0 (1-based); colours: the project's filament colours, '#RRGGBB', first filament first.
   */
  function make(codes, flip, ext, colours) {
    var any = false, i;
    for (i = 0; i < codes.length && !any; i++) if (codes[i]) any = true;
    if (!any && ext) for (i = 0; i < ext.length && !any; i++) if (ext[i] > 1) any = true;
    if (!any) return null;
    return { codes: codes, flip: flip || null, ext: ext || null, colours: (colours || []).slice(), triangles: codes.length };
  }

  /** Does `paint` still belong to a soup of this many floats (one code per triangle)? */
  function fits(paint, soupLength) { return !!(paint && paint.triangles * 9 === soupLength); }

  /** Triangle i of a soup, in the file's corner order. */
  function corners(P, i, flipped) {
    var o = i * 9, a = [P[o], P[o + 1], P[o + 2]], b = [P[o + 3], P[o + 4], P[o + 5]], c = [P[o + 6], P[o + 7], P[o + 8]];
    return flipped ? [a, c, b] : [a, b, c];
  }

  /**
   * Every leaf of a painted soup, its filament resolved: emit(p, q, r, filament) with filament 1-based. P: the soup
   * (any frame the paint's soup was rigidly or affinely moved into, the triangles in the same order).
   */
  function eachLeaf(P, paint, emit) {
    var n = paint.triangles;
    for (var i = 0; i < n; i++) {
      var own = paint.ext ? (paint.ext[i] || 1) : 1, k = corners(P, i, paint.flip && paint.flip[i]);
      decode(paint.codes[i], k[0], k[1], k[2], function (p, q, r, st) { emit(p, q, r, st > 0 ? st : own); });
    }
  }

  /** The filaments a paint uses, ascending (1-based). */
  function filaments(paint) {
    var seen = {};
    var dummy = [0, 0, 0];
    for (var i = 0; i < paint.triangles; i++) {
      var own = paint.ext ? (paint.ext[i] || 1) : 1;
      if (!paint.codes[i]) { seen[own] = 1; continue; }
      decode(paint.codes[i], dummy, dummy, dummy, function (p, q, r, st) { seen[st > 0 ? st : own] = 1; });
    }
    return Object.keys(seen).map(Number).sort(function (x, y) { return x - y; });
  }

  var FALLBACK = ['#f2f2f2', '#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#f97316', '#14b8a6'];
  function rgb(hex) {
    var m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  /** Filament f's colour (1-based) as [r,g,b] 0..1: the project's, else a fallback by number. */
  function colourOf(paint, f) {
    return rgb(paint.colours[f - 1]) || rgb(FALLBACK[(f - 1) % FALLBACK.length]);
  }

  /**
   * The painted surface to draw over a piece: { positions, colors } (Float32Arrays, a soup and one RGB per vertex), in
   * the frame of P (the piece's displayed soup). Every triangle is drawn, the unpainted ones in their own filament's
   * colour, so the piece shows as it will print.
   */
  function overlay(P, paint) {
    var pos = [], col = [];
    eachLeaf(P, paint, function (p, q, r, f) {
      var c = colourOf(paint, f);
      pos.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
      col.push(c[0], c[1], c[2], c[0], c[1], c[2], c[0], c[1], c[2]);
    });
    return { positions: new Float32Array(pos), colors: new Float32Array(col) };
  }

  /** A copy (for a cloned piece). */
  function clone(paint) {
    if (!paint) return null;
    return { codes: paint.codes.slice(), flip: paint.flip ? new Uint8Array(paint.flip) : null, ext: paint.ext ? new Uint8Array(paint.ext) : null,
             colours: paint.colours.slice(), triangles: paint.triangles };
  }

  return { decode: decode, make: make, fits: fits, eachLeaf: eachLeaf, filaments: filaments, overlay: overlay, colourOf: colourOf, clone: clone };
});
