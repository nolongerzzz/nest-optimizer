/* Drive check: the photo-set onramp through the REAL controls, end to end.
     node tools/nso_photoset_drive_check.js           local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_photoset_drive_check.js

   Same standard as the other drive checks: every step is a click on the
   shipped UI, and the verdict asserted is the one the browser rendered.

   THE FIXTURES ARE REAL JPEGS. The pixel statistics need a decoder, so the
   frames are rendered in the page with canvas.toDataURL('image/jpeg') and an
   APP1 segment is spliced onto each one here. That gives 93 files that
   Chromium genuinely decodes and that carry genuine EXIF - which is the only
   way this check can claim anything about the focus and framing statistics.

   Flow:
     1. 93 in-contract frames through the real file input
     2. the drawer opens by itself; verdict is NOT READY, because 11
        attestations are untinked - the whole point of the feature
     3. every automatic check has passed on its own
     4. tick the 11 boxes by clicking them; verdict flips to READY
     5. the deferred section is on screen and says a reconstruction is needed
     6. re-load with one frame shot at a different focal length: FAIL, named
     7. re-load with 92 frames: FAIL on the shot list, naming which pass

   Scope note: nothing here reconstructs anything. The check asserts the
   report, which is where this ticket ends.                                 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, ROOT } = require('./nso_app_harness');
const { exifFor, spliceExif } = require('./nso_photoset_fixtures.js');
const PS = require(path.join(ROOT, 'nso_photoset.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-photoset-'));

/* Rendered in the page: a mid-grey backdrop with a speckled subject filling
   ~70 % of the short side, which is inside the contract's 60-80 % window and
   carries enough texture for the focus statistic to be non-trivial. `seed`
   varies the speckle so no two frames are byte-identical - a duplicate would
   trip the duplicate check and this set is meant to be clean. */
async function renderJPEG(page, seed) {
  return await page.evaluate((s) => {
    const W = 640, H = 480;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#808080';
    x.fillRect(0, 0, W, H);
    /* subject: 0.70 * 480 = 336 px tall, centred */
    const sh = Math.round(H * 0.70), sw = 300;
    const x0 = (W - sw) >> 1, y0 = (H - sh) >> 1;
    x.fillStyle = '#2a2a2a';
    x.fillRect(x0, y0, sw, sh);
    let r = (s * 2654435761) >>> 0;
    const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 4000; i++) {
      const px = x0 + Math.floor(rnd() * sw), py = y0 + Math.floor(rnd() * sh);
      x.fillStyle = rnd() > 0.5 ? '#e8e8e8' : '#111111';
      x.fillRect(px, py, 2, 2);
    }
    return c.toDataURL('image/jpeg', 0.92);
  }, seed);
}

function writeFrame(dir, name, dataUrl, exifOverrides) {
  const raw = Buffer.from(dataUrl.split(',')[1], 'base64');
  const withExif = spliceExif(new Uint8Array(raw), exifFor(exifOverrides));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(withExif));
  return file;
}

/* Names carry the pass, which is how an operator who shot the list names
   them, and which app-photoset.js's guessPass picks up. */
function shotListNames() {
  const names = [];
  for (const p of PS.CONTRACT.passes) {
    for (let k = 0; k < p.frames; k++) {
      names.push(p.id + '_' + String(k + 1).padStart(2, '0') + '.jpg');
    }
  }
  return names;
}

function stampAt(i) {
  const t = new Date(Date.UTC(2026, 2, 1, 10, 0, 0) + i * 20000);
  const p = n => String(n).padStart(2, '0');
  return t.getUTCFullYear() + ':' + p(t.getUTCMonth() + 1) + ':' + p(t.getUTCDate()) + ' ' +
    p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds());
}

/* Files are fed through the real <input type="file">, then we wait for the
   panel to finish measuring all of them. */
async function loadSet(page, files) {
  await page.evaluate(() => {
    window.NSO_PhotoSetUI.state.frames = [];
    window.NSO_PhotoSetUI.state.attest = {};
  });
  await page.setInputFiles('#photoset-input', files);
  await page.waitForFunction(
    n => window.NSO_PhotoSetUI.state.frames.length === n,
    files.length, { timeout: 120000 });
  /* one more tick so the report has rendered */
  await page.waitForFunction(() => !!document.querySelector('#photoset-report .ps-row'), null, { timeout: 15000 });
}

