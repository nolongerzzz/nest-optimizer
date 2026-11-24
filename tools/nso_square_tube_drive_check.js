#!/usr/bin/env node
/* Shape → Tubes with Square tubes on, driven through the real app: real
   index.html, real script tags, real clicks and a real drag. The geometry is
   proved headless in tools/nso_square_tube_test.js; this proves the card on it.
     node tools/nso_square_tube_drive_check.js                    exit 0 = every gate held
     SQ_TUBE_SHOTS=dir node tools/nso_square_tube_drive_check.js  ...and screenshots

     - the toggle is in the Tubes card; ticked, Roll and Keep length go, the
       new square tube's row comes, and the sizes read as sides;
     - Add square tube puts a 20 / wall 1.6 × 60 tube on the plate, selected;
     - Reducer: defaults 16 / 12.8 over 10, the ghost, the readout; Set commits
       ("Square reducer done"), one Undo puts the tube back bit for bit;
     - Neck: a click on the tube centres the band there; Set;
     - Branch: a press on a side and a drag outward pulls a branch - Length and
       Angle follow the pointer, the camera does not move; Set welds it on
       (Euler down by 2), and the card stays up for the next;
     - a round tube with the toggle on is refused, pointed back at Tubes. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, openMenuFor } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.SQ_TUBE_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-sq-tube-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const NSO_Stock = require('../nso_stock.js');
const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris).join(','));
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, value]);
}
const card = page => page.evaluate(() => {
  const B = state.tubeEdge, el = id => document.getElementById(id);
  const vis = id => { const e = el(id); return !!e && !e.hidden && e.offsetParent !== null; };
  return {
    open: !!B.open, readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
    ghost: !!(B.ghost && B.ghost.parent), squares: B.ring ? B.ring.children.length : 0, ok: !!(B.result && B.result.ok),
    newRow: vis('te-sq-new-rows'), keep: vis('chk-te-keep'), roll: !el('opt-te-roll').hidden, odLabel: el('inp-te-od2').parentNode.querySelector('.te-lbl').textContent,
    diaLabel: document.querySelector('label[for="rng-te-br-dia"]').textContent, od2: el('inp-te-od2').value, id2: el('inp-te-id2').value,
    len: el('inp-te-br-len').value, ang: el('inp-te-br-angle').value, controls: state.controls.enabled, go: !el('btn-te-go').disabled
  };
});
async function frame(page, elevDeg, dist) {
  await page.evaluate(([elev, dist]) => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    const e = elev * Math.PI / 180;
    state.controls.target.copy(c);
    state.camera.position.set(c.x + dist * Math.cos(e) * 0.7, c.y + dist * Math.sin(e), c.z + dist * Math.cos(e) * 0.7);
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  }, [elevDeg, dist]);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log('   screenshot ' + path.join(SHOTS, name));
}
// The screen point of a raw point on the selected piece.
const screenOf = (page, raw) => page.evaluate((raw) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh, o = m.centerOffset;
  mesh.updateMatrixWorld(true);
  const w = new THREE.Vector3(raw[0] - o.x, raw[2] - o.y, -raw[1] - o.z).applyMatrix4(mesh.matrixWorld).project(state.camera);
  const rc = state.renderer.domElement.getBoundingClientRect();
  const x = rc.left + (w.x + 1) / 2 * rc.width, y = rc.top + (1 - w.y) / 2 * rc.height;
  return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
}, raw);
// The face of the square tube nearest the camera: its outward normal in raw (±X or ±Y).
const nearFace = page => page.evaluate(() => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh, o = m.centerOffset;
  mesh.updateMatrixWorld(true);
  const cam = state.camera.position.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  const cx = cam.x + o.x, cy = -(cam.z + o.z);
  return Math.abs(cx) >= Math.abs(cy) ? [Math.sign(cx), 0] : [0, Math.sign(cy)];
});
const euler = page => page.evaluate(() => NSO_bendTopology(getActiveModel().rawTris).euler);
const waitIdle = page => page.waitForFunction(() => !state.tubeEdge.busy, null, { timeout: 120000 });

withApp(async (page) => {
  console.log('\n=== 1. the toggle, and a new square tube ===');
  await openMenuFor(page, '#btn-tube-edge');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open, null, { timeout: 30000 });
  let C = await card(page);
  check('the Tubes card is open, round: Roll and Keep length offered, no new-tube row, New Ø', C.open && C.roll && C.keep && !C.newRow && C.odLabel === 'New Ø',
        JSON.stringify({ roll: C.roll, keep: C.keep, row: C.newRow, od: C.odLabel }));
  await page.click('#chk-te-square');
  C = await card(page);
  check('Square tubes ticked: no Roll, no Keep length, the new-tube row, New side / Side', !C.roll && !C.keep && C.newRow && C.odLabel === 'New side' && C.diaLabel === 'Side',
        JSON.stringify({ roll: C.roll, keep: C.keep, row: C.newRow, od: C.odLabel, dia: C.diaLabel }));
  check('with nothing selected the readout says to select one or add one', C.bad && /Add square tube/.test(C.readout), C.readout);
  await page.click('#btn-te-sq-new');
  await page.waitForFunction(() => state.tubeEdge.result && state.tubeEdge.result.ok, null, { timeout: 30000 });
  const name = await page.evaluate(() => getActiveModel().name);
  check('Add square tube puts "square tube 1" on the plate, selected', name === 'square tube 1', name);
  await frame(page, 20, 160);
  C = await card(page);
  console.log('   readout: ' + C.readout);
  check('Reducer defaults on it: 16 / 12.8 over 10, a ghost, the end and target squares', C.od2 === '16.00' && C.id2 === '12.80' && C.ghost && C.squares === 4, C.od2 + ' / ' + C.id2 + ' · ' + C.squares);
  check('the readout: "Square reducer: 20.00 / bore 16.80 → 16.00 / bore 12.80 over 10.0 mm"', !C.bad && /^Square reducer: 20\.00 \/ bore 16\.80 → 16\.00 \/ bore 12\.80 over 10\.0 mm/.test(C.readout), C.readout);
  await shot(page, 'square-1-reducer-ghost.png');

  console.log('\n=== 2. Reducer: Set, Undo ===');
  const tube0 = await soupOf(page);
  await setField(page, 'inp-te-run', '8');
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Square reducer done/.test(document.getElementById('status') ? document.getElementById('status').textContent : '') || state.tubeEdge.result, null, { timeout: 30000 });
  const zTop = await page.evaluate(() => { const s = getActiveModel().rawTris; let lo = Infinity, hi = -Infinity; for (let i = 2; i < s.length; i += 3) { lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); } return hi - lo; });
  check('Set: the tube now stands 60 + 10 + 8 = 78 mm', Math.abs(zTop - 78) < 1e-3, zTop.toFixed(3));
  await page.click('#btn-undo');
  await page.waitForFunction(t => Array.from(getActiveModel().rawTris).join(',') === t, tube0, { timeout: 30000 }).catch(() => {});
  check('one Undo puts the tube back bit for bit', (await soupOf(page)) === tube0);

  console.log('\n=== 3. Neck: a click centres the band ===');
  await page.selectOption('#sel-te-verb', 'neck');
  await page.waitForFunction(() => state.tubeEdge.result, null, { timeout: 30000 });
  const face = await nearFace(page);
  const at = await screenOf(page, [10 * face[0] + 0.0, 10 * face[1], 22]);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => state.tubeEdge.result && state.tubeEdge.result.ok && state.tubeEdge.result.neck, null, { timeout: 30000 });
  const h0 = await page.evaluate(() => state.tubeEdge.result.neck.h0 + state.tubeEdge.result.end.center[2]);
  C = await card(page);
  console.log('   readout: ' + C.readout);
  check('the band is centred where the tube was clicked (z 22, to 0.3 mm)', Math.abs(h0 - 22) < 0.3, h0.toFixed(3));
  check('a ghost and three squares (the band\'s ends and its waist)', C.ghost && C.squares === 3, String(C.squares));
  await shot(page, 'square-2-neck-ghost.png');
  await page.click('#btn-te-go');
  await page.waitForFunction(t => Array.from(getActiveModel().rawTris).join(',') !== t, tube0, { timeout: 30000 });
  check('Set necks it', (await soupOf(page)) !== tube0);
  await page.click('#btn-undo');
  await page.waitForFunction(t => Array.from(getActiveModel().rawTris).join(',') === t, tube0, { timeout: 30000 }).catch(() => {});

  console.log('\n=== 4. Branch: press and drag ===');
  await page.selectOption('#sel-te-verb', 'branch');
  await page.waitForTimeout(200);
  C = await card(page);
  check('before a press the readout says where to press', /Press on a side of the square tube/.test(C.readout), C.readout);
  const e0 = await euler(page);
  const f2 = await nearFace(page);
  const from = await screenOf(page, [10 * f2[0], 10 * f2[1], 25]);
  const to = await screenOf(page, [28 * f2[0], 28 * f2[1], 43]);
  check('the press point is on the canvas', from.onCanvas && to.onCanvas);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  C = await card(page);
  check('mid-drag the camera is held', C.controls === false);
  await page.mouse.up();
  await page.waitForFunction(() => state.tubeEdge.result && state.tubeEdge.result.ok && state.tubeEdge.result.branch, null, { timeout: 30000 });
  C = await card(page);
  console.log('   readout: ' + C.readout);
  check('the drag wrote Length and Angle: about 25 mm out at about 45°', Math.abs(+C.len - 25.5) < 3 && Math.abs(+C.ang - 45) < 6, C.len + ' mm, ' + C.ang + '°');
  check('the ghost is the branch, two squares (root and tip), Set offered', C.ghost && C.squares === 2 && C.go, String(C.squares));
  await shot(page, 'square-3-branch-ghost.png');
  await page.click('#btn-te-go');
  await waitIdle(page);
  const e1 = await euler(page);
  C = await card(page);
  check('Set welds it on: Euler ' + e0 + ' → ' + (e0 - 2) + ' (its bore opens through), the card stays up', e1 === e0 - 2 && C.open, e0 + ' → ' + e1 + ' · ' + C.readout);
  // a second branch off the other side face, at 30°
  const f3 = [-f2[1], f2[0]];
  await setField(page, 'inp-te-br-angle', '30');
  await setField(page, 'inp-te-br-len', '20');
  const p2 = await screenOf(page, [10 * f3[0], 10 * f3[1], 40]);
  if (p2.onCanvas) {
    await page.mouse.click(p2.x, p2.y);
    await page.waitForFunction(() => state.tubeEdge.result && state.tubeEdge.result.branch, null, { timeout: 30000 }).catch(() => {});
    if (await page.evaluate(() => !!(state.tubeEdge.result && state.tubeEdge.result.ok))) {
      await page.click('#btn-te-go');
      await waitIdle(page);
      const e2 = await euler(page);
      check('a second branch on the next face, at 30°: Euler ' + e1 + ' → ' + (e1 - 2), e2 === e1 - 2, String(e2));
    } else check('a second branch on the next face plans', false, (await card(page)).readout);
  }
  await frame(page, 15, 190);
  await page.evaluate(() => { state.tubeEdge.point = null; NSO_teClear(); });
  await shot(page, 'square-4-tree.png');

  console.log('\n=== 5. a round tube with the toggle on ===');
  const tubeId = await loadSTL(page, writeSTL('round.stl', NSO_Stock.revolve(NSO_Stock.profileTube(10, 8.4, 40), 96)));
  await selectModel(page, tubeId);
  await page.waitForFunction(() => state.tubeEdge.read && !state.tubeEdge.read.ok, null, { timeout: 30000 }).catch(() => {});
  C = await card(page);
  check('refused, pointed back at Tubes with Square tubes off', C.bad && /round tube is Tubes with Square tubes off/.test(C.readout), C.readout);

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  if (fails) process.exitCode = 1;
}).catch(e => { console.error(e); process.exit(1); });
