#!/usr/bin/env node
/* Plates (beds): up to six, one active, every tool on the active one. No browser.
     node tools/nso_beds_test.js         exit 0 = every gate held
     npm run beds:test

   app-beds.js is loaded whole into a vm with three.js; the app's own functions it leans on are lifted from
   app-core.js / app-join.js as they are (buildPlateMesh, framePlateHome, pushUndo, undoLast, the real
   undoLastStep dispatcher, clearPlateOnly, clearPlaced, selectPlaced, endMoveDrag, the Pieces card's plate
   test, the geometry lifecycle). Only what draws, lists or measures is stubbed. The meshes, cameras and
   raycasts are real three.js; the geometries are real BufferGeometry with dispose() counted.

   Gates:
     1  layout: 1 2 3 across the back row, 4 5 6 under them, one equal gap, the cap of six, the + plate button
     2  one bed: no label, no floor but the active one, today's framing
     3  active-bed switch: the lists, the Pieces card, the meshes under modelGroup and the Undo / Redo lines are
        the active bed's; a piece's x / z are its bed's own wherever the bed stands; nothing moves on screen
     4  a click on a bed that is not active makes it active; a drag, or a click on the active bed, does not
     5  Clear plate wipes the active bed only
     6  Delete plate: refused at one bed; wipes the active bed and nothing else; the next bed is active; numbers close up
     7  a piece dropped over another bed: pose kept, lands in that bed's frame, joins its list, one Undo step back
     8  ... a drop over no bed is today's move; Undo of a move waits for later steps on the other bed
     9  every bed in the frame when the layout is framed; the geometry lifecycle sees the other beds
    10  nothing switches while a job that would land on "the plate" is running */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const THREE = require('three');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);

function fnSource(src, name, file) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error('no function ' + name + ' in ' + file);
  let i = src.indexOf('{', a), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
const join = fs.readFileSync(path.join(ROOT, 'app-join.js'), 'utf8');
const bedsSrc = fs.readFileSync(path.join(ROOT, 'app-beds.js'), 'utf8');

// --- the page: a few elements, a status line --------------------------------------
const els = {};
const el = id => els[id] || (els[id] = { id, disabled: false, title: '', dataset: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
const status = [];
const calls = [];
const ctx = {
  THREE, Math, console, Object, Array, Map, Set, Number, Promise, Float32Array,
  window: null,
  document: {
    readyState: 'complete',
    getElementById: id => (['btn-undo', 'btn-redo', 'stats', 'btn-export-stl', 'btn-add-plate', 'ctx-delete-plate', 'plate-select'].includes(id) ? el(id) : null),
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillText() {}, set font(v) {}, set textBaseline(v) {}, set fillStyle(v) {} }) })
  },
  setStatus: (t) => { status.push(t); },
  state: null
};
ctx.window = ctx;
['renderModelList', 'updateOptimizeButton', 'updateCutterUI', 'updateEditSize', 'updateAdjustUI', 'removeCutHelper',
  'nsoInvalidatePlacedBounds', 'removeFaceHelper', 'clearFenceLines', 'updateExportButton', 'closeCutter', 'clearFacePick', 'updateJoinUI']
  .forEach(n => { ctx[n] = () => { calls.push(n); }; });
ctx.settlePlacedOnBed = (p) => { if (p && p.mesh) p.mesh.position.y = 0.2; };   // the bed height: the maths is nso-bounds.js's
ctx.nsoHelpers = { teardown: (why) => { calls.push('teardown:' + why); }, afterUndo: () => {}, exportable: x => x };
ctx.NSO_SUPPORTS_CARD = {
  forgetAll: () => { calls.push('forgetAll'); },
  forget: (ids) => { calls.push('forget:' + ids.join('+')); },
  busy: () => ctx.__supportsBusy === true
};
vm.createContext(ctx);

const PLATE_CONSTS = ['PLATE_GRID_STEP_MM', 'PLATE_GRID_MAJOR_EVERY', 'PLATE_GRID_Y', 'PLATE_GRID_AUTO_HOLD_MS']
  .map(n => core.match(new RegExp('const ' + n + ' = [^;]+;'))[0]).join('\n');
