#!/usr/bin/env node
/* Rotate rings - steady radius, quieter rails, degree markers: the ticket's
   drive-check, in the real app, with screenshots.

   node tools/nso_rotate_rings_steady_drive_check.js [outDir]     exit 0 = every step held

   Real mouse drags on the real arrowheads. The ring's PIXEL diameter is read
   off the drawn torus itself - every vertex of the mesh that is on screen,
   through the camera that drew it - at rest, before and after a turn, with
   the camera not moved in between. Screenshots go to outDir (default
   docs/rotate-rings-steady).

   The pieces are the repository's 80 x 40 x 20 box fixture (the one #135's
   drive-check used) and tape_on-edge-single. */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'rotate-rings-steady'));
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const shot = async (page, name) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, name + '.png'), clip: { x: 300, y: 60, width: 1100, height: 780 } });
  console.log('   [screenshot] ' + name + '.png');
};

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await loadSTL(page, path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const H = window.__d = {};
    H.p = () => state.placed[state.selectedIndex];
    H.q = () => { const p = H.p(); p.mesh.updateMatrixWorld(true); return p.mesh.quaternion.toArray(); };
    H.angle = (qa, qb) => {
      const a = new THREE.Quaternion().fromArray(qa), b = new THREE.Quaternion().fromArray(qb);
      const d = b.clone().multiply(a.clone().invert());
      return 2 * Math.atan2(Math.hypot(d.x, d.y, d.z), Math.abs(d.w)) * 180 / Math.PI;
    };
    /* the drawn ring's extent on screen, in pixels, from its own vertices */
    H.diam = (ring) => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      const m = g.children.find(c => c.userData.nsoRotateRing === ring);
      m.updateMatrixWorld(true);
      const pos = m.geometry.attributes.position, v = new THREE.Vector3();
      const r = state.renderer.domElement.getBoundingClientRect();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(state.camera);
        const x = (v.x * .5 + .5) * r.width, y = (-v.y * .5 + .5) * r.height;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { w: +(x1 - x0).toFixed(3), h: +(y1 - y0).toFixed(3), mm: m.geometry.parameters.radius };
    };
    H.cam = (x, y, z) => {
      const c = H.p().mesh.position;
      state.controls.target.copy(c);
      state.camera.position.set(c.x + x, c.y + y, c.z + z);
      state.controls.update(); state.camera.updateMatrixWorld(true);
      window.nsoRotate.refresh();
    };
    H.camNow = () => state.camera.position.toArray().concat(state.controls.target.toArray());
  });
  const N = page.evaluate.bind(page);

  /* A real drag from an arrowhead round the projected centre, `screenDeg`
     degrees clockwise on screen. `at[i]` runs at step i, mid-drag. */
  const dragRing = async (ring, screenDeg, at) => {
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
    await page.mouse.up();
    await page.waitForTimeout(60);
  };
  const select = async (i) => { await N(k => { selectPlaced(k); }, i); await page.waitForTimeout(150); };
  /* A freshly dropped piece rests 0.1 mm higher than any posed one (ingest
     seats it on +0.3, every pose on the 0.2 baseline - the open finding noted
     at snapshotPlacedPose in app-core.js). The first turn would drop the ring's
     CENTRE by that 0.1 mm and the projection would shift by a tenth of a pixel
     that has nothing to do with its radius. One key nudge there and back
     seats it first. */
  const settle = async () => {
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(60);
  };

  console.log('\n=== 1. the 80x40x20 box, Turn ring: 0°, then dragged to 37° ===');
  await select(0);
  await page.click('#menu-rotate > summary');
  await page.waitForTimeout(150);
  await settle();
  const cam0 = await N(() => window.__d.camNow());
  const d0 = await N(() => window.__d.diam('turn'));
  const q0 = await N(() => window.__d.q());
  await shot(page, '01-box-turn-0deg');
  await dragRing('turn', 37);
  const d37 = await N(() => window.__d.diam('turn'));
  const turned = await N(q => window.__d.angle(q, window.__d.q()), q0);
  const cam1 = await N(() => window.__d.camNow());
  await shot(page, '02-box-turn-37deg');
  check('the drag turned the box 37° (pointer pixels are quantised: to 0.001°)', Math.abs(turned - 37) < 1e-3, turned.toFixed(6) + '°');
  check('the camera did not move between the two', JSON.stringify(cam0) === JSON.stringify(cam1));
  check('ring pixel diameter identical at 0° and 37°', d0.w === d37.w && d0.h === d37.h && d0.mm === d37.mm,
    '0°: ' + d0.w + ' x ' + d0.h + ' px, 37°: ' + d37.w + ' x ' + d37.h + ' px (radius ' + d0.mm.toFixed(3) + ' mm)');

  console.log('\n=== 2. tape_on-edge-single, Turn ring, dragged through 90° ===');
  await select(1);
  await page.waitForTimeout(150);
  await settle();
  const tq0 = await N(() => window.__d.q());
  const t0 = await N(() => window.__d.diam('turn'));
  await shot(page, '03-tape-turn-0deg');
  const mid = [];
  const at = {};
  for (const k of [15, 30, 45, 60, 75]) at[k] = async () => {
    /* mid-drag the active ring is thinner, so its outer pixel edge moves by
       the tube; its centre-line radius in mm is what must not */
    mid.push(await N(() => window.nsoRotate.ringRadius()));
  };
  await dragRing('turn', 92, at);                         // into the snap at 90
  const t90 = await N(() => window.__d.diam('turn'));
  const tTurned = await N(q => window.__d.angle(q, window.__d.q()), tq0);
  await shot(page, '04-tape-turn-90deg');
  check('the tape turned through to the quarter turn', Math.abs(tTurned - 90) < 1e-6 || Math.abs(tTurned - 92) < 1e-6,
    tTurned.toFixed(6) + '°');
  check('ring pixel diameter identical at 0° and 90°', t0.w === t90.w && t0.h === t90.h,
    '0°: ' + t0.w + ' x ' + t0.h + ' px, 90°: ' + t90.w + ' x ' + t90.h + ' px (radius ' + t0.mm.toFixed(3) + ' mm)');
  check('...and the radius never moved on the way (15/30/45/60/75°)', mid.every(r => r === t0.mm),
    mid.map(r => r.toFixed(6)).join(' '));

  console.log('\n=== 3. mid-drag: the active ring thin, the piece through it, the others faint ===');
  await select(0);
  await page.click('#chk-rot-ring-fb');
  await page.click('#chk-rot-ring-ss');
  await page.waitForTimeout(120);
  await shot(page, '05-box-three-rings-rest');
  let midState = null;
  await dragRing('turn', 30, { 25: async () => {
    midState = await N(() => {
      const g = state.scene.getObjectByName('nso-rotate-handles'), o = {};
      g.children.forEach(c => { if (c.userData.nsoRotateRing) o[c.userData.nsoRotateRing] =
        { opacity: c.material.opacity, tube: +c.geometry.parameters.tube.toFixed(3) }; });
      return o;
    });
    await shot(page, '06-box-mid-drag');
  } });
  console.log('   mid-drag: ' + JSON.stringify(midState));
  check('mid-drag the Turn ring is the thin, see-through one; the leans are a faint trace',
    midState.turn.opacity < 0.5 && midState.fb.opacity <= 0.15 && midState.ss.opacity <= 0.15);
  const rest = await N(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles'), o = {};
    g.children.forEach(c => { if (c.userData.nsoRotateRing) o[c.userData.nsoRotateRing] =
      { opacity: c.material.opacity, tube: +c.geometry.parameters.tube.toFixed(3) }; });
    return o;
  });
  console.log('   released: ' + JSON.stringify(rest));
  check('released: all three back at rest weight',
    ['turn', 'fb', 'ss'].every(k => rest[k].opacity === rest.turn.opacity && rest[k].tube === rest.turn.tube) &&
    rest.turn.tube > midState.turn.tube);

  console.log('\n=== 4. at rest: ticks and the four labels, at the default zoom and after an orbit ===');
  await page.click('#chk-rot-ring-fb');
  await page.click('#chk-rot-ring-ss');
  await page.waitForTimeout(120);
  await shot(page, '07-turn-ring-ticks-labels-default-zoom');
  const lab = async () => N(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles');
    const r = state.renderer.domElement.getBoundingClientRect();
    return g.children.filter(c => c.userData.nsoRotateLabel && c.userData.nsoRotateLabel.ring === 'turn').map(s => {
      const v = s.getWorldPosition(new THREE.Vector3()).project(state.camera);
      return { deg: s.userData.nsoRotateLabel.deg, sprite: !!s.isSprite,
               x: +((v.x * .5 + .5) * r.width).toFixed(1), y: +((-v.y * .5 + .5) * r.height).toFixed(1),
               onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
    });
  });
  const L0 = await lab();
  check('four Turn labels, all on screen at the default zoom', L0.length === 4 && L0.every(l => l.onScreen),
    L0.map(l => l.deg + '@(' + l.x + ',' + l.y + ')').join(' '));
  await N(() => window.__d.cam(-170, 120, -150));
  const L1 = await lab();
  await shot(page, '08-turn-ring-labels-after-orbit');
  check('after an orbit they are still sprites - camera-facing by construction - and on screen',
    L1.every(l => l.sprite && l.onScreen), L1.map(l => l.deg + '@(' + l.x + ',' + l.y + ')').join(' '));
  check('...and they moved on screen with the orbit, i.e. they stay where the scale is',
    L1.some((l, i) => Math.hypot(l.x - L0[i].x, l.y - L0[i].y) > 20));

  console.log('\n=== 5. the hard snap at 90° lands on the 90 tick ===');
  await N(() => { const p = window.__d.p(); p.rotY = 0; p.tiltX = 0; p.tiltZ = 0; applyMeshRotation(p); });
  await N(() => window.__d.cam(130, 170, 210));
  /* The box's long axis (its own X) reads 90 on the Turn scale at rest - the
     scale's 0 is the plate's +Z. Take it 40° off, then drag it back up: the
     snap catches it 3° short and it lands on the 90. */
  await N(() => { window.nsoRotate.turn('turn', -40); });
  const before = await N(() => window.nsoRotate.ringAngle('turn'));
  const sign = await N(() => window.nsoRotate.dialSign('turn'));
  await dragRing('turn', sign * 38);                       // 2° short of the tick
  const landed = await N(() => {
    const p = window.__d.p(); p.mesh.updateMatrixWorld(true);
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(p.mesh.quaternion).projectOnPlane(new THREE.Vector3(0, 1, 0)).normalize();
    const g = state.scene.getObjectByName('nso-rotate-handles');
    const t = g.children.find(c => c.userData.nsoRotateTicks === 'turn').geometry.attributes.position.array;
    const k = (90 / 15) * 6;                               // the 90 tick's first point
    const tick = new THREE.Vector3(t[k], t[k + 1], t[k + 2]).normalize();
    /* drawn for the screenshot only: the box's long axis, out to the tick */
    const r = window.nsoRotate.ringRadius() * 1.12;
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, r, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ax);
    line.position.copy(p.mesh.position).add(ax.clone().multiplyScalar(r / 2));
    line.name = 'nso-check-axis'; line.renderOrder = 3000;
    state.scene.add(line);
    return { angle: window.nsoRotate.ringAngle('turn'), cos: ax.dot(tick), readout: window.nsoRotate.readout() };
  });
  await shot(page, '09-snap-lands-on-90-tick');
  await N(() => state.scene.remove(state.scene.getObjectByName('nso-check-axis')));
  check('dragged to 2° short of 90, the snap put it on 90 exactly', Math.abs(landed.angle - 90) < 1e-6,
    before.toFixed(3) + '° -> ' + landed.angle.toFixed(6) + '° (' + landed.readout + ')');
  check('...the box\'s long axis lies exactly along the 90 tick', Math.abs(landed.cos - 1) < 1e-9, 'cos = ' + landed.cos);

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\nscreenshots in ' + OUT);
  console.log(fails ? fails + ' FAILED' : 'every step held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
