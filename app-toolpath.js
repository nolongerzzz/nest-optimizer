/*
 * Toolpath import + the line-level view slider
 * --------------------------------------------
 * Drops an already-sliced Bambu Studio project (`*.gcode.3mf`) onto the plate
 * as real geometry: `nso-gcode-lines.js` reads `Metadata/plate_N.gcode` and
 * turns every extrusion move into a flat line solid at its own printed width
 * and height, and this file puts those on screen and lets you scrub through
 * them ONE MOVE AT A TIME.
 *
 * WHY LINE GRANULARITY AND NOT JUST LAYERS
 * A layer slider tells you which layer a feature is on. It does not let you
 * pick the line. A support-interface layer can be hundreds of moves, and the
 * whole point of importing the toolpath is to isolate one of them, so the
 * scrub control here steps move by move within a layer as well as layer by
 * layer - the same stepping Bambu Studio's own preview does, except that here
 * the thing you land on is selectable geometry rather than a picture.
 *
 * SCOPE
 * Import and render only. Nothing here slices, and nothing here guesses what
 * Bambu Studio would do; the toolpath on screen is the one in the file.
 *
 * WHAT GETS ADDED TO THE SCENE
 * One model per `; FEATURE:` group, through `addModelFromZUpGeometry()` - the
 * same single ingest path STL and plain-3MF imports use. So an imported
 * toolpath feature is an ordinary NSO model from that point on: undo, paint,
 * Cut, Join and both exporters treat it like anything else, with no
 * special-casing anywhere.
 */
/* global THREE, state, setStatus, addModelFromZUpGeometry, pushUndo */
'use strict';

