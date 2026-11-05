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

  console.log('\n=== 9b. Keep length: the reducer cut into the wall, the tube stays 40 mm ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'reducer');
  await setField(page, 'inp-te-od2', '26');
  await setField(page, 'inp-te-id2', '22.8');
  await setField(page, 'inp-te-trans', '10');
  await setField(page, 'inp-te-run', '4');
  let K = await page.evaluate(() => ({ box: !!document.getElementById('chk-te-keep'), on: document.getElementById('chk-te-keep').checked,
    handles: !!NSO_teReducerGeom(), readout: document.getElementById('te-readout').textContent }));
  check('the Keep length box is on the Reducer card, off by default, and the plain reducer adds its 14 mm (the old way, still there)',
    K.box && !K.on && K.handles && /^Expander: Ø20\.00 \/ bore Ø16\.80 → Ø26\.00 \/ bore Ø22\.80 over 10\.0 mm .*, then 4\.0 mm run/.test(K.readout), K.readout);
  await page.click('#chk-te-keep');
  await page.waitForFunction(() => /length kept/.test(document.getElementById('te-readout').textContent), null, { timeout: 15000 });
  K = await page.evaluate(() => ({ on: document.getElementById('chk-te-keep').checked, handles: !!NSO_teReducerGeom(), tris: state.tubeEdge.result && state.tubeEdge.result.tris,
    readout: document.getElementById('te-readout').textContent, ghost: !!(state.tubeEdge.ghost && state.tubeEdge.ghost.parent), goDisabled: document.getElementById('btn-te-go').disabled,
    key: state.tubeEdge.result && state.tubeEdge.result.keepLength }));
  console.log('   readout: ' + K.readout);
  check('ticked: the readout says Expander, length kept, Ø26 / bore Ø22.8 at the end for 4 mm, back to Ø20 / Ø16.8 over 10, the tube stays 40 mm',
    K.on && /^Expander, length kept: Ø26\.00 \/ bore Ø22\.80 at the end for 4\.0 mm, then easing back to the tube's Ø20\.00 \/ bore Ø16\.80 over 10\.0 mm .* · the tube stays 40\.00 mm long · wall 1\.60/.test(K.readout), K.readout);
  check('...the ghost is up and Set is live', K.ghost && !K.goDisabled);
  // the rings are handles here too, laid down the tube: OD and ID on the end ring, R a Run (4) below it, T a Transition (10) below that
  const RG = await page.evaluate(() => { const g = NSO_teReducerGeom(); return g && { keep: g.keep, hO: g.hO, hI: g.hI, hR: g.hR, hT: g.hT, rings: NSO_teReducerRings(g).map(q => q[0]).join(),
    live: state.tubeEdge.ring.children.map(c => c.userData.teHandle).join() }; });
  check('Keep length: the OD / ID rings stand on the end (z 0), the R ring 4 mm down, the T ring 14 mm down, all four drawn (R even at Run 0)',
    RG && RG.keep && RG.hO === 0 && RG.hI === 0 && RG.hR === -4 && RG.hT === -14 && RG.rings === 'od,id,t,r' && /od,id,t,r$/.test(RG.live.replace(/^,?(?:undefined,?)*/, '').replace(/^.*?(od,id,t,r)$/, '$1')), JSON.stringify(RG));
  const keepExpect = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await frame(page, 28, 75);
  await shot(page, 'tube-edge-keep-ghost.png');
  await setField(page, 'inp-te-trans', '60');
  K = await page.evaluate(() => ({ readout: document.getElementById('te-readout').textContent, bad: document.getElementById('te-readout').classList.contains('is-bad'),
    ghost: !!(state.tubeEdge.ghost && state.tubeEdge.ghost.parent), goDisabled: document.getElementById('btn-te-go').disabled }));
  check('Transition 60 on a 40 mm tube: refused in words, naming the room and the way out, the ghost gone, Set dead',
    K.bad && !K.ghost && K.goDisabled && /^Tube edge: Keep length cuts the transition and the run into the wall, and the tube is 40\.0 mm long - Transition 60\.0 \+ Run 4\.0 = 64\.0 mm .*Use 39\.6 mm or less between them, or turn Keep length off/.test(K.readout), K.readout);
  await setField(page, 'inp-te-trans', '10');
  await page.waitForFunction(() => !!(state.tubeEdge.result && state.tubeEdge.result.ok), null, { timeout: 15000 });
  check('...and back to 10 the same ghost is back, soup for soup', (await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','))) === keepExpect);
  // THE RINGS, DRAGGED: the T ring 4 mm further down the tube is Transition +4 (the Run held); the R ring 3 mm down is Run +3; with Run 0 the R ring is still there to pull
  await frame(page, 20, 130);
  const ringPt = (handle, dh) => page.evaluate(([handle, dh]) => {
    const g = NSO_teReducerGeom(), r = NSO_teReducerRings(g).find(q => q[0] === handle), m = g.m;
    let best = null;
    for (let i = 0; i < 96; i++) {                         // the ring's right-most point on screen: edge-on, clear of the other rings
      const a = 2 * Math.PI * i / 96, O = NSO_teAxisPoint(g, r[1] + dh);
      const raw = [0, 1, 2].map(k => O[k] + r[2] * (Math.cos(a) * g.e1[k] + Math.sin(a) * g.e2[k]));
      const P = NSO_teScreen(m, raw);
      if (!best || P.x > best.x) best = { x: P.x, y: P.y };
    }
    return best;
  }, [handle, dh]);
  const fieldsNow = () => page.evaluate(() => ({ trans: document.getElementById('inp-te-trans').value, run: document.getElementById('inp-te-run').value,
    od2: document.getElementById('inp-te-od2').value, id2: document.getElementById('inp-te-id2').value, callout: (document.getElementById('te-callout') || {}).textContent,
    hit: null }));
  const hitAt = pt => page.evaluate(([x, y]) => NSO_teNeckHit(x, y), [pt.x, pt.y]);
  const T0p = await ringPt('t', 0), T1p = await ringPt('t', -4);
  check('the T ring (14 mm down) is the handle under the pointer there', (await hitAt(T0p)) === 't', JSON.stringify(T0p));
  await page.mouse.move(T0p.x, T0p.y); await page.mouse.down(); await page.mouse.move(T1p.x, T1p.y, { steps: 12 });
  let Fd = await fieldsNow();
  check('mid-drag, T 4 mm further down: the chip reads 14.0 mm, the dimension line is between the R and T rings', +Fd.trans === 14 && /^14\.0 mm$/.test(Fd.callout || ''), JSON.stringify(Fd));
  await page.mouse.up();
  Fd = await fieldsNow();
  const geo = await page.evaluate(() => { const g = NSO_teReducerGeom(); return { hR: g.hR, hT: g.hT, ok: !!(state.tubeEdge.result && state.tubeEdge.result.ok), read: document.getElementById('te-readout').textContent }; });
  check('T ring 4 mm down the tube: Transition 14, the Run held at 4, the Ø kept; the T ring now 18 mm down; the ghost still ok', +Fd.trans === 14 && +Fd.run === 4 && +Fd.od2 === 26 && geo.hT === -18 && geo.hR === -4 && geo.ok, JSON.stringify([Fd, geo]));
  const R0p = await ringPt('r', 0), R1p = await ringPt('r', -3);
  check('the R ring (4 mm down) is the handle there', (await hitAt(R0p)) === 'r');
  await page.mouse.move(R0p.x, R0p.y); await page.mouse.down(); await page.mouse.move(R1p.x, R1p.y, { steps: 12 });
  await page.mouse.up();
  Fd = await fieldsNow();
  const geo2 = await page.evaluate(() => { const g = NSO_teReducerGeom(); return { hR: g.hR, hT: g.hT, ok: !!(state.tubeEdge.result && state.tubeEdge.result.ok) }; });
  check('R ring 3 mm down: Run 7, the Transition held at 14 (the T ring follows, 21 mm down)', +Fd.run === 7 && +Fd.trans === 14 && geo2.hR === -7 && geo2.hT === -21 && geo2.ok, JSON.stringify([Fd, geo2]));
  // dragging a ring back up the tube shortens it, to 0 and no further; Up / Down step it the way it moves on screen
  const R2p = await ringPt('r', 0), R3p = await ringPt('r', 12);
  await page.mouse.move(R2p.x, R2p.y); await page.mouse.down(); await page.mouse.move(R3p.x, R3p.y, { steps: 12 }); await page.mouse.up();
  Fd = await fieldsNow();
  check('R ring dragged up past the end: Run 0 and no less; the R ring stays up, on the end, outside the Ø rings', +Fd.run === 0 &&
    (await page.evaluate(() => NSO_teReducerRings(NSO_teReducerGeom()).map(q => q[0]).join())) === 'od,id,t,r');
  // the Ø rings on the end ring: OD 1.5 mm in is New Ø -3
  const O0p = await page.evaluate(() => { const g = NSO_teReducerGeom(); let best = null;
    for (let i = 0; i < 96; i++) { const a = 2 * Math.PI * i / 96, O = NSO_teAxisPoint(g, 0), raw = [0, 1, 2].map(k => O[k] + g.rO * (Math.cos(a) * g.e1[k] + Math.sin(a) * g.e2[k]));
      const P = NSO_teScreen(g.m, raw); if (!best || P.x > best.x) best = { x: P.x, y: P.y, a }; }
    const a = best.a, O = NSO_teAxisPoint(g, 0), raw2 = [0, 1, 2].map(k => O[k] + (g.rO - 1.5) * (Math.cos(a) * g.e1[k] + Math.sin(a) * g.e2[k])), P2 = NSO_teScreen(g.m, raw2);
    return { x: best.x, y: best.y, x2: P2.x, y2: P2.y }; });
  check('the OD ring on the end is the handle there', (await hitAt(O0p)) === 'od');
  await page.mouse.move(O0p.x, O0p.y); await page.mouse.down(); await page.mouse.move(O0p.x2, O0p.y2, { steps: 12 }); await page.mouse.up();
  Fd = await fieldsNow();
  check('OD ring 1.5 mm toward the axis: New Ø 23.00 (was 26), the bore unchanged', +Fd.od2 === 23 && +Fd.id2 === 22.8, JSON.stringify(Fd));
  // FROM ABOVE: looking almost straight down the axis (86°) the Ø rings, on the end, are what is in view. A radial ring is then
  // read on its own plane, so the pointer is the radius: OD 2 mm out is New Ø +4, the ID ring 1 mm in is New bore -2 (both were nothing at 86°, half at 75°)
  await frame(page, 86, 130);
  const ringDrag = async (handle, dr) => {
    const P = await page.evaluate(([handle, dr]) => { const g = NSO_teReducerGeom(), q = NSO_teReducerRings(g).find(x => x[0] === handle), O = NSO_teAxisPoint(g, q[1]);
      const at = r => NSO_teScreen(g.m, [0, 1, 2].map(k => O[k] + r * g.e1[k])), a = at(q[2]), b = at(q[2] + dr); return { x: a.x, y: a.y, x2: b.x, y2: b.y }; }, [handle, dr]);
    await page.mouse.move(P.x, P.y); await page.mouse.down(); await page.mouse.move(P.x2, P.y2, { steps: 12 }); await page.mouse.up();
    return fieldsNow();
  };
  Fd = await ringDrag('od', 2);
  check('from above (86°): the OD ring 2 mm out is New Ø +4 (23.00 -> 27.00), the bore unchanged', +Fd.od2 === 27 && +Fd.id2 === 22.8, JSON.stringify(Fd));
  Fd = await ringDrag('id', -1);
  check('from above (86°): the ID ring 1 mm in is New bore -2 (22.80 -> 20.80), the outside unchanged', +Fd.id2 === 20.8 && +Fd.od2 === 27, JSON.stringify(Fd));
  await frame(page, 28, 75);
  // back to the numbers the Set below is checked against
  await setField(page, 'inp-te-od2', '26'); await setField(page, 'inp-te-id2', '22.8'); await setField(page, 'inp-te-trans', '10'); await setField(page, 'inp-te-run', '4');
  await page.waitForFunction(() => !!(state.tubeEdge.result && state.tubeEdge.result.ok), null, { timeout: 15000 });
  check('...and typed back to Ø26 / 10 / 4 the ghost is the first one again, soup for soup', (await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','))) === keepExpect);
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Tube edge done|Tube edge refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const stK = await statusOf(page);
  console.log('   status: ' + stK);
  const kept = await page.evaluate(() => { const m = getActiveModel(); return { T: NSO_bendTopology(m.rawTris), soup: Array.from(m.rawTris).join(','), h: m.size.y, w: m.size.x }; });
  check('Set: Tube edge done, length kept', /^Tube edge done - Expander, length kept: Ø26\.00 \/ bore Ø22\.80/.test(stK), stK);
  check('the piece is the ghost\'s soup, bit for bit', kept.soup === keepExpect);
  check('closed, 2-manifold, consistently wound', kept.T.open === 0 && kept.T.nm === 0 && kept.T.flip === 0 && kept.T.degen === 0 && kept.T.euler === 0, JSON.stringify(kept.T));
  check('it is still 40 mm tall (the plain reducer made it 54), and Ø26 across at the end', Math.abs(kept.h - 40) < 2e-3 && Math.abs(kept.w - 26) < 0.01, 'h ' + kept.h.toFixed(3) + ' w ' + kept.w.toFixed(3));
  await frame(page, 28, 75);
  await shot(page, 'tube-edge-keep-set.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Tube edge reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo puts the tube back, coordinate for coordinate', (await soupOf(page)) === before);
  // the box stays ticked across the card (like the other fields): untick it so what follows is the plain card again
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await page.click('#chk-te-keep');
  await page.waitForFunction(() => !/length kept/.test(document.getElementById('te-readout').textContent), null, { timeout: 15000 });
  K = await page.evaluate(() => ({ on: document.getElementById('chk-te-keep').checked, handles: !!NSO_teReducerGeom(), readout: document.getElementById('te-readout').textContent }));
  check('unticked: the plain reducer (its length rings back past the end, no R ring at Run 0) - ' + K.readout.slice(0, 40), !K.on && K.handles && /^Expander: /.test(K.readout), K.readout);
  await page.click('#btn-te-cancel');

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
