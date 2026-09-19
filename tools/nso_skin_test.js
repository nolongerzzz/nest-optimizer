/* Contact skin on a face + Seat against the skin's tips, proven in Node and
   through the real app, every file through the canonical checker.
     node tools/nso_skin_test.js        exit 0 = every gate held

   Part 1 - nso_skin.js alone (no browser)
     a. each pattern on fixtures/box-20mm.stl: one closed shell (0 open,
        0 non-manifold, Euler 2), 0 piercing, 0 coplanar, volume = cube +
        the relief's analytic volume, bbox grows by the skin height.
     b. refusals return the input untouched: a curved piece, a ring that
        does not fit, recess without a rim.
     c. supportExtreme measures what is UNDER the footprint: the tips when
        a rib crosses the footprint with both its ends outside it, the base
        plane when the footprint lies entirely in a valley.
   Part 2 - the samples (tools/nso_skin_samples.js)
     For crosshatch, zigzag, ring at gap 0: the committed STL is byte-identical
     to a fresh build; exactly two edge-connected shells; each shell closed on
     its own with 0 piercing; combined volume = A + B; A's highest point equals
     B's lowest point (contact with zero penetration); B stands the full skin
     height above the base plane; the checker sees coplanar contact. Controls:
     gap -0.05 -> 0 piercing, 0 coplanar, shells 0.05 apart; +0.05 -> piercing.
   Part 3 - the real app (headless Chromium, tools/nso_app_harness.js)
     Plain 30x30x8 block A + box-20mm B. Seat gap 0 on the flat A first:
     reference 'plane', pose as always. Then the Skin face button: A's raw
     soup is replaced, undo puts it back, a painted target face stands it
     down, the sphere is refused. Skinned again, Seat gap 0: B's underside on
     A's TIPS (A's world top), 0.6 above the base plane, status names the
     tips; the core reports reference 'tips', tipRise 0.6. Seat -0.18: 0.18
     above the tips, plate export through mesh_validate: two shells 0.18
     apart, 0 piercing, 0 coplanar. Seat +0.05: 0.05 into the relief. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const NSO_Skin = require('../nso_skin.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const samples = require('./nso_skin_samples.js');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skin-'));

function meshValidate(file) {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}
function summary(v) {
  return 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', euler ' + v.euler_characteristic +
    ', vol ' + v.signed_volume.toFixed(3) + ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
    ', bbox ' + JSON.stringify(v.bbox_size);
}

/* Shells by shared EDGES (welded at 1e-4): two solids touching face to face
   share no edge, so this cannot glue them together by accident. */
function edgeShells(soup) {
  const n = soup.length / 9;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = o => Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
  const owner = new Map();
  for (let t = 0; t < n; t++) {
    const k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) union(owner.get(ek), t); else owner.set(ek, t);
    }
  }
  const groups = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()].map(list => {
    let zmin = Infinity, zmax = -Infinity;
    const out = new Float32Array(list.length * 9);
    list.forEach((t, i) => {
      for (let k = 0; k < 9; k++) out[i * 9 + k] = soup[t * 9 + k];
      for (let k = 2; k < 9; k += 3) { if (soup[t * 9 + k] < zmin) zmin = soup[t * 9 + k]; if (soup[t * 9 + k] > zmax) zmax = soup[t * 9 + k]; }
    });
    return { tris: list.length, zmin, zmax, soup: out };
  }).sort((a, b) => a.zmin - b.zmin);
}

/* ======================= Part 1: the module ======================= */
console.log('=== 1. nso_skin.js on the 20 mm cube ===');
const cube = readSTL(fx('box-20mm.stl'));
const cubeV = meshValidate(fx('box-20mm.stl')).signed_volume;
/* Keyed by pattern NAME, and this loop walks every name in PATTERNS - so a new
   preset lands here rather than being skipped, which is what caught
   crosshatch-fine the moment it was added. A preset shares its family's
   formula: the ribs are prismatic either way, so the relief is contact x
   height whatever the pitch. */
