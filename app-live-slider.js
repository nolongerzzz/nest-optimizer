/* ============================================================
   Live slider - one number, a slider and a box that say the same thing, and a
   preview that follows the slider while it moves.

   Built for Hollow's wall (app-hollow.js). Thicken's live slider is meant to
   bind the same way: give it the slider, the box and what to draw.

     nsoLiveSlider.bind({
       slider: 'inp-hollow-slider',   // <input type=range>
       box:    'inp-hollow-mm',       // <input type=number>: the number the button uses
       read:   'hollow-slider-read',  // optional: a span that shows the value
       unit:   ' mm',                 // what the read-out appends
       onLive: function (value) {}    // draw the preview for this value
     })  ->  { value(), set(v), fire(), cancel() }

   THE BOX IS OPTIONAL. Leave `box` out and the slider is the number: value()
   reads the slider, there is no box to keep in step, and the read-out (if any)
   is the only text. The Pottery Wheel's card is built that way - a slider and
   what it says, nothing to type into.

   THE BOX IS THE NUMBER (when there is one). The button beside it reads the box, exactly as it did
   before there was a slider, so nothing about what the tool does changes: the
   slider only writes the box, and the box can be typed into past the slider's
   own range (the slider then sits at its end and the box keeps what was typed).

   onLive RUNS AT THE PACE IT CAN KEEP. A preview that costs 400 ms must not be
   asked for forty times as a slider is dragged: the next call waits for as long
   as the last one took (never under MIN_GAP_MS), and only the latest value is
   ever drawn - a trailing call, not a queue.

   data-nso-live is the repo's marker that a control is bound, set the way
   app-hollow.js sets data-nso-wired: bound once, and a second bind() on the
   same slider hands back the first one's handle.
   ============================================================ */
(function () {
  'use strict';

  var MIN_GAP_MS = 60;

  function $(id) { return document.getElementById(id); }

  /* Two decimals, or as many as the slider's own step has (an inch box steps
     by 0.005): the box must be able to say every position the slider can. */
  function trim(x, slider) {
    var st = slider ? String(slider.step || '') : '', dot = st.indexOf('.');
    var d = Math.max(2, Math.min(6, dot < 0 ? 0 : st.length - dot - 1));
    var k = Math.pow(10, d);
    return String(Math.round(x * k) / k);
  }

  var bound = {};

  function bind(o) {
    var slider = $(o.slider), box = o.box ? $(o.box) : null;
    if (!slider || (o.box && !box)) return null;
    if (bound[o.slider]) return bound[o.slider];
    var read = o.read ? $(o.read) : null;
    var unit = o.unit || '';
    var timer = 0, lastCost = 0, lastAt = 0, pending = false;

    function value() {
      var v = parseFloat(box ? box.value : slider.value);
      return isFinite(v) ? v : null;
    }
    function show() {
      var v = value();
      if (read) read.textContent = v === null ? '—' : trim(v, slider) + unit;
      if (v !== null && box) slider.value = String(v);   // the browser clamps it to the slider's own range
    }
    function run() {
      timer = 0;
      pending = false;
      var v = value();
      if (v === null || typeof o.onLive !== 'function') return;
      var t0 = Date.now();
      try { o.onLive(v); } finally { lastCost = Date.now() - t0; lastAt = Date.now(); }
    }
    function fire() {
      show();
      pending = true;
      if (timer) return;                           // a call is already waiting: it will read the latest value
      var wait = Math.max(MIN_GAP_MS, lastCost) - (Date.now() - lastAt);
      timer = setTimeout(run, wait > 0 ? wait : 0);
    }
    function cancel() {
      if (timer) { clearTimeout(timer); timer = 0; }
      pending = false;
    }
    function set(v) {
      if (box) box.value = trim(v, slider); else slider.value = String(v);
      fire();
    }

    slider.addEventListener('input', function () {
      if (box) box.value = trim(parseFloat(slider.value), slider);
      fire();
    });
    if (box) {
      box.addEventListener('input', fire);
      box.addEventListener('change', fire);
    }

    slider.dataset.nsoLive = '1';
    show();
    var handle = { value: value, set: set, fire: fire, cancel: cancel, pending: function () { return pending; } };
    bound[o.slider] = handle;
    return handle;
  }

  window.nsoLiveSlider = { bind: bind };
})();
