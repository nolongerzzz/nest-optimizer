/*
 * Split to parts - the SUBTRACT card's SPLIT TO PARTS verb, beside Lift.
 * The app side of nso_split_parts.js (THREE-free, node-tested: npm run
 * split:parts). After app-core.js, nso_hollow.js, nso_split_parts.js.
 * ----------------------------------------------------------------------------
 *
 * A piece made of several shells - the print-in-place hinge a Lift hands over,
 * any imported multi-body STL - becomes one piece per part. A part is an outer
 * shell plus the cavity shells inside it (a hollow stays with its outer);
 * touching-but-separate shells are separate parts. The engine says which.
 *
 * THE READOUT comes BEFORE the button. Selecting a piece reads it (once per
 * soup, cached) and the card says "1 part" or "3 parts" beside the button, and
 * in words under it. A piece of one part is refused when the button is pressed,
 * with the reason, and nothing changes.
 *
 * WHAT A SPLIT DOES. Each part becomes an ordinary piece named
 * "<piece> part 1" .. "<piece> part n" (Pieces list, Move, Join, Export,
 * Remove, grab and drop). It takes the original's pose and sits exactly where
 * the original drew those triangles - every triangle bit for bit as it was -
 * so a part that was resting above the bed is left in the air (liftY, the
 * floating state app-grab-drop.js describes) until grabbed and dropped or sent
 * To plate. The original piece leaves the plate and the Pieces list. One
 * 'featureSwap' Undo step (Mold's and Detach's) puts it back where it was in
 * both, and selects it again.
 *
 * SELECTION. The app has ONE selection (state.selectedIndex), not a set, so
 * "select all the parts" is not something it can hold. Part 1 is selected and
 * the readout names all of them; they are the last rows of the Pieces list.
 *
 * PAINT SCOPE: WHOLE-PIECE, per the scoping rule in docs/HANDOFF.md. The
 * original's soup is replaced by several new ones, so no painted face could be
 * held still. nsoMaskCount(m) > 0 stands it down and names the count.
 *
 * NON-SOLID SCOPE: not read. A part is exactly the triangles of its shells; if
 * the source was open, the part is open, and the split does not hide that.
 */
/* global THREE, state, setStatus, addModel, placeModelMovable, pushUndo, applyMeshRotation,
          meshLocalBox3, nsoMaskCount, rawResultToDisplayGeometry, computeCenterOffsetFromRaw,
          renderModelList, updateOptimizeButton, updateEditSize, updateAdjustUI, selectPlaced */
'use strict';

