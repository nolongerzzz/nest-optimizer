/* A bake must not move the piece: NSO_sculptCommitRaw and the pose record.
     node tools/nso_pose_after_bake_test.js        exit 0 = every gate held

   NSO_sculptCommitRaw is the house commit half - Smooth, Skin, Skin wrap,
   Scale, Extend, Brush, Carve, Texture, Paint delete and Seat (surface) all
   land through it. It replaces the geometry and then builds a FRESH placed
   mesh. That mesh was built at identity: position set from the piece's own
   bbox and no rotation at all.

   The pose is not on the geometry, it is on the placed record - rotY, tipX /
   tiltX, flipX, tipZ / tiltZ, liftY - and a bake does not change it. So after
   a bake on a posed piece the viewport drew the piece unrotated while every
   exporter went on reading the record, and neither said anything. The gate is
   that a bake is a no-op for pose: the record, the drawn mesh and the exported
   geometry must all read exactly the same before it and after it.

   What is NOT gated here, because it is not this change's doing: a COMPOSITE
   pose (two or more of rotY / tipX / tipZ at once) already disagrees between
   viewport and exporter with no bake anywhere near it. applyMeshRotation()
   sets a THREE Euler in XYZ order while buildCombinedGeometry() calls
   rotateX, then rotateY, then rotateZ, which composes in the reverse order.
   Measured in section 5 and printed on every run; it wants its own pass.  */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-posebake-'));
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function writeBinarySTL(file, soup) {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50, s = i * 9;
    const ax = soup[s], ay = soup[s + 1], az = soup[s + 2];
    const ux = soup[s + 3] - ax, uy = soup[s + 4] - ay, uz = soup[s + 5] - az;
    const vx = soup[s + 6] - ax, vy = soup[s + 7] - ay, vz = soup[s + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / L, o); buf.writeFloatLE(ny / L, o + 4); buf.writeFloatLE(nz / L, o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[s + k], o + 12 + k * 4);
  }
  fs.writeFileSync(file, buf);
}
function gate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--gate', '--json'].concat(extra || []);
  let out, code = 0;
  try { out = execFileSync('python3', args, { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; code = e.status == null ? 1 : e.status; }
  let j = null;
  try { j = JSON.parse(out); } catch (e) { /* leave null */ }
  return { code, j };
}
const clean = g => !!(g.j && g.code === 0 && g.j.verdict === 'PASS' &&
  g.j.open_edges === 0 && g.j.nonmanifold_edges === 0 && g.j.odd_edges === 0 &&
  g.j.inconsistent_winding_edges === 0 && g.j.degenerate_tris === 0 &&
  g.j.self_intersection && g.j.self_intersection.pierce === 0);
const gsum = g => g.j ? ('tris ' + g.j.triangles + ', open ' + g.j.open_edges + ', nm ' + g.j.nonmanifold_edges +
  ', odd ' + g.j.odd_edges + ', wind ' + g.j.inconsistent_winding_edges + ', deg ' + g.j.degenerate_tris +
  ', pierce ' + (g.j.self_intersection ? g.j.self_intersection.pierce : '?') + ', ' + g.j.verdict) : 'checker gave no JSON';

/* Everything the pose is: what the record says, where the mesh is actually
   drawn, and what the plate exporter would write. Read in one page call so
   the three cannot drift between reads. */
const poseOf = (page, id) => page.evaluate(i => {
  const span = a => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < a.length; k += 3) for (let j = 0; j < 3; j++) {
      if (a[k + j] < mn[j]) mn[j] = a[k + j];
      if (a[k + j] > mx[j]) mx[j] = a[k + j];
    }
    return { min: mn.map(v => +v.toFixed(4)), size: mx.map((v, j) => +(v - mn[j]).toFixed(4)) };
  };
  const p = state.placed.find(q => q && q.sourceId === i);
  p.mesh.updateMatrixWorld(true);
  return {
    record: { rotY: +(p.rotY || 0).toFixed(6), tipX: p.tipX || 0, tiltX: p.tiltX || 0,
              flipX: !!p.flipX, tipZ: p.tipZ || 0, tiltZ: p.tiltZ || 0, liftY: +(p.liftY || 0).toFixed(4),
              width: +p.width.toFixed(4), depth: +p.depth.toFixed(4), height: +p.height.toFixed(4) },
    mesh: { rot: [p.mesh.rotation.x, p.mesh.rotation.y, p.mesh.rotation.z].map(v => +v.toFixed(6)),
            pos: [p.mesh.position.x, p.mesh.position.y, p.mesh.position.z].map(v => +v.toFixed(4)) },
    drawn: span(Array.from(meshToWorldSoup(p.mesh))),
    exported: span(Array.from(buildCombinedGeometry().attributes.position.array))
  };
}, id);

