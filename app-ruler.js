/* Ruler — a 300 mm / 12 in ruler laid over the viewport, to line a piece up
   against.

   WHAT IT IS. A flat ruler drawn on the screen, not in the scene. It is dragged
   anywhere in the viewport and never turns: it is locked level, so its marks
   always read left to right along the screen's own horizontal. Its body is
   click-through - only the spine (the thin bar the ticks hang from) takes the
   pointer - so you can still orbit, pan and zoom the piece underneath it, which
   is the whole use: slide the ruler beside an edge, then move the PIECE until
   the edge sits on a mark.

   WHAT ITS SCALE MEANS. This is the part that needs saying out loud, because
   the camera is a perspective one. A screen has no single millimetres-per-pixel:
   a thing twice as far from the camera is half the size on screen. A ruler on
   the glass is therefore true for exactly one distance from the camera, and
   this one says which:

     * nothing picked - the nearest surface under the visible part of the ruler:
       a piece, or a ghost / preview (Custom shape, Crop's box...), else the
       plate. The caption says how high that surface is;
     * a point or an edge picked - that point (an edge: its middle), so the
       number the ruler gives for it is true.

   The caption on the spine names the one in force. The reading for a point that
   is NOT at that distance is off by the ratio of the two distances, which is
   why an edge pick also reports how far its two ends are from each other in
   depth ("depth d", 0 % = the edge is square to the view) and how far it is from
   lying along the ruler ("tilt"). Both near zero and the marks mean what they
   say; if either is not, orbit until it is.

   WHAT IT READS FROM MEASURE. Points and edges come from app-measure.js - its
   snap, its edge chain, its anchors - through window.NSO_MeasureBridge, and the
   ruler's Align point / Align edge modes are two more entries in the Measure
   mode select. An anchor is a point in its piece's own space, so a pick follows
   the piece when it is moved and drops itself when the piece is re-baked.

   NOT A BAKE. Nothing here touches a mesh, a rawTris or a model. Everything is
   drawn on one transparent 2D canvas over the viewport; no scene object is made,
   so there is nothing for nsoHelpers to sweep and nothing for an export to carry.

   The geometry below is pure and free of THREE and the DOM, so
   tools/nso_measure_test.js can check it in Node. */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- core */

  var MM_PER_IN = 25.4;
  // 300 mm, and the 12 in it stands in for in inches (a real foot, 304.8 mm).
  // Written out: 12 * 25.4 is 304.79999999999995 in floating point.
  var LENGTH_MM = 300;
  var LENGTH_IN = 12;
  var LENGTH_IN_MM = 304.8;

  /* The tick ladder, in the DISPLAY unit, finest first. Each step is a whole
     multiple of the one before, which is what lets one tick be classified by
     the coarsest step it lands on. Inches go by halves (a rule, not a decimal
     scale); millimetres by 0.1 / 0.5 / 1 / 5 / 10. */
  var LEVELS = {
    mm: [0.1, 0.5, 1, 5, 10, 50, 100],
    'in': [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 5, 10]
  };
  var MIN_TICK_PX = 4.5;     // closer than this, a level is a smear: leave it out
  // A number needs this much room: tighter in mm (10, 20, 30...) than in inches,
  // where whole inches read as a rule and half-inch numbers read as clutter.
  var LABEL_MIN_PX = { mm: 28, 'in': 48 };
  var ALIGN_TILT_DEG = 0.5;  // "along the ruler": within half a degree
  var ALIGN_DEPTH = 0.005;   // "square to the view": ends within 0.5 % of each other

  function unitOf(u) { return u === 'in' ? 'in' : 'mm'; }
  function mmPerUnit(u) { return unitOf(u) === 'in' ? MM_PER_IN : 1; }
  function lengthMm(u) { return unitOf(u) === 'in' ? LENGTH_IN_MM : LENGTH_MM; }

  function isMultiple(v, step) {
    var r = v / step;
    return Math.abs(r - Math.round(r)) < 1e-6;
  }

  // Decimals a step needs to print exactly: 1 -> 0, 0.5 -> 1, 1/16 -> 4.
  function decimalsFor(step) {
    if (step >= 1) return 0;
    for (var d = 1; d <= 6; d++) {
      var x = step * Math.pow(10, d);
      if (Math.abs(x - Math.round(x)) < 1e-9) return d;
    }
    return 6;
  }

  /* Which levels are drawn at this scale, and which of them carries numbers.
     pxPerMm is the ruler's scale on screen. Always at least the coarsest level,
     so a ruler seen from very far away still has marks. */
  function tickPlan(unit, pxPerMm) {
    var u = unitOf(unit), lv = LEVELS[u], f = mmPerUnit(u);
    var steps = [], i;
    for (i = 0; i < lv.length; i++) if (lv[i] * f * pxPerMm >= MIN_TICK_PX) steps.push(lv[i]);
    if (!steps.length) steps.push(lv[lv.length - 1]);
    var labelStep = lv[lv.length - 1];
    for (i = 0; i < lv.length; i++) {
      if (lv[i] * f * pxPerMm >= LABEL_MIN_PX[u]) { labelStep = lv[i]; break; }
    }
    return { unit: u, steps: steps, labelStep: labelStep, mmPerUnit: f };
  }

  /* The marks to draw between two screen x's. x0 is where the ruler's zero is.
     Each is { x, v (display unit), rank (0 finest .. 1 coarsest drawn), label }.
     Clipped to the ruler's own length, and bounded: at 4.5 px a mark a screen
     holds a few hundred at most. */
  function ticks(unit, pxPerMm, x0, xMin, xMax) {
    var plan = tickPlan(unit, pxPerMm), f = plan.mmPerUnit;
    var ppu = pxPerMm * f;
    var finest = plan.steps[0];
    var vMax = lengthMm(plan.unit) / f;
    var lo = Math.max(0, (xMin - x0) / ppu), hi = Math.min(vMax, (xMax - x0) / ppu);
    var out = [];
    if (!(hi >= lo)) return out;
    var k0 = Math.ceil(lo / finest - 1e-9), k1 = Math.floor(hi / finest + 1e-9);
    if (k1 - k0 > 6000) k1 = k0 + 6000;
    var dec = decimalsFor(plan.labelStep), n = plan.steps.length;
    for (var k = k0; k <= k1; k++) {
      var v = Math.round(k * finest * 1e9) / 1e9;
      var j = 0;
      for (var s = n - 1; s >= 0; s--) { if (isMultiple(v, plan.steps[s])) { j = s; break; } }
      var lab = isMultiple(v, plan.labelStep);
      out.push({
        x: x0 + v * ppu, v: v,
        rank: n > 1 ? j / (n - 1) : 1,
        label: lab ? v.toFixed(dec) : null
      });
    }
    return out;
  }

  /* Pixels per mm for a thing `depth` mm in front of the camera, for a
     perspective camera of vertical field of view fovDeg on a canvas heightPx
     tall. Depth is measured along the view direction, not as a straight-line
     distance: every point on a plane square to the view shares one scale, and
     that is what makes a ruler on the glass a ruler. */
  function pxPerMmAtDepth(depth, fovDeg, heightPx) {
    return heightPx / (2 * depth * Math.tan(fovDeg * Math.PI / 360));
  }

  // Where along the ruler (mm from its zero) a screen x falls.
  function readingMm(pxPerMm, x0, x) { return (x - x0) / pxPerMm; }

  /* How an edge's two screen ends sit against the ruler.
       tiltDeg  - how far the edge is from lying along the ruler, + when it
                  climbs to the right, folded to (-90, 90] so an edge is the
                  same edge whichever end is called A
       spanMm   - its extent ALONG the ruler (what the marks give), not its length
       depth    - how far apart its two ends are in distance from the camera, as
                  a fraction of that distance: 0 = square to the view
     a and b are { x, y (screen, y down), depth }. */
  function edgeAlignment(a, b, pxPerMm) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var t = Math.atan2(-dy, dx) * 180 / Math.PI;
    if (t > 90) t -= 180; else if (t <= -90) t += 180;
    var mean = (a.depth + b.depth) / 2;
    var dd = mean > 0 ? Math.abs(a.depth - b.depth) / mean : 1;
    return {
      tiltDeg: t,
      spanMm: Math.abs(dx) / pxPerMm,
      depthFrac: dd,
      parallel: Math.abs(t) <= ALIGN_TILT_DEG,
      square: dd <= ALIGN_DEPTH
    };
  }

  var CORE = {
    MM_PER_IN: MM_PER_IN, LENGTH_MM: LENGTH_MM, LENGTH_IN: LENGTH_IN,
    LEVELS: LEVELS, MIN_TICK_PX: MIN_TICK_PX, LABEL_MIN_PX: LABEL_MIN_PX,
    ALIGN_TILT_DEG: ALIGN_TILT_DEG, ALIGN_DEPTH: ALIGN_DEPTH,
    lengthMm: lengthMm, tickPlan: tickPlan, ticks: ticks,
    pxPerMmAtDepth: pxPerMmAtDepth, readingMm: readingMm, edgeAlignment: edgeAlignment
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (typeof window !== 'undefined') window.NSO_Ruler = CORE;

  // Node only wants the maths. Everything below needs a page.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ------------------------------------------------------------ the tool */

  var COLOUR = '#a3e635';          // Measure's lime (app-measure.js MEASURE_COLOUR)
  var AMBER = '#fbbf24';           // "not there yet" - the plate ticks' colour, used here as a caution
  var INK = 'rgba(12, 18, 26, 0.86)';
  var SPINE_H = 18;                // the bar you grab
  var TICK_MAX = 14;               // the longest mark, px
  var LABEL_H = 14;                // room under the ticks for the numbers
  var KEY = 'nso.ruler.v1';
  var FONT = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';

  var host = null, cv = null, ctx = null, spine = null, tools = null, unitBtn = null, flipBtn = null;
  var on = false, flip = false, guides = false;
  var pos = { x: 144, y: null };   // clear of the left button column    // the spine's top-left, in the viewport's own pixels
  var pick = null, hover = null;   // { kind, a, b, segments, forked, trueMm, piece }
  var pxPerMm = 1.5, depth = 300, depthSource = 'plate';
  var autoAt = 0, autoDirty = true, autoDepth = null, autoSource = 'plate', autoUp = 0, up = null;
  var lastSig = '', raf = 0, live = null;
  var drag = null;

  function el(id) { return document.getElementById(id); }
  function bridge() { return window.NSO_MeasureBridge || null; }
  function unit() { var b = bridge(); return b ? b.unit() : 'mm'; }
  function fmt(mm) { var b = bridge(); return b ? b.fmt(mm) : mm.toFixed(3) + ' mm'; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function load() {
    try {
      var j = window.localStorage && JSON.parse(localStorage.getItem(KEY) || 'null');
      if (j && typeof j === 'object') {
        if (typeof j.x === 'number') pos.x = j.x;
        if (typeof j.y === 'number') pos.y = j.y;
        flip = !!j.flip;
        guides = !!j.guides;
      }
    } catch (e) { /* a clean start is fine */ }
  }
  function save() {
    try { if (window.localStorage) localStorage.setItem(KEY, JSON.stringify({ x: pos.x, y: pos.y, flip: flip, guides: guides })); }
    catch (e) { /* not remembered */ }
  }

  /* ---- the DOM: one canvas that draws, one bar that takes the pointer ---- */

  function build() {
    if (cv && cv.isConnected) return true;
    host = document.querySelector('.viewport-section');
    if (!host) return false;
    cv = document.createElement('canvas');
    cv.id = 'nso-ruler-canvas';
    cv.className = 'nso-ruler-canvas';
    cv.hidden = true;
    ctx = cv.getContext('2d');
    host.appendChild(cv);

    spine = document.createElement('div');
    spine.id = 'nso-ruler-spine';
    spine.className = 'nso-ruler-spine';
    spine.hidden = true;
    spine.title = 'Drag to move the ruler anywhere in the viewport. It stays level. The rest of the ruler is click-through: orbit and pan the piece under it.';
    host.appendChild(spine);

    tools = document.createElement('div');
    tools.id = 'nso-ruler-tools';
    tools.className = 'nso-ruler-tools';
    tools.hidden = true;
    unitBtn = document.createElement('button');
    unitBtn.type = 'button';
    unitBtn.className = 'nso-ruler-btn';
    unitBtn.id = 'nso-ruler-unit';
    unitBtn.title = 'Switch between millimetres and inches';
    flipBtn = document.createElement('button');
    flipBtn.type = 'button';
    flipBtn.className = 'nso-ruler-btn';
    flipBtn.id = 'nso-ruler-flip';
    flipBtn.textContent = '⇅';
    flipBtn.title = 'Flip the marks to the other side of the bar, so they face the piece';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nso-ruler-btn';
    closeBtn.id = 'nso-ruler-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Hide the ruler';
    tools.appendChild(unitBtn);
    tools.appendChild(flipBtn);
    tools.appendChild(closeBtn);
    host.appendChild(tools);

    unitBtn.addEventListener('click', function () {
      var b = bridge(); if (b) b.setUnit(b.unit() === 'in' ? 'mm' : 'in');
    });
    flipBtn.addEventListener('click', function () {
      flip = !flip; clampPos(); save(); kick();
    });
    closeBtn.addEventListener('click', function () {
      var c = el('chk-ruler'); if (c && c.checked) c.click(); else show(false);
    });

    spine.addEventListener('pointerdown', onSpineDown);
    spine.addEventListener('pointermove', onSpineMove);
    spine.addEventListener('pointerup', onSpineUp);
    spine.addEventListener('pointercancel', onSpineUp);
    window.addEventListener('resize', kick);
    return true;
  }

  /* ---- placement ---- */

  // The band the ruler occupies: from `up` above the spine's top to `down`
  // below its bottom. Flipped, the marks hang upward.
  function bandUp() { return flip ? TICK_MAX + LABEL_H : 0; }
  function bandDown() { return flip ? 0 : TICK_MAX + LABEL_H; }

  function clampPos() {
    if (!host) return;
    var W = host.clientWidth, H = host.clientHeight;
    if (pos.y == null) pos.y = Math.round(H * 0.72);
    var Lpx = CORE.lengthMm(unit()) * pxPerMm;
    // Anywhere in the viewport - and far enough in that some of the bar, and so
    // somewhere to grab it, is always on screen, even a bar wider than the view.
    var keep = 64;
    pos.x = clamp(pos.x, -(Lpx - keep), W - keep);
    pos.y = clamp(pos.y, bandUp(), H - SPINE_H - bandDown());
  }

  function applyDom() {
    var Lpx = CORE.lengthMm(unit()) * pxPerMm;
    spine.style.left = Math.round(pos.x) + 'px';
    spine.style.top = Math.round(pos.y) + 'px';
    spine.style.width = Math.round(Math.min(Lpx, 20000)) + 'px';
    spine.style.height = SPINE_H + 'px';
    var tl = clamp(pos.x + 4, 4, Math.max(4, host.clientWidth - 92));
    tools.style.left = Math.round(tl) + 'px';
    tools.style.top = Math.round(pos.y + 2) + 'px';
    unitBtn.textContent = unit();
  }

  /* ---- dragging: both axes, and the ruler never turns ---- */

  function onSpineDown(e) {
    if (e.button != null && e.button !== 0) return;
    var h = host.getBoundingClientRect();
    drag = { ox: e.clientX - h.left - pos.x, oy: e.clientY - h.top - pos.y };
    try { spine.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    spine.classList.add('is-dragging');
    e.preventDefault();
    e.stopPropagation();
  }
  function onSpineMove(e) {
    if (!drag) return;
    var h = host.getBoundingClientRect();
    pos.x = e.clientX - h.left - drag.ox;
    pos.y = e.clientY - h.top - drag.oy;
    clampPos();
    kick();
  }
  function onSpineUp(e) {
    if (!drag) return;
    drag = null;
    spine.classList.remove('is-dragging');
    try { spine.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    save();
    kick();                  // settle the scale on what it ended up over
  }

  /* ---- reading the camera ---- */

  var V = null;

  function viewDepth(w) {
    var c = state.camera;
    if (!V) V = { fwd: new THREE.Vector3(), d: new THREE.Vector3() };
    c.getWorldDirection(V.fwd);
    return V.d.copy(w).sub(c.position).dot(V.fwd);
  }

  // World point -> the viewport's own pixels, and how far in front of the camera.
  function toHost(w, rects) {
    var p = w.clone().project(state.camera);
    return {
      x: (p.x * 0.5 + 0.5) * rects.r.width + (rects.r.left - rects.h.left),
      y: (-p.y * 0.5 + 0.5) * rects.r.height + (rects.r.top - rects.h.top),
      depth: viewDepth(w),
      behind: p.z > 1
    };
  }

  /* The distance the ruler is true at when nothing is picked: the nearest
     surface under the part of the ruler that is on screen.

     WHAT COUNTS AS A SURFACE. A placed piece, and also a ghost: the live preview
     a generator card shows (Custom shape, Fittings, Fasteners), Crop's box, a
     lifted ghost. Those are scene objects, deliberately not in state.modelGroup,
     so the first cut of this asked only the pieces and, with a 30 mm solid being
     previewed, answered "the plate" - and then read a 160 mm part as 176 mm,
     because its top is 30 mm nearer the camera than the plate it stands on. The
     plate itself, its grid and ticks, and Measure's own marks are left out.

     WHERE. Several rays along the visible stretch of the ruler, not one: a ruler
     wider than the view has no useful "middle" off the screen (the first cut
     clamped it to the right-hand edge). The nearest hit wins - the face you are
     laying the ruler beside is the one that is nearest the camera.

     A ray costs a walk of a piece's tree, so at most one set every 100 ms while
     the view is moving; the frame after it settles takes the last one. */
  var SAMPLES = 16;               // columns along the visible ruler
  var ROWS = [0, 16, 34];         // px from the bar's centre, towards where the marks hang
  function isSurface(o) {
    for (var n = o; n; n = n.parent) {
      if (n === state.plateMesh || n === state.plateGrid || n === state.plateBorder) return false;
      if (n.userData && n.userData.nsoHelper === 'measure') return false;
    }
    return true;
  }
  function autoDepthNow(rects) {
    var dom = state.renderer.domElement;
    var W = host.clientWidth;
    var Lpx = CORE.lengthMm(unit()) * pxPerMm;
    var lo = Math.max(pos.x, 8), hi = Math.min(pos.x + Lpx, W - 8);
    if (!(hi > lo)) { lo = hi = clamp(pos.x, 8, W - 8); }
    var rc = state.raycaster;
    var targets = [state.modelGroup];
    state.scene.children.forEach(function (c) {
      if (c !== state.modelGroup && c.visible && (c.isMesh || c.isGroup) && isSurface(c)) targets.push(c);
    });
    var best = null;
    for (var q = 0; q < SAMPLES * ROWS.length; q++) {
      var k = q % SAMPLES, r = (q / SAMPLES) | 0;
      var x = SAMPLES > 1 ? lo + (hi - lo) * k / (SAMPLES - 1) : lo;
      var y = pos.y + SPINE_H / 2 + ROWS[r] * dirY();
      var nx = ((x - (rects.r.left - rects.h.left)) / rects.r.width) * 2 - 1;
      var ny = -(((y - (rects.r.top - rects.h.top)) / rects.r.height) * 2 - 1);
      rc.setFromCamera({ x: nx, y: ny }, state.camera);
      var hits = rc.intersectObjects(targets, true);
      for (var i = 0; i < hits.length; i++) {
        var o = hits[i].object;
        if (hits[i].faceIndex == null || !o.visible || !isSurface(o)) continue;
        if (o.material && o.material.opacity === 0) continue;
        if (window.nsoHelpers && window.nsoHelpers.isHelper && window.nsoHelpers.isHelper(o) &&
            !(window.nsoHelpers.ownerOf && /^(crop|bend|tube-edge)$/.test(window.nsoHelpers.ownerOf(o) || ''))) continue;
        var d = viewDepth(hits[i].point);
        if (d > 0 && (!best || d < best.depth)) best = { depth: d, up: hits[i].point.y, source: 'surface' };
        break;                                   // the nearest on this ray is the first
      }
    }
    if (best) return best;
    var pt = new THREE.Vector3();
    var cx = ((clamp((lo + hi) / 2, 0, W) - (rects.r.left - rects.h.left)) / rects.r.width) * 2 - 1;
    var cy = -(((pos.y + SPINE_H / 2 - (rects.r.top - rects.h.top)) / rects.r.height) * 2 - 1);
    rc.setFromCamera({ x: cx, y: cy }, state.camera);
    if (rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt)) {
      return { depth: viewDepth(pt), up: 0, source: 'plate' };
    }
    return { depth: viewDepth(state.controls.target), up: null, source: 'target' };
  }

  /* One pick, as it stands this frame: its ends on screen, or null if the piece
     it was on is gone (re-baked, removed, undone). */
  function evaluate(p, rects) {
    var b = bridge();
    if (!p || !b) return null;
    var wa = b.worldOf(p.a);
    var wb = p.b ? b.worldOf(p.b) : null;
    if (!wa || (p.b && !wb)) return null;
    var sa = toHost(wa, rects), sb = wb ? toHost(wb, rects) : null;
    if (sa.behind || (sb && sb.behind) || !(sa.depth > 0)) return { gone: false, hidden: true, p: p };
    return { gone: false, hidden: false, p: p, a: sa, b: sb,
             focus: sb ? (sa.depth + sb.depth) / 2 : sa.depth,
             up: sb ? (wa.y + wb.y) / 2 : wa.y };
  }

  /* ---- drawing ---- */

  function sizeCanvas() {
    var W = host.clientWidth, H = host.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(W * dpr), h = Math.round(H * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function text(str, x, y, colour, align) {
    ctx.font = FONT;
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(8, 12, 18, 0.85)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(str, x, y);
  }

  // A small dark pill with one or two lines, kept inside the viewport.
  function pill(lines, cx, cy, colours) {
    ctx.font = FONT;
    var w = 0, i;
    for (i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
    w += 12;
    var h = lines.length * 13 + 6;
    var x = clamp(cx - w / 2, 4, host.clientWidth - w - 4);
    var y = clamp(cy - h / 2, 4, host.clientHeight - h - 4);
    ctx.fillStyle = INK;
    ctx.strokeStyle = 'rgba(163, 230, 53, 0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 5); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (i = 0; i < lines.length; i++) {
      ctx.fillStyle = (colours && colours[i]) || '#ecfccb';
      ctx.fillText(lines[i], x + 6, y + 3 + 6.5 + i * 13);
    }
  }

  // The ruler's reference edge: the side the marks hang from.
  function baseY() { return flip ? pos.y : pos.y + SPINE_H; }
  function dirY() { return flip ? -1 : 1; }

  function drawRuler(W, H) {
    var u = unit(), Lpx = CORE.lengthMm(u) * pxPerMm;
    var x0 = pos.x, y0 = baseY(), dy = dirY();
    // Body: the bar, and a faint band behind the marks so they read on any piece.
    ctx.fillStyle = 'rgba(12, 18, 26, 0.34)';
    var bandTop = flip ? pos.y - TICK_MAX - LABEL_H : pos.y + SPINE_H;
    ctx.fillRect(x0, bandTop, Lpx, TICK_MAX + LABEL_H);
    ctx.fillStyle = INK;
    ctx.fillRect(x0, pos.y, Lpx, SPINE_H);
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, pos.y + 0.5, Lpx - 1, SPINE_H - 1);

    var ts = CORE.ticks(u, pxPerMm, x0, -2, W + 2), i, t;
    if (guides) {
      ctx.strokeStyle = 'rgba(163, 230, 53, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < ts.length; i++) {
        t = ts[i];
        if (t.label == null) continue;
        ctx.moveTo(Math.round(t.x) + 0.5, 0);
        ctx.lineTo(Math.round(t.x) + 0.5, H);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i < ts.length; i++) {
      t = ts[i];
      var len = t.label != null ? TICK_MAX : 3 + (TICK_MAX - 6) * t.rank;
      var x = Math.round(t.x) + 0.5;
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + dy * len);
    }
    ctx.stroke();
    for (i = 0; i < ts.length; i++) {
      t = ts[i];
      if (t.label == null) continue;
      text(t.label, Math.round(t.x), y0 + dy * (TICK_MAX + LABEL_H / 2), '#ecfccb');
    }
    // Which distance this is true at - the one thing a perspective ruler owes you.
    /* Say HOW HIGH the scale is true at. "At the plate" and "30 mm up" are
       different rulers, and a part 30 mm tall reads 10 % long on the first. */
    var hi = up == null ? '' : (Math.abs(up) < 0.05 ? '' : ' \u00B7 ' + (unit() === 'in' ? (up / 25.4).toFixed(2) + ' in' : up.toFixed(1) + ' mm') + ' up');
    var cap = depthSource === 'pick' ? 'true at the pick' + hi
            : depthSource === 'surface' ? 'true at the surface under it' + hi
            : depthSource === 'plate' ? 'true at the plate (0 up)' : 'true at the orbit centre';
    var capX = clamp(x0 + Lpx, 0, W) - 6;
    if (capX - 230 > x0 + 90) text(cap, capX, pos.y + SPINE_H / 2, 'rgba(236, 252, 203, 0.7)', 'right');
  }

  // Everything one pick draws. `strong` = a click; hover is the same, dimmer.
  function drawPick(ev, strong) {
    if (!ev || ev.hidden) return null;
    var p = ev.p, a = ev.a, b = ev.b;
    var y0 = baseY();
    var al = strong ? 1 : 0.55;
    var col = strong ? COLOUR : 'rgba(163, 230, 53, 0.65)';
    var ra = CORE.readingMm(pxPerMm, pos.x, a.x);
    var out = { aMm: ra };
    var L = CORE.lengthMm(unit());
    function plumb(s) {
      ctx.strokeStyle = col;
      ctx.lineWidth = strong ? 1.25 : 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x, y0);
      ctx.stroke();
      ctx.setLineDash([]);
      // the tick it lands on, on the ruler
      var r = CORE.readingMm(pxPerMm, pos.x, s.x);
      ctx.fillStyle = (r < 0 || r > L) ? AMBER : col;
      ctx.beginPath();
      ctx.moveTo(s.x, y0);
      ctx.lineTo(s.x - 4, y0 + dirY() * 7);
      ctx.lineTo(s.x + 4, y0 + dirY() * 7);
      ctx.closePath();
      ctx.fill();
    }
    function ring(s) {
      ctx.strokeStyle = col;
      ctx.lineWidth = strong ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = al;
    if (!strong) {
      /* A hover shows WHAT would be picked and nothing to read. Until a pick
         sets it, the ruler is true at the surface under it, and the thing
         under the pointer may be a different distance from the camera (the top
         of a 20 mm piece is 6 % nearer than the plate it stands on) - so a
         number here would be wrong by that much. The number is for a pick. */
      if (b) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ring(b);
      }
      ring(a);
      ctx.globalAlpha = 1;
      return null;
    }
    if (p.kind === 'point' || !b) {
      plumb(a); ring(a);
      ctx.globalAlpha = 1;
      pill([fmt(ra)], a.x + 8 + 30, (a.y + y0) / 2, null);
      return out;
    }
    var rb = CORE.readingMm(pxPerMm, pos.x, b.x);
    var al2 = CORE.edgeAlignment(a, b, pxPerMm);
    out.bMm = rb; out.align = al2;
    // the edge itself, then a plumb from each end, then its shadow on the ruler
    ctx.strokeStyle = col;
    ctx.lineWidth = strong ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    plumb(a); plumb(b); ring(a); ring(b);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(Math.min(a.x, b.x), y0 + dirY() * 2);
    ctx.lineTo(Math.max(a.x, b.x), y0 + dirY() * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    var lo = Math.min(ra, rb), hi = Math.max(ra, rb);
    pill([fmt(lo) + ' → ' + fmt(hi), 'span ' + fmt(hi - lo)],
         (a.x + b.x) / 2, y0 + dirY() * (TICK_MAX + LABEL_H + 22), null);
    var tilt = (al2.tiltDeg >= 0 ? '+' : '') + al2.tiltDeg.toFixed(2) + '°';
    pill(['tilt ' + tilt + (al2.parallel ? ' ✓' : ''),
          'depth Δ ' + (al2.depthFrac * 100).toFixed(2) + ' %' + (al2.square ? ' ✓' : '')],
         (a.x + b.x) / 2, (a.y + b.y) / 2 - 24,
         [al2.parallel ? COLOUR : AMBER, al2.square ? COLOUR : AMBER]);
    return out;
  }

  /* One frame: work out the scale, draw, publish what was drawn. */
  function frame() {
    if (!on || !host || !state.camera || !state.renderer) return;
    var dom = state.renderer.domElement;
    var rects = { r: dom.getBoundingClientRect(), h: host.getBoundingClientRect() };
    if (!rects.r.width || !rects.r.height) return;

    var evPick = pick ? evaluate(pick, rects) : null;
    if (pick && !evPick) {
      // Its piece was re-baked, removed or undone away: the pick means nothing.
      pick = null;
      if (typeof setStatus === 'function') setStatus('Ruler pick cleared - the piece it was on changed');
      syncZero();
    }
    var evHover = hover ? evaluate(hover, rects) : null;
    if (hover && !evHover) hover = null;

    // The scale: the pick's distance if there is one, else the surface below.
    var now = Date.now();
    if (evPick && !evPick.hidden) {
      depth = evPick.focus; depthSource = 'pick'; up = evPick.up;
      autoDirty = false;       // no ray needed while a pick sets the scale
    } else {
      /* Not while the bar is in hand: sliding the ruler on or off a piece would
         re-scale it under the pointer by the piece's height over the camera
         distance (6 % for a 20 mm piece). It settles when you let go. */
      if (autoDirty && !drag && now - autoAt >= 100) {
        var d = autoDepthNow(rects);
        autoDepth = d.depth; autoSource = d.source; autoUp = d.up; autoAt = now; autoDirty = false;
      }
      if (autoDepth == null) { depth = viewDepth(state.controls.target); depthSource = 'target'; up = null; }
      else { depth = autoDepth; depthSource = autoSource; up = autoUp; }
    }
    if (!(depth > 0)) return;
    pxPerMm = CORE.pxPerMmAtDepth(depth, state.camera.fov, rects.r.height);

    clampPos();
    applyDom();
    sizeCanvas();
    var W = host.clientWidth, H = host.clientHeight;
    ctx.clearRect(0, 0, W, H);
    drawRuler(W, H);
    var rp = null;
    if (evHover) drawPick(evHover, false);
    if (evPick) rp = drawPick(evPick, true);

    live = {
      on: true, unit: unit(), lengthMm: CORE.lengthMm(unit()), x0: pos.x, y: pos.y, flip: flip, guides: guides,
      pxPerMm: pxPerMm, depth: depth, depthSource: depthSource, up: up,
      hover: hover ? hover.kind : null,
      pick: evPick && !evPick.hidden && rp ? {
        kind: pick.kind, aMm: rp.aMm, bMm: rp.bMm == null ? null : rp.bMm,
        trueMm: pick.trueMm, segments: pick.segments,
        tiltDeg: rp.align ? rp.align.tiltDeg : null,
        spanMm: rp.align ? rp.align.spanMm : null,
        depthFrac: rp.align ? rp.align.depthFrac : null,
        parallel: rp.align ? rp.align.parallel : null,
        square: rp.align ? rp.align.square : null,
        screen: { a: [evPick.a.x, evPick.a.y], b: evPick.b ? [evPick.b.x, evPick.b.y] : null }
      } : null
    };
  }

  /* The loop runs only while the ruler is up, and draws only when something it
     depends on moved: the camera, the ruler, a piece under a pick, the view's
     size. Anything that can move a pick's piece (a drag, a nudge, an undo)
     changes a world point, and the point is in the signature. */
  function signature() {
    var c = state.camera;
    if (!c) return '';
    c.updateMatrixWorld();
    var e = c.matrixWorld.elements, s = e[12] + ',' + e[13] + ',' + e[14] + ',' + e[0] + ',' + e[1] + ',' + e[2] +
      ',' + e[4] + ',' + e[5] + ',' + e[6] + ',' + c.fov + ',' + c.aspect +
      '|' + host.clientWidth + 'x' + host.clientHeight +
      '|' + pos.x + ',' + pos.y + ',' + unit() + ',' + flip + ',' + guides;
    var b = bridge();
    [pick, hover].forEach(function (p) {
      s += '|';
      if (!p || !b) return;
      var wa = b.worldOf(p.a), wb = p.b ? b.worldOf(p.b) : null;
      s += (wa ? wa.x + ',' + wa.y + ',' + wa.z : 'x') + (wb ? ';' + wb.x + ',' + wb.y + ',' + wb.z : '');
    });
    return s;
  }

  function loop() {
    raf = 0;
    if (!on) return;
    var sig = signature();
    var due = autoDirty && !drag && Date.now() - autoAt >= 100;
    if (sig !== lastSig || due) {
      if (sig !== lastSig) autoDirty = true;
      lastSig = sig;
      frame();
    }
    raf = requestAnimationFrame(loop);
  }

  // Ask for a redraw now (a state change the signature already covers, made certain).
  function kick() {
    lastSig = '';
    autoDirty = true;
    if (on && !raf) raf = requestAnimationFrame(loop);
  }

  /* ---- show / hide, picks ---- */

  function show(v) {
    v = !!v;
    if (!build()) return;
    if (v === on) return;
    on = v;
    cv.hidden = spine.hidden = tools.hidden = !on;
    var cb = el('chk-ruler');
    if (cb && cb.checked !== on) cb.checked = on;
    if (on) {
      load2();
      kick();
    } else {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      pick = hover = null;
      live = null;
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
    }
    syncZero();
  }
  var loaded = false;
  function load2() { if (!loaded) { loaded = true; load(); } }

  function setGuides(v) { guides = !!v; save(); kick(); }

  function syncZero() {
    var z = el('btn-ruler-zero');
    if (z) z.disabled = !(on && pick);
  }

  /* Slide the ruler along so its zero mark sits on the pick - the nearer end of
     an edge. After this the marks read straight off the point: "how far from
     here". The height is left alone; the ruler stays level where it was. */
  function zeroHere() {
    if (!on || !pick || !live || !live.pick) return false;
    var s = live.pick.screen;
    var x = s.b ? Math.min(s.a[0], s.b[0]) : s.a[0];
    pos.x = x;
    clampPos();
    save();
    kick();
    if (typeof setStatus === 'function') setStatus('Ruler zeroed on the ' + (pick.kind === 'edge' ? "edge's left end" : 'point'));
    return true;
  }

  window.NSO_RulerUI = {
    show: show,
    setPick: function (p) {
      pick = p; hover = null;
      if (p && !on) show(true);
      kick();
      syncZero();
      // Say what was picked, once; the live numbers ride on the ruler itself.
      if (p && typeof setStatus === 'function') {
        setStatus((p.kind === 'edge' ? 'Align edge' : 'Align point') + ' on ' + (p.piece || 'the piece') +
          '. The ruler is now true at the ' + (p.kind === 'edge' ? "edge's middle" : 'point') +
          ' - orbit or pan the piece until it sits on a mark.' +
          (p.kind === 'edge' ? ' Edge is ' + fmt(p.trueMm) + ' long.' : ''));
      }
    },
    clearPick: function () { if (pick) { pick = null; kick(); syncZero(); } },
    setHover: function (p) { if (p || hover) { hover = p; kick(); } }
  };

  // What the ruler is showing, as data - for the test suite.
  window.nsoRulerReadout = function () {
    if (!on) return null;
    autoDirty = true; autoAt = 0;      // a test wants the scale as it is NOW, not 100 ms ago
    frame();
    return live;
  };
  window.nsoRulerPlace = function (x, y) {
    if (x != null) pos.x = x;
    if (y != null) pos.y = y;
    clampPos(); save(); kick();
    return { x: pos.x, y: pos.y };
  };

  function bind() {
    var cb = el('chk-ruler');
    if (cb && !cb._rulerBound) {
      cb.addEventListener('change', function () { show(cb.checked); });
      cb._rulerBound = true;
    }
    var g = el('chk-ruler-guides');
    if (g && !g._rulerBound) {
      load2();
      g.checked = guides;
      g.addEventListener('change', function () { setGuides(g.checked); });
      g._rulerBound = true;
    }
    var z = el('btn-ruler-zero');
    if (z && !z._rulerBound) {
      z.addEventListener('click', zeroHere);
      z._rulerBound = true;
    }
    var b = bridge();
    if (b && !bind._unit) { bind._unit = true; b.onUnit(function () { kick(); }); }
    syncZero();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
