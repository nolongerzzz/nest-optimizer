#!/usr/bin/env node
/* Live check: every Library row, loaded from the REAL nest-library repo.

     node tools/nso_library_live_check.js                 against main
     NSO_LIBRARY_REF=<branch> node tools/nso_library_live_check.js

   The rest of the suite answers the page's raw.githubusercontent.com requests
   from disk (nso_app_harness.js + nso_library_dir.js) so it needs no network.
   That proves the page and the catalog agree with a checkout. It cannot prove
   the one thing a user depends on: that the URL each row resolves to really
   serves that piece, from GitHub, to a browser, today. This does, and it is
   NOT in package.json's testSteps for exactly that reason - it needs the
   network and it reads a repo this one does not control.

   In the real page in Chromium, with the harness's library route turned off:
     1. every catalog row resolves to a URL under the nest-library base
     2. every row, CLICKED, fetches from raw.githubusercontent.com with a 200
        and a CORS header the page accepts, and the piece arrives on the plate
        under the file's own name
     3. the piece's triangle count is the count in the bytes GitHub served
     4. with a nest-library checkout present, those bytes are byte-identical
        to the checkout's copy - the live repo and the one CI compares against
        are the same files

   NSO_LIBRARY_REF points the fetches at another branch of nest-library - for
   proving a branch before it is merged. The page still asks for main; the
   request is re-aimed at the same path on that ref, in flight, and the log
   says so. With no ref set nothing is re-aimed at all.                     */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp } = require('./nso_app_harness');
const LIB = require('./nso_library_dir');

const REF = process.env.NSO_LIBRARY_REF || LIB.REF;
const LIVE_BASE = 'https://raw.githubusercontent.com/' + LIB.OWNER + '/' + LIB.REPO + '/' +
  (REF === LIB.REF ? REF : 'refs/heads/' + REF) + '/';

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function triCountOf(b) {
  const ascii = b.slice(0, 5).toString('latin1').toLowerCase() === 'solid' &&
                b.length !== 84 + 50 * b.readUInt32LE(80);
  if (!ascii) return b.readUInt32LE(80);
  const m = b.toString('latin1').match(/facet\s+normal/gi);
  return m ? m.length : 0;
}

withApp(async (page, logs) => {
  console.log('nest-library ref: ' + REF + (REF === LIB.REF ? '' : '  (re-aimed from ' + LIB.REF + ')'));
  console.log('fetching from:    ' + LIVE_BASE);
  const checkout = LIB.libraryDir();
  console.log('checkout:         ' + (checkout || '(none - byte comparison skipped)'));

  /* What GitHub actually sent, per file, captured off the wire. */
  const got = {};
  if (REF !== LIB.REF) {
    await page.route(LIB.RAW_BASE + '**', r =>
      r.continue({ url: LIVE_BASE + r.request().url().slice(LIB.RAW_BASE.length) }));
  }
  page.on('response', async res => {
    const u = res.url();
    if (u.indexOf(LIVE_BASE) !== 0) return;
    const name = decodeURIComponent(u.slice(LIVE_BASE.length).split('?')[0]);
    let body = null;
    try { body = await res.body(); } catch (e) { /* aborted */ }
    got[name] = { status: res.status(), cors: res.headers()['access-control-allow-origin'] || null, body };
  });

  const rows = await page.evaluate(() => window.nsoLibrary.entries().map(e => ({
    file: e.file, category: e.category, source: e.source, url: window.nsoLibrary.urlFor(e.file) })));

  console.log('\n=== 1. every row resolves under the nest-library base ===');
  const off = rows.filter(r => r.url !== LIB.RAW_BASE + encodeURIComponent(r.file));
  check('all ' + rows.length + ' rows resolve to ' + LIB.RAW_BASE + '<file>', off.length === 0,
    off.map(r => r.file + ' -> ' + r.url).join(', '));

  console.log('\n=== 2-4. every row, clicked, loads the piece GitHub serves ===');
  let identical = 0, compared = 0, totalBytes = 0;
  for (const r of rows) {
    const before = await page.evaluate(() => state.models.length);
    await page.evaluate(name => {
      for (let n = document.getElementById('library-list'); n; n = n.parentElement)
        if (n.tagName === 'DETAILS') n.open = true;
      const b = document.getElementById('btn-library');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      document.querySelectorAll('#library-list .library-sec').forEach(d => { d.open = true; });
      const row = document.querySelector('#library-list .library-item[data-file="' + name + '"]');
      if (!row) throw new Error('no row for ' + name);
      row.click();
    }, r.file);
    /* The piece arrives, or loadOne() says the load failed (a 404 lands here
       in well under a second) - whichever comes first. */
    try {
      await page.waitForFunction(n => state.models.length > n ||
        /Library load failed/.test(document.getElementById('status').textContent), before, { timeout: 60000 });
    } catch (e) { /* reported below */ }
    const arrived = await page.evaluate(n => state.models.length > n, before);
    /* the response body is read asynchronously; give it a moment to land */
    for (let i = 0; i < 100 && !(got[r.file] && got[r.file].body); i++) await page.waitForTimeout(50);
    const wire = got[r.file];
    if (!arrived || !wire || !wire.body) {
      const st = await page.evaluate(() => document.getElementById('status').textContent);
      check(r.category + ': ' + r.file, false,
        'HTTP ' + (wire ? wire.status : 'no response') + ' - ' + st);
      continue;
    }
    const m = await page.evaluate(() => {
      const mm = state.models[state.models.length - 1];
      return { name: mm.name, tris: mm.rawTris ? mm.rawTris.length / 9 : 0 };
    });
    const want = triCountOf(wire.body);
    totalBytes += wire.body.length;
    let same = '';
    if (checkout) {
      const f = path.join(checkout, r.file);
      const eq = fs.existsSync(f) && fs.readFileSync(f).equals(wire.body);
      compared++; if (eq) identical++;
      same = eq ? ', = checkout' : ', DIFFERS from checkout';
      if (!eq) fails++;
    }
    check(r.category + ': ' + r.file,
      wire.status === 200 && wire.cors === '*' && m.name === r.file.replace(/\.stl$/i, '') && m.tris === want,
      'HTTP ' + wire.status + ', ' + wire.body.length + ' bytes, ' + m.tris + '/' + want + ' tris' + same);
  }
  console.log('\n' + rows.length + ' rows, ' + (totalBytes / 1048576).toFixed(2) + ' MiB served by GitHub' +
    (checkout ? ', ' + identical + '/' + compared + ' byte-identical to the checkout' : ''));

  const bad = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', bad.length === 0, bad.slice(0, 3).join(' | ') || 'clean');
}, { liveLibrary: true }).then(() => {
  if (fails) { console.log('\n' + fails + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall checks held');
}).catch(err => { console.error(err); process.exit(1); });
