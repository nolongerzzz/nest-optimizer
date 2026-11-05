#!/usr/bin/env node
/* 3MF import keeps the positions a project file gives its pieces. No browser.
     node tools/nso_import_keep_positions_test.js     exit 0 = every gate held
     npm run import:keep-positions

   A Studio project with several parts spread over its plate used to come in
   as a row along the plate edge (each piece placed beside the last, as an STL
   is). import3MF now puts each piece at the XY the file has it, through
   savedPlacements3MF: the mapping buildPlacedObjects3MF uses on export, run
   backwards (Studio X = x + w/2, Studio Y = -z + d/2).

   This lifts the real functions out of app-core.js into a vm with three.js and
   the real 3MF reader / writer / scene modules; only what draws is stubbed.
   Nothing here is a copy of the logic under test: it reads fixtures and
   asserts against numbers taken from the file itself (the reader's soup).

   Gates:
     1  fixtures/supports/supp_ref.3mf (Studio, six parts): every piece lands
        at the file's XY, to 0.01 mm, and rests on its lowest vertex
     2  round trip: import, export the plate, read the export - each piece's
        position (bounding box) equals the file's
     3  a file whose pieces do not fit the plate takes the old route (a row
        beside each other) and the status line says so
     4  a file NSO exported (scene block) and a single-object file load exactly
        as before: the same placed state, hashed, as the code before this change
   The "before" hashes in gate 4 were taken from claude-wip at 7dc1d1f; set
   NSO_CORE=<path to an older app-core.js> to print what that file gives. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const THREE = require('three');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

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

const CORE_FILE = process.env.NSO_CORE ? path.resolve(process.env.NSO_CORE) : path.join(ROOT, 'app-core.js');
const core = fs.readFileSync(CORE_FILE, 'utf8');

const LIFTED = [
  'getCurrentPlate', 'zUpToYUp', 'savedPlacements3MF', 'import3MF', 'addModelFromZUpGeometryAsync',
  'addModelFromZUpGeometry', 'addModel', 'placeNewModel', 'placeModelMovable', 'buildPlacedObjects3MF',
  'nsoPoseBelow', 'readSceneBlock', 'restoreSceneFrom3MF', 'restoreSceneObject', 'restoreScenePlate',
  'applyModelSceneState', 'applyPlacedOrientation', 'applyMeshRotation', 'clearPlaced', 'clearDisplayMeshes',
  'buildPlateSceneJson', 'capturePieceState', 'pieceBasis3MF', 'modelOfPlaced', 'geometryCenter',
  'nsoBelowOrigin'
].filter(n => core.indexOf('function ' + n + '(') >= 0);   // an older core has no savedPlacements3MF

/* One app per call: a state of its own, the real modules, the real functions. */
function newApp(opts) {
  opts = opts || {};
  const status = [];
  const noop = () => {};
  const ctx = {
    THREE, Math, console: Object.assign({}, console, { warn: () => {} }), Object, Array, Map, Set, Number, Float32Array, Uint8Array, Promise, JSON, Error,
    TextDecoder, TextEncoder, DecompressionStream, CompressionStream, Response, Blob, performance, setTimeout,
    document: { getElementById: id => (opts.dom && opts.dom[id]) || null },
    setStatus: t => { status.push(t); },
    renderModelList: noop, updateOptimizeButton: noop, updateEditSize: noop, updateAdjustUI: noop,
    updatePlateInfo: noop, selectPlaced: noop, showEditPreview: noop,
    loader: null
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // the real modules, as the page loads them (each one hangs its API on window)
  ['nso-cooling-profiles.js', 'nso-3mf.js', 'nso-3mf-read.js', 'nso-3mf-scene.js', 'nso-bounds.js', 'nso-helpers.js'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  });
  ctx.nsoHelpers = ctx.window.nsoHelpers;
  ctx.nsoBounds = ctx.window.nsoBounds;
  ctx.state = {
    plate: 'a1mini', models: [], placed: [], selectedIndex: -1, editId: null, cutT: 0.5,
    cutterOpen: false, cutTool: null, modelGroup: new THREE.Group()
  };
  const plates = core.slice(core.indexOf('const PLATES = {'), core.indexOf('};', core.indexOf('const PLATES = {')) + 2);
  vm.runInContext([
    plates, 'let nextId = 1;',
    ...LIFTED.map(n => fnSource(core, n, path.basename(CORE_FILE))),
    fnSource(fs.readFileSync(path.join(ROOT, 'app-finish.js'), 'utf8'), 'meshLocalBox3', 'app-finish.js'),
    'this.__app = { ' + LIFTED.join(', ') + ', PLATES, state: () => state };'
  ].join('\n'), ctx, { filename: 'app-core.js (lifted)' });
  const app = ctx.__app;
  app.status = status;
  app.ctx = ctx;
  return app;
}

