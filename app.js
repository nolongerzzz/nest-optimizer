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
  joinPickMode: false,
  joinArmed: null,
  joinSession: false,
  joinFaceA: null,
  joinFaceB: null,
  joinUseFaces: false,
  faceHelper: null,
  softenArmed: false,
  capArmed: false,
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
  if (above) {
    mat.opacity = 0.88;
    mat.transparent = true;
    mat.depthWrite = true;
    mat.color.setHex(0x24344c);
    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.28;
  } else {
    mat.opacity = 0.08;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.color.setHex(0x152033);
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
    color: 0x24344c,
    metalness: 0.05,
    roughness: 0.85,
    emissive: 0x1a2332,
    emissiveIntensity: 0.28,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.88,
    depthWrite: true
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.plateMesh.position.y = 0;
  state.plateMesh.receiveShadow = true;
  state.scene.add(state.plateMesh);

  // Grid on the floor - not a child of the rotated plate
  const grid = new THREE.GridHelper(Math.max(p.w, p.d), 18, 0x3b4f6b, 0x1e2d42);
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
    setStatus('Moved model #' + (idx + 1));
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
      state.editId = m.id;
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
  setStatus(`Moved model #${state.selectedIndex + 1}`);
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
  if (loopA.length === loopB.length) {
    const n = loopA.length;
    const strip = [];
    for (let i = 0; i < n; i++) {
      const i1 = (i+1) % n;
      strip.push([loopA[i], loopA[i1], loopB[i1]]);
      strip.push([loopA[i], loopB[i1], loopB[i]]);
    }
    return strip;
  }
  function cumlen(poly) {
    const n = poly.length; let total = 0; const t = [0];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i+1)%n];
      total += Math.hypot(b[0]-a[0], b[1]-a[1]);
      if (i < n-1) t.push(total);
    }
    return { t, total };
  }
  const A = loopA, B = loopB;
  const nA = A.length, nB = B.length;
  const { t: tA, total: totalA } = cumlen(A);
  const { t: tBraw, total: totalB } = cumlen(B);
  const tB = tBraw.map(v => v * (totalA / Math.max(totalB, 1e-9)));
  const strip = [];
  let i = 0, j = 0, guard = 0;
  while ((i < nA || j < nB) && guard++ < 20000) {
    const iNext = (i+1)%nA, jNext = (j+1)%nB;
    const tiNext = iNext !== 0 ? tA[iNext] : totalA;
    const tjNext = jNext !== 0 ? tB[jNext] : totalA;
    if (iNext === 0 && jNext === 0) {
      // Both loops close on this step — stitch the final quad instead of
      // dropping it. Same two-triangle-per-step shape as every other
      // step (and the equal-length fast path above), just the last one.
      strip.push([A[i], A[iNext], B[j]]);
      strip.push([A[i], B[jNext], B[j]]);
      break;
    }
    const advanceA = (tiNext <= tjNext && iNext !== 0) || (jNext === 0 && iNext !== 0);
    if (advanceA) { strip.push([A[i], A[iNext], B[j]]); i = iNext; }
    else { strip.push([A[i], B[jNext], B[j]]); j = jNext; }
    if (i === 0 && j === 0) break;
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
  if (poly2d.length < 8) throw new Error('boundary too small to fillet after weld');
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
  const centers = corners.map(ci => {
    const prev = poly2d[(ci-2+n)%n], curr = poly2d[ci], next = poly2d[(ci+2)%n];
    const n1 = rawEdgeInwardNormal2(prev, curr), n2 = rawEdgeInwardNormal2(curr, next);
    return { i: ci, C: rawSolveCornerCenter2(curr, n1, n2, Rs[ci]), n1, n2, R: Rs[ci] };
  });

  function vertexOffset(i, radius) {
    const prev = poly2d[(i-1+n)%n], curr = poly2d[i], next = poly2d[(i+1)%n];
    const n1 = rawEdgeInwardNormal2(prev, curr), n2 = rawEdgeInwardNormal2(curr, next);
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
      for (const c of centers) {
        if (!c.C) continue;
        let d = ((i - c.i + n) % n); if (d > n/2) d -= n;
        const absD = Math.abs(d);
        if (absD > windowN) continue;
        // Index proximity alone isn't a reliable blend radius — this
        // boundary has non-uniform point spacing (confirmed: 14mm
        // covered in 6 index steps near one corner), so an index-only
        // window pulled a physically-distant point toward the corner
        // sphere just because it was index-close. Gate on actual
        // distance to the corner point too.
        const distToCorner = Math.hypot(poly2d[i][0]-poly2d[c.i][0], poly2d[i][1]-poly2d[c.i][1]);
        if (distToCorner > c.R * 4) continue;
        const w = rawSmoothstep2(1 - absD/windowN);
        const negN1 = [-c.n1[0], -c.n1[1]], negN2 = [-c.n2[0], -c.n2[1]];
        const tBlend = (d + windowN) / (2*windowN);
        const nBlend = rawSlerp2D2(negN1, negN2, tBlend);
        const suv = [c.C[0]+c.R*Math.cos(phi)*nBlend[0], c.C[1]+c.R*Math.cos(phi)*nBlend[1]];
        uv = [uv[0]*(1-w)+suv[0]*w, uv[1]*(1-w)+suv[1]*w];
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
  const { kept: bodyTrimmed, cutEdges: marginEdges } = rawClipTrianglesAtPlane(rawTris, axisIdx, marginPlane, keepMin);
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

// ===================== Soften Selected (post-cut Edit action) =====================
// Runs the SAME validated rawFilletCut engine as the Soft-finish post-pass,
// but as an independent Edit action on the currently selected library
// model — never wired into Split/splitBothSides, never touches the
// display mesh directly (always rebuilds from rawTris). No model other
// than the selected one is touched.
//
// A model carries no record of which face (if any) was its own cut face,
// and Split is locked from being changed to add that. So this tries both
// raw-X extremes of the piece independently: whichever one is an actual
// flat cut face has a real boundary loop to round; a factory-curved end
// simply has no meaningful boundary there and rawFilletCut fails safely,
// so it's skipped rather than mangled. Chained, not exclusive — if only
// one end is a real cut face, only that one changes.
function softenSelectedFace(rawTris, axisIdx, keepMinFace, R) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  // Clipping exactly AT the piece's own extreme finds nothing to cross —
  // every vertex already satisfies the boundary, so no cut edges exist to
  // build a loop from. Nudge slightly inward so the clip actually crosses
  // the flat face's own triangles and recovers its true boundary shape.
  const EPS = 0.02;
  const plane = keepMinFace ? minV + EPS : maxV - EPS;
  // keepMin=true keeps coord >= plane (the upper/max side) in this
  // engine's convention — confirmed directly, opposite of the name's
  // surface reading. To soften the MAX face and keep the rest of the
  // piece, keep coord <= plane, i.e. keepMin=false; to soften the MIN
  // face and keep the rest, keep coord >= plane, i.e. keepMin=true.
  const keepMin = keepMinFace;
  return rawFilletCut(rawTris, axisIdx, plane, keepMin, R);
}

function dropZeroAreaTriangles(soup, epsArea) {
  epsArea = epsArea == null ? 1e-6 : epsArea;
  const triCount = (soup.length / 9) | 0;
  const out = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
    const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
    const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (area > epsArea) out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  return out.length >= 9 ? new Float32Array(out) : soup;
}

function flipInconsistentWindings(soup) {
  const triCount = (soup.length / 9) | 0;
  if (triCount < 2) return soup;

  function keyv(x, y, z) { return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000); }
  const vidMap = new Map();
  function vid(x, y, z) {
    const k = keyv(x, y, z);
    let id = vidMap.get(k);
    if (id === undefined) { id = vidMap.size; vidMap.set(k, id); }
    return id;
  }
  const triV = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    triV[t] = [
      vid(soup[i0], soup[i0 + 1], soup[i0 + 2]),
      vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]),
      vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8])
    ];
  }

  const dirEdge = new Map();
  function dk(a, b) { return a + '_' + b; }
  for (let t = 0; t < triCount; t++) {
    const tv = triV[t];
    [[tv[0], tv[1]], [tv[1], tv[2]], [tv[2], tv[0]]].forEach(function (e) {
      const k = dk(e[0], e[1]);
      if (!dirEdge.has(k)) dirEdge.set(k, []);
      dirEdge.get(k).push(t);
    });
  }

  const flip = new Uint8Array(triCount);
  const visited = new Uint8Array(triCount);
  let flippedCount = 0;

  for (let s = 0; s < triCount; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const stack = [s];
    while (stack.length) {
      const t = stack.pop();
      const tv = triV[t];
      [[tv[0], tv[1]], [tv[1], tv[2]], [tv[2], tv[0]]].forEach(function (e) {
        const a0 = e[0], b0 = e[1];
        const fwd = flip[t] ? [b0, a0] : [a0, b0];
        const sameDirPeers = dirEdge.get(dk(a0, b0)) || [];
        const oppDirPeers = dirEdge.get(dk(b0, a0)) || [];
        sameDirPeers.concat(oppDirPeers).forEach(function (o) {
          if (o === t || visited[o]) return;
          const oOrigFwd = sameDirPeers.indexOf(o) !== -1 ? [a0, b0] : [b0, a0];
          flip[o] = (oOrigFwd[0] === fwd[0]) ? 1 : 0;
          if (flip[o]) flippedCount++;
          visited[o] = 1;
          stack.push(o);
        });
      });
    }
  }

  if (!flippedCount || flippedCount > triCount * 0.15) return soup;

  const out = new Float32Array(soup.length);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    if (flip[t]) {
      out[i0] = soup[i0]; out[i0 + 1] = soup[i0 + 1]; out[i0 + 2] = soup[i0 + 2];
      out[i0 + 3] = soup[i0 + 6]; out[i0 + 4] = soup[i0 + 7]; out[i0 + 5] = soup[i0 + 8];
      out[i0 + 6] = soup[i0 + 3]; out[i0 + 7] = soup[i0 + 4]; out[i0 + 8] = soup[i0 + 5];
    } else {
      for (let k = 0; k < 9; k++) out[i0 + k] = soup[i0 + k];
    }
  }
  return out;
}

function pruneDustShells(soup) {
  const triCount = (soup.length / 9) | 0;
  if (triCount < 2) return soup;
  function keyv(x, y, z) { return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000); }
  const vidMap = new Map();
  function vid(x, y, z) {
    const k = keyv(x, y, z);
    let id = vidMap.get(k);
    if (id === undefined) { id = vidMap.size; vidMap.set(k, id); }
    return id;
  }
  const triV = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    triV[t] = [
      vid(soup[i0], soup[i0 + 1], soup[i0 + 2]),
      vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]),
      vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8])
    ];
  }
  const parent = new Array(triCount);
  for (let t = 0; t < triCount; t++) parent[t] = t;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  const edgeMap = new Map();
  function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  for (let t = 0; t < triCount; t++) {
    const tv = triV[t];
    [ek(tv[0], tv[1]), ek(tv[1], tv[2]), ek(tv[2], tv[0])].forEach(function (k) {
      if (!edgeMap.has(k)) edgeMap.set(k, []);
      edgeMap.get(k).push(t);
    });
  }
  edgeMap.forEach(function (list) { for (let i = 1; i < list.length; i++) union(list[0], list[i]); });

  const compTris = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    if (!compTris.has(r)) compTris.set(r, []);
    compTris.get(r).push(t);
  }
  if (compTris.size < 2) return soup;

  let totalVol = 0;
  const compInfo = [];
  compTris.forEach(function (tris) {
    let vol = 0;
    for (let k = 0; k < tris.length; k++) {
      const i0 = tris[k] * 9;
      const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
      const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
      const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    vol = Math.abs(vol);
    totalVol += vol;
    compInfo.push({ tris: tris, vol: vol });
  });
  compInfo.sort(function (a, b) {
    if (Math.abs(a.vol - b.vol) > 1e-9) return b.vol - a.vol;
    return b.tris.length - a.tris.length;
  });
  const keepTriIdx = new Set();
  for (let i = 0; i < compInfo.length; i++) {
    const c = compInfo[i];
    const share = totalVol > 0 ? c.vol / totalVol : 0;
    const keep = (i === 0) || (c.tris.length >= 20 && share >= 0.02);
    if (keep) for (let k = 0; k < c.tris.length; k++) keepTriIdx.add(c.tris[k]);
  }
  const filtered = [];
  for (let t = 0; t < triCount; t++) {
    if (!keepTriIdx.has(t)) continue;
    const i0 = t * 9;
    for (let k = 0; k < 9; k++) filtered.push(soup[i0 + k]);
  }
  return filtered.length >= 9 ? new Float32Array(filtered) : soup;
}

function countNonManifoldEdges(soup) {
  try {
    const triCount = (soup.length / 9) | 0;
    function keyv(x, y, z) { return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000); }
    const vidMap = new Map();
    function vid(x, y, z) {
      const k = keyv(x, y, z);
      let id = vidMap.get(k);
      if (id === undefined) { id = vidMap.size; vidMap.set(k, id); }
      return id;
    }
    const edgeCount = new Map();
    function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 9;
      const a = vid(soup[i0], soup[i0 + 1], soup[i0 + 2]);
      const b = vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]);
      const c = vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8]);
      [ek(a, b), ek(b, c), ek(c, a)].forEach(function (k) {
        edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
      });
    }
    let nm = 0;
    edgeCount.forEach(function (n) { if (n > 2) nm++; });
    return nm;
  } catch (e) {
    return null;
  }
}

function repairForPrint(soup) {
  if (!soup || soup.length < 9) return { soup: null, ok: false, reason: 'empty input' };

  function bboxVolume(s) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ);
  }

  const volBefore = bboxVolume(soup);
  let working = soup;
  try {
    working = dropZeroAreaTriangles(working, 1e-6);
    working = weldSoupVerts(working, 0.05);
    if (!working || working.length < 9) return { soup: null, ok: false, reason: 'weld collapsed mesh' };

    working = flipInconsistentWindings(working);
    working = pruneDustShells(working);
    if (typeof capSmallOpenLoops === 'function') {
      working = capSmallOpenLoops(working, 3);
    }
  } catch (e) {
    return { soup: null, ok: false, reason: 'repair pass threw: ' + (e && e.message || e) };
  }

  if (!working || working.length < 9) {
    return { soup: null, ok: false, reason: 'repair pass produced empty mesh' };
  }
  const volAfter = bboxVolume(working);
  if (volBefore > 0 && volAfter < volBefore * 0.85) {
    return { soup: null, ok: false, reason: 'bbox shrank >15% - possible bad flip/prune' };
  }
  return { soup: working, ok: true, reason: null };
}

function sealSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece in the list first', true); return; }

  function localSoupFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    const pos = geo.attributes.position;
    const index = geo.index;
    const out = [];
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
    }
    return out.length >= 9 ? new Float32Array(out) : null;
  }

  const usingRaw = !!(m.rawTris && m.rawAxis === 'zup');
  const soupIn = usingRaw ? m.rawTris : localSoupFromGeometry(m.geometry);
  if (!soupIn || soupIn.length < 9) {
    setStatus('Seal failed - piece unchanged', true);
    return;
  }

  const repairChk = document.getElementById('chk-seal-repair');
  const repairMode = !!(repairChk && repairChk.checked);

  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  if (repairMode) { try { nmBefore = countNonManifoldEdges(soupIn); } catch (e) {} }

  let working = soupIn;
  let ok = true;
  let failReason = null;

  if (repairMode) {
    const result = repairForPrint(soupIn);
    ok = result.ok;
    working = result.soup;
    failReason = result.reason;
  } else {
    try {
      working = weldSoupVerts(working);
      if (typeof capSmallOpenLoops === 'function') {
        working = capSmallOpenLoops(working, 3);
      }
      working = capAllOuterHoles(working);
      if (typeof repairJoinedSoup === 'function') {
        working = repairJoinedSoup(working);
      }
    } catch (e) {
      ok = false;
    }
  }

  if (!ok || !working || working.length < 9) {
    setStatus(repairMode ? ('Repair failed - piece unchanged (' + (failReason || 'unknown') + ')') : 'Seal failed - piece unchanged', true);
    return;
  }

  pushUndo({
    type: 'sealReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  let newGeo;
  if (usingRaw) {
    newGeo = rawResultToDisplayGeometry(working);
  } else {
    newGeo = soupToCenteredGeo(working);
  }
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  if (usingRaw) {
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
  }
  m.size = { x: size2.x, y: size2.y, z: size2.z };

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
    settlePlacedOnBed(placedEntry);
  }

  let openAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}

  if (repairMode) {
    let nmAfter = null;
    try { nmAfter = countNonManifoldEdges(working); } catch (e) {}
    const openStr = (openBefore != null && openAfter != null) ? (openBefore + '\u2192' + openAfter) : '?';
    const nmStr = (nmBefore != null && nmAfter != null) ? (nmBefore + '\u2192' + nmAfter) : '?';
    setStatus('Repair done - open edges ' + openStr + ', non-manifold ' + nmStr);
  } else {
    if (openBefore != null && openAfter != null) {
      setStatus('Seal ok - open edges ' + openBefore + '\u2192' + openAfter);
    } else {
      setStatus('Seal ok');
    }
  }
}


function solidifySelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  function localSoupFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    const pos = geo.attributes.position;
    const index = geo.index;
    const out = [];
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      }
    }
    return out.length >= 9 ? new Float32Array(out) : null;
  }
  const usingRaw = !!(m.rawTris && m.rawAxis === 'zup');
  const soupIn = usingRaw ? m.rawTris : localSoupFromGeometry(m.geometry);
  if (!soupIn || soupIn.length < 9) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmBefore = countNonManifoldEdges(soupIn); } catch (e) {}
  let working = soupIn;
  try {
    working = weldSoupVerts(working);
    if (typeof capSmallOpenLoops === 'function') working = capSmallOpenLoops(working, 28);
    working = capAllOuterHoles(working);
    if (typeof repairJoinedSoup === 'function') working = repairJoinedSoup(working);
    working = weldSoupVerts(working);
  } catch (e) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  if (!working || working.length < 9) {
    setStatus('Solidify failed - piece unchanged', true);
    return;
  }
  pushUndo({
    type: 'solidifyReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });
  let newGeo;
  if (usingRaw) newGeo = rawResultToDisplayGeometry(working);
  else newGeo = soupToCenteredGeo(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  m.geometry = newGeo;
  if (usingRaw) {
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
  }
  m.size = { x: size2.x, y: size2.y, z: size2.z };
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
    settlePlacedOnBed(placedEntry);
  }
  let openAfter = null, nmAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmAfter = countNonManifoldEdges(working); } catch (e) {}
  if (openBefore != null && openAfter != null) {
    let msg = 'Solidify ok - open ' + openBefore + '\u2192' + openAfter;
    if (nmBefore != null && nmAfter != null) msg += ', NM ' + nmBefore + '\u2192' + nmAfter;
    setStatus(msg);
  } else {
    setStatus('Solidify ok');
  }
}

// ---- Thicken: voxel dilate/erode helpers (new, not used by Solidify) ----

const THICKEN_MAX_DIM = 110;
const THICKEN_TARGET_STEPS = 4;
const THICKEN_PAD_VOX = 3;

function _thickenBBoxOfSoup(soup) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function _thickenChoosePitch(bb, offsetMm) {
  const spanX = Math.max(1e-3, bb.maxX - bb.minX);
  const spanY = Math.max(1e-3, bb.maxY - bb.minY);
  const spanZ = Math.max(1e-3, bb.maxZ - bb.minZ);
  let pitch = Math.max(offsetMm / THICKEN_TARGET_STEPS, 0.05);
  function dims(p) {
    return [
      Math.ceil(spanX / p) + THICKEN_PAD_VOX * 2,
      Math.ceil(spanY / p) + THICKEN_PAD_VOX * 2,
      Math.ceil(spanZ / p) + THICKEN_PAD_VOX * 2
    ];
  }
  let [nx, ny, nz] = dims(pitch);
  let guard = 0;
  while ((nx > THICKEN_MAX_DIM || ny > THICKEN_MAX_DIM || nz > THICKEN_MAX_DIM) && guard < 60) {
    pitch *= 1.25;
    [nx, ny, nz] = dims(pitch);
    guard++;
  }
  return pitch;
}

function _thickenPointInTri2D(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

function _thickenVoxelize(soup, pitch) {
  const bb = _thickenBBoxOfSoup(soup);
  const pad = THICKEN_PAD_VOX * pitch;
  const ox = bb.minX - pad, oy = bb.minY - pad, oz = bb.minZ - pad;
  const nx = Math.max(1, Math.ceil((bb.maxX - bb.minX) / pitch) + THICKEN_PAD_VOX * 2);
  const ny = Math.max(1, Math.ceil((bb.maxY - bb.minY) / pitch) + THICKEN_PAD_VOX * 2);
  const nz = Math.max(1, Math.ceil((bb.maxZ - bb.minZ) / pitch) + THICKEN_PAD_VOX * 2);

  const grid = new Uint8Array(nx * ny * nz);
  const idx = (ix, iy, iz) => (ix * ny + iy) * nz + iz;

  const buckets = new Array(nx * ny);
  const triCount = (soup.length / 9) | 0;
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = soup[i], ay = soup[i + 1];
    const bx = soup[i + 3], by = soup[i + 4];
    const cxp = soup[i + 6], cyp = soup[i + 7];
    const minXt = Math.min(ax, bx, cxp), maxXt = Math.max(ax, bx, cxp);
    const minYt = Math.min(ay, by, cyp), maxYt = Math.max(ay, by, cyp);
    const ix0 = Math.max(0, Math.floor((minXt - ox) / pitch) - 1);
    const ix1 = Math.min(nx - 1, Math.ceil((maxXt - ox) / pitch) + 1);
    const iy0 = Math.max(0, Math.floor((minYt - oy) / pitch) - 1);
    const iy1 = Math.min(ny - 1, Math.ceil((maxYt - oy) / pitch) + 1);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const bi = ix * ny + iy;
        if (!buckets[bi]) buckets[bi] = [];
        buckets[bi].push(t);
      }
    }
  }

  const EPS = 1e-6;
  for (let ix = 0; ix < nx; ix++) {
    const cx = ox + (ix + 0.5) * pitch;
    for (let iy = 0; iy < ny; iy++) {
      const list = buckets[ix * ny + iy];
      if (!list || !list.length) continue;
      const cy = oy + (iy + 0.5) * pitch;
      const zs = [];
      for (let li = 0; li < list.length; li++) {
        const i = list[li] * 9;
        const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
        const bx = soup[i + 3], by = soup[i + 4], bz = soup[i + 5];
        const cxp = soup[i + 6], cyp = soup[i + 7], cz = soup[i + 8];
        if (!_thickenPointInTri2D(cx, cy, ax, ay, bx, by, cxp, cyp)) continue;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cxp - ax, e2y = cyp - ay, e2z = cz - az;
        const nX = e1y * e2z - e1z * e2y;
        const nY = e1z * e2x - e1x * e2z;
        const nZ = e1x * e2y - e1y * e2x;
        if (Math.abs(nZ) < EPS) continue;
        zs.push(az - (nX * (cx - ax) + nY * (cy - ay)) / nZ);
      }
      if (zs.length < 2) continue;
      zs.sort((a, b) => a - b);
      const uniq = [];
      for (let k = 0; k < zs.length; k++) {
        if (k === 0 || zs[k] - uniq[uniq.length - 1] > pitch * 0.1) uniq.push(zs[k]);
        else uniq[uniq.length - 1] = zs[k];
      }
      const pairCount = uniq.length - (uniq.length % 2);
      for (let k = 0; k < pairCount; k += 2) {
        const z0 = uniq[k], z1 = uniq[k + 1];
        const iz0 = Math.max(0, Math.ceil((z0 - oz) / pitch - 0.5));
        const iz1 = Math.min(nz - 1, Math.floor((z1 - oz) / pitch - 0.5));
        for (let iz = iz0; iz <= iz1; iz++) grid[idx(ix, iy, iz)] = 1;
      }
    }
  }
  return { grid, nx, ny, nz, ox, oy, oz, pitch, idx };
}

