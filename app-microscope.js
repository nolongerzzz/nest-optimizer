/*
 * G-scope (the Microscope view) - the reference tool, lifted, with a way in
 * and a way out. The ONE G-code tool: the rail button and every sliced import
 * land here, and nowhere else.
 * ----------------------------------------------------------------------------
 *
 * `docs/reference/joint_microscope_3d.html` is a working standalone G-code
 * inspector kept in this repo as reference material. Its view is good and this
 * file does not redesign it: the overview build, the capture-box interaction,
 * the legend, Isolate, Back and the animation loop below are that tool's code,
 * lifted. What the reference tool has never had is an import and an export -
 * it opens one slice baked into its own source, and its only way out is
 * `Export .json`. That gap is what this file closes.
 *
 * READ docs/GCODE-MICROSCOPE.md FIRST. It carries the audit this is built on,
 * including the one place the port deviates from the reference tool on purpose.
 *
 * WHAT IS REUSED, AND WHAT IS NOT
 *
 *   rendering   REUSED, essentially verbatim - see the banner below. Every
 *               three.js call the reference tool makes is unchanged between
 *               the r128 it loads and the r147 this app serves.
 *   parsing     NOT REUSED, because the reference tool HAS NO PARSER. Its
 *               `SEGMENTS` is a 4.78 MB baked literal out of one slice, and
 *               nothing that produced it was ever committed. `parseGcode()`
 *               in nso-gcode-lines.js is the parser, and it already emits the
 *               reference tool's exact segment schema - two field renames
 *               (`w` <- `width`, `obj` <- `objectId`) and nothing missing.
 *   geometry    extrudeFlatLine(), unchanged. The reference renderer draws the
 *               VIEW; extrudeFlatLine builds the EXPORT. Its detail view is
 *               one cylinder per move - the same one-primitive-per-move
 *               construction, round instead of rectangular - and a cylinder is
 *               neither the right cross-section for a bead nor exportable as
 *               the shape that prints.
 *
 * THE ONE DELIBERATE DEVIATION
 * The reference tool's axis map is `toThree(x,y,z) -> (x, z, y)`, determinant
 * -1: a reflection, so it draws every slice MIRRORED. That is invisible in a
 * tool whose only output is JSON of the original numbers. It is not invisible
 * here, because Export to plate and Export as STL would both hand back a
 * mirrored part. So the view uses the app's own `zUpToYUp()` mapping,
 * `(x, y, z) -> (x, z, -y)`, determinant +1. One sign. Nothing a user touches
 * changes. (A second, smaller one: the camera frames the loaded file instead of
 * sitting at the fixed distance the reference tool hard-codes for its own baked
 * part - which its own comment marks as unfinished, "will refine after
 * centering".)
 *
 * TWO KINDS OF DOCUMENT
 *   'toolpath'  a sliced `.gcode.3mf`. Segments, feature colours, real layers.
 *   'mesh'      triangles in named groups, no layers and no features, because
 *               the source has none. See docs/GCODE-MICROSCOPE.md for why
 *               full-layer selection is refused rather than faked, and why the
 *               capture box selects whole objects rather than loose triangles.
 *
 * THREE SOURCES, ONE VIEW
 * A document's KIND is what it holds; its SOURCE is where it came from, and
 * the view does not care. A mesh document can be built from
 *   a file        an STL or a plain 3MF - one group per build object, an STL
 *                 being one object because the format has no object structure;
 *   the plate     `openPlate()` - one group per placed piece, read through
 *                 meshToWorldSoup, so the microscope button is an OVERLAY on
 *                 whatever is already there, exactly as X-ray is, and not a
 *                 door to a file dialog;
 *   any producer  `openObjects()` - any named Z-up triangle groups at all.
 * The third is the seam the support-isolation work grows through: a producer
 * that splits one support tree into its branches, or lifts one interface
 * layer out of a print, hands its groups to `openObjects()` and inherits the
 * legend, the capture box, Isolate and both exports with no change here.
 * Gen+ -> Picture (app-relief.js) is one: its slab opens here BEFORE it is a
 * piece, and the seam's two optional hooks give it a Back button to the card
 * and a say in where Export to plate seats the slab.
 *
 * WHERE A `.gcode.3mf` LANDS
 * Importing one puts you in this view, coloured by feature, without a button
 * press - app-core.js's `handleFiles()` asks `isSliced()` (by CONTENT: the
 * archive holds `Metadata/plate_N.gcode`) and hands the bytes to `openFile()`.
 * Nothing goes onto the plate: the old plate-side importer (app-toolpath.js,
 * the G🔬 #btn-gcode door and the sidebar Toolpath card) was merged into this
 * view and removed. Its line scrub is `Pick a line` here; its Z filter is the
 * layer-range slider; its Extract is Export.
 *
 * G-SCOPE ADDITIONS (docs/GCODE-MICROSCOPE.md, "G-scope")
 *   view filters  legend (with "only"), Clear from view, the layer-range
 *                 slider. VIEW ONLY - none of them writes to `state`.
 *   line picking  one move at a time, isolated as its extrudeFlatLine prism.
 *   Take band     the slider's Z band, isolated as one piece (Select > Layer).
 *   the seam      setSelection() / selectionRegion() / onSelection() - where a
 *                 later support-generation step reads what was isolated.
 *
 * SCOPE
 * A VIEW plus an import and an export. Nothing here slices, nothing here
 * repairs, and nothing here writes to a model already on the plate. Export to
 * plate goes through `addModelFromZUpGeometry()` with `pushUndo()`, the same
 * two calls `NSO_TOOLPATH.extractSelection()` makes, so a piece that arrives
 * this way is an ordinary NSO model from that point on.
 */
/* global THREE, state, setStatus, addModelFromZUpGeometry, pushUndo,
          geometryToBinarySTL, downloadBlob, loader, meshToWorldSoup */
'use strict';

