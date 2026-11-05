/* app-assemble.js - Attach: the one guided flow from "a blank" to "one solid".
 *
 * Pick a shape on the Stock shelf (Gen+ > Stock), open the CONNECT card, press
 * Attach under its Set / Cancel row, and click the point on a piece where a
 * blank of that shape should go. The blank is generated at the shelf's default
 * size, auto-aim works out
 * which way it leaves that point, nso_assemble.js seats it, and app-join.js's
 * union makes the two into one piece. Nothing is left on the plate to tidy up
 * and no tool-hopping is required: before this the same result took New stock,
 * then a pose by hand, then Start Join, then two slot picks, then Complete
 * Join - and got the seat wrong on any curved face.
 *
 * WHERE THE BUTTON IS. btn-stock-attach lives in the Connect card (index.html,
 * under Set / Cancel), because Attach is the same act as Connect - a thing
 * made at a point you click on a piece - and because the Stock card is a shelf
 * of tiles with no button on it (app-stock.js). The shape is the one LAST
 * CLICKED on the shelf (nsoStockShelf.lastShape); with none clicked yet the
 * button refuses to arm and says where to click. Escape disarms. So do Cancel,
 * and closing the Connect card - the button is inside it, and a mode must not
 * be left lit where it cannot be seen. While armed, Connect's own anchor picks
 * stand down (app-connect.js asks state.attachArmed): the click is Attach's.
 * Through nsoAttachAt the blank can still be stated outright - { shape,
 * height, radius, wall, waste, ratio, ... } - which is how the drive checks
 * size theirs.
 *
 * Thin on purpose, like app-stock.js and app-hollow.js. Every measurement is
 * in nso_assemble.js (THREE-free, node-tested); the union is app-join.js's;
 * the sizing is nso_stock.js's; the commit is app-sculpt.js's. What is here
 * is only what can be done in the app: arm a click, turn a raycast hit into
 * the piece's own raw frame, and commit.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DIRECTION COMES FROM, and why the app has to supply it
 * ---------------------------------------------------------------------------
 * nso_support_aim.js answers "given a point out in space, where is the foot
 * and which way". It cannot answer "given this point on the body, which way
 * is out": closestOnSoup returns a point and a distance, with no triangle
 * index and no normal, and nothing in that module exposes one. So an
 * attachment point picked by hand needs its outward direction from somewhere
 * else - and the raycast that found the point already carries it, as
 * hit.face.normal in the piece's own object space. That is the direction
 * handed to attach(), and auto-aim then does what it is good at: it finds the
 * real foot for that aim, and it refuses when the straight line out is
 * blocked. The two answers are cross-checked - attach() refuses when the foot
 * it finds and the point that was clicked are further apart than the blank is
 * wide, which is the case where the click and the aim mean different places.
 *
 * ---------------------------------------------------------------------------
 * THE RAW FRAME, not the world
 * ---------------------------------------------------------------------------
 * Everything below the click happens in the piece's own raw soup, the way
 * Thicken, Extend, Fatten and Hollow all work, so the result commits through
 * NSO_sculptCommitRaw with no pose arithmetic and the scene and the file agree
 * by construction. The click arrives in world space, so it is converted once,
 * through app-mask.js's own raw <-> local mapping (nsoRawFrameOf /
 * nsoRawPointFromLocal / nsoRawDirFromLocal). Those are app-mask's, exported
 * rather than copied: this app already carries two copies of that eight-line
 * mapping and a third is how they start to disagree.
 *
 * PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md, the
 * question is whether the feature acts on an identifiable sub-region. It does
 * not: the union hands back a wholly new soup with its own triangles in its
 * own order, and no face of the old piece survives as itself - the face that
 * was clicked least of all, since the arm is cut into it. There is no
 * sub-region to scope the check to, which makes whole-piece the only coherent
 * reading, exactly as it is for Fusion, Seat here, Smooth and Thicken.
 * nsoMaskCount(m) is the whole test and any paint anywhere stands it down.
 */
