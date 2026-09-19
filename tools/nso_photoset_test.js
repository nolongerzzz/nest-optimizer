#!/usr/bin/env node
// Headless self-test for the photogrammetry upload onramp.
//
//   node tools/nso_photoset_test.js      exit 0 = every gate held
//
// Six sections:
//
//   1. The contract transcription, checked against the CONTRACT DOCUMENT
//      ITSELF. nso_photoset.js carries the shot list as a table of numbers;
//      docs/PHOTOGRAMMETRY-CAPTURE.md carries it as a markdown table. This
//      section parses the doc and compares. It is the only thing standing
//      between an edited spec and a validator that quietly grades against the
//      old one, which is the single worst failure this feature could have -
//      a confident green light measured against a contract nobody agreed to.
//
//   2. nso_exif.js against JPEGs built byte by byte in this file, plus the
//      malformed-input contract: it never throws, it returns null.
//
//   3. The two pure image statistics, on synthetic buffers with a known answer.
//
//   4. Each contract clause, violated one at a time, producing the right
//      status on the right check and leaving the others alone.
//
//   5. The ready gate: what blocks it, what does not, and why an unticked
//      attestation blocks exactly as hard as a failure.
//
//   6. Scope. The five post-SfM gates are present, are marked deferred, and
//      never block - this ticket does not run a reconstruction and the report
//      has to say so rather than implying it checked everything.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'nso_exif.js'));
const P = require(path.join(ROOT, 'nso_photoset.js'));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function statusOf(report, id) {
  const r = report.results.find(x => x.id === id);
  return r ? r.status : '(no such check: ' + id + ')';
}
function detailOf(report, id) {
  const r = report.results.find(x => x.id === id);
  return r ? r.detail : '';
}

/* =====================================================================
   1. The contract, against the contract document
   ===================================================================== */
console.log('== 1. the shot list in code is the shot list in the doc ==');
{
  const docPath = path.join(ROOT, 'docs', 'PHOTOGRAMMETRY-CAPTURE.md');
  check('the capture contract is in the tree', fs.existsSync(docPath), docPath);
  const doc = fs.readFileSync(docPath, 'utf8');
  /* The doc hard-wraps, and its bold spans cross line breaks, so every prose
     regex below runs against a whitespace-collapsed copy. */
  const flat = doc.replace(/\s+/g, ' ');

  /* The section 5.1 table. Cells are | pass | elevation | positions | frames | notes | */
  const rows = doc.split('\n').filter(l => l.trim().startsWith('|'));
  function frameCountFor(label) {
    for (const line of rows) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length < 4) continue;
      if (cells[0].replace(/\*/g, '').indexOf(label) === 0) {
        const m = /(\d+)/.exec(cells[3]);
        if (m) return Number(m[1]);
      }
    }
    return null;
  }

  const expect = {
    'Ring A': 'ringA', 'Ring B': 'ringB', 'Ring C': 'ringC',
    'Top': 'top', 'Flip pass': 'flip', 'Flip top': 'fliptop'
  };
  for (const label of Object.keys(expect)) {
    const docN = frameCountFor(label);
    const code = P.passById(expect[label]);
    check('"' + label + '" frame count matches the doc',
      code !== null && docN !== null && code.frames === docN,
      'doc ' + docN + ', code ' + (code ? code.frames : '?'));
  }

  /* The doc bolds its own total on the table's last row. */
  check('the doc still totals 93', /\*\*93\*\*/.test(doc));
  check('CONTRACT.total is 93 and is the sum of the passes',
    P.CONTRACT.total === 93 &&
    P.CONTRACT.passes.reduce((n, p) => n + p.frames, 0) === 93,
    String(P.CONTRACT.total));
  check('there are exactly six passes, plus a separate bucket for detail frames',
    P.CONTRACT.passes.length === 6 && P.CONTRACT.extra.id === 'extra' && P.CONTRACT.extra.frames === null);

  /* Section 5.2's step, section 3's scale rule and section 8.2's framing
     window are quoted in the code; check they are still what the doc says. */
  check('the 15 deg azimuth step is what the three rings carry',
    ['ringA', 'ringB', 'ringC'].every(id => P.passById(id).step === 15) && /every 15/.test(flat));
  check('the scale reference is 3 frames of every ring, in doc and code',
    P.CONTRACT.scaleRefFramesPerRing === 3 && /\*\*at least 3 frames of every ring\*\*/.test(flat));
  check('the 60-80 % framing window is the doc\'s',
    P.CONTRACT.subjectFill.lo === 0.60 && P.CONTRACT.subjectFill.hi === 0.80 && /60.?80 ?%/.test(flat));
  check('the f/5.6-f/11 aperture target is the doc\'s',
    P.CONTRACT.aperture.lo === 5.6 && P.CONTRACT.aperture.hi === 11 && /f\/5\.6.{1,3}f\/11/.test(flat));
  check('the hand-hold rule is 1/(2 x focal length equivalent)',
    P.CONTRACT.handHoldFactor.value === 2 && /1\/\(2 x focal length equivalent\)/.test(flat));

  /* Every number this module invented must say so, so that a reader can tell
     a measured threshold from one we chose. */
  const invented = ['isoSpread', 'isoCeiling', 'frameGapMinutes', 'sessionHours', 'sharpnessFloor', 'fillTolerance'];
  check('every convention-grade threshold is labelled as one',
    invented.every(k => P.CONTRACT[k] && P.CONTRACT[k].from === 'convention'),
    invented.join(', '));
  check('every contract-grade threshold is labelled as one',
    ['subjectFill', 'aperture', 'handHoldFactor'].every(k => P.CONTRACT[k].from === 'contract'));
}

