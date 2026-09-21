/*
 * The Microscope view - the reference tool, lifted, with a way in and a way out
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
 * press - app-core.js's `handleFiles()` hands the ALREADY-PARSED result to
 * `openToolpathResult()` (no second parse) after the toolpath import has run.
 * The plate import behind the overlay is untouched, so Close drops you onto
 * the Toolpath card exactly as before.
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
      var tail = String(name).split(' - ').pop();
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
    var segs = res.parsed.moves.map(function (m) {
      return {
        x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1,
        z: m.z, w: m.width,
        feature: m.feature, obj: m.objectId, layer: m.layer,
        mv: m
      };
    });
    // The reference tool's centroid, verbatim: the mean of every segment
    // endpoint, not the bounding box. Kept because the framing is its framing.
    var cx = 0, cy = 0;
    segs.forEach(function (s) { cx += s.x0 + s.x1; cy += s.y0 + s.y1; });
    var n2 = segs.length * 2 || 1;

    return {
      kind: 'toolpath',
      name: filename,
      segments: segs,
      parsed: res.parsed,
      objects: null,
      cx: cx / n2,
      cy: cy / n2,
      unit: 'segment'
    };
  }

  /** A plain mesh: one group per build object, triangles as read. */
  function meshDoc(filename, objects) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    objects.forEach(function (o) {
      var p = o.positions;
      // Triangle centroids, once, so the capture box never re-derives them.
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
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxY > maxY) maxY = b.maxY;
    });
    return {
      kind: 'mesh',
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
  var defaultH = 1.0;         // flat by default - a thin slab, not a tall cube
  var currentSelection = [];  // segments (toolpath) or objects (mesh)
  var selectionSource = 'box';

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

    var raycaster = new THREE.Raycaster();
    raycaster.params.Line.threshold = 0.6;

    view = {
      scene: scene, camera: camera, renderer: renderer, controls: controls,
      host: host,
      overviewGroup: overviewGroup, detailGroup: detailGroup,
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
    return view;
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
    if (!doc) return;

    if (doc.kind === 'toolpath') {
      var byFeature = {};
      doc.segments.forEach(function (s) {
        if (!byFeature[s.feature]) byFeature[s.feature] = [];
        byFeature[s.feature].push(s);
      });
      doc.groups = byFeature;
      Object.keys(byFeature).forEach(function (feature, gi) {
        var segs = byFeature[feature];
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
        v.overviewMeshes[feature] = mesh;
        v.overviewGroup.add(mesh);
      });
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
        color: colorForGroup(o.name, gi), metalness: 0.05, roughness: 0.4
      }));
      mesh.userData.feature = o.name;
      v.overviewMeshes[o.name] = mesh;
      v.overviewGroup.add(mesh);
    });
    doc.groups = byObject;
  }

  // --- selection boxes ------------------------------------------------------
  // each is { point, r (horizontal half-extent), h (vertical half-extent),
  //           boxMesh, edges, handle, heightHandle }

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

    v.scene.add(boxMesh); v.scene.add(handle); v.scene.add(heightHandle);
    return { boxMesh: boxMesh, edges: edges, handle: handle, heightHandle: heightHandle };
  }

  function updateBoxTransform(b) {
    b.boxMesh.position.copy(b.point);
    b.boxMesh.scale.set(b.r * 2, b.h * 2, b.r * 2);
    b.handle.position.copy(b.point);
    b.handle.scale.setScalar(Math.max(0.35, b.r * 0.1));
    b.heightHandle.position.set(b.point.x, b.point.y + b.h, b.point.z);
    b.heightHandle.scale.setScalar(Math.max(0.3, b.r * 0.08));
  }

  function addBall(point, r, h) {
    var b = Object.assign({ point: point.clone(), r: r, h: h }, makeBoxVisuals());
    updateBoxTransform(b);
    balls.push(b);
    return b;
  }

  function removeAllBalls() {
    balls.forEach(function (b) {
      view.scene.remove(b.boxMesh); view.scene.remove(b.handle); view.scene.remove(b.heightHandle);
      disposeTree(b.boxMesh); disposeTree(b.handle); disposeTree(b.heightHandle);
    });
    balls.length = 0;
  }

  /** The capture boxes as G-code-space centres and extents. */
  function gcodeBoxes() {
    return balls.map(function (b) {
      // Inverse of toThree: three (x, y, z) -> gcode (x + cx, -z + cy, y)
      return { gx: b.point.x + doc.cx, gy: -b.point.z + doc.cy, gz: b.point.y, r: b.r, h: b.h };
    });
  }

  /**
   * The reference tool's capture predicate, unchanged:
   *     |mx - gx| <= r && |my - gy| <= r && |mz - gz| <= h
   * `r` is the horizontal half-extent and `h` the vertical one, which is the
   * whole point of the box - a sphere reaching 5 mm across the plate also
   * reaches 5 mm up, and that is twenty layers.
   */
  function inBox(b, mx, my, mz) {
    return Math.abs(mx - b.gx) <= b.r && Math.abs(my - b.gy) <= b.r && Math.abs(mz - b.gz) <= b.h;
  }

  function selectByBox() {
    var boxes = gcodeBoxes();
    if (!boxes.length) return [];
    if (doc.kind === 'toolpath') {
      return doc.segments.filter(function (s) {
        var mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2, mz = s.z;
        return boxes.some(function (b) { return inBox(b, mx, my, mz); });
      });
    }
    // Mesh: whole build objects, not loose triangles. An object is taken when
    // the box holds any of its triangle centroids. See docs/GCODE-MICROSCOPE.md
    // for why the granularity is the object and not the triangle.
    return doc.objects.filter(function (o) {
      var hit = boxes.filter(function (b) {
        return o.bounds.minX <= b.gx + b.r && o.bounds.maxX >= b.gx - b.r &&
               o.bounds.minY <= b.gy + b.r && o.bounds.maxY >= b.gy - b.r &&
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
        currentSelection = [];
        info('No boxes placed yet.');
        syncExportRow();
        return;
      }
      currentSelection = selectByBox();
    }
    describeSelection();
    syncExportRow();
  }

  function describeSelection() {
    if (!currentSelection.length) {
      info(selectionSource === 'layer'
        ? 'That layer holds nothing.'
        : '<b>' + balls.length + ' box(es)</b>, nothing caught.');
      return;
    }
    if (doc.kind === 'toolpath') {
      var layers = {};
      currentSelection.forEach(function (s) { layers[s.layer] = 1; });
      var keys = Object.keys(layers).map(Number).sort(function (a, b) { return a - b; });
      info((selectionSource === 'layer'
              ? '<b>whole layer</b>, '
              : '<b>' + balls.length + ' box(es)</b>, ') +
           '<b>' + currentSelection.length + ' segment(s)</b> total<br>' +
           'across ' + keys.length + ' layer(s): ' + keys.join(', '));
      return;
    }
    var tris = currentSelection.reduce(function (a, o) { return a + o.triangles; }, 0);
    info('<b>' + balls.length + ' box(es)</b>, <b>' + currentSelection.length +
         ' object(s)</b>, ' + tris + ' triangle(s)<br>' +
         currentSelection.map(function (o) { return o.name; }).join(', '));
  }

  function applyFeatureVisibility() {
    var v = view;
    Object.keys(v.overviewMeshes).forEach(function (name) {
      v.overviewMeshes[name].visible = !HIDDEN.has(name) && !v.detailGroup.visible;
    });
    v.detailGroup.children.forEach(function (mesh) {
      mesh.visible = !HIDDEN.has(mesh.userData.feature);
    });
  }

  function buildLegend() {
    var legend = $('ms-legend');
    if (!legend) return;
    legend.innerHTML = '';
    if (!doc) return;
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
      label.textContent = name + ' (' + count + unit + ')';
      item.appendChild(swatch); item.appendChild(label);
      item.addEventListener('click', function () {
        if (HIDDEN.has(name)) HIDDEN.delete(name); else HIDDEN.add(name);
        buildLegend();
        applyFeatureVisibility();
      });
      legend.appendChild(item);
    });
  }

  // --- viewport interaction -------------------------------------------------

  function setMode(newMode) {
    mode = newMode;
    var o = $('ms-mode-orbit'), s = $('ms-mode-select');
    if (o) o.classList.toggle('active', mode === 'orbit');
    if (s) s.classList.toggle('active', mode === 'select');
    var ctl = $('ms-select-controls');
    if (ctl) ctl.style.display = mode === 'select' ? 'block' : 'none';
    var hint = $('ms-hint-badge');
    if (hint) {
      hint.textContent = mode === 'select'
        ? 'Click empty space to drop a flat box. Drag its blue centre dot to move it, a side to resize the footprint, the orange top dot to set how thick it is.'
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

      // priority: centre handle (move) > height handle (thickness) > box face
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
      var surfaceHits = v.dragRaycaster.intersectObjects(balls.map(function (b) { return b.boxMesh; }));
      if (surfaceHits.length > 0) {
        var i3 = balls.findIndex(function (b) { return b.boxMesh === surfaceHits[0].object; });
        v.dragState = { type: 'resizeR', ballIndex: i3 };
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
      } else if (v.dragState.type === 'resizeR') {
        // footprint resize: horizontal distance only
        var flat = Math.hypot(hit.x - ball.point.x, hit.z - ball.point.z);
        ball.r = Math.max(0.3, Math.min(60, flat));
        defaultR = ball.r;
        updateBoxTransform(ball);
      }
      selectionSource = 'box';
      computeSelectionInfo();
    });

    window.addEventListener('pointerup', function () {
      if (v.dragState) { v.dragState = null; v.controls.enabled = true; }
    });

    el.addEventListener('pointerup', function (e) {
      if (mode !== 'select' || !doc) return;
      if (v.dragState) return;                       // was a move/resize drag
      if (!v.mouseDownPos) return;
      if (Math.hypot(e.clientX - v.mouseDownPos[0], e.clientY - v.mouseDownPos[1]) > 4) return;

      var p = ndc(e);
      v.mouse.set(p[0], p[1]);
      v.raycaster.setFromCamera(v.mouse, v.camera);
      var targets = Object.keys(v.overviewMeshes)
        .map(function (k) { return v.overviewMeshes[k]; })
        .filter(function (m) { return m.visible; });
      var hits = v.raycaster.intersectObjects(targets);
      if (hits.length === 0) return;

      addBall(hits[0].point.clone(), defaultR, defaultH);
      selectionSource = 'box';
      computeSelectionInfo();
    });
  }

  // --- Isolate / Back -------------------------------------------------------

  function isolate() {
    if (!currentSelection.length) return false;
    var v = view;
    clearGroup(v.detailGroup);

    if (doc.kind === 'toolpath') {
      var bySel = {};
      currentSelection.forEach(function (s) {
        if (!bySel[s.feature]) bySel[s.feature] = [];
        bySel[s.feature].push(s);
      });
      Object.keys(bySel).forEach(function (feature, gi) {
        var segs = bySel[feature];
        var dummy = new THREE.Object3D();
        var geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
        var inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
          color: new THREE.Color(colorForGroup(feature, gi))
        }), segs.length);
        segs.forEach(function (s, i) {
          var p0 = toThree(s.x0 - doc.cx, s.y0 - doc.cy, s.z);
          var p1 = toThree(s.x1 - doc.cx, s.y1 - doc.cy, s.z);
          var mid = p0.clone().add(p1).multiplyScalar(0.5);
          var dir = p1.clone().sub(p0);
          var len = dir.length() || 0.001;
          dummy.position.copy(mid);
          dummy.scale.set(s.w / 2, len, s.w / 2);
          dummy.up.set(0, 1, 0);
          dummy.quaternion.copy(new THREE.Quaternion()
            .setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.userData.feature = feature;
        v.detailGroup.add(inst);
      });
    } else {
      currentSelection.forEach(function (o, gi) {
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.positions), 3));
        geo.translate(-doc.cx, -doc.cy, 0);
        geo.rotateX(-Math.PI / 2);
        geo.computeVertexNormals();
        var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: colorForGroup(o.name, gi), metalness: 0.05, roughness: 0.4
        }));
        mesh.userData.feature = o.name;
        v.detailGroup.add(mesh);
      });
    }

    v.overviewGroup.visible = false;
    v.detailGroup.visible = true;
    balls.forEach(function (b) {
      b.boxMesh.visible = false; b.handle.visible = false; b.heightHandle.visible = false;
    });
    badge('Detail: ' + currentSelection.length + ' ' +
          (doc.kind === 'toolpath' ? 'segments' : 'object(s)'));
    show('ms-detail-controls', true);
    show('ms-select-controls', false);

    // The reference tool only re-TARGETS here, on the centroid of the boxes,
    // and leaves the camera where the whole part put it. That is the whole
    // part's zoom, which on a plate of twelve pieces leaves one isolated
    // support interface a thumbnail in the middle of the grid. Isolate is the
    // zoom - so frame the selection itself, and fall back to the reference
    // tool's target when there is nothing measurable to frame.
    var selBox = selectionBox();
    if (selBox) {
      frameBox(selBox);
    } else if (balls.length > 0) {
      var centre = new THREE.Vector3();
      balls.forEach(function (b) { centre.add(b.point); });
      v.controls.target.copy(centre.divideScalar(balls.length));
    }
    applyFeatureVisibility();
    return true;
  }

  function back() {
    var v = view;
    v.detailGroup.visible = false;
    v.overviewGroup.visible = true;
    frame();                      // Isolate zoomed in; Back is the way out of that
    balls.forEach(function (b) {
      b.boxMesh.visible = true; b.handle.visible = true; b.heightHandle.visible = true;
    });
    badge('Whole part');
    show('ms-detail-controls', false);
    show('ms-select-controls', mode === 'select');
    applyFeatureVisibility();
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
    selectionSource = 'layer';
    currentSelection = doc.segments.filter(function (s) { return keep[s.mv.index] === 1; });
    doc.layerIndex = li;
    describeSelection();
    syncExportRow();
    syncLayerRow();
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
  function microscopeGeometry() {
    if (!doc || !currentSelection.length) return null;
    var positions;
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
      var what = currentSelection.length === 1
        ? currentSelection[0].name
        : currentSelection.length + ' ' + (doc.source === 'plate' ? 'pieces' : 'objects');
      // A piece read off the plate already carries the plate's own name for
      // it; prefixing "Plate - " onto that says nothing and reads worse.
      return doc.source === 'plate' ? what : base + ' - ' + what;
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
    var iso = $('ms-btn-isolate');
    if (iso) iso.disabled = !currentSelection.length;
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

  /** Put the camera where the loaded file is actually visible. */
  function frame() {
    var v = view;
    var box = new THREE.Box3();
    v.overviewGroup.children.forEach(function (c) {
      c.geometry.computeBoundingBox();
      box.union(c.geometry.boundingBox.clone().applyMatrix4(c.matrixWorld));
    });
    frameBox(box);
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
    v.controls.target.copy(centre);
    v.camera.position.set(centre.x + step, centre.y + step, centre.z + step);
    v.camera.near = Math.max(0.01, span / 1000);
    v.camera.far = Math.max(span, dist) * 100;
    v.camera.updateProjectionMatrix();
    v.controls.update();
  }

  function open(d) {
    if (!buildWorld()) { say('Microscope failed to start - check console', true); return null; }
    doc = d;
    HIDDEN = new Set(doc.kind === 'toolpath' ? ['Travel'] : []);
    removeAllBalls();
    currentSelection = [];
    selectionSource = 'box';
    clearGroup(view.detailGroup);
    view.detailGroup.visible = false;
    view.overviewGroup.visible = true;
    buildOverview();
    buildLegend();
    applyFeatureVisibility();
    frame();
    badge('Whole part');
    show('ms-detail-controls', false);
    setMode('select');
    syncHeader();
    syncLayerRow();
    info(doc.kind === 'toolpath'
      ? 'Click the model to drop a capture box, or take a whole layer.'
      : ('Click a ' + (doc.source === 'plate' ? 'piece' : 'part') +
         ' to drop a capture box over it.'));
    syncExportRow();
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
    frame();
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
    buildLegend();
    syncHeader();
    syncLayerRow();
    syncExportRow();
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
    bind('ms-btn-isolate', 'click', isolate);
    bind('ms-btn-back', 'click', back);
    bind('ms-btn-export-plate', 'click', exportToPlate);
    bind('ms-btn-export-stl', 'click', exportAsSTL);
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
        if (ev.key === 'Escape') { close(); ev.preventDefault(); }
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

  return {
    mount: mount,
    open: openPanel,
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
    addBoxAt: function (gx, gy, gz, r, h) {
      // A capture box placed by G-code coordinates rather than by a click, so a
      // check can drive the same selection a drag produces.
      if (!doc || !buildWorld()) return null;
      var p = toThree(gx - doc.cx, gy - doc.cy, gz);
      var b = addBall(p, r != null ? r : defaultR, h != null ? h : defaultH);
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
    selectLayer: selectLayer,
    selection: function () { return currentSelection.slice(); },
    selectionSource: function () { return selectionSource; },
    geometry: microscopeGeometry,
    exportLabel: function () { return doc && currentSelection.length ? exportLabel() : null; },
    exportToPlate: exportToPlate,
    exportAsSTL: exportAsSTL,
    isolate: isolate,
    back: back,
    layerCount: layerCount,
    hidden: function () { return HIDDEN ? Array.from(HIDDEN) : []; },
    groups: function () { return doc ? Object.keys(doc.groups) : []; },
    getDoc: function () { return doc; },
    getView: function () { return view; }
  };
})();

if (typeof window !== 'undefined') window.NSO_MICROSCOPE = NSO_MICROSCOPE;
