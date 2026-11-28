/* ============================================================
   Scale zones - the Scale card's section that scales PART of a piece and keeps
   the rest exactly as it is: a shower head's tube bigger with its threaded
   fitting kept, a thumb screw's head bigger on the same thread, one pillar of a
   stringing test up or down. docs/SCALE-ZONES.md. The geometry is
   nso_scale_zones.js (headless, tools/nso_scale_zones_test.js); this file is
   the card section on it, after app-scale-feature.js.

   THE SECTION works as the rest of the Scale card does: a number box with a
   slider, a ghost of the result on the piece while the numbers move, Set (or
   Enter) bakes it as one Undo, Cancel (or Escape) drops it and the piece was
   never touched.

     Scale zones   arm it. The piece turns to a ghost; zones put on it before
                   are back.
     + Keep        then click the piece: a red zone is fitted round the part
                   under the click (a thread, a shaft, a fitting) - nothing in
                   it moves. Shift-click puts a plain box there instead.
     + Scale       the same, blue: only what is in a Scale zone changes (one
                   pillar). With no Scale zone, everything outside the Keep
                   zones scales.
     a zone        a press on it picks it (yellow) and drags it; the handles on
                   its faces (a cylinder: its two ends and its side) stretch it.
                   Its row in the list: Keep | Scale, Box | Cylinder, its sizes
                   and its centre by number, × takes it away; Delete does too.
     Scale %       the factor, every way; Per axis gives X, Y and Z their own
                   (the piece's own axes; Z is up as it was loaded).
     Anchor        what stays put: Join (where the scaled part meets the kept
                   one - the default), Centre, Base.
     Blend         0 steps at the zone's skin; more eases the change over that
                   distance.

   THE PIERCE GATE (as Feature size): a part grown INTO another part of the
   piece is refused at Set, counted by NSO_Repair.inspect on the triangles
   near what moved.

   ONE PREVIEW AT A TIME. The card's own rows and Feature size put this away,
   and arming this drops theirs.

   PAINT SCOPE: WHOLE-PIECE, as Feature size: a painted piece stands this down
   at arm time, in words.
   ============================================================ */
