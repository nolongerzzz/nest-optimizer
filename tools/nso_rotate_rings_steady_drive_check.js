#!/usr/bin/env node
/* Rotate rings - steady radius, quieter rails, a 5° scale: the ticket's
   drive-check, in the real app, with screenshots.

   node tools/nso_rotate_rings_steady_drive_check.js [outDir]     exit 0 = every step held

   Real mouse drags on the real arrowheads. The ring's PIXEL diameter is read
   off the drawn torus itself - every vertex of the mesh that is on screen,
   through the camera that drew it - at rest, before and after a turn, with
   the camera not moved in between. Screenshots go to outDir (default a
   fresh nso-rotate-rings-steady-* dir under the OS temp dir, outside the
   repo; the path is printed at the end).

   The pieces are the repository's 80 x 40 x 20 box fixture (the one #135's
   drive-check used) and tape_on-edge-single. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const OUT = process.argv[2] ? path.resolve(process.argv[2])
                            : fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rotate-rings-steady-'));
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

  console.log('\n=== 4. at rest: the 5° scale, no numbers, at the default zoom and after an orbit ===');
  await page.click('#chk-rot-ring-fb');
  await page.click('#chk-rot-ring-ss');
  await page.waitForTimeout(120);
  await shot(page, '07-turn-ring-ticks-default-zoom');
  const scale = async () => N(() => {
    const g = state.scene.getObjectByName('nso-rotate-handles');
    const r = state.renderer.domElement.getBoundingClientRect();
    const t = g.children.find(c => c.userData.nsoRotateTicks === 'turn');
    t.updateMatrixWorld(true);
    const pos = t.geometry.attributes.position, v = new THREE.Vector3(), out = [];
    for (let i = 0; i < pos.count; i += 2) {                  // each tick's inner end
      v.fromBufferAttribute(pos, i).applyMatrix4(t.matrixWorld).project(state.camera);
      out.push({ x: +((v.x * .5 + .5) * r.width).toFixed(1), y: +((-v.y * .5 + .5) * r.height).toFixed(1),
                 onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 });
    }
    return { ticks: out, sprites: g.children.filter(c => c.isSprite).length };
  });
  const S0 = await scale();
  check('72 Turn ticks - one every 5° - all on screen at the default zoom',
    S0.ticks.length === 72 && S0.ticks.every(l => l.onScreen), S0.ticks.length + ' ticks');
  check('no 0 / 90 / 180 / 270 labels round the ring', S0.sprites === 0, S0.sprites + ' sprite(s)');
  await N(() => window.__d.cam(-170, 120, -150));
  const S1 = await scale();
  await shot(page, '08-turn-ring-ticks-after-orbit');
  check('after an orbit the ticks are still all on screen', S1.ticks.every(l => l.onScreen));
  check('...and they moved on screen with the orbit, i.e. they stay where the scale is',
    S1.ticks.some((l, i) => Math.hypot(l.x - S0.ticks[i].x, l.y - S0.ticks[i].y) > 20));

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
    const k = (90 / 5) * 6;                                // the 90 tick's first point
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

  console.log('\n=== 6. the leans are the piece\'s own: turn the box 45°, lean side/side 30° ===');
  /* Real drags only. Back to rest first, from three-quarter view. */
  await select(0);
  await N(() => { const p = window.__d.p(); p.rotY = 0; p.tiltX = 0; p.tiltZ = 0; applyMeshRotation(p);
    window.__d.cam(150, 140, 190); });
  await page.click('#chk-rot-ring-fb');
  await page.click('#chk-rot-ring-ss');
  await page.waitForTimeout(100);
  await shot(page, '10-box-at-rest-lean-rings-along-the-piece');
  const axes = () => N(() => {
    const q = window.__d.p().mesh.quaternion, D = 180 / Math.PI;
    const L = new THREE.Vector3(1, 0, 0).applyQuaternion(q), W = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return { heading: Math.atan2(-L.z, L.x) * D, elev: Math.asin(Math.max(-1, Math.min(1, L.y))) * D,
             W: W.toArray(), fb: window.nsoRotate.ringAxis('fb'), ss: window.nsoRotate.ringAxis('ss'),
             L: L.toArray() };
  });
  /* turn +45: the dial's turn is dialSign x the screen angle traced, so
     tracing dialSign x 45 turns it +45 */
  let sgn = await N(() => window.nsoRotate.dialSign('turn'));
  await dragRing('turn', sgn * 45);
  const a45 = await axes();
  check('Turn: the box\'s heading is 45°', Math.abs(a45.heading - 45) < 1e-3, a45.heading.toFixed(4) + '°');
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  check('...and the lean rings came round with it: front/back is now its own length, side/side its width line',
    Math.abs(Math.abs(dot(a45.fb, a45.L)) - 1) < 1e-9 && Math.abs(Math.abs(dot(a45.ss, a45.W)) - 1) < 1e-9,
    'fb ' + a45.fb.map(v => v.toFixed(3)) + ', ss ' + a45.ss.map(v => v.toFixed(3)));
  await shot(page, '11-turned-45-lean-rings-turned-with-it');
  /* lean side/side 30 - the ring that runs along the piece - raising an end */
  sgn = await N(() => window.nsoRotate.dialSign('ss'));
  await dragRing('ss', sgn * 30);
  const a30 = await axes();
  console.log('   long axis: heading ' + a45.heading.toFixed(4) + '° -> ' + a30.heading.toFixed(4) +
    '°, elevation ' + a45.elev.toFixed(4) + '° -> ' + a30.elev.toFixed(4) + '°');
  check('Lean side/side 30°: the long axis rises 30° end-over-end', Math.abs(Math.abs(a30.elev) - 30) < 1e-3,
    a30.elev.toFixed(4) + '°');
  check('...with no twist: still heading 45°', Math.abs(a30.heading - a45.heading) < 1e-6,
    a30.heading.toFixed(6) + '°');
  check('...about its width line, which stayed put', Math.abs(dot(a30.W, a45.W) - 1) < 1e-12);
  await shot(page, '12-then-leaned-side-side-30');
  await N(() => window.__d.cam(-60, 60, 230));
  await shot(page, '13-same-from-the-side');
  await N(() => window.__d.cam(150, 140, 190));

  /* export through the real button and read the file back */
  await N(() => { const f = document.getElementById('export-format'); f.value = '3mf'; f.dispatchEvent(new Event('change')); });
  await N(() => { const e = document.getElementById('btn-export-stl'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-stl')]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-steady-'));
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const parts = execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(n => /\.model$/.test(n));
  const objects = [];
  for (const part of parts) {
    const xml = execFileSync('unzip', ['-p', file, part], { maxBuffer: 1 << 28 }).toString();
    for (const o of xml.matchAll(/<object\b[\s\S]*?<\/object>/g)) {
      const verts = [], tris = [];
      for (const m of o[0].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) verts.push([+m[1], +m[2], +m[3]]);
      for (const m of o[0].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) tris.push([+m[1], +m[2], +m[3]]);
      if (tris.length) objects.push([].concat(...tris.map(t => t.map(i => verts[i]))));
    }
  }
  const screens = await N(() => {
    const plate = getCurrentPlate(), v = new THREE.Vector3();
    return state.placed.map(p => {
      p.mesh.updateMatrixWorld(true);
      const pos = p.mesh.geometry.attributes.position, out = [];
      const lift = p.mesh.position.y - (p.height / 2 + (p.liftY || 0));     // the 0.2 baseline the export leaves out
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i); p.mesh.localToWorld(v);
        out.push([v.x + plate.w / 2, -v.z + plate.d / 2, v.y - lift]);
      }
      return out;
    });
  });
  const cmp = screens.map((sc, i) => {
    const f = objects[i];
    if (!f || f.length !== sc.length) return { worst: Infinity, n: sc.length, fn: f ? f.length : 0 };
    let w = 0;
    for (let k = 0; k < sc.length; k++) w = Math.max(w, Math.hypot(f[k][0] - sc[k][0], f[k][1] - sc[k][1], f[k][2] - sc[k][2]));
    return { worst: w, n: sc.length, minZ: Math.min(...f.map(v => v[2])) };
  });
  check('the downloaded .3mf holds the turned-and-leaned box where the screen shows it, vertex for vertex',
    cmp[0].worst < 1e-3, 'worst ' + cmp[0].worst.toExponential(2) + ' mm over ' + cmp[0].n + ' vertices');
  check('...and resting on the plate', Math.abs(cmp[0].minZ) < 1e-3, 'min z ' + cmp[0].minZ);
  check('...and the other piece on the plate too', cmp[1] && cmp[1].worst < 1e-3,
    cmp[1] && ('worst ' + cmp[1].worst.toExponential(2) + ' mm over ' + cmp[1].n));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\nscreenshots in ' + OUT);
  console.log(fails ? fails + ' FAILED' : 'every step held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
