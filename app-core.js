/* THREE, OrbitControls, STLLoader loaded as globals from index.html */

// ===================== Plate Presets =====================
const PLATES = {
  a1mini: { name: 'Bambu A1 Mini', w: 180, d: 180 },
  a1:     { name: 'Bambu A1 / P1S / X1C', w: 256, d: 256 },
  prusa:  { name: 'Prusa MK4 / MK3S', w: 250, d: 210 },
  ender:  { name: 'Creality Ender 3', w: 220, d: 220 },
  custom: { name: 'Custom', w: 180, d: 180 }
};

// ===================== State =====================
const state = {
  plate: 'a1mini',
  models: [],
  placed: [],
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  plateMesh: null,
  plateGrid: null,
  plateBorder: null,
  plateTicks: [],
  modelGroup: null,
  ready: false,
  selectedIndex: -1,
  raycaster: null,
  pointer: null,
  editId: null,
  cutT: 0.5,
  cutDragging: false,
  cutHelper: null,
  previewMesh: null,
  cutterOpen: false,
  moveDragging: false,
  moveIndex: -1,
  moveGrab: { x: 0, z: 0 },
  moveUndoFrom: null,
  undoStack: [],
  cameraFramed: false,
  cutAxis: null,
  joinPartnerId: null,
  joinHullId: null,
  joinPickMode: false,
  joinArmed: null,
  joinSession: false,
  joinFaceA: null,
  joinFaceB: null,
  joinUseFaces: false,
  faceHelper: null,
  softenArmed: false,
  capArmed: false,
  edgeTreat: 'fillet',
  xray: false
};

let nextId = 1;
function getSTLLoader() {
  if (typeof THREE === 'undefined') throw new Error('THREE missing');
  const Ctor = THREE.STLLoader;
  if (!Ctor) throw new Error('THREE.STLLoader missing - check script tags');
  return new Ctor();
}
const loader = { parse: function (data) { return getSTLLoader().parse(data); } };

const NUDGE_MM = 2;
const UNDO_MAX = 40;
const MIN_CUT_SIDE_MM = 1; // allow 1 mm steps; still refuse zero-width
const KERF_MM = 1.0; // material removed at the blade — join still kisses this
const SPLIT_VIEW_GAP_MM = 8; // extra plate space after split so edges are readable. Not cut.
const PIECE_COLOR = 0x38bdf8;
const SELECT_COLOR = 0xf43f5e;
const CHAMFER_MM = 0.8; // mild soft edge on cut face (bevel band)
const CHAMFER_MITER = 2.0; // miter limit - sharp corners become bevels