const expectedVolume = {
  crosshatch: r => cubeV + r.tipArea * r.tipHeight,
  'crosshatch-fine': r => cubeV + r.tipArea * r.tipHeight,
  zigzag: r => {
    const p = r.params, L = r.face.D - 2 * r.info.margin;
    return cubeV + r.info.ridges * ((p.base + p.tip) / 2 * p.height) * L;
  },
  ring: r => {
    /* frustum shell with regular-polygon sections (the ring is a 96-gon, so
       its section area is (n/2) r^2 sin(2pi/n), not pi r^2) */
    const p = r.params, h = p.height, t = (p.wallBase - p.wallTip) / 2, n = p.segments;
    const k = (n / 2) * Math.sin(2 * Math.PI / n);
    const ro0 = p.rOut, ro1 = p.rOut - t, ri0 = p.rOut - p.wallBase, ri1 = ri0 + t;
    const cone = (a, b) => k * h * (a * a + a * b + b * b) / 3;
    return cubeV + cone(ro0, ro1) - cone(ri0, ri1);
  }
};
for (const pat of Object.keys(NSO_Skin.PATTERNS)) {
  const r = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: pat });
  check(pat + ': applies to the +Z face', r.ok, r.reason);
  if (!r.ok) continue;
  const f = path.join(tmp, 'cube_' + pat + '.stl');
  writeSTL(f, r.tris, 'cube ' + pat);
  const v = meshValidate(f);
  console.log('    ' + pat + ': ' + summary(v) + ', tip area ' + r.tipArea.toFixed(3));
  check(pat + ': one closed shell (0 open, 0 non-manifold, Euler 2)', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2);
  check(pat + ': consistent winding, no degenerate triangles', v.inconsistent_winding_edges === 0 && v.degenerate_tris === 0);
  check(pat + ': 0 piercing, 0 coplanar pairs', v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0);
  check(pat + ': volume = cube + relief (analytic, 1e-3)', near(v.signed_volume, expectedVolume[pat](r), 1e-3), v.signed_volume.toFixed(4) + ' vs ' + expectedVolume[pat](r).toFixed(4));
  check(pat + ': bbox grows by the skin height only', near(v.bbox_size[2], 20 + r.tipHeight, 1e-5) && near(v.bbox_size[0], 20, 1e-5), JSON.stringify(v.bbox_size));
  check(pat + ': tips plane reported at 10 + height', near(r.tipsPlane, 10 + r.tipHeight, 1e-9) && near(r.basePlane, 10, 1e-9));
  check(pat + ': all 4 wall triangles bordering the face were re-fanned', r.wallTrisFanned === 4, r.wallTrisFanned);
}
{
  const r = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', mode: 'recess' });
  check('recess: applies, tips stay at the old face plane', r.ok && near(r.tipsPlane, 10, 1e-9), r.reason);
  if (r.ok) {
    const f = path.join(tmp, 'cube_recess.stl'); writeSTL(f, r.tris, 'recess');
    const v = meshValidate(f);
    check('recess: closed shell, 0 piercing, bbox unchanged', v.open_edges === 0 && v.euler_characteristic === 2 && v.self_intersection.pierce === 0 && near(v.bbox_size[2], 20, 1e-5), summary(v));
    check('recess: volume below the cube by the valleys', v.signed_volume < cubeV - 1 && v.signed_volume > cubeV - 400, v.signed_volume.toFixed(3));
  }
  const side = NSO_Skin.applySkinToFace(cube, { dir: [-1, 0, 0], pattern: 'zigzag' });
  check('a side face (-X) can be skinned too', side.ok && near(side.face.n[0], -1, 1e-9), side.reason);
}
console.log('\n--- refusals leave the input untouched ---');
{
  const sphere = readSTL(fx('fixture_sphere_curved.stl'));
  const r1 = NSO_Skin.applySkinToFace(sphere, { dir: [0, 0, 1] });
  check('curved piece refused (not a rectangle / no flat face), soup returned as is', !r1.ok && r1.tris === sphere, r1.reason);
  const r2 = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'ring', params: { rOut: 9.8 } });
  check('ring that does not fit is refused', !r2.ok && r2.tris === cube, r2.reason);
  const r3 = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'crosshatch', mode: 'recess', params: { margin: 0 } });
  check('recess without a rim is refused', !r3.ok && /rim/.test(r3.reason), r3.reason);
  const r4 = NSO_Skin.applySkinToFace(cube, { dir: [0, 0, 1], pattern: 'nope' });
  check('unknown pattern refused', !r4.ok, r4.reason);
}
console.log('\n--- supportExtreme measures what is under the footprint ---');
{
  const A = samples.buildSample('crosshatch').A;
  const ext = NSO_Skin.supportExtreme(A, [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]], [0, 0, 1], {});
  check('20 x 20 footprint over the lattice: tips at 8.6 (rib ends lie outside the footprint; Float32 soup, 1e-6)', ext && near(ext.s, 8.6, 1e-6), ext && ext.s);
  /* a valley: ribs are 0.42 wide on a 1.2 pitch starting 1.59 from the edge -> cell centre of the first valley */
  const rib0 = 1.59 - 15;                        /* first rib starts here (centred coords) */
  const vu = rib0 + 0.42 + (1.2 - 0.42) / 2;     /* middle of the first valley in u */
  const s = 0.15;
  const valley = NSO_Skin.supportExtreme(A, [[vu - s, vu - s, 0], [vu + s, vu - s, 0], [vu + s, vu + s, 0], [vu - s, vu + s, 0]], [0, 0, 1], {});
  check('footprint entirely in a valley: base plane 8.0, not the global tips', valley && near(valley.s, 8.0, 1e-6), valley && valley.s);
  const flat = NSO_Skin.supportExtreme(cube, [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]], [0, 0, 1], {});
  check('flat cube: extreme is its top face, 10', flat && near(flat.s, 10, 1e-9), flat && flat.s);
  const capped = NSO_Skin.supportExtreme(cube, [[-5, -5, 0], [5, -5, 0], [5, 5, 0], [-5, 5, 0]], [0, 0, 1], { sMax: 0 });
  check('sMax caps the search (bottom face at -10 when everything above 0 is excluded)', capped && near(capped.s, -10, 1e-9), capped && capped.s);
  const none = NSO_Skin.supportExtreme(cube, [[30, 30, 0], [31, 30, 0], [31, 31, 0], [30, 31, 0]], [0, 0, 1], {});
  check('footprint off the piece: null', none === null);
}