(function () {
  'use strict';
  if (typeof NSO_ScaleZones === 'undefined') return;

  var SZ = NSO_ScaleZones;
  var GHOST_OPACITY = 0.18;
  var CLICK_PX = 5, HIT_PX = 14, DRAW_PX = 30, MIN_HALF = 0.1;
  var COL = { keep: 0xef4444, scale: 0x38bdf8, sel: 0xfacc15, rail: 0xfbbf24, dart: 0xfde68a, held: 0xffffff, result: 0x4ade80, pivot: 0xf472b6 };
  var GATE_MAX_TRIS = 120000;     // the pierce gate's own limit: more triangles near the move than this and it says it did not look

  var on = false, m = null, mesh = null, soupRef = null, ix = null, frame = null, group = null, ghostSaved = null;
  var zones = [], sel = null, picking = null, nextId = 1;
  var perAxis = false, anchor = 'join';
  var last = null, dirty = false, raf = 0, drag = null, down = null, hooked = false;
  var objs = { zones: [], fills: [], handles: [], result: null, pivots: null };

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function inch() { return typeof NSO_scaleIn === 'function' && NSO_scaleIn(); }
  function MMI() { return typeof NSO_SCALE_MM_PER_IN === 'number' ? NSO_SCALE_MM_PER_IN : 25.4; }
  function show(mm) { return inch() ? (mm / MMI()).toFixed(3) : String(Math.round(mm * 100) / 100); }
  function toMm(v) { v = +v; return inch() ? v * MMI() : v; }
  function unit() { return inch() ? 'in' : 'mm'; }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : null;
  }

  /* ---------------- the raw <-> local frame ---------------- */

  /* rawTris -> the mesh's local space is a rotation and an offset (app-mask.js); held as one matrix */
  function rawToLocalMatrix() {
    var L = function (p) { return frame && typeof nsoLocalPointFromRaw === 'function' ? nsoLocalPointFromRaw(frame, p) : p; };
    var b = L([0, 0, 0]), ex = L([1, 0, 0]), ey = L([0, 1, 0]), ez = L([0, 0, 1]);
    var M = new THREE.Matrix4();
    M.set(ex[0] - b[0], ey[0] - b[0], ez[0] - b[0], b[0],
          ex[1] - b[1], ey[1] - b[1], ez[1] - b[1], b[1],
          ex[2] - b[2], ey[2] - b[2], ez[2] - b[2], b[2],
          0, 0, 0, 1);
    return M;
  }
  var M = null, Minv = null;
  function worldOfRaw(p) { var v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(M); mesh.updateMatrixWorld(true); return mesh.localToWorld(v); }
  function worldDirOfRaw(d) {
    var v = new THREE.Vector3(d[0], d[1], d[2]).transformDirection(M);
    return v.transformDirection(mesh.matrixWorld).normalize();
  }
  function rawOfWorld(v) { mesh.updateMatrixWorld(true); var l = mesh.worldToLocal(v.clone()); l.applyMatrix4(Minv); return [l.x, l.y, l.z]; }
  function rawDirOfWorld(v) {
    var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    var l = v.clone().transformDirection(inv).transformDirection(Minv);
    return [l.x * v.length(), l.y * v.length(), l.z * v.length()];
  }

  /* ---------------- drawing ---------------- */

  function dispose(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    o.traverse(function (c) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(function (mt) { mt.dispose(); });
    });
  }
  function localGeo(flat) {
    var pos = new Float32Array(flat.length), v = new THREE.Vector3();
    for (var i = 0; i < flat.length; i += 3) {
      v.set(flat[i], flat[i + 1], flat[i + 2]).applyMatrix4(M);
      pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }
  function ghost(onOff) {
    var mats = mesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    if (onOff) {
      ghostSaved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite };
      }) };
      mesh.userData.skipXray = true;
      mats.forEach(function (mt) { mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.needsUpdate = true; });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) { s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite; s.mt.needsUpdate = true; });
      if (mesh) mesh.userData.skipXray = ghostSaved.skip;
      ghostSaved = null;
    }
  }

  /* a zone's shape in raw axes, then into the mesh's local space */
  function zoneGeo(z) {
    var g;
    if (z.shape === 'cyl') {
      g = new THREE.CylinderGeometry(z.r, z.r, 2 * z.hl, 48, 1, false);
      if (z.axis === 2) g.rotateX(Math.PI / 2); else if (z.axis === 0) g.rotateZ(-Math.PI / 2);
    } else g = new THREE.BoxGeometry(2 * z.h[0], 2 * z.h[1], 2 * z.h[2]);
    g.translate(z.c[0], z.c[1], z.c[2]);
    g.applyMatrix4(M);
    return g;
  }

  function handlesOf(z) {
    var out = [];
    if (z.shape === 'cyl') {
      var a = z.axis, u = (a + 1) % 3;
      [1, -1].forEach(function (sg) {
        var p = z.c.slice(), d = [0, 0, 0];
        p[a] += sg * z.hl; d[a] = sg;
        out.push({ id: 'end' + (sg > 0 ? '+' : '-'), k: a, sg: sg, raw: p, dir: d, what: 'end' });
      });
      var q = z.c.slice(), e = [0, 0, 0];
      q[u] += z.r; e[u] = 1;
      out.push({ id: 'radius', k: u, sg: 1, raw: q, dir: e, what: 'radius' });
      return out;
    }
    [0, 1, 2].forEach(function (k) {
      [1, -1].forEach(function (sg) {
        var p = z.c.slice(), d = [0, 0, 0];
        p[k] += sg * z.h[k]; d[k] = sg;
        out.push({ id: 'xyz'[k] + (sg > 0 ? '+' : '-'), k: k, sg: sg, raw: p, dir: d, what: 'face' });
      });
    });
    return out;
  }

  function buildHandle(h, held) {
    var g = new THREE.Group();
    var mat = function (c, o) { return new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: o }); };
    var rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6), mat(held ? COL.held : COL.rail, held ? 1 : 0.85));
    rail.renderOrder = 999; g.add(rail);
    [1, -1].forEach(function (sg) {
      var dart = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.9, 14), mat(held ? COL.held : COL.dart, 1));
      dart.position.y = sg * 0.85;
      if (sg < 0) dart.rotation.x = Math.PI;
      dart.renderOrder = 1000; g.add(dart);
    });
    g.userData.zoneHandle = h.id;
    return g;
  }

  function rescale() {
    if (!group || !state.camera || !state.renderer) return;
    var cam = state.camera, rect = state.renderer.domElement.getBoundingClientRect();
    if (!rect.height) return;
    var perPx = 2 * Math.tan((cam.fov || 50) * Math.PI / 360) / rect.height, wp = new THREE.Vector3();
    objs.handles.forEach(function (h) {
      h.obj.getWorldPosition(wp);
      var s = Math.max(1e-4, cam.position.distanceTo(wp) * perPx * DRAW_PX / 2);
      /* the group sits in the mesh: undo the mesh's own scale, if it has one */
      var ms = new THREE.Vector3(); mesh.getWorldScale(ms);
      h.obj.scale.setScalar(s / (ms.x || 1));
    });
  }

  function clearZones() {
    objs.zones.forEach(dispose); objs.zones = []; objs.fills = [];
    objs.handles.forEach(function (h) { dispose(h.obj); }); objs.handles = [];
  }
  function clearResult() { dispose(objs.result); objs.result = null; dispose(objs.pivots); objs.pivots = null; }

  function drawZones() {
    clearZones();
    if (!on || !group) return;
    list().forEach(function (z) {
      var isSel = z.id === sel, col = isSel ? COL.sel : COL[z.kind];
      var geo = zoneGeo(z);
      var fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COL[z.kind], transparent: true, opacity: isSel ? 0.22 : 0.13, depthWrite: false, side: THREE.DoubleSide }));
      fill.renderOrder = 20; fill.userData.zoneId = z.id; fill.userData.skipXray = true;
      var edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: isSel ? 1 : 0.8, depthTest: false }));
      edges.renderOrder = 21; edges.userData.skipXray = true; edges.raycast = function () {};
      var g = new THREE.Group(); g.add(fill); g.add(edges);
      group.add(g);
      objs.zones.push(g); objs.fills.push(fill);
    });
    var z = zoneById(sel);
    if (z) {
      handlesOf(z).forEach(function (h) {
        var obj = buildHandle(h, drag && drag.kind === 'handle' && drag.h.id === h.id);
        var lp = new THREE.Vector3(h.raw[0], h.raw[1], h.raw[2]).applyMatrix4(M);
        var ld = new THREE.Vector3(h.dir[0], h.dir[1], h.dir[2]).transformDirection(M);
        obj.position.copy(lp);
        obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ld);
        group.add(obj);
        objs.handles.push({ h: h, obj: obj });
      });
    }
    group.traverse(function (o) { o.frustumCulled = false; });
    rescale();
  }

  /* ---------------- the result ---------------- */

  function factorNow() {
    var all = pct('all');
    if (!perAxis) return all == null ? null : [all, all, all];
    var f = ['x', 'y', 'z'].map(function (k) { return pct(k); });
    return f.some(function (v) { return v == null; }) ? null : f;
  }
  function pct(k) {
    var b = $('scale-zones-' + k);
    if (!b || String(b.value).trim() === '') return null;
    var v = +b.value;
    return isFinite(v) ? v / 100 : null;
  }
  function blendNow() {
    var b = $('scale-zones-blend');
    var v = b ? toMm(b.value) : 0;
    return isFinite(v) && v > 0 ? v : 0;
  }
  function isIdentity(F) { return F && F.every(function (f) { return Math.abs(f - 1) < 1e-6; }); }

  function recompute() {
    dirty = false;
    clearResult();
    last = null;
    if (!on) return;
    drawZones();
    /* while a zone is dragged only the zone follows the pointer; the result is worked out when it is let go
       (a 200 000-triangle piece takes a tenth of a second a preview) */
    if (drag && drag.moved) { readout(); return; }
    var F = factorNow();
    if (list().length && F && !isIdentity(F)) {
      try { last = SZ.apply(soupRef, list(), F, { ix: ix, blend: blendNow(), anchor: anchor }); }
      catch (e) { last = { ok: false, reason: (e && e.message) || 'error' }; }
      last.F = F;
    } else if (list().length) {
      try { var P = SZ.plan(soupRef, list(), { ix: ix, blend: blendNow(), anchor: anchor }); last = { ok: false, planOnly: true, plan: P, reason: P.ok ? null : P.reason }; }
      catch (e2) { last = { ok: false, planOnly: true, reason: (e2 && e2.message) || 'error' }; }
    }
    if (last && last.ok && group) {
      var g = localGeo(last.soup);
      objs.result = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COL.result, emissive: 0x14532d, emissiveIntensity: 0.4, roughness: 0.6, metalness: 0,
        transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      objs.result.renderOrder = 30; objs.result.userData.skipXray = true; objs.result.raycast = function () {};
      group.add(objs.result);
    }
    var parts = last && (last.parts || (last.plan && last.plan.parts));
    if (parts && parts.length && group) {
      objs.pivots = new THREE.Group();
      majorParts(parts).forEach(function (p) {
        var s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: COL.pivot, depthTest: false, transparent: true, opacity: 0.9 }));
        s.position.copy(new THREE.Vector3(p.pivot[0], p.pivot[1], p.pivot[2]).applyMatrix4(M));
        var span = Math.max(p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]);
        s.scale.setScalar(Math.max(0.3, Math.min(2, span * 0.03)));
        s.renderOrder = 45; s.raycast = function () {};
        objs.pivots.add(s);
      });
      group.add(objs.pivots);
    }
    readout();
  }
  /* the parts worth naming: a stray vertex or two caught at a zone's skin is not a part */
  function majorParts(parts) {
    var total = parts.reduce(function (s, p) { return s + (p.verts.length != null ? p.verts.length : p.verts); }, 0);
    return parts.filter(function (p, i) { var n = p.verts.length != null ? p.verts.length : p.verts; return i === 0 || n >= Math.max(8, total * 0.01); });
  }

  /* THE PIERCE GATE: piercing pairs among the triangles near the move, before and after. */
  function gate(r) {
    if (typeof NSO_Repair === 'undefined' || !NSO_Repair || typeof NSO_Repair.inspect !== 'function') return { ran: false, why: 'the checker did not load' };
    var n = soupRef.length / 9, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], movedT = new Uint8Array(n), k, t, c;
    for (t = 0; t < n; t++) {
      for (c = 0; c < 9; c++) if (r.soup[t * 9 + c] !== soupRef[t * 9 + c]) { movedT[t] = 1; break; }
      if (!movedT[t]) continue;
      for (c = 0; c < 9; c++) { k = c % 3; var v = r.soup[t * 9 + c]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    }
    var pick = [];
    for (t = 0; t < n; t++) {
      if (movedT[t]) { pick.push(t); continue; }
      var inside = true;
      for (k = 0; k < 3 && inside; k++) {
        var a = Math.min(soupRef[t * 9 + k], soupRef[t * 9 + 3 + k], soupRef[t * 9 + 6 + k]), b = Math.max(soupRef[t * 9 + k], soupRef[t * 9 + 3 + k], soupRef[t * 9 + 6 + k]);
        if (b < lo[k] || a > hi[k]) inside = false;
      }
      if (inside) pick.push(t);
    }
    if (pick.length > GATE_MAX_TRIS) return { ran: false, why: pick.length + ' triangles near the move - too many to check for crossings here; look the piece over after' };
    var A = new Float32Array(pick.length * 9), B = new Float32Array(pick.length * 9);
    pick.forEach(function (t2, i) { for (var q = 0; q < 9; q++) { A[i * 9 + q] = soupRef[t2 * 9 + q]; B[i * 9 + q] = r.soup[t2 * 9 + q]; } });
    var before = NSO_Repair.inspect(A).selfIntersections, after = NSO_Repair.inspect(B).selfIntersections;
    return { ran: true, before: before, after: after };
  }

  /* ---------------- the list and the boxes ---------------- */

  function list() {
    if (drag && drag.draft) return zones.map(function (z) { return z.id === drag.draft.id ? drag.draft : z; });
    return zones;
  }
  function zoneById(id) { return list().find(function (z) { return z.id === id; }) || null; }
  function stored(id) { return zones.find(function (z) { return z.id === id; }) || null; }
  function persist() { if (m) m.scaleZones = zones.map(SZ.copy); }

  function kindWord(z) { return z.kind === 'keep' ? 'Keep' : 'Scale'; }

  function renderList() {
    var ul = $('scale-zones-list');
    if (!ul) return;
    ul.textContent = '';
    zones.forEach(function (z) {
      var li = document.createElement('li');
      li.className = 'scale-zones-item' + (z.id === sel ? ' is-sel' : '') + ' is-' + z.kind;
      li.dataset.zoneId = String(z.id);
      var name = document.createElement('button');
      name.type = 'button'; name.className = 'scale-zones-name';
      var dims = z.shape === 'cyl' ? 'cylinder Ø' + show(2 * z.r) + ' × ' + show(2 * z.hl) + ' ' + unit() + ', along ' + SZ.AXES[z.axis]
        : 'box ' + show(2 * z.h[0]) + ' × ' + show(2 * z.h[1]) + ' × ' + show(2 * z.h[2]) + ' ' + unit();
      name.textContent = kindWord(z) + ' · ' + dims;
      name.title = 'Pick this zone: its handles show on the piece, and its sizes below';
      name.addEventListener('click', function () { select(z.id); });
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'scale-zones-del'; del.textContent = '×';
      del.title = 'Take this zone away'; del.setAttribute('aria-label', 'Take away ' + kindWord(z) + ' zone');
      del.addEventListener('click', function () { remove(z.id); });
      li.appendChild(name); li.appendChild(del);
      ul.appendChild(li);
    });
    var edit = $('scale-zones-edit'), z0 = stored(sel);
    if (edit) edit.hidden = !z0;
    if (!z0) return;
    ['keep', 'scale'].forEach(function (k) { var b = $('btn-scale-zones-kind-' + k); if (b) { b.setAttribute('aria-pressed', z0.kind === k ? 'true' : 'false'); b.classList.toggle('is-on', z0.kind === k); } });
    ['box', 'cyl'].forEach(function (k) { var b = $('btn-scale-zones-shape-' + k); if (b) { b.setAttribute('aria-pressed', z0.shape === k ? 'true' : 'false'); b.classList.toggle('is-on', z0.shape === k); } });
    var dims = z0.shape === 'cyl'
      ? [['Ø', 2 * z0.r], ['Length', 2 * z0.hl], null]
      : [['X', 2 * z0.h[0]], ['Y', 2 * z0.h[1]], ['Z', 2 * z0.h[2]]];
    for (var i = 0; i < 3; i++) {
      var lab = $('scale-zones-size' + i + '-label'), box = $('scale-zones-size' + i), row = $('scale-zones-size' + i + '-row');
      if (row) row.hidden = !dims[i];
      if (dims[i] && box && document.activeElement !== box) { if (lab) lab.textContent = dims[i][0]; box.value = show(dims[i][1]); }
    }
    var axisRow = $('scale-zones-axis-row');
    if (axisRow) axisRow.hidden = z0.shape !== 'cyl';
    ['0', '1', '2'].forEach(function (k) { var b = $('btn-scale-zones-axis-' + k); if (b) { var p = z0.shape === 'cyl' && String(z0.axis) === k; b.setAttribute('aria-pressed', p ? 'true' : 'false'); b.classList.toggle('is-on', p); } });
    ['x', 'y', 'z'].forEach(function (k, j) { var b = $('scale-zones-c' + k); if (b && document.activeElement !== b) b.value = show(z0.c[j]); });
    document.querySelectorAll('#scale-zones-panel .scale-zones-u').forEach(function (s) { s.textContent = unit(); });
  }

  function changed() { persist(); renderList(); dirty = true; }

  /* ---------------- adding, removing, editing ---------------- */

  function add(z, quiet) {
    z = SZ.copy(z);
    z.id = nextId++;
    zones.push(z);
    sel = z.id;
    changed();
    if (!quiet) say('Scale zones: ' + kindWord(z) + ' zone added - ' + SZ.describe(z) + ' mm. Drag it to move it, drag a handle to stretch it.');
    return z.id;
  }
  function remove(id) {
    var before = zones.length;
    zones = zones.filter(function (z) { return z.id !== id; });
    if (sel === id) sel = zones.length ? zones[zones.length - 1].id : null;
    if (zones.length !== before) changed();
    return zones.length !== before;
  }
  function select(id) { sel = stored(id) ? id : null; changed(); return sel; }
  function edit(id, fields) {
    var z = stored(id);
    if (!z) return { ok: false, reason: 'no such zone' };
    if (fields.kind) z.kind = fields.kind === 'keep' ? 'keep' : 'scale';
    if (fields.shape && fields.shape !== z.shape) {
      var b = SZ.bounds(z);
      if (fields.shape === 'cyl') {
        var a = fields.axis != null ? fields.axis : longest(b);
        var hh = [(b.hi[0] - b.lo[0]) / 2, (b.hi[1] - b.lo[1]) / 2, (b.hi[2] - b.lo[2]) / 2];
        z.shape = 'cyl'; z.axis = a; z.hl = hh[a]; z.r = Math.max(hh[(a + 1) % 3], hh[(a + 2) % 3]); delete z.h;
      } else {
        z.shape = 'box'; z.h = [(b.hi[0] - b.lo[0]) / 2, (b.hi[1] - b.lo[1]) / 2, (b.hi[2] - b.lo[2]) / 2]; delete z.axis; delete z.r; delete z.hl;
      }
    }
    if (fields.axis != null && z.shape === 'cyl' && fields.axis !== z.axis) z.axis = fields.axis | 0;
    if (fields.c) z.c = fields.c.map(r3);
    if (fields.h && z.shape === 'box') z.h = fields.h.map(function (v) { return r3(Math.max(MIN_HALF, v)); });
    if (fields.r != null && z.shape === 'cyl') z.r = r3(Math.max(MIN_HALF, fields.r));
    if (fields.hl != null && z.shape === 'cyl') z.hl = r3(Math.max(MIN_HALF, fields.hl));
    changed();
    return { ok: true, zone: SZ.copy(z) };
  }
  function longest(b) { var s = [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]]; return s[2] >= s[0] && s[2] >= s[1] ? 2 : s[0] >= s[1] ? 0 : 1; }

  /* a zone round the part at triangle `tri`, point `p` (raw); plain: a box there, not a fit */
  function placeAt(tri, p, kind, plain) {
    var fitR = null;
    if (!plain) {
      try { fitR = SZ.fit(soupRef, tri, p, { ix: ix, kind: kind }); } catch (e) { fitR = { ok: false, reason: (e && e.message) || 'error' }; }
    }
    if (fitR && fitR.ok) {
      add(fitR.zone, true);
      say('Scale zones: ' + (kind === 'keep' ? 'Keep' : 'Scale') + ' zone fitted to the part you clicked - ' + SZ.describe(fitR.zone) + ' mm. Stretch its handles if it should reach further.');
      return { ok: true, fitted: true, zone: SZ.copy(fitR.zone) };
    }
    var span = bboxSpan(), s = Math.max(2, Math.min(40, Math.max(span[0], span[1], span[2]) / 4)) / 2;
    var z = { kind: kind, shape: 'box', c: p.slice(), h: [s, s, s] };
    add(z, true);
    say('Scale zones: ' + (fitR ? 'no part to fit there (' + fitR.reason + ') - ' : '') + 'a ' + (kind === 'keep' ? 'Keep' : 'Scale') + ' box put there. Drag it, stretch its handles, or type its sizes.', !!fitR);
    return { ok: true, fitted: false, zone: SZ.copy(z) };
  }
  function bboxSpan() {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < ix.nv; i++) for (var k = 0; k < 3; k++) { var x = ix.pos[i * 3 + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }
  /** Pick a triangle by its middle (the drive check's way in). */
  function placeOnTri(tri, kind, plain) {
    if (!on) return { ok: false, reason: 'not armed' };
    var o = tri * 9, p = [0, 1, 2].map(function (k) { return (soupRef[o + k] + soupRef[o + 3 + k] + soupRef[o + 6 + k]) / 3; });
    var r = placeAt(tri, p, kind === 'keep' ? 'keep' : 'scale', !!plain);
    picking = null; syncButtons();
    return r;
  }

  /* ---------------- the readout ---------------- */

  function syncButtons() {
    ['keep', 'scale'].forEach(function (k) {
      var b = $('btn-scale-zones-' + k);
      if (b) { b.setAttribute('aria-pressed', picking === k ? 'true' : 'false'); b.classList.toggle('is-on', picking === k); }
    });
    ['join', 'centre', 'base'].forEach(function (k) {
      var b = $('btn-scale-zones-anchor-' + k);
      if (b) { b.setAttribute('aria-pressed', anchor === k ? 'true' : 'false'); b.classList.toggle('is-on', anchor === k); }
    });
    var axes = $('scale-zones-axes'), pa = $('scale-zones-peraxis'), allRow = $('scale-zones-all-row');
    if (axes) axes.hidden = !perAxis;
    if (allRow) allRow.hidden = perAxis;
    if (pa) pa.checked = perAxis;
    var cv = state.renderer && state.renderer.domElement;
    if (cv) cv.style.cursor = on && picking ? 'crosshair' : (cv.style.cursor === 'crosshair' ? '' : cv.style.cursor);
  }

  function fmtPart(p, F) {
    var d = function (k) { return show(p.hi[k] - p.lo[k]); }, n = function (k) { return show(p.newHi[k] - p.newLo[k]); };
    return d(0) + ' × ' + d(1) + ' × ' + d(2) + (p.newLo ? ' → ' + n(0) + ' × ' + n(1) + ' × ' + n(2) : '') + ' ' + unit() +
      (p.anchor === 'join' ? ' (from where it joins)' : p.anchor === 'base' ? ' (from its base)' : ' (about its middle)');
  }

  function readout() {
    var el = $('scale-zones-readout'), note = $('scale-zones-note'), set = $('btn-scale-zones-set'), cancel = $('btn-scale-zones-cancel');
    if (set) set.disabled = !(on && last && last.ok);
    if (cancel) cancel.disabled = !on;
    syncButtons();
    if (!el) return;
    if (!on) { el.textContent = 'Scale part of a piece and keep the rest: a head on the same thread, one pillar of many.'; if (note) { note.textContent = ''; note.classList.remove('scale-bad'); } return; }
    if (picking) el.textContent = 'Click the part of ' + (m && m.name ? m.name : 'the piece') + ' to ' + (picking === 'keep' ? 'KEEP' : 'SCALE') + ' - a zone is fitted round it. Shift-click puts a plain box there.';
    else if (!zones.length) el.textContent = 'Press + Keep and click what must not change (a thread, a fitting), or + Scale and click the part to resize.';
    else {
      var nk = zones.filter(function (z) { return z.kind === 'keep'; }).length, ns = zones.length - nk;
      el.textContent = (nk ? nk + ' Keep' : '') + (nk && ns ? ', ' : '') + (ns ? ns + ' Scale' : '') + ' zone' + (zones.length === 1 ? '' : 's') + ' - ' +
        (ns ? 'what is in a Scale zone changes' : 'everything outside the Keep zones changes') + (nk && ns ? ', and Keep wins where they overlap' : '') + '.';
    }
    if (!note) return;
    note.classList.remove('scale-bad');
    if (!zones.length) { note.textContent = ''; return; }
    if (!last) { note.textContent = 'Type a scale or move the slider to see it on the piece. Set bakes it; nothing changes until then.'; return; }
    if (last.planOnly) {
      if (last.reason) { note.textContent = last.reason; note.classList.add('scale-bad'); return; }
      var P = majorParts(last.plan.parts);
      note.textContent = (P.length === 1 ? 'One part' : P.length + ' parts') + ' would scale (the pink dot' + (P.length === 1 ? ' is what stays put' : 's are what stay put') + '): ' +
        P.map(function (p) { return fmtPart(p); }).join('; ') + '. Type a scale to see it.';
      return;
    }
    if (!last.ok) { note.textContent = 'Refused: ' + last.reason; note.classList.add('scale-bad'); return; }
    var parts = majorParts(last.parts);
    note.textContent = 'Preview: ' + (parts.length > 1 ? parts.length + ' parts - ' : '') + parts.map(function (p) { return fmtPart(p); }).join('; ') +
      '. ' + last.kept + ' points kept as they were. Set bakes it, Esc drops it.';
  }

  /* ---------------- arm ---------------- */

  function showPanel(v) {
    var p = $('scale-zones-panel'), b = $('btn-scale-zones');
    if (p) p.hidden = !v;
    if (b) { b.setAttribute('aria-pressed', v ? 'true' : 'false'); b.classList.toggle('is-on', !!v); }
  }

  function arm() {
    if (on) { cancel(); return { ok: true, left: true }; }
    var model = typeof getActiveModel === 'function' ? getActiveModel() : null;
    if (!model) { say('Scale zones: select a piece first', true); return { ok: false, reason: 'no piece' }; }
    if (!(model.rawTris && model.rawAxis === 'zup' && model.rawTris.length >= 9)) { say('Scale zones: this piece has no untransformed soup to work on', true); return { ok: false, reason: 'no soup' }; }
    var painted = typeof nsoMaskCount === 'function' ? nsoMaskCount(model) : 0;
    if (painted > 0) {
      say('Scale zones stood down - ' + painted + ' painted face(s); faces that cross a zone stretch, so no painted face can be promised untouched. Clear paint first.', true);
      return { ok: false, reason: 'painted faces: ' + painted };
    }
    var ms = meshOf(model);
    if (!ms) { say('Scale zones: put the piece on the plate first. Nothing changed.', true); return { ok: false, reason: 'not placed' }; }
    var sc = $('btn-scale-cancel');
    if (sc && !sc.disabled) sc.click();                       // the card's own preview goes first: one ghost at a time
    if (window.nsoScaleFeature && window.nsoScaleFeature.on()) window.nsoScaleFeature.cancel(true);
    on = true; m = model; mesh = ms; soupRef = model.rawTris; ix = SZ.index(soupRef); last = null; picking = null;
    frame = typeof nsoRawFrameOf === 'function' ? nsoRawFrameOf(m) : null;
    M = rawToLocalMatrix(); Minv = new THREE.Matrix4().copy(M).invert();
    zones = (m.scaleZones || []).filter(SZ.valid).map(SZ.copy);
    zones.forEach(function (z) { z.id = nextId++; });
    sel = zones.length ? zones[zones.length - 1].id : null;
    group = new THREE.Group();
    group.userData.skipXray = true;
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(mesh, group, 'scale-zones', { interactive: true }); else mesh.add(group);
    ghost(true);
    showPanel(true);
    renderList();
    dirty = true;
    readout();
    say(zones.length ? 'Scale zones - the zones you put on this piece are back. Type a scale to see it.' : 'Scale zones - press + Keep and click what must not change, or + Scale and click the part to resize.');
    if (state.controls && state.controls.addEventListener && !hooked) { hooked = true; state.controls.addEventListener('change', rescale); }
    tick();
    return { ok: true };
  }

  function teardown() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (drag && state.controls) state.controls.enabled = true;
    clearZones(); clearResult();
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
    on = false; m = null; mesh = null; soupRef = null; ix = null; frame = null; last = null; drag = null; down = null; picking = null; zones = []; sel = null;
    showPanel(false);
    renderList();
    readout();
  }

  function cancel(quiet) {
    if (!on) return false;
    teardown();
    if (!quiet) say('Scale zones: put away - piece unchanged (the zones are kept on it for next time)');
    return true;
  }

  /* ---------------- set ---------------- */

  function set() {
    if (!on) return { ok: false, reason: 'not armed' };
    if (stale()) return { ok: false, reason: 'the piece changed' };
    if (dirty) recompute();
    if (!last || !last.ok) {
      say('Scale zones: ' + (last && last.reason ? 'refused - ' + last.reason : 'nothing to set - add a zone and type a scale first') + '; piece unchanged', true);
      return { ok: false, reason: last ? last.reason : 'nothing' };
    }
    var r = last, model = m, F = r.F;
    var g = null;
    try { g = gate(r); } catch (e) { g = { ran: false, why: 'the check failed: ' + ((e && e.message) || e) }; }
    if (g.ran && g.after > g.before) {
      last.ok = false;
      last.reason = 'at that scale the part would cut into another part of the piece (piercing pairs ' + g.before + '→' + g.after + ') - scale it less or move a zone';
      readout();
      say('Scale zones: refused - ' + last.reason + '; piece unchanged', true);
      return { ok: false, reason: last.reason };
    }
    var parts = majorParts(r.parts);
    var words = perAxis ? 'X ' + Math.round(F[0] * 1000) / 10 + '%, Y ' + Math.round(F[1] * 1000) / 10 + '%, Z ' + Math.round(F[2] * 1000) / 10 + '%' : Math.round(F[0] * 1000) / 10 + '%';
    var status = 'Scale zones: ' + (parts.length > 1 ? parts.length + ' parts' : 'the part') + ' scaled ' + words + ', the rest kept' + (g.ran ? '' : ' (not checked for crossings: ' + g.why + ')');
    /* the Scale zones go with their parts, so they still hold them; Keep zones stay where they are */
    var carried = zones.map(function (z) {
      if (z.kind !== 'scale') return SZ.copy(z);
      var idx = list().filter(function (q) { return q.kind === 'scale'; }).indexOf(z);
      var p = r.parts.find(function (q) { return q.zone === idx; });
      return p ? SZ.carry(z, p.pivot, F) : SZ.copy(z);
    });
    teardown();
    var ok = typeof NSO_sculptCommitRaw === 'function' && NSO_sculptCommitRaw(model, r.soup, 'scaleZonesReplace', status);
    if (!ok) { say('Scale zones failed to commit - piece unchanged', true); return { ok: false, reason: 'commit failed' }; }
    model.scaleZones = carried;
    if (typeof updateEditSize === 'function') updateEditSize();
    /* armed again on the same piece, with its zones, at 100% */
    resetFactors();
    arm();
    say(status);
    return { ok: true, parts: r.parts, gate: g };
  }
  function resetFactors() {
    ['all', 'x', 'y', 'z'].forEach(function (k) { var b = $('scale-zones-' + k), s = $('scale-zones-' + k + '-slider'); if (b) b.value = '100'; if (s) s.value = '100'; });
  }

  /* ---------------- upkeep ---------------- */

  function stale() {
    if (!on) return false;
    var cur = typeof getActiveModel === 'function' ? getActiveModel() : null;
    if (cur === m && m.rawTris === soupRef && meshOf(m) === mesh) return false;
    cancel(true);
    say('Scale zones put away - the piece or the selection changed under it. Nothing was set.');
    return true;
  }
  function tick() {
    raf = 0;
    if (!on || stale()) return;
    if (dirty) recompute();
    raf = requestAnimationFrame(tick);
  }

  /* ---------------- pointer ---------------- */

  function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }
  function consume(ev) { ev.stopImmediatePropagation(); ev.preventDefault(); }
  function setRay(ev) {
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster.ray;
  }
  function screenOf(v) {
    var r = state.renderer.domElement.getBoundingClientRect(), p = v.clone().project(state.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, behind: p.z > 1 };
  }
  function hitHandle(ev) {
    var best = null, bd = HIT_PX, wp = new THREE.Vector3();
    objs.handles.forEach(function (H) {
      H.obj.getWorldPosition(wp);
      var s = screenOf(wp);
      if (s.behind) return;
      var d = Math.hypot(s.x - ev.clientX, s.y - ev.clientY);
      if (d <= bd) { bd = d; best = H.h; }
    });
    return best;
  }
  function zoneHit(ev) {
    if (!objs.fills.length) return null;
    setRay(ev);
    group.updateMatrixWorld(true);
    var hit = state.raycaster.intersectObjects(objs.fills, false)[0];
    return hit ? { id: hit.object.userData.zoneId, point: hit.point.clone(), dist: hit.distance } : null;
  }
  function pieceHit(ev) {
    setRay(ev);
    mesh.updateMatrixWorld(true);
    var hits = state.raycaster.intersectObject(mesh, false).filter(function (h) { return h.faceIndex != null; });
    return hits[0] || null;
  }
  function rayLineT(ray, p0, d) {
    var w = ray.origin.clone().sub(p0), r = ray.direction;
    var b = r.dot(d), dd = r.dot(w), e = d.dot(w), den = 1 - b * b;
    if (den < 1e-6) return null;
    return (e - b * dd) / den;
  }

  function onDown(ev) {
    down = null;
    if (!on || ev.button !== 0 || !onCanvas(ev) || drag) return;
    if (picking) {
      var ph = pieceHit(ev);
      if (!ph) { say('Scale zones: that click missed the piece - click on it', true); consume(ev); return; }
      var geo = mesh.geometry, nTri = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) | 0;
      if (nTri !== soupRef.length / 9) { say('Scale zones: the picture of this piece and its triangles disagree - Undo and redo the last change, then try again', true); consume(ev); return; }
      var p = rawOfWorld(ph.point), kind = picking;
      placeAt(ph.faceIndex, p, kind, !!ev.shiftKey);
      picking = null;
      consume(ev);
      readout();
      return;
    }
    var h = sel != null ? hitHandle(ev) : null;
    if (h) {
      var z = stored(sel), ray = setRay(ev), wp = worldOfRaw(h.raw), wd = worldDirOfRaw(h.dir);
      drag = { kind: 'handle', h: h, id: z.id, was: SZ.copy(z), wp: wp, wd: wd, t0: rayLineT(ray, wp, wd), moved: false, x: ev.clientX, y: ev.clientY, draft: SZ.copy(z) };
      if (state.controls) state.controls.enabled = false;
      consume(ev); drawZones();
      return;
    }
    var zh = zoneHit(ev);
    if (zh) {
      var ph2 = pieceHit(ev);
      if (zh.id === sel || !ph2 || ph2.distance > zh.dist - 1e-3) {
        sel = zh.id; renderList();
        var z2 = stored(zh.id), cam = new THREE.Vector3();
        state.camera.getWorldDirection(cam);
        drag = { kind: 'body', id: z2.id, was: SZ.copy(z2), q: zh.point.clone(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(cam, zh.point),
          moved: false, x: ev.clientX, y: ev.clientY, draft: SZ.copy(z2) };
        if (state.controls) state.controls.enabled = false;
        consume(ev); drawZones();
        return;
      }
    }
    down = { x: ev.clientX, y: ev.clientY };
  }
  function onMove(ev) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < CLICK_PX) return;
    drag.moved = true;
    var ray = setRay(ev), was = drag.was, d = drag.draft;
    if (drag.kind === 'body') {
      var q = new THREE.Vector3();
      if (!ray.intersectPlane(drag.plane, q)) return;
      var dv = rawDirOfWorld(q.clone().sub(drag.q));
      d.c = [was.c[0] + dv[0], was.c[1] + dv[1], was.c[2] + dv[2]];
    } else {
      var h = drag.h, t1 = rayLineT(ray, drag.wp, drag.wd);
      if (t1 == null || drag.t0 == null) return;
      var delta = t1 - drag.t0;
      if (h.what === 'radius') d.r = Math.max(MIN_HALF, was.r + delta);
      else if (h.what === 'end') {
        var hl = Math.max(MIN_HALF, was.hl + delta / 2);
        d.hl = hl; d.c = was.c.slice(); d.c[h.k] = was.c[h.k] + (hl - was.hl) * h.sg;
      } else {
        var h0 = was.h[h.k], hn = Math.max(MIN_HALF, h0 + delta / 2);
        d.h = was.h.slice(); d.h[h.k] = hn; d.c = was.c.slice(); d.c[h.k] = was.c[h.k] + (hn - h0) * h.sg;
      }
    }
    consume(ev);
    dirty = true;
  }
  function endDrag(keep) {
    var d = drag;
    drag = null;
    if (state.controls) state.controls.enabled = true;
    if (keep && d && d.moved) {
      var z = stored(d.id);
      if (z) {
        z.c = d.draft.c.map(r3);
        if (z.shape === 'cyl') { z.r = r3(d.draft.r); z.hl = r3(d.draft.hl); } else z.h = d.draft.h.map(r3);
      }
    }
    changed();
  }
  function onUp(ev) {
    if (drag) { endDrag(true); return; }
    var d = down; down = null;
    if (d && on && sel != null && onCanvas(ev) && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < CLICK_PX && !zoneHit(ev)) { sel = null; changed(); }
  }
  function onKey(ev) {
    if (!on) return;
    var tag = ev.target && ev.target.tagName;
    if (ev.key === 'Escape') {
      if (drag) { endDrag(false); consume(ev); return; }
      if (picking) { picking = null; readout(); consume(ev); return; }
      if (tag !== 'INPUT') { cancel(); consume(ev); }
      return;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel != null && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      remove(sel); consume(ev);
    }
  }

  /* ---------------- wiring ---------------- */

  function bind() {
    var b = $('btn-scale-zones');
    if (!b || b.dataset.nsoWired === '1') return;
    b.dataset.nsoWired = '1';
    b.addEventListener('click', function () { arm(); });
    $('btn-scale-zones-set').addEventListener('click', function () { set(); });
    $('btn-scale-zones-cancel').addEventListener('click', function () { cancel(); });
    ['keep', 'scale'].forEach(function (k) {
      $('btn-scale-zones-' + k).addEventListener('click', function () {
        if (!on && !arm().ok) return;
        picking = picking === k ? null : k;
        readout();
        if (picking) say('Scale zones: click the part to ' + (k === 'keep' ? 'keep' : 'scale') + ' - Shift-click for a plain box, Esc to stop');
      });
      $('btn-scale-zones-kind-' + k).addEventListener('click', function () { if (sel != null) edit(sel, { kind: k }); });
    });
    ['box', 'cyl'].forEach(function (k) {
      $('btn-scale-zones-shape-' + k).addEventListener('click', function () { if (sel != null) edit(sel, { shape: k }); });
    });
    [0, 1, 2].forEach(function (a) {
      $('btn-scale-zones-axis-' + a).addEventListener('click', function () { if (sel != null) edit(sel, { axis: a }); });
    });
    ['join', 'centre', 'base'].forEach(function (k) {
      $('btn-scale-zones-anchor-' + k).addEventListener('click', function () { anchor = k; dirty = true; readout(); });
    });
    var keys = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); set(); }
      else if (e.key === 'Escape' && on) { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    ['all', 'x', 'y', 'z'].forEach(function (k) {
      var bx = $('scale-zones-' + k), sl = $('scale-zones-' + k + '-slider');
      bx.addEventListener('input', function () { if (sl) sl.value = bx.value; dirty = true; });
      if (sl) sl.addEventListener('input', function () { bx.value = sl.value; dirty = true; });
      bx.addEventListener('keydown', keys);
      if (sl) sl.addEventListener('keydown', keys);
    });
    var pa = $('scale-zones-peraxis');
    pa.addEventListener('change', function () {
      perAxis = pa.checked;
      if (perAxis) { var a = $('scale-zones-all').value; ['x', 'y', 'z'].forEach(function (k) { $('scale-zones-' + k).value = a; $('scale-zones-' + k + '-slider').value = a; }); }
      dirty = true; readout();
    });
    var bl = $('scale-zones-blend');
    bl.addEventListener('input', function () { dirty = true; });
    bl.addEventListener('keydown', keys);
    /* the picked zone's sizes and centre, by number */
    [0, 1, 2].forEach(function (i) {
      var bx = $('scale-zones-size' + i);
      bx.addEventListener('change', function () {
        var z = stored(sel), v = toMm(bx.value);
        if (!z || !(v > 0)) { renderList(); return; }
        if (z.shape === 'cyl') { if (i === 0) edit(sel, { r: v / 2 }); else if (i === 1) edit(sel, { hl: v / 2 }); }
        else { var h = z.h.slice(); h[i] = v / 2; edit(sel, { h: h }); }
      });
    });
    ['x', 'y', 'z'].forEach(function (k, j) {
      var bx = $('scale-zones-c' + k);
      bx.addEventListener('change', function () {
        var z = stored(sel), v = toMm(bx.value);
        if (!z || !isFinite(v)) { renderList(); return; }
        var c = z.c.slice(); c[j] = v; edit(sel, { c: c });
      });
    });
    $('btn-scale-zones-delete').addEventListener('click', function () { if (sel != null) remove(sel); });
    /* the card's own rows and Feature size: one preview at a time */
    var rows = $('scale-rows');
    if (rows) ['focusin', 'input'].forEach(function (t) { rows.addEventListener(t, function () { if (on) cancel(true); }, true); });
    var fb = $('btn-scale-feature');
    if (fb) fb.addEventListener('click', function () { if (on) cancel(true); }, true);
    var inBtn = $('btn-scale-unit-in');
    if (inBtn && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { renderList(); dirty = true; readout(); }).observe(inBtn, { attributes: true, attributeFilter: ['aria-pressed'] });
    }
    var menu = $('menu-scale');
    if (menu) menu.addEventListener('toggle', function () { if (!menu.open) cancel(true); });
    resetFactors();
    readout();
  }

  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', function () { if (drag) endDrag(false); down = null; }, true);
  window.addEventListener('keydown', onKey, true);

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('scale-zones', {
    live: function () { return on; },
    close: function () { cancel(true); },
    clear: function () { clearZones(); clearResult(); }
  });

  /* For the drive check: the same paths the controls run. */
  window.nsoScaleZones = {
    arm: arm, cancel: cancel, set: set, add: function (z) { return on ? add(z) : null; }, remove: remove, select: select, edit: edit,
    placeOnTri: placeOnTri,
    setScale: function (f) {
      if (typeof f === 'number') { perAxis = false; $('scale-zones-all').value = String(f * 100); }
      else { perAxis = true; ['x', 'y', 'z'].forEach(function (k, i) { $('scale-zones-' + k).value = String(f[i] * 100); }); }
      dirty = true; readout(); return true;
    },
    setAnchor: function (a) { anchor = a; dirty = true; return anchor; },
    setBlend: function (mm) { $('scale-zones-blend').value = String(mm); dirty = true; },
    refresh: function () { if (on) recompute(); return !!(last && last.ok); },
    on: function () { return on; },
    info: function () {
      if (!on) return null;
      if (dirty) recompute();
      return {
        modelId: m.id, zones: zones.map(SZ.copy), sel: sel, picking: picking, anchor: anchor, perAxis: perAxis, factor: factorNow(), blend: blendNow(),
        ok: !!(last && last.ok), reason: last && !last.ok ? last.reason : null,
        parts: last && last.parts ? last.parts.map(function (p) { return { pivot: p.pivot, verts: p.verts, lo: p.lo, hi: p.hi, newLo: p.newLo, newHi: p.newHi, anchor: p.anchor }; }) : null,
        drawn: { zones: objs.fills.length, handles: objs.handles.length, result: !!objs.result },
        readout: ($('scale-zones-readout') || {}).textContent, note: ($('scale-zones-note') || {}).textContent
      };
    },
    /** Where on the page (client pixels) a picked zone's handle or a zone's centre is, for a real press. */
    screenOf: function (id, handle) {
      var z = zoneById(id);
      if (!z || !mesh) return null;
      state.camera.updateMatrixWorld();
      var raw = z.c;
      if (handle) { var h = handlesOf(z).find(function (q) { return q.id === handle; }); if (!h) return null; raw = h.raw; }
      return screenOf(worldOfRaw(raw));
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