function updateUndoBtn() {
  const btn = document.getElementById('btn-undo');
  if (!btn) return;
  const has = state.undoStack.length > 0;
  btn.disabled = !has;
  btn.classList.toggle('is-ready', has);
  btn.title = has ? ('Undo (' + state.undoStack.length + ') - Ctrl+Z') : 'Nothing to undo yet';
}
function pushUndo(entry) {
  if (!entry || !entry.type) return;
  state.undoStack.push(entry);
  if (state.undoStack.length > UNDO_MAX) state.undoStack.shift();
  updateUndoBtn();
}
function clearUndo() {
  state.undoStack = [];
  updateUndoBtn();
}
function undoLast() {
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  const entry = state.undoStack.pop();
  updateUndoBtn();
  if (!entry) { setStatus('Nothing to undo'); return; }
  if (entry.type === 'addModels') {
    const ids = new Set(entry.ids || []);
    state.models = state.models.filter(m => !ids.has(m.id));
    // Remove cloned pieces from the plate too
    const kept = [];
    state.placed.forEach(p => {
      if (p && p.sourceId != null && ids.has(p.sourceId)) {
        if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
        if (p.mesh && p.mesh.material) {
          if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
          else p.mesh.material.dispose();
        }
      } else {
        kept.push(p);
      }
    });
    state.placed = kept;
    state.placed.forEach((p, i) => { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    if (entry.editId != null && state.models.some(m => m.id === entry.editId)) state.editId = entry.editId;
    else state.editId = state.models.length ? state.models[state.models.length - 1].id : null;
    if (entry.cutT != null) state.cutT = entry.cutT;
    renderModelList(); updateOptimizeButton(); updateCutterUI(); updateEditSize(); updateAdjustUI();
    if (state.cutterOpen && state.editId) showEditPreview();
    else if (!state.models.length) { clearDisplayMeshes(); removeCutHelper(); state.previewMesh = null; }
    setStatus('Undo: removed cloned pieces');
    return;
  }
  if (entry.type === 'splitReplace') {
    // Remove the two halves, restore the single original, clear plate view
    const ids = new Set(entry.newIds || []);
    const keptSiblings = (entry.siblings && entry.siblings.length)
      ? entry.siblings.slice()
      : state.models.filter(m => !ids.has(m.id) && (!entry.source || m.id !== entry.source.id));
    state.models = keptSiblings.slice();
    if (entry.source) {
      state.models.push(entry.source);
      state.editId = entry.source.id;
    } else if (entry.editId != null) {
      state.editId = entry.editId;
    }
    if (entry.cutT != null) state.cutT = entry.cutT;
    state.cutterOpen = false;
    state.previewMesh = null;
    state.selectedIndex = -1;
    removeCutHelper();
    clearPlaced();
    clearDisplayMeshes();
    renderModelList();
    updateOptimizeButton();
    updateCutterUI();
    updateEditSize();
    if (state.models.length >= 1) layoutUndoModels(state.models);
    updateAdjustUI();
    updateUndoBtn();
    setStatus('Undo: ' + state.models.length + ' piece(s) on plate');
    return;
  }
  if (entry.type === 'joinReplace') {
    const mA = state.models.find(x => x.id === entry.aId);
    if (!mA) { setStatus('Undo: piece no longer exists'); return; }
    mA.geometry = entry.aPrevGeometry;
    mA.rawTris = entry.aPrevRawTris;
    mA.rawAxis = entry.aPrevRawAxis;
    mA.centerOffset = entry.aPrevCenterOffset;
    mA.size = { x: entry.aPrevSize.x, y: entry.aPrevSize.y, z: entry.aPrevSize.z };

    // Restore B into the library.
    const bIdx = Math.min(entry.bSnapshot ? state.models.length : 0, state.models.length);
    if (entry.bSnapshot) state.models.splice(bIdx, 0, entry.bSnapshot);

    const placedA = state.placed.find(p => p && p.sourceId === mA.id);
    if (placedA) {
      const px = placedA.x, pz = placedA.z;
      if (placedA.mesh && state.modelGroup) {
        state.modelGroup.remove(placedA.mesh);
        if (placedA.mesh.material) {
          if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
          else placedA.mesh.material.dispose();
        }
      }
      const matA = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const meshA = new THREE.Mesh(mA.geometry, matA);
      meshA.position.set(px, mA.size.y / 2 + 0.3, pz);
      meshA.userData.sourceId = mA.id;
      state.modelGroup.add(meshA);
      placedA.mesh = meshA;
      placedA.geometry = mA.geometry;
      placedA.width = mA.size.x;
      placedA.depth = mA.size.z;
      placedA.height = mA.size.y;
    }
    if (entry.bSnapshot && entry.poseB && state.modelGroup) {
      const matB = new THREE.MeshStandardMaterial({
        color: 0x4ade80, metalness: 0.05, roughness: 0.4,
        emissive: 0x14532d, emissiveIntensity: 0.2
      });
      const meshB = new THREE.Mesh(entry.bSnapshot.geometry, matB);
      meshB.position.set(entry.poseB.x, entry.bSnapshot.size.y / 2 + 0.3, entry.poseB.z);
      meshB.userData.sourceId = entry.bSnapshot.id;
      state.modelGroup.add(meshB);
      const insertAt = (entry.placedBIndex >= 0 && entry.placedBIndex <= state.placed.length)
        ? entry.placedBIndex : state.placed.length;
      state.placed.splice(insertAt, 0, {
        mesh: meshB, geometry: entry.bSnapshot.geometry, name: entry.bSnapshot.name,
        x: entry.poseB.x, z: entry.poseB.z,
        width: entry.bSnapshot.size.x, depth: entry.bSnapshot.size.z, height: entry.bSnapshot.size.y,
        yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: entry.bSnapshot.id, outline: null
      });
      reindexPlacedMeshes();
    }
    updateEditSize();
    renderModelList();
    updateAdjustUI();
    updateUndoBtn();
    setStatus('Undo: Join reverted - two pieces restored');
    return;
  }
  if (entry.type === 'subtractReplace') {
    const mA = state.models.find(x => x.id === entry.aId);
    if (!mA) { setStatus('Undo: piece no longer exists'); return; }
    mA.geometry = entry.aPrevGeometry;
    mA.rawTris = entry.aPrevRawTris;
    mA.rawAxis = entry.aPrevRawAxis;
    mA.centerOffset = entry.aPrevCenterOffset;
    mA.size = { x: entry.aPrevSize.x, y: entry.aPrevSize.y, z: entry.aPrevSize.z };

    const bIdx = Math.min(entry.bSnapshot ? state.models.length : 0, state.models.length);
    if (entry.bSnapshot) state.models.splice(bIdx, 0, entry.bSnapshot);

    const placedA = state.placed.find(p => p && p.sourceId === mA.id);
    if (placedA) {
      const px = placedA.x, pz = placedA.z;
      if (placedA.mesh && state.modelGroup) {
        state.modelGroup.remove(placedA.mesh);
        if (placedA.mesh.material) {
          if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
          else placedA.mesh.material.dispose();
        }
      }
      const matA = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const meshA = new THREE.Mesh(mA.geometry, matA);
      meshA.position.set(px, mA.size.y / 2 + 0.3, pz);
      meshA.userData.sourceId = mA.id;
      state.modelGroup.add(meshA);
      placedA.mesh = meshA;
      placedA.geometry = mA.geometry;
      placedA.width = mA.size.x;
      placedA.depth = mA.size.z;
      placedA.height = mA.size.y;
    }
    if (entry.bSnapshot && entry.poseB && state.modelGroup) {
      const matB = new THREE.MeshStandardMaterial({
        color: 0x4ade80, metalness: 0.05, roughness: 0.4,
        emissive: 0x14532d, emissiveIntensity: 0.2
      });
      const meshB = new THREE.Mesh(entry.bSnapshot.geometry, matB);
      meshB.position.set(entry.poseB.x, entry.bSnapshot.size.y / 2 + 0.3, entry.poseB.z);
      meshB.userData.sourceId = entry.bSnapshot.id;
      state.modelGroup.add(meshB);
      const insertAt = (entry.placedBIndex >= 0 && entry.placedBIndex <= state.placed.length)
        ? entry.placedBIndex : state.placed.length;
      state.placed.splice(insertAt, 0, {
        mesh: meshB, geometry: entry.bSnapshot.geometry, name: entry.bSnapshot.name,
        x: entry.poseB.x, z: entry.poseB.z,
        width: entry.bSnapshot.size.x, depth: entry.bSnapshot.size.z, height: entry.bSnapshot.size.y,
        yaw: 0, rotY: 0, flipX: false, tipX: 0, overflow: false, sourceId: entry.bSnapshot.id, outline: null
      });
      reindexPlacedMeshes();
    }
    updateEditSize();
    renderModelList();
    updateAdjustUI();
    updateUndoBtn();
    setStatus('Undo: Subtract reverted - two pieces restored');
    return;
  }
  if (entry.type === 'softenReplace' || entry.type === 'capReplace' || entry.type === 'sealReplace' || entry.type === 'solidifyReplace' || entry.type === 'thickenReplace') {
    const m = state.models.find(x => x.id === entry.modelId);
    if (!m) { setStatus('Undo: piece no longer exists'); return; }
    m.geometry = entry.prevGeometry;
    m.rawTris = entry.prevRawTris;
    m.rawAxis = entry.prevRawAxis;
    m.centerOffset = entry.prevCenterOffset;
    m.size = { x: entry.prevSize.x, y: entry.prevSize.y, z: entry.prevSize.z };
    const placedEntry = state.placed.find(p => p && p.sourceId === m.id);
    if (placedEntry) {
      const px = placedEntry.x, pz = placedEntry.z;
      if (placedEntry.mesh && state.modelGroup) {
        state.modelGroup.remove(placedEntry.mesh);
        if (placedEntry.mesh.material) {
          if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(mt => mt.dispose());
          else placedEntry.mesh.material.dispose();
        }
      }
      const mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const mesh = new THREE.Mesh(m.geometry, mat);
      mesh.position.set(px, m.size.y / 2 + 0.3, pz);
      mesh.userData.sourceId = m.id;
      mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
      state.modelGroup.add(mesh);
      placedEntry.mesh = mesh;
      placedEntry.geometry = m.geometry;
      placedEntry.width = m.size.x;
      placedEntry.depth = m.size.z;
      placedEntry.height = m.size.y;
    } else if (state.cutterOpen && state.editId === m.id) {
      showEditPreview();
    }
    updateEditSize();
    renderModelList();
    updateUndoBtn();
    setStatus(entry.type === 'thickenReplace' ? 'Undo: Thicken reverted' : (entry.type === 'solidifyReplace' ? 'Undo: Solidify reverted' : (entry.type === 'sealReplace' ? 'Undo: Seal reverted' : (entry.type === 'capReplace' ? 'Undo: Cap reverted' : 'Undo: Soften reverted'))));
    return;
  }
  if (entry.type === 'removeModel') {
    const m = entry.model;
    if (!m) return;
    const at = Math.min(entry.index ?? state.models.length, state.models.length);
    state.models.splice(at, 0, m);
    if (entry.editId != null) state.editId = entry.editId;
    renderModelList(); updateOptimizeButton(); updateCutterUI(); updateEditSize();
    if (state.cutterOpen && state.editId) showEditPreview();
    setStatus('Undo: restored model ' + (m.name || ''));
    return;
  }
  if (entry.type === 'removePlaced') {
    const p = entry.item;
    if (!p) return;
    const at = Math.min(entry.index ?? state.placed.length, state.placed.length);
    if (!p.mesh && p.geometry) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      p.mesh = new THREE.Mesh(p.geometry, mat);
    }
    if (p.mesh && state.modelGroup) {
      p.mesh.position.set(p.x, p.height / 2 + 0.2, p.z);
      state.modelGroup.add(p.mesh);
    }
    state.placed.splice(at, 0, p);
    reindexPlacedMeshes();
    state.selectedIndex = at;
    updateAdjustUI();
    setStatus('Undo: restored piece on plate');
    return;
  }
  if (entry.type === 'movePlaced') {
    const p = state.placed[entry.index];
    if (!p) return;
    applyPlacedXZ(p, entry.x, entry.z);
    state.selectedIndex = entry.index;
    updateAdjustUI();
    setStatus('Undo: moved piece back');
    return;
  }
  if (entry.type === 'posePlaced') {
    const p = state.placed[entry.index];
    if (!p) return;
    p.x = entry.x; p.z = entry.z;
    p.rotY = entry.rotY || 0;
    p.flipX = !!entry.flipX;
    p.tipX = entry.tipX || 0;
    p.tipZ = entry.tipZ || 0;
    p.liftY = entry.liftY || 0;
    p.tiltX = entry.tiltX || 0;
    p.tiltZ = entry.tiltZ || 0;
    p.width = entry.width; p.depth = entry.depth; p.height = entry.height;
    if (p.mesh) {
      applyMeshRotation(p);
      if (typeof refreshOutline === 'function') refreshOutline(p);
    }
    applyPlacedXZ(p, p.x, p.z);
    state.selectedIndex = entry.index;
    updateAdjustUI();
    setStatus('Undo: restored pose');
    return;
  }
  setStatus('Undo: unknown action');
}

// ===================== Three.js Setup =====================
function initThree() {
  const container = document.getElementById('viewport');

  // Force a real size even if CSS hasn't fully applied yet
  let width = container.clientWidth || 600;
  let height = container.clientHeight || 400;
  if (height < 100) height = 400;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x0b1a33);

  state.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
  state.camera.position.set(140, 160, 200);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  state.renderer.setSize(width, height);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.setClearColor(0x0b1a33, 1);
  container.innerHTML = ''; // clear any previous content
  container.appendChild(state.renderer.domElement);
  const cv = state.renderer.domElement;
  cv.style.display = 'block';
  cv.style.width = '100%';
  cv.style.height = '420px';
  cv.style.background = '#0b1a33';

  state.controls = new THREE.OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.target.set(0, 0, 0);
  // Orbit only while left-dragging the plate (toggled in pointer handlers)
  state.controls.enableRotate = true;
  state.controls.enablePan = true;
  // Custom wheel handler below - Orbit zoom disabled so we can invert direction
  state.controls.enableZoom = false;
  state.controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: null
  };

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.75);
  state.scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(80, 150, 100);
  state.scene.add(dir);

  state.modelGroup = new THREE.Group();
  state.scene.add(state.modelGroup);

  state.raycaster = new THREE.Raycaster();
  state.pointer = new THREE.Vector2();

  buildPlateMesh();
  if (state.camera && state.controls) {
    state.camera.position.set(160, 180, 200);
    state.controls.target.set(0, 0, 0);
    state.controls.update();
  }
  state.ready = true;
  animate();

  window.addEventListener('resize', onResize);
  // Capture phase so we can gate OrbitControls before it sees the event
  state.renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown, true);
  state.renderer.domElement.addEventListener('contextmenu', onCanvasContextMenu);
  // Invert scroll zoom: scroll-in / wheel-up -> closer; scroll-out -> farther
  state.renderer.domElement.addEventListener('wheel', onViewportWheel, { passive: false, capture: true });
  window.addEventListener('pointermove', onCanvasPointerMove);
  window.addEventListener('pointerup', onCanvasPointerUp);
  window.addEventListener('pointercancel', onCanvasPointerUp);
  window.addEventListener('pointerdown', (e) => {
    const menu = document.getElementById('ctx-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(e.target)) return;
    hideCtxMenu();
  }, true);

  // Force one more resize after layout settles
  setTimeout(onResize, 150);
  setTimeout(onResize, 500);
}

function freezeCamera() {
  if (!state.camera || !state.controls) return null;
  return {
    px: state.camera.position.x,
    py: state.camera.position.y,
    pz: state.camera.position.z,
    tx: state.controls.target.x,
    ty: state.controls.target.y,
    tz: state.controls.target.z
  };
}

function restoreCamera(snap) {
  if (!snap || !state.camera || !state.controls) return;
  state.camera.position.set(snap.px, snap.py, snap.pz);
  state.controls.target.set(snap.tx, snap.ty, snap.tz);
  state.controls.update();
}

function onViewportWheel(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!state.camera || !state.controls) return;
  const delta = event.deltaY;
  if (!delta) return;
  // Flipped: deltaY < 0 (scroll up / in) -> closer; deltaY > 0 -> farther
  const scale = Math.pow(0.95, Math.min(8, Math.abs(delta) * 0.01));
  const offset = state.camera.position.clone().sub(state.controls.target);
  if (delta < 0) {
    // scroll in -> closer
    offset.multiplyScalar(scale);
  } else {
    // scroll out -> farther
    offset.multiplyScalar(1 / scale);
  }
  // Clamp distance so we never flip through the target
  const dist = offset.length();
  if (dist < 15) offset.setLength(15);
  if (dist > 1200) offset.setLength(1200);
  state.camera.position.copy(state.controls.target).add(offset);
  state.controls.update();
}

function onResize() {
  if (!state.renderer || !state.camera) return;
  const container = document.getElementById('viewport');
  if (!container) return;
  const w = Math.max(1, container.clientWidth || 600);
  const h = Math.max(1, container.clientHeight || 400);
  if (h < 50) return;

  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  // false = don't let three.js write CSS that can blow past the grid column
  state.renderer.setSize(w, h, false);
  const canvas = state.renderer.domElement;
  if (canvas) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
  }
}

function updatePlateByView() {
  if (!state.plateMesh || !state.camera || !state.plateMesh.material) return;
  const mat = state.plateMesh.material;
  const above = state.camera.position.y > 1.5;
  if (state.xray) {
    mat.opacity = 0.18;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.color.setHex(0x1a2230);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.04;
  } else if (above) {
    mat.opacity = 0.96;
    mat.transparent = true;
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.color.setHex(0x16181c);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.08;
  } else {
    mat.opacity = 0.08;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.color.setHex(0x121416);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.05;
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (state.controls) state.controls.update();
  updatePlateByView();
  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera);
  }
}

