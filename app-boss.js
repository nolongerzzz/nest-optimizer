/* ============================================================
   Step / Boss - an outline stood out of a face: a step, a pad, a boss, a
   ledge with a sloped underside, or a wedge that thickens a wall at an angle.
   docs/BOSS.md. ADD > Step / Boss opens it. After app-asm-editor.js (whose
   stage it borrows as a SOLO mode - no tab on the Assemble editor, its own
   title) and nso_boss.js (the solid).

   THE EDITOR. The plate's pieces alone on a stage, as in the assembly editor.
     1  Click the face it goes on.
     2  The ghost stands on the face - green, where the bake will put it -
        before anything on the plate changes. Shape it on the panel:
          Outline   Rectangle (Length x Width, corner Radius), Round (Ø) or
                    Drawn: points on the face itself, each its own corner
                    radius - drag a point, pick one to set its radius, add
                    one after it or delete it; or take the Custom shape
                    card's outline (Gen+ > Custom shape) as the points.
          Height    how far it stands out of the face.
          Ramp      0: a flat top. Above 0: the top rises out of the face at
                    that many degrees from the THIN END and runs flat once it
                    reaches Height - a ledge whose underside is a slope. A
                    Height the ramp never reaches makes a wedge.
          Thin end  which side of the outline the ramp starts from, as the
                    face is seen: Bottom (the default - on a wall, a ledge
                    whose underside prints without support), Top, Left,
                    Right.
        Place it by dragging the ghost on the face, or by typing a, b, c, d -
        its distances from the face's four edges, exact - and Turn.
     3  Apply: the solid is unioned into the piece. One Undo; the piece does
        not move. The stage goes back to step 1 for the next one.

   WHAT IT REUSES. The face under a click, its rectangle and its marks are the
   editor's (NSO_AsmEditor.mode's kit). The union, the raw-frame mapping, the
   refusals and the commit that keeps the piece where it stood are the
   editor's toolShare / commitShare - the same path Interlock's key takes.
   The outline of a rectangle or drawn points is NSO_CustomShape's.

   PAINT SCOPE: WHOLE-PIECE. A boolean replaces every triangle on the piece,
   so a piece with painted faces is refused, in words, as Interlock and
   Attach refuse it.
   ============================================================ */
