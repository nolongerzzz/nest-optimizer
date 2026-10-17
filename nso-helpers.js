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

/* Overlap guard - one check before the boolean kernel runs.

   WHY. The kernel unions and subtracts closed solids. A piece that is several
   shells laid over one another (library/box_closed.stl: a tray and a lid slab
   that overlap by 0.1 mm, 74 piercing pairs) is not one solid to it, and what
   comes back is a weld that "would not be closed (N wound the wrong way)" -
   the right refusal, in words that point at the wrong thing. Every verb that
   hands a piece to NSO_unionSoups / NSO_subtractSoups asks here first and
   stands down in words, naming the piece, before anything is built: Bridge,
   Connect (weld), Join, Subtract B from A, Crop Circle / Piece.

   THE TEST. The checker's piercing pairs (NSO_Repair._selfIntersectionDetail,
   the count tools/mesh_validate.py gives), kept only where the two triangles
   truly cross: each one straddles the other's plane by more than CROSS_MM. Shells
   that merely touch (a mark sitting on a bar's face, 0 mm apart) and the
   checker's near-coplanar sliver pairs are contact, not overlap, and the kernel
   unions them; box_closed's 0.1 mm lid overlap is 1e5 times CROSS_MM. A piece
   with any crossing pair is refused, and the sentence quotes the checker's
   count. Counted once per piece: the answer is cached on the piece's raw soup (a
   WeakMap), which every edit replaces, and a pose does not change it. Unknown
   (no checker loaded, no soup) is never a refusal.

   THE REMEDY. Check & Repair -> Repair does NOT merge overlapping shells
   (measured on box_closed.stl: "nothing to repair", 74 -> 74 pairs), so the
   message points at tools/nso_fixture_union. Flip REPAIR_MERGES the day Repair
   can, and the message becomes "run CHECK & REPAIR -> Repair on it first". */
(function () {
  var REPAIR_MERGES = false;
  var CROSS_MM = 1e-3;
  var cache = (typeof WeakMap === 'function') ? new WeakMap() : null;

  // Do triangles fa and fb of mesh m cross, both straddling the other's plane by more than CROSS_MM?
  function crosses(m, fa, fb) {
    function tri(f) {
      var v = [];
      for (var i = 0; i < 3; i++) { var o = m.faces[f * 3 + i] * 3; v.push([m.pos[o], m.pos[o + 1], m.pos[o + 2]]); }
      return v;
    }
    function straddles(T, U) {          // does U straddle T's plane?
      var e1 = [T[1][0] - T[0][0], T[1][1] - T[0][1], T[1][2] - T[0][2]], e2 = [T[2][0] - T[0][0], T[2][1] - T[0][1], T[2][2] - T[0][2]];
      var n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      var L = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      if (!(L > 0)) return false;
      var pos = false, neg = false;
      for (var i = 0; i < 3; i++) {
        var d = ((U[i][0] - T[0][0]) * n[0] + (U[i][1] - T[0][1]) * n[1] + (U[i][2] - T[0][2]) * n[2]) / L;
        if (d > CROSS_MM) pos = true; else if (d < -CROSS_MM) neg = true;
      }
      return pos && neg;
    }
    var A = tri(fa), B = tri(fb);
    return straddles(A, B) && straddles(B, A);
  }

  // { pierce, crossing } for a raw soup: the checker's pairs, and those that truly cross; null when it cannot be asked.
  function measure(soup) {
    if (!soup || !soup.length) return null;
    if (cache && cache.has(soup)) return cache.get(soup);
    if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair._selfIntersectionDetail !== 'function' ||
        typeof NSO_Repair._weldToIndexed !== 'function') return null;
    var out;
    try {
      var mesh = NSO_Repair._weldToIndexed(soup, NSO_Repair.WELD_TOL).mesh;
      var d = NSO_Repair._selfIntersectionDetail(mesh, { collect: true });
      out = { pierce: d.pierce, crossing: 0 };
      for (var i = 0; i < d.pairs.length; i++) {
        if (d.pairs[i].kind === 'pierce' && crosses(mesh, d.pairs[i].a, d.pairs[i].b)) out.crossing++;
      }
    } catch (e) { return null; }
    if (cache) cache.set(soup, out);
    return out;
  }

  // The checker's piercing-pair count when the piece has overlapping shells, else 0; null when it cannot be asked.
  function pairs(soup) {
    var r = measure(soup);
    return r ? (r.crossing > 0 ? r.pierce : 0) : null;
  }

  function sentence(name, n) {
    return (name || 'this piece') + ' has overlapping shells (' + n + ' piercing pair' + (n === 1 ? '' : 's') + '); ' +
      (REPAIR_MERGES ? 'run CHECK & REPAIR \u2192 Repair on it first' : 'clean it with tools/nso_fixture_union first');
  }

  /* items: [{ name, soup }] - the pieces about to go to the kernel. '' when
     every one is a clean solid, else the sentence for the first that is not. */
  function refusal(items) {
    for (var i = 0; i < (items || []).length; i++) {
      var it = items[i], n = it ? pairs(it.soup) : null;
      if (n > 0) return sentence(it.name, n);
    }
    return '';
  }

  /* The same, for models off state.models (name, raw soup). */
  function refusalOfModels(models) {
    return refusal((models || []).map(function (m) {
      if (!m) return null;
      var soup = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris
        : (typeof getModelRawSoup === 'function' && m.geometry ? getModelRawSoup(m) : m.rawTris);
      return { name: m.name, soup: soup };
    }));
  }

  window.nsoOverlap = { pairs: pairs, refusal: refusal, refusalOfModels: refusalOfModels, repairMerges: REPAIR_MERGES };
})();