function _thickenClassifyExterior(vox) {
  const { grid, nx, ny, nz, idx } = vox;
  const exterior = new Uint8Array(nx * ny * nz);
  const total = nx * ny * nz;
  const qx = new Int32Array(total), qy = new Int32Array(total), qz = new Int32Array(total);
  let qh = 0, qt = 0;
  function tryPush(ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return;
    const id = idx(ix, iy, iz);
    if (grid[id] === 1 || exterior[id] === 1) return;
    exterior[id] = 1;
    qx[qt] = ix; qy[qt] = iy; qz[qt] = iz; qt++;
  }
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) { tryPush(ix, iy, 0); tryPush(ix, iy, nz - 1); }
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) { tryPush(ix, 0, iz); tryPush(ix, ny - 1, iz); }
  for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) { tryPush(0, iy, iz); tryPush(nx - 1, iy, iz); }
  while (qh < qt) {
    const ix = qx[qh], iy = qy[qh], iz = qz[qh]; qh++;
    tryPush(ix + 1, iy, iz); tryPush(ix - 1, iy, iz);
    tryPush(ix, iy + 1, iz); tryPush(ix, iy - 1, iz);
    tryPush(ix, iy, iz + 1); tryPush(ix, iy, iz - 1);
  }
  return exterior;
}

function _thickenDilateInto(vox, allowMask, steps) {
  const { grid, nx, ny, nz, idx } = vox;
  let frontier = [];
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) {
    const id = idx(ix, iy, iz);
    if (grid[id] !== 1) continue;
    if (
      (ix + 1 < nx && grid[idx(ix + 1, iy, iz)] === 0 && allowMask[idx(ix + 1, iy, iz)]) ||
      (ix - 1 >= 0 && grid[idx(ix - 1, iy, iz)] === 0 && allowMask[idx(ix - 1, iy, iz)]) ||
      (iy + 1 < ny && grid[idx(ix, iy + 1, iz)] === 0 && allowMask[idx(ix, iy + 1, iz)]) ||
      (iy - 1 >= 0 && grid[idx(ix, iy - 1, iz)] === 0 && allowMask[idx(ix, iy - 1, iz)]) ||
      (iz + 1 < nz && grid[idx(ix, iy, iz + 1)] === 0 && allowMask[idx(ix, iy, iz + 1)]) ||
      (iz - 1 >= 0 && grid[idx(ix, iy, iz - 1)] === 0 && allowMask[idx(ix, iy, iz - 1)])
    ) frontier.push(id);
  }
  for (let s = 0; s < steps && frontier.length; s++) {
    const next = [];
    const seen = new Set();
    for (let fi = 0; fi < frontier.length; fi++) {
      const id = frontier[fi];
      const iz = id % nz;
      const iy = ((id - iz) / nz) % ny;
      const ix = (id - iz - iy * nz) / (nz * ny);
      const nb = [[ix + 1, iy, iz], [ix - 1, iy, iz], [ix, iy + 1, iz], [ix, iy - 1, iz], [ix, iy, iz + 1], [ix, iy, iz - 1]];
      for (let k = 0; k < 6; k++) {
        const nxp = nb[k][0], nyp = nb[k][1], nzp = nb[k][2];
        if (nxp < 0 || nyp < 0 || nzp < 0 || nxp >= nx || nyp >= ny || nzp >= nz) continue;
        const nid = idx(nxp, nyp, nzp);
        if (grid[nid] === 1 || !allowMask[nid] || seen.has(nid)) continue;
        seen.add(nid);
        grid[nid] = 1;
        next.push(nid);
      }
    }
    frontier = next;
  }
}

function _thickenSoupFromVoxels(vox) {
  const { grid, nx, ny, nz, ox, oy, oz, pitch, idx } = vox;
  const out = [];
  function solidAt(ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return 0;
    return grid[idx(ix, iy, iz)];
  }
  function push6(v0, v1, v2, v3) {
    out.push(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    out.push(v0[0], v0[1], v0[2], v2[0], v2[1], v2[2], v3[0], v3[1], v3[2]);
  }
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++) {
    if (!solidAt(ix, iy, iz)) continue;
    const x0 = ox + ix * pitch, x1 = x0 + pitch;
    const y0 = oy + iy * pitch, y1 = y0 + pitch;
    const z0 = oz + iz * pitch, z1 = z0 + pitch;
    if (!solidAt(ix + 1, iy, iz)) push6([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    if (!solidAt(ix - 1, iy, iz)) push6([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]);
    if (!solidAt(ix, iy + 1, iz)) push6([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
    if (!solidAt(ix, iy - 1, iz)) push6([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!solidAt(ix, iy, iz + 1)) push6([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    if (!solidAt(ix, iy, iz - 1)) push6([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  }
  return out.length >= 9 ? new Float32Array(out) : null;
}

// ---- main entry ----

function thickenSelectedModel(mode, offsetMm) {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  if (!(offsetMm > 0)) { setStatus('Thicken failed - enter a positive mm value', true); return; }

  function localSoupFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    const pos = geo.attributes.position;
    const index = geo.index;
    const out = [];
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const vi = index.getX(i);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    } else {
      for (let i = 0; i < pos.count; i++) out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    return out.length >= 9 ? new Float32Array(out) : null;
  }

  const usingRaw = !!(m.rawTris && m.rawAxis === 'zup');
  const soupIn = usingRaw ? m.rawTris : localSoupFromGeometry(m.geometry);
  if (!soupIn || soupIn.length < 9) { setStatus('Thicken failed - piece unchanged', true); return; }

  let openBefore = null, nmBefore = null;
  try { openBefore = openBoundaryEdges(soupIn).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmBefore = countNonManifoldEdges(soupIn); } catch (e) {}

  let closedSoup = soupIn;
  try { closedSoup = weldSoupVerts(closedSoup); } catch (e) {}
  try { if (typeof capSmallOpenLoops === 'function') closedSoup = capSmallOpenLoops(closedSoup, 28); } catch (e) {}

  let openCheck = null;
  try { openCheck = openBoundaryEdges(closedSoup).length; } catch (e) {}
  // Slots (cups, USB) are leftover open loops on purpose. Only refuse
  // a shredded soup (no triangles) — not a bar that still has holes.
  if (!closedSoup || closedSoup.length < 9) {
    setStatus('Thicken ' + mode + ' ' + offsetMm + ' failed - piece unchanged', true);
    return;
  }

  let working = null;
  try {
    const bb = _thickenBBoxOfSoup(closedSoup);
    const pitch = _thickenChoosePitch(bb, offsetMm);
    const vox = _thickenVoxelize(closedSoup, pitch);
    const exterior = _thickenClassifyExterior(vox);
    const steps = Math.max(1, Math.round(offsetMm / pitch));
    if (mode === 'out') {
      _thickenDilateInto(vox, exterior, steps);
    } else {
      const interior = new Uint8Array(exterior.length);
      for (let i = 0; i < interior.length; i++) interior[i] = (vox.grid[i] === 0 && exterior[i] === 0) ? 1 : 0;
      _thickenDilateInto(vox, interior, steps);
    }
    working = _thickenSoupFromVoxels(vox);
    if (working) { try { working = weldSoupVerts(working); } catch (e) {} }
  } catch (e) {
    working = null;
  }

  if (!working || working.length < 9) {
    setStatus('Thicken ' + mode + ' ' + offsetMm + ' failed - piece unchanged', true);
    return;
  }

  pushUndo({
    type: 'thickenReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  let newGeo;
  if (usingRaw) newGeo = rawResultToDisplayGeometry(working);
  else newGeo = soupToCenteredGeo(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  m.geometry = newGeo;
  if (usingRaw) {
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
  }
  m.size = { x: size2.x, y: size2.y, z: size2.z };

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
    settlePlacedOnBed(placedEntry);
  }

  let openAfter = null, nmAfter = null;
  try { openAfter = openBoundaryEdges(working).length; } catch (e) {}
  try { if (typeof countNonManifoldEdges === 'function') nmAfter = countNonManifoldEdges(working); } catch (e) {}
  let msg = 'Thicken ' + mode + ' ' + offsetMm + ' - open ' + (openBefore == null ? '?' : openBefore) + '\u2192' + (openAfter == null ? '?' : openAfter);
  if (nmBefore != null && nmAfter != null) msg += ', NM ' + nmBefore + '\u2192' + nmAfter;
  setStatus(msg);
}

function thickenOutSelectedModel() {
  const inp = document.getElementById('inp-thicken-mm');
  const v = inp ? parseFloat(inp.value) : NaN;
  thickenSelectedModel('out', isFinite(v) && v > 0 ? v : 1.5);
}

function thickenInSelectedModel() {
  const inp = document.getElementById('inp-thicken-mm');
  const v = inp ? parseFloat(inp.value) : NaN;
  thickenSelectedModel('in', isFinite(v) && v > 0 ? v : 1.5);
}

function applySoftenOnFace(face) {
  const m = getActiveModel();
  if (!m) {
    setStatus('Select a piece first', true);
    return;
  }
  if (!m.rawTris || m.rawAxis !== 'zup') {
    setStatus('Soften needs a Square-split or loaded raw piece', true);
    return;
  }
  if (!face || face.axisIdx == null) {
    setStatus('Click the end or face to soften', true);
    return;
  }
  const inpR = document.getElementById('inp-soften-r');
  const Rv = inpR ? parseFloat(inpR.value) : NaN;
  const R = (isFinite(Rv) && Rv > 0) ? Rv : 0.5;
  const keepMinFace = face.sign < 0;
  let working = null;
  try {
    working = softenSelectedFace(m.rawTris, face.axisIdx, keepMinFace, R);
  } catch (e) {
    working = null;
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Soften failed - ' + (e && e.message ? e.message : e), true);
    return;
  }
  if (!working || working.length < 9) {
    if (typeof removeFaceHelper === 'function') removeFaceHelper();
    setStatus('Soften failed - fillet empty. Piece unchanged', true);
    return;
  }
  const sealed = rawCheckWatertightQuick(working);


  // Snapshot for Undo BEFORE mutating the model.
  pushUndo({
    type: 'softenReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  const newGeo = rawResultToDisplayGeometry(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  m.rawTris = working;
  m.rawAxis = 'zup';
  m.centerOffset = computeCenterOffsetFromRaw(working);
  m.size = { x: size2.x, y: size2.y, z: size2.z };

  // Keep plate X/Z: if this model is currently placed, rebuild its mesh
  // in place at the same position rather than moving it.
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
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateUndoBtn();
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  setStatus(sealed ? 'Soften ok' : 'Soften ok - not fully sealed, check slice');
}


// ===== Cap: raw engine — flat lid via existing clip+cap (rawCut), R=0 =====
// Same extreme-finding + EPS nudge as softenSelectedFace, same keepMin
// convention (direct passthrough — confirmed there against
// rawClipTrianglesAtPlane, not re-derived here). Just skips the fillet band:
// rawCut already does clip -> loop -> rawFlatCapLoop, which is exactly a
// legal flat raw lid, fillet-ready input for softenSelectedFace later.
function capSelectedFace(rawTris, axisIdx, keepMinFace) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < rawTris.length; i += 3) {
    if (rawTris[i] < minV) minV = rawTris[i];
    if (rawTris[i] > maxV) maxV = rawTris[i];
  }
  const EPS = 0.02;
  const plane = keepMinFace ? minV + EPS : maxV - EPS;
  const keepMin = keepMinFace;
  return rawCut(rawTris, axisIdx, plane, keepMin);
}

function applyCapOnFace(face) {
  const m = getActiveModel();
  if (!m) {
    setStatus('Select a piece first', true);
    return;
  }
  if (!m.rawTris || m.rawAxis !== 'zup') {
    setStatus('Cap needs a Square-split or loaded raw piece', true);
    return;
  }
  if (!face || face.axisIdx == null) {
    setStatus('Click the face to cap', true);
    return;
  }
  const keepMinFace = face.sign < 0;
  let working = null;
  try {
    working = capSelectedFace(m.rawTris, face.axisIdx, keepMinFace);
  } catch (e) {
    working = null;
  }
  if (!working || !rawCheckWatertightQuick(working)) {
    setStatus('Cap failed - piece unchanged', true);
    return;
  }

  // Same Undo shape as Soften's softenReplace, new type for clarity.
  pushUndo({
    type: 'capReplace',
    modelId: m.id,
    prevGeometry: m.geometry.clone(),
    prevRawTris: m.rawTris,
    prevRawAxis: m.rawAxis,
    prevCenterOffset: m.centerOffset,
    prevSize: { x: m.size.x, y: m.size.y, z: m.size.z }
  });

  const newGeo = rawResultToDisplayGeometry(working);
  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  m.rawTris = working;
  m.rawAxis = 'zup';
  m.centerOffset = computeCenterOffsetFromRaw(working);
  m.size = { x: size2.x, y: size2.y, z: size2.z };

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
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateUndoBtn();
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  setStatus('Cap ok');
}

function capSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  if (state.capArmed) {
    state.capArmed = false;
    removeFaceHelper();
    setStatus('Cap cancelled');
    return;
  }
  state.capArmed = true;
  setStatus('Cap: click the face to close');
}
function softenSelectedModel() {
  const m = getActiveModel();
  if (!m) { setStatus('Select a piece first', true); return; }
  if (state.softenArmed) {
    state.softenArmed = false;
    removeFaceHelper();
    setStatus('Soften cancelled');
    return;
  }
  state.softenArmed = true;
  setStatus('Soften: click the end or face to round');
}

function capSelectedOpenFaces() {
  const m = getActiveModel();
  if (!m || !m.geometry) {
    setStatus('Select a piece to cap', true);
    return;
  }
  const placed = state.placed.find(function (p) { return p && p.sourceId === m.id; });
  const prevGeo = m.geometry.clone();
  const prevRaw = m.rawTris;
  const prevAxis = m.rawAxis;
  const prevOff = m.centerOffset;
  const prevSize = { x: m.size.x, y: m.size.y, z: m.size.z };
  let capped;
  try {
    capped = capOpenFacesOnGeometry(m.geometry);
  } catch (err) {
    setStatus('Cap failed - ' + (err && err.message ? err.message : 'unchanged'), true);
    return;
  }
  if (!capped) {
    setStatus('No open face to cap');
    return;
  }
  pushUndo({
    type: 'softenReplace',
    id: m.id,
    prevGeometry: prevGeo,
    prevRawTris: prevRaw,
    prevRawAxis: prevAxis,
    prevCenterOffset: prevOff,
    prevSize: prevSize
  });
  capped.computeBoundingBox();
  const size2 = new THREE.Vector3();
  capped.boundingBox.getSize(size2);
  m.geometry = capped;
  m.rawTris = displayGeometryToRawSoup(capped);
  m.rawAxis = 'zup';
  m.centerOffset = computeCenterOffsetFromRaw(m.rawTris);
  m.size = { x: size2.x, y: size2.y, z: size2.z };
  if (placed && placed.mesh && state.modelGroup) {
    const px = placed.x, pz = placed.z;
    state.modelGroup.remove(placed.mesh);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placed);
    state.modelGroup.add(mesh);
    placed.mesh = mesh;
    placed.geometry = m.geometry;
    placed.width = m.size.x;
    placed.depth = m.size.z;
    placed.height = m.size.y;
  }
  updateEditSize();
  renderModelList();
  updateUndoBtn();
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  setStatus('Cap ok');
}

// ===================== Join Selected (post-cut Edit action) =====================
// Not general boolean CSG — a scoped, tractable union for the actual use
// case (chopped ends stored and rejoined onto bars): detect the flat
// interface where two pieces touch, remove both matching caps (they
// become internal surfaces after union), translate to close any kerf gap,
// merge the remaining shells. Verified directly against real split
// geometry, including a simulated kerf gap. Never runs during Split;
// never touches any piece other than the two explicitly selected.

function rawJoinBboxOf(tris, axisIdx) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = axisIdx; i < tris.length; i += 3) {
    if (tris[i] < minV) minV = tris[i];
    if (tris[i] > maxV) maxV = tris[i];
  }
  return { minV, maxV };
}

function rawJoinTranslateAxis(tris, axisIdx, delta) {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i++) out[i] = tris[i];
  for (let i = axisIdx; i < out.length; i += 3) out[i] += delta;
  return out;
}

function soupWorldWin(soup) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, minZ: minZ, maxZ: maxZ };
}

function rawJoinStripCapAtPlane(tris, axisIdx, planeVal, tol, win) {
  tol = (tol == null) ? 0.45 : tol;
  const out = [];
  const triCount = tris.length / 9;
  let stripped = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const c0 = tris[i0+axisIdx], c1 = tris[i0+3+axisIdx], c2 = tris[i0+6+axisIdx];
    const onPlane = Math.abs(c0-planeVal)<tol && Math.abs(c1-planeVal)<tol && Math.abs(c2-planeVal)<tol;
    if (onPlane) {
      if (win) {
        const cx = (tris[i0] + tris[i0 + 3] + tris[i0 + 6]) / 3;
        const cy = (tris[i0 + 1] + tris[i0 + 4] + tris[i0 + 7]) / 3;
        const cz = (tris[i0 + 2] + tris[i0 + 5] + tris[i0 + 8]) / 3;
        const pad = 1.2;
        const inWin =
          (axisIdx === 0 || (cx >= win.minX - pad && cx <= win.maxX + pad)) &&
          (axisIdx === 1 || (cy >= win.minY - pad && cy <= win.maxY + pad)) &&
          (axisIdx === 2 || (cz >= win.minZ - pad && cz <= win.maxZ + pad));
        if (!inWin) {
          for (let k = 0; k < 9; k++) out.push(tris[i0 + k]);
          continue;
        }
      }
      stripped++;
      continue;
    }
    for (let k = 0; k < 9; k++) out.push(tris[i0+k]);
  }
  return { tris: new Float32Array(out), stripped };
}

// rawJoinPieces(rawMin, rawMax, axisIdx) — rawMin is the piece on the
// lower side, rawMax on the upper side; their facing boundaries are
// brought together and merged. Throws on any failure — caller must keep
// both pieces unchanged in that case.
function rawJoinPieces(rawMin, rawMax, axisIdx) {
  const bbMin = rawJoinBboxOf(rawMin, axisIdx);
  const bbMax = rawJoinBboxOf(rawMax, axisIdx);
  const joinPlane = bbMin.maxV;
  const delta = joinPlane - bbMax.minV;
  const maxMoved = rawJoinTranslateAxis(rawMax, axisIdx, delta);

  let sMin = 0, sMax = 0, minStripped, maxStripped;
  const tols = [0.45, 0.9, 1.2, 2.0];
  for (let i = 0; i < tols.length; i++) {
    const a = rawJoinStripCapAtPlane(rawMin, axisIdx, joinPlane, tols[i]);
    const b = rawJoinStripCapAtPlane(maxMoved, axisIdx, joinPlane, tols[i]);
    minStripped = a.tris; maxStripped = b.tris; sMin = a.stripped; sMax = b.stripped;
    if (sMin > 0 && sMax > 0) break;
  }
  if (sMin === 0 || sMax === 0) {
    throw new Error('no flat mate face (stripped ' + sMin + '+' + sMax + ')');
  }

  const merged = new Float32Array(minStripped.length + maxStripped.length);
  merged.set(minStripped, 0);
  merged.set(maxStripped, minStripped.length);

  if (!rawCheckWatertightQuick(merged)) {
    console.warn('[join] merged not watertight; keeping cap-stripped union');
  }
  return merged;
}

function meshLocalBox3(mesh) {
  if (!mesh || !mesh.geometry) return new THREE.Box3();
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  mesh.updateMatrixWorld(true);
  return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
}

function geomToWorldSoup(geometry, px, py, pz) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i) + px;
    out[i * 3 + 1] = pos.getY(i) + py;
    out[i * 3 + 2] = pos.getZ(i) + pz;
  }
  return out;
}

function soupToCenteredGeo(soup) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
  if (THREE.BufferGeometryUtils && typeof THREE.BufferGeometryUtils.mergeVertices === 'function') {
    const merged = THREE.BufferGeometryUtils.mergeVertices(geo, 0.3);
    merged.computeVertexNormals();
    merged.center();
    merged.computeBoundingBox();
    return merged;
  }
  geo.computeVertexNormals();
  geo.center();
  geo.computeBoundingBox();
  return geo;
}

function stripFacingInBand(soup, axisIdx, plane, band, win) {
  const out = [];
  const triCount = soup.length / 9;
  let stripped = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
    const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
    const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
    const avg = ((ax + bx + cx) / 3 * (axisIdx === 0 ? 1 : 0)) +
      ((ay + by + cy) / 3 * (axisIdx === 1 ? 1 : 0)) +
      ((az + bz + cz) / 3 * (axisIdx === 2 ? 1 : 0));
    const coord = axisIdx === 0 ? (ax + bx + cx) / 3 : axisIdx === 1 ? (ay + by + cy) / 3 : (az + bz + cz) / 3;
    if (Math.abs(coord - plane) <= band) {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const nAxis = axisIdx === 0 ? nx : axisIdx === 1 ? ny : nz;
      if (Math.abs(nAxis / len) >= 0.72) {
        if (win) {
          const tcx = (ax + bx + cx) / 3;
          const tcy = (ay + by + cy) / 3;
          const tcz = (az + bz + cz) / 3;
          const pad = 1.2;
          const inWin =
            (axisIdx === 0 || (tcx >= win.minX - pad && tcx <= win.maxX + pad)) &&
            (axisIdx === 1 || (tcy >= win.minY - pad && tcy <= win.maxY + pad)) &&
            (axisIdx === 2 || (tcz >= win.minZ - pad && tcz <= win.maxZ + pad));
          if (!inWin) {
            for (let k = 0; k < 9; k++) out.push(soup[i0 + k]);
            continue;
          }
        }
        stripped++;
        continue;
      }
    }
    for (let k = 0; k < 9; k++) out.push(soup[i0 + k]);
  }
  return { tris: new Float32Array(out), stripped };
}