function buildPlateMesh() {
  if (state.plateMesh) {
    state.scene.remove(state.plateMesh);
    if (state.plateMesh.geometry) state.plateMesh.geometry.dispose();
  }
  if (state.plateGrid) {
    state.scene.remove(state.plateGrid);
    state.plateGrid = null;
  }
  if (state.plateBorder) {
    state.scene.remove(state.plateBorder);
    state.plateBorder = null;
  }
  if (state.plateTicks && state.plateTicks.length) {
    state.plateTicks.forEach(t => {
      state.scene.remove(t);
      if (t.geometry) t.geometry.dispose();
      if (t.material) t.material.dispose();
    });
  }
  state.plateTicks = [];

  const p = getCurrentPlate();
  const geo = new THREE.PlaneGeometry(p.w, p.d);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x16181c,
    metalness: 0.05,
    roughness: 0.85,
    emissive: 0x0a0b0d,
    emissiveIntensity: 0.08,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.96,
    depthWrite: true
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.plateMesh.position.y = 0;
  state.plateMesh.receiveShadow = true;
  state.scene.add(state.plateMesh);

  // Grid on the floor - not a child of the rotated plate
  const grid = new THREE.GridHelper(Math.max(p.w, p.d), 18, 0x3a3d44, 0x22252a);
  grid.position.y = 0.15;
  state.scene.add(grid);
  state.plateGrid = grid;

  // Bright cyan border so plate edge is obvious
  const edges = new THREE.EdgesGeometry(geo);
  const border = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x38bdf8, linewidth: 2 })
  );
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.3;
  state.scene.add(border);
  state.plateBorder = border;

  // Corner ticks for orientation
  const tickMat = new THREE.LineBasicMaterial({ color: 0xfbbf24 });
  const tickLen = Math.min(p.w, p.d) * 0.06;
  const hw = p.w / 2;
  const hd = p.d / 2;
  const corners = [
    [[-hw, 0.35, -hd], [-hw + tickLen, 0.35, -hd], [-hw, 0.35, -hd + tickLen]],
    [[hw, 0.35, -hd], [hw - tickLen, 0.35, -hd], [hw, 0.35, -hd + tickLen]],
    [[-hw, 0.35, hd], [-hw + tickLen, 0.35, hd], [-hw, 0.35, hd - tickLen]],
    [[hw, 0.35, hd], [hw - tickLen, 0.35, hd], [hw, 0.35, hd - tickLen]]
  ];
  corners.forEach(pts => {
    const g = new THREE.BufferGeometry().setFromPoints(
      pts.map(v => new THREE.Vector3(v[0], v[1], v[2]))
    );
    const line = new THREE.Line(g, tickMat);
    state.scene.add(line);
    state.plateTicks.push(line);
  });

  // Frame camera only once on first plate build - never on upload/cutter/rebuild
  if (state.controls && !state.cameraFramed) {
    framePlateHome();
    state.cameraFramed = true;
  }
}

function getCurrentPlate() {
  if (state.plate === 'custom') {
    return {
      name: 'Custom',
      w: Number(document.getElementById('custom-w').value) || 180,
      d: Number(document.getElementById('custom-d').value) || 180
    };
  }
  return PLATES[state.plate];
}

