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
 *   Crop          the slider's Z band, cut out through app-crop.js.
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
  function info(html) {
    var el = $('ms-info');
    if (el) el.innerHTML = html;
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
   * piece, or a feature lifted out of one (the Flange tab's).
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
    return open(d);
  }

  /** Whatever is on the plate, under the lens. The overlay route. */
  function openPlate() {
    var objs = plateObjects();
    if (!objs.length) return null;
    return openObjects('Plate', objs, {
      source: 'plate',
      subtitle: 'The plate as it stands, read off the pieces themselves. ' +
                'Not a sliced file: no layers and no slicer features, so each ' +
                'piece draws whole. Click one to drop a capture box over it.'
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
   * failure that has already been reported.
   */
  function load(filename, arrayBuffer) {
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
  var mode = 'orbit';         // 'orbit' | 'select'
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
  // Isolate's state, kept apart from what is drawn. Isolated in Normal: the
  // selection alone, drawn as-is. Isolated in Close inspection: the whole view
  // with the selection highlighted over it. The camera toggle flips between
  // the two without leaving the isolation (applyDisplay).
  var isolated = false;
  var clickHooks = [];        // fn(ndcX, ndcY, event) -> true when it took the click
  var docListeners = [];      // fn(doc) after every open()

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

    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    // The reference tool adds this only on Isolate, so its detail cylinders
    // "actually read as 3D". A mesh document needs it from the first frame or
    // it renders as a flat silhouette, so it is added once, up front.
    var dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(1, 1, 1);
    scene.add(dl);

    // grid on the "bed" plane (three.js XZ plane, y=0)
    scene.add(new THREE.GridHelper(120, 24, 0x333844, 0x22252c));

    var overviewGroup = new THREE.Group();
    scene.add(overviewGroup);
    var detailGroup = new THREE.Group();
    detailGroup.visible = false;
    scene.add(detailGroup);
    // The current selection, drawn over the overview so a picked line or a
    // caught region can be seen before anything is isolated or exported.
    var highlightGroup = new THREE.Group();
    scene.add(highlightGroup);
    // The layer-range slider clips a mesh document with two planes.
    renderer.localClippingEnabled = true;

    var raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.6;

    view = {
      scene: scene, camera: camera, renderer: renderer, controls: controls,
      host: host,
      overviewGroup: overviewGroup, detailGroup: detailGroup, highlightGroup: highlightGroup,
      clip: [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)],
      overviewMeshes: {},
      raycaster: raycaster,
      dragRaycaster: new THREE.Raycaster(),
      mouse: new THREE.Vector2(),
      resizePlane: new THREE.Plane(),
      running: false,
      dragState: null,
      mouseDownPos: null
    };

    wireViewport();
    wireLegendToggle();
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
      if (n.geometry) n.geometry.dispose();
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
        var positions = new Float32Array(segs.length * 6);
        segs.forEach(function (s, i) {
          var p0 = toThree(s.x0 - doc.cx, s.y0 - doc.cy, s.z);
          var p1 = toThree(s.x1 - doc.cx, s.y1 - doc.cy, s.z);
          positions[i * 6 + 0] = p0.x; positions[i * 6 + 1] = p0.y; positions[i * 6 + 2] = p0.z;
          positions[i * 6 + 3] = p1.x; positions[i * 6 + 4] = p1.y; positions[i * 6 + 5] = p1.z;
        });
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        var isTravel = feature === 'Travel';
        var mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
          color: colorForGroup(feature, gi),
          transparent: isTravel,
          opacity: isTravel ? 0.35 : 1.0
        }));
        mesh.userData.feature = feature;
        // Line i of this mesh is segs[i] - how a picked line finds its move.
        mesh.userData.segs = segs;
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
    // so what the microscope shows is what the plate would show.
    var byObject = {};
    doc.objects.forEach(function (o, gi) {
      byObject[o.name] = o;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.positions), 3));
      geo.translate(-doc.cx, -doc.cy, 0);
      geo.rotateX(-Math.PI / 2);          // the same (x,y,z) -> (x,z,-y) as toThree
      geo.computeVertexNormals();
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: colorForGroup(o.name, gi), metalness: 0.05, roughness: 0.4,
        clippingPlanes: clipPlanes()
      }));
      mesh.userData.feature = o.name;
      mesh.userData.object = o;
      v.overviewMeshes[o.name] = mesh;
      v.overviewGroup.add(mesh);
    });
    doc.groups = byObject;
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

    var handle = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x5b8cff }));       // centre dot - drag to MOVE
    var heightHandle = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6),
      new THREE.MeshBasicMaterial({ color: 0xffb35b }));       // top dot - drag to set thickness
    // corner dot - drag to size X and Y. Drawn over the toolpath: the corner
    // it sits on is usually inside a wall of lines, and a handle you cannot
    // see is one you cannot find (the raycast finds it through them anyway).
    var cornerHandle = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6),
      new THREE.MeshBasicMaterial({ color: 0x4cd97b, depthTest: false, depthWrite: false }));
    cornerHandle.renderOrder = 10;

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
    b.handle.scale.setScalar(Math.max(0.35, rMax * 0.1));
    b.heightHandle.position.set(b.point.x, b.point.y + b.h, b.point.z);
    b.heightHandle.scale.setScalar(Math.max(0.3, rMax * 0.08));
    b.cornerHandle.position.copy(cornerPoint(b));
    b.cornerHandle.scale.setScalar(Math.max(0.3, rMax * 0.08));
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
  function gcodeBoxes() {
    return balls.map(function (b) {
      // Inverse of toThree: three (x, y, z) -> gcode (x + cx, -z + cy, y)
      var a = b.a || 0, ca = Math.cos(a), sa = Math.sin(a);
      return { gx: b.point.x + doc.cx, gy: -b.point.z + doc.cy, gz: b.point.y,
               rx: b.rx, ry: b.ry, r: Math.max(b.rx, b.ry), h: b.h, a: a,
               ca: ca, sa: sa,
               // plate-aligned half-extents of the turned footprint, for
               // bounding-box rejects
               ex: b.rx * Math.abs(ca) + b.ry * Math.abs(sa),
               ey: b.rx * Math.abs(sa) + b.ry * Math.abs(ca) };
    });
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

  function selectByBox() {
    var boxes = gcodeBoxes();
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
    // the box holds any of its triangle centroids. See docs/GCODE-MICROSCOPE.md
    // for why the granularity is the object and not the triangle.
    return doc.objects.filter(function (o) {
      if (!objectShown(o)) return false;
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
      return false;
    });
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
          : '<b>' + balls.length + ' box(es)</b>, ') +
           '<b>' + currentSelection.length + ' segment(s)</b> total<br>' +
           'across ' + keys.length + ' layer(s): ' + keys.join(', '));
      return;
    }
    var tris = currentSelection.reduce(function (a, o) { return a + o.triangles; }, 0);
    info((selectionSource === 'visible' ? '<b>everything shown</b>, '
          : selectionSource === 'flange' ? '<b>Flange</b> (detected), '
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
      v.overviewMeshes[name].visible = !HIDDEN.has(name) && !detail;
    });
    Object.keys(v.solidMeshes || {}).forEach(function (name) {
      v.solidMeshes[name].visible = !HIDDEN.has(name) && !detail;
    });
    v.detailGroup.children.forEach(function (mesh) {
      mesh.visible = !HIDDEN.has(mesh.userData.feature);
    });
  }

  function buildLegend() {
    var legend = $('ms-legend');
    if (!legend) return;
    legend.innerHTML = '';
    if (!doc) { buildDetectedRow(); return; }
    Object.keys(doc.groups).sort().forEach(function (name, gi) {
      var g = doc.groups[name];
      var count = doc.kind === 'toolpath' ? g.length : g.triangles;
      var unit = doc.kind === 'toolpath' ? '' : ' tri';
      var item = document.createElement('div');
      item.className = 'ms-legend-item' + (HIDDEN.has(name) ? ' dim' : '');
      item.dataset.group = name;
      var swatch = document.createElement('div');
      swatch.className = 'ms-swatch';
      swatch.style.background = '#' + ('000000' + colorForGroup(name, gi).toString(16)).slice(-6);
      var label = document.createElement('span');
      label.className = 'ms-legend-label';
      label.textContent = name + ' (' + count + unit + ')';
      // Feature-level isolation in one click: this group alone, every other
      // one switched off. A view action like the row click - nothing is
      // selected, exported or written anywhere.
      var only = document.createElement('button');
      only.type = 'button';
      only.className = 'ms-legend-only';
      only.textContent = 'only';
      only.title = 'Show ' + name + ' alone (view only - click Show all to bring the rest back)';
      only.addEventListener('click', function (ev) {
        ev.stopPropagation();
        soloGroup(name);
      });
      item.appendChild(swatch); item.appendChild(label); item.appendChild(only);
      item.addEventListener('click', function () {
        if (HIDDEN.has(name)) HIDDEN.delete(name); else HIDDEN.add(name);
        viewChanged();
      });
      legend.appendChild(item);
    });
    buildDetectedRow();
  }

  // --- viewport interaction -------------------------------------------------

  function setMode(newMode) {
    // Picking a line needs lines; a mesh document has none.
    if (newMode === 'line' && !(doc && doc.kind === 'toolpath')) newMode = 'select';
    mode = newMode;
    var o = $('ms-mode-orbit'), s = $('ms-mode-select'), l = $('ms-mode-line');
    if (o) o.classList.toggle('active', mode === 'orbit');
    if (s) s.classList.toggle('active', mode === 'select');
    if (l) l.classList.toggle('active', mode === 'line');
    var ctl = $('ms-select-controls');
    if (ctl) ctl.style.display = mode === 'select' ? 'block' : 'none';
    show('ms-line-controls', mode === 'line');
    var hint = $('ms-hint-badge');
    if (hint) {
      hint.textContent = mode === 'select'
        ? 'Click empty space to drop a flat box. Drag its blue centre dot to move it, the green corner dot to size it along and across, a side to scale the footprint, the orange top dot to set how thick it is.'
        : mode === 'line'
          ? 'Click a line to pick that one move. Shift-click adds or removes a line. Left / Right arrows step to the neighbouring move.'
          : '';
    }
  }

  function ndc(e) {
    var rect = view.renderer.domElement.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    ];
  }

  function wireViewport() {
    var v = view;
    var el = v.renderer.domElement;

    el.addEventListener('pointerdown', function (e) {
      v.mouseDownPos = [e.clientX, e.clientY];
      if (mode !== 'select') return;
      var p = ndc(e);
      v.dragRaycaster.setFromCamera(new THREE.Vector2(p[0], p[1]), v.camera);

      // priority: centre handle (move) > height handle (thickness) >
      //           corner handle (X and Y) > box face
      var handleHits = v.dragRaycaster.intersectObjects(balls.map(function (b) { return b.handle; }));
      if (handleHits.length > 0) {
        var i1 = balls.findIndex(function (b) { return b.handle === handleHits[0].object; });
        v.dragState = { type: 'move', ballIndex: i1 };
        v.controls.enabled = false;
        var d1 = new THREE.Vector3();
        v.camera.getWorldDirection(d1);
        v.resizePlane.setFromNormalAndCoplanarPoint(d1, balls[i1].point);
        return;
      }
      var heightHits = v.dragRaycaster.intersectObjects(balls.map(function (b) { return b.heightHandle; }));
      if (heightHits.length > 0) {
        v.dragState = {
          type: 'resizeH',
          ballIndex: balls.findIndex(function (b) { return b.heightHandle === heightHits[0].object; })
        };
        v.controls.enabled = false;
        return;
      }
      // The corner dot: drag it across a horizontal plane at the corner's own
      // height, and the footprint's X and Y half-extents follow the pointer
      // independently. The box stays centred, as every other resize keeps it.
      var cornerHits = v.dragRaycaster.intersectObjects(balls.map(function (b) { return b.cornerHandle; }));
      if (cornerHits.length > 0) {
        var i2 = balls.findIndex(function (b) { return b.cornerHandle === cornerHits[0].object; });
        v.dragState = { type: 'resizeXY', ballIndex: i2 };
        v.controls.enabled = false;
        v.resizePlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), cornerPoint(balls[i2]));
        return;
      }
      // Not recursive: the box's edge lines are a child of boxMesh, and at the
      // raycaster's 1 mm Line threshold a press near any edge hit THEM first -
      // no box owns that object, so the drag indexed balls[-1] and threw.
      // (The reference tool has the same fault.)
      var surfaceHits = v.dragRaycaster.intersectObjects(balls.map(function (b) { return b.boxMesh; }), false);
      if (surfaceHits.length > 0) {
        var i3 = balls.findIndex(function (b) { return b.boxMesh === surfaceHits[0].object; });
        // The footprint's proportion, fixed for the drag (see resizeR below).
        var m3 = Math.max(balls[i3].rx, balls[i3].ry);
        v.dragState = { type: 'resizeR', ballIndex: i3, fx: balls[i3].rx / m3, fy: balls[i3].ry / m3 };
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
        // footprint resize: horizontal distance only. The reference tool set
        // its one `r` here; with a rectangle the LARGER side follows the
        // pointer and the other keeps the proportion it had when the drag
        // began, so a square behaves exactly as it did and a corner-drawn
        // rectangle keeps its shape.
        var flat = Math.max(0.3, Math.min(60, Math.hypot(hit.x - ball.point.x, hit.z - ball.point.z)));
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

    el.addEventListener('pointerup', function (e) {
      if (!doc || v.dragState || !v.mouseDownPos) return;
      if (Math.hypot(e.clientX - v.mouseDownPos[0], e.clientY - v.mouseDownPos[1]) > 4) return;
      // A click hook (app-gscope-support.js's markers and supports) gets the
      // click first, in every mode: a marker is a thing you click, not a
      // region you box. A hook that takes the click returns true.
      var h = ndc(e);
      for (var hk = 0; hk < clickHooks.length; hk++) {
        try { if (clickHooks[hk](h[0], h[1], e)) return; }
        catch (err) { console.error('[g-scope] click hook', err); }
      }
      if (mode !== 'select' && mode !== 'line') return;
      if (mode === 'line') {
        var q = ndc(e);
        pickLineAt(q[0], q[1], e.shiftKey);
        return;
      }

      var p = ndc(e);
      v.mouse.set(p[0], p[1]);
      v.raycaster.setFromCamera(v.mouse, v.camera);
      var targets = Object.keys(v.overviewMeshes)
        .map(function (k) { return v.overviewMeshes[k]; })
        .filter(function (m) { return m.visible; });
      var hits = v.raycaster.intersectObjects(targets);
      if (hits.length === 0) return;

      // Square to the piece beside the drop, not to the plate.
      var hp0 = hits[0].point;
      var ang = pieceAngleNear(hp0.x + doc.cx, -hp0.z + doc.cy);
      if (defaultRx != null) addBall(hp0.clone(), defaultRx, defaultH, defaultRy, ang);
      else addBall(hp0.clone(), defaultR, defaultH, undefined, ang);
      selectionSource = 'box';
      computeSelectionInfo();
    });
  }

  // --- Isolate / Back -------------------------------------------------------

  /** Isolated and in Normal: the selection alone is what is drawn. */
  function showingDetail() { return isolated && cameraMode === 'normal'; }

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
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.positions), 3));
      geo.translate(-doc.cx, -doc.cy, 0);
      geo.rotateX(-Math.PI / 2);
      geo.computeVertexNormals();
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: isDetected(o) ? FLANGE_COLOR : colorForGroup(o.name, Math.max(0, okeys.indexOf(o.name))),
        metalness: 0.05, roughness: 0.4,
        clippingPlanes: clipPlanes()
      }));
      mesh.userData.feature = o.name;
      v.detailGroup.add(mesh);
    });
  }

  /** Moves as line segments, the overview's own way of drawing them. */
  function lineMesh(segs, color, faint) {
    var positions = new Float32Array(segs.length * 6);
    segs.forEach(function (s, i) {
      var p0 = toThree(s.x0 - doc.cx, s.y0 - doc.cy, s.z);
      var p1 = toThree(s.x1 - doc.cx, s.y1 - doc.cy, s.z);
      positions.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 6);
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: color, transparent: !!faint, opacity: faint ? 0.35 : 1.0
    }));
    mesh.userData.segs = segs;
    return mesh;
  }

  /**
   * What is drawn, from the isolation and the camera mode:
   *   Normal, not isolated      the whole view, the selection highlighted
   *   Normal, isolated          the selection alone, as-is (detail group)
   *   Close inspection, either  the whole view with the highlighted
   *                             selection over it, framed on the selection
   */
  function applyDisplay() {
    var v = view;
    if (!v) return;
    var detail = showingDetail();
    v.detailGroup.visible = detail;
    v.overviewGroup.visible = !detail;
    v.highlightGroup.visible = !detail;
    var unit = doc && doc.kind === 'toolpath' ? 'segments' : 'object(s)';
    badge(detail ? 'Detail: ' + currentSelection.length + ' ' + unit
        : cameraMode === 'close' ? 'Close inspection' + (isolated ? ' (isolated)' : '')
        : 'Whole part');
    show('ms-detail-controls', isolated);
    show('ms-select-controls', !isolated && mode === 'select');
    applyFeatureVisibility();
  }

  function isolate(opts) {
    if (!currentSelection.length) return false;
    isolated = true;
    buildDetail();
    // Isolate shows the selection alone, which is Normal's isolated view -
    // so it lands in Normal, turned to the selection (fitView: the same
    // viewing angle, the selection filling the frame). A redraw under a
    // filter or a changed selection passes keepCamera and moves nothing.
    if (!(opts && opts.keepCamera)) {
      cameraMode = 'normal';
      syncCameraButtons();
      fitView(selectionBox());
    }
    applyDisplay();
    return true;
  }

  function back() {
    isolated = false;
    clearGroup(view.detailGroup);
    setCameraMode('normal');      // the whole part again; Back is the way out
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
    // The corner dot follows the camera round to the near corner.
    balls.forEach(function (b) { b.cornerHandle.position.copy(cornerPoint(b)); });
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
    syncLayerRow();
    return currentSelection;
  }

  // ===========================================================================
  // G-scope: the selection seam, the view filters, line picking, the layer
  // range and Crop
  // ===========================================================================
  //
  // THE SELECTION IS ONE THING. Whatever produced it - a capture box, a whole
  // layer, a picked line, "everything shown" - it is an array of segments
  // (toolpath) or of objects (mesh), and it reaches the rest of the view
  // through setSelection() and nowhere else. Isolate, the highlight, both
  // exports and Crop read `currentSelection`; none of them knows or asks which
  // control made it. docs/GCODE-MICROSCOPE.md, "The selection seam", is where
  // a future support-generation step plugs in.

  function setSelection(items, source) {
    currentSelection = items || [];
    selectionSource = source || selectionSource;
    if (selectionSource !== 'line') lineCursor = -1;
    if (doc) describeSelection();
    syncExportRow();
    buildDetectedRow();        // lit while the selection is the flange
    refreshHighlightSoon();
    // Isolated, the view IS the selection: a box dragged, a line stepped,
    // redraws it. One rebuild per frame, however many steps a drag makes.
    if (isolated) isolateRedrawSoon();
    syncCropRow();
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
    return !HIDDEN.has(s.feature) && !CLEARED.has(s.id) && inZRange(s);
  }

  function objectShown(o) {
    if (HIDDEN.has(o.name)) return false;
    var band = zBandMm();
    if (!band || zRangeFull()) return true;
    return o.bounds.maxZ >= band[0] - 1e-6 && o.bounds.minZ <= band[1] + 1e-6;
  }

  /** Every segment drawn right now, in print order. */
  function shownSegments() {
    if (!doc || doc.kind !== 'toolpath') return [];
    return doc.segments.filter(segShown);
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
    }
    applyFeatureVisibility();
    refreshHighlight();
    syncZRangeUI();
    syncCropRow();
    syncLineRead();
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

  /** One legend group alone. Feature-level isolation; view only. */
  function soloGroup(name) {
    if (!doc || !doc.groups[name]) return false;
    HIDDEN = new Set(Object.keys(doc.groups).filter(function (g) { return g !== name; }));
    viewChanged();
    return true;
  }

  // ===========================================================================
  // Detected features: the Flange tab
  // ===========================================================================
  //
  // The tabs above are what the FILE groups - a slice's FEATURE: tags, a
  // mesh's build objects. A flange is a functional part of ONE object, so no
  // file names it: nso_flange.js finds it (docs/GSCOPE-FLANGE.md has the rule
  // and what it was validated on) and lifts it out as its own closed solid
  // with the Cut tool's rawCut. What comes back is an ordinary mesh object -
  // positions, centroids, bounds - so it reaches the rest of the view through
  // setSelection() like anything else: Isolate, the highlight, Crop and both
  // exports take it without knowing where it came from. The one thing it is
  // not is a plate piece, so Crop sends it the file route (a new piece, then
  // cropped) rather than editing a piece in place.
  //
  // Detection runs once per document, just after it opens, so the view is up
  // first; clicking the tab before it has finished runs it there and then.

  var FLANGE_COLOR = 0xff8a1f;
  var FLANGE_MAX_TRIS = 400000;   // past this, say so rather than stall the page

  function isDetected(o) { return !!(o && o.detected); }

  function flangeState() {
    if (!doc) return null;
    if (!doc.flange) {
      doc.flange = doc.kind !== 'mesh'
        ? { status: 'unavailable', objects: [], notes: [],
            reason: 'a slice has beads, not a closed surface to measure. Open the part itself ' +
                    '(its STL or 3MF, or the plate) to find its flange.' }
        : { status: 'pending', objects: [], notes: [], reason: '' };
    }
    return doc.flange;
  }

  /** Find and lift out every flange in the document. Idempotent per document. */
  function detectFlanges() {
    var st = flangeState();
    if (!st || st.status !== 'pending') return st;
    var F = window.NSO_Flange;
    if (!F || typeof rawCut !== 'function') {
      st.status = 'unavailable';
      st.reason = 'the flange detector (nso_flange.js) or the Cut tool (app-cut.js) is not loaded.';
      return st;
    }
    var t0 = Date.now();
    var single = doc.objects.length === 1 && doc.source !== 'plate';
    doc.objects.forEach(function (host) {
      if (host.triangles > FLANGE_MAX_TRIS) {
        st.notes.push(host.name + ': ' + host.triangles + ' triangles, too many to scan here');
        return;
      }
      var r;
      try { r = F.detect(host.positions); }
      catch (err) { console.error('[g-scope] flange detection', err); st.notes.push(host.name + ': detection failed'); return; }
      if (!r.flanges.length) { st.notes.push(host.name + ': ' + r.reason.replace(/^no flange: /, '')); return; }
      r.flanges.forEach(function (f, i) {
        var e = F.extract(host.positions, f, rawCut);
        if (!e.ok) { st.notes.push(host.name + ': a flange was found but not lifted out (' + e.reason + ')'); return; }
        var label = (single ? baseName(doc.name) : host.name) + ' - Flange' +
          (r.flanges.length > 1 ? ' ' + (i + 1) : '');
        st.objects.push(prepObject({
          name: label,
          positions: e.positions,
          detected: 'flange',
          host: host.name,
          flange: { thickness: f.thickness, reach: f.reach, rootLength: f.rootLen,
                    axis: f.axis, band: f.band, cut: e.plane }
        }));
      });
    });
    st.status = st.objects.length ? 'found' : 'none';
    st.ms = Date.now() - t0;
    if (!st.objects.length) {
      st.reason = st.notes.length === 1 ? st.notes[0].replace(/^[^:]*: /, '') : st.notes.join('; ');
    }
    return st;
  }

  function flangeRowText(st) {
    if (st.status === 'pending') return 'Flange - looking...';
    if (st.status === 'unavailable') return 'Flange - not on a slice';
    if (st.status === 'none') return 'Flange - none detected';
    var o = st.objects;
    return 'Flange (' + (o.length === 1
      ? o[0].flange.thickness.toFixed(2) + ' mm, ' + o[0].triangles + ' tri'
      : o.length + ' found') + ')';
  }

  /** The Flange tab, under the file's own tabs. Rebuilt with the legend. */
  function buildDetectedRow() {
    var box = $('ms-detected');
    if (!box) return;
    box.innerHTML = '';
    var st = flangeState();    // null with no document: the row goes with it
    if (!st) return;
    var item = document.createElement('div');
    item.className = 'ms-legend-item ms-detected-item' + (st.status === 'found' ? '' : ' dim');
    item.dataset.detected = 'flange';
    item.dataset.status = st.status;
    var on = st.status === 'found' && currentSelection.length > 0 &&
      currentSelection.every(isDetected);
    if (on) item.classList.add('active');
    var swatch = document.createElement('div');
    swatch.className = 'ms-swatch';
    swatch.style.background = '#' + ('000000' + FLANGE_COLOR.toString(16)).slice(-6);
    var label = document.createElement('span');
    label.className = 'ms-legend-label';
    label.textContent = flangeRowText(st);
    item.title = st.status === 'found'
      ? 'Detected from the geometry, not named in the file. Click to isolate ' +
        (st.objects.length === 1 ? 'it' : 'them') + ' - then Crop or Export as usual.\n' +
        st.objects.map(function (o) {
          return o.name + ': ' + o.flange.thickness.toFixed(2) + ' mm thick, ' + o.flange.reach.toFixed(1) +
            ' mm out, ' + o.flange.rootLength.toFixed(1) + ' mm along its root';
        }).join('\n')
      : st.status === 'pending' ? 'Looking for a flange in the geometry...'
      : 'No flange: ' + st.reason;
    item.appendChild(swatch); item.appendChild(label);
    item.addEventListener('click', function () { isolateFlange(); });
    box.appendChild(item);
  }

  /**
   * The Flange tab's click: the flange(s) as the selection, isolated. On a
   * piece with none, say why and change nothing.
   */
  function isolateFlange() {
    var st = detectFlanges();
    if (!st) return false;
    buildDetectedRow();
    if (st.status !== 'found') {
      var why = st.status === 'unavailable' ? 'Flange: not available - ' + st.reason
        : 'Flange: none detected - ' + st.reason;
      say(why, false);
      info((st.status === 'unavailable' ? '<b>Flange: not available here.</b> ' : '<b>No flange detected.</b> ') +
           st.reason.replace(/</g, '&lt;'));
      return false;
    }
    removeAllBalls();
    setSelection(st.objects.slice(), 'flange');
    isolate();
    buildDetectedRow();
    return true;
  }

  var detectTimer = null;
  function detectSoon() {
    if (detectTimer) clearTimeout(detectTimer);
    var mine = doc;
    detectTimer = setTimeout(function () {
      detectTimer = null;
      if (doc !== mine) return;
      detectFlanges();
      buildDetectedRow();
    }, 30);
  }

  /**
   * Clear the selection FROM VIEW. Hides it - a piece, a feature's lines, a
   * picked line - and stops there: no export, no plate change, no undo entry.
   * `Show all` brings it back. This is the view-only answer to "get this out
   * of my way", and it is deliberately not wired to anything that writes.
   */
  function clearFromView() {
    if (!doc || !currentSelection.length) return 0;
    var n = currentSelection.length;
    if (view && isolated) back();
    if (doc.kind === 'toolpath') {
      currentSelection.forEach(function (s) { CLEARED.add(s.id); });
    } else {
      currentSelection.forEach(function (o) { if (!isDetected(o)) HIDDEN.add(o.name); });
    }
    removeAllBalls();
    setSelection([], selectionSource === 'line' ? 'line' : 'box');
    viewChanged();
    info('<b>' + n + ' ' + (doc.kind === 'toolpath' ? 'line(s)' : 'piece(s)') +
         '</b> cleared from view. Nothing was exported and the plate is unchanged. ' +
         '<b>Show all</b> brings them back.');
    return n;
  }

  /** Every legend group back on, nothing cleared. The slider is left alone. */
  function showAll() {
    if (!doc) return;
    CLEARED.clear();
    HIDDEN = new Set(doc.kind === 'toolpath' ? ['Travel'] : []);
    viewChanged();
  }

  /** Everything the filters leave on screen, as the selection. */
  function selectVisible() {
    if (!doc) return [];
    removeAllBalls();
    if (doc.kind === 'toolpath') setSelection(shownSegments(), 'visible');
    else setSelection(doc.objects.filter(objectShown), 'visible');
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
        var pos = new Float32Array(segs.length * 6);
        segs.forEach(function (s, i) {
          var p0 = toThree(s.x0 - doc.cx, s.y0 - doc.cy, s.z), p1 = toThree(s.x1 - doc.cx, s.y1 - doc.cy, s.z);
          pos.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 6);
        });
        var lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR })));
      }
      return;
    }
    currentSelection.forEach(function (o) {
      if (isDetected(o)) {
        // Lifted out of a part that is drawn whole, so it is drawn over that
        // part - winning the depth test where the two coincide.
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.positions), 3));
        geo.translate(-doc.cx, -doc.cy, 0);
        geo.rotateX(-Math.PI / 2);
        geo.computeVertexNormals();
        var hm = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: FLANGE_COLOR, metalness: 0.05, roughness: 0.4, clippingPlanes: clipPlanes(),
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
        }));
        hm.userData.feature = o.name;
        g.add(hm);
        return;
      }
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
    syncLineRead();
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

  function syncLineRead() {
    var el = $('ms-line-read');
    if (!el) return;
    var shown = shownSegments();
    if (selectionSource === 'line' && currentSelection.length && lineCursor >= 0) {
      el.textContent = 'Line ' + (lineCursor + 1) + ' of ' + shown.length + ' shown' +
        (currentSelection.length > 1 ? ' (' + currentSelection.length + ' picked)' : '');
    } else {
      el.textContent = shown.length + ' line(s) shown - click one, or step with the arrows';
    }
  }

  // --- the layer-range slider ---------------------------------------------------
  //
  // Two handles on one vertical track, docked to the viewport's right edge:
  // the lower and upper Z the view draws. On a slice the steps are the file's
  // own printing heights, so both handles on one step is one layer, and
  // spread apart is a chunk of layers; on a mesh (no layers - see syncLayerRow)
  // the steps are millimetres across the part and the view is clipped. A VIEW:
  // it changes what is drawn and what a click can catch. Crop reads the band.

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
   * The band the slider holds, in mm, bottom to top - what Crop removes. On a
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

  // --- Crop, through the real Crop tool ----------------------------------------
  //
  // Crop out the slider's Z band and rejoin what is above onto what is below.
  // G-scope does not crop anything itself: every route ends in app-crop.js -
  // NSO_cropRaw (Cut's clip, the joint seal, the gate) and NSO_cropModel (the
  // painted-face stand-down, the in-page canonical checker, the commit with
  // its 'cropReplace' undo) - the functions behind the Cut menu's Crop row.
  //
  //   plate piece   crops THAT piece in place. The band is mapped from the
  //                 view's Z to the piece's raw Z by the offset between the
  //                 two, and refused if the piece was tilted (spans differ).
  //   slice         the selection's beads (buildLineGeometry - one closed
  //                 prism per move) become a piece on the plate, and that
  //                 piece is cropped. Beads are touching closed shells, not one
  //                 closed solid, so Crop runs with `shells` - see NSO_cropRaw.
  //   file mesh     as a slice, without `shells`.
  // A refusal is checked BEFORE anything reaches the plate, so a refused crop
  // leaves the plate exactly as it was.

  function cropAvailable() {
    return typeof NSO_cropRaw === 'function' && typeof NSO_cropModel === 'function';
  }

  function cropReason() {
    if (!doc) return 'Open something first';
    if (!cropAvailable()) return 'The Crop tool (app-crop.js) is not loaded';
    if (!currentSelection.length) return 'Select what to crop first';
    if (!zr || zRangeFull()) return 'Narrow the layer range to the band to remove';
    if (cropsPiece() && currentSelection.length !== 1) return 'Crop edits one plate piece at a time';
    return '';
  }

  /**
   * Crop edits a plate piece in place only when the selection IS a plate
   * piece. A flange lifted out of one is not: it goes the file route, as a
   * new piece that is then cropped, and the piece it came from is untouched.
   */
  function cropsPiece() {
    return doc && doc.source === 'plate' && !currentSelection.some(isDetected);
  }

  function syncCropRow() {
    var row = $('ms-crop-row');
    if (!row) return;
    row.style.display = doc ? 'block' : 'none';
    var btn = $('ms-btn-crop'), read = $('ms-crop-read');
    var why = cropReason();
    if (btn) btn.disabled = !!why;
    if (!read) return;
    if (why) { read.textContent = why + '.'; return; }
    var band = zBandMm();
    read.textContent = 'Removes Z ' + band[0].toFixed(2) + ' - ' + band[1].toFixed(2) + ' mm (' +
      (band[1] - band[0]).toFixed(2) + ' mm) from ' +
      (cropsPiece() ? '"' + currentSelection[0].name + '", in place'
        : 'the selection, as a new piece on the plate') + ', and joins the rest.';
  }

  function cropLabel(band) {
    return 'removed Z ' + band[0].toFixed(2) + '–' + band[1].toFixed(2) + ' mm (G-scope)';
  }

  function cropZBand() {
    var why = cropReason();
    if (why) { say('Crop: ' + why, true); return { ok: false, reason: why }; }
    var band = zBandMm();
    var label = cropLabel(band);

    if (cropsPiece()) {
      var o = currentSelection[0];
      var p = state.placed && state.placed[o.placedIndex];
      var m = p && (state.models || []).find(function (mm) { return mm && mm.id === p.sourceId; });
      if (!m || !m.rawTris) { say('Crop: that piece has no raw mesh to crop', true); return { ok: false, reason: 'no raw piece' }; }
      var rb = NSO_cropBounds(m.rawTris);
      var spanRaw = rb.hi[2] - rb.lo[2], spanView = o.bounds.maxZ - o.bounds.minZ;
      if (Math.abs(spanRaw - spanView) > 1e-3) {
        var why2 = 'the piece was tilted since it was loaded, so its raw Z no longer matches the view';
        say('Crop refused - piece unchanged (' + why2 + ')', true);
        return { ok: false, reason: why2 };
      }
      var off = o.bounds.minZ - rb.lo[2];
      var r = NSO_cropModel(m, { axisIdx: 2, lo: band[0] - off, hi: band[1] - off }, { label: label });
      if (r.ok) {
        // Read the plate again so the view shows the piece as it now is.
        // The status line keeps Crop's own report.
        openPlate();
      }
      r.modelId = m.id;
      return r;
    }

    var shells = doc.kind === 'toolpath';
    var geo = microscopeGeometry();
    if (!geo) { say('Crop: the selection has no geometry', true); return { ok: false, reason: 'empty' }; }
    var soup = geo.attributes.position.array;
    // Dry run first, on the same soup and with the same two gates
    // NSO_cropModel applies, so a refusal never leaves a stray piece behind.
    var dry = NSO_cropRaw(soup, { axisIdx: 2, lo: band[0], hi: band[1], shells: shells });
    if (dry.ok && typeof NSO_cropCensus === 'function') {
      var cb = NSO_cropCensus(soup), ca = NSO_cropCensus(dry.tris);
      if (cb && ca && (ca.open || ca.nm > cb.nm || ca.degen > cb.degen)) {
        dry.ok = false;
        dry.reason = 'checker: open ' + ca.open + ', non-manifold ' + cb.nm + '→' + ca.nm +
          ', degenerate ' + cb.degen + '→' + ca.degen;
      }
    }
    if (!dry.ok) {
      say('Crop refused - nothing added to the plate (' + dry.reason + ')', true);
      return dry;
    }
    var name = exportLabel() + ' - cropped';
    var id = addModelFromZUpGeometry(name, geo);
    if (!id) { say('Crop failed - nothing was added', true); return { ok: false, reason: 'ingest failed' }; }
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
    }
    var model = state.models.find(function (mm) { return mm && mm.id === id; });
    var res = NSO_cropModel(model, { axisIdx: 2, lo: band[0], hi: band[1] }, { shells: shells, label: label });
    res.modelId = id;
    // Crop's own status line stands: it says what was removed and what the
    // checker found. Back to the plate, where the new piece is.
    if (res.ok) close();
    return res;
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
  function microscopeGeometry(asSolid) {
    if (!doc || !currentSelection.length) return null;
    var positions;
    if (asSolid) {
      var sb = solidOfSelection();
      if (!sb || !sb.positions.length) return null;
      var sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sb.positions, 3));
      sg.userData.solid = sb.stats;
      return sg;
    }
    if (doc.kind === 'toolpath') {
      var built = window.NSOGcodeLines.buildLineGeometry(
        currentSelection.map(function (s) { return s.mv; }));
      if (!built.positions.length) return null;
      positions = built.positions;
    } else {
      var total = currentSelection.reduce(function (a, o) { return a + o.positions.length; }, 0);
      if (!total) return null;
      positions = new Float32Array(total);
      var at = 0;
      currentSelection.forEach(function (o) { positions.set(o.positions, at); at += o.positions.length; });
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }

  /** What the exported piece is called. */
  function exportLabel() {
    var base = baseName(doc.name);
    if (doc.kind !== 'toolpath') {
      // A detected feature is already named for its part ("<part> - Flange").
      if (currentSelection.every(isDetected)) {
        return currentSelection.length === 1 ? currentSelection[0].name
          : baseName(doc.name) + ' - ' + currentSelection.length + ' flanges';
      }
      var what = currentSelection.length === 1
        ? currentSelection[0].name
        : currentSelection.length + ' ' + (doc.source === 'plate' ? 'pieces' : 'objects');
      // A piece read off the plate already carries the plate's own name for
      // it; prefixing "Plate - " onto that says nothing and reads worse.
      return doc.source === 'plate' ? what : base + ' - ' + what;
    }
    if (selectionSource === 'line' && currentSelection.length === 1) {
      var s1 = currentSelection[0];
      return base + ' - ' + s1.feature + ' L' + (s1.layer + 1) + ' move ' + (s1.mv.index + 1);
    }
    if (selectionSource === 'visible' || selectionSource === 'line') {
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
      return base + ' - Z ' + z.toFixed(3) + ' mm (L' + ((doc.layerIndex || 0) + 1) +
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
    if (!doc || doc.kind !== 'toolpath' || !currentSelection.length) return null;
    return window.NSOGcodeSolid.buildSolid(currentSelection.map(function (s) { return s.mv; }),
                                           { cache: solidCache() });
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

  function syncRenderRow() {
    var isPath = !!(doc && doc.kind === 'toolpath');
    show('ms-render-row', isPath);
    var a = $('ms-render-toolpath'), b = $('ms-render-solid');
    if (a) { a.classList.toggle('active', renderMode === 'toolpath'); a.setAttribute('aria-pressed', String(renderMode === 'toolpath')); }
    if (b) { b.classList.toggle('active', renderMode === 'solid'); b.setAttribute('aria-pressed', String(renderMode === 'solid')); }
    var rd = $('ms-render-read');
    if (rd) {
      if (!isPath) rd.textContent = '';
      else if (renderMode !== 'solid') rd.textContent = 'Each move drawn as a line; Close inspection highlights the selection as its flat beads.';
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
    show('ms-export-row', !!(doc && currentSelection.length));
    show('ms-export-solid-row', !!(doc && doc.kind === 'toolpath' && currentSelection.length));
    var iso = $('ms-btn-isolate');
    if (iso) iso.disabled = !currentSelection.length;
    var iso2 = $('ms-btn-isolate-line');
    if (iso2) iso2.disabled = !currentSelection.length;
    var clr = $('ms-btn-clear-view');
    if (clr) clr.disabled = !currentSelection.length;
    var sv = $('ms-btn-select-visible');
    if (sv) sv.disabled = !doc;
    var sa = $('ms-btn-show-all');
    if (sa) sa.disabled = !doc;
  }

  function syncLayerRow() {
    var n = layerCount();
    var row = $('ms-layer-row');
    if (row) row.style.display = doc ? 'block' : 'none';
    var note = $('ms-layer-note');
    var num = $('ms-layer-index');
    var btn = $('ms-btn-layer-select');
    var prev = $('ms-layer-prev'), next = $('ms-layer-next');
    var has = n > 0;
    [num, btn, prev, next].forEach(function (el) { if (el) el.disabled = !has; });
    if (num) {
      num.max = has ? String(n - 1) : '0';
      num.value = String(doc && doc.layerIndex != null ? doc.layerIndex : 0);
    }
    if (note) {
      // Refused, not faked. Inventing layers for an unsliced mesh would mean
      // guessing a layer height the file never states - the same fiction the
      // importer refuses when it drops Travel moves.
      note.textContent = has
        ? n + ' layers in this file'
        : 'This file is not sliced, so it has no layers. Use the capture box.';
    }
  }

  function syncHeader() {
    // The legend groups on whatever the FILE has. A slice has features; a plain
    // mesh has build objects. Naming the section after the wrong one would say
    // a plain STL has features, which is the thing this route must not claim.
    var legendTitle = $('ms-legend-title'), infoTitle = $('ms-info-title');
    var isPath = !!(doc && doc.kind === 'toolpath');
    if (legendTitle) {
      legendTitle.textContent = (doc && !isPath ? 'Parts' : 'Features') + ' (click to isolate)';
    }
    if (infoTitle) {
      infoTitle.textContent = 'Selection / ' + (isPath || !doc ? 'segment' : 'part') + ' info';
    }
    var sub = $('ms-sub');
    if (!sub) return;
    if (!doc) { sub.textContent = 'The plate, or an STL, a 3MF or a sliced .gcode.3mf.'; return; }
    if (doc.kind === 'toolpath') {
      sub.textContent = doc.name + ' - ' + doc.segments.length + ' extrusion moves, ' +
        doc.parsed.layers.length + ' layers, true layer heights. ' +
        'Drag to orbit, scroll to zoom, right-drag to pan.';
      return;
    }
    var tris = doc.objects.reduce(function (a, o) { return a + o.triangles; }, 0);
    var unitName = doc.source === 'plate' ? 'piece' : 'object';
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
      currentSelection.forEach(function (s) {
        var w = (s.w || 0) / 2;
        box.expandByPoint(toThree(s.x0 - doc.cx - w, s.y0 - doc.cy - w, s.z - w));
        box.expandByPoint(toThree(s.x0 - doc.cx + w, s.y0 - doc.cy + w, s.z + w));
        box.expandByPoint(toThree(s.x1 - doc.cx - w, s.y1 - doc.cy - w, s.z - w));
        box.expandByPoint(toThree(s.x1 - doc.cx + w, s.y1 - doc.cy + w, s.z + w));
      });
    } else {
      currentSelection.forEach(function (o) {
        var b = o.bounds;
        box.expandByPoint(toThree(b.minX - doc.cx, b.minY - doc.cy, b.minZ));
        box.expandByPoint(toThree(b.maxX - doc.cx, b.maxY - doc.cy, b.maxZ));
      });
    }
    return box.isEmpty() ? null : box;
  }

  /** Everything the view draws, as one box: the document and the bed grid. */
  function worldBox() {
    var box = new THREE.Box3();
    view.overviewGroup.children.forEach(function (c) {
      c.geometry.computeBoundingBox();
      box.union(c.geometry.boundingBox.clone().applyMatrix4(c.matrixWorld));
    });
    return box;
  }

  /** Put the camera where the loaded file is actually visible. */
  function frame() {
    var v = view;
    var box = worldBox();
    // Cached for the clip planes (followClip), which need the extent
    // every frame and must not recompute it every frame. The grid is 120 mm.
    v.worldSphere = box.clone().union(new THREE.Box3(
      new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 0, 60))).getBoundingSphere(new THREE.Sphere());
    frameBox(box);
  }

  /**
   * The clip planes, re-fitted to wherever the camera is, every frame, in
   * both camera modes.
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

  /** Point the camera at one box, with air around it. Empty box: no move. */
  function frameBox(box) {
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
    var step = dist / Math.sqrt(3);                      // equal on all three axes
    // Spend any orbit / pan the damping is still easing out FIRST. With
    // damping on, OrbitControls keeps adding a decaying remainder of the last
    // drag on every update, so a re-frame straight after a pan would drift off
    // the target it was just given - Close inspection's lock included. One
    // undamped update applies the remainder and zeroes it; the framing below
    // then overwrites where it landed.
    v.controls.enableDamping = false;
    v.controls.update();
    v.controls.enableDamping = true;
    v.controls.target.copy(centre);
    v.camera.position.set(centre.x + step, centre.y + step, centre.z + step);
    v.camera.near = Math.max(0.01, span / 1000);
    v.camera.far = Math.max(span, dist) * 100;
    v.camera.updateProjectionMatrix();
    v.controls.update();
  }

  // --- camera modes -----------------------------------------------------------
  //
  //   normal  free orbit / zoom / pan, framed on the whole part - the view
  //           G-scope opens in and Back returns to.
  //   close   Close inspection: framed tight on what is selected, orbit and
  //           zoom about it, pan off so the target stays locked on it. This
  //           is the view Isolate has always put you in.
  //
  // A camera mode is ONLY the camera. Switching it never touches the
  // selection, the capture boxes, the isolation (detail vs overview) or
  // anything on the plate, so it can be flipped either way at any time -
  // before Isolate, inside it, or after Back.
  var cameraMode = 'normal';

  /**
   * What Close inspection frames: the selection's own extent; failing that,
   * the capture boxes (a box that has caught nothing yet is still where you
   * are looking); failing both, null.
   */
  function closeBox() {
    var sel = selectionBox();
    if (sel) return sel;
    if (!balls.length) return null;
    var box = new THREE.Box3();
    balls.forEach(function (b) {
      var a = b.a || 0;
      var ex = b.rx * Math.abs(Math.cos(a)) + b.ry * Math.abs(Math.sin(a));
      var ez = b.rx * Math.abs(Math.sin(a)) + b.ry * Math.abs(Math.cos(a));
      box.expandByPoint(new THREE.Vector3(b.point.x - ex, b.point.y - b.h, b.point.z - ez));
      box.expandByPoint(new THREE.Vector3(b.point.x + ex, b.point.y + b.h, b.point.z + ez));
    });
    return box;
  }

  function setCameraMode(m) {
    cameraMode = m === 'close' ? 'close' : 'normal';
    var v = view;
    if (v) {
      if (cameraMode === 'close') {
        // The reference tool only re-TARGETED on Isolate and left the whole
        // part's zoom, which on a plate of twelve pieces leaves one isolated
        // support interface a thumbnail in the middle of the grid. Close
        // inspection is the zoom: frame the selection itself, with the rest
        // of the view drawn round it. With nothing selected or boxed there is
        // nothing to be close to, so it frames the whole part.
        var box = closeBox();
        if (box) frameBox(box); else frame();
      } else if (isolated) {
        // Normal while isolated: the selection alone, turned to it.
        fitView(selectionBox());
      } else {
        frame();
      }
      // Full zoom, pan and orbit in both modes: nothing is locked, and the
      // clip planes follow the camera (followClip, every frame).
      v.controls.enablePan = true;
      followClip();
      if (doc) applyDisplay();
    }
    syncCameraButtons();
    return cameraMode;
  }

  function syncCameraButtons() {
    var n = $('ms-cam-normal'), c = $('ms-cam-close');
    if (n) { n.classList.toggle('active', cameraMode === 'normal'); n.setAttribute('aria-pressed', String(cameraMode === 'normal')); }
    if (c) { c.classList.toggle('active', cameraMode === 'close'); c.setAttribute('aria-pressed', String(cameraMode === 'close')); }
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
    doc = d;
    HIDDEN = new Set(doc.kind === 'toolpath' ? ['Travel'] : []);
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
    setMode('select');
    setCameraMode('normal');      // frames the whole part
    syncHeader();
    syncLayerRow();
    info(doc.kind === 'toolpath'
      ? 'Click the model to drop a capture box, pick a single line, or take a whole layer.'
      : ('Click a ' + (doc.source === 'plate' ? 'piece' : 'part') +
         ' to drop a capture box over it.'));
    var lineBtn = $('ms-mode-line');
    if (lineBtn) lineBtn.disabled = doc.kind !== 'toolpath';
    syncExportRow();
    syncRenderRow();
    syncZRangeUI();
    syncCropRow();
    syncLineRead();
    if (flangeState() && flangeState().status === 'pending') detectSoon();
    docListeners.forEach(function (fn) {
      try { fn(doc); } catch (err) { console.error('[g-scope] document listener', err); }
    });
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

  function close() {
    var panel = $('microscope');
    if (panel) panel.hidden = true;
    var btn = $('btn-microscope');
    if (btn) btn.classList.remove('is-on');
    if (view) view.running = false;
    loop++;                       // retires any frame already in flight
  }

  function reset() {
    if (view) {
      removeAllBalls();
      clearGroup(view.overviewGroup);
      clearGroup(view.detailGroup);
      view.overviewMeshes = {};
    }
    doc = null;
    currentSelection = [];
    isolated = false;
    CLEARED = new Set();
    zr = null;
    if (view) clearGroup(view.highlightGroup);
    syncZRangeUI();
    syncCropRow();
    buildLegend();
    syncHeader();
    syncLayerRow();
    syncExportRow();
    syncRenderRow();
    info('No file open.');
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

  function mount() {
    // X-ray's pattern: one rail button, a toggle, and it acts on what is
    // ALREADY on the plate rather than sending you off to fetch something
    // first. The file picker is what an empty plate falls back to, not the
    // front door. A file already in the view is left alone on reopen - the
    // sidebar's "Read the plate" is how you go back to the plate from one.
    bind('btn-microscope', 'click', function () {
      if (isOpen()) { close(); return; }
      if ((!doc || doc.source === 'plate') && openPlate()) return;
      openPanel();
      if (!doc) openPicker();
    });
    bind('ms-input', 'change', onPicked);
    bind('ms-btn-open', 'click', openPicker);
    bind('ms-btn-plate', 'click', function () {
      if (!openPlate()) say('Nothing on the plate to look at - import a file instead', true);
    });
    bind('ms-close', 'click', close);
    bind('ms-mode-orbit', 'click', function () { setMode('orbit'); });
    bind('ms-mode-select', 'click', function () { setMode('select'); });
    bind('ms-btn-clear', 'click', function () {
      removeAllBalls();
      selectionSource = 'box';
      computeSelectionInfo();
    });
    bind('ms-btn-isolate', 'click', function () { isolate(); });
    bind('ms-btn-isolate-line', 'click', function () { isolate(); });
    bind('ms-cam-normal', 'click', function () { setCameraMode('normal'); });
    bind('ms-cam-close', 'click', function () { setCameraMode('close'); });
    bind('ms-btn-back', 'click', back);
    bind('ms-mode-line', 'click', function () { setMode('line'); });
    bind('ms-line-prev', 'click', function () { stepLine(-1); });
    bind('ms-line-next', 'click', function () { stepLine(1); });
    bind('ms-btn-clear-view', 'click', clearFromView);
    bind('ms-btn-show-all', 'click', showAll);
    bind('ms-btn-select-visible', 'click', selectVisible);
    bind('ms-btn-crop', 'click', function () {
      try { cropZBand(); }
      catch (err) {
        console.error('[g-scope crop]', err);
        say('Crop failed - nothing changed (' + ((err && err.message) || err) + ')', true);
      }
    });
    wireZRange();
    bind('ms-btn-export-plate', 'click', exportToPlate);
    bind('ms-btn-export-stl', 'click', exportAsSTL);
    bind('ms-btn-export-solid-plate', 'click', exportSolidToPlate);
    bind('ms-btn-export-solid-stl', 'click', exportSolidAsSTL);
    bind('ms-render-toolpath', 'click', function () { setRenderMode('toolpath'); });
    bind('ms-render-solid', 'click', function () { setRenderMode('solid'); });
    bind('ms-layer-prev', 'click', function () { stepLayer(-1); });
    bind('ms-layer-next', 'click', function () { stepLayer(1); });
    bind('ms-btn-layer-select', 'click', function () {
      var num = $('ms-layer-index');
      selectLayer(num ? (parseInt(num.value, 10) || 0) : 0);
    });
    if (!wiredWindow && window && window.addEventListener) {
      wiredWindow = true;
      window.addEventListener('resize', resize);
    }
    var panel = $('microscope');
    if (panel && panel.dataset.wired !== '1') {
      panel.dataset.wired = '1';
      panel.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { close(); ev.preventDefault(); return; }
        // Left / Right step the picked line, the way the old Toolpath card's
        // arrows did - unless a text field or the slider has the keys.
        var t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || (t.getAttribute && t.getAttribute('role') === 'slider'))) return;
        if (doc && doc.kind === 'toolpath' && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') &&
            (mode === 'line' || selectionSource === 'line')) {
          stepLine(ev.key === 'ArrowRight' ? 1 : -1);
          ev.preventDefault();
        }
      });
    }
  }

  function stepLayer(d) {
    var n = layerCount();
    if (!n) return;
    var num = $('ms-layer-index');
    var at = num ? (parseInt(num.value, 10) || 0) : 0;
    var next = Math.max(0, Math.min(n - 1, at + d));
    if (num) num.value = String(next);
    selectLayer(next);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  /**
   * A file handed over by the app's own Import (app-core.js handleFiles):
   * into G-scope, and NOT onto the plate. A slice is something you look
   * through; what leaves the view does so through Export or Crop, by choice.
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
    reset: reset,
    load: load,
    openPlate: openPlate,
    openObjects: openObjects,
    openToolpathResult: openToolpathResult,
    plateObjects: plateObjects,
    openPicker: openPicker,
    setMode: function (m) { setMode(m); },
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
    showAll: showAll,
    clearFromView: clearFromView,
    cleared: function () { return Array.from(CLEARED); },
    selectVisible: selectVisible,
    shownCount: function () {
      if (!doc) return 0;
      return doc.kind === 'toolpath' ? shownSegments().length : doc.objects.filter(objectShown).length;
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
    cropZBand: cropZBand,
    cropReason: cropReason,
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
    setCameraMode: setCameraMode,
    cameraMode: function () { return cameraMode; },
    layerCount: layerCount,
    hidden: function () { return HIDDEN ? Array.from(HIDDEN) : []; },
    groups: function () { return doc ? Object.keys(doc.groups) : []; },
    getDoc: function () { return doc; },
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
    // --- detected features (docs/GSCOPE-FLANGE.md) ---
    /** The Flange tab's state: status 'pending' | 'found' | 'none' | 'unavailable'. */
    flange: function () {
      var st = flangeState();
      if (!st) return null;
      return { status: st.status, reason: st.reason, notes: st.notes.slice(), ms: st.ms,
               objects: st.objects.map(function (o) {
                 return { name: o.name, host: o.host, triangles: o.triangles, bounds: o.bounds,
                          flange: o.flange };
               }) };
    },
    detectFlanges: function () { var st = detectFlanges(); buildDetectedRow(); return st ? st.status : null; },
    isolateFlange: isolateFlange
  };
})();

if (typeof window !== 'undefined') window.NSO_MICROSCOPE = NSO_MICROSCOPE;
