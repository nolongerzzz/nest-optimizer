#!/usr/bin/env node
/* Shape → Cylinders, driven through the real app: real index.html, real
   script tags, real clicks and drags. The geometry is proved headless in
   tools/nso_tube_neck_test.js (section 11, Cylinders → Neck); this proves the
   card on it.
     node tools/nso_cylinders_neck_check.js                     exit 0 = every gate held
     CYL_NECK_SHOTS=dir node tools/nso_cylinders_neck_check.js  ...and screenshots

   On Stock's Ø30.84 × 60 cylinder (the one in the bug report: Tube edge →
   Neck refused it, "the end is closed - a flat Ø30.84 face with no opening"):
     - Cylinders sits in the Shape card and opens the Tube edge card in its rod
       mode: the heading in place of Verb, no Walls row, Neck's rows;
     - defaults Length 23, Δr −4, centred at the middle; three rings, a ghost
       whose waist is Ø22.84;
     - a press on the rod that does not travel centres the band there; the waist ring dragged
       toward the axis is a deeper pinch, read back off the field and the
       ghost;
     - Tube edge's button takes the card over (Verb back, the rod refused
       there with a pointer to Cylinders), and Cylinders takes it back, the
       rod's numbers kept;
     - Set commits the ghost (status "Cylinder neck done"), one Undo puts the
       rod back bit for bit;
     - a tube is refused by Cylinders, pointed at Tube edge.
   And BRANCH (nso_rod_branch.js), on a Ø20 × 80 rod:
     - the Cylinder picker switches to Branch: its rows, Neck's hidden;
     - a press on the rod's side and a drag outward pulls a branch: the
       Length and Angle fields follow the pointer and the ghost is the branch,
       its tip where the fields say (read back off the ghost's vertices);
     - the camera does not move during the drag;
     - Set welds it on ("Branch done"), the card stays up for the next one;
       a second branch is pressed and Set; two Undos put the rod back bit
       for bit. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, openFinishMenu } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.CYL_NECK_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-cyl-neck-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const NSO_Stock = require('../nso_stock.js');
const R = 15.42, H = 60;
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);
const soupOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris).join(','));
async function setField(page, id, value) {
  await page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, value]);
}
// The card as the page has it; the rod's axis is raw +Z through x = y = 0,
// read off its top end (z 60), so the band's centre is at z 60 + h0.
const card = page => page.evaluate(() => {
  const B = state.tubeEdge, el = id => document.getElementById(id), g = NSO_teNeckGeom();
  let waistDia = null;
  if (B.ghost && g) {
    const o = getActiveModel().centerOffset, P = B.ghost.geometry.attributes.position.array, zw = 60 + g.h0;
    let hi = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const X = P[i] + o.x, Y = -(P[i + 2] + o.z), Z = P[i + 1] + o.y;
      if (Math.abs(Z - zw) < 2e-3) hi = Math.max(hi, Math.hypot(X, Y));
    }
    waistDia = isFinite(hi) ? 2 * hi : null;
  }
  const vis = id => { const e = el(id); return !!e && !e.hidden && e.offsetParent !== null; };
  return {
    open: !!B.open, rod: !!B.rod, length: el('inp-te-neck-length').value, dr: el('inp-te-neck-dr').value,
    readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
    ghost: !!(B.ghost && B.ghost.parent), waistDia, h0: g ? g.h0 : null,
    rings: B.ring ? B.ring.children.map(c => c.userData.teHandle) : [],
    head: vis('te-rod-head'), verbRow: vis('te-verb-row'), wallsRow: vis('te-walls-row'), neckRows: vis('te-neck-rows'),
    cylOn: el('btn-cylinders').getAttribute('aria-expanded') === 'true', teOn: el('btn-tube-edge').getAttribute('aria-expanded') === 'true',
    controls: state.controls.enabled, drag: !!B.drag
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
// A point on the rod's surface of revolution at height z and radius r, edge-on ('side') or nearest the camera ('front').
const onRod = (page, z, r, where) => page.evaluate(([z, r, where]) => {
  const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh, o = m.centerOffset;
  mesh.updateMatrixWorld(true);
  const cam = state.camera.position.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  const cx = cam.x + o.x, cy = -(cam.z + o.z), L = Math.hypot(cx, cy), ux = cx / L, uy = cy / L;
  const dir = where === 'front' ? [ux, uy] : [-uy, ux];
  const local = new THREE.Vector3(r * dir[0] - o.x, z - o.y, -(r * dir[1]) - o.z);
  const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera);
  const rc = state.renderer.domElement.getBoundingClientRect();
  const x = rc.left + (w.x + 1) / 2 * rc.width, y = rc.top + (1 - w.y) / 2 * rc.height;
  return { x, y, onCanvas: document.elementFromPoint(x, y) === state.renderer.domElement, hit: NSO_teNeckHit(x, y) };
}, [z, r, where]);
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

withApp(async (page) => {
  console.log('\n=== 1. Shape → Cylinders on Stock\'s Ø30.84 × 60 cylinder ===');
  const rodId = await loadSTL(page, writeSTL('cylinder.stl', NSO_Stock.revolve(NSO_Stock.profileCylinder(R, H), 96)));
  await selectModel(page, rodId);
  await openFinishMenu(page);
  const before = await soupOf(page);
  check('the Cylinders button is in the Shape card', await page.evaluate(() => !!document.querySelector('#menu-shape #btn-cylinders')));
  await page.click('#btn-cylinders');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open && state.tubeEdge.result, null, { timeout: 30000 });
  await frame(page, 15, 140);
  let C = await card(page);
  console.log('   readout: ' + C.readout);
  check('the card is open in rod mode, Cylinders lit, Tube edge not', C.open && C.rod && C.cylOn && !C.teOn);
  check('rod heading up; no Verb, no Walls; Neck\'s rows', C.head && !C.verbRow && !C.wallsRow && C.neckRows, JSON.stringify({ head: C.head, verb: C.verbRow, walls: C.wallsRow, neck: C.neckRows }));
  check('defaults: Length 23, Δr −4, centred at the middle (h0 −30)', C.length === '23' && C.dr === '-4' && near(C.h0, -30), C.length + ' / ' + C.dr + ' / ' + C.h0);
  check('three rings and a ghost whose waist is Ø22.84', C.rings.join(',') === 'a,b,waist' && C.ghost && near(C.waistDia, 22.84, 0.05), C.rings.join(',') + ' · Ø' + C.waistDia);
  check('the readout: "Rod pinch −4.00 mm: Ø30.84 → Ø22.84 at the waist"', !C.bad && /^Rod pinch −4\.00 mm: Ø30\.84 → Ø22\.84 at the waist, smooth over 23\.0 mm, centred 30\.00 mm in/.test(C.readout), C.readout);
  await shot(page, 'cyl-open.png');

  console.log('\n=== 2. a click places the band; the waist ring drags the pinch ===');
  const click = await onRod(page, 22, R, 'front');
  check('the click point is on the canvas, in the band (z 22), off the rings', click.onCanvas && click.hit === 'band', JSON.stringify(click));
  await page.mouse.click(click.x, click.y);
  C = await card(page);
  check('a press there that does not travel centres the band there (38 mm in)', near(C.h0, -38, 0.05) && /centred 38\.\d\d mm in/.test(C.readout), C.h0 + ' · ' + C.readout);
  await page.evaluate(() => { state.tubeEdge.point = [15.42, 0, 22]; NSO_tePreview(); });
  const w0 = await onRod(page, 22, R - 4, 'side'), w1 = await onRod(page, 22, R - 7, 'side');
  check('the waist ring, edge-on at the side, is the handle there', w0.hit === 'waist', JSON.stringify(w0));
  await drag(page, w0, w1);
  C = await card(page);
  console.log('   readout: ' + C.readout);
  check('3 mm toward the axis: Δr −7.0, the ghost\'s waist Ø16.84', C.dr === '-7.0' && near(C.waistDia, 16.84, 0.05), C.dr + ' · Ø' + C.waistDia);
  check('the drag over, OrbitControls on again', !C.drag && C.controls);
  await shot(page, 'cyl-drag.png');

  console.log('\n=== 3. Tube edge takes the card over, Cylinders takes it back ===');
  await page.click('#btn-tube-edge');
  C = await card(page);
  check('Tube edge: Verb back, rod heading gone, Tube edge lit', C.open && !C.rod && C.verbRow && !C.head && C.teOn && !C.cylOn);
  await setField(page, 'sel-te-verb', 'neck');
  C = await card(page);
  check('...its Neck refuses the rod and points at Cylinders', C.bad && /a solid rod or cylinder is necked from Shape → Cylinders/.test(C.readout), C.readout);
  await page.click('#btn-cylinders');
  await page.waitForFunction(() => state.tubeEdge.rod && state.tubeEdge.result, null, { timeout: 30000 });
  C = await card(page);
  check('Cylinders again: rod mode, the rod\'s own numbers kept (Tube edge never read it), the band back at the middle, a ghost',
        C.rod && C.length === '23' && C.dr === '-7.0' && near(C.h0, -30) && C.ghost && !C.bad, C.length + ' / ' + C.dr + ' · ' + C.readout);

  console.log('\n=== 4. Set, then one Undo ===');
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Cylinder neck done/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  C = await card(page);
  const status = await page.evaluate(() => document.getElementById('status').textContent);
  check('Set: "Cylinder neck done - Rod pinch ...", the card shut, Cylinders unlit', /^Cylinder neck done - Rod pinch −7\.00 mm/.test(status) && !C.open && !C.cylOn, status);
  const after = await soupOf(page);
  check('the piece changed', after !== before);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: /.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  const undo = await page.evaluate(() => document.getElementById('status').textContent);
  check('one Undo puts the rod back, bit for bit: "Undo: Cylinder neck reverted"', (await soupOf(page)) === before && /Undo: Cylinder neck reverted/.test(undo), undo);

  console.log('\n=== 5. a tube is refused by Cylinders ===');
  const tubeId = await loadSTL(page, writeSTL('tube.stl', NSO_Stock.revolve(NSO_Stock.profileTube(10, 8.4, 40), 96)));
  await selectModel(page, tubeId);
  await page.click('#btn-cylinders');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open, null, { timeout: 30000 });
  C = await card(page);
  check('refused in words, pointed at Tube edge → Neck, no ghost', C.bad && !C.ghost && /^Cylinder neck: .*a tube is necked from Tube edge → Neck/.test(C.readout), C.readout);
  await page.click('#btn-cylinders');
  C = await card(page);
  check('Cylinders again shuts the card', !C.open && !C.cylOn);

  console.log('\n=== 6. Branch: press on the rod, drag out, Set; again; two Undos ===');
  const R2 = 10, H2 = 80;
  const rod2Id = await loadSTL(page, writeSTL('rod2.stl', NSO_Stock.revolve(NSO_Stock.profileCylinder(R2, H2), 96)));
  await selectModel(page, rod2Id);
  const before2 = await soupOf(page);
  await page.click('#btn-cylinders');
  await page.waitForFunction(() => state.tubeEdge && state.tubeEdge.open && state.tubeEdge.rod, null, { timeout: 30000 });
  await setField(page, 'sel-te-rod-verb', 'branch');
  const br = () => page.evaluate(() => {
    const B = state.tubeEdge, el = id => document.getElementById(id), vis = id => { const e = el(id); return !!e && !e.hidden && e.offsetParent !== null; };
    let tip = null;
    if (B.ghost && B.result && B.result.ok) {
      // the ghost back to raw, its farthest vertices along the branch: the tip's centre
      const o = getActiveModel().centerOffset, P = B.ghost.geometry.attributes.position.array, b = B.result.branch, d = b.dir, S = b.wall;
      let far = -Infinity; const pts = [];
      for (let i = 0; i < P.length; i += 3) {
        const X = P[i] + o.x, Y = -(P[i + 2] + o.z), Z = P[i + 1] + o.y, s = (X - S[0]) * d[0] + (Y - S[1]) * d[1] + (Z - S[2]) * d[2];
        pts.push([X, Y, Z, s]); if (s > far) far = s;
      }
      const t = pts.filter(q => q[3] > far - 1e-3), c = [0, 1, 2].map(k => t.reduce((a, q) => a + q[k], 0) / t.length);
      tip = { far, c, angle: Math.acos(((c[2] - S[2])) / Math.hypot(c[0] - S[0], c[1] - S[1], c[2] - S[2])) * 180 / Math.PI };
    }
    return { open: !!B.open, verb: NSO_teVerb(), branchRows: vis('te-branch-rows'), neckRows: vis('te-neck-rows'),
             dia: el('inp-te-br-dia').value, len: el('inp-te-br-len').value, angle: el('inp-te-br-angle').value,
             readout: el('te-readout').textContent, bad: el('te-readout').classList.contains('is-bad'),
             ghost: !!(B.ghost && B.ghost.parent), tip, busy: !!B.busy, go: !el('btn-te-go').disabled, point: B.point, controls: state.controls.enabled };
  });
  let Bc = await br();
  check('Branch: its rows up, Neck\'s hidden, no ghost before a press', Bc.verb === 'branch' && Bc.branchRows && !Bc.neckRows && !Bc.ghost && /^Press on the side of the rod/.test(Bc.readout),
        JSON.stringify({ rows: Bc.branchRows, neck: Bc.neckRows, ghost: Bc.ghost, r: Bc.readout }));
  check('defaults off the Ø20 rod: Ø6.5 (a third), Length 30, Angle 45', Bc.dia === '6.5' && Bc.len === '30' && Bc.angle === '45', Bc.dia + ' / ' + Bc.len + ' / ' + Bc.angle);
  await frame(page, 10, 150);
  const camOf = () => page.evaluate(() => [...state.camera.position.toArray(), ...state.controls.target.toArray()].map(v => +v.toFixed(6)).join(','));
  const cam0 = await camOf();
  // the press: the rod's wall at z 30, turned 40° from the silhouette toward the camera (a clean hit,
  // not a graze); the drag: to the point 20 mm out and 20 mm up from the root the page read there
  const p0 = await page.evaluate(([R2]) => {
    const m = getActiveModel(), pl = state.placed.find(q => q.sourceId === m.id), mesh = pl.mesh, o = m.centerOffset;
    const cam = state.camera.position.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    const cx = cam.x + o.x, cy = -(cam.z + o.z), L = Math.hypot(cx, cy), f = [cx / L, cy / L], sd = [-cy / L, cx / L];
    const c = Math.cos(50 * Math.PI / 180), sn = Math.sin(50 * Math.PI / 180), dir = [c * sd[0] + sn * f[0], c * sd[1] + sn * f[1]];
    const local = new THREE.Vector3(R2 * dir[0] - o.x, 30 - o.y, -(R2 * dir[1]) - o.z);
    const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera), rc = state.renderer.domElement.getBoundingClientRect();
    return { x: rc.left + (w.x + 1) / 2 * rc.width, y: rc.top + (1 - w.y) / 2 * rc.height };
  }, [R2]);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  const p1 = await page.evaluate(() => {
    const D = state.tubeEdge.bdrag, m = getActiveModel();
    const T = [0, 1, 2].map(k => D.S[k] + 20 * D.e[k] + 20 * D.a[k]);
    return Object.assign(NSO_teScreen(m, T), { S: D.S });
  });
  await page.mouse.move(p1.x, p1.y, { steps: 16 });
  const mid = await br();
  await page.mouse.up();
  Bc = await br();
  console.log('   readout: ' + Bc.readout);
  check('mid-drag: OrbitControls off, the ghost following', !mid.controls && mid.ghost, JSON.stringify({ controls: mid.controls, ghost: mid.ghost }));
  check('the drag 20 out and 20 up: Length 28.5 (20√2, to 0.5), Angle 45', Bc.len === '28.5' && Bc.angle === '45', Bc.len + ' / ' + Bc.angle);
  check('the ghost is the branch, its tip 28.5 mm out at 45° (± 0.05)', Bc.ghost && Bc.tip && Math.abs(Bc.tip.far - 28.5) < 0.05 && Math.abs(Bc.tip.angle - 45) < 0.05,
        Bc.tip && (Bc.tip.far.toFixed(3) + ' mm, ' + Bc.tip.angle.toFixed(3) + '°'));
  check('the readout names it: "Branch Ø6.50, 28.5 mm out at 45° off a Ø20.00 rod"', !Bc.bad && /^Branch Ø6\.50, 28\.5 mm out at 45° off a Ø20\.00 rod, 50\.\d\d mm in from its end · Set welds it on/.test(Bc.readout), Bc.readout);
  check('the camera did not move; OrbitControls on again', (await camOf()) === cam0 && Bc.controls);
  await shot(page, 'branch-drag.png');
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Branch done/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await page.evaluate(() => document.getElementById('status').textContent);
  Bc = await br();
  check('Set: "Branch done - Branch Ø6.50, 28.5 mm out ...", the card still up for the next, its root cleared', /^Branch done - Branch Ø6\.50, 28\.5 mm out at 45°/.test(st) && Bc.open && !Bc.point && !Bc.ghost, st);
  const after1 = await soupOf(page);
  check('the piece changed', after1 !== before2);
  await shot(page, 'branch-set.png');
  // a second branch, a click on the far side lower down (no drag: the fields' Length and Angle)
  const q0 = await page.evaluate(([R2]) => {
    const m = getActiveModel(), pl = state.placed.find(q => q.sourceId === m.id), mesh = pl.mesh, o = m.centerOffset;
    const cam = state.camera.position.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    const cx = cam.x + o.x, cy = -(cam.z + o.z), L = Math.hypot(cx, cy), dir = [cx / L, cy / L];
    const local = new THREE.Vector3(R2 * dir[0] - o.x, 15 - o.y, -(R2 * dir[1]) - o.z);
    const w = local.applyMatrix4(mesh.matrixWorld).project(state.camera), rc = state.renderer.domElement.getBoundingClientRect();
    return { x: rc.left + (w.x + 1) / 2 * rc.width, y: rc.top + (1 - w.y) / 2 * rc.height };
  }, [R2]);
  await setField(page, 'inp-te-br-angle', '70');
  await setField(page, 'inp-te-br-len', '15');
  await page.mouse.click(q0.x, q0.y);
  Bc = await br();
  check('a click on the rod (facing the camera, z 15) roots the next branch there: the ghost up', Bc.ghost && /15\.0 mm out at 70° off a Ø20\.00 rod, 65\.\d\d mm in/.test(Bc.readout), Bc.readout);
  await page.click('#btn-te-go');
  await page.waitForFunction(() => /Branch done/.test(document.getElementById('status').textContent) && getActiveModel().rawTris.length !== 0 && !state.tubeEdge.busy, null, { timeout: 30000 });
  const after2 = await soupOf(page);
  check('the second Set welds it on', after2 !== after1);
  await shot(page, 'branch-two.png');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Branch reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('one Undo takes the second branch off', (await soupOf(page)) === after1);
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Branch reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('a second Undo puts the bare rod back, bit for bit', (await soupOf(page)) === before2);

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  if (fails) process.exitCode = 1;
});
