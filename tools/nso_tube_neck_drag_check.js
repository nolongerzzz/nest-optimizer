#!/usr/bin/env node
/* Neck's handles, driven through the real app: real index.html, real script
   tags, real pointer drags and keys. The second half of tube:neck (the first,
   tools/nso_tube_neck_test.js, proves the geometry headless).
     node tools/nso_tube_neck_drag_check.js                 exit 0 = every gate held
     TUBE_NECK_DRAG_SHOTS=dir node tools/nso_tube_neck_drag_check.js   ...and screenshots

   What it proves: the three rings are up on the tube (two end rings, a
   waist), the cursor and the readout name a handle under the pointer, and
     - the WAIST dragged 5 mm toward the axis reads Δr −5.0 in its field, and
       the ghost's waist (measured off the ghost's own vertices) is Ø10, 10 mm
       under the tube's Ø20; with Shift it moves in 0.1 mm steps;
     - the BAND dragged 10 mm along the axis moves the neck's centre 10 mm;
       a press on it that does not travel is still the click that places it;
     - an END ring dragged 4 mm along the axis makes the Length 8 mm longer,
       the centre held;
     - the arrows: Up / Down the band 1 mm, Left / Right Δr 1 mm, 0.1 with
       Shift;
     - Escape puts a drag back where it began, then shuts the card;
     - no drag moves the camera, and OrbitControls is on again after each;
     - Set commits the dragged ghost and one Undo puts the piece back.
   And the REDUCER's four rings (tube-reducer-card; they replace Flare's lip
   and END rings, tube-end-drag / tube-run-card), on a Ø43.52 / Ø34.82 tube:
     - defaults on open: New Ø = Ø + 4, New bore = bore + 4, Transition 10,
       Run 0 - Flare Out +2 over 10, wall held: the same outside, vertex for
       vertex, the bore at Ø38.82 where Flare's carried lip cut is Ø38.65;
     - the OD ring 2.5 mm in is New Ø 38.52, the bore unchanged; the ID ring
       1 mm out is New bore 36.82, the outside unchanged; the T ring 4 mm
       along is Transition 16.1; the R ring 10 mm along is Run 17.5 - each
       read back off the fields and the ghost;
     - while each is in hand the piece carries its measure: a chip with the
       ring's Ø on it, or a dimension line between the two planes with its
       length; gone on the release, and never on a hover;
     - the arrows step the length ring and the Ø ring touched last, Shift
       tenths, Escape mid-drag, Shift + the T ring at Run 0 pulls a run out;
     - Set commits the ghost and one Undo puts the tube back; the ID ring
       alone on a Ø40.62 / Ø30.47 pipe is bore only, Set, one Undo;
     - Roll shows Way and hides the Reducer's rows, Neck shows Walls.
   Every grab point and target is a point on the tube, projected through the
   page's own camera; the drag's numbers are read back off the fields, the
   ghost and the readout. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, statusOf, openFinishMenu } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.TUBE_NECK_DRAG_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-tube-neck-drag-'));
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
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}
// The card and the handles as the page has them. The tube is Stock's: its
// axis is raw +Z through x = y = 0 and it was read off its top end (z 40),
// so the centre's height is 40 + h0.
const neck = page => page.evaluate(() => {
  const B = state.tubeEdge, el = id => document.getElementById(id), g = NSO_teNeckGeom();
  const cv = state.renderer.domElement;
  // the ghost's outside at the waist, off its own vertices: back to raw
  // (display (x, y, z) = (X, Z, -Y) - centerOffset), the most radius there
  let waistDia = null;
  if (B.ghost && g) {
    const o = getActiveModel().centerOffset, P = B.ghost.geometry.attributes.position.array, zw = 40 + g.h0;
    let hi = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const X = P[i] + o.x, Y = -(P[i + 2] + o.z), Z = P[i + 1] + o.y;
      if (Math.abs(Z - zw) < 2e-3) hi = Math.max(hi, Math.hypot(X, Y));
    }
    waistDia = isFinite(hi) ? 2 * hi : null;
  }
  return {
    open: !!B.open, length: el('inp-te-neck-length').value, dr: el('inp-te-neck-dr').value,
    readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
    ghost: !!(B.ghost && B.ghost.parent), waistDia,
    rings: B.ring ? B.ring.children.map(c => c.userData.teHandle) : [],
    hot: B.ring ? B.ring.children.filter(c => c.material.color.getHex() === 0xffffff).map(c => c.userData.teHandle) : [],
    h0: g ? g.h0 : null, L: g ? g.L : null, drNum: g ? g.dr : null, drag: !!B.drag, hover: B.hover,
    cursor: Array.from(cv.classList).filter(c => /^te-cur-/.test(c)),
    controls: state.controls.enabled
  };
});
// The Reducer and its rings as the page has them. Its tube's axis is raw +Z
// through x = y = 0, the top end read: a ring at height h is at z = zEnd + h.
// The ghost read back to raw: its top, its radii at the transition's end
// (tEnd) and at the top (topR) - lo the bore, hi the outside - and the most
// radius anywhere. The measure on the piece: the chip's text, which handle,
// and how far (px) the chip's centre is from its anchor's place on screen;
// the dimension line's handle and its two heights.
const red = page => page.evaluate(() => {
  const B = state.tubeEdge, el = id => document.getElementById(id), g = NSO_teReducerGeom(), cv = state.renderer.domElement;
  const o = getActiveModel().centerOffset, P = B.ghost ? B.ghost.geometry.attributes.position.array : [];
  const at = z => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < P.length; i += 3) if (Math.abs(P[i + 1] + o.y - z) < 2e-3) { const r = Math.hypot(P[i] + o.x, P[i + 2] + o.z); lo = Math.min(lo, r); hi = Math.max(hi, r); } return { lo, hi }; };
  let top = -Infinity, maxR = 0;
  for (let i = 0; i < P.length; i += 3) { top = Math.max(top, P[i + 1] + o.y); maxR = Math.max(maxR, Math.hypot(P[i] + o.x, P[i + 2] + o.z)); }
  const zEnd = B.read && B.read.end ? B.read.end.center[2] : 0;
  const chip = el('te-callout'), shown = !!(chip && !chip.hidden && chip.textContent);
  let calloutNear = null;
  if (shown && B.calloutAt) {
    const c = chip.getBoundingClientRect(), s = NSO_teScreen(getActiveModel(), B.calloutAt);
    calloutNear = Math.hypot(c.left + c.width / 2 - s.x, c.top + c.height / 2 - s.y);
  }
  return {
    open: !!B.open, od2: el('inp-te-od2').value, id2: el('inp-te-id2').value, trans: el('inp-te-trans').value, run: el('inp-te-run').value,
    readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
    ghost: !!(B.ghost && B.ghost.parent), top: B.ghost ? top : null, maxDia: 2 * maxR, zEnd,
    tEnd: g && B.ghost ? at(zEnd + g.hT) : null, topR: B.ghost ? at(top) : null,
    rings: B.ring ? B.ring.children.map(c => c.userData.teHandle).filter(Boolean) : [],
    hot: B.ring ? B.ring.children.filter(c => c.userData.teHandle && c.material.color.getHex() === 0xffffff).map(c => c.userData.teHandle) : [],
    g: g ? { hO: g.hO, hI: g.hI, hT: g.hT, hR: g.hR, rO: g.rO, rI: g.rI, Rlen: g.Rlen } : null,
    callout: shown ? chip.textContent : null, calloutHandle: shown ? chip.dataset.handle : null, calloutNear,
    dim: B.dim && B.dim.parent ? { h: B.dim.userData.teDim, from: B.dim.userData.from, to: B.dim.userData.to } : null,
    drag: !!B.drag, cursor: Array.from(cv.classList).filter(c => /^te-cur-/.test(c)), controls: state.controls.enabled
  };
});
const camera = page => page.evaluate(() => [...state.camera.position.toArray(), ...state.controls.target.toArray()].map(v => +v.toFixed(6)).join(','));
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
/* A point on the tube's surface of revolution, at height z and radius r, on
   the side the camera sees it edge-on ('side': square to the axis and to the
   line of sight, where a drag toward the axis reads true) or nearest the
   camera ('front'), projected to the screen. */
