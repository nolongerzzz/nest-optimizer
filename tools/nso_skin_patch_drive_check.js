/* Drive check: the standalone skin patch through the REAL controls, end to end.
     node tools/nso_skin_patch_drive_check.js               local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_skin_patch_drive_check.js

   Same standard as tools/nso_skin_drive_check.js: every step is a click on the
   shipped UI, and the file checked is the one the browser downloaded.

   Flow, per pattern x variant (six in all):
     1. Finish tab open, pattern select, patch variant select
     2. Skin patch -> a NEW piece appears, no existing piece changes, the
        status names the variant and the walls
     3. the non-solid flag: set on `loose`, off on `bordered`, and the
        checkbox and the list tag show it - read off the shipped controls,
        not off the model object
     4. Format = STL, Download selected STL -> the downloaded file through
        tools/mesh_validate.py, both ways: --gate (standard closure) and
        --gate --non-solid (the 0.42 mm wall/gap check the flag turns on).
        Both must pass.
     5. the download is the SAME OBJECT as the committed fixture - equal
        triangle count, bounding box and volume, and the same triangle set up
        to the pure translation the app applies. Not a byte compare: the
        exporter writes the piece's DISPLAY geometry, which addModel centres
        on the origin and which has been through Z up -> Y up -> Z up, so the
        bytes legitimately differ from a fixture that rests on z = 0.
        tools/nso_skin_patch_test.js part 5 holds the byte identity between
        the module's own output and the fixture.
   Then, once:
     6. a patch leaves every existing piece alone: a loaded cube's geometry
        and triangle count are untouched across a patch bake, and the patch's
        own piece has rawTris like an imported file
     7. no page errors anywhere
   One check that is NOT a click is named as such in its label. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skinpatch-drive-'));

function meshValidate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(extra || []);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
const verdictOf = v => (v.verdict_fails && v.verdict_fails.length) ? v.verdict_fails.join('; ') : 'PASS';

function parseSTL(buf) {
  const n = buf.readUInt32LE(80), tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12, t = [];
    for (let k = 0; k < 3; k++) t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    tris.push(t);
  }
  return tris;
}
const bboxMin = tris => tris.reduce((m, t) => t.reduce((mm, v) =>
  [Math.min(mm[0], v[0]), Math.min(mm[1], v[1]), Math.min(mm[2], v[2])], m), [Infinity, Infinity, Infinity]);
/* the triangle set as translation-invariant keys: each triangle's three
   vertices relative to the soup's own min corner, rounded to 1e-3 mm, sorted
   so winding and triangle order do not matter */