/* =====================================================================
   2. nso_exif.js
   ===================================================================== */
console.log('\n== 2. the EXIF reader, on JPEGs built byte by byte ==');

const { T, buildTIFF, buildJPEG } = require('./nso_photoset_fixtures.js');

{
  const tiff = buildTIFF(
    [
      { tag: 0x010f, type: T.ASCII, value: 'NSOCam' },
      { tag: 0x0110, type: T.ASCII, value: 'Bench 1' },
      { tag: 0x0131, type: T.ASCII, value: 'Firmware 2.1' }
    ],
    [
      { tag: 0x829a, type: T.RATIONAL, value: [1, 125] },     /* ExposureTime */
      { tag: 0x829d, type: T.RATIONAL, value: [80, 10] },     /* FNumber f/8 */
      { tag: 0x8827, type: T.SHORT, value: 100 },             /* ISO */
      { tag: 0x9003, type: T.ASCII, value: '2026:03:01 10:00:00' },
      { tag: 0x9209, type: T.SHORT, value: 16 },              /* Flash: did not fire */
      { tag: 0x920a, type: T.RATIONAL, value: [24, 1] },      /* FocalLength */
      { tag: 0xa002, type: T.LONG, value: 4032 },
      { tag: 0xa003, type: T.LONG, value: 3024 },
      { tag: 0xa401, type: T.SHORT, value: 0 },               /* CustomRendered: normal */
      { tag: 0xa405, type: T.SHORT, value: 27 },              /* 35 mm equivalent */
      { tag: 0xa406, type: T.SHORT, value: 0 },               /* SceneCaptureType */
      { tag: 0xa434, type: T.ASCII, value: 'NSO 24mm f/2' }
    ]
  );
  const jpg = buildJPEG({ tiff });
  const t = E.read(jpg);
  check('EXIF is found in the APP1 segment', t !== null);
  check('  ...ASCII tags come back, NUL-trimmed', t.Make === 'NSOCam' && t.Model === 'Bench 1', t.Make + ' / ' + t.Model);
  check('  ...a long ASCII value from the heap comes back whole', t.LensModel === 'NSO 24mm f/2', t.LensModel);
  check('  ...RATIONALs divide', Math.abs(t.ExposureTime - 1 / 125) < 1e-9 && t.FNumber === 8,
    P.fmtExposure(t.ExposureTime) + ' f/' + t.FNumber);
  check('  ...SHORTs read inline', t.ISO === 100 && t.FocalLengthIn35mmFilm === 27 && t.Flash === 16);
  check('  ...LONGs read', t.PixelXDimension === 4032 && t.PixelYDimension === 3024);
  check('  ...the focal length is a number, not a string', t.FocalLength === 24);
  check('  ...the timestamp parses to a wall clock', P.exifTime(t.DateTimeOriginal) === Date.UTC(2026, 2, 1, 10, 0, 0));

  check('the frame size also comes off SOF, with no EXIF needed', (() => {
    const s = E.jpegSize(buildJPEG({ width: 1920, height: 1080 }));
    return s && s.width === 1920 && s.height === 1080;
  })());
  check('a JPEG with no EXIF reads as null rather than throwing', E.read(buildJPEG({})) === null);

  /* The malformed-input contract. Every one of these is a file a photographer
     could plausibly hand over, and none may take down the other 92 frames. */
  const junk = [
    ['empty', new Uint8Array(0)],
    ['not a JPEG', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])],
    ['truncated mid-APP1', jpg.slice(0, 20)],
    ['truncated mid-TIFF', jpg.slice(0, 40)],
    ['SOI only', Uint8Array.from([0xff, 0xd8])],
    ['bogus segment length', Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45, 0x78])],
    ['null', null],
    ['a number', 12345]
  ];
  let threw = null;
  for (const [label, input] of junk) {
    try {
      E.read(input);
      E.jpegSize(input);
      E.isJPEG(input);
    } catch (err) { threw = label + ': ' + err.message; break; }
  }
  check('no malformed input throws - a bad frame is a finding, not a crash', threw === null, threw || '8 cases');

  /* A count field large enough to run off the end of the buffer is the
     classic EXIF parser crash. It must read as absent. */
  const evil = buildTIFF([{ tag: 0x010f, type: T.ASCII, value: 'X' }], []);
  evil[10] = 0xff; evil[11] = 0xff; evil[12] = 0xff; evil[13] = 0x7f;
  let evilOk = true;
  try { E.read(buildJPEG({ tiff: evil })); } catch (err) { evilOk = false; }
  check('an out-of-range value count is refused, not followed', evilOk);

  check('describeRendering names what the mode tags admit to',
    E.describeRendering({ CustomRendered: 3, Flash: 1 }) === 'HDR, flash fired',
    E.describeRendering({ CustomRendered: 3, Flash: 1 }));
}