var NSO_MICROSCOPE = (function () {
  'use strict';

  // The three.js world, built once on first open and kept. Its animation loop
  // only runs while the panel is visible, so a closed microscope costs nothing
  // but the context it is holding.
  var view = null;

  // The loaded document. One at a time: two files in one microscope has no
  // meaning, exactly as one toolpath at a time has none in app-toolpath.js.
  var doc = null;

  function $(id) { return document.getElementById(id); }

  function say(msg, isErr) {
    if (typeof setStatus === 'function') setStatus(msg, !!isErr);
    else if (isErr) console.error(msg); else console.log(msg);
  }

  /** The panel's own status line, which stays readable with the panel open. */
  var infoBase = '';          // what the selection (or the document) says
  var infoLine = null;        // the move a hover is reading out over it, or null
  function info(html) {
    infoBase = html;
    infoLine = null;            // a new word on the selection is read until the next hover
    var el = $('ms-info');
    if (el) el.innerHTML = html;
  }

  /**
   * Line's readout (it was SELECT > Line's): the move under the pointer, on a
   * slice, read out in SELECTION / SEGMENT INFO while it is hovered - in any
   * mode; off it, the box says what it said before. Nothing is picked.
   */
  function hoverLine(seg) {
    var el = $('ms-info');
    if (seg && doc && doc.kind === 'toolpath' && seg.mv) {
      if (infoLine === seg) return;
      infoLine = seg;
      if (el) el.innerHTML = describeLine(seg);
    } else if (infoLine != null) {
      infoLine = null;
      if (el) el.innerHTML = infoBase;
    }
  }

  function baseName(n) {
    return String(n).replace(/\.gcode\.3mf$/i, '').replace(/\.(stl|3mf)$/i, '');
  }

  // Colours for the mesh route. The toolpath route uses the slicer's own
  // feature table (NSOGcodeLines.colorForFeature) and never this.
  var OBJECT_COLORS = [
    0x5b8cff, 0x4ecf8f, 0xff9d4d, 0xc25bd1, 0xf5d76e,
    0x5bb3ff, 0x3aa66f, 0xff6b5b, 0xe05bcf, 0xc9c9c9
  ];

  function colorForGroup(name, i) {
    var G = window.NSOGcodeLines;
    if (doc && doc.kind === 'toolpath' && G) return G.colorForFeature(name);
    // A mesh group that IS a slicer feature gets the slicer's colour for it.
    // That is not a guess: a `.gcode.3mf` imported to the plate arrives as one
    // piece per feature named "<file> - Outer wall", so reading the plate back
    // gives the feature colouring for free, and a group named for a feature by
    // anything else - a support-isolation producer, say - inherits it too.
    // Anything the table does not know falls through to the object palette
    // rather than to the table's grey "other", so unrelated parts stay
    // distinguishable from one another.
    if (G && G.FEATURE_COLORS) {
      // "<file> - Support interface" or, from G-scope's own export,
      // "<file> - Support interface (x120, 3 layers)": the feature is the
      // last " - " part with any trailing count dropped.
      var tail = String(name).split(' - ').pop().replace(/\s*\([^)]*\)$/, '');
      if (Object.prototype.hasOwnProperty.call(G.FEATURE_COLORS, tail)) {
        return G.FEATURE_COLORS[tail];
      }
    }
    return OBJECT_COLORS[i % OBJECT_COLORS.length];
  }

  // ===========================================================================
  // Axes
  // ===========================================================================
  //
  // The app's own mapping, not the reference tool's - see the deviation note at
  // the top. `zUpToYUp()` is `rotateX(-PI/2)`, which is exactly this:
  //
  //     (gx, gy, gz)  ->  (gx, gz, -gy)
  //
  // XY is centred on the document so the part sits over the grid's middle; Z is
  // NOT centred, because the grid is the bed and a part's z=0 belongs on it.
  // That is the reference tool's own choice and it is kept.

  function toThree(x, y, z) { return new THREE.Vector3(x, z, -y); }

  // ===========================================================================
  // Loading a document
  // ===========================================================================

  /**
   * A sliced project: segments in the reference tool's own schema, each
   * carrying a back-pointer to the parsed move so Export can build its bead.
   */
  function toolpathDoc(filename, res) {
    var G = window.NSOGcodeLines;
    // The distinct printing heights, bed first. The layer-range slider steps
    // over THESE, not over layer indices, for the reason selectLayer() gives:
    // a move belongs to the Z it prints at.
    var zLevels = G.zLevels(res.parsed);
    function zIndex(z) {
      var lo = 0, hi = zLevels.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (zLevels[mid] < z - 1e-6) lo = mid + 1; else hi = mid;
      }
      return lo;
    }
    var segs = res.parsed.moves.map(function (m, i) {
      return {
        id: i,
        x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1,
        z: m.z, w: m.width, zi: zIndex(m.z),
        feature: m.feature, obj: m.objectId, layer: m.layer,
        mv: m
      };
    });
    // The bottom of each Z level's beads: a bead hangs down from its printing
    // Z, so the band a slider step covers starts at the lowest bead bottom.
    var zBottom = zLevels.slice();
    segs.forEach(function (s) {
      var b = s.z - beadHeight(s);
      if (b < zBottom[s.zi]) zBottom[s.zi] = b;
    });
    function beadHeight(s) { return s.mv.height > 0 ? s.mv.height : 0; }
    // The reference tool's centroid, verbatim: the mean of every segment
    // endpoint, not the bounding box. Kept because the framing is its framing.
    var cx = 0, cy = 0;
    segs.forEach(function (s) { cx += s.x0 + s.x1; cy += s.y0 + s.y1; });
    var n2 = segs.length * 2 || 1;

    return {
      kind: 'toolpath',
      name: filename,
      segments: segs,
      zLevels: zLevels,
      zBottom: zBottom,
      parsed: res.parsed,
      objects: null,
      // Swept chains, keyed by first:last move - see NSOGcodeSolid.buildSolid.
      // Per document, because a chain key means nothing in another file.
      solidCache: new Map(),
      cx: cx / n2,
      cy: cy / n2,
      unit: 'segment'
    };
  }

  /**
   * Triangle centroids and bounds, once per object, so the capture box never
   * re-derives them. Every mesh object gets these - a build object, a plate
   * piece, or a feature lifted out of one (a detector row's).
   */
  function prepObject(o) {
    var p = o.positions;
    var n = Math.floor(p.length / 9);
    var c = new Float32Array(n * 3);
    var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity,
              minZ: Infinity, maxZ: -Infinity };
    for (var t = 0; t < n; t++) {
      var k = t * 9;
      var ax = (p[k] + p[k + 3] + p[k + 6]) / 3;
      var ay = (p[k + 1] + p[k + 4] + p[k + 7]) / 3;
      var az = (p[k + 2] + p[k + 5] + p[k + 8]) / 3;
      c[t * 3] = ax; c[t * 3 + 1] = ay; c[t * 3 + 2] = az;
      for (var v = 0; v < 3; v++) {
        var x = p[k + v * 3], y = p[k + v * 3 + 1], z = p[k + v * 3 + 2];
        if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
        if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
      }
    }
    o.centroids = c;
    o.triangles = n;
    o.bounds = b;
    return o;
  }

  /** A plain mesh: one group per build object, triangles as read. */
  function meshDoc(filename, objects) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var minZ = Infinity, maxZ = -Infinity;
    objects.forEach(function (o) {
      var b = prepObject(o).bounds;
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxY > maxY) maxY = b.maxY;
      if (b.minZ < minZ) minZ = b.minZ;
      if (b.maxZ > maxZ) maxZ = b.maxZ;
    });
    return {
      kind: 'mesh',
      zMin: isFinite(minZ) ? minZ : 0,
      zMax: isFinite(maxZ) ? maxZ : 0,
      name: filename,
      segments: null,
      parsed: null,
      objects: objects,
      // A triangle soup's centroid is mesh-density weighted and so arbitrary;
      // for a mesh the bounding box centre is the honest middle. (The toolpath
      // route keeps the reference tool's endpoint centroid - see above.)
      cx: isFinite(minX) ? (minX + maxX) / 2 : 0,
      cy: isFinite(minY) ? (minY + maxY) / 2 : 0,
      unit: 'triangle'
    };
  }

  // ===========================================================================
  // The plate as a document - the overlay route
  // ===========================================================================
  //
  // The file routes above answer "what is in this file". This one answers
  // "what is on the plate right now", which is the question X-ray answers and
  // the one this view could not ask until now. X-ray's pattern, exactly: a
  // rail button that acts on whatever is already there, with the main
  // viewport left where it stands underneath - the panel is `position: fixed`
  // over it, not a route away from it, so Close puts you back on the same
  // plate with the same selection.
  //
  // What comes out is the SAME mesh document the STL/3MF route builds - one
  // named group per part, whole parts caught by the capture box, Isolate and
  // both exports unchanged - so nothing below `meshDoc` needs to know, or can
  // tell, where the triangles came from.
  //
  // COORDINATES. `meshToWorldSoup` (app-join.js) is the app's one way to read
  // a placed piece as world triangles, and it hands back the VIEWPORT's Y-up
  // space. A microscope document is in the FILE's Z-up millimetres, because
  // that is what the capture box, the layer window and both exports speak.
  // The remap is the inverse of `toThree`:
  //
  //     three (X, Y, Z)  ->  z-up (X, -Z, Y)
  //
  // so a piece read off the plate and a piece read out of a file land in the
  // same space, and Export to plate puts one back down where the other would.

  /** One placed mesh as a Z-up millimetre triangle soup, or null. */
  function zUpSoupOf(placedMesh) {
    if (typeof meshToWorldSoup !== 'function') return null;
    var soup = meshToWorldSoup(placedMesh);
    if (!soup || soup.length < 9) return null;
    var out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      out[i] = soup[i];                 //  x  <-  X
      out[i + 1] = -soup[i + 2];        //  y  <- -Z
      out[i + 2] = soup[i + 1];         //  z  <-  Y
    }
    return out;
  }

  /**
   * Every piece on the plate, as microscope objects.
   *
   * Names are made unique because `doc.groups` and the legend are keyed by
   * name, and two pieces cut from one file share theirs. The plate index and
   * source model id ride along so a caller can tell an object back to the
   * piece it was read from.
   */
  function plateObjects() {
    if (typeof state === 'undefined' || !state || !state.placed) return [];
    var used = {};
    var out = [];
    state.placed.forEach(function (p, i) {
      if (!p || !p.mesh) return;
      var soup = zUpSoupOf(p.mesh);
      if (!soup) return;
      var base = p.name || ('Piece ' + (i + 1));
      var name = base, n = 2;
      while (used[name]) { name = base + ' #' + n; n++; }
      used[name] = 1;
      out.push({ name: name, positions: soup, placedIndex: i, sourceId: p.sourceId });
    });
    return out;
  }

  /**
   * Open any set of named Z-up triangle groups as a mesh document.
   *
   * THIS IS THE SEAM, and it is deliberately wider than its one caller needs.
   * `openPlate()` below passes one group per plate piece. Anything that can
   * name and separate triangles can be the next caller - a support tree split
   * into its branches, a single strut, one interface layer, one web - and the
   * view, the legend, the capture box, Isolate and both exports take it
   * without a change, because from `meshDoc` down nothing knows or asks who
   * grouped the triangles. Growing the isolation library is a matter of
   * writing a producer that hands this function better groups; it is not a
   * matter of touching anything in this file below this line.
   */
  function openObjects(label, objects, opts) {
    if (!objects || !objects.length) {
      say('Nothing to put under the microscope', true);
      return null;
    }
    var o = opts || {};
    openPanel();
    if (!view) return null;
    var d = meshDoc(label, objects);
    d.source = o.source || 'objects';
    d.subtitle = o.subtitle || null;
    // Two optional hooks for a producer that owns the groups it hands over
    // (Picture, app-relief.js, is the one caller that sets them):
    //   back     a way back to the producer: shows the Back button, named
    //            `backLabel`, which closes this view and calls it;
    //   onPlate  called with the model id after Export to plate puts
    //            a piece of this document on the plate, so the producer can
    //            seat it. The piece is already added and on the Undo stack.
    d.back = typeof o.back === 'function' ? o.back : null;
    d.backLabel = o.backLabel || 'Back';
    d.onPlate = typeof o.onPlate === 'function' ? o.onPlate : null;
    return open(d);
  }

  /** A piece of the document just landed on the plate: tell its producer. */
  function landed(id) {
    if (!doc || !doc.onPlate || id == null) return;
    try { doc.onPlate(id); }
    catch (err) { console.error('[g-scope] onPlate', err); }
  }

  /** The document's Back button: shown only when its producer gave one. */
  function syncBackButton() {
    var b = $('ms-btn-back-producer');
    if (!b) return;
    var ld = lensDoc();
    b.hidden = !(ld && ld.back);
    if (ld && ld.back) b.textContent = ld.backLabel;
  }

  function backToProducer() {
    var ld = lensDoc();
    var fn = ld && ld.back;
    if (!fn) return;
    close();
    fn();
  }

  /** Whatever is on the plate, under the lens. The overlay route. */
  function openPlate() {
    var objs = plateObjects();
    if (!objs.length) return null;
    return openObjects('Plate', objs, {
      source: 'plate',
      subtitle: 'The plate as it stands, read off the pieces themselves. ' +
                'Not a sliced file: no layers and no slicer features, so each ' +
                'piece draws whole. Click one to isolate it; Region places a capture box.'
    });
  }

  /**
   * A slice that has ALREADY been parsed, opened without parsing it twice.
   * `res` is `NSOGcodeLines.readSlicedGcode3MF()`'s own result - the same
   * object `NSO_TOOLPATH`'s session keeps on `.result` - which is how a
   * `.gcode.3mf` import can land here for free on its way to the plate.
   */
  function openToolpathResult(filename, res) {
    if (!res || !res.parsed || !res.parsed.moves || !res.parsed.moves.length) return null;
    openPanel();
    if (!view) return null;
    return open(toolpathDoc(filename, res));
  }

  /**
   * Which route a 3MF takes is decided by its CONTENT, never by its name.
   * `.gcode.3mf` is not a single extension and cannot be sniffed reliably; a
   * sliced project is the one that carries `Metadata/plate_N.gcode`.
   */
  function threeMFHasToolpath(bytes) {
    var G = window.NSOGcodeLines, R = window.NSO3MFRead;
    if (!G || !R || !R.openZip) return false;
    try { return G.listPlateGcode(R.openZip(bytes)).length > 0; }
    catch (err) { return false; }
  }

  /**
   * Read one file into the view. Resolves with the document, or null on a
   * failure that has already been reported. A file that opens is the
   * IMPORTED file: the one thing a close does not throw away (close()).
   */
  function load(filename, arrayBuffer) {
    return loadFile(filename, arrayBuffer).then(function (d) {
      // the plate holds a copy of what was read (importCopy): the import is kept as read
      if (d) { importedDoc = Object.assign({}, d); d.importOf = importedDoc; }
      return d;
    });
  }

  function loadFile(filename, arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var isSTL = /\.stl$/i.test(filename);
    var is3MF = /\.3mf$/i.test(filename);
    if (!isSTL && !is3MF) {
      say(filename + ': the microscope opens STL, 3MF and sliced .gcode.3mf', true);
      return Promise.resolve(null);
    }

    if (is3MF && !window.NSO3MFRead) {
      say('3MF reader failed to load - check console', true);
      return Promise.resolve(null);
    }
    if (is3MF && !window.NSOGcodeLines) {
      say('Toolpath reader failed to load - check console', true);
      return Promise.resolve(null);
    }

    if (is3MF && threeMFHasToolpath(bytes)) {
      say('Reading toolpath from ' + filename + '...');
      return window.NSOGcodeLines.readSlicedGcode3MF(bytes, { name: filename })
        .then(function (res) {
          if (!res.parsed.moves.length) {
            say(filename + ': the plate G-code has no extrusion moves', true);
            return null;
          }
          res.warnings.forEach(function (w) { console.warn(filename + ': ' + w); });
          return open(toolpathDoc(filename, res));
        })
        .catch(function (err) {
          console.error(err);
          say('Could not read ' + filename + ': ' + (err && err.message ? err.message : 'unreadable'), true);
          return null;
        });
    }

    if (is3MF) {
      say('Reading ' + filename + '...');
      return window.NSO3MFRead.parse3MF(bytes, { name: filename })
        .then(function (res) {
          res.warnings.forEach(function (w) { console.warn(filename + ': ' + w); });
          var objs = res.objects.map(function (o) {
            return { name: o.name || baseName(filename), positions: o.positions };
          }).filter(function (o) { return o.positions && o.positions.length >= 9; });
          if (!objs.length) { say(filename + ': no usable geometry found', true); return null; }
          return open(meshDoc(filename, objs));
        })
        .catch(function (err) {
          console.error(err);
          say('Failed to load ' + filename + ': ' +
              (err && err.message ? err.message : 'not a readable 3MF'), true);
          return null;
        });
    }

    // STL. One object by definition - the format has no object structure - so
    // it opens as one whole unsegmented part, named after the file.
    try {
      // app-core.js's own accessor, so there is one place that knows how the
      // loader is reached rather than two.
      var geo = (typeof loader !== 'undefined' && loader && loader.parse)
        ? loader.parse(arrayBuffer)
        : new THREE.STLLoader().parse(arrayBuffer);
      if (!geo.attributes || !geo.attributes.position) throw new Error('Invalid geometry');
      var pos = new Float32Array(geo.attributes.position.array);
      geo.dispose();
      if (pos.length < 9) throw new Error('Invalid geometry');
      return Promise.resolve(open(meshDoc(filename, [{ name: baseName(filename), positions: pos }])));
    } catch (err) {
      console.error(err);
      say('Failed to load ' + filename + '. Try re-exporting as binary STL.', true);
      return Promise.resolve(null);
    }
  }

  // ===========================================================================
  // ===========================================================================
  //
  //   REFERENCE TOOL, LIFTED
  //
  //   Everything from here to the matching end banner is
  //   docs/reference/joint_microscope_3d.html's own code. It is reused, not
  //   reinterpreted. Changes are limited to:
  //     - `SEGMENTS` is `doc.segments`, loaded rather than baked;
  //     - `toThree` is the app's mapping, not the mirrored one (see the top);
  //     - module-level globals are closure variables, so nothing collides;
  //     - the mesh route is an added branch - the reference tool never saw a
  //       mesh, so there is nothing of its behaviour to preserve there;
  //     - `animate()` takes a generation, because this view can be closed and
  //       reopened and the reference tool's loop can only ever start once.
  //
  // ===========================================================================
  // ===========================================================================

  var HIDDEN = null;          // Set of group names toggled off in the legend
  var mode = 'piece';         // 'piece' | 'select' (REGION armed); every document opens in 'piece'
  var balls = [];             // the capture boxes
  var defaultR = 5.0;
  // A corner drag makes the footprint a rectangle; the next box dropped takes
  // the last one's shape, as the reference tool's next ball took its size.
  var defaultRx = null, defaultRy = null;
  var defaultH = 1.0;         // flat by default - a thin slab, not a tall cube
  var currentSelection = [];  // segments (toolpath) or objects (mesh)
  var selectionSource = 'box';

  // --- G-scope's view filters. All three are VIEW state: they decide what is
  // drawn and what a click can catch, and nothing else. None of them writes
  // to `state`, the plate or the undo stack - see clearFromView().
  var CLEARED = new Set();    // toolpath: segment ids cleared from view
  var zr = null;              // layer-range slider, in steps: { lo, hi, n }
  var lineCursor = -1;        // position in shownSegments() of the picked line
  var selectionListeners = [];
  // How a toolpath is DRAWN: 'toolpath' (lines, and per-move prisms for a
  // highlight or Isolate) or 'solid' (every continuous run of bead swept into
  // one closed shell - nso-gcode-solid.js). View state like the three above:
  // it changes the triangles on screen and nothing else. What is selected,
  // what the capture box catches and what a line pick lands on are the same
  // moves either way, so switching back and forth never loses a selection.
  var renderMode = 'toolpath';
  // Isolate's state, kept apart from what is drawn. Isolated: the selection
  // alone, drawn as-is (applyDisplay).
  var isolated = false;
  var clickHooks = [];        // fn(ndcX, ndcY, event) -> true when it took the click
  var docListeners = [];      // fn(doc) after every open()
  // Line types the Display column has switched off. ONE set for both plates:
  // unchecking "Support" hides it on plate 1 and on plate 2 alike, and it outlives
  // the plate that was showing when the box was ticked. Travel opens off, as
  // it always has; a new slice opens with that default again.
  var FEATURE_OFF = new Set(['Travel']);

  var BED_GRID = 120;                 // a plate's smallest side, mm; a bigger plate read grows both
  var plateSide = BED_GRID;           // both plates' side now, mm, each centred on its own origin

  // ===========================================================================
  // Two plates, side by side (docs/GSCOPE.md)
  // ===========================================================================
  //
  // Bambu Studio's multi-plate view: both plates stand on one floor, plate 1
  // ('lens' inside this file) on the left and plate 2 ('take') to its right,
  // the same size, each with its label. THE TWO PLATES ARE THE SAME (round 2b):
  // each is its own zone, empty or holding one document - a plate read, an
  // imported file, a slice made here, or the pieces dragged onto it - and every
  // control acts on the ACTIVE plate and works identically on either: Import
  // and Read plate load into it, CLEAR empties it, Export writes it, and a drag
  // copies across in either direction.
  //
  // One plate is ACTIVE. The module variables above and below (doc, HIDDEN,
  // balls, the selection, the layer range, ...) are the active plate's, so the
  // legend, the readouts, the slider, every card and Export follow it because
  // they already read those. Making the other plate active stashes them and puts
  // its own back - each plate keeps its own three scene groups, meshes and clip
  // planes, and nothing of the plate not active is touched while it is not.
  //
  // THE ACTIVE PLATE STANDS AT THE ORIGIN. Every coordinate in this file - a
  // pick, a capture box, the clip planes, a drag's drop - is in the active
  // plate's own frame, as it was when one plate was shown at a time. The other
  // plate's groups and floor are drawn beside it (placePlates), and a change of
  // the active plate moves the camera by the same step the plates move, so on
  // screen nothing moves: the plates stay where they stand, left and right, and
  // only which one is lit changes.
  //
  // A piece dragged onto an EMPTY plate makes it a pieces document (source
  // 'take'): a mesh document whose objects are the pieces, in the Z-up
  // millimetres of a bed centred on its origin (cx = cy = 0), so the legend, the
  // box, the clip slider, Isolate and the exports read it as they read any mesh.
  // A piece copied off a slice keeps its moves (shifted with it), so "as solid"
  // still has the beads to sweep. Dragged onto a plate that holds a document,
  // a piece joins it (setDownOn). Nothing the user reads says 'lens' or 'take'.

  var plateName = 'lens';                         // the ACTIVE plate
  var plateSaved = { lens: null, take: null };   // a plate's stash while it is NOT active
  var plateListeners = [];                       // fn(name) after the active plate changed
  var SLOT = { lens: 0, take: 1 };               // left to right
  var PLATE_LABEL = { lens: 'Plate 1', take: 'Plate 2' };
  var importedDoc = null;                        // the file Import opened, kept across a close

  /** "Plate 1" / "Plate 2". */
  function plateTitle(name) { return PLATE_LABEL[name === 'take' ? 'take' : 'lens']; }

  /** A plate's document, active or not (null: the plate is empty). */
  function plateDoc(name) {
    name = name === 'take' ? 'take' : 'lens';
    return name === plateName ? doc : (plateSaved[name] ? plateSaved[name].doc : null);
  }

  /** A plate that pieces were dragged onto while it was empty. */
  function newPiecesDoc(name) {
    return {
      kind: 'mesh', source: 'take', name: plateTitle(name), objects: [], segments: null, parsed: null,
      zMin: 0, zMax: 0, cx: 0, cy: 0, unit: 'triangle', groups: {},
      subtitle: 'Pieces dragged here. Drag a piece to move it, drop it on another to seat it, or on the bed to ' +
                'set it down; drag it over the other plate to copy it there.'
    };
  }

  /** Is this a pieces document (what a drag onto an empty plate makes)? */
  function isPieces(d) { return !!(d && d.kind === 'mesh' && d.source === 'take'); }

  /** Does this mesh document hold a piece that is still a slice's beads? Its Features list is those beads' line types. */
  function hasBeads(d) {
    return !!(d && d.kind === 'mesh' && d.objects && d.objects.some(function (o) { return o.moves && o.moves.length; }));
  }

  function clipPair() {
    return [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)];
  }

  function freshPlate(name) {
    var G = function () { return new THREE.Group(); };
    var dg = G();
    dg.visible = false;
    return {
      doc: null,
      HIDDEN: new Set(), CLEARED: new Set(), zr: null, lineCursor: -1,
      mode: 'piece', balls: [], currentSelection: [], selectionSource: 'box', isolated: false,
      groups: [G(), dg, G()], overviewMeshes: {}, solidMeshes: {}, solidBuilt: null, clip: clipPair()
    };
  }

  /** The active plate's variables, as a stash. */
  function stashPlate() {
    var v = view;
    var s = {
      doc: doc, HIDDEN: HIDDEN, CLEARED: CLEARED, zr: zr, lineCursor: lineCursor,
      mode: mode, balls: balls, currentSelection: currentSelection, selectionSource: selectionSource, isolated: isolated
    };
    if (v) {
      s.groups = [v.overviewGroup, v.detailGroup, v.highlightGroup];
      s.overviewMeshes = v.overviewMeshes;
      s.solidMeshes = v.solidMeshes || {}; s.solidBuilt = v.solidBuilt || null;
      s.clip = v.clip;
    }
    plateSaved[plateName] = s;
  }

  /** A stash back into the module variables and the view's fields. */
  function loadPlate(s) {
    var v = view;
    doc = s.doc; HIDDEN = s.HIDDEN; CLEARED = s.CLEARED; zr = s.zr;
    lineCursor = s.lineCursor; mode = s.mode; balls = s.balls; currentSelection = s.currentSelection;
    selectionSource = s.selectionSource; isolated = s.isolated;
    v.overviewGroup = s.groups[0]; v.detailGroup = s.groups[1]; v.highlightGroup = s.groups[2];
    v.overviewMeshes = s.overviewMeshes;
    v.solidMeshes = s.solidMeshes; v.solidBuilt = s.solidBuilt; v.clip = s.clip;
  }

  /** The active plate's capture boxes in the scene, or out of it (the other plate's are never drawn). */
  function ballsInScene(on) {
    var v = view;
    balls.forEach(function (b) {
      boxParts(b).forEach(function (o) { if (on) v.scene.add(o); else v.scene.remove(o); });
    });
  }

  /** Plate 1's document, whichever plate is active. */
  function lensDoc() { return plateDoc('lens'); }

  function otherPlate() { return plateName === 'lens' ? 'take' : 'lens'; }

  /** Plate centre to plate centre, mm: a plate's side and a gap. */
  function plateSpacing() { return plateSide + Math.max(16, plateSide * 0.15); }

  /** Where plate `name` stands, along view X, with the active plate at the origin. */
  function plateOffset(name) {
    return (SLOT[name === 'take' ? 'take' : 'lens'] - SLOT[plateName]) * plateSpacing();
  }

  /** A plate's three scene groups, active or not. */
  function plateGroups(name) {
    if (name === plateName) return view ? [view.overviewGroup, view.detailGroup, view.highlightGroup] : [];
    var s = plateSaved[name];
    return s && s.groups ? s.groups : [];
  }

  // --- the floors -----------------------------------------------------------------

  var FLOOR_LIT = 0x38bdf8, FLOOR_DIM = 0x3a404c;

  /** A plate's label, lying on the floor in front of it: text on a canvas. */
  function floorLabel(text) {
    var c = document.createElement('canvas');
    c.width = 512; c.height = 80;
    var g = c.getContext('2d');
    g.font = '600 50px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#e2e8f0';
    g.fillText(text, 4, 42);
    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var w = Math.min(60, plateSide * 0.4), h = w * 80 / 512;
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide
    }));
    m.rotation.x = -Math.PI / 2;
    m.userData.w = w; m.userData.h = h;
    return m;
  }

  /** One plate's floor: its grid, its outline (lit while active) and its label. */
  function makeFloor(name) {
    var side = plateSide, half = side / 2;
    var g = new THREE.Group();
    g.name = 'gscopeFloor:' + name;
    var grid = new THREE.GridHelper(side, Math.max(2, Math.round(side / 5)), 0x333844, 0x22252c);
    g.add(grid);
    var sq = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-half, 0.02, -half), new THREE.Vector3(half, 0.02, -half),
      new THREE.Vector3(half, 0.02, half), new THREE.Vector3(-half, 0.02, half)]);
    var outline = new THREE.LineLoop(sq, new THREE.LineBasicMaterial({ color: FLOOR_DIM, transparent: true, opacity: 1 }));
    g.add(outline);
    var label = floorLabel(PLATE_LABEL[name]);
    label.position.set(-half + label.userData.w / 2, 0.02, half + label.userData.h / 2 + 1.5);
    g.add(label);
    return { group: g, grid: grid, outline: outline, label: label, side: side };
  }

  /** Both floors, at the plate side now (rebuilt when a plate read grows it). */
  function buildFloors() {
    var v = view;
    ['lens', 'take'].forEach(function (n) {
      var f = v.floors && v.floors[n];
      if (f && f.side === plateSide) return;
      if (f) { v.scene.remove(f.group); disposeTree(f.group); }
      v.floors = v.floors || {};
      v.floors[n] = makeFloor(n);
      v.scene.add(v.floors[n].group);
    });
  }

  /** The side both plates take for this document: the bed's 120 mm, or more if it spreads wider. */
  function sideFor(d) {
    var span = 0;
    if (d && d.kind === 'toolpath') {
      d.segments.forEach(function (s) {
        span = Math.max(span, Math.abs(s.x0 - d.cx), Math.abs(s.x1 - d.cx), Math.abs(s.y0 - d.cy), Math.abs(s.y1 - d.cy));
      });
    } else if (d && d.objects) {
      d.objects.forEach(function (o) {
        var b = o.bounds;
        if (!b || !isFinite(b.minX)) return;
        span = Math.max(span, Math.abs(b.minX - d.cx), Math.abs(b.maxX - d.cx), Math.abs(b.minY - d.cy), Math.abs(b.maxY - d.cy));
      });
    }
    return Math.max(BED_GRID, Math.ceil((span * 2 + 10) / 20) * 20);
  }

  /** Every plate's groups and floor where it stands; the active one's outline lit, the other's dimmed. */
  function placePlates() {
    var v = view;
    if (!v) return;
    buildFloors();
    ['lens', 'take'].forEach(function (n) {
      var x = plateOffset(n), on = n === plateName, f = v.floors[n];
      plateGroups(n).forEach(function (g) {
        g.position.x = x;
        if (g.parent !== v.scene) v.scene.add(g);
        g.updateMatrixWorld(true);
      });
      f.group.position.x = x;
      f.group.updateMatrixWorld(true);
      f.outline.material.color.setHex(on ? FLOOR_LIT : FLOOR_DIM);
      f.label.material.opacity = on ? 1 : 0.45;
    });
    v.grid = v.floors[plateName].grid;
    v.hoverGroup.position.x = 0;
    v.worldSphere = worldSphere();
  }

  /** Move the camera with the plates: a change of the active plate moves nothing on screen. */
  function shiftView(dx) {
    var v = view;
    if (!v || !dx) return;
    v.controls.enableDamping = false;
    v.controls.update();
    v.controls.enableDamping = true;
    v.camera.position.x += dx;
    v.controls.target.x += dx;
    v.controls.update();
  }

  /** Both plates on the floor and in the scene; the one not active, empty if it is new. */
  function ensurePlates() {
    if (!view) return;
    var o = otherPlate();
    if (!plateSaved[o]) plateSaved[o] = freshPlate(o);
    placePlates();
  }

  /** The side both plates take: what either holds decides it (both grow together). */
  function sizePlates() {
    var was = plateSide;
    plateSide = Math.max(sideFor(plateDoc('lens')), sideFor(plateDoc('take')));
    return plateSide !== was;
  }

  /**
   * Plate `name` emptied, active or not - its document, pieces, selection,
   * boxes, isolation, clears and slider - ready for Import or Read plate. The
   * other plate is not touched. The plate stays where it is and so does the
   * camera; which plate is active does not change.
   */
  function emptyPlate(name) {
    name = name === 'take' ? 'take' : 'lens';
    var d = plateDoc(name);
    if (d && d.objects) d.objects.forEach(dropPieceGeometry);
    if (name !== plateName) {
      var s = plateSaved[name];
      if (s && view) {
        s.groups.forEach(function (g) { clearGroup(g); view.scene.remove(g); });
        s.balls.forEach(function (b) { boxParts(b).forEach(function (o) { view.scene.remove(o); disposeTree(o); }); });
      }
      plateSaved[name] = null;
      ensurePlates();
      return;
    }
    removeAllBalls();
    if (view) {
      clearGroup(view.overviewGroup);
      clearGroup(view.detailGroup);
      clearGroup(view.highlightGroup);
      view.overviewMeshes = {};
      view.solidMeshes = {};
      view.solidBuilt = null;
    }
    doc = null;
    HIDDEN = new Set();
    CLEARED = new Set();
    currentSelection = [];
    selectionSource = 'box';
    isolated = false;
    lineCursor = -1;
    zr = null;
    mode = 'piece';
  }

  /** One burst of coalesced redraws, run now so it lands on the plate that asked for it. */
  function flushPending() {
    if (viewPending) { viewPending = false; viewChanged(); }
    if (isolatePending) { isolatePending = false; isolateRedraw(); }
    if (highlightPending) { highlightPending = false; refreshHighlight(); }
  }

  /**
   * Make a plate active: 'lens' (plate 1) or 'take' (plate 2). opts.quiet swaps
   * the state and nothing else (nothing moved, no panels redrawn, no listener
   * told) - for a caller that is about to work on the plate and swap straight
   * back.
   */
  function showPlate(name, opts) {
    name = name === 'take' ? 'take' : 'lens';
    opts = opts || {};
    if (!buildWorld()) return plateName;
    if (name === plateName) { if (!opts.quiet) syncPlateUI(); return plateName; }
    flushPending();
    if (!opts.quiet) clearHover();
    var dx = -plateOffset(name);
    stashPlate();
    ballsInScene(false);
    plateName = name;
    loadPlate(plateSaved[name] || freshPlate(name));
    ballsInScene(true);
    if (opts.quiet) return plateName;
    placePlates();
    shiftView(dx);
    // Each plate keeps its own built scene (its groups and meshes came with it),
    // so a change rebuilds nothing: only what reads the document is redrawn.
    if (!zr || zr.n !== zSteps()) zr = { lo: 0, hi: Math.max(0, zSteps() - 1), n: zSteps() };
    redrawDoc(false);
    syncPlate();
    docListeners.forEach(function (fn) {
      try { fn(doc); } catch (err) { console.error('[g-scope] document listener', err); }
    });
    plateListeners.forEach(function (fn) {
      try { fn(plateName); } catch (err) { console.error('[g-scope] plate listener', err); }
    });
    return plateName;
  }

  /**
   * Everything drawn and every readout, for the document the active plate holds.
   * `rebuild` false keeps the scene objects the plate already has.
   */
  function redrawDoc(rebuild) {
    var v = view;
    applyClip();
    if (v && (rebuild !== false || (hasBeads(doc) && v.takeSig !== featureSig()))) {
      buildOverview();
      buildDetail_();
    }
    clearHover();
    buildLegend();
    applyFeatureVisibility();
    refreshHighlight();
    applyDisplay();
    setMode(mode);
    syncHeader();
    syncExportRow();
    syncRenderRow();
    syncZRangeUI();
    syncTakeBand();
    syncBackButton();
    syncCard();
    if (doc && currentSelection.length) describeSelection(); else info(introInfo());
  }

  /** Isolated, the detail group is the selection: rebuilt with the plate it belongs to. */
  function buildDetail_() { if (isolated) buildDetail(); else clearGroup(view.detailGroup); }

  /** The line under the info box when nothing is selected. */
  function introInfo() {
    var me = plateTitle(plateName), other = plateTitle(otherPlate());
    if (!doc) return me + ' is empty. <b>Import</b> a file or <b>Read plate</b> into it, or drag something here from ' + other + '.';
    if (isPieces(doc)) {
      return me + '. Drag a piece to move it, or over ' + other + ' to copy it there. Hover and click one to isolate it - and Export acts on it.';
    }
    return 'Hover what a click would take and it is outlined. <b>Click</b> isolates it (click it again, or Escape, to see the ' +
           'whole part), <b>drag</b> it onto ' + other + ' to copy it there; drag bare floor to orbit. Click a plate to make it the active one.';
  }

  /** CLEAR and Export follow the plates. */
  function syncPlateUI() {
    var t = $('ms-btn-take-clear');
    if (t) {
      t.title = 'Empty ' + plateTitle(plateName) + ', the active plate - ' + plateTitle(otherPlate()) + ' is not touched. ' +
                'An emptied plate is ready for Import or Read plate';
      t.dataset.plate = plateName === 'take' ? '2' : '1';
    }
    var vp = $('ms-viewport');
    if (vp) vp.dataset.plate = plateName === 'take' ? '2' : '1';
    syncExportRow();
  }
  function syncPlate() { syncPlateUI(); badgeFor(); syncCard(); }

  /**
   * The card's side (docs/GSCOPE.md item 12): the document decides it. A
   * toolpath - a slice made here, or a sliced file - is the Slice side; a mesh,
   * pieces or an empty plate is the Normal side. The switch shows it, and the
   * rows for that side are the ones the card shows (CSS, by data-side).
   */
  function cardSide() { return doc && doc.kind === 'toolpath' ? 'slice' : 'normal'; }
  function syncCard() {
    var c = $('ms-main-card');
    if (c) c.dataset.side = cardSide();
    var S = window.NSO_GSCOPE_SLICE;
    if (S && S.syncPanel) S.syncPanel(); else if (S && S.syncToggle) S.syncToggle();
  }
  function badgeFor() {
    if (!isolated) badge(plateBadge());
  }
  /** What the badge says of the active plate, nothing isolated. */
  function plateBadge() {
    if (!doc) return plateTitle(plateName) + ': empty';
    if (isPieces(doc)) return plateTitle(plateName) + ': ' + doc.objects.length + ' piece(s)';
    return 'Whole part';
  }

  // ===========================================================================
  // Pieces: what a drag sets down on a plate
  // ===========================================================================

  function uniquePieceName(d, base) {
    var used = {};
    (d.objects || []).forEach(function (o) { used[o.name] = 1; });
    var name = base, n = 2;
    while (used[name]) { name = base + ' #' + n; n++; }
    return name;
  }

  /** Moves copied and shifted: a piece's beads travel with it, the slice's own are never touched. */
  function shiftedMoves(moves, dx, dy, dz) {
    return moves.map(function (m) {
      var c = Object.assign({}, m);
      c.x0 = m.x0 + dx; c.x1 = m.x1 + dx; c.y0 = m.y0 + dy; c.y1 = m.y1 + dy; c.z = m.z + dz;
      return c;
    });
  }

  function shiftedPositions(p, dx, dy, dz) {
    var out = new Float32Array(p.length);
    for (var i = 0; i < p.length; i += 3) { out[i] = p[i] + dx; out[i + 1] = p[i + 1] + dy; out[i + 2] = p[i + 2] + dz; }
    return out;
  }

  /** A piece moved by (dx, dy, dz) mm in its plate's own Z-up frame, baked into its triangles and beads. */
  function bakePiece(o, dx, dy, dz) {
    if (!dx && !dy && !dz) return o;
    var p0 = o.positions, m0 = o.moves;
    o.positions = shiftedPositions(o.positions, dx, dy, dz);
    if (o.moves) o.moves = shiftedMoves(o.moves, dx, dy, dz);
    movePieceGeometry(o, p0, m0, dx, dy, dz);         // drawn as it was, moved: nothing rebuilt
    return prepObject(o);
  }

  /** A mesh plate, active, after its pieces changed: the bounds, the slider, what is selected, all redrawn. */
  function pieceRefresh() {
    var d = doc, os = d.objects, lo = Infinity, hi = -Infinity;
    os.forEach(function (o) {
      if (o.bounds.minZ < lo) lo = o.bounds.minZ;
      if (o.bounds.maxZ > hi) hi = o.bounds.maxZ;
    });
    d.zMin = isFinite(lo) ? lo : 0;
    d.zMax = isFinite(hi) ? hi : 0;
    var names = {};
    os.forEach(function (o) { names[o.name] = 1; });
    HIDDEN = new Set(Array.from(HIDDEN).filter(function (n) { return names[n]; }));
    currentSelection = currentSelection.filter(function (o) { return os.indexOf(o) >= 0; });
    if (!currentSelection.length && isolated) isolated = false;
    zr = { lo: 0, hi: Math.max(0, zSteps() - 1), n: zSteps() };
    redrawDoc();
    if (selectionSource === 'box' && balls.length) setSelection(selectByBox(), 'box');
    if (view) view.worldSphere = worldSphere();
    syncPlate();
  }

  /**
   * A plate's state as plain data, active or not: what is loaded, what is
   * hidden, cleared, selected, boxed and isolated, the layer range, the mode
   * and where the camera stands IN THAT PLATE'S OWN FRAME (so a change of the
   * active plate, which moves the camera with the plates, reads the same) -
   * and a checksum of every coordinate the document holds. Two reads that agree
   * are the same plate, byte for byte (the checks compare plate 1 before and
   * after a pull with it).
   */
  function plateState(name) {
    name = name === 'take' ? 'take' : 'lens';
    var live = name === plateName, S = live ? null : plateSaved[name];
    var d = live ? doc : (S ? S.doc : null);
    if (!live && !S) return null;
    var H = live ? HIDDEN : S.HIDDEN, C = live ? CLEARED : S.CLEARED;
    var Z = live ? zr : S.zr, B = live ? balls : S.balls, SEL = live ? currentSelection : S.currentSelection;
    var off = view ? plateOffset(name) : 0;
    var cam = view ? { pos: view.camera.position, target: view.controls.target } : null;
    var sum = 0, n = 0;
    var eat = function (a) { for (var i = 0; i < a.length; i++) { sum = (sum * 31 + a[i]) % 1000003; n++; } };
    if (d) {
      if (d.kind === 'toolpath') d.segments.forEach(function (g) { eat([g.x0, g.y0, g.x1, g.y1, g.z, g.w]); });
      else d.objects.forEach(function (o) { eat(o.positions); });
    }
    var r = function (v) { return +v.toFixed(6); };
    return {
      doc: d ? d.name : null, kind: d ? d.kind : null, source: d ? d.source || null : null,
      hidden: Array.from(H).sort(), cleared: Array.from(C).sort(function (a, b) { return a - b; }), featuresOff: Array.from(FEATURE_OFF).sort(),
      zr: Z ? [Z.lo, Z.hi, Z.n] : null,
      mode: live ? mode : S.mode, isolated: live ? isolated : S.isolated,
      selectionSource: live ? selectionSource : S.selectionSource,
      selection: SEL.map(function (o) { return o.mv ? o.mv.index : o.name; }),
      boxes: B.map(function (b) { return [r(b.point.x), r(b.point.y), r(b.point.z), r(b.rx), r(b.ry), r(b.h), r(b.a || 0)]; }),
      camera: cam ? [r(cam.pos.x - off), r(cam.pos.y), r(cam.pos.z), r(cam.target.x - off), r(cam.target.y), r(cam.target.z)] : null,
      sum: sum, coords: n
    };
  }

  /** A plate's mesh objects (plate 2's by default), for a reader (and the checks). */
  function takePieces(name) {
    var d = plateDoc(name || 'take');
    return (d && d.kind === 'mesh' ? d.objects : []).map(function (o) {
      return { name: o.name, triangles: o.triangles, bounds: o.bounds, moves: o.moves ? o.moves.length : 0,
               from: o.take ? o.take.from : null, turned: !!o.turned };
    });
  }

  // ---------------------------------------------------------------------------
  // A drag across: the thing pressed, copied onto the other plate
  // ---------------------------------------------------------------------------

  /**
   * What a drag carries, or null. `tgt` is what the press was on ({ items,
   * source }); with none it is the active plate's selection. Whatever the thing
   * is - a piece, a box's region, a line type, a line, a layer, the slider's
   * range - it is the same here: items, and the copy is what Export would
   * write: a slice's beads as their prisms (with the moves kept, so it can join
   * a slice or be swept "as solid"), a mesh's own triangles. Pieces that are
   * still beads carry their shown moves the same way. The plate the copy comes
   * from is not touched: its selection is only borrowed for the read.
   * { name, from, positions (Z-up, this plate's frame), moves, moveIds, trisPerMove }
   */
  function pullSpec(tgt) {
    if (!doc) return null;
    var items = actedOn(tgt ? tgt.items : currentSelection), source = tgt ? tgt.source : selectionSource;
    if (!items || !items.length) return null;
    if (doc.kind === 'mesh' && items.every(function (o) { return o.moves && o.moves.length; })) {
      // pieces that are still beads: their shown moves, one prism each (more than
      // one piece: each keeps its own move numbers, as Export as solid does)
      var mv = [];
      items.forEach(function (o, i) {
        o.moves.forEach(function (m) {
          if (!FEATURE_OFF.has(m.feature)) mv.push(items.length > 1 ? Object.assign({}, m, { index: m.index + i * 10000000 }) : m);
        });
      });
      var built = mv.length ? window.NSOGcodeLines.buildLineGeometry(mv) : null;
      if (!built || built.positions.length < 9) return null;
      return withSelection(items, source, function () {
        return { name: exportLabel(), from: doc.name, positions: built.positions, moves: mv, moveIds: built.moveIds, trisPerMove: built.trisPerMove };
      });
    }
    return withSelection(items, source, function () {
      var geo = microscopeGeometry();
      if (!geo) return null;
      var pos = geo.attributes.position.array;       // the geometry's own, new
      if (pos.length < 9) return null;
      return {
        name: exportLabel(), positions: pos, from: doc.name,
        moves: doc.kind === 'toolpath' ? items.map(function (sg) { return sg.mv; }) : null,
        moveIds: geo.userData.moveIds || null, trisPerMove: geo.userData.trisPerMove || 0
      };
    });
  }

  /** Run fn with `items` as the selection - and put the real one back, whatever fn does. */
  function withSelection(items, source, fn) {
    var s0 = currentSelection, src0 = selectionSource, c0 = lineCursor, li0 = doc && doc.layerIndex;
    currentSelection = items; selectionSource = source;
    try { return fn(); }
    finally { currentSelection = s0; selectionSource = src0; lineCursor = c0; if (doc) doc.layerIndex = li0; }
  }

  /** A Z-up soup's footprint centre and its bottom: the point a carried copy stands on. */
  function soupAnchor(p) {
    var x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < p.length; i += 3) {
      var x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z;
    }
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: z0 };
  }

  /** The material a piece is drawn in on a plate - the ghost's too, so nothing changes when it lands. */
  function pieceMaterial(beads, colour) {
    return beads
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.4, clippingPlanes: clipPlanes() })
      : new THREE.MeshStandardMaterial({ color: colour, metalness: 0.05, roughness: 0.4, clippingPlanes: clipPlanes() });
  }

  /**
   * THE GHOST: the copy in hand, drawn as it will land - a slice's beads as
   * their prisms in their line types' colours, a mesh in its piece colour - in
   * the scene itself, not on either plate, with its footprint's centre and its
   * bottom at the mesh's origin. It is under the pointer from the slop to the
   * release, over either plate's floor (sliding on it), a piece, or nothing,
   * and it is what lands: set down on a mesh plate, its geometry IS the piece's
   * from then on, standing where the ghost stood (setDownOn).
   */
  function makeGhost(spec) {
    var at = soupAnchor(spec.positions);
    var beads = !!(spec.moves && spec.moveIds && spec.trisPerMove &&
                   spec.moveIds.length * spec.trisPerMove * 9 === spec.positions.length);
    var geo = beads
      ? beadGeometry(spec.positions, spec.moveIds, spec.trisPerMove, spec.moves.filter(function (m) { return !FEATURE_OFF.has(m.feature); }), at)
      : keptGeometry(soupGeometry(viewPositions(spec.positions, at)));
    var n = doc && doc.kind === 'mesh' ? doc.objects.length : 0;
    var colour = beads ? 0xffffff : (doc && doc.kind === 'toolpath' ? OBJECT_COLORS[0] : colorForGroup(spec.name, n));
    var mesh = new THREE.Mesh(geo, pieceMaterial(beads, colour));
    mesh.material.clippingPlanes = [];
    mesh.name = 'gscopeGhost';
    view.scene.add(mesh);
    mesh.updateMatrixWorld(true);
    return { ghost: true, name: spec.name, spec: spec, at: at, beads: beads, geo: geo, mesh: mesh, colour: colour };
  }

  /** The ghost out of the scene; its geometry kept when it became a piece's. */
  function dropGhost(g, keepGeometry) {
    if (!g || !g.mesh) return;
    if (g.mesh.parent) g.mesh.parent.remove(g.mesh);
    g.mesh.material.dispose();
    if (!keepGeometry) g.geo.dispose();
    g.mesh = null;
  }

  /**
   * The carried copy set down on the ACTIVE plate where the ghost stands now
   * (`pos`, view space in the active plate's frame), or seated (`placed`: its
   * Z-up triangles already where they go, turned). Returns what landed (the
   * piece, or the slice's new segments), or null with the reason said:
   *   an empty plate  - a pieces document with this one piece
   *   a mesh plate    - one more object, a piece (grab it to move it)
   *   a slice         - the piece's moves join it, one more object of the slice,
   *                     drawn as its lines; a mesh (no moves) cannot, and is refused
   * A document is never edited in place: it gets new arrays, so an imported
   * file the plate shows (importCopy) is not changed by it.
   */
  function setDownOn(g, pos, placed) {
    var spec = g.spec, me = plateTitle(plateName);
    if (doc && doc.kind === 'toolpath') {
      if (!spec.moves || placed) {
        say(me + ' holds a slice, and a mesh piece cannot join one - nothing copied. Set it down on an empty plate or a plate of pieces.', true);
        return null;
      }
      var sd = [pos.x + doc.cx - g.at.x, -pos.z + doc.cy - g.at.y, pos.y - g.at.z];
      var segs = appendToSlice(doc, shiftedMoves(spec.moves, sd[0], sd[1], sd[2]));
      dropGhost(g, false);
      if (sizePlates()) placePlates();
      zr = { lo: 0, hi: Math.max(0, zSteps() - 1), n: zSteps() };
      currentSelection = [];
      isolated = false;
      redrawDoc();
      setSelection(segs, 'pick');
      if (view) view.worldSphere = worldSphere();
      say('"' + spec.name + '" set down on ' + me.toLowerCase() + ' - it joins the slice there as one more object (' + segs.length + ' moves).');
      return segs;
    }
    if (!doc) {
      doc = newPiecesDoc(plateName);
      HIDDEN = new Set(); CLEARED = new Set(); currentSelection = []; isolated = false; mode = 'piece';
    }
    var d = [pos.x + doc.cx - g.at.x, -pos.z + doc.cy - g.at.y, pos.y - g.at.z];
    var o = prepObject({
      name: uniquePieceName(doc, spec.name),
      positions: placed || shiftedPositions(spec.positions, d[0], d[1], d[2]),
      moves: placed ? null : (spec.moves ? shiftedMoves(spec.moves, d[0], d[1], d[2]) : null),
      take: { from: spec.from }
    });
    if (placed) { o.turned = true; dropGhost(g, false); }
    else if (g.geo) {
      // the ghost's geometry is the piece's: it stood where the piece now is
      pieceGeoms.set(o, { geo: g.geo, sig: featureSig(), positions: o.positions, moves: o.moves, base: pos.clone(),
                          beads: g.beads, edges: null, doc: doc });
      dropGhost(g, true);
    }
    doc.objects = doc.objects.concat([o]);
    if (sizePlates()) placePlates();
    pieceRefresh();
    setSelection([o], 'pick');
    treeSoon(o);
    return o;
  }

  /**
   * A slice with more moves: `moves` (already where they go, in its Z-up frame)
   * appended as one more object - new move numbers, a new object id, runs of
   * their own - and every segment, Z level and the slider's steps made again.
   * The slice's centre stays (the plate does not move under it); what was
   * cleared from view stays cleared. Returns the new segments.
   */
  function appendToSlice(d, moves) {
    var old = d.parsed.moves, obj = -1, run = -1;
    old.forEach(function (m) {
      if (m.objectId != null && m.objectId > obj) obj = m.objectId;
      if (m.run != null && m.run > run) run = m.run;
    });
    var add = moves.map(function (m, k) {
      var c = Object.assign({}, m);
      c.index = old.length + k;
      c.objectId = obj + 1;
      c.run = (m.run || 0) + run + 1;
      return c;
    });
    var parsed = Object.assign({}, d.parsed, { moves: old.concat(add) });
    var nd = toolpathDoc(d.name, { parsed: parsed });
    d.parsed = parsed;
    d.segments = nd.segments;
    d.zLevels = nd.zLevels;
    d.zBottom = nd.zBottom;
    return d.segments.slice(old.length);
  }

  var pull = null;     // the press in progress: { kind: 'new' | 'move', tgt, x0, y0, live, cancelled }

  function pullSlop() { return (window.nsoGrab && window.nsoGrab.SLOP) || 3; }

  function rayAt(e) {
    var v = view, q = ndc(e);
    v.raycaster.setFromCamera(new THREE.Vector2(q[0], q[1]), v.camera);
    var d = v.camera.position.distanceTo(v.controls.target);
    v.raycaster.params.Line.threshold = Math.max(0.05, d * 0.006);
    return v.raycaster;
  }

  /** The nearest thing DRAWN under the pointer in these groups, or null. */
  function firstDrawn(e, roots) {
    var best = null, bestScore = Infinity, ray = rayAt(e).ray;
    rayAt(e).intersectObjects(roots, true).forEach(function (h) {
      if (!drawnAt(h)) return;
      var sc = (h.object.isLine || h.object.isLineSegments ? ray.distanceToPoint(h.point) : 0) + h.distance * 1e-4;
      if (sc < bestScore) { bestScore = sc; best = h; }
    });
    return best;
  }

  // A capture box's three dots (item 8) are drawn over everything and always
  // own the pointer: a press on one is a handle drag even with the piece in
  // front of it, in any mode, and never falls through to the piece. They are
  // picked ON SCREEN - within DOT_PICK_PX of where a dot is drawn, however
  // small - and never drawn smaller than DOT_MIN_PX, so at any zoom a dot you
  // can see is one you can take.
  var DOT_PICK_PX = 10, DOT_MIN_PX = 6;
  // [part, the drag it starts] in the old handler's priority: move > thickness > X and Y
  var DOT_KINDS = [['handle', 'move'], ['heightHandle', 'resizeH'], ['cornerHandle', 'resizeXY']];

  /** World units per screen pixel at distance 1 from the camera. */
  function worldPerPx() {
    var h = (view.renderer.domElement.clientHeight || 1);
    return 2 * Math.tan(view.camera.fov * Math.PI / 360) / h;
  }

  /** The dot under the pointer: { ballIndex, type } (type as the drag it starts), or null. */
  function dotAt(e) {
    if (!view || !balls.length) return null;
    var r = view.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var px = e.clientX - r.left, py = e.clientY - r.top, k = worldPerPx();
    var best = null, bestScore = Infinity, cam = view.camera, p = new THREE.Vector3();
    balls.forEach(function (b, i) {
      DOT_KINDS.forEach(function (kind, pri) {
        var m = b[kind[0]];
        m.getWorldPosition(p);
        var dist = cam.position.distanceTo(p);
        var q = p.clone().project(cam);
        if (q.z > 1 || q.z < -1) return;                      // behind the camera, or past its far plane
        var sx = (q.x + 1) / 2 * r.width, sy = (1 - q.y) / 2 * r.height;
        var d = Math.hypot(sx - px, sy - py);
        var reach = Math.max(DOT_PICK_PX, m.scale.x / (k * Math.max(dist, 1e-6)));
        if (d > reach) return;
        var score = d + pri * 0.01;                           // the nearest; on a tie, the old priority
        if (score < bestScore) { bestScore = score; best = { ballIndex: i, type: kind[1] }; }
      });
    });
    return best;
  }

  /** Each dot at least DOT_MIN_PX in radius on screen, whatever the zoom (the render loop asks). */
  function dotsOnScreen(b) {
    var cam = view.camera, k = worldPerPx();
    [b.handle, b.heightHandle, b.cornerHandle].forEach(function (m) {
      var base = m.userData.dotScale || m.scale.x;
      m.scale.setScalar(Math.max(base, DOT_MIN_PX * k * cam.position.distanceTo(m.position)));
    });
  }

  /**
   * Is the press the capture box's? 'dot': one of its three dots, in any mode
   * (item 8). 'face': REGION armed, the box itself, in front of what is drawn
   * there - a click there isolates what it holds, a drag scales its footprint.
   * Otherwise false.
   */
  function boxOwnsPress(e) {
    if (!balls.length) return false;
    if (dotAt(e)) return 'dot';
    if (mode !== 'select') return false;
    var v = view, rc = rayAt(e);
    var fh = rc.intersectObjects(balls.map(function (b) { return b.boxMesh; }), false)[0];
    if (!fh) return false;
    // Behind what the selection draws, the press is that thing's, not the box's.
    var drawn = firstDrawn(e, isolated ? [v.detailGroup] : [v.highlightGroup, v.overviewGroup]);
    return !drawn || fh.distance <= drawn.distance ? 'face' : false;
  }

  var selSetOf = null;        // the selection as a Set, kept while it is the same selection (a hover asks per move)

  /** Is the selection what is drawn under the pointer? */
  function selectedHit(e) {
    var v = view, rc = rayAt(e), ray = rc.ray;
    var roots = isolated ? [v.detailGroup] : [v.highlightGroup, v.overviewGroup];
    var best = null, bestScore = Infinity, scored = [];
    rc.intersectObjects(roots, true).forEach(function (h) {
      if (!drawnAt(h)) return;
      var sc = (h.object.isLine || h.object.isLineSegments ? ray.distanceToPoint(h.point) : 0) + h.distance * 1e-4;
      scored.push([sc, h]);
      if (sc < bestScore) { bestScore = sc; best = h; }
    });
    if (!best) return false;
    if (!selSetOf || selSetOf.arr !== currentSelection || selSetOf.n !== currentSelection.length) {
      selSetOf = { arr: currentSelection, n: currentSelection.length, set: new Set(currentSelection) };
    }
    var sel = selSetOf.set;
    var owns = function (h) {
      if (isolated) return true;
      for (var n = h.object; n; n = n.parent) if (n === v.highlightGroup) return true;
      var ud = h.object.userData || {};
      if (ud.segs && h.index != null) { var sg = ud.segs[Math.floor(h.index / 2)]; return !!sg && sel.has(sg); }
      if (ud.object) return sel.has(ud.object);
      return false;
    };
    // A highlight is drawn over the thing it marks, to within a hair: the nearest of such a pair is the selection's.
    var eps = Math.max(1e-3, best.distance * 2e-3);
    return scored.some(function (r) { return r[0] <= bestScore + eps && owns(r[1]); });
  }

  // --- a line pick that does not walk every line --------------------------------
  //
  // three.js picks a line by walking every segment of the mesh, and a slice's
  // feature mesh is all its moves of that type - tabletop's outer wall alone is
  // tens of thousands, asked on every hover and every press. A mesh this big
  // gets nso_bvh.js's tree over its segments (each as a flat triangle a, b, b),
  // built in that file's worker, and its raycast asks the tree which segments'
  // boxes - grown by the pick's reach - the ray passes through, then runs
  // three's OWN test on those and on nothing else: the same distanceSqToSegment,
  // the same reach, near and far, the same point and index, pushed in the same
  // order. So a line it picks is the line the walk picked; only lines that
  // could not be within reach are not asked. Until the tree is ready, the walk.

  var LINE_INDEX_MIN = 20000;
  var _lr = null, _lrCands = [], _lrStack = [];     // lineRaycast's scratch, made on its first use

  /** A LineSegments mesh, given the indexed pick when it is big enough to need one. */
  function indexLines(mesh) {
    var B = window.NSO_BVH, g = mesh.geometry, pos = g.attributes.position;
    if (!B || !B.ensure || g.index || !pos || pos.count / 2 < LINE_INDEX_MIN) return mesh;
    var a = pos.array, n = pos.count / 2, soup = new Float32Array(n * 9);
    for (var i = 0; i < n; i++) {
      var s = i * 6, d = i * 9;
      soup[d] = a[s]; soup[d + 1] = a[s + 1]; soup[d + 2] = a[s + 2];
      soup[d + 3] = soup[d + 6] = a[s + 3]; soup[d + 4] = soup[d + 7] = a[s + 4]; soup[d + 5] = soup[d + 8] = a[s + 5];
    }
    mesh.userData.lineSoup = soup;
    B.ensure(soup, 0);
    mesh.raycast = lineRaycast;
    return mesh;
  }

  /** Segments whose box, grown by `reach`, the (local) ray enters: ascending. */
  function lineCandidates(ix, ray, reach, out) {
    var o = ray.origin, d = ray.direction, box = ix.box;
    var iX = Math.abs(d.x) < 1e-300 ? 1e300 : 1 / d.x, iY = Math.abs(d.y) < 1e-300 ? 1e300 : 1 / d.y, iZ = Math.abs(d.z) < 1e-300 ? 1e300 : 1 / d.z;
    var enters = function (b) {
      var p = (box[b] - reach - o.x) * iX, q = (box[b + 3] + reach - o.x) * iX;
      var t0 = Math.min(p, q), t1 = Math.max(p, q);
      p = (box[b + 1] - reach - o.y) * iY; q = (box[b + 4] + reach - o.y) * iY;
      t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q));
      p = (box[b + 2] - reach - o.z) * iZ; q = (box[b + 5] + reach - o.z) * iZ;
      t0 = Math.max(t0, Math.min(p, q)); t1 = Math.min(t1, Math.max(p, q));
      return Math.max(t0, 0) <= t1;
    };
    out.length = 0;
    if (!ix.nodes || !enters(0)) return out;
    var st = _lrStack;
    st.length = 0;
    st.push(0);
    while (st.length) {
      var nd = st.pop();
      if (ix.left[nd] < 0) {
        for (var q2 = ix.start[nd], e = q2 + ix.count[nd]; q2 < e; q2++) out.push(ix.order[q2]);
        continue;
      }
      if (enters(ix.left[nd] * 6)) st.push(ix.left[nd]);
      if (enters(ix.right[nd] * 6)) st.push(ix.right[nd]);
    }
    out.sort(function (x, y) { return x - y; });
    return out;
  }

  /** LineSegments.raycast (three r147), asked only about the tree's candidates. */
  function lineRaycast(raycaster, intersects) {
    var g = this.geometry, pos = g.attributes.position, soup = this.userData.lineSoup;
    var ix = soup && window.NSO_BVH.peek(soup);
    if (!ix || g.index || g.drawRange.start !== 0 || g.drawRange.count < pos.count || soup.length !== pos.count / 2 * 9) {
      return THREE.LineSegments.prototype.raycast.call(this, raycaster, intersects);
    }
    if (!_lr) _lr = { sphere: new THREE.Sphere(), inv: new THREE.Matrix4(), ray: new THREE.Ray(), a: new THREE.Vector3(),
                      b: new THREE.Vector3(), onRay: new THREE.Vector3(), onSeg: new THREE.Vector3() };
    var _lrSphere = _lr.sphere, _lrInv = _lr.inv, _lrRay = _lr.ray, _lrA = _lr.a, _lrB = _lr.b, _lrOnRay = _lr.onRay, _lrOnSeg = _lr.onSeg;
    var threshold = raycaster.params.Line.threshold, mw = this.matrixWorld;
    if (g.boundingSphere === null) g.computeBoundingSphere();
    _lrSphere.copy(g.boundingSphere);
    _lrSphere.applyMatrix4(mw);
    _lrSphere.radius += threshold;
    if (raycaster.ray.intersectsSphere(_lrSphere) === false) return;
    _lrInv.copy(mw).invert();
    _lrRay.copy(raycaster.ray).applyMatrix4(_lrInv);
    var reach = threshold / ((this.scale.x + this.scale.y + this.scale.z) / 3), reachSq = reach * reach;
    var list = lineCandidates(ix, _lrRay, reach, _lrCands);
    for (var k = 0; k < list.length; k++) {
      var i = list[k] * 2;
      _lrA.fromBufferAttribute(pos, i);
      _lrB.fromBufferAttribute(pos, i + 1);
      if (_lrRay.distanceSqToSegment(_lrA, _lrB, _lrOnRay, _lrOnSeg) > reachSq) continue;
      _lrOnRay.applyMatrix4(mw);
      var distance = raycaster.ray.origin.distanceTo(_lrOnRay);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      intersects.push({ distance: distance, point: _lrOnSeg.clone().applyMatrix4(mw), index: i, face: null, faceIndex: null, object: this });
    }
  }

  // --- what a click would take ------------------------------------------------

  /** The line under the pointer: { seg, point } - the nearest to the ray, of what is drawn. */
  function lineHitAt(e) {
    var v = view, rc = rayAt(e);
    var targets = Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.userData.segs && m.userData.segs.length; });
    var hits = rc.intersectObjects(targets, false);
    if (!hits.length) return null;
    // Closest to the cursor ray wins, not first along it: with a threshold,
    // many lines are "hit" and the nearest in depth is often a neighbour.
    var best = null, bestScore = Infinity;
    hits.forEach(function (h) {
      var sc = rc.ray.distanceToPoint(h.point) + h.distance * 1e-4;
      if (sc < bestScore) { bestScore = sc; best = h; }
    });
    var seg = best.object.userData.segs[Math.floor(best.index / 2)];
    return seg ? { seg: seg, point: best.point } : null;
  }

  /** The mesh object under the pointer: { obj, point } - the nearest drawn. */
  function objectHitAt(e) {
    var v = view, rc = rayAt(e);
    var meshes = Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.userData.object; });
    var hit = rc.intersectObjects(meshes, false).filter(drawnAt)[0];
    var out = hit ? { obj: hit.object.userData.object, point: hit.point, distance: hit.distance } : null;
    // A hover over a big piece whose tree (nso_bvh.js) is still building gets
    // nothing from its raycast (that file's hover rule: no walk of a million
    // triangles to repaint an outline). The hover still answers: where the ray
    // enters the piece's box stands in for its surface until the tree is ready -
    // as a drag holds such a piece (pieceWorld.hitOn). A press asks without the
    // hover flag and gets the real surface.
    if (rc.nsoHover) {
      meshes.forEach(function (m) {
        if (treeReady(m.geometry)) return;
        m.updateMatrixWorld(true);
        var p = rc.ray.intersectBox(new THREE.Box3().setFromObject(m), new THREE.Vector3());
        var d = p ? p.distanceTo(rc.ray.origin) : Infinity;
        if (p && (!out || d < out.distance)) out = { obj: m.userData.object, point: p, distance: d, box: true };
      });
    }
    return out;
  }

  /** The default-sized capture box a click at `pt` (view space) would drop, as data. */
  function tempBoxAt(pt) {
    var ang = pieceAngleNear(pt.x + doc.cx, -pt.z + doc.cy);
    var rx = defaultRx != null ? defaultRx : defaultR, ry = defaultRx != null ? defaultRy : defaultR;
    return { point: pt.clone(), rx: rx, ry: ry, h: defaultH, a: ang };
  }

  /**
   * What a click here would take, in the current mode: { items, source, point,
   * label } or null. Items are a slice's segments or a mesh's objects - the one
   * selection every export and pull already reads.
   */
  function targetAt(e) {
    if (!view || !doc || isolated) return null;     // isolated, the selection is all there is (selectedHit)
    var isPath = doc.kind === 'toolpath', t;
    // REGION's box goes where a click is, whatever it catches there: on a sparse
    // spot (no move's midpoint within the default box) the hover still shows
    // the box, holding nothing, and the click still places it.
    if (isPath) {
      var lh = lineHitAt(e);
      if (!lh) return null;
      var sg = lh.seg;
      if (mode === 'select') {
        var tb = tempBoxAt(lh.point);
        t = selectByBox([gcodeBoxOf(tb)]);
        return { items: t, source: 'box', point: lh.point, box: tb, label: 'region', seg: sg };
      }
      var shown = shownMemo();
      if (!shown.byObj.has(sg.obj)) shown.byObj.set(sg.obj, shown.list.filter(function (x) { return x.obj === sg.obj; }));
      return { items: shown.byObj.get(sg.obj).slice(), source: 'pick', point: lh.point, label: 'piece', seg: sg };
    }
    var oh = objectHitAt(e);
    if (!oh) return null;
    if (mode === 'select') {
      var tb2 = tempBoxAt(oh.point);
      t = selectByBox([gcodeBoxOf(tb2)]);
      return { items: t, source: 'box', point: oh.point, box: tb2, label: 'region', stand: oh.box ? 'box' : null };
    }
    // stand: 'box' when the piece's box answered for its surface (a big piece, its tree still building)
    return { items: [oh.obj], source: 'pick', point: oh.point, label: 'piece', stand: oh.box ? 'box' : null };
  }

  /**
   * A press here: the selection when it is under the pointer, else what the mode
   * takes. With REGION armed and nothing isolated, a press on the selection is
   * not "the selection": a click inside a box is the box's own (boxOwnsPress,
   * its face), and anywhere else - a piece the boxes hold, outside them; a piece
   * picked before - it places a box like any other click (item 7). Isolated,
   * the selection is the selection in every mode: a click on it makes the view
   * whole again, a drag copies it.
   */
  function selectionTakes() { return isolated || mode !== 'select'; }
  function pressTarget(e) {
    if (!doc) return null;
    if (currentSelection.length && selectionTakes() && selectedHit(e)) {
      return { items: currentSelection, source: selectionSource, selected: true, label: 'selection' };
    }
    return targetAt(e);
  }

  /** Everything the slider's range leaves drawn: one card. */
  function rangeTarget() {
    if (!doc) return null;
    var t = doc.kind === 'toolpath' ? shownSegments() : shownObjects();
    return t.length ? { items: t, source: 'range', label: 'range' } : null;
  }

  function sameItems(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var set = new Set(b);
    return a.every(function (x) { return set.has(x); });
  }

  // --- hover: an outline of what a click would take ---------------------------

  var HOVER_COLOR = 0x38bdf8;
  var hoverKey = '';
  var hoverTgt = null;     // what the outline stands for

  function clearHover() {
    hoverKey = '';
    hoverTgt = null;
    if (!view || !view.hoverGroup) return;
    var g = view.hoverGroup;
    for (var i = g.children.length - 1; i >= 0; i--) {
      var c = g.children[i];
      g.remove(c);
      if (c.geometry && !c.userData.sharedGeometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    if (view.renderer && view.renderer.domElement) view.renderer.domElement.style.cursor = '';
    hoverLine(null);
  }

  /** Draw `tgt` as the hover: its lines in the hover colour over the view, or its pieces tinted. */
  function drawHover(tgt) {
    if (!view || !tgt) { clearHover(); return; }
    var key = plateName + '|' + tgt.source + '|' + tgt.items.length + '|' + (tgt.items[0] && (tgt.items[0].id != null ? tgt.items[0].id : tgt.items[0].name)) +
      '|' + (tgt.box ? tgt.box.point.x.toFixed(2) + ',' + tgt.box.point.z.toFixed(2) : '');
    if (key === hoverKey) return;
    clearHover();
    hoverKey = key;
    hoverTgt = tgt;
    var g = view.hoverGroup;
    var mat = function () {
      return new THREE.LineBasicMaterial({ color: HOVER_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
    };
    if (doc.kind === 'toolpath' && tgt.items.length) {
      var segs = tgt.items;
      if (segs.length <= HIGHLIGHT_PRISM_CAP) {
        var pm = prismMesh(segs, HOVER_COLOR);
        pm.material.depthTest = false; pm.material.transparent = true; pm.material.opacity = 0.7;
        pm.renderOrder = 8;
        g.add(pm);
      } else {
        var lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(segPositions(segs), 3));
        var ls = new THREE.LineSegments(lg, mat());
        ls.renderOrder = 8;
        g.add(ls);
      }
    } else if (doc.kind !== 'toolpath') {
      tgt.items.forEach(function (o) {
        var m = view.overviewMeshes[o.name];
        if (!m || !m.visible) return;
        var h = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({
          color: HOVER_COLOR, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false
        }));
        h.position.copy(m.position);
        h.renderOrder = 8;
        h.userData.sharedGeometry = true;
        g.add(h);
        var kept = pieceEdges(o);
        var edges = new THREE.LineSegments(kept || new THREE.EdgesGeometry(m.geometry, 30), mat());
        if (kept) edges.userData.sharedGeometry = true;
        edges.position.copy(m.position);
        edges.renderOrder = 8;
        g.add(edges);
      });
    }
    if (tgt.box) {
      // what a click would drop: the box, as a wire
      var b = tgt.box;
      var wire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), mat());
      wire.position.copy(b.point);
      wire.rotation.set(0, b.a || 0, 0);
      wire.scale.set(b.rx * 2, b.h * 2, b.ry * 2);
      wire.renderOrder = 8;
      g.add(wire);
    }
    if (view.renderer.domElement) view.renderer.domElement.style.cursor = 'pointer';
  }

  // One hover per HOVER_EVERY ms at most - and the LAST move always gets one. A
  // move inside the window is kept as the one pending (a newer move replaces
  // it), and ONE timer runs it when the window is up; a timer that finds the
  // window not yet up waits out the rest instead of letting go of the move.
  // (Each such move used to arm a timer of its own, and a stale one that fired
  // within 40 ms of a hover took the newest move and dropped it: the pointer
  // came to rest on a piece with no outline at all, in whichever mode lost the
  // race on that machine. gscope:select drives that exact sequence on a fake
  // clock.) The clock is performance.now(), which does not jump as the wall
  // clock can, and a last hover stamped AHEAD of it (a clock swapped or set
  // back) waits for nothing - it can never hold the hover off.
  var hoverPending = null, hoverAt = -Infinity, hoverTimer = null, HOVER_EVERY = 40;
  function hoverWait() {
    var since = performance.now() - hoverAt;
    return since < 0 || since >= HOVER_EVERY ? 0 : HOVER_EVERY - since;
  }
  function onHoverMove(e) {
    if (!view || !isOpen() || pull || e.buttons || view.dragState) { hoverPending = null; if (e.buttons) clearHover(); return; }
    if (e.target !== view.renderer.domElement) {
      hoverPending = null;            // off the canvas: a move made on it is not answered late
      // the range card outlines what it would take; moving over it is not leaving it
      if (hoverKey && !(e.target.closest && e.target.closest('#ms-zr-card'))) clearHover();
      return;
    }
    hoverPending = e;
    var wait = hoverWait();
    if (!wait) flushHover();
    else if (!hoverTimer) hoverTimer = setTimeout(flushHover, Math.ceil(wait));
  }
  function flushHover() {
    hoverTimer = null;
    if (!hoverPending) return;
    var wait = hoverWait();
    if (wait) { hoverTimer = setTimeout(flushHover, Math.ceil(wait)); return; }
    var e = hoverPending; hoverPending = null;
    hoverAt = performance.now();
    hoverNow(e);
  }
  function hoverNow(e) {
    if (!view || !doc || !isOpen() || pull) return;
    var tgt = null, own = false, seg = null;
    // a hover over a big plate 2 piece whose tree (nso_bvh.js) is not built yet outlines nothing until it is,
    // rather than walk every triangle - the main viewport's hover does the same
    view.raycaster.nsoHover = true;
    try {
      // a box's dot or (REGION armed) the box itself: a press there is the box's, so
      // nothing new is outlined - what a click inside it isolates is the selection, lit already
      own = boxOwnsPress(e);
      if (!own && currentSelection.length && selectionTakes() && selectedHit(e)) {
        if (doc.kind === 'toolpath') { var lh = lineHitAt(e); seg = lh && lh.seg; }
      } else if (!own) {
        tgt = targetAt(e);
        seg = tgt && tgt.seg;
      }
    } catch (err) { tgt = null; }
    finally { view.raycaster.nsoHover = false; }
    if (own || !tgt) clearHover(); else drawHover(tgt);
    if (own) view.renderer.domElement.style.cursor = own === 'dot' ? 'grab' : 'pointer';
    hoverLine(seg);
  }

  /** A piece dragged onto the active plate (one that moves when dragged) under the pointer, or null. */
  function takePieceAt(e) {
    if (!doc || doc.kind !== 'mesh' || boxOwnsPress(e)) return null;
    var oh = objectHitAt(e);
    return oh && oh.obj.take ? oh.obj : null;
  }

  // --- carrying a thing across the floor, for app-grab-drop.js ---------------------
  //
  // Two worlds, one floor. PIECE WORLD: a piece on the active plate, grabbed -
  // it moves on its bed, onto another piece (seated), into the air, and carried
  // over the OTHER plate's bed and let go it is COPIED there (it stays where it
  // was). GHOST WORLD: a pull's copy (makeGhost), carried from the plate it was
  // pressed on - its home - over to the other plate, which is active for the
  // drag; let go there it lands (setDownOn), let go back over home nothing is
  // copied. In both, whatever is carried slides on WHICHEVER BED is under the
  // pointer - the active plate's or the other one - so it is under the pointer
  // every frame of the way and lands exactly where it was let go.

  function takeMesh(o) { return view && view.overviewMeshes[o.name]; }
  function takeBox(o) { var m = takeMesh(o); m.updateMatrixWorld(true); return new THREE.Box3().setFromObject(m); }

  var BED_PLANE = null;
  var carriedOver = null;        // what the last under() found: { kind: 'plate' | 'piece' | 'air', plate }

  /** Is this ray's meeting with the floor plane on plate `name`'s floor (its label strip too)? */
  function onFloorOf(name, rc) {
    var bp = new THREE.Vector3(), half = plateSide / 2;
    if (!rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), bp)) return null;
    if (bp.distanceTo(rc.ray.origin) > view.camera.far) return null;
    var x = bp.x - plateOffset(name);
    return (Math.abs(x) <= half && bp.z >= -half && bp.z <= half + 14) ? bp : null;
  }

  /** Where this ray meets plate `name`'s bed (its square), in the active plate's frame, or null. */
  function bedOf(name, rc) {
    if (!BED_PLANE) BED_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    var bp = new THREE.Vector3(), half = plateSide / 2;
    if (!rc.ray.intersectPlane(BED_PLANE, bp) || bp.distanceTo(rc.ray.origin) > view.camera.far) return null;
    return (Math.abs(bp.x - plateOffset(name)) <= half && Math.abs(bp.z) <= half) ? bp : null;
  }

  /**
   * What is under the pointer for a carried thing: a piece of the active plate
   * (not `self`) to seat onto, either plate's bed to slide on, or the air.
   */
  function underCarry(ev, self) {
    var rc = pieceWorld.ray(ev);
    var meshes = Object.keys(view.overviewMeshes).map(function (k) { return view.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.userData.object && m.userData.object !== self; });
    var hit = rc.intersectObjects(meshes, false).filter(function (h) { return h.face && drawnAt(h); })[0];
    var bed = null, which = null;
    [plateName, otherPlate()].some(function (n) {
      var bp = bedOf(n, rc);
      if (bp) { bed = { point: bp, distance: bp.distanceTo(rc.ray.origin) }; which = n; }
      return !!bp;
    });
    if (hit && (!bed || hit.distance <= bed.distance)) {
      carriedOver = { kind: 'piece', plate: plateName };
      var n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      return { kind: 'piece', placed: hit.object.userData.object, point: hit.point.clone(), normal: n };
    }
    if (bed) { carriedOver = { kind: 'plate', plate: which }; return { kind: 'plate', point: bed.point, plate: which }; }
    carriedOver = { kind: 'air', plate: onFloorOf(otherPlate(), rc) ? otherPlate() : plateName };
    return { kind: 'air' };
  }

  /** The carried mesh slid on the bed under the pointer: its bottom on y = 0, held where it was grabbed. */
  function slideOnBed(m, G, u) {
    m.position.set(u.point.x + G.grabOff.x, 0, u.point.z + G.grabOff.z);
    m.updateMatrixWorld(true);
    m.position.y -= new THREE.Box3().setFromObject(m).min.y;
    m.updateMatrixWorld(true);
    return true;
  }

  /** Lowest point of the carried mesh on the bed: raised if it would be under it. */
  function placeAbove(m, pos) {
    m.position.copy(pos);
    m.updateMatrixWorld(true);
    var lo = new THREE.Box3().setFromObject(m).min.y;
    if (lo < 0) { m.position.y -= lo; m.updateMatrixWorld(true); }
  }

  var pieceWorld = {
    name: 'piece',
    ray: function (ev) {
      var q = ndc(ev);
      view.raycaster.setFromCamera(new THREE.Vector2(q[0], q[1]), view.camera);
      return view.raycaster;
    },
    camera: function () { return view.camera; },
    under: underCarry,
    meshOf: takeMesh,
    boxOf: takeBox,
    posOf: function (o) { return takeMesh(o).position.clone(); },
    hitOn: function (o, rc) {
      var m = takeMesh(o);
      m.updateMatrixWorld(true);
      // where the grab holds it. A big piece with no tree yet (a piece just set
      // down: 2.4M triangles for a 200,000-move slice) is held where the ray
      // enters its box - a walk of every triangle was 0.3 s before it could move
      if (!treeReady(m.geometry)) {
        var pt = rc.ray.intersectBox(takeBox(o), new THREE.Vector3());
        return pt ? { point: pt, distance: pt.distanceTo(rc.ray.origin), object: m } : undefined;
      }
      return rc.intersectObject(m, false)[0];
    },
    keyOf: function (o) { return o.name; },
    nameOf: function (o) { return '"' + (o && o.name || 'piece') + '"'; },
    isSupport: function () { return false; },
    snapshot: function (o) { return { pos: takeMesh(o).position.clone() }; },
    restore: function (G) { var m = takeMesh(G.p); if (m) { m.position.copy(G.from.pos); m.updateMatrixWorld(true); } },
    placeAt: function (o, pos) { placeAbove(takeMesh(o), pos); },
    onPlate: function (G, ev, u) { return slideOnBed(takeMesh(G.p), G, u); },
    endPlate: function (G) {
      if (carriedOver && carriedOver.plate !== plateName) return copyAcross(G);
      var h = takeCommit(G);
      say(pieceWorld.nameOf(G.p) + ' set down on ' + plateTitle(plateName).toLowerCase() + '.');
      return { handled: true, mode: 'plate', liftY: h };
    },
    endAir: function (G) {
      var h = takeCommit(G);
      say(pieceWorld.nameOf(G.p) + ' left in the air, ' + h.toFixed(2) + ' mm over ' + plateTitle(plateName).toLowerCase() +
          '\'s bed - it stays there; grab it again to move it.');
      return { handled: true, mode: 'air', liftY: h };
    },
    seat: function (G, T, pt) { return takeSeat(G, T, pt); },
    onCancel: function () {},
    scene: function () { return view.scene; },
    attach: function (sc, lyr) { sc.add(lyr); }
  };

  /**
   * A piece of the active plate let go over the OTHER plate's bed: a copy of it
   * set down there, where it was let go, and that plate active; the piece itself
   * is back where it was. Refused (a mesh onto a slice): it is back, nothing copied.
   */
  function copyAcross(G) {
    var o = G.p, m = takeMesh(o), home = plateName, other = otherPlate();
    var at = soupAnchor(o.positions);
    var disp = m.position.clone().sub(m.userData.base || new THREE.Vector3());
    var off = plateOffset(other);
    // the anchor where it stands now, in the other plate's frame
    var pos = new THREE.Vector3(at.x - doc.cx + disp.x - off, at.z + disp.y, -(at.y - doc.cy) + disp.z);
    pieceWorld.restore(G);
    var g = { name: o.name, spec: { name: o.name, from: o.take ? o.take.from : doc.name, positions: o.positions, moves: o.moves },
              at: at, geo: null, mesh: null, beads: false };
    showPlate(other);
    var landed = setDownOn(g, pos, null);
    if (!landed) { showPlate(home); return { handled: true, mode: 'cancel', reason: 'refused' }; }
    if (!Array.isArray(landed)) {          // (a slice joined says so itself)
      say(pieceWorld.nameOf(o) + ' copied onto ' + plateTitle(other).toLowerCase() + ', where it was let go; it is still on ' +
          plateTitle(home).toLowerCase() + ' too.');
    }
    return { handled: true, mode: 'plate', copied: true };
  }

  /** The ghost's world: GHOST WORLD above. The other plate is active for the drag; `pull.home` is where it came from. */
  var ghostWorld = {
    name: 'ghost',
    ray: pieceWorld.ray,
    camera: pieceWorld.camera,
    under: function (ev) { return underCarry(ev, null); },
    meshOf: function (g) { return g.mesh; },
    // the ghost's box - or, for the seat's outline, the box of the piece it is over
    boxOf: function (q) {
      if (!q || !q.ghost) return takeBox(q);
      q.mesh.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(q.mesh);
    },
    posOf: function (g) { return g.mesh.position.clone(); },
    // the copy has no tree yet: it is held where the ray enters its box
    hitOn: function (g, rc) {
      var pt = rc.ray.intersectBox(ghostWorld.boxOf(g), new THREE.Vector3());
      return pt ? { point: pt, distance: pt.distanceTo(rc.ray.origin), object: g.mesh } : undefined;
    },
    keyOf: function (q) { return q && q.ghost ? 'ghost:' + q.name : q.name; },
    nameOf: function (g) { return '"' + (g && g.name || 'piece') + '"'; },
    isSupport: function () { return false; },
    snapshot: function (g) { return { pos: g.mesh.position.clone() }; },
    restore: function (G) { if (G.p.mesh) { G.p.mesh.position.copy(G.from.pos); G.p.mesh.updateMatrixWorld(true); } },
    placeAt: function (g, pos) { placeAbove(g.mesh, pos); },
    onPlate: function (G, ev, u) { return slideOnBed(G.p.mesh, G, u); },
    endPlate: function (G) {
      if (carriedOver && pull && carriedOver.plate === pull.home) return ghostHome(G.p);
      return ghostLand(G.p, G.p.mesh.position.clone(), null, 'plate');
    },
    endAir: function (G) { return ghostLand(G.p, G.p.mesh.position.clone(), null, 'air'); },
    seat: function (G, T, pt) { return ghostSeat(G, T, pt); },
    onCancel: function (G) {
      // Escape: nothing kept, the plate it came from active again
      var home = pull ? pull.home : otherPlate();
      dropGhost(G.p, false);
      if (pull) pull.cancelled = true;
      showPlate(home);
      if (view) { view.controls.enabled = true; view.mouseDownPos = null; }
    },
    scene: pieceWorld.scene,
    attach: pieceWorld.attach
  };

  /** Let go over the plate it came from: nothing copied, that plate active again. */
  function ghostHome(g) {
    var home = pull ? pull.home : otherPlate();
    dropGhost(g, false);
    showPlate(home);
    say('Let go over ' + plateTitle(home).toLowerCase() + ' - nothing copied. Drag it over ' +
        plateTitle(otherPlate()).toLowerCase() + ' to copy it there.');
    return { handled: true, mode: 'cancel', reason: 'over home' };
  }

  /** The ghost set down on the active plate at `pos` (or seated: `placed`); refused, it is as if let go over home. */
  function ghostLand(g, pos, placed, how) {
    var me = plateTitle(plateName).toLowerCase();
    var landed = setDownOn(g, pos, placed);
    if (!landed) {
      var home = pull ? pull.home : otherPlate();
      dropGhost(g, false);
      showPlate(home);
      return { handled: true, mode: 'cancel', reason: 'refused' };
    }
    if (!Array.isArray(landed)) {
      var h = Math.max(0, landed.bounds.minZ);
      if (how === 'air' && h > 1e-3) say('"' + landed.name + '" left in the air, ' + h.toFixed(2) + ' mm over ' + me + '\'s bed - grab it to move it.');
      else if (how !== 'seat') say('"' + landed.name + '" set down on ' + me + '.');
    }
    return { handled: true, mode: how };
  }

  /** The ghost dropped onto a piece of the active plate: seated as a piece is (takeSeat), then set down. */
  function ghostSeat(G, T, pt) {
    var g = G.p, S = window.NSO_SeatSurface, nm = ghostWorld.nameOf;
    var fail = function (msg, reason) { say(msg, true); ghostHome(g); return { handled: true, mode: 'piece', ok: false, reason: reason }; };
    if (!S) return fail('Dropping onto a piece needs nso_seat_surface.js - nothing copied.', 'no seat');
    var gap = typeof readSeatGapInput === 'function' ? readSeatGapInput() : NaN;
    if (!isFinite(gap)) return fail('Seat gap slider is missing or out of range - nothing copied', 'no gap');
    // the copy as it stands now (restored to where the drag began), Z-up in the active plate's frame
    var p0 = g.mesh.position, sp = g.spec.positions;
    var d = [p0.x + doc.cx - g.at.x, -p0.z + doc.cy - g.at.y, p0.y - g.at.z];
    var soup = shiftedPositions(sp, d[0], d[1], d[2]);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) for (var a = 0; a < 3; a++) {
      if (soup[i + a] < lo[a]) lo[a] = soup[i + a];
      if (soup[i + a] > hi[a]) hi[a] = soup[i + a];
    }
    var plan = S.plan(T.positions, { soup: soup, box: { min: lo, max: hi }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
                      { point: [pt.x + doc.cx, -pt.z + doc.cy, pt.y], gap: gap });
    if (!plan.ok) return fail('Drop refused - nothing copied (' + plan.reason + ')', plan.reason);
    var placed = S.transformSoup(soup, plan.matrix);
    var zlo = Infinity;
    for (var k = 2; k < placed.length; k += 3) if (placed[k] < zlo) zlo = placed[k];
    if (zlo < -1e-4) return fail('Drop refused - that pose would put ' + nm(g) + ' ' + (-zlo).toFixed(2) + ' mm below the plate. Aim at a face that does not look down.', 'below the plate');
    var turned = plan.rotationDeg > 1e-3, mx = plan.matrix;
    var r = turned ? ghostLand(g, null, new Float32Array(placed), 'seat')
                   : ghostLand(g, new THREE.Vector3(p0.x + mx[12], p0.y + mx[14], p0.z - mx[13]), null, 'seat');
    if (r.mode === 'cancel') return Object.assign(r, { mode: 'piece', ok: false });
    var cl = isFinite(plan.clearance) ? plan.clearance.toFixed(3) : '-';
    say('Dropped onto ' + nm(T) + ': seated (clearance ' + cl + ' mm' + (turned ? ', ' + nm(g) + ' turned ' + plan.rotationDeg.toFixed(1) + ' degrees' : ', no turn needed') + ').');
    return { handled: true, mode: 'piece', ok: true, onto: T.name, seat: plan };
  }

  /** False only for a big geometry nso_bvh.js has no tree for yet (a pick on it would walk every triangle). */
  function treeReady(geo) {
    var B = window.NSO_BVH, pos = geo && geo.attributes.position;
    return !B || !B.peek || !pos || !B.isBig(geo) || !!B.peek(pos.array);
  }

  /** A big piece just set down: its tree built now, off the main thread, not at the next press on it. */
  function treeSoon(o) {
    var m = takeMesh(o), B = window.NSO_BVH;
    if (m && B && B.ensureGeometry && !treeReady(m.geometry)) setTimeout(function () { B.ensureGeometry(m.geometry); }, 0);
  }

  /** The carried piece let go: its offset baked into its triangles and beads, selected, drawn. Returns its height over the bed. */
  function takeCommit(G) {
    var o = G.p, m = takeMesh(o);
    var d = m.position.clone().sub(m.userData.base || new THREE.Vector3());
    bakePiece(o, d.x, -d.z, d.y);
    var h = Math.max(0, o.bounds.minZ);
    pieceRefresh();
    setSelection([o], 'pick');
    treeSoon(o);
    return h;
  }

  /** A drop onto another piece of the plate: NSO_SeatSurface's plan, the one Seat here and a main-plate drop use. */
  function takeSeat(G, T, pt) {
    var o = G.p, nm = pieceWorld.nameOf;
    var S = window.NSO_SeatSurface;
    var fin = function (ok, reason, extra) {
      takeCommit(G);
      return Object.assign({ handled: true, mode: 'piece', ok: ok, onto: T.name, reason: reason }, extra || {});
    };
    if (!S) { say('Dropping onto a piece needs nso_seat_surface.js - ' + nm(o) + ' is back where it was.', true); return fin(false, 'no seat'); }
    var gap = typeof readSeatGapInput === 'function' ? readSeatGapInput() : NaN;
    if (!isFinite(gap)) { say('Seat gap slider is missing or out of range - nothing seated', true); return fin(false, 'no gap'); }
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < o.positions.length; i += 3) for (var a = 0; a < 3; a++) {
      if (o.positions[i + a] < lo[a]) lo[a] = o.positions[i + a];
      if (o.positions[i + a] > hi[a]) hi[a] = o.positions[i + a];
    }
    // the point under the pointer, in the plate's Z-up frame
    var plan = S.plan(T.positions, { soup: o.positions, box: { min: lo, max: hi },
                                     matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
                      { point: [pt.x + doc.cx, -pt.z + doc.cy, pt.y], gap: gap });
    if (!plan.ok) { say('Drop refused - ' + nm(o) + ' is where it was (' + plan.reason + ')', true); return fin(false, plan.reason, { seat: plan }); }
    var placed = S.transformSoup(o.positions, plan.matrix);
    var zlo = Infinity;
    for (var k = 2; k < placed.length; k += 3) if (placed[k] < zlo) zlo = placed[k];
    if (zlo < -1e-4) {
      var why = 'that pose would put ' + nm(o) + ' ' + (-zlo).toFixed(2) + ' mm below the plate';
      say('Drop refused - ' + nm(o) + ' is where it was (' + why + '). Aim at a face that does not look down.', true);
      return fin(false, 'below the plate', { seat: plan });
    }
    var turned = plan.rotationDeg > 1e-3;
    if (turned) {
      // a turned bead is no longer a flat move: the piece stays a mesh
      o.positions = new Float32Array(placed);
      o.moves = null;
      o.turned = true;
      prepObject(o);
    } else {
      var mx = plan.matrix;
      bakePiece(o, mx[12], mx[13], mx[14]);
    }
    var cl = isFinite(plan.clearance) ? plan.clearance.toFixed(3) : '-';
    say('Dropped onto ' + nm(T) + ': seated (clearance ' + cl + ' mm' + (turned ? ', ' + nm(o) + ' turned ' + plan.rotationDeg.toFixed(1) + ' degrees' : ', no turn needed') + ').');
    takeCommit(G);
    return { handled: true, mode: 'piece', ok: true, onto: T.name, seat: plan };
  }

  // --- the gesture ---------------------------------------------------------------
  //
  // One press, decided by what follows it - the same on either plate:
  //   it travels past the slop  -> a piece dragged onto this plate MOVES (and let
  //                                go over the other plate, is copied there);
  //                                anything else is PULLED: a copy of it, the
  //                                ghost, carried over to the other plate
  //   it is let go in place     -> CLICK: the thing is isolated; its click again un-isolates
  //   it was on bare floor      -> never taken: OrbitControls has it
  //   it was on the OTHER plate -> never taken either (a drag there orbits); let go
  //                                in place, it makes that plate the active one

  /** Taking the press from the orbit. A click still reaches the click hooks and the click below. */
  function claimPress(e) {
    view.mouseDownPos = [e.clientX, e.clientY];
    view.hookTook = false;
    // A finger is not taken from the orbit: a second one down is a pinch, and a drag is the
    // touch orbit. A tap still clicks (below); the drag is the mouse's and the pen's.
    if (e.pointerType === 'touch') return;
    e.stopImmediatePropagation();
    view.controls.enabled = false;
  }

  /**
   * Which plate that is not the active one the pointer is on - its floor, its
   * label, or anything drawn on it - or null. `floorOnly` skips what is drawn
   * (hover asks often, and a floor test is one plane).
   */
  function otherPlateAt(e, floorOnly) {
    if (!view) return null;
    var o = otherPlate(), rc = rayAt(e);
    if (onFloorOf(o, rc)) return o;
    if (floorOnly) return null;
    var gs = plateGroups(o).filter(function (g) { return g.visible; });
    return rc.intersectObjects(gs, true).some(drawnAt) ? o : null;
  }

  /** A press that the active plate does not take: on the other plate, it is noted for the click. */
  function notePlatePress(e) {
    var o = otherPlateAt(e);
    if (o) view.platePress = { x: e.clientX, y: e.clientY, name: o };
  }

  function onPressCapture(e) {
    var v = view;
    hoverPending = null;                                    // the press picks for itself (pressTarget); a move still waiting is not drawn after it
    if (pull && pull.touch) pull.cancelled = true;          // a second finger: the pinch's, not a click's
    if (v) { v.platePress = null; v.regionPress = null; }
    if (!v || e.button !== 0 || pull) return;
    if (!doc) { notePlatePress(e); return; }
    var own = boxOwnsPress(e);
    if (own) {                                     // the box's dots and face: the older handler has them
      // ...and a click inside the box (no travel, not on a dot) toggles the isolation of what it holds
      v.boxPress = { x: e.clientX, y: e.clientY, dot: own === 'dot' };
      return;
    }
    v.boxPress = null;
    var tgt = pressTarget(e);
    if (!tgt) { notePlatePress(e); return; }    // bare floor: orbit (the other plate: a click there activates it)
    // REGION where its box would hold nothing: the press is not taken - a drag
    // orbits, as on bare floor - and a click there still places the box
    if (tgt.source === 'box' && !tgt.items.length && !tgt.selected) { v.regionPress = { x: e.clientX, y: e.clientY, tgt: tgt }; return; }
    // a piece dragged here, nothing isolated, by the mouse: it is grabbed - it moves
    var o = !isolated && e.pointerType !== 'touch' ? takePieceAt(e) : null;
    if (o && window.nsoGrab && window.nsoGrab.begin(o, null, e, pieceWorld)) {
      var tg = (selectionTakes() && currentSelection.length === 1 && currentSelection[0] === o && selectedHit(e))
        ? { items: currentSelection, source: selectionSource, selected: true } : tgt;
      claimPress(e);
      pull = { kind: 'move', piece: o, tgt: tg, home: plateName, x0: e.clientX, y0: e.clientY, live: false, cancelled: false };
      return;
    }
    claimPress(e);
    pull = { kind: 'new', tgt: tgt, home: plateName, x0: e.clientX, y0: e.clientY, live: false, cancelled: false, touch: e.pointerType === 'touch' };
  }

  /** A press that began on a DOM card (the range grip): the target is given. */
  function pressCard(ev, tgtFn) {
    if (ev.button !== 0 || pull || !doc) return;
    var tgt = tgtFn();
    if (!tgt) return;
    pull = { kind: 'new', tgt: tgt, home: plateName, x0: ev.clientX, y0: ev.clientY, live: false, cancelled: false, dom: true };
  }

  /**
   * The slop is crossed: the plate it was pressed on stays as it is, the other
   * plate becomes the active one (the camera moves with the plates, so nothing
   * on screen jumps), and the copy - the ghost - is in hand under the pointer,
   * still over its home plate until it is carried across.
   */
  function startPull(e) {
    var spec = pullSpec(pull.tgt);
    if (!spec) { pull.cancelled = true; view.controls.enabled = true; return false; }
    clearHover();
    showPlate(otherPlate());
    var g = makeGhost(spec);
    var rc = pieceWorld.ray(e), bp = new THREE.Vector3();
    var onBed = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), bp) && bp.distanceTo(rc.ray.origin) <= view.camera.far;
    g.mesh.position.set(onBed ? bp.x : 0, 0, onBed ? bp.z : 0);
    g.mesh.updateMatrixWorld(true);
    if (!window.nsoGrab || !window.nsoGrab.begin(g, null, e, ghostWorld, { live: true })) {
      dropGhost(g, false);
      showPlate(pull.home);
      pull.cancelled = true; view.controls.enabled = true;
      return false;
    }
    pull.live = true; pull.piece = g;
    say('Copying "' + g.name + '" - carry it over ' + plateTitle(plateName).toLowerCase() + ' and let go there. Esc cancels.');
    return true;
  }

  function onPullMove(e) {
    if (!pull || pull.cancelled) return;
    // a finger that travels is the orbit's: the press was never taken from it
    if (pull.touch) { if (Math.hypot(e.clientX - pull.x0, e.clientY - pull.y0) >= pullSlop()) pull.cancelled = true; return; }
    if (pull.kind === 'new' && !pull.live) {
      if (Math.hypot(e.clientX - pull.x0, e.clientY - pull.y0) < pullSlop()) return;
      if (!startPull(e)) return;
    }
    if (window.nsoGrab && window.nsoGrab.active()) {
      window.nsoGrab.move(e);
      if (pull) pull.live = pull.live || window.nsoGrab.live();
      // which plate it would be let go over, said once each time it changes
      var c = carriedOver || { kind: 'air', plate: plateName };
      var over = c.kind === 'air' ? 'air' : c.plate === plateName ? 'active' : 'other';
      if (pull && over !== pull.over) {
        var nm = '"' + ((pull.piece && pull.piece.name) || 'piece') + '"';
        var oth = plateTitle(otherPlate()).toLowerCase(), me = plateTitle(plateName).toLowerCase();
        if (pull.kind === 'new' && over === 'other') say('Over ' + oth + ', where it came from - let go here and nothing is copied. Carry it over ' + me + '.');
        else if (pull.kind === 'move' && over === 'other') say('Over ' + oth + ' - let go to copy ' + nm + ' there; it stays on ' + me + ' too.');
        else if (over === 'air' && pull.over === 'other') say('Over nothing - let go to leave ' + nm + ' in the air where it is. Esc puts it back.');
        pull.over = over;
      }
    }
  }

  function onPullUp(e) {
    if (!pull) {
      var pp = view && view.platePress;
      if (pp) {
        view.platePress = null;
        if (e && !view.hookTook && Math.hypot(e.clientX - pp.x, e.clientY - pp.y) < pullSlop() && isOpen()) { activatePlate(pp.name); return; }
      }
      var rp = view && view.regionPress;
      if (rp) {
        view.regionPress = null;
        if (e && !view.hookTook && Math.hypot(e.clientX - rp.x, e.clientY - rp.y) < pullSlop() && isOpen() && doc) { clickTarget(rp.tgt, e); return; }
      }
      var bp = view && view.boxPress;
      // a click inside a box (no travel): what the boxes hold, isolated - or whole
      // again; a dot is a handle: pressed and let go, it isolates nothing (item 8)
      if (bp && !bp.dot && e && Math.hypot(e.clientX - bp.x, e.clientY - bp.y) < pullSlop()) {
        if (isolated) unIsolate(); else isolateBoxes();
      }
      if (view) view.boxPress = null;
      return;
    }
    var P = pull, r = null;
    // Whatever the drop does - and it reaches far: a seat, a slice joined, a
    // plate redrawn - the press is over when it returns or throws. A throw
    // that left `pull` set used to lock G-scope: no click, hover or pull
    // was ever taken again, and the orbit stayed off.
    try {
      r = !P.cancelled && window.nsoGrab && window.nsoGrab.active() ? window.nsoGrab.end() : null;
    } catch (err) {
      console.error('[g-scope] let go', err);
      P.cancelled = true;
      // the grab is put back too - else app-grab-drop.js keeps it, takes the next
      // Escape for itself and replays the failed drop on the next click
      try { if (window.nsoGrab && window.nsoGrab.active()) window.nsoGrab.cancel(); }
      catch (err2) { console.error('[g-scope] put back', err2); }
      say('That drop failed - see the console. Nothing was copied; G-scope is ready for the next press.', true);
    } finally {
      pull = null;
      carriedOver = null;
      if (view) view.controls.enabled = true;
    }
    if (P.cancelled) return;
    if (P.live || (r && r.handled)) { if (view) view.mouseDownPos = null; return; }
    if (P.dom) return;                                      // the card's own click does it
    if (view && view.hookTook) { view.hookTook = false; return; }
    // a press that never travelled is a click
    if (P.tgt && Math.hypot(e.clientX - P.x0, e.clientY - P.y0) < pullSlop()) clickTarget(P.tgt, e);
    if (view) view.mouseDownPos = null;
  }

  /**
   * A click on a target. On the selection: isolated, it is whole again; else it
   * is isolated. REGION armed (item 7): the click PLACES a box where it is, and
   * does nothing else - the box's dots size it, and a click inside it (or
   * Isolate) isolates what it holds. On anything else: it becomes the
   * selection and is isolated.
   */
  function clickTarget(tgt, e) {
    if (!tgt || !doc) return;
    if (tgt.selected) { if (isolated) unIsolate(); else isolate(); return; }
    if (tgt.source === 'box') {
      // the box a click places, where it was placed
      var hp0 = tgt.point;
      var ang = pieceAngleNear(hp0.x + doc.cx, -hp0.z + doc.cy);
      if (defaultRx != null) addBall(hp0.clone(), defaultRx, defaultH, defaultRy, ang);
      else addBall(hp0.clone(), defaultR, defaultH, undefined, ang);
      selectionSource = 'box';
      computeSelectionInfo();
      syncExportRow();
      return;
    }
    if (tgt.source === 'line' && tgt.seg) {
      pickLine(tgt.seg, false);
    } else {
      removeAllBalls();
      setSelection(tgt.items, tgt.source);
    }
    isolate();
  }

  /**
   * Isolate (the REGION row) and a click inside a box: what the boxes hold, taken
   * again from the boxes - a piece moved or dropped since may have been
   * selected - and isolated. False with no box.
   */
  function isolateBoxes() {
    if (isolated || !balls.length) return false;
    selectionSource = 'box';
    computeSelectionInfo();
    return isolate();
  }

  /** Escape on a box not isolated: the last one placed goes (item 7). True if one did. */
  function removeLastBox() {
    if (isolated || !balls.length || !view) return false;
    var b = balls.pop();
    boxParts(b).forEach(function (o) { view.scene.remove(o); disposeTree(o); });
    selectionSource = 'box';
    computeSelectionInfo();
    syncExportRow();
    return true;
  }

  /** A click on the other plate: it is the active one now - its Features, slider, cards and Export. */
  function activatePlate(name) {
    if (showPlate(name) !== name) return false;
    say((name === 'take' ? 'Plate 2' : 'Plate 1') + ' is active - the Features list, the slider, every card and Export act on it.');
    return true;
  }

  /** Whole again: what was isolated stays selected. */
  function unIsolate() {
    if (!isolated) return false;
    back();
    return true;
  }

  function rangeCardClick() {
    if (!doc) return;
    var t = rangeTarget();
    if (!t) return;
    t.selected = isolated && selectionSource === 'range' && sameItems(t.items, currentSelection);
    clickTarget(t);
  }
  function rangeCardPress(ev) { pressCard(ev, rangeTarget); }

  function cancelPull() {
    if (!pull) return;
    // a cancel that throws must not stop what asked for it (close() starts here)
    try { if (window.nsoGrab && window.nsoGrab.active()) window.nsoGrab.cancel(); }
    catch (err) { console.error('[g-scope] cancel', err); }
    if (pull) pull.cancelled = true;
  }

  function onPullKey(e) {
    if (e.key !== 'Escape' || !pull || pull.live || pull.cancelled) return;
    // pressed but not yet pulled: Escape lets go of it
    pull.cancelled = true;
    if (window.nsoGrab && window.nsoGrab.active()) window.nsoGrab.cancel();
    if (view) view.controls.enabled = true;
    e.preventDefault();
    e.stopPropagation();
  }

  function buildWorld() {
    if (view) return view;
    var host = $('ms-viewport');
    if (!host || typeof THREE === 'undefined') return null;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0f13);

    var w = host.clientWidth || 800, h = host.clientHeight || 600;
    var camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 4000);
    camera.position.set(60, 60, 60);

    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 10, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // The plate's mapping: left orbits, middle zooms, right-drag pans in
    // screen space (the part follows the pointer at any orbit angle).
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.screenSpacePanning = true;

    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    // The reference tool adds this only on Isolate, so its detail cylinders
    // "actually read as 3D". A mesh document needs it from the first frame or
    // it renders as a flat silhouette, so it is added once, up front.
    var dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(1, 1, 1);
    scene.add(dl);

    // The two plates' floors (their grids, outlines and labels) are placePlates()'s,
    // on the "bed" plane (three.js XZ plane, y=0).

    var overviewGroup = new THREE.Group();
    scene.add(overviewGroup);
    var detailGroup = new THREE.Group();
    detailGroup.visible = false;
    scene.add(detailGroup);
    // The current selection, drawn over the overview so a picked line or a
    // caught region can be seen before anything is isolated or exported.
    var highlightGroup = new THREE.Group();
    scene.add(highlightGroup);
    // What a click would take, outlined under the pointer (hover).
    var hoverGroup = new THREE.Group();
    scene.add(hoverGroup);
    // The layer-range slider clips a mesh document with two planes.
    renderer.localClippingEnabled = true;

    var raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.6;

    view = {
      scene: scene, camera: camera, renderer: renderer, controls: controls,
      host: host,
      overviewGroup: overviewGroup, detailGroup: detailGroup, highlightGroup: highlightGroup, hoverGroup: hoverGroup,
      clip: clipPair(),
      overviewMeshes: {},
      raycaster: raycaster,
      dragRaycaster: new THREE.Raycaster(),
      wheelRaycaster: new THREE.Raycaster(),
      grid: null,
      floors: null,
      mouse: new THREE.Vector2(),
      resizePlane: new THREE.Plane(),
      running: false,
      dragState: null,
      mouseDownPos: null
    };

    wireViewport();
    wireLegendToggle();
    ensurePlates();
    return view;
  }

  /**
   * The minimize button on the floating feature list. Collapsed, the panel is
   * just its title row, so it stops covering the part; the choice is kept for
   * this browser. View state only - which features are hidden is untouched.
   */
  var legendToggleWired = false;
  function setLegendCollapsed(on) {
    var box = $('ms-legend-float'), btn = $('ms-legend-toggle');
    if (!box || !btn) return;
    box.classList.toggle('collapsed', !!on);
    btn.setAttribute('aria-expanded', String(!on));
    btn.innerHTML = on ? '+' : '&minus;';
    btn.title = on ? 'Show the list' : 'Minimize the list';
    try { localStorage.setItem('nso.gscope.legendCollapsed', on ? '1' : '0'); } catch (e) {}
  }
  function wireLegendToggle() {
    if (legendToggleWired) return;
    var box = $('ms-legend-float'), btn = $('ms-legend-toggle'), title = $('ms-legend-title');
    if (!box || !btn) return;
    legendToggleWired = true;
    var flip = function () { setLegendCollapsed(!box.classList.contains('collapsed')); };
    btn.addEventListener('click', flip);
    if (title) title.addEventListener('click', flip);
    var saved = null;
    try { saved = localStorage.getItem('nso.gscope.legendCollapsed'); } catch (e) {}
    if (saved === '1') setLegendCollapsed(true);
  }

  function disposeTree(obj) {
    obj.traverse(function (n) {
      if (n.geometry && !n.geometry.userData.kept) n.geometry.dispose();     // a piece's is kept (pieceGeometry)
      if (n.material) {
        (Array.isArray(n.material) ? n.material : [n.material]).forEach(function (m) { m.dispose(); });
      }
    });
  }

  function clearGroup(g) {
    for (var i = g.children.length - 1; i >= 0; i--) {
      var c = g.children[i];
      g.remove(c);
      disposeTree(c);
    }
  }

  // --- build overview: one LineSegments mesh per feature ---------------------
  // (or, for a mesh document, one Mesh per build object)

  function buildOverview() {
    var v = view;
    clearGroup(v.overviewGroup);
    v.overviewMeshes = {};
    v.solidMeshes = {};
    v.solidBuilt = null;
    if (!doc) return;

    if (doc.kind === 'toolpath') {
      var byFeature = {};
      doc.segments.forEach(function (s) {
        if (!byFeature[s.feature]) byFeature[s.feature] = [];
        byFeature[s.feature].push(s);
      });
      // The legend counts every move the file has; what is DRAWN is only the
      // moves inside the layer range and not cleared from view.
      doc.groups = byFeature;
      Object.keys(byFeature).forEach(function (feature, gi) {
        var segs = byFeature[feature].filter(function (s) { return !CLEARED.has(s.id) && inZRange(s); });
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(segPositions(segs), 3));
        var isTravel = feature === 'Travel';
        var mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
          color: colorForGroup(feature, gi),
          transparent: isTravel,
          opacity: isTravel ? 0.35 : 1.0
        }));
        mesh.userData.feature = feature;
        // Line i of this mesh is segs[i] - how a picked line finds its move.
        mesh.userData.segs = segs;
        indexLines(mesh);
        v.overviewMeshes[feature] = mesh;
        v.overviewGroup.add(mesh);
      });
      // Solid view: the same moves, swept. The line meshes stay in the scene
      // with their MATERIAL switched off - three.js still raycasts an object
      // whose material is invisible - so a line pick and a dropped box land
      // on exactly the moves they land on in the toolpath view.
      if (renderMode === 'solid') {
        Object.keys(v.overviewMeshes).forEach(function (k) { v.overviewMeshes[k].material.visible = false; });
        var shownNow = doc.segments.filter(function (s) { return !CLEARED.has(s.id) && inZRange(s); });
        var sm = solidMeshes(shownNow, function (f) { return colorForGroup(f, Object.keys(byFeature).indexOf(f)); });
        v.solidMeshes = sm.meshes;
        v.solidBuilt = sm.built;
        Object.keys(sm.meshes).forEach(function (k) { v.overviewGroup.add(sm.meshes[k]); });
      }
      return;
    }

    // Mesh route. One solid per build object, in the app's own material family,
    // so what the microscope shows is what the plate would show. A plate 2 piece
    // that is still a slice's beads is drawn bead by bead in its line types'
    // colours, minus the types Display has switched off.
    var byObject = {};
    var sig = featureSig();
    prunePieceGeometry(doc, sig);
    doc.objects.forEach(function (o, gi) {
      byObject[o.name] = o;
      var mesh = null;
      if (isPieces(doc) || o.take) {
        // a piece dragged here: built once and kept (pieceGeometry), sitting where it was moved to
        var pg = pieceGeometry(o, sig);
        mesh = new THREE.Mesh(pg.geo, pg.beads
          ? new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.4, clippingPlanes: clipPlanes() })
          : new THREE.MeshStandardMaterial({ color: colorForGroup(o.name, gi), metalness: 0.05, roughness: 0.4, clippingPlanes: clipPlanes() }));
        mesh.position.copy(pg.base);
        mesh.userData.base = pg.base.clone();
        if (pg.beads) mesh.userData.empty = !pg.geo.attributes.position.count;
      } else {
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.positions), 3));
        geo.translate(-doc.cx, -doc.cy, 0);
        geo.rotateX(-Math.PI / 2);          // the same (x,y,z) -> (x,z,-y) as toThree
        geo.computeVertexNormals();
        mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: colorForGroup(o.name, gi), metalness: 0.05, roughness: 0.4,
          clippingPlanes: clipPlanes()
        }));
      }
      mesh.userData.feature = o.name;
      mesh.userData.object = o;
      v.overviewMeshes[o.name] = mesh;
      v.overviewGroup.add(mesh);
    });
    doc.groups = byObject;
    v.takeSig = sig;
  }

  /** What Display has switched off, as one string: a plate of bead pieces is drawn from it, and rebuilt when it changes. */
  function featureSig() { return Array.from(FEATURE_OFF).sort().join('|'); }

  // --- plate 2's pieces, built once -------------------------------------------
  //
  // A plate 2 piece's drawn geometry - a slice's beads as their prisms (12
  // triangles a move, coloured by line type), or a mesh's own triangles - is
  // built ONCE and kept with the piece. A redraw of plate 2 (a pull, a drop, a
  // click that activates it) hands the same geometry to a new mesh; a piece
  // moved across the bed keeps it too, and the mesh stands where the piece was
  // moved to (`base`, view space). It is rebuilt only when what it is drawn
  // from changes: the piece turned by a seat (new triangles), or a line type
  // switched on or off (the signature). Kept, it also keeps nso_bvh.js's tree,
  // which every pick and hover on the piece asks.
  //
  // A drag's copy is drawn from the prisms the drag built (pullSpec), as a ghost
  // (makeGhost); set down on a mesh plate, that ghost's geometry is the piece's
  // from then on (setDownOn) - nothing is built a second time.

  var pieceGeoms = new Map();     // piece -> { geo, sig, positions, moves, base, beads, edges }

  function keptGeometry(geo) { geo.userData.kept = true; return geo; }

  function dropPieceGeometry(o) {
    var e = pieceGeoms.get(o);
    if (!e) return;
    pieceGeoms.delete(o);
    e.geo.dispose();
    if (e.edges) e.edges.dispose();
  }

  /** Throw away what no piece of `objects` draws any more (gone, or drawn from other data now). */
  function prunePieceGeometry(d, sig) {
    var live = new Set(d.objects);
    Array.from(pieceGeoms.keys()).forEach(function (o) {
      var e = pieceGeoms.get(o);
      if (e.doc !== d) return;                // the other plate's pieces are its own business
      if (!live.has(o) || e.positions !== o.positions || e.moves !== o.moves || (e.beads && e.sig !== sig)) dropPieceGeometry(o);
    });
  }

  /**
   * Z-up mm triangles into a view-space position attribute: (x, y, z) ->
   * (x - cx, z - cz, -(y - cy)), toThree's map about `at` - the document's
   * centre by default, a carried copy's footprint and bottom for a ghost.
   */
  function viewPositions(p, at) {
    var out = new Float32Array(p.length), cx = at ? at.x : doc.cx, cy = at ? at.y : doc.cy, cz = at ? at.z : 0;
    for (var i = 0; i < p.length; i += 3) { out[i] = p[i] - cx; out[i + 1] = p[i + 2] - cz; out[i + 2] = -(p[i + 1] - cy); }
    return out;
  }

  /**
   * A soup's normals, as computeVertexNormals + normalizeNormals (three r147)
   * leave them on a non-indexed geometry - (C - B) x (A - B), stored, read back
   * and scaled by 1 / length - in one pass over the arrays instead of a Vector3
   * round trip per vertex. The same float32 values, bit for bit.
   */
  function flatNormals(p) {
    var n = new Float32Array(p.length), f = Math.fround;
    for (var i = 0; i < p.length; i += 9) {
      var bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
      var cbx = p[i + 6] - bx, cby = p[i + 7] - by, cbz = p[i + 8] - bz;
      var abx = p[i] - bx, aby = p[i + 1] - by, abz = p[i + 2] - bz;
      var x = f(cby * abz - cbz * aby), y = f(cbz * abx - cbx * abz), z = f(cbx * aby - cby * abx);
      var s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
      x *= s; y *= s; z *= s;
      n[i] = n[i + 3] = n[i + 6] = x; n[i + 1] = n[i + 4] = n[i + 7] = y; n[i + 2] = n[i + 5] = n[i + 8] = z;
    }
    return n;
  }

  /**
   * A view-space soup as a geometry with its flat normals, and its bounding box
   * and sphere as computeBoundingBox / computeBoundingSphere would make them
   * (the box's centre, the farthest vertex) - made here in two flat passes,
   * because the frustum cull and plateBox would otherwise make them on the
   * first frame through a Vector3 per vertex, 0.3 s on a 200,000-move copy.
   */
  function soupGeometry(viewPos) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(viewPos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(flatNormals(viewPos), 3));
    if (viewPos.length) {
      var x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, i;
      for (i = 0; i < viewPos.length; i += 3) {
        var x = viewPos[i], y = viewPos[i + 1], z = viewPos[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
      var c = g.boundingBox.getCenter(new THREE.Vector3()), r2 = 0;
      for (i = 0; i < viewPos.length; i += 3) {
        var dx = c.x - viewPos[i], dy = c.y - viewPos[i + 1], dz = c.z - viewPos[i + 2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
      }
      g.boundingSphere = new THREE.Sphere(c, Math.sqrt(r2));
    }
    return g;
  }

  /**
   * The beads' prisms, as drawn: flat normals and each move's line-type colour -
   * held as bytes, which is what a line type's hex colour is (a quarter of the
   * upload of floats, the same colour on screen).
   */
  function beadGeometry(pos, moveIds, trisPerMove, moves, at) {
    var featOf = {}, rgb = {};
    moves.forEach(function (m) { featOf[m.index] = m.feature; });
    var colors = new Uint8Array(pos.length), per = trisPerMove * 9;
    for (var mi = 0; mi < moveIds.length; mi++) {
      var ft = featOf[moveIds[mi]], c = rgb[ft];
      if (c == null) c = rgb[ft] = featureColor(ft, 0);
      var r = (c >> 16) & 255, gr = (c >> 8) & 255, b = c & 255;
      for (var k = mi * per, end = k + per; k < end; k += 3) { colors[k] = r; colors[k + 1] = gr; colors[k + 2] = b; }
    }
    var bg = soupGeometry(viewPositions(pos, at));
    bg.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    return keptGeometry(bg);
  }

  /** The piece's kept geometry (built now if it has none that still fits). */
  function pieceGeometry(o, sig) {
    var e = pieceGeoms.get(o);
    if (e && e.positions === o.positions && e.moves === o.moves && (!e.beads || e.sig === sig)) return e;
    if (e) dropPieceGeometry(o);
    var G = window.NSOGcodeLines, geo, beads = false;
    if (o.moves && o.moves.length && G && G.buildLineGeometry) {
      var shown = o.moves.filter(function (m) { return !FEATURE_OFF.has(m.feature); });
      var built = G.buildLineGeometry(shown);
      geo = beadGeometry(built.positions, built.moveIds, built.trisPerMove, shown);
      beads = true;
    } else {
      geo = keptGeometry(soupGeometry(viewPositions(o.positions)));
    }
    e = { geo: geo, sig: sig, positions: o.positions, moves: o.moves, base: new THREE.Vector3(), beads: beads, edges: null, doc: doc };
    pieceGeoms.set(o, e);
    return e;
  }

  /**
   * The piece moved by (dx, dy, dz) mm, Z-up: its kept geometry is not rebuilt -
   * it follows the piece's new data and stands that much further along.
   */
  function movePieceGeometry(o, positions0, moves0, dx, dy, dz) {
    var e = pieceGeoms.get(o);
    if (!e || e.positions !== positions0 || e.moves !== moves0) return;
    e.positions = o.positions; e.moves = o.moves;
    e.base.add(new THREE.Vector3(dx, dz, -dy));
  }

  /**
   * The piece's outline for the hover: its edges past 30 degrees. A bead piece's
   * prisms are boxes, so those are each box's 12 edges, read straight off its
   * triangles (EdgesGeometry hashes every triangle edge, seconds on a slice);
   * a mesh piece's are EdgesGeometry's. Built on the first hover, kept.
   */
  function pieceEdges(o) {
    var e = pieceGeoms.get(o);
    if (!e) return null;
    if (e.edges) return e.edges;
    if (e.beads) {
      // extrudeFlatLine's 12 triangles: corner k of the box is vertex V[k] of the move's 36
      var V = [0, 4, 1, 2, 6, 8, 7, 10];
      var EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
      var p = e.geo.attributes.position.array, n = p.length / 108, out = new Float32Array(n * 72);
      for (var m = 0; m < n; m++) {
        var b = m * 108, w = m * 72;
        for (var j = 0; j < 24; j++) {
          var s = b + V[EDGES[j]] * 3;
          out[w + j * 3] = p[s]; out[w + j * 3 + 1] = p[s + 1]; out[w + j * 3 + 2] = p[s + 2];
        }
      }
      e.edges = new THREE.BufferGeometry();
      e.edges.setAttribute('position', new THREE.BufferAttribute(out, 3));
    } else {
      e.edges = new THREE.EdgesGeometry(e.geo, 30);
    }
    keptGeometry(e.edges);
    return e.edges;
  }

  // --- selection boxes ------------------------------------------------------
  // each is { point, rx, ry (horizontal half-extents along G-code X and Y),
  //           h (vertical half-extent), boxMesh, edges, handle, heightHandle,
  //           cornerHandle }
  //
  // The reference tool's box had ONE horizontal half-extent `r`, a square
  // footprint, and no corner handle - it never did, and neither did G-scope
  // until the corner handle below. The corner handle resizes the footprint
  // along G-code X and Y independently; `r` survives in gcodeBoxes() as the
  // larger of the two so a reader of the old field still gets a box that
  // covers the footprint.

  function makeBoxVisuals() {
    var v = view;
    var boxGeo = new THREE.BoxGeometry(1, 1, 1);
    var boxMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false });
    var boxMesh = new THREE.Mesh(boxGeo, boxMat); // used for raycasting the "resize footprint" drag
    var edgesGeo = new THREE.EdgesGeometry(boxGeo);
    var edges = new THREE.LineSegments(edgesGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
    boxMesh.add(edges);

    // The three dots are drawn over everything - no depth test, after the
    // hover and the highlight (renderOrder 20; those are 8) - like the rotate
    // rings: a handle you cannot see is one you cannot find, and the piece is
    // usually in front of at least one of them (item 8). dotAt() picks them on
    // screen, so what is drawn is what takes the press.
    var dotMat = function (c) {
      return new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true });
    };
    var handle = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), dotMat(0x5b8cff));         // centre dot - drag to MOVE
    var heightHandle = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), dotMat(0xffb35b));   // top dot - drag to set thickness
    var cornerHandle = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), dotMat(0x4cd97b));   // corner dot - drag to size X and Y
    handle.renderOrder = heightHandle.renderOrder = cornerHandle.renderOrder = 20;

    v.scene.add(boxMesh); v.scene.add(handle); v.scene.add(heightHandle); v.scene.add(cornerHandle);
    return { boxMesh: boxMesh, edges: edges, handle: handle, heightHandle: heightHandle,
             cornerHandle: cornerHandle };
  }

  /** The three dots and the box, the parts of a capture box a view shows or hides together. */
  function boxParts(b) { return [b.boxMesh, b.handle, b.heightHandle, b.cornerHandle]; }

  /**
   * Where the corner dot sits in view space: on the box's top face, at the
   * footprint corner nearest the camera - the one in front of the box, not
   * behind it. The resize is symmetric about the centre, so which corner
   * carries the dot changes nothing about what a drag does.
   */
  function cornerPoint(b) {
    var ax = boxAxes(b);
    var cam = view ? view.camera.position : null;
    var d = cam ? cam.clone().sub(b.point) : null;
    var sx = d && d.dot(ax.u) < 0 ? -1 : 1;
    var sz = d && d.dot(ax.w) < 0 ? -1 : 1;
    return b.point.clone()
      .addScaledVector(ax.u, sx * b.rx)
      .addScaledVector(ax.w, sz * b.ry)
      .add(new THREE.Vector3(0, b.h, 0));
  }

  /**
   * A box is turned about the vertical by `a`, the angle its own X axis makes
   * with G-code X (counter-clockwise, radians). In view space that is a plain
   * rotation.y of `a` - toThree maps G-code (x, y) to view (x, -y), so a turn
   * of `a` in the plate is a turn of `a` about view +Y. `u` is the box's own X
   * (rx along it), `w` its own view-Z (ry along it).
   */
  function boxAxes(b) {
    var a = b.a || 0, c = Math.cos(a), s = Math.sin(a);
    return { u: new THREE.Vector3(c, 0, -s), w: new THREE.Vector3(s, 0, c) };
  }

  /**
   * The angle a box dropped at G-code (gx, gy) should take so it lies square
   * to the piece next to it rather than square to the plate. Toolpath: the
   * walls nearest the drop - outer wall if the slice labels it, any wall if
   * not, any extrusion failing both - give the piece's frame as a
   * length-weighted mean of their directions folded mod 90 degrees (a
   * rectangle's two edge directions agree there, and a bar's short ends agree
   * with its long sides). Of the two axes of that frame the box takes the one
   * nearer the walls' mod-180 mean, so its own X runs along the piece's
   * longer run and a footprint drawn long stays long along the part. Mesh:
   * the principal axis of the nearest object's triangle centroids. Nothing
   * near, or no direction stronger than noise: 0, square to the plate.
   */
  function pieceAngleNear(gx, gy) {
    if (!doc) return 0;
    if (doc.kind === 'toolpath') {
      var tiers = [/outer wall|external perimeter|wall-outer/i, /wall|perimeter/i, null];
      for (var t = 0; t < tiers.length; t++) {
        var re = tiers[t], cand = [];
        doc.segments.forEach(function (s) {
          if (s.feature === 'Travel' || !segShown(s)) return;
          if (re && !re.test(s.feature || '')) return;
          var dx = s.x1 - s.x0, dy = s.y1 - s.y0;
          var len = Math.hypot(dx, dy);
          if (len < 1e-3) return;
          var mx = (s.x0 + s.x1) / 2 - gx, my = (s.y0 + s.y1) / 2 - gy;
          cand.push({ dx: dx, dy: dy, len: len, d: Math.hypot(mx, my) });
        });
        if (!cand.length) continue;
        var dMin = Infinity;
        cand.forEach(function (c) { if (c.d < dMin) dMin = c.d; });
        var reach = dMin + 20;              // the piece beside the drop, not the plate
        var c2 = 0, s2 = 0, c4 = 0, s4 = 0, wsum = 0;
        cand.forEach(function (c) {
          if (c.d > reach) return;
          var th = Math.atan2(c.dy, c.dx);
          c2 += c.len * Math.cos(2 * th); s2 += c.len * Math.sin(2 * th);
          c4 += c.len * Math.cos(4 * th); s4 += c.len * Math.sin(4 * th);
          wsum += c.len;
        });
        if (!wsum || Math.hypot(c4, s4) / wsum < 0.15) return 0;
        var frame = Math.atan2(s4, c4) / 4;                  // mod 90
        var along = Math.atan2(s2, c2) / 2;                  // mod 180
        var alt = frame + Math.PI / 2;
        var diff = function (x, y) {                         // distance mod 180
          var d = Math.abs(x - y) % Math.PI; return Math.min(d, Math.PI - d);
        };
        return diff(alt, along) < diff(frame, along) ? alt : frame;
      }
      return 0;
    }
    var best = null, bestD = Infinity;
    (doc.objects || []).forEach(function (o) {
      if (!objectShown(o) || !o.bounds) return;
      var ex = Math.max(o.bounds.minX - gx, 0, gx - o.bounds.maxX);
      var ey = Math.max(o.bounds.minY - gy, 0, gy - o.bounds.maxY);
      var d = Math.hypot(ex, ey);
      if (d < bestD) { bestD = d; best = o; }
    });
    if (!best || !best.centroids || best.centroids.length < 9) return 0;
    var cen = best.centroids, n = 0, sx = 0, sy = 0;
    for (var i = 0; i < cen.length; i += 3) { sx += cen[i]; sy += cen[i + 1]; n++; }
    sx /= n; sy /= n;
    var xx = 0, yy = 0, xy = 0;
    for (var j = 0; j < cen.length; j += 3) {
      var px = cen[j] - sx, py = cen[j + 1] - sy;
      xx += px * px; yy += py * py; xy += px * py;
    }
    // Round in plan (no long axis): leave it square to the plate.
    var spread = Math.hypot(xx - yy, 2 * xy);
    if (spread < 0.1 * (xx + yy)) return 0;
    return 0.5 * Math.atan2(2 * xy, xx - yy);
  }

  function updateBoxTransform(b) {
    var rMax = Math.max(b.rx, b.ry);
    b.boxMesh.position.copy(b.point);
    b.boxMesh.rotation.set(0, b.a || 0, 0);
    b.boxMesh.scale.set(b.rx * 2, b.h * 2, b.ry * 2);
    b.handle.position.copy(b.point);
    b.handle.userData.dotScale = Math.max(0.35, rMax * 0.1);
    b.heightHandle.position.set(b.point.x, b.point.y + b.h, b.point.z);
    b.heightHandle.userData.dotScale = Math.max(0.3, rMax * 0.08);
    b.cornerHandle.position.copy(cornerPoint(b));
    b.cornerHandle.userData.dotScale = Math.max(0.3, rMax * 0.08);
    // the size it has in the box; never under DOT_MIN_PX on screen
    if (view) dotsOnScreen(b);
    else [b.handle, b.heightHandle, b.cornerHandle].forEach(function (m) { m.scale.setScalar(m.userData.dotScale); });
  }

  // `r` is the square footprint every caller before the corner handle passed;
  // `ry`, when given, makes it a rectangle (r is then the X half-extent).
  // `a` turns it about the vertical (see boxAxes); omitted, square to the plate.
  function addBall(point, r, h, ry, a) {
    var b = Object.assign({ point: point.clone(), rx: r, ry: ry != null ? ry : r, h: h, a: a || 0 },
                          makeBoxVisuals());
    updateBoxTransform(b);
    balls.push(b);
    return b;
  }

  function removeAllBalls() {
    balls.forEach(function (b) {
      boxParts(b).forEach(function (o) { view.scene.remove(o); disposeTree(o); });
    });
    balls.length = 0;
  }

  /** The capture boxes as G-code-space centres and extents. */
  function gcodeBoxOf(b) {
    // Inverse of toThree: three (x, y, z) -> gcode (x + cx, -z + cy, y)
    var a = b.a || 0, ca = Math.cos(a), sa = Math.sin(a);
    return { gx: b.point.x + doc.cx, gy: -b.point.z + doc.cy, gz: b.point.y,
             rx: b.rx, ry: b.ry, r: Math.max(b.rx, b.ry), h: b.h, a: a,
             ca: ca, sa: sa,
             // plate-aligned half-extents of the turned footprint, for
             // bounding-box rejects
             ex: b.rx * Math.abs(ca) + b.ry * Math.abs(sa),
             ey: b.rx * Math.abs(sa) + b.ry * Math.abs(ca) };
  }

  function gcodeBoxes() {
    return balls.map(gcodeBoxOf);
  }

  /**
   * The reference tool's capture predicate, with its one horizontal extent
   * split in two so the corner handle can make the footprint a rectangle:
   *     |mx - gx| <= rx && |my - gy| <= ry && |mz - gz| <= h
   * With rx == ry it is the reference predicate exactly. The horizontal and
   * vertical extents stay independent, which is the whole point of the box -
   * a sphere reaching 5 mm across the plate also reaches 5 mm up, and that is
   * twenty layers.
   */
  function inBox(b, mx, my, mz) {
    if (Math.abs(mz - b.gz) > b.h) return false;
    var dx = mx - b.gx, dy = my - b.gy;
    var ca = b.ca != null ? b.ca : 1, sa = b.sa || 0;
    // into the box's own frame (it is turned by `a` about the vertical)
    return Math.abs(dx * ca + dy * sa) <= b.rx && Math.abs(-dx * sa + dy * ca) <= b.ry;
  }

  function selectByBox(boxesIn) {
    var boxes = boxesIn || gcodeBoxes();
    if (!boxes.length) return [];
    // What you can see is what a box catches: a feature switched off in the
    // legend, a line cleared from view or a layer outside the slider's range
    // is not caught. That is what makes feature-level isolation compose with
    // the box - hide everything but Support, drop a box, get only Support.
    if (doc.kind === 'toolpath') {
      return doc.segments.filter(function (s) {
        if (!segShown(s)) return false;
        var mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2, mz = s.z;
        return boxes.some(function (b) { return inBox(b, mx, my, mz); });
      });
    }
    // Mesh: whole build objects, not loose triangles. An object is taken when
    // the box holds any of its triangle centroids, or failing that when any of
    // its triangles crosses the box. See docs/GCODE-MICROSCOPE.md
    // for why the granularity is the object and not the triangle. What is
    // shown includes a detector row's feature drawn alone (shownObjects()).
    return shownObjects().filter(function (o) {
      var hit = boxes.filter(function (b) {
        return o.bounds.minX <= b.gx + b.ex && o.bounds.maxX >= b.gx - b.ex &&
               o.bounds.minY <= b.gy + b.ey && o.bounds.maxY >= b.gy - b.ey &&
               o.bounds.minZ <= b.gz + b.h && o.bounds.maxZ >= b.gz - b.h;
      });
      if (!hit.length) return false;          // bounding box misses every box
      var c = o.centroids;
      for (var t = 0; t < c.length; t += 3) {
        for (var k = 0; k < hit.length; k++) {
          if (inBox(hit[k], c[t], c[t + 1], c[t + 2])) return true;
        }
      }
      // No centroid inside, but a triangle may still cross the box: a few
      // long triangles - a flange lifted out of its part is 2,148 of them
      // over 187 mm - put every centroid far from a 5 mm box dropped on the
      // surface itself. Only reached when the centroids miss, so a dense
      // part costs what it always did.
      for (var k2 = 0; k2 < hit.length; k2++) {
        if (anyTriangleInBox(hit[k2], o.positions)) return true;
      }
      return false;
    });
  }

  /** Does any triangle of a Z-up soup cross box `b` (gcodeBoxes() form)? */
  function anyTriangleInBox(b, p) {
    var ca = b.ca != null ? b.ca : 1, sa = b.sa || 0, v = new Array(9);
    for (var t = 0; t < p.length; t += 9) {
      for (var i = 0; i < 3; i++) {
        // into the box's own frame, centred: along it, across it, up
        var dx = p[t + i * 3] - b.gx, dy = p[t + i * 3 + 1] - b.gy;
        v[i * 3] = dx * ca + dy * sa;
        v[i * 3 + 1] = -dx * sa + dy * ca;
        v[i * 3 + 2] = p[t + i * 3 + 2] - b.gz;
      }
      if (triBoxOverlap(b.rx, b.ry, b.h, v)) return true;
    }
    return false;
  }

  /**
   * Triangle v (9 numbers, box-centred) against the box of half-extents hx, hy,
   * hz: the separating-axis test (Akenine-Moller) - the box's three axes, the
   * triangle's normal, and each edge crossed with each box axis.
   */
  function triBoxOverlap(hx, hy, hz, v) {
    function apart(ax, ay, az) {
      var p0 = ax * v[0] + ay * v[1] + az * v[2];
      var p1 = ax * v[3] + ay * v[4] + az * v[5];
      var p2 = ax * v[6] + ay * v[7] + az * v[8];
      var r = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
      return Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r;
    }
    if (apart(1, 0, 0) || apart(0, 1, 0) || apart(0, 0, 1)) return false;
    var e = [[v[3] - v[0], v[4] - v[1], v[5] - v[2]],
             [v[6] - v[3], v[7] - v[4], v[8] - v[5]],
             [v[0] - v[6], v[1] - v[7], v[2] - v[8]]];
    if (apart(e[0][1] * e[1][2] - e[0][2] * e[1][1], e[0][2] * e[1][0] - e[0][0] * e[1][2],
              e[0][0] * e[1][1] - e[0][1] * e[1][0])) return false;
    for (var i = 0; i < 3; i++) {
      var x = e[i][0], y = e[i][1], z = e[i][2];
      if (apart(0, -z, y) || apart(z, 0, -x) || apart(-y, x, 0)) return false;
    }
    return true;
  }

  function computeSelectionInfo() {
    if (!doc) { currentSelection = []; return; }
    if (selectionSource === 'box') {
      if (!balls.length) {
        setSelection([], 'box');
        info('No boxes placed yet.');
        return;
      }
      setSelection(selectByBox(), 'box');
      return;
    }
    describeSelection();
    syncExportRow();
  }

  function describeSelection() {
    if (!currentSelection.length) {
      info(selectionSource === 'layer' ? 'That layer holds nothing.'
         : selectionSource === 'line' ? 'No line picked.'
         : selectionSource === 'visible' ? 'Nothing is shown to take.'
         : '<b>' + balls.length + ' box(es)</b>, nothing caught.');
      return;
    }
    if (doc.kind === 'toolpath' && selectionSource === 'line' && currentSelection.length === 1) {
      info(describeLine(currentSelection[0]));
      return;
    }
    if (doc.kind === 'toolpath') {
      var layers = {};
      currentSelection.forEach(function (s) { layers[s.layer] = 1; });
      var keys = Object.keys(layers).map(Number).sort(function (a, b) { return a - b; });
      info((selectionSource === 'layer' ? '<b>whole layer</b>, '
          : selectionSource === 'line' ? '<b>picked lines</b>, '
          : selectionSource === 'visible' ? '<b>everything shown</b>, '
          : selectionSource === 'range' ? '<b>the slider\'s range</b>, '
          : selectionSource === 'feature' ? '<b>one line type</b>, '
          : selectionSource === 'pick' ? '<b>a piece</b>, '
          : '<b>' + balls.length + ' box(es)</b>, ') +
           '<b>' + currentSelection.length + ' segment(s)</b> total<br>' +
           'across ' + keys.length + ' layer(s): ' + keys.join(', '));
      return;
    }
    var tris = currentSelection.reduce(function (a, o) { return a + o.triangles; }, 0);
    info((selectionSource === 'visible' || selectionSource === 'range' ? '<b>everything shown</b>, '
          : selectionSource === 'pick' ? '<b>picked</b>, '
          : '<b>' + balls.length + ' box(es)</b>, ') + '<b>' + currentSelection.length +
         ' object(s)</b>, ' + tris + ' triangle(s)<br>' +
         currentSelection.map(function (o) { return o.name; }).join(', '));
  }

  function applyFeatureVisibility() {
    var v = view;
    // Per mesh, not only per group: the pick and box raycasts filter on each
    // mesh's own `visible`, and three.js raycasts a mesh in a hidden group.
    var detail = showingDetail();
    Object.keys(v.overviewMeshes).forEach(function (name) {
      var m = v.overviewMeshes[name];
      m.visible = !rowOff(name) && !detail && !m.userData.empty;
    });
    Object.keys(v.solidMeshes || {}).forEach(function (name) {
      v.solidMeshes[name].visible = !rowOff(name) && !detail;
    });
    v.detailGroup.children.forEach(function (mesh) {
      mesh.visible = !rowOff(mesh.userData.feature);
    });
  }

  /** Is this overview row switched off: a line type (slice) or a piece cleared from view (mesh)? */
  function rowOff(name) {
    return doc && doc.kind === 'toolpath' ? FEATURE_OFF.has(name) : HIDDEN.has(name);
  }

  // ===========================================================================
  // The Features list
  // ===========================================================================
  //
  // ONE list, the slicer's own line types - Outer wall, Inner wall, Sparse
  // infill, Support ... - the way Bambu Studio's preview lists them: a colour
  // swatch, the name, a count, and a checkbox. CHECKBOXES ONLY (docs/GSCOPE.md,
  // item 4): what is shown is the union of the checked rows - all checked, the
  // whole piece; none, nothing - and a re-checked row is drawn again. The row's
  // text is its box's label (a click on it toggles the box, nothing else);
  // hovering a row does nothing. What is shown is what Select, a drag and
  // Export act on (actedOn). One set for both plates (FEATURE_OFF). A part
  // that is not sliced has no line types and the list says so.

  var FEATURE_ORDER = ['Outer wall', 'Inner wall', 'Overhang wall', 'Sparse infill', 'Internal solid infill',
    'Top surface', 'Bottom surface', 'Bridge', 'Gap infill', 'Support', 'Support interface', 'Support transition', 'Floating vertical shell',
    'Custom', 'Travel'];

  /** [{ name, count }] - the line types of the document shown, in Bambu's order. */
  function featureCounts() {
    if (!doc) return [];
    var counts = {};
    if (doc.kind === 'toolpath') {
      doc.segments.forEach(function (sg) { counts[sg.feature] = (counts[sg.feature] || 0) + 1; });
    } else if (hasBeads(doc)) {
      doc.objects.forEach(function (o) {
        (o.moves || []).forEach(function (m) { counts[m.feature] = (counts[m.feature] || 0) + 1; });
      });
    }
    var rank = function (n) { var i = FEATURE_ORDER.indexOf(n); return i < 0 ? 1000 : i; };
    return Object.keys(counts).sort(function (a, b) { return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0); })
      .map(function (n) { return { name: n, count: counts[n] }; });
  }

  /** Does the active plate have line types - Features rows to check? */
  function hasLineTypes() {
    return !!doc && (doc.kind === 'toolpath' || hasBeads(doc));
  }

  function buildLegend() {
    var legend = $('ms-legend');
    if (!legend) return;
    legend.innerHTML = '';
    if (!doc) return;
    var rows = featureCounts();
    if (!rows.length) {
      var note = document.createElement('div');
      note.className = 'ms-legend-note';
      note.textContent = isPieces(doc) ? 'No line types on ' + plateTitle(plateName) + ' - these pieces are not slices.'
        : 'Not sliced - no line types.';
      legend.appendChild(note);
      return;
    }
    rows.forEach(function (r, gi) {
      var name = r.name, off = FEATURE_OFF.has(name);
      var item = document.createElement('div');
      item.className = 'ms-legend-item' + (off ? ' dim' : '');
      item.dataset.group = name;
      item.setAttribute('role', 'listitem');
      var swatch = document.createElement('div');
      swatch.className = 'ms-swatch';
      swatch.style.background = '#' + ('000000' + featureColor(name, gi).toString(16)).slice(-6);
      var label = document.createElement('label');
      label.className = 'ms-legend-label';
      label.textContent = name + ' (' + r.count + ')';
      var disp = document.createElement('input');
      disp.type = 'checkbox';
      disp.className = 'ms-legend-display';
      disp.id = 'ms-legend-cb-' + gi;
      disp.checked = !off;
      disp.title = 'Show ' + name + ' - checked, it is drawn, and Select, drag and Export take it; unchecked, it is not';
      disp.setAttribute('aria-label', 'Show ' + name);
      disp.addEventListener('change', function () { setFeatureDisplay(name, disp.checked); });
      // The row text is the box's label: a click on it toggles the box, and nothing else.
      label.htmlFor = disp.id;
      item.appendChild(swatch); item.appendChild(label); item.appendChild(disp);
      legend.appendChild(item);
    });
  }

  function featureColor(name, i) {
    var G = window.NSOGcodeLines;
    return G && G.colorForFeature ? G.colorForFeature(name) : OBJECT_COLORS[i % OBJECT_COLORS.length];
  }

  /** The Display check of one line type: shown or hidden, on both plates. */
  function setFeatureDisplay(name, on) {
    if (!doc) return;
    if (on === undefined) on = FEATURE_OFF.has(name);
    if (on) FEATURE_OFF.delete(name); else FEATURE_OFF.add(name);
    viewChanged();
    rescopeSelection();
    syncExportRow();
  }

  // --- viewport interaction -------------------------------------------------

  // ===========================================================================
  // Selecting: a click in the view, and the card's REGION row
  // ===========================================================================
  //
  // The view's own gesture is the piece (it was SELECT > Piece): hover outlines
  // it, a click isolates it (what is not it goes out of the view; click it
  // again, or press Escape, and it is whole again), a drag copies it onto the
  // other plate (a piece dragged onto a plate is moved). A press on bare plate -
  // nothing to take - orbits. The card's REGION row arms the capture box
  // (mode 'select', its button #ms-mode-select): a click places a box and does
  // nothing else (item 7). The other ways in that SELECT had went to their new
  // homes (docs/GSCOPE.md item 12): a line type is the Features list, a layer
  // is the slider and Take band, a single move is read out on hover.

  var MODES = ['piece', 'select'];   // 'select' is Region (its id, ms-mode-select, is older than its name)
  var MODE_ALIAS = { orbit: 'piece', region: 'select' };

  /** REGION needs something to box. */
  function modeAvailable(m) {
    return m === 'piece' || !!doc;
  }

  function setMode(newMode) {
    newMode = MODE_ALIAS[newMode] || newMode;
    if (MODES.indexOf(newMode) < 0 || !modeAvailable(newMode)) newMode = 'piece';
    mode = newMode;
    var b = $('ms-mode-select');
    if (b) {
      b.classList.toggle('active', mode === 'select');
      b.setAttribute('aria-pressed', String(mode === 'select'));
      setDisabled(b, !modeAvailable('select'));
    }
    var note = $('ms-region-note');
    if (note) note.hidden = mode !== 'select';
    var hint = $('ms-hint-badge');
    if (hint) hint.textContent = '';
    clearHover();
  }

  /** Escape with REGION armed and nothing else to undo: disarmed. True if it was armed. */
  function disarmRegion() {
    if (mode !== 'select') return false;
    setMode('piece');
    return true;
  }

  function ndc(e) {
    var rect = view.renderer.domElement.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    ];
  }

  /* WHEEL ZOOM TOWARD THE CURSOR - the main viewport's (#154), on G-scope's
     own OrbitControls. three 0.147 has no zoomToCursor, so the wheel is taken
     before OrbitControls' own handler sees it: a capture listener on the host
     (the canvas's parent), for wheels over the canvas only, that stops the
     event there. OrbitControls' zoom stays ON, because its middle-drag and
     two-finger dolly hang off the same enableZoom - those still dolly about
     the target, as before.

     Each step scales the camera AND the target about the point under the
     cursor (app-core.js's dollyAbout, shared with the main viewport), so that
     point keeps its pixel exactly; the view direction never changes. The step
     is OrbitControls' own (0.95 per wheel event, either sign of deltaY), and
     its own limits apply - minDistance / maxDistance on the camera-to-target
     distance, 0 and Infinity here, so still no floor and no ceiling.

     The point is the first DRAWN thing of the document under the cursor (its
     lines, solid, detected features, the isolated detail or the highlight):
     a visible object with a visible material, at a point its clipping planes
     keep. A line counts within the same zoom-tracking reach a line pick uses.
     Failing that, the bed's plane (y = 0) where the bed grid is drawn; failing
     both, the target - which is the zoom this replaced. */
  function drawnAt(hit) {
    var o = hit.object;
    if (!(o.isMesh || o.isLine) || !nsoVisibleInScene(o)) return false;
    var mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!mats.some(function (m) { return m && m.visible; })) return false;
    var m = mats[0] || {};
    var planes = (m.clippingPlanes || []).concat(view.renderer.clippingPlanes || []);
    return planes.every(function (pl) { return pl.distanceToPoint(hit.point) >= -1e-6; });
  }

  function wheelAnchor(clientX, clientY) {
    var v = view, rect = v.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var rc = v.wheelRaycaster;
    rc.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1,
                                       -((clientY - rect.top) / rect.height) * 2 + 1), v.camera);
    rc.near = v.camera.near;
    rc.far = v.camera.far;
    rc.params.Line.threshold = Math.max(0.05, v.camera.position.distanceTo(v.controls.target) * 0.006);
    // both plates: what is drawn on either, then either floor
    var hits = rc.intersectObjects([v.overviewGroup, v.detailGroup, v.highlightGroup].concat(plateGroups(otherPlate())), true);
    for (var i = 0; i < hits.length; i++) {
      // ray.at(distance), not hit.point: on the ray itself, so the pixel holds
      if (drawnAt(hits[i])) return rc.ray.at(hits[i].distance, new THREE.Vector3());
    }
    var g = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (g && v.grid && nsoVisibleInScene(v.grid) && g.distanceTo(rc.ray.origin) <= v.camera.far && Math.abs(g.z) <= plateSide / 2 &&
        ['lens', 'take'].some(function (n) { return Math.abs(g.x - plateOffset(n)) <= plateSide / 2; })) return g;
    return null;
  }

  function onWheel(e) {
    var v = view, c = v.controls;
    if (e.target !== v.renderer.domElement) return;
    // What OrbitControls' own handler would ignore, it is left to ignore: the
    // controls off (a box handle drag) or a button held (an orbit, pan or
    // middle-drag dolly in progress).
    if (!c.enabled || !c.enableZoom || e.buttons) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.deltaY) return;
    var step = Math.pow(0.95, c.zoomSpeed);
    var anchor = wheelAnchor(e.clientX, e.clientY) || c.target.clone();
    c.dispatchEvent({ type: 'start' });
    dollyAbout(v.camera, c, anchor, e.deltaY < 0 ? step : 1 / step, c.minDistance, c.maxDistance);
    c.dispatchEvent({ type: 'end' });
  }

  function wireViewport() {
    var v = view;
    var el = v.renderer.domElement;

    v.host.addEventListener('wheel', onWheel, { capture: true, passive: false });

    el.addEventListener('pointerdown', function (e) {
      v.mouseDownPos = [e.clientX, e.clientY];
      v.hookTook = false;
      // The box handles are left-button grabs; a right press is the pan.
      if (e.button !== 0 || !balls.length) return;
      var p = ndc(e);
      v.dragRaycaster.setFromCamera(new THREE.Vector2(p[0], p[1]), v.camera);

      // A dot, in any mode, whatever stands in front of it (item 8), picked on
      // screen as it is drawn (dotAt): the centre (move) > the top (thickness) >
      // the corner (X and Y). Then, REGION armed, the box's face.
      var dot = dotAt(e);
      if (dot && dot.type === 'move') {
        var i1 = dot.ballIndex;
        v.dragState = { type: 'move', ballIndex: i1 };
        v.controls.enabled = false;
        var d1 = new THREE.Vector3();
        v.camera.getWorldDirection(d1);
        v.resizePlane.setFromNormalAndCoplanarPoint(d1, balls[i1].point);
        return;
      }
      if (dot && dot.type === 'resizeH') {
        v.dragState = { type: 'resizeH', ballIndex: dot.ballIndex };
        v.controls.enabled = false;
        return;
      }
      // The corner dot: drag it across a horizontal plane at the corner's own
      // height, and the footprint's X and Y half-extents follow the pointer
      // independently. The box stays centred, as every other resize keeps it.
      if (dot && dot.type === 'resizeXY') {
        var i2 = dot.ballIndex;
        v.dragState = { type: 'resizeXY', ballIndex: i2 };
        v.controls.enabled = false;
        v.resizePlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), cornerPoint(balls[i2]));
        return;
      }
      if (mode !== 'select') return;
      // Not recursive: the box's edge lines are a child of boxMesh, and at the
      // raycaster's 1 mm Line threshold a press near any edge hit THEM first -
      // no box owns that object, so the drag indexed balls[-1] and threw.
      // (The reference tool has the same fault.)
      var surfaceHits = v.dragRaycaster.intersectObjects(balls.map(function (b) { return b.boxMesh; }), false);
      if (surfaceHits.length > 0) {
        var i3 = balls.findIndex(function (b) { return b.boxMesh === surfaceHits[0].object; });
        // The footprint's proportion, fixed for the drag (see resizeR below).
        var m3 = Math.max(balls[i3].rx, balls[i3].ry);
        // Not live until it travels past the slop: a press inside the box that is
        // let go in place is a click (it isolates - item 7), and a hand's jitter
        // on the way must not resize the box first.
        v.dragState = { type: 'resizeR', ballIndex: i3, fx: balls[i3].rx / m3, fy: balls[i3].ry / m3,
                        r0: m3, x0: e.clientX, y0: e.clientY, d0: 0 };
        v.controls.enabled = false;
        var d3 = new THREE.Vector3();
        v.camera.getWorldDirection(d3);
        v.resizePlane.setFromNormalAndCoplanarPoint(d3, balls[i3].point);
        return;
      }
      v.dragState = null;
    });

    window.addEventListener('pointermove', function (e) {
      if (!v.dragState || !isOpen()) return;
      var ball = balls[v.dragState.ballIndex];
      if (!ball) return;
      var p = ndc(e);
      v.dragRaycaster.setFromCamera(new THREE.Vector2(p[0], p[1]), v.camera);

      if (v.dragState.type === 'resizeH') {
        // vertical-only drag: a plane whose normal is the camera direction
        // flattened onto the horizontal
        var toCam = v.camera.position.clone().sub(ball.point); toCam.y = 0; toCam.normalize();
        var vertPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(toCam, ball.point);
        var hp = new THREE.Vector3();
        if (!v.dragRaycaster.ray.intersectPlane(vertPlane, hp)) return;
        ball.h = Math.max(0.1, Math.min(15, Math.abs(hp.y - ball.point.y)));
        defaultH = ball.h;
        updateBoxTransform(ball);
        selectionSource = 'box';
        computeSelectionInfo();
        return;
      }

      var hit = new THREE.Vector3();
      if (!v.dragRaycaster.ray.intersectPlane(v.resizePlane, hit)) return;

      if (v.dragState.type === 'move') {
        ball.point.copy(hit);
        updateBoxTransform(ball);
        var cd = new THREE.Vector3();
        v.camera.getWorldDirection(cd);
        v.resizePlane.setFromNormalAndCoplanarPoint(cd, hit);
      } else if (v.dragState.type === 'resizeXY') {
        // corner resize, in the box's own frame: along it and across it
        var ax = boxAxes(ball), off = hit.clone().sub(ball.point);
        ball.rx = Math.max(0.3, Math.min(60, Math.abs(off.dot(ax.u))));
        ball.ry = Math.max(0.3, Math.min(60, Math.abs(off.dot(ax.w))));
        defaultRx = ball.rx; defaultRy = ball.ry;
        updateBoxTransform(ball);
      } else if (v.dragState.type === 'resizeR') {
        // footprint resize: horizontal distance only, and only once the press
        // has travelled past the slop (before that it is a click inside the
        // box). The footprint then scales with the pointer's distance from the
        // centre, from where the drag began - no jump to the press point. With
        // a rectangle the LARGER side follows and the other keeps the
        // proportion it had when the drag began, so a square stays a square and
        // a corner-drawn rectangle keeps its shape.
        var ds = v.dragState, rd = Math.hypot(hit.x - ball.point.x, hit.z - ball.point.z);
        if (!ds.d0) {
          if (Math.hypot(e.clientX - ds.x0, e.clientY - ds.y0) < pullSlop()) return;
          ds.d0 = Math.max(rd, 1e-3);
        }
        var flat = Math.max(0.3, Math.min(60, ds.r0 * rd / ds.d0));
        ball.rx = Math.max(0.3, flat * v.dragState.fx);
        ball.ry = Math.max(0.3, flat * v.dragState.fy);
        defaultR = Math.max(ball.rx, ball.ry);
        defaultRx = ball.rx; defaultRy = ball.ry;
        updateBoxTransform(ball);
      }
      selectionSource = 'box';
      computeSelectionInfo();
    });

    window.addEventListener('pointerup', function () {
      if (v.dragState) { v.dragState = null; v.controls.enabled = true; }
    });

    // No double-click here. G-scope has two exits, Back and Close, and a
    // double-click on the view is not one of them: it does nothing.

    // Pulling onto plate 2, and moving what is on it. The press is taken in the
    // capture phase, before OrbitControls sees it, only when it lands on the
    // selection (plate 1) or on a piece (plate 2); anywhere else the orbit has it.
    el.addEventListener('pointerdown', onPressCapture, true);
    window.addEventListener('pointermove', onPullMove);
    window.addEventListener('pointerup', onPullUp);
    window.addEventListener('pointercancel', onPullUp);
    window.addEventListener('keydown', onPullKey, true);

    el.addEventListener('pointerup', function (e) {
      if (!doc || v.dragState || !v.mouseDownPos) return;
      if (Math.hypot(e.clientX - v.mouseDownPos[0], e.clientY - v.mouseDownPos[1]) > 4) return;
      // A click hook (app-gscope-support.js's markers and supports) gets the
      // click first, in every mode: a marker is a thing you click, not a
      // region you box. A hook that takes the click returns true.
      var h = ndc(e);
      for (var hk = 0; hk < clickHooks.length; hk++) {
        try { if (clickHooks[hk](h[0], h[1], e)) { v.hookTook = true; return; } }
        catch (err) { console.error('[g-scope] click hook', err); }
      }
    });

    // Hover: an outline of what a click would take.
    window.addEventListener('pointermove', onHoverMove);
    el.addEventListener('pointerleave', function () { hoverPending = null; clearHover(); });
  }

  // --- Isolate / Back -------------------------------------------------------

  /** Isolated: the selection alone is what is drawn. */
  function showingDetail() { return isolated; }

  /**
   * The selection's own moves / objects, drawn AS-IS - the same way the
   * overview draws them - into the detail group. Toolpath view: each move as
   * its line, in its feature's colour, exactly the overview's lines with
   * everything else taken away. Solid view: the selection's own solid (what
   * Export as solid writes). Mesh: the objects' own triangles.
   */
  function buildDetail() {
    var v = view;
    clearGroup(v.detailGroup);
    if (!doc || !currentSelection.length) return;
    if (doc.kind === 'toolpath') {
      var keys = Object.keys(doc.groups || {});
      var colourOf = function (f) { return colorForGroup(f, Math.max(0, keys.indexOf(f))); };
      var segs = currentSelection.filter(function (s) { return !CLEARED.has(s.id) && inZRange(s); });
      if (renderMode === 'solid') {
        // A run the selection cuts is capped where the selection ends.
        var sd = solidMeshes(segs, colourOf);
        Object.keys(sd.meshes).forEach(function (k) { v.detailGroup.add(sd.meshes[k]); });
        return;
      }
      var byFeature = {};
      segs.forEach(function (s) { (byFeature[s.feature] = byFeature[s.feature] || []).push(s); });
      Object.keys(byFeature).forEach(function (feature) {
        var mesh = lineMesh(byFeature[feature], colourOf(feature), feature === 'Travel');
        mesh.userData.feature = feature;
        v.detailGroup.add(mesh);
      });
      return;
    }
    var okeys = Object.keys(doc.groups || {});
    currentSelection.forEach(function (o) {
      var geo = soupGeometry(viewPositions(o.positions));
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: colorForGroup(o.name, Math.max(0, okeys.indexOf(o.name))),
        metalness: 0.05, roughness: 0.4,
        clippingPlanes: clipPlanes()
      }));
      mesh.userData.feature = o.name;
      v.detailGroup.add(mesh);
    });
  }

  /**
   * Moves as line-segment positions in view space: toThree(x - cx, y - cy, z)
   * for each end, written straight into the array (a hover, a highlight or an
   * isolation of a whole slice is hundreds of thousands of them; a Vector3 per
   * end was a tenth of a second).
   */
  function segPositions(segs) {
    var out = new Float32Array(segs.length * 6), cx = doc.cx, cy = doc.cy;
    for (var i = 0, w = 0; i < segs.length; i++, w += 6) {
      var s = segs[i];
      out[w] = s.x0 - cx; out[w + 1] = s.z; out[w + 2] = -(s.y0 - cy);
      out[w + 3] = s.x1 - cx; out[w + 4] = s.z; out[w + 5] = -(s.y1 - cy);
    }
    return out;
  }

  /** Moves as line segments, the overview's own way of drawing them. */
  function lineMesh(segs, color, faint) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(segPositions(segs), 3));
    var mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: color, transparent: !!faint, opacity: faint ? 0.35 : 1.0
    }));
    mesh.userData.segs = segs;
    return indexLines(mesh);
  }

  /**
   * What is drawn, from the isolation:
   *   not isolated   the whole view, the selection highlighted
   *   isolated       the selection alone, as-is (detail group)
   */
  function applyDisplay() {
    var v = view;
    if (!v) return;
    var detail = showingDetail();
    v.detailGroup.visible = detail;
    v.overviewGroup.visible = !detail;
    v.highlightGroup.visible = !detail;
    var unit = doc && doc.kind === 'toolpath' ? 'segments' : 'object(s)';
    badge(detail ? 'Detail: ' + currentSelection.length + ' ' + unit : plateBadge());
    syncCardRows();
    applyFeatureVisibility();
  }

  /** The card's REGION and WHOLE PART buttons: what each can do now. */
  function syncCardRows() {
    setDisabled($('ms-btn-isolate'), isolated || !balls.length);
    setDisabled($('ms-btn-clear'), !balls.length);
    setDisabled($('ms-btn-back'), !isolated);
  }

  /**
   * A control switched off. One that had the keyboard hands it to the panel: a
   * disabled button drops its focus to the page, and Escape - the panel's -
   * would then reach nothing (Isolate pressed, then Escape, did nothing; the
   * last box Escaped away with EXPORT focused, and its rows emptied, did the
   * same). Every control G-scope switches off goes through here.
   */
  function setDisabled(el, off) {
    if (!el || el.disabled === !!off) return;
    var panel = $('microscope');
    if (off && document.activeElement === el && panel && panel.focus) panel.focus();
    el.disabled = !!off;
  }

  function isolate(opts) {
    if (!currentSelection.length) return false;
    isolated = true;
    buildDetail();
    // Isolate shows the selection alone, turned to it (fitView: the same
    // viewing angle, the selection filling the frame). A redraw under a
    // filter or a changed selection passes keepCamera and moves nothing.
    if (!(opts && opts.keepCamera)) fitView(selectionBox());
    applyDisplay();
    return true;
  }

  function back() {
    isolated = false;
    clearGroup(view.detailGroup);
    normalView();                 // the whole part again; Back is the way out
    applyDisplay();
  }

  // `loop` is a generation counter, not a boolean. Closing sets `running`
  // false, but a frame already scheduled fires AFTER that - and if the panel
  // is reopened before it does, a plain boolean would let it reschedule
  // alongside the new loop and leave two running. Each loop carries the
  // generation it was started at and stops as soon as that is not the current
  // one, so a reopen can never end up with two.
  var loop = 0;

  function animate(gen) {
    if (!view || !view.running || gen !== loop) return;
    requestAnimationFrame(function () { animate(gen); });
    view.controls.update();
    followClip();
    // The corner dot follows the camera round to the near corner, and every
    // dot keeps its least size on screen.
    balls.forEach(function (b) { b.cornerHandle.position.copy(cornerPoint(b)); dotsOnScreen(b); });
    view.renderer.render(view.scene, view.camera);
  }

  function resize() {
    if (!view || !isOpen()) return;
    var w = view.host.clientWidth, h = view.host.clientHeight;
    if (!w || !h) return;
    view.camera.aspect = w / h;
    view.camera.updateProjectionMatrix();
    view.renderer.setSize(w, h);
  }

  // ===========================================================================
  // ===========================================================================
  //
  //   END REFERENCE TOOL, LIFTED
  //
  // ===========================================================================
  // ===========================================================================

  // ===========================================================================
  // Full-layer selection - the second mode
  // ===========================================================================
  //
  // Not the reference tool's; it has no such thing. This is NSO's own, and it
  // is not reimplemented here either: `NSOGcodeLines.movesAtZ()` is the same
  // call the Toolpath card's "This whole layer at one Z (all features)" scope
  // makes. Keyed on Z and not on the layer index, for the reason
  // docs/GCODE-TOOLPATH-IMPORT.md records - a bead hangs DOWN from the nozzle
  // Z, so testing a bead's span would pull every layer into its neighbour's.

  function layerCount() {
    return (doc && doc.kind === 'toolpath' && doc.parsed) ? doc.parsed.layers.length : 0;
  }

  /** Select every move at layer `li`'s printing height, whatever printed it. */
  function selectLayer(li) {
    if (!doc || doc.kind !== 'toolpath') {
      say('This file has no layers - a plain STL or 3MF is not sliced', true);
      return [];
    }
    var G = window.NSOGcodeLines;
    var n = layerCount();
    if (!(li >= 0 && li < n)) { say('Layer ' + li + ' is not in this file', true); return []; }
    var win = G.layerZWindow(doc.parsed, li);
    var wanted = G.movesInZWindow(doc.parsed.moves, win);
    var keep = {};
    wanted.forEach(function (m) { keep[m.index] = 1; });
    doc.layerIndex = li;
    setSelection(doc.segments.filter(function (s) { return keep[s.mv.index] === 1; }), 'layer');
    return currentSelection;
  }

  // ===========================================================================
  // G-scope: the selection seam, the view filters, line picking and the layer
  // range
  // ===========================================================================
  //
  // THE SELECTION IS ONE THING. Whatever produced it - a capture box, a whole
  // layer, a picked line, "everything shown" - it is an array of segments
  // (toolpath) or of objects (mesh), and it reaches the rest of the view
  // through setSelection() and nowhere else. Isolate, the highlight, both
  // exports and a pull read `currentSelection`; none of them knows or asks which
  // control made it. docs/GCODE-MICROSCOPE.md, "The selection seam", is where
  // a future support-generation step plugs in.

  function setSelection(items, source) {
    currentSelection = items || [];
    selectionSource = source || selectionSource;
    if (selectionSource !== 'line') lineCursor = -1;
    if (doc) describeSelection();
    syncExportRow();
    refreshHighlightSoon();
    // Isolated, the view IS the selection: a box dragged, a line stepped,
    // redraws it. One rebuild per frame, however many steps a drag makes.
    if (isolated) isolateRedrawSoon();
    if (!selectionListeners.length) return;
    var region = selectionRegion();
    selectionListeners.forEach(function (fn) {
      try { fn(region); } catch (err) { console.error('[g-scope] selection listener', err); }
    });
  }

  /**
   * The current selection as a plain description, in the file's own Z-up
   * millimetres: what a consumer of the selection reads. Moves carry the
   * parsed move records (x0 y0 x1 y1 z width height feature layer index), so
   * nothing downstream has to know about the view's segment wrappers.
   */
  function selectionRegion() {
    if (!doc || !currentSelection.length) return null;
    var lo = Infinity, hi = -Infinity;
    var out = {
      kind: doc.kind,
      source: doc.source || 'file',
      document: doc.name,
      by: selectionSource,
      boxes: gcodeBoxes(),
      zBand: null
    };
    if (doc.kind === 'toolpath') {
      out.moves = currentSelection.map(function (s) {
        if (s.z - s.mv.height < lo) lo = s.z - s.mv.height;
        if (s.z > hi) hi = s.z;
        return s.mv;
      });
    } else {
      out.objects = currentSelection.map(function (o) {
        if (o.bounds.minZ < lo) lo = o.bounds.minZ;
        if (o.bounds.maxZ > hi) hi = o.bounds.maxZ;
        return { name: o.name, positions: o.positions, placedIndex: o.placedIndex, sourceId: o.sourceId,
                 detected: o.detected || null };
      });
    }
    out.zExtent = [lo, hi];
    out.zBand = zBandMm();
    return out;
  }

  // --- view filters -----------------------------------------------------------

  function inZRange(s) { return !zr || (s.zi >= zr.lo && s.zi <= zr.hi); }

  function segShown(s) {
    return !FEATURE_OFF.has(s.feature) && !CLEARED.has(s.id) && inZRange(s);
  }

  function objectShown(o) {
    if (HIDDEN.has(o.name)) return false;
    // a plate 2 piece whose every line type is switched off is not drawn
    if (o.moves && o.moves.length && o.moves.every(function (m) { return FEATURE_OFF.has(m.feature); })) return false;
    var band = zBandMm();
    if (!band || zRangeFull()) return true;
    return o.bounds.maxZ >= band[0] - 1e-6 && o.bounds.minZ <= band[1] + 1e-6;
  }

  /** Every object drawn right now, as the selection takes them. */
  function shownObjects() {
    if (!doc || doc.kind !== 'mesh') return [];
    return doc.objects.filter(objectShown);
  }

  /** Every segment drawn right now, in print order. */
  function shownSegments() {
    if (!doc || doc.kind !== 'toolpath') return [];
    return doc.segments.filter(segShown);
  }

  /**
   * shownSegments() for the hover, which asks on every move: kept until what
   * is drawn changes (the document, the Features list, what is cleared from
   * view, the slider), with each piece's share kept as it is first asked for.
   * Read only - a caller hands on a copy.
   */
  var shownKept = null;
  function shownMemo() {
    var key = [featureSig(), CLEARED.size, zr ? zr.lo + ':' + zr.hi : ''].join('/');
    if (!shownKept || shownKept.doc !== doc || shownKept.segs !== doc.segments || shownKept.cleared !== CLEARED || shownKept.key !== key) {
      shownKept = { doc: doc, segs: doc.segments, cleared: CLEARED, key: key, list: shownSegments(), byObj: new Map() };
    }
    return shownKept;
  }

  function clipPlanes() { return view ? view.clip : []; }

  /** Set the two clipping planes from the slider. Mesh documents only. */
  function applyClip() {
    if (!view) return;
    var lo = -1e9, hi = 1e9;
    if (doc && doc.kind === 'mesh' && zr && !zRangeFull()) {
      var band = zBandMm();
      lo = band[0] - 1e-4; hi = band[1] + 1e-4;
    }
    view.clip[0].constant = -lo;     // keep y >= lo  (three Y is the file's Z)
    view.clip[1].constant = hi;      // keep y <= hi
  }

  /** The legend, a clear or the slider changed what is shown: redraw it. */
  var viewPending = false;
  function viewChanged() {
    if (!view || !doc) return;
    buildLegend();
    if (doc.kind === 'toolpath') {
      buildOverview();
      if (isolated) isolateRedraw();
    } else {
      applyClip();
      if (hasBeads(doc) && view.takeSig !== featureSig()) { buildOverview(); buildDetail_(); }
    }
    applyFeatureVisibility();
    refreshHighlight();
    syncZRangeUI();
    syncTakeBand();
    syncRenderRow();
  }
  /** Coalesce a burst of slider moves into one redraw per frame. */
  function viewChangedSoon() {
    if (viewPending) return;
    viewPending = true;
    var run = function () { viewPending = false; viewChanged(); };
    if (typeof requestAnimationFrame === 'function' && isOpen()) requestAnimationFrame(run); else run();
  }

  /**
   * Redraw the isolated selection in place after a filter or the selection
   * itself changed under it. Not a re-zoom: the camera and its mode stay.
   */
  function isolateRedraw() {
    if (!isolated) return;
    buildDetail();
    applyDisplay();
  }
  var isolatePending = false;
  function isolateRedrawSoon() {
    if (isolatePending) return;
    isolatePending = true;
    var run = function () { isolatePending = false; isolateRedraw(); };
    if (typeof requestAnimationFrame === 'function' && isOpen()) requestAnimationFrame(run); else run();
  }

  /**
   * One legend group alone: the "only" button. It both solos the view (every
   * other group hidden, and on a mesh every detector row off) and becomes the
   * selection - Export is offered right after, same as a picked line or a
   * capture box, with no separate "Select shown" required. Nothing is
   * isolated: the list stays up, and any row brings the rest back.
   * `selectVisible()` is what "Select shown" itself calls, so a plain click
   * here and a follow-up press of that button read the identical set - one
   * definition of "what is shown", not two.
   */
  function soloGroup(name) { return soloGroups([name]); }

  /** soloGroup() for several groups at once: these shown, every other one hidden, selected. */
  function soloGroups(names) {
    if (!doc) return false;
    var want = (names || []).filter(function (n) { return !!doc.groups[n]; });
    if (!want.length) return false;
    if (isolated) back();               // a new view filter: what was isolated is whole first
    if (doc.kind === 'toolpath') FEATURE_OFF = new Set(Object.keys(doc.groups).filter(function (g) { return want.indexOf(g) < 0; }));
    else HIDDEN = new Set(Object.keys(doc.groups).filter(function (g) { return want.indexOf(g) < 0; }));
    viewChanged();
    selectVisible();
    return true;
  }

  /**
   * A row was switched on or off: a mesh selection follows what is shown. A
   * box selection is taken again (a box catches only what is drawn), "Select
   * shown" stays everything shown, and anything else loses what was switched
   * off. So Export and Isolate always act on the parts and features the
   * list has on, never on one switched off after it was selected. A slice's
   * selection is left as it was, as it always has been.
   */
  function rescopeSelection() {
    if (!doc || doc.kind !== 'mesh') return;
    if (selectionSource === 'box') { if (balls.length) setSelection(selectByBox(), 'box'); return; }
    if (selectionSource === 'visible') { setSelection(shownObjects(), 'visible'); return; }
    var keep = shownObjects();
    var next = currentSelection.filter(function (o) { return keep.indexOf(o) >= 0; });
    if (next.length !== currentSelection.length) setSelection(next, selectionSource);
  }

  // ===========================================================================
  // Surface features (flange, handle, bracket, lid, hinge) are not G-scope's:
  // they live on the plate now (Subtract > Lift). G-scope's one list is the
  // slicer's line types - see "The Features list".
  // ===========================================================================

  /**
   * Clear the selection FROM VIEW. Hides it - a piece, a feature's lines, a
   * picked line - and stops there: no export, no plate change, no undo entry.
   * The card has no button for it (round 2c: its job is the corner CLEAR's);
   * it is the API's, view only, and deliberately not wired to anything that writes.
   */
  function clearFromView() {
    if (!doc || !currentSelection.length) return 0;
    var n = currentSelection.length;
    if (view && isolated) back();
    if (doc.kind === 'toolpath') {
      currentSelection.forEach(function (s) { CLEARED.add(s.id); });
    } else {
      currentSelection.forEach(function (o) { HIDDEN.add(o.name); });
    }
    removeAllBalls();
    setSelection([], selectionSource === 'line' ? 'line' : 'box');
    viewChanged();
    info('<b>' + n + ' ' + (doc.kind === 'toolpath' ? 'line(s)' : 'piece(s)') +
         '</b> cleared from view. Nothing was exported and the plate is unchanged.');
    return n;
  }

  /**
   * Check all (the Features list's head): every box checked - every line type
   * shown, Travel too - and nothing else. What was isolated stays isolated.
   */
  function checkAll() {
    if (!doc) return;
    FEATURE_OFF = new Set();
    viewChanged();
    rescopeSelection();
    syncExportRow();
  }

  /** Everything the filters leave on screen, as the selection. */
  function selectVisible() {
    if (!doc) return [];
    // isolated, what is shown IS the selection
    if (isolated && currentSelection.length) return currentSelection;
    removeAllBalls();
    if (doc.kind === 'toolpath') setSelection(shownSegments(), 'visible');
    else setSelection(shownObjects(), 'visible');
    return currentSelection;
  }

  // --- the selection highlight --------------------------------------------------

  var HIGHLIGHT_COLOR = 0xff3b30;       // the red the old Toolpath scrub used
  // Moves. A picked line or a handful reads best as its solid prism; a box
  // or a layer of hundreds reads as red lines, and costs a fraction as much
  // to rebuild on every step of a drag.
  var HIGHLIGHT_PRISM_CAP = 200;

  /** One highlight rebuild per frame, however many selection steps a drag makes. */
  var highlightPending = false;
  function refreshHighlightSoon() {
    if (highlightPending) return;
    highlightPending = true;
    var run = function () { highlightPending = false; refreshHighlight(); };
    if (typeof requestAnimationFrame === 'function' && isOpen()) requestAnimationFrame(run); else run();
  }

  /** The per-move prisms of `segs`, in view space. extrudeFlatLine, reused. */
  function prismMesh(segs, color) {
    var built = window.NSOGcodeLines.buildLineGeometry(segs.map(function (s) { return s.mv; }));
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
    geo.translate(-doc.cx, -doc.cy, 0);
    geo.rotateX(-Math.PI / 2);            // the same (x,y,z) -> (x,z,-y) as toThree
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: color, metalness: 0.05, roughness: 0.5
    }));
    mesh.userData.moveIds = built.moveIds;
    return mesh;
  }

  /**
   * `segs` swept into closed shells (NSOGcodeSolid.buildSolid), one three.js
   * mesh per feature, in view space. The chains are cached on the document,
   * so a slider step re-sweeps nothing it has swept before.
   */
  // Whole runs repeat (every overview redraw asks for the same ones), but a
  // capture-box drag cuts runs somewhere new on every step, and each cut is a
  // new key. Past this many the cache starts over rather than grow for the
  // session; `tabletop`, 202,877 moves, is 7,339 whole runs.
  var SOLID_CACHE_LIMIT = 40000;

  function solidCache() {
    if (doc.solidCache.size > SOLID_CACHE_LIMIT) doc.solidCache.clear();
    return doc.solidCache;
  }

  function solidMeshes(segs, colorOf) {
    var built = window.NSOGcodeSolid.buildSolid(segs.map(function (s) { return s.mv; }),
                                                { cache: solidCache() });
    var byF = {};
    built.shells.forEach(function (sh) {
      (byF[sh.feature] = byF[sh.feature] || []).push(sh);
    });
    var meshes = {};
    Object.keys(byF).forEach(function (f) {
      var n = 0;
      byF[f].forEach(function (sh) { n += sh.triCount * 9; });
      var pos = new Float32Array(n), at = 0;
      byF[f].forEach(function (sh) {
        pos.set(built.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9), at);
        at += sh.triCount * 9;
      });
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.translate(-doc.cx, -doc.cy, 0);
      geo.rotateX(-Math.PI / 2);          // the same (x,y,z) -> (x,z,-y) as toThree
      geo.computeVertexNormals();
      // The scene's ambient light is 1.0, which drives a light feature colour
      // to white on every face alike and draws a solid as a flat silhouette.
      // Taking the base colour down leaves the directional light room to
      // shade the walls apart from the tops, so the solid reads as one.
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(colorOf(f)).multiplyScalar(0.55), metalness: 0.05, roughness: 0.5
      }));
      mesh.userData.feature = f;
      mesh.userData.solid = true;
      meshes[f] = mesh;
    });
    return { meshes: meshes, built: built };
  }

  // A solid highlight past this many moves falls back to red lines, as the
  // prism highlight does past HIGHLIGHT_PRISM_CAP. Higher, because a sweep is
  // cheaper per move than a prism and its chains are cached.
  var HIGHLIGHT_SOLID_CAP = 20000;

  function refreshHighlight() {
    if (!view) return;
    var g = view.highlightGroup;
    clearGroup(g);
    Object.keys(view.overviewMeshes).forEach(function (k) {
      var m = view.overviewMeshes[k];
      if (m.isMesh && m.material && m.material.emissive) m.material.emissive.setHex(0x000000);
    });
    if (!doc || !currentSelection.length) return;
    if (doc.kind === 'toolpath') {
      var segs = currentSelection.filter(segShown);
      if (!segs.length) return;
      if (renderMode === 'solid' && segs.length <= HIGHLIGHT_SOLID_CAP) {
        var hs = solidMeshes(segs, function () { return HIGHLIGHT_COLOR; });
        Object.keys(hs.meshes).forEach(function (k) {
          hs.meshes[k].material.emissive = new THREE.Color(0x551010);
          // Drawn over the overview's own shell of the same bead, so it wins
          // the depth test where the two coincide instead of z-fighting.
          hs.meshes[k].material.polygonOffset = true;
          hs.meshes[k].material.polygonOffsetFactor = -1;
          hs.meshes[k].material.polygonOffsetUnits = -1;
          g.add(hs.meshes[k]);
        });
      } else if (renderMode !== 'solid' && segs.length <= HIGHLIGHT_PRISM_CAP) {
        var mesh = prismMesh(segs, HIGHLIGHT_COLOR);
        mesh.material.emissive = new THREE.Color(0x551010);
        g.add(mesh);
      } else {
        var lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(segPositions(segs), 3));
        g.add(indexLines(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR }))));
      }
      return;
    }
    currentSelection.forEach(function (o) {
      var m = view.overviewMeshes[o.name];
      if (m && m.material && m.material.emissive) m.material.emissive.setHex(0x3a1010);
    });
  }

  // --- line-level isolation -----------------------------------------------------
  //
  // One move at a time, the granularity the old sidebar Toolpath card had,
  // now inside the one tool. A pick is a raycast against the overview's own
  // LineSegments (line i of a feature mesh is `userData.segs[i]`), so it can
  // only land on a line that is actually drawn. Isolate then shows that move
  // as its extrudeFlatLine prism - the solid Export writes.

  function pickLineAt(nx, ny, additive) {
    if (!view || !doc || doc.kind !== 'toolpath') return null;
    var v = view;
    v.raycaster.setFromCamera(new THREE.Vector2(nx, ny), v.camera);
    // A threshold in world units that tracks the zoom, so a pick means "the
    // line under the cursor" whether the whole part or one layer fills the view.
    var d = v.camera.position.distanceTo(v.controls.target);
    v.raycaster.params.Line.threshold = Math.max(0.05, d * 0.006);
    var targets = Object.keys(v.overviewMeshes)
      .map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.userData.segs && m.userData.segs.length; });
    var hits = v.raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    // Closest to the cursor ray wins, not first along it: with a threshold,
    // many lines are "hit" and the nearest in depth is often a neighbour.
    var ray = v.raycaster.ray, best = null, bestScore = Infinity;
    hits.forEach(function (h) {
      var sc = ray.distanceToPoint(h.point) + h.distance * 1e-4;
      if (sc < bestScore) { bestScore = sc; best = h; }
    });
    var seg = best.object.userData.segs[Math.floor(best.index / 2)];
    if (!seg) return null;
    pickLine(seg, additive);
    return seg;
  }

  function pickLine(seg, additive) {
    removeAllBalls();
    var sel;
    if (additive && selectionSource === 'line') {
      var at = currentSelection.indexOf(seg);
      sel = currentSelection.slice();
      if (at >= 0) sel.splice(at, 1); else sel.push(seg);
    } else {
      sel = [seg];
    }
    var shown = shownSegments();
    setSelection(sel, 'line');
    lineCursor = shown.indexOf(seg);
  }

  /** Step the picked line to the next / previous move that is drawn. */
  function stepLine(d) {
    var shown = shownSegments();
    if (!shown.length) return null;
    var at = lineCursor;
    if (!(selectionSource === 'line' && at >= 0 && shown[at] === currentSelection[currentSelection.length - 1])) {
      at = (selectionSource === 'line' && currentSelection.length)
        ? shown.indexOf(currentSelection[currentSelection.length - 1]) : -1;
    }
    var next = at < 0 ? (d >= 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + d));
    pickLine(shown[next], false);
    if (view && isolated) isolateRedraw();
    return shown[next];
  }

  function describeLine(s) {
    var m = s.mv;
    return '<b>Move ' + (m.index + 1) + '</b> - ' + s.feature + ', layer ' + (s.layer + 1) +
      ', Z ' + s.z.toFixed(3) + ' mm<br>' +
      m.width.toFixed(3) + ' mm wide x ' + m.height.toFixed(3) + ' mm tall, ' +
      m.length.toFixed(2) + ' mm long, ' + (m.angle * 180 / Math.PI).toFixed(1) + ' deg';
  }

  // --- the layer-range slider ---------------------------------------------------
  //
  // Two handles on one vertical track, docked to the viewport's right edge:
  // the lower and upper Z the view draws. On a slice the steps are the file's
  // own printing heights, so both handles on one step is one layer, and
  // spread apart is a chunk of layers; on a mesh (no layers)
  // the steps are millimetres across the part and the view is clipped. A VIEW:
  // it changes what is drawn and what a click can catch. Take band reads the band.

  var MESH_Z_STEPS = 201;

  function zSteps() {
    if (!doc) return 0;
    if (doc.kind === 'toolpath') return doc.zLevels.length;
    return doc.zMax > doc.zMin ? MESH_Z_STEPS : 1;
  }

  /** The Z, in mm, of step i. */
  function zAt(i) {
    if (!doc) return 0;
    if (doc.kind === 'toolpath') return doc.zLevels[Math.max(0, Math.min(doc.zLevels.length - 1, i))];
    var n = zSteps();
    return n > 1 ? doc.zMin + (doc.zMax - doc.zMin) * (i / (n - 1)) : doc.zMin;
  }

  function zRangeFull() { return !zr || (zr.lo === 0 && zr.hi === zr.n - 1); }

  /**
   * The band the slider holds, in mm, bottom to top - what Take band takes. On a
   * slice the bottom is the BOTTOM of the lowest layer's beads (a bead hangs
   * down from its printing Z), so the band covers exactly the beads drawn.
   */
  function zBandMm() {
    if (!doc || !zr) return null;
    var hi = zAt(zr.hi);
    if (doc.kind !== 'toolpath') return [zAt(zr.lo), hi];
    return [doc.zBottom[zr.lo], hi];
  }

  function setZRange(lo, hi) {
    if (!doc) return null;
    var n = zSteps();
    lo = Math.round(Number(lo)); hi = Math.round(Number(hi));
    if (!isFinite(lo)) lo = 0;
    if (!isFinite(hi)) hi = n - 1;
    lo = Math.max(0, Math.min(n - 1, lo));
    hi = Math.max(0, Math.min(n - 1, hi));
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    if (zr && zr.lo === lo && zr.hi === hi && zr.n === n) return zRange();
    zr = { lo: lo, hi: hi, n: n };
    viewChangedSoon();
    syncZRangeUI();
    return zRange();
  }

  /** The step whose Z is nearest `z` mm. */
  function stepAtZ(z) {
    var n = zSteps(), best = 0, bd = Infinity;
    for (var i = 0; i < n; i++) {
      var d = Math.abs(zAt(i) - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function zRange() {
    if (!doc || !zr) return null;
    var band = zBandMm();
    return {
      lo: zr.lo, hi: zr.hi, steps: zr.n,
      zLo: zAt(zr.lo), zHi: zAt(zr.hi),
      bandMm: band, full: zRangeFull(),
      unit: doc.kind === 'toolpath' ? 'layer' : 'mm'
    };
  }

  function stepLabel(i) {
    if (!doc) return '';
    if (doc.kind === 'toolpath') return 'Z ' + zAt(i).toFixed(2);
    return zAt(i).toFixed(1) + ' mm';
  }

  function syncZRangeUI() {
    var box = $('ms-zr');
    if (!box) return;
    var n = zr ? zr.n : 0;
    box.hidden = !(doc && n > 1);
    if (box.hidden) return;
    var pct = function (i) { return (n > 1 ? (i / (n - 1)) * 100 : 0); };
    var lo = $('ms-zr-lo'), hi = $('ms-zr-hi'), fill = $('ms-zr-fill');
    if (lo) { lo.style.bottom = pct(zr.lo) + '%'; lo.setAttribute('aria-valuenow', String(zr.lo)); lo.setAttribute('aria-valuemax', String(n - 1)); lo.setAttribute('aria-valuetext', stepLabel(zr.lo)); }
    if (hi) { hi.style.bottom = pct(zr.hi) + '%'; hi.setAttribute('aria-valuenow', String(zr.hi)); hi.setAttribute('aria-valuemax', String(n - 1)); hi.setAttribute('aria-valuetext', stepLabel(zr.hi)); }
    if (fill) { fill.style.bottom = pct(zr.lo) + '%'; fill.style.height = (pct(zr.hi) - pct(zr.lo)) + '%'; }
    var rl = $('ms-zr-lo-read'), rh = $('ms-zr-hi-read'), cnt = $('ms-zr-count');
    if (rl) rl.textContent = stepLabel(zr.lo);
    if (rh) rh.textContent = stepLabel(zr.hi);
    if (cnt) {
      cnt.textContent = doc.kind === 'toolpath'
        ? (zr.hi - zr.lo + 1) + ' / ' + n + ' layer' + (n === 1 ? '' : 's')
        : (zAt(zr.hi) - zAt(zr.lo)).toFixed(1) + ' mm';
    }
  }

  function wireZRange() {
    var box = $('ms-zr'), track = $('ms-zr-track');
    if (!box || !track || box.dataset.wired === '1') return;
    box.dataset.wired = '1';
    var drag = null;
    function stepFromY(clientY) {
      var r = track.getBoundingClientRect();
      var f = r.height > 0 ? (r.bottom - clientY) / r.height : 0;
      f = Math.max(0, Math.min(1, f));
      return Math.round(f * ((zr ? zr.n : 1) - 1));
    }
    function begin(e, which) {
      if (!zr) return;
      drag = { which: which, start: stepFromY(e.clientY), lo: zr.lo, hi: zr.hi };
      if (e.target.setPointerCapture) { try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ } }
      e.preventDefault(); e.stopPropagation();
    }
    ['lo', 'hi'].forEach(function (w) {
      var h = $('ms-zr-' + w);
      if (!h) return;
      h.addEventListener('pointerdown', function (e) { begin(e, w); });
      h.addEventListener('keydown', function (e) {
        if (!zr) return;
        var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
        if (e.key === 'Home') d = -zr.n; else if (e.key === 'End') d = zr.n;
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) {
          // Shift moves the whole window, keeping its width: scrub a chunk.
          var width = zr.hi - zr.lo;
          var lo = Math.max(0, Math.min(zr.n - 1 - width, zr.lo + d));
          setZRange(lo, lo + width);
        } else if (w === 'lo') {
          setZRange(Math.min(zr.lo + d, zr.hi), zr.hi);
        } else {
          setZRange(zr.lo, Math.max(zr.hi + d, zr.lo));
        }
      });
    });
    var fill = $('ms-zr-fill');
    if (fill) fill.addEventListener('pointerdown', function (e) { begin(e, 'both'); });
    track.addEventListener('pointerdown', function (e) {
      if (!zr || e.target !== track) return;
      // A press on bare track moves the nearer handle there.
      var at = stepFromY(e.clientY);
      if (Math.abs(at - zr.lo) <= Math.abs(at - zr.hi)) setZRange(at, zr.hi); else setZRange(zr.lo, at);
      begin(e, Math.abs(at - zr.lo) <= Math.abs(at - zr.hi) ? 'lo' : 'hi');
    });
    window.addEventListener('pointermove', function (e) {
      if (!drag || !zr) return;
      var at = stepFromY(e.clientY);
      if (drag.which === 'lo') setZRange(Math.min(at, zr.hi), zr.hi);
      else if (drag.which === 'hi') setZRange(zr.lo, Math.max(at, zr.lo));
      else {
        var width = drag.hi - drag.lo;
        var lo = Math.max(0, Math.min(zr.n - 1 - width, drag.lo + (at - drag.start)));
        setZRange(lo, lo + width);
      }
    });
    window.addEventListener('pointerup', function () { drag = null; });
    var all = $('ms-zr-all');
    if (all) all.addEventListener('click', function () { if (zr) setZRange(0, zr.n - 1); });
  }

  // --- Take band: the slider's range, as one piece -----------------------------
  //
  // The card's TAKE BAND row, the Slice side. The layer-range slider's range IS the band:
  // Take band selects everything it leaves drawn - the Range card's own
  // selection (rangeTarget) - and isolates it, one piece, to drag onto plate 2
  // or export like any isolation. It replaced Crop Z's "Crop out band" (round
  // 1b, docs/GSCOPE.md item 5): nothing is cut out of anything any more.

  // The band does not depend on the selection, so this is not on setSelection's
  // path (a box drag re-selects every pointermove); the slider and the document
  // re-read it.
  function bandReason(n) {
    if (!doc) return 'Open something first';
    if (doc.kind !== 'toolpath') return 'A band is a slice\'s layers: flip the switch to Slice';
    if (!(n != null ? n : shownSegments().length)) return 'Nothing is drawn in the slider\'s range';
    return '';
  }

  function syncTakeBand() {
    var btn = $('ms-btn-take-band'), read = $('ms-band-read');
    var n = doc && doc.kind === 'toolpath' ? shownSegments().length : 0;
    var why = bandReason(n);
    setDisabled(btn, !!why);
    if (!read) return;
    if (why) { read.textContent = why + '.'; return; }
    var band = zBandMm();
    read.textContent = 'The slider\'s range is the band: Z ' + band[0].toFixed(2) + ' - ' + band[1].toFixed(2) + ' mm, ' +
      n + ' move' + (n === 1 ? '' : 's') + '.';
  }

  /** The band isolated as one piece. Returns the selection, or null (and says why). */
  function takeBand() {
    var why = bandReason();
    if (why) { say('Take band: ' + why, true); return null; }
    var t = rangeTarget();
    if (isolated) back();
    removeAllBalls();
    setSelection(t.items, 'range');
    isolate();
    var band = zBandMm();
    say('Band Z ' + band[0].toFixed(2) + ' - ' + band[1].toFixed(2) + ' mm isolated as one piece (' + t.items.length +
        ' moves) - drag it onto ' + plateTitle(otherPlate()).toLowerCase() + ', or Export it.');
    return currentSelection;
  }

  // ===========================================================================
  // Export - the way out
  // ===========================================================================
  //
  // Both buttons build the SAME bytes through microscopeGeometry(); the only
  // difference is where they go. Geometry is in the file's own Z-up
  // millimetres, uncentred - exactly what NSO_TOOLPATH.extractSelection()
  // hands the ingest path, so a piece taken here and a piece taken there are
  // the same piece.

  /**
   * The current selection as one Z-up millimetre geometry, or null.
   * - toolpath: `buildLineGeometry()`, 12 triangles per move, closed boxes at
   *   each move's own measured width and height.
   * - mesh: the selected build objects' triangles, as read.
   */
  /**
   * What a selection ACTS on: the part of it that is shown. A slice's moves
   * whose line type is unchecked in the Features list are not drawn, so they
   * are not exported, copied or swept either (docs/GSCOPE.md, item 4) - and
   * checked again, they are back, the selection itself never having changed.
   */
  function actedOn(items) {
    if (!doc || doc.kind !== 'toolpath') return items;
    return items.filter(function (sg) { return !FEATURE_OFF.has(sg.feature); });
  }

  /** A mesh object's triangles as drawn: a piece that is still a slice's beads, minus the unchecked line types. */
  function shownPositions(o) {
    if (!o.moves || !o.moves.length || !o.moves.some(function (m) { return FEATURE_OFF.has(m.feature); })) return o.positions;
    var keep = o.moves.filter(function (m) { return !FEATURE_OFF.has(m.feature); });
    return keep.length ? window.NSOGcodeLines.buildLineGeometry(keep).positions : new Float32Array(0);
  }

  function microscopeGeometry(asSolid) {
    if (!doc || !currentSelection.length) return null;
    var positions, ids = null;
    if (asSolid) {
      var sb = solidOfSelection();
      if (!sb || !sb.positions.length) return null;
      var sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sb.positions, 3));
      sg.userData.solid = sb.stats;
      return sg;
    }
    if (doc.kind === 'toolpath') {
      var moves = actedOn(currentSelection).map(function (s) { return s.mv; });
      if (!moves.length) return null;
      var built = window.NSOGcodeLines.buildLineGeometry(moves);
      if (!built.positions.length) return null;
      positions = built.positions;
      ids = built;
    } else {
      var soups = currentSelection.map(shownPositions);
      var total = soups.reduce(function (a, p) { return a + p.length; }, 0);
      if (!total) return null;
      positions = new Float32Array(total);
      var at = 0;
      soups.forEach(function (p) { positions.set(p, at); at += p.length; });
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // which move each prism is (a pull keeps them: plate 2 draws the copy from these very prisms)
    if (ids) { geo.userData.moveIds = ids.moveIds; geo.userData.trisPerMove = ids.trisPerMove; }
    return geo;
  }

  /** What the exported piece is called. */
  function exportLabel() {
    var base = baseName(doc.name);
    if (doc.kind !== 'toolpath') {
      var what = currentSelection.length === 1
        ? currentSelection[0].name
        : currentSelection.length + ' ' + (doc.source === 'plate' ? 'pieces' : 'objects');
      // A piece read off the plate already carries the plate's own name for
      // it; prefixing "Plate - " onto that says nothing and reads worse. A
      // Picture slab is already named after its file, the same way.
      return (doc.source === 'plate' || doc.source === 'picture' || doc.source === 'take') ? what : base + ' - ' + what;
    }
    if (selectionSource === 'line' && currentSelection.length === 1) {
      var s1 = currentSelection[0];
      return base + ' - ' + s1.feature + ' L' + (s1.layer + 1) + ' move ' + (s1.mv.index + 1);
    }
    if (selectionSource === 'pick' && !currentSelection.every(function (x) { return x.obj === currentSelection[0].obj; })) {
      return base + ' - ' + currentSelection.length + ' moves';
    }
    if (selectionSource === 'pick') {
      return base + ' - piece' + (currentSelection[0].obj != null ? ' ' + currentSelection[0].obj : '') + ' (x' + currentSelection.length + ')';
    }
    if (selectionSource === 'visible' || selectionSource === 'line' || selectionSource === 'feature' || selectionSource === 'range') {
      var feats = {};
      currentSelection.forEach(function (s) { feats[s.feature] = 1; });
      var fk = Object.keys(feats);
      var zs2 = {};
      currentSelection.forEach(function (s) { zs2[s.zi] = 1; });
      var nl = Object.keys(zs2).length;
      return base + ' - ' + (fk.length === 1 ? fk[0] : fk.length + ' features') + ' (x' +
             currentSelection.length + ', ' + nl + ' layer' + (nl === 1 ? '' : 's') + ')';
    }
    if (selectionSource === 'layer') {
      var z = currentSelection.length ? currentSelection[0].z : 0;
      return base + ' - Z ' + z.toFixed(3) + ' mm (L' + ((currentSelection.length ? currentSelection[0].layer : 0) + 1) +
             ', x' + currentSelection.length + ')';
    }
    var zs = [];
    currentSelection.forEach(function (s) {
      for (var i = 0; i < zs.length; i++) if (Math.abs(zs[i] - s.z) <= 1e-6) return;
      zs.push(s.z);
    });
    return base + ' - box x' + currentSelection.length + ' (' + zs.length +
           ' layer' + (zs.length === 1 ? '' : 's') + ')';
  }

  /**
   * Back to the main Nest 3D viewport with the selection on the plate as a
   * standalone object. The same two calls extractSelection() makes, so the
   * piece is an ordinary NSO model with undo wired.
   */
  function exportToPlate() {
    if (!doc) { say('Open a file in the microscope first', true); return null; }
    var geo = microscopeGeometry();
    if (!geo) { say('Nothing selected to export', true); return null; }
    var label = exportLabel();
    var id = addModelFromZUpGeometry(label, geo);
    if (!id) { say('Export to plate failed - nothing was added', true); return null; }
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
    }
    var tris = geo.attributes.position.count / 3;
    landed(id);
    close();
    say('Export to plate ok - "' + label + '" is its own object (' + tris + ' triangles)');
    return id;
  }

  // --- Export as solid ---------------------------------------------------------
  //
  // The same selection, the same two doors, a different builder: every
  // continuous run of bead in it becomes ONE closed shell, swept along the
  // run's own ordered moves (NSOGcodeSolid.buildSolid on NSO_PathSweep), with
  // a cap only where the nozzle genuinely stopped or the selection ends. Then
  // the runs that genuinely touch - one layer on the next, a wall overlapping
  // the wall beside it - are unioned where they touch and nowhere else
  // (NSOGcodeSolid.fuseShells, the app's own kernel), so a selection of many
  // runs leaves as the solids it is, not as shells in contact. A run touching
  // nothing leaves exactly as swept. Toolpath only - a mesh document already
  // IS a solid, and the buttons are hidden for one.
  //
  // The live Solid VIEW stays the unfused shells (solidOfSelection): it is
  // redrawn on every slider step, and the union is an export-time cost.

  /** The selection's swept shells - every selected move, as the toolpath export takes them. */
  function solidOfSelection() {
    if (doc && doc.kind === 'mesh' && currentSelection.length) return takeSolidable() ? solidOfTake() : null;
    if (!doc || doc.kind !== 'toolpath' || !currentSelection.length) return null;
    var moves = actedOn(currentSelection).map(function (s) { return s.mv; });
    if (!moves.length) return null;
    return window.NSOGcodeSolid.buildSolid(moves, { cache: solidCache() });
  }

  /** The selected pieces that still have their beads, swept. Each piece keeps its own index range. */
  function solidOfTake() {
    var mv = [];
    currentSelection.forEach(function (o, i) {
      (o.moves || []).forEach(function (m) { if (!FEATURE_OFF.has(m.feature)) mv.push(Object.assign({}, m, { index: m.index + i * 10000000 })); });
    });
    if (!mv.length) return null;
    return window.NSOGcodeSolid.buildSolid(mv, { cache: new Map() });
  }

  /** Can every selected piece be swept? Only a slice's pieces, and not one a seat turned. */
  function takeSolidable() {
    return !!(doc && doc.kind === 'mesh' && currentSelection.length &&
              currentSelection.every(function (o) { return o.moves && o.moves.length; }));
  }

  /**
   * The selection as it is exported: the swept shells, fused where runs touch.
   * A Promise of a Z-up geometry whose userData carries `solid` (the sweep's
   * stats) and `fuse` (the union's), or null for no selection. If the union
   * cannot run at all, the shells are exported as they are and `fuse` says why.
   */
  function fusedGeometry() {
    var sb = solidOfSelection();
    if (!sb || !sb.positions.length) return Promise.resolve(null);
    return window.NSOGcodeSolid.fuseShells(sb).then(function (f) {
      var positions = f.ok ? f.positions : sb.positions;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.userData.solid = sb.stats;
      g.userData.fuse = f.ok ? f.stats : null;
      g.userData.fuseReason = f.reason;
      return g;
    });
  }

  function mm3(x) { return (Math.round(x * 1000) / 1000).toFixed(3); }

  /** One line on what the sweep made of the selection, for the status bar and the info box. */
  function describeSolid(st) {
    var bits = [st.shells + ' closed shell' + (st.shells === 1 ? '' : 's') +
                ' from ' + st.moves + ' move' + (st.moves === 1 ? '' : 's')];
    if (st.closedLoops) bits.push(st.closedLoops + ' seam-closed loop' + (st.closedLoops === 1 ? '' : 's'));
    if (st.forcedSplits.length) {
      bits.push(st.forcedSplits.length + ' forced split' + (st.forcedSplits.length === 1 ? '' : 's') +
                ' where the bead overlaps itself');
    }
    bits.push('volume ' + mm3(st.solidVolume) + ' mm\u00b3 (toolpath ' + mm3(st.toolpathVolume) +
              (st.seamAddedMm3 > 0 ? ' + seams ' + mm3(st.seamAddedMm3) : '') + ')');
    return bits.join(', ');
  }

  /** The sweep's line, then the union's: what the export actually holds. */
  function describeExport(geo) {
    var u = geo.userData;
    if (!u.fuse) return describeSolid(u.solid) + '; not fused - ' + u.fuseReason;
    if (!u.fuse.contacts) return describeSolid(u.solid);
    return describeSolid(u.solid) + '; fused: ' + u.fuseReason + ', exported ' +
           mm3(u.fuse.fusedVolume) + ' mm\u00b3';
  }

  function solidExportGuard() {
    if (!doc) { say('Open a file in the microscope first', true); return false; }
    if (hasBeads(doc)) {
      if (!currentSelection.length) { say('Nothing selected to export', true); return false; }
      if (!takeSolidable()) {
        say('Export as solid needs a piece that is still a slice\'s beads - this one is a mesh, or a seat turned it', true);
        return false;
      }
      return true;
    }
    if (doc.kind !== 'toolpath') { say('Export as solid is for a sliced toolpath - this document is already a mesh', true); return false; }
    if (!currentSelection.length) { say('Nothing selected to export', true); return false; }
    return true;
  }

  // Both return a Promise: the union runs in the kernel, which loads async.
  // The status line says it is working first, and a frame is let through so
  // that line is drawn before the kernel holds the thread.
  function fusing() {
    say('Export as solid - fusing ' + currentSelection.length + ' move' +
        (currentSelection.length === 1 ? '' : 's') + ' where their runs touch...');
    return new Promise(function (res) { setTimeout(res, 0); }).then(fusedGeometry);
  }

  function exportSolidToPlate() {
    if (!solidExportGuard()) return Promise.resolve(null);
    var label = exportLabel() + ' (solid)';
    return fusing().then(function (geo) {
      if (!geo) { say('Nothing selected to export', true); return null; }
      var id = addModelFromZUpGeometry(label, geo);
      if (!id) { say('Export as solid failed - nothing was added', true); return null; }
      if (typeof pushUndo === 'function') {
        pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
      }
      landed(id);
      close();
      say('Export as solid ok - "' + label + '": ' + describeExport(geo));
      return id;
    });
  }

  function exportSolidAsSTL() {
    if (!solidExportGuard()) return Promise.resolve(null);
    var name = (exportLabel() + ' solid').replace(/\s+/g, '_').replace(/[\/\\?%*:|"<>]/g, '') + '.stl';
    return fusing().then(function (geo) {
      if (!geo) { say('Nothing selected to export', true); return null; }
      var buffer = geometryToBinarySTL(geo);
      downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), name);
      say('Downloaded ' + name + ' - ' + describeExport(geo));
      return name;
    });
  }

  // --- the live toolpath / solid toggle --------------------------------------

  function setRenderMode(m) {
    m = m === 'solid' ? 'solid' : 'toolpath';
    renderMode = m;
    syncRenderRow();
    if (view && doc && doc.kind === 'toolpath') viewChanged();
    return renderMode;
  }

  /**
   * Toolpath / Solid, a row of the card's Slice side: enabled while a slice is
   * shown - one made here, or a sliced file. On a mesh (the Normal side, where
   * the row is not shown) there is nothing to draw as a toolpath.
   */
  function syncRenderRow() {
    var isPath = !!(doc && doc.kind === 'toolpath');
    var a = $('ms-render-toolpath'), b = $('ms-render-solid');
    if (a) { a.classList.toggle('active', renderMode === 'toolpath'); a.setAttribute('aria-pressed', String(renderMode === 'toolpath')); setDisabled(a, !isPath); }
    if (b) { b.classList.toggle('active', renderMode === 'solid'); b.setAttribute('aria-pressed', String(renderMode === 'solid')); setDisabled(b, !isPath); }
    var rd = $('ms-render-read');
    if (rd) {
      if (!isPath) rd.textContent = 'Flip the switch to Slice to draw the slice as a toolpath or as a solid.';
      else if (renderMode !== 'solid') rd.textContent = 'Each move drawn as a line; a small selection is highlighted as its flat beads.';
      else if (view && view.solidBuilt) rd.textContent = 'Shown: ' + describeSolid(view.solidBuilt.stats) + '.';
      else rd.textContent = 'Nothing shown.';
    }
  }

  /** Just the selection, straight to a file. Same geometry, different door. */
  function exportAsSTL() {
    if (!doc) { say('Open a file in the microscope first', true); return null; }
    var geo = microscopeGeometry();
    if (!geo) { say('Nothing selected to export', true); return null; }
    var buffer = geometryToBinarySTL(geo);
    var name = exportLabel().replace(/\s+/g, '_').replace(/[\/\\?%*:|"<>]/g, '') + '.stl';
    downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), name);
    say('Downloaded ' + name + ' (' + (geo.attributes.position.count / 3) + ' triangles)');
    return name;
  }

  // --- the whole plate ----------------------------------------------------------
  //
  // The active plate's every piece (a mesh plate: its pieces, a plate read's
  // pieces, an imported file's objects) - the same on either plate.

  function takeGeometryOf(o) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.positions), 3));
    return geo;
  }

  function wholePlateObjects() { return doc && doc.kind === 'mesh' ? doc.objects : []; }

  /** Every piece of the active plate onto the main plate, each its own object, one Undo. G-scope closes, as after any export. */
  function exportTakeToPlate() {
    var os = wholePlateObjects(), me = plateTitle(plateName);
    if (!os.length) { say(me + ' has no pieces - nothing to export', true); return null; }
    var ids = [];
    os.forEach(function (o) {
      var id = addModelFromZUpGeometry(o.name, takeGeometryOf(o));
      if (id) ids.push(id);
    });
    if (!ids.length) { say('Export to plate failed - nothing was added', true); return null; }
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'addModels', ids: ids, editId: state.editId, cutT: state.cutT });
    }
    close();
    say('Export to plate ok - ' + ids.length + ' piece' + (ids.length === 1 ? '' : 's') + ' from ' + me.toLowerCase() + ', each its own object');
    return ids;
  }

  /** The whole of the active plate as one STL, the pieces where they stand on it: Plate_1.stl / Plate_2.stl. */
  function exportTakeAsSTL() {
    var os = wholePlateObjects(), me = plateTitle(plateName);
    if (!os.length) { say(me + ' has no pieces - nothing to export', true); return null; }
    var total = os.reduce(function (a, o) { return a + o.positions.length; }, 0);
    var all = new Float32Array(total), at = 0;
    os.forEach(function (o) { all.set(o.positions, at); at += o.positions.length; });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(all, 3));
    var name = me.replace(' ', '_') + '.stl';
    downloadBlob(new Blob([geometryToBinarySTL(geo)], { type: 'application/octet-stream' }), name);
    say('Downloaded ' + name + ' (' + os.length + ' piece' + (os.length === 1 ? '' : 's') + ', ' + (all.length / 9) + ' triangles)');
    return name;
  }

  /**
   * CLEAR: the ACTIVE plate emptied - its document, pieces, selection, boxes,
   * isolation, clears and slider - and nothing else: the other plate is not
   * touched, and the active plate stays active, ready for Import or Read plate.
   * The same on either plate; there is no Shift-CLEAR. A plate that showed the
   * imported file forgets it (unless the other plate shows it too), so the next
   * open reads the plate: CLEAR on plate 1 is the start-over.
   */
  function clearPlates() {
    if (!buildWorld()) return 0;
    cancelPull();
    var me = plateTitle(plateName);
    var n = doc ? (doc.kind === 'mesh' ? doc.objects.length : 1) : 0;
    if (doc && showsImport(doc) && !showsImport(plateDoc(otherPlate()))) importedDoc = null;
    clearHover();
    emptyPlate(plateName);
    if (sizePlates()) placePlates();
    if (view) view.worldSphere = worldSphere();
    applyClip();
    redrawDoc();
    syncPlate();
    docListeners.forEach(function (fn) {
      try { fn(doc); } catch (err) { console.error('[g-scope] document listener', err); }
    });
    say(n ? me + ' cleared - empty, ready for Import or Read plate' : me + ' was already empty');
    return n;
  }

  // ===========================================================================
  // Panel
  // ===========================================================================

  function show(id, on) {
    var el = $(id);
    if (el) el.style.display = on ? (el.dataset.flex === '1' ? 'flex' : 'block') : 'none';
  }

  function badge(text) {
    var el = $('ms-mode-badge');
    if (el) el.textContent = text;
  }

  function syncExportRow() {
    var acts = !!(doc && currentSelection.length && actedOn(currentSelection).length);
    show('ms-export-row', acts);
    show('ms-export-solid-row', !!(doc && ((doc.kind === 'toolpath' && acts) || takeSolidable())));
    show('ms-take-export-row', wholePlateObjects().length > 0);
    var selTitle = $('ms-export-sel-title');
    if (selTitle) selTitle.textContent = isPieces(doc) ? 'Selected piece' : 'Selection';
    syncCardRows();
    var sa = $('ms-btn-show-all');
    setDisabled(sa, !hasLineTypes());
  }

  function syncHeader() {
    // The legend groups on whatever the FILE has. A slice has features; a plain
    // mesh has build objects. Naming the section after the wrong one would say
    // a plain STL has features, which is the thing this route must not claim.
    var legendTitle = $('ms-legend-title'), infoTitle = $('ms-info-title');
    var isPath = !!(doc && doc.kind === 'toolpath');
    if (legendTitle) {
      // One list: the slicer's line types, each with a Display check.
      legendTitle.textContent = 'Features';
    }
    if (infoTitle) {
      infoTitle.textContent = 'Selection / ' + (isPath || !doc ? 'segment' : 'part') + ' info';
    }
    var sub = $('ms-sub');
    if (!sub) return;
    if (!doc) { sub.textContent = plateTitle(plateName) + ' - empty. Import the plate, an STL, a 3MF or a sliced .gcode.3mf into it.'; return; }
    if (doc.kind === 'toolpath') {
      sub.textContent = doc.name + ' - ' + doc.segments.length + ' extrusion moves, ' +
        doc.parsed.layers.length + ' layers, true layer heights. ' +
        'Drag to orbit, scroll to zoom, right-drag to pan.';
      return;
    }
    var tris = doc.objects.reduce(function (a, o) { return a + o.triangles; }, 0);
    var unitName = doc.source === 'plate' || doc.source === 'take' ? 'piece' : 'object';
    var count = doc.name + ' - ' + doc.objects.length + ' ' + unitName +
      (doc.objects.length === 1 ? '' : 's') + ', ' + tris + ' triangles. ';
    // A document built from groups somebody else named says what it is in its
    // own words; a file says the one thing a file can say about being sliced.
    sub.textContent = count + (doc.subtitle ||
      ('Not sliced: no layers and no features, so it draws as ' +
       (doc.objects.length === 1 ? 'one whole part.' : 'one whole part per object.')));
  }

  /**
   * The current selection's extent in VIEW space, or null.
   *
   * Computed from the document rather than from the detail group, because the
   * toolpath detail group is InstancedMesh: its geometry bounding box is the
   * unit cylinder every instance shares, and reading that would frame a 1 mm
   * cylinder at the origin however far away the selection is.
   */
  function selectionBox() {
    if (!doc || !currentSelection.length) return null;
    var box = new THREE.Box3();
    if (doc.kind === 'toolpath') {
      // each move's ends, its half width out on every axis, through toThree's
      // (x, y, z) -> (x, z, -y): the box of those points, axis by axis
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (var i = 0; i < currentSelection.length; i++) {
        var s = currentSelection[i], w = (s.w || 0) / 2;
        var ax = s.x0 - doc.cx, bx = s.x1 - doc.cx, ay = s.y0 - doc.cy, by = s.y1 - doc.cy;
        x0 = Math.min(x0, ax - w, bx - w); x1 = Math.max(x1, ax + w, bx + w);
        y0 = Math.min(y0, s.z - w); y1 = Math.max(y1, s.z + w);
        z0 = Math.min(z0, -(ay + w), -(by + w)); z1 = Math.max(z1, -(ay - w), -(by - w));
      }
      if (x0 <= x1) box.set(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    } else {
      currentSelection.forEach(function (o) {
        var b = o.bounds;
        box.expandByPoint(toThree(b.minX - doc.cx, b.minY - doc.cy, b.minZ));
        box.expandByPoint(toThree(b.maxX - doc.cx, b.maxY - doc.cy, b.maxZ));
      });
    }
    return box.isEmpty() ? null : box;
  }

  /**
   * Everything the view draws, as one box: both plates' floors and what stands
   * on them (an empty plate is its floor, a little air over it).
   */
  function worldBox() {
    var box = new THREE.Box3();
    ['lens', 'take'].forEach(function (n) { box.union(plateBox(n)); });
    return box;
  }

  /** One plate's floor (its label strip too) and what stands on it, in world space. */
  function plateBox(n) {
    var half = plateSide / 2, x = plateOffset(n);
    var box = new THREE.Box3(new THREE.Vector3(x - half, 0, -half), new THREE.Vector3(x + half, 10, half + 12));
    var g = plateGroups(n)[0];
    if (!g) return box;
    g.updateMatrixWorld(true);
    g.children.forEach(function (c) {
      if (!c.geometry) return;
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
      if (!c.geometry.boundingBox.isEmpty()) box.union(c.geometry.boundingBox.clone().applyMatrix4(c.matrixWorld));
    });
    return box;
  }

  /**
   * A sphere round everything drawn, for the clip planes (followClip): each
   * plate's own bounding sphere, a tenth larger, and the two together. Generous
   * on purpose - it only sets how far the far plane reaches, and any sphere a
   * reader draws round one plate's floor and part sits inside it.
   */
  function worldSphere() {
    var out = null;
    ['lens', 'take'].forEach(function (n) {
      var s = plateBox(n).getBoundingSphere(new THREE.Sphere());
      s.radius *= 1.1;
      out = out ? out.union(s) : s;
    });
    return out;
  }

  var FRAME_DIR = [0.22, 0.95, 1];

  /** Put the camera where both plates, and everything on them, are visible (the ◎ framing). */
  function frame() {
    var v = view;
    placePlates();          // and the sphere the clip planes follow (followClip)
    var box = worldBox();
    // From the front and above, as Bambu Studio's plate view looks: the two
    // plates side by side, left and right, with a little turn so they read solid.
    frameBox(box, new THREE.Vector3().fromArray(FRAME_DIR));
  }

  /**
   * The clip planes, re-fitted to wherever the camera is, every frame.
   *
   * frameBox() sets near / far ONCE, for the box it frames, and on their own
   * those made two artificial limits: past 100x the framed distance the whole
   * part fell behind the far plane and vanished, and near stayed at the
   * framed size / 1000 however close you zoomed. The controls themselves are
   * never clamped (minDistance 0, maxDistance Infinity) - the frustum was. So
   * it follows the camera: near a hundredth of the distance to the target,
   * far out past the far side of everything drawn. No distance is refused
   * and nothing drawn is clipped.
   */
  function followClip() {
    var v = view, c = v.camera, sph = v.worldSphere;
    if (!sph) return;
    var d = c.position.distanceTo(v.controls.target);
    var reach = c.position.distanceTo(sph.center) + sph.radius;
    var near = Math.max(1e-9, d / 100);
    var far = Math.max(reach * 1.05, d * 2, near * 10);
    if (near !== c.near || far !== c.far) {
      c.near = near; c.far = far;
      c.updateProjectionMatrix();
    }
  }

  /**
   * Point the camera at one box, with air around it. Empty box: no move.
   * `dir` is where the camera stands from the box's centre - the corner the
   * reference tool looks from when it is not given.
   */
  function frameBox(box, dir) {
    var v = view;
    if (!box || box.isEmpty()) return;
    var size = new THREE.Vector3(), centre = new THREE.Vector3();
    box.getSize(size); box.getCenter(centre);
    var span = Math.max(size.x, size.y, size.z) || 20;
    // Fit the bounding SPHERE, not the longest edge. Viewed from a corner a
    // box presents its diagonal, so framing on the longest edge crops a
    // compact part off both sides of the canvas - which is what it did to a
    // piece read off the plate, the one document that is reliably compact.
    // The vertical FOV governs whenever the canvas is wider than it is tall,
    // and this panel always is.
    var radius = (size.length() / 2) || 10;
    var half = (v.camera.fov * Math.PI / 180) / 2;
    var dist = (radius / Math.sin(half)) * 1.1;          // 10% air around it
    var look = (dir || new THREE.Vector3(1, 1, 1)).clone().normalize();
    // Spend any orbit / pan the damping is still easing out FIRST. With
    // damping on, OrbitControls keeps adding a decaying remainder of the last
    // drag on every update, so a re-frame straight after a pan would drift off
    // the target it was just given. One undamped update applies the remainder
    // and zeroes it; the framing below then overwrites where it landed.
    v.controls.enableDamping = false;
    v.controls.update();
    v.controls.enableDamping = true;
    v.controls.target.copy(centre);
    v.camera.position.copy(centre).addScaledVector(look, dist);
    v.camera.near = Math.max(0.01, span / 1000);
    v.camera.far = Math.max(span, dist) * 100;
    v.camera.updateProjectionMatrix();
    v.controls.update();
  }

  // --- Normal ------------------------------------------------------------------
  //
  // The one camera: free orbit / zoom / pan, framed on the whole part - the
  // view G-scope opens in and Back returns to; isolated, turned to the
  // selection. #ms-cam-normal re-frames with it. Its neighbour in the View
  // row, Slice view, is not a camera: app-gscope-slice.js owns both buttons
  // and swaps the DOCUMENT (mesh <-> in-house slice). The old Close
  // inspection framing is gone.
  function normalView() {
    var v = view;
    if (v) {
      if (isolated) fitView(selectionBox());
      else frame();
      // Full zoom, pan and orbit: nothing is locked, and the clip planes
      // follow the camera (followClip, every frame).
      v.controls.enablePan = true;
      followClip();
      if (doc) applyDisplay();
    }
    return 'normal';
  }

  /**
   * Fit `box` in view WITHOUT turning the camera: the same viewing angle it
   * has now, the target moved to the box and the distance set so the box's
   * bounding sphere fills the frame. Isolate uses it, so the selection alone
   * is seen from where you were looking at it. Empty box: no move.
   */
  function fitView(box) {
    var v = view;
    if (!box || box.isEmpty()) return;
    var size = new THREE.Vector3(), centre = new THREE.Vector3();
    box.getSize(size); box.getCenter(centre);
    var radius = (size.length() / 2) || 10;
    var dist = (radius / Math.sin((v.camera.fov * Math.PI / 180) / 2)) * 1.1;
    var dir = v.camera.position.clone().sub(v.controls.target);
    if (dir.lengthSq() < 1e-24) dir.set(1, 1, 1);
    dir.normalize();
    // Spend the damping's remainder first, as frameBox() does.
    v.controls.enableDamping = false;
    v.controls.update();
    v.controls.enableDamping = true;
    v.controls.target.copy(centre);
    v.camera.position.copy(centre).addScaledVector(dir, dist);
    v.controls.update();
    followClip();
  }

  function open(d) {
    if (!buildWorld()) { say('Microscope failed to start - check console', true); return null; }
    // Loaded INTO THE ACTIVE PLATE, in place of what it held; the other plate is not touched.
    cancelPull();
    if (doc && doc.objects) doc.objects.forEach(dropPieceGeometry);
    doc = d;
    if (sizePlates()) placePlates();
    ensurePlates();
    HIDDEN = new Set();
    // a new slice opens with Travel off, as every one has; Display survives a plate flip, not a load
    if (doc.kind === 'toolpath') FEATURE_OFF = new Set(['Travel']);
    CLEARED = new Set();
    lineCursor = -1;
    removeAllBalls();
    currentSelection = [];
    selectionSource = 'box';
    isolated = false;
    clearGroup(view.detailGroup);
    clearGroup(view.highlightGroup);
    view.detailGroup.visible = false;
    view.overviewGroup.visible = true;
    view.highlightGroup.visible = true;
    zr = { lo: 0, hi: zSteps() - 1, n: zSteps() };
    applyClip();
    buildOverview();
    buildLegend();
    applyFeatureVisibility();
    // Every document opens with REGION off: a box is something you ask for, not
    // a side effect of looking round the part.
    setMode('piece');
    normalView();                 // frames the whole part
    syncHeader();
    info(introInfo());
    syncExportRow();
    syncRenderRow();
    syncZRangeUI();
    syncTakeBand();
    syncBackButton();
    if (view) view.worldSphere = worldSphere();
    docListeners.forEach(function (fn) {
      try { fn(doc); } catch (err) { console.error('[g-scope] document listener', err); }
    });
    syncPlate();
    return doc;
  }

  function isOpen() {
    var panel = $('microscope');
    return !!(panel && !panel.hidden);
  }

  function openPanel() {
    var panel = $('microscope');
    if (!panel) { say('Microscope panel is missing from the page', true); return; }
    panel.hidden = false;
    var btn = $('btn-microscope');
    if (btn) btn.classList.add('is-on');
    if (!buildWorld()) return;
    // One loop, however many times the panel is opened - a second would double
    // the frame rate and the damping with it.
    if (!view.running) { view.running = true; animate(++loop); }
    resize();
    // A reopen leaves the camera where it was left, in either mode. A NEW
    // document is framed by open(), which every route calls after this.
    // The panel owns the keyboard while it is up, so its own Escape handler is
    // reachable without clicking into it first.
    if (panel.focus) panel.focus();
  }

  /**
   * CLOSE (and BACK, and every export that leaves G-scope) end the visit
   * whole. Nothing of it survives but an imported file: plate 2 is thrown
   * away, plate 1 is emptied, the Display set, the render mode, REGION and the
   * open ▾ menu or Export card go back to their defaults (the Slice settings
   * fold and take the printer profile again: app-gscope-slice.js), and the next open starts from a
   * fresh read of the plate - or of the imported file, if plate 1 was showing
   * it (or a slice made from it) when G-scope closed.
   */
  function close() {
    cancelPull();
    var panel = $('microscope');
    if (panel) panel.hidden = true;
    var btn = $('btn-microscope');
    if (btn) btn.classList.remove('is-on');
    if (view) view.running = false;
    loop++;                       // retires any frame already in flight
    if (!showsImport(lensDoc()) && !showsImport(plateDoc('take'))) importedDoc = null;
    shellCardClose();
    reset();
    FEATURE_OFF = new Set(['Travel']);
    renderMode = 'toolpath';
    setMode('piece');
  }

  /** Is this plate's document the imported file - as opened, re-opened, or a slice made from it? */
  function showsImport(d) {
    var I = importedDoc;
    if (!I || !d) return false;
    if (d === I || d.importOf === I) return true;
    if (I.objects && d.objects === I.objects) return true;
    return !!(I.objects && d.nsoSlice && d.nsoSlice.source && d.nsoSlice.source.objects === I.objects);
  }

  /**
   * The imported file as a plate holds it: a copy of the document as Import
   * opened it, so what is done on the plate - a piece set down on it - never
   * reaches the import itself (setDownOn assigns new arrays, it never edits
   * one in place).
   */
  function importCopy(I) {
    var d = Object.assign({}, I);
    d.importOf = I;
    d.layerIndex = undefined;
    return d;
  }

  /** The imported file back on plate 1, as Import opened it: nothing selected, isolated or hidden. */
  function reopenImport() {
    if (!importedDoc) return null;
    openPanel();
    return open(importCopy(importedDoc));
  }

  /** Both plates empty, plate 1 active. */
  function reset() {
    cancelPull();
    if (view && plateName !== 'lens') showPlate('lens', { quiet: true });
    emptyPlate('take');
    emptyPlate('lens');
    plateSide = BED_GRID;
    clearHover();
    if (view) { applyClip(); applyDisplay(); ensurePlates(); }
    syncZRangeUI();
    syncTakeBand();
    buildLegend();
    syncHeader();
    syncExportRow();
    syncRenderRow();
    syncBackButton();
    info('No file open.');
    syncPlate();
    docListeners.forEach(function (fn) {
      try { fn(null); } catch (err) { console.error('[g-scope] document listener', err); }
    });
  }

  function openPicker() {
    var input = $('ms-input');
    if (!input) { say('Microscope is missing its file input', true); return; }
    input.value = '';
    input.click();
  }

  function onPicked(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { say('Could not read ' + file.name, true); };
    reader.onload = function (e) {
      openPanel();
      load(file.name, e.target.result).then(function (d) {
        if (!d) return;
        say('Microscope: ' + file.name + ' open');
      });
    };
    reader.readAsArrayBuffer(file);
  }

  var wiredWindow = false;

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') {
      el.dataset.wired = '1';
      el.addEventListener(ev, fn);
    }
  }

  // ===========================================================================
  // Shell: the card, and the two that open
  //
  // The card (docs/GSCOPE.md item 12) is always up; the ▾ menu and Export are
  // the two that open - one at a time, each from its own button; Escape, CLOSE
  // or its button again shuts it, a press outside the ▾ menu shuts that one,
  // and a choice in it does too. The engine still shows and hides the rows by
  // id, as it always did - the only things added are that a button whose rows
  // are all hidden is disabled (nothing to open), a card whose button is
  // disabled shuts, and the Export card's groups follow the rows they hold.
  // The card's height is published as --ms-card-bottom, so the left wall's
  // readouts (and the support pop) stay under it whichever side it shows.
  // ===========================================================================

  // [button, card, the rows the engine shows for it - null: always available]
  var SHELL_CARDS = [
    ['ms-btn-import-more', 'ms-import-menu', null],
    ['ms-nav-export', 'ms-card-export', ['ms-export-row', 'ms-export-solid-row', 'ms-slice-export-row', 'ms-take-export-row']]
  ];
  var shellOpen = null;      // the card id that is open, or null

  function rowShown(id) {
    var el = $(id);
    return !!el && el.style.display !== 'none';
  }

  function shellCardSet(card, on) {
    var el = $(card);
    if (el) el.classList.toggle('is-open', on);
    // a shut card must not take the keyboard with it: it goes back to the
    // button that opened it (or, that one off, the panel - Escape is the panel's)
    var ae = document.activeElement, panel = $('microscope');
    if (!on && el && ae && el.contains(ae)) {
      var opener = null;
      SHELL_CARDS.forEach(function (c) { if (c[1] === card) opener = $(c[0]); });
      if (opener && !opener.disabled && opener.focus) opener.focus();
      else if (panel && panel.focus) panel.focus();
    }
    // the ▾ menu opened: the keyboard is on its item
    if (on && card === 'ms-import-menu') { var item = $('ms-btn-plate'); if (item && item.focus) item.focus(); }
    SHELL_CARDS.forEach(function (c) {
      if (c[1] !== card) return;
      var btn = $(c[0]);
      if (!btn) return;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-expanded', String(on));
    });
  }

  /** Shut the open card. True if there was one (Escape's cue to stop there). */
  function shellCardClose() {
    if (!shellOpen) return false;
    shellCardSet(shellOpen, false);
    shellOpen = null;
    return true;
  }

  /** Open a card, shutting the one that was open; its own button again shuts it. */
  function shellCardToggle(card) {
    var was = shellOpen;
    shellCardClose();
    if (was !== card) { shellCardSet(card, true); shellOpen = card; }
  }

  function syncShell() {
    SHELL_CARDS.forEach(function (c) {
      var btn = $(c[0]);
      if (!btn || !c[2]) return;
      var avail = c[2].some(rowShown);
      setDisabled(btn, !avail);
      if (!avail && shellOpen === c[1]) shellCardClose();
    });
    // A labelled group of rows shows while any of its rows does.
    var groups = document.querySelectorAll('#ms-card-export .ms-xgroup');
    Array.prototype.forEach.call(groups, function (g) {
      var any = Array.prototype.some.call(g.children, function (k) {
        return !k.classList.contains('ms-section-title') && k.style.display !== 'none';
      });
      g.style.display = any ? '' : 'none';
    });
  }

  function wireShell() {
    SHELL_CARDS.forEach(function (c) {
      bind(c[0], 'click', function () { shellCardToggle(c[1]); });
    });
    // a press anywhere but the ▾ menu (or its button) shuts the menu, and so
    // does the keyboard leaving it for anywhere else
    var panel = $('microscope');
    if (panel && panel.dataset.menuWired !== '1') {
      panel.dataset.menuWired = '1';
      var outside = function (t) {
        var m = $('ms-import-menu'), b = $('ms-btn-import-more');
        return !((m && m.contains(t)) || (b && b.contains(t)));
      };
      panel.addEventListener('pointerdown', function (ev) {
        if (shellOpen === 'ms-import-menu' && outside(ev.target)) shellCardClose();
      }, true);
      var menu = $('ms-import-menu');
      if (menu) menu.addEventListener('focusout', function (ev) {
        if (shellOpen === 'ms-import-menu' && ev.relatedTarget && outside(ev.relatedTarget)) shellCardClose();
      });
    }
    watchCard();
    if (typeof MutationObserver === 'undefined') { syncShell(); return; }
    var watch = new MutationObserver(syncShell);
    var seen = {};
    SHELL_CARDS.forEach(function (c) {
      (c[2] || []).forEach(function (id) {
        var el = $(id);
        if (el && !seen[id]) { seen[id] = 1; watch.observe(el, { attributes: true, attributeFilter: ['style'] }); }
      });
    });
    syncShell();
  }

  /** The card's bottom edge, from the top of the panel, as --ms-card-bottom (the left wall stays under it). */
  function watchCard() {
    var card = $('ms-main-card'), panel = $('microscope');
    if (!card || !panel || card.dataset.watched === '1') return;
    card.dataset.watched = '1';
    var put = function () {
      var cr = card.getBoundingClientRect(), pr = panel.getBoundingClientRect();
      if (!cr.height) return;                                // the panel is shut
      panel.style.setProperty('--ms-card-bottom', Math.round(cr.bottom - pr.top) + 'px');
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(put).observe(card);
    put();
  }

  function mount() {
    // X-ray's pattern: one rail button, a toggle, and it acts on what is
    // ALREADY on the plate rather than sending you off to fetch something
    // first. The file picker is what an empty plate falls back to, not the
    // front door. After an Import the next open shows the file again - IMPORT's
    // ▾ Read plate is how you go back to the plate from one.
    bind('btn-microscope', 'click', function () {
      if (isOpen()) { close(); return; }
      // Every open is a fresh one (close() ended the last visit whole): the
      // imported file if one is loaded, else the plate read again.
      if (importedDoc && reopenImport()) return;
      if (openPlate()) return;
      openPanel();
      normalView();
      if (!lensDoc()) openPicker();
    });
    bind('ms-btn-take-clear', 'click', function () { clearPlates(); });
    bind('ms-btn-frame', 'click', function () { if (buildWorld()) frame(); });
    bind('ms-btn-take-export-plate', 'click', exportTakeToPlate);
    bind('ms-btn-take-export-stl', 'click', exportTakeAsSTL);
    bind('ms-input', 'change', onPicked);
    bind('ms-btn-open', 'click', function () { shellCardClose(); openPicker(); });
    bind('ms-btn-plate', 'click', function () {
      shellCardClose();                                       // a choice shuts the ▾ menu
      if (!openPlate()) say('Nothing on the plate to look at - import a file instead', true);
    });
    bind('ms-close', 'click', close);
    bind('ms-btn-back-producer', 'click', backToProducer);
    // REGION: a toggle - armed, a click places a capture box; again, the click is the piece's
    bind('ms-mode-select', 'click', function () { setMode(mode === 'select' ? 'piece' : 'select'); });
    var zcard = $('ms-zr-card');
    if (zcard && zcard.dataset.wired !== '1') {
      zcard.dataset.wired = '1';
      zcard.addEventListener('click', rangeCardClick);
      zcard.addEventListener('pointerdown', rangeCardPress);
      zcard.addEventListener('pointerenter', function () { if (!pull) drawHover(rangeTarget()); });
      zcard.addEventListener('pointerleave', clearHover);
    }
    bind('ms-btn-clear', 'click', function () {
      if (isolated && selectionSource === 'box') unIsolate();
      removeAllBalls();
      selectionSource = 'box';
      computeSelectionInfo();
      syncExportRow();
    });
    bind('ms-btn-isolate', 'click', function () { isolateBoxes(); });
    wireShell();
    bind('ms-btn-back', 'click', unIsolate);                  // WHOLE PART: back out of any isolate
    bind('ms-btn-show-all', 'click', checkAll);
    bind('ms-btn-take-band', 'click', function () { takeBand(); });
    wireZRange();
    bind('ms-btn-export-plate', 'click', exportToPlate);
    bind('ms-btn-export-stl', 'click', exportAsSTL);
    bind('ms-btn-export-solid-plate', 'click', exportSolidToPlate);
    bind('ms-btn-export-solid-stl', 'click', exportSolidAsSTL);
    bind('ms-render-toolpath', 'click', function () { setRenderMode('toolpath'); });
    bind('ms-render-solid', 'click', function () { setRenderMode('solid'); });
    if (!wiredWindow && window && window.addEventListener) {
      wiredWindow = true;
      window.addEventListener('resize', resize);
    }
    var panel = $('microscope');
    if (panel && panel.dataset.wired !== '1') {
      panel.dataset.wired = '1';
      panel.addEventListener('keydown', function (ev) {
        // Escape, one step at a time: an open ▾ menu or Export card shuts; then
        // what is isolated is whole again; then the last box placed (not
        // isolated) goes; then REGION disarms; with none of those, Escape
        // closes G-scope, as before.
        if (ev.key === 'Escape') {
          if (!shellCardClose() && !unIsolate() && !removeLastBox() && !disarmRegion()) close();
          ev.preventDefault();
          return;
        }
        // Left / Right step a picked line (the API's pickLine / stepLine) -
        // unless a text field or the slider has the keys.
        var t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || (t.getAttribute && t.getAttribute('role') === 'slider'))) return;
        if (doc && doc.kind === 'toolpath' && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') &&
            selectionSource === 'line') {
          stepLine(ev.key === 'ArrowRight' ? 1 : -1);
          ev.preventDefault();
        }
      });
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  /**
   * A file handed over by the app's own Import (app-core.js handleFiles):
   * into G-scope, and NOT onto the plate. A slice is something you look
   * through; what leaves the view does so through Export, by choice.
   */
  function openFile(filename, arrayBuffer) {
    openPanel();
    return load(filename, arrayBuffer).then(function (d) {
      if (d) say('G-scope: ' + filename + ' open - nothing was added to the plate');
      return d;
    });
  }

  return {
    mount: mount,
    open: openPanel,
    openFile: openFile,
    isSliced: function (arrayBuffer) {
      return threeMFHasToolpath(arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer));
    },
    close: close,
    isOpen: isOpen,
    /** Both plates empty, and an imported file forgotten too: the next open reads the plate. */
    reset: function () { importedDoc = null; reset(); },
    load: load,
    openPlate: openPlate,
    openObjects: openObjects,
    openToolpathResult: openToolpathResult,
    plateObjects: plateObjects,
    openPicker: openPicker,
    setMode: function (m) { setMode(m); },
    /** What the outline under the pointer stands for: { source, count, label } or null. */
    hoverInfo: function () {
      if (!hoverTgt) return null;
      var o = { source: hoverTgt.source, count: hoverTgt.items.length, label: hoverTgt.label };
      if (hoverTgt.stand) o.stand = hoverTgt.stand;     // 'box': the piece's box stood in for its surface
      return o;
    },
    isIsolated: function () { return isolated; },
    pressTargetAt: function (x, y) { var t = pressTarget({ clientX: x, clientY: y }); return t ? { source: t.source, count: t.items.length, selected: !!t.selected } : null; },
    mode: function () { return mode; },
    addBoxAt: function (gx, gy, gz, r, h, ry, a) {
      // A capture box placed by G-code coordinates rather than by a click, so a
      // check can drive the same selection a drag produces. `ry` makes the
      // footprint a rectangle, as the corner handle does; `r` is then X.
      // `a` turns it (radians, CCW from G-code X); 'auto' squares it to the
      // piece beside it, as a click-drop does; omitted, square to the plate.
      if (!doc || !buildWorld()) return null;
      var p = toThree(gx - doc.cx, gy - doc.cy, gz);
      var ang = a === 'auto' ? pieceAngleNear(gx, gy) : (a || 0);
      var b = addBall(p, r != null ? r : defaultR, h != null ? h : defaultH, ry, ang);
      selectionSource = 'box';
      computeSelectionInfo();
      return b;
    },
    clearBoxes: function () {
      removeAllBalls();
      selectionSource = 'box';
      computeSelectionInfo();
    },
    boxes: function () { return gcodeBoxes(); },
    /** The card's side, as the switch shows it: 'normal' (a mesh, pieces, nothing) or 'slice' (a toolpath). */
    cardSide: function () { return cardSide(); },
    /** Each capture box's three dots, where they are drawn on screen (client px): [{ move, resizeH, resizeXY }]. */
    boxDots: function () {
      if (!view) return [];
      var r = view.renderer.domElement.getBoundingClientRect(), p = new THREE.Vector3();
      return balls.map(function (b) {
        var o = {};
        DOT_KINDS.forEach(function (k) {
          b[k[0]].getWorldPosition(p);
          var q = p.clone().project(view.camera);
          o[k[1]] = [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height];
        });
        return o;
      });
    },
    setLegendCollapsed: function (on) { setLegendCollapsed(on); },
    selectLayer: selectLayer,
    selection: function () { return currentSelection.slice(); },
    selectionSource: function () { return selectionSource; },
    geometry: microscopeGeometry,
    // --- G-scope: the selection seam and the view filters ---
    selectionRegion: selectionRegion,
    onSelection: function (fn) {
      if (typeof fn === 'function') selectionListeners.push(fn);
      return function () { selectionListeners = selectionListeners.filter(function (f) { return f !== fn; }); };
    },
    setSelectionMoves: function (moveIndices) {
      // Select by parsed-move index - the other half of the seam, for a
      // producer that knows moves and not the view's segment wrappers.
      if (!doc || doc.kind !== 'toolpath') return [];
      var want = new Set(moveIndices || []);
      removeAllBalls();
      setSelection(doc.segments.filter(function (s) { return want.has(s.mv.index); }), 'line');
      return currentSelection;
    },
    soloGroup: soloGroup,
    soloGroups: soloGroups,
    /** Check all (the View card's #ms-btn-show-all): every Features box checked. */
    checkAll: checkAll,
    showAll: checkAll,
    /** One Features box, checked or not - what a click on it does. */
    setFeatureDisplay: function (name, on) { setFeatureDisplay(name, !!on); },
    clearFromView: clearFromView,
    cleared: function () { return Array.from(CLEARED); },
    selectVisible: selectVisible,
    shownCount: function () {
      if (!doc) return 0;
      return doc.kind === 'toolpath' ? shownSegments().length : shownObjects().length;
    },
    pickLineAt: pickLineAt,
    pickLine: function (moveIndex, additive) {
      if (!doc || doc.kind !== 'toolpath') return null;
      var seg = doc.segments.find(function (s) { return s.mv.index === moveIndex; });
      if (seg) pickLine(seg, !!additive);
      return seg || null;
    },
    stepLine: stepLine,
    setZRange: setZRange,
    setZRangeMm: function (zLo, zHi) { return setZRange(stepAtZ(zLo), stepAtZ(zHi)); },
    zRange: zRange,
    flushView: function () {
      if (viewPending) { viewPending = false; viewChanged(); }
      if (highlightPending) { highlightPending = false; refreshHighlight(); }
    },
    takeBand: takeBand,
    bandReason: function () { return bandReason(); },
    exportLabel: function () { return doc && currentSelection.length ? exportLabel() : null; },
    exportToPlate: exportToPlate,
    exportAsSTL: exportAsSTL,
    exportSolidToPlate: exportSolidToPlate,
    exportSolidAsSTL: exportSolidAsSTL,
    solidOfSelection: solidOfSelection,
    fusedGeometry: fusedGeometry,
    setRenderMode: setRenderMode,
    renderMode: function () { return renderMode; },
    shownSolid: function () { return view && view.solidBuilt ? view.solidBuilt : null; },
    isolate: function () { return isolate(); },
    back: back,
    normalView: normalView,
    layerCount: layerCount,
    hidden: function () { return doc && doc.kind === 'toolpath' ? Array.from(FEATURE_OFF) : (HIDDEN ? Array.from(HIDDEN) : []); },
    groups: function () { return doc ? Object.keys(doc.groups) : []; },
    getDoc: function () { return doc; },
    // --- the two plates (docs/GSCOPE.md) ---
    plate: function () { return plateName; },
    showPlate: showPlate,
    activatePlate: activatePlate,
    plateOffset: function (n) { return plateOffset(n); },
    plateSide: function () { return plateSide; },
    imported: function () { return importedDoc ? importedDoc.name : null; },
    frame: function () { if (buildWorld()) frame(); },
    onPlate: function (fn) { if (typeof fn === 'function') plateListeners.push(fn); },
    lensDoc: lensDoc,
    plateDoc: plateDoc,
    takeDoc: function () { return plateDoc('take'); },
    takePieces: takePieces,
    plateState: plateState,
    clearPlates: clearPlates,
    pullSpec: pullSpec,
    exportTakeToPlate: exportTakeToPlate,
    exportTakeAsSTL: exportTakeAsSTL,
    // --- for layers drawn over the view (app-gscope-support.js) ---
    addClickHook: function (fn) { if (typeof fn === 'function') clickHooks.push(fn); },
    onDocument: function (fn) { if (typeof fn === 'function') docListeners.push(fn); },
    /** A point in the file's Z-up millimetres, in view space. */
    toView: function (x, y, z) { return doc ? toThree(x - doc.cx, y - doc.cy, z) : null; },
    /** Select mesh-document objects by name, through the one seam. */
    selectObjects: function (names, source) {
      if (!doc || doc.kind !== 'mesh') return [];
      var want = new Set(names || []);
      removeAllBalls();
      setSelection(doc.objects.filter(function (o) { return want.has(o.name); }), source || 'pick');
      return currentSelection;
    },
    getView: function () { return view; },
    /** Switch a control off without dropping the keyboard (app-gscope-slice.js's switch uses it). */
    setDisabled: setDisabled
  };
})();

if (typeof window !== 'undefined') window.NSO_MICROSCOPE = NSO_MICROSCOPE;
