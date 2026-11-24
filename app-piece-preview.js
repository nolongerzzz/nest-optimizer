/* app-piece-preview.js - the live preview a generator card (Gen+ > Fasteners, Gen+ > Fittings) shows before it bakes, and the
   small mesh helpers their tiles are drawn with. docs/THREADS.md.

   THE PREVIEW is a translucent copy of the piece(s) Add to plate would drop, standing where the drop would put them: beside the
   selection, then the nearest free spot (nsoFittings.spotFor - the drop's own two steps, run with the ghost's mesh as the entry so
   the search measures its real footprint). A second piece (a bolt + nut) stands beside the first. It is a helper in the SCENE, not a
   piece: never in state.placed or state.modelGroup, so it is not picked, packed, exported, or an Undo step.

   ONE GHOST AT A TIME. show(owner, soups) replaces whatever another card had up; clear(owner) only clears the owner's own - so two open
   cards do not leave two ghosts on the plate, and one card closing does not take the other's away.

   TILE ART helpers act on the app's z-up triangle soups (9 floats a triangle): flipUp (a half turn about X - a bolt head up, as it is
   held), moveZ, join, xform (a 3x3 rotation + translation), and the colours a tile tints a second part with. */

(function () {
  'use strict';

  var cur = { owner: null, meshes: [] };
  var GAP = 6;                                              // mm between a second piece and the first, as the drop leaves

  function sizeOfMesh(mesh) {
    var bb = mesh.geometry.boundingBox;
    return { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  }

  function dispose() {
    if (cur.host) {                                         // an overlay: give the piece under it its own look back
      cur.host.saved.forEach(function (sv) { sv.mt.transparent = sv.transparent; sv.mt.opacity = sv.opacity; sv.mt.depthWrite = sv.depthWrite; sv.mt.needsUpdate = true; });
      cur.host = null;
    }
    cur.meshes.forEach(function (m) {
      if (m.parent) m.parent.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    });
    cur.meshes = []; cur.owner = null;
  }
  function clear(owner) {
    if (owner && cur.owner !== owner) return false;
    dispose();
    return true;
  }

  /* stand the ghost(s) where the drop would put them */
  function place() {
    if (!cur.meshes.length || cur.host) return;             // an overlay rides on its piece
    var spot = window.nsoFittings && window.nsoFittings.spotFor, prev = null;
    cur.meshes.forEach(function (m, i) {
      var sz = sizeOfMesh(m), at;
      if (i === 0) at = typeof spot === 'function' ? spot(sz.x, m) : { x: 0, z: 0 };
      else at = { x: prev.x + prev.w / 2 + GAP + sz.x / 2, z: prev.z };
      m.position.set(at.x, 0.2 + sz.y / 2, at.z);
      m.updateMatrixWorld(true);
      prev = { x: at.x, z: at.z, w: sz.x };
    });
  }

  /* show(owner, soups): replace the ghost with these z-up soups (a Float32Array each) */
  function show(owner, soups) {
    dispose();
    if (typeof THREE === 'undefined' || typeof state === 'undefined' || !state.scene) return 0;
    cur.owner = owner;
    soups.forEach(function (soup) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
      g.rotateX(-Math.PI / 2);                              // the app's own z-up -> y-up
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.center();
      var mat = new THREE.MeshStandardMaterial({ color: 0x34d399, metalness: 0.05, roughness: 0.5, emissive: 0x064e3b, emissiveIntensity: 0.35,
                                                 transparent: true, opacity: 0.6, depthWrite: false });
      var mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = 40;
      mesh.userData.skipXray = true;
      mesh.userData.nsoPiecePreview = true;
      state.scene.add(mesh);
      cur.meshes.push(mesh);
    });
    place();
    return cur.meshes.length;
  }

  /* showOn(owner, model, soup): the ghost of an EDIT - the piece as it would become - laid over the piece itself (a raw-frame soup, put
     in the placed mesh's own frame the way Hollow's preview is), and the piece turned translucent under it until the ghost goes. */
  function showOn(owner, model, soup) {
    dispose();
    if (typeof THREE === 'undefined' || typeof state === 'undefined' || !model) return 0;
    var entry = (state.placed || []).find(function (p) { return p && p.sourceId === model.id; });
    if (!entry || !entry.mesh) return 0;
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(model) : null, n = soup.length / 3, pos = new Float32Array(soup.length);
    for (var i = 0; i < n; i++) {
      var p = [soup[3 * i], soup[3 * i + 1], soup[3 * i + 2]], q = f && typeof nsoLocalPointFromRaw === 'function' ? nsoLocalPointFromRaw(f, p) : p;
      pos[3 * i] = q[0]; pos[3 * i + 1] = q[1]; pos[3 * i + 2] = q[2];
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals(); g.computeBoundingBox();
    var mat = new THREE.MeshStandardMaterial({ color: 0x34d399, metalness: 0.05, roughness: 0.5, emissive: 0x064e3b, emissiveIntensity: 0.35, transparent: true, opacity: 0.6, depthWrite: false });
    var mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 40; mesh.userData.skipXray = true; mesh.userData.nsoPiecePreview = true;
    entry.mesh.add(mesh);
    var mats = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
    cur.host = { mesh: entry.mesh, saved: mats.map(function (mt) { return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite }; }) };
    mats.forEach(function (mt) { mt.transparent = true; mt.opacity = 0.25; mt.depthWrite = false; mt.needsUpdate = true; });
    cur.owner = owner; cur.meshes = [mesh];
    return 1;
  }

  function snapshot() {
    return { owner: cur.owner, count: cur.meshes.length, overlay: !!cur.host,
             ghost: cur.meshes.map(function (g) { var p = g.position; return { x: p.x, y: p.y, z: p.z, size: sizeOfMesh(g), inScene: !!g.parent }; }) };
  }

  /* ------------------------------------------------------------- tile art */
  function flipUp(s) {
    var o = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { o[i] = s[i]; o[i + 1] = -s[i + 1]; o[i + 2] = -s[i + 2]; }
    return o;
  }
  function moveZ(s, dz) { var o = new Float32Array(s); for (var i = 2; i < o.length; i += 3) o[i] += dz; return o; }
  function join() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var o = new Float32Array(n), q = 0;
    for (i = 0; i < arguments.length; i++) { o.set(arguments[i], q); q += arguments[i].length; }
    return o;
  }
  /* x' = R x + t, R a 3x3 as 9 numbers row-major, t [x, y, z]. A rotation (det +1) keeps the winding. */
  function xform(s, R, t) {
    var o = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) {
      var x = s[i], y = s[i + 1], z = s[i + 2];
      o[i] = R[0] * x + R[1] * y + R[2] * z + t[0];
      o[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
      o[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
    }
    return o;
  }
  function rotY(a) { var c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
  function rotZ(a) { var c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  function mul3(A, B) {
    var o = [];
    for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) o.push(A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c]);
    return o;
  }

  window.nsoPiecePreview = {
    show: show, showOn: showOn, clear: clear, place: place, state: snapshot, count: function () { return cur.meshes.length; },
    art: { flipUp: flipUp, moveZ: moveZ, join: join, xform: xform, rotY: rotY, rotZ: rotZ, mul3: mul3, AMBER: [251, 191, 36] }
  };
})();
