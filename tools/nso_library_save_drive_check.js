#!/usr/bin/env node
/* Drive check: the Library "Save As", in the real page, through the real UI.

     node tools/nso_library_save_drive_check.js

   WHAT IS REAL AND WHAT IS STUBBED
   The page, the piece, the STL export, the button, the dialog, the focus, the
   keyboard, the module and its catalog edit are all real - every click below
   is a real click on the shipped markup, and the bytes that reach the API are
   the bytes the shipped exporter produced from a piece really loaded through
   the shipped file input. The GitHub REST API is stubbed at window.fetch.

   It has to be, exactly as it has to be on the delete side. A real call needs
   a repository write credential, which cannot exist in a test run, and a test
   that really saved files would commit them to the repository it is testing.
   So the stub records what the page SENDS and answers it, and the assertions
   are about the request sequence, its payloads and its ordering - which is the
   part this feature could plausibly get wrong.

   THE ONE THING THIS CANNOT PROVE IS THAT GITHUB ACCEPTS THE CALLS. That is
   what the one-time manual check in docs/LIBRARY-SAVE.md is for, and it stays
   a separate, documented, human step.

   What it proves:
     1. the button is there, and a piece has to be selected before it does
        anything
     2. the dialog really blocks: Escape, Cancel and a backdrop click each
        leave the library and the repository untouched, with ZERO requests
     3. no single click can save - Save stays disabled until a name, a
        category AND a token are all present, and the keyboard lands on Cancel
     4. the dialog names the exact file, category, BOTH repositories and
        branches, and keeps naming the right ones as they are typed
     5. confirming sends exactly four requests in the one safe order: read the
        catalog, check the name is free, WRITE THE FILE, then write the
        catalog - file before catalog, so a half-finished run can never leave
        a row pointing at a file that is not there. The file pair goes to
        nest-library on main and the catalog pair to nest-optimizer on
        claude-wip (app-library-access.js); every request is checked for which
     6. the bytes committed are byte-for-byte the shipped exporter's bytes
     7. the catalog it commits really parses and really contains the piece
     8. the row and the entry then appear in the browser, and a new category
        gets its own section
     9. a refused catalog write leaves NO row and NO entry - the failure
        orphans a file, which is the harmless shape
    10. a duplicate name and a taken file name - the orphan check 9 left in
        nest-library - are each refused before any write is sent at all
    11. no page errors  */
'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const LIB_SRC = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');

/* Stand in for api.github.com inside the page, recording every request.

   `have` is the set of repo/path pairs the stub pretends already exist.
   nest-optimizer's app-library.js is in it; nest-library files are not, which
   is what makes a save of a new name the normal path. A PUT adds its path, so
   the file section 10 orphans is really there for section 11 to trip over. */
async function installStub(page, source) {
  await page.evaluate(src => {
    const enc = t => {
      const b = new TextEncoder().encode(t);
      let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return btoa(s);
    };
    window.__gh = { calls: [], src: src, fail: null, have: ['nest-optimizer/app-library.js'] };
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
      const repo = u.split('/repos/nolongerzzz/')[1].split('/')[0];
      const pathPart = repo + '/' + decodeURIComponent(u.split('/contents/')[1].split('?')[0]);
      if (method === 'GET') {
        if (pathPart === 'nest-optimizer/app-library.js')
          return Promise.resolve(new Response(JSON.stringify({ content: enc(window.__gh.src), sha: 'catsha' }),
            { status: 200 }));
        if (window.__gh.have.indexOf(pathPart) !== -1)
          return Promise.resolve(new Response(JSON.stringify({ sha: 'blobsha' }), { status: 200 }));
        return Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));
      }
      // A PUT lands: remember it, and let a later read of the catalog see it.
      if (window.__gh.have.indexOf(pathPart) === -1) window.__gh.have.push(pathPart);
      return Promise.resolve(new Response(JSON.stringify({ commit: { sha: 'commit' + window.__gh.calls.length } }),
        { status: 200 }));
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
const dlgOpen = page => page.evaluate(() => {
  const b = document.getElementById('nso-save-back');
  return !!(b && !b.hasAttribute('hidden'));
});
const entryNames = page => page.evaluate(() => window.nsoLibrary.entries().map(e => e.file));
const rowNames = page => page.evaluate(() =>
  Array.from(document.querySelectorAll('#library-list .library-item')).map(r => r.dataset.file));
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);

