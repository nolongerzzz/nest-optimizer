/* nso_photoset.js - the photogrammetry capture contract, as a checkable thing.

   Loads as a classic script (window.NSO_PhotoSet) and as a Node module
   (require('../nso_photoset.js')). No DOM, no Three.js, no app state, no
   image decoding - the caller hands in frame descriptors and gets back a
   report.

   ---------------------------------------------------------------------------
   SCOPE, stated first because it is the whole design
   ---------------------------------------------------------------------------
   docs/PHOTOGRAMMETRY-CAPTURE.md is a paper contract written by the
   feasibility spike. This module is the first thing in NSO that reads it. It
   answers exactly one question:

       Is this pile of photographs in contract, and if not, which clause?

   It does NOT reconstruct, does not call COLMAP or Meshroom or a hosted API,
   does not repair or scale or decimate a mesh, and does not guide a capture
   in progress. Those are named and deliberately deferred - see DEFERRED below
   and section 10 of the contract. This module ends at "ready", and "ready"
   means the capture may now be worth a reconstruction's time. It does not
   mean the reconstruction will succeed; section 8.3 of the contract has five
   more gates that only a sparse reconstruction can answer, and they are
   carried here as deferred entries so that the report says what it has not
   checked rather than implying it checked everything.

   ---------------------------------------------------------------------------
   THE THREE KINDS OF CHECK, which is the point of the whole module
   ---------------------------------------------------------------------------
   The contract has 12 numbered checks and a dozen more requirements in prose.
   They are not all the same kind of thing, and pretending they were would be
   the one way to make this feature actively harmful - an operator who is told
   "all green" by a tool that never looked at the lighting will trust a bad
   shoot. So every check declares its kind:

     'auto'      Decidable from the submitted files alone - frame count, EXIF
                 optics, duplicate detection, pixel statistics. The machine
                 looked, and the verdict is evidence.

     'declared'  Decidable once the operator says which frames belong to which
                 pass. Nothing in a photograph records that it was shot at 45
                 degrees of elevation; no EXIF tag carries it and no pixel
                 statistic recovers it. The operator's assignment is an input,
                 and given it, the per-pass counts are then arithmetic.

     'manual'    NOT decidable after the fact, at any cost, from the images.
                 "Diffuse and static lighting" is the clearest case: a single
                 hard source and two softboxes produce photographs that no
                 statistic separates, and the shadow that moved is only
                 visible as the reconstruction failing later. These are
                 attestations. The operator ticks them, the report records
                 that the operator - not the tool - vouched for them, and an
                 unticked one blocks 'ready' exactly as a failure does.

     'deferred'  Section 8.3's post-SfM gates. They need a reconstruction,
                 which this ticket does not build. Listed, with their
                 thresholds, and never blocking.

   The split is reported, not buried. A report that says "9 automatic passes,
   11 things you vouched for, 5 nobody has checked yet" is honest; one that
   says "PASS" is not.

   ---------------------------------------------------------------------------
   PROVENANCE OF NUMBERS
   ---------------------------------------------------------------------------
   The contract is careful to say which of its numbers are measured and which
   are convention or margin, and that care is worth nothing if it is lost
   here. Every threshold below carries a `from` string in the same spirit:
   'contract' for a number the contract fixes, 'measured' where the
   feasibility report measured it, and 'convention' for a number this module
   chose. A convention-grade threshold never produces a hard failure.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   CONTRACT                     the frozen spec: passes, total, thresholds
   ATTESTATIONS                 the manual clauses, in report order
   PASS_IDS                     ['ringA','ringB','ringC','top','flip','fliptop','extra']
   grade(set)                   -> report    the whole thing
   summarize(report)            -> counts    {pass, warn, fail, todo, unknown, deferred, ready}
   sharpnessOf(gray)            -> number    variance of Laplacian, relative measure
   subjectFillOf(gray)          -> number    subject extent / short frame axis, 0..1
 */
