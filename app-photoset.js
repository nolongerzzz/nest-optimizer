/* app-photoset.js - the photogrammetry upload onramp's UI.

   The DOM half of the feature. nso_photoset.js holds the contract and every
   verdict; nso_exif.js reads the tags. This file does three things and no
   more: it takes a batch of files, it MEASURES each one (the two pixel
   statistics the contract's checks 6 and 7 want, which need a canvas and so
   cannot live in the pure module), and it draws the report.

   ---------------------------------------------------------------------------
   WHERE THE MEASUREMENTS ARE TAKEN, and why it is not the obvious place
   ---------------------------------------------------------------------------
   The naive implementation downsamples each frame to something small and
   measures that. It would be wrong for the focus statistic, and wrong in the
   direction that matters: the feasibility report's whole finding is that
   defocus is invisible out to a 4 px radius on a 4032 px frame and fatal at
   8 px. Downsample 4032 to 512 and both of those become the same picture.

   So the two statistics are sampled differently, on purpose:

     focus   a CROP_PX square taken from the centre of the frame at NATIVE
             resolution. That is the 100 % zoom the contract's check 6 asks
             the operator for, on the part of the frame the contract's check 7
             says the subject is in.

     fill    the whole frame scaled into SMALL_PX. Subject extent is a global
             property and a small image answers it fine.

   Both are advisory and the report says so. Neither replaces the operator's
   own eye, which is why 'focus.eyes' and 'framing.eyes' remain attestations.

   ---------------------------------------------------------------------------
   OUT OF SCOPE, by name
   ---------------------------------------------------------------------------
   No reconstruction is started from here - no COLMAP, no Meshroom, no hosted
   API. No mesh is produced, scaled, decimated or repaired. No live capture
   guidance. This panel ends at "a validated photo set is confirmed ready",
   and the report's deferred section names the five gates that only a
   reconstruction can answer.
 */
