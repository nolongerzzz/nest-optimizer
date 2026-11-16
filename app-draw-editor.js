/* ============================================================
   The Draw editor - DRAW > Draw editor. docs/DRAW.md.
   After nso_sketch.js (the geometry: outlines, solids) and app-connect.js
   (NSO_connectCommit, for Add to plate).

   WHY IT EXISTS. Connect's freehand Draw drew on the plate and the pieces
   themselves: a stroke went where a ray from the pointer landed, so what could
   be drawn was what the view could reach, and every orbit fought the stroke.
   This is a flat sheet instead, the way a laser / pen tool's pencil works: a
   millimetre grid, rulers, and the drawing on it - no plate, no pieces, no
   view to turn. What is drawn here is put on a piece afterwards, on any face,
   by DRAW > Connect (app-draw-connect.js).

   THE SHEET. Millimetres, x right, y up, a grid that refines as you zoom. The
   wheel zooms about the pointer, a right- or middle-drag (or Space + drag)
   pans, F fits the drawing.

   TOOLS (left):
     Select  V   click an object to pick it (Shift adds), drag to move what is
                 picked, drag on empty sheet for a box, the corner handles
                 scale (aspect kept while the lock is on). Arrows nudge 0.1 mm
                 (Shift 1 mm).
     Pencil  P   press and drag: a freehand stroke, smoothed on release
                 (NSO_Sketch.smooth). A line that ends where it began is
                 closed (a ring).
     Line    L   click, click, ...: a polyline; double-click or Enter ends it,
                 a click on the first point closes it. Shift: 15 degree steps.
     Rect    R   drag a rectangle (Shift: a square).
     Ellipse E   drag an ellipse (Shift: a circle).

   PROCESS TYPE (top): every object is a DRAWING LINE (the stroke given a
   Width - a bead, a rib, a ring) or a DRAWING FILL (the area the stroke goes
   round, solid). It is set on what is picked, and is what the next stroke
   becomes when nothing is. HEIGHT is how far the object stands out of the face
   it is put on (blank: the drawing's own height, on the right).

   SIZE AND PLACE (top): W and H of what is picked (lock: keep its aspect),
   Rotate by, X and Y of its centre, Mirror left-right and up-down. Delete,
   Duplicate (Ctrl+D), Ctrl+A.

   AN OBJECT THAT CANNOT BE MADE (a fill that crosses itself, a line folded
   onto itself tighter than its width) is drawn red, and the readout says why.

   HISTORY. Ctrl+Z / Ctrl+Shift+Z (or the arrows) step the editor's own
   history; nothing on the plate changes until Add to plate or Connect bakes.
   The drawing is kept in this browser (localStorage, a convenience).

   PAINT SCOPE: NONE. The editor reads no piece; Add to plate adds a new one.
   ============================================================ */
