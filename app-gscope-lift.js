/*
 * G-scope Features - what Lift would find on the piece under the lens.
 * READ docs/LIFT.md FIRST (section 7).
 * ----------------------------------------------------------------------------
 *
 * READ-ONLY. One section, "Features", in G-scope's sidebar, on any mesh
 * document. It shows the features Lift would find on the piece under the lens
 * - each outlined over the piece, coloured by its group - and the grouped
 * list, and nothing else: no base face to pick, nothing to lift, remove or
 * choose. Lifting is done on the plate, from the Subtract card's Lift
 * (app-lift-plate.js).
 *
 * THE SAME READ. The features are NSO_LIFT_PLATE.detectSoup's - the rolling
 * ball looking down the piece, cached per soup - so the row and the card
 * always count the same features: a plate piece is read off its raw soup in
 * the frame the card reads it in (NSO_LIFT_PLATE.viewFor); a document that is
 * not the plate is read off its own triangles, looking down its Z.
 *
 * THE PIECE UNDER THE LENS: the one object G-scope has selected; else the
 * piece selected on the plate, when G-scope shows it; else the biggest object
 * in the document.
 *
 * PAINT SCOPE: NONE - this row reads geometry and writes none.
 */
/* global THREE, state, nsoHelpers */
'use strict';

