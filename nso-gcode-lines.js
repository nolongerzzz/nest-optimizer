/*
 * NSO sliced-G-code toolpath reader
 * ---------------------------------
 * Turns an ALREADY-SLICED Bambu Studio project (`*.gcode.3mf`) into real,
 * editable NSO geometry: every extrusion move in `Metadata/plate_N.gcode`
 * becomes a flat line solid at the width and height that move actually prints
 * at, grouped by the slicer's own `; FEATURE:` tag.
 *
 * SCOPE - read this before extending it.
 * This is an IMPORTER AND RENDERER, nothing else. It reads a file the slicer
 * has already written and draws what is in it. It is NOT a slicer, it does not
 * run in real time, and it never tries to predict or reproduce what Bambu
 * Studio would decide. Input is always a sliced file out of Bambu Studio; if
 * the archive carries no plate G-code there is nothing here to do and the
 * reader says so rather than guessing.
 *
 * What it reads out of the archive:
 *
 *   Metadata/plate_1.gcode ...  the sliced toolpath (one part per plate)
 *
 * The ZIP walk is `NSO3MFRead.openZip()` - the same central-directory reader
 * the geometry importer uses, which inflates entries on demand, so nothing but
 * the one G-code part is ever touched.
 *
 * WIDTH AND HEIGHT ARE MEASURED, NOT ASSUMED
 * Each move's cross-section comes from that move's OWN extrusion:
 *
 *     volume  = dE * PI * (filament_diameter / 2)^2      dE from the G-code
 *     A       = volume / distance                        distance from X/Y
 *     A       = h * (w - h) + PI * h^2 / 4               stadium cross-section
 *  => w       = A / h + h * (1 - PI / 4)
 *
 * which is the exact inverse of the flow model the slicer used on the way in.
 * `filament_diameter` is read from the file's own trailing config comments, and
 * `h` from the file's own `; LAYER_HEIGHT:` where Bambu wrote one, otherwise
 * from the measured Z step between layers. Every move records which source its
 * height came from (`heightSource`) so a check can assert the file was read
 * rather than a default applied - see `meta.assumed`.
 *
 * No third-party dependencies, and the same code runs in the page and under
 * Node for tools/gcode-test.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSOGcodeLines = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DEFAULT_FILAMENT_DIAMETER = 1.75;   // mm, only if the file names none
  var DEFAULT_LAYER_HEIGHT = 0.2;         // mm, only if the file names none
  var ARC_SEGMENT_MM = 0.4;               // chord length when flattening G2/G3

  // ===========================================================================
  // Plate parts
  // ===========================================================================

  var PLATE_GCODE_RE = /^Metadata\/plate_(\d+)\.gcode$/i;

  /**
   * Plate G-code parts in a sliced 3MF, ascending by plate number.
   * @param {{names: function(): string[]}} zip  an NSO3MFRead.openZip() handle
   * @returns {{name: string, plate: number}[]}
   */
  function listPlateGcode(zip) {
    var out = [];
    zip.names().forEach(function (n) {
      var m = PLATE_GCODE_RE.exec(n);
      if (m) out.push({ name: n, plate: parseInt(m[1], 10) });
    });
    out.sort(function (a, b) { return a.plate - b.plate; });
    return out;
  }

  // ===========================================================================
  // Comment tags Bambu Studio writes
  // ===========================================================================

  var RE_FEATURE      = /^\s*;\s*(?:FEATURE|TYPE)\s*:\s*(.+?)\s*$/i;
  var RE_Z_HEIGHT     = /^\s*;\s*Z_HEIGHT\s*:\s*([-+]?[\d.]+)\s*$/i;
  var RE_LAYER_HEIGHT = /^\s*;\s*LAYER_HEIGHT\s*:\s*([-+]?[\d.]+)\s*$/i;
  var RE_CHANGE_LAYER = /^\s*;\s*(?:CHANGE_LAYER|LAYER_CHANGE)\s*$/i;
  var RE_LAYER_NUM    = /^\s*;\s*layer\s+num\/total_layer_count\s*:\s*(\d+)/i;
  var RE_FILAMENT_D   = /^\s*;\s*filament_diameter\s*=\s*([\d.]+)/i;
  var RE_OBJECT_ID    = /^\s*;\s*OBJECT_ID\s*:\s*(\d+)\s*$/i;

  // A word out of a G-code line: letter + signed number. Comments are stripped
  // first, so a `;` inside a parameter is not a concern.
  var RE_WORD = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

  function codePart(line) {
    var i = line.indexOf(';');
    return i === -1 ? line : line.slice(0, i);
  }

  function words(code) {
    var out = {};
    RE_WORD.lastIndex = 0;
    var m;
    while ((m = RE_WORD.exec(code)) !== null) {
      out[m[1].toUpperCase()] = parseFloat(m[2]);
    }
    return out;
  }

  // ===========================================================================
  // Flow model
  // ===========================================================================

  /**
   * Extruded width for one move, from that move's own numbers.
   * Inverse of the slicer's stadium cross-section: A = h(w-h) + PI h^2 / 4.
   *
   * @param {number} dE      filament advanced, mm
   * @param {number} dist    XY distance travelled, mm
   * @param {number} h       layer height, mm
   * @param {number} filD    filament diameter, mm
   * @returns {number} width in mm, or 0 when the move cannot have a width
   */
  function widthFromExtrusion(dE, dist, h, filD) {
    if (!(dE > 0) || !(dist > 0) || !(h > 0) || !(filD > 0)) return 0;
    var area = (dE * Math.PI * filD * filD / 4) / dist;   // mm^2 per mm of path
    var w = area / h + h * (1 - Math.PI / 4);
    return w > 0 ? w : 0;
  }

  /**
   * Cross-section area of a stadium-profile line - the forward direction of
   * `widthFromExtrusion`, kept beside it so a check can round-trip the pair.
   */
  function areaFromWidth(w, h) {
    if (!(w > 0) || !(h > 0)) return 0;
    return h * (w - h) + Math.PI * h * h / 4;
  }

  // ===========================================================================
  // Parser
  // ===========================================================================

  /**
   * Walk a sliced G-code file and collect its real extrusion moves.
   *
   * @param {string} text          the whole plate G-code
   * @param {object} [opts]
   * @param {number} [opts.filamentDiameter]  override; normally read from the file
   * @returns {{moves: object[], layers: object[], features: object[],
   *            meta: object, warnings: string[]}}
   */
  function parseGcode(text, opts) {
    opts = opts || {};
    var warnings = [];
    var lines = String(text).split(/\r\n|\n|\r/);

    // --- machine state -----------------------------------------------------
    var absXYZ = true;        // G90 / G91
    var absE = true;          // M82 / M83 - Bambu writes M83, but do not assume
    var sawEMode = false;
    var x = 0, y = 0, z = 0, e = 0;
    var havePos = false;

    // --- file-declared settings -------------------------------------------
    var filD = 0;
    var layerHeightTag = 0;   // most recent ; LAYER_HEIGHT:
    var zHeightTag = 0;       // most recent ; Z_HEIGHT:
    var prevLayerZ = 0;
    var haveLayerZ = false;

    // --- grouping ----------------------------------------------------------
    var feature = '';
    var objectId = null;
    var layerIndex = -1;
    var moves = [];
    var layers = [];
    var heightSourceCount = { tag: 0, zstep: 0, firstLayer: 0, fallback: 0 };

    // --- continuous extrusion runs -----------------------------------------
    // `run` numbers the stretches the nozzle printed without stopping. It is
    // bumped by the first thing that genuinely interrupts the bead: a motion
    // with no positive E (a travel, a wipe, a Z hop or a layer's Z step), a
    // retraction (negative E, with or without motion), or a G92 that moves
    // the position. Nothing else - a feed-rate line, an M-code, a FEATURE tag
    // or an E-only prime is not a stop, and the bead carries on through it.
    // The solid reconstruction (nso-gcode-solid.js) caps a sweep only where
    // this says a run begins or ends.
    var run = 0;
    var runOpen = false;
    var runBreaks = { travel: 0, retract: 0, zmove: 0, reposition: 0 };
    function breakRun(why) {
      if (!runOpen) return;
      run++;
      runOpen = false;
      runBreaks[why]++;
    }

    function currentLayer() {
      if (layerIndex < 0) {
        layers.push({ index: 0, z: z, height: 0, moveStart: moves.length, moveEnd: moves.length });
        layerIndex = 0;
      }
      return layers[layerIndex];
    }

    // Height for a move landing at printing height `atZ`, in the order the
    // file's own evidence allows.
    function heightAt(atZ) {
      if (layerHeightTag > 0) return { h: layerHeightTag, src: 'tag' };
      if (haveLayerZ) {
        var d = atZ - prevLayerZ;
        if (d > 1e-6) return { h: d, src: 'zstep' };
      }
      if (atZ > 1e-6 && layers.length <= 1) return { h: atZ, src: 'firstLayer' };
      return { h: DEFAULT_LAYER_HEIGHT, src: 'fallback' };
    }

    function pushMove(x0, y0, x1, y1, atZ, dE) {
      var dx = x1 - x0, dy = y1 - y0;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (!(dist > 1e-9)) return;                       // retract / prime, not a line
      var hh = heightAt(atZ);
      var w = widthFromExtrusion(dE, dist, hh.h, filD || DEFAULT_FILAMENT_DIAMETER);
      if (!(w > 0)) return;
      var lay = currentLayer();
      moves.push({
        index: moves.length,
        x0: x0, y0: y0, x1: x1, y1: y1,
        z: atZ,
        e: dE,
        length: dist,
        width: w,
        height: hh.h,
        heightSource: hh.src,
        angle: Math.atan2(dy, dx),
        feature: feature || 'Unknown',
        objectId: objectId,
        layer: lay.index,
        run: run
      });
      runOpen = true;
      heightSourceCount[hh.src]++;
      lay.moveEnd = moves.length;
      if (!(lay.height > 0)) lay.height = hh.h;
    }

    // Flatten a G2/G3 arc into chords. Bambu emits these when arc fitting is
    // on; the extrusion is spread over the arc by length, same as the firmware.
    function pushArc(x0, y0, x1, y1, i, j, cw, atZ, dE) {
      var cx = x0 + i, cy = y0 + j;
      var r = Math.sqrt(i * i + j * j);
      if (!(r > 1e-9)) { pushMove(x0, y0, x1, y1, atZ, dE); return; }
      var a0 = Math.atan2(y0 - cy, x0 - cx);
      var a1 = Math.atan2(y1 - cy, x1 - cx);
      var sweep = a1 - a0;
      if (cw) { while (sweep >= 0) sweep -= 2 * Math.PI; }
      else    { while (sweep <= 0) sweep += 2 * Math.PI; }
      var arcLen = Math.abs(sweep) * r;
      var n = Math.max(1, Math.ceil(arcLen / ARC_SEGMENT_MM));
      var px = x0, py = y0;
      for (var k = 1; k <= n; k++) {
        var a = a0 + sweep * (k / n);
        var qx = cx + r * Math.cos(a), qy = cy + r * Math.sin(a);
        // The last chord ends on the commanded end point itself, not on the
        // circle evaluated there: the two differ in the last bits, and the
        // next move starts from the commanded point, so anything else leaves
        // a sub-nanometre step between two moves that are one bead.
        if (k === n) { qx = x1; qy = y1; }
        pushMove(px, py, qx, qy, atZ, dE / n);
        px = qx; py = qy;
      }
    }

    for (var li = 0; li < lines.length; li++) {
      var raw = lines[li];
      if (!raw) continue;

      // ---- comment tags ----
      var m;
      if ((m = RE_FEATURE.exec(raw)) !== null) { feature = m[1]; continue; }
      if ((m = RE_LAYER_HEIGHT.exec(raw)) !== null) { layerHeightTag = parseFloat(m[1]); continue; }
      if ((m = RE_OBJECT_ID.exec(raw)) !== null) { objectId = parseInt(m[1], 10); continue; }
      if ((m = RE_FILAMENT_D.exec(raw)) !== null) {
        var d = parseFloat(m[1]);
        if (d > 0) filD = d;
        continue;
      }
      if ((m = RE_Z_HEIGHT.exec(raw)) !== null) {
        var zt = parseFloat(m[1]);
        if (haveLayerZ && layers.length) prevLayerZ = layers[layers.length - 1].z;
        zHeightTag = zt;
        continue;
      }
      if (RE_CHANGE_LAYER.test(raw) || RE_LAYER_NUM.test(raw)) {
        if (RE_LAYER_NUM.test(raw)) continue;            // informational only
        // A new layer starts empty; its Z arrives with the next Z_HEIGHT or G1 Z.
        if (layers.length) prevLayerZ = layers[layers.length - 1].z;
        haveLayerZ = layers.length > 0;
        layers.push({
          index: layers.length,
          z: zHeightTag || z,
          height: 0,
          moveStart: moves.length,
          moveEnd: moves.length
        });
        layerIndex = layers.length - 1;
        layerHeightTag = 0;                              // re-read per layer
        continue;
      }

      var code = codePart(raw);
      if (!/[A-Za-z]/.test(code)) continue;

      // ---- modal state ----
      if (/^\s*G90(\D|$)/i.test(code)) { absXYZ = true; continue; }
      if (/^\s*G91(\D|$)/i.test(code)) { absXYZ = false; continue; }
      if (/^\s*M82(\D|$)/i.test(code)) { absE = true; sawEMode = true; continue; }
      if (/^\s*M83(\D|$)/i.test(code)) { absE = false; sawEMode = true; continue; }
      if (/^\s*G92(\D|$)/i.test(code)) {
        var g92 = words(code);
        if (g92.E !== undefined) e = g92.E;
        if (g92.X !== undefined) x = g92.X;
        if (g92.Y !== undefined) y = g92.Y;
        if (g92.Z !== undefined) z = g92.Z;
        if (g92.X !== undefined || g92.Y !== undefined || g92.Z !== undefined) breakRun('reposition');
        continue;
      }

      var gm = /^\s*G([0-3])(\D|$)/i.exec(code);
      if (!gm) continue;
      var g = parseInt(gm[1], 10);
      var w2 = words(code);

      var nx = w2.X !== undefined ? (absXYZ ? w2.X : x + w2.X) : x;
      var ny = w2.Y !== undefined ? (absXYZ ? w2.Y : y + w2.Y) : y;
      var nz = w2.Z !== undefined ? (absXYZ ? w2.Z : z + w2.Z) : z;

      var dE = 0;
      if (w2.E !== undefined) {
        dE = absE ? (w2.E - e) : w2.E;
        e = absE ? w2.E : e + w2.E;
      }

      var extruding = havePos && dE > 0 && (g === 1 || g === 2 || g === 3);
      if (!extruding) {
        if (dE < 0) breakRun('retract');
        else if (nz !== z) breakRun('zmove');
        else if (nx !== x || ny !== y) breakRun('travel');
      }
      if (extruding) {
        // The move prints at the Z it ends at; the layer's Z_HEIGHT tag wins
        // where the file gave one, because a Z hop lands mid-move otherwise.
        var atZ = zHeightTag > 0 ? zHeightTag : nz;
        var lay0 = currentLayer();
        if (!(lay0.z > 0)) lay0.z = atZ;
        if (g === 1) {
          pushMove(x, y, nx, ny, atZ, dE);
        } else {
          pushArc(x, y, nx, ny, w2.I || 0, w2.J || 0, g === 2, atZ, dE);
        }
      }

      x = nx; y = ny; z = nz;
      havePos = true;
    }

    // Drop layers that never printed anything, and renumber so the slider's
    // indices are contiguous.
    var kept = [];
    layers.forEach(function (L) {
      if (L.moveEnd > L.moveStart) { L.index = kept.length; kept.push(L); }
    });
    kept.forEach(function (L) {
      for (var k = L.moveStart; k < L.moveEnd; k++) moves[k].layer = L.index;
    });

    // Feature groups, in the order the slicer printed them.
    var byName = new Map();
    moves.forEach(function (mv) {
      var g2 = byName.get(mv.feature);
      if (!g2) { g2 = { name: mv.feature, moves: [], length: 0 }; byName.set(mv.feature, g2); }
      g2.moves.push(mv.index);
      g2.length += mv.length;
    });
    var features = Array.from(byName.values());

    if (!filD) warnings.push('filament_diameter not in the file - assumed ' + DEFAULT_FILAMENT_DIAMETER + ' mm');
    if (!sawEMode) warnings.push('neither M82 nor M83 seen - E read as absolute');
    if (heightSourceCount.fallback) {
      warnings.push(heightSourceCount.fallback + ' move(s) had no layer height in the file - assumed ' +
                    DEFAULT_LAYER_HEIGHT + ' mm');
    }
    if (!moves.length) warnings.push('no extrusion moves found');

    return {
      moves: moves,
      layers: kept,
      features: features,
      meta: {
        filamentDiameter: filD || DEFAULT_FILAMENT_DIAMETER,
        filamentDiameterFromFile: !!filD,
        absoluteE: absE,
        eModeFromFile: sawEMode,
        heightSources: heightSourceCount,
        // How many continuous extrusion runs the file breaks into, and what
        // broke them. `runCount` is one past the highest `run` on a move.
        runCount: moves.length ? moves[moves.length - 1].run + 1 : 0,
        runBreaks: runBreaks,
        // True when anything at all fell back to a constant rather than the
        // file's own numbers. Checks assert this is false on a real slice.
        assumed: !filD || !sawEMode || heightSourceCount.fallback > 0,
        layerCount: kept.length,
        moveCount: moves.length
      },
      warnings: warnings
    };
  }

  // ===========================================================================
  // Geometry - one flat line solid per move
  // ===========================================================================

  /**
   * The printed solid for a single extrusion move: a closed box `width` across,
   * `height` tall, hanging below the move's Z (the nozzle's Z is the TOP of the
   * bead), swept along the move. 12 triangles, outward normals, Z up in
   * millimetres - the same shape and axes STLLoader hands the app, so the
   * result goes through addModelFromZUpGeometry() like any other import.
   *
   * @param {object} mv    a move from parseGcode()
   * @param {Float32Array|number[]} out  appended to
   * @returns {typeof out}
   */
  function extrudeFlatLine(mv, out) {
    out = out || [];
    var dx = mv.x1 - mv.x0, dy = mv.y1 - mv.y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 1e-9) || !(mv.width > 0) || !(mv.height > 0)) return out;
    var ux = dx / len, uy = dy / len;      // along
    var px = -uy, py = ux;                 // across
    var hw = mv.width / 2;
    var zTop = mv.z, zBot = mv.z - mv.height;

    // Corners: 0..3 bottom (start-left, start-right, end-right, end-left),
    // 4..7 the same at the top.
    var c = [
      [mv.x0 - px * hw, mv.y0 - py * hw, zBot],
      [mv.x0 + px * hw, mv.y0 + py * hw, zBot],
      [mv.x1 + px * hw, mv.y1 + py * hw, zBot],
      [mv.x1 - px * hw, mv.y1 - py * hw, zBot],
      [mv.x0 - px * hw, mv.y0 - py * hw, zTop],
      [mv.x0 + px * hw, mv.y0 + py * hw, zTop],
      [mv.x1 + px * hw, mv.y1 + py * hw, zTop],
      [mv.x1 - px * hw, mv.y1 - py * hw, zTop]
    ];

    // Wound counter-clockwise seen from OUTSIDE, so face normals point out and
    // the shell has positive signed volume - an inward winding here exports as
    // an inside-out STL, which the checks below pin down.
    var faces = [
      [0, 2, 3], [0, 1, 2],   // bottom (normal -Z)
      [4, 6, 5], [4, 7, 6],   // top    (normal +Z)
      [0, 5, 1], [0, 4, 5],   // start cap
      [2, 7, 3], [2, 6, 7],   // end cap
      [1, 6, 2], [1, 5, 6],   // +across side
      [3, 4, 0], [3, 7, 4]    // -across side
    ];
    for (var f = 0; f < faces.length; f++) {
      for (var v = 0; v < 3; v++) {
        var p = c[faces[f][v]];
        out.push(p[0], p[1], p[2]);
      }
    }
    return out;
  }

  var TRIS_PER_MOVE = 12;
  var FLOATS_PER_MOVE = TRIS_PER_MOVE * 9;

  /**
   * Flat-line geometry for a set of moves, as one non-indexed position array.
   * Triangles come out in move order, `TRIS_PER_MOVE` per move, so a caller can
   * map any triangle back to the move that printed it (see `moveOfTriangle`).
   *
   * @param {object[]} moves
   * @returns {{positions: Float32Array, moveIds: Int32Array, trisPerMove: number}}
   */
  function buildLineGeometry(moves) {
    var acc = [];
    var ids = [];
    for (var i = 0; i < moves.length; i++) {
      var before = acc.length;
      extrudeFlatLine(moves[i], acc);
      if (acc.length > before) ids.push(moves[i].index);
    }
    return {
      positions: new Float32Array(acc),
      moveIds: new Int32Array(ids),
      trisPerMove: TRIS_PER_MOVE
    };
  }

  function moveOfTriangle(built, triIndex) {
    var k = Math.floor(triIndex / TRIS_PER_MOVE);
    return (k >= 0 && k < built.moveIds.length) ? built.moveIds[k] : -1;
  }

  // ===========================================================================
  // Z-height filtering - one layer in true isolation
  // ===========================================================================
  //
  // Feature grouping alone answers "which moves are Outer wall". It does NOT
  // answer "which moves are Outer wall ON THIS LAYER": a feature group is every
  // move of that feature at every height, so 73 layers of wall arrive stacked
  // and overlaid and a single layer's construction cannot be read off it, let
  // alone selected. The filter below adds the missing axis.
  //
  // A move prints at one Z (the nozzle Z, which is the TOP of its bead), so a
  // window is a Z interval and a move is in it when its printing Z is inside.
  // Testing the printing Z and not the bead's span is deliberate: the bead
  // hangs DOWN into the layer below, so a span test would pull every layer's
  // beads into its neighbour's window and defeat the isolation.
  //
  // The window is the same shape the reference capture box in
  // `docs/reference/joint_microscope_3d.html` uses - a centre and a vertical
  // half-extent, `|mz - cz| <= h` - so a window can be one layer or a slab
  // several layers thick, and one layer is just the case where it is tight.

  var Z_EPS = 1e-6;    // mm; Z values come out of text, so compare with slack

  /**
   * A Z window. `zLo`/`zHi` are inclusive bounds on a move's printing Z.
   * @param {number} zLo
   * @param {number} zHi
   * @returns {{zLo: number, zHi: number}}
   */
  function zWindow(zLo, zHi) {
    return zLo <= zHi ? { zLo: zLo, zHi: zHi } : { zLo: zHi, zHi: zLo };
  }

  /**
   * The window a centre and a vertical half-extent describe - the reference
   * capture box's `|mz - cz| <= h` written as an interval.
   */
  function zWindowAround(z, half) {
    var h = half > 0 ? half : 0;
    return zWindow(z - h, z + h);
  }

  /**
   * The window that holds exactly one layer and nothing else: that layer's own
   * printing Z, with only comparison slack either side.
   * @param {object} parsed  a parseGcode() result
   * @param {number} li      layer index
   * @returns {{zLo: number, zHi: number}|null}
   */
  function layerZWindow(parsed, li) {
    var L = parsed && parsed.layers && parsed.layers[li];
    if (!L) return null;
    // The layer's Z as its own moves report it, not the CHANGE_LAYER tag's
    // guess - the moves are what the window has to match.
    var z = L.z;
    for (var i = L.moveStart; i < L.moveEnd; i++) {
      if (parsed.moves[i]) { z = parsed.moves[i].z; break; }
    }
    return zWindow(z - Z_EPS, z + Z_EPS);
  }

  /** True when a move prints inside the window. */
  function moveInZWindow(mv, win) {
    if (!mv || !win) return false;
    return mv.z >= win.zLo - Z_EPS && mv.z <= win.zHi + Z_EPS;
  }

  /** The moves of a list that print inside the window, in path order. */
  function movesInZWindow(moves, win) {
    var out = [];
    if (!moves || !win) return out;
    for (var i = 0; i < moves.length; i++) {
      if (moveInZWindow(moves[i], win)) out.push(moves[i]);
    }
    return out;
  }

  /**
   * The distinct printing heights in the file, ascending. On a real Bambu slice
   * this is one Z per layer - `tools/gcode-test/gcode-zfilter-check.js` asserts
   * that 1:1 against the two committed real files.
   */
  function zLevels(parsed) {
    var seen = [];
    var moves = (parsed && parsed.moves) || [];
    for (var i = 0; i < moves.length; i++) {
      var z = moves[i].z;
      var found = false;
      for (var k = 0; k < seen.length; k++) {
        if (Math.abs(seen[k] - z) <= Z_EPS) { found = true; break; }
      }
      if (!found) seen.push(z);
    }
    seen.sort(function (a, b) { return a - b; });
    return seen;
  }

  /** The layer whose printing Z is nearest `z`, or -1 when there are none. */
  function layerIndexAtZ(parsed, z) {
    var layers = (parsed && parsed.layers) || [];
    var best = -1, bestD = Infinity;
    for (var i = 0; i < layers.length; i++) {
      var w = layerZWindow(parsed, i);
      if (!w) continue;
      var d = Math.abs((w.zLo + w.zHi) / 2 - z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Group an arbitrary move list by feature, in the order the slicer printed
   * them - the same shape `parseGcode()` puts in `features`, so a Z-filtered
   * grouping and an unfiltered one are interchangeable to a caller.
   */
  function groupMovesByFeature(moves) {
    var byName = new Map();
    var order = [];
    (moves || []).forEach(function (mv) {
      var g = byName.get(mv.feature);
      if (!g) {
        g = { name: mv.feature, moves: [], length: 0 };
        byName.set(mv.feature, g);
        order.push(g);
      }
      g.moves.push(mv.index);
      g.length += mv.length;
    });
    return order;
  }

  /**
   * Feature groups restricted to a Z window, each with its flat-line geometry
   * already built - the Z-filtered counterpart of `readSlicedGcode3MF()`'s
   * `groups`. This is the isolation unit: one layer of one feature, with every
   * other layer of that same feature left out.
   *
   * @param {object} parsed  a parseGcode() result
   * @param {{zLo: number, zHi: number}} win
   * @returns {{name: string, moves: object[], built: object}[]}
   */
  function featuresInZWindow(parsed, win) {
    var kept = movesInZWindow((parsed && parsed.moves) || [], win);
    var out = [];
    groupMovesByFeature(kept).forEach(function (g) {
      var mvs = g.moves.map(function (i) { return parsed.moves[i]; });
      out.push({ name: g.name, moves: mvs, length: g.length, built: buildLineGeometry(mvs) });
    });
    return out;
  }

  /**
   * Every move at one printing height, whatever feature printed it - the
   * extraction unit: a whole layer at one Z, all features at that height.
   */
  function movesAtZ(parsed, z) {
    return movesInZWindow((parsed && parsed.moves) || [], zWindow(z - Z_EPS, z + Z_EPS));
  }

  // ===========================================================================
  // The feature categories a Bambu slice names
  // ===========================================================================
  //
  // Grouping is data-driven - whatever string follows `; FEATURE:` becomes a
  // group - so the reader never has to be taught a new category. This table
  // adds nothing to that; it only gives the categories the reference tool
  // isolates a stable colour, so a Z-filtered layer reads the same way there
  // and here. An unlisted feature still groups, and draws in `OTHER_COLOR`.
  //
  // `Travel` is in the table for completeness and can never appear in a group:
  // a travel carries no extrusion, so it has no width and no bead, and
  // `pushMove()` drops it. See docs/GCODE-FEATURE-AUDIT.md.

  var FEATURE_COLORS = {
    'Bottom surface':          0x8f8f8f,
    'Bridge':                  0xc25bd1,
    'Floating vertical shell': 0xf5d76e,
    'Gap infill':              0x7a7a7a,
    'Inner wall':              0x5bb3ff,
    'Internal solid infill':   0x3aa66f,
    'Outer wall':              0x5b8cff,
    'Overhang wall':           0xe05bcf,
    'Sparse infill':           0x4ecf8f,
    'Support':                 0xff6b5b,
    'Support interface':       0xff9d4d,
    'Top surface':             0xc9c9c9,
    'Custom':                  0x999999,
    'Travel':                  0xffffff
  };
  var OTHER_COLOR = 0x666666;

  /** The colour for a feature name; `OTHER_COLOR` for one not in the table. */
  function colorForFeature(name) {
    return Object.prototype.hasOwnProperty.call(FEATURE_COLORS, name)
      ? FEATURE_COLORS[name] : OTHER_COLOR;
  }

  // ===========================================================================
  // Top level: a sliced 3MF in, groups of flat-line geometry out
  // ===========================================================================

  /**
   * Read the toolpath out of a sliced Bambu Studio project.
   *
   * @param {Uint8Array} bytes
   * @param {object} [opts]
   * @param {number} [opts.plate]  plate number; default the lowest present
   * @param {string} [opts.name]   file name, for messages
   * @returns {Promise<{plate: number, part: string, parsed: object,
   *                    groups: {name: string, moves: object[], built: object}[],
   *                    warnings: string[]}>}
   */
  function readSlicedGcode3MF(bytes, opts) {
    opts = opts || {};
    var zipOpen = (root && root.NSO3MFRead && root.NSO3MFRead.openZip) ||
                  (typeof require === 'function' ? require('./nso-3mf-read.js').openZip : null);
    if (!zipOpen) return Promise.reject(new Error('NSO3MFRead is not loaded - it owns the ZIP reader'));

    var zip;
    try { zip = zipOpen(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    catch (err) { return Promise.reject(err); }

    var parts = listPlateGcode(zip);
    if (!parts.length) {
      return Promise.reject(new Error(
        'No sliced toolpath in this 3MF. Slice the project in Bambu Studio and save ' +
        'it as a .gcode.3mf - a plain project has no Metadata/plate_N.gcode.'));
    }
    var pick = parts[0];
    if (opts.plate != null) {
      var want = parts.filter(function (p) { return p.plate === opts.plate; })[0];
      if (!want) return Promise.reject(new Error('Plate ' + opts.plate + ' is not in this file'));
      pick = want;
    }

    return zip.read(pick.name).then(function (raw) {
      var text = new TextDecoder().decode(raw);
      var parsed = parseGcode(text, opts);
      var groups = parsed.features.map(function (f) {
        var mvs = f.moves.map(function (i) { return parsed.moves[i]; });
        return { name: f.name, moves: mvs, built: buildLineGeometry(mvs) };
      });
      return {
        plate: pick.plate,
        part: pick.name,
        plates: parts.map(function (p) { return p.plate; }),
        parsed: parsed,
        groups: groups,
        warnings: parsed.warnings
      };
    });
  }

  return {
    listPlateGcode: listPlateGcode,
    parseGcode: parseGcode,
    widthFromExtrusion: widthFromExtrusion,
    areaFromWidth: areaFromWidth,
    extrudeFlatLine: extrudeFlatLine,
    buildLineGeometry: buildLineGeometry,
    moveOfTriangle: moveOfTriangle,
    readSlicedGcode3MF: readSlicedGcode3MF,
    zWindow: zWindow,
    zWindowAround: zWindowAround,
    layerZWindow: layerZWindow,
    moveInZWindow: moveInZWindow,
    movesInZWindow: movesInZWindow,
    movesAtZ: movesAtZ,
    zLevels: zLevels,
    layerIndexAtZ: layerIndexAtZ,
    groupMovesByFeature: groupMovesByFeature,
    featuresInZWindow: featuresInZWindow,
    colorForFeature: colorForFeature,
    FEATURE_COLORS: FEATURE_COLORS,
    OTHER_COLOR: OTHER_COLOR,
    Z_EPS: Z_EPS,
    TRIS_PER_MOVE: TRIS_PER_MOVE,
    FLOATS_PER_MOVE: FLOATS_PER_MOVE,
    DEFAULT_FILAMENT_DIAMETER: DEFAULT_FILAMENT_DIAMETER
  };
});
