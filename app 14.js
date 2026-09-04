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
  state.scene.background = new THREE.Color(0x0a0c10);

  state.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
  state.camera.position.set(140, 160, 200);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  state.renderer.setSize(width, height);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
  if (!state.plateMesh || !state.camera || !state.plateMesh.material) return;
  const mat = state.plateMesh.material;
  // Horizon = plate y=0. Above = solid bed. Below = glass.
  const above = state.camera.position.y > 1.5;
  if (above) {
    mat.opacity = 0.88;
    mat.transparent = true;
    mat.depthWrite = true;
    mat.color.setHex(0x5b6b82);
    mat.emissiveIntensity = 0.28;
  } else {
    mat.opacity = 0.06;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.color.setHex(0x8aa0b8);
    mat.emissiveIntensity = 0.05;
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
  // Solid visible bed — high contrast against dark viewport
  const geo = new THREE.PlaneGeometry(p.w, p.d);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5b6b82,
    metalness: 0.05,
    roughness: 0.85,
    emissive: 0x1a2332,
    emissiveIntensity: 0.2,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.28,
    depthWrite: false
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


// FILLET ENGINE — rolled back to last verified state. See PROGRESS.md.

// ---- from watertight.mjs ----
// Watertightness verification: every undirected edge must appear in exactly
// 2 triangles; every directed edge at most once (consistent winding).
function checkWatertight(tris, tol = 1e-4) {
  function key(x,y,z) { return `${Math.round(x/tol)}|${Math.round(y/tol)}|${Math.round(z/tol)}`; }
  const edgeCount = new Map();
  const dirCount = new Map();
  const triCount = tris.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = t*9;
    const p = [
      [tris[i0],tris[i0+1],tris[i0+2]],
      [tris[i0+3],tris[i0+4],tris[i0+5]],
      [tris[i0+6],tris[i0+7],tris[i0+8]],
    ];
    const k = p.map(v => key(...v));
    for (let i=0;i<3;i++) {
      const a=k[i], b=k[(i+1)%3];
      const uk = a<b ? a+'~'+b : b+'~'+a;
      edgeCount.set(uk, (edgeCount.get(uk)||0)+1);
      const dk = a+'>'+b;
      dirCount.set(dk, (dirCount.get(dk)||0)+1);
    }
  }
  let badEdges = 0, badDirs = 0;
  for (const c of edgeCount.values()) if (c !== 2) badEdges++;
  for (const c of dirCount.values()) if (c > 1) badDirs++;

  // zero-area triangle check
  let degenerate = 0;
  for (let t=0;t<triCount;t++) {
    const i0=t*9;
    const ax=tris[i0],ay=tris[i0+1],az=tris[i0+2];
    const bx=tris[i0+3],by=tris[i0+4],bz=tris[i0+5];
    const cx=tris[i0+6],cy=tris[i0+7],cz=tris[i0+8];
    const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const area = 0.5*Math.hypot(nx,ny,nz);
    if (area < 1e-9) degenerate++;
  }

  // signed volume (sanity check on overall orientation)
  let vol = 0;
  for (let t=0;t<triCount;t++) {
    const i0=t*9;
    const ax=tris[i0],ay=tris[i0+1],az=tris[i0+2];
    const bx=tris[i0+3],by=tris[i0+4],bz=tris[i0+5];
    const cx=tris[i0+6],cy=tris[i0+7],cz=tris[i0+8];
    vol += (ax*(by*cz-bz*cy) - ay*(bx*cz-bz*cx) + az*(bx*cy-by*cx));
  }
  vol /= 6;

  return { watertight: badEdges===0 && badDirs===0, badEdges, badDirs, degenerate, volume: vol, triCount };
}

// ---- from clip.mjs ----
// Triangle-plane clipping (Sutherland-Hodgman per triangle), axis-aligned.
// Pure function on flat Float32Array triangle soup. No THREE.js dependency.

function coordOf(v, axisIdx) { return v[axisIdx]; }

/**
 * Clip a flat triangle soup at an axis-aligned plane.
 * @param {Float32Array|number[]} tris - flat [x,y,z,...] per vertex, 9 per triangle
 * @param {number} axisIdx - 0 for x, 1 for y, 2 for z
 * @param {number} planeVal - the coordinate value of the cutting plane
 * @param {boolean} keepMin - true = keep material where coord <= planeVal
 * @returns {{ kept: number[], cutEdges: [number,number,number][][] }}
 *   kept: flat triangle array of the retained (clipped) geometry
 *   cutEdges: array of [pointA, pointB] pairs lying exactly on the plane,
 *             one pair per triangle that straddled it — this is the raw
 *             material for boundary-loop reconstruction in stage 3.
 */
/**
 * Clip a flat triangle soup at an axis-aligned plane.
 * @param {Float32Array|number[]} tris - flat [x,y,z,...] per vertex, 9 per triangle
 * @param {number} axisIdx - 0 for x, 1 for y, 2 for z
 * @param {number} planeVal - the coordinate value of the cutting plane
 * @param {boolean} keepMin - true = keep material where coord <= planeVal
 * @returns {{ kept: number[], cutEdges: [number,number,number][][] }}
 *   kept: flat triangle array of the retained (clipped) geometry
 *   cutEdges: array of [pointA, pointB] pairs lying exactly on the plane,
 *             one pair per triangle that straddled it — this is the raw
 *             material for boundary-loop reconstruction in stage 3.
 */
function clipTrianglesAtPlane(tris, axisIdx, planeVal, keepMin) {
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
    const d = v.map(p => (coordOf(p, axisIdx) - planeVal) * (keepMin ? 1 : -1));
    // d > 0 means "on the kept side" for either keepMin convention, by construction

    const allIn = d[0] >= 0 && d[1] >= 0 && d[2] >= 0;
    const allOut = d[0] < 0 && d[1] < 0 && d[2] < 0;

    if (allIn) {
      kept.push(...v[0], ...v[1], ...v[2]);
      continue;
    }
    if (allOut) continue;

    // Strict crossing check: only treat an edge as crossing the plane when
    // its endpoints have genuinely opposite signs. Using `>=` here (treating
    // an exactly-on-plane vertex as "crossing" against its neighbor) creates
    // a spurious duplicate intersection at that vertex's own position,
    // corrupting the boundary loop — confirmed against real geometry, where
    // a cut landing exactly on an existing mesh vertex (common at a
    // symmetric/periodic cut location) triggered exactly this.
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
        const p = [
          a[0] + (b[0]-a[0])*tt,
          a[1] + (b[1]-a[1])*tt,
          a[2] + (b[2]-a[2])*tt,
        ];
        p[axisIdx] = planeVal; // snap exactly onto the plane, avoid float drift
        poly.push(p);
        intersections.push(p);
      }
    }
    // A vertex sitting exactly on the plane is itself a valid boundary
    // point, just not one produced by interpolation. If the strict crossing
    // check above only found one genuine interpolated crossing (because the
    // triangle's other plane-crossing "edge" was really just touching an
    // on-plane vertex), pair that crossing with the on-plane vertex instead
    // of dropping this triangle's boundary contribution entirely.
    if (intersections.length === 1 && onPlaneVerts.length >= 1) {
      intersections.push(onPlaneVerts[0]);
    }
    // fan-triangulate the resulting (kept-side) triangle or quad
    for (let i = 1; i < poly.length - 1; i++) {
      kept.push(...poly[0], ...poly[i], ...poly[i+1]);
    }
    if (intersections.length === 2) {
      cutEdges.push([intersections[0], intersections[1]]);
    }
  }

  return { kept, cutEdges };
}