(function () {
  'use strict';
  if (typeof NSO_AsmEditor === 'undefined' || !NSO_AsmEditor.mode || typeof NSO_Boss === 'undefined') return;

  var EMBED = 0.4;
  var SNAP = 0.75;
  var COL_BOSS = 0x4ade80, COL_HOST = 0xfb923c, COL_HANDLE = 0xf8fafc, COL_PICK = 0xfacc15;
  var BS = NSO_Boss;
  var L = null;            // the mode's state while it is in use
  var K;

  var FIELDS = [
    { id: 'length', label: 'Length', value: 20, outlines: ['rect'], title: 'Along the step, in mm' },
    { id: 'width', label: 'Width', value: 10, outlines: ['rect'], title: 'Across the step, in mm' },
    { id: 'radius', label: 'Radius', value: 1, outlines: ['rect'], title: 'The radius of all four corners, in mm. 0 for square.' },
    { id: 'diameter', label: 'Diameter', value: 10, outlines: ['round'], title: 'Of the round boss, in mm' },
    { id: 'height', label: 'Height', value: 3, outlines: ['rect', 'round', 'custom'], title: 'How far it stands out of the face, in mm (with a ramp: where the ramp levels off)' },
    { id: 'ramp', label: 'Ramp', value: 0, outlines: ['rect', 'round', 'custom'], title: 'The top rises out of the face at this angle from the thin end, then runs flat at Height. 0: a flat top. 45 on a wall, thin end at the bottom: a ledge that prints without support.' }
  ];
  var EDGES = ['a', 'b', 'c', 'd'];
  var THIN = [['down', 'Bottom'], ['up', 'Top'], ['left', 'Left'], ['right', 'Right']];

  function R() { return K.stage(); }
  function E() { return K.session(); }
  function el(id) { return K.$('boss-' + id); }
  function val(id) { var v = Number(el(id).value); return isFinite(v) ? v : 0; }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }

  var prefs = { outline: 'rect', thin: 'down' };     // kept from one to the next, and across a close
  var drawn = null;                                  // the drawn points, boss-local mm: [{x, y, r}]

  /* ---------------- the panel ---------------- */

  function panel(body) {
    var h = K.h;
    function seg(attr, list, label) {
      return h('div', { cls: 'asm-il-seg', role: 'group', 'aria-label': label }, list.map(function (o) {
        var a = { type: 'button', cls: 'asm-il-opt', id: 'boss-' + attr + '-' + o[0], text: o[1], title: o[2] || o[1] };
        a['data-' + attr] = o[0];
        return h('button', a);
      }));
    }
    var grid = h('div', { cls: 'asm-il-grid' }, FIELDS.map(function (f) {
      return h('label', { cls: 'asm-il-field', id: 'boss-f-' + f.id, title: f.title }, [
        h('span', { text: f.label }),
        h('input', { type: 'number', id: 'boss-' + f.id, min: '0', step: f.id === 'ramp' ? '1' : '0.01', value: String(f.value), inputmode: 'decimal',
          'aria-label': f.label + (f.id === 'ramp' ? ' in degrees' : ' in mm') })
      ]);
    }));
    function edge(k, where) {
      return h('label', { cls: 'asm-il-edge asm-il-edge-' + where, title: 'Distance from the step to edge ' + k + ' of the face, in mm - the edge the line marked ' + k + ' runs to on the stage' }, [
        h('span', { cls: 'asm-il-edge-k', text: k }),
        h('input', { type: 'number', id: 'boss-' + k, step: '0.01', inputmode: 'decimal', 'aria-label': 'Distance to edge ' + k + ' in mm' })
      ]);
    }
    [
      h('button', { type: 'button', cls: 'asm-chip asm-chip-target', id: 'boss-chip', title: 'The face it stands on. Click to pick it again.' }, [
        h('span', { cls: 'asm-chip-n', text: '1' }), h('span', { cls: 'asm-chip-text', id: 'boss-chip-text', text: 'Click the face it goes on' })]),
      h('div', { cls: 'asm-ed-adjust', id: 'boss-set' }, [
        h('div', { cls: 'asm-ed-label', text: 'Outline' }),
        seg('outline', [['rect', 'Rectangle', 'Length × Width, rounded corners'], ['round', 'Round', 'A round boss'], ['custom', 'Drawn', 'Points you put on the face, each corner its own radius']], 'Outline'),
        h('div', { cls: 'boss-drawn', id: 'boss-drawn', hidden: '' }, [
          h('p', { cls: 'asm-il-note', id: 'boss-drawn-note', text: 'Drag a white point on the face to move it; click one to pick it.' }),
          h('div', { cls: 'asm-il-turn' }, [
            h('label', { cls: 'asm-il-field', title: 'The picked corner\'s radius, in mm' }, [
              h('span', { text: 'Point R' }),
              h('input', { type: 'number', id: 'boss-pt-r', min: '0', step: '0.1', inputmode: 'decimal', 'aria-label': 'Picked point radius in mm' })]),
            h('button', { type: 'button', cls: 'btn btn-secondary', id: 'boss-pt-add', text: '+ point', title: 'Add a point halfway along the side after the picked one' }),
            h('button', { type: 'button', cls: 'btn btn-secondary', id: 'boss-pt-del', text: 'Delete', title: 'Remove the picked point (three is the least)' })
          ]),
          h('div', { cls: 'asm-ed-row' }, [
            h('button', { type: 'button', cls: 'btn btn-secondary', id: 'boss-pt-from-rect', text: 'Start from rectangle', title: 'Put the points back on the corners of the Length × Width rectangle' }),
            h('button', { type: 'button', cls: 'btn btn-secondary', id: 'boss-pt-from-cs', text: 'Use Custom shape', title: 'Take the outline drawn on the Custom shape card (Gen+ > Custom shape): its points and corner radii' })
          ])
        ]),
        grid,
        h('div', { cls: 'asm-ed-label', id: 'boss-thin-label', text: 'Ramp starts from (thin end)' }),
        seg('thin', THIN.map(function (t) { return [t[0], t[1], 'The ramp rises from the ' + t[1].toLowerCase() + ' of the outline, as the face is seen'] }), 'Thin end'),
        h('div', { cls: 'asm-ed-label', text: 'From the face\'s edges (mm)' }),
        h('div', { cls: 'asm-il-cross' }, [edge('a', 'top'), edge('d', 'left'), h('div', { cls: 'asm-il-cross-key' }), edge('b', 'right'), edge('c', 'bottom')]),
        h('div', { cls: 'asm-il-turn' }, [
          h('label', { cls: 'asm-il-field', title: 'Turn the step on the face, in degrees' }, [
            h('span', { text: 'Turn' }),
            h('input', { type: 'number', id: 'boss-deg', step: '1', value: '0', inputmode: 'decimal', 'aria-label': 'Turn in degrees' })]),
          h('button', { type: 'button', cls: 'btn btn-secondary', id: 'boss-turn90', text: '+90°', title: 'A quarter turn on the face' })
        ]),
        h('p', { cls: 'asm-ed-readout', id: 'boss-readout', 'aria-live': 'polite' }),
        h('div', { cls: 'asm-ed-row' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', id: 'boss-apply', text: 'Apply',
            title: 'Add the step the ghost shows to the piece. One Undo. The piece stays where it is.' })
        ])
      ])
    ].forEach(function (n) { body.appendChild(n); });

    el('chip').addEventListener('click', function () { if (live(false)) K.restart(); });
    Array.prototype.forEach.call(body.querySelectorAll('[data-outline]'), function (b) {
      b.addEventListener('click', function () {
        if (!E() || E().busy) return;
        prefs.outline = b.getAttribute('data-outline');
        if (prefs.outline === 'custom' && !drawn) drawn = rectPoints();
        changed();
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-thin]'), function (b) {
      b.addEventListener('click', function () { if (!E() || E().busy) return; prefs.thin = b.getAttribute('data-thin'); changed(); });
    });
    FIELDS.forEach(function (f) { el(f.id).addEventListener('input', changed); });
    el('deg').addEventListener('input', function () { if (L) { L.deg = val('deg'); changed(); } });
    el('turn90').addEventListener('click', function () {
      if (!live(true)) return;
      L.deg = ((L.deg + 90) % 360 + 360) % 360; el('deg').value = String(L.deg); changed();
    });
    EDGES.forEach(function (k) {
      el(k).addEventListener('change', function () {
        if (!live(true)) return;
        var x = Number(el(k).value), sp = spanNow();
        if (!isFinite(x) || !sp) return;
        var fr = L.fr;
        if (k === 'a') L.cv = fr.v1 - x - sp.v1;
        if (k === 'c') L.cv = fr.v0 + x - sp.v0;
        if (k === 'd') L.cu = fr.u0 + x - sp.u0;
        if (k === 'b') L.cu = fr.u1 - x - sp.u1;
        changed();
      });
    });
    el('pt-r').addEventListener('input', function () {
      if (!drawn || L == null || L.pick == null || !drawn[L.pick]) return;
      var r = Number(el('pt-r').value);
      if (isFinite(r) && r >= 0) { drawn[L.pick].r = r; changed(); }
    });
    el('pt-add').addEventListener('click', function () {
      if (!drawn || !live(true)) return;
      var i = L.pick == null ? drawn.length - 1 : L.pick, j = (i + 1) % drawn.length;
      drawn.splice(i + 1, 0, { x: (drawn[i].x + drawn[j].x) / 2, y: (drawn[i].y + drawn[j].y) / 2, r: 0 });
      L.pick = i + 1; changed();
    });
    el('pt-del').addEventListener('click', function () {
      if (!drawn || !live(true) || L.pick == null || drawn.length <= 3) return;
      drawn.splice(L.pick, 1); L.pick = null; changed();
    });
    el('pt-from-rect').addEventListener('click', function () { if (!live(true)) return; drawn = rectPoints(); L.pick = null; changed(); });
    el('pt-from-cs').addEventListener('click', function () {
      if (!live(true)) return;
      var got = fromCustomShape();
      if (!got.ok) { K.say(got.reason, true); return; }
      drawn = got.points; L.pick = null; prefs.outline = 'custom';
      K.say('Took the Custom shape card\'s outline: ' + drawn.length + ' points');
      changed();
    });
    el('apply').addEventListener('click', apply);
  }

  function live(needSet) { return !!(L && E() && !E().busy && (!needSet || L.step === 'set')); }

  function rectPoints() {
    var Lh = Math.max(0.1, val('length')) / 2, Wh = Math.max(0.1, val('width')) / 2, r = Math.max(0, val('radius'));
    return [{ x: -Lh, y: -Wh, r: r }, { x: Lh, y: -Wh, r: r }, { x: Lh, y: Wh, r: r }, { x: -Lh, y: Wh, r: r }];
  }

  /* The Custom shape card's outline: the spec it keeps in this browser
     (app-custom-shape.js, 'nso.customShape.v1'), its points and their outside
     radii, centred on their box. */
  function fromCustomShape() {
    var sp = null;
    try { var raw = window.localStorage && window.localStorage.getItem('nso.customShape.v1'); if (raw) sp = JSON.parse(raw); } catch (e) { sp = null; }
    if (!sp || !Array.isArray(sp.points) || sp.points.length < 3) return { ok: false, reason: 'The Custom shape card has no outline yet - open Gen+ > Custom shape and draw one first' };
    if ((sp.sides || []).some(function (s) { return s && Math.abs(+s.bulge || 0) > 1e-6; })) {
      return { ok: false, reason: 'That outline has curved sides - a drawn step takes straight sides and rounded corners. Straighten them on the Custom shape card (Curve 0), or round the corners instead' };
    }
    var pts = sp.points.map(function (p) { return { x: +p.x || 0, y: +p.y || 0, r: Math.max(0, +p.r || 0) }; });
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    pts.forEach(function (p) { lo[0] = Math.min(lo[0], p.x); lo[1] = Math.min(lo[1], p.y); hi[0] = Math.max(hi[0], p.x); hi[1] = Math.max(hi[1], p.y); });
    var cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    return { ok: true, points: pts.map(function (p) { return { x: p.x - cx, y: p.y - cy, r: p.r }; }) };
  }

  /* the face's "up", as it is seen: the world's up laid on the face; on a top
     or bottom face, the face's own v */
  function faceUp() {
    var fr = L.fr, up = K.V(0, 1, 0);
    var a = up.dot(fr.u), b = up.dot(fr.v), m = Math.hypot(a, b);
    if (m < 0.2) return [0, 1];
    return [a / m, b / m];
  }

  /* the spec as the panel reads now, with the ramp's direction worked out in
     the solid's own frame (before its turn) */
  function specNow() {
    var s = { outline: prefs.outline, length: val('length'), width: val('width'), radius: val('radius'),
              diameter: val('diameter'), height: val('height'), ramp: val('ramp'), points: drawn || [] };
    if (L && L.host) {
      var up = faceUp(), d;
      if (prefs.thin === 'down') d = up;
      else if (prefs.thin === 'up') d = [-up[0], -up[1]];
      else if (prefs.thin === 'left') d = [up[1], -up[0]];       // thin on the left: thicker toward the right
      else d = [-up[1], up[0]];
      var t = -L.deg * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
      s.rampDir = Math.atan2(d[0] * si + d[1] * co, d[0] * co - d[1] * si) * 180 / Math.PI;
    }
    return s;
  }

  function spanNow() {
    var o = BS.outline(specNow());
    return o.ok ? BS.span(o.loop, L ? L.deg : 0) : null;
  }

  /* ---------------- the plan ---------------- */

  function plan() {
    if (!L || !L.host) return { ok: false, reason: 'no face picked' };
    var spec = specNow(), b = BS.build(spec, { embed: EMBED });
    if (!b.ok) return { ok: false, reason: b.reason, at: b.at };
    var face = L.host, fr = L.fr;
    var o = fr.u.clone().multiplyScalar(L.cu).addScaledVector(fr.v, L.cv).addScaledVector(face.n, face.d);
    var F = { o: o.toArray(), u: fr.u.toArray(), v: fr.v.toArray(), n: face.n.toArray() };
    var sp = BS.span(b.loop, L.deg);
    var P = { ok: true, spec: b.spec, build: b, world: BS.place(b.soup, F, L.deg), frame: F, span: sp, notes: [] };
    P.edges = { a: fr.v1 - (L.cv + sp.v1), c: (L.cv + sp.v0) - fr.v0, d: (L.cu + sp.u0) - fr.u0, b: fr.u1 - (L.cu + sp.u1) };
    if (P.edges.a < -1e-6 || P.edges.b < -1e-6 || P.edges.c < -1e-6 || P.edges.d < -1e-6) P.notes.push('it hangs over the edge of the face');
    if (b.ramped && b.crease == null) P.notes.push('a wedge: the ramp never levels off - it stands ' + f2(b.top) + ' at its thick end');
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
      metalness: 0, roughness: 0.6, emissive: color, emissiveIntensity: 0.25, side: THREE.DoubleSide })));
    if (wire) grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30),
      new THREE.LineBasicMaterial({ color: wire, transparent: true, opacity: 0.95, depthTest: false })));
    grp.position.copy(L.host.piece.offset);
    grp.renderOrder = 5;
    R().group.add(grp);
    return grp;
  }

  /* a drawn point, boss-local, on the face in the world */
  function pointWorld(p) {
    var fr = L.fr, a = L.deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    var x = p.x * co - p.y * si, y = p.x * si + p.y * co;
    return fr.u.clone().multiplyScalar(L.cu + x).addScaledVector(fr.v, L.cv + y).addScaledVector(L.host.n, L.host.d + 0.05);
  }

  function redraw() {
    if (!L) return;
    ['bossMesh', 'dims', 'handles'].forEach(function (k) { K.disposeObj(L[k]); L[k] = null; });
    L.plan = null;
    if (L.step !== 'set') { labels(null); return; }
    var P = plan();
    L.plan = P;
    if (P.ok) L.bossMesh = soupMesh(P.world, COL_BOSS, 0.62, 0xbbf7d0);
    if (prefs.outline === 'custom' && drawn) drawHandles(P);
    if (!P.ok) { labels(null); return; }
    var face = L.host, fr = L.fr, sp = P.span, lift = face.d + 0.05;
    function pt(u, v) { return fr.u.clone().multiplyScalar(u).addScaledVector(fr.v, v).addScaledVector(face.n, lift); }
    var mu = L.cu + (sp.u0 + sp.u1) / 2, mv = L.cv + (sp.v0 + sp.v1) / 2;
    var seg = {
      a: [pt(mu, L.cv + sp.v1), pt(mu, fr.v1)], c: [pt(mu, L.cv + sp.v0), pt(mu, fr.v0)],
      d: [pt(L.cu + sp.u0, mv), pt(fr.u0, mv)], b: [pt(L.cu + sp.u1, mv), pt(fr.u1, mv)]
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

  /* the drawn outline's points, as discs on the face: white, the picked one yellow */
  function drawHandles() {
    var grp = new THREE.Group(), size = handleSize();
    drawn.forEach(function (p, i) {
      var m = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({
        color: i === L.pick ? COL_PICK : COL_HANDLE, depthTest: false, transparent: true, opacity: 0.95 }));
      m.position.copy(pointWorld(p));
      m.userData.bossPoint = i;
      m.renderOrder = 7;
      grp.add(m);
    });
    /* the points' own polygon, so a point is seen to belong to its corner */
    var arr = [];
    drawn.forEach(function (p, i) { var a = pointWorld(p), b = pointWorld(drawn[(i + 1) % drawn.length]); arr.push(a.x, a.y, a.z, b.x, b.y, b.z); });
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    var ln = new THREE.LineSegments(lg, new THREE.LineDashedMaterial({ color: COL_HANDLE, dashSize: 0.8, gapSize: 0.6, transparent: true, opacity: 0.7, depthTest: false }));
    ln.computeLineDistances();
    ln.renderOrder = 6;
    grp.add(ln);
    grp.position.copy(L.host.piece.offset);
    R().group.add(grp);
    L.handles = grp;
  }
  function handleSize() {
    var fr = L.fr;
    return Math.max(0.25, Math.min(1.2, Math.max(fr.u1 - fr.u0, fr.v1 - fr.v0) / 90));
  }

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

  /* ---------------- the pointer on the face ---------------- */

  function rayAt(e) {
    var rect = R().dom.getBoundingClientRect();
    var p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    R().raycaster.setFromCamera(p, R().camera);
    return R().raycaster.ray;
  }
  function onFace(e) {
    var ray = rayAt(e), face = L.host, off = face.piece.offset;
    var org = ray.origin.clone().sub(off);
    var den = ray.direction.dot(face.n);
    if (Math.abs(den) < 1e-6) return null;
    var t = (face.d - org.dot(face.n)) / den;
    if (t <= 0) return null;
    var hit = org.addScaledVector(ray.direction, t);
    return { u: hit.dot(L.fr.u), v: hit.dot(L.fr.v) };
  }

  /* A dragged step lands on the face's centre line or flush with an edge
     within SNAP of one; otherwise on a 0.1 mm step. Typed distances are exact. */
  function snap(cu, cv) {
    var fr = L.fr, sp = spanNow() || { u0: 0, u1: 0, v0: 0, v1: 0 };
    function one(c, lo, hi, s0, s1) {
      var mid = (lo + hi) / 2, m = c + (s0 + s1) / 2;
      if (Math.abs(m - mid) < SNAP) return mid - (s0 + s1) / 2;
      if (Math.abs(c + s0 - lo) < SNAP) return lo - s0;
      if (Math.abs(hi - (c + s1)) < SNAP) return hi - s1;
      return lo - s0 + Math.round((c + s0 - lo) * 10) / 10;
    }
    return { u: one(cu, fr.u0, fr.u1, sp.u0, sp.u1), v: one(cv, fr.v0, fr.v1, sp.v0, sp.v1) };
  }

  /* a press on a drawn point drags that point; on the ghost, the whole step */
  function pointerDown(e) {
    if (!live(true)) return false;
    rayAt(e);
    if (L.handles) {
      var hp = R().raycaster.intersectObjects(L.handles.children.filter(function (c) { return c.isMesh; }), false);
      if (hp.length) return dragPoint(hp[0].object.userData.bossPoint);
    }
    if (!L.bossMesh) return false;
    var meshes = [];
    L.bossMesh.traverse(function (c) { if (c.isMesh) meshes.push(c); });
    if (!R().raycaster.intersectObjects(meshes, false).length) return false;
    var at = onFace(e);
    if (!at) return false;
    var grab = { du: L.cu - at.u, dv: L.cv - at.v };
    return follow(function (p) { var s = snap(p.u + grab.du, p.v + grab.dv); L.cu = s.u; L.cv = s.v; });
  }
  function dragPoint(i) {
    L.pick = i;
    changed();
    var a = -L.deg * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
    return follow(function (p) {
      var x = p.u - L.cu, y = p.v - L.cv;
      drawn[i].x = Math.round((x * co - y * si) * 10) / 10;
      drawn[i].y = Math.round((x * si + y * co) * 10) / 10;
    });
  }
  function follow(onMove) {
    R().dom.style.cursor = 'grabbing';
    function move(ev) { var p = onFace(ev); if (!p) return; onMove(p); redraw(); sync(); }
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

  function showHost(on) {
    E().pieces.forEach(function (p) {
      var isHost = on && L.host && p === L.host.piece;
      p.mesh.visible = !on || isHost;
      var m = p.mesh.material;
      m.transparent = false; m.opacity = 1; m.depthWrite = true;
      m.color.setHex(isHost ? COL_HOST : 0x38bdf8);
      m.emissive.setHex(isHost ? 0x4a2a0c : 0x0a3a5c);
      m.needsUpdate = true;
    });
  }

  function toHost() {
    L.step = 'host'; L.host = null; L.plan = null; L.pick = null;
    K.disposeObj(L.hostMark); L.hostMark = null;
    K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null;
    showHost(false);
    redraw();
  }

  /* The face's rectangle, upright: on a wall, v points up the wall (so a, the
     panel's top edge, is the wall's top) - the editor's frame is the smallest
     rectangle round the face and may point either way along it. Turned a half
     turn about n when it points down: u x v = n still. */
  function upright(face) {
    var fr = face.frame;
    if (Math.abs(face.n.y) > 0.9 || fr.v.y >= 0) return fr;
    return { u: fr.u.clone().negate(), v: fr.v.clone().negate(), u0: -fr.u1, u1: -fr.u0, v0: -fr.v1, v1: -fr.v0 };
  }

  function pick(hit) {
    L.host = hit.face;
    L.fr = upright(hit.face);
    L.step = 'set';
    K.disposeObj(L.hoverMark); L.hoverMark = null; L.hoverFace = null;
    K.disposeObj(L.hostMark);
    L.hostMark = K.markFor(hit.face, COL_HOST, 0.22);
    var s = snap(hit.point.dot(L.fr.u), hit.point.dot(L.fr.v));
    L.cu = s.u; L.cv = s.v;
    showHost(true);
    redraw();
    K.frameBox(viewBox(), true);
    K.syncPanel();
  }

  function viewBox() {
    if (!L || L.step !== 'set') return K.stageBox(E().pieces);
    return L.host.piece.box.clone().translate(L.host.piece.offset);
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
    var box = el('set');
    box.classList.toggle('is-idle', !set || busy);
    Array.prototype.forEach.call(box.querySelectorAll('button, input'), function (x) { x.disabled = !set || busy; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-outline]'), function (b) {
      var on = b.getAttribute('data-outline') === prefs.outline; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-thin]'), function (b) {
      var on = b.getAttribute('data-thin') === prefs.thin; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    FIELDS.forEach(function (f) { K.$('boss-f-' + f.id).hidden = f.outlines.indexOf(prefs.outline) < 0; });
    var ramped = val('ramp') > 0;
    el('thin-label').hidden = !ramped;
    Array.prototype.forEach.call(box.querySelectorAll('[data-thin]'), function (b) { b.parentNode.hidden = !ramped; });
    var custom = prefs.outline === 'custom';
    el('drawn').hidden = !custom;
    if (custom) {
      var has = L.pick != null && drawn && drawn[L.pick];
      el('pt-r').disabled = !set || busy || !has;
      el('pt-del').disabled = !set || busy || !has || drawn.length <= 3;
      if (document.activeElement !== el('pt-r')) el('pt-r').value = has ? String(drawn[L.pick].r) : '';
      el('drawn-note').textContent = has ? 'Point ' + (L.pick + 1) + ' of ' + drawn.length + ' picked - drag it, set its radius, add one after it or delete it.'
        : 'Drag a white point on the face to move it; click one to pick it.';
    }
    var P = L.plan;
    EDGES.forEach(function (k) {
      var inp = el(k);
      if (document.activeElement !== inp) inp.value = (P && P.ok) ? f2(P.edges[k]) : '';
    });
    if (document.activeElement !== el('deg')) el('deg').value = String(Math.round(L.deg * 100) / 100);
    var out = el('readout'), applyBtn = el('apply');
    if (!set) { out.textContent = ''; out.classList.remove('is-bad'); }
    else if (!P || !P.ok) { out.textContent = (P && P.reason) || ''; out.classList.add('is-bad'); }
    else {
      out.classList.remove('is-bad');
      out.textContent = [BS.describe(P.spec) + ' on ' + K.nameOf(L.host.piece) + ' · adds ' + f2(volumeAbove(P)) + ' mm³'].concat(P.notes).join(' · ');
    }
    applyBtn.disabled = !set || busy || !(P && P.ok);
  }

  /* what the step adds above the face: its solid less the part sunk in */
  function volumeAbove(P) {
    var o = BS.outline(P.spec), a = 0, Lp = o.ok ? o.loop : [];
    for (var i = 0; i < Lp.length; i++) { var p = Lp[i], q = Lp[(i + 1) % Lp.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.max(0, P.build.volume - Math.abs(a / 2) * EMBED);
  }

  /* ---------------- Apply ---------------- */

  async function apply() {
    if (!live(true)) return false;
    var S = E(), P = plan();
    if (!P.ok) { K.say(P.reason, true); return false; }
    S.busy = true; K.syncPanel();
    K.say('Working…');
    var result = { ok: false, reason: '' }, piece = L.host.piece;
    try {
      var pl = piece.placed, tool = P.world;
      pl.mesh.updateMatrixWorld(true);
      var y0 = pl.mesh.position.y;
      if (typeof settlePlacedOnBed === 'function') settlePlacedOnBed(pl);
      pl.mesh.updateMatrixWorld(true);
      var dy = pl.mesh.position.y - y0;
      if (dy) { tool = tool.slice(); for (var i = 1; i < tool.length; i += 3) tool[i] += dy; }
      var w = await K.toolShare(piece, tool, 'union', {
        label: 'Adding the step',
        noJoin: function (name) { return 'the step would not be joined to ' + name + ' there - there is nothing under it to stand on'; }
      });
      if (!w.ok) result.reason = w.reason;
      else {
        await K.asOneStep('Undo: Step / Boss reverted', async function () {
          if (!K.commitShare(w, 'bossReplace')) { result.reason = 'the commit was rejected'; return; }
          result.ok = true; result.raised = w.raise || 0; result.tris = w.tris;
        });
      }
    } catch (err) {
      console.error('[boss]', err);
      result.reason = (err && err.message) || String(err);
    }
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    S.busy = false;
    var msg;
    if (result.ok) {
      msg = BS.describe(P.spec) + ' added to ' + K.nameOf(piece);
      msg = msg.charAt(0).toUpperCase() + msg.slice(1);
      if (result.raised > 1e-6) msg += ' (raised ' + f2(result.raised) + ' mm: it reaches under the plate)';
      if (typeof setStatus === 'function') setStatus('Step / Boss: ' + msg);
    } else msg = 'Nothing changed - ' + (result.reason === 'stopped' ? 'stopped' : result.reason);
    L.last = result;
    if (result.ok) { toHost(); K.buildPieces(); K.frameBox(K.stageBox(S.pieces), true); }
    K.syncPanel();
    K.say(result.ok ? msg + '. Click a face for the next, or Return.' : msg, !result.ok);
    return result.ok;
  }

  /* ---------------- the mode ---------------- */

  K = NSO_AsmEditor.mode('boss', {
    label: 'Step / Boss',
    title: 'An outline stood out of a face: a step, a boss, a ledge or a wedge',
    solo: { title: 'Step / Boss', returnTo: 'btn-boss' },
    apart: true,
    panel: panel,
    enter: function () {
      L = { step: 'host', host: null, cu: 0, cv: 0, deg: val('deg') || 0, plan: null, last: null, pick: null,
            hoverMark: null, hoverFace: null, hostMark: null, bossMesh: null, dims: null, handles: null, tags: null };
      toHost();
    },
    leave: function () {
      if (!L) return;
      ['bossMesh', 'dims', 'handles', 'hostMark', 'hoverMark'].forEach(function (k) { K.disposeObj(L[k]); });
      if (L.tags) EDGES.forEach(function (k) { if (L.tags[k].parentNode) L.tags[k].parentNode.removeChild(L.tags[k]); });
      showHost(false);
      L = null;
    },
    restart: function () { if (L) toHost(); },
    banner: function () {
      if (!L || L.step === 'host') return ['1', 'Click the face it goes on', 'the face the step stands out of'];
      return ['2', 'Shape it, drag it into place or type the distances', 'the green ghost is what Apply adds'];
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
      /* a click on a drawn point picks it; elsewhere on the face's plane, the step goes there */
      if (L.handles) {
        rayAt(e);
        var hp = R().raycaster.intersectObjects(L.handles.children.filter(function (c) { return c.isMesh; }), false);
        if (hp.length) { L.pick = hp[0].object.userData.bossPoint; changed(); return; }
      }
      var at = onFace(e);
      if (!at) return;
      var fr = L.fr;
      if (at.u < fr.u0 - 2 || at.u > fr.u1 + 2 || at.v < fr.v0 - 2 || at.v > fr.v1 + 2) return;
      var sp = spanNow() || { u0: 0, u1: 0, v0: 0, v1: 0 };
      var s = snap(at.u - (sp.u0 + sp.u1) / 2, at.v - (sp.v0 + sp.v1) / 2);
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
        step: L.step, outline: prefs.outline, thin: prefs.thin, points: drawn ? drawn.map(function (p) { return [p.x, p.y, p.r]; }) : null, pick: L.pick,
        host: L.host ? { id: L.host.piece.id, normal: L.host.n.toArray(), d: L.host.d,
          rect: { u0: L.fr.u0, u1: L.fr.u1, v0: L.fr.v0, v1: L.fr.v1 },
          u: L.fr.u.toArray(), v: L.fr.v.toArray() } : null,
        cu: L.cu, cv: L.cv, deg: L.deg,
        plan: (P && P.ok) ? { edges: P.edges, notes: P.notes, box: bx(P.world), volume: P.build.volume, above: volumeAbove(P),
          rampDir: P.spec.rampDir, crease: P.build.crease, top: P.build.top, ghost: !!L.bossMesh } : (P ? { error: P.reason } : null),
        last: L.last
      };
    }
  });
})();