const reportOf = page => page.evaluate(() => {
  const r = window.NSO_PhotoSetUI.state.report;
  return {
    ready: r.ready, verdict: r.verdict, counts: r.counts, frames: r.frames,
    results: r.results.map(x => ({ id: x.id, kind: x.kind, status: x.status, detail: x.detail }))
  };
});
const statusOf = (rep, id) => (rep.results.find(x => x.id === id) || {}).status;
const detailOf = (rep, id) => (rep.results.find(x => x.id === id) || {}).detail || '';

withApp(async (page, logs) => {
  console.log('== the onramp, driven through the shipped controls ==');

  // Photo set is a top-bar dropdown now, so the panel is only laid out once
  // its menu is open. Unfold it, then ask the same question of the same id.
  await page.evaluate(() => { const e = document.getElementById('photoset-card');
    for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  check('the card is on the page', await page.isVisible('#photoset-card'));
  check('  ...and the modules loaded', await page.evaluate(
    () => typeof window.NSO_PhotoSet === 'object' && typeof window.NSO_Exif === 'object'));
  check('the report drawer starts closed', await page.isHidden('#photoset-drawer'));

  /* --- build 93 real, in-contract frames --------------------------------- */
  const names = shotListNames();
  const good = path.join(OUT, 'good');
  fs.mkdirSync(good);
  const files = [];
  for (let i = 0; i < names.length; i++) {
    const url = await renderJPEG(page, i + 1);
    files.push(writeFrame(good, names[i], url, { when: stampAt(i) }));
  }
  check('93 real JPEGs built, each with EXIF spliced on', files.length === 93,
    fs.statSync(files[0]).size + ' bytes each, roughly');

  /* --- 1-3: load them, and read the verdict ------------------------------ */
  await loadSet(page, files);
  check('the drawer opened by itself once the set was measured', await page.isVisible('#photoset-drawer'));

  let rep = await reportOf(page);
  check('all 93 frames were measured', rep.frames === 93);
  check('the verdict is NOT READY, because nothing has been vouched for yet',
    rep.ready === false && /NOT READY/.test(rep.verdict), rep.verdict);
  check('  ...and it is the attestations blocking, not a failure',
    rep.counts.fail === 0 && rep.counts.todo === PS.ATTESTATIONS.length,
    JSON.stringify(rep.counts));

  check('the filenames pre-filled the pass assignment, so the shot list counts',
    statusOf(rep, 'count.perPass') === 'pass', detailOf(rep, 'count.perPass'));
  check('the shot list is complete', statusOf(rep, 'count.total') === 'pass', detailOf(rep, 'count.total'));
  check('the spliced EXIF was read back through the real file input',
    statusOf(rep, 'optics.focal') === 'pass' && /24 mm/.test(detailOf(rep, 'optics.focal')),
    detailOf(rep, 'optics.focal'));
  check('no duplicate frames - the speckle seed differs per frame',
    statusOf(rep, 'count.duplicates') === 'pass', detailOf(rep, 'count.duplicates'));
  check('one frame size across the set', statusOf(rep, 'format.dimensions') === 'pass',
    detailOf(rep, 'format.dimensions'));

  /* The two statistics that need a real decode. This is the assertion that
     could not be made in the unit test at all. */
  const stats = await page.evaluate(() => {
    const f = window.NSO_PhotoSetUI.state.frames;
    const sharp = f.map(x => x.sharpness).filter(v => typeof v === 'number');
    const fill = f.map(x => x.fill).filter(v => typeof v === 'number');
    return { nSharp: sharp.length, nFill: fill.length, minSharp: Math.min(...sharp), medFill: fill.sort((a, b) => a - b)[fill.length >> 1] };
  });
  check('every frame was decoded and measured for focus', stats.nSharp === 93, 'min score ' + stats.minSharp.toFixed(0));
  check('every frame was measured for subject fill', stats.nFill === 93);
  check('  ...and the fill estimate recovers the 70 % the fixture was drawn at',
    Math.abs(stats.medFill - 0.70) < 0.06, stats.medFill.toFixed(3));
  check('the focus check passes on a sharp set', statusOf(rep, 'focus.relative') === 'pass',
    detailOf(rep, 'focus.relative'));
  check('the framing check passes on a 70 % subject', statusOf(rep, 'framing.fill') === 'pass',
    detailOf(rep, 'framing.fill'));

  /* --- 4: tick the attestations, by clicking them ------------------------ */
  const nBoxes = (await page.$$('#photoset-report .ps-tick input[type=checkbox]')).length;
  check('the manual clauses are on screen as ticks, one per attestation',
    nBoxes === PS.ATTESTATIONS.length, nBoxes + ' checkboxes');
  /* Each tick regrades and redraws the report, so a handle taken before the
     click is detached by the time the next one is used. Re-query every time -
     which is also what a user does, since they are clicking what is on screen
     now, not what was there eleven renders ago. */
  for (let i = 0; i < nBoxes; i++) {
    const sel = '#photoset-report .ps-tick input[type=checkbox]';
    await page.$$eval(sel, (els, k) => { if (!els[k].checked) els[k].click(); }, i);
  }

  rep = await reportOf(page);
  check('with all 11 vouched for, the verdict flips to READY',
    rep.ready === true && /^READY/.test(rep.verdict), rep.verdict);
  check('  ...and nothing is left to confirm', rep.counts.todo === 0, JSON.stringify(rep.counts));
  check('the banner in the drawer says so too',
    /READY/.test(await page.textContent('#photoset-report .photoset-verdict')));
  check('the card\'s own verdict line agrees with the drawer',
    /READY/.test(await page.textContent('#photoset-verdict')));

  /* --- 5: scope, on screen ---------------------------------------------- */
  const body = await page.textContent('#photoset-report');
  check('the report says on screen that a reconstruction is still needed',
    /needs a reconstruction/i.test(body));
  check('  ...and names the post-SfM gates it did not check',
    /track length/i.test(body) && /azimuth gap/i.test(body));
  check('  ...and the deferred rows carry no verdict that could be read as a pass',
    rep.results.filter(r => r.kind === 'deferred').every(r => r.status === 'deferred'));
  check('the manual section explains WHY a machine cannot decide those',
    (await page.$$('#photoset-report .ps-why')).length >= PS.ATTESTATIONS.length);

  /* --- 6: one frame at a different focal length -------------------------- */
  const bad = path.join(OUT, 'focal');
  fs.mkdirSync(bad);
  const badFiles = [];
  for (let i = 0; i < names.length; i++) {
    const url = await renderJPEG(page, i + 1);
    const over = { when: stampAt(i) };
    if (i === 50) { over.focal = [35, 1]; over.focal35 = 39; }
    badFiles.push(writeFrame(bad, names[i], url, over));
  }
  await loadSet(page, badFiles);
  rep = await reportOf(page);
  check('one frame zoomed mid-capture fails, through the real input',
    statusOf(rep, 'optics.focal') === 'fail' && rep.ready === false,
    detailOf(rep, 'optics.focal'));
  check('  ...and the lens check catches the same event from the other side',
    statusOf(rep, 'optics.lens') === 'fail', detailOf(rep, 'optics.lens'));

  /* --- 7: a short shoot -------------------------------------------------- */
  await loadSet(page, badFiles.slice(0, 92).filter((_, i) => i < 92));
  rep = await reportOf(page);
  check('92 frames fails the shot list', statusOf(rep, 'count.total') === 'fail',
    detailOf(rep, 'count.total'));
  check('  ...and the per-pass count names which pass is short',
    statusOf(rep, 'count.perPass') === 'fail' && /Flip top/.test(detailOf(rep, 'count.perPass')),
    detailOf(rep, 'count.perPass'));

  /* --- the page stayed clean -------------------------------------------- */
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors while driving the panel', errs.length === 0, errs.join(' | ') || 'clean');

  console.log('\n' + (fails ? fails + ' FAILED' : 'all checks passed'));
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('DRIVE CHECK FAIL', e); process.exit(1); });
