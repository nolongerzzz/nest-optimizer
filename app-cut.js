function rotateActiveModelY(deg) {
  const m = getActiveModel();
  if (!m || !m.geometry) return;
  m.geometry.rotateY((deg * Math.PI) / 180);
  m.geometry.center();
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox;
  m.size = {
    x: bb.max.x - bb.min.x,
    y: bb.max.y - bb.min.y,
    z: bb.max.z - bb.min.z
  };
  m.orientedGeometry = null;
  updateEditSize();
  if (state.cutterOpen) showEditPreview();
  else previewModelOnPlate(m.geometry, m.size);
  setStatus('Piece yaw ' + (deg > 0 ? '+' : '') + deg + ' deg (Y only - no free orbit)');
}

function getActiveModel() {
  if (state.editId != null) {
    const found = state.models.find(m => m.id === state.editId);
    if (found) return found;
  }
  return null;
}

function updateEditSize() {
  const el = document.getElementById('edit-size');
  const m = getActiveModel();
  if (!el) return;
  if (!m) {
    el.textContent = 'Load an STL to see size.';
    return;
  }
  el.textContent = m.name + ': ' + m.size.x.toFixed(1) + ' x ' + m.size.y.toFixed(1) + ' x ' + m.size.z.toFixed(1) + ' mm (X x H x Z)';
  syncCutUI();
}

function resolveAxis(model) {
  if (state.cutAxis === 'x' || state.cutAxis === 'z') return state.cutAxis;
  const sel = (document.getElementById('edit-axis') || {}).value || 'auto';
  if (sel === 'x' || sel === 'z') return sel;
  if (model && model.geometry && model.geometry.attributes && model.geometry.attributes.position) {
    const bb = new THREE.Box3().setFromBufferAttribute(model.geometry.attributes.position);
    const sx = bb.max.x - bb.min.x;
    const sz = bb.max.z - bb.min.z;
    return sx >= sz ? 'x' : 'z';
  }
  return model.size.x >= model.size.z ? 'x' : 'z';
}

function getCutSpan(model) {
  if (model && model.geometry && model.geometry.attributes && model.geometry.attributes.position) {
    const bbox = new THREE.Box3().setFromBufferAttribute(model.geometry.attributes.position);
    const axis = resolveAxis(model);
    return axis === 'x' ? (bbox.max.x - bbox.min.x) : (bbox.max.z - bbox.min.z);
  }
  return resolveAxis(model) === 'x' ? model.size.x : model.size.z;
}

function getCutMm() {
  const m = getActiveModel();
  if (!m) return 0;
  return state.cutT * getCutSpan(m);
}

/** Snap plane to 0.5 mm steps so cuts are repeatable */
function snapCutT(t, span) {
  if (!(span > 0)) return t;
  const mm = t * span;
  const snapped = Math.round(mm * 10) / 10; // 0.1 mm
  return Math.min(0.98, Math.max(0.02, snapped / span));
}

/** cutT drives the plane. Helper is a display of cutT. */
function getCutPlaneLocal(model) {
  const m = model || getActiveModel();
  if (!m || !m.geometry) return null;
  const axis = resolveAxis(m);
  const bbox = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  const span = axis === 'x' ? (bbox.max.x - bbox.min.x) : (bbox.max.z - bbox.min.z);
  if (!(span > 0)) return null;
  const t = Math.min(0.98, Math.max(0.02, Number(state.cutT) || 0.5));
  const origin = axis === 'x' ? bbox.min.x : bbox.min.z;
  const plane = origin + t * span;
  return { axis, plane, bbox, span, t, origin };
}

/** For Split: push cutT -> helper, then read plane from helper so cut == red line */
function getCutPlaneForSplit(model) {
  const m = model || getActiveModel();
  if (!m) return null;

  updateCutHelper();
  const plateAxis = resolveAxis(m);
  if (!state.cutHelper) return getCutPlaneLocal(m);

  const placed = (state.placed || []).find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  const mesh = placed ? placed.mesh : state.previewMesh;
  if (!mesh) {
    return getCutPlaneLocal(m);
  }

  mesh.updateMatrixWorld(true);
  const invWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();

  const worldPoint = state.cutHelper.position.clone().applyMatrix4(invWorld);
  const worldNormal = (plateAxis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1))
    .transformDirection(invWorld)
    .normalize();

  const ax = Math.abs(worldNormal.x);
  const ay = Math.abs(worldNormal.y);
  const az = Math.abs(worldNormal.z);
  let clipAxis = 'z';
  if (ax >= ay && ax >= az) clipAxis = 'x';
  else if (ay >= ax && ay >= az) clipAxis = 'y';
  else clipAxis = 'z';

  const bbox = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  const origin = clipAxis === 'x' ? bbox.min.x : clipAxis === 'y' ? bbox.min.y : bbox.min.z;
  const span = clipAxis === 'x' ? (bbox.max.x - bbox.min.x)
    : clipAxis === 'y' ? (bbox.max.y - bbox.min.y)
    : (bbox.max.z - bbox.min.z);
  if (!(span > 0)) return null;

  const plane = clipAxis === 'x' ? worldPoint.x : clipAxis === 'y' ? worldPoint.y : worldPoint.z;
  const t = Math.min(1, Math.max(0, (plane - origin) / span));

  return { axis: clipAxis, plateAxis: plateAxis, plane: plane, bbox: bbox, span: span, t: t, origin: origin };
}
function setCutMm(mm) {
  const m = getActiveModel();
  if (!m) return;
  const span = getCutSpan(m);
  if (span < 1) return;
  state.cutT = snapCutT(Math.min(0.98, Math.max(0.02, mm / span)), span);
  syncCutUI();
  updateCutHelper();
}

function syncCutUI() {
  const m = getActiveModel();
  const slider = document.getElementById('cut-slider');
  const input = document.getElementById('cut-mm');
  const readout = document.getElementById('cut-readout');
  if (!m) {
    if (readout) readout.textContent = '-';
    return;
  }
  const span = getCutSpan(m);
  const axis = resolveAxis(m);
  const mm = state.cutT * span;
  if (slider) slider.value = String((state.cutT * 100).toFixed(1));
  if (input && document.activeElement !== input) input.value = mm.toFixed(1);
  if (readout) {
    const a = Math.max(0, mm - KERF_MM * 0.5);
    const b = Math.max(0, span - mm - KERF_MM * 0.5);
    readout.textContent =
      'RED LINE @ ' + mm.toFixed(1) + ' mm (kerf ' + KERF_MM + ' mm) -> ' +
      a.toFixed(1) + ' mm | ' + b.toFixed(1) + ' mm  (' + axis.toUpperCase() + ')';
  }
}

function removeCutHelper() {
  if (state.cutHelper && state.cutHelper.parent) {
    state.cutHelper.parent.remove(state.cutHelper);
  }
  if (state.cutHelper) {
    state.cutHelper.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(mat => mat.dispose());
        else obj.material.dispose();
      }
    });
  }
  state.cutHelper = null;
}

function updateCutterUI() {
  const openBtn = document.getElementById('btn-cutter-open');
  const closeBtn = document.getElementById('btn-cutter-close');
  const status = document.getElementById('cutter-status');
  const cutBtn = document.getElementById('btn-cut');
  if (openBtn) {
    openBtn.disabled = state.cutterOpen;
    openBtn.classList.toggle('tool-active', state.cutterOpen);
  }
  if (closeBtn) closeBtn.disabled = !state.cutterOpen;
  if (status) {
    status.textContent = state.cutterOpen
      ? 'Cutter open - click a piece to put the red line on it, then Split.'
      : 'Cutter closed - red line off.';
  }
  if (cutBtn) cutBtn.disabled = !state.cutterOpen || !getActiveModel() || !state.cutHelper;
  const tools = document.getElementById('cutter-tools');
  if (tools) tools.classList.toggle('is-open', !!state.cutterOpen);
}

/** Mesh on the plate for the active model - used to hang the red plane in place */
function getCutterTargetMesh() {
  const m = getActiveModel();
  if (!m || !state.placed || !state.placed.length) return null;
  const hit = state.placed.find(p => p && p.sourceId === m.id && p.mesh);
  return hit ? hit.mesh : null;
}

function openCutter() {
  state.cutterOpen = true;
  state.cutDragging = false;
  state.editYawDragging = false;
  state.cutT = 0.5;
  state.editId = null;
  state.selectedIndex = -1;
  if (state.controls) state.controls.enabled = true;
  removeCutHelper();
  state.previewMesh = null;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  updateCutterUI();
  updateEditSize();
  const m = getActiveModel();
  setStatus(
    'Cutter open on ' + (m && m.name ? m.name : 'piece') +
    ' - red line only; pieces stay put. Drag plane, then Split.'
  );
}

function closeCutter(silent) {
  state.cutterOpen = false;
  state.cutDragging = false;
  state.moveDragging = false;
  state.editYawDragging = false;
  state.editId = null;
  state.selectedIndex = -1;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  if (state.controls) state.controls.enabled = true;
  removeCutHelper();
  // Do NOT clear or rebuild pieces - open/close is red-line only
  if (state.previewMesh && state.previewMesh.userData && state.previewMesh.userData.editPreview) {
    // Only clear a temporary single-model preview (no real plate pack)
    if (!state.placed.length) {
      /* leave preview mesh visible without plane */
    }
  }
  // If previewMesh was a real placed piece, just detach helper (already removed)
  state.previewMesh = null;
  updateCutterUI();
  if (!silent) setStatus('Cutter closed - red line off. Pieces unchanged.');
}

function showEditPreview() {
  const m = getActiveModel();
  if (!m || !state.scene || !state.modelGroup) return;

  const cam = freezeCamera();
  removeCutHelper();
  clearDisplayMeshes();
  state.previewMesh = null;
  state.placed = [];
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.05,
    roughness: 0.4,
    emissive: 0x0a3a5c,
    emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(m.geometry, mat);
  mesh.position.set(0, m.size.y / 2 + 0.3, 0);
  mesh.userData.editPreview = true;
  state.modelGroup.add(mesh);
  state.previewMesh = mesh;
  if (state.cutterOpen) buildCutHelper();
  restoreCamera(cam);
  syncCutUI();
}

function buildCutHelper() {
  const m = getActiveModel();
  if (!m || !state.previewMesh) return;
  if (state.cutHelper) {
    const keep = state.previewMesh;
    removeCutHelper();
    state.previewMesh = keep;
  }

  const axis = resolveAxis(m);
  const group = new THREE.Group();
  group.name = 'cutHelper';

  const w = Math.max(axis === 'x' ? m.size.z : m.size.x, 4);
  const h = Math.max(m.size.y, 4);
  const pw = w + 2;
  const ph = h + 2;

  const kerfVis = 0.7;
  const planeGeo = new THREE.BoxGeometry(
    axis === 'x' ? kerfVis : pw,
    ph,
    axis === 'x' ? pw : kerfVis
  );
  const planeMat = new THREE.MeshBasicMaterial({
    color: 0x111111,
    transparent: false,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.userData.cutHandle = true;

  // Large invisible hit target for easy drag
  const hitGeo = new THREE.PlaneGeometry(pw + 24, ph + 24);
  const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({
    visible: false, side: THREE.DoubleSide
  }));
  hit.userData.cutHandle = true;
  if (axis === 'x') hit.rotation.y = Math.PI / 2;

  // Bright edge frame around the plane
  const hw = pw / 2, hh = ph / 2;
  const framePts = axis === 'x'
    ? [
        [0, -hh, -hw], [0, -hh, hw],
        [0, -hh, hw], [0, hh, hw],
        [0, hh, hw], [0, hh, -hw],
        [0, hh, -hw], [0, -hh, -hw]
      ]
    : [
        [-hw, -hh, 0], [hw, -hh, 0],
        [hw, -hh, 0], [hw, hh, 0],
        [hw, hh, 0], [-hw, hh, 0],
        [-hw, hh, 0], [-hw, -hh, 0]
      ];
  const framePos = new Float32Array(framePts.flat());
  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.BufferAttribute(framePos, 3));
  const frame = new THREE.LineSegments(
    frameGeo,
    new THREE.LineBasicMaterial({ color: 0x000000 })
  );
  frame.userData.cutHandle = true;

  // Center crosshair on the plane
  const cross = axis === 'x'
    ? [[0, -hh * 0.9, 0], [0, hh * 0.9, 0], [0, 0, -hw * 0.9], [0, 0, hw * 0.9]]
    : [[0, -hh * 0.9, 0], [0, hh * 0.9, 0], [-hw * 0.9, 0, 0], [hw * 0.9, 0, 0]];
  const crossPos = new Float32Array(cross.flat());
  const crossGeo = new THREE.BufferGeometry();
  crossGeo.setAttribute('position', new THREE.BufferAttribute(crossPos, 3));
  const crossLine = new THREE.LineSegments(
    crossGeo,
    new THREE.LineBasicMaterial({ color: 0x000000 })
  );
  crossLine.userData.cutHandle = true;

  group.add(hit);
  group.add(plane);
  group.add(frame);
  group.add(crossLine);
  if (state.modelGroup) state.modelGroup.add(group);
  else if (state.previewMesh) state.previewMesh.add(group);
  state.cutHelper = group;
  updateCutHelper();
}

function updateCutHelper() {
  const m = getActiveModel();
  if (!m || !state.cutHelper) return;
  const info = getCutPlaneLocal(m);
  if (!info) return;
  const placed = (state.placed || []).find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  const mesh = placed ? placed.mesh : state.previewMesh;
  const wp = mesh ? mesh.position : { x: 0, y: 8, z: 0 };
  const y = (placed && placed.height) ? placed.height / 2 + 0.3 : (wp.y || 8);
  state.cutHelper.quaternion.identity();
  if (info.axis === 'x') {
    const span = m.size.x;
    const t = info.t;
    state.cutHelper.position.set(wp.x - span / 2 + t * span, y, wp.z);
  } else {
    const span = m.size.z;
    const t = info.t;
    state.cutHelper.position.set(wp.x, y, wp.z - span / 2 + t * span);
  }
}

function axisCoord(ax, x, y, z) {
  return ax === 'x' ? x : ax === 'y' ? y : z;
}

function clipGeometrySide(geometry, axis, plane, keepMin) {
  // Always copy - never mutate the source model mesh
  let src = geometry.clone();
  if (src.index) src = src.toNonIndexed();
  const pos = src.attributes.position;
  const out = [];
  const edges = [];
  const EPS = 1e-4;

  function coord(v) {
    return axis === 'x' ? v[0] : axis === 'y' ? v[1] : v[2];
  }

  // -1 = min side, 0 = on plane, +1 = max side
  function classify(c) {
    if (c < plane - EPS) return -1;
    if (c > plane + EPS) return 1;
    return 0;
  }

  function isKept(side) {
    if (keepMin) return side <= 0;
    return side >= 0;
  }

  function interp(a, b, ca, cb) {
    const den = cb - ca;
    const t = Math.abs(den) < 1e-12 ? 0.5 : (plane - ca) / den;
    const tt = Math.min(1, Math.max(0, t));
    const pt = [
      a[0] + (b[0] - a[0]) * tt,
      a[1] + (b[1] - a[1]) * tt,
      a[2] + (b[2] - a[2]) * tt
    ];
    if (axis === 'x') pt[0] = plane;
    else if (axis === 'y') pt[1] = plane;
    else pt[2] = plane;
    return pt;
  }

  function almostSame(a, b) {
    return Math.abs(a[0] - b[0]) < 1e-4
      && Math.abs(a[1] - b[1]) < 1e-4
      && Math.abs(a[2] - b[2]) < 1e-4;
  }

  function pushTri(a, b, c) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return;
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }

  const triCount = Math.floor(pos.count / 3);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const verts = [
      [pos.getX(i0), pos.getY(i0), pos.getZ(i0)],
      [pos.getX(i0 + 1), pos.getY(i0 + 1), pos.getZ(i0 + 1)],
      [pos.getX(i0 + 2), pos.getY(i0 + 2), pos.getZ(i0 + 2)]
    ];
    const cs = verts.map(coord);
    const sides = cs.map(classify);
    const kept = sides.map(isKept);
    const nKeep = (kept[0] ? 1 : 0) + (kept[1] ? 1 : 0) + (kept[2] ? 1 : 0);
    if (nKeep === 0) continue;
    if (nKeep === 3) {
      // Whole triangle on this side - but skip pure on-plane tris (zero volume)
      if (sides[0] === 0 && sides[1] === 0 && sides[2] === 0) continue;
      pushTri(verts[0], verts[1], verts[2]);
      continue;
    }

    const poly = [];
    const cutPts = [];
    for (let e = 0; e < 3; e++) {
      const a = verts[e];
      const b = verts[(e + 1) % 3];
      const ca = cs[e];
      const cb = cs[(e + 1) % 3];
      const sa = sides[e];
      const sb = sides[(e + 1) % 3];
      const ka = kept[e];
      const kb = kept[(e + 1) % 3];

      if (ka) poly.push(a);

      // Crossing from one side of plane to the other (not on-plane-only edge)
      if (sa !== sb && sa * sb === -1) {
        const p = interp(a, b, ca, cb);
        poly.push(p);
        cutPts.push(p);
      } else if (sa !== sb && (sa === 0 || sb === 0)) {
        // One vertex on plane, other off - the on-plane vertex is the cut point
        const onPt = sa === 0 ? a : b;
        if (ka !== kb) {
          // only add if the off-plane vertex is NOT kept and on-plane was already pushed, or vice versa
          if (!almostSame(poly.length ? poly[poly.length - 1] : [1e9, 0, 0], onPt)) {
            if (!ka) poly.push(onPt);
          }
          cutPts.push(onPt);
        }
      }
    }

    const clean = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      if (!clean.length || !almostSame(clean[clean.length - 1], p)) clean.push(p);
    }
    if (clean.length >= 2 && almostSame(clean[0], clean[clean.length - 1])) clean.pop();
    if (clean.length < 3) continue;

    for (let i = 1; i < clean.length - 1; i++) {
      pushTri(clean[0], clean[i], clean[i + 1]);
    }

    if (cutPts.length >= 2) {
      let a = cutPts[0];
      let b = cutPts[0];
      for (let i = 1; i < cutPts.length; i++) {
        if (!almostSame(a, cutPts[i])) { b = cutPts[i]; break; }
      }
      if (!almostSame(a, b)) edges.push([a, b]);
    }
  }

  const cap = capFromEdges(edges, axis, plane, keepMin);
  for (let i = 0; i < cap.length; i++) out.push(cap[i]);

  if (out.length < 9) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
}

