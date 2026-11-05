#!/usr/bin/env node
/* Drive check: the Library delete, in the real page, through the real UI.

     node tools/nso_library_delete_drive_check.js

   WHAT IS REAL AND WHAT IS STUBBED
   The page, the rows, the x, the dialog, the focus, the keyboard, the module
   and its catalog edit are all real - every click below is a real click on
   the shipped markup. The GitHub REST API is stubbed at window.fetch.

   It has to be. A real call needs a repository write credential, which
   cannot exist in a test run, and a test that really deleted files would
   delete them from the repository it is testing. So the stub records what
   the page SENDS and answers it, and the assertions are about the request
   sequence, its payloads and its ordering - which is the part this feature
   could plausibly get wrong. The one thing the stub cannot prove is that
   GitHub accepts the calls; that is what docs/LIBRARY-DELETE.md's manual
   check is for.

   What it proves:
     1. every row carries a delete affordance, labelled, and clicking it does
        NOT load the piece
     2. the confirmation really blocks: Escape, Cancel and a backdrop click
        each leave the row, the catalog and the repository untouched, with
        ZERO requests sent
     3. no single click can delete - Delete is disabled until a token is
        typed, and the keyboard lands on Cancel
     4. confirming sends exactly four requests in the one safe order: read
        the catalog, write the catalog WITHOUT the entry, read the blob,
        delete the blob - catalog before blob, so a half-finished run can
        never leave a row pointing at a file that is gone. The catalog pair
        goes to nest-optimizer on claude-wip and the blob pair to
        nest-library on main: a row's two halves live in two repositories
        (app-library-access.js), and each request is checked for which.
     5. the row and the catalog entry then disappear from the browser, and a
        group that loses its last row is removed
     6. a refused write removes nothing: the error is shown, the row stays,
        and no blob DELETE is sent
     7. a row served from any other source is refused before a single
        request - Delete cannot say which repository its file is in
     8. no page errors  */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const LIB_SRC = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');

/* Stand in for api.github.com inside the page, recording every request. */
async function installStub(page, source) {
  await page.evaluate(src => {
    const enc = t => {
      const b = new TextEncoder().encode(t);
      let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s);
    };
    window.__gh = { calls: [], src: src, fail: null };
    const real = window.fetch.bind(window);
    window.fetch = function (url, init) {
      const u = String(url);
      if (u.indexOf('https://api.github.com/') !== 0) return real(url, init);
      const method = (init && init.method) || 'GET';
      const hdrs = (init && init.headers) || {};
      window.__gh.calls.push({
        method: method,
        url: u,
        body: init && init.body ? String(init.body) : null,
        auth: hdrs.Authorization || hdrs.authorization || ''
      });
      const f = window.__gh.fail;
      if (f && f.method === method && u.indexOf(f.match) !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ message: f.message || 'nope' }),
          { status: f.status || 403 }));
      }
      let body = {};
      if (method === 'GET' && /app-library\.js/.test(u)) body = { content: enc(window.__gh.src), sha: 'catsha' };
      else if (method === 'GET') body = { sha: 'blobsha' };
      else body = { commit: { sha: 'commit' + window.__gh.calls.length } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
  }, source);
}

const ghCalls = page => page.evaluate(() => window.__gh.calls.map(c => ({
  method: c.method, url: c.url, body: c.body, auth: c.auth })));
const resetGh = page => page.evaluate(() => { window.__gh.calls = []; window.__gh.fail = null; });
const openLib = page => page.evaluate(() => {
  // #library-list sits inside the top bar's Import dropdown now, so the
  // list is not laid out until that menu is open. Unfold it first.
  for (let n = document.getElementById('library-list'); n; n = n.parentElement)
    if (n.tagName === 'DETAILS') n.open = true;
  const b = document.getElementById('btn-library');
  if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
  document.querySelectorAll('#library-list .library-sec').forEach(d => { d.open = true; });
});
const rowSel = f => '#library-list .library-item[data-file="' + f + '"]';
const dlgOpen = page => page.evaluate(() => {
  const b = document.getElementById('nso-confirm-back');
  return !!(b && !b.hasAttribute('hidden'));
});
const entryNames = page => page.evaluate(() => window.nsoLibrary.entries().map(e => e.file));
const rowNames = page => page.evaluate(() =>
  Array.from(document.querySelectorAll('#library-list .library-item')).map(r => r.dataset.file));
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
/* The rows a category is holding right now, and how many. Read off the page
   every time rather than written down: this check used to assert that Test
   Fixtures held exactly two, which was true on the day it was written and
   false the next time somebody added a fixture. What it is actually about -
   the badge tracking the rows, and a group that empties disappearing - is
   true at any membership, so it is asked that way. */
