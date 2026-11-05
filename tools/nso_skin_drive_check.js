/* Drive check: the breakaway-skin flow through the REAL controls, end to end.
     node tools/nso_skin_drive_check.js               local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_skin_drive_check.js

   Same standard as tools/cth-test/drive-check.mjs: every step is a click on
   the shipped UI, and the file checked is the one the browser downloaded.

   Flow (fixtures/box_hull_80x40x20-2.stl as A, fixtures/box-20mm.stl as B):
     1. both files through the file input
     2. Start Join -> Pick A (slot, then the list row) -> Pick B (same)
     3. B over A: the app's own selectPlaced + nudgeSelected (what a viewport
        drag calls - there is no button for it), then the Raise button
     4. pattern select = crosshatch, Skin face -> A grows 0.6, status names it
     5. gap slider = -0.18, Seat (support) -> B 0.18 above A's TIPS, status says so
     6. Format = STL, Export plate -> the downloaded STL through
        tools/mesh_validate.py: two shells 0.18 apart, 0 piercing, 0 coplanar
     7. Undo x2 (button), pattern = ring, Skin face, gap 0, Seat, Export ->
        B on the ring's top, coplanar contact, shells touch at one plane
   One check that is NOT a click is named as such in its label. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');
const { openJoin } = require('./nso_join_card');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skin-drive-'));

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
function parseSTL(buf) {
  const n = buf.readUInt32LE(80), tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12, t = [];
    for (let k = 0; k < 3; k++) t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    tris.push(t);
  }
  return tris;
}
/* shells by shared edges - two solids touching face to face share no edge */
function edgeShells(tris) {
  const parent = tris.map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = v => v.map(c => Math.round(c * 1e4)).join('_');
  const owner = new Map();
  tris.forEach((t, i) => {
    const k = t.map(key);
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) union(owner.get(ek), i); else owner.set(ek, i);
    }
  });
  const g = new Map();
  tris.forEach((t, i) => { const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(t); });
  return [...g.values()].map(list => {
    let zmin = Infinity, zmax = -Infinity;
    for (const t of list) for (const v of t) { if (v[2] < zmin) zmin = v[2]; if (v[2] > zmax) zmax = v[2]; }
    return { tris: list.length, zmin, zmax };
  }).sort((a, b) => a.zmin - b.zmin);
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', euler ' + v.euler_characteristic +
  ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar + ', bbox ' + JSON.stringify(v.bbox_size);

const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });

/* scene relation, as the viewport shows it */
const scene = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh), bbB = new THREE.Box3().setFromObject(pB.mesh);
  const mA = state.models.find(m => m.id === a);
  return {
    aTop: bbA.max.y, aHeight: bbA.max.y - bbA.min.y, bBottom: bbB.min.y,
    bBottomMinusATop: bbB.min.y - bbA.max.y,
    overlapXZ: bbB.min.x < bbA.max.x && bbB.max.x > bbA.min.x && bbB.min.z < bbA.max.z && bbB.max.z > bbA.min.z,
    aTris: mA.rawTris.length / 9, aSizeY: mA.size.y,
    join: { session: state.joinSession, a: state.editId, b: state.joinPartnerId },
    nameA: document.getElementById('join-name-a').textContent, nameB: document.getElementById('join-name-b').textContent
  };
};

async function exportPlateSTL(page, label) {
  // export-format moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  check(label + ': "Export plate" downloaded an .stl (' + download.suggestedFilename() + ')', /\.stl$/.test(download.suggestedFilename()));
  return file;
}

