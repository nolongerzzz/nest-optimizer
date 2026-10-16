/* Findings — Check's results on a card, a ring on every problem, and a fix
 * button that is the Finish menu's own.
 *
 * WHAT IT IS. Pressing Check (app-defects.js) paints 1 px lines and patches on
 * the piece. On a 2,000-triangle sphere seven open edges are seven pixels: the
 * check found them and you still cannot. This file adds three things on top
 * of that check, and changes nothing about how it measures or what colour it
 * paints:
 *
 *   1. A card, docked at the right edge of the viewport under the top-right
 *      buttons, one row per kind of problem: what was found, in numbers, and
 *      one sentence on what it means for a print. Clicking a row flies the
 *      camera to the nearest problem of that kind and pulses its ring.
 *   2. A ring and a number on every problem. NSO_Findings.group (nso-findings.js)
 *      sorts the report's marks into problems - one per hole, one per patch of
 *      doubled edges, and so on - and each gets a ring sized to it.
 *   3. The fix that fits. Every finding on a row is an ITEM - one hole, one
 *      pair of faces, one thin wall - and each names the fix chosen from that
 *      finding's own geometry, on its own button, run on that finding only:
 *
 *        open loop, rim flat            CAP      this loop (nso_patch.js cap)
 *        open loop, rim curved          PATCH    this loop (nso_patch.js patch)
 *        two openings / two faces
 *          within 2x the wall           BRIDGE   this pair (nso_patch.js)
 *        doubled, pinched, unclosed     REPAIR   Seal with Repair, whole piece
 *        thin wall                      THICKEN OUT +mm to two nozzle widths
 *
 *      CAP, PATCH and BRIDGE call window.nsoRepairRun (app-patch.js) with the
 *      item's anchor vertices, so the fix finds the loops again on the piece as
 *      it stands. REPAIR is the existing control: it ticks #chk-seal-repair,
 *      clicks #btn-seal and puts the tick back - the same click, the same code,
 *      the same Undo entry and status line. THICKEN OUT types the mm into
 *      #inp-thicken-mm and clicks #btn-thicken-out. "Fix all" runs every
 *      item's own fix in the card's order (never the advisory gap). Each fix
 *      is one Undo.
 *
 * ALWAYS RE-SCAN. Cap, Seal, Solidify and Thicken out are watched at the
 * document, and Patch / Cap / Bridge are bracketed by the card itself: a
 * capture-phase listener takes the "before" reading before the button's own
 * handler runs, a bubble-phase one takes the "after" reading once it has, and
 * the card says "Before: 221 open edges. Now: 0." for that action until the
 * next one. That covers the card's buttons and the Finish menu's alike,
 * because the card's buttons ARE the Finish menu's. The re-scan pushes no
 * Undo entry, so one Undo still reverses the fix, and the piece changing
 * under the marks then turns the card stale.
 *
 * DRAWN THROUGH THE PIECE, NEVER PICKED. Rings and numbers are depthTest off,
 * raycast stubbed, renderOrder above the marks - the call app-defects.js makes
 * for its own layers. They are NOT children of the piece's mesh, which is
 * where the marks live: a ring is bigger than what it circles, and
 * `Box3.setFromObject` walks children, so a ring parented to the piece would
 * make the piece measure bigger (app-seat-grid.js tells that story with a
 * 0.1375 mm Seat gate). They sit in the scene and take the piece's world
 * transform every frame, facing the camera.
 *
 * NON-SOLID SCOPE. This file never reads an edge count to decide intent. It
 * reads `report.nonSolid`, which app-defects.js set from `nsoNonSolid(m)`, and
 * on a flagged piece the open-edge row is DECLARED: slate, not red; no Cap
 * button (Cap does not read the flag and would close what the user said to
 * leave open); and it does not stop the green "Nothing wrong found" row.
 * docs/NON-SOLID.md section 3. */