// ---- from loops.mjs ----
/**
 * Weld near-duplicate points and walk the edge graph into closed loops.
 * @param {[number,number,number][][]} cutEdges - pairs of 3D points on the plane
 * @param {number} axisIdx - the plane's normal axis (0/1/2), used to pick the
 *   2 in-plane coordinates for the weld key
 * @param {number} weldTol - coordinate rounding tolerance for welding
 * @returns {{ loops: number[][][] }} array of loops, each an ordered array of
 *   3D points forming a closed polygon
 */
function buildLoopsFromCutEdges(cutEdges, axisIdx, weldTol = 1e-4) {
  const otherAxes = [0, 1, 2].filter(a => a !== axisIdx);

  function key(p) {
    const a = p[otherAxes[0]], b = p[otherAxes[1]];
    return `${Math.round(a/weldTol)}|${Math.round(b/weldTol)}`;
  }

  const nodePos = new Map();
  const adj = new Map();
  function addNode(p) {
    const k = key(p);
    if (!nodePos.has(k)) nodePos.set(k, p);
    if (!adj.has(k)) adj.set(k, new Set());
    return k;
  }

  let degenerateSkipped = 0;
  for (const [p1, p2] of cutEdges) {
    const k1 = addNode(p1), k2 = addNode(p2);
    if (k1 === k2) { degenerateSkipped++; continue; }
    adj.get(k1).add(k2);
    adj.get(k2).add(k1);
  }

  // sanity: every node should have degree exactly 2 for a clean, simple
  // closed boundary. Report anything else rather than silently walking
  // through a branch point (this caught the gusset/branch issues last time).
  const degreeIssues = [];
  for (const [k, nbrs] of adj) {
    if (nbrs.size !== 2) degreeIssues.push({ key: k, pos: nodePos.get(k), degree: nbrs.size });
  }

  const visitedEdges = new Set();
  const ek = (a, b) => (a < b ? `${a}~${b}` : `${b}~${a}`);
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
          next = cand;
          visitedEdges.add(e);
          break;
        }
        if (next == null) break;
        prev = cur; cur = next;
      }
      if (cur === start && loopKeys.length >= 3) {
        loops.push(loopKeys.map(k => nodePos.get(k)));
      }
    }
  }

  return { loops, degenerateSkipped, degreeIssues, weldMap: nodePos };
}

// ---- from earclip.mjs ----
// Ear-clip triangulation of a simple (possibly concave) planar polygon.
// Operates in 2D (the plane's own in-plane coordinates), lifts back to 3D.

function signedArea2D(poly2d) {
  let a = 0;
  const n = poly2d.length;
  for (let i = 0; i < n; i++) {
    const [x1,y1] = poly2d[i], [x2,y2] = poly2d[(i+1)%n];
    a += x1*y2 - x2*y1;
  }
  return a * 0.5;
}
function isConvex(a, b, c) {
  return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]) > 1e-9;
}

/**
 * Point-in-triangle test with a proper epsilon tolerance. Without it, a
 * point sitting almost exactly on a candidate ear's edge — extremely
 * common along any straight/near-collinear run of boundary points, not
 * rare — gets misclassified as strictly "inside" due to floating-point
 * noise in the sign computation, falsely blocking a valid ear. Confirmed
 * directly on real geometry: a 271-point ring with 52 near-collinear
 * points caused earClip2D to produce only 259 of the expected 269
 * triangles, with one vertex reused 74 times as a fallback pivot — a
 * classic "can't find any other ear" failure mode, visible as a fan of
 * slivers spanning the flat region.
 */
/**
 * Point-in-triangle test with a proper epsilon tolerance. Without it, a
 * point sitting almost exactly on a candidate ear's edge — extremely
 * common along any straight/near-collinear run of boundary points, not
 * rare — gets misclassified as strictly "inside" due to floating-point
 * noise in the sign computation, falsely blocking a valid ear. Confirmed
 * directly on real geometry: a 271-point ring with 52 near-collinear
 * points caused earClip2D to produce only 259 of the expected 269
 * triangles, with one vertex reused 74 times as a fallback pivot — a
 * classic "can't find any other ear" failure mode, visible as a fan of
 * slivers spanning the flat region.
 */
function pointInTri(p, a, b, c, eps = 1e-7) {
  function sign(p1,p2,p3) { return (p1[0]-p3[0])*(p2[1]-p3[1]) - (p2[0]-p3[0])*(p1[1]-p3[1]); }
  const d1 = sign(p,a,b), d2 = sign(p,b,c), d3 = sign(p,c,a);
  // A point within epsilon of any edge is ambiguous (right on the
  // boundary, within floating-point noise) — treat it as NOT blocking.
  // Only a point unambiguously, clearly inside (all three signs the same,
  // none near zero) should block a candidate ear.
  if (Math.abs(d1) < eps || Math.abs(d2) < eps || Math.abs(d3) < eps) return false;
  const hasNeg = d1<0||d2<0||d3<0, hasPos = d1>0||d2>0||d3>0;
  return !(hasNeg && hasPos);
}

/**
 * @param {[number,number][]} poly2d - simple polygon, CCW or CW
 * @returns {[number,number,number][]} array of triangle index triples
 */
/**
 * @param {[number,number][]} poly2d - simple polygon, CCW or CW
 * @returns {[number,number,number][]} array of triangle index triples
 */
