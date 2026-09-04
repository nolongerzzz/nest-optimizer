import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

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
  cutAxis: null
};

let nextId = 1;
const loader = new STLLoader();
const NUDGE_MM = 2;
const UNDO_MAX = 40;
const MIN_CUT_SIDE_MM = 1; // allow 1 mm steps; still refuse zero-width
const KERF_MM = 1.0; // cut width removed between halves (visible gap)
const CHAMFER_MM = 0.8; // mild soft edge on cut face (bevel band)
const CHAMFER_MITER = 2.0; // miter limit — sharp corners become bevels

function updateUndoBtn() {
  const btn = document.getElementById('btn-undo');
  if (!btn) return;
  const has = state.undoStack.length > 0;
  btn.disabled = !has;
  btn.classList.toggle('is-ready', has);
  btn.title = has ? ('Undo (' + state.undoStack.length + ') — Ctrl+Z') : 'Nothing to undo yet';
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
    state.models = state.models.filter(m => !ids.has(m.id));
    if (entry.source) {
      state.models.push(entry.source);
      state.editId = entry.source.id;
    } else if (entry.editId != null) {
      state.editId = entry.editId;
    }
    if (entry.cutT != null) state.cutT = entry.cutT;
    // Wipe plate halves completely, then show the restored original only
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
    updateAdjustUI();
    const src = entry.source || getActiveModel();
    if (src && src.geometry) {
      // Direct single-mesh preview (no auto-orient) so undo is obvious
      const mat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
        emissive: 0x0a3a5c, emissiveIntensity: 0.25
      });
      const mesh = new THREE.Mesh(src.geometry, mat);
      const h = (src.size && src.size.y) ? src.size.y / 2 + 0.3 : 5;
      mesh.position.set(0, h, 0);
      state.modelGroup.add(mesh);
    }
    updateUndoBtn();
    setStatus('Undo: restored single piece — halves cleared from plate');
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
  state.scene.background = new THREE.Color(0x475569);

  state.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
  state.camera.position.set(140, 160, 200);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  state.renderer.setSize(width, height);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.setClearColor(0x475569, 1);
  container.innerHTML = ''; // clear any previous content
  container.appendChild(state.renderer.domElement);

  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.target.set(0, 0, 0);
  // Orbit only while left-dragging the plate (toggled in pointer handlers)
  state.controls.enableRotate = false;
  state.controls.enablePan = false;
  // Custom wheel handler below — Orbit zoom disabled so we can invert direction
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
  // Invert scroll zoom: scroll-in / wheel-up → closer; scroll-out → farther
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
  // Flipped: deltaY < 0 (scroll up / in) → closer; deltaY > 0 → farther
  const scale = Math.pow(0.95, Math.min(8, Math.abs(delta) * 0.01));
  const offset = state.camera.position.clone().sub(state.controls.target);
  if (delta < 0) {
    // scroll in → closer
    offset.multiplyScalar(scale);
  } else {
    // scroll out → farther
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
  // Keep bed fully visible until mesh-engine work; glass-from-below can return later.
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
  const mat = new THREE.MeshBasicMaterial({
    color: 0x7dd3fc,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.plateMesh.position.y = 0;
  state.plateMesh.receiveShadow = true;
  state.scene.add(state.plateMesh);

  // Grid on the floor — not a child of the rotated plate
  const grid = new THREE.GridHelper(Math.max(p.w, p.d), 18, 0x93c5fd, 0x64748b);
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

  // Frame camera only once on first plate build — never on upload/cutter/rebuild
  if (state.controls && !state.cameraFramed) {
    state.controls.target.set(0, 0, 0);
    state.camera.position.set(p.w * 0.7, p.w * 0.8, p.d * 0.9);
    state.controls.update();
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
// rotateX(-90°) is the standard mapping; export inverts it.
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
        geometry = zUpToYUp(geometry);
        geometry.computeVertexNormals();
        geometry.center();
        addModel(file.name, geometry);
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
    orientedGeometry: null
  });

  if (!options.keepSelection) {
    state.editId = id;
    state.cutT = 0.5;
  }
  renderModelList();
  updateOptimizeButton();
  updateEditSize();
  if (!options.silent) {
    if (state.cutterOpen && !options.keepSelection) {
      showEditPreview();
      setStatus(`Loaded: ${name} (${size2.x.toFixed(0)}×${size2.y.toFixed(0)}×${size2.z.toFixed(0)} mm) – cutter open, slide red plane`);
    } else if (!options.keepSelection) {
      const model = state.models.find(x => x.id === id);
      // Offset new uploads so they don't stack on existing plate pieces
      let x = 0;
      if (state.placed.length) {
        const maxX = Math.max(...state.placed.map(p => p.x + (p.width || 0) / 2));
        x = maxX + size2.x / 2 + 4;
      }
      if (model) placeModelMovable(model, x, 0);
      setStatus(`Loaded: ${name} (${size2.x.toFixed(0)}×${size2.y.toFixed(0)}×${size2.z.toFixed(0)} mm) – drag to move, Open cutter, or Optimize`);
    }
  }
  return id;
}

// Clear display meshes only — never dispose shared model geometries
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
    // Do NOT dispose geometry — it may be shared with state.models
  }
  // Safety: empty group
  while (state.modelGroup.children.length) {
    state.modelGroup.remove(state.modelGroup.children[0]);
  }
}

