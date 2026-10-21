#!/usr/bin/env node
/* The Tip menu's orientation controls, driven in the real page.
     node tools/nso_tip_orient_test.js        exit 0 = every gate held

   Orientation is checked by where the piece's own up-axis ENDS UP and by the
   footprint it presents, not by the five pose fields. Two different field
   combinations can describe the same orientation, so comparing fields would
   pass a wrong answer that happened to be spelled the same way. */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, statusOf, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const vec = v => '(' + v.x + ',' + v.y + ',' + v.z + ')';
const dims = s => s.w + 'x' + s.d + 'x' + s.h;
const same = (a, b) => vec(a.up) === vec(b.up) && dims(a.size) === dims(b.size);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => selectPlaced(0));
  await page.waitForTimeout(300);

  const api = await page.evaluate(() => typeof window.nsoTipOrient);
  check('the module is on the page', api === 'object', 'typeof = ' + api);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the three one-click orientations are correct AND distinct ===');
  {
    const o = await page.evaluate(() => {
      const t = window.nsoTipOrient;
      const reset = () => { const p = state.placed[0];
        p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; p.flipX = false;
        applyMeshRotation(p); };
      const shot = id => { reset(); document.getElementById(id).click(); return t.orientation(); };
      reset();
      return { start: t.orientation(), side: shot('btn-flip'),
               stand: shot('btn-tip'), flip: shot('btn-flip-over') };
    });
    console.log('   start  up' + vec(o.start.up) + '  ' + dims(o.start.size));
    console.log('   side   up' + vec(o.side.up) + '  ' + dims(o.side.size));
    console.log('   stand  up' + vec(o.stand.up) + '  ' + dims(o.stand.size));
    console.log('   flip   up' + vec(o.flip.up) + '  ' + dims(o.flip.size));

    check('the piece starts flat, 80 x 40 x 20', vec(o.start.up) === '(0,1,0)' &&
      dims(o.start.size) === '80x40x20', vec(o.start.up) + ' ' + dims(o.start.size));
    /* Tip on side pivots about the axis the long bottom edge runs along, so
       the 40 goes upright and the 80 stays along the plate. */
    check('Tip on side lays it on its long edge - 40 comes up, 80 stays down',
      dims(o.side.size) === '80x20x40', dims(o.side.size));
    /* Stand puts the LONGEST dimension upright. */
    check('Stand puts it on its end - the 80 axis is now the tall one',
      o.stand.size.h === 80, dims(o.stand.size));
    /* Flip turns it over: the footprint is unchanged and up is inverted. */
    check('Flip turns it upside down - same footprint, up inverted',
      vec(o.flip.up) === '(0,-1,0)' && dims(o.flip.size) === dims(o.start.size),
      vec(o.flip.up) + ' ' + dims(o.flip.size));

    check('...and no two of them are the same orientation',
      !same(o.side, o.stand) && !same(o.side, o.flip) && !same(o.stand, o.flip));
    check('...nor is any of them a no-op',
      !same(o.start, o.side) && !same(o.start, o.stand) && !same(o.start, o.flip));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. Tip on face, and the orientation Flat used to give ===');
  {
    const f = await page.evaluate(() => {
      const t = window.nsoTipOrient;
      const reset = () => { const p = state.placed[0];
        p.tipX = 0; p.tipZ = 0; p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; p.flipX = false;
        applyMeshRotation(p); };
      const pick = n => {
        reset();
        const p = state.placed[0]; p.mesh.updateMatrixWorld(true);
        t.tipOnFaceFromHit({ face: { normal: new THREE.Vector3(n[0], n[1], n[2]) },
                             object: p.mesh });
        return t.orientation();
      };
      reset(); const start = t.orientation();
      return { start: start, top: pick([0, 1, 0]), bottom: pick([0, -1, 0]),
               side: pick([1, 0, 0]), front: pick([0, 0, 1]),
               slanted: pick([0.6, 0.8, 0]) };
    });
    check('picking the TOP face turns it over - that face is now down',
      vec(f.top.up) === '(0,-1,0)', vec(f.top.up));
    /* The Flat replacement, asserted as the ticket words it. */
    check('picking the BOTTOM face gives exactly what Flat used to give - lying flat',
      same(f.bottom, f.start), vec(f.bottom.up) + ' ' + dims(f.bottom.size) +
      '  vs start ' + vec(f.start.up) + ' ' + dims(f.start.size));
    check('picking a side face stands that side on the plate',
      f.side.size.h === 80 || f.side.size.w === 20 || f.side.size.d === 20,
      dims(f.side.size));
    check('picking the front face rests it on the front', vec(f.front.up) !== '(0,1,0)',
      vec(f.front.up) + ' ' + dims(f.front.size));
    /* Not a box face at all - the thing storeFacePick refuses as "on a curve"
       and the reason the world normal is taken straight off the triangle. */
    check('a slanted pick works too - an edge or a curve is still a direction',
      vec(f.slanted.up) !== '(0,1,0)' && isFinite(f.slanted.size.h),
      vec(f.slanted.up) + ' ' + dims(f.slanted.size));

    const arm = await page.evaluate(() => {
      const t = window.nsoTipOrient, b = document.getElementById('btn-tip-face');
      t.setArmed(false);
      const before = { armed: t.armed(), label: b.textContent.trim(),
                       pressed: b.getAttribute('aria-pressed') };
      b.click();
      const on = { armed: t.armed(), label: b.textContent.trim(),
                   pressed: b.getAttribute('aria-pressed'), cls: b.classList.contains('is-armed') };
      b.click();
      const off = { armed: t.armed(), label: b.textContent.trim() };
      return { before: before, on: on, off: off };
    });
    check('the button arms a pick and says so', arm.on.armed && arm.on.pressed === 'true' &&
      arm.on.cls && arm.on.label !== arm.before.label, JSON.stringify(arm.on));
    check('...and clicking it again puts it away', !arm.off.armed &&
      arm.off.label === arm.before.label, JSON.stringify(arm.off));
    check('it reuses the one-picker-at-a-time contract rather than a private copy',
      await page.evaluate(() => typeof window.nsoMaskDisarmOthers === 'function'));
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Tilt works by click, about the piece\'s own axes ===');
  {
    const t = await page.evaluate(() => {
      const p = state.placed[0];
      const zero = () => { p.tiltX = 0; p.tiltZ = 0; applyMeshRotation(p); };
      const out = {};
      zero(); document.getElementById('btn-tilt-up').click(); out.up = p.tiltX;
      zero(); document.getElementById('btn-tilt-dn').click(); out.dn = p.tiltX;
      zero(); document.getElementById('btn-bank-up').click(); out.bankUp = p.tiltZ;
      zero(); document.getElementById('btn-bank-dn').click(); out.bankDn = p.tiltZ;
      zero();
      out.labels = ['btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn']
        .map(i => document.getElementById(i).textContent.trim());
      return out;
    });
    /* From flat and un-turned, a plate-X turn is tiltX and a plate-Z turn
       is tiltZ, so the fields still read the step. Tilt → is -15 on Z: it
       lifts the left edge, as its title says (it used to be +15, lifting the
       right). tools/nso_pose_buttons_drive_check.js checks the edges. */
    check('each Tilt button still moves 15° on its own axis',
      t.up === 15 && t.dn === -15 && t.bankUp === -15 && t.bankDn === 15, JSON.stringify(t));
    check('all four now read as Tilt with a direction',
      t.labels.every(l => /^Tilt/.test(l)), t.labels.join(' | '));
    /* Tilt is not Rotate. Each press leans the piece 15° about the axis of
       one of Rotate's two lean rings - a level side of the piece's footprint
       as it lies at the press: its length (own X) for ↑/↓ and its width line
       (own Z) for ←/→ while it lies flat - and never about the plate's
       vertical, which is Rotate's Turn. On a piece a Tilt has already leaned
       the next Tilt is about the footprint's level side, not the own axis the
       first one tipped (app-rotate-handles.js leanAxes). It used to say so by
       leaving rotY alone; now that a Tilt is a turn decomposed back into the
       fields, a Tilt on a Tilt can spell part of itself in rotY, so the
       motion itself is what is checked. */
    const sep = await page.evaluate(() => {
      const p = state.placed[0];
      p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; applyMeshRotation(p);
      const q = () => { p.mesh.updateMatrixWorld(true); return p.mesh.quaternion.clone(); };
      const own = (b) => new THREE.Vector3().fromArray(b).applyQuaternion(q());
      const out = [];
      for (const [id, b, ring] of [['btn-tilt-up', [1, 0, 0], 'fb'], ['btn-bank-up', [0, 0, 1], 'ss'],
                                   ['btn-tilt-dn', [1, 0, 0], 'fb'], ['btn-bank-dn', [0, 0, 1], 'ss']]) {
        const a = q(), ax = own(b), ring0 = new THREE.Vector3().fromArray(window.nsoRotate.ringAxis(ring));
        document.getElementById(id).click();
        const d = q().multiply(a.clone().invert());
        const s = Math.hypot(d.x, d.y, d.z);
        const dot = v => s ? Math.abs(d.x * v.x + d.y * v.y + d.z * v.z) / s : 0;
        out.push({ deg: 2 * Math.atan2(s, Math.abs(d.w)) * 180 / Math.PI,
                   own: dot(ax), ring: dot(ring0), up: s ? Math.abs(d.y) / s : 0 });
      }
      p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; applyMeshRotation(p);
      return out;
    });
    check('every Tilt press is a 15° turn about its lean ring\'s axis at the press - a level line, never the vertical',
      sep.every(r => Math.abs(r.deg - 15) < 1e-6 && Math.abs(r.ring - 1) < 1e-9 && r.up < 1e-9),
      sep.map(r => r.deg.toFixed(6) + '° |dot ring| ' + r.ring.toFixed(9) + ' up ' + r.up.toExponential(1)).join('; '));
    check('...the first, from flat, about the piece\'s own length exactly',
      Math.abs(sep[0].own - 1) < 1e-9, '|dot own X| ' + sep[0].own.toFixed(9));
    /* ...and on a piece turned 90°, Tilt ← still turns about the piece's
       own width line - which now runs along the plate's X. */
    const tz = await page.evaluate(() => {
      const p = state.placed[0];
      p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; applyMeshRotation(p);
      window.nsoRotate.turn('turn', 90);
      p.mesh.updateMatrixWorld(true);
      const a = p.mesh.quaternion.clone();
      const w = new THREE.Vector3(0, 0, 1).applyQuaternion(a);
      document.getElementById('btn-bank-dn').click();
      p.mesh.updateMatrixWorld(true);
      const d = p.mesh.quaternion.clone().multiply(a.invert());
      const s = Math.hypot(d.x, d.y, d.z);
      p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; applyMeshRotation(p);
      return { deg: 2 * Math.atan2(s, Math.abs(d.w)) * 180 / Math.PI,
               along: s ? Math.abs(d.x * w.x + d.y * w.y + d.z * w.z) / s : 0, x: s ? Math.abs(d.x) / s : 0 };
    });
    check('on a piece turned 90°, Tilt ← turns 15° about its own width line - now the plate\'s X',
      Math.abs(tz.deg - 15) < 1e-6 && Math.abs(tz.along - 1) < 1e-9 && Math.abs(tz.x - 1) < 1e-9,
      tz.deg.toFixed(6) + '°, |dot| ' + tz.along.toFixed(9));
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the arrow keys, scoped to this menu, with hold-to-repeat ===');
  {
    const k = await page.evaluate(() => {
      const p = state.placed[0], menu = document.getElementById('menu-tip');
      const zero = () => { p.tiltX = 0; p.tiltZ = 0; applyMeshRotation(p); };
      const fire = (key, repeat) => document.dispatchEvent(new KeyboardEvent('keydown',
        { key: key, repeat: !!repeat, bubbles: true, cancelable: true }));
      const out = {};
      /* SHUT: the keys are not ours. This is the whole point of scoping them
         - another tool can hold the same four arrows without a collision. */
      menu.open = false; zero(); fire('ArrowUp'); fire('ArrowLeft');
      out.shut = { tiltX: p.tiltX, tiltZ: p.tiltZ };
      menu.open = true;
      zero(); fire('ArrowUp');    out.up = p.tiltX;
      zero(); fire('ArrowDown');  out.down = p.tiltX;
      zero(); fire('ArrowRight'); out.right = p.tiltZ;
      zero(); fire('ArrowLeft');  out.left = p.tiltZ;
      zero(); for (let i = 0; i < 6; i++) fire('ArrowUp', true);
      out.held = p.tiltX;
      zero();
      const inp = document.querySelector('#menu-tip input, input[type="number"]');
      if (inp) { inp.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowUp', bubbles: true, cancelable: true })); }
      out.inField = p.tiltX;
      zero(); menu.open = false;
      return out;
    });
    check('with the menu SHUT the arrows do nothing here',
      k.shut.tiltX === 0 && k.shut.tiltZ === 0, JSON.stringify(k.shut));
    check('with it open, up/down tilt one axis by 15°', k.up === 15 && k.down === -15,
      'up ' + k.up + ', down ' + k.down);
    check('...and left/right tilt the other', k.right === -15 && k.left === 15,
      'right ' + k.right + ', left ' + k.left);
    check('holding an arrow keeps tilting - 6 repeats give 90°', k.held === 90, k.held + '°');
    check('arrows typed into a field still belong to the field', k.inField === 0, k.inField + '°');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. Flat is gone and nothing is left pointing at it ===');
  {
    const gone = await page.evaluate(() => ({
      button: !!document.getElementById('btn-roll'),
      inTipMenu: [...document.querySelectorAll('#menu-tip button')].map(b => b.id)
    }));
    check('the Flat button is not on the page', !gone.button);
    check('the Tip menu holds the four orientations and the four tilts',
      gone.inTipMenu.length === 8, gone.inTipMenu.join(', '));

    /* The rosters that listed it by name. A stale id in one of these is a
       button that never gets enabled, or a lock that silently stops
       covering a control - neither shows up as an error. */
    const rosters = [
      ['app-core.js', /'btn-roll'/],
      ['app-poslock.js', /'btn-roll'/],
      ['tools/nso_poslock_test.js', /'btn-roll'/],
      ['tools/nso_multilock_test.js', /'btn-roll'/]
    ];
    rosters.forEach(([f, re]) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      check(f + ' no longer lists btn-roll', !re.test(src));
    });
    const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    check('app-core\'s enable roster lists the two new buttons instead',
      /'btn-flip-over', 'btn-tip-face'/.test(core));
    const lock = fs.readFileSync(path.join(ROOT, 'app-poslock.js'), 'utf8');
    check('and the position lock covers them too',
      /'btn-flip-over', 'btn-tip-face'/.test(lock));
    /* rollSelected still exists for its own callers - retiring a button is
       not the same as deleting the function behind it. */
    check('rollSelected() itself is still there, just not on a button',
      /function rollSelected\(/.test(core) && !/getElementById\('btn-roll'\)/.test(
        fs.readFileSync(path.join(ROOT, 'app-join.js'), 'utf8')));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
