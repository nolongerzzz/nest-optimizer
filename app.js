import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

// Loader shim: full engine ships as app.full.js (same commit)
const s = document.createElement('script');
s.type = 'module';
s.src = 'app.full.js?v=' + Date.now();
s.onerror = () => {
  document.body.innerHTML = '<p style="color:#f87171;padding:40px;font-family:sans-serif">Missing app.full.js — push still in progress.</p>';
};
document.head.appendChild(s);
