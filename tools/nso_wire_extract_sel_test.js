/* End-to-end evidence for Extract selection, driven through the real app.
   node tools/nso_wire_extract_sel_test.js        exit 0 = every gate held

   Three things this has to prove, and it proves each on real geometry loaded
   through the app's own file input, painted through the app's own hit path
   and extracted by a real click on the real button:

     1. the extracted object is a part - closed by the app's own topology
        count, with the volume its wall and its painted area say it should be;
     2. it is the painted selection and nothing else - every painted triangle
        is in it, and no unpainted triangle of the source is;
     3. the source piece is untouched - geometry, raw soup, paint, size and
        plate pose all byte-identical across the extraction.                */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Puts the loaded model on the plate the way a load does, and hands back the
   plate index so the paint has a mesh to hit. */
const placeIt = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i);
  placeModelMovable(m, 0, 0);
  state.editId = i;
  return state.placed.length - 1;
}, id);

/* Paints one face by firing a real ray at the piece from outside, taking
   three.js's own intersection and handing it to the paint's own toggle - the
   same object hitFace() would have returned for a click. dir is the axis the
   ray travels along, e.g. [0,-1,0] to land on the top face. */
const paintFace = (page, id, dir) => page.evaluate(([i, d]) => {
  const m = state.models.find(x => x.id === i);
  const placed = state.placed.find(p => p && p.sourceId === i && p.mesh);
  placed.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(placed.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  const span = bb.getSize(new THREE.Vector3()).length() + 50;
  const dirV = new THREE.Vector3(d[0], d[1], d[2]).normalize();
  const origin = c.clone().sub(dirV.clone().multiplyScalar(span));
  const hits = new THREE.Raycaster(origin, dirV).intersectObject(placed.mesh, true);
  if (!hits.length) return { ok: false, why: 'no hit' };
  const before = nsoMaskCount(m);
  nsoMaskToggleAt(m, placed.mesh, hits[0]);
  return { ok: nsoMaskCount(m) === before + 1, faces: nsoMaskCount(m),
           tris: nsoMaskPaintedTris(m, placed.mesh).length / 9 };
}, [id, dir]);

/* Everything about a piece that extraction must not move. */
const snapshotSource = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i);
  const placed = state.placed.find(p => p && p.sourceId === i && p.mesh);
  const pos = m.geometry.attributes.position;
  let gh = 0;
  for (let k = 0; k < pos.count; k++) {
    gh = (gh * 31 + Math.round(pos.getX(k) * 1e6)) | 0;
    gh = (gh * 31 + Math.round(pos.getY(k) * 1e6)) | 0;
    gh = (gh * 31 + Math.round(pos.getZ(k) * 1e6)) | 0;
  }
  let rh = 0;
  for (let k = 0; k < m.rawTris.length; k++) rh = (rh * 31 + Math.round(m.rawTris[k] * 1e6)) | 0;
  return {
    name: m.name, geoHash: gh, rawHash: rh, rawLen: m.rawTris.length,
    verts: pos.count, size: [+m.size.x.toFixed(6), +m.size.y.toFixed(6), +m.size.z.toFixed(6)],
    mask: JSON.stringify(nsoMaskSnapshot(m)),
    pose: [+placed.x.toFixed(6), +placed.z.toFixed(6), +placed.mesh.position.y.toFixed(6)],
    editId: state.editId
  };
}, id);

/* The canonical checker, plus the numbers a part has to have. */
const measure = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i);
  const s = m.rawTris;
  const st = NSO_edgeStats(s);
  let v = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    v += (s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7])
        - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6])
        + s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]));
  }
  return { tris: s.length / 9, open: st.open, nm: st.nm, volume: v / 6,
           size: { x: +m.size.x.toFixed(4), y: +m.size.y.toFixed(4), z: +m.size.z.toFixed(4) },
           from: m.fromSelection || null };
}, id);

/* "exactly the painted selection - no more, no less", measured on triangles.
   The extracted piece was centred on the way to the plate, and it carries the
   translation that centring applied, so both sets can be compared in one
   space without guessing at an offset. */