vm.runInContext([
  'const UNDO_MAX = 40;',
  'const REDO_LABEL = {}, UNDO_REPLACE_LABEL = {};',
  'const PLATES = { a1mini: { name: "A1 Mini", w: 180, d: 180 }, prusa: { name: "Prusa", w: 250, d: 210 } };',
  PLATE_CONSTS,
  ...['updateUndoBtn', 'nsoGeometriesNamed', 'nsoReleaseGeometries', 'nsoPoseBakeGeometries', 'nsoLeavingGeometries', 'nsoDropRedo',
    'pushUndo', 'undoLast', 'undoLastStep', 'nsoCopyFields', 'nsoWorldFingerprint', 'nsoWorldSnapshot',
    'modelIsOnPlate', 'modelsOnPlate', 'clearPlaced', 'clearDisplayMeshes', 'clearPlateOnly', 'clearSelectionOutline', 'selectPlaced',
    'reindexPlacedMeshes', 'applyPlacedXZ', 'restoreMeshY', 'setPointerFromEvent', 'endMoveDrag',
    'getCurrentPlate', 'buildPlateGrid', 'disposePlateGrid', 'plateGridNow', 'plateGridAutoActive', 'plateGridWantsVisible',
    'applyPlateGridVisibility', 'plateGridNeverRaycast', 'buildPlateMesh', 'framePlateHome', 'nsoCtxMenuRefresh']
    .map(n => fnSource(core, n, 'app-core.js')),
  fnSource(join, 'clearJoinSlots', 'app-join.js'),
  'function plateGridSnapXZ(x, z) { return { x: x, z: z }; }',
  'function reportJoinFlushGap() { return false; }',
  'const nsoGrab = { end() { return null; } };',
  bedsSrc,
  'this.__app = { pushUndo, undoLast, clearPlateOnly, clearPlaced, modelsOnPlate, selectPlaced, endMoveDrag, buildPlateMesh, framePlateHome,' +
  ' nsoReleaseGeometries, applyPlacedXZ, updateUndoBtn, nsoCtxMenuRefresh };'
].join('\n'), ctx, { filename: 'app-core.js + app-join.js + app-beds.js (lifted)' });
const app = ctx.__app;
const BEDS = ctx.NSO_BEDS;

// --- a scene -----------------------------------------------------------------------
let disposed, made;
function geo(name) {
  const g = new THREE.BoxGeometry(10, 10, 10);
  g.name = name;
  const real = g.dispose.bind(g);
  g.dispose = () => { disposed.set(g, (disposed.get(g) || 0) + 1); real(); };
  made.push(g);
  return g;
}
const times = g => disposed.get(g) || 0;

function world() {
  disposed = new Map(); made = []; calls.length = 0; status.length = 0;
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const camera = new THREE.PerspectiveCamera(45, 1000 / 600, 1, 2000);
  camera.position.set(160, 180, 200);
  const controls = { enableDamping: true, target: new THREE.Vector3(0, 6, 0), update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } };
  controls.update();
  ctx.state = {
    plate: 'a1mini', scene, camera, controls, modelGroup: group, models: [], placed: [], undoStack: [], redoStack: [],
    selectedIndex: -1, editId: null, cutT: 0.5, plateLock: false, plateGridMode: 'on', plateGridSnap: false, plateGridAutoHoldUntil: 0,
    plateMesh: null, plateGrid: null, plateBorder: null, plateTicks: [], cameraFramed: true, xray: false,
    raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), previewMesh: null, cutterOpen: false,
    renderer: { domElement: { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) } }
  };
  // a fresh module state: the only way back to one bed is a new vm, so every world() gets its own
  return ctx.state;
}
/* NSO_BEDS keeps its bed list in its closure; a new world needs a new module (a re-run of the file). */
function freshBeds() {
  vm.runInContext(bedsSrc, ctx, { filename: 'app-beds.js' });
  return ctx.NSO_BEDS;
}
let B;
function setup() {
  const s = world();
  B = freshBeds();
  app.buildPlateMesh();
  return s;
}

let nextId = 1;
/* A piece on the ACTIVE bed, the way placeModelMovable leaves one. */
function piece(s, name, x, z, extra) {
  const g = geo(name);
  const id = nextId++;
  const m = { id, name, geometry: g, quantity: 1, size: { x: 10, y: 10, z: 10 } };
  s.models.push(m);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  mesh.position.set(x, 5.3, z);
  mesh.userData.placedIndex = s.placed.length;
  mesh.userData.sourceId = id;
  s.modelGroup.add(mesh);
  const p = Object.assign({ mesh, geometry: g, name, x, z, width: 10, depth: 10, height: 10, rotY: 0, flipX: false, tipX: 0, sourceId: id, outline: null }, extra || {});
  s.placed.push(p);
  return { m, p, g, mesh };
}
const names = () => ctx.state.placed.map(p => p.name).join(',');
const listed = () => app.modelsOnPlate().map(m => m.name).join(',');
const groupNames = () => ctx.state.modelGroup.children.map(c => c.userData.sourceId).join(',');
const rows = () => B.info().map(b => b.number + (b.active ? '*' : '') + ':' + b.placed + 'p/' + b.undo + 'u').join(' ');

