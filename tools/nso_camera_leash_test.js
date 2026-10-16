#!/usr/bin/env node
/* The camera leash: wheel zoom and pan cannot carry the orbit centre off the
   plate for good.
     node tools/nso_camera_leash_test.js        exit 0 = every gate held

   No browser. three 0.147 and its OrbitControls run in a vm context with the
   app's own camera code lifted out of app-core.js (the wheel block, from
   "WHEEL ZOOM TOWARD THE CURSOR" to onResize, plus PLATES, getCurrentPlate,
   framePlateHome and frameSelectedPiece) and X-ray from app-join.js
   (applyXrayToMaterial, applyXrayView). Nothing is re-implemented here except
   the control in section 0.

   WHY. Wheel zoom scales the camera and the orbit target about the point
   under the cursor. Over bare plate that point was where the cursor's ray met
   the infinite y = 0 plane - near the horizon, hundreds of mm off the plate -
   and each scroll-out scaled the target further from the plate. Orbit then
   swung around empty space and one pan lost the plate. X-ray made it common:
   see-through pieces, more scrolling over bare grid.

   Scene: plate 'a1' (256 x 256), one 40 x 40 x 40 box at the plate's centre,
   a 1000 x 600 px viewport. "Horizon" = the pixel row where the plane's
   points at infinity land; the camera is first orbited down to 12 deg so that
   row is on screen (from Frame's 29 deg it is above the top edge). Each run
   is 40 scroll-outs (deltaY +100) at one cursor, from the same start.

   GATES
     0. Control: the same 40 scroll-outs with the old anchor (ray / plane hit,
        unclamped, while inside the far plane) and no leash put the target
        more than a plate diagonal out. If this ever fails, the scenario has
        stopped reproducing the bug.
     a. Horizon cursors (on the row and 1 / 5 / 20 / 40 / 60 px below it, at
        left / middle / right): after 40 scroll-outs the plate centre projects
        inside the viewport and stays there through a full orbit round the
        target (12 steps of 30 deg); the target is within one diagonal
        throughout; every ground anchor is on the plate rectangle + 10 mm.
     b. The same with X-ray on - and an X-rayed piece (wireframe, depthTest
        off) under the cursor is still the anchor.
     c. A scroll over the piece zooms toward the piece point exactly as
        before: the point holds its pixel, and camera and target land where
        the unchanged dollyAbout math puts them.
     d. Frame (frameSelectedPiece) puts the target back on the plate centre
        and the camera at its home pose.
     e. The leash itself. A wheel step that starts with the target past it
        ends with the target on it and the view direction unchanged; and
        right-drags through OrbitControls, far past the plate, leave the
        target on the leash and the camera's offset from the target
        untouched. (In a / b the clamp alone holds the target inside.) */

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
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

// --- lift the app's code -----------------------------------------------------
const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
const join = fs.readFileSync(path.join(ROOT, 'app-join.js'), 'utf8');

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
const listeners = {};
const dom = {
  style: {}, clientWidth: W, clientHeight: H,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(g => g !== fn); },
  setPointerCapture() {}, releasePointerCapture() {},
  fire: (t, e) => (listeners[t] || []).slice().forEach(fn => fn(e))
};

const ctx = {
  THREE, Math, console,
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
  fnSource(core, 'frameSelectedPiece'),
  between(core, '/* WHEEL ZOOM TOWARD THE CURSOR', 'function onResize('),
  fnSource(join, 'applyXrayToMaterial'),
  fnSource(join, 'applyXrayView'),
  // the vm's top-level const/let are not properties of ctx: hand them out
  'this.__app = { getCurrentPlate, framePlateHome, frameSelectedPiece, wheelZoomAnchor, dollyAbout,',
  '  onViewportWheel, leashOrbitTarget, installOrbitLeash, applyXrayView,',
  '  WHEEL_ZOOM_MIN, WHEEL_ZOOM_MAX, WHEEL_ANCHOR_MARGIN_MM };'
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

const modelGroup = new THREE.Group();
const box = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40),
  new THREE.MeshStandardMaterial({ color: 0x88aacc }));
box.position.set(0, 20, 0);
modelGroup.add(box);
modelGroup.updateMatrixWorld(true);

