/* app-library-delete.js - removing a piece from the Library, for real.

   Loads as a classic script (window.nsoLibraryDelete) and as a Node module
   (require('./app-library-delete.js')), so the one piece of this that is pure
   text surgery - removeCatalogEntry - is unit-testable off the page.

   ---------------------------------------------------------------------------
   WHAT "DELETE" HAS TO MEAN HERE, AND WHAT THAT COSTS
   ---------------------------------------------------------------------------
   A Library row is two things in the repository, not one:

     1. a line in `var CATALOG` in app-library.js
     2. a file in library/

   Dropping only (1) leaves an orphan blob nobody can reach. Dropping only (2)
   leaves a row that 404s when clicked - a DANGLING CATALOG REFERENCE, which is
   worse than not deleting at all. So a delete is both, and it does them in
   that order: catalog first, blob second. If the run dies between them the
   result is an unreferenced file, which is harmless and collectable. The other
   order would leave the broken row.

   ---------------------------------------------------------------------------
   THE MECHANISM, AND THE THING THAT IS NOT IN PLACE
   ---------------------------------------------------------------------------
   This app is static files on GitHub Pages. There is no server of ours in the
   loop, so there is exactly one way a page can change the repository: the
   GitHub REST Contents API, called straight from the browser.

     GET    /repos/{owner}/{repo}/contents/{path}?ref={branch}   -> blob sha
     PUT    /repos/{owner}/{repo}/contents/{path}                 write
     DELETE /repos/{owner}/{repo}/contents/{path}                 remove

   Every write needs an `Authorization` header carrying a credential with
   `contents: write` on this repo. That credential CANNOT come from this
   repository:

     - A token committed to a public repo is a published token. GitHub's secret
       scanning revokes it, usually within minutes, and until it does anyone
       can use it. Not an option, not even briefly.
     - A GitHub App or an OAuth web flow would be the right answer, and both
       need a server to hold the client secret and do the code-for-token
       exchange. There is no such server, and standing one up is out of scope
       for this ticket.
     - The device flow avoids the secret but its token endpoint does not send
       CORS headers, so a browser cannot complete it either.

   So the credential is SUPPLIED BY THE OPERATOR AT THE MOMENT OF THE DELETE -
   a fine-grained PAT, scoped to this one repository, pasted into the confirm
   dialog. It is held in sessionStorage (not localStorage) so it dies with the
   tab, and it is never written anywhere this code can commit. That is the
   honest state of things: the delete works today, and it works because a human
   with write access hands it a key each session. It is NOT an anonymous
   capability, whatever the absence of a permission gate below might suggest.

   See docs/LIBRARY-DELETE.md for the full audit, including why the catalog is
   edited as source text rather than read from a data file.

   ---------------------------------------------------------------------------
   WHAT THIS FILE NO LONGER OWNS
   ---------------------------------------------------------------------------
   app-library-save.js adds a piece the same way this one removes it, against
   the same repository, with the same token, under the same rule. Three things
   are therefore NOT decided here any more - they live in
   app-library-access.js and this file reads them:

     - the target owner / repo / branch / API host
     - the sessionStorage key the operator's token is held under
     - THE PERMISSION GATE (see mayDelete below)

   so that a real access check is one edit covering both features rather than
   two that can disagree. See docs/LIBRARY-SAVE.md section 4.  */