// 1 ----------------------------------------------------------------------------------
console.log('1  layout');
{
  let s = setup();
  for (let i = 0; i < 5; i++) B.add();
  check('six beds', B.count() === 6 && B.info().length === 6);
  const plate = { w: 180, d: 180 };
  // from bed 1's frame (activate it so the offsets read from it)
  B.activate(0);
  const o = i => B.offsetOf(i);
  const gapX = o(1).x - plate.w, gapZ = o(3).z - plate.d;
  check('Plate 2 is right next to Plate 1 (same row, +X)', near(o(1).z, 0) && o(1).x > 0);
  check('1 2 3 across the back row', near(o(2).z, 0) && near(o(2).x, 2 * o(1).x));
  check('4 5 6 across the front row, directly under 1 2 3', near(o(3).x, 0) && near(o(4).x, o(1).x) && near(o(5).x, o(2).x) && o(3).z > 0 && near(o(4).z, o(3).z));
  check('one equal gap, both directions', near(gapX, gapZ) && gapX > 0, 'gap ' + gapX + ' mm');
  check('the gap is a fifth of the plate (Bambu Studio\'s 1.2 stride; supp_ref reads 20 % and 21 %)', near(gapX, 36));
  s.plate = 'prusa'; app.buildPlateMesh();
  const p = { w: 250, d: 210 };
  check('a plate that is not square: still one equal gap', near(B.offsetOf(1, 0).x - p.w, B.offsetOf(3, 0).z - p.d) && near(B.offsetOf(1, 0).x - p.w, 50));
  s.plate = 'a1mini'; app.buildPlateMesh();
  const full = B.add();
  check('the 7th press adds nothing and says why', full === false && B.count() === 6 && /Six plates/.test(status[status.length - 1]), status[status.length - 1]);
  check('+ plate is disabled at six', el('btn-add-plate').disabled === true);
  B.deleteActive();
  check('... and back on at five', el('btn-add-plate').disabled === false);
}

// 2 ----------------------------------------------------------------------------------
console.log('2  one bed is the app as it was');
{
  const s = setup();
  const kids = s.scene.children.length;
  piece(s, 'a', 0, 0);
  check('no floor, no label, no group: the scene holds what buildPlateMesh made', s.scene.children.length === kids && !s.scene.children.some(c => /nsoBed/.test(c.name || '')));
  check('the border is the cyan it always was', s.plateBorder.material.color.getHex() === 0x38bdf8);
  check('Delete plate has nothing to do', BEDS_canDelete() === false && B.deleteActive() === false);
  check('count is 1 and the active bed is Plate 1', B.count() === 1 && B.activeNumber() === 1);
  app.framePlateHome();
  check('framing is today\'s: target (0, 6, 0), camera (w*1.08, max*0.92, d*1.18)',
    near(s.controls.target.x, 0) && near(s.controls.target.y, 6) && near(s.camera.position.x, 180 * 1.08) && near(s.camera.position.y, 180 * 0.92) && near(s.camera.position.z, 180 * 1.18));
}
function BEDS_canDelete() { return B.canDelete(); }

// 3 ----------------------------------------------------------------------------------
console.log('3  the active bed');
{
  const s = setup();
  const a = piece(s, 'a', -30, 12), b = piece(s, 'b', 25, -40);
  app.pushUndo({ type: 'movePlaced', index: 0, x: 0, z: 0, meshY: 5.3 });
  app.selectPlaced(1);
  B.add();                                         // Plate 2 is active, empty
  check('a new bed is active and empty', B.activeNumber() === 2 && s.placed.length === 0 && s.models.length === 0, rows());
  check('its Pieces card is empty; Plate 1\'s pieces are not listed', listed() === '');
  check('nothing of Plate 1 is under modelGroup', s.modelGroup.children.length === 0);
  check('Plate 1\'s meshes stand in its own group, one step to the left of the active Plate 2', (() => {
    const g = s.scene.children.find(c => c.name === 'nsoBed:1');
    return g && g.position.x < -180 && near(g.position.z, 0) && g.children[0].children.length === 2;
  })());
  check('the Undo line is Plate 2\'s own (empty); Plate 1\'s entry is kept', s.undoStack.length === 0 && /1:2p\/1u/.test(rows()), rows());
  check('selection and edit are not carried over', s.selectedIndex === -1 && s.editId === null);
  check('every tool was closed first (teardown ran before the swap)', calls.indexOf('teardown:plate-switch') >= 0);
  const c = piece(s, 'c', 5, 5);
  B.activate(0);
  check('back on Plate 1: its two pieces, its Pieces card, its Undo line',
    names() === 'a,b' && listed() === 'a,b' && s.undoStack.length === 1 && groupNames() === a.m.id + ',' + b.m.id, names() + ' | ' + listed());
  check('a piece\'s x / z are its own bed\'s, unchanged by the move', s.placed[0].x === -30 && s.placed[0].z === 12 && near(a.mesh.position.x, -30) && near(a.mesh.position.z, 12));
  B.activate(1);
  check('Plate 2: its one piece, listed alone', names() === 'c' && listed() === 'c' && s.undoStack.length === 0);
  check('Plate 2\'s piece at its own x / z, though its bed stood elsewhere', s.placed[0].x === 5 && near(c.mesh.position.x, 5));
  // nothing moves on screen: a point on Plate 1 projects to the same pixel before and after a switch
  B.activate(0);
  const probe = new THREE.Vector3(60, 0, 10);
  const pix = () => { const v = probe.clone().project(s.camera); return v.x.toFixed(5) + ',' + v.y.toFixed(5); };
  const before = pix();
  const world0 = probe.clone();
  const farBed = B.offsetOf(1);
  B.activate(1);
  const after = new THREE.Vector3(60 + (-farBed.x), 0, 10 + (-farBed.z)).project(s.camera);
  check('nothing moves on screen: Plate 1\'s point is at the same pixel after the camera stepped with the beds',
    after.x.toFixed(5) + ',' + after.y.toFixed(5) === before, before + ' vs ' + after.x.toFixed(5) + ',' + after.y.toFixed(5));
  check('the active bed\'s border is lit and only its border', s.plateBorder.material.color.getHex() === 0x38bdf8 &&
    (() => { const g = s.scene.children.find(x => x.name === 'nsoBed:1'); let dim = 0; g.traverse(o => { if (o.isLineSegments && o.rotation.x && o.material.color.getHex() === 0x3a404c) dim++; }); return dim === 1; })());
  check('a label under every bed, from two beds on: the active one\'s in the scene, each other bed\'s in its floor',
    s.scene.children.filter(x => x.userData && x.userData.w).length === 1 &&
    s.scene.children.filter(x => /nsoBed:/.test(x.name || '')).every(g => g.children.some(f => f.children.some(o => o.userData && o.userData.w))));
}