ctx.state = {
  plate: 'a1', camera, controls, modelGroup, xray: false, previewMesh: null,
  plateMesh: null, cutHelper: null, renderer: { domElement: dom }
};
const S = ctx.state;
const plate = app.getCurrentPlate();
const DIAG = Math.hypot(plate.w, plate.d);
const HW = plate.w / 2 + app.WHEEL_ANCHOR_MARGIN_MM, HD = plate.d / 2 + app.WHEEL_ANCHOR_MARGIN_MM;
console.log('plate ' + plate.w + ' x ' + plate.d + ', leash ' + f1(DIAG) + ' mm, anchor rect +-' + HW + ' x +-' + HD);

function settle() { for (let i = 0; i < 200; i++) controls.update(); camera.updateMatrixWorld(true); }

// Orbit down to `elev` degrees about the plate's centre so the horizon is on screen.
function lowOrbit(elev = 12, az = 40, dist = 470) {
  const e = elev * Math.PI / 180, a = az * Math.PI / 180;
  controls.target.set(0, 6, 0);
  camera.position.set(dist * Math.cos(e) * Math.sin(a), 6 + dist * Math.sin(e), dist * Math.cos(e) * Math.cos(a));
  settle();
}
function horizonRow() {
  const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize();
  const p = camera.position.clone().addScaledVector(f, 1e8); p.y = 0;
  p.project(camera);
  return (1 - p.y) / 2 * H;
}
function centreOnScreen() {
  camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
  const n = new THREE.Vector3(0, 0, 0).project(camera);
  return { ok: v.z < 0 && Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1, n };
}
/* Orbit the camera all the way round the target in 30-degree steps (as a
   left-drag would) and count the steps that lose the plate centre; then put
   the camera back. This is the symptom: orbit swinging around empty space. */
function orbitSweepMisses() {
  const pos0 = camera.position.clone(), off = pos0.clone().sub(controls.target);
  let miss = 0;
  for (let k = 0; k < 12; k++) {
    camera.position.copy(controls.target).add(off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), k * Math.PI / 6));
    camera.lookAt(controls.target);
    if (!centreOnScreen().ok) miss++;
  }
  camera.position.copy(pos0); camera.lookAt(controls.target); camera.updateMatrixWorld(true);
  return miss;
}
const wheel = (x, y, dy) => app.onViewportWheel({ clientX: x, clientY: y, deltaY: dy, preventDefault() {}, stopPropagation() {} });

const CURSORS = [];
for (const dyPx of [0, 1, 5, 20, 40, 60]) for (const xf of [0.05, 0.5, 0.95]) CURSORS.push({ xf, dyPx });

