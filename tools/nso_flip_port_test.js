/* Join -> Flip port, driven through the real app.
     node tools/nso_flip_port_test.js        exit 0 = every gate held

   flipPortOnPunch handed meshToWorldSoup() the PLACED RECORD instead of the
   mesh. A placed record carries a `geometry`, so it got past that function's
   guard, and then died on `placed.updateWorldMatrix is not a function` -
   uncaught, out of the click handler, before NSO_plugFrame ever saw a hull.
   The button did nothing and said nothing.

   What the hull soup is FOR is the other half of this. NSO_plugFrame uses it
   to pick the seat axis by probing inside/outside the hull; with no soup it
   falls back to a centroid vector, which is a different answer on a hull that
   is not convex. So the gates below are not "it stopped throwing" - they are
   that the soup arrives, that it is the thing choosing the axis, that the
   flip is a true 180 about that axis, and that a pose change moved no
   geometry. Every mesh that comes out goes through the canonical checker.  */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-flipport-'));
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

/* the canonical battery, tools/mesh_validate.py - same invocation and same
   definition of "clean" tools/nso_carve_test.js uses */
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

const selectRow = (page, id) => page.click(`.model-item[data-edit-id="${id}"]`);
async function joinAB(page, idA, idB) {
  await page.click('#btn-join-start');
  await page.click('#join-slot-a'); await selectRow(page, idA);
  await page.click('#join-slot-b'); await selectRow(page, idB);
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
}
/* the bit as the app itself would hand it to an exporter: world soup off the
   placed mesh, which is exactly what the flip is supposed to have moved */
const worldSoup = (page, id) => page.evaluate(i => {
  const p = state.placed.find(q => q && q.sourceId === i);
  p.mesh.updateMatrixWorld(true);
  return Array.from(meshToWorldSoup(p.mesh));
}, id);
const quatOf = (page, id) => page.evaluate(i => {
  const p = state.placed.find(q => q && q.sourceId === i);
  return p.mesh.quaternion.toArray().map(v => +v.toFixed(9));
}, id);
const statusText = page => page.evaluate(() => document.getElementById('status').textContent);

