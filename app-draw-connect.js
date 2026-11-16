/* ============================================================
   Draw > Connect - the drawing put on a piece. docs/DRAW.md.
   After app-asm-editor.js (whose stage it borrows as a SOLO mode, the way
   Step / Boss does), nso_sketch.js (the solids), app-draw-editor.js (the
   drawing) and app-connect.js (NSO_connectCommit).

   WHY IT EXISTS. Connect drew and anchored on the plate: every click was a
   ray into the plate view, so where a stroke could go was where the view
   could reach, and orbiting and clicking fought each other. The Assemble
   editor answered the same trouble for putting one piece on another - the
   pieces alone on a stage, a ghost before anything is baked. This is that,
   for a drawing.

   THE STAGE shows the plate's pieces AS THEY STAND (asPlaced: not spread
   out), so one drawing can run from one piece onto the next and weld the two.
     1  Click the face it goes on - any face: a top, a wall, an underside.
     2  The drawing stands on that face as a GHOST, its lines and fills each
        their own height out of the face. Move it freely: drag the ghost
        anywhere on the face's plane (past the face's edge too, onto the
        next piece), the arrows nudge, [ and ] turn it 15 degrees (Shift: 1),
        or type Offset, Turn, Scale, Lift. A click on another face moves the
        drawing there, settings kept. Edit drawing reopens the Draw editor
        with this face drawn on the sheet as its size reference.
     3  Apply, as one Undo:
          Weld in   the drawing is unioned into every piece it reaches. One
                    piece keeps its identity (Step / Boss's commit); two or
                    more become one new piece - that is the connection.
          Cut in    the drawing is cut into the face, its height deep - an
                    engraving, a channel, a recess.
          Own piece the drawing is made a piece of its own where the ghost
                    is (no boolean on any piece).
        The pieces it would touch are lit orange while it is placed.

   PAINT SCOPE: WHOLE-PIECE on every piece a Weld or a Cut changes (a boolean
   replaces every triangle); a painted piece is refused in words. Own piece
   touches none.
   ============================================================ */