// 4 ----------------------------------------------------------------------------------
console.log('4  clicks');
{
  const s = setup();
  piece(s, 'a', 0, 0);
  B.add(); B.add();                                // Plate 3 active
  const shot = (x, z, type, button) => {
    const v = new THREE.Vector3(x, 0, z).project(s.camera);
    return { type: type || 'pointerup', button: button || 0, clientX: (v.x * 0.5 + 0.5) * 1000, clientY: (-v.y * 0.5 + 0.5) * 600 };
  };
  const at1 = () => { const o = B.offsetOf(0); return [o.x + 55, o.z + 55]; };
  let e = shot(...at1(), 'pointerdown');
  B.notePress(e);
  B.releasePress(Object.assign({}, e, { type: 'pointerup' }));
  check('a click on Plate 1\'s floor makes Plate 1 active', B.activeNumber() === 1, rows());
  check('... and says so', /Plate 1 is active/.test(status[status.length - 1]));
  B.activate(2);
  e = shot(...at1(), 'pointerdown');
  B.notePress(e);
  B.releasePress(Object.assign({}, e, { clientX: e.clientX + 40, type: 'pointerup' }));
  check('a drag that starts on it activates nothing (it orbits)', B.activeNumber() === 3);
  const here = shot(0, 0, 'pointerdown');
  B.notePress(here);
  B.releasePress(Object.assign({}, here, { type: 'pointerup' }));
  check('a click on the active bed\'s floor changes nothing', B.activeNumber() === 3 && s.selectedIndex === -1);
  const s2 = shot(...at1(), 'pointerdown');
  B.notePress(s2);
  B.releasePress({ type: 'pointercancel', button: 0, clientX: s2.clientX, clientY: s2.clientY });
  check('a cancelled press activates nothing', B.activeNumber() === 3);
  // a piece standing on another bed counts as that bed
  B.activate(0);
  const pa = s.placed[0];
  const tall = piece(s, 'tall', 0, 0);
  const o2 = B.offsetOf(1);
  B.activate(1);
  const stand = piece(s, 'stand', 0, 0);
  B.activate(0);
  const onPiece = shot(B.offsetOf(1).x, B.offsetOf(1).z, 'pointerdown');
  onPiece.clientY -= 2;
  check('pickBed names the bed a piece stands on', B.pickBed(onPiece) === 1, String(B.pickBed(onPiece)));
  // right click on another bed makes it active first
  B.activateUnder(shot(B.offsetOf(2).x + 50, B.offsetOf(2).z + 50, 'contextmenu', 2));
  check('a right click on another bed makes it active (Delete plate acts on the active one)', B.activeNumber() === 3);
}

