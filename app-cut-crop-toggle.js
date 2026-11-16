/* Cut / Crop: one card in the column, two tools behind it.

   Cut (#menu-cut) and Crop (#menu-crop) stay two <details>, so app-cut.js's
   cutWireCards arms the right tool off whichever is open, exactly as before.
   What changed is the face: Crop's slab is hidden (styles.css), the Cut slab
   stands for both, and the Cut | Crop switch at the top of either card opens
   the other one. app-join.js's one-panel rule shuts the card being left, and
   app-cut.js hands the piece selection over from one tool to the other.

   The Cut slab, pressed while Crop is open, shuts Crop (it is the card's
   slab: a second press closes the card), rather than swapping to Cut. */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  function $(id) { return document.getElementById(id); }

  function sync() {
    var crop = $('menu-crop');
    var mode = crop && crop.open ? 'crop' : 'cut';
    Array.prototype.forEach.call(document.querySelectorAll('.cutcrop-toggle .cutcrop-opt'), function (b) {
      var on = b.getAttribute('data-cutcrop') === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function show(mode) {
    var want = $(mode === 'crop' ? 'menu-crop' : 'menu-cut');
    if (want && !want.open) want.open = true;
    sync();
  }

  function wire() {
    var cut = $('menu-cut'), crop = $('menu-crop');
    if (!cut || !crop || cut.dataset.nsoCutCrop === '1') return;
    cut.dataset.nsoCutCrop = '1';
    Array.prototype.forEach.call(document.querySelectorAll('.cutcrop-toggle .cutcrop-opt'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        show(b.getAttribute('data-cutcrop'));
      });
    });
    var slab = cut.querySelector(':scope > summary');
    if (slab) slab.addEventListener('click', function (ev) {
      if (!crop.open) return;
      ev.preventDefault();
      crop.open = false;
    });
    if (typeof MutationObserver === 'function') {
      new MutationObserver(sync).observe(crop, { attributes: true, attributeFilter: ['open'] });
      new MutationObserver(sync).observe(cut, { attributes: true, attributeFilter: ['open'] });
    }
    sync();
  }

  window.NSO_CutCrop = { show: show, sync: sync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