function weldSoupVerts(soup, eps) {
  eps = eps || 0.2;
  const inv = 1 / eps;
  const map = new Map();
  const verts = [];
  function key(x, y, z) {
    return (Math.round(x * inv)) + ',' + (Math.round(y * inv)) + ',' + (Math.round(z * inv));
  }
  function vid(x, y, z) {
    const k = key(x, y, z);
    if (map.has(k)) return map.get(k);
    const id = verts.length / 3;
    verts.push(x, y, z);
    map.set(k, id);
    return id;
  }
  const out = [];
  const triCount = soup.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9;
    const a = vid(soup[i0], soup[i0 + 1], soup[i0 + 2]);
    const b = vid(soup[i0 + 3], soup[i0 + 4], soup[i0 + 5]);
    const c = vid(soup[i0 + 6], soup[i0 + 7], soup[i0 + 8]);
    if (a === b || b === c || c === a) continue;
    out.push(verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2]);
    out.push(verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]);
    out.push(verts[c * 3], verts[c * 3 + 1], verts[c * 3 + 2]);
  }
  return new Float32Array(out);
}

function openBoundaryEdges(soup) {
  const edges = new Map();
  function key(ax, ay, az, bx, by, bz) {
    const a = ax.toFixed(3) + ',' + ay.toFixed(3) + ',' + az.toFixed(3);
    const b = bx.toFixed(3) + ',' + by.toFixed(3) + ',' + bz.toFixed(3);
    return a < b ? a + '~' + b : b + '~' + a;
  }
  const n = soup.length / 9;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const pts = [
      [soup[i], soup[i + 1], soup[i + 2]],
      [soup[i + 3], soup[i + 4], soup[i + 5]],
      [soup[i + 6], soup[i + 7], soup[i + 8]]
    ];
    for (let e = 0; e < 3; e++) {
      const p = pts[e], q = pts[(e + 1) % 3];
      const k = key(p[0], p[1], p[2], q[0], q[1], q[2]);
      if (!edges.has(k)) edges.set(k, { count: 0, a: p, b: q });
      edges.get(k).count++;
    }
  }
  const out = [];
  edges.forEach(function (val) {
    if (val.count === 1) out.push([val.a, val.b]);
  });
  return out;
}

function capSoupNearPlane(soup, axisIdx, plane, band) {
  band = band == null ? 0.8 : band;
  const axis = axisIdx === 0 ? 'x' : axisIdx === 1 ? 'y' : 'z';
  const raw = openBoundaryEdges(soup);
  const near = raw.filter(function (pair) {
    const ca = pair[0][axisIdx], cb = pair[1][axisIdx];
    return Math.abs(ca - plane) <= band && Math.abs(cb - plane) <= band;
  });
  if (near.length < 3) return soup;
  const cap = capFromEdges(near, axis, plane, true);
  if (!cap || cap.length < 9) return soup;
  const out = new Float32Array(soup.length + cap.length);
  out.set(soup, 0);
  out.set(Float32Array.from(cap), soup.length);
  return out;
}

function capOpenFacesOnGeometry(geometry) {
  const soup = geomToWorldSoup(geometry, 0, 0, 0);
  const edges = openBoundaryEdges(soup);
  if (edges.length < 3) return null;
  let sx = 0, sz = 0, cx = 0, cz = 0, n = 0;
  edges.forEach(function (pair) {
    sx += Math.abs(pair[0][0] - pair[1][0]);
    sz += Math.abs(pair[0][2] - pair[1][2]);
    cx += pair[0][0] + pair[1][0];
    cz += pair[0][2] + pair[1][2];
    n += 2;
  });
  const axis = sx < sz ? 'x' : 'z';
  const axisIdx = axis === 'x' ? 0 : 2;
  const plane = n ? ((axis === 'x' ? cx : cz) / n) : 0;
  const capped = capSoupNearPlane(soup, axisIdx, plane, 1.2);
  if (capped.length <= soup.length) return null;
  return soupToCenteredGeo(capped);
}

function unionKissedSoups(soupA, soupB) {
  function bboxOf(s) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ };
  }
  function inflate(bb, pad) {
    return {
      minX: bb.minX - pad, minY: bb.minY - pad, minZ: bb.minZ - pad,
      maxX: bb.maxX + pad, maxY: bb.maxY + pad, maxZ: bb.maxZ + pad
    };
  }
  function inBox(bb, x, y, z) {
    return x >= bb.minX && x <= bb.maxX && y >= bb.minY && y <= bb.maxY && z >= bb.minZ && z <= bb.maxZ;
  }

  const DX = 0.5257311, DY = 0.6881910, DZ = 0.4998877;

  function rayHitsTriangle(ox, oy, oz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const hx = DY * e2z - DZ * e2y;
    const hy = DZ * e2x - DX * e2z;
    const hz = DX * e2y - DY * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det > -1e-9 && det < 1e-9) return false;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = inv * (sx * hx + sy * hy + sz * hz);
    if (u < -1e-9 || u > 1 + 1e-9) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = inv * (DX * qx + DY * qy + DZ * qz);
    if (v < -1e-9 || u + v > 1 + 1e-9) return false;
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    return t > 1e-6;
  }

  function isInsideSolid(soup, bbInflated, px, py, pz) {
    if (!inBox(bbInflated, px, py, pz)) return false;
    let hits = 0;
    const n = soup.length / 9;
    for (let t = 0; t < n; t++) {
      const i0 = t * 9;
      if (rayHitsTriangle(px, py, pz,
        soup[i0], soup[i0 + 1], soup[i0 + 2],
        soup[i0 + 3], soup[i0 + 4], soup[i0 + 5],
        soup[i0 + 6], soup[i0 + 7], soup[i0 + 8])) hits++;
    }
    return (hits % 2) === 1;
  }

  function clipAgainst(source, other) {
    const bb = inflate(bboxOf(other), 0.5);
    const out = [];
    const n = source.length / 9;
    for (let t = 0; t < n; t++) {
      const i0 = t * 9;
      const cx = (source[i0] + source[i0 + 3] + source[i0 + 6]) / 3;
      const cy = (source[i0 + 1] + source[i0 + 4] + source[i0 + 7]) / 3;
      const cz = (source[i0 + 2] + source[i0 + 5] + source[i0 + 8]) / 3;
      if (isInsideSolid(other, bb, cx, cy, cz)) continue;
      for (let k = 0; k < 9; k++) out.push(source[i0 + k]);
    }
    return out;
  }

  if (!soupA || soupA.length < 9) return soupB && soupB.length >= 9 ? new Float32Array(soupB) : new Float32Array(0);
  if (!soupB || soupB.length < 9) return new Float32Array(soupA);

  const keptA = clipAgainst(soupA, soupB);
  const keptB = clipAgainst(soupB, soupA);
  if (!keptA.length && !keptB.length) return new Float32Array(0);

  const merged = new Float32Array(keptA.length + keptB.length);
  merged.set(keptA, 0);
  merged.set(keptB, keptA.length);
  return weldSoupVerts(merged, 0.3);
}

/** Plate-space weld along X (0) or Z (2). */
function joinHalvesOnPlate(modelA, placedA, modelB, placedB, axisIdx) {
  axisIdx = (axisIdx === 2) ? 2 : 0;
  matchPlacedBottoms(placedA, placedB);
  const pyA = placedA.mesh ? placedA.mesh.position.y : (modelA.size.y / 2 + 0.3);
  const pyB = placedB.mesh ? placedB.mesh.position.y : (modelB.size.y / 2 + 0.3);
  const soupA = geomToWorldSoup(modelA.geometry, placedA.x, pyA, placedA.z);
  const soupB = geomToWorldSoup(modelB.geometry, placedB.x, pyB, placedB.z);
  const key = axisIdx === 0 ? 'x' : 'z';
  const aIsMin = placedA[key] <= placedB[key];
  const left = aIsMin ? soupA : soupB;
  const right = aIsMin ? soupB : soupA;
  const bbL = rawJoinBboxOf(left, axisIdx);
  const bbR = rawJoinBboxOf(right, axisIdx);
  const planeL = bbL.maxV;
  const planeR = bbR.minV;
  const winR = soupWorldWin(right);
  const winL = soupWorldWin(left);
  const t0 = axisIdx === 0 ? 2 : 0;
  const spanL = (t0 === 0 ? (winL.maxX - winL.minX) : (winL.maxZ - winL.minZ)) || 1;
  const spanR = (t0 === 0 ? (winR.maxX - winR.minX) : (winR.maxZ - winR.minZ)) || 1;
  const ov0 = Math.min(t0 === 0 ? winL.maxX : winL.maxZ, t0 === 0 ? winR.maxX : winR.maxZ);
  const ov1 = Math.max(t0 === 0 ? winL.minX : winL.minZ, t0 === 0 ? winR.minX : winR.minZ);
  const overlapT = Math.max(0, ov0 - ov1);
  const isLJoin = overlapT < Math.max(spanL, spanR) * 0.8;
  let leftKept = left;
  let rightKept = right;
  if (!isLJoin) {
    const extraL = rawJoinStripCapAtPlane(left, axisIdx, planeL, 0.55, winR);
    const extraR = rawJoinStripCapAtPlane(right, axisIdx, planeR, 0.55, winL);
    leftKept = extraL.tris;
    rightKept = extraR.tris;
    if (extraL.stripped === 0) {
      const band = stripFacingInBand(left, axisIdx, planeL, 0.35, winR);
      if (band.stripped > 0) leftKept = band.tris;
    }
    if (extraR.stripped === 0) {
      const band = stripFacingInBand(right, axisIdx, planeR, 0.35, winL);
      if (band.stripped > 0) rightKept = band.tris;
    }
  }
  if (leftKept.length < 9 || rightKept.length < 9) {
    throw new Error('join stripped a half empty');
  }
  const closed = isLJoin
    ? rightKept
    : rawJoinTranslateAxis(rightKept, axisIdx, planeL - planeR);

  function bboxVolumeOf(s) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ);
  }

  const kissed = new Float32Array(leftKept.length + closed.length);
  kissed.set(leftKept, 0);
  kissed.set(closed, leftKept.length);
  const volKissed = bboxVolumeOf(kissed);

  // The old fail-safe path, kept byte-for-byte in spirit: concatenate,
  // weld, flat-cap the seam and the outer walls, weld again. This is the
  // fallback whenever the real union can't be trusted.
  function fallbackConcatWeldRepair() {
    let m = weldSoupVerts(kissed, 0.18);
    if (!isLJoin) {
      m = capSoupNearPlane(m, axisIdx, planeL, 0.8);
      m = flattenOuterWalls(m, 0.28, ['x', 'z']);
      m = capAllOuterHoles(m);
    }
    m = weldSoupVerts(m, 0.35);
    return m;
  }

  let merged;
  if (isLJoin) {
    merged = fallbackConcatWeldRepair();
  } else {
    try {
      const unioned = unionKissedSoups(leftKept, closed);
      const volUnion = (unioned && unioned.length >= 9) ? bboxVolumeOf(unioned) : 0;
      const shrunkTooMuch = volKissed > 0 && volUnion < volKissed * 0.85;
      if (unioned && unioned.length >= 9 && !shrunkTooMuch) {
        merged = flattenOuterWalls(unioned, 0.28, ['x', 'z']);
      } else {
        merged = fallbackConcatWeldRepair();
      }
    } catch (err) {
      merged = fallbackConcatWeldRepair();
    }
  }
  if (merged.length < 9) throw new Error('join weld empty');
  if (!isLJoin) {
    merged = repairJoinedSoup(merged);
    if (merged.length < 9) throw new Error('join weld empty');
  }
  return soupToCenteredGeo(merged);
}

function repairJoinedSoup(soup) {
  try {
    if (!soup || soup.length < 9) return soup;
    const original = soup;

    function bboxOf(s) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < s.length; i += 3) {
        const x = s[i], y = s[i + 1], z = s[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return { minX: minX, minY: minY, minZ: minZ, maxX: maxX, maxY: maxY, maxZ: maxZ };
    }
    function bboxVolume(bb) {
      return Math.max(0, bb.maxX - bb.minX) *
        Math.max(0, bb.maxY - bb.minY) *
        Math.max(0, bb.maxZ - bb.minZ);
    }

    const volBefore = bboxVolume(bboxOf(soup));

    // 1) Drop degenerate triangles (area < 1e-6) and exact/near-exact duplicate faces.
    function pk(x, y, z) {
      return Math.round(x * 1000) + ':' + Math.round(y * 1000) + ':' + Math.round(z * 1000);
    }
    const seenTri = new Set();
    const work = [];
    const triCount0 = soup.length / 9;
    for (let t = 0; t < triCount0; t++) {
      const i0 = t * 9;
      const ax = soup[i0], ay = soup[i0 + 1], az = soup[i0 + 2];
      const bx = soup[i0 + 3], by = soup[i0 + 4], bz = soup[i0 + 5];
      const cx = soup[i0 + 6], cy = soup[i0 + 7], cz = soup[i0 + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(area > 1e-6)) continue;

      const keys = [pk(ax, ay, az), pk(bx, by, bz), pk(cx, cy, cz)].sort();
      const triKey = keys.join('|');
      if (seenTri.has(triKey)) continue;
      seenTri.add(triKey);

      work.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    if (!work.length) return original;

    // 2) Weld vertices (reuse existing welder; also re-drops any triangles
    //    that collapse to zero area once shared verts snap together).
    let soupW = weldSoupVerts(new Float32Array(work), 0.3);
    if (soupW.length < 9) return original;

    // 3) Cap any remaining planar open loops with the existing capper
    //    (no new ear-clipper). Only run it while real boundary edges remain,
    //    up to 3 passes — one pass can leave a residual sliver on complex,
    //    multi-loop boundaries, and re-running on an already-watertight
    //    region just risks a fresh seam from weld-tolerance rounding.
    let soupC = soupW;
    for (let pass = 0; pass < 3; pass++) {
      if (!(typeof openBoundaryEdges === 'function' && openBoundaryEdges(soupC).length > 0)) break;
      const capped = capAllOuterHoles(soupC);
      const reWelded = weldSoupVerts(capped, 0.3);
      if (reWelded.length < 9) break;
      if (reWelded.length === soupC.length) { soupC = reWelded; break; }
      soupC = reWelded;
    }

    if (typeof capSmallOpenLoops === 'function') {
      soupC = capSmallOpenLoops(soupC, 3);
    }

    // 4) Drop small disjoint shells (<20 tris or <2% of total volume);
    //    always keep the largest shell.
    function keyv(x, y, z) {
      return Math.round(x * 2000) + ':' + Math.round(y * 2000) + ':' + Math.round(z * 2000);
    }
    const triCount2 = soupC.length / 9;
    const vidMap = new Map();
    const vpos = [];
    function vid(x, y, z) {
      const k = keyv(x, y, z);
      let id = vidMap.get(k);
      if (id === undefined) {
        id = vpos.length / 3;
        vpos.push(x, y, z);
        vidMap.set(k, id);
      }
      return id;
    }
    const triA = new Int32Array(triCount2);
    const triB = new Int32Array(triCount2);
    const triCc = new Int32Array(triCount2);
    for (let t = 0; t < triCount2; t++) {
      const i0 = t * 9;
      triA[t] = vid(soupC[i0], soupC[i0 + 1], soupC[i0 + 2]);
      triB[t] = vid(soupC[i0 + 3], soupC[i0 + 4], soupC[i0 + 5]);
      triCc[t] = vid(soupC[i0 + 6], soupC[i0 + 7], soupC[i0 + 8]);
    }
    const parent = new Array(triCount2);
    for (let t = 0; t < triCount2; t++) parent[t] = t;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    const edgeMap = new Map();
    function ek(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    for (let t = 0; t < triCount2; t++) {
      const a = triA[t], b = triB[t], c = triCc[t];
      const es = [ek(a, b), ek(b, c), ek(c, a)];
      for (let e = 0; e < 3; e++) {
        const k = es[e];
        if (!edgeMap.has(k)) edgeMap.set(k, []);
        edgeMap.get(k).push(t);
      }
    }
    edgeMap.forEach(function (list) {
      for (let i = 1; i < list.length; i++) union(list[0], list[i]);
    });

    const compTris = new Map();
    for (let t = 0; t < triCount2; t++) {
      const r = find(t);
      if (!compTris.has(r)) compTris.set(r, []);
      compTris.get(r).push(t);
    }

    if (compTris.size > 1) {
      let totalVol = 0;
      const compInfo = [];
      compTris.forEach(function (tris) {
        let vol = 0;
        for (let k = 0; k < tris.length; k++) {
          const i0 = tris[k] * 9;
          const ax = soupC[i0], ay = soupC[i0 + 1], az = soupC[i0 + 2];
          const bx = soupC[i0 + 3], by = soupC[i0 + 4], bz = soupC[i0 + 5];
          const cx = soupC[i0 + 6], cy = soupC[i0 + 7], cz = soupC[i0 + 8];
          vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
        }
        vol = Math.abs(vol);
        totalVol += vol;
        compInfo.push({ tris: tris, vol: vol });
      });

      compInfo.sort(function (a, b) {
        if (Math.abs(a.vol - b.vol) > 1e-9) return b.vol - a.vol;
        return b.tris.length - a.tris.length;
      });

      const keepTriIdx = new Set();
      for (let i = 0; i < compInfo.length; i++) {
        const c = compInfo[i];
        const share = totalVol > 0 ? c.vol / totalVol : 0;
        const keep = (i === 0) || (c.tris.length >= 20 && share >= 0.02);
        if (keep) for (let k = 0; k < c.tris.length; k++) keepTriIdx.add(c.tris[k]);
      }

      const filtered = [];
      for (let t = 0; t < triCount2; t++) {
        if (!keepTriIdx.has(t)) continue;
        const i0 = t * 9;
        for (let k = 0; k < 9; k++) filtered.push(soupC[i0 + k]);
      }
      if (filtered.length >= 9) soupC = new Float32Array(filtered);
    }

    // 5) Do not flip-by-bbox-center. Slot interiors sit closer to the
    //    center than the outer wall, so that pass inverted hundreds of
    //    good faces (Formware 207 → 1088). Leave winding as-is.

    // 6) Safety net: never emit an empty mesh or a heavily shrunk bbox.
    if (!soupC || soupC.length < 9) return original;
    const volAfter = bboxVolume(bboxOf(soupC));
    if (volBefore > 0 && volAfter < volBefore * 0.85) return original;

    return soupC;
  } catch (err) {
    return soup;
  }
}

function flattenOuterWalls(soup, tol, axes) {
  if (!soup || soup.length < 9) return soup;
  const doX = !axes || axes.indexOf('x') !== -1;
  const doY = !axes || axes.indexOf('y') !== -1;
  const doZ = !axes || axes.indexOf('z') !== -1;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const out = new Float32Array(soup);
  for (let i = 0; i < out.length; i += 3) {
    if (doX) {
      if (Math.abs(out[i] - minX) <= tol) out[i] = minX;
      else if (Math.abs(out[i] - maxX) <= tol) out[i] = maxX;
    }
    if (doY) {
      if (Math.abs(out[i + 1] - minY) <= tol) out[i + 1] = minY;
      else if (Math.abs(out[i + 1] - maxY) <= tol) out[i + 1] = maxY;
    }
    if (doZ) {
      if (Math.abs(out[i + 2] - minZ) <= tol) out[i + 2] = minZ;
      else if (Math.abs(out[i + 2] - maxZ) <= tol) out[i + 2] = maxZ;
    }
  }
  return out;
}

function capSmallOpenLoops(soup, maxSpanMm) {
  maxSpanMm = (maxSpanMm == null) ? 3 : maxSpanMm;
  try {
    if (!soup || soup.length < 9) return soup;
    if (typeof openBoundaryEdges !== 'function' || typeof capFromEdges !== 'function') return soup;

    const rawEdges = openBoundaryEdges(soup);
    if (!rawEdges || rawEdges.length < 3) return soup;

    let meshMinX = Infinity, meshMinY = Infinity, meshMinZ = Infinity;
    let meshMaxX = -Infinity, meshMaxY = -Infinity, meshMaxZ = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      const x = soup[i], y = soup[i + 1], z = soup[i + 2];
      if (x < meshMinX) meshMinX = x; if (x > meshMaxX) meshMaxX = x;
      if (y < meshMinY) meshMinY = y; if (y > meshMaxY) meshMaxY = y;
      if (z < meshMinZ) meshMinZ = z; if (z > meshMaxZ) meshMaxZ = z;
    }
    function bboxVolume(minX, minY, minZ, maxX, maxY, maxZ) {
      return Math.max(0, maxX - minX) * Math.max(0, maxY - minY) * Math.max(0, maxZ - minZ);
    }
    const volBefore = bboxVolume(meshMinX, meshMinY, meshMinZ, meshMaxX, meshMaxY, meshMaxZ);

    // Build the boundary graph the same way capFromEdges does internally,
    // so we can find which open loops are small, clean (simple) cycles --
    // never touching a branch point (degree != 2) and never touching a
    // loop whose span says it's a real opening, not a defect.
    const TOL = 1e-4;
    function keyOf(p) {
      return (Math.round(p[0] / TOL) * TOL) + '|' + (Math.round(p[1] / TOL) * TOL) + '|' + (Math.round(p[2] / TOL) * TOL);
    }
    function proj2(ax, p) {
      if (ax === 'x') return [p[1], p[2]];
      if (ax === 'y') return [p[0], p[2]];
      return [p[0], p[1]];
    }
    const nodePos = new Map();
    const adj = new Map();
    function addNode(p) {
      const k = keyOf(p);
      if (!nodePos.has(k)) nodePos.set(k, p);
      if (!adj.has(k)) adj.set(k, new Set());
      return k;
    }
    rawEdges.forEach(function (pair) {
      const k0 = addNode(pair[0]);
      const k1 = addNode(pair[1]);
      if (k0 === k1) return;
      adj.get(k0).add(k1);
      adj.get(k1).add(k0);
    });

    const visited = new Set();
    const extraPatches = [];

    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      if (adj.get(start).size !== 2) { visited.add(start); continue; }

      const loopKeys = [start];
      let prev = start;
      let cur = Array.from(adj.get(start))[0];
      let clean = true;
      let guard = 0;
      while (cur !== start && guard++ < 5000) {
        if (!adj.has(cur) || adj.get(cur).size !== 2) { clean = false; break; }
        loopKeys.push(cur);
        const nbs = Array.from(adj.get(cur));
        const next = (nbs[0] === prev) ? nbs[1] : nbs[0];
        prev = cur;
        cur = next;
      }
      loopKeys.forEach(function (k) { visited.add(k); });
      visited.add(start);
      if (!clean || cur !== start || loopKeys.length < 3) continue;

      const pts = loopKeys.map(function (k) { return nodePos.get(k); });
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      pts.forEach(function (p) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
      });
      const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;
      const span = Math.sqrt(spanX * spanX + spanY * spanY + spanZ * spanZ);

      // Cap with whichever axis this specific loop is flattest along (a
      // deck pinhole is flat in Y; a seam sliver off the side walls is
      // flat in X or Z) -- reuses capFromEdges, no new triangulator.
      let axis = 'x', planeVal = (minX + maxX) / 2, flatSpan = spanX;
      if (spanY < flatSpan) { axis = 'y'; planeVal = (minY + maxY) / 2; flatSpan = spanY; }
      if (spanZ < flatSpan) { axis = 'z'; planeVal = (minZ + maxZ) / 2; flatSpan = spanZ; }

      let shouldCap;
      if (span <= maxSpanMm) {
        // Small enough to be a pinhole / seam-tessellation sliver -- always cap.
        shouldCap = true;
      } else {
        // Large loop. This is where "missing wall" vs "real slot" gets
        // decided -- by SHAPE, not size. Isoperimetric quotient
        // Q = 4*pi*Area / Perimeter^2 is 1.0 for a perfect circle and
        // drops well below ~0.7 for anything rectangular or irregular.
        // A genuine circular/oval slot the user cut on purpose stays
        // open no matter how big; a missing wall's rectangle-ish
        // outline gets filled. Axis/face is never part of the test, so
        // a slot sitting on the same face as a missing wall is never
        // mistaken for one.
        const pts2 = pts.map(function (p) { return proj2(axis, p); });
        let area2 = 0, perim = 0;
        for (let i = 0; i < pts2.length; i++) {
          const a = pts2[i], b = pts2[(i + 1) % pts2.length];
          area2 += a[0] * b[1] - b[0] * a[1];
          perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const area = Math.abs(area2) / 2;
        const Q = perim > 1e-6 ? (4 * Math.PI * area) / (perim * perim) : 0;
        const CIRCULARITY_MIN = 0.72;
        shouldCap = Q < CIRCULARITY_MIN;
      }
      if (!shouldCap) continue;

      const meshMin = axis === 'x' ? meshMinX : axis === 'y' ? meshMinY : meshMinZ;
      const meshMax = axis === 'x' ? meshMaxX : axis === 'y' ? meshMaxY : meshMaxZ;
      const keepMin = Math.abs(planeVal - meshMax) < Math.abs(planeVal - meshMin);

      const edgePairs = [];
      for (let i = 0; i < pts.length; i++) {
        edgePairs.push([pts[i], pts[(i + 1) % pts.length]]);
      }
      const cap = capFromEdges(edgePairs, axis, planeVal, keepMin);
      if (cap && cap.length >= 9) {
        for (let i = 0; i < cap.length; i++) extraPatches.push(cap[i]);
      }
    }

    if (!extraPatches.length) return soup;

    const out = new Float32Array(soup.length + extraPatches.length);
    out.set(soup, 0);
    out.set(Float32Array.from(extraPatches), soup.length);

    let outMinX = Infinity, outMinY = Infinity, outMinZ = Infinity;
    let outMaxX = -Infinity, outMaxY = -Infinity, outMaxZ = -Infinity;
    for (let i = 0; i < out.length; i += 3) {
      const x = out[i], y = out[i + 1], z = out[i + 2];
      if (x < outMinX) outMinX = x; if (x > outMaxX) outMaxX = x;
      if (y < outMinY) outMinY = y; if (y > outMaxY) outMaxY = y;
      if (z < outMinZ) outMinZ = z; if (z > outMaxZ) outMaxZ = z;
    }
    const volAfter = bboxVolume(outMinX, outMinY, outMinZ, outMaxX, outMaxY, outMaxZ);
    if (volBefore > 0 && volAfter < volBefore * 0.85) return soup;

    return out;
  } catch (err) {
    return soup;
  }
}