(function () {
  'use strict';

  var CROP_PX = 512;     /* native-resolution centre crop, for the focus statistic */
  var SMALL_PX = 256;    /* whole-frame downsample, for the fill estimate */

  var STATE = { frames: [], attest: {}, report: null, busy: false };

  function $(id) { return document.getElementById(id); }
  function PS() { return window.NSO_PhotoSet; }
  function EX() { return window.NSO_Exif; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /* =====================================================================
     MEASUREMENT
     ===================================================================== */

  /* Rec. 601 luma. The statistics care about structure, not colour, and a
     single channel would throw away the contrast that a red part against a
     grey backdrop actually has. */
  function toGray(imgData) {
    var d = imgData.data, n = imgData.width * imgData.height;
    var out = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    }
    return { width: imgData.width, height: imgData.height, data: out };
  }

  var canvas = null, ctx = null;
  function scratch(w, h) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    canvas.width = w; canvas.height = h;
    return ctx;
  }

  /* A frame descriptor in the shape nso_photoset.grade() takes. Everything
     that cannot be determined comes back null rather than as a guess: the
     report distinguishes "looked and it is fine" from "could not look", and
     that distinction is only worth having if this function honours it. */
  function measure(file, index) {
    var frame = {
      name: file.name || ('frame ' + (index + 1)),
      size: file.size || null,
      pass: PS().guessPass(file.name),
      exif: null, width: null, height: null,
      hash: null, sharpness: null, fill: null
    };

    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      frame.exif = EX().read(bytes);
      var sz = EX().jpegSize(bytes);
      if (sz) { frame.width = sz.width; frame.height = sz.height; }
      return hashOf(bytes);
    }).then(function (h) {
      frame.hash = h;
      /* createImageBitmap is what decodes; if the browser will not decode the
         file, the pixel statistics stand down and the EXIF checks still run. */
      if (typeof createImageBitmap !== 'function') return null;
      return createImageBitmap(file).catch(function () { return null; });
    }).then(function (bmp) {
      if (!bmp) return frame;
      try {
        if (!frame.width || !frame.height) { frame.width = bmp.width; frame.height = bmp.height; }

        /* Focus: a native-resolution centre crop. See the header. */
        var c = Math.min(CROP_PX, bmp.width, bmp.height);
        var cx = Math.max(0, Math.floor((bmp.width - c) / 2));
        var cy = Math.max(0, Math.floor((bmp.height - c) / 2));
        var g = scratch(c, c);
        g.drawImage(bmp, cx, cy, c, c, 0, 0, c, c);
        frame.sharpness = PS().sharpnessOf(toGray(g.getImageData(0, 0, c, c)));

        /* Fill: the whole frame, small. */
        var scale = SMALL_PX / Math.max(bmp.width, bmp.height);
        var sw = Math.max(8, Math.round(bmp.width * scale));
        var sh = Math.max(8, Math.round(bmp.height * scale));
        var g2 = scratch(sw, sh);
        g2.drawImage(bmp, 0, 0, sw, sh);
        frame.fill = PS().subjectFillOf(toGray(g2.getImageData(0, 0, sw, sh)));
      } catch (e) {
        /* A frame the canvas refuses is a finding for the report, not a stop.
           Leaving the statistics null is exactly how that is reported. */
      }
      if (bmp.close) bmp.close();
      return frame;
    }).catch(function () {
      return frame;                     /* an unreadable file is still a frame */
    });
  }

  /* Duplicate detection (check: "a copy of a frame is not a second position")
     needs identity, not cryptography. FNV-1a over the bytes, with the length
     mixed in, is ample: an accidental collision between two real photographs
     is not a thing that happens, and nothing here is a security boundary. */
  function hashOf(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return bytes.length.toString(36) + '-' + h.toString(36);
  }

  /* Files are measured one at a time. A 93-frame set at 4032 x 3024 is about
     a gigabyte of decoded bitmap if they are all in flight at once, and the
     tab dies; sequential decode with an explicit close() keeps one frame
     resident. It is slower and it finishes. */
  function measureAll(files, onProgress) {
    var out = [], i = 0;
    function next() {
      if (i >= files.length) return Promise.resolve(out);
      var n = i++;
      return measure(files[n], n).then(function (f) {
        out.push(f);
        if (onProgress) onProgress(out.length, files.length);
        /* Yield to the event loop so the progress line actually paints. */
        return new Promise(function (r) { setTimeout(r, 0); }).then(next);
      });
    }
    return next();
  }

  /* =====================================================================
     RENDER
     ===================================================================== */
  var STATUS_LABEL = {
    pass: 'PASS', warn: 'WARN', fail: 'FAIL',
    todo: 'CONFIRM', unknown: 'NO DATA', deferred: 'LATER'
  };

  var KIND_SECTIONS = [
    { kinds: ['auto', 'declared'], title: 'Checked from the photographs',
      blurb: 'Decided by the tool. A verdict here is evidence - the machine looked.' },
    { kinds: ['manual'], title: 'Only you can confirm these',
      blurb: 'Nothing in the images settles these, at any cost. Tick what is true; an unticked box blocks "ready" exactly as a failure does.' },
    { kinds: ['deferred'], title: 'Not checked here - needs a reconstruction',
      blurb: 'Section 8.3 of the contract. This onramp runs no reconstruction, so these have no verdict. Listed so the report says what it has not checked.' }
  ];

  function renderVerdict() {
    var v = $('photoset-verdict');
    var r = STATE.report;
    if (!v) return;
    if (!r || r.empty) {
      v.hidden = true;
      return;
    }
    v.hidden = false;
    v.textContent = r.verdict;
    v.className = 'photoset-verdict ' + (r.ready ? (r.counts.warn ? 'is-warn' : 'is-ready') : 'is-blocked');
  }

  function renderCounts(into) {
    var r = STATE.report;
    var row = el('div', 'ps-counts');
    /* [status, count, label, singular label where it differs] */
    var bits = [
      ['pass', r.counts.pass, 'in contract'],
      ['fail', r.counts.fail, 'out of contract'],
      ['warn', r.counts.warn, 'warnings', 'warning'],
      ['todo', r.counts.todo, 'to confirm'],
      ['unknown', r.counts.unknown, 'no data'],
      ['deferred', r.counts.deferred, 'need a reconstruction', 'needs a reconstruction']
    ];
    bits.forEach(function (b) {
      if (!b[1]) return;
      var chip = el('span', 'ps-chip ps-' + b[0]);
      chip.appendChild(el('b', null, b[1]));
      chip.appendChild(document.createTextNode(' ' + (b[1] === 1 && b[3] ? b[3] : b[2])));
      row.appendChild(chip);
    });
    into.appendChild(row);
  }

  function attestationFor(id) {
    var list = PS().ATTESTATIONS;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function renderResult(res) {
    var row = el('div', 'ps-row ps-' + res.status);
    var head = el('div', 'ps-row-head');

    if (res.kind === 'manual') {
      var lab = el('label', 'ps-tick');
      var box = el('input');
      box.type = 'checkbox';
      box.checked = STATE.attest[res.id] === true;
      box.addEventListener('change', function () {
        STATE.attest[res.id] = box.checked;
        regrade();
      });
      lab.appendChild(box);
      lab.appendChild(el('span', null, res.title));
      head.appendChild(lab);
    } else {
      head.appendChild(el('span', 'ps-title', res.title));
    }

    head.appendChild(el('span', 'ps-status', STATUS_LABEL[res.status] || res.status));
    head.appendChild(el('span', 'ps-clause', '§' + res.clause));
    row.appendChild(head);
    row.appendChild(el('p', 'ps-detail', res.detail));

    /* The "why can a machine not do this" sentence is the point of the manual
       section, and the note is the point of the deferred one. Neither is
       decoration; both stay on screen. */
    if (res.why) row.appendChild(el('p', 'ps-why', res.why));
    return row;
  }

  function renderPassAssignment(into) {
    var wrap = el('section', 'ps-section');
    wrap.appendChild(el('h3', null, 'Which frames are which pass'));
    wrap.appendChild(el('p', 'ps-blurb',
      'No photograph records the elevation it was shot at, so the shot list can only be counted once you say. ' +
      'Names that already carry the pass ("ringB_07.jpg") were picked up automatically; check them.'));

    var tools = el('div', 'ps-tools');
    var inOrder = el('button', 'btn btn-secondary', 'Assign in shot-list order');
    inOrder.type = 'button';
    inOrder.title = 'Fill the list top to bottom in the contract\'s order - 24 ring A, 24 ring B, 24 ring C, 4 top, 16 flip, 1 flip top - which is the order the list is shot in.';
    inOrder.addEventListener('click', function () {
      var seq = [];
      PS().CONTRACT.passes.forEach(function (p) {
        for (var k = 0; k < p.frames; k++) seq.push(p.id);
      });
      STATE.frames.forEach(function (f, i) { f.pass = i < seq.length ? seq[i] : 'extra'; });
      regrade();
    });
    var clear = el('button', 'btn btn-ghost', 'Clear assignment');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      STATE.frames.forEach(function (f) { f.pass = null; });
      regrade();
    });
    tools.appendChild(inOrder);
    tools.appendChild(clear);
    wrap.appendChild(tools);

    /* A per-pass tally, which is the thing an operator actually reads while
       fixing an assignment. */
    var tally = el('div', 'ps-tally');
    PS().CONTRACT.passes.forEach(function (p) {
      var n = STATE.frames.filter(function (f) { return f.pass === p.id; }).length;
      var chip = el('span', 'ps-chip ' + (n === p.frames ? 'ps-pass' : 'ps-fail'));
      chip.textContent = p.name + ' ' + n + '/' + p.frames;
      chip.title = p.elevation + ', every ' + p.step + ' deg of azimuth';
      tally.appendChild(chip);
    });
    var un = STATE.frames.filter(function (f) { return !f.pass; }).length;
    var ex = STATE.frames.filter(function (f) { return f.pass === 'extra'; }).length;
    if (un) tally.appendChild(el('span', 'ps-chip ps-todo', un + ' unassigned'));
    if (ex) tally.appendChild(el('span', 'ps-chip ps-deferred', ex + ' detail'));
    wrap.appendChild(tally);

    var list = el('div', 'ps-frames');
    STATE.frames.forEach(function (f) {
      var row = el('div', 'ps-frame');
      row.appendChild(el('span', 'ps-frame-name', f.name));
      var sel = el('select', 'ps-frame-pass');
      var none = el('option', null, '- unassigned -');
      none.value = '';
      sel.appendChild(none);
      PS().CONTRACT.passes.forEach(function (p) {
        var o = el('option', null, p.name);
        o.value = p.id;
        sel.appendChild(o);
      });
      var ox = el('option', null, PS().CONTRACT.extra.name);
      ox.value = 'extra';
      sel.appendChild(ox);
      sel.value = f.pass || '';
      sel.addEventListener('change', function () {
        f.pass = sel.value || null;
        regrade();
      });
      row.appendChild(sel);
      list.appendChild(row);
    });
    wrap.appendChild(list);
    into.appendChild(wrap);
  }

  function render() {
    renderVerdict();
    var body = $('photoset-report');
    if (!body) return;
    /* Ticking one attestation regrades and redraws the whole report. Without
       this the reader is thrown back to the top of a 30-row panel on every
       tick, which for a list of eleven boxes is the difference between usable
       and not. */
    var scroll = body.scrollTop;
    var framesEl = body.querySelector('.ps-frames');
    var frameScroll = framesEl ? framesEl.scrollTop : 0;
    body.innerHTML = '';
    var r = STATE.report;
    if (!r || r.empty) {
      body.appendChild(el('p', 'ps-blurb', 'No photographs loaded yet.'));
      return;
    }

    var banner = el('p', 'photoset-verdict ' + (r.ready ? (r.counts.warn ? 'is-warn' : 'is-ready') : 'is-blocked'), r.verdict);
    body.appendChild(banner);
    renderCounts(body);

    var note = el('p', 'ps-blurb',
      'Graded against ' + PS().CONTRACT.doc + ' (' + PS().CONTRACT.total + '-frame shot list). ' +
      '"Ready" means this capture is worth a reconstruction\'s time - not that the reconstruction will succeed.');
    body.appendChild(note);

    renderPassAssignment(body);

    KIND_SECTIONS.forEach(function (sec) {
      var rows = r.results.filter(function (x) { return sec.kinds.indexOf(x.kind) >= 0; });
      if (!rows.length) return;
      var wrap = el('section', 'ps-section');
      wrap.appendChild(el('h3', null, sec.title));
      wrap.appendChild(el('p', 'ps-blurb', sec.blurb));
      rows.forEach(function (res) { wrap.appendChild(renderResult(res)); });
      body.appendChild(wrap);
    });

    body.scrollTop = scroll;
    var again = body.querySelector('.ps-frames');
    if (again) again.scrollTop = frameScroll;
  }

  function regrade() {
    STATE.report = PS().grade({ frames: STATE.frames, attest: STATE.attest });
    render();
    var btn = $('btn-photoset-report');
    if (btn) btn.disabled = !STATE.frames.length;
    var clr = $('btn-photoset-clear');
    if (clr) clr.disabled = !STATE.frames.length;
  }

  function setProgress(text) {
    var p = $('photoset-progress');
    if (!p) return;
    p.hidden = !text;
    p.textContent = text || '';
  }

  function openDrawer(open) {
    var d = $('photoset-drawer');
    if (d) d.hidden = !open;
  }

  /* =====================================================================
     WIRING
     ===================================================================== */
  function init() {
    if (!window.NSO_PhotoSet || !window.NSO_Exif) return;    /* module missing: stay inert */
    var input = $('photoset-input');
    var pick = $('btn-photoset-pick');
    var report = $('btn-photoset-report');
    var clear = $('btn-photoset-clear');
    var close = $('btn-photoset-close');
    if (!input || !pick) return;

    pick.addEventListener('click', function () { input.click(); });

    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) return;
      if (STATE.busy) return;
      STATE.busy = true;
      pick.disabled = true;
      /* Sorted by name, because the shot list is executed in order and
         "assign in shot-list order" is only useful if the order is the
         operator's, not the file picker's. */
      files.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), undefined, { numeric: true }); });
      setProgress('Reading 0 of ' + files.length + '...');
      measureAll(files, function (done, total) {
        setProgress('Reading ' + done + ' of ' + total + '...');
      }).then(function (frames) {
        STATE.frames = frames;
        setProgress('');
        regrade();
        openDrawer(true);
      }).catch(function (e) {
        setProgress('Could not read the photo set: ' + (e && e.message ? e.message : e));
      }).then(function () {
        STATE.busy = false;
        pick.disabled = false;
        input.value = '';                 /* so picking the same batch again fires */
      });
    });

    if (report) report.addEventListener('click', function () { openDrawer(true); });
    if (close) close.addEventListener('click', function () { openDrawer(false); });
    if (clear) clear.addEventListener('click', function () {
      STATE.frames = [];
      STATE.attest = {};
      setProgress('');
      openDrawer(false);
      regrade();                        /* which re-renders the empty report */
    });

    regrade();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* Exposed for the drive check, which runs this panel in a real browser. */
  window.NSO_PhotoSetUI = {
    state: STATE,
    measureAll: measureAll,
    hashOf: hashOf,
    toGray: toGray,
    regrade: regrade,
    CROP_PX: CROP_PX,
    SMALL_PX: SMALL_PX
  };
})();