const toAB = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const readBack = (app, bytes, name) =>
  app.ctx.NSO3MFRead.parse3MF(new Uint8Array(bytes), { name: name });

/* the piece's footprint on the plate, in the slicer's frame, from its soup */
function footprint(soup) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    x0 = Math.min(x0, soup[i]); x1 = Math.max(x1, soup[i]);
    y0 = Math.min(y0, soup[i + 1]); y1 = Math.max(y1, soup[i + 1]);
    z0 = Math.min(z0, soup[i + 2]);
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z0 };
}

/* what a piece is on the plate, in the slicer's frame, read off the scene: the
   same arithmetic the exporter uses, with nothing taken from the code under test */
function sceneFrame(entry, plate) {
  const bb = new THREE.Box3().setFromObject(entry.mesh);
  return { cx: (bb.min.x + bb.max.x) / 2 + plate.w / 2, cy: -((bb.min.z + bb.max.z) / 2) + plate.d / 2, lowY: bb.min.y };
}

/* the plate, hashed: what a piece is, where it sits and what the status said */
function plateHash(app) {
  const h = crypto.createHash('sha256');
  const st = app.state();
  st.placed.forEach(p => {
    h.update(JSON.stringify([p.name, p.x, p.z, p.rotY, p.yaw, p.liftY, p.mesh.position.x, p.mesh.position.y, p.mesh.position.z]));
    h.update(Buffer.from(new Float32Array(p.geometry.attributes.position.array).buffer));
  });
  st.models.forEach(m => h.update(JSON.stringify([m.id, m.name, m.size])));
  return h.digest('hex').slice(0, 16);
}

