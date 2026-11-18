/* ============================================================
   Foam - the app layer over nso_foam.js.

   Spray foam into a hollow, see it fill, bond it solid. Fill / Densify fills
   every enclosed cavity at once and shows nothing; Foam is its visible,
   partial counterpart: one hollow, filled from the bottom up to a level the
   person chooses, previewed in orange inside a ghost of the piece, and only
   turned into mesh on Set. All the geometry is nso_foam.js's (THREE-free,
   node-tested in tools/nso_foam_test.js); what is here is the panel, the
   view, the spray, and the commit.

   WHILE FOAM IS ON
     - the piece is a ghost: translucent, depth-write off - X-ray's treatment
       without the wireframe - so the hollows inside it can be seen
     - each hollow is a dark void; the chosen one darker
     - the foam is the chosen hollow's volume below the level, orange and
       bubbly, with a thin bright ring where its surface meets the wall
     - the readout says "Foam: 42% of the hollow, 7,396 mm³"
   Nothing on the piece changes until Set. Cancel (or the Foam button again)
   puts the view back and leaves the piece exactly as it was.

   THE CONTROLS
     Hollows found   one row per hollow, with its volume; a click on a row, or
                     on the hollow in the ghost view, chooses it. One hollow
                     is chosen for you.
     hold to spray   hold the mouse button anywhere over the piece: the level
                     rises at a steady speed that fills the chosen hollow in
                     SPRAY_SECONDS; letting go pauses it.
     Level           the same level as a slider, so it can be set directly
                     and lowered again before Set.
     Fill it all     the level to the top.
     Set             commits through NSO_sculptCommitRaw - one undo entry, so
                     one Undo puts the piece back bit for bit - with a short
                     orange flash, and the piece returns to normal.

   "UP" is the plate's vertical as the piece lies: world +Y taken into the
   piece's own frame through its mesh's pose, then into its raw axes by
   app-mask.js's raw <-> local mapping (nsoRawDirFromLocal), the one copy of
   it. Unposed, that is raw +Z.

   PAINT SCOPE: SUB-REGION (docs/HANDOFF.md, "Scoping"). Foam changes only the
   faces of the hollow it fills that the level reaches. Those faces are checked
   against nsoMaskFaceList(m), the skip list as the clicks recorded it - read,
   never re-derived - and a painted one among them stands Foam down, named.
   Paint anywhere else on the piece does not. A painted recessed patch has no
   axis and side for that list to carry (it returns null), so Foam stands down
   and says so rather than guess.

   NON-SOLID: a piece flagged non-solid (nsoNonSolid) is refused in words -
   it declares it has no closed inside, so there is nothing for foam to fill.

   FOAM has two modes side by side: BOX (the default - FOAM puts Crop's Box on
   the selected piece, app-crop-card.js lends it, handles and all, and a press
   that aims at the piece through the box sprays foamBox's foam into it) and
   HOLLOW (the sealed-hollow Foam above). Each panel carries a button for the
   other.

   THE GUN (docs/FOAM-GUN.md) is the last part of this file: no box - point
   into a gap and hold, and nso_foam_gun.js fills that gap from the plate to
   the face.
   ============================================================ */
