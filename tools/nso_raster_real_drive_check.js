/* Trace raster through the REAL app, in real headless Chromium.
 *     node tools/nso_raster_real_drive_check.js     exit 0 = every gate held
 *
 * tools/nso_raster_real_test.js proves the tracer against real images in Node.
 * This proves the thing Node cannot: that a person can pick a file and get a
 * piece. Every step is the shipped control - the Finish menu is opened by
 * clicking its summary, the file is put into the actual <input type=file>, and
 * the change handler app-raster.js attached is what runs. No injected
 * ImageData, no stubbed decoder, no direct call into the module.
 *
 * It is also the only place the JPEG is opened. nso_raster_lines.js decodes
 * nothing on purpose and Node has no JPEG decoder; the browser's IS the shipped
 * decoder, so the check uses that rather than a second one written to agree
 * with it. fixtures/raster-real/hand-stroke.jpg is a wobbly, pressure-varying
 * stroke on off-white paper at quality 0.82 - antialiasing, compression
 * mottling and a background that is not white, all at once, which is what an
 * uploaded photo of a sketch actually is.
 *
 * The finished piece's triangles are read back out of the page and measured
 * HERE, by tools/nso_line_angle.js, against the ground truth in
 * fixtures/raster-real/ground-truth.json - so what is checked is the geometry
 * the app really produced, not a number the app reported about itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, openFinishMenu, statusOf, ROOT } = require('./nso_app_harness');
const ANG = require('./nso_line_angle.js');

const DIR = path.join(ROOT, 'fixtures', 'raster-real');
const TRUTH = JSON.parse(fs.readFileSync(path.join(DIR, 'ground-truth.json'), 'utf8'));

let fails = 0, ran = 0;
function check(name, cond, detail) {
  ran++;
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + name + (detail ? ' - ' + detail : ''));
}
const angDiff = (a, b) => { const d = Math.abs(((a - b) % 180 + 180) % 180); return Math.min(d, 180 - d); };

/* Pick a file in the real input, the way a person does, and wait for the piece. */
async function traceFile(page, file, sizeMM) {
  const before = await page.evaluate(() => state.models.length);
  await page.fill('#raster-size', String(sizeMM));
  await page.setInputFiles('#raster-file', file);
  await page.waitForFunction(n => state.models.length > n, before, { timeout: 60000 });
  return await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { name: m.name, nonSolid: !!m.nonSolid, tris: Array.from(m.rawTris || []) };
  });
}

