/* Lift: the button in the Subtract card (shell v3; the column's own Lift
   button in shell v2).

   It opens G-scope exactly as the G-scope button does - the plate under the
   lens, or the file picker when the plate is empty - and then brings one row
   of G-scope's sidebar into view and marks it: the button's data-gscope-row
   (#ms-lift-row).

   The row, its controls and what they do belong to app-gscope-lift.js and
   are not touched here. Nothing is pressed for the user: the row is shown,
   not started.

   If G-scope is already open the button does not close it (the G-scope
   button toggles; this only ever goes to its row). Opening G-scope from its
   own button clears the mark. */
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