/* =====================================================================
   3. The two pure image statistics
   ===================================================================== */
console.log('\n== 3. sharpness and subject fill, on buffers with a known answer ==');
{
  function gray(w, h, fn) {
    const d = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = fn(x, y) & 0xff;
    return { width: w, height: h, data: d };
  }
  function boxBlur(g, r) {
    const { width: w, height: h, data: d } = g;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        s += d[yy * w + xx]; n++;
      }
      out[y * w + x] = Math.round(s / n);
    }
    return { width: w, height: h, data: out };
  }

  const sharp = gray(64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 25);
  const soft = boxBlur(sharp, 3);
  const flat = gray(64, 64, () => 128);

  const sS = P.sharpnessOf(sharp), sB = P.sharpnessOf(soft), sF = P.sharpnessOf(flat);
  check('a sharp checkerboard scores far above a blurred copy of itself',
    sS > sB * 5, sS.toFixed(1) + ' vs ' + sB.toFixed(1));
  check('a flat field scores zero', sF === 0, String(sF));
  check('sharpness refuses a buffer it cannot use, rather than guessing',
    P.sharpnessOf(null) === null && P.sharpnessOf({ width: 2, height: 2, data: new Uint8Array(4) }) === null);

  /* A 120 x 100 frame - short axis is the height - with a subject spanning
     rows 20..79. That is 60 of 100, so the answer is 0.60 exactly. */
  const framed = gray(120, 100, (x, y) => (y >= 20 && y <= 79 && x >= 30 && x <= 89) ? 30 : 200);
  const fill = P.subjectFillOf(framed);
  check('subject fill measures against the SHORT frame axis',
    Math.abs(fill - 0.60) < 0.02, fill === null ? 'null' : fill.toFixed(3));

  const small = gray(120, 100, (x, y) => (y >= 45 && y <= 54 && x >= 55 && x <= 64) ? 30 : 200);
  check('a subject shot from across the room reads far under the window',
    P.subjectFillOf(small) < 0.2, P.subjectFillOf(small).toFixed(3));

  check('a uniform frame yields no estimate rather than a wrong one',
    P.subjectFillOf(gray(64, 64, () => 128)) === null);
  check('subject fill refuses a buffer it cannot use',
    P.subjectFillOf(null) === null && P.subjectFillOf({ width: 4, height: 4, data: new Uint8Array(16) }) === null);
}

/* =====================================================================
   4. Each clause, violated one at a time
   ===================================================================== */
console.log('\n== 4. one violation at a time, landing on the right clause ==');