function capAllOuterHoles(soup) {
  if (!soup || soup.length < 9) return soup;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  let out = soup;
  const faces = [
    [0, minX], [0, maxX],
    [2, minZ], [2, maxZ]
  ];
  for (let i = 0; i < faces.length; i++) {
    out = capSoupNearPlane(out, faces[i][0], faces[i][1], 0.55);
  }
  return out;
}

function captureJoinFace(hit) {
  return capturePlanarFace(hit);
}

function capturePlanarFace(hit) {
  if (!hit || !hit.face || !hit.object || !hit.object.geometry) return null;
  const mesh = hit.object;
  const nHit = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
  if (Math.abs(nHit.y) >= Math.abs(nHit.x) && Math.abs(nHit.y) >= Math.abs(nHit.z)) {
    setStatus('Click a side wall, not the top');
    return null;
  }
  const planeW = nHit.dot(hit.point);
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = geo.attributes.position;
  const kept = [];
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const tn = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    tmpA.fromBufferAttribute(pos, i);
    tmpB.fromBufferAttribute(pos, i + 1);
    tmpC.fromBufferAttribute(pos, i + 2);
    mesh.localToWorld(tmpA);
    mesh.localToWorld(tmpB);
    mesh.localToWorld(tmpC);
    tn.crossVectors(tmpB.clone().sub(tmpA), tmpC.clone().sub(tmpA)).normalize();
    if (tn.dot(nHit) < 0.92) continue;
    const mid = tmpA.clone().add(tmpB).add(tmpC).multiplyScalar(1 / 3);
    if (Math.abs(nHit.dot(mid) - planeW) > 0.35) continue;
    kept.push(tmpA.x, tmpA.y, tmpA.z, tmpB.x, tmpB.y, tmpB.z, tmpC.x, tmpC.y, tmpC.z);
  }
  if (kept.length < 9) return null;
  const axis = Math.abs(nHit.x) >= Math.abs(nHit.z) ? 'x' : 'z';
  return {
    axis: axis,
    axisIdx: axis === 'x' ? 0 : 2,
    sign: axis === 'x' ? (nHit.x >= 0 ? 1 : -1) : (nHit.z >= 0 ? 1 : -1),
    point: hit.point.clone(),
    worldTris: kept
  };
}

function showPlanarHighlight(mesh, face) {
  removeFaceHelper();
  if (!face || !face.worldTris || !state.scene) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(face.worldTris, 3));
  const hl = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthTest: false
  }));
  hl.renderOrder = 20;
  state.scene.add(hl);
  state.faceHelper = hl;
}

function removeFaceHelper() {
  if (state.faceHelper && state.faceHelper.parent) {
    state.faceHelper.parent.remove(state.faceHelper);
  }
  if (state.faceHelper) {
    if (state.faceHelper.geometry) state.faceHelper.geometry.dispose();
    if (state.faceHelper.material) state.faceHelper.material.dispose();
  }
  state.faceHelper = null;
}

function showFaceHighlight(hit) {
  removeFaceHelper();
  if (!hit || !hit.face || !state.scene) return;
  const geo = new THREE.BufferGeometry();
  const pos = hit.object.geometry.attributes.position;
  const ia = hit.face.a, ib = hit.face.b, ic = hit.face.c;
  const a = new THREE.Vector3().fromBufferAttribute(pos, ia);
  const b = new THREE.Vector3().fromBufferAttribute(pos, ib);
  const c = new THREE.Vector3().fromBufferAttribute(pos, ic);
  hit.object.localToWorld(a);
  hit.object.localToWorld(b);
  hit.object.localToWorld(c);
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  a.addScaledVector(n, 0.25);
  b.addScaledVector(n, 0.25);
  c.addScaledVector(n, 0.25);
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z
  ], 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthTest: false
  }));
  mesh.renderOrder = 20;
  state.scene.add(mesh);
  state.faceHelper = mesh;
}

function detectMateAxis(placedA, placedB) {
  if (!placedA || !placedB || !placedA.mesh || !placedB.mesh) return 'x';
  const bbA = meshLocalBox3(placedA.mesh);
  const bbB = meshLocalBox3(placedB.mesh);
  const sepX = bbA.max.x < bbB.min.x ? bbB.min.x - bbA.max.x
    : bbB.max.x < bbA.min.x ? bbA.min.x - bbB.max.x : 0;
  const sepZ = bbA.max.z < bbB.min.z ? bbB.min.z - bbA.max.z
    : bbB.max.z < bbA.min.z ? bbA.min.z - bbB.max.z : 0;
  if (sepZ > 0.2 && sepZ >= sepX) return 'z';
  if (sepX > 0.2) return 'x';
  const dx = Math.abs(((bbA.min.x + bbA.max.x) - (bbB.min.x + bbB.max.x)) / 2);
  const dz = Math.abs(((bbA.min.z + bbA.max.z) - (bbB.min.z + bbB.max.z)) / 2);
  return dz >= dx ? 'z' : 'x';
}

function autoKissOnFaces(placedA, faceA, placedB, faceB) {
  if (!placedA || !placedB) return faceA && faceA.axisIdx === 2 ? 2 : 0;
  const fa = placedFootprint(placedA);
  const fb = placedFootprint(placedB);
  const dx = ((fb.minx + fb.maxx) - (fa.minx + fa.maxx)) / 2;
  const dz = ((fb.minz + fb.maxz) - (fa.minz + fa.maxz)) / 2;
  if (Math.abs(dx) >= Math.abs(dz)) {
    applyPlacedXZ(placedB, dx >= 0 ? placedB.x + (fa.maxx - fb.minx) : placedB.x + (fa.minx - fb.maxx), placedB.z);
    return 0;
  }
  applyPlacedXZ(placedB, placedB.x, dz >= 0 ? placedB.z + (fa.maxz - fb.minz) : placedB.z + (fa.minz - fb.maxz));
  return 2;
}

function meshBandExtent(mesh, axis, tMin, tMax, pad) {
  const out = { min: Infinity, max: -Infinity, hits: false, groups: [] };
  if (!mesh || !mesh.geometry) return out;
  const posAttr = mesh.geometry.attributes && mesh.geometry.attributes.position;
  if (!posAttr) return out;
  mesh.updateMatrixWorld(true);
  const m = mesh.matrixWorld.elements;
  const p = pad == null ? 0.05 : pad;
  const lo = Math.min(tMin, tMax) - p;
  const hi = Math.max(tMin, tMax) + p;
  const wantX = axis === 'x';
  const index = mesh.geometry.index;
  const triCount = index ? (index.count / 3) : (posAttr.count / 3);
  const WALL_FLATNESS_TOL = 0.6; // mm -- a real wall barely varies in its own normal coord

  function vertAt(vi) {
    const i = index ? index.getX(vi) : vi;
    const lx = posAttr.getX(i), ly = posAttr.getY(i), lz = posAttr.getZ(i);
    const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
    const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
    return { t: wantX ? wz : wx, n: wantX ? wx : wz };
  }
  function clipHalf(poly, bound, side) {
    if (!poly.length) return poly;
    const res = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], nxt = poly[(i + 1) % poly.length];
      const curIn = side > 0 ? cur.t >= bound : cur.t <= bound;
      const nxtIn = side > 0 ? nxt.t >= bound : nxt.t <= bound;
      if (curIn) res.push(cur);
      if (curIn !== nxtIn) {
        const dt = nxt.t - cur.t;
        const f = dt !== 0 ? (bound - cur.t) / dt : 0;
        res.push({ t: bound, n: cur.n + (nxt.n - cur.n) * f });
      }
    }
    return res;
  }
  // Distinct wall FACES in this band, each kept as its own [min,max] envelope
  // (not collapsed to one shared value) -- a real STL wall isn't perfectly
  // flat (triangulation/export noise of a few tenths of a mm), and averaging
  // that noise away from the true outer surface is what left a persistent
  // sliver gap after Join. Keeping the envelope lets us use the correct
  // outward extreme per direction instead of a blurred average.
  const groups = [];
  for (let ti = 0; ti < triCount; ti++) {
    let poly = [vertAt(ti * 3), vertAt(ti * 3 + 1), vertAt(ti * 3 + 2)];
    poly = clipHalf(poly, lo, 1);
    if (!poly.length) continue;
    poly = clipHalf(poly, hi, -1);
    if (!poly.length) continue;
    let nMin = Infinity, nMax = -Infinity;
    for (let k = 0; k < poly.length; k++) {
      if (poly[k].n < nMin) nMin = poly[k].n;
      if (poly[k].n > nMax) nMax = poly[k].n;
    }
    // Skip cap/floor-like faces that aren't roughly perpendicular to this
    // axis (their "n" coordinate sweeps across the whole face instead of
    // staying flat) -- these aren't real walls and pollute the result.
    if (nMax - nMin > WALL_FLATNESS_TOL) continue;
    out.hits = true;
    if (nMin < out.min) out.min = nMin;
    if (nMax > out.max) out.max = nMax;

    let g = null;
    for (let gi = 0; gi < groups.length; gi++) {
      const gg = groups[gi];
      // Same wall face if this triangle's range overlaps the group's
      // envelope once padded by the flatness tolerance.
      if (nMin <= gg.max + WALL_FLATNESS_TOL && nMax >= gg.min - WALL_FLATNESS_TOL) { g = gg; break; }
    }
    if (!g) { groups.push({ min: nMin, max: nMax }); }
    else { if (nMin < g.min) g.min = nMin; if (nMax > g.max) g.max = nMax; }
  }
  out.groups = groups;
  return out;
}

function alignJoinForSlide() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Pick A and B first', true);
    return false;
  }
  const placedA = state.placed.find(function (p) { return p && p.sourceId === idA && p.mesh; });
  const placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both pieces must be on the plate', true);
    return false;
  }
  const fa = placedFootprint(placedA);
  const fb = placedFootprint(placedB);
  const CONCAVE_TOL = 1.0; // mm

  const xBand = meshBandExtent(placedA.mesh, 'x', fb.minz, fb.maxz);
  const zBand = meshBandExtent(placedA.mesh, 'z', fb.minx, fb.maxx);

  // Pick, among A's distinct wall faces in the band, the one whose relevant
  // OUTWARD extreme (max for a "+" facing candidate, min for "-") is nearest
  // B's corresponding edge -- both which wall (an L/step-shaped A can have
  // several) and which value to actually snap to (the true outer surface,
  // not an average of its own noise).
  function nearestExtreme(groups, target, useMax) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const val = useMax ? groups[i].max : groups[i].min;
      const d = Math.abs(val - target);
      if (d < bestD) { bestD = d; best = val; }
    }
    return best;
  }
  function pickBest(cands) {
    if (!cands.length) return null;
    cands.sort(function (c1, c2) { return Math.abs(c1.delta) - Math.abs(c2.delta); });
    return cands[0];
  }
  function isConcave(best) {
    if (!best) return false;
    const globalWall = best.axis === 'x'
      ? (best.dir > 0 ? fa.maxx : fa.minx)
      : (best.dir > 0 ? fa.maxz : fa.minz);
    return Math.abs(best.wall - globalWall) > CONCAVE_TOL;
  }

  const xCands = [];
  if (xBand.groups.length) {
    const wPlus = nearestExtreme(xBand.groups, fb.minx, true);
    xCands.push({ axis: 'x', dir: 1, wall: wPlus, delta: wPlus - fb.minx });
    const wMinus = nearestExtreme(xBand.groups, fb.maxx, false);
    xCands.push({ axis: 'x', dir: -1, wall: wMinus, delta: wMinus - fb.maxx });
  }
  const zCands = [];
  if (zBand.groups.length) {
    const wPlus = nearestExtreme(zBand.groups, fb.minz, true);
    zCands.push({ axis: 'z', dir: 1, wall: wPlus, delta: wPlus - fb.minz });
    const wMinus = nearestExtreme(zBand.groups, fb.maxz, false);
    zCands.push({ axis: 'z', dir: -1, wall: wMinus, delta: wMinus - fb.maxz });
  }

  const bestX = pickBest(xCands);
  const bestZ = pickBest(zCands);
  const xConcave = isConcave(bestX);
  const zConcave = isConcave(bestZ);
  const SNAP_DIST = 6; // mm -- tune if your hand-drag placements are looser
  const bothClose = bestX && bestZ
    && Math.abs(bestX.delta) <= SNAP_DIST
    && Math.abs(bestZ.delta) <= SNAP_DIST;

  let nx = placedB.x;
  let nz = placedB.z;

  if (bothClose && xConcave && zConcave) {
    nx = placedB.x + bestX.delta;
    nz = placedB.z + bestZ.delta;
    applyPlacedXZ(placedB, nx, nz);
    matchPlacedBottoms(placedA, placedB);
    setStatus("Aligned into A's inner corner");
    return true;
  }

  const candidates = xCands.concat(zCands);
  if (candidates.length) {
    const best = pickBest(candidates);
    const concaveHere = isConcave(best);

    if (best.axis === 'x') {
      nx = placedB.x + best.delta;
      if (concaveHere) {
        nz = placedB.z;
      } else {
        const toMin = fa.minz - fb.minz;
        const toMax = fa.maxz - fb.maxz;
        nz = placedB.z + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
      }
      state.joinSlideAxis = 'z';
    } else {
      nz = placedB.z + best.delta;
      if (concaveHere) {
        nx = placedB.x;
      } else {
        const toMin = fa.minx - fb.minx;
        const toMax = fa.maxx - fb.maxx;
        nx = placedB.x + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
      }
      state.joinSlideAxis = 'x';
    }
    applyPlacedXZ(placedB, nx, nz);
    matchPlacedBottoms(placedA, placedB);
    setStatus(concaveHere ? "Aligned to A's inner wall" : 'Aligned to nearest corner of A');
    return true;
  }

  const dx = ((fb.minx + fb.maxx) - (fa.minx + fa.maxx)) / 2;
  const dz = ((fb.minz + fb.maxz) - (fa.minz + fa.maxz)) / 2;
  if (Math.abs(dx) >= Math.abs(dz)) {
    nx = dx >= 0 ? placedB.x + (fa.maxx - fb.minx) : placedB.x + (fa.minx - fb.maxx);
    const toMin = fa.minz - fb.minz;
    const toMax = fa.maxz - fb.maxz;
    nz = placedB.z + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
    state.joinSlideAxis = 'z';
  } else {
    nz = dz >= 0 ? placedB.z + (fa.maxz - fb.minz) : placedB.z + (fa.minz - fb.maxz);
    const toMin = fa.minx - fb.minx;
    const toMax = fa.maxx - fb.maxx;
    nx = placedB.x + (Math.abs(toMin) <= Math.abs(toMax) ? toMin : toMax);
    state.joinSlideAxis = 'x';
  }
  applyPlacedXZ(placedB, nx, nz);
  matchPlacedBottoms(placedA, placedB);
  setStatus('Aligned to nearest corner of A');
  return true;
}

function displayGeometryToRawSoup(geometry) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = geo.attributes.position;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    out[i*3] = x; out[i*3+1] = -z; out[i*3+2] = y;
  }
  return out;
}

function getModelRawSoup(model) {
  if (model.rawTris && model.rawAxis === 'zup') return model.rawTris;
  return displayGeometryToRawSoup(model.geometry);
}



function modelNameById(id) {
  const m = state.models.find(function (x) { return x.id === id; });
  return m && m.name ? m.name : '';
}

function paintJoinHighlights() {
  (state.placed || []).forEach(function (pl) {
    if (!pl || !pl.mesh || !pl.mesh.material || !pl.mesh.material.color) return;
    const selected = pl.sourceId === state.editId;
    pl.mesh.material.color.setHex(selected ? SELECT_COLOR : PIECE_COLOR);
    if (pl.mesh.material.emissive) {
      pl.mesh.material.emissive.setHex(selected ? 0x9f1239 : 0x0a3a5c);
      pl.mesh.material.emissiveIntensity = selected ? 0.4 : 0.2;
    }
  });
}

