#!/usr/bin/env node
/* Tube edge, driven through the real app: real index.html, real script tags,
   real clicks, real Undo.
     node tools/nso_tube_edge_drive_check.js            exit 0 = every gate held
     TUBE_EDGE_SHOTS=dir node tools/nso_tube_edge_drive_check.js   also screenshots

   The geometry is proven headless in tools/nso_tube_edge_test.js. What this
   file proves is the card: the button sits beside Bend in Finish -> Shape,
   the ghost on the piece is the very soup Set commits, the ring marks the end
   being treated, a click on the piece picks the end nearest it, the Reducer's
   fields make the reducer they say (its angles derived, in the readout), a
   refusal is said in words and takes the ghost away,
   Set bakes, one Undo restores the piece bit for bit, Cancel leaves it
   alone, and paint stands it down. Fixtures are generated here and written
   to a temp directory. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.TUBE_EDGE_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-tube-edge-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
// Stock's tube, built by the shipped revolve (the same file the page loads).
const NSO_Stock = require('../nso_stock.js');
const stockTube = (rOut, wall, h) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), 96);

const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris).join(','));
const cardState = page => page.evaluate(() => {
  const B = state.tubeEdge || {}, el = id => document.getElementById(id);
  return {
    open: !!B.open, hidden: el('te-panel').hidden,
    verb: el('sel-te-verb').value, dir: el('sel-te-dir').value, dirShown: !el('te-dir-row').hidden, wallsShown: !el('te-walls-row').hidden,
    od2: el('inp-te-od2').value, id2: el('inp-te-id2').value, trans: el('inp-te-trans').value, run: el('inp-te-run').value,
    profile: el('sel-te-profile').value, radius: el('inp-te-radius').value, rollAngle: el('inp-te-roll-angle').value,
    reducerShown: !el('te-reducer-rows').hidden, rollShown: !el('te-roll-rows').hidden,
    readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
    goDisabled: el('btn-te-go').disabled,
    ghost: !!(B.ghost && B.ghost.parent), ring: !!(B.ring && B.ring.parent),
    ghostTris: B.ghost ? B.ghost.geometry.attributes.position.count / 3 : 0,
    resultTris: B.result && B.result.ok ? B.result.tris.length / 9 : 0,
    ghostMat: B.ghost ? { color: B.ghost.material.color.getHex(), opacity: B.ghost.material.opacity } : null,
    ringCenter: B.ring ? B.ring.userData.center : null,
    ringDepth: B.ring ? B.ring.children.every(o => o.material.depthTest === false) : null,
    endAxis: B.read && B.read.ok ? B.read.end.axis : null
  };
});
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}
// Frame the piece from above and to one side, so its end is in view.
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

withApp(async (page, logs) => {
  console.log('\n=== 1. the button, beside Bend in the Bend menu (shell v2; was Finish -> Shape) ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-tube-edge'), bend = document.getElementById('btn-bend');
    const menu = b && b.closest('.vp-shell-menu');
    const row = b && b.closest('.vp-row');
    return { btn: !!b, wired: b && b.dataset.nsoWired === '1', menu: menu && menu.id,
             sameRow: !!row && row === bend.closest('.vp-row'), bendFirst: !!row && row.firstElementChild === bend,
             panelWithIt: !!(menu && menu.contains(document.getElementById('te-panel'))),
             panelHidden: document.getElementById('te-panel').hidden };
  });
  check('#btn-tube-edge is in the Shape card (shell v3; Bend\'s card moved there whole), with its card', ui.btn && ui.menu === 'menu-shape' && ui.panelWithIt, JSON.stringify(ui));
  check('...in Bend\'s own row, beside it; Bend still first', ui.sameRow && ui.bendFirst);
  check('...wired at load, its card shut', ui.wired && ui.panelHidden);

  console.log('\n=== 2. open on a Stock tube Ø20 wall 1.6: defaults, ghost, ring ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', stockTube(10, 1.6, 40)));
  await selectModel(page, tubeId);
  await openFinishMenu(page);
  const before = await soupOf(page);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  let P = await cardState(page);
  console.log('   readout: ' + P.readout);
  check('the card opens on Reducer: its rows up, Way (a Roll\'s) and Walls (Neck\'s) hidden', P.open && !P.hidden && P.verb === 'reducer' && P.reducerShown && !P.rollShown && !P.dirShown && !P.wallsShown);
  check('defaults: New Ø = the tube\'s Ø + 4, New bore = its bore + 4 (a wall-held 2 mm flare), Transition 10, Run 0',
        P.od2 === '24.00' && P.id2 === '20.80' && P.trans === '10' && P.run === '0', P.od2 + ' / ' + P.id2 + ' / ' + P.trans + ' / ' + P.run);
  check('the top end is picked, facing up', P.endAxis && P.endAxis[2] === 1);
  check('the readout states it, the angles derived: "Expander: Ø20.00 / bore Ø16.80 → Ø24.00 / bore Ø20.80 over 10.0 mm (11.3° outside, 11.3° bore) · wall 1.60 → 1.60"',
        P.readout.indexOf('Expander: Ø20.00 / bore Ø16.80 → Ø24.00 / bore Ø20.80 over 10.0 mm (11.3° outside, 11.3° bore) · wall 1.60 → 1.60') === 0 && !P.bad, P.readout);
  check('the ghost is on the piece, the soup Set would commit', P.ghost && P.ghostTris === P.resultTris && P.ghostTris > 768, P.ghostTris + ' triangles');
  check('...drawn as Bend\'s ghost is (amber, 0.75)', P.ghostMat && P.ghostMat.color === 0xf59e0b && P.ghostMat.opacity === 0.75);
  check('the ring marks the end, read through the piece', P.ring && P.ringDepth);
  check('opening the card changes nothing', (await soupOf(page)) === before);

  console.log('\n=== 3. the fields make the reducer they say ===');
  await setField(page, 'inp-te-od2', '14');
  await setField(page, 'inp-te-id2', '10.8');
  await setField(page, 'inp-te-trans', '8');
  P = await cardState(page);
  check('New Ø 14 / bore 10.8 over 8: a reducer, its angles derived (atan 3/8 = 20.6° on both faces)',
    P.readout.indexOf('Reducer: Ø20.00 / bore Ø16.80 → Ø14.00 / bore Ø10.80 over 8.0 mm (20.6° outside, 20.6° bore) · wall 1.60 → 1.60') === 0 && P.ghost && !P.bad, P.readout);
  await setField(page, 'inp-te-id2', '12.8');
  P = await cardState(page);
  check('...the bore set apart from the outside: the wall says so (1.60 → 0.60), the bore\'s angle its own (atan 2/8 = 14.0°)',
    P.readout.indexOf('Reducer: Ø20.00 / bore Ø16.80 → Ø14.00 / bore Ø12.80 over 8.0 mm (20.6° outside, 14.0° bore) · wall 1.60 → 0.60') === 0 && P.ghost, P.readout);
  await setField(page, 'inp-te-run', '5');
  P = await cardState(page);
  check('a Run: ", then 5.0 mm run"', /over 8\.0 mm \(20\.6° outside, 14\.0° bore\), then 5\.0 mm run · wall 1\.60 → 0\.60/.test(P.readout), P.readout);
  await setField(page, 'inp-te-id2', '10.8');
  await setField(page, 'inp-te-run', '0');

  console.log('\n=== 4. a click on the piece picks the end nearest it ===');
  await frame(page, 20, 90);
  const pt = await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    // raw (10, 0, 2): on the outside wall 2 mm above the bottom end
    const o = m.centerOffset, local = new THREE.Vector3(10 - o.x, 2 - o.y, -0 - o.z);
    const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera);
    const r = state.renderer.domElement.getBoundingClientRect();
    const x = r.left + (w.x + 1) / 2 * r.width, y = r.top + (1 - w.y) / 2 * r.height;
    return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
  });
  check('the point is on the canvas', pt.onCanvas, JSON.stringify(pt));
  const placedBefore = await page.evaluate(() => { const p = state.placed.find(q => q.sourceId === getActiveModel().id); return [p.x, p.z]; });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => state.tubeEdge.read && state.tubeEdge.read.ok && state.tubeEdge.read.end.axis[2] === -1, null, { timeout: 10000 });
  P = await cardState(page);
  const placedAfter = await page.evaluate(() => { const p = state.placed.find(q => q.sourceId === getActiveModel().id); return [p.x, p.z]; });
  check('a click near the bottom picks the bottom end, and the ring moves there', P.endAxis[2] === -1 && P.ring && P.ghost, P.readout);
  check('the click did not drag the piece', placedBefore[0] === placedAfter[0] && placedBefore[1] === placedAfter[1]);
  await page.evaluate(() => { state.tubeEdge.point = [0, 9, 39.5]; NSO_teLoad(); });
  P = await cardState(page);
  check('...and back at the top', P.endAxis[2] === 1 && P.ghost);

  console.log('\n=== 5. refusals take the ghost away and say why; Roll; Trumpet ===');
  await setField(page, 'inp-te-id2', '15');
  P = await cardState(page);
  console.log('   readout: ' + P.readout);
  check('New bore Ø15 inside a New Ø14: refused in words - the faces would cross', P.bad && /the faces would cross - the new outside Ø14\.00 is inside the new bore Ø15\.00/.test(P.readout), P.readout);
  check('...the ghost goes, Set is disabled, the ring stays', !P.ghost && P.goDisabled && P.ring);
  await setField(page, 'inp-te-id2', '10.8');
  await setField(page, 'inp-te-trans', '0');
  P = await cardState(page);
  check('Transition 0 with a new Ø: "transition 0: use Scale\'s ring rows for a step"', P.bad && /transition 0: use Scale's ring rows for a step/.test(P.readout) && !P.ghost, P.readout);
  await setField(page, 'inp-te-trans', '8');
  await setField(page, 'sel-te-verb', 'roll');
  await setField(page, 'inp-te-roll-angle', '330');
  P = await cardState(page);
  console.log('   readout: ' + P.readout);
  check('Roll rows shown (and Way); 330° refused before it reaches the tube, naming the most it rolls', P.rollShown && !P.reducerShown && P.dirShown && P.bad &&
        /it rolls up to \d+°/.test(P.readout), P.readout);
  await setField(page, 'inp-te-roll-angle', '180');
  P = await cardState(page);
  check('180° with the default radius (2.5 = 1.5 walls) is good again', !P.bad && P.ghost && !P.goDisabled && P.radius === '2.5' &&
        /Roll 180° round a 2\.50 mm bead/.test(P.readout), P.readout);
  await setField(page, 'sel-te-verb', 'reducer');
  await setField(page, 'sel-te-profile', 'trumpet');
  P = await cardState(page);
  check('Trumpet reads each face\'s angle where it ends (atan 2·3/8 = 36.9°)', /^Reducer: Ø20\.00 \/ bore Ø16\.80 → Ø14\.00 \/ bore Ø10\.80 over 8\.0 mm, trumpet \(36\.9° outside, 36\.9° bore where it ends\)/.test(P.readout) && P.ghost, P.readout);
  await frame(page, 22, 100);
  await shot(page, 'tube-edge-card-trumpet-ghost.png');
  await setField(page, 'sel-te-profile', 'straight');

  console.log('\n=== 6. Cancel leaves the piece alone ===');
  await page.click('#btn-te-cancel');
  P = await cardState(page);
  check('the card shuts, ghost and ring gone, piece unchanged', !P.open && P.hidden && !P.ghost && !P.ring && (await soupOf(page)) === before);

  console.log('\n=== 7. Set: a straight reducer, one bake ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  P = await cardState(page);
  check('reopened, it keeps the numbers typed: Ø14 / bore 10.8 over 8, straight', P.od2 === '14' && P.id2 === '10.8' && P.trans === '8' && P.profile === 'straight' && P.ghost, P.readout);
  const expect = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Tube edge done|Tube edge refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await statusOf(page);
  console.log('   status: ' + st);
  const after = await page.evaluate(() => {
    const m = getActiveModel();
    return { T: NSO_bendTopology(m.rawTris), soup: Array.from(m.rawTris).join(','), h: m.size.y, open: state.tubeEdge.open, ghost: !!state.tubeEdge.ghost };
  });
  check('status: Tube edge done, with the numbers', /Tube edge done - Reducer: Ø20\.00 \/ bore Ø16\.80 → Ø14\.00 \/ bore Ø10\.80 over 8\.0 mm .* 768 → 1152 faces/.test(st), st);
  check('the piece is the ghost\'s soup, bit for bit', after.soup === expect);
  check('closed, 2-manifold, consistently wound', after.T.open === 0 && after.T.nm === 0 && after.T.flip === 0 && after.T.euler === 0, JSON.stringify(after.T));
  check('it stands 48 mm tall now', Math.abs(after.h - 48) < 1e-3, after.h.toFixed(3));
  check('the card closed, ghost gone', !after.open && !after.ghost);
  await frame(page, 28, 75);
  await shot(page, 'tube-edge-reduced.png');

  console.log('\n=== 8. one Undo puts it back, bit for bit ===');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const st2 = await statusOf(page);
  check('Undo names Tube edge', /Undo: Tube edge reverted/.test(st2), st2);
  check('the whole soup is back, coordinate for coordinate', (await soupOf(page)) === before);

  console.log('\n=== 9. Set: a roll 180° r 2.5 ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'roll');
  await setField(page, 'inp-te-radius', '2.5');
  await setField(page, 'inp-te-roll-angle', '180');
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Tube edge done - Roll|Tube edge refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st3 = await statusOf(page);
  console.log('   status: ' + st3);
  const rolled = await page.evaluate(() => { const m = getActiveModel(); return { T: NSO_bendTopology(m.rawTris), w: m.size.x }; });
  check('rolled: closed, 2-manifold, Ø33.2 across the bead', /Tube edge done - Roll 180° round a 2\.50 mm bead: Ø33\.20/.test(st3) &&
        rolled.T.open === 0 && rolled.T.nm === 0 && rolled.T.flip === 0 && Math.abs(rolled.w - 33.2) < 0.01, st3);
  await frame(page, 30, 70);
  await shot(page, 'tube-edge-rolled.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Tube edge reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('...and Undo again restores it', (await soupOf(page)) === before);

  console.log('\n=== 10. a closed box is refused in the card ===');
  const boxId = await loadSTL(page, writeSTL('box.stl', NSO_Stock.boxSoup(30, 20, 10)));
  await selectModel(page, boxId);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.modelId === getActiveModel().id, null, { timeout: 30000 });
  P = await cardState(page);
  check('the box: "that end is closed", no ghost, Set disabled', P.bad && /that end is closed - a flat 4-sided face/.test(P.readout) && !P.ghost && P.goDisabled, P.readout);
  await page.click('#btn-te-cancel');

  console.log('\n=== 11. paint stands it down; Bend and Tube edge take turns ===');
  await selectModel(page, tubeId);
  await page.evaluate(() => { getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 40, axisIdx: 2, keepMin: false, inner: false }] }; });
  const pr = await page.evaluate(() => NSO_teSelectedModel({ verb: 'reducer', od2: 14, id2: 10.8, transitionMm: 8 }));
  const st4 = await statusOf(page);
  check('declined, naming the painted count', !pr.ok && /Tube edge stood down - 1 painted face/.test(st4), st4);
  check('...piece unchanged', (await soupOf(page)) === before);
  await page.evaluate(() => { getActiveModel().faceMask = null; });
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open, null, { timeout: 10000 });
  await page.click('#btn-bend');
  await page.waitForFunction(() => state.bend && state.bend.open && !state.tubeEdge.open, null, { timeout: 10000 });
  P = await cardState(page);
  check('opening Bend shuts the Tube edge card, its ghost and ring', !P.open && P.hidden && !P.ghost && !P.ring);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && !state.bend.open, null, { timeout: 10000 });
  check('...and the other way round', true);

  console.log('\n=== 12. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