const CLEAN_EXIF = {
  Make: 'NSOCam', Model: 'Bench 1',
  FocalLength: 24, FocalLengthIn35mmFilm: 27, LensModel: 'NSO 24mm f/2',
  FNumber: 8, ISO: 100, ExposureTime: 1 / 125,
  Flash: 16, CustomRendered: 0, SceneCaptureType: 0,
  DateTimeOriginal: '2026:03:01 10:00:00'
};

function stamp(i) {
  const t = new Date(Date.UTC(2026, 2, 1, 10, 0, 0) + i * 20000);
  const p = n => String(n).padStart(2, '0');
  return t.getUTCFullYear() + ':' + p(t.getUTCMonth() + 1) + ':' + p(t.getUTCDate()) + ' ' +
    p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds());
}

/* A full, in-contract 93-frame set: the baseline every case below perturbs. */
function cleanSet() {
  const frames = [];
  let i = 0;
  for (const p of P.CONTRACT.passes) {
    for (let k = 0; k < p.frames; k++, i++) {
      frames.push({
        name: p.id + '_' + String(k + 1).padStart(2, '0') + '.jpg',
        size: 3500000,
        pass: p.id,
        exif: Object.assign({}, CLEAN_EXIF, { DateTimeOriginal: stamp(i) }),
        width: 4032, height: 3024,
        hash: 'h' + i,
        sharpness: 1000 + (i % 7) * 10,
        fill: 0.70
      });
    }
  }
  const attest = {};
  for (const a of P.ATTESTATIONS) attest[a.id] = true;
  return { frames, attest };
}