function updateJoinUI() {
  const a = state.models.find(function (x) { return x.id === state.editId && state.joinSession; });
  const b = state.models.find(function (x) { return x.id === state.joinPartnerId; });
  const nameA = document.getElementById('join-name-a');
  const nameB = document.getElementById('join-name-b');
  const slotA = document.getElementById('join-slot-a');
  const slotB = document.getElementById('join-slot-b');
  const step = document.getElementById('join-step');
  const btn = document.getElementById('btn-join');
  if (nameA) {
    const face = state.joinFaceA;
    nameA.textContent = (state.joinSession && state.editId && a)
      ? (a.name + (face ? ' · ' + face.axis.toUpperCase() + (face.sign > 0 ? '+' : '-') : ''))
      : 'Pick piece A';
  }
  if (nameB) {
    const face = state.joinFaceB;
    nameB.textContent = b
      ? (b.name + (face ? ' · ' + face.axis.toUpperCase() + (face.sign > 0 ? '+' : '-') : ''))
      : 'Pick piece B';
  }
  const faceBtn = document.getElementById('btn-join-faces');
  if (faceBtn) {
    faceBtn.classList.toggle('tool-active', !!state.joinUseFaces);
    faceBtn.textContent = state.joinUseFaces ? 'Faces ON — click cut walls' : 'Lock faces (optional)';
  }
  if (slotA) {
    slotA.classList.toggle('filled-a', !!(state.joinSession && state.editId));
    slotA.classList.toggle('armed', state.joinArmed === 'a');
  }
  if (slotB) {
    slotB.classList.toggle('filled-b', !!state.joinPartnerId);
    slotB.classList.toggle('armed', state.joinArmed === 'b');
  }
  if (btn) btn.disabled = !(state.joinSession && state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const btnSub = document.getElementById('btn-subtract');
  if (btnSub) btnSub.disabled = !(state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const alignBtn = document.getElementById('btn-join-align');
  if (alignBtn) alignBtn.disabled = !(state.joinSession && state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const readyJoin = !!(state.joinSession && state.editId && state.joinPartnerId && state.editId !== state.joinPartnerId);
  const cx = document.getElementById('btn-join-cx');
  const cz = document.getElementById('btn-join-cz');
  if (cx) cx.disabled = !readyJoin;
  if (cz) cz.disabled = !readyJoin;
  if (step) {
    if (!state.joinSession) step.textContent = '1. Start Join';
    else if (state.joinArmed === 'a') step.textContent = '2. Click piece A on the plate or list';
    else if (!state.editId) step.textContent = '2. Click Pick A';
    else if (state.joinArmed === 'b') step.textContent = '3. Click piece B on the plate or list';
    else if (!state.joinPartnerId) step.textContent = '3. Click Pick B';
    else step.textContent = '4. Align / slide B along the wall, then Complete Join';
  }
  paintJoinHighlights();
}

function assignJoinClick(id, face) {
  if (id == null) return;
  if (!state.joinSession || !state.joinArmed) return;
  const useFace = face || null;
  if (state.joinArmed === 'a') {
    if (id === state.joinPartnerId) { state.joinPartnerId = null; state.joinFaceB = null; }
    state.editId = id;
    state.joinFaceA = useFace;
    state.cutT = 0.5;
    state.joinArmed = null;
  } else if (state.joinArmed === 'b') {
    if (id === state.editId) return;
    state.joinPartnerId = id;
    state.joinFaceB = useFace;
    state.joinArmed = null;
  }
  renderModelList();
  updateEditSize();
  updateJoinUI();
}

function startJoinSession() {
  if (state.cutterOpen) closeCutter(true);
  state.joinSession = true;
  state.joinArmed = null;
  state.joinPartnerId = null;
  state.joinFaceA = null;
  state.joinFaceB = null;
  state.joinSlideAxis = null;
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  state.editId = null;
  state.selectedIndex = -1;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  renderModelList();
  updateJoinUI();
}

function armJoinSlot(slot) {
  if (!state.joinSession) startJoinSession();
  state.joinArmed = slot;
  updateJoinUI();
}

function clearJoinSlots() {
  state.joinSession = false;
  state.joinArmed = null;
  state.joinPartnerId = null;
  state.joinFaceA = null;
  state.joinFaceB = null;
  state.joinUseFaces = false;
  state.joinSlideAxis = null;
  removeFaceHelper();
  renderModelList();
  updateEditSize();
  updateJoinUI();
}

/**
 * Subtract: keep A's triangles that lie outside B, drop the ones inside B,
 * weld the cut, then close only small stray loops the clip/weld introduces
 * (weld-tolerance slivers) -- never the cavity itself. B's shell is fully
 * discarded. This is a triangle-soup boolean by centroid + ray-parity, not
 * a true CSG: a triangle straddling B's own skin, or a non-manifold/open B
 * (no bottom cap on the bit), can misclassify near the boundary.
 */
/* ============================================================
   NSO shared math — no ES modules, r147, Safari-safe
   ============================================================ */

var NSO_EPS = 1e-7;

function NSO_soupLen(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }

/* ---- 1. World soup from a PLACED mesh (position + quaternion + scale + lift) ---- */

function meshToWorldSoup(placed, extraLift) {
  if (!placed || !placed.geometry) return new Float32Array(0);

  placed.updateWorldMatrix(true, false);
  var m = placed.matrixWorld.clone();

  // "lift" applied after the matrix (if your pipeline keeps it separate)
  if (extraLift) {
    var lm = new THREE.Matrix4().makeTranslation(
      extraLift.x || 0, extraLift.y || 0, extraLift.z || 0
    );
    m.premultiply(lm);
  }

  var g = placed.geometry;
  var pos = g.attributes && g.attributes.position;
  if (!pos) return new Float32Array(0);

  var idx = g.index ? g.index.array : null;
  var triCount = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  var out = new Float32Array(triCount * 9);

  var v = new THREE.Vector3();
  var w = 0;
  for (var t = 0; t < triCount; t++) {
    for (var k = 0; k < 3; k++) {
      var vi = idx ? idx[t * 3 + k] : (t * 3 + k);
      v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      v.applyMatrix4(m);
      out[w++] = v.x; out[w++] = v.y; out[w++] = v.z;
    }
  }
  return out;
}

/* Back-compat shim so old call sites keep working. Prefer meshToWorldSoup. */
function NSO_geomToWorldSoup(geometry, px, py, pz, quatOrEuler, scale) {
  var m = new THREE.Matrix4();
  var q = new THREE.Quaternion();
  if (quatOrEuler) {
    if (quatOrEuler.isQuaternion) q.copy(quatOrEuler);
    else if (quatOrEuler.isEuler) q.setFromEuler(quatOrEuler);
  }
  var s = scale ? (scale.isVector3 ? scale : new THREE.Vector3(scale, scale, scale))
                : new THREE.Vector3(1, 1, 1);
  m.compose(new THREE.Vector3(px || 0, py || 0, pz || 0), q, s);

  var fake = { geometry: geometry, matrixWorld: m, updateWorldMatrix: function () {} };
  return meshToWorldSoup(fake);
}

/* ---- soup <-> geometry ---- */

function NSO_soupToGeometry(soup) {
  var g = new THREE.BufferGeometry();
  var arr = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function NSO_soupToLocal(worldSoup, mesh) {
  mesh.updateWorldMatrix(true, false);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var out = new Float32Array(worldSoup.length);
  var v = new THREE.Vector3();
  for (var i = 0; i < worldSoup.length; i += 3) {
    v.set(worldSoup[i], worldSoup[i + 1], worldSoup[i + 2]).applyMatrix4(inv);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  return out;
}

/* ---- ray parity (point inside closed soup) ---- */

function NSO_rayTri(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  var det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  var inv = 1 / det;
  var tx = ox - ax, ty = oy - ay, tz = oz - az;
  var u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  var vv = (dx * qx + dy * qy + dz * qz) * inv;
  if (vv < 0 || u + vv > 1) return -1;
  var tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return (tt > 1e-6) ? tt : -1;
}

/* 3 skew rays, majority vote — kills the coplanar/edge ghosting on voxel plugs */
var NSO_RAYS = [
  [0.5773502, 0.5127110, 0.6350210],
  [-0.4472136, 0.7071068, 0.5477226],
  [0.3015113, -0.6030227, 0.7385489]
];

function NSO_pointInsideSoup(soup, x, y, z) {
  var votes = 0;
  for (var r = 0; r < 3; r++) {
    var dx = NSO_RAYS[r][0], dy = NSO_RAYS[r][1], dz = NSO_RAYS[r][2];
    var hits = 0;
    for (var i = 0; i < soup.length; i += 9) {
      if (NSO_rayTri(x, y, z, dx, dy, dz,
        soup[i], soup[i + 1], soup[i + 2],
        soup[i + 3], soup[i + 4], soup[i + 5],
        soup[i + 6], soup[i + 7], soup[i + 8]) > 0) hits++;
    }
    if (hits & 1) votes++;
  }
  return votes >= 2;
}

/* ---- box-likeness detection in the plug's own local frame ---- */

function NSO_localAABB(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  return geometry.boundingBox.clone();
}

/* True only if every face normal is axis-aligned AND its verts sit on the
   matching AABB face. A stepped / slotted / smooth plug returns false. */
function NSO_isBoxLike(geometry, box) {
  var pos = geometry.attributes && geometry.attributes.position;
  if (!pos) return false;
  var idx = geometry.index ? geometry.index.array : null;
  var triCount = idx ? (idx.length / 3) | 0 : (pos.count / 3) | 0;
  if (triCount < 12) return false;

  var size = new THREE.Vector3(); box.getSize(size);
  var tol = Math.max(size.x, size.y, size.z) * 1e-3;

  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  var ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  var lo = [box.min.x, box.min.y, box.min.z];
  var hi = [box.max.x, box.max.y, box.max.z];

  for (var t = 0; t < triCount; t++) {
    var i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
    b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
    c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-16) continue;
    n.normalize();

    var comp = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    var ax = comp[0] > comp[1] ? (comp[0] > comp[2] ? 0 : 2) : (comp[1] > comp[2] ? 1 : 2);
    if (comp[ax] < 0.999) return false;

    var av = [a.x, a.y, a.z][ax], bv = [b.x, b.y, b.z][ax], cv = [c.x, c.y, c.z][ax];
    var onLo = Math.abs(av - lo[ax]) < tol && Math.abs(bv - lo[ax]) < tol && Math.abs(cv - lo[ax]) < tol;
    var onHi = Math.abs(av - hi[ax]) < tol && Math.abs(bv - hi[ax]) < tol && Math.abs(cv - hi[ax]) < tol;
    if (!onLo && !onHi) return false;
  }
  return true;
}

/* ---- clip one triangle against an AABB, keep the OUTSIDE fragments ---- */

function NSO_splitPolyByAxisPlane(poly, axis, sign, val, inPoly, outPoly) {
  inPoly.length = 0; outPoly.length = 0;
  var n = poly.length;
  for (var i = 0; i < n; i++) {
    var p = poly[i], q = poly[(i + 1) % n];
    var fp = sign * (p.getComponent(axis) - val);
    var fq = sign * (q.getComponent(axis) - val);
    if (fp <= 0) inPoly.push(p.clone()); else outPoly.push(p.clone());
    if ((fp > 0) !== (fq > 0)) {
      var d = fp - fq;
      var s = (Math.abs(d) < NSO_EPS) ? 0.5 : (fp / d);
      var m = new THREE.Vector3().lerpVectors(p, q, s);
      inPoly.push(m.clone()); outPoly.push(m.clone());
    }
  }
}

function NSO_fanTriangulate(poly, sink) {
  if (poly.length < 3) return;
  for (var i = 1; i + 1 < poly.length; i++) {
    var a = poly[0], b = poly[i], c = poly[i + 1];
    var abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    var acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    var cx = aby * acz - abz * acy, cy = abz * acx - abx * acz, cz = abx * acy - aby * acx;
    if (cx * cx + cy * cy + cz * cz < 1e-18) continue; // degenerate sliver
    sink.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
}

/* Returns fragments of the triangle lying OUTSIDE the box. Empty = fully inside. */
function NSO_clipTriOutsideAABB(a, b, c, box, sink) {
  var planes = [
    [0, 1, box.max.x], [0, -1, box.min.x],
    [1, 1, box.max.y], [1, -1, box.min.y],
    [2, 1, box.max.z], [2, -1, box.min.z]
  ];
  var cur = [a.clone(), b.clone(), c.clone()];
  var inP = [], outP = [];
  for (var p = 0; p < 6; p++) {
    if (cur.length < 3) return;
    NSO_splitPolyByAxisPlane(cur, planes[p][0], planes[p][1], planes[p][2], inP, outP);
    if (outP.length >= 3) NSO_fanTriangulate(outP, sink);
    cur = inP.slice();
  }
  // whatever survived all 6 planes is strictly inside the box -> dropped
}

/* ============================================================
   2. subtractSoupBFromA — soup-level pocket cut
   ============================================================
   aWorld : hull soup, world space
   bWorld : plug soup, world space
   opts   : { plugMatrix, plugLocalBox, mode:'auto'|'box'|'centroid', wallShrink }
   Returns { ok, soup, mode, reason, hullTris, wallTris }
   ============================================================ */

/* ============================================================
   NSO rounded-hull Seat + Subtract
   Adds: hull signed-distance grid, plug frame, corner projection,
         rim clip of plug walls to hull skin.
   ============================================================ */

/* ---- hull signed-distance grid (convex-ish hull assumption) ---- */


function NSO_closestPointOnTri(p, a, b, c, out) {
  var ab = new THREE.Vector3().subVectors(b, a);
  var ac = new THREE.Vector3().subVectors(c, a);
  var ap = new THREE.Vector3().subVectors(p, a);
  var d1 = ab.dot(ap), d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  var bp = new THREE.Vector3().subVectors(p, b);
  var d3 = ab.dot(bp), d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  var vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
  var cp = new THREE.Vector3().subVectors(p, c);
  var d5 = ab.dot(cp), d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  var vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
  var va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    var w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(new THREE.Vector3().subVectors(c, b), w);
  }
  var den = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(ab, vb * den).addScaledVector(ac, vc * den);
}

function NSO_buildHullGrid(soup) {
  var n = (soup.length / 9) | 0;
  var mn = new THREE.Vector3(Infinity, Infinity, Infinity);
  var mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  var i, k;
  for (i = 0; i < soup.length; i += 3) {
    if (soup[i] < mn.x) mn.x = soup[i]; if (soup[i] > mx.x) mx.x = soup[i];
    if (soup[i + 1] < mn.y) mn.y = soup[i + 1]; if (soup[i + 1] > mx.y) mx.y = soup[i + 1];
    if (soup[i + 2] < mn.z) mn.z = soup[i + 2]; if (soup[i + 2] > mx.z) mx.z = soup[i + 2];
  }
  var size = new THREE.Vector3().subVectors(mx, mn);
  var span = Math.max(size.x, size.y, size.z) || 1;
  var res = Math.max(4, Math.min(40, Math.round(Math.cbrt(n) * 1.2)));
  var cell = span / res;

  var center = new THREE.Vector3().addVectors(mn, mx).multiplyScalar(0.5);

  /* outward-oriented per-tri normals */
  var nrm = new Float32Array(n * 3);
  var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  var e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nv = new THREE.Vector3(), cen = new THREE.Vector3();
  for (i = 0; i < n; i++) {
    var o = i * 9;
    a.set(soup[o], soup[o + 1], soup[o + 2]);
    b.set(soup[o + 3], soup[o + 4], soup[o + 5]);
    c.set(soup[o + 6], soup[o + 7], soup[o + 8]);
    e1.subVectors(b, a); e2.subVectors(c, a);
    nv.crossVectors(e1, e2);
    if (nv.lengthSq() < 1e-18) { nrm[i * 3] = 0; nrm[i * 3 + 1] = 1; nrm[i * 3 + 2] = 0; continue; }
    nv.normalize();
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(center);
    if (nv.dot(cen) < 0) nv.negate();
    nrm[i * 3] = nv.x; nrm[i * 3 + 1] = nv.y; nrm[i * 3 + 2] = nv.z;
  }

  var buckets = {};
  function key(ix, iy, iz) { return ix + ',' + iy + ',' + iz; }
  for (i = 0; i < n; i++) {
    var oo = i * 9;
    var tminx = Math.min(soup[oo], soup[oo + 3], soup[oo + 6]);
    var tmaxx = Math.max(soup[oo], soup[oo + 3], soup[oo + 6]);
    var tminy = Math.min(soup[oo + 1], soup[oo + 4], soup[oo + 7]);
    var tmaxy = Math.max(soup[oo + 1], soup[oo + 4], soup[oo + 7]);
    var tminz = Math.min(soup[oo + 2], soup[oo + 5], soup[oo + 8]);
    var tmaxz = Math.max(soup[oo + 2], soup[oo + 5], soup[oo + 8]);
    var x0 = Math.floor((tminx - mn.x) / cell), x1 = Math.floor((tmaxx - mn.x) / cell);
    var y0 = Math.floor((tminy - mn.y) / cell), y1 = Math.floor((tmaxy - mn.y) / cell);
    var z0 = Math.floor((tminz - mn.z) / cell), z1 = Math.floor((tmaxz - mn.z) / cell);
    for (var gx = x0; gx <= x1; gx++)
      for (var gy = y0; gy <= y1; gy++)
        for (var gz = z0; gz <= z1; gz++) {
          var kk = key(gx, gy, gz);
          if (!buckets[kk]) buckets[kk] = [];
          buckets[kk].push(i);
        }
  }
  return { soup: soup, n: n, min: mn, cell: cell, buckets: buckets, nrm: nrm, center: center, span: span };
}

/* negative = inside. Returns { d, p, n } or null if hull is empty. */
var NSO__cp = new THREE.Vector3();
var NSO__ta = new THREE.Vector3(), NSO__tb = new THREE.Vector3(), NSO__tc = new THREE.Vector3();

function NSO_signedDistToHull(grid, x, y, z) {
  if (!grid || !grid.n) return null;
  var p = new THREE.Vector3(x, y, z);
  var cx = Math.floor((x - grid.min.x) / grid.cell);
  var cy = Math.floor((y - grid.min.y) / grid.cell);
  var cz = Math.floor((z - grid.min.z) / grid.cell);

  var best = Infinity, bestTri = -1, bestPt = new THREE.Vector3();
  var maxR = 32;
  for (var r = 0; r <= maxR; r++) {
    var found = false;
    for (var dx = -r; dx <= r; dx++)
      for (var dy = -r; dy <= r; dy++)
        for (var dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          var list = grid.buckets[(cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)];
          if (!list) continue;
          found = true;
          for (var li = 0; li < list.length; li++) {
            var ti = list[li], o = ti * 9;
            NSO__ta.set(grid.soup[o], grid.soup[o + 1], grid.soup[o + 2]);
            NSO__tb.set(grid.soup[o + 3], grid.soup[o + 4], grid.soup[o + 5]);
            NSO__tc.set(grid.soup[o + 6], grid.soup[o + 7], grid.soup[o + 8]);
            NSO_closestPointOnTri(p, NSO__ta, NSO__tb, NSO__tc, NSO__cp);
            var d2 = NSO__cp.distanceToSquared(p);
            if (d2 < best) { best = d2; bestTri = ti; bestPt.copy(NSO__cp); }
          }
        }
    /* stop once the found radius is guaranteed to enclose the true nearest */
    if (bestTri >= 0 && found && Math.sqrt(best) <= r * grid.cell) break;
    if (bestTri >= 0 && r >= 3) break;
  }
  if (bestTri < 0) return null;

  var nx = grid.nrm[bestTri * 3], ny = grid.nrm[bestTri * 3 + 1], nz = grid.nrm[bestTri * 3 + 2];
  var d = (x - bestPt.x) * nx + (y - bestPt.y) * ny + (z - bestPt.z) * nz;
  return { d: d, p: bestPt, nx: nx, ny: ny, nz: nz };
}

/* ---- plug frame: which local box face is the outer face ---- */

/* ============================================================
   NSO_plugFrame  (patched — shape-agnostic axis selection)
   ============================================================ */
function NSO_plugFrame(bitMesh, hullCenterWorld, aWorld) {
  bitMesh.updateWorldMatrix(true, false);
  var box = NSO_localAABB(bitMesh.geometry);
  var M = bitMesh.matrixWorld.clone();

  var plugCenterLocal = new THREE.Vector3();
  box.getCenter(plugCenterLocal);
  var plugCenterWorld = plugCenterLocal.clone().applyMatrix4(M);

  var nm = new THREE.Matrix3().getNormalMatrix(M);
  var extent = new THREE.Vector3();
  box.getSize(extent);

  var outward = new THREE.Vector3().subVectors(plugCenterWorld, hullCenterWorld || plugCenterWorld);
  if (outward.lengthSq() < 1e-12) outward.set(0, 1, 0);
  outward.normalize();

  var haveSoup = aWorld && NSO_soupLen(aWorld);
  var axis = 1, sign = 1, bestN = new THREE.Vector3(0, 1, 0);
  var cand = new THREE.Vector3(), probeOut = new THREE.Vector3(), probeIn = new THREE.Vector3();
  var bestScore = -Infinity;

  for (var a = 0; a < 3; a++) {
    var half = Math.max(extent.getComponent(a) * 0.5, 0.5);
    var margin = half + Math.max(0.75, half * 0.25);
    for (var s = -1; s <= 1; s += 2) {
      cand.set(0, 0, 0).setComponent(a, s).applyMatrix3(nm).normalize();
      var score;
      if (haveSoup) {
        probeOut.copy(plugCenterWorld).addScaledVector(cand, margin);
        probeIn.copy(plugCenterWorld).addScaledVector(cand, -margin);
        var outOK = !NSO_pointInsideSoup(aWorld, probeOut.x, probeOut.y, probeOut.z);
        var inOK = NSO_pointInsideSoup(aWorld, probeIn.x, probeIn.y, probeIn.z);
        /* real seat axis: stepping out clears the hull AND stepping in stays
           inside it. Local + shape-agnostic, so it holds on a stepped/
           non-convex hull, unlike a single whole-hull centroid vector. */
        score = (outOK && inOK) ? 2 : (outOK ? 1 : -1);
        score += cand.dot(outward) * 0.01; // tie-break only
      } else {
        score = cand.dot(outward);
      }
      if (score > bestScore) { bestScore = score; axis = a; sign = s; bestN.copy(cand); }
    }
  }

  return {
    matrix: M,
    inv: new THREE.Matrix4().copy(M).invert(),
    box: box,
    axis: axis,
    sign: sign,
    outerNormal: bestN.clone(),
    punch: bestN.clone().negate(),
    capCoord: (sign > 0) ? box.max.getComponent(axis) : box.min.getComponent(axis),
    span: Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  };
}

function NSO_outerFaceCorners(frame) {
  var a = frame.axis, u = (a + 1) % 3, v = (a + 2) % 3;
  var lo = [frame.box.min.x, frame.box.min.y, frame.box.min.z];
  var hi = [frame.box.max.x, frame.box.max.y, frame.box.max.z];
  var quad = [[lo[u], lo[v]], [hi[u], lo[v]], [hi[u], hi[v]], [lo[u], hi[v]]];
  var out = [];
  for (var i = 0; i < 4; i++) {
    var p = new THREE.Vector3();
    p.setComponent(a, frame.capCoord);
    p.setComponent(u, quad[i][0]);
    p.setComponent(v, quad[i][1]);
    out.push(p.applyMatrix4(frame.matrix));
  }
  return out;
}

/* ---- ray vs soup, nearest hit either direction ---- */

function NSO_nearestSkinHit(soup, o, dir) {
  var bestT = Infinity, sgn = 0;
  var i;
  for (i = 0; i < soup.length; i += 9) {
    var t = NSO_rayTri(o.x, o.y, o.z, dir.x, dir.y, dir.z,
      soup[i], soup[i + 1], soup[i + 2],
      soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t > 0 && t < bestT) { bestT = t; sgn = 1; }
  }
  for (i = 0; i < soup.length; i += 9) {
    var t2 = NSO_rayTri(o.x, o.y, o.z, -dir.x, -dir.y, -dir.z,
      soup[i], soup[i + 1], soup[i + 2],
      soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t2 > 0 && t2 < bestT) { bestT = t2; sgn = -1; }
  }
  if (sgn === 0) return null;
  return o.clone().addScaledVector(dir, bestT * sgn);
}

/* Newell normal of an ordered quad */
function NSO_newellNormal(pts) {
  var n = new THREE.Vector3();
  for (var i = 0; i < pts.length; i++) {
    var c = pts[i], d = pts[(i + 1) % pts.length];
    n.x += (c.y - d.y) * (c.z + d.z);
    n.y += (c.z - d.z) * (c.x + d.x);
    n.z += (c.x - d.x) * (c.y + d.y);
  }
  if (n.lengthSq() < 1e-16) return null;
  return n.normalize();
}

/* ============================================================
   SEAT — corner projection + best-fit tilt on a curved hull
   opts: { proud:0.4, maxTiltDeg:20, iterations:3, liftHull, liftBit }
   ============================================================ */

function NSO_seatFlushBitToHull(hullMesh, bitMesh, opts) {
  opts = opts || {};
  var proud = (opts.proud === undefined) ? 0.4 : opts.proud;
  var maxTilt = ((opts.maxTiltDeg === undefined) ? 20 : opts.maxTiltDeg) * Math.PI / 180;
  var iters = opts.iterations || 3;

  if (!hullMesh || !bitMesh) return { ok: false, reason: 'missing mesh' };

  var hull = meshToWorldSoup(hullMesh, opts.liftHull);
  if (!hull.length) return { ok: false, reason: 'empty hull' };
  var hullSoup = hull;

  /* save for fail-safe restore */
  var savedPos = bitMesh.position.clone();
  var savedQuat = bitMesh.quaternion.clone();

  hullMesh.updateWorldMatrix(true, false);
  if (!hullMesh.geometry.boundingBox) hullMesh.geometry.computeBoundingBox();
  var hullCenter = new THREE.Vector3();
  hullMesh.geometry.boundingBox.getCenter(hullCenter);
  hullCenter.applyMatrix4(hullMesh.matrixWorld);

  var lastFit = null, lastCorners = null, lastHits = null;

  for (var it = 0; it < iters; it++) {
    var frame = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var corners = NSO_outerFaceCorners(frame);
    var punch = frame.punch;

    var hits = [];
    for (var i = 0; i < 4; i++) {
      var h = NSO_nearestSkinHit(hull, corners[i], punch);
      if (!h) {
        bitMesh.position.copy(savedPos);
        bitMesh.quaternion.copy(savedQuat);
        bitMesh.updateMatrixWorld(true);
        return { ok: false, reason: 'corner ' + i + ' missed hull along punch axis' };
      }
      hits.push(h);
    }

    var nFit = NSO_newellNormal(hits);
    if (!nFit) {
      bitMesh.position.copy(savedPos);
      bitMesh.quaternion.copy(savedQuat);
      bitMesh.updateMatrixWorld(true);
      return { ok: false, reason: 'degenerate hit quad' };
    }
    if (nFit.dot(frame.outerNormal) < 0) nFit.negate();

    /* ---- tilt: rotate outer normal onto the fitted plane normal, clamped ---- */
    var q = new THREE.Quaternion().setFromUnitVectors(frame.outerNormal, nFit);
    var ang = 2 * Math.acos(Math.min(1, Math.max(-1, q.w)));
    if (ang > maxTilt) {
      q.slerp(new THREE.Quaternion(), 0); // no-op guard for old three builds
      q = new THREE.Quaternion().slerpQuaternions
        ? new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), q, maxTilt / ang)
        : new THREE.Quaternion().copy(q); // r147 has slerpQuaternions
    }

    var pivot = new THREE.Vector3();
    for (var c = 0; c < 4; c++) pivot.add(corners[c]);
    pivot.multiplyScalar(0.25);

    bitMesh.quaternion.premultiply(q);
    var rel = new THREE.Vector3().subVectors(bitMesh.position, pivot).applyQuaternion(q);
    bitMesh.position.copy(pivot).add(rel);
    bitMesh.updateMatrixWorld(true);

    /* ---- translate along the fitted normal only (preserves Center X/Z) ---- */
    var frame2 = NSO_plugFrame(bitMesh, hullCenter, hullSoup);
    var corners2 = NSO_outerFaceCorners(frame2);
    var faceC = new THREE.Vector3();
    for (var c2 = 0; c2 < 4; c2++) faceC.add(corners2[c2]);
    faceC.multiplyScalar(0.25);

    var hitC = new THREE.Vector3();
    for (var h2 = 0; h2 < 4; h2++) hitC.add(hits[h2]);
    hitC.multiplyScalar(0.25);

    var target = hitC.clone().addScaledVector(nFit, proud);
    var along = target.clone().sub(faceC).dot(nFit);
    bitMesh.position.addScaledVector(nFit, along);
    bitMesh.updateMatrixWorld(true);

    lastFit = nFit; lastCorners = corners2; lastHits = hits;
  }

  /* residual report: how far each corner ends up from the skin */
  var frameF = NSO_plugFrame(bitMesh, hullCenter);
  var cf = NSO_outerFaceCorners(frameF);
  var resid = [], maxResid = 0;
  for (var r = 0; r < 4; r++) {
    var hh = NSO_nearestSkinHit(hull, cf[r], frameF.punch);
    var dv = hh ? cf[r].clone().sub(hh).dot(frameF.outerNormal) : NaN;
    resid.push(dv);
    if (isFinite(dv) && Math.abs(dv - proud) > maxResid) maxResid = Math.abs(dv - proud);
  }

  return {
    ok: true,
    normal: lastFit ? lastFit.clone() : frameF.outerNormal.clone(),
    corners: cf,
    hits: lastHits,
    cornerResidual: resid,
    maxResidual: maxResid,
    undo: { position: savedPos, quaternion: savedQuat }
  };
}


/* ============================================================
   SUBTRACT — box clip hull, rim-clip plug walls to the skin
   ============================================================ */

/* clip a triangle to the region inside the hull (d < 0), curved boundary
   located by bisection along edges. Fan-triangulates into sink. */
function NSO_clipTriInsideHull(grid, A, B, C, sink) {
  var pts = [A, B, C];
  var ds = [];
  var k;
  for (k = 0; k < 3; k++) {
    var r = NSO_signedDistToHull(grid, pts[k].x, pts[k].y, pts[k].z);
    ds.push(r ? r.d : 1);
  }
  var nIn = (ds[0] < 0 ? 1 : 0) + (ds[1] < 0 ? 1 : 0) + (ds[2] < 0 ? 1 : 0);
  if (nIn === 0) return 0;
  if (nIn === 3) {
    sink.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
    return 1;
  }

  var poly = [];
  for (k = 0; k < 3; k++) {
    var p = pts[k], q = pts[(k + 1) % 3];
    var dp = ds[k], dq = ds[(k + 1) % 3];
    if (dp < 0) poly.push(p.clone());
    if ((dp < 0) !== (dq < 0)) {
      /* bisect for the true skin crossing */
      var lo = p.clone(), hi = q.clone();
      if (dp >= 0) { lo = q.clone(); hi = p.clone(); } // lo is inside
      var mid = new THREE.Vector3();
      for (var b = 0; b < 12; b++) {
        mid.addVectors(lo, hi).multiplyScalar(0.5);
        var rr = NSO_signedDistToHull(grid, mid.x, mid.y, mid.z);
        if (rr && rr.d < 0) lo.copy(mid); else hi.copy(mid);
      }
      poly.push(lo.clone().add(hi).multiplyScalar(0.5));
    }
  }
  if (poly.length < 3) return 0;
  var before = sink.length;
  NSO_fanTriangulate(poly, sink);
  return (sink.length - before) / 9;
}



function NSO_wallHitsAlong(soup, ox, oy, oz, dir, maxDist) {
  var hits = [];
  if (!soup || !dir) return hits;
  for (var i = 0; i < soup.length; i += 9) {
    var t = NSO_rayTri(ox, oy, oz, dir.x, dir.y, dir.z,
      soup[i], soup[i + 1], soup[i + 2],
      soup[i + 3], soup[i + 4], soup[i + 5],
      soup[i + 6], soup[i + 7], soup[i + 8]);
    if (t > 1e-3 && t < maxDist) hits.push(t);
  }
  hits.sort(function (a, b) { return a - b; });
  var uniq = [];
  for (var h = 0; h < hits.length; h++) {
    if (!uniq.length || hits[h] - uniq[uniq.length - 1] > 0.15) uniq.push(hits[h]);
  }
  return uniq;
}

function NSO_farWallMarch(grid, ox, oy, oz, dir, maxDist, tol) {
  var d0 = NSO_signedDistToHull(grid, ox, oy, oz);
  if (!d0) return null;
  var t0 = 0;
  if (d0.d >= 0) {
    var seek = 0, found = false, guard0 = 0;
    while (seek < maxDist && guard0 < 400) {
      guard0++;
      seek += Math.max(tol * 4, 0.15);
      var s0 = NSO_signedDistToHull(grid, ox + dir.x * seek, oy + dir.y * seek, oz + dir.z * seek);
      if (s0 && s0.d < 0) { t0 = seek; d0 = s0; found = true; break; }
    }
    if (!found) return null;
  }

  var t = t0, cur = d0.d, guard = 0;
  while (t < maxDist && guard < 2000) {
    guard++;
    var step = Math.max(Math.abs(cur), tol);
    var tNext = t + step;
    var s = NSO_signedDistToHull(grid, ox + dir.x * tNext, oy + dir.y * tNext, oz + dir.z * tNext);
    if (!s) return null;
    if (s.d >= 0) {
      var lo = t, hi = tNext;
      for (var b = 0; b < 12 && (hi - lo) > tol; b++) {
        var mid = (lo + hi) * 0.5;
        var sm = NSO_signedDistToHull(grid, ox + dir.x * mid, oy + dir.y * mid, oz + dir.z * mid);
        if (!sm || sm.d < 0) lo = mid; else hi = mid;
      }
      return { dist: hi };
    }
    t = tNext; cur = s.d;
  }
  return null;
}

/* ============================================================
   subtractSoupBFromA — soup-level pocket cut  (patched)
   ============================================================ */
/* =====================================================================
   NSO_CSG -- real solid boolean kernel adapter (Manifold, WASM)
   New code. Does not replace or call any existing centroid/ray logic.

   Loaded via dynamic import() from jsDelivr at call time (no bundler in
   this app). To vendor for real instead of CDN-loading:
     1. npm i manifold-3d
     2. copy node_modules/manifold-3d/manifold.js and manifold.wasm into
        your repo (e.g. /vendor/manifold/)
     3. point NSO_CSG_URL at that local manifold.js path
   The rest of this adapter is unchanged either way.
   ===================================================================== */

var NSO_CSG_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.3/manifold.js';

var NSO_CSG = (function () {
  var _wasmPromise = null;

  function load() {
    if (!_wasmPromise) {
      _wasmPromise = import(NSO_CSG_URL)
        .then(function (mod) { return (mod.default || mod)(); })
        .then(function (wasm) { wasm.setup(); return wasm; })
        .catch(function (err) {
          _wasmPromise = null; // don't cache a permanent failure -- allow retry next call
          throw err;
        });
    }
    return _wasmPromise;
  }

  // world-space triangle soup (Float32Array, 9 floats/tri, no shared index)
  // -> wasm Manifold. Calls Mesh.merge() to weld coincident corner
  // vertices, since soup has none shared -- this is what lets Manifold see
  // the input as a solid instead of N disconnected triangles.
  function soupToManifold(wasm, soup) {
    var n = (soup.length / 9) | 0;
    var vertProperties = (soup instanceof Float32Array) ? soup.slice() : new Float32Array(soup);
    var triVerts = new Uint32Array(n * 3);
    for (var i = 0; i < n * 3; i++) triVerts[i] = i;
    var mesh = new wasm.Mesh({ numProp: 3, vertProperties: vertProperties, triVerts: triVerts });
    mesh.merge();
    return new wasm.Manifold(mesh);
  }

  function manifoldToSoup(manifold) {
    var mesh = manifold.getMesh();
    var vp = mesh.vertProperties;
    var tv = mesh.triVerts;
    var numProp = mesh.numProp || 3;
    var out = new Float32Array(tv.length * 3);
    var w = 0;
    for (var t = 0; t < tv.length; t++) {
      var vi = tv[t] * numProp;
      out[w++] = vp[vi]; out[w++] = vp[vi + 1]; out[w++] = vp[vi + 2];
    }
    return out;
  }

  // Builds a solid box (as a real Manifold, via Manifold.cube) bounding the
  // region it's safe to cut into: from just outside the bit's own outer tip
  // (frame.capCoord, frame.axis/sign -- the bit's own local AABB, NOT the
  // hull's), inward along frame.punch, stopping `minWall` short of wherever
  // hull A's actual surface is found by ray-casting the real soup. This is
  // deliberately NOT based on frame.box for depth -- frame.box is the bit's
  // own bounding box (sized to the bit, ~mm), not the hull's, so it can't
  // tell us how thick the hull's wall actually is; only a real hit test
  // against aWorld can.
  // Samples 5 points across the bit's own footprint (center + 4 inset
  // corners) and takes the worst (shortest) safe depth, so a tilted or
  // uneven wall doesn't get punched through at one corner.
  // Returns a world-space Manifold, or null if the bit doesn't reach the
  // hull anywhere, or there's no room to cut within minWall.
  function buildCutVolume(wasm, frame, aWorld, minWall) {
    var axis = frame.axis, sign = frame.sign;
    var axB = (axis + 1) % 3, axC = (axis + 2) % 3;
    var box = frame.box; // bit's own local AABB -- used only for lateral (cross-section) sizing below

    var basisX = new THREE.Vector3(), basisY = new THREE.Vector3(), basisZ = new THREE.Vector3();
    frame.matrix.extractBasis(basisX, basisY, basisZ);
    var axisScale = [basisX, basisY, basisZ][axis].length() || 1; // local-unit -> world-mm for the punch axis

    var centerLocal = new THREE.Vector3();
    box.getCenter(centerLocal);
    centerLocal.setComponent(axis, frame.capCoord); // bit's own outer-tip face, centered on its cross-section

    var punch = frame.punch; // world unit vector, tip -> into the hull (already computed correctly upstream)
    var halfB = (box.max.getComponent(axB) - box.min.getComponent(axB)) / 2;
    var halfC = (box.max.getComponent(axC) - box.min.getComponent(axC)) / 2;
    var shrink = 0.85; // stay a little inboard of the bit's true edge for the probe rays
    var offsets = [
      [0, 0], [halfB * shrink, halfC * shrink], [halfB * shrink, -halfC * shrink],
      [-halfB * shrink, halfC * shrink], [-halfB * shrink, -halfC * shrink]
    ];

    var mouthPadWorld = Math.max(1, frame.span * 0.1);
    var lv = new THREE.Vector3(), wp = new THREE.Vector3();
    var minFarWorld = Infinity, anySample = false;

    for (var i = 0; i < offsets.length; i++) {
      lv.copy(centerLocal);
      lv.setComponent(axB, centerLocal.getComponent(axB) + offsets[i][0]);
      lv.setComponent(axC, centerLocal.getComponent(axC) + offsets[i][1]);
      wp.copy(lv).applyMatrix4(frame.matrix);
      var ox = wp.x - punch.x * mouthPadWorld, oy = wp.y - punch.y * mouthPadWorld, oz = wp.z - punch.z * mouthPadWorld;
      var hits = NSO_rayHitsSoup(aWorld, ox, oy, oz, punch.x, punch.y, punch.z);
      if (!hits.length) continue;
      var farWorld = hits[hits.length - 1] - mouthPadWorld; // distance from the tip (wp) to the far wall
      if (farWorld <= 0) continue;
      anySample = true;
      if (farWorld < minFarWorld) minFarWorld = farWorld;
    }

    if (!anySample) return null; // bit doesn't actually reach the hull anywhere along the punch direction

    var depthWorld = minFarWorld - minWall;
    if (depthWorld <= 0.2) return null; // no safe room to cut

    var depthLocal = depthWorld / axisScale;
    var mouthPadLocal = mouthPadWorld / axisScale;

    var lo = new THREE.Vector3(), hi = new THREE.Vector3();
    var lateralPad = Math.max(0.5, frame.span * 0.05);
    lo.setComponent(axB, box.min.getComponent(axB) - lateralPad);
    hi.setComponent(axB, box.max.getComponent(axB) + lateralPad);
    lo.setComponent(axC, box.min.getComponent(axC) - lateralPad);
    hi.setComponent(axC, box.max.getComponent(axC) + lateralPad);

    var outerLocal = frame.capCoord + sign * mouthPadLocal;   // just outside the bit's own tip
    var innerLocal = frame.capCoord - sign * depthLocal;      // depthWorld into the hull, minWall short of its far wall
    if (sign > 0) { lo.setComponent(axis, innerLocal); hi.setComponent(axis, outerLocal); }
    else { lo.setComponent(axis, outerLocal); hi.setComponent(axis, innerLocal); }

    var size = new THREE.Vector3().subVectors(hi, lo);
    var center = new THREE.Vector3().addVectors(lo, hi).multiplyScalar(0.5);
    var localTranslate = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
    var worldMat = frame.matrix.clone().multiply(localTranslate);

    var cube = wasm.Manifold.cube([Math.max(size.x, 1e-3), Math.max(size.y, 1e-3), Math.max(size.z, 1e-3)], true);
    return cube.transform(Array.from(worldMat.elements));
  }

  return {
    load: load,
    soupToManifold: soupToManifold,
    manifoldToSoup: manifoldToSoup,
    buildCutVolume: buildCutVolume
  };
})();

// Möller-Trumbore ray/triangle-soup intersection. Returns sorted hit
// distances (t along the ray from origin, direction assumed unit length)
// for every triangle the ray crosses -- used to find where a punch ray
// actually enters/exits hull A's real surface, in place of any bounding
// box guess.
function NSO_rayHitsSoup(soup, ox, oy, oz, dx, dy, dz) {
  var hits = [];
  var n = (soup.length / 9) | 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
    var cx = soup[o + 6], cy = soup[o + 7], cz = soup[o + 8];
    var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    var pvx = dy * e2z - dz * e2y, pvy = dz * e2x - dx * e2z, pvz = dx * e2y - dy * e2x;
    var det = e1x * pvx + e1y * pvy + e1z * pvz;
    if (Math.abs(det) < 1e-9) continue;
    var invDet = 1 / det;
    var tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
    var u = (tvx * pvx + tvy * pvy + tvz * pvz) * invDet;
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    var qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
    var v = (dx * qvx + dy * qvy + dz * qvz) * invDet;
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    var tt = (e2x * qvx + e2y * qvy + e2z * qvz) * invDet;
    if (tt > 1e-6) hits.push(tt);
  }
  hits.sort(function (a, b) { return a - b; });
  return hits;
}

function NSO_errMsg(err) {
  return (err && err.message) ? String(err.message) : String(err);
}

// Open-edge / non-manifold-edge counts for a triangle soup. Vertex welding
// is by coordinate rounding (0.1 micron buckets), not topology -- this is a
// diagnostic count for the status line, not a watertight/valid claim.
function NSO_edgeStats(soup) {
  var n = (soup.length / 9) | 0;
  var q = 1e4;
  function key(o) {
    return Math.round(soup[o] * q) + '_' + Math.round(soup[o + 1] * q) + '_' + Math.round(soup[o + 2] * q);
  }
  var map = new Map();
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var k = [key(o), key(o + 3), key(o + 6)];
    for (var e = 0; e < 3; e++) {
      var a = k[e], b = k[(e + 1) % 3];
      var ek = a < b ? (a + '|' + b) : (b + '|' + a);
      map.set(ek, (map.get(ek) || 0) + 1);
    }
  }
  var open = 0, nm = 0;
  map.forEach(function (count) {
    if (count === 1) open++;
    else if (count > 2) nm++;
  });
  return { open: open, nm: nm };
}