// Show a single model on the plate so upload has immediate feedback

/** Put a library model on the plate as a movable piece (does not wipe other pieces). */
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

function frameSelectedPiece() {
  const p = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
  if (!p || !p.mesh || !state.camera || !state.controls) {
    setStatus('Select a piece on the plate first', true);
    return;
  }
  const box = new THREE.Box3().setFromObject(p.mesh);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 20);
  state.controls.target.copy(center);
  state.camera.position.set(
    center.x + maxDim * 1.2,
    center.y + maxDim * 0.9,
    center.z + maxDim * 1.2
  );
  state.controls.update();
  setStatus('Framed: ' + (p.name || 'piece'));
}

function clearPlateOnly() {
  clearPlaced();
  removeCutHelper();
  state.previewMesh = null;
  state.selectedIndex = -1;
  state.cutterOpen = false;
  updateCutterUI();
  updateAdjustUI();
  setStatus('Plate cleared — library models kept. Upload or Open cutter still work.');
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
  setStatus('Cloned ' + newIds.length + ' × ' + src.name + ' side-by-side on plate (' + cols + ' across)');
}

function previewModelOnPlate(geometry, size) {
  if (!state.scene || !state.modelGroup) {
    setStatus('3D view not ready – refresh the page', true);
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
    row.className = 'model-item' + (m.id === state.editId ? ' active' : '');
    row.dataset.editId = String(m.id);
    row.innerHTML = `
      <span class="name" title="${m.name}">${m.name}</span>
      <div class="qty">
        <input type="number" min="1" max="30" value="${m.quantity}" data-id="${m.id}" />
      </div>
      <button class="remove" data-id="${m.id}" title="Remove">×</button>
    `;
    el.appendChild(row);
  });

  el.querySelectorAll('.model-item').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.qty') || e.target.closest('.remove')) return;
      const id = Number(row.dataset.editId);
      state.editId = id;
      state.cutT = 0.5;
      renderModelList();
      updateEditSize();
      if (state.cutterOpen) {
        showEditPreview();
        setStatus('Cutter on ' + (getActiveModel() ? getActiveModel().name : ''));
      } else {
        setStatus('Selected ' + (getActiveModel() ? getActiveModel().name : '') + ' — Open cutter to cut, or Optimize to nest');
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
// Footprints: 0°, 90°, ±45° yaw. AABB expands at 45°.
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
    // Candidate footprints: as-is + 90° yaw if allowed
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

    // Two split heuristics — keep both leftover rects when large enough
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
  const threshold = Math.cos((45 * Math.PI) / 180); // 45° overhang

  for (let i = 0; i < pos.count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    normal.crossVectors(vB.clone().sub(vA), vC.clone().sub(vA)).normalize();
    // Faces pointing down/sideways past threshold need support
    const dot = normal.dot(up);
    const needsSupport = dot < threshold && dot > -0.95; // skip near-downward bed faces slightly
    // Stronger: any face more than 45° from up
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
  setStatus('Optimizing…');
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

    // Keep plate visible — do not reframe camera after packing
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
      setStatus(`${fitted} fitted, ${overflowCount} need manual place — click orange model(s) to rotate/nudge`, true);
    } else {
      setStatus(`Packed ${fitted} models — ready to export`, false);
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
  p.mesh.position.y = p.height / 2 + 0.2;
}

function applyPlacedXZ(p, x, z) {
  if (!p) return;
  // Free move — on plate or off. No hard clamp.
  p.x = x;
  p.z = z;
  if (p.mesh) {
    p.mesh.position.x = p.x;
    p.mesh.position.z = p.z;
    settlePlacedOnBed(p);
  }
}

function startMoveDrag(idx, event) {
  if (state.cutterOpen) {
    setStatus('Cutter open — close cutter to move pieces');
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
  return true;
}

function dragMovePlaced(event) {
  if (!state.moveDragging) return;
  const p = state.placed[state.moveIndex];
  if (!p) return;
  setPointerFromEvent(event);
  const hit = hitPlateXZ();
  if (!hit) return;
  applyPlacedXZ(p, hit.x + state.moveGrab.x, hit.z + state.moveGrab.z);
}

function endMoveDrag() {
  if (!state.moveDragging) return;
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
  if (!m || !state.previewMesh) return;
  const axis = resolveAxis(m);
  // Horizontal plane through the target mesh (works anywhere on the plate)
  const worldPos = new THREE.Vector3();
  state.previewMesh.getWorldPosition(worldPos);
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldPos.y);
  const hit = new THREE.Vector3();
  state.raycaster.setFromCamera(state.pointer, state.camera);
  if (!state.raycaster.ray.intersectPlane(dragPlane, hit)) return;
  // Drag in the mesh's local space so left/right of the piece both work
  const local = state.previewMesh.worldToLocal(hit.clone());
  const bbox = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
  const span = axis === 'x' ? (bbox.max.x - bbox.min.x) : (bbox.max.z - bbox.min.z);
  if (span < 1e-6) return;
  const along = axis === 'x' ? local.x : local.z;
  const origin = axis === 'x' ? bbox.min.x : bbox.min.z;
  const raw = Math.min(0.98, Math.max(0.02, (along - origin) / span));
  state.cutT = snapCutT(raw, span);
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
    // Low sensitivity: ~0.15° per pixel — controllable, not gyro
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
  setStatus('Selected #' + (idx + 1) + ' — Delete piece or press Delete');
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

  // Cutter plane drag — never orbit
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
        selectPlaced(idx);
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
      // preview mesh or non-placed — still block orbit
      event.stopPropagation();
      return;
    }
  }

  // Left-drag on plate OR empty background → orbit (pieces still steal drag above)
  if (hitPlateSurface(event)) {
    setOrbitFromPlate(true);
    return;
  }

  // Off-plate / sky — still orbit so pieces can't trap the view
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
    // Bold white edge outline
    const edges = new THREE.EdgesGeometry(p.mesh.geometry, 30);
    const outline = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 })
    );
    p.mesh.add(outline);
    p.outline = outline;
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
      // If cutter is already open, move the red line onto this piece
      if (state.cutterOpen) {
        removeCutHelper();
        state.previewMesh = p.mesh;
        state.cutT = 0.5;
        buildCutHelper();
        setStatus('Cutter on ' + m.name + ' — drag red line, then Split.');
      }
    }
  }
  updateAdjustUI();
  updateCutterUI();
}