/* The path a PUT/GET was aimed at, which is what the ordering assertions are
   really about. */
/* repo/path, e.g. 'nest-optimizer/app-library.js' or 'nest-library/pin.stl' -
   the repository is part of what is asserted, not stripped off. */
const pathOf = c => c.url.split('/repos/nolongerzzz/')[1].split('/')[0] + '/' +
  decodeURIComponent(c.url.split('/contents/')[1].split('?')[0]);
const refOf = c => (c.url.split('?ref=')[1] || null);
const seq = calls => calls.map(c => c.method + ' ' + pathOf(c));

async function openSave(page) {
  /* Save to Library moved into the top bar's Export dropdown. Unfold it, and
     shut the Import one on the way: the bar's menus are exclusive, section 10
     leaves the library list open, and the two racing each other is exactly
     the kind of order dependence this check should not have. Then wait for the
     button to actually have a box rather than assuming the fold took. */
  await page.evaluate(() => {
    document.querySelectorAll('.viewport-overlay-topbar details').forEach(d => { d.open = false; });
    for (let n = document.getElementById('btn-library-save'); n; n = n.parentElement)
      if (n.tagName === 'DETAILS') n.open = true;
  });
  await page.waitForFunction(() => {
    const e = document.getElementById('btn-library-save');
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !e.closest('details:not([open])');
  }, null, { timeout: 5000 });
  await page.click('#btn-library-save');
  await page.waitForFunction(() => {
    const b = document.getElementById('nso-save-back');
    return !!(b && !b.hasAttribute('hidden'));
  }, null, { timeout: 5000 });
}

/* Fill the dialog the way a person would - typing, not setting .value - so
   the input listeners that arm the Save button actually run. */
async function fillSave(page, name, category, token) {
  if (name !== null) await page.fill('#nso-save-name', name);
  if (category !== null) {
    const known = await page.evaluate(cat => {
      const sel = document.getElementById('nso-save-cat');
      return Array.from(sel.options).some(o => o.value === cat);
    }, category);
    if (known) {
      await page.selectOption('#nso-save-cat', category);
    } else {
      await page.selectOption('#nso-save-cat', '\u0000new');
      await page.fill('#nso-save-newcat', category);
    }
  }
  if (token !== null) await page.fill('#nso-save-token', token);
}