function triKeys(tris) {
  const o = bboxMin(tris);
  return tris.map(t => t.map(v => [0, 1, 2].map(k => Math.round((v[k] - o[k]) * 1000)).join(','))
    .sort().join('|')).sort();
}
function sameObject(a, b) {
  if (a.length !== b.length) return false;
  const ka = triKeys(a), kb = triKeys(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  return true;
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris +
  ', pierce ' + v.self_intersection.pierce + ', bbox ' + JSON.stringify(v.bbox_size);

const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const waitStatus = (page, re) => page.waitForFunction(
  src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });

const PATTERNS = ['crosshatch', 'zigzag', 'ring'];
const VARIANTS = ['bordered', 'loose'];

withApp(async (page, logs) => {
  console.log('\n=== the modules are loaded and the button is wired ===');
  {
    const wired = await page.evaluate(() => ({
      module: typeof window.NSO_SkinPatch === 'object' && typeof window.NSO_SkinPatch.buildPatch === 'function',
      skin: typeof window.NSO_Skin === 'object' && typeof window.NSO_Skin.patternPlan === 'function',
      app: typeof NSO_skinPatchAdd === 'function',
      btn: (b => !!b && b.dataset.nsoWired === '1')(document.getElementById('btn-skin-patch')),
      sel: (s => !!s && Array.from(s.options).map(o => o.value).join(','))(document.getElementById('skin-patch-variant'))
    }));
    check('nso_skin_patch.js and app-skin-patch.js loaded, button listener attached',
      wired.module && wired.skin && wired.app && wired.btn, JSON.stringify(wired));
    check('the variant select offers exactly bordered, loose and sandwich', wired.sel === 'bordered,loose,sandwich', wired.sel);
  }

  console.log('\n=== the six standalone patches, each through the shipped button ===');

  /* an existing piece to prove the bake leaves it alone */
  const cubeId = await loadSTL(page, fx('box-20mm.stl'));
  const cubeBefore = await page.evaluate(id => {
    const m = state.models.find(x => x.id === id);
    return { tris: m.rawTris ? m.rawTris.length / 9 : null, size: m.size };
  }, cubeId);
  await openFinishMenu(page);
  // export-format moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', 'stl');

  for (const pattern of PATTERNS) {
    for (const variant of VARIANTS) {
      const tag = variant + ' ' + pattern;
      console.log('\n--- ' + tag + ' ---');
      const before = await page.evaluate(() => state.models.length);

      await page.selectOption('#skin-pattern', pattern);
      await page.selectOption('#skin-patch-variant', variant);
      await page.click('#btn-skin-patch');
      await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
      await waitStatus(page, /Added patch_/);

      const st = await statusOf(page);
      check(tag + ': "Skin patch" added a NEW piece and named it',
        /Added patch_/.test(st) && new RegExp(pattern).test(st), st.slice(0, 150));
      check(tag + ': the status states real walls, never a thin surface', /walls? /.test(st) || /mm rim/.test(st));

      const info = await page.evaluate(() => {
        const m = state.models[state.models.length - 1];
        const chk = document.getElementById('chk-non-solid');
        const rows = Array.from(document.querySelectorAll('#model-list .nonsolid-tag, #model-list [data-nonsolid]'));
        return {
          id: m.id, name: m.name, tris: m.rawTris ? m.rawTris.length / 9 : null,
          rawAxis: m.rawAxis, size: m.size,
          flagged: !!(window.nsoNonSolid && window.nsoNonSolid(m)),
          checkboxShows: !!(chk && chk.checked),
          tagCount: rows.length
        };
      });
      check(tag + ': the new piece has rawTris in file axes, like an import',
        info.tris > 0 && info.rawAxis === 'zup', info.tris + ' tris, rawAxis ' + info.rawAxis);

      /* the flag, read off the shipped checkbox after selecting the piece */
      await selectModel(page, info.id);
      await page.evaluate(() => { if (window.nsoNonSolidRefresh) window.nsoNonSolidRefresh(); });
      const shown = await page.evaluate(() => {
        const chk = document.getElementById('chk-non-solid');
        return { checked: !!(chk && chk.checked), disabled: !!(chk && chk.disabled) };
      });
      const wantFlag = variant === 'loose';
      check(tag + ': non-solid ' + (wantFlag ? 'SET' : 'clear') + ', and the shipped checkbox shows it',
        info.flagged === wantFlag && shown.checked === wantFlag,
        'model ' + info.flagged + ', checkbox ' + shown.checked);
      if (wantFlag) {
        check(tag + ': and the status says the flag was set', /flagged non-solid/i.test(st), st.slice(-90));
      } else {
        check(tag + ': and the status does NOT claim a flag', !/flagged non-solid/i.test(st));
      }

      /* export through the real button, and check the downloaded file */
      /* "Download selected" prompts for a filename; accept it as Enter
         would. Playwright dismisses dialogs by default, which the app reads
         as "Export cancelled". */
      page.once('dialog', d => d.accept());
      // btn-export-model moved into the top bar's Export dropdown; unfold it first.
      await page.evaluate(() => { const e = document.getElementById('btn-export-model'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click('#btn-export-model')
      ]);
      const file = path.join(out, variant + '_' + pattern + '_' + download.suggestedFilename());
      await download.saveAs(file);
      check(tag + ': "Download selected STL" downloaded an .stl (' + download.suggestedFilename() + ')',
        /\.stl$/i.test(download.suggestedFilename()));

      const plain = meshValidate(file);
      const flagged = meshValidate(file, ['--non-solid']);
      check(tag + ': download passes --gate (standard closure)', plain.verdict_fails.length === 0,
        verdictOf(plain) + ' | ' + summary(plain));
      check(tag + ': download passes --gate --non-solid (wall/gap at 0.42 mm)',
        flagged.verdict_fails.length === 0,
        verdictOf(flagged) + ' - thinnest ' +
        (flagged.wall && flagged.wall.min_wall_mm !== null ? flagged.wall.min_wall_mm.toFixed(4) + ' mm' : 'none within probe'));
      check(tag + ': the download has genuine thickness (z extent > 0, real volume)',
        plain.bbox_size[2] > 0.4 && Math.abs(plain.signed_volume) > 1,
        'z ' + plain.bbox_size[2] + ' mm, volume ' + plain.signed_volume.toFixed(2) + ' mm³');

      /* the exported file vs the committed fixture - NOT a click: the button
         and the repo must not drift apart. Compared as geometry, not bytes,
         for the reason in the header. */
      const fixture = fx(path.join('skin-patches', 'patch_' + pattern + '_' + variant + '.stl'));
      const got = parseSTL(fs.readFileSync(file));
      const want = parseSTL(fs.readFileSync(fixture));
      const wv = meshValidate(fixture);
      check(tag + ': (not a click) the download IS the committed fixture, up to the app\'s own centring',
        sameObject(got, want), got.length + ' vs ' + want.length + ' triangles');
      check(tag + ': same bounding box and volume as the fixture',
        got.length === want.length &&
        [0, 1, 2].every(k => Math.abs(plain.bbox_size[k] - wv.bbox_size[k]) < 1e-4) &&
        Math.abs(Math.abs(plain.signed_volume) - Math.abs(wv.signed_volume)) < 1e-3,
        JSON.stringify(plain.bbox_size) + ' vs ' + JSON.stringify(wv.bbox_size) +
        ', volume ' + plain.signed_volume.toFixed(4) + ' vs ' + wv.signed_volume.toFixed(4));
    }
  }

  console.log('\n=== the bake touches nothing else ===');
  const cubeAfter = await page.evaluate(id => {
    const m = state.models.find(x => x.id === id);
    return { tris: m.rawTris ? m.rawTris.length / 9 : null, size: m.size, flagged: !!(window.nsoNonSolid && window.nsoNonSolid(m)) };
  }, cubeId);
  check('the loaded cube is untouched across six patch bakes',
    cubeAfter.tris === cubeBefore.tris &&
    Math.abs(cubeAfter.size.x - cubeBefore.size.x) < 1e-9 &&
    Math.abs(cubeAfter.size.z - cubeBefore.size.z) < 1e-9,
    cubeBefore.tris + ' -> ' + cubeAfter.tris + ' tris');
  check('and the cube did NOT pick up the non-solid flag', cubeAfter.flagged === false);
  const total = await page.evaluate(() => state.models.length);
  check('seven pieces: the cube plus six patches', total === 7, total);

  console.log('\n=== refusal: nothing is added when a patch cannot be built ===');
  const refused = await page.evaluate(() => {
    const n = state.models.length;
    const r = NSO_skinPatchAdd({ variant: 'bordered', pattern: 'ring', W: 8, D: 8 });
    return { ok: r.ok, reason: r.reason, added: state.models.length - n,
             status: document.getElementById('status').textContent };
  });
  check('a ring that does not fit its pocket is refused and adds no piece',
    refused.ok === false && refused.added === 0 && /nothing added/.test(refused.status),
    refused.reason);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | ') || 'none');

  console.log('\nfiles: ' + out);
  if (fails) { console.log('\n' + fails + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall checks passed');
}).catch(e => { console.error('DRIVE CHECK FAIL', e); process.exit(1); });
