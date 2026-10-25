#!/usr/bin/env node
/* Clear plate is a wipe (app-core.js clearPlateOnly). No browser.
     node tools/nso_clear_plate_wipe_test.js     exit 0 = every gate held
     npm run clear-plate:wipe

   Clear plate used to take the copies off the plate and leave every model in
   state.models: a cut or an Undo that lays out state.models brought them
   back, and a reload from Import > Recent added a second model beside the old
   one. It now empties state.models, both stacks, and every id that named a
   model, and releases the geometries they held.

   This lifts the real functions (clearPlateOnly, clearPlaced, clearJoinSlots,
   the geometry lifecycle, the Pieces card's plate test, updateUndoBtn) into a
   vm with three.js; only what draws is stubbed. The geometries are real
   BufferGeometry with dispose() counted.

   Gates:
     1  state.models, state.placed, the Undo line and the Redo line are empty
     2  Undo and Redo buttons are off, with the "nothing" titles
     3  the edit, Join (B, C, hull, faces), Center lock, cutter, preview and selection ids are reset
     4  the Supports card was told to forget (host and memory), the face pick was cleared, helpers torn down first
     5  every geometry the models, the plate and both stacks named is disposed once; one the scene still draws is not
     6  the Pieces card, Optimize and Clone read empty (no model is on the plate)
     7  the status line still says the pieces are in Import > Recent
     8  other callers of clearPlaced keep state.models
     9  a piece loaded again after the wipe is one model, with a fresh id */

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

// --- a DOM of two buttons -----------------------------------------------------
const els = {};
const el = id => els[id] || (els[id] = { id, disabled: false, title: '', classList: { toggle() {}, add() {}, remove() {} } });
const calls = [];
const status = [];
const ctx = {
  THREE, Math, console, Object, Array, Map, Set, Number,
  window: {},
  document: { getElementById: id => (id === 'btn-undo' || id === 'btn-redo' || id === 'stats' || id === 'btn-export-stl') ? el(id) : null },
  setStatus: (t) => { status.push(t); },
  state: null
};
// what draws or lists: nothing here decides what is wiped
['renderModelList', 'updateOptimizeButton', 'updateCutterUI', 'updateEditSize', 'updateAdjustUI', 'removeCutHelper',
  'clearDisplayMeshes', 'updateJoinUI', 'removeFaceHelper']
  .forEach(n => { ctx[n] = () => { calls.push(n); }; });
ctx.clearFacePick = () => { calls.push('clearFacePick'); };
ctx.nsoHelpers = { teardown: (why) => { calls.push('teardown:' + why + ':models=' + ctx.state.models.length); } };
ctx.window = ctx;      // a browser's global is its window
ctx.NSO_SUPPORTS_CARD = { forgetAll: () => { calls.push('forgetAll:models=' + ctx.state.models.length); } };
vm.createContext(ctx);
vm.runInContext([
  'const UNDO_MAX = 40;',
  ...['updateUndoBtn', 'nsoGeometriesNamed', 'nsoReleaseGeometries', 'modelIsOnPlate', 'modelsOnPlate', 'clearPlaced', 'clearPlateOnly']
    .map(n => fnSource(core, n, 'app-core.js')),
  fnSource(join, 'clearJoinSlots', 'app-join.js'),
  'this.__app = { clearPlateOnly, clearPlaced, modelsOnPlate, modelIsOnPlate, nsoReleaseGeometries };'
].join('\n'), ctx, { filename: 'app-core.js + app-join.js (lifted)' });
const app = ctx.__app;

// --- a plate with history ----------------------------------------------------------
let disposed, made;
function geo(name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  g.name = name;
  const real = g.dispose.bind(g);
  g.dispose = () => { disposed.set(g, (disposed.get(g) || 0) + 1); real(); };
  made.push(g);
  return g;
}
const times = g => disposed.get(g) || 0;

function plate() {
  disposed = new Map(); made = []; calls.length = 0; status.length = 0;
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  const P = { gA: geo('A'), gB: geo('B'), gPrevA: geo('prevA'), gRedoA: geo('redoA'), gGone: geo('gone'), gHelper: geo('helper') };
  const mk = (id, name, g) => ({ id, name, geometry: g, quantity: 1, size: { x: 1, y: 1, z: 1 } });
  const mA = mk(1, 'a', P.gA), mB = mk(2, 'b', P.gB);
  const place = (m, i) => {
    const mesh = new THREE.Mesh(m.geometry, new THREE.MeshStandardMaterial());
    group.add(mesh);
    mesh.userData.placedIndex = i;
    return { sourceId: m.id, geometry: m.geometry, mesh, x: 0, z: 0 };
  };
  // a model removed earlier (one Undo puts it back) and a piece nothing shows: both on the Undo line
  const mGone = mk(3, 'gone', P.gGone);
  // something else the scene draws that is not a piece or a model
  const scenery = new THREE.Mesh(P.gHelper, new THREE.MeshBasicMaterial());
  scene.add(scenery);
  P.scenery = scenery;
  ctx.state = {
    scene, modelGroup: group,
    models: [mA, mB], placed: [place(mA, 0), place(mB, 1)],
    undoStack: [
      { type: 'removeModel', model: mGone, index: 2, editId: 1 },
      { type: 'sealReplace', modelId: 1, prevGeometry: P.gPrevA }
    ],
    redoStack: [{ entry: { type: 'sealReplace', modelId: 2, prevGeometry: P.gRedoA }, post: { placed: [], models: [] }, expect: 'x' }],
    editId: 1, cutT: 0.2, selectedIndex: 1, moveIndex: 1, moveDragging: true,
    previewMesh: new THREE.Mesh(P.gA), cutHelper: null, cutterOpen: true, cutTool: 'cut', cutDragging: true,
    joinSession: true, joinArmed: 'b', joinPartnerId: 2, joinHullId: 1, joinThirdId: 3, joinFaceA: { f: 1 }, joinFaceB: { f: 2 }, joinFaceC: { f: 3 },
    joinUseFaces: true, joinSlideAxis: 'x', centerLockArmed: true, centerLockTarget: { sourceId: 1 }, seatHereArmed: true
  };
  P.state = ctx.state;
  P.ids = [1, 2];
  return P;
}