(function () {
  'use strict';

  var busy = false;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  function shelfShape() {
    return (window.nsoStockShelf && typeof window.nsoStockShelf.lastShape === 'function') ? window.nsoStockShelf.lastShape() : null;
  }

  function setArmed(on) {
    if (on) {
      /* Nothing to generate until a shape has been clicked on the shelf. */
      if (!shelfShape()) {
        state.attachArmed = false;
        say('Attach needs a shape - click one on the Stock shelf (Gen+ > Stock) first', true);
        return;
      }
    }
    state.attachArmed = !!on;
    var btn = $('btn-stock-attach');
    if (btn) {
      btn.setAttribute('aria-pressed', state.attachArmed ? 'true' : 'false');
      btn.classList.toggle('is-armed', state.attachArmed);
    }
    if (!state.attachArmed) { say('Attach off'); return; }
    /* Disarm the other click-owning modes, the way Seat here and Measure do -
       by clicking their own buttons, so a mode is never left lit and dead. */
    if (state.maskPaint) {
      var pb = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (pb) pb.click();
    }
    if (state.carveArmed) { var cb = $('btn-carve'); if (cb) cb.click(); else state.carveArmed = false; }
    if (state.measureOn) { var mb = $('btn-measure'); if (mb) mb.click(); else state.measureOn = false; }
    if (state.seatHereArmed && typeof window.nsoSeatHereDisarm === 'function') window.nsoSeatHereDisarm();
    if (state.centerLockArmed) {
      var clb = $('btn-center-lock-pick');
      if (clb) clb.click(); else state.centerLockArmed = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    /* The click is Attach's now: Connect's picks, and the hover that goes with
       them, are dropped (and it stays out of the way until Attach is off). */
    if (typeof NSO_connectClearPicks === 'function') {
      NSO_connectClearPicks();
      if (typeof NSO_connectUI === 'function') {
        NSO_connectUI().hover = null;
        if (typeof NSO_connectDrawPicks === 'function') NSO_connectDrawPicks();     // the hover light goes too
      }
    }
    say('Attach armed - click the point on a piece where the ' + shelfShape() + ' blank should attach. ' +
        'Escape or Attach again to stop.');
  }

  /* Exposed for the Connect card, which disarms it on Cancel and on closing. */
  window.nsoAttachDisarm = function () { if (state.attachArmed) setArmed(false); };

  function hitPiece(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null || !hits[i].face) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = (obj && obj.userData) ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null) {
        return { hit: hits[i], index: idx, placed: state.placed[idx] };
      }
    }
    return null;
  }

  /* app-core's onCanvasPointerDown asks this before it starts a move drag -
     the same contract app-mask.js, app-carve.js and app-seat-surface.js have. */
  window.nsoAttachTakesClick = function (event) {
    if (!state.attachArmed || !event || event.button !== 0) return false;
    var t = hitPiece(event);
    if (!t) return false;
    if (busy) { say('Attach: the last attach is still running - one at a time', true); return true; }
    if (typeof selectPlaced === 'function') selectPlaced(t.index);
    var n = t.hit.face.normal;
    window.nsoAttachAt(t.placed, [t.hit.point.x, t.hit.point.y, t.hit.point.z],
                       [n.x, n.y, n.z], null);
    return true;
  };

  /* The click point and the clicked face's normal, in the piece's OWN raw
     axes. hit.face.normal is already in the mesh's object space; the point is
     not, so it goes through worldToLocal first, which carries whatever pose
     the piece is in. */
  function rawPickFrom(m, mesh, worldPoint, localNormal) {
    if (typeof window.nsoRawFrameOf !== 'function' ||
        typeof window.nsoRawPointFromLocal !== 'function' ||
        typeof window.nsoRawDirFromLocal !== 'function') {
      return { error: 'Attach needs app-mask.js - its raw <-> local mapping is the one this ' +
        'app has, and a second copy here is how two copies start to disagree' };
    }
    var f = window.nsoRawFrameOf(m);
    if (!f) return { error: 'Attach needs a raw piece - that one has no untransformed soup' };
    mesh.updateMatrixWorld(true);
    var lp = mesh.worldToLocal(new THREE.Vector3(worldPoint[0], worldPoint[1], worldPoint[2]));
    var ln = new THREE.Vector3(localNormal[0], localNormal[1], localNormal[2]);
    if (ln.lengthSq() < 1e-12) return { error: 'that face has no usable normal to attach along' };
    ln.normalize();
    return {
      at: window.nsoRawPointFromLocal(f, [lp.x, lp.y, lp.z]),
      dir: window.nsoRawDirFromLocal([ln.x, ln.y, ln.z])
    };
  }

  /* Reattach (app-detach.js) converts its click the same way. Exported, not
     copied, for the reason this function's own comment gives. */
  window.nsoAttachRawPick = rawPickFrom;

  /* One attach. Async, because the boolean loads a WASM kernel. Exposed on
     window so the drive check runs the same path the click runs rather than a
     parallel copy of it, exactly as app-stock.js exposes nsoStockShelf.drop. */
  window.nsoAttachAt = function (placed, worldPoint, localNormal, overrides) {
    if (busy) return Promise.resolve({ ok: false, reason: 'busy' });
    busy = true;
    return runAttach(placed, worldPoint, localNormal, overrides)
      .catch(function (err) {
        console.error('[attach]', err);
        say('Attach failed - nothing changed (' + ((err && err.message) || err) + ')', true);
        return { ok: false, reason: (err && err.message) || String(err) };
      })
      .then(function (r) { busy = false; return r; });
  };

  function fail(reason, bad) { say(reason, bad !== false); return { ok: false, reason: reason }; }

  async function runAttach(placed, worldPoint, localNormal, overrides) {
    if (typeof NSO_Assemble === 'undefined' || !NSO_Assemble) return fail('Attach needs nso_assemble.js');
    if (typeof NSO_Stock === 'undefined' || !NSO_Stock) return fail('Attach needs nso_stock.js');
    if (typeof NSO_unionSoups !== 'function') return fail('Attach needs app-join.js for the union');
    if (!placed || !placed.mesh || placed.sourceId == null) return fail('Attach: nothing was clicked');

    var m = state.models.find(function (x) { return x && x.id === placed.sourceId; });
    if (!m) return fail('Attach: that piece is not in the model list');
    if (!(m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9)) {
      return fail('Attach needs a raw piece - "' + m.name + '" has no untransformed soup to attach to');
    }

    /* PAINT SCOPE: WHOLE-PIECE - see the header. The union replaces every
       triangle, so there is no face this could promise to leave alone. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return fail('Attach stood down - ' + painted + ' painted face(s); the union replaces ' +
        'every triangle on the piece and cannot hold a face still. Clear paint to attach.');
    }
    /* Work as is (nso-helpers.js, nsoOverlap): a piece whose shells overlap is attached to as those shells
       merged into one solid, in the same raw frame; the union replaces the piece, as it always did. */
    var sol = (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? await nsoOverlap.solid(m) : { ok: true, merged: false };
    if (!sol.ok) return fail(sol.cancelled ? 'Attach stopped - piece unchanged' : 'Attach refused - ' + sol.reason + ' - piece unchanged', !sol.cancelled);
    var hull = sol.merged ? sol.soup : m.rawTris;

    /* The blank: the Stock shelf's default size for the shape in `overrides`,
       else the shape last clicked on the shelf (a cylinder when none has
       been), then whatever else `overrides` sets. */
    if (!window.nsoStockShelf || typeof window.nsoStockShelf.defaultOptions !== 'function') {
      return fail('Attach needs app-stock.js');
    }
    var opts = window.nsoStockShelf.defaultOptions((overrides && overrides.shape) || shelfShape() || 'cylinder');
    if (overrides) for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) opts[k] = overrides[k];
    if (!opts.height) {
      return fail('Set a target height first (mm) - the blank is sized from the piece you mean to make');
    }
    /* The same build-volume gate a Stock drop applies, against the machine the
       Plate card is pointed at, before any geometry exists. */
    if (typeof NSO_fitCurrentPrinter === 'function') opts.printer = NSO_fitCurrentPrinter();

    var arm;
    try { arm = NSO_Stock.make(opts); }
    catch (e) { return fail('Attach failed - nothing changed (' + ((e && e.message) || e) + ')'); }
    if (!arm.ok) return fail('Attach refused - nothing changed: ' + arm.reason);

    var pick = rawPickFrom(m, placed.mesh, worldPoint, localNormal);
    if (pick.error) return fail(pick.error);

    var r = NSO_Assemble.attach(hull, arm.soup, { at: pick.at, dir: pick.dir });
    if (!r.ok) return fail('Attach refused - nothing changed: ' + r.reason);

    say('Attaching (loading CSG kernel)...');
    var u = await NSO_unionSoups(hull, r.soup);
    if (!u.ok || !u.soup || u.soup.length < 9) {
      return fail('Attach refused - nothing changed: the union ' +
        (u.reason ? '- ' + u.reason : 'missed') + '. Seated ' + r.engageMm.toFixed(3) +
        ' mm; a deeper seat may be needed.');
    }

    var stats = u.stats || ((typeof NSO_edgeStats === 'function') ? NSO_edgeStats(u.soup) : null);
    if (stats && (stats.open > 0 || stats.nm > 0)) {
      return fail('Attach refused - nothing changed: the union came back open (' +
        stats.open + ' open, ' + stats.nm + ' non-manifold edges)');
    }

    var txt = 'Attached ' + arm.sizing.shape + ' ' + arm.sizing.measure_text +
      ' - ' + r.exposedLengthMm.toFixed(2) + ' mm proud, seated ' + r.engageMm.toFixed(3) +
      ' mm (' + r.rootGapMm.toFixed(3) + ' mm rim gap + ' +
      (r.marginMm == null ? 'as asked' : r.marginMm.toFixed(2) + ' mm floor') + '), ' +
      (u.soup.length / 9) + ' tris, 0 open / 0 non-manifold';
    if (r.growWarning) txt += ' - ' + r.growWarning;
    if (sol.merged) txt += ' - ' + sol.note;

    if (typeof NSO_sculptCommitRaw !== 'function') return fail('Attach needs app-sculpt.js to commit');
    if (!NSO_sculptCommitRaw(m, u.soup, 'attachReplace', txt)) {
      return fail('Attach refused - nothing changed: the commit was rejected');
    }
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return { ok: true, attach: r, union: { parts: u.parts, tris: u.soup.length / 9, stats: stats },
             stock: arm, modelId: m.id, reason: txt };
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (!el || el.dataset.nsoWired === '1') return;
    el.dataset.nsoWired = '1';
    el.addEventListener(ev, fn);
  }

  function wire() {
    bind('btn-stock-attach', 'click', function () { setArmed(!state.attachArmed); });
    /* Escape stops it. Not consumed: whatever else listens for Escape still
       does. */
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.attachArmed) setArmed(false);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
