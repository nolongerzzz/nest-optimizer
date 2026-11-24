/* Painted colours on the plate - the app half of nso_paint.js (docs/MULTICOLOR.md).

   A piece opened from a Studio project painted with the colour brush (or whose parts print with
   different filaments) keeps that paint (model.paint). Every frame, before the render gate looks,
   sync() makes sure each displayed mesh of such a piece carries an overlay: the painted leaves,
   coloured with the project's filament colours, drawn just over the piece's own surface. The overlay
   is the piece's look, not a tool's: it is a helper (nso-helpers.js: never picked, exported or counted),
   owned by 'colours', which is always live; a Clear or an Undo that sweeps it is undone on the next
   frame. It is rebuilt only when the mesh's geometry changes.

   The paint belongs to the piece only while the piece's triangles are the ones it was read with
   (NSO_Paint.fits: the same count). A tool that rebuilds the piece (a cut, a boolean) leaves it
   without paint, and the overlay goes. */
(function () {
  'use strict';
  var OWNER = 'colours';
  var KEY = 'nsoPaintOverlay';

  if (window.nsoHelpers && window.nsoHelpers.owner) {
    window.nsoHelpers.owner(OWNER, { live: function () { return true; } });
  }

  function modelFor(mesh) {
    if (typeof state === 'undefined' || !state) return null;
    var ud = mesh.userData || {};
    var id = null;
    if (ud.placedIndex != null && state.placed && state.placed[ud.placedIndex] && state.placed[ud.placedIndex].mesh === mesh) {
      id = state.placed[ud.placedIndex].sourceId;
    } else if (ud.sourceId != null) {
      id = ud.sourceId;
    } else if (ud.editPreview && state.editId != null) {
      id = state.editId;
    }
    if (id == null) return null;
    for (var i = 0; i < (state.models || []).length; i++) if (state.models[i].id === id) return state.models[i];
    return null;
  }

  /** The mesh's triangles as a soup, whatever its indexing. */
  function soupOf(geo) {
    var pos = geo.attributes && geo.attributes.position;
    if (!pos) return null;
    if (!geo.index) return pos.array;
    var idx = geo.index.array, out = new Float32Array(idx.length * 3);
    for (var i = 0; i < idx.length; i++) {
      out[3 * i] = pos.getX(idx[i]); out[3 * i + 1] = pos.getY(idx[i]); out[3 * i + 2] = pos.getZ(idx[i]);
    }
    return out;
  }

  function keyOf(geo) {
    var pos = geo.attributes.position;
    return geo.uuid + ':' + pos.version + ':' + pos.count + ':' + (geo.index ? geo.index.version : '-');
  }

  function overlayOf(mesh) {
    for (var i = 0; i < mesh.children.length; i++) if (mesh.children[i].userData[KEY]) return mesh.children[i];
    return null;
  }

  function drop(mesh) {
    var o = overlayOf(mesh);
    if (!o) return;
    mesh.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }

  function build(mesh, model) {
    var P = soupOf(mesh.geometry);
    if (!P || !window.NSO_Paint.fits(model.paint, P.length)) return null;
    var ov = window.NSO_Paint.overlay(P, model.paint);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(ov.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(ov.colors, 3));
    g.computeVertexNormals();
    var m = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.05, roughness: 0.6,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2
    });
    var o = new THREE.Mesh(g, m);
    o.userData[KEY] = keyOf(mesh.geometry);
    o.userData.skipXray = true;
    o.renderOrder = mesh.renderOrder;
    return o;
  }

  /** One pass over the displayed pieces: add, refresh or remove each one's overlay. */
  function sync() {
    if (typeof state === 'undefined' || !state || !state.modelGroup || !window.NSO_Paint || typeof THREE === 'undefined') return;
    var meshes = state.modelGroup.children.slice();
    if (state.previewMesh && meshes.indexOf(state.previewMesh) < 0) meshes.push(state.previewMesh);
    for (var i = 0; i < meshes.length; i++) {
      var mesh = meshes[i];
      if (!mesh || !mesh.isMesh || !mesh.geometry || (mesh.userData && mesh.userData.nsoHelper)) continue;
      var model = modelFor(mesh);
      var have = overlayOf(mesh);
      if (!model || !model.paint) { if (have) drop(mesh); continue; }
      var k = keyOf(mesh.geometry);
      if (have && have.userData[KEY] === k) continue;
      if (have) drop(mesh);
      var o = build(mesh, model);
      if (!o) continue;                       /* the piece was rebuilt: its paint no longer lines up */
      if (window.nsoHelpers && window.nsoHelpers.attach) window.nsoHelpers.attach(mesh, o, OWNER);
      else { o.raycast = function () {}; mesh.add(o); }
    }
  }

  /** The filaments a piece uses, for its status line: "3 filaments (1, 2, 3)". */
  function describe(model) {
    if (!model || !model.paint || !window.NSO_Paint) return '';
    var f = window.NSO_Paint.filaments(model.paint);
    return f.length > 1 ? f.length + ' filaments (' + f.join(', ') + ')' : 'filament ' + f[0];
  }

  window.NSO_PaintView = { sync: sync, describe: describe };
})();