(function () {
  'use strict';
  if (typeof NSO_Sketch === 'undefined') return;
  var SK = NSO_Sketch;
  var STORE = 'nso.sketch.v1';
  var HISTORY_MAX = 80;
  var COL = { line: '#38bdf8', fill: 'rgba(56,189,248,0.35)', fillEdge: '#38bdf8', sel: '#a3e635', bad: '#f87171',
              grid: 'rgba(255,255,255,0.05)', grid5: 'rgba(255,255,255,0.10)', axis: 'rgba(255,255,255,0.28)', ref: '#60a5fa', draft: '#facc15' };
  var TOOLS = [
    ['select', 'Select', 'V', 'Pick, move and scale objects. Drag on empty sheet for a box. Shift adds to the pick.'],
    ['pencil', 'Pencil', 'P', 'Press and drag to draw freehand. It is smoothed when you let go; end where you began to close it.'],
    ['line', 'Line', 'L', 'Click point after point; double-click or Enter ends it, a click on the first point closes it. Shift: 15° steps.'],
    ['rect', 'Rectangle', 'R', 'Drag a rectangle. Shift: a square.'],
    ['ellipse', 'Ellipse', 'E', 'Drag an ellipse. Shift: a circle.']
  ];
  var ICON = {
    select: 'M5 3l14 8-6 2 4 7-3 1-4-7-5 4z',
    pencil: 'M4 20l1-5L16 4l4 4L9 19zM14 6l4 4',
    line: 'M4 18L10 8l5 6 5-9',
    rect: 'M4 6h16v12H4z',
    ellipse: 'M12 6c5 0 8 3 8 6s-3 6-8 6-8-3-8-6 3-6 8-6z'
  };

  var root = null, cv = null, ctx = null;
  var D = null;                 // the open session
  var sketch = load();          // kept across opens
  var defaults = { kind: 'line', width: 1.2 };

  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag), k;
    for (k in (attrs || {})) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'cls') el.className = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function svgIcon(d) {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', d); s.appendChild(p);
    return s;
  }
  function f2(x) { return String(Math.round(x * 100) / 100); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------------------------------------------------------- the drawing */

  function load() {
    var sk = null;
    try { var raw = window.localStorage && window.localStorage.getItem(STORE); if (raw) sk = JSON.parse(raw); } catch (e) { sk = null; }
    return SK.normalize(sk || { height: 1.5, objects: [] });
  }
  function save() { try { if (window.localStorage) window.localStorage.setItem(STORE, JSON.stringify(sketch)); } catch (e) { /* private window: fine */ } }
  function remember() {
    if (!D) return;
    D.history.push(JSON.stringify(sketch));
    if (D.history.length > HISTORY_MAX) D.history.shift();
    D.future = [];
  }
  function undo() {
    if (!D || !D.history.length) return;
    D.future.push(JSON.stringify(sketch));
    sketch = SK.normalize(JSON.parse(D.history.pop()));
    pruneSel(); changed(false);
  }
  function redo() {
    if (!D || !D.future.length) return;
    D.history.push(JSON.stringify(sketch));
    sketch = SK.normalize(JSON.parse(D.future.pop()));
    pruneSel(); changed(false);
  }
  function pruneSel() {
    var ids = sketch.objects.map(function (o) { return o.id; });
    D.sel = D.sel.filter(function (id) { return ids.indexOf(id) >= 0; });
  }
  function byId(id) { return sketch.objects.find(function (o) { return o.id === id; }) || null; }
  function selected() { return D ? D.sel.map(byId).filter(Boolean) : []; }
  function nextName(kind) {
    var base = kind === 'fill' ? 'Free Fill ' : 'Free Line ', n = 1;
    sketch.objects.forEach(function (o) { var m = new RegExp('^' + base + '(\\d+)$').exec(o.name); if (m) n = Math.max(n, +m[1] + 1); });
    return base + n;
  }
  function addObject(o) {
    remember();
    o.id = sketch.nextId++;
    o.name = o.name || nextName(o.kind);
    if (o.height === undefined) o.height = null;
    sketch.objects.push(o);
    D.sel = [o.id];
    changed(true);
    return o;
  }

  /* Each object's outline check, kept until the object changes: a red object and the reason. */
  var checked = new WeakMap();
  function problem(o) {
    var key = JSON.stringify([o.kind, o.closed, o.width, o.pts]), c = checked.get(o);
    if (c && c.key === key) return c.bad;
    var r = SK.outlines(o);
    checked.set(o, { key: key, bad: r.ok ? '' : r.reason });
    return r.ok ? '' : r.reason;
  }

  /* ---------------------------------------------------------------- the view */

  function toScreen(p) { return [D.w / 2 + (p[0] - D.view.cx) * D.view.z, D.h / 2 - (p[1] - D.view.cy) * D.view.z]; }
  function toMm(sx, sy) { return [D.view.cx + (sx - D.w / 2) / D.view.z, D.view.cy - (sy - D.h / 2) / D.view.z]; }
  function evMm(e) { var r = cv.getBoundingClientRect(); return toMm(e.clientX - r.left, e.clientY - r.top); }
  function evPx(e) { var r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  function resize() {
    if (!D) return;
    var wrap = $('dr-canvas-wrap'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    D.w = wrap.clientWidth || 800; D.h = wrap.clientHeight || 600;
    cv.width = Math.round(D.w * dpr); cv.height = Math.round(D.h * dpr);
    cv.style.width = D.w + 'px'; cv.style.height = D.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function fit() {
    var b = SK.bounds(sketch.objects);
    if (D.ref) {
      var rb = { x0: -D.ref.w / 2, y0: -D.ref.h / 2, x1: D.ref.w / 2, y1: D.ref.h / 2 };
      b = b ? { x0: Math.min(b.x0, rb.x0), y0: Math.min(b.y0, rb.y0), x1: Math.max(b.x1, rb.x1), y1: Math.max(b.y1, rb.y1) } : rb;
    }
    if (sketch.trace) {
      var tb = sketch.trace.box;
      b = b ? { x0: Math.min(b.x0, tb.x0), y0: Math.min(b.y0, tb.y0), x1: Math.max(b.x1, tb.x1), y1: Math.max(b.y1, tb.y1) } : { x0: tb.x0, y0: tb.y0, x1: tb.x1, y1: tb.y1 };
    }
    if (!b) b = { x0: -50, y0: -50, x1: 50, y1: 50 };
    var w = Math.max(10, b.x1 - b.x0), hh = Math.max(10, b.y1 - b.y0);
    D.view.cx = (b.x0 + b.x1) / 2; D.view.cy = (b.y0 + b.y1) / 2;
    D.view.z = Math.max(0.5, Math.min(60, Math.min((D.w - 80) / w, (D.h - 80) / hh)));
    draw();
  }

  /* ---------------------------------------------------------------- drawing the sheet */

  function gridStep() {
    var steps = [0.1, 0.5, 1, 5, 10, 50, 100], s = steps[0];
    for (var i = 0; i < steps.length; i++) { s = steps[i]; if (s * D.view.z >= 9) break; }
    return s;
  }

  function pathOf(pts, closed) {
    ctx.beginPath();
    pts.forEach(function (p, i) { var s = toScreen(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
    if (closed) ctx.closePath();
  }

  function draw() {
    if (!D || !ctx) return;
    ctx.clearRect(0, 0, D.w, D.h);
    ctx.fillStyle = '#12151b'; ctx.fillRect(0, 0, D.w, D.h);
    /* grid */
    var st = gridStep(), big = st * 5, lo = toMm(0, D.h), hi = toMm(D.w, 0);
    ctx.lineWidth = 1;
    [[st, COL.grid], [big, COL.grid5]].forEach(function (g) {
      ctx.strokeStyle = g[1]; ctx.beginPath();
      for (var x = Math.ceil(lo[0] / g[0]) * g[0]; x <= hi[0]; x += g[0]) { var sx = Math.round(toScreen([x, 0])[0]) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, D.h); }
      for (var y = Math.ceil(lo[1] / g[0]) * g[0]; y <= hi[1]; y += g[0]) { var sy = Math.round(toScreen([0, y])[1]) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(D.w, sy); }
      ctx.stroke();
    });
    var o0 = toScreen([0, 0]);
    ctx.strokeStyle = COL.axis; ctx.beginPath(); ctx.moveTo(o0[0], 0); ctx.lineTo(o0[0], D.h); ctx.moveTo(0, o0[1]); ctx.lineTo(D.w, o0[1]); ctx.stroke();
    /* a traced piece, under everything: its outline at Trace at (orange), its foot and top (faint) */
    if (sketch.trace) {
      var T = sketch.trace;
      ctx.save();
      ctx.setLineDash([3, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(251,146,60,0.35)';
      T.rims.forEach(function (L) { pathOf(L, true); ctx.stroke(); });
      ctx.setLineDash([]);
      ctx.beginPath();
      T.loops.forEach(function (L) { L.forEach(function (p, i) { var q = toScreen(p); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath(); });
      ctx.fillStyle = 'rgba(251,146,60,0.12)'; ctx.fill('evenodd');
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fb923c'; ctx.stroke();
      var tl = toScreen([T.box.x0, T.box.y1]);
      ctx.fillStyle = '#fb923c'; ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText(T.name + ' - traced at ' + f2(T.at) + ' mm', tl[0], tl[1] - 6);
      ctx.restore();
    }
    /* the face it goes on, when the editor was opened for one */
    if (D.ref) {
      var a = toScreen([-D.ref.w / 2, D.ref.h / 2]), b = toScreen([D.ref.w / 2, -D.ref.h / 2]);
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = COL.ref; ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.restore();
      ctx.fillStyle = COL.ref; ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
      ctx.fillText(D.ref.label || ('Face ' + f2(D.ref.w) + ' × ' + f2(D.ref.h) + ' mm'), a[0] + 2, a[1] - 5);
    }
    /* the objects */
    sketch.objects.forEach(function (o) {
      var sel = D.sel.indexOf(o.id) >= 0, bad = problem(o);
      var edge = bad ? COL.bad : (sel ? COL.sel : COL.line);
      if (o.kind === 'fill') {
        pathOf(o.pts, true);
        ctx.fillStyle = bad ? 'rgba(248,113,113,0.3)' : (sel ? 'rgba(163,230,53,0.3)' : COL.fill);
        ctx.fill('evenodd');
        ctx.lineWidth = 1.5; ctx.strokeStyle = edge; ctx.stroke();
      } else {
        pathOf(o.pts, o.closed);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1, o.width * D.view.z); ctx.strokeStyle = bad ? 'rgba(248,113,113,0.55)' : (sel ? 'rgba(163,230,53,0.55)' : 'rgba(56,189,248,0.55)');
        ctx.stroke();
        ctx.lineWidth = 1; ctx.strokeStyle = edge; ctx.stroke();
      }
    });
    /* the stroke being drawn */
    if (D.draft && D.draft.pts.length) {
      ctx.save();
      pathOf(D.draft.pts, D.draft.closedPreview);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = COL.draft; ctx.lineWidth = defaults.kind === 'line' ? Math.max(1, defaults.width * D.view.z) : 1.5;
      ctx.globalAlpha = defaults.kind === 'line' ? 0.6 : 1;
      ctx.stroke(); ctx.restore();
      if (D.draft.kind === 'line' && D.draft.pts.length) {
        var f = toScreen(D.draft.pts[0]); ctx.fillStyle = COL.draft; ctx.fillRect(f[0] - 3, f[1] - 3, 6, 6);
      }
    }
    /* the pick's box and its handles */
    var sb = selBox();
    if (sb) {
      var p = toScreen([sb.x0, sb.y1]), q = toScreen([sb.x1, sb.y0]);
      ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = COL.sel; ctx.lineWidth = 1;
      ctx.strokeRect(p[0] - 4, p[1] - 4, q[0] - p[0] + 8, q[1] - p[1] + 8); ctx.restore();
      handles(sb).forEach(function (hd) { ctx.fillStyle = '#fff'; ctx.strokeStyle = COL.sel; ctx.fillRect(hd.s[0] - 4, hd.s[1] - 4, 8, 8); ctx.strokeRect(hd.s[0] - 4, hd.s[1] - 4, 8, 8); });
      var tag = f2(sb.w) + ' × ' + f2(sb.h) + ' mm';
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
      var tw = ctx.measureText(tag).width + 12;
      ctx.fillStyle = 'rgba(132,204,22,0.9)'; ctx.fillRect((p[0] + q[0]) / 2 - tw / 2, p[1] - 30, tw, 18);
      ctx.fillStyle = '#0b1a33'; ctx.fillText(tag, (p[0] + q[0]) / 2 - tw / 2 + 6, p[1] - 17);
    }
    /* the box being dragged out */
    if (D.drag && D.drag.kind === 'marquee') {
      var m0 = toScreen(D.drag.from), m1 = toScreen(D.drag.to);
      ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = '#e2e8f0';
      ctx.strokeRect(m0[0], m0[1], m1[0] - m0[0], m1[1] - m0[1]); ctx.restore();
    }
    rulers();
  }

  function rulers() {
    var st = gridStep() * 10, lo = toMm(0, D.h), hi = toMm(D.w, 0);
    ctx.fillStyle = 'rgba(15,17,21,0.92)'; ctx.fillRect(0, 0, D.w, 18); ctx.fillRect(0, 0, 18, D.h);
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
    for (var x = Math.ceil(lo[0] / st) * st; x <= hi[0]; x += st) { var sx = toScreen([x, 0])[0]; ctx.fillRect(sx, 12, 1, 6); ctx.fillText(f2(x), sx + 2, 11); }
    for (var y = Math.ceil(lo[1] / st) * st; y <= hi[1]; y += st) {
      var sy = toScreen([0, y])[1]; ctx.fillRect(12, sy, 6, 1);
      ctx.save(); ctx.translate(10, sy - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(f2(y), 0, 0); ctx.restore();
    }
  }

  /* ---------------------------------------------------------------- the pick */

  function selBox() {
    var s = selected();
    if (!s.length) return null;
    var b = SK.bounds(s.map(function (o) { return { pts: o.pts, kind: 'fill' }; }));
    return b;
  }
  function handles(b) {
    return [[b.x0, b.y0, 'sw'], [b.x1, b.y0, 'se'], [b.x1, b.y1, 'ne'], [b.x0, b.y1, 'nw']].map(function (c) {
      var s = toScreen([c[0], c[1]]);
      s[0] += c[2].indexOf('w') >= 0 ? -4 : 4; s[1] += c[2].indexOf('n') >= 0 ? -4 : 4;
      return { at: [c[0], c[1]], k: c[2], s: s };
    });
  }

  function distSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  }
  function inside(p, pts) {
    var c = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function hitObject(p) {
    var tol = 5 / D.view.z;
    for (var i = sketch.objects.length - 1; i >= 0; i--) {
      var o = sketch.objects[i], pts = o.pts, closed = o.kind === 'fill' || o.closed, r = o.kind === 'line' ? o.width / 2 : 0;
      if (o.kind === 'fill' && inside(p, pts)) return o;
      var n = closed ? pts.length : pts.length - 1;
      for (var k = 0; k < n; k++) if (distSeg(p, pts[k], pts[(k + 1) % pts.length]) <= r + tol) return o;
    }
    return null;
  }

  /* ---------------------------------------------------------------- transforms of the pick */

  function applyAffine(m, objs) {
    objs.forEach(function (o) {
      o.pts = SK.transform(o.pts, m);
      if (m[0] * m[3] - m[1] * m[2] < 0) o.pts.reverse();
      if (o.kind === 'line') {
        var s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        if (D.scaleWidth && s > 0) o.width = Math.max(SK.MIN_WIDTH, o.width * s);
      }
    });
  }
  function scaleAbout(cx, cy, sx, sy) { return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]; }

  function setSize(w, hh) {
    var b = selBox();
    if (!b) return;
    var sx = b.w > 1e-9 ? w / b.w : 1, sy = b.h > 1e-9 ? hh / b.h : 1;
    if (!(sx > 0) || !(sy > 0)) return;
    if (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9) { sync(); return; }      // the box re-read on blur: nothing to do
    remember();
    applyAffine(scaleAbout(b.cx, b.cy, sx, sy), selected());
    changed(true);
  }
  function moveBy(dx, dy) {
    if (!selected().length) return;
    applyAffine([1, 0, 0, 1, dx, dy], selected());
    changed(true);
  }
  function rotateBy(deg) {
    var b = selBox();
    if (!b || !deg) return;
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    remember();
    applyAffine([c, s, -s, c, b.cx - c * b.cx + s * b.cy, b.cy - s * b.cx - c * b.cy], selected());
    changed(true);
  }
  function mirror(axis) {
    var b = selBox();
    if (!b) return;
    remember();
    applyAffine(axis === 'x' ? scaleAbout(b.cx, b.cy, -1, 1) : scaleAbout(b.cx, b.cy, 1, -1), selected());
    changed(true);
  }

  /* ---------------------------------------------------------------- the pointer */

  function snapMm(p) {
    var e = edgeSnap(p);
    if (e) return e;
    if (!D.snap) return p;
    var s = 0.5;
    return [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s];
  }
  /* onto the traced outline: a corner within 10 px, else the nearest point of an edge within 8 px */
  function edgeSnap(p) {
    if (!D.snapEdge || !sketch.trace) return null;
    var best = null, bd = 8 / D.view.z, cd = 10 / D.view.z, corner = null;
    sketch.trace.loops.forEach(function (L) {
      for (var i = 0; i < L.length; i++) {
        var a = L[i], b = L[(i + 1) % L.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        var dc = Math.hypot(p[0] - a[0], p[1] - a[1]);
        if (dc < cd) { cd = dc; corner = a; }
        var t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
        var q = [a[0] + dx * t, a[1] + dy * t], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bd) { bd = d; best = q; }
      }
    });
    return corner ? corner.slice() : best;
  }

  /* ---------------------------------------------------------------- trace a piece */

  function pieces() {
    if (typeof state === 'undefined' || !state.placed) return [];
    return state.placed.filter(function (pl) {
      if (!pl || !pl.mesh || pl.sourceId == null) return false;
      var m = state.models.find(function (x) { return x && x.id === pl.sourceId; });
      return m && !m.nsoSupport;
    }).map(function (pl) {
      var m = state.models.find(function (x) { return x && x.id === pl.sourceId; });
      return { id: pl.sourceId, placed: pl, name: String(m.name || ('piece ' + pl.sourceId)).replace(/\.(stl|step|stp|3mf|obj)$/i, '') };
    });
  }
  /* The piece in plate millimetres, from above: z up (the plate's own frame, as Connect reads it) */
  function plateSoup(pl) {
    pl.mesh.updateMatrixWorld(true);
    var s = meshToWorldSoup(pl.mesh), up = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { up[i] = s[i]; up[i + 1] = -s[i + 2]; up[i + 2] = s[i + 1]; }
    return up;
  }
  /* -> { ok, trace } : the cut through the piece at `at` mm above its foot, its foot and top for reference */
  function traceOf(id, at) {
    var pc = pieces().find(function (x) { return x.id === id; });
    if (!pc) return { ok: false, reason: 'that piece is not on the plate' };
    if (typeof NSO_Slicer === 'undefined' || !NSO_Slicer.sliceMesh) return { ok: false, reason: 'the slicer (nso_slicer.js) did not load' };
    var up = plateSoup(pc.placed), z0 = Infinity, z1 = -Infinity, box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < up.length; i += 3) {
      if (up[i + 2] < z0) z0 = up[i + 2]; if (up[i + 2] > z1) z1 = up[i + 2];
      if (up[i] < box.x0) box.x0 = up[i]; if (up[i] > box.x1) box.x1 = up[i];
      if (up[i + 1] < box.y0) box.y0 = up[i + 1]; if (up[i + 1] > box.y1) box.y1 = up[i + 1];
    }
    var h = z1 - z0, a = Math.max(0.01, Math.min(h - 0.01, at == null ? h / 2 : at));
    function cut(z) {
      var sec = NSO_Slicer.sliceMesh(up, [{ sliceZ: z }]).sections[0];
      return (sec && sec.loops || []).filter(function (L) { return L.length >= 3; }).map(function (L) { return L.map(function (p) { return [p[0], p[1]]; }); });
    }
    var loops = cut(z0 + a);
    if (!loops.length) return { ok: false, reason: 'nothing to trace at ' + f2(a) + ' mm - try another height' };
    var rims = cut(z0 + Math.min(0.3, h / 4)).concat(cut(z1 - Math.min(0.3, h / 4)));
    return { ok: true, trace: { pieceId: id, name: pc.name, at: a, z0: z0, z1: z1, box: box, loops: loops, rims: rims } };
  }
  function doTrace() {
    var sel = $('dr-trace-piece'), id = sel && sel.value !== '' ? +sel.value : null;
    if (id == null) { say('Pick a piece to trace.', true); return false; }
    var raw = $('dr-trace-at').value.trim(), r = traceOf(id, raw === '' ? null : parseFloat(raw));
    if (!r.ok) { say(r.reason, true); return false; }
    remember();
    sketch.trace = r.trace;
    D.snapEdge = true;
    changed(); fit();
    say('Traced ' + r.trace.name + ': draw on its outline - points snap to it. Connect puts the drawing where you drew it, on the plate under the piece.');
    return true;
  }
  function syncTrace() {
    var sel = $('dr-trace-piece');
    if (!sel) return;
    var list = pieces(), want = sel.value;
    if (want === '' && sketch.trace) want = String(sketch.trace.pieceId);
    if (want === '' && typeof state !== 'undefined' && state.placed && state.placed[state.selectedIndex]) want = String(state.placed[state.selectedIndex].sourceId);
    sel.textContent = '';
    sel.appendChild(h('option', { value: '', text: list.length ? '- a piece on the plate -' : '- no piece on the plate -' }));
    list.forEach(function (pc) { var o = h('option', { value: String(pc.id), text: pc.name }); sel.appendChild(o); });
    sel.value = list.some(function (pc) { return String(pc.id) === want; }) ? want : '';
    $('dr-trace-go').disabled = sel.value === '';
    $('dr-trace-clear').disabled = !sketch.trace;
    $('dr-snap-edge').disabled = !sketch.trace;
    $('dr-snap-edge').checked = !!(D.snapEdge && sketch.trace);
    var note = $('dr-trace-note'), T = sketch.trace;
    note.textContent = T ? T.name + ', cut ' + f2(T.at) + ' mm above its foot (' + f2(T.z1 - T.z0) + ' mm tall). The drawing is in plate mm.'
      : 'Lay a piece\'s outline (from above) under the sheet and draw on its border.';
  }
  function angleSnap(from, p) {
    var dx = p[0] - from[0], dy = p[1] - from[1], L = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
    return [from[0] + L * Math.cos(a), from[1] + L * Math.sin(a)];
  }

  function onDown(e) {
    if (!D) return;
    cv.focus();
    if (e.button === 1 || e.button === 2 || (e.button === 0 && D.space)) {
      D.drag = { kind: 'pan', px: evPx(e), cx: D.view.cx, cy: D.view.cy };
      cv.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    var p = evMm(e);
    cv.setPointerCapture(e.pointerId);
    if (D.tool === 'pencil') {
      D.draft = { kind: 'pencil', pts: [p], raw: [p] };
      D.drag = { kind: 'pencil' };
    } else if (D.tool === 'line') {
      var q = snapMm(p);
      if (!D.draft || D.draft.kind !== 'line') D.draft = { kind: 'line', pts: [q, q] };
      else {
        var first = D.draft.pts[0], close = D.draft.pts.length > 3 && Math.hypot(toScreen(first)[0] - toScreen(q)[0], toScreen(first)[1] - toScreen(q)[1]) < 9;
        if (close) { D.draft.pts.pop(); finishLine(true); return; }
        D.draft.pts[D.draft.pts.length - 1] = e.shiftKey ? angleSnap(D.draft.pts[D.draft.pts.length - 2], q) : q;
        D.draft.pts.push(D.draft.pts[D.draft.pts.length - 1].slice());
      }
    } else if (D.tool === 'rect' || D.tool === 'ellipse') {
      var s = snapMm(p);
      D.draft = { kind: D.tool, from: s, pts: [] };
      D.drag = { kind: 'shape' };
    } else {                                                         // select
      var px = evPx(e), sb = selBox();
      if (sb) {
        var hd = handles(sb).find(function (x) { return Math.abs(x.s[0] - px[0]) <= 7 && Math.abs(x.s[1] - px[1]) <= 7; });
        if (hd) {
          var opp = { sw: [sb.x1, sb.y1], se: [sb.x0, sb.y1], ne: [sb.x0, sb.y0], nw: [sb.x1, sb.y0] }[hd.k];
          remember();
          D.drag = { kind: 'scale', opp: opp, start: hd.at, base: clone(selected().map(function (o) { return { id: o.id, pts: o.pts, width: o.width }; })) };
          return;
        }
      }
      var o = hitObject(p);
      if (o) {
        if (e.shiftKey) {
          var at = D.sel.indexOf(o.id);
          if (at >= 0) D.sel.splice(at, 1); else D.sel.push(o.id);
        } else if (D.sel.indexOf(o.id) < 0) D.sel = [o.id];
        remember();
        D.drag = { kind: 'move', last: p, moved: false };
        sync(); draw();
      } else {
        if (!e.shiftKey) D.sel = [];
        D.drag = { kind: 'marquee', from: p, to: p, add: e.shiftKey, base: D.sel.slice() };
        sync(); draw();
      }
    }
  }

  function onMove(e) {
    if (!D) return;
    var p = evMm(e);
    D.pointer = p;
    var dr = D.drag;
    if (dr && dr.kind === 'pan') {
      var px = evPx(e);
      D.view.cx = dr.cx - (px[0] - dr.px[0]) / D.view.z; D.view.cy = dr.cy + (px[1] - dr.px[1]) / D.view.z;
      draw(); return;
    }
    if (dr && dr.kind === 'pencil') {
      D.draft.raw.push(p); D.draft.pts.push(p);
      var f = toScreen(D.draft.pts[0]), l = toScreen(p);
      D.draft.closedPreview = D.draft.pts.length > 8 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 10;
      draw(); return;
    }
    if (dr && dr.kind === 'shape') { shapeDraft(snapMm(p), e.shiftKey); draw(); return; }
    if (dr && dr.kind === 'move') {
      var dx = p[0] - dr.last[0], dy = p[1] - dr.last[1];
      if (D.snap) { dx = Math.round(dx / 0.5) * 0.5; dy = Math.round(dy / 0.5) * 0.5; }
      if (dx || dy) { applyAffine([1, 0, 0, 1, dx, dy], selected()); dr.last = [dr.last[0] + dx, dr.last[1] + dy]; dr.moved = true; save(); sync(); draw(); }
      return;
    }
    if (dr && dr.kind === 'scale') {
      var o0 = dr.opp, s0 = dr.start;
      var sx = Math.abs(s0[0] - o0[0]) > 1e-9 ? (p[0] - o0[0]) / (s0[0] - o0[0]) : 1;
      var sy = Math.abs(s0[1] - o0[1]) > 1e-9 ? (p[1] - o0[1]) / (s0[1] - o0[1]) : 1;
      if (D.lock || e.shiftKey) { var k = Math.max(Math.abs(sx), Math.abs(sy)); sx = sy = Math.max(0.01, k); }
      sx = Math.max(0.01, sx); sy = Math.max(0.01, sy);
      dr.base.forEach(function (b) { var o = byId(b.id); if (o) { o.pts = b.pts; o.width = b.width; } });
      applyAffine(scaleAbout(o0[0], o0[1], sx, sy), selected());
      sync(); draw();
      return;
    }
    if (dr && dr.kind === 'marquee') {
      dr.to = p;
      var x0 = Math.min(dr.from[0], p[0]), x1 = Math.max(dr.from[0], p[0]), y0 = Math.min(dr.from[1], p[1]), y1 = Math.max(dr.from[1], p[1]);
      var inBox = sketch.objects.filter(function (o) { return o.pts.every(function (q) { return q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1; }); }).map(function (o) { return o.id; });
      D.sel = dr.add ? dr.base.concat(inBox.filter(function (id) { return dr.base.indexOf(id) < 0; })) : inBox;
      sync(); draw(); return;
    }
    if (D.draft && D.draft.kind === 'line') {
      var q = snapMm(p), prev = D.draft.pts[D.draft.pts.length - 2];
      D.draft.pts[D.draft.pts.length - 1] = e.shiftKey ? angleSnap(prev, q) : q;
      draw();
    }
    cv.style.cursor = D.space ? 'grab' : (D.tool === 'select' ? (hitObject(p) ? 'move' : 'default') : 'crosshair');
    footer();
  }

  function onUp(e) {
    if (!D) return;
    var dr = D.drag;
    D.drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
    if (!dr) return;
    if (dr.kind === 'pencil') {
      var raw = D.draft.raw, closed = D.draft.closedPreview;
      D.draft = null;
      if (raw.length < 2 || SK.pathLength(raw) < 0.5) { draw(); say('Too short to keep - press and drag to draw.', true); return; }
      var e0 = edgeSnap(raw[0]), e1 = edgeSnap(raw[raw.length - 1]);      // a stroke that starts or ends on the traced edge lands on it
      if (e0) raw[0] = e0;
      if (e1) raw[raw.length - 1] = e1;
      var kind = defaults.kind, pts = SK.smooth(raw, { closed: kind === 'fill' || closed });
      if (pts.length < (kind === 'fill' || closed ? 3 : 2)) { draw(); return; }
      addObject({ kind: kind, closed: kind === 'line' && closed, width: defaults.width, pts: pts });
    } else if (dr.kind === 'shape') {
      var d = D.draft; D.draft = null;
      if (!d.pts.length) { draw(); return; }
      var b = SK.bounds([{ pts: d.pts, kind: 'fill' }]);
      if (!b || b.w < 0.2 || b.h < 0.2) { draw(); say('Drag out a shape bigger than that.', true); return; }
      addObject({ kind: defaults.kind, closed: true, width: defaults.width, pts: d.pts });
    } else if (dr.kind === 'move') {
      if (!dr.moved) D.history.pop();
      changed(true);
    } else if (dr.kind === 'scale') {
      changed(true);
    } else if (dr.kind === 'marquee') {
      sync(); draw();
    }
  }

  function shapeDraft(p, square) {
    var a = D.draft.from, dx = p[0] - a[0], dy = p[1] - a[1];
    if (square) { var m = Math.max(Math.abs(dx), Math.abs(dy)); dx = m * (dx < 0 ? -1 : 1); dy = m * (dy < 0 ? -1 : 1); }
    var x0 = Math.min(a[0], a[0] + dx), x1 = Math.max(a[0], a[0] + dx), y0 = Math.min(a[1], a[1] + dy), y1 = Math.max(a[1], a[1] + dy);
    D.draft.pts = D.draft.kind === 'rect' ? SK.rectPts(x0, y0, x1, y1) : SK.ellipsePts((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2);
    D.draft.closedPreview = true;
  }

  function finishLine(closed) {
    var d = D.draft;
    D.draft = null;
    if (!d || d.kind !== 'line') return;
    var pts = d.pts.slice(0, closed ? d.pts.length : d.pts.length - 1);
    var clean = [];
    pts.forEach(function (p) { if (!clean.length || Math.hypot(p[0] - clean[clean.length - 1][0], p[1] - clean[clean.length - 1][1]) > 1e-6) clean.push(p); });
    if (clean.length < (closed ? 3 : 2)) { draw(); return; }
    addObject({ kind: closed ? defaults.kind : 'line', closed: closed && defaults.kind === 'line', width: defaults.width, pts: clean });
  }

  function onDbl(e) {
    if (!D) return;
    if (D.tool === 'line' && D.draft && D.draft.kind === 'line') { D.draft.pts.pop(); finishLine(false); e.preventDefault(); }
  }

  function onWheel(e) {
    if (!D) return;
    e.preventDefault();
    var px = evPx(e), before = toMm(px[0], px[1]);
    D.view.z = Math.max(0.3, Math.min(200, D.view.z * Math.exp(-e.deltaY * 0.0015)));
    var after = toMm(px[0], px[1]);
    D.view.cx += before[0] - after[0]; D.view.cy += before[1] - after[1];
    draw(); footer();
  }

  function onKey(e) {
    if (!D) return;
    var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    var mod = e.ctrlKey || e.metaKey, k = e.key;
    if (k === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (typing) { t.blur(); return; }
      if (D.draft) { D.draft = null; D.drag = null; draw(); return; }
      if (D.sel.length) { D.sel = []; sync(); draw(); return; }
      close(); return;
    }
    if (typing) return;
    e.stopImmediatePropagation();
    if (k === ' ') { D.space = true; e.preventDefault(); return; }
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); D.sel = sketch.objects.map(function (o) { return o.id; }); sync(); draw(); return; }
    if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); duplicate(); return; }
    if (k === 'Enter' && D.draft && D.draft.kind === 'line') { e.preventDefault(); finishLine(false); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); del(); return; }
    if (k.indexOf('Arrow') === 0 && D.sel.length) {
      e.preventDefault();
      var st = e.shiftKey ? 1 : 0.1, dx = k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, dy = k === 'ArrowDown' ? -st : k === 'ArrowUp' ? st : 0;
      remember(); moveBy(dx, dy); return;
    }
    if (mod) return;
    var map = { v: 'select', p: 'pencil', l: 'line', r: 'rect', e: 'ellipse' };
    if (map[k.toLowerCase()]) { setTool(map[k.toLowerCase()]); return; }
    if (k.toLowerCase() === 'f') fit();
  }
  function onKeyUp(e) { if (D && e.key === ' ') D.space = false; }

  /* ---------------------------------------------------------------- commands */

  function setTool(t) {
    if (D.draft && D.draft.kind === 'line' && t !== 'line') finishLine(false);
    D.tool = t; D.draft = null;
    Array.prototype.forEach.call(root.querySelectorAll('[data-dr-tool]'), function (b) {
      var on = b.getAttribute('data-dr-tool') === t; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var tip = TOOLS.find(function (x) { return x[0] === t; });
    say(tip ? tip[3] : '');
    draw();
  }
  function del() {
    if (!D.sel.length) return;
    remember();
    sketch.objects = sketch.objects.filter(function (o) { return D.sel.indexOf(o.id) < 0; });
    D.sel = [];
    changed(true);
  }
  function duplicate() {
    var s = selected();
    if (!s.length) return;
    remember();
    D.sel = [];
    s.forEach(function (o) {
      var c = { kind: o.kind, closed: o.closed, width: o.width, height: o.height, pts: o.pts.map(function (p) { return [p[0] + 5, p[1] - 5]; }) };
      c.id = sketch.nextId++; c.name = nextName(c.kind);
      sketch.objects.push(c); D.sel.push(c.id);
    });
    changed(true);
  }
  function setKind(kind) {
    defaults.kind = kind;
    var s = selected();
    if (s.length) {
      remember();
      s.forEach(function (o) {
        if (o.kind === kind) return;
        o.kind = kind;
        if (kind === 'fill') o.closed = true;
        o.name = o.name.replace(/^Free (Line|Fill)/, kind === 'fill' ? 'Free Fill' : 'Free Line');
      });
      changed(true);
    } else sync();
  }

  function changed() {
    save();
    sync(); draw();
    if (D && D.onChange) D.onChange(sketch);
  }

  /* ---------------------------------------------------------------- the panels */

  function say(msg, bad) {
    var el = $('dr-hint');
    if (el) { el.textContent = msg || ''; el.classList.toggle('is-bad', !!bad); }
  }
  function footer() {
    var z = $('dr-zoom'); if (z && D) z.textContent = Math.round(D.view.z * 100 / 4) + ' %';
    var c = $('dr-cursor'); if (c && D && D.pointer) c.textContent = 'x ' + f2(D.pointer[0]) + '  y ' + f2(D.pointer[1]) + ' mm';
  }

  function sync() {
    if (!D) return;
    var s = selected(), b = selBox(), active = document.activeElement;
    function setVal(id, v) { var el = $(id); if (el && el !== active) el.value = v; }
    var kind = s.length ? (s.every(function (o) { return o.kind === s[0].kind; }) ? s[0].kind : '') : defaults.kind;
    Array.prototype.forEach.call(root.querySelectorAll('[data-dr-kind]'), function (x) {
      var on = x.getAttribute('data-dr-kind') === kind; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var lines = s.filter(function (o) { return o.kind === 'line'; });
    var w = s.length ? (lines.length ? (lines.every(function (o) { return o.width === lines[0].width; }) ? f2(lines[0].width) : '') : '') : f2(defaults.width);
    setVal('dr-width', w);
    $('dr-width').disabled = s.length > 0 && !lines.length;
    var hts = s.map(function (o) { return o.height; });
    setVal('dr-height', s.length ? (hts.every(function (x) { return x === hts[0]; }) && hts[0] != null ? f2(hts[0]) : '') : '');
    $('dr-height').placeholder = f2(sketch.height);
    ['dr-w', 'dr-h', 'dr-x', 'dr-y', 'dr-rot'].forEach(function (id) { $(id).disabled = !b; });
    ['dr-mirror-x', 'dr-mirror-y', 'dr-del', 'dr-dup'].forEach(function (id) { $(id).disabled = !s.length; });
    setVal('dr-w', b ? f2(b.w) : ''); setVal('dr-h', b ? f2(b.h) : '');
    setVal('dr-x', b ? f2(b.cx) : ''); setVal('dr-y', b ? f2(b.cy) : '');
    $('dr-lock').setAttribute('aria-pressed', D.lock ? 'true' : 'false');
    $('dr-lock').classList.toggle('is-on', D.lock);
    setVal('dr-sheet-height', f2(sketch.height));
    $('dr-undo').disabled = !D.history.length; $('dr-redo').disabled = !D.future.length;
    syncTrace();
    $('dr-snap').checked = !!D.snap;
    $('dr-scale-width').checked = !!D.scaleWidth;
    /* the objects list */
    var list = $('dr-objects');
    list.textContent = '';
    if (!sketch.objects.length) list.appendChild(h('p', { cls: 'dr-empty', text: 'Nothing drawn yet. Pick the Pencil and drag on the sheet.' }));
    sketch.objects.slice().reverse().forEach(function (o) {
      var bad = problem(o);
      var row = h('button', { type: 'button', cls: 'dr-obj' + (D.sel.indexOf(o.id) >= 0 ? ' is-on' : '') + (bad ? ' is-bad' : ''), 'data-dr-obj': String(o.id), title: bad || (o.name + ' - click to pick, Shift-click to add') }, [
        thumb(o),
        h('span', { cls: 'dr-obj-text' }, [h('span', { cls: 'dr-obj-name', text: o.name }), h('span', { cls: 'dr-obj-kind', text: (o.kind === 'fill' ? 'Drawing Fill' : 'Drawing Line' + (o.closed ? ' · ring' : '')) + (o.height != null ? ' · ' + f2(o.height) + ' mm' : '') })])
      ]);
      row.addEventListener('click', function (e) {
        if (e.shiftKey) { var i = D.sel.indexOf(o.id); if (i >= 0) D.sel.splice(i, 1); else D.sel.push(o.id); }
        else D.sel = [o.id];
        sync(); draw();
      });
      list.appendChild(row);
    });
    /* the readout: what it makes, or why it cannot */
    var badOne = sketch.objects.find(function (o) { return problem(o); });
    var out = $('dr-readout');
    out.textContent = badOne ? badOne.name + ': ' + problem(badOne) : SK.describe(sketch) + (sketch.objects.length ? ', ' + f2(sketch.height) + ' mm tall' : '');
    out.classList.toggle('is-bad', !!badOne);
    $('dr-connect').disabled = !sketch.objects.length || !!badOne;
    $('dr-add').disabled = !sketch.objects.length || !!badOne || D.busy;
    footer();
  }

  function thumb(o) {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), b = SK.bounds([{ pts: o.pts, kind: 'fill' }]);
    s.setAttribute('viewBox', '0 0 28 20'); s.setAttribute('class', 'dr-obj-thumb'); s.setAttribute('aria-hidden', 'true');
    if (!b) return s;
    var k = Math.min(24 / Math.max(b.w, 1e-3), 16 / Math.max(b.h, 1e-3));
    var d = o.pts.map(function (p, i) { return (i ? 'L' : 'M') + (14 + (p[0] - b.cx) * k).toFixed(1) + ' ' + (10 - (p[1] - b.cy) * k).toFixed(1); }).join('') + (o.kind === 'fill' || o.closed ? 'Z' : '');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', o.kind === 'fill' ? 'is-fill' : 'is-line');
    s.appendChild(p);
    return s;
  }

  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : null; }

  function buildDom() {
    if (root) return;
    function btn(id, text, title, cls) { return h('button', { type: 'button', id: id, cls: 'btn ' + (cls || 'btn-secondary'), text: text, title: title }); }
    function field(id, label, title, unit, attrs) {
      var a = { type: 'number', id: id, step: '0.1', inputmode: 'decimal', 'aria-label': title };
      for (var k in (attrs || {})) a[k] = attrs[k];
      return h('label', { cls: 'dr-field', title: title }, [h('span', { cls: 'dr-field-k', text: label }), h('input', a), unit ? h('span', { cls: 'dr-field-u', text: unit }) : null]);
    }
    function group(label, kids) { return h('div', { cls: 'dr-group' }, [h('span', { cls: 'dr-group-label', text: label }), h('div', { cls: 'dr-group-body' }, kids)]); }

    var kindSeg = h('div', { cls: 'dr-seg', role: 'group', 'aria-label': 'Process type' }, [
      h('button', { type: 'button', cls: 'dr-seg-opt', 'data-dr-kind': 'line', id: 'dr-kind-line', text: 'Drawing Line', title: 'The stroke given a Width: a bead, a rib, a ring standing out of the face' }),
      h('button', { type: 'button', cls: 'dr-seg-opt', 'data-dr-kind': 'fill', id: 'dr-kind-fill', text: 'Drawing Fill', title: 'The area the stroke goes round, solid' })
    ]);
    var top = h('div', { cls: 'dr-top' }, [
      group('Edit', [btn('dr-undo', '↶', 'Undo (Ctrl+Z)'), btn('dr-redo', '↷', 'Redo (Ctrl+Shift+Z)')]),
      group('Process type', [kindSeg]),
      group('Line', [field('dr-width', 'W', 'Line width, mm - of what is picked, or the next line', 'mm', { min: String(SK.MIN_WIDTH) })]),
      group('Height', [field('dr-height', '', 'How far what is picked stands out of the face, mm. Blank: the drawing\'s height', 'mm', { min: String(SK.MIN_HEIGHT) })]),
      group('Mirror', [btn('dr-mirror-x', '⇋', 'Mirror left-right'), btn('dr-mirror-y', '⇵', 'Mirror up-down')]),
      group('Size (mm)', [field('dr-w', 'W', 'Width of what is picked', ''), h('button', { type: 'button', id: 'dr-lock', cls: 'btn btn-secondary dr-lock', text: '🔒', title: 'Keep the aspect when W, H or a corner handle changes the size', 'aria-pressed': 'true' }), field('dr-h', 'H', 'Height (on the sheet) of what is picked', '')]),
      group('Rotate', [field('dr-rot', '', 'Turn what is picked by this many degrees about its centre (Enter)', '°', { step: '1' })]),
      group('Position (mm)', [field('dr-x', 'X', 'Centre of what is picked, X', ''), field('dr-y', 'Y', 'Centre of what is picked, Y', '')]),
      group('Object', [btn('dr-dup', 'Duplicate', 'Duplicate what is picked (Ctrl+D)'), btn('dr-del', 'Delete', 'Delete what is picked (Delete)')])
    ]);
    var tools = h('div', { cls: 'dr-tools', role: 'toolbar', 'aria-label': 'Draw tools' }, TOOLS.map(function (t) {
      var b = h('button', { type: 'button', cls: 'dr-tool', 'data-dr-tool': t[0], id: 'dr-tool-' + t[0], title: t[1] + ' (' + t[2] + ') - ' + t[3], 'aria-label': t[1] }, [svgIcon(ICON[t[0]]), h('span', { text: t[1] })]);
      return b;
    }).concat([h('div', { cls: 'dr-tools-sep' }), (function () { var b = h('button', { type: 'button', cls: 'dr-tool', id: 'dr-fit', title: 'Fit the drawing in view (F)', 'aria-label': 'Fit' }, [svgIcon('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'), h('span', { text: 'Fit' })]); return b; })()]));
    var side = h('div', { cls: 'dr-side' }, [
      h('div', { cls: 'dr-side-title', text: 'Objects' }),
      h('div', { cls: 'dr-objects', id: 'dr-objects', role: 'list' }),
      h('div', { cls: 'dr-side-title', text: 'Trace a piece' }),
      h('p', { cls: 'dr-empty', id: 'dr-trace-note' }),
      h('select', { id: 'dr-trace-piece', cls: 'dr-select', 'aria-label': 'Piece to trace', title: 'The piece whose outline goes under the sheet' }),
      h('div', { cls: 'dr-row' }, [
        field('dr-trace-at', 'at', 'How far above the piece\'s foot to cut its outline, mm. Blank: half way up', 'mm', { min: '0', step: '0.5' }),
        btn('dr-trace-go', 'Trace', 'Lay this piece\'s outline, seen from above, under the sheet - in plate millimetres, so Connect puts the drawing exactly where it is drawn'),
        btn('dr-trace-clear', 'Clear', 'Take the traced outline off the sheet')
      ]),
      h('label', { cls: 'dr-check', title: 'Line points, shape corners and the ends of a pencil stroke land on the traced outline when near it' }, [h('input', { type: 'checkbox', id: 'dr-snap-edge' }), h('span', { text: ' Snap to the traced edges' })]),
      h('div', { cls: 'dr-side-title', text: 'Drawing' }),
      field('dr-sheet-height', 'Height', 'How far the whole drawing stands out of the face it is put on, mm (an object with its own height keeps it)', 'mm', { min: String(SK.MIN_HEIGHT) }),
      h('label', { cls: 'dr-check', title: 'Shape tools, the Line tool and moves land on a 0.5 mm grid' }, [h('input', { type: 'checkbox', id: 'dr-snap' }), h('span', { text: ' Snap 0.5 mm' })]),
      h('label', { cls: 'dr-check', title: 'Scaling a line scales its width too' }, [h('input', { type: 'checkbox', id: 'dr-scale-width' }), h('span', { text: ' Scale line widths' })]),
      h('p', { cls: 'dr-readout', id: 'dr-readout', 'aria-live': 'polite' }),
      h('div', { cls: 'dr-actions' }, [
        btn('dr-connect', 'Connect to a piece…', 'Put this drawing on a face of a piece: the pieces alone on a stage, the drawing as a ghost you move freely, then weld it in, cut it in, or place it as its own piece', 'btn-primary'),
        btn('dr-add', 'Add to plate', 'Make the drawing a piece of its own, flat on the plate, Height tall. One Undo.'),
        btn('dr-clear', 'Clear drawing', 'Delete every object (Undo brings them back)'),
        btn('dr-done', 'Done', 'Close the editor. The drawing is kept.')
      ])
    ]);
    root = h('div', { id: 'draw-editor', cls: 'dr-ed', role: 'dialog', 'aria-label': 'Draw editor', hidden: '' }, [
      h('div', { cls: 'dr-head' }, [h('span', { cls: 'dr-title', text: 'Draw' }), top]),
      tools,
      h('div', { cls: 'dr-canvas-wrap', id: 'dr-canvas-wrap' }, [h('canvas', { id: 'dr-canvas', tabindex: '0', 'aria-label': 'Drawing sheet, millimetres' })]),
      side,
      h('div', { cls: 'dr-foot' }, [h('span', { cls: 'dr-hint', id: 'dr-hint' }), h('span', { cls: 'dr-cursor', id: 'dr-cursor' }), h('span', { cls: 'dr-zoom', id: 'dr-zoom' })])
    ]);
    document.body.appendChild(root);
    cv = $('dr-canvas'); ctx = cv.getContext('2d');
    wire();
  }

  function wire() {
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('dblclick', onDbl);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-dr-tool]'), function (b) { b.addEventListener('click', function () { setTool(b.getAttribute('data-dr-tool')); cv.focus(); }); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-dr-kind]'), function (b) { b.addEventListener('click', function () { setKind(b.getAttribute('data-dr-kind')); }); });
    $('dr-fit').addEventListener('click', fit);
    $('dr-undo').addEventListener('click', undo);
    $('dr-redo').addEventListener('click', redo);
    $('dr-mirror-x').addEventListener('click', function () { mirror('x'); });
    $('dr-mirror-y').addEventListener('click', function () { mirror('y'); });
    $('dr-del').addEventListener('click', del);
    $('dr-dup').addEventListener('click', duplicate);
    $('dr-lock').addEventListener('click', function () { D.lock = !D.lock; sync(); });
    $('dr-snap').addEventListener('change', function () { D.snap = $('dr-snap').checked; });
    $('dr-scale-width').addEventListener('change', function () { D.scaleWidth = $('dr-scale-width').checked; });
    $('dr-width').addEventListener('change', function () {
      var v = num('dr-width'); if (v == null || v < SK.MIN_WIDTH) { sync(); return; }
      defaults.width = v;
      var s = selected().filter(function (o) { return o.kind === 'line' && o.width !== v; });
      if (s.length) { remember(); s.forEach(function (o) { o.width = v; }); changed(true); } else sync();
    });
    $('dr-height').addEventListener('change', function () {
      var s = selected(); if (!s.length) return;
      var raw = $('dr-height').value.trim(), v = raw === '' ? null : parseFloat(raw);
      if (v != null && !(v >= SK.MIN_HEIGHT)) { sync(); return; }
      if (s.every(function (o) { return o.height === v; })) return;
      remember(); s.forEach(function (o) { o.height = v; }); changed(true);
    });
    $('dr-sheet-height').addEventListener('change', function () {
      var v = num('dr-sheet-height'); if (v == null || v < SK.MIN_HEIGHT) { sync(); return; }
      if (v === sketch.height) return;
      remember(); sketch.height = v; changed(true);
    });
    function sizeChange(which) {
      var b = selBox(); if (!b) return;
      var v = num(which === 'w' ? 'dr-w' : 'dr-h'); if (!(v > 0)) { sync(); return; }
      var w = b.w, hh = b.h;
      if (which === 'w') { if (D.lock && b.w > 1e-9) hh = b.h * v / b.w; w = v; }
      else { if (D.lock && b.h > 1e-9) w = b.w * v / b.h; hh = v; }
      if (b.w < 1e-9) w = b.w;
      if (b.h < 1e-9) hh = b.h;
      setSize(w, hh);
    }
    $('dr-w').addEventListener('change', function () { sizeChange('w'); });
    $('dr-h').addEventListener('change', function () { sizeChange('h'); });
    function posChange() {
      var b = selBox(), x = num('dr-x'), y = num('dr-y'); if (!b || x == null || y == null) { sync(); return; }
      if (Math.abs(x - b.cx) < 1e-9 && Math.abs(y - b.cy) < 1e-9) { sync(); return; }
      remember(); moveBy(x - b.cx, y - b.cy);
    }
    $('dr-x').addEventListener('change', posChange);
    $('dr-y').addEventListener('change', posChange);
    $('dr-rot').addEventListener('change', function () { var v = num('dr-rot'); $('dr-rot').value = ''; if (v) rotateBy(v); });
    $('dr-trace-go').addEventListener('click', doTrace);
    $('dr-trace-piece').addEventListener('change', syncTrace);
    $('dr-trace-clear').addEventListener('click', function () { if (!sketch.trace) return; remember(); sketch.trace = null; changed(); });
    $('dr-snap-edge').addEventListener('change', function () { D.snapEdge = $('dr-snap-edge').checked; });
    $('dr-clear').addEventListener('click', function () { if (!sketch.objects.length) return; remember(); sketch.objects = []; D.sel = []; changed(true); });
    $('dr-done').addEventListener('click', function () { close(); });
    $('dr-connect').addEventListener('click', function () {
      var cb = D && D.onConnect;
      close();
      if (cb) cb(sketch);
      else if (typeof NSO_AsmEditor !== 'undefined') NSO_AsmEditor.open('drawconnect');
    });
    $('dr-add').addEventListener('click', function () { addToPlate(); });
    window.addEventListener('resize', resize);
  }

  /* ---------------------------------------------------------------- Add to plate */

  async function addToPlate() {
    if (!D || D.busy) return { ok: false, reason: 'busy' };
    var r = SK.solids(sketch, { embed: 0 });
    if (!r.ok) { say(r.reason, true); return r; }
    D.busy = true; sync();
    say('Working…');
    try {
      var soup = await unionParts(r.parts, 'Drawing');
      if (!soup.ok) { say(soup.reason, true); return soup; }
      if (typeof NSO_connectCommit !== 'function') { say('Add to plate needs app-connect.js', true); return { ok: false }; }
      var c = NSO_connectCommit(soup.soup, [], 'drawing', 'Drawing (' + SK.describe(sketch).split(',')[0] + ')');
      if (!c.ok) { say(c.reason, true); return c; }
      if (typeof setStatus === 'function') setStatus('Drawing added to the plate - ' + SK.describe(sketch) + '. One Undo takes it off.');
      say('Added to the plate as a piece of its own. One Undo takes it off.');
      return { ok: true, id: c.id };
    } finally { if (D) { D.busy = false; sync(); } }
  }

  /* The drawing's solids as one soup: parts that share space are unioned (the
     boolean kernel), parts apart are simply put together - two closed shells. */
  async function unionParts(parts, label) {
    var groups = SK.overlapGroups(parts), out = [];
    for (var g = 0; g < groups.length; g++) {
      var acc = groups[g][0].soup;
      for (var i = 1; i < groups[g].length; i++) {
        if (typeof NSO_unionSoups !== 'function') return { ok: false, reason: 'two objects overlap and the boolean kernel did not load' };
        var u = await NSO_unionSoups(acc, groups[g][i].soup, { label: label || 'Drawing' });
        if (!u || !u.ok || !u.soup) return { ok: false, reason: 'the overlapping objects could not be joined' + (u && u.reason ? ' - ' + u.reason : '') };
        acc = u.soup;
      }
      out.push(acc);
    }
    return { ok: true, soup: SK.concat(out), groups: groups.length };
  }

  /* ---------------------------------------------------------------- open / close */

  function open(opts) {
    opts = opts || {};
    buildDom();
    if (D) close();
    D = { tool: 'pencil', sel: [], view: { cx: 0, cy: 0, z: 4 }, history: [], future: [], drag: null, draft: null,
          lock: true, snap: false, snapEdge: true, scaleWidth: false, space: false, busy: false, w: 800, h: 600,
          ref: opts.ref || null, onConnect: opts.onConnect || null, onChange: opts.onChange || null, onClose: opts.onClose || null };
    root.hidden = false;
    document.body.classList.add('draw-editor-open');
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    resize();
    fit();
    setTool('pencil');
    sync();
    $('dr-connect').textContent = opts.onConnect ? 'Back to the piece' : 'Connect to a piece…';
    cv.focus();
    return true;
  }
  function close() {
    if (!D) return;
    var cb = D.onClose;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    D = null;
    root.hidden = true;
    document.body.classList.remove('draw-editor-open');
    var back = $('btn-draw-editor');
    if (cb) cb(sketch); else if (back) back.focus();
  }

  window.NSO_DrawEditor = {
    open: open, close: close, isOpen: function () { return !!D; },
    sketch: function () { return SK.normalize(clone(sketch)); },
    setSketch: function (sk) { sketch = SK.normalize(sk); save(); if (D) { D.sel = []; changed(true); } },
    unionParts: unionParts, addToPlate: addToPlate,
    /* for the checks: the sheet's pixel for a mm point, and what the editor holds */
    screenOf: function (p) { if (!D) return null; var r = cv.getBoundingClientRect(), s = toScreen(p); return [r.left + s[0], r.top + s[1]]; },
    trace: function (id, at) { if (!D) return { ok: false, reason: 'the editor is shut' }; $('dr-trace-piece').value = String(id); $('dr-trace-at').value = at == null ? '' : String(at); return { ok: doTrace(), trace: sketch.trace }; },
    info: function () { return D ? { tool: D.tool, sel: D.sel.slice(), objects: sketch.objects.length, kind: defaults.kind, view: clone(D.view), history: D.history.length } : null; }
  };

  function bind() {
    var b = $('btn-draw-editor');
    if (b) b.addEventListener('click', function () { open(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