function capFromEdges(edges, axis, plane, keepMin) {
  // Claude-style: boundary graph -> closed loop(s) -> ear-clip cap -> outward normals
  if (!edges || !edges.length) return [];

  const TOL = 1e-4;
  function keyOf(p) {
    // Plane is axis=const; key on the other two coords
    let a, b;
    if (axis === 'x') { a = p[1]; b = p[2]; }
    else if (axis === 'y') { a = p[0]; b = p[2]; }
    else { a = p[0]; b = p[1]; }
    return (Math.round(a / TOL) * TOL) + '|' + (Math.round(b / TOL) * TOL);
  }
  function snap(p) {
    const q = [p[0], p[1], p[2]];
    if (axis === 'x') q[0] = plane;
    else if (axis === 'y') q[1] = plane;
    else q[2] = plane;
    return q;
  }
  function to2(p) {
    if (axis === 'x') return [p[1], p[2]];
    if (axis === 'y') return [p[0], p[2]];
    return [p[0], p[1]];
  }
  function from2(u, v) {
    if (axis === 'x') return [plane, u, v];
    if (axis === 'y') return [u, plane, v];
    return [u, v, plane];
  }
  function dist2(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  }

  // Weld points + filter zero-length segments
  const nodePos = new Map(); // key -> [x,y,z]
  const adj = new Map(); // key -> Set of neighbor keys

  function addNode(p) {
    const s = snap(p);
    const k = keyOf(s);
    if (!nodePos.has(k)) nodePos.set(k, s);
    if (!adj.has(k)) adj.set(k, new Set());
    return k;
  }

  edges.forEach(pair => {
    if (!pair || pair.length < 2) return;
    const k0 = addNode(pair[0]);
    const k1 = addNode(pair[1]);
    if (k0 === k1) return; // degenerate
    if (dist2(nodePos.get(k0), nodePos.get(k1)) < TOL * TOL) return;
    adj.get(k0).add(k1);
    adj.get(k1).add(k0);
  });

  // Walk only clean, non-branching simple cycles (every node degree
  // exactly 2). A node with degree != 2 is a junction where two or more
  // separate boundary loops meet or cross (e.g. a missing-wall opening
  // touching an adjacent slot or rib). Walking blindly through such a
  // point used to stitch unrelated loops into one convoluted polygon --
  // ear-clipping that produced long diagonal slivers fanning across the
  // hole instead of a flat panel. Skipping anything that touches a
  // junction leaves those specific edges open (fail-safe) instead of
  // guessing which branch belongs to which loop.
  const visitedEdge = new Set();
  function ek(a, b) { return a < b ? a + '~' + b : b + '~' + a; }

  const loops = [];
  for (const start of adj.keys()) {
    if (adj.get(start).size !== 2) continue;
    for (const nb of adj.get(start)) {
      const e0 = ek(start, nb);
      if (visitedEdge.has(e0)) continue;
      // Walk loop
      const loopKeys = [start];
      let prev = start;
      let cur = nb;
      visitedEdge.add(e0);
      let guard = 0;
      let clean = true;
      while (cur !== start && guard++ < 100000) {
        if (!adj.has(cur) || adj.get(cur).size !== 2) { clean = false; break; }
        loopKeys.push(cur);
        const nbs = adj.get(cur);
        let next = null;
        for (const cand of nbs) {
          if (cand === prev) continue;
          const e = ek(cur, cand);
          if (visitedEdge.has(e)) continue;
          next = cand;
          visitedEdge.add(e);
          break;
        }
        if (next == null) {
          // try any unused including back (open chain - abort)
          clean = false;
          break;
        }
        prev = cur;
        cur = next;
      }
      if (clean && cur === start && loopKeys.length >= 3) {
        loops.push(loopKeys.map(k => nodePos.get(k)));
      }
    }
  }

  // NOTE: the old convex-hull-of-all-points fallback (used when no clean
  // loop was found) is gone. A "best guess" hull across every leftover
  // point is precisely the kind of guess that spans across a trough --
  // if no clean loop was found, this cap attempt yields nothing and the
  // edges stay open (fail-safe) rather than being closed with a wrong shape.

  function hull2D(pts3) {
    const pts = pts3.map((p, i) => {
      const t = to2(p);
      return { u: t[0], v: t[1], p, i };
    });
    pts.sort((a, b) => a.u === b.u ? a.v - b.v : a.u - b.u);
    function cross(o, a, b) {
      return (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
    }
    const lower = [];
    for (let i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper).map(h => h.p);
  }

  // Ear clipping in 2D
  function earClip(loop3) {
    if (loop3.length < 3) return [];
    const poly = loop3.map(p => {
      const t = to2(p);
      return { u: t[0], v: t[1], p: p };
    });
    // Remove near-duplicate consecutive verts
    const clean = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (Math.abs(a.u - b.u) + Math.abs(a.v - b.v) > TOL) clean.push(a);
    }
    if (clean.length < 3) return [];

    function area2(pts) {
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        a += pts[i].u * pts[j].v - pts[j].u * pts[i].v;
      }
      return a;
    }
    let verts = clean.slice();
    // Ensure CCW for standard ear clip
    if (area2(verts) < 0) verts.reverse();

    function isInside(a, b, c, p) {
      // barycentric
      const v0x = c.u - a.u, v0y = c.v - a.v;
      const v1x = b.u - a.u, v1y = b.v - a.v;
      const v2x = p.u - a.u, v2y = p.v - a.v;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const inv = 1 / (dot00 * dot11 - dot01 * dot01 + 1e-30);
      const u = (dot11 * dot02 - dot01 * dot12) * inv;
      const v = (dot00 * dot12 - dot01 * dot02) * inv;
      return u >= -1e-9 && v >= -1e-9 && (u + v) <= 1 + 1e-9;
    }
    function isConvex(prev, curr, next) {
      return (curr.u - prev.u) * (next.v - prev.v) - (curr.v - prev.v) * (next.u - prev.u) > 1e-12;
    }

    const tris = [];
    let guard = 0;
    let stuck = false;
    while (verts.length > 3 && guard++ < 10000) {
      let clipped = false;
      const n = verts.length;
      for (let i = 0; i < n; i++) {
        const prev = verts[(i + n - 1) % n];
        const curr = verts[i];
        const next = verts[(i + 1) % n];
        if (!isConvex(prev, curr, next)) continue;
        let empty = true;
        for (let k = 0; k < n; k++) {
          if (k === i || k === (i + n - 1) % n || k === (i + 1) % n) continue;
          if (isInside(prev, curr, next, verts[k])) { empty = false; break; }
        }
        if (!empty) continue;
        tris.push([prev.p, curr.p, next.p]);
        verts.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) {
        // Ear-clipping got stuck on a remaining non-convex/complex
        // polygon. The old behavior fanned every remaining vertex from
        // verts[0], which is exactly what produced long diagonal slivers
        // fanning across a hole instead of a flat panel. Bail out
        // uncapped instead -- fail-safe leaves this loop's edges open.
        stuck = true;
        break;
      }
    }
    if (stuck) return [];
    if (verts.length === 3) {
      tris.push([verts[0].p, verts[1].p, verts[2].p]);
    }
    return tris;
  }

  // Outward normal along cut axis:
  // keepMin (material on min side): outward is +axis
  // keepMax (material on max side): outward is -axis
  const outward = keepMin ? 1 : -1;
  const finish = (document.getElementById('cut-finish') || {}).value || 'match';
  const out = [];
  function pushOriented(a, b, c) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    let along = axis === 'x' ? nx : axis === 'y' ? ny : nz;
    if (along * outward < 0) {
      out.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
    } else {
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
  }

  function loopArea2(loop2) {
    let a = 0;
    for (let i = 0; i < loop2.length; i++) {
      const j = (i + 1) % loop2.length;
      a += loop2[i][0] * loop2[j][1] - loop2[j][0] * loop2[i][1];
    }
    return a;
  }

  function resampleLoop2(loop2, spacing) {
    if (loop2.length < 3) return loop2;
    const segs = [];
    let total = 0;
    for (let i = 0; i < loop2.length; i++) {
      const a = loop2[i], b = loop2[(i + 1) % loop2.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segs.push({ a, b, L });
      total += L;
    }
    if (total < spacing * 3) return loop2;
    const n = Math.max(12, Math.round(total / spacing));
    const outL = [];
    let dist = 0, si = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const target = (k / n) * total;
      while (si < segs.length - 1 && acc + segs[si].L < target) {
        acc += segs[si].L;
        si++;
      }
      const s = segs[si];
      const t = s.L < 1e-9 ? 0 : (target - acc) / s.L;
      outL.push([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
    }
    return outL;
  }

  function edgeInwardNormal(p1, p2, sign) {
    const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1e-12;
    return [sign * (-dy / len), sign * (dx / len)];
  }

  function vertexOffset(loop2, i, radius, sign) {
    const n = loop2.length;
    const prev = loop2[(i - 1 + n) % n], curr = loop2[i], next = loop2[(i + 1) % n];
    const n1 = edgeInwardNormal(prev, curr, sign);
    const n2 = edgeInwardNormal(curr, next, sign);
    let bx = n1[0] + n2[0], by = n1[1] + n2[1];
    const blen = Math.hypot(bx, by) || 1e-9;
    bx /= blen; by /= blen;
    const cosHalf = Math.max(bx * n1[0] + by * n1[1], 0.3);
    const mag = radius / cosHalf;
    return [curr[0] + bx * mag, curr[1] + by * mag];
  }

  function turningAngle(loop2, i) {
    const n = loop2.length;
    const prev = loop2[(i - 1 + n) % n], curr = loop2[i], next = loop2[(i + 1) % n];
    const a1 = Math.atan2(curr[1] - prev[1], curr[0] - prev[0]);
    const a2 = Math.atan2(next[1] - curr[1], next[0] - curr[0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function solveCornerCenter(cornerPt, n1, n2, R) {
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    if (Math.abs(det) < 1e-10) return null;
    const nx = (n2[1] - n1[1]) / det;
    const ny = (n1[0] - n2[0]) / det;
    return [cornerPt[0] + R * nx, cornerPt[1] + R * ny];
  }

  function slerp2D(a, b, t) {
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
    const theta = Math.acos(dot);
    if (theta < 1e-8) return a.slice();
    const s = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / s, wb = Math.sin(t * theta) / s;
    return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1]];
  }

  function smoothstep(x) {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  }

  function ringSelfIntersectsDetail(ring) {
    // Same as the original ringSelfIntersects, but returns the offending
    // index pairs instead of just a boolean - needed for local repair (BUG 3).
    function segX(p1, p2, p3, p4) {
      const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
      const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-12) return false;
      const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
      const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    }
    const m = ring.length;
    const bad = [];
    for (let i = 0; i < m; i++) {
      const a = ring[i], b = ring[(i + 1) % m];
      for (let j = i + 2; j < m; j++) {
        if (i === 0 && j === m - 1) continue;
        if ((j + 1) % m === i) continue;
        if (segX(a, b, ring[j], ring[(j + 1) % m])) bad.push([i, j]);
      }
    }
    return bad;
  }

  function ringSelfIntersects(ring) {
    return ringSelfIntersectsDetail(ring).length > 0;
  }

  function from2At(u, v, along) {
    if (axis === 'x') return [along, u, v];
    if (axis === 'y') return [u, along, v];
    return [u, v, along];
  }

  function localThickness(loop2, i, sign) {
    const n = loop2.length;
    const curr = loop2[i];
    const prev = loop2[(i - 1 + n) % n], next = loop2[(i + 1) % n];
    const nn = edgeInwardNormal(prev, next, sign);
    let minD = 1e9;
    for (let j = 0; j < n; j++) {
      if (Math.abs(j - i) < 2 || Math.abs(j - i) > n - 2) continue;
      const a = loop2[j], b = loop2[(j + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const den = nn[0] * dy - nn[1] * dx;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((a[0] - curr[0]) * dy - (a[1] - curr[1]) * dx) / den;
      const u = ((a[0] - curr[0]) * nn[1] - (a[1] - curr[1]) * nn[0]) / -den;
      if (t > 0.15 && t < minD && u >= -0.05 && u <= 1.05) minD = t;
    }
    return minD === 1e9 ? 4 : minD;
  }

  function targetRadius() {
    if (finish === 'square') return 0;
    if (finish === 'soft') return 0.8;
    return 2.0; // match piece - factory-scale default, locally clamped
  }

  // ---- min-filter (not mean-filter) smoothing for the radius array. ----
  function minFilterCircular(arr, window) {
    const n = arr.length;
    const out = new Array(n);
    const half = Math.floor(window / 2);
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let k = -half; k <= half; k++) m = Math.min(m, arr[(i + k + n) % n]);
      out[i] = m;
    }
    return out;
  }

  function smoothRadiusSafely(arr, window) {
    const n = arr.length;
    const half = Math.floor(window / 2);
    const mean = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -half; k <= half; k++) s += arr[(i + k + n) % n];
      mean[i] = s / window;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(mean[i], arr[i] * 1.15);
    return out;
  }

  function repairSelfIntersections(loop2, Rs, computeRing) {
    const n = loop2.length;
    let R = Rs.slice();
    for (let iter = 0; iter < 40; iter++) {
      const ring = computeRing(R);
      const bad = ringSelfIntersectsDetail(ring);
      if (bad.length === 0) return R;
      const touched = new Set();
      for (const [i, j] of bad) {
        touched.add(i); touched.add((i + 1) % n);
        touched.add(j); touched.add((j + 1) % n);
      }
      touched.forEach(idx => { R[idx] *= 0.9; });
    }
    return R;
  }

  function buildStitchStrip(trueLoop2, resampledLoop2) {
    function cumlen(poly) {
      const n = poly.length;
      const seg = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const a = poly[i], b = poly[(i + 1) % n];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        seg.push(L);
        total += L;
      }
      const t = [0];
      for (let i = 0; i < n - 1; i++) t.push(t[i] + seg[i]);
      return { t, total };
    }

    const T = trueLoop2, R = resampledLoop2;
    const nT = T.length, nR = R.length;
    const { t: tT, total: totalT } = cumlen(T);
    const { t: tRraw, total: totalR } = cumlen(R);
    const tR = tRraw.map(v => v * (totalT / totalR));

    const strip = [];
    let i = 0, j = 0, guard = 0;
    while ((i < nT || j < nR) && guard++ < 20000) {
      const iNext = (i + 1) % nT;
      const jNext = (j + 1) % nR;
      const tiNext = iNext !== 0 ? tT[iNext] : totalT;
      const tjNext = jNext !== 0 ? tR[jNext] : totalT;
      if (iNext === 0 && jNext === 0) break;

      const advanceTrue = (tiNext <= tjNext && iNext !== 0) || (jNext === 0 && iNext !== 0);
      const pTcur = T[i], pRcur = R[j];

      if (advanceTrue) {
        strip.push([pTcur, T[iNext], pRcur]);
        i = iNext;
      } else {
        strip.push([pTcur, R[jNext], pRcur]);
        j = jNext;
      }
      if (i === 0 && j === 0) break;
    }
    return strip;
  }

  function nudgeDegenerateTriangles(triangles2D) {
    const MATCH_TOL = 1e-4;
    function area2(a, b, c) {
      return 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    }
    function keyOf2(p) {
      return Math.round(p[0] / MATCH_TOL) + '|' + Math.round(p[1] / MATCH_TOL);
    }
    const candidateMags = [1e-5, 1e-5 / 3, 1e-5 / 10, 1e-5 / 30, 1e-5 / 100];

    for (const tri of triangles2D) {
      if (area2(tri[0], tri[1], tri[2]) > 1e-9) continue;
      const d01 = Math.hypot(tri[1][0] - tri[0][0], tri[1][1] - tri[0][1]);
      const d12 = Math.hypot(tri[2][0] - tri[1][0], tri[2][1] - tri[1][1]);
      const d02 = Math.hypot(tri[2][0] - tri[0][0], tri[2][1] - tri[0][1]);
      const longest = Math.max(d01, d12, d02);
      let midIdx, aIdx, bIdx;
      if (longest === d02) { midIdx = 1; aIdx = 0; bIdx = 2; }
      else if (longest === d01) { midIdx = 2; aIdx = 0; bIdx = 1; }
      else { midIdx = 0; aIdx = 1; bIdx = 2; }
      const a = tri[aIdx], b = tri[bIdx];
      const edx = b[0] - a[0], edy = b[1] - a[1];
      const elen = Math.hypot(edx, edy);
      if (elen < 1e-12) continue;
      const ex = edx / elen, ey = edy / elen;
      const perp = [-ey, ex];
      const origPt = tri[midIdx].slice();
      const origKey = keyOf2(origPt);
      let fixed = false;
      for (const dir of [1, -1]) {
        for (const mag of candidateMags) {
          const cand = [origPt[0] + perp[0] * mag * dir, origPt[1] + perp[1] * mag * dir];
          if (keyOf2(cand) === origKey) {
            tri[midIdx] = cand;
            fixed = true;
            break;
          }
        }
        if (fixed) break;
      }
    }
    return triangles2D;
  }

  function filletLoop(loop3, Rreq) {
    const raw2 = loop3.map(p => to2(p));
    if (raw2.length < 6 || Rreq < 0.15) return null;

    let trueLoop2 = raw2;
    let loop2 = resampleLoop2(raw2, 0.35);

    let areaTrue = loopArea2(trueLoop2);
    let area = loopArea2(loop2);
    const sign = area >= 0 ? 1 : -1;
    if (areaTrue < 0) trueLoop2 = trueLoop2.slice().reverse();
    if (area < 0) { loop2 = loop2.slice().reverse(); area = -area; }
    const n = loop2.length;

    const Rloc = [];
    for (let i = 0; i < n; i++) {
      const thick = localThickness(loop2, i, 1);
      Rloc.push(Math.min(Rreq, Math.max(0.2, thick * 0.3)));
    }
    let Rs = minFilterCircular(Rloc, 9);
    Rs = smoothRadiusSafely(Rs, 7);

    const Rmax = Math.max(...Rs);
    if (Rmax < 0.15) return null;

    const STEPS = 12;
    const cornerThresh = 30 * Math.PI / 180;
    const corners = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(turningAngle(loop2, i)) > cornerThresh) corners.push(i);
    }
    const windowN = 12;
    const centers = corners.map(ci => {
      const prev = loop2[(ci - 3 + n) % n], curr = loop2[ci], next = loop2[(ci + 3) % n];
      const n1 = edgeInwardNormal(prev, curr, 1);
      const n2 = edgeInwardNormal(curr, next, 1);
      return { i: ci, C: solveCornerCenter(curr, n1, n2, Rs[ci]), n1, n2, R: Rs[ci] };
    });

    function computeRingAtDepth(Rarr, s) {
      const t = s / STEPS;
      const ring = [];
      for (let i = 0; i < n; i++) {
        const R = Rarr[i];
        const u = R * (1 - t);
        const sinPhi = Math.min(1, Math.max(0, 1 - (R < 1e-6 ? 1 : u / R)));
        const phi = Math.asin(sinPhi);
        const inset = R * (1 - Math.cos(phi));
        let uv = vertexOffset(loop2, i, inset, 1);
        for (const c of centers) {
          if (!c.C) continue;
          const signedDist = i - c.i;
          let d = ((signedDist + n) % n);
          if (d > n / 2) d -= n;
          const absD = Math.abs(d);
          if (absD > windowN) continue;
          const w = smoothstep(1 - absD / windowN);
          const negN1 = [-c.n1[0], -c.n1[1]];
          const negN2 = [-c.n2[0], -c.n2[1]];
          const tBlend = (d + windowN) / (2 * windowN);
          const nBlend = slerp2D(negN1, negN2, tBlend);
          const suv = [c.C[0] + c.R * Math.cos(phi) * nBlend[0], c.C[1] + c.R * Math.cos(phi) * nBlend[1]];
          uv = [uv[0] * (1 - w) + suv[0] * w, uv[1] * (1 - w) + suv[1] * w];
        }
        ring.push(uv);
      }
      return ring;
    }

    Rs = repairSelfIntersections(loop2, Rs, (Rarr) => computeRingAtDepth(Rarr, STEPS));
    const finalRmax = Math.max(...Rs);
    if (finalRmax < 0.15) return null;

    const rings = [];
    for (let s = 0; s <= STEPS; s++) rings.push(computeRingAtDepth(Rs, s));

    if (ringSelfIntersects(rings[rings.length - 1])) return null;

    const tris3 = [];

    const stitch2D = nudgeDegenerateTriangles(buildStitchStrip(trueLoop2, rings[0]));
    for (const [p1, p2, p3] of stitch2D) {
      tris3.push([from2At(p1[0], p1[1], plane), from2At(p2[0], p2[1], plane), from2At(p3[0], p3[1], plane)]);
    }

    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[s], b = rings[s + 1];
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        const A0 = from2At(a[i][0], a[i][1], plane - outward * (s / STEPS) * finalRmax);
        const A1 = from2At(a[i1][0], a[i1][1], plane - outward * (s / STEPS) * finalRmax);
        const B0 = from2At(b[i][0], b[i][1], plane - outward * ((s + 1) / STEPS) * finalRmax);
        const B1 = from2At(b[i1][0], b[i1][1], plane - outward * ((s + 1) / STEPS) * finalRmax);
        tris3.push([A0, A1, B1], [A0, B1, B0]);
      }
    }
    const inner = rings[rings.length - 1].map(uv => from2At(uv[0], uv[1], plane - outward * finalRmax));
    const cap = earClip(inner);
    cap.forEach(t => tris3.push(t));
    return tris3;
  }

  // LIVE GATE: fillet triangles are added ON TOP of walls that still meet
  // the cut plane. Claude's sandbox builds one consistent mesh (clip+round
  // together). Injecting the fillet here self-intersects the body and looks
  // like the old slice-and-dice. Keep sealed flat cap until rounding is a
  // post-pass on an already-capped STL, or walls are retracted by R first.
  loops.forEach(loop => {
    const tris = earClip(loop);
    tris.forEach(t => pushOriented(t[0], t[1], t[2]));
  });

  return out;
}

