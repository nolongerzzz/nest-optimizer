/* app-library-save.js - "Save As": putting a piece from the plate INTO the
   Library, for real. The exact inverse of app-library-delete.js.

   Loads as a classic script (window.nsoLibrarySave) and as a Node module
   (require('./app-library-save.js')), so the one piece of this that is pure
   text surgery - addCatalogEntry - is unit-testable off the page.

   ---------------------------------------------------------------------------
   1. THE MECHANISM IS DELETE'S MECHANISM. IT WAS NOT RE-DERIVED.
   ---------------------------------------------------------------------------
   docs/LIBRARY-DELETE.md already audited this in full and the answer has not
   changed, because nothing about it was specific to deleting:

     - This app is static files on GitHub Pages. There is no server of ours in
       the loop, so the ONLY way a page can change the repository is the
       GitHub REST Contents API, called straight from the browser.
     - Every write needs an Authorization header carrying contents:write on
       this repository, and that credential cannot come from this repository.
       A committed token is a published token; a GitHub App or OAuth web flow
       needs a server to hold the client secret; the device flow's token
       endpoint sends no CORS headers so a browser cannot complete it; Pages
       has no function runtime.
     - So the credential is a fine-grained PAT, scoped to nest-optimizer and
       nest-library (a row spans both - see app-library-access.js),
       PASTED BY THE OPERATOR AT THE MOMENT OF THE SAVE, held in
       sessionStorage so it dies with the tab, never written anywhere this
       code can commit.

   There is no unattended, credential-free save, and there cannot be one
   without a backend - the same "not currently in place" the delete audit
   named, and the same smallest real fix (a tiny authenticated proxy holding a
   GitHub App installation token; a deployment, not a code change here).

   Save reuses that mechanism rather than inventing a second one, and reuses
   the sessionStorage key too (app-library-access.js), so an operator doing a
   round of library housekeeping pastes once, not once per feature.

   ---------------------------------------------------------------------------
   2. THE ORDER OF THE TWO WRITES - AND WHY IT IS THE REVERSE OF DELETE'S
   ---------------------------------------------------------------------------
   A Library row is two things, not one, in two repositories:

     1. a line in `var CATALOG` in app-library.js   (this repo)
     2. the STL itself                              (nolongerzzz/nest-library)

   Delete does the catalog FIRST and the blob second. Save does the blob
   FIRST and the catalog second. That is not an inconsistency - it is the same
   rule applied to an operation that runs the other way.

   The rule is: A CATALOG ROW MUST NEVER EXIST WITHOUT ITS FILE. The two
   half-finished states are not equally bad:

     catalog entry, no file  ->  a row that 404s the moment it is clicked.
                                 A DANGLING REFERENCE. The bad one.
     file, no catalog entry  ->  a blob nobody can reach. Wasteful, harmless,
                                 and invisible to every user of the browser.

   So whichever operation is being performed, the write that CREATES the
   reference goes last and the write that REMOVES it goes first:

     deleting   remove entry, then remove file   -> a crash orphans the file
     saving     write file,  then write entry    -> a crash orphans the file

   Both orders fail into the same harmless shape. Reversing either one would
   fail into the broken one. The failure-safety direction does flip between an
   add and a remove; the invariant behind it does not.

   Belt and braces on top of that ordering: the catalog edit is COMPUTED AND
   PROVEN BEFORE ANY WRITE IS SENT. The catalog is read first and
   addCatalogEntry is run against it; if it refuses - duplicate name, a block
   it does not recognise - nothing at all has been sent, so the common failure
   does not even orphan a file. The file write only starts once the catalog
   edit is known to be possible.

   ---------------------------------------------------------------------------
   3. WHAT IT REFUSES TO DO, ON PURPOSE
   ---------------------------------------------------------------------------
   It will not overwrite an existing file in nest-library, even one with no
   catalog entry. "No catalog entry" does not mean "spare": it is what a save
   that died between its two writes leaves behind, and what a row removed by
   hand leaves too, and neither is this code's to clobber. A name that is
   already taken is refused with the reason, and the operator picks another;
   that also refuses a retry of a save that half-finished earlier, which is
   the right trade against silently overwriting somebody's piece.

   (The fixtures the checks load by name - CTH_fixture.stl, soften_test_*.stl
   and friends - stayed in this repo's library/ and are not in nest-library at
   all, so a save can no longer reach them. The refusal is kept regardless.)

   See docs/LIBRARY-SAVE.md for the full write-up.                          */