const exactness = (page, srcId, newId) => page.evaluate(([si, ni]) => {
  const src = state.models.find(x => x.id === si);
  const out = state.models.find(x => x.id === ni);
  const placed = state.placed.find(p => p && p.sourceId === si && p.mesh);
  const off = out.fromSelection.offset;
  const Q = 1e4, R = q => Math.round(q * Q);
  // orientation-preserving triangle key: rotate to the smallest corner first,
  // so vertex order does not matter but winding still does
  const triKey = t => {
    const c = [[R(t[0]),R(t[1]),R(t[2])], [R(t[3]),R(t[4]),R(t[5])], [R(t[6]),R(t[7]),R(t[8])]];
    const s = c.map(p => p.join(',')); 
    let b = 0;
    if (s[1] < s[b]) b = 1;
    if (s[2] < s[b]) b = 2;
    return s[b] + '/' + s[(b+1)%3] + '/' + s[(b+2)%3];
  };
  const soupKeys = (buf, dx, dy, dz) => {
    const out2 = [];
    for (let t = 0; t < buf.length / 9; t++) {
      const o = t * 9;
      out2.push(triKey([buf[o]+dx, buf[o+1]+dy, buf[o+2]+dz,
                        buf[o+3]+dx, buf[o+4]+dy, buf[o+5]+dz,
                        buf[o+6]+dx, buf[o+7]+dy, buf[o+8]+dz]));
    }
    return out2;
  };
  // the painted patch, in the display space the shell was built in, moved by
  // the same centring the extracted piece got
  const painted = nsoMaskPaintedTris(src, placed.mesh);
  const paintedKeys = soupKeys(Float32Array.from(painted), off.x, off.y, off.z);
  // every display triangle of the source, same space, same shift
  const spos = placed.mesh.geometry.attributes.position;
  const all = new Float32Array(spos.count * 3);
  for (let k = 0; k < spos.count; k++) {
    all[k*3] = spos.getX(k); all[k*3+1] = spos.getY(k); all[k*3+2] = spos.getZ(k);
  }
  const allKeys = soupKeys(all, off.x, off.y, off.z);
  // and the extracted piece, already centred
  const opos = out.geometry.attributes.position;
  const ob = new Float32Array(opos.count * 3);
  for (let k = 0; k < opos.count; k++) {
    ob[k*3] = opos.getX(k); ob[k*3+1] = opos.getY(k); ob[k*3+2] = opos.getZ(k);
  }
  const outSet = new Set(soupKeys(ob, 0, 0, 0));
  const paintedSet = new Set(paintedKeys);
  let missing = 0;
  paintedKeys.forEach(k => { if (!outSet.has(k)) missing++; });
  let strays = 0;
  allKeys.forEach(k => { if (!paintedSet.has(k) && outSet.has(k)) strays++; });
  return { painted: paintedKeys.length, sourceTris: allKeys.length,
           extracted: ob.length / 9, missing: missing, strays: strays };
}, [srcId, newId]);

