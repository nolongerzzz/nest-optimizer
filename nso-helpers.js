/* Scene helpers - one registry, one teardown.

   A HELPER is anything a tool draws that is not a piece and not the plate: the
   Cut blade and its plate line, Crop's box and lifted ghost, Bend's ghost and
   marker, Tube edge's ghost and rings, Bridge's picks, line and ghost, Foam's
   preview, Measure's marks, the Check's marks and finding rings, Rotate's rails,
   Move's arrows, the brush ring, the picked-face highlight, and G-scope's lift
   height map and support beacons. Each one is put in the scene through
   nsoHelpers.attach(parent, obj, owner), which tags it, and every one of them is
   held to the same four rules:

     1. REMOVED on leave-tool, on Clear (and Clear plate), and on an Undo that
        goes past the step it was drawn after. The owner's own close path runs
        first, so the tool unwinds the way its button would; whatever is still
        tagged in the scene after that is taken out here.
     2. NEVER SELECTABLE. Its raycast is a no-op unless the tool drags it
        ({ interactive: true }: the blade's grab sheet, Crop's handles, Rotate's
        rings), and a piece pick never resolves to one (pieceHits).
     3. NEVER EXPORTED. exportable() is what every export builder reads off
        state.placed: an entry whose mesh or geometry is a helper's is dropped.
     4. NEVER COUNTED by Watch: nso-watch.js skips isHelper() objects, and reports
        stale() ones - a helper on screen whose tool is not live - as phantoms.

   WHY. Two sightings of the same bug. A Bend session on a tube survived Clear
   (Clear never told Bend), so the next piece loaded got Bend's marker - a
   vertical translucent sheet - through its middle. And an export carried a
   12-triangle slab off a piece's top face: a helper written out as a piece.
   Each tool had its own remove function and its own idea of when to call it;
   nothing said every helper goes on every leave.

   OWNERS. A tool registers how to ask whether its session is live and how to
   end it: owner(name, { live, close, clear, refresh }).
     live()     true while the tool's session is open; left out for a helper
                that belongs to no session (the picked-face highlight), which
                is then cleared on every teardown and never called stale
     close()    the tool's own close path (its Cancel / Close / off button)
     clear()    optional: drop its helpers without ending anything, for helpers
                left behind by a session that is no longer live
     refresh()  optional: redraw from current state, used after an Undo took
                away helpers of a session that stays open
   A helper whose owner has no entry is still tagged, swept and skipped by
   exports and Watch; it just has no session to close.

   Plain classic script, loaded ahead of every app-*.js; nothing here runs
   until a tool calls it. The headless checks load some app files into a bare
   context without it, which is why each owner() registration is guarded. */
