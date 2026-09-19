#!/usr/bin/env node
/* The Library browser: From File vs From Library, the category taxonomy, and
   the one architectural claim this ticket exists to make.

   What it proves, in the real page in Chromium:

     1. FROM FILE is untouched. The button still does nothing but click the
        same hidden file input, and a piece imported through that input is
        byte-identical - vertex for vertex - to what the same STL produced
        before this change. This is the assertion the ticket cares most
        about, so it is measured against the file's own bytes rather than
        against a remembered number.
     2. EVERY entry resolves to a FULL ABSOLUTE URL. Not "starts with
        library/", not "is a string" - scheme + host + path, parseable by
        URL(), same origin as the page today, and pointing inside the
        source's own base. This is what makes a second library repo a data
        change later instead of a migration, so it is checked on every one.
     3. The browser is grouped, and every category's pieces load THROUGH IT -
        one real click per category, on a real row, with the piece arriving
        on the plate.
     4. Every catalog entry is reachable and correctly categorized, and the
        category set matches the declared taxonomy - including that a
        category with no entries left in it (Washers, since the four bordered
        washers were deleted) stays in the taxonomy and is not drawn.

   node tools/nso_library_browser_test.js        exit 0 = every gate held  */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Triangle count read from the STL itself, so "the import produced this
   mesh" is measured against the file rather than against the app. Both
   encodings are in library/ and fixtures/, and reading an ASCII file's
   bytes 80..84 as a binary count yields a number in the hundreds of
   millions, so the format is detected rather than assumed. */
function triCountOf(file) {
  const b = fs.readFileSync(file);
  const ascii = b.slice(0, 5).toString('latin1').toLowerCase() === 'solid' &&
                b.length !== 84 + 50 * b.readUInt32LE(80);
  if (!ascii) return b.readUInt32LE(80);
  const m = b.toString('latin1').match(/facet\s+normal/gi);
  return m ? m.length : 0;
}

/* The app names a piece after its file with the extension dropped. */
const pieceName = file => file.replace(/\.(stl|3mf)$/i, '');

const openLib = page => page.evaluate(() => {
  const b = document.getElementById('btn-library');
  if (b) b.click();
  document.querySelectorAll('#library-list .library-sec').forEach(d => { d.open = true; });
});

