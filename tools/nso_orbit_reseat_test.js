#!/usr/bin/env node
/* Pan and orbit stay true after a long session: the orbit target is re-seated
   at the depth of what each drag grabs.
     node tools/nso_orbit_reseat_test.js        exit 0 = every gate held

   No browser, the same rig as nso_camera_leash_test.js: three 0.147 and its
   OrbitControls in a vm context, with the app's own camera code lifted out
   of app-core.js (the block from "WHEEL ZOOM TOWARD THE CURSOR" to onResize,
   which holds the wheel, the leash and the re-seat).

   WHY. OrbitControls pans by the target's depth: a pixel of drag moves a
   point AT that depth one pixel, and a point at depth d by depthTarget / d
   pixels. Wheel zoom scales camera and target about the point under the
   cursor, which keeps that ratio; pan and orbit keep it too. So over a long
   bout of zooming, panning and orbiting among pieces at different depths
   the target drifts in front of (or behind) what is on screen, and a pan
   crawls at a fraction of the pointer - "dragging uphill" - until Frame.

   Scene: plate 'a1', five boxes at different spots and heights, a
   1000 x 600 px viewport. A SESSION is 60 seeded rounds of: a burst of
   wheel steps over a piece, a right-drag pan that grabs a piece, a left-drag
   orbit. The same session runs twice from Frame: once with the re-seat
   unhooked (the control) and once as the app has it.

   GATES
     0. Control: without the re-seat, some pan moves the grabbed point 25 %
        more or less than the pointer travelled. If this ever fails, the session has
        stopped reproducing the drift.
     a. With it, every pan moves the grabbed point with the pointer, to
        0.5 px.
     b. The re-seat itself never moves the picture: across each press, the
        camera's position and orientation are unchanged and the target stays
        on the view line.
     c. An orbit turns about what is at the centre of the view: a point on a
        piece at the centre at the press is still at the centre after the
        orbit.
     d. A press over sky (nothing under it, nothing at the centre) leaves the
        target where it was.
     e. A re-seat that would put the target past the leash is refused.
     f. A wheel step's own 'start' (G-scope dispatches one) re-seats nothing.
     g. G-scope is wired to the same re-seat (its source calls it). */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const THREE = require('three');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const f2 = (v) => v.toFixed(2);

// --- lift the app's code -----------------------------------------------------
const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
function between(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + (a < 0 ? from : to));
  return src.slice(a, b);
}
function fnSource(src, name) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error('no function ' + name);
  let i = src.indexOf('{', a), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

const W = 1000, H = 600;
/* A canvas stand-in that dispatches the way a browser does at the target:
   capture listeners first, then the rest, each in the order added. */
const listeners = { cap: {}, bub: {} };
const dom = {
  style: {}, clientWidth: W, clientHeight: H,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
  addEventListener: (t, fn, opt) => {
    const k = (opt === true || (opt && opt.capture)) ? 'cap' : 'bub';
    (listeners[k][t] = listeners[k][t] || []).push(fn);
  },
  removeEventListener: (t, fn) => {
    for (const k of ['cap', 'bub']) listeners[k][t] = (listeners[k][t] || []).filter(g => g !== fn);
  },
  setPointerCapture() {}, releasePointerCapture() {},
  fire: (t, e) => {
    const ev = Object.assign({ ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {} }, e);
    (listeners.cap[t] || []).slice().forEach(fn => fn(ev));
    (listeners.bub[t] || []).slice().forEach(fn => fn(ev));
  }
};
dom.ownerDocument = dom;

