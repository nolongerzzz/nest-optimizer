/* End-to-end evidence for Extract selection, driven through the real app.
   node tools/nso_wire_extract_sel_test.js        exit 0 = every gate held

   Extract selection is Delete painted's non-destructive twin: same pink
   target, same exclude veto, but it COPIES the target's region onto the plate
   and leaves the source alone. Four things this has to prove, on real geometry
   loaded through the app's own file input, targeted through the app's own
   select-paint hit path and extracted by a real click on the real button:

     1. it reads the SELECT list and respects the EXCLUDE veto - the two
        questions in docs/HANDOFF.md, both answered;
     2. the extracted object is a part - closed by the app's own topology
        count, with the volume its wall and its patch area say it should be;
     3. it is the target's region and nothing else - every triangle
        NSO_PaintDelete.select marks is in it, and no unmarked source triangle
        of the source is;
     4. the source piece is untouched - geometry, raw soup, both paint lists,
        size and plate pose all byte-identical across the extraction.       */

const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu, ROOT } =
  require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Puts the loaded model on the plate the way a load does. */
const placeIt = (page, id) => page.evaluate(i => {
  const m = state.models.find(x => x.id === i);
  placeModelMovable(m, 0, 0);
  state.editId = i;
}, id);

/* Fires a real ray at the piece from outside, takes three.js's own
   intersection and hands it to the paint's own toggle - the same object
   hitFace() would have returned for a click. `mode` picks which list:
   'select' is the pink target, 'exclude' the yellow. */
const paintFace = (page, id, dir, mode) => page.evaluate(([i, d, mo]) => {
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
  if (mo === 'exclude') nsoMaskToggleAt(m, placed.mesh, hits[0]);
  else nsoMaskSelectAt(m, placed.mesh, hits[0]);
  const sel = nsoMaskSelected(m);
  return { ok: true, target: sel ? nsoMaskFaceName(sel) : null,
           selCount: nsoMaskSelectCount(m), excluded: nsoMaskCount(m),
           tris: sel ? NSO_PaintDelete.select(m.rawTris, [sel]).count : 0 };
}, [id, dir, mode || 'select']);

/* Everything about a piece that extraction must not move - both paint lists
   included, since the target is deliberately NOT consumed here. */
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

/* "exactly the target's region - no more, no less", on triangles. The source's
   raw soup is rotated into display space and shifted by the centring the
   extracted piece records, so both sets are compared in one space with no
   offset guessed at. */
const exactness = (page, srcId, newId) => page.evaluate(([si, ni]) => {
  const src = state.models.find(x => x.id === si);
  const out = state.models.find(x => x.id === ni);
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
  // raw (zup) -> display, the mapping app-extract-sel.js uses: [x, z, -y]
  const rawTriKey = (r, t) => {
    const o = t * 9, p = [];
    for (let v = 0; v < 3; v++) {
      p.push(r[o+v*3] + off.x, r[o+v*3+2] + off.y, -r[o+v*3+1] + off.z);
    }
    return triKey(p);
  };
  const face = nsoMaskSelected(src);
  const sel = NSO_PaintDelete.select(src.rawTris, [face]);
  const nSrc = src.rawTris.length / 9;
  const inSel = [], notInSel = [];
  for (let t = 0; t < nSrc; t++) (sel.hit[t] ? inSel : notInSel).push(rawTriKey(src.rawTris, t));
  const opos = out.geometry.attributes.position;
  const outKeys = new Set();
  for (let t = 0; t < opos.count / 3; t++) {
    const p = [];
    for (let v = 0; v < 3; v++) {
      const k = t*3+v;
      p.push(opos.getX(k), opos.getY(k), opos.getZ(k));
    }
    outKeys.add(triKey(p));
  }
  let missing = 0;
  inSel.forEach(k => { if (!outKeys.has(k)) missing++; });
  let strays = 0;
  notInSel.forEach(k => { if (outKeys.has(k)) strays++; });
  return { selected: inSel.length, sourceTris: nSrc, extracted: opos.count / 3,
           missing: missing, strays: strays };
}, [srcId, newId]);

