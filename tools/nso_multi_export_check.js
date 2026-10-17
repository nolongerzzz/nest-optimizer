/* Multi-piece plate export, checked piece by piece against the scene.
     node tools/nso_multi_export_check.js        exit 0 = every gate held

   The Seat-gap and Skin checks each prove ONE pair exports where the scene
   shows it. This one puts five pieces in three independent states on one
   plate and proves every one of them exports in its own place, with nothing
   drifting, colliding or landing on another assembly:

     free   fixtures/box-20mm.stl, loaded first and never touched - the
            ordinary piece, left exactly where the file drop put it;
     pair 1 box_hull_80x40x20-2 (A1) + box-20mm (B1), Seat (support) at the
            slider's -0.18 -> B1 0.18 mm above A1's flat top (the gap seat);
     pair 2 box_hull_80x40x20-2 (A2) + box-20mm (B2), Skin face crosshatch on
            A2, then Seat (support) at -0.05 -> B2 0.05 mm above A2's TIPS
            (the skinned seat, at a different gap so the two cannot be
            confused in the file).

   Every step is the shipped control - file input, Start Join, the slot
   buttons and the list rows, Raise, the pattern select, Skin face, the gap
   slider, Seat (support), Cancel Join, Format, Export plate - except moving
   a piece across the plate, which has no button: a viewport drag calls
   selectPlaced + nudgeSelected, and the check calls those and says so.

   The file checked is the browser's actual download, both routes:
     STL  tools/mesh_validate.py --json (the canonical checker) on the whole
          plate, then the STL split into edge-connected shells and every shell
          matched to its scene piece: X/Y extents equal to the scene's world
          box, height equal, bottom at the piece's liftY, signed volume equal
          to the piece's own raw soup, triangle count equal; pair gaps 0.18
          and 0.05 measured off the shells; no two shells of different
          assemblies overlap in X/Y;
     3MF  the same per-object relations read out of 3D/3dmodel.model, +90 mm
          plate offset accounted for.
   Then the scene is compared before and after each export (an export must
   not move anything), and a second STL export after selecting every piece
   in turn must be byte-identical to the first. */

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
const f3 = v => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const f6 = v => (Number.isFinite(v) ? v.toFixed(6) : String(v));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-multi-export-'));

/* ---- STL helpers, stdlib only ---- */
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
function triStats(list) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  for (const t of list) {
    for (const v of t) for (let a = 0; a < 3; a++) { if (v[a] < mn[a]) mn[a] = v[a]; if (v[a] > mx[a]) mx[a] = v[a]; }
    const [a, b, c] = t;
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { tris: list.length, min: mn, max: mx, volume: vol,
           centre: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] };
}
/* shells by shared edges - two solids 0.05 mm apart share no edge */
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
  return [...g.values()].map(triStats);
}
/* 3MF: one entry per <object>, vertices only (Bambu axes, plate at +90) */
function objects3MF(file) {
  const xml = execFileSync('unzip', ['-p', file, '3D/3dmodel.model'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const objs = [];
  for (const m of xml.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const verts = [...m[2].matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)" z="([-\d.eE+]+)"/g)].map(v => v.slice(1).map(Number));
    const tris = (m[2].match(/<triangle /g) || []).length;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let a = 0; a < 3; a++) { if (v[a] < mn[a]) mn[a] = v[a]; if (v[a] > mx[a]) mx[a] = v[a]; }
    objs.push({ id: Number(m[1]), verts: verts.length, tris, min: mn, max: mx,
                centre: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2] });
  }
  return objs;
}
const xyOverlap = (a, b) => {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const oy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  return { ox, oy, overlaps: ox > 0 && oy > 0 };
};

/* ---- in-page helpers ---- */
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });

/* Every placed piece, as the viewport shows it: world box (Y up), pose
   fields the export reads, and the signed volume of the model's own raw
   soup (file axes, rigid-invariant) so each exported shell can be matched
   to the geometry it came from. */