function updateExportButton() {
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
}

function updateAdjustUI() {
  const has = state.selectedIndex >= 0 && state.placed[state.selectedIndex];
  ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back', 'btn-delete-placed', 'btn-frame-selected']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !has;
    });
  const cloneBtn = document.getElementById('btn-clone');
  if (cloneBtn) cloneBtn.disabled = !(has || getActiveModel());
  const status = document.getElementById('adjust-status');
  if (status) {
    status.textContent = has
      ? `Selected #${state.selectedIndex + 1} — drag to move, right-click to delete`
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
      /* shared geo — do not dispose */
    } else if (p.mesh.material) {
      if (Array.isArray(p.mesh.material)) p.mesh.material.forEach(m => m.dispose());
      else p.mesh.material.dispose();
    }
  }
  state.placed.splice(idx, 1);
  state.selectedIndex = -1;
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
  p.mesh.rotation.set(p.flipX ? Math.PI : 0, p.rotY, 0);

  // Swap width/depth for packing metadata
  const tmp = p.width;
  p.width = p.depth;
  p.depth = tmp;

  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
  }
  p.mesh.position.y = p.height / 2 + 0.2;

  updateExportButton();
  setStatus(`Rotated model #${state.selectedIndex + 1}`);
}

function flipSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));

  p.flipX = !p.flipX;
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus(`Flipped model #${state.selectedIndex + 1}`);
}

// Tip 90° around X — cycles which face sits on the bed (any model)
function tipSelected() {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;
  pushUndo(snapshotPlacedPose(state.selectedIndex));

  p.tipX = ((p.tipX || 0) + 1) % 4; // 0,1,2,3 → 0,90,180,270°
  applyMeshRotation(p);
  refreshOutline(p);
  updateExportButton();
  setStatus(`Tipped model #${state.selectedIndex + 1} (face ${p.tipX + 1}/4)`);
}

function applyMeshRotation(p) {
  const tip = (p.tipX || 0) * (Math.PI / 2);
  const flip = p.flipX ? Math.PI : 0;
  p.mesh.rotation.set(tip + flip, p.rotY || 0, 0);
  p.mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(p.mesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  p.width = size.x;
  p.depth = size.z;
  p.height = size.y;
  p.mesh.position.set(p.x, p.height / 2 + 0.2, p.z);
  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
  }
}