// 5 ----------------------------------------------------------------------------------
console.log('5  Clear plate wipes the active bed only');
{
  const s = setup();
  const a = piece(s, 'a', 0, 0);
  app.pushUndo({ type: 'removeModel', model: a.m, index: 0, editId: null });
  B.add();
  const b = piece(s, 'b', 3, 3), b2 = piece(s, 'b2', -20, 3);
  app.pushUndo({ type: 'movePlaced', index: 0, x: 0, z: 0, meshY: 5.3 });
  calls.length = 0;
  app.clearPlateOnly();
  check('Plate 2 is empty, with no Undo line', s.placed.length === 0 && s.models.length === 0 && s.undoStack.length === 0 && s.modelGroup.children.length === 0);
  check('Plate 1 keeps its piece, its model and its Undo entry', /1:1p\/1u/.test(rows()), rows());
  check('only Plate 2\'s geometries are disposed', times(b.g) === 1 && times(b2.g) === 1 && times(a.g) === 0, `a=${times(a.g)} b=${times(b.g)} b2=${times(b2.g)}`);
  check('the Supports card forgot Plate 2\'s pieces by id, not everything', calls.includes('forget:' + b.m.id + '+' + b2.m.id) && !calls.includes('forgetAll'), calls.filter(c => /forget/.test(c)).join(','));
  B.activate(0);
  check('Plate 1 is as it was: piece, mesh, list', names() === 'a' && s.modelGroup.children.length === 1 && listed() === 'a' && s.undoStack.length === 1);
}

// 6 ----------------------------------------------------------------------------------
console.log('6  Delete plate');
{
  const s = setup();
  const a = piece(s, 'a', 10, 10);
  B.add(); const b = piece(s, 'b', -5, 7);
  B.add(); const c = piece(s, 'c', 20, -20);
  B.add(); const d = piece(s, 'd', 1, 1);
  // Plate 4 active. Delete Plate 2.
  B.activate(1);
  app.pushUndo({ type: 'movePlaced', index: 0, x: 0, z: 0, meshY: 5.3 });
  const ctxCanDelete = B.canDelete();
  check('Delete plate is on with more than one bed', ctxCanDelete === true);
  const ok = B.deleteActive();
  const said = status[status.length - 1];
  check('Plate 2 is gone: 3 beds, and the next one (old Plate 3) is active as Plate 2', ok && B.count() === 3 && B.activeNumber() === 2 && names() === 'c', rows());
  check('its pieces were wiped, geometries disposed once; the others\' were not',
    times(b.g) === 1 && times(a.g) === 0 && times(c.g) === 0 && times(d.g) === 0, `a=${times(a.g)} b=${times(b.g)} c=${times(c.g)} d=${times(d.g)}`);
  check('the beds after it moved up one number, each with its own piece, at the pose it had',
    (() => { B.activate(2); const dOk = names() === 'd' && s.placed[0].x === 1 && s.placed[0].z === 1;
             B.activate(1); const cOk = names() === 'c' && s.placed[0].x === 20 && s.placed[0].z === -20;
             B.activate(0); const aOk = names() === 'a' && s.placed[0].x === 10; return dOk && cOk && aOk; })());
  check('it says which plate is active and that there is no Undo', /deleted/.test(said) && /no Undo/i.test(said) && /Plate 2 is active/.test(said), said);
  // delete the last one: the previous becomes active
  B.activate(2);
  B.deleteActive();
  check('deleting the last bed makes the one before it active', B.count() === 2 && B.activeNumber() === 2, rows());
  B.deleteActive();
  check('down to one bed: Plate 1 is active, no label and no floor but its own, today\'s look',
    B.count() === 1 && B.activeNumber() === 1 && names() === 'a' &&
    !s.scene.children.some(x => /nsoBed/.test(x.name || '')) &&
    s.scene.children.filter(x => x.isMesh && x.geometry.type === 'PlaneGeometry').length === 1);
  check('... and Delete plate is refused, nothing wiped', B.deleteActive() === false && names() === 'a' && times(a.g) === 0);
  check('the camera is framed again (a single plate\'s)', near(s.camera.position.x, 180 * 1.08) && near(s.controls.target.x, 0));
}

