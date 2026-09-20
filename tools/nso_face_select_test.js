/* Face SELECT (the target) next to face EXCLUDE (the paint), proven in Node
   and through the real controls.
     node tools/nso_face_select_test.js        exit 0 = every gate held

   Part 1 - nso_skin.js alone (no browser)
     A 30x30x10 block with a 20x20 pocket 5 deep from the top. findFace by
     direction picks the RIM (the outermost +Z plane, as it always has);
     findFace with the plane offset a select entry records picks the FLOOR;
     a plane nothing sits on is null. Skinning the floor by plane gives one
     closed shell, 0 piercing, the relief 0.6 tall inside the pocket (the
     bbox does not grow), the rim untouched, volume = block + relief.

   Part 2 - the real app (headless Chromium, tools/nso_app_harness.js), every
   step a click on the shipped UI:
     a. box_hull_80x40x20-2 as A, box-20mm as B, Start Join, Pick A / Pick B,
        B moved BESIDE A on +X. Skin face with no target -> the auto-pick
        skins the +X face (the one that looks at B): A grows in X, not in Y.
        Undo (button).
     b. Finish tab -> Paint Selected -> a click on A's TOP face in the
        viewport: one select entry (raw +Z, inner false), exclude list still
        empty, pink overlay on the mesh, status and HUD name it. Skin face ->
        the +Z face gets the relief: A grows in Y and NOT in X, status says
        "target: selected target", the selection is consumed. Export plate ->
        the downloaded STL: hull shell 20.6 tall in z, 80 wide in x, two
        shells. Undo (button) -> geometry AND selection back.
     c. one target at a time: a click on the +X side replaces the top (still
        exactly one entry), a click on the same face again clears it, a click
        on the top selects it again.
     d. paint wins: Paint Excluded, click the same top face -> both lists
        carry it; Skin face stands down naming the face; piece unchanged.
     e. Clear paint -> both lists empty, status says so; Skin face with no
        target falls back to the auto-pick (+X, faces B). Undo.
     f. Stop painting: the mode ends, both buttons idle.
     g. a pocket piece (the part-1 block, written to disk and loaded through
        the file input): Paint Selected, click the pocket FLOOR -> an inner
        entry (raw +Z at 5); Skin face skins the floor, not the rim: height
        stays 10, status says "inner +Z face".
     h. Cap open faces, now in the Finish tab, still answers on a closed
        piece ("No open face to cap"). No page errors. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const NSO_Skin = require('../nso_skin.js');
const { writeSTL } = require('./nso_stl_io.js');
const { withApp, loadSTL, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-select-'));

function meshValidate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', euler ' + v.euler_characteristic +
  ', vol ' + v.signed_volume.toFixed(3) + ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
  ', bbox ' + JSON.stringify(v.bbox_size);

/* ---- the pocket block: 30 x 30 x 10, pocket 20 x 20, floor at z = 5 ---- */
function pocketBlock() {
  const out = [];
  const tri = (a, b, c, want) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { const t = b; b = c; c = t; }
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  const quad = (a, b, c, d, want) => { tri(a, b, c, want); tri(a, c, d, want); };
  const O = 15, I = 10, H = 10, F = 5;
  // bottom (-Z)
  quad([-O, -O, 0], [O, -O, 0], [O, O, 0], [-O, O, 0], [0, 0, -1]);
  // outer walls
  quad([O, -O, 0], [O, O, 0], [O, O, H], [O, -O, H], [1, 0, 0]);
  quad([-O, -O, 0], [-O, O, 0], [-O, O, H], [-O, -O, H], [-1, 0, 0]);
  quad([-O, O, 0], [O, O, 0], [O, O, H], [-O, O, H], [0, 1, 0]);
  quad([-O, -O, 0], [O, -O, 0], [O, -O, H], [-O, -O, H], [0, -1, 0]);
  // rim (+Z at H), four trapezoids between the outer and inner squares
  quad([-O, -O, H], [O, -O, H], [I, -I, H], [-I, -I, H], [0, 0, 1]);
  quad([O, -O, H], [O, O, H], [I, I, H], [I, -I, H], [0, 0, 1]);
  quad([O, O, H], [-O, O, H], [-I, I, H], [I, I, H], [0, 0, 1]);
  quad([-O, O, H], [-O, -O, H], [-I, -I, H], [-I, I, H], [0, 0, 1]);
  // pocket walls, normals into the pocket
  quad([I, -I, F], [I, I, F], [I, I, H], [I, -I, H], [-1, 0, 0]);
  quad([-I, -I, F], [-I, I, F], [-I, I, H], [-I, -I, H], [1, 0, 0]);
  quad([-I, I, F], [I, I, F], [I, I, H], [-I, I, H], [0, -1, 0]);
  quad([-I, -I, F], [I, -I, F], [I, -I, H], [-I, -I, H], [0, 1, 0]);
  // floor (+Z at F)
  quad([-I, -I, F], [I, -I, F], [I, I, F], [-I, I, F], [0, 0, 1]);
  return new Float32Array(out);
}

