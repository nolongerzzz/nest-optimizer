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

  function say(text, bad) {
    if (typeof setStatus === 'function') setStatus(text, !!bad);
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
      // A real File, so handleFiles reads it exactly as it reads a dropped
      // one - same reader, same name on the piece, same everything after.
      handleFiles([new File([buf], name, { type: 'model/stl' })]);
      done();
    }).catch(function (err) {
      fail(err && err.message ? err.message : String(err));
    });
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
        row.addEventListener('click', function () { loadOne(name, row); });
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); loadOne(name, row); }
        });
        host.appendChild(row);
      })(CATALOG[i]);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  setTimeout(build, 0);
})();