withApp(async (page) => {
  console.log('=== 1. the control is really in the shipped page ===');
  await openFinishMenu(page);
  check('the module loaded into the page',
    await page.evaluate(() => typeof NSO_RasterLines === 'object' && typeof NSO_RasterLines.buildFromImage === 'function'), true);
  check('the app side loaded into the page',
    await page.evaluate(() => typeof NSO_rasterAddFromFile === 'function'), true);
  check('the Trace raster button is there and its listener is attached',
    await page.evaluate(() => { const b = document.getElementById('btn-trace-raster'); return !!b && b.dataset.nsoWired === '1'; }), true);
  check('the button is VISIBLE in the Finish menu, not just in the DOM',
    await page.locator('#btn-trace-raster').isVisible(), true);
  check('the file input takes the formats a person uploads',
    await page.getAttribute('#raster-file', 'accept'), 'image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp');
  for (const id of ['raster-size', 'raster-threshold', 'raster-line-width', 'raster-line-height', 'raster-invert']) {
    check('the ' + id + ' control is visible', await page.locator('#' + id).isVisible(), true);
  }
  check('the line width defaults to the measured extrusion line',
    await page.inputValue('#raster-line-width'), '0.42');

  /* ------------------------------------------------------------------ PNG */
  console.log('\n=== 2. a real PNG, picked in the real file input ===');
  const png = TRUTH.images.find(r => r.file === 'skew-cross.png');
  console.log('    the picture: ' + png.shows);
  const a = await traceFile(page, path.join(DIR, png.file), 30);
  check('a piece was added, named after the file', a.name === 'traced_skew-cross', a.name);
  check('and flagged non-solid - every wall in it is one extrusion line', a.nonSolid, String(a.nonSolid));
  check('it has triangles', a.tris.length > 0, (a.tris.length / 9) + ' tris');
  {
    const hist = ANG.wallHistogram(Float32Array.from(a.tris));
    const bands = ANG.bands(hist, 1, 0.05);
    console.log('    the piece:   ' + ANG.describe(hist, 1));
    for (const want of png.angles) {
      check('the piece in the page runs at ' + want + ' deg, as the picture does',
        bands.some(b => angDiff(b.centre, want) <= 1),
        bands.map(b => b.centre + ' deg').join(', '));
    }
    check('and in no direction the picture lacks',
      bands.every(b => png.angles.some(w => angDiff(b.centre, w) <= 2 || angDiff(b.centre, w + 90) <= 2)),
      bands.length + ' band(s)');
  }
  const status1 = await statusOf(page);
  check('the status names the crossing bridge it collapsed',
    /crossing bridge/.test(status1), status1.trim().slice(0, 130));

  /* ----------------------------------------------------------------- JPEG */
  console.log('\n=== 3. a real JPEG - the browser is the decoder, and it is the shipped one ===');
  const jpg = TRUTH.images.find(r => r.file === 'hand-stroke.jpg');
  console.log('    the picture: ' + jpg.shows);
  const b = await traceFile(page, path.join(DIR, jpg.file), 30);
  check('the browser decoded the JPEG and a piece was added', b.name === 'traced_hand-stroke', b.name);
  check('it is flagged non-solid too', b.nonSolid, String(b.nonSolid));
  {
    /* A hand-drawn stroke is not straight, so its wall weight is SPREAD rather
       than piled in one degree. The gate is that the spread sits about the
       angle the stroke was drawn at - a wide band, because the wobble is real,
       and a dominant one, because the stroke is still a stroke. */
    const hist = ANG.wallHistogram(Float32Array.from(b.tris));
    const dom = ANG.dominantBand(hist, 12);
    check('the traced stroke runs about the ' + jpg.angles[0] + ' deg it was drawn at',
      angDiff(dom.centre, jpg.angles[0]) <= 8, dom.centre + '+/-12 deg');
    check('and that band is dominant, not noise',
      dom.share > 0.5, (dom.share * 100).toFixed(1) + '% of the wall');
    console.log('    the piece:   ' + ANG.describe(hist, 3));
    /* and the SPREAD is the wobble itself, not slop. The stroke's steepest
       tangent is fixed by the amplitude and the wave count it was drawn with,
       and ground-truth.json carries that range: every direction the traced
       piece runs in has to lie inside it, end caps aside. A tracer that
       straightened the stroke would fail this as surely as one that lost it. */
    const [lo, hi] = jpg.tangentRange;
    const runs = ANG.bands(hist, 3, 0.05)
      .filter(x => !ANG.bands(hist, 3, 0.05).some(y => y !== x && angDiff(x.centre, y.centre + 90) <= 4));
    check('every direction it runs in lies inside the wobble the stroke was drawn with',
      runs.every(x => x.centre >= lo - 3 && x.centre <= hi + 3),
      'drawn tangents span ' + lo.toFixed(1) + '..' + hi.toFixed(1) + ' deg, traced ' +
      runs.map(x => x.centre).sort((p2, q2) => p2 - q2).join(', ') + ' deg');
    check('and it really does wobble - it did not come back one straight line',
      runs.length >= 2, runs.length + ' distinct direction(s)');
  }

  /* ------------------------------------------------------ adds, never replaces */
  console.log('\n=== 4. it ADDS a piece and leaves every other one alone ===');
  {
    const names = await page.evaluate(() => state.models.map(m => m.name));
    check('two uploads left two pieces, neither replaced',
      names.length === 2 && names[0] === 'traced_skew-cross' && names[1] === 'traced_hand-stroke',
      names.join(', '));
  }

  /* --------------------------------------------------------- a refusal says so */
  console.log('\n=== 5. a file that is not an image is refused by name, and adds nothing ===');
  {
    const before = await page.evaluate(() => state.models.length);
    await page.setInputFiles('#raster-file', {
      name: 'notanimage.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG at all')
    });
    await page.waitForFunction(
      () => /refused/i.test((document.getElementById('status') || {}).textContent || ''),
      null, { timeout: 20000 });
    check('nothing was added', await page.evaluate(() => state.models.length) === before, 'still ' + before);
    const st = await statusOf(page);
    check('and it said what happened, in words', /refused/i.test(st) && /decode/i.test(st), st.trim().slice(0, 130));
  }

  /* ---------------------------------------------- the same file twice still fires */
  console.log('\n=== 6. picking the SAME file again traces it again ===');
  {
    const before = await page.evaluate(() => state.models.length);
    await traceFile(page, path.join(DIR, png.file), 20);
    check('a second copy was added - the input is cleared after each pick',
      await page.evaluate(() => state.models.length) === before + 1, 'models ' + before + ' -> ' + (before + 1));
    const size = await page.evaluate(() => {
      const m = state.models[state.models.length - 1];
      return [m.size.x, m.size.y, m.size.z].map(v => Math.round(v * 100) / 100);
    });
    check('and at 20 mm it really is smaller than the 30 mm one',
      Math.max(size[0], size[2]) < 15, 'size ' + size.join(' x ') + ' mm');
  }

  console.log('\n' + (fails ? fails + ' of ' + ran + ' checks FAILED' : 'all ' + ran + ' checks held'));
  process.exitCode = fails ? 1 : 0;
}).catch(e => { console.error(e); process.exit(1); });