(function (root) {
  'use strict';

  /* =====================================================================
     THE CONTRACT
     Section 5.1's shot list, transcribed. The frame counts are the
     contract's; `elevation` and `step` are carried for the report's benefit
     and are not checkable (see 'declared' above).
     ===================================================================== */
  var PASSES = [
    { id: 'ringA',   name: 'Ring A - low',  frames: 24, elevation: '15 +/- 5 deg',  step: 15,   ring: true,  flip: false },
    { id: 'ringB',   name: 'Ring B - mid',  frames: 24, elevation: '45 +/- 5 deg',  step: 15,   ring: true,  flip: false },
    { id: 'ringC',   name: 'Ring C - high', frames: 24, elevation: '70 +/- 5 deg',  step: 15,   ring: true,  flip: false },
    { id: 'top',     name: 'Top',           frames: 4,  elevation: '~90 deg',       step: 90,   ring: false, flip: false },
    { id: 'flip',    name: 'Flip pass',     frames: 16, elevation: '40 +/- 10 deg', step: 22.5, ring: false, flip: true },
    { id: 'fliptop', name: 'Flip top',      frames: 1,  elevation: '~90 deg',       step: 0,    ring: false, flip: true }
  ];

  /* Detail passes are ADDED to the list, never substituted into it (5.1), so
     they live in their own bucket and are excluded from the 93. */
  var EXTRA = { id: 'extra', name: 'Detail / extra pass', frames: null };

  var TOTAL = PASSES.reduce(function (n, p) { return n + p.frames; }, 0);

  var CONTRACT = {
    doc: 'docs/PHOTOGRAMMETRY-CAPTURE.md',
    report: 'docs/PHOTOGRAMMETRY-FEASIBILITY.md',
    passes: PASSES,
    extra: EXTRA,
    total: TOTAL,                       /* 93, asserted below */
    scaleRefFramesPerRing: 3,           /* contract section 3 */
    subjectFill: { lo: 0.60, hi: 0.80, from: 'contract' },      /* 8.2 check 7 */
    aperture: { lo: 5.6, hi: 11, from: 'contract' },            /* section 4 */
    /* Section 4: shutter at least 1/(2 x 35mm-equivalent focal length). */
    handHoldFactor: { value: 2, from: 'contract' },
    /* Conventions chosen here, not by the contract. None of them fails hard. */
    isoSpread: { value: 4, from: 'convention' },
    isoCeiling: { value: 1600, from: 'convention' },
    frameGapMinutes: { value: 30, from: 'convention' },
    sessionHours: { value: 4, from: 'convention' },
    sharpnessFloor: { value: 0.5, from: 'convention' },
    fillTolerance: { lo: 0.45, hi: 0.92, from: 'convention' }
  };

  if (TOTAL !== 93) {
    /* The contract's own total. If the table above is edited, this is the
       line that says so before a report quietly grades against 91 or 95. */
    throw new Error('nso_photoset: shot list totals ' + TOTAL + ', contract says 93');
  }

  var PASS_IDS = PASSES.map(function (p) { return p.id; }).concat([EXTRA.id]);

  function passById(id) {
    for (var i = 0; i < PASSES.length; i++) if (PASSES[i].id === id) return PASSES[i];
    return id === EXTRA.id ? EXTRA : null;
  }

  /* A convenience, and deliberately a weak one: operators who shoot the list
     usually name or foldered their frames after it, so a filename carrying
     "ringB" or "flip-top" can pre-fill the assignment the 'declared' check
     needs. It is a GUESS - it never overrides an assignment the operator
     made, a null result means "ask", and nothing downstream treats a guessed
     pass as evidence. The order below matters: fliptop must be tested before
     both flip and top, or every flip-top frame lands in the wrong pass. */
  function guessPass(name) {
    if (typeof name !== 'string') return null;
    var n = name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');
    if (/fliptop|topflip/.test(n)) return 'fliptop';
    if (/flip|under|invert/.test(n)) return 'flip';
    if (/ringa/.test(n)) return 'ringA';
    if (/ringb/.test(n)) return 'ringB';
    if (/ringc/.test(n)) return 'ringC';
    if (/detail|extra/.test(n)) return 'extra';
    if (/top|nadir/.test(n)) return 'top';
    return null;
  }

  /* =====================================================================
     THE MANUAL CLAUSES
     Everything the contract requires that no amount of pixel-staring
     recovers. Each says WHY it cannot be automated, because that sentence
     is the one an operator needs in order to take the tick seriously.
     ===================================================================== */
  var ATTESTATIONS = [
    { id: 'subject.envelope', clause: '2',
      title: 'Subject is 30-250 mm, opaque and matte',
      ask: 'The longest axis is between 30 and 250 mm, and the part is opaque.',
      why: 'Size is a property of the object, not of the image. A photograph of a 40 mm bracket and one of a 4 m girder are the same photograph.' },
    { id: 'subject.surface', clause: '2, 9',
      title: 'Surface is not transparent, mirrored or gloss - or has been dulled',
      ask: 'No transparent, mirrored, polished or uniformly glossy surface remains untreated, and any featureless matte face has been speckled or knowingly accepted.',
      why: 'The failure is in the correspondence, not in any single frame. A mirrored part photographs perfectly well; it is only when two frames disagree about what a point is that it breaks.' },
    { id: 'rig.motion', clause: '3',
      title: 'Camera moved, object stayed still',
      ask: 'The object did not move relative to its backdrop at any point within a half of the capture.',
      why: 'A turntable capture and an orbit capture produce identical-looking frames. Only the background tells them apart, and the contract requires the background to be blank.' },
    { id: 'rig.backdrop', clause: '3',
      title: 'Backdrop matte, mid-grey, non-repeating',
      ask: 'The backdrop carries no repeating pattern, weave or chequerboard, and is not reflective.',
      why: 'A repeating backdrop produces confident wrong matches. Whether a given grey field repeats is a judgement about the physical cloth, not a statistic of one frame.' },
    { id: 'rig.lighting', clause: '3',
      title: 'Lighting diffuse and static relative to the object',
      ask: 'Two softboxes or full overcast; no hard single source, no on-camera flash, no shadow that moved with the camera.',
      why: 'This is the clearest case of something the images cannot answer. A shadow fixed to the object and a shadow fixed to the camera look the same in any single frame, and by the time the difference shows it has shown as a failed reconstruction.' },
    { id: 'scale.reference', clause: '3, 7',
      title: 'Scale reference of KNOWN length, in 3+ frames of every ring',
      ask: 'A scale bar, coded target or object of known length is in shot in at least 3 frames of each of rings A, B and C.',
      why: 'Detecting a bar would need marker detection this ticket does not build; and even detected, its LENGTH is knowledge the operator has and the image does not. Section 7 is the reason the whole handover to NSO works in millimetres.' },
    { id: 'rig.support', clause: '3, 5.3',
      title: 'Underside covered - flip pass shot, or object on a spike',
      ask: 'Either the flip pass was shot, or the object stood on a narrow support so ring A could drop to 0 degrees.',
      why: 'Which of the two legal routes was taken changes what the frame counts should be, and nothing in the frames says which.' },
    { id: 'flip.untouched', clause: '5.3',
      title: 'Object not cleaned, re-lit or re-speckled between halves',
      ask: 'Between the upright passes and the flip pass the surface was left exactly as it was.',
      why: 'The shared surface texture is the only thing tying the two halves into one model. A wipe with a cloth between them is invisible in the files and fatal in the solve.' },
    { id: 'focus.eyes', clause: '8.2 check 6',
      title: 'Every frame checked sharp at 100 % zoom',
      ask: 'Each frame was inspected at 100 % on the subject and any soft one was re-taken.',
      why: 'Measured: defocus does nothing at all out to 4 px and then destroys the capture at 8 px, with no warning band. The statistic below flags outliers; it cannot certify the set, and the contract keeps this rule absolute for exactly that reason.' },
    { id: 'framing.eyes', clause: '8.2 check 7',
      title: 'Subject fills 60-80 % of the short frame dimension',
      ask: 'In every ring frame the subject filled roughly 60-80 % of the frame\'s short side.',
      why: 'The estimate below finds the subject by contrast against the backdrop. It is a coarse advisory and it is wrong on a busy scene; the operator\'s eye is the check.' },
    { id: 'optics.settings', clause: '4',
      title: 'Stabilisation set correctly, and no mode the EXIF cannot show',
      ask: 'Stabilisation off on a tripod / on hand-held, no beautify or post-sharpening, and the lens was locked so the phone could not switch cameras.',
      why: 'Stabilisation state is not an EXIF tag on most bodies, and a beautify filter that re-encodes a file leaves no tag at all. The automatic optics checks below cover what the tags do carry, and no more.' }
  ];

  /* =====================================================================
     SECTION 8.3 - the gates a reconstruction has to answer
     Carried so the report can say what it has NOT checked. Out of scope for
     this ticket by name: no SfM is run, so none of these has a verdict.
     ===================================================================== */
  var DEFERRED = [
    { id: 'sfm.registered', clause: '8.3 check 8',  title: 'Every submitted frame registered',
      threshold: '100 %, no exceptions', from: 'measured',
      note: 'Partial registration is not graceful degradation: 8 frames registered 4 while 7 frames registered all 7.' },
    { id: 'sfm.submodels', clause: '8.3 check 9',   title: 'Exactly one sub-model',
      threshold: '1', from: 'contract',
      note: 'Two sub-models are two unrelated coordinate frames and cannot be combined into one part.' },
    { id: 'sfm.tracklen', clause: '8.3 check 10',   title: 'Mean track length',
      threshold: '>= 4.0', from: 'measured',
      note: '20 evenly-spread frames reached 4.12; the full 41 reached 5.08.' },
    { id: 'sfm.azimuthgap', clause: '8.3 check 11', title: 'No azimuth gap between recovered cameras > 30 deg',
      threshold: '30 deg', from: 'convention',
      note: 'Twice the 15 deg design step. Track length says how well the captured surface was measured; only this says how much of the object was captured.' },
    { id: 'sfm.reproj', clause: '8.3 check 12',     title: 'Mean reprojection error',
      threshold: 'report it; investigate above ~2 px', from: 'measured',
      note: 'Deliberately not a quality gate - measured inverted on real data, 5 frames gave 0.62 px and 41 gave 1.29 px.' }
  ];

  /* =====================================================================
     SMALL HELPERS
     ===================================================================== */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* Distinct values of one EXIF field across frames that carry it. Returns
     {values: [...], missing: n, counts: Map-ish object keyed by String(v)}. */
  function spread(frames, field, round) {
    var counts = {}, order = [], missing = 0;
    for (var i = 0; i < frames.length; i++) {
      var e = frames[i].exif;
      var v = e ? e[field] : undefined;
      if (v === undefined || v === null || v === '') { missing++; continue; }
      if (isNum(v) && isNum(round)) v = Math.round(v * round) / round;
      var k = String(v);
      if (counts[k] === undefined) { counts[k] = 0; order.push(v); }
      counts[k]++;
    }
    return { values: order, counts: counts, missing: missing, present: frames.length - missing };
  }

  function nameList(frames, limit) {
    var n = limit || 4;
    var names = frames.slice(0, n).map(function (f) { return f.name; });
    if (frames.length > n) names.push('+' + (frames.length - n) + ' more');
    return names.join(', ');
  }

  function fmtExposure(t) {
    if (!isNum(t) || t <= 0) return '?';
    if (t >= 1) return t.toFixed(t < 10 ? 1 : 0) + ' s';
    return '1/' + Math.round(1 / t) + ' s';
  }

  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* EXIF's DateTimeOriginal is "YYYY:MM:DD HH:MM:SS", local, no zone. Parsed
     as a wall clock; only differences are ever used, so the missing zone does
     not matter unless the capture crossed one, which is its own problem. */
  function exifTime(s) {
    if (typeof s !== 'string') return null;
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  /* =====================================================================
     PURE IMAGE STATISTICS
     Kept here, away from the DOM, so the checks that use them are testable
     on a synthetic buffer. `gray` is {width, height, data} with one byte per
     pixel; the browser builds it from a canvas, the tests build it directly.
     ===================================================================== */

  /* Variance of the Laplacian - the standard cheap focus measure. Returned
     RAW and used only relatively, because an absolute threshold would be a
     fiction: the value scales with the subject's own texture, and the
     feasibility report's finding is that what collapses under defocus is
     KEYPOINT YIELD (14,272 -> 4,671 between 4 px and 8 px of blur), not any
     smooth quality curve. This tracks that yield loosely and nothing more. */
  function sharpnessOf(gray) {
    if (!gray || !gray.data || !gray.width || !gray.height) return null;
    var w = gray.width, h = gray.height, d = gray.data;
    if (w < 3 || h < 3 || d.length < w * h) return null;
    var sum = 0, sumSq = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      var row = y * w;
      for (var x = 1; x < w - 1; x++) {
        var i = row + x;
        var lap = d[i - w] + d[i + w] + d[i - 1] + d[i + 1] - 4 * d[i];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    if (!n) return null;
    var mean = sum / n;
    return sumSq / n - mean * mean;
  }

  /* Subject extent along the frame's SHORT axis, as a fraction of it -
     the quantity section 8.2 check 7 is about.

     The backdrop is taken from the frame's border, which the contract makes
     legitimate: it requires a plain matte backdrop, and the subject is
     centred. Pixels differing from that level by more than a robust
     threshold are "subject"; a row or column counts as occupied once enough
     of it is subject, which stops a single dust speck from spanning the
     frame.

     This is an ESTIMATE and the report says so. On a cluttered scene, a
     subject the same tone as its backdrop, or a scale bar lying well outside
     the part, it will be wrong. It is worth having anyway: the failure it
     does catch - a part shot from across the room, filling 15 % of frame -
     is both common and completely obvious in this number. */
  function subjectFillOf(gray) {
    if (!gray || !gray.data || !gray.width || !gray.height) return null;
    var w = gray.width, h = gray.height, d = gray.data;
    if (w < 8 || h < 8 || d.length < w * h) return null;

    /* Border ring: the outer 4 % on each side, at least 2 px. */
    var bx = Math.max(2, Math.round(w * 0.04));
    var by = Math.max(2, Math.round(h * 0.04));
    var border = [];
    var x, y;
    for (y = 0; y < h; y++) {
      var inVertBand = (y < by || y >= h - by);
      for (x = 0; x < w; x++) {
        if (inVertBand || x < bx || x >= w - bx) border.push(d[y * w + x]);
      }
    }
    var bg = median(border);
    if (bg === null) return null;
    /* Robust spread of the backdrop itself, so a textured cloth raises the
       bar instead of reading as subject everywhere. */
    var dev = [];
    for (var i = 0; i < border.length; i++) dev.push(Math.abs(border[i] - bg));
    var mad = median(dev) || 0;
    var thresh = Math.max(12, mad * 4);

    var rowHit = new Uint32Array(h), colHit = new Uint32Array(w);
    for (y = 0; y < h; y++) {
      var r = y * w;
      for (x = 0; x < w; x++) {
        if (Math.abs(d[r + x] - bg) > thresh) { rowHit[y]++; colHit[x]++; }
      }
    }
    var rowNeed = Math.max(2, Math.round(w * 0.01));
    var colNeed = Math.max(2, Math.round(h * 0.01));
    var y0 = -1, y1 = -1, x0 = -1, x1 = -1;
    for (y = 0; y < h; y++) if (rowHit[y] >= rowNeed) { if (y0 < 0) y0 = y; y1 = y; }
    for (x = 0; x < w; x++) if (colHit[x] >= colNeed) { if (x0 < 0) x0 = x; x1 = x; }
    if (y0 < 0 || x0 < 0) return null;            /* uniform frame: nothing found */

    /* The short axis is the one the contract measures against. */
    return (h <= w) ? (y1 - y0 + 1) / h : (x1 - x0 + 1) / w;
  }

  /* =====================================================================
     THE CHECKS
     Each returns {status, detail, frames?}. Statuses:
       pass      looked, in contract
       warn      looked, out of spec on a convention-grade threshold, or a
                 soft signal - reported, does not block
       fail      looked, out of contract - blocks
       todo      an input is missing (an attestation, a pass assignment) -
                 blocks, because "not yet answered" is not "fine"
       unknown   could not look (no EXIF carried the tag) - does not block,
                 but is never silently folded into pass
     ===================================================================== */

  function checkTotal(set) {
    var counted = set.frames.filter(function (f) { return f.pass !== EXTRA.id; });
    var n = counted.length;
    var extra = set.frames.length - n;
    var d = n + ' of ' + TOTAL + ' contract frames' + (extra ? ' (+' + extra + ' in detail passes, not counted)' : '');
    if (n === TOTAL) return { status: 'pass', detail: d };
    if (n < TOTAL) return { status: 'fail', detail: d + ' - ' + (TOTAL - n) + ' short. A ring with a missing position is a re-shoot of that position, not a judgement call.' };
    return { status: 'fail', detail: d + ' - ' + (n - TOTAL) + ' over. Detail frames are ADDED as a named extra pass, never folded into a ring.' };
  }

  function checkPerPass(set) {
    var assigned = set.frames.filter(function (f) { return f.pass && f.pass !== null; });
    if (!assigned.length) {
      return { status: 'todo', detail: 'No frames assigned to passes yet. Nothing in a photograph records the elevation it was shot at - the shot list can only be counted once you say which frames are which.' };
    }
    var bad = [], bits = [];
    for (var i = 0; i < PASSES.length; i++) {
      var p = PASSES[i];
      var n = set.frames.filter(function (f) { return f.pass === p.id; }).length;
      bits.push(p.name + ' ' + n + '/' + p.frames);
      if (n !== p.frames) bad.push(p.name + ' has ' + n + ', needs ' + p.frames);
    }
    var un = set.frames.filter(function (f) { return !f.pass; }).length;
    if (un) bad.push(un + ' frame' + (un === 1 ? '' : 's') + ' unassigned');
    if (!bad.length) return { status: 'pass', detail: bits.join('  |  ') };
    return { status: 'fail', detail: bad.join('; ') };
  }

  function checkDuplicates(set) {
    var seen = {}, dupes = [];
    for (var i = 0; i < set.frames.length; i++) {
      var f = set.frames[i];
      if (!f.hash) continue;
      if (seen[f.hash]) dupes.push(f.name + ' = ' + seen[f.hash]);
      else seen[f.hash] = f.name;
    }
    if (!Object.keys(seen).length) return { status: 'unknown', detail: 'No file hashes supplied.' };
    if (!dupes.length) return { status: 'pass', detail: 'All ' + set.frames.length + ' frames distinct.' };
    return { status: 'fail', detail: dupes.length + ' duplicate frame' + (dupes.length === 1 ? '' : 's') + ': ' + dupes.slice(0, 3).join('; ') +
      '. A copy of a frame is not a second position, and it inflates the count past the gate it is meant to sit behind.' };
  }

  function checkFocal(set) {
    var s = spread(set.frames, 'FocalLength', 100);
    if (!s.present) return { status: 'unknown', detail: 'No frame carries a focal length.' };
    var d = s.values.map(function (v) { return v + ' mm'; }).join(', ') +
      (s.missing ? '  (' + s.missing + ' frame' + (s.missing === 1 ? '' : 's') + ' carry no tag)' : '');
    if (s.values.length === 1) return { status: 'pass', detail: d };
    return { status: 'fail', detail: 'Focal length changed mid-capture: ' + d +
      '. One camera model is solved for the whole set; changing focal length silently invalidates it.' };
  }

  function checkLens(set) {
    var model = spread(set.frames, 'LensModel');
    var eq = spread(set.frames, 'FocalLengthIn35mmFilm');
    if (!model.present && !eq.present) return { status: 'unknown', detail: 'No frame names a lens or a 35 mm equivalent.' };
    var bad = [];
    if (model.values.length > 1) bad.push('lens: ' + model.values.join(' / '));
    if (eq.values.length > 1) bad.push('35 mm equivalent: ' + eq.values.map(function (v) { return v + ' mm'; }).join(' / '));
    if (!bad.length) {
      return { status: 'pass', detail: (model.values[0] || ('' + eq.values[0] + ' mm equiv')) + ' throughout.' };
    }
    return { status: 'fail', detail: bad.join('; ') +
      ' - the phone switched cameras mid-capture, which is a focal length change wearing a different hat.' };
  }

  function checkAperture(set) {
    var s = spread(set.frames, 'FNumber', 100);
    if (!s.present) return { status: 'unknown', detail: 'No frame carries an aperture.' };
    if (s.values.length > 1) {
      return { status: 'warn', detail: 'Aperture varied: f/' + s.values.join(', f/') +
        ' - auto exposure was moving it. Depth of field changed across the set.' };
    }
    var f = s.values[0];
    var d = 'f/' + f + ' throughout';
    if (f >= CONTRACT.aperture.lo && f <= CONTRACT.aperture.hi) return { status: 'pass', detail: d + ' - inside the f/5.6-f/11 target.' };
    if (f < CONTRACT.aperture.lo) {
      return { status: 'pass', detail: d + ' - wider than the f/5.6-f/11 target. Fixed, which is what the contract requires; on a phone this is a constraint, not a choice. Depth of field is then the operator\'s problem.' };
    }
    return { status: 'pass', detail: d + ' - narrower than the f/5.6-f/11 target; watch for diffraction softening and a slow shutter.' };
  }

  function checkISO(set) {
    var s = spread(set.frames, 'ISO');
    if (!s.present) return { status: 'unknown', detail: 'No frame carries an ISO.' };
    var lo = Math.min.apply(null, s.values), hi = Math.max.apply(null, s.values);
    var d = (lo === hi) ? ('ISO ' + lo + ' throughout') : ('ISO ' + lo + '-' + hi);
    var bad = [];
    if (hi > lo * CONTRACT.isoSpread.value) bad.push('spread over ' + CONTRACT.isoSpread.value + 'x - sensor noise is texture that does not correspond between frames');
    if (hi > CONTRACT.isoCeiling.value) bad.push('peaks above ISO ' + CONTRACT.isoCeiling.value);
    if (!bad.length) return { status: 'pass', detail: d };
    return { status: 'warn', detail: d + ' - ' + bad.join('; ') + '. (Both thresholds are this tool\'s convention, not the contract\'s.)' };
  }

  function checkShutter(set) {
    var slow = [], checked = 0, worst = null;
    for (var i = 0; i < set.frames.length; i++) {
      var e = set.frames[i].exif;
      if (!e || !isNum(e.ExposureTime)) continue;
      var f35 = isNum(e.FocalLengthIn35mmFilm) ? e.FocalLengthIn35mmFilm : null;
      if (f35 === null) continue;
      checked++;
      var limit = 1 / (CONTRACT.handHoldFactor.value * f35);
      if (e.ExposureTime > limit) {
        slow.push(set.frames[i]);
        if (worst === null || e.ExposureTime > worst) worst = e.ExposureTime;
      }
    }
    if (!checked) return { status: 'unknown', detail: 'No frame carries both an exposure time and a 35 mm equivalent, so the hand-hold limit cannot be computed.' };
    if (!slow.length) return { status: 'pass', detail: 'All ' + checked + ' frames at or under 1/(2 x focal length equivalent).' };
    return { status: 'warn', detail: slow.length + ' of ' + checked + ' frames slower than the hand-hold limit (worst ' + fmtExposure(worst) + '): ' + nameList(slow) +
      '. On a tripod this is fine; hand-held it is motion blur, which is directional and was never measured in the spike.' };
  }

  function checkFlash(set) {
    var fired = set.frames.filter(function (f) { return f.exif && isNum(f.exif.Flash) && (f.exif.Flash & 1); });
    var carried = set.frames.filter(function (f) { return f.exif && isNum(f.exif.Flash); });
    if (!carried.length) return { status: 'unknown', detail: 'No frame carries a flash tag.' };
    if (!fired.length) return { status: 'pass', detail: 'No flash on any of ' + carried.length + ' frames that say.' };
    return { status: 'fail', detail: 'Flash fired on ' + fired.length + ' frame' + (fired.length === 1 ? '' : 's') + ': ' + nameList(fired) +
      '. On-camera flash is a light source that moves with the camera - a shadow that lies, in exactly the way section 3 bans.' };
  }

  /* CustomRendered / SceneCaptureType. Graded rather than lumped: the HDR,
     panorama and portrait values are unambiguous and fail; the bare "custom
     process" value 1 is vague across vendors and only warns. A clean tag is
     not proof the mode was off - it only means the camera did not admit to
     it - which is why 'optics.settings' is an attestation as well. */
  var RENDER_FAIL = { 2: 'HDR', 3: 'HDR', 6: 'panorama', 7: 'portrait HDR', 8: 'portrait' };

  function checkRendering(set) {
    var carried = 0, bad = [], soft = [];
    for (var i = 0; i < set.frames.length; i++) {
      var f = set.frames[i], e = f.exif;
      if (!e) continue;
      var has = isNum(e.CustomRendered) || isNum(e.SceneCaptureType);
      if (has) carried++;
      if (isNum(e.CustomRendered) && RENDER_FAIL[e.CustomRendered]) bad.push(f.name + ' (' + RENDER_FAIL[e.CustomRendered] + ')');
      else if (e.CustomRendered === 1) soft.push(f);
      if (e.SceneCaptureType === 3) bad.push(f.name + ' (night mode)');
    }
    if (!carried) return { status: 'unknown', detail: 'No frame carries a rendering-mode tag.' };
    if (bad.length) {
      return { status: 'fail', detail: bad.length + ' frame' + (bad.length === 1 ? '' : 's') + ' shot in a computational mode: ' + bad.slice(0, 4).join(', ') +
        '. These are per-frame non-linear edits and they break correspondence.' };
    }
    if (soft.length) {
      return { status: 'warn', detail: soft.length + ' frame' + (soft.length === 1 ? '' : 's') + ' tagged "custom process", which is vague across vendors: ' + nameList(soft) + '. Worth checking what the camera was doing.' };
    }
    return { status: 'pass', detail: 'No HDR, panorama, portrait or night mode on any of ' + carried + ' frames that say.' };
  }

  function checkDimensions(set) {
    var shapes = {}, order = [], orientations = {}, known = 0;
    for (var i = 0; i < set.frames.length; i++) {
      var f = set.frames[i];
      if (!isNum(f.width) || !isNum(f.height)) continue;
      known++;
      /* Sorted, so a camera turned to portrait is not a different sensor. */
      var lo = Math.min(f.width, f.height), hi = Math.max(f.width, f.height);
      var k = hi + 'x' + lo;
      if (!shapes[k]) { shapes[k] = 0; order.push(k); }
      shapes[k]++;
      var o = f.width >= f.height ? 'landscape' : 'portrait';
      orientations[o] = (orientations[o] || 0) + 1;
    }
    if (!known) return { status: 'unknown', detail: 'No frame dimensions available.' };
    if (order.length > 1) {
      return { status: 'fail', detail: 'Mixed frame sizes: ' + order.map(function (k) { return k + ' x' + shapes[k]; }).join(', ') +
        '. A cropped or differently-sourced frame does not share the camera model the rest of the set is solved with.' };
    }
    var mixed = Object.keys(orientations).length > 1;
    var d = order[0] + ' on all ' + known + ' frames';
    if (mixed) {
      return { status: 'warn', detail: d + ', but the camera was turned: ' +
        Object.keys(orientations).map(function (k) { return orientations[k] + ' ' + k; }).join(', ') +
        '. Legal, and it changes how much of the short dimension the subject fills - check 7 is about the short side either way.' };
    }
    return { status: 'pass', detail: d + '.' };
  }

  function checkProvenance(set) {
    var noExif = set.frames.filter(function (f) { return !f.exif; });
    var bits = [];
    var status = 'pass';
    if (noExif.length === set.frames.length) {
      return { status: 'warn', detail: 'No frame carries EXIF at all. Every optics check below stands down. A stripped file is usually a re-export, and heavy re-compression is the one thing section 4 says wrecks fine texture.' };
    }
    if (noExif.length) {
      status = 'warn';
      bits.push(noExif.length + ' frame' + (noExif.length === 1 ? '' : 's') + ' carry no EXIF (' + nameList(noExif) + ') - the optics checks skip them');
    }
    var sw = spread(set.frames, 'Software');
    if (sw.values.length) bits.push('Software tag: ' + sw.values.join(', '));
    var cam = spread(set.frames, 'Model');
    if (cam.values.length > 1) {
      status = 'fail';
      bits.push('more than one camera body: ' + cam.values.join(', ') + ' - one camera model cannot be solved for two bodies');
    } else if (cam.values.length === 1) {
      bits.unshift(cam.values[0]);
    }
    return { status: status, detail: bits.join('; ') || 'EXIF present.' };
  }

  function checkContinuity(set) {
    var stamped = [];
    for (var i = 0; i < set.frames.length; i++) {
      var f = set.frames[i];
      var t = f.exif ? exifTime(f.exif.DateTimeOriginal || f.exif.DateTime) : null;
      if (t !== null) stamped.push({ f: f, t: t });
    }
    if (stamped.length < 2) return { status: 'unknown', detail: 'Fewer than two frames carry a timestamp.' };
    stamped.sort(function (a, b) { return a.t - b.t; });
    var spanH = (stamped[stamped.length - 1].t - stamped[0].t) / 3600000;
    var gaps = [];
    for (var j = 1; j < stamped.length; j++) {
      var g = (stamped[j].t - stamped[j - 1].t) / 60000;
      if (g > CONTRACT.frameGapMinutes.value) gaps.push({ mins: g, after: stamped[j - 1].f.name, before: stamped[j].f.name });
    }
    var d = stamped.length + ' frames over ' + (spanH < 1 ? Math.round(spanH * 60) + ' min' : spanH.toFixed(1) + ' h');
    if (!gaps.length && spanH <= CONTRACT.sessionHours.value) return { status: 'pass', detail: d + ', no gap over ' + CONTRACT.frameGapMinutes.value + ' min.' };
    var bits = [];
    if (gaps.length) {
      /* Name the frame the LONGEST gap follows, not the first one's - the
         operator is being sent to look at a specific frame, and the two are
         different frames as soon as there is more than one gap. */
      var worstGap = gaps[0];
      for (var k = 1; k < gaps.length; k++) if (gaps[k].mins > worstGap.mins) worstGap = gaps[k];
      bits.push(gaps.length + ' gap' + (gaps.length === 1 ? '' : 's') + ' over ' + CONTRACT.frameGapMinutes.value +
        ' min (longest ' + Math.round(worstGap.mins) + ' min, between ' + worstGap.after + ' and ' + worstGap.before + ')');
    }
    if (spanH > CONTRACT.sessionHours.value) bits.push('the set spans ' + spanH.toFixed(1) + ' h');
    return { status: 'warn', detail: d + ' - ' + bits.join('; ') +
      '. Worth confirming the object, the light and the rig did not move in the interval; section 5.3 turns on the two halves sharing one surface untouched. (Convention-grade thresholds, not the contract\'s.)' };
  }

  function checkFocus(set) {
    var scored = set.frames.filter(function (f) { return isNum(f.sharpness) && f.sharpness > 0; });
    if (scored.length < 3) return { status: 'unknown', detail: 'Fewer than three frames were measured, so there is no set to compare against.' };
    var med = median(scored.map(function (f) { return f.sharpness; }));
    var floor = med * CONTRACT.sharpnessFloor.value;
    var soft = scored.filter(function (f) { return f.sharpness < floor; });
    var base = scored.length + ' frames measured';
    if (!soft.length) {
      return { status: 'pass', detail: base + ', none below half the set median. This flags OUTLIERS only - measured, defocus does nothing at all out to 4 px and then destroys the capture at 8 px, so a clean result here is not a certificate. Check 6 stays yours.' };
    }
    return { status: 'warn', detail: soft.length + ' of ' + base + ' below half the set median: ' + nameList(soft) +
      '. Re-check these at 100 % zoom and re-take rather than trusting the number - there is no useful warning band between sharp and fatal.' };
  }

  function checkFill(set) {
    var measured = set.frames.filter(function (f) { return isNum(f.fill) && f.fill > 0; });
    if (!measured.length) return { status: 'unknown', detail: 'No frame was measured for subject fill.' };
    var vals = measured.map(function (f) { return f.fill; });
    var med = median(vals);
    var out = measured.filter(function (f) { return f.fill < CONTRACT.fillTolerance.lo || f.fill > CONTRACT.fillTolerance.hi; });
    var d = 'median ' + Math.round(med * 100) + ' % of the short side across ' + measured.length + ' frames (target ' +
      Math.round(CONTRACT.subjectFill.lo * 100) + '-' + Math.round(CONTRACT.subjectFill.hi * 100) + ' %)';
    if (!out.length) return { status: 'pass', detail: d + '. Coarse estimate from backdrop contrast - advisory only.' };
    return { status: 'warn', detail: d + '; ' + out.length + ' frame' + (out.length === 1 ? '' : 's') + ' outside ' +
      Math.round(CONTRACT.fillTolerance.lo * 100) + '-' + Math.round(CONTRACT.fillTolerance.hi * 100) + ' %: ' + nameList(out) +
      '. Coarse estimate from backdrop contrast - it is wrong on a busy scene, and the tolerance here is deliberately wider than the contract\'s because of that.' };
  }

  var AUTO_CHECKS = [
    { id: 'count.total',       clause: '5.1', kind: 'auto',     title: 'Shot list complete - 93 contract frames', run: checkTotal },
    { id: 'count.perPass',     clause: '5.1', kind: 'declared', title: 'Every pass has its own count', run: checkPerPass },
    { id: 'count.duplicates',  clause: '5.1', kind: 'auto',     title: 'No duplicate frames', run: checkDuplicates },
    { id: 'optics.focal',      clause: '4',   kind: 'auto',     title: 'Focal length fixed for the whole capture', run: checkFocal },
    { id: 'optics.lens',       clause: '4',   kind: 'auto',     title: 'One lens - no camera switch mid-capture', run: checkLens },
    { id: 'optics.aperture',   clause: '4',   kind: 'auto',     title: 'Aperture fixed', run: checkAperture },
    { id: 'optics.iso',        clause: '4',   kind: 'auto',     title: 'ISO low and steady', run: checkISO },
    { id: 'optics.shutter',    clause: '4',   kind: 'auto',     title: 'Shutter above the hand-hold limit', run: checkShutter },
    { id: 'optics.flash',      clause: '3',   kind: 'auto',     title: 'No on-camera flash', run: checkFlash },
    { id: 'optics.rendering',  clause: '4',   kind: 'auto',     title: 'No HDR, portrait, panorama or night mode', run: checkRendering },
    { id: 'format.dimensions', clause: '4',   kind: 'auto',     title: 'One frame size, one camera body', run: checkDimensions },
    { id: 'format.provenance', clause: '4',   kind: 'auto',     title: 'Files straight off the camera', run: checkProvenance },
    { id: 'capture.continuity',clause: '5.3', kind: 'auto',     title: 'One continuous session', run: checkContinuity },
    { id: 'focus.relative',    clause: '8.2 check 6', kind: 'auto', title: 'No frame far softer than the set', run: checkFocus },
    { id: 'framing.fill',      clause: '8.2 check 7', kind: 'auto', title: 'Subject fill estimate', run: checkFill }
  ];

  /* =====================================================================
     GRADE
     ===================================================================== */
  function normalizeSet(set) {
    var s = set || {};
    var frames = (s.frames || []).map(function (f, i) {
      return {
        name: f.name || ('frame ' + (i + 1)),
        size: isNum(f.size) ? f.size : null,
        pass: (f.pass && PASS_IDS.indexOf(f.pass) >= 0) ? f.pass : null,
        exif: f.exif || null,
        width: isNum(f.width) ? f.width : null,
        height: isNum(f.height) ? f.height : null,
        hash: f.hash || null,
        sharpness: isNum(f.sharpness) ? f.sharpness : null,
        fill: isNum(f.fill) ? f.fill : null
      };
    });
    return { frames: frames, attest: s.attest || {} };
  }

  function grade(set) {
    var s = normalizeSet(set);
    var results = [];

    if (!s.frames.length) {
      /* An empty set is not a failing set - it is not a set. Report it once
         rather than emitting 31 identical "no frames" lines. */
      return {
        contract: CONTRACT,
        empty: true,
        results: [],
        counts: { pass: 0, warn: 0, fail: 0, todo: 0, unknown: 0, deferred: DEFERRED.length },
        ready: false,
        verdict: 'No frames submitted.'
      };
    }

    var i, r;
    for (i = 0; i < AUTO_CHECKS.length; i++) {
      var c = AUTO_CHECKS[i];
      try {
        r = c.run(s);
      } catch (err) {
        /* A check that throws is a bug in this file, not a verdict about the
           photographs. Say so plainly instead of reporting a pass or a fail. */
        r = { status: 'unknown', detail: 'check errored: ' + (err && err.message ? err.message : err) };
      }
      results.push({ id: c.id, clause: c.clause, kind: c.kind, title: c.title, status: r.status, detail: r.detail });
    }

    for (i = 0; i < ATTESTATIONS.length; i++) {
      var a = ATTESTATIONS[i];
      var ticked = s.attest[a.id] === true;
      results.push({
        id: a.id, clause: a.clause, kind: 'manual', title: a.title,
        status: ticked ? 'pass' : 'todo',
        detail: ticked ? 'Vouched for by the photographer. ' + a.ask
                       : 'Not yet confirmed. ' + a.ask,
        why: a.why
      });
    }

    for (i = 0; i < DEFERRED.length; i++) {
      var dd = DEFERRED[i];
      results.push({
        id: dd.id, clause: dd.clause, kind: 'deferred', title: dd.title,
        status: 'deferred', threshold: dd.threshold,
        detail: dd.threshold + ' - needs a sparse reconstruction, which this onramp does not run.',
        why: dd.note
      });
    }

    var counts = summarizeResults(results);
    var ready = counts.fail === 0 && counts.todo === 0;
    return {
      contract: CONTRACT,
      empty: false,
      frames: s.frames.length,
      results: results,
      counts: counts,
      ready: ready,
      verdict: verdictText(counts, ready, s.frames.length)
    };
  }

  function summarizeResults(results) {
    var c = { pass: 0, warn: 0, fail: 0, todo: 0, unknown: 0, deferred: 0 };
    for (var i = 0; i < results.length; i++) {
      if (c[results[i].status] === undefined) c[results[i].status] = 0;
      c[results[i].status]++;
    }
    return c;
  }

  function verdictText(c, ready, n) {
    if (!ready) {
      var why = [];
      if (c.fail) why.push(c.fail + ' out of contract');
      if (c.todo) why.push(c.todo + ' not yet confirmed');
      return 'NOT READY - ' + why.join(', ') + '. ' +
        'Fix these before spending reconstruction time on this set.';
    }
    var tail = c.warn ? (' ' + c.warn + ' warning' + (c.warn === 1 ? '' : 's') + ' to read first.') : '';
    return 'READY - ' + n + ' frames in contract on every clause this onramp can decide.' + tail +
      ' ' + c.deferred + ' post-reconstruction gates remain unchecked by design.';
  }

  function summarize(report) {
    var c = report && report.counts ? report.counts : { pass: 0, warn: 0, fail: 0, todo: 0, unknown: 0, deferred: 0 };
    var out = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
    out.ready = !!(report && report.ready);
    return out;
  }

  var API = {
    CONTRACT: CONTRACT,
    ATTESTATIONS: ATTESTATIONS,
    DEFERRED: DEFERRED,
    AUTO_CHECKS: AUTO_CHECKS,
    PASS_IDS: PASS_IDS,
    passById: passById,
    guessPass: guessPass,
    grade: grade,
    summarize: summarize,
    sharpnessOf: sharpnessOf,
    subjectFillOf: subjectFillOf,
    exifTime: exifTime,
    fmtExposure: fmtExposure
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_PhotoSet = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
