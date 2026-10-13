/* Picture - the app side of nso_relief.js (Gen+ -> Picture).

   A picture becomes a relief slab: a flat base, a dense heightfield on top,
   heights driven by the image. All of the arithmetic and all of the geometry
   live in nso_relief.js, which is DOM-free and node-tested; what is here is
   what only the app can do - read a file through the browser's own decoder,
   read the card, hand the slab to G-scope, seat it when it reaches the
   plate, and say what happened.

   NO DECODER OF OUR OWN, exactly as app-raster.js: a file input, an ObjectURL
   into an <img>, one drawImage onto a canvas over a white ground (a
   transparent PNG's background is paper), getImageData, and that object goes
   into NSO_Relief.build unconverted. Unlike Trace raster the picture is NOT
   downscaled on the canvas first: the box filter in nso_relief.js is the
   resampler, so a big scan is averaged rather than pre-shrunk by whatever
   filter the browser picks, and the triangle budget - not a pixel cap - is
   what refuses a grid too fine to build.

   PICTURE -> G-SCOPE -> PLATE. Make piece builds the slab and opens it in
   G-scope through NSO_MICROSCOPE.openObjects - the seam G-scope already had
   for any named Z-up triangle groups - so it is looked at BEFORE it is a
   piece: nothing goes on the plate and nothing goes on the Undo stack. From
   there:
     Back to Picture  closes G-scope and opens this card again. The photo is
                      still in memory and no control here was touched, so
                      every setting is as it was left.
     Make again       replaces the slab G-scope shows. Attempts do not stack.
     Undo (here)      one step back to the previous attempt: that slab goes
                      back into G-scope and its photo and settings come back
                      onto the card. Only the previous one is kept.
     Export to plate  G-scope's own button. The slab arrives through
                      addModelFromZUpGeometry, the one ingest path an imported
                      STL takes, named after the file, with one 'addModels'
                      Undo step - an ordinary piece from then on. G-scope's
                      onPlate hook hands it back here and it is moved to free
                      plate (seat(), below), clear of every placed piece.

   PAINT SCOPE, THE CREATE PATH: NONE - it reads no existing geometry at all,
   so there is no face for paint to protect. See docs/HANDOFF.md, "Scoping".

   THE LIVE LINE is NSO_Relief.plan(), the same closed-form count build()
   produces, so "~ N triangles" on the card is the number the piece will have.
*/
'use strict';

