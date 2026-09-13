/* Library catalog - STLs that live in library/ on this origin.

   One row per file. A row click fetches that file and hands it to
   handleFiles, which is the same function the file input and the drop
   target call, so a catalog load and a file drop are one import.

   The baked CATALOG is the fallback when GitHub cannot be reached.
   On each Library open we ask git for library/*.stl and redraw the
   list to match what is actually on main. Pages has no directory
   listing, so the live names come from the public contents API. */
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
  var GAP = 2;
  var GIT_LIST = 'https://api.github.com/repos/nolongerzzz/nest-optimizer/contents/library?ref=main';

  var liveNames = CATALOG.slice();

  function say(text, bad) {
    if (typeof setStatus === 'function') setStatus(text, !!bad);
  }

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

  function freeSlot(entry, others) {
    var plate = plateSize();
    var w = entry.width || 0, d = entry.depth || 0;
    var xMin = -plate.w / 2 + w / 2, xMax = plate.w / 2 - w / 2;
    var zMin = -plate.d / 2 + d / 2, zMax = plate.d / 2 - d / 2;
    if (xMin > xMax || zMin > zMax) return null;
    if (!others.length) return { x: 0, z: 0 };

    var last = others[others.length - 1];
    var rowZ = Math.min(Math.max(last.z, zMin), zMax);
    var startX = last.x + (last.width || 0) / 2 + GAP + w / 2;
    var step = Math.max(1, Math.min(w, d) / 2);
    for (var guard = 0; guard < 400; guard++) {
      var z = Math.min(Math.max(rowZ, zMin), zMax);
      for (var x = Math.max(startX, xMin); x <= xMax + 1e-6; x += step) {
        if (clears(x, z, w, d, others)) return { x: x, z: z };
      }
      if (z >= zMax - 1e-6) break;
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
    say('Loading ' + name + '\u2026');
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
      handleFiles([new File([buf], name, { type: 'model/stl' })]);
      waitForPlaced(before, name);
      done();
    }).catch(function (err) {
      fail(err && err.message ? err.message : String(err));
    });
  }

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

  function listEl() { return document.getElementById('library-list'); }
  function btnEl() { return document.getElementById('btn-library'); }

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

  function namesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function paintRows(names) {
    var host = listEl();
    if (!host) return;
    host.innerHTML = '';
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        var row = document.createElement('div');
        row.className = 'library-item';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.title = 'Load ' + DIR + name;
        var label = document.createElement('span');
        label.className = 'name';
        label.textContent = name;
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
      })(names[i]);
    }
  }

  function stlNamesFromGit(json) {
    if (!json || !json.length) return [];
    var out = [];
    for (var i = 0; i < json.length; i++) {
      var it = json[i];
      if (!it || it.type !== 'file' || !it.name) continue;
      if (!/\.stl$/i.test(it.name)) continue;
      out.push(it.name);
    }
    out.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return out;
  }

  function syncFromGit(thenOpen) {
    fetch(GIT_LIST, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      var names = stlNamesFromGit(json);
      if (!names.length) throw new Error('no stl in library/');
      if (!namesEqual(names, liveNames)) {
        liveNames = names;
        paintRows(liveNames);
      }
      if (thenOpen) setOpen(true);
    }).catch(function (err) {
      console.warn('[library] git list failed, using baked catalog:', err && err.message ? err.message : err);
      if (!liveNames.length) liveNames = CATALOG.slice();
      if (!listEl() || !listEl().childNodes.length) paintRows(liveNames);
      if (thenOpen) setOpen(true);
    });
  }

  function build() {
    var host = listEl();
    if (!host || host._libBuilt) return;
    host._libBuilt = true;
    paintRows(liveNames);

    var btn = btnEl();
    if (btn && !btn._libBound) {
      btn._libBound = true;
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (isOpen()) { setOpen(false); return; }
        syncFromGit(true);
      });
    }
    if (!document._libBound) {
      document._libBound = true;
      document.addEventListener('pointerdown', function (ev) {
        if (!isOpen()) return;
        var list = listEl(), b = btnEl();
        if (list && list.contains(ev.target)) return;
        if (b && b.contains(ev.target)) return;
        setOpen(false);
      }, true);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && isOpen()) setOpen(false);
      }, true);
    }
    setOpen(false);
    syncFromGit(false);
  }

  setOpen(false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () {
    setOpen(false);
    build();
  });
  else build();
  setTimeout(build, 0);
})();