{
  const base = P.grade(cleanSet());
  check('a fully in-contract 93-frame set is READY', base.ready === true, base.verdict);
  check('  ...with no failures and nothing left to confirm',
    base.counts.fail === 0 && base.counts.todo === 0,
    JSON.stringify(base.counts));
  check('  ...and 93 frames counted', base.frames === 93);

  /* --- frame count --- */
  let s = cleanSet(); s.frames.pop();
  let r = P.grade(s);
  check('one frame short fails the shot list', statusOf(r, 'count.total') === 'fail' && !r.ready, detailOf(r, 'count.total'));
  check('  ...and the per-pass check names WHICH pass is short',
    statusOf(r, 'count.perPass') === 'fail' && /Flip top/.test(detailOf(r, 'count.perPass')),
    detailOf(r, 'count.perPass'));

  /* A detail pass is ADDED to the list, never folded into it (5.1). */
  s = cleanSet();
  s.frames.push({ name: 'detail_01.jpg', pass: 'extra', exif: Object.assign({}, CLEAN_EXIF), width: 4032, height: 3024, hash: 'x1', sharpness: 1000, fill: 0.7 });
  r = P.grade(s);
  check('a named detail pass does not inflate the 93', statusOf(r, 'count.total') === 'pass' && r.ready, detailOf(r, 'count.total'));

  s = cleanSet();
  s.frames.push({ name: 'stray.jpg', pass: 'ringB', exif: Object.assign({}, CLEAN_EXIF), width: 4032, height: 3024, hash: 'x2', sharpness: 1000, fill: 0.7 });
  r = P.grade(s);
  check('...but a 25th frame folded into ring B does', statusOf(r, 'count.total') === 'fail' && statusOf(r, 'count.perPass') === 'fail');

  s = cleanSet(); s.frames.forEach(f => { f.pass = null; });
  r = P.grade(s);
  check('with no pass assignment the per-pass check is TODO, not a pass',
    statusOf(r, 'count.perPass') === 'todo' && !r.ready, detailOf(r, 'count.perPass'));
  check('  ...while the total, which needs no assignment, still passes',
    statusOf(r, 'count.total') === 'pass');

  /* --- duplicates --- */
  s = cleanSet(); s.frames[40].hash = s.frames[3].hash;
  r = P.grade(s);
  check('a duplicated frame fails', statusOf(r, 'count.duplicates') === 'fail', detailOf(r, 'count.duplicates'));

  /* --- section 4 optics --- */
  s = cleanSet(); s.frames[50].exif.FocalLength = 35;
  r = P.grade(s);
  check('a focal length change mid-capture fails', statusOf(r, 'optics.focal') === 'fail', detailOf(r, 'optics.focal'));

  s = cleanSet();
  s.frames[60].exif.LensModel = 'NSO 13mm ultra-wide';
  s.frames[60].exif.FocalLengthIn35mmFilm = 13;
  r = P.grade(s);
  check('a phone switching to its ultra-wide fails', statusOf(r, 'optics.lens') === 'fail', detailOf(r, 'optics.lens'));

  s = cleanSet(); s.frames[10].exif.FNumber = 4;
  r = P.grade(s);
  check('a drifting aperture warns but does not block',
    statusOf(r, 'optics.aperture') === 'warn' && r.ready, detailOf(r, 'optics.aperture'));

  s = cleanSet(); s.frames.forEach(f => { f.exif.FNumber = 1.8; });
  r = P.grade(s);
  check('a phone\'s fixed f/1.8 passes - fixed is what the contract asks, the window is a target',
    statusOf(r, 'optics.aperture') === 'pass', detailOf(r, 'optics.aperture'));

  s = cleanSet(); s.frames[20].exif.ISO = 3200;
  r = P.grade(s);
  check('an ISO spike warns on a convention-grade threshold',
    statusOf(r, 'optics.iso') === 'warn' && r.ready && /convention/.test(detailOf(r, 'optics.iso')),
    detailOf(r, 'optics.iso'));

  s = cleanSet(); s.frames[30].exif.ExposureTime = 1 / 15;
  r = P.grade(s);
  check('a shutter under the hand-hold limit warns, because a tripod is legal',
    statusOf(r, 'optics.shutter') === 'warn' && r.ready, detailOf(r, 'optics.shutter'));

  s = cleanSet(); s.frames[5].exif.Flash = 17;
  r = P.grade(s);
  check('on-camera flash fails - a light that moves with the camera',
    statusOf(r, 'optics.flash') === 'fail' && !r.ready, detailOf(r, 'optics.flash'));

  s = cleanSet(); s.frames[7].exif.CustomRendered = 3;
  r = P.grade(s);
  check('an HDR frame fails', statusOf(r, 'optics.rendering') === 'fail', detailOf(r, 'optics.rendering'));

  s = cleanSet(); s.frames[8].exif.SceneCaptureType = 3;
  r = P.grade(s);
  check('a night-mode frame fails', statusOf(r, 'optics.rendering') === 'fail', detailOf(r, 'optics.rendering'));

  s = cleanSet(); s.frames[9].exif.CustomRendered = 1;
  r = P.grade(s);
  check('the vague "custom process" value only warns - it means different things per vendor',
    statusOf(r, 'optics.rendering') === 'warn' && r.ready, detailOf(r, 'optics.rendering'));

  /* --- format --- */
  s = cleanSet(); s.frames[11].width = 2016; s.frames[11].height = 1512;
  r = P.grade(s);
  check('a cropped frame fails the one-frame-size check', statusOf(r, 'format.dimensions') === 'fail', detailOf(r, 'format.dimensions'));

  s = cleanSet(); s.frames[12].width = 3024; s.frames[12].height = 4032;
  r = P.grade(s);
  check('the camera turned to portrait warns, not fails - same sensor, different framing',
    statusOf(r, 'format.dimensions') === 'warn' && r.ready, detailOf(r, 'format.dimensions'));

  s = cleanSet(); s.frames[13].exif.Model = 'Other Body';
  r = P.grade(s);
  check('two camera bodies fail', statusOf(r, 'format.provenance') === 'fail', detailOf(r, 'format.provenance'));

  s = cleanSet(); s.frames[14].exif = null;
  r = P.grade(s);
  check('a frame with EXIF stripped warns and the optics checks skip it',
    statusOf(r, 'format.provenance') === 'warn' && statusOf(r, 'optics.focal') === 'pass' && r.ready,
    detailOf(r, 'format.provenance'));

  s = cleanSet(); s.frames.forEach(f => { f.exif = null; });
  r = P.grade(s);
  check('a set with no EXIF at all warns once, and every optics check reads UNKNOWN',
    statusOf(r, 'format.provenance') === 'warn' &&
    ['optics.focal', 'optics.lens', 'optics.aperture', 'optics.iso', 'optics.shutter', 'optics.flash', 'optics.rendering']
      .every(id => statusOf(r, id) === 'unknown'),
    detailOf(r, 'format.provenance'));
  check('  ...and UNKNOWN is never folded into a pass, nor does it block',
    r.counts.unknown >= 7 && r.ready, JSON.stringify(r.counts));

  /* --- section 5.3 continuity --- */
  s = cleanSet();
  for (let i = 60; i < s.frames.length; i++) s.frames[i].exif.DateTimeOriginal = stamp(i + 400);
  r = P.grade(s);
  check('a two-hour gap between the halves warns - the object may have been touched',
    statusOf(r, 'capture.continuity') === 'warn' && r.ready, detailOf(r, 'capture.continuity'));

  /* With more than one gap the message must name the frames the LONGEST gap
     falls between - it is sending the operator to look at a specific frame. */
  s = cleanSet();
  for (let i = 30; i < s.frames.length; i++) s.frames[i].exif.DateTimeOriginal = stamp(i + 130);
  for (let i = 60; i < s.frames.length; i++) s.frames[i].exif.DateTimeOriginal = stamp(i + 700);
  r = P.grade(s);
  check('with two gaps, the longest one\'s own frames are named',
    statusOf(r, 'capture.continuity') === 'warn' &&
    /2 gaps/.test(detailOf(r, 'capture.continuity')) &&
    /between ringC_12\.jpg and ringC_13\.jpg/.test(detailOf(r, 'capture.continuity')),
    detailOf(r, 'capture.continuity'));

  /* --- section 8.2 check 6, the focus statistic --- */
  s = cleanSet(); s.frames[70].sharpness = 120;
  r = P.grade(s);
  check('a frame far softer than the set is flagged as an outlier',
    statusOf(r, 'focus.relative') === 'warn' && /100 ?%/.test(detailOf(r, 'focus.relative')),
    detailOf(r, 'focus.relative'));
  check('  ...and a clean result says in words that it is not a certificate',
    /not a certificate/.test(detailOf(P.grade(cleanSet()), 'focus.relative')));

  /* --- section 8.2 check 7, the fill estimate --- */
  s = cleanSet(); for (let i = 0; i < 6; i++) s.frames[i].fill = 0.18;
  r = P.grade(s);
  check('frames shot from too far away are flagged, advisory only',
    statusOf(r, 'framing.fill') === 'warn' && r.ready, detailOf(r, 'framing.fill'));
  check('  ...and the wording says it is an estimate',
    /estimate/.test(detailOf(r, 'framing.fill')));
}

  /* The filename guess. It is a convenience for the assignment step, and it
     must stay a guess: a wrong pass silently mis-counts a ring. */
  check('a filename carrying its pass is picked up',
    P.guessPass('ringB_07.jpg') === 'ringB' && P.guessPass('RING-A-12.JPG') === 'ringA' &&
    P.guessPass('ring c 03.jpeg') === 'ringC');
  check('fliptop is tested before both flip and top, or every one lands wrong',
    P.guessPass('flip_top_01.jpg') === 'fliptop' && P.guessPass('fliptop.jpg') === 'fliptop' &&
    P.guessPass('flip_09.jpg') === 'flip' && P.guessPass('top_02.jpg') === 'top');
  check('a detail frame lands in the extra bucket, not in a ring',
    P.guessPass('detail_boss_3.jpg') === 'extra' && P.guessPass('extra-01.jpg') === 'extra');
  check('a name that says nothing guesses nothing, rather than guessing wrong',
    P.guessPass('IMG_4821.JPG') === null && P.guessPass('DSC00012.jpg') === null &&
    P.guessPass('') === null && P.guessPass(null) === null);
  check('a guessed pass only ever fills a blank - grade() takes what it is given',
    (() => {
      const s = cleanSet();
      s.frames[0].pass = 'extra';            /* an operator override */
      return P.grade(s).results.find(r => r.id === 'count.perPass').status === 'fail';
    })());