// ---- 0. control: the old anchor, no leash ------------------------------------
console.log('0. control - old unclamped anchor, no leash');
{
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const oldAnchor = (x, y) => {
    ndc.set(x / W * 2 - 1, -(y / H) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(modelGroup.children, true);
    if (hits.length) return ray.ray.at(hits[0].distance, new THREE.Vector3());
    const g = ray.ray.intersectPlane(ground, new THREE.Vector3());
    return g && g.distanceTo(ray.ray.origin) <= camera.far ? g : null;
  };
  let worst = 0, offscreen = 0;
  for (const c of CURSORS) {
    lowOrbit();
    const y = horizonRow() + c.dyPx, x = c.xf * W;
    // unhook the leash: dollyAbout's controls.update() would run it on 'change'
    const keep = controls._listeners.change; controls._listeners.change = [];
    for (let i = 0; i < 40; i++) {
      camera.updateMatrixWorld(true);
      const a = oldAnchor(x, y) || controls.target.clone();
      app.dollyAbout(camera, controls, a, 1 / 0.95, app.WHEEL_ZOOM_MIN, app.WHEEL_ZOOM_MAX);
    }
    controls._listeners.change = keep;
    worst = Math.max(worst, controls.target.length());
    offscreen += orbitSweepMisses();
  }
  check('the old anchor drags the target off the plate', worst > DIAG,
    'worst target ' + f1(worst) + ' mm from centre (leash ' + f1(DIAG) + ')');
  // not a gate: at 1200 mm the wide view still holds the centre from 485 mm out
  console.log('  info orbit round those targets: ' + offscreen + ' of ' + CURSORS.length * 12 + ' steps lose the plate centre');
}

// ---- a / b. horizon scroll-outs ------------------------------------------------
function horizonRuns(label) {
  let worst = 0, worstCam = 0, centreFails = [], anchorFails = 0, anchors = 0, sweepMiss = 0;
  for (const c of CURSORS) {
    lowOrbit();
    const y = horizonRow() + c.dyPx, x = c.xf * W;
    for (let i = 0; i < 40; i++) {
      camera.updateMatrixWorld(true);
      const a = app.wheelZoomAnchor(x, y);
      if (a && a.y === 0) {
        anchors++;
        if (Math.abs(a.x) > HW + 1e-9 || Math.abs(a.z) > HD + 1e-9) anchorFails++;
      }
      wheel(x, y, 100);
      worst = Math.max(worst, controls.target.length());
    }
    settle();
    worst = Math.max(worst, controls.target.length());
    worstCam = Math.max(worstCam, camera.position.distanceTo(controls.target));
    const cs = centreOnScreen();
    if (!cs.ok) centreFails.push('x ' + c.xf + ' +' + c.dyPx + 'px -> ndc ' + f1(cs.n.x) + ',' + f1(cs.n.y));
    sweepMiss += orbitSweepMisses();
  }
  check(label + ': plate centre inside the viewport after 40 scroll-outs', centreFails.length === 0,
    centreFails.length ? centreFails.join('; ') : CURSORS.length + ' cursors, horizon row ' + f1(horizonRow()) + ' px');
  check(label + ': and stays inside through a full orbit round the target', sweepMiss === 0,
    sweepMiss + ' of ' + CURSORS.length * 12 + ' orbit steps off screen');
  check(label + ': target within one diagonal throughout', worst <= DIAG + 1e-6,
    'worst ' + f1(worst) + ' mm, leash ' + DIAG.toFixed(1) + ', camera distance at the end ' + f1(worstCam));
  check(label + ': every ground anchor on the plate + ' + app.WHEEL_ANCHOR_MARGIN_MM + ' mm', anchors > 0 && anchorFails === 0,
    anchors + ' ground anchors, ' + anchorFails + ' outside');
  return worst;
}

console.log('a. horizon scroll-outs, X-ray off');
const worstA = horizonRuns('a');

console.log('b. horizon scroll-outs, X-ray on');
S.xray = true;
app.applyXrayView();
check('b: X-ray applied to the piece', box.material.wireframe === true && box.material.depthTest === false && box.visible,
  'wireframe ' + box.material.wireframe + ', depthTest ' + box.material.depthTest);
{
  camera.position.set(0, 300, 1); controls.target.set(0, 0, 0); settle();
  const a = app.wheelZoomAnchor(W / 2, H / 2);   // straight down onto the box top
  check('b: an X-rayed piece under the cursor is the anchor', a && Math.abs(a.y - 40) < 1e-6,
    a ? 'anchor y ' + a.y.toFixed(4) + ' (box top 40)' : 'no anchor');
}
const worstB = horizonRuns('b');
S.xray = false;
app.applyXrayView();

// ---- c. scroll over the piece ---------------------------------------------------
console.log('c. scroll over the piece');
{
  app.framePlateHome(); settle();
  const pix = new THREE.Vector3(10, 30, 20).project(camera);   // a point on the box's +z face
  const x = (pix.x + 1) / 2 * W, y = (1 - pix.y) / 2 * H;
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), camera);
  const hit = rc.intersectObject(box)[0];
  const P = rc.ray.at(hit.distance, new THREE.Vector3());
  const a0 = app.wheelZoomAnchor(x, y);
  check('c: the anchor is the piece point under the cursor', a0 && a0.distanceTo(P) < 1e-9,
    'anchor ' + a0.toArray().map(f1).join(',') + ' vs ray hit ' + P.toArray().map(f1).join(','));
  let drift = 0, off = 0;
  for (const dy of [-100, -100, -300, 100, 300, 100, 100]) {
    const pos = camera.position.clone(), tgt = controls.target.clone();
    const d = pos.distanceTo(tgt);
    const k = Math.pow(0.95, Math.min(8, Math.abs(dy) * 0.01));
    const s = Math.min(app.WHEEL_ZOOM_MAX, Math.max(app.WHEEL_ZOOM_MIN, d * (dy < 0 ? k : 1 / k))) / d;
    const ePos = pos.sub(P).multiplyScalar(s).add(P), eTgt = tgt.sub(P).multiplyScalar(s).add(P);
    wheel(x, y, dy);
    camera.updateMatrixWorld(true);
    off = Math.max(off, camera.position.distanceTo(ePos), controls.target.distanceTo(eTgt));
    const q = P.clone().project(camera);
    drift = Math.max(drift, Math.hypot((q.x + 1) / 2 * W - x, (1 - q.y) / 2 * H - y));
  }
  check('c: the piece point holds its pixel', drift < 1e-6, 'max drift ' + drift.toExponential(2) + ' px over 7 steps');
  check('c: camera and target exactly where dollyAbout puts them', off < 1e-9, 'max ' + off.toExponential(2) + ' mm');
}

