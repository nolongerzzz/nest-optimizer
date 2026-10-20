#!/usr/bin/env node
/* Neck, driven through the real app, for its screenshots: real index.html,
   real script tags, real clicks, real Undo.
     node tools/nso_tube_neck_shots.js                    exit 0 = every gate held
     TUBE_NECK_SHOTS=dir node tools/nso_tube_neck_shots.js   ...and the screenshots

   The geometry is proven headless in tools/nso_tube_neck_test.js (tube:neck,
   in npm test). This is the card's third verb end to end - Neck in the verb
   list, its rows, the ghost and the band's two rings, a click on the tube
   centring the band, a refusal in words, Set, a second neck, one Undo each -
   and the hourglass picture. Not a test step: the ticket kept the suite to
   tube:neck. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.TUBE_NECK_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-tube-neck-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const NSO_Stock = require('../nso_stock.js');
const stockTube = (rOut, wall, h) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), 96);

const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris).join(','));
const cardState = page => page.evaluate(() => {
  const B = state.tubeEdge || {}, el = id => document.getElementById(id);
  return {
    open: !!B.open, verb: el('sel-te-verb').value,
    neckShown: !el('te-neck-rows').hidden, reducerShown: !el('te-reducer-rows').hidden, dirShown: !el('te-dir-row').hidden,
    length: el('inp-te-neck-length').value, dr: el('inp-te-neck-dr').value, profile: el('sel-te-neck-profile').value,
    readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'), goDisabled: el('btn-te-go').disabled,
    ghost: !!(B.ghost && B.ghost.parent), ring: !!(B.ring && B.ring.parent), rings: B.ring ? B.ring.children.length : 0,
    band: B.ring && B.ring.userData.band ? B.ring.userData.band : null,
    ghostTris: B.ghost ? B.ghost.geometry.attributes.position.count / 3 : 0,
    resultTris: B.result && B.result.ok ? B.result.tris.length / 9 : 0,
    pieceShown: (() => { const m = getActiveModel(), p = m && state.placed.find(q => q.sourceId === m.id); return !!(p && p.mesh && p.mesh.visible); })()
  };
});
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}
// Frame the piece from the side, a little above, the whole tube in view.
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
// The screen point of a raw (z-up) point on the piece.
const screenOf = (page, raw) => page.evaluate((raw) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
  mesh.updateMatrixWorld(true);
  const o = m.centerOffset, local = new THREE.Vector3(raw[0] - o.x, raw[2] - o.y, -raw[1] - o.z);
  const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  const x = r.left + (w.x + 1) / 2 * r.width, y = r.top + (1 - w.y) / 2 * r.height;
  return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement };
}, raw);

withApp(async (page, logs) => {
  console.log('\n=== 1. Neck on the Tube edge card, on a Stock tube Ø20 wall 1.6 x 40 ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', stockTube(10, 1.6, 40)));
  await selectModel(page, tubeId);
  await openFinishMenu(page);
  const before = await soupOf(page);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'neck');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'neck' && state.tubeEdge.result, null, { timeout: 30000 });
  let P = await cardState(page);
  console.log('   readout: ' + P.readout);
  check('Neck is the third verb: its rows shown, the Reducer\'s and Way hidden', P.verb === 'neck' && P.neckShown && !P.reducerShown && !P.dirShown);
  check('defaults from the wall: Length 12 (7.5 walls), Δr −4 (2.5 walls), Smooth', P.length === '12' && P.dr === '-4' && P.profile === 'smooth',
    P.length + ' / ' + P.dr + ' / ' + P.profile);
  check('blank: the band centred at the middle of the tube, said in words', /Pinch −4\.00 mm over 12\.0 mm, smooth, centred 20\.00 mm in: bore Ø16\.80 → Ø8\.80/.test(P.readout) && !P.bad, P.readout);
  check('the ghost is the soup Set would commit; two rings mark the band, a third its waist', P.ghost && P.ghostTris === P.resultTris && P.ring && P.rings === 3 &&
    P.band && Math.abs(P.band[0] + 26) < 1e-9 && Math.abs(P.band[1] + 14) < 1e-9, JSON.stringify(P.band));
  check('the piece is hidden while the ghost stands in it (a pinch lies inside it)', !P.pieceShown);
  check('opening it changes nothing', (await soupOf(page)) === before);

  console.log('\n=== 2. a click on the tube centres the band there ===');
  await frame(page, 15, 110);
  const pt = await screenOf(page, [10, 0, 10]);
  check('the point is on the canvas', pt.onCanvas, JSON.stringify(pt));
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => /centred 3\d\.\d\d mm in/.test(document.getElementById('te-readout').textContent), null, { timeout: 10000 });
  P = await cardState(page);
  check('clicked 10 mm up the outside: centred ~30 mm in from the top end', /centred 3\d\.\d\d mm in/.test(P.readout) && P.ghost, P.readout);

  console.log('\n=== 3. refusals in words take the ghost away ===');
  await setField(page, 'inp-te-neck-dr', '-9');
  P = await cardState(page);
  console.log('   readout: ' + P.readout);
  check('−9: refused, naming the bore limit', P.bad && /bore limit of Ø0\.80/.test(P.readout) && !P.ghost && P.goDisabled);
  check('...and with the ghost gone the piece shows again', P.pieceShown);

  console.log('\n=== 4. Set: an hourglass ===');
  await page.evaluate(() => { state.tubeEdge.point = [10, 0, 20]; NSO_tePreview(); });
  await setField(page, 'inp-te-neck-length', '36');
  await setField(page, 'inp-te-neck-dr', '-5.5');
  P = await cardState(page);
  check('pinch −5.5 over 36, centred: good', !P.bad && P.ghost && /Pinch −5\.50 mm over 36\.0 mm, smooth, centred 20\.00 mm in/.test(P.readout), P.readout);
  await frame(page, 12, 95);
  await shot(page, 'tube-neck-hourglass-ghost.png');
  const expect = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Neck done|Neck refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await statusOf(page);
  console.log('   status: ' + st);
  const after = await page.evaluate(() => { const m = getActiveModel(); return { T: NSO_bendTopology(m.rawTris), soup: Array.from(m.rawTris).join(','), h: m.size.y }; });
  check('status: Neck done, with the numbers', /Neck done - Pinch −5\.50 mm over 36\.0 mm/.test(st), st);
  check('the piece is the ghost\'s soup, bit for bit; closed, 2-manifold', after.soup === expect && after.T.open === 0 && after.T.nm === 0 && after.T.flip === 0);
  check('the ends unchanged: still 40 mm long', Math.abs(after.h - 40) < 1e-3, after.h.toFixed(3));
  P = await cardState(page);
  check('the card closed, the piece shown', !P.open && !P.ghost && P.pieceShown);
  await frame(page, 24, 95);
  await shot(page, 'tube-neck-hourglass.png');

  console.log('\n=== 5. one Undo puts it back ===');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const st2 = await statusOf(page);
  check('Undo names Neck; the soup is back, coordinate for coordinate', /Undo: Neck reverted/.test(st2) && (await soupOf(page)) === before, st2);

  console.log('\n=== 6. two necks, each its own Undo ===');
  async function neckAt(z, len, dr, profile) {
    await page.click('#btn-tube-edge');
    await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
    await setField(page, 'sel-te-verb', 'neck');
    await page.waitForFunction(() => state.tubeEdge.readVerb === 'neck', null, { timeout: 30000 });
    await page.evaluate((z) => { state.tubeEdge.point = [10, 0, z]; NSO_tePreview(); }, z);
    await setField(page, 'inp-te-neck-length', String(len));
    await setField(page, 'inp-te-neck-dr', String(dr));
    await setField(page, 'sel-te-neck-profile', profile);
    await page.click('#btn-te-go');
    await page.waitForFunction(() => /Neck done|Neck refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
    return statusOf(page);
  }
  const s1 = await neckAt(9, 12, -4, 'smooth');
  const one = await soupOf(page);
  const s2 = await neckAt(31, 12, 3, 'funnel');
  check('a pinch at 9 mm and a funnel bulge at 31 mm: both done', /Neck done/.test(s1) && /Neck done - Bulge \+3\.00 mm over 12\.0 mm, funnel/.test(s2), s2);
  await frame(page, 12, 100);
  await shot(page, 'tube-neck-two.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Neck reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo takes off the second, leaving the first', (await soupOf(page)) === one);
  await page.evaluate(() => setStatus('-'));
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Neck reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('...and another, the first', (await soupOf(page)) === before);

  console.log('\n=== 7. the Reducer still the Reducer ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'reducer');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'end' && state.tubeEdge.result, null, { timeout: 30000 });
  P = await cardState(page);
  check('back to the Reducer: its rows shown (Way is a Roll\'s), the reducer previewed', P.reducerShown && !P.neckShown && !P.dirShown && /^(Reducer|Expander)/.test(P.readout) && P.ghost, P.readout);
  await page.click('#btn-te-cancel');

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