const setPose = (page, id, pose) => page.evaluate(a => {
  const p = state.placed.find(q => q && q.sourceId === a.id);
  p.rotY = a.pose.rotY || 0; p.tipX = a.pose.tipX || 0; p.tipZ = a.pose.tipZ || 0;
  p.tiltX = a.pose.tiltX || 0; p.tiltZ = a.pose.tiltZ || 0;
  p.flipX = !!a.pose.flipX; p.liftY = a.pose.liftY || 0;
  applyMeshRotation(p);
}, { id, pose });

const openFinish = page => page.evaluate(async () => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
    /* `.vp-menu` is an EXCLUSIVE accordion: the toggle handler in app-join.js
       closes every other menu when one opens, and `toggle` fires
       ASYNCHRONOUSLY - so the blanket open above is partly undone a task
       later, and re-opening a menu that is still `open` at this instant is a
       no-op that the queued handlers then override. Let them settle, then set
       the accordion explicitly to the menu whose buttons this suite clicks.
       This was invisible while Finish was the only .vp-menu on the page. */
    await new Promise(r => setTimeout(r, 0));
    document.querySelectorAll('.vp-menu').forEach(m => {
      m.open = m.classList.contains('vp-finish-menu');
    });
    await new Promise(r => setTimeout(r, 0));
  });
const plateSoup = page => page.evaluate(() =>
  Array.from(buildCombinedGeometry().attributes.position.array));
/* the exporter's own Z-up view of where the piece sits on the bed */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