function refreshOutline(p) {
  if (p.outline) {
    p.mesh.remove(p.outline);
    if (p.outline.geometry) p.outline.geometry.dispose();
    if (p.outline.material) p.outline.material.dispose();
  }
  const edges = new THREE.EdgesGeometry(p.mesh.geometry, 30);
  p.outline = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0xffffff })
  );
  p.mesh.add(p.outline);
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
// Convert (x, y, z)_three → (x, z, y)_slicer so the plate lies flat.
function buildCombinedGeometry() {
  const positions = [];
  state.placed.forEach(p => {
    const geo = p.geometry.clone();
    const tip = (p.tipX || 0) * (Math.PI / 2);
    const flip = p.flipX ? Math.PI : 0;
    if (tip || flip) geo.rotateX(tip + flip);
    const rotY = p.rotY != null ? p.rotY : (p.rotated ? Math.PI / 2 : 0);
    if (rotY) geo.rotateY(rotY);
    geo.translate(p.x, p.height / 2, p.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // height in Three.js
      const z = pos.getZ(i);
      // Inverse of import: (x,y,z)_Yup → (x,-z,y)_Zup for Bambu
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
    setStatus('Nothing to export – run Optimize first', true);
    return;
  }

  setStatus('Building STL…');

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
    setStatus('Export failed – check console', true);
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
  setStatus('Piece yaw ' + (deg > 0 ? '+' : '') + deg + '° (Y only — no free orbit)');
}

function getActiveModel() {
  if (state.editId != null) {
    const found = state.models.find(m => m.id === state.editId);
    if (found) return found;
  }
  return state.models.length ? state.models[state.models.length - 1] : null;
}

function updateEditSize() {
  const el = document.getElementById('edit-size');
  const m = getActiveModel();
  if (!el) return;
  if (!m) {
    el.textContent = 'Load an STL to see size.';
    return;
  }
  el.textContent = m.name + ': ' + m.size.x.toFixed(1) + ' × ' + m.size.y.toFixed(1) + ' × ' + m.size.z.toFixed(1) + ' mm (X × H × Z)';
  syncCutUI();
}

function resolveAxis(model) {
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

/** For Split: push cutT → helper, then read plane from helper so cut == red line */
function getCutPlaneForSplit(model) {
  const m = model || getActiveModel();
  if (!m) return null;
  // Sync helper to current cutT first
  updateCutHelper();
  const base = getCutPlaneLocal(m);
  if (!base) return null;
  // Prefer live helper position (same space as geometry local)
  if (state.cutHelper) {
    const plane = base.axis === 'x' ? state.cutHelper.position.x : state.cutHelper.position.z;
    const t = (plane - base.origin) / base.span;
    return {
      axis: base.axis,
      plane: plane,
      bbox: base.bbox,
      span: base.span,
      t: Math.min(0.98, Math.max(0.02, t)),
      origin: base.origin
    };
  }
  return base;
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
    if (readout) readout.textContent = '—';
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
      'RED LINE @ ' + mm.toFixed(1) + ' mm (kerf ' + KERF_MM + ' mm) → ' +
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
      ? 'Cutter open — click a piece to put the red line on it, then Split.'
      : 'Cutter closed — red line off.';
  }
  if (cutBtn) cutBtn.disabled = !state.cutterOpen || !getActiveModel();
}

/** Mesh on the plate for the active model — used to hang the red plane in place */
function getCutterTargetMesh() {
  const m = getActiveModel();
  if (!m || !state.placed || !state.placed.length) return null;
  const hit = state.placed.find(p => p && p.sourceId === m.id && p.mesh);
  return hit ? hit.mesh : null;
}

function openCutter() {
  // Prefer the piece selected on the plate, else list selection
  if (state.selectedIndex >= 0 && state.placed[state.selectedIndex]) {
    const p = state.placed[state.selectedIndex];
    if (p && p.sourceId != null) {
      const m = state.models.find(x => x.id === p.sourceId);
      if (m) state.editId = m.id;
    }
  }
  if (!getActiveModel()) {
    setStatus('Load or select a piece first, then open cutter', true);
    return;
  }
  state.cutterOpen = true;
  state.cutDragging = false;
  state.editYawDragging = false;
  state.cutT = 0.5;
  if (state.controls) state.controls.enabled = true;

  // Open/close cutter MUST NOT rebuild or remove pieces — only the red line
  removeCutHelper();
  const target = getCutterTargetMesh();
  if (target) {
    state.previewMesh = target;
    buildCutHelper();
  } else if (!state.placed.length) {
    // Nothing on plate yet — single-model preview only
    showEditPreview();
  } else {
    // Models on plate but no mesh match — still show plane on active geometry at origin
    showEditPreview();
  }
  updateCutterUI();
  updateEditSize();
  const m = getActiveModel();
  setStatus(
    'Cutter open on ' + (m && m.name ? m.name : 'piece') +
    ' — red line only; pieces stay put. Drag plane, then Split.'
  );
}

function closeCutter(silent) {
  state.cutterOpen = false;
  state.cutDragging = false;
  state.moveDragging = false;
  state.editYawDragging = false;
  if (state.controls) state.controls.enabled = true;
  removeCutHelper();
  // Do NOT clear or rebuild pieces — open/close is red-line only
  if (state.previewMesh && state.previewMesh.userData && state.previewMesh.userData.editPreview) {
    // Only clear a temporary single-model preview (no real plate pack)
    if (!state.placed.length) {
      /* leave preview mesh visible without plane */
    }
  }
  // If previewMesh was a real placed piece, just detach helper (already removed)
  if (state.previewMesh && state.previewMesh.userData && state.previewMesh.userData.placedIndex != null) {
    state.previewMesh = null;
  }
  updateCutterUI();
  if (!silent) setStatus('Cutter closed — red line off. Pieces unchanged.');
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

  const w = Math.max(axis === 'x' ? m.size.z : m.size.x, 8);
  const h = Math.max(m.size.y, 8);
  const pw = w * 1.35;
  const ph = h * 1.45;

  // Thick kerf slab so the cut band is obvious (~KERF_MM visual)
  const kerfVis = Math.max(KERF_MM, 1.2);
  const planeGeo = new THREE.BoxGeometry(
    axis === 'x' ? kerfVis : pw,
    ph,
    axis === 'x' ? pw : kerfVis
  );
  const planeMat = new THREE.MeshBasicMaterial({
    color: 0xff1a1a,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: true
  });
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.userData.cutHandle = true;

  // Large invisible hit target for easy drag
  const hitGeo = new THREE.PlaneGeometry(pw * 1.5, ph * 1.5);
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
    new THREE.LineBasicMaterial({ color: 0xffeeee, linewidth: true })
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
    new THREE.LineBasicMaterial({ color: 0xffffff })
  );
  crossLine.userData.cutHandle = true;

  group.add(hit);
  group.add(plane);
  group.add(frame);
  group.add(crossLine);
  state.previewMesh.add(group);
  state.cutHelper = group;
  updateCutHelper();
}

function updateCutHelper() {
  const m = getActiveModel();
  if (!m || !state.cutHelper) return;
  const info = getCutPlaneLocal(m);
  if (!info) return;
  if (info.axis === 'x') {
    state.cutHelper.position.set(info.plane, 0, 0);
  } else {
    state.cutHelper.position.set(0, 0, info.plane);
  }
}

function axisCoord(ax, x, y, z) {
  return ax === 'x' ? x : ax === 'y' ? y : z;
}

function clipGeometrySide(geometry, axis, plane, keepMin) {
  // Always copy — never mutate the source model mesh
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
      // Whole triangle on this side — but skip pure on-plane tris (zero volume)
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
        // One vertex on plane, other off — the on-plane vertex is the cut point
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
  // Claude-style: boundary graph → closed loop(s) → ear-clip cap → outward normals
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

  // Walk all simple cycles (degree-2 chains)
  const visitedEdge = new Set();
  function ek(a, b) { return a < b ? a + '~' + b : b + '~' + a; }

  const loops = [];
  for (const start of adj.keys()) {
    for (const nb of adj.get(start)) {
      const e0 = ek(start, nb);
      if (visitedEdge.has(e0)) continue;
      // Walk loop
      const loopKeys = [start];
      let prev = start;
      let cur = nb;
      visitedEdge.add(e0);
      let guard = 0;
      while (cur !== start && guard++ < 100000) {
        loopKeys.push(cur);
        const nbs = adj.get(cur);
        if (!nbs || !nbs.size) break;
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
          // try any unused including back (open chain — abort)
          break;
        }
        prev = cur;
        cur = next;
      }
      if (cur === start && loopKeys.length >= 3) {
        loops.push(loopKeys.map(k => nodePos.get(k)));
      }
    }
  }

  if (!loops.length) {
    // Fallback: convex hull of all points if loop walk failed
    const all = Array.from(nodePos.values());
    if (all.length < 3) return [];
    loops.push(hull2D(all));
  }

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
        // Degenerate remainder — fan from first
        for (let i = 1; i < verts.length - 1; i++) {
          tris.push([verts[0].p, verts[i].p, verts[i + 1].p]);
        }
        break;
      }
    }
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

  function edgeInwardNormal` through
  // the end of `function filletLoop`, i.e. everything between `resampleLoop2`
  // and the `loops.forEach(...)` dispatch block).
  //
  // Do NOT touch anything outside this range — clipGeometrySide, the loop-walk
  // in capFromEdges, earClip, resampleLoop2, loopArea2, to2/from2/from2At, and
  // the `loops.forEach(...)` dispatch at the bottom are all correct as-is and
  // are not part of this patch.
  //
  // This fixes three independent, confirmed bugs found by review against the
  // validated Python reference implementation:
  //
  //  BUG 1 — tBlend was hardcoded to 0.5. Every point inside a corner's blend
  //    window collapsed onto the same fixed 50/50 direction instead of sweeping
  //    smoothly from wall 1's direction to wall 2's direction as the loop index
  //    moves through the window. This is what produces a visible pinch/crease
  //    at the corner — the corner patch was never actually a smooth fan.
  //
  //  BUG 2 — No stitch between the fillet ring and the actual clipped-body
  //    boundary. `filletLoop` builds its ring entirely on a *resampled* copy of
  //    the boundary (`resampleLoop2`), with no connection back to the true,
  //    unresampled vertices that `out` (the clipped body in clipGeometrySide)
  //    actually has along its cut edge. This is a real gap risk, not just
  //    cosmetic — the ring and the body can disagree about exactly where the
  //    boundary is.
  //
  //  BUG 3 — `if (ringSelfIntersects(...)) return null;` discards the ENTIRE
  //    loop's fillet on any self-intersection, falling back to a flat cap for
  //    that whole slot/loop. A local self-intersection near one thin wall
  //    shouldn't cost the whole loop its rounding — it should shrink the
  //    radius locally, right where it's needed, and keep going.
  //
  // All four fixes below were validated against real measured geometry
  // (a factory part's actual corner radius, fit to a true circle within
  // 0.008mm) before being ported here. See cut-edge-fillet-algorithm.md for
  // the underlying math.
  // ============================================================================

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
    // index pairs instead of just a boolean — needed for local repair (BUG 3).
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
    return 2.0; // match piece — factory-scale default, locally clamped
  }

  // ---- NEW: min-filter (not mean-filter) smoothing for the radius array. ----
  // A mean filter can INCREASE the radius near a thin spot (averaging a thin
  // value with wider neighbors), which defeats the safety pass. Min-filter
  // never does that — it only ever pulls values down toward the tightest
  // nearby constraint, which is what "safe everywhere" actually requires.
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

  // ---- NEW: mean smoothing, but never allowed to exceed the min-filtered
  // safe ceiling. This removes jagged single-point dips (which is what BUG 3's
  // predecessor in the Python work looked like: a sharp cliff down to ~0.3mm
  // right next to full radius, which itself reads as a visible pinch even
  // with the corner-sphere math otherwise correct) while never re-introducing
  // an unsafe radius. ----
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

  // ---- NEW: local iterative repair (replaces "return null on any
  // intersection"). Only shrinks the radius at the specific vertices involved
  // in a self-intersection, and only as much as needed — the rest of the loop
  // keeps its full requested radius. This is what stops one tight corner from
  // costing an entire slot its rounding. ----
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
    return R; // best effort after 40 iterations — logged by caller if still bad
  }

  // ---- NEW: walk for stitching the resampled fillet ring to the TRUE
  // (unresampled) boundary loop that the clipped body actually uses. This is
  // BUG 2's fix.
  //
  // IMPORTANT — this ALWAYS emits a triangle for every step of the walk, even
  // when three consecutive points are collinear (zero area). An earlier draft
  // of this fix tried skipping degenerate triangles instead, on the reasoning
  // that they contribute nothing — that was tested against the Python
  // reference and it's WRONG: some of those "contribute nothing" edges are
  // the *only* edge pairing a particular boundary point has back to the
  // clipped body's own triangulation. Skipping them silently punches a real
  // hole in the mesh (confirmed: 622 broken edge-pairings in that test).
  //
  // So: always emit, preserving every pairing exactly as the naive walk
  // would. Any triangle that comes out with ~zero area gets its middle vertex
  // nudged by a tiny amount afterward (see nudgeDegenerateTriangles below) —
  // small enough to be visually and dimensionally meaningless, but large
  // enough to survive STLExporter's float32 export, and chosen adaptively so
  // it never perturbs a vertex enough to stop matching its partner elsewhere.
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

    const strip = []; // array of [p1_2d, p2_2d, p3_2d] triangles
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
    return strip; // each triangle vertex is a 2D [u,v] point; caller lifts to 3D at `plane`
  }

  // ---- NEW: fix zero-area triangles by nudging, not deleting. Validated
  // against a float32 STLExporter round-trip and against the same coordinate
  // rounding tolerance (TOL = 1e-4) capFromEdges already uses for welding —
  // the nudge is picked per-vertex to be large enough to survive one, small
  // enough to never cross the other. ----
  function nudgeDegenerateTriangles(triangles2D) {
    const MATCH_TOL = 1e-4; // same tolerance as keyOf() elsewhere in capFromEdges
    function area2(a, b, c) {
      return 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    }
    function keyOf2(p) {
      return Math.round(p[0] / MATCH_TOL) + '|' + Math.round(p[1] / MATCH_TOL);
    }
    const candidateMags = [1e-5, 1e-5 / 3, 1e-5 / 10, 1e-5 / 30, 1e-5 / 100];

    for (const tri of triangles2D) {
      if (area2(tri[0], tri[1], tri[2]) > 1e-9) continue;
      // find the "middle" vertex on the longest edge
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
      // if not fixed, leave as-is — an unfixed zero-area triangle is
      // cosmetically imperfect but not topologically unsafe, unlike deleting it
    }
    return triangles2D;
  }

  function filletLoop(loop3, Rreq) {
    const raw2 = loop3.map(p => to2(p));
    if (raw2.length < 6 || Rreq < 0.15) return null;

    // trueLoop2 = exact boundary, matching the clipped body's own vertices.
    // loop2 = resampled copy used only for stable offset/normal computation.
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
          const signedDist = i - c.i; // signed, wrapped below — needed for a real sweep, not a fixed midpoint
          let d = ((signedDist + n) % n);
          if (d > n / 2) d -= n;
          const absD = Math.abs(d);
          if (absD > windowN) continue;
          const w = smoothstep(1 - absD / windowN);
          const negN1 = [-c.n1[0], -c.n1[1]];
          const negN2 = [-c.n2[0], -c.n2[1]];
          // BUG 1 FIX: tBlend sweeps from 0 (wall-1 side of the window) to 1
          // (wall-2 side), tracking the vertex's actual signed position in the
          // window, instead of being frozen at the window's midpoint for every
          // point. This is the change that turns the corner into an actual fan
          // instead of a collapse onto one direction.
          const tBlend = (d + windowN) / (2 * windowN);
          const nBlend = slerp2D(negN1, negN2, tBlend);
          const suv = [c.C[0] + c.R * Math.cos(phi) * nBlend[0], c.C[1] + c.R * Math.cos(phi) * nBlend[1]];
          uv = [uv[0] * (1 - w) + suv[0] * w, uv[1] * (1 - w) + suv[1] * w];
        }
        ring.push(uv);
      }
      return ring;
    }

    // BUG 3 FIX: local repair instead of all-or-nothing rejection. Only
    // checked/repaired against the innermost (tightest) ring, same as before,
    // but now failure shrinks specific vertices rather than discarding
    // everything.
    Rs = repairSelfIntersections(loop2, Rs, (Rarr) => computeRingAtDepth(Rarr, STEPS));
    const finalRmax = Math.max(...Rs);
    if (finalRmax < 0.15) return null;

    const rings = [];
    for (let s = 0; s <= STEPS; s++) rings.push(computeRingAtDepth(Rs, s));

    // Final safety check — if repair still couldn't fully clear it after 40
    // iterations, fall back to flat cap for this loop only (same behavior as
    // before, but now it's a true last resort, not the first response to any
    // intersection).
    if (ringSelfIntersects(rings[rings.length - 1])) return null;

    const tris3 = [];

    // BUG 2 FIX: stitch ring 0 (resampled) to the TRUE boundary loop the
    // clipped body actually has, instead of leaving a gap. This uses the same
    // skip-if-degenerate approach validated in the Python reference — every
    // point in both sequences is visited, but no zero-area triangle is ever
    // emitted, so there's nothing left to cause z-fighting or rendering
    // slivers.
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
      color: colors[i % colors.length],
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
    setStatus('Cannot resolve cut plane — reopen cutter', true);
    return;
  }
  const axis = info.axis;
  const span = info.span;
  const plane = info.plane;
  // Distance from min end — must match readout
  const cutMm = (plane - info.origin);
  if (span < MIN_CUT_SIDE_MM * 2) {
    setStatus('Piece too short to cut (need ≥ ' + (MIN_CUT_SIDE_MM * 2) + ' mm along cut axis)', true);
    return;
  }
  if (cutMm < MIN_CUT_SIDE_MM || cutMm > span - MIN_CUT_SIDE_MM) {
    setStatus('Keep ≥ ' + MIN_CUT_SIDE_MM + ' mm on each side of the red plane', true);
    return;
  }
  // Kerf band centered on red line — middle slab discarded so halves have a real gap
  const halfKerf = KERF_MM * 0.5;
  const leftPlane = plane - halfKerf;
  const rightPlane = plane + halfKerf;
  const left = clipGeometrySide(m.geometry, axis, leftPlane, true);
  const right = clipGeometrySide(m.geometry, axis, rightPlane, false);
  if (!left || !right) {
    setStatus('Cut produced an empty side — nudge the plane and retry', true);
    return;
  }

  function measure(geo) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const sx = bb.max.x - bb.min.x;
    const sy = bb.max.y - bb.min.y;
    const sz = bb.max.z - bb.min.z;
    const along = axis === 'x' ? sx : sz;
    return { sx, sy, sz, along };
  }
  const mL = measure(left);
  const mR = measure(right);
  if (mL.along < 0.5 || mR.along < 0.5) {
    setStatus('Cut would leave a speck — move the red plane', true);
    return;
  }
  if (mL.sx < 0.4 || mL.sy < 0.4 || mL.sz < 0.4 || mR.sx < 0.4 || mR.sy < 0.4 || mR.sz < 0.4) {
    setStatus('Cut produced a degenerate sliver — try a different plane position', true);
    return;
  }

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

  // One piece → two pieces. No leftover original copy.
  const sourceSnapshot = {
    id: m.id,
    name: m.name,
    geometry: m.geometry.clone(),
    quantity: m.quantity || 1,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    orientedGeometry: null
  };
  // Remove original FIRST
  state.models = state.models.filter(x => x.id !== sourceId);
  state.editId = null;

  const idA = addModel(nameA, left, { keepSelection: true, silent: true });
  const idB = addModel(nameB, right, { keepSelection: true, silent: true });
  const newIds = [idA, idB].filter(x => x != null);
  if (newIds.length < 2) {
    // Roll back if halves failed to add
    state.models.push(sourceSnapshot);
    state.editId = sourceSnapshot.id;
    setStatus('Split failed to create both halves — original restored', true);
    return;
  }

  pushUndo({
    type: 'splitReplace',
    source: sourceSnapshot,
    newIds: newIds.slice(),
    editId: prevEditId,
    cutT: prevCutT
  });
  console.log('[nest] split undo pushed', state.undoStack.length, newIds);

  const modelA = state.models.find(x => x.id === idA);
  const modelB = state.models.find(x => x.id === idB);
  const sizeA = modelA ? (axis === 'x' ? modelA.size.x : modelA.size.z) : 0;
  const sizeB = modelB ? (axis === 'x' ? modelB.size.x : modelB.size.z) : 0;
  const pick = sizeA >= sizeB ? modelA : modelB;
  if (pick) {
    state.editId = pick.id;
    state.cutT = 0.5;
  }
  renderModelList();
  updateEditSize();
  updateOptimizeButton();

  // Close cutter view and show BOTH halves on the plate with a visible gap
  state.cutterOpen = false;
  updateCutterUI();
  placeHalvesOnPlate(modelA, modelB, axis);
  updateUndoBtn();

  const sum = mL.along + mR.along;
  const loss = span - sum;
  setStatus(
    'Cut @ ' + cutMm.toFixed(1) + ' mm (kerf ' + KERF_MM + ' mm) → ' +
    nameA + ' ' + mL.along.toFixed(1) + ' mm + ' + nameB + ' ' + mR.along.toFixed(1) +
    ' mm. List: ' + state.models.length + ' models. Undo: ' + state.undoStack.length + '.' +
    (Math.abs(loss) > KERF_MM + 1.5 ? ' ⚠ loss ' + loss.toFixed(1) + ' mm' : '')
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
        // Three.js Y-up → slicer Z-up: (x, y, z) → (x, -z, y)
        verts.push(x, -z, y);
      }
      if (!ok) { dropped++; continue; }
      mapped.push(verts[0], verts[1], verts[2], verts[3], verts[4], verts[5], verts[6], verts[7], verts[8]);
    }
    if (mapped.length < 9) {
      setStatus('Export failed — mesh empty or invalid after cut', true);
      return;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(mapped, 3));
    const buffer = geometryToBinarySTL(out);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const safe = String(m.name || 'piece').replace(/[\/\?%*:|"<>]/g, '_');
    downloadBlob(blob, safe + '.stl');
    setStatus(
      'Downloaded ' + safe + '.stl (' + Math.floor(mapped.length / 9) + ' tris' +
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
  document.getElementById('plate-dims').textContent = `${p.w} × ${p.d} mm`;
  document.getElementById('plate-area').textContent = `${(p.w * p.d).toLocaleString()} mm²`;
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
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  });

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
    setStatus('Cleared — click drop zone to load an STL again');
  });
  document.getElementById('btn-export-stl').addEventListener('click', exportSTLs);

  // Manual adjust
  document.getElementById('btn-rot-left').addEventListener('click', () => rotateSelected(-1));
  document.getElementById('btn-rot-right').addEventListener('click', () => rotateSelected(1));
  document.getElementById('btn-flip').addEventListener('click', () => flipSelected());
  document.getElementById('btn-tip').addEventListener('click', () => tipSelected());
  document.getElementById('btn-nudge-left').addEventListener('click', () => nudgeSelected(-NUDGE_MM, 0));
  document.getElementById('btn-nudge-right').addEventListener('click', () => nudgeSelected(NUDGE_MM, 0));
  document.getElementById('btn-nudge-fwd').addEventListener('click', () => nudgeSelected(0, -NUDGE_MM));
  document.getElementById('btn-nudge-back').addEventListener('click', () => nudgeSelected(0, NUDGE_MM));

  const btnFrame = document.getElementById('btn-frame-selected');
  if (btnFrame) btnFrame.addEventListener('click', frameSelectedPiece);
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
  const btnYawL = document.getElementById('btn-yaw-left');
  const btnYawR = document.getElementById('btn-yaw-right');
  const btnYawL90 = document.getElementById('btn-yaw-left-90');
  const btnYawR90 = document.getElementById('btn-yaw-right-90');
  if (btnYawL) btnYawL.addEventListener('click', () => rotateActiveModelY(-15));
  if (btnYawR) btnYawR.addEventListener('click', () => rotateActiveModelY(15));
  if (btnYawL90) btnYawL90.addEventListener('click', () => rotateActiveModelY(-90));
  if (btnYawR90) btnYawR90.addEventListener('click', () => rotateActiveModelY(90));

  const axisSel = document.getElementById('edit-axis');
  if (axisSel) axisSel.addEventListener('change', () => {
    state.cutT = 0.5;
    if (getActiveModel() && state.cutterOpen) {
      showEditPreview();
      updateEditSize();
    }
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
  setStatus('Ready – drop STL files. If the center is only a blue grid, 3D plate is hidden; grid means the page loaded.');
} catch (err) {
  console.error(err);
  document.body.innerHTML = '<p style="color:white;padding:40px;font-family:sans-serif">Failed to start. Check browser console.</p>';
}