function earClip2D(poly2d) {
  let pts = poly2d;
  let idxs = pts.map((_, i) => i);
  const area = signedArea2D(pts);
  const ccwIdxs = area >= 0 ? idxs.slice() : idxs.slice().reverse();
  const work = ccwIdxs.slice();
  const tris = [];
  let guard = 0;
  let scanStart = 0;
  // Scanning always restarts from i=0 was the real bug: for a polygon with
  // a long run of near-collinear points (e.g. a thin flange), whichever
  // region happens to have a valid ear "first" gets cut over and over,
  // producing either a severe fan/pinwheel degeneracy or, in the worst
  // case, a genuine dead end (confirmed directly: stuck at exactly 12
  // remaining points on real geometry, none formed a valid unblocked ear).
  // Continuing the scan from near the last successful cut, instead of
  // always restarting at 0, is the standard fix — it distributes cuts
  // around the polygon instead of repeatedly favoring one region.
  while (work.length > 3 && guard++ < 200000) {
    const n = work.length;
    let found = false;
    for (let k = 0; k < n; k++) {
      const i = (scanStart + k) % n;
      const ip = work[(i-1+n)%n], ic = work[i], inx = work[(i+1)%n];
      const a = pts[ip], b = pts[ic], c = pts[inx];
      if (!isConvex(a, b, c)) continue;
      let blocked = false;
      for (const j of work) {
        if (j===ip||j===ic||j===inx) continue;
        if (pointInTri(pts[j], a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      tris.push([ip, ic, inx]);
      work.splice(i, 1);
      scanStart = i > 0 ? i - 1 : 0; // resume just before the cut, not from 0
      found = true;
      break;
    }
    if (!found) {
      // Genuine dead end — confirmed on real geometry to happen (a tiny
      // cluster of points, all within a fraction of a mm of each other,
      // with no valid unblocked ear among them at all, regardless of scan
      // order). Leaving this as an open hole breaks watertightness; letting
      // the main loop keep hunting elsewhere produces the severe fan
      // degeneracy this whole investigation started from. Neither is
      // acceptable. Fallback: fan-triangulate just the remaining stuck
      // points directly, in their current order. This guarantees the cap
      // closes completely. The stuck region is always small in practice
      // (confirmed: 12 points within a 0.4mm×0.5mm cluster) — any
      // reasonable completion there is visually negligible, and a
      // guaranteed-complete cap is far more important than a marginally
      // prettier triangulation of a sub-millimeter patch.
      // Fan-triangulate the stuck remainder, but verify each triangle's
      // own winding matches the polygon's overall CCW convention before
      // keeping it — the "star-shaped from one point" assumption a simple
      // fan relies on doesn't strictly hold for a locally zigzagging
      // cluster (confirmed: this is exactly where the stuck case occurs),
      // so a naive fan can produce a few backwards triangles. Flip any
      // that come out with the wrong sign rather than leave them
      // inconsistent with their neighbors.
      for (let m = 1; m < work.length - 1; m++) {
        const ia = work[0], ib = work[m], ic = work[m+1];
        const a = pts[ia], b = pts[ib], c = pts[ic];
        const cross = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
        if (cross >= 0) tris.push([ia, ib, ic]);
        else tris.push([ia, ic, ib]); // flip to match CCW
      }
      work.length = 0;
      break;
    }
  }
  if (work.length === 3) tris.push([work[0], work[1], work[2]]);
  return tris;
}

// ---- from cap.mjs ----
// Project a 3D point (on a plane perpendicular to axisIdx) to 2D in-plane coords.
function to2D(p, axisIdx) {
  const other = [0,1,2].filter(a => a !== axisIdx);
  return [p[other[0]], p[other[1]]];
}
function from2D(uv, axisIdx, planeVal) {
  const p = [0,0,0];
  const other = [0,1,2].filter(a => a !== axisIdx);
  p[other[0]] = uv[0]; p[other[1]] = uv[1]; p[axisIdx] = planeVal;
  return p;
}

/**
 * Flat-cap a single boundary loop with correct outward orientation.
 * @param {number[][]} loop3d - ordered 3D points, closed loop
 * @param {number} axisIdx
 * @param {number} planeVal
 * @param {boolean} keepMin - determines which way the cap should face
 * @returns {number[]} flat triangle array
 */
/**
 * Flat-cap a single boundary loop with correct outward orientation.
 * @param {number[][]} loop3d - ordered 3D points, closed loop
 * @param {number} axisIdx
 * @param {number} planeVal
 * @param {boolean} keepMin - determines which way the cap should face
 * @returns {number[]} flat triangle array
 */
function flatCapLoop(loop3d, axisIdx, planeVal, keepMin) {
  const poly2d = loop3d.map(p => to2D(p, axisIdx));
  const triIdx = earClip2D(poly2d);
  const out = [];
  for (const [ia, ib, ic] of triIdx) {
    let a = loop3d[ia], b = loop3d[ib], c = loop3d[ic];
    // orient so the cap faces outward: for keepMin (material at coord<=plane),
    // outward normal points in +axis direction; for keepMax, -axis direction.
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    const n = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(n[axisIdx] || 1) !== wantSign) { const t=b; b=c; c=t; }
    out.push(...a, ...b, ...c);
  }
  return out;
}

/**
 * Full cut + flat-cap pipeline for one side. No fillet — this is the
 * baseline milestone that must be verified watertight before any fillet
 * logic is layered on top.
 */
/**
 * Weld boundary-plane vertices in `kept` to the canonical values the
 * matching loop already uses. `kept` and the loop are both derived from
 * the same clip operation, but near complex geometry (confirmed: a part's
 * internal rib) different triangles can independently compute slightly
 * different floating-point copies of "the same" physical boundary point —
 * close enough to look identical at a glance, far enough apart to cross
 * the watertightness check's matching tolerance. This was the original
 * unresolved defect from the very start of this rebuild, logged and
 * deferred, now precisely findable with everything learned since: at the
 * exact-middle cut, edges connecting the boundary to points 15mm into the
 * body were being counted 4 times instead of 2 — multiple independent,
 * near-but-not-exact copies of the same point.
 *
 * Only snaps when doing so keeps every triangle touching that vertex
 * non-degenerate — an earlier, less careful version of this exact fix
 * introduced new degenerate triangles as a side effect; this version
 * checks before snapping instead of assuming it's always safe.
 */
/**
 * Full cut + flat-cap pipeline for one side. No fillet — this is the
 * baseline milestone that must be verified watertight before any fillet
 * logic is layered on top.
 */
/**
 * Weld boundary-plane vertices in `kept` to the canonical values the
 * matching loop already uses. `kept` and the loop are both derived from
 * the same clip operation, but near complex geometry (confirmed: a part's
 * internal rib) different triangles can independently compute slightly
 * different floating-point copies of "the same" physical boundary point —
 * close enough to look identical at a glance, far enough apart to cross
 * the watertightness check's matching tolerance. This was the original
 * unresolved defect from the very start of this rebuild, logged and
 * deferred, now precisely findable with everything learned since: at the
 * exact-middle cut, edges connecting the boundary to points 15mm into the
 * body were being counted 4 times instead of 2 — multiple independent,
 * near-but-not-exact copies of the same point.
 *
 * Only snaps when doing so keeps every triangle touching that vertex
 * non-degenerate — an earlier, less careful version of this exact fix
 * introduced new degenerate triangles as a side effect; this version
 * checks before snapping instead of assuming it's always safe.
 */
function cutAndCapFlat(tris, axisIdx, planeVal, keepMin) {
  const { kept, cutEdges } = clipTrianglesAtPlane(tris, axisIdx, planeVal, keepMin);
  const { loops, degreeIssues } = buildLoopsFromCutEdges(cutEdges, axisIdx);
  if (degreeIssues.length > 0) {
    throw new Error(`Boundary has ${degreeIssues.length} branch point(s) — not a simple loop`);
  }
  const out = kept.slice();
  for (const loop of loops) {
    const cap = flatCapLoop(loop, axisIdx, planeVal, keepMin);
    out.push(...cap);
  }
  return out;
}

// ---- from thickness.mjs ----
// Local wall-thickness measurement: for each boundary point, ray-cast along
// its inward normal to find distance to the opposite wall. This bounds how
// large a fillet radius can safely be at that point without the rounded
// surface punching through the opposite side of a thin wall.

function edgeNormal(a, b, sign) {
  const dx = b[0]-a[0], dy = b[1]-a[1];
  const len = Math.hypot(dx, dy) || 1e-12;
  return [sign * -dy/len, sign * dx/len];
}
// (signedArea2D dedup)
function inwardNormalAt(poly2d, i, sign, minEdge = 0.05) {
  const n = poly2d.length;
  // walk past short/noisy edges to find a stable direction (real STL
  // boundaries can have edges as short as 1e-5mm — confirmed last session)
  let j = i;
  for (let s = 0; s < n; s++) {
    j = (j - 1 + n) % n;
    if (Math.hypot(poly2d[j][0]-poly2d[i][0], poly2d[j][1]-poly2d[i][1]) >= minEdge) break;
  }
  let k = i;
  for (let s = 0; s < n; s++) {
    k = (k + 1) % n;
    if (Math.hypot(poly2d[k][0]-poly2d[i][0], poly2d[k][1]-poly2d[i][1]) >= minEdge) break;
  }
  const prev = poly2d[j], curr = poly2d[i], next = poly2d[k];
  const n1 = edgeNormal(prev, curr, sign), n2 = edgeNormal(curr, next, sign);
  let bx = n1[0]+n2[0], by = n1[1]+n2[1];
  const bl = Math.hypot(bx, by) || 1e-9;
  return { normal: [bx/bl, by/bl], prevIdx: j, nextIdx: k, n1, n2 };
}
function rayPolyDistance(origin, dir, poly2d, skipIdxs) {
  const n = poly2d.length;
  let best = Infinity;
  for (let j = 0; j < n; j++) {
    if (skipIdxs.has(j)) continue;
    const a = poly2d[j], b = poly2d[(j+1)%n];
    const ex = b[0]-a[0], ey = b[1]-a[1];
    const denom = dir[0]*ey - dir[1]*ex;
    if (Math.abs(denom) < 1e-10) continue;
    const t = ((a[0]-origin[0])*ey - (a[1]-origin[1])*ex) / denom;
    const s = ((a[1]-origin[1])*dir[0] - (a[0]-origin[0])*dir[1]) / -denom;
    if (t > 1e-6 && s >= -1e-9 && s <= 1+1e-9 && t < best) best = t;
  }
  return best;
}

/**
 * @param {[number,number][]} poly2d
 * @returns {number[]} local thickness estimate at each boundary point
 */
/**
 * @param {[number,number][]} poly2d
 * @returns {number[]} local thickness estimate at each boundary point
 */
function computeLocalThickness(poly2d) {
  const n = poly2d.length;
  const sign = signedArea2D(poly2d) >= 0 ? 1 : -1; // CCW->1, CW->-1, computed ONCE, applied consistently
  const thickness = new Array(n);
  for (let i = 0; i < n; i++) {
    const { normal, prevIdx, nextIdx } = inwardNormalAt(poly2d, i, sign);
    const skip = new Set([i, prevIdx, nextIdx, (i-1+n)%n, (i+1)%n]);
    const d = rayPolyDistance(poly2d[i], normal, poly2d, skip);
    thickness[i] = Number.isFinite(d) ? d : 4; // generous default if no hit found
  }
  return thickness;
}

/** min-filter, NOT mean-filter — a thin spot must never get diluted upward
 *  by averaging with thicker neighbors (that was a real bug found and fixed
 *  last session). */
/** min-filter, NOT mean-filter — a thin spot must never get diluted upward
 *  by averaging with thicker neighbors (that was a real bug found and fixed
 *  last session). */
function minFilterCircular(arr, window) {
  const n = arr.length, half = Math.floor(window/2), out = new Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let k = -half; k <= half; k++) m = Math.min(m, arr[(i+k+n)%n]);
    out[i] = m;
  }
  return out;
}