(function () {
  'use strict';

  var SPRAY_SECONDS = 3;          // any hollow fills in about this long
  var GUN_SECONDS = 3;            // the gun's amount runs 0 to 100 in this long, held
  var GHOST_OPACITY = 0.2;
  var FLASH_MS = 450;

  var on = false;
  var m = null, soupRef = null, mesh = null, A = null;
  var chosen = null;              // hollow id
  var heights = {};               // id -> mm above that hollow's floor
  var group = null, voids = [], foamObj = null, ringObj = null;
  var ghostSaved = null;
  var last = null;                // the last preview
  var spraying = false, sprayT = 0, raf = 0, dirty = false;
  var bubbleTex = null;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function FM() { return (typeof NSO_Foam !== 'undefined') ? NSO_Foam : null; }

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : (state.previewMesh || null);
  }

  /* The plate's vertical, in the piece's raw axes, as it lies. */
  function upRaw(ms) {
    ms.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(ms.matrixWorld).invert();
    var v = new THREE.Vector3(0, 1, 0).transformDirection(inv);
    var r = (typeof nsoRawDirFromLocal === 'function') ? nsoRawDirFromLocal([v.x, v.y, v.z]) : [v.x, -v.z, v.y];
    for (var k = 0; k < 3; k++) if (Math.abs(Math.abs(r[k]) - 1) < 1e-6) { var o = [0, 0, 0]; o[k] = r[k] > 0 ? 1 : -1; return o; }
    return r;
  }

  /* ---------------------------------------------------------------
     Drawing: raw soup -> the piece mesh's own frame
     --------------------------------------------------------------- */

  function localGeo(raw, uv, model) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(model || m) : null;
    var n = raw.length / 3, pos = new Float32Array(raw.length);
    for (var i = 0; i < n; i++) {
      var p = [raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]];
      var q = f ? nsoLocalPointFromRaw(f, p) : p;
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (uv) g.setAttribute('uv', new THREE.BufferAttribute(boxUV(pos), 2));
    return g;
  }

  /* Box-mapped UVs, one projection per triangle along its dominant normal,
     so the bubble texture lies on every side of the foam at one scale. */
  function boxUV(pos) {
    var uv = new Float32Array(pos.length / 3 * 2), S = 1 / 7;
    for (var t = 0; t < pos.length; t += 9) {
      var ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
      var vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
      var nx = Math.abs(uy * vz - uz * vy), ny = Math.abs(uz * vx - ux * vz), nz = Math.abs(ux * vy - uy * vx);
      var a = nx >= ny && nx >= nz ? [1, 2] : (ny >= nz ? [0, 2] : [0, 1]);
      for (var c = 0; c < 3; c++) {
        uv[(t / 3 + c) * 2] = pos[t + c * 3 + a[0]] * S;
        uv[(t / 3 + c) * 2 + 1] = pos[t + c * 3 + a[1]] * S;
      }
    }
    return uv;
  }

  /* A tile of foam: orange, packed with small bubbles of every size. Drawn
     once on a canvas and used as both the colour and the bump, so the
     surface catches the light where the bubbles are. */
  function bubbles() {
    if (bubbleTex) return bubbleTex;
    var cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    var g = cv.getContext('2d');
    g.fillStyle = '#f08a24';
    g.fillRect(0, 0, 128, 128);
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < 90; i++) {
      var x = rnd() * 128, y = rnd() * 128, r = 2 + rnd() * rnd() * 11;
      for (var dx = -128; dx <= 128; dx += 128) {
        for (var dy = -128; dy <= 128; dy += 128) {
          var gr = g.createRadialGradient(x + dx - r * 0.3, y + dy - r * 0.3, r * 0.1, x + dx, y + dy, r);
          gr.addColorStop(0, 'rgba(255,214,150,0.95)');
          gr.addColorStop(0.7, 'rgba(250,150,50,0.6)');
          gr.addColorStop(1, 'rgba(150,60,0,0.55)');
          g.fillStyle = gr;
          g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI * 2); g.fill();
        }
      }
    }
    bubbleTex = new THREE.CanvasTexture(cv);
    bubbleTex.wrapS = bubbleTex.wrapT = THREE.RepeatWrapping;
    return bubbleTex;
  }

  function foamMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xffa040, emissive: 0x7a2e00, emissiveIntensity: 0.55, roughness: 0.9, metalness: 0,
      map: bubbles(), bumpMap: bubbles(), bumpScale: 0.8, transparent: true, opacity: 0.84 });
  }

  function disposeObj(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }

  /* The piece as a ghost, and back. Foam ghosts the piece it holds; the gun
     names the piece it sprays. */
  function ghost(onOff, target) {
    var gm = onOff ? (target || mesh) : (ghostSaved && ghostSaved.mesh);
    var mats = gm ? (Array.isArray(gm.material) ? gm.material : [gm.material]) : [];
    if (onOff) {
      ghostSaved = { mesh: gm, skip: !!gm.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite,
                 depthTest: mt.depthTest, wireframe: mt.wireframe };
      }) };
      gm.userData.skipXray = true;
      mats.forEach(function (mt) {
        mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true;
        mt.wireframe = false; mt.needsUpdate = true;
      });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) {
        s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite;
        s.mt.depthTest = s.depthTest; s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
      });
      if (gm) gm.userData.skipXray = ghostSaved.skip;
      ghostSaved = null;
    }
  }

  function buildVoids() {
    voids = A.cavities.map(function (cv) {
      var raw = new Float32Array(cv.faces.length * 9);
      for (var q = 0; q < cv.faces.length; q++) raw.set(soupRef.subarray(cv.faces[q] * 9, cv.faces[q] * 9 + 9), q * 9);
      var o = new THREE.Mesh(localGeo(raw), new THREE.MeshBasicMaterial({
        color: 0x05070d, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      o.renderOrder = 41;
      o.userData.skipXray = true;
      o.userData.nsoFoamHollow = cv.id;
      group.add(o);
      return o;
    });
  }

  function styleVoids() {
    voids.forEach(function (o) {
      var c = o.userData.nsoFoamHollow === chosen;
      o.material.opacity = c ? 0.72 : 0.38;
      o.material.color.setHex(c ? 0x020308 : 0x111827);
    });
  }

  function redraw() {
    dirty = false;
    disposeObj(foamObj); foamObj = null;
    disposeObj(ringObj); ringObj = null;
    last = null;
    if (chosen == null) { readout(); return; }
    var p = FM().preview(soupRef, A, chosen, heights[chosen] || 0, { rawCut: window.rawCut || (typeof rawCut === 'function' ? rawCut : null) });
    last = p;
    if (p.ok && p.foam.length) {
      var mat = foamMaterial();
      foamObj = new THREE.Mesh(localGeo(p.foam, true), mat);
      foamObj.geometry.computeVertexNormals();
      foamObj.renderOrder = 42;
      foamObj.userData.skipXray = true;
      foamObj.userData.nsoFoam = true;
      group.add(foamObj);
    }
    if (p.ok && p.ring.length) {
      ringObj = new THREE.LineSegments(localGeo(p.ring), new THREE.LineBasicMaterial({
        color: 0xfff3b0, transparent: true, opacity: 1, depthTest: false }));
      ringObj.renderOrder = 43;
      ringObj.userData.skipXray = true;
      group.add(ringObj);
    }
    readout();
  }

  /* ---------------------------------------------------------------
     The panel
     --------------------------------------------------------------- */

  function cvOf(id) { return A && id != null ? A.cavities[id] : null; }

  function readout() {
    var r = $('foam-readout'), s = $('inp-foam-level'), lr = $('foam-level-read');
    var cv = cvOf(chosen);
    if (s) {
      s.disabled = !cv;
      s.max = cv ? String(cv.height) : '1';
      s.step = '0.01';
      s.value = cv ? String(heights[chosen] || 0) : '0';
    }
    if (lr) lr.textContent = cv ? (heights[chosen] || 0).toFixed(1) + ' of ' + cv.height.toFixed(1) + ' mm' : '—';
    ['btn-foam-all', 'btn-foam-set'].forEach(function (id) { var b = $(id); if (b) b.disabled = !cv; });
    var text = !cv ? 'Click a hollow to choose it.' : (last && last.ok ? last.reason : (last ? last.reason : '—'));
    if (cv && last && last.captiveCross) text += ' - the surface is inside the loose solid; Set waits until it is past it';
    if (r) r.textContent = text;
    var list = $('foam-hollows');
    if (list) {
      list.querySelectorAll('.foam-hollow').forEach(function (b) {
        var c = Number(b.dataset.hollow) === chosen;
        b.classList.toggle('is-on', c);
        b.setAttribute('aria-pressed', c ? 'true' : 'false');
      });
    }
  }

  function buildList() {
    var list = $('foam-hollows');
    if (!list) return;
    list.innerHTML = '';
    var h = document.createElement('div');
    h.className = 'foam-hollows-head';
    h.textContent = 'Hollows found:';
    list.appendChild(h);
    A.cavities.forEach(function (cv) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-secondary foam-hollow';
      b.dataset.hollow = String(cv.id);
      b.textContent = 'Hollow ' + (cv.id + 1) + ' - ' + FM().grouped(cv.volume) + ' mm³';
      b.addEventListener('click', function () { choose(cv.id); });
      list.appendChild(b);
    });
  }

  function showPanel(v) {
    var p = $('foam-panel');
    if (p) p.hidden = !v;
    var b = $('btn-foam');
    if (b) { b.classList.toggle('is-on', !!v); b.setAttribute('aria-pressed', v ? 'true' : 'false'); }
  }

  /* ---------------------------------------------------------------
     Enter / leave
     --------------------------------------------------------------- */

  function enter() {
    if (on) { cancel(); return { ok: true, left: true }; }
    if (!FM()) { say('Foam needs nso_foam.js', true); return { ok: false }; }
    boxCancel(true);                                       // one Foam at a time: the box steps aside
    gunCancel(true);
    var model = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!model) { say('Select a piece first', true); return { ok: false, reason: 'no piece' }; }
    if (typeof nsoNonSolid === 'function' && nsoNonSolid(model)) {
      var nr = 'Foam does not apply to "' + model.name + '" - it is flagged non-solid, so it has no closed inside ' +
        'for foam to fill. Nothing changed.';
      say(nr, true);
      return { ok: false, reason: nr };
    }
    if (!(model.rawTris && model.rawAxis === 'zup' && model.rawTris.length >= 9)) {
      say('Foam needs a raw piece - split, wrap or boolean it first. Nothing changed.', true);
      return { ok: false };
    }
    var ms = meshOf(model);
    if (!ms) { say('Foam: put the piece on the plate first. Nothing changed.', true); return { ok: false }; }
    var an = FM().analyse(model.rawTris, { up: upRaw(ms) });
    if (!an.ok) { say(an.reason, true); return { ok: false, reason: an.reason, kind: an.kind }; }

    on = true;
    m = model; soupRef = model.rawTris; mesh = ms; A = an;
    heights = {};
    chosen = A.cavities.length === 1 ? 0 : null;
    group = new THREE.Group();
    group.userData.skipXray = true;
    group.userData.nsoFoamGroup = true;
    // A helper (nso-helpers.js), riding the piece's mesh; interactive - a
    // click on a hollow's void chooses it.
    nsoHelpers.attach(mesh, group, 'foam', { interactive: true });
    ghost(true);
    buildVoids();
    styleVoids();
    buildList();
    showPanel(true);
    redraw();
    say(A.reason + ' ' + (chosen == null ? 'Click a hollow to choose it, then hold' : 'Hold') +
        ' the mouse on the piece to spray foam in; let go to pause.');
    tick();
    return { ok: true, analysis: A };
  }

  function teardown() {
    stopSpray();
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    disposeObj(foamObj); foamObj = null;
    disposeObj(ringObj); ringObj = null;
    voids.forEach(disposeObj); voids = [];
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
    showPanel(false);
    on = false;
    m = null; soupRef = null; mesh = null; A = null; chosen = null; last = null;
  }

  function cancel(quiet) {
    if (!on) return false;
    teardown();
    if (!quiet) say('Foam cancelled - nothing changed');
    return true;
  }

  /* The piece moved on under the panel - another selection, an Undo, a bake:
     the foam no longer describes it, so it is put away. */
  function stale() {
    if (!on) return false;
    var cur = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (cur !== m || m.rawTris !== soupRef || meshOf(m) !== mesh) {
      cancel(true);
      say('Foam put away - the piece or the selection changed under it. Nothing was set.');
      return true;
    }
    return false;
  }

  function choose(id) {
    if (!on || !cvOf(id)) return false;
    chosen = id;
    if (heights[id] == null) heights[id] = 0;
    styleVoids();
    redraw();
    return true;
  }

  function setHeight(h) {
    if (!on) return null;
    var cv = cvOf(chosen);
    if (!cv) return null;
    var v = Math.max(0, Math.min(cv.height, +h || 0));
    heights[chosen] = v;
    dirty = true;
    readout();
    return v;
  }

  function fillAll() { var cv = cvOf(chosen); if (cv) { setHeight(cv.height); redraw(); } }

  /* ---------------------------------------------------------------
     Spray
     --------------------------------------------------------------- */

  function tick() {
    raf = 0;
    if (!on) return;
    if (stale()) return;
    var now = performance.now();
    if (spraying) {
      var cv = cvOf(chosen);
      if (cv) {
        /* Wall-clock time, so the rate is the rate however slowly frames come;
           capped only so a stalled tab does not jump the level on return. */
        var dt = Math.min(0.5, (now - sprayT) / 1000);
        setHeight((heights[chosen] || 0) + cv.height / SPRAY_SECONDS * dt);
      }
    }
    sprayT = now;
    if (dirty) redraw();
    raf = requestAnimationFrame(tick);
  }

  function stopSpray() {
    if (!spraying) return;
    spraying = false;
    if (state.controls) state.controls.enabled = true;
    if (on) readout();
  }

  /* What the press is on: a hollow's void in the ghost view, or the piece. */
  function pick(event) {
    if (!on || !mesh || !state.camera || !state.renderer) return null;
    var r = state.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, state.camera);
    var vh = rc.intersectObjects(voids, false);
    var hollow = vh.length ? vh[0].object.userData.nsoFoamHollow : null;
    var ph = rc.intersectObject(mesh, false);
    if (hollow == null && !ph.length) return null;
    return { hollow: hollow, piece: ph.length > 0 };
  }

  window.nsoFoamTakesPointer = function (event) {
    if (!event || event.button !== 0) return false;
    if (P.on) return P.spraying || gunTakes(gunAim(event));
    if (G.on) return G.spraying || boxAims(event);
    if (!on) return false;
    return !!pick(event);
  };

  function onDown(event) {
    if (!on || event.button !== 0) return;
    if (stale()) return;
    var p = pick(event);
    if (!p) return;
    event.stopPropagation();
    event.preventDefault();
    if (p.hollow != null && p.hollow !== chosen) {
      choose(p.hollow);
      say('Hollow ' + (p.hollow + 1) + ' chosen - hold the mouse on the piece to spray foam in.');
      return;
    }
    if (chosen == null) { say('Click a hollow to choose it first.', true); return; }
    spraying = true;
    sprayT = performance.now();
    if (state.controls) state.controls.enabled = false;
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function onUp() { stopSpray(); }

  /* ---------------------------------------------------------------
     Set
     --------------------------------------------------------------- */

  function set() {
    if (!on) return { ok: false, reason: 'Foam is not on' };
    if (stale()) return { ok: false, reason: 'the piece changed - Foam put away' };
    stopSpray();
    var cv = cvOf(chosen);
    if (!cv) { say('Click a hollow to choose it first.', true); return { ok: false }; }
    var skip = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(m) : [];
    if (skip === null) {
      var sr = 'Foam stood down - a painted recessed patch has no axis and side to check against the hollow\'s ' +
        'walls, so no wall can be promised untouched. Clear that paint to foam. Nothing changed.';
      say(sr, true);
      return { ok: false, reason: sr };
    }
    var model = m;
    var res = FM().foam(soupRef, A, chosen, heights[chosen] || 0, {
      skipList: skip,
      rawCut: window.rawCut || (typeof rawCut === 'function' ? rawCut : null),
      faceName: function (i) {
        var e = model.faceMask && model.faceMask.exclude && model.faceMask.exclude[i];
        return (e && typeof nsoMaskFaceName === 'function') ? nsoMaskFaceName(e) : null;
      }
    });
    if (!res.ok || !res.changed) { say(res.reason, !res.ok); return res; }
    teardown();
    if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(model, res.soup, 'foamReplace', res.reason)) {
      say('Foam: could not commit the result - nothing changed', true);
      return { ok: false, reason: 'commit failed' };
    }
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    flash(meshOf(model));
    return res;
  }

  /* The foam turns solid: the fresh piece glows orange and fades back. */
  function flash(ms) {
    if (!ms || !ms.material || !ms.material.emissive) return;
    var mt = ms.material, c0 = mt.emissive.getHex(), i0 = mt.emissiveIntensity;
    var hot = new THREE.Color(0xff8a1f), base = new THREE.Color(c0), t0 = performance.now();
    function step() {
      var k = Math.min(1, (performance.now() - t0) / FLASH_MS);
      if (ms.material !== mt) return;
      mt.emissive.copy(hot).lerp(base, k);
      mt.emissiveIntensity = (1.4 * (1 - k)) + i0 * k;
      if (k < 1) requestAnimationFrame(step);
      else { mt.emissive.setHex(c0); mt.emissiveIntensity = i0; }
    }
    step();
  }

  /* ---------------------------------------------------------------
     FOAM's Box mode (docs/FOAM.md section 11) - the box that was the gun's

     FOAM puts Crop's Box on the selected piece: NSO_CropCard.lend() draws it with
     the card's own handles, and the handles place and size it - there is no
     field. A press that aims at the piece through the box is the spray: the
     amount rises 0 to 100 in GUN_SECONDS while the mouse is held, foamBox is
     asked at the amount as it now stands, and the foam it makes is drawn while
     you hold (the piece a ghost, the foam orange, cut to the box and the level).
     Letting go sets the amount reached, as one Undo; the box stays for the next
     spray, which takes the piece as it now is and adds to it. Escape or Cancel
     takes the box away. All the geometry is NSO_Foam.foamBox's.
     --------------------------------------------------------------- */

  var G = {
    on: false, m: null, box: null,
    spraying: false, finishing: false, amount: 0, sprayT: 0, seq: 0, busy: false, sprays: 0,
    base: null, toRaw: null, skip: null, ms: null, last: null,
    group: null, foam: null, raf: 0, readout: '—'
  };

  function cardApi() { return window.NSO_CropCard || null; }

  function boxReadout(text) {
    G.readout = text;
    var r = $('foam-box-readout');
    if (r) r.textContent = text;
  }
  function boxPanel(v) {
    var p = $('foam-box-panel');
    if (p) p.hidden = !v;
    var b = $('btn-foam');
    if (b) { b.classList.toggle('is-on', !!v); b.setAttribute('aria-pressed', v ? 'true' : 'false'); }
  }

  /* Crop's Box in P is drawn in world as (Px, Pz, -Py); these are its six faces
     as clipping planes (kept side inside) and the level, so only the foam in the
     box and under the level is drawn. A hair of slack so a cap lying on a plane
     is not clipped by rounding. */
  var CLIP_EPS = 0.03;
  function boxPlanes(level) {
    var b = G.box, a = b.yaw * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    var axes = [[c, sn, 0], [-sn, c, 0], [0, 0, 1]], out = [];
    function w(v) { return new THREE.Vector3(v[0], v[2], -v[1]); }
    for (var k = 0; k < 3; k++) {
      [1, -1].forEach(function (sg) {
        var e = axes[k], n = w([-sg * e[0], -sg * e[1], -sg * e[2]]);
        var at = w([b.c[0] + sg * (b.h[k] + CLIP_EPS) * e[0], b.c[1] + sg * (b.h[k] + CLIP_EPS) * e[1], b.c[2] + sg * (b.h[k] + CLIP_EPS) * e[2]]);
        out.push(new THREE.Plane().setFromNormalAndCoplanarPoint(n, at));
      });
    }
    if (level != null) out.push(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, level + CLIP_EPS, 0)));
    return out;
  }

  /* A triangle's identity: its nine corner floats, bit for bit. */
  function triKey(u, o) {
    var h1 = 0x811c9dc5, h2 = 0x9747b28c;
    for (var k = 0; k < 9; k++) {
      var x = u[o + k];
      h1 = Math.imul(h1 ^ x, 16777619);
      h2 = Math.imul(h2 + x, 0x85ebca6b); h2 ^= h2 >>> 13;
    }
    return (h1 >>> 0) * 2097152 + (h2 >>> 11);
  }

  /* The foam's surface, from the piece before and after: foamBox hands back the
     piece with the foam welded in, every triangle clear of the foam bit for bit.
     What the foam welded away (the walls it covers) and what it added (its caps
     and lids, and the remains of the walls it cut) are the two sides of the
     difference; drawn clipped to the box and the level, the remains fall outside
     and what is left is the foam's own skin. */
  function foamSkin(before, after) {
    var ub = new Uint32Array(before.buffer, before.byteOffset, before.length);
    var ua = new Uint32Array(after.buffer, after.byteOffset, after.length);
    var nb = Math.floor(before.length / 9), na = Math.floor(after.length / 9), i;
    var inBefore = new Map();
    for (i = 0; i < nb; i++) { var k = triKey(ub, i * 9); inBefore.set(k, (inBefore.get(k) || 0) + 1); }
    var out = [], inAfter = new Map();
    for (i = 0; i < na; i++) {
      var ka = triKey(ua, i * 9), c = inBefore.get(ka);
      if (c) inBefore.set(ka, c - 1);
      else for (var q = 0; q < 9; q++) out.push(after[i * 9 + q]);
    }
    for (i = 0; i < nb; i++) {
      var kb = triKey(ub, i * 9), left = inBefore.get(kb);
      if (left > 0) { inBefore.set(kb, left - 1); for (var r = 0; r < 9; r++) out.push(before[i * 9 + r]); }
    }
    return new Float32Array(out);
  }

  function boxDisposeFoam() {
    disposeObj(G.foam); G.foam = null;
    if (G.group && G.group.parent) G.group.parent.remove(G.group);
    G.group = null;
  }

  function boxDrawFoam(res) {
    boxDisposeFoam();
    if (!res.ok || !res.changed) return;
    var skin = foamSkin(G.base, res.mesh);
    if (!skin.length) return;
    var mat = foamMaterial();
    mat.side = THREE.DoubleSide;
    mat.clippingPlanes = boxPlanes(res.level);
    G.foam = new THREE.Mesh(localGeo(skin, true, G.m), mat);
    G.foam.geometry.computeVertexNormals();
    G.foam.renderOrder = 42;
    G.foam.userData.skipXray = true;
    G.foam.userData.nsoFoam = true;
    G.group = new THREE.Group();
    G.group.userData.skipXray = true;
    G.group.userData.nsoFoamGroup = true;
    G.group.add(G.foam);
    nsoHelpers.attach(G.ms, G.group, 'foam', { interactive: false });
  }

  /* What a spray shows: only what the engine returned - the volume it added,
     or its refusal in its own words. */
  function volumeWords(res) { return '+' + FM().grouped(Math.round(res.addedVolume || 0)) + ' mm³'; }
  function boxShow(res) {
    G.last = res;
    boxDrawFoam(res);
    boxReadout(res.ok ? volumeWords(res) : res.reason);
  }

  function boxAsk(amount) {
    var model = G.m, box = G.box;
    var piece = { rawTris: G.base, toRaw: G.toRaw, name: model.name, skipList: G.skip };
    return Promise.resolve().then(function () {
      return FM().foamBox(piece, { c: box.c.slice(), h: box.h.slice(), yaw: box.yaw }, amount, {
        faceName: function (i) {
          var e = model.faceMask && model.faceMask.exclude && model.faceMask.exclude[i];
          return (e && typeof nsoMaskFaceName === 'function') ? nsoMaskFaceName(e) : null;
        }
      });
    }).catch(function (err) {
      return { ok: false, changed: false, addedVolume: 0, reason: 'Foam: ' + ((err && err.message) || err) + '. Nothing changed.' };
    });
  }

  function boxTick() {
    G.raf = 0;
    if (!G.on) return;
    var cur = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (cur !== G.m) {
      boxCancel(true);
      say('Foam box put away - the selection changed. Nothing was set.');
      return;
    }
    var now = performance.now();
    if (G.spraying) {
      var dt = Math.min(0.5, (now - G.sprayT) / 1000);
      G.amount = Math.min(100, G.amount + 100 / GUN_SECONDS * dt);
      if (!G.busy) {
        var seq = G.seq, a = G.amount;
        G.busy = true;
        boxAsk(a).then(function (res) {
          G.busy = false;
          if (seq === G.seq && G.spraying) boxShow(res);
        });
      }
    }
    G.sprayT = now;
    G.raf = requestAnimationFrame(boxTick);
  }

  function boxPieceHit(event) {
    var ms = G.m ? meshOf(G.m) : null;
    if (!ms || !state.camera || !state.renderer) return false;
    var r = state.renderer.domElement.getBoundingClientRect();
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1), state.camera);
    return rc.intersectObject(ms, false).length > 0;
  }

  /* Aimed at the piece through the box: the ray passes through the box and meets
     the piece (a box buried in the piece is aimed at through its wall). */
  function boxAims(event) {
    var card = cardApi();
    return !!(G.on && !G.finishing && card && card.bodyHit(event) && boxPieceHit(event));
  }

  function boxDown(event) {
    if (!G.on || event.button !== 0 || G.spraying || G.finishing) return;
    if (!boxAims(event)) return;
    event.stopPropagation();
    event.preventDefault();
    var model = G.m, ms = meshOf(model);
    var fr = (window.NSO_Crop && NSO_Crop.plateToRaw) ? NSO_Crop.plateToRaw(model, ms) : { reason: 'Foam box needs Crop' };
    if (fr.reason) { say('Foam: ' + fr.reason + '. Nothing changed.', true); boxReadout(fr.reason); return; }
    var skip = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(model) : [];
    if (skip === null) {
      var sr = 'Foam stood down - a painted recessed patch has no axis and side to check against the faces the foam ' +
        'would weld to, so no face can be promised untouched. Clear that paint to foam. Nothing changed.';
      say(sr, true); boxReadout(sr);
      return;
    }
    G.base = model.rawTris; G.toRaw = fr.M; G.skip = skip; G.ms = ms; G.last = null;
    G.amount = 0; G.sprayT = performance.now(); G.seq++; G.busy = false; G.spraying = true;
    ghost(true, ms);
    if (state.controls) state.controls.enabled = false;
  }

  function boxUp() {
    if (!G.spraying) return;
    G.spraying = false;
    if (state.controls) state.controls.enabled = true;
    boxSet();
  }

  /* Letting go sets the amount reached: foamBox asked once more at exactly that,
     and its mesh committed as one Undo. */
  function boxSet() {
    var seq = ++G.seq, amount = G.amount, model = G.m, base = G.base;
    G.finishing = true;
    return boxAsk(amount).then(function (res) {
      G.finishing = false;
      if (!G.on || seq !== G.seq) { ghost(false); boxDisposeFoam(); return res; }
      ghost(false);
      boxDisposeFoam();
      if ((typeof getActiveModel === 'function' && getActiveModel() !== model) || model.rawTris !== base) {
        say('Foam box: the piece changed under the spray. Nothing was set.', true);
        return { ok: false, changed: false, reason: 'the piece changed' };
      }
      if (!res.ok || !res.changed) {
        boxReadout(res.ok ? volumeWords(res) : res.reason);
        say(res.reason, !res.ok);
        return res;
      }
      if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(model, res.mesh, 'foamReplace', res.reason)) {
        say('Foam: could not commit the result - nothing changed', true);
        boxReadout('Foam: could not commit the result - nothing changed');
        return { ok: false, reason: 'commit failed' };
      }
      G.sprays++;
      G.last = res;
      boxReadout(volumeWords(res));
      if (typeof updateAdjustUI === 'function') updateAdjustUI();
      flash(meshOf(model));
      if (cardApi()) cardApi().refresh();
      return res;
    });
  }

  function boxCancel(quiet) {
    if (!G.on) return false;
    G.seq++;
    G.spraying = false; G.finishing = false; G.busy = false;
    if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
    ghost(false);
    boxDisposeFoam();
    G.on = false;
    if (cardApi()) cardApi().release();
    if (state.controls) state.controls.enabled = true;
    boxPanel(false);
    boxReadout('—');
    G.m = null; G.base = null; G.ms = null; G.last = null; G.box = null;
    if (!quiet) say('Foam box put away - nothing changed');
    return true;
  }

  function boxStart() {
    if (G.on) { boxCancel(); return { ok: true, left: true }; }
    if (!FM()) { say('Foam needs nso_foam.js', true); return { ok: false }; }
    var card = cardApi();
    if (!card) { say('Foam box needs the Crop card\'s Box', true); return { ok: false }; }
    if (on) cancel(true);                                   // one Foam at a time: the sealed-hollow one steps aside
    gunCancel(true);
    var model = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!model) { say('Select a piece first', true); return { ok: false, reason: 'no piece' }; }
    var r = card.lend({ onChange: function (b) { G.box = b; }, taken: function () { boxCancel(true); } });
    if (!r.ok) { say('Foam box: ' + r.reason + '. Nothing changed.', true); return r; }
    if (state.renderer) state.renderer.localClippingEnabled = true;
    G.on = true; G.m = model; G.box = r.box; G.sprays = 0; G.last = null;
    boxPanel(true);
    boxReadout('—');
    say('Foam box: drag the box\'s handles to place and size it, then aim at the piece inside the box and hold the mouse. ' +
        'Escape takes the box away.');
    G.sprayT = performance.now();
    G.raf = requestAnimationFrame(boxTick);
    return { ok: true, box: r.box };
  }

  /* ---------------------------------------------------------------
     FOAM's two modes, side by side
     --------------------------------------------------------------- */

  /* FOAM: the box (the default); pressed again, whatever Foam has out goes. */
  function foamButton() {
    if (on) { cancel(); return; }
    if (G.on) { boxCancel(); return; }
    boxStart();
  }
  function toHollow() { boxCancel(true); if (!on) enter(); }
  function toBox() { if (on) cancel(true); if (!G.on) boxStart(); }

  /* ---------------------------------------------------------------
     The GUN (docs/FOAM-GUN.md): point into a gap, hold, it fills.

     No box. GUN arms it and reads the piece at once (nso_foam_gun.js keeps it).
     The cursor is a little foam gun, and it says what a press would do before
     you press:

       ready    green tick  - over a gap the gun can fill: hold now
       no       red bar     - over the piece, but not in a gap (the top face,
                              open air beside a wall): nothing to fill there
       busy     grey dots   - reading the piece (on arming, after a set)
       spray    orange foam - spraying
       plain gun            - off the piece: a press there orbits

     While the cursor rests on a gap the foam is built ahead (one spray, kept
     for that spot), so a press starts the foam rising at once. Hold: it rises
     from the plate, 0 to 100 in GUN_SECONDS. Let go: the amount reached is set
     as one Undo, and the foam that went in glows for a moment so you can see
     it. A tap - let go before the foam has risen at all - sets nothing and
     says so. Escape, Cancel or GUN again puts it away.
     --------------------------------------------------------------- */

  var TAP_MS = 250;               // let go before this much foam has risen (this long a hold) and nothing is set
  var GLOW_MS = 1400;             // the foam just set glows this long
  var REACH_PX = 6;               // a gap this many pixels from the cursor counts as aimed at
  var PREFETCH_MS = 120;          // the cursor rests this long on a gap before its foam is built ahead
  var P = {
    on: false, m: null, ms: null, base: null, skip: null, up: null, aim: null,
    spraying: false, finishing: false, amount: 0, sprayT: 0, downT: 0, seq: 0, sprays: 0,
    full: null, last: null, group: null, foam: null, raf: 0, readout: '—',
    cursor: '', hover: null, hoverSeq: 0, moveRaf: 0, lastMove: null, pre: null, preTimer: 0, preparing: false,
    glow: null, warmMat: null
  };
  function GM() { return (typeof NSO_FoamGun !== 'undefined') ? NSO_FoamGun : null; }

  /* ---- the cursor: a little foam gun, nozzle tip at the hotspot ---- */
  var GUN_SVG_BODY =
    '<path d="M1 9.9 L11.2 8.3 L11.2 12.5 L1 11.1 Z" fill="#ece22a" stroke="#4d4800" stroke-width="0.8" stroke-linejoin="round"/>' +
    '<rect x="10.4" y="6.8" width="3" height="7.4" rx="1.2" fill="#f4ea3a" stroke="#4d4800" stroke-width="0.8"/>' +
    '<rect x="13" y="5" width="15.5" height="10" rx="2.6" fill="#2d3184" stroke="#0b0d30" stroke-width="0.9"/>' +
    '<rect x="20.5" y="3.4" width="4.2" height="3" rx="0.8" fill="#111"/>' +
    '<path d="M19.2 14.2 L26.4 14.2 L28.8 28.8 Q29 30.6 27.2 30.6 L23.2 30.6 Q21.7 30.6 21.5 29.2 Z" fill="#2d3184" stroke="#0b0d30" stroke-width="0.9" stroke-linejoin="round"/>' +
    '<path d="M22.8 18.2h4.1M23.2 20.8h4.1M23.6 23.4h4.1M24 26h4.1" stroke="#6d72cc" stroke-width="0.8"/>' +
    '<path d="M17.6 14.6 Q15.4 21.2 17.1 28.6" fill="none" stroke="#111" stroke-width="2.1" stroke-linecap="round"/>';
  var GUN_BADGE = {
    plain: '',
    ready: '<circle cx="7" cy="24.6" r="5.6" fill="#1f9d55" stroke="#fff" stroke-width="1.3"/>' +
           '<path d="M4.3 24.8 L6.3 26.8 L9.8 22.8" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    no:    '<circle cx="7" cy="24.6" r="5.6" fill="#d23b3b" stroke="#fff" stroke-width="1.3"/>' +
           '<path d="M3.9 24.6 H10.1" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
    busy:  '<circle cx="7" cy="24.6" r="5.6" fill="#6b6b6b" stroke="#fff" stroke-width="1.3"/>' +
           '<circle cx="4.6" cy="24.6" r="0.95" fill="#fff"/><circle cx="7" cy="24.6" r="0.95" fill="#fff"/><circle cx="9.4" cy="24.6" r="0.95" fill="#fff"/>',
    spray: '<circle cx="4.2" cy="15.6" r="2.4" fill="#ff8a1f" stroke="#8a3f00" stroke-width="0.7"/>' +
           '<circle cx="8.2" cy="17.6" r="1.8" fill="#ffa64d" stroke="#8a3f00" stroke-width="0.7"/>' +
           '<circle cx="3.4" cy="20.6" r="1.6" fill="#ff8a1f" stroke="#8a3f00" stroke-width="0.7"/>' +
           '<circle cx="7.6" cy="22.4" r="1.2" fill="#ffa64d" stroke="#8a3f00" stroke-width="0.6"/>' +
           '<circle cx="9.4" cy="13.8" r="1.1" fill="#ffa64d" stroke="#8a3f00" stroke-width="0.6"/>'
  };
  var GUN_FALLBACK = { plain: 'crosshair', ready: 'crosshair', no: 'not-allowed', busy: 'progress', spray: 'crosshair' };
  var gunCursorCss = {};
  function gunCursorOf(kind) {
    if (!gunCursorCss[kind]) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' + GUN_SVG_BODY + (GUN_BADGE[kind] || '') + '</svg>';
      gunCursorCss[kind] = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '") 1 10, ' + GUN_FALLBACK[kind];
    }
    return gunCursorCss[kind];
  }
  function gunCursor(kind) {
    P.cursor = kind || '';
    var el = state.renderer && state.renderer.domElement;
    if (el) el.style.cursor = kind ? gunCursorOf(kind) : '';
  }

  function gunReadout(text) {
    P.readout = text;
    var r = $('foam-gun-readout');
    if (r) r.textContent = text;
  }
  function gunPanel(v) {
    var p = $('foam-gun-panel');
    if (p) p.hidden = !v;
    var b = $('btn-foam-gun');
    if (b) { b.classList.toggle('is-on', !!v); b.setAttribute('aria-pressed', v ? 'true' : 'false'); }
  }
  function gunWords(added) { return GM() ? GM().readout(added) : '+' + Math.round(added) + ' mm³'; }

  function gunDisposeFoam() {
    disposeObj(P.foam); P.foam = null;
    if (P.group && P.group.parent) P.group.parent.remove(P.group);
    P.group = null;
  }
  /* The level as a world plane: the plate's vertical is world +Y, and the
     level is a height along the piece's raw `up`. */
  function gunLevelPlane(level, res, ms) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(P.m) : null, u = res.up;
    var raw = [u[0] * level, u[1] * level, u[2] * level];
    var loc = f ? nsoLocalPointFromRaw(f, raw) : raw;
    var w = ms.localToWorld(new THREE.Vector3(loc[0], loc[1], loc[2]));
    return new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, -1, 0), w);
  }
  function gunFoamMesh(res) {
    var mat = foamMaterial();
    mat.side = THREE.DoubleSide;
    var o = new THREE.Mesh(localGeo(res.foam, true, P.m), mat);
    o.geometry.computeVertexNormals();
    o.renderOrder = 42;
    o.userData.skipXray = true;
    o.userData.nsoFoam = true;
    return o;
  }
  function gunDrawFoam() {
    gunDisposeFoam();
    var res = P.full;
    if (!res || !res.ok || !res.changed || !res.foam || !res.foam.length) return;
    P.foam = gunFoamMesh(res);
    P.group = new THREE.Group();
    P.group.userData.skipXray = true;
    P.group.userData.nsoFoamGroup = true;
    P.group.add(P.foam);
    nsoHelpers.attach(P.ms, P.group, 'foam', { interactive: false });
    gunShowLevel();
  }
  function gunShowLevel() {
    var res = P.full;
    if (!P.foam || !res || !res.span) return;
    var lv = res.span[0] + P.amount / 100 * (res.span[1] - res.span[0]);
    P.foam.material.clippingPlanes = [gunLevelPlane(lv + 1e-3, res, P.ms)];
    gunReadout(gunWords(res.addedVolume * P.amount / 100) + ' - holding');
  }

  /* After a set: the foam that went in, drawn over the piece and fading, so
     what changed can be seen without going to look for it. */
  function gunGlowOff() {
    if (!P.glow) return;
    disposeObj(P.glow.obj);
    if (P.glow.group.parent) P.glow.group.parent.remove(P.glow.group);
    P.glow = null;
  }
  function gunGlow(res, level, model) {
    gunGlowOff();
    var ms = meshOf(model);
    if (!res.foam || !res.foam.length || !ms) return;
    var o = gunFoamMesh(res), g = new THREE.Group();
    o.material.transparent = true;
    o.material.depthTest = false;
    o.material.clippingPlanes = [gunLevelPlane(level + 1e-3, res, ms)];
    g.userData.skipXray = true;
    g.userData.nsoFoamGroup = true;
    g.add(o);
    nsoHelpers.attach(ms, g, 'foam', { interactive: false });
    var glow = P.glow = { obj: o, group: g }, t0 = performance.now();
    (function fade() {
      if (P.glow !== glow) return;
      var k = (performance.now() - t0) / GLOW_MS;
      if (k >= 1) { gunGlowOff(); return; }
      o.material.opacity = 0.85 * (1 - k * k);
      requestAnimationFrame(fade);
    })();
  }

  /* The ray under the mouse, raw: its hit on the piece and its direction. */
  function gunAim(event) {
    var ms = P.m ? meshOf(P.m) : null;
    if (!ms || !state.camera || !state.renderer) return null;
    var r = state.renderer.domElement.getBoundingClientRect();
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1), state.camera);
    var hits = rc.intersectObject(ms, false), through = false;
    ms.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(ms.matrixWorld).invert();
    var ld = rc.ray.direction.clone().transformDirection(inv), lp;
    if (hits.length) lp = ms.worldToLocal(hits[0].point.clone());
    else {
      /* Straight down a through-gap the ray meets nothing: aim at the middle
         of its run through the piece's box instead. */
      var g = ms.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      var lr = rc.ray.clone().applyMatrix4(inv), a = lr.intersectBox(g.boundingBox, new THREE.Vector3());
      if (!a) return null;
      var far = new THREE.Ray(lr.at(1e5, new THREE.Vector3()), lr.direction.clone().negate()).intersectBox(g.boundingBox, new THREE.Vector3());
      if (!far) return null;
      lp = a.add(far).multiplyScalar(0.5);
      through = true;
    }
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(P.m) : null;
    var point = f ? nsoRawPointFromLocal(f, [lp.x, lp.y, lp.z]) : [lp.x, -lp.z, lp.y];
    var dir = (typeof nsoRawDirFromLocal === 'function') ? nsoRawDirFromLocal([ld.x, ld.y, ld.z]) : [ld.x, -ld.z, ld.y];
    /* Reach: a gap within REACH_PX of the cursor counts as aimed at - a
       hairline slit is thinner than a pixel. In mm at the hit's depth. */
    var wp = ms.localToWorld(lp.clone()), cam = state.camera, perPx = 0;
    if (cam.isPerspectiveCamera) perPx = 2 * wp.distanceTo(cam.position) * Math.tan(cam.fov * Math.PI / 360) / r.height;
    else if (cam.isOrthographicCamera) perPx = (cam.top - cam.bottom) / cam.zoom / r.height;
    var reach = Math.min(0.5, Math.max(0.02, REACH_PX * perPx));
    return { point: point, dir: dir, ms: ms, through: through, reach: reach };
  }
  function sameSpot(a, b) {
    return !!(a && b) && Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1], a.point[2] - b.point[2]) < 0.05 &&
      a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2] > 0.9995;
  }

  /* What the GUN needs of the piece as it is now; null (and said) when it cannot spray it. */
  function gunPiece() {
    var model = P.m, ms = meshOf(model);
    if (!ms) return null;
    if (typeof nsoNonSolid === 'function' && nsoNonSolid(model)) {
      return { refuse: 'GUN does not apply to "' + model.name + '" - it is flagged non-solid, so it has no closed inside to fill. Nothing changed.' };
    }
    var skip = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(model) : [];
    if (skip === null) {
      return { refuse: 'GUN stood down - a painted recessed patch has no axis and side to check against the faces the foam ' +
        'would fill against. Clear that paint to spray. Nothing changed.' };
    }
    return { base: model.rawTris, skip: skip, ms: ms, up: upRaw(ms) };
  }
  function gunAsk(pc, aim, amount) {
    return GM().spray({ rawTris: pc.base, skipList: pc.skip }, { point: aim.point, dir: aim.dir, reach: aim.reach }, { up: pc.up, amount: amount, preview: amount >= 100 })
      .catch(function (err) {
        return { ok: false, changed: false, addedVolume: 0, reason: 'GUN: ' + ((err && err.message) || err) + '. Nothing changed.' };
      });
  }

  /* Read the piece now - on arming, and after each set - with the busy cursor. */
  function gunPrepare() {
    var pc = gunPiece();
    if (!pc || pc.refuse) return;
    P.preparing = true;
    gunCursor('busy');
    var seq = P.seq;
    setTimeout(function () {                           // a frame for the busy cursor first
      if (!P.on || seq !== P.seq) return;
      GM().prepare({ rawTris: pc.base }, { up: pc.up }).then(function (r) {
        P.preparing = false;
        if (!P.on) return;
        if (!P.spraying) gunWarm(pc.ms);
        if (!r.ok) { gunReadout(r.reason); say(r.reason, true); }
        gunCursor(P.spraying ? 'spray' : 'plain');
        if (P.lastMove) gunHover(P.lastMove);
      }, function () { P.preparing = false; gunCursor('plain'); });
    }, 30);
  }

  /* The first ghost and the first foam each need a shader the GPU has not
     built yet - the pause before the ghost showed. Build both now, while the
     gun is being armed, so the press does not wait for them. */
  function gunWarm(ms) {
    var r = state.renderer;
    if (!r || typeof r.compile !== 'function' || !state.scene || !state.camera || !ms) return;
    var dummy = null;
    try {
      ghost(true, ms);
      var mat = foamMaterial();
      mat.side = THREE.DoubleSide;
      mat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6)];
      dummy = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)), mat);
      dummy.frustumCulled = false;
      state.scene.add(dummy);
      r.compile(state.scene, state.camera);
    } catch (e) { /* a warm-up only */ }
    if (dummy) {
      state.scene.remove(dummy);
      dummy.geometry.dispose();
      /* Its material is kept until the gun is put away: while one material
         holds the foam's shader, the real foam reuses it. */
      if (P.warmMat && P.warmMat !== dummy.material) P.warmMat.dispose();
      P.warmMat = dummy.material;
    }
    ghost(false);
  }

  /* ---- hover: what would a press here do? ---- */
  function gunMove(event) {
    if (!P.on) return;
    P.lastMove = { clientX: event.clientX, clientY: event.clientY, buttons: event.buttons };
    if (P.spraying || P.finishing || P.preparing || P.moveRaf) return;
    P.moveRaf = requestAnimationFrame(function () {
      P.moveRaf = 0;
      if (P.lastMove && !P.spraying && !P.finishing && !P.preparing) gunHover(P.lastMove);
    });
  }
  /* -> Promise of the cursor it settled on. */
  function gunHover(ev) {
    if (ev.buttons) return Promise.resolve(P.cursor);  // dragging an orbit
    var aim = gunAim(ev);
    if (P.preTimer) { clearTimeout(P.preTimer); P.preTimer = 0; }
    if (!aim) { P.hover = null; P.hoverSeq++; gunCursor('plain'); return Promise.resolve('plain'); }
    if (P.hover && sameSpot(P.hover.aim, aim)) return Promise.resolve(P.cursor);
    var pc = gunPiece();
    if (!pc || pc.refuse) { gunCursor('no'); P.hover = { aim: aim, ok: false, reason: pc && pc.refuse }; return Promise.resolve('no'); }
    var seq = ++P.hoverSeq;
    return GM().probe({ rawTris: pc.base }, aim, { up: pc.up }).then(function (r) {
      if (seq !== P.hoverSeq || !P.on || P.spraying || P.finishing) return P.cursor;
      P.hover = { aim: aim, ok: r.ok, reason: r.reason };
      gunCursor(r.ok ? 'ready' : (aim.through ? 'plain' : 'no'));
      if (r.ok) {
        /* Rest here and its foam is built ahead: the press then rises at once. */
        if (!(P.pre && P.pre.base === pc.base && sameSpot(P.pre.aim, aim))) {
          P.preTimer = setTimeout(function () {
            P.preTimer = 0;
            if (seq !== P.hoverSeq || !P.on || P.spraying || P.finishing || P.m.rawTris !== pc.base) return;
            gunAsk(pc, aim, 100).then(function (res) { if (P.on && P.m.rawTris === pc.base) P.pre = { base: pc.base, aim: aim, res: res }; });
          }, PREFETCH_MS);
        }
      }
      return P.cursor;
    });
  }

  /* Pull the trigger at `aim`: the ghost and the spraying gun at once, then
     the foam - built ahead if the cursor rested here, else built now. */
  function gunFire(aim) {
    var pc = gunPiece();
    if (!pc) return false;
    if (pc.refuse) { say(pc.refuse, true); gunReadout(pc.refuse); return false; }
    gunGlowOff();
    if (P.preTimer) { clearTimeout(P.preTimer); P.preTimer = 0; }
    P.base = pc.base; P.skip = pc.skip; P.ms = pc.ms; P.up = pc.up; P.aim = aim;
    P.amount = 0; P.sprayT = performance.now(); P.downT = P.sprayT; P.full = null; P.last = null; P.spraying = true;
    var seq = ++P.seq;
    ghost(true, pc.ms);
    gunCursor('spray');
    if (state.controls) state.controls.enabled = false;
    function got(res) {
      if (seq !== P.seq || !P.on) return;
      P.full = res;
      if (!res.ok || !res.changed) {
        P.spraying = false;
        if (state.controls) state.controls.enabled = true;
        ghost(false);
        gunCursor('no');
        gunReadout(res.reason);
        say(res.reason, !res.ok);
        P.last = res;
        return;
      }
      P.sprayT = performance.now();
      gunDrawFoam();
      gunReadout(gunWords(0) + ' - holding');
    }
    var pre = P.pre;
    if (pre && pre.base === pc.base && sameSpot(pre.aim, aim)) { got(pre.res); return true; }
    gunReadout('reading the gap…');
    /* Two frames, so the ghost and the spraying gun show before the work. */
    requestAnimationFrame(function () { setTimeout(function () {
      if (seq !== P.seq || !P.on) return;
      gunAsk(pc, aim, 100).then(got);
    }, 0); });
    return true;
  }

  function gunTick() {
    P.raf = 0;
    if (!P.on) return;
    var cur = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (cur !== P.m) {
      gunCancel(true);
      say('GUN put away - the selection changed. Nothing was set.');
      return;
    }
    var now = performance.now();
    if (P.spraying && P.full && P.full.ok) {
      var dt = Math.min(0.5, (now - P.sprayT) / 1000);
      P.amount = Math.min(100, P.amount + 100 / GUN_SECONDS * dt);
      gunShowLevel();
    }
    P.sprayT = now;
    P.raf = requestAnimationFrame(gunTick);
  }

  /* A press the gun takes: on the piece, or down a gap the cursor already
     calls ready. Anything else is the orbit's. */
  function gunTakes(aim) { return !!aim && (!aim.through || !!(P.hover && P.hover.ok && sameSpot(P.hover.aim, aim))); }
  function gunDown(event) {
    if (!P.on || event.button !== 0 || P.spraying || P.finishing) return;
    var aim = gunAim(event);
    if (!gunTakes(aim)) return;                        // off the piece: the orbit's
    event.stopPropagation();
    event.preventDefault();
    gunFire(aim);
  }
  function gunUp() {
    if (!P.spraying) return;
    P.spraying = false;
    if (state.controls) state.controls.enabled = true;
    /* Nothing has visibly risen - a tap, or let go while the gap was still
       being read: set nothing, and say how to spray. */
    if (!P.full || !P.full.ok || P.amount < 100 / GUN_SECONDS * (TAP_MS / 1000)) {
      var early = !P.full;
      P.seq++;
      ghost(false);
      gunDisposeFoam();
      gunCursor(P.hover && P.hover.ok ? 'ready' : 'plain');
      var t = early ? 'GUN: let go before the foam was ready - nothing set. Hold until you see it rise.'
                    : 'GUN: that was a tap - nothing set. Hold the mouse down to spray; the foam rises while you hold.';
      gunReadout(t); say(t);
      return;
    }
    gunSet();
  }

  /* Letting go: the amount reached, set as one Undo. All of it is the foam
     already built; part of it is asked again at exactly that amount. */
  function gunSet() {
    var full = P.full, model = P.m, base = P.base, amount = Math.max(P.amount, 0.5), pc = { base: P.base, skip: P.skip, up: P.up };
    if (!full || !full.ok || !full.changed) return Promise.resolve(full);
    var seq = ++P.seq;
    P.finishing = true;
    gunCursor('busy');
    var ask = amount >= 99.5 ? Promise.resolve(full) : gunAsk(pc, P.aim, amount);
    return ask.then(function (res) {
      P.finishing = false;
      ghost(false);
      gunDisposeFoam();
      if (!P.on || seq !== P.seq) return res;
      if ((typeof getActiveModel === 'function' && getActiveModel() !== model) || model.rawTris !== base) {
        say('GUN: the piece changed under the spray. Nothing was set.', true);
        gunCursor('plain');
        return { ok: false, changed: false, reason: 'the piece changed' };
      }
      if (!res.ok || !res.changed) { gunReadout(res.reason); say(res.reason, !res.ok); P.last = res; gunCursor('plain'); return res; }
      if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(model, res.mesh, 'foamReplace', res.reason)) {
        say('GUN: could not commit the result - nothing changed', true);
        gunReadout('GUN: could not commit the result - nothing changed');
        gunCursor('plain');
        return { ok: false, reason: 'commit failed' };
      }
      P.sprays++;
      P.last = res;
      P.pre = null; P.hover = null;
      gunReadout(gunWords(res.addedVolume) + ' set - ' + (res.amount >= 99.5 ? 'the gap is filled' : Math.round(res.amount) + '% of the gap'));
      say(res.reason);
      if (typeof updateAdjustUI === 'function') updateAdjustUI();
      gunGlow(full, res.level, model);
      gunPrepare();                                    // the piece as it now is, read for the next gap
      return res;
    });
  }

  /* For the drive check: a press at `aim` (raw), held until `amount`. */
  function gunSprayAt(aim, amount) {
    if (!P.on) return Promise.resolve({ ok: false, reason: 'GUN is not armed' });
    var ms = meshOf(P.m);
    if (!gunFire({ point: aim.point, dir: aim.dir, reach: aim.reach, ms: ms })) return Promise.resolve(P.last || { ok: false });
    var seq = P.seq;
    return new Promise(function (done) {
      (function wait() {
        if (seq !== P.seq) return done(P.last);
        if (!P.full) return setTimeout(wait, 20);
        if (!P.full.ok || !P.full.changed) return done(P.full);
        P.spraying = false;
        P.amount = amount == null ? 100 : amount;
        if (state.controls) state.controls.enabled = true;
        gunSet().then(done);
      })();
    });
  }
  /* For the drive check: what the cursor would say at a screen point. */
  function gunHoverAt(x, y) {
    if (!P.on) return Promise.resolve(null);
    P.hover = null;
    return gunHover({ clientX: x, clientY: y, buttons: 0 });
  }

  function gunCancel(quiet) {
    if (!P.on) return false;
    P.seq++; P.hoverSeq++;
    P.spraying = false; P.finishing = false; P.preparing = false;
    if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; }
    if (P.moveRaf) { cancelAnimationFrame(P.moveRaf); P.moveRaf = 0; }
    if (P.preTimer) { clearTimeout(P.preTimer); P.preTimer = 0; }
    ghost(false);
    gunDisposeFoam();
    gunGlowOff();
    gunCursor('');
    if (P.warmMat) { P.warmMat.dispose(); P.warmMat = null; }
    P.on = false;
    if (state.controls) state.controls.enabled = true;
    gunPanel(false);
    gunReadout('—');
    P.m = null; P.base = null; P.ms = null; P.full = null; P.aim = null; P.pre = null; P.hover = null; P.lastMove = null;
    if (GM()) GM().forget();
    if (!quiet) say('GUN put away - sprays already set stay; Undo takes them back one at a time');
    return true;
  }

  function gunStart() {
    if (P.on) { gunCancel(); return { ok: true, left: true }; }
    if (!GM()) { say('GUN needs nso_foam_gun.js', true); return { ok: false }; }
    if (on) cancel(true);
    if (G.on) boxCancel(true);
    var model = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!model) { say('Select a piece first', true); return { ok: false, reason: 'no piece' }; }
    P.on = true; P.m = model; P.sprays = 0; P.last = null; P.pre = null; P.hover = null;
    if (state.renderer) state.renderer.localClippingEnabled = true;
    gunPanel(true);
    gunReadout('—');
    say('GUN: move over the piece - the gun shows a green tick over a gap it can fill. Hold the mouse there to spray, ' +
        'let go to set. Escape puts it away.');
    P.sprayT = performance.now();
    P.raf = requestAnimationFrame(gunTick);
    gunPrepare();
    return { ok: true };
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function bind() {
    [['btn-foam', foamButton], ['btn-foam-all', fillAll], ['btn-foam-set', set], ['btn-foam-cancel', function () { cancel(); }],
     ['btn-foam-box-cancel', function () { boxCancel(); }], ['btn-foam-mode-hollow', toHollow], ['btn-foam-mode-box', toBox],
     ['btn-foam-gun', function () { gunStart(); }], ['btn-foam-gun-cancel', function () { gunCancel(); }]].forEach(function (x) {
      var e = $(x[0]);
      if (e && e.dataset.nsoWired !== '1') { e.dataset.nsoWired = '1'; e.addEventListener('click', x[1]); }
    });
    var s = $('inp-foam-level');
    if (s && s.dataset.nsoWired !== '1') {
      s.dataset.nsoWired = '1';
      s.addEventListener('input', function () { setHeight(parseFloat(s.value)); });
    }
    /* Foam's tools live in the Fill & fix card and are armed only while it is
       open: shutting it - by its summary, by another card opening, or by the
       leave-tool gesture - puts whichever is out away (sprays already set
       stay). A MutationObserver on `open`, as Brush and Carve do: it sees a
       programmatic close as well as a click. */
    var card = $('menu-fillfix');
    if (card && card.dataset.nsoFoamCardWired !== '1' && typeof MutationObserver === 'function') {
      card.dataset.nsoFoamCardWired = '1';
      new MutationObserver(function () {
        if (card.open) return;
        var was = P.on ? 'GUN' : (G.on ? 'Foam box' : (on ? 'Foam' : null));
        if (P.on) gunCancel(true);
        if (G.on) boxCancel(true);
        if (on) cancel(true);
        if (was) say(was + ' put away - the Fill & fix card was closed. ' + (was === 'Foam' ? 'Nothing changed.' : 'Sprays already set stay.'));
      }).observe(card, { attributes: true, attributeFilter: ['open'] });
    }
    if (typeof state === 'undefined' || !state.renderer || !state.renderer.domElement || state._foamBound) return;
    state._foamBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    state.renderer.domElement.addEventListener('pointerdown', boxDown, true);
    state.renderer.domElement.addEventListener('pointerdown', gunDown, true);
    state.renderer.domElement.addEventListener('pointermove', gunMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerup', boxUp);
    window.addEventListener('pointercancel', boxUp);
    window.addEventListener('pointerup', gunUp);
    window.addEventListener('pointercancel', gunUp);
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (on) cancel();
      if (G.on) boxCancel();
      if (P.on) gunCancel();
    });
  }

  /* Foam's session, for the helper registry. Undo needs no case of its own:
     tick() already puts Foam away when the piece changes under it. */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('foam', {
    live: function () { return on || G.on || P.on; },
    close: function () { cancel(); boxCancel(); gunCancel(); }
  });

  /* For the drive check and leaveTool: the same paths the controls run. */
  window.nsoFoam = {
    enter: enter, cancel: cancel, set: set, choose: choose, setHeight: setHeight, fillAll: fillAll,
    on: function () { return on; },
    info: function () {
      return on ? { chosen: chosen, height: chosen != null ? (heights[chosen] || 0) : null, spraying: spraying,
                    hollows: A.cavities.map(function (c) { return { id: c.id, volume: c.volume, height: c.height }; }),
                    readout: ($('foam-readout') || {}).textContent, preview: last,
                    up: A.frame.n.slice(), modelId: m.id } : null;
    },
    objects: function () { return { group: group, voids: voids, foam: foamObj, ring: ringObj, mesh: mesh }; },
    SPRAY_SECONDS: SPRAY_SECONDS
  };

  /* Foam's box, for the drive check and leaveTool. */
  window.nsoFoamBox = {
    start: boxStart, cancel: function () { return boxCancel(); },
    on: function () { return G.on; },
    info: function () {
      return G.on ? { spraying: G.spraying, finishing: G.finishing, amount: G.amount, sprays: G.sprays, box: G.box && { c: G.box.c.slice(), h: G.box.h.slice(), yaw: G.box.yaw },
                      readout: G.readout, last: G.last, foam: !!G.foam, modelId: G.m.id } : null;
    },
    objects: function () { return { group: G.group, foam: G.foam, mesh: G.ms }; },
    GUN_SECONDS: GUN_SECONDS
  };

  /* The GUN, for the drive check and leaveTool. */
  window.nsoFoamGun = {
    start: gunStart, cancel: function () { return gunCancel(); },
    on: function () { return P.on; },
    /* Spray as a press would: aim { point, dir } raw, held to `amount`. */
    sprayAt: function (aim, amount) { return gunSprayAt(aim, amount); },
    hoverAt: function (x, y) { return gunHoverAt(x, y); },
    cursor: function () { return P.cursor; },
    info: function () {
      return P.on ? { spraying: P.spraying, finishing: P.finishing, preparing: P.preparing, amount: P.amount, sprays: P.sprays,
                      readout: P.readout, cursor: P.cursor, prefetched: !!P.pre, glow: !!P.glow,
                      last: P.last, foam: !!P.foam, modelId: P.m.id } : null;
    },
    objects: function () { return { group: P.group, foam: P.foam, mesh: P.ms }; },
    GUN_SECONDS: GUN_SECONDS
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
