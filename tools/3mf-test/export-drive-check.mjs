#!/usr/bin/env node
/**
 * nest-optimizer / tools/3mf-test / export-drive-check.mjs
 *
 * Drives the real app, in headless Chromium, all the way to a .3mf on disk,
 * and then takes the file apart.
 *
 * roundtrip-check.js covers the modules in isolation: the format rules, the
 * archive, the profile table. What it cannot reach is the app itself - the
 * <script> tags, the Format selector that switches both export buttons between
 * STL and 3MF, the profile selector, the button wiring, and
 * buildPlacedObjects3MF() / buildActiveModelObject3MF() turning real pieces
 * into 3MF objects. That is all browser, and it needs THREE, so it runs here.
 *
 * Two exports are driven end to end: "Export plate" (every placed piece, one
 * object each) and "Download selected" (the active model alone), both with
 * Format = 3MF. Then Format goes back to STL and the plate button is pressed
 * once more, so the STL route is shown to still be wired.
 *
 * index.html names three (and the manifold kernel) on cdn.jsdelivr.net, which
 * this runner cannot reach; browser-lib serves the copies already in the repo
 * and in devDependencies, so nothing needs the network.
 *
 * It does not trust the app's own status line. The export is captured as a real
 * browser download, re-opened from disk, and every cooling value is read back
 * out of the archive and compared against what the profile table says.
 *
 * Usage:
 *   node tools/3mf-test/export-drive-check.mjs
 *   CHROME_PATH=/path/to/chrome node tools/3mf-test/export-drive-check.mjs
 */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts } from '../cth-test/browser-lib.mjs';

const require = createRequire(import.meta.url);
const Profiles = require('../../nso-cooling-profiles.js');
const NSO3MF = require('../../nso-3mf.js');

const FIXTURE = 'fixtures/box-20mm.stl';
const check = mkCheck();