withApp(async (page, logs) => {
  console.log('\n=== 1. a real Join session: box_hull_80x40x20-2 as A, pin as B ===');
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('pin.stl'));
  await page.evaluate(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); });
  const sess = await joinAB(page, idA, idB);
  check('join session live with A and B picked',
    sess.session === true && sess.a === idA && sess.b === idB, JSON.stringify(sess));
  check('#btn-flip-port present', await page.evaluate(() => !!document.getElementById('btn-flip-port')));

  console.log('\n=== 2. the hull soup actually reaches NSO_plugFrame ===');
  /* The defect in one measurement: the record does not answer
     meshToWorldSoup, the mesh does. Both read off the SAME placed entry. */
  const reach = await page.evaluate(i => {
    const p = state.placed.find(q => q && q.sourceId === i);
    p.mesh.updateMatrixWorld(true);
    const fromRecord = (() => { try { return meshToWorldSoup(p).length; } catch (e) { return 'threw: ' + e.message; } })();
    const fromMesh = meshToWorldSoup(p.mesh).length;
    return { fromRecord, fromMesh, recordHasGeometry: !!p.geometry, recordIsMesh: !!p.isMesh };
  }, idA);
  console.log('   ' + JSON.stringify(reach));
  check('the placed record still cannot answer it', typeof reach.fromRecord === 'string', String(reach.fromRecord));
  check('the mesh returns a real soup', reach.fromMesh > 0, reach.fromMesh / 9 + ' tris');

  console.log('\n=== 2b. and the soup is what picks the punch axis ===');
  /* Not a formality. NSO_plugFrame scores the six candidate directions by
     probing inside/outside the hull soup, and falls back to a hull-centroid
     vector when it has none. Those are different answers, and the case where
     they differ is the one this button exists for: a tunnel bit sunk INSIDE
     a pocketed hull, where the centroid vector points along the hull's long
     axis and the probe correctly reads the pocket's own up. Seat the bit
     there and measure both. */
  const seatInside = () => page.evaluate(a => {
    const pa = state.placed.find(q => q && q.sourceId === a);
    const pb = state.placed.find(q => q && q.sourceId !== a);
    pa.mesh.updateMatrixWorld(true);
    pb.mesh.quaternion.identity();
    pb.mesh.position.set(pa.mesh.position.x - 10, 2, pa.mesh.position.z);
    pb.mesh.updateMatrixWorld(true);
  }, idA);
  await seatInside();
  const frames = await page.evaluate(a => {
    const pa = state.placed.find(q => q && q.sourceId === a);
    const pb = state.placed.find(q => q && q.sourceId !== a);
    if (!pa.mesh.geometry.boundingBox) pa.mesh.geometry.computeBoundingBox();
    const hc = new THREE.Vector3();
    pa.mesh.geometry.boundingBox.getCenter(hc);
    hc.applyMatrix4(pa.mesh.matrixWorld);
    const withSoup = NSO_plugFrame(pb.mesh, hc, meshToWorldSoup(pa.mesh));
    const without = NSO_plugFrame(pb.mesh, hc, null);
    const nrm = f => f.outerNormal.clone().normalize().toArray().map(v => +v.toFixed(6));
    return { withSoup: { axis: withSoup.axis, sign: withSoup.sign, n: nrm(withSoup) },
             without: { axis: without.axis, sign: without.sign, n: nrm(without) } };
  }, idA);
  console.log('   with soup ' + JSON.stringify(frames.withSoup));
  console.log('   without   ' + JSON.stringify(frames.without));
  check('the two disagree here, so the soup is doing the work',
    frames.withSoup.axis !== frames.without.axis || frames.withSoup.sign !== frames.without.sign,
    JSON.stringify(frames.withSoup) + ' vs ' + JSON.stringify(frames.without));

  console.log('\n=== 3. the real click: Flip port ===');
  const beforeSoup = await worldSoup(page, idB);
  const q0 = await quatOf(page, idB);
  const undo0 = await page.evaluate(() => state.undoStack.length);
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#btn-flip-port');
  const st1 = await statusText(page);
  console.log('   status: ' + JSON.stringify(st1));
  check('the button reports a flip rather than staying silent',
    /Port flipped 180 on punch/.test(st1), st1);
  check('nothing threw out of the handler',
    logs.filter(l => l.startsWith('[pageerror]')).length === 0,
    logs.filter(l => l.startsWith('[pageerror]')).join(' | '));
  check('it pushed exactly one undo step',
    await page.evaluate(() => state.undoStack.length) === undo0 + 1);

  const q1 = await quatOf(page, idB);
  const afterSoup = await worldSoup(page, idB);
  console.log('   bit quaternion ' + JSON.stringify(q0) + ' -> ' + JSON.stringify(q1));
  check('the bit actually moved', JSON.stringify(q0) !== JSON.stringify(q1));

  /* The bit started at identity, so the applied 180 leaves w = 0 and xyz =
     the axis it turned about. Read it back and hold it against the two
     candidate normals: it must be the soup's, not the fallback's. This is
     the gate that would still fail if the soup were quietly arriving empty
     instead of throwing. */
  const axisUsed = [q1[0], q1[1], q1[2]];
  const sameDir = (a, b) => Math.abs(Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2]) - 1) < 1e-4;
  console.log('   turned about ' + JSON.stringify(axisUsed.map(v => +v.toFixed(6))) +
              ', w ' + q1[3].toFixed(6));
  check('a clean 180 (w = 0)', Math.abs(q1[3]) < 1e-6, String(q1[3]));
  check('about the axis the HULL SOUP chose', sameDir(axisUsed, frames.withSoup.n),
    JSON.stringify(axisUsed) + ' vs soup ' + JSON.stringify(frames.withSoup.n));
  check('not the axis the no-soup fallback would have chosen',
    !sameDir(axisUsed, frames.without.n),
    JSON.stringify(axisUsed) + ' vs fallback ' + JSON.stringify(frames.without.n));

  console.log('\n=== 4. it is a true 180 about the punch axis ===');
  await page.click('#btn-flip-port');
  const q2 = await quatOf(page, idB);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  /* q and -q are the same rotation, so accept either sign */
  const back = near(q2, q0) || near(q2, q0.map(v => -v));
  console.log('   after a second flip ' + JSON.stringify(q2));
  check('two flips return the bit to where it started', back, JSON.stringify(q2));
  await page.click('#btn-flip-port'); // leave it flipped once, for section 5

  console.log('\n=== 5. a pose change moves no geometry ===');
  const bitTris = beforeSoup.length / 9;
  check('triangle count unchanged by the flip', afterSoup.length / 9 === bitTris,
    bitTris + ' -> ' + afterSoup.length / 9);
  const spanOf = s => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) {
      if (s[i + k] < mn[k]) mn[k] = s[i + k];
      if (s[i + k] > mx[k]) mx[k] = s[i + k];
    }
    return mx.map((v, k) => +(v - mn[k]).toFixed(4)).sort((a, b) => a - b);
  };
  const s0 = spanOf(beforeSoup), s1 = spanOf(afterSoup);
  console.log('   sorted bbox spans ' + JSON.stringify(s0) + ' -> ' + JSON.stringify(s1));
  check('the piece is the same size, only turned',
    s0.every((v, i) => Math.abs(v - s1[i]) < 1e-3), JSON.stringify(s0) + ' vs ' + JSON.stringify(s1));

  console.log('\n=== 6. canonical checker, tools/mesh_validate.py ===');
  for (const [label, soup] of [['bit before the flip', beforeSoup], ['bit after the flip', afterSoup]]) {
    const f = path.join(tmp, label.replace(/\W+/g, '_') + '.stl');
    writeBinarySTL(f, Float32Array.from(soup));
    const g = gate(f);
    console.log('   ' + label + ': ' + gsum(g));
    check(label + ' gates clean', clean(g), gsum(g));
  }
  const hullSoup = await worldSoup(page, idA);
  const hf = path.join(tmp, 'hull.stl');
  writeBinarySTL(hf, Float32Array.from(hullSoup));
  const hg = gate(hf);
  console.log('   hull A: ' + gsum(hg));
  check('hull A gates clean - Flip port never touches it', clean(hg), gsum(hg));

  console.log('\n=== 7. the refusal path still refuses ===');
  await page.evaluate(() => { state.joinPartnerId = null; document.getElementById('status').textContent = ''; });
  await page.click('#btn-flip-port');
  const st2 = await statusText(page);
  console.log('   status: ' + JSON.stringify(st2));
  check('no B picked is still named, not thrown',
    /Start Join, pick hull A and tunnel B/.test(st2), st2);

  console.log('\n=== 8. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors anywhere in this run', errs.length === 0, errs.join(' | '));
  const missing = await page.evaluate(() => ['btn-join-start','btn-join','btn-subtract','btn-seat-flush',
    'btn-flip-port','btn-cap-open','btn-join-clear'].filter(i => !document.getElementById(i)));
  check('every Join button still present', missing.length === 0, missing.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