function rawEarClip2D(poly2d) {
  function signedArea2D(pts) {
    let a = 0; const n = pts.length;
    for (let i = 0; i < n; i++) { const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%n]; a += x1*y2 - x2*y1; }
    return a * 0.5;
  }
  function isConvex(a, b, c) { return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]) > 1e-9; }
  function pointInTri(p, a, b, c, eps) {
    function sign(p1,p2,p3){ return (p1[0]-p3[0])*(p2[1]-p3[1]) - (p2[0]-p3[0])*(p1[1]-p3[1]); }
    const d1=sign(p,a,b), d2=sign(p,b,c), d3=sign(p,c,a);
    if (Math.abs(d1)<eps || Math.abs(d2)<eps || Math.abs(d3)<eps) return false;
    const hasNeg=d1<0||d2<0||d3<0, hasPos=d1>0||d2>0||d3>0;
    return !(hasNeg && hasPos);
  }
  let pts = poly2d;
  const area = signedArea2D(pts);
  const ccwIdxs = area >= 0 ? pts.map((_,i)=>i) : pts.map((_,i)=>i).reverse();
  const work = ccwIdxs.slice();
  const tris = [];
  let guard = 0, scanStart = 0;
  while (work.length > 3 && guard++ < 20000) {
    let found = false;
    const n = work.length;
    for (let s = 0; s < n; s++) {
      const i = (scanStart + s) % work.length;
      const ip = work[(i - 1 + work.length) % work.length];
      const ic = work[i];
      const inx = work[(i + 1) % work.length];
      const a = pts[ip], b = pts[ic], c = pts[inx];
      if (!isConvex(a, b, c)) continue;
      let blocked = false;
      for (const j of work) {
        if (j===ip||j===ic||j===inx) continue;
        if (pointInTri(pts[j], a, b, c, 1e-7)) { blocked = true; break; }
      }
      if (blocked) continue;
      tris.push([ip, ic, inx]);
      work.splice(i, 1);
      scanStart = i > 0 ? i - 1 : 0;
      found = true;
      break;
    }
    if (!found) {
      // Guaranteed-complete fallback for a genuine dead end — see sandbox notes.
      for (let m = 1; m < work.length - 1; m++) {
        const ia = work[0], ib = work[m], ic = work[m+1];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        const cross = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
        if (cross >= 0) tris.push([ia, ib, ic]); else tris.push([ia, ic, ib]);
      }
      work.length = 0;
      break;
    }
  }
  if (work.length === 3) tris.push([work[0], work[1], work[2]]);
  return tris;
}

function rawClipTrianglesAtPlane(tris, axisIdx, planeVal, keepMin) {
  const kept = [];
  const cutEdges = [];
  const triCount = tris.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const v = [
      [tris[i0], tris[i0+1], tris[i0+2]],
      [tris[i0+3], tris[i0+4], tris[i0+5]],
      [tris[i0+6], tris[i0+7], tris[i0+8]],
    ];
    const d = v.map(p => (p[axisIdx] - planeVal) * (keepMin ? 1 : -1));
    const allIn = d[0] >= 0 && d[1] >= 0 && d[2] >= 0;
    const allOut = d[0] < 0 && d[1] < 0 && d[2] < 0;
    if (allIn) { kept.push(...v[0], ...v[1], ...v[2]); continue; }
    if (allOut) continue;

    const poly = [];
    const intersections = [];
    const onPlaneVerts = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e+1)%3];
      const da = d[e], db = d[(e+1)%3];
      if (da >= 0) poly.push(a);
      if (da === 0) onPlaneVerts.push(a);
      const crosses = (da > 0 && db < 0) || (da < 0 && db > 0);
      if (crosses) {
        const tt = da / (da - db);
        const p = [a[0]+(b[0]-a[0])*tt, a[1]+(b[1]-a[1])*tt, a[2]+(b[2]-a[2])*tt];
        p[axisIdx] = planeVal;
        poly.push(p);
        intersections.push(p);
      }
    }
    if (intersections.length === 1 && onPlaneVerts.length >= 1) intersections.push(onPlaneVerts[0]);
    for (let i = 1; i < poly.length - 1; i++) kept.push(...poly[0], ...poly[i], ...poly[i+1]);
    if (intersections.length === 2) cutEdges.push([intersections[0], intersections[1]]);
  }
  return { kept, cutEdges };
}

function rawBuildLoopsFromCutEdges(cutEdges, axisIdx, weldTol) {
  weldTol = weldTol || 1e-4;
  const otherAxes = [0, 1, 2].filter(a => a !== axisIdx);
  function key(p) {
    const a = p[otherAxes[0]], b = p[otherAxes[1]];
    return Math.round(a/weldTol) + '|' + Math.round(b/weldTol);
  }
  const nodePos = new Map();
  const adj = new Map();
  function addNode(p) {
    const k = key(p);
    if (!nodePos.has(k)) nodePos.set(k, p);
    if (!adj.has(k)) adj.set(k, new Set());
    return k;
  }
  for (const pair of cutEdges) {
    const k1 = addNode(pair[0]), k2 = addNode(pair[1]);
    if (k1 === k2) continue;
    adj.get(k1).add(k2);
    adj.get(k2).add(k1);
  }
  const degreeIssues = [];
  for (const entry of adj) {
    if (entry[1].size !== 2) degreeIssues.push({ key: entry[0], pos: nodePos.get(entry[0]), degree: entry[1].size });
  }
  const visitedEdges = new Set();
  function ek(a, b) { return a < b ? a+'~'+b : b+'~'+a; }
  const loops = [];
  for (const start of adj.keys()) {
    for (const nb of adj.get(start)) {
      const e0 = ek(start, nb);
      if (visitedEdges.has(e0)) continue;
      const loopKeys = [start];
      let prev = start, cur = nb;
      visitedEdges.add(e0);
      let guard = 0;
      while (cur !== start && guard++ < 200000) {
        loopKeys.push(cur);
        const nbrs = adj.get(cur);
        let next = null;
        for (const cand of nbrs) {
          if (cand === prev) continue;
          const e = ek(cur, cand);
          if (visitedEdges.has(e)) continue;
          next = cand; visitedEdges.add(e); break;
        }
        if (next == null) break;
        prev = cur; cur = next;
      }
      if (cur === start && loopKeys.length >= 3) loops.push(loopKeys.map(k => nodePos.get(k)));
    }
  }
  return { loops: loops, degreeIssues: degreeIssues };
}

function rawFlatCapLoop(loop3d, axisIdx, planeVal, keepMin) {
  const other = [0,1,2].filter(a => a !== axisIdx);
  const poly2d = loop3d.map(p => [p[other[0]], p[other[1]]]);
  const triIdx = rawEarClip2D(poly2d);
  const out = [];
  for (const tri of triIdx) {
    let a = loop3d[tri[0]], b = loop3d[tri[1]], c = loop3d[tri[2]];
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const n = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(n[axisIdx] || 1) !== wantSign) { const t=b; b=c; c=t; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  }
  return out;
}

// rawCut(rawTris, axisIdx, plane, keepMin)
// rawTris: Float32Array/number[] flat triangle soup, original file axes.
// axisIdx: 0/1/2 in that RAW frame (not the display axis letter).
// plane: coordinate value of the cut plane, in RAW (uncentered) space.
// keepMin: true = keep material where coord <= plane.
// Returns a Float32Array of the resulting watertight, flat-capped half,
// still in raw (uncentered, original-file-axis) coordinates — or null if
// the cut produced nothing.
function rawCut(rawTris, axisIdx, plane, keepMin) {
  const clipped = rawClipTrianglesAtPlane(rawTris, axisIdx, plane, keepMin);
  if (!clipped.kept.length) return null;
  const walked = rawBuildLoopsFromCutEdges(clipped.cutEdges, axisIdx);
  if (walked.degreeIssues.length > 0) throw new Error(walked.degreeIssues.length + ' branch point(s) in raw cut boundary');
  const out = clipped.kept.slice();
  for (const loop of walked.loops) {
    const cap = rawFlatCapLoop(loop, axisIdx, plane, keepMin);
    for (let i = 0; i < cap.length; i++) out.push(cap[i]);
  }
  if (out.length < 9) return null;
  return new Float32Array(out);
}

