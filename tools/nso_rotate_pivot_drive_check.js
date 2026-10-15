#!/usr/bin/env node
/* Rotate - one ring size, and a fixed pivot while turning: the ticket's
   drive-check, in the real app, with screenshots.

   node tools/nso_rotate_pivot_drive_check.js [outDir]     exit 0 = every step held

   Real mouse drags and clicks on the real arrowheads, the camera never moved
   while a turn is in hand. Screenshots go to outDir (default tools/rotate-pivot-out,
   git-ignored).

   The long piece is library/tape_on-edge-single.stl - 185 x 34 x 20.9 mm,
   longer than the 80 mm rings and the A1 Mini's 180 mm bed. (The fixtures/
   copy with the longer name is an 83.8 mm cut of it.) The other is the
   80 x 40 x 20 box fixture. */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tools', 'rotate-pivot-out'));
fs.mkdirSync(OUT, { recursive: true });
const TAPE = path.join(ROOT, 'library', 'tape_on-edge-single.stl');
const BOX = path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl');
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const shot = async (page, name) => {
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, name + '.png'), clip: { x: 300, y: 60, width: 1100, height: 780 } });
  console.log('   [screenshot] ' + name + '.png');
};

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  const N = page.evaluate.bind(page);
  const helpers = () => N(() => {
    const H = window.__d = {};
    H.p = () => state.placed[state.selectedIndex];
    H.q = () => { const p = H.p(); p.mesh.updateMatrixWorld(true); return p.mesh.quaternion.toArray(); };
    H.angle = (qa, qb) => {
      const a = new THREE.Quaternion().fromArray(qa), b = new THREE.Quaternion().fromArray(qb);
      const d = b.clone().multiply(a.clone().invert());
      return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180 / Math.PI;
    };
    H.cam = () => {
      state.controls.target.set(0, 20, 0);
      state.camera.position.set(170, 190, 250);
      state.controls.update(); state.camera.updateMatrixWorld(true);
      window.nsoRotate.refresh();
    };
    H.group = () => state.scene.getObjectByName('nso-rotate-handles').position.toArray();
    H.lowest = () => { const p = H.p(); p.mesh.updateMatrixWorld(true); return new THREE.Box3().setFromObject(p.mesh).min.y; };
    H.diam = ring => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      const m = g && g.children.find(c => c.userData.nsoRotateRing === ring);
      if (!m) return null;                      // not drawn: Rotate shut, or no piece
      m.updateMatrixWorld(true);
      const pos = m.geometry.attributes.position, v = new THREE.Vector3(), r = state.renderer.domElement.getBoundingClientRect();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(state.camera);
        const x = (v.x * .5 + .5) * r.width, y = (-v.y * .5 + .5) * r.height;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2), mm: m.geometry.parameters.radius };
    };
    /* put the selected piece at the plate's centre, so both pieces' rings are
       measured from the same spot through the same camera */
    H.centre = () => { const p = H.p(); applyPlacedXZ(p, 0, 0); applyMeshRotation(p); window.nsoRotate.refresh(); };
  });

  /* a real drag from an arrowhead round the projected ring centre */
  const dragRing = async (ring, screenDeg, at, keepDown) => {
    const h = await N(r => window.nsoRotate.handleScreen(r, 1), ring);
    const c = await N(() => window.nsoRotate.centreScreen());
    const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    for (let i = 1; i <= Math.abs(screenDeg); i++) {
      const a = a0 + Math.sign(screenDeg) * i * Math.PI / 180;
      await page.mouse.move(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R);
      if (at && at[i]) await at[i]();
    }
    if (!keepDown) { await page.mouse.up(); await page.waitForTimeout(60); }
  };

  await loadSTL(page, BOX);
  await loadSTL(page, TAPE);
  await page.waitForTimeout(300);
  await helpers();
  await N(() => window.__d.cam());
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);

  console.log('\n=== 1. one ring size: the 185 mm tape and the 80 x 40 x 20 box ===');
  const sizes = {};
  for (const [label, idx] of [['box', 0], ['tape', 1]]) {
    await N(i => { selectPlaced(i); }, idx);
    await page.waitForTimeout(150);
    await N(() => window.__d.centre());
    sizes[label] = await N(() => ({ dims: (p => [p.width, p.depth, p.height].map(v => +v.toFixed(1)))(window.__d.p()),
      ring: window.nsoRotate.ringRadius(), px: window.__d.diam('turn'), centre: window.__d.group() }));
    await shot(page, '01-' + label + '-turn-ring');
    await N(i => { const p = state.placed[i]; applyPlacedXZ(p, i ? 45 : -45, i ? 30 : -30); applyMeshRotation(p); }, idx);
  }
  console.log('   ' + JSON.stringify(sizes));
  check('both get the same ring: the fixed 40 mm',
    sizes.box.ring === 40 && sizes.tape.ring === 40 && sizes.box.px.mm === 40 && sizes.tape.px.mm === 40);
  check('...measured on screen from the same spot and camera: the same diameter to a pixel',
    Math.abs(sizes.box.px.w - sizes.tape.px.w) < 1 && Math.abs(sizes.box.px.h - sizes.tape.px.h) < 1,
    'box ' + sizes.box.px.w + ' x ' + sizes.box.px.h + ' px, tape ' + sizes.tape.px.w + ' x ' + sizes.tape.px.h +
    ' px (centres at y ' + sizes.box.centre[1].toFixed(2) + ' / ' + sizes.tape.centre[1].toFixed(2) + ' mm)');
  check('the tape is longer than the rings, which is fine: they are 80 mm across', sizes.tape.dims[0] > 80,
    sizes.tape.dims.join(' x ') + ' mm');

  console.log('\n=== 2. drag side/side 0 -> 90 -> 180 on the tape, camera still ===');
  await N(() => { selectPlaced(1); });
  await page.waitForTimeout(100);
  await N(() => { const p = window.__d.p(); applyPlacedXZ(p, 0, 0); applyMeshRotation(p); window.nsoRotate.refresh(); });
  await page.click('#chk-rot-ring-ss');
  await page.waitForTimeout(100);
  /* settle: a fresh drop rests 0.1 mm above the pose baseline (the known
     ingest seat); one key there and back puts it on the baseline first */
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(800);
  const startCam = await N(() => state.camera.position.toArray().concat(state.controls.target.toArray()));
  await shot(page, '02-tape-at-rest-ss-ring');
  const q0 = await N(() => window.__d.q());
  const frames = {};
  const record = async (label) => {
    frames[label] = await N(() => ({ screen: window.nsoRotate.centreScreen(), group: window.__d.group(),
      pivot: window.nsoRotate.pivot(), lowest: window.__d.lowest(), turned: window.nsoRotate.dragState().applied }));
  };
  const sgn = await N(() => window.nsoRotate.dialSign('ss'));
  frames['0'] = await N(() => ({ screen: window.nsoRotate.centreScreen(), group: window.__d.group(), pivot: null,
    lowest: window.__d.lowest(), turned: 0 }));
  const at = {};
  for (const k of [45, 90, 135, 180]) at[k] = async () => {
    await record(k);
    if (k === 90) await shot(page, '03-mid-drag-90-through-the-plate');
    if (k === 45) await shot(page, '03a-mid-drag-45');
  };
  await dragRing('ss', sgn * 180, at, true);
  await shot(page, '04-held-at-180-before-release');
  await page.mouse.up();
  await page.waitForTimeout(80);
  const rel = await N(() => ({ screen: window.nsoRotate.centreScreen(), group: window.__d.group(), held: window.nsoRotate.holding(),
    lowest: window.__d.lowest(), seatY: (p => p.height / 2 + 0.2 + (p.liftY || 0))(window.__d.p()) }));
  await shot(page, '05-released-at-180-seated');
  const endCam = await N(() => state.camera.position.toArray().concat(state.controls.target.toArray()));
  console.log('   ring centre on screen per frame:');
  for (const k of ['0', '45', '90', '135', '180']) {
    const f = frames[k];
    console.log('     ' + (k + '°').padEnd(5) + ' (' + f.screen.x.toFixed(2) + ', ' + f.screen.y.toFixed(2) + ') px' +
      '   turned ' + Math.abs(f.turned).toFixed(1) + '°, lowest point ' + f.lowest.toFixed(2) + ' mm');
  }
  console.log('     released (' + rel.screen.x.toFixed(2) + ', ' + rel.screen.y.toFixed(2) + ') px, lowest ' + rel.lowest.toFixed(3) + ' mm');
  check('the camera did not move', JSON.stringify(startCam) === JSON.stringify(endCam));
  check('the ring centre\'s screen position is identical at 0, 45, 90, 135 and 180°',
    ['45', '90', '135', '180'].every(k => frames[k].screen.x === frames['0'].screen.x && frames[k].screen.y === frames['0'].screen.y));
  check('mid-drag the tape passes through the plate', frames['90'].lowest < -50,
    'lowest point at 90°: ' + frames['90'].lowest.toFixed(1) + ' mm');
  check('on release it sits on the plate', rel.held === null && Math.abs(rel.lowest - 0.2) < 1e-3, rel.lowest.toFixed(4) + ' mm');
  check('...and the rings sit on its seated centre (at 180° the same box, so no step to make)',
    Math.abs(rel.group[1] - rel.seatY) < 1e-6, 'centre y ' + rel.group[1].toFixed(3));

  /* the step on release: drag to 90 and let go - it stands on end */
  const pre = await N(() => window.__d.group());
  await dragRing('ss', sgn * 90, null, true);
  const held90 = await N(() => ({ group: window.__d.group(), screen: window.nsoRotate.centreScreen() }));
  await page.mouse.up();
  await page.waitForTimeout(80);
  const seated90 = await N(() => ({ group: window.__d.group(), screen: window.nsoRotate.centreScreen(),
    lowest: window.__d.lowest() }));
  await shot(page, '06-released-at-90-stood-on-end-rings-stepped');
  check('dragged to 90° and released: the rings held on the pivot to the end, then stepped once to the new centre',
    Math.abs(held90.group[1] - pre[1]) < 1e-9 && seated90.group[1] > held90.group[1] + 50 && Math.abs(seated90.lowest - 0.2) < 1e-3,
    'centre y ' + held90.group[1].toFixed(2) + ' -> ' + seated90.group[1].toFixed(2) + ' mm, screen y ' +
    held90.screen.y.toFixed(1) + ' -> ' + seated90.screen.y.toFixed(1) + ' px');

  console.log('\n=== 3. fifteen 1° clicks: the pivot holds until the last release ===');
  await page.click('#btn-undo');                      // back to the 180 pose
  await page.waitForTimeout(150);
  await N(() => window.nsoRotate.turn('ss', -40));      // leaned 40°, so a click changes the box
  await page.waitForTimeout(100);
  const c0 = await N(() => ({ q: window.__d.q(), group: window.__d.group() }));
  const pivots = [];
  for (let i = 0; i < 15; i++) {
    const h = await N(() => window.nsoRotate.handleScreen('ss', 1));
    await page.mouse.click(h.x, h.y);
    pivots.push(await N(() => ({ pivot: window.nsoRotate.pivot(), group: window.__d.group(), held: !!window.nsoRotate.holding() })));
  }
  const clicked = await N(q => window.__d.angle(q, window.__d.q()), c0.q);
  await shot(page, '07-after-15-clicks-still-held');
  await page.waitForTimeout(800);
  const seatedRun = await N(() => ({ held: window.nsoRotate.holding(), group: window.__d.group(), lowest: window.__d.lowest() }));
  await shot(page, '08-run-seated-once');
  check('15 clicks turned it exactly 15°', Math.abs(clicked - 15) < 1e-6, clicked.toFixed(6) + '°');
  check('...the pivot, and the rings on it, unchanged through all 15', pivots.every(v => v.held &&
    JSON.stringify(v.pivot) === JSON.stringify(pivots[0].pivot) && JSON.stringify(v.group) === JSON.stringify(pivots[0].group)),
    'pivot ' + pivots[0].pivot.map(v => v.toFixed(2)).join(', '));
  check('...then seated once after the last release, the rings stepping to the seated centre',
    seatedRun.held === null && Math.abs(seatedRun.lowest - 0.2) < 1e-3 && seatedRun.group[1] !== pivots[14].group[1],
    'centre y ' + pivots[14].group[1].toFixed(3) + ' -> ' + seatedRun.group[1].toFixed(3) + ' mm');

  console.log('\n=== 4. Undo returns the seated pose ===');
  const undos = [];
  for (let i = 0; i < 3; i++) {
    await page.click('#btn-undo');
    await page.waitForTimeout(100);
    undos.push(await N(q => ({ lowest: window.__d.lowest(), turned: window.__d.angle(q, window.__d.q()) }), c0.q));
  }
  check('each Undo steps back one click and is seated on the plate',
    undos.every((u, i) => Math.abs(u.lowest - 0.2) < 1e-3 && Math.abs(u.turned - (14 - i)) < 1e-6),
    undos.map(u => u.turned.toFixed(2) + '° @ ' + u.lowest.toFixed(3) + ' mm').join(', '));

  console.log('\n=== 5. P1S selected: the same rings - the bed no longer sizes them ===');
  /* Switching the plate clears its pieces (updatePlateInfo -> clearPlaced,
     as it always has), so the tape is dropped on again. The plate picker
     lives in the Plate drop-down now, and switching it shuts Rotate (one
     panel on the page), which empties the rings' group - so Rotate is
     opened again, as a user would, before the rings are measured. */
  await page.selectOption('#plate-select', 'a1');
  await page.waitForTimeout(200);
  await loadSTL(page, TAPE);
  await page.waitForTimeout(300);
  if (!(await N(() => document.getElementById('menu-rotate').open))) await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);
  await N(() => { selectPlaced(state.placed.length - 1); window.__d.cam(); window.__d.centre(); });
  await page.waitForTimeout(150);
  const big = await N(() => ({ bed: getCurrentPlate(), ring: window.nsoRotate.ringRadius(), px: window.__d.diam('turn') }));
  await shot(page, '09-p1s-bed-same-rings');
  check('P1S / A1 / X1C, 256 mm bed: the rings are drawn, and are the same 40 mm',
    !!big.px && big.bed.w === 256 && big.ring === 40 && big.px.mm === 40,
    big.ring + ' mm on ' + big.bed.name + (big.px ? ', ' + big.px.w + ' x ' + big.px.h + ' px' : ', no ring drawn'));
  check('...the same size on screen as on the A1 Mini, same piece, spot and camera (to a pixel)',
    !!big.px && Math.abs(big.px.w - sizes.tape.px.w) < 1 && Math.abs(big.px.h - sizes.tape.px.h) < 1,
    big.px && (big.px.w + ' x ' + big.px.h + ' px vs ' + sizes.tape.px.w + ' x ' + sizes.tape.px.h));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\nscreenshots in ' + OUT);
  console.log(fails ? fails + ' FAILED' : 'every step held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