(function () {
  var owners = {};        // name -> { live, close, clear, refresh }
  var order = [];         // registration order: the order sessions are closed in
  var attached = new Set();
  var NOOP = function () {};

  function S() { return (typeof state !== 'undefined' && state) ? state : null; }
  function depth() { var s = S(); return s && s.undoStack ? s.undoStack.length : 0; }

  function owner(name, spec) {
    if (!name || !spec) return;
    if (!owners[name]) order.push(name);
    owners[name] = spec;
  }

  function call(fn, what) {
    if (typeof fn !== 'function') return false;
    try { fn(); return true; } catch (err) { console.error('[helpers] ' + what, err); return false; }
  }
  function isLive(name) {
    var o = owners[name];
    if (!o || typeof o.live !== 'function') return false;
    try { return !!o.live(); } catch (e) { return false; }
  }

  /* Tag `obj` and everything under it as `ownerName`'s helper. Idempotent: a
     helper put back in the scene is tagged again, which also restamps the Undo
     depth it was drawn at. */
  function tag(obj, ownerName, opts) {
    if (!obj) return obj;
    var interactive = !!(opts && opts.interactive);
    var name = ownerName || 'helper';
    // A helper that draws a piece's own geometry (none does today) must not
    // mark that geometry: the piece would stop exporting.
    var s = S(), pieceGeo = new Set();
    if (s) {
      (s.models || []).forEach(function (m) { if (m && m.geometry) pieceGeo.add(m.geometry); });
      (s.placed || []).forEach(function (p) { if (p && p.geometry) pieceGeo.add(p.geometry); });
    }
    obj.userData.nsoHelper = name;
    obj.userData.nsoHelperDepth = depth();
    obj.userData.nsoHelperInteractive = interactive;
    obj.traverse(function (o) {
      o.userData.nsoHelper = name;
      if (!interactive) o.raycast = NOOP;
      if (o.geometry && o.geometry.userData && !pieceGeo.has(o.geometry)) o.geometry.userData.nsoHelper = name;
    });
    return obj;
  }

  /* The one way a helper enters the scene: tagged, then added. */
  function attach(parent, obj, ownerName, opts) {
    if (!parent || !obj) return obj;
    tag(obj, ownerName, opts);
    if (obj.parent !== parent) parent.add(obj);
    attached.add(obj);
    return obj;
  }

  function isHelper(obj) {
    for (var o = obj; o; o = o.parent) if (o.userData && o.userData.nsoHelper) return true;
    return false;
  }
  function ownerOf(obj) {
    for (var o = obj; o; o = o.parent) if (o.userData && o.userData.nsoHelper) return o.userData.nsoHelper;
    return null;
  }

  function disposeTree(obj) {
    obj.traverse(function (o) {
      if (o.isSprite) { if (o.material) o.material.dispose(); return; }   // THREE's shared quad
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
        else o.material.dispose();
      }
    });
  }

  /* Every tagged helper still in a scene, top-most only. */
  function live() {
    var out = [];
    attached.forEach(function (o) {
      if (!o.parent) { attached.delete(o); return; }
      for (var p = o.parent; p; p = p.parent) if (p.userData && p.userData.nsoHelper) return;
      out.push(o);
    });
    // Tagged by hand rather than through attach (app-seat-grid.js) - found by
    // walking the main scene.
    var s = S();
    if (s && s.scene) {
      (function walk(n) {
        for (var i = 0; i < n.children.length; i++) {
          var c = n.children[i];
          if (c.userData && c.userData.nsoHelper) { if (out.indexOf(c) < 0) out.push(c); continue; }
          walk(c);
        }
      })(s.scene);
    }
    return out;
  }

  function sweep(list) {
    var n = 0;
    list.forEach(function (o) {
      if (!o.parent) { attached.delete(o); return; }
      o.parent.remove(o);
      attached.delete(o);
      disposeTree(o);
      n++;
    });
    return n;
  }

  /* LEAVE-TOOL, CLEAR, CLEAR PLATE: every live session closed through its own
     close path, every helper left behind cleared by its owner, then whatever
     is still tagged anywhere taken out. Returns what it did, for the checks. */
  function teardown(reason) {
    var closed = [];
    order.forEach(function (name) {
      if (isLive(name) && call(owners[name].close, name + '.close(' + reason + ')')) closed.push(name);
    });
    var left = live();
    var stragglers = {};
    left.forEach(function (o) { stragglers[ownerOf(o)] = true; });
    Object.keys(stragglers).forEach(function (name) {
      if (owners[name]) call(owners[name].clear, name + '.clear(' + reason + ')');
    });
    var swept = sweep(live());
    return { reason: reason, closed: closed, swept: swept };
  }

  /* UNDO: a helper drawn after the step that was just undone shows state that
     no longer exists. Its owner redraws it from what is there now when the
     session is still open and knows how; a session that cannot is closed; a
     helper without a live session is just taken out. */
  function afterUndo() {
    var d = depth();
    var past = live().filter(function (o) { return (o.userData.nsoHelperDepth || 0) > d; });
    if (!past.length) return { swept: 0, refreshed: [], closed: [] };
    var names = {};
    past.forEach(function (o) { names[ownerOf(o)] = true; });
    var refreshed = [], closed = [];
    Object.keys(names).forEach(function (name) {
      var o = owners[name];
      if (!o) return;
      if (isLive(name)) {
        if (typeof o.refresh === 'function') { if (call(o.refresh, name + '.refresh(undo)')) refreshed.push(name); }
        else if (call(o.close, name + '.close(undo)')) closed.push(name);
      } else {
        call(o.clear, name + '.clear(undo)');
      }
    });
    // What a refresh drew is current, including a helper it redrew in place
    // (Rotate's rails, G-scope's layers) rather than put back; anything else
    // still past the stack is stale.
    live().forEach(function (o) {
      if (refreshed.indexOf(ownerOf(o)) >= 0 && (o.userData.nsoHelperDepth || 0) > d) o.userData.nsoHelperDepth = d;
    });
    var swept = sweep(live().filter(function (o) { return (o.userData.nsoHelperDepth || 0) > d; }));
    return { swept: swept, refreshed: refreshed, closed: closed };
  }

  /* Helpers on screen whose tool is not live: what Watch reports. An invisible
     one draws nothing, so it is not on screen. */
  function stale() {
    return live().filter(function (o) {
      var name = ownerOf(o), spec = owners[name];
      // Only a helper with a session can outlive it.
      if (!spec || typeof spec.live !== 'function' || isLive(name)) return false;
      var shown = true;
      for (var p = o; p; p = p.parent) if (p.visible === false) { shown = false; break; }
      return shown;
    });
  }

  /* What an export writes: the plate's entries that are pieces. */
  function exportable(placed) {
    return (placed || []).filter(function (p) {
      if (!p) return false;
      if (p.mesh && isHelper(p.mesh)) return false;
      if (p.geometry && p.geometry.userData && p.geometry.userData.nsoHelper) return false;
      return true;
    });
  }

  /* Ray hits with every helper taken out: what a piece pick may land on. */
  function pieceHits(hits) {
    return (hits || []).filter(function (h) { return !isHelper(h.object); });
  }

  window.nsoHelpers = {
    owner: owner,
    owners: function () { return order.slice(); },
    isLive: isLive,
    tag: tag,
    attach: attach,
    isHelper: isHelper,
    ownerOf: ownerOf,
    live: live,
    stale: stale,
    teardown: teardown,
    afterUndo: afterUndo,
    exportable: exportable,
    pieceHits: pieceHits
  };
})();