/* ======================= Part 1: the module ======================= */
console.log('=== 1. nso_skin.js: findFace by direction vs by plane, on a pocket block ===');
const block = pocketBlock();
const blockFile = path.join(tmp, 'pocket_block.stl');
writeSTL(blockFile, block, 'pocket block');
const vBlock = meshValidate(blockFile);
console.log('    block: ' + summary(vBlock));
check('the block itself is one closed shell, 0 piercing (28 tris)', vBlock.open_edges === 0 && vBlock.nonmanifold_edges === 0 && vBlock.euler_characteristic === 2 && vBlock.self_intersection.pierce === 0 && vBlock.triangles === 28);
check('block volume 30x30x10 - 20x20x5 = 7000', near(vBlock.signed_volume, 7000, 1e-3), vBlock.signed_volume);
{
  const byDir = NSO_Skin.findFace(block, [0, 0, 1]);
  check('findFace(+Z) alone picks the RIM at z = 10 (outermost, as before)', byDir && near(byDir.d, 10, 1e-9) && byDir.tris.length === 8, byDir && (byDir.d + ' / ' + byDir.tris.length + ' tris'));
  const byPlane = NSO_Skin.findFace(block, [0, 0, 1], 5);
  check('findFace(+Z, plane 5) picks the FLOOR at z = 5 (2 tris)', byPlane && near(byPlane.d, 5, 1e-9) && byPlane.tris.length === 2, byPlane && (byPlane.d + ' / ' + byPlane.tris.length + ' tris'));
  check('findFace(+Z, plane 7) - nothing there - is null', NSO_Skin.findFace(block, [0, 0, 1], 7) === null);
  check('findFace(+Z, plane 10) is the rim again (the plane form covers the outer face too)', (NSO_Skin.findFace(block, [0, 0, 1], 10) || {}).d === 10);
  const rim = NSO_Skin.applySkinToFace(block, { dir: [0, 0, 1], pattern: 'crosshatch' });
  check('skin by direction alone refuses: the rim is not a rectangle, soup returned untouched', !rim.ok && rim.tris === block, rim.reason);
  const r = NSO_Skin.applySkinToFace(block, { dir: [0, 0, 1], plane: 5, pattern: 'crosshatch' });
  check('skin by plane 5 applies to the floor', r.ok, r.reason);
  if (r.ok) {
    const f = path.join(tmp, 'pocket_floor_crosshatch.stl');
    writeSTL(f, r.tris, 'pocket floor crosshatch');
    const v = meshValidate(f);
    console.log('    floor skinned: ' + summary(v) + ', tip area ' + r.tipArea.toFixed(2));
    check('one closed shell (0 open, 0 non-manifold, Euler 2), 0 piercing, 0 coplanar', v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2 && v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0);
    check('the relief is INSIDE the pocket: bbox still 30 x 30 x 10', near(v.bbox_size[2], 10, 1e-6) && near(v.bbox_size[0], 30, 1e-6), JSON.stringify(v.bbox_size));
    check('base plane 5, tips plane 5.6 - the floor, not the rim', near(r.basePlane, 5, 1e-9) && near(r.tipsPlane, 5.6, 1e-9), r.basePlane + ' -> ' + r.tipsPlane);
    check('volume = block + tip area x 0.6 (1e-3)', near(v.signed_volume, 7000 + r.tipArea * 0.6, 1e-3), v.signed_volume.toFixed(4) + ' vs ' + (7000 + r.tipArea * 0.6).toFixed(4));
    check('the 4 pocket walls were re-fanned, not the outer ones', r.wallTrisFanned === 4, r.wallTrisFanned);
    const rimAfter = NSO_Skin.findFace(r.tris, [0, 0, 1], 10);
    check('the rim is still there, same area (500 mm^2)', rimAfter && near(rimAfter.area, 500, 1e-6), rimAfter && rimAfter.area);
  }
  const wrongPlane = NSO_Skin.applySkinToFace(block, { dir: [0, 0, 1], plane: 7, pattern: 'crosshatch' });
  check('skin by a plane nothing sits on refuses and names the plane', !wrongPlane.ok && /selected plane/.test(wrongPlane.reason), wrongPlane.reason);
}

