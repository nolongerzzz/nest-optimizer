/* The Crop card: pick a shape, drag it to size, press CROP.

   Crop is one operation - copy what a shape holds out of the selected piece as
   a new, sealed, solid piece (nso_crop.js, docs/CROP.md). This file is the
   card for it and nothing else: a Shape row, one readout line, CROP, Cancel.
   There is no field to type a size into. The shape is placed and sized by
   dragging.

   THE SHAPE. Picking Box, Cylinder or Sphere puts it centred on the selected
   piece at half the piece's size, translucent, with grab handles. Outline waits for a
   click on a piece (its footprint seen from above) or a Shift-click on a
   triangle (the rim loop that triangle borders), then shows the footprint band
   and its handles. Orbit between grabs: a press that lands on no handle and
   no shape is the orbit's.

   THE HANDLES, in Rotate's rails look (app-rotate-handles.js): a thin rail
   through each handle along the way it drags, a slim dart pointing out of each
   end of it, drawn over everything, and no gizmo arrows. Each is kept a fixed
   size on screen, and is found by its place on screen, not by a ray: the grab
   is HIT_PX pixels round the handle wherever the camera is.

     box        a handle on each face. It drags along the face's normal and the
                opposite face stays where it is.
     cylinder   an end handle on each end, a side handle on the rim. The ends
                slide along the axis; the side sets the diameter. An end pulled
                round past 45 degrees of the axis turns the axis to follow it:
                the axis is whichever of x, y, z the handle last pointed along.
     sphere     one handle on the surface: it sets the diameter.
     outline    d1 (outer) and d2 (inner) offsets, dragged along the surface
                normal at the outline's boundary, and the two heights z1 and z2.
     wall       click a flat wall of the piece: a straight line appears along it, on
                the wall's own outline (so a bump standing on the wall is inside it).
                Its one handle drags the line out of the wall or into it, along the
                wall's normal; a click on the piece sets the line through the point
                clicked (look at the bump from the side, click behind it); a Shift-click
                picks another wall. CROP copies what stands outside the line - with
                the line flush on the wall that is the bump and nothing else - and the
                original is untouched (Subtract the copy from it for a clean wall).
                A click on a BUMP - a small patch of the surface, a pin's end, a dome - draws the LOOPS of edges round it instead (a
                pin: its end rim, then its foot) and picks the outermost, where it meets what it stands on: the bendable line. Click
                another drawn loop, or any crease edge, to switch. CROP copies what is inside the loop, exactly as it is, and
                closes the underside with Lift's fill, which continues the surface's curve across the loop, so Subtracting the copy
                leaves the piece with a clean surface where the bump was.
     lasso      no handles: drag a loop round what to copy, on the screen. The
                loop is a cone of rays from the camera it was drawn in, so what
                it copies is what it sees, front to back; the cone stays where it
                was drawn when the view is orbited. Draw again to replace it.
                Alt-drag orbits (a plain press draws).
     all        the body itself slides the shape: across the plate by default,
                straight up and down with Shift held.

   THE READOUT follows live from NSO_Crop.planOn: "Box 40 x 22 x 15 mm - holds
   698 faces, 1.2 cm3", or the refusal in words. CROP is NSO_Crop.copy as the
   engine does it: one Undo, the original untouched, the copy lands in place
   and is selected. The shape stays, on the piece it was picked on, for another
   crop. Escape or Cancel puts it away; so does closing the card.

   FRAMES. The shape is kept in the plate frame P - z up, the way the engine
   takes it - and drawn in world space, world = (Px, Pz, -Py). A yaw about P's
   z is a rotation about world Y by the same angle.

   LENT. The Foam GUN (app-foam.js, docs/FOAM.md section 11) borrows the Box: lend() puts
   a fresh Box on the selected piece with the same handles, whether or not this card is
   open, and release() gives back whatever shape the card had. While lent the card plans
   nothing, the body does not slide (a press inside the box is the gun's), and Escape and
   the selection are the borrower's. The borrower is told when the box moves (onChange)
   and when the card takes the shape back (taken).

   PAINT SCOPE: none. Nothing is written to the original. */
