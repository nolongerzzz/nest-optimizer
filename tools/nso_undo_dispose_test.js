#!/usr/bin/env node
/* A pose bake's geometry is disposed when nothing reachable names it, and not before.
     node tools/nso_undo_dispose_test.js        exit 0 = every gate held

   A Yaw bakes the turn into a NEW geometry; Undo puts the old one back on the
   same mesh. three.js keeps the renderer's state for every geometry it has
   drawn (and the arrays it was bound to) until dispose(), so the geometry the
   Undo took off leaked once per cycle - 65 MB a time on the 947,444-triangle
   vase (tools/perf-bisect.mjs, yaw+undo). app-core.js, "GEOMETRY LIFECYCLE":
   the places entries leave the undo / redo stacks hand the geometries they
   named to nsoReleaseGeometries, which disposes the ones nothing still names.

   This lifts the real functions out of app-core.js (pushUndo, undoLast,
   redoLast, undoLastDiscard, clearRedo, clearUndo, the world snapshot and its
   restore, nsoUndoPoseBake and the lifecycle helpers) into a vm with three.js
   and stubs only for what draws or lists. The geometries are real
   BufferGeometry with dispose() counted; the Yaw is the bake's own bookkeeping
   (nsoBakePlacedPose: an entry naming the old geometry, a new one swapped onto
   model, piece and mesh, poseHome). The browser side - that the renderer really
   lets go - is the perf-bisect probe's number, not this step's.

   Gates:
     1  Yaw, Undo: nothing disposed - the geometry Undo took off is on the redo line
     2  ... Redo: the same geometry back on the mesh, nothing disposed, no new geometry
     3  Yaw, Undo, a NEW Yaw: the first Yaw's geometry is disposed once, the home and the live one are not
     4  ten Yaw -> Undo cycles: one geometry left on the redo line, the rest disposed (flat)
     5  clearRedo (the plate changed) disposes what the redo line held; Redo then has nothing
     6  an Undo that is not redoable (onUndone) disposes what it took off
     7  undoLastDiscard of a pose bake disposes what the bake put on
     8  UNDO_MAX: the entry that falls off the bottom disposes what only it named; poseHome's geometry stays
     9  never a geometry that is shared by another piece, named by poseHome, or on screen */

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