withApp(async (page, logs) => {
  console.log('\n=== 1. the commit half really is shared ===');
  const shared = await page.evaluate(() => ({
    commit: typeof NSO_sculptCommitRaw,
    applyMeshRotation: typeof applyMeshRotation,
    smooth: typeof NSO_smoothSelectedModel,
    skin: typeof NSO_skinFaceOfModel
  }));
  console.log('   ' + JSON.stringify(shared));
  check('NSO_sculptCommitRaw is the shipped commit half', shared.commit === 'function');
  check('applyMeshRotation is reachable from it', shared.applyMeshRotation === 'function');

  console.log('\n=== 2. Skin face, through the real button, on a piece posed first ===');
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectModel(page, idA);
  await openFinish(page);
  /* One axis only. A composite pose is section 5's business and gating it
     here would be gating somebody else's bug. */
  await setPose(page, idA, { rotY: Math.PI / 2, liftY: 6 });
  const beforeA = await poseOf(page, idA);
  console.log('   posed:  record ' + JSON.stringify(beforeA.record));
  console.log('           mesh   ' + JSON.stringify(beforeA.mesh));
  console.log('           drawn  ' + JSON.stringify(beforeA.drawn));
  check('the pose is on the mesh before the bake',
    Math.abs(beforeA.mesh.rot[1] - Math.PI / 2) < 1e-6, JSON.stringify(beforeA.mesh.rot));

  await page.selectOption('#skin-pattern', 'crosshatch');
  await page.click('#btn-skin-face');
  await page.waitForFunction(() => /^Skinned|^Skin /.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const stA = await statusOf(page);
  console.log('   status: ' + stA);
  check('the skin really baked', /^Skinned/.test(stA), stA);
  const afterA = await poseOf(page, idA);
  console.log('   baked:  record ' + JSON.stringify(afterA.record));
  console.log('           mesh   ' + JSON.stringify(afterA.mesh));
  console.log('           drawn  ' + JSON.stringify(afterA.drawn));
  check('the mesh still carries the pose', same(beforeA.mesh.rot, afterA.mesh.rot),
    JSON.stringify(beforeA.mesh.rot) + ' -> ' + JSON.stringify(afterA.mesh.rot));
  check('the record still carries the pose',
    afterA.record.rotY === beforeA.record.rotY && afterA.record.liftY === beforeA.record.liftY,
    JSON.stringify(afterA.record));
  check('drawn and record agree on the footprint after the bake',
    Math.abs(afterA.drawn.size[0] - afterA.record.width) < 1e-3 &&
    Math.abs(afterA.drawn.size[2] - afterA.record.depth) < 1e-3,
    'drawn ' + JSON.stringify(afterA.drawn.size) + ' vs record w/d/h ' +
    [afterA.record.width, afterA.record.depth, afterA.record.height].join('/'));
  /* the skin adds relief, so only the two spans it does not touch are equal */
  check('the bake only grew the piece along the face it skinned',
    Math.abs(afterA.drawn.size[0] - beforeA.drawn.size[0]) < 1e-3 &&
    Math.abs(afterA.drawn.size[2] - beforeA.drawn.size[2]) < 1e-3,
    JSON.stringify(beforeA.drawn.size) + ' -> ' + JSON.stringify(afterA.drawn.size));
  check('viewport and exporter agree on the posed, baked piece',
    same([afterA.drawn.size[0], afterA.drawn.size[2], afterA.drawn.size[1]], afterA.exported.size),
    'drawn ' + JSON.stringify(afterA.drawn.size) + ' -> exporter ' + JSON.stringify(afterA.exported.size));

  console.log('\n=== 3. Smooth, through the real button, on a posed curved piece ===');
  const idB = await loadSTL(page, fx('fixture_sphere_curved.stl'));
  await selectModel(page, idB);
  await setPose(page, idB, { tipX: 1, liftY: 3 });
  const beforeB = await poseOf(page, idB);
  console.log('   posed:  mesh ' + JSON.stringify(beforeB.mesh) + ' record h ' + beforeB.record.height);
  await page.click('#btn-smooth');
  await page.waitForFunction(() => /Smooth/.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const stB = await statusOf(page);
  console.log('   status: ' + stB);
  check('the smooth really baked', /Smooth done/.test(stB), stB);
  const afterB = await poseOf(page, idB);
  console.log('   baked:  mesh ' + JSON.stringify(afterB.mesh) + ' record h ' + afterB.record.height);
  check('the tip survived the bake', same(beforeB.mesh.rot, afterB.mesh.rot),
    JSON.stringify(beforeB.mesh.rot) + ' -> ' + JSON.stringify(afterB.mesh.rot));
  check('the lift survived the bake', afterB.record.liftY === beforeB.record.liftY,
    beforeB.record.liftY + ' -> ' + afterB.record.liftY);
  check('the recorded height is the POSED height, re-measured after the bake',
    Math.abs(afterB.record.height - afterB.drawn.size[1]) < 1e-3,
    'record ' + afterB.record.height + ' vs drawn Y ' + afterB.drawn.size[1]);

  console.log('\n=== 4. a bake is a no-op for pose, one axis at a time ===');
  /* The bake is the identity commit - the same soup back in - so anything
     that moves is the rebuild moving it, and nothing else. */
  const idC = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  await selectModel(page, idC);
  const POSES = [
    /* as placed - nothing has moved it, so no applyMeshRotation has run on
       it either. See the convention note in section 5 for why that matters. */
    { name: 'as placed',      pose: null },
    { name: 'rotY 90',        pose: { rotY: Math.PI / 2 } },
    { name: 'tipX 90',        pose: { tipX: 1 } },
    { name: 'tipZ 90',        pose: { tipZ: 1 } },
    { name: 'flipX',          pose: { flipX: true } },
    { name: 'tiltX 15',       pose: { tiltX: 15 } },
    { name: 'lift 12',        pose: { liftY: 12 } }
  ];
  for (const p of POSES) {
    if (p.pose) await setPose(page, idC, p.pose);
    const b = await poseOf(page, idC);
    await page.evaluate(i => {
      const m = state.models.find(x => x.id === i);
      NSO_sculptCommitRaw(m, m.rawTris.slice(), 'poseProbeReplace', null);
    }, idC);
    const a = await poseOf(page, idC);
    check(p.name + ': record unchanged', same(b.record, a.record),
      JSON.stringify(b.record) + ' -> ' + JSON.stringify(a.record));
    check(p.name + ': drawn mesh unchanged', same(b.mesh, a.mesh) && same(b.drawn, a.drawn),
      JSON.stringify(b.mesh) + '/' + JSON.stringify(b.drawn) + ' -> ' +
      JSON.stringify(a.mesh) + '/' + JSON.stringify(a.drawn));
    check(p.name + ': exported geometry unchanged', same(b.exported, a.exported),
      JSON.stringify(b.exported) + ' -> ' + JSON.stringify(a.exported));
  }

  console.log('\n=== 5a. recorded, NOT gated: two resting-height conventions ===');
  /* The app sets a piece down at height/2 + 0.3 when it PLACES or rebuilds it
     (placeModelMovable, the undo restores, NSO_sculptCommitRaw) and at
     height/2 + 0.2 when anything MOVES it (packModels, applyMeshRotation, so
     every adjust button). 0.1 mm apart, and both already in app-core.js
     before this change - the greps are app-core.js:1231 and :2988.

     It shows as a 0.1 mm hop when a piece that an adjust button has touched
     and then returned to zero - Raise then Lower - is baked: the bake rebuilds
     on the +0.3 convention. This fix deliberately does not pick a winner. It
     puts a RECORDED pose back through applyMeshRotation, which is the +0.2
     convention and self-consistent; a piece with no pose keeps the exact
     placement it has always had. Unifying the two is its own pass. */
  const hop = await page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i);
    p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.flipX = false; p.liftY = 0;
    applyMeshRotation(p);                       // what Raise-then-Lower leaves behind
    const moved = +p.mesh.position.y.toFixed(4);
    const m = state.models.find(x => x.id === i);
    NSO_sculptCommitRaw(m, m.rawTris.slice(), 'conventionProbe', null);
    const q = state.placed.find(z => z && z.sourceId === i);
    return { afterMove: moved, afterBake: +q.mesh.position.y.toFixed(4) };
  }, idC);
  console.log('   zero pose via an adjust button: y ' + hop.afterMove +
    ', then a bake: y ' + hop.afterBake +
    '  (delta ' + (hop.afterBake - hop.afterMove).toFixed(4) + ' mm, open finding, app-core.js)');

  console.log('\n=== 5b. recorded, NOT gated: composite poses and the exporter ===');
  /* Pre-existing and independent of any bake: applyMeshRotation() builds a
     THREE Euler in XYZ order, buildCombinedGeometry() calls rotateX ->
     rotateY -> rotateZ, which composes in the reverse order. One axis agrees;
     two or three need not. Measured before any bake runs, which is what makes
     it someone else's bug and not this one's. */
  const COMPOSITE = [
    { name: 'rotY 90 + tipX 90', pose: { rotY: Math.PI / 2, tipX: 1 } },
    { name: 'rotY 90 + tipZ 90', pose: { rotY: Math.PI / 2, tipZ: 1 } },
    { name: 'tipX 90 + tipZ 90', pose: { tipX: 1, tipZ: 1 } }
  ];
  let composite = 0;
  for (const c of COMPOSITE) {
    await setPose(page, idC, c.pose);
    const s = await poseOf(page, idC);
    const want = [s.drawn.size[0], s.drawn.size[2], s.drawn.size[1]];
    const agree = want.every((v, k) => Math.abs(v - s.exported.size[k]) < 1e-3);
    if (!agree) composite++;
    console.log('   ' + (agree ? 'agree  ' : 'DIFFER ') + c.name.padEnd(20) +
      ' drawn ' + JSON.stringify(s.drawn.size) + ' -> expect ' + JSON.stringify(want) +
      ', exporter gave ' + JSON.stringify(s.exported.size));
  }
  console.log('   ' + composite + ' of ' + COMPOSITE.length +
    ' composite poses disagree, with no bake involved (open finding, app-core.js)');

  console.log('\n=== 6. canonical checker, tools/mesh_validate.py ===');
  await setPose(page, idC, { rotY: Math.PI / 2, liftY: 6 });
  const plate = await plateSoup(page);
  const pf = path.join(tmp, 'plate.stl');
  writeBinarySTL(pf, Float32Array.from(plate));
  const pg = gate(pf, ['--non-solid']);   // three pieces in one file, not one solid
  console.log('   whole plate: ' + gsum(pg));
  check('the exported plate has no bad triangles',
    !!(pg.j && pg.j.degenerate_tris === 0 && pg.j.inconsistent_winding_edges === 0), gsum(pg));
  for (const [label, id] of [['skinned A', idA], ['smoothed B', idB], ['probe C', idC]]) {
    const soup = await page.evaluate(i => {
      const p = state.placed.find(q => q && q.sourceId === i);
      p.mesh.updateMatrixWorld(true);
      return Array.from(meshToWorldSoup(p.mesh));
    }, id);
    const f = path.join(tmp, label.replace(/\W+/g, '_') + '.stl');
    writeBinarySTL(f, Float32Array.from(soup));
    const g = gate(f);
    console.log('   ' + label + ' as drawn: ' + gsum(g));
    check(label + ' gates clean as drawn', clean(g), gsum(g));
  }

  console.log('\n=== 7. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const missing = await page.evaluate(() => ['btn-smooth','btn-skin-face','btn-skin-wrap','btn-texture',
    'btn-scale-dim','btn-carve','btn-rot-left','btn-tip','btn-raise'].filter(i => !document.getElementById(i)));
  check('every bake and pose button still present', missing.length === 0, missing.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