(function () {
  'use strict';

  var HIT_PX = 14;             // a handle is grabbed this close to it on screen (never under 12)
  var DRAW_PX = 38;            // and drawn this big
  var MIN_MM = 0.1;            // no half-size, radius or height gap below this
  var SHAPES = ['box', 'cylinder', 'sphere', 'outline', 'wall', 'lasso'];
  var NAMES = { box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', outline: 'Outline', wall: 'Wall', lasso: 'Lasso' };
  var LASSO_MIN_PX = 3;        // a loop point is kept when it is this far from the last one
  var LASSO_MIN_AREA = 80;     // a loop smaller than this (px squared) is a click, not a lasso
  var LASSO_MAX_PTS = 240;     // the loop is simplified until it has at most this many corners
  var COL = { body: 0xef4444, edge: 0xb91c1c, rail: 0xfbbf24, dart: 0xfde68a, held: 0xffffff };
  var PLAN_MS = 90;
  var PLAN_BIG_MS = 400;       // a big piece's plan is a worker job of seconds: ask when the drag has settled, not at every pause

  var S = {
    shape: null,               // 'box' | 'cylinder' | 'sphere' | 'outline' | 'wall' | 'lasso' | null
    forId: null,               // the model it was picked on
    box: null, cyl: null, sph: null,
    wall: { kind: 'plane', face: null, tri: -1, off: 0, loop: null },   // the wall picked (NSO_Crop.wallFace) and the line's distance out from it - or, kind 'loop', the loops round a bump (NSO_Crop.bumpLoops)
    lasso: { eye: null, dirs: null },   // the loop, as rays from the eye it was drawn in (P)
    draw: null,                // a loop being drawn: { pts: [[x, y] in px] }
    outline: { id: null, mode: 'silhouette', tri: -1, d1: 0, d2: 0, z1: 0, z2: 0, fp: null, src: null, key: '' },
    plan: null, planText: '', seq: 0, timer: null, busy: false,
    expectSel: null,           // the copy just made: its selection is not a retarget
    group: null, body: null, handles: [], drag: null, preview: null,
    lent: null,                // the borrower: { onChange(box), taken() }, while the Box is lent
    kept: null                 // the card's own shape, set aside while lent
  };

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function fmt(v) { return String(Math.round(v * 10) / 10); }

  // P (z up) <-> world (y up): world = (Px, Pz, -Py).
  function toWorld(p) { return new THREE.Vector3(p[0], p[2], -p[1]); }
  function toP(v) { return [v.x, -v.z, v.y]; }
  function yawVecP(yawDeg, x, y) {
    var a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [c * x - s * y, s * x + c * y];
  }

  /* ---- the piece and the card ------------------------------------------- */

  function live() { return !!(typeof state !== 'undefined' && state.cutterOpen && state.cutTool === 'crop'); }

  function targetModel() {
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (S.forId != null && S.shape && (!m || m.id !== S.forId)) {
      var keep = state.models.find(function (q) { return q && q.id === S.forId; });
      // the copy just made, selected for the user to grab, is not a new target
      if (keep && (S.copying || (S.expectSel != null && m && m.id === S.expectSel))) return keep;
    }
    return m && m.rawTris && m.rawAxis === 'zup' ? m : null;
  }
  function placedOf(id) {
    return (state.placed || []).find(function (p) { return p && p.sourceId === id && p.mesh; }) || null;
  }
  function modelOf(id) { return (state.models || []).find(function (q) { return q && q.id === id; }) || null; }

  /* The target's box in P, from the mesh as drawn. */
  function boundsP(mesh) {
    var b = new THREE.Box3().setFromObject(mesh);
    return { lo: [b.min.x, -b.max.z, b.min.y], hi: [b.max.x, -b.min.z, b.max.y] };
  }

  function target() {
    if (typeof state === 'undefined' || typeof THREE === 'undefined') return null;
    var m = targetModel();
    if (!m) return null;
    var p = placedOf(m.id);
    if (!p) return null;
    p.mesh.updateMatrixWorld(true);
    return { m: m, placed: p, mesh: p.mesh, bp: boundsP(p.mesh) };
  }

  /* ---- a fresh shape on a piece: centred, half its size ------------------ */

  function mid(bp, k) { return (bp.lo[k] + bp.hi[k]) / 2; }
  function size(bp, k) { return bp.hi[k] - bp.lo[k]; }

  function freshShape(kind, t) {
    var bp = t.bp, c = [mid(bp, 0), mid(bp, 1), mid(bp, 2)];
    var sx = size(bp, 0), sy = size(bp, 1), sz = size(bp, 2);
    if (kind === 'box') S.box = { c: c, h: [sx / 4, sy / 4, sz / 4], yaw: 0 };
    if (kind === 'cylinder') S.cyl = { c: c, r: Math.min(sx, sy) / 4, hl: sz / 4, axis: 'z', yaw: 0 };
    if (kind === 'sphere') S.sph = { c: c, r: Math.min(sx, sy, sz) / 4 };
    if (kind === 'lasso') S.lasso = { eye: null, dirs: null };
    if (kind === 'wall') S.wall = { kind: 'plane', face: null, tri: -1, off: 0, loop: null };
    if (kind === 'outline') S.outline = { id: null, mode: 'silhouette', tri: -1, d1: 0, d2: 0, z1: bp.lo[2], z2: bp.hi[2], fp: null, src: null, key: '' };
  }

  function engineShape() {
    if (S.shape === 'box') return { kind: 'box', c: S.box.c.slice(), h: S.box.h.slice(), yaw: S.box.yaw };
    if (S.shape === 'cylinder') return { kind: 'cylinder', c: S.cyl.c.slice(), r: S.cyl.r, hl: S.cyl.hl, axis: S.cyl.axis, yaw: S.cyl.yaw };
    if (S.shape === 'sphere') return { kind: 'sphere', c: S.sph.c.slice(), r: S.sph.r };
    if (S.shape === 'wall') {
      var wl = S.wall, wf = wl.face;
      if (wl.kind === 'loop') return wl.loop ? { kind: 'loop', tris: wl.loop.cands[wl.loop.pick].tris } : null;
      if (!wf) return null;
      var wt = target(), wr = wt ? wallReach(wt.bp, wf) : null;
      var ws = { kind: 'wall', o: wf.o.slice(), n: wf.n.slice(), u: wf.u.slice(), ring: wf.ring.map(function (q) { return q.slice(); }), off: wl.off };
      if (wr != null) ws.reach = wr;
      return ws;
    }
    if (S.shape === 'lasso') {
      var l = S.lasso;
      if (!l.dirs) return null;
      var ls = { kind: 'lasso', eye: l.eye.slice(), dirs: l.dirs.map(function (d) { return d.slice(); }) };
      var lt = target(), dp = lt ? lassoDepths(lt.bp, l) : null;
      if (dp) { ls.near = dp.near; ls.far = dp.far; }
      return ls;
    }
    if (S.shape === 'outline') {
      var o = S.outline;
      if (o.id == null) return null;
      return { kind: 'outline', pieceId: o.id, mode: o.mode, tri: o.mode === 'rim' ? o.tri : undefined,
               d1: o.d1, d2: o.d2, z1: o.z1, z2: o.z2 };
    }
    return null;
  }

  /* ---- the readout ------------------------------------------------------- */

  function describe() {
    var t = target();
    if (S.shape === 'box') return 'Box ' + fmt(2 * S.box.h[0]) + ' × ' + fmt(2 * S.box.h[1]) + ' × ' + fmt(2 * S.box.h[2]) + ' mm';
    if (S.shape === 'cylinder') return 'Cylinder Ø' + fmt(2 * S.cyl.r) + ' × ' + fmt(2 * S.cyl.hl) + ' mm along ' + S.cyl.axis.toUpperCase();
    if (S.shape === 'sphere') return 'Sphere Ø' + fmt(2 * S.sph.r) + ' mm';
    if (S.shape === 'wall') {
      var wd = S.wall;
      if (wd.kind === 'loop' && wd.loop) return 'Loop ' + fmt(wd.loop.cands[wd.loop.pick].perimeterMm) + ' mm round' + (wd.loop.cands.length > 1 ? ' (' + (wd.loop.pick + 1) + ' of ' + wd.loop.cands.length + ' drawn - click another to switch)' : '');
      return wd.face ? 'Wall ' + fmt(wd.face.size[0]) + ' × ' + fmt(wd.face.size[1]) + ' mm, line ' + (wd.off < 0 ? '−' : '+') + Math.abs(wd.off).toFixed(2) + ' mm'
                     : 'Wall, no wall picked yet';
    }
    if (S.shape === 'lasso') return 'Lasso, ' + (S.lasso.dirs ? S.lasso.dirs.length + '-point loop' : 'no loop yet');
    if (S.shape === 'outline') {
      var o = S.outline, om = o.id != null ? modelOf(o.id) : null;
      return 'Outline of ' + (om ? om.name : 'a piece') + (o.mode === 'rim' ? ' rim' : '') + ', +' + o.d1.toFixed(1) + ' / −' + o.d2.toFixed(1) +
        ' mm, z ' + o.z1.toFixed(1) + ' → ' + o.z2.toFixed(1) + ' mm';
    }
    return t ? '' : '';
  }

  function cm3(v) { var c = v / 1000; return (c >= 1 ? c.toFixed(1) : c.toFixed(2)) + ' cm³'; }

  function readoutText() {
    if (!live()) return '—';
    var busy = (typeof NSO_BoolBusy !== 'undefined') ? NSO_BoolBusy.line('crop-readout') : '';
    if (busy) return busy;               // "Cropping… 12 s" while the worker has it
    var t = target();
    if (!t) return 'Select a piece, then pick a shape.';
    if (!S.shape) return 'Pick a shape: it appears on ' + t.m.name + ', ready to drag.';
    if (S.shape === 'wall' && !S.wall.face && !S.wall.loop) return 'Wall: click a flat wall of the piece for a straight line along it, or a bump on it for the loop round its foot.';
    if (S.shape === 'lasso' && !S.lasso.dirs) return 'Lasso: drag a loop round what to copy (Alt-drag to orbit).';
    if (S.shape === 'outline' && S.outline.id == null) return 'Outline: click a piece for its footprint, or Shift-click a triangle for its rim.';
    var d = describe();
    if (!S.plan) return d + ' · …';
    if (S.plan.ok) return d + ' · holds ' + S.plan.faces + ' faces, ' + cm3(S.plan.volumeMm3) + (S.plan.merged ? ' · ' + S.plan.merged : '');
    return d + ' · ' + S.plan.reason;
  }

  function syncUI() {
    var ro = $('crop-readout');
    if (ro) {
      ro.textContent = readoutText();
      // red is for a refusal: the kernel said no, or a shape cannot be made of what was asked
      ro.classList.toggle('is-refusal', !!(live() && S.shape && S.plan && !S.plan.ok));
    }
    SHAPES.forEach(function (k) {
      var b = $('btn-crop-shape-' + k);
      if (!b) return;
      var on = S.shape === k;
      b.classList.toggle('tool-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.disabled = !live() || !target();
    });
    var cv = (typeof state !== 'undefined' && state && state.renderer) ? state.renderer.domElement : null;
    if (cv) cv.style.cursor = (live() && S.shape === 'lasso' && !S.lent) ? 'crosshair' : '';
    var go = $('btn-crop');
    if (go) go.disabled = !(live() && S.shape && S.plan && S.plan.ok && !S.busy);
    var cancel = $('btn-crop-cancel');
    if (cancel) cancel.disabled = !S.shape;
  }

  /* ---- the plan ---------------------------------------------------------- */

  function schedulePlan() {
    S.plan = null;
    if (S.lent) return;                              // a lent Box is planned by nobody: the borrower asks the engine
    syncUI();
    if (S.timer) clearTimeout(S.timer);
    var t = target(), big = t && t.m.rawTris && typeof NSO_BoolConfig !== 'undefined' &&
      t.m.rawTris.length / 9 >= NSO_BoolConfig.bigTris;
    S.timer = setTimeout(runPlan, big ? PLAN_BIG_MS : PLAN_MS);
  }

  async function runPlan() {
    S.timer = null;
    var t = target(), sh = engineShape();
    if (!live() || !S.shape || !t || !sh) { S.plan = null; syncUI(); return; }
    var seq = ++S.seq;
    var r;
    try { r = await NSO_Crop.planOn(t.m, sh); }
    catch (err) { r = { ok: false, reason: (err && err.message) || String(err) }; }
    if (seq !== S.seq) return;                     // the shape moved on while the kernel worked
    if (r.superseded) return;                      // a newer plan took its place and will land
    S.plan = r;
    syncUI();
    if (S.shape === 'outline' || S.shape === 'lasso' || (S.shape === 'wall' && S.wall.kind !== 'loop')) refreshPreview(seq);
  }

  /* The outline's band (or the lasso's cone), as the kernel cuts it: a closed soup in P, off the main
     path, redrawn when it lands. */
  async function refreshPreview(seq) {
    var o = S.outline, kind = S.shape, r;
    if (kind === 'lasso' || kind === 'wall') {
      var ls = engineShape();
      if (!ls) return;
      try { r = await NSO_Crop.cutterSoup(ls); } catch (err2) { r = { reason: String(err2) }; }
    } else {
      if (o.id == null || !o.src) return;
      try {
        r = await NSO_Crop.cutterSoup({ kind: 'outline', source: o.src, mode: o.mode, tri: o.mode === 'rim' ? o.tri : undefined,
                                        d1: o.d1, d2: o.d2, z1: o.z1, z2: o.z2 });
      } catch (err) { r = { reason: String(err) }; }
    }
    if (seq !== S.seq || S.shape !== kind) return;
    setPreview(r.soup || null);
    rebuild();
  }

  // The band's geometry is built once per kernel answer, not once per mouse move.
  function setPreview(soup) {
    if (S.previewGeo) { S.previewGeo.dispose(); S.previewGeo = null; }
    if (S.previewEdges) { S.previewEdges.dispose(); S.previewEdges = null; }
    S.preview = soup;
    if (!soup) return;
    var arr = new Float32Array(soup.length);
    for (var k = 0; k < soup.length; k += 3) { arr[k] = soup[k]; arr[k + 1] = soup[k + 2]; arr[k + 2] = -soup[k + 1]; }
    S.previewGeo = new THREE.BufferGeometry();
    S.previewGeo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    S.previewEdges = new THREE.EdgesGeometry(S.previewGeo, 20);
  }

  /* ---- the outline's footprint ------------------------------------------ */

  function matKey(mesh) {
    mesh.updateMatrixWorld(true);
    return mesh.geometry.uuid + '|' + mesh.matrixWorld.elements.map(function (v) { return v.toFixed(4); }).join(',');
  }

  async function loadFootprint() {
    var o = S.outline;
    if (o.id == null) return;
    var p = placedOf(o.id);
    if (!p) { o.fp = null; return; }
    o.src = NSO_Crop.meshSoupP(p.mesh);
    o.key = matKey(p.mesh);
    var want = o.id + '|' + o.mode + '|' + o.tri;
    var r = await NSO_Crop.footprintPolys({ kind: 'outline', source: o.src, mode: o.mode, tri: o.mode === 'rim' ? o.tri : undefined });
    if (S.shape !== 'outline' || want !== o.id + '|' + o.mode + '|' + o.tri) return;
    o.fp = r.polys ? r : null;
    rebuild();
    schedulePlan();
  }

  /* The boundary point with the largest (sign +1) or smallest (-1) x, and the
     outward normal of the footprint there. */
  function boundaryAt(fp, sign) {
    var best = null;
    fp.polys.forEach(function (ring) {
      for (var i = 0; i < ring.length; i++) {
        var p = ring[i];
        if (!best || sign * p[0] > sign * best.p[0]) best = { ring: ring, i: i, p: p };
      }
    });
    if (!best) return null;
    var ring = best.ring, n = ring.length, a = ring[(best.i + n - 1) % n], b = ring[(best.i + 1) % n], p = best.p;
    // F's outside is on the right of a boundary edge (outer loops run counter-clockwise, holes clockwise)
    function nrm(u, v) { var dx = v[0] - u[0], dy = v[1] - u[1], L = Math.hypot(dx, dy) || 1; return [dy / L, -dx / L]; }
    var n1 = nrm(a, p), n2 = nrm(p, b), nx = n1[0] + n2[0], ny = n1[1] + n2[1], L = Math.hypot(nx, ny);
    if (L < 1e-9) { nx = n2[0]; ny = n2[1]; L = Math.hypot(nx, ny) || 1; }
    return { p: p, n: [nx / L, ny / L] };
  }

  function fpCentre(fp) {
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    fp.polys.forEach(function (ring) {
      ring.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    });
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }

  /* ---- the handles: where they are, which way they drag ------------------ */

  /* Every handle: { id, pos (world), dir (world, unit) }. */
  function handlesOf() {
    var out = [], V = THREE.Vector3;
    function add(id, posP, dirP) {
      var d = toWorld(dirP); d.normalize();
      out.push({ id: id, pos: toWorld(posP), dir: d });
    }
    if (S.shape === 'box') {
      var b = S.box, ex = yawVecP(b.yaw, 1, 0), ey = yawVecP(b.yaw, 0, 1);
      var ax = [[ex[0], ex[1], 0], [ey[0], ey[1], 0], [0, 0, 1]];
      ['x', 'y', 'z'].forEach(function (nm, k) {
        [1, -1].forEach(function (sg) {
          add(nm + (sg > 0 ? '+' : '-'),
            [b.c[0] + sg * b.h[k] * ax[k][0], b.c[1] + sg * b.h[k] * ax[k][1], b.c[2] + sg * b.h[k] * ax[k][2]],
            [sg * ax[k][0], sg * ax[k][1], sg * ax[k][2]]);
        });
      });
    } else if (S.shape === 'cylinder') {
      var c = S.cyl, av = axisVecP(c), uv = radialVecP(c);
      add('end+', [c.c[0] + c.hl * av[0], c.c[1] + c.hl * av[1], c.c[2] + c.hl * av[2]], av);
      add('end-', [c.c[0] - c.hl * av[0], c.c[1] - c.hl * av[1], c.c[2] - c.hl * av[2]], [-av[0], -av[1], -av[2]]);
      add('side', [c.c[0] + c.r * uv[0], c.c[1] + c.r * uv[1], c.c[2] + c.r * uv[2]], uv);
    } else if (S.shape === 'sphere') {
      add('radius', [S.sph.c[0] + S.sph.r, S.sph.c[1], S.sph.c[2]], [1, 0, 0]);
    } else if (S.shape === 'wall' && S.wall.kind !== 'loop' && S.wall.face) {
      var wf = S.wall.face;
      // on the middle of the wall's top edge, so it is not in the way of a bump stood on the wall
      var topB = wf.ring.reduce(function (m, q) { return Math.max(m, q[1]); }, -Infinity);
      add('line', wallPoint(wf, wf.centre[0], topB, S.wall.off), wf.n);
    } else if (S.shape === 'outline' && S.outline.fp) {
      var o = S.outline, fp = o.fp, zm = (o.z1 + o.z2) / 2;
      var a = boundaryAt(fp, 1), bb = boundaryAt(fp, -1), cc = fpCentre(fp);
      if (a) add('d1', [a.p[0] + a.n[0] * o.d1, a.p[1] + a.n[1] * o.d1, zm], [a.n[0], a.n[1], 0]);
      if (bb) add('d2', [bb.p[0] - bb.n[0] * o.d2, bb.p[1] - bb.n[1] * o.d2, zm], [-bb.n[0], -bb.n[1], 0]);
      add('z1', [cc[0], cc[1], o.z1], [0, 0, 1]);
      add('z2', [cc[0], cc[1], o.z2], [0, 0, 1]);
    }
    return out;
  }

  // The cylinder's axis, and the direction its side handle sits in, in P (yaw applied).
  function axisVecP(c) {
    var l = c.axis === 'x' ? [1, 0] : c.axis === 'y' ? [0, 1] : [0, 0];
    var yv = yawVecP(c.yaw, l[0], l[1]);
    return c.axis === 'z' ? [0, 0, 1] : [yv[0], yv[1], 0];
  }
  function radialVecP(c) {
    var l = c.axis === 'x' ? [0, 1] : [1, 0];
    var yv = yawVecP(c.yaw, l[0], l[1]);
    return [yv[0], yv[1], 0];
  }

  /* ---- drawing ----------------------------------------------------------- */

  function removeGroup() {
    var g = S.group;
    if (g) {
      if (g.parent) g.parent.remove(g);
      g.traverse(function (o) {
        if (o.userData && o.userData.sharedGeo) return;
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    S.group = null; S.body = null; S.handles = [];
  }

  function bodyMat(op) {
    // drawn through the piece it stands in: a shape inside a piece would otherwise be hidden by it
    var m = new THREE.MeshBasicMaterial({ color: COL.body, transparent: true, opacity: op, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    return m;
  }

  function buildBody(g) {
    var m = null, holder = new THREE.Group();
    if (S.shape === 'box') {
      var b = S.box;
      holder.position.copy(toWorld(b.c)); holder.rotation.y = b.yaw * Math.PI / 180;
      m = new THREE.Mesh(new THREE.BoxGeometry(2 * b.h[0], 2 * b.h[2], 2 * b.h[1]), bodyMat(0.2));
    } else if (S.shape === 'cylinder') {
      var c = S.cyl;
      holder.position.copy(toWorld(c.c)); holder.rotation.y = c.yaw * Math.PI / 180;
      m = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, 2 * c.hl, Math.min(96, Math.max(32, NSO_Crop.circleSegments(c.r))), 1, false), bodyMat(0.2));
      if (c.axis === 'x') m.rotation.z = Math.PI / 2;
      if (c.axis === 'y') m.rotation.x = Math.PI / 2;
    } else if (S.shape === 'sphere') {
      holder.position.copy(toWorld(S.sph.c));
      m = new THREE.Mesh(new THREE.SphereGeometry(S.sph.r, 48, 24), bodyMat(0.2));
    }
    if (m) {
      m.userData.cropBody = true;
      holder.add(m);
      var edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.9, depthTest: false }));
      edges.renderOrder = 998;
      m.renderOrder = 997;
      edges.rotation.copy(m.rotation);
      holder.add(edges);
      g.add(holder);
      S.body = m;
      return;
    }
    if (S.shape === 'wall' && S.wall.kind === 'loop' && S.wall.loop) buildLoopDraw(g);
    else if (S.shape === 'wall' && S.wall.face) buildWallLine(g);
    if ((S.shape === 'outline' || S.shape === 'wall' || S.shape === 'lasso') && S.previewGeo) {
      var pm = new THREE.Mesh(S.previewGeo, bodyMat(0.2));
      pm.userData.sharedGeo = true;
      g.add(pm);
      var ed = new THREE.LineSegments(S.previewEdges, new THREE.LineBasicMaterial({ color: COL.edge, depthTest: false, transparent: true, opacity: 0.8 }));
      ed.userData.sharedGeo = true;
      ed.renderOrder = 10;
      g.add(ed);
    }
  }

  /* One handle: a thin rail through it along its drag, a slim dart off each
     end, unit-sized and scaled to a fixed size on screen (rescale). */
  function buildHandle(h, held) {
    var g = new THREE.Group();
    var col = held ? COL.held : COL.rail;
    var mat = function (c, o) { return new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: o }); };
    var rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6), mat(col, held ? 1 : 0.85));
    rail.renderOrder = 999;
    g.add(rail);
    [1, -1].forEach(function (sg) {
      var dart = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.9, 14), mat(held ? COL.held : COL.dart, 1));
      dart.position.y = sg * 0.85;
      if (sg < 0) dart.rotation.x = Math.PI;
      dart.renderOrder = 1000;
      g.add(dart);
    });
    var bead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), mat(held ? COL.held : COL.rail, 1));
    bead.renderOrder = 1001;
    g.add(bead);
    g.position.copy(h.pos);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.dir);
    g.userData.cropHandle = h.id;
    return g;
  }

  function rescale() {
    if (!S.group || !state.camera || !state.renderer) return;
    var cam = state.camera, rect = state.renderer.domElement.getBoundingClientRect();
    if (!rect.height) return;
    var perPx = 2 * Math.tan((cam.fov || 50) * Math.PI / 360) / rect.height;
    S.group.children.forEach(function (c) {
      if (!c.userData.cropHandle) return;
      var d = cam.position.distanceTo(c.position);
      c.scale.setScalar(Math.max(1e-4, d * perPx * DRAW_PX / 2));
    });
  }

  function rebuild() {
    removeGroup();
    if (!(live() || S.lent) || !S.shape || typeof THREE === 'undefined' || !state.scene) return;
    var t = target();
    if (!t) return;
    var g = new THREE.Group();
    g.name = S.lent ? 'foamGunBox' : 'cropCardShape';
    buildBody(g);
    S.handles = handlesOf();
    S.handles.forEach(function (h) { g.add(buildHandle(h, S.drag && S.drag.id === h.id)); });
    nsoHelpers.attach(state.scene, g, 'crop', { interactive: true });   // the body is raycast to slide the shape
    S.group = g;
    rescale();
    if (state.controls && !S.hooked) {
      S.hooked = true;
      state.controls.addEventListener('change', rescale);
    }
  }

  /* ---- where a handle is on screen --------------------------------------- */

  function screenOf(v) {
    var r = state.renderer.domElement.getBoundingClientRect();
    var p = v.clone().project(state.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, behind: p.z > 1 };
  }

  function handleScreen(id) {
    var h = S.handles.find(function (q) { return q.id === id; });
    return h ? screenOf(h.pos) : null;
  }

  function hitHandle(ev) {
    var best = null, bd = HIT_PX;
    S.handles.forEach(function (h) {
      var s = screenOf(h.pos);
      if (s.behind) return;
      var d = Math.hypot(s.x - ev.clientX, s.y - ev.clientY);
      if (d <= bd) { bd = d; best = h; }
    });
    return best;
  }

  /* ---- the wall ----------------------------------------------------------- */

  /* How far out along the wall's normal the piece reaches, from the wall's own plane: the cutter runs from the
     line to just past that. */
  function wallReach(bp, f) {
    var m = -Infinity;
    for (var k = 0; k < 8; k++) {
      var q = [(k & 1 ? bp.hi : bp.lo)[0] - f.o[0], (k & 2 ? bp.hi : bp.lo)[1] - f.o[1], (k & 4 ? bp.hi : bp.lo)[2] - f.o[2]];
      m = Math.max(m, q[0] * f.n[0] + q[1] * f.n[1] + q[2] * f.n[2]);
    }
    return m + 1 > 0.05 ? m + 1 : null;
  }

  // A point of the wall's plane, (a, b) across it, `off` mm out of it, in P.
  function wallPoint(f, a, b, off) {
    return [f.o[0] + f.u[0] * a + f.w[0] * b + f.n[0] * off, f.o[1] + f.u[1] * a + f.w[1] * b + f.n[1] * off,
            f.o[2] + f.u[2] * a + f.w[2] * b + f.n[2] * off];
  }

  /* The crop line: the wall's outline carried out to where the line is, drawn bright, with the plane it bounds
     faintly filled - from the side that plane is the line. */
  function buildWallLine(g) {
    var f = S.wall.face, off = S.wall.off;
    var pts = f.ring.map(function (q) { return toWorld(wallPoint(f, q[0], q[1], off)); });
    var lg = new THREE.BufferGeometry().setFromPoints(pts);
    var line = new THREE.LineLoop(lg, new THREE.LineBasicMaterial({ color: COL.rail, depthTest: false, transparent: true, opacity: 1 }));
    line.renderOrder = 999;
    g.add(line);
    var sh = new THREE.Shape(f.ring.map(function (q) { return new THREE.Vector2(q[0], q[1]); }));
    var plane = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial({ color: COL.rail, transparent: true, opacity: 0.14, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    var ux = toWorld(f.u), wx = toWorld(f.w), nx = toWorld(f.n);
    plane.matrixAutoUpdate = false;
    plane.matrix.makeBasis(ux, wx, nx).setPosition(toWorld(wallPoint(f, 0, 0, off)));
    plane.matrixWorldNeedsUpdate = true;
    plane.renderOrder = 996;
    g.add(plane);
  }

  /* The loops round a bump: every candidate loop's edges drawn (the picked one bright, the rest dim), and what is inside the
     picked one tinted. Drawn in the piece's own frame, from the mesh's own positions - the triangles the engine named. */
  function buildLoopDraw(g) {
    var l = S.wall.loop, t = target();
    if (!l || !t) return;
    var P = t.mesh.geometry.attributes.position.array;
    if (P.length !== t.m.rawTris.length) return;
    t.mesh.updateMatrixWorld(true);
    var holder = new THREE.Group();
    holder.matrixAutoUpdate = false; holder.matrix.copy(t.mesh.matrixWorld); holder.matrixWorldNeedsUpdate = true;
    var c = l.cands[l.pick], pos = new Float32Array(c.tris.length * 9);
    c.tris.forEach(function (tt, i) { for (var q = 0; q < 9; q++) pos[i * 9 + q] = P[tt * 9 + q]; });
    var tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var tint = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: COL.rail, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    tint.renderOrder = 996;
    holder.add(tint);
    l.cands.forEach(function (cd, i) {
      var seg = new Float32Array(cd.edges.length * 6);
      cd.edges.forEach(function (e, j) {
        var a = e.t * 9 + e.k * 3, b = e.t * 9 + ((e.k + 1) % 3) * 3;
        seg[j * 6] = P[a]; seg[j * 6 + 1] = P[a + 1]; seg[j * 6 + 2] = P[a + 2]; seg[j * 6 + 3] = P[b]; seg[j * 6 + 4] = P[b + 1]; seg[j * 6 + 5] = P[b + 2];
      });
      var lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(seg, 3));
      var ln = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: i === l.pick ? COL.rail : 0xffffff, transparent: true, opacity: i === l.pick ? 1 : 0.6, depthTest: false }));
      ln.renderOrder = i === l.pick ? 999 : 998;
      holder.add(ln);
    });
    g.add(holder);
  }

  var EDGE_PX = 8;                                           // a click this near a drawn edge is on it
  // Where the segment a-b (world) is on the screen, and how far the click is from it, in px.
  function screenSegDist(a, b, ev) {
    var A = screenOf(a), B = screenOf(b);
    if (A.behind || B.behind) return Infinity;
    var dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy, u = L2 > 0 ? Math.max(0, Math.min(1, ((ev.clientX - A.x) * dx + (ev.clientY - A.y) * dy) / L2)) : 0;
    return Math.hypot(A.x + u * dx - ev.clientX, A.y + u * dy - ev.clientY);
  }
  function edgeEnds(mesh, P, t, k) {
    var o = t * 9 + k * 3, o2 = t * 9 + ((k + 1) % 3) * 3;
    return [new THREE.Vector3(P[o], P[o + 1], P[o + 2]).applyMatrix4(mesh.matrixWorld), new THREE.Vector3(P[o2], P[o2 + 1], P[o2 + 2]).applyMatrix4(mesh.matrixWorld)];
  }

  // A flat wall picked: its straight line.
  function pickPlane(fc, tri) {
    S.wall = { kind: 'plane', face: fc, tri: tri, off: 0, loop: null };
    S.plan = null; setPreview(null);
    say('Crop: Wall - a ' + fmt(fc.size[0]) + ' × ' + fmt(fc.size[1]) + ' mm wall' + (fc.holes ? ', ' + fc.holes + ' thing' + (fc.holes > 1 ? 's' : '') + ' standing on it' : '') +
        '. Drag the handle, or click behind a bump from the side, to set the line');
    rebuild(); schedulePlan(); syncUI();
    return true;
  }

  /* A press on the piece in Wall.
       a loop is up    a press on one of its drawn edges picks that loop; anywhere else on the piece picks afresh
       a wall is up    a press sets the line through the point pressed (Shift picks afresh)
       picking         a big flat wall gets its straight line; a bump - a small patch, a pin's end, a dome - gets the loops of
                       edges round it, the outermost picked (its foot); a press within 8 px of a crease edge picks that edge's loop
     A press that is not on the piece is the orbit's. */
  function wallClick(ev) {
    var t = target();
    if (!t) return false;
    setRay(ev);
    var hit = state.raycaster.intersectObject(t.mesh, false).filter(function (h) { return h.faceIndex != null; })[0];
    if (!hit) return false;
    var w = S.wall, raw = t.m.rawTris, P = t.mesh.geometry.attributes.position.array, tri = hit.faceIndex, drawn = P.length === raw.length;
    if (w.kind === 'loop' && w.loop && drawn) {
      var best = -1, bd = EDGE_PX;
      w.loop.cands.forEach(function (cd, i) {
        cd.edges.forEach(function (e) { var ends = edgeEnds(t.mesh, P, e.t, e.k), d = screenSegDist(ends[0], ends[1], ev); if (d < bd) { bd = d; best = i; } });
      });
      if (best >= 0) {
        if (best !== w.loop.pick) {
          w.loop.pick = best; S.plan = null;
          say('Crop: Wall - loop ' + (best + 1) + ' of ' + w.loop.cands.length + ' (' + fmt(w.loop.cands[best].perimeterMm) + ' mm round)');
          rebuild(); schedulePlan(); syncUI();
        }
        return true;
      }
    }
    if (w.kind === 'plane' && w.face && !ev.shiftKey) {
      var q = toP(hit.point), f = w.face;
      var off = (q[0] - f.o[0]) * f.n[0] + (q[1] - f.o[1]) * f.n[1] + (q[2] - f.o[2]) * f.n[2];
      w.off = Math.round(off * 100) / 100;
      say('Crop: Wall - the line is ' + w.off.toFixed(2) + ' mm out from the wall, through the point clicked');
      rebuild(); schedulePlan(); syncUI();
      return true;
    }
    var fc = NSO_Crop.wallFace(NSO_Crop.meshSoupP(t.mesh), tri);
    if (fc.ring && fc.share >= 0.05) return pickPlane(fc, tri);                    // a real wall: its straight line
    var edge = null, ed = EDGE_PX;
    if (drawn) for (var k = 0; k < 3; k++) { var en = edgeEnds(t.mesh, P, tri, k), dd = screenSegDist(en[0], en[1], ev); if (dd < ed) { ed = dd; edge = { t: tri, k: k }; } }
    var B = drawn ? NSO_Crop.bumpLoops(raw, tri, edge ? { edge: edge } : {}) : { ok: false, reason: 'the drawn piece is not its triangles any more' };
    if (B.ok) {
      S.wall = { kind: 'loop', face: null, tri: tri, off: 0, loop: { cands: B.candidates, pick: B.pick } };
      S.plan = null; setPreview(null);
      var pk = B.candidates[B.pick];
      say('Crop: Wall - the loop round the bump, ' + fmt(pk.perimeterMm) + ' mm' + (B.candidates.length > 1 ? '; ' + B.candidates.length + ' loops are drawn - click another to switch' : '') +
          '. CROP copies what is inside it');
      rebuild(); schedulePlan(); syncUI();
      return true;
    }
    if (fc.ring) return pickPlane(fc, tri);                                         // a small flat face with no loop round it
    say('Crop: Wall - ' + (fc.curved ? 'that is a curved surface, not a flat wall - click a bump on it for the loop round its foot, or a flat face' : B.reason), true);
    return true;
  }

  /* ---- the lasso ---------------------------------------------------------- */

  /* A loop drawn on the screen is kept as the rays through its corners, from the
     camera it was drawn in, in P: a cone, which stays where it was drawn when the
     view is orbited. The engine cuts the cone off short of the piece and just past
     it (lassoDepths, from the piece as drawn). */

  function rayDirP(x, y) {
    var r = state.renderer.domElement.getBoundingClientRect();
    var v = new THREE.Vector3((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height * 2 - 1), 0.5).unproject(state.camera);
    return toP(v.sub(state.camera.position));
  }

  // Ramer-Douglas-Peucker on a polyline of px points.
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]];
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      var seg = stack.pop(), a = pts[seg[0]], b = pts[seg[1]], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      var worst = -1, wd = eps;
      for (var i = seg[0] + 1; i < seg[1]; i++) {
        var d = L > 1e-9 ? Math.abs(dy * (pts[i][0] - a[0]) - dx * (pts[i][1] - a[1])) / L : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst >= 0) { keep[worst] = 1; stack.push([seg[0], worst], [worst, seg[1]]); }
    }
    return pts.filter(function (_, i) { return keep[i]; });
  }

  function loopArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) { var p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
  }

  /* How deep the piece lies along the lasso's view: the cone runs from just short
     of its nearest corner to just past its farthest. null when it is all behind the eye. */
  function lassoDepths(bp, l) {
    var c = [0, 0, 0];
    l.dirs.forEach(function (d) { var n = Math.hypot(d[0], d[1], d[2]) || 1; c[0] += d[0] / n; c[1] += d[1] / n; c[2] += d[2] / n; });
    var cl = Math.hypot(c[0], c[1], c[2]);
    if (!(cl > 1e-9)) return null;
    var lo = Infinity, hi = -Infinity;
    for (var k = 0; k < 8; k++) {
      var q = [(k & 1 ? bp.hi : bp.lo)[0] - l.eye[0], (k & 2 ? bp.hi : bp.lo)[1] - l.eye[1], (k & 4 ? bp.hi : bp.lo)[2] - l.eye[2]];
      var dd = (q[0] * c[0] + q[1] * c[1] + q[2] * c[2]) / cl;
      lo = Math.min(lo, dd); hi = Math.max(hi, dd);
    }
    var near = Math.max(1, lo - 1), far = hi + 1;
    return far > near + 1e-3 ? { near: near, far: far } : null;
  }

  /* The loop (screen px) becomes the shape. */
  function setLasso(pts) {
    var eps = 1.5, pl = rdp(pts, eps);
    while (pl.length > LASSO_MAX_PTS) { eps *= 1.4; pl = rdp(pts, eps); }
    if (pl.length < 3 || loopArea(pl) < LASSO_MIN_AREA) return false;
    state.camera.updateMatrixWorld(true);
    S.lasso = { eye: toP(state.camera.position), dirs: pl.map(function (q) { return rayDirP(q[0], q[1]); }) };
    S.plan = null;
    rebuild();
    schedulePlan();
    return true;
  }

  // The loop under the pointer, drawn over the view while it is dragged.
  function overlay(pts) {
    var NS = 'http://www.w3.org/2000/svg', svg = S.svg;
    if (!pts) { if (svg && svg.parentNode) svg.parentNode.removeChild(svg); S.svg = null; return; }
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('id', 'crop-lasso-overlay');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:9000';
      var pg = document.createElementNS(NS, 'polygon');
      pg.setAttribute('fill', 'rgba(239,68,68,0.14)');
      pg.setAttribute('stroke', '#fbbf24');
      pg.setAttribute('stroke-width', '2');
      pg.setAttribute('stroke-dasharray', '6 4');
      pg.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(pg);
      document.body.appendChild(svg);
      S.svg = svg;
    }
    svg.firstChild.setAttribute('points', pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' '));
  }

  function startLasso(ev) {
    S.draw = { pts: [[ev.clientX, ev.clientY]] };
    if (state.controls) state.controls.enabled = false;
    overlay(S.draw.pts);
  }

  function moveLasso(ev) {
    var pts = S.draw.pts, last = pts[pts.length - 1];
    if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) < LASSO_MIN_PX) return;
    pts.push([ev.clientX, ev.clientY]);
    overlay(pts);
  }

  // Let go: the loop closes itself. A press that did not travel round anything keeps the old loop.
  function finishLasso(cancelled) {
    var d = S.draw;
    S.draw = null;
    overlay(null);
    if (state.controls) state.controls.enabled = true;
    if (!d || cancelled) return;
    if (setLasso(d.pts)) say('Crop: Lasso - ' + S.lasso.dirs.length + '-point loop; draw again to replace it, then CROP');
    else say('Crop: Lasso - drag a loop round what to copy');
    syncUI();
  }

  /* ---- the pointer ------------------------------------------------------- */

  function setRay(ev) {
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster.ray;
  }

  // Parameter t where the line p0 + t d (d unit) passes closest to the ray.
  function rayLineT(ray, p0, d) {
    var w = ray.origin.clone().sub(p0), r = ray.direction;
    var b = r.dot(d), dd = r.dot(w), e = d.dot(w), den = 1 - b * b;
    if (den < 1e-6) return null;
    return (e - b * dd) / den;
  }

  // The ray against the plane through `point` square to the view.
  function viewPlanePoint(ray, point) {
    var look = new THREE.Vector3();
    state.camera.getWorldDirection(look);
    var q = new THREE.Vector3();
    return ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(look, point), q) ? q : null;
  }

  function lineParam(ray, h) { return rayLineT(ray, h.pos, h.dir); }

  function clampMin(v) { return Math.max(MIN_MM, v); }

  function beginDrag(h, ev) {
    var ray = setRay(ev);
    var d = { id: h.id, kind: 'handle', h: h, t0: lineParam(ray, h), start: JSON.parse(JSON.stringify({ box: S.box, cyl: S.cyl, sph: S.sph, outline: { d1: S.outline.d1, d2: S.outline.d2, z1: S.outline.z1, z2: S.outline.z2 }, wall: { off: S.wall.off } })) };
    if (S.shape === 'cylinder' && (h.id === 'end+' || h.id === 'end-')) {
      d.s = h.id === 'end+' ? 1 : -1;
      d.free = false;
    }
    S.drag = d;
  }

  function beginBody(ev, hit) {
    var ray = setRay(ev);
    var src = S.shape === 'box' ? S.box : S.shape === 'cylinder' ? S.cyl : S.sph;
    S.drag = { id: 'body', kind: 'body', q: hit.point.clone(), c0: src.c.slice(), vertical: !!ev.shiftKey, ray0: ray.clone() };
  }

  function applyDrag(ev) {
    var d = S.drag;
    if (!d) return;
    var ray = setRay(ev), st = d.start, sh = S.shape;
    if (d.kind === 'body') {
      var src = sh === 'box' ? S.box : sh === 'cylinder' ? S.cyl : S.sph;
      if (d.vertical) {
        var t = rayLineT(ray, d.q, new THREE.Vector3(0, 1, 0)), t0 = rayLineT(d.ray0, d.q, new THREE.Vector3(0, 1, 0));
        if (t == null || t0 == null) return;
        src.c = [d.c0[0], d.c0[1], d.c0[2] + (t - t0)];
      } else {
        var q = new THREE.Vector3();
        if (!ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -d.q.y), q)) return;
        src.c = [d.c0[0] + (q.x - d.q.x), d.c0[1] - (q.z - d.q.z), d.c0[2]];
      }
      return;
    }
    var h = d.h, t1 = lineParam(ray, h);
    var delta = (t1 != null && d.t0 != null) ? t1 - d.t0 : null;
    if (sh === 'box') {
      if (delta == null) return;
      var k = h.id[0] === 'x' ? 0 : h.id[0] === 'y' ? 1 : 2, sg = h.id[1] === '+' ? 1 : -1;
      var h0 = st.box.h[k], hn = clampMin(h0 + delta / 2), shift = (hn - h0) * sg;
      var e = k === 0 ? yawVecP(st.box.yaw, 1, 0) : k === 1 ? yawVecP(st.box.yaw, 0, 1) : [0, 0];
      S.box.h[k] = hn;
      S.box.c = [st.box.c[0] + (k === 2 ? 0 : shift * e[0]), st.box.c[1] + (k === 2 ? 0 : shift * e[1]), st.box.c[2] + (k === 2 ? shift : 0)];
    } else if (sh === 'cylinder') {
      if (h.id === 'side') {
        if (delta != null) S.cyl.r = clampMin(st.cyl.r + delta);
      } else {
        dragCylinderEnd(ray, d, ev);
      }
    } else if (sh === 'sphere') {
      var cw = toWorld(st.sph.c), p = viewPlanePoint(ray, cw);
      if (p) S.sph.r = clampMin(p.distanceTo(cw));
    } else if (sh === 'wall') {
      if (delta == null) return;
      var wt2 = target(), lim = wt2 && S.wall.face ? wallReach(wt2.bp, S.wall.face) : null;
      var no = Math.round((st.wall.off + delta) * 100) / 100;
      S.wall.off = lim != null ? Math.max(-lim, Math.min(lim - 0.05, no)) : no;
    } else if (sh === 'outline') {
      if (delta == null) return;
      var o = S.outline;
      if (h.id === 'd1') o.d1 = Math.max(0, Math.round((st.outline.d1 + delta) * 20) / 20);
      if (h.id === 'd2') o.d2 = Math.max(0, Math.round((st.outline.d2 + delta) * 20) / 20);
      if (h.id === 'z1') o.z1 = Math.min(o.z2 - MIN_MM, st.outline.z1 + delta);
      if (h.id === 'z2') o.z2 = Math.max(o.z1 + MIN_MM, st.outline.z2 + delta);
    }
  }

  /* An end of the cylinder, pulled. Slide or turn is decided on the screen, by where the
     pointer is: while it stays within 45 degrees of the line the axis visibly lies along
     (seen from the centre), the end slides along the axis and the far end stays; pulled
     round past that, the axis turns to whichever of x, y, z the pointer now follows on
     the screen, and the cylinder is centred again. The length is always measured along
     the axis line itself (the ray's closest approach to it), so it does not matter how
     the camera looks at it. */
  function dragCylinderEnd(ray, d, ev) {
    var st = d.start.cyl, cw = toWorld(st.c), cs = screenOf(cw);
    var v = [ev.clientX - cs.x, ev.clientY - cs.y], vl = Math.hypot(v[0], v[1]);
    if (vl < 4) return;
    var sd = {};
    ['x', 'y', 'z'].forEach(function (k) {
      var dir = toWorld(axisVecP({ axis: k, yaw: st.yaw })), q = screenOf(cw.clone().add(dir));
      var sx = q.x - cs.x, sy = q.y - cs.y, L = Math.hypot(sx, sy);
      sd[k] = { dir: dir, s: L > 1e-6 ? [sx / L, sy / L] : null };
    });
    function cosTo(k) { var s = sd[k].s; return s ? Math.abs(v[0] * s[0] + v[1] * s[1]) / vl : 0; }
    var cur = d.free ? S.cyl.axis : st.axis, cyl = S.cyl;
    var best = ['x', 'y', 'z'].reduce(function (a, k) { return cosTo(k) > cosTo(a) + 1e-9 ? k : a; }, cur);
    var turned = d.free || cosTo(cur) < Math.SQRT1_2;
    if (turned) {
      d.free = true;
      var axis = cosTo(cur) < Math.SQRT1_2 ? best : cur;
      var tt = rayLineT(ray, cw, sd[axis].dir);
      if (tt == null) return;
      cyl.axis = axis; cyl.c = st.c.slice(); cyl.hl = clampMin(Math.abs(tt));
      return;
    }
    var a = rayLineT(ray, cw, sd[cur].dir);
    if (a == null) return;
    var hl0 = st.hl;
    var lo = d.s > 0 ? -hl0 : a, hi = d.s > 0 ? a : hl0;
    if (hi - lo < 2 * MIN_MM) { if (d.s > 0) hi = lo + 2 * MIN_MM; else lo = hi - 2 * MIN_MM; }
    cyl.axis = cur;
    cyl.hl = (hi - lo) / 2;
    var av = axisVecP(st), mid = (hi + lo) / 2;
    cyl.c = [st.c[0] + av[0] * mid, st.c[1] + av[1] * mid, st.c[2] + av[2] * mid];
  }

  function endDrag(ev) {
    if (S.draw) { finishLasso(ev && ev.type === 'pointercancel'); return; }
    if (!S.drag) return;
    S.drag = null;
    if (state.controls) state.controls.enabled = true;
    rebuild();
    syncUI();
  }

  function consume(ev) { ev.stopImmediatePropagation(); ev.preventDefault(); }

  /* A click on a piece in Outline: it becomes the footprint. */
  function pickPiece(ev) {
    var ray = setRay(ev);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(function (h) { return h.faceIndex != null; });
    if (typeof nsoHelpers !== 'undefined' && nsoHelpers.pieceHits) hits = nsoHelpers.pieceHits(hits);
    if (!hits.length) return false;
    var obj = hits[0].object;
    while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
    var placed = obj && typeof obj.userData.placedIndex === 'number' ? state.placed[obj.userData.placedIndex] : null;
    if (!placed) return false;
    var pm = modelOf(placed.sourceId);
    var o = S.outline;
    var keepZ = o.id != null ? { z1: o.z1, z2: o.z2, d1: o.d1, d2: o.d2 } : null;
    o.id = placed.sourceId; o.mode = ev.shiftKey ? 'rim' : 'silhouette'; o.tri = ev.shiftKey ? hits[0].faceIndex : -1;
    if (keepZ) { o.z1 = keepZ.z1; o.z2 = keepZ.z2; o.d1 = keepZ.d1; o.d2 = keepZ.d2; }
    o.fp = null; o.src = null; setPreview(null);
    say('Crop: the ' + (o.mode === 'rim' ? 'rim' : 'footprint') + ' of ' + ((pm && pm.name) || 'that piece') + ' is the outline');
    rebuild(); schedulePlan();
    loadFootprint();
    return true;
  }

  function onDown(ev) {
    if (ev.button !== 0 || !(live() || S.lent) || !S.shape || !state.renderer || !state.camera) return;
    if (ev.target !== state.renderer.domElement) return;
    var t = target();
    if (!t) return;
    if (S.shape === 'lasso' && !S.lent) {
      if (ev.altKey) return;                       // Alt-drag is the orbit's
      startLasso(ev);
      consume(ev);
      return;
    }
    var h = hitHandle(ev);
    if (h) {
      beginDrag(h, ev);
      if (state.controls) state.controls.enabled = false;
      consume(ev);
      rebuild();
      return;
    }
    var ray = setRay(ev);
    if (S.body && !S.lent) {                         // lent: a press inside the box is not a slide
      S.group.updateMatrixWorld(true);
      var bh = state.raycaster.intersectObject(S.body, false)[0];
      if (bh) {
        beginBody(ev, bh);
        if (state.controls) state.controls.enabled = false;
        consume(ev);
        return;
      }
    }
    if (S.shape === 'outline' && pickPiece(ev)) consume(ev);
    if (S.shape === 'wall' && wallClick(ev)) consume(ev);
  }

  function onMove(ev) {
    if (S.draw) { moveLasso(ev); return; }
    if (!S.drag) return;
    applyDrag(ev);
    rebuild();
    syncUI();
    schedulePlan();
    if (S.lent && S.lent.onChange) S.lent.onChange(boxCopy());
  }

  /* ---- doing it ---------------------------------------------------------- */

  async function doCrop() {
    var t = target(), sh = engineShape();
    if (!t || !sh || S.busy || !(S.plan && S.plan.ok)) return { ok: false, reason: 'nothing to crop' };
    S.busy = true; S.copying = true; syncUI();
    try {
      var r = await NSO_Crop.copy(t.m, sh);
      if (r.ok) S.expectSel = r.id;
      return r;
    } catch (err) {
      console.error('[crop]', err);
      say('Crop failed - nothing changed (' + ((err && err.message) || err) + ')', true);
      return { ok: false, reason: (err && err.message) || String(err) };
    } finally {
      S.busy = false; S.copying = false;
      rebuild();
      schedulePlan();
    }
  }

  function putAway(silent) {
    var had = !!S.shape;
    if (typeof NSO_boolCancelKey === 'function') NSO_boolCancelKey('crop-plan');   // a plan still measuring has no shape to measure
    S.shape = null; S.plan = null; setPreview(null); S.drag = null; S.seq++;
    if (S.draw) { S.draw = null; overlay(null); }
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    if (state.controls) state.controls.enabled = true;
    removeGroup();
    syncUI();
    if (had && !silent) say('Crop: shape put away');
  }

  // The Lift panel lives in this card. Lift owns a click on a piece while it is armed, so a shape and Lift never run together.
  function liftAway() {
    if (typeof NSO_LIFT_PLATE !== 'undefined' && NSO_LIFT_PLATE.isArmed && NSO_LIFT_PLATE.isArmed()) NSO_LIFT_PLATE.setArmed(false);
  }

  function pick(kind) {
    if (S.lent) lentTaken();                         // the card wants its own shape: the gun's box goes
    liftAway();                                      // Lift and a shape both want the clicks on a piece: one at a time
    var t = target();
    if (!t) { say('Select a piece first, then pick a shape', true); syncUI(); return; }
    S.shape = kind; S.forId = t.m.id; setPreview(null); S.expectSel = null;
    freshShape(kind, t);
    say(kind === 'wall' ? 'Crop: Wall - click a flat wall of ' + t.m.name + ' for a line along it'
      : kind === 'lasso' ? 'Crop: Lasso - drag a loop round what to copy on ' + t.m.name + ' (Alt-drag to orbit), then CROP'
      : kind === 'outline' ? 'Crop: Outline - click a piece for its footprint, or Shift-click a triangle for its rim'
      : 'Crop: ' + NAMES[kind] + ' on ' + t.m.name + ' - drag a handle to size it, the body to move it, then CROP');
    rebuild();
    schedulePlan();
  }

  /* The card follows the selection: a different piece picked puts the shape on
     that piece afresh; the copy CROP just made does not count. */
  function sync() {
    if (S.lent) return;
    if (!live()) {
      if (S.shape) putAway(true);
      S.forId = null; S.expectSel = null;
      syncUI();
      return;
    }
    var t = target();
    if (S.shape && t && t.m.id !== S.forId) {
      var kind = S.shape;
      S.forId = t.m.id; S.expectSel = null;
      freshShape(kind, t);
      S.plan = null; setPreview(null);
      rebuild(); schedulePlan();
    } else if (S.shape && !t) {
      rebuild();
    }
    syncUI();
  }

  /* ---- lending the Box --------------------------------------------------- */

  function boxCopy() { return S.box ? { c: S.box.c.slice(), h: S.box.h.slice(), yaw: S.box.yaw } : null; }

  /* The borrower is told the box is no longer its own (the card was handed another
     shape, or the helper registry is closing sessions): it puts itself away, which
     calls release(). */
  function lentTaken() {
    var l = S.lent;
    if (l && l.taken) l.taken(); else release();
  }

  /* A fresh Box on the selected piece, centred and half its size, with the card's
     handles. -> { ok, box } or { ok: false, reason }. */
  function lend(who) {
    if (S.lent) return { ok: false, reason: 'the Box is already lent' };
    var t = target();
    if (!t) return { ok: false, reason: 'Select a piece first' };
    S.kept = S.shape ? {
      shape: S.shape, forId: S.forId, plan: S.plan, expectSel: S.expectSel,
      box: S.box && { c: S.box.c.slice(), h: S.box.h.slice(), yaw: S.box.yaw }
    } : null;
    S.lent = who || {};
    S.shape = 'box'; S.forId = t.m.id; S.plan = null; S.drag = null; S.seq++;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    freshShape('box', t);
    rebuild();
    return { ok: true, box: boxCopy() };
  }

  /* Give the Box back: the card's own shape is put back as it was, or nothing. */
  function release() {
    if (!S.lent) return false;
    S.lent = null; S.drag = null;
    if (state.controls) state.controls.enabled = true;
    removeGroup();
    var k = S.kept;
    S.kept = null; S.plan = null;
    if (k) {
      S.shape = k.shape; S.forId = k.forId; S.expectSel = k.expectSel;
      if (k.box) S.box = k.box;
      rebuild(); schedulePlan();
    } else {
      S.shape = null;
    }
    syncUI();
    return true;
  }

  /* Does the pointer's ray pass through the lent box? */
  function bodyHit(ev) {
    if (!S.lent || !S.body || !S.group || !state.camera) return false;
    setRay(ev);
    S.group.updateMatrixWorld(true);
    return state.raycaster.intersectObject(S.body, false).length > 0;
  }

  /* ---- wiring ------------------------------------------------------------ */

  function onKey(ev) {
    if (S.lent || ev.key !== 'Escape' || !live() || !S.shape) return;
    var el = ev.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (S.draw) { finishLasso(true); return; }       // Escape mid-loop drops the loop, not the shape
    putAway(false);
  }

  function wire() {
    var go = $('btn-crop');
    if (!go || go.dataset.nsoWired === '1') return;
    go.dataset.nsoWired = '1';
    go.addEventListener('click', function () { doCrop(); });
    var cancel = $('btn-crop-cancel');
    if (cancel) cancel.addEventListener('click', function () { putAway(false); });
    SHAPES.forEach(function (k) {
      var b = $('btn-crop-shape-' + k);
      if (b) b.addEventListener('click', function () { pick(k); });
    });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('keydown', onKey);
    // The card follows the cutter: same piece, same lifetime. updateCutterUI runs on
    // every selection change while the card is open, and on the tool going away.
    var base = window.updateCutterUI;
    if (typeof base === 'function') {
      window.updateCutterUI = function () { var r = base.apply(this, arguments); sync(); return r; };
    }
    sync();
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('crop', {
    live: function () { return (live() && !!S.shape) || !!S.lent; },
    close: function () {
      if (S.lent) lentTaken();
      else if (typeof closeCutter === 'function') closeCutter(false);
    },
    clear: removeGroup,
    refresh: function () { if (S.shape) rebuild(); }
  });

  window.NSO_CropCard = {
    HIT_PX: HIT_PX, SHAPES: SHAPES,
    state: function () { return S; },
    shape: function () { return engineShape(); },
    handles: function () { return S.handles.map(function (h) { return h.id; }); },
    handleScreen: handleScreen,
    pick: pick, cancel: function (silent) { putAway(silent === true); }, crop: doCrop, sync: sync,
    /* The lasso, set the way a drag sets it: a loop of screen points (client px). */
    lasso: function (pts) { return S.shape === 'lasso' && setLasso(pts); },
    /* The wall's line, set the way a drag sets it (a check has no steady hand): mm out of the wall, negative into it. */
    /* The loop picked, set the way a click on a drawn edge sets it. */
    pickLoop: function (i) { var l = S.wall.loop; if (S.shape !== 'wall' || !l || i < 0 || i >= l.cands.length) return false; l.pick = i; S.plan = null; rebuild(); schedulePlan(); return true; },
    setLine: function (off) { if (S.shape !== 'wall' || !S.wall.face) return false; S.wall.off = off; rebuild(); schedulePlan(); return true; },
    /* Ask the engine about the shape as it now stands (the checks set the shape's numbers, the mouse would). */
    replan: schedulePlan,
    /* The box's centre and half-sizes in P, set the way a drag sets them (a check has no mouse worth the name on a 1.4 M-triangle piece). */
    setBox: function (c, h) {
      if (S.shape !== 'box' || !S.box) return false;
      S.box.c = c.slice(); S.box.h = h.slice();
      rebuild(); schedulePlan();
      if (S.lent && S.lent.onChange) S.lent.onChange(boxCopy());
      return true;
    },
    /* The Foam gun's loan of the Box (above). */
    /* Nothing of the card's is in use: no shape picked and none lent - so a press on a piece is the ordinary one (select, move). */
    idle: function () { return !S.shape && !S.lent; },
    lend: lend, release: release, lent: function () { return !!S.lent; }, box: boxCopy, bodyHit: bodyHit,
    refresh: function () { if (S.shape) rebuild(); }
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }
})();