/* Overlapping shells - work as is.

   WHY. The kernel unions and subtracts closed solids. A piece that is several
   shells laid through one another (library/box_closed.stl: a tray and a lid
   slab that overlap by 0.1 mm, 74 piercing pairs) is not one solid to it. That
   used to be a refusal ("has overlapping shells; clean it with
   tools/nso_fixture_union first"). Now no verb refuses a piece for it: the
   verbs whose kernel needs a solid - Crop's copy, Subtract B from A, Extract
   bit, the welds of Join / Connect / Bridge, Carve, Attach, Reattach - ask
   solid() first, which unions the piece's shells into one solid FOR THAT
   OPERATION (NSO_shellMergeCore, nso_csg.js: the pass nso_fixture_union makes,
   in the verbs' own kernel). The verb runs on that solid; the piece on the
   plate is not touched by the merge. Crop leaves it as it was; the welds,
   Subtract and Carve replace it with their result, as they always did. The
   readout says so: "box_closed had 2 overlapping shells - merged for this
   operation". The one refusal left is a merge that cannot make a closed solid
   (a shell that is itself open), and it says that in words.

   Verbs that never needed a solid (Scale, Move, Rotate, Tip, Cut, Crop band,
   Lift, Split to parts, Export, G-scope, Detach) do not ask at all.

   THE TEST. NSO_overlapMeasure (nso_csg.js, NSO_Repair._overlapShells): the
   checker's piercing pairs that truly cross - each triangle straddles the
   other's plane by more than 1e-3 mm, so shells that merely touch are contact,
   not overlap - and lie on two different shells. A piece with two or more such
   shells is merged; anything else goes to the kernel as it is. Unknown (no
   checker loaded, no soup) is never a merge.

   ONCE PER PIECE. The measure is kept on the piece's raw soup and the merge on
   the soup it merged (the raw soup, or the drawn geometry's own triangles), in
   WeakMaps: every edit replaces them, and a pose does not change either. A big
   piece (the boolean worker's threshold) is measured and merged in the worker,
   under the bar and Escape. CHECK & REPAIR's MERGE SHELLS (app-findings.js)
   applies the same merge to the piece itself. */