(function () {
  'use strict';

  /* Ring colours are the marks' own (app-defects.js), so a ring reads as the
     same finding as the line inside it. Slate for a declared opening and the
     app's success green for "fixed" are the only two new ones. */
  var RING_COLOR = { open: 0xff2d2d, nonManifold: 0xff8c1a, pierce: 0xff2d2d, thin: 0xc084fc, gap: 0x22d3ee };
  var DECLARED_COLOR = 0x94a3b8;
  var FIXED_COLOR = 0x22c55e;
  var ORDER_RING = 53;    // above the marks' lines (52)
  var ORDER_LABEL = 54;

  var FLY_MS = 450;
  var PULSE_MS = 1200;
  var FIXED_MS = 1600;
  var LABEL_SCALE = 0.032;   // sprite, size-attenuation off: ~3.5% of the view height

  var ACTION_LABEL = { 'btn-cap-open': 'Cap open faces', 'btn-seal': 'Seal', 'btn-solidify': 'Solidify', 'btn-thicken-out': 'Thicken out',
                       patch: 'Patch', cap: 'Cap', bridge: 'Bridge' };
  var ACTION_KINDS = { 'btn-cap-open': ['open'], 'btn-seal': ['open'], 'btn-solidify': ['open'], 'btn-thicken-out': ['thin'],
                       patch: ['open'], cap: ['open'], bridge: ['open', 'gap'] };

  var F = function () { return window.NSO_Findings; };

  /* The check on the card. Null when none is. */
  var cur = null;     // { modelId, name, host, report, problems, items: [...], group }
  var card = { open: false, stale: false, staleName: null, result: null, done: [], working: false };
  var pending = null; // a Cap / Seal / Solidify click between its two listeners
  var flashes = [];   // green "fixed" rings, fading
  var fly = null;     // camera flight in progress
  var ticking = false;

  /* ---- small helpers ---- */

  function $(id) { return document.getElementById(id); }
  function modelById(id) {
    if (typeof state === 'undefined' || !state.models) return null;
    for (var i = 0; i < state.models.length; i++) if (state.models[i].id === id) return state.models[i];
    return null;
  }
  function placedFor(m) {
    if (!m || typeof state === 'undefined' || !state.placed) return null;
    for (var i = 0; i < state.placed.length; i++) {
      var p = state.placed[i];
      if (p && p.sourceId === m.id && p.mesh) return p;
    }
    return null;
  }
  function activeModel() { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  /* Raw Z-up -> the piece's display space, the mapping app-defects.js uses
     for its marks (dispX = rawX + off0, dispY = rawZ + off1, dispZ = -rawY + off2). */
  function toDisplay(c, off) {
    return new THREE.Vector3(c[0] + off[0], c[2] + off[1], -c[1] + off[2]);
  }

  /* A ring sized to the problem, with a floor so a three-edge hole on a big
     piece is still a ring and not a dot. */
  function ringRadius(problem, pieceRadius) {
    return Math.max(problem.radius * 1.3 + 0.4, pieceRadius * 0.04, 0.8);
  }

  /* ---- rings and numbers ---- */

  var ringGeo = null;
  function sharedRingGeo() {
    if (!ringGeo) ringGeo = new THREE.RingGeometry(0.91, 1, 64);
    return ringGeo;
  }
  function ringMesh(color, name) {
    var mat = new THREE.MeshBasicMaterial({
      color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false
    });
    var o = new THREE.Mesh(sharedRingGeo(), mat);
    o.name = name;
    o.renderOrder = ORDER_RING;
    o.raycast = function () {};
    o.frustumCulled = false;
    o.matrixAutoUpdate = false;
    o.userData.nsoDefectMark = true;
    o.userData.skipXray = true;
    return o;
  }
  function labelSprite(text, color) {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g = c.getContext('2d');
    g.beginPath();
    g.arc(32, 32, 29, 0, Math.PI * 2);
    g.fillStyle = '#' + ('000000' + color.toString(16)).slice(-6);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(15,23,42,0.9)';
    g.stroke();
    g.fillStyle = '#ffffff';
    g.font = 'bold ' + (text.length > 2 ? 24 : 32) + 'px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 32, 34);
    var tex = new THREE.CanvasTexture(c);
    var mat = new THREE.SpriteMaterial({
      map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false
    });
    var s = new THREE.Sprite(mat);
    s.name = 'nso-findings-label';
    s.renderOrder = ORDER_LABEL;
    s.raycast = function () {};
    s.frustumCulled = false;
    s.matrixAutoUpdate = false;
    s.userData.nsoDefectMark = true;
    s.userData.skipXray = true;
    return s;
  }

  var _v = null, _q = null, _s = null, _up = null;
  function scratch() {
    if (!_v) { _v = new THREE.Vector3(); _q = new THREE.Quaternion(); _s = new THREE.Vector3(); _up = new THREE.Vector3(); }
  }
  /* The pulse a row click gives its ring: two swells over PULSE_MS. */
  function pulse(it) {
    if (!it.flashUntil) return 1;
    var left = it.flashUntil - now();
    if (left <= 0) { it.flashUntil = 0; return 1; }
    var t = 1 - left / PULSE_MS;
    return 1 + 0.55 * Math.abs(Math.sin(t * Math.PI * 2));
  }
  /* Facing the camera, at the problem's place on the piece as the piece
     stands now. onBeforeRender runs after the scene's world matrices and
     before the renderer reads this one, so writing it here is in time. */
  function placeRing(it) {
    return function (renderer, scene, camera) {
      if (!cur || !cur.host) return;
      scratch();
      _v.copy(it.local).applyMatrix4(cur.host.matrixWorld);
      var k = it.r * cur.host.matrixWorld.getMaxScaleOnAxis() * pulse(it);
      this.matrix.compose(_v, camera.quaternion, _s.set(k, k, k));
      this.matrixWorld.copy(this.matrix);
    };
  }
  function placeLabel(it) {
    return function (renderer, scene, camera) {
      if (!cur || !cur.host) return;
      scratch();
      _v.copy(it.local).applyMatrix4(cur.host.matrixWorld);
      var k = it.r * cur.host.matrixWorld.getMaxScaleOnAxis() * pulse(it);
      _up.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(k);
      _v.add(_up);
      this.matrix.compose(_v, camera.quaternion, _s.set(LABEL_SCALE, LABEL_SCALE, 1));
      this.matrixWorld.copy(this.matrix);
    };
  }

  function disposeObj(o) {
    if (!o) return;
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  }
  function clearRings() {
    if (!cur || !cur.group) return;
    if (cur.group.parent) cur.group.parent.remove(cur.group);
    cur.group.children.forEach(disposeObj);
    cur.group = null;
  }

  function pieceRadius(host) {
    var g = host.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    return g.boundingSphere ? g.boundingSphere.radius : 10;
  }

  function buildItems(problems, off, host, declaredOpen) {
    var items = [];
    var pr = pieceRadius(host);
    var kinds = F().KINDS;
    for (var k = 0; k < kinds.length; k++) {
      var list = problems[kinds[k]] || [];
      for (var i = 0; i < list.length; i++) {
        var pb = list[i];
        items.push({
          kind: kinds[k],
          number: pb.number,
          count: pb.count,
          declared: kinds[k] === 'open' && declaredOpen,
          local: toDisplay(pb.center, off),
          r: ringRadius(pb, pr),
          flashUntil: 0
        });
      }
    }
    return items;
  }
  function worldOf(it, host) {
    return it.local.clone().applyMatrix4(host.matrixWorld);
  }

  function drawRings() {
    if (!cur || typeof state === 'undefined' || !state.scene) return;
    var grp = new THREE.Group();
    grp.name = 'nso-findings-rings';
    grp.userData.nsoDefectMark = true;
    for (var i = 0; i < cur.items.length; i++) {
      var it = cur.items[i];
      var color = it.declared ? DECLARED_COLOR : RING_COLOR[it.kind];
      var ring = ringMesh(color, 'nso-findings-ring-' + it.kind);
      ring.userData.findingKind = it.kind;
      ring.userData.findingNumber = it.number;
      ring.onBeforeRender = placeRing(it);
      var label = labelSprite(String(it.number), color);
      label.userData.findingKind = it.kind;
      label.userData.findingNumber = it.number;
      label.onBeforeRender = placeLabel(it);
      it.ring = ring;
      it.label = label;
      grp.add(ring);
      grp.add(label);
    }
    nsoHelpers.attach(state.scene, grp, 'check');
    cur.group = grp;
  }

  /* ---- green "fixed" flashes ---- */

  function flashFixed(list) {
    if (typeof state === 'undefined' || !state.scene) return;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var ring = ringMesh(FIXED_COLOR, 'nso-findings-fixed');
      var w = f.world.clone(), r = f.r, t0 = now();
      ring.onBeforeRender = (function (w, r) {
        return function (renderer, scene, camera) {
          scratch();
          this.matrix.compose(w, camera.quaternion, _s.set(r, r, r));
          this.matrixWorld.copy(this.matrix);
        };
      })(w, r);
      nsoHelpers.attach(state.scene, ring, 'check-flash');   // a flash: no session, gone on its own
      flashes.push({ ring: ring, t0: t0 });
    }
    kick();
  }

  /* ---- the camera ---- */

  function flyTo(center, radius) {
    if (typeof state === 'undefined' || !state.camera || !state.controls) return;
    var cam = state.camera, ctl = state.controls;
    var fovV = cam.fov * Math.PI / 180;
    var fovH = 2 * Math.atan(Math.tan(fovV / 2) * (cam.aspect || 1));
    var half = Math.min(fovV, fovH) / 2;
    var dist = Math.max(radius / Math.sin(half), (cam.near || 1) * 4);
    var dir = cam.position.clone().sub(ctl.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 1, 1);
    dir.normalize();
    fly = {
      t0: now(),
      fromT: ctl.target.clone(), toT: center.clone(),
      fromP: cam.position.clone(), toP: center.clone().add(dir.multiplyScalar(dist))
    };
    kick();
  }
  function stepFly() {
    if (!fly) return;
    var t = Math.min(1, (now() - fly.t0) / FLY_MS);
    var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    state.controls.target.lerpVectors(fly.fromT, fly.toT, e);
    state.camera.position.lerpVectors(fly.fromP, fly.toP, e);
    state.camera.lookAt(state.controls.target);
    if (t >= 1) fly = null;
  }

  /* One rAF loop, only while something moves. */
  function kick() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(tick);
  }
  function tick() {
    stepFly();
    var t = now();
    for (var i = flashes.length - 1; i >= 0; i--) {
      var f = flashes[i];
      var a = (t - f.t0) / FIXED_MS;
      if (a >= 1) {
        if (f.ring.parent) f.ring.parent.remove(f.ring);
        disposeObj(f.ring);
        flashes.splice(i, 1);
      } else {
        f.ring.material.opacity = 0.95 * (1 - a);
      }
    }
    var pulsing = cur && cur.items && cur.items.some(function (it) { return it.flashUntil > t; });
    if (fly || flashes.length || pulsing) requestAnimationFrame(tick);
    else ticking = false;
  }

  /* Frames the piece and every ring on it. Called by app-defects.js when
     Check is pressed (not on a re-scan after a fix). */
  window.nsoFindingsFrame = function () {
    if (!cur || !cur.host) return false;
    var host = cur.host;
    host.updateMatrixWorld(true);
    var g = host.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    var box = g.boundingBox.clone().applyMatrix4(host.matrixWorld);
    var sc = host.matrixWorld.getMaxScaleOnAxis();
    for (var i = 0; i < cur.items.length; i++) {
      var w = worldOf(cur.items[i], host);
      var r = cur.items[i].r * sc;
      box.expandByPoint(w.clone().addScalar(r));
      box.expandByPoint(w.clone().addScalar(-r));
    }
    var sphere = box.getBoundingSphere(new THREE.Sphere());
    flyTo(sphere.center, sphere.radius * 1.08);
    return true;
  };

  /* A row click: the nearest problem of that kind to the camera. */
  function goTo(kind) {
    if (!cur || !cur.host || typeof state === 'undefined' || !state.camera) return null;
    var cam = state.camera.position, best = null, bd = Infinity;
    for (var i = 0; i < cur.items.length; i++) {
      var it = cur.items[i];
      if (it.kind !== kind) continue;
      var d = worldOf(it, cur.host).distanceTo(cam);
      if (d < bd) { bd = d; best = it; }
    }
    if (!best) return null;
    var sc = cur.host.matrixWorld.getMaxScaleOnAxis();
    flyTo(worldOf(best, cur.host), Math.max(best.r * sc * 3, 6));
    best.flashUntil = now() + PULSE_MS;
    cur.focus = { kind: best.kind, number: best.number };
    kick();
    return best;
  }

  /* An item's number: fly to that problem's ring and pulse it. */
  function goToNumber(kind, number) {
    if (!cur || !cur.host || typeof state === 'undefined' || !state.camera) return null;
    var best = null;
    for (var i = 0; i < cur.items.length; i++) if (cur.items[i].kind === kind && cur.items[i].number === number) best = cur.items[i];
    if (!best) return null;
    var sc = cur.host.matrixWorld.getMaxScaleOnAxis();
    flyTo(worldOf(best, cur.host), Math.max(best.r * sc * 3, 6));
    best.flashUntil = now() + PULSE_MS;
    cur.focus = { kind: best.kind, number: best.number };
    kick();
    return best;
  }

  /* ---- the card ---- */

  /* The items on the card now, in the card's order: [{ row, item }]. */
  function liveItems() {
    var out = [];
    if (!cur || card.stale) return out;
    F().rows(cur.report, cur.problems).forEach(function (row) {
      (row.items || []).forEach(function (it) { out.push({ row: row, item: it }); });
    });
    return out;
  }
  function itemSig(it) {
    if (it.fix === 'sealRepair' || it.fix === 'thickenOut') return it.fix;
    return it.fix + '|' + (it.anchors || []).map(function (a) { return a.map(function (x) { return x.toFixed(3); }).join(','); }).join(';');
  }

  /* The REPAIR button: Seal with Repair, the Finish menu's own control. */
  function runSealRepair() {
    var chk = $('chk-seal-repair'), btn = $('btn-seal');
    if (!btn) return;
    var was = chk ? chk.checked : false;
    if (chk) chk.checked = true;
    try { btn.click(); } finally { if (chk) chk.checked = was; }
  }
  /* THICKEN OUT: the mm the finding needs goes into the Finish box and the
     Finish button is clicked, then the box is put back as it was. */
  function runThicken(mm) {
    var inp = $('inp-thicken-mm'), btn = $('btn-thicken-out');
    if (!btn) return;
    var was = inp ? inp.value : null;
    if (inp) inp.value = String(mm);
    try { btn.click(); } finally { if (inp && was != null) inp.value = was; }
  }

  /* One item's own fix, on that finding only. CAP / PATCH / BRIDGE are
     bracketed here (the document-level watcher only knows the Finish
     buttons): the "before" is taken, nsoRepairRun runs, the "after" is read. */
  function runItem(item) {
    if (item.fix === 'cap' || item.fix === 'patch' || item.fix === 'bridge') {
      begin(item.fix);
      if (pending) pending.item = item;
      var res = null;
      try {
        res = (typeof window.nsoRepairRun === 'function')
          ? window.nsoRepairRun({ fix: item.fix, anchors: item.anchors, faces: item.kind === 'gap' })
          : { ok: false, reason: 'app-patch.js is not loaded' };
      } finally { finish(item.fix); }
      return res;
    }
    if (item.fix === 'sealRepair') {
      var btn = $('btn-seal');
      if (!btn) return null;
      runWatched('btn-seal', item, runSealRepair);
    } else if (item.fix === 'thickenOut') {
      runWatched('btn-thicken-out', item, function () { runThicken(item.mm); });
    }
    return null;
  }
  /* A Finish-menu button clicked by the card: the document listeners see the
     click and do the before / after; the item rides along for the row's line. */
  function runWatched(id, item, fn) {
    itemRiding = item;
    try { fn(); } finally { itemRiding = null; }
  }
  var itemRiding = null;

  function fixAll() {
    if (card.working || !cur || card.stale) return;
    card.working = true;
    card.done = [];
    var tried = {}, ran = 0;
    try {
      for (var guard = 0; guard < 60; guard++) {
        var next = null, all = liveItems();
        for (var i = 0; i < all.length; i++) {
          var it = all[i].item;
          if (all[i].row.advisory || tried[itemSig(it)]) continue;
          next = it; break;
        }
        if (!next) break;
        tried[itemSig(next)] = 1;
        keepDone = true;
        runItem(next);
        ran++;
      }
    } finally { card.working = false; keepDone = false; }
    if (ran) {
      var ok = card.done.filter(function (d) { return d.ok; }).length;
      card.result = card.result || { action: 'Fix all', changed: true, text: '' };
      card.result = { action: 'Fix all', changed: ran > 0, fixed: ok,
                      text: 'Fix all: ' + ok + ' of ' + ran + ' fix' + (ran === 1 ? '' : 'es') + ' cleared what it was for. ' +
                            (cur && cur.report.verdict === 'PASS' ? 'The piece now passes Check.' : 'Check still reads ' + (cur ? cur.report.verdict : '?') + '.') };
    }
    render();
  }
  var keepDone = false;

  function render() {
    var el = $('findings-card');
    if (!el) return;
    el.hidden = !card.open;
    if (!card.open) return;

    var name = cur ? cur.name : card.staleName;
    $('findings-piece').textContent = name || '';

    var stale = $('findings-stale');
    stale.hidden = !card.stale;

    var res = $('findings-result');
    res.hidden = !card.result;
    if (card.result) {
      res.textContent = card.result.text;
      res.classList.toggle('is-nochange', !card.result.changed);
    }

    var items = liveItems().filter(function (x) { return !x.row.advisory; });
    var act = $('findings-actions');
    if (act) {
      act.hidden = !(items.length > 0);
      var fa = $('btn-findings-fixall');
      if (fa) fa.textContent = 'Fix all (' + items.length + ')';
    }

    // what the last fix did, one line each: green when it cleared its finding
    var dn = $('findings-done');
    if (dn) {
      dn.textContent = '';
      (card.done || []).forEach(function (d) {
        var li = document.createElement('li');
        li.className = 'findings-done-row ' + (d.ok ? 'is-fixed' : 'is-notfixed');
        li.setAttribute('data-fix', d.fix || '');
        li.setAttribute('data-ok', d.ok ? '1' : '0');
        li.textContent = (d.ok ? '✓ ' : '✗ ') + d.text + ' — ' + d.line;
        dn.appendChild(li);
      });
      dn.hidden = !(card.done && card.done.length);
    }

    var ul = $('findings-rows');
    ul.textContent = '';
    var note = $('findings-unplaced');
    note.hidden = true;
    if (cur && !card.stale) {
      var rows = F().rows(cur.report, cur.problems);
      rows.forEach(function (row) {
        var li = document.createElement('li');
        li.className = 'findings-row findings-' + row.kind + (row.declared ? ' is-declared' : '') + (row.advisory ? ' is-advisory' : '');
        li.setAttribute('data-kind', row.kind);
        var head;
        if (row.kind === 'clean') {
          head = document.createElement('div');
        } else {
          head = document.createElement('button');
          head.type = 'button';
          head.title = 'Fly the camera to the nearest of these';
          head.addEventListener('click', function () { goTo(row.kind); });
        }
        head.className = 'findings-go';
        var t = document.createElement('strong');
        t.className = 'findings-title';
        t.textContent = row.title;
        var mng = document.createElement('span');
        mng.className = 'findings-meaning';
        mng.textContent = row.meaning;
        head.appendChild(t);
        head.appendChild(mng);
        li.appendChild(head);
        if (row.items && row.items.length) {
          var ol = document.createElement('div');
          ol.className = 'findings-items';
          row.items.forEach(function (item, ii) {
            var line = document.createElement('div');
            line.className = 'findings-item';
            line.setAttribute('data-fix', item.fix);
            var nums = (item.problems || []).map(function (pi) { return row.problems[pi] ? row.problems[pi].number : null; })
              .filter(function (n) { return n != null; });
            if (nums.length) {
              var badge = document.createElement('span');
              badge.className = 'findings-num';
              badge.textContent = nums.join(' + ');
              line.appendChild(badge);
            }
            var txt = document.createElement('span');
            txt.className = 'findings-item-text';
            txt.textContent = item.text + (item.detail ? ' (' + item.detail + ')' : '');
            if (nums.length) {
              txt.classList.add('is-link');
              txt.title = 'Fly the camera to it';
              txt.addEventListener('click', function () { goToNumber(row.kind, nums[0]); });
            }
            line.appendChild(txt);
            var fb = document.createElement('button');
            fb.type = 'button';
            fb.className = 'btn btn-secondary findings-fix';
            fb.setAttribute('data-fix', item.fix);
            fb.setAttribute('data-scope', item.scope || '');
            if (item.mm != null) fb.setAttribute('data-mm', String(item.mm));
            fb.textContent = item.fixLabel + (item.fix === 'thickenOut' ? ' +' + item.mm.toFixed(2) + ' mm' : '');
            fb.title = item.scope === 'whole piece'
              ? 'Runs on the whole piece: this fix has no way to touch one finding only.'
              : 'Runs on this finding only. One Undo.';
            fb.addEventListener('click', function () { runItem(item); });
            line.appendChild(fb);
            ol.appendChild(line);
          });
          li.appendChild(ol);
        } else if (row.handledBy) {
          var hb = document.createElement('p');
          hb.className = 'findings-handled';
          hb.textContent = row.handledBy;
          li.appendChild(hb);
        }
        ul.appendChild(li);
      });
      var un = F().unplaced(cur.report);
      if (un.length) {
        note.hidden = false;
        note.textContent = 'Also counted, with no place to point at: ' + un.join(', ') + '.';
      }
    }
    layout();
  }

  /* Docked at the right edge, its top just under what holds the top-right
     corner - since shell v3 the pinned Plate & pieces panel (and the Clear
     plate / Optimize slabs beside it, whichever reaches lower). If an open
     drop-down's panel would cover the card, the card moves to its left
     rather than under it. Measured, not assumed: every panel opens at the
     shared spot on the left, so this finds no overlap today. */
  function layout() {
    var el = $('findings-card');
    if (!el || el.hidden) return;
    var host = el.offsetParent || el.parentElement;
    if (!host) return;
    var hr = host.getBoundingClientRect();
    var gap = 8;
    var top = gap + 36;
    ['plate-panel', 'btn-optimize'].forEach(function (id) {
      var anchor = $(id);
      if (!anchor) return;
      var sr = anchor.getBoundingClientRect();
      if (sr.height > 0) top = Math.max(top, Math.round(sr.bottom - hr.top + gap));
    });
    var right = gap;
    var open = document.querySelector('.vp-shell-menu[open] > .vp-menu-body');
    if (open) {
      var br = open.getBoundingClientRect();
      var w = el.offsetWidth || 300;
      if (br && br.width > 0) {
        var cardLeft = hr.right - right - w, cardRight = hr.right - right;
        if (br.left < cardRight && br.right > cardLeft && br.bottom > hr.top + top) {
          right = Math.round(hr.right - br.left + gap);
        }
      }
    }
    el.style.top = top + 'px';
    el.style.right = right + 'px';
    el.style.maxHeight = Math.max(160, Math.round(hr.height - top - 96)) + 'px';
  }

  /* ---- the hooks app-defects.js calls ---- */

  window.nsoFindingsOnShow = function (info) {
    if (!F() || typeof THREE === 'undefined') return;
    clearRings();
    var problems = F().group(info.report);
    cur = {
      modelId: info.model.id,
      name: info.model.name,
      host: info.host,
      report: info.report,
      off: info.off,
      problems: problems,
      items: buildItems(problems, info.off, info.host, !!info.report.nonSolid),
      group: null,
      focus: null
    };
    drawRings();
    card.open = true;
    card.stale = false;
    card.staleName = null;
    if (!pending && !card.working) card.done = [];       // a fresh Check starts a fresh card
    render();
  };

  window.nsoFindingsOnClear = function (why) {
    var name = cur ? cur.name : null;
    clearRings();
    cur = null;
    if (why === 'hide') {
      card.open = false;
      card.stale = false;
      card.result = null;
      card.done = [];
    } else if (why === 'stale') {
      if (!card.working) card.done = [];
      card.stale = true;
      card.staleName = name;
    }
    render();
  };

  /* ---- always re-scan: Cap, Seal, Solidify ---- */

  function actionButton(ev) {
    var t = ev.target;
    if (!t || !t.closest) return null;
    return t.closest('#btn-cap-open, #btn-seal, #btn-solidify, #btn-thicken-out');
  }
  function worldProblems(items, host) {
    host.updateMatrixWorld(true);
    var sc = host.matrixWorld.getMaxScaleOnAxis();
    return items.map(function (it) {
      return { kind: it.kind, declared: it.declared, world: worldOf(it, host), r: it.r * sc };
    });
  }

  /* Before the button's own handler: what the piece reads now. The card's
     current check when it is this piece's and still current, otherwise a
     scan - the battery, nothing drawn. */
  function begin(id) {
    pending = null;
    var m = activeModel();
    var p = placedFor(m);
    if (!m || !p) return;
    var repair = id === 'btn-seal' && !!($('chk-seal-repair') && $('chk-seal-repair').checked);
    var before = null, beforeWorld = [], scan = null;
    if (cur && cur.modelId === m.id && cur.host === p.mesh && !card.stale) {
      before = cur.report;
      beforeWorld = worldProblems(cur.items, cur.host);
    } else if (typeof window.nsoDefectsScan === 'function') {
      scan = window.nsoDefectsScan();
      if (scan) {
        before = scan.report;
        var probs = F().group(scan.report);
        beforeWorld = worldProblems(buildItems(probs, scan.off, scan.host, !!scan.report.nonSolid), scan.host);
      }
    }
    pending = {
      id: id,
      item: itemRiding,
      label: repair ? 'Seal with Repair' : ACTION_LABEL[id],
      kinds: repair ? ['open', 'nonManifold'] : ACTION_KINDS[id],
      modelId: m.id, host: p.mesh, rawRef: m.rawTris, geoRef: m.geometry,
      before: before, beforeWorld: beforeWorld, scan: scan
    };
  }

  /* After it: did the piece change, and what does it read now. */
  function finish(id) {
    var pd = pending;
    pending = null;
    if (!pd || pd.id !== id) return;
    var m = modelById(pd.modelId);
    var p = placedFor(m);
    var statusEl = $('status');
    var said = statusEl ? statusEl.textContent : '';
    var changed = !p || p.mesh !== pd.host || m.rawTris !== pd.rawRef || m.geometry !== pd.geoRef;

    function note(ok, line) {
      var it = pd.item;
      if (!keepDone) card.done = [];
      card.done.push({ ok: ok, fix: it ? it.fix : id, text: it ? (it.text + ' \u2014 ' + (it.fixLabel || pd.label)) : pd.label, line: line });
    }

    if (!changed) {
      // Show the check the "before" was taken from, if the card was not
      // already showing it, so the card is never a result with no rows.
      if (!(cur && cur.modelId === pd.modelId && !card.stale) && pd.scan) {
        window.nsoDefectsShow({ quiet: true, scan: pd.scan });
      }
      card.open = true;
      card.result = {
        action: pd.label, changed: false,
        text: pd.label + ' changed nothing on the piece.' + (said ? ' It said: ' + said : '')
      };
      note(false, 'changed nothing' + (said ? ': ' + said : ''));
      render();
      return;
    }

    if (typeof window.nsoDefectsRefresh === 'function') window.nsoDefectsRefresh();
    var am = activeModel();
    var after = (am && am.id === pd.modelId) ? window.nsoDefectsShow({ quiet: true }) : null;
    card.open = true;
    if (!after || !pd.before) {
      card.result = { action: pd.label, changed: true, text: pd.label + ' changed the piece. ' + (after ? '' : 'Check again to see it.') };
      note(true, 'changed the piece');
      render();
      return;
    }

    /* The kinds the action is for, where there was or is any of it, then
       every other kind whose count moved - a fix that opens new holes or
       adds piercing pairs says so. Never an empty line: an action with
       nothing of its kind before or after still names its first one. */
    var Fx = F();
    var kinds = pd.kinds.filter(function (k) {
      return Fx.countOf(pd.before, k) || Fx.countOf(after, k);
    });
    Fx.KINDS.forEach(function (k) {
      if (kinds.indexOf(k) < 0 && Fx.countOf(pd.before, k) !== Fx.countOf(after, k)) kinds.push(k);
    });
    if (!kinds.length) kinds.push(pd.kinds[0]);
    var lines = kinds.map(function (k) { return Fx.beforeNow(pd.before, after, k); });
    var anyMoved = Fx.KINDS.some(function (k) { return Fx.countOf(pd.before, k) !== Fx.countOf(after, k); });

    // Fixed: a problem from before with nothing of its kind near it now.
    var afterWorld = cur ? worldProblems(cur.items, cur.host) : [];
    var fixed = pd.beforeWorld.filter(function (b) {
      if (b.declared) return false;
      for (var i = 0; i < afterWorld.length; i++) {
        var a = afterWorld[i];
        if (a.kind === b.kind && a.world.distanceTo(b.world) <= Math.max(a.r, b.r)) return false;
      }
      return true;
    });
    flashFixed(fixed);

    card.result = {
      action: pd.label, changed: true, fixed: fixed.length,
      text: pd.label + (anyMoved ? ': ' : ' changed the piece, but none of these counts: ') + lines.join(' ')
    };
    // The item's own line: green when the count of what it was for went down.
    var mine = (pd.item && pd.item.kind) || pd.kinds[0];
    var cleared = Fx.countOf(after, mine) < Fx.countOf(pd.before, mine);
    var worse = Fx.KINDS.filter(function (k) { return k !== mine && Fx.countOf(after, k) > Fx.countOf(pd.before, k); });
    note(cleared, Fx.beforeNow(pd.before, after, mine) +
         (cleared ? '' : ' Not cleared - ' + (said || 'the check still sees it') + '.') +
         (worse.length ? ' Also: ' + worse.map(function (k) { return Fx.beforeNow(pd.before, after, k); }).join(' ') : ''));
    render();
  }

  /* ---- staleness while the card is up ---- */

  /* Seal and Solidify swap the mesh without rebuilding the model list, so
     app-defects.js's own refresh does not always run after them; Undo and
     most bakes do. A cheap look twice a second while a check is on the card
     closes that gap: the moment the piece is not the one the marks were
     drawn on, the shared stale rule runs and the card says so. */
  setInterval(function () {
    if (!cur || pending) return;
    var m = modelById(cur.modelId);
    var p = placedFor(m);
    if (!p || p.mesh !== cur.host) {
      if (typeof window.nsoDefectsRefresh === 'function') window.nsoDefectsRefresh();
    }
  }, 500);

  /* ---- reading it back (tests, Watch) ---- */

  window.nsoFindingsState = function () {
    var rows = [];
    document.querySelectorAll('#findings-rows .findings-row').forEach(function (li) {
      var fb = li.querySelector('.findings-fix');
      var hb = li.querySelector('.findings-handled');
      var its = [];
      li.querySelectorAll('.findings-item').forEach(function (ln) {
        var b = ln.querySelector('.findings-fix');
        its.push({
          fix: b ? b.getAttribute('data-fix') : null,
          fixLabel: b ? b.textContent : null,
          scope: b ? b.getAttribute('data-scope') : null,
          mm: b && b.getAttribute('data-mm') != null ? +b.getAttribute('data-mm') : null,
          text: (ln.querySelector('.findings-item-text') || {}).textContent || '',
          numbers: ((ln.querySelector('.findings-num') || {}).textContent || '').split(' + ').filter(Boolean).map(Number)
        });
      });
      rows.push({
        kind: li.getAttribute('data-kind'),
        declared: li.classList.contains('is-declared'),
        advisory: li.classList.contains('is-advisory'),
        title: (li.querySelector('.findings-title') || {}).textContent || '',
        meaning: (li.querySelector('.findings-meaning') || {}).textContent || '',
        fix: fb ? fb.getAttribute('data-fix') : null,
        fixLabel: fb ? fb.textContent : null,
        items: its,
        handledBy: hb ? hb.textContent : null
      });
    });
    var host = cur && cur.host;
    return {
      open: card.open,
      stale: card.stale,
      modelId: cur ? cur.modelId : null,
      result: card.result ? { action: card.result.action, changed: card.result.changed,
                              fixed: card.result.fixed || 0, text: card.result.text } : null,
      rows: rows,
      done: (card.done || []).map(function (d) { return { ok: d.ok, fix: d.fix, text: d.text, line: d.line }; }),
      fixAll: (function () { var b = $('btn-findings-fixall'); var a = $('findings-actions'); return a && !a.hidden && b ? b.textContent : null; })(),
      unplaced: $('findings-unplaced') && !$('findings-unplaced').hidden ? $('findings-unplaced').textContent : null,
      problems: cur ? cur.items.map(function (it) {
        var w = worldOf(it, host);
        return { kind: it.kind, number: it.number, count: it.count, declared: it.declared,
                 world: [w.x, w.y, w.z], r: it.r, pulsing: it.flashUntil > now() };
      }) : [],
      focus: cur ? cur.focus : null,
      flying: !!fly,
      fixedFlashes: flashes.length
    };
  };
  window.nsoFindingsGoTo = goTo;
  window.nsoFindingsFixAll = fixAll;
  window.nsoFindingsRunItem = function (kind, index) {
    var all = liveItems().filter(function (x) { return x.row.kind === kind; });
    return all[index || 0] ? runItem(all[index || 0].item) : null;
  };
  /* app-patch.js's Add > Patch click: the same fix, bracketed by the card's
     re-scan when it is up on this piece. */
  window.nsoFindingsRunTool = function (spec) {
    var m = activeModel();
    if (card.open && cur && m && cur.modelId === m.id && !card.stale && typeof window.nsoRepairRun === 'function') {
      begin(spec.fix);
      var res;
      try { res = window.nsoRepairRun(spec); } finally { finish(spec.fix); }
      return res;
    }
    return typeof window.nsoRepairRun === 'function' ? window.nsoRepairRun(spec) : null;
  };

  /* ---- wiring ---- */

  function bind() {
    var close = $('btn-findings-close');
    if (close && !close._findingsBound) {
      close.addEventListener('click', function () {
        if (cur && typeof window.nsoDefectsHide === 'function') {
          window.nsoDefectsHide();
          if (typeof setStatus === 'function') setStatus('Check cleared');
        }
        card.open = false;
        card.stale = false;
        card.result = null;
        render();
      });
      close._findingsBound = true;
    }
    var fixall = $('btn-findings-fixall');
    if (fixall && !fixall._findingsBound) {
      fixall.addEventListener('click', function () { fixAll(); });
      fixall._findingsBound = true;
    }
    var again = $('btn-findings-recheck');
    if (again && !again._findingsBound) {
      again.addEventListener('click', function () {
        var b = $('btn-check-defects');
        if (b) b.click();
      });
      again._findingsBound = true;
    }
    var bar = document.querySelector('.viewport-overlay-topbar');
    if (bar && !bar._findingsBound) {
      bar.addEventListener('toggle', layout, true);
      bar._findingsBound = true;
    }
  }
  if (!document._findingsActionsBound) {
    document._findingsActionsBound = true;
    document.addEventListener('click', function (ev) {
      var b = actionButton(ev);
      if (b) begin(b.id);
    }, true);
    document.addEventListener('click', function (ev) {
      var b = actionButton(ev);
      if (b) finish(b.id);
    }, false);
    window.addEventListener('resize', layout);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