async function main() {
  const served = await serveRoot();
  const base = served.base;

  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\nNest at ${base}/index.html`);
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });

  // --- the modules actually reached the page ---
  console.log('\n--- the build under test ---');
  check('three was fetched', cdn.includes('three@0.147.0/build/three.min.js'), true);
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('NSOCoolingProfiles is in this build',
    await page.evaluate(() => typeof window.NSOCoolingProfiles), 'object');
  check('NSO3MF is in this build',
    await page.evaluate(() => typeof window.NSO3MF), 'object');

  // --- the format choice the user actually sees ---
  console.log('\n--- the export format selector ---');
  check('the Format selector offers STL and 3MF',
    await page.evaluate(() =>
      Array.from(document.getElementById('export-format').options).map((o) => o.value)),
    ['stl', '3mf']);
  check('3MF is selectable (its modules loaded)',
    await page.evaluate(() =>
      document.querySelector('#export-format option[value="3mf"]').disabled), false);
  check('a fresh session defaults to STL',
    await page.evaluate(() => document.getElementById('export-format').value), 'stl');
  check('with STL selected the buttons say STL',
    await page.evaluate(() => [
      document.getElementById('btn-export-model').textContent,
      document.getElementById('btn-export-stl').textContent,
      document.getElementById('ctx-export').textContent]),
    ['Download selected STL', 'Export plate STL', 'Export STL']);
  check('with STL selected the cooling row is hidden',
    await page.evaluate(() => document.getElementById('cooling-profile-row').hidden), true);

  await page.selectOption('#export-format', '3mf');
  check('switching to 3MF relabels both buttons and the right-click item',
    await page.evaluate(() => [
      document.getElementById('btn-export-model').textContent,
      document.getElementById('btn-export-stl').textContent,
      document.getElementById('ctx-export').textContent]),
    ['Download selected 3MF', 'Export plate 3MF', 'Export 3MF']);
  check('switching to 3MF reveals the cooling row',
    await page.evaluate(() => document.getElementById('cooling-profile-row').hidden), false);
  check('the choice is remembered for next time',
    await page.evaluate(() => localStorage.getItem('nso.exportFormat')), '3mf');

  // --- the cooling profile selector ---
  console.log('\n--- the cooling profile selector ---');
  const opts = await page.evaluate(() =>
    Array.from(document.getElementById('cooling-profile').options).map((o) => o.value));
  check('selector is populated from the profile table',
    opts, Profiles.listProfiles().map((p) => p.id));
  check('it defaults to the confirmed profile',
    await page.evaluate(() => document.getElementById('cooling-profile').value),
    Profiles.DEFAULT_PROFILE_ID);
  check('the plate button starts disabled with an empty plate',
    await page.evaluate(() => document.getElementById('btn-export-stl').disabled), true);

  /* --- put real pieces on the plate, through the app's own paths ---
     Deliberately NOT via "Optimize plate". runOptimize() throws on this branch
     before it packs anything: app-core.js reads #opt-orient and #opt-rotate,
     and neither element exists in index.html (already true at 63c5b00, so it
     predates the 3MF work). An earlier version of this check pressed Optimize
     and then asserted `state.placed.length > 0` - which passed for the wrong
     reason, because handleFiles() already places the imported piece. Importing
     and cloning reaches the same place honestly and does not rest on a
     function that is currently broken. */
  console.log('\n--- driving the app ---');
  const stl = Array.from(await readFile(FIXTURE));
  await page.evaluate(async (bytes) => {
    const buf = new Uint8Array(bytes);
    handleFiles([new File([buf], 'box-20mm.stl', { type: 'model/stl' })]);
  }, stl);
  await page.waitForFunction('state.models.length > 0', null, { timeout: 20000 });
  check('importing the fixture puts one piece on the plate',
    await page.evaluate(() => state.placed.length), 1);

  // Clone it, so the export has to carry more than one object.
  await page.evaluate(() => { state.selectedIndex = 0; updateAdjustUI(); });
  await page.click('#btn-clone');
  await page.waitForFunction('state.placed.length === 2', null, { timeout: 20000 });
  check('cloning gives the plate a second piece',
    await page.evaluate(() => state.placed.length), 2);
  check('the plate button is enabled once the plate has pieces',
    await page.evaluate(() => document.getElementById('btn-export-stl').disabled), false);

  // --- press the real plate button, Format = 3MF, and catch the real download ---
  const outDir = await mkdtemp(join(tmpdir(), 'nso-3mf-drive-'));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl'),
  ]);
  const file = join(outDir, download.suggestedFilename());
  await download.saveAs(file);
  check('"Export plate" with Format = 3MF downloads a .3mf',
    /\.3mf$/.test(download.suggestedFilename()), true);
  console.log(`       saved ${file}`);

  const status = await page.evaluate(() =>
    (document.getElementById('status') || {}).textContent || '');
  check('the app reports the baked profile', /cooling profile/.test(status), true);

  // --- the piece the app packed actually made it into the archive ---
  const expectedObjects = await page.evaluate(() => state.placed.length);

  // --- "Download selected", Format = 3MF: the active model alone ---
  console.log('\n--- the selected-model export ---');
  // The app prompts for a filename; accept its suggestion, as a user pressing
  // Enter would. Playwright dismisses dialogs by default, which would read as
  // "Export cancelled".
  // The clone is the active model at this point (the app strips ".stl" from
  // names on import, so it is "box-20mm-copy1"); read it rather than assume it.
  const activeName = await page.evaluate(() => getActiveModel().name);
  page.once('dialog', (d) => d.accept());
  const [pieceDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-model'),
  ]);
  const pieceFile = join(outDir, 'selected-' + pieceDownload.suggestedFilename());
  await pieceDownload.saveAs(pieceFile);
  check('"Download selected" with Format = 3MF downloads a .3mf named after the active model',
    pieceDownload.suggestedFilename(), activeName + '.3mf');
  console.log(`       saved ${pieceFile}`);
  const pieceStatus = await page.evaluate(() =>
    (document.getElementById('status') || {}).textContent || '');
  check('the app reports the baked profile for the selected model',
    /cooling profile/.test(pieceStatus), true);

  // --- Format back to STL: the same plate button now writes STL ---
  console.log('\n--- the STL route is still wired ---');
  await page.selectOption('#export-format', 'stl');
  const [stlDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl'),
  ]);
  check('"Export plate" with Format = STL downloads a .stl',
    /\.stl$/.test(stlDownload.suggestedFilename()), true);
  const stlFile = join(outDir, stlDownload.suggestedFilename());
  await stlDownload.saveAs(stlFile);
  const stlBytes = await readFile(stlFile);
  check('the STL is binary STL with the plate\'s triangles',
    stlBytes.length === 84 + 50 * stlBytes.readUInt32LE(80) && stlBytes.readUInt32LE(80) > 0, true);

  // --- the choice survives a reload ---
  await page.selectOption('#export-format', '3mf');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });
  check('after a reload the Format selector comes back as 3MF',
    await page.evaluate(() => document.getElementById('export-format').value), '3mf');
  check('and the buttons come back labelled 3MF',
    await page.evaluate(() => [
      document.getElementById('btn-export-model').textContent,
      document.getElementById('btn-export-stl').textContent]),
    ['Download selected 3MF', 'Export plate 3MF']);

  check('no uncaught page errors', errors, []);
  await browser.close();
  served.srv.close();

  // --- take the file apart, off the browser entirely ---
  console.log('\n--- the exported file ---');
  try {
    execFileSync('unzip', ['-tqq', file], { stdio: 'pipe' });
    check('archive passes third-party `unzip -t`', true, true);
  } catch (err) {
    check('archive passes third-party `unzip -t`',
      String(err.stderr || err.message).trim(), true);
  }

  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .trim().split('\n').sort();
  check('every OPC part is present', names, [
    '3D/3dmodel.model', 'Metadata/model_settings.config',
    'Metadata/nso_profile.json', 'Metadata/project_settings.config',
    '[Content_Types].xml', '_rels/.rels',
  ].sort());

  const text = execFileSync('unzip', ['-p', file, NSO3MF.PART_PROJECT_SETTINGS],
    { encoding: 'utf8' });
  const parsed = Profiles.parseProjectSettings(text);   // throws on shape drift
  const expected = Profiles.resolveValues(Profiles.DEFAULT_PROFILE_ID);

  check('exact key set and order survived', Object.keys(parsed), Object.keys(expected));
  check('only the confirmed cooling keys are in the file',
    Profiles.validateValues(parsed), []);

  for (const key of Object.keys(expected)) {
    check(`  ${key} = ${JSON.stringify(expected[key])}`, parsed[key], expected[key]);
  }

  // The '%' rule, read straight off the exported bytes.
  const pctWrong = Object.keys(expected).filter((k) =>
    (parsed[k].includes('%')) !== (Profiles.KEY_FORMATS[k].type === 'percent'));
  check('"%" on percent fields, absent on numeric fields', pctWrong, []);

  // A tolerant JSON parser could hide a formatting slip; the raw text cannot.
  const rawMissing = Object.keys(expected).filter((k) =>
    !text.includes(`    ${JSON.stringify(k)}: [${JSON.stringify(expected[k])}]`));
  check('raw text carries each key verbatim as "key": ["value"]', rawMissing, []);

  // The geometry the app packed is really in there.
  const model = execFileSync('unzip', ['-p', file, NSO3MF.PART_MODEL], { encoding: 'utf8' });
  check('an object per packed piece reached the model part',
    (model.match(/<object /g) || []).length, expectedObjects);
  check('the model part has vertices', (model.match(/<vertex /g) || []).length > 0, true);
  check('the model part has triangles', (model.match(/<triangle /g) || []).length > 0, true);

  // Plate coordinates, not the packer's plate-centred ones: nothing negative,
  // nothing past the 180 mm A1 Mini plate, and the piece sits on z = 0.
  const xs = [...model.matchAll(/<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/g)]
    .map((m) => m.slice(1).map(Number));
  check('every vertex is inside the plate in X/Y',
    xs.every(([x, y]) => x >= 0 && x <= 180 && y >= 0 && y <= 180), true);
  check('the piece rests on the plate (min Z = 0)',
    Math.min(...xs.map((v) => v[2])) < 1e-6, true);

  const prov = JSON.parse(execFileSync('unzip', ['-p', file, NSO3MF.PART_NSO_PROFILE],
    { encoding: 'utf8' }));
  check('provenance records which profile was baked in',
    prov.cooling_profile, Profiles.DEFAULT_PROFILE_ID);

  // --- the selected-model file, taken apart the same way ---
  console.log('\n--- the selected-model file ---');
  try {
    execFileSync('unzip', ['-tqq', pieceFile], { stdio: 'pipe' });
    check('selected-model archive passes third-party `unzip -t`', true, true);
  } catch (err) {
    check('selected-model archive passes third-party `unzip -t`',
      String(err.stderr || err.message).trim(), true);
  }
  const pieceText = execFileSync('unzip', ['-p', pieceFile, NSO3MF.PART_PROJECT_SETTINGS],
    { encoding: 'utf8' });
  const pieceParsed = Profiles.parseProjectSettings(pieceText);
  check('selected-model export carries the same 14 keys in order',
    Object.keys(pieceParsed), Object.keys(expected));
  check('selected-model export carries the same values, "%" included',
    Object.keys(expected).map((k) => pieceParsed[k]),
    Object.keys(expected).map((k) => expected[k]));
  check('selected-model project_settings.config is byte-identical to the plate export',
    pieceText, text);

  const pieceModel = execFileSync('unzip', ['-p', pieceFile, NSO3MF.PART_MODEL], { encoding: 'utf8' });
  check('selected-model export holds exactly one object',
    (pieceModel.match(/<object /g) || []).length, 1);
  const pv = [...pieceModel.matchAll(/<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)"/g)]
    .map((m) => m.slice(1).map(Number));
  check('selected-model has vertices', pv.length > 0, true);
  const pxs = pv.map((v) => v[0]), pys = pv.map((v) => v[1]), pzs = pv.map((v) => v[2]);
  check('selected-model rests on the plate (min Z = 0)', Math.min(...pzs) < 1e-6, true);
  check('selected-model is centred on the 180 mm plate in X/Y',
    [Math.abs((Math.min(...pxs) + Math.max(...pxs)) / 2 - 90) < 1e-3,
     Math.abs((Math.min(...pys) + Math.max(...pys)) / 2 - 90) < 1e-3], [true, true]);
  check('selected-model is the 20 mm box',
    [Math.max(...pxs) - Math.min(...pxs), Math.max(...pys) - Math.min(...pys), Math.max(...pzs)]
      .map((d) => Math.round(d * 1000) / 1000), [20, 20, 20]);
  const pieceSettings = execFileSync('unzip', ['-p', pieceFile, NSO3MF.PART_MODEL_SETTINGS],
    { encoding: 'utf8' });
  check('selected-model is named after the active model in model_settings.config',
    pieceSettings.includes('<metadata key="name" value="' + activeName + '"/>'), true);

  return check.report();
}

main().then((failed) => process.exit(failed ? 1 : 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