var NSO_GSCOPE_LIFT = (function () {
  var GROUP_COLOUR = { dots: 0x38bdf8, lines: 0xf59e0b, large: 0xa855f7, cant: 0xb91c1c };
  var GROUP_LABEL = { lines: 'Lines', large: 'Large shapes', dots: 'Dots', cant: 'Can\'t lift' };

  var on = true;              // the outlines shown (leave-tool switches them off)
  var cur = null;             // { o, soup, D } for the piece under the lens
  var layer = null;

  function $(id) { return document.getElementById(id); }
  function MS() { return window.NSO_MICROSCOPE; }
  function LP() { return window.NSO_LIFT_PLATE; }
  function f2(x) { return (+x).toFixed(2); }
  function meshDoc() { var d = MS() && MS().getDoc(); return d && d.kind === 'mesh' ? d : null; }
  function minH() { return LP() ? LP().minHeight() : 0.42; }

  /** The piece under the lens, or null. */
  function lensObject(d) {
    if (!d || !d.objects || !d.objects.length) return null;
    var sel = (MS().selection() || []).filter(function (o) { return o && o.positions; });
    if (sel.length === 1) return sel[0];
    var p = typeof state !== 'undefined' && state.placed ? state.placed[state.selectedIndex] : null;
    if (p && p.sourceId != null) {
      var o = d.objects.find(function (x) { return x.sourceId === p.sourceId; });
      if (o) return o;
    }
    return d.objects.reduce(function (a, b) { return !a || b.positions.length > a.positions.length ? b : a; }, null);
  }

  /** Read the piece under the lens: the card's read when it is a plate piece. */
  function read() {
    var d = meshDoc(), o = lensObject(d);
    if (!o || !LP()) { cur = null; return cur; }
    var soup = o.positions, n = [0, 0, 1];
    if (d.source === 'plate' && o.sourceId != null && typeof state !== 'undefined') {
      var m = (state.models || []).find(function (x) { return x && x.id === o.sourceId; });
      if (m && m.rawTris && m.rawAxis === 'zup' && m.rawTris.length === o.positions.length) {
        soup = m.rawTris;
        n = LP().viewFor(o.sourceId);
      }
    }
    if (cur && cur.o === o && cur.soup === soup) return cur;
    cur = { o: o, soup: soup, D: LP().detectSoup(soup, n) };
    return cur;
  }

  function A() { return cur && cur.D && cur.D.ok ? cur.D.A : null; }

  function readout() {
    if (!meshDoc()) return '—';
    if (!cur) return 'Features: nothing under the lens.';
    if (!cur.D.ok) return cur.D.reason;
    var a = A(), off = window.NSO_LiftAuto.offered(a, minH());
    var gs = LP().groups(a, minH()), n = off.length;
    var parts = [n + ' feature' + (n === 1 ? '' : 's') + ' found on ' + cur.o.name + ', standing out more than ' + f2(minH()) + ' mm' +
      (n ? ': ' + gs.list.map(LP().groupWords).join(' · ') : '') + '.'];
    if (gs.low) parts.push(gs.low + ' lower, not counted.');
    if (gs.cant) parts.push(gs.cant + ' can\'t be lifted.');
    parts.push('To lift them: Subtract → Lift, on the plate.');
    return parts.join(' ');
  }

  // =========================================================================
  // Drawing: each feature outlined in its group's colour
  // =========================================================================

  function ensureLayer() {
    var v = MS() && MS().getView();
    if (!v) return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'gscopeFeatures'; layer.renderOrder = 9; }
    if (layer.parent !== v.scene) nsoHelpers.attach(v.scene, layer, 'gscope-lift');
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

  /** The edges of `tris` only one of them uses, in G-scope's view frame. */
  function outline(P, tris) {
    var seen = new Map(), key = function (o) { return P[o].toFixed(4) + ',' + P[o + 1].toFixed(4) + ',' + P[o + 2].toFixed(4); };
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var a = t * 9 + k * 3, b = t * 9 + ((k + 1) % 3) * 3, ka = key(a), kb = key(b);
        var e = ka < kb ? ka + '|' + kb : kb + '|' + ka, s = seen.get(e);
        if (s) s.n++; else seen.set(e, { n: 1, a: a, b: b });
      }
    });
    var out = [];
    seen.forEach(function (s) {
      if (s.n !== 1) return;
      [s.a, s.b].forEach(function (o) { var q = MS().toView(P[o], P[o + 1], P[o + 2]); out.push(q.x, q.y, q.z); });
    });
    return out;
  }

  /** The features' own triangles, tinted in their group's colour. */
  function tint(P, tris, colour) {
    var pos = new Float32Array(tris.length * 9);
    tris.forEach(function (t, i) {
      for (var k = 0; k < 3; k++) {
        var q = MS().toView(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]);
        pos[i * 9 + k * 3] = q.x; pos[i * 9 + k * 3 + 1] = q.y; pos[i * 9 + k * 3 + 2] = q.z;
      }
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  }

  function draw() {
    if (!ensureLayer()) return;
    clearLayer();
    var d = meshDoc();
    layer.visible = isOn();
    syncPanel();
    if (!on || !d || !cur || !A()) return;
    var a = A(), P = cur.o.positions, by = { dots: [], lines: [], large: [], cant: [] };
    var off = new Set(window.NSO_LiftAuto.offered(a, minH()));
    a.islands.forEach(function (I) {
      if (I.status !== 'ok') by.cant = by.cant.concat(I.tris);
      else if (off.has(I.id)) by[I.group] = by[I.group].concat(I.tris);
    });
    Object.keys(by).forEach(function (k) {
      if (!by[k].length) return;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(outline(P, by[k]), 3));
      layer.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: GROUP_COLOUR[k], depthTest: false })));
      layer.add(tint(P, by[k], GROUP_COLOUR[k]));
    });
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  /** The grouped list: a swatch, the group, its count - nothing to press. */
  function syncPanel() {
    var row = $('ms-lift-row'), d = meshDoc();
    if (row) row.style.display = d ? 'block' : 'none';
    var box = $('ms-lift-groups'), a = A();
    if (box) {
      var gs = a ? LP().groups(a, minH()) : null;
      var show = !!(gs && (gs.list.length || gs.cant));
      box.style.display = show ? 'block' : 'none';
      box.innerHTML = !show ? '' : gs.list.map(function (G) {
        return '<div class="ms-lift-group" data-group="' + G.key + '"><span class="ms-lift-sw" style="background:#' +
          ('000000' + GROUP_COLOUR[G.key].toString(16)).slice(-6) + '"></span>' + esc(GROUP_LABEL[G.key]) +
          '<span class="ms-lift-n" data-count="' + G.key + '">' + esc(LP().groupWords(G)) + '</span></div>';
      }).join('') + (gs.cant ? '<div class="ms-lift-group" data-group="cant"><span class="ms-lift-sw" style="background:#b91c1c"></span>' +
        esc(GROUP_LABEL.cant) + '<span class="ms-lift-n" data-count="cant">' + gs.cant + '</span></div>' : '');
    }
    var r = $('ms-lift-read');
    if (r) r.textContent = readout();
  }

  function update() { read(); draw(); }

  // =========================================================================
  // Wiring
  // =========================================================================

  /* The outlines, for the helper registry: leave-tool switches them off; the
     next document G-scope opens shows them again. G-scope's close() only
     hides its panel - the document stays, and nothing is told - so the
     outlines are hidden here whenever the row is not live (a visible helper
     whose owner is not live is a stale one, Watch's phantom), and drawn
     again when the panel shows (the observer in mount). */
  function hideIfIdle() { if (layer && !isOn()) layer.visible = false; }
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('gscope-lift', {
    live: function () { var v = isOn(); if (!v) hideIfIdle(); return v; },
    close: function () { setOn(false); },
    clear: clearLayer,
    refresh: function () { update(); }
  });

  function isOn() { return on && !!(MS() && MS().isOpen() && meshDoc()); }
  function setOn(v) { on = !!v; update(); return on; }

  function mount() {
    if (!MS()) return;
    MS().onDocument(function () { on = true; cur = null; update(); });
    MS().onSelection(function () { if (meshDoc()) update(); });
    var panel = $('microscope');
    if (panel && typeof MutationObserver === 'function') {
      new MutationObserver(function () { if (panel.hidden) hideIfIdle(); else if (meshDoc()) update(); })
        .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    }
    syncPanel();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    setOn: setOn,
    isOn: isOn,
    refresh: function () { cur = null; update(); return cur ? { name: cur.o.name, count: A() ? window.NSO_LiftAuto.offered(A(), minH()).length : 0 } : null; },
    piece: function () { return cur ? { name: cur.o.name, sourceId: cur.o.sourceId } : null; },
    analysis: A,
    count: function () { return A() ? window.NSO_LiftAuto.offered(A(), minH()).length : 0; },
    groups: function () { return A() ? LP().groups(A(), minH()) : null; },
    readout: readout,
    layer: function () { return layer; }
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_LIFT = NSO_GSCOPE_LIFT;