// 7 + 8 -------------------------------------------------------------------------------
console.log('7  a piece dropped over another bed');
{
  const s = setup();
  const keep = piece(s, 'keep', -40, 30);
  const mv = piece(s, 'mv', 30, -20, { rotY: Math.PI / 2, tipX: 1, liftY: 0 });
  app.pushUndo({ type: 'movePlaced', index: 1, x: 0, z: 0, meshY: 5.3 });          // a step before the move
  B.add(); const other = piece(s, 'other', 0, 0); B.activate(0);
  const to = 1, off = B.offsetOf(1);
  // the drag: picked up at (0, 0), carried over Plate 2, so its own x/z are in Plate 1's frame
  app.selectPlaced(1);
  s.moveDragging = true; s.moveIndex = 1; s.moveMoved = true; s.moveUndoFrom = { index: 1, x: 0, z: 0, meshY: 5.3 };
  s.moveGrabbing = false; s.controls.enabled = true;
  mv.p.x = off.x + 12; mv.p.z = off.z - 7; mv.mesh.position.x = mv.p.x; mv.mesh.position.z = mv.p.z;
  app.endMoveDrag();
  check('the piece is on Plate 2 and Plate 2 is active', B.activeNumber() === 2 && names() === 'other,mv', rows());
  const q = s.placed.find(p => p.name === 'mv');
  check('it keeps its pose', q.rotY === Math.PI / 2 && q.tipX === 1 && q === mv.p);
  check('it lands in Plate 2\'s own frame, where it was let go', near(q.x, 12) && near(q.z, -7) && near(q.mesh.position.x, 12) && near(q.mesh.position.z, -7), q.x + ',' + q.z);
  check('it sits on Plate 2\'s floor', near(q.mesh.position.y, 0.2));
  check('it is the selection on Plate 2', s.selectedIndex === s.placed.indexOf(q) && s.editId === mv.m.id);
  check('its model is in Plate 2\'s list, Plate 1\'s Pieces card no longer has it', listed() === 'other,mv' && (B.activate(0), listed() === 'keep') && (B.activate(1), true));
  check('one entry on each bed\'s line', /1:1p\/2u 2\*:2p\/1u/.test(rows()), rows());
  check('the drag state is clear', s.moveDragging === false);
  // one Undo
  const geosBefore = made.filter(g => times(g)).length;
  app.undoLast();
  check('ONE Undo: back on Plate 1 at the pose it was picked up in, Plate 1 active',
    B.activeNumber() === 1 && names() === 'keep,mv' && near(s.placed[1].x, 0) && near(s.placed[1].z, 0) && s.placed[1].rotY === Math.PI / 2 && s.selectedIndex === 1, names() + ' ' + rows());
  check('... Plate 2 is as before the move, and both entries are gone', /1\*:2p\/1u 2:1p\/0u/.test(rows()), rows());
  check('... the piece\'s mesh is under modelGroup again, listed once', s.modelGroup.children.length === 2 && listed() === 'keep,mv');
  check('... nothing was disposed by the Undo', made.filter(g => times(g)).length === geosBefore);
  check('... and the Redo line is empty (a move is not redoable)', s.redoStack.length === 0);
  // the same from the other side: move again, switch to the source bed, Undo there
  s.selectedIndex = 1; s.moveDragging = true; s.moveIndex = 1; s.moveMoved = true; s.moveUndoFrom = { index: 1, x: 0, z: 0, meshY: 5.3 };
  s.placed[1].x = off.x; s.placed[1].z = off.z; s.placed[1].mesh.position.set(off.x, 5.3, off.z);
  app.endMoveDrag();
  B.activate(0);
  check('(moved again, now on Plate 1 to undo it from the bed it left)', names() === 'keep' && B.activeNumber() === 1);
  app.undoLast();
  check('Undo on the bed it LEFT puts it back too, in one step', names() === 'keep,mv' && B.activeNumber() === 1 && /1\*:2p\/1u 2:1p\/0u/.test(rows()), rows());
}
console.log('8  not over a bed; Undo waits for the other bed');
{
  const s = setup();
  const a = piece(s, 'a', 0, 0);
  B.add(); B.activate(0);
  // let go over the gap between the beds: today's move
  const gapX = B.offsetOf(1).x - 90 - 18;
  s.selectedIndex = 0; s.moveDragging = true; s.moveIndex = 0; s.moveMoved = true; s.moveUndoFrom = { index: 0, x: 0, z: 0, meshY: 5.3 };
  a.p.x = gapX; a.p.z = 0; a.mesh.position.set(gapX, 5.3, 0);
  app.endMoveDrag();
  check('over no bed it is the move it always was: still on Plate 1, one movePlaced entry',
    B.activeNumber() === 1 && names() === 'a' && s.undoStack.length === 1 && s.undoStack[0].type === 'movePlaced' && near(s.placed[0].x, gapX), rows() + ' ' + (s.undoStack[0] && s.undoStack[0].type));
  // over its own bed, same
  app.undoLast();
  s.selectedIndex = 0; s.moveDragging = true; s.moveIndex = 0; s.moveMoved = true; s.moveUndoFrom = { index: 0, x: 0, z: 0, meshY: 5.3 };
  a.p.x = 20; a.mesh.position.x = 20;
  app.endMoveDrag();
  check('over its own bed it is the same ordinary move', B.activeNumber() === 1 && s.undoStack[0].type === 'movePlaced');
  app.undoLast();

  // later steps on the source bed make the move wait
  const mv = piece(s, 'mv', 0, 0);
  s.selectedIndex = 1; s.moveDragging = true; s.moveIndex = 1; s.moveMoved = true; s.moveUndoFrom = { index: 1, x: 0, z: 0, meshY: 5.3 };
  const off = B.offsetOf(1);
  mv.p.x = off.x; mv.p.z = off.z; mv.mesh.position.set(off.x, 5.3, off.z);
  app.endMoveDrag();                                // Plate 2 active, holding mv
  B.activate(0);
  app.pushUndo({ type: 'movePlaced', index: 0, x: 0, z: 0, meshY: 5.3 });   // a later step on Plate 1
  B.activate(1);
  const before = rows();
  app.undoLast();
  check('Undo of the move is refused while Plate 1 has later steps: nothing moved, the entry kept',
    rows() === before && names() === 'mv' && /Plate 1 first/.test(status[status.length - 1]), rows() + ' | ' + status[status.length - 1]);
  B.activate(0);
  app.undoLast();                                   // the later step
  B.activate(1);
  app.undoLast();
  check('after that step is undone, one Undo brings it back', B.activeNumber() === 1 && names() === 'a,mv', rows());
  // a bed deleted under the move: the entry can no longer be undone and is dropped, not stuck
  s.selectedIndex = 1; s.moveDragging = true; s.moveIndex = 1; s.moveMoved = true; s.moveUndoFrom = { index: 1, x: 0, z: 0, meshY: 5.3 };
  s.placed[1].x = off.x; s.placed[1].z = off.z; s.placed[1].mesh.position.set(off.x, 5.3, off.z);
  app.endMoveDrag();                                // on Plate 2
  B.add();                                          // Plate 3
  B.activate(0);
  B.deleteActive();                                 // Plate 1 and the other half of the history are gone; Plate 2 (old) is active
  check('(Plate 1 deleted: Plate 2 is the first bed now)', B.count() === 2 && B.activeNumber() === 1 && names() === 'mv', rows());
  app.undoLast();
  check('Undo of a move whose other bed is gone drops the entry and says so; the piece stays', names() === 'mv' && s.undoStack.length === 0 && /no longer be undone/.test(status[status.length - 1]), status[status.length - 1]);
}

