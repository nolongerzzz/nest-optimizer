/* ============================================================
   Interlock - keys and their sockets, placed on the assembly editor's stage.
   docs/INTERLOCK.md. After app-asm-editor.js (whose stage, faces and marks it
   is handed by NSO_AsmEditor.mode) and nso_interlock.js (the solids).

   WHAT IT IS. The editor's second mode. One click names a face; a key stands
   on it - a tongue, a round pin or a snap tab, sized by typed caliper values -
   and is put exactly where it is wanted by dragging it on the face or by
   typing its distance from any of the face's four edges. If another piece is
   SEATED against that face (the Mate tab's Place puts one there), that piece
   is found, drawn see-through, and gets the matching socket: the key grown by
   the fit, cut where the key will be. Apply does both as one Undo.

   With nothing seated there it works on the one piece: a key to fit a slot
   that already exists somewhere - another print, a bought part, a machine -
   or a socket sized off the thing that has to go into it.

   WHICH PIECE GETS WHAT
     Make: key here      the key is added to the clicked piece and points out
                         of the clicked face; the socket (if a piece is seated
                         there and "cut the socket" is on) goes into that one.
     Make: socket here   the socket is cut into the clicked piece, going in
                         from the clicked face; the key (same condition) is
                         added to the seated piece and points into this one.

   WHAT IT REUSES. The key and the cutter are nso_interlock.js's. They are
   added and cut by the app's own booleans (NSO_unionSoups, NSO_subtractSoups)
   in the piece's own raw frame, through app-mask.js's raw <-> local mapping,
   and committed by NSO_sculptCommitRaw - the route Attach takes
   (app-assemble.js). One press is one Undo through the editor's asOneStep.

   THE PIECE DOES NOT MOVE. A commit re-centres a piece's geometry on its own
   box, so a key standing out of one side would shift the body by half the
   key's height. The result's box is worked out in the world BEFORE the commit
   (through the mapping as it stood) and the piece is put back to it after:
   x, z and liftY re-fitted, inside the same Undo entry (its prevPose).

   PAINT SCOPE: WHOLE-PIECE. A boolean replaces every triangle on the piece,
   so there is no face this could promise to leave alone: a piece with painted
   faces is refused, in words, as Attach refuses it.
   ============================================================ */