(async () => {
  const supp = fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'supp_ref.3mf'));
  const asRead = await newApp().ctx.NSO3MFRead.parse3MF(new Uint8Array(supp), { name: 'supp_ref.3mf' });
  const truth = asRead.objects.map(o => Object.assign({ name: o.name }, footprint(o.positions)));

  console.log('1. supp_ref.3mf: six parts, where the file puts them');
  let app = newApp();
  await app.import3MF('supp_ref.3mf', toAB(supp));
  let st = app.state();
  const plate = app.PLATES.a1mini;
  check('six pieces on the plate', st.placed.length === 6 && st.models.length === 6, String(st.placed.length));
  if (!app.savedPlacements3MF) {
    console.log('  (this core has no savedPlacements3MF: the "before" run - positions printed, gates 1-3 skipped)');
    console.log('  placed (x, z):', JSON.stringify(st.placed.map(p => [p.name, +p.x.toFixed(3), +p.z.toFixed(3)])));
    console.log('  sceneFrame:', JSON.stringify(st.placed.map(p => { const f = sceneFrame(p, plate); return [+f.cx.toFixed(3), +f.cy.toFixed(3)]; })));
  }
  const rows = [];
  truth.forEach((t, i) => {
    const p = st.placed.find(q => q.name === t.name.replace(/\.stl$/i, ''));
    const f = p ? sceneFrame(p, plate) : { cx: NaN, cy: NaN, lowY: NaN };
    rows.push([t.name, t.cx, t.cy, f.cx, f.cy, p && p.x, p && p.z]);
    if (app.savedPlacements3MF) {
      check(t.name + ' at the file\'s XY', near(f.cx, t.cx, 0.01) && near(f.cy, t.cy, 0.01),
        'file (' + t.cx.toFixed(3) + ', ' + t.cy.toFixed(3) + ') plate (' + f.cx.toFixed(3) + ', ' + f.cy.toFixed(3) + ')');
      check('  rests on its lowest vertex', p && p.mesh.position.y - p.height / 2 < 0.5 && f.lowY > -0.01 && f.lowY < 0.5,
        'lowest y ' + f.lowY.toFixed(3));
    }
  });
  check('the status says where they went', !app.savedPlacements3MF || /each at its position in the file/.test(app.status[app.status.length - 1]),
    app.status[app.status.length - 1]);

  console.log('2. round trip: import, export, read the export');
  if (app.savedPlacements3MF) {
    const objs = app.buildPlacedObjects3MF();
    const built = await app.ctx.NSO3MF.build3MF({ objects: objs, profileId: undefined, plateName: plate.name, sceneJson: app.buildPlateSceneJson() });
    const back = await readBack(app, built.bytes, 'export.3mf');
    check('six objects in the export', back.objects.length === 6, String(back.objects.length));
    truth.forEach(t => {
      const o = back.objects.find(x => x.name === t.name.replace(/\.stl$/i, '')) || back.objects.find(x => x.name === t.name);
      const f = o ? footprint(o.positions) : { cx: NaN, cy: NaN, z0: NaN };
      check(t.name + ' exported where it was', near(f.cx, t.cx, 0.01) && near(f.cy, t.cy, 0.01) && near(f.z0, 0, 0.01),
        'dx ' + (f.cx - t.cx).toExponential(1) + ' dy ' + (f.cy - t.cy).toExponential(1) + ' z0 ' + f.z0.toFixed(3));
    });
    // the same, from a copy of the export with its scene block taken away: a Studio-style read of it
    const bare = await app.ctx.NSO3MF.build3MF({ objects: objs, plateName: plate.name });
    const again = newApp();
    await again.import3MF('bare.3mf', toAB(bare.bytes));
    const st2 = again.state();
    check('the export, without its scene block, imports to the same six positions',
      st2.placed.length === 6 && truth.every(t => {
        const p = st2.placed.find(q => q.name === t.name.replace(/\.stl$/i, ''));
        const f = p ? sceneFrame(p, plate) : { cx: NaN, cy: NaN };
        return near(f.cx, t.cx, 0.01) && near(f.cy, t.cy, 0.01);
      }));
  }

  console.log('3. pieces that do not fit the plate take the old route');
  {
    // the same project on a smaller plate: two parts sit past 100 mm
    const small = newApp({ dom: { 'custom-w': { value: '100' }, 'custom-d': { value: '100' }, 'custom-h': { value: '100' } } });
    small.state().plate = 'custom';
    await small.import3MF('supp_ref.3mf', toAB(supp));
    const s3 = small.state();
    const xs = s3.placed.map(p => p.x).sort((a, b) => a - b);
    const lastSay = small.status[small.status.length - 1];
    check('six pieces still come in', s3.placed.length === 6, String(s3.placed.length));
    check('all on the one line z = 0, each beside the last (the old placement)',
      s3.placed.every(p => p.z === 0) && xs.every((x, i) => i === 0 || x > xs[i - 1] + 10), xs.map(x => x.toFixed(1)).join(' '));
    check('the status says so', /did not fit the plate at its saved positions; arranged inside it/.test(lastSay), lastSay);
    // and a file with one piece past the edge, on the plate that is selected
    const W = newApp().ctx.NSO3MF;
    const box = (x, y) => {
      const v = [], t = [];
      [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
        .forEach(c => v.push(c[0] + x, c[1] + y, c[2]));
      [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
        .forEach(f => t.push(f[0], f[1], f[2]));
      return { vertices: v, triangles: t };
    };
    const mk = (a, b) => W.build3MF({ objects: [Object.assign({ name: 'A' }, box(20, 20)), Object.assign({ name: 'B' }, box(a, b))], plateName: 'x' });
    const inside = await mk(100, 60);
    const off = await mk(175, 60);       // spans 175 - 185 on a 180 bed
    const a1 = newApp(); await a1.import3MF('in.3mf', toAB(inside.bytes));
    const a2 = newApp(); await a2.import3MF('off.3mf', toAB(off.bytes));
    if (app.savedPlacements3MF) {
      const pa = a1.state().placed;
      check('two boxes inside the bed: each at its place', pa.length === 2 &&
        near(sceneFrame(pa[0], plate).cx, 25, 0.01) && near(sceneFrame(pa[1], plate).cx, 105, 0.01) && near(sceneFrame(pa[1], plate).cy, 65, 0.01));
      const pb = a2.state().placed;
      check('one box over the edge: the whole set goes in as before, and says so',
        pb.length === 2 && pb[0].z === 0 && pb[1].z === 0 && pb[1].x > pb[0].x + 10 &&
        /did not fit the plate at its saved positions; arranged inside it/.test(a2.status[a2.status.length - 1]), a2.status[a2.status.length - 1]);
    }
  }

  console.log('4. an NSO export and a single-object file are untouched');
  {
    // NSO's own export: three pieces posed off-centre, exported with their scene block, loaded again
    const maker = newApp();
    await maker.import3MF('supp_ref.3mf', toAB(supp));
    const ms = maker.state();
    // the same hand arrangement whichever core ran: spread them as NSO would hold them, then export the plate
    ms.placed.forEach((p, i) => { p.x = -40 + 18 * i; p.z = 12 - 7 * i; p.mesh.position.x = p.x; p.mesh.position.z = p.z; });
    const exp = await maker.ctx.NSO3MF.build3MF({
      objects: maker.buildPlacedObjects3MF(), plateName: plate.name, sceneJson: maker.buildPlateSceneJson()
    });
    const nsoFile = Buffer.from(exp.bytes);
    const loaded = newApp();
    await loaded.import3MF('nso.3mf', toAB(nsoFile));
    const hNSO = plateHash(loaded);
    const hasScene = !!(await loaded.ctx.NSO3MFRead.parse3MF(new Uint8Array(nsoFile), { name: 'n' })).sceneJson;
    check('the export carries a scene block', hasScene);
    check('six pieces restored, poses as saved', loaded.state().placed.length === 6 &&
      loaded.state().placed.every((p, i) => near(p.x, -40 + 18 * i, 1e-6) && near(p.z, 12 - 7 * i, 1e-6)));
    check('the status is the restore line', /^Restored 6 piece\(s\)/.test(loaded.status[loaded.status.length - 1]), loaded.status[loaded.status.length - 1]);

    // a single object: through the ordinary path, a piece at the middle
    const one = fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf'));
    const oneRead = await newApp().ctx.NSO3MFRead.parse3MF(new Uint8Array(one), { name: 'o' });
    const solo = await newApp().ctx.NSO3MF.build3MF({
      objects: [{ name: 'solo', vertices: Array.from(oneRead.objects[0].positions).length ? indexed(oneRead.objects[0].positions).vertices : [], triangles: indexed(oneRead.objects[0].positions).triangles }],
      plateName: 'x'
    });
    const one1 = newApp();
    await one1.import3MF('solo.3mf', toAB(solo.bytes));
    const hOne = plateHash(one1);
    check('one object: one piece, at the centre, as an STL comes in',
      one1.state().placed.length === 1 && one1.state().placed[0].x === 0 && one1.state().placed[0].z === 0);

    const EXPECT = { nso: '290bd8505333799f', solo: '7c0ea3deb352d865' };
    console.log('  hashes: nso=' + hNSO + ' solo=' + hOne);
    if (!app.savedPlacements3MF) { console.log('  (before run: copy these into EXPECT)'); }
    else {
      check('the NSO export loads to the same plate as before this change', hNSO === EXPECT.nso, hNSO + ' vs ' + EXPECT.nso);
      check('the single-object file loads to the same plate as before this change', hOne === EXPECT.solo, hOne + ' vs ' + EXPECT.solo);
    }
  }

  if (process.env.NSO_REPORT && app.savedPlacements3MF) {
    console.log('\nREPORT');
    rows.forEach(r => console.log(JSON.stringify(r.map(v => typeof v === 'number' ? +v.toFixed(3) : v))));
  }
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall import-keep-positions checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* an indexed mesh from a triangle soup, by exact vertex match (what the writer takes) */
function indexed(soup) {
  const map = new Map(), vertices = [], triangles = [];
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2];
    let j = map.get(k);
    if (j === undefined) { j = vertices.length / 3; map.set(k, j); vertices.push(soup[i], soup[i + 1], soup[i + 2]); }
    triangles.push(j);
  }
  return { vertices, triangles };
}
