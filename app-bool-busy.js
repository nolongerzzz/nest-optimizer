/* app-bool-busy.js - what the page shows while a boolean runs in the worker.

   nso_csg.js NSO_boolRun calls NSO_BoolBusy.begin(label, hostId) when it hands a big boolean to the
   worker and .end() when the answer (or a refusal) is back. Between the two:

     - the #226 bar - the one the Supports card draws while it builds - under the readout of the card
       that asked (hostId: 'crop-readout', 'connect-readout', 'bridge-readout'), or, for a boolean with
       no card of its own (Join, Subtract), over the status line at the bottom right. It sweeps: the
       kernel reports no progress and none is invented, so there is no percent;
     - the words "Cropping… 12 s" - the label and the seconds the job has run - in that readout and in
       the status line;
     - Escape, which stops it (NSO_boolCancelAll): the worker is ended and the next job starts a fresh one.
       Escape is taken here, in the capture phase, so the card's own Escape (put the shape away) does not
       also fire: the shape stays, ready to try again. The plate is as it was.

   The bar is made when the first job begins and removed when the last one ends. */
(function () {
  'use strict';

  var S = { jobs: [], timer: null, bar: null, said: null, log: [] };

  function $(id) { return document.getElementById(id); }

  function secondsOf(j) { return Math.floor((Date.now() - j.t0) / 1000); }
  function lineOf(j) {
    var s = secondsOf(j);
    return j.label + '…' + (s >= 1 ? ' ' + s + ' s' : '');
  }
  function top() { return S.jobs.length ? S.jobs[S.jobs.length - 1] : null; }

  function say(msg) {
    if (typeof setStatus === 'function') setStatus(msg, false);
  }

  function shown(el) { return !!(el && el.getClientRects && el.getClientRects().length); }

  function makeBar() {
    var bar = document.createElement('div');
    bar.id = 'bool-progress';
    bar.className = 'bool-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Working');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.title = 'Escape stops it; nothing is changed';
    var fill = document.createElement('div');
    fill.className = 'bool-progress-fill';
    bar.appendChild(fill);
    return bar;
  }

  /* Under the asking card's readout if that is on screen, else over the status line. */
  function place(bar, host) {
    var anchor = host && shown(host) ? host : null;
    bar.classList.toggle('is-floating', !anchor);
    if (anchor) {
      if (bar.previousElementSibling !== anchor) anchor.insertAdjacentElement('afterend', bar);
      return;
    }
    var hud = document.querySelector('.viewport-overlay-br');
    var st = $('status');
    if (hud && st) { if (bar.nextElementSibling !== st || bar.parentNode !== hud) hud.insertBefore(bar, st); }
    else if (!bar.parentNode) document.body.appendChild(bar);
  }

  function paint() {
    var j = top();
    if (!j) return;
    var line = lineOf(j);
    var host = j.host ? $(j.host) : null;
    if (!S.bar) S.bar = makeBar();
    place(S.bar, host);
    S.bar.setAttribute('aria-valuetext', line);
    S.bar.dataset.label = j.label;
    if (host && host.textContent !== line) host.textContent = line;
    if (S.said !== line) { S.said = line; say(line); }
  }

  function unsay() {
    var el = $('status');
    if (S.said != null && el && el.textContent === S.said) say('');
    S.said = null;
  }

  function begin(label, hostId) {
    var j = { label: label, host: hostId || null, t0: Date.now() };
    S.jobs.push(j);
    S.log.push({ at: Date.now(), event: 'begin', label: label });
    if (!S.timer) S.timer = setInterval(paint, 1000);
    paint();
    return {
      end: function () {
        var i = S.jobs.indexOf(j);
        if (i < 0) return;
        S.jobs.splice(i, 1);
        S.log.push({ at: Date.now(), event: 'end', label: label, seconds: secondsOf(j) });
        if (!S.jobs.length) {
          clearInterval(S.timer); S.timer = null;
          if (S.bar && S.bar.parentNode) S.bar.parentNode.removeChild(S.bar);
          S.bar = null;
          unsay();
        } else paint();
      }
    };
  }

  /* The line a card should show as its readout while its boolean runs, or '' if none is. */
  function line(hostId) {
    for (var i = S.jobs.length - 1; i >= 0; i--) if (S.jobs[i].host === hostId) return lineOf(S.jobs[i]);
    return '';
  }

  function onKey(ev) {
    if (ev.key !== 'Escape' || !S.jobs.length) return;
    if (typeof NSO_boolCancelAll !== 'function') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    NSO_boolCancelAll();
  }

  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

  window.NSO_BoolBusy = {
    begin: begin,
    line: line,
    active: function () { return S.jobs.length; },
    /* For the checks: what is on screen now. */
    state: function () {
      var j = top();
      return j ? { label: j.label, host: j.host, seconds: secondsOf(j), line: lineOf(j),
                   bar: !!(S.bar && S.bar.parentNode), barIn: S.bar && S.bar.parentNode ? S.bar.parentNode.id || S.bar.parentNode.className : '' }
               : null;
    },
    log: function () { return S.log.slice(); }
  };
})();