// 9 ----------------------------------------------------------------------------------
console.log('9  framing and the geometry lifecycle');
{
  const s = setup();
  for (let i = 0; i < 5; i++) B.add();
  B.activate(0);
  app.framePlateHome();
  s.camera.updateMatrixWorld(true); s.camera.updateProjectionMatrix();
  let inside = true, worst = 0;
  for (let i = 0; i < 6; i++) {
    const o = B.offsetOf(i);
    [[-90, -90], [90, -90], [-90, 90], [90, 90]].forEach(c => {
      const v = new THREE.Vector3(o.x + c[0], 0, o.z + c[1]).project(s.camera);
      worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) inside = false;
    });
  }
  check('all six beds are in the frame (3 x 2 block)', inside, 'worst |ndc| ' + worst.toFixed(2));
  check('the camera is in front of the block and above it, looking at its centre', s.camera.position.z > B.layoutBox().cz && s.camera.position.y > 100 && near(s.controls.target.x, B.layoutBox().cx));
  check('the far plane reaches the far corner', s.camera.far >= s.camera.position.distanceTo(new THREE.Vector3(B.layoutBox().maxx, 0, B.layoutBox().minz)));
  // the lifecycle
  const s2 = setup();
  const a = piece(s2, 'a', 0, 0);
  const prev = geo('prev');
  app.pushUndo({ type: 'sealReplace', modelId: a.m.id, prevGeometry: prev });
  B.add();
  check('a geometry only another bed\'s Undo line names is not disposed', app.nsoReleaseGeometries([prev]) === 0 && times(prev) === 0);
  B.activate(0);
  app.clearPlateOnly();
  check('... and is, once that bed is wiped', times(prev) === 1 && times(a.g) === 1);
}

// 10 ---------------------------------------------------------------------------------
console.log('10  busy');
{
  const s = setup();
  piece(s, 'a', 0, 0);
  B.add(); B.activate(0);
  ctx.__supportsBusy = true;
  check('no switch while the Supports card builds', B.activate(1) === false && B.activeNumber() === 1 && /Supports are still building/.test(status[status.length - 1]), status[status.length - 1]);
  check('no new bed either, nor Delete plate', B.add() === false && B.count() === 2 && B.deleteActive() === false && B.count() === 2);
  ctx.__supportsBusy = false;
  s.importsPending = 1;
  check('no switch while a big piece is being indexed', B.activate(1) === false && /indexed/.test(status[status.length - 1]));
  s.importsPending = 0;
  ctx.NSO_BoolBusy = { active: () => 1 };
  check('no switch while a boolean runs', B.activate(1) === false && /boolean/.test(status[status.length - 1]));
  ctx.NSO_BoolBusy = undefined;
  s.moveDragging = true;
  check('no switch mid-drag', B.activate(1) === false);
  s.moveDragging = false;
  check('and it switches when nothing is running', B.activate(1) === true && B.activeNumber() === 2);
}


