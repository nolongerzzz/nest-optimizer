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
   ============================================================ */
(function () {
  'use strict';

  var SPRAY_SECONDS = 3;          // any hollow fills in about this long
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

  function localGeo(raw, uv) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(m) : null;
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

  function disposeObj(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }

  function ghost(onOff) {
    var mats = mesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    if (onOff) {
      ghostSaved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite,
                 depthTest: mt.depthTest, wireframe: mt.wireframe };
      }) };
      mesh.userData.skipXray = true;
      mats.forEach(function (mt) {
        mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true;
        mt.wireframe = false; mt.needsUpdate = true;
      });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) {
        s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite;
        s.mt.depthTest = s.depthTest; s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
      });
      if (mesh) mesh.userData.skipXray = ghostSaved.skip;
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
      var mat = new THREE.MeshStandardMaterial({
        color: 0xffa040, emissive: 0x7a2e00, emissiveIntensity: 0.55, roughness: 0.9, metalness: 0,
        map: bubbles(), bumpMap: bubbles(), bumpScale: 0.8, transparent: true, opacity: 0.84 });
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
    if (!on || !event || event.button !== 0) return false;
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
     Wiring
     --------------------------------------------------------------- */

  function bind() {
    var b = $('btn-foam');
    if (b && b.dataset.nsoWired !== '1') {
      b.dataset.nsoWired = '1';
      b.addEventListener('click', function () { enter(); });
    }
    [['btn-foam-all', fillAll], ['btn-foam-set', set], ['btn-foam-cancel', function () { cancel(); }]].forEach(function (x) {
      var e = $(x[0]);
      if (e && e.dataset.nsoWired !== '1') { e.dataset.nsoWired = '1'; e.addEventListener('click', x[1]); }
    });
    var s = $('inp-foam-level');
    if (s && s.dataset.nsoWired !== '1') {
      s.dataset.nsoWired = '1';
      s.addEventListener('input', function () { setHeight(parseFloat(s.value)); });
    }
    if (typeof state === 'undefined' || !state.renderer || !state.renderer.domElement || state._foamBound) return;
    state._foamBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && on) cancel(); });
  }

  /* Foam's session, for the helper registry. Undo needs no case of its own:
     tick() already puts Foam away when the piece changes under it. */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('foam', {
    live: function () { return on; },
    close: function () { cancel(); }
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
