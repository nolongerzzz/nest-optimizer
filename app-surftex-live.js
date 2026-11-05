/* ============================================================
   Wrap, live - the app layer over app-surftex.js, in the shape Soften's live
   card (app-soften-live.js) gave Soften.

   Wrap used to be a form: a Face list, a Skin list, a Feature list and fifteen
   boxes, and a WRAP button that baked whatever they said, unseen. Now:

     Feature, Layout          shelves of tiles. Each picture is the engine's own
                              wrap on a small flat slab - NSO_SurfTex.apply, the
                              call WRAP makes - with the surface the wrap made lit
                              green, so a tile is what that feature does to a
                              face, not an artist's idea of it. The two <select>s
                              stay in the page, hidden, as the value holders the
                              card's own code (NSO_surftexParams, the presets)
                              reads and writes; a tile sets one and says so.
     the preview              while the card is open and anything on it has been
                              touched - a tile, a skin, a number, the face - the
                              piece turns to a ghost and the new patch is drawn on
                              it, redrawn as the numbers move. The face the wrap
                              replaces keeps its amber tint (app-surftex.js).
     a click on the piece     picks the face under it, the same as choosing it in
                              the Face list (a click, not a drag: orbit and move
                              are untouched).
     WRAP                     installs the result that is on screen, bit for bit:
                              NSO_surftexWrap({ computed }) with the preview's own
                              NSO_surftexCompute result, then the same commit it
                              has always made. One Undo. The ghost is put away
                              first (the bake swaps the piece's mesh) and the
                              preview stays off until something is touched again.
     Close                    the preview goes; the piece was never touched.

   PACED, NOT QUEUED. apply() is synchronous and its cost is the face's: a
   cylinder is milliseconds, a dense lattice on a big dome is seconds. Each
   redraw waits as long as the last one took (never under MIN_GAP_MS), and only
   the latest numbers are ever drawn. A preview that cost more than SLOW_MS is
   redrawn when a number is let go (change), not at every keystroke (input).

   PAINT SCOPE: WHOLE-PIECE, as Wrap's. A painted piece gets Wrap's own refusal
   in the readout, and no preview.
   ============================================================ */
