/* app-stock.js - the Stock shelf: one tile per shape, one click puts it on
   the plate.

   Thin on purpose, the way app-hollow.js and app-skin-patch.js are thin: all
   the arithmetic and all the geometry live in nso_stock.js, which is
   THREE-free and node-tested, and all the floor lives in nso_thickness.js.
   What is here is the three things that can only be done in the app - draw
   the tiles, resolve the machine the user is actually pointed at, and add the
   piece.

   THE CARD HAS NO FIELDS. It used to: a shape select, a target height and
   radius, wall, nozzle, waste, a proportions box, Match and Oversize, and a
   live session that re-sized the block as they moved. Sizing a blank is the
   Scale card's job now, and Scale reads the shape's own measurements (a
   capsule's length, a torus's ring and tube Ø - nso_shapes.js), so a second
   set of boxes saying the same thing in other words is gone. The card is a
   shelf of tiles and a tile is a verb.

   A TILE IS DRAWN FROM THE GENERATOR, NOT FROM A FILE. Each is a 56 px canvas
   painted once, the first time the card opens, from NSO_Stock.make's own soup
   for that shape - the soup a click drops, at a coarser tessellation - lit
   flat from one side on a dark ground. No image is in the repo, no tile has a
   word on it, and a shape added to nso_stock.js is a tile in index.html and
   nothing else.

   A CLICK DROPS THE SHAPE AT ITS DEFAULT SIZE. DEFAULT_TARGET is the one
   figure here: a 40 mm target, sized by nso_stock.js with its own stated
   defaults (3 mm wall, 30 % waste), so every shape arrives at the size the old
   card's blank fields gave it - bar the ellipsoid's ratio, below. Where it lands is free plate space (nsoFreeSpot,
   the same search Picture and Mold use), centred when the plate is empty and
   beside the selected piece when one is. It is selected, named by what it is
   and a running number - "box 1", "cylinder 2" - and tagged with its sizing
   (NSO_shapeTagStock) so Scale's per-shape rows read the parameters instead of
   fitting the mesh. A second click on the same tile drops another; Undo takes
   the last one back off through the same 'addModels' entry Extract and Split
   use.

   The build-volume gate is still the machine the Plate card is pointed at
   (NSO_fitCurrentPrinter): a default block the plate cannot hold is refused
   before any geometry is added.

   PAINT SCOPE: NONE. A drop reads no existing geometry (the selected piece is
   read for its footprint only, to find the room beside it) and writes to no
   face of anything. See docs/HANDOFF.md, "Scoping" - `none` is a category
   there. */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  /* The size every tile drops at: nso_stock.js sized for a 40 mm target, with
     its own defaults for everything else. */
  var DEFAULT_TARGET = { height: 40 };

  /* The one shape whose own default would be another tile's: an ellipsoid
     with nothing said is the target's height over its diameter, which for a
     40 mm target is 1 - a sphere. It is dropped 1.5 tall instead, so the tile
     and the piece are an ellipsoid. Every other shape takes the module's. */
  var SHAPE_DEFAULTS = { ellipsoid: { ratio: 1.5 } };

  /* mm between the selected piece and the one dropped beside it - what
     addModel leaves, and what nsoFreeSpot keeps clear anyway. */
  var BESIDE_GAP = 6;

  /* The tiles' look. */
  var TILE_BG = '#14171c';
  var TILE_RGB = [56, 189, 248];         // the plate piece's own 0x38bdf8
  var TILE_SEGMENTS = 32;                // coarser than a drop: 56 px cannot show more
  var TILE_YAW = 0.62, TILE_ELEV = 0.62; // radians: a three-quarter view from above
  var TILE_LIGHT = [-0.45, 0.55, 0.70];   // view frame: x right, y up, z toward the viewer

  function shapeButtons() {
    var shelf = $('stock-shelf');
    return shelf ? Array.prototype.slice.call(shelf.querySelectorAll('button[data-shape]')) : [];
  }
  function shelfShapes() {
    return shapeButtons().map(function (b) { return b.getAttribute('data-shape'); });
  }

  /* --------------------------------------------------------------- the tiles

     A tiny painter's-algorithm renderer: rotate the soup into the view frame,
     cull the faces turned away, sort back to front by centroid and fill each
     triangle flat. Enough for eight primitives at 56 px, and it needs neither
     THREE nor a GL context - a canvas 2D context is all a tile owns. */
  function signedVolume(s) {
    var v = 0;
    for (var i = 0; i < s.length; i += 9) {
      v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) -
           s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
           s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
    }
    return v;
  }

  function paintTile(canvas, soup) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return false;
    var W = canvas.width, H = canvas.height, n = (soup.length / 9) | 0;
    ctx.fillStyle = TILE_BG;
    ctx.fillRect(0, 0, W, H);
    if (!n) return false;

    var cy = Math.cos(TILE_YAW), sy = Math.sin(TILE_YAW);
    var ce = Math.cos(TILE_ELEV), se = Math.sin(TILE_ELEV);
    /* Z-up soup: turn about Z by the yaw, then look down at it from `elev`.
       Screen x is the turned x; screen y (up) is y*sin(e) + z*cos(e); depth
       toward the viewer is z*sin(e) - y*cos(e). */
    var P = new Float32Array(n * 9), D = new Float32Array(n);
    var lox = Infinity, hix = -Infinity, loy = Infinity, hiy = -Infinity;
    for (var i = 0; i < n * 3; i++) {
      var x = soup[3 * i], y = soup[3 * i + 1], z = soup[3 * i + 2];
      var x1 = x * cy - y * sy, y1 = x * sy + y * cy;
      var sx = x1, sv = y1 * se + z * ce, d = z * se - y1 * ce;
      P[3 * i] = sx; P[3 * i + 1] = sv; P[3 * i + 2] = d;
      if (sx < lox) lox = sx; if (sx > hix) hix = sx;
      if (sv < loy) loy = sv; if (sv > hiy) hiy = sv;
    }
    var pad = 4, span = Math.max(hix - lox, hiy - loy, 1e-6);
    var k = (Math.min(W, H) - 2 * pad) / span;
    var ox = W / 2 - k * (lox + hix) / 2, oy = H / 2 + k * (loy + hiy) / 2;

    var L = TILE_LIGHT, ll = Math.sqrt(L[0] * L[0] + L[1] * L[1] + L[2] * L[2]);
    var flip = signedVolume(soup) < 0 ? -1 : 1;
    var order = [];
    for (var t = 0; t < n; t++) {
      var o = 9 * t;
      /* Facet normal in the view frame (x right, y up, z toward the viewer). */
      var ax = P[o + 3] - P[o], ay = P[o + 4] - P[o + 1], az = P[o + 5] - P[o + 2];
      var bx = P[o + 6] - P[o], by = P[o + 7] - P[o + 1], bz = P[o + 8] - P[o + 2];
      var nx = (ay * bz - az * by) * flip, ny = (az * bx - ax * bz) * flip, nz = (ax * by - ay * bx) * flip;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) continue;
      nx /= nl; ny /= nl; nz /= nl;
      if (nz <= 0) continue;                       // turned away from the viewer
      var lam = (nx * L[0] + ny * L[1] + nz * L[2]) / ll;
      order.push({ t: t, depth: (P[o + 2] + P[o + 5] + P[o + 8]) / 3, shade: 0.28 + 0.72 * Math.max(0, lam) });
    }
    order.sort(function (a, b) { return a.depth - b.depth; });
    ctx.lineWidth = 0.6;
    ctx.lineJoin = 'round';
    for (var q = 0; q < order.length; q++) {
      var f = order[q], p = 9 * f.t;
      var col = 'rgb(' + Math.round(TILE_RGB[0] * f.shade) + ',' + Math.round(TILE_RGB[1] * f.shade) + ',' + Math.round(TILE_RGB[2] * f.shade) + ')';
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(ox + k * P[p], oy - k * P[p + 1]);
      ctx.lineTo(ox + k * P[p + 3], oy - k * P[p + 4]);
      ctx.lineTo(ox + k * P[p + 6], oy - k * P[p + 7]);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    return true;
  }

  /* What a tile asks nso_stock.js for: the shape at the default target. */
  function stockOpts(shape) {
    var o = { shape: shape };
    for (var k in DEFAULT_TARGET) if (Object.prototype.hasOwnProperty.call(DEFAULT_TARGET, k)) o[k] = DEFAULT_TARGET[k];
    var own = SHAPE_DEFAULTS[shape];
    if (own) for (var j in own) if (Object.prototype.hasOwnProperty.call(own, j)) o[j] = own[j];
    return o;
  }

  var drawn = false;
  function drawTiles() {
    if (drawn) return 0;
    if (typeof NSO_Stock === 'undefined' || !NSO_Stock) return 0;
    drawn = true;
    var done = 0;
    shapeButtons().forEach(function (btn) {
      var canvas = btn.querySelector('canvas');
      if (!canvas) return;
      var o = stockOpts(btn.getAttribute('data-shape'));
      o.segments = TILE_SEGMENTS; o.profileN = TILE_SEGMENTS;
      var r;
      try { r = NSO_Stock.make(o); } catch (e) { r = null; }
      if (r && r.ok && paintTile(canvas, r.soup)) { canvas.setAttribute('data-drawn', '1'); done++; }
    });
    return done;
  }

  /* ------------------------------------------------------------------- drop */

  /* "box 1", "cylinder 2": the shape and the next number up from the highest
     the plate's pieces already carry, so an Undo hands its number back. */
  function nextName(shape) {
    var top = 0;
    var re = new RegExp('^(?:' + (NSO_Stock.SHAPES || []).join('|') + ') (\\d+)$');
    (state.models || []).forEach(function (m) {
      var hit = m && re.exec(m.name || '');
      if (hit) top = Math.max(top, parseInt(hit[1], 10));
    });
    return shape + ' ' + (top + 1);
  }

  /* Where the drop should be asked to land: the middle of the plate, or the
     room beside the selected piece. nsoFreeSpot then moves it to the nearest
     spot that is actually free. */
  function wantedSpot(made) {
    var sel = (state.selectedIndex >= 0) ? state.placed[state.selectedIndex] : null;
    if (!sel || !sel.mesh) return { x: 0, z: 0, beside: null };
    var fp = (typeof placedFootprint === 'function') ? placedFootprint(sel) : null;
    var right = fp ? fp.maxx : sel.x + (sel.width || 0) / 2;
    var mid = fp ? (fp.minz + fp.maxz) / 2 : sel.z;
    return { x: right + BESIDE_GAP + made.size.x / 2, z: mid, beside: sel.name || null };
  }

  /* `overrides` is for a drive check that needs a block of a stated size
     (opts as nso_stock.js takes them: height, radius, waste, proportions...)
     through the same path a click takes; a tile passes none. */
  /* The shape last clicked on the shelf - what Connect's Attach button
     generates a blank of. Set before anything can refuse the drop: it was
     clicked. */
  var lastShape = null;

  function drop(shape, overrides) {
    if (typeof NSO_Stock === 'undefined' || !NSO_Stock) {
      say('Stock needs nso_stock.js', true);
      return { ok: false, reason: 'NSO_Stock not loaded' };
    }
    if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
      say('Stock needs the viewport', true);
      return { ok: false, reason: 'no ingest path' };
    }
    if (NSO_Stock.SHAPES.indexOf(shape) < 0) {
      say('Stock has no shape called "' + shape + '"', true);
      return { ok: false, reason: 'unknown shape' };
    }

    lastShape = shape;
    var opts = stockOpts(shape);
    if (overrides) for (var ok in overrides) if (Object.prototype.hasOwnProperty.call(overrides, ok)) opts[ok] = overrides[ok];
    /* The machine the Plate card is pointed at, passed in rather than looked
       up inside nso_stock.js, which has no app state by design - see its
       header. */
    if (typeof NSO_fitCurrentPrinter === 'function') opts.printer = NSO_fitCurrentPrinter();

    var r;
    try { r = NSO_Stock.make(opts); }
    catch (e) {
      say('Stock failed - nothing added (' + ((e && e.message) || e) + ')', true);
      return { ok: false, reason: (e && e.message) || String(e) };
    }
    if (!r.ok) {
      say('Stock refused - nothing added: ' + r.reason, true);
      return r;
    }

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.soup), 3));
    var name = nextName(shape);
    var editBefore = state.editId, cutBefore = state.cutT;
    /* keepSelection + silent: addModel's own auto-placement and status line
       are for an uploaded file; this one is placed, selected and announced
       below. */
    var id = addModelFromZUpGeometry(name, g, { keepSelection: true, silent: true });
    if (id == null) {
      say('Stock refused - the new piece looked empty', true);
      return { ok: false, reason: 'addModel refused' };
    }
    var made = state.models.find(function (x) { return x && x.id === id; });
    if (made.rawTris && typeof NSO_shapeTagStock === 'function') NSO_shapeTagStock(made.rawTris, r.sizing);
    if (typeof pushUndo === 'function') pushUndo({ type: 'addModels', ids: [id], editId: editBefore, cutT: cutBefore });

    var want = wantedSpot(made);
    var entry = placeModelMovable(made, want.x, want.z);
    var at = { x: want.x, z: want.z, onBed: true };
    if (entry && typeof nsoFreeSpot === 'function') at = nsoFreeSpot(entry, want);
    if (entry && typeof applyPlacedXZ === 'function') applyPlacedXZ(entry, at.x, at.z);

    var idx = entry ? state.placed.indexOf(entry) : -1;
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();

    var s = r.sizing;
    var txt = 'Dropped ' + name + ' - ' + s.measure_text + (want.beside ? ', beside ' + want.beside : '') +
      '. Size it with Scale.';
    if (!at.onBed) txt += ' The plate has no free room left - it sits past the edge.';
    if (s.warnings && s.warnings.length) txt += ' ' + s.warnings.join('; ');
    say(txt, !at.onBed);

    r.modelId = id;
    r.name = name;
    r.placedIndex = idx;
    return r;
  }

  function wire() {
    shapeButtons().forEach(function (btn) {
      if (btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try { drop(btn.getAttribute('data-shape')); }
        catch (err) {
          if (typeof console !== 'undefined') console.error('[stock]', err);
          say('Stock failed - nothing added (' + ((err && err.message) || err) + ')', true);
        }
      });
    });
    var menu = document.querySelector('.vp-stock-menu');
    if (menu) {
      if (menu.open) drawTiles();
      menu.addEventListener('toggle', function () { if (menu.open) drawTiles(); });
    }
  }

  /* Exposed so a drive check runs the same path a click runs rather than a
     parallel copy of it. */
  window.nsoStockShelf = {
    shapes: shelfShapes,
    drop: drop,
    draw: drawTiles,
    drawn: function () { return drawn; },
    lastShape: function () { return lastShape; },
    /* What a drop asks nso_stock.js for, minus the machine. app-assemble.js
       sizes its blank from the same figures. */
    defaultOptions: stockOpts,
    defaultTarget: function () { return Object.assign({}, DEFAULT_TARGET); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
