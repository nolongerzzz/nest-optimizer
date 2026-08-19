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
  modelGroup: null,
  ready: false
};

let nextId = 1;
const loader = new STLLoader();

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

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  state.scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(80, 150, 100);
  state.scene.add(dir);

  state.modelGroup = new THREE.Group();
  state.scene.add(state.modelGroup);

  buildPlateMesh();
  state.ready = true;
  animate();

  window.addEventListener('resize', onResize);

  // Force one more resize after layout settles
  setTimeout(onResize, 150);
  setTimeout(onResize, 500);
}

function onResize() {
  if (!state.renderer || !state.camera) return;
  const container = document.getElementById('viewport');
  const w = container.clientWidth || 600;
  const h = container.clientHeight || 400;
  if (h < 50) return;

  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  if (state.controls) state.controls.update();
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

  const p = getCurrentPlate();
  const geo = new THREE.PlaneGeometry(p.w, p.d);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a3140,
    metalness: 0.15,
    roughness: 0.85,
    side: THREE.DoubleSide
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.plateMesh.position.y = 0;
  state.scene.add(state.plateMesh);

  // Grid on the floor — not a child of the rotated plate
  const grid = new THREE.GridHelper(Math.max(p.w, p.d), 18, 0x3b82f6, 0x333a48);
  grid.position.y = 0.2;
  state.scene.add(grid);
  state.plateGrid = grid;

  const edges = new THREE.EdgesGeometry(geo);
  const border = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x60a5fa }));
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.25;
  state.scene.add(border);
  state.plateBorder = border;

  if (state.controls) {
    state.controls.target.set(0, 0, 0);
    state.camera.position.set(p.w * 0.7, p.w * 0.8, p.d * 0.9);
    state.controls.update();
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
        const geometry = loader.parse(e.target.result);
        if (!geometry.attributes || !geometry.attributes.position) {
          throw new Error('Invalid geometry');
        }
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

function addModel(name, geometry) {
  const id = nextId++;
  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const size = new THREE.Vector3();
  bbox.getSize(size);

  // Sanity check
  if (size.x < 0.1 || size.y < 0.1 || size.z < 0.1) {
    setStatus(`${name} looks empty or invalid`, true);
    return;
  }

  state.models.push({
    id,
    name: name.replace(/\.stl$/i, ''),
    geometry,
    quantity: 1,
    size: { x: size.x, y: size.y, z: size.z },
    orientedGeometry: null
  });

  renderModelList();
  updateOptimizeButton();
  previewModelOnPlate(geometry, size);
  setStatus(`Loaded: ${name} (${size.x.toFixed(0)}×${size.y.toFixed(0)}×${size.z.toFixed(0)} mm) – hit Optimize`);
}

// Clear display meshes only — never dispose shared model geometries
function clearDisplayMeshes() {
  if (!state.modelGroup) return;
  while (state.modelGroup.children.length) {
    const child = state.modelGroup.children[0];
    state.modelGroup.remove(child);
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material.dispose();
    }
    // Do NOT dispose geometry — it may be shared with state.models
  }
}

// Show a single model on the plate so upload has immediate feedback
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
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, h / 2 + 0.3, 0);
  state.modelGroup.add(mesh);

  if (state.controls && state.camera) {
    const maxDim = Math.max(size.x, size.y, size.z, 40);
    state.controls.target.set(0, h / 2, 0);
    state.camera.position.set(maxDim * 1.6, maxDim * 1.4, maxDim * 1.6);
    state.controls.update();
  }
}

function renderModelList() {
  const el = document.getElementById('model-list');
  el.innerHTML = '';

  state.models.forEach(m => {
    const row = document.createElement('div');
    row.className = 'model-item';
    row.innerHTML = `
      <span class="name" title="${m.name}">${m.name}</span>
      <div class="qty">
        <input type="number" min="1" max="30" value="${m.quantity}" data-id="${m.id}" />
      </div>
      <button class="remove" data-id="${m.id}" title="Remove">×</button>
    `;
    el.appendChild(row);
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
      renderModelList();
      updateOptimizeButton();
      clearPlaced();
    });
  });
}

function updateOptimizeButton() {
  const btn = document.getElementById('btn-optimize');
  if (btn) btn.disabled = state.models.length === 0;
}

// ===================== Orientation =====================
function scoreOrientation(geometry) {
  const bbox = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const contactArea = size.x * size.z;
  const height = size.y;
  const score = height * 2.2 - contactArea * 0.008;
  return { score, size, contactArea, height };
}