const scene = () => state.placed.map((p, i) => {
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const m = state.models.find(mm => mm.id === p.sourceId);
  let vol = 0;
  const s = m.rawTris;
  for (let t = 0; t < s.length; t += 9) {
    const ax = s[t], ay = s[t + 1], az = s[t + 2], bx = s[t + 3], by = s[t + 4], bz = s[t + 5], cx = s[t + 6], cy = s[t + 7], cz = s[t + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { i, id: p.sourceId, name: p.name, x: p.x, z: p.z, liftY: p.liftY || 0, rotY: p.rotY || 0,
           min: bb.min.toArray(), max: bb.max.toArray(), rawTris: s.length / 9, rawVolume: vol,
           posY: p.mesh.position.y };
});
/* the app's own move primitive, what a viewport drag calls - NOT a click */
async function moveTo(page, id, x, z) {
  await page.evaluate(([id, x, z]) => {
    const idx = state.placed.findIndex(p => p && p.sourceId === id);
    selectPlaced(idx);
    const p = state.placed[idx];
    nudgeSelected(x - p.x, z - p.z);
  }, [id, x, z]);
}
async function pickPair(page, idA, idB) {
  await openJoin(page);
  await page.click('#join-slot-a');
  await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.click('#join-slot-b');
  await page.click(`.model-item[data-edit-id="${idB}"]`);
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
}
async function exportPlate(page, format, label) {
  // export-format moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', format);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl')
  ]);
  const file = path.join(out, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  check(label + ': "Export plate" (' + format.toUpperCase() + ') downloaded ' + download.suggestedFilename(),
    new RegExp('\\.' + format + '$').test(download.suggestedFilename()));
  return file;
}
/* scene piece -> the box the export should write: X = x, Y = -z, Z = y - bed */
const expectedBox = (s) => ({
  min: [s.min[0], -s.max[2], s.min[1]], max: [s.max[0], -s.min[2], s.max[1]],
  centre: [(s.min[0] + s.max[0]) / 2, -(s.min[2] + s.max[2]) / 2, (s.min[1] + s.max[1]) / 2]
});
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function matchShells(shells, pieces, offXY) {
  const used = new Set();
  return pieces.map(s => {
    const e = expectedBox(s);
    let best = -1, bestD = Infinity;
    shells.forEach((sh, k) => {
      if (used.has(k)) return;
      const d = dist3([sh.centre[0] - offXY, sh.centre[1] - offXY, sh.centre[2]], e.centre);
      if (d < bestD) { bestD = d; best = k; }
    });
    used.add(best);
    return { piece: s, shell: shells[best], k: best, d: bestD, expect: e };
  });
}

withApp(async (page, logs) => {
  console.log('app: ' + page.url());
  console.log('\n=== 1. five pieces through the file input ===');
  const idFree = await loadSTL(page, fx('box-20mm.stl'));               // first in: never touched again
  const idA1 = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB1 = await loadSTL(page, fx('box-20mm.stl'));
  const idA2 = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB2 = await loadSTL(page, fx('box-20mm.stl'));
  let s = await page.evaluate(scene);
  check('five pieces on the plate', s.length === 5, s.length);
  const free0 = s.find(p => p.id === idFree);
  console.log('  free piece dropped at x ' + f3(free0.x) + ' z ' + f3(free0.z) + ', mesh y ' + f3(free0.posY) + ' (drop baseline)');
  const hullVol = meshValidate(fx('box_hull_80x40x20-2.stl')).signed_volume;
  const bitVol = meshValidate(fx('box-20mm.stl')).signed_volume;
  console.log('  fixture volumes: hull ' + f3(hullVol) + ', box ' + f3(bitVol));

  console.log('\n=== 2. hulls apart (selectPlaced + nudgeSelected: the move primitive, NOT a click) ===');
  await moveTo(page, idA1, -45, -35);
  await moveTo(page, idA2, 45, -35);
  s = await page.evaluate(scene);
  const a1 = s.find(p => p.id === idA1), a2 = s.find(p => p.id === idA2);
  check('A1 at (-45, -35), A2 at (45, -35)', near(a1.x, -45, 1e-9) && near(a1.z, -35, 1e-9) && near(a2.x, 45, 1e-9) && near(a2.z, -35, 1e-9),
    a1.x + ',' + a1.z + ' / ' + a2.x + ',' + a2.z);

  console.log('\n=== 3. pair 1: Start Join, Pick A1, Pick B1, B1 over A1, Raise x11, gap -0.18, Seat (support) ===');
  let j = await pickPair(page, idA1, idB1);
  check('Join session holds A1 / B1', j.session && j.a === idA1 && j.b === idB1, JSON.stringify(j));
  await moveTo(page, idB1, -45, -35);
  /* Raise/Lower are gone - the Move menu's Vertical checkbox, its slider
     and the arrow keys are the vertical control now. liftSelected() is
     untouched, so the 22 mm this wanted is one call. */
  await page.evaluate(() => { for (let i = 0; i < 11; i++) liftSelected(1); });
  check('status shows the lift', /^Lift 22 mm/.test(await statusOf(page)), await statusOf(page));
  await page.fill('#seat-gap', '-0.18');
  await page.click('#btn-seat-support');
  await waitStatus(page, /^Seated|^Seat /);
  const st1 = await statusOf(page);
  console.log('    status: ' + st1);
  check('pair 1 status: air gap 0.18, measured -0.180, skin error 0.00', /^Seated - air gap 0\.18mm \(measured -0\.180mm, skin error 0\.00mm\)$/.test(st1), st1);
  s = await page.evaluate(scene);
  let b1 = s.find(p => p.id === idB1); let a1s = s.find(p => p.id === idA1);
  check('scene: B1 underside 0.18 above A1 top (2e-6)', near(b1.min[1] - a1s.max[1], 0.18, 2e-6), f6(b1.min[1] - a1s.max[1]));
  await page.click('#btn-join-clear');
  check('Cancel Join ends the session', !(await page.evaluate(() => state.joinSession)));

  console.log('\n=== 4. pair 2: Start Join, Pick A2, Pick B2, B2 over A2, Raise x11, Skin face crosshatch, gap -0.05, Seat (support) ===');
  j = await pickPair(page, idA2, idB2);
  check('Join session holds A2 / B2', j.session && j.a === idA2 && j.b === idB2, JSON.stringify(j));
  await moveTo(page, idB2, 45, -35);
  /* Raise/Lower are gone - the Move menu's Vertical checkbox, its slider
     and the arrow keys are the vertical control now. liftSelected() is
     untouched, so the 22 mm this wanted is one call. */
  await page.evaluate(() => { for (let i = 0; i < 11; i++) liftSelected(1); });
  await openFinishMenu(page);   // Skin face lives in the Finish tab
  await page.selectOption('#skin-pattern', 'crosshatch');
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  const st2 = await statusOf(page);
  console.log('    status: ' + st2);
  check('A2 skinned: +Z face, crosshatch, tips +0.60mm', /^Skinned \+Z face - crosshatch lattice.*tips \+0\.60mm/.test(st2), st2);
  await page.fill('#seat-gap', '-0.05');
  await page.click('#btn-seat-support');
  await waitStatus(page, /^Seated|^Seat /);
  const st3 = await statusOf(page);
  console.log('    status: ' + st3);
  check('pair 2 status: air gap 0.05 from skin tips, relief 0.60', /^Seated - air gap 0\.05mm \(measured -0\.050mm, skin error 0\.00mm\) - from skin tips, relief 0\.60mm above the base plane$/.test(st3), st3);
  await page.click('#btn-join-clear');
  s = await page.evaluate(scene);
  const b2 = s.find(p => p.id === idB2), a2s = s.find(p => p.id === idA2);
  check('scene: B2 underside 0.05 above A2\'s tips (A2 world top), 2e-6', near(b2.min[1] - a2s.max[1], 0.05, 2e-6), f6(b2.min[1] - a2s.max[1]));
  check('scene: A2 is 20.6 tall (skin), A1 still 20.0', near(a2s.max[1] - a2s.min[1], 20.6, 1e-4) && near(a1s.max[1] - a1s.min[1], 20, 1e-4),
    f3(a2s.max[1] - a2s.min[1]) + ' / ' + f3(a1s.max[1] - a1s.min[1]));
  const freeS = s.find(p => p.id === idFree);
  check('free piece never moved: same x/z and mesh y as at the drop', near(freeS.x, free0.x, 1e-12) && near(freeS.z, free0.z, 1e-12) && near(freeS.posY, free0.posY, 1e-12) && freeS.liftY === 0,
    freeS.x + ',' + freeS.z + ' y ' + freeS.posY);

  console.log('\n=== 5. the scene, piece by piece (Y up, world boxes) ===');
  const before = s;
  for (const p of before) {
    console.log('    #' + (p.i + 1) + ' ' + p.name.padEnd(22) + ' x ' + f3(p.x).padStart(8) + ' z ' + f3(p.z).padStart(8) +
      ' liftY ' + f3(p.liftY).padStart(7) + '  box x ' + f3(p.min[0]) + '..' + f3(p.max[0]) + '  y ' + f3(p.min[1]) + '..' + f3(p.max[1]) +
      '  z ' + f3(p.min[2]) + '..' + f3(p.max[2]) + '  rawTris ' + p.rawTris + '  rawVol ' + f3(p.rawVolume));
  }
  // nothing on the plate may overlap another assembly in plan
  const asm = id => (id === idA1 || id === idB1) ? 'pair1' : (id === idA2 || id === idB2) ? 'pair2' : 'free';
  let planClash = [];
  for (let i = 0; i < before.length; i++) for (let k = i + 1; k < before.length; k++) {
    const p = before[i], q = before[k];
    if (asm(p.id) === asm(q.id)) continue;
    const ox = Math.min(p.max[0], q.max[0]) - Math.max(p.min[0], q.min[0]);
    const oz = Math.min(p.max[2], q.max[2]) - Math.max(p.min[2], q.min[2]);
    if (ox > 0 && oz > 0) planClash.push(p.name + ' x ' + q.name);
  }
  check('scene: no two assemblies overlap in plan', planClash.length === 0, planClash.join(', '));

  console.log('\n=== 6. Format = STL, Export plate, the download through the canonical checker ===');
  const stlFile = await exportPlate(page, 'stl', 'plate5');
  const afterSTL = await page.evaluate(scene);
  check('export moved nothing in the scene (every pose field and box identical)',
    JSON.stringify(afterSTL) === JSON.stringify(before));
  const v = meshValidate(stlFile);
  console.log('    mesh_validate: tris ' + v.triangles + ', open ' + v.open_edges + ', nonmanifold ' + v.nonmanifold_edges +
    ', euler ' + v.euler_characteristic + ', volume ' + f3(v.signed_volume) + ', bbox_size ' + JSON.stringify(v.bbox_size) +
    ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar);
  const expectTris = before.reduce((n, p) => n + p.rawTris, 0);
  const expectVol = before.reduce((n, p) => n + p.rawVolume, 0);
  check('triangle count = sum of the five pieces (' + expectTris + ')', v.triangles === expectTris, v.triangles);
  check('0 open, 0 non-manifold edges', v.open_edges === 0 && v.nonmanifold_edges === 0, v.open_edges + '/' + v.nonmanifold_edges);
  check('Euler characteristic 10 = five closed shells', v.euler_characteristic === 10, v.euler_characteristic);
  check('canonical checker: 0 piercing pairs (nothing penetrates anything)', v.self_intersection.pierce === 0, v.self_intersection.pierce);
  check('canonical checker: 0 coplanar contact (nothing touches anything)', v.self_intersection.coplanar === 0, v.self_intersection.coplanar);
  check('volume = sum of the five raw soups (1e-2)', near(v.signed_volume, expectVol, 1e-2), f3(v.signed_volume) + ' vs ' + f3(expectVol));
  check('two hulls + three boxes: hull volume x2 in the sum (1e-2 over the skin relief)', v.signed_volume > 2 * hullVol + 3 * bitVol, f3(v.signed_volume - (2 * hullVol + 3 * bitVol)) + ' mm^3 is the crosshatch relief');

  const shells = edgeShells(parseSTL(fs.readFileSync(stlFile)));
  check('STL splits into exactly five edge-connected shells', shells.length === 5, shells.length);
  const matched = matchShells(shells, before, 0);
  console.log('    per piece, exported shell vs scene (X = x, Y = -z, Z = height):');
  const bedOffsets = {};
  for (const m of matched) {
    const p = m.piece, sh = m.shell, e = m.expect;
    const dx = [sh.min[0] - e.min[0], sh.max[0] - e.max[0], sh.min[1] - e.min[1], sh.max[1] - e.max[1]];
    const h = sh.max[2] - sh.min[2], hs = e.max[2] - e.min[2];
    const bed = e.min[2] - sh.min[2];
    bedOffsets[p.name + '#' + p.i] = bed;
    console.log('      #' + (p.i + 1) + ' ' + p.name.padEnd(22) + ' shell x ' + f3(sh.min[0]) + '..' + f3(sh.max[0]) + ' y ' + f3(sh.min[1]) + '..' + f3(sh.max[1]) +
      ' z ' + f6(sh.min[2]) + '..' + f6(sh.max[2]) + '  tris ' + sh.tris + '  vol ' + f3(sh.volume) + '  |XY err| max ' + Math.max(...dx.map(Math.abs)).toExponential(2) +
      '  scene y_min - shell z_min = ' + f6(bed));
    check('#' + (p.i + 1) + ' ' + p.name + ': X/Y extents equal the scene world box (2e-4)', dx.every(d => Math.abs(d) <= 2e-4), dx.map(d => d.toExponential(2)).join(' '));
    check('#' + (p.i + 1) + ' ' + p.name + ': height equals the scene (2e-4)', near(h, hs, 2e-4), f6(h) + ' vs ' + f6(hs));
    check('#' + (p.i + 1) + ' ' + p.name + ': bottom at its liftY = ' + f3(p.liftY) + ' (1e-5)', near(sh.min[2], p.liftY, 1e-5), f6(sh.min[2]));
    // 1e-3 absolute plus 1e-7 relative: a 34k-triangle float32 shell at 64k mm^3
    // lands ~6e-4 off its own raw soup, which is rounding, not geometry.
    check('#' + (p.i + 1) + ' ' + p.name + ': shell volume = the piece\'s own raw soup (1e-3 + 1e-7 rel)', near(sh.volume, p.rawVolume, 1e-3 + 1e-7 * Math.abs(p.rawVolume)),
      f3(sh.volume) + ' vs ' + f3(p.rawVolume) + ', diff ' + (sh.volume - p.rawVolume).toExponential(2));
    check('#' + (p.i + 1) + ' ' + p.name + ': shell triangle count = the piece\'s raw soup', sh.tris === p.rawTris, sh.tris + ' vs ' + p.rawTris);
  }
  // The scene draws a piece 0.2 mm above the bed once it has been settled
  // (applyPlacedXZ / settlePlacedOnBed) and 0.3 mm where a file drop left it
  // (placeModelMovable's drop baseline); the export puts both on z = 0. That
  // 0.1 mm difference is in the SCENE, not the file: pinned here so the
  // number is on record rather than rediscovered.
  const bedFree = bedOffsets[freeS.name + '#' + freeS.i];
  check('untouched free piece: scene draws it 0.3 above the bed (drop baseline), exports at 0', near(bedFree, 0.3, 1e-5), f6(bedFree));
  for (const m of matched) {
    if (m.piece.id === idFree) continue;
    check('#' + (m.piece.i + 1) + ' ' + m.piece.name + ': settled piece, scene 0.2 above the bed, exports at its liftY', near(bedOffsets[m.piece.name + '#' + m.piece.i], 0.2, 1e-5), f6(bedOffsets[m.piece.name + '#' + m.piece.i]));
  }
  const shOf = id => matched.find(m => m.piece.id === id).shell;
  const gap1 = shOf(idB1).min[2] - shOf(idA1).max[2];
  const gap2 = shOf(idB2).min[2] - shOf(idA2).max[2];
  console.log('    pair gaps in the STL: pair 1 ' + f6(gap1) + ', pair 2 ' + f6(gap2) + '; A2 height ' + f6(shOf(idA2).max[2] - shOf(idA2).min[2]));
  check('pair 1 in the file: B1 0.18 above A1 (1e-5)', near(gap1, 0.18, 1e-5), f6(gap1));
  check('pair 2 in the file: B2 0.05 above A2\'s tips (1e-5)', near(gap2, 0.05, 1e-5), f6(gap2));
  check('pair 2 in the file: A2 shell is 20.6 tall (the skin is in the file)', near(shOf(idA2).max[2] - shOf(idA2).min[2], 20.6, 1e-5));
  check('pair 1 in the file: A1 shell is 20.0 tall (no skin leaked across)', near(shOf(idA1).max[2] - shOf(idA1).min[2], 20, 1e-5));
  check('both bits sit inside their hull\'s footprint', [[idA1, idB1], [idA2, idB2]].every(([a, b]) => {
    const A = shOf(a), B = shOf(b);
    return B.min[0] >= A.min[0] && B.max[0] <= A.max[0] && B.min[1] >= A.min[1] && B.max[1] <= A.max[1];
  }));
  let minSep = Infinity, clash = [];
  for (let i = 0; i < matched.length; i++) for (let k = i + 1; k < matched.length; k++) {
    const P = matched[i], Q = matched[k];
    if (asm(P.piece.id) === asm(Q.piece.id)) continue;
    const o = xyOverlap(P.shell, Q.shell);
    const sep = Math.max(-o.ox, -o.oy);
    if (sep < minSep) minSep = sep;
    if (o.overlaps) clash.push(P.piece.name + ' x ' + Q.piece.name);
  }
  console.log('    smallest plan separation between assemblies: ' + f3(minSep) + ' mm');
  check('no shell of one assembly overlaps a shell of another in X/Y', clash.length === 0 && minSep > 0, clash.join(', ') || f3(minSep));
  check('free piece in the file rests on z = 0, 20 mm cube, at its drop x/y', near(shOf(idFree).min[2], 0, 1e-5) && near(shOf(idFree).max[2], 20, 1e-5) &&
    near((shOf(idFree).min[0] + shOf(idFree).max[0]) / 2, free0.x, 2e-4) && near((shOf(idFree).min[1] + shOf(idFree).max[1]) / 2, -free0.z, 2e-4),
    JSON.stringify(shOf(idFree).min.map(f3)) + '..' + JSON.stringify(shOf(idFree).max.map(f3)));

  console.log('\n=== 7. Format = 3MF, Export plate, the same relations out of 3D/3dmodel.model ===');
  const mfFile = await exportPlate(page, '3mf', 'plate5');
  const after3MF = await page.evaluate(scene);
  check('3MF export moved nothing in the scene', JSON.stringify(after3MF) === JSON.stringify(before));
  const objs = objects3MF(mfFile);
  check('five objects in the model part', objs.length === 5, objs.length);
  const plate = await page.evaluate(() => getCurrentPlate());
  check('plate is the 180 mm A1 Mini (offset +90 in X/Y)', plate.w === 180 && plate.d === 180, JSON.stringify(plate));
  const m3 = matchShells(objs, before, 90);
  for (const m of m3) {
    const p = m.piece, o = m.shell, e = m.expect;
    const dx = [o.min[0] - 90 - e.min[0], o.max[0] - 90 - e.max[0], o.min[1] - 90 - e.min[1], o.max[1] - 90 - e.max[1]];
    console.log('      #' + (p.i + 1) + ' ' + p.name.padEnd(22) + ' object ' + o.id + ' x ' + f3(o.min[0]) + '..' + f3(o.max[0]) + ' y ' + f3(o.min[1]) + '..' + f3(o.max[1]) +
      ' z ' + f6(o.min[2]) + '..' + f6(o.max[2]) + '  tris ' + o.tris + '  |XY err| max ' + Math.max(...dx.map(Math.abs)).toExponential(2));
    check('3MF #' + (p.i + 1) + ' ' + p.name + ': X/Y extents equal the scene box + 90 (2e-4)', dx.every(d => Math.abs(d) <= 2e-4), dx.map(d => d.toExponential(2)).join(' '));
    check('3MF #' + (p.i + 1) + ' ' + p.name + ': bottom at liftY, height as the scene (1e-5 / 2e-4)', near(o.min[2], p.liftY, 1e-5) && near(o.max[2] - o.min[2], e.max[2] - e.min[2], 2e-4), f6(o.min[2]) + ' h ' + f6(o.max[2] - o.min[2]));
    check('3MF #' + (p.i + 1) + ' ' + p.name + ': triangle count = the piece\'s raw soup', o.tris === p.rawTris, o.tris + ' vs ' + p.rawTris);
    check('3MF #' + (p.i + 1) + ' ' + p.name + ': object is in order of the plate', o.id === p.i + 1, o.id);
  }
  const oOf = id => m3.find(m => m.piece.id === id).shell;
  const g1m = oOf(idB1).min[2] - oOf(idA1).max[2], g2m = oOf(idB2).min[2] - oOf(idA2).max[2];
  console.log('    pair gaps in the 3MF: pair 1 ' + f6(g1m) + ', pair 2 ' + f6(g2m));
  check('3MF pair 1: 0.18 gap (1e-5)', near(g1m, 0.18, 1e-5), f6(g1m));
  check('3MF pair 2: 0.05 gap off the tips (1e-5)', near(g2m, 0.05, 1e-5), f6(g2m));
  check('3MF: every vertex inside the 180 mm plate', objs.every(o => o.min[0] >= 0 && o.min[1] >= 0 && o.max[0] <= 180 && o.max[1] <= 180));
  let clash3 = [];
  for (let i = 0; i < m3.length; i++) for (let k = i + 1; k < m3.length; k++) {
    if (asm(m3[i].piece.id) === asm(m3[k].piece.id)) continue;
    if (xyOverlap(m3[i].shell, m3[k].shell).overlaps) clash3.push(m3[i].piece.name + ' x ' + m3[k].piece.name);
  }
  check('3MF: no object of one assembly overlaps another in X/Y', clash3.length === 0, clash3.join(', '));

  console.log('\n=== 8. select every piece in turn (list rows), export STL again: byte-identical ===');
  for (const id of [idFree, idA1, idB1, idA2, idB2]) await page.click(`.model-item[data-edit-id="${id}"]`);
  const stlFile2 = await exportPlate(page, 'stl', 'plate5_again');
  const bytes1 = fs.readFileSync(stlFile), bytes2 = fs.readFileSync(stlFile2);
  check('second STL export is byte-identical to the first (' + bytes1.length + ' bytes)', bytes1.equals(bytes2), bytes1.length + ' vs ' + bytes2.length);
  const afterAll = await page.evaluate(scene);
  check('scene still identical after selecting every piece and exporting three times', JSON.stringify(afterAll) === JSON.stringify(before));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + out);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