console.log('1. the lists');
let P = plate();
const before = { undo: P.state.undoStack.length, redo: P.state.redoStack.length };
const released = app.clearPlateOnly();
check('the Undo line had ' + before.undo + ' and the Redo line ' + before.redo + ' entries', before.undo === 2 && before.redo === 1);
check('state.models is empty', P.state.models.length === 0);
check('state.placed is empty and the modelGroup holds nothing', P.state.placed.length === 0 && P.state.modelGroup.children.length === 0);
check('the Undo line is empty', P.state.undoStack.length === 0);
check('the Redo line is empty', P.state.redoStack.length === 0);

console.log('2. the buttons');
check('Undo is off and says so', el('btn-undo').disabled === true && /nothing to undo/i.test(el('btn-undo').title), el('btn-undo').title);
check('Redo is off and says so', el('btn-redo').disabled === true && /nothing to redo/i.test(el('btn-redo').title), el('btn-redo').title);

console.log('3. every id that named a model');
const s = P.state;
check('editId and the cut position', s.editId === null && s.cutT === 0.5);
check('selection, move and preview', s.selectedIndex === -1 && s.moveIndex === -1 && s.moveDragging === false && s.previewMesh === null);
check('cutter closed and its tool and drag forgotten', s.cutterOpen === false && s.cutTool === null && s.cutDragging === false);
check('Join: B, the hull, C, the three faces, the session and the armed slot',
  s.joinPartnerId === null && s.joinHullId === null && s.joinThirdId === null &&
  s.joinFaceA === null && s.joinFaceB === null && s.joinFaceC === null && s.joinSession === false && s.joinArmed === null);
check('Center lock target and Seat here', s.centerLockTarget === null && s.centerLockArmed === false && s.seatHereArmed === false);

console.log('4. the helpers and the Supports card, told before the models went');
check('tools closed first, while the models still stood', calls[0] === 'teardown:clear-plate:models=2', calls[0]);
check('the Supports card forgot, before the wipe', calls[1] === 'forgetAll:models=2', calls[1]);
check('the stored face pick was cleared', calls.indexOf('clearFacePick') > 1);

console.log('5. the geometries');
const named = ['gA', 'gB', 'gPrevA', 'gRedoA', 'gGone'];
check('each geometry a model, a stack entry or the plate named is disposed exactly once',
  named.every(k => times(P[k]) === 1), named.map(k => k + '=' + times(P[k])).join(' '));
check('one the scene still draws is not', times(P.gHelper) === 0);
check('clearPlateOnly returns the count', released === named.length, String(released));

console.log('6. the empty-plate state');
check('no model is on the plate (Pieces card rows, Optimize, Clone read this set)', app.modelsOnPlate().length === 0);
check('the card, Optimize, the size line, the cutter and the Adjust buttons were all refreshed',
  ['renderModelList', 'updateOptimizeButton', 'updateEditSize', 'updateCutterUI', 'updateAdjustUI'].every(n => calls.indexOf(n) >= 0));

console.log('7. the words');
check('the status line still says the pieces are in Import > Recent', status.length === 1 && /Import > Recent/.test(status[0]), status[status.length - 1]);

console.log('8. the other callers of clearPlaced re-place pieces and keep the models');
P = plate();
app.clearPlaced();
check('clearPlaced empties the plate and keeps state.models', P.state.placed.length === 0 && P.state.models.length === 2);
check('... and the Undo line', P.state.undoStack.length === 2 && P.state.redoStack.length === 1);
check('... and disposes no geometry', made.every(g => times(g) === 0));

console.log('9. loaded again');
P = plate();
app.clearPlateOnly();
P.state.models.push({ id: 4, name: 'a', geometry: geo('A2'), quantity: 1, size: { x: 1, y: 1, z: 1 } });
check('one model, not two', P.state.models.length === 1 && P.state.models[0].name === 'a');
check('its id is not one of the wiped models\'', !P.ids.includes(P.state.models[0].id));

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall clear-plate-wipe checks passed');
process.exit(fails ? 1 : 0);
