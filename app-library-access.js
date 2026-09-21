/* app-library-access.js - the ONE place that decides whether the Library may
   be written to, and the one place that names the repository it is written to.

   Loads as a classic script (window.nsoLibraryAccess) and as a Node module
   (require('./app-library-access.js')), so the gate is testable off the page.

   ---------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   ---------------------------------------------------------------------------
   There are now two features that change the repository from the browser:

     app-library-delete.js   remove a piece   (catalog entry, then file)
     app-library-save.js     add a piece      (file, then catalog entry)

   Both are gated today by exactly one thing: holding a fine-grained PAT with
   contents:write on this repository. There is no user, session or role
   concept anywhere in this app, so there is nothing else to check against -
   see docs/LIBRARY-DELETE.md for the full audit of why, and why a
   credential-free write is not possible without a backend.

   When a real access check IS wanted, the thing that must not happen is two
   separately-hardened paths: a check bolted onto Delete and a second,
   subtly-different one bolted onto Save. So the question "may the library be
   written to, this way, for this entry?" is asked HERE, of one function, by
   both features. Delete's mayDelete() and Save's maySave() are each a single
   delegation to it and decide nothing of their own.

   ADDING A REAL ACCESS CHECK LATER IS AN EDIT TO may()'s BODY. Nothing else
   in either feature asks who you are: not the dialogs, not the API calls, not
   the catalog editors, not app-library.js's rows.                          */
(function (root) {
  'use strict';

  /* ---- where these writes go -----------------------------------------

     Literals, deliberately, and NOT derived from location.host.

     The page you are looking at is very probably NOT served from the repo
     that owns these files. .github/workflows/mirror-wip-pages.yml force-pushes
     a snapshot of claude-wip into a SECOND repository (nest-wip) and Pages
     serves the site from there. Deriving the target from the URL would aim
     every write at that snapshot, where it would survive exactly until the
     next mirror run overwrote it. The source of truth is named here instead.

     This lives beside the gate rather than inside either feature because
     "which repository" and "may I write to it" are the same question asked
     twice, and a Save aimed at one repo while a Delete aims at another is a
     bug nobody would think to look for. configure() exists for the one case
     the literals cannot cover: driving this against a scratch repo from a
     test or from the console. */
  var TARGET = {
    owner:   'nolongerzzz',
    repo:    'nest-optimizer',
    branch:  'claude-wip',
    dir:     'library/',
    catalog: 'app-library.js',
    api:     'https://api.github.com'
  };

  function configure(patch) {
    if (!patch) return;
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k) &&
      Object.prototype.hasOwnProperty.call(TARGET, k)) TARGET[k] = patch[k];
  }
  function target() {
    var out = {};
    for (var k in TARGET) if (Object.prototype.hasOwnProperty.call(TARGET, k)) out[k] = TARGET[k];
    return out;
  }

  /* ---- the operator's credential, once per tab -------------------------

     ONE key for both features, on purpose: a run of library housekeeping is
     one session's work, and making someone paste the same token again because
     they went from deleting a piece to saving one is friction with no safety
     bought by it. The token is the same token, for the same repository, with
     the same scope.

     sessionStorage, never localStorage: a write credential that outlives the
     tab is a write credential sitting on disk on a shared machine.

     The key is published here and the reads/writes stay in each feature, so
     neither one can drift onto a key of its own. */
  var TOKEN_KEY = 'nso.library.token';

  /* =====================================================================
     THE PERMISSION GATE
     =====================================================================

     `action` is 'save' or 'delete'. `entry` is the catalog row being added or
     removed - { file, category } - so a future check can be per-piece and not
     only per-person.

     TODAY IT ALWAYS SAYS YES, for both actions. That is the honest state of
     things: writing is gated by holding a repository write token and by
     nothing this code knows. For the stated temporary testing use that is the
     accepted position, and no gating logic was invented to dress it up.

     It returns a verdict object rather than a boolean so the shape a real
     check needs - a no PLUS the sentence to put in front of the operator - is
     already here and neither caller has to grow a second return channel for
     it. An unknown action is refused rather than allowed, so a third feature
     that forgets to introduce itself here fails closed instead of inheriting
     a yes. */
  var ACTIONS = { save: true, delete: true };

  function may(action, entry) {
    if (!ACTIONS[action]) return { allowed: false, reason: 'unknown library action: ' + action };
    return { allowed: true, reason: '' };
  }

  var api = {
    may: may,
    actions: function () { return Object.keys(ACTIONS); },
    TOKEN_KEY: TOKEN_KEY,
    /* The LIVE object, for the two features that build request URLs out of it
       - they hold onto it, so a configure() reaches them without either one
       re-reading anything. target() is the safe copy, for everyone else. */
    TARGET: TARGET,
    target: target,
    configure: configure
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.nsoLibraryAccess = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
