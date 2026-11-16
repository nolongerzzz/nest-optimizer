/* ============================================================
   The assembly editor - the Assemble card's "Open editor".
   docs/ASSEMBLE-EDITOR.md. After app-join.js (meshToWorldSoup,
   joinSelectedModels, NSO_recordSeat, readSeatGapInput's convention) and
   app-seat-surface.js (NSO_poseApplyWorld).

   WHY IT EXISTS. Putting one piece on another by hand was a walk round three
   cards: pick A and B on a crowded plate, Center lock or Align to get near,
   Tip to bring the right face round, Seat for the gap, Join to weld - and a
   click meant for one piece landing on its neighbour. The pieces were all
   there; the sequence was the user's to remember.

   WHAT IT IS. A stage of its own over the app: the plate's pieces and nothing
   else - no bed, no grid, no other tool's handles - spread apart so no two
   are in each other's way, on a view that turns freely. Two clicks say what
   is wanted:

     1  the face of the piece being attached
     2  the place on the other piece where it goes

   and a GHOST of the attached piece is drawn there, face to face, squared up
   to the face it sits on. The ghost follows the pointer before the second
   click, so the answer is seen before it is asked for. Then, on the ghost:
   where on the face (a 3 x 3 pad of edges, corners and centre, or where it
   was clicked), a quarter turn, a nudge, a gap. Nothing on the plate has
   moved yet. WELD INTO ONE or PLACE bakes it, as one Undo.

   WHAT IT REUSES. No new way to move or weld a piece:
     - the move is committed by NSO_poseApplyWorld, which is Seat here's own
       commit (turn baked into the raw triangles, x / z / liftY off the real
       box, position lock, paint scope);
     - the seat is recorded by NSO_recordSeat, as every Seat records it;
     - the gap has the Seat slider's range and sign: negative is an air gap,
       0 is touching, positive overlaps;
     - the weld is Complete Join (joinSelectedModels) told the pair is
       already in place, so it is the kernel union and Join's own Undo entry;
     - one press is one Undo through app-core's stepGroup, as the Join card's
       JOIN is.
   What is new is the mate itself - two picked faces brought together - and
   that is plain rigid geometry, all of it in solveMate() below.

   COORDINATES. Everything is worked out in the plate's WORLD frame, on each
   piece's world triangle soup. The stage only DRAWS a piece somewhere else
   (its `offset`, a pure translation that spreads the pieces out); a click is
   taken back through that offset before anything is measured. So the matrix
   the ghost is drawn with is, less the offset, the matrix the plate piece is
   moved by.

   PAINT SCOPE: none here. This file reads pieces and draws a ghost; the one
   write goes through NSO_poseApplyWorld, which carries Seat here's
   whole-piece rule for the piece that moves.
   ============================================================ */