/* =====================================================================
   REPLACEMENT: subtractSoupBFromA
   Was: homemade ray/AABB pocket clipper (centroid filter + wall raycast).
   Now: real solid boolean via Manifold. Async (WASM load + compute).
   Same fail-safe contract: any failure returns { ok:false, soup: aWorld },
   caller leaves A untouched.
   ===================================================================== */
async function subtractSoupBFromA(aWorld, bWorld, opts) {
  opts = opts || {};
  var na = NSO_soupLen(aWorld), nb = NSO_soupLen(bWorld);
  if (!na || !nb) return { ok: false, soup: aWorld, reason: 'empty soup' };

  var frame = opts.plugFrame || null;
  if (!frame) return { ok: false, soup: aWorld, reason: 'no plug frame (bit not oriented against hull)' };

  var minWall = (opts.minWall === undefined) ? 1.0 : opts.minWall;
  var before = NSO_edgeStats(aWorld);

  var wasm;
  try {
    wasm = await NSO_CSG.load();
  } catch (err) {
    return { ok: false, soup: aWorld, mode: 'manifold', reason: 'CSG kernel failed to load: ' + NSO_errMsg(err) };
  }

  var manA = null, manB = null, safetyBox = null, bClipped = null, result = null;
  try {
    var aIn = aWorld, bIn = bWorld;
    if (typeof weldSoupVerts === 'function') {
      try { aIn = weldSoupVerts(aWorld, 0.08); } catch (e0) { aIn = aWorld; }
      try { bIn = weldSoupVerts(bWorld, 0.08); } catch (e1) { bIn = bWorld; }
    }
    try { manA = NSO_CSG.soupToManifold(wasm, aIn); }
    catch (eA) { throw new Error('hull rejected: ' + ((eA && eA.message) ? eA.message : eA)); }
    if (manA.status && manA.status() !== 'NoError') throw new Error('hull rejected: ' + manA.status());

    try { manB = NSO_CSG.soupToManifold(wasm, bIn); }
    catch (eB) { throw new Error('bit rejected: ' + ((eB && eB.message) ? eB.message : eB)); }
    if (manB.status && manB.status() !== 'NoError') throw new Error('bit rejected: ' + manB.status());

    safetyBox = NSO_CSG.buildCutVolume(wasm, frame, aWorld, minWall);
    if (!safetyBox) throw new Error('bit does not reach hull A along the punch direction, or no room within minWall');

    bClipped = manB.intersect(safetyBox);
    if (bClipped.isEmpty()) throw new Error('bit does not reach hull within safe wall margin');

    result = manA.subtract(bClipped);
    if (result.status() !== 'NoError') throw new Error('subtract rejected by kernel: ' + result.status());
    if (result.isEmpty()) throw new Error('subtract produced empty solid');

    // No-op guard: a "successful" boolean that removed ~nothing (e.g. the
    // bit doesn't actually touch the hull's outer skin, so the safety-box
    // clip missed it) must NOT be reported as ok -- that would let the
    // caller delete B and leave A silently unchanged. Compare solid
    // volume, not triangle count (retriangulation can shuffle tri count
    // even on a true no-op).
    var volBefore = manA.volume();
    var volAfter = result.volume();
    var removedVol = volBefore - volAfter;
    var noopEps = Math.max(1e-3, volBefore * 1e-4); // absolute floor + 0.01% of hull volume
    if (removedVol <= noopEps) {
      throw new Error('removed ~0 volume (' + removedVol.toFixed(4) +
        ' mm^3) -- bit likely does not touch the hull skin; check placement');
    }

    var outTris = result.numTri();
    var soup = NSO_CSG.manifoldToSoup(result);
    var after = NSO_edgeStats(soup);

    console.log('[subtract] kernel=manifold tris', manA.numTri(), '->', outTris,
      'open', before.open, '->', after.open, 'nonManifold', before.nm, '->', after.nm);

    return {
      ok: true,
      soup: soup,
      mode: 'manifold',
      hullTris: outTris,
      openBefore: before.open, nmBefore: before.nm,
      openAfter: after.open, nmAfter: after.nm
    };
  } catch (err) {
    var why = NSO_errMsg(err);
    console.warn('[subtract] failed:', why);
    return { ok: false, soup: aWorld, mode: 'manifold', reason: why };
  } finally {
    if (manA) manA.delete();
    if (manB) manB.delete();
    if (safetyBox) safetyBox.delete();
    if (bClipped) bClipped.delete();
    if (result) result.delete();
  }
}

/* =====================================================================
   REPLACEMENT: subtractBFromA
   Same selection checks, same undo shape (subtractReplace), same mesh
   swap/cleanup as before. Only change: awaits the now-async subtract,
   and the status/log line reflects open-edge/NM counts instead of the
   old wall-clearance readout.
   ===================================================================== */