/* ======================= Part 2: the real app ======================= */
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);
const hudOf = page => page.evaluate(() => document.getElementById('adjust-status').textContent);
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });

/* what the piece carries: geometry extents, both paint lists, the overlays */
const pieceState = id => {
  const m = state.models.find(x => x.id === id);
  const p = state.placed.find(x => x && x.sourceId === id && x.mesh);
  const raw = m.rawTris;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.length; i += 3) for (let k = 0; k < 3; k++) { if (raw[i + k] < lo[k]) lo[k] = raw[i + k]; if (raw[i + k] > hi[k]) hi[k] = raw[i + k]; }
  const overlays = state.modelGroup.children.filter(o => o.isMesh && o.material && o.material.color && o.userData.placedIndex == null && !o.userData.sourceId && o.material.polygonOffset);
  const col = o => o.material.color.getHex();
  const sel = nsoMaskSelected(m);
  return {
    tris: raw.length / 9, rawSize: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], rawHi: hi, size: { x: m.size.x, y: m.size.y, z: m.size.z },
    exclude: (m.faceMask && m.faceMask.exclude) ? m.faceMask.exclude.map(e => ({ axisIdx: e.axisIdx, keepMin: e.keepMin, inner: e.inner, d: e.d })) : [],
    selected: sel ? { axisIdx: sel.axisIdx, keepMin: sel.keepMin, inner: sel.inner, d: sel.d, n: sel.n, dispAxis: sel.dispAxis, dispSign: sel.dispSign } : null,
    selectCount: nsoMaskSelectCount(m), excludeCount: nsoMaskCount(m),
    pink: overlays.filter(o => col(o) === 0xf472b6).map(o => o.geometry.attributes.position.count / 3),
    yellow: overlays.filter(o => col(o) === 0xffdd00).map(o => o.geometry.attributes.position.count / 3),
    mode: state.maskPaint, joinA: state.editId, joinB: state.joinPartnerId, session: state.joinSession,
    x: p ? p.x : null, z: p ? p.z : null,
    status: document.getElementById('status').textContent, hud: document.getElementById('adjust-status').textContent,
    labels: { sel: document.getElementById('btn-mask-select').textContent, exc: document.getElementById('btn-mask-paint').textContent,
              selArmed: document.getElementById('btn-mask-select').classList.contains('is-armed'), excArmed: document.getElementById('btn-mask-paint').classList.contains('is-armed') }
  };
};

