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
  ready: false,
  selectedIndex: -1,
  raycaster: null,
  pointer: null
};

let nextId = 1;
const loader = new STLLoader();
const NUDGE_MM = 2;

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

  state.raycaster = new THREE.Raycaster();
  state.pointer = new THREE.Vector2();

  buildPlateMesh();
  state.ready = true;
  animate();

  window.addEventListener('resize', onResize);
  state.renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);

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
    color: 0x3a4558,
    metalness: 0.1,
    roughness: 0.9,
    side: THREE.DoubleSide
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.plateMesh.position.y = 0;
  state.scene.add(state.plateMesh);

  // Grid on the floor — not a child of the rotated plate
  const grid = new THREE.GridHelper(Math.max(p.w, p.d), 18, 0x60a5fa, 0x4a5568);
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
// STL / Bambu Studio are Z-up. Three.js is Y-up.
// (x, y, z)_Zup → (x, z, -y)_Yup
function zUpToYUp(geometry) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setXYZ(i, x, z, -y);
  }
  pos.needsUpdate = true;
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

    // Keep plate visible and frame the view after packing
    if (!state.plateMesh || !state.plateGrid) buildPlateMesh();
    if (state.controls && state.camera) {
      state.controls.target.set(0, 5, 0);
      state.camera.position.set(plate.w * 0.7, plate.w * 0.85, plate.d * 0.9);
      state.controls.update();
    }

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
  clearDisplayMeshes();
  state.placed = [];
  const stats = document.getElementById('stats');
  if (stats) stats.classList.add('hidden');
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = true;
}

// ===================== Manual Adjust =====================
function onCanvasPointerDown(event) {
  if (!state.placed.length || !state.renderer || !state.camera) return;

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, false);

  if (hits.length > 0) {
    const idx = hits[0].object.userData.placedIndex;
    if (typeof idx === 'number') selectPlaced(idx);
  }
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
    p.mesh.material.emissive = new THREE.Color(0x335577);
    p.mesh.material.emissiveIntensity = 0.45;
  }
  updateAdjustUI();
}

function updateExportButton() {
  const exportBtn = document.getElementById('btn-export-stl');
  if (exportBtn) exportBtn.disabled = state.placed.length === 0;
}

function updateAdjustUI() {
  const has = state.selectedIndex >= 0 && state.placed[state.selectedIndex];
  ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !has;
    });
  const status = document.getElementById('adjust-status');
  if (status) {
    status.textContent = has
      ? `Selected model #${state.selectedIndex + 1}`
      : (state.placed.length ? 'Click a model to adjust' : 'No model selected');
  }
  updateExportButton();
}

function rotateSelected(dir) {
  const p = state.placed[state.selectedIndex];
  if (!p || !p.mesh) return;

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

  p.x += dx;
  p.z += dz;
  p.mesh.position.x = p.x;
  p.mesh.position.z = p.z;
  // Drop overflow models onto the plate when first moved
  if (p.overflow || p.meshOffsetY) {
    p.overflow = false;
    p.meshOffsetY = 0;
    p.mesh.position.y = p.height / 2 + 0.2;
    const hue = 0.55 + (state.selectedIndex % 8) * 0.03;
    p.mesh.material.color.setHSL(hue, 0.65, 0.55);
  }

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
    state.selectedIndex = -1;
    updateAdjustUI();
    updateOptimizeButton();
    setStatus('Cleared');
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
  updateAdjustUI();
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