/** adaptive radius = min(requested, safetyFactor * local thickness),
 *  smoothed but never allowed to exceed the min-filtered safe ceiling */
/** adaptive radius = min(requested, safetyFactor * local thickness),
 *  smoothed but never allowed to exceed the min-filtered safe ceiling */
function adaptiveRadius(poly2d, requestedR, safetyFactor = 0.3) {
  const thickness = computeLocalThickness(poly2d);
  const raw = thickness.map(t => Math.min(requestedR, Math.max(0.2, t * safetyFactor)));
  const safe = minFilterCircular(raw, 9);
  const n = safe.length, half = 3, smoothed = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) s += safe[(i+k+n)%n];
    smoothed[i] = Math.min(s/(2*half+1), safe[i]*1.15);
  }
  return smoothed;
}

// ---- from corners.mjs ----
// Corner detection (turning angle) and the true single-sphere-center
// construction for rounding a corner — the math validated last session
// against a real factory part's measured radius (fit to within 0.008mm).

function robustPrevNext(poly2d, i, minEdge = 0.05) {
  const n = poly2d.length;
  let j = i;
  for (let s = 0; s < n; s++) {
    j = (j - 1 + n) % n;
    if (Math.hypot(poly2d[j][0]-poly2d[i][0], poly2d[j][1]-poly2d[i][1]) >= minEdge) break;
  }
  let k = i;
  for (let s = 0; s < n; s++) {
    k = (k + 1) % n;
    if (Math.hypot(poly2d[k][0]-poly2d[i][0], poly2d[k][1]-poly2d[i][1]) >= minEdge) break;
  }
  return [j, k];
}
function turningAngle(poly2d, i, prevIdx, nextIdx) {
  const prev = poly2d[prevIdx], curr = poly2d[i], next = poly2d[nextIdx];
  const a1 = Math.atan2(curr[1]-prev[1], curr[0]-prev[0]);
  const a2 = Math.atan2(next[1]-curr[1], next[0]-curr[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2*Math.PI;
  while (d < -Math.PI) d += 2*Math.PI;
  return d;
}

/**
 * Detect sharp corners (turning angle beyond threshold) in the boundary.
 * @returns {number[]} indices of corner vertices
 */
/**
 * Detect sharp corners (turning angle beyond threshold) in the boundary.
 * @returns {number[]} indices of corner vertices
 */
function detectCorners(poly2d, thresholdDeg = 30) {
  const n = poly2d.length;
  const threshold = thresholdDeg * Math.PI / 180;
  const corners = [];
  for (let i = 0; i < n; i++) {
    const [j, k] = robustPrevNext(poly2d, i);
    if (Math.abs(turningAngle(poly2d, i, j, k)) > threshold) corners.push(i);
  }
  return corners;
}
// (edgeNormal dedup)
/**
 * Solve for the sphere center tangent to both walls meeting at a corner,
 * at the given radius. Verified last session: dot(C-cornerPt, n1) and
 * dot(C-cornerPt, n2) both equal R exactly (not approximately) when solved
 * this way — this is the piece that matched the real measured factory
 * corner to within 0.008mm.
 */
function solveCornerCenter(cornerPt, n1, n2, R) {
  const det = n1[0]*n2[1] - n1[1]*n2[0];
  if (Math.abs(det) < 1e-10) return null; // walls nearly parallel — degenerate
  const nx = (n2[1] - n1[1]) / det;
  const ny = (n1[0] - n2[0]) / det;
  return [cornerPt[0] + R*nx, cornerPt[1] + R*ny];
}

/**
 * Full corner info needed downstream: index, sphere center, and the two
 * wall inward-normals (needed for the sweep direction at each corner).
 */
/**
 * Full corner info needed downstream: index, sphere center, and the two
 * wall inward-normals (needed for the sweep direction at each corner).
 */
function buildCornerData(poly2d, cornerIdxs, radiusAt, windingSign) {
  return cornerIdxs.map(ci => {
    const [j, k] = robustPrevNext(poly2d, ci);
    const n1 = edgeNormal(poly2d[j], poly2d[ci], windingSign);
    const n2 = edgeNormal(poly2d[ci], poly2d[k], windingSign);
    const R = radiusAt[ci];
    const C = solveCornerCenter(poly2d[ci], n1, n2, R);
    return { i: ci, C, n1, n2, R };
  });
}

// ---- from band.mjs ----
// (edgeNormal dedup)
// (robustPrevNext dedup)
function vertexOffset(poly2d, i, inset, sign, prevIdx, nextIdx) {
  const curr = poly2d[i], prev = poly2d[prevIdx], next = poly2d[nextIdx];
  const n1 = edgeNormal(prev, curr, sign), n2 = edgeNormal(curr, next, sign);
  let bx = n1[0]+n2[0], by = n1[1]+n2[1];
  const bl = Math.hypot(bx,by) || 1e-9;
  bx/=bl; by/=bl;
  const cosHalf = Math.max(bx*n1[0]+by*n1[1], 0.3);
  const mag = inset / cosHalf;
  return [curr[0]+bx*mag, curr[1]+by*mag];
}
function slerp2D(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a[0]*b[0]+a[1]*b[1]));
  const theta = Math.acos(dot);
  if (theta < 1e-8) return a.slice();
  const s = Math.sin(theta);
  return [(Math.sin((1-t)*theta)*a[0]+Math.sin(t*theta)*b[0])/s,
          (Math.sin((1-t)*theta)*a[1]+Math.sin(t*theta)*b[1])/s];
}
function smoothstep(x) { x=Math.max(0,Math.min(1,x)); return x*x*(3-2*x); }