// --- lift the app's code ------------------------------------------------------
const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
function fnSource(src, name) {
  const a = src.indexOf('function ' + name + '(');
  if (a < 0) throw new Error('no function ' + name + ' in app-core.js');
  let i = src.indexOf('{', a), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const LIFTED = ['updateUndoBtn', 'pushUndo', 'clearUndo', 'clearRedo', 'undoLast', 'undoLastDiscard', 'redoLast',
  'nsoGeometriesNamed', 'nsoReleaseGeometries', 'nsoPoseBakeGeometries', 'nsoLeavingGeometries', 'nsoDropRedo',
  'nsoCopyFields', 'nsoRestoreFields', 'nsoWorldFingerprint', 'nsoWorldSnapshot', 'nsoWorldRestore', 'nsoUndoPoseBake'];
const UNDO_MAX = 5;     // the real one is 40; the trim is the same code at any size

const ctx = {
  THREE, Math, console, Object, Array, Map, Set,
  document: { getElementById: () => null },
  setStatus: () => {},
  state: null
};
// what draws, lists or measures: nothing here decides what is disposed
['renderModelList', 'updateOptimizeButton', 'updateCutterUI', 'updateEditSize', 'updateAdjustUI', 'removeCutHelper',
  'nsoInvalidatePlacedBounds', 'applyMeshRotation', 'applyPlacedXZ', 'restoreMeshY', 'refreshOutline', 'removeFaceHelper']
  .forEach(n => { ctx[n] = () => {}; });
vm.createContext(ctx);
vm.runInContext([
  'const UNDO_MAX = ' + UNDO_MAX + ';',
  'const REDO_LABEL = {}, UNDO_REPLACE_LABEL = {};',      // the status line's wording, which nothing here reads
  // undoLastStep is the real 600-line dispatcher; the one branch these steps reach is the pose bake's own Undo
  'function undoLastStep() { const e = state.undoStack.pop(); updateUndoBtn(); if (!e) return;',
  '  if (e.type === "stepGroup") { e.steps.slice().reverse().forEach(s => { state.undoStack.push(s); undoLastStep(); }); return; }',
  '  if (e.type === "poseBake") nsoUndoPoseBake(e); }',
  ...LIFTED.map(n => fnSource(core, n)),
  'this.__app = { pushUndo, clearUndo, clearRedo, undoLast, undoLastDiscard, redoLast, nsoReleaseGeometries };'
].join('\n'), ctx, { filename: 'app-core.js (lifted)' });
const app = ctx.__app;

// --- a plate: one model, one piece, the way a load leaves it ---------------------
let disposed;             // geometry -> times dispose() was called
let made;                 // every geometry this run made, in order
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
const names = gs => gs.map(g => g.name).join(',') || '(none)';

function plate(opts) {
  opts = opts || {};
  disposed = new Map(); made = [];
  const group = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(group);
  const g0 = geo('G0');
  const m = { id: 1, name: 'vase', geometry: g0, rawTris: new Float32Array(9), size: { x: 1, y: 1, z: 1 }, centerOffset: new THREE.Vector3() };
  const mesh = new THREE.Mesh(g0, new THREE.MeshStandardMaterial());
  group.add(mesh);
  const p = { sourceId: 1, geometry: g0, mesh, x: 0, z: 0, rotY: 0, poseHome: null };
  mesh.userData.placedIndex = 0;
  ctx.state = { scene, modelGroup: group, models: [m], placed: [p], undoStack: [], redoStack: [], selectedIndex: 0,
    editId: null, plateLock: false, cutterOpen: false, cutT: 0 };
  if (opts.second) {      // a second piece drawing the same geometry (a clone that shares it)
    const m2 = Object.assign({}, m, { id: 2 });
    const mesh2 = new THREE.Mesh(g0, new THREE.MeshStandardMaterial());
    group.add(mesh2);
    ctx.state.models.push(m2);
    ctx.state.placed.push({ sourceId: 2, geometry: g0, mesh: mesh2, x: 10, z: 0, poseHome: null });
  }
  return { state: ctx.state, m, p, mesh, g0, group };
}

/* nsoBakePlacedPose's bookkeeping, no maths: an Undo entry naming the geometry the piece is leaving (pushed first,
   so it empties the redo line), a new geometry swapped onto model, piece and mesh, the home recorded on the first bake. */
function yaw(P, opts) {
  opts = opts || {};
  const { m, p, mesh } = P;
  const geo0 = mesh.geometry;
  const entry = {
    type: 'poseBake', index: 0, modelId: m.id, prevPose: { x: p.x, z: p.z, rotY: 0 },
    prevGeometry: geo0, prevRawTris: m.rawTris, prevRawAxis: null, prevCenterOffset: m.centerOffset, prevSize: { x: 1, y: 1, z: 1 }
  };
  if (opts.onUndone) entry.onUndone = opts.onUndone;
  app.pushUndo(entry);
  if (!(p.poseHome && (p.poseHome.geometry === geo0 || p.poseHome.chain.has(geo0)))) p.poseHome = { chain: new WeakSet(), geometry: geo0 };
  const ng = geo('G' + made.length);
  m.geometry = ng; m.rawTris = new Float32Array(9);
  p.geometry = ng; mesh.geometry = ng;
  p.poseHome.chain.add(ng);
  return ng;
}
const undo = () => app.undoLast();
const redo = () => app.redoLast();
const live = P => P.mesh.geometry;

// 1 / 2 ------------------------------------------------------------------------
console.log('1  Yaw, Undo; 2  Redo');
{
  const P = plate();
  const g1 = yaw(P);
  undo();
  check('Undo put the old geometry back on the mesh', live(P) === P.g0);
  check('the redo line holds the turn', P.state.redoStack.length === 1);
  check('nothing disposed: the geometry Undo took off is on the redo line', made.every(g => times(g) === 0), 'disposed: ' + names(made.filter(g => times(g))));
  const before = made.length;
  redo();
  check('Redo put the SAME geometry back (no re-bake)', live(P) === g1 && P.m.geometry === g1 && P.p.geometry === g1);
  check('Redo made no geometry and disposed none', made.length === before && made.every(g => times(g) === 0));
  check('Redo put the step back on the undo line', P.state.undoStack.length === 1 && P.state.redoStack.length === 0);
  undo(); redo(); undo(); redo();
  check('Undo / Redo / Undo / Redo: still the same geometry, still nothing disposed', live(P) === g1 && made.every(g => times(g) === 0));
}

// 3 ----------------------------------------------------------------------------
console.log('3  Yaw, Undo, a NEW Yaw');
{
  const P = plate();
  const g1 = yaw(P);
  undo();
  const g2 = yaw(P);
  check('the first Yaw geometry is disposed, once', times(g1) === 1);
  check('the home geometry (on screen no more, named by poseHome and the entry) is not', times(P.g0) === 0);
  check('the new Yaw geometry (on screen) is not', times(g2) === 0 && live(P) === g2);
  check('the redo line is empty', P.state.redoStack.length === 0);
  undo();
  check('and that Undo keeps the new geometry for Redo', times(g2) === 0 && P.state.redoStack.length === 1);
}

// 4 ----------------------------------------------------------------------------
console.log('4  ten Yaw -> Undo cycles');
{
  const P = plate();
  for (let i = 0; i < 10; i++) { yaw(P); undo(); }
  const stillHeld = made.filter(g => times(g) === 0);
  check('10 geometries made, 9 disposed', made.length === 11 && made.filter(g => times(g) === 1).length === 9, made.length + ' made');
  check('what is not disposed: the home and the one on the redo line', stillHeld.length === 2 && stillHeld.includes(P.g0), names(stillHeld));
  check('no geometry disposed twice', made.every(g => times(g) <= 1));
}

// 5 ----------------------------------------------------------------------------
console.log('5  clearRedo');
{
  const P = plate();
  const g1 = yaw(P);
  undo();
  app.clearRedo();
  check('the geometry on the redo line is disposed', times(g1) === 1);
  check('the live one is not', times(P.g0) === 0);
  redo();
  check('Redo has nothing, the piece is as the Undo left it', live(P) === P.g0 && P.state.undoStack.length === 0);
}
{
  const P = plate();
  const g1 = yaw(P);
  undo();
  app.clearUndo();
  check('clearUndo disposes the redo line\'s geometry too', times(g1) === 1 && times(P.g0) === 0);
}

// 6 ----------------------------------------------------------------------------
console.log('6  an Undo that is not redoable');
{
  const P = plate();
  const g1 = yaw(P, { onUndone: () => {} });
  undo();
  check('nothing is set aside for Redo', P.state.redoStack.length === 0);
  check('what the Undo took off is disposed', times(g1) === 1 && times(P.g0) === 0);
}

// 7 ----------------------------------------------------------------------------
console.log('7  undoLastDiscard');
{
  const P = plate();
  const g1 = yaw(P);
  app.undoLastDiscard();
  check('the bake is taken back and nothing is set aside', live(P) === P.g0 && P.state.redoStack.length === 0 && P.state.undoStack.length === 0);
  check('what the bake had put on is disposed, once', times(g1) === 1 && times(P.g0) === 0);
}

// 8 ----------------------------------------------------------------------------
console.log('8  UNDO_MAX (' + UNDO_MAX + ' here)');
{
  const P = plate();
  const gs = [];
  for (let i = 0; i < UNDO_MAX; i++) gs.push(yaw(P));
  check('a full stack disposes nothing', made.every(g => times(g) === 0) && P.state.undoStack.length === UNDO_MAX);
  gs.push(yaw(P));      // entry 1 (prevGeometry G0) falls off the bottom
  check('the first entry fell off, its geometry is poseHome\'s home and stays', P.state.undoStack.length === UNDO_MAX && times(P.g0) === 0);
  gs.push(yaw(P));      // entry 2 (prevGeometry G1) falls off: nothing names G1 any more
  check('the second entry fell off and took the only name of ' + gs[0].name + ' with it', times(gs[0]) === 1, 'disposed: ' + names(made.filter(g => times(g))));
  check('the rest of the line is intact', gs.slice(1).every(g => times(g) === 0) && P.state.undoStack.length === UNDO_MAX);
  // Redo that pushes the line past UNDO_MAX trims it too
  const Q = plate();
  const qs = [];
  for (let i = 0; i < UNDO_MAX; i++) qs.push(yaw(Q));
  undo();                                  // one entry onto the redo line; G(last) is named by its post snapshot
  yaw(Q);                                  // a new action: that item leaves, the line is full again
  check('a new action after Undo on a full line: the redo geometry is disposed', times(qs[UNDO_MAX - 1]) === 1);
}
{
  const P = plate();
  for (let i = 0; i < UNDO_MAX - 1; i++) yaw(P);
  yaw(P);                                  // full
  undo();                                  // redo line: 1
  const before = made.filter(g => times(g)).length;
  redo();                                  // back on the undo line: full, no trim
  check('Redo onto a full line trims nothing it should not', made.filter(g => times(g)).length === before && P.state.undoStack.length === UNDO_MAX);
}

// 9 ----------------------------------------------------------------------------
console.log('9  what is never disposed');
{
  const P = plate({ second: true });
  const g1 = yaw(P);                       // piece 0 turns; piece 1 still draws G0
  undo();
  P.state.placed[1].mesh.geometry = g1;    // a clone of the turned piece shares G1
  P.state.placed[1].geometry = g1;
  const g2 = yaw(P);                       // a new action empties the redo line, which names G1
  check('a geometry another piece draws is not disposed', times(g1) === 0, 'G1 disposals: ' + times(g1));
  check('nor the one both pieces started from', times(P.g0) === 0);
  check('nor the live one', times(g2) === 0);
}
{
  const P = plate();
  const g1 = yaw(P);
  undo();
  P.p.poseHome.geometry = g1;              // the home names G1 (a re-homed piece)
  yaw(P);
  check('a geometry poseHome names is not disposed', times(g1) === 0);
}
{
  const P = plate();
  const g1 = yaw(P);
  undo();
  const stray = new THREE.Mesh(g1, new THREE.MeshStandardMaterial());
  P.group.add(stray);                      // something else on screen draws it (a preview, a helper)
  yaw(P);
  check('a geometry that is on screen is not disposed', times(g1) === 0);
  P.group.remove(stray);
  app.nsoReleaseGeometries([g1]);
  check('and goes the moment it is off screen and nothing names it', times(g1) === 1);
}
{
  const P = plate();
  app.nsoReleaseGeometries([P.g0, null, undefined, {}]);
  check('the geometry on the mesh survives a release that names it, and junk is ignored', times(P.g0) === 0);
}

// 10 ---------------------------------------------------------------------------
console.log('10  each holder, on its own');
{
  const holders = {
    'a model': P => P.state.models.push({ id: 9, geometry: P.x }),
    'an entry still on the undo line': P => P.state.undoStack.push({ type: 'sealReplace', prevGeometry: P.x }),
    'a redo item\'s entry': P => P.state.redoStack.push({ entry: { type: 'sealReplace', prevGeometry: P.x }, post: { models: [], placed: [] }, expect: '' }),
    'a redo item\'s plate snapshot': P => P.state.redoStack.push({ entry: { type: 'movePlaced' }, post: { models: [], placed: [{ fields: { geometry: P.x }, geo: null }] }, expect: '' }),
    'a piece\'s poseHome': P => { P.p.poseHome = { chain: new WeakSet(), geometry: P.x }; },
    'a removed piece an entry keeps (its mesh)': P => P.state.undoStack.push({ type: 'removePlaced', item: { geometry: null, mesh: new THREE.Mesh(P.x, new THREE.MeshStandardMaterial()) } }),
    'a step inside a stepGroup': P => P.state.undoStack.push({ type: 'stepGroup', steps: [{ type: 'sealReplace', prevGeometry: P.x }] })
  };
  Object.keys(holders).forEach(name => {
    const P = plate();
    P.x = geo('X');
    holders[name](P);
    app.nsoReleaseGeometries([P.x]);
    check(name + ' keeps a geometry', times(P.x) === 0);
  });
  const P = plate();
  P.x = geo('X');
  P.p.poseHome = { chain: new WeakSet([P.x]), geometry: P.g0 };
  app.nsoReleaseGeometries([P.x]);
  check('poseHome.chain alone is not a name (it is a WeakSet of "is this one of the run")', times(P.x) === 1);
}
{
  const P = plate();
  const g1 = yaw(P);
  const e = P.state.undoStack.pop();
  P.state.undoStack.push({ type: 'stepGroup', steps: [e], label: 'one press' });   // asOneStep's shape
  undo();
  check('a pose bake inside a stepGroup: Undo keeps it for Redo', live(P) === P.g0 && times(g1) === 0 && P.state.redoStack.length === 1);
  app.clearRedo();
  check('... and disposes it when the redo line goes', times(g1) === 1 && times(P.g0) === 0);
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall undo-dispose checks passed');
process.exit(fails ? 1 : 0);