/* Screen point (client coords) at the centre of one face of a placed piece,
   plus what the app's own ray finds there - so a click can be asserted to
   land on the face it was aimed at before it is made. axis 0/1/2 = display
   x/y/z, sign +1/-1. `inset` is a world-space offset from the face centre
   along the face's own normal (0) and a fraction toward the camera-facing
   corner is not needed: the centre is always inside a rectangle. */
const facePoint = ([id, axis, sign, off]) => {
  const p = state.placed.find(x => x && x.sourceId === id && x.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  const w = c.clone();
  w.setComponent(axis, sign > 0 ? bb.max.getComponent(axis) : bb.min.getComponent(axis));
  if (off) { w.x += off[0]; w.y += off[1]; w.z += off[2]; }
  const ndc = w.clone().project(state.camera);
  const rect = state.renderer.domElement.getBoundingClientRect();
  const x = rect.left + (ndc.x + 1) / 2 * rect.width, y = rect.top + (1 - ndc.y) / 2 * rect.height;
  state.pointer.x = ndc.x; state.pointer.y = ndc.y;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(h => h.faceIndex != null);
  let hitId = null, hitN = null;
  if (hits.length) {
    let o = hits[0].object;
    while (o && o.userData.placedIndex == null && o.parent) o = o.parent;
    hitId = o && o.userData ? state.placed[o.userData.placedIndex].sourceId : null;
    const n = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
    hitN = [n.x, n.y, n.z].map(v => Math.round(v * 1000) / 1000);
  }
  // what is on top at that client point (a menu body would eat the click)
  const el = document.elementFromPoint(x, y);
  return { x, y, hitId, hitN, onCanvas: el === state.renderer.domElement };
};

async function clickFace(page, id, axis, sign, off) {
  const fp = await page.evaluate(facePoint, [id, axis, sign, off || null]);
  const want = [0, 0, 0]; want[axis] = sign;
  const aimed = fp.hitId === id && fp.hitN && fp.hitN.every((v, i) => near(v, want[i], 1e-3)) && fp.onCanvas;
  check('  aim: the click point lands on that piece\'s ' + 'XYZ'[axis] + (sign > 0 ? '+' : '-') + ' face, on the canvas', aimed, JSON.stringify(fp));
  await page.mouse.click(fp.x, fp.y);
  return fp;
}

async function exportPlateSTL(page, label) {
  // export-format moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl')
  ]);
  // folded back: this check clicks the canvas, and an open panel
  // hangs over the top of the viewport where some of those land.
  await page.evaluate(() => document.querySelectorAll('.viewport-overlay-topbar details').forEach(d => { d.open = false; }));
  const file = path.join(tmp, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  return file;
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
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of list) for (const v of t) for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
    return { tris: list.length, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  }).sort((a, b) => b.tris - a.tris);
}