var NSO_TOOLPATH = (function () {
  var HIGHLIGHT_COLOR = 0xff3b30;
  var CONTEXT_COLOR = 0x3b82f6;

  // The last import, kept so the slider has something to scrub. One at a time:
  // scrubbing two toolpaths at once has no meaning.
  var session = null;

  function $(id) { return document.getElementById(id); }

  function say(msg, isErr) {
    if (typeof setStatus === 'function') setStatus(msg, !!isErr);
    else if (isErr) console.error(msg); else console.log(msg);
  }

  // =========================================================================
  // Import
  // =========================================================================

  /** True for a file that is worth trying as a sliced project. */
  function looksSliced(name) {
    return /\.gcode\.3mf$/i.test(String(name));
  }

  /**
   * Read a sliced project and add one model per feature group.
   * @returns {Promise<object|null>} the session, or null on failure
   */
  function importSliced3MF(filename, arrayBuffer) {
    var G = window.NSOGcodeLines;
    if (!G) { say('Toolpath reader failed to load - check console', true); return Promise.resolve(null); }
    say('Reading toolpath from ' + filename + '...');

    return G.readSlicedGcode3MF(new Uint8Array(arrayBuffer), { name: filename })
      .then(function (res) {
        if (!res.parsed.moves.length) {
          say(filename + ': the plate G-code has no extrusion moves', true);
          return null;
        }
        // The toolpath's own bounds, before the app touches anything. Every
        // group is placed back relative to THIS, so the import reassembles as
        // the plate the slicer wrote rather than as N pieces in a row.
        var frame = boundsOf(res.parsed.moves);

        var ids = [];
        res.groups.forEach(function (g) {
          if (!g.built.positions.length) return;
          var geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(g.built.positions, 3));
          var id = addModelFromZUpGeometry(baseName(filename) + ' - ' + g.name, geo);
          if (!id) return;
          ids.push(id);
          g.modelId = id;
          reseat(id, boundsOf(g.moves), frame);
        });
        if (!ids.length) { say(filename + ': nothing could be added to the scene', true); return null; }

        session = {
          file: filename,
          result: res,
          moves: res.parsed.moves,
          layers: res.parsed.layers,
          modelIds: ids,
          frame: frame,
          cursor: 0,
          overlay: null
        };
        buildOverlay();
        mountUI();
        setCursor(0);

        res.warnings.forEach(function (w) { console.warn(filename + ': ' + w); });
        say('Toolpath in: ' + ids.length + ' feature group' + (ids.length === 1 ? '' : 's') + ', ' +
            res.parsed.layers.length + ' layers, ' + res.parsed.moves.length + ' lines' +
            (res.parsed.meta.assumed ? ' (some settings were not in the file - see console)' : ''));
        return session;
      })
      .catch(function (err) {
        console.error(err);
        say(filename + ': ' + (err && err.message ? err.message : 'not a readable sliced 3MF'), true);
        return null;
      });
  }

  function baseName(n) { return String(n).replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, ''); }

  // =========================================================================
  // Keeping the toolpath assembled
  // =========================================================================
  //
  // addModel() centres every geometry on its own box and placeModelMovable()
  // lays new pieces out in a row, which is right for unrelated STLs and wrong
  // here: five FEATURE groups out of one slice are five parts of ONE print and
  // have to stay in register, or the walls sit next to their own infill and the
  // scrub highlight cannot line up with anything. So each group is put back at
  // its true offset within the toolpath, and the overlay is parked on the same
  // datum.
  //
  // Axes: the app's display space is Y up, reached from the file's Z-up
  // millimetres by zUpToYUp()'s rotateX(-90 deg), i.e.
  //     (gx, gy, gz)  ->  (gx, gz, -gy).
  // Everything below is that one mapping, applied consistently.

  var PLATE_LIFT = 0.3;   // the hover placeModelMovable() adds; matched, not guessed

  /** Bounds of a move list in the file's own Z-up millimetres. */
  function boundsOf(moves) {
    var b = {
      minX: Infinity, maxX: -Infinity,
      minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity
    };
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var hw = m.width / 2;
      // The bead is half a width proud on each side, across the move.
      var dx = m.x1 - m.x0, dy = m.y1 - m.y0;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ex = Math.abs(-dy / len) * hw, ey = Math.abs(dx / len) * hw;
      b.minX = Math.min(b.minX, m.x0 - ex, m.x1 - ex);
      b.maxX = Math.max(b.maxX, m.x0 + ex, m.x1 + ex);
      b.minY = Math.min(b.minY, m.y0 - ey, m.y1 - ey);
      b.maxY = Math.max(b.maxY, m.y0 + ey, m.y1 + ey);
      b.minZ = Math.min(b.minZ, m.z - m.height);
      b.maxZ = Math.max(b.maxZ, m.z);
    }
    b.cx = (b.minX + b.maxX) / 2;
    b.cy = (b.minY + b.maxY) / 2;
    b.cz = (b.minZ + b.maxZ) / 2;
    return b;
  }

  /** Move a just-placed group back to its true spot inside the toolpath. */
  function reseat(modelId, own, frame) {
    if (!state || !state.placed) return;
    var entry = null;
    for (var i = state.placed.length - 1; i >= 0; i--) {
      if (state.placed[i].sourceId === modelId) { entry = state.placed[i]; break; }
    }
    if (!entry || !entry.mesh) return;
    var px = own.cx - frame.cx;
    var py = own.cz - frame.minZ + PLATE_LIFT;
    var pz = -(own.cy - frame.cy);
    entry.mesh.position.set(px, py, pz);
    // The app tracks x / z on the entry as well as on the mesh; leaving those
    // stale would make the very first drag jump the piece back.
    entry.x = px;
    entry.z = pz;
  }

  // =========================================================================
  // Scrub overlay - the highlight the slider drives
  // =========================================================================
  //
  // The overlay is a VIEW, not geometry: it is drawn over the imported models
  // so scrubbing never edits, marks or dirties them. The models the importer
  // added are the real thing; this just points at one of their moves.

  function disposeOverlay() {
    if (!session || !session.overlay) return;
    var o = session.overlay;
    if (o.parent) o.parent.remove(o);
    o.traverse(function (n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(function (m) { m.dispose(); });
    });
    session.overlay = null;
  }

  function buildOverlay() {
    if (!session || !session.frame || typeof THREE === 'undefined' || !state || !state.scene) return;
    disposeOverlay();
    var g = new THREE.Group();
    g.name = 'nso-toolpath-scrub';
    g.renderOrder = 999;

    function lineMesh(color, opacity) {
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      var mat = new THREE.MeshBasicMaterial({
        color: color, transparent: true, opacity: opacity, depthTest: false
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 999;
      return mesh;
    }
    g.add(lineMesh(CONTEXT_COLOR, 0.35));    // child 0: the rest of this layer
    g.add(lineMesh(HIGHLIGHT_COLOR, 1.0));   // child 1: the one selected move
    // Same datum reseat() puts the groups on, so the highlight lands exactly on
    // the bead it marks. Derived from the one axis mapping above:
    //   (gx, gy, gz) -> (gx - cx, gz - minZ + lift, -gy + cy)
    var f = session.frame;
    g.position.set(-f.cx, PLATE_LIFT - f.minZ, f.cy);
    state.scene.add(g);
    session.overlay = g;
  }

  // Overlay geometry is built in the same Z-up millimetre space the moves live
  // in, then rotated to the app's Y-up view - the same mapping zUpToYUp() does
  // for imported meshes, so the highlight lands exactly on the model it marks.
  function setOverlayMoves(mesh, moves, grow) {
    var G = window.NSOGcodeLines;
    var acc = [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      G.extrudeFlatLine(grow ? {
        x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, z: m.z + grow,
        width: m.width + grow * 2, height: m.height + grow * 2
      } : m, acc);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc), 3));
    geo.rotateX(-Math.PI / 2);
    if (mesh.geometry) mesh.geometry.dispose();
    mesh.geometry = geo;
  }

  // =========================================================================
  // The scrub control
  // =========================================================================

  /** Moves on a layer, as [start, end) indices into session.moves. */
  function layerRange(li) {
    var L = session.layers[li];
    return L ? [L.moveStart, L.moveEnd] : [0, 0];
  }

  function layerOfCursor() {
    var m = session.moves[session.cursor];
    return m ? m.layer : 0;
  }

  /**
   * Point the scrub at one move. `i` is a GLOBAL move index, so stepping past
   * the last line of a layer rolls into the first line of the next - the
   * toolpath is one continuous path and the control follows it.
   */
  function setCursor(i) {
    if (!session) return;
    var n = session.moves.length;
    if (!n) return;
    session.cursor = Math.max(0, Math.min(n - 1, i | 0));
    var mv = session.moves[session.cursor];
    var lr = layerRange(mv.layer);

    if (session.overlay) {
      // Everything else on this layer, faint; the selected move, solid and
      // slightly grown so it reads on top of the model it sits in.
      var rest = [];
      for (var k = lr[0]; k < lr[1]; k++) if (k !== session.cursor) rest.push(session.moves[k]);
      setOverlayMoves(session.overlay.children[0], rest, 0);
      setOverlayMoves(session.overlay.children[1], [mv], 0.02);
      session.overlay.visible = true;
    }
    syncUI();
  }

  function stepMove(d) { setCursor(session.cursor + d); }

  function stepLayer(d) {
    if (!session) return;
    var li = Math.max(0, Math.min(session.layers.length - 1, layerOfCursor() + d));
    setCursor(session.layers[li].moveStart);
  }

  /** The move indices the user has scrubbed to, for extraction. */
  function selection() {
    if (!session) return null;
    var mode = ($('tp-scope') || {}).value || 'move';
    if (mode === 'move') return [session.cursor];
    var mv = session.moves[session.cursor];
    var out = [];
    if (mode === 'layer') {
      var lr = layerRange(mv.layer);
      for (var k = lr[0]; k < lr[1]; k++) out.push(k);
    } else { // 'feature' - this feature on this layer, which is the useful unit
      var lr2 = layerRange(mv.layer);
      for (var j = lr2[0]; j < lr2[1]; j++) {
        if (session.moves[j].feature === mv.feature) out.push(j);
      }
    }
    return out;
  }

  // =========================================================================
  // UI
  // =========================================================================

  function mountUI() {
    var card = $('toolpath-card');
    if (!card) return;
    card.classList.remove('hidden');
    if (card.dataset.wired === '1') return;
    card.dataset.wired = '1';

    var slider = $('tp-slider');
    if (slider) {
      slider.addEventListener('input', function () { setCursor(parseInt(slider.value, 10)); });
    }
    var num = $('tp-index');
    if (num) {
      num.addEventListener('change', function () { setCursor(parseInt(num.value, 10) || 0); });
    }
    var bind = [
      ['btn-tp-prev', function () { stepMove(-1); }],
      ['btn-tp-next', function () { stepMove(1); }],
      ['btn-tp-layer-down', function () { stepLayer(-1); }],
      ['btn-tp-layer-up', function () { stepLayer(1); }],
      ['btn-tp-extract', extractSelection]
    ];
    bind.forEach(function (b) {
      var el = $(b[0]);
      if (el) el.addEventListener('click', b[1]);
    });
    var scope = $('tp-scope');
    if (scope) scope.addEventListener('change', function () { setCursor(session.cursor); });

    // Arrow keys step lines, shift+arrows step layers - but only while the
    // card has focus, so they never fight the viewport's own bindings.
    card.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') { ev.shiftKey ? stepLayer(1) : stepMove(1); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { ev.shiftKey ? stepLayer(-1) : stepMove(-1); ev.preventDefault(); }
    });
  }

  function syncUI() {
    if (!session) return;
    var n = session.moves.length;
    var mv = session.moves[session.cursor];
    var lr = layerRange(mv.layer);

    var slider = $('tp-slider');
    if (slider) {
      slider.min = '0'; slider.max = String(n - 1); slider.step = '1';
      slider.value = String(session.cursor);
    }
    var num = $('tp-index');
    if (num && document.activeElement !== num) {
      num.min = '0'; num.max = String(n - 1); num.value = String(session.cursor);
    }
    var read = $('tp-readout');
    if (read) {
      read.textContent =
        'Line ' + (session.cursor + 1) + ' / ' + n +
        '  -  layer ' + (mv.layer + 1) + ' / ' + session.layers.length +
        ' (line ' + (session.cursor - lr[0] + 1) + ' / ' + (lr[1] - lr[0]) + ' on this layer)';
    }
    var det = $('tp-detail');
    if (det) {
      det.textContent =
        mv.feature + '  -  ' + mv.width.toFixed(3) + ' mm wide x ' + mv.height.toFixed(3) +
        ' mm tall, ' + mv.length.toFixed(2) + ' mm long, ' +
        (mv.angle * 180 / Math.PI).toFixed(1) + ' deg, Z ' + mv.z.toFixed(3);
    }
    var sel = selection();
    var btn = $('btn-tp-extract');
    if (btn && sel) {
      btn.textContent = 'Extract Line (' + sel.length + ' line' + (sel.length === 1 ? '' : 's') + ')';
    }
  }

  // =========================================================================
  // Extract - the scrubbed selection as its own standalone model
  // =========================================================================

  /**
   * Pull the scrubbed selection out as a new model of its own, exactly as
   * imported - same flat line solids, same widths, nothing re-fitted. It lands
   * in `state.models` through the ordinary ingest path, so it exports through
   * the ordinary Export / Download buttons with nothing else on the plate.
   */
  function extractSelection() {
    if (!session) { say('Import a sliced .gcode.3mf first', true); return null; }
    var G = window.NSOGcodeLines;
    var idx = selection();
    if (!idx || !idx.length) { say('Nothing scrubbed to extract', true); return null; }

    var moves = idx.map(function (i) { return session.moves[i]; });
    var built = G.buildLineGeometry(moves);
    if (!built.positions.length) { say('Extract Line failed - the selection has no geometry', true); return null; }

    var mv = session.moves[session.cursor];
    var label = baseName(session.file) + ' - ' + mv.feature +
                ' L' + (mv.layer + 1) + (moves.length === 1 ? ' line ' + (session.cursor + 1) : ' x' + moves.length);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
    var id = addModelFromZUpGeometry(label, geo);
    if (!id) { say('Extract Line failed - piece unchanged', true); return null; }
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
    }
    say('Extract Line ok - "' + label + '" is its own object (' + moves.length + ' line' +
        (moves.length === 1 ? '' : 's') + ', ' + (built.positions.length / 9) + ' triangles)');
    return id;
  }

  function reset() {
    disposeOverlay();
    session = null;
    var card = $('toolpath-card');
    if (card) card.classList.add('hidden');
  }

  return {
    looksSliced: looksSliced,
    importSliced3MF: importSliced3MF,
    setCursor: setCursor,
    stepMove: stepMove,
    stepLayer: stepLayer,
    selection: selection,
    extractSelection: extractSelection,
    reset: reset,
    getSession: function () { return session; }
  };
})();

if (typeof window !== 'undefined') window.NSO_TOOLPATH = NSO_TOOLPATH;