withApp(async (page, logs) => {
  await installStub(page, LIB_SRC);
  await openLib(page);
  const baseRows = (await rowNames(page)).length;
  const baseEntries = (await entryNames(page)).length;

  /* ---------------------------------------------------------------- 1 */
  console.log('\n=== 1. the button, and nothing to save ===');
  {
    const shape = await page.evaluate(() => {
      const b = document.getElementById('btn-library-save');
      return b ? { tag: b.tagName, type: b.type, text: b.textContent.trim(), title: b.title } : null;
    });
    check('there is a Save-to-Library button', !!shape, JSON.stringify(shape));
    check('it is a real <button type=button>', shape && shape.tag === 'BUTTON' && shape.type === 'button');
    // btn-library-save moved into the top bar's Export dropdown; unfold it first.
    await page.evaluate(() => { const e = document.getElementById('btn-library-save'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    check('it says what it does', shape && /save/i.test(shape.text) && /librar/i.test(shape.text), shape && shape.text);

    // Nothing selected yet: it must say so and send nothing.
    await page.evaluate(() => { const e = document.getElementById('btn-library-save'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
    await page.click('#btn-library-save');
    await page.waitForTimeout(200);
    check('with no piece selected it refuses, in words',
      /select a model/i.test(await statusOf(page)), (await statusOf(page)).slice(0, 70));
    check('and raises no dialog', !(await dlgOpen(page)));
    check('and sends nothing', (await ghCalls(page)).length === 0);
  }

  /* A real piece, loaded through the real file input and selected the way a
     click selects it. Everything from here on saves THIS. */
  const id = await loadSTL(page, path.join(ROOT, 'library', 'pin.stl'));
  await selectModel(page, id);

  /* ---------------------------------------------------------------- 2/3 */
  console.log('\n=== 2. the dialog is a real block, not a speed bump ===');
  {
    await openSave(page);
    const d = await page.evaluate(() => {
      const box = document.querySelector('#nso-save-back .nso-confirm');
      return {
        role: box.getAttribute('role'),
        modal: box.getAttribute('aria-modal'),
        focused: document.activeElement ? document.activeElement.id : null,
        goDisabled: document.getElementById('nso-save-go').disabled,
        name: document.getElementById('nso-save-name').value,
        body: document.getElementById('nso-save-body').textContent,
        cats: Array.from(document.getElementById('nso-save-cat').options).map(o => o.textContent)
      };
    });
    check('it is a modal dialog', d.role === 'dialog' && d.modal === 'true', d.role + ' / ' + d.modal);
    check('the keyboard lands on Cancel, not Save', d.focused === 'nso-save-cancel', d.focused);
    check('Save is DISABLED on arrival - no single click can write', d.goDisabled === true);
    check('it names the piece being saved', /pin/.test(d.body), d.body);
    check('the name is prefilled from the piece', /^pin\.stl$/.test(d.name), d.name);
    check('every shipped category is offered, plus a way to add one',
      d.cats.indexOf('Skins') !== -1 && d.cats.indexOf('Test Fixtures') !== -1 &&
      d.cats.some(c => /new category/i.test(c)), d.cats.join(' | '));
    check('nothing has been sent yet', (await ghCalls(page)).length === 0);
  }

  console.log('\n=== 3. Save stays disabled until name, category AND token are all present ===');
  {
    const arm = async (name, cat, tok) => {
      await fillSave(page, name, cat, tok);
      await page.waitForTimeout(60);
      return await page.evaluate(() => document.getElementById('nso-save-go').disabled);
    };
    check('name + category, no token -> still disabled', await arm('drive_piece.stl', 'Test Fixtures', ''));
    check('token but no name -> still disabled', await arm('', null, 'github_pat_pretend'));
    check('a name that sanitises away to nothing -> still disabled',
      await arm('!!!', null, null));
    /* A traversal is not rejected, it is SANITISED - and the note proves what
       will actually be written, so the operator sees the flat name before
       they commit to it and nothing path-shaped can reach the API. */
    await fillSave(page, '../../etc/passwd.stl', null, null);
    await page.waitForTimeout(60);
    const travel = await page.evaluate(() => document.getElementById('nso-save-note').textContent);
    check('a traversal is flattened, and the note shows the flat name it will write',
      /writes etcpasswd\.stl to/.test(travel) && !/\.\./.test(travel), travel.slice(0, 110));
    check('an empty new-category -> still disabled', await arm('drive_piece.stl', 'Jigs_new_x', null) === false
      ? await (async () => { await page.fill('#nso-save-newcat', ''); await page.waitForTimeout(60);
          return await page.evaluate(() => document.getElementById('nso-save-go').disabled); })()
      : true);
    check('all three present -> armed', (await arm('drive_piece.stl', 'Test Fixtures', 'github_pat_pretend')) === false);
    const note = await page.evaluate(() => document.getElementById('nso-save-note').textContent);
    check('the note names the file it will write, and where',
      /writes drive_piece\.stl to nolongerzzz\/nest-library on main/.test(note), note);
    check('...the category', /Test Fixtures/.test(note));
    check('...and where the catalog entry goes',
      /app-library\.js under Test Fixtures, in nolongerzzz\/nest-optimizer on claude-wip/.test(note), note);
    // and it re-reads live rather than describing a stale answer
    await page.fill('#nso-save-name', 'renamed_piece.stl');
    await page.waitForTimeout(60);
    const note2 = await page.evaluate(() => document.getElementById('nso-save-note').textContent);
    check('retyping the name re-reads the note', /writes renamed_piece\.stl to/.test(note2) &&
      !/drive_piece/.test(note2), note2.slice(0, 90));
    check('still nothing sent', (await ghCalls(page)).length === 0);
  }

  console.log('\n=== 4. Escape, Cancel and the backdrop each leave everything alone ===');
  {
    const ways = [
      ['Escape', async () => { await page.keyboard.press('Escape'); }],
      ['Cancel', async () => { await page.click('#nso-save-cancel'); }],
      ['a backdrop click', async () => {
        await page.evaluate(() => {
          document.getElementById('nso-save-back')
            .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        });
      }]
    ];
    for (const [what, act] of ways) {
      if (!(await dlgOpen(page))) await openSave(page);
      // fill it in fully first: cancelling must win even when Save is armed
      await fillSave(page, 'cancel_me.stl', 'Test Fixtures', 'github_pat_pretend');
      await act();
      await page.waitForFunction(() => document.getElementById('nso-save-back').hasAttribute('hidden'),
        null, { timeout: 5000 }).catch(() => {});
      const closed = !(await dlgOpen(page));
      const calls = await ghCalls(page);
      await openLib(page);
      check(what + ' closes it', closed);
      check('  ...with ZERO requests sent', calls.length === 0, seq(calls).join(', '));
      check('  ...and no new row or entry',
        (await rowNames(page)).length === baseRows && (await entryNames(page)).length === baseEntries);
      check('  ...and the status line says nothing was written',
        /cancel/i.test(await statusOf(page)), (await statusOf(page)).slice(0, 70));
    }
  }

  /* ---------------------------------------------------------------- 5-8 */
  console.log('\n=== 5. a real save: four requests, FILE BEFORE CATALOG ===');
  let saved = null;
  {
    await resetGh(page);
    /* What the shipped exporter would write for this piece, read straight out
       of the page, so check 6 can compare bytes rather than trust them. */
    const want = await page.evaluate(() => {
      const stl = activeModelSTL();
      const b = new Uint8Array(stl.buffer);
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { b64: btoa(s), bytes: b.length, tris: stl.tris };
    });

    await openSave(page);
    await fillSave(page, 'drive_check_piece.stl', 'Test Fixtures', 'github_pat_pretend');
    await page.click('#nso-save-go');
    await page.waitForFunction(() => document.getElementById('nso-save-back').hasAttribute('hidden'),
      null, { timeout: 20000 });
    const calls = await ghCalls(page);
    saved = calls;

    check('exactly four requests', calls.length === 4, seq(calls).join(' | '));
    check('1. read the catalog, from nest-optimizer on claude-wip',
      calls[0] && calls[0].method === 'GET' && pathOf(calls[0]) === 'nest-optimizer/app-library.js' &&
      refOf(calls[0]) === 'claude-wip', seq(calls)[0] + ' ref=' + (calls[0] && refOf(calls[0])));
    check('2. check the file name is free, in nest-library on main',
      calls[1] && calls[1].method === 'GET' && pathOf(calls[1]) === 'nest-library/drive_check_piece.stl' &&
      refOf(calls[1]) === 'main', seq(calls)[1] + ' ref=' + (calls[1] && refOf(calls[1])));
    check('3. WRITE THE FILE, to nest-library',
      calls[2] && calls[2].method === 'PUT' && pathOf(calls[2]) === 'nest-library/drive_check_piece.stl');
    check('4. and only then write the catalog entry, to nest-optimizer',
      calls[3] && calls[3].method === 'PUT' && pathOf(calls[3]) === 'nest-optimizer/app-library.js');
    check('nothing is sent to this repo\'s library/', calls.every(c => pathOf(c).indexOf('nest-optimizer/library/') !== 0));

    /* THE ORDERING INVARIANT, stated as the thing it protects rather than as
       a position: the write that CREATES the catalog reference is the last
       one sent, so a run that dies part way orphans a file (harmless) instead
       of leaving a row that 404s (the broken shape). */
    const puts = calls.filter(c => c.method === 'PUT');
    check('the catalog write is the LAST write - a crash orphans a file, never a row',
      puts.length === 2 && pathOf(puts[0]).indexOf('nest-library/') === 0 && pathOf(puts[1]) === 'nest-optimizer/app-library.js',
      seq(puts).join(' then '));
    check('every request carried the token', calls.every(c => c.auth === 'Bearer github_pat_pretend'),
      calls.map(c => c.auth).join(','));
    check('both commits say what they are',
      /\(file\)/.test(puts[0].body) && /\(catalog entry\)/.test(puts[1].body));
    check('each commit names its own repository\'s branch - main for the file, claude-wip for the entry',
      JSON.parse(puts[0].body).branch === 'main' && JSON.parse(puts[1].body).branch === 'claude-wip',
      JSON.parse(puts[0].body).branch + ' / ' + JSON.parse(puts[1].body).branch);
    check('the catalog write is conditional on the sha it read',
      JSON.parse(puts[1].body).sha === 'catsha');
    check('the file write is NOT conditional on a sha - it is a creation',
      JSON.parse(puts[0].body).sha === undefined);

    console.log('\n=== 6. the committed bytes are the shipped exporter\'s bytes ===');
    check('the piece really produced an STL', want.bytes > 84 && want.tris > 0,
      want.bytes + ' bytes, ' + want.tris + ' tris');
    check('the file committed is byte-for-byte what Download selected STL writes',
      JSON.parse(puts[0].body).content === want.b64,
      JSON.parse(puts[0].body).content.length + ' vs ' + want.b64.length + ' base64 chars');

    console.log('\n=== 7. the catalog it commits really parses, and really has the piece ===');
    const committed = await page.evaluate(b64 => {
      const bin = atob(b64.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }, JSON.parse(puts[1].body).content);
    check('it decodes back to JavaScript, not mojibake',
      committed.indexOf('var CATALOG = [') !== -1 && committed.length > 1000);
    check('and it is the shipped file plus exactly one line',
      committed.split('\n').length === LIB_SRC.split('\n').length + 1,
      (committed.split('\n').length - LIB_SRC.split('\n').length) + ' lines');
    check('with the new entry in it, spelled as an entry',
      /\{ file: 'drive_check_piece\.stl',\s+category: 'Test Fixtures', source: 'nest-library' \}/.test(committed));
    /* Run it, rather than believing a regex. */
    const ran = await page.evaluate(src => {
      try {
        const f = new Function('document', 'window', 'URL', 'setTimeout', 'console', src + '\n;return window.nsoLibrary;');
        const el = () => ({ _libBuilt: true, style: {}, dataset: {}, setAttribute() {}, removeAttribute() {},
          hasAttribute() { return true; }, appendChild() {}, addEventListener() {}, contains() { return false; },
          querySelector() { return null; }, querySelectorAll() { return []; } });
        const doc = { baseURI: document.baseURI, readyState: 'complete', getElementById: el,
          createElement: el, querySelectorAll: () => [], addEventListener() {} };
        const win = { document: doc };
        const lib = f(doc, win, URL, () => {}, { warn() {} });
        return { files: (win.nsoLibrary || lib).entries().map(e => e.file),
                 cats: (win.nsoLibrary || lib).categories };
      } catch (e) { return { error: e.message }; }
    }, committed);
    check('the committed catalog executes', !ran.error, ran.error || '');
    check('...and lists the saved piece', !ran.error && ran.files.indexOf('drive_check_piece.stl') !== -1,
      ran.error ? '' : ran.files.length + ' entries');

    console.log('\n=== 8. the browser then shows it ===');
    await openLib(page);
    check('the entry is in window.nsoLibrary',
      (await entryNames(page)).indexOf('drive_check_piece.stl') !== -1);
    check('a row appeared', (await rowNames(page)).indexOf('drive_check_piece.stl') !== -1);
    check('under the right category', await page.evaluate(() => {
      const r = document.querySelector('#library-list .library-item[data-file="drive_check_piece.stl"]');
      return !!r && r.dataset.category === 'Test Fixtures' &&
             !!r.closest('.library-sec') && r.closest('.library-sec').dataset.sec === 'Test Fixtures';
    }));
    check('the section count went up', await page.evaluate(() => {
      const sec = Array.from(document.querySelectorAll('#library-list .library-sec'))
        .find(s => s.dataset.sec === 'Test Fixtures');
      return sec && Number(sec.querySelector('.library-sec-count').textContent) ===
        sec.querySelectorAll('.library-item').length;
    }));
    check('the status line says both halves landed',
      /saved/i.test(await statusOf(page)) && /catalog/i.test(await statusOf(page)),
      (await statusOf(page)).slice(0, 90));
    check('the new row can be deleted again - it carries the same x as every other',
      await page.evaluate(() => !!document.querySelector(
        '#library-list .library-item[data-file="drive_check_piece.stl"] .library-del')));
  }

  /* ---------------------------------------------------------------- 9 */
  console.log('\n=== 9. a new category gets its own section ===');
  {
    await resetGh(page);
    await openSave(page);
    await fillSave(page, 'jig_drive.stl', 'Jigs', 'github_pat_pretend');
    await page.click('#nso-save-go');
    await page.waitForFunction(() => document.getElementById('nso-save-back').hasAttribute('hidden'),
      null, { timeout: 20000 });
    const puts = (await ghCalls(page)).filter(c => c.method === 'PUT');
    check('it saved', puts.length === 2, seq(puts).join(' | '));
    const committed = await page.evaluate(b64 => {
      const bin = atob(b64.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }, JSON.parse(puts[1].body).content);
    check('CATEGORIES gained the new name in the committed source',
      /var CATEGORIES = \[[^\]]*'Jigs'\]/.test(committed),
      (committed.split('\n').find(l => /var CATEGORIES/.test(l)) || '').slice(0, 130));
    await openLib(page);
    check('the browser drew a section for it', await page.evaluate(() =>
      Array.from(document.querySelectorAll('#library-list .library-sec')).some(s => s.dataset.sec === 'Jigs')));
    check('with the piece in it', await page.evaluate(() => {
      const r = document.querySelector('#library-list .library-item[data-file="jig_drive.stl"]');
      return !!r && !!r.closest('.library-sec') && r.closest('.library-sec').dataset.sec === 'Jigs';
    }));
    check('and the next save offers it as an existing category', await (async () => {
      await openSave(page);
      const has = await page.evaluate(() =>
        Array.from(document.getElementById('nso-save-cat').options).some(o => o.value === 'Jigs'));
      await page.click('#nso-save-cancel');
      return has;
    })());
  }

  /* ---------------------------------------------------------------- 10 */
  console.log('\n=== 10. a refused catalog write leaves NO row - it orphans a file instead ===');
  {
    await resetGh(page);
    await page.evaluate(() => {
      window.__gh.fail = { method: 'PUT', match: 'app-library.js', status: 403,
                           message: 'Resource not accessible by personal access token' };
    });
    await openSave(page);
    await fillSave(page, 'never_listed.stl', 'Test Fixtures', 'github_pat_pretend');
    await page.click('#nso-save-go');
    await page.waitForFunction(() => {
      const e = document.getElementById('nso-save-err');
      return e && !e.hasAttribute('hidden');
    }, null, { timeout: 20000 });
    const shown = await page.evaluate(() => document.getElementById('nso-save-err').textContent);
    const calls = await ghCalls(page);
    check('the dialog is STILL OPEN, so the error is somewhere it can be read', await dlgOpen(page));
    check('the failure is shown in the dialog, in words', /403|not accessible/i.test(shown), shown);
    const armed = await page.evaluate(() => ({
      cancel: document.getElementById('nso-save-cancel').disabled,
      go: document.getElementById('nso-save-go').disabled,
      name: document.getElementById('nso-save-name').value,
      label: document.getElementById('nso-save-go').textContent
    }));
    check('the fields are live again, still filled in, so it can be corrected and retried',
      armed.cancel === false && armed.go === false && armed.label === 'Save' &&
      armed.name === 'never_listed.stl', JSON.stringify(armed));
    check('the status line says it failed', /failed/i.test(await statusOf(page)),
      (await statusOf(page)).slice(0, 80));
    check('the file WAS written - that is the orphan, and it is the harmless half',
      calls.some(c => c.method === 'PUT' && pathOf(c) === 'nest-library/never_listed.stl'));

    await page.click('#nso-save-cancel');
    await page.waitForFunction(() => document.getElementById('nso-save-back').hasAttribute('hidden'),
      null, { timeout: 5000 });
    await openLib(page);
    check('NO row appeared', (await rowNames(page)).indexOf('never_listed.stl') === -1);
    check('NO catalog entry appeared', (await entryNames(page)).indexOf('never_listed.stl') === -1);
    check('so nothing in the browser points at a file the catalog does not list',
      (await entryNames(page)).every(f => f !== 'never_listed.stl'));
  }

  /* ---------------------------------------------------------------- 11 */
  console.log('\n=== 11. duplicate name and taken file name are refused before any write ===');
  {
    await resetGh(page);
    await openSave(page);
    await fillSave(page, 'pin.stl', 'Test Fixtures', 'github_pat_pretend');
    await page.click('#nso-save-go');
    await page.waitForFunction(() => {
      const e = document.getElementById('nso-save-err');
      return e && !e.hasAttribute('hidden');
    }, null, { timeout: 20000 });
    let shown = await page.evaluate(() => document.getElementById('nso-save-err').textContent);
    let calls = await ghCalls(page);
    check('a name already in the catalog is refused', /already an entry/i.test(shown), shown.slice(0, 90));
    check('  ...after the read, and before ANY write',
      calls.length === 1 && calls[0].method === 'GET', seq(calls).join(' | '));
    check('  ...so not even a file was orphaned', !calls.some(c => c.method === 'PUT'));

    /* And a name that is free in the catalog but taken in nest-library -
       which is real: section 10 left exactly that behind, the file a save wrote
       before its catalog write was refused. Retrying that save must not
       clobber it. */
    await resetGh(page);
    const orphaned = await page.evaluate(() => window.__gh.have.indexOf('nest-library/never_listed.stl') !== -1);
    check('the orphan section 10 left is in nest-library', orphaned);
    await fillSave(page, 'never_listed.stl', null, null);
    await page.click('#nso-save-go');
    await page.waitForFunction(() => {
      const e = document.getElementById('nso-save-err');
      return e && !e.hasAttribute('hidden') && /already exists/i.test(e.textContent);
    }, null, { timeout: 20000 });
    shown = await page.evaluate(() => document.getElementById('nso-save-err').textContent);
    calls = await ghCalls(page);
    check('a file name already in nest-library is refused, not overwritten',
      /already exists in nest-library/i.test(shown), shown.slice(0, 120));
    check('  ...and it says why that matters', /interrupted/i.test(shown));
    check('  ...with no PUT sent at all', !calls.some(c => c.method === 'PUT'), seq(calls).join(' | '));
    await page.click('#nso-save-cancel');
    await page.waitForFunction(() => document.getElementById('nso-save-back').hasAttribute('hidden'),
      null, { timeout: 5000 });
  }

  /* ---------------------------------------------------------------- 12 */
  console.log('\n=== 12. no page errors ===');
  {
    const bad = logs.filter(l => l.startsWith('[pageerror]'));
    check('no uncaught page errors', bad.length === 0, bad.slice(0, 3).join(' | ') || 'clean');
  }
}).then(() => {
  if (fails) { console.log('\n' + fails + ' check(s) FAILED'); process.exit(1); }
  console.log('\nall checks held');
}).catch(err => { console.error(err); process.exit(1); });