withApp(async (page, logs) => {
  console.log('\n=== 2a. A + B, Join, B beside A on +X: Skin with NO target auto-picks the face that looks at B ===');
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  await page.click('#btn-join-start');
  await page.click('#join-slot-a');
  await page.click(`.model-item[data-edit-id="${idA}"]`);
  await page.click('#join-slot-b');
  await page.click(`.model-item[data-edit-id="${idB}"]`);
  // B beside A on +X (the app's move primitive - a viewport drag calls this; there is no button for it)
  await page.evaluate(([a, b]) => {
    const iB = state.placed.findIndex(p => p && p.sourceId === b);
    const pA = state.placed.find(p => p && p.sourceId === a), pB = state.placed[iB];
    selectPlaced(iB);
    nudgeSelected(pA.x + 70 - pB.x, pA.z - pB.z);
  }, [idA, idB]);
  await page.click(`.model-item[data-edit-id="${idA}"]`);   // A active again
  let a = await page.evaluate(pieceState, idA);
  check('Join holds A / B, A active, nothing painted', a.session && a.joinA === idA && a.joinB === idB && a.excludeCount === 0 && a.selectCount === 0, JSON.stringify({ s: a.session, A: a.joinA, B: a.joinB }));
  check('A is 80 x 40 x 20 raw (x, y, z), 28 tris', a.tris === 28 && near(a.rawSize[0], 80, 1e-6) && near(a.rawSize[1], 40, 1e-6) && near(a.rawSize[2], 20, 1e-6), JSON.stringify(a.rawSize));
  await openFinishMenu(page);
  await page.selectOption('#skin-pattern', 'crosshatch');
  await clearStatus(page);
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  a = await page.evaluate(pieceState, idA);
  console.log('    status: ' + a.status);
  check('auto-pick: status names the +X face and says the target came from the auto-pick toward B', /^Skinned \+X face - crosshatch/.test(a.status) && /target: auto-pick: faces B$/.test(a.status), a.status);
  check('auto-pick: A grew 0.6 in raw X (80.6), not in Z (20)', near(a.rawSize[0], 80.6, 1e-4) && near(a.rawSize[2], 20, 1e-4), JSON.stringify(a.rawSize));
  await page.click('#btn-undo');
  a = await page.evaluate(pieceState, idA);
  check('Undo: A back to 28 tris, 80 x 40 x 20', a.tris === 28 && near(a.rawSize[0], 80, 1e-6) && near(a.rawSize[2], 20, 1e-6) && /Undo: Skin reverted/.test(a.status), a.status);

  console.log('\n=== 2b. Paint Selected -> click A\'s TOP face -> Skin face uses THAT face, not the auto-pick ===');
  await page.click('#btn-mask-select');
  a = await page.evaluate(pieceState, idA);
  check('select mode live: state.maskPaint = "select", button reads Stop selecting and is armed, Paint Excluded idle', a.mode === 'select' && a.labels.sel === 'Stop selecting' && a.labels.selArmed && a.labels.exc === 'Paint Excluded' && !a.labels.excArmed, JSON.stringify(a.labels));
  check('status explains the mode', /^Paint Selected - click a face to make it the target/.test(a.status), a.status);
  await clickFace(page, idA, 1, 1);   // display Y+ = the top = raw +Z
  a = await page.evaluate(pieceState, idA);
  console.log('    status: ' + a.status);
  check('one select entry: raw +Z (axisIdx 2, max side), an outer face', a.selectCount === 1 && a.selected && a.selected.axisIdx === 2 && a.selected.keepMin === false && a.selected.inner === false, JSON.stringify(a.selected));
  check('  its raw plane is n = (0,0,1), d = the raw soup\'s top z (the fixture is centred, so 10)', a.selected && a.selected.n[2] === 1 && near(a.selected.d, a.rawHi[2], 1e-3) && near(a.rawHi[2], 10, 1e-6), a.selected && (a.selected.d + ' vs ' + a.rawHi[2]));
  check('  exclude list untouched (0) - a different flag on a different question', a.excludeCount === 0 && a.exclude.length === 0);
  check('  pink overlay on the mesh covers the face (2 tris), no yellow', a.pink.length === 1 && a.pink[0] === 2 && a.yellow.length === 0, JSON.stringify({ pink: a.pink, yellow: a.yellow }));
  check('  status: Selected the Y+ face as the target, Skin will use it', /^Selected the Y\+ face as the target \(2 tris pink\) - Skin face will use it$/.test(a.status), a.status);
  check('  HUD carries the target', /target Y\+ face$/.test(a.hud), a.hud);
  await clearStatus(page);
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  a = await page.evaluate(pieceState, idA);
  console.log('    status: ' + a.status);
  check('SELECTED face skinned: status names +Z and "target: selected target"', /^Skinned \+Z face - crosshatch lattice.*tips \+0\.60mm/.test(a.status) && /target: selected target$/.test(a.status), a.status);
  check('  the relief is on the TOP: raw Z 20 -> 20.6, raw X stays 80 (the auto-pick face is untouched)', near(a.rawSize[2], 20.6, 1e-4) && near(a.rawSize[0], 80, 1e-4) && a.tris > 1000, JSON.stringify(a.rawSize) + ', ' + a.tris + ' tris');
  check('  scene height 20.6', near(a.size.y, 20.6, 1e-4), a.size.y);
  check('  selection consumed: no target, no pink', a.selectCount === 0 && a.selected === null && a.pink.length === 0, JSON.stringify({ n: a.selectCount, pink: a.pink }));
  check('  still in select mode (Skin does not end the session), Join intact', a.mode === 'select' && a.session && a.joinA === idA);
  const file = await exportPlateSTL(page, 'selected_top');
  const v = meshValidate(file);
  const shells = edgeShells(parseSTL(fs.readFileSync(file)));
  console.log('    export: ' + summary(v));
  check('download: 0 open, 0 non-manifold, two shells (A skinned + B)', v.open_edges === 0 && v.nonmanifold_edges === 0 && shells.length === 2, shells.length);
  check('download: the hull shell is 80 x 40 x 20.6 in the file - the skin is on the top', shells.length === 2 && near(shells[0].size[0], 80, 1e-5) && near(shells[0].size[1], 40, 1e-5) && near(shells[0].size[2], 20.6, 1e-5), shells.length === 2 ? JSON.stringify(shells[0].size) : '');
  await page.click('#btn-undo');
  a = await page.evaluate(pieceState, idA);
  check('Undo (button): geometry back (28 tris, 20 tall) AND the target back (+Z, pink again)', a.tris === 28 && near(a.rawSize[2], 20, 1e-6) && a.selectCount === 1 && a.selected.axisIdx === 2 && !a.selected.keepMin && a.pink.length === 1, JSON.stringify({ tris: a.tris, sel: a.selected, pink: a.pink, status: a.status }));

  console.log('\n=== 2c. one target at a time ===');
  await clickFace(page, idA, 0, 1);   // the +X side (display X+ = raw +X)
  a = await page.evaluate(pieceState, idA);
  console.log('    status: ' + a.status);
  check('click on the +X side: still exactly ONE entry, now raw +X (axisIdx 0, max side)', a.selectCount === 1 && a.selected.axisIdx === 0 && a.selected.keepMin === false, JSON.stringify(a.selected));
  check('  status says it replaces the Y+ face', /^Selected the X\+ face as the target .* - replaces the Y\+ face - Skin face will use it$/.test(a.status), a.status);
  await clickFace(page, idA, 0, 1);   // same face again
  a = await page.evaluate(pieceState, idA);
  check('click on the same face again: deselected, no target, no pink', a.selectCount === 0 && a.pink.length === 0 && /^Deselected the X\+ face - no target face$/.test(a.status), a.status);
  await clickFace(page, idA, 1, 1);
  a = await page.evaluate(pieceState, idA);
  check('click on the top: selected again (+Z)', a.selectCount === 1 && a.selected.axisIdx === 2 && !a.selected.keepMin && a.pink.length === 1);
  await page.click('#btn-undo');
  a = await page.evaluate(pieceState, idA);
  check('Undo of a select is one step: back to no target, status names it', a.selectCount === 0 && /^Undo: paint reverted - 0 face\(s\) excluded, target none$/.test(a.status), a.status);
  await page.click('#btn-undo');
  a = await page.evaluate(pieceState, idA);
  check('Undo again: the X+ target is back', a.selectCount === 1 && a.selected.axisIdx === 0 && /target X\+ face$/.test(a.status), a.status);
  await clickFace(page, idA, 1, 1);   // top selected, replacing X+
  a = await page.evaluate(pieceState, idA);
  check('top selected for the next step', a.selectCount === 1 && a.selected.axisIdx === 2);

  console.log('\n=== 2d. paint wins: the same face excluded AND selected stands Skin down ===');
  await page.click('#btn-mask-paint');
  a = await page.evaluate(pieceState, idA);
  check('Paint Excluded switches the mode: "exclude", its button armed, Paint Selected idle', a.mode === 'exclude' && a.labels.excArmed && a.labels.exc === 'Stop painting' && !a.labels.selArmed && a.labels.sel === 'Paint Selected', JSON.stringify(a.labels));
  await clickFace(page, idA, 1, 1);
  a = await page.evaluate(pieceState, idA);
  console.log('    status: ' + a.status);
  check('the top is now on BOTH lists: 1 excluded, 1 selected, yellow and pink both drawn', a.excludeCount === 1 && a.exclude[0].axisIdx === 2 && a.selectCount === 1 && a.selected.axisIdx === 2 && a.yellow.length === 1 && a.pink.length === 1, JSON.stringify({ ex: a.exclude, sel: a.selected, y: a.yellow, p: a.pink }));
  check('  status: Excluded the Y+ face', /^Excluded the Y\+ face \(2 tris yellow\) - 1 face\(s\) excluded$/.test(a.status), a.status);
  check('  HUD: 1 face excluded, target Y+', /1 face excluded, target Y\+ face$/.test(a.hud), a.hud);
  await clearStatus(page);
  await page.click('#btn-skin-face');
  a = await page.evaluate(pieceState, idA);
  console.log('    status: ' + a.status);
  check('Skin stood down, naming the painted +Z face; piece unchanged (28 tris); target kept', /^Skin stood down - \+Z face is painted; clear paint on it to skin it$/.test(a.status) && a.tris === 28 && a.selectCount === 1, a.status);

  console.log('\n=== 2e. Clear paint drops both; Skin with no target falls back to the auto-pick ===');
  await page.click('#btn-mask-clear');
  a = await page.evaluate(pieceState, idA);
  check('both lists empty, no overlays, status says so', a.excludeCount === 0 && a.selectCount === 0 && a.yellow.length === 0 && a.pink.length === 0 && /^Paint cleared - 0 faces excluded, no target face$/.test(a.status), a.status);
  await clearStatus(page);
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  a = await page.evaluate(pieceState, idA);
  check('no target -> auto-pick again: +X (faces B), X grows to 80.6', /^Skinned \+X face/.test(a.status) && /target: auto-pick: faces B$/.test(a.status) && near(a.rawSize[0], 80.6, 1e-4), a.status);
  await page.click('#btn-undo');
  a = await page.evaluate(pieceState, idA);
  check('Undo: 28 tris again', a.tris === 28);

  console.log('\n=== 2f. Stop painting ends the mode ===');
  await page.click('#btn-mask-paint');
  a = await page.evaluate(pieceState, idA);
  check('mode off, both buttons idle and unarmed', a.mode === false && a.labels.exc === 'Paint Excluded' && a.labels.sel === 'Paint Selected' && !a.labels.excArmed && !a.labels.selArmed, JSON.stringify(a.labels));
  check('status: Paint off - 0 face(s) excluded, target none', /^Paint off - 0 face\(s\) excluded, target none$/.test(a.status), a.status);
  check('HUD back to the bare tag', /^HUD \S+$/.test(a.hud), a.hud);

  console.log('\n=== 2g. an INNER face: the pocket floor as the target ===');
  await page.click('#btn-join-clear');
  const idP = await loadSTL(page, blockFile);
  await page.click(`.model-item[data-edit-id="${idP}"]`);
  // the block arrives beside the others; bring it to the front-centre so the floor is in clear view
  await page.evaluate(id => {
    const i = state.placed.findIndex(p => p && p.sourceId === id);
    selectPlaced(i);
    nudgeSelected(-state.placed[i].x, 40 - state.placed[i].z);
  }, idP);
  let pk = await page.evaluate(pieceState, idP);
  check('pocket block loaded: 28 tris, 30 x 30 x 10, no paint', pk.tris === 28 && near(pk.rawSize[2], 10, 1e-6) && pk.selectCount === 0, JSON.stringify(pk.rawSize));
  await page.click('#btn-mask-select');
  // the floor: display Y+ face at y = 5 above the block's base (the block rests on the plate)
  const floorPt = await page.evaluate(id => {
    const p = state.placed.find(x => x && x.sourceId === id && x.mesh);
    p.mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(p.mesh);
    const c = bb.getCenter(new THREE.Vector3());
    const w = new THREE.Vector3(c.x, bb.min.y + 5, c.z);
    const ndc = w.clone().project(state.camera);
    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ndc.x; state.pointer.y = ndc.y;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(h => h.faceIndex != null);
    const n = hits.length ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : null;
    const local = hits.length ? hits[0].object.worldToLocal(hits[0].point.clone()) : null;
    return { x: rect.left + (ndc.x + 1) / 2 * rect.width, y: rect.top + (1 - ndc.y) / 2 * rect.height,
             hitN: n ? [n.x, n.y, n.z].map(v => Math.round(v * 1000) / 1000) : null, localY: local ? local.y : null, bbLocalTop: 5 };
  }, idP);
  check('  aim: the ray lands on an upward face 5 below the rim (the floor)', floorPt.hitN && near(floorPt.hitN[1], 1, 1e-3) && near(floorPt.localY, 0, 1e-3), JSON.stringify(floorPt));
  await page.mouse.click(floorPt.x, floorPt.y);
  pk = await page.evaluate(pieceState, idP);
  console.log('    status: ' + pk.status);
  check('the floor is the target: raw +Z, INNER, plane d = 5', pk.selectCount === 1 && pk.selected.axisIdx === 2 && !pk.selected.keepMin && pk.selected.inner === true && near(pk.selected.d, 5, 1e-3), JSON.stringify(pk.selected));
  check('  status names the inner face at its plane', /^Selected the inner Y\+ face at 0\.00 as the target \(2 tris pink\)/.test(pk.status), pk.status);
  check('  the pink is on the floor only (2 tris), not the 8-tri rim', pk.pink.length === 1 && pk.pink[0] === 2, JSON.stringify(pk.pink));
  await clearStatus(page);
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  pk = await page.evaluate(pieceState, idP);
  console.log('    status: ' + pk.status);
  check('Skin took the FLOOR: status says inner +Z face, selected target', /^Skinned inner \+Z face - crosshatch/.test(pk.status) && /target: selected target$/.test(pk.status), pk.status);
  check('  height stays 10 (relief inside the pocket), thousands of tris', near(pk.rawSize[2], 10, 1e-4) && pk.tris > 500, JSON.stringify(pk.rawSize) + ', ' + pk.tris);
  await page.click('#btn-undo');
  pk = await page.evaluate(pieceState, idP);
  check('Undo: block back, floor target back', pk.tris === 28 && pk.selectCount === 1 && pk.selected.inner === true);
  await page.click('#btn-mask-clear');
  await page.click('#btn-mask-select');   // stop selecting
  pk = await page.evaluate(pieceState, idP);
  check('cleared and stopped', pk.selectCount === 0 && pk.mode === false);
  await clearStatus(page);
  await page.click('#btn-skin-face');
  await waitStatus(page, /^Skinned|^Skin /);
  pk = await page.evaluate(pieceState, idP);
  check('no target on the pocket block: the auto-pick finds the rim and refuses it (not a rectangle), piece unchanged', /^Skin refused - piece unchanged/.test(pk.status) && pk.tris === 28, pk.status);

  console.log('\n=== 2h. Cap open faces in its new home ===');
  await page.click(`.model-item[data-edit-id="${idA}"]`);
  await clearStatus(page);
  await page.click('#btn-cap-open');
  const cap = await statusOf(page);
  check('Cap open faces (Finish tab) answers on the closed hull: No open face to cap', /^No open face to cap$/.test(cap), cap);

  await page.screenshot({ path: path.join(tmp, 'finish-menu.png') });
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.join(' | '));
  console.log('\nfiles: ' + tmp);
  console.log(fails ? '\nFAIL ' + fails : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