async function subtractBFromA() {
  if (typeof removeFaceHelper === 'function') removeFaceHelper();
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (idA == null || idB == null || idA === idB) {
    setStatus('Select hull A and bit B', true);
    return;
  }
  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  if (!modelA || !modelB) {
    setStatus('Select hull A and bit B', true);
    return;
  }
  const placedA = state.placed.find(p => p && p.sourceId === idA);
  const placedB = state.placed.find(p => p && p.sourceId === idB);
  if (!placedA || !placedB || !placedA.mesh || !placedB.mesh) {
    setStatus('Select hull A and bit B', true);
    return;
  }

  let newGeo = null;
  try {
    placedA.mesh.updateMatrixWorld(true);
    placedB.mesh.updateMatrixWorld(true);
    const aWorld = meshToWorldSoup(placedA.mesh);
    const bWorld = meshToWorldSoup(placedB.mesh);
    placedA.mesh.updateMatrixWorld(true);
    if (!placedA.mesh.geometry.boundingBox) placedA.mesh.geometry.computeBoundingBox();
    const hullCenter = new THREE.Vector3();
    placedA.mesh.geometry.boundingBox.getCenter(hullCenter);
    hullCenter.applyMatrix4(placedA.mesh.matrixWorld);
    const frame = NSO_plugFrame(placedB.mesh, hullCenter, aWorld);

    setStatus('Subtracting (loading CSG kernel)...');
    const res = await subtractSoupBFromA(aWorld, bWorld, {
      plugFrame: frame,
      minWall: 1.0
    });
    if (!res || !res.ok || !res.soup || res.soup.length < 9) {
      throw new Error((res && res.reason) ? res.reason : 'result empty');
    }
    newGeo = soupToCenteredGeo(res.soup);
    window.__nestSubtractMsg = 'Subtract ok - open edges ' +
      res.openBefore + '→' + res.openAfter +
      ', non-manifold ' + res.nmBefore + '→' + res.nmAfter;
  } catch (err) {
    const why = (err && err.message) ? String(err.message) : 'unknown';
    console.warn('[subtract] failed:', why);
    setStatus('Subtract failed - ' + why, true);
    return;
  }

  pushUndo({
    type: 'subtractReplace',
    aId: idA,
    aPrevGeometry: modelA.geometry.clone(),
    aPrevRawTris: modelA.rawTris,
    aPrevRawAxis: modelA.rawAxis,
    aPrevCenterOffset: modelA.centerOffset,
    aPrevSize: { x: modelA.size.x, y: modelA.size.y, z: modelA.size.z },
    bSnapshot: {
      id: modelB.id,
      name: modelB.name,
      geometry: modelB.geometry.clone(),
      quantity: modelB.quantity || 1,
      size: { x: modelB.size.x, y: modelB.size.y, z: modelB.size.z },
      orientedGeometry: null,
      rawTris: modelB.rawTris || null,
      rawAxis: modelB.rawAxis || null,
      centerOffset: modelB.centerOffset || null
    },
    poseB: { x: placedB.x, z: placedB.z },
    placedBIndex: state.placed.indexOf(placedB)
  });

  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  const rawOut = displayGeometryToRawSoup(newGeo);

  modelA.geometry = newGeo;
  modelA.rawTris = rawOut;
  modelA.rawAxis = 'zup';
  modelA.centerOffset = computeCenterOffsetFromRaw(rawOut);
  modelA.size = { x: size2.x, y: size2.y, z: size2.z };

  state.models = state.models.filter(x => x.id !== idB);
  if (placedB.mesh && state.modelGroup) {
    state.modelGroup.remove(placedB.mesh);
    if (placedB.mesh.material) {
      if (Array.isArray(placedB.mesh.material)) placedB.mesh.material.forEach(mt => mt.dispose());
      else placedB.mesh.material.dispose();
    }
  }
  state.placed = state.placed.filter(p => p !== placedB);
  reindexPlacedMeshes();

  state.joinPartnerId = null;
  state.joinSession = false;
  state.joinArmed = null;

  if (placedA.mesh && state.modelGroup) {
    state.modelGroup.remove(placedA.mesh);
    if (placedA.mesh.material) {
      if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
      else placedA.mesh.material.dispose();
    }
  }
  const mat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
    emissive: 0x0a3a5c, emissiveIntensity: 0.25
  });
  const mesh = new THREE.Mesh(modelA.geometry, mat);
  mesh.position.set(placedA.x, modelA.size.y / 2 + 0.3, placedA.z);
  mesh.userData.sourceId = modelA.id;
  mesh.userData.placedIndex = state.placed.indexOf(placedA);
  state.modelGroup.add(mesh);
  placedA.mesh = mesh;
  placedA.geometry = modelA.geometry;
  placedA.width = modelA.size.x;
  placedA.depth = modelA.size.z;
  placedA.height = modelA.size.y;

  updateEditSize();
  renderModelList();
  updateAdjustUI();
  updateUndoBtn();
  removeFaceHelper();
  updateJoinUI();
  setStatus(window.__nestSubtractMsg || 'Subtract ok');
}

function centerJoinAxis(axis) {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Start Join, Pick A and B, then Center', true);
    return;
  }
  const placedA = state.placed.find(function (q) { return q && q.sourceId === idA && q.mesh; });
  const placedB = state.placed.find(function (q) { return q && q.sourceId === idB && q.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both pieces must be on the plate', true);
    return;
  }
  placedA.mesh.updateMatrixWorld(true);
  placedB.mesh.updateMatrixWorld(true);
  const ba = meshLocalBox3(placedA.mesh);
  const bb = meshLocalBox3(placedB.mesh);
  const cax = (ba.min.x + ba.max.x) / 2;
  const caz = (ba.min.z + ba.max.z) / 2;
  const cbx = (bb.min.x + bb.max.x) / 2;
  const cbz = (bb.min.z + bb.max.z) / 2;
  const punchIsX = Math.abs(cbx - cax) >= Math.abs(cbz - caz);
  if (axis === 'x' && punchIsX) {
    setStatus('Center X would pull the plug into the hull - use Center Z on this face', true);
    return;
  }
  if (axis === 'z' && !punchIsX) {
    setStatus('Center Z would pull the plug into the hull - use Center X on this face', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  let nx = placedB.x, nz = placedB.z;
  if (axis === 'x') nx += (cax - cbx);
  else nz += (caz - cbz);
  applyPlacedXZ(placedB, nx, nz);
  setStatus(axis === 'x' ? 'Centered on face X' : 'Centered on face Z');
}


function flipPortOnPunch() {
  const placedB = state.placed.find(p => p && p.sourceId === state.joinPartnerId);
  const placedA = state.placed.find(p => p && p.sourceId === state.editId);
  const bit = placedB && placedB.mesh;
  const hull = placedA && placedA.mesh;
  if (!bit || !hull) {
    setStatus('Start Join, pick hull A and tunnel B, then Flip port', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  hull.updateMatrixWorld(true);
  bit.updateMatrixWorld(true);
  const hc = new THREE.Vector3();
  if (!hull.geometry.boundingBox) hull.geometry.computeBoundingBox();
  hull.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(hull.matrixWorld);
  const aWorld = (typeof meshToWorldSoup === 'function') ? meshToWorldSoup(placedA) : null;
  const frame = NSO_plugFrame(bit, hc, aWorld);
  const axis = frame.outerNormal && frame.outerNormal.lengthSq() > 1e-8
    ? frame.outerNormal.clone().normalize()
    : new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI);
  bit.quaternion.premultiply(q);
  bit.updateMatrixWorld(true);
  if (placedB.rotY == null) placedB.rotY = 0;
  setStatus('Port flipped 180 on punch - Seat flush again');
}

function seatFlushBitToHull() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Start Join, A = hull, B = bit, then Seat flush', true);
    return;
  }
  const placedA = state.placed.find(function (p) { return p && p.sourceId === idA && p.mesh; });
  const placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
  if (!placedA || !placedB) {
    setStatus('Both hull and bit must be on the plate', true);
    return;
  }
  pushUndo(snapshotPlacedPose(state.placed.indexOf(placedB)));
  const res = NSO_seatFlushBitToHull(placedA.mesh, placedB.mesh, { proud: 0.4 });
  if (!res || !res.ok) {
    setStatus('Seat failed - ' + ((res && res.reason) || 'pieces unchanged'), true);
    return;
  }
  placedB.x = placedB.mesh.position.x;
  placedB.z = placedB.mesh.position.z;
  const baseY = (placedB.height || placedB.mesh.geometry.boundingBox && (placedB.mesh.geometry.boundingBox.max.y - placedB.mesh.geometry.boundingBox.min.y) || 10) / 2 + 0.2;
  placedB.liftY = Math.max(0, placedB.mesh.position.y - baseY);
  applyPlacedXZ(placedB, placedB.x, placedB.z);
  setStatus('Seated on skin - bit crosses wall, then Subtract');
}



function soupAxisBox(min, max) {
  const x0 = min.x, y0 = min.y, z0 = min.z;
  const x1 = max.x, y1 = max.y, z1 = max.z;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [5, 4, 7, 5, 7, 6],
    [4, 0, 3, 4, 3, 7],
    [1, 5, 6, 1, 6, 2],
    [3, 2, 6, 3, 6, 7],
    [4, 5, 1, 4, 1, 0]
  ];
  const out = [];
  for (let f = 0; f < faces.length; f++) {
    const idx = faces[f];
    for (let k = 0; k < 6; k++) {
      const pt = v[idx[k]];
      out.push(pt[0], pt[1], pt[2]);
    }
  }
  return new Float32Array(out);
}

// New helper: 6-connected flood fill over the empty-cell grid, returns the
// largest connected empty region as index-space min/max (or null if the
// grid has no empty cells at all).
function NSO_floodFillLargestEmptyCluster(empty, nx, ny, nz) {
  const total = nx * ny * nz;
  const visited = new Uint8Array(total);
  const stackX = new Int32Array(total);
  const stackY = new Int32Array(total);
  const stackZ = new Int32Array(total);
  const idx3 = function (ix, iy, iz) { return (ix * ny + iy) * nz + iz; };

  let best = null;

  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const startIdx = idx3(ix, iy, iz);
        if (!empty[startIdx] || visited[startIdx]) continue;

        let sp = 0;
        stackX[sp] = ix; stackY[sp] = iy; stackZ[sp] = iz; sp++;
        visited[startIdx] = 1;

        let size = 0;
        let minIx = ix, minIy = iy, minIz = iz;
        let maxIx = ix, maxIy = iy, maxIz = iz;

        while (sp > 0) {
          sp--;
          const cx = stackX[sp], cy = stackY[sp], cz = stackZ[sp];
          size++;
          if (cx < minIx) minIx = cx; if (cx > maxIx) maxIx = cx;
          if (cy < minIy) minIy = cy; if (cy > maxIy) maxIy = cy;
          if (cz < minIz) minIz = cz; if (cz > maxIz) maxIz = cz;

          if (cx > 0) { const n = idx3(cx - 1, cy, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx - 1; stackY[sp] = cy; stackZ[sp] = cz; sp++; } }
          if (cx < nx - 1) { const n = idx3(cx + 1, cy, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx + 1; stackY[sp] = cy; stackZ[sp] = cz; sp++; } }
          if (cy > 0) { const n = idx3(cx, cy - 1, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy - 1; stackZ[sp] = cz; sp++; } }
          if (cy < ny - 1) { const n = idx3(cx, cy + 1, cz); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy + 1; stackZ[sp] = cz; sp++; } }
          if (cz > 0) { const n = idx3(cx, cy, cz - 1); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy; stackZ[sp] = cz - 1; sp++; } }
          if (cz < nz - 1) { const n = idx3(cx, cy, cz + 1); if (empty[n] && !visited[n]) { visited[n] = 1; stackX[sp] = cx; stackY[sp] = cy; stackZ[sp] = cz + 1; sp++; } }
        }

        if (!best || size > best.size) {
          best = { size: size, minIx: minIx, minIy: minIy, minIz: minIz, maxIx: maxIx, maxIy: maxIy, maxIz: maxIz };
        }
      }
    }
  }

  return best;
}

function extractBitFromSelected() {
  const p = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
  const model = p && p.sourceId != null
    ? state.models.find(function (m) { return m.id === p.sourceId; })
    : getActiveModel();
  if (!p || !p.mesh || !model || !model.geometry) {
    setStatus('Select a tile on the plate first', true);
    return;
  }
  const py = p.mesh.position.y;
  const soupPiece = geomToWorldSoup(model.geometry, p.x, py, p.z);
  if (!soupPiece || soupPiece.length < 9) {
    setStatus('Extract failed - piece unchanged', true);
    return;
  }
  p.mesh.updateMatrixWorld(true);
  const bb = meshLocalBox3(p.mesh);
  const inset = 0.45;
  const x0 = bb.min.x + inset, x1 = bb.max.x - inset;
  const y0 = bb.min.y + inset, y1 = bb.max.y - inset;
  const z0 = bb.min.z + inset, z1 = bb.max.z - inset;
  if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
    setStatus('Extract failed - tile too thin', true);
    return;
  }

  // Same sampling grid as before - cell centers on the 1.2mm lattice.
  const step = 1.2;
  const half = step * 0.49;
  const xs = [];
  for (let x = x0 + half; x <= x1 - half + 1e-6; x += step) xs.push(x);
  const ys = [];
  for (let y = y0 + half; y <= y1 - half + 1e-6; y += step) ys.push(y);
  const zs = [];
  for (let z = z0 + half; z <= z1 - half + 1e-6; z += step) zs.push(z);
  const nx = xs.length, ny = ys.length, nz = zs.length;
  if (nx < 1 || ny < 1 || nz < 1) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  const empty = new Uint8Array(nx * ny * nz);
  let emptyCount = 0;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        if (!NSO_pointInsideSoup(soupPiece, xs[ix], ys[iy], zs[iz])) {
          empty[(ix * ny + iy) * nz + iz] = 1;
          emptyCount++;
        }
      }
    }
  }
  if (emptyCount < 4) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  // Flood-fill (6-connected) to the single largest empty region - this is
  // the fix: no more one cube per empty cell.
  const cluster = NSO_floodFillLargestEmptyCluster(empty, nx, ny, nz);
  if (!cluster || cluster.size < 4) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  // One box spanning the cluster's cell extents.
  const mn = {
    x: xs[cluster.minIx] - half,
    y: ys[cluster.minIy] - half,
    z: zs[cluster.minIz] - half
  };
  const mx = {
    x: xs[cluster.maxIx] + half,
    y: ys[cluster.maxIy] + half,
    z: zs[cluster.maxIz] + half
  };

  const bitSoup = soupAxisBox(mn, mx);
  if (!bitSoup || bitSoup.length < 9) {
    setStatus('Extract failed - no cavity found', true);
    return;
  }

  const geo = soupToCenteredGeo(bitSoup);
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const rawOut = displayGeometryToRawSoup(geo);
  const id = addModel((model.name || 'tile') + '-bit', geo, {
    rawTris: rawOut,
    rawAxis: 'zup',
    centerOffset: computeCenterOffsetFromRaw(rawOut),
    keepSelection: true,
    silent: true
  });
  if (!id) {
    setStatus('Extract failed - piece unchanged', true);
    return;
  }
  pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
  const xPlace = p.x + (p.width || size.x) / 2 + size.x / 2 + 6;
  const m = state.models.find(function (mm) { return mm.id === id; });
  if (m) placeModelMovable(m, xPlace, p.z);
  setStatus('Extract bit ok - solid ' + size.x.toFixed(1) + 'x' + size.y.toFixed(1) + 'x' + size.z.toFixed(1) + ' mm');
}

function joinSelectedModels() {
  const idA = state.editId;
  const idB = state.joinPartnerId;
  if (!state.joinSession || idA == null || idB == null || idA === idB) {
    setStatus('Start Join, Pick A, Pick B, then Complete Join', true);
    return;
  }
  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  if (!modelA || !modelB) {
    setStatus('Select two pieces to join', true);
    return;
  }

  const placedA = state.placed.find(p => p && p.sourceId === idA);
  const placedB = state.placed.find(p => p && p.sourceId === idB);
  const poseA = placedA ? { x: placedA.x, z: placedA.z } : { x: 0, z: 0 };
  const poseB = placedB ? { x: placedB.x, z: placedB.z } : { x: 0, z: 0 };

  // Join axis/direction from current plate positions — X is the axis
  // Split itself always uses to lay pieces out, so this matches every
  // real scenario (rejoining halves, attaching a stored end to a bar).
  let newGeo = null;
  try {
    if (placedA && placedB) {
      const yA = placedA.mesh ? placedA.mesh.position.y : 0;
      const yB = placedB.mesh ? placedB.mesh.position.y : 0;
      const seated = Math.abs(yA - yB) > 3.5;
      if (seated && typeof meshToWorldSoup === 'function') {
        const sa = meshToWorldSoup(placedA);
        const sb = meshToWorldSoup(placedB);
        if (!sa || !sb || sa.length < 9 || sb.length < 9) throw new Error('in-place join empty soup');
        let merged = new Float32Array(sa.length + sb.length);
        merged.set(sa, 0);
        merged.set(sb, sa.length);
        if (typeof weldSoupVerts === 'function') merged = weldSoupVerts(merged, 0.22);
        if (typeof repairJoinedSoup === 'function') merged = repairJoinedSoup(merged);
        if (!merged || merged.length < 9) throw new Error('in-place join empty');
        newGeo = soupToCenteredGeo(merged);
        console.log('[join] in-place weld (seated port)');
      } else {
        const axisName = detectMateAxis(placedA, placedB);
        const axisIdx = axisName === 'z' ? 2 : 0;
        newGeo = joinHalvesOnPlate(modelA, placedA, modelB, placedB, axisIdx);
      }
    } else {
      const aIsMin = poseA.x <= poseB.x;
      const rawA = getModelRawSoup(modelA);
      const rawB = getModelRawSoup(modelB);
      const joinedRaw = rawJoinPieces(aIsMin ? rawA : rawB, aIsMin ? rawB : rawA, 0);
      newGeo = rawResultToDisplayGeometry(joinedRaw);
    }
  } catch (err) {
    console.warn('[join] failed:', err.message);
    setStatus('Join failed - ' + (err && err.message ? err.message : 'pieces unchanged'), true);
    return;
  }

  // Snapshot BOTH pieces (full state, including plate pose) before
  // mutating anything, so Undo can fully restore two separate pieces.
  pushUndo({
    type: 'joinReplace',
    aId: idA,
    aPrevGeometry: modelA.geometry.clone(),
    aPrevRawTris: modelA.rawTris,
    aPrevRawAxis: modelA.rawAxis,
    aPrevCenterOffset: modelA.centerOffset,
    aPrevSize: { x: modelA.size.x, y: modelA.size.y, z: modelA.size.z },
    bSnapshot: {
      id: modelB.id,
      name: modelB.name,
      geometry: modelB.geometry.clone(),
      quantity: modelB.quantity || 1,
      size: { x: modelB.size.x, y: modelB.size.y, z: modelB.size.z },
      orientedGeometry: null,
      rawTris: modelB.rawTris || null,
      rawAxis: modelB.rawAxis || null,
      centerOffset: modelB.centerOffset || null
    },
    poseB: poseB,
    placedBIndex: placedB ? state.placed.indexOf(placedB) : -1
  });

  newGeo.computeBoundingBox();
  const size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);
  const joinedRaw = displayGeometryToRawSoup(newGeo);

  modelA.geometry = newGeo;
  modelA.rawTris = joinedRaw;
  modelA.rawAxis = 'zup';
  modelA.centerOffset = computeCenterOffsetFromRaw(joinedRaw);
  modelA.size = { x: size2.x, y: size2.y, z: size2.z };

  // Remove B from the library and the plate.
  state.models = state.models.filter(x => x.id !== idB);
  if (placedB) {
    if (placedB.mesh && state.modelGroup) {
      state.modelGroup.remove(placedB.mesh);
      if (placedB.mesh.material) {
        if (Array.isArray(placedB.mesh.material)) placedB.mesh.material.forEach(mt => mt.dispose());
        else placedB.mesh.material.dispose();
      }
    }
    state.placed = state.placed.filter(p => p !== placedB);
    reindexPlacedMeshes();
  }
  state.joinPartnerId = null;
  state.joinSession = false;
  state.joinArmed = null;

  // Park the union at the midpoint of the two halves.
  if (placedA) {
    const px = (poseA.x + poseB.x) / 2;
    const pz = (poseA.z + poseB.z) / 2;
    placedA.x = px;
    placedA.z = pz;
    if (placedA.mesh && state.modelGroup) {
      state.modelGroup.remove(placedA.mesh);
      if (placedA.mesh.material) {
        if (Array.isArray(placedA.mesh.material)) placedA.mesh.material.forEach(mt => mt.dispose());
        else placedA.mesh.material.dispose();
      }
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    const mesh = new THREE.Mesh(modelA.geometry, mat);
    mesh.position.set(px, modelA.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = modelA.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedA);
    state.modelGroup.add(mesh);
    placedA.mesh = mesh;
    placedA.geometry = modelA.geometry;
    placedA.width = modelA.size.x;
    placedA.depth = modelA.size.z;
    placedA.height = modelA.size.y;
  } else if (state.cutterOpen) {
    showEditPreview();
  }

  updateEditSize();
  renderModelList();
  updateAdjustUI();
  updateUndoBtn();
  removeFaceHelper();
  setStatus('Join ok');
}


function splitBothSides(model, axis, leftPlane, rightPlane) {
  const alreadySplit = /-[AB]\d+$/i.test(model.name || '');
  // 2nd+ cuts: clip the DISPLAY mesh at the slider plane. Raw mapping on a
  // half still in original-file coordinates misses the plane and looks like
  // "Split does nothing."
  if (!alreadySplit && model.rawTris && model.rawAxis === 'zup' && model.centerOffset) {
    try {
      const mapL = mapPlaneToRaw(model, axis, leftPlane, true);
      const mapR = mapPlaneToRaw(model, axis, rightPlane, false);
      if (!mapL || !mapR) throw new Error('no raw mapping');
      const rawL = rawCut(model.rawTris, mapL.axisIdx, mapL.plane, mapL.keepMin);
      const rawR = rawCut(model.rawTris, mapR.axisIdx, mapR.plane, mapR.keepMin);
      if (!rawL || !rawR) throw new Error('rawCut empty side');
      return {
        left: rawResultToDisplayGeometry(rawL, model.centerOffset),
        right: rawResultToDisplayGeometry(rawR, model.centerOffset),
        engine: 'raw',
        rawA: rawL,
        centerOffsetA: computeCenterOffsetFromRaw(rawL),
        rawB: rawR,
        centerOffsetB: computeCenterOffsetFromRaw(rawR)
      };
    } catch (err) {
      console.warn('[rawCut] fallback to display clip:', err.message);
    }
  }
  return {
    left: clipGeometrySide(model.geometry, axis, leftPlane, true),
    right: clipGeometrySide(model.geometry, axis, rightPlane, false),
    engine: 'display'
  };
}