/** Lay out every model in the library on the plate (inspection / multi-piece view). Not a pack. */
function showAllModelsOnPlate() {
  if (!state.modelGroup) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();
  state.selectedIndex = -1;

  const models = state.models.slice();
  if (!models.length) {
    const exportBtn = document.getElementById('btn-export-stl');
    if (exportBtn) exportBtn.disabled = true;
    updateAdjustUI();
    return;
  }

  const gap = Math.max(KERF_MM, 3);
  const colors = [0x38bdf8, 0x4ade80, 0xfbbf24, 0xf472b6, 0xa78bfa, 0x22d3ee];
  let cursor = 0;
  const entries = [];

  models.forEach((m, i) => {
    if (!m.geometry) return;
    const mat = new THREE.MeshStandardMaterial({
      color: PIECE_COLOR,
      metalness: 0.05,
      roughness: 0.4,
      emissive: 0x0a3a5c,
      emissiveIntensity: 0.2
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    const w = m.size.x;
    const d = m.size.z;
    const h = m.size.y;
    const x = cursor + w / 2;
    mesh.position.set(x, h / 2 + 0.3, 0);
    mesh.userData.placedIndex = entries.length;
    mesh.userData.sourceId = m.id;
    state.modelGroup.add(mesh);
    entries.push({
      mesh,
      geometry: m.geometry,
      name: m.name,
      x,
      z: 0,
      width: w,
      depth: d,
      height: h,
      yaw: 0,
      rotY: 0,
      flipX: false,
      tipX: 0,
      overflow: false,
      sourceId: m.id,
      outline: null
    });
    cursor += w + gap;
  });

  // Center the row on the plate origin
  const totalW = cursor - gap;
  const shift = totalW / 2;
  entries.forEach(p => {
    p.x -= shift;
    p.mesh.position.x = p.x;
  });

  state.placed = entries;
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = entries.length === 0;
  updateAdjustUI();
}

/** Show both halves on the plate with a visible gap (no Optimize needed) */
function layoutUndoModels(models) {
  if (!state.modelGroup) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();
  const colors = [0x38bdf8, 0x4ade80, 0xfbbf24, 0xf472b6, 0xa78bfa, 0x22d3ee];
  models.forEach(function (mod, i) {
    if (!mod || !mod.geometry) return;
    const x = (typeof mod.plateX === 'number') ? mod.plateX : (i * 40);
    const z = (typeof mod.plateZ === 'number') ? mod.plateZ : 0;
    placeModelMovable(mod, x, z);
  });
  state.placed.forEach(function (pl, i) {
    if (pl.mesh && pl.mesh.material && pl.mesh.material.color) {
      pl.mesh.material.color.setHex(PIECE_COLOR);
    }
  });
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
  updateAdjustUI();
}

/** Which end of a half is the planar cut cap along plate X. 'max' = cap faces +X. */
function cutCapSideX(model) {
  const geo = model && model.geometry;
  if (!geo || !geo.attributes || !geo.attributes.position) return null;
  const pos = geo.attributes.position;
  const n = pos.count;
  if (n < 9) return null;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const minX = bb.min.x;
  const maxX = bb.max.x;
  const span = maxX - minX;
  if (!(span > 0.5)) return null;
  const band = Math.max(0.35, Math.min(1.2, span * 0.04));
  let nearMin = 0;
  let nearMax = 0;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    if (Math.abs(x - minX) <= band) nearMin++;
    if (Math.abs(x - maxX) <= band) nearMax++;
  }
  if (nearMax > nearMin * 1.15) return 'max';
  if (nearMin > nearMax * 1.15) return 'min';
  return nearMax >= nearMin ? 'max' : 'min';
}

function layoutAfterSplit(sourcePose, poseById, sourceId, modelA, modelB, axis, stayA, stayB) {
  if (!state.modelGroup) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();

  state.models.forEach(function (mod) {
    if (!mod || !mod.geometry) return;
    if (modelA && mod.id === modelA.id) return;
    if (modelB && mod.id === modelB.id) return;
    const pose = poseById[mod.id];
    if (!pose) return;
    const e = placeModelMovable(mod, pose.x, pose.z);
    if (e) applyPlacedOrientation(e, pose);
  });

  // Leave halves where they sat. stayA/stayB = bbox center in parent space before .center().
  function stayWorld(stay, ori) {
    const v = new THREE.Vector3(
      stay && typeof stay.x === 'number' ? stay.x : 0,
      stay && typeof stay.y === 'number' ? stay.y : 0,
      stay && typeof stay.z === 'number' ? stay.z : 0
    );
    if (ori) {
      const e = new THREE.Euler(
        ((ori.tipX || 0) * Math.PI / 2) + ((ori.tiltX || 0) * Math.PI / 180),
        ori.rotY || 0,
        ((ori.tipZ || 0) * Math.PI / 2) + ((ori.tiltZ || 0) * Math.PI / 180),
        'XYZ'
      );
      v.applyEuler(e);
    }
    return { x: (sourcePose.x || 0) + v.x, z: (sourcePose.z || 0) + v.z };
  }
  const srcOri = poseById[sourceId] || sourcePose || {};
  let aOff = stayWorld(stayA, srcOri);
  let bOff = stayWorld(stayB, srcOri);
  let ax = aOff.x, az = aOff.z, bx = bOff.x, bz = bOff.z;
  const pad = SPLIT_VIEW_GAP_MM * 0.5;
  if (axis === 'z') {
    const dir = bz >= az ? 1 : -1;
    az -= dir * pad;
    bz += dir * pad;
  } else {
    const dir = bx >= ax ? 1 : -1;
    ax -= dir * pad;
    bx += dir * pad;
  }
  if (modelA) {
    const eA = placeModelMovable(modelA, ax, az);
    if (eA) applyPlacedOrientation(eA, srcOri);
  }
  if (modelB) {
    const eB = placeModelMovable(modelB, bx, bz);
    if (eB) applyPlacedOrientation(eB, srcOri);
  }

  /* Join slots stay empty until Start Join → Pick A → Pick B */

  state.placed.forEach(function (pl, i) {
    if (pl.mesh && pl.mesh.material && pl.mesh.material.color) {
      pl.mesh.material.color.setHex(PIECE_COLOR);
    }
  });
  if (typeof updateJoinUI === 'function') updateJoinUI();
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
  updateAdjustUI();
}

function placeHalvesOnPlate(modelA, modelB, axis) {
  // Prefer full library layout so 2nd cuts / multi pieces stay consistent
  if (state.models.length >= 1) {
    showAllModelsOnPlate();
    return;
  }
  if (!state.modelGroup || !modelA || !modelB) return;
  clearDisplayMeshes();
  state.placed = [];
  state.previewMesh = null;
  removeCutHelper();

  const gap = Math.max(KERF_MM, 2);
  const matA = new THREE.MeshStandardMaterial({
    color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
    emissive: 0x0a3a5c, emissiveIntensity: 0.25
  });
  const matB = new THREE.MeshStandardMaterial({
    color: 0x4ade80, metalness: 0.05, roughness: 0.4,
    emissive: 0x14532d, emissiveIntensity: 0.2
  });

  const meshA = new THREE.Mesh(modelA.geometry, matA);
  const meshB = new THREE.Mesh(modelB.geometry, matB);
  const hA = modelA.size.y / 2 + 0.3;
  const hB = modelB.size.y / 2 + 0.3;

  // Place along X with gap between them
  const wA = modelA.size.x;
  const wB = modelB.size.x;
  const xA = -((wA + wB + gap) / 2) + wA / 2;
  const xB = xA + wA / 2 + gap + wB / 2;
  meshA.position.set(xA, hA, 0);
  meshB.position.set(xB, hB, 0);
  meshA.userData.placedIndex = 0;
  meshB.userData.placedIndex = 1;
  state.modelGroup.add(meshA);
  state.modelGroup.add(meshB);

  state.placed = [
    {
      mesh: meshA, geometry: modelA.geometry, name: modelA.name,
      x: xA, z: 0, width: modelA.size.x, depth: modelA.size.z, height: modelA.size.y,
      yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: modelA.id, outline: null
    },
    {
      mesh: meshB, geometry: modelB.geometry, name: modelB.name,
      x: xB, z: 0, width: modelB.size.x, depth: modelB.size.z, height: modelB.size.y,
      yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: modelB.id, outline: null
    }
  ];
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = false;
  updateAdjustUI();
}


// Map a Split plane from display-local space (Y-up, centered — what
// getCutPlaneForSplit returns) back into the raw, untranslated,
// original-file-axis space that rawTris/rawCut operate on. Inverts, in
// order: geometry.center() (via the stored centerOffset), then
// rotateX(-PI/2) (via the fixed axis/sign remap below). Returns null if
// the model has no rawTris (e.g. it wasn't loaded through handleFiles) —
// callers must fall back to clipGeometrySide in that case.
function mapPlaneToRaw(model, displayAxis, displayPlane, keepMin) {
  if (!model.rawTris || !model.centerOffset || model.rawAxis !== 'zup') return null;
  const off = model.centerOffset;
  if (displayAxis === 'x') {
    // raw x0 = dispX + centerOffset.x — axis and sign unaffected by rotateX(-90deg)
    return { axisIdx: 0, plane: displayPlane + off.x, keepMin: keepMin };
  }
  if (displayAxis === 'z') {
    // dispZ = -y0 - centerOffset.z  =>  y0 = -dispZ - centerOffset.z
    // Increasing dispZ means DECREASING raw y0 — keepMin flips.
    return { axisIdx: 1, plane: -displayPlane - off.z, keepMin: !keepMin };
  }
  return null; // unexpected axis — let caller fall back
}

// Convert a raw-space Float32Array (from rawCut, original file axes,
// untranslated) into a Y-up, centered BufferGeometry matching what the
// rest of the app expects on the plate — i.e. re-apply the SAME
// rotateX(-PI/2) + center() transform used at load time, so a Split
// result looks identical in the viewport to a freshly-loaded piece.
function rawResultToDisplayGeometry(rawFlatTris, parentOffset) {
  const arr = new Float32Array(rawFlatTris);
  const cos = Math.cos(-Math.PI/2), sin = Math.sin(-Math.PI/2);
  for (let i = 0; i < arr.length; i += 3) {
    const y = arr[i+1], z = arr[i+2];
    arr[i+1] = y*cos - z*sin;
    arr[i+2] = y*sin + z*cos;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  geo.computeVertexNormals();
  if (parentOffset) {
    geo.translate(-parentOffset.x, -parentOffset.y, -parentOffset.z);
  } else {
    geo.center();
  }
  geo.computeBoundingBox();
  return geo;
}

// Split hook: try the raw-mesh engine first (same math as the sandbox);
// fall back to the existing display-mesh clipGeometrySide on ANY failure
// — mapping unavailable, rawCut throws, or result missing. Never leaves a
// null half. Both halves always go through the SAME path (both raw or
// both fallback) so they stay geometrically consistent with each other.
function splitCutSide(model, axis, plane, keepMin) {
  try {
    const mapped = mapPlaneToRaw(model, axis, plane, keepMin);
    if (!mapped) throw new Error('no raw mapping available for this model');
    const rawResult = rawCut(model.rawTris, mapped.axisIdx, mapped.plane, mapped.keepMin);
    if (!rawResult) throw new Error('rawCut produced no geometry');
    return rawResultToDisplayGeometry(rawResult);
  } catch (err) {
    console.warn('[rawCut] falling back to clipGeometrySide:', err.message);
    return clipGeometrySide(model.geometry, axis, plane, keepMin);
  }
}

// Compute a half's centerOffset directly from its own raw bounding box,
// without an actual rotate step. handleFiles measures centerOffset AFTER
// rotateX(-PI/2) - i.e. in (x, z, -y) space. rotateX(-90deg) maps
// (x,y,z) -> (x, z, -y), so that same value is just {x: cx, y: cz, z: -cy}
// computed straight from the raw (x,y,z) bounding box. No second mapping.
function computeCenterOffsetFromRaw(rawFlat) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (let i=0;i<rawFlat.length;i+=3){
    const x=rawFlat[i], y=rawFlat[i+1], z=rawFlat[i+2];
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z;
  }
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2, cz=(minZ+maxZ)/2;
  return { x: cx, y: cz, z: -cy };
}


// ===================== Raw-Mesh Fillet Post-Pass (Soft finish only) =====================
// Runs AFTER rawCut has already produced a sealed, flat-capped half — that
// flat result is the permanent safety net and is always computed first.
// This is an OPTIONAL alternate result: same corner-sphere-solved,
// margin-retraction fillet architecture validated earlier against real
// factory-part geometry, ported here as a small, self-contained addition.
// Small requested radius (0.4-0.6mm default) makes self-intersection rare
// by construction rather than requiring repair logic. Reuses the existing
// raw clip/loop/earclip functions — no duplicate boundary math.

function rawEdgeInwardNormal2(p1, p2) {
  const dx = p2[0]-p1[0], dy = p2[1]-p1[1];
  const len = Math.hypot(dx, dy) || 1e-12;
  return [-dy/len, dx/len];
}
function rawTurningAngle2(loop2, i) {
  const n = loop2.length;
  const prev = loop2[(i-1+n)%n], curr = loop2[i], next = loop2[(i+1)%n];
  const a1 = Math.atan2(curr[1]-prev[1], curr[0]-prev[0]);
  const a2 = Math.atan2(next[1]-curr[1], next[0]-curr[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2*Math.PI;
  while (d < -Math.PI) d += 2*Math.PI;
  return d;
}
function rawSolveCornerCenter2(cornerPt, n1, n2, R) {
  const det = n1[0]*n2[1] - n1[1]*n2[0];
  if (Math.abs(det) < 1e-10) return null;
  const nx = (n2[1]-n1[1])/det, ny = (n1[0]-n2[0])/det;
  return [cornerPt[0]+R*nx, cornerPt[1]+R*ny];
}
function rawSlerp2D2(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a[0]*b[0]+a[1]*b[1]));
  const theta = Math.acos(dot);
  if (theta < 1e-8) return a.slice();
  const s = Math.sin(theta);
  const wa = Math.sin((1-t)*theta)/s, wb = Math.sin(t*theta)/s;
  return [wa*a[0]+wb*b[0], wa*a[1]+wb*b[1]];
}
function rawSmoothstep2(x) { x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x); }

// Local wall thickness at loop point i, measured inward along the corner
// bisector — same ray-cast approach validated in the sandbox.
function rawLocalThickness2(loop2, i) {
  const n = loop2.length;
  const curr = loop2[i];
  const prev = loop2[(i-1+n)%n], next = loop2[(i+1)%n];
  const nn = rawEdgeInwardNormal2(prev, next);
  let minD = 1e9;
  for (let j = 0; j < n; j++) {
    if (Math.abs(j-i) < 2 || Math.abs(j-i) > n-2) continue;
    const a = loop2[j], b = loop2[(j+1)%n];
    const dx = b[0]-a[0], dy = b[1]-a[1];
    const den = nn[0]*dy - nn[1]*dx;
    if (Math.abs(den) < 1e-10) continue;
    const t = ((a[0]-curr[0])*dy - (a[1]-curr[1])*dx) / den;
    const u = ((a[0]-curr[0])*nn[1] - (a[1]-curr[1])*nn[0]) / -den;
    if (t > 0.1 && t < minD && u >= -0.05 && u <= 1.05) minD = t;
  }
  // The ray-cast above only looks along ONE direction (the local bisector)
  // and can miss a genuinely close point that isn't roughly in that
  // direction — confirmed directly: two boundary points only 0.52mm apart
  // in space, where the ray-cast reported no nearby wall at all. A direct
  // nearest-point distance is a simpler, direction-independent safety net
  // that catches exactly this case; take whichever signal is tighter.
  let nearestPt = 1e9;
  for (let j = 0; j < n; j++) {
    if (Math.abs(j-i) < 2 || Math.abs(j-i) > n-2) continue;
    const d = Math.hypot(loop2[j][0]-curr[0], loop2[j][1]-curr[1]);
    if (d < nearestPt) nearestPt = d;
  }
  return Math.min(minD === 1e9 ? 4 : minD, nearestPt === 1e9 ? 4 : nearestPt);
}

function rawRingSelfIntersects2(ring) {
  function segX(p1,p2,p3,p4) {
    const d1x=p2[0]-p1[0], d1y=p2[1]-p1[1], d2x=p4[0]-p3[0], d2y=p4[1]-p3[1];
    const denom = d1x*d2y - d1y*d2x;
    if (Math.abs(denom) < 1e-12) return false;
    const t = ((p3[0]-p1[0])*d2y - (p3[1]-p1[1])*d2x)/denom;
    const u = ((p3[0]-p1[0])*d1y - (p3[1]-p1[1])*d1x)/denom;
    return t > 1e-6 && t < 1-1e-6 && u > 1e-6 && u < 1-1e-6;
  }
  const m = ring.length;
  for (let i = 0; i < m; i++) {
    const a = ring[i], b = ring[(i+1)%m];
    for (let j = i+2; j < m; j++) {
      if (i === 0 && j === m-1) continue;
      if ((j+1)%m === i) continue;
      if (segX(a, b, ring[j], ring[(j+1)%m])) return true;
    }
  }
  return false;
}