(function (root) {
  'use strict';

  /* ---- the shared access module ---------------------------------------

     Where these writes go, who may make them, and which sessionStorage key
     the operator's token lives under are all questions Save asks too, and a
     Save aimed at one repository while a Delete aims at another - or allowed
     by one rule while the other refuses - is a bug nobody would think to look
     for. So all three live in app-library-access.js and this module reads
     them from there. It decides none of them itself.

     Resolved lazily rather than at load time so script order cannot matter,
     and resolved through require() under Node so the unit test can load this
     file on its own. */
  function access() {
    if (root && root.nsoLibraryAccess) return root.nsoLibraryAccess;
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./app-library-access.js'); } catch (err) { /* not on disk */ }
    }
    return null;
  }

  /* The LIVE target object, not a copy, so configure() through either module
     moves both features together. Throws rather than falling back to literals
     of its own: a second copy of owner/repo/branch is exactly the drift this
     is here to prevent, and mayDelete() below has already refused - in words,
     to the operator - before anything reaches this. */
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

     This is the ONE place in this file that decides whether a delete is
     allowed to proceed, and it is the only question requestDelete() asks
     before it starts. Nothing else here, and nothing at all in
     app-library.js, re-decides it inline.

     It no longer decides anything itself either: it asks the shared gate in
     app-library-access.js, which Save's maySave() asks in exactly the same
     way. TODAY IT ALWAYS SAYS YES, for both - there is no user, session, role
     or permission concept anywhere in this app, there is nothing to check
     against, and for the stated temporary testing use that is the accepted
     position. Deleting is gated by holding a repository write token, not by
     anything this code knows.

     The verdict is an object rather than a boolean so the shape a real check
     needs is already here: a yes/no plus the sentence to show the operator
     when it is no. A missing access module is a NO, not a yes - a gate that
     fails open the moment a script tag is dropped is not a gate.

     ADDING A REAL ACCESS CHECK LATER IS AN EDIT TO may()'s BODY IN
     app-library-access.js - one edit, covering Delete and Save together, not
     two separately-hardened paths. It is not a change to the dialog, the API
     calls, the row wiring or the catalog editor, none of which ask who you
     are. */
  function mayDelete(entry) {
    var a = access();
    if (!a) return { allowed: false, reason: 'the library access gate did not load - refusing to delete' };
    return a.may('delete', entry);
  }

  /* ---- names ---------------------------------------------------------

     Every name that reaches an API path or a regex goes through this first.
     A catalog file name is a flat name in library/ - no slashes, no '..', no
     query, nothing that could aim a DELETE at a path this feature has no
     business touching, and nothing that could turn into a metacharacter in
     the catalog edit below. */
  var SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(stl|3mf)$/i;
  function safeName(file) { return typeof file === 'string' && SAFE_NAME.test(file); }

  /* =====================================================================
     THE CATALOG EDIT - the only text surgery in the feature
     =====================================================================

     app-library.js's CATALOG is authored source, one entry per LINE, and the
     repo depends on that: tools/nso_skin_fine_test.js greps this file for
     "'<name>'" to prove the shipped catalog has not drifted from what the
     sample generator writes. Rewriting source from a browser is the fragile
     part of this feature, so the fragility is confined to this one pure
     function, which:

       - works only inside the `var CATALOG = [ ... ];` block, never the file
       - requires EXACTLY ONE entry line to match, and refuses on 0 or 2+
       - fixes the trailing comma when the line it removed was the last one
       - returns a verdict, never a partially-edited string

     tools/nso_library_delete_test.js drives it against the real shipped
     app-library.js, so "it still parses and still lists the right files" is
     proven rather than assumed. */
  var CAT_OPEN = 'var CATALOG = [';
  var CAT_CLOSE = '\n  ];';

  function removeCatalogEntry(src, file) {
    if (typeof src !== 'string' || !src) return { ok: false, reason: 'no source' };
    if (!safeName(file)) return { ok: false, reason: 'not a plain library file name: ' + file };

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

    // An entry line is a line whose code begins the object literal. Comment
    // lines inside the block mention file names too and must never match.
    var lines = body.split('\n');
    var needle = "'" + file + "'";
    var hits = [];
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.charAt(0) !== '{') continue;
      if (t.indexOf('file:') === -1) continue;
      if (t.indexOf(needle) !== -1) hits.push(i);
    }
    if (!hits.length) return { ok: false, reason: file + ' is not an entry in CATALOG' };
    if (hits.length > 1) return { ok: false, reason: file + ' appears on ' + hits.length + ' CATALOG lines' };

    lines.splice(hits[0], 1);

    /* The removed line may have been the last entry, leaving its predecessor
       holding a trailing comma. Find the last remaining entry line and strip
       one, if it has one. (A trailing comma is legal in a modern array
       literal, but this file is a classic script the repo keeps ES5-clean,
       and a diff that quietly changes style is a diff a reviewer has to
       think about.) */
    var last = -1;
    for (var j = lines.length - 1; j >= 0; j--) {
      if (lines[j].trim().charAt(0) === '{') { last = j; break; }
    }
    if (last !== -1) lines[last] = lines[last].replace(/,(\s*)$/, '$1');

    var out = head + lines.join('\n') + tail;

    // Belt and braces: the name must be gone from the block we just edited,
    // and nothing outside the block may have moved.
    var reOpen = out.indexOf(CAT_OPEN);
    var reFrom = out.indexOf('\n', reOpen) + 1;
    var reClose = out.indexOf(CAT_CLOSE, reFrom);
    if (reOpen === -1 || reClose === -1) return { ok: false, reason: 'the edit broke the CATALOG block' };
    if (out.slice(reFrom, reClose).indexOf(needle) !== -1)
      return { ok: false, reason: file + ' still appears in CATALOG after the edit' };
    if (out.slice(0, reOpen) !== src.slice(0, open) || tail !== src.slice(close))
      return { ok: false, reason: 'the edit touched something outside CATALOG' };

    return { ok: true, text: out, removed: file };
  }

  /* ---- base64 over UTF-8 ---------------------------------------------
     The Contents API speaks base64. btoa/atob speak latin1, so a source file
     with any non-ASCII byte in it - and this repo's comments have plenty -
     round-trips to mojibake without going through TextEncoder first. */
  function b64encode(text) {
    var bytes = new TextEncoder().encode(text), bin = '', i;
    for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s+/g, '')), bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---- the token ------------------------------------------------------

     sessionStorage, never localStorage: a write credential that outlives the
     tab is a write credential sitting on disk on a shared machine. It is read
     back only to prefill the dialog, so a run of deletes is not a run of
     pastes, and forget() is there for the operator who wants it gone now. */
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

  function contentsUrl(path) {
    return TGT().api + '/repos/' + TGT().owner + '/' + TGT().repo +
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

  function apiError(what, r) {
    var msg = (r.body && r.body.message) ? r.body.message : ('HTTP ' + r.status);
    if (r.status === 401) msg = 'the token was rejected (401) - expired, or not a token for this repo';
    if (r.status === 403) msg = 'the token lacks contents:write on ' + TGT().owner + '/' + TGT().repo + ' (403)';
    if (r.status === 404) msg = 'not found (404) - wrong repo, wrong branch, or the token cannot see it';
    if (r.status === 409) msg = 'the branch moved under us (409) - reload and try again';
    return new Error(what + ': ' + msg);
  }

  /* The whole repository side of one delete. Catalog entry first, blob
     second - see the header. Resolves with a report of what it actually did;
     rejects with the first thing that went wrong, having done nothing after
     it. */
  function performDelete(entry, token) {
    var file = entry.file;
    var blobPath = TGT().dir + file;
    var why = 'Library: delete ' + file;
    var done = { file: file, catalog: null, blob: null };

    return Promise.resolve().then(function () {
      if (!safeName(file)) throw new Error('refusing to delete "' + file + '" - not a plain library file name');
      if (!token) throw new Error('no GitHub token - nothing was sent');
      return ghFetch(contentsUrl(TGT().catalog) + '?ref=' + encodeURIComponent(TGT().branch), token).then(ghJson);
    }).then(function (r) {
      if (!r.ok || !r.body || !r.body.content) throw apiError('reading ' + TGT().catalog, r);
      var edit = removeCatalogEntry(b64decode(r.body.content), file);
      if (!edit.ok) throw new Error('the catalog entry could not be removed cleanly: ' + edit.reason +
                                    ' - nothing was deleted');
      return ghFetch(contentsUrl(TGT().catalog), token, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: why + ' (catalog entry)',
          content: b64encode(edit.text),
          sha: r.body.sha,
          branch: TGT().branch
        })
      }).then(ghJson);
    }).then(function (r) {
      if (!r.ok) throw apiError('rewriting ' + TGT().catalog, r);
      done.catalog = (r.body && r.body.commit) ? r.body.commit.sha : 'written';
      return ghFetch(contentsUrl(blobPath) + '?ref=' + encodeURIComponent(TGT().branch), token).then(ghJson);
    }).then(function (r) {
      /* The catalog entry is already gone, so a blob that is not there is the
         state we were asking for, not a failure. Say so and stop. */
      if (r.status === 404) { done.blob = 'already gone'; return null; }
      if (!r.ok || !r.body || !r.body.sha) throw apiError('reading ' + blobPath, r);
      return ghFetch(contentsUrl(blobPath), token, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: why + ' (file)', sha: r.body.sha, branch: TGT().branch })
      }).then(ghJson);
    }).then(function (r) {
      if (r === null) return done;
      if (!r.ok) throw apiError('deleting ' + blobPath, r);
      done.blob = (r.body && r.body.commit) ? r.body.commit.sha : 'deleted';
      return done;
    });
  }

  /* =====================================================================
     THE CONFIRMATION
     =====================================================================

     A real modal, not window.confirm: it has to name the file, name the
     repository and branch it is about to write to, and carry the token field,
     none of which confirm() can do.

     What makes it a real block rather than a speed bump:
       - Cancel is what the keyboard lands on, so Enter on arrival cancels
       - Escape cancels, a click on the backdrop cancels
       - the Delete button is DISABLED until a token has been typed, so no
         single click on anything can start a delete
       - it resolves exactly once, whichever way it closes

     It does NOT close on Delete. The two API calls take a moment and can be
     refused - a bad token, a branch that moved - and an error about work you
     can no longer see is an error you cannot act on. So confirming puts the
     dialog into a busy state and hands the caller two handles: close() for a
     delete that worked, and fail(msg) to put the reason back in front of the
     operator with the token field still there to correct. Cancel, Escape and
     the backdrop are all inert while it is busy: the requests are already in
     flight and closing the window would not recall them. */
  var dlg = null;

  function buildDialog() {
    if (dlg) return dlg;
    var back = document.createElement('div');
    back.className = 'nso-confirm-back';
    back.id = 'nso-confirm-back';
    back.setAttribute('hidden', 'hidden');
    back.style.display = 'none';
    back.innerHTML =
      '<div class="nso-confirm" role="alertdialog" aria-modal="true"' +
      ' aria-labelledby="nso-confirm-title" aria-describedby="nso-confirm-body">' +
        '<h2 class="nso-confirm-title" id="nso-confirm-title">Are you sure?</h2>' +
        '<p class="nso-confirm-body" id="nso-confirm-body"></p>' +
        '<p class="nso-confirm-note" id="nso-confirm-note"></p>' +
        '<label class="nso-confirm-tok" for="nso-confirm-token">GitHub token' +
          ' <span>fine-grained, contents:write on this repo</span>' +
          '<input id="nso-confirm-token" type="password" autocomplete="off"' +
          ' spellcheck="false" placeholder="github_pat_…"></label>' +
        '<p class="nso-confirm-err" id="nso-confirm-err" hidden></p>' +
        '<div class="nso-confirm-row">' +
          '<button type="button" class="nso-confirm-btn" id="nso-confirm-cancel">Cancel</button>' +
          '<button type="button" class="nso-confirm-btn is-danger" id="nso-confirm-go" disabled>Delete</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);
    dlg = {
      back: back,
      body: back.querySelector('#nso-confirm-body'),
      note: back.querySelector('#nso-confirm-note'),
      err: back.querySelector('#nso-confirm-err'),
      token: back.querySelector('#nso-confirm-token'),
      cancel: back.querySelector('#nso-confirm-cancel'),
      go: back.querySelector('#nso-confirm-go')
    };
    return dlg;
  }

  /* Raises the dialog and drives it until there is an answer.

     `attempt(token)` is the work; it returns a promise. If it rejects, the
     reason goes back into the dialog, the buttons come back and the operator
     can correct the token and press Delete again - the dialog is a loop, not
     a one-shot, because "the token was wrong" is the overwhelmingly likely
     failure and making someone start over for it is just rude.

     Resolves with the attempt's value once one succeeds, or null if they
     cancelled. It never rejects: a failure that the operator then walked away
     from is a cancel, not an exception. */
  var confirmOpen = false;

  function runConfirm(entry, attempt) {
    var d = buildDialog();
    /* One dialog element, so one session at a time. The backdrop already
       makes a second row unreachable with the pointer, but a second
       programmatic request would bind a second set of listeners to the same
       buttons, and then both sessions would answer one click. */
    if (confirmOpen) return Promise.resolve(null);
    confirmOpen = true;
    return new Promise(function (resolve) {
      var busy = false, done = false;

      d.body.innerHTML = '';
      d.body.appendChild(document.createTextNode('Permanently delete '));
      var strong = document.createElement('strong');
      strong.textContent = entry.file;
      d.body.appendChild(strong);
      d.body.appendChild(document.createTextNode('?'));
      d.note.textContent = 'This removes its CATALOG entry from ' + TGT().catalog +
        ' and deletes library/' + entry.file + ' from ' +
        TGT().owner + '/' + TGT().repo + ' on ' + TGT().branch +
        '. Two commits, on the real repository. There is no undo from here.';
      d.err.setAttribute('hidden', 'hidden');
      d.err.textContent = '';
      d.token.value = storedToken();
      d.go.textContent = 'Delete';
      d.go.disabled = !d.token.value;
      d.cancel.disabled = false;

      function setBusy(on) {
        busy = on;
        d.cancel.disabled = on;
        d.go.disabled = on || !d.token.value.trim();
        d.go.textContent = on ? 'Deleting…' : 'Delete';
      }

      function finish(value) {
        if (done) return;
        done = true;
        confirmOpen = false;
        d.back.removeEventListener('pointerdown', onBack);
        d.token.removeEventListener('input', onInput);
        d.cancel.removeEventListener('click', onCancel);
        d.go.removeEventListener('click', onGo);
        document.removeEventListener('keydown', onKey, true);
        d.back.setAttribute('hidden', 'hidden');
        d.back.style.display = 'none';
        // not left sitting in the DOM of a closed dialog
        d.token.value = '';
        d.go.textContent = 'Delete';
        d.cancel.disabled = false;
        resolve(value);
      }

      /* Cancel, Escape and the backdrop are all inert while a delete is in
         flight: the requests have gone, and taking the window away would not
         recall them - it would only hide the answer. */
      function cancel() { if (!busy) finish(null); }

      function go() {
        if (busy || done || d.go.disabled) return;
        var tok = d.token.value;
        d.err.setAttribute('hidden', 'hidden');
        setBusy(true);
        Promise.resolve().then(function () {
          return attempt(tok);
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

      function onBack(ev) { if (ev.target === d.back) cancel(); }
      function onInput() { if (!busy) d.go.disabled = !d.token.value.trim(); }
      function onCancel() { cancel(); }
      function onGo() { go(); }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancel(); }
      }

      d.back.addEventListener('pointerdown', onBack);
      d.token.addEventListener('input', onInput);
      d.cancel.addEventListener('click', onCancel);
      d.go.addEventListener('click', onGo);
      document.addEventListener('keydown', onKey, true);

      d.back.removeAttribute('hidden');
      d.back.style.display = '';
      // Cancel, not Delete: whatever the keyboard does by reflex must be the
      // harmless one.
      d.cancel.focus();
    });
  }

  function say(text, bad) {
    if (typeof setStatus === 'function') setStatus(text, !!bad);
  }

  /* =====================================================================
     THE ENTRY POINT
     =====================================================================

     The one function the rest of the app calls. app-library.js's row wiring
     calls this and nothing else - it does not know about the gate, the
     dialog, the token or the API, and it cannot start a delete by any other
     route. Resolves with a report on a completed delete and with null on
     anything else, including a cancel, so a caller can tell "done" from "not
     done" without catching. */
  function requestDelete(entry, opts) {
    var o = opts || {};
    return Promise.resolve().then(function () {
      if (!entry || !entry.file) throw new Error('no entry to delete');

      var verdict = mayDelete(entry);
      if (!verdict || !verdict.allowed) {
        say(verdict && verdict.reason ? verdict.reason : 'Deleting is not permitted', true);
        return null;
      }

      return runConfirm(entry, function (token) {
        say('Deleting ' + entry.file + '…');
        return performDelete(entry, token).then(function (report) {
          rememberToken(token);
          return report;
        }).catch(function (err) {
          var msg = err && err.message ? err.message : String(err);
          console.warn('[library/delete] ' + entry.file + ': ' + msg);
          say('Delete failed - ' + msg, true);
          // back to the dialog, which puts this in front of the operator with
          // the token field still there to correct
          throw err;
        });
      }).then(function (report) {
        if (!report) { say('Delete cancelled - ' + entry.file + ' is untouched'); return null; }
        if (typeof o.onDeleted === 'function') o.onDeleted(entry, report);
        say('Deleted ' + entry.file + ' - catalog entry and file');
        return report;
      });
    }).catch(function (err) {
      if (!(err instanceof Error)) throw err;
      return null;
    });
  }

  var api = {
    request: requestDelete,
    mayDelete: mayDelete,
    removeCatalogEntry: removeCatalogEntry,
    target: target,
    configure: configure,
    forgetToken: forgetToken,
    hasToken: function () { return !!storedToken(); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.nsoLibraryDelete = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
