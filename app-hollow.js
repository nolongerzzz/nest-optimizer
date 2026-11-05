/* ============================================================
   Hollow / Fill - the app layer over nso_hollow.js.

   Thin on purpose, the way app-carve.js is thin: all the geometry lives in
   nso_hollow.js, which is THREE-free and node-tested, and all the floor lives
   in nso_thickness.js. What is here is the three things that can only be done
   in the app - read the controls, take the piece's raw soup, and commit the
   result the way every other geometry op commits.

   THREE BUTTONS, and the third is not a convenience.

     Hollow              carve the interior out to the wall in the box.
     Fill / Densify      the inverse: fill the cavity solid again.
     Hollow to safe min  hollow out to the SAFEST wall, not to a number.

   The third exists for the thicken -> edit -> hollow back out workflow. Thicken
   in was used to put enough wall under a feature for a cut to bite into; the
   cut is done; the wall should come back down. Back down TO WHAT is the whole
   question, and "to whatever it was before" is the wrong answer whenever the
   piece was not printable before - which is exactly why somebody reached for
   Thicken in the first place. So this stops at the canonical floor even when
   the wall used to be thinner than it. nso_hollow.js safeMinWall() is where
   that rule lives and this button is one call to it.

   THE SLIDER IS A PREVIEW, NOT A FOURTH BUTTON. Beside the wall box sits a
   slider (app-live-slider.js) that writes the same number. While it moves, the
   piece turns to a ghost and the cavity Hollow would cut shows inside it, drawn
   from a coarser, unverified pass of the same nso_hollow.js (a pitch of 1.5
   samples to the wall, not 3, no re-measure): cheap enough to follow a drag, and
   labelled as a preview in its readout. It is a helper like Foam's ghost - one
   owner, torn down on leave-tool, Clear, Undo, a different piece, the section
   closing, and the moment Hollow itself runs. Nothing is cut until a button is
   pressed, and the buttons are unchanged.

   PAINT SCOPE: WHOLE-PIECE. Both operations rebuild the piece's interior
   surfaces, and there is no painted sub-region that can be promised untouched -
   a cavity is defined by the whole outer surface, not by the faces under the
   brush. Any painted face stands the operation down, the same test and the
   same wording Thicken and Smooth use. See the scoping rule in docs/HANDOFF.md.
   ============================================================ */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function round3(x) { return (x === null || x === undefined) ? '?' : Math.round(x * 1000) / 1000; }

  function ready() {
    if (typeof NSO_Hollow === 'undefined' || !NSO_Hollow) {
      say('Hollow needs nso_hollow.js', true);
      return false;
    }
    if (typeof NSO_Thickness === 'undefined' || !NSO_Thickness) {
      say('Hollow needs nso_thickness.js - the floor comes from there, never from a literal', true);
      return false;
    }
    return true;
  }

  /* The piece's raw soup, the same way Thicken reads it. A piece that has no
     raw soup has only a display geometry, which is centred and rotated; the
     cavity would be built in the wrong frame, so it is refused by name. */
  function soupOf(m) {
    if (m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9) return m.rawTris;
    return null;
  }

  function standDown(m, what) {
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (!painted) return null;
    return what + ' stood down - ' + painted + ' painted face(s); a cavity is defined by the ' +
      'whole outer surface, so no face can be promised untouched. Clear paint to ' +
      what.toLowerCase() + '.';
  }

  function nozzleOpts() {
    /* One place to widen this if a nozzle control ever lands. Until then the
       module's own default is the answer, and it is nso_thickness.js's. */
    return {};
  }

  function run(kind) {
    if (liveHandle) liveHandle.cancel();
    closePreview();
    if (!ready()) return null;
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!m) { say('Select a piece first', true); return null; }

    var label = (kind === 'fill') ? 'Fill' : 'Hollow';
    var stand = standDown(m, label);
    if (stand) { say(stand, true); return null; }

    var soup = soupOf(m);
    if (!soup) {
      say(label + ' needs a raw piece - split, wrap or boolean it first', true);
      return null;
    }

    var res;
    try {
      if (kind === 'fill') {
        res = NSO_Hollow.fill(soup, nozzleOpts());
      } else if (kind === 'safe-min') {
        /* The wall the piece has NOW is what a plain Hollow would restore, and
           it is exactly the number this mode must not blindly take. It is
           passed as `restore` so safeMinWall() can floor it, and the status
           line says which of the two won. */
        var o = nozzleOpts();
        o.mode = 'safe-min';
        o.restore = currentWall(soup);
        res = NSO_Hollow.hollow(soup, o);
      } else {
        var mm = parseFloat(($('inp-hollow-mm') || {}).value);
        var o2 = nozzleOpts();
        o2.wall = mm;
        res = NSO_Hollow.hollow(soup, o2);
      }
    } catch (e) {
      say(label + ' failed - ' + ((e && e.message) || e) + '; piece unchanged', true);
      return null;
    }

    if (!res || !res.ok) {
      say(label + ' refused - ' + ((res && res.reason) || 'piece unchanged'), true);
      return res || null;
    }

    /* Commit exactly as Soften / Smooth / Thicken / Carve commit: one raw soup
       through the shared helper, which pushes the undo entry, swaps the
       geometry, rebuilds the mesh and repaints the mask. */
    var type = (kind === 'fill') ? 'fillReplace' : 'hollowReplace';
    if (typeof NSO_sculptCommitRaw !== 'function') {
      say(label + ': could not commit the result', true);
      return res;
    }
    if (!NSO_sculptCommitRaw(m, res.soup, type, res.reason)) {
      say(label + ': could not commit the result', true);
      return res;
    }
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return res;
  }

  /* What wall this piece already has, measured rather than remembered.

     There is no stored "what it was before Thicken" anywhere in this app - the
     undo stack holds geometry, not a wall figure - so the pre-Thicken wall has
     to come off the piece itself. The canonical checker's thinnest MEASURED
     wall is that number, and null when the piece is solid (nothing behind any
     face), which safeMinWall() reads as "no restore target, use the floor". */
  function currentWall(soup) {
    try {
      var rep = NSO_Thickness.measureMesh(soup, {});
      return (rep && typeof rep.min_mm === 'number') ? rep.min_mm : undefined;
    } catch (e) { return undefined; }
  }

  /* ---------------------------------------------------------------
     The live preview: a ghost piece with the cavity inside it
     --------------------------------------------------------------- */

  /* A coarser, unverified pass: 1.5 samples to the wall where Hollow takes 3, and
     no measure-and-retry. On the fixtures that is 25-700 ms where the full pass
     is 0.4-4 s, which a drag can follow. The cavity it draws is the same shape to
     within a sample; the wall Hollow then leaves is the full pass's, measured. */
  var PREVIEW_OPTS = { stepsPerWall: 1.5, verify: false };
  var GHOST_OPACITY = 0.2;
  var live = null;                 // { model, mesh, group, cavity, saved, raf }

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : (state.previewMesh || null);
  }

  /* Raw soup -> the piece mesh's own frame, as Foam draws its hollows. */
  function localGeo(model, raw) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(model) : null;
    var n = raw.length / 3, pos = new Float32Array(raw.length);
    for (var i = 0; i < n; i++) {
      var p = [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
      var q = f ? nsoLocalPointFromRaw(f, p) : p;
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }

  function ghostOn(mesh) {
    var mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    var saved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
      return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite,
               depthTest: mt.depthTest, wireframe: mt.wireframe };
    }) };
    mesh.userData.skipXray = true;
    mats.forEach(function (mt) {
      mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true;
      mt.wireframe = false; mt.needsUpdate = true;
    });
    return saved;
  }

  function ghostOff(mesh, saved) {
    saved.mats.forEach(function (s) {
      s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite;
      s.mt.depthTest = s.depthTest; s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
    });
    if (mesh) mesh.userData.skipXray = saved.skip;
  }

  function closePreview() {
    if (!live) return false;
    var L = live;
    live = null;
    if (L.raf) cancelAnimationFrame(L.raf);
    if (L.cavity) {
      if (L.cavity.parent) L.cavity.parent.remove(L.cavity);
      if (L.cavity.geometry) L.cavity.geometry.dispose();
      if (L.cavity.material) L.cavity.material.dispose();
    }
    if (L.group && L.group.parent) L.group.parent.remove(L.group);
    ghostOff(L.mesh, L.saved);
    return true;
  }

  /* While a preview shows, the piece it is on must stay the selected one. */
  function watchPreview() {
    if (!live) return;
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!m || m !== live.model || meshOf(m) !== live.mesh || m.rawTris !== live.soup) { closePreview(); return; }
    live.raf = requestAnimationFrame(watchPreview);
  }

  function drawPreview(m, mesh, soup, res) {
    var cavSoup = res.soup.subarray(soup.length);
    var keep = (live && live.model === m && live.mesh === mesh) ? live : null;
    if (!keep) {
      closePreview();
      var group = new THREE.Group();
      group.userData.skipXray = true;
      group.userData.nsoHollowPreview = true;
      nsoHelpers.attach(mesh, group, 'hollow-live');
      live = { model: m, mesh: mesh, soup: soup, group: group, cavity: null, saved: ghostOn(mesh), raf: 0 };
      live.raf = requestAnimationFrame(watchPreview);
    }
    if (live.cavity) {
      live.group.remove(live.cavity);
      live.cavity.geometry.dispose();
      live.cavity.material.dispose();
    }
    var o = new THREE.Mesh(localGeo(m, cavSoup), new THREE.MeshBasicMaterial({
      color: 0x22d3ee, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    o.renderOrder = 41;
    o.userData.skipXray = true;
    live.group.add(o);
    live.cavity = o;
  }

  function tell(msg, bad) {
    var el = $('hollow-readout');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('carve-bad', !!bad);
  }

  /* One preview, for a wall in mm. A piece Hollow would refuse is refused here in
     the same words, in the readout rather than the status line: a drag is not a
     request, and must not fill the status with a refusal a frame. */
  function previewWall(mm) {
    if (typeof NSO_Hollow === 'undefined' || !NSO_Hollow || typeof THREE === 'undefined') return null;
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!m) { closePreview(); tell('Select a piece to see the cavity.'); return null; }
    var stand = standDown(m, 'Hollow');
    if (stand) { closePreview(); tell(stand, true); return null; }
    var soup = soupOf(m);
    if (!soup) { closePreview(); tell('Hollow needs a raw piece - split, wrap or boolean it first', true); return null; }
    var mesh = meshOf(m);
    if (!mesh) { closePreview(); tell('Put the piece on the plate to see the cavity.'); return null; }
    var o = { wall: mm };
    for (var k in PREVIEW_OPTS) o[k] = PREVIEW_OPTS[k];
    var res;
    try { res = NSO_Hollow.hollow(soup, Object.assign(nozzleOpts(), o)); }
    catch (e) { closePreview(); tell('Preview failed - ' + ((e && e.message) || e), true); return null; }
    if (!res || !res.ok) { closePreview(); tell((res && res.reason) || 'Nothing to show at this wall.', true); return res || null; }
    drawPreview(m, mesh, soup, res);
    tell('Preview: ' + round3(mm) + ' mm wall, ' + Math.round(res.cavity_volume) +
         ' mm³ of interior removed. Hollow runs the full pass.');
    return res;
  }

  var liveHandle = null;
  function wireLive() {
    if (liveHandle || !window.nsoLiveSlider) return;
    liveHandle = window.nsoLiveSlider.bind({
      slider: 'inp-hollow-slider', box: 'inp-hollow-mm', read: 'hollow-slider-read', unit: ' mm',
      onLive: previewWall
    });
    /* Closing the Subtract card puts the preview away; opening it draws
       nothing until the wall is touched. */
    var d = $('menu-bit');
    if (d && !d.dataset.nsoLiveSec) {
      d.dataset.nsoLiveSec = '1';
      d.addEventListener('toggle', function () {
        if (!d.open) { if (liveHandle) liveHandle.cancel(); closePreview(); }
      });
    }
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('hollow-live', {
    live: function () { return !!live; },
    close: function () { if (liveHandle) liveHandle.cancel(); closePreview(); },
    clear: function () { closePreview(); },
    refresh: function () { var was = !!live; closePreview(); if (was && liveHandle) liveHandle.fire(); }
  });

  /* data-nso-wired is the repo's own marker that a listener is attached, set
     the same way app-sculpt.js and app-wheel.js set it: the drive checks read
     it instead of guessing from a click that might have been swallowed. Bound
     once, so a second wire() call cannot double-fire the handler. */
  function bind(id, kind) {
    var b = $(id);
    if (!b || b.dataset.nsoWired === '1') return;
    b.dataset.nsoWired = '1';
    b.addEventListener('click', function () { run(kind); });
  }
  function wire() {
    bind('btn-hollow', 'hollow');
    bind('btn-hollow-safe', 'safe-min');
    bind('btn-fill', 'fill');
    wireLive();
  }

  /* Exposed for the drive checks, which run the same path the buttons run
     rather than a parallel copy of it. */
  window.nsoHollowRun = run;
  window.nsoHollowPreview = {
    wall: previewWall,
    close: closePreview,
    on: function () { return !!live; },
    objects: function () { return live ? { group: live.group, cavity: live.cavity, mesh: live.mesh } : null; }
  };
  window.nsoHollowCurrentWall = currentWall;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
