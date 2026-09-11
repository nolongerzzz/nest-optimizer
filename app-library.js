/* Library catalog - the owner's STLs that live in library/ on this origin.

   One row per file. A row click fetches that file and hands it to
   handleFiles, which is the same function the file input and the drop
   target call, so a catalog load and a file drop are one import: the same
   parse, the same rotateX(-90deg) then centre, the same rawTris captured
   before either. Nothing here re-implements loading, and nothing here
   touches pack, Subtract, wrap or Finish.

   The names below are the catalog. They are not derived from a directory
   listing - Pages does not serve one - and they are not generated from
   anything, because a name this file invents is a 404 the owner has to go
   and debug. They are the owner's list, spelled the way the files on disk
   are spelled. */
(function () {
  var CATALOG = [
    'USB_bit.stl',
    'usb_a_bit.stl',
    'usb_c_bit.stl',
    'sd_bit.stl',
    'microsd_bit.stl',
    'box_bit_12x8x8.stl',
    'box_hull_80x40x20.stl',
    'box_hull_80x40x20-2.stl',
    'box_closed.stl',
    'box_open.stl',
    'lid_blank.stl',
    'lid_strap.stl',
    'hinge_knuckle_box.stl',
    'hinge_knuckle_lid.stl',
    'hinge_pip.stl',
    'pin.stl'
  ];

  var DIR = 'library/';
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
  function loadOne(name, row) {
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
    var url = DIR + encodeURIComponent(name);
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

  function setOpen(open) {
    var list = listEl(), btn = btnEl();
    if (!list || !btn) return;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function isOpen() {
    var list = listEl();
    return !!(list && !list.hidden);
  }

  function build() {
    var host = document.getElementById('library-list');
    if (!host || host._libBuilt) return;
    host._libBuilt = true;
    for (var i = 0; i < CATALOG.length; i++) {
      (function (name) {
        var row = document.createElement('div');
        row.className = 'library-item';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.title = 'Load ' + DIR + name;
        var label = document.createElement('span');
        label.className = 'name';
        label.textContent = name;     // the file's own name, never a prettied one
        row.appendChild(label);
        row.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setOpen(false);
          loadOne(name, row);
        });
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault(); setOpen(false); loadOne(name, row);
          }
        });
        host.appendChild(row);
      })(CATALOG[i]);
    }

    var btn = btnEl();
    if (btn && !btn._libBound) {
      btn._libBound = true;
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        setOpen(!isOpen());
      });
    }
    // click off, or Escape, closes it
    if (!document._libBound) {
      document._libBound = true;
      document.addEventListener('click', function (ev) {
        if (!isOpen()) return;
        var list = listEl(), b = btnEl();
        if (list && list.contains(ev.target)) return;
        if (b && b.contains(ev.target)) return;
        setOpen(false);
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && isOpen()) setOpen(false);
      });
    }
    setOpen(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  setTimeout(build, 0);
})();
