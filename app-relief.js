/* Picture - the app side of nso_relief.js (Gen+ -> Picture).

   A picture becomes a relief slab: a flat base, a dense heightfield on top,
   heights driven by the image. All of the arithmetic and all of the geometry
   live in nso_relief.js, which is DOM-free and node-tested; what is here is
   the four things only the app can do - read a file through the browser's own
   decoder, read the card, add the piece, and say what happened.

   NO DECODER OF OUR OWN, exactly as app-raster.js: a file input, an ObjectURL
   into an <img>, one drawImage onto a canvas over a white ground (a
   transparent PNG's background is paper), getImageData, and that object goes
   into NSO_Relief.build unconverted. Unlike Trace raster the picture is NOT
   downscaled on the canvas first: the box filter in nso_relief.js is the
   resampler, so a big scan is averaged rather than pre-shrunk by whatever
   filter the browser picks, and the triangle budget - not a pixel cap - is
   what refuses a grid too fine to build.

   THIS ADDS A PIECE AND EDITS NONE, like New stock and Trace raster. It
   arrives through addModelFromZUpGeometry (app-core.js), the one ingest path
   an imported STL takes, so the slab has rawTris exactly as a loaded file
   does and the Brush, Smooth, Cut and both exporters see an ordinary piece.
   One Undo step takes it off again (an 'addModels' entry, the one Extract
   selection pushes) and nothing else on the plate is read or written.

   PAINT SCOPE, THE CREATE PATH: NONE - it reads no existing geometry at all,
   so there is no face for paint to protect. See docs/HANDOFF.md, "Scoping".

   THE LIVE LINE is NSO_Relief.plan(), the same closed-form count build()
   produces, so "~ N triangles" on the card is the number the piece will have.
*/
'use strict';

(function () {
  if (typeof document === 'undefined') return;

  var picture = null;     /* { image: ImageData, name, w, h } once a file is read */

  function el(id) { return document.getElementById(id); }
  function say(t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); }

  function readUI() {
    var num = function (id, d) {
      var e = el(id); if (!e) return d;
      var v = parseFloat(e.value);
      return isFinite(v) ? v : d;
    };
    var D = (typeof NSO_Relief !== 'undefined' && NSO_Relief) ? NSO_Relief.DEFAULTS : {};
    var lv = el('sel-relief-levels');
    var up = el('chk-relief-bright');
    return {
      widthMm: num('inp-relief-width', D.widthMm),
      baseMm: num('inp-relief-base', D.baseMm),
      reliefMm: num('inp-relief-relief', D.reliefMm),
      sampleMm: num('inp-relief-detail', D.sampleMm),
      levels: lv ? (lv.value === 'smooth' ? 'smooth' : parseInt(lv.value, 10)) : D.levels,
      darkIsUp: !(up && up.checked)
    };
  }

  /* The live line under the controls: what Make piece would build. */
  function refresh() {
    var line = el('relief-tris'), btn = el('btn-relief-make');
    if (!line) return null;
    if (!picture) {
      line.textContent = 'Pick a picture';
      if (btn) btn.disabled = true;
      return null;
    }
    var p = NSO_Relief.plan(picture.w, picture.h, readUI());
    if (!p.triangles) {
      line.textContent = p.reason;
      if (btn) btn.disabled = true;
      return p;
    }
    line.textContent = '≈ ' + NSO_Relief.formatCount(p.triangles) + ' triangles';
    line.title = picture.name + ', ' + picture.w + ' x ' + picture.h + ' px - ' +
      NSO_Relief.formatCount(p.samples) + ' samples, ' + p.sizeMm[0].toFixed(1) + ' x ' +
      p.sizeMm[1].toFixed(1) + ' mm, ' + (+p.mmPerPixel.toPrecision(4)) + ' mm/px';
    if (btn) btn.disabled = false;
    return p;
  }

  /* file -> ImageData, full size, on white. cb(err, imageData). */
  function readFile(file, cb) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!(w > 0 && h > 0)) { URL.revokeObjectURL(url); cb('the file decoded to a 0 x 0 image'); return; }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        var id = ctx.getImageData(0, 0, w, h);
        URL.revokeObjectURL(url);
        cb(null, id);
      } catch (err) {
        URL.revokeObjectURL(url);
        cb((err && err.message) || String(err));
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      cb('the browser could not decode ' + (file.name || 'that file') + ' as an image');
    };
    img.src = url;
  }

  function pick(file) {
    if (!file) return;
    say('Reading ' + file.name + '...');
    readFile(file, function (err, id) {
      if (err) {
        say('Picture refused - nothing read (' + err + ')', true);
        return;
      }
      picture = { image: id, name: file.name, w: id.width, h: id.height };
      var nm = el('relief-file-name');
      if (nm) nm.textContent = file.name + ' · ' + id.width + ' x ' + id.height + ' px';
      refresh();
      say('Picture: ' + file.name + ', ' + id.width + ' x ' + id.height + ' px - set the slab, then Make piece');
    });
  }

  /* Build and add. Exposed so a drive check runs the button's own path. */
  function make() {
    if (typeof NSO_Relief === 'undefined' || !NSO_Relief) {
      say('Picture needs nso_relief.js', true); return { ok: false, reason: 'NSO_Relief not loaded' };
    }
    if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
      say('Picture needs the viewport', true); return { ok: false, reason: 'no ingest path' };
    }
    if (!picture) { say('Pick a picture first', true); return { ok: false, reason: 'no picture' }; }

    var r;
    try {
      r = NSO_Relief.build(picture.image, readUI());
    } catch (e) {
      say('Picture failed - nothing added (' + ((e && e.message) || e) + ')', true);
      return { ok: false, reason: (e && e.message) || String(e) };
    }
    if (!r.ok) { say('Picture refused - nothing added: ' + r.reason, true); return r; }

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.rawTris, 3));
    var name = String(picture.name || 'picture').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'picture';
    /* Undo puts the selection and cutter position back as they were BEFORE
       the piece arrived; addModel resets cutT on the way in. */
    var prevEdit = state.editId, prevCut = state.cutT;
    var id = addModelFromZUpGeometry(name + '.stl', g);
    if (id == null) { say('Picture refused - the new piece looked empty', true); return { ok: false, reason: 'addModel refused' }; }
    if (typeof pushUndo === 'function') pushUndo({ type: 'addModels', ids: [id], editId: prevEdit, cutT: prevCut });
    r.modelId = id;
    r.name = name;
    say('Added ' + name + ' - ' + r.describe);
    return r;
  }

  function wire() {
    var btn = el('btn-relief-pick'), inp = el('relief-file'), mk = el('btn-relief-make');
    if (!btn || !inp || !mk || btn.dataset.nsoWired === '1') return;
    btn.dataset.nsoWired = '1';
    btn.addEventListener('click', function () { inp.click(); });
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      inp.value = '';                     /* the same file twice still fires */
      if (f) pick(f);
    });
    mk.addEventListener('click', function () { make(); });
    ['inp-relief-width', 'inp-relief-base', 'inp-relief-relief', 'inp-relief-detail',
     'sel-relief-levels', 'chk-relief-bright'].forEach(function (k) {
      var e = el(k);
      if (!e) return;
      e.addEventListener('input', refresh);
      e.addEventListener('change', refresh);
    });
    refresh();
  }

  window.nsoReliefMake = make;
  window.nsoReliefRefresh = refresh;
  window.nsoReliefPicture = function () {
    return picture ? { name: picture.name, w: picture.w, h: picture.h } : null;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