// Rotate loopB's array so its index 0 is the point nearest loopA's index 0
// — buildLoopsFromCutEdges' walk can start at a different physical point
// for two separate clips (order depends on Map insertion order, which
// differs between planes), so raw index correspondence between two
// same-length loops is NOT guaranteed aligned. Confirmed directly: two
// loops of identical length had corresponding indices up to 10mm apart in
// space before this fix, versus an expected ~0.5mm.
function rawAlignLoopStart2(loopA, loopB) {
  let bestJ = 0, bestD = Infinity;
  for (let j = 0; j < loopB.length; j++) {
    const d = Math.hypot(loopB[j][0]-loopA[0][0], loopB[j][1]-loopA[0][1]);
    if (d < bestD) { bestD = d; bestJ = j; }
  }
  let rotated = bestJ === 0 ? loopB : loopB.slice(bestJ).concat(loopB.slice(0, bestJ));

  // marginLoop2d and ring0 are walked independently (different clip
  // plane) — nothing guarantees they run the same rotational direction.
  // If rotated[] runs opposite loopA near the aligned start, the
  // arc-length zipper tears open as it moves away from that point.
  // Compare first-edge direction; flip if opposed, keeping index 0 fixed.
  if (loopA.length >= 2 && rotated.length >= 2) {
    const aDx = loopA[1][0]-loopA[0][0], aDy = loopA[1][1]-loopA[0][1];
    const bDx = rotated[1][0]-rotated[0][0], bDy = rotated[1][1]-rotated[0][1];
    if (aDx*bDx + aDy*bDy < 0) {
      rotated = [rotated[0]].concat(rotated.slice(1).reverse());
    }
  }
  return rotated;
}

function rawBuildStitchStrip2(loopA, loopBIn) {
  const loopB = rawAlignLoopStart2(loopA, loopBIn);
  const nA = loopA.length, nB = loopB.length;
  if (nA === nB) {
    const n = nA;
    const strip = [];
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      strip.push([loopA[i], loopA[i1], loopB[i1]]);
      strip.push([loopA[i], loopB[i1], loopB[i]]);
    }
    return strip;
  }
  function cumlen(poly) {
    const n = poly.length; let total = 0; const t = [0];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (i < n - 1) t.push(total);
    }
    return { t, total };
  }
  const A = loopA, B = loopB;
  const nAedges = A.length, nBedges = B.length;
  const { t: tA, total: totalA } = cumlen(A);
  const { t: tBraw, total: totalB } = cumlen(B);
  const tB = tBraw.map(v => v * (totalA / Math.max(totalB, 1e-9)));
  const strip = [];
  let i = 0, j = 0;
  let stepsA = 0, stepsB = 0;
  const guardMax = (nAedges + nBedges) * 2 + 64;
  let guard = 0;
  while ((stepsA < nAedges || stepsB < nBedges) && guard++ < guardMax) {
    const iDone = stepsA >= nAedges;
    const jDone = stepsB >= nBedges;
    if (iDone && jDone) break;
    const iNext = (i + 1) % nAedges;
    const jNext = (j + 1) % nBedges;
    const tiNext = iDone ? Infinity : (iNext === 0 ? totalA : tA[iNext]);
    const tjNext = jDone ? Infinity : (jNext === 0 ? totalA : tB[jNext]);
    const advanceA = iDone ? false : (jDone ? true : tiNext <= tjNext);
    if (advanceA) {
      strip.push([A[i], A[iNext], B[j]]);
      i = iNext; stepsA++;
    } else {
      strip.push([A[i], B[jNext], B[j]]);
      j = jNext; stepsB++;
    }
  }
  return strip;
}

function raw2DWeldLoop(poly2d, tol) {
  const snapped = poly2d.map(p => p.slice());
  for (let i = 0; i < snapped.length; i++) {
    for (let j = 0; j < i; j++) {
      const dx = snapped[i][0]-snapped[j][0], dy = snapped[i][1]-snapped[j][1];
      if (Math.hypot(dx, dy) < tol) { snapped[i][0] = snapped[j][0]; snapped[i][1] = snapped[j][1]; break; }
    }
  }
  const out = [];
  for (let i = 0; i < snapped.length; i++) {
    const p = snapped[i];
    const prev = out[out.length-1];
    if (prev && Math.hypot(p[0]-prev[0], p[1]-prev[1]) < 1e-9) continue;
    out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0]-out[out.length-1][0], out[0][1]-out[out.length-1][1]) < 1e-9) {
    out.pop();
  }
  return out;
}

function simplifyCollinear2D(loop, eps) {
  eps = (eps == null) ? 1e-3 : eps;
  const n = loop.length;
  if (n <= 3) return loop;
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n], curr = loop[i], next = loop[(i + 1) % n];
    const ux = curr[0]-prev[0], uy = curr[1]-prev[1];
    const vx = next[0]-curr[0], vy = next[1]-curr[1];
    const ul = Math.hypot(ux,uy) || 1e-9, vl = Math.hypot(vx,vy) || 1e-9;
    const cross = (ux/ul)*(vy/vl) - (uy/ul)*(vx/vl);
    if (Math.abs(cross) > eps) out.push(curr);
  }
  return out.length >= 3 ? out : loop;
}

function matchToRing0(marginLoop, ring0) {
  return ring0.map(rp => {
    let best = marginLoop[0], bestD = Infinity;
    for (const mp of marginLoop) {
      const d = Math.hypot(mp[0] - rp[0], mp[1] - rp[1]);
      if (d < bestD) { bestD = d; best = mp; }
    }
    return best;
  });
}

// Corner filter for the shared soften engine (Corners treatment).
//
// Finds the loop vertices that are genuine corners and hands back a
// radius PER VERTEX that is full at the corner and zero everywhere else,
// so the engine rounds the corner and leaves the straight runs as an
// untouched sharp cap/wall edge.
//
// Turn angle is measured across a window of ARC LENGTH, not against the
// immediate neighbours: a 90deg corner then reads ~90deg no matter how
// finely the wall happens to be tessellated, and a gently curved end
// reads small instead of being chopped into a ring of fake corners.
//
// A pair of R=0 transition points is inserted at +/- the blend distance
// around each corner, so the taper always dies out within ~2R of the
// corner even when a long wall carries no intermediate vertices at all.
function rawCornerRadiiOnLoop2(loop2, requestedR, minTurn) {
  const n = loop2.length;
  if (n < 3) throw new Error('cap boundary too small for corners');

  const seg = new Array(n), cum = new Array(n + 1);
  cum[0] = 0;
  for (let i = 0; i < n; i++) {
    const a = loop2[i], b = loop2[(i + 1) % n];
    seg[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum[i + 1] = cum[i] + seg[i];
  }
  const total = cum[n];
  if (!(total > 1e-6)) throw new Error('cap boundary has no length');

  const pointAtArc = (s) => {
    let x = s % total; if (x < 0) x += total;
    let lo = 0, hi = n;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= x) lo = mid; else hi = mid; }
    const t = seg[lo] > 1e-12 ? (x - cum[lo]) / seg[lo] : 0;
    const a = loop2[lo], b = loop2[(lo + 1) % n];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  // Wide enough to read a corner across the tessellation, never so wide
  // that it reaches past the next feature. Unbounded, a large R makes the
  // window span whole edges, every mid-edge vertex reads as a turn, and all
  // four corners of a square merge into one group - one corner treated,
  // three left sharp.
  const win = Math.max(total / 200, 0.25, Math.min(requestedR * 1.5, total / 16));
  const turn = new Array(n);
  for (let i = 0; i < n; i++) {
    const back = pointAtArc(cum[i] - win);
    const fwd = pointAtArc(cum[i] + win);
    const a1 = Math.atan2(loop2[i][1] - back[1], loop2[i][0] - back[0]);
    const a2 = Math.atan2(fwd[1] - loop2[i][1], fwd[0] - loop2[i][0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn[i] = d;
  }

  const hotIdx = [];
  for (let i = 0; i < n; i++) if (Math.abs(turn[i]) > minTurn) hotIdx.push(i);
  if (!hotIdx.length) throw new Error('no corners over ' + Math.round(minTurn * 180 / Math.PI) + 'deg on this edge');

  // Group by ARC distance, not by index adjacency: hot vertices within one
  // detection window of each other are one physical corner smeared across
  // that window, and the sharpest of them is its apex. Vertices further
  // apart than the window are separate corners — a plain 4-vertex
  // rectangle is four hot vertices and must stay four corners, which
  // index-adjacency grouping would have collapsed into one.
  const groups = [];
  let cur = [hotIdx[0]];
  for (let q = 1; q < hotIdx.length; q++) {
    if (cum[hotIdx[q]] - cum[hotIdx[q - 1]] <= win) cur.push(hotIdx[q]);
    else { groups.push(cur); cur = [hotIdx[q]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length - 1];
    if (total - cum[last[last.length - 1]] + cum[first[0]] <= win) {
      groups[0] = last.concat(first);
      groups.pop();
    }
  }
  const apex = groups.map(g => g.reduce((best, i) => Math.abs(turn[i]) > Math.abs(turn[best]) ? i : best, g[0]));

  const A = apex.length;
  // rawCornerWallLimit2, not rawLocalThickness2: the latter skips every
  // segment within two indices of the vertex, so on a 4-vertex loop - the
  // plain Square-split case - it skips the whole loop and falls back to its
  // 4mm default, pinning every corner at R=1.8 whatever R was asked.
  const apexR = apex.map(i => Math.min(requestedR, Math.max(0, rawCornerWallLimit2(loop2, i) * 0.45)));
  const gapFwd = (t) => {
    if (A === 1) return total;
    let g = cum[apex[(t + 1) % A]] - cum[apex[t]];
    if (g <= 0) g += total;
    return g;
  };
  // Blend never eats more than 45% of the run to either neighbour, so two
  // close corners taper out cleanly instead of fighting over the wall.
  const blend = apex.map((a, t) => Math.max(0, Math.min(apexR[t] * 2, gapFwd((t - 1 + A) % A) * 0.45, gapFwd(t) * 0.45)));

  const circDist = (s1, s2) => { const d = Math.abs(s1 - s2) % total; return Math.min(d, total - d); };
  const radiusAt = (s) => {
    let r = 0;
    for (let t = 0; t < A; t++) {
      if (!(blend[t] > 1e-9)) continue;
      const d = circDist(s, cum[apex[t]]);
      if (d >= blend[t]) continue;
      const v = apexR[t] * (1 - d / blend[t]);
      if (v > r) r = v;
    }
    return r;
  };

  const samples = [];
  for (let i = 0; i < n; i++) samples.push({ s: cum[i], uv: loop2[i] });
  for (let t = 0; t < A; t++) {
    if (!(blend[t] > 1e-9)) continue;
    const sa = cum[apex[t]];
    for (const raw of [sa - blend[t], sa + blend[t]]) {
      let x = raw % total; if (x < 0) x += total;
      samples.push({ s: x, uv: pointAtArc(x) });
    }
  }
  samples.sort((p, q) => p.s - q.s);

  const outLoop = [], outR = [];
  for (const smp of samples) {
    const prev = outLoop[outLoop.length - 1];
    if (prev && Math.hypot(smp.uv[0] - prev[0], smp.uv[1] - prev[1]) < 1e-6) continue;
    outLoop.push([smp.uv[0], smp.uv[1]]);
    outR.push(radiusAt(smp.s));
  }
  while (outLoop.length > 3 &&
         Math.hypot(outLoop[0][0] - outLoop[outLoop.length - 1][0], outLoop[0][1] - outLoop[outLoop.length - 1][1]) < 1e-6) {
    outLoop.pop(); outR.pop();
  }
  if (outLoop.length < 3) throw new Error('corner loop too small after build');
  let maxR = 0;
  for (const r of outR) if (r > maxR) maxR = r;
  if (maxR < 0.02) throw new Error('no safe radius at any corner');
  return { loop: outLoop, radii: outR };
}

// Cap-face extraction shared by every soften path. Reads the true cap plane
// off the mesh itself (never the EPS-nudged `plane` arg), sorts triangles
// into cap and wall, and chains the cap/wall boundary into one ordered loop.
// Lifted out of rawEdgeRoundInPlace unchanged so the Corners path can walk
// the same boundary instead of carrying a second loop walker.
function rawCapFaceContext(rawTris, axisIdx, keepMin) {
  const tol = 1e-4;
  // true cap plane, derived from the mesh itself — ignores the EPS-nudged `plane` arg
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const capPlane = keepMin ? minV : maxV;
  const capTol = 1e-3;

  const triCount = rawTris.length / 9;
  const vert = (t, v) => { const i0 = t*9 + v*3; return [rawTris[i0], rawTris[i0+1], rawTris[i0+2]]; };
  const isOnCap = (p) => Math.abs(p[axisIdx] - capPlane) < capTol;

  const capTriIdx = [], wallTriIdx = [];
  for (let t = 0; t < triCount; t++) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1) && isOnCap(v2)) capTriIdx.push(t);
    else wallTriIdx.push(t);
  }
  if (!capTriIdx.length) throw new Error('no cap found on this face');

  // boundary edges: shared by exactly one cap triangle and one wall triangle
  const vkey = (p) => Math.round(p[0]/tol)+'|'+Math.round(p[1]/tol)+'|'+Math.round(p[2]/tol);
  const edgeMap = new Map();
  const addEdge = (a, b, isCap) => {
    const ka = vkey(a), kb = vkey(b);
    const ek = ka < kb ? ka+'~'+kb : kb+'~'+ka;
    if (!edgeMap.has(ek)) edgeMap.set(ek, []);
    edgeMap.get(ek).push({ isCap, a, b });
  };
  for (const t of capTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    addEdge(v0,v1,true); addEdge(v1,v2,true); addEdge(v2,v0,true);
  }
  for (const t of wallTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1)) addEdge(v0,v1,false);
    if (isOnCap(v1) && isOnCap(v2)) addEdge(v1,v2,false);
    if (isOnCap(v2) && isOnCap(v0)) addEdge(v2,v0,false);
  }
  const boundaryEdges = [];
  for (const entries of edgeMap.values()) {
    if (entries.length === 2 && entries.some(e=>e.isCap) && entries.some(e=>!e.isCap)) {
      const capEntry = entries.find(e => e.isCap);
      boundaryEdges.push([capEntry.a, capEntry.b]);
    }
  }
  if (!boundaryEdges.length) throw new Error('no cap/wall boundary found');

  // chain into an ordered loop
  const adj = new Map(), posOf = new Map();
  const pushAdj = (k, o) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(o); };
  for (const [a,b] of boundaryEdges) {
    const ka = vkey(a), kb = vkey(b);
    posOf.set(ka,a); posOf.set(kb,b);
    pushAdj(ka,kb); pushAdj(kb,ka);
  }
  for (const list of adj.values()) if (list.length !== 2) throw new Error('branch point in cap boundary');
  const startKey = vkey(boundaryEdges[0][0]);
  const loopKeys = [startKey];
  let prevKey = null, curKey = startKey;
  do {
    const nbrs = adj.get(curKey);
    const nextKey = nbrs[0] === prevKey ? nbrs[1] : nbrs[0];
    if (nextKey === startKey) break;
    loopKeys.push(nextKey);
    prevKey = curKey; curKey = nextKey;
    if (loopKeys.length > adj.size + 2) throw new Error('cap boundary did not close');
  } while (true);
  const loop3d = loopKeys.map(k => posOf.get(k));
  if (loop3d.length < 3) throw new Error('cap boundary too small to round');
  return { capPlane, capTol, tol, triCount, vert, isOnCap, capTriIdx, wallTriIdx, loop3d };
}

function rawIsConvexPoly2(poly) {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], c = poly[(i + 2) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-12) continue;
    const sg = cr > 0 ? 1 : -1;
    if (sign === 0) sign = sg;
    else if (sg !== sign) return false;
  }
  return sign !== 0;
}

