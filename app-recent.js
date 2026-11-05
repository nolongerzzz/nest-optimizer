/* Import > Recent - the list of what was loaded this session.

   It opens the way From Library does: a button in the Import dropdown and a
   list dropping straight down under it, in flow. A row is a recent load,
   newest first, whether the piece came from a file or from the library;
   clicking one loads it onto the plate again.

   What this file knows about the list is NSORecent.list() (nso-recent.js) and
   nothing else, so a store that remembers across sessions replaces the one
   behind it without this file changing. What it knows about a load is that a
   library entry is loaded by the library (nsoLibrary.load - the same fetch,
   the same seating as picking it from the catalog) and a file entry by
   handleFiles, which is what From File calls.

   Recording is not done here: handleFiles hands each piece that actually came
   in to NSORecent.noteLoad, so a file, a drop, a library row and a row of this
   list all arrive in the same place. */
(function () {
  function listEl() { return document.getElementById('recent-list'); }
  function btnEl() { return document.getElementById('btn-recent'); }
  function menuEl() {
    var list = listEl();
    return list ? list.closest('details') : null;
  }

  /* Open and closed are written in both places that can decide it, as the
     library list does - the attribute the stylesheet keys off and the inline
     display - by this one function. */
  function setOpen(open) {
    var list = listEl(), btn = btnEl();
    if (!list || !btn) return;
    if (open) {
      list.removeAttribute('hidden');
      list.style.display = '';
    } else {
      list.setAttribute('hidden', 'hidden');
      list.style.display = 'none';
    }
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function isOpen() {
    var list = listEl();
    return !!(list && !list.hasAttribute('hidden'));
  }

  function say(text, bad) {
    if (typeof setStatus === 'function') setStatus(text, !!bad);
  }

  function dismiss() {
    setOpen(false);
    var m = menuEl();
    if (m) m.open = false;
  }

  function reload(entry) {
    if (entry.source === 'library') {
      var lib = window.nsoLibrary;
      if (!lib || typeof lib.load !== 'function') { say('The library is not on this page', true); return; }
      lib.load(entry.load);
      return;
    }
    if (typeof handleFiles !== 'function') { say('No importer on this page', true); return; }
    handleFiles([entry.load.blob]);
  }

  function when(ms) {
    try { return new Date(ms).toLocaleTimeString(); } catch (e) { return ''; }
  }

  function makeRow(entry) {
    var row = document.createElement('div');
    row.className = 'library-item recent-item';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.source = entry.source;
    row.dataset.name = entry.name;
    row.title = 'Load ' + entry.name + ' again (' + (entry.source === 'library' ? 'from the library' : 'from a file') +
      ', ' + when(entry.when) + ')';
    var label = document.createElement('span');
    label.className = 'name';
    label.textContent = entry.name;
    row.appendChild(label);
    var tag = document.createElement('span');
    tag.className = 'recent-src';
    tag.textContent = entry.source === 'library' ? 'Library' : 'File';
    row.appendChild(tag);
    var go = function () { dismiss(); reload(entry); };
    row.addEventListener('click', function (ev) { ev.stopPropagation(); go(); });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
    });
    return row;
  }

  /* Redrawn each time it opens: the list is whatever the store holds then. */
  function render() {
    var host = listEl();
    if (!host) return Promise.resolve();
    return Promise.resolve(window.NSORecent.list()).then(function (rows) {
      host.textContent = '';
      if (!rows || !rows.length) {
        var none = document.createElement('div');
        none.className = 'recent-empty';
        none.textContent = 'Nothing loaded yet this session';
        host.appendChild(none);
        return;
      }
      for (var i = 0; i < rows.length; i++) host.appendChild(makeRow(rows[i]));
    }).catch(function (err) {
      console.warn('[recent] ' + (err && err.message ? err.message : err));
    });
  }

  function build() {
    var btn = btnEl();
    if (!btn || btn._recentBound || !window.NSORecent) return;
    btn._recentBound = true;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (isOpen()) { setOpen(false); return; }
      // one list at a time under Import
      if (window.nsoLibrary && typeof window.nsoLibrary.close === 'function') window.nsoLibrary.close();
      render().then(function () { setOpen(true); });
    });
    var lib = document.getElementById('btn-library');
    if (lib) lib.addEventListener('click', function () { setOpen(false); });

    // The dropdown shutting - by a load, Escape, pointing elsewhere, another
    // menu opening - puts the list away with it.
    var m = menuEl();
    if (m) m.addEventListener('toggle', function () { if (!m.open) setOpen(false); });
    document.addEventListener('pointerdown', function (ev) {
      if (!isOpen()) return;
      var mm = menuEl();
      if (mm && mm.contains(ev.target)) return;
      setOpen(false);
    }, true);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && isOpen()) setOpen(false);
    }, true);
    setOpen(false);
  }

  setOpen(false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