const ctx = {
  THREE, Math, console, setTimeout,
  document: { getElementById: () => null },
  setStatus: () => {},
  state: null
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'node_modules/three/examples/js/controls/OrbitControls.js'), 'utf8'), ctx);
vm.runInContext([
  between(core, 'const PLATES', '// ===================== State'),
  fnSource(core, 'getCurrentPlate'),
  fnSource(core, 'framePlateHome'),
  between(core, '/* WHEEL ZOOM TOWARD THE CURSOR', 'function onResize('),
  'this.__app = { getCurrentPlate, framePlateHome, wheelZoomAnchor, onViewportWheel, orbitLeashReach,',
  '  installOrbitLeash, installOrbitReseat, reseatOrbitTarget, mainViewReseatPick, WHEEL_ZOOM_MIN };'
].join('\n'), ctx, { filename: 'app-core.js (lifted)' });
const app = ctx.__app;

// --- the scene, built the way init does it ------------------------------------
const camera = new THREE.PerspectiveCamera(45, W / H, 1, 2000);
const controls = new ctx.THREE.OrbitControls(camera, dom);
controls.enableDamping = true;
controls.enableZoom = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
app.installOrbitLeash(camera, controls);
let reseatOn = true, reseats = 0;
app.installOrbitReseat(controls, dom, (p) => { if (reseatOn && app.mainViewReseatPick(p)) reseats++; });

const modelGroup = new THREE.Group();
const BOXES = [
  { at: [-100, 0, -100], s: [30, 90, 30] },   // a tall tower at the back left
  { at: [95, 0, -90], s: [40, 25, 40] },
  { at: [0, 0, 0], s: [50, 40, 50] },
  { at: [-90, 0, 95], s: [25, 12, 25] },      // a small low piece at the front
  { at: [100, 0, 100], s: [35, 60, 20] }
];
const pieces = BOXES.map(b => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(b.s[0], b.s[1], b.s[2]), new THREE.MeshStandardMaterial());
  m.position.set(b.at[0], b.s[1] / 2, b.at[2]);
  modelGroup.add(m);
  return m;
});
modelGroup.updateMatrixWorld(true);
ctx.state = {
  plate: 'a1', camera, controls, modelGroup, xray: false,
  renderer: { domElement: dom }
};

// --- helpers ------------------------------------------------------------------
function settle() {
  // flush damping: one undamped update applies the remainder (as pan:drive does)
  for (let i = 0; i < 3; i++) controls.update();
  controls.enableDamping = false; controls.update(); controls.enableDamping = true;
  camera.updateMatrixWorld(true);
}
function proj(p) {
  camera.updateMatrixWorld(true);
  const n = p.clone().project(camera);
  return [(n.x + 1) / 2 * W, (1 - n.y) / 2 * H];
}
const ray = new THREE.Raycaster();
function hitAt(x, y) {
  camera.updateMatrixWorld(true);
  ray.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), camera);
  const h = ray.intersectObjects(modelGroup.children, true)[0];
  return h ? ray.ray.at(h.distance, new THREE.Vector3()) : null;
}
// a pixel on piece k that is on screen, clear of the edges, or null
function pixelOn(k, rnd) {
  for (let tries = 0; tries < 40; tries++) {
    const b = pieces[k].position.clone().add(new THREE.Vector3((rnd() - 0.5) * 0.6 * BOXES[k].s[0],
      (rnd() - 0.5) * 0.6 * BOXES[k].s[1], (rnd() - 0.5) * 0.6 * BOXES[k].s[2]));
    const s = proj(b);
    if (s[0] < 60 || s[0] > W - 60 || s[1] < 60 || s[1] > H - 60) continue;
    if (hitAt(s[0], s[1])) return s;
  }
  return null;
}
function drag(button, x0, y0, dx, dy, steps, mods) {
  steps = steps || 15;
  dom.fire('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', button, clientX: x0, clientY: y0 }, mods || {}));
  for (let i = 1; i <= steps; i++) {
    dom.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: x0 + dx * i / steps, clientY: y0 + dy * i / steps });
  }
  dom.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button });
  settle();
}
const wheel = (x, y, dy) => app.onViewportWheel({ clientX: x, clientY: y, deltaY: dy, preventDefault() {}, stopPropagation() {} });
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const camState = () => ({ p: camera.position.clone(), q: camera.quaternion.clone(), t: controls.target.clone() });

