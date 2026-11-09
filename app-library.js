/* Library catalog - the owner's STLs, served from the nest-library repo.

   One row per file. A row click fetches that file and hands it to
   handleFiles, which is the same function the file input and the drop
   target call, so a catalog load and a file drop are one import: the same
   parse, the same rotateX(-90deg) then centre, the same rawTris captured
   before either. Nothing here re-implements loading, and nothing here
   touches pack, Subtract, wrap or Finish.

   The names below are the catalog. They are not derived from a directory
   listing - neither Pages nor raw.githubusercontent.com serves one - and they
   are not generated from anything, because a name this file invents is a 404
   the owner has to go and debug. They are the owner's list, spelled the way
   the files in nolongerzzz/nest-library are spelled. */
(function () {
  /* ---- where a library lives ----------------------------------------

     A SOURCE is a library: a label and the base URL its files hang off.
     Every entry names one, and every entry resolves through resolve() to a
     FULL ABSOLUTE URL - scheme, host and all - never a bare 'library/name'.

     That was written when there was one source, this origin, and it was a
     distinction without a difference. It is what made the SECOND library -
     nest-library, below - cheap to add. With a relative path, "the library" and
     "this repo" are the same statement, and every consumer - the fetch, the
     row's title, anything that later wants to show where a piece came from -
     has quietly assumed it; splitting them means finding all of those. With
     a base URL per source, a library in another repo is a new row in this
     object and nothing else:

         'nso-extras': { label: 'Extras', base: 'https://someone.github.io/nso-extras/library/' }

     and an entry that names it. No new code, no fetch changes, no UI change.

     The local base is resolved against document.baseURI rather than written
     as a literal, because a literal https://...github.io/... would be a
     different origin under the local test harness and on any fork. Resolved,
     it is absolute on every origin the page is served from and correct on all
     of them. */
  var SOURCES = {
    local: {
      label: 'This project',
      base: new URL('library/', document.baseURI).href
    },
    /* The catalog's own repository. Every row lives here. The 31 pieces only
       the catalog needed (4.6 MB) left this repo's library/; what stayed is
       the fixtures the checks load by name (see library/README.md), nine of
       them also catalog rows with a byte-identical copy in nest-library.

       A literal, not resolved against document.baseURI, and that is the one
       place the note above does not apply: this is not "a path on whatever
       origin serves the page" but one fixed repository, and it answers the
       same on Pages, on the wip mirror, on a fork and under the test harness.
       raw.githubusercontent.com sends Access-Control-Allow-Origin: *, so the
       fetch in loadOne() needs nothing added. The branch is main - the branch
       app-library-access.js writes saved pieces to, so a save is loadable the
       moment it lands. tools/nso_library_dir.js carries the same string for
       the harness that answers these requests offline, and
       tools/nso_library_browser_test.js asserts the two are equal. */
    'nest-library': {
      label: 'nest-library',
      base: 'https://raw.githubusercontent.com/nolongerzzz/nest-library/main/'
    }
  };

  /* The taxonomy. Deliberately a rough first cut and expected to grow -
     Supports is here with nothing in it yet because the shape of the list
     matters more than today's membership, and the UI simply does not draw a
     category that has no entries.

     NOT a home for templates. A template would store generator parameters,
     not a file, and resolve() has nothing to say about it; that is a
     different concept and it stays out of this list rather than being bent
     to fit. */
  /* ONE LINE, and it has to stay one line. app-library-save.js edits this
     declaration in place with a regex over "var CATEGORIES = [ ... ];" so a
     Save can add a category the file has never seen; wrapped across two lines
     it stops matching, and every save fails with it. tools/nso_library_save_test.js
     is what says so. */
  var CATEGORIES = ['Skins', 'Supports', 'Washers', 'Traced Lines', 'Shaped Pieces', 'Stock Blanks', 'Test Fixtures'];

  /* One row per file, as before, now carrying the category it belongs to and
     the source it lives in. The file names are still the owner's list,
     spelled the way the files on disk are spelled, and they are still
     written as plain quoted literals - tools/nso_skin_fine_test.js greps
     this file for "'<name>'" to prove the shipped catalog has not drifted
     from what the sample generator writes.

     On the patches: _loose and _sandwich are the relief itself with no rim,
     which is the skin. They came in as one block called "skin patches" and
     split across categories on the way in, which is the point of tagging them
     rather than inheriting a name.

     The other half of that split, the four _bordered washers, is GONE - see
     the note on the patch block below. Washers stays in CATEGORIES with
     nothing in it, exactly as Supports does: the taxonomy is what the list
     should be able to hold, not an inventory, and build() simply does not
     draw a category with no entries. */
  var CATALOG = [
    { file: 'box_bit_12x8x8.stl',                      category: 'Shaped Pieces', source: 'local' },
    { file: 'box_closed.stl',                          category: 'Test Fixtures', source: 'local' },
    { file: 'box_hull_80x40x20-2.stl',                 category: 'Shaped Pieces', source: 'local' },
    { file: 'box_hull_80x40x20.stl',                   category: 'Shaped Pieces', source: 'local' },
    { file: 'CTH_fixture.stl',                         category: 'Test Fixtures', source: 'local' },
    { file: 'hinge_knuckle_box.stl',                   category: 'Shaped Pieces', source: 'local' },
    { file: 'pin.stl',                                 category: 'Shaped Pieces', source: 'local' },
    { file: 'soften_test_01_cube.stl',                 category: 'Test Fixtures', source: 'local' },
    { file: 'soften_test_03_thinwall_tube.stl',        category: 'Test Fixtures', source: 'local' },
    { file: 'soften_test_04_slotted_block.stl',        category: 'Test Fixtures', source: 'local' },
    { file: 'soften_test_05_star_prism.stl',           category: 'Test Fixtures', source: 'local' },
    { file: 'tape_on-edge-single-B101_rounded_v8_FINAL.stl', category: 'Test Fixtures', source: 'local' },
    { file: 'tape_on-edge-single.stl',                 category: 'Test Fixtures', source: 'local' },
    { file: 'USB_bit.stl',                             category: 'Shaped Pieces', source: 'local' },
    { file: 'v9_mirror_factory.stl',                   category: 'Test Fixtures', source: 'local' },
  ];

  /* The one way a file name becomes something fetchable. Absolute, always. */
  function resolve(entry) {
    var src = SOURCES[entry && entry.source];
    if (!src) return null;
    return new URL(encodeURIComponent(entry.file), src.base).href;
  }

  var GAP = 2;        // mm of clear plate between a new piece and anything placed

  function say(text, bad) {
    if (typeof setStatus === 'function') setStatus(text, !!bad);
  }

  /* ---- where the new piece goes ----

     handleFiles seats the piece the way a file drop does, and that seating
     marches every new piece to the right of the widest thing on the plate
     with no idea where the plate ends. Off a catalog of sixteen that walks
     straight off the bed and the pieces end up on top of each other.

     So after the piece is on the plate it is moved once, to the first slot
     that is clear of every placed footprint and still wholly on the bed:
     the middle for the first piece, then along the row beside the last one,
     then down to a new row when the row runs out of bed. Rectangles only -
     each piece's own width and depth - which is all "does not sit on an
     already-placed AABB" needs, and is not the packer. */
  /* state is a const in the core script, so it is a script-scope binding and
     NOT a property of window - reaching for window.state gets undefined and
     the seat is skipped. The same binding is visible here. */
  function placedList() {
    return (typeof state !== 'undefined' && state && state.placed) || null;
  }

  function plateSize() {
    // The bed the packer and the seat both use. Hard-coded because the
    // printer card that owns it is not loaded yet when this runs, and a
    // later change there is a later change here.
    return { w: 180, d: 180 };
  }

  /* The first clear rectangle on the plate. Returns null when none fits,
     which is the honest answer rather than stacking. */
  function freeSlot(entry, others) {
    var plate = plateSize();
    var w = entry.width || 20, d = entry.depth || 20;
    var xMin = -plate.w / 2 + w / 2, xMax = plate.w / 2 - w / 2;
    var zMin = -plate.d / 2 + d / 2, zMax = plate.d / 2 - d / 2;
    if (xMin > xMax || zMin > zMax) return null;

    function clears(x, z, w, d, others) {
      for (var i = 0; i < others.length; i++) {
        var o = others[i];
        var ow = o.width || 20, od = o.depth || 20;
        if (Math.abs(x - o.x) < (w + ow) / 2 + GAP &&
            Math.abs(z - o.z) < (d + od) / 2 + GAP) return false;
      }
      return true;
    }

    // First piece: the middle.
    if (!others.length) return { x: 0, z: 0 };

    // Walk from the last piece along the row, then drop.
    var last = others[others.length - 1];
    var rowZ = last.z;
    var startX = last.x + (last.width || 20) / 2 + GAP + w / 2;
    var bottom = -Infinity;
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      if (Math.abs(o.z - rowZ) < (o.depth || 0) / 2 + GAP)
        bottom = Math.max(bottom, o.z + (o.depth || 0) / 2);
    }
    var nextZ = (bottom > -Infinity) ? bottom + GAP + d / 2 : zMin + d / 2;
    if (!(nextZ > rowZ + 1e-6)) nextZ = rowZ + d + GAP;
    rowZ = nextZ;
    startX = xMin;
    if (rowZ > zMax + 1e-6) {
      // fall through to the full sweep
    } else {
      for (var x = startX; x <= xMax + 1e-6; x += Math.max(1, GAP)) {
        if (clears(x, rowZ, w, d, others)) return { x: x, z: rowZ };
      }
    }

    // Walking down from the last piece can run out of bed while there is
    // still plenty of it - everything above the first row, for one, which
    // nothing has walked through. Sweep the whole plate for the first clear
    // spot before giving up. Still first fit for the one piece being placed:
    // nothing already down is moved or reordered.
    // a gap-sized step, so a slot between two pieces is actually landed on
    // rather than stepped over
    var fine = Math.max(1, GAP);
    for (var zz = zMin; zz <= zMax + 1e-6; zz += fine) {
      for (var xx = xMin; xx <= xMax + 1e-6; xx += fine) {
        if (clears(xx, zz, w, d, others)) return { x: xx, z: zz };
      }
    }
    if (clears(xMax, zMax, w, d, others)) return { x: xMax, z: zMax };
    console.warn('[library] no free ' + w.toFixed(1) + ' x ' + d.toFixed(1) +
                 ' slot left on the ' + plate.w + ' x ' + plate.d + ' plate');
    return null;
  }

  /* Move the piece handleFiles just placed into that slot. Anything at all
     going wrong here leaves it exactly where handleFiles put it and says so
     - a piece on the plate in the wrong spot is a piece the owner can drag,
     and that beats a load that half happened. */
  function seat(before) {
    var placed = placedList();
    if (!placed || placed.length <= before) return true;
    var entry = placed[placed.length - 1];
    if (!entry) return true;
    var others = placed.slice(0, placed.length - 1);
    var slot = freeSlot(entry, others);
    if (!slot) return false;
    if (typeof applyPlacedXZ !== 'function') return false;
    applyPlacedXZ(entry, slot.x, slot.z);
    if (typeof refreshOutline === 'function') refreshOutline(entry);
    return true;
  }

  /* One row's worth of loading. Anything that stops it - the file is not
     there, the origin refused it, the body is empty - says the same thing
     and leaves the plate alone, because from the owner's side they are the
     same fact: that row did not come in. The console keeps the detail. */
  function loadOne(entry, row) {
    var name = entry.file;
    if (row) {
      if (row._libBusy) return;
      row._libBusy = true;
      row.classList.add('is-loading');
    }
    var url = resolve(entry);
    if (!url) {
      say('Library: no source for ' + name, true);
      if (row) { row._libBusy = false; row.classList.remove('is-loading'); }
      return;
    }
    var before = (placedList() || []).length;
    fetch(url).then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.blob();
    }).then(function (blob) {
      if (!blob || !blob.size) throw new Error('empty body');
      var file = new File([blob], name, { type: 'application/octet-stream' });
      if (typeof handleFiles !== 'function') throw new Error('no handleFiles');
      return Promise.resolve(handleFiles([file])).then(function () {
        if (!seat(before)) say('Library: ' + name + ' loaded, no free seat', true);
        else say('Library: ' + name);
        if (row) dismiss();
      });
    }).catch(function (err) {
      console.warn('[library]', name, err);
      say('Library: ' + name + ' did not load', true);
    }).then(function () {
      if (row) { row._libBusy = false; row.classList.remove('is-loading'); }
    });
  }

  /* ---- the menu -----------------------------------------------------

     The list is built once, from CATALOG, and then only shown or hidden.
     A category with no rows is not drawn. The rows are the only clickable
     things; the category heads are labels. */
  function listEl() { return document.getElementById('library-list'); }
  function btnEl() { return document.getElementById('library-btn'); }
  function menuEl() { return document.getElementById('library-menu'); }

  function anyOpen() {
    var m = menuEl();
    return m && !m.hidden;
  }

  function setOpen(open) {
    var m = menuEl(), b = btnEl();
    if (m) m.hidden = !open;
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function dismiss() { setOpen(false); }

  function build() {
    var list = listEl();
    if (!list) return;
    list.innerHTML = '';
    var byCat = {};
    for (var i = 0; i < CATALOG.length; i++) {
      var e = CATALOG[i];
      (byCat[e.category] || (byCat[e.category] = [])).push(e);
    }
    for (var c = 0; c < CATEGORIES.length; c++) {
      var cat = CATEGORIES[c];
      var rows = byCat[cat];
      if (!rows || !rows.length) continue;
      var head = document.createElement('div');
      head.className = 'library-cat';
      head.textContent = cat;
      list.appendChild(head);
      for (var r = 0; r < rows.length; r++) {
        var entry = rows[r];
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'library-row';
        row.textContent = entry.file;
        row.title = resolve(entry) || entry.file;
        row.addEventListener('click', loadOne.bind(null, entry, row));
        list.appendChild(row);
      }
    }
  }

  /* A save that just landed: the row is already in CATALOG, so rebuild. */
  function remember(entry) {
    CATALOG.push(entry);
    build();
  }

  /* The local half of a delete. */
  function forget(file) {
    for (var i = CATALOG.length - 1; i >= 0; i--)
      if (CATALOG[i].file === file) CATALOG.splice(i, 1);
    build();
  }

  /* ---- open and close -----------------------------------------------

     The button toggles. Clicking anywhere else closes, except the button
     itself and the menu. A row click loads and then dismisses. Escape
     dismisses. The pointerdown is on document and in the capture phase so
     it fires before a click that might stopPropagation. */
  function wire() {
    var b = btnEl();
    if (b && !b._libWired) {
      b._libWired = true;
      b.addEventListener('click', function () {
        if (anyOpen()) dismiss();
        else setOpen(true);
      });
    }
    /* The menu is a sibling of the button, not a child, so a click on the
       button does not bubble into the menu and a click on a row does not
       hit the button. The dismiss has to know about both. A click on the
       list and a row are all things you point at while still using the menu,
       and hiding it under the pointer would destroy a row before its own
       click could fire. The row's click is what loads, and loading dismisses
       on its own. */
    if (!document._libBound) {
      document._libBound = true;
      document.addEventListener('pointerdown', function (ev) {
        if (!anyOpen()) return;
        var list = listEl(), b = btnEl(), m = menuEl();
        if (list && list.contains(ev.target)) return;
        if (b && b.contains(ev.target)) return;
        if (m && m.contains(ev.target)) return;
        dismiss();
      }, true);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && anyOpen()) dismiss();
      }, true);
    }
    setOpen(false);
  }

  /* The catalog, readable from outside. The drive check proves every entry
     resolves to a full absolute URL and that each category holds what it
     should; neither is provable from the DOM alone, and neither should be
     re-derived by a test guessing at the base. */
  window.nsoLibrary = {
    categories: CATEGORIES.slice(),
    sources: SOURCES,
    entries: function () { return CATALOG.slice(); },
    urlFor: function (file) {
      for (var i = 0; i < CATALOG.length; i++)
        if (CATALOG[i].file === file) return resolve(CATALOG[i]);
      return null;
    },
    /* The local half of a delete, exposed so the drive check can watch the
       browser actually lose the row. NOT a delete: it touches this page and
       nothing else. The repository side is app-library-delete.js's. */
    forget: forget,
    /* Load one catalog entry onto the plate - what a row click does, for a
       caller with no row (Import > Recent). */
    load: function (entry) { loadOne(entry, null); },
    /* Put the list away without touching the Import dropdown around it. */
    close: function () { setOpen(false); },
    /* And the local half of a save. Same rule, same non-claim: it touches
       this page and nothing else. app-library-save.js calls it once the two
       commits have really landed. */
    add: remember
  };

  // Closed before anything else is wired, and again once the rows exist, so
  // it never depends on a first click - or on build() having got that far.
  setOpen(false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () {
    setOpen(false);
    build();
  });
  else build();
  setTimeout(build, 0);
})();