// ---- d. Frame -----------------------------------------------------------------------
console.log('d. Frame');
{
  lowOrbit();
  for (let i = 0; i < 40; i++) wheel(0.95 * W, horizonRow() + 60, 100);
  settle();
  const before = controls.target.clone();
  check('d: the scroll-outs left the target off the plate centre', before.distanceTo(new THREE.Vector3(0, 6, 0)) > 50,
    f1(before.distanceTo(new THREE.Vector3(0, 6, 0))) + ' mm away');
  app.frameSelectedPiece();
  check('d: Frame puts the target on the plate centre', controls.target.distanceTo(new THREE.Vector3(0, 6, 0)) < 1e-9,
    'from ' + before.toArray().map(f1).join(',') + ' to ' + controls.target.toArray().map(f1).join(','));
  const home = new THREE.Vector3(plate.w * 1.08, Math.max(plate.w, plate.d) * 0.92, plate.d * 1.18);
  check('d: and the camera at its home pose', camera.position.distanceTo(home) < 1e-9,
    camera.position.toArray().map(f1).join(','));
}

// ---- e. pan ---------------------------------------------------------------------------
console.log('e. the leash');
{
  app.framePlateHome(); settle();
  const off = camera.position.clone().sub(controls.target);
  controls.target.set(600, 6, -300);              // past the leash, as an old session could leave it
  camera.position.copy(controls.target).add(off);
  camera.updateMatrixWorld(true);
  const dir0 = off.clone().normalize();
  wheel(W / 2, 5, 100);                           // top edge: over bare plate or sky
  const off1 = camera.position.clone().sub(controls.target);
  check('e: a wheel step pulls the target onto the leash', Math.abs(controls.target.length() - DIAG) < 1e-6,
    'from ' + f1(Math.hypot(600, 6, 300)) + ' to ' + controls.target.length().toFixed(4) + ' mm');
  check('e: and keeps the view direction', off1.clone().normalize().distanceTo(dir0) < 1e-9,
    'direction change ' + off1.clone().normalize().distanceTo(dir0).toExponential(2));
}
{
  app.framePlateHome(); settle();
  const offset0 = camera.position.clone().sub(controls.target);
  let worst = 0;
  for (let drag = 0; drag < 12; drag++) {
    let px = 500, py = 300;
    dom.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: px, clientY: py });
    for (let i = 0; i < 20; i++) {
      camera.updateMatrixWorld(true);
      px += 25; py += 10;
      dom.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: px, clientY: py });
      worst = Math.max(worst, controls.target.length());
    }
    dom.fire('pointerup', { pointerId: 1, pointerType: 'mouse' });
    settle();
    worst = Math.max(worst, controls.target.length());
  }
  const offset1 = camera.position.clone().sub(controls.target);
  /* OrbitControls skips 'change' for a camera move under 1e-3 mm (its EPS
     is on the squared distance), so damping's last steps can sit up to that
     far past the leash until the next event: 0.01 mm is that, with room. */
  check('e: 12 long right-drags leave the target on the leash', worst <= DIAG + 0.01 && controls.target.length() > DIAG - 1,
    'worst ' + worst.toFixed(4) + ' mm, now ' + controls.target.length().toFixed(4) + ' (leash ' + DIAG.toFixed(4) + ')');
  check('e: the camera keeps its offset from the target', offset1.distanceTo(offset0) < 1e-6,
    'offset change ' + offset1.distanceTo(offset0).toExponential(2) + ' mm');
}

console.log('\nleash ' + f1(DIAG) + ' mm; worst target a ' + f1(worstA) + ', b ' + f1(worstB));
console.log(fails ? fails + ' FAILED' : 'all gates held');
process.exit(fails ? 1 : 0);