/* One session. Returns the pan efficiencies (grabbed point's travel over the
   pointer's) and the worst picture change across a press. */
function session(seed) {
  app.framePlateHome(); settle();
  const rnd = rng(seed);
  const eff = [], press = [];
  for (let round = 0; round < 60; round++) {
    // wheel burst over a piece
    let k = Math.floor(rnd() * pieces.length), s = pixelOn(k, rnd);
    if (s) {
      const n = 1 + Math.floor(rnd() * 6), dir = rnd() < 0.6 ? -100 : 100;
      for (let i = 0; i < n; i++) wheel(s[0], s[1], dir);
      settle();
    }
    // pan: grab a piece, drag it toward the middle
    k = Math.floor(rnd() * pieces.length); s = pixelOn(k, rnd);
    if (s) {
      const P = hitAt(s[0], s[1]);
      const dx = Math.round((W / 2 - s[0]) * 0.6 + (rnd() - 0.5) * 80);
      const dy = Math.round((H / 2 - s[1]) * 0.6 + (rnd() - 0.5) * 80);
      const before = camState();
      // the press alone: what the re-seat does to the picture
      dom.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: s[0], clientY: s[1] });
      camera.updateMatrixWorld(true);
      const fwd0 = before.t.clone().sub(before.p).normalize(), fwd1 = controls.target.clone().sub(camera.position).normalize();
      // (quaternion distance as 1 - |dot|: angleTo's acos turns rounding into 1e-8)
      press.push(Math.max(camera.position.distanceTo(before.p), 1 - Math.abs(camera.quaternion.dot(before.q)), fwd0.distanceTo(fwd1)));
      for (let i = 1; i <= 15; i++) dom.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: s[0] + dx * i / 15, clientY: s[1] + dy * i / 15 });
      dom.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2 });
      settle();
      const t = proj(P), travel = Math.hypot(dx, dy);
      if (travel > 20) eff.push({ eff: Math.hypot(t[0] - s[0], t[1] - s[1]) / travel, err: Math.hypot(t[0] - s[0] - dx, t[1] - s[1] - dy) });
    }
    // orbit: a left-drag from wherever
    drag(0, 200 + rnd() * 600, 150 + rnd() * 300, (rnd() - 0.5) * 300, (rnd() - 0.5) * 120);
  }
  return { eff, press };
}

// ---- 0 / a / b. the session, without and with the re-seat --------------------
console.log('0. control - the session with the re-seat unhooked');
reseatOn = false;
const ctl = session(7);
const ctlWorst = Math.min(...ctl.eff.map(e => e.eff));
const ctlBest = Math.max(...ctl.eff.map(e => e.eff));
check('0: some pan moved the grabbed point 25 % off the pointer\'s travel', ctlWorst < 0.8 || ctlBest > 1.25,
  ctl.eff.length + ' pans, grabbed point moved ' + f2(ctlWorst) + 'x .. ' + f2(ctlBest) + 'x the pointer');

console.log('a/b. the same session, as the app has it');
reseatOn = true; reseats = 0;
const run = session(7);
const worstErr = Math.max(...run.eff.map(e => e.err));
check('a: every pan moves the grabbed point with the pointer, to 0.5 px', worstErr <= 0.5,
  run.eff.length + ' pans, worst miss ' + worstErr.toFixed(4) + ' px, ' + f2(Math.min(...run.eff.map(e => e.eff))) + 'x .. ' +
  f2(Math.max(...run.eff.map(e => e.eff))) + 'x, ' + reseats + ' re-seats');
const worstPress = Math.max(...run.press);
check('b: a press never moves the picture', worstPress < 1e-9, 'worst ' + worstPress.toExponential(2));