(function () {
  'use strict';

  var GHOST_OPACITY = 0.2;
  var MIN_GAP_MS = 100, SLOW_MS = 2000;
  var CLICK_PX = 5, CLICK_MS = 600;
  var HI = [74, 222, 128];

  var on = false, previewOn = false;
  var m = null, mesh = null, group = null, patchObj = null, ghostSaved = null;
  var last = null;                      // { key, c, soup } - what the preview last drew
  var timer = 0, lastCost = 0, lastAt = 0, tilesQueued = false, bound = false;
  var press = null;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function readout(text, bad) { if (typeof NSO_surftexReadout === 'function') NSO_surftexReadout(text, bad); }
  function engineReady() {
    return typeof NSO_surftexCompute === 'function' && typeof NSO_surftexModel === 'function' && typeof NSO_SurfTex !== 'undefined';
  }
  function card() { return $('surftex-card'); }
  function tiles() { var c = card(); return c ? Array.prototype.slice.call(c.querySelectorAll('button[data-pick]')) : []; }

  /* ---------------------------------------------------------------
     Tiles
     --------------------------------------------------------------- */

  /* Which tile of each shelf is the select's value. Called whenever a select has been written (a preset, a tile). */
  function sync() {
    tiles().forEach(function (b) {
      var sel = $('sel-surftex-' + b.getAttribute('data-pick'));
      var lit = !!sel && sel.value === b.getAttribute('data-value');
      b.classList.toggle('is-picked', lit);
      b.setAttribute('aria-pressed', lit ? 'true' : 'false');
    });
  }

  /* One flat slab, wrapped by the engine for every tile. The top face is the larger of the two big planes by height. */
  var slab = null;
  function slabFace() {
    if (slab) return slab;
    if (typeof rawBoxSoup !== 'function') return null;
    var soup = rawBoxSoup([-11, -11, -2], [11, 11, 2]);
    var reg = NSO_SurfTex.regions(soup, { crease: 30, minArea: 2 }), best = null, bz = -Infinity;
    reg.list.forEach(function (r) {
      var z = 0, n = 0, k, t;
      for (t = 0; t < r.tris.length; t++) for (k = 0; k < 3; k++) { z += reg.M.P[3 * reg.M.vid[3 * r.tris[t] + k] + 2]; n++; }
      z /= n;
      if (r.area > 300 && z > bz) { bz = z; best = r; }
    });
    slab = best ? { soup: soup, reg: reg, face: best } : null;
    return slab;
  }

  /* What a tile asks the engine for. A feature tile varies the feature; a layout tile lays balls in that layout. */
  function tileParams(pick, value) {
    if (pick === 'layout') return { motif: 'ball', size: 2.6, height: 1.3, spacing: 4, margin: 0.3, layout: value };
    // big and few, so each feature reads as itself at the size of a tile
    var p = { motif: value, size: 8, height: 4, depth: 1.8, spacing: 10, margin: 0.4, layout: 'grid', sides: 4 };
    if (value === 'bump') p.height = 2.6;
    if (value === 'line') { p.size = 3; p.spacing = 6; p.height = 1.8; p.profile = 'tri'; }
    return p;
  }

  function paintTile(btn) {
    var canvas = btn.querySelector('canvas'), s = slabFace();
    if (!canvas || !s || !window.nsoStockShelf || typeof window.nsoStockShelf.paint !== 'function') return false;
    var res;
    try { res = NSO_SurfTex.apply(s.soup, s.reg, [s.face], tileParams(btn.getAttribute('data-pick'), btn.getAttribute('data-value'))); }
    catch (e) { res = null; }
    if (!res || !res.ok) return false;
    var n = (res.soup.length / 9) | 0, firstNew = n - res.added;
    var lit = function (t) { return t >= firstNew ? HI : null; };
    // a layout is a pattern: look nearly straight down at it; a feature is a shape: the shelf's three-quarter view
    var view = btn.getAttribute('data-pick') === 'layout' ? { yaw: 0.35, elev: 1.25 } : null;
    if (window.nsoStockShelf.paint(canvas, res.soup, lit, view)) { canvas.setAttribute('data-drawn', '1'); return true; }
    return false;
  }

  /* One tile per tick: nine wraps in a row would hold the page for as long as they take together. */
  function drawTiles() {
    if (tilesQueued || !engineReady()) return;
    tilesQueued = true;
    var queue = tiles();
    (function next() {
      var b = queue.shift();
      if (!b) return;
      try { paintTile(b); } catch (e) { if (typeof console !== 'undefined') console.error('[wrap tiles]', e); }
      setTimeout(next, 0);
    })();
  }

  /* ---------------------------------------------------------------
     The ghost and the patch
     --------------------------------------------------------------- */

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : null;
  }
  function disposeObj(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }
  function ghost(onOff) {
    var mats = mesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    if (onOff) {
      ghostSaved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite, depthTest: mt.depthTest, wireframe: mt.wireframe };
      }) };
      mesh.userData.skipXray = true;
      mats.forEach(function (mt) {
        mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true; mt.wireframe = false; mt.needsUpdate = true;
      });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) {
        s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite; s.mt.depthTest = s.depthTest;
        s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
      });
      if (mesh) mesh.userData.skipXray = ghostSaved.skip;
      ghostSaved = null;
    }
  }
  function openView(ms) {
    mesh = ms;
    group = new THREE.Group();
    group.userData.skipXray = true;
    group.userData.nsoSurftexGroup = true;
    nsoHelpers.attach(mesh, group, 'surftex');
    ghost(true);
  }
  function clearPatch() { disposeObj(patchObj); patchObj = null; }
  function closeView() {
    clearPatch();
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
    mesh = null;
  }
  /* The piece's mesh is rebuilt by an Undo or a bake: the ghost follows it. */
  function ensureView(model) {
    var ms = meshOf(model);
    if (!ms) { closeView(); return false; }
    if (ms !== mesh) { closeView(); openView(ms); }
    return true;
  }

  function localPositions(soup, model) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(model) : null;
    var n = soup.length / 3, pos = new Float32Array(soup.length);
    for (var i = 0; i < n; i++) {
      var p = [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]];
      var q = f ? nsoLocalPointFromRaw(f, p) : p;
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
    }
    return pos;
  }
  /* The new patch is the last `added` triangles of the result: the kept ones come first (nso_surftex.js apply). */
  function drawPatch(c, model) {
    clearPatch();
    if (!group) return;
    var soup = c.res.soup, n = (soup.length / 9) | 0, k = Math.min(c.res.added, n);
    if (!k) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(localPositions(soup.subarray(9 * (n - k)), model), 3));
    g.computeVertexNormals();
    patchObj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0x4ade80, emissive: 0x14532d, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0,
      transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    patchObj.renderOrder = 42;
    group.add(patchObj);
  }

  /* ---------------------------------------------------------------
     The preview
     --------------------------------------------------------------- */

  function keyNow() {
    var picks = (typeof NSO_surftexPicks === 'function') ? NSO_surftexPicks().map(function (r) { return r.id; }).join(',') : '';
    return picks + '|' + JSON.stringify(NSO_surftexParams());
  }

  function recompute() {
    timer = 0;
    if (!on || !previewOn || !engineReady()) return;
    var model = NSO_surftexModel();
    if (!model) { last = null; closeView(); return; }
    ensureView(model);
    var t0 = Date.now(), c;
    try { c = NSO_surftexCompute({}); }
    catch (e) { c = { ok: false, reason: (e && e.message) || String(e) }; }
    lastCost = Date.now() - t0; lastAt = Date.now();
    if (c.ok) {
      last = { key: keyNow(), c: c, soup: model.rawTris };
      drawPatch(c, model);
      readout(c.text.replace(/^Wrapped/, 'Wrap preview:') + ' - press WRAP to bake it.');
    } else {
      last = null; clearPatch();
      readout('Wrap: ' + (c.painted ? c.painted + ' painted face(s) - clear paint first.' : c.reason), true);
    }
  }

  /* kind: 'input' (a key, a drag) or 'change' (let go). A slow preview waits for the second. */
  function schedule(kind) {
    if (!on || !previewOn) return;
    if (kind === 'input' && lastCost > SLOW_MS) return;
    if (timer) clearTimeout(timer);
    var wait = Math.max(MIN_GAP_MS, lastCost) - (Date.now() - lastAt);
    timer = setTimeout(recompute, wait > 0 ? wait : 0);
  }

  /* The preview, current, for WRAP to install: null when there is none to trust, and WRAP then computes as it always did. */
  function fresh() {
    if (!on || !previewOn) return null;
    if (timer) { clearTimeout(timer); recompute(); }
    var model = NSO_surftexModel();
    if (!last || !model || last.soup !== model.rawTris || last.key !== keyNow()) return null;
    return last.c;
  }

  function touched(kind) {
    if (!on) return;
    previewOn = true;
    sync();
    schedule(kind);
  }

  /* ---------------------------------------------------------------
     Open, close, the hooks app-surftex.js calls
     --------------------------------------------------------------- */

  function open() { on = true; sync(); drawTiles(); }
  function close() {
    on = false; previewOn = false; last = null;
    if (timer) { clearTimeout(timer); timer = 0; }
    press = null;
    closeView();
  }
  /* The faces were read again (open, a new crease, a new soup after an Undo or a bake): draw the preview again if there is one. */
  function refresh() {
    if (!on) return;
    if (!previewOn) { last = null; return; }
    schedule('change');
  }
  /* WRAP is about to install: the ghost off now (the bake swaps the mesh), the preview off until something is touched. */
  function release() {
    if (timer) { clearTimeout(timer); timer = 0; }
    previewOn = false; last = null;
    closeView();
  }

  /* ---------------------------------------------------------------
     A click on the piece names the face under it
     --------------------------------------------------------------- */

  function onDown(event) {
    if (!on || event.button !== 0) { press = null; return; }
    press = { x: event.clientX, y: event.clientY, t: performance.now() };
  }
  function onUp(event) {
    var p = press; press = null;
    if (!p || !on || event.button !== 0) return;
    var cv = state.renderer && state.renderer.domElement;
    if (!cv || event.target !== cv) return;
    if (Math.abs(event.clientX - p.x) > CLICK_PX || Math.abs(event.clientY - p.y) > CLICK_PX) return;
    if (performance.now() - p.t > CLICK_MS) return;
    pickFace(event);
  }
  function pickFace(event) {
    var model = NSO_surftexModel(), B = (typeof NSO_surftexUI === 'function') ? NSO_surftexUI() : null;
    var ms = model ? meshOf(model) : null;
    if (!model || !ms || !B || !B.reg || B.soup !== model.rawTris) return false;
    var r = state.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, state.camera);
    ms.updateMatrixWorld(true);
    var hits = rc.intersectObject(ms, false).filter(function (h) { return h.faceIndex != null; });
    if (!hits.length) return false;
    var geo = ms.geometry, nTri = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) | 0;
    if (nTri !== model.rawTris.length / 9) return false;                 // the picture and the triangles disagree: no guess
    var t = hits[0].faceIndex, shown = B.reg.list.slice(0, 12), found = null;
    for (var i = 0; i < shown.length; i++) if (shown[i].mask[t]) { found = shown[i]; break; }
    if (!found) { say('Wrap: that spot is not on a face in the list (too small a piece of surface) - pick from the Face list', true); return false; }
    var sel = $('sel-surftex-face');
    if (!sel) return false;
    sel.value = String(found.id);
    sel.dispatchEvent(new Event('change', { bubbles: true }));            // the card tints it; the delegation below redraws the preview
    say('Wrap: ' + (found.id + 1) + ' - ' + found.label);
    return true;
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function bind() {
    var c = card();
    if (!c || c.dataset.nsoLiveWired === '1') return;
    c.dataset.nsoLiveWired = '1';
    tiles().forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sel = $('sel-surftex-' + btn.getAttribute('data-pick'));
        if (!sel) return;
        sel.value = btn.getAttribute('data-value');
        sel.dispatchEvent(new Event('change', { bubbles: true }));       // the motif's own handler clears the skin and shows its fields; the delegation below draws
      });
    });
    c.addEventListener('input', function (e) { if (e.target && e.target.id !== 'inp-surftex-crease') touched('input'); });
    c.addEventListener('change', function (e) { if (e.target && e.target.id !== 'inp-surftex-crease') touched('change'); });
    var menu = $('menu-surftex');
    if (menu && menu.open) open();
    if (typeof state !== 'undefined' && state.renderer && state.renderer.domElement && !bound) {
      bound = true;
      state.renderer.domElement.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', function () { press = null; });
    }
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('surftex', {
    live: function () { return on; },
    close: function () { var menu = $('menu-surftex'); if (menu) menu.open = false; close(); }
  });

  /* For the drive checks and app-surftex.js: the same paths the controls run. */
  window.nsoSurftexLive = {
    open: open, close: close, refresh: refresh, release: release, sync: sync, fresh: fresh, drawTiles: drawTiles,
    touch: function () { touched('change'); },
    flush: function () { if (timer) { clearTimeout(timer); } recompute(); },
    on: function () { return on; },
    info: function () {
      return {
        on: on, previewOn: previewOn, ok: !!last, text: last ? last.c.text : null, tiles: last ? last.c.res.stats.tiles : null,
        patchTris: last ? last.c.res.added : null, soup: last ? last.c.res.soup : null, ghost: !!ghostSaved, patch: !!patchObj,
        cost: lastCost, readout: ($('surftex-readout') || {}).textContent
      };
    },
    objects: function () { return { group: group, patch: patchObj, mesh: mesh }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
