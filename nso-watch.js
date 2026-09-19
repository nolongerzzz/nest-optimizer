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

  var VERSION = 'watch1';
  var MAX_EVENTS = 4000;
  /* An operation is checked more than once: a bake is synchronous, but Join
     and Subtract resolve a promise, and a few paths finish inside a rAF. The
     same finding is only ever reported once, so the extra passes cost nothing
     but catch the late ones. */
  var CHECK_DELAYS = [0, 150, 700, 2000];
  var IDLE_MS = 4000;          // sweep, for anything not driven by a click
  var OP_HISTORY = 6;

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
    ev.seq = ++seqN;
    ev.at = new Date();
    ev.time = clock(ev.at);
    ev.op = ev.op || opLabel();
    events.push(ev);
    if (events.length > MAX_EVENTS) { events.shift(); dropped++; }
    row(ev);
    counts();
    echo(ev);
    return ev;
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
          var refusal = (isError === true) || REFUSAL.test(txt);
          log('status', refusal ? 'refusal' : 'info', txt);
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

  /* ---------------- watcher 2: rendered scene vs logical state ---------------- */
  function installConsistency() {
    /* pushUndo is the app's own record that something changed: every
       mutating operation - bake, split, join, subtract, paint, clone,
       delete, and the end of a drag - pushes one, and its `type` is the
       app's own name for what just happened. Reading the operation label off
       that beats guessing it from a button. */
    wrapGlobal('pushUndo', function (orig) {
      return function (entry) {
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
        markOp('set ' + t.id + '=' + shorten(t.value, 24));
      } catch (e) {}
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    restores.push(function () {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
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
    '#nso-watch-panel{position:absolute;left:12px;bottom:68px;width:min(420px,calc(100% - 24px));',
    'max-height:46vh;display:none;flex-direction:column;z-index:120;pointer-events:auto;',
    'background:rgba(9,12,18,.95);border:1px solid #3a4558;border-radius:10px;',
    'box-shadow:0 6px 24px rgba(0,0,0,.55);backdrop-filter:blur(8px);color:#e5edf7;',
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '#nso-watch-panel.is-on{display:flex}',
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
    '#btn-watch .nso-watch-dot.is-on{display:block}'
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
        '<button type="button" id="nso-watch-save">Save</button>' +
        '<button type="button" id="nso-watch-copy">Copy</button>' +
        '<button type="button" id="nso-watch-clear">Clear</button>' +
      '</div>' +
      '<div id="nso-watch-list"></div>';
    host.appendChild(p);
    el.panel = p;
    el.list = p.querySelector('#nso-watch-list');
    el.nPhantom = p.querySelector('#nso-watch-n-phantom');
    el.nError = p.querySelector('#nso-watch-n-error');
    p.querySelector('#nso-watch-save').addEventListener('click', function () { api.save(); });
    p.querySelector('#nso-watch-copy').addEventListener('click', function () { api.copy(); });
    p.querySelector('#nso-watch-clear').addEventListener('click', function () { api.clear(); });
  }

  function row(ev) {
    if (!el.list) return;
    var kind = (ev.level === 'refusal') ? 'refusal' : ev.kind;
    var d = document.createElement('div');
    d.className = 'nso-watch-row k-' + kind;
    var t = document.createElement('time');
    t.textContent = ev.time;
    var s = document.createElement('span');
    s.textContent = ev.msg;
    d.appendChild(t);
    d.appendChild(s);
    if (ev.kind === 'phantom') {
      var o = document.createElement('span');
      o.className = 'op';
      o.textContent = 'after ' + ev.op;
      d.appendChild(o);
    }
    var stick = el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 24;
    el.list.appendChild(d);
    while (el.list.childElementCount > 400) el.list.removeChild(el.list.firstChild);
    if (stick) el.list.scrollTop = el.list.scrollHeight;
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
      on = true;
      buildPanel();
      if (el.panel) el.panel.classList.add('is-on');
      if (el.list) el.list.innerHTML = '';
      installLogger();
      installConsistency();
      paintButton();
      log('watch', 'info', 'watch on - ' + VERSION + ' - error/status log and state-consistency checks are live');
      /* A baseline pass: anything already broken when watching starts is
         reported now rather than being blamed on the next operation. */
      check('watch start (baseline)');
      try { global.localStorage.setItem('nso.watch', '1'); } catch (e) {}
      return true;
    },

    stop: function () {
      if (!on) return false;
      log('watch', 'info', 'watch off - ' + events.length + ' event(s), ' +
          Object.keys(openF).length + ' mismatch(es) still open');
      on = false;
      clearTimers();
      for (var i = restores.length - 1; i >= 0; i--) {
        try { restores[i](); } catch (e) {}
      }
      restores = [];
      if (el.panel) el.panel.classList.remove('is-on');
      paintButton();
      try { global.localStorage.removeItem('nso.watch'); } catch (e) {}
      return true;
    },

    toggle: function () { return on ? (api.stop(), false) : (api.start(), true); },
    isOn: function () { return on; },

    /* Run the consistency pass now and hand back what it found. */
    check: function (label) { return check(label || 'manual check'); },

    /* Everything seen so far, oldest first. */
    events: function () {
      return events.map(function (e) {
        return { seq: e.seq, time: e.time, iso: e.at.toISOString(), kind: e.kind,
                 level: e.level, msg: e.msg, op: e.op, detail: e.detail, trail: e.trail };
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
              : (e.level === 'refusal') ? 'refusal' : e.kind;
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