// ---- c. orbit turns about the centre ---------------------------------------
console.log('c. orbit about the centre of the view');
{
  app.framePlateHome(); settle();
  // look at the tall tower from the side, then put it at the centre of the view
  const tower = pieces[0].position.clone();
  controls.target.copy(tower).add(new THREE.Vector3(80, 0, 80));   // the target well off the tower
  camera.position.copy(tower).add(new THREE.Vector3(260, 120, 180));
  camera.lookAt(controls.target); settle();
  // aim the view line through the tower without moving the camera: the target slides to the tower's depth line
  const fwd = tower.clone().sub(camera.position).normalize();
  controls.target.copy(camera.position).addScaledVector(fwd, 30);  // target far in front of the tower
  settle();
  const C = hitAt(W / 2, H / 2);
  check('c: a piece at the centre of the view', !!C);
  // press over bare plate off to the side, orbit
  drag(0, 120, 520, 220, -60);
  const c = proj(C);
  check('c: after the orbit the centre point is still at the centre', Math.hypot(c[0] - W / 2, c[1] - H / 2) < 0.5,
    'at (' + f2(c[0]) + ', ' + f2(c[1]) + ')');
}

// ---- d. sky ---------------------------------------------------------------
console.log('d. nothing to grab');
{
  // look up, away from the plate: no piece, no ground in view
  app.framePlateHome(); settle();
  // (inside the leash, so only the pan moves the target)
  controls.target.set(0, 300, 0);
  camera.position.set(0, 290, 250);
  settle();
  const t0 = controls.target.clone(), fwd = t0.clone().sub(camera.position);
  const n0 = reseats;
  drag(2, 500, 100, 40, 0);
  const moved = controls.target.clone().sub(t0);
  check('d: a press over sky re-seats nothing', reseats === n0, (reseats - n0) + ' re-seats');
  check('d: and the pan moved the target across the view, not along it', Math.abs(moved.dot(fwd.normalize())) < 1e-6 && moved.length() > 1,
    'moved ' + moved.length().toFixed(3) + ' mm, along the view ' + moved.dot(fwd).toExponential(2));
}

// ---- e. the leash ---------------------------------------------------------
console.log('e. the leash');
{
  const reach = app.orbitLeashReach();
  camera.position.set(0, 50, 700); controls.target.set(0, 0, 300);
  settle();
  // a point straight ahead deep behind the plate's far side: the seat would land past the leash
  const t0 = controls.target.clone();
  const far = camera.position.clone().add(controls.target.clone().sub(camera.position).normalize().multiplyScalar(1100));
  const ok = app.reseatOrbitTarget(camera, controls, far, 15, 1200, (t) => t.length() <= reach);
  check('e: a seat past the leash is refused', !ok && controls.target.equals(t0),
    'would be ' + far.length().toFixed(1) + ' mm out, leash ' + reach.toFixed(1));
}

// ---- f. a wheel's 'start' -------------------------------------------------
console.log('f. a start with no press');
{
  app.framePlateHome(); settle();
  const t0 = controls.target.clone(), n0 = reseats;
  // a press long gone: its record is cleared once its own dispatch is over
  dom.fire('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 1, clientX: 500, clientY: 300 });
  dom.fire('pointerup', { pointerId: 2, pointerType: 'mouse', button: 1 });
  settle();
  setTimeout(() => {
    const t1 = controls.target.clone(), n1 = reseats;
    controls.dispatchEvent({ type: 'start' });
    controls.dispatchEvent({ type: 'end' });
    check('f: a start with no press behind it re-seats nothing', reseats === n1 && controls.target.equals(t1),
      (reseats - n1) + ' re-seats (the middle press before it: ' + (n1 - n0) + ', target ' + (t1.equals(t0) ? 'kept' : 'seated') + ')');

    // ---- g. G-scope ---------------------------------------------------------
    console.log('g. G-scope');
    const ms = fs.readFileSync(path.join(ROOT, 'app-microscope.js'), 'utf8');
    check('g: G-scope wires its OrbitControls to the same re-seat', /installOrbitReseat\(v\.controls, el,/.test(ms) && /reseatOrbitTarget\(v\.camera, c,/.test(ms));

    console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
    process.exit(fails ? 1 : 0);
  }, 5);
}
