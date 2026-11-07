/* app-custom-shape.js - the Custom shape card (Gen+ > Custom shape): draw an outline, give every corner its own radius and
   every side its own wall and curve, and make it a Tray, a Frame or a Solid. The geometry is nso_custom_shape.js (headless,
   tools/nso_custom_shape_test.js); what is here is what only the app can do - the outline editor, the rows for what is picked,
   the live preview on the plate (app-piece-preview.js) and the bake. docs/CUSTOM-SHAPE.md.

   THE EDITOR is a canvas in millimetres, y up, on a grid. A POINT is a corner: drag it (it snaps to the Snap grid), click it to
   pick it - its X, Y, Radius and Inner R come up below. A SIDE runs from one point to the next: click it to pick it - its Wall
   and Curve come up. The small diamond in the middle of every side is its curve handle: drag it out or in to bow the side.
   Double-click a side to add a point there (on a curved side the new point sits on the curve and both halves stay on the same
   circle, so the outline does not move). Delete removes the picked point. Drag the background to pan, the wheel zooms, Fit
   frames the outline, Big lifts the editor out over the page. Ctrl+Z (or Undo) steps the editor back; it is the card's own
   history - nothing is on the plate until Add to plate, which is one ordinary Undo.

   THE PREVIEW is NSO_CustomShape.make's soup, standing where Add to plate would drop it (nsoPiecePreview, the Fittings card's
   ghost). It follows every change; a refusal clears it, says why in the read-out and marks the point or side it is about in red.

   THE SPEC is kept in this browser (localStorage, a convenience: it can be missing and the card starts from the Rounded
   preset), so a shape is still there when the card is opened again.

   PAINT SCOPE: NONE. The piece reads no face of anything and writes to no face: the selected piece is read for its footprint
   only, to stand the new one beside it. See docs/HANDOFF.md, "Scoping". */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function CS() { return typeof NSO_CustomShape !== 'undefined' ? NSO_CustomShape : null; }
  function PV() { return window.nsoPiecePreview; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function fmt(x) { return CS() ? CS().fmt(x) : String(r2(x)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var STORE = 'nso.customShape.v1';
  var OWNER = 'cshape';
  var BESIDE_GAP = 6;
  var HIT_POINT = 9, HIT_HANDLE = 8, HIT_SIDE = 7;   // css px
  var HISTORY_MAX = 60;

  var S = {
    spec: null, sel: null, out: null, last: null, ok: false,
    view: null, drag: null, hover: null, history: [], tiles: false, big: false, home: null, timer: 0
  };

  /* ================================================================ the spec */

  function load() {
    var sp = null;
    try { var raw = window.localStorage && window.localStorage.getItem(STORE); if (raw) sp = JSON.parse(raw); } catch (e) { sp = null; }
    if (!sp || !sp.points || sp.points.length < 3) sp = CS().preset('rounded');
    return CS().normalize(sp);
  }
  function save() { try { if (window.localStorage) window.localStorage.setItem(STORE, JSON.stringify(S.spec)); } catch (e) { /* private window: fine */ } }
  function remember() {
    S.history.push(JSON.stringify(S.spec));
    if (S.history.length > HISTORY_MAX) S.history.shift();
  }
  function undoEdit() {
    if (!S.history.length) return false;
    S.spec = CS().normalize(JSON.parse(S.history.pop()));
    if (S.sel && ((S.sel.kind === 'point' && S.sel.i >= S.spec.points.length) || (S.sel.kind === 'side' && S.sel.i >= S.spec.sides.length))) S.sel = null;
    changed(true);
    return true;
  }

  /* ================================================================ the card's state */

  function menu() { return $('menu-cshape'); }
  function isOpen() {
    var m = menu();
    for (var d = m; d; d = d.parentElement && d.parentElement.closest('details')) if (!d.open) return false;
    return !!m;
  }
  function readout(text, bad) {
    var el = $('cs-readout');
    if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  }
  function setAdd(on) { var b = $('btn-cs-add'); if (b) b.disabled = !on; S.ok = !!on; }

  /* Everything that follows a change to the spec: the 2D outline now, the 3D preview on a short timer (a drag sends many). */
  function changed(now) {
    S.out = CS().outline(S.spec);
    save();
    syncRows();
    draw();
    if (now) refresh(); else soon();
  }
  function soon() {
    if (S.timer) return;
    S.timer = setTimeout(function () { S.timer = 0; refresh(); }, 70);
  }

  function refresh() {
    if (!isOpen()) { if (PV()) PV().clear(OWNER); return null; }
    var r = CS().make(S.spec);
    S.last = r;
    if (!r.ok) {
      if (PV()) PV().clear(OWNER);
      setAdd(false);
      readout('Custom shape: ' + r.reason, true);
      return r;
    }
    if (PV()) PV().show(OWNER, [r.soup]);
    setAdd(true);
    var txt = r.text + (r.info.minWall != null ? ' - thinnest wall ' + fmt(r.info.minWall) + ' mm' : '') + ', ' + fmt(r.info.volume / 1000) + ' cm³';
    if (r.warnings.length) txt += '. ' + r.warnings.join('; ');
    readout(txt, false);
    return r;
  }

  /* ================================================================ the rows */

  function setBox(id, v, read, unit) {
    var box = $(id), sl = $(id + '-slider'), rd = $(read);
    if (box && document.activeElement !== box) box.value = v == null ? '' : String(r2(v));   // never under the caret
    if (sl && v != null) sl.value = String(v);
    if (rd) rd.textContent = v == null ? (unit === 'auto' ? 'auto' : '—') : fmt(v) + ' mm';
  }
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }

  function common(list, key) {
    if (!list.length) return null;
    var v = list[0][key];
    for (var i = 1; i < list.length; i++) if (Math.abs(list[i][key] - v) > 1e-9) return null;
    return v;
  }

  function syncRows() {
    var sp = S.spec, sel = S.sel, walled = sp.mode !== 'solid';
    document.querySelectorAll('#cs-mode-row [data-mode]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === sp.mode ? 'true' : 'false'); });
    show('cs-row-floor', sp.mode === 'tray');
    show('cs-row-allwall', walled);
    show('cs-row-rin', walled);
    show('btn-cs-rin-auto', walled);
    show('cs-row-wall', walled);
    show('cs-sel-none', !sel);
    show('cs-sel-point', !!sel && sel.kind === 'point');
    show('cs-sel-side', !!sel && sel.kind === 'side');
    setBox('inp-cs-height', sp.height, 'cs-height-read');
    setBox('inp-cs-floor', sp.floor, 'cs-floor-read');
    var cw = common(sp.sides, 'wall'), cr = common(sp.points, 'r');
    setBox('inp-cs-allwall', cw, 'cs-allwall-read');
    setBox('inp-cs-allr', cr, 'cs-allr-read');
    if (cw == null) { var rw = $('cs-allwall-read'); if (rw) rw.textContent = 'mixed'; }
    if (cr == null) { var rr = $('cs-allr-read'); if (rr) rr.textContent = 'mixed'; }
    var size = $('cs-size');
    if (size) size.textContent = S.out && S.out.ok ? fmt(S.out.info.width) + ' × ' + fmt(S.out.info.depth) + ' mm' : '—';

    if (sel && sel.kind === 'point') {
      var p = sp.points[sel.i];
      var t = $('cs-point-title'); if (t) t.textContent = 'Point ' + (sel.i + 1) + ' of ' + sp.points.length;
      var bx = $('inp-cs-x'), by = $('inp-cs-y');
      if (bx && document.activeElement !== bx) bx.value = String(r2(p.x));
      if (by && document.activeElement !== by) by.value = String(r2(p.y));
      setBox('inp-cs-r', p.r, 'cs-r-read');
      var max = CS().maxRadius(sp, sel.i), rd = $('cs-r-read');
      if (rd) rd.textContent = fmt(p.r) + ' mm' + (max > 0 ? ' / ' + fmt(max) : '');
      if (rd) rd.title = 'The most this corner has room for, with its neighbours as they are: ' + fmt(max) + ' mm';
      var c = S.out && S.out.ok && S.out.corners ? S.out.corners[sel.i] : null;
      setBox('inp-cs-rin', p.rIn, 'cs-rin-read', 'auto');
      var ri = $('cs-rin-read');
      if (ri && p.rIn == null) ri.textContent = 'auto' + (c && c.rIn != null ? ' ' + fmt(c.rIn) : '');
      var rs = $('inp-cs-rin-slider'); if (rs && p.rIn == null && c && c.rIn != null) rs.value = String(c.rIn);
      var del = $('btn-cs-del'); if (del) del.disabled = sp.points.length <= 3;
    }
    if (sel && sel.kind === 'side') {
      var s = sp.sides[sel.i], n = sp.points.length, len = S.out && S.out.ok ? S.out.info.sideLengths[sel.i] : null;
      var a = sp.points[sel.i], b = sp.points[(sel.i + 1) % n];
      if (len == null) len = Math.hypot(b.x - a.x, b.y - a.y);
      var st = $('cs-side-title'); if (st) st.textContent = 'Side ' + (sel.i + 1) + ' - point ' + (sel.i + 1) + ' to ' + ((sel.i + 1) % n + 1) + ', ' + fmt(len) + ' mm';
      setBox('inp-cs-wall', s.wall, 'cs-wall-read');
      setBox('inp-cs-bulge', s.bulge, 'cs-bulge-read');
    }
  }

  /* ================================================================ editing */

  function select(sel) {
    S.sel = sel;
    syncRows();
    draw();
  }

  function snapStep() { var v = parseFloat(($('sel-cs-snap') || {}).value); return isFinite(v) && v > 0 ? v : 0; }
  function snap(v) { var s = snapStep(); return s ? Math.round(v / s) * s : r2(v); }

  function orient() { return CS().signedArea(S.spec.points.map(function (p) { return [p.x, p.y]; })) >= 0 ? 1 : -1; }
  /* side i's chord, its outward unit normal and the bulge handle's position */
  function sideGeom(i) {
    var sp = S.spec, n = sp.points.length, a = sp.points[i], b = sp.points[(i + 1) % n];
    var dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, o = orient();
    var nx = dy / len * o, ny = -dx / len * o;                 // outward: right of travel when counter-clockwise
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, bu = sp.sides[i].bulge;
    return { a: a, b: b, len: len, nx: nx, ny: ny, mx: mx, my: my, hx: mx + nx * bu, hy: my + ny * bu, bulge: bu };
  }
  /* the arc through a side (null when straight): centre and radius */
  function sideArc(g) {
    if (Math.abs(g.bulge) < 1e-6) return null;
    var h = g.len / 2, s = Math.abs(g.bulge), R = (h * h + s * s) / (2 * s), k = g.bulge > 0 ? 1 : -1;
    var off = k * (R - s);                                     // from the chord's middle, inward
    return { cx: g.mx - g.nx * off, cy: g.my - g.ny * off, R: R };
  }
  function sagittaFor(R, chord, sign) { var h = chord / 2; return sign * (R - Math.sqrt(Math.max(0, R * R - h * h))); }

  /* add a point on side i at world (x, y) - on the curve when the side is curved, both halves on the same circle */
  function splitSide(i, x, y) {
    var sp = S.spec, n = sp.points.length, g = sideGeom(i), arc = sideArc(g), side = sp.sides[i];
    var nx, ny;
    if (arc) {
      var vx = x - arc.cx, vy = y - arc.cy, l = Math.hypot(vx, vy) || 1;
      nx = arc.cx + vx / l * arc.R; ny = arc.cy + vy / l * arc.R;
    } else {
      var t = ((x - g.a.x) * (g.b.x - g.a.x) + (y - g.a.y) * (g.b.y - g.a.y)) / (g.len * g.len);
      t = Math.max(0.05, Math.min(0.95, t));
      nx = g.a.x + (g.b.x - g.a.x) * t; ny = g.a.y + (g.b.y - g.a.y) * t;
      nx = snap(nx); ny = snap(ny);
    }
    remember();
    var r = Math.min(g.a.r, g.b.r);
    var np = { x: r2(nx), y: r2(ny), r: r, rIn: null };
    var s1 = { wall: side.wall, bulge: 0 }, s2 = { wall: side.wall, bulge: 0 };
    if (arc) {
      var sign = g.bulge > 0 ? 1 : -1;
      s1.bulge = r2(sagittaFor(arc.R, Math.hypot(np.x - g.a.x, np.y - g.a.y), sign));
      s2.bulge = r2(sagittaFor(arc.R, Math.hypot(g.b.x - np.x, g.b.y - np.y), sign));
    }
    sp.points.splice(i + 1, 0, np);
    sp.sides.splice(i, 1, s1, s2);
    S.sel = { kind: 'point', i: i + 1 };
    changed(true);
  }

  function deletePoint(i) {
    var sp = S.spec, n = sp.points.length;
    if (n <= 3) { readout('Custom shape: an outline keeps at least 3 points', true); return false; }
    remember();
    var prev = (i + n - 1) % n;
    sp.sides[prev] = { wall: sp.sides[prev].wall, bulge: 0 };   // the two sides either side become one, straight
    sp.points.splice(i, 1);
    sp.sides.splice(i, 1);
    S.sel = null;
    changed(true);
    return true;
  }

  function setMode(m) {
    if (CS().MODES.indexOf(m) < 0 || S.spec.mode === m) return;
    remember();
    S.spec.mode = m;
    changed(true);
  }
  function usePreset(name) {
    var p = CS().preset(name);
    if (!p) return;
    remember();
    p.mode = S.spec.mode;
    S.spec = p;
    S.sel = null;
    S.view = null;
    changed(true);
  }

  /* ================================================================ the editor canvas */

  function cv() { return $('cs-editor'); }
  function dims() {
    var c = cv(), w = c ? (c.clientWidth || 264) : 264, h = c ? (c.clientHeight || w) : w;
    return { w: w, h: h };
  }
  function fit() {
    var sp = S.spec, d = dims(), lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    var add = function (x, y) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); };
    sp.points.forEach(function (p) { add(p.x, p.y); });
    for (var i = 0; i < sp.sides.length; i++) { var g = sideGeom(i); add(g.hx, g.hy); }
    if (S.out && S.out.ok) S.out.outer.forEach(function (p) { add(p[0], p[1]); });
    var span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 10), k = Math.min(d.w, d.h) * 0.8 / span;
    S.view = { x0: (lo[0] + hi[0]) / 2 - d.w / 2 / k, y0: (lo[1] + hi[1]) / 2 + d.h / 2 / k, k: k };
  }
  /* The view is anchored at the canvas's TOP-LEFT corner (x0, y0: the mm there), not its middle: the canvas narrows when the
     Gen+ panel grows a scrollbar (picking a point brings rows up), and a middle-anchored view would slide under the pointer. */
  function toScreen(x, y) { var v = S.view; return [(x - v.x0) * v.k, (v.y0 - y) * v.k]; }
  function toWorld(sx, sy) { var v = S.view; return [v.x0 + sx / v.k, v.y0 - sy / v.k]; }

  function draw() {
    var c = cv();
    if (!c || !c.getContext || !S.spec) return;
    var d = dims(), dpr = window.devicePixelRatio || 1;
    var W = Math.round(d.w * dpr), H = Math.round(d.h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    if (!S.view) fit();
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, d.w, d.h);

    /* the grid: the finest of 1, 2, 5, 10... mm that stands at least 10 px apart, every 5th brighter */
    var steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200], step = steps[steps.length - 1];
    for (var q = 0; q < steps.length; q++) if (steps[q] * S.view.k >= 10) { step = steps[q]; break; }
    var tl = toWorld(0, 0), br = toWorld(d.w, d.h);
    ctx.lineWidth = 1;
    for (var gx = Math.floor(tl[0] / step) * step; gx <= br[0]; gx += step) {
      var sx = Math.round(toScreen(gx, 0)[0]) + 0.5, major = Math.abs(Math.round(gx / step) % 5) === 0;
      ctx.strokeStyle = Math.abs(gx) < step / 2 ? '#475569' : major ? '#1e293b' : '#131c2e';
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, d.h); ctx.stroke();
    }
    for (var gy = Math.floor(br[1] / step) * step; gy <= tl[1]; gy += step) {
      var sy = Math.round(toScreen(0, gy)[1]) + 0.5, major2 = Math.abs(Math.round(gy / step) % 5) === 0;
      ctx.strokeStyle = Math.abs(gy) < step / 2 ? '#475569' : major2 ? '#1e293b' : '#131c2e';
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(d.w, sy); ctx.stroke();
    }
    ctx.fillStyle = '#64748b'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('grid ' + fmt(step) + ' mm', d.w - 4, d.h - 3);

    var sp = S.spec, n = sp.points.length, out = S.out, i;
    function path(loop) {
      loop.forEach(function (p, j) { var s = toScreen(p[0], p[1]); if (j) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
      ctx.closePath();
    }
    /* the outline as it will be made: the wall filled, the inside left open */
    if (out && out.ok) {
      ctx.beginPath(); path(out.outer); if (out.inner) path(out.inner);
      ctx.fillStyle = out.inner ? 'rgba(56, 189, 248, 0.45)' : 'rgba(56, 189, 248, 0.28)';
      ctx.fill('evenodd');
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#38bdf8';
      ctx.beginPath(); path(out.outer); ctx.stroke();
      if (out.inner) { ctx.lineWidth = 1; ctx.strokeStyle = '#7dd3fc'; ctx.beginPath(); path(out.inner); ctx.stroke(); }
    }
    /* the construction: point to point, straight - the dashed line the curve handles stand off */
    var bad = out && !out.ok ? (out.at || {}) : {};
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    for (i = 0; i < n; i++) {
      var g = sideGeom(i), a = toScreen(g.a.x, g.a.y), b = toScreen(g.b.x, g.b.y);
      var picked = S.sel && S.sel.kind === 'side' && S.sel.i === i, isBad = bad.side === i;
      ctx.strokeStyle = isBad ? '#f87171' : picked ? '#fbbf24' : (out && !out.ok ? '#f87171' : 'rgba(148, 163, 184, 0.55)');
      ctx.lineWidth = picked || isBad ? 2.5 : 1;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.setLineDash([]);
    /* side labels, where there is room: the side's number and (walled) its wall */
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (i = 0; i < n; i++) {
      var gg = sideGeom(i), slen = gg.len * S.view.k;
      if (slen < 46) continue;
      var lx = gg.mx - gg.nx * (14 / S.view.k), ly = gg.my - gg.ny * (14 / S.view.k), ls = toScreen(lx, ly);
      var picked2 = S.sel && S.sel.kind === 'side' && S.sel.i === i;
      ctx.fillStyle = picked2 ? '#fbbf24' : '#94a3b8';
      ctx.fillText(sp.mode === 'solid' ? 's' + (i + 1) : 's' + (i + 1) + ' · ' + fmt(sp.sides[i].wall), ls[0], ls[1]);
    }
    /* curve handles: a diamond in the middle of each side, stood off by its curve */
    for (i = 0; i < n; i++) {
      var gh = sideGeom(i), hs = toScreen(gh.hx, gh.hy);
      var hot = (S.hover && S.hover.kind === 'handle' && S.hover.i === i) || (S.drag && S.drag.kind === 'handle' && S.drag.i === i);
      ctx.fillStyle = hot ? '#fbbf24' : Math.abs(gh.bulge) > 1e-6 ? '#a78bfa' : 'rgba(167, 139, 250, 0.55)';
      ctx.beginPath(); ctx.moveTo(hs[0], hs[1] - 5); ctx.lineTo(hs[0] + 5, hs[1]); ctx.lineTo(hs[0], hs[1] + 5); ctx.lineTo(hs[0] - 5, hs[1]); ctx.closePath(); ctx.fill();
    }
    /* points: numbered, the picked one amber, one a refusal is about red */
    var badPts = bad.points || (bad.point != null ? [bad.point] : []);
    for (i = 0; i < n; i++) {
      var p = sp.points[i], ps = toScreen(p.x, p.y);
      var pk = S.sel && S.sel.kind === 'point' && S.sel.i === i, hv = S.hover && S.hover.kind === 'point' && S.hover.i === i;
      ctx.beginPath(); ctx.arc(ps[0], ps[1], pk ? 6 : 5, 0, 2 * Math.PI);
      ctx.fillStyle = badPts.indexOf(i) >= 0 ? '#f87171' : pk ? '#fbbf24' : hv ? '#ffffff' : '#e2e8f0';
      ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#0b1220'; ctx.stroke();
      ctx.fillStyle = pk ? '#fbbf24' : '#cbd5e1'; ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText(String(i + 1), ps[0] + 10, ps[1] - 9);
    }
  }

  /* what is under the pointer: a point, then a curve handle, then a side */
  function hit(sx, sy) {
    var sp = S.spec, n = sp.points.length, i, best = null, bd = Infinity;
    for (i = 0; i < n; i++) {
      var p = toScreen(sp.points[i].x, sp.points[i].y), dd = Math.hypot(p[0] - sx, p[1] - sy);
      if (dd <= HIT_POINT && dd < bd) { bd = dd; best = { kind: 'point', i: i }; }
    }
    if (best) return best;
    for (i = 0; i < n; i++) {
      var g = sideGeom(i), h = toScreen(g.hx, g.hy), dh = Math.hypot(h[0] - sx, h[1] - sy);
      if (dh <= HIT_HANDLE && dh < bd) { bd = dh; best = { kind: 'handle', i: i }; }
    }
    if (best) return best;
    for (i = 0; i < n; i++) {
      var g2 = sideGeom(i), a = toScreen(g2.a.x, g2.a.y), b = toScreen(g2.b.x, g2.b.y);
      var vx = b[0] - a[0], vy = b[1] - a[1], ll = vx * vx + vy * vy;
      var t = ll > 0 ? Math.max(0, Math.min(1, ((sx - a[0]) * vx + (sy - a[1]) * vy) / ll)) : 0;
      var ds = Math.hypot(a[0] + vx * t - sx, a[1] + vy * t - sy);
      /* a curved side is also hit along its curve: sample it */
      var arc = sideArc(g2);
      if (arc) {
        for (var k = 1; k < 16; k++) {
          var tt = k / 16, px = g2.a.x + (g2.b.x - g2.a.x) * tt, py = g2.a.y + (g2.b.y - g2.a.y) * tt;
          var vx2 = px - arc.cx, vy2 = py - arc.cy, l2 = Math.hypot(vx2, vy2) || 1;
          var on = toScreen(arc.cx + vx2 / l2 * arc.R, arc.cy + vy2 / l2 * arc.R);
          ds = Math.min(ds, Math.hypot(on[0] - sx, on[1] - sy));
        }
      }
      if (ds <= HIT_SIDE && ds < bd) { bd = ds; best = { kind: 'side', i: i }; }
    }
    return best;
  }

  /* pointer -> the canvas's content box (inside its border), the box draw() lays out in */
  function local(ev) { var c = cv(), r = c.getBoundingClientRect(); return [ev.clientX - r.left - c.clientLeft, ev.clientY - r.top - c.clientTop]; }

  function onDown(ev) {
    if (ev.button !== 0) return;
    var c = cv();
    try { c.focus({ preventScroll: true }); } catch (e) { c.focus(); }   // a scrolled panel would move the canvas under the drag
    var at = local(ev), h = hit(at[0], at[1]);
    S.lastDown = at;
    c.setPointerCapture && c.setPointerCapture(ev.pointerId);
    if (h && h.kind === 'point') {
      S.drag = { kind: 'point', i: h.i, moved: false, before: JSON.stringify(S.spec) };
      select({ kind: 'point', i: h.i });
    } else if (h && h.kind === 'handle') {
      S.drag = { kind: 'handle', i: h.i, moved: false, before: JSON.stringify(S.spec) };
      select({ kind: 'side', i: h.i });
    } else if (h && h.kind === 'side') {
      S.drag = null;
      select({ kind: 'side', i: h.i });
    } else {
      S.drag = { kind: 'pan', sx: at[0], sy: at[1], x0: S.view.x0, y0: S.view.y0, moved: false };
    }
    ev.preventDefault();
  }
  function onMove(ev) {
    var at = local(ev), dr = S.drag;
    if (!dr) {
      var h = hit(at[0], at[1]), was = S.hover;
      S.hover = h;
      cv().style.cursor = h ? (h.kind === 'side' ? 'pointer' : 'grab') : 'crosshair';
      if ((was && was.kind) !== (h && h.kind) || (was && was.i) !== (h && h.i)) draw();
      return;
    }
    if (dr.kind === 'pan') {
      S.view.x0 = dr.x0 - (at[0] - dr.sx) / S.view.k;
      S.view.y0 = dr.y0 + (at[1] - dr.sy) / S.view.k;
      dr.moved = true;
      draw();
      return;
    }
    var w = toWorld(at[0], at[1]);
    if (dr.kind === 'point') {
      var p = S.spec.points[dr.i], nx = snap(w[0]), ny = snap(w[1]);
      if (nx === p.x && ny === p.y) return;
      p.x = nx; p.y = ny; dr.moved = true;
      changed(false);
    } else if (dr.kind === 'handle') {
      var g = sideGeom(dr.i), b = (w[0] - g.mx) * g.nx + (w[1] - g.my) * g.ny;
      b = Math.max(-g.len, Math.min(g.len, snap(b)));
      if (Math.abs(b) < (snapStep() || 0.25) / 2) b = 0;
      if (b === S.spec.sides[dr.i].bulge) return;
      S.spec.sides[dr.i].bulge = b; dr.moved = true;
      changed(false);
    }
  }
  function onUp(ev) {
    var dr = S.drag;
    S.drag = null;
    var c = cv();
    if (c.releasePointerCapture) try { c.releasePointerCapture(ev.pointerId); } catch (e) { /* not captured */ }
    if (!dr) return;
    if (dr.kind === 'pan') { if (!dr.moved) select(null); return; }
    if (dr.moved) {
      S.history.push(dr.before);
      if (S.history.length > HISTORY_MAX) S.history.shift();
      refresh();
    }
  }
  function onDbl(ev) {
    /* the pointerdown just before it: a dblclick's clientX / clientY are whole pixels, a pointer event's are not */
    var at = S.lastDown || local(ev), h = hit(at[0], at[1]);
    if (h && (h.kind === 'side' || h.kind === 'handle')) {
      var w = toWorld(at[0], at[1]);
      splitSide(h.i, w[0], w[1]);
    }
    ev.preventDefault();
  }
  function onWheel(ev) {
    ev.preventDefault();
    var at = local(ev), before = toWorld(at[0], at[1]);
    var f = Math.exp(-ev.deltaY * 0.0015);
    S.view.k = Math.max(0.05, Math.min(80, S.view.k * f));
    var after = toWorld(at[0], at[1]);
    S.view.x0 += before[0] - after[0]; S.view.y0 += before[1] - after[1];
    draw();
  }
  function onKey(ev) {
    var k = ev.key, sel = S.sel;
    if ((ev.ctrlKey || ev.metaKey) && (k === 'z' || k === 'Z')) { undoEdit(); ev.preventDefault(); ev.stopPropagation(); return; }
    if (k === 'Escape') { if (S.big) setBig(false); else select(null); ev.preventDefault(); ev.stopPropagation(); return; }
    if ((k === 'Delete' || k === 'Backspace') && sel && sel.kind === 'point') { deletePoint(sel.i); ev.preventDefault(); ev.stopPropagation(); return; }
    var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (arrows[k] && sel && sel.kind === 'point') {
      var step = (snapStep() || 0.5) * (ev.shiftKey ? 10 : 1), p = S.spec.points[sel.i];
      remember();
      p.x = r2(p.x + arrows[k][0] * step); p.y = r2(p.y + arrows[k][1] * step);
      changed(false);
      ev.preventDefault(); ev.stopPropagation();
    }
  }

  /* Big: the editor lifted out over the page - moved to <body> and back, since a position: fixed box inside the Gen+ panel
     (which has a backdrop-filter) would be fixed to the panel, not the window. */
  function setBig(on) {
    var wrap = $('cs-editor-wrap'), btn = $('btn-cs-big');
    if (!wrap || S.big === !!on) return;
    if (on) {
      S.home = { parent: wrap.parentNode, next: wrap.nextSibling };
      document.body.appendChild(wrap);
      wrap.classList.add('is-big');
    } else {
      wrap.classList.remove('is-big');
      if (S.home && S.home.parent) S.home.parent.insertBefore(wrap, S.home.next);
      S.home = null;
    }
    S.big = !!on;
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    fit(); draw();
    if (on) { try { cv().focus({ preventScroll: true }); } catch (e) { cv().focus(); } }
  }

  /* ================================================================ the bake */

  function nextName(label) {
    var top = 0, re = new RegExp('^' + label + ' (\\d+)$');
    (state.models || []).forEach(function (m) { var hitN = m && re.exec(m.name || ''); if (hitN) top = Math.max(top, parseInt(hitN[1], 10)); });
    return label + ' ' + (top + 1);
  }
  function wantedSpot(made) {
    var sel = (state.selectedIndex >= 0) ? state.placed[state.selectedIndex] : null;
    if (!sel || !sel.mesh) return { x: 0, z: 0, beside: null };
    var fp = (typeof placedFootprint === 'function') ? placedFootprint(sel) : null;
    var right = fp ? fp.maxx : sel.x + (sel.width || 0) / 2;
    var mid = fp ? (fp.minz + fp.maxz) / 2 : sel.z;
    var src = (state.models || []).find(function (x) { return x && x.id === sel.sourceId; });
    return { x: right + BESIDE_GAP + made.size.x / 2, z: mid, beside: (src && src.name) || sel.name || null };
  }

  /* Put the soup on the plate as a piece of its own - Stock's and Fittings' drop, step for step: one 'addModels' Undo entry,
     the nearest free spot beside the selection, selected. */
  function add() {
    var r = CS() ? CS().make(S.spec) : null;
    if (!r || !r.ok) { var why = r ? r.reason : 'nso_custom_shape.js is not loaded'; say('Custom shape refused - nothing added: ' + why, true); return { ok: false, reason: why }; }
    if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') { say('Custom shape needs the viewport', true); return { ok: false, reason: 'no ingest path' }; }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.soup), 3));
    var name = nextName('custom ' + r.info.mode), editBefore = state.editId, cutBefore = state.cutT;
    var id = addModelFromZUpGeometry(name, g, { keepSelection: true, silent: true });
    if (id == null) { say('Custom shape refused - the new piece looked empty', true); return { ok: false, reason: 'addModel refused' }; }
    var made = state.models.find(function (x) { return x && x.id === id; });
    if (typeof pushUndo === 'function') pushUndo({ type: 'addModels', ids: [id], editId: editBefore, cutT: cutBefore });
    var want = wantedSpot(made), entry = placeModelMovable(made, want.x, want.z), at = { x: want.x, z: want.z, onBed: true };
    if (entry && typeof nsoFreeSpot === 'function') at = nsoFreeSpot(entry, want);
    if (entry && typeof applyPlacedXZ === 'function') applyPlacedXZ(entry, at.x, at.z);
    var idx = entry ? state.placed.indexOf(entry) : -1;
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    var txt = 'Dropped ' + name + ' - ' + r.text + (want.beside ? ', beside ' + want.beside : '') + '.';
    if (r.warnings.length) txt += ' ' + r.warnings.join('; ') + '.';
    if (!at.onBed) txt += ' The plate has no free room left - it sits past the edge.';
    say(txt, !at.onBed);
    if (isOpen()) refresh();                                   // the preview stands beside what was just added
    return { ok: true, modelId: id, name: name, placedIndex: idx, info: r.info };
  }

  /* ================================================================ tiles */

  function drawTiles() {
    if (S.tiles || !CS() || !window.nsoStockShelf || typeof window.nsoStockShelf.paint !== 'function') return 0;
    S.tiles = true;
    var done = 0, paint = window.nsoStockShelf.paint, view = { yaw: 0.5, elev: 0.95 };
    document.querySelectorAll('#cs-preset-row [data-preset]').forEach(function (b) {
      var sp = CS().preset(b.getAttribute('data-preset')), r = sp && CS().make(sp), c = b.querySelector('canvas');
      if (r && r.ok && c && paint(c, r.soup, null, view)) { c.setAttribute('data-drawn', '1'); done++; }
    });
    document.querySelectorAll('#cs-mode-row [data-mode]').forEach(function (b) {
      var sp = CS().preset('rounded'); sp.mode = b.getAttribute('data-mode'); sp.sides.forEach(function (s) { s.wall = 5; });
      var r = CS().make(sp), c = b.querySelector('canvas');
      if (r && r.ok && c && paint(c, r.soup, null, { yaw: 0.5, elev: 0.75 })) { c.setAttribute('data-drawn', '1'); done++; }
    });
    return done;
  }

  /* ================================================================ wiring */

  function bindNum(name, onValue) {
    var id = 'inp-cs-' + name;
    if (window.nsoLiveSlider) {
      return window.nsoLiveSlider.bind({ slider: id + '-slider', box: id, read: 'cs-' + name + '-read', unit: ' mm', onLive: onValue });
    }
    var box = $(id), sl = $(id + '-slider');
    if (box) box.addEventListener('input', function () { if (sl) sl.value = box.value; var v = parseFloat(box.value); if (isFinite(v)) onValue(v); });
    if (sl) sl.addEventListener('input', function () { if (box) box.value = sl.value; onValue(parseFloat(sl.value)); });
    return null;
  }
  /* a typed or slid change: one editor-history step per burst, not per pixel */
  var burst = { key: '', at: 0 };
  function edit(key, fn) {
    var now = Date.now();
    if (burst.key !== key || now - burst.at > 800) remember();
    burst.key = key; burst.at = now;
    fn();
    changed(false);
  }

  function wire() {
    var m = menu();
    if (!m || m.dataset.nsoWired === '1' || !CS()) return;
    m.dataset.nsoWired = '1';
    S.spec = load();
    S.out = CS().outline(S.spec);

    document.querySelectorAll('#cs-preset-row [data-preset]').forEach(function (b) { b.addEventListener('click', function () { usePreset(b.getAttribute('data-preset')); }); });
    document.querySelectorAll('#cs-mode-row [data-mode]').forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); }); });

    bindNum('height', function (v) { if (v > 0) edit('height', function () { S.spec.height = v; }); });
    bindNum('floor', function (v) { if (v > 0) edit('floor', function () { S.spec.floor = v; }); });
    bindNum('allwall', function (v) { if (v > 0) edit('allwall', function () { S.spec.sides.forEach(function (s) { s.wall = v; }); }); });
    bindNum('allr', function (v) { if (v >= 0) edit('allr', function () { S.spec.points.forEach(function (p) { p.r = v; }); }); });
    bindNum('r', function (v) { if (v >= 0 && S.sel && S.sel.kind === 'point') { var i = S.sel.i; edit('r' + i, function () { S.spec.points[i].r = v; }); } });
    bindNum('rin', function (v) { if (v >= 0 && S.sel && S.sel.kind === 'point') { var i = S.sel.i; edit('rin' + i, function () { S.spec.points[i].rIn = v; }); } });
    bindNum('wall', function (v) { if (v > 0 && S.sel && S.sel.kind === 'side') { var i = S.sel.i; edit('wall' + i, function () { S.spec.sides[i].wall = v; }); } });
    bindNum('bulge', function (v) { if (isFinite(v) && S.sel && S.sel.kind === 'side') { var i = S.sel.i; edit('bulge' + i, function () { S.spec.sides[i].bulge = v; }); } });
    ['x', 'y'].forEach(function (ax) {
      var box = $('inp-cs-' + ax);
      if (box) box.addEventListener('input', function () {
        var v = parseFloat(box.value);
        if (!isFinite(v) || !S.sel || S.sel.kind !== 'point') return;
        var i = S.sel.i;
        edit(ax + i, function () { S.spec.points[i][ax] = v; });
      });
    });
    var ra = $('btn-cs-rin-auto');
    if (ra) ra.addEventListener('click', function () { if (S.sel && S.sel.kind === 'point') { remember(); S.spec.points[S.sel.i].rIn = null; changed(true); } });
    var del = $('btn-cs-del');
    if (del) del.addEventListener('click', function () { if (S.sel && S.sel.kind === 'point') deletePoint(S.sel.i); });
    var sp = $('btn-cs-split');
    if (sp) sp.addEventListener('click', function () {
      if (!S.sel || S.sel.kind !== 'side') return;
      var g = sideGeom(S.sel.i);
      splitSide(S.sel.i, g.hx, g.hy);                         // the side's middle (on its curve, when curved)
    });
    var fb = $('btn-cs-fit'); if (fb) fb.addEventListener('click', function () { fit(); draw(); });
    var bb = $('btn-cs-big'); if (bb) bb.addEventListener('click', function () { setBig(!S.big); });
    var ab = $('btn-cs-add');
    if (ab) ab.addEventListener('click', function () {
      try { add(); } catch (err) { if (typeof console !== 'undefined') console.error('[custom shape]', err); say('Custom shape failed - nothing added (' + ((err && err.message) || err) + ')', true); }
    });

    var c = cv();
    if (c) {
      c.addEventListener('pointerdown', onDown);
      c.addEventListener('pointermove', onMove);
      c.addEventListener('pointerup', onUp);
      c.addEventListener('pointercancel', onUp);
      c.addEventListener('pointerleave', function () { if (!S.drag && S.hover) { S.hover = null; draw(); } });
      c.addEventListener('dblclick', onDbl);
      c.addEventListener('wheel', onWheel, { passive: false });
      c.addEventListener('keydown', onKey);
      if (typeof ResizeObserver === 'function') new ResizeObserver(function () { if (isOpen() || S.big) draw(); }).observe(c);
    }
    window.addEventListener('keydown', function (ev) { if (S.big && ev.key === 'Escape') { setBig(false); ev.stopPropagation(); } }, true);

    var onToggle = function () {
      if (isOpen()) { drawTiles(); syncRows(); draw(); refresh(); }
      else { if (S.big) setBig(false); if (PV()) PV().clear(OWNER); }
    };
    for (var d = m; d; d = d.parentElement && d.parentElement.closest('details')) d.addEventListener('toggle', onToggle);
    /* a click on the plate may change the selection, and the preview stands beside the selection */
    window.addEventListener('pointerup', function () {
      if (!isOpen()) return;
      setTimeout(function () { if (PV() && PV().state().owner === OWNER) PV().place(); }, 0);
    });
    syncRows();
    if (isOpen()) onToggle();
  }

  /* Exposed so a drive check runs the same paths a click runs. */
  window.nsoCustomShape = {
    spec: function () { return clone(S.spec); },
    setSpec: function (sp) { remember(); S.spec = CS().normalize(sp); S.sel = null; S.view = null; changed(true); return clone(S.spec); },
    select: function (kind, i) { select(kind ? { kind: kind, i: i } : null); return S.sel; },
    preset: usePreset, mode: setMode, split: splitSide, remove: deletePoint, undo: undoEdit, add: add, refresh: refresh,
    big: setBig, fit: function () { fit(); draw(); },
    toScreen: function (x, y) { return toScreen(x, y); },
    /* where world (x, y) mm is in the window, as a pointer event's clientX / clientY */
    toClient: function (x, y) { var c = cv(), r = c.getBoundingClientRect(), s = toScreen(x, y); return [r.left + c.clientLeft + s[0], r.top + c.clientTop + s[1]]; },
    state: function () {
      var g = PV() ? PV().state() : { owner: null, count: 0, ghost: [] }, mine = g.owner === OWNER;
      return { open: isOpen(), ok: S.ok, sel: S.sel, ghosts: mine ? g.count : 0, ghost: mine ? g.ghost : [], tiles: S.tiles, big: S.big,
               history: S.history.length, last: S.last ? { ok: S.last.ok, reason: S.last.reason || null, info: S.last.info || null, warnings: S.last.warnings || [] } : null };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