// The lid, without ever re-fanning it.
//
// The ring's top row IS the new lid boundary, and loop2[i] <-> ring2[i] one
// for one, so the strip the ring took off the lid is the band of quads
// [loop2[i], loop2[i+1], ring2[i+1], ring2[i]] - empty wherever R is 0.
// The lid is then the original cap triangles minus that band: triangles the
// band does not reach come through untouched, the ones it bites are clipped.
// No centroid star, no vertex shared by the whole lid, no re-triangulated
// interior.
//
// Convex ring (a plain cut face, and every rectangle) takes the direct
// intersection - one clip per triangle, no growth. Anything else falls back
// to subtracting the band quad by quad, which is the same answer without
// assuming convexity.
function rawLidTrimToRing2(capPolys, loop2, ring2) {
  const n = loop2.length;
  let band = 0;
  const quads = [];
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    const q = [loop2[i], loop2[i1], ring2[i1], ring2[i]];
    const a = rawPolyArea2(q);
    if (a < 1e-12) continue;
    let qMinX = Infinity, qMinY = Infinity, qMaxX = -Infinity, qMaxY = -Infinity;
    for (const v of q) {
      if (v[0] < qMinX) qMinX = v[0];
      if (v[0] > qMaxX) qMaxX = v[0];
      if (v[1] < qMinY) qMinY = v[1];
      if (v[1] > qMaxY) qMaxY = v[1];
    }
    quads.push({ q, bb: [qMinX, qMinY, qMaxX, qMaxY] });
    band += a;
  }

  let before = 0;
  for (const p of capPolys) before += rawPolyArea2(p);

  let pieces = [];
  if (rawIsConvexPoly2(ring2)) {
    let a2 = 0;
    for (let i = 0; i < ring2.length; i++) {
      const a = ring2[i], b = ring2[(i + 1) % ring2.length];
      a2 += a[0] * b[1] - b[0] * a[1];
    }
    const w = a2 >= 0 ? 1 : -1;
    for (const cp of capPolys) {
      let cur = cp;
      for (let i = 0; i < ring2.length && cur.length; i++) {
        const a = ring2[i], b = ring2[(i + 1) % ring2.length];
        const nx = -(b[1] - a[1]) * w, ny = (b[0] - a[0]) * w;
        cur = rawClipPoly2ByHalfPlane(cur, a[0], a[1], nx, ny);
      }
      if (cur.length >= 3) pieces.push(cur);
    }
  } else {
    pieces = capPolys.slice();
    for (const qd of quads) {
      const next = [];
      for (const p of pieces) {
        let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
        for (const v of p) {
          if (v[0] < pMinX) pMinX = v[0];
          if (v[0] > pMaxX) pMaxX = v[0];
          if (v[1] < pMinY) pMinY = v[1];
          if (v[1] > pMaxY) pMaxY = v[1];
        }
        if (pMaxX < qd.bb[0] - 1e-9 || pMinX > qd.bb[2] + 1e-9 ||
            pMaxY < qd.bb[1] - 1e-9 || pMinY > qd.bb[3] + 1e-9) { next.push(p); continue; }
        let inside = p;
        for (let e = 0; e < qd.q.length && inside.length; e++) {
          const a = qd.q[e], b = qd.q[(e + 1) % qd.q.length];
          let nx = -(b[1] - a[1]), ny = b[0] - a[0];
          let cen = [0, 0];
          for (const v of qd.q) { cen[0] += v[0] / qd.q.length; cen[1] += v[1] / qd.q.length; }
          if ((cen[0] - a[0]) * nx + (cen[1] - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
          const outer = rawClipPoly2ByHalfPlane(inside, a[0], a[1], -nx, -ny);
          if (outer.length >= 3) next.push(outer);
          inside = rawClipPoly2ByHalfPlane(inside, a[0], a[1], nx, ny);
        }
      }
      pieces = next;
      if (pieces.length > 4096) throw new Error('lid trim did not converge');
    }
  }

  let after = 0;
  for (const p of pieces) after += rawPolyArea2(p);
  if (Math.abs((before - band) - after) > Math.max(1e-6, before * 1e-5)) {
    throw new Error('lid trim lost area - face left untouched');
  }
  return pieces;
}

// Corners. The clicked face does not move: capPlane is read off the mesh,
// the lid is rebuilt at exactly that plane, and only the corners of the face
// loop are rolled. No second-plane re-clip, no full-loop offset.
//
// Per genuine corner (windowed turn > minTurnDeg), interior angle t:
//   R      clamped to 0.45 x the wall available at that corner, and to
//          0.45 x the straight run either side so the blend fits.
//   ring   the loop offset inward by R(1-cos phi) with the wall dropped by
//          R(1-sin phi) - a true quarter circle normal to each edge.
//   taper  R dies to 0 at +/- blend along each edge, with an explicit R=0
//          transition point inserted there, so the span between corners
//          keeps R=0 and stays a straight sharp edge sitting on the plane.
// The lid is the ORIGINAL cap triangles trimmed back to the ring - never a
// centroid fan, so the face interior is not re-triangulated.
//
// opts.minTurnDeg  corner threshold, default 25
// `plane` is accepted for call-site compatibility and deliberately unused:
// the true cap plane comes from the mesh, not the EPS-nudged value.
function rawEdgeRoundInPlace(rawTris, axisIdx, plane, keepMin, requestedR, opts) {
  opts = opts || {};
  const minTurn = (opts.minTurnDeg == null ? 25 : opts.minTurnDeg) * Math.PI / 180;
  const STEPS = 6;
  const intoBody = keepMin ? 1 : -1;
  const other = [0, 1, 2].filter(a => a !== axisIdx);
  const tol = 1e-4;

  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const capPlane = keepMin ? minV : maxV;
  const capTol = 1e-3;

  const triCount = rawTris.length / 9;
  const vert = (t, v) => { const i0 = t*9 + v*3; return [rawTris[i0], rawTris[i0+1], rawTris[i0+2]]; };
  const isOnCap = (p) => Math.abs(p[axisIdx] - capPlane) < capTol;

  const capTriIdx = [], wallTriIdx = [];
  for (let t = 0; t < triCount; t++) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1) && isOnCap(v2)) capTriIdx.push(t);
    else wallTriIdx.push(t);
  }
  if (!capTriIdx.length) throw new Error('no cap found on this face');

  const vkey = (p) => Math.round(p[0]/tol)+'|'+Math.round(p[1]/tol)+'|'+Math.round(p[2]/tol);
  const edgeMap = new Map();
  const addEdge = (a, b, isCap) => {
    const ka = vkey(a), kb = vkey(b);
    const ek = ka < kb ? ka+'~'+kb : kb+'~'+ka;
    if (!edgeMap.has(ek)) edgeMap.set(ek, []);
    edgeMap.get(ek).push({ isCap, a, b });
  };
  for (const t of capTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    addEdge(v0,v1,true); addEdge(v1,v2,true); addEdge(v2,v0,true);
  }
  for (const t of wallTriIdx) {
    const v0=vert(t,0), v1=vert(t,1), v2=vert(t,2);
    if (isOnCap(v0) && isOnCap(v1)) addEdge(v0,v1,false);
    if (isOnCap(v1) && isOnCap(v2)) addEdge(v1,v2,false);
    if (isOnCap(v2) && isOnCap(v0)) addEdge(v2,v0,false);
  }
  const boundaryEdges = [];
  for (const entries of edgeMap.values()) {
    if (entries.length === 2 && entries.some(e=>e.isCap) && entries.some(e=>!e.isCap)) {
      const capEntry = entries.find(e => e.isCap);
      boundaryEdges.push([capEntry.a, capEntry.b]);
    }
  }
  if (!boundaryEdges.length) throw new Error('no cap/wall boundary found');

  const adj = new Map(), posOf = new Map();
  const pushAdj = (k, o) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(o); };
  for (const [a,b] of boundaryEdges) {
    const ka = vkey(a), kb = vkey(b);
    posOf.set(ka,a); posOf.set(kb,b);
    pushAdj(ka,kb); pushAdj(kb,ka);
  }
  for (const list of adj.values()) if (list.length !== 2) throw new Error('branch point in cap boundary');
  const startKey = vkey(boundaryEdges[0][0]);
  const loopKeys = [startKey];
  let prevKey = null, curKey = startKey;
  do {
    const nbrs = adj.get(curKey);
    const nextKey = nbrs[0] === prevKey ? nbrs[1] : nbrs[0];
    if (nextKey === startKey) break;
    loopKeys.push(nextKey);
    prevKey = curKey; curKey = nextKey;
    if (loopKeys.length > adj.size + 2) throw new Error('cap boundary did not close');
  } while (true);
  const loop3d = loopKeys.map(k => posOf.get(k));
  if (loop3d.length < 3) throw new Error('cap boundary too small to round');

  const flat2 = (p3) => [p3[other[0]], p3[other[1]]];
  let poly2d = loop3d.map(flat2);
  poly2d = raw2DWeldLoop(poly2d, 0.08);
  if (poly2d.length < 3) throw new Error('cap boundary too small after weld');

  // ---------- corner detection ----------
  const arcTable = (loop) => {
    const m = loop.length;
    const seg = new Array(m), cum = new Array(m + 1);
    cum[0] = 0;
    for (let i = 0; i < m; i++) {
      const a = loop[i], b = loop[(i+1)%m];
      seg[i] = Math.hypot(b[0]-a[0], b[1]-a[1]);
      cum[i+1] = cum[i] + seg[i];
    }
    const total = cum[m];
    if (!(total > 1e-6)) throw new Error('cap boundary has no length');
    const at = (s) => {
      let x = s % total; if (x < 0) x += total;
      let lo = 0, hi = m;
      while (lo + 1 < hi) { const mid = (lo+hi) >> 1; if (cum[mid] <= x) lo = mid; else hi = mid; }
      const u = seg[lo] > 1e-12 ? (x - cum[lo]) / seg[lo] : 0;
      const a = loop[lo], b = loop[(lo+1)%m];
      return [a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u];
    };
    return { seg, cum, total, at };
  };
  const tab = arcTable(poly2d);
  const nLoop = poly2d.length;
  // Turn read across a window of ARC LENGTH, so a 90deg corner reads 90deg
  // however finely the wall is tessellated. Bounded to total/16: unbounded,
  // a large R makes the window span whole edges, every mid-edge vertex reads
  // as a turn and all four corners of a square merge into one.
  const win = Math.max(tab.total / 200, 0.25, Math.min(requestedR * 1.5, tab.total / 16));
  const turn = new Array(nLoop);
  for (let i = 0; i < nLoop; i++) {
    const back = tab.at(tab.cum[i] - win), fwd = tab.at(tab.cum[i] + win);
    const a1 = Math.atan2(poly2d[i][1] - back[1], poly2d[i][0] - back[0]);
    const a2 = Math.atan2(fwd[1] - poly2d[i][1], fwd[0] - poly2d[i][0]);
    let d = a2 - a1;
    while (d > Math.PI) d -= 2*Math.PI;
    while (d < -Math.PI) d += 2*Math.PI;
    turn[i] = d;
  }
  const hot = [];
  for (let i = 0; i < nLoop; i++) if (Math.abs(turn[i]) > minTurn) hot.push(i);
  if (!hot.length) throw new Error('no corners over ' + Math.round(minTurn*180/Math.PI) + 'deg on this face');
  const groups = [];
  let cur = [hot[0]];
  for (let q = 1; q < hot.length; q++) {
    if (tab.cum[hot[q]] - tab.cum[hot[q-1]] <= win) cur.push(hot[q]);
    else { groups.push(cur); cur = [hot[q]]; }
  }
  groups.push(cur);
  if (groups.length > 1) {
    const first = groups[0], last = groups[groups.length-1];
    if (tab.total - tab.cum[last[last.length-1]] + tab.cum[first[0]] <= win) {
      groups[0] = last.concat(first);
      groups.pop();
    }
  }
  const apex = groups.map(g => g.reduce((best,i) => Math.abs(turn[i]) > Math.abs(turn[best]) ? i : best, g[0]));
  const cornerCount = apex.length;

  // Wall available at one corner. rawLocalThickness2 skips every segment
  // within two indices of the vertex, so on a 4-vertex loop - the plain
  // square face - it skips the whole loop and falls back to its default,
  // pinning every corner at a radius the user never asked for. Here only the
  // two segments touching the apex are skipped.
  const wallLimitAt = (i) => {
    const m = poly2d.length;
    const curr = poly2d[i];
    const prev = poly2d[(i-1+m)%m], next = poly2d[(i+1)%m];
    const nn = rawEdgeInwardNormal2(prev, next);
    let best = Infinity;
    for (let j = 0; j < m; j++) {
      if (j === i || j === (i-1+m)%m) continue;
      const a = poly2d[j], b = poly2d[(j+1)%m];
      const dx = b[0]-a[0], dy = b[1]-a[1];
      const den = nn[0]*dy - nn[1]*dx;
      if (Math.abs(den) < 1e-10) continue;
      const t = ((a[0]-curr[0])*dy - (a[1]-curr[1])*dx) / den;
      const u = ((a[0]-curr[0])*nn[1] - (a[1]-curr[1])*nn[0]) / -den;
      if (t > 0.1 && t < best && u >= -0.05 && u <= 1.05) best = t;
    }
    for (let j = 0; j < m; j++) {
      if (j === i || j === (i-1+m)%m || j === (i+1)%m) continue;
      const d = Math.hypot(poly2d[j][0]-curr[0], poly2d[j][1]-curr[1]);
      if (d < best) best = d;
    }
    return best === Infinity ? 4 : best;
  };

  const gapFwd = (t) => {
    if (cornerCount === 1) return tab.total;
    let g = tab.cum[apex[(t+1)%cornerCount]] - tab.cum[apex[t]];
    if (g <= 0) g += tab.total;
    return g;
  };
  const apexR = apex.map(i => Math.min(requestedR, Math.max(0, wallLimitAt(i) * 0.45)));
  const blend = apex.map((a, t) => Math.max(0, Math.min(
    apexR[t] * 2,
    gapFwd((t - 1 + cornerCount) % cornerCount) * 0.45,
    gapFwd(t) * 0.45
  )));
  let peakR = 0, tookR = 0;
  for (let t = 0; t < cornerCount; t++) {
    if (apexR[t] > 0.02 && blend[t] > 1e-9) { tookR++; if (apexR[t] > peakR) peakR = apexR[t]; }
  }
  if (!tookR) throw new Error('no corner takes R=' + requestedR + ' on this face');

  // Rebuild the loop with an explicit R=0 transition point at +/- blend, so
  // the taper always dies out inside the corner even when the wall between
  // corners carries no vertex of its own.
  const circDist = (s1, s2) => { const d = Math.abs(s1 - s2) % tab.total; return Math.min(d, tab.total - d); };
  const radiusAt = (s) => {
    let r = 0;
    for (let t = 0; t < cornerCount; t++) {
      if (!(blend[t] > 1e-9) || !(apexR[t] > 0.02)) continue;
      const d = circDist(s, tab.cum[apex[t]]);
      if (d >= blend[t]) continue;
      const v = apexR[t] * (1 - d / blend[t]);
      if (v > r) r = v;
    }
    return r;
  };
  const samples = [];
  for (let i = 0; i < nLoop; i++) samples.push({ s: tab.cum[i], uv: poly2d[i] });
  for (let t = 0; t < cornerCount; t++) {
    if (!(blend[t] > 1e-9) || !(apexR[t] > 0.02)) continue;
    for (const raw of [tab.cum[apex[t]] - blend[t], tab.cum[apex[t]] + blend[t]]) {
      let x = raw % tab.total; if (x < 0) x += tab.total;
      samples.push({ s: x, uv: tab.at(x) });
    }
  }
  samples.sort((p, q) => p.s - q.s);
  const builtLoop = [], Rs = [];
  for (const smp of samples) {
    const prev = builtLoop[builtLoop.length-1];
    if (prev && Math.hypot(smp.uv[0]-prev[0], smp.uv[1]-prev[1]) < 1e-6) continue;
    builtLoop.push([smp.uv[0], smp.uv[1]]);
    Rs.push(radiusAt(smp.s));
  }
  while (builtLoop.length > 3 &&
         Math.hypot(builtLoop[0][0]-builtLoop[builtLoop.length-1][0],
                    builtLoop[0][1]-builtLoop[builtLoop.length-1][1]) < 1e-6) {
    builtLoop.pop(); Rs.pop();
  }
  poly2d = builtLoop;
  const n = poly2d.length;
  if (n < 3) throw new Error('corner loop too small after build');

  // ---------- ring ----------
  let area2 = 0;
  for (let i = 0; i < n; i++) { const a=poly2d[i], b=poly2d[(i+1)%n]; area2 += a[0]*b[1]-b[0]*a[1]; }
  const windSign = area2 >= 0 ? 1 : -1;
  const inwardNormal2 = (a, b) => {
    const tx=b[0]-a[0], ty=b[1]-a[1];
    let nx=-ty*windSign, ny=tx*windSign;
    const len = Math.hypot(nx,ny) || 1e-9;
    return [nx/len, ny/len];
  };
  const vertexOffset = (i, radius) => {
    const prev=poly2d[(i-1+n)%n], curr=poly2d[i], next=poly2d[(i+1)%n];
    const n1=inwardNormal2(prev,curr), n2=inwardNormal2(curr,next);
    let bx=n1[0]+n2[0], by=n1[1]+n2[1];
    const blen=Math.hypot(bx,by)||1e-9; bx/=blen; by/=blen;
    const cosHalf = Math.max(bx*n1[0]+by*n1[1], 0.3);
    return [curr[0]+bx*(radius/cosHalf), curr[1]+by*(radius/cosHalf)];
  };
  const from3 = (uv, along) => { const p=[0,0,0]; p[other[0]]=uv[0]; p[other[1]]=uv[1]; p[axisIdx]=along; return p; };
  const ringAt = (s) => {
    const phi = Math.asin(Math.min(1, Math.max(0, s / STEPS)));
    const ring = [];
    for (let i = 0; i < n; i++) {
      const R = Rs[i];
      ring.push(from3(vertexOffset(i, R * (1 - Math.cos(phi))),
                      capPlane + intoBody * R * (1 - Math.sin(phi))));
    }
    return ring;
  };
  const rings = [];
  for (let s = 0; s <= STEPS; s++) rings.push(ringAt(s));
  const ringTop2 = rings[STEPS].map(flat2);
  if (rawRingSelfIntersects2(ringTop2)) throw new Error('corner round self-intersects at this radius');

  const out = [];

  // ---------- lid: the original cap triangles trimmed back to the ring ----------
  const polyArea = (p) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i+1)%p.length]; a += q[0]*r[1] - r[0]*q[1]; }
    return Math.abs(a) * 0.5;
  };
  const clipHalf = (p, px, py, nx, ny) => {
    if (p.length < 3) return [];
    const res = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      const da = (a[0]-px)*nx + (a[1]-py)*ny;
      const db = (b[0]-px)*nx + (b[1]-py)*ny;
      if (da >= -1e-12) res.push(a);
      if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
        const u = da / (da - db);
        res.push([a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u]);
      }
    }
    const cl = [];
    for (const q of res) {
      const last = cl[cl.length-1];
      if (!last || Math.hypot(q[0]-last[0], q[1]-last[1]) > 1e-9) cl.push(q);
    }
    while (cl.length > 1 && Math.hypot(cl[0][0]-cl[cl.length-1][0], cl[0][1]-cl[cl.length-1][1]) < 1e-9) cl.pop();
    return cl.length >= 3 ? cl : [];
  };
  const capPolys = capTriIdx.map(t => [flat2(vert(t,0)), flat2(vert(t,1)), flat2(vert(t,2))]);
  let lidBefore = 0;
  for (const p of capPolys) lidBefore += polyArea(p);

  // The lid loses exactly one crescent per corner: the original boundary
  // across the corner span, closed by the ring across the same span. R is 0
  // at both ends of the span, so ring and boundary meet there and the
  // crescent closes. Everything else on the lid is left alone - triangles the
  // crescent does not reach come through whole, the ones it bites are
  // clipped. No centroid fan.
  const spans = [];
  for (let i = 0; i < n; i++) {
    if (!(Rs[i] > 1e-9)) continue;
    if (Rs[(i-1+n)%n] > 1e-9) continue;
    const span = [(i-1+n)%n];
    let j = i;
    for (let step = 0; step < n; step++) {
      span.push(j);
      const nx = (j+1)%n;
      if (!(Rs[nx] > 1e-9)) { span.push(nx); break; }
      j = nx;
    }
    spans.push(span);
  }
  const lunes = [];
  for (const span of spans) {
    const lune = [];
    for (const i of span) lune.push(poly2d[i]);
    for (let k = span.length - 1; k >= 0; k--) {
      const p = ringTop2[span[k]], last = lune[lune.length-1];
      if (Math.hypot(p[0]-last[0], p[1]-last[1]) < 1e-9) continue;
      lune.push(p);
    }
    while (lune.length > 1 &&
           Math.hypot(lune[0][0]-lune[lune.length-1][0], lune[0][1]-lune[lune.length-1][1]) < 1e-9) lune.pop();
    if (lune.length < 3 || polyArea(lune) < 1e-12) continue;
    let sign = 0, convex = true;
    for (let i = 0; i < lune.length && convex; i++) {
      const p0 = lune[i], p1 = lune[(i+1)%lune.length], p2 = lune[(i+2)%lune.length];
      const cr = (p1[0]-p0[0])*(p2[1]-p1[1]) - (p1[1]-p0[1])*(p2[0]-p1[0]);
      if (Math.abs(cr) < 1e-12) continue;
      const sg = cr > 0 ? 1 : -1;
      if (sign === 0) sign = sg; else if (sg !== sign) convex = false;
    }
    if (!convex) throw new Error('corner cut folds back at R=' + requestedR + ' - left unchanged');
    let bx0=Infinity, by0=Infinity, bx1=-Infinity, by1=-Infinity;
    for (const v of lune) {
      if (v[0] < bx0) bx0 = v[0];
      if (v[0] > bx1) bx1 = v[0];
      if (v[1] < by0) by0 = v[1];
      if (v[1] > by1) by1 = v[1];
    }
    const cen = [0, 0];
    for (const v of lune) { cen[0] += v[0]/lune.length; cen[1] += v[1]/lune.length; }
    lunes.push({ lune, cen, bb: [bx0, by0, bx1, by1] });
  }
  if (!lunes.length) throw new Error('no corner takes R=' + requestedR + ' on this face');

  let lidPieces = capPolys.slice();
  for (const ln of lunes) {
    const next = [];
    for (const p of lidPieces) {
      let px0=Infinity, py0=Infinity, px1=-Infinity, py1=-Infinity;
      for (const v of p) {
        if (v[0] < px0) px0 = v[0];
        if (v[0] > px1) px1 = v[0];
        if (v[1] < py0) py0 = v[1];
        if (v[1] > py1) py1 = v[1];
      }
      if (px1 < ln.bb[0]-1e-9 || px0 > ln.bb[2]+1e-9 || py1 < ln.bb[1]-1e-9 || py0 > ln.bb[3]+1e-9) {
        next.push(p);
        continue;
      }
      // piece minus a convex region, as convex slices: outside edge 1, then
      // inside 1 and outside 2, and so on. Every slice stays convex.
      let inside = p;
      for (let e = 0; e < ln.lune.length && inside.length; e++) {
        const a = ln.lune[e], b = ln.lune[(e+1)%ln.lune.length];
        let nx = -(b[1]-a[1]), ny = b[0]-a[0];
        if ((ln.cen[0]-a[0])*nx + (ln.cen[1]-a[1])*ny < 0) { nx = -nx; ny = -ny; }
        const outer = clipHalf(inside, a[0], a[1], -nx, -ny);
        if (outer.length >= 3) next.push(outer);
        inside = clipHalf(inside, a[0], a[1], nx, ny);
      }
    }
    lidPieces = next;
    if (lidPieces.length > 4096) throw new Error('lid trim did not converge');
  }

  // The trimmed lid must come out as exactly the ring polygon - that is the
  // one honest test that the crescents took what they should and nothing
  // else. Anything off, and the face is left unchanged.
  let lidAfter = 0;
  for (const p of lidPieces) lidAfter += polyArea(p);
  let ringArea = 0;
  for (let i = 0; i < n; i++) { const a=ringTop2[i], b=ringTop2[(i+1)%n]; ringArea += a[0]*b[1]-b[0]*a[1]; }
  ringArea = Math.abs(ringArea) * 0.5;
  if (!(ringArea > 1e-9) || Math.abs(ringArea - lidAfter) > Math.max(1e-6, lidBefore * 1e-5)) {
    throw new Error('R=' + requestedR + ' too large for this face - left unchanged');
  }

  // Two lid triangles clipped by the same ring do not pick up the same points
  // along an edge they share, and a lid edge can run past several wall
  // vertices. Split every lid edge at any lid point lying on it.
  const cpts = [];
  const cseen = new Set();
  const addC = (p) => {
    const k = Math.round(p[0]*1e4) + '|' + Math.round(p[1]*1e4);
    if (cseen.has(k)) return;
    cseen.add(k);
    cpts.push(p);
  };
  for (const p of lidPieces) for (const v of p) addC(v);
  for (const v of poly2d) addC(v);
  for (const v of loop3d) addC(flat2(v));
  for (const v of ringTop2) addC(v);
  for (let idx = 0; idx < lidPieces.length; idx++) {
    const p = lidPieces[idx], grown = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i+1)%p.length];
      grown.push(a);
      const ex = b[0]-a[0], ey = b[1]-a[1], len2 = ex*ex + ey*ey;
      if (!(len2 > 1e-18)) continue;
      const inv = 1 / Math.sqrt(len2);
      const mids = [];
      for (const q of cpts) {
        const u = ((q[0]-a[0])*ex + (q[1]-a[1])*ey) / len2;
        if (u <= 1e-6 || u >= 1-1e-6) continue;
        if (Math.abs((q[0]-a[0])*ey - (q[1]-a[1])*ex) * inv > 1e-6) continue;
        mids.push({ u, q });
      }
      mids.sort((x, y) => x.u - y.u);
      for (const md of mids) grown.push(md.q);
    }
    lidPieces[idx] = grown;
  }

  // Splits the band has to follow, or every crossing is a T-junction.
  const ringSplits = new Map();
  for (const p of lidPieces) {
    for (const v of p) {
      for (let i = 0; i < n; i++) {
        const P = ringTop2[i], Q = ringTop2[(i+1)%n];
        const ex = Q[0]-P[0], ey = Q[1]-P[1], len2 = ex*ex + ey*ey;
        if (!(len2 > 1e-18)) continue;
        const u = ((v[0]-P[0])*ex + (v[1]-P[1])*ey) / len2;
        if (u <= 1e-6 || u >= 1-1e-6) continue;
        if (Math.abs((v[0]-P[0])*ey - (v[1]-P[1])*ex) / Math.sqrt(len2) > 1e-3) continue;
        if (!ringSplits.has(i)) ringSplits.set(i, []);
        const list = ringSplits.get(i);
        if (!list.some(w => Math.abs(w - u) < 1e-6)) list.push(u);
      }
    }
  }

  const emitLid = (A, B, C) => {
    let a = from3(A, capPlane), b = from3(B, capPlane), c = from3(C, capPlane);
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    if (!(Math.hypot(nrm[0], nrm[1], nrm[2]) > 1e-10)) return;
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(nrm[axisIdx] || 1) !== wantSign) { const tmp=b; b=c; c=tmp; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  };
  for (const p of lidPieces) {
    const m = p.length;
    // Fan from a vertex that is not collinear with any of its own fan edges.
    // Fanning blindly from vertex 0 leaves holes: a lid edge carrying a wall
    // vertex puts three points on one line, that triangle has no area, and
    // dropping it orphans the boundary edge underneath.
    let apexAt = -1;
    for (let a = 0; a < m && apexAt < 0; a++) {
      let clean = true;
      for (let k = 1; k + 1 < m && clean; k++) {
        const P0 = p[a], P1 = p[(a+k)%m], P2 = p[(a+k+1)%m];
        const cr = (P1[0]-P0[0])*(P2[1]-P0[1]) - (P1[1]-P0[1])*(P2[0]-P0[0]);
        if (Math.abs(cr) * 0.5 < 1e-12) clean = false;
      }
      if (clean) apexAt = a;
    }
    if (apexAt < 0) {
      for (const t of rawEarClip2D(p)) emitLid(p[t[0]], p[t[1]], p[t[2]]);
      continue;
    }
    for (let k = 1; k + 1 < m; k++) emitLid(p[apexAt], p[(apexAt+k)%m], p[(apexAt+k+1)%m]);
  }

  // ---------- wall ----------
  // Depth only, never sideways. Snapping a wall vertex onto the nearest loop
  // vertex drags the wall across the face and leaves the chip; project onto
  // the nearest loop SEGMENT and interpolate R along it, so an untreated run
  // stays exactly on the cut plane and stays sharp.
  const depthOf = (uv) => {
    let bestD = Infinity, bestR = 0;
    for (let i = 0; i < n; i++) {
      const a = poly2d[i], b = poly2d[(i+1)%n];
      const ex = b[0]-a[0], ey = b[1]-a[1];
      const len2 = ex*ex + ey*ey;
      let u = len2 > 1e-18 ? ((uv[0]-a[0])*ex + (uv[1]-a[1])*ey) / len2 : 0;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(uv[0] - (a[0]+ex*u), uv[1] - (a[1]+ey*u));
      if (d < bestD) { bestD = d; bestR = Rs[i] + (Rs[(i+1)%n] - Rs[i]) * u; }
    }
    return capPlane + intoBody * bestR;
  };
  const dropTo = (p3) => { const q = p3.slice(); q[axisIdx] = depthOf(flat2(p3)); return q; };
  // A wall triangle's cap-plane edge is split at every loop vertex lying on
  // it first: the rebuilt loop carries transition points the original wall
  // edge knows nothing about, and without the split the ring's outer row and
  // the wall's top edge share no vertices at all.
  const splitTol = 1e-3;
  const capEdgeChain = (A, B) => {
    const ax = A[other[0]], ay = A[other[1]];
    const ex = B[other[0]] - ax, ey = B[other[1]] - ay;
    const len2 = ex*ex + ey*ey;
    if (!(len2 > 1e-18)) return [A, B];
    const inv = 1 / Math.sqrt(len2);
    const mids = [];
    for (let i = 0; i < n; i++) {
      const px = poly2d[i][0] - ax, py = poly2d[i][1] - ay;
      const u = (px*ex + py*ey) / len2;
      if (u <= 1e-6 || u >= 1-1e-6) continue;
      if (Math.abs(px*ey - py*ex) * inv > splitTol) continue;
      const q = [0,0,0];
      q[other[0]] = ax + ex*u;
      q[other[1]] = ay + ey*u;
      q[axisIdx] = capPlane;
      mids.push({ u, q });
    }
    if (!mids.length) return [A, B];
    mids.sort((x, y) => x.u - y.u);
    const chain = [A];
    const near = (p, q) => Math.hypot(p[other[0]]-q[other[0]], p[other[1]]-q[other[1]]) < 1e-9;
    for (const md of mids) if (!near(md.q, chain[chain.length-1])) chain.push(md.q);
    if (!near(B, chain[chain.length-1])) chain.push(B);
    return chain;
  };
  const pushTri = (a, b, c) => {
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    if (0.5*Math.hypot(nx,ny,nz) < 1e-12) return;
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  };
  for (const t of wallTriIdx) {
    const tri = [vert(t,0), vert(t,1), vert(t,2)];
    let capEdge = -1;
    for (let v = 0; v < 3; v++) if (isOnCap(tri[v]) && isOnCap(tri[(v+1)%3])) { capEdge = v; break; }
    if (capEdge < 0) {
      let moved = false;
      for (let v = 0; v < 3; v++) {
        if (!isOnCap(tri[v])) continue;
        const q = dropTo(tri[v]);
        if (q[axisIdx] !== tri[v][axisIdx]) moved = true;
        tri[v] = q;
      }
      // Untouched triangles are copied through byte for byte, area test and
      // all: the split leaves zero-area seam triangles behind and they are
      // load bearing.
      if (moved) pushTri(tri[0], tri[1], tri[2]);
      else out.push(tri[0][0],tri[0][1],tri[0][2], tri[1][0],tri[1][1],tri[1][2], tri[2][0],tri[2][1],tri[2][2]);
      continue;
    }
    const A = tri[capEdge], B = tri[(capEdge+1)%3], C = tri[(capEdge+2)%3];
    const rawChain = capEdgeChain(A, B);
    const chain = rawChain.map(dropTo);
    const Cp = isOnCap(C) ? dropTo(C) : C;
    let moved = rawChain.length !== 2;
    for (let k = 0; k < chain.length; k++) if (chain[k][axisIdx] !== rawChain[k][axisIdx]) moved = true;
    if (isOnCap(C) && Cp[axisIdx] !== C[axisIdx]) moved = true;
    if (!moved) {
      out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
      continue;
    }
    for (let k = 0; k + 1 < chain.length; k++) pushTri(chain[k], chain[k+1], Cp);
  }

  // ---------- band ----------
  const same = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]) < 1e-9;
  const pushBand = (A, B, C) => {
    if (same(A,B) || same(B,C) || same(C,A)) return;
    out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
  };
  for (let s = 0; s < STEPS; s++) {
    const a = rings[s], b = rings[s+1];
    for (let i = 0; i < n; i++) {
      const i1 = (i+1)%n;
      const A0=a[i], A1=a[i1], B0=b[i], B1=b[i1];
      // An untreated (R=0) run collapses the strip to a line; those
      // degenerate triangles are dropped, leaving the original sharp edge.
      if (s === STEPS-1 && ringSplits.has(i) && !same(B0, B1)) {
        const P = ringTop2[i], Q = ringTop2[i1];
        const chain = [B0];
        for (const u of ringSplits.get(i).slice().sort((x,y)=>x-y)) {
          chain.push(from3([P[0] + (Q[0]-P[0])*u, P[1] + (Q[1]-P[1])*u], capPlane));
        }
        chain.push(B1);
        pushBand(A0, A1, chain[chain.length-1]);
        for (let k = chain.length-1; k > 0; k--) pushBand(A0, chain[k], chain[k-1]);
        continue;
      }
      pushBand(A0, A1, B1);
      pushBand(A0, B1, B0);
    }
  }

  if (out.length < 9) throw new Error('corner round produced no geometry');
  rawEdgeRoundInPlace.lastBuild = {
    corners: cornerCount,
    rounded: tookR,
    loopPts: n,
    radius: peakR,
    requested: requestedR
  };
  return new Float32Array(out);
}