withApp(async (page, logs) => {
  console.log('\n=== 1. the button exists and is reachable ===');
  const btn = await page.evaluate(() => {
    const b = document.getElementById('btn-extract-sel');
    return b ? { text: b.textContent.trim(), wired: b.dataset.nsoWired === '1' } : null;
  });
  check('#btn-extract-sel present in the DOM', !!btn, btn ? 'label "' + btn.text + '"' : 'missing');
  check('listener attached at load', !!btn && btn.wired);
  check('it does not touch Extract bit', await page.evaluate(
    () => typeof extractBitFromSelected === 'function' &&
          !!document.getElementById('btn-extract-bit')));

  // the Finish menu is a <details>; a user opens it before reaching the button
  const openMenu = () => page.evaluate(() => {
    const b = document.getElementById('btn-extract-sel');
    for (let n = b; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
  });

  console.log('\n=== 2. no paint, no extraction - and no damage ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await placeIt(page, id);
  await openMenu();
  const platedBefore = await page.evaluate(() => state.placed.length);
  await page.click('#btn-extract-sel');
  const st0 = await statusOf(page);
  check('stands down with a reason', /paint the region first/.test(st0), st0);
  check('nothing added to the plate',
        await page.evaluate(n => state.placed.length === n, platedBefore));
  check('nothing added to the model list', await page.evaluate(() => state.models.length === 1));

  console.log('\n=== 3. paint the top face of a real 20mm box ===');
  const p1 = await paintFace(page, id, [0, -1, 0]);
  check('one face painted through the app hit path', p1.ok, JSON.stringify(p1));
  check('the paint covers triangles', p1.tris >= 2, p1.tris + ' tri(s) yellow');

  const before = await snapshotSource(page, id);
  console.log('   source before: ' + JSON.stringify(before.size) +
              '  verts ' + before.verts + '  geoHash ' + before.geoHash);

  console.log('\n=== 4. real click on the real button ===');
  const plated = await page.evaluate(() => state.placed.length);
  await page.click('#btn-extract-sel');
  await page.waitForFunction(() => /Extract selection/.test(
    (document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  const st1 = await statusOf(page);
  console.log('   status: ' + st1);
  check('status reports a completed extraction', /Extract selection ok/.test(st1), st1);

  const newId = await page.evaluate(() => state.models[state.models.length - 1].id);
  check('a new model exists', await page.evaluate(() => state.models.length === 2));
  check('it is on the plate as its own piece',
        await page.evaluate(([n, i]) => state.placed.length === n + 1 &&
          state.placed[state.placed.length - 1].sourceId === i, [plated, newId]));
  check('it is a separate mesh from the source',
        await page.evaluate(i => {
          const a = state.placed.find(p => p.sourceId !== i);
          const b = state.placed.find(p => p.sourceId === i);
          return !!a && !!b && a.mesh !== b.mesh && a.geometry !== b.geometry;
        }, id));
  check('it is listed in the model list UI',
        await page.evaluate(() => document.querySelectorAll('#model-list .model-item').length === 2 ||
                                  document.querySelectorAll('.model-item').length === 2));

  console.log('\n=== 5. canonical checker on the extracted object ===');
  const got = await measure(page, newId);
  console.log('   extracted  tris ' + got.tris + '  open ' + got.open + '  nm ' + got.nm +
              '  vol ' + got.volume.toFixed(3) + '  bbox ' + JSON.stringify(got.size));
  check('watertight - no open edges', got.open === 0, 'open ' + got.open);
  check('manifold - no over-used edges', got.nm === 0, 'nm ' + got.nm);
  check('it encloses a positive volume', got.volume > 0, got.volume.toFixed(3) + ' mm^3');
  check('it carries its provenance', !!got.from && got.from.sourceId === id,
        JSON.stringify(got.from && { tris: got.from.tris, wall: got.from.wall }));
  // a flat 20x20 patch walled at 1.2mm is a 20x20x1.2 slab, exactly
  const wall = got.from.wall;
  check('wall is the documented 1.2mm on a 20mm box', Math.abs(wall - 1.2) < 1e-9, wall + 'mm');
  check('volume is painted-area x wall', Math.abs(Math.abs(got.volume) - 400 * wall) < 1e-3,
        Math.abs(got.volume).toFixed(4) + ' vs ' + (400 * wall).toFixed(4));
  check('it is 20 x 20 x wall on the plate',
        Math.abs(got.size.x - 20) < 1e-3 && Math.abs(got.size.z - 20) < 1e-3 &&
        Math.abs(got.size.y - wall) < 1e-3, JSON.stringify(got.size));

  console.log('\n=== 6. exactly the painted selection - no more, no less ===');
  const ex = await exactness(page, id, newId);
  console.log('   painted ' + ex.painted + ' / source ' + ex.sourceTris +
              ' / extracted ' + ex.extracted + '  missing ' + ex.missing + '  strays ' + ex.strays);
  check('every painted triangle is in the extracted object', ex.missing === 0, ex.missing + ' missing');
  check('no unpainted source triangle came along', ex.strays === 0, ex.strays + ' stray(s)');
  check('the outer face is the whole selection and only it',
        ex.extracted === 2 * ex.painted + 2 * got.from.boundary,
        ex.extracted + ' = 2*' + ex.painted + ' + 2*' + got.from.boundary);

  console.log('\n=== 7. the source piece is genuinely unmodified ===');
  const after = await snapshotSource(page, id);
  check('display geometry byte-identical', after.geoHash === before.geoHash,
        before.geoHash + ' -> ' + after.geoHash);
  check('raw soup byte-identical', after.rawHash === before.rawHash && after.rawLen === before.rawLen,
        before.rawHash + ' -> ' + after.rawHash);
  check('vertex count unchanged', after.verts === before.verts, before.verts + ' -> ' + after.verts);
  check('size unchanged', JSON.stringify(after.size) === JSON.stringify(before.size),
        JSON.stringify(before.size) + ' -> ' + JSON.stringify(after.size));
  check('the paint is still on it', after.mask === before.mask);
  check('it has not moved on the plate', JSON.stringify(after.pose) === JSON.stringify(before.pose),
        JSON.stringify(before.pose) + ' -> ' + JSON.stringify(after.pose));
  check('it is still the selected piece', after.editId === before.editId);
  check('name unchanged', after.name === before.name);

  console.log('\n=== 8. Undo removes only the extracted piece ===');
  await page.evaluate(() => undoLast());
  check('the extracted model is gone', await page.evaluate(() => state.models.length === 1));
  check('the source is still there', await page.evaluate(i => !!state.models.find(m => m.id === i), id));
  const afterUndo = await snapshotSource(page, id);
  check('and still untouched', afterUndo.geoHash === before.geoHash && afterUndo.rawHash === before.rawHash);

  console.log('\n=== 9. two faces that meet at a corner still close ===');
  const id2 = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id2);
  await placeIt(page, id2);
  const a = await paintFace(page, id2, [0, -1, 0]);   // top
  const b = await paintFace(page, id2, [-1, 0, 0]);   // +X side
  check('two faces painted', a.ok && b.ok && b.faces === 2, JSON.stringify(b));
  const before2 = await snapshotSource(page, id2);
  await page.click('#btn-extract-sel');
  await page.waitForFunction(() => /Extract selection ok/.test(
    (document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  const id2out = await page.evaluate(() => state.models[state.models.length - 1].id);
  const got2 = await measure(page, id2out);
  console.log('   status: ' + await statusOf(page));
  console.log('   extracted  tris ' + got2.tris + '  open ' + got2.open + '  nm ' + got2.nm +
              '  vol ' + got2.volume.toFixed(3) + '  bbox ' + JSON.stringify(got2.size));
  check('the two-face shell is watertight', got2.open === 0, 'open ' + got2.open);
  check('the two-face shell is manifold', got2.nm === 0, 'nm ' + got2.nm);
  check('it is one L, not two loose slabs', Math.abs(got2.volume) > 400 * got2.from.wall,
        Math.abs(got2.volume).toFixed(2) + ' mm^3');
  const ex2 = await exactness(page, id2, id2out);
  check('still exactly the selection', ex2.missing === 0 && ex2.strays === 0,
        ex2.missing + ' missing, ' + ex2.strays + ' stray(s)');
  const after2 = await snapshotSource(page, id2);
  check('the two-face source is unmodified too',
        after2.geoHash === before2.geoHash && after2.rawHash === before2.rawHash &&
        after2.mask === before2.mask);

  console.log('\n=== 10. the extracted piece exports on its own ===');
  /* Selecting it and running the app's own STL writer over it - the same call
     "Download selected" makes - so "ready to export" is measured, not assumed.
     The header's triangle count has to be the shell's own. */
  const stl = await page.evaluate(i => {
    state.editId = i;
    const m = getActiveModel();
    const buf = geometryToBinarySTL(m.geometry);
    const dv = new DataView(buf);
    return { id: m.id, bytes: buf.byteLength, header: dv.getUint32(80, true),
             tris: m.geometry.attributes.position.count / 3,
             raw: m.rawTris ? m.rawTris.length / 9 : 0,
             wired: typeof exportSelected === 'function' && typeof exportActiveModel === 'function' };
  }, id2out);
  console.log('   ' + JSON.stringify(stl));
  check('the extracted piece is selectable on its own', stl.id === id2out);
  check('the app\'s STL writer writes it', stl.bytes === 84 + stl.tris * 50 && stl.tris > 0,
        stl.bytes + ' bytes for ' + stl.tris + ' tris');
  check('the STL header counts the shell\'s own triangles', stl.header === stl.tris,
        stl.header + ' vs ' + stl.tris);
  check('its raw soup matches, so the raw engines take it too', stl.raw === stl.tris,
        stl.raw + ' vs ' + stl.tris);
  check('the Download selected path is reachable for it', stl.wired);

  console.log('\n=== 11. a real factory part, three faces meeting at one corner ===');
  const id3 = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectModel(page, id3);
  await placeIt(page, id3);
  const c1 = await paintFace(page, id3, [0, -1, 0]);
  const c2 = await paintFace(page, id3, [-1, 0, 0]);
  const c3 = await paintFace(page, id3, [0, 0, -1]);
  check('three faces painted on the hull', c1.ok && c2.ok && c3.ok && c3.faces === 3,
        JSON.stringify(c3));
  const before3 = await snapshotSource(page, id3);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-extract-sel');
  await page.waitForFunction(() => /Extract selection ok/.test(
    (document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  const id3out = await page.evaluate(() => state.models[state.models.length - 1].id);
  const got3 = await measure(page, id3out);
  console.log('   status: ' + await statusOf(page));
  console.log('   extracted  tris ' + got3.tris + '  open ' + got3.open + '  nm ' + got3.nm +
              '  vol ' + got3.volume.toFixed(3) + '  bbox ' + JSON.stringify(got3.size));
  check('three-face corner shell is watertight', got3.open === 0, 'open ' + got3.open);
  check('three-face corner shell is manifold', got3.nm === 0, 'nm ' + got3.nm);
  check('it encloses a positive volume', got3.volume > 0, got3.volume.toFixed(2) + ' mm^3');
  const ex3 = await exactness(page, id3, id3out);
  check('still exactly the selection', ex3.missing === 0 && ex3.strays === 0,
        ex3.missing + ' missing, ' + ex3.strays + ' stray(s)');
  const after3 = await snapshotSource(page, id3);
  check('the hull is unmodified', after3.geoHash === before3.geoHash &&
        after3.rawHash === before3.rawHash && after3.mask === before3.mask &&
        JSON.stringify(after3.size) === JSON.stringify(before3.size));

  console.log('\n=== 12. a piece too thin for a 1.2mm wall gets a thinner one ===');
  const id4 = await loadSTL(page, fx('lid_strap.stl'));
  await selectModel(page, id4);
  await placeIt(page, id4);
  const th = await paintFace(page, id4, [0, -1, 0]);
  check('a face painted on the strap', th.ok, JSON.stringify(th));
  const before4 = await snapshotSource(page, id4);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-extract-sel');
  await page.waitForFunction(() => /Extract selection ok/.test(
    (document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  const id4out = await page.evaluate(() => state.models[state.models.length - 1].id);
  const got4 = await measure(page, id4out);
  console.log('   status: ' + await statusOf(page));
  console.log('   extracted  tris ' + got4.tris + '  open ' + got4.open + '  nm ' + got4.nm +
              '  wall ' + got4.from.wall.toFixed(3) + '  bbox ' + JSON.stringify(got4.size));
  check('the wall was clamped below 1.2mm', got4.from.wall < 1.2 && got4.from.wall >= 0.4,
        got4.from.wall.toFixed(3) + 'mm');
  check('and the thin shell is still watertight', got4.open === 0 && got4.nm === 0,
        'open ' + got4.open + ', nm ' + got4.nm);
  const after4 = await snapshotSource(page, id4);
  check('the strap is unmodified', after4.geoHash === before4.geoHash &&
        after4.rawHash === before4.rawHash);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }

  console.log('\n' + (fails ? fails + ' GATE(S) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });
