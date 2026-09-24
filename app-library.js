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
    { file: 'USB_bit.stl',                        category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'usb_a_bit.stl',                      category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'usb_c_bit.stl',                      category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'sd_bit.stl',                         category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'microsd_bit.stl',                    category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'box_bit_12x8x8.stl',                 category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'box_hull_80x40x20.stl',              category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'box_hull_80x40x20-2.stl',            category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'box_closed.stl',                     category: 'Test Fixtures', source: 'nest-library' },
    { file: 'box_open.stl',                       category: 'Test Fixtures', source: 'nest-library' },
    { file: 'lid_blank.stl',                      category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'lid_strap.stl',                      category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'hinge_knuckle_box.stl',              category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'hinge_knuckle_lid.stl',              category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'hinge_pip.stl',                      category: 'Shaped Pieces', source: 'nest-library' },
    { file: 'pin.stl',                            category: 'Shaped Pieces', source: 'nest-library' },
    /* Skin patches - a pattern as its own printable piece, loadable here so a
       test coupon does not have to be baked through the Finish tab every time.
       Generated by tools/nso_skin_fine_samples.js, which also byte-checks the
       `loose` files against the gated fixtures in fixtures/skin-patches/ so
       this list can never drift from them.
       All 30 x 30 mm, the footprint the skin samples use - except the loose
       ring, which is 2 x rOut = 10 x 10 and says so in its own manifest.
         _loose     the pattern's features alone, no rim, no backing plate
         _sandwich  double-sided: the pattern on BOTH faces, no floor between
                    them - the piece a sandwich test needs
         -fine      the tighter 0.84 mm pitch (0.42 mm channel, one 0.4-nozzle
                    extrusion line) against the shipped 1.2 mm default

       THE FOUR _bordered WASHERS ARE NOT HERE ANY MORE. `bordered` set the
       pattern in a solid rim on a 0.6 mm floor, and the rim plus the standing
       ribs it enclosed bonded to whatever was stacked on them far too well to
       be usable as a separating washer - measured at 2.857x the contact of a
       true flat line. patch_crosshatch_bordered, patch_crosshatch-fine_bordered,
       patch_zigzag_bordered and patch_ring_bordered were removed from this
       catalog and from library/ together, so there is no dangling row.

       Only the SHIPPED SAMPLES went. NSO_SkinPatch still builds the bordered
       variant, the Finish tab still offers it, and fixtures/skin-patches/
       still gates it - nso_skin_patch_test.js proves that geometry and would
       have to be rewritten to drop it, which is a different ticket from
       "these four coupons are not worth printing". */
    { file: 'patch_crosshatch_loose.stl',         category: 'Skins',   source: 'nest-library' },
    { file: 'patch_crosshatch_sandwich.stl',      category: 'Skins',   source: 'nest-library' },
    { file: 'patch_crosshatch-fine_loose.stl',    category: 'Skins',   source: 'nest-library' },
    { file: 'patch_crosshatch-fine_sandwich.stl', category: 'Skins',   source: 'nest-library' },
    { file: 'patch_zigzag_loose.stl',             category: 'Skins',   source: 'nest-library' },
    { file: 'patch_ring_loose.stl',               category: 'Skins',   source: 'nest-library' },
    /* Traced lines - a picture of line art built as flat printed lines by
       nso_raster_lines.js, the Finish tab's Trace raster button. Their own
       category and not Skins: a skin is a pattern this repo generates over a
       face, and these are whatever somebody drew.

       Generated by tools/nso_raster_library_samples.js, which builds each from
       a file in fixtures/raster-real/ - pictures Chromium drew, not this repo -
       and refuses to write any piece whose component and junction counts
       disagree with what the picture actually contains.
       tools/nso_raster_real_test.js validates those pictures first, against
       their own ground truth and against an independent pixel probe, and
       tools/nso_raster_real_drive_check.js opens two of them through the
       shipped file input in real Chromium.

       All 30 x 30 mm, the skin patches' footprint, and all three a
       one-extrusion-line lattice at 0.42 mm - the repo's own minimum wall - so
       all three are non-solid for the reason the loose patches are.
         _cross_23-67    the interface crossing, at an angle no synthetic
                         fixture used; the piece that found the bridge bug
         _parallel_113   two strokes that touch nothing - the width coupon
         _hand_stroke    a hand-drawn wobble, followed rather than straightened */
    { file: 'traced_cross_23-67.stl',             category: 'Traced Lines', source: 'nest-library' },
    { file: 'traced_parallel_113.stl',            category: 'Traced Lines', source: 'nest-library' },
    { file: 'traced_hand_stroke.stl',             category: 'Traced Lines', source: 'nest-library' },
    /* Stock Blanks - the eight primitives NSO_Stock makes, one of each, all
       sized from ONE target: a 10 mm piece with a 1 mm wall, which needs
       469.668 mm^3 at the default 30% waste margin. That is the whole reason
       they are a category and not eight more Shaped Pieces: a shaped piece is
       a part, and these are BLANKS - the thing Carve, Hollow, Cut and Seat all
       want to start from and previously had to be generated for one at a time
       through the Stock card.

       Sized from one target means they all hold the same material, so picking
       between them here is picking a SHAPE and nothing else. Built at 32
       segments rather than the card's 96, so the round ones are about 2k
       triangles instead of 18k - a blank to try a tool on, not a blank to
       print a vessel from. The card is still where you get one sized for your
       own target.

       Generated by tools/nso_quick_fixtures.js into fixtures/quick/ and
       copied here, the same way the hinge and strap fixtures are in both
       places. tools/nso_quick_test.js section 6 byte-compares every row below
       against its fixture, so the two copies cannot drift apart. */
    { file: 'shape-sphere.stl',                   category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-box.stl',                      category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-cylinder.stl',                 category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-cone.stl',                     category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-tube.stl',                     category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-torus.stl',                    category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-capsule.stl',                  category: 'Stock Blanks',  source: 'nest-library' },
    { file: 'shape-ellipsoid.stl',                category: 'Stock Blanks',  source: 'nest-library' },
    /* Test Fixtures - the fast half of fixtures/quick/. Twelve triangles each
       and a minute and a half to eight and a half minutes to print SOLID,
       which is the worst case; fixtures/quick/quick.json carries the model
       that figure comes from.

       A cube is the workhorse of half the drive checks in this repo and the
       only one there was is 20 mm, so this is a size LADDER - roughly three
       times the material at each step. The plate and the bar are here because
       a good deal of code branches on aspect ratio and a cube exercises none
       of it: one piece with a dominant flat face, one with a dominant long
       axis.

       These rest on z = 0, like everything NSO_Stock makes. box_open.stl and
       box_closed.stl above do not, and neither does fixtures/box-20mm.stl -
       they predate this and the Soften gate measures against that placement. */
    { file: 'cube-6mm.stl',                       category: 'Test Fixtures', source: 'nest-library' },
    { file: 'cube-9mm.stl',                       category: 'Test Fixtures', source: 'nest-library' },
    { file: 'cube-12mm.stl',                      category: 'Test Fixtures', source: 'nest-library' },
    { file: 'plate-20x20x2.stl',                  category: 'Test Fixtures', source: 'nest-library' },
    { file: 'bar-20x5x5.stl',                     category: 'Test Fixtures', source: 'nest-library' },
    { file: 'tape_on-edge-single.stl',            category: 'Test Fixtures', source: 'nest-library' },
    { file: 'v9_mirror_factory.stl',              category: 'Test Fixtures', source: 'nest-library' },
    /* Damaged on purpose - a clean fixtures/quick/ piece with ONE controlled
       defect each, named <clean>_<defect>. Made by tools/nso_damage.js through
       tools/nso_damage_make_fixtures.js; fixtures/damage/damage.json carries
       the exact numbers tools/mesh_validate.py must read off each, and
       tools/nso_damage_test.js holds them to it and byte-compares each row's
       file in nest-library against fixtures/damage/. Load one to try a repair on a defect whose
       size is known in advance. docs/DAMAGE.md has the table.
         _hole / _holes-shredded   real holes: open edges and nothing else
         _severed                  ring wall cut through and capped: valid,
                                   only genus moves (the cutClearance case)
         _nm-duplicate             a patch doubled in place: non-manifold,
                                   nothing missing
         _winding-flip             a patch flipped in place: winding only
         _weld-collide             a vertex 5e-5 mm from a distinct one,
                                   inside the 1e-4 weld (rawCut's seam bug) */
    { file: 'shape-sphere_hole.stl',              category: 'Test Fixtures', source: 'nest-library' },
    { file: 'shape-sphere_holes-shredded.stl',    category: 'Test Fixtures', source: 'nest-library' },
    { file: 'shape-tube_severed.stl',             category: 'Test Fixtures', source: 'nest-library' },
    { file: 'shape-sphere_nm-duplicate.stl',      category: 'Test Fixtures', source: 'nest-library' },
    { file: 'shape-sphere_winding-flip.stl',      category: 'Test Fixtures', source: 'nest-library' },
    { file: 'shape-torus_weld-collide.stl',       category: 'Test Fixtures', source: 'nest-library' }
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
     any guard written against it quietly turns its own feature off. Read the
     binding itself. */
  function placedList() {
    return (typeof state !== 'undefined' && state && state.placed) ? state.placed : null;
  }

  function plateSize() {
    if (typeof getCurrentPlate === 'function') {
      var pl = getCurrentPlate();
      if (pl && pl.w > 0 && pl.d > 0) return { w: pl.w, d: pl.d };
    }
    return { w: 180, d: 180 };
  }

  function clears(x, z, w, d, others) {
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      var ow = (o.width || 0) / 2 + w / 2 + GAP;
      var od = (o.depth || 0) / 2 + d / 2 + GAP;
      if (Math.abs(x - o.x) < ow - 1e-6 && Math.abs(z - o.z) < od - 1e-6) return false;
    }
    return true;
  }

  // The slot, or null when the bed has no room left for this piece.
  function freeSlot(entry, others) {
    var plate = plateSize();
    var w = entry.width || 0, d = entry.depth || 0;
    var xMin = -plate.w / 2 + w / 2, xMax = plate.w / 2 - w / 2;
    var zMin = -plate.d / 2 + d / 2, zMax = plate.d / 2 - d / 2;
    if (xMin > xMax || zMin > zMax) return null;          // bigger than the bed
    if (!others.length) return { x: 0, z: 0 };            // first piece: the middle

    var last = others[others.length - 1];
    // rows walk down the bed from wherever the last piece sits, and along it
    // from just past that piece; a row that runs out of bed starts again at
    // the left edge one row further down
    var rowZ = Math.min(Math.max(last.z, zMin), zMax);
    var startX = last.x + (last.width || 0) / 2 + GAP + w / 2;
    var step = Math.max(1, Math.min(w, d) / 2);
    for (var guard = 0; guard < 400; guard++) {
      var z = Math.min(Math.max(rowZ, zMin), zMax);
      for (var x = Math.max(startX, xMin); x <= xMax + 1e-6; x += step) {
        if (clears(x, z, w, d, others)) return { x: x, z: z };
      }
      if (z >= zMax - 1e-6) break;
      // next row: below everything this row is holding
      var bottom = -Infinity;
      for (var i = 0; i < others.length; i++) {
        var o = others[i];
        if (Math.abs(o.z - z) < (o.depth || 0) / 2 + d / 2 + GAP)
          bottom = Math.max(bottom, o.z + (o.depth || 0) / 2);
      }
      var nextZ = (bottom > -Infinity) ? bottom + GAP + d / 2 : z + d + GAP;
      if (!(nextZ > rowZ + 1e-6)) nextZ = rowZ + d + GAP;
      rowZ = nextZ;
      startX = xMin;
      if (rowZ > zMax + 1e-6) break;
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
    var done = function () {
      if (!row) return;
      row._libBusy = false;
      row.classList.remove('is-loading');
    };
    var fail = function (why) {
      console.warn('[library] ' + name + ': ' + why);
      say('Library load failed - ' + name, true);
      done();
    };
    say('Loading ' + name + '…');
    var url = resolve(entry);
    if (!url) { fail('no source named ' + entry.source); return; }
    fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      if (!buf || buf.byteLength < 84) throw new Error('empty or truncated (' +
        (buf ? buf.byteLength : 0) + ' bytes)');
      if (typeof handleFiles !== 'function') throw new Error('no importer on this page');
      var nowPlaced = placedList();
      var before = nowPlaced ? nowPlaced.length : 0;
      // A real File, so handleFiles reads it exactly as it reads a dropped
      // one - same reader, same name on the piece, same everything after.
      handleFiles([new File([buf], name, { type: 'model/stl' })]);
      // handleFiles reads the file asynchronously, so the piece is not on
      // the plate yet; seat it on the turn it arrives.
      waitForPlaced(before, name);
      done();
    }).catch(function (err) {
      fail(err && err.message ? err.message : String(err));
    });
  }

  /* handleFiles hands the file to a FileReader, so the piece lands a turn or
     two later. Watch for it rather than guessing a delay, give up quietly if
     it never arrives - handleFiles has already said why in that case. */
  function waitForPlaced(before, name) {
    var tries = 0;
    var tick = function () {
      var placed = placedList();
      var now = placed ? placed.length : 0;
      if (now > before) {
        var ok;
        try { ok = seat(before); }
        catch (err) {
          console.warn('[library] seating ' + name + ': ' + (err && err.message ? err.message : err));
          ok = false;
        }
        if (!ok) say('Library placed stacked', true);
        return;
      }
      if (++tries < 240) setTimeout(tick, 25);
    };
    setTimeout(tick, 0);
  }

  /* ---- the dropdown ---- */

  function listEl() { return document.getElementById('library-list'); }
  function btnEl() { return document.getElementById('btn-library'); }

  /* Open and closed are written in both places that can decide it - the
     attribute the stylesheet keys off, and the inline display that holds
     even with no stylesheet at all - by this one function, so the two can
     never drift. The page ships closed in the markup the same way, so the
     list is closed at first paint without waiting for any of this to run. */
  function setOpen(open) {
    var list = listEl(), btn = btnEl();
    if (!list || !btn) return;
    if (open) {
      list.removeAttribute('hidden');
      list.style.display = '';        // back to the flex the class asks for
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

  /* The menu the list is sitting in. Found by walking up rather than named,
     because the list has already moved once - it was its own popover off a
     bar button before the Import dropdown existed - and this should keep
     working wherever it lands next. */
  function menuEl() {
    var list = listEl();
    return list ? list.closest('details') : null;
  }

  /* Dismissal: the list AND the dropdown holding it.

     Deliberately NOT folded into setOpen. setOpen is the From Library
     button's own toggle, and collapsing the list with that button must not
     tear down the whole Import dropdown around it - the From File button is
     in there too. Dismissal is the other thing: the user is done with the
     menu, by loading a piece, by pressing Escape, or by pointing somewhere
     else entirely. */
  function dismiss() {
    setOpen(false);
    var m = menuEl();
    if (m) m.open = false;
  }
  function anyOpen() {
    var m = menuEl();
    return isOpen() || !!(m && m.open);
  }

  /* One row. Same element, same class, same .name span holding the file's
     own name - nso_skin_fine_drive_check finds rows by that name and clicks
     them, and a row is still a row wherever it now sits. */
  function makeRow(entry) {
    var row = document.createElement('div');
    row.className = 'library-item';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.dataset.category = entry.category;
    row.dataset.source = entry.source;
    row.dataset.file = entry.file;
    // The full URL, so hovering a row tells you exactly what will be fetched
    // and from where - which is the question that matters the moment there
    // is more than one library.
    row.title = 'Load ' + resolve(entry);
    var label = document.createElement('span');
    label.className = 'name';
    label.textContent = entry.file;   // the file's own name, never a prettied one
    row.appendChild(label);
    row.appendChild(makeDeleteBtn(entry, row));
    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      dismiss();
      loadOne(entry, row);
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault(); dismiss(); loadOne(entry, row);
      }
    });
    return row;
  }

  /* ---- the delete affordance ------------------------------------------

     A row's own small x, rather than a mode or a second menu: the thing being
     deleted is the row, and anything that makes you first say "now I am
     deleting" and then pick is a mode you can forget you are in.

     This is the ONLY place in the app that starts a delete, and all it knows
     how to do is hand the entry to window.nsoLibraryDelete.request. It does
     not ask whether deleting is allowed, does not raise the confirmation,
     does not know a token or an API exists. app-library-delete.js owns every
     one of those, behind that one call, so a real permission check later is
     an edit inside that module and not a hunt through this one.

     If the module is not on the page there is simply no x - the browser
     degrades to what it was, rather than growing a button that throws. */
  function makeDeleteBtn(entry, row) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'library-del';
    btn.textContent = '\u00d7';
    btn.title = 'Delete ' + entry.file + ' from the library';
    btn.setAttribute('aria-label', 'Delete ' + entry.file);
    btn.addEventListener('click', function (ev) {
      // Never let the click reach the row: clicking x must not also load.
      ev.stopPropagation();
      ev.preventDefault();
      var del = window.nsoLibraryDelete;
      if (!del || typeof del.request !== 'function') {
        say('Deleting is not available on this page', true);
        return;
      }
      del.request(entry, { onDeleted: function (e) { forget(e.file); } });
    });
    // The row answers Enter and Space; the button is inside the row, so stop
    // those here too or the x's own Enter would load the piece as well.
    btn.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation();
    });
    return btn;
  }

  /* The local half of a delete: drop the entry from the in-memory catalog and
     take its row out of the list. Called only after the repository side has
     actually succeeded, so the browser never shows a piece as gone that is
     still there. A group that loses its last row is removed outright, which
     is the same rule build() applies - an empty category is not drawn. */
  function forget(file) {
    var i;
    for (i = CATALOG.length - 1; i >= 0; i--) {
      if (CATALOG[i].file === file) CATALOG.splice(i, 1);
    }
    var rows = document.querySelectorAll('#library-list .library-item');
    for (i = 0; i < rows.length; i++) {
      if (rows[i].dataset.file !== file) continue;
      var sec = rows[i].closest ? rows[i].closest('.library-sec') : null;
      rows[i].parentNode.removeChild(rows[i]);
      if (!sec) continue;
      var left = sec.querySelectorAll('.library-item').length;
      if (!left) { sec.parentNode.removeChild(sec); continue; }
      var badge = sec.querySelector('.library-sec-count');
      if (badge) badge.textContent = left;
    }
  }

  /* The local half of a SAVE - the mirror of forget() above, and called under
     exactly the same rule: only after the repository side has actually
     succeeded, so the browser never shows a piece as saved that is not there.

     A category the taxonomy has not seen before is appended to it, because
     build() does not draw a category it does not know and a piece filed under
     one would simply be invisible. Its section is created on the spot, at the
     end, which is where CATEGORIES just put it.

     Like forget(), this touches this page and nothing else. The repository
     side is app-library-save.js's, and this file does not know that module
     exists - it does not call it, and the Save button is not wired here. */
  function remember(entry) {
    if (!entry || !entry.file) return null;
    var i;
    for (i = 0; i < CATALOG.length; i++) if (CATALOG[i].file === entry.file) return CATALOG[i];
    var e = { file: entry.file, category: entry.category, source: entry.source || 'local' };
    CATALOG.push(e);
    if (CATEGORIES.indexOf(e.category) === -1) {
      CATEGORIES.push(e.category);
      /* The exported list is a copy, deliberately, so push the same name onto
         it rather than handing the live array out. */
      if (window.nsoLibrary && window.nsoLibrary.categories &&
          window.nsoLibrary.categories.indexOf(e.category) === -1)
        window.nsoLibrary.categories.push(e.category);
    }

    var host = document.getElementById('library-list');
    if (!host || !host._libBuilt) return e;   // nothing drawn yet; build() will

    var secs = host.querySelectorAll('.library-sec'), sec = null;
    for (i = 0; i < secs.length; i++) {
      if (secs[i].dataset.sec === e.category) { sec = secs[i]; break; }
    }
    if (!sec) {
      sec = document.createElement('details');
      sec.className = 'vp-sec library-sec';
      sec.dataset.sec = e.category;
      sec.open = true;
      var head = document.createElement('summary');
      head.className = 'vp-sec-head';
      head.textContent = e.category;
      var badge = document.createElement('span');
      badge.className = 'library-sec-count';
      badge.textContent = '0';
      head.appendChild(badge);
      sec.appendChild(head);
      var fresh = document.createElement('div');
      fresh.className = 'vp-sec-body';
      sec.appendChild(fresh);
      host.appendChild(sec);
    }
    var body = sec.querySelector('.vp-sec-body');
    if (body) body.appendChild(makeRow(e));
    var count = sec.querySelector('.library-sec-count');
    if (count) count.textContent = sec.querySelectorAll('.library-item').length;
    return e;
  }

  function build() {
    var host = document.getElementById('library-list');
    if (!host || host._libBuilt) return;
    host._libBuilt = true;

    /* Grouped by category, in CATEGORIES order, using the same <details>
       convention the Finish menu's groups use so the two read as one system.
       A category with no entries is not drawn at all - Supports is in the
       taxonomy before it has members, and an empty heading is just a dead
       row to scroll past.

       Every group ships OPEN. The Finish menu's groups start shut because it
       is a tool palette you return to all day; this is a browser you opened
       to find one piece, and hiding all 26 behind five more clicks is the
       opposite of what the button was pressed for. The grouping is here to
       make the list scannable, not shorter. */
    var byCat = {};
    for (var i = 0; i < CATALOG.length; i++) {
      var e = CATALOG[i];
      (byCat[e.category] = byCat[e.category] || []).push(e);
    }
    // A category that is in no entry would silently vanish; say so instead.
    for (var k in byCat) {
      if (CATEGORIES.indexOf(k) === -1)
        console.warn('[library] entries tagged "' + k + '", which is not in CATEGORIES');
    }

    /* Accordion: at most one category open at a time, so the panel stays a
       fixed handful of rows tall instead of growing to every category's
       combined length and dragging the whole page into a scroll. Bound to
       the summary's CLICK, not the <details> 'toggle' event or its 'open'
       property - a test (or any other caller) that forces every section
       open with `sec.open = true` to reach a row across categories is not a
       user working the accordion and must keep working exactly as before;
       only an actual click on a heading closes the others. preventDefault
       stops the native toggle so this function is the only thing that sets
       .open, and it decides all of it in one place: already open -> close
       it; otherwise -> close every other section, then open this one. */
    function armAccordion(sec, head) {
      head.addEventListener('click', function (ev) {
        ev.preventDefault();
        var willOpen = !sec.open;
        var secs = host.querySelectorAll('.library-sec');
        for (var i = 0; i < secs.length; i++) {
          if (secs[i] !== sec) secs[i].open = false;
        }
        sec.open = willOpen;
      });
    }

    for (var c = 0; c < CATEGORIES.length; c++) {
      var cat = CATEGORIES[c];
      var rows = byCat[cat];
      if (!rows || !rows.length) continue;
      var sec = document.createElement('details');
      sec.className = 'vp-sec library-sec';
      sec.dataset.sec = cat;
      /* Shut, like the Finish menu's groups. They shipped open on the theory
         that a browser you opened to find one piece should show you the
         pieces - but that was written when the list was its own popover. In
         the Import dropdown it means every category's rows are in front of
         you before you have said which category you want, and you scroll
         past all of them to reach the one you do. Closed, the four headings
         and their counts fit at a glance and one click gets you there.
         Unlike Finish's groups, these are an ACCORDION: opening one closes
         whichever other category was open, so the list never stacks two
         categories' rows (and the page-level scroll that caused) at once. */
      sec.open = false;
      var head = document.createElement('summary');
      head.className = 'vp-sec-head';
      head.textContent = cat;
      var count = document.createElement('span');
      count.className = 'library-sec-count';
      count.textContent = rows.length;
      head.appendChild(count);
      sec.appendChild(head);
      var body = document.createElement('div');
      body.className = 'vp-sec-body';
      for (var r = 0; r < rows.length; r++) body.appendChild(makeRow(rows[r]));
      sec.appendChild(body);
      host.appendChild(sec);
      armAccordion(sec, head);
    }

    var btn = btnEl();
    if (btn && !btn._libBound) {
      btn._libBound = true;
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        setOpen(!isOpen());
      });
    }
    /* Pointer down outside, or Escape, dismisses it. This handler already
       did that for the bare list; it now covers the dropdown holding it, so
       pointing at the plate, at a placed piece, or anywhere else puts the
       whole thing away.

       On pointerdown and not click: a drag on the viewport - orbiting the
       scene, moving a piece - never produces a click, so a click-based
       close leaves the menu hanging over the model for the whole drag. And
       in the capture phase, because the canvas handlers stop propagation on
       their own pointerdowns and a bubble listener never hears those at all.

       Anywhere INSIDE the menu is left alone, which now means the panel and
       not just the list: From File, a category heading and a row are all
       things you point at while still using the menu, and hiding it under
       the pointer would destroy a row before its own click could fire. The
       row's click is what loads, and loading dismisses on its own. */
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