(function () {
  'use strict';
  if (typeof NSO_AsmEditor === 'undefined' || !NSO_AsmEditor.mode || typeof NSO_Sketch === 'undefined') return;

  var SK = NSO_Sketch;
  var EMBED = 0.4;
  var SNAP = 0.75;
  var OPS = [['weld', 'Weld in', 'Union the drawing into every piece it reaches - two pieces it spans become one'],
             ['cut', 'Cut in', 'Cut the drawing into the face, its height deep: an engraving, a channel, a recess'],
             ['place', 'Own piece', 'Make the drawing a piece of its own, where the ghost is']];
  var COL = { weld: 0x4ade80, cut: 0xf87171, place: 0xfbbf24, host: 0xfb923c, touched: 0xfdba74, other: 0x38bdf8 };
  var L = null, K;
  var prefs = { op: 'weld', scale: 100, lift: 0, height: '', mirror: false };

  function R() { return K.stage(); }
  function E() { return K.session(); }
  function el(id) { return K.$('dc-' + id); }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function sketch() { return typeof NSO_DrawEditor !== 'undefined' ? NSO_DrawEditor.sketch() : SK.normalize(null); }
  function numVal(id, d) { var v = parseFloat(el(id).value); return isFinite(v) ? v : d; }

  /* ---------------------------------------------------------------- the panel */

  function panel(body) {
    var h = K.h;
    function field(id, label, title, attrs) {
      var a = { type: 'number', id: 'dc-' + id, step: '0.1', inputmode: 'decimal', 'aria-label': title };
      for (var k in (attrs || {})) a[k] = attrs[k];
      return h('label', { cls: 'asm-il-field', title: title }, [h('span', { text: label }), h('input', a)]);
    }
    [
      h('button', { type: 'button', cls: 'asm-chip asm-chip-target', id: 'dc-chip', title: 'The face it goes on. Click to pick it again.' }, [
        h('span', { cls: 'asm-chip-n', text: '1' }), h('span', { cls: 'asm-chip-text', id: 'dc-chip-text', text: 'Click the face it goes on' })]),
      h('p', { cls: 'asm-il-note', id: 'dc-drawing', text: '' }),
      h('button', { type: 'button', cls: 'btn btn-secondary', id: 'dc-edit', text: 'Edit drawing',
        title: 'Open the Draw editor; with a face picked, its size is drawn on the sheet. Close it to come back here.' }),
      h('div', { cls: 'asm-ed-adjust', id: 'dc-set' }, [
        h('div', { cls: 'asm-ed-label', text: 'What Apply does' }),
        h('div', { cls: 'asm-il-seg', role: 'group', 'aria-label': 'Operation' }, OPS.map(function (o) {
          return h('button', { type: 'button', cls: 'asm-il-opt', id: 'dc-op-' + o[0], 'data-dc-op': o[0], text: o[1], title: o[2] });
        })),
        h('div', { cls: 'asm-ed-label', text: 'Place it (drag the ghost, or type)' }),
        h('div', { cls: 'asm-il-grid' }, [
          field('u', '← →', 'Offset of the drawing\'s centre from the face\'s centre, along the face, mm'),
          field('v', '↓ ↑', 'Offset of the drawing\'s centre from the face\'s centre, up the face, mm'),
          field('deg', 'Turn', 'Turn on the face, degrees ([ and ] turn 15, Shift 1)', { step: '1' }),
          field('scale', 'Scale %', 'The drawing\'s size, per cent', { step: '1', min: '1' }),
          field('height', 'Height', 'How far it stands out of the face (or how deep it cuts), mm. Blank: the drawing\'s own heights', { min: String(SK.MIN_HEIGHT) }),
          field('lift', 'Lift', 'Raise the drawing off the face, mm (negative sinks it in). A Weld still bites the face by ' + EMBED + ' mm under its foot', { step: '0.1' })
        ]),
        h('div', { cls: 'asm-ed-row' }, [
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'dc-turn90', text: '+90°', title: 'A quarter turn on the face' }),
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'dc-mirror', text: 'Mirror', title: 'Mirror the drawing left-right on the face', 'aria-pressed': 'false' }),
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'dc-centre', text: 'Centre', title: 'Back to the middle of the face' })
        ]),
        h('div', { cls: 'asm-nudge', role: 'group', 'aria-label': 'Nudge' }, [
          h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': -1, 'data-dy': 0, text: '←', title: 'Nudge left (arrow key)', 'aria-label': 'Nudge left' }),
          h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': 0, 'data-dy': 1, text: '↑', title: 'Nudge up', 'aria-label': 'Nudge up' }),
          h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': 0, 'data-dy': -1, text: '↓', title: 'Nudge down', 'aria-label': 'Nudge down' }),
          h('button', { type: 'button', cls: 'btn btn-secondary asm-nudge-btn', 'data-dx': 1, 'data-dy': 0, text: '→', title: 'Nudge right', 'aria-label': 'Nudge right' })
        ]),
        h('div', { cls: 'asm-ed-row' }, [
          h('label', { cls: 'asm-step', title: 'How far one nudge moves it, mm (Shift: ten times)' }, [
            h('span', { text: 'step' }), h('input', { type: 'number', id: 'dc-step', min: '0.01', step: '0.1', value: '1', 'aria-label': 'Nudge step in mm' }), h('span', { text: 'mm' })])
        ]),
        h('p', { cls: 'asm-ed-readout', id: 'dc-readout', 'aria-live': 'polite' }),
        h('div', { cls: 'asm-ed-row' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', id: 'dc-apply', text: 'Apply', title: 'Bake what the ghost shows. One Undo.' })
        ])
      ])
    ].forEach(function (n) { body.appendChild(n); });

    el('chip').addEventListener('click', function () { if (live(false)) K.restart(); });
    el('edit').addEventListener('click', editDrawing);
    Array.prototype.forEach.call(body.querySelectorAll('[data-dc-op]'), function (b) {
      b.addEventListener('click', function () { if (!E() || E().busy) return; prefs.op = b.getAttribute('data-dc-op'); changed(); });
    });
    el('u').addEventListener('change', function () { if (live(true)) { L.cu = L.fr.mu + numVal('u', 0); changed(); } });
    el('v').addEventListener('change', function () { if (live(true)) { L.cv = L.fr.mv + numVal('v', 0); changed(); } });
    el('deg').addEventListener('change', function () { if (live(true)) { L.deg = numVal('deg', 0); changed(); } });
    el('scale').addEventListener('change', function () { var v = numVal('scale', 100); if (v > 0) prefs.scale = v; changed(); });
    el('height').addEventListener('change', function () { var raw = el('height').value.trim(); prefs.height = raw === '' ? '' : Math.max(SK.MIN_HEIGHT, parseFloat(raw) || SK.MIN_HEIGHT); changed(); });
    el('lift').addEventListener('change', function () { prefs.lift = numVal('lift', 0); changed(); });
    el('turn90').addEventListener('click', function () { if (live(true)) { L.deg = ((L.deg + 90) % 360 + 360) % 360; changed(); } });
    el('mirror').addEventListener('click', function () { if (live(true)) { prefs.mirror = !prefs.mirror; changed(); } });
    el('centre').addEventListener('click', function () { if (live(true)) { L.cu = L.fr.mu; L.cv = L.fr.mv; changed(); } });
    Array.prototype.forEach.call(body.querySelectorAll('.asm-nudge-btn'), function (b) {
      b.addEventListener('click', function () { nudge(+b.getAttribute('data-dx'), +b.getAttribute('data-dy'), false); });
    });
    el('apply').addEventListener('click', apply);
  }

  function live(needSet) { return !!(L && E() && !E().busy && (!needSet || L.step === 'set')); }

  function nudge(dx, dy, big) {
    if (!live(true)) return;
    var st = Math.max(0.01, numVal('step', 1)) * (big ? 10 : 1);
    L.cu += dx * st; L.cv += dy * st;
    changed();
  }

  function editDrawing() {
    if (typeof NSO_DrawEditor === 'undefined' || (E() && E().busy)) return;
    var ref = null;
    if (L && L.host) ref = { w: L.fr.u1 - L.fr.u0, h: L.fr.v1 - L.fr.v0, label: K.nameOf(L.host.piece) + ' · ' + K.faceWord(L.host) + ' (' + f2(L.fr.u1 - L.fr.u0) + ' × ' + f2(L.fr.v1 - L.fr.v0) + ' mm)' };
    var back = function () { changed(); var b = el('edit'); if (b) b.focus(); };
    NSO_DrawEditor.open({ ref: ref, onClose: back, onConnect: function () { /* the stage is already open: close() returns here */ } });
  }

  /* ---------------------------------------------------------------- the face */

  /* Step / Boss's rule: on a wall, v points up the wall; u x v = n kept. */
  function upright(face) {
    var fr = face.frame, out;
    if (Math.abs(face.n.y) > 0.9 || fr.v.y >= 0) out = { u: fr.u, v: fr.v, u0: fr.u0, u1: fr.u1, v0: fr.v0, v1: fr.v1 };
    else out = { u: fr.u.clone().negate(), v: fr.v.clone().negate(), u0: -fr.u1, u1: -fr.u0, v0: -fr.v1, v1: -fr.v0 };
    out.mu = (out.u0 + out.u1) / 2; out.mv = (out.v0 + out.v1) / 2;
    return out;
  }

  /* ---------------------------------------------------------------- the plan */

  function plan() {
    if (!L || !L.host) return { ok: false, reason: 'no face picked' };
    var sk = sketch(), cut = prefs.op === 'cut', own = prefs.op === 'place';
    var r = SK.solids(sk, { embed: own ? 0 : EMBED, lift: cut ? 0 : prefs.lift, scale: prefs.scale / 100, mirror: prefs.mirror ? 'x' : null,
                            height: prefs.height === '' ? null : prefs.height });
    if (!r.ok) return { ok: false, reason: r.reason };
    var face = L.host, fr = L.fr, a = L.deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    var o = fr.u.clone().multiplyScalar(L.cu).addScaledVector(fr.v, L.cv).addScaledVector(face.n, face.d);
    var u = fr.u, v = fr.v, n = face.n, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    /* Cut: the solid turned into the face - z runs down from EMBED above the face to its height below it, less any lift */
    var parts = r.parts.map(function (p) {
      var s = p.soup, w = new Float32Array(s.length);
      for (var i = 0; i < s.length; i += 3) {
        var x = s[i] * co - s[i + 1] * si, y = s[i] * si + s[i + 1] * co, z = cut ? -s[i + 2] : s[i + 2];
        var X = o.x + u.x * x + v.x * y + n.x * z, Y = o.y + u.y * x + v.y * y + n.y * z, Z = o.z + u.z * x + v.z * y + n.z * z;
        w[i] = X; w[i + 1] = Y; w[i + 2] = Z;
        if (X < lo[0]) lo[0] = X; if (Y < lo[1]) lo[1] = Y; if (Z < lo[2]) lo[2] = Z;
        if (X > hi[0]) hi[0] = X; if (Y > hi[1]) hi[1] = Y; if (Z > hi[2]) hi[2] = Z;
      }
      if (cut) for (var t = 0; t < w.length; t += 9) for (var k = 0; k < 3; k++) { var q = w[t + 3 + k]; w[t + 3 + k] = w[t + 6 + k]; w[t + 6 + k] = q; }
      return { soup: w, volume: p.volume };
    });
    var box = new THREE.Box3(new THREE.Vector3(lo[0], lo[1], lo[2]), new THREE.Vector3(hi[0], hi[1], hi[2]));
    /* which pieces it may reach: the host, and any other whose box its box meets */
    var touched = own ? [] : E().pieces.filter(function (p) { return p === face.piece || p.box.intersectsBox(box); });
    var notes = [];
    var su = r.box.w * Math.abs(co) + r.box.h * Math.abs(si), sv = r.box.w * Math.abs(si) + r.box.h * Math.abs(co);
    if (L.cu - su / 2 < fr.u0 - 1e-6 || L.cu + su / 2 > fr.u1 + 1e-6 || L.cv - sv / 2 < fr.v0 - 1e-6 || L.cv + sv / 2 > fr.v1 + 1e-6) notes.push('runs past the face\'s edge');
    if (!cut && !own && prefs.lift > 0) notes.push('lifted ' + f2(prefs.lift) + ' mm: only what still reaches a piece welds');
    return { ok: true, parts: parts, box: box, touched: touched, solids: r, notes: notes, sketch: sk, span: { u: su, v: sv } };
  }

  /* ---------------------------------------------------------------- drawing */

  function redraw() {
    if (!L) return;
    K.disposeObj(L.ghost); L.ghost = null;
    L.plan = null;
    if (L.step !== 'set') { tint(); return; }
    var P = plan();
    L.plan = P;
    tint();
    if (!P.ok) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(SK.concat(P.parts.map(function (p) { return p.soup; })), 3));
    g.computeVertexNormals();
    var c = COL[prefs.op], grp = new THREE.Group();
    grp.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: c, transparent: true, opacity: 0.66, depthWrite: false, depthTest: false,
      metalness: 0, roughness: 0.6, emissive: c, emissiveIntensity: 0.25, side: THREE.DoubleSide })));
    grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.5, depthTest: false })));
    grp.position.copy(L.host.piece.offset);
    grp.renderOrder = 5;
    R().group.add(grp);
    L.ghost = grp;
  }

  /* the host orange, the pieces it may reach light orange, the rest dimmed - all of them in sight */
  function tint() {
    if (!E()) return;
    var P = L && L.plan && L.plan.ok ? L.plan : null;
    E().pieces.forEach(function (p) {
      var isHost = !!(L && L.host && p === L.host.piece), reach = !!(P && P.touched.indexOf(p) >= 0);
      var m = p.mesh.material;
      p.mesh.visible = true;
      var dim = !!(L && L.step === 'set' && !isHost && !reach);
      m.transparent = dim; m.opacity = dim ? 0.35 : 1; m.depthWrite = !dim;
      m.color.setHex(isHost ? COL.host : (reach ? COL.touched : COL.other));
      m.emissive.setHex(isHost ? 0x4a2a0c : (reach ? 0x3a2410 : 0x0a3a5c));
      m.needsUpdate = true;
    });
  }

  /* ---------------------------------------------------------------- the pointer */

  function rayAt(e) {
    var rect = R().dom.getBoundingClientRect();
    var p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    R().raycaster.setFromCamera(p, R().camera);
    return R().raycaster.ray;
  }
  function onPlane(e) {
    var ray = rayAt(e), face = L.host, org = ray.origin.clone().sub(face.piece.offset), den = ray.direction.dot(face.n);
    if (Math.abs(den) < 1e-6) return null;
    var t = (face.d - org.dot(face.n)) / den;
    if (t <= 0) return null;
    var hit = org.addScaledVector(ray.direction, t);
    return { u: hit.dot(L.fr.u), v: hit.dot(L.fr.v) };
  }
  /* free: on a 0.1 mm step. Shift: onto the face's centre lines and flush with its edges when within SNAP. */
  function place(cu, cv, snap) {
    if (!snap) return { u: Math.round(cu * 10) / 10, v: Math.round(cv * 10) / 10 };
    var fr = L.fr, sp = (L.plan && L.plan.ok) ? L.plan.span : { u: 0, v: 0 };
    function one(c, lo, hi, mid, s) {
      if (Math.abs(c - mid) < SNAP) return mid;
      if (Math.abs(c - s / 2 - lo) < SNAP) return lo + s / 2;
      if (Math.abs(hi - c - s / 2) < SNAP) return hi - s / 2;
      return Math.round(c * 10) / 10;
    }
    return { u: one(cu, fr.u0, fr.u1, fr.mu, sp.u), v: one(cv, fr.v0, fr.v1, fr.mv, sp.v) };
  }

  function pointerDown(e) {
    if (!live(true) || !L.ghost) return false;
    rayAt(e);
    var meshes = [];
    L.ghost.traverse(function (c) { if (c.isMesh) meshes.push(c); });
    if (!R().raycaster.intersectObjects(meshes, false).length) return false;
    var at = onPlane(e);
    if (!at) return false;
    var grab = { du: L.cu - at.u, dv: L.cv - at.v };
    R().dom.style.cursor = 'grabbing';
    function move(ev) {
      var p = onPlane(ev); if (!p) return;
      var s = place(p.u + grab.du, p.v + grab.dv, ev.shiftKey);
      L.cu = s.u; L.cv = s.v; L.dragged = true;
      redraw(); sync();
    }
    function up() {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      R().dom.style.cursor = '';
    }
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    return true;
  }

  /* ---------------------------------------------------------------- steps */

  function toHost() {
    L.step = 'host'; L.host = null; L.plan = null;
    K.disposeObj(L.hostMark); L.hostMark = null;
    K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null;
    redraw();
  }

  function pick(hit, keep) {
    var was = L.host;
    L.host = hit.face;
    L.fr = upright(hit.face);
    L.step = 'set';
    K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null;
    K.disposeObj(L.hostMark);
    L.hostMark = K.markFor(hit.face, COL.host, 0.22);
    var at = { u: hit.point.dot(L.fr.u), v: hit.point.dot(L.fr.v) };
    if (!keep) { L.cu = L.fr.mu; L.cv = L.fr.mv; L.deg = 0; }
    else { L.cu = at.u; L.cv = at.v; }
    if (!keep) {                                    // a face smaller than the drawing: centred; one that holds it: where it was clicked
      var b = SK.bounds(sketch().objects), s = prefs.scale / 100;
      if (b && b.w * s < L.fr.u1 - L.fr.u0 && b.h * s < L.fr.v1 - L.fr.v0) {
        L.cu = Math.min(L.fr.u1 - b.w * s / 2, Math.max(L.fr.u0 + b.w * s / 2, at.u));
        L.cv = Math.min(L.fr.v1 - b.h * s / 2, Math.max(L.fr.v0 + b.h * s / 2, at.v));
      }
    }
    redraw();
    if (!was) K.frameBox(viewBox(), true);
    K.syncPanel();
  }

  function viewBox() {
    if (!L || L.step !== 'set') return K.stageBox(E().pieces);
    var b = L.host.piece.box.clone().translate(L.host.piece.offset);
    if (L.plan && L.plan.ok) b.union(L.plan.box.clone().translate(L.host.piece.offset));
    return b;
  }

  function changed() {
    if (!L) return;
    redraw();
    K.syncPanel();
  }

  function sync() {
    if (!L) return;
    var S = E(), set = L.step === 'set', busy = !!S.busy, sk = sketch(), active = document.activeElement;
    el('chip-text').textContent = L.host ? (K.nameOf(L.host.piece) + ' · ' + K.faceWord(L.host)) : 'Click the face it goes on';
    el('chip').classList.toggle('is-set', !!L.host);
    el('chip').classList.toggle('is-now', !L.host);
    el('drawing').textContent = 'Drawing: ' + SK.describe(sk) + (sk.objects.length ? '' : ' - open Edit drawing and draw first');
    el('edit').disabled = busy;
    var box = el('set');
    box.classList.toggle('is-idle', !set || busy);
    Array.prototype.forEach.call(box.querySelectorAll('button, input'), function (x) { x.disabled = !set || busy; });
    /* what Apply does and the drawing's size and height can be chosen before a face is */
    Array.prototype.forEach.call(box.querySelectorAll('[data-dc-op], #dc-scale, #dc-height'), function (x) { x.disabled = busy; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-dc-op]'), function (b) {
      var on = b.getAttribute('data-dc-op') === prefs.op; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    el('mirror').setAttribute('aria-pressed', prefs.mirror ? 'true' : 'false');
    el('mirror').classList.toggle('is-on', prefs.mirror);
    function setVal(id, v) { if (el(id) !== active) el(id).value = v; }
    setVal('u', set ? f2(L.cu - L.fr.mu) : ''); setVal('v', set ? f2(L.cv - L.fr.mv) : '');
    setVal('deg', set ? String(Math.round(L.deg * 100) / 100) : '0');
    setVal('scale', String(prefs.scale)); setVal('height', prefs.height === '' ? '' : String(prefs.height)); setVal('lift', String(prefs.lift));
    el('height').placeholder = 'own';
    el('lift').disabled = !set || busy || prefs.op === 'cut';
    var P = L.plan, out = el('readout');
    if (!set) { out.textContent = ''; out.classList.remove('is-bad'); }
    else if (!P || !P.ok) { out.textContent = (P && P.reason) || ''; out.classList.add('is-bad'); }
    else { out.classList.remove('is-bad'); out.textContent = words(P); }
    el('apply').disabled = !set || busy || !(P && P.ok);
    el('apply').textContent = prefs.op === 'cut' ? 'Cut it in' : (prefs.op === 'place' ? 'Add as a piece' : (P && P.ok && P.touched.length > 1 ? 'Weld and connect' : 'Weld it in'));
  }

  function words(P) {
    var names = P.touched.map(function (p) { return K.nameOf(p); });
    var w;
    if (prefs.op === 'place') w = 'a piece of its own, ' + f2(P.span.u) + ' × ' + f2(P.span.v) + ' mm';
    else if (prefs.op === 'cut') w = 'cut into ' + names.join(', ');
    else w = P.touched.length > 1 ? 'welds ' + names.join(' and ') + ' into one' : 'welded into ' + names[0];
    return [SK.describe(P.sketch) + (prefs.scale !== 100 ? ' at ' + prefs.scale + '%' : '') + ' · ' + w].concat(P.notes).join(' · ');
  }

  /* ---------------------------------------------------------------- Apply */

  async function apply() {
    if (!live(true)) return false;
    var S = E(), P = plan();
    if (!P.ok) { K.say(P.reason, true); return false; }
    S.busy = true; K.syncPanel();
    K.say('Working…');
    var result = { ok: false, reason: '' };
    try {
      var tool = await joinParts(P.parts);
      if (!tool.ok) result.reason = tool.reason;
      else if (prefs.op === 'place') result = commitOwn(tool.soup);
      else if (prefs.op === 'cut') result = await cutIn(P, tool.soup);
      else if (P.touched.length > 1) result = await weldMany(P, tool.soup);
      else result = await weldOne(P, tool.soup);
    } catch (err) {
      console.error('[draw-connect]', err);
      result = { ok: false, reason: (err && err.message) || String(err) };
    }
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    S.busy = false;
    L.last = result;
    var msg = result.ok ? result.text : 'Nothing changed - ' + (result.reason === 'stopped' ? 'stopped' : result.reason);
    if (result.ok) {
      if (typeof setStatus === 'function') setStatus('Draw > Connect: ' + result.text);
      toHost(); K.buildPieces(); tint(); K.frameBox(K.stageBox(S.pieces), true);
    }
    K.syncPanel();
    K.say(result.ok ? msg + '. Click a face for the next, or Return.' : msg, !result.ok);
    return result.ok;
  }

  /* the drawing's solids as one tool: overlapping ones unioned first */
  async function joinParts(parts) {
    if (typeof NSO_DrawEditor !== 'undefined' && NSO_DrawEditor.unionParts) return NSO_DrawEditor.unionParts(parts.map(function (p) { return { soup: p.soup }; }), 'Drawing');
    return { ok: true, soup: SK.concat(parts.map(function (p) { return p.soup; })) };
  }

  function painted(pieces) {
    var n = 0, names = [];
    pieces.forEach(function (p) {
      var m = state.models.find(function (x) { return x && x.id === p.id; });
      var c = (m && typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
      if (c > 0) { n += c; names.push(K.nameOf(p)); }
    });
    return n ? n + ' painted face(s) on ' + names.join(', ') + ' - the boolean replaces every triangle on a piece and cannot hold a face still. Clear the paint first, or add the drawing as its own piece.' : '';
  }

  /* one piece: Step / Boss's union and commit - the piece keeps its identity */
  async function weldOne(P, tool) {
    var piece = L.host.piece, pl = piece.placed;
    pl.mesh.updateMatrixWorld(true);
    var y0 = pl.mesh.position.y;
    if (typeof settlePlacedOnBed === 'function') settlePlacedOnBed(pl);
    pl.mesh.updateMatrixWorld(true);
    var dy = pl.mesh.position.y - y0;
    if (dy) { tool = tool.slice(); for (var i = 1; i < tool.length; i += 3) tool[i] += dy; }
    var w = await K.toolShare(piece, tool, 'union', {
      label: 'Welding the drawing in',
      noJoin: function (name) { return 'the drawing would not be joined to ' + name + ' there - lift it less, or move it onto the face'; }
    });
    if (!w.ok) return w;
    var r = { ok: false, reason: 'the commit was rejected' };
    await K.asOneStep('Undo: Draw > Connect reverted', async function () {
      if (K.commitShare(w, 'drawConnectReplace')) r = { ok: true, text: 'drawing welded into ' + K.nameOf(piece) + (w.raise > 1e-6 ? ' (raised ' + f2(w.raise) + ' mm: it reaches under the plate)' : '') };
    });
    return r;
  }

  /* two or more: every piece it reaches and the drawing, unioned, one new piece in their place */
  async function weldMany(P, tool) {
    var why = painted(P.touched);
    if (why) return { ok: false, reason: why };
    if (typeof NSO_unionSoups !== 'function' || typeof NSO_connectCommit !== 'function') return { ok: false, reason: 'the boolean kernel or app-connect.js did not load' };
    var acc = tool, vAcc = Math.abs(K.soupVolume(tool));
    for (var i = 0; i < P.touched.length; i++) {
      var p = P.touched[i], s = meshToWorldSoup(p.placed.mesh), vp = Math.abs(K.soupVolume(s));
      var u = await NSO_unionSoups(s, acc, { label: 'Connecting ' + K.nameOf(p) });
      if (u.cancelled) return { ok: false, reason: 'stopped' };
      if (!u.ok || !u.soup) return { ok: false, reason: K.nameOf(p) + ': the union ' + (u.reason ? '- ' + u.reason : 'missed') };
      var vu = Math.abs(K.soupVolume(u.soup));
      if (vu > vp + vAcc - 1e-4) return { ok: false, reason: 'the drawing does not reach ' + K.nameOf(p) + ' - move it so it bites both, or weld only one' };
      acc = u.soup; vAcc = vu;
    }
    var stats = typeof NSO_edgeStats === 'function' ? NSO_edgeStats(acc) : null;
    if (stats && (stats.open > 0 || stats.nm > 0)) return { ok: false, reason: 'the result came back open (' + stats.open + ' open, ' + stats.nm + ' non-manifold edges)' };
    var models = P.touched.map(function (p) { return state.models.find(function (x) { return x && x.id === p.id; }); });
    var names = P.touched.map(function (p) { return K.nameOf(p); });       // before they leave the plate
    var c = NSO_connectCommit(toZUp(acc), models, 'drawing');
    if (!c.ok) return c;
    return { ok: true, text: 'drawing welded - ' + names.join(' and ') + ' are one piece', id: c.id };
  }

  /* cut: into every piece it reaches; the host must be cut */
  async function cutIn(P, tool) {
    var shares = [];
    for (var i = 0; i < P.touched.length; i++) {
      var p = P.touched[i];
      var w = await K.toolShare(p, tool, 'subtract', { label: 'Cutting the drawing in' });
      if (!w.ok) {
        if (w.reason === 'stopped') return w;
        if (p === L.host.piece) return w;
        continue;                                          // its box met the drawing's, the drawing does not
      }
      shares.push(w);
    }
    if (!shares.length) return { ok: false, reason: 'nothing would be cut' };
    var r = { ok: false, reason: 'the commit was rejected' };
    await K.asOneStep('Undo: Draw > Connect (cut) reverted', async function () {
      for (var k = 0; k < shares.length; k++) if (!K.commitShare(shares[k], 'drawConnectReplace')) return;
      r = { ok: true, text: 'drawing cut into ' + shares.map(function (w) { return K.nameOf(w.piece); }).join(', ') };
    });
    return r;
  }

  function commitOwn(tool) {
    if (typeof NSO_connectCommit !== 'function') return { ok: false, reason: 'app-connect.js did not load' };
    var c = NSO_connectCommit(toZUp(tool), [], 'drawing', 'Drawing (' + SK.describe(sketch()).split(',')[0] + ')');
    if (!c.ok) return c;
    return { ok: true, text: 'drawing added as a piece of its own', id: c.id };
  }

  function toZUp(s) {
    var up = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { up[i] = s[i]; up[i + 1] = -s[i + 2]; up[i + 2] = s[i + 1]; }
    return up;
  }

  /* ---------------------------------------------------------------- the mode */

  K = NSO_AsmEditor.mode('drawconnect', {
    label: 'Draw · Connect',
    title: 'Put the drawing on a face: weld it in, cut it in, or make it a piece of its own',
    solo: { title: 'Draw · Connect', returnTo: 'btn-draw-connect' },
    asPlaced: true,
    panel: panel,
    enter: function () {
      L = { step: 'host', host: null, fr: null, cu: 0, cv: 0, deg: 0, plan: null, last: null, ghost: null, hostMark: null, hoverMark: null, hoverFace: null };
      toHost();
    },
    leave: function () {
      if (!L) return;
      ['ghost', 'hostMark', 'hoverMark'].forEach(function (k) { K.disposeObj(L[k]); });
      E().pieces.forEach(function (p) { var m = p.mesh.material; m.transparent = false; m.opacity = 1; m.depthWrite = true; p.mesh.visible = true; });
      L = null;
    },
    restart: function () { if (L) toHost(); },
    banner: function () {
      if (!sketch().objects.length) return ['', 'The drawing is empty', 'press Edit drawing and draw something first'];
      if (!L || L.step === 'host') return ['1', 'Click the face it goes on', 'any face - a top, a wall, an underside'];
      return ['2', 'Drag the ghost where it goes', 'past the face\'s edge onto the next piece to connect them · Shift snaps · [ ] turn'];
    },
    hover: function (hit) {
      if (!L) return;
      if (L.step === 'set') { R().dom.style.cursor = hit && hit.face !== L.host ? 'pointer' : 'crosshair'; return; }
      if (!hit) { K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null; R().dom.style.cursor = ''; return; }
      R().dom.style.cursor = 'pointer';
      if (L.hoverFace !== hit.face) { K.disposeObj(L.hoverMark); L.hoverMark = K.markFor(hit.face, COL.host, 0.45); L.hoverFace = hit.face; }
    },
    clearHover: function () { if (L && L.step === 'host') { K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null; } },
    click: function (hit, e) {
      if (!L) return;
      if (L.step === 'host') { if (hit) pick(hit, false); return; }
      if (hit && hit.face !== L.host) { pick(hit, true); return; }       // another face: the drawing moves there
      var at = onPlane(e);
      if (!at) return;
      var s = place(at.u, at.v, e.shiftKey);
      L.cu = s.u; L.cv = s.v;
      changed();
    },
    pointerDown: pointerDown,
    key: function (e) {
      if (!live(true)) return false;
      var k = e.key;
      if (k.indexOf('Arrow') === 0) {
        nudge(k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, k === 'ArrowUp' ? 1 : k === 'ArrowDown' ? -1 : 0, e.shiftKey);
        return true;
      }
      if (k === '[' || k === ']' || k === '{' || k === '}') {
        L.deg += (k === '[' || k === '{' ? 1 : -1) * (e.shiftKey ? 1 : 15);
        L.deg = Math.round(((L.deg % 360) + 360) % 360 * 100) / 100;
        changed();
        return true;
      }
      return false;
    },
    escape: function () {
      if (!L || L.step === 'host') return false;
      toHost(); K.frameBox(K.stageBox(E().pieces), true); K.say(''); K.syncPanel();
      return true;
    },
    sync: sync,
    view: function () { return viewBox(); },
    info: function () {
      if (!L) return null;
      var P = L.plan;
      return {
        step: L.step, op: prefs.op, scale: prefs.scale, lift: prefs.lift, height: prefs.height, mirror: prefs.mirror,
        host: L.host ? { id: L.host.piece.id, normal: L.host.n.toArray(), d: L.host.d, u: L.fr.u.toArray(), v: L.fr.v.toArray(),
          rect: { u0: L.fr.u0, u1: L.fr.u1, v0: L.fr.v0, v1: L.fr.v1 } } : null,
        cu: L.cu, cv: L.cv, deg: L.deg,
        plan: (P && P.ok) ? { box: { min: P.box.min.toArray(), max: P.box.max.toArray() }, touched: P.touched.map(function (p) { return p.id; }), notes: P.notes, parts: P.parts.length, ghost: !!L.ghost }
          : (P ? { error: P.reason } : null),
        last: L.last
      };
    }
  });

  function bind() {
    var b = document.getElementById('btn-draw-connect');
    if (b) b.addEventListener('click', function () {
      if (typeof NSO_connectShut === 'function') NSO_connectShut();
      NSO_AsmEditor.open('drawconnect');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
