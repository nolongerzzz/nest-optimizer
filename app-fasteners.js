/* app-fasteners.js - the Fasteners card (Gen+ > Fasteners): a threaded Rod, a Bolt (hex or socket head), a Nut and a
   Bolt + nut set. Each puts a NEW piece on the plate, selected, beside whatever was selected - it edits nothing.
   The geometry is nso_thread.js (headless, tools/nso_thread_test.js); what is here is what only the app can do:
   read the fields, resolve the blanks, drop the piece (the drop Fittings uses, nsoFittings.addPiece: one Undo each).
   docs/THREADS.md.

   Size is a table thread (metric coarse / fine, G); Ø and Pitch override it for any other. A nut's bore is the
   bolt's thread + Fit, so a bolt and a nut made here turn on each other, and a hole made with Punch > Thread takes
   the same bolt. A refusal says why, in words, and adds nothing.

   PAINT SCOPE: NONE. A fastener reads no face of anything and writes to no face. See docs/HANDOFF.md, "Scoping". */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function num(id) { var el = $(id); return el && el.value !== '' && isFinite(+el.value) ? +el.value : null; }
  function readout(text, bad) {
    var el = $('fs-readout');
    if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  }
  function val(id) { var el = $(id); return el ? el.value : ''; }

  function common() {
    return { size: val('sel-fs-size') || 'M8', hand: val('sel-fs-hand') === 'left' ? 'left' : 'right', major: num('inp-fs-major'), pitch: num('inp-fs-pitch') };
  }
  function drop(label, r) {
    if (!r.ok) { say(label + ' refused - nothing added: ' + r.reason, true); readout(label + ': ' + r.reason, true); return r; }
    readout(r.reason);
    var add = window.nsoFittings && window.nsoFittings.addPiece;
    if (typeof add !== 'function') { say('Fasteners needs the Fittings card (app-fittings.js)', true); return { ok: false, reason: 'no addPiece' }; }
    var put = add(r.info.kind === 'rod' ? 'rod ' + r.info.size : r.info.kind === 'nut' ? 'nut ' + r.info.size : 'bolt ' + r.info.size, r.soup, r.reason);
    r.modelId = put.modelId; r.name = put.name; r.placedIndex = put.placedIndex; r.added = put.ok;
    return r;
  }
  function need() {
    if (typeof NSO_Thread === 'undefined') { say('Fasteners needs nso_thread.js', true); return false; }
    return true;
  }

  function makeRod() {
    if (!need()) return { ok: false, reason: 'NSO_Thread not loaded' };
    var o = common(); o.length = num('inp-fs-length') != null ? num('inp-fs-length') : 40;
    var r; try { r = NSO_Thread.rod(o); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    return drop('Rod', r);
  }
  function makeBolt() {
    if (!need()) return { ok: false, reason: 'NSO_Thread not loaded' };
    var o = common(); o.length = num('inp-fs-length') != null ? num('inp-fs-length') : 25; o.head = val('sel-fs-head');
    var r; try { r = NSO_Thread.bolt(o); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    return drop('Bolt', r);
  }
  function makeNut() {
    if (!need()) return { ok: false, reason: 'NSO_Thread not loaded' };
    var o = common(); o.fit = num('inp-fs-fit'); o.thickness = num('inp-fs-nutm');
    var r; try { r = NSO_Thread.nut(o); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    return drop('Nut', r);
  }
  /* Both or neither: the pieces are built first, so a refusal on either adds nothing. */
  function makeSet() {
    if (!need()) return { ok: false, reason: 'NSO_Thread not loaded' };
    var o = common(), b = Object.assign({}, o), n = Object.assign({}, o);
    b.length = num('inp-fs-length') != null ? num('inp-fs-length') : 25; b.head = val('sel-fs-head');
    n.fit = num('inp-fs-fit'); n.thickness = num('inp-fs-nutm');
    var rb, rn;
    try { rb = NSO_Thread.bolt(b); rn = NSO_Thread.nut(n); } catch (e) { rb = { ok: false, reason: (e && e.message) || String(e) }; }
    if (!rb.ok) return drop('Bolt + nut', rb);
    if (!rn || !rn.ok) return drop('Bolt + nut', rn || { ok: false, reason: 'the nut would not build' });
    var a = drop('Bolt', rb), c = drop('Nut', rn);
    readout(rb.reason + ' - and ' + rn.reason);
    return { ok: !!(a.ok && c.ok), bolt: a, nut: c, reason: rb.reason + ' / ' + rn.reason };
  }

  function wire() {
    [['btn-fs-rod', makeRod], ['btn-fs-bolt', makeBolt], ['btn-fs-nut', makeNut], ['btn-fs-set', makeSet]].forEach(function (q) {
      var b = $(q[0]);
      if (!b || b.dataset.nsoWired === '1') return;
      b.dataset.nsoWired = '1';
      b.addEventListener('click', function () {
        try { q[1](); } catch (err) {
          if (typeof console !== 'undefined') console.error('[fasteners]', err);
          say('Fasteners failed - nothing added (' + ((err && err.message) || err) + ')', true);
        }
      });
    });
    // blank fields say what they will do: the nut's defaults are the placeholders
    if (typeof NSO_Thread !== 'undefined') { var f = $('inp-fs-fit'); if (f) f.placeholder = String(NSO_Thread.DEFAULTS.fit); }
  }

  window.nsoFasteners = { rod: makeRod, bolt: makeBolt, nut: makeNut, set: makeSet };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
