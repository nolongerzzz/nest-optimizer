/* Drive check: Skin wrap and the double skin through the REAL controls.
     node tools/nso_skin_wrap_drive_check.js          local tree
     APP_URL=https://nolongerzzz.github.io/nest-wip/ node tools/nso_skin_wrap_drive_check.js

   Same standard as tools/nso_skin_drive_check.js: every step is a click on
   the shipped UI, and the file checked is the one the browser downloaded.

   Flow (fixtures/box-20mm.stl):
     1. the file through the file input, the piece picked by clicking its row
     2. the Finish tab carries Skin wrap, the layer-2 select and Free, wired
     3. pattern = crosshatch, click Skin wrap -> all six faces, 21.2 tall
     4. Format = STL, Export plate -> the download through mesh_validate.py:
        ONE closed shell, Euler 2, 0 piercing, 0 coplanar, bbox 21.2 cubed
     5. Undo -> the 12-triangle cube back
     6. a face painted excluded -> the wrap leaves it alone and NAMES it,
        five faces wrapped, still one closed shell
     7. layer 2 = zigzag, click Skin face -> the status carries BOTH contact
        numbers, the piece is 0.9 taller
     8. Free on, click Skin face -> a second shell, the piece is flagged
        non-solid by the bake (checkbox and list tag), the export holds two
        shells touching at layer 1's tips, and Undo puts the geometry AND the
        flag back in one step
   The one step that is not a click is setting the paint (step 6): there is no
   button for a face click, so the check calls the app's own paint primitive
   and is labelled as such, the same way the Skin check does it. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skinwrap-drive-'));

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris +
  ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
  ', bbox ' + JSON.stringify(v.bbox_size);
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

const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 120000 });

/* the piece as the viewport and the list show it */
const piece = id => {
  const m = state.models.find(x => x.id === id);
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  let world = null;
  if (p) {
    p.mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(p.mesh);
    world = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  }
  const row = document.querySelector('.model-item[data-edit-id="' + id + '"]');
  return {
    tris: m.rawTris ? m.rawTris.length / 9 : null,
    size: { x: m.size.x, y: m.size.y, z: m.size.z },
    world: world,
    nonSolid: !!m.nonSolid,
    chk: !!(document.getElementById('chk-non-solid') || {}).checked,
    tag: !!(row && row.querySelector('.tag-nonsolid')),
    active: state.editId === id
  };
};

async function exportPlateSTL(page, label) {
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  check(label + ': "Export plate" downloaded an .stl (' + download.suggestedFilename() + ')', /\.stl$/.test(download.suggestedFilename()));
  return file;
}

