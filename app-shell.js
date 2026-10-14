/* Shell v2: the column's Lift, Supports and Slice settings buttons.

   Each opens G-scope exactly as the G-scope button does - the plate under
   the lens, or the file picker when the plate is empty - and then brings one
   row of G-scope's sidebar into view and marks it: Lift (#ms-lift-row),
   Supports (#ms-support-row), or the in-house slicer's row with its Slice
   settings unfolded (#ms-slice-row, #ms-slice-settings). Which row is the
   button's data-gscope-row; data-gscope-open names a <details> in it to
   unfold.

   The rows, their controls and what they do belong to app-gscope-lift.js,
   app-gscope-support.js and app-gscope-slice.js and are not touched here.
   Nothing is pressed for the user: the row is shown, not started.

   If G-scope is already open the buttons do not close it (the G-scope button
   toggles; these only ever go to their row). Opening G-scope from its own
   button clears the mark. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function clearTarget() {
    Array.prototype.forEach.call(document.querySelectorAll('#microscope .ms-row-target'),
      function (r) { r.classList.remove('ms-row-target'); });
  }

  /* Scroll the sidebar, and only the sidebar, so the row's top sits just
     under the sidebar's top. A row G-scope is not showing (no document yet)
     has no box and is left where it is. */
  function scrollTo(row) {
    var bar = $('ms-sidebar');
    if (!bar || !row) return;
    var rr = row.getBoundingClientRect();
    if (!rr.height) return;
    var br = bar.getBoundingClientRect();
    bar.scrollTop += Math.round(rr.top - br.top - 8);
  }

  function openAt(btn) {
    var MS = window.NSO_MICROSCOPE;
    var row = $(btn.dataset.gscopeRow);
    if (!MS || !row) return;
    if (!MS.isOpen()) {
      var g = $('btn-microscope');
      if (g) g.click();
    }
    clearTarget();
    row.classList.add('ms-row-target');
    var inner = btn.dataset.gscopeOpen ? $(btn.dataset.gscopeOpen) : null;
    if (inner && inner.tagName === 'DETAILS') inner.open = true;
    scrollTo(row);
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.vp-gscope-row-btn'), function (btn) {
      if (btn.dataset.shellWired === '1') return;
      btn.dataset.shellWired = '1';
      btn.addEventListener('click', function () { openAt(btn); });
    });
    var g = $('btn-microscope');
    if (g && g.dataset.shellWired !== '1') {
      g.dataset.shellWired = '1';
      g.addEventListener('click', clearTarget, true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