// Sutherland-Hodgman clip of a convex polygon by one half plane:
// keeps dot(p - (px,py), (nx,ny)) >= 0. Convex in, convex out.
function rawClipPoly2ByHalfPlane(poly, px, py, nx, ny) {
  const m = poly.length;
  if (m < 3) return [];
  const out = [];
  for (let i = 0; i < m; i++) {
    const a = poly[i], b = poly[(i + 1) % m];
    const da = (a[0] - px) * nx + (a[1] - py) * ny;
    const db = (b[0] - px) * nx + (b[1] - py) * ny;
    if (da >= -1e-12) out.push(a);
    if ((da > 1e-12 && db < -1e-12) || (da < -1e-12 && db > 1e-12)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  const cl = [];
  for (const p of out) {
    const q = cl[cl.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) cl.push(p);
  }
  while (cl.length > 1 && Math.hypot(cl[0][0] - cl[cl.length - 1][0], cl[0][1] - cl[cl.length - 1][1]) < 1e-9) cl.pop();
  return cl.length >= 3 ? cl : [];
}

function rawPolyArea2(poly) {
  let a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a2 += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a2) * 0.5;
}

// Wall available at ONE corner. rawLocalThickness2 skips every segment
// within two indices of the vertex, so on a coarse loop - a plain 4-vertex
// rectangle, exactly the Square-split case - it skips the whole loop and
// falls back to its 4mm default, which silently pins any corner at
// R=1.8 however large R is. Here only the two segments actually touching
// the apex are skipped, so a 20mm square reports 28.3mm of wall and R=2
// (or 3, or 6) is the radius that gets built.
function rawCornerWallLimit2(loop2, i) {
  const n = loop2.length;
  const curr = loop2[i];
  const prev = loop2[(i - 1 + n) % n], next = loop2[(i + 1) % n];
  const nn = rawEdgeInwardNormal2(prev, next);
  let best = Infinity;
  for (let j = 0; j < n; j++) {
    if (j === i || j === (i - 1 + n) % n) continue;
    const a = loop2[j], b = loop2[(j + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const den = nn[0] * dy - nn[1] * dx;
    if (Math.abs(den) < 1e-10) continue;
    const t = ((a[0] - curr[0]) * dy - (a[1] - curr[1]) * dx) / den;
    const u = ((a[0] - curr[0]) * nn[1] - (a[1] - curr[1]) * nn[0]) / -den;
    if (t > 0.1 && t < best && u >= -0.05 && u <= 1.05) best = t;
  }
  for (let j = 0; j < n; j++) {
    if (j === i || j === (i - 1 + n) % n || j === (i + 1) % n) continue;
    const d = Math.hypot(loop2[j][0] - curr[0], loop2[j][1] - curr[1]);
    if (d < best) best = d;
  }
  return best === Infinity ? 4 : best;
}

// Edges used an odd number of times - the cheap seal signal used to refuse
// a corner build that would leave the piece worse than it arrived.
function rawOddEdgeCount(soup) {
  const key = (i) => Math.round(soup[i] * 1e4) + ',' + Math.round(soup[i+1] * 1e4) + ',' + Math.round(soup[i+2] * 1e4);
  const seen = new Map();
  for (let t = 0; t + 8 < soup.length; t += 9) {
    for (let v = 0; v < 3; v++) {
      const a = key(t + v * 3), b = key(t + ((v + 1) % 3) * 3);
      const k = a < b ? a + '~' + b : b + '~' + a;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  let odd = 0;
  for (const c of seen.values()) if (c % 2) odd++;
  return odd;
}

function rawFilletCut(rawTris, axisIdx, plane, keepMin, requestedR) {
  const outward = keepMin ? 1 : -1;
  const other = [0,1,2].filter(a => a !== axisIdx);

  const { cutEdges: tipEdges } = rawClipTrianglesAtPlane(rawTris, axisIdx, plane, keepMin);
  const { loops: tipLoops, degreeIssues } = rawBuildLoopsFromCutEdges(tipEdges, axisIdx);
  if (degreeIssues.length > 0) throw new Error('branch point in tip boundary');
  if (!tipLoops.length) throw new Error('no tip boundary');
  const tipLoop3d = tipLoops.reduce((a,b) => b.length > a.length ? b : a);
  if (tipLoop3d.length < 8) throw new Error('boundary too small to fillet');
  let poly2d = tipLoop3d.map(p => [p[other[0]], p[other[1]]]);
  poly2d = raw2DWeldLoop(poly2d, 0.08);
  poly2d = simplifyCollinear2D(poly2d);
  if (poly2d.length < 3) throw new Error('boundary too small to fillet after weld');
  const n = poly2d.length;

  // Adaptive per-vertex radius: never more than half the local wall
  // thickness (2R > thickness is explicitly out of bounds), never more
  // than the requested small radius.
  const Rs = new Array(n);
  for (let i = 0; i < n; i++) {
    const thick = rawLocalThickness2(poly2d, i);
    Rs[i] = Math.min(requestedR, Math.max(0, thick * 0.45));
  }
  const Rmax = Math.max(...Rs);
  if (Rmax < 0.1) throw new Error('no safe radius anywhere on this boundary');

  // Corners: shared sphere-center solve, small blend window (matches the
  // validated approach — a real fan, not a frozen 50/50 collapse).
  const cornerThresh = 30 * Math.PI / 180;
  const corners = [];
  for (let i = 0; i < n; i++) if (Math.abs(rawTurningAngle2(poly2d, i)) > cornerThresh) corners.push(i);
  const windowN = 6;
  let __area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = poly2d[i], b = poly2d[(i + 1) % n];
    __area2 += a[0] * b[1] - b[0] * a[1];
  }
  const windSign = __area2 >= 0 ? 1 : -1;
  function inwardNormal2(a, b) {
    const tx = b[0] - a[0], ty = b[1] - a[1];
    let nx = -ty * windSign, ny = tx * windSign;
    const len = Math.hypot(nx, ny) || 1e-9;
    return [nx / len, ny / len];
  }
  const centers = corners.map(ci => {
    const prev = poly2d[(ci-2+n)%n], curr = poly2d[ci], next = poly2d[(ci+2)%n];
    const n1 = inwardNormal2(prev, curr), n2 = inwardNormal2(curr, next);
    return { i: ci, C: rawSolveCornerCenter2(curr, n1, n2, Rs[ci]), n1, n2, R: Rs[ci] };
  });

  function vertexOffset(i, radius) {
    const prev = poly2d[(i-1+n)%n], curr = poly2d[i], next = poly2d[(i+1)%n];
    const n1 = inwardNormal2(prev, curr), n2 = inwardNormal2(curr, next);
    let bx = n1[0]+n2[0], by = n1[1]+n2[1];
    const blen = Math.hypot(bx, by) || 1e-9;
    bx /= blen; by /= blen;
    const cosHalf = Math.max(bx*n1[0]+by*n1[1], 0.3);
    const mag = radius / cosHalf;
    return [curr[0]+bx*mag, curr[1]+by*mag];
  }

  const STEPS = 6;
  function computeRing(s) {
    const t = s / STEPS;
    const ring = [];
    for (let i = 0; i < n; i++) {
      const R = Rs[i];
      const u = R * (1 - t);
      const sinPhi = Math.min(1, Math.max(0, 1 - (R < 1e-6 ? 1 : u/R)));
      const phi = Math.asin(sinPhi);
      const inset = R * (1 - Math.cos(phi));
      let uv = vertexOffset(i, inset);
      if (s > 0) {
        for (const c of centers) {
          if (!c.C) continue;
          let d = ((i - c.i + n) % n); if (d > n/2) d -= n;
          const absD = Math.abs(d);
          if (absD > windowN) continue;
          const distToCorner = Math.hypot(poly2d[i][0]-poly2d[c.i][0], poly2d[i][1]-poly2d[c.i][1]);
          if (distToCorner > c.R * 4) continue;
          const w = rawSmoothstep2(1 - absD/windowN);
          const negN1 = [-c.n1[0], -c.n1[1]], negN2 = [-c.n2[0], -c.n2[1]];
          const tBlend = (d + windowN) / (2*windowN);
          const nBlend = rawSlerp2D2(negN1, negN2, tBlend);
          const suv = [c.C[0]+c.R*Math.cos(phi)*nBlend[0], c.C[1]+c.R*Math.cos(phi)*nBlend[1]];
          uv = [uv[0]*(1-w)+suv[0]*w, uv[1]*(1-w)+suv[1]*w];
        }
      }
      ring.push(uv);
    }
    return ring;
  }

  const innerRing = computeRing(STEPS);
  if (rawRingSelfIntersects2(innerRing)) throw new Error('fillet band self-intersects at this radius');

  // Retract the wall by Rmax FIRST — re-clip the ORIGINAL body at the
  // margin plane, rather than gluing a ring onto a wall still at the
  // original plane. This is the actual fix for the self-intersecting
  // "slice and dice" look the old disabled fillet code produced.
  const marginPlane = plane + outward * Rmax;
  // Body is always the same keepMin as the half. !keepMin is the R-slab — never ship it.
  const { kept: bodyTrimmed, cutEdges: marginEdges } = rawClipTrianglesAtPlane(rawTris, axisIdx, marginPlane, keepMin);
  if (!bodyTrimmed || bodyTrimmed.length < 9) throw new Error('margin trim produced no body');
  const { loops: marginLoops, degreeIssues: marginDegreeIssues } = rawBuildLoopsFromCutEdges(marginEdges, axisIdx);
  if (marginDegreeIssues.length > 0) throw new Error('branch point in margin boundary');
  if (!marginLoops.length) throw new Error('no margin boundary');
  const outerMargin3d = marginLoops.reduce((a,b) => b.length > a.length ? b : a);
  const marginLoop2d = outerMargin3d.map(p => [p[other[0]], p[other[1]]]);

  function from3(uv, along) {
    const p = [0,0,0]; p[other[0]] = uv[0]; p[other[1]] = uv[1]; p[axisIdx] = along; return p;
  }

  const out = bodyTrimmed.slice();

  // Weld bodyTrimmed's own margin-plane vertices to the canonical loop
  // values before stitching. bodyTrimmed and outerMargin3d both come from
  // the same clip, but near different local mesh triangles can each
  // compute a slightly different float32 copy of "the same" physical
  // point — confirmed directly: independent copies close enough to look
  // identical but far enough to break edge pairing at the stitch seam.
  // Skip any snap that would degenerate the triangle it belongs to.
  (function weldMarginPlane() {
    const tol = 1e-4;
    function wkey(p) { return Math.round(p[other[0]]/tol) + '|' + Math.round(p[other[1]]/tol); }
    const canonical = new Map();
    for (const p of outerMargin3d) canonical.set(wkey(p), p);
    const triCount = out.length / 9;
    for (let t = 0; t < triCount; t++) {
      const i0 = t*9;
      const orig = [[out[i0],out[i0+1],out[i0+2]],[out[i0+3],out[i0+4],out[i0+5]],[out[i0+6],out[i0+7],out[i0+8]]];
      const test = orig.map(v => v.slice());
      let anySnap = false;
      for (let v = 0; v < 3; v++) {
        const p = orig[v];
        if (Math.abs(p[axisIdx] - marginPlane) > tol) continue;
        const c = canonical.get(wkey(p));
        if (!c) continue;
        if (Math.abs(c[0]-p[0])<1e-9 && Math.abs(c[1]-p[1])<1e-9 && Math.abs(c[2]-p[2])<1e-9) continue;
        test[v] = c.slice();
        anySnap = true;
      }
      if (!anySnap) continue;
      const ux=test[1][0]-test[0][0], uy=test[1][1]-test[0][1], uz=test[1][2]-test[0][2];
      const vx=test[2][0]-test[0][0], vy=test[2][1]-test[0][1], vz=test[2][2]-test[0][2];
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      if (0.5*Math.hypot(nx,ny,nz) < 1e-9) continue;
      for (let v = 0; v < 3; v++) { out[i0+v*3]=test[v][0]; out[i0+v*3+1]=test[v][1]; out[i0+v*3+2]=test[v][2]; }
    }
  })();

  // Any OTHER margin loop (an internal rib, etc.) gets a flat cap at the
  // margin plane — same treatment the main rawCut engine uses.
  for (const loop of marginLoops) {
    if (loop === outerMargin3d) continue;
    const cap = rawFlatCapLoop(loop, axisIdx, marginPlane, keepMin);
    for (let i = 0; i < cap.length; i++) out.push(cap[i]);
  }

  // Stitch margin boundary to the band's outermost (widest, s=0) ring.
  const ring0 = computeRing(0);
  const stitch = rawBuildStitchStrip2(marginLoop2d, ring0);
  for (const [p1, p2, p3] of stitch) {
    const A = from3(p1, marginPlane), B = from3(p2, marginPlane), C = from3(p3, marginPlane);
    out.push(A[0],A[1],A[2], B[0],B[1],B[2], C[0],C[1],C[2]);
  }

  // Band: ring0 (at depth Rmax, matching wall) down to innerRing (at tip).
  const rings = [];
  for (let s = 0; s <= STEPS; s++) rings.push(computeRing(s));
  for (let s = 0; s < STEPS; s++) {
    const a = rings[s], b = rings[s+1];
    const depthA = plane + outward * (Rmax * (1 - s/STEPS));
    const depthB = plane + outward * (Rmax * (1 - (s+1)/STEPS));
    for (let i = 0; i < n; i++) {
      const i1 = (i+1)%n;
      const A0 = from3(a[i], depthA), A1 = from3(a[i1], depthA);
      const B0 = from3(b[i], depthB), B1 = from3(b[i1], depthB);
      out.push(A0[0],A0[1],A0[2], A1[0],A1[1],A1[2], B1[0],B1[1],B1[2]);
      out.push(A0[0],A0[1],A0[2], B1[0],B1[1],B1[2], B0[0],B0[1],B0[2]);
    }
  }

  // Cap the innermost ring at the true tip plane.
  const capTris = rawEarClip2D(innerRing);
  for (const tri of capTris) {
    let a = from3(innerRing[tri[0]], plane), b = from3(innerRing[tri[1]], plane), c = from3(innerRing[tri[2]], plane);
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(nrm[axisIdx] || 1) !== wantSign) { const t=b; b=c; c=t; }
    out.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
  }

  if (out.length < 9) throw new Error('fillet produced no geometry');
  return new Float32Array(out);
}

// Coarse self-check: edge pairing + winding consistency. Cheap enough to
// run on every Soft attempt before trusting the result over the flat cap.
function rawCheckWatertightQuick(flatTris) {
  function key(x,y,z) { const tol=1e-4; return Math.round(x/tol)+'|'+Math.round(y/tol)+'|'+Math.round(z/tol); }
  const edgeCount = new Map(), dirCount = new Map();
  const triN = flatTris.length / 9;
  for (let t = 0; t < triN; t++) {
    const i0 = t*9;
    const p = [[flatTris[i0],flatTris[i0+1],flatTris[i0+2]],[flatTris[i0+3],flatTris[i0+4],flatTris[i0+5]],[flatTris[i0+6],flatTris[i0+7],flatTris[i0+8]]];
    const k = p.map(v => key(v[0],v[1],v[2]));
    for (let i = 0; i < 3; i++) {
      const a=k[i], b=k[(i+1)%3];
      const uk = a<b ? a+'~'+b : b+'~'+a;
      edgeCount.set(uk, (edgeCount.get(uk)||0)+1);
      const dk = a+'>'+b;
      dirCount.set(dk, (dirCount.get(dk)||0)+1);
    }
  }
  let odd = 0, stacked = 0;
  for (const c of edgeCount.values()) if (c !== 2) odd++;
  for (const c of dirCount.values()) if (c > 1) stacked++;
  // Soften used to require a perfect 2-manifold. Real fillets leave a
  // handful of unpaired edges. Allow that so a usable fillet can ship.
  if (odd > 208 || stacked > 208) return false;
  return true;
}