const onTube = (page, z, r, where) => page.evaluate(([z, r, where]) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh, o = m.centerOffset;
  mesh.updateMatrixWorld(true);
  const cam = state.camera.position.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  const cx = cam.x + o.x, cy = -(cam.z + o.z);                     // the camera in raw x, y
  const L = Math.hypot(cx, cy), ux = cx / L, uy = cy / L;          // toward it, square to the axis
  const dir = where === 'front' ? [ux, uy] : [-uy, ux];            // ...or square to that
  const local = new THREE.Vector3(r * dir[0] - o.x, z - o.y, -(r * dir[1]) - o.z);
  const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera);
  const rc = state.renderer.domElement.getBoundingClientRect();
  const x = rc.left + (w.x + 1) / 2 * rc.width, y = rc.top + (1 - w.y) / 2 * rc.height;
  return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement, hit: NSO_teNeckHit(x, y) };
}, [z, r, where]);
async function drag(page, from, to, steps) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: steps || 12 });
  await page.mouse.up();
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

withApp(async (page, logs) => {
  console.log('\n=== 1. Neck on a Stock tube Ø20 wall 1.6 x 40: three rings, placed by a click ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', stockTube(10, 1.6, 40)));
  await selectModel(page, tubeId);
  await openFinishMenu(page);
  const before = await soupOf(page);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'neck');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'neck' && state.tubeEdge.result, null, { timeout: 30000 });
  await frame(page, 15, 85);
  let N = await neck(page);
  check('three rings on the tube: two end rings and the waist', N.rings.join(',') === 'a,b,waist', N.rings.join(','));
  check('defaults: Length 12, Δr −4, centred at the middle (h0 −20)', N.length === '12' && N.dr === '-4' && near(N.h0, -20), N.length + ' / ' + N.dr + ' / ' + N.h0);
  // a click below the band places it (z 12: centred 28 mm in from the top)
  const click = await onTube(page, 12, 10, 'front');
  check('the click point is on the canvas, off every handle', click.onCanvas && click.hit === null, JSON.stringify(click));
  await page.mouse.click(click.x, click.y);
  N = await neck(page);
  check('the click centres the band there, as before', near(N.h0, -28, 0.05) && /centred 28\.\d\d mm in/.test(N.readout), N.h0 + ' · ' + N.readout);
  // one press on the band that does not travel is still the click
  const inBand = await onTube(page, 15, 10, 'front');
  check('a point inside the band (z 15) is the band', inBand.hit === 'band', JSON.stringify(inBand));
  let cam0 = await camera(page);
  await page.mouse.click(inBand.x, inBand.y);
  N = await neck(page);
  check('...and a press there that does not travel re-centres the band, the camera still', near(N.h0, -25, 0.05) && (await camera(page)) === cam0 && N.controls,
        N.h0 + '');
  await page.evaluate(() => { state.tubeEdge.point = [10, 0, 12]; NSO_tePreview(); });

  console.log('\n=== 2. the waist: 5 mm toward the axis is Δr −5.0 ===');
  await setField(page, 'inp-te-neck-dr', '0');
  N = await neck(page);
  check('Δr 0: refused in words, the waist ring on the wall (and still a handle)', N.bad && /a Δr of 0 is no neck/.test(N.readout) && !N.ghost && N.rings.length === 3, N.readout);
  const w0 = await onTube(page, 12, 10, 'side'), w1 = await onTube(page, 12, 5, 'side');
  check('the waist ring, edge-on at the side, is the handle there', w0.hit === 'waist' && w0.onCanvas, JSON.stringify(w0));
  await page.mouse.move(w0.x, w0.y);
  N = await neck(page);
  check('hover: the readout names it and the face it moves ("Wall Δr 0.0 mm"), lit, the cursor a resize across the axis',
        /^Wall Δr 0\.0 mm · /.test(N.readout) && N.hot.join() === 'waist' && N.cursor.join() === 'te-cur-ew', N.readout + ' · ' + N.cursor.join());
  cam0 = await camera(page);
  await drag(page, w0, w1);
  N = await neck(page);
  console.log('   readout: ' + N.readout);
  check('Δr field reads −5.0', N.dr === '-5.0' && near(N.drNum, -5), N.dr);
  check('the ghost is up and its waist outside is Ø10.00 ± 0.05 - 10 mm under the tube\'s Ø20', N.ghost && N.waistDia != null && near(N.waistDia, 10, 0.05),
        N.waistDia && N.waistDia.toFixed(3));
  check('...the readout says the same: outside Ø20.00 → Ø10.00', /Pinch −5\.00 mm over 12\.0 mm.*outside Ø20\.00 → Ø10\.00/.test(N.readout), N.readout);
  check('the drag did not move the camera; OrbitControls on again, the drag over', (await camera(page)) === cam0 && N.controls && !N.drag);
  // Shift: tenths
  const s0 = await onTube(page, 12, 5, 'side'), s1 = await onTube(page, 12, 7.3, 'side');
  await page.keyboard.down('Shift');
  await drag(page, s0, s1);
  await page.keyboard.up('Shift');
  N = await neck(page);
  check('with Shift, 2.3 mm out is 0.1 mm steps: Δr −2.7', near(N.drNum, -2.7, 1e-9) && N.dr === '-2.7', N.dr);
  await setField(page, 'inp-te-neck-dr', '-5');
  await shot(page, 'neck-drag-waist.png');

  console.log('\n=== 3. the band: 10 mm along the axis moves the neck 10 mm ===');
  const b0 = await onTube(page, 15, 10, 'front'), b1 = await onTube(page, 25, 10, 'front');
  check('the band is under the grab point (z 15, between the waist and the upper end ring)', b0.hit === 'band', JSON.stringify(b0));
  await page.mouse.move(b0.x, b0.y);
  N = await neck(page);
  check('hover: "Centre 28.0 mm in", a hand', /^Centre 28\.0 mm in · /.test(N.readout) && N.cursor.join() === 'te-cur-grab', N.readout + ' · ' + N.cursor.join());
  const h0a = N.h0, La = N.L;
  cam0 = await camera(page);
  await drag(page, b0, b1);
  N = await neck(page);
  console.log('   readout: ' + N.readout);
  check('the centre moved 10.00 mm up the tube (28 → 18 mm in)', near(N.h0 - h0a, 10, 1e-9) && /centred 18\.00 mm in/.test(N.readout), (N.h0 - h0a) + ' · ' + N.readout);
  check('...its Length and Δr untouched, the ghost there', near(N.L, La) && N.dr === '-5' && N.ghost);
  check('the camera did not move', (await camera(page)) === cam0 && N.controls && !N.drag);

  console.log('\n=== 4. an end ring: 4 mm along the axis is Length +8, centre held ===');
  const zb = 40 + N.h0 + N.L / 2, e0 = await onTube(page, zb, 10, 'side'), e1 = await onTube(page, zb + 4, 10, 'side');
  check('the upper end ring is the handle at its own height', e0.hit === 'b', JSON.stringify(e0));
  await page.mouse.move(e0.x, e0.y);
  N = await neck(page);
  check('hover: "Length 12.0 mm", a resize along the axis', /^Length 12\.0 mm · /.test(N.readout) && N.cursor.join() === 'te-cur-ns', N.readout + ' · ' + N.cursor.join());
  const h0b = N.h0;
  cam0 = await camera(page);
  await drag(page, e0, e1);
  N = await neck(page);
  console.log('   readout: ' + N.readout);
  check('Length 12 → 20, the field reads 20.0', near(N.L, 20, 1e-9) && N.length === '20.0', N.length);
  check('...the centre held', near(N.h0, h0b, 1e-9) && /over 20\.0 mm/.test(N.readout) && /centred 18\.00 mm in/.test(N.readout), N.readout);
  check('the camera did not move', (await camera(page)) === cam0 && N.controls);
  const za = 40 + N.h0 - N.L / 2, a0 = await onTube(page, za, 10, 'side'), a1 = await onTube(page, za - 2, 10, 'side');
  await drag(page, a0, a1);
  N = await neck(page);
  check('the lower end ring 2 mm down: Length +4 (24.0), centre held', a0.hit === 'a' && near(N.L, 24, 1e-9) && near(N.h0, h0b, 1e-9), N.length);
  await setField(page, 'inp-te-neck-length', '12');
  await shot(page, 'neck-drag-band.png');

  console.log('\n=== 5. arrow keys: 1 mm, 0.1 with Shift ===');
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  N = await neck(page);
  const k0 = N.h0, d0 = N.drNum;
  await page.keyboard.press('ArrowUp');
  N = await neck(page);
  check('Up: the band 1 mm up the tube', near(N.h0 - k0, 1, 1e-9) && /^Centre 17\.0 mm in/.test(N.readout), (N.h0 - k0) + ' · ' + N.readout);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  N = await neck(page);
  check('Down twice: 1 mm below where it was', near(N.h0 - k0, -1, 1e-9), String(N.h0 - k0));
  await page.keyboard.press('Shift+ArrowUp');
  N = await neck(page);
  check('Shift+Up: 0.1 mm', near(N.h0 - k0, -0.9, 1e-9), String(N.h0 - k0));
  await page.keyboard.press('ArrowLeft');
  N = await neck(page);
  check('Left: Δr 1 mm more pinch (−6.0)', near(N.drNum - d0, -1, 1e-9) && N.dr === '-6.0' && /^Wall Δr −6\.0 mm/.test(N.readout), N.dr + ' · ' + N.readout);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  N = await neck(page);
  check('Right, Shift+Right: Δr +1.1 back (−4.9)', near(N.drNum, -4.9, 1e-9) && N.dr === '-4.9', N.dr);
  check('...the ghost follows the keys as it does the fields', N.ghost && /Pinch −4\.90 mm over 12\.0 mm/.test(N.readout.replace(/^Wall Δr [^·]*· /, '')), N.readout);
  check('the keys never moved the camera', N.controls);

  console.log('\n=== 6. Escape: the drag goes back, then the card shuts ===');
  const before6 = await neck(page);
  const x0 = await onTube(page, 40 + before6.h0, 10 + before6.drNum, 'side'), x1 = await onTube(page, 40 + before6.h0, 10 + before6.drNum - 2, 'side');
  check('the waist under the grab point again', x0.hit === 'waist', JSON.stringify(x0));
  await page.mouse.move(x0.x, x0.y);
  await page.mouse.down();
  await page.mouse.move(x1.x, x1.y, { steps: 8 });
  N = await neck(page);
  check('mid-drag: Δr moved (−6.9), a drag in hand, the orbit off', N.drag && near(N.drNum, -6.9, 1e-9) && !N.controls, N.dr);
  await page.keyboard.press('Escape');
  N = await neck(page);
  check('Escape: the drag put back (Δr −4.9, the centre where it was), the card still open, the orbit on',
        !N.drag && N.open && N.dr === '-4.9' && near(N.h0, before6.h0, 1e-9) && N.controls && N.ghost, N.dr);
  await page.mouse.up();
  N = await neck(page);
  check('...the release after it changes nothing', N.dr === '-4.9' && near(N.h0, before6.h0, 1e-9));
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  N = await neck(page);
  check('Escape again: the card shuts, the rings and ghost gone, the piece unchanged', !N.open && N.rings.length === 0 && !N.ghost && (await soupOf(page)) === before);

  console.log('\n=== 7. Set commits the dragged ghost; one Undo ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.readVerb === 'neck' && state.tubeEdge.result, null, { timeout: 30000 });
  await page.evaluate(() => { state.tubeEdge.point = [10, 0, 20]; NSO_tePreview(); });
  await setField(page, 'inp-te-neck-dr', '-2');
  const g0 = await onTube(page, 20, 8, 'side'), g1 = await onTube(page, 20, 5, 'side');
  await drag(page, g0, g1);
  N = await neck(page);
  check('reopened, the waist dragged 3 mm in: Δr −5.0', g0.hit === 'waist' && N.dr === '-5.0' && N.ghost, N.dr);
  const expect = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Neck done|Neck refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await statusOf(page);
  check('Set: "Neck done - Pinch −5.00 mm", the piece is the ghost\'s soup', /Neck done - Pinch −5\.00 mm over 12\.0 mm/.test(st) && (await soupOf(page)) === expect, st);
  await frame(page, 15, 85);
  await shot(page, 'neck-drag-set.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Neck reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo puts it back, bit for bit', (await soupOf(page)) === before);

  console.log('\n=== 8. Reducer on a Ø43.52 / Ø34.82 tube: defaults, then its four rings - OD, ID, T, R - and the measure on the piece ===');
  const RRedId = await loadSTL(page, writeSTL('red.stl', stockTube(21.76, 4.35, 40)));
  await selectModel(page, RRedId);
  const RRedBefore = await soupOf(page);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'reducer');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'end' && state.tubeEdge.read && state.tubeEdge.read.ok && state.tubeEdge.result, null, { timeout: 30000 });
  await page.evaluate(() => { state.tubeEdge.point = [0, 19, 39.5]; NSO_teLoad(); });      // the top end
  await frame(page, 15, 220);            // wide enough for the transition and the run up to ~40 mm past the end
  let F = await red(page);
  check('defaults on open: New Ø 47.52 (Ø + 4), New bore 38.82 (bore + 4), Transition 10, Run 0; the OD, ID and T rings up, no R ring',
    F.od2 === '47.52' && F.id2 === '38.82' && F.trans === '10' && F.run === '0' && F.rings.join() === 'od,id,t' && F.ghost && !F.bad,
    [F.od2, F.id2, F.trans, F.run, F.rings.join()].join(' / '));
  // the defaults are Flare Out +2 over 10, wall held: the same outside, built
  // directly; the bore at Ø38.82 exactly where Flare's carried one is cut at
  // the lip t / cos θ wide (Ø38.65)
  const RCmp = await page.evaluate(() => {
    const m = getActiveModel(), B = state.tubeEdge, rr = B.result, rf = NSO_tubeEdgeRaw(m.rawTris, { verb: 'flare', length: 10, dr: 2, read: B.read });
    const outside = r => { const S = []; const s = r.tris; for (let i = 0; i < s.length; i += 3) if (s[i + 2] > 40 + 1e-4 && Math.hypot(s[i], s[i + 1]) > 21.7) S.push([s[i], s[i + 1], s[i + 2]]); return S; };
    const A = outside(rr), Fo = outside(rf), key = p => p.map(v => v.toFixed(4)).join(','), FS = new Set(Fo.map(key));
    const Ir = rr.meridian.inner, If = rf.meridian.inner;
    return { ok: rr.ok && rf.ok, n: A.length, nf: Fo.length, same: A.every(p => FS.has(key(p))),
             odR: 2 * rr.meridian.outer[rr.meridian.outer.length - 1][0], odF: 2 * rf.lipOuterRadiusMm, idR: 2 * Ir[Ir.length - 1][0], idF: 2 * If[If.length - 1][0],
             hR: rr.meridian.outer[rr.meridian.outer.length - 1][1], hF: rf.meridian.outer[rf.meridian.outer.length - 1][1], wallR: rr.reducer.wallEndMm };
  });
  check('...that ghost is Flare Out +2 over 10, wall held: the same outside, vertex for vertex (to 1e-4), the same lip Ø47.52 at the same height',
    RCmp.ok && RCmp.same && RCmp.n > 0 && Math.abs(RCmp.odR - RCmp.odF) < 1e-4 && Math.abs(RCmp.odR - 47.52) < 1e-4 && RCmp.hR === RCmp.hF, JSON.stringify(RCmp));
  check('...and its bore Ø38.82, the wall 4.35 at the end exactly - Flare\'s carried bore is cut Ø' + RCmp.idF.toFixed(2) + ' there (the lip\'s width, docs: Reducer flag 1)',
    Math.abs(RCmp.idR - 38.82) < 1e-4 && Math.abs(RCmp.wallR - 4.35) < 1e-4 && Math.abs(RCmp.idF - 2 * (23.76 - 4.35 / Math.cos(Math.atan2(2, 10)))) < 1e-3, RCmp.idR.toFixed(4) + ' vs ' + RCmp.idF.toFixed(4));
  // the card's own numbers, then the handles
  await setField(page, 'inp-te-od2', '43.52');
  await setField(page, 'inp-te-id2', '34.82');
  await setField(page, 'inp-te-trans', '12.1');
  await setField(page, 'inp-te-run', '7.5');
  F = await red(page);
  check('New Ø 43.52 / bore 34.82 (the tube\'s own), Transition 12.1, Run 7.5: the R ring joins them, at the run\'s end (z 59.6)',
    F.rings.join() === 'od,id,t,r' && near(F.zEnd + F.g.hR, 59.6, 1e-6) && near(F.g.rO, 21.76, 1e-6) && near(F.g.rI, 17.41, 1e-6), F.rings.join() + ' · ' + JSON.stringify(F.g));
  const RZT = F.zEnd + F.g.hT;
  // OD: 2.5 mm toward the axis is New Ø −5
  const RO0 = await onTube(page, RZT, F.g.rO, 'side'), RO1 = await onTube(page, RZT, F.g.rO - 2.5, 'side');
  check('the OD ring, edge-on at the side, is the handle there', RO0.hit === 'od' && RO0.onCanvas, JSON.stringify(RO0));
  await page.mouse.move(RO0.x, RO0.y);
  F = await red(page);
  check('hover: "New Ø43.52 mm", lit, a resize across the axis - and no measure on the piece (a hover is the readout\'s)',
    /^New Ø43\.52 mm · /.test(F.readout) && F.hot.join() === 'od' && F.cursor.join() === 'te-cur-ew' && F.callout === null && F.dim === null, F.readout + ' · ' + F.cursor.join());
  cam0 = await camera(page);
  await page.mouse.down();
  await page.mouse.move(RO1.x, RO1.y, { steps: 12 });
  F = await red(page);
  check('mid-drag: the chip on the piece reads "Ø38.52", on the OD ring where it was taken hold of', F.drag && F.callout === 'Ø38.52' && F.calloutHandle === 'od' &&
    F.calloutNear != null && F.calloutNear < 3, F.callout + ' · ' + F.calloutNear + ' px from the ring');
  await page.mouse.up();
  F = await red(page);
  console.log('   readout: ' + F.readout);
  check('OD ring 2.5 mm in: New Ø 38.52, the bore unchanged (34.82)', F.od2 === '38.52' && F.id2 === '34.82', F.od2 + ' / ' + F.id2);
  check('...the ghost follows: its outside Ø38.52 at the transition\'s end, its bore Ø34.82', F.ghost && near(F.tEnd.hi * 2, 38.52, 0.01) && near(F.tEnd.lo * 2, 34.82, 0.01),
    (2 * F.tEnd.hi).toFixed(3) + ' / ' + (2 * F.tEnd.lo).toFixed(3));
  check('...the measure gone with the release; the camera still, the orbit on', F.callout === null && F.dim === null && (await camera(page)) === cam0 && F.controls && !F.drag);
  // ID: 1 mm out is New bore +2
  const RI0 = await onTube(page, RZT, F.g.rI, 'side'), RI1 = await onTube(page, RZT, F.g.rI + 1, 'side');
  check('the ID ring is the handle on the bore', RI0.hit === 'id' && RI0.onCanvas, JSON.stringify(RI0));
  await page.mouse.move(RI0.x, RI0.y);
  await page.mouse.down();
  await page.mouse.move(RI1.x, RI1.y, { steps: 12 });
  F = await red(page);
  check('mid-drag: "Ø36.82" on the ID ring', F.callout === 'Ø36.82' && F.calloutHandle === 'id' && F.calloutNear < 3, F.callout + ' · ' + F.calloutNear);
  await page.mouse.up();
  F = await red(page);
  check('ID ring 1 mm out: New bore 36.82, the outside unchanged (38.52); the measure gone', F.id2 === '36.82' && F.od2 === '38.52' && F.callout === null, F.od2 + ' / ' + F.id2);
  check('...the ghost\'s bore Ø36.82 at the transition\'s end', F.ghost && near(F.tEnd.lo * 2, 36.82, 0.01), (2 * F.tEnd.lo).toFixed(3));
  // T: 4 mm along the axis is the Transition +4
  const RT0 = await onTube(page, RZT, F.g.Rlen, 'side'), RT1 = await onTube(page, RZT + 4, F.g.Rlen, 'side');
  check('the T ring, outside both, in the transition\'s end plane, is the handle there', RT0.hit === 't' && RT0.onCanvas, JSON.stringify(RT0));
  await page.mouse.move(RT0.x, RT0.y);
  F = await red(page);
  check('hover: "Transition 12.1 mm", a resize along the axis', /^Transition 12\.1 mm · /.test(F.readout) && F.cursor.join() === 'te-cur-ns' && F.callout === null, F.readout);
  await page.mouse.down();
  await page.mouse.move(RT1.x, RT1.y, { steps: 12 });
  F = await red(page);
  check('mid-drag: a dimension line along the axis from the end (0) to the transition\'s end (16.1), its chip "16.1 mm" at its middle',
    F.callout === '16.1 mm' && F.dim && F.dim.h === 't' && near(F.dim.from, 0, 1e-9) && near(F.dim.to, 16.1, 1e-6) && F.calloutNear < 3, F.callout + ' · ' + JSON.stringify(F.dim));
  await page.mouse.up();
  F = await red(page);
  check('T ring 4 mm along: Transition 16.1, the Ø kept; the measure gone', F.trans === '16.1' && F.od2 === '38.52' && F.id2 === '36.82' && F.callout === null && F.dim === null, F.trans);
  check('...the ghost\'s transition ends 16.1 mm out (its Ø38.52 there), the run on to z ' + (40 + 16.1 + 7.5).toFixed(1),
    F.ghost && near(F.tEnd.hi * 2, 38.52, 0.01) && near(F.top, 63.6, 1e-3), (2 * F.tEnd.hi).toFixed(3) + ' · top ' + F.top);
  // R: 10 mm along the axis is the Run +10
  const RZR = F.zEnd + F.g.hR, RR0 = await onTube(page, RZR, F.g.Rlen, 'side'), RR1 = await onTube(page, RZR + 10, F.g.Rlen, 'side');
  check('the R ring at the run\'s far end is the handle there (and 10 mm past it is on the canvas)', RR0.hit === 'r' && RR0.onCanvas && RR1.onCanvas, JSON.stringify(RR0));
  await page.mouse.move(RR0.x, RR0.y);
  await page.mouse.down();
  await page.mouse.move(RR1.x, RR1.y, { steps: 12 });
  F = await red(page);
  check('mid-drag: the dimension line from the transition\'s end (16.1) to the run\'s (33.6), "17.5 mm"',
    F.callout === '17.5 mm' && F.dim && F.dim.h === 'r' && near(F.dim.from, 16.1, 1e-6) && near(F.dim.to, 33.6, 1e-6) && F.calloutNear < 3, F.callout + ' · ' + JSON.stringify(F.dim));
  await page.mouse.up();
  F = await red(page);
  console.log('   readout: ' + F.readout);
  check('R ring 10 mm along: Run 17.5, the transition kept; the measure gone', F.run === '17.5' && F.trans === '16.1' && F.callout === null && F.dim === null, F.run);
  check('...the ghost\'s top at z 73.6, one cylinder Ø38.52 / Ø36.82 there', F.ghost && near(F.top, 73.6, 1e-3) && near(F.topR.hi * 2, 38.52, 0.01) && near(F.topR.lo * 2, 36.82, 0.01),
    F.top + ' · ' + (2 * F.topR.hi).toFixed(3) + ' / ' + (2 * F.topR.lo).toFixed(3));
  check('...the readout: "Reducer: Ø43.52 / bore Ø34.82 → Ø38.52 / bore Ø36.82 over 16.1 mm (…), then 17.5 mm run · wall 4.35 → 0.85"',
    /^Reducer: Ø43\.52 \/ bore Ø34\.82 → Ø38\.52 \/ bore Ø36\.82 over 16\.1 mm \([\d.]+° outside, [\d.]+° bore\), then 17\.5 mm run · wall 4\.35 → 0\.85/.test(F.readout), F.readout);
  // arrows: Up / Down the length ring last touched (R), Left / Right the Ø ring (ID)
  await page.mouse.move(5, 5);
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('ArrowUp');
  F = await red(page);
  check('Up: the R ring was the length ring touched last - Run 18.5, the Transition kept', F.run === '18.5' && F.trans === '16.1' && /^Run 18\.5 mm · /.test(F.readout), F.run + ' · ' + F.readout);
  await page.keyboard.press('ArrowLeft');
  F = await red(page);
  check('Left: the ID ring was the Ø ring touched last - New bore 35.82, the outside kept', F.id2 === '35.82' && F.od2 === '38.52' && /^New bore Ø35\.82 mm · /.test(F.readout), F.id2 + ' · ' + F.readout);
  await page.keyboard.press('Shift+ArrowRight');
  F = await red(page);
  check('Shift+Right: 0.1 back out (35.92)', F.id2 === '35.92', F.id2);
  // T last, then Up steps it; OD last, then Right steps it
  const RT2 = await onTube(page, F.zEnd + F.g.hT, F.g.Rlen, 'side'), RO2 = await onTube(page, F.zEnd + F.g.hO, F.g.rO, 'side');
  await page.mouse.move(RT2.x, RT2.y); await page.mouse.move(RO2.x, RO2.y); await page.mouse.move(5, 5);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  F = await red(page);
  check('after hovering the T ring then the OD ring: Up is the Transition (17.1), Right the New Ø (39.52)', RT2.hit === 't' && RO2.hit === 'od' && F.trans === '17.1' && F.od2 === '39.52' && F.run === '18.5',
    F.trans + ' / ' + F.od2);
  // Shift: tenths
  const RQ0 = await onTube(page, F.zEnd + F.g.hO, F.g.rO, 'side'), RQ1 = await onTube(page, F.zEnd + F.g.hO, F.g.rO + 1.17, 'side');
  await page.keyboard.down('Shift');
  await drag(page, RQ0, RQ1);
  await page.keyboard.up('Shift');
  F = await red(page);
  check('with Shift, 0.1 mm steps: the OD ring 1.17 mm out is New Ø +2.3 (41.82)', RQ0.hit === 'od' && F.od2 === '41.82', F.od2);
  // Escape mid-drag puts it back
  const RE0 = await onTube(page, F.zEnd + F.g.hT, F.g.Rlen, 'side'), RE1 = await onTube(page, F.zEnd + F.g.hT + 3, F.g.Rlen, 'side');
  await page.mouse.move(RE0.x, RE0.y);
  await page.mouse.down();
  await page.mouse.move(RE1.x, RE1.y, { steps: 8 });
  F = await red(page);
  check('mid-drag: Transition 20.1, its measure up, the orbit off', RE0.hit === 't' && F.drag && F.trans === '20.1' && F.callout === '20.1 mm' && !F.controls, F.trans + ' · ' + F.callout);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  F = await red(page);
  check('Escape: the drag put back (Transition 17.1), the measure gone, the card open, the orbit on', !F.drag && F.open && F.trans === '17.1' && F.callout === null && F.dim === null && F.controls && F.ghost, F.trans);
  // with Run 0 there is no R ring: Shift + the T ring pulls a run out of it
  await setField(page, 'inp-te-run', '0');
  F = await red(page);
  check('Run 0: no R ring', F.rings.join() === 'od,id,t', F.rings.join());
  const RP0 = await onTube(page, F.zEnd + F.g.hT, F.g.Rlen, 'side'), RP1 = await onTube(page, F.zEnd + F.g.hT + 5, F.g.Rlen, 'side');
  await page.keyboard.down('Shift');
  await page.mouse.move(RP0.x, RP0.y);
  await page.mouse.down();
  await page.mouse.move(RP1.x, RP1.y, { steps: 12 });
  F = await red(page);
  check('Shift + a press on the T ring: an R drag from the T plane - mid-drag "5.0 mm" from 17.1 to 22.1, the R ring in hand', RP0.hit === 't' && F.callout === '5.0 mm' && F.dim && F.dim.h === 'r' &&
    near(F.dim.from, 17.1, 1e-6) && near(F.dim.to, 22.1, 1e-6) && F.rings.includes('r'), F.callout + ' · ' + JSON.stringify(F.dim));
  await page.mouse.up();
  await page.keyboard.up('Shift');
  F = await red(page);
  check('...released: Run 5.0, the Transition kept (17.1)', F.run === '5.0' && F.trans === '17.1' && F.rings.join() === 'od,id,t,r', F.run + ' / ' + F.trans);
  // Set, one Undo
  const RExpectR = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Tube edge done|Tube edge refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const RStR = await statusOf(page);
  check('Set: "Tube edge done - Reducer: Ø43.52 / bore Ø34.82 → Ø41.82 / bore Ø35.92 over 17.1 mm …, then 5.0 mm run", the piece is the ghost\'s soup',
    /Tube edge done - Reducer: Ø43\.52 \/ bore Ø34\.82 → Ø41\.82 \/ bore Ø35\.92 over 17\.1 mm .*, then 5\.0 mm run/.test(RStR) && (await soupOf(page)) === RExpectR, RStR);
  await frame(page, 15, 160);
  await shot(page, 'reducer-set.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: /.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo puts the tube back, bit for bit', (await soupOf(page)) === RRedBefore);

  console.log('\n=== 9. the ID ring alone: bore only on a Ø40.62 / Ø30.47 pipe - 3 mm out is the bore Ø +6, the outside unchanged ===');
  const RPipeId = await loadSTL(page, writeSTL('pipe.stl', stockTube(20.31, 5.076, 30)));
  await selectModel(page, RPipeId);
  const RPipeBefore = await soupOf(page);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  await page.evaluate(() => { state.tubeEdge.point = [0, 18, 29.5]; NSO_teLoad(); });
  F = await red(page);
  check('a new tube: the Ø fields default again to its own + 4 (44.62 / 34.47)', F.od2 === '44.62' && F.id2 === '34.47', F.od2 + ' / ' + F.id2);
  await setField(page, 'inp-te-od2', '40.62');
  await setField(page, 'inp-te-id2', '30.468');
  await setField(page, 'inp-te-trans', '10');
  await setField(page, 'inp-te-run', '0');
  await frame(page, 15, 150);
  F = await red(page);
  check('the tube\'s own Ø over 10: a straight tube on, the ID ring on the bore (r 15.234) 10 mm out', near(F.g.rI, 15.234, 1e-3) && near(F.zEnd + F.g.hI, 40, 1e-6) && /^Straight on: /.test(F.readout), F.readout);
  const RB0 = await onTube(page, 40, F.g.rI, 'side'), RB1 = await onTube(page, 40, F.g.rI + 3, 'side');
  await drag(page, RB0, RB1);
  F = await red(page);
  console.log('   readout: ' + F.readout);
  check('3 mm out: New bore 36.47, New Ø 40.62', RB0.hit === 'id' && F.id2 === '36.47' && F.od2 === '40.62', F.id2 + ' / ' + F.od2);
  check('the ghost\'s bore Ø36.47 ± 0.01 at the transition\'s end, its outside Ø40.62 everywhere (unchanged)', F.ghost && near(F.tEnd.lo * 2, 36.47, 0.01) && near(F.maxDia, 40.62, 1e-3),
    (2 * F.tEnd.lo).toFixed(3) + ' / ' + F.maxDia);
  check('...the readout: "Expander (bore only): Ø40.62 / bore Ø30.47 → Ø40.62 / bore Ø36.47 over 10.0 mm (0.0° outside, 16.7° bore) · wall 5.08 → 2.0…"',
    /^Expander \(bore only\): Ø40\.62 \/ bore Ø30\.47 → Ø40\.62 \/ bore Ø36\.47 over 10\.0 mm \(0\.0° outside, 16\.7° bore\) · wall 5\.08 → 2\.0[78]/.test(F.readout), F.readout);
  const RExpectF = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Tube edge done|Tube edge refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const RStF = await statusOf(page);
  check('Set: "Tube edge done - Expander (bore only): …", the piece is the ghost\'s soup', /Tube edge done - Expander \(bore only\): Ø40\.62/.test(RStF) && (await soupOf(page)) === RExpectF, RStF);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: /.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo puts the pipe back, bit for bit', (await soupOf(page)) === RPipeBefore);

  console.log('\n=== 10. Neck with Bore only: its rings on the bore ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'neck');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'neck' && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-walls', 'bore');
  await setField(page, 'inp-te-neck-dr', '2');
  N = await page.evaluate(() => { const g = NSO_teNeckGeom(); return { Rf: g.Rf, Rw: g.Rw, text: NSO_teHandleText('waist'), readout: document.getElementById('te-readout').textContent }; });
  check('the rings sit on the bore (r 15.234) and the waist at the bore + Δr, named "Bore"', near(N.Rf, 15.234, 1e-3) && near(N.Rw, 17.234, 1e-3) && /^Bore Δr \+2\.0 mm$/.test(N.text) &&
        /^Bore only: Ø30\.47 → Ø34\.47/.test(N.readout), N.Rf + ' / ' + N.Rw + ' · ' + N.text + ' · ' + N.readout);
  await page.click('#btn-te-cancel');

  console.log('\n=== 11. the Reducer\'s rows are its own: Roll shows Way and hides them, Neck shows Walls; the Reducer shows them again ===');
  await selectModel(page, tubeId);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'reducer');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'end' && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  const tubeBefore11 = await soupOf(page);
  await setField(page, 'inp-te-run', '30');
  const rows = () => page.evaluate(() => ['te-reducer-rows', 'te-dir-row', 'te-walls-row'].map(id => !document.getElementById(id).hidden));
  F = await red(page);
  check('Reducer: its rows (Run 30 among them, the R ring up), no Way, no Walls', (await rows()).join() === 'true,false,false' && F.rings.includes('r'), (await rows()).join());
  await setField(page, 'sel-te-verb', 'roll');
  F = await red(page);
  check('Roll: Way, not the Reducer\'s rows; no Reducer rings; it rolls (no refusal)', (await rows()).join() === 'false,true,false' && !F.rings.length && !F.bad && /^Roll /.test(F.readout), F.readout);
  await setField(page, 'sel-te-verb', 'neck');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'neck' && state.tubeEdge.result, null, { timeout: 30000 });
  check('Neck: Walls, not the Reducer\'s rows', (await rows()).join() === 'false,false,true');
  await setField(page, 'sel-te-verb', 'reducer');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'end' && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  F = await red(page);
  check('the Reducer again, its Run 30 and its R ring', (await rows()).join() === 'true,false,false' && F.run === '30' && F.rings.join() === 'od,id,t,r', F.run + ' · ' + F.rings.join());
  await page.click('#btn-te-cancel');
  check('Cancel: the piece unchanged', (await soupOf(page)) === tubeBefore11);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