(function () {
  var measured = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var mergedOf = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var localOf = (typeof WeakMap === 'function') ? new WeakMap() : null;

  /* A big piece (the boolean worker's threshold) is not measured on the page's thread: what a plan asks over and
     over as the pointer moves (cachedOnly) takes a big piece's answer only if it is already known. */
  function big(soup) {
    return soup.length / 9 >= (typeof NSO_BoolConfig !== 'undefined' ? NSO_BoolConfig.bigTris : 50000);
  }

  // NSO_overlapMeasure's answer for a raw soup, kept; null when it cannot be asked.
  function measure(soup, cachedOnly) {
    if (!soup || !soup.length) return null;
    if (measured && measured.has(soup)) return measured.get(soup);
    if (cachedOnly && big(soup)) return null;
    if (typeof NSO_overlapMeasure !== 'function') return null;
    var out = NSO_overlapMeasure(soup);
    if (out && measured) measured.set(soup, out);
    return out;
  }

  /* One job for the worker (a big soup) or the page's thread (a small one, or no worker). */
  function job(path, channel, label, files, soup, host, inThread, refuse) {
    if (!big(soup) || typeof NSO_boolRun !== 'function') return Promise.resolve().then(inThread);
    return NSO_boolRun({
      path: path, channel: channel, label: label, host: host || null,
      files: function () { return files; },
      tris: function (a) { return (a[0].length / 9) | 0; },
      refuse: refuse, restore: function (r) { return r; }
    }, [soup], inThread);
  }

  /* The measure, without holding the page. -> the measure, null, or { stopped, cancelled | timedOut }. */
  function measureAsync(soup, host) {
    if (!soup || !soup.length) return Promise.resolve(null);
    if (measured && measured.has(soup)) return Promise.resolve(measured.get(soup));
    return job('NSO_overlapJob', 'bool-check', 'Checking', ['NSO_Repair.js', 'nso_csg.js'], soup, host,
      function () { return measure(soup); },
      function (a, why) { return { stopped: why }; }).then(function (r) {
      if (r && !r.stopped && measured) measured.set(soup, r);
      return r;
    });
  }

  /* The merge of a soup's shells into one solid, kept. -> NSO_shellMergeCore's answer; a stopped one carries
     cancelled / timedOut and is not kept. */
  function merge(soup, host) {
    if (mergedOf && mergedOf.has(soup)) return Promise.resolve(mergedOf.get(soup));
    if (typeof NSO_shellMergeCore !== 'function') return Promise.resolve({ ok: false, reason: 'the boolean kernel is not loaded' });
    return job('NSO_shellMergeJob', 'bool', 'Merging shells', ['nso_csg.js'], soup, host,
      function () { return NSO_shellMergeCore(soup); },
      function (a, why) { return { ok: false, reason: why }; }).then(function (r) {
      if (r && !r.cancelled && !r.timedOut && !/kernel failed to load/.test(String(r.reason || '')) && mergedOf) mergedOf.set(soup, r);
      return r;
    });
  }
  function cachedMerge(soup) {
    var r = soup && mergedOf ? mergedOf.get(soup) : null;
    return r && r.ok ? r.soup : null;
  }

  /* A geometry's own triangles, unindexed, in its local frame - kept per geometry while its positions are the same. */
  function localSoup(g) {
    var pos = g && g.attributes && g.attributes.position;
    if (!pos) return null;
    var k = localOf ? localOf.get(g) : null;
    if (k && k.version === pos.version && k.count === pos.count && k.index === g.index) return k.soup;
    var idx = g.index, n = idx ? idx.count : pos.count, out = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var v = idx ? idx.getX(i) : i;
      out[i * 3] = pos.getX(v); out[i * 3 + 1] = pos.getY(v); out[i * 3 + 2] = pos.getZ(v);
    }
    if (localOf) localOf.set(g, { soup: out, version: pos.version, count: pos.count, index: g.index });
    return out;
  }

  /* A local soup through a mesh's world matrix: what meshToWorldSoup (app-join.js) reads off the same mesh. */
  function toWorld(local, mesh) {
    mesh.updateMatrixWorld(true);
    var e = mesh.matrixWorld.elements, out = new Float32Array(local.length);
    for (var i = 0; i < local.length; i += 3) {
      var x = local[i], y = local[i + 1], z = local[i + 2];
      var w = e[3] * x + e[7] * y + e[11] * z + e[15];
      out[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      out[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      out[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
    }
    return out;
  }
  /* World (Y up) to the plate's Z-up frame, as Bridge and Connect read a piece. */
  function zUp(s) {
    var out = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { out[i] = s[i]; out[i + 1] = -s[i + 2]; out[i + 2] = s[i + 1]; }
    return out;
  }

  function rawOf(m) {
    return (m.rawTris && m.rawAxis === 'zup') ? m.rawTris
      : (typeof getModelRawSoup === 'function' && m.geometry ? getModelRawSoup(m) : m.rawTris);
  }

  function note(name, n) {
    return (name || 'this piece') + ' had ' + n + ' overlapping shells - merged for this operation';
  }
  function cannot(name, n, why) {
    return (name || 'this piece') + ' has ' + n + ' overlapping shells that cannot be merged into one closed solid: ' + why;
  }

  /* The solid a verb hands the kernel, for one model.
       opts.geometry   merge that geometry's own triangles (the frame meshToWorldSoup starts from); with
       opts.mesh       also put the merged soup through that mesh's world matrix (-> world)
       otherwise       merge the model's raw soup (Crop, Attach, Reattach work in it)
     -> Promise of { ok: true, merged: false }                        clean, or cannot be asked: use the piece as it is
                   { ok: true, merged: true, soup, world?, shells, note }   use soup (or world) for this operation
                   { ok: false, reason, cancelled?, timedOut? }       the merge cannot make a closed solid, or was stopped */
  async function solid(model, opts, host) {
    opts = opts || {};
    if (!model) return { ok: true, merged: false };
    var raw = rawOf(model);
    var r = await measureAsync(raw, host);
    if (r && r.stopped) {
      return { ok: false, stopped: true, cancelled: !!r.cancelled, timedOut: !!r.timedOut,
               reason: 'the overlap check ' + (r.timedOut ? 'ran too long and ' : '') + 'was stopped' };
    }
    if (!r || !(r.overlapShells >= 2)) return { ok: true, merged: false };
    var src = opts.geometry ? localSoup(opts.geometry) : raw;
    if (!src) return { ok: true, merged: false };
    var mg = await merge(src, host);
    if (mg.cancelled || mg.timedOut) {
      return { ok: false, stopped: true, cancelled: !!mg.cancelled, timedOut: !!mg.timedOut,
               reason: 'merging ' + (model.name || 'the piece') + '’s overlapping shells ' + (mg.timedOut ? 'ran too long and ' : '') + 'was stopped' };
    }
    if (!mg.ok) return { ok: false, reason: cannot(model.name, r.overlapShells, mg.reason) };
    var out = { ok: true, merged: true, soup: mg.soup, shells: r.overlapShells, note: note(model.name, r.overlapShells) };
    if (opts.mesh) out.world = toWorld(mg.soup, opts.mesh);
    return out;
  }

  /* solid() for several models in turn (each with its own opts): -> { ok, list, note } or the first refusal. */
  async function solids(models, optsOf, host) {
    var list = [], notes = [];
    for (var i = 0; i < models.length; i++) {
      var s = await solid(models[i], optsOf ? optsOf(models[i], i) : null, host);
      if (!s.ok) return s;
      list.push(s);
      if (s.merged) notes.push(s.note);
    }
    return { ok: true, list: list, note: notes.join('; ') };
  }

  /* The count of a piece's overlapping shells, or 0; null when it cannot be asked (Check's row, the drive). */
  function shells(soup, cachedOnly) {
    var r = measure(soup, cachedOnly);
    return r ? (r.overlapShells >= 2 ? r.overlapShells : 0) : null;
  }

  window.nsoOverlap = {
    measure: measure, measureAsync: measureAsync, shells: shells,
    merge: merge, cachedMerge: cachedMerge, localSoup: localSoup, toWorld: toWorld, zUp: zUp,
    solid: solid, solids: solids, note: note
  };
})();