/* ======================= Part 2: the samples ======================= */
console.log('\n=== 2. block + skin + block samples ===');
const fresh = path.join(tmp, 'samples');
samples.writeSamples(fresh);
for (const s of samples.SAMPLES) {
  const pat = s.pattern;
  console.log('\n--- ' + pat + ' ---');
  const base = 'skin_' + pat;
  for (const f of [base + '_block.stl', base + '_A.stl', base + '_B.stl']) {
    const committed = fx(path.join('skin-samples', f));
    check(f + ' is committed and byte-identical to a fresh build', fs.existsSync(committed) && fs.readFileSync(committed).equals(fs.readFileSync(path.join(fresh, f))));
  }
  const r = samples.buildSample(pat);
  const h = r.skin.tipHeight;
  const combined = fx(path.join('skin-samples', base + '_block.stl'));
  const v = meshValidate(combined);
  const vA = meshValidate(fx(path.join('skin-samples', base + '_A.stl')));
  const vB = meshValidate(fx(path.join('skin-samples', base + '_B.stl')));
  console.log('    A+B: ' + summary(v));
  console.log('    A:   ' + summary(vA));
  console.log('    B:   ' + summary(vB));
  check('A alone: one closed shell, 0 piercing, 0 coplanar', vA.open_edges === 0 && vA.nonmanifold_edges === 0 && vA.euler_characteristic === 2 && vA.self_intersection.pierce === 0 && vA.self_intersection.coplanar === 0);
  check('B alone: one closed shell (the plain 20 x 20 x 6 block)', vB.open_edges === 0 && vB.euler_characteristic === 2 && near(vB.signed_volume, 2400, 1e-6));
  check('A+B: 0 open, 0 non-manifold edges, Euler 4 = two closed shells', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 4);
  check('A+B volume = A + B exactly (nothing shared, nothing lost)', near(v.signed_volume, vA.signed_volume + vB.signed_volume, 1e-6), v.signed_volume.toFixed(6));
  const sh = edgeShells(readSTL(combined));
  check('A+B splits into exactly two edge-connected shells', sh.length === 2, sh.length);
  if (sh.length === 2) {
    check('lower shell is A (rests on z 0), upper shell is B (12 tris)', near(sh[0].zmin, 0, 1e-9) && sh[1].tris === 12);
    check('A\'s highest point == B\'s lowest point: contact with zero penetration', sh[0].zmax === sh[1].zmin, sh[0].zmax + ' vs ' + sh[1].zmin);
    check('that contact is at the TIPS, ' + h + ' above the skin base plane (Float32, 1e-6)', near(sh[1].zmin - r.skin.basePlane, h, 1e-6), (sh[1].zmin - r.skin.basePlane).toFixed(7));
  }
  check('checker sees coplanar contact (touching), as gap 0 always reads', v.self_intersection.coplanar > 0, v.self_intersection.coplanar);
  check('contact patch under B is real and small: ' + r.meta.contact_area_under_B_mm2.toFixed(2) + ' mm^2 of 400',
    r.meta.contact_area_under_B_mm2 > 1 && r.meta.contact_area_under_B_mm2 < 400 * 0.7);
  check('bbox height = 8 + skin + 6', near(v.bbox_size[2], 8 + h + 6, 1e-5), v.bbox_size[2]);

  /* controls: the same build with an air gap and with an overlap */
  const air = samples.buildSample(pat, { gap: -0.05 });
  const fAir = path.join(tmp, base + '_air.stl'); writeSTL(fAir, air.combined, 'air');
  const va = meshValidate(fAir);
  const shAir = edgeShells(air.combined);
  check('control -0.05: 0 piercing, 0 coplanar (an air gap touches nothing)', va.self_intersection.pierce === 0 && va.self_intersection.coplanar === 0, va.self_intersection.pierce + '/' + va.self_intersection.coplanar);
  check('control -0.05: shells measured 0.05 apart off the STL', shAir.length === 2 && near(shAir[1].zmin - shAir[0].zmax, 0.05, 1e-5), shAir.length === 2 ? (shAir[1].zmin - shAir[0].zmax).toFixed(5) : shAir.length);
  const over = samples.buildSample(pat, { gap: 0.05 });
  const fOver = path.join(tmp, base + '_over.stl'); writeSTL(fOver, over.combined, 'over');
  const vo = meshValidate(fOver);
  check('control +0.05: piercing pairs (B is in the relief)', vo.self_intersection.pierce > 0, vo.self_intersection.pierce);
  check('manifest carries the numbers', (() => {
    const m = JSON.parse(fs.readFileSync(fx('skin-samples/skin-samples.json'), 'utf8')).samples[pat];
    return m && near(m.tips_measured_z, r.meta.tips_measured_z, 1e-12) && near(m.B_bottom_z, r.meta.tips_measured_z, 1e-12) && m.gap_mm === 0;
  })());
}