/* =====================================================================
   5. The ready gate
   ===================================================================== */
console.log('\n== 5. what blocks ready, and what only warns ==');
{
  /* Every attestation, on its own, blocks. This is the section that makes the
     feature honest: the tool cannot see the lighting, so it refuses to call a
     set ready until a person has said they did. */
  let blocked = 0;
  for (const a of P.ATTESTATIONS) {
    const s = cleanSet();
    s.attest[a.id] = false;
    const r = P.grade(s);
    if (!r.ready && statusOf(r, a.id) === 'todo') blocked++;
  }
  check('every one of the ' + P.ATTESTATIONS.length + ' attestations blocks ready on its own',
    blocked === P.ATTESTATIONS.length, blocked + '/' + P.ATTESTATIONS.length);

  const none = P.grade({ frames: cleanSet().frames, attest: {} });
  check('with nothing vouched for, ready is refused and the count says how many',
    none.ready === false && none.counts.todo === P.ATTESTATIONS.length,
    none.verdict);

  check('every attestation says WHY it cannot be automated',
    P.ATTESTATIONS.every(a => typeof a.why === 'string' && a.why.length > 40));
  check('every attestation cites a clause of the contract',
    P.ATTESTATIONS.every(a => /^[0-9]/.test(a.clause)));
  check('lighting is one of them, in so many words',
    P.ATTESTATIONS.some(a => a.id === 'rig.lighting' && /diffuse/i.test(a.title)));
  check('the scale reference is one of them - a known LENGTH is not in the pixels',
    P.ATTESTATIONS.some(a => a.id === 'scale.reference' && /known/i.test(a.title)));

  /* Warnings must never block: a capture on a tripod at 1/15 s is fine. */
  const warned = cleanSet();
  warned.frames[30].exif.ExposureTime = 1 / 15;
  warned.frames[20].exif.ISO = 3200;
  warned.frames[0].fill = 0.2;
  const wr = P.grade(warned);
  check('several warnings together still leave the set ready',
    wr.ready === true && wr.counts.warn >= 3, wr.counts.warn + ' warnings, ready=' + wr.ready);
  check('  ...and the verdict tells the operator to read them anyway',
    /warning/.test(wr.verdict), wr.verdict);

  const empty = P.grade({ frames: [], attest: {} });
  check('an empty set is reported once, not as 31 separate failures',
    empty.empty === true && empty.ready === false && empty.results.length === 0, empty.verdict);

  check('every result carries an id, a clause, a kind and a status',
    P.grade(cleanSet()).results.every(r => r.id && r.clause && r.kind && r.status));

  /* The kinds have to partition the report, or the "what did the machine
     actually check" summary is a fiction. */
  const kinds = {};
  for (const r of P.grade(cleanSet()).results) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  check('the report splits into auto / declared / manual / deferred and nothing else',
    Object.keys(kinds).sort().join(',') === 'auto,declared,deferred,manual',
    JSON.stringify(kinds));
  check('  ...and the manual bucket is the big one, which is the honest answer',
    kinds.manual === P.ATTESTATIONS.length && kinds.manual >= 10, String(kinds.manual));
}

