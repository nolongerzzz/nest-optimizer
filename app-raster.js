/* Trace raster - the app side of nso_raster_lines.js.
 *
 * nso_raster_lines.js decodes nothing on purpose (see its header): it takes
 * { width, height, data, channels }, which is exactly what a canvas hands back
 * as an ImageData for every format the browser can open - PNG, JPEG, WebP,
 * GIF, BMP. So the upload path is four steps and no decoder: a file input, an
 * ObjectURL into an <img>, one drawImage onto a canvas, getImageData, and that
 * object goes straight into buildFromImage unconverted.
 *
 * This ADDS A NEW PIECE, like Skin patch next to it, and leaves every existing
 * piece alone. Nothing about the loaded scene is read and nothing is replaced.
 *
 * WHY THE PIECE IS FLAGGED NON-SOLID. The traced solid is closed and watertight
 * - the check gates on that - but every wall in it is one extrusion line, 0.42
 * mm, the same figure mesh_validate.py carries as --min-wall. That is what the
 * loose skin patch is flagged for and this is the same object, so it is flagged
 * the same way rather than quietly passing a wall check it only just meets.
 *
 * THE SIZE FIELD IS THE SCALE, and it is the one number the picture cannot
 * supply. A raster has pixels, not millimetres; `mmPerPixel` is a convenience
 * and buildFromImage reports it back so it cannot be mistaken for a measurement.
 * The UI asks for the finished WIDTH in mm instead, because that is the figure
 * a person has in mind, and the scale follows from it and the pixel width.
 */
'use strict';

/* The largest raster we will thin. Zhang-Suen is O(passes x pixels) and a
   phone photo is 12 megapixels, which would hang the tab for a minute for no
   gain: the skeleton of a downscaled copy is the same centreline. Downscaling
   happens on the canvas, with the browser's own filtering. */
var NSO_RASTER_MAX_PX = 1600;

function NSO_rasterOptsFromUI() {
  var g = function (id) { return document.getElementById(id); };
  var num = function (id, d) {
    var el = g(id); if (!el) return d;
    var v = parseFloat(el.value);
    return isFinite(v) ? v : d;
  };
  var inv = g('raster-invert');
  return {
    widthMM: num('raster-size', 30),
    width: num('raster-line-width', 0.42),
    height: num('raster-line-height', 0.3),
    threshold: num('raster-threshold', 128),
    invert: !!(inv && inv.checked),
    simplify: 1.5
  };
}

/* An ImageData from a File, downscaled to fit NSO_RASTER_MAX_PX.
   cb(err, imageData, meta). No decoding of our own - the browser's. */
function NSO_rasterReadFile(file, cb) {
  if (!file) { cb('no file'); return; }
  var url = URL.createObjectURL(file);
  var img = new Image();
  img.onload = function () {
    try {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!(w > 0 && h > 0)) { URL.revokeObjectURL(url); cb('the file decoded to a 0 x 0 image'); return; }
      var k = Math.min(1, NSO_RASTER_MAX_PX / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * k)), chh = Math.max(1, Math.round(h * k));
      var c = document.createElement('canvas');
      c.width = cw; c.height = chh;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      /* a transparent PNG's background must read as PAPER, not as ink: toMask's
         alphaFloor would drop it, but a flattened white ground is what the
         person drew on and what every other format already has */
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, chh);
      ctx.drawImage(img, 0, 0, cw, chh);
      var id = ctx.getImageData(0, 0, cw, chh);
      URL.revokeObjectURL(url);
      cb(null, id, { sourceW: w, sourceH: h, usedW: cw, usedH: chh, scaled: k < 1, name: file.name });
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

/* Trace an ImageData and add the result as a new piece.
   Returns the build result with `modelId` on it, or { ok:false, reason }. */
function NSO_rasterAdd(imageData, opts, meta) {
  opts = opts || {};
  meta = meta || {};
  var say = function (t, err) { if (typeof setStatus === 'function') setStatus(t, err); };
  if (typeof NSO_RasterLines === 'undefined' || !NSO_RasterLines) {
    say('Trace raster module missing', true); return { ok: false, reason: 'NSO_RasterLines not loaded' };
  }
  if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
    say('Trace raster needs the viewport', true); return { ok: false, reason: 'no ingest path' };
  }

  var r = NSO_RasterLines.buildFromImage(imageData, opts);
  if (!r.ok) { say('Trace raster refused - nothing added (' + r.reason + ')', true); return r; }

  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.tris), 3));
  var base = String(meta.name || 'raster').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_');
  var name = 'traced_' + (base || 'raster');
  var id = addModelFromZUpGeometry(name + '.stl', g);
  if (id == null) { say('Trace raster refused - the new piece looked empty', true); return { ok: false, reason: 'addModel refused' }; }
  r.modelId = id;

  var txt = 'Added ' + name + ' - ' + r.describe;
  if (meta.scaled) txt += ' (traced at ' + meta.usedW + ' x ' + meta.usedH + ' from ' + meta.sourceW + ' x ' + meta.sourceH + ')';
  if (r.bridgedPaths) txt += ' - ' + r.bridgedPaths + ' crossing bridge(s) collapsed';
  txt += ' - flagged non-solid: every wall is one ' + r.width + ' mm extrusion line';
  say(txt, !r.closed);

  var m = null, i;
  for (i = 0; i < state.models.length; i++) if (state.models[i].id === id) m = state.models[i];
  if (m && typeof window.nsoNonSolidSet === 'function') {
    window.nsoNonSolidSet(m, true, { noUndo: true, silent: true });
  }
  return r;
}

/* file -> trace -> piece, the whole path the button runs. */
function NSO_rasterAddFromFile(file, opts) {
  var say = function (t, err) { if (typeof setStatus === 'function') setStatus(t, err); };
  say('Tracing ' + (file && file.name ? file.name : 'image') + '...');
  NSO_rasterReadFile(file, function (err, id, meta) {
    if (err) { say('Trace raster refused - nothing added (' + err + ')', true); return; }
    try {
      NSO_rasterAdd(id, opts || NSO_rasterOptsFromUI(), meta);
    } catch (e) {
      console.error('[trace raster]', e);
      say('Trace raster failed - nothing added (' + ((e && e.message) || e) + ')', true);
    }
  });
}

if (typeof document !== 'undefined') {
  (function wireRasterButton() {
    function wire() {
      var btn = document.getElementById('btn-trace-raster');
      var inp = document.getElementById('raster-file');
      if (!btn || !inp || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      /* the button owns the click; the input is the hidden half of it, so the
         control reads as one thing and matches every other button in the row */
      btn.addEventListener('click', function () { inp.click(); });
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        /* cleared so choosing the SAME file twice fires change again */
        inp.value = '';
        if (f) NSO_rasterAddFromFile(f);
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