// ===================== Model Loading =====================
// Try to match Bambu (Z-up) in Three.js (Y-up).
// rotateX(-90 deg) is the standard mapping; export inverts it.
function zUpToYUp(geometry) {
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function handleFiles(files) {
  const list = Array.from(files).filter(f =>
    f.name.toLowerCase().endsWith('.stl')
  );

  if (!list.length) {
    setStatus('Please use STL files only for now', true);
    return;
  }

  list.forEach(file => {
    const reader = new FileReader();
    reader.onerror = () => setStatus(`Could not read ${file.name}`, true);
    reader.onload = (e) => {
      try {
        let geometry = loader.parse(e.target.result);
        if (!geometry.attributes || !geometry.attributes.position) {
          throw new Error('Invalid geometry');
        }
        // Capture the raw triangle soup BEFORE rotateX/center - original
        // file axes, untranslated. This is what the sandbox cut engine
        // was validated against; the display mesh below is a transformed
        // copy for viewport/UI purposes only and is never read by rawCut.
        const rawTris = new Float32Array(geometry.attributes.position.array);
        geometry = zUpToYUp(geometry);
        geometry.computeVertexNormals();
        // Compute the center offset ourselves (THREE's .center() doesn't
        // return it) so Split can invert it later to map a display-space
        // plane back into raw, untranslated coordinates.
        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        const centerOffset = {
          x: (bb.min.x + bb.max.x) / 2,
          y: (bb.min.y + bb.max.y) / 2,
          z: (bb.min.z + bb.max.z) / 2
        };
        geometry.center();
        addModel(file.name, geometry, { rawTris: rawTris, rawAxis: 'zup', centerOffset: centerOffset });
      } catch (err) {
        console.error(err);
        setStatus(`Failed to load ${file.name}. Try re-exporting as binary STL.`, true);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function addModel(name, geometry, opts) {
  const options = opts || {};
  const id = nextId++;
  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // Sanity check
  if (size.x < 0.1 || size.y < 0.1 || size.z < 0.1) {
    setStatus(`${name} looks empty or invalid`, true);
    return null;
  }

  // Center so red plane and clip share the same origin every time
  geometry.center();
  geometry.computeBoundingBox();
  const size2 = new THREE.Vector3();
  geometry.boundingBox.getSize(size2);

  state.models.push({
    id,
    name: name.replace(/\.stl$/i, ''),
    geometry,
    quantity: 1,
    size: { x: size2.x, y: size2.y, z: size2.z },
    orientedGeometry: null,
    // Raw-mesh cut engine data - original file axes, untranslated. Only
    // present when loaded via handleFiles; absent on programmatically
    // rebuilt models (e.g. after a Split), which fall back to
    // clipGeometrySide automatically since rawTris will be undefined.
    rawTris: options.rawTris || null,
    rawAxis: options.rawAxis || null,
    centerOffset: options.centerOffset || null
  });

  if (!options.keepSelection) {
    state.cutT = 0.5;
  }
  renderModelList();
  updateOptimizeButton();
  updateEditSize();
  if (!options.silent) {
    if (state.cutterOpen && !options.keepSelection) {
      showEditPreview();
      setStatus(`Loaded: ${name} (${size2.x.toFixed(0)}x${size2.y.toFixed(0)}x${size2.z.toFixed(0)} mm) - cutter open, slide red plane`);
    } else if (!options.keepSelection) {
      const model = state.models.find(x => x.id === id);
      // Offset new uploads so they don't stack on existing plate pieces
      let x = 0;
      if (state.placed.length) {
        const maxX = Math.max(...state.placed.map(p => p.x + (p.width || 0) / 2));
        x = maxX + size2.x / 2 + 4;
      }
      if (model) placeModelMovable(model, x, 0);
      setStatus(`Loaded: ${name} (${size2.x.toFixed(0)}x${size2.y.toFixed(0)}x${size2.z.toFixed(0)} mm) - drag to move, Open cutter, or Optimize`);
    }
  }
  return id;
}

// Clear display meshes only - never dispose shared model geometries
function clearDisplayMeshes() {
  if (!state.modelGroup) return;
  const kids = state.modelGroup.children.slice();
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    state.modelGroup.remove(child);
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
    // Do NOT dispose geometry - it may be shared with state.models
  }
  // Safety: empty group
  while (state.modelGroup.children.length) {
    state.modelGroup.remove(state.modelGroup.children[0]);
  }
}

// Show a single model on the plate so upload has immediate feedback

/** Put a library model on the plate as a movable piece (does not wipe other pieces). */
function applyPlacedOrientation(entry, ori) {
  if (!entry || !ori) return;
  entry.rotY = ori.rotY || 0;
  entry.flipX = !!ori.flipX;
  entry.tipX = ori.tipX || 0;
  entry.tipZ = ori.tipZ || 0;
  entry.tiltX = ori.tiltX || 0;
  entry.tiltZ = ori.tiltZ || 0;
  entry.liftY = ori.liftY || 0;
  if (typeof applyMeshRotation === 'function') applyMeshRotation(entry);
}

function placeModelMovable(model, x, z) {
  if (!model || !model.geometry || !state.modelGroup) return null;
  // Avoid duplicate plate instances of same source unless caller wants clones (clones are new models)
  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
    emissive: 0x0a3a5c, emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(model.geometry, mat);
  const h = model.size.y / 2 + 0.3;
  const px = (typeof x === 'number') ? x : 0;
  const pz = (typeof z === 'number') ? z : 0;
  mesh.position.set(px, h, pz);
  mesh.userData.placedIndex = state.placed.length;
  mesh.userData.sourceId = model.id;
  state.modelGroup.add(mesh);
  const entry = {
    mesh,
    geometry: model.geometry,
    name: model.name,
    x: px,
    z: pz,
    width: model.size.x,
    depth: model.size.z,
    height: model.size.y,
    yaw: 0,
    rotY: 0,
    flipX: false,
    tipX: 0,
    overflow: false,
    sourceId: model.id,
    outline: null
  };
  state.placed.push(entry);
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = false;
  updateAdjustUI();
  return entry;
}

function framePlateHome() {
  if (!state.camera || !state.controls) return;
  const plate = (typeof getCurrentPlate === 'function') ? getCurrentPlate() : { w: 180, d: 180 };
  const w = plate.w || 180;
  const d = plate.d || 180;
  state.controls.target.set(0, 6, 0);
  state.camera.position.set(w * 1.08, Math.max(w, d) * 0.92, d * 1.18);
  state.controls.update();
}

function frameSelectedPiece() {
  framePlateHome();
  setStatus('Camera: plate view');
}

function clearPlateOnly() {
  clearPlaced();
  removeCutHelper();
  state.previewMesh = null;
  state.selectedIndex = -1;
  state.cutterOpen = false;
  updateCutterUI();
  updateAdjustUI();
  setStatus('Plate cleared - library models kept. Upload or Open cutter still work.');
}

function cloneSelectedModel() {
  const m = getActiveModel();
  if (!m) {
    const p = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
    if (p && p.sourceId != null) {
      const found = state.models.find(x => x.id === p.sourceId);
      if (found) state.editId = found.id;
    }
  }
  const src = getActiveModel();
  if (!src || !src.geometry) {
    setStatus('Select a model to clone', true);
    return;
  }
  const n = Math.max(1, Math.min(20, Number(document.getElementById('clone-count')?.value) || 1));
  const plate = getCurrentPlate();
  const gap = 3;
  const w = src.size.x;
  const d = src.size.z;
  const cellW = w + gap;
  const cellD = d + gap;
  const cols = Math.max(1, Math.floor((plate.w + gap) / cellW));
  const rows = Math.max(1, Math.floor((plate.d + gap) / cellD));
  // Occupied cell keys from existing plate pieces
  const occupied = new Set();
  state.placed.forEach(p => {
    const col = Math.round((p.x + plate.w / 2 - w / 2) / cellW);
    const row = Math.round((p.z + plate.d / 2 - d / 2) / cellD);
    occupied.add(col + ',' + row);
  });
  function nextFreeCell(start) {
    for (let k = start; k < cols * rows * 4; k++) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      const key = col + ',' + row;
      if (!occupied.has(key)) {
        occupied.add(key);
        const x = -plate.w / 2 + w / 2 + col * cellW;
        const z = -plate.d / 2 + d / 2 + row * cellD;
        return { x, z, k: k + 1 };
      }
    }
    // Overflow: place to the right of plate
    const k = start;
    const x = plate.w / 2 + w / 2 + (k - cols * rows) * cellW;
    return { x, z: 0, k: k + 1 };
  }
  let cursor = 0;
  const newIds = [];
  for (let i = 0; i < n; i++) {
    const geo = src.geometry.clone();
    geo.computeBoundingBox();
    const name = src.name.replace(/-copy\d+$/i, '') + '-copy' + (i + 1);
    const id = addModel(name, geo, { keepSelection: true, silent: true });
    if (id == null) continue;
    newIds.push(id);
    const model = state.models.find(x => x.id === id);
    if (!model) continue;
    const cell = nextFreeCell(cursor);
    cursor = cell.k;
    placeModelMovable(model, cell.x, cell.z);
  }
  if (newIds.length) {
    pushUndo({ type: 'addModels', ids: newIds.slice(), editId: state.editId, cutT: state.cutT });
    state.editId = newIds[0];
  }
  renderModelList();
  updateOptimizeButton();
  updateEditSize();
  updateUndoBtn();
  setStatus('Cloned ' + newIds.length + ' x ' + src.name + ' side-by-side on plate (' + cols + ' across)');
}

function previewModelOnPlate(geometry, size) {
  if (!state.scene || !state.modelGroup) {
    setStatus('3D view not ready - refresh the page', true);
    return;
  }

  clearDisplayMeshes();
  state.placed = []; // preview is not a real pack
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;

  // Auto-orient for a sensible preview (same logic as Optimize)
  let geo;
  let h = size.y;
  try {
    const best = autoOrient(geometry);
    geo = best.geometry;
    h = best.size.y;
  } catch (e) {
    geo = geometry.clone();
    geo.center();
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.05,
    roughness: 0.4,
    emissive: 0x0a3a5c,
    emissiveIntensity: 0.25
  });
  const cam = freezeCamera();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, h / 2 + 0.3, 0);
  state.modelGroup.add(mesh);
  restoreCamera(cam);
}

function renderModelList() {
  const el = document.getElementById('model-list');
  el.innerHTML = '';

  state.models.forEach(m => {
    const row = document.createElement('div');
    let cls = 'model-item';
    if (m.id === state.editId) cls += ' active';
    if (m.id === state.joinPartnerId) cls += ' join-partner';
    row.className = cls;
    row.dataset.editId = String(m.id);
    row.innerHTML = `
      <span class="name" title="${m.name}">${m.name}</span>
      <div class="qty">
        <input type="number" min="1" max="30" value="${m.quantity}" data-id="${m.id}" />
      </div>
      <button class="remove" data-id="${m.id}" title="Remove">x</button>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll('.model-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.qty') || e.target.closest('.remove')) return;
      const id = Number(row.dataset.editId);
      if (state.joinSession && state.joinArmed) {
        assignJoinClick(id);
        return;
      }
      state.editId = id;
      state.cutT = 0.5;
      const placedIdx = state.placed.findIndex(function (p) { return p && p.sourceId === id; });
      if (placedIdx >= 0) selectPlaced(placedIdx);
      else {
        renderModelList();
        updateEditSize();
        if (state.cutterOpen) {
          const mesh = getCutterTargetMesh();
          if (mesh) {
            removeCutHelper();
            state.previewMesh = mesh;
            buildCutHelper();
          }
        }
        if (typeof updateJoinUI === 'function') updateJoinUI();
      }
      return;
      state.cutT = 0.5;
      renderModelList();
      updateEditSize();
      if (state.cutterOpen) {
        showEditPreview();
        setStatus('Cutter on ' + (getActiveModel() ? getActiveModel().name : ''));
      } else {
        setStatus('Selected ' + (getActiveModel() ? getActiveModel().name : '') + ' - Open cutter to cut, or Optimize to nest');
      }
    });
  });

  el.querySelectorAll('.qty input').forEach(input => {
    input.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      const model = state.models.find(m => m.id === id);
      if (model) {
        model.quantity = Math.max(1, Math.min(30, Number(e.target.value) || 1));
        e.target.value = model.quantity;
      }
    });
  });

  el.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = Number(e.target.dataset.id);
      state.models = state.models.filter(m => m.id !== id);
      if (state.editId === id) {
        state.editId = state.models.length ? state.models[state.models.length - 1].id : null;
        state.cutT = 0.5;
      }
      renderModelList();
      updateOptimizeButton();
      if (state.editId) showEditPreview();
      else {
        clearPlaced();
        removeCutHelper();
      }
    });
  });
  if (typeof updateJoinUI === 'function') updateJoinUI();
}

function updateOptimizeButton() {
  const btn = document.getElementById('btn-optimize');
  if (btn) btn.disabled = state.models.length === 0;
}

// ===================== Orientation =====================
// density = pack more, but NEVER on a thin edge
// supports = lowest overhangs
function scoreOrientation(geometry, mode = 'density') {
  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const footprint = size.x * size.z;
  const height = size.y;
  const maxSide = Math.max(size.x, size.z);
  const minSide = Math.min(size.x, size.z);
  const baseAspect = maxSide / Math.max(minSide, 0.1);
  const stability = footprint / Math.max(height * height, 1);

  // Hard ban: thin-edge / tip poses (min base width < 18mm or crazy aspect)
  const MIN_BASE = 18;
  const isThinEdge = minSide < MIN_BASE || baseAspect > 3.2 || stability < 0.18;

  let score;
  if (isThinEdge) {
    score = 1e9; // banned
  } else if (mode === 'density') {
    score = footprint * 0.5 + maxSide * 3 + height * 0.4;
  } else {
    score = height * 3.0 - footprint * 0.01 + maxSide * 0.2;
  }
  return { score, size, footprint, height, maxSide, baseAspect, stability, isThinEdge };
}

function autoOrient(geometry, mode = 'density') {
  const rotations = [
    [0, 0, 0],
    [Math.PI / 2, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [0, 0, -Math.PI / 2],
    [Math.PI, 0, 0],
    [Math.PI / 2, 0, Math.PI / 2],
    [Math.PI / 2, 0, -Math.PI / 2],
    [-Math.PI / 2, 0, Math.PI / 2],
    [-Math.PI / 2, 0, -Math.PI / 2],
    [0, Math.PI / 2, 0],
    [0, -Math.PI / 2, 0],
    [Math.PI / 2, Math.PI / 2, 0],
    [-Math.PI / 2, Math.PI / 2, 0]
  ];

  let best = null;

  rotations.forEach(([rx, ry, rz]) => {
    const geo = geometry.clone();
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.computeBoundingBox();
    geo.center();
    const result = scoreOrientation(geo, mode);
    if (!best || result.score < best.score) {
      best = { geometry: geo, ...result, rot: [rx, ry, rz] };
    }
  });

  return best;
}

// ===================== Nesting =====================
// Footprints: 0 deg, 90 deg, +/-45 deg yaw. AABB expands at 45 deg.
function footprintsFor(geo, size, allowRotate) {
  const list = [{ geometry: geo, width: size.x, depth: size.z, height: size.y, rotY: 0 }];
  if (!allowRotate) return list;
  list.push({ geometry: geo, width: size.z, depth: size.x, height: size.y, rotY: Math.PI / 2 });
  const w45 = size.x * Math.SQRT1_2 + size.z * Math.SQRT1_2;
  const d45 = w45;
  list.push({ geometry: geo, width: w45, depth: d45, height: size.y, rotY: Math.PI / 4 });
  list.push({ geometry: geo, width: w45, depth: d45, height: size.y, rotY: -Math.PI / 4 });
  return list;
}

function packModels(instances, plate, gap, allowRotate) {
  const placed = [];
  const freeRects = [{ x: -plate.w / 2, z: -plate.d / 2, w: plate.w, d: plate.d }];

  // Largest footprint first
  const sorted = [...instances].sort((a, b) => (b.width * b.depth) - (a.width * a.depth));

  for (const inst of sorted) {
    // Candidate footprints: as-is + 90 deg yaw if allowed
    const candidates = footprintsFor(inst.geometry, {
      x: inst.width, y: inst.height, z: inst.depth
    }, allowRotate);

    // Also try other base orientations of the source model if attached
    if (inst.orientOptions && inst.orientOptions.length) {
      for (const opt of inst.orientOptions) {
        for (const fp of footprintsFor(opt.geometry, opt.size, allowRotate)) {
          candidates.push(fp);
        }
      }
    }

    let best = null;

    for (const cand of candidates) {
      for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (cand.width + gap <= r.w + 0.01 && cand.depth + gap <= r.d + 0.01) {
          // Prefer bottom-left, then minimize leftover strip waste
          const waste = (r.w * r.d) - (cand.width * cand.depth);
          const score = r.z * 5000 + r.x * 10 + waste * 0.01;
          if (!best || score < best.score) {
            best = {
              x: r.x, z: r.z,
              w: cand.width, d: cand.depth,
              score, rectIdx: i,
              geometry: cand.geometry,
              rotY: cand.rotY || 0,
              height: cand.height
            };
          }
        }
      }
    }

    if (!best) {
      const overflowIndex = placed.filter(p => p.overflow).length;
      placed.push({
        ...inst,
        x: 0,
        z: 0,
        width: inst.width,
        depth: inst.depth,
        rotated: false,
        rotY: 0,
        overflow: true,
        meshOffsetY: overflowIndex * (inst.height + 2)
      });
      continue;
    }

    placed.push({
      ...inst,
      geometry: best.geometry,
      x: best.x + best.w / 2,
      z: best.z + best.d / 2,
      width: best.w,
      depth: best.d,
      height: best.height,
      rotated: Math.abs(best.rotY) > 0.1,
      rotY: best.rotY,
      overflow: false
    });

    // Split free rect (guillotine)
    const r = freeRects[best.rectIdx];
    freeRects.splice(best.rectIdx, 1);
    const usedW = best.w + gap;
    const usedD = best.d + gap;

    // Two split heuristics - keep both leftover rects when large enough
    if (r.w - usedW > 1.5) {
      freeRects.push({ x: r.x + usedW, z: r.z, w: r.w - usedW, d: r.d });
    }
    if (r.d - usedD > 1.5) {
      freeRects.push({ x: r.x, z: r.z + usedD, w: Math.min(usedW, r.w), d: r.d - usedD });
    }

    freeRects.sort((a, b) => a.z - b.z || a.x - b.x);
  }

  return placed;
}

// Color mesh faces by overhang: green = OK, red = needs support
function applyOverhangColors(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const threshold = Math.cos((45 * Math.PI) / 180); // 45 deg overhang

  for (let i = 0; i < pos.count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    normal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA)).normalize();
    // Faces pointing down/sideways past threshold need support
    const dot = normal.dot(up);
    const needsSupport = dot < threshold && dot > -0.95; // skip near-downward bed faces slightly
    // Stronger: any face more than 45 deg from up
    const bad = normal.dot(up) < threshold;
    const r = bad ? 0.95 : 0.25;
    const g = bad ? 0.25 : 0.85;
    const b = bad ? 0.2 : 0.45;
    for (let k = 0; k < 3; k++) {
      colors[(i + k) * 3] = r;
      colors[(i + k) * 3 + 1] = g;
      colors[(i + k) * 3 + 2] = b;
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// ===================== Optimize =====================
function runOptimize() {
  const btn = document.getElementById('btn-optimize');
  btn.disabled = true;
  setStatus('Optimizing...');
  closeCutter(true);

  try {
    const autoOrientFace = document.getElementById('opt-auto-orient')?.checked;
    const preferSupports = document.getElementById('opt-orient').checked;
    const allowRotate = document.getElementById('opt-rotate').checked;
    const gap = Number(document.getElementById('gap').value) || 2;
    const plate = getCurrentPlate();

    // Top N orientations so packer can pick per-instance
    function topOrients(geometry, mode, n = 4) {
      const rotations = [
        [0, 0, 0], [Math.PI / 2, 0, 0], [-Math.PI / 2, 0, 0],
        [0, 0, Math.PI / 2], [0, 0, -Math.PI / 2], [Math.PI, 0, 0],
        [Math.PI / 2, 0, Math.PI / 2], [-Math.PI / 2, 0, Math.PI / 2]
      ];
      const scored = [];
      rotations.forEach(([rx, ry, rz]) => {
        const geo = geometry.clone();
        geo.rotateX(rx); geo.rotateY(ry); geo.rotateZ(rz);
        geo.computeBoundingBox(); geo.center();
        const result = scoreOrientation(geo, mode || 'density');
        scored.push({ geometry: geo, size: result.size, score: result.score, isThinEdge: result.isThinEdge });
      });
      scored.sort((a, b) => a.score - b.score);
      // Prefer printable poses only; fall back to all if none pass
      const printable = scored.filter(s => !s.isThinEdge && s.score < 1e8);
      const pool = printable.length ? printable : scored;
      return pool.slice(0, n);
    }

    function buildInstances(mode) {
      const instances = [];
      for (const model of state.models) {
        const orients = mode ? topOrients(model.geometry, mode, 5) : [{
          geometry: (() => { const g = model.geometry.clone(); g.center(); return g; })(),
          size: model.size,
          score: 0
        }];
        const primary = orients[0];
        const orientOptions = orients.slice(1).map(o => ({
          geometry: o.geometry,
          size: { x: o.size.x, y: o.size.y, z: o.size.z }
        }));
        for (let i = 0; i < model.quantity; i++) {
          instances.push({
            sourceId: model.id,
            name: model.name,
            geometry: primary.geometry,
            width: primary.size.x,
            depth: primary.size.z,
            height: primary.size.y,
            orientOptions
          });
        }
      }
      return instances;
    }

    // Default: keep upload orientation (works for any file).
    // Optional auto-orient when user enables it.
    const candidates = [];
    if (autoOrientFace) {
      candidates.push({ mode: 'density', instances: buildInstances('density') });
      candidates.push({ mode: 'supports', instances: buildInstances('supports') });
    }
    candidates.push({ mode: null, instances: buildInstances(null) }); // as uploaded

    let bestPlaced = null;
    let bestFitted = -1;
    let bestMode = 'as-uploaded';

    for (const c of candidates) {
      const placedTry = packModels(c.instances, plate, gap, allowRotate);
      const fitted = placedTry.filter(p => !p.overflow).length;
      if (fitted > bestFitted) {
        bestFitted = fitted;
        bestPlaced = placedTry;
        bestMode = c.mode || 'as-uploaded';
      }
    }

    const placed = bestPlaced;

    clearDisplayMeshes();
    state.placed = placed;

    const showSupports = preferSupports; // reuse checkbox: when on, tint overhangs

    placed.forEach((p, idx) => {
      let geo = p.geometry.clone();
      if (showSupports) {
        geo = applyOverhangColors(geo);
      }
      const mat = new THREE.MeshStandardMaterial({
        color: showSupports ? 0xffffff : 0x60a5fa,
        metalness: 0.08,
        roughness: 0.55,
        vertexColors: showSupports
      });
      if (p.overflow) {
        mat.vertexColors = false;
        mat.color.setHSL(0.05, 0.75, 0.55);
      }
      const mesh = new THREE.Mesh(geo, mat);
      const yOff = p.meshOffsetY || 0;
      mesh.position.set(p.x, p.height / 2 + 0.2 + yOff, p.z);
      mesh.rotation.y = p.rotY || (p.rotated ? Math.PI / 2 : 0);
      mesh.userData.placedIndex = idx;
      p.mesh = mesh;
      p.rotY = p.rotY || (p.rotated ? Math.PI / 2 : 0);
      state.modelGroup.add(mesh);
    });

    state.selectedIndex = -1;
    updateAdjustUI();

    // Keep plate visible - do not reframe camera after packing
    if (!state.plateMesh || !state.plateGrid) buildPlateMesh();

    const totalRequested = state.models.reduce((s, m) => s + m.quantity, 0);
    const fitted = placed.filter(p => !p.overflow).length;
    const totalArea = plate.w * plate.d;
    const usedArea = placed.filter(p => !p.overflow).reduce((sum, p) => sum + p.width * p.depth, 0);
    const fill = totalArea > 0 ? ((usedArea / totalArea) * 100).toFixed(1) : 0;

    document.getElementById('stats').classList.remove('hidden');
    document.getElementById('stat-count').textContent = `${fitted} models`;
    document.getElementById('stat-fill').textContent = `${fill}% fill`;
    document.getElementById('stat-time').textContent = `${totalRequested - fitted} left`;

    const resultsEl = document.getElementById('results');
    resultsEl.innerHTML = `
      <div class="result-row"><span>Placed</span><strong>${fitted} / ${totalRequested}</strong></div>
      <div class="result-row"><span>Plate fill</span><strong>${fill}%</strong></div>
      <div class="result-row"><span>Mode</span><strong>${bestMode}${showSupports ? ' + support tint' : ''}</strong></div>
      <div class="result-row"><span>Gap</span><strong>${gap} mm</strong></div>
    `;

    updateExportButton();

    const overflowCount = placed.filter(p => p.overflow).length;
    if (overflowCount > 0) {
      setStatus(`${fitted} fitted, ${overflowCount} need manual place - click orange model(s) to rotate/nudge`, true);
    } else {
      setStatus(`Packed ${fitted} models - ready to export`, false);
    }
  } catch (err) {
    console.error(err);
    setStatus('Optimize failed. Check console.', true);
  }

  btn.disabled = false;
}

function clearPlaced() {
  if (state.placed && state.placed.length) {
    state.placed.forEach(p => {
      if (p && p.mesh) {
        if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
        if (p.mesh.material) {
          if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
          else p.mesh.material.dispose();
        }
      }
      if (p && p.outline && p.outline.parent) p.outline.parent.remove(p.outline);
    });
  }
  state.placed = [];
  clearDisplayMeshes();
  const stats = document.getElementById('stats');
  if (stats) stats.classList.add('hidden');
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;
  state.selectedIndex = -1;
}

// ===================== Manual Adjust =====================
function setPointerFromEvent(event) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function hitPlateXZ() {
  if (!state.raycaster || !state.camera) return null;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  if (!state.raycaster.ray.intersectPlane(plane, hit)) return null;
  return hit;
}

function settlePlacedOnBed(p) {
  if (!p || !p.mesh) return;
  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
    if (p.mesh.material && !p.mesh.material.vertexColors) {
      const hue = 0.55 + ((state.selectedIndex >= 0 ? state.selectedIndex : 0) % 8) * 0.03;
      p.mesh.material.color.setHSL(hue, 0.65, 0.55);
    }
  }
  const yKeep = p.mesh.position.y;
  p.mesh.position.y = 0;
  p.mesh.updateMatrixWorld(true);
  const bb = meshLocalBox3(p.mesh);
  p.mesh.position.y = 0.2 - bb.min.y + (p.liftY || 0);
}

function clearFenceLines() {
  if (!state.fenceGroup || !state.modelGroup) return;
  state.modelGroup.remove(state.fenceGroup);
  state.fenceGroup.traverse(function (c) {
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
  state.fenceGroup = null;
}

function showFenceLines(skipIdx) {
  clearFenceLines();
  if (!state.modelGroup || !state.placed) return;
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xff2a2a, depthTest: false });
  const y = 0.35;
  for (let i = 0; i < state.placed.length; i++) {
    if (i === skipIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    const fp = placedFootprint(q);
    const pts = [
      [fp.minx, fp.minz, fp.maxx, fp.minz],
      [fp.maxx, fp.minz, fp.maxx, fp.maxz],
      [fp.maxx, fp.maxz, fp.minx, fp.maxz],
      [fp.minx, fp.maxz, fp.minx, fp.minz]
    ];
    for (let e = 0; e < 4; e++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(pts[e][0], y, pts[e][1]),
        new THREE.Vector3(pts[e][2], y, pts[e][3])
      ]);
      g.add(new THREE.Line(geo, mat));
    }
  }
  state.fenceGroup = g;
  state.modelGroup.add(g);
}

function matchPlacedBottoms(a, b) {
  if (!a || !b || !a.mesh || !b.mesh) return;
  settlePlacedOnBed(a);
  settlePlacedOnBed(b);
  a.mesh.updateMatrixWorld(true);
  b.mesh.updateMatrixWorld(true);
  const ba = meshLocalBox3(a.mesh);
  const bb = meshLocalBox3(b.mesh);
  a.mesh.position.y += 0.2 - ba.min.y;
  b.mesh.position.y += 0.2 - bb.min.y;
}

function applyPlacedXZ(p, x, z) {
  if (!p) return;
  p.x = x;
  p.z = z;
  if (p.mesh) {
    p.mesh.position.x = p.x;
    p.mesh.position.z = p.z;
    settlePlacedOnBed(p);
  }
}

function placedFootprint(p, x, z) {
  const px = (x == null) ? p.x : x;
  const pz = (z == null) ? p.z : z;
  if (p.mesh) {
    const savedX = p.mesh.position.x;
    const savedZ = p.mesh.position.z;
    p.mesh.position.x = px;
    p.mesh.position.z = pz;
    p.mesh.updateMatrixWorld(true);
    const bb = meshLocalBox3(p.mesh);
    p.mesh.position.x = savedX;
    p.mesh.position.z = savedZ;
    p.mesh.updateMatrixWorld(true);
    return { minx: bb.min.x, maxx: bb.max.x, minz: bb.min.z, maxz: bb.max.z };
  }
  const hx = Math.max(1, p.width || 10) / 2;
  const hz = Math.max(1, p.depth || 10) / 2;
  return { minx: px - hx, maxx: px + hx, minz: pz - hz, maxz: pz + hz };
}

function footprintsOverlap(a, b, pad) {
  const g = pad == null ? 0.02 : pad;
  const ox = Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx);
  const oz = Math.min(a.maxz, b.maxz) - Math.max(a.minz, b.minz);
  return ox > g && oz > g;
}

function jigBoxesFor(q) {
  return [];
}

function poseOverlapsOthers(p, selfIdx, x, z) {
  const fp = placedFootprint(p, x, z);
  for (let i = 0; i < state.placed.length; i++) {
    if (i === selfIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    if (footprintsOverlap(fp, placedFootprint(q))) return true;
    const jigs = jigBoxesFor(q);
    for (let j = 0; j < jigs.length; j++) {
      if (footprintsOverlap(fp, jigs[j], 0.02)) return true;
    }
  }
  return false;
}

function magnetTowardNeighbors(p, selfIdx, x, z) {
  const MAG = 12;
  let nx = x;
  let nz = z;
  const fp = placedFootprint(p, x, z);
  for (let i = 0; i < state.placed.length; i++) {
    if (i === selfIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    const o = placedFootprint(q);
    const overZ = Math.min(fp.maxz, o.maxz) - Math.max(fp.minz, o.minz);
    const overX = Math.min(fp.maxx, o.maxx) - Math.max(fp.minx, o.minx);
    if (overZ > 1) {
      const gapR = o.minx - fp.maxx;
      const gapL = fp.minx - o.maxx;
      if (gapR >= 0 && gapR < MAG) nx += gapR;
      else if (gapL >= 0 && gapL < MAG) nx -= gapL;
    }
    if (overX > 1) {
      const gapF = o.minz - fp.maxz;
      const gapB = fp.minz - o.maxz;
      if (gapF >= 0 && gapF < MAG) nz += gapF;
      else if (gapB >= 0 && gapB < MAG) nz -= gapB;
    }
  }
  return { x: nx, z: nz };
}

function clampToApproachWalls(p, selfIdx, fromX, fromZ, toX, toZ) {
  const from = placedFootprint(p, fromX, fromZ);
  let x = toX;
  let z = toZ;
  for (let i = 0; i < state.placed.length; i++) {
    if (i === selfIdx) continue;
    const q = state.placed[i];
    if (!q) continue;
    const o = placedFootprint(q);
    if (from.minx >= o.maxx - 0.25) {
      const limit = fromX + (o.maxx - from.minx);
      if (x < limit) x = limit;
    } else if (from.maxx <= o.minx + 0.25) {
      const limit = fromX + (o.minx - from.maxx);
      if (x > limit) x = limit;
    }
    if (from.minz >= o.maxz - 0.25) {
      const limit = fromZ + (o.maxz - from.minz);
      if (z < limit) z = limit;
    } else if (from.maxz <= o.minz + 0.25) {
      const limit = fromZ + (o.minz - from.maxz);
      if (z > limit) z = limit;
    }
  }
  return { x: x, z: z };
}

function resolveDragPose(p, selfIdx, fromX, fromZ, toX, toZ) {
  const mag = magnetTowardNeighbors(p, selfIdx, toX, toZ);
  applyPlacedXZ(p, mag.x, mag.z);
}

function startMoveDrag(idx, event) {
  if (state.cutterOpen) {
    setStatus('Cutter open - close cutter to move pieces');
    return false;
  }
  const p = state.placed[idx];
  if (!p || !p.mesh) return false;
  setPointerFromEvent(event);
  const hit = hitPlateXZ();
  if (!hit) return false;
  state.moveDragging = true;
  state.moveIndex = idx;
  state.moveUndoFrom = { index: idx, x: p.x, z: p.z };
  state.moveGrab.x = p.x - hit.x;
  state.moveGrab.z = p.z - hit.z;
  if (state.controls) state.controls.enabled = false;
  if (state.renderer && state.renderer.domElement) {
    state.renderer.domElement.style.cursor = 'grabbing';
  }
  try { event.target.setPointerCapture(event.pointerId); } catch (e) {}
  showFenceLines(idx);
  return true;
}

function dragMovePlaced(event) {
  if (!state.moveDragging) return;
  const p = state.placed[state.moveIndex];
  if (!p) return;
  setPointerFromEvent(event);
  const hit = hitPlateXZ();
  if (!hit) return;
  const fromX = p.x;
  const fromZ = p.z;
  const nx = hit.x + state.moveGrab.x;
  const nz = hit.z + state.moveGrab.z;
  resolveDragPose(p, state.moveIndex, fromX, fromZ, nx, nz);
  reportJoinFlushGap();
}

function endMoveDrag() {
  if (!state.moveDragging) return;
  clearFenceLines();
  const idx = state.moveIndex;
  const from = state.moveUndoFrom;
  state.moveDragging = false;
  state.moveIndex = -1;
  state.moveUndoFrom = null;
  if (state.controls) {
    state.controls.enabled = true;
    state.controls.enableRotate = false;
  }
  if (state.renderer && state.renderer.domElement) {
    state.renderer.domElement.style.cursor = '';
  }
  updateExportButton();
  if (idx >= 0 && state.placed[idx] && from) {
    const p = state.placed[idx];
    if (Math.abs(p.x - from.x) > 0.01 || Math.abs(p.z - from.z) > 0.01) {
      pushUndo({ type: 'movePlaced', index: from.index, x: from.x, z: from.z });
    }
    if (!reportJoinFlushGap()) setStatus('Moved model #' + (idx + 1));
  }
}

function cutTFromPointer() {
  const m = getActiveModel();
  const placed = (state.placed || []).find(function (p) { return p && p.sourceId === state.editId && p.mesh; });
  const mesh = (placed && placed.mesh) || state.previewMesh;
  if (!m || !mesh) return;
  const axis = resolveAxis(m);
  const worldPos = new THREE.Vector3();
  mesh.getWorldPosition(worldPos);
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldPos.y);
  const hit = new THREE.Vector3();
  if (state.raycaster && state.camera) state.raycaster.setFromCamera(state.pointer, state.camera);
  if (!state.raycaster.ray.intersectPlane(dragPlane, hit)) return;
  const span = axis === 'x' ? m.size.x : m.size.z;
  if (!(span > 0.5)) return;
  const along = axis === 'x' ? (hit.x - (worldPos.x - span / 2)) : (hit.z - (worldPos.z - span / 2));
  const raw = Math.min(0.98, Math.max(0.02, along / span));
  state.cutT = raw;
  syncCutUI();
  updateCutHelper();
}

function onCanvasPointerMove(event) {
  if (state.cutDragging) {
    event.preventDefault();
    setPointerFromEvent(event);
    cutTFromPointer();
    return;
  }
  if (state.editYawDragging) {
    event.preventDefault();
    const dx = event.clientX - state.editYawLastX;
    state.editYawLastX = event.clientX;
    // Low sensitivity: ~0.15 deg per pixel - controllable, not gyro
    if (Math.abs(dx) > 0) rotateActiveModelY(dx * 0.15);
    return;
  }
  if (state.moveDragging) {
    event.preventDefault();
    dragMovePlaced(event);
  }
}

function clearPointerState() {
  state.cutDragging = false;
  if (state.moveDragging) endMoveDrag();
  state.moveDragging = false;
  if (state.controls) {
    state.controls.enabled = true;
    state.controls.enableRotate = false;
  }
}

function onCanvasPointerUp() {
  if (state.cutDragging) {
    state.cutDragging = false;
    if (state.controls) state.controls.enabled = true;
  }
  if (state.editYawDragging) {
    state.editYawDragging = false;
    if (state.controls) state.controls.enabled = true;
  }
  if (state.moveDragging) endMoveDrag();
  // Orbit only while actively dragging the plate
  setOrbitFromPlate(false);
}

function setOrbitFromPlate(allow) {
  if (!state.controls) return;
  state.controls.enableRotate = !!allow;
  // keep zoom; pan stays off
}

function isPlateObject(obj) {
  if (!obj) return false;
  if (obj === state.plateMesh || obj === state.plateGrid || obj === state.plateBorder) return true;
  if (state.plateTicks && state.plateTicks.indexOf(obj) >= 0) return true;
  return false;
}

function hitPlateSurface(event) {
  if (!state.renderer || !state.camera) return false;
  setPointerFromEvent(event);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const targets = [];
  if (state.plateMesh) targets.push(state.plateMesh);
  if (state.plateGrid) targets.push(state.plateGrid);
  if (state.plateBorder) targets.push(state.plateBorder);
  if (state.plateTicks && state.plateTicks.length) targets.push(...state.plateTicks);
  if (!targets.length) return false;
  const hits = state.raycaster.intersectObjects(targets, false);
  return hits.length > 0;
}

function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.classList.add('hidden');
}

function showCtxMenu(clientX, clientY) {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.classList.remove('hidden');
  const pad = 8;
  const w = menu.offsetWidth || 140;
  const h = menu.offsetHeight || 44;
  let x = clientX;
  let y = clientY;
  if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
  if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function pickPlacedIndexFromEvent(event) {
  if (!state.renderer || !state.camera || !state.modelGroup) return -1;
  setPointerFromEvent(event);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, false);
  if (!hits.length) return -1;
  const idx = hits[0].object.userData.placedIndex;
  return typeof idx === 'number' ? idx : -1;
}

function onCanvasContextMenu(event) {
  event.preventDefault();
  if (!state.placed.length) {
    hideCtxMenu();
    return;
  }
  const idx = pickPlacedIndexFromEvent(event);
  if (idx < 0) {
    hideCtxMenu();
    return;
  }
  selectPlaced(idx);
  showCtxMenu(event.clientX, event.clientY);
  setStatus('Selected #' + (idx + 1) + ' - Delete piece or press Delete');
}

function onCanvasPointerDown(event) {
  if (!state.renderer || !state.camera) return;

  // Right-click: highlight only (menu comes from contextmenu event)
  if (event.button === 2) {
    setOrbitFromPlate(false);
    const idx = pickPlacedIndexFromEvent(event);
    if (idx >= 0) selectPlaced(idx);
    return;
  }

  if (event.button !== 0) return;

  setPointerFromEvent(event);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  hideCtxMenu();

  if (state.softenArmed && state.modelGroup && event.button === 0) {
    const sHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (sHits.length) {
      let obj = sHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        selectPlaced(idx);
        const face = capturePlanarFace(sHits[0]);
        if (face) {
          showPlanarHighlight(sHits[0].object, face);
          state.softenArmed = false;
          applySoftenOnFace(face);
          event.stopPropagation();
          return;
        }
        setStatus('Soften: click a flat end, not the top', true);
        event.stopPropagation();
        return;
      }
    }
  }

  if (state.capArmed && state.modelGroup && event.button === 0) {
    const cHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (cHits.length) {
      let obj = cHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        selectPlaced(idx);
        const face = capturePlanarFace(cHits[0]);
        if (face) {
          showPlanarHighlight(cHits[0].object, face);
          state.capArmed = false;
          applyCapOnFace(face);
          event.stopPropagation();
          return;
        }
        setStatus('Cap: click a flat end, not the top', true);
        event.stopPropagation();
        return;
      }
    }
  }

  if (state.joinSession && state.modelGroup) {
    const jHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (jHits.length) {
      let obj = jHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null) {
        const sid = state.placed[idx].sourceId;
        const planar = capturePlanarFace(jHits[0]);
        if (state.joinArmed) {
          assignJoinClick(sid, planar);
          if (planar) showPlanarHighlight(jHits[0].object, planar);
          event.stopPropagation();
          return;
        }
        // Both picked: do not swallow the click — fall through so B can slide.
      }
    }
  }

  // Cutter open: clicking a DIFFERENT piece moves the red line onto it.
  // Do this BEFORE helper hit-test so the plane cannot trap the other half.
  if (state.cutterOpen && state.modelGroup) {
    const modelHits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (modelHits.length) {
      let obj = modelHits[0].object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      const idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx]) {
        const p = state.placed[idx];
        if (p.sourceId != null) {
          setOrbitFromPlate(false);
          if (state.joinSession && state.joinArmed) {
            const faceHit = modelHits[0];
            const face = captureJoinFace(faceHit);
            assignJoinClick(p.sourceId, face);
            if (state.joinUseFaces && face) showFaceHighlight(faceHit);
            event.stopPropagation();
            return;
          }
          if (p.sourceId !== state.editId) selectPlaced(idx);
          state.cutDragging = true;
          if (state.controls) state.controls.enabled = false;
          cutTFromPointer();
          event.stopPropagation();
          return;
        }
      }
    }
  }

  // Cutter plane drag - never orbit
  if (state.cutHelper) {
    const cutHits = state.raycaster.intersectObject(state.cutHelper, true);
    if (cutHits.length) {
      setOrbitFromPlate(false);
      state.cutDragging = true;
      if (state.controls) state.controls.enabled = false;
      cutTFromPointer();
      event.stopPropagation();
      return;
    }
  }

  // Models / pieces take priority over plate orbit
  if (state.modelGroup) {
    const modelHits = state.raycaster.intersectObjects(state.modelGroup.children, false);
    if (modelHits.length) {
      setOrbitFromPlate(false);
      const idx = modelHits[0].object.userData.placedIndex;
      if (typeof idx === 'number' && state.placed.length) {
        const hit = state.placed[idx];
        if (state.joinSession && state.joinArmed && hit && hit.sourceId != null) {
          const faceHit = modelHits[0];
          const face = captureJoinFace(faceHit);
          assignJoinClick(hit.sourceId, face);
          if (state.joinUseFaces && face) showFaceHighlight(faceHit);
          event.stopPropagation();
          return;
        }
        if (state.cutterOpen && hit && hit.sourceId != null) {
          if (hit.sourceId !== state.editId) selectPlaced(idx);
          state.cutDragging = true;
          if (state.controls) state.controls.enabled = false;
          cutTFromPointer();
          event.stopPropagation();
          return;
        }
        if (hit && hit.sourceId != null) selectPlaced(idx);
        startMoveDrag(idx, event);
        event.stopPropagation();
        return;
      }
      // Cutter open: left-drag on the piece = controlled Yaw only (not free orbit)
      if (state.cutterOpen && modelHits[0].object.userData.editPreview) {
        state.editYawDragging = true;
        state.editYawLastX = event.clientX;
        if (state.controls) state.controls.enabled = false;
        event.stopPropagation();
        return;
      }
      // preview mesh or non-placed - still block orbit
      event.stopPropagation();
      return;
    }
  }

  // Left-drag on plate OR empty background -> orbit (pieces still steal drag above)
  if (hitPlateSurface(event)) {
    setOrbitFromPlate(true);
    return;
  }

  setOrbitFromPlate(true);
}

function clearSelectionOutline() {
  state.placed.forEach((p, i) => {
    if (p.mesh) {
      if (p.outline) {
        p.mesh.remove(p.outline);
        if (p.outline.geometry) p.outline.geometry.dispose();
        if (p.outline.material) p.outline.material.dispose();
        p.outline = null;
      }
      if (p.mesh.material) {
        const hue = p.overflow ? 0.05 : (0.55 + (i % 8) * 0.03);
        p.mesh.material.color.setHSL(hue, 0.7, 0.55);
        p.mesh.material.emissive = new THREE.Color(0x000000);
        p.mesh.material.emissiveIntensity = 0;
      }
    }
  });
}

function selectPlaced(idx) {
  clearSelectionOutline();

  state.selectedIndex = idx;
  const p = state.placed[idx];
  if (p && p.mesh) {
    p.mesh.material.emissive = new THREE.Color(0xdc2626);
    p.mesh.material.emissiveIntensity = 0.55;
  }
  // Keep Square-cut / Open cutter in sync with the plate selection
  if (p && p.sourceId != null) {
    const m = state.models.find(x => x.id === p.sourceId);
    if (m) {
      const isJoinBit = !!(state.joinSession && state.joinPartnerId != null && p.sourceId === state.joinPartnerId);
      if (!isJoinBit) {
        state.editId = m.id;
        if (state.joinSession) state.joinHullId = m.id;
      }
      updateEditSize();
      renderModelList();
      if (state.cutterOpen) {
        removeCutHelper();
        state.previewMesh = p.mesh;
        if (state.cutT == null) state.cutT = 0.5;
        buildCutHelper();
        setStatus('Cutter on ' + m.name + ' - drag red line, then Split.');
      }
    }
  }
  updateAdjustUI();
  updateCutterUI();
  if (typeof updateJoinUI === 'function') updateJoinUI();
}

function updateExportButton() {
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
}

function updateAdjustUI() {
  if (typeof applyXrayView === 'function') applyXrayView();
  const has = state.selectedIndex >= 0 && state.placed[state.selectedIndex];
  ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-roll', 'btn-raise', 'btn-lower', 'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn', 'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back', 'btn-delete-placed', 'btn-frame-selected']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !has;
    });
  const cloneBtn = document.getElementById('btn-clone');
  if (cloneBtn) cloneBtn.disabled = !(has || getActiveModel());
  const status = document.getElementById('adjust-status');
  if (status) {
    status.textContent = has
      ? `Selected #${state.selectedIndex + 1} - drag to move, right-click to delete`
      : (state.placed.length ? 'Left-drag a piece to move it' : 'No model selected');
  }
  const delModel = document.getElementById('btn-delete-model');
  if (delModel) delModel.disabled = !getActiveModel();
  updateExportButton();
}

function reindexPlacedMeshes() {
  state.placed.forEach((p, i) => {
    if (p.mesh) p.mesh.userData.placedIndex = i;
  });
}

function deleteSelectedPlaced() {
  hideCtxMenu();
  const idx = state.selectedIndex;
  if (idx < 0 || !state.placed[idx]) {
    setStatus('Click or right-click a piece on the plate first', true);
    return;
  }
  const p = state.placed[idx];
  const name = p.name || ('#' + (idx + 1));
  pushUndo({
    type: 'removePlaced',
    index: idx,
    item: {
      name: p.name, x: p.x, z: p.z, yaw: p.yaw || 0,
      rotY: p.rotY || 0, flipX: !!p.flipX, tipX: p.tipX || 0,
      width: p.width, depth: p.depth, height: p.height,
      overflow: p.overflow, sourceId: p.sourceId,
      geometry: p.geometry, mesh: null, outline: null
    }
  });
  clearSelectionOutline();
  if (p.mesh && state.modelGroup) {
    state.modelGroup.remove(p.mesh);
    if (p.outline) {
      p.outline = null;
    }
    if (p.mesh.geometry && p.mesh.userData && p.mesh.userData.editPreview) {
      /* shared geo - do not dispose */
    } else if (p.mesh.material) {
      if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
      else p.mesh.material.dispose();
    }
  }
  const sourceId = p.sourceId;
  state.placed.splice(idx, 1);
  state.selectedIndex = -1;
  if (sourceId != null && !state.placed.some(function (x) { return x && x.sourceId === sourceId; })) {
    state.models = state.models.filter(function (m) { return m.id !== sourceId; });
    if (state.editId === sourceId) state.editId = null;
    if (state.joinPartnerId === sourceId) state.joinPartnerId = null;
    renderModelList();
  }
  reindexPlacedMeshes();
  updateAdjustUI();
  // refresh fill stats if present
  const stats = document.getElementById('stats');
  if (stats && !stats.classList.contains('hidden')) {
    const fitted = state.placed.filter(x => !x.overflow).length;
    const plate = getCurrentPlate();
    const totalArea = plate.w * plate.d;
    const usedArea = state.placed.filter(x => !x.overflow).reduce((s, x) => s + x.width * x.depth, 0);
    const fill = totalArea > 0 ? ((usedArea / totalArea) * 100).toFixed(1) : 0;
    document.getElementById('stat-count').textContent = fitted + ' models';
    document.getElementById('stat-fill').textContent = fill + '% fill';
  }
  setStatus('Deleted ' + name + ' from plate (' + state.placed.length + ' left)');
}

function deleteActiveModel() {
  const m = getActiveModel();
  if (!m) {
    setStatus('Select a model in the list first', true);
    return;
  }
  const id = m.id;
  const name = m.name;
  const idx = state.models.findIndex(x => x.id === id);
  pushUndo({ type: 'removeModel', model: m, index: idx, editId: state.editId });
  state.models = state.models.filter(x => x.id !== id);
  if (state.editId === id) {
    state.editId = state.models.length ? state.models[state.models.length - 1].id : null;
    state.cutT = 0.5;
  }
  // Also drop any placed instances from this source
  const kept = [];
  state.placed.forEach((p, i) => {
    if (p.sourceId === id) {
      if (p.mesh && state.modelGroup) {
        state.modelGroup.remove(p.mesh);
        if (p.mesh.material) {
          if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(mat => mat.dispose());
          else p.mesh.material.dispose();
        }
      }
    } else {
      kept.push(p);
    }
  });
  state.placed = kept;
  state.selectedIndex = -1;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  reindexPlacedMeshes();
  renderModelList();
  updateOptimizeButton();
  updateAdjustUI();
  updateCutterUI();
  if (state.cutterOpen && state.editId) {
    showEditPreview();
  } else if (!state.models.length) {
    clearPlaced();
    removeCutHelper();
    state.previewMesh = null;
  } else if (state.cutterOpen) {
    showEditPreview();
  }
  updateEditSize();
  setStatus('Deleted model ' + name + ' (waste/source removed)');
}

function snapshotPlacedPose(idx) {
  const p = state.placed[idx];
  if (!p) return null;
  return {
    type: 'posePlaced',
    index: idx,
    x: p.x, z: p.z,
    rotY: p.rotY || 0,
    flipX: !!p.flipX,
    tipX: p.tipX || 0,
    tipZ: p.tipZ || 0,
    liftY: p.liftY || 0,
    tiltX: p.tiltX || 0,
    tiltZ: p.tiltZ || 0,
    width: p.width, depth: p.depth, height: p.height,
    yaw: p.yaw || 0
  };
}

function rotateSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));

  p.rotY = (p.rotY || 0) + dir * (Math.PI / 2);
  p.rotated = Math.abs(Math.sin(p.rotY)) > 0.5;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus(`Yaw #${state.selectedIndex + 1}`);
}

function flipSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) {
    setStatus('Select a piece first', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.rotY = (p.rotY || 0) + Math.PI;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Edge 180°');
}

// Tip 90 deg around X - cycles which face sits on the bed (any model)
function tipSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));

  p.tipX = ((p.tipX || 0) + 1) % 4; // 0,1,2,3 -> 0,90,180,270 deg
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Tip X ' + ((p.tipX || 0) * 90) + '°');
}

function rollSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.tipZ = ((p.tipZ || 0) + 1) % 4;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Roll Z ' + ((p.tipZ || 0) * 90) + '°');
}

function liftSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  const step = 2;
  p.liftY = Math.max(0, Math.min(80, (p.liftY || 0) + dir * step));
  applyMeshRotation(p);
  refreshOutline(p);
  setStatus(p.liftY ? ('Lift ' + p.liftY.toFixed(0) + ' mm') : 'On plate');
}

function bankSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.tiltZ = (p.tiltZ || 0) + dir * 15;
  if (p.tiltZ > 180) p.tiltZ -= 360;
  if (p.tiltZ < -180) p.tiltZ += 360;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Bank ' + p.tiltZ + '°');
}

function tiltSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));
  p.tiltX = (p.tiltX || 0) + dir * 15;
  if (p.tiltX > 180) p.tiltX -= 360;
  if (p.tiltX < -180) p.tiltX += 360;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus('Tilt ' + p.tiltX + '°');
}