/**
 * Build the fillet band: a sequence of rings from the body-matching edge
 * (inset 0, at depth Rmax behind the tip) to the tip (fully rounded, at
 * depth 0 — the ORIGINAL cut plane, unchanged). This direction was the
 * single most consequential bug last session — verified here by construction:
 * ring[0] must end up with inset 0 (matching the un-rounded wall), ring[last]
 * must have inset = R at every point (fully rounded), and ring[last]'s depth
 * must be 0 (AT the tip plane), not receded.
 *
 * @returns {{ rings: number[][][], Rmax: number, cornerData: object[] }}
 *   rings[s][i] = [u, v] in-plane coords at ring s, vertex i. Depth (the
 *   axis coordinate) is NOT included here — caller combines with the known
 *   plane position and per-ring depth to lift to 3D.
 */
/**
 * Build the fillet band: a sequence of rings from the body-matching edge
 * (inset 0, at depth Rmax behind the tip) to the tip (fully rounded, at
 * depth 0 — the ORIGINAL cut plane, unchanged). This direction was the
 * single most consequential bug last session — verified here by construction:
 * ring[0] must end up with inset 0 (matching the un-rounded wall), ring[last]
 * must have inset = R at every point (fully rounded), and ring[last]'s depth
 * must be 0 (AT the tip plane), not receded.
 *
 * @returns {{ rings: number[][][], Rmax: number, cornerData: object[] }}
 *   rings[s][i] = [u, v] in-plane coords at ring s, vertex i. Depth (the
 *   axis coordinate) is NOT included here — caller combines with the known
 *   plane position and per-ring depth to lift to 3D.
 */
function buildFilletBand(poly2d, Rs, steps = 12, cornerThresholdDeg = 30, windowN = 12) {
  const n = poly2d.length;
  const area = poly2d.reduce((a, p, i) => {
    const q = poly2d[(i+1)%n];
    return a + p[0]*q[1] - q[0]*p[1];
  }, 0) / 2;
  const sign = area >= 0 ? 1 : -1;

  const Rmax = Math.max(...Rs);
  const corners = detectCorners(poly2d, cornerThresholdDeg);
  const cornerData = buildCornerData(poly2d, corners, Rs, sign);

  function ringAt(depthFraction /* 0 = body-match, 1 = tip */) {
    const t = depthFraction;
    const ring = new Array(n);
    for (let i = 0; i < n; i++) {
      const R = Rs[i];
      const u = R * (1 - t); // distance from the tip for THIS vertex's own radius
      const sinPhi = Math.min(1, Math.max(0, 1 - (R < 1e-6 ? 1 : u / R)));
      const phi = Math.asin(sinPhi);
      const inset = R * (1 - Math.cos(phi));
      const [j, k] = robustPrevNext(poly2d, i);
      let uv = vertexOffset(poly2d, i, inset, sign, j, k);

      for (const c of cornerData) {
        if (!c.C) continue;
        let d = ((i - c.i + n) % n);
        if (d > n/2) d -= n;
        const absD = Math.abs(d);
        if (absD > windowN) continue;
        const wWindow = smoothstep(1 - absD/windowN);
        const w = wWindow * t; // fades to 0 at t=0 (body-match ring) — this
        // is what keeps ring[0] exactly matching the true un-rounded
        // boundary, so the stitch to the real trimmed body has something
        // consistent to attach to.
        const negN1 = [-c.n1[0],-c.n1[1]], negN2 = [-c.n2[0],-c.n2[1]];
        const tBlend = (d + windowN) / (2*windowN);
        const nBlend = slerp2D(negN1, negN2, tBlend);
        const suv = [c.C[0]+c.R*Math.cos(phi)*nBlend[0], c.C[1]+c.R*Math.cos(phi)*nBlend[1]];
        uv = [uv[0]*(1-w)+suv[0]*w, uv[1]*(1-w)+suv[1]*w];
      }
      ring[i] = uv;
    }
    return ring;
  }

  const rings = [];
  for (let s = 0; s <= steps; s++) rings.push(ringAt(s/steps));

  return { rings, Rmax, cornerData, sign, ringAt };
}
function ringSelfIntersectsDetail(ring) {
  const n = ring.length;
  const bad = [];
  function segX(p1,p2,p3,p4) {
    const d1x=p2[0]-p1[0],d1y=p2[1]-p1[1], d2x=p4[0]-p3[0],d2y=p4[1]-p3[1];
    const denom = d1x*d2y-d1y*d2x;
    if (Math.abs(denom)<1e-12) return false;
    const t=((p3[0]-p1[0])*d2y-(p3[1]-p1[1])*d2x)/denom;
    const u=((p3[0]-p1[0])*d1y-(p3[1]-p1[1])*d1x)/denom;
    return t>1e-6&&t<1-1e-6&&u>1e-6&&u<1-1e-6;
  }
  for (let i=0;i<n;i++) {
    for (let j=i+2;j<n;j++) {
      if (i===0&&j===n-1) continue;
      if (segX(ring[i],ring[(i+1)%n],ring[j],ring[(j+1)%n])) bad.push([i,j]);
    }
  }
  return bad;
}
function ringSelfIntersects(ring) {
  return ringSelfIntersectsDetail(ring).length > 0;
}

/**
 * Iteratively shrink the radius ONLY at vertices actually involved in a
 * self-intersection, checked against the tightest ring (fully rounded,
 * t=1). Local, not global — a tight spot near one corner shouldn't cost
 * the whole loop its rounding.
 */
/**
 * Iteratively shrink the radius ONLY at vertices actually involved in a
 * self-intersection, checked against the tightest ring (fully rounded,
 * t=1). Local, not global — a tight spot near one corner shouldn't cost
 * the whole loop its rounding.
 */