/* ======================= Part 3: the real app ======================= */
console.log('\n=== 3. the real app: Skin face button, Seat against the tips ===');
const blockA = path.join(tmp, 'block_30x30x8.stl');
writeSTL(blockA, samples.box(-15, 15, -15, 15, 0, 8), 'block A');

const stage = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.liftY = 0;
  pA.mesh.position.set(pA.x, pA.height / 2 + 0.3, pA.z);
  pA.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  pB.liftY = 0; pB.x = pA.x; pB.z = pA.z;
  pB.mesh.quaternion.identity();
  pB.mesh.position.set(pA.x, bbA.max.y + 5 + pB.height / 2, pA.z);
  pB.mesh.updateMatrixWorld(true);
  state.joinSession = true; state.editId = a; state.joinPartnerId = b;
  document.getElementById('status').textContent = '';
};
const relation = ([a, b]) => {
  const pA = state.placed.find(p => p && p.sourceId === a && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === b && p.mesh);
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  const bbA = new THREE.Box3().setFromObject(pA.mesh);
  const bbB = new THREE.Box3().setFromObject(pB.mesh);
  const mA = state.models.find(m => m.id === a);
  return {
    bitBottomMinusHullTop: bbB.min.y - bbA.max.y,
    hullTop: bbA.max.y, hullBottom: bbA.min.y, hullHeight: bbA.max.y - bbA.min.y,
    bitQuat: pB.mesh.quaternion.toArray(),
    status: document.getElementById('status').textContent,
    rawTrisA: mA.rawTris ? mA.rawTris.length / 9 : null,
    sizeA: mA.size
  };
};
const exportPlate = () => {
  const geo = buildCombinedGeometry();
  const buf = geometryToBinarySTL(geo);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const seatCore = ({ ids, gap }) => {
  const pA = state.placed.find(p => p && p.sourceId === ids[0] && p.mesh);
  const pB = state.placed.find(p => p && p.sourceId === ids[1] && p.mesh);
  const r = NSO_seatFlushBitToHull(pA.mesh, pB.mesh, { gap: gap });
  return { ok: r.ok, reason: r.reason, mode: r.mode, reference: r.reference, tipRise: r.tipRise, gapAchieved: r.gapAchieved, gapMin: r.gapMin, gapMax: r.gapMax, maxResidual: r.maxResidual };
};

withApp(async (page, logs) => {
  const idA = await loadSTL(page, blockA);
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const ids = [idA, idB];
  const wired = await page.evaluate(() => ({
    skin: typeof NSO_Skin !== 'undefined' && typeof NSO_Skin.supportExtreme === 'function',
    btn: !!document.getElementById('btn-skin-face') && document.getElementById('btn-skin-face').dataset.nsoWired === '1',
    sel: !!document.getElementById('skin-pattern'),
    fn: typeof NSO_skinFaceOfModel === 'function',
    probe: typeof NSO_seatTipsProbe === 'function'
  }));
  check('nso_skin.js and app-skin.js are loaded, button wired, probe present', wired.skin && wired.btn && wired.sel && wired.fn && wired.probe, JSON.stringify(wired));

  console.log('\n--- flat A: Seat gap 0 still measures the plane ---');
  await page.evaluate(stage, ids);
  const flatCore = await page.evaluate(seatCore, { ids, gap: 0 });
  check('core on a flat hull: reference plane, tipRise ~ 0', flatCore.ok && flatCore.reference === 'plane' && Math.abs(flatCore.tipRise) < 1e-4, JSON.stringify(flatCore));
  await page.evaluate(stage, ids);
  await page.evaluate(() => { document.getElementById('seat-gap').value = '0'; });
  await page.click('#btn-seat-support');
  const flat0 = await page.evaluate(relation, ids);
  check('flat A, gap 0: B rests on A\'s top (2e-6)', near(flat0.bitBottomMinusHullTop, 0, 2e-6), flat0.bitBottomMinusHullTop);
  check('flat A status does not mention tips', /^Seated - touching/.test(flat0.status) && !/tips/.test(flat0.status), flat0.status);

  console.log('\n--- Skin face button on A (crosshatch, toward B) ---');
  await page.evaluate(stage, ids);
  const before = await page.evaluate(relation, ids);
  await openFinishMenu(page);   // Skin face lives in the Finish tab
  await page.selectOption('#skin-pattern', 'crosshatch');
  await page.click('#btn-skin-face');
  await page.waitForFunction(() => /Skinned|Skin /.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const skinned = await page.evaluate(relation, ids);
  console.log('    status: ' + skinned.status);
  check('status reports the skin and the contact area', /^Skinned \+Z face - crosshatch lattice/.test(skinned.status) && /contact \d+\.\dmm/.test(skinned.status), skinned.status);
  check('A\'s raw soup was replaced (12 tris -> thousands)', before.rawTrisA === 12 && skinned.rawTrisA > 1000, before.rawTrisA + ' -> ' + skinned.rawTrisA);
  check('A is now 8.6 tall (skin raised 0.6)', near(skinned.sizeA.y, 8.6, 1e-4) && near(skinned.hullHeight, 8.6, 1e-4), skinned.sizeA.y);
  await page.evaluate(() => undoLast());
  const afterUndo = await page.evaluate(([a, b]) => {
    const mA = state.models.find(m => m.id === a);
    return { tris: mA.rawTris.length / 9, size: mA.size.y, status: document.getElementById('status').textContent };
  }, ids);
  check('Undo puts the plain block back (12 tris, 8 tall)', afterUndo.tris === 12 && near(afterUndo.size, 8, 1e-6), JSON.stringify(afterUndo));
  check('Undo status names Skin', /Undo: Skin reverted/.test(afterUndo.status), afterUndo.status);

  console.log('\n--- paint on the target face stands the bake down ---');
  await page.evaluate(stage, ids);
  await page.evaluate(([a]) => {
    const mA = state.models.find(m => m.id === a);
    nsoMaskRestore(mA, [{ n: [0, 0, 1], d: 8, axisIdx: 2, keepMin: false, inner: false }]);
  }, ids);
  await page.click('#btn-skin-face');
  const painted = await page.evaluate(relation, ids);
  check('painted +Z face: stood down, named, piece unchanged', /Skin stood down - \+Z face is painted/.test(painted.status) && painted.rawTrisA === 12, painted.status);
  await page.evaluate(([a]) => {
    const mA = state.models.find(m => m.id === a);
    /* paint on the -Z face (not the target) must not block it */
    nsoMaskRestore(mA, [{ n: [0, 0, -1], d: 0, axisIdx: 2, keepMin: true, inner: false }]);
  }, ids);
  await page.click('#btn-skin-face');
  const other = await page.evaluate(relation, ids);
  check('paint on a different face does not block (sub-region scope)', /^Skinned/.test(other.status) && other.rawTrisA > 1000, other.status);
  await page.evaluate(([a]) => { undoLast(); const mA = state.models.find(m => m.id === a); nsoMaskRestore(mA, []); }, ids);

  console.log('\n--- skinned A + B: Seat gap 0 lands on the TIPS ---');
  await page.evaluate(stage, ids);
  await page.click('#btn-skin-face');
  await page.waitForFunction(() => /^Skinned/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  await page.evaluate(stage, ids);   // the bake re-seated A; put B back above it
  const core0 = await page.evaluate(seatCore, { ids, gap: 0 });
  console.log('    core gap 0: ' + JSON.stringify(core0));
  check('core: reference is the skin tips', core0.ok && core0.mode === 'gap' && core0.reference === 'tips');
  check('core: tipRise 0.6 = the relief height (corner rays would have found the base plane)', near(core0.tipRise, 0.6, 1e-4), core0.tipRise);
  check('core: gapAchieved 0 from the tips, min..max tight', near(core0.gapAchieved, 0, 1e-6) && near(core0.gapMin, 0, 1e-6) && near(core0.gapMax, 0, 1e-6), core0.gapAchieved);

  await page.evaluate(stage, ids);
  await page.evaluate(() => { document.getElementById('seat-gap').value = '0'; });
  await page.click('#btn-seat-support');
  const g0 = await page.evaluate(relation, ids);
  console.log('    status: ' + g0.status);
  check('button gap 0: B\'s underside on A\'s tips = A\'s world top (2e-6)', near(g0.bitBottomMinusHullTop, 0, 2e-6), g0.bitBottomMinusHullTop);
  check('button gap 0: B stands 0.6 above the base plane (hull height 8.6, not 8)', near(g0.hullHeight, 8.6, 1e-4), g0.hullHeight);
  check('status says touching AND names the tips with the relief height', /^Seated - touching, gap 0\.00mm \(measured (\+|-)?0\.000mm.*from skin tips, relief 0\.60mm above the base plane/.test(g0.status), g0.status);
  check('B untilted', g0.bitQuat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)));
  const stl0 = path.join(tmp, 'app_skin_gap0.stl');
  fs.writeFileSync(stl0, Buffer.from(await page.evaluate(exportPlate), 'base64'));
  const v0 = meshValidate(stl0);
  const sh0 = edgeShells(readSTL(stl0));
  console.log('    export gap 0: ' + summary(v0));
  check('export gap 0: 0 open, 0 non-manifold, two shells, coplanar contact', v0.open_edges === 0 && v0.nonmanifold_edges === 0 && sh0.length === 2 && v0.self_intersection.coplanar > 0);
  check('export gap 0: A top == B bottom in the file (1e-5), height 8.6 + 20', sh0.length === 2 && near(sh0[1].zmin - sh0[0].zmax, 0, 1e-5) && near(v0.bbox_size[2], 28.6, 1e-5), sh0.length === 2 ? (sh0[1].zmin - sh0[0].zmax) : sh0.length);

  console.log('\n--- gap -0.18 above the tips, exported ---');
  await page.evaluate(stage, ids);
  await page.evaluate(() => { document.getElementById('seat-gap').value = '-0.18'; });
  await page.click('#btn-seat-support');
  const g18 = await page.evaluate(relation, ids);
  console.log('    status: ' + g18.status);
  check('scene: B 0.18 above the tips (2e-6)', near(g18.bitBottomMinusHullTop, 0.18, 2e-6), g18.bitBottomMinusHullTop);
  check('status names the air gap and the tips', /^Seated - air gap 0\.18mm \(measured -0\.180mm.*from skin tips/.test(g18.status), g18.status);
  const stl18 = path.join(tmp, 'app_skin_gap-0.18.stl');
  fs.writeFileSync(stl18, Buffer.from(await page.evaluate(exportPlate), 'base64'));
  const v18 = meshValidate(stl18);
  const sh18 = edgeShells(readSTL(stl18));
  console.log('    export -0.18: ' + summary(v18));
  check('export -0.18: 0 piercing, 0 coplanar - nothing touches', v18.self_intersection.pierce === 0 && v18.self_intersection.coplanar === 0);
  check('export -0.18: shells 0.18 apart, measured tips to B (1e-5)', sh18.length === 2 && near(sh18[1].zmin - sh18[0].zmax, 0.18, 1e-5), sh18.length === 2 ? (sh18[1].zmin - sh18[0].zmax) : sh18.length);
  check('export -0.18: height 8.6 + 0.18 + 20', near(v18.bbox_size[2], 28.78, 1e-5), v18.bbox_size[2]);

  console.log('\n--- gap +0.05: into the relief, not through it ---');
  await page.evaluate(stage, ids);
  await page.evaluate(() => { document.getElementById('seat-gap').value = '0.05'; });
  await page.click('#btn-seat-support');
  const g05 = await page.evaluate(relation, ids);
  check('scene: B 0.05 below the tips, still 0.55 above the base plane', near(g05.bitBottomMinusHullTop, -0.05, 2e-6), g05.bitBottomMinusHullTop);
  check('status names the overlap and the tips', /^Seated - overlap 0\.05mm \(measured \+0\.050mm.*from skin tips/.test(g05.status), g05.status);

  console.log('\n--- a curved piece is refused ---');
  const idS = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await page.evaluate(id => { state.joinSession = false; state.editId = id; }, idS);  // last: the sphere must not ride along in the plate exports above
  await page.click('#btn-skin-face');
  const refused = await page.evaluate(() => document.getElementById('status').textContent);
  check('sphere: refused with the reason, piece unchanged', /^Skin refused - piece unchanged \((no flat face|face is not a rectangle)/.test(refused), refused);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nfiles: ' + tmp);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