function applyMeshRotation(p) {
  const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
  const flip = p.flipX ? Math.PI : 0;
  const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
  p.mesh.rotation.set(tip + flip, p.rotY || 0, roll);
  p.mesh.updateMatrixWorld(true);
  const bbox = meshLocalBox3(p.mesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  p.width = size.x;
  p.depth = size.z;
  p.height = size.y;
  const lift = p.liftY || 0;
  p.mesh.position.set(p.x, p.height / 2 + 0.2 + lift, p.z);
  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
  }
}

function refreshOutline(p) {
  if (!p) return;
  if (p.outline) {
    if (p.mesh) p.mesh.remove(p.outline);
    if (p.outline.geometry) p.outline.geometry.dispose();
    if (p.outline.material) p.outline.material.dispose();
    p.outline = null;
  }
}

function nudgeSelected(dx, dz) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo({ type: 'movePlaced', index: state.selectedIndex, x: p.x, z: p.z });
  applyPlacedXZ(p, p.x + dx, p.z + dz);
  updateExportButton();
  if (!reportJoinFlushGap()) setStatus(`Moved model #${state.selectedIndex + 1}`);
}

// ===================== Export =====================
// Three.js is Y-up. Bambu / most slicers are Z-up.
// Convert (x, y, z)_three -> (x, z, y)_slicer so the plate lies flat.
function buildCombinedGeometry() {
  const positions = [];
  state.placed.forEach(p => {
    const geo = p.geometry.clone();
    const tip = (p.tipX || 0) * (Math.PI / 2) + ((p.tiltX || 0) * Math.PI / 180);
    const flip = p.flipX ? Math.PI : 0;
    if (tip || flip) geo.rotateX(tip + flip);
    const rotY = p.rotY != null ? p.rotY : (p.rotated ? Math.PI / 2 : 0);
    if (rotY) geo.rotateY(rotY);
    const roll = (p.tipZ || 0) * (Math.PI / 2) + ((p.tiltZ || 0) * Math.PI / 180);
    if (roll) geo.rotateZ(roll);
    geo.translate(p.x, p.height / 2, p.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // height in Three.js
      const z = pos.getZ(i);
      // Inverse of import: (x,y,z)_Yup -> (x,-z,y)_Zup for Bambu
      positions.push(x, -z, y);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

// Binary STL is smaller and more reliable than ASCII
function geometryToBinarySTL(geometry) {
  const pos = geometry.attributes.position;
  const numTriangles = Math.floor(pos.count / 3);
  const bufferLength = 84 + numTriangles * 50;
  const buffer = new ArrayBuffer(bufferLength);
  const view = new DataView(buffer);

  // 80-byte header
  const header = 'Nest Optimizer';
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  }
  view.setUint32(80, numTriangles, true);

  let offset = 84;
  for (let i = 0; i < numTriangles; i++) {
    const i3 = i * 3;
    const ax = pos.getX(i3), ay = pos.getY(i3), az = pos.getZ(i3);
    const bx = pos.getX(i3 + 1), by = pos.getY(i3 + 1), bz = pos.getZ(i3 + 1);
    const cx = pos.getX(i3 + 2), cy = pos.getY(i3 + 2), cz = pos.getZ(i3 + 2);

    // Simple normal (not critical for import)
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;
    view.setFloat32(offset, 0, true); offset += 4;

    view.setFloat32(offset, ax, true); offset += 4;
    view.setFloat32(offset, ay, true); offset += 4;
    view.setFloat32(offset, az, true); offset += 4;
    view.setFloat32(offset, bx, true); offset += 4;
    view.setFloat32(offset, by, true); offset += 4;
    view.setFloat32(offset, bz, true); offset += 4;
    view.setFloat32(offset, cx, true); offset += 4;
    view.setFloat32(offset, cy, true); offset += 4;
    view.setFloat32(offset, cz, true); offset += 4;

    view.setUint16(offset, 0, true); offset += 2; // attribute byte count
  }
  return buffer;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

function exportSTLs() {
  if (!state.placed.length) {
    setStatus('Nothing to export - run Optimize first', true);
    return;
  }

  setStatus('Building STL...');

  try {
    const geo = buildCombinedGeometry();
    const buffer = geometryToBinarySTL(geo);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const plateName = getCurrentPlate().name.replace(/\s+/g, '_').replace(/[\/\\?%*:|"<>]/g, '');
    const filename = `nest_${plateName}_${state.placed.length}pcs.stl`;

    downloadBlob(blob, filename);
    setStatus(`Downloaded ${filename}`);
  } catch (err) {
    console.error(err);
    setStatus('Export failed - check console', true);
  }
}



// ===================== Edit: square-cut / array =====================