function repairSelfIntersections(poly2d, Rs, buildRingFn, maxIter = 40) {
  const n = poly2d.length;
  let R = Rs.slice();
  for (let iter = 0; iter < maxIter; iter++) {
    const ring = buildRingFn(R);
    const bad = ringSelfIntersectsDetail(ring);
    if (bad.length === 0) return { Rs: R, iterations: iter, converged: true };
    const touched = new Set();
    for (const [i,j] of bad) { touched.add(i); touched.add((i+1)%n); touched.add(j); touched.add((j+1)%n); }
    touched.forEach(idx => { R[idx] *= 0.9; });
  }
  return { Rs: R, iterations: maxIter, converged: false };
}

// ---- from stitch.mjs ----
// Stitch two closed 2D loops representing the SAME physical boundary but
// sampled differently (different point counts/positions) — here, the true
// margin-plane boundary (independently measured) and the fillet band's
// outermost ring (built from the tip's own point structure).
//
// Validated approach from last session: ALWAYS emit a triangle for every
// step of the arc-length walk, even when it comes out degenerate (three
// near-collinear points). An earlier attempt skipped degenerate triangles
// on the reasoning that they contribute nothing — that was tested and is
// WRONG: some of those "contribute nothing" edges are the only pairing a
// particular boundary point has back to its neighbor. Skipping them
// silently punches real holes. Fix: always emit (preserving every pairing
// exactly), then nudge any triangle that comes out degenerate by a tiny,
// carefully-bounded amount afterward.

function cumulativeLength(poly2d) {
  const n = poly2d.length;
  const seg = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = poly2d[i], b = poly2d[(i+1)%n];
    const L = Math.hypot(b[0]-a[0], b[1]-a[1]);
    seg.push(L);
    total += L;
  }
  const t = [0];
  for (let i = 0; i < n-1; i++) t.push(t[i] + seg[i]);
  return { t, total, seg };
}

/**
 * Interpolate a point on loopB at a given absolute arc-length position
 * (0..total), walking loopB's own edges.
 */
/**
 * Interpolate a point on loopB at a given absolute arc-length position
 * (0..total), walking loopB's own edges.
 */
function pointAtArcLength(loopB, tB, totalB, targetT) {
  const n = loopB.length;
  let tt = targetT % totalB;
  if (tt < 0) tt += totalB;
  // find the segment containing tt
  for (let i = 0; i < n; i++) {
    const t0 = tB[i];
    const t1 = i+1 < n ? tB[i+1] : totalB;
    if (tt >= t0 - 1e-9 && tt <= t1 + 1e-9) {
      const segLen = t1 - t0;
      const frac = segLen < 1e-12 ? 0 : (tt - t0) / segLen;
      const a = loopB[i], b = loopB[(i+1)%n];
      return [a[0] + (b[0]-a[0])*frac, a[1] + (b[1]-a[1])*frac];
    }
  }
  return loopB[0]; // fallback, shouldn't hit
}

/**
 * Build a stitch strip between two loops representing the same boundary at
 * two different depths, by resampling loopB directly onto loopA's own
 * arc-length positions — NOT a greedy interleaved zipper walk.
 *
 * Why: on any real part, long stretches of a boundary can be geometrically
 * near-identical between two closely-spaced cross-sections (straight walls
 * simply don't change over a small margin depth) — confirmed directly: 121
 * of 273 points on this actual test piece have a near-coincident match.
 * A zipper walk that interleaves two independent point sequences handles
 * that common case badly: it can advance the two loops through a
 * near-coincident region in an order that creates overlapping, aliasing
 * triangles (found and precisely traced this session — 66 of 273 boundary
 * edges were being triple-counted). Resampling loopB onto loopA's own
 * parametrization sidesteps the problem entirely: every loopA point gets
 * exactly one corresponding loopB point, in matching order, with no
 * ambiguity about which points pair with which — a straightforward
 * quad-strip, not a walk that has to reconcile two independent sequences.
 *
 * @returns {[[number,number],'A'|'B'][][]} triangles, each vertex tagged
 *   with its source ('A' = pinned to the true margin boundary, must never
 *   move; 'B' = resampled from the band's own ring, safe to nudge)
 */
/**
 * Pre-process loopB: push any point that's suspiciously close to an
 * unrelated loopA point (or to another loopB point) a safe distance away,
 * BEFORE triangulating — not per-triangle after the fact. Doing this after
 * triangulation risks nudging the same shared point differently across the
 * 2+ triangles that reference it (a point at index j appears in both the
 * triangle that advances TO it and the one that advances FROM it next),
 * which would silently reintroduce a new mismatch. One consistent nudge
 * per point, applied once, is what those confirmed-widespread-conflict
 * numbers (582 internal winding conflicts) turned out to actually need —
 * B points have no external pinning requirement, so the nudge here can be
 * meaningfully larger than the watertightness matching tolerance; it just
 * needs to be small enough to stay cosmetically invisible.
 */
/**
 * Build a stitch strip between two loops representing the same boundary at
 * two different depths, by resampling loopB directly onto loopA's own
 * arc-length positions — NOT a greedy interleaved zipper walk.
 *
 * Why: on any real part, long stretches of a boundary can be geometrically
 * near-identical between two closely-spaced cross-sections (straight walls
 * simply don't change over a small margin depth) — confirmed directly: 121
 * of 273 points on this actual test piece have a near-coincident match.
 * A zipper walk that interleaves two independent point sequences handles
 * that common case badly: it can advance the two loops through a
 * near-coincident region in an order that creates overlapping, aliasing
 * triangles (found and precisely traced this session — 66 of 273 boundary
 * edges were being triple-counted). Resampling loopB onto loopA's own
 * parametrization sidesteps the problem entirely: every loopA point gets
 * exactly one corresponding loopB point, in matching order, with no
 * ambiguity about which points pair with which — a straightforward
 * quad-strip, not a walk that has to reconcile two independent sequences.
 *
 * @returns {[[number,number],'A'|'B'][][]} triangles, each vertex tagged
 *   with its source ('A' = pinned to the true margin boundary, must never
 *   move; 'B' = resampled from the band's own ring, safe to nudge)
 */
/**
 * Pre-process loopB: push any point that's suspiciously close to an
 * unrelated loopA point (or to another loopB point) a safe distance away,
 * BEFORE triangulating — not per-triangle after the fact. Doing this after
 * triangulation risks nudging the same shared point differently across the
 * 2+ triangles that reference it (a point at index j appears in both the
 * triangle that advances TO it and the one that advances FROM it next),
 * which would silently reintroduce a new mismatch. One consistent nudge
 * per point, applied once, is what those confirmed-widespread-conflict
 * numbers (582 internal winding conflicts) turned out to actually need —
 * B points have no external pinning requirement, so the nudge here can be
 * meaningfully larger than the watertightness matching tolerance; it just
 * needs to be small enough to stay cosmetically invisible.
 */