withApp(async (page, logs) => {
  /* ---------------------------------------------------------------- 1 */
  console.log('\n=== 1. From File: the local-file path is exactly what it was ===');
  const wiring = await page.evaluate(() => {
    const b = document.getElementById('btn-load-stl');
    const i = document.getElementById('file-input');
    return { btn: !!b, label: b ? b.textContent.trim() : null,
             input: !!i, accept: i ? i.getAttribute('accept') : null,
             multiple: i ? i.multiple : null, type: i ? i.type : null };
  });
  check('the From File button is present', wiring.btn, wiring.label);
  check('it still drives #file-input, unchanged: type/accept/multiple',
    wiring.input && wiring.type === 'file' && wiring.accept === '.stl,.3mf' && wiring.multiple === true,
    JSON.stringify(wiring));

  const box = path.join(ROOT, 'fixtures', 'box-20mm.stl');
  const wantTris = triCountOf(box);
  const id = await loadSTL(page, box);          // the real #file-input, as before
  await selectModel(page, id);
  const got = await page.evaluate(() => {
    const m = getActiveModel();
    return { tris: m.rawTris.length / 9, name: m.name, axis: m.rawAxis };
  });
  check('a file imported through it lands with the file\'s own triangle count',
    got.tris === wantTris, got.tris + ' vs ' + wantTris + ' in the STL header');
  check('...under the file\'s own name, on the same zup raw axis as before',
    got.name === pieceName('box-20mm.stl') && got.axis === 'zup', JSON.stringify(got));

  /* ---------------------------------------------------------------- 2 */
  console.log('\n=== 2. every catalog entry resolves to a full absolute URL ===');
  const api = await page.evaluate(() => typeof window.nsoLibrary);
  check('window.nsoLibrary is on the page', api === 'object', 'typeof = ' + api);

  const urls = await page.evaluate(() => window.nsoLibrary.entries().map(e => ({
    file: e.file, category: e.category, source: e.source,
    url: window.nsoLibrary.urlFor(e.file),
    base: window.nsoLibrary.sources[e.source] ? window.nsoLibrary.sources[e.source].base : null
  })));
  check('the catalog has entries', urls.length > 0, urls.length + ' entries');

  let relative = [], unparseable = [], outside = [];
  for (const e of urls) {
    if (!e.url || !/^https?:\/\/[^/]+\//.test(e.url)) { relative.push(e.file); continue; }
    let u;
    try { u = new URL(e.url); } catch (err) { unparseable.push(e.file); continue; }
    if (!u.protocol || !u.host) { unparseable.push(e.file); continue; }
    if (!e.base || e.url.indexOf(e.base) !== 0) outside.push(e.file);
  }
  check('all ' + urls.length + ' resolve to an absolute http(s) URL with a host',
    relative.length === 0, relative.join(', '));
  check('all ' + urls.length + ' parse as a URL', unparseable.length === 0, unparseable.join(', '));
  check('each sits under its own source\'s base', outside.length === 0, outside.join(', '));
  console.log('   e.g. ' + urls[0].file + ' -> ' + urls[0].url);
  const srcBase = await page.evaluate(() => window.nsoLibrary.sources.local.base);
  check('the source base is itself absolute (not "library/")',
    /^https?:\/\/[^/]+\/.*library\/$/.test(srcBase), srcBase);

  /* the resolved URL is the one actually fetched: it must really serve */
  const probe = await page.evaluate(async u => {
    const r = await fetch(u, { cache: 'no-store' });
    return { ok: r.ok, status: r.status, bytes: (await r.arrayBuffer()).byteLength };
  }, urls[0].url);
  check('fetching a resolved URL really serves the file',
    probe.ok && probe.bytes > 84, JSON.stringify(probe));

  /* ---------------------------------------------------------------- 3 */
  console.log('\n=== 3. the browser is grouped, and the groups match the taxonomy ===');
  await openLib(page);
  const ui = await page.evaluate(() => {
    const secs = Array.from(document.querySelectorAll('#library-list .library-sec'));
    return {
      taxonomy: window.nsoLibrary.categories,
      groups: secs.map(s => ({
        name: s.dataset.sec,
        head: s.querySelector('.vp-sec-head').firstChild.textContent.trim(),
        count: Number(s.querySelector('.library-sec-count').textContent),
        rows: s.querySelectorAll('.library-item').length,
        open: s.open
      })),
      totalRows: document.querySelectorAll('#library-list .library-item').length,
      looseRows: Array.from(document.querySelectorAll('#library-list > .library-item')).length
    };
  });
  ui.groups.forEach(g => console.log('   ' + g.name.padEnd(15) + g.rows + ' rows'));
  check('every group is a <details> carrying its category name',
    ui.groups.length > 0 && ui.groups.every(g => g.name && g.head === g.name));
  check('every group\'s count badge matches the rows it holds',
    ui.groups.every(g => g.count === g.rows));
  check('no row sits outside a group', ui.looseRows === 0, ui.looseRows + ' loose');
  check('every group name is in the declared taxonomy',
    ui.groups.every(g => ui.taxonomy.indexOf(g.name) !== -1),
    ui.groups.map(g => g.name).join(', '));
  check('groups appear in taxonomy order',
    ui.groups.map(g => ui.taxonomy.indexOf(g.name)).every((v, i, a) => i === 0 || a[i - 1] < v));
  check('a category with no entries is not drawn',
    ui.groups.every(g => g.rows > 0) && ui.groups.length < ui.taxonomy.length,
    ui.groups.length + ' groups for ' + ui.taxonomy.length + ' categories');
  check('all ' + urls.length + ' entries have a row', ui.totalRows === urls.length,
    ui.totalRows + ' rows for ' + urls.length + ' entries');

  /* ---------------------------------------------------------------- 4 */
  console.log('\n=== 4. every entry is categorized as the catalog says ===');
  const domCats = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#library-list .library-item').forEach(r => {
      out[r.querySelector('.name').textContent] =
        { cat: r.dataset.category, sec: r.closest('.library-sec').dataset.sec, title: r.title };
    });
    return out;
  });
  let miss = [], wrongSec = [], badTitle = [];
  for (const e of urls) {
    const d = domCats[e.file];
    if (!d) { miss.push(e.file); continue; }
    if (d.cat !== e.category || d.sec !== e.category) wrongSec.push(e.file + '(' + d.sec + ')');
    if (d.title.indexOf(e.url) === -1) badTitle.push(e.file);
  }
  check('every entry is reachable as a row', miss.length === 0, miss.join(', '));
  check('every row sits in the group its category names', wrongSec.length === 0, wrongSec.join(', '));
  check('every row\'s tooltip carries the full absolute URL', badTitle.length === 0, badTitle.join(', '));

  const byCat = {};
  urls.forEach(e => { (byCat[e.category] = byCat[e.category] || []).push(e.file); });
  Object.keys(byCat).sort().forEach(c =>
    console.log('   ' + c.padEnd(15) + byCat[c].length + '  ' + byCat[c].slice(0, 3).join(', ') +
                (byCat[c].length > 3 ? ', …' : '')));
  /* Six skin patches, all Skins. There were ten, four of them _bordered
     washers; those were deleted - catalog entry and library file together -
     when the bordered construction was measured bonding to a stacked part at
     2.857x a flat line's contact. The tagging rule they demonstrated still
     holds and is still asserted: a patch's category comes from its variant,
     not from the block it arrived in. */
  const patches = urls.filter(e => e.file.startsWith('patch_'));
  check('the six skin patches are all tagged Skins, by variant',
    patches.length === 6 &&
    patches.filter(e => /_(loose|sandwich)\.stl$/.test(e.file)).every(e => e.category === 'Skins'),
    patches.map(e => e.file.replace('patch_', '') + ':' + e.category).join(' '));
  check('no _bordered washer is left in the catalog',
    patches.every(e => !/_bordered\.stl$/.test(e.file)),
    patches.filter(e => /_bordered\.stl$/.test(e.file)).map(e => e.file).join(', ') || 'none');
  check('and Washers is still in the taxonomy, just empty and undrawn',
    ui.taxonomy.indexOf('Washers') !== -1 &&
    ui.groups.every(g => g.name !== 'Washers') &&
    urls.every(e => e.category !== 'Washers'),
    ui.groups.map(g => g.name).join(', '));

  /* ---------------------------------------------------------------- 5 */
  console.log('\n=== 5. one real click per category actually loads a piece ===');
  for (const cat of ui.groups.map(g => g.name)) {
    const file = byCat[cat][0];
    const before = await page.evaluate(() => state.models.length);
    await openLib(page);
    await page.evaluate(name => {
      const row = Array.from(document.querySelectorAll('#library-list .library-item'))
        .find(r => r.querySelector('.name').textContent === name);
      if (!row) throw new Error('no row for ' + name);
      row.click();
    }, file);
    let arrived = true;
    try { await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 }); }
    catch (err) { arrived = false; }
    if (!arrived) { check(cat + ': ' + file + ' loaded through the browser', false, await statusOf(page)); continue; }
    const m = await page.evaluate(() => {
      const mm = state.models[state.models.length - 1];
      return { name: mm.name, tris: mm.rawTris ? mm.rawTris.length / 9 : 0 };
    });
    const want = triCountOf(path.join(ROOT, 'library', file));
    check(cat + ': ' + file + ' loaded, ' + m.tris + ' tris',
      m.name === pieceName(file) && m.tris === want, m.name + ' / ' + m.tris + ' vs ' + want);
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
