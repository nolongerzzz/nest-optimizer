import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const PLATES = {
  a1mini: { name: 'Bambu A1 Mini', w: 180, d: 180 },
  a1: { name: 'Bambu A1 / P1S / X1C', w: 256, d: 256 },
  prusa: { name: 'Prusa MK4 / MK3S', w: 250, d: 210 },
  ender: { name: 'Creality Ender 3', w: 220, d: 220 },
  custom: { name: 'Custom', w: 180, d: 180 }
};

const state = {
  plate: 'a1mini', scene: null, camera: null, renderer: null, controls: null,
  plateMesh: null, plateGrid: null, plateBorder: null, plateTicks: [],
  modelGroup: null, models: [], placed: [], selectedIndex: -1,
  raycaster: null, pointer: null, ready: false
};

function getCurrentPlate() {
  if (state.plate === 'custom') {
    return {
      name: 'Custom',
      w: Number(document.getElementById('custom-w')?.value) || 180,
      d: Number(document.getElementById('custom-d')?.value) || 180
    };
  }
  return PLATES[state.plate] || PLATES.a1mini;
}

function buildPlateMesh() {
  if (!state.scene) return;
  if (state.plateMesh) { state.scene.remove(state.plateMesh); state.plateMesh.geometry?.dispose(); }
  if (state.plateGrid) { state.scene.remove(state.plateGrid); state.plateGrid = null; }
  if (state.plateBorder) { state.scene.remove(state.plateBorder); state.plateBorder = null; }
  (state.plateTicks || []).forEach(t => { state.scene.remove(t); t.geometry?.dispose(); t.material?.dispose(); });
  state.plateTicks = [];

  const p = getCurrentPlate();
  const geo = new THREE.PlaneGeometry(p.w, p.d);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x5b6b82, metalness: 0.05, roughness: 0.85,
    emissive: 0x1a2332, emissiveIntensity: 0.35, side: THREE.DoubleSide
  });
  state.plateMesh = new THREE.Mesh(geo, mat);
  state.plateMesh.rotation.x = -Math.PI / 2;
  state.scene.add(state.plateMesh);

  const grid = new THREE.GridHelper(Math.max(p.w, p.d), 18, 0x93c5fd, 0x64748b);
  grid.position.y = 0.15;
  state.scene.add(grid);
  state.plateGrid = grid;

  const edges = new THREE.EdgesGeometry(geo);
  const border = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x38bdf8 }));
  border.rotation.x = -Math.PI / 2;
  border.position.y = 0.3;
  state.scene.add(border);
  state.plateBorder = border;

  if (state.controls) {
    state.controls.target.set(0, 0, 0);
    state.camera.position.set(p.w * 0.7, p.w * 0.8, p.d * 0.9);
    state.controls.update();
  }
}

function initThree() {
  const container = document.getElementById('viewport');
  if (!container) return;
  let width = container.clientWidth || 600;
  let height = container.clientHeight || 400;
  if (height < 100) height = 400;

  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color(0x0a0c10);
  state.camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
  state.camera.position.set(140, 160, 200);
  state.renderer = new THREE.WebGLRenderer({ antialias: true });
  state.renderer.setSize(width, height);
  state.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  container.innerHTML = '';
  container.appendChild(state.renderer.domElement);

  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.target.set(0, 0, 0);

  state.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(80, 150, 100);
  state.scene.add(dir);

  state.modelGroup = new THREE.Group();
  state.scene.add(state.modelGroup);
  state.raycaster = new THREE.Raycaster();
  state.pointer = new THREE.Vector2();

  buildPlateMesh();
  state.ready = true;

  function animate() {
    requestAnimationFrame(animate);
    state.controls?.update();
    state.renderer.render(state.scene, state.camera);
  }
  animate();

  window.addEventListener('resize', () => {
    const w = container.clientWidth || 600;
    const h = container.clientHeight || 400;
    if (h < 50) return;
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(w, h);
  });
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg || '';
}

document.addEventListener('DOMContentLoaded', () => {
  initThree();
  const sel = document.getElementById('plate-select');
  if (sel) {
    sel.addEventListener('change', () => {
      state.plate = sel.value;
      const custom = document.getElementById('custom-size');
      if (custom) custom.classList.toggle('hidden', state.plate !== 'custom');
      buildPlateMesh();
      const p = getCurrentPlate();
      const dims = document.getElementById('plate-dims');
      const area = document.getElementById('plate-area');
      if (dims) dims.textContent = p.w + ' × ' + p.d + ' mm';
      if (area) area.textContent = (p.w * p.d).toLocaleString() + ' mm²';
    });
  }
  setStatus('Plate visible. Full engine still pending upload — load/nest after full app.js lands.');
});