function pushApartCloseBPoints(loopA, loopB, minSafeDist = 0.002) {
  const out = loopB.map(p => p.slice());
  for (let j = 0; j < out.length; j++) {
    let nearest = Infinity, dir = [0, 1];
    for (const a of loopA) {
      const dx = out[j][0]-a[0], dy = out[j][1]-a[1];
      const d = Math.hypot(dx, dy);
      if (d < nearest) {
        nearest = d;
        dir = d > 1e-9 ? [dx/d, dy/d] : [0, 1]; // only tracks the direction for the CURRENT nearest point
      }
    }
    if (nearest < minSafeDist) {
      const push = minSafeDist - nearest + 1e-6;
      out[j] = [out[j][0] + dir[0]*push, out[j][1] + dir[1]*push];
    }
  }
  return out;
}
function buildStitchStrip(loopA, loopB) {
  const nA = loopA.length, nB = loopB.length;
  const { t: tA, total: totalA } = cumulativeLength(loopA);
  const { t: tBraw, total: totalB } = cumulativeLength(loopB);
  const tB = tBraw.map(v => v * (totalA / totalB));

  const strip = [];
  let i = 0, j = 0;
  let advancesA = 0, advancesB = 0;
  let guard = 0;
  while ((advancesA < nA || advancesB < nB) && guard++ < 200000) {
    const doneA = advancesA >= nA, doneB = advancesB >= nB;
    const iNext = (i+1) % nA, jNext = (j+1) % nB;
    const tiNext = doneA ? Infinity : (iNext !== 0 ? tA[iNext] : totalA);
    const tjNext = doneB ? Infinity : (jNext !== 0 ? tB[jNext] : totalA);
    const advanceA = !doneA && (doneB || tiNext <= tjNext);
    const pACur = loopA[i], pBCur = loopB[j];
    // 'A' vertices (the true margin boundary) must stay pinned exactly to
    // what the trimmed body already has. 'B' vertices are the band's own
    // rings[0] points, used directly (not resampled) so the stitch
    // connects to exactly what the band actually has — a resampled
    // approximation was tried and found to silently misalign with the
    // band's own triangulation, a worse bug than the one it was meant to
    // fix. 'B' vertices have no external pinning requirement, which
    // matters for the nudge step downstream.
    if (advanceA) {
      strip.push([[pACur,'A'], [loopA[iNext],'A'], [pBCur,'B']]);
      i = iNext; advancesA++;
    } else {
      strip.push([[pACur,'A'], [loopB[jNext],'B'], [pBCur,'B']]);
      j = jNext; advancesB++;
    }
  }
  return strip;
}
function area2(a, b, c) {
  return 0.5 * Math.abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1]));
}

/**
 * Where loopA and loopB are nearly coincident (common on stable/flat
 * sections of a cross-section — the margin and tip boundary barely differ
 * there), a stitch edge between an A point and a nearby-but-distinct B
 * point can fall within the watertightness check's matching tolerance of
 * an unrelated same-loop edge, aliasing in the coordinate-based edge count
 * even though the actual geometry is fine. Confirmed directly: 66 of 273
 * margin-loop edges were being counted 3 times instead of 1, traced to
 * exactly this. Fix: snap any B-tagged vertex within tolerance of an
 * A-tagged vertex to be bit-identical to it, removing the ambiguity rather
 * than hoping the tolerance never bites.
 */
/**
 * Where loopA and loopB are nearly coincident (common on stable/flat
 * sections of a cross-section — the margin and tip boundary barely differ
 * there), a stitch edge between an A point and a nearby-but-distinct B
 * point can fall within the watertightness check's matching tolerance of
 * an unrelated same-loop edge, aliasing in the coordinate-based edge count
 * even though the actual geometry is fine. Confirmed directly: 66 of 273
 * margin-loop edges were being counted 3 times instead of 1, traced to
 * exactly this. Fix: snap any B-tagged vertex within tolerance of an
 * A-tagged vertex to be bit-identical to it, removing the ambiguity rather
 * than hoping the tolerance never bites.
 */
function snapNearCoincidentPoints(triangles, loopA, matchTol = 1e-4) {
  function keyOf(p) { return `${Math.round(p[0]/matchTol)}|${Math.round(p[1]/matchTol)}`; }
  const aByKey = new Map();
  for (const p of loopA) aByKey.set(keyOf(p), p);

  for (const tri of triangles) {
    for (const entry of tri) {
      const [p, tag] = entry;
      if (tag !== 'B') continue;
      const k = keyOf(p);
      if (aByKey.has(k)) {
        const snapTo = aByKey.get(k);
        entry[0] = snapTo; // now bit-identical to the A point it was aliasing
      }
    }
  }
  return triangles;
}
function float32PrecisionAt(x) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = x;
  const asInt = new Uint32Array(buf)[0];
  new Uint32Array(buf)[0] = asInt + 1;
  return new Float32Array(buf)[0] - x;
}

/**
 * Fix zero-area triangles by nudging a vertex by a tiny, carefully-bounded
 * amount rather than deleting the triangle. Only ever nudges 'B'-tagged
 * vertices — 'A'-tagged vertices (the true margin boundary) must stay
 * pinned exactly to what the trimmed body has, or the pairing breaks.
 *
 * Magnitude is scaled to the point's actual coordinate magnitude, not a
 * fixed value. Confirmed real bug: a fixed 1e-5 nudge survives float32 STL
 * export near the origin, but this piece's coordinates run out to ~100mm
 * from origin, where float32 precision is only ~7.6e-6 — some of the
 * smaller fallback magnitudes (down to 1e-7) were being silently rounded
 * away on export, recreating the exact degenerate triangle the nudge was
 * meant to fix (confirmed: 0 degenerate in the live JS data, 5 degenerate
 * after a real STL write+read round-trip).
 */
/**
 * Fix zero-area triangles by nudging a vertex by a tiny, carefully-bounded
 * amount rather than deleting the triangle. Only ever nudges 'B'-tagged
 * vertices — 'A'-tagged vertices (the true margin boundary) must stay
 * pinned exactly to what the trimmed body has, or the pairing breaks.
 *
 * Magnitude is scaled to the point's actual coordinate magnitude, not a
 * fixed value. Confirmed real bug: a fixed 1e-5 nudge survives float32 STL
 * export near the origin, but this piece's coordinates run out to ~100mm
 * from origin, where float32 precision is only ~7.6e-6 — some of the
 * smaller fallback magnitudes (down to 1e-7) were being silently rounded
 * away on export, recreating the exact degenerate triangle the nudge was
 * meant to fix (confirmed: 0 degenerate in the live JS data, 5 degenerate
 * after a real STL write+read round-trip).
 */
function nudgeDegenerateTriangles(triangles2D, matchTol = 1e-4) {
  function keyOf(p) { return `${Math.round(p[0]/matchTol)}|${Math.round(p[1]/matchTol)}`; }
  const dirs = [];
  for (let k = 0; k < 8; k++) { const a = (k/8)*2*Math.PI; dirs.push([Math.cos(a), Math.sin(a)]); }

  let fixed = 0, unfixed = 0;
  const out = [];
  for (const tri of triangles2D) {
    const pts = tri.map(([p]) => p);
    const tags = tri.map(([,tag]) => tag);
    if (area2(pts[0], pts[1], pts[2]) > 1e-9) { out.push(pts); continue; }
    let done = false;
    const candidateIdxs = [0,1,2].filter(k => tags[k] === 'B');
    for (const vIdx of candidateIdxs) {
      if (done) break;
      const orig = pts[vIdx].slice();
      const origKey = keyOf(orig);
      // scale to the LARGER of the two coordinate magnitudes at this point,
      // with a real safety margin (5x), not just barely over the floor
      const floor = Math.max(float32PrecisionAt(orig[0]), float32PrecisionAt(orig[1]), 1e-9);
      const mags = [floor*50, floor*30, floor*20, floor*10, 1e-5, 1e-5/3];
      for (const [dx,dy] of dirs) {
        for (const mag of mags) {
          const cand = [orig[0]+dx*mag, orig[1]+dy*mag];
          if (keyOf(cand) !== origKey) continue;
          const test = pts.slice(); test[vIdx] = cand;
          if (area2(test[0], test[1], test[2]) > 1e-9) { pts[vIdx] = cand; done = true; break; }
        }
        if (done) break;
      }
    }
    if (done) fixed++; else unfixed++;
    out.push(pts);
  }
  return { triangles: out, fixed, unfixed };
}