withApp(async (page, logs) => {
  console.log('app: ' + page.url());

  console.log('\n=== 1. the file through the file input, the piece picked by clicking its row ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await page.click(`.model-item[data-edit-id="${id}"]`);
  let s = await page.evaluate(piece, id);
  check('the 20 mm cube is loaded, placed and active', s.tris === 12 && s.active && s.world && near(s.world.y, 20, 1e-4), JSON.stringify(s.size));

  console.log('\n=== 2. the Finish tab carries the new controls, wired ===');
  await openFinishMenu(page);
  const present = await page.evaluate(() => ({
    wrap: !!document.querySelector('.vp-finish #btn-skin-wrap'),
    layer2: !!document.querySelector('.vp-finish #skin-layer2'),
    free: !!document.querySelector('.vp-finish #chk-skin-free'),
    face: !!document.querySelector('.vp-finish #btn-skin-face'),
    wired: (document.getElementById('btn-skin-wrap') || {}).dataset && document.getElementById('btn-skin-wrap').dataset.nsoWired === '1',
    fns: typeof NSO_skinWrapModel === 'function' && typeof NSO_skinLayer2FromUI === 'function',
    core: typeof NSO_Skin !== 'undefined' && typeof NSO_Skin.applySkinWrap === 'function',
    options: [...document.querySelectorAll('#skin-layer2 option')].map(o => o.value)
  }));
  check('Skin wrap, the layer-2 select and Free all live in the Finish tab next to Skin face',
    present.wrap && present.layer2 && present.free && present.face, JSON.stringify(present));
  check('the wrap button has its listener, and both modules are loaded', present.wired && present.fns && present.core);
  check('layer 2 offers off / zigzag / crosshatch / crosshatch-fine / ring',
    JSON.stringify(present.options) === '["off","zigzag","crosshatch","crosshatch-fine","ring"]',
    present.options.join(','));

  console.log('\n=== 3. pattern = crosshatch, click Skin wrap ===');
  await page.selectOption('#skin-pattern', 'crosshatch');
  await page.selectOption('#skin-layer2', 'off');
  await page.click('#btn-skin-wrap');
  await waitStatus(page, /^Wrapped|^Skin wrap/);
  const st3 = await statusOf(page);
  console.log('    status: ' + st3);
  check('status: wrapped 6 faces, named, with the contact over all of them',
    /^Wrapped 6 faces \(\+Z, -Z, \+X, -X, \+Y, -Y\) - crosshatch lattice.*tips \+0\.60mm, contact \d+\.\dmm² over all of them/.test(st3), st3);
  s = await page.evaluate(piece, id);
  check('the piece went from 12 triangles to the wrapped soup', s.tris === 25308, s.tris);
  check('every axis grew by 2 x 0.6: 20 -> 21.2 in the scene',
    near(s.world.x, 21.2, 1e-4) && near(s.world.y, 21.2, 1e-4) && near(s.world.z, 21.2, 1e-4), JSON.stringify(s.world));
  check('the wrap did not flag the piece non-solid - it is still one shell', !s.nonSolid && !s.chk && !s.tag);

  console.log('\n=== 4. Format = STL, Export plate, the download through the checker ===');
  const f6 = await exportPlateSTL(page, 'wrap6');
  const v6 = meshValidate(f6);
  console.log('    ' + summary(v6));
  check('download: ONE closed shell (0 open, 0 non-manifold, Euler 2)',
    v6.open_edges === 0 && v6.nonmanifold_edges === 0 && v6.euler_characteristic === 2);
  check('download: 0 piercing, 0 coplanar, 0 degenerate, consistent winding',
    v6.self_intersection.pierce === 0 && v6.self_intersection.coplanar === 0 &&
    v6.degenerate_tris === 0 && v6.inconsistent_winding_edges === 0);
  check('download: exactly one edge-connected shell', edgeShells(parseSTL(fs.readFileSync(f6))).length === 1);
  check('download: 21.2 on every axis, the skin is in the file',
    v6.bbox_size.every(x => near(x, 21.2, 1e-4)), JSON.stringify(v6.bbox_size));
  check('download: 25308 triangles, the piece\'s own soup', v6.triangles === 25308, v6.triangles);

  console.log('\n=== 5. Undo (button) ===');
  await page.click('#btn-undo');
  s = await page.evaluate(piece, id);
  check('Undo puts the 12-triangle cube back, 20 mm', s.tris === 12 && near(s.world.y, 20, 1e-4), s.tris + ', ' + s.world.y.toFixed(4));
  check('Undo status names Skin', /Undo: Skin reverted/.test(await statusOf(page)), await statusOf(page));

  console.log('\n=== 6. a painted face is left alone and NAMED (paint set by the app primitive, NOT a click) ===');
  await page.evaluate(i => {
    const m = state.models.find(x => x.id === i);
    nsoMaskRestore(m, [{ n: [0, 0, 1], d: 10, axisIdx: 2, keepMin: false, inner: false }]);
  }, id);
  await page.click('#btn-skin-wrap');
  await waitStatus(page, /^Wrapped|^Skin wrap/);
  const st6 = await statusOf(page);
  console.log('    status: ' + st6);
  check('status: five faces wrapped, +Z named as left painted',
    /^Wrapped 5 faces \(-Z, \+X, -X, \+Y, -Y\) - .* - left painted: \+Z/.test(st6), st6);
  s = await page.evaluate(piece, id);
  check('the painted face kept its plane: the piece grew on five sides, not six (z 20.6, x and y 21.2)',
    near(s.world.y, 20.6, 1e-4) && near(s.world.x, 21.2, 1e-4) && near(s.world.z, 21.2, 1e-4), JSON.stringify(s.world));
  const f5 = await exportPlateSTL(page, 'wrap5painted');
  const v5 = meshValidate(f5);
  console.log('    ' + summary(v5));
  check('download: still one closed shell, 0 piercing',
    v5.open_edges === 0 && v5.nonmanifold_edges === 0 && v5.euler_characteristic === 2 && v5.self_intersection.pierce === 0);
  await page.click('#btn-undo');
  await page.evaluate(i => { nsoMaskRestore(state.models.find(x => x.id === i), []); }, id);

  console.log('\n=== 7. layer 2 = zigzag, click Skin face: one shell, both contact numbers ===');
  await page.selectOption('#skin-layer2', 'zigzag');
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  const st7 = await statusOf(page);
  console.log('    status: ' + st7);
  check('status: the composed layer 2 is named and the contact is given against layer 1 alone',
    /^Skinned \+Z face - crosshatch lattice.* \+ sawtooth ridges.* on its tips, tips \+0\.90mm, contact \d+\.\dmm² \(layer 1 alone: \d+\.\dmm²\)/.test(st7), st7);
  s = await page.evaluate(piece, id);
  check('the piece is 0.9 taller, not 0.6 - the two layers stack', near(s.world.y, 20.9, 1e-4), s.world.y.toFixed(4));
  check('a composed layer 2 does NOT flag the piece non-solid', !s.nonSolid && !s.chk && !s.tag);
  const fL = await exportPlateSTL(page, 'layered');
  const vL = meshValidate(fL);
  console.log('    ' + summary(vL));
  check('download: one closed shell, Euler 2, 0 piercing, 0 coplanar',
    vL.open_edges === 0 && vL.nonmanifold_edges === 0 && vL.euler_characteristic === 2 &&
    vL.self_intersection.pierce === 0 && vL.self_intersection.coplanar === 0);
  check('download: 20.9 tall', near(vL.bbox_size[2], 20.9, 1e-4), vL.bbox_size[2]);
  await page.click('#btn-undo');

  console.log('\n=== 8. Free on: a second shell, and the bake flags the piece non-solid ===');
  await page.check('#chk-skin-free');
  await page.selectOption('#skin-layer2', 'crosshatch');
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  const st8 = await statusOf(page);
  console.log('    status: ' + st8);
  check('status: names the free layer, its sheet, and the non-solid flag',
    /free layer 0\.6mm thick resting on layer 1's tips/.test(st8) && /two shells: flagged non-solid/.test(st8), st8);
  s = await page.evaluate(piece, id);
  check('the piece carries the non-solid flag, the checkbox shows it, the list row is tagged',
    s.nonSolid && s.chk && s.tag, JSON.stringify({ flag: s.nonSolid, chk: s.chk, tag: s.tag }));
  check('the scene shows the free layer standing above the tips (20 -> 21.8)', near(s.world.y, 21.8, 1e-4), s.world.y.toFixed(4));
  const fF = await exportPlateSTL(page, 'freelayer');
  const vF = meshValidate(fF);
  const shF = edgeShells(parseSTL(fs.readFileSync(fF)));
  console.log('    ' + summary(vF));
  check('download: two closed shells (Euler 4), 0 open, 0 non-manifold',
    vF.open_edges === 0 && vF.nonmanifold_edges === 0 && vF.euler_characteristic === 4);
  check('download: exactly two edge-connected shells', shF.length === 2, shF.length);
  if (shF.length === 2) {
    check('download: the free layer rests exactly on layer 1\'s tips (1e-5)', near(shF[1].zmin - shF[0].zmax, 0, 1e-5), (shF[1].zmin - shF[0].zmax).toFixed(6));
    check('download: the piece is 20.6 tall, the free layer 1.2',
      near(shF[0].zmax - shF[0].zmin, 20.6, 1e-4) && near(shF[1].zmax - shF[1].zmin, 1.2, 1e-4),
      (shF[0].zmax - shF[0].zmin).toFixed(4) + ' / ' + (shF[1].zmax - shF[1].zmin).toFixed(4));
  }
  check('download: coplanar contact seen where the sheet rests on the tips', vF.self_intersection.coplanar > 0, vF.self_intersection.coplanar);

  console.log('\n=== 8b. one Undo puts the geometry AND the flag back ===');
  await page.click('#btn-undo');
  s = await page.evaluate(piece, id);
  check('Undo: the 12-triangle cube is back', s.tris === 12 && near(s.world.y, 20, 1e-4), s.tris + ', ' + s.world.y.toFixed(4));
  check('Undo: the non-solid flag came off with it, in the SAME step', !s.nonSolid && !s.chk && !s.tag,
    JSON.stringify({ flag: s.nonSolid, chk: s.chk, tag: s.tag }));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + out);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
