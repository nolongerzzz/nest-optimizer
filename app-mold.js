/* app-mold.js - Gen+ -> Mold: a two-piece interlocking silicone mold from the
   selected piece. Thin on purpose, as app-stock.js and app-lift-plate.js are:
   every number and every solid comes from nso_mold.js (THREE-free, node-tested
   by tools/nso_mold_test.js), which in turn does its booleans and its split
   with the engines already shipped - Subtract and Union (app-join.js) and the
   Cut engine's clean split (app-cut.js). What is here is what only the page can
   do: read the piece as it lies on the plate, draw the blade, the tint and the
   pour marker, take a click, and put two pieces on the plate with one Undo.
   docs/MOLD.md.

   THE CARD IS THE SWITCH. Open Gen+ and Mold and the piece selected on the
   plate is the one a mold is being made of; shut either and every helper goes.
   The selection moving to another piece retargets the card.

   THE PIECE AS IT LIES. The mold orientation is the piece's own pose on the
   plate (the Rotate / Tip / Tilt tools do the orienting); the world soup read
   here is the piece's geometry through its mesh's matrixWorld, a mirrored pose
   (flipX) included. Nothing here turns, moves or edits the piece.

   THE BLADE is the Cut card's: a slider, the <- number -> row, the dial, in the
   same classes. The Cut card's blade stands across a piece's length, so its
   dial (a heading about the vertical) means nothing to a flat plane; here the
   plane is flat to start and the dial says which way it leans, with Tilt for
   how far.

   PAINT SCOPE: NONE - it reads the piece's geometry and writes no face of it.
   It adds two pieces and edits none (docs/HANDOFF.md, Scoping). */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function M() { return window.NSO_Mold; }
  function f1(v) { return (Math.round(v * 10) / 10).toFixed(1); }

  var BLADE = 0xffc83d;          // the Cut card's blade colour
  var FILL = 0x101010;
  var LOCK = 0xff7a00;
  var POUR = 0x38bdf8;
  var VENT = 0x4ade80;
  var BLOCK = 0x94a3b8;
  var ORDER = 22;                // after the pieces, so the sheet tints them
  var SIDE = { '+y': 'top', '+x': '+X side', '-x': '\u2212X side', '+z': '+Z side', '-z': '\u2212Z side' };

  var S = {
    armed: false,
    targetId: null,
    mm: null,              // wanted plane height; null = mid-height
    tilt: 0,
    heading: 0,
    pour: null,            // a clicked point on the piece, world [x, y, z]
    plan: null,
    soup: null,
    sig: '',
    cache: {},
    busy: false,
    pair: null,            // { ids: [idA, idB], srcId }
    timer: null,
    lastNote: ''
  };

  /* ---------------------------------------------------------- the card */
  function num(id) {
    var el = $(id), v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : undefined;
  }

  function planOpts() {
    return {
      mm: S.mm, tiltDeg: S.tilt, headingDeg: S.heading,
      wallMm: num('mold-wall'), capMm: num('mold-cap'),
      keyDiaMm: num('mold-key-dia'), keyHeightMm: num('mold-key-h'),
      pour: S.pour
    };
  }

  /* The machine the user is pointed at, as {w, d, h}. */
  function printer() {
    var p = (typeof NSO_fitCurrentPrinter === 'function') ? NSO_fitCurrentPrinter() : null;
    return p ? { w: p.bedX, d: p.bedY, h: p.buildZ } : null;
  }

  /* ----------------------------------------------- reading the piece */
  function entryOf(id) {
    return (state.placed || []).find(function (p) { return p && p.sourceId === id && p.mesh; }) || null;
  }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }

  function targetEntry() {
    var i = state.selectedIndex, p = (i >= 0 && state.placed) ? state.placed[i] : null;
    if (p && p.mesh && p.sourceId != null && modelOf(p.sourceId)) return p;
    if (state.editId != null) {
      p = entryOf(state.editId);
      if (p && modelOf(p.sourceId)) return p;
    }
    return null;
  }

  /* The piece in world coordinates, faces out. */
  function worldSoup(entry) {
    var mesh = entry.mesh;
    mesh.updateMatrixWorld(true);
    var g = mesh.geometry, pos = g.attributes.position, idx = g.index, e = mesh.matrixWorld.elements;
    var n = idx ? idx.count : pos.count, out = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var v = idx ? idx.getX(i) : i, x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      out[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return mesh.matrixWorld.determinant() < 0 ? M().flipWinding(out) : out;
  }

  function signature(entry) {
    var mesh = entry.mesh, g = mesh.geometry;
    mesh.updateMatrixWorld(true);
    var pos = g.attributes.position;
    var pl = printer();
    return [entry.sourceId, mesh.uuid, g.uuid, pos ? pos.count + ':' + pos.version : '',
      mesh.matrixWorld.elements.map(function (v) { return v.toFixed(3); }).join(','),
      pl ? pl.w + 'x' + pl.d + 'x' + pl.h : ''].join('|');
  }

  /* ------------------------------------------------------ the helpers */
  var layer = null;
  function ensureLayer() {
    if (!state.scene || typeof THREE === 'undefined') return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'mold'; layer.renderOrder = ORDER; }
    if (layer.parent !== state.scene) {
      if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, layer, 'mold');
      else state.scene.add(layer);
    }
    return layer;
  }
  function clearLayer() {
    if (!layer) return;
    for (var i = layer.children.length - 1; i >= 0; i--) {
      var c = layer.children[i];
      layer.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }
  function over(o) {
    o.renderOrder = ORDER;
    o.userData.skipXray = true;
    return o;
  }
  function lineMat(color, opacity) {
    return new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity, depthTest: false, depthWrite: false });
  }
  function fillMat(color, opacity, test) {
    return new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity, side: THREE.DoubleSide,
      depthTest: !!test, depthWrite: false, polygonOffset: !!test, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  function segs(arr, color, opacity) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return over(new THREE.LineSegments(g, lineMat(color, opacity)));
  }

  /* The corners of the plane's section through the block, in order round. */
  function sectionPolygon(block, plane) {
    var pts = [], n = plane.n, mn = block.min, mx = block.max, a, b, c;
    var X = [mn[0], mx[0]], Y = [mn[1], mx[1]], Z = [mn[2], mx[2]];
    function d(p) { return n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - plane.c; }
    function edge(p, q) {
      var dp = d(p), dq = d(q);
      if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
        var t = dp / (dp - dq);
        pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
      } else if (dp === 0) pts.push(p.slice());
    }
    for (a = 0; a < 2; a++) for (b = 0; b < 2; b++) {
      edge([X[a], Y[b], Z[0]], [X[a], Y[b], Z[1]]);
      edge([X[a], Y[0], Z[b]], [X[a], Y[1], Z[b]]);
      edge([X[0], Y[a], Z[b]], [X[1], Y[a], Z[b]]);
    }
    if (pts.length < 3) return [];
    var cx = 0, cy = 0, cz = 0;
    pts.forEach(function (p) { cx += p[0]; cy += p[1]; cz += p[2]; });
    cx /= pts.length; cy /= pts.length; cz /= pts.length;
    var h = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var u = [n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]];
    var ul = Math.hypot(u[0], u[1], u[2]); u = [u[0] / ul, u[1] / ul, u[2] / ul];
    var v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    pts.sort(function (p, q) {
      function ang(r) {
        var dx = r[0] - cx, dy = r[1] - cy, dz = r[2] - cz;
        return Math.atan2(dx * v[0] + dy * v[1] + dz * v[2], dx * u[0] + dy * u[1] + dz * u[2]);
      }
      return ang(p) - ang(q);
    });
    return pts;
  }

  function cylinderBetween(from, to, r, color, opacity) {
    var a = new THREE.Vector3(from[0], from[1], from[2]), b = new THREE.Vector3(to[0], to[1], to[2]);
    var len = a.distanceTo(b);
    var g = new THREE.CylinderGeometry(r, r, len, 24, 1, false);
    var m = new THREE.Mesh(g, fillMat(color, opacity, false));
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return over(m);
  }

  function draw() {
    if (!ensureLayer()) return;
    clearLayer();
    layer.visible = S.armed;
    var pl = S.plan;
    if (!S.armed || !pl) return;

    var b = pl.block, i;
    var e = [], X = [b.min[0], b.max[0]], Y = [b.min[1], b.max[1]], Z = [b.min[2], b.max[2]];
    for (i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
      e.push(X[0], Y[i], Z[j], X[1], Y[i], Z[j]);
      e.push(X[i], Y[0], Z[j], X[i], Y[1], Z[j]);
      e.push(X[i], Y[j], Z[0], X[i], Y[j], Z[1]);
    }
    var box = segs(e, BLOCK, 0.55); box.name = 'moldBlock'; layer.add(box);

    var poly = sectionPolygon(b, pl.plane);
    if (poly.length >= 3) {
      var fp = [], lp = [];
      for (i = 1; i + 1 < poly.length; i++) {
        fp.push(poly[0][0], poly[0][1], poly[0][2], poly[i][0], poly[i][1], poly[i][2], poly[i + 1][0], poly[i + 1][1], poly[i + 1][2]);
      }
      var fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
      var sheet = over(new THREE.Mesh(fg, fillMat(FILL, 0.38, false))); sheet.name = 'moldBlade'; layer.add(sheet);
      poly.forEach(function (p, k) {
        var q = poly[(k + 1) % poly.length];
        lp.push(p[0], p[1], p[2], q[0], q[1], q[2]);
      });
      var frame = segs(lp, BLADE, 1); frame.name = 'moldBladeFrame'; layer.add(frame);
    }

    // the four keys, as rings on the blade
    if (pl.keys && pl.keys.places) {
      var rings = [], n = pl.plane.n;
      var h = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      var u = new THREE.Vector3(n[0], n[1], n[2]).cross(new THREE.Vector3(h[0], h[1], h[2])).normalize();
      var v = new THREE.Vector3(n[0], n[1], n[2]).cross(u).normalize();
      pl.keys.places.forEach(function (p) {
        var r = pl.keys.shape.rb;
        for (var k = 0; k < 24; k++) {
          var a0 = (2 * Math.PI * k) / 24, a1 = (2 * Math.PI * (k + 1)) / 24;
          rings.push(p.o[0] + (u.x * Math.cos(a0) + v.x * Math.sin(a0)) * r, p.o[1] + (u.y * Math.cos(a0) + v.y * Math.sin(a0)) * r,
            p.o[2] + (u.z * Math.cos(a0) + v.z * Math.sin(a0)) * r,
            p.o[0] + (u.x * Math.cos(a1) + v.x * Math.sin(a1)) * r, p.o[1] + (u.y * Math.cos(a1) + v.y * Math.sin(a1)) * r,
            p.o[2] + (u.z * Math.cos(a1) + v.z * Math.sin(a1)) * r);
        }
      });
      var keys = segs(rings, BLADE, pl.keys.ok ? 0.9 : 0.35); keys.name = 'moldKeys'; layer.add(keys);
    }

    // the faces that would lock, tinted on the piece
    if (pl.lock && pl.lock.tris.length) {
      var lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(pl.lock.tris, 3));
      var tint = over(new THREE.Mesh(lg, fillMat(LOCK, 0.7, true))); tint.name = 'moldLock'; layer.add(tint);
    }

    // the sprue, the vent, and the pour marker
    if (pl.pour && pl.pour.ok) {
      var ch = pl.pour.ch;
      var sp = cylinderBetween(ch.from, ch.to, ch.r, POUR, 0.3); sp.name = 'moldSprue'; layer.add(sp);
      var mk = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 12), fillMat(POUR, 1, false));
      mk.position.set(pl.pour.point[0], pl.pour.point[1], pl.pour.point[2]);
      over(mk); mk.name = 'moldPourMarker'; layer.add(mk);
    }
    if (pl.vent && pl.vent.ok) {
      var vc = pl.vent.ch;
      var vt = cylinderBetween(vc.from, vc.to, vc.r, VENT, 0.35); vt.name = 'moldVent'; layer.add(vt);
    }
  }

  /* ------------------------------------------------------ the plan view */
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(name, attrs) {
    var el = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function drawPlan() {
    var svg = $('mold-plan');
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var pl = S.plan;
    if (!pl) return;
    var b = pl.block, W = 120, H = 76, pad = 4;
    var k = Math.min((W - 2 * pad) / b.size[0], (H - 2 * pad) / b.size[2]);
    var ox = W / 2 - ((b.min[0] + b.max[0]) / 2) * k, oz = H / 2 - ((b.min[2] + b.max[2]) / 2) * k;
    function X(x) { return ox + x * k; }
    function Z(z) { return oz + z * k; }
    svg.appendChild(svgEl('rect', { class: 'p-block', x: X(b.min[0]), y: Z(b.min[2]), width: b.size[0] * k, height: b.size[2] * k }));
    var pb = pl.bounds;
    svg.appendChild(svgEl('rect', { class: 'p-piece', x: X(pb.min[0]), y: Z(pb.min[2]), width: pb.size[0] * k, height: pb.size[2] * k }));
    (pl.keys ? pl.keys.places : []).forEach(function (p) {
      svg.appendChild(svgEl('circle', { class: 'p-key', cx: X(p.o[0]), cy: Z(p.o[2]), r: Math.max(1.5, pl.keys.shape.rb * k) }));
    });
    if (pl.vent && pl.vent.ok) {
      var vp = pl.vent.point;
      var vc = svgEl('circle', { id: 'mold-plan-vent', class: 'p-vent', cx: X(vp[0]), cy: Z(vp[2]), r: Math.max(1.8, pl.vent.ch.r * k) });
      vc.setAttribute('data-x', vp[0].toFixed(2)); vc.setAttribute('data-z', vp[2].toFixed(2));
      svg.appendChild(vc);
      svg.appendChild(svgEl('text', { x: X(vp[0]) + 3, y: Z(vp[2]) - 3 })).textContent = 'vent';
    }
    if (pl.pour && pl.pour.ok) {
      var pp = pl.pour.point, ex = pl.pour.ch.to;
      if (Math.abs(ex[0] - pp[0]) > 0.01 || Math.abs(ex[2] - pp[2]) > 0.01) {
        svg.appendChild(svgEl('line', { x1: X(pp[0]), y1: Z(pp[2]), x2: X(ex[0]), y2: Z(ex[2]), stroke: '#38bdf8', 'stroke-width': Math.max(1, pl.pour.ch.r * 2 * k) , 'stroke-opacity': 0.35 }));
      }
      var pc = svgEl('circle', { id: 'mold-plan-pour', class: 'p-pour', cx: X(pp[0]), cy: Z(pp[2]), r: Math.max(2.2, pl.pour.ch.r * k) });
      pc.setAttribute('data-x', pp[0].toFixed(2)); pc.setAttribute('data-z', pp[2].toFixed(2));
      svg.appendChild(pc);
      svg.appendChild(svgEl('text', { x: X(pp[0]) + 3, y: Z(pp[2]) - 3 })).textContent = 'pour';
    }
  }

  /* ------------------------------------------------------------- sync */
  function livePair() {
    if (!S.pair) return null;
    var ok = S.pair.ids.every(function (id) { return modelOf(id) && entryOf(id); });
    return ok ? S.pair : null;
  }

  function syncDial() {
    var deg = S.heading;
    var turn = $('mold-dial-turn');
    if (turn) turn.setAttribute('transform', 'rotate(' + deg + ' 50 50)');
    var text = $('mold-dial-deg');
    if (text) text.textContent = deg + '°';
    var dial = $('mold-dial');
    if (dial) dial.setAttribute('aria-valuenow', String(deg));
    var input = $('mold-heading');
    if (input && document.activeElement !== input) input.value = String(deg);
    var tilt = $('mold-tilt');
    if (tilt && document.activeElement !== tilt) tilt.value = String(S.tilt);
  }

  function sync() {
    syncDial();
    var pl = S.plan, ent = S.armed ? targetEntry() : null;
    var slider = $('mold-slider'), mmEl = $('mold-mm');
    var status = $('mold-status'), lockEl = $('mold-lock'), pourEl = $('mold-pour'), readout = $('mold-readout');
    var btn = $('btn-mold-make');
    if (!S.armed || !pl || !ent) {
      if (status) status.textContent = 'Select a piece, then open Mold.';
      if (lockEl) { lockEl.textContent = '—'; lockEl.classList.remove('is-lock'); }
      if (pourEl) pourEl.textContent = '—';
      if (readout) readout.textContent = '';
      if (btn) btn.disabled = true;
      drawPlan();
      return;
    }
    var m = modelOf(ent.sourceId), pn = pl.plane;
    if (status) {
      status.textContent = '"' + (m ? m.name : 'piece') + '" - block ' + f1(pl.block.size[0]) + ' \u00d7 ' + f1(pl.block.size[2]) +
        ' \u00d7 ' + f1(pl.block.size[1]) + ' mm';
      status.title = 'The piece is ' + f1(pl.bounds.size[0]) + ' \u00d7 ' + f1(pl.bounds.size[2]) + ' \u00d7 ' + f1(pl.bounds.size[1]) +
        ' mm; the mold block around it, X \u00d7 Z \u00d7 height.';
    }
    if (slider) { slider.min = String(pn.lo); slider.max = String(pn.hi); slider.step = '0.1'; slider.value = pn.mm.toFixed(1); }
    if (mmEl) {
      mmEl.min = String(pn.lo); mmEl.max = String(pn.hi);
      if (document.activeElement !== mmEl) mmEl.value = pn.mm.toFixed(1);
    }
    var area = pl.lock.areaMm2;
    if (lockEl) {
      lockEl.textContent = Math.round(area) + ' mm² would lock';
      lockEl.classList.toggle('is-lock', area >= 0.5);
    }
    if (pourEl) {
      if (pl.pour && pl.pour.ok) {
        var pp = pl.pour.point;
        pourEl.textContent = 'Pour ' + (pl.pour.auto ? 'at the highest point' : 'where you clicked') + ': sprue ' + f1(pl.pour.lengthMm) +
          ' mm to the ' + SIDE[pl.pour.dir] + '.' + (pl.vent && pl.vent.ok ? '' : ' No vent.') + ' Click the piece to move it.';
        pourEl.title = 'Pour point (' + f1(pp[0]) + ', ' + f1(pp[1]) + ', ' + f1(pp[2]) + ') mm';
      } else pourEl.textContent = (pl.pour && pl.pour.reason) || '\u2014';
    }
    if (readout) {
      var lines = pl.refusals.concat(pl.warnings);
      readout.textContent = lines.join(' ');
      readout.style.color = pl.refusals.length ? '' : '#fbbf24';
    }
    if (btn) {
      btn.disabled = !pl.ok || S.busy;
      btn.textContent = livePair() ? 'Regenerate mold' : 'Generate mold';
    }
    drawPlan();
  }

  /* ---------------------------------------------------------- refresh */
  function resetForNewPiece() {
    S.mm = null; S.tilt = 0; S.heading = 0; S.pour = null; S.soup = null; S.cache = {}; S.sig = '';
  }

  /* Read the piece, plan, redraw. force re-reads the piece; otherwise only a
     changed piece (moved, turned, rebuilt, another plate) is read again. */
  function refresh(force) {
    if (!S.armed) { clearLayer(); if (layer) layer.visible = false; return S.plan; }
    var ent = targetEntry();
    if (!ent) {
      S.targetId = null; S.plan = null; S.soup = null; S.sig = '';
      draw(); sync();
      return null;
    }
    var changed = false;
    if (ent.sourceId !== S.targetId) {
      resetForNewPiece();
      S.targetId = ent.sourceId;
      changed = true;
    }
    var sig = signature(ent), moved = !!S.sig && sig !== S.sig;
    if (force || changed || moved || !S.soup) {
      S.soup = worldSoup(ent); S.cache = {};
      if (moved) S.pour = null;            // a clicked spot belongs to the piece as it was
    }
    S.sig = sig;
    S.plan = M().plan(S.soup, planOpts(), { printer: printer(), cache: S.cache });
    if (S.mm != null) S.mm = S.plan.plane.mm;
    draw(); sync();
    if (changed) {
      var m = modelOf(ent.sourceId);
      say('Mold: "' + (m ? m.name : 'piece') + '" - slide or tilt the blade, then Generate mold. Click the piece to move the pour point.');
    }
    return S.plan;
  }

  /* The piece moved, was turned or rebuilt, or another plate was picked, or the
     selection went elsewhere: read it again. Nothing else costs anything. */
  function tick() {
    if (!S.armed || S.busy) return;
    var ent = targetEntry();
    if (!ent) { if (S.targetId != null || S.plan) refresh(true); return; }
    if (ent.sourceId !== S.targetId || signature(ent) !== S.sig) refresh(false);
  }

  /* ------------------------------------------------------ the controls */
  function setMm(v) {
    v = parseFloat(v);
    if (!isFinite(v)) return;
    S.mm = v;
    refresh(false);
  }
  function setTilt(v) {
    v = parseFloat(v);
    S.tilt = isFinite(v) ? Math.max(0, Math.min(60, v)) : 0;
    refresh(false);
  }
  function setHeading(v) {
    v = Math.round(parseFloat(v));
    S.heading = isFinite(v) ? ((v % 360) + 360) % 360 : 0;
    refresh(false);
  }
  function nudge(dir, shift) {
    if (!S.plan) return;
    setMm(S.plan.plane.mm + dir * (shift ? 1 : 0.1));
  }

  function wireDial() {
    var dial = $('mold-dial');
    if (!dial || dial.dataset.nsoWired === '1') return;
    dial.dataset.nsoWired = '1';
    var dragging = false;
    function degAt(ev) {
      var r = dial.getBoundingClientRect();
      var dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * 0.18) return null;     // the centre is the readout, not the rail
      return Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
    }
    dial.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      var d = degAt(ev);
      if (d == null) return;
      dragging = true;
      if (dial.setPointerCapture) { try { dial.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ } }
      setHeading(d);
      ev.preventDefault(); ev.stopPropagation();
    });
    dial.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var d = degAt(ev);
      if (d != null) setHeading(d);
    });
    var stop = function () { dragging = false; };
    dial.addEventListener('pointerup', stop);
    dial.addEventListener('pointercancel', stop);
    dial.addEventListener('keydown', function (ev) {
      var step = ev.shiftKey ? 15 : 1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') setHeading(S.heading + step);
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') setHeading(S.heading - step);
      else if (ev.key === 'Home' || ev.key === '0') setHeading(0);
      else return;
      ev.preventDefault(); ev.stopPropagation();
    });
  }

  /* ---------------------------------------------------------- the click */
  function hitTarget(ev) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    var rect = state.renderer.domElement.getBoundingClientRect();
    var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1, ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
    var hits = rc.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx !== 'number' || !state.placed[idx]) continue;
      return state.placed[idx].sourceId === S.targetId ? hits[i] : null;      // the first piece struck, or none
    }
    return null;
  }

  /* Move the pour point to `p` (world [x, y, z] on the piece). The sprue goes
     straight to the nearest outer face it can reach; a spot it cannot serve is
     refused in words and the pour stays where it was. */
  function setPour(p) {
    if (!S.armed || !S.soup) return { ok: false, reason: 'Mold is not open on a piece' };
    var trial = M().plan(S.soup, Object.assign(planOpts(), { pour: p }), { printer: printer(), cache: S.cache });
    if (trial.pour && trial.pour.ok && !trial.pour.auto) {
      S.pour = p.slice();
      S.plan = trial;
      draw(); sync();
      var pp = trial.pour.point;
      say('Mold: pour moved to (' + f1(pp[0]) + ', ' + f1(pp[1]) + ', ' + f1(pp[2]) + ') - the sprue runs ' + f1(trial.pour.lengthMm) +
        ' mm straight to the ' + SIDE[trial.pour.dir] + '.');
      return { ok: true, plan: trial };
    }
    var why = (trial.pour && (trial.pour.note || trial.pour.reason)) || 'No sprue reaches the outside from there.';
    say('Mold: ' + why, true);
    return { ok: false, reason: why };
  }
  function resetPour() {
    S.pour = null;
    refresh(false);
    say('Mold: pour back at the highest point.');
  }

  window.nsoMoldTakesClick = function (event) {
    if (!S.armed || S.busy || S.targetId == null || !S.soup) return false;
    if (event.button !== 0) return false;
    var hit = hitTarget(event);
    if (!hit) return false;
    setPour([hit.point.x, hit.point.y, hit.point.z]);
    return true;
  };

  /* --------------------------------------------------------- generate */
  function toRaw(w) {
    var o = new Float32Array(w.length);
    for (var i = 0; i < w.length; i += 3) { o[i] = w[i]; o[i + 1] = -w[i + 2]; o[i + 2] = w[i + 1]; }
    return o;
  }

  function takeOff(ids) {
    var drop = new Set(ids), removed = [];
    state.placed.forEach(function (p, i) { if (p && drop.has(p.sourceId)) removed.push({ placed: p, placedIndex: i }); });
    removed.forEach(function (r) {
      r.model = modelOf(r.placed.sourceId);
      r.modelIndex = state.models.indexOf(r.model);
    });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    return removed;
  }

  function kernel() {
    return {
      subtract: function (a, b) { return NSO_subtractSoups(a, b); },
      union: function (a, b) { return NSO_unionSoups(a, b); },
      cutSide: function (soup, axisIdx, plane, keepMin) { return cutOneSide(soup, axisIdx, plane, keepMin); }
    };
  }

  async function generate() {
    if (S.busy) return { ok: false, reason: 'busy' };
    var ent = S.armed ? targetEntry() : null;
    if (!ent) { say('Mold: select a piece and open Mold first', true); return { ok: false, reason: 'no piece' }; }
    refresh(true);
    var pl = S.plan;
    if (!pl || !pl.ok) {
      var why = pl ? pl.refusals[0] : 'nothing to build';
      say('Mold refused - nothing made. ' + why, true);
      return { ok: false, reason: why, refusals: pl ? pl.refusals : [] };
    }
    if (typeof NSO_subtractSoups !== 'function' || typeof NSO_unionSoups !== 'function' || typeof cutOneSide !== 'function') {
      say('Mold needs the Subtract / Join and Cut engines (app-join.js, app-cut.js)', true);
      return { ok: false, reason: 'engines missing' };
    }
    var tid = ent.sourceId, src = modelOf(tid), srcName = src ? src.name : 'piece';
    S.busy = true; sync();
    say('Mold: building - the block, the cavity, the split and the keys ...');
    var r;
    try {
      r = await M().build(S.soup, pl, kernel());
    } catch (err) {
      r = { ok: false, reason: 'Mold failed (' + ((err && err.message) || err) + ')' };
    }
    try {
      if (!r.ok) {
        say('Mold refused - nothing made. ' + r.reason, true);
        return { ok: false, reason: r.reason, stage: r.stage };
      }
      // the target may have changed while the kernel ran
      var ent2 = entryOf(tid);
      if (!ent2) { say('Mold: the piece went away while the mold was being built - nothing made', true); return { ok: false, reason: 'piece gone' }; }

      // a pair from the last Generate is replaced; its places are taken over
      var old = livePair(), oldPlaces = null, removed = [];
      if (old && old.srcId === tid) {
        oldPlaces = old.ids.map(function (id) { var p = entryOf(id); return { x: p.x, z: p.z }; });
        removed = takeOff(old.ids);
      }
      var names = [srcName + ' mold A', srcName + ' mold B'], halves = [r.A, r.B], ids = [];
      for (var i = 0; i < 2; i++) {
        var raw = toRaw(halves[i]);
        var id = addModel(names[i], rawResultToDisplayGeometry(raw), {
          rawTris: raw, rawAxis: 'zup', centerOffset: computeCenterOffsetFromRaw(raw), keepSelection: true, silent: true });
        if (id == null) {
          takeOff(ids);
          say('Mold refused - nothing made: half ' + (i ? 'B' : 'A') + ' is too small to be a piece', true);
          return { ok: false, reason: 'half too small' };
        }
        ids.push(id);
      }
      var near = { x: ent2.x + (ent2.width || 0) / 2 + pl.block.size[0] / 2 + 6, z: ent2.z };
      var spots = [];
      [1, 0].forEach(function (k) {                       // B first, then A beside it
        var made = modelOf(ids[k]), entry = placeModelMovable(made, near.x, near.z);
        if (!entry) return;
        var at;
        if (oldPlaces) at = { x: oldPlaces[k].x, z: oldPlaces[k].z, onBed: true };
        else at = nsoFreeSpot(entry, near);
        applyPlacedXZ(entry, at.x, at.z);
        if (typeof refreshOutline === 'function') refreshOutline(entry);
        spots[k] = at;
      });
      var prevPair = old;
      S.pair = { ids: ids.slice(), srcId: tid };
      pushUndo({ type: 'featureSwap', replace: null, addedIds: ids.slice(), removed: removed,
        label: 'Undo: mold removed',
        onUndone: function () {
          S.pair = (prevPair && prevPair.ids.every(function (x) { return modelOf(x); })) ? prevPair : null;
          refresh(true);
        } });
      var srcIdx = state.placed.indexOf(entryOf(tid));
      if (srcIdx >= 0 && typeof selectPlaced === 'function') selectPlaced(srcIdx);
      if (typeof renderModelList === 'function') renderModelList();
      if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
      if (typeof updateEditSize === 'function') updateEditSize();
      if (typeof updateAdjustUI === 'function') updateAdjustUI();

      var st = r.stats, off = spots.filter(function (s) { return s && !s.onBed; }).length;
      var txt = 'Mold: "' + names[0] + '" and "' + names[1] + '" are on the plate beside "' + srcName + '", open, parting face up' +
        ' (cavity ' + Math.round(st.cavityMm3) + ' mm³ = piece ' + Math.round(st.pieceMm3) + ' + sprue and vent; both halves closed and manifold).' +
        ' ' + Math.round(pl.lock.areaMm2) + ' mm² would lock. One Undo removes both; the piece is untouched.';
      if (off) txt += ' ' + off + ' did not fit on the bed and sit beside it, clear of every piece.';
      say(txt, off > 0);
      return { ok: true, ids: ids.slice(), names: names, stats: st, plan: pl, spots: spots, replaced: !!old, reason: txt };
    } catch (err) {
      console.error('[mold]', err);
      say('Mold failed - nothing changed (' + ((err && err.message) || err) + ')', true);
      return { ok: false, reason: String((err && err.message) || err) };
    } finally {
      S.busy = false;
      refresh(true);
    }
  }

  /* ------------------------------------------------------ arm / disarm */
  function cardOpen() {
    var mold = $('menu-mold');
    if (!mold || !mold.open) return false;
    for (var n = mold.parentElement; n; n = n.parentElement) if (n.tagName === 'DETAILS' && !n.open) return false;
    return true;
  }

  function setArmed(on) {
    on = !!on;
    if (on === S.armed) return;
    S.armed = on;
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    if (!on) {
      clearLayer();
      if (layer) layer.visible = false;
      S.targetId = null; S.soup = null; S.plan = null; S.sig = '';
      sync();
      say('Mold off.');
      return;
    }
    S.timer = setInterval(tick, 250);
    refresh(true);
    if (!S.plan) say('Mold: select a piece first - it is the piece as it lies that the mold is made of.');
  }

  function watchCard() {
    function check() { setArmed(cardOpen()); }
    if (typeof MutationObserver === 'function') {
      new MutationObserver(check).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] });
    }
    document.addEventListener('toggle', check, true);
    check();
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('mold', {
    live: function () { return S.armed; },
    close: function () { var m = $('menu-mold'); if (m) m.open = false; setArmed(false); },
    clear: clearLayer,
    refresh: function () { refresh(true); }
  });

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    bind('mold-slider', 'input', function () { setMm($('mold-slider').value); });
    bind('mold-mm', 'change', function () { setMm($('mold-mm').value); });
    bind('btn-mold-nudge-m', 'click', function (e) { nudge(-1, e.shiftKey); });
    bind('btn-mold-nudge-p', 'click', function (e) { nudge(1, e.shiftKey); });
    bind('mold-heading', 'change', function () { setHeading($('mold-heading').value); });
    bind('mold-tilt', 'input', function () { setTilt($('mold-tilt').value); });
    bind('mold-tilt', 'change', function () { setTilt($('mold-tilt').value); });
    ['mold-wall', 'mold-cap', 'mold-key-dia', 'mold-key-h'].forEach(function (id) {
      bind(id, 'input', function () { refresh(false); });
      bind(id, 'change', function () { refresh(false); });
    });
    bind('btn-mold-pour-reset', 'click', resetPour);
    bind('btn-mold-make', 'click', function () { generate(); });
    wireDial();
    watchCard();
    sync();
  }

  window.nsoMold = {
    armed: function () { return S.armed; },
    target: function () { return S.targetId; },
    plan: function () { return S.plan; },
    soup: function () { return S.soup; },
    refresh: function () { return refresh(true); },
    setMm: setMm, setTilt: setTilt, setHeading: setHeading, setPour: setPour, resetPour: resetPour,
    generate: generate,
    pair: function () { var p = livePair(); return p ? { ids: p.ids.slice(), srcId: p.srcId } : null; },
    layer: function () { return layer; },
    busy: function () { return S.busy; }
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})();
