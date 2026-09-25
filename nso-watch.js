/* Live watch - two independent watchers behind one toggle button.

   Off by default and completely inert until it is switched on: nothing is
   patched, no listener is installed, no timer runs. Switching it off puts
   every patched global back the way it was found. It never writes to the
   status line or the HUD, never repairs anything it finds, and never calls a
   bake, a repaint or an undo of its own - a watcher that fixes the state
   destroys the evidence it exists to capture.

   1. LOG      - console errors and warnings, uncaught errors and rejections,
                 failed fetch / XHR, and every setStatus line the app writes,
                 with the refusals and stand-downs marked. Timestamped.

   2. CONSIST  - after every Undo, bake and tool switch, the RENDERED scene is
                 compared against the app's own LOGICAL state:
                   state.placed / state.models   (what the app believes)
                   state.modelGroup.children     (what is on screen)
                   faceMask.exclude              (which faces are excluded)
                 A mismatch is reported immediately as a "phantom <subject>"
                 event carrying the timestamp and the operation that preceded
                 it. Subjects: object, wall, paint, pose, footprint.

   3. SELECT / OP - what the operations were done TO, and what kind of
                 operation each one was:
                   select   every change of state.selectedIndex / state.editId,
                            however it was made (selectPlaced, a click, one of
                            the many direct assignments), coalesced to one line
                            per change and always logged BEFORE the operation
                            that follows it in the same tick.
                   op       preview / discard / commit / undo. A commit is a
                            pushUndo - the app's own record that it changed
                            something. A preview is shown but not kept (the
                            cutter's edit preview, the plate preview, a brush
                            stroke still under the pointer); a discard is a
                            preview dropped without a commit. Every op line
                            carries the selection it acted on, and every
                            status line written in the same tick carries its
                            phase, so "Carve - drag..." and "Carve done" no
                            longer read alike.
                 Build-volume warnings arrive as status lines (app-fit.js
                 routes them through setStatus) and are marked as such.

   4. REPORT   - every event is also kept in this browser (localStorage,
                 "nso.watch.store"), across reloads, one run per start(). The
                 Report button opens an in-app view of the whole history -
                 filter by run, by kind, by text - instead of downloading a
                 file. There is no backend and this does not need one.

   Why this exists: two mismatches of exactly this shape have been found by
   accident (a pose lost across a bake, paint left on screen after an undo).
   Both are invisible until an unrelated test happens to trip over them,
   because in both cases the app's logical state stays correct and only the
   picture diverges. This catches the next one at the moment it happens.

   WHAT COUNTS AS A MISMATCH is not re-derived here. Every invariant is read
   back off the app's own definitions:
     - pose:      applyMeshRotation() in app-core.js is the one mapping from a
                  placed entry's logical pose to its mesh transform.
     - bed:       settlePlacedOnBed() in app-core.js seats a piece 0.2 mm up.
     - footprint: meshLocalBox3(), the same box applyMeshRotation() measures
                  width / depth / height from.
     - paint:     nsoMaskCount() and nsoMaskRepaint()'s own return value.
                  The skip list is read, never re-derived - docs/HANDOFF.md.

   The CSS is injected from here rather than added to styles.css because
   styles.css is served with a ?v= tag this file is not allowed to bump, so a
   rule added there would not reach a browser holding the cached copy. This
   file is a new URL and has no stale copy anywhere. The whole feature is this
   file plus one button and one script tag in index.html; deleting those three
   things removes it without a trace. */
