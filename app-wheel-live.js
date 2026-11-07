/* ============================================================
   Pottery Wheel - the live sliders.

   THE PIECE IS A RECIPE (app-wheel.js, "7g. THE RECIPE"), and every slider is
   one live value in it. Nothing is baked into the piece, so nothing is ever shut
   off: the form is rebuilt from the ball, in the order a potter works, whenever
   any slider moves.

     Starter Ball   drops the ball (25 mm radius unless Scale says otherwise) and
                    starts a recipe on it
     Scale          the size of the ball - at any time, under everything else
     W              the wall: how thin the disc may press and the walls open
     Thick          press the ball flat (the top comes down, the diameter grows)
     Deep           push in to open it (the clay rises into walls)
     Lip            lift the edge of a pressed plate into a rim, this high
     Lip at         where the lift starts, as a percentage of the plate's radius
     Flare          how long the transition is, as a percentage of the lifted part
     Pull at        where on the piece, as a percentage of its height
     Pull           how far out (or in) the wall goes there
     Soft           how wide the pull spreads, as a percentage of the height
     Trim           take this much off the base
     Rim +          add height at the rim (needs a straight wall)

   drag a slider   the piece itself changes, live, as a PREVIEW: nothing is set,
                   and the Undo stack does not move
   let go          that is Set: one Undo step. The RECIPE stays editable - the next
                   drag, on any slider, starts from the ball again
   Escape          puts the preview away

   THERE IS NOTHING TO TYPE INTO. Each slider is a label, the track and what it
   says (the read-out), on one row; the number is the slider's own, through the
   shared helper's optional-box form (app-live-slider.js).

   A LIMIT IS NOT A REFUSAL. A slider the current shape cannot fully honour (Deep
   on a 3 mm disc, a Pull that would take the wall under the nozzle floor, Rim +
   on a curved wall) is CLAMPED to what it can do and the read-out says so - the
   slider is never disabled. Each slider's range follows what is upstream of it
   (Deep's maximum depends on how far Thick has pressed), and is re-read on every
   preview.

   THE PREVIEW NEVER TOUCHES THE PIECE. The placed mesh's geometry is swapped for
   a throwaway one (Pull's own mechanism) with its bottom kept where the real
   piece's bottom is, m.rawTris is untouched, and ending the preview puts the
   original geometry back. A new ball, Escape, the menu closing, or anything else
   changing the piece ends it first (NSO_wheelUI.end).
   ============================================================ */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof NSO_wheelBuild !== 'function') return;

  function $(id) { return document.getElementById(id); }

  var DEFS = {};            // by key
  var handles = {};         // nsoLiveSlider handles, by key
  var LIVE = null;          // the preview in flight: { mesh, origGeo, geo, origH }
  var draft = null;         // uncommitted edits to the recipe, between a drag and its release
  var pending = NSO_wheelNewRecipe({});   // the recipe the sliders hold while no piece is on the wheel
  var lastRanges = null;

  function trim(x, step) {
    var st = String(step || 0.1), dot = st.indexOf('.');
    var d = dot < 0 ? 0 : st.length - dot - 1;
    var k = Math.pow(10, Math.max(d, 1));
    return String(Math.round(x * k) / k);
  }
  function sliderVal(d) { var v = parseFloat(($(d.slider) || {}).value); return isFinite(v) ? v : undefined; }

  /* ------------------------------------------------------------ read-out */
  function readout(text, bad) {
    var el = $('wheel-readout');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('carve-bad', !!bad);
  }

  function describe(b, head) {
    var rMax = 0;
    for (var i = 0; i < b.piece.outer.length; i++) if (b.piece.outer[i].r > rMax) rMax = b.piece.outer[i].r;
    if (b.piece.inner) for (i = 0; i < b.piece.inner.length; i++) if (b.piece.inner[i].r > rMax) rMax = b.piece.inner[i].r;
    var line = (head ? head + ' ' : '') + 'Ø' + (2 * rMax).toFixed(1) + ' × ' + NSO_wheelHeightOf(b.piece).toFixed(1) + ' mm';
    var st = NSO_wheelStatus(b.piece, line);
    return b.notes.length ? st + ' - ' + b.notes.join('; ') : st;
  }

  /* ------------------------------------------------------------ the preview */
  function modelNow() { return NSO_wheelHome ? NSO_wheelModel() : null; }

  function entryOf(m) {
    if (!m || typeof state === 'undefined' || !state.placed) return null;
    for (var i = 0; i < state.placed.length; i++) {
      if (state.placed[i] && state.placed[i].sourceId === m.id) return state.placed[i];
    }
    return null;
  }

  function end() {
    var L = LIVE;
    LIVE = null;
    draft = null;
    if (!L) return;
    var restored = false;
    if (L.mesh && L.geo && L.mesh.geometry === L.geo && L.origGeo) { L.mesh.geometry = L.origGeo; restored = true; }
    if (L.geo) L.geo.dispose();
    /* The white edge follows the geometry: put it back on the original (the house
       edge cache has it, so this is a lookup, not a rebuild). */
    if (restored && L.entry && typeof refreshOutline === 'function') refreshOutline(L.entry);
    placeHandles();
  }

  /* The throwaway geometry for a piece of the wheel, with its bottom where the
     real piece's bottom is: a display geometry is centred on its own bounding
     box, so a piece taller or shorter than the real one moves by half the
     difference. */
  function previewGeometry(piece, origH) {
    var geo = rawResultToDisplayGeometry(NSO_wheelRevolve(piece));
    var bb = geo.boundingBox;
    geo.translate(0, ((bb.max.y - bb.min.y) - origH) / 2, 0);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  function draw(piece, m) {
    var e = entryOf(m);
    if (!e || !e.mesh) return false;
    if (LIVE && LIVE.mesh !== e.mesh) { var keep = draft; end(); draft = keep; }
    if (!LIVE) LIVE = { mesh: e.mesh, entry: e, origGeo: e.mesh.geometry, geo: null, origH: m.size.y };
    var geo = previewGeometry(piece, LIVE.origH);
    var old = LIVE.geo;
    NSO_wheelWear(geo, piece);          // the white edge is drawn from the piece's own profile
    LIVE.mesh.geometry = geo;
    LIVE.geo = geo;
    LIVE.piece = piece;                 // the drag handles sit on the shape being shown
    if (old) old.dispose();
    /* THE WHITE EDGE STAYS ON, AND ON THE SHAPE YOU ARE SEEING. It is a child
       line built from the mesh's geometry, so a swapped geometry used to leave the
       old piece's edge hanging there; the house refreshOutline rebuilds it for the
       preview (and caches it on the throwaway geometry). */
    if (typeof refreshOutline === 'function') refreshOutline(e);
    return true;
  }

  /* ------------------------------------------------------------ the sliders */
  function define(key, d) { d.key = key; DEFS[key] = d; }

  define('scale', { slider: 'rng-wheel-scale', read: 'out-wheel-scale', unit: ' mm',
    fmt: function (v) { return v === null ? '—' : 'Ø' + trim(2 * v, 1) + ' mm'; },
    get: function (r) { return r.ball.ballRadius || NSO_WHEEL_DEFAULT_BALL_RADIUS; },
    put: function (r, v) { r.ball.ballRadius = v > 0 ? v : undefined; } });
  define('wall', { slider: 'rng-wheel-wall', read: 'out-wheel-wall', unit: ' mm',
    get: function (r) { return r.ball.wall || 3; },
    put: function (r, v) { r.ball.wall = v > 0 ? v : undefined; } });
  define('thick', { slider: 'rng-wheel-flat', read: 'out-wheel-flat', unit: ' mm',
    get: function (r, R) { return r.thick == null ? (R && R.thick ? R.thick.max : 0) : r.thick; },
    put: function (r, v, R) { r.thick = (R && R.thick && v >= R.thick.max - 0.05) ? null : v; } });
  define('depth', { slider: 'rng-wheel-depth', read: 'out-wheel-depth', unit: ' mm',
    get: function (r) { return r.depth || 0; },
    put: function (r, v) { r.depth = v < 0.05 ? 0 : v; } });
  define('lip', { slider: 'rng-wheel-lip', read: 'out-wheel-lip', unit: ' mm',
    get: function (r) { return r.lip ? r.lip.h : 0; },
    put: function (r, v) { r.lip = r.lip || { h: 0, at: 0.6, flare: 0.5 }; r.lip.h = v < 0.05 ? 0 : v; } });
  define('lipat', { slider: 'rng-wheel-lip-at', read: 'out-wheel-lip-at', unit: ' %',
    get: function (r) { return Math.round((r.lip && r.lip.at != null ? r.lip.at : 0.6) * 100); },
    put: function (r, v) { r.lip = r.lip || { h: 0, at: 0.6, flare: 0.5 }; r.lip.at = v / 100; } });
  define('flare', { slider: 'rng-wheel-flare', read: 'out-wheel-flare', unit: ' %',
    get: function (r) { return Math.round((r.lip && r.lip.flare != null ? r.lip.flare : 0.5) * 100); },
    put: function (r, v) { r.lip = r.lip || { h: 0, at: 0.6, flare: 0.5 }; r.lip.flare = v / 100; } });
  define('pullz', { slider: 'rng-wheel-pull-z', read: 'out-wheel-pull-z', unit: ' %',
    get: function (r) { return Math.round((r.pull.z == null ? 0.5 : r.pull.z) * 100); },
    put: function (r, v) { r.pull.z = v / 100; } });
  define('pulldr', { slider: 'rng-wheel-pull-dr', read: 'out-wheel-pull-dr', unit: ' mm',
    fmt: function (v) { return v === null ? '—' : (v > 0 ? '+' : '') + trim(v, 0.5) + ' mm'; },
    get: function (r) { return r.pull.dr || 0; },
    put: function (r, v) { r.pull.dr = v; } });
  define('wide', { slider: 'rng-wheel-soft', read: 'out-wheel-soft', unit: ' %',
    get: function (r) { return Math.round((r.pull.wide == null ? 0.4 : r.pull.wide) * 100); },
    put: function (r, v) { r.pull.wide = v / 100; } });
  define('trim', { slider: 'rng-wheel-trim', read: 'out-wheel-trim', unit: ' mm',
    get: function (r) { return r.trim || 0; },
    put: function (r, v) { r.trim = v < 0.05 ? 0 : v; } });
  define('rim', { slider: 'rng-wheel-rim', read: 'out-wheel-rim', unit: ' mm',
    get: function (r) { return r.rim || 0; },
    put: function (r, v) { r.rim = v < 0.05 ? 0 : v; } });

  function paintRead(d) {
    var read = $(d.read), slider = $(d.slider);
    if (!read || !slider) return;
    var v = parseFloat(slider.value);
    read.textContent = d.fmt ? d.fmt(isFinite(v) ? v : null) : (isFinite(v) ? trim(v, slider.step) + d.unit : '—');
  }

  /* A slider's range, from the build that has just been done. Never disables:
     a slider that has nothing to do right now sits at its end, with the reason
     as its tooltip. */
  function range(d, min, max, step, why) {
    var slider = $(d.slider);
    if (!slider) return;
    if (!(max > min)) max = min + step;
    slider.min = String(min); slider.max = String(max); slider.step = String(step);
    if (slider.dataset.title === undefined) slider.dataset.title = slider.title || '';
    slider.title = why ? (why + ' - ' + slider.dataset.title) : slider.dataset.title;
  }

  function applyRanges(R) {
    lastRanges = R;
    var th = R.thick || { min: 0, max: 0 };
    range(DEFS.thick, th.min, th.max, 0.1, th.why);
    range(DEFS.depth, 0, R.push ? R.push.max : 0, 0.1, R.push && R.push.max <= 0 ? R.push.why : null);
    range(DEFS.lip, 0, R.lip ? R.lip.max : 0, 0.5, R.lip && R.lip.max <= 0 ? R.lip.why : null);
    var sw = R.pull ? R.pull.swing : 10;
    range(DEFS.pulldr, -sw, sw, 0.5);
    range(DEFS.trim, 0, R.trim ? R.trim.max : 0, 0.1, R.trim && R.trim.max <= 0.1 ? 'nothing to take off the base' : null);
    range(DEFS.rim, 0, R.rim ? R.rim.max : 60, 0.5);
  }

  /* Put every slider (and its read-out) at the recipe's value, clamped into its
     own range. The recipe is the truth; the sliders only say it. */
  function show(recipe, R) {
    Object.keys(DEFS).forEach(function (k) {
      var d = DEFS[k], slider = $(d.slider);
      if (!slider) return;
      var v = d.get(recipe, R);
      var lo = parseFloat(slider.min), hi = parseFloat(slider.max);
      if (isFinite(lo) && isFinite(hi)) v = Math.min(hi, Math.max(lo, v));
      slider.value = String(v);
      paintRead(d);
    });
  }

  function committed() { return NSO_wheelHome ? NSO_wheelHome.recipe : pending; }

  /* Edit the draft (a copy of the committed recipe) from the slider being moved. */
  function readDraft(only) {
    var base = committed();
    if (!draft) draft = NSO_wheelCloneRecipe(base);
    if (only) {
      var v = sliderVal(only);
      if (v !== undefined) only.put(draft, v, lastRanges);
    }
    return draft;
  }

  /* One build of whatever the sliders say now: draw it, say it, re-range. */
  function preview(only) { return runPreview(readDraft(only)); }

  /* The build-and-draw half, on a recipe already edited - by a slider (above) or by a
     handle dragged on the piece (the drag section below). */
  function runPreview(r) {
    var m = modelNow();
    if (NSO_wheelHome) {
      var sync = NSO_wheelSync();
      if (!sync.ok) { end(); readout(sync.reason, true); return; }
      m = sync.model;
      var paint = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
      if (paint > 0) { readout('Pottery Wheel stood down - ' + paint + ' painted face(s). Clear paint to throw.', true); return; }
      NSO_wheelSelect(m);          // the sliders act on the wheel's piece: it is the selected one, so it wears the white edge
    }
    var b = NSO_wheelBuild(r);
    if (!b.ok) { readout(b.reason, true); return; }
    applyRanges(b.ranges);
    if (!m) {
      pending = NSO_wheelCloneRecipe(r);
      readout('Starter ball will be - ' + describe(b, '') + '. Press Starter Ball to drop it.', false);
      return;
    }
    draw(b.piece, m);
    readout('Preview - ' + describe(b, '') + '. Let go to set it.', b.notes.length > 0);
  }

  function set(only) {
    var r = readDraft(only);
    if (!NSO_wheelHome) {                           // nothing on the wheel: the sliders hold the recipe for the next ball
      pending = NSO_wheelCloneRecipe(r); draft = null;
      preview();
      return;
    }
    end();
    var res = NSO_wheelSetRecipe(r, 'On the wheel');
    draft = null;
    refresh();
    if (res && !res.ok) { var st = $('status'); if (st) readout(st.textContent, true); }
  }

  function bind(d) {
    var slider = $(d.slider);
    if (!slider) return;
    var handle = window.nsoLiveSlider
      ? window.nsoLiveSlider.bind({ slider: d.slider, read: d.read, unit: d.unit, onLive: function () { preview(d); } })
      : null;
    handles[d.key] = handle;
    slider.addEventListener('input', function () { paintRead(d); });   // the helper writes value + unit; say it our way after it
    if (!handle) slider.addEventListener('input', function () { preview(d); });   // no helper module: plain and unthrottled
    /* Let go of the slider is Set. */
    slider.addEventListener('change', function () { if (handle) handle.cancel(); set(d); });
    paintRead(d);
  }

  /* ------------------------------------------------------------ dragging on the piece

     Handles on the piece write to the SAME draft recipe the sliders do, through the same
     preview and the same Set, so a drag is one Undo step and the sliders move with it.

       blue ball    on the top face of a ball or plate: drag DOWN to press it (Thick);
                    hold Shift to open it instead (Deep)
       cyan ball    on the cavity floor of an opened piece: drag down to go deeper (Deep)
       yellow ball  on the wall at the Pull height: drag OUT or IN to pull (Pull), UP or
                    DOWN to move where (Pull at)
       green ball   on a pressed plate's rim: drag UP to lift it (Lip)

     They are round on the screen whatever the zoom, drawn on top, and picked by distance
     from the cursor (the picked one wins; where two would sit on top of each other the
     wall one steps aside). They sit on the camera's right-hand side of the piece, so a
     radial drag runs along the screen's x; the mouse is turned into millimetres through
     the camera's own projection at the handle (a 2x2 solve), so it holds from any angle.
     The orbit is switched off for the length of a drag. The handles follow the camera
     through OrbitControls' `change` event and are put away with the menu. */
  var HANDLE_PX = 7, HIT_PX = 14;
  var HANDLE_COLOR = { thick: 0x38bdf8, deep: 0x22d3ee, wall: 0xfacc15, lip: 0x4ade80 };
  var HANDLE_HINT = {
    thick: 'Drag the blue ball down to press it into a plate (hold Shift to open it instead)',
    deep: 'Drag the cyan ball down to go deeper',
    wall: 'Drag the yellow ball out or in to pull the wall - up or down to move where',
    lip: 'Drag the green ball up to lift the rim'
  };
  var HG = null;            // { group, items: { kind: { mesh, kind, world, alpha, hidden } } }
  var DRAG = null;
  var hovered = null;
  var dragBound = false;

  function cv() { return (typeof state !== 'undefined' && state && state.renderer) ? state.renderer.domElement : null; }

  function toScreen(v) {
    var r = cv().getBoundingClientRect();
    var p = v.clone().project(state.camera);
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  }

  /* Where each handle goes on this piece: { kind, r, z, radial } in the profile's own terms. */
  function handleSpecs(piece, recipe) {
    var specs = [], opened = !!piece.inner && piece.ops.indexOf('open') >= 0;
    var top = NSO_wheelTopZ(piece), span = NSO_wheelSpan(piece.outer);
    if (opened) specs.push({ kind: 'deep', r: 0, z: piece.inner[0].z });
    else specs.push({ kind: 'thick', r: 0, z: piece.inner ? piece.inner[0].z : top });
    var zf = (recipe.pull && recipe.pull.z != null) ? recipe.pull.z : 0.5;
    var zw = span.lo + zf * (span.hi - span.lo);
    specs.push({ kind: 'wall', r: NSO_wheelRadiusAt(piece.outer, zw), z: zw, radial: true });
    if (!opened && piece.press && piece.press.c >= piece.press.h) {
      if (piece.inner && piece.ops.indexOf('lip') >= 0) {
        var q = piece.inner[piece.inner.length - 1];
        specs.push({ kind: 'lip', r: q.r, z: q.z, radial: true });
      } else {
        specs.push({ kind: 'lip', r: piece.press.c, z: top, radial: true });
      }
    }
    return specs;
  }

  function removeHandles() {
    if (!HG) return;
    if (HG.group.parent) HG.group.parent.remove(HG.group);
    Object.keys(HG.items).forEach(function (k) {
      var it = HG.items[k];
      if (it.mesh.geometry) it.mesh.geometry.dispose();
      if (it.mesh.material) it.mesh.material.dispose();
    });
    HG = null;
    hovered = null;
    if (cv() && !DRAG) cv().style.cursor = '';
  }

  function placeHandles() {
    try {
      var m = modelNow(), e = m && entryOf(m);
      var piece = (LIVE && LIVE.piece) || NSO_wheelSession;
      if (!menuOpen() || !m || !e || !e.mesh || !piece || !state.camera || !cv()) { removeHandles(); return; }
      var mesh = e.mesh;
      mesh.updateMatrixWorld();
      var g = mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      var bb = g.boundingBox, cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2, y0 = bb.min.y;
      var zLo = piece.outer[0].z;
      /* the camera's right, in the mesh's own frame: a radial drag then runs along the screen's x */
      var right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrixWorld, 0);
      right.y = 0;
      if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
      right.normalize();
      var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      var loc = right.transformDirection(inv);
      var alpha = Math.atan2(-loc.z, loc.x);
      var specs = handleSpecs(piece, DRAG ? DRAG.draftNow() : committed());
      if (!HG) {
        HG = { group: new THREE.Group(), items: {} };
        HG.group.name = 'wheelHandles';
        state.scene.add(HG.group);
      }
      var rect = cv().getBoundingClientRect();
      var have = {};
      specs.forEach(function (sp) {
        have[sp.kind] = true;
        var it = HG.items[sp.kind];
        if (!it) {
          var mat = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR[sp.kind], depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
          var mh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
          mh.renderOrder = 30;
          mh.raycast = function () {};
          HG.group.add(mh);
          it = HG.items[sp.kind] = { mesh: mh, kind: sp.kind };
        }
        var r = sp.radial ? sp.r : 0;
        var local = new THREE.Vector3(cx + r * Math.cos(alpha), y0 + (sp.z - zLo), cz - r * Math.sin(alpha));
        var world = mesh.localToWorld(local);
        it.world = world; it.alpha = alpha; it.hidden = false;
        it.mesh.position.copy(world);
        var dist = state.camera.position.distanceTo(world);
        var wpp = 2 * Math.tan(state.camera.fov * Math.PI / 360) * dist / rect.height;
        var big = (hovered === sp.kind || (DRAG && DRAG.kind === sp.kind)) ? 1.4 : 1;
        it.mesh.scale.setScalar(HANDLE_PX * wpp * big);
      });
      Object.keys(HG.items).forEach(function (k) {
        if (have[k]) return;
        var it = HG.items[k];
        if (it.mesh.parent) it.mesh.parent.remove(it.mesh);
        it.mesh.geometry.dispose(); it.mesh.material.dispose();
        delete HG.items[k];
      });
      /* on a thin plate the wall and the rim are a few pixels apart: the wall steps aside */
      var wall = HG.items.wall;
      if (wall && !(DRAG && DRAG.kind === 'wall')) {
        var sw = toScreen(wall.world);
        ['lip', 'thick', 'deep'].forEach(function (k) {
          var o = HG.items[k];
          if (!o) return;
          var so = toScreen(o.world);
          if (Math.hypot(sw.x - so.x, sw.y - so.y) < 2.2 * HANDLE_PX) wall.hidden = true;
        });
      }
      Object.keys(HG.items).forEach(function (k) { HG.items[k].mesh.visible = !HG.items[k].hidden; });
      if (typeof nsoWakeRender === 'function') nsoWakeRender(200);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[wheel handles]', err);
    }
  }

  function nearestHandle(ev) {
    if (!HG) return null;
    var best = null, bd = HIT_PX;
    Object.keys(HG.items).forEach(function (k) {
      var it = HG.items[k];
      if (it.hidden || !it.world) return;
      var s2 = toScreen(it.world), d = Math.hypot(ev.clientX - s2.x, ev.clientY - s2.y);
      if (d < bd) { bd = d; best = it; }
    });
    return best;
  }

  /* Screen pixels per millimetre along the handle's radial (a) and up (b) directions. */
  function axesAt(it, m) {
    var mesh = entryOf(m).mesh;
    mesh.updateMatrixWorld();
    var P = it.world;
    var Rw = new THREE.Vector3(Math.cos(it.alpha), 0, -Math.sin(it.alpha)).transformDirection(mesh.matrixWorld);
    var Uw = new THREE.Vector3(0, 1, 0).transformDirection(mesh.matrixWorld);
    var s0 = toScreen(P), sR = toScreen(P.clone().add(Rw)), sU = toScreen(P.clone().add(Uw));
    var a = { x: sR.x - s0.x, y: sR.y - s0.y }, b = { x: sU.x - s0.x, y: sU.y - s0.y };
    return { a: a, b: b, det: a.x * b.y - b.x * a.y };
  }

  /* A mouse delta, in millimetres along the handle's radial and up directions, through the
     camera's projection at the handle (Cramer's rule on the 2x2). */
  function toMillimetres(d, dx, dy) {
    if (Math.abs(d.det) < 1e-6) {
      return { rad: dx / Math.max(1e-6, Math.hypot(d.a.x, d.a.y)), up: -dy / Math.max(1e-6, Math.hypot(d.b.x, d.b.y)) };
    }
    return { rad: (dx * d.b.y - d.b.x * dy) / d.det, up: (d.a.x * dy - dx * d.a.y) / d.det };
  }

  function clampTo(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* Edit a fresh copy of the recipe the drag started from - never incrementally, so nothing drifts. */
  function applyDrag(dx, dy) {
    var d = DRAG, mm = toMillimetres(d, dx, dy), r = NSO_wheelCloneRecipe(d.start), R = d.R || {};
    if (d.kind === 'thick' && !d.shift) {
      var th = R.thick || { min: 0, max: 0 };
      var st = d.start.thick == null ? th.max : d.start.thick;
      DEFS.thick.put(r, clampTo(st + mm.up, th.min, th.max), R);
    } else if (d.kind === 'deep' || d.kind === 'thick') {
      var mx = R.push ? R.push.max : 0;
      DEFS.depth.put(r, clampTo((d.start.depth || 0) - mm.up, 0, mx));
    } else if (d.kind === 'wall') {
      var sw = R.pull ? R.pull.swing : 10;
      r.pull.dr = clampTo((d.start.pull.dr || 0) + mm.rad, -sw, sw);
      r.pull.z = clampTo((d.start.pull.z == null ? 0.5 : d.start.pull.z) + mm.up / d.spanH, 0, 1);
    } else if (d.kind === 'lip') {
      var lm = R.lip ? R.lip.max : 0;
      r.lip = r.lip || { h: 0, at: 0.6, flare: 0.5 };
      r.lip.h = clampTo((d.start.lip ? d.start.lip.h : 0) + mm.up, 0, lm);
    }
    draft = r;
  }

  function pump() {
    var d = DRAG;
    if (!d) return;
    d.dirty = false;
    if (d.last) {
      applyDrag(d.last.dx, d.last.dy);
      runPreview(draft);
      show(draft, lastRanges);
      placeHandles();
    }
    if (DRAG !== d) return;
    if (d.dirty) setTimeout(pump, 0); else d.busy = false;
  }

  function dragEnd(commit, ev) {
    var d = DRAG;
    if (!d) return;
    if (commit && d.last) applyDrag(d.last.dx, d.last.dy);
    DRAG = null;
    var c = cv();
    if (c) { try { if (ev && c.releasePointerCapture) c.releasePointerCapture(d.pointerId); } catch (e) { /* synthetic */ } c.style.cursor = ''; }
    if (state.controls) state.controls.enabled = true;
    var moved = d.last && Math.hypot(d.last.dx, d.last.dy) >= 2;
    if (commit && moved) set();
    else { end(); refresh(); }
    placeHandles();
  }

  function onDown(ev) {
    if (ev.button !== 0 || DRAG || !HG) return;
    var it = nearestHandle(ev);
    if (!it) return;
    ev.stopPropagation();
    ev.preventDefault();
    var m = modelNow();
    if (!m) return;
    NSO_wheelSelect(m);
    var ax = axesAt(it, m), a = ax.a, b = ax.b;
    var span = NSO_wheelSpan(NSO_wheelSession.outer);
    DRAG = {
      kind: it.kind, shift: !!ev.shiftKey, start: NSO_wheelCloneRecipe(committed()), R: lastRanges,
      x0: ev.clientX, y0: ev.clientY, a: a, b: b, det: a.x * b.y - b.x * a.y,
      spanH: Math.max(1, span.hi - span.lo), last: null, busy: false, dirty: false, pointerId: ev.pointerId,
      draftNow: function () { return draft || DRAG.start; }
    };
    draft = NSO_wheelCloneRecipe(DRAG.start);
    if (state.controls) state.controls.enabled = false;
    var c = cv();
    try { if (c.setPointerCapture) c.setPointerCapture(ev.pointerId); } catch (err) { /* synthetic */ }
    c.style.cursor = 'grabbing';
    placeHandles();
  }

  function onMove(ev) {
    if (DRAG) {
      DRAG.last = { dx: ev.clientX - DRAG.x0, dy: ev.clientY - DRAG.y0 };
      if (!DRAG.busy) { DRAG.busy = true; setTimeout(pump, 0); } else DRAG.dirty = true;
      return;
    }
    if (!HG || ev.target !== cv()) {
      if (hovered) { hovered = null; if (cv()) cv().style.cursor = ''; placeHandles(); if (!LIVE) refresh(); }
      return;
    }
    var it = nearestHandle(ev), k = it ? it.kind : null;
    if (k === hovered) return;
    hovered = k;
    cv().style.cursor = k ? 'grab' : '';
    placeHandles();
    if (k) readout(HANDLE_HINT[k], false); else if (!LIVE) refresh();
  }

  function bindDrag() {
    if (dragBound || !cv()) return;
    dragBound = true;
    cv().addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', function (ev) { dragEnd(true, ev); });
    window.addEventListener('pointercancel', function (ev) { dragEnd(false, ev); });
    if (state.controls && state.controls.addEventListener) state.controls.addEventListener('change', placeHandles);
    window.addEventListener('resize', placeHandles);
  }

  /* Asked by app-core's press handler (like nsoPullTakesPointer): a press that lands on a handle
     is the wheel's, so the core must not also start moving the piece across the plate. It does its
     own hit test rather than relying on this module's handler having run - the core's runs first
     on the canvas. */
  window.nsoWheelTakesPointer = function (ev) {
    return !!ev && ev.button === 0 && (!!DRAG || !!nearestHandle(ev));
  };

  /* For the checks: where each handle is on the page, in client pixels. */
  function handleScreens() {
    var out = [];
    if (!HG) return out;
    Object.keys(HG.items).forEach(function (k) {
      var it = HG.items[k];
      if (it.hidden || !it.world) return;
      var s2 = toScreen(it.world), ax = axesAt(it, modelNow());
      out.push({ kind: k, x: s2.x, y: s2.y, a: ax.a, b: ax.b });
    });
    return out;
  }

  /* ------------------------------------------------------------ keeping in step */
  function refresh() {
    var r = committed();
    var b = NSO_wheelBuild(r);
    if (b.ok) { applyRanges(b.ranges); }
    show(r, b.ok ? b.ranges : null);
    if (!LIVE) {
      if (NSO_wheelHome && b.ok) readout(describe(b, 'On the wheel -'), b.notes.length > 0);
      else if (b.ok) readout('Press Starter Ball to drop a ball of clay. It will be ' + describe(b, '').replace(/ - .*$/, '') + '.');
      else readout(b.reason, true);
    }
    placeHandles();
  }

  function menuEl() { var b = $('btn-wheel-ball'); return b ? b.closest('details.vp-wheel-menu') : null; }
  function menuOpen() {
    for (var d = menuEl(); d; d = d.parentElement && d.parentElement.closest('details')) if (!d.open) return false;
    return !!menuEl();
  }

  var seen = { home: null, raw: null };
  function watch() {
    bindDrag();
    if (!menuOpen()) { end(); removeHandles(); return; }
    if (LIVE) return;
    var m = NSO_wheelHome ? NSO_wheelModel() : null;
    var raw = m ? m.rawTris : null;
    if (seen.home === NSO_wheelHome && seen.raw === raw) return;
    /* Undo, or another tool, moved the piece under the wheel. */
    if (NSO_wheelHome) NSO_wheelSync();
    var m2 = NSO_wheelHome ? NSO_wheelModel() : null;
    if (m2) NSO_wheelOutline(m2);       // keep the white edge on whatever the piece is now
    seen = { home: NSO_wheelHome, raw: m2 ? m2.rawTris : null };
    refresh();
  }

  /* Flatten and Open are one-click presets: they move their own slider to its
     far end, live, and set it. They bake nothing - drag the slider back. */
  function preset(key, toMax) {
    var d = DEFS[key], slider = $(d.slider);
    if (!slider) return;
    slider.value = String(toMax ? parseFloat(slider.max) : parseFloat(slider.min));
    paintRead(d);
    set(d);
  }

  function wire() {
    Object.keys(DEFS).forEach(function (k) { bind(DEFS[k]); });
    var f = $('btn-wheel-flatten'), o = $('btn-wheel-open');
    if (f) { f.dataset.nsoWired = '1'; f.addEventListener('click', function () { preset('thick', false); }); }
    if (o) { o.dataset.nsoWired = '1'; o.addEventListener('click', function () { preset('depth', true); }); }
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (DRAG) { dragEnd(false); return; }
      if (LIVE || draft) { end(); refresh(); }
    });
    var menu = menuEl();
    if (menu) menu.addEventListener('toggle', function () { if (!menu.open) end(); else refresh(); });
    bindDrag();
    setInterval(watch, 300);
    refresh();
  }

  NSO_wheelUI = { end: end, refresh: function () { seen = { home: null, raw: null }; refresh(); }, handles: handleScreens, place: placeHandles };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