var NSO_SPLIT_PARTS = (function () {
  var busy = false;
  var cache = new WeakMap();               // soup -> engine analysis
  var token = 0, shown = null;
  var hold = null;                        // { id, text }: the last result, kept on the card while that piece stays selected

  function SP() { return typeof window !== 'undefined' ? window.NSO_SplitParts : null; }
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function f2(x) { return (+x).toFixed(2); }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }
  function placedOf(id) { return (state.placed || []).find(function (p) { return p && p.sourceId === id; }) || null; }

  function sayCard(msg, bad) {
    var r = $('split-readout');
    if (r) { r.textContent = msg; r.classList.toggle('carve-bad', !!bad); }
  }
  function say(msg, bad) {
    sayCard(msg, bad);
    if (typeof setStatus === 'function') setStatus(msg, !!bad);
  }
  function fail(msg) { say(msg, true); return { ok: false, reason: msg }; }

  /** The selected piece and its record, or null. */
  function target() {
    var p = state.placed && state.placed[state.selectedIndex];
    if (!p || p.sourceId == null) return null;
    var m = modelOf(p.sourceId);
    return m ? { m: m, p: p } : null;
  }

  /** Why this piece cannot be split, in words; null when it can. */
  function refusalFor(m, p) {
    if (!SP()) return 'Split to parts needs nso_split_parts.js - nothing changed.';
    if (!m || !p) return 'Split to parts works on a piece on the plate - select one. Nothing changed.';
    if (m.nsoSupport) return 'Split to parts stood down - "' + m.name + '" is a support, made for the piece it holds up. Nothing changed.';
    if (!(m.rawTris && m.rawAxis === 'zup')) {
      return 'Split to parts needs a raw piece - "' + m.name + '" has no untransformed soup. Nothing changed.';
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return 'Split to parts stood down - ' + painted + ' painted face(s) on "' + m.name + '"; the parts are new soups and ' +
        'cannot hold a face still. Clear paint to split.';
    }
    var g = p.mesh && p.mesh.geometry, pos = g && g.attributes && g.attributes.position;
    if (!pos || g.index || pos.count * 3 !== m.rawTris.length) {
      return 'Split to parts: "' + m.name + '" on the plate does not match its own mesh - nothing changed.';
    }
    return null;
  }

  /** The engine's read of a soup, once per soup. */
  function read(soup) {
    var a = cache.get(soup);
    if (!a) {
      try { a = SP().analyse(soup); }
      catch (err) { console.error('[split-parts]', err); a = { ok: false, parts: [], words: '', reason: 'Could not read the piece (' + ((err && err.message) || err) + ').' }; }
      cache.set(soup, a);
    }
    return a;
  }

  // =========================================================================
  // The card: the count and the readout, before the button is pressed
  // =========================================================================

  function paint(count, text, bad, canPress) {
    var c = $('split-count');
    if (c) c.textContent = count;
    var b = $('btn-split-parts');
    if (b) b.disabled = !canPress || busy;
    if (!busy) sayCard(text, bad);
  }

  /** Read the selected piece and say what it is. The read is deferred a tick
      when it has not been made yet, so selecting a large mesh is not held up
      by it, and dropped if the selection moved on meanwhile. */
  function refresh() {
    if (busy) return;
    var t = target();
    if (!t) { shown = null; paint('—', 'Select a piece to see how many parts it is.', false, false); return; }
    var why = refusalFor(t.m, t.p);
    if (why) { shown = null; paint('—', why, false, false); return; }
    if (hold && hold.id !== t.m.id) hold = null;
    var a = cache.get(t.m.rawTris);
    if (!a) {
      var my = ++token;
      paint('…', 'Reading ' + t.m.name + ' ...', false, false);
      setTimeout(function () {
        if (my !== token) return;
        var t2 = target();
        if (!t2 || t2.m.rawTris !== t.m.rawTris) return refresh();
        read(t2.m.rawTris);
        refresh();
      }, 0);
      return;
    }
    token++;
    shown = { id: t.m.id, soup: t.m.rawTris };
    paint(a.words, hold ? hold.text : a.ok ? SP().describe(a) + ' - Split to parts makes one piece of each.' : a.reason, false, true);
  }

  // =========================================================================
  // The verb
  // =========================================================================

  /** Take pieces off the plate and out of the list, keeping what Undo needs to
      put each back where it was. No undo step of its own. */
  function takeOff(ids) {
    var drop = new Set(ids), removed = [];
    state.placed.forEach(function (p, i) { if (p && drop.has(p.sourceId)) removed.push({ placed: p, placedIndex: i }); });
    removed.forEach(function (r) {
      r.model = modelOf(r.placed.sourceId);
      r.modelIndex = state.models.indexOf(r.model);
    });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    return removed;
  }

  /** Put a part where it stood on `host`: the host's pose, and the mesh where
      the host draws those same raw triangles. Both soups are in the host's raw
      frame; each display mesh is its soup turned (raw (x, y, z) -> (x, z, -y))
      and centred on its own box, so the part's origin is the host's moved by
      the difference of the two centres, carried through the host's rotation.
      The height above the bed is what it is - liftY records it, counted from
      the host's. (The placement app-lift-plate.js gives a lifted feature.) */
  function landInPlace(entry, made, hostModel, host, hostBottom) {
    if (!host || !host.mesh) return null;
    ['rotY', 'rotated', 'flipX', 'tipX', 'tipZ', 'tiltX', 'tiltZ'].forEach(function (k) { entry[k] = host[k]; });
    entry.liftY = 0;
    applyMeshRotation(entry);
    var cH = hostModel.centerOffset, cN = made.centerOffset;
    host.mesh.updateMatrixWorld(true);
    var at = host.mesh.localToWorld(new THREE.Vector3(cN.x - cH.x, cN.y - cH.y, cN.z - cH.z));
    entry.mesh.quaternion.copy(host.mesh.quaternion);
    entry.mesh.position.copy(at);
    entry.mesh.updateMatrixWorld(true);
    entry.x = at.x; entry.z = at.z;
    /* Its height is the host's plus how much higher this part's lowest point
       is than the host's: the lowest part stays as low as the host was. */
    var lift = (host.liftY || 0) + meshLocalBox3(entry.mesh).min.y - hostBottom;
    entry.liftY = lift > 1e-6 ? lift : 0;
    return { x: at.x, y: at.y, z: at.z, liftY: entry.liftY };
  }

  function split() {
    if (busy) return { ok: false, reason: 'busy' };
    var t = target();
    if (!t) return fail('Split to parts: select a piece on the plate first. Nothing changed.');
    var m = t.m, host = t.p;
    var why = refusalFor(m, host);
    if (why) return fail(why);
    busy = true;
    var added = [];
    try {
      var r = SP().split(m.rawTris);
      if (!r.ok) return fail(r.reason);

      /* The parts first, so a failure to add one leaves the plate alone. */
      var names = [];
      for (var i = 0; i < r.parts.length; i++) {
        var pc = r.parts[i], name = (m.name || 'piece') + ' part ' + (i + 1);
        var id = addModel(name, rawResultToDisplayGeometry(pc.soup), {
          rawTris: pc.soup, rawAxis: 'zup', centerOffset: computeCenterOffsetFromRaw(pc.soup),
          keepSelection: true, silent: true
        });
        if (id == null) {
          takeOff(added);
          state.selectedIndex = state.placed.indexOf(host);
          return fail('Split to parts refused - nothing changed: part ' + (i + 1) + ' is too small to be a piece (under 0.1 mm across one way).');
        }
        added.push(id); names.push(name);
      }

      /* Each part exactly where it stood in the original, as it is drawn now. */
      var spots = [], hostBottom = meshLocalBox3(host.mesh).min.y;
      added.forEach(function (id2) {
        var made = modelOf(id2), entry = placeModelMovable(made, host.x, host.z);
        spots.push(entry ? landInPlace(entry, made, m, host, hostBottom) : null);
      });

      /* The original leaves, in the list and on the plate. */
      var removed = takeOff([m.id]);
      if (state.editId === m.id) state.editId = null;
      if (state.joinPartnerId === m.id) state.joinPartnerId = null;
      if (state.joinThirdId === m.id) { state.joinThirdId = null; state.joinFaceC = null; }
      var hostId = m.id, hostName = m.name;
      pushUndo({ type: 'featureSwap', replace: null, addedIds: added.slice(), removed: removed,
        label: 'Undo: Split to parts reverted',
        onUndone: function () {
          var i2 = state.placed.findIndex(function (p) { return p && p.sourceId === hostId; });
          if (i2 >= 0 && typeof selectPlaced === 'function') selectPlaced(i2);
          shown = null;
          hold = null;
          refresh();
          say('Undo: Split to parts reverted - ' + hostName + ' is back as one piece, selected.');
        } });

      var first = state.placed.findIndex(function (p) { return p && p.sourceId === added[0]; });
      if (first >= 0 && typeof selectPlaced === 'function') selectPlaced(first);
      if (typeof renderModelList === 'function') renderModelList();
      if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
      if (typeof updateEditSize === 'function') updateEditSize();
      if (typeof updateAdjustUI === 'function') updateAdjustUI();

      var up = spots.filter(function (s) { return s && s.liftY > 0; });
      var txt = 'Split ' + hostName + ' into ' + r.parts.length + ' parts: ' + names.map(function (n) { return '"' + n + '"'; }).join(', ') +
        ' - ' + r.parts.map(function (p) { return p.tris; }).join(' + ') + ' = ' + r.tris + ' triangles, every one as it was, each where it stood' +
        (r.cavities ? ', ' + (r.cavities === 1 ? 'a hollow' : r.cavities + ' hollows') + ' kept with the part it is in' : '') + '.' +
        (up.length ? ' ' + (up.length === r.parts.length ? 'They are' : up.length + ' are') + ' in the air over the bed' +
          (up.length === 1 ? ' (' + f2(up[0].liftY) + ' mm)' : '') + ', and stay there until dropped or sent To plate.' : '') +
        ' "' + names[0] + '" is selected; grab any part to move it. One Undo (Ctrl+Z) puts ' + hostName + ' back.';
      busy = false;
      shown = null;
      hold = added.length ? { id: added[0], text: txt } : null;
      refresh();
      say(txt);
      return { ok: true, addedIds: added, names: names, hostId: hostId, spots: spots, parts: r.parts.map(function (p) { return { tris: p.tris, shells: p.shells, cavities: p.cavities }; }), reason: txt };
    } catch (err) {
      console.error('[split-parts]', err);
      if (added.length && placedOf(m.id)) { takeOff(added); state.selectedIndex = state.placed.indexOf(host); }
      return fail('Split to parts failed - nothing changed (' + ((err && err.message) || err) + ')');
    } finally {
      busy = false;
      var b = $('btn-split-parts');
      if (b) b.disabled = !target();
    }
  }

  // =========================================================================
  // Wiring
  // =========================================================================

  function wrap(name) {
    var prev = window[name];
    if (typeof prev !== 'function' || prev._nsoSplitWrapped) return;
    var wrapped = function () {
      var out = prev.apply(this, arguments);
      try { refresh(); } catch (err) { console.error('[split-parts]', err); }
      return out;
    };
    wrapped._nsoSplitWrapped = true;
    window[name] = wrapped;
  }

  function mount() {
    var b = $('btn-split-parts');
    if (b && b.dataset.wired !== '1') { b.dataset.wired = '1'; b.addEventListener('click', function () { split(); }); }
    wrap('selectPlaced');
    wrap('renderModelList');
    refresh();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    split: split,
    refresh: refresh,
    read: function (soup) { return read(soup); },
    refusalFor: refusalFor,
    shown: function () { return shown; }
  };
})();

if (typeof window !== 'undefined') window.NSO_SPLIT_PARTS = NSO_SPLIT_PARTS;