(function (global) {
  'use strict';

  var VERSION = 'watch2';
  var MAX_EVENTS = 4000;
  /* An operation is checked more than once: a bake is synchronous, but Join
     and Subtract resolve a promise, and a few paths finish inside a rAF. The
     same finding is only ever reported once, so the extra passes cost nothing
     but catch the late ones. */
  var CHECK_DELAYS = [0, 150, 700, 2000];
  var IDLE_MS = 4000;          // sweep, for anything not driven by a click
  var OP_HISTORY = 6;
  var STORE_KEY = 'nso.watch.store';
  var MAX_STORED = 6000;       // events kept across runs; oldest go first
  var SAVE_MS = 250;           // persistence is batched, and flushed on pagehide / stop
  var REPORT_ROWS = 1500;      // rows the report view draws at once

  /* tolerances */
  var TOL_MM = 0.05;           // mm - positions, sizes
  var TOL_BED = 0.35;          // mm - covers the 0.2 and 0.3 seat conventions
  var TOL_RAD = 1e-3;          // rad - ~0.06 degrees
  var PAINT_RENDER_ORDER = 40; // app-mask.js
  var PAINT_COLOR = 0xffdd00;  // app-mask.js

  /* A refusal is the app declining to do what was asked, which is a
     first-class signal here and not an error: every wired bake can stand
     down (docs/HANDOFF.md, "paint wins"), and a stand-down that nobody
     noticed reads exactly like a bake that silently did nothing. "unchanged"
     is deliberately NOT in this list - "Cutter closed - pieces unchanged" is
     a plain status line, and every real refusal that says it also says
     failed. */
  var REFUSAL = /(refus|stand[ -]?down|stood down|blocked|gated|cannot|can't|won't|unable|failed|not allowed|nothing to|no piece|select a (?:piece|model)|load an stl|too (?:many|few|large|small|thin))/i;

  /* ---------------- module state ---------------- */
  var on = false;
  var events = [];
  var dropped = 0;
  var seqN = 0;
  var startedWall = 0;
  var openF = null;            // fingerprint -> the event that opened it
  var ops = [];                // recent operation labels, newest last
  var paintStamp = null;       // what the last nsoMaskRepaint() drew, and from what
  var ovSeen = null;           // paint overlay uuid -> the state it was drawn from
  var restores = [];           // teardown thunks, run in reverse on stop()
  var timers = [];
  var idleTimer = 0;
  var busy = false;            // re-entrancy guard for the console patches
  var raw = {};                // untouched console methods, for our own output

  var el = {};                 // panel elements

  var selCur = null;           // the selection as last logged
  var selPending = false;      // a setter fired; the line is written at the end of the tick
  var task = null;             // {phase, events} for the current synchronous tick
  var store = null;            // the persisted history: {v, runs, events, dropped}
  var runId = null;            // this start()'s entry in store.runs
  var saveTimer = 0;
  var reportTimer = 0;

  /* ---------------- small helpers ---------------- */
  function stateRef() {
    try { return (typeof state !== 'undefined' && state) ? state : null; }
    catch (e) { return null; }
  }
  function activeModel() {
    try { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
    catch (e) { return null; }
  }
  function clock(d) {
    var t = d || new Date();
    function p(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
    return p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds()) + '.' + p(t.getMilliseconds(), 3);
  }
  function mm(v) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(2) : String(v); }
  function deg(r) { return (typeof r === 'number' && isFinite(r)) ? (r * 180 / Math.PI).toFixed(1) : String(r); }
  function shorten(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function triCount(geo) {
    if (!geo) return 0;
    if (geo.index) return (geo.index.count / 3) | 0;
    var p = geo.attributes && geo.attributes.position;
    return p ? (p.count / 3) | 0 : 0;
  }
  /* smallest signed difference between two angles */
  function angOff(a, b) {
    var d = (a || 0) - (b || 0);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  }
  function worldBox(mesh) {
    if (typeof meshLocalBox3 === 'function') {
      try { return meshLocalBox3(mesh); } catch (e) { /* fall through */ }
    }
    if (!mesh || !mesh.geometry || typeof THREE === 'undefined') return null;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    mesh.updateMatrixWorld(true);
    return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
  }
  function boxSize(b) {
    if (!b || !isFinite(b.min.x)) return null;
    return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
  }
  function isPaintOverlay(o) {
    return !!(o && o.isMesh && o.renderOrder === PAINT_RENDER_ORDER &&
              o.material && o.material.color &&
              typeof o.material.color.getHex === 'function' &&
              o.material.color.getHex() === PAINT_COLOR);
  }

  /* ---------------- the log ---------------- */
  function opLabel() { return ops.length ? ops[ops.length - 1] : '(nothing yet)'; }

  function push(ev) {
    /* A selection change made earlier in this tick is written first, so the
       log always reads "selected X" before "commit Y" and never the other
       way round. */
    if (ev.kind !== 'select') flushSelection();
    ev.seq = ++seqN;
    ev.at = new Date();
    ev.time = clock(ev.at);
    ev.op = ev.op || opLabel();
    events.push(ev);
    if (events.length > MAX_EVENTS) { events.shift(); dropped++; }
    persist(ev);
    row(ev);
    counts();
    echo(ev);
    if (el.report && el.report.classList.contains('is-on')) reportSoon();
    return ev;
  }
  /* ---------------- the persisted history ---------------- */
  function emptyStore() { return { v: 1, runs: [], events: [], dropped: 0 }; }
  function loadStore() {
    try {
      var saved = global.localStorage.getItem(STORE_KEY);
      var st = saved ? JSON.parse(saved) : null;
      if (st && st.v === 1 && Array.isArray(st.runs) && Array.isArray(st.events)) {
        st.dropped = st.dropped || 0;
        return st;
      }
    } catch (e) { /* unreadable or blocked: start a fresh history */ }
    return emptyStore();
  }
  function currentRun() {
    if (!store || !runId) return null;
    for (var i = store.runs.length - 1; i >= 0; i--) if (store.runs[i].id === runId) return store.runs[i];
    return null;
  }
  function persist(ev) {
    if (!store || !runId) return;
    var r = {
      run: runId, seq: ev.seq, iso: ev.at.toISOString(), time: ev.time, kind: ev.kind,
      level: ev.level, phase: ev.phase || null, source: ev.source || null, msg: ev.msg,
      op: ev.op, sel: ev.sel || null, detail: ev.detail || null, trail: ev.trail || null
    };
    ev._rec = r;
    store.events.push(r);
    if (store.events.length > MAX_STORED) {
      var n = store.events.length - MAX_STORED;
      store.events.splice(0, n);
      store.dropped += n;
    }
    var run = currentRun();
    if (run) { run.events = (run.events || 0) + 1; run.last = r.iso; }
    saveSoon();
  }
  function saveSoon() {
    if (saveTimer || !store) return;
    saveTimer = global.setTimeout(flushStore, SAVE_MS);
  }
  /* A full quota is met by dropping the oldest half and trying again - the
     newest events are the ones a person is about to look for. */
  function flushStore() {
    if (saveTimer) { global.clearTimeout(saveTimer); saveTimer = 0; }
    if (!store) return false;
    for (var tries = 0; tries < 5; tries++) {
      try { global.localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
      catch (e) {
        if (!store.events.length) return false;
        var n = Math.ceil(store.events.length / 2);
        store.events.splice(0, n);
        store.dropped += n;
      }
    }
    return false;
  }

  function log(kind, level, msg, detail) {
    return push({ kind: kind, level: level || 'info', msg: msg, detail: detail || null });
  }
  function echo(ev) {
    var line = '[' + VERSION + ' ' + ev.time + '] ' + ev.kind +
               (ev.level && ev.level !== 'info' ? '/' + ev.level : '') + ': ' + ev.msg;
    var fn = (ev.level === 'error' || ev.kind === 'phantom') ? raw.error
           : (ev.level === 'warn' || ev.level === 'refusal') ? raw.warn : raw.log;
    busy = true;
    try {
      if (ev.kind === 'phantom') fn.call(console, line + '  [after ' + ev.op + ']');
      else fn.call(console, line);
    } catch (e) { /* never let logging throw into the app */ }
    busy = false;
  }

  function nextTick(fn) {
    if (typeof global.queueMicrotask === 'function') global.queueMicrotask(fn);
    else Promise.resolve().then(fn);
  }

  /* ---------------- selection ---------------- */
  function selSnap() {
    var S = stateRef();
    var out = { index: -1, piece: null, sourceId: null, editId: null, model: null };
    if (!S) return out;
    out.index = (typeof S.selectedIndex === 'number') ? S.selectedIndex : -1;
    var p = (out.index >= 0 && S.placed) ? S.placed[out.index] : null;
    if (p) { out.piece = p.name || null; out.sourceId = (p.sourceId != null) ? p.sourceId : null; }
    out.editId = (S.editId != null) ? S.editId : null;
    var models = S.models || [];
    for (var i = 0; i < models.length; i++) {
      if (models[i] && models[i].id === out.editId) { out.model = models[i].name || null; break; }
    }
    return out;
  }
  function selKey(s) { return s ? [s.index, s.sourceId, s.editId].join('|') : ''; }
  function selText(s) {
    if (!s) return '?';
    var parts = [];
    if (s.index >= 0) {
      parts.push('placed[' + s.index + ']' + (s.piece ? ' "' + s.piece + '"' : '') +
                 (s.sourceId != null ? ' (model #' + s.sourceId + ')' : (s.piece ? '' : ' - an empty index')));
    } else parts.push('no piece');
    if (s.editId != null && (s.index < 0 || s.editId !== s.sourceId)) {
      parts.push('active model #' + s.editId + (s.model ? ' "' + s.model + '"' : ' (not in the registry)'));
    }
    return parts.join(', ');
  }
  function flushSelection() {
    if (!on) return;
    var wasSetter = selPending;
    selPending = false;
    var now = selSnap();
    if (selKey(now) === selKey(selCur)) return;
    var from = selCur;
    selCur = now;
    var cleared = now.index < 0 && now.editId == null;
    /* "selected" when the app assigned the selection; "selection now" when
       it moved without an assignment - the plate changed under the same
       index, which is still a change in what the next operation acts on. */
    push({ kind: 'select', level: 'info',
           msg: (cleared ? 'selection cleared' : ((wasSetter ? 'selected ' : 'selection now ') + selText(now))) +
                ' (was ' + selText(from) + ')',
           detail: { from: from, to: now, cause: wasSetter ? 'assigned' : 'plate changed' },
           sel: now });
  }
  function noteSelection() {
    if (selPending || !on) return;
    selPending = true;
    nextTick(function () { if (selPending) flushSelection(); });
  }
  /* state.selectedIndex and state.editId are assigned directly in dozens of
     places, not only through selectPlaced(), so the change is caught on the
     property itself: an accessor with the same value behind it, put back to a
     plain data property on stop(). The setter only notes that something
     changed; the line is written once, at the end of the tick. */
  function installSelection() {
    var S = stateRef();
    if (!S) return;
    ['selectedIndex', 'editId'].forEach(function (key) {
      var d = Object.getOwnPropertyDescriptor(S, key);
      if (!d || !d.configurable || !('value' in d)) return;
      var val = d.value;
      var acc = {
        configurable: true, enumerable: d.enumerable,
        get: function () { return val; },
        set: function (v) { var ch = v !== val; val = v; if (ch) noteSelection(); }
      };
      Object.defineProperty(S, key, acc);
      restores.push(function () {
        var now = Object.getOwnPropertyDescriptor(S, key);
        if (!now || now.get !== acc.get) return;
        Object.defineProperty(S, key, { value: val, writable: true, enumerable: d.enumerable, configurable: true });
      });
    });
  }

  /* ---------------- operations: preview / discard / commit / undo ---------------- */
  var PHASE_RANK = { preview: 1, discard: 2, undo: 3, commit: 3 };
  function tick() {
    if (!task) {
      task = { phase: null, events: [] };
      nextTick(function () { task = null; });
    }
    return task;
  }
  /* The status lines written in the same tick as an operation belong to it:
     the brush's "drag to work the surface" is a preview's line, its "Carve
     done" a commit's. A commit can land after its own status line (setStatus
     first, pushUndo second), so the tag is applied backwards too. */
  function opEvent(phase, name, detail) {
    if (!on) return null;
    var t = tick();
    if ((PHASE_RANK[phase] || 0) >= (PHASE_RANK[t.phase] || 0)) {
      t.phase = phase;
      t.events.forEach(function (e) {
        if ((PHASE_RANK[e.phase] || 0) <= PHASE_RANK[phase]) retag(e, phase);
      });
    }
    flushSelection();
    return push({ kind: 'op', level: 'info', phase: phase, msg: phase + ' ' + name,
                  detail: detail || null, sel: selCur });
  }
  function retag(ev, phase) {
    ev.phase = phase;
    if (ev._rec) { ev._rec.phase = phase; saveSoon(); }
    if (ev._row) paintPhase(ev._row, phase);
  }
  function installOps() {
    /* The two previews that are plain globals. Wrapped by name, as setStatus is. */
    wrapGlobal('showEditPreview', function (orig) {
      return function () {
        var m = activeModel();
        var r = orig.apply(this, arguments);
        try { opEvent('preview', 'cutter edit preview' + (m ? ' of "' + m.name + '"' : '')); } catch (e) {}
        return r;
      };
    });
    wrapGlobal('previewModelOnPlate', function (orig) {
      return function () {
        var r = orig.apply(this, arguments);
        try { opEvent('preview', 'plate preview'); } catch (e) {}
        return r;
      };
    });
    /* Previews that live inside a module's closure announce themselves
       (app-brush.js: a stroke under the pointer, and a stroke dropped). */
    function onOp(ev) {
      try {
        var d = (ev && ev.detail) || {};
        if (!PHASE_RANK[d.phase]) return;
        opEvent(d.phase, String(d.op || 'operation') + (d.reason ? ' - ' + shorten(d.reason, 160) : ''), d);
      } catch (e) {}
    }
    global.addEventListener('nso:op', onOp);
    restores.push(function () { global.removeEventListener('nso:op', onOp); });
  }

  function markOp(name) {
    ops.push(name);
    if (ops.length > OP_HISTORY) ops.shift();
    scheduleChecks(name);
  }

  /* ---------------- watcher 1: errors, network, status ---------------- */
  function installLogger() {
    var i;
    /* console */
    ['error', 'warn'].forEach(function (name) {
      var orig = console[name];
      console[name] = function () {
        if (!busy) {
          var txt = Array.prototype.map.call(arguments, function (a) {
            if (a instanceof Error) return a.message + (a.stack ? ' | ' + shorten(a.stack.split('\n')[1] || '', 90) : '');
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
          }).join(' ');
          log('console', name, shorten(txt, 400));
        }
        return orig.apply(console, arguments);
      };
      restores.push(function () { if (console[name] !== orig) console[name] = orig; });
    });

    /* uncaught errors, including a script or image that failed to load */
    function onErr(ev) {
      var tgt = ev && ev.target;
      if (tgt && tgt !== global && tgt.tagName) {
        log('net', 'error', 'resource failed to load: <' + String(tgt.tagName).toLowerCase() + '> ' +
            shorten(tgt.src || tgt.href || '?', 160));
        return;
      }
      var where = (ev && ev.filename) ? (' @ ' + shorten(ev.filename, 80) + ':' + ev.lineno + ':' + ev.colno) : '';
      log('error', 'error', 'uncaught: ' + shorten((ev && (ev.message || (ev.error && ev.error.message))) || 'unknown', 300) + where,
          ev && ev.error && ev.error.stack ? shorten(ev.error.stack, 600) : null);
    }
    global.addEventListener('error', onErr, true);
    restores.push(function () { global.removeEventListener('error', onErr, true); });

    function onRej(ev) {
      var r = ev && ev.reason;
      log('error', 'error', 'unhandled rejection: ' +
          shorten((r && (r.message || r)) || 'unknown', 300),
          r && r.stack ? shorten(r.stack, 600) : null);
    }
    global.addEventListener('unhandledrejection', onRej);
    restores.push(function () { global.removeEventListener('unhandledrejection', onRej); });

    /* fetch */
    if (typeof global.fetch === 'function') {
      var origFetch = global.fetch;
      global.fetch = function (input) {
        var url = (input && input.url) ? input.url : String(input);
        var t0 = (global.performance && performance.now) ? performance.now() : 0;
        var p;
        try { p = origFetch.apply(this, arguments); }
        catch (e) {
          log('net', 'error', 'fetch threw for ' + shorten(url, 140) + ' - ' + (e && e.message));
          throw e;
        }
        return p.then(function (res) {
          if (!res || !res.ok) {
            log('net', 'error', 'fetch ' + (res ? res.status + ' ' + (res.statusText || '') : 'no response') +
                ' for ' + shorten(url, 140), { ms: Math.round(((global.performance && performance.now) ? performance.now() : 0) - t0) });
          }
          return res;
        }, function (err) {
          log('net', 'error', 'fetch failed for ' + shorten(url, 140) + ' - ' +
              shorten((err && err.message) || err, 160));
          throw err;
        });
      };
      restores.push(function () { if (global.fetch !== origFetch) global.fetch = origFetch; });
    }

    /* XHR - three's loaders use it, so a missing STL shows up here, not in fetch */
    if (global.XMLHttpRequest && XMLHttpRequest.prototype) {
      var P = XMLHttpRequest.prototype;
      var origOpen = P.open, origSend = P.send;
      P.open = function (method, url) {
        try { this.__nsoWatchUrl = String(url); this.__nsoWatchMethod = String(method); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      P.send = function () {
        var xhr = this;
        try {
          xhr.addEventListener('loadend', function () {
            if (xhr.__nsoWatchLogged) return;
            xhr.__nsoWatchLogged = true;
            var u = shorten(xhr.__nsoWatchUrl || '?', 140);
            if (xhr.status === 0) log('net', 'error', 'XHR aborted or blocked: ' + u);
            else if (xhr.status >= 400) log('net', 'error', 'XHR ' + xhr.status + ' for ' + u);
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
      restores.push(function () {
        if (P.open !== origOpen) P.open = origOpen;
        if (P.send !== origSend) P.send = origSend;
      });
    }

    /* NSO's own status line. setStatus is a top-level function declaration in
       a classic script, so every unqualified setStatus(...) call in the app
       resolves through the global object at call time and lands here. The
       original is always called with the original arguments - the status line
       the user reads is not touched. */
    wrapGlobal('setStatus', function (orig) {
      return function (msg, isError) {
        try {
          var txt = String(msg == null ? '' : msg);
          /* app-fit.js's warnings, and the line that says they cleared -
             on their own, or appended to the line they followed */
          var bv = /(^|\| )Build volume: /.test(txt);
          var refusal = !bv && ((isError === true) || REFUSAL.test(txt));
          var t = tick();
          var ev = push({ kind: 'status', msg: txt, phase: t.phase,
                          level: bv ? (/fits again/.test(txt) ? 'info' : 'warn') : (refusal ? 'refusal' : 'info'),
                          source: bv ? 'build-volume' : null });
          t.events.push(ev);
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  }

  /* Replaces a global function, keeping a restore that only fires if nothing
     else has since replaced ours. Returns true when the global was there. */
  function wrapGlobal(name, make) {
    var orig = global[name];
    if (typeof orig !== 'function') return false;
    var wrapped = make(orig);
    wrapped.__nsoWatchWrapped = orig;
    global[name] = wrapped;
    restores.push(function () { if (global[name] === wrapped) global[name] = orig; });
    return true;
  }

  /* Which piece an undo entry says it changed - read off the entry itself,
     the app's own record, never off the selection. The two differ more often
     than they look: a paint click paints the piece under the cursor whatever
     is selected, and inside a Join the active piece is A while B is the one
     highlighted. Seat + paint driver round (2026-09-24): "commit maskReplace"
     was logged against the selected bit while the entry's modelId named the
     hull. `modelId` is what the replace / mask / sculpt entries carry;
     `index` is the plate slot the pose and move entries carry. */
  function undoTarget(entry) {
    if (!entry) return null;
    var S = stateRef();
    if (!S) return null;
    var id = null;
    if (entry.modelId != null) id = entry.modelId;
    else if (typeof entry.index === 'number' && S.placed && S.placed[entry.index]) id = S.placed[entry.index].sourceId;
    if (id == null) return null;
    var m = (S.models || []).filter(function (x) { return x && x.id === id; })[0];
    var sel = selSnap();
    var bySel = !!(sel && sel.sourceId != null);
    var selId = sel ? (bySel ? sel.sourceId : sel.editId) : null;
    var name = m ? m.name : null;
    return {
      target: { modelId: id, model: name, selected: id === selId },
      label: ' on "' + (name || '?') + '" (model #' + id + ')' +
             (id === selId || selId == null ? '' : (bySel ? ' - not the selected piece' : ' - not the active piece'))
    };
  }

  /* ---------------- watcher 2: rendered scene vs logical state ---------------- */
  function installConsistency() {
    /* pushUndo is the app's own record that something changed: every
       mutating operation - bake, split, join, subtract, paint, clone,
       delete, and the end of a drag - pushes one, and its `type` is the
       app's own name for what just happened. Reading the operation label off
       that beats guessing it from a button. */
    wrapGlobal('pushUndo', function (orig) {
      return function (entry) {
        try {
          var tgt = undoTarget(entry);
          opEvent('commit', ((entry && entry.type) || 'unknown') + (tgt ? tgt.label : ''),
                  tgt ? { target: tgt.target } : null);
        } catch (e) {}
        var r = orig.apply(this, arguments);
        try { markOp('op ' + ((entry && entry.type) || 'unknown')); } catch (e) {}
        return r;
      };
    });

    /* Undo is synchronous, so the first check runs the instant it returns. */
    wrapGlobal('undoLast', function (orig) {
      return function () {
        var kind = 'unknown';
        try {
          var S = stateRef();
          var top = S && S.undoStack && S.undoStack[S.undoStack.length - 1];
          if (top && top.type) kind = top.type;
        } catch (e) {}
        ops.push('undo ' + kind);
        if (ops.length > OP_HISTORY) ops.shift();
        try { opEvent('undo', kind); } catch (e) {}
        var r = orig.apply(this, arguments);
        scheduleChecks('undo ' + kind, true);
        return r;
      };
    });

    /* What the paint module last drew, and what it drew it from. Compared
       against the piece's CURRENT mesh on every check: that is how yellow
       left over from a geometry the undo replaced is caught, without this
       file re-deriving a single face. */
    wrapGlobal('nsoMaskRepaint', function (orig) {
      return function () {
        var drew = orig.apply(this, arguments);
        try {
          var S = stateRef();
          var m = activeModel();
          var p = (S && m) ? (S.placed || []).filter(function (q) {
            return q && q.sourceId === m.id && q.mesh;
          })[0] : null;
          paintStamp = {
            modelId: m ? m.id : null,
            drew: (typeof drew === 'number') ? drew : null,
            maskLen: (typeof global.nsoMaskCount === 'function') ? global.nsoMaskCount(m) : null,
            geoUuid: (p && p.mesh && p.mesh.geometry) ? p.mesh.geometry.uuid : null,
            meshUuid: (p && p.mesh) ? p.mesh.uuid : null,
            op: opLabel(),
            time: clock()
          };
        } catch (e) {}
        return drew;
      };
    });

    /* Tool switches, and every other operation that goes through a control.
       Capture phase, so the label is recorded before the app's own handler
       runs; the check itself is scheduled for after it. This is what covers
       the buttons whose handlers were bound by reference at load time and so
       cannot be wrapped by name. */
    function onClick(ev) {
      try {
        var t = ev.target;
        if (!t || !t.closest) return;
        if (el.panel && el.panel.contains(t)) return;       // our own UI
        if (el.report && el.report.contains(t)) return;
        var c = t.closest('button, [role="menuitem"], summary');
        if (!c) return;
        markOp('click ' + (c.id || shorten((c.textContent || '').trim(), 24) || c.tagName));
      } catch (e) {}
    }
    function onChange(ev) {
      try {
        var t = ev.target;
        if (!t || !t.id) return;
        if (el.panel && el.panel.contains(t)) return;
        if (el.report && el.report.contains(t)) return;
        markOp('set ' + t.id + '=' + shorten(t.value, 24));
      } catch (e) {}
    }
    /* A press on the 3D view itself. Paint, Seat here, Carve, Measure and a
       move drag all start from a pointerdown on the canvas, not from a
       button, so without this their commit carried whatever button was
       pressed last ("commit maskReplace | op=click btn-seat-here").
       Capture phase on the document, so it is recorded before the canvas's
       own capture-phase handlers run. */
    function onViewportDown(ev) {
      try {
        var S = stateRef();
        var cv = S && S.renderer && S.renderer.domElement;
        if (!cv || ev.target !== cv || ev.button !== 0) return;
        markOp('press on the 3D view');
      } catch (e) {}
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('pointerdown', onViewportDown, true);
    restores.push(function () {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('pointerdown', onViewportDown, true);
    });

    /* Anything not driven by a control at all - a keyboard shortcut, a call
       from the console, a late async finish nobody scheduled a check for. */
    idleTimer = global.setInterval(function () { check('idle sweep'); }, IDLE_MS);
    restores.push(function () { global.clearInterval(idleTimer); idleTimer = 0; });
  }

  function scheduleChecks(label, alsoNow) {
    if (!on) return;
    if (alsoNow) check(label);
    CHECK_DELAYS.forEach(function (d) {
      var id = global.setTimeout(function () {
        timers = timers.filter(function (x) { return x !== id; });
        check(label);
      }, d);
      timers.push(id);
    });
  }
  function clearTimers() {
    timers.forEach(function (id) { global.clearTimeout(id); });
    timers = [];
  }

  /* ---------------- the consistency pass ---------------- */
  /* Every finding is {subject, msg, detail, fp}. fp is the identity of the
     mismatch, not of the moment it was seen: a finding is reported once when
     it opens and once when it clears, so a mismatch that survives twenty
     checks is two lines, not forty. */
  function collect() {
    var f = [];
    var S = stateRef();
    if (!S || !S.modelGroup) return f;

    function add(subject, msg, fp, detail) {
      f.push({ subject: subject, msg: msg, fp: subject + '|' + fp, detail: detail || null });
    }

    var models = S.models || [];
    var placed = S.placed || [];
    var group = S.modelGroup;

    /* --- the registry itself --- */
    var byId = {};
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (!m) { add('object', 'model registry holds an empty slot at index ' + i, 'model-hole-' + i); continue; }
      if (byId[m.id] !== undefined) {
        add('object', 'two models share id #' + m.id + ' ("' + (byId[m.id].name || '?') + '" and "' + (m.name || '?') + '")', 'dup-model-' + m.id);
      }
      byId[m.id] = m;
    }

    /* --- every logical piece, against what is actually drawn for it --- */
    var owned = [];
    placed.forEach(function (p, idx) {
      var who = 'placed[' + idx + ']' + (p && p.name ? ' "' + p.name + '"' : '');
      var key = 'p' + idx;
      if (!p) { add('object', 'the plate list holds an empty slot at index ' + idx, key + '-hole'); return; }

      var mdl = (p.sourceId != null) ? byId[p.sourceId] : null;
      if (p.sourceId != null && !mdl) {
        add('object', who + ' is on the plate but its model #' + p.sourceId + ' is gone from the registry', key + '-nomodel');
      }
      if (!p.mesh) {
        add('object', who + ' has no mesh - the plate counts it, the scene draws nothing', key + '-nomesh');
        return;
      }
      owned.push(p.mesh);

      if (p.mesh.parent !== group) {
        add('object', who + ' has a mesh that is not in the scene - the plate counts a piece nobody can see', key + '-detached');
      }
      var ud = p.mesh.userData || {};
      if (ud.placedIndex !== idx) {
        add('object', who + ' carries placedIndex ' + ud.placedIndex + ' - a click on it selects placed[' + ud.placedIndex + ']', key + '-index-' + ud.placedIndex);
      }
      if (p.sourceId != null && ud.sourceId !== p.sourceId) {
        add('object', who + ' renders a mesh stamped sourceId ' + ud.sourceId + ', the entry says ' + p.sourceId, key + '-srcid');
      }

      /* --- the surface on screen vs the surface the app will export --- */
      if (p.geometry && p.mesh.geometry !== p.geometry) {
        add('wall', who + ' draws a geometry its own entry does not point at - what is on screen is not what the plate holds', key + '-geo-entry');
      }
      if (mdl && mdl.geometry && p.mesh.geometry !== mdl.geometry) {
        add('wall', who + ' draws a geometry that is not model #' + mdl.id + "'s current one - a bake or an undo left the old surface on screen", key + '-geo-model');
      }
      if (mdl && mdl.rawTris && mdl.rawAxis === 'zup') {
        var rawT = (mdl.rawTris.length / 9) | 0;
        var dispT = triCount(p.mesh.geometry);
        if (rawT !== dispT) {
          add('wall', who + ' shows ' + dispT + ' triangles; model #' + mdl.id + ' exports ' + rawT +
              ' - the picture and the file disagree about the surface', key + '-tris-' + dispT + '-' + rawT);
        }
      }

      /* --- pose: applyMeshRotation() is the one definition --- */
      var wantX = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180) + (p.flipX ? Math.PI : 0);
      var wantY = p.rotY || 0;
      var wantZ = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
      var r = p.mesh.rotation;
      if (angOff(r.x, wantX) > TOL_RAD || angOff(r.y, wantY) > TOL_RAD || angOff(r.z, wantZ) > TOL_RAD) {
        add('pose', who + ' is drawn at (' + deg(r.x) + ', ' + deg(r.y) + ', ' + deg(r.z) +
            ')deg; its logical pose is (' + deg(wantX) + ', ' + deg(wantY) + ', ' + deg(wantZ) + ')deg',
            key + '-rot',
            { rotY: p.rotY, flipX: p.flipX, tipX: p.tipX, tipZ: p.tipZ, tiltX: p.tiltX, tiltZ: p.tiltZ });
      }
      if (Math.abs(p.mesh.position.x - (p.x || 0)) > TOL_MM || Math.abs(p.mesh.position.z - (p.z || 0)) > TOL_MM) {
        add('pose', who + ' is drawn at x=' + mm(p.mesh.position.x) + ' z=' + mm(p.mesh.position.z) +
            '; the plate places it at x=' + mm(p.x) + ' z=' + mm(p.z), key + '-xz');
      }

      var box = worldBox(p.mesh);
      var sz = boxSize(box);
      if (box && sz) {
        if (!p.overflow && !p.meshOffsetY) {
          var wantMinY = 0.2 + (p.liftY || 0);
          if (Math.abs(box.min.y - wantMinY) > TOL_BED) {
            add('pose', who + ' sits with its lowest point at y=' + mm(box.min.y) +
                ' mm; seated on the bed it belongs at ' + mm(wantMinY) + ' mm', key + '-bed');
          }
        }
        var bad = [];
        if (typeof p.width === 'number' && Math.abs(sz.x - p.width) > TOL_MM) bad.push('width ' + mm(sz.x) + ' vs ' + mm(p.width));
        if (typeof p.depth === 'number' && Math.abs(sz.z - p.depth) > TOL_MM) bad.push('depth ' + mm(sz.z) + ' vs ' + mm(p.depth));
        if (typeof p.height === 'number' && Math.abs(sz.y - p.height) > TOL_MM) bad.push('height ' + mm(sz.y) + ' vs ' + mm(p.height));
        if (bad.length) {
          add('footprint', who + ' measures ' + bad.join(', ') + ' (drawn vs packed) - the packer is reserving the wrong space for it', key + '-size');
        }
      }
    });

    /* --- everything on screen that no logical piece owns --- */
    var overlays = [];
    var drawnPieces = 0;
    (group.children || []).forEach(function (c) {
      if (isPaintOverlay(c)) { overlays.push(c); return; }
      if (c === S.previewMesh || c === S.cutHelper || c === S.faceHelper || c === S.fenceGroup) return;
      var cud = c.userData || {};
      var isPiece = !!(c.isMesh && (cud.sourceId != null || cud.placedIndex != null));
      if (isPiece) drawnPieces++;
      if (owned.indexOf(c) >= 0) return;
      if (cud.editPreview) {
        add('object', 'an edit-preview mesh is in the scene that state.previewMesh does not point at', 'stale-preview-' + c.uuid);
        return;
      }
      if (isPiece) {
        add('object', 'a piece mesh (sourceId ' + cud.sourceId + ', placedIndex ' + cud.placedIndex +
            ') is on screen that no entry on the plate owns', 'orphan-' + c.uuid);
      }
    });
    if (drawnPieces !== placed.length) {
      add('object', 'the plate holds ' + placed.length + ' piece(s); the scene draws ' + drawnPieces,
          'count-' + placed.length + '-' + drawnPieces);
    }

    /* --- paint: the skip list vs the yellow on screen --- */
    var am = activeModel();
    var maskN = (typeof global.nsoMaskCount === 'function') ? global.nsoMaskCount(am) : 0;
    var pm = am ? placed.filter(function (q) { return q && q.sourceId === am.id && q.mesh; })[0] : null;

    if (overlays.length > 1) {
      add('paint', overlays.length + ' paint overlays are in the scene; the paint module keeps exactly one', 'paint-many-' + overlays.length);
    }
    if (maskN === 0 && overlays.length > 0) {
      add('paint', 'paint is on screen but no face is excluded on "' + (am ? am.name : '?') + '" - the yellow outlived the list it stands for', 'paint-orphan');
    }
    if (maskN > 0 && pm && overlays.length === 0 && paintStamp && paintStamp.drew > 0) {
      add('paint', maskN + ' face(s) are excluded on "' + (am ? am.name : '?') + '" and the last repaint drew ' +
          paintStamp.drew + ' triangle(s), but nothing is on screen', 'paint-missing');
    }
    if (overlays.length === 1 && pm) {
      var ov = overlays[0];
      /* Which piece the yellow was drawn from, without asking the paint
         module and without re-deriving a single face: repaint() disposes its
         overlay and builds a new mesh every time it runs, so an overlay whose
         uuid we have seen before is one no repaint has touched since. What
         the piece looked like then is recorded the first time it is seen. */
      var was = ovSeen[ov.uuid];
      if (!was) {
        var keys = Object.keys(ovSeen);
        // every repaint retires one overlay and makes another; the ledger
        // only has to remember the recent ones
        if (keys.length > 200) delete ovSeen[keys[0]];
        was = ovSeen[ov.uuid] = {
          geoUuid: pm.mesh.geometry ? pm.mesh.geometry.uuid : null,
          maskLen: maskN, op: opLabel(), time: clock()
        };
      }
      if (was.geoUuid && pm.mesh.geometry && was.geoUuid !== pm.mesh.geometry.uuid) {
        add('paint', 'the paint on screen was drawn from the geometry the piece had at ' + was.time +
            ' (' + was.op + '); the piece has been rebuilt since and nothing repainted it', 'paint-stale-geo');
      }
      if (was.maskLen !== maskN) {
        add('paint', 'the paint on screen stands for ' + was.maskLen + ' excluded face(s); the list now holds ' + maskN, 'paint-stale-count');
      }
      var gap = ov.position.distanceTo(pm.mesh.position);
      var tw = angOff(ov.rotation.x, pm.mesh.rotation.x) + angOff(ov.rotation.y, pm.mesh.rotation.y) +
               angOff(ov.rotation.z, pm.mesh.rotation.z);
      if (gap > TOL_MM || tw > TOL_RAD) {
        add('paint', 'the paint is ' + mm(gap) + ' mm and ' + deg(tw) +
            ' deg off the piece it marks - it was drawn for a pose the piece has left', 'paint-pose');
      }
      var ob = worldBox(ov), pb = worldBox(pm.mesh);
      if (ob && pb && isFinite(ob.min.x) && isFinite(pb.min.x)) {
        var pad = 0.25;
        if (ob.min.x < pb.min.x - pad || ob.min.y < pb.min.y - pad || ob.min.z < pb.min.z - pad ||
            ob.max.x > pb.max.x + pad || ob.max.y > pb.max.y + pad || ob.max.z > pb.max.z + pad) {
          add('paint', 'the paint has triangles outside the piece it marks - it belongs to a surface that is gone', 'paint-outside');
        }
      }
    }
    return f;
  }

  /* Reports what is new, and what has cleared, and nothing else. */
  function check(label) {
    if (!on) return [];
    var found;
    try { found = collect(); }
    catch (e) {
      busy = true;
      try { raw.error.call(console, '[' + VERSION + '] the consistency pass threw: ' + (e && e.message)); } catch (e2) {}
      busy = false;
      return [];
    }
    var seen = Object.create(null);
    found.forEach(function (fi) {
      seen[fi.fp] = fi;
      if (openF[fi.fp]) return;
      openF[fi.fp] = push({
        kind: 'phantom', level: 'error',
        msg: 'phantom ' + fi.subject + ' - ' + fi.msg,
        detail: fi.detail, op: label || opLabel(),
        trail: ops.slice()
      });
    });
    Object.keys(openF).forEach(function (fp) {
      if (seen[fp]) return;
      var was = openF[fp];
      delete openF[fp];
      push({ kind: 'cleared', level: 'info',
             msg: 'cleared (was: ' + was.msg + ', open since ' + was.time + ')',
             op: label || opLabel() });
    });
    counts();
    return found;
  }

  /* ---------------- the panel ---------------- */
  var CSS = [
    /* left:64px clears the viewport's left tool rail (Undo, the eye and the
       buttons between them: 12px inset + 44px buttons), so the log never sits
       on it, expanded or collapsed. */
    '#nso-watch-panel{position:absolute;left:64px;bottom:68px;width:min(420px,calc(100% - 76px));',
    'max-height:46vh;display:none;flex-direction:column;z-index:120;pointer-events:auto;',
    'background:rgba(9,12,18,.95);border:1px solid #3a4558;border-radius:10px;',
    'box-shadow:0 6px 24px rgba(0,0,0,.55);backdrop-filter:blur(8px);color:#e5edf7;',
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '#nso-watch-panel.is-on{display:flex}',
    '#nso-watch-panel.is-collapsed #nso-watch-list{display:none}',
    '#nso-watch-panel.is-collapsed #nso-watch-head{border-bottom:0}',
    '#nso-watch-panel.is-collapsed{width:auto;max-width:calc(100% - 76px)}',
    '#nso-watch-head{display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid #26303f;flex:0 0 auto}',
    '#nso-watch-head b{font-weight:600;letter-spacing:.02em;color:#f8fafc}',
    '#nso-watch-counts{margin-left:auto;display:flex;gap:6px;align-items:center}',
    '.nso-watch-pill{border-radius:999px;padding:1px 7px;font-size:11px;border:1px solid #3a4558;color:#cbd5e1}',
    '.nso-watch-pill.bad{background:#7f1d1d;border-color:#ef4444;color:#fff}',
    '.nso-watch-pill.warn{background:#78350f;border-color:#f59e0b;color:#fff}',
    '#nso-watch-head button{background:rgba(255,255,255,.1);border:1px solid #3a4558;color:#e5edf7;',
    'border-radius:6px;font-size:11px;padding:2px 7px;cursor:pointer;font-family:inherit}',
    '#nso-watch-head button:hover{border-color:#38bdf8;background:rgba(30,41,59,.98)}',
    '#nso-watch-list{overflow:auto;padding:4px 0;flex:1 1 auto;overscroll-behavior:contain}',
    '.nso-watch-row{display:flex;flex-wrap:wrap;gap:0 7px;padding:2px 9px;align-items:flex-start;border-left:3px solid transparent}',
    '.nso-watch-row time{color:#64748b;flex:0 0 auto;font-variant-numeric:tabular-nums}',
    '.nso-watch-row span{flex:1 1 60%;word-break:break-word;min-width:0}',
    '.nso-watch-row .op{flex:0 0 100%;margin-left:69px;color:#94a3b8;opacity:.8}',
    '.nso-watch-row.k-phantom{border-left-color:#ef4444;background:rgba(127,29,29,.28);color:#fecaca}',
    '.nso-watch-row.k-cleared{border-left-color:#22c55e;color:#86efac}',
    '.nso-watch-row.k-error{border-left-color:#ef4444;color:#fca5a5}',
    '.nso-watch-row.k-net{border-left-color:#f97316;color:#fdba74}',
    '.nso-watch-row.k-console{border-left-color:#f59e0b;color:#fcd34d}',
    '.nso-watch-row.k-refusal{border-left-color:#a78bfa;color:#ddd6fe}',
    '.nso-watch-row.k-status{color:#94a3b8}',
    '#btn-watch.is-on{border-color:#ef4444;color:#fff;background:rgba(127,29,29,.9)}',
    '#btn-watch .nso-watch-dot{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;',
    'border-radius:999px;background:#ef4444;color:#fff;font:600 10px/17px ui-sans-serif,system-ui;',
    'text-align:center;padding:0 3px;display:none}',
    '#btn-watch .nso-watch-dot.is-on{display:block}',
    '.nso-watch-row.k-select{border-left-color:#38bdf8;color:#bae6fd}',
    '.nso-watch-row.k-commit{border-left-color:#22c55e;color:#bbf7d0}',
    '.nso-watch-row.k-undo{border-left-color:#14b8a6;color:#99f6e4}',
    '.nso-watch-row.k-preview{border-left-color:#64748b;color:#cbd5e1;font-style:italic}',
    '.nso-watch-row.k-discard{border-left-color:#64748b;color:#94a3b8;text-decoration:line-through}',
    '.nso-watch-row.k-build-volume{border-left-color:#eab308;color:#fde68a}',
    '.nso-watch-row.k-warning{border-left-color:#f59e0b;color:#fcd34d}',
    '.nso-watch-row .ph{font-style:normal;flex:0 0 auto;font-size:10px;padding:0 5px;border-radius:4px;border:1px solid #3a4558;color:#cbd5e1}',
    '.nso-watch-row .ph-commit{border-color:#22c55e;color:#86efac}',
    '.nso-watch-row .ph-undo{border-color:#14b8a6;color:#5eead4}',
    '#nso-watch-report{position:absolute;inset:12px 12px 68px 12px;display:none;flex-direction:column;z-index:121;',
    'background:#090c12;border:1px solid #3a4558;border-radius:10px;box-shadow:0 10px 36px rgba(0,0,0,.6);',
    'color:#e5edf7;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:auto;min-height:0}',
    '#nso-watch-report.is-on{display:flex}',
    '#nso-watch-report .wr-head,#nso-watch-report .wr-filt{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:7px 9px;border-bottom:1px solid #26303f}',
    '#nso-watch-report .wr-head b{font-weight:600;color:#f8fafc}',
    '#nso-watch-report .wr-meta{color:#94a3b8;flex:1 1 auto;min-width:0}',
    '#nso-watch-report button,#nso-watch-report select,#nso-watch-report input{background:rgba(255,255,255,.08);border:1px solid #3a4558;',
    'color:#e5edf7;border-radius:6px;font:inherit;font-size:11px;padding:2px 7px}',
    '#nso-watch-report button{cursor:pointer}',
    '#nso-watch-report button:hover{border-color:#38bdf8}',
    '#nso-watch-report input{flex:1 1 140px;min-width:0}',
    '#nso-watch-report .wr-sum{display:flex;flex-wrap:wrap;gap:5px;padding:6px 9px;border-bottom:1px solid #26303f}',
    '#nso-watch-report .wr-sum button.is-on{border-color:#38bdf8;background:rgba(56,189,248,.18)}',
    '#nso-watch-report .wr-list{overflow:auto;flex:1 1 auto;padding:4px 0;overscroll-behavior:contain;min-height:0}',
    '#nso-watch-report .wr-run{padding:6px 9px 2px;color:#94a3b8;border-top:1px solid #26303f;margin-top:4px}',
    '#nso-watch-report .wr-note{padding:6px 9px;color:#94a3b8}'
  ].join('');

  function buildPanel() {
    if (el.panel) return;
    if (!document.getElementById('nso-watch-css')) {
      var st = document.createElement('style');
      st.id = 'nso-watch-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var host = document.querySelector('.viewport-section') || document.body;
    var p = document.createElement('div');
    p.id = 'nso-watch-panel';
    p.innerHTML =
      '<div id="nso-watch-head">' +
        '<b>Watch</b>' +
        '<span id="nso-watch-counts">' +
          '<span class="nso-watch-pill" id="nso-watch-n-phantom">0 phantom</span>' +
          '<span class="nso-watch-pill" id="nso-watch-n-error">0 error</span>' +
        '</span>' +
        '<button type="button" id="nso-watch-report-btn">Report</button>' +
        '<button type="button" id="nso-watch-copy">Copy</button>' +
        '<button type="button" id="nso-watch-clear">Clear</button>' +
        '<button type="button" id="nso-watch-collapse" aria-expanded="true"' +
          ' title="Collapse the log to this bar, so it stops covering the tool cards">\u25be</button>' +
      '</div>' +
      '<div id="nso-watch-list"></div>';
    host.appendChild(p);
    el.panel = p;
    el.list = p.querySelector('#nso-watch-list');
    el.nPhantom = p.querySelector('#nso-watch-n-phantom');
    el.nError = p.querySelector('#nso-watch-n-error');
    p.querySelector('#nso-watch-report-btn').addEventListener('click', function () { api.showReport(); });
    p.querySelector('#nso-watch-copy').addEventListener('click', function () { api.copy(); });
    p.querySelector('#nso-watch-clear').addEventListener('click', function () { api.clear(); });
    p.querySelector('#nso-watch-collapse').addEventListener('click', function () { api.collapse(!api.isCollapsed()); });
    applyCollapsed(readCollapsed());
  }

  /* Collapse. Expanded, the panel is up to 46vh tall in the bottom-left of
     the viewport - over the Scale card's "Scale by" row and the Undo button,
     which a person watching could then not click (driver-testing round 1,
     2026-09-24). Collapsed it is only its header bar: the phantom and error
     pills stay in view, logging and checking carry on exactly as before, and
     nothing under the log's old footprint is covered. A per-viewer display
     preference, so it lives in its own localStorage key and survives a
     reload; unreadable storage just means "expanded". */
  var COLLAPSE_KEY = 'nso.watch.collapsed';
  function readCollapsed() {
    try { return global.localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (e) { return false; }
  }
  function applyCollapsed(c) {
    if (!el.panel) return;
    el.panel.classList.toggle('is-collapsed', !!c);
    var b = el.panel.querySelector('#nso-watch-collapse');
    if (b) {
      b.textContent = c ? '\u25b8' : '\u25be';
      b.setAttribute('aria-expanded', c ? 'false' : 'true');
      b.title = c ? 'Show the log' : 'Collapse the log to this bar, so it stops covering the tool cards';
    }
  }

  /* One classification, shared by the live panel and the report. */
  function category(ev) {
    if (ev.kind === 'op') return ev.phase || 'op';
    if (ev.kind === 'status') return ev.source === 'build-volume' ? 'build-volume' : (ev.level === 'refusal' ? 'refusal' : 'status');
    if (ev.kind === 'console') return ev.level === 'error' ? 'error' : 'warning';
    if (ev.kind === 'net') return 'error';
    return ev.kind;          // phantom, cleared, error, select, watch
  }
  function paintPhase(d, phase) {
    var b = d.querySelector('.ph');
    if (!b) {
      b = document.createElement('em');
      b.className = 'ph';
      d.insertBefore(b, d.children[1] || null);
    }
    b.textContent = phase;
    b.className = 'ph ph-' + phase;
  }
  function row(ev) {
    if (!el.list) return;
    var d = document.createElement('div');
    d.className = 'nso-watch-row k-' + category(ev);
    var t = document.createElement('time');
    t.textContent = ev.time;
    var s = document.createElement('span');
    s.textContent = ev.msg;
    d.appendChild(t);
    d.appendChild(s);
    if (ev.phase && ev.kind === 'status') paintPhase(d, ev.phase);
    ev._row = d;
    if (ev.kind === 'phantom') {
      var o = document.createElement('span');
      o.className = 'op';
      o.textContent = 'after ' + ev.op;
      d.appendChild(o);
    } else if (ev.kind === 'op' && ev.sel) {
      var on2 = document.createElement('span');
      on2.className = 'op';
      on2.textContent = 'on ' + selText(ev.sel);
      d.appendChild(on2);
    }
    var stick = el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 24;
    el.list.appendChild(d);
    while (el.list.childElementCount > 400) el.list.removeChild(el.list.firstChild);
    if (stick) el.list.scrollTop = el.list.scrollHeight;
  }

  /* ---------------- the report view ----------------
     The whole persisted history, in the app, browsable. Read from `store`,
     which is the same object persist() writes, so an open report follows the
     session live; when the watch is off it is read back from localStorage. */
  var REPORT_CATS = ['phantom', 'error', 'select', 'preview', 'discard', 'commit', 'undo',
                     'build-volume', 'refusal', 'status', 'warning', 'cleared', 'watch'];
  var rf = { run: 'all', cat: 'all', q: '' };

  function buildReport() {
    if (el.report) return;
    var host = document.querySelector('.viewport-section') || document.body;
    var r = document.createElement('div');
    r.id = 'nso-watch-report';
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-label', 'Watch report');
    r.innerHTML =
      '<div class="wr-head"><b>Watch report</b><span class="wr-meta" id="nso-wr-meta"></span>' +
        '<button type="button" id="nso-wr-copy">Copy</button>' +
        '<button type="button" id="nso-wr-wipe">Clear history</button>' +
        '<button type="button" id="nso-wr-close">Close</button></div>' +
      '<div class="wr-filt"><select id="nso-wr-run" aria-label="Run"></select>' +
        '<input type="search" id="nso-wr-q" placeholder="filter text" aria-label="Filter text"></div>' +
      '<div class="wr-sum" id="nso-wr-sum"></div>' +
      '<div class="wr-list" id="nso-wr-list"></div>';
    host.appendChild(r);
    el.report = r;
    ['pointerdown', 'wheel', 'keydown'].forEach(function (t) {
      r.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    r.querySelector('#nso-wr-close').addEventListener('click', function () { api.hideReport(); });
    r.querySelector('#nso-wr-copy').addEventListener('click', function () { api.copyReport(); });
    r.querySelector('#nso-wr-wipe').addEventListener('click', function () { api.clearStored(); });
    r.querySelector('#nso-wr-run').addEventListener('change', function (e) { rf.run = e.target.value; renderReport(); });
    r.querySelector('#nso-wr-q').addEventListener('input', function (e) { rf.q = e.target.value; renderReport(); });
    r.querySelector('#nso-wr-sum').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[data-cat]');
      if (!b) return;
      var c = b.getAttribute('data-cat');
      rf.cat = (rf.cat === c) ? 'all' : c;
      renderReport();
    });
  }

  function reportSoon() {
    if (reportTimer) return;
    reportTimer = global.setTimeout(function () { reportTimer = 0; renderReport(); }, 200);
  }

  function runLabel(run, i) {
    var d = run.started ? new Date(run.started) : null;
    return '#' + (i + 1) + ' ' + (d ? d.toLocaleDateString() + ' ' + clock(d) : '?') +
           ' (' + (run.events || 0) + ')' + (run.id === runId && on ? ' - live' : '');
  }

  /* The events a filter selects, oldest first. Exposed as api.query(). */
  function query(f) {
    var st = store || loadStore();
    f = f || {};
    var q = String(f.q || '').toLowerCase();
    return st.events.filter(function (e) {
      if (f.run && f.run !== 'all' && e.run !== f.run) return false;
      if (f.cat && f.cat !== 'all' && category(e) !== f.cat) return false;
      if (q && (e.msg + ' ' + (e.op || '') + ' ' + (e.sel ? selText(e.sel) : '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderReport() {
    if (!el.report) return;
    if (!store) store = loadStore();
    var runs = store.runs;
    var runNo = {};
    runs.forEach(function (r, i) { runNo[r.id] = i + 1; });
    if (rf.run !== 'all' && !runNo[rf.run]) rf.run = 'all';

    var sel = el.report.querySelector('#nso-wr-run');
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All runs (' + runs.length + ')';
    sel.appendChild(all);
    runs.forEach(function (r, i) {
      var o = document.createElement('option');
      o.value = r.id;
      o.textContent = runLabel(r, i);
      sel.appendChild(o);
    });
    sel.value = rf.run;

    var inRun = query({ run: rf.run });
    var by = {};
    inRun.forEach(function (e) { var c = category(e); by[c] = (by[c] || 0) + 1; });
    var sum = el.report.querySelector('#nso-wr-sum');
    sum.innerHTML = '';
    REPORT_CATS.forEach(function (c) {
      if (!by[c] && rf.cat !== c) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-cat', c);
      b.className = (rf.cat === c) ? 'is-on' : '';
      b.textContent = (by[c] || 0) + ' ' + c;
      sum.appendChild(b);
    });

    var rows = query(rf);
    el.report.querySelector('#nso-wr-meta').textContent =
      store.events.length + ' event(s) in ' + runs.length + ' run(s), kept in this browser' +
      (store.dropped ? ' - ' + store.dropped + ' older dropped' : '') +
      (rows.length !== store.events.length ? ' - ' + rows.length + ' shown' : '');

    var list = el.report.querySelector('#nso-wr-list');
    var stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
    list.innerHTML = '';
    if (!rows.length) {
      var n = document.createElement('div');
      n.className = 'wr-note';
      n.textContent = store.events.length ? 'Nothing matches this filter.' :
        'Nothing recorded yet. Turn the watch on and use the app - every event lands here, across reloads.';
      list.appendChild(n);
      return;
    }
    var from = Math.max(0, rows.length - REPORT_ROWS);
    if (from) {
      var more = document.createElement('div');
      more.className = 'wr-note';
      more.textContent = 'Showing the newest ' + REPORT_ROWS + ' of ' + rows.length + ' - narrow the filter to see older ones.';
      list.appendChild(more);
    }
    var lastRun = null;
    var frag = document.createDocumentFragment();
    for (var i = from; i < rows.length; i++) {
      var e = rows[i];
      if (e.run !== lastRun) {
        lastRun = e.run;
        var h = document.createElement('div');
        h.className = 'wr-run';
        var rr = runs[runNo[e.run] - 1];
        h.textContent = 'run ' + (rr ? runLabel(rr, runNo[e.run] - 1) : '(pruned)');
        frag.appendChild(h);
      }
      var d = document.createElement('div');
      d.className = 'nso-watch-row k-' + category(e);
      var t = document.createElement('time');
      t.textContent = e.time;
      t.title = e.iso;
      var sp = document.createElement('span');
      sp.textContent = e.msg;
      d.appendChild(t);
      d.appendChild(sp);
      if (e.kind === 'status' && e.phase) paintPhase(d, e.phase);
      var sub = null;
      if (e.kind === 'phantom') sub = 'after ' + e.op;
      else if (e.kind === 'op' && e.sel) sub = 'on ' + selText(e.sel);
      if (sub) {
        var o = document.createElement('span');
        o.className = 'op';
        o.textContent = sub;
        d.appendChild(o);
      }
      frag.appendChild(d);
    }
    list.appendChild(frag);
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function reportText(rows) {
    var st = store || loadStore();
    var runNo = {};
    st.runs.forEach(function (r, i) { runNo[r.id] = i + 1; });
    var out = ['# NSO watch history (' + VERSION + ') - ' + rows.length + ' event(s), ' + st.runs.length + ' run(s)' +
               (st.dropped ? ', ' + st.dropped + ' older dropped' : ''), ''];
    rows.forEach(function (e) {
      out.push('#' + (runNo[e.run] || '?') + ' ' + e.time + '  ' + category(e) +
               (e.kind === 'status' && e.phase ? '/' + e.phase : '') + '  ' + e.msg +
               (e.kind === 'phantom' ? '   [after ' + e.op + ']' : '') +
               (e.kind === 'op' && e.sel ? '   [on ' + selText(e.sel) + ']' : ''));
    });
    return out.join('\n');
  }

  function counts() {
    var nP = 0, nE = 0;
    for (var i = 0; i < events.length; i++) {
      if (events[i].kind === 'phantom') nP++;
      else if (events[i].kind === 'error' || events[i].kind === 'net' ||
               (events[i].kind === 'console' && events[i].level === 'error')) nE++;
    }
    if (el.nPhantom) {
      el.nPhantom.textContent = nP + ' phantom';
      el.nPhantom.className = 'nso-watch-pill' + (nP ? ' bad' : '');
    }
    if (el.nError) {
      el.nError.textContent = nE + ' error';
      el.nError.className = 'nso-watch-pill' + (nE ? ' warn' : '');
    }
    if (el.dot) {
      el.dot.textContent = String(nP + nE);
      el.dot.className = 'nso-watch-dot' + ((nP + nE) ? ' is-on' : '');
    }
  }

  function paintButton() {
    if (!el.btn) return;
    el.btn.classList.toggle('is-on', on);
    el.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.btn.title = on
      ? 'Watch is ON - logging errors and status, and checking the scene against the app state after every operation. Click to stop.'
      : 'Watch: log errors / failed loads / status lines, and check the rendered scene against the app state after every Undo, bake and tool switch.';
  }

  /* ---------------- public api ---------------- */
  var api = {
    version: VERSION,

    start: function () {
      if (on) return true;
      raw.log = console.log; raw.warn = console.warn; raw.error = console.error;
      events = []; dropped = 0; seqN = 0; ops = []; paintStamp = null;
      ovSeen = Object.create(null);
      openF = Object.create(null);
      restores = [];
      startedWall = Date.now();
      /* Taken before anything is logged, so the first line cannot read as a
         change from an unknown selection. */
      selPending = false; task = null;
      /* One run per start(), appended to whatever this browser already holds. */
      store = loadStore();
      runId = startedWall.toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36);
      store.runs.push({ id: runId, started: new Date(startedWall).toISOString(), ended: null, events: 0,
                        page: (global.location ? global.location.pathname + global.location.search : '') });
      var liveRuns = {};
      store.events.forEach(function (e) { liveRuns[e.run] = true; });
      store.runs = store.runs.filter(function (r) { return r.id === runId || liveRuns[r.id]; }).slice(-200);
      on = true;
      selCur = selSnap();
      buildPanel();
      if (el.panel) el.panel.classList.add('is-on');
      if (el.list) el.list.innerHTML = '';
      installLogger();
      installConsistency();
      installSelection();
      installOps();
      global.addEventListener('pagehide', flushStore);
      restores.push(function () { global.removeEventListener('pagehide', flushStore); });
      paintButton();
      log('watch', 'info', 'watch on - ' + VERSION + ' - error/status log, selection and preview/commit tracking, and state-consistency checks are live');
      /* What is selected when watching starts, so the first operation in the
         log is never one whose target is unknown. */
      flushSelection();
      push({ kind: 'select', level: 'info', msg: 'selection at start: ' + selText(selCur),
             detail: { from: null, to: selCur, cause: 'baseline' }, sel: selCur });
      /* A baseline pass: anything already broken when watching starts is
         reported now rather than being blamed on the next operation. */
      check('watch start (baseline)');
      try { global.localStorage.setItem('nso.watch', '1'); } catch (e) {}
      return true;
    },

    stop: function () {
      if (!on) return false;
      flushSelection();
      log('watch', 'info', 'watch off - ' + events.length + ' event(s), ' +
          Object.keys(openF).length + ' mismatch(es) still open');
      on = false;
      clearTimers();
      for (var i = restores.length - 1; i >= 0; i--) {
        try { restores[i](); } catch (e) {}
      }
      restores = [];
      task = null; selPending = false;
      var run = currentRun();
      if (run) run.ended = new Date().toISOString();
      flushStore();
      if (el.panel) el.panel.classList.remove('is-on');
      paintButton();
      try { global.localStorage.removeItem('nso.watch'); } catch (e) {}
      if (el.report && el.report.classList.contains('is-on')) renderReport();
      return true;
    },

    toggle: function () { return on ? (api.stop(), false) : (api.start(), true); },
    /* Collapse the panel to its header bar (true) or show the log (false).
       Display only: what is logged and checked does not change. */
    collapse: function (c) {
      c = !!c;
      try { global.localStorage.setItem(COLLAPSE_KEY, c ? '1' : '0'); } catch (e) {}
      applyCollapsed(c);
      return c;
    },
    isCollapsed: function () { return !!(el.panel && el.panel.classList.contains('is-collapsed')); },
    isOn: function () { return on; },

    /* Run the consistency pass now and hand back what it found. */
    check: function (label) { return check(label || 'manual check'); },

    /* Everything seen so far, oldest first. */
    events: function () {
      return events.map(function (e) {
        return { seq: e.seq, time: e.time, iso: e.at.toISOString(), kind: e.kind,
                 level: e.level, phase: e.phase || null, source: e.source || null,
                 category: category(e), msg: e.msg, op: e.op, sel: e.sel || null,
                 detail: e.detail, trail: e.trail };
      });
    },

    /* Mismatches that are open right now. */
    open: function () {
      return Object.keys(openF).map(function (k) {
        return { since: openF[k].time, msg: openF[k].msg, op: openF[k].op };
      });
    },

    summary: function () {
      var by = {};
      events.forEach(function (e) {
        var k = (e.kind === 'phantom') ? ('phantom ' + e.msg.split(' - ')[0].replace('phantom ', ''))
              : category(e);
        by[k] = (by[k] || 0) + 1;
      });
      return { on: on, started: new Date(startedWall).toISOString(),
               events: events.length, dropped: dropped, open: Object.keys(openF).length, by: by };
    },

    report: function () {
      var out = ['# NSO watch log (' + VERSION + ')',
                 '# started ' + new Date(startedWall).toISOString() +
                 (dropped ? ('  (' + dropped + ' older event(s) dropped)') : ''), ''];
      events.forEach(function (e) {
        out.push(e.time + '  ' + e.kind + (e.level && e.level !== 'info' ? '/' + e.level : '') +
                 '  ' + e.msg + (e.kind === 'phantom' ? '   [after ' + e.op + ']' : ''));
      });
      var open = api.open();
      out.push('', '# ' + open.length + ' mismatch(es) still open at export');
      open.forEach(function (o) { out.push('  since ' + o.since + '  ' + o.msg); });
      return out.join('\n');
    },

    /* The persisted history, across runs and reloads: {runs, events, dropped}.
       Events are the stored records - plain JSON, oldest first. */
    stored: function () {
      var st = store || loadStore();
      return JSON.parse(JSON.stringify(st));
    },
    /* Filtered history: {run: id|'all', cat: category|'all', q: text}. */
    query: function (f) { return JSON.parse(JSON.stringify(query(f))); },
    showReport: function () {
      buildReport();
      if (!store) store = loadStore();
      el.report.classList.add('is-on');
      renderReport();
      return true;
    },
    hideReport: function () { if (el.report) el.report.classList.remove('is-on'); },
    copyReport: function () {
      var txt = reportText(query(rf));
      if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function () {});
      }
      return txt;
    },
    /* Forget every stored run. A live run carries on, with a clean slate. */
    clearStored: function () {
      var keep = on ? currentRun() : null;
      store = emptyStore();
      if (keep) { keep.events = 0; store.runs.push(keep); }
      flushStore();
      if (!on) { try { global.localStorage.removeItem(STORE_KEY); } catch (e) {} }
      if (el.report && el.report.classList.contains('is-on')) renderReport();
    },

    /* Console-only, kept for anyone who wants a file: the in-app report is
       the way to browse. */
    save: function () {
      var blob = new Blob([JSON.stringify({
        version: VERSION, started: new Date(startedWall).toISOString(),
        summary: api.summary(), open: api.open(), events: api.events()
      }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'nso-watch-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      global.setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    },

    copy: function () {
      var txt = api.report();
      if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(function () {});
      }
      busy = true;
      try { raw.log.call(console, txt); } catch (e) {}
      busy = false;
      return txt;
    },

    clear: function () {
      events = []; dropped = 0;
      openF = Object.create(null);
      if (el.list) el.list.innerHTML = '';
      counts();
    }
  };

  global.NSOWatch = api;

  /* ---------------- wiring ---------------- */
  function bind() {
    el.btn = document.getElementById('btn-watch');
    buildPanel();
    if (el.btn) {
      var dot = document.createElement('span');
      dot.className = 'nso-watch-dot';
      el.btn.appendChild(dot);
      el.dot = dot;
      el.btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        api.toggle();
      });
    }
    paintButton();
    var wanted = false;
    try { wanted = /[?&]watch=1\b/.test(global.location.search) || global.localStorage.getItem('nso.watch') === '1'; }
    catch (e) {}
    if (wanted) api.start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})(window);