function autoOrient(geometry) {
  const rotations = [
    [0, 0, 0],
    [Math.PI / 2, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [0, 0, -Math.PI / 2],
    [Math.PI, 0, 0]
  ];

  let best = null;

  rotations.forEach(([rx, ry, rz]) => {
    const geo = geometry.clone();
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.computeBoundingBox();
    geo.center();
    const result = scoreOrientation(geo);
    if (!best || result.score < best.score) {
      best = { geometry: geo, ...result };
    }
  });

  return best;
}

// ===================== Nesting =====================
function packModels(instances, plate, gap, allowRotate) {
  const placed = [];
  const freeRects = [{ x: -plate.w / 2, z: -plate.d / 2, w: plate.w, d: plate.d }];

  const sorted = [...instances].sort((a, b) => (b.width * b.depth) - (a.width * a.depth));

  for (const inst of sorted) {
    let best = null;
    let rotated = false;

    const tryPlace = (w, d, isRotated) => {
      for (let i = 0; i < freeRects.length; i++) {
        const r = freeRects[i];
        if (w + gap <= r.w + 0.01 && d + gap <= r.d + 0.01) {
          const score = r.z * 1000 + r.x;
          if (!best || score < best.score) {
            best = { x: r.x, z: r.z, w, d, score, rectIdx: i };
            rotated = isRotated;
          }
        }
      }
    };

    tryPlace(inst.width, inst.depth, false);
    if (allowRotate && Math.abs(inst.width - inst.depth) > 0.8) {
      tryPlace(inst.depth, inst.width, true);
    }

    if (!best) continue;

    const finalW = best.w;
    const finalD = best.d;

    placed.push({
      ...inst,
      x: best.x + finalW / 2,
      z: best.z + finalD / 2,
      width: finalW,
      depth: finalD,
      rotated
    });

    const r = freeRects[best.rectIdx];
    freeRects.splice(best.rectIdx, 1);

    if (r.w - finalW - gap > 1.5) {
      freeRects.push({
        x: r.x + finalW + gap,
        z: r.z,
        w: r.w - finalW - gap,
        d: r.d
      });
    }
    if (r.d - finalD - gap > 1.5) {
      freeRects.push({
        x: r.x,
        z: r.z + finalD + gap,
        w: finalW + gap,
        d: r.d - finalD - gap
      });
    }

    freeRects.sort((a, b) => a.z - b.z || a.x - b.x);
  }

  return placed;
}

// ===================== Optimize =====================
function runOptimize() {
  const btn = document.getElementById('btn-optimize');
  btn.disabled = true;
  setStatus('Optimizing…');

  try {
    const doOrient = document.getElementById('opt-orient').checked;
    const allowRotate = document.getElementById('opt-rotate').checked;
    const gap = Number(document.getElementById('gap').value) || 2;
    const plate = getCurrentPlate();

    const instances = [];
    for (const model of state.models) {
      let geo = model.geometry;
      let size = model.size;

      if (doOrient) {
        const best = autoOrient(model.geometry);
        geo = best.geometry;
        size = { x: best.size.x, y: best.size.y, z: best.size.z };
        model.orientedGeometry = geo;
      } else {
        model.orientedGeometry = model.geometry.clone();
      }

      for (let i = 0; i < model.quantity; i++) {
        instances.push({
          sourceId: model.id,
          name: model.name,
          geometry: geo,
          width: size.x,
          depth: size.z,
          height: size.y
        });
      }
    }

    const placed = packModels(instances, plate, gap, allowRotate);

    clearDisplayMeshes();
    state.placed = placed;

    const material = new THREE.MeshStandardMaterial({
      color: 0x60a5fa,
      metalness: 0.1,
      roughness: 0.6
    });

    placed.forEach((p, idx) => {
      // Clone so display meshes never share geometry with stored models
      const mesh = new THREE.Mesh(p.geometry.clone(), material.clone());
      mesh.position.set(p.x, p.height / 2 + 0.2, p.z);
      if (p.rotated) mesh.rotation.y = Math.PI / 2;
      const hue = 0.55 + (idx % 8) * 0.03;
      mesh.material.color.setHSL(hue, 0.65, 0.55);
      state.modelGroup.add(mesh);
    });

    const totalArea = plate.w * plate.d;
    const usedArea = placed.reduce((sum, p) => sum + p.width * p.depth, 0);
    const fill = totalArea > 0 ? ((usedArea / totalArea) * 100).toFixed(1) : 0;

    document.getElementById('stats').classList.remove('hidden');
    document.getElementById('stat-count').textContent = `${placed.length} models`;
    document.getElementById('stat-fill').textContent = `${fill}% fill`;
    document.getElementById('stat-time').textContent = `${instances.length - placed.length} left`;

    const resultsEl = document.getElementById('results');
    resultsEl.innerHTML = `
      <div class="result-row"><span>Placed</span><strong>${placed.length} / ${instances.length}</strong></div>
      <div class="result-row"><span>Plate fill</span><strong>${fill}%</strong></div>
      <div class="result-row"><span>Gap</span><strong>${gap} mm</strong></div>
    `;

    document.getElementById('btn-export-stl').disabled = placed.length === 0;

    if (placed.length < instances.length) {
      setStatus(`Placed ${placed.length} of ${instances.length}. Some did not fit.`, true);
    } else {
      setStatus(`Packed ${placed.length} models — ready to export`, false);
    }
  } catch (err) {
    console.error(err);
    setStatus('Optimize failed. Check console.', true);
  }

  btn.disabled = false;
}

function clearPlaced() {
  clearDisplayMeshes();
  state.placed = [];
  const stats = document.getElementById('stats');
  if (stats) stats.classList.add('hidden');
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;
}

// ===================== Export =====================
// Three.js is Y-up. Bambu / most slicers are Z-up.
// Convert (x, y, z)_three → (x, z, y)_slicer so the plate lies flat.
function buildCombinedGeometry() {
  const positions = [];
  state.placed.forEach(p => {
    const geo = p.geometry.clone();
    if (p.rotated) geo.rotateY(Math.PI / 2);
    geo.translate(p.x, p.height / 2, p.z);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); // height in Three.js
      const z = pos.getZ(i);
      // Y-up → Z-up
      positions.push(x, z, y);
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
    renderModelList();
    clearPlaced();
    updateOptimizeButton();
    setStatus('Cleared');
  });
  document.getElementById('btn-export-stl').addEventListener('click', exportSTLs);
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
