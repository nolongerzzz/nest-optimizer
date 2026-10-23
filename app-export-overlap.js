/*
 * Export check: pieces that overlap in plate space.
 * The app side of NSO_Shells.overlaps (nso_shells.js). After app-core.js's
 * helpers, before they are called (classic scripts, resolved at export time).
 * docs/SHELLS-AS-PIECES.md.
 * ----------------------------------------------------------------------------
 *
 * Two pieces on the plate whose shells pass through each other - the halves of a
 * box Split to parts left laid through one another, a handle shell through a
 * body - print as two solids filling the same space. Export does not refuse
 * that (the file is written, as it always was); it says so in one line, with the
 * pieces named:
 *
 *     Downloaded nest_X_2pcs.stl - these pieces overlap; Join before printing: A + B
 *
 * The check reads the geometry the file is made from: the combined geometry the
 * STL is written from (cut into its pieces by their triangle counts), or the
 * 3MF's own objects. A plate with no overlap says nothing, and its status line is
 * exactly what it was.
 */
/* global state, nsoHelpers */
'use strict';

(function () {
  function SH() { return window.NSO_Shells; }

  /** The exportable pieces' soups from the STL's combined geometry, in plate order. */
  function fromCombined(geo) {
    var pieces = nsoHelpers.exportable(state.placed), arr = geo.attributes.position.array, at = 0, out = [];
    pieces.forEach(function (p) {
      var n = p.geometry.attributes.position.count * 3;
      out.push({ name: p.name || 'piece', soup: arr.subarray(at, at + n) });
      at += n;
    });
    return out;
  }

  /** The 3MF objects' soups: indexed vertices and triangles back to nine numbers a triangle. */
  function fromObjects(objects) {
    return objects.map(function (o) {
      var t = o.triangles, v = o.vertices, soup = new Float32Array(t.length * 3);
      for (var i = 0; i < t.length; i++) { soup[i * 3] = v[t[i] * 3]; soup[i * 3 + 1] = v[t[i] * 3 + 1]; soup[i * 3 + 2] = v[t[i] * 3 + 2]; }
      return { name: o.name, soup: soup };
    });
  }

  /**
   * The export check's line for what is about to be written: '' when no two pieces overlap, else
   * ' - these pieces overlap; Join before printing: A + B'. src: { combined: geometry } or { objects }.
   */
  window.nsoExportOverlapNote = function (src) {
    window.nsoExportOverlapLast = null;
    try {
      if (!SH() || typeof SH().overlaps !== 'function' || !src) return '';
      var items = src.combined ? fromCombined(src.combined) : src.objects ? fromObjects(src.objects) : [];
      if (items.length < 2) return '';
      var r = SH().overlaps(items);
      if (!r.pairs.length) return '';
      window.nsoExportOverlapLast = { line: r.line, names: r.names };
      return ' - ' + r.line;
    } catch (err) {
      console.error('[export-overlap]', err);
      return '';
    }
  };
})();
