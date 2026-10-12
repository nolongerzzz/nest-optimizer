#!/usr/bin/env node
/* Pose buttons about the plate's axes - the ticket's drive-check, in the real
   app, with screenshots.

   node tools/nso_pose_buttons_drive_check.js [outDir]    exit 0 = every step held

   Tip's Tilt ↑/↓ and Tilt ←/→, Tip's arrow keys, and Rotate's ⟲ 90 / 90 ⟳ all
   go through nsoRotate.turn now: one turn about a fixed axis of the PLATE,
   composed with whatever the piece is already doing. Before, Tilt ←/→ wrote
   tiltZ - the innermost Euler factor, the piece's own Z - and the 90° buttons
   wrote rotY, the middle one, so on a turned, stood or leaned piece they
   turned it about an axis of the piece instead.

   Every step is a real click or key press; what is read back is read from the
   scene. Each step also works out what the OLD field write would have done
   from the same pose (oldDelta), so the log says what changed, not only that
   the new thing holds.

   The piece is the 80 x 40 x 20 box hull. Screenshots go to outDir (default
   docs/pose-buttons). Export is checked the way tools/
   nso_rotate_rings_drive_check.js checks it: the downloaded .3mf's vertices
   against the screen's, in Bambu's plate frame. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'pose-buttons'));
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const shot = async (page, name) => {
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(OUT, name + '.png'), clip: { x: 300, y: 60, width: 1100, height: 760 } });
  console.log('   [screenshot] ' + name + '.png');
};
const fmtAxis = a => '[' + a.map(v => v.toFixed(6)).join(', ') + ']';

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 860 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    selectPlaced(0);
    const H = window.__d = {};
    H.p = () => state.placed[0];
    H.q = () => { const p = H.p(); p.mesh.updateMatrixWorld(true); return p.mesh.quaternion.toArray(); };
    H.fields = () => { const p = H.p();
      return { tipX: p.tipX || 0, tipZ: p.tipZ || 0, flipX: !!p.flipX, tiltX: p.tiltX || 0,
               rotY: p.rotY || 0, tiltZ: p.tiltZ || 0 }; };
    /* the rotation that takes orientation qa to qb, as a signed angle about a
       unit axis (premultiplied: qb = d * qa, so the axis is in WORLD terms) */
    H.rel = (qa, qb) => {
      const a = new THREE.Quaternion().fromArray(qa), b = new THREE.Quaternion().fromArray(qb);
      const d = b.clone().multiply(a.clone().invert());
      if (d.w < 0) { d.x = -d.x; d.y = -d.y; d.z = -d.z; d.w = -d.w; }
      const s = Math.hypot(d.x, d.y, d.z);
      const deg = 2 * Math.atan2(s, d.w) * 180 / Math.PI;
      return { deg, axis: s < 1e-12 ? [0, 0, 0] : [d.x / s, d.y / s, d.z / s] };
    };
    H.delta = (qa) => H.rel(qa, H.q());
    /* What the old buttons would have done from the pose the piece is in
       now: the same field arithmetic bankSelected / tiltSelected /
       rotateSelected used, composed the way applyMeshRotation composes it -
       computed, never written. */
    H.oldDelta = (field, amount) => {
      const f = H.fields();
      const compose = g => new THREE.Quaternion().setFromEuler(new THREE.Euler(
        g.tipX * Math.PI / 2 + g.tiltX * Math.PI / 180 + (g.flipX ? Math.PI : 0),
        g.rotY,
        g.tipZ * Math.PI / 2 + g.tiltZ * Math.PI / 180, 'XYZ'));
      const g = Object.assign({}, f); g[field] += amount;
      return H.rel(compose(f).toArray(), compose(g).toArray());
    };
    H.cam = (x, y, z) => {
      const c = H.p().mesh.position;
      state.controls.target.copy(c);
      state.camera.position.set(c.x + x, c.y + y, c.z + z);
      state.controls.update();
      state.camera.updateMatrixWorld(true);
      if (window.nsoRotate) window.nsoRotate.refresh();
    };
    H.heights = () => {
      const p = H.p(); p.mesh.updateMatrixWorld(true);
      const pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3(), out = [];
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); p.mesh.localToWorld(v); out.push(v.y); }
      return out;
    };
    /* where one of the piece's own axes points in the world */
    H.own = (b) => { const p = H.p(); p.mesh.updateMatrixWorld(true);
      return new THREE.Vector3().fromArray(b).applyQuaternion(p.mesh.quaternion).toArray(); };
    /* a point fixed to the piece, its screen angle about the piece's centre
       (screen y is down, so a growing angle is clockwise on screen) */
    H.markAngle = (local) => {
      const p = H.p(); p.mesh.updateMatrixWorld(true);
      const r = state.renderer.domElement.getBoundingClientRect();
      const s = v => { v = v.clone().project(state.camera);
        return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height }; };
      const a = s(p.mesh.localToWorld(new THREE.Vector3().fromArray(local))), c = s(p.mesh.position);
      return Math.atan2(a.y - c.y, a.x - c.x) * 180 / Math.PI;
    };
    H.status = () => document.getElementById('status').textContent;
  });
  const N = page.evaluate.bind(page);
  const openMenu = async (id) => {
    const open = await N(i => document.getElementById(i).open, id);
    if (!open) { await page.click('#' + id + ' > summary'); await page.waitForTimeout(150); }
  };
  const press = async (sel) => { await page.click(sel); await page.waitForTimeout(60); };
  const undo = async () => { await page.click('#btn-undo'); await page.waitForTimeout(80); };
  const near = (a, b, e) => Math.abs(a - b) <= e;
  const alongY = ax => near(Math.abs(ax[1]), 1, 1e-9);
  const alongX = ax => near(Math.abs(ax[0]), 1, 1e-9);
  const alongZ = ax => near(Math.abs(ax[2]), 1, 1e-9);
  const CAM_FRONT = [0, 110, 230], CAM_SIDE = [230, 110, 0], CAM_HIGH = [150, 140, 190];

  const start = await N(() => ({ q: window.__d.q(), f: window.__d.fields(),
    labels: ['btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn', 'btn-rot-left', 'btn-rot-right']
      .map(i => document.getElementById(i).textContent.trim()) }));
  check('the box lies flat and un-turned to begin with',
    start.f.tiltX === 0 && start.f.tiltZ === 0 && start.f.rotY === 0, JSON.stringify(start.f));
  check('the six buttons keep their labels', start.labels.join('|') === 'Tilt ↑|Tilt ↓|Tilt →|Tilt ←|⟲ 90°|90° ⟳',
    start.labels.join(' | '));

  /* ------------------------------------------------------------------- 0 */
  console.log('\n=== 0. each Tilt lifts the edge its title names, from the default front view ===');
  {
    await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_FRONT);
    await openMenu('menu-tip');
    /* the four ends of the flat box, by their mean height: far is -Z (away
       from the camera), right is +X (screen right from the +Z side) */
    const ends = () => N(() => {
      const p = window.__d.p(); p.mesh.updateMatrixWorld(true);
      const pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3(), w = new THREE.Vector3();
      const acc = { far: [], near: [], left: [], right: [] };
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i); w.copy(v); p.mesh.localToWorld(w);
        if (v.z < -9) acc.far.push(w.y); if (v.z > 9) acc.near.push(w.y);
        if (v.x < -39) acc.left.push(w.y); if (v.x > 39) acc.right.push(w.y);
      }
      const m = a => a.reduce((s, x) => s + x, 0) / a.length;
      const r = state.renderer.domElement.getBoundingClientRect();
      const sx = x => { const q = p.mesh.localToWorld(new THREE.Vector3(x, 0, 0)).project(state.camera); return r.left + (q.x * .5 + .5) * r.width; };
      return { far: m(acc.far), near: m(acc.near), left: m(acc.left), right: m(acc.right),
               rightOnScreenRight: sx(39) > sx(-39) };
    });
    const want = { 'btn-tilt-up': 'far', 'btn-tilt-dn': 'near', 'btn-bank-up': 'left', 'btn-bank-dn': 'right' };
    const opposite = { far: 'near', near: 'far', left: 'right', right: 'left' };
    for (const id of Object.keys(want)) {
      await press('#' + id);
      const e = await ends();
      const title = await N(i => document.getElementById(i).title, id);
      const label = await N(i => document.getElementById(i).textContent.trim(), id);
      const side = want[id];
      check(label + ' lifts the ' + side + ' edge, as its title says ("' + title + '")',
        e[side] - e[opposite[side]] > 5 && e.rightOnScreenRight && title.indexOf(side) >= 0,
        side + ' ' + e[side].toFixed(2) + ' mm vs ' + opposite[side] + ' ' + e[opposite[side]].toFixed(2) + ' mm');
      if (id === 'btn-bank-up') await shot(page, '00-flat-tilt-right-once-front');
      await undo();
    }
  }

  /* ------------------------------------------------------------------- 1 */
  console.log('\n=== 1. turn it 90° with the Turn ring, then Tilt → twice ===');
  await N(() => window.__d.cam(0.01, 300, 0.01));   // straight down: screen degrees are plate degrees
  await openMenu('menu-rotate');
  {
    const h = await N(() => window.nsoRotate.handleScreen('turn', 1));
    const c = await N(() => window.nsoRotate.centreScreen());
    const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    for (let i = 1; i <= 90; i++) {
      const a = a0 + i * Math.PI / 180;
      await page.mouse.move(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R);
    }
    await page.mouse.up();
    await page.waitForTimeout(80);
  }
  let r = await N(q => window.__d.delta(q), start.q);
  check('the Turn ring turned it exactly 90° about the plate\'s vertical',
    near(r.deg, 90, 1e-6) && alongY(r.axis), r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  const turned = await N(() => ({ q: window.__d.q(), f: window.__d.fields(), long: window.__d.own([1, 0, 0]) }));
  check('...so its 80 mm length now runs front to back, along the plate\'s Z',
    near(Math.abs(turned.long[2]), 1, 1e-9), fmtAxis(turned.long));

  await openMenu('menu-tip');
  const old1 = await N(() => window.__d.oldDelta('tiltZ', 30));
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_FRONT);
  await press('#btn-bank-up');
  const afterOne = await N(() => ({ q: window.__d.q(), status: window.__d.status() }));
  await press('#btn-bank-up');
  r = await N(q => window.__d.delta(q), turned.q);
  const tilted = await N(() => ({ q: window.__d.q(), status: window.__d.status(), long: window.__d.own([1, 0, 0]),
    up: window.__d.own([0, 1, 0]) }));
  console.log('   old tiltZ += 30 from this pose would have been ' + old1.deg.toFixed(3) + '° about ' + fmtAxis(old1.axis));
  check('Tilt → twice leans it 30° about the plate\'s Z - side to side',
    near(r.deg, 30, 1e-6) && alongZ(r.axis), r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  check('...not front/back: its length still runs level along the plate\'s Z',
    near(tilted.long[1], 0, 1e-9) && near(Math.abs(tilted.long[2]), 1, 1e-9), 'length axis ' + fmtAxis(tilted.long));
  check('...where the old tiltZ write would have leaned it front/back, about the plate\'s X',
    alongX(old1.axis), fmtAxis(old1.axis));
  check('the status line still says Bank', /^Bank /.test(tilted.status), JSON.stringify(tilted.status));
  await shot(page, '01a-turned-90-tilt-right-x2-front');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_SIDE);
  await shot(page, '01b-turned-90-tilt-right-x2-side');

  /* the arrow key is the button */
  await undo(); await undo();
  r = await N(q => window.__d.delta(q), turned.q);
  check('two Undos take back the two Tilt presses, one each, to the turned pose', r.deg < 1e-6, r.deg.toExponential(2) + '°');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(60);
  r = await N(q => window.__d.rel(q, window.__d.q()), afterOne.q);
  check('ArrowRight in the Tip menu lands exactly where one Tilt → click did', r.deg < 1e-6, r.deg.toExponential(2) + '°');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(60);
  r = await N(q => window.__d.rel(q, window.__d.q()), tilted.q);
  check('...and a second, exactly where the second click did', r.deg < 1e-6, r.deg.toExponential(2) + '°');
  await undo(); await undo();
  r = await N(q => window.__d.delta(q), turned.q);
  check('...each key press its own Undo step', r.deg < 1e-6, r.deg.toExponential(2) + '°');
  await undo();
  r = await N(q => window.__d.delta(q), start.q);
  check('...and one more Undo takes back the ring turn: flat again', r.deg < 1e-6, r.deg.toExponential(2) + '°');

  /* ------------------------------------------------------------------- 2 */
  console.log('\n=== 2. Stand it, then Tilt ← ===');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_FRONT);
  await press('#btn-tip');
  const stood = await N(() => ({ q: window.__d.q(), f: window.__d.fields(), long: window.__d.own([1, 0, 0]),
    h: window.__d.p().height }));
  check('Stand stood it on end: the 80 mm length upright', near(Math.abs(stood.long[1]), 1, 1e-9) && near(stood.h, 80, 1e-3),
    'length axis ' + fmtAxis(stood.long) + ', height ' + stood.h.toFixed(3));
  await shot(page, '02a-stood-front');
  const old2 = await N(() => window.__d.oldDelta('tiltZ', -15));
  await press('#btn-bank-dn');
  r = await N(q => window.__d.delta(q), stood.q);
  const leant = await N(() => ({ long: window.__d.own([1, 0, 0]) }));
  const fromUp = Math.acos(Math.min(1, Math.abs(leant.long[1]))) * 180 / Math.PI;
  console.log('   old tiltZ -= 15 from this pose would have been ' + old2.deg.toFixed(3) + '° about ' + fmtAxis(old2.axis));
  check('Tilt ← turned it 15° about the plate\'s Z - a horizontal axis', near(r.deg, 15, 1e-6) && alongZ(r.axis),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  check('...so it leans: the upright length is now 15° off vertical', near(fromUp, 15, 1e-6), fromUp.toFixed(9) + '°');
  check('...and it did not turn: no part of the motion is about the vertical', Math.abs(r.axis[1]) < 1e-9,
    'vertical component ' + r.axis[1].toExponential(2));
  await shot(page, '02b-stood-tilt-left-front');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_SIDE);
  await shot(page, '02c-stood-tilt-left-side');
  await undo();
  r = await N(q => window.__d.delta(q), stood.q);
  check('Undo takes back the Tilt: stood exactly as before', r.deg < 1e-6, r.deg.toExponential(2) + '°');
  await undo();
  r = await N(q => window.__d.delta(q), start.q);
  check('...and the next takes back the Stand: flat again', r.deg < 1e-6, r.deg.toExponential(2) + '°');

  /* Stand on this box is a quarter turn about the plate's Z, and the piece's
     own Z stays the plate's Z - so the old innermost-tiltZ write happened to
     lean it too (the log above says so). Tip on side is the pose where it did
     not: a quarter turn about X puts the piece's own Z vertical, and the old
     Tilt ←/→ spun it where it stood. */
  console.log('\n=== 2b. Tip on side, then Tilt ← ===');
  await press('#btn-flip');
  const side = await N(() => ({ q: window.__d.q(), ownZ: window.__d.own([0, 0, 1]) }));
  check('Tip on side put the piece\'s own Z vertical', near(Math.abs(side.ownZ[1]), 1, 1e-9), fmtAxis(side.ownZ));
  const old2b = await N(() => window.__d.oldDelta('tiltZ', -15));
  await press('#btn-bank-dn');
  r = await N(q => window.__d.delta(q), side.q);
  console.log('   old tiltZ -= 15 from this pose would have been ' + old2b.deg.toFixed(3) + '° about ' + fmtAxis(old2b.axis));
  check('Tilt ← leans it 15° about the plate\'s Z', near(r.deg, 15, 1e-6) && alongZ(r.axis),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  check('...where the old tiltZ write would have turned it about the vertical', alongY(old2b.axis), fmtAxis(old2b.axis));
  await shot(page, '02d-tipped-on-side-tilt-left-front');
  await undo(); await undo();
  r = await N(q => window.__d.delta(q), start.q);
  check('two Undos: flat again', r.deg < 1e-6, r.deg.toExponential(2) + '°');

  /* ------------------------------------------------------------------- 3 */
  console.log('\n=== 3. flat again, ⟲ 90 four times ===');
  await N(() => window.__d.cam(0.01, 300, 0.01));
  await openMenu('menu-rotate');
  const mark = [30, 0, 0];                               // the end of the piece's length
  const qs = [start.q];
  const turns = [];
  for (let i = 0; i < 4; i++) {
    const a0 = await N(m => window.__d.markAngle(m), mark);
    await press('#btn-rot-left');
    const a1 = await N(m => window.__d.markAngle(m), mark);
    const d = await N(q => window.__d.delta(q), qs[qs.length - 1]);
    qs.push(await N(() => window.__d.q()));
    turns.push({ deg: d.deg, axis: d.axis, screen: ((a1 - a0 + 540) % 360) - 180, status: await N(() => window.__d.status()) });
    if (i === 0) await shot(page, '03a-flat-rot-left-once-from-above');
  }
  turns.forEach((t, i) => console.log('   ⟲ #' + (i + 1) + ': ' + t.deg.toFixed(9) + '° about ' + fmtAxis(t.axis) +
    ', ' + t.screen.toFixed(2) + '° on screen, "' + t.status + '"'));
  check('each ⟲ is exactly a quarter turn about the plate\'s vertical',
    turns.every(t => near(t.deg, 90, 1e-9) && alongY(t.axis)), turns.map(t => t.deg.toFixed(9)).join(', '));
  check('...anticlockwise as seen from above, as the ⟲ says',
    turns.every(t => near(t.screen, -90, 0.5) && t.axis[1] > 0), turns.map(t => t.screen.toFixed(2)).join(', '));
  check('...each keeps its own status line', turns.every(t => /^Yaw #1$/.test(t.status)), turns[0].status);
  const back = await N(() => window.__d.fields());
  r = await N(q => window.__d.delta(q), start.q);
  check('four of them: back to the start exactly', r.deg === 0 && JSON.stringify(back) === JSON.stringify(start.f),
    r.deg + '°, fields ' + JSON.stringify(back));
  for (let i = 3; i >= 0; i--) {
    await undo();
    const d = await N(q => window.__d.delta(q), qs[i]);
    check('Undo #' + (4 - i) + ' steps back one ⟲', d.deg < 1e-9, d.deg.toExponential(2) + '°');
  }
  /* 90° ⟳ the other way, once, and back */
  await press('#btn-rot-right');
  r = await N(q => window.__d.delta(q), start.q);
  check('90° ⟳ is the same quarter turn clockwise from above', near(r.deg, 90, 1e-9) && near(r.axis[1], -1, 1e-9),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  await undo();

  /* The hard snap is the 90° buttons' and not the 15° tilts'. A piece 2° off
     square: ⟲ lands it ON the next quarter turn (88° of motion), where the
     ring's own snap would put a drag. A piece leaned 76°: Tilt ↑ makes it 91,
     not 90. Both offsets are written by nsoRotate.turn, no Undo point. */
  await N(() => window.nsoRotate.turn('turn', 2));
  const off = await N(() => window.__d.q());
  await press('#btn-rot-left');
  r = await N(q => window.__d.delta(q), off);
  const sq = await N(q => window.__d.delta(q), start.q);
  check('the 90° buttons snap: 2° off square, ⟲ lands exactly on the quarter turn',
    near(r.deg, 88, 1e-6) && near(sq.deg, 90, 1e-9), r.deg.toFixed(9) + '° of motion, ' + sq.deg.toFixed(9) + '° from the start');
  await undo();
  await N(() => window.nsoRotate.turn('turn', -2));
  await N(() => window.nsoRotate.turn('fb', 76));
  const lean76 = await N(() => window.__d.q());
  await openMenu('menu-tip');
  await press('#btn-tilt-up');
  r = await N(q => window.__d.delta(q), start.q);
  check('the 15° tilts do not: leaned 76°, Tilt ↑ goes to 91°, not 90°', near(r.deg, 91, 1e-6) && alongX(r.axis),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  await undo();
  r = await N(q => window.__d.delta(q), lean76);
  check('...one Undo back to 76°', r.deg < 1e-6, r.deg.toExponential(2));
  await N(() => window.nsoRotate.turn('fb', -76));
  r = await N(q => window.__d.delta(q), start.q);
  check('(the test offsets taken off again: flat)', r.deg < 1e-9, r.deg.toExponential(2));

  /* ------------------------------------------------------------------- 4 */
  console.log('\n=== 4. lean it 45°, then ⟲ 90 ===');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_HIGH);
  const chain = [start.q];
  for (let i = 0; i < 3; i++) { await press('#btn-tilt-up'); chain.push(await N(() => window.__d.q())); }
  r = await N(q => window.__d.delta(q), start.q);
  const tiltStatus = await N(() => window.__d.status());
  check('Tilt ↑ three times leans it 45° about the plate\'s X', near(r.deg, 45, 1e-6) && alongX(r.axis),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  check('...and the status line still says Tilt', /^Tilt 45°$/.test(tiltStatus), JSON.stringify(tiltStatus));
  await shot(page, '04a-leaned-45-camA');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_SIDE);
  await shot(page, '04b-leaned-45-camB');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_HIGH);
  await openMenu('menu-rotate');
  const old4 = await N(() => window.__d.oldDelta('rotY', -Math.PI / 2));
  const h0 = await N(() => window.__d.heights());
  const qLean = await N(() => window.__d.q());
  await press('#btn-rot-left');
  chain.push(await N(() => window.__d.q()));
  const h1 = await N(() => window.__d.heights());
  r = await N(q => window.__d.delta(q), qLean);
  const dh = Math.max(...h0.map((v, i) => Math.abs(v - h1[i])));
  const oldDh = await N((o) => {
    /* what the old rotY -= 90 would have done to the heights: the same
       vertices under the composed old orientation, seated the same way */
    const p = window.__d.p(), f = window.__d.fields();
    const e = new THREE.Euler(f.tipX * Math.PI / 2 + f.tiltX * Math.PI / 180 + (f.flipX ? Math.PI : 0),
      f.rotY + o, f.tipZ * Math.PI / 2 + f.tiltZ * Math.PI / 180, 'XYZ');
    const qa = p.mesh.quaternion.clone(), qb = new THREE.Quaternion().setFromEuler(e);
    const pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3(), ya = [], yb = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      ya.push(v.clone().applyQuaternion(qa).y); yb.push(v.clone().applyQuaternion(qb).y);
    }
    const la = Math.min(...ya), lb = Math.min(...yb);   // each seated on the plate
    return Math.max(...ya.map((y, i) => Math.abs((y - la) - (yb[i] - lb))));
  }, -Math.PI / 2);
  console.log('   old rotY -= 90 (the old ⟲) from this pose would have been ' + old4.deg.toFixed(3) + '° about ' + fmtAxis(old4.axis) +
    '; a point of it would have moved up to ' + oldDh.toFixed(3) + ' mm in height');
  check('⟲ 90 on the leaned piece turns it about the plate\'s vertical', near(r.deg, 90, 1e-6) && alongY(r.axis),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  check('...and no point of it changes height', dh < 1e-6, 'max ' + dh.toExponential(2) + ' mm over ' + h0.length + ' vertices');
  check('...where the old rotY write would have turned it about its own leaned axis',
    !alongY(old4.axis), fmtAxis(old4.axis));
  await shot(page, '04c-leaned-45-then-rot-left-camA');
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_SIDE);
  await shot(page, '04d-leaned-45-then-rot-left-camB');

  /* and tilt it side to side as well: the leaned-and-tilted piece */
  await N(c => window.__d.cam(c[0], c[1], c[2]), CAM_HIGH);
  await openMenu('menu-tip');
  const qT = await N(() => window.__d.q());
  for (let i = 0; i < 2; i++) { await press('#btn-bank-up'); chain.push(await N(() => window.__d.q())); }
  r = await N(q => window.__d.delta(q), qT);
  check('Tilt → twice on top of that: 30° about the plate\'s Z', near(r.deg, 30, 1e-6) && alongZ(r.axis),
    r.deg.toFixed(9) + '° about ' + fmtAxis(r.axis));
  await shot(page, '04e-leaned-turned-and-tilted-camA');

  /* ------------------------------------------------------------------- 5 */
  console.log('\n=== 5. export the leaned-and-tilted piece ===');
  await N(() => { const f = document.getElementById('export-format'); f.value = '3mf'; f.dispatchEvent(new Event('change')); });
  await N(() => { const e = document.getElementById('btn-export-stl'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export-stl')]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-pose-'));
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const parts = execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(n => /\.model$/.test(n));
  const verts = [], tris = [];
  for (const part of parts) {
    const xml = execFileSync('unzip', ['-p', file, part], { maxBuffer: 1 << 28 }).toString();
    const base = verts.length;
    for (const m of xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) verts.push([+m[1], +m[2], +m[3]]);
    for (const m of xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) tris.push([+m[1] + base, +m[2] + base, +m[3] + base]);
  }
  const screen = await N(() => {
    const p = window.__d.p(); p.mesh.updateMatrixWorld(true);
    const plate = getCurrentPlate(), pos = p.mesh.geometry.attributes.position, v = new THREE.Vector3(), out = [];
    const lift = p.mesh.position.y - (p.height / 2 + (p.liftY || 0));
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i); p.mesh.localToWorld(v);
      out.push([v.x + plate.w / 2, -v.z + plate.d / 2, v.y - lift]);
    }
    return out;
  });
  const fileSoup = [].concat(...tris.map(t => t.map(i => verts[i])));
  let worst = Infinity;
  if (fileSoup.length === screen.length) {
    worst = 0;
    for (let i = 0; i < screen.length; i++)
      worst = Math.max(worst, Math.hypot(...[0, 1, 2].map(k => fileSoup[i][k] - screen[i][k])));
  }
  const minZ = Math.min(...verts.map(v => v[2]));
  check('the downloaded .3mf holds the piece where the screen shows it, vertex for vertex',
    worst < 1e-3, (worst === Infinity ? 'counts differ ' + fileSoup.length + ' vs ' + screen.length
      : 'worst ' + worst.toExponential(2) + ' mm') + ' over ' + screen.length + ' vertices, ' + parts.join(','));
  check('...resting on the plate (min z = 0)', Math.abs(minZ) < 1e-3, 'min z ' + minZ);
  await N((soup) => {
    const plate = getCurrentPlate();
    const g = new THREE.BufferGeometry();
    const p = window.__d.p(), lift = p.mesh.position.y - (p.height / 2 + (p.liftY || 0));
    g.setAttribute('position', new THREE.Float32BufferAttribute([].concat(...soup.map(v =>
      [v[0] - plate.w / 2, v[2] + lift, -(v[1] - plate.d / 2)])), 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x22ff88, wireframe: true, depthTest: false }));
    m.name = 'nso-export-overlay'; m.renderOrder = 2000;
    state.scene.add(m);
  }, fileSoup);
  await shot(page, '05-exported-file-overlaid-green');
  await N(() => state.scene.remove(state.scene.getObjectByName('nso-export-overlay')));

  /* ------------------------------------------------------------------- 6 */
  console.log('\n=== 6. Undo steps each back ===');
  /* chain: flat, Tilt ↑ x3, ⟲, Tilt → x2 - six presses, six Undos */
  const offs = [];
  for (let i = chain.length - 2; i >= 0; i--) {
    await undo();
    offs.push(await N(q => window.__d.delta(q).deg, chain[i]));
  }
  check('six presses, six Undos, each back exactly one press, ending flat',
    offs.length === 6 && offs.every(o => o < 1e-6), offs.map(o => o.toExponential(1)).join(' '));

  /* ------------------------------------------------------------------- 7 */
  console.log('\n=== 7. audit (report only, no change): Tip on side, Stand, Flip ===');
  /* Task 2. Each of the three quarter-turn seats is turnBy in
     app-tip-orient.js: a WORLD-axis quaternion premultiplied onto the mesh's
     own. Measured here from three poses - flat, turned 90° and leaned 30° -
     as the rotation each press makes, in world terms. A piece-local turn
     would show up as an axis that follows the piece (off the plate's X/Z
     once turned or leaned). */
  {
    await openMenu('menu-tip');
    const poses = {
      flat: [],
      'turned 90 (⟲)': ['menu-rotate', '#btn-rot-left'],
      'leaned 30 (Tilt ↑ x2)': ['menu-tip', '#btn-tilt-up', '#btn-tilt-up']
    };
    const rows = [];
    for (const [pose, steps] of Object.entries(poses)) {
      for (const [btn, name] of [['#btn-flip', 'Tip on side'], ['#btn-tip', 'Stand'], ['#btn-flip-over', 'Flip']]) {
        let n = 0;
        if (steps.length) { await openMenu(steps[0]); for (const s of steps.slice(1)) { await press(s); n++; } }
        await openMenu('menu-tip');
        const q0 = await N(() => window.__d.q());
        await press(btn);
        const d = await N(q => window.__d.delta(q), q0);
        const f = await N(() => window.__d.fields());
        rows.push({ pose, name, deg: d.deg, axis: d.axis, f });
        await undo(); for (let i = 0; i < n; i++) await undo();
      }
    }
    rows.forEach(x => console.log('   ' + (x.pose + ', ' + x.name).padEnd(36) + x.deg.toFixed(6) + '° about ' + fmtAxis(x.axis) +
      '   fields after: tiltX ' + (+x.f.tiltX.toFixed(4)) + ', rotY ' + (+(x.f.rotY * 180 / Math.PI).toFixed(4)) +
      '°, tiltZ ' + (+x.f.tiltZ.toFixed(4))));
    const plateAxis = ax => ['x', 'y', 'z'].filter((k, i) => near(Math.abs(ax[i]), 1, 1e-9))[0];
    for (const name of ['Tip on side', 'Stand', 'Flip']) {
      const mine = rows.filter(x => x.name === name);
      check(name + ': every press is one turn about a horizontal PLATE axis, from every pose',
        mine.every(x => ['x', 'z'].includes(plateAxis(x.axis))),
        mine.map(x => (plateAxis(x.axis) || 'piece-local!') + ' ' + x.deg.toFixed(3) + '°').join(', '));
    }
    r = await N(q => window.__d.delta(q), start.q);
    check('(audit left the piece flat)', r.deg < 1e-6, r.deg.toExponential(2));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\nscreenshots in ' + OUT);
  console.log(fails ? fails + ' FAILED' : 'every step held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