// 10b --------------------------------------------------------------------------------
console.log('10b busy, for a move and its Undo; the kernel\'s first load');
{
  const s = setup();
  const a = piece(s, 'a', 0, 0), keep = piece(s, 'keep', -40, 30);
  B.add(); B.activate(0);
  const off = B.offsetOf(1);
  const drag = (idx, x, z) => {
    s.selectedIndex = idx; s.moveDragging = true; s.moveIndex = idx; s.moveMoved = true; s.moveUndoFrom = { index: idx, x: s.placed[idx].x, z: s.placed[idx].z, meshY: 5.3 };
    s.placed[idx].x = x; s.placed[idx].z = z; s.placed[idx].mesh.position.set(x, 5.3, z);
    app.endMoveDrag();
  };
  ctx.__supportsBusy = true;
  drag(0, off.x, off.z);
  check('a drop over another bed while Supports build is the ordinary move: the piece stays, nothing moved bed',
    B.activeNumber() === 1 && names() === 'a,keep' && s.undoStack.length === 1 && s.undoStack[0].type === 'movePlaced' && /Supports are still building/.test(status[status.length - 1]), rows());
  ctx.__supportsBusy = false;
  app.undoLast();
  drag(0, off.x, off.z);                              // now it goes
  check('(the same drop goes through when nothing runs)', B.activeNumber() === 2 && names() === 'a');
  ctx.__supportsBusy = true;
  const before = rows();
  app.undoLast();
  check('Undo of a move waits while a job runs: nothing moved, the entry kept', rows() === before && B.activeNumber() === 2 && /Supports are still building/.test(status[status.length - 1]), rows());
  ctx.__supportsBusy = false;
  ctx.NSO_CSG = { loading: () => true };
  check('no switch while the boolean kernel is first loading', B.activate(0) === false && /kernel/.test(status[status.length - 1]));
  ctx.NSO_CSG = undefined;
  calls.length = 0;
  app.undoLast();
  check('Undo of a move closes every tool first, as a switch does', B.activeNumber() === 1 && calls.includes('teardown:plate-move') && names() === 'a,keep', calls.join(',') + ' ' + names());
}

// 11 ---------------------------------------------------------------------------------
console.log('11 a plate size change');
{
  const s = setup();
  piece(s, 'a', 0, 0);
  B.add(); piece(s, 'b', 0, 0);
  const upd = () => { app.buildPlateMesh(); app.clearPlaced(); B.plateSizeChanged(); };   // updatePlateInfo, as app-join.js runs it
  upd();
  check('the same size again takes the active bed\'s pieces off (as it always did) and leaves the other bed alone', s.placed.length === 0 && /1:1p/.test(rows()), rows());
  s.plate = 'prusa';
  upd();
  check('a new size takes the pieces off every bed (the models stay)', /1:0p/.test(rows()) && B.info().every(b => b.placed === 0) && B.info()[0].models === 1, rows());
  const w = s.scene.children.find(c => c.name === 'nsoBed:1');
  check('and the floors are the new size', w && w.children[1].children[0].geometry.parameters.width === 250);
}

// 12 ---------------------------------------------------------------------------------
console.log('12 what cannot be moved alone');
{
  const s = setup();
  const twin = piece(s, 'twin', 0, 0);
  const copy = piece(s, 'copy', 20, 0); copy.p.sourceId = twin.m.id;                 // a second placed entry of the same model
  const host = piece(s, 'host', -30, 20), sup = piece(s, 'sup', -30, 40);
  sup.m.nsoSupport = { card: true, hostSourceId: host.m.id };
  const plain = piece(s, 'plain', 30, -30);
  B.add(); B.activate(0);
  const off = B.offsetOf(1);
  const drop = (name, x, z, from) => {
    const i = s.placed.findIndex(p => p.name === name);
    const f = from || { x: s.placed[i].x, z: s.placed[i].z };
    s.selectedIndex = i; s.moveDragging = true; s.moveIndex = i; s.moveMoved = true; s.moveUndoFrom = { index: i, x: f.x, z: f.z, meshY: 5.3 };
    s.placed[i].x = x; s.placed[i].z = z; s.placed[i].mesh.position.set(x, 5.3, z);
    app.endMoveDrag();
  };
  drop('twin', off.x, off.z);
  check('a model with another copy on the plate stays, and says why', B.activeNumber() === 1 && /copies of the same model/.test(status[status.length - 1]), status[status.length - 1]);
  drop('host', off.x, off.z);
  check('a piece with supports stays', B.activeNumber() === 1 && /has supports/.test(status[status.length - 1]), status[status.length - 1]);
  drop('sup', off.x, off.z);
  check('a support stays', B.activeNumber() === 1 && /is a support/.test(status[status.length - 1]), status[status.length - 1]);
  // a piece that began past its own bed's edge (placed there) is moved about, not carried off it
  drop('plain', off.x, off.z, { x: off.x - 20, z: 0 });
  check('a piece that started off its own bed is not carried to another by a nudge', B.activeNumber() === 1 && names().includes('plain'), rows());
  drop('plain', off.x, off.z, { x: 30, z: -30 });
  check('one that started on its bed is', B.activeNumber() === 2 && names() === 'plain', rows());
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall beds checks passed');
process.exit(fails ? 1 : 0);