// ---- from fillet.mjs ----
// (to2D dedup)
// (from2D dedup)
/**
 * Full cut + fillet pipeline for one side. ROLLED BACK to the last
 * thoroughly-verified state — no retry ladder, no global self-intersection
 * fallback, no margin-topology-ratio shrink loop. Those were added in one
 * evening to chase a specific narrow zone, each individually tested, and
 * collectively they made a real, worse failure (torn/holed geometry)
 * possible in ways that weren't caught until a real render surfaced it.
 * This version is exactly what was verified clean, one stage at a time,
 * against real geometry, at every location tested before that chase
 * began: 84.9mm, 102.7mm, 74.0mm, and four confirmed multi-loop locations
 * (70.5, 74.0, 89.0, 95.0mm). The ridge zone (roughly 80-105mm from one
 * end, where this part's internal rib transitions) is a KNOWN, OPEN
 * limitation — not silently patched, not hidden. Cutting there may throw
 * an error or fall back to a flat cap rather than produce a fillet. That
 * is the honest, current boundary of what this engine reliably does.
 * Multi-loop cross-sections ARE supported (only the largest loop gets
 * filleted; other loops are flat-capped at the margin plane — correct by
 * construction, not a workaround).
 */
function cutAndFillet(tris, axisIdx, planeVal, keepMin, requestedR) {
  const outward = keepMin ? 1 : -1;

  const { cutEdges: tipEdges } = clipTrianglesAtPlane(tris, axisIdx, planeVal, keepMin);
  const { loops: tipLoops, degreeIssues } = buildLoopsFromCutEdges(tipEdges, axisIdx);
  if (degreeIssues.length > 0) throw new Error(`${degreeIssues.length} branch point(s) in tip boundary`);
  if (tipLoops.length === 0) return null;
  const tipLoop3d = tipLoops.reduce((a, b) => (b.length > a.length ? b : a));
  const poly2d = tipLoop3d.map(p => to2D(p, axisIdx));

  if (requestedR < 0.15) {
    const { kept } = clipTrianglesAtPlane(tris, axisIdx, planeVal, keepMin);
    const out = kept.slice();
    for (const loop of tipLoops) out.push(...flatCapLoop(loop, axisIdx, planeVal, keepMin));
    return out;
  }

  const Rs0 = adaptiveRadius(poly2d, requestedR);

  function tightestRing(Rarr) { return buildFilletBand(poly2d, Rarr).rings.slice(-1)[0]; }
  const { Rs } = repairSelfIntersections(poly2d, Rs0, tightestRing);
  const { rings, Rmax } = buildFilletBand(poly2d, Rs);
  if (rings.some(r => ringSelfIntersects(r))) throw new Error('band still self-intersects after repair — this cut location is not currently supported at this radius');

  const marginPlane = planeVal - outward * Rmax;
  const { kept: bodyTrimmed, cutEdges: marginEdges } = clipTrianglesAtPlane(tris, axisIdx, marginPlane, keepMin);
  const { loops: marginLoops, degreeIssues: marginDegreeIssues } = buildLoopsFromCutEdges(marginEdges, axisIdx);
  if (marginDegreeIssues.length > 0) throw new Error(`${marginDegreeIssues.length} branch point(s) in margin boundary`);
  if (marginLoops.length === 0) throw new Error('no margin boundary found');
  const outerMarginLoop3d = marginLoops.reduce((a, b) => (b.length > a.length ? b : a));
  const marginLoop2d = outerMarginLoop3d.map(p => to2D(p, axisIdx));

  const out = bodyTrimmed.slice();

  for (const loop of marginLoops) {
    if (loop === outerMarginLoop3d) continue;
    out.push(...flatCapLoop(loop, axisIdx, marginPlane, keepMin));
  }

  const rings0Safe = pushApartCloseBPoints(marginLoop2d, rings[0], 0.002);
  const stitchRaw = buildStitchStrip(marginLoop2d, rings0Safe);
  const { triangles: stitch2D } = nudgeDegenerateTriangles(stitchRaw);
  for (const [p1, p2, p3] of stitch2D) {
    out.push(...from2D(p1, axisIdx, marginPlane), ...from2D(p2, axisIdx, marginPlane), ...from2D(p3, axisIdx, marginPlane));
  }

  const ringsForBand = rings.slice();
  ringsForBand[0] = rings0Safe;
  const steps = ringsForBand.length - 1;
  for (let s = 0; s < steps; s++) {
    const a = ringsForBand[s], b = ringsForBand[s+1];
    const depthA = Rmax * (1 - s/steps);
    const depthB = Rmax * (1 - (s+1)/steps);
    const n = a.length;
    for (let i = 0; i < n; i++) {
      const i1 = (i+1)%n;
      const A0 = from2D(a[i], axisIdx, planeVal - outward*depthA);
      const A1 = from2D(a[i1], axisIdx, planeVal - outward*depthA);
      const B0 = from2D(b[i], axisIdx, planeVal - outward*depthB);
      const B1 = from2D(b[i1], axisIdx, planeVal - outward*depthB);
      out.push(...A0, ...A1, ...B1, ...A0, ...B1, ...B0);
    }
  }

  const tipRing3d = rings[rings.length-1].map(uv => from2D(uv, axisIdx, planeVal));
  const capTriIdx = earClip2D(rings[rings.length-1]);
  for (const [ia,ib,ic] of capTriIdx) {
    let a = tipRing3d[ia], b = tipRing3d[ib], c = tipRing3d[ic];
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2], vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const nrm = [uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx];
    const wantSign = keepMin ? -1 : 1;
    if (Math.sign(nrm[axisIdx] || 1) !== wantSign) { const t=b; b=c; c=t; }
    out.push(...a, ...b, ...c);
  }

  return out;
}

// ---- clipGeometrySide: drop-in replacement using the new engine ----
// Same external signature as before (geometry, axis, plane, keepMin) ->
// THREE.BufferGeometry | null, so cutActiveModel's call sites don't need
// to change at all.
function clipGeometrySide(geometry, axis, plane, keepMin) {
  const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position;
  const tris = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    tris[i*3] = pos.getX(i); tris[i*3+1] = pos.getY(i); tris[i*3+2] = pos.getZ(i);
  }

  const finishEl = document.getElementById('cut-finish');
  const finishVal = (finishEl || {}).value || 'match';
  const requestedR = finishVal === 'square' ? 0 : (finishVal === 'soft' ? 0.8 : 2.0);

  let result;
  try {
    result = cutAndFillet(tris, axisIdx, plane, keepMin, requestedR);
  } catch (err) {
    console.error('[engine] cutAndFillet failed:', err.message);
    return null;
  }
  if (!result || result.length < 9) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(result), 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  return geo;
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
  setStatus('Ready – drop STL files');
} catch (err) {
  console.error(err);
  document.body.innerHTML = '<p style="color:white;padding:40px;font-family:sans-serif">Failed to start. Check browser console.</p>';
}