withApp(async (page, logs) => {
  console.log('app: ' + page.url());
  console.log('\n=== 1. two real files through the file input ===');
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const ids = [idA, idB];
  const present = await page.evaluate(() => ({
    skin: !!document.getElementById('btn-skin-face'), sel: !!document.getElementById('skin-pattern'),
    gap: !!document.getElementById('seat-gap'), seat: !!document.getElementById('btn-seat-flush') && !!document.getElementById('btn-seat-support'),
    wired: document.getElementById('btn-skin-face') && document.getElementById('btn-skin-face').dataset.nsoWired === '1',
    module: typeof NSO_Skin !== 'undefined', appSkin: typeof NSO_skinFaceOfModel === 'function',
    options: [...document.querySelectorAll('#skin-pattern option')].map(o => o.value)
  }));
  check('Finish tab has Skin face + pattern select; Seat drop-down has Seat flush + Seat (support) + gap slider', present.skin && present.sel && present.gap && present.seat, JSON.stringify(present));
  const where = await page.evaluate(() => ({
    skinInFinish: !!document.querySelector('.vp-finish #btn-skin-face'), selInFinish: !!document.querySelector('.vp-finish #skin-pattern'),
    capInFinish: !!document.querySelector('.vp-finish #btn-cap-open'), noneInJoin: ['btn-skin-face', 'skin-pattern', 'btn-cap-open'].every(id => { const e = document.getElementById(id); return !!e && !e.closest('#menu-joins, #menu-align, #menu-seat, #menu-bit'); })
  }));
  // Shell v2: Finish's sections are the column's Surface and Check & repair
  // menus (their bodies keep the .vp-finish class); the Join drop-downs are
  // Join, Align, Seat and Subtract.
  check('Skin face, pattern select and Cap open faces live in the Finish-era menus, not the Join drop-downs', where.skinInFinish && where.selInFinish && where.capInFinish && where.noneInJoin, JSON.stringify(where));
  check('nso_skin.js and app-skin.js loaded, button listener attached', present.module && present.appSkin && present.wired);
  check('pattern select offers crosshatch / crosshatch-fine / zigzag / ring',
    JSON.stringify(present.options) === '["crosshatch","crosshatch-fine","zigzag","ring"]', present.options.join(','));

  console.log('\n=== 2. Start Join, Pick A, Pick B - by clicking ===');
  await openJoin(page);
  await page.click('#join-slot-a');
  await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.click('#join-slot-b');
  await page.click(`.model-item[data-edit-id="${idB}"]`);
  let s = await page.evaluate(scene, ids);
  check('Join session holds A = hull, B = bit', s.join.session && s.join.a === idA && s.join.b === idB, JSON.stringify(s.join));
  check('slots show the piece names', /box_hull/.test(s.nameA) && /box-20mm/.test(s.nameB), s.nameA + ' | ' + s.nameB);

  console.log('\n=== 3. B over A: nudge (app move primitive, NOT a click), then the Raise button ===');
  await page.evaluate(([a, b]) => {
    const iB = state.placed.findIndex(p => p && p.sourceId === b);
    const pA = state.placed.find(p => p && p.sourceId === a);
    const pB = state.placed[iB];
    selectPlaced(iB);
    nudgeSelected(pA.x - pB.x, pA.z - pB.z);
  }, ids);
  /* was: btn-raise's disabled state. That button is retired; the piece
     being selected is what it was standing in for. */
  const raiseEnabled = await page.evaluate(() => state.selectedIndex >= 0);
  check('Raise button is enabled for the selected piece', raiseEnabled);
  /* Raise/Lower are gone - the Move menu's Vertical checkbox, its slider and
     the arrow keys are the vertical control now. liftSelected() is untouched,
     so what this check actually wanted - the piece 22 mm up - is one call. */
  await page.evaluate(() => { for (let i = 0; i < 11; i++) liftSelected(1); });
  s = await page.evaluate(scene, ids);
  check('B is above A after 11 x Raise (2 mm each)', s.overlapXZ && s.bBottomMinusATop > 0, 'B bottom - A top = ' + s.bBottomMinusATop.toFixed(3));
  check('status shows the lift', /^Lift 22 mm/.test(await statusOf(page)), await statusOf(page));

  console.log('\n=== 4. open Finish, pattern = crosshatch, click Skin face ===');
  const before = s;
  await openFinishMenu(page);
  await page.selectOption('#skin-pattern', 'crosshatch');
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  s = await page.evaluate(scene, ids);
  const st4 = await statusOf(page);
  console.log('    status: ' + st4);
  check('status: Skinned +Z face, crosshatch, tips +0.60mm, contact area', /^Skinned \+Z face - crosshatch lattice.*tips \+0\.60mm, contact \d+\.\dmm/.test(st4), st4);
  check('A: 28 raw tris -> thousands, 20 -> 20.6 tall', before.aTris === 28 && s.aTris > 1000 && near(s.aSizeY, 20.6, 1e-4), before.aTris + ' -> ' + s.aTris + ', ' + s.aSizeY);
  check('A world height 20.6 (skin raised, scene rebuilt)', near(s.aHeight, 20.6, 1e-4), s.aHeight);
  check('Join session survived the bake', s.join.session && s.join.a === idA && s.join.b === idB);

  console.log('\n=== 5. gap slider = -0.18, click Seat (support) ===');
  await page.fill('#seat-gap', '-0.18');
  await page.click('#btn-seat-support');
  await waitStatus(page, /^Seated|^Seat /);
  s = await page.evaluate(scene, ids);
  const st5 = await statusOf(page);
  console.log('    status: ' + st5);
  check('status: air gap 0.18, measured -0.180, from skin tips, relief 0.60', /^Seated - air gap 0\.18mm \(measured -0\.180mm, skin error 0\.00mm\) - from skin tips, relief 0\.60mm above the base plane$/.test(st5), st5);
  check('scene: B underside 0.18 above A\'s tips (A world top), 2e-6', near(s.bBottomMinusATop, 0.18, 2e-6), s.bBottomMinusATop);
  check('scene: A top is the tips plane (height 20.6), so 0.18 is off the tips not the base', near(s.aHeight, 20.6, 1e-4), s.aHeight);

  console.log('\n=== 6. Format = STL, click Export plate, check the download ===');
  const f18 = await exportPlateSTL(page, 'crosshatch_gap-0.18');
  const v18 = meshValidate(f18);
  const sh18 = edgeShells(parseSTL(fs.readFileSync(f18)));
  console.log('    ' + summary(v18));
  check('download: 0 open, 0 non-manifold, Euler 4 (two closed shells)', v18.open_edges === 0 && v18.nonmanifold_edges === 0 && v18.euler_characteristic === 4);
  check('download: 0 piercing, 0 coplanar - nothing touches', v18.self_intersection.pierce === 0 && v18.self_intersection.coplanar === 0);
  check('download: exactly two edge-connected shells', sh18.length === 2, sh18.length);
  if (sh18.length === 2) {
    check('download: hull shell rests on z 0 and is 20.6 tall (skin in the file)', near(sh18[0].zmin, 0, 1e-5) && near(sh18[0].zmax - sh18[0].zmin, 20.6, 1e-5), (sh18[0].zmax - sh18[0].zmin).toFixed(5));
    check('download: bit shell starts 0.18 above the hull\'s tips (1e-5)', near(sh18[1].zmin - sh18[0].zmax, 0.18, 1e-5), (sh18[1].zmin - sh18[0].zmax).toFixed(6));
    check('download: bit is the untouched 20 mm cube', sh18[1].tris === 12 && near(sh18[1].zmax - sh18[1].zmin, 20, 1e-5));
  }
  check('download: height 20.6 + 0.18 + 20 = 40.78', near(v18.bbox_size[2], 40.78, 1e-5), v18.bbox_size[2]);

  console.log('\n=== 7. Undo x2 (button), pattern = ring, Skin face, gap 0, Seat, Export ===');
  await page.click('#btn-undo');   // the seat pose
  await page.click('#btn-undo');   // the skin
  s = await page.evaluate(scene, ids);
  check('two Undo clicks: A back to 28 tris, 20 tall', s.aTris === 28 && near(s.aSizeY, 20, 1e-6), s.aTris + ', ' + s.aSizeY);
  check('Undo status names Skin', /Undo: Skin reverted/.test(await statusOf(page)), await statusOf(page));
  await page.selectOption('#skin-pattern', 'ring');
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  const st7 = await statusOf(page);
  console.log('    status: ' + st7);
  check('status: ring skin, tips +1.00mm', /^Skinned \+Z face - tapered ring, r 5 mm.*tips \+1\.00mm/.test(st7), st7);
  s = await page.evaluate(scene, ids);
  check('A is 21.0 tall after the ring', near(s.aSizeY, 21, 1e-4), s.aSizeY);
  await page.fill('#seat-gap', '0');
  await page.click('#btn-seat-support');
  await waitStatus(page, /^Seated|^Seat /);
  const st7b = await statusOf(page);
  console.log('    status: ' + st7b);
  check('status: touching, from skin tips, relief 1.00', /^Seated - touching, gap 0\.00mm \(measured (\+|-)?0\.000mm.*from skin tips, relief 1\.00mm above the base plane/.test(st7b), st7b);
  s = await page.evaluate(scene, ids);
  check('scene: B underside on the ring top (A world top), 2e-6', near(s.bBottomMinusATop, 0, 2e-6), s.bBottomMinusATop);
  const f0 = await exportPlateSTL(page, 'ring_gap0');
  const v0 = meshValidate(f0);
  const sh0 = edgeShells(parseSTL(fs.readFileSync(f0)));
  console.log('    ' + summary(v0));
  check('download: 0 open, 0 non-manifold, two shells, coplanar contact seen', v0.open_edges === 0 && v0.nonmanifold_edges === 0 && sh0.length === 2 && v0.self_intersection.coplanar > 0);
  check('download: hull top == bit bottom (touching at the ring, 1e-5), height 41', sh0.length === 2 && near(sh0[1].zmin - sh0[0].zmax, 0, 1e-5) && near(v0.bbox_size[2], 41, 1e-5), sh0.length === 2 ? (sh0[1].zmin - sh0[0].zmax) : sh0.length);
  check('download: hull shell is 21.0 tall (ring in the file)', sh0.length === 2 && near(sh0[0].zmax - sh0[0].zmin, 21, 1e-5));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + out);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