withApp(async (page, logs) => {
  console.log('\n=== 1. the button exists, is reachable, and touches nothing protected ===');
  const btn = await page.evaluate(() => {
    const b = document.getElementById('btn-extract-sel');
    return b ? { text: b.textContent.trim(), wired: b.dataset.nsoWired === '1' } : null;
  });
  check('#btn-extract-sel present in the DOM', !!btn, btn ? 'label "' + btn.text + '"' : 'missing');
  check('listener attached at load', !!btn && btn.wired);
  check('Extract bit is untouched and still there', await page.evaluate(
    () => typeof extractBitFromSelected === 'function' &&
          !!document.getElementById('btn-extract-bit')));
  check('it reads Delete\'s selector rather than a second copy', await page.evaluate(
    () => typeof NSO_PaintDelete === 'object' && typeof NSO_PaintDelete.select === 'function'));
  await openFinishMenu(page);

  console.log('\n=== 2. no target, no extraction - and no damage ===');
  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await placeIt(page, id);
  const platedBefore = await page.evaluate(() => state.placed.length);
  await page.click('#btn-extract-sel');
  const st0 = await statusOf(page);
  check('stands down and names the way in', /needs a target face.*Paint Selected/.test(st0), st0);
  check('nothing added to the plate',
        await page.evaluate(n => state.placed.length === n, platedBefore));
  check('nothing added to the model list', await page.evaluate(() => state.models.length === 1));

  console.log('\n=== 3. the EXCLUDE list is still only a veto ===');
  const vy = await paintFace(page, id, [0, -1, 0], 'exclude');   // yellow on the top
  const vp = await paintFace(page, id, [0, -1, 0], 'select');    // pink on the same face
  check('the same face is both excluded and the target',
        vy.ok && vp.ok && vp.selCount === 1 && vp.excluded === 1, JSON.stringify(vp));
  const beforeVeto = await snapshotSource(page, id);
  await page.click('#btn-extract-sel');
  const stV = await statusOf(page);
  console.log('   status: ' + stV);
  check('it stands down on a target that is painted excluded',
        /Extract selection stood down/.test(stV) && /painted excluded/.test(stV), stV);
  check('and says paint wins, as Delete does', /Paint wins/.test(stV));
  check('nothing was put on the plate', await page.evaluate(() => state.models.length === 1));
  const afterVeto = await snapshotSource(page, id);
  check('the piece is untouched by the refusal',
        afterVeto.geoHash === beforeVeto.geoHash && afterVeto.mask === beforeVeto.mask);
  // clear the yellow, keep the pink
  await paintFace(page, id, [0, -1, 0], 'exclude');
  check('exclude cleared, target still set',
        await page.evaluate(i => {
          const m = state.models.find(x => x.id === i);
          return nsoMaskCount(m) === 0 && nsoMaskSelectCount(m) === 1;
        }, id));

  console.log('\n=== 4. real click on the real button ===');
  const before = await snapshotSource(page, id);
  const plated = await page.evaluate(() => state.placed.length);
  await page.click('#btn-extract-sel');
  await page.waitForFunction(() => /Extract selection ok/.test(
    (document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
  const st1 = await statusOf(page);
  console.log('   status: ' + st1);
  check('status reports a completed extraction', /Extract selection ok/.test(st1), st1);
  check('and names the face it took', /the Y\+ face/.test(st1), st1);

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
        await page.evaluate(() => document.querySelectorAll('.model-item').length === 2));

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
  check('volume is patch-area x wall', Math.abs(Math.abs(got.volume) - 400 * wall) < 1e-3,
        Math.abs(got.volume).toFixed(4) + ' vs ' + (400 * wall).toFixed(4));
  check('it is 20 x 20 x wall on the plate',
        Math.abs(got.size.x - 20) < 1e-3 && Math.abs(got.size.z - 20) < 1e-3 &&
        Math.abs(got.size.y - wall) < 1e-3, JSON.stringify(got.size));

  console.log('\n=== 6. exactly the target\'s region - no more, no less ===');
  const ex = await exactness(page, id, newId);
  console.log('   selected ' + ex.selected + ' / source ' + ex.sourceTris +
              ' / extracted ' + ex.extracted + '  missing ' + ex.missing + '  strays ' + ex.strays);
  check('every triangle the selector marks is in the extracted object',
        ex.missing === 0, ex.missing + ' missing');
  check('no unselected source triangle came along', ex.strays === 0, ex.strays + ' stray(s)');
  check('the outer face is the whole region and only it',
        ex.extracted === 2 * ex.selected + 2 * got.from.boundary,
        ex.extracted + ' = 2*' + ex.selected + ' + 2*' + got.from.boundary);

  console.log('\n=== 7. the source piece is genuinely unmodified ===');
  const after = await snapshotSource(page, id);
  check('display geometry byte-identical', after.geoHash === before.geoHash,
        before.geoHash + ' -> ' + after.geoHash);
  check('raw soup byte-identical', after.rawHash === before.rawHash && after.rawLen === before.rawLen,
        before.rawHash + ' -> ' + after.rawHash);
  check('vertex count unchanged', after.verts === before.verts, before.verts + ' -> ' + after.verts);
  check('size unchanged', JSON.stringify(after.size) === JSON.stringify(before.size),
        JSON.stringify(before.size) + ' -> ' + JSON.stringify(after.size));
  check('both paint lists survive, target included', after.mask === before.mask);
  check('it has not moved on the plate', JSON.stringify(after.pose) === JSON.stringify(before.pose),
        JSON.stringify(before.pose) + ' -> ' + JSON.stringify(after.pose));
  check('it is still the selected piece', after.editId === before.editId);
  check('name unchanged', after.name === before.name);
  // Delete consumes the target because the plane it named is gone; this does not
  check('the target is still set, so the same region can be taken twice',
        await page.evaluate(i => nsoMaskSelectCount(state.models.find(x => x.id === i)) === 1, id));

  console.log('\n=== 8. Undo removes only the extracted piece ===');
  await page.evaluate(() => undoLast());
  check('the extracted model is gone', await page.evaluate(() => state.models.length === 1));
  check('the source is still there', await page.evaluate(i => !!state.models.find(m => m.id === i), id));
  const afterUndo = await snapshotSource(page, id);
  check('and still untouched', afterUndo.geoHash === before.geoHash && afterUndo.rawHash === before.rawHash);

  console.log('\n=== 9. a patch that turns a corner still closes ===');
  /* The SELECT list holds one face, so the UI cannot aim this - but the shell
     builder must still close a patch whose triangles do not share a plane,
     which is the case the mitred vertex normal exists for. Fed directly, with
     two faces of the same box, through the app's own module. */
  const corner = await page.evaluate(() => {
    const L = 20, h = L / 2;
    // +Y face and +X face of a 20mm cube, wound outward, as one patch
    const quad = (a, b, c, d) => [].concat(a, b, c, a, c, d);
    const tris = [].concat(
      quad([-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]),          // +Y
      quad([h, h, -h], [h, h, h], [h, -h, h], [h, -h, -h])           // +X
    );
    const wall = 1.2;
    const r = NSO_ExtractSelection.shellFromPatch(Float32Array.from(tris), wall);
    if (!r || !r.soup) return { why: r && r.why };
    const st = NSO_edgeStats(r.soup);
    const s = r.soup;
    let v = 0;
    for (let t = 0; t < s.length / 9; t++) {
      const o = t * 9;
      v += (s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7])
          - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6])
          + s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]));
    }
    return { open: st.open, nm: st.nm, volume: v / 6, tris: r.tris, boundary: r.boundary, wall: wall };
  });
  console.log('   ' + JSON.stringify(corner));
  check('the corner shell is watertight', corner.open === 0, 'open ' + corner.open);
  check('the corner shell is manifold', corner.nm === 0, 'nm ' + corner.nm);
  /* Two 20x20 slabs mitred at a right angle: 2*400*w minus the wedge the
     mitre shares, 20*w*w/2 per side. At w=1.2 that is 960 - 28.8 = 931.2. An
     un-mitred shell would measure 960 and be two slabs fighting over a corner. */
  const want = 2 * 400 * corner.wall - 20 * corner.wall * corner.wall;
  check('the mitre takes exactly the shared wedge out',
        Math.abs(Math.abs(corner.volume) - want) < 1e-3,
        Math.abs(corner.volume).toFixed(3) + ' vs ' + want.toFixed(3));

  console.log('\n=== 10. a real factory part, and a piece too thin for a 1.2mm wall ===');
  for (const [file, dir, thin] of [['box_hull_80x40x20-2.stl', [0, -1, 0], false],
                                   ['lid_strap.stl', [0, -1, 0], true]]) {
    const fid = await loadSTL(page, fx(file));
    await selectModel(page, fid);
    await placeIt(page, fid);
    const p = await paintFace(page, fid, dir, 'select');
    check(file + ': a target painted', p.ok && p.selCount === 1, JSON.stringify(p));
    const b4 = await snapshotSource(page, fid);
    await page.evaluate(() => { document.getElementById('status').textContent = ''; });
    await page.click('#btn-extract-sel');
    await page.waitForFunction(() => /Extract selection ok/.test(
      (document.getElementById('status') || {}).textContent || ''), null, { timeout: 30000 });
    const oid = await page.evaluate(() => state.models[state.models.length - 1].id);
    const g = await measure(page, oid);
    console.log('   ' + file + '  tris ' + g.tris + '  open ' + g.open + '  nm ' + g.nm +
                '  wall ' + g.from.wall.toFixed(3) + '  vol ' + g.volume.toFixed(2));
    check(file + ': watertight and manifold', g.open === 0 && g.nm === 0,
          'open ' + g.open + ', nm ' + g.nm);
    const exf = await exactness(page, fid, oid);
    check(file + ': exactly the region', exf.missing === 0 && exf.strays === 0,
          exf.missing + ' missing, ' + exf.strays + ' stray(s)');
    const af = await snapshotSource(page, fid);
    check(file + ': source unmodified',
          af.geoHash === b4.geoHash && af.rawHash === b4.rawHash && af.mask === b4.mask);
    if (thin) check(file + ': the wall was clamped below 1.2mm',
                    g.from.wall < 1.2 && g.from.wall >= 0.4, g.from.wall.toFixed(3) + 'mm');
  }

  console.log('\n=== 11. the extracted piece exports on its own ===');
  const last = await page.evaluate(() => state.models[state.models.length - 1].id);
  const stl = await page.evaluate(i => {
    state.editId = i;
    const m = getActiveModel();
    const buf = geometryToBinarySTL(m.geometry);
    const dv = new DataView(buf);
    return { id: m.id, bytes: buf.byteLength, header: dv.getUint32(80, true),
             tris: m.geometry.attributes.position.count / 3,
             raw: m.rawTris ? m.rawTris.length / 9 : 0,
             wired: typeof exportSelected === 'function' && typeof exportActiveModel === 'function' };
  }, last);
  console.log('   ' + JSON.stringify(stl));
  check('the extracted piece is selectable on its own', stl.id === last);
  check('the app\'s STL writer writes it', stl.bytes === 84 + stl.tris * 50 && stl.tris > 0,
        stl.bytes + ' bytes for ' + stl.tris + ' tris');
  check('the STL header counts the shell\'s own triangles', stl.header === stl.tris,
        stl.header + ' vs ' + stl.tris);
  check('its raw soup matches, so the raw engines take it too', stl.raw === stl.tris,
        stl.raw + ' vs ' + stl.tris);
  check('the Download selected path is reachable for it', stl.wired);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }

  console.log('\n' + (fails ? fails + ' GATE(S) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('DRIVE FAIL', e); process.exit(1); });
