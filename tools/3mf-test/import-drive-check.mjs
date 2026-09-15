#!/usr/bin/env node
/**
 * nest-optimizer / tools/3mf-test / import-drive-check.mjs
 *
 * 3MF import through the real app, in headless Chromium.
 *
 * import-check.js proves the reader; this proves the wiring: the file input
 * accepts .3mf, handleFiles() routes it to the reader, each object becomes a
 * model with rawTris in file axes (so Cut / Sculpt / the STL exporter all work
 * on it), and a model that came in from a 3MF goes back out through both
 * export routes. Then the app's own 3MF export is re-imported - export ->
 * import -> same geometry - which is the round trip a user would actually hit.
 *
 * Usage:
 *   node tools/3mf-test/import-drive-check.mjs
 *   CHROME_PATH=/path/to/chrome node tools/3mf-test/import-drive-check.mjs
 */
import { chromium } from 'playwright';
import { readFile, mkdtemp } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRoot, routeCdn, mkCheck, launchOpts } from '../cth-test/browser-lib.mjs';

const check = mkCheck();

async function importFile(page, file, name) {
  const bytes = Array.from(await readFile(file));
  const before = await page.evaluate(() => state.models.length);
  await page.evaluate(([b, n]) => {
    handleFiles([new File([new Uint8Array(b)], n)]);
  }, [bytes, name]);
  return before;
}

/** Same shape import-check.js asserts on, read off the app's own model record. */
function describe(m) {
  // m.size is display space: x, y = height, z. Report as (x, depth, height) = Bambu (x, y, z).
  const r = (v) => Math.round(v * 1000) / 1000;
  return { name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : null, rawAxis: m.rawAxis,
           size: [r(m.size.x), r(m.size.z), r(m.size.y)] };
}

async function main() {
  const served = await serveRoot();
  const base = served.base;
  const browser = await chromium.launch(launchOpts());
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const cdn = routeCdn(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

  console.log(`\nNest at ${base}/index.html`);
  await page.goto(`${base}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.state && window.state.ready', null, { timeout: 20000 });

  console.log('\n--- the build under test ---');
  check('nothing hit the CDN unrouted', cdn.filter((s) => s.startsWith('UNROUTED')), []);
  check('NSO3MFRead is in this build', await page.evaluate(() => typeof window.NSO3MFRead), 'object');
  check('the file input accepts .3mf',
    await page.evaluate(() => document.getElementById('file-input').accept), '.stl,.3mf');

  console.log('\n--- a Bambu Studio file, split object part, scaled item ---');
  await importFile(page, 'fixtures/3mf/pa_pattern.3mf', 'pa_pattern.3mf');
  await page.waitForFunction('state.models.length === 1', null, { timeout: 20000 });
  const cube = await page.evaluate(() => {
    const m = state.models[0];
    return { name: m.name, tris: m.rawTris.length / 9, rawAxis: m.rawAxis,
             size: [m.size.x, m.size.z, m.size.y].map((v) => Math.round(v * 1000) / 1000) };
  });
  check('one model, named from the file\'s model_settings', cube.name, 'Cube');
  check('rawTris carries the 12 triangles in file axes', [cube.tris, cube.rawAxis], [12, 'zup']);
  check('the item scale was applied: 5 x 5 x 0.85 mm', cube.size, [5, 5, 0.85]);
  check('it was placed on the plate', await page.evaluate(() => state.placed.length), 1);

  console.log('\n--- a Bambu Studio file, ten inline objects ---');
  await importFile(page, 'fixtures/3mf/flowrate-test-pass2.3mf', 'flowrate-test-pass2.3mf');
  await page.waitForFunction('state.models.length === 11', null, { timeout: 20000 });
  const ten = await page.evaluate(() => state.models.slice(1).map((m) => ({
    name: m.name, tris: m.rawTris.length / 9,
    size: [m.size.x, m.size.z, m.size.y].map((v) => Math.round(v * 1000) / 1000) })));
  const xml = execFileSync('unzip', ['-p', 'fixtures/3mf/flowrate-test-pass2.3mf', '3D/3dmodel.model'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  check('ten more models, named from <object name>',
    ten.map((m) => m.name), [...xml.matchAll(/<object [^>]*name="([^"]*)"/g)].map((m) => m[1]));
  check('their triangles add up to the raw XML',
    ten.reduce((n, m) => n + m.tris, 0), (xml.match(/<triangle[\s/>]/g) || []).length);
  check('each is 40 x 30 x 1.4 mm', ten.map((m) => m.size), ten.map(() => [40, 30, 1.4]));
  const status = await page.evaluate(() => document.getElementById('status').textContent);
  check('the status line reports the multi-object load', /Loaded 10 objects from flowrate-test-pass2\.3mf/.test(status), true);

  console.log('\n--- the imported cube goes back out through both export routes ---');
  await page.evaluate(() => {
    const m = state.models.find((x) => x.name === 'Cube');
    document.querySelector(`[data-edit-id="${m.id}"]`).click();
  });
  check('the cube is the active model', await page.evaluate(() => getActiveModel().name), 'Cube');
  const outDir = await mkdtemp(join(tmpdir(), 'nso-3mf-import-drive-'));

  await page.selectOption('#export-format', 'stl');
  page.once('dialog', (d) => d.accept());
  const [stlDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-model')]);
  const stlFile = join(outDir, stlDl.suggestedFilename());
  await stlDl.saveAs(stlFile);
  const stl = await readFile(stlFile);
  check('"Download selected STL" of an imported 3MF model is a 12-triangle binary STL',
    [stlDl.suggestedFilename(), stl.readUInt32LE(80), stl.length], ['Cube.stl', 12, 84 + 50 * 12]);
  const wt = spawnSync('python3', ['tools/stl_watertight_check.py', stlFile, '--odd', '--degen'],
    { encoding: 'utf8' });
  check('and it passes the canonical watertight checker (exit 0)',
    wt.status === 0 ? 'clean' : (wt.stdout + wt.stderr).trim(), 'clean');

  await page.selectOption('#export-format', '3mf');
  page.once('dialog', (d) => d.accept());
  const [mfDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-model')]);
  const mfFile = join(outDir, mfDl.suggestedFilename());
  await mfDl.saveAs(mfFile);
  check('"Download selected 3MF" of an imported 3MF model downloads Cube.3mf', mfDl.suggestedFilename(), 'Cube.3mf');

  console.log('\n--- and that export comes back in: export -> import -> same shape ---');
  await importFile(page, mfFile, 'Cube.3mf');
  await page.waitForFunction('state.models.length === 12', null, { timeout: 20000 });
  const again = await page.evaluate(() => {
    const m = state.models[state.models.length - 1];
    return { name: m.name, tris: m.rawTris.length / 9,
             size: [m.size.x, m.size.z, m.size.y].map((v) => Math.round(v * 1000) / 1000) };
  });
  check('the re-imported model is named from NSO\'s own model_settings', again.name, 'Cube');
  check('same 12 triangles, same 5 x 5 x 0.85 mm', [again.tris, again.size], [12, [5, 5, 0.85]]);
  // Corner-for-corner: the exporter re-centres on the plate, so compare after
  // removing each soup's own minimum corner.
  const corners = await page.evaluate(() => {
    const norm = (raw) => {
      const mn = [Infinity, Infinity, Infinity];
      for (let i = 0; i < raw.length; i += 3) for (let k = 0; k < 3; k++) mn[k] = Math.min(mn[k], raw[i + k]);
      const out = [];
      for (let i = 0; i < raw.length; i++) out.push(Math.round((raw[i] - mn[i % 3]) * 1e4) / 1e4);
      return out;
    };
    const a = state.models.find((x) => x.name === 'Cube');
    const b = state.models[state.models.length - 1];
    const na = norm(a.rawTris), nb = norm(b.rawTris);
    let maxErr = 0;
    for (let i = 0; i < na.length; i++) maxErr = Math.max(maxErr, Math.abs(na[i] - nb[i]));
    return maxErr;
  });
  check('every corner of the re-import matches the original import (after the plate shift)', corners < 1e-3, true);

  console.log('\n--- what a bad file does ---');
  await page.evaluate(() => handleFiles([new File([new Uint8Array([1, 2, 3, 4])], 'junk.3mf')]));
  await page.waitForFunction(() => /Failed to load junk\.3mf/.test(document.getElementById('status').textContent),
    null, { timeout: 10000 });
  check('a non-3MF .3mf is reported, not thrown',
    await page.evaluate(() => document.getElementById('status').textContent), 'Failed to load junk.3mf: Not a ZIP archive (no end-of-central-directory record)');
  check('the model count did not change', await page.evaluate(() => state.models.length), 12);

  check('no uncaught page errors', errors, []);
  await browser.close();
  served.srv.close();
  return check.report();
}

main().then((failed) => process.exit(failed ? 1 : 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
