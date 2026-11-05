/* Recent loads - the pieces that came onto the plate this session, newest
   first, whether they came from a file or from the library.

   A STORE, and nothing else: no DOM, no knowledge of the plate or of how a
   piece is loaded. app-recent.js is what draws the Import > Recent list and
   what reloads an entry; this file is what it reads and writes through.

   THE INTERFACE IS TWO CALLS. add(entry) and list(). The dropdown calls
   nothing else, so a store that keeps its entries in browser storage later is
   a second createStore-shaped object handed to NSORecent.use(), and the
   dropdown is not touched. list() may therefore return an array or a promise
   of one (a storage that has to be read asynchronously); the dropdown waits
   for either.

   AN ENTRY IS PLAIN DATA:

     name    what the row says: the file's own name
     source  'file' or 'library'
     load    what is needed to load it again.
               library  the catalog entry: { file, category, source }, which
                        is enough to fetch the same file again
               file     { blob }: the File the browser handed over. It is not
                        a copy - a File is a handle to the file on disk - and
                        a Blob is what IndexedDB stores as it is, so a
                        persistent store keeps it without the entry changing
                        shape.
     when    milliseconds since the epoch, stamped by add()

   The same piece loaded twice is one entry, moved to the top with a new
   `when`: Recent is a list of what you used, not a log of every click. Two
   entries are the same piece when their key() is - a library file by the
   library and its name, a file by name, size and modified time.

   The in-memory store below is the only implementation. Nothing here writes
   to browser storage. */
(function (root) {
  'use strict';

  var SOURCES = ['file', 'library'];
  var DEFAULT_LIMIT = 20;

  function key(entry) {
    var load = entry && entry.load;
    if (!load) return null;
    if (entry.source === 'library') return 'library:' + (load.source || '') + '/' + load.file;
    var b = load.blob;
    if (!b) return null;
    return 'file:' + entry.name + ':' + (b.size == null ? '' : b.size) + ':' + (b.lastModified == null ? '' : b.lastModified);
  }

  /* A store that lives for the session. `opts.limit` caps how many entries it
     keeps (the oldest fall off); `opts.now` is the clock, for the checks. */
  function createStore(opts) {
    var limit = (opts && opts.limit > 0) ? opts.limit : DEFAULT_LIMIT;
    var now = (opts && opts.now) || function () { return Date.now(); };
    var entries = [];                       // newest first

    function copy(e) {
      return { name: e.name, source: e.source, load: e.load, when: e.when };
    }

    return {
      /* Returns the stored entry, or null when the entry is not one (no name,
         an unknown source, nothing to load it again from). */
      add: function (entry) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) return null;
        if (SOURCES.indexOf(entry.source) < 0) return null;
        var k = key(entry);
        if (!k) return null;
        var stored = { name: entry.name, source: entry.source, load: entry.load, when: now() };
        for (var i = entries.length - 1; i >= 0; i--) {
          if (key(entries[i]) === k) entries.splice(i, 1);
        }
        entries.unshift(stored);
        if (entries.length > limit) entries.length = limit;
        return copy(stored);
      },
      /* Newest first. A copy: changing the array changes nothing here. */
      list: function () {
        return entries.map(copy);
      }
    };
  }

  var api = { createStore: createStore, key: key, LIMIT: DEFAULT_LIMIT };

  /* The store the page uses. `current` is swapped by use(); the two wrappers
     keep callers off the swap. */
  var current = createStore();
  api.use = function (store) {
    if (!store || typeof store.add !== 'function' || typeof store.list !== 'function')
      throw new Error('a recent store has add() and list()');
    current = store;
  };
  api.add = function (entry) { return current.add(entry); };
  api.list = function () { return current.list(); };

  /* A piece has just come onto the plate. `file` is what handleFiles read;
     `origin` is present when the library fetched it for us, and then carries
     the catalog entry to fetch again. Without it the piece came from a file.
     Never throws: remembering a load must not be able to break it. */
  api.noteLoad = function (file, origin) {
    try {
      var ref = origin && origin.source === 'library' && origin.load;
      if (ref && ref.file) {
        return api.add({ name: ref.file, source: 'library',
          load: { file: ref.file, category: ref.category, source: ref.source } });
      }
      if (file && file.name) return api.add({ name: file.name, source: 'file', load: { blob: file } });
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[recent] ' + (err && err.message ? err.message : err));
    }
    return null;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NSORecent = api;
})(typeof window !== 'undefined' ? window : this);