(function () {
  'use strict';
  if (typeof NSO_AsmEditor === 'undefined' || !NSO_AsmEditor.mode || typeof NSO_Interlock === 'undefined') return;

  var EMBED = 0.4;        // the key starts this far inside the piece it is added to
  var PRE = 0.2;          // the cutter starts this far before the face it is cut into
  var SEAT_REACH = 0.31;  // a piece this close to the face (the widest seat gap, and a hair) is seated on it
  var SEAT_SINK = 0.06;   // ...or this far into it (the deepest overlap seat)
  var SNAP = 0.75;        // a drag within this of the centre line or flush with an edge lands on it
  var COL_KEY = 0x4ade80, COL_CUT = 0xf97316, COL_HOST = 0xfb923c;
  var IL = NSO_Interlock;
  var L = null;           // this mode's own state while it is the mode in use
  var K;                  // the editor's kit

  var FIELDS = [
    { id: 'length', label: 'Length', value: 25, shapes: ['tongue', 'snap'], title: 'Along the key, in mm' },
    { id: 'width', label: 'Width', value: 5, shapes: ['tongue', 'snap'], title: 'Across the key, in mm' },
    { id: 'diameter', label: 'Diameter', value: 5, shapes: ['pin'], title: 'Of the pin, in mm' },
    { id: 'height', label: 'Height', value: 2, shapes: ['tongue', 'pin', 'snap'], title: 'How far the key stands proud of its own face, in mm' },
    { id: 'ease', label: 'Ease', value: 0.4, shapes: ['tongue', 'pin', 'snap'], title: 'A 45-degree chamfer round the key\'s tip so it finds the socket, in mm. 0 for square.' },
    { id: 'catch', label: 'Catch', value: 0.5, shapes: ['snap'], title: 'How far the snap\'s ridge stands out of each long side, in mm' },
    { id: 'fit', label: 'Fit', value: 0.1, shapes: ['tongue', 'pin', 'snap'], title: 'Clearance per side between key and socket, in mm: the socket is the key grown by this on every side. 0.10 is a close sliding fit on a well-tuned printer; 0.20 is easy.' }
  ];
  var EDGES = ['a', 'b', 'c', 'd'];

  function R() { return K.stage(); }
  function E() { return K.session(); }
  function el(id) { return K.$('asm-il-' + id); }
  function val(id) { var v = Number(el(id).value); return isFinite(v) ? v : 0; }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }

  /* ---------------- the panel ---------------- */

  function panel(body) {
    var h = K.h;
    var shapes = h('div', { cls: 'asm-il-seg', role: 'group', 'aria-label': 'Shape' }, [
      h('button', { type: 'button', cls: 'asm-il-opt', id: 'asm-il-shape-tongue', 'data-shape': 'tongue', text: 'Tongue', title: 'A rectangular bar and its slot' }),
      h('button', { type: 'button', cls: 'asm-il-opt', id: 'asm-il-shape-pin', 'data-shape': 'pin', text: 'Pin', title: 'A round pin and its hole' }),
      h('button', { type: 'button', cls: 'asm-il-opt', id: 'asm-il-shape-snap', 'data-shape': 'snap', text: 'Snap tab', title: 'A tongue with a 45-degree ridge down each long side, and a slot grooved to take it: it clicks in and pulls out' })
    ]);
    var make = h('div', { cls: 'asm-il-seg', role: 'group', 'aria-label': 'Make' }, [
      h('button', { type: 'button', cls: 'asm-il-opt', id: 'asm-il-make-key', 'data-make': 'key', text: 'Key here', title: 'Add the key to the clicked piece, standing out of the clicked face' }),
      h('button', { type: 'button', cls: 'asm-il-opt', id: 'asm-il-make-socket', 'data-make': 'socket', text: 'Socket here', title: 'Cut the socket into the clicked piece, going in from the clicked face' })
    ]);
    var grid = h('div', { cls: 'asm-il-grid' }, FIELDS.map(function (f) {
      return h('label', { cls: 'asm-il-field', id: 'asm-il-f-' + f.id, title: f.title }, [
        h('span', { text: f.label }),
        h('input', { type: 'number', id: 'asm-il-' + f.id, min: '0', step: '0.01', value: String(f.value), inputmode: 'decimal', 'aria-label': f.label + ' in mm' })
      ]);
    }));
    function edge(k, where) {
      return h('label', { cls: 'asm-il-edge asm-il-edge-' + where, title: 'Distance from the key to edge ' + k + ' of the face, in mm - the edge the line marked ' + k + ' runs to on the stage' }, [
        h('span', { cls: 'asm-il-edge-k', text: k }),
        h('input', { type: 'number', id: 'asm-il-' + k, step: '0.01', inputmode: 'decimal', 'aria-label': 'Distance to edge ' + k + ' in mm' })
      ]);
    }
    [
      h('button', { type: 'button', cls: 'asm-chip asm-chip-target', id: 'asm-il-chip', title: 'The face the key stands on, or the socket goes into. Click to pick it again.' }, [
        h('span', { cls: 'asm-chip-n', text: '1' }), h('span', { cls: 'asm-chip-text', id: 'asm-il-chip-text', text: 'Click the face it goes on' })]),
      h('label', { cls: 'asm-il-pair', id: 'asm-il-pair-row', hidden: '' }, [
        h('input', { type: 'checkbox', id: 'asm-il-pair', checked: '' }), h('span', { id: 'asm-il-pair-text' })]),
      h('p', { cls: 'asm-il-note', id: 'asm-il-alone', hidden: '' }),
      h('div', { cls: 'asm-ed-adjust', id: 'asm-il-set' }, [
        make, shapes, grid,
        h('label', { cls: 'asm-il-pair', id: 'asm-il-through-row', title: 'Cut the socket right through the piece instead of stopping at the key\'s height plus the fit' }, [
          h('input', { type: 'checkbox', id: 'asm-il-through' }), h('span', { text: ' socket goes through' })]),
        h('div', { cls: 'asm-ed-label', text: 'From the face\'s edges (mm)' }),
        h('div', { cls: 'asm-il-cross' }, [edge('a', 'top'), edge('d', 'left'), h('div', { cls: 'asm-il-cross-key' }), edge('b', 'right'), edge('c', 'bottom')]),
        h('div', { cls: 'asm-il-turn' }, [
          h('label', { cls: 'asm-il-field', title: 'Turn the key on the face, in degrees' }, [
            h('span', { text: 'Turn' }),
            h('input', { type: 'number', id: 'asm-il-deg', step: '1', value: '0', inputmode: 'decimal', 'aria-label': 'Turn in degrees' })]),
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'asm-il-turn90', text: '+90°', title: 'A quarter turn on the face' })
        ]),
        h('p', { cls: 'asm-ed-readout', id: 'asm-il-readout', 'aria-live': 'polite' }),
        h('div', { cls: 'asm-ed-row' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', id: 'asm-il-apply', text: 'Apply',
            title: 'Add the key and cut the socket as shown. One Undo. The pieces stay where they are.' })
        ])
      ])
    ].forEach(function (n) { body.appendChild(n); });

    el('chip').addEventListener('click', function () { if (live(false)) K.restart(); });
    Array.prototype.forEach.call(body.querySelectorAll('[data-shape]'), function (b) {
      b.addEventListener('click', function () { if (!E() || E().busy) return; prefs.shape = b.getAttribute('data-shape'); changed(); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-make]'), function (b) {
      b.addEventListener('click', function () { if (!E() || E().busy) return; prefs.make = b.getAttribute('data-make'); changed(); });
    });
    FIELDS.forEach(function (f) { el(f.id).addEventListener('input', changed); });
    el('pair').addEventListener('change', changed);
    el('through').addEventListener('change', changed);
    el('deg').addEventListener('input', function () { if (L) { L.deg = val('deg'); changed(); } });
    el('turn90').addEventListener('click', function () {
      if (!live(true)) return;
      L.deg = ((L.deg + 90) % 360 + 360) % 360; el('deg').value = String(L.deg); changed();
    });
    EDGES.forEach(function (k) {
      el(k).addEventListener('change', function () {
        if (!live(true)) return;
        var x = Number(el(k).value);
        if (!isFinite(x)) return;
        var fr = L.host.frame, hs = IL.halfSpan(specNow(), L.deg);
        if (k === 'a') L.cv = fr.v1 - x - hs.v;
        if (k === 'c') L.cv = fr.v0 + x + hs.v;
        if (k === 'd') L.cu = fr.u0 + x + hs.u;
        if (k === 'b') L.cu = fr.u1 - x - hs.u;
        changed();
      });
    });
    el('apply').addEventListener('click', apply);
  }

  var prefs = { shape: 'tongue', make: 'key' };       // kept from one key to the next, and across a close

  function live(needSet) { return !!(L && E() && !E().busy && (!needSet || L.step === 'set')); }

  function specNow() {
    return { shape: prefs.shape, length: val('length'), width: val('width'), diameter: val('diameter'),
             height: val('height'), ease: val('ease'), catch: val('catch'), fit: val('fit') };
  }

  /* ---------------- what is seated on a face ---------------- */

  /* The piece whose face lies against `face` - looking back at it, within a
     seat gap of it (or a seat overlap into it), over its rectangle. Of several,
     the one with the most of its face there. Returns the piece, the gap
     (negative = pressed in) and how far the piece reaches beyond the face. */
  function seatedOn(face) {
    var n = face.n, fr = face.frame, best = null;
    E().pieces.forEach(function (p) {
      if (p === face.piece) return;
      K.triData(p);
      var N = p.triN, s = p.soup, area = 0, gapSum = 0, tri = -1;
      for (var t = 0; t < N.length / 3; t++) {
        if (-(N[t * 3] * n.x + N[t * 3 + 1] * n.y + N[t * 3 + 2] * n.z) < K.FACE_COS) continue;
        var o = t * 9;
        var cx = (s[o] + s[o + 3] + s[o + 6]) / 3, cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3, cz = (s[o + 2] + s[o + 5] + s[o + 8]) / 3;
        var g = n.x * cx + n.y * cy + n.z * cz - face.d;
        if (g < -SEAT_SINK || g > SEAT_REACH) continue;
        var cu = fr.u.x * cx + fr.u.y * cy + fr.u.z * cz, cv = fr.v.x * cx + fr.v.y * cy + fr.v.z * cz;
        if (cu < fr.u0 - 1e-6 || cu > fr.u1 + 1e-6 || cv < fr.v0 - 1e-6 || cv > fr.v1 + 1e-6) continue;
        var ax = s[o + 3] - s[o], ay = s[o + 4] - s[o + 1], az = s[o + 5] - s[o + 2];
        var bx = s[o + 6] - s[o], by = s[o + 7] - s[o + 1], bz = s[o + 8] - s[o + 2];
        var a2 = Math.sqrt(Math.pow(ay * bz - az * by, 2) + Math.pow(az * bx - ax * bz, 2) + Math.pow(ax * by - ay * bx, 2)) / 2;
        area += a2; gapSum += g * a2;
        if (tri < 0) tri = t;
      }
      if (tri < 0 || area < 1e-6) return;
      if (!best || area > best.area) best = { piece: p, area: area, gap: gapSum / area };
    });
    if (!best) return null;
    best.gap = Math.round(best.gap * 1e6) / 1e6;
    return best;
  }

  /* How far a piece reaches along `dir` beyond the plane dir . x = at. */
  function reach(piece, dir, at) {
    var s = piece.soup, hi = -Infinity;
    for (var i = 0; i < s.length; i += 3) {
      var d = dir.x * s[i] + dir.y * s[i + 1] + dir.z * s[i + 2];
      if (d > hi) hi = d;
    }
    return hi - at;
  }

  /* ---------------- the plan ---------------- */

  /* Everything Apply will do, worked out from the face, the fields and where
     the key stands: which piece gets the key, which the socket, and the two
     solids in the WORLD. Heights below are along the way the key points, 0 on
     the clicked face. */
  function plan() {
    if (!L || !L.host) return { ok: false, reason: 'no face picked' };
    var spec = specNow(), c = IL.check(spec);
    if (!c.ok) return { ok: false, reason: c.reason };
    spec = c.spec;
    var face = L.host, fr = face.frame, make = prefs.make;
    var pair = !!(L.partner && el('pair').checked);
    var g = pair ? L.partner.gap : 0;
    var out = make === 'key';
    var nk = out ? face.n.clone() : face.n.clone().negate();
    var vk = out ? fr.v.clone() : fr.v.clone().negate();          // u x vk = nk either way
    var deg = out ? L.deg : -L.deg;                               // ...and the footprint on the face is the same either way
    var o = fr.u.clone().multiplyScalar(L.cu).addScaledVector(fr.v, L.cv).addScaledVector(face.n, face.d);
    var keyTo = out ? face.piece : (pair ? L.partner.piece : null);
    var cutTo = out ? (pair ? L.partner.piece : null) : face.piece;
    /* the key's own face: the clicked face when it stands on this piece, the
       seated piece's face (a gap back from here) when it stands on that one */
    var keyBase = out ? 0 : -g;
    var socketFace = out ? g : 0;
    var tip = keyBase + spec.height;
    var P = { ok: true, spec: spec, make: make, pair: pair, gap: g, keyTo: keyTo, cutTo: cutTo, nk: nk, o: o, notes: [] };
    if (keyTo) {
      var k = IL.key(spec, { embed: EMBED });
      if (!k.ok) return { ok: false, reason: k.reason };
      var ko = o.clone().addScaledVector(nk, keyBase);
      P.keyWorld = IL.place(k.soup, { o: ko.toArray(), u: fr.u.toArray(), v: vk.toArray(), n: nk.toArray() }, deg);
      P.keyVolume = k.volume;
    }
    if (cutTo) {
      var far = reach(cutTo, nk, nk.dot(o));                      // the socket piece's far side
      var through = el('through').checked;
      var to = through ? far + 1 : tip + spec.fit;
      if (!through && to >= far - 1e-6) { to = far + 1; P.breaksThrough = true; P.notes.push('the socket comes out the far side of ' + K.nameOf(cutTo) + ', ' + f2(far - socketFace) + ' mm on'); }
      if (to <= socketFace + 1e-6) return { ok: false, reason: 'the key is no taller than the gap between the two pieces, so there is nothing to cut a socket for' };
      var q = IL.cutter(spec, { from: socketFace - PRE, to: to, peak: keyBase + IL.snapPeak(spec) });
      if (!q.ok) return { ok: false, reason: q.reason };
      P.cutWorld = IL.place(q.soup, { o: o.toArray(), u: fr.u.toArray(), v: vk.toArray(), n: nk.toArray() }, deg);
      P.through = through || !!P.breaksThrough;
      P.socketDepth = (P.through ? far : to) - socketFace;
    }
    var hs = IL.halfSpan(spec, L.deg);
    P.half = hs;
    P.edges = { a: fr.v1 - (L.cv + hs.v), c: (L.cv - hs.v) - fr.v0, d: (L.cu - hs.u) - fr.u0, b: fr.u1 - (L.cu + hs.u) };
    if (P.edges.a < -1e-6 || P.edges.b < -1e-6 || P.edges.c < -1e-6 || P.edges.d < -1e-6) P.notes.push('it hangs over the edge of the face');
    return P;
  }

  /* ---------------- drawing ---------------- */

  function soupMesh(soup, color, opacity, wire) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
    g.computeVertexNormals();
    var grp = new THREE.Group();
    grp.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: color, transparent: opacity < 1, opacity: opacity, depthWrite: opacity >= 1, depthTest: false,
      metalness: 0, roughness: 0.6, emissive: color, emissiveIntensity: 0.25 })));
    if (wire) grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30),
      new THREE.LineBasicMaterial({ color: wire, transparent: true, opacity: 0.95, depthTest: false })));
    grp.position.copy(L.host.piece.offset);
    grp.renderOrder = 5;
    R().group.add(grp);
    return grp;
  }

  function redraw() {
    if (!L) return;
    ['keyMesh', 'cutMesh', 'dims'].forEach(function (k) { K.disposeObj(L[k]); L[k] = null; });
    L.plan = null;
    if (L.step !== 'set') { labels(null); return; }
    var P = plan();
    L.plan = P;
    if (!P.ok) { labels(null); return; }
    if (P.cutWorld) L.cutMesh = soupMesh(P.cutWorld, COL_CUT, 0.28, 0xfdba74);
    if (P.keyWorld) L.keyMesh = soupMesh(P.keyWorld, COL_KEY, 0.9, 0xbbf7d0);
    /* the four distances, each a line from the key to the edge it is measured to */
    var face = L.host, fr = face.frame, hs = P.half, lift = face.d + 0.05;
    function pt(u, v) { return fr.u.clone().multiplyScalar(u).addScaledVector(fr.v, v).addScaledVector(face.n, lift); }
    var seg = {
      a: [pt(L.cu, L.cv + hs.v), pt(L.cu, fr.v1)], c: [pt(L.cu, L.cv - hs.v), pt(L.cu, fr.v0)],
      d: [pt(L.cu - hs.u, L.cv), pt(fr.u0, L.cv)], b: [pt(L.cu + hs.u, L.cv), pt(fr.u1, L.cv)]
    };
    var arr = [];
    EDGES.forEach(function (k) { arr.push(seg[k][0].x, seg[k][0].y, seg[k][0].z, seg[k][1].x, seg[k][1].y, seg[k][1].z); });
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    L.dims = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.9, depthTest: false }));
    L.dims.position.copy(face.piece.offset);
    L.dims.renderOrder = 6;
    R().group.add(L.dims);
    labels(seg, P.edges);
  }

  /* The a / b / c / d tags, pinned to the middle of each line as the view turns. */
  function labels(seg, edges) {
    if (!L.tags) {
      L.tags = {};
      EDGES.forEach(function (k) {
        L.tags[k] = K.h('div', { cls: 'asm-il-tag', 'aria-hidden': 'true' });
        K.$('asm-editor').appendChild(L.tags[k]);
      });
    }
    EDGES.forEach(function (k) {
      var t = L.tags[k];
      if (!seg) { t.hidden = true; t._at = null; return; }
      t.hidden = false;
      t.textContent = k + '  ' + f2(edges[k]);
      t._at = seg[k][0].clone().add(seg[k][1]).multiplyScalar(0.5).add(L.host.piece.offset);
    });
  }
  function tick() {
    if (!L || !L.tags) return;
    var rect = R().dom.getBoundingClientRect();
    EDGES.forEach(function (k) {
      var t = L.tags[k];
      if (!t._at) return;
      var p = t._at.clone().project(R().camera);
      t.style.left = (rect.left + (p.x + 1) / 2 * rect.width) + 'px';
      t.style.top = (rect.top + (1 - p.y) / 2 * rect.height) + 'px';
      t.style.visibility = (p.z < 1) ? 'visible' : 'hidden';
    });
  }

  /* ---------------- where the pointer is on the face ---------------- */

  function rayAt(e) {
    var rect = R().dom.getBoundingClientRect();
    var p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    R().raycaster.setFromCamera(p, R().camera);
    return R().raycaster.ray;
  }
  /* The pointer's place on the clicked face's PLANE, in the face's own (u, v):
     through whatever is drawn over it - the seated piece is - because a key
     under a seated piece is exactly what is being placed. */
  function onFace(e) {
    var ray = rayAt(e), face = L.host, off = face.piece.offset;
    var org = ray.origin.clone().sub(off);                         // the ray, taken back to the world
    var den = ray.direction.dot(face.n);
    if (Math.abs(den) < 1e-6) return null;
    var t = (face.d - org.dot(face.n)) / den;
    if (t <= 0) return null;
    var hit = org.addScaledVector(ray.direction, t);
    return { u: hit.dot(face.frame.u), v: hit.dot(face.frame.v) };
  }

  /* A dragged key lands on the centre line, or flush with an edge, when it is
     within SNAP of one; otherwise on the nearest 0.1 mm from the low edge.
     Typed distances are not snapped - they are what was typed. */
  function snap(cu, cv) {
    var fr = L.host.frame, hs = IL.halfSpan(specNow(), L.deg);
    function one(c, lo, hi, half) {
      var mid = (lo + hi) / 2;
      if (Math.abs(c - mid) < SNAP) return mid;
      if (Math.abs((c - half) - lo) < SNAP) return lo + half;
      if (Math.abs(hi - (c + half)) < SNAP) return hi - half;
      return lo + half + Math.round((c - half - lo) * 10) / 10;
    }
    return { u: one(cu, fr.u0, fr.u1, hs.u), v: one(cv, fr.v0, fr.v1, hs.v) };
  }

  function pointerDown(e) {
    if (!live(true) || !(L.keyMesh || L.cutMesh)) return false;
    var ray = rayAt(e), meshes = [];
    [L.keyMesh, L.cutMesh].forEach(function (g) { if (g) g.traverse(function (c) { if (c.isMesh) meshes.push(c); }); });
    if (!R().raycaster.intersectObjects(meshes, false).length) return false;
    var at = onFace(e);
    if (!at) return false;
    var grab = { du: L.cu - at.u, dv: L.cv - at.v };
    R().dom.style.cursor = 'grabbing';
    function move(ev) {
      var p = onFace(ev);
      if (!p) return;
      var s = snap(p.u + grab.du, p.v + grab.dv);
      L.cu = s.u; L.cv = s.v;
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

  /* ---------------- steps ---------------- */

  function showPair(on) {
    var S = E();
    S.pieces.forEach(function (p) {
      var isHost = on && L.host && p === L.host.piece, isMate = on && L.partner && p === L.partner.piece;
      p.mesh.visible = !on || isHost || isMate;
      p.mesh.position.copy(isMate ? L.host.piece.offset : p.offset);    // the seated piece, where it really sits on this one
      var m = p.mesh.material;
      m.transparent = !!isMate; m.opacity = isMate ? 0.22 : 1; m.depthWrite = !isMate;
      m.color.setHex(isHost ? COL_HOST : 0x38bdf8);
      m.emissive.setHex(isHost ? 0x4a2a0c : 0x0a3a5c);
      m.needsUpdate = true;
    });
  }

  function toHost() {
    L.step = 'host'; L.host = null; L.partner = null; L.plan = null;
    K.disposeObj(L.hostMark); L.hostMark = null;
    K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null;
    showPair(false);
    redraw();
  }

  function pick(hit) {
    L.host = hit.face;
    L.partner = seatedOn(hit.face);
    L.step = 'set';
    K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null;
    K.disposeObj(L.hostMark);
    L.hostMark = K.markFor(hit.face, COL_HOST, 0.22);
    var s = snap(hit.point.dot(hit.face.frame.u), hit.point.dot(hit.face.frame.v));
    L.cu = s.u; L.cv = s.v;
    showPair(true);
    redraw();
    K.frameBox(viewBox(), true);
    K.syncPanel();
  }

  function viewBox() {
    var S = E();
    if (!L || L.step !== 'set') return K.stageBox(S.pieces);
    var box = L.host.piece.box.clone().translate(L.host.piece.offset);
    if (L.partner) box.union(L.partner.piece.box.clone().translate(L.host.piece.offset));
    return box;
  }

  function changed() {
    if (!L) return;
    redraw();
    K.syncPanel();
  }

  function sync() {
    if (!L) return;
    var S = E(), set = L.step === 'set', busy = !!S.busy;
    el('chip-text').textContent = L.host ? (K.nameOf(L.host.piece) + ' · ' + K.faceWord(L.host)) : 'Click the face it goes on';
    el('chip').classList.toggle('is-set', !!L.host);
    el('chip').classList.toggle('is-now', !L.host);
    var pr = el('pair-row'), alone = el('alone');
    pr.hidden = !(set && L.partner);
    alone.hidden = !(set && !L.partner);
    if (set && L.partner) {
      el('pair-text').textContent = ' ' + K.nameOf(L.partner.piece) + ' is seated on it' +
        (Math.abs(L.partner.gap) > 1e-4 ? ' (' + (L.partner.gap > 0 ? 'gap ' : 'overlap ') + f2(Math.abs(L.partner.gap)) + ')' : '') +
        ' — ' + (prefs.make === 'key' ? 'cut the socket in it' : 'add the key to it');
    }
    if (set && !L.partner) alone.textContent = 'Nothing is seated on this face, so this makes the ' + (prefs.make === 'key' ? 'key' : 'socket') + ' only. To pair two pieces, Place one on the other in the Mate tab first.';
    var box = el('set');
    box.classList.toggle('is-idle', !set || busy);
    Array.prototype.forEach.call(box.querySelectorAll('button, input'), function (x) { x.disabled = !set || busy; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-shape]'), function (b) {
      var on = b.getAttribute('data-shape') === prefs.shape; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-make]'), function (b) {
      var on = b.getAttribute('data-make') === prefs.make; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    FIELDS.forEach(function (f) { K.$('asm-il-f-' + f.id).hidden = f.shapes.indexOf(prefs.shape) < 0; });
    var P = L.plan;
    /* a socket is being cut at all: by "socket here", or in the seated piece */
    var cuts = prefs.make === 'socket' || !!(L.partner && el('pair').checked);
    el('through-row').hidden = !cuts;
    K.$('asm-il-f-fit').hidden = !cuts;
    EDGES.forEach(function (k) {
      var inp = el(k);
      if (document.activeElement !== inp) inp.value = (P && P.ok) ? f2(P.edges[k]) : '';
    });
    if (document.activeElement !== el('deg')) el('deg').value = String(Math.round(L.deg * 100) / 100);
    var out = el('readout'), apply = el('apply');
    if (!set) { out.textContent = ''; out.classList.remove('is-bad'); }
    else if (!P || !P.ok) { out.textContent = (P && P.reason) || ''; out.classList.add('is-bad'); }
    else {
      out.classList.remove('is-bad');
      var bits = [];
      if (P.keyTo) bits.push(IL.describe(P.spec, 'key') + ' on ' + K.nameOf(P.keyTo));
      if (P.cutTo) bits.push(IL.describe(P.spec, 'socket').replace(/ × [0-9.]+$/, P.through ? ' × through' : ' × ' + f2(P.socketDepth) + ' deep') + ' in ' + K.nameOf(P.cutTo));
      out.textContent = bits.concat(P.notes).join(' · ');
    }
    apply.disabled = !set || busy || !(P && P.ok);
  }

  /* ---------------- Apply ---------------- */

  function volume(s) { return IL.signedVolume(s); }

  /* One piece's share: the tool carried into the piece's own raw frame, the
     boolean run, and the box the result will have in the world. Nothing is
     changed here - both shares are worked out before either is committed, so
     a refusal on one leaves both pieces as they were. */
  async function work(piece, tool, op) {
    var placed = piece.placed, name = K.nameOf(piece);
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
    if (volume(raw) < 0) {                                      // a mirrored pose turns a solid inside out: wind it back
      for (i = 0; i < raw.length; i += 9) for (var k = 0; k < 3; k++) { var t = raw[i + 3 + k]; raw[i + 3 + k] = raw[i + 6 + k]; raw[i + 6 + k] = t; }
    }
    var r = op === 'union' ? await NSO_unionSoups(hull, raw, { label: 'Adding the key' })
                           : await NSO_subtractSoups(hull, raw, { label: 'Cutting the socket' });
    if (r.cancelled || r.timedOut) return { ok: false, reason: r.cancelled ? 'stopped' : r.reason };
    if (!r.ok || !r.soup || r.soup.length < 9) return { ok: false, reason: name + ': the ' + (op === 'union' ? 'union' : 'cut') + ' ' + (r.reason ? '- ' + r.reason : 'missed') };
    var stats = r.stats || ((typeof NSO_edgeStats === 'function') ? NSO_edgeStats(r.soup) : null);
    if (stats && (stats.open > 0 || stats.nm > 0)) return { ok: false, reason: name + ': the result came back open (' + stats.open + ' open, ' + stats.nm + ' non-manifold edges)' };
    var vh = Math.abs(volume(hull)), vt = Math.abs(volume(raw)), vr = Math.abs(volume(r.soup));
    /* A key that bites the piece shares volume with it; one that does not is
       a loose body beside it. A socket that removes nothing missed. */
    if (op === 'union' && vr > vh + vt - 1e-4) return { ok: false, reason: 'the key would not be joined to ' + name + ' there - there is nothing under it to stand on' };
    if (op !== 'union' && vr > vh - 1e-4) return { ok: false, reason: 'the socket misses ' + name + ' there - nothing would be cut' };
    var box = new THREE.Box3();
    for (i = 0; i < r.soup.length; i += 3) {
      var lp = nsoLocalPointFromRaw(f, [r.soup[i], r.soup[i + 1], r.soup[i + 2]]);
      box.expandByPoint(v.set(lp[0], lp[1], lp[2]).applyMatrix4(mesh.matrixWorld));
    }
    return { ok: true, piece: piece, model: m, soup: r.soup, box: box, op: op, tris: r.soup.length / 9, removed: vh - vr, merged: sol.merged ? sol.note : '' };
  }

  /* Commit one share and put the piece back where its body was. */
  function commitShare(w) {
    var placed = w.piece.placed, idx = state.placed.indexOf(placed);
    var pose = (typeof snapshotPlacedPose === 'function') ? snapshotPlacedPose(idx) : null;
    if (!NSO_sculptCommitRaw(w.model, w.soup, 'interlockReplace', null)) return false;
    var top = state.undoStack[state.undoStack.length - 1];
    if (top && top.type === 'interlockReplace' && top.modelId === w.model.id) top.prevPose = pose;
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

  async function apply() {
    if (!live(true)) return false;
    var S = E(), P = plan();
    if (!P.ok) { K.say(P.reason, true); return false; }
    S.busy = true; K.syncPanel();
    K.say('Working…');
    var result = { ok: false, reason: '', key: null, socket: null };
    try {
      /* Both pieces onto the bed baseline first (a piece dropped and never
         moved rests 0.1 mm higher than a settled one). Settling only moves a
         piece in y, and each solid goes with the piece it is for. */
      var jobs = [];
      if (P.keyTo) jobs.push({ piece: P.keyTo, tool: P.keyWorld, op: 'union' });
      if (P.cutTo) jobs.push({ piece: P.cutTo, tool: P.cutWorld, op: 'subtract' });
      jobs.forEach(function (j) {
        var pl = j.piece.placed;
        pl.mesh.updateMatrixWorld(true);
        var y0 = pl.mesh.position.y;
        if (typeof settlePlacedOnBed === 'function') settlePlacedOnBed(pl);
        pl.mesh.updateMatrixWorld(true);
        var dy = pl.mesh.position.y - y0;
        if (dy) { j.tool = j.tool.slice(); for (var i = 1; i < j.tool.length; i += 3) j.tool[i] += dy; }
      });
      var shares = [];
      for (var n = 0; n < jobs.length; n++) {
        var w = await work(jobs[n].piece, jobs[n].tool, jobs[n].op);
        if (!w.ok) { result.reason = w.reason; break; }
        shares.push(w);
      }
      if (shares.length === jobs.length && jobs.length) {
        await K.asOneStep('Undo: Interlock reverted', async function () {
          var good = true;
          shares.forEach(function (w) { if (good) good = commitShare(w); });
          if (!good) { result.reason = 'the commit was rejected'; return; }
          /* a key that reaches under the plate lifted its piece; the other piece goes up with it */
          var up = 0;
          shares.forEach(function (w) { up = Math.max(up, w.raise || 0); });
          if (up > 0) shares.forEach(function (w) {
            if ((w.raise || 0) >= up - 1e-9) return;
            var pl = w.piece.placed;
            pl.liftY = (pl.liftY || 0) + up - (w.raise || 0);
            applyPlacedXZ(pl, pl.x, pl.z);
          });
          result.raised = up;
          result.ok = true;
        });
      }
      shares.forEach(function (w) { result[w.op === 'union' ? 'key' : 'socket'] = { id: w.piece.id, tris: w.tris, removed: w.removed }; });
    } catch (err) {
      console.error('[interlock]', err);
      result.reason = (err && err.message) || String(err);
    }
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    S.busy = false;
    var msg, bad = !result.ok;
    if (result.ok) {
      var bits = [];
      if (P.keyTo) bits.push(IL.describe(P.spec, 'key') + ' added to ' + K.nameOf(P.keyTo));
      if (P.cutTo) bits.push(IL.describe(P.spec, 'socket').replace(/ × [0-9.]+$/, P.through ? ' × through' : ' × ' + f2(P.socketDepth) + ' deep') +
        ' cut in ' + K.nameOf(P.cutTo) + (P.pair ? ', ' + f2(P.spec.fit) + ' fit per side' : ''));
      msg = bits.join('; ');
      msg = msg.charAt(0).toUpperCase() + msg.slice(1);
      if (result.raised > 1e-6) msg += ' (raised ' + f2(result.raised) + ' mm: the key reaches under the plate)';
      if (typeof setStatus === 'function') setStatus('Interlock: ' + msg);
    } else {
      msg = 'Nothing changed - ' + (result.reason === 'stopped' ? 'stopped' : result.reason);
    }
    L.last = result;
    if (result.ok) { toHost(); K.buildPieces(); K.frameBox(K.stageBox(S.pieces), true); }
    K.syncPanel();
    K.say(result.ok ? msg + '. Click a face for the next, or Return.' : msg, bad);
    return result.ok;
  }

  /* ---------------- the mode ---------------- */

  K = NSO_AsmEditor.mode('lock', {
    label: 'Interlock',
    title: 'Keys and their sockets: a tongue, a pin or a snap tab on a face, placed by dragging or by typed distances, with the matching socket cut in the piece seated on it',
    apart: true,                       // every piece on its own: the faces between seated pieces are the ones to click
    panel: panel,
    enter: function () {
      L = { step: 'host', host: null, partner: null, cu: 0, cv: 0, deg: val('deg') || 0, plan: null, last: null,
            hoverMark: null, hoverFace: null, hostMark: null, keyMesh: null, cutMesh: null, dims: null, tags: null };
      toHost();
    },
    leave: function () {
      if (!L) return;
      ['keyMesh', 'cutMesh', 'dims', 'hostMark', 'hoverMark'].forEach(function (k) { K.disposeObj(L[k]); });
      if (L.tags) EDGES.forEach(function (k) { if (L.tags[k].parentNode) L.tags[k].parentNode.removeChild(L.tags[k]); });
      showPair(false);
      L = null;
    },
    restart: function () { if (L) toHost(); },
    banner: function () {
      if (!L || L.step === 'host') return ['1', 'Click the face it goes on', 'the face a key stands on, or a socket is cut into'];
      return ['2', 'Drag it into place, or type the distances', 'then Apply'];
    },
    hover: function (hit) {
      if (!L) return;
      if (L.step === 'set') { R().dom.style.cursor = 'crosshair'; return; }
      if (!hit) { K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null; R().dom.style.cursor = ''; return; }
      R().dom.style.cursor = 'pointer';
      if (L.hoverFace !== hit.face) { K.disposeObj(L.hoverMark); L.hoverMark = K.markFor(hit.face, COL_HOST, 0.45); L.hoverFace = hit.face; }
    },
    clearHover: function () { if (L && L.step === 'host') { K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null; } },
    click: function (hit, e) {
      if (!L) return;
      if (L.step === 'host') { if (hit) pick(hit); return; }
      /* step 2: a click on the face's plane puts the key there */
      var at = onFace(e);
      if (!at) return;
      var fr = L.host.frame;
      if (at.u < fr.u0 - 2 || at.u > fr.u1 + 2 || at.v < fr.v0 - 2 || at.v > fr.v1 + 2) return;
      var s = snap(at.u, at.v);
      L.cu = s.u; L.cv = s.v;
      changed();
    },
    pointerDown: pointerDown,
    escape: function () {
      if (!L || L.step === 'host') return false;
      toHost(); K.frameBox(K.stageBox(E().pieces), true); K.say(''); K.syncPanel();
      return true;
    },
    sync: sync,
    tick: tick,
    view: function () { return viewBox(); },
    info: function () {
      if (!L) return null;
      var P = L.plan, bx = function (s) {
        if (!s) return null;
        var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (var i = 0; i < s.length; i += 3) for (var k = 0; k < 3; k++) { if (s[i + k] < lo[k]) lo[k] = s[i + k]; if (s[i + k] > hi[k]) hi[k] = s[i + k]; }
        return { min: lo, max: hi };
      };
      return {
        step: L.step, shape: prefs.shape, make: prefs.make,
        host: L.host ? { id: L.host.piece.id, normal: L.host.n.toArray(), d: L.host.d,
          rect: { u0: L.host.frame.u0, u1: L.host.frame.u1, v0: L.host.frame.v0, v1: L.host.frame.v1 } } : null,
        partner: L.partner ? { id: L.partner.piece.id, gap: L.partner.gap } : null,
        cu: L.cu, cv: L.cv, deg: L.deg,
        plan: (P && P.ok) ? { keyTo: P.keyTo ? P.keyTo.id : null, cutTo: P.cutTo ? P.cutTo.id : null, pair: P.pair, through: !!P.through,
          socketDepth: P.socketDepth, edges: P.edges, notes: P.notes, keyBox: bx(P.keyWorld), cutBox: bx(P.cutWorld) } : (P ? { error: P.reason } : null),
        last: L.last
      };
    }
  });
})();