const groupFiles = (page, cat) => page.evaluate(c => Array.from(
  document.querySelectorAll('#library-list .library-sec[data-sec="' + c + '"] .library-item'))
  .map(r => r.dataset.file), cat);
const groupSize = async (page, cat) => (await groupFiles(page, cat)).length;
let FIXTURES_BEFORE = 0;

/* Raise the dialog on one row through the real x. */
async function openConfirm(page, file) {
  await openLib(page);
  await page.click(rowSel(file) + ' .library-del');
  await page.waitForFunction(() => {
    const b = document.getElementById('nso-confirm-back');
    return !!(b && !b.hasAttribute('hidden'));
  }, null, { timeout: 5000 });
}

withApp(async (page, logs) => {
  await installStub(page, LIB_SRC);
  await openLib(page);

  /* ---------------------------------------------------------------- 1 */
  console.log('\n=== 1. every row has a labelled delete affordance, and it does not load ===');
  {
    const rows = await rowNames(page);
    const shape = await page.evaluate(() => {
      const out = { rows: 0, withBtn: 0, labelled: 0, typed: 0 };
      document.querySelectorAll('#library-list .library-item').forEach(r => {
        out.rows++;
        const b = r.querySelector('.library-del');
        if (!b) return;
        out.withBtn++;
        if ((b.getAttribute('aria-label') || '').indexOf(r.dataset.file) !== -1) out.labelled++;
        if (b.tagName === 'BUTTON' && b.type === 'button') out.typed++;
      });
      return out;
    });
    check('every one of the ' + shape.rows + ' rows has an x',
      shape.rows > 0 && shape.withBtn === shape.rows, shape.withBtn + '/' + shape.rows);
    check('each x is a real <button type=button>', shape.typed === shape.rows);
    check('each x names the file it would delete', shape.labelled === shape.rows);

    const before = await page.evaluate(() => state.models.length);
    await openConfirm(page, 'pin.stl');
    const after = await page.evaluate(() => state.models.length);
    check('clicking the x does NOT also load the piece', after === before, before + ' -> ' + after);
    check('it raises the confirmation instead', await dlgOpen(page));
    check('the catalog still lists every row', (await entryNames(page)).length === rows.length);
  }

  /* ---------------------------------------------------------------- 2/3 */
  console.log('\n=== 2. the dialog is a real block, not a speed bump ===');
  {
    const d = await page.evaluate(() => {
      const box = document.querySelector('.nso-confirm');
      return {
        role: box.getAttribute('role'),
        modal: box.getAttribute('aria-modal'),
        focused: document.activeElement ? document.activeElement.id : null,
        goDisabled: document.getElementById('nso-confirm-go').disabled,
        names: document.getElementById('nso-confirm-body').textContent,
        note: document.getElementById('nso-confirm-note').textContent
      };
    });
    check('it is an alertdialog, modal', d.role === 'alertdialog' && d.modal === 'true',
      d.role + ' / ' + d.modal);
    check('the keyboard lands on Cancel, not Delete', d.focused === 'nso-confirm-cancel', d.focused);
    check('Delete is DISABLED on arrival - no single click can delete',
      d.goDisabled === true);
    check('it names the file', /pin\.stl/.test(d.names), d.names);
    check('and names both repositories and branches it would write to',
      /nolongerzzz\/nest-optimizer on claude-wip/.test(d.note) &&
      /nolongerzzz\/nest-library on main/.test(d.note), d.note);
    check('nothing has been sent yet', (await ghCalls(page)).length === 0);
  }

  console.log('\n=== 3. Escape, Cancel and the backdrop each leave everything alone ===');
  {
    const wantRows = (await rowNames(page)).length;
    const wantEntries = (await entryNames(page)).length;

    const ways = [
      ['Escape', async () => { await page.keyboard.press('Escape'); }],
      ['Cancel', async () => { await page.click('#nso-confirm-cancel'); }],
      ['a backdrop click', async () => {
        await page.evaluate(() => {
          const b = document.getElementById('nso-confirm-back');
          b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        });
      }]
    ];
    for (const [what, act] of ways) {
      if (!(await dlgOpen(page))) await openConfirm(page, 'pin.stl');
      // type a token first: cancelling must win even when Delete is armed
      await page.fill('#nso-confirm-token', 'github_pat_pretend');
      await act();
      await page.waitForFunction(() => document.getElementById('nso-confirm-back').hasAttribute('hidden'),
        null, { timeout: 5000 }).catch(() => {});
      const closed = !(await dlgOpen(page));
      const calls = await ghCalls(page);
      await openLib(page);
      const rows = await rowNames(page);
      const entries = await entryNames(page);
      check(what + ' closes it', closed);
      check(what + ': ZERO requests were sent', calls.length === 0,
        calls.map(c => c.method).join(', ') || 'none');
      check(what + ': pin.stl is still a row and still a catalog entry',
        rows.indexOf('pin.stl') !== -1 && entries.indexOf('pin.stl') !== -1);
      check(what + ': nothing else moved either',
        rows.length === wantRows && entries.length === wantEntries,
        rows.length + ' rows, ' + entries.length + ' entries');
      check(what + ': the status says it was cancelled',
        /cancelled/i.test(await statusOf(page)), (await statusOf(page)).slice(0, 60));
      await resetGh(page);
    }
  }

  /* ---------------------------------------------------------------- 4/5 */
  console.log('\n=== 4. confirming sends four requests, catalog before blob ===');
  let calls = [];
  {
    const victim = 'box_closed.stl';
    /* How big its group is BEFORE the delete, read off the page rather than
       written down. "The badge followed the row out" is a DECREMENT, and a
       decrement needs a before. */
    FIXTURES_BEFORE = await groupSize(page, 'Test Fixtures');
    await openConfirm(page, victim);
    await page.fill('#nso-confirm-token', 'github_pat_pretend');
    const armed = await page.evaluate(() => document.getElementById('nso-confirm-go').disabled);
    check('typing a token arms Delete', armed === false);
    await page.click('#nso-confirm-go');
    await page.waitForFunction(f => !document.querySelector('#library-list .library-item[data-file="' + f + '"]'),
      victim, { timeout: 15000 });
    calls = await ghCalls(page);
    const seq = calls.map(c => c.method + ' ' + c.url.replace('https://api.github.com/repos/nolongerzzz/', ''));
    seq.forEach(s => console.log('     ' + s));
    check('exactly four requests', calls.length === 4, calls.length + '');
    check('1. GET the catalog source from nest-optimizer, on claude-wip',
      /^GET nest-optimizer\/contents\/app-library\.js\?ref=claude-wip$/.test(seq[0] || ''), seq[0]);
    check('2. PUT the catalog source back to nest-optimizer',
      /^PUT nest-optimizer\/contents\/app-library\.js$/.test(seq[1] || ''), seq[1]);
    check('3. GET the blob for its sha from nest-library, on main',
      /^GET nest-library\/contents\/box_closed\.stl\?ref=main$/.test(seq[2] || ''), seq[2]);
    check('4. DELETE the blob from nest-library',
      /^DELETE nest-library\/contents\/box_closed\.stl$/.test(seq[3] || ''), seq[3]);
    check('nothing is sent to this repo\'s library/ - the fixture copy kept there is not the row',
      calls.every(c => c.url.indexOf('/contents/library/') === -1));
    check('the catalog write happens BEFORE the blob delete - a half-run can ' +
      'orphan a file but never dangle a row',
      seq.findIndex(s => s.startsWith('PUT')) < seq.findIndex(s => s.startsWith('DELETE')));
    check('every request carries the typed token as a bearer',
      calls.every(c => c.auth === 'Bearer github_pat_pretend'),
      calls.map(c => c.auth ? 'yes' : 'NO').join(','));

    const put = JSON.parse(calls[1].body);
    const sent = Buffer.from(put.content, 'base64').toString('utf8');
    check('the PUT sends the source with the entry removed and nothing else',
      sent.indexOf("'" + victim + "'") === -1 &&
      sent.split('\n').length === LIB_SRC.split('\n').length - 1,
      (LIB_SRC.split('\n').length - sent.split('\n').length) + ' line(s) removed');
    check('it is a real conditional write - the sha it read is sent back',
      put.sha === 'catsha' && put.branch === 'claude-wip', JSON.stringify({ sha: put.sha, branch: put.branch }));
    const kill = JSON.parse(calls[3].body);
    check('the DELETE sends the blob sha it read, on nest-library\'s branch',
      kill.sha === 'blobsha' && kill.branch === 'main', JSON.stringify(kill));
    check('both commit messages name the file',
      put.message.indexOf(victim) !== -1 && kill.message.indexOf(victim) !== -1,
      put.message + ' / ' + kill.message);
    check('the dialog closes itself once the delete really went through',
      !(await dlgOpen(page)));
  }

  console.log('\n=== 5. the browser then really loses it ===');
  {
    await openLib(page);
    const rows = await rowNames(page);
    const entries = await entryNames(page);
    check('the row is gone from the list', rows.indexOf('box_closed.stl') === -1);
    check('the entry is gone from window.nsoLibrary', entries.indexOf('box_closed.stl') === -1);
    check('and nothing else went with it', rows.length === entries.length,
      rows.length + ' rows, ' + entries.length + ' entries');
    const badge = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('#library-list .library-sec'))
        .find(x => x.dataset.sec === 'Test Fixtures');
      return s ? { count: Number(s.querySelector('.library-sec-count').textContent),
                   rows: s.querySelectorAll('.library-item').length } : null;
    });
    check('the group\'s count badge followed the row out',
      badge && badge.count === badge.rows && badge.count === FIXTURES_BEFORE - 1,
      JSON.stringify(badge) + ', down from ' + FIXTURES_BEFORE);
    check('the status says what happened', /Deleted box_closed\.stl/.test(await statusOf(page)),
      (await statusOf(page)).slice(0, 70));

    /* THE LAST ROW OF A GROUP: the group itself must go, rather than being
       left drawn and empty at zero. Which files that takes is whatever the
       category is holding - seven when this was last run, two when the check
       was written - so they are read off the page and deleted one at a time
       through the same real dialog. */
    const left = await groupFiles(page, 'Test Fixtures');
    check('...and the group still has rows to be emptied of', left.length > 0,
      left.length + ': ' + left.join(', '));
    for (const f of left) {
      await resetGh(page);
      await openConfirm(page, f);
      await page.fill('#nso-confirm-token', 'github_pat_pretend');
      await page.click('#nso-confirm-go');
      await page.waitForFunction(n => !document.querySelector(
        '#library-list .library-item[data-file="' + n + '"]'), f, { timeout: 15000 });
    }
    await openLib(page);
    const secs = await page.evaluate(() => Array.from(
      document.querySelectorAll('#library-list .library-sec')).map(s => s.dataset.sec));
    check('a group that loses its last row is removed, not left empty',
      secs.indexOf('Test Fixtures') === -1, secs.join(', '));
  }

  /* ---------------------------------------------------------------- 6 */
  console.log('\n=== 6. a refused write deletes nothing ===');
  {
    await resetGh(page);
    await page.evaluate(() => {
      window.__gh.fail = { method: 'PUT', match: 'app-library.js', status: 403,
                           message: 'Resource not accessible by personal access token' };
    });
    await openConfirm(page, 'pin.stl');
    await page.fill('#nso-confirm-token', 'github_pat_pretend');
    await page.click('#nso-confirm-go');
    await page.waitForFunction(() => {
      const e = document.getElementById('nso-confirm-err');
      return e && !e.hasAttribute('hidden');
    }, null, { timeout: 15000 });
    const shown = await page.evaluate(() => document.getElementById('nso-confirm-err').textContent);
    const c = await ghCalls(page);
    check('the dialog is STILL OPEN, so the error is somewhere it can be read',
      await dlgOpen(page));
    check('the failure is shown in the dialog, in words', /403|not accessible/i.test(shown), shown);
    const armed = await page.evaluate(() => ({
      cancel: document.getElementById('nso-confirm-cancel').disabled,
      go: document.getElementById('nso-confirm-go').disabled,
      label: document.getElementById('nso-confirm-go').textContent
    }));
    check('and the buttons are live again, so the token can be corrected and retried',
      armed.cancel === false && armed.go === false && armed.label === 'Delete',
      JSON.stringify(armed));
    check('the status line says it failed', /failed/i.test(await statusOf(page)),
      (await statusOf(page)).slice(0, 80));
    check('it stopped at the refused write - no blob DELETE was sent',
      c.every(x => x.method !== 'DELETE'), c.map(x => x.method).join(', '));
    check('the row is still there', (await rowNames(page)).indexOf('pin.stl') !== -1);
    check('the catalog entry is still there', (await entryNames(page)).indexOf('pin.stl') !== -1);

    /* The dialog is a loop, not a one-shot: fix what was wrong and press
       Delete again, without starting over from the row. */
    await page.evaluate(() => { window.__gh.fail = null; });
    await page.click('#nso-confirm-go');
    await page.waitForFunction(() => document.getElementById('nso-confirm-back').hasAttribute('hidden'),
      null, { timeout: 15000 });
    const retried = await ghCalls(page);
    check('pressing Delete again after the failure retries, same dialog',
      retried.filter(x => x.method === 'DELETE').length === 1,
      retried.map(x => x.method).join(', '));
    await openLib(page);
    check('and this time the row really goes', (await rowNames(page)).indexOf('pin.stl') === -1);
    check('the dialog closed on the successful retry', !(await dlgOpen(page)));
  }

  /* ---------------------------------------------------------------- 7 */
  /* ---------------------------------------------------------------- 7 */
  console.log('\n=== 7. a row from another source is refused, with nothing sent ===');
  {
    await resetGh(page);
    /* Every shipped row is nest-library's, so this is a hand-made row on the
       'local' source - the shape a future local row would have. Through the
       module's one entry point, the same call the row's x makes. */
    await page.evaluate(() => {
      window.nsoLibraryDelete.request({ file: 'pin.stl', category: 'Shaped Pieces', source: 'local' }, {});
    });
    await page.waitForFunction(() => {
      const b = document.getElementById('nso-confirm-back');
      return !!(b && !b.hasAttribute('hidden'));
    }, null, { timeout: 5000 });
    await page.fill('#nso-confirm-token', 'github_pat_pretend');
    await page.click('#nso-confirm-go');
    await page.waitForFunction(() => {
      const e = document.getElementById('nso-confirm-err');
      return e && !e.hasAttribute('hidden');
    }, null, { timeout: 15000 });
    const shown = await page.evaluate(() => document.getElementById('nso-confirm-err').textContent);
    const c = await ghCalls(page);
    check('it is refused, and the reason names both sources',
      /refusing to delete/.test(shown) && /"local"/.test(shown) && /"nest-library"/.test(shown), shown);
    check('ZERO requests were sent', c.length === 0, c.map(x => x.method + ' ' + x.url).join(', ') || 'none');
    await page.click('#nso-confirm-cancel');
    await page.waitForFunction(() => document.getElementById('nso-confirm-back').hasAttribute('hidden'),
      null, { timeout: 5000 });
  }

  console.log('\n=== 8. no page errors ===');
  {
    const bad = logs.filter(l => l.startsWith('[pageerror]'));
    check('no uncaught page errors', bad.length === 0, bad.slice(0, 3).join(' | ') || 'clean');
  }
}).then(() => {
  if (fails) { console.log('\n' + fails + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall checks held');
}).catch(err => { console.error(err); process.exit(1); });
