#!/usr/bin/env node
/**
 * nest-optimizer / tools/3mf-test / export-drive-check.mjs
 *
 * Drives the real app, in headless Chromium, all the way to a .3mf on disk,
 * and then takes the file apart.
 *
 * roundtrip-check.js covers the modules in isolation: the format rules, the
 * archive, the profile table. What it cannot reach is the app itself - the
 * <script> tags, the profile selector, the button wiring, and
 * buildPlacedObjects3MF() turning real packed pieces into 3MF objects. That is
 * all browser, and it needs THREE, so it runs here.
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

  // --- the selector the user actually sees ---
  console.log('\n--- the cooling profile selector ---');
  const opts = await page.evaluate(() =>
    Array.from(document.getElementById('cooling-profile').options).map((o) => o.value));
  check('selector is populated from the profile table',
    opts, Profiles.listProfiles().map((p) => p.id));
  check('it defaults to the confirmed profile',
    await page.evaluate(() => document.getElementById('cooling-profile').value),
    Profiles.DEFAULT_PROFILE_ID);
  check('the 3MF button starts disabled with an empty plate',
    await page.evaluate(() => document.getElementById('btn-export-3mf').disabled), true);

  // --- import a fixture through the app's own importer, then pack it ---
  console.log('\n--- driving the app ---');
  const stl = Array.from(await readFile(FIXTURE));
  await page.evaluate(async (bytes) => {
    const buf = new Uint8Array(bytes);
    handleFiles([new File([buf], 'box-20mm.stl', { type: 'model/stl' })]);
  }, stl);
  await page.waitForFunction('state.models.length > 0', null, { timeout: 20000 });

  await page.click('#btn-optimize');
  await page.waitForFunction('state.placed.length > 0', null, { timeout: 20000 });
  const placed = await page.evaluate(() => state.placed.length);
  check('a piece is on the plate after Optimize', placed > 0, true);
  check('the 3MF button is enabled once the plate has pieces',
    await page.evaluate(() => document.getElementById('btn-export-3mf').disabled), false);

  // --- press the real button and catch the real download ---
  const outDir = await mkdtemp(join(tmpdir(), 'nso-3mf-drive-'));
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-3mf'),
  ]);
  const file = join(outDir, download.suggestedFilename());
  await download.saveAs(file);
  check('the download is named .3mf', /\.3mf$/.test(download.suggestedFilename()), true);
  console.log(`       saved ${file}`);

  const status = await page.evaluate(() =>
    (document.getElementById('status') || {}).textContent || '');
  check('the app reports the baked profile', /cooling profile/.test(status), true);

  // --- the piece the app packed actually made it into the archive ---
  const expectedObjects = await page.evaluate(() => state.placed.length);
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

  return check.report();
}

main().then((failed) => process.exit(failed ? 1 : 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