/* =====================================================================
   6. Scope - what this ticket does NOT do
   ===================================================================== */
console.log('\n== 6. the deferred gates are named, not silently skipped ==');
{
  const r = P.grade(cleanSet());
  const def = r.results.filter(x => x.kind === 'deferred');
  check('all five post-SfM gates from section 8.3 are listed', def.length === 5,
    def.map(d => d.id).join(', '));
  check('  ...every one carries its threshold and its clause',
    def.every(d => /8\.3/.test(d.clause) && d.detail.length > 10));
  check('  ...every one says it needs a reconstruction this onramp does not run',
    def.every(d => /reconstruction/.test(d.detail)));
  check('  ...and none of them blocks ready', r.ready === true);
  check('track length and the azimuth gap are both there - neither substitutes for the other',
    def.some(d => d.id === 'sfm.tracklen') && def.some(d => d.id === 'sfm.azimuthgap'));
  check('the reprojection gate is carried as "report it", not as a quality bar',
    def.find(d => d.id === 'sfm.reproj').threshold.indexOf('report it') === 0);

  /* Nothing in this module may reach for a reconstruction backend, a repair
     pass, or live capture guidance. Check the source says so and does not. */
  const src = fs.readFileSync(path.join(ROOT, 'nso_photoset.js'), 'utf8');
  /* Strip comments first. The header says "does not call COLMAP or Meshroom"
     deliberately, and a scan that cannot tell prose from a call site would
     make stating the scope the thing that fails the scope check. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const forbidden = [/\bColmap\b/i, /\bMeshroom\b/i, /\bfetch\s*\(/, /XMLHttpRequest/, /NSO_Repair\./, /require\s*\(/];
  const hit = forbidden.find(re => re.test(code));
  check('the module calls no reconstruction backend, no network and no repair pipeline',
    hit === undefined, hit ? 'found ' + hit : 'clean');
  check('  ...and says out loud that reconstruction, repair and live guidance are out of scope',
    /does not reconstruct/i.test(src) && /repair/i.test(src) && /guide a capture/i.test(src));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