(function (root) {
  'use strict';

  /* ---- the shared access module ---------------------------------------

     Target repository, token key and THE PERMISSION GATE all live in
     app-library-access.js, which app-library-delete.js reads too. Save
     decides none of them itself - that is the whole point of Task 5: one
     place to harden, not two. Resolved lazily so script order cannot matter,
     and through require() under Node so the unit test can load this file
     alone. */
  function access() {
    if (root && root.nsoLibraryAccess) return root.nsoLibraryAccess;
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./app-library-access.js'); } catch (err) { /* not on disk */ }
    }
    return null;
  }

  function TGT() {
    var a = access();
    if (!a) throw new Error('app-library-access.js is not loaded - refusing to write');
    return a.TARGET;
  }

  function configure(patch) { var a = access(); if (a) a.configure(patch); }
  function target() { var a = access(); return a ? a.target() : null; }

  /* =====================================================================
     THE PERMISSION GATE
     =====================================================================

     The ONE question requestSave() asks before it does anything, asked once,
     before the dialog is even raised - exactly where mayDelete() is asked on
     the other side. It decides nothing itself: it delegates to the shared
     gate that Delete also delegates to.

     TODAY IT ALWAYS SAYS YES, for the same reason it does there: there is no
     user, session, role or permission concept anywhere in this app, so there
     is nothing to check against, and saving is gated by holding a repository
     write token and by nothing this code knows.

     `entry` is the row that WOULD be created - the suggested file name plus
     the piece it came from - so a future per-piece rule has something to look
     at. It is checked before the name and category are typed rather than
     after, so a refusal never lets the operator fill in a form that was never
     going to be submitted.

     A missing access module is a NO. A gate that fails open the moment a
     script tag is dropped is not a gate.

     ADDING A REAL ACCESS CHECK LATER IS AN EDIT TO may()'s BODY IN
     app-library-access.js, covering Save and Delete together. */
  function maySave(entry) {
    var a = access();
    if (!a) return { allowed: false, reason: 'the library access gate did not load - refusing to save' };
    return a.may('save', entry);
  }

  /* ---- names and categories -------------------------------------------

     Everything typed by the operator reaches either an API path or a JS
     source file, so both go through these first.

     A file name is a flat name in nest-library - no slashes, no '..', no query -
     so nothing can aim a PUT at a path this feature has no business touching.
     It is the SAME rule app-library-delete.js enforces, so a piece that can
     be saved can always be deleted again.

     A category is embedded in source as a single-quoted string literal, so it
     is letters, digits, spaces, dash and underscore and nothing else: no
     quote, no backslash, no newline, nothing that could close the literal and
     keep going. */
  var SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(stl|3mf)$/i;
  var SAFE_CATEGORY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
  function safeName(file) { return typeof file === 'string' && SAFE_NAME.test(file); }
  function safeCategory(cat) { return typeof cat === 'string' && SAFE_CATEGORY.test(cat); }

  /* A typed name turned into a candidate file name: trim, drop the characters
     the name rule forbids, and make sure it ends in .stl. Deliberately NOT a
     validator - it returns its best effort and safeName() still decides. */
  function normaliseName(typed) {
    var s = String(typed == null ? '' : typed).trim().replace(/\s+/g, '_');
    s = s.replace(/[^A-Za-z0-9._-]/g, '');
    s = s.replace(/^[^A-Za-z0-9]+/, '');
    if (!s) return '';
    if (!/\.(stl|3mf)$/i.test(s)) s += '.stl';
    return s;
  }

  /* =====================================================================
     THE CATALOG EDIT - the only text surgery in the feature
     =====================================================================

     app-library.js's CATALOG is authored source, one entry per LINE, and the
     repo depends on that: tools/nso_skin_fine_test.js greps this file for
     "'<name>'" to prove the shipped catalog has not drifted from what the
     sample generator writes. Rewriting source from a browser is the fragile
     part of this feature, so - exactly as on the delete side - the fragility
     is confined to one pure function with no DOM, no network and no state,
     which:

       - works only inside `var CATALOG = [ ... ];` and, for a category that
         is new, the one-line `var CATEGORIES = [ ... ];`, never the rest
       - REFUSES a name that is already an entry, rather than adding a second
         line for it - two lines with one name is precisely what the delete
         side refuses to guess about, so this side must never create it
       - appends after the last entry line, taking that line's indentation and
         giving it the trailing comma it did not need while it was last
       - lines the new entry's `category:` up with the column the file already
         uses, so the diff a reviewer reads is one line, not a re-indent
       - returns a verdict, never a partially-edited string
       - proves afterwards that the file changed by EXACTLY the lines it meant
         to change and no others

     tools/nso_library_save_test.js drives it against the real shipped
     app-library.js and then actually executes the result in a sandboxed VM,
     so "it still parses and the piece is really in the catalog" is proven
     rather than assumed. */
  var CAT_OPEN = 'var CATALOG = [';
  var CAT_CLOSE = '\n  ];';
  var CATS_RE = /^(\s*var CATEGORIES = \[)(.*)(\];\s*)$/;

  function isEntryLine(line) {
    var t = line.trim();
    return t.charAt(0) === '{' && t.indexOf('file:') !== -1;
  }

  /* The column existing entries put `category:` at, so a new line lands in
     the same place. The mode rather than the max: one unusually long name
     should not re-align everything after it. */
  function categoryColumn(lines) {
    var counts = {}, best = 0, bestN = 0;
    for (var i = 0; i < lines.length; i++) {
      if (!isEntryLine(lines[i])) continue;
      var c = lines[i].indexOf('category:');
      if (c === -1) continue;
      counts[c] = (counts[c] || 0) + 1;
      if (counts[c] > bestN) { bestN = counts[c]; best = c; }
    }
    return best;
  }

  function addCatalogEntry(src, entry) {
    if (typeof src !== 'string' || !src) return { ok: false, reason: 'no source' };
    if (!entry) return { ok: false, reason: 'no entry to add' };
    var file = entry.file;
    var category = entry.category;
    var source = entry.source || 'local';
    if (!safeName(file)) return { ok: false, reason: 'not a plain library file name: ' + file };
    if (!safeCategory(category)) return { ok: false, reason: 'not a usable category name: ' + category };
    if (!safeCategory(source)) return { ok: false, reason: 'not a usable source name: ' + source };

    var open = src.indexOf(CAT_OPEN);
    if (open === -1) return { ok: false, reason: 'no "' + CAT_OPEN + '" in app-library.js' };
    var bodyFrom = src.indexOf('\n', open);
    if (bodyFrom === -1) return { ok: false, reason: 'CATALOG block is not laid out one entry per line' };
    bodyFrom += 1;
    var close = src.indexOf(CAT_CLOSE, bodyFrom);
    if (close === -1) return { ok: false, reason: 'CATALOG block is not closed by "  ];"' };

    var head = src.slice(0, bodyFrom);
    var body = src.slice(bodyFrom, close);
    var tail = src.slice(close);
    var lines = body.split('\n');
    var needle = "'" + file + "'";

    /* Already there? Refuse. Comment lines mention file names too, so only
       entry lines count - the same distinction the delete side draws. */
    var i, last = -1;
    for (i = 0; i < lines.length; i++) {
      if (!isEntryLine(lines[i])) continue;
      if (lines[i].indexOf(needle) !== -1)
        return { ok: false, reason: file + ' is already an entry in CATALOG' };
      last = i;
    }
    if (last === -1) return { ok: false, reason: 'CATALOG has no entry lines to append after' };

    /* The last entry did not need a trailing comma while it was last. It does
       now. (A trailing comma on the new final line is legal, but this file is
       a classic script the repo keeps ES5-clean and a diff that quietly
       changes style is a diff a reviewer has to think about.) */
    var commaFixed = -1;
    if (!/,\s*$/.test(lines[last])) {
      lines[last] = lines[last].replace(/(\s*)$/, ',$1');
      commaFixed = last;
    }

    var indent = (lines[last].match(/^[ \t]*/) || [''])[0];
    var prefix = indent + "{ file: '" + file + "',";
    var col = categoryColumn(lines);
    var pad = col > prefix.length ? new Array(col - prefix.length + 1).join(' ') : ' ';
    var line = prefix + pad + "category: '" + category + "', source: '" + source + "' }";
    lines.splice(last + 1, 0, line);

    var out = head + lines.join('\n') + tail;

    /* A category nothing is tagged with is never drawn, so a new category has
       to join CATEGORIES or the piece would save and then be invisible. */
    var catsAdded = false;
    var outLines = out.split('\n');
    var catsAt = -1;
    for (i = 0; i < outLines.length; i++) {
      var m = CATS_RE.exec(outLines[i]);
      if (!m) continue;
      catsAt = i;
      if (m[2].indexOf("'" + category + "'") === -1) {
        outLines[i] = m[1] + m[2].replace(/\s*$/, '') + ", '" + category + "'" + m[3];
        catsAdded = true;
      }
      break;
    }
    if (catsAt === -1) return { ok: false, reason: 'no one-line "var CATEGORIES = [ ... ];" in app-library.js' };
    out = outLines.join('\n');

    /* ---- prove the edit is exactly the edit that was intended ----------

       Not "the name is now present" - that is satisfied by a file this
       function could have mangled anywhere else. Line by line: the output is
       the input plus exactly one inserted line, and of the remaining lines at
       most two may differ, each one a change this function just made and can
       name. Anything else and nothing is returned at all. */
    var a = src.split('\n'), b = out.split('\n');
    if (b.length !== a.length + 1) return { ok: false, reason: 'the edit changed ' + (b.length - a.length) + ' lines, not 1' };
    var insertedAt = bodyFrom === 0 ? 0 : src.slice(0, bodyFrom).split('\n').length - 1;
    insertedAt += last + 1;
    var b2 = b.slice(0, insertedAt).concat(b.slice(insertedAt + 1));
    if (b[insertedAt] !== line) return { ok: false, reason: 'the new entry did not land where it was put' };
    var diffs = [];
    for (i = 0; i < a.length; i++) if (a[i] !== b2[i]) diffs.push(i);
    for (i = 0; i < diffs.length; i++) {
      var at = diffs[i];
      var isComma = commaFixed !== -1 && a[at] + ',' === b2[at];
      var isCats = catsAdded && CATS_RE.test(a[at]) && CATS_RE.test(b2[at]);
      if (!isComma && !isCats)
        return { ok: false, reason: 'the edit touched line ' + (at + 1) + ', which it had no business touching' };
    }
    if (diffs.length > (commaFixed !== -1 ? 1 : 0) + (catsAdded ? 1 : 0))
      return { ok: false, reason: 'the edit touched ' + diffs.length + ' existing lines' };

    return { ok: true, text: out, added: file, category: category, newCategory: catsAdded, line: line };
  }

  /* ---- base64 ----------------------------------------------------------
     The Contents API speaks base64 for both halves. btoa/atob speak latin1,
     so a source file with any non-ASCII byte in it - and this repo's comments
     have plenty - round-trips to mojibake without going through TextEncoder
     first. The STL half is already bytes and only needs chunking, because
     String.fromCharCode.apply on a megabyte of mesh blows the argument
     limit. */
  var CHUNK = 0x8000;
  function b64bytes(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf), bin = '', i;
    for (i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64encode(text) { return b64bytes(new TextEncoder().encode(text)); }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s+/g, '')), bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---- the token -------------------------------------------------------
     sessionStorage, never localStorage, under the key app-library-access.js
     publishes - the same key the delete side reads, so one paste covers a
     session of library housekeeping either way. Read back only to prefill the
     dialog; forget() is there for the operator who wants it gone now. */
  function tokenKey() {
    var a = access();
    return (a && a.TOKEN_KEY) || 'nso.library.token';
  }
  function storedToken() {
    try { return sessionStorage.getItem(tokenKey()) || ''; } catch (err) { return ''; }
  }
  function rememberToken(tok) {
    try { if (tok) sessionStorage.setItem(tokenKey(), tok); } catch (err) { /* private mode */ }
  }
  function forgetToken() {
    try { sessionStorage.removeItem(tokenKey()); } catch (err) { /* private mode */ }
  }

  /* ---- the API --------------------------------------------------------- */

  /* `repo` is t.repo for the catalog line and t.fileRepo for the file - the
     two halves of a row live in different repositories. */
  function contentsUrl(repo, path) {
    var t = TGT();
    return t.api + '/repos/' + t.owner + '/' + repo +
           '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  }

  function ghFetch(url, token, init) {
    var opts = init || {};
    opts.headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + token
    }, opts.headers || {});
    opts.cache = 'no-store';
    return fetch(url, opts);
  }

  function ghJson(res) {
    return res.text().then(function (t) {
      var body = null;
      try { body = t ? JSON.parse(t) : null; } catch (err) { body = null; }
      return { ok: res.ok, status: res.status, body: body, text: t };
    });
  }

  function apiError(what, r, repo) {
    var t = TGT();
    var msg = (r.body && r.body.message) ? r.body.message : ('HTTP ' + r.status);
    if (r.status === 401) msg = 'the token was rejected (401) - expired, or not a token for this repo';
    if (r.status === 403) msg = 'the token lacks contents:write on ' + t.owner + '/' + repo + ' (403)';
    if (r.status === 404) msg = 'not found (404) - wrong repo, wrong branch, or the token cannot see it';
    if (r.status === 409) msg = 'the branch moved under us (409) - reload and try again';
    return new Error(what + ': ' + msg);
  }

  /* The whole repository side of one save. FILE FIRST, CATALOG ENTRY SECOND -
     see section 2 of the header: the write that creates the reference goes
     last, so a run that dies half way leaves an unreachable blob rather than a
     row that 404s.

     The catalog is read and its edit computed BEFORE either write, so the
     likely refusals - a name already in the catalog, a file already in
     nest-library - cost nothing at all. Resolves with a report of what it
     actually did; rejects with the first thing that went wrong, having done
     nothing after it. */
  function performSave(entry, bytes, token) {
    var t = TGT();
    var file = entry.file;
    var blobPath = t.dir + file;
    var why = 'Library: save ' + file;
    var done = { file: file, category: entry.category, source: t.source, blob: null, catalog: null, newCategory: false };
    var catSha = null, catText = null;

    return Promise.resolve().then(function () {
      if (!safeName(file)) throw new Error('refusing to save "' + file + '" - not a plain library file name');
      if (!safeCategory(entry.category)) throw new Error('refusing to save into "' + entry.category + '" - not a usable category name');
      if (!bytes || !bytes.byteLength) throw new Error('the piece produced no STL bytes - nothing was sent');
      if (!token) throw new Error('no GitHub token - nothing was sent');
      return ghFetch(contentsUrl(t.repo, t.catalog) + '?ref=' + encodeURIComponent(t.branch), token).then(ghJson);
    }).then(function (r) {
      if (!r.ok || !r.body || !r.body.content) throw apiError('reading ' + t.catalog, r, t.repo);
      /* The row is filed under the file side's source, whatever the caller
         said: the file is about to be written to t.fileRepo, and a row that
         pointed anywhere else would 404. */
      var edit = addCatalogEntry(b64decode(r.body.content),
        { file: file, category: entry.category, source: t.source });
      if (!edit.ok) throw new Error('the catalog entry could not be added cleanly: ' + edit.reason +
                                    ' - nothing was saved');
      catSha = r.body.sha;
      catText = edit.text;
      done.newCategory = edit.newCategory;
      /* Is the name free? A file with no catalog row is a leftover, not a
         spare (section 3 of the header). A taken name is refused, never
         overwritten, and that refusal costs no write at all. */
      return ghFetch(contentsUrl(t.fileRepo, blobPath) + '?ref=' + encodeURIComponent(t.fileBranch), token).then(ghJson);
    }).then(function (r) {
      if (r.ok) throw new Error(blobPath + ' already exists in ' + t.fileRepo + ' (it is not a catalog ' +
        'row - it may be a leftover from an interrupted save, or a row removed by hand). ' +
        'Nothing was written. Choose a different name.');
      if (r.status !== 404) throw apiError('checking ' + blobPath, r, t.fileRepo);
      return ghFetch(contentsUrl(t.fileRepo, blobPath), token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: why + ' (file)',
          content: b64bytes(bytes),
          branch: t.fileBranch
        })
      }).then(ghJson);
    }).then(function (r) {
      if (!r.ok) throw apiError('writing ' + blobPath, r, t.fileRepo);
      done.blob = (r.body && r.body.commit) ? r.body.commit.sha : 'written';
      return ghFetch(contentsUrl(t.repo, t.catalog), token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: why + ' (catalog entry)',
          content: b64encode(catText),
          sha: catSha,
          branch: t.branch
        })
      }).then(ghJson);
    }).then(function (r) {
      if (!r.ok) throw apiError('rewriting ' + t.catalog, r, t.repo);
      done.catalog = (r.body && r.body.commit) ? r.body.commit.sha : 'written';
      return done;
    });
  }

  /* =====================================================================
     THE CONFIRMATION
     =====================================================================

     Same discipline as the delete dialog, and deliberately the same look: a
     real modal, not window.confirm, because it has to carry three fields and
     name the repository and branch it is about to commit to.

     What makes it a real block rather than a speed bump:
       - Cancel is what the keyboard lands on, so Enter on arrival cancels
       - Escape cancels, a click on the backdrop cancels
       - Save is DISABLED until a name, a category AND a token are all
         present, so no single click on anything, anywhere, can start a write
       - the line above the buttons names the exact file, category, repository
         and branch that are about to change, and it re-reads live as the name
         and category are typed - it is never describing a stale answer
       - it resolves exactly once, whichever way it closes

     It does NOT close on Save. The writes take a moment and can be refused -
     a bad token, a name already taken, a branch that moved - and an error
     about work you can no longer see is an error you cannot act on. So
     confirming puts the dialog into a busy state, and a failure puts the
     reason back in front of the operator with every field still filled in to
     correct. Cancel, Escape and the backdrop are inert while it is busy: the
     requests have gone and hiding the window would not recall them. */
  var dlg = null;
  var NEW_CAT = '\u0000new';

  function buildDialog() {
    if (dlg) return dlg;
    var back = document.createElement('div');
    back.className = 'nso-confirm-back';
    back.id = 'nso-save-back';
    back.setAttribute('hidden', 'hidden');
    back.style.display = 'none';
    back.innerHTML =
      '<div class="nso-confirm" role="dialog" aria-modal="true"' +
      ' aria-labelledby="nso-save-title" aria-describedby="nso-save-note">' +
        '<h2 class="nso-confirm-title" id="nso-save-title">Save to Library</h2>' +
        '<p class="nso-confirm-body" id="nso-save-body"></p>' +
        '<label class="nso-confirm-tok" for="nso-save-name">File name' +
          ' <span>letters, digits, . _ - and it will end in .stl</span>' +
          '<input id="nso-save-name" type="text" autocomplete="off" spellcheck="false"' +
          ' placeholder="my_piece.stl"></label>' +
        '<label class="nso-confirm-tok" for="nso-save-cat">Category' +
          '<select id="nso-save-cat"></select></label>' +
        '<label class="nso-confirm-tok" for="nso-save-newcat" id="nso-save-newcat-row" hidden>New category' +
          ' <span>added to the taxonomy as well as to this piece</span>' +
          '<input id="nso-save-newcat" type="text" autocomplete="off" spellcheck="false"' +
          ' placeholder="Jigs"></label>' +
        '<label class="nso-confirm-tok" for="nso-save-token">GitHub token' +
          ' <span>fine-grained, contents:write on nest-optimizer + nest-library</span>' +
          '<input id="nso-save-token" type="password" autocomplete="off"' +
          ' spellcheck="false" placeholder="github_pat_…"></label>' +
        '<p class="nso-confirm-note" id="nso-save-note"></p>' +
        '<p class="nso-confirm-err" id="nso-save-err" hidden></p>' +
        '<div class="nso-confirm-row">' +
          '<button type="button" class="nso-confirm-btn" id="nso-save-cancel">Cancel</button>' +
          '<button type="button" class="nso-confirm-btn is-go" id="nso-save-go" disabled>Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);
    dlg = {
      back: back,
      body: back.querySelector('#nso-save-body'),
      name: back.querySelector('#nso-save-name'),
      cat: back.querySelector('#nso-save-cat'),
      newCatRow: back.querySelector('#nso-save-newcat-row'),
      newCat: back.querySelector('#nso-save-newcat'),
      note: back.querySelector('#nso-save-note'),
      err: back.querySelector('#nso-save-err'),
      token: back.querySelector('#nso-save-token'),
      cancel: back.querySelector('#nso-save-cancel'),
      go: back.querySelector('#nso-save-go')
    };
    return dlg;
  }

  /* The categories offered: the LIVE list the browser is drawing, so a
     category added by an earlier save in this same session is offered to the
     next one without a reload.

     Deliberately no hardcoded fallback. A second copy of the taxonomy here
     would be a copy that drifts from app-library.js's, and the one case it
     would cover - the browser not loaded at all - is answered better by the
     "+ New category" row, which the dialog opens on when this comes back
     empty. */
  function knownCategories() {
    var lib = root && root.nsoLibrary;
    return (lib && lib.categories) ? lib.categories.slice() : [];
  }

  var confirmOpen = false;

  /* Raises the dialog and drives it until there is an answer.

     `attempt(entry, token)` is the work; it returns a promise. If it rejects,
     the reason goes back into the dialog with every field still filled in and
     the operator can correct and press Save again - the dialog is a loop, not
     a one-shot, because "the token was wrong" and "that name is taken" are
     the overwhelmingly likely failures and making someone start over for
     either is just rude.

     Resolves with the attempt's value once one succeeds, or null if they
     cancelled. It never rejects: a failure the operator then walked away from
     is a cancel, not an exception. */
  function runConfirm(suggest, attempt) {
    var d = buildDialog();
    /* One dialog element, so one session at a time: a second programmatic
       request would bind a second set of listeners to the same buttons, and
       then both sessions would answer one click. */
    if (confirmOpen) return Promise.resolve(null);
    confirmOpen = true;
    return new Promise(function (resolve) {
      var busy = false, done = false;
      var t = TGT();

      d.body.innerHTML = '';
      d.body.appendChild(document.createTextNode('Add '));
      var strong = document.createElement('strong');
      strong.textContent = suggest.from || 'this piece';
      d.body.appendChild(strong);
      d.body.appendChild(document.createTextNode(
        suggest.tris ? ' (' + suggest.tris + ' triangles) to the Library.' : ' to the Library.'));

      d.cat.innerHTML = '';
      var cats = knownCategories(), oi;
      for (oi = 0; oi < cats.length; oi++) {
        var opt = document.createElement('option');
        opt.value = cats[oi];
        opt.textContent = cats[oi];
        d.cat.appendChild(opt);
      }
      var newOpt = document.createElement('option');
      newOpt.value = NEW_CAT;
      newOpt.textContent = '+ New category…';
      d.cat.appendChild(newOpt);
      /* With no known categories there is nothing to pick, so open on the
         typed one rather than leaving a select with no valid value. */
      if (!cats.length) {
        d.cat.value = NEW_CAT;
        d.newCatRow.removeAttribute('hidden');
      } else {
        d.cat.value = cats.indexOf(suggest.category) !== -1 ? suggest.category : cats[0];
      }

      d.name.value = suggest.file || '';
      d.newCat.value = '';
      d.newCatRow.setAttribute('hidden', 'hidden');
      d.err.setAttribute('hidden', 'hidden');
      d.err.textContent = '';
      d.token.value = storedToken();
      d.go.textContent = 'Save';
      d.cancel.disabled = false;

      /* What the operator has actually asked for, right now. One reader, used
         by the note, by the enabled/disabled rule and by the write itself, so
         the sentence on screen can never describe a different write from the
         one the button would send. */
      function current() {
        var cat = d.cat.value === NEW_CAT ? d.newCat.value.trim() : d.cat.value;
        return {
          file: normaliseName(d.name.value),
          category: cat,
          source: t.source,
          token: d.token.value.trim()
        };
      }

      function refresh() {
        var c = current();
        var ok = safeName(c.file) && safeCategory(c.category) && !!c.token;
        if (!busy) d.go.disabled = !ok;
        if (!c.file) {
          d.note.textContent = 'Type a file name.';
        } else if (!safeName(c.file)) {
          d.note.textContent = '"' + d.name.value + '" is not a usable library file name.';
        } else if (!safeCategory(c.category)) {
          d.note.textContent = d.cat.value === NEW_CAT
            ? 'Type a category name - letters, digits, spaces, - and _.'
            : 'Choose a category.';
        } else {
          d.note.textContent = 'This writes ' + t.dir + c.file + ' to ' +
            t.owner + '/' + t.fileRepo + ' on ' + t.fileBranch +
            ', then adds a CATALOG entry in ' + t.catalog + ' under ' + c.category +
            (d.cat.value === NEW_CAT ? ' (a new category)' : '') + ', in ' +
            t.owner + '/' + t.repo + ' on ' + t.branch +
            '. Two commits, on the real repositories.';
        }
      }

      function setBusy(on) {
        busy = on;
        d.cancel.disabled = on;
        d.name.disabled = on;
        d.cat.disabled = on;
        d.newCat.disabled = on;
        d.token.disabled = on;
        d.go.textContent = on ? 'Saving…' : 'Save';
        if (on) d.go.disabled = true; else refresh();
      }

      function finish(value) {
        if (done) return;
        done = true;
        confirmOpen = false;
        d.back.removeEventListener('pointerdown', onBack);
        d.name.removeEventListener('input', refresh);
        d.newCat.removeEventListener('input', refresh);
        d.token.removeEventListener('input', refresh);
        d.cat.removeEventListener('change', onCat);
        d.cancel.removeEventListener('click', onCancel);
        d.go.removeEventListener('click', onGo);
        document.removeEventListener('keydown', onKey, true);
        d.back.setAttribute('hidden', 'hidden');
        d.back.style.display = 'none';
        // not left sitting in the DOM of a closed dialog
        d.token.value = '';
        d.go.textContent = 'Save';
        d.cancel.disabled = false;
        resolve(value);
      }

      /* Cancel, Escape and the backdrop are all inert while a save is in
         flight: the requests have gone, and taking the window away would not
         recall them - it would only hide the answer. */
      function cancel() { if (!busy) finish(null); }

      function go() {
        if (busy || done || d.go.disabled) return;
        var c = current();
        d.err.setAttribute('hidden', 'hidden');
        setBusy(true);
        Promise.resolve().then(function () {
          return attempt({ file: c.file, category: c.category, source: c.source }, c.token);
        }).then(function (value) {
          setBusy(false);
          finish(value);
        }, function (err) {
          setBusy(false);
          d.err.textContent = err && err.message ? err.message : String(err);
          d.err.removeAttribute('hidden');
          d.cancel.focus();
        });
      }

      function onCat() {
        if (d.cat.value === NEW_CAT) {
          d.newCatRow.removeAttribute('hidden');
          d.newCat.focus();
        } else {
          d.newCatRow.setAttribute('hidden', 'hidden');
        }
        refresh();
      }
      function onBack(ev) { if (ev.target === d.back) cancel(); }
      function onCancel() { cancel(); }
      function onGo() { go(); }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); }
      }

      d.back.addEventListener('pointerdown', onBack);
      d.name.addEventListener('input', refresh);
      d.newCat.addEventListener('input', refresh);
      d.token.addEventListener('input', refresh);
      d.cat.addEventListener('change', onCat);
      d.cancel.addEventListener('click', onCancel);
      d.go.addEventListener('click', onGo);
      document.addEventListener('keydown', onKey, true);

      refresh();
      d.back.removeAttribute('hidden');
      d.back.style.display = '';
      // Cancel, not Save: whatever the keyboard does by reflex must be the
      // harmless one.
      d.cancel.focus();
    });
  }

  function say(text, bad) {
    if (typeof setStatus === 'function') setStatus(text, !!bad);
  }

  /* The piece being saved: the SAME bytes "Download selected STL" would
     write, produced by the same function, so a saved piece is the piece that
     was tested rather than a second export path that can drift from it. */
  function currentPiece() {
    if (typeof activeModelSTL !== 'function') {
      say('Saving to the library is not available on this page', true);
      return null;
    }
    return activeModelSTL();   // already said why, on the status line, if null
  }

  /* =====================================================================
     THE ENTRY POINT
     =====================================================================

     The one function the rest of the app calls to save a piece. Nothing else
     raises the dialog, asks for a token, touches the API or edits the
     catalog, and there is no second route to any of it - performSave and
     runConfirm are not on the exported object.

     Resolves with a report on a completed save and with null on anything
     else, including a cancel, so a caller can tell "done" from "not done"
     without catching. */
  function requestSave(opts) {
    var o = opts || {};
    return Promise.resolve().then(function () {
      var piece = o.piece || currentPiece();
      if (!piece || !piece.buffer) return null;

      var suggest = {
        file: normaliseName(o.file || piece.name),
        category: o.category || 'Shaped Pieces',
        from: piece.name,
        tris: piece.tris
      };

      var verdict = maySave({ file: suggest.file, category: suggest.category, piece: piece.name });
      if (!verdict || !verdict.allowed) {
        say(verdict && verdict.reason ? verdict.reason : 'Saving to the library is not permitted', true);
        return null;
      }

      return runConfirm(suggest, function (entry, token) {
        say('Saving ' + entry.file + ' to the library…');
        return performSave(entry, piece.buffer, token).then(function (report) {
          rememberToken(token);
          return report;
        }).catch(function (err) {
          var msg = err && err.message ? err.message : String(err);
          console.warn('[library/save] ' + entry.file + ': ' + msg);
          say('Save failed - ' + msg, true);
          // back to the dialog, which puts this in front of the operator with
          // the fields still filled in to correct
          throw err;
        });
      }).then(function (report) {
        if (!report) { say('Save cancelled - nothing was written'); return null; }
        /* The browser's own half, and only now: the row appears because the
           repository really took it, never before. */
        var lib = root && root.nsoLibrary;
        if (lib && typeof lib.add === 'function') {
          lib.add({ file: report.file, category: report.category, source: report.source });
        }
        if (typeof o.onSaved === 'function') o.onSaved(report);
        say('Saved ' + report.file + ' to the library under ' + report.category +
            ' - file and catalog entry');
        return report;
      });
    }).catch(function (err) {
      if (!(err instanceof Error)) throw err;
      /* Anything that reaches here is a bug in this module rather than a
         refusal from GitHub - the refusals are caught above and put in the
         dialog. Returning null quietly would make it look like a cancel, so
         say so in both places a developer and an operator would look. */
      console.warn('[library/save] ' + (err.message || err));
      say('Save failed - ' + (err.message || err), true);
      return null;
    });
  }

  /* ---- the button ------------------------------------------------------

     One button, in the Export card beside "Download selected STL", because
     that is where "do something with the piece I have selected" already
     lives. It is bound here rather than in app-core.js so that the whole
     feature is this file plus one <button> - deleting the tag and the button
     removes it completely. */
  function bind() {
    var btn = document.getElementById('btn-library-save');
    if (!btn || btn._saveBound) return;
    btn._saveBound = true;
    btn.addEventListener('click', function () { requestSave(); });
  }
  if (root && root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  }

  var api = {
    request: requestSave,
    maySave: maySave,
    addCatalogEntry: addCatalogEntry,
    normaliseName: normaliseName,
    target: target,
    configure: configure,
    forgetToken: forgetToken,
    hasToken: function () { return !!storedToken(); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.nsoLibrarySave = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