(function () {
  if (typeof document === 'undefined') return;

  var picture = null;     /* { image: ImageData, name, w, h } once a file is read */
  /* The attempt G-scope was handed last, and the one before it - nothing
     older. An attempt is { picture, card, r, name }: the photo, the card's
     raw control values, NSO_Relief.build's result and the piece name. */
  var shown = null, previous = null;

  var CARD = ['inp-relief-width', 'inp-relief-base', 'inp-relief-relief', 'inp-relief-detail',
              'sel-relief-levels', 'chk-relief-bright'];

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

  function isHeic(file) {
    return /\.hei[cf]$/i.test((file && file.name) || '') || /^image\/hei[cf]/i.test((file && file.type) || '');
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
      /* HEIC is what an iPhone saves; only Safari's decoder reads it, and the
         chooser lists it, so a refusal says that rather than "not an image". */
      if (isHeic(file)) cb('this browser can\'t read HEIC photos; export it as JPEG or use Safari');
      else cb('the browser could not decode ' + (file.name || 'that file') + ' as an image');
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
      showName();
      refresh();
      say('Picture: ' + file.name + ', ' + id.width + ' x ' + id.height + ' px - set the slab, then Make piece');
    });
  }

  function showName() {
    var nm = el('relief-file-name');
    if (nm) nm.textContent = picture ? picture.name + ' · ' + picture.w + ' x ' + picture.h + ' px' : '';
  }

  /* The card's controls as they stand, raw, so putting them back is exact. */
  function cardValues() {
    var out = {};
    CARD.forEach(function (k) {
      var e = el(k);
      if (e) out[k] = e.type === 'checkbox' ? e.checked : e.value;
    });
    return out;
  }
  function setCard(v) {
    CARD.forEach(function (k) {
      var e = el(k);
      if (!e || !(k in v)) return;
      if (e.type === 'checkbox') e.checked = !!v[k]; else e.value = v[k];
    });
  }

  function syncUndo() {
    var b = el('btn-relief-undo');
    if (b) b.disabled = !previous;
  }

  /* Gen+ and its Picture card, open - where Back to Picture lands. */
  function openCard() {
    var g = el('menu-gen'), r = el('menu-relief');
    if (g) g.open = true;
    if (r) r.open = true;
  }

  function backToPicture() {
    openCard();
    say('Picture: back to the card - ' + (picture ? picture.name : 'no picture') +
        ', every setting as it was. Make piece again replaces the slab in G-scope.');
  }

  function scope() {
    return (typeof NSO_MICROSCOPE !== 'undefined' && NSO_MICROSCOPE && NSO_MICROSCOPE.openObjects) ? NSO_MICROSCOPE : null;
  }

  /* Hand one attempt to G-scope. The positions are the slab's own Z-up soup,
     exactly what Make piece used to hand the ingest path. */
  function showInScope(a) {
    return scope().openObjects(a.picture.name, [{ name: a.name, positions: a.r.rawTris }], {
      source: 'picture',
      subtitle: 'A relief slab from ' + a.picture.name + ' - not on the plate. Back to Picture to change it; ' +
                'Click to select region, click the slab, then Export to plate to keep it.',
      back: backToPicture,
      backLabel: 'Back to Picture',
      onPlate: seat
    });
  }

  /* ---------------------------------------------------------- free plate */

  /* The spot nearest the plate's middle where `entry`'s footprint sits
     wholly on the bed and at least 4 mm from every other placed piece's.
     nsoFreeSpot (app-core.js) - written here, moved there so Lift shares it. */
  function freeSpot(entry) { return nsoFreeSpot(entry); }

  /* G-scope's onPlate: the slab has just been added (and its Undo step
     pushed); move it to free plate. addModel's own seat marches a new piece
     past the rightmost one by its unturned width, which can land on a
     turned piece and walks off the bed; this does neither. */
  function seat(id) {
    var entry = state.placed.find(function (p) { return p && p.sourceId === id; });
    if (!entry || typeof nsoFreeSpot !== 'function' || typeof applyPlacedXZ !== 'function') return null;
    var at = freeSpot(entry);
    applyPlacedXZ(entry, at.x, at.z);
    if (typeof refreshOutline === 'function') refreshOutline(entry);
    if (!at.onBed) {
      setTimeout(function () {
        say('On the plate, but the bed had no free room for it - it is beside the plate, clear of every piece', true);
      }, 0);
    }
    return at;
  }

  /* Build and show. Exposed so a drive check runs the button's own path. */
  function make() {
    if (typeof NSO_Relief === 'undefined' || !NSO_Relief) {
      say('Picture needs nso_relief.js', true); return { ok: false, reason: 'NSO_Relief not loaded' };
    }
    if (!scope()) { say('Picture needs G-scope', true); return { ok: false, reason: 'no G-scope' }; }
    if (!picture) { say('Pick a picture first', true); return { ok: false, reason: 'no picture' }; }

    var r;
    try {
      r = NSO_Relief.build(picture.image, readUI());
    } catch (e) {
      say('Picture failed - nothing made (' + ((e && e.message) || e) + ')', true);
      return { ok: false, reason: (e && e.message) || String(e) };
    }
    if (!r.ok) { say('Picture refused - nothing made: ' + r.reason, true); return r; }

    var name = String(picture.name || 'picture').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'picture';
    var a = { picture: picture, card: cardValues(), r: r, name: name };
    if (!showInScope(a)) { say('Picture: G-scope could not open the slab - nothing changed', true); return { ok: false, reason: 'G-scope refused' }; }
    if (shown) previous = shown;
    shown = a;
    syncUndo();
    r.name = name;
    say('Picture: ' + name + ' in G-scope, not on the plate - ' + r.describe);
    return r;
  }

  /* One step back: the previous attempt into G-scope, its photo and settings
     onto the card. There is no step after it. */
  function undo() {
    if (!previous) { say('Picture: no previous slab to go back to'); return { ok: false, reason: 'nothing to undo' }; }
    if (!scope() || !showInScope(previous)) { say('Picture: G-scope could not open the previous slab - nothing changed', true); return { ok: false, reason: 'G-scope refused' }; }
    shown = previous;
    previous = null;
    picture = shown.picture;
    setCard(shown.card);
    showName();
    refresh();
    syncUndo();
    say('Picture: back to the previous slab, ' + shown.name + ' - ' + shown.r.describe);
    return { ok: true, name: shown.name };
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
    var un = el('btn-relief-undo');
    if (un) un.addEventListener('click', function () { undo(); });
    CARD.forEach(function (k) {
      var e = el(k);
      if (!e) return;
      e.addEventListener('input', refresh);
      e.addEventListener('change', refresh);
    });
    refresh();
    syncUndo();
  }

  window.nsoReliefMake = make;
  window.nsoReliefUndo = undo;
  window.nsoReliefFreeSpot = freeSpot;
  window.nsoReliefRefresh = refresh;
  window.nsoReliefPicture = function () {
    return picture ? { name: picture.name, w: picture.w, h: picture.h } : null;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