(function () {
  'use strict';

  var COL_PIECE = 0x38bdf8, COL_PART = 0x4ade80, COL_TARGET = 0xfb923c, COL_GHOST = 0x4ade80;
  var BG = 0x0b1a33;
  /* Two triangles are one flat face when their normals agree to about a
     degree and they lie in one plane to a twentieth of a millimetre. */
  var FACE_COS = 0.99985, FACE_PLANE_TOL = 0.05;
  /* Pieces whose boxes come within this of each other are shown together, as
     they stand: it is wider than the widest seat gap, so a pair already
     seated is not pulled apart on the stage. */
  var CLUSTER_REACH = 0.3;
  var GAP_MIN = -0.25, GAP_MAX = 0.05, GAP_DEFAULT = -0.18;

  var root = null, R = null;     // DOM, and the renderer / scene / camera / controls
  var E = null;                  // the open session, or null
  /* The editor has MODES. 'mate' is this file: put one piece on another.
     Another tool that wants the same stage - the pieces alone, a face under
     the pointer, a ghost, one Undo - registers itself here (NSO_AsmEditor.mode)
     and is handed the stage's clicks, hovers and Escape while it is the mode
     in use. app-asm-interlock.js is the first. A mode is
       { label, title, panel(container), enter(), leave(), restart(),
         click(hit, event), hover(hit, event), clearHover(), escape() -> handled,
         pointerDown(event) -> taken, sync(), banner() -> [n, main, sub],
         tick(), info(), view() -> Box3 | null,
         solo: { title, returnTo } }
     A SOLO mode is a tool of its own that borrows the stage: it gets no tab
     on the Assemble editor, and opened on it the editor wears its title and
     shows no tabs (app-boss.js, ADD > Step / Boss). */
  var MODES = {};

  function $(id) { return document.getElementById(id); }
  function V(x, y, z) { return new THREE.Vector3(x, y, z); }
  function nameOf(piece) {
    var m = state.models.find(function (x) { return x && x.id === piece.id; });
    return (m && m.name) ? String(m.name).replace(/\.(stl|step|stp|3mf|obj)$/i, '') : ('piece ' + piece.id);
  }

  /* ---------------- DOM ---------------- */

  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    for (k in (attrs || {})) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'cls') el.className = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  function buildDom() {
    if (root) return;
    var pad = h('div', { cls: 'asm-pad', id: 'asm-pad', role: 'group', 'aria-label': 'Position on the face' });
    for (var row = 1; row >= -1; row--) {
      for (var col = -1; col <= 1; col++) {
        pad.appendChild(h('button', {
          type: 'button', cls: 'asm-pad-cell', 'data-col': col, 'data-row': row,
          title: (row === 0 && col === 0) ? 'Centre of the face'
            : ((row === 0 || col === 0) ? 'Flush with this edge, centred along it' : 'Flush into this corner'),
          'aria-label': 'Position ' + (row > 0 ? 'top' : row < 0 ? 'bottom' : 'middle') + ' ' + (col < 0 ? 'left' : col > 0 ? 'right' : 'centre')
        }));
      }
    }
    var mateBody = h('div', { cls: 'asm-ed-body', id: 'asm-mate-body' }, [
      h('button', { type: 'button', cls: 'asm-chip asm-chip-part', id: 'asm-chip-part', title: 'The face being attached. Click to pick it again.' }, [
        h('span', { cls: 'asm-chip-n', text: '1' }), h('span', { cls: 'asm-chip-text', id: 'asm-chip-part-text', text: 'Click the face to attach' })]),
      h('button', { type: 'button', cls: 'btn btn-ghost asm-under', id: 'asm-underside', text: 'Use its underside instead',
        title: 'Attach by the face this piece rests on, without turning the view to reach it' }),
      h('button', { type: 'button', cls: 'asm-chip asm-chip-target', id: 'asm-chip-target', title: 'Where it goes. Click to pick the place again.' }, [
        h('span', { cls: 'asm-chip-n', text: '2' }), h('span', { cls: 'asm-chip-text', id: 'asm-chip-target-text', text: 'Click where it goes' })]),
      h('div', { cls: 'asm-ed-adjust', id: 'asm-ed-adjust' }, [
        h('div', { cls: 'asm-ed-label', text: 'Position on the face' }),
        h('div', { cls: 'asm-ed-posrow' }, [
          pad,
          h('div', { cls: 'asm-ed-poscol' }, [
            h('button', { type: 'button', cls: 'btn btn-secondary', id: 'asm-pos-click', text: 'Where I clicked',
              title: 'Put it where the face was clicked, kept inside the face: a click near an edge lands flush with that edge' }),
            h('div', { cls: 'asm-nudge', role: 'group', 'aria-label': 'Nudge' }, [
              h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': -1, 'data-dy': 0, text: '←', title: 'Nudge left', 'aria-label': 'Nudge left' }),
              h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': 0, 'data-dy': 1, text: '↑', title: 'Nudge up', 'aria-label': 'Nudge up' }),
              h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': 0, 'data-dy': -1, text: '↓', title: 'Nudge down', 'aria-label': 'Nudge down' }),
              h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': 1, 'data-dy': 0, text: '→', title: 'Nudge right', 'aria-label': 'Nudge right' })
            ]),
            h('label', { cls: 'asm-step', title: 'How far one nudge moves it, in mm' }, [
              h('span', { text: 'step' }),
              h('input', { type: 'number', id: 'asm-nudge-step', min: '0.01', max: '50', step: '0.1', value: '1', 'aria-label': 'Nudge step in mm' }),
              h('span', { text: 'mm' })])
          ])
        ]),
        h('div', { cls: 'asm-ed-label', text: 'Turn on the face' }),
        h('div', { cls: 'asm-ed-row' }, [
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'asm-spin-l', text: '⟲ 90°', title: 'Quarter turn about the face it sits on' }),
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'asm-spin-r', text: '90° ⟳', title: 'Quarter turn about the face it sits on' })
        ]),
        h('div', { cls: 'asm-ed-gaprow' }, [
          h('label', { cls: 'asm-gap-check', title: 'Off: the two faces touch (0), and the pair can be welded. On: they are set apart or into each other by the slider.' }, [
            h('input', { type: 'checkbox', id: 'asm-gap-on' }), h('span', { text: ' gap' })]),
          h('input', { type: 'range', id: 'asm-gap', min: String(GAP_MIN), max: String(GAP_MAX), step: '0.01', value: String(GAP_DEFAULT), disabled: '',
            title: 'Gap between the two faces in mm, the Seat slider\'s range and sign: negative = air gap (easy release is -0.15 to -0.20), 0 = touching, positive = overlap.',
            'aria-label': 'Gap in mm' }),
          h('output', { id: 'asm-gap-value', 'for': 'asm-gap', text: 'touching' })
        ]),
        h('p', { cls: 'asm-ed-readout', id: 'asm-ed-readout', 'aria-live': 'polite' }),
        h('div', { cls: 'asm-ed-row' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', id: 'asm-weld', text: 'Weld into one',
            title: 'Move the piece to where the ghost is and weld the two into one solid piece. One Undo.' }),
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'asm-place', text: 'Place',
            title: 'Move the piece to where the ghost is and leave the two as separate pieces. One Undo.' })
        ])
      ])
    ]);
    var tabs = h('div', { cls: 'asm-ed-tabs', id: 'asm-ed-tabs', role: 'tablist', 'aria-label': 'Tool' }, [
      h('button', { type: 'button', cls: 'asm-tab', id: 'asm-tab-mate', role: 'tab', 'data-mode': 'mate', text: 'Mate',
        title: 'Put one piece on another: click the face to attach, click where it goes' })
    ]);
    var panel = h('div', { cls: 'asm-ed-panel', id: 'asm-ed-panel' }, [
      h('div', { cls: 'asm-ed-title', id: 'asm-ed-title', text: 'Assemble' }),
      tabs,
      mateBody,
      h('div', { cls: 'asm-ed-row asm-ed-foot' }, [
        h('button', { type: 'button', cls: 'btn btn-ghost', id: 'asm-restart', text: 'Start over', title: 'Drop both picks and begin again' }),
        h('button', { type: 'button', cls: 'btn btn-ghost', id: 'asm-undo', text: 'Undo', title: 'Undo the last step on the plate' })
      ])
    ]);
    root = h('div', { id: 'asm-editor', cls: 'asm-editor', hidden: '', role: 'dialog', 'aria-label': 'Assembly editor' }, [
      h('div', { cls: 'asm-ed-stage', id: 'asm-ed-stage' }),
      h('button', { type: 'button', cls: 'vp-bar-btn asm-ed-return', id: 'asm-return', text: '↩ Return',
        title: 'Back to the plate. Anything not welded or placed is dropped. (Escape steps back; Escape again returns.)' }),
      h('div', { cls: 'asm-ed-banner', id: 'asm-ed-banner', 'aria-live': 'polite' }),
      panel,
      h('div', { cls: 'asm-ed-keys', text: 'Drag: turn  ·  Right-drag: pan  ·  Wheel: zoom' }),
      h('div', { cls: 'asm-ed-status', id: 'asm-ed-status', role: 'status', 'aria-live': 'polite' })
    ]);
    document.body.appendChild(root);
    /* a tab and a panel body for every other mode, in the order they registered */
    var foot = panel.querySelector('.asm-ed-foot');
    Object.keys(MODES).forEach(function (name) {
      var m = MODES[name];
      if (!m.solo) tabs.appendChild(h('button', { type: 'button', cls: 'asm-tab', id: 'asm-tab-' + name, role: 'tab', 'data-mode': name,
        text: m.label || name, title: m.title || '' }));
      var body = h('div', { cls: 'asm-ed-body', id: 'asm-' + name + '-body', hidden: '' });
      panel.insertBefore(body, foot);
      if (m.panel) m.panel(body);
    });
    wireDom();
  }

  function wireDom() {
    $('asm-return').addEventListener('click', close);
    Array.prototype.forEach.call(root.querySelectorAll('.asm-tab'), function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
    });
    $('asm-restart').addEventListener('click', function () { restart(); });
    $('asm-undo').addEventListener('click', undo);
    $('asm-chip-part').addEventListener('click', function () { if (E && !E.busy && E.mode === 'mate') restart(); });
    $('asm-chip-target').addEventListener('click', function () { if (E && !E.busy && E.part) toStep('target'); });
    $('asm-underside').addEventListener('click', function () {
      if (!E || E.busy || !E.part) return;
      var f = undersideOf(E.part.face.piece);
      if (!f) { say('That piece has no flat underside - turn the view and click the face', true); return; }
      E.part = { face: f };
      if (E.step === 'adjust') { toStep('adjust'); } else toStep('target');
      say('');
    });
    $('asm-pos-click').addEventListener('click', function () {
      if (!ready()) return;
      E.anchor = { mode: 'click' }; E.nudge = { u: 0, v: 0 }; resolve();
    });
    Array.prototype.forEach.call(root.querySelectorAll('.asm-pad-cell'), function (b) {
      b.addEventListener('click', function () {
        if (!ready()) return;
        var f = padToFace(Number(b.getAttribute('data-col')), Number(b.getAttribute('data-row')));
        E.anchor = { mode: 'pad', iu: f.iu, iv: f.iv }; E.nudge = { u: 0, v: 0 }; resolve();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('.asm-nudge-btn'), function (b) {
      b.addEventListener('click', function () {
        if (!ready()) return;
        var step = Number($('asm-nudge-step').value);
        if (!(step > 0)) step = 1;
        var ax = screenAxes();
        var dx = Number(b.getAttribute('data-dx')), dy = Number(b.getAttribute('data-dy'));
        if (dx) E.nudge[ax.h.axis] += dx * ax.h.sign * step;
        if (dy) E.nudge[ax.v.axis] += dy * ax.v.sign * step;
        resolve();
      });
    });
    $('asm-spin-l').addEventListener('click', function () { if (ready()) { E.spin = (E.spin + 1) % 4; resolve(); } });
    $('asm-spin-r').addEventListener('click', function () { if (ready()) { E.spin = (E.spin + 3) % 4; resolve(); } });
    $('asm-gap-on').addEventListener('change', function () { syncPanel(); if (ready()) resolve(); });
    $('asm-gap').addEventListener('input', function () { syncPanel(); if (ready()) resolve(); });
    $('asm-weld').addEventListener('click', function () { commit(true); });
    $('asm-place').addEventListener('click', function () { commit(false); });
  }

  function ready() { return !!(E && !E.busy && E.step === 'adjust' && E.part && E.target); }

  /* The gap as asked: 0 with the box off, the slider's value with it on,
     snapped to its 0.01 step - readSeatGapInput's rule (app-join.js). */
  function gapNow() {
    if (!$('asm-gap-on').checked) return 0;
    var v = Math.round(Number($('asm-gap').value) * 100) / 100;
    if (!isFinite(v) || v < GAP_MIN - 1e-9 || v > GAP_MAX + 1e-9) return 0;
    return v;
  }
  function gapWord(g) {
    if (g < 0) return 'air gap ' + Math.abs(g).toFixed(2) + ' mm';
    if (g > 0) return 'overlap ' + g.toFixed(2) + ' mm';
    return 'touching';
  }

  /* ---------------- the stage ---------------- */

  function buildStage() {
    if (R) return;
    var stage = $('asm-ed-stage');
    var renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(BG, 1);
    stage.appendChild(renderer.domElement);
    var scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    var camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    camera.position.set(-120, 140, 200);
    /* the light rides with the view, over the right shoulder, so whichever
       way the stage is turned the three faces in sight are three shades */
    var key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(0.9, 1.6, 1);
    key.target.position.set(0, 0, -1);
    camera.add(key); camera.add(key.target);
    scene.add(camera);
    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener('end', function () { if (E) syncPad(); });
    var group = new THREE.Group();
    scene.add(group);
    R = { renderer: renderer, scene: scene, camera: camera, controls: controls, group: group,
          raycaster: new THREE.Raycaster(), dom: renderer.domElement, raf: 0 };

    var down = null;
    /* A mode may take a press for itself (dragging its ghost). It is asked in
       the capture phase, before the view's own controls hear the press, and a
       press it takes goes no further - so the view does not turn under a drag. */
    R.dom.addEventListener('pointerdown', function (e) {
      var m = E && MODES[E.mode];
      if (m && m.pointerDown && !E.busy && e.button === 0 && m.pointerDown(e)) {
        e.stopImmediatePropagation(); e.preventDefault(); down = null;
      }
    }, true);
    R.dom.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY, b: e.button }; });
    R.dom.addEventListener('pointerup', function (e) {
      var d = down; down = null;
      if (!d || d.b !== 0 || e.button !== 0) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 5) return;      // that was a turn of the view
      onClick(e);
    });
    var hoverEvt = null, hoverQueued = false;
    R.dom.addEventListener('pointermove', function (e) {
      if (down) return;                               // turning the view: no hover work
      hoverEvt = e;
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(function () { hoverQueued = false; if (E && hoverEvt) onHover(hoverEvt); });
    });
    R.dom.addEventListener('pointerleave', function () { hoverEvt = null; if (E) clearHover(); });
    R.dom.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('resize', function () { if (E) resize(); });
  }

  function resize() {
    var stage = $('asm-ed-stage');
    var w = stage.clientWidth || window.innerWidth, hh = stage.clientHeight || window.innerHeight;
    R.renderer.setSize(w, hh, false);
    R.camera.aspect = w / Math.max(1, hh);
    R.camera.updateProjectionMatrix();
  }

  function tick() {
    if (!E) { R.raf = 0; return; }
    R.controls.update();
    R.renderer.render(R.scene, R.camera);
    var m = MODES[E.mode];
    if (m && m.tick) m.tick();
    R.raf = requestAnimationFrame(tick);
  }

  function frameBox(box, keepDir) {
    if (box.isEmpty()) return;
    var c = box.getCenter(V(0, 0, 0)), size = box.getSize(V(0, 0, 0));
    var r = Math.max(5, size.length() / 2);
    var dir = keepDir ? R.camera.position.clone().sub(R.controls.target) : V(-0.55, 0.62, 0.75);
    if (dir.lengthSq() < 1e-9) dir.set(-0.55, 0.62, 0.75);
    dir.normalize();
    var fov = R.camera.fov * Math.PI / 180;
    var fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * R.camera.aspect));
    /* the panel takes the right of the stage, so leave a little more room */
    var dist = r / Math.sin(fit / 2) * 1.25;
    R.controls.target.copy(c);
    R.camera.position.copy(c).addScaledVector(dir, dist);
    R.camera.near = Math.max(0.1, dist / 500);
    R.camera.far = dist * 20 + 2000;
    R.camera.updateProjectionMatrix();
    R.controls.update();
  }

  /* ---------------- the pieces ---------------- */

  function disposeObj(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    o.traverse(function (c) {
      if (c.geometry && !c.userData.sharedGeometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });
  }

  function clearPieces() {
    if (!E) return;
    (E.pieces || []).forEach(function (p) { disposeObj(p.mesh); p.geo.dispose(); });
    E.pieces = [];
    ['hoverMark', 'partMark', 'targetMark', 'ghost'].forEach(function (k) { disposeObj(E[k]); E[k] = null; });
    E.hoverFace = null;
  }

  /* Every piece on the plate, as its world soup, and where the stage draws
     it. Pieces that stand together on the plate (boxes within CLUSTER_REACH)
     stay together; the groups are set out in a row, left to right as they lie
     on the plate, with clear air between them. */
  function buildPieces() {
    clearPieces();
    var list = [];
    state.placed.forEach(function (pl) {
      if (!pl || !pl.mesh || pl.sourceId == null) return;
      var src = state.models.find(function (x) { return x && x.id === pl.sourceId; });
      if (!src || src.nsoSupport) return;                  // generated supports are not pieces to assemble
      pl.mesh.updateMatrixWorld(true);
      var soup = meshToWorldSoup(pl.mesh);
      if (!soup || soup.length < 9) return;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(soup, 3));
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: COL_PIECE, metalness: 0.05, roughness: 0.45, emissive: 0x0a3a5c, emissiveIntensity: 0.22 }));
      mesh.userData.sharedGeometry = true;
      var piece = { id: pl.sourceId, placed: pl, soup: soup, geo: geo, mesh: mesh, box: geo.boundingBox.clone(),
                    offset: V(0, 0, 0), triN: null, triD: null, faces: [], faceOfTri: null };
      mesh.userData.piece = piece;
      list.push(piece);
    });
    /* groups of pieces that stand together */
    var parent = list.map(function (_, i) { return i; });
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    /* A mode that works on the faces BETWEEN seated pieces asks for every
       piece on its own (E.apart), so those faces can be clicked. */
    for (var i = 0; !E.apart && i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
      var a = list[i].box, b = list[j].box, r = CLUSTER_REACH;
      if (a.min.x - r <= b.max.x && b.min.x - r <= a.max.x && a.min.y - r <= b.max.y && b.min.y - r <= a.max.y &&
          a.min.z - r <= b.max.z && b.min.z - r <= a.max.z) parent[find(i)] = find(j);
    }
    if (E.together) list.forEach(function (_, k) { parent[find(k)] = find(0); });
    var groups = {};
    list.forEach(function (p, k) {
      var g = find(k);
      if (!groups[g]) groups[g] = { box: new THREE.Box3(), pieces: [] };
      groups[g].box.union(p.box); groups[g].pieces.push(p);
    });
    var gl = Object.keys(groups).map(function (k) { return groups[k]; });
    gl.sort(function (x, y) { return (x.box.min.x + x.box.max.x) - (y.box.min.x + y.box.max.x) || (x.box.min.z - y.box.min.z); });
    var biggest = 0;
    gl.forEach(function (g) { var s = g.box.getSize(V(0, 0, 0)); biggest = Math.max(biggest, s.x, s.z); });
    var air = Math.max(12, biggest * 0.3), cursor = 0;
    gl.forEach(function (g) {
      var s = g.box.getSize(V(0, 0, 0));
      var off = V(cursor - g.box.min.x, -g.box.min.y, -(g.box.min.z + g.box.max.z) / 2);
      g.pieces.forEach(function (p) { p.offset.copy(off); p.mesh.position.copy(off); R.group.add(p.mesh); });
      cursor += s.x + air;
    });
    E.pieces = list;
  }

  function stageBox(pieces) {
    var box = new THREE.Box3();
    pieces.forEach(function (p) { if (p.mesh.visible) box.union(p.box.clone().translate(p.offset)); });
    return box;
  }

  /* ---------------- faces ---------------- */

  function triData(piece) {
    if (piece.triN) return;
    var s = piece.soup, n = s.length / 9, N = new Float32Array(n * 3), D = new Float32Array(n);
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var ax = s[o + 3] - s[o], ay = s[o + 4] - s[o + 1], az = s[o + 5] - s[o + 2];
      var bx = s[o + 6] - s[o], by = s[o + 7] - s[o + 1], bz = s[o + 8] - s[o + 2];
      var nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (L > 1e-12) { nx /= L; ny /= L; nz /= L; } else { nx = ny = nz = 0; }
      N[t * 3] = nx; N[t * 3 + 1] = ny; N[t * 3 + 2] = nz;
      D[t] = nx * s[o] + ny * s[o + 1] + nz * s[o + 2];
    }
    piece.triN = N; piece.triD = D;
    piece.faceOfTri = new Int32Array(n).fill(-1);
  }

  /* The flat face a triangle belongs to: every triangle of the piece in the
     same plane, facing the same way. All of them, joined or not - the two
     feet of a channel are one face to stand it on. */
  function faceOf(piece, tri) {
    triData(piece);
    if (piece.faceOfTri[tri] >= 0) return piece.faces[piece.faceOfTri[tri]];
    var N = piece.triN, D = piece.triD, s = piece.soup, n = D.length;
    var nx = N[tri * 3], ny = N[tri * 3 + 1], nz = N[tri * 3 + 2], d = D[tri];
    if (nx === 0 && ny === 0 && nz === 0) return null;
    var tris = [], t;
    for (t = 0; t < n; t++) {
      if (N[t * 3] * nx + N[t * 3 + 1] * ny + N[t * 3 + 2] * nz < FACE_COS) continue;
      var o = t * 9;
      var cd = nx * (s[o] + s[o + 3] + s[o + 6]) / 3 + ny * (s[o + 1] + s[o + 4] + s[o + 7]) / 3 + nz * (s[o + 2] + s[o + 5] + s[o + 8]) / 3;
      if (Math.abs(cd - d) > FACE_PLANE_TOL) continue;
      tris.push(t);
    }
    var normal = V(nx, ny, nz), pts = [], k;
    for (k = 0; k < tris.length; k++) {
      var q = tris[k] * 9;
      pts.push(V(s[q], s[q + 1], s[q + 2]), V(s[q + 3], s[q + 4], s[q + 5]), V(s[q + 6], s[q + 7], s[q + 8]));
    }
    var face = { piece: piece, id: piece.faces.length, n: normal, d: d, tris: tris, pts: pts, frame: null };
    face.frame = faceFrame(face);
    for (k = 0; k < tris.length; k++) piece.faceOfTri[tris[k]] = face.id;
    piece.faces.push(face);
    return face;
  }

  /* A fallback in-plane direction for a normal: the world axis least along it. */
  function anyTangent(n) {
    var ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    var e = (ax <= az && ax <= ay) ? V(1, 0, 0) : (az <= ay ? V(0, 0, 1) : V(0, 1, 0));
    return e.addScaledVector(n, -e.dot(n)).normalize();
  }

  function extent(pts, u, v) {
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i].dot(u), b = pts[i].dot(v);
      if (a < u0) u0 = a; if (a > u1) u1 = a;
      if (b < v0) v0 = b; if (b > v1) v1 = b;
    }
    return { u0: u0, u1: u1, v0: v0, v1: v1 };
  }

  /* The face's own rectangle: the in-plane pair of directions (u, v = n x u)
     whose bounding rectangle of the face is smallest. The candidates are the
     directions of the face's own longest edges, so a rectangular face turned
     any way on the plate still reads as that rectangle, and the pad's "flush
     with this edge" means the face's edge. */
  function faceFrame(face) {
    var pts = face.pts, n = face.n, buckets = {}, i, k;
    for (i = 0; i < pts.length; i += 3) {
      for (k = 0; k < 3; k++) {
        var e = pts[i + (k + 1) % 3].clone().sub(pts[i + k]);
        var L = e.length();
        if (L < 1e-6) continue;
        e.multiplyScalar(1 / L);
        var t0 = anyTangent(n), t1 = n.clone().cross(t0);
        var ang = Math.atan2(e.dot(t1), e.dot(t0));
        ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);          // a rectangle repeats every quarter turn
        var key = Math.round(ang * 180 / Math.PI * 2);                         // half-degree buckets
        if (key === 180) key = 0;
        if (!buckets[key]) buckets[key] = { len: 0, ang: ang };
        buckets[key].len += L;
      }
    }
    var cands = Object.keys(buckets).map(function (q) { return buckets[q]; })
      .sort(function (a, b) { return b.len - a.len; }).slice(0, 24);
    cands.push({ ang: 0, len: 0 });
    var best = null, t0b = anyTangent(n), t1b = n.clone().cross(t0b);
    cands.forEach(function (c) {
      var u = t0b.clone().multiplyScalar(Math.cos(c.ang)).addScaledVector(t1b, Math.sin(c.ang)).normalize();
      var v = n.clone().cross(u).normalize();
      var x = extent(pts, u, v), area = (x.u1 - x.u0) * (x.v1 - x.v0);
      if (!best || area < best.area - 1e-9) best = { u: u, v: v, x: x, area: area };
    });
    return { u: best.u, v: best.v, u0: best.x.u0, u1: best.x.u1, v0: best.x.v0, v1: best.x.v1 };
  }

  /* The flat face a piece rests on: its lowest downward-looking face. */
  function undersideOf(piece) {
    triData(piece);
    var N = piece.triN, s = piece.soup, best = -1, bestY = Infinity;
    for (var t = 0; t < N.length / 3; t++) {
      if (N[t * 3 + 1] > -0.98) continue;
      var y = (s[t * 9 + 1] + s[t * 9 + 4] + s[t * 9 + 7]) / 3;
      if (y < bestY - 1e-6) { bestY = y; best = t; }
    }
    return best < 0 ? null : faceOf(piece, best);
  }

  function faceWord(face) {
    var n = face.n;
    if (n.y > 0.98) return 'top face';
    if (n.y < -0.98) return 'underside';
    if (Math.abs(n.y) < 0.2) return 'side face';
    return 'sloped face';
  }

  function markFor(face, color, opacity) {
    var arr = new Float32Array(face.pts.length * 3);
    face.pts.forEach(function (p, i) { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: opacity, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.position.copy(face.piece.offset);
    m.renderOrder = 2;
    R.group.add(m);
    return m;
  }

  /* ---------------- picking ---------------- */

  function hitAt(e) {
    var rect = R.dom.getBoundingClientRect();
    var p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    R.raycaster.setFromCamera(p, R.camera);
    var meshes = E.pieces.filter(function (q) { return q.mesh.visible; }).map(function (q) { return q.mesh; });
    var hits = R.raycaster.intersectObjects(meshes, false);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null) continue;
      var piece = hits[i].object.userData.piece;
      var face = faceOf(piece, hits[i].faceIndex);
      if (!face) continue;
      return { piece: piece, face: face, point: hits[i].point.clone().sub(piece.offset) };   // world, not stage
    }
    return null;
  }

  function clearHover() {
    if (!E) return;
    if (E.mode !== 'mate') { if (MODES[E.mode].clearHover) MODES[E.mode].clearHover(); R.dom.style.cursor = ''; return; }
    disposeObj(E.hoverMark); E.hoverMark = null; E.hoverFace = null;
    if (E.step === 'target' && E.ghost) E.ghost.visible = false;
    R.dom.style.cursor = '';
  }

  function onHover(e) {
    if (!E || E.busy) return;
    var hit = hitAt(e);
    if (E.mode !== 'mate') { if (MODES[E.mode].hover) MODES[E.mode].hover(hit, e); return; }
    if (E.step === 'adjust') {
      R.dom.style.cursor = (hit && hit.piece === E.target.face.piece) ? 'crosshair' : '';
      return;
    }
    if (!hit || (E.step === 'target' && hit.piece === E.part.face.piece)) {
      /* over the attached piece itself in step 2: its face can be re-picked, so light it as step 1 would */
      if (hit && E.step === 'target') {
        if (E.ghost) E.ghost.visible = false;
        if (E.hoverFace !== hit.face) { disposeObj(E.hoverMark); E.hoverMark = markFor(hit.face, COL_PART, 0.35); E.hoverFace = hit.face; }
        R.dom.style.cursor = 'pointer';
        return;
      }
      clearHover();
      return;
    }
    R.dom.style.cursor = 'pointer';
    if (E.hoverFace !== hit.face) {
      disposeObj(E.hoverMark);
      E.hoverMark = markFor(hit.face, E.step === 'part' ? COL_PART : COL_TARGET, 0.45);
      E.hoverFace = hit.face;
    }
    if (E.step === 'target') {
      var sol = solveMate(E.part.face, hit.face, hit.point, 0, { mode: 'click' }, { u: 0, v: 0 }, gapNow());
      showGhost(sol, hit.face.piece);
    }
  }

  function onClick(e) {
    if (!E || E.busy) return;
    var hit = hitAt(e);
    if (E.mode !== 'mate') { if (MODES[E.mode].click) MODES[E.mode].click(hit, e); return; }
    if (!hit) return;
    if (E.step === 'part' || (E.step === 'target' && hit.piece === E.part.face.piece)) {
      E.part = { face: hit.face };
      toStep('target');
      return;
    }
    if (E.step === 'target' || (E.step === 'adjust' && hit.piece === E.target.face.piece)) {
      E.target = { face: hit.face, point: hit.point };
      E.anchor = { mode: 'click' }; E.nudge = { u: 0, v: 0 };
      if (E.step === 'target') E.spin = 0;
      toStep('adjust');
    }
  }

  /* ---------------- the mate ---------------- */

  /* Part face onto target face. Returns the WORLD matrix that takes the part
     from where it is to where it mates, and what it found on the way.

     turn    the part's face normal onto the reverse of the target's - the
             shortest turn, and for a face already looking the other way a
             half turn about the target face's own long edge;
     square  then about the target's normal by the least angle that lays the
             part face's rectangle parallel to the target face's, plus `spin`
             quarter turns;
     place   the part face's rectangle on the target face's: where it was
             clicked (kept inside the face when it fits, centred across when
             it does not), or an edge / corner / centre off the pad; then the
             nudge;
     gap     off the target's plane by -gap along its normal (the Seat sign:
             negative is air). */
  function solveMate(fb, fa, point, spin, anchor, nudge, gap) {
    var nA = fa.n, nB = fb.n, back = nA.clone().negate();
    var q0 = new THREE.Quaternion();
    if (nB.dot(back) < -0.999999) q0.setFromAxisAngle(fa.frame.u, Math.PI);
    else q0.setFromUnitVectors(nB, back);
    var uA = fa.frame.u, vA = fa.frame.v;
    var ub = fb.frame.u.clone().applyQuaternion(q0);
    var theta = Math.atan2(ub.dot(vA), ub.dot(uA));
    var snap = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2) - theta;
    var q1 = new THREE.Quaternion().setFromAxisAngle(nA, snap + (spin || 0) * Math.PI / 2);
    var q = q1.multiply(q0);

    /* pivot: the middle of the part face's own rectangle */
    var fr = fb.frame;
    var pivot = fr.u.clone().multiplyScalar((fr.u0 + fr.u1) / 2).addScaledVector(fr.v, (fr.v0 + fr.v1) / 2).addScaledVector(nB, fb.d);
    var turned = fb.pts.map(function (p) { return p.clone().sub(pivot).applyQuaternion(q).add(pivot); });
    var xb = extent(turned, uA, vA);
    var wB = xb.u1 - xb.u0, hB = xb.v1 - xb.v0, wA = fa.frame.u1 - fa.frame.u0, hA = fa.frame.v1 - fa.frame.v0;
    function along(lo, hi, size, sizeB, mode, i, clicked) {
      var mid = (lo + hi) / 2;
      if (mode === 'pad') return i < 0 ? lo + sizeB / 2 : (i > 0 ? hi - sizeB / 2 : mid);
      if (sizeB >= size - 1e-6) return mid;                     // no room to slide: centred
      return Math.min(hi - sizeB / 2, Math.max(lo + sizeB / 2, clicked));
    }
    var cu = along(fa.frame.u0, fa.frame.u1, wA, wB, anchor.mode, anchor.iu, point.dot(uA)) + (nudge.u || 0);
    var cv = along(fa.frame.v0, fa.frame.v1, hA, hB, anchor.mode, anchor.iv, point.dot(vA)) + (nudge.v || 0);
    var move = uA.clone().multiplyScalar(cu - (xb.u0 + xb.u1) / 2)
      .addScaledVector(vA, cv - (xb.v0 + xb.v1) / 2)
      .addScaledVector(nA, (fa.d - gap) - pivot.dot(nA));
    var M = new THREE.Matrix4().makeTranslation(pivot.x + move.x, pivot.y + move.y, pivot.z + move.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    /* what the two faces share once mated: the overlap of the two rectangles */
    var ou = Math.min(fa.frame.u1, cu + wB / 2) - Math.max(fa.frame.u0, cu - wB / 2);
    var ov = Math.min(fa.frame.v1, cv + hB / 2) - Math.max(fa.frame.v0, cv - hB / 2);
    return { matrix: M, gap: gap, contactU: Math.max(0, ou), contactV: Math.max(0, ov), partW: wB, partH: hB,
             overhang: (ou < wB - 1e-4) || (ov < hB - 1e-4),
             turnDeg: 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI };
  }

  function showGhost(sol, targetPiece) {
    var part = E.part.face.piece;
    if (!E.ghost) {
      var g = new THREE.Group();
      var body = new THREE.Mesh(part.geo, new THREE.MeshStandardMaterial({
        color: COL_GHOST, transparent: true, opacity: 0.5, depthWrite: false, metalness: 0, roughness: 0.6,
        emissive: 0x14532d, emissiveIntensity: 0.35 }));
      body.userData.sharedGeometry = true;
      g.add(body);
      if (part.soup.length / 9 <= 60000) {
        g.add(new THREE.LineSegments(new THREE.EdgesGeometry(part.geo, 30),
          new THREE.LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.9 })));
      }
      g.matrixAutoUpdate = false;
      g.renderOrder = 3;
      R.group.add(g);
      E.ghost = g;
    }
    E.ghost.visible = true;
    E.ghost.matrix.copy(new THREE.Matrix4().makeTranslation(targetPiece.offset.x, targetPiece.offset.y, targetPiece.offset.z).multiply(sol.matrix));
    E.ghost.matrixWorldNeedsUpdate = true;
  }

  function resolve() {
    if (!E || !E.part || !E.target) return;
    E.solution = solveMate(E.part.face, E.target.face, E.target.point, E.spin, E.anchor, E.nudge, gapNow());
    E.solution.sink = sinkOf(E.part.face.piece, E.target.face, E.solution);
    showGhost(E.solution, E.target.face.piece);
    syncPanel();
  }

  /* How far the mated piece reaches past the face it sits on, in mm. The mate
     brings the two PICKED faces together and says nothing of the rest of the
     piece: a face picked in a recess leaves whatever stands proud of it inside
     the other piece. That can be what is wanted (a boss into a hole), so it is
     measured and said, not refused. Beyond the asked-for overlap only. */
  function sinkOf(piece, fa, sol) {
    var s = piece.soup, e = sol.matrix.elements, n = fa.n, lo = Infinity;
    /* n . (M p) = (M^T n) . p + n . t : one dot product a vertex */
    var ax = n.x * e[0] + n.y * e[1] + n.z * e[2], ay = n.x * e[4] + n.y * e[5] + n.z * e[6],
        az = n.x * e[8] + n.y * e[9] + n.z * e[10], at = n.x * e[12] + n.y * e[13] + n.z * e[14];
    for (var i = 0; i < s.length; i += 3) {
      var d = ax * s[i] + ay * s[i + 1] + az * s[i + 2] + at;
      if (d < lo) lo = d;
    }
    var past = (fa.d - Math.max(0, sol.gap)) - lo;
    return past > 1e-3 ? past : 0;
  }

  /* ---------------- the pad, as the view has it ---------------- */

  /* Which of the target face's two directions runs across the screen and
     which up it, and with which sign, for the view as it is now. The pad and
     the nudge arrows are read through this, so "top right" is the corner that
     is top right on the screen. */
  function screenAxes() {
    var f = E.target.face.frame;
    var right = V(1, 0, 0).applyQuaternion(R.camera.quaternion), up = V(0, 1, 0).applyQuaternion(R.camera.quaternion);
    var ur = f.u.dot(right), vr = f.v.dot(right), uu = f.u.dot(up), vu = f.v.dot(up);
    var sg = function (x) { return x < 0 ? -1 : 1; };
    if (Math.abs(ur) >= Math.abs(vr)) return { h: { axis: 'u', sign: sg(ur) }, v: { axis: 'v', sign: sg(vu) } };
    return { h: { axis: 'v', sign: sg(vr) }, v: { axis: 'u', sign: sg(uu) } };
  }
  function padToFace(col, row) {
    var ax = screenAxes(), out = { iu: 0, iv: 0 };
    out['i' + ax.h.axis] = col * ax.h.sign;
    out['i' + ax.v.axis] = row * ax.v.sign;
    return out;
  }
  function syncPad() {
    if (!root) return;
    var live = !!(E && E.step === 'adjust' && E.target);
    Array.prototype.forEach.call(root.querySelectorAll('.asm-pad-cell'), function (b) {
      var on = false;
      if (live && E.anchor.mode === 'pad' && !E.nudge.u && !E.nudge.v) {
        var f = padToFace(Number(b.getAttribute('data-col')), Number(b.getAttribute('data-row')));
        on = (f.iu === E.anchor.iu && f.iv === E.anchor.iv);
      }
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var pc = $('asm-pos-click');
    if (pc) pc.classList.toggle('is-on', live && E.anchor.mode === 'click' && !E.nudge.u && !E.nudge.v);
  }

  /* ---------------- steps and the panel ---------------- */

  var BANNER = {
    part: ['1', 'Click the face to attach', 'on the piece being put on - turn the view to reach a hidden face'],
    target: ['2', 'Click where it goes', 'on the other piece - the ghost shows it'],
    adjust: ['3', 'Set it, then Weld or Place', 'click the face again to move it']
  };

  function say(msg, bad) {
    var s = $('asm-ed-status');
    if (s) { s.textContent = msg || ''; s.classList.toggle('is-bad', !!bad); }
  }

  function toStep(step) {
    E.step = step;
    clearHover();
    if (step === 'part') {
      E.part = null; E.target = null; E.solution = null;
      disposeObj(E.partMark); E.partMark = null;
    }
    if (step !== 'adjust') {
      E.target = (step === 'target') ? null : E.target;
      E.solution = null;
      disposeObj(E.targetMark); E.targetMark = null;
      disposeObj(E.ghost); E.ghost = null;
      E.pieces.forEach(function (p) { p.mesh.visible = true; });
    }
    if (step === 'target') {
      disposeObj(E.partMark);
      E.partMark = markFor(E.part.face, COL_PART, 0.6);
    }
    if (step === 'adjust') {
      /* only the pair: the piece it goes on, and the ghost of the one going on */
      var tp = E.target.face.piece, pp = E.part.face.piece;
      E.pieces.forEach(function (p) { p.mesh.visible = (p === tp); });
      disposeObj(E.partMark); E.partMark = null;
      disposeObj(E.targetMark);
      E.targetMark = markFor(E.target.face, COL_TARGET, 0.28);
      resolve();
      var box = tp.box.clone().translate(tp.offset);
      box.union(pp.box.clone().applyMatrix4(E.ghost.matrix));
      frameBox(box, true);
    }
    E.pieces.forEach(function (p) {
      var isPart = !!(E.part && p === E.part.face.piece), isTarget = !!(E.target && p === E.target.face.piece);
      p.mesh.material.color.setHex(isTarget ? COL_TARGET : (isPart ? COL_PART : COL_PIECE));
      p.mesh.material.emissive.setHex(isTarget ? 0x4a2a0c : (isPart ? 0x14532d : 0x0a3a5c));
    });
    syncPanel();
  }

  function syncPanel() {
    if (!E) return;
    Array.prototype.forEach.call(root.querySelectorAll('.asm-tab'), function (t) {
      var on = t.getAttribute('data-mode') === E.mode;
      t.classList.toggle('is-on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.disabled = !!E.busy;
    });
    Array.prototype.forEach.call(root.querySelectorAll('.asm-ed-body'), function (d) { d.hidden = d.id !== 'asm-' + E.mode + '-body'; });
    var solo = E.mode !== 'mate' && MODES[E.mode].solo;
    $('asm-ed-tabs').hidden = !!solo;
    $('asm-ed-title').textContent = solo ? solo.title : 'Assemble';
    root.setAttribute('aria-label', solo ? solo.title + ' editor' : 'Assembly editor');
    $('asm-undo').disabled = !!E.busy || !(state.undoStack && state.undoStack.length);
    if (E.mode !== 'mate') {
      var mm = MODES[E.mode], mb = mm.banner ? mm.banner() : ['', '', ''], bn = $('asm-ed-banner');
      bn.innerHTML = '';
      if (mb[0]) bn.appendChild(h('span', { cls: 'asm-ed-banner-n', text: mb[0] }));
      bn.appendChild(h('span', { cls: 'asm-ed-banner-main', text: mb[1] }));
      bn.appendChild(h('span', { cls: 'asm-ed-banner-sub', text: mb[2] }));
      $('asm-restart').disabled = !!E.busy;
      if (mm.sync) mm.sync();
      return;
    }
    var b = BANNER[E.step], banner = $('asm-ed-banner');
    banner.innerHTML = '';
    banner.appendChild(h('span', { cls: 'asm-ed-banner-n', text: b[0] }));
    banner.appendChild(h('span', { cls: 'asm-ed-banner-main', text: b[1] }));
    banner.appendChild(h('span', { cls: 'asm-ed-banner-sub', text: b[2] }));
    if (E.pieces.length < 2) {
      banner.innerHTML = '';
      banner.appendChild(h('span', { cls: 'asm-ed-banner-main', text: 'Two pieces are needed' }));
      banner.appendChild(h('span', { cls: 'asm-ed-banner-sub', text: 'put another piece on the plate, then open the editor again' }));
    }
    $('asm-chip-part-text').textContent = E.part ? (nameOf(E.part.face.piece) + ' · ' + faceWord(E.part.face)) : 'Click the face to attach';
    $('asm-chip-target-text').textContent = E.target ? (nameOf(E.target.face.piece) + ' · ' + faceWord(E.target.face)) : 'Click where it goes';
    $('asm-chip-part').classList.toggle('is-set', !!E.part);
    $('asm-chip-part').classList.toggle('is-now', E.step === 'part');
    $('asm-chip-target').classList.toggle('is-set', !!E.target);
    $('asm-chip-target').classList.toggle('is-now', E.step === 'target');
    var under = $('asm-underside');
    under.hidden = !E.part || E.part.face.n.y < -0.98;
    under.disabled = !!E.busy;
    var live = E.step === 'adjust' && !E.busy;
    var adj = $('asm-ed-adjust');
    adj.classList.toggle('is-idle', !live);
    Array.prototype.forEach.call(adj.querySelectorAll('button, input'), function (el) { el.disabled = !live; });
    var gapOn = $('asm-gap-on').checked, g = gapNow();
    $('asm-gap').disabled = !(live && gapOn);
    $('asm-gap-value').textContent = gapOn ? (g.toFixed(2) + ' mm') : 'touching';
    /* An air gap leaves two pieces by definition, so there is nothing to weld. */
    var weld = $('asm-weld');
    weld.disabled = !live || g < 0;
    weld.title = (g < 0)
      ? 'An air gap keeps the two apart, so they stay two pieces: Place them, or turn the gap off to weld.'
      : 'Move the piece to where the ghost is and weld the two into one solid piece. One Undo.';
    var out = $('asm-ed-readout');
    if (E.step === 'adjust' && E.solution) {
      var s = E.solution;
      out.textContent = nameOf(E.part.face.piece) + ' on ' + nameOf(E.target.face.piece) + ' · ' + gapWord(s.gap) +
        ' · faces share ' + s.contactU.toFixed(1) + ' × ' + s.contactV.toFixed(1) + ' mm' +
        (s.overhang ? ' · hangs over the edge' : '') +
        (s.sink ? ' · ' + s.sink.toFixed(2) + ' mm of it stands past the picked face, into the other piece' : '');
    } else out.textContent = '';
    $('asm-undo').disabled = !!E.busy || !(state.undoStack && state.undoStack.length);
    $('asm-restart').disabled = !!E.busy || E.step === 'part';
    syncPad();
  }

  function restart(keepStatus) {
    if (!E) return;
    if (E.mode !== 'mate') {
      MODES[E.mode].restart();
      frameBox(stageBox(E.pieces), true);
      if (!keepStatus) say('');
      syncPanel();
      return;
    }
    toStep('part');
    frameBox(stageBox(E.pieces), true);
    if (!keepStatus) say('');
  }

  /* One mode out, another in: the stage is rebuilt for the new one (the mate
     keeps seated pieces together, another mode may want them apart) and it
     starts from its first step. Sizes typed into a mode's panel stay. */
  function setMode(name) {
    if (!E || E.busy || name === E.mode || (name !== 'mate' && !MODES[name])) return;
    E.opener = name;
    if (E.mode === 'mate') toStep('part');
    else if (MODES[E.mode].leave) MODES[E.mode].leave();
    E.mode = name;
    E.apart = name !== 'mate' && !!MODES[name].apart;
    /* A mode that works ACROSS pieces (Draw > Connect: one drawing welded into
       two of them) asks for the plate as it stands - every piece where it is. */
    E.together = name !== 'mate' && !!MODES[name].asPlaced;
    buildPieces();
    if (name === 'mate') toStep('part');
    else if (MODES[name].enter) MODES[name].enter();
    frameBox(stageBox(E.pieces), true);
    say('');
    syncPanel();
  }

  /* ---------------- bake ---------------- */

  /* Run fn with a fresh undo stack and put what it pushed back as ONE entry -
     app-join-triple.js's asOneStep, for a body that awaits. */
  async function asOneStep(label, fn) {
    var outer = state.undoStack;
    state.undoStack = [];
    try { return await fn(); }
    finally {
      var steps = state.undoStack;
      state.undoStack = outer;
      if (steps.length === 1) pushUndo(steps[0]);
      else if (steps.length > 1) pushUndo({ type: 'stepGroup', steps: steps, label: label });
      else if (typeof updateUndoBtn === 'function') updateUndoBtn();
    }
  }

  function appStatus() { var s = $('status'); return s ? s.textContent : ''; }

  async function commit(weld) {
    if (!ready() || !E.solution) return false;
    var sol = E.solution, tp = E.target.face.piece, pp = E.part.face.piece;
    var A = tp.placed, B = pp.placed, nameA = nameOf(tp), nameB = nameOf(pp);
    if (weld && sol.gap < 0) { say('An air gap keeps them two pieces - Place them, or turn the gap off to weld', true); return false; }
    E.busy = true; syncPanel();
    say(weld ? 'Welding…' : 'Placing…');
    var result = { ok: false, placed: false, welded: false, reason: '' };
    try {
      await asOneStep(weld ? 'Undo: Assemble (weld) reverted' : 'Undo: Assemble (place) reverted', async function () {
        var M = sol.matrix.clone();
        /* The piece it goes on, onto the bed baseline first, the way every Seat
           does it (a piece that was dropped and never moved rests 0.1 mm higher
           than a settled one, and liftY is measured from the settled baseline).
           Settling only moves a piece in y, so the same delta carries the mate. */
        A.mesh.updateMatrixWorld(true);
        var yWas = A.mesh.position.y;
        if (typeof settlePlacedOnBed === 'function') settlePlacedOnBed(A);
        A.mesh.updateMatrixWorld(true);
        var dy = A.mesh.position.y - yWas;
        if (dy) M = new THREE.Matrix4().makeTranslation(0, dy, 0).multiply(M);
        var r = NSO_poseApplyWorld(B, M.elements, { verb: 'Assemble', b: nameB });
        if (!r.ok && r.reason === 'below the plate') {
          /* The mate hangs the piece below the bed. Nothing can sit there, so
             the piece it goes on is raised by exactly that much and the mate
             is made at the new height - the pair as the ghost showed it. */
          var below = r.below;
          if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(A, 'Assemble')) {
            result.reason = nameA + ' is locked, and this mate needs it raised ' + below.toFixed(2) + ' mm to keep ' + nameB + ' above the plate';
            return;
          }
          pushUndo(snapshotPlacedPose(state.placed.indexOf(A)));
          A.liftY = (A.liftY || 0) + below;
          applyPlacedXZ(A, A.x, A.z);
          if (typeof refreshOutline === 'function') refreshOutline(A);
          A.mesh.updateMatrixWorld(true);
          M = new THREE.Matrix4().makeTranslation(0, below, 0).multiply(M);
          r = NSO_poseApplyWorld(B, M.elements, { verb: 'Assemble', b: nameB });
          result.raised = r.ok ? below : 0;
        }
        if (!r.ok) { result.reason = r.reason || 'the piece could not be moved'; return; }
        result.placed = true;
        if (typeof NSO_recordSeat === 'function') {
          NSO_recordSeat(B, A, { gap: sol.gap, kind: 'support', measured: sol.gap, reference: 'face' });
        }
        if (!weld) { result.ok = true; return; }
        /* Complete Join on the pair, in place: its own kernel union, its own
           Undo entry. It reads the pair off the Join slots, so the slots are
           the argument. */
        state.joinSession = true; state.joinArmed = null;
        state.editId = A.sourceId; state.joinPartnerId = B.sourceId;
        state.joinThirdId = null;
        var joined = false;
        try { joined = (await joinSelectedModels({ inPlace: true })) === true; }
        catch (err) { console.error('[assemble] weld', err); }
        if (!joined) {
          result.reason = appStatus() || 'the weld did not go through';
          state.joinSession = false; state.joinPartnerId = null; state.joinArmed = null;
          if (typeof updateJoinUI === 'function') updateJoinUI();
          return;
        }
        result.welded = true; result.ok = true;
      });
    } catch (err) {
      console.error('[assemble]', err);
      result.reason = (err && err.message) || String(err);
    }
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    E.busy = false;
    var msg, bad = false;
    if (result.welded) msg = nameB + ' welded onto ' + nameA + ' - one piece. Attach another, or Return.';
    else if (result.ok) msg = nameB + ' placed on ' + nameA + ' - ' + gapWord(sol.gap) + '. Attach another, or Return.';
    else if (result.placed) { msg = nameB + ' is placed on ' + nameA + ', but not welded - ' + result.reason; bad = true; }
    else { msg = 'Nothing moved - ' + (result.reason && result.reason !== 'position lock' && result.reason !== 'painted' ? result.reason : appStatus()); bad = true; }
    if (result.raised) msg += ' (' + nameA + ' raised ' + result.raised.toFixed(2) + ' mm so nothing sits under the plate)';
    if (typeof setStatus === 'function' && (result.ok || result.placed)) setStatus('Assemble: ' + msg.replace(/ Attach another, or Return\.$/, ''), bad);
    E.last = result;
    if (result.placed) { buildPieces(); restart(true); }
    else syncPanel();
    say(msg, bad);
    return result.ok;
  }

  function undo() {
    if (!E || E.busy) return;
    if (!(state.undoStack && state.undoStack.length)) { say('Nothing to undo'); return; }
    undoLast();
    buildPieces();
    restart(true);
    say(appStatus());
  }

  /* ---------------- open / close ---------------- */

  function onKey(e) {
    if (!E) return;
    if (document.body.classList.contains('draw-editor-open')) return;     // the Draw editor is over the stage: its keys
    var tag = (e.target && e.target.tagName) || '';
    var typing = (tag === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') || tag === 'TEXTAREA';
    /* the plate's shortcuts (Delete, the arrows, Ctrl+Z...) must not act on a plate that cannot be seen */
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (E.busy) return;
      if (E.mode !== 'mate') { if (!(MODES[E.mode].escape && MODES[E.mode].escape())) close(); return; }
      if (E.step === 'adjust') toStep('target');
      else if (E.step === 'target') restart();
      else close();
      return;
    }
    if (typing) return;
    if (E.mode !== 'mate' && MODES[E.mode].key && !E.busy && MODES[E.mode].key(e)) { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
  }

  function open(mode) {
    if (E) { if (mode) setMode(mode); return true; }
    if (typeof THREE === 'undefined' || !THREE.OrbitControls || typeof NSO_poseApplyWorld !== 'function') {
      if (typeof setStatus === 'function') setStatus('The assembly editor could not start - a script it needs did not load', true);
      return false;
    }
    /* leave the plate quiet: the Assemble card shut (which ends its Join session), nothing armed */
    var menu = $('menu-assemble');
    if (menu && menu.open && !(mode && MODES[mode] && MODES[mode].solo)) menu.open = false;
    if (typeof clearJoinSlots === 'function' && state.joinSession) clearJoinSlots();
    buildDom(); buildStage();
    E = { mode: 'mate', apart: false, together: false, opener: mode || 'mate',
          step: 'part', pieces: [], part: null, target: null, anchor: { mode: 'click' }, nudge: { u: 0, v: 0 }, spin: 0,
          solution: null, busy: false, ghost: null, hoverMark: null, partMark: null, targetMark: null, hoverFace: null, last: null };
    root.hidden = false;
    document.body.classList.add('asm-editor-open');
    resize();
    buildPieces();
    toStep('part');
    R.camera.position.set(-120, 140, 200); R.controls.target.set(0, 0, 0);
    frameBox(stageBox(E.pieces), false);
    say('');
    window.addEventListener('keydown', onKey, true);
    if (!R.raf) R.raf = requestAnimationFrame(tick);
    $('asm-return').focus();
    if (mode && mode !== 'mate') setMode(mode);
    return true;
  }

  function close() {
    if (!E || E.busy) return;
    window.removeEventListener('keydown', onKey, true);
    if (E.mode !== 'mate' && MODES[E.mode].leave) MODES[E.mode].leave();
    clearPieces();
    var solo = MODES[E.opener] && MODES[E.opener].solo;
    var back = solo && solo.returnTo ? $(solo.returnTo) : null;
    E = null;
    root.hidden = true;
    document.body.classList.remove('asm-editor-open');
    if (R.raf) { cancelAnimationFrame(R.raf); R.raf = 0; }
    if (back) { back.focus(); return; }
    var btn = $('menu-assemble');
    if (btn && btn.querySelector('summary')) btn.querySelector('summary').focus();
  }

  /* For the checks (tools/nso_asm_editor_test.js): where a world point on a
     piece is on the screen, so a check clicks the pixel a person would, and
     what the editor holds. Nothing here acts. */
  function screenOf(sourceId, worldPoint) {
    if (!E) return null;
    var piece = E.pieces.find(function (p) { return p.id === sourceId; });
    if (!piece) return null;
    var p = V(worldPoint[0], worldPoint[1], worldPoint[2]).add(piece.offset).project(R.camera);
    var rect = R.dom.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height };
  }
  function info() {
    if (!E) return { open: false };
    return {
      open: true, mode: E.mode, lock: (E.mode !== 'mate' && MODES[E.mode].info) ? MODES[E.mode].info() : null,
      step: E.step, busy: E.busy, pieces: E.pieces.map(function (p) { return p.id; }),
      visible: E.pieces.filter(function (p) { return p.mesh.visible; }).map(function (p) { return p.id; }),
      part: E.part ? { id: E.part.face.piece.id, normal: E.part.face.n.toArray(), tris: E.part.face.tris.length } : null,
      target: E.target ? { id: E.target.face.piece.id, normal: E.target.face.n.toArray(), tris: E.target.face.tris.length } : null,
      anchor: E.anchor, spin: E.spin, nudge: E.nudge, ghost: !!(E.ghost && E.ghost.visible),
      solution: E.solution ? { matrix: E.solution.matrix.elements.slice(), gap: E.solution.gap, contactU: E.solution.contactU,
        contactV: E.solution.contactV, overhang: E.solution.overhang, turnDeg: E.solution.turnDeg, sink: E.solution.sink || 0 } : null,
      last: E.last
    };
  }
  function view(dir) {            // look from a direction, for a check that needs a face in sight
    if (!E) return;
    var mv = (E.mode !== 'mate' && MODES[E.mode].view) ? MODES[E.mode].view() : null;
    var box = mv || ((E.mode === 'mate' && E.step === 'adjust') ? stageBox(E.pieces).union(new THREE.Box3().setFromObject(E.ghost)) : stageBox(E.pieces));
    R.camera.position.copy(R.controls.target).add(V(dir[0], dir[1], dir[2]));
    frameBox(box, true);
    R.renderer.render(R.scene, R.camera);
    syncPad();
  }

  /* ---------------- a tool added to or cut from a piece ----------------
     Interlock's key and socket and Step / Boss's solid all go in this way.

     One piece's share: the tool carried into the piece's own raw frame, the
     boolean run, and the box the result will have in the world. Nothing is
     changed here - both shares are worked out before either is committed, so
     a refusal on one leaves both pieces as they were. */
  async function toolShare(piece, tool, op, words) {
    words = words || {};
    var placed = piece.placed, name = nameOf(piece);
    var m = state.models.find(function (x) { return x && x.id === piece.id; });
    if (!m || !(m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9)) return { ok: false, reason: name + ' has no untransformed soup to work on' };
    if (typeof nsoRawFrameOf !== 'function') return { ok: false, reason: 'the raw-frame mapping (app-mask.js) did not load' };
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) return { ok: false, reason: painted + ' painted face(s) on ' + name + ' - the boolean replaces every triangle on the piece and cannot hold a face still. Clear the paint first.' };
    var sol = (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? await nsoOverlap.solid(m) : { ok: true, merged: false };
    if (!sol.ok) return { ok: false, reason: sol.cancelled ? 'stopped' : name + ': ' + sol.reason };
    var hull = sol.merged ? sol.soup : m.rawTris;
    var f = nsoRawFrameOf(m), mesh = placed.mesh;
    mesh.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert(), v = new THREE.Vector3();
    var raw = new Float32Array(tool.length), i;
    for (i = 0; i < tool.length; i += 3) {
      v.set(tool[i], tool[i + 1], tool[i + 2]).applyMatrix4(inv);
      var rp = nsoRawPointFromLocal(f, [v.x, v.y, v.z]);
      raw[i] = rp[0]; raw[i + 1] = rp[1]; raw[i + 2] = rp[2];
    }
    if (soupVolume(raw) < 0) {                                      // a mirrored pose turns a solid inside out: wind it back
      for (i = 0; i < raw.length; i += 9) for (var k = 0; k < 3; k++) { var t = raw[i + 3 + k]; raw[i + 3 + k] = raw[i + 6 + k]; raw[i + 6 + k] = t; }
    }
    var r = op === 'union' ? await NSO_unionSoups(hull, raw, { label: words.label || 'Adding' })
                           : await NSO_subtractSoups(hull, raw, { label: words.label || 'Cutting' });
    if (r.cancelled || r.timedOut) return { ok: false, reason: r.cancelled ? 'stopped' : r.reason };
    if (!r.ok || !r.soup || r.soup.length < 9) return { ok: false, reason: name + ': the ' + (op === 'union' ? 'union' : 'cut') + ' ' + (r.reason ? '- ' + r.reason : 'missed') };
    var stats = r.stats || ((typeof NSO_edgeStats === 'function') ? NSO_edgeStats(r.soup) : null);
    if (stats && (stats.open > 0 || stats.nm > 0)) return { ok: false, reason: name + ': the result came back open (' + stats.open + ' open, ' + stats.nm + ' non-manifold edges)' };
    var vh = Math.abs(soupVolume(hull)), vt = Math.abs(soupVolume(raw)), vr = Math.abs(soupVolume(r.soup));
    /* A key that bites the piece shares volume with it; one that does not is
       a loose body beside it. A socket that removes nothing missed. */
    if (op === 'union' && vr > vh + vt - 1e-4) return { ok: false, reason: words.noJoin ? words.noJoin(name) : 'it would not be joined to ' + name + ' there - there is nothing under it to stand on' };
    if (op !== 'union' && vr > vh - 1e-4) return { ok: false, reason: words.noCut ? words.noCut(name) : 'it misses ' + name + ' there - nothing would be cut' };
    var box = new THREE.Box3();
    for (i = 0; i < r.soup.length; i += 3) {
      var lp = nsoLocalPointFromRaw(f, [r.soup[i], r.soup[i + 1], r.soup[i + 2]]);
      box.expandByPoint(v.set(lp[0], lp[1], lp[2]).applyMatrix4(mesh.matrixWorld));
    }
    return { ok: true, piece: piece, model: m, soup: r.soup, box: box, op: op, tris: r.soup.length / 9, removed: vh - vr, merged: sol.merged ? sol.note : '' };
  }

  /* Commit one share and put the piece back where its body was. */
  function commitShare(w, undoType) {
    var placed = w.piece.placed, idx = state.placed.indexOf(placed);
    var pose = (typeof snapshotPlacedPose === 'function') ? snapshotPlacedPose(idx) : null;
    if (!NSO_sculptCommitRaw(w.model, w.soup, undoType, null)) return false;
    var top = state.undoStack[state.undoStack.length - 1];
    if (top && top.type === undoType && top.modelId === w.model.id) top.prevPose = pose;
    placed.liftY = 0;
    applyPlacedXZ(placed, placed.x, placed.z);
    placed.mesh.updateMatrixWorld(true);
    var b = new THREE.Box3().setFromObject(placed.mesh);
    var lift = w.box.min.y - b.min.y;
    w.raise = lift < -1e-6 ? -lift : 0;                          // the result reaches under the plate: it rests on it instead
    placed.liftY = Math.max(0, lift);
    placed.x += (w.box.min.x + w.box.max.x) / 2 - (b.min.x + b.max.x) / 2;
    placed.z += (w.box.min.z + w.box.max.z) / 2 - (b.min.z + b.max.z) / 2;
    applyPlacedXZ(placed, placed.x, placed.z);
    if (typeof refreshOutline === 'function') refreshOutline(placed);
    placed.mesh.updateMatrixWorld(true);
    return true;
  }

  function soupVolume(s) {
    var v = 0;
    for (var i = 0; i < s.length; i += 9) {
      v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7])
         - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6])
         + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
    }
    return v / 6;
  }

  window.NSO_AsmEditor = {
    open: open, close: close, isOpen: function () { return !!E; }, info: info, screenOf: screenOf, view: view,
    /* Register a mode (see MODES). `kit` is what a mode needs of this file's
       own workings - the stage, the session, faces, marks - handed over
       rather than copied, so there is one definition of "the face under a
       click" for every tool on the stage. */
    mode: function (name, def) {
      MODES[name] = def;
      return {
        stage: function () { return R; }, session: function () { return E; },
        h: h, $: $, V: V, nameOf: nameOf, faceOf: faceOf, triData: triData, faceWord: faceWord, markFor: markFor,
        disposeObj: disposeObj, frameBox: frameBox, stageBox: stageBox, buildPieces: buildPieces,
        say: say, syncPanel: syncPanel, asOneStep: asOneStep, appStatus: appStatus, restart: restart,
        toolShare: toolShare, commitShare: commitShare, soupVolume: soupVolume, close: close,
        FACE_COS: FACE_COS
      };
    }
  };

  function bind() {
    var b = $('btn-asm-open');
    if (b) b.addEventListener('click', function () { open(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-asm-mode]'), function (el) {
      el.addEventListener('click', function () { open(el.getAttribute('data-asm-mode')); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