function cutActiveModel() {
  try {
  if (!state.cutterOpen) {
    setStatus('Open cutter first', true);
    return;
  }
  const m = getActiveModel();
  if (!m) {
    setStatus('Load an STL first', true);
    return;
  }
  const info = getCutPlaneForSplit(m);
  if (!info) {
    setStatus('Cannot resolve cut plane - reopen cutter', true);
    return;
  }
  const axis = info.axis;
  const plateAxis = info.plateAxis || axis;
  const span = info.span;
  const plane = info.plane;
  // Distance from min end - must match readout
  const cutMm = (plane - info.origin);
  if (span < MIN_CUT_SIDE_MM * 2) {
    setStatus('Piece too short to cut (need >= ' + (MIN_CUT_SIDE_MM * 2) + ' mm along cut axis)', true);
    return;
  }
  if (cutMm < MIN_CUT_SIDE_MM || cutMm > span - MIN_CUT_SIDE_MM) {
    setStatus('Keep >= ' + MIN_CUT_SIDE_MM + ' mm on each side of the red plane', true);
    return;
  }
  // Kerf band centered on red line - middle slab discarded so halves have a real gap
  const halfKerf = KERF_MM * 0.5;
  const leftPlane = plane - halfKerf;
  const rightPlane = plane + halfKerf;
  const pair = splitBothSides(m, axis, leftPlane, rightPlane);
  const left = pair.left;
  const right = pair.right;
  if (!left || !right) {
    setStatus('Cut produced an empty side - nudge the plane and retry', true);
    return;
  }

  function measure(geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    const along = axis === 'x' ? sx : axis === 'y' ? sy : sz;
    return { sx, sy, sz, along };
  }
  const mL = measure(left);
  const mR = measure(right);
  if (mL.along < 0.5 || mR.along < 0.5) {
    setStatus('Cut would leave a speck - move the red plane', true);
    return;
  }
  if (mL.sx < 0.4 || mL.sy < 0.4 || mL.sz < 0.4 || mR.sx < 0.4 || mR.sy < 0.4 || mR.sz < 0.4) {
    setStatus('Cut produced a degenerate sliver - try a different plane position', true);
    return;
  }

  left.computeBoundingBox();
  right.computeBoundingBox();
  const stayA = left.boundingBox.getCenter(new THREE.Vector3());
  const stayB = right.boundingBox.getCenter(new THREE.Vector3());
  left.center();
  right.center();
  left.computeBoundingBox();
  right.computeBoundingBox();

  const tag = Math.round(cutMm);
  const baseName = String(m.name).replace(/-[AB]\d+$/i, '');
  const nameA = baseName + '-A' + tag;
  const nameB = baseName + '-B' + tag;
  const prevEditId = state.editId;
  const prevCutT = state.cutT;
  const sourceId = m.id;

  const poseById = {};
  (state.placed || []).forEach(function (pl) {
    if (pl && pl.sourceId != null) {
      poseById[pl.sourceId] = {
        x: pl.x, z: pl.z,
        rotY: pl.rotY || 0,
        flipX: !!pl.flipX,
        tipX: pl.tipX || 0,
        tipZ: pl.tipZ || 0,
        tiltX: pl.tiltX || 0,
        tiltZ: pl.tiltZ || 0,
        liftY: pl.liftY || 0
      };
    }
  });
  const sourcePose = poseById[sourceId] || { x: 0, z: 0 };

  // One piece -> two pieces. No leftover original copy.
  const sourceSnapshot = {
    id: m.id,
    name: m.name,
    geometry: m.geometry.clone(),
    quantity: m.quantity || 1,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    orientedGeometry: null,
    // Carry the parent's raw data forward so Undo restores a model that can
    // still Split with the raw engine, not just its display geometry.
    rawTris: m.rawTris || null,
    rawAxis: m.rawAxis || null,
    centerOffset: m.centerOffset || null,
    plateX: sourcePose.x,
    plateZ: sourcePose.z
  };
  const siblingSnapshots = state.models
    .filter(x => x.id !== sourceId)
    .map(function (sib) {
      const pose = poseById[sib.id] || { x: 0, z: 0 };
      return {
        id: sib.id,
        name: sib.name,
        geometry: sib.geometry,
        quantity: sib.quantity || 1,
        size: sib.size ? { x: sib.size.x, y: sib.size.y, z: sib.size.z } : { x: 1, y: 1, z: 1 },
        orientedGeometry: null,
        rawTris: sib.rawTris || null,
        rawAxis: sib.rawAxis || null,
        centerOffset: sib.centerOffset || null,
        plateX: pose.x,
        plateZ: pose.z
      };
    });
  // Remove original FIRST
  state.models = state.models.filter(x => x.id !== sourceId);
  state.editId = null;

  const halfOptsA = pair.engine === 'raw'
    ? { keepSelection: true, silent: true, rawTris: pair.rawA, rawAxis: 'zup', centerOffset: pair.centerOffsetA }
    : { keepSelection: true, silent: true };
  const halfOptsB = pair.engine === 'raw'
    ? { keepSelection: true, silent: true, rawTris: pair.rawB, rawAxis: 'zup', centerOffset: pair.centerOffsetB }
    : { keepSelection: true, silent: true };
  const idA = addModel(nameA, left, halfOptsA);
  const idB = addModel(nameB, right, halfOptsB);
  const newIds = [idA, idB].filter(x => x != null);
  if (newIds.length < 2) {
    // Roll back if halves failed to add
    state.models.push(sourceSnapshot);
    state.editId = sourceSnapshot.id;
    setStatus('Split failed to create both halves - original restored', true);
    return;
  }

  pushUndo({
    type: 'splitReplace',
    source: sourceSnapshot,
    newIds: newIds.slice(),
    siblings: siblingSnapshots,
    editId: prevEditId,
    cutT: prevCutT
  });
  console.log('[nest] split undo pushed', state.undoStack.length, newIds);

  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  const sizeA = modelA ? (axis === 'x' ? modelA.size.x : modelA.size.z) : 0;
  const sizeB = modelB ? (axis === 'x' ? modelB.size.x : modelB.size.z) : 0;
  state.selectedIndex = -1;
  state.joinPartnerId = null;
  state.joinSession = false;
  state.joinArmed = null;
  state.cutT = 0.5;
  renderModelList();
  updateEditSize();
  updateOptimizeButton();

  // Close cutter view and show BOTH halves on the plate with a visible gap
  // Keep cutter open so the other piece can be selected without Close.
  // Helper moves when the user clicks a piece.
  state.cutterOpen = true;
  removeCutHelper();
  state.previewMesh = null;
  layoutAfterSplit(sourcePose, poseById, sourceId, modelA, modelB, plateAxis, stayA, stayB);
  state.cutterOpen = true;
  state.editId = null;
  removeCutHelper();
  state.previewMesh = null;
  if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
  if (typeof paintJoinHighlights === 'function') paintJoinHighlights();
  updateCutterUI();
  updateUndoBtn();

  const sum = mL.along + mR.along;
  const loss = span - sum;
  setStatus(
    'Cut @ ' + cutMm.toFixed(1) + ' mm (kerf ' + KERF_MM + ' mm) -> ' +
    nameA + ' ' + mL.along.toFixed(1) + ' mm + ' + nameB + ' ' + mR.along.toFixed(1) +
    ' mm [' + pair.engine + ']. List: ' + state.models.length + ' models. Undo: ' + state.undoStack.length + '.' +
    (Math.abs(loss) > KERF_MM + 1.5 ? ' ! loss ' + loss.toFixed(1) + ' mm' : '')
  );
  } catch (err) {
    console.error(err);
    setStatus('Split failed: ' + (err && err.message ? err.message : String(err)), true);
  }
}

function arrayActiveModel() {
  const m = getActiveModel();
  if (!m) {
    setStatus('Load an STL first', true);
    return;
  }
  const count = Math.max(2, Math.min(16, Number(document.getElementById('array-count').value) || 4));
  const pitch = Number(document.getElementById('array-pitch').value);
  if (!(pitch > 0.5)) {
    setStatus('Pitch must be > 0.5 mm', true);
    return;
  }
  const axis = resolveAxis(m);
  const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
  const pos = src.attributes.position;
  const out = [];
  for (let n = 0; n < count; n++) {
    const dx = axis === 'x' ? n * pitch : 0;
    const dz = axis === 'z' ? n * pitch : 0;
    for (let i = 0; i < pos.count; i++) {
      out.push(pos.getX(i) + dx, pos.getY(i), pos.getZ(i) + dz);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.center();
  addModel(m.name + '-x' + count, geo);
  setStatus('Arrayed ' + count + ' at ' + pitch + ' mm on ' + axis + '. Download that new model.');
}

function exportActiveModel() {
  const m = getActiveModel();
  if (!m || !m.geometry) {
    setStatus('Select a model in the list first (click its name), then Download selected model STL', true);
    return;
  }
  try {
    let geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    if (!geo.attributes || !geo.attributes.position) {
      setStatus('Model has no mesh data to export', true);
      return;
    }
    // Work on a clean non-indexed clone
    if (geo === m.geometry) geo = geo.clone();
    const pos = geo.attributes.position;
    const mapped = [];
    let dropped = 0;
    const triCount = Math.floor(pos.count / 3);
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const verts = [];
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const i = i0 + k;
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          ok = false;
          break;
        }
        // Three.js Y-up -> slicer Z-up: (x, y, z) -> (x, -z, y)
        verts.push(x, -z, y);
      }
      if (!ok) { dropped++; continue; }
      mapped.push(verts[0], verts[1], verts[2], verts[3], verts[4], verts[5], verts[6], verts[7], verts[8]);
    }
    if (mapped.length < 9) {
      setStatus('Export failed - mesh empty or invalid after cut', true);
      return;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(mapped, 3));
    const buffer = geometryToBinarySTL(out);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const safe = String(m.name || 'piece').replace(/[\/\?%*:|"<>]/g, '_');
    let filename = safe + '.stl';
    try {
      const typed = window.prompt('Export as', filename);
      if (typed == null) {
        setStatus('Export cancelled');
        return;
      }
      filename = String(typed).trim() || filename;
      if (!/\.stl$/i.test(filename)) filename += '.stl';
      filename = filename.replace(/[\/\?%*:|"<>]/g, '_');
    } catch (e) {}
    downloadBlob(blob, filename);
    setStatus(
      'Downloaded ' + filename + ' (' + Math.floor(mapped.length / 9) + ' tris' +
      (dropped ? ', skipped ' + dropped + ' bad' : '') + '). Open in Bambu Studio.'
    );
  } catch (err) {
    console.error(err);
    setStatus('Export failed: ' + (err && err.message ? err.message : 'unknown error'), true);
  }
}

// ===================== UI =====================
function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : ' success');
}

function updatePlateInfo() {
  const p = getCurrentPlate();
  document.getElementById('plate-dims').textContent = `${p.w} x ${p.d} mm`;
  document.getElementById('plate-area').textContent = `${(p.w * p.d).toLocaleString()} mm2`;
  if (state.ready) {
    buildPlateMesh();
    clearPlaced();
  }
}

function setupUI() {
  document.getElementById('plate-select').addEventListener('change', (e) => {
    state.plate = e.target.value;
    document.getElementById('custom-size').classList.toggle('hidden', state.plate !== 'custom');
    updatePlateInfo();
  });

  document.getElementById('custom-w').addEventListener('change', updatePlateInfo);
  document.getElementById('custom-d').addEventListener('change', updatePlateInfo);

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  // Click method (label-based, more reliable)
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) {
      handleFiles(e.target.files);
    }
    // Allow re-selecting the same file after clear/delete
    e.target.value = '';
  });

  // Drag and drop (secondary)
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    if (!dropZone) return;
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  if (dropZone) {
    dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      dropZone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  function isFileDrag(e) {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }
  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
  const viewEl = document.getElementById('viewport');
  if (viewEl) {
    viewEl.addEventListener('dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    viewEl.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
  }

  document.getElementById('btn-optimize').addEventListener('click', runOptimize);
  document.getElementById('btn-clear').addEventListener('click', () => {
    state.models = [];
    state.editId = null;
    state.cutT = 0.5;
    state.cutterOpen = false;
    state.editYawDragging = false;
    state.cutDragging = false;
    clearUndo();
    clearDisplayMeshes();
    renderModelList();
    clearPlaced();
    removeCutHelper();
    state.previewMesh = null;
    state.selectedIndex = -1;
    updateAdjustUI();
    updateOptimizeButton();
    updateEditSize();
    updateCutterUI();
    const fi = document.getElementById('file-input');
    if (fi) fi.value = '';
    setStatus('Cleared - click drop zone to load an STL again');
  });
  document.getElementById('btn-export-stl').addEventListener('click', exportSTLs);

  // Manual adjust
  document.getElementById('btn-rot-left').addEventListener('click', () => rotateSelected(-1));
  document.getElementById('btn-rot-right').addEventListener('click', () => rotateSelected(1));
  document.getElementById('btn-flip').addEventListener('click', () => flipSelected());
  document.getElementById('btn-tip').addEventListener('click', () => tipSelected());
  const btnRoll = document.getElementById('btn-roll');
  if (btnRoll) btnRoll.addEventListener('click', () => rollSelected());
  const btnRaise = document.getElementById('btn-raise');
  if (btnRaise) btnRaise.addEventListener('click', () => liftSelected(1));
  const btnLower = document.getElementById('btn-lower');
  if (btnLower) btnLower.addEventListener('click', () => liftSelected(-1));
  const btnTiltUp = document.getElementById('btn-tilt-up');
  if (btnTiltUp) btnTiltUp.addEventListener('click', () => tiltSelected(1));
  const btnTiltDn = document.getElementById('btn-tilt-dn');
  if (btnTiltDn) btnTiltDn.addEventListener('click', () => tiltSelected(-1));
  const btnBankUp = document.getElementById('btn-bank-up');
  if (btnBankUp) btnBankUp.addEventListener('click', () => bankSelected(1));
  const btnBankDn = document.getElementById('btn-bank-dn');
  if (btnBankDn) btnBankDn.addEventListener('click', () => bankSelected(-1));
  document.getElementById('btn-nudge-left').addEventListener('click', () => nudgeSelected(-NUDGE_MM, 0));
  document.getElementById('btn-nudge-right').addEventListener('click', () => nudgeSelected(NUDGE_MM, 0));
  document.getElementById('btn-nudge-fwd').addEventListener('click', () => nudgeSelected(0, -NUDGE_MM));
  document.getElementById('btn-nudge-back').addEventListener('click', () => nudgeSelected(0, NUDGE_MM));

  const btnFrame = document.getElementById('btn-frame-selected');
  if (btnFrame) btnFrame.addEventListener('click', frameSelectedPiece);
  document.querySelectorAll('.vp-menu').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      document.querySelectorAll('.vp-menu').forEach(function (o) {
        if (o !== d) o.open = false;
      });
    });
  });

  const btnClearPlate = document.getElementById('btn-clear-plate');
  if (btnClearPlate) btnClearPlate.addEventListener('click', clearPlateOnly);
  const btnClone = document.getElementById('btn-clone');
  if (btnClone) btnClone.addEventListener('click', cloneSelectedModel);

  const btnDelPlaced = document.getElementById('btn-delete-placed');
  if (btnDelPlaced) btnDelPlaced.addEventListener('click', deleteSelectedPlaced);
  const ctxDel = document.getElementById('ctx-delete');
  if (ctxDel) ctxDel.addEventListener('click', () => {
    deleteSelectedPlaced();
    hideCtxMenu();
  });
  const btnDelModel = document.getElementById('btn-delete-model');
  if (btnDelModel) btnDelModel.addEventListener('click', deleteActiveModel);
  const btnUndo = document.getElementById('btn-undo');
  if (btnUndo) {
    const fireUndo = (e) => {
      e.preventDefault();
      e.stopPropagation();
      undoLast();
    };
    btnUndo.addEventListener('click', fireUndo, true);
    btnUndo.addEventListener('pointerdown', (e) => { e.stopPropagation(); }, true);
  }
  updateUndoBtn();

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undoLast();
      return;
    }
    if (state.cutterOpen && getActiveModel()) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCutMm(getCutMm() - 0.5);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCutMm(getCutMm() + 0.5);
        return;
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (state.selectedIndex >= 0 && state.placed[state.selectedIndex]) {
        deleteSelectedPlaced();
      } else if (getActiveModel()) {
        deleteActiveModel();
      }
    }
  });
  const btnCutterOpen = document.getElementById('btn-cutter-open');
  if (btnCutterOpen) btnCutterOpen.addEventListener('click', openCutter);
  const btnCutterClose = document.getElementById('btn-cutter-close');
  if (btnCutterClose) btnCutterClose.addEventListener('click', () => closeCutter(false));
  const btnCut = document.getElementById('btn-cut');
  if (btnCut) btnCut.addEventListener('click', cutActiveModel);
  const btnArray = document.getElementById('btn-array');
  if (btnArray) btnArray.addEventListener('click', arrayActiveModel);
  const btnExportModel = document.getElementById('btn-export-model');
  if (btnExportModel) btnExportModel.addEventListener('click', exportActiveModel);
  const btnSoften = document.getElementById('btn-soften');
  if (btnSoften) btnSoften.addEventListener('click', softenSelectedModel);
  const btnCapFace = document.getElementById('btn-cap');
  if (btnCapFace) btnCapFace.addEventListener('click', capSelectedModel);

  const btnSeal = document.getElementById('btn-seal');
  if (btnSeal) btnSeal.addEventListener('click', sealSelectedModel);
  const btnSolidify = document.getElementById('btn-solidify');
  if (btnSolidify) btnSolidify.addEventListener('click', solidifySelectedModel);
  const btnThickenOut = document.getElementById('btn-thicken-out');
  if (btnThickenOut) btnThickenOut.addEventListener('click', thickenOutSelectedModel);
  const btnThickenIn = document.getElementById('btn-thicken-in');
  if (btnThickenIn) btnThickenIn.addEventListener('click', thickenInSelectedModel);

  const btnJoin = document.getElementById('btn-join');
  if (btnJoin) btnJoin.addEventListener('click', joinSelectedModels);
  const btnSubtract = document.getElementById('btn-subtract');
  if (btnSubtract) {
    var subtractBusy = false;
    btnSubtract.addEventListener('click', function () {
      if (subtractBusy) return;
      subtractBusy = true;
      var prevLabel = btnSubtract.textContent;
      btnSubtract.disabled = true;
      btnSubtract.textContent = 'Subtracting...';
      Promise.resolve(subtractBFromA()).catch(function (err) {
        console.warn('[subtract] unexpected error:', err);
        setStatus('Subtract failed - unexpected error', true);
      }).then(function () {
        subtractBusy = false;
        btnSubtract.disabled = false;
        btnSubtract.textContent = prevLabel;
      });
    });
  }
  const btnExtract = document.getElementById('btn-extract-bit');
  if (btnExtract) btnExtract.addEventListener('click', extractBitFromSelected);
  const btnSeat = document.getElementById('btn-seat-flush');
  if (btnSeat) btnSeat.addEventListener('click', seatFlushBitToHull);
  const btnFlipPort = document.getElementById('btn-flip-port');
  if (btnFlipPort) btnFlipPort.addEventListener('click', flipPortOnPunch);
  const btnCap = document.getElementById('btn-cap-open');
  if (btnCap) btnCap.addEventListener('click', capSelectedOpenFaces);
  const btnJoinClear = document.getElementById('btn-join-clear');
  if (btnJoinClear) btnJoinClear.addEventListener('click', clearJoinSlots);
  const btnJoinStart = document.getElementById('btn-join-start');
  if (btnJoinStart) btnJoinStart.addEventListener('click', startJoinSession);
  const btnJoinAlign = document.getElementById('btn-join-align');
  if (btnJoinAlign) btnJoinAlign.addEventListener('click', alignJoinForSlide);
  const btnJoinCx = document.getElementById('btn-join-cx');
  if (btnJoinCx) btnJoinCx.addEventListener('click', function () { centerJoinAxis('x'); });
  const btnJoinCz = document.getElementById('btn-join-cz');
  if (btnJoinCz) btnJoinCz.addEventListener('click', function () { centerJoinAxis('z'); });
  
function applyXrayToMaterial(mat) {
  if (!mat) return;
  const on = !!state.xray;
  mat.wireframe = on;
  mat.transparent = on || mat.userData.keepTransparent;
  mat.opacity = on ? 0.22 : (mat.userData.solidOpacity != null ? mat.userData.solidOpacity : 1);
  mat.depthWrite = !on;
  mat.needsUpdate = true;
}

function applyXrayView() {
  const walk = function (obj) {
    if (!obj) return;
    if (obj.isMesh && obj.material) {
      if (obj === state.plateMesh || obj === state.cutHelper) return;
      if (obj.userData && obj.userData.skipXray) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach(applyXrayToMaterial);
    }
    if (obj.children) obj.children.forEach(walk);
  };
  walk(state.modelGroup);
  if (state.previewMesh) walk(state.previewMesh);
  const btn = document.getElementById('btn-xray');
  if (btn) btn.classList.toggle('is-on', !!state.xray);
}

function toggleXrayView() {
  state.xray = !state.xray;
  applyXrayView();
  setStatus(state.xray ? 'X-ray on' : 'X-ray off');
}

  const btnLoadStl = document.getElementById('btn-load-stl');
  const fileInp = document.getElementById('file-input');
  if (btnLoadStl && fileInp) btnLoadStl.addEventListener('click', function () { fileInp.click(); });
const btnFrameView = document.getElementById('btn-frame-view');
  if (btnFrameView) btnFrameView.addEventListener('click', frameSelectedPiece);
  const btnXray = document.getElementById('btn-xray');
  if (btnXray) btnXray.addEventListener('click', toggleXrayView);
  const btnJoinFaces = document.getElementById('btn-join-faces');
  if (btnJoinFaces) btnJoinFaces.style.display = 'none';
  const slotA = document.getElementById('join-slot-a');
  if (slotA) slotA.addEventListener('click', function () { armJoinSlot('a'); });
  const slotB = document.getElementById('join-slot-b');
  if (slotB) slotB.addEventListener('click', function () { armJoinSlot('b'); });
  const btnYawL = document.getElementById('btn-yaw-left');
  const btnYawR = document.getElementById('btn-yaw-right');
  const btnYawL90 = document.getElementById('btn-yaw-left-90');
  const btnYawR90 = document.getElementById('btn-yaw-right-90');
  if (btnYawL) btnYawL.addEventListener('click', () => rotateActiveModelY(-15));
  if (btnYawR) btnYawR.addEventListener('click', () => rotateActiveModelY(15));
  if (btnYawL90) btnYawL90.addEventListener('click', () => rotateActiveModelY(-90));
  if (btnYawR90) btnYawR90.addEventListener('click', () => rotateActiveModelY(90));

  function setCutAxisLock(axis) {
    state.cutAxis = axis;
    const sel = document.getElementById('edit-axis');
    if (sel) sel.value = axis;
    const bx = document.getElementById('btn-cut-axis-x');
    const bz = document.getElementById('btn-cut-axis-z');
    if (bx) bx.classList.toggle('tool-active', axis === 'x');
    if (bz) bz.classList.toggle('tool-active', axis === 'z');
    if (state.cutterOpen && getActiveModel()) {
      const mesh = getCutterTargetMesh();
      if (mesh) state.previewMesh = mesh;
      buildCutHelper();
      updateCutHelper();
      syncCutUI();
    }
    setStatus('Blade axis ' + axis.toUpperCase());
  }
  const btnAx = document.getElementById('btn-cut-axis-x');
  const btnAz = document.getElementById('btn-cut-axis-z');
  if (btnAx) btnAx.addEventListener('click', function () { setCutAxisLock('x'); });
  if (btnAz) btnAz.addEventListener('click', function () { setCutAxisLock('z'); });
  const axisSel = document.getElementById('edit-axis');
  if (axisSel) axisSel.addEventListener('change', function () {
    setCutAxisLock(axisSel.value === 'z' ? 'z' : axisSel.value === 'x' ? 'x' : 'auto');
  });
  const slider = document.getElementById('cut-slider');
  if (slider) slider.addEventListener('input', () => {
    const m = getActiveModel();
    const span = m ? getCutSpan(m) : 100;
    const raw = Math.min(0.98, Math.max(0.02, Number(slider.value) / 100));
    state.cutT = snapCutT(raw, span);
    syncCutUI();
    updateCutHelper();
  });
  const cutMm = document.getElementById('cut-mm');
  if (cutMm) cutMm.addEventListener('change', () => setCutMm(Number(cutMm.value)));
  const nudgeM = document.getElementById('btn-cut-nudge-m');
  if (nudgeM) nudgeM.addEventListener('click', () => setCutMm(getCutMm() - 1));
  const nudgeP = document.getElementById('btn-cut-nudge-p');
  if (nudgeP) nudgeP.addEventListener('click', () => setCutMm(getCutMm() + 1));
  updateAdjustUI();
  updateCutterUI();
}

// ===================== Boot =====================
try {
  initThree();
  setupUI();
  updatePlateInfo();
  setStatus('Ready - 3D canvas ' + (state.renderer ? state.renderer.domElement.width + 'x' + state.renderer.domElement.height : 'missing'));
} catch (err) {
  console.error(err);
  document.body.innerHTML = '<p style="color:white;padding:40px;font-family:sans-serif">Failed to start. Check browser console.</p>';
}
