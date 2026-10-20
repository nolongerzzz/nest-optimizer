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
   And FLARE's lip ring (tube-end-drag):
     - the lip ring dragged 4 mm toward the axis reads Δr −4.0 (the flare
       turned in), the ghost's lip bore Ø 8 under the tube's;
     - dragged 6 mm along the axis, the Length 6 longer, the ghost's lip there;
     - the arrows (Left / Right Δr, Up / Down the Length), Escape mid-drag;
     - Walls Bore only: the ring sits on the bore, hover says "Bore", and
       3 mm out is the bore Ø +6 at the lip with the outside unchanged (a
       Ø40.62 / Ø30.47 pipe, wall 5.08); Set commits it, one Undo.
     - Neck with Bore only: its rings sit on the bore.
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
// Flare and its lip ring as the page has them. The tube's axis is raw +Z
// through x = y = 0; the top end is read, so the lip is at z = 40 + h0.
const flare = page => page.evaluate(() => {
  const B = state.tubeEdge, el = id => document.getElementById(id), g = NSO_teFlareGeom(), cv = state.renderer.domElement;
  let lipBoreDia = null, ghostTop = null, maxDia = null;
  if (B.ghost) {
    const o = getActiveModel().centerOffset, P = B.ghost.geometry.attributes.position.array;
    let top = -Infinity, hi = -Infinity;
    for (let i = 0; i < P.length; i += 3) { const Z = P[i + 1] + o.y; top = Math.max(top, Z); hi = Math.max(hi, Math.hypot(P[i] + o.x, P[i + 2] + o.z)); }
    let lo = Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const X = P[i] + o.x, Y = -(P[i + 2] + o.z), Z = P[i + 1] + o.y;
      if (Math.abs(Z - top) < 2e-3) lo = Math.min(lo, Math.hypot(X, Y));
    }
    ghostTop = top; lipBoreDia = isFinite(lo) ? 2 * lo : null; maxDia = 2 * hi;
  }
  const zEnd = B.read && B.read.end ? B.read.end.center[2] : 0;
  return {
    open: !!B.open, length: el('inp-te-length').value, dr: el('inp-te-dr').value, dir: el('sel-te-dir').value,
    readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
    ghost: !!(B.ghost && B.ghost.parent), lipBoreDia, ghostTop, maxDia,
    rings: B.ring ? B.ring.children.map(c => c.userData.teHandle).filter(Boolean) : [],
    hot: B.ring ? B.ring.children.filter(c => c.userData.teHandle && c.material.color.getHex() === 0xffffff).map(c => c.userData.teHandle) : [],
    lipR: g ? g.Rl : null, lipZ: g ? zEnd + g.h0 : null, drag: !!B.drag,
    cursor: Array.from(cv.classList).filter(c => /^te-cur-/.test(c)), controls: state.controls.enabled
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

  console.log('\n=== 8. Flare: the lip ring - 4 mm in is Δr −4, 6 mm along is Length +6 ===');
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'flare');
  await page.waitForFunction(() => state.tubeEdge.readVerb === 'end' && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  await page.evaluate(() => { state.tubeEdge.point = [0, 9, 39.5]; NSO_teLoad(); });      // the top end
  await setField(page, 'inp-te-dr', '0');
  await frame(page, 15, 140);            // wide enough for a lip up to 15 mm past the end
  let F = await flare(page);
  check('Flare on the top end: the lip ring is up, on the wall\'s mid-line, 6 mm out (Length 6, Δr 0 - refused, the ring still a handle)',
    F.rings.includes('lip') && near(F.lipR, 9.2, 1e-6) && near(F.lipZ, 46, 1e-6) && F.bad && /a 0° flare is no flare/.test(F.readout) && !F.ghost,
    F.rings.join(',') + ' r ' + F.lipR + ' z ' + F.lipZ + ' · ' + F.readout);
  const l0 = await onTube(page, 46, 9.2, 'side'), l1 = await onTube(page, 46, 5.2, 'side');
  check('the lip ring, edge-on at the side, is the handle there', l0.hit === 'lip' && l0.onCanvas, JSON.stringify(l0));
  await page.mouse.move(l0.x, l0.y);
  F = await flare(page);
  check('hover: "Wall Δr 0.0 mm, Length 6.0 mm", lit, a hand', /^Wall Δr 0\.0 mm, Length 6\.0 mm · /.test(F.readout) && F.hot.join() === 'lip' && F.cursor.join() === 'te-cur-grab',
    F.readout + ' · ' + F.cursor.join());
  cam0 = await camera(page);
  await drag(page, l0, l1);
  F = await flare(page);
  console.log('   readout: ' + F.readout);
  check('4 mm toward the axis: the Δr field reads −4.0, the Length 6, Way Out (the sign is Δr\'s)', F.dr === '-4.0' && F.length === '6.0' && F.dir === 'out', F.dr + ' / ' + F.length + ' / ' + F.dir);
  check('the ghost is up and its lip bore is Ø8.80 ± 0.05 - Ø 8 under the tube\'s Ø16.80', F.ghost && F.lipBoreDia != null && near(F.lipBoreDia, 8.8, 0.05), F.lipBoreDia && F.lipBoreDia.toFixed(3));
  check('...the readout says the same: inward, lip bore Ø8.80', /Δr −4\.00 mm\), inward: lip bore Ø8\.80/.test(F.readout), F.readout);
  check('the drag did not move the camera; OrbitControls on again', (await camera(page)) === cam0 && F.controls && !F.drag);
  const m0 = await onTube(page, 46, F.lipR, 'side'), m1 = await onTube(page, 52, F.lipR, 'side');
  check('the lip ring has followed (r ' + F.lipR.toFixed(2) + '), still the handle', m0.hit === 'lip' && m1.onCanvas, JSON.stringify(m0));
  await drag(page, m0, m1);
  F = await flare(page);
  console.log('   readout: ' + F.readout);
  check('6 mm along the axis: Length 6 → 12.0, Δr held at −4.0', F.length === '12.0' && F.dr === '-4.0', F.length + ' / ' + F.dr);
  check('...the ghost\'s lip 12 mm out (z 52), its bore Ø8.80 there', F.ghost && near(F.ghostTop, 52, 1e-3) && near(F.lipBoreDia, 8.8, 0.05) && /Straight flare 12\.0 mm/.test(F.readout),
    F.ghostTop + ' · ' + F.lipBoreDia);
  // Shift: tenths, both ways at once
  const f0 = await onTube(page, 52, F.lipR, 'side'), f1 = await onTube(page, 52.27, F.lipR + 1.23, 'side');
  check('...and at 12 mm out it is the handle on the canvas', f0.hit === 'lip' && f0.onCanvas, JSON.stringify(f0));
  await page.keyboard.down('Shift');
  await drag(page, f0, f1);
  await page.keyboard.up('Shift');
  F = await flare(page);
  check('with Shift, 0.1 mm steps: Δr −2.8, Length 12.3', F.dr === '-2.8' && F.length === '12.3', F.dr + ' / ' + F.length);
  await setField(page, 'inp-te-length', '12');
  await setField(page, 'inp-te-dr', '-4');
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('ArrowRight');
  F = await flare(page);
  check('Right: Δr 1 mm out (−3.0), the hover text in front', F.dr === '-3.0' && /^Wall Δr −3\.0 mm, Length 12\.0 mm/.test(F.readout), F.dr + ' · ' + F.readout);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  F = await flare(page);
  check('Up, Shift+Up: the Length 1.1 mm longer (13.1)', F.length === '13.1', F.length);
  await page.keyboard.press('ArrowLeft');
  F = await flare(page);
  check('Left: Δr −4.0 again, the ghost following', F.dr === '-4.0' && F.ghost && /Straight flare 13\.1 mm/.test(F.readout), F.readout);
  const e8a = await onTube(page, F.lipZ, F.lipR, 'side'), e8b = await onTube(page, F.lipZ, F.lipR - 2, 'side');
  await page.mouse.move(e8a.x, e8a.y);
  await page.mouse.down();
  await page.mouse.move(e8b.x, e8b.y, { steps: 8 });
  F = await flare(page);
  check('mid-drag: Δr −6.0, the orbit off', e8a.hit === 'lip' && F.drag && F.dr === '-6.0' && !F.controls, F.dr);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  F = await flare(page);
  check('Escape: the drag put back (Δr −4.0, Length 13.1), the card open, the orbit on', !F.drag && F.open && F.dr === '-4.0' && F.length === '13.1' && F.controls && F.ghost, F.dr + ' / ' + F.length);
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  F = await flare(page);
  check('Escape again shuts the card, the piece unchanged', !F.open && !F.ghost && (await soupOf(page)) === before);

  console.log('\n=== 9. Walls = Bore only: the ring on the bore; 3 mm out is the bore Ø +6, the outside unchanged ===');
  const pipeId = await loadSTL(page, writeSTL('pipe.stl', stockTube(20.31, 5.076, 30)));
  await selectModel(page, pipeId);
  const pipeBefore = await soupOf(page);
  await page.click('#btn-tube-edge');
  await page.waitForFunction(() => state.tubeEdge.open && state.tubeEdge.read && state.tubeEdge.read.ok, null, { timeout: 30000 });
  await setField(page, 'sel-te-verb', 'flare');
  check('the Walls row shows for Flare', await page.evaluate(() => !document.getElementById('te-walls-row').hidden));
  await setField(page, 'sel-te-walls', 'bore');
  await setField(page, 'inp-te-length', '10');
  await setField(page, 'inp-te-dr', '0');
  await page.evaluate(() => { state.tubeEdge.point = [0, 18, 29.5]; NSO_teLoad(); });
  await frame(page, 15, 150);
  F = await flare(page);
  check('Bore only: the lip ring sits on the bore (r 15.234), 10 mm out', near(F.lipR, 15.234, 1e-3) && near(F.lipZ, 40, 1e-6) && F.rings.includes('lip'), F.lipR + ' / ' + F.lipZ);
  const p0 = await onTube(page, 40, 15.234, 'side'), p1 = await onTube(page, 40, 18.234, 'side');
  await page.mouse.move(p0.x, p0.y);
  F = await flare(page);
  check('hover names the face it moves: "Bore Δr 0.0 mm, Length 10.0 mm"', p0.hit === 'lip' && /^Bore Δr 0\.0 mm, Length 10\.0 mm · /.test(F.readout), F.readout);
  await drag(page, p0, p1);
  F = await flare(page);
  console.log('   readout: ' + F.readout);
  check('3 mm out: Δr +3.0', F.dr === '3.0', F.dr);
  check('the ghost\'s lip bore is Ø36.47 ± 0.05 - the bore Ø +6 - and its outside Ø40.62 everywhere (unchanged)',
    F.ghost && near(F.lipBoreDia, 36.468, 0.05) && near(F.maxDia, 40.62, 1e-3), F.lipBoreDia + ' / ' + F.maxDia);
  check('...the readout names the walls: "Bore only: Ø30.47 → Ø36.47 at the lip, outside kept Ø40.62, wall 5.08 → 2.08"',
    /^Bore only: Ø30\.47 → Ø36\.47 at the lip, outside kept Ø40\.62, wall 5\.08 → 2\.08/.test(F.readout), F.readout);
  const expectF = await page.evaluate(() => Array.from(state.tubeEdge.result.tris).join(','));
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Tube edge done|Tube edge refused/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const stF = await statusOf(page);
  check('Set: "Tube edge done - Bore only: …", the piece is the ghost\'s soup', /Tube edge done - Bore only: Ø30\.47 → Ø36\.47/.test(stF) && (await soupOf(page)) === expectF, stF);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: /.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo puts the pipe back, bit for bit', (await soupOf(page)) === pipeBefore);

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

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
