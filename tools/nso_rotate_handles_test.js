#!/usr/bin/env node
/* Rotation handles, driven in the real page.

   node tools/nso_rotate_handles_test.js        exit 0 = every gate held

   The control is a dial: the pointer's angle about the guide's centre IS the
   rotation, so tracing 30 degrees turns the piece 30 degrees. The soft
   detents then displace what is SHOWN, by a bounded amount, which is why the
   raw accumulator and the displayed angle are checked separately - a test
   that only looked at the displayed angle could not tell a correct 1:1
   mapping with a detent from a wrong mapping without one.

   What is NOT here: the 90 degree buttons' own behaviour beyond proving this
   ticket left it alone. */

const path = require('path');
const { withApp, loadSTL, statusOf, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => selectPlaced(0));
  await page.waitForTimeout(300);

  const api = await page.evaluate(() => typeof window.nsoRotate);
  check('the module is on the page', api === 'object', 'typeof = ' + api);

  /* The Rotate menu open for the sections that count handles. The guide and
     its grab target belong to this menu now - "both axes locked leaves no
     handle at all" in section 4 says nothing unless there would have been
     one otherwise. Section 5 shuts it again on purpose, as its own subject. */
  await page.evaluate(() => { document.getElementById('menu-rotate').open = true; });
  await page.waitForTimeout(100);
  const K = await page.evaluate(() => window.nsoRotate.constants);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the dial maps traced degrees to rotation degrees ===');
  {
    const d = await page.evaluate(() => {
      const a = window.nsoRotate, cx = 700, cy = 450, R = 200;
      const at = deg => ({ x: cx + Math.cos(deg * Math.PI / 180) * R,
                           y: cy + Math.sin(deg * Math.PI / 180) * R });
      const trace = (axis, total) => {
        a.setAngle(axis, 0);
        const p0 = at(0);
        a.beginDrag(axis, p0.x, p0.y, cx, cy);
        for (let i = 1; i <= Math.abs(total); i++) {
          const q = at(Math.sign(total) * i);
          a.moveDrag(q.x, q.y);
        }
        const out = { raw: a.rawAngle(axis), shown: a.angleOf(axis) };
        a.endDrag();
        return out;
      };
      a.setLock('y', true);                 // X alone, so it is a dial not a ball
      const r = { x30: trace('x', 30), x90: trace('x', 90), xBack: trace('x', -30) };
      a.setLock('y', false); a.setLock('x', true);
      r.y30 = trace('y', 30);
      a.setLock('x', false);
      return r;
    });
    check('tracing 30° turns the piece 30°', near(d.x30.raw, 30, 0.01), d.x30.raw + '°');
    check('tracing 90° turns it 90°', near(d.x90.raw, 90, 0.01), d.x90.raw + '°');
    check('tracing backwards turns it back', near(d.xBack.raw, -30, 0.01), d.xBack.raw + '°');
    check('the same holds on the other axis', near(d.y30.raw, 30, 0.01), d.y30.raw + '°');
    check('a detent displaces what is shown, but never past S*R/4',
      Math.abs(d.x30.shown - d.x30.raw) <= K.SNAP_STRENGTH * K.SNAP_RADIUS_DEG / 4 + 1e-6,
      'traced ' + d.x30.raw + '° shown ' + d.x30.shown.toFixed(2) + '°');
    check('a detent itself is exactly reachable, not merely approached',
      near(d.x90.shown, 90, 1e-6), d.x90.shown + '°');
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. the arc window, its gradations and its detents ===');
  {
    const w = await page.evaluate(() => {
      const a = window.nsoRotate;
      return { at0: a.arcWindow(0), at10: a.arcWindow(10), at37: a.arcWindow(37),
               snap: [0, 1, 10, 22.4, 22.5, 30, 44, 45, 46, 90, 91].map(v =>
                 ({ in: v, out: a.softSnapDeg(v) })) };
    });
    check('the window shows ' + K.ARC_WINDOW_DEG + '° of path, not the whole circle',
      near(w.at0.span, K.ARC_WINDOW_DEG, 1e-9) && K.ARC_WINDOW_DEG < 360, w.at0.span + '°');
    check('most of it is the travel AHEAD of where you are',
      (w.at0.end - w.at0.at) > (w.at0.at - w.at0.start),
      (w.at0.at - w.at0.start) + '° behind, ' + (w.at0.end - w.at0.at) + '° ahead');
    check('the window scrolls with the angle rather than standing still',
      near(w.at10.start - w.at0.start, 10, 1e-9) && near(w.at37.start - w.at0.start, 37, 1e-9),
      w.at0.start + ' -> ' + w.at10.start + ' -> ' + w.at37.start);
    check('gradations are 1° apart',
      w.at0.ticks.length === K.ARC_WINDOW_DEG / K.TICK_DEG + 1, w.at0.ticks.length + ' ticks');
    const gaps = w.at0.ticks.slice(1).map((t, i) => +(t.deg - w.at0.ticks[i].deg).toFixed(6));
    check('...evenly, with no gap wrong', gaps.every(g => near(g, K.TICK_DEG, 1e-6)));
    check('...and they move with the window, not pinned to absolute positions',
      w.at10.ticks[0].deg !== w.at0.ticks[0].deg,
      w.at0.ticks[0].deg + ' -> ' + w.at10.ticks[0].deg);
    check('every 45° is marked as a detent',
      w.at0.ticks.filter(t => t.major).every(t => near(t.deg % K.SNAP_STEP_DEG, 0, 1e-6)));

    const s = w.snap;
    const f = v => s.find(e => e.in === v).out;
    check('the pull is zero AT a detent: f(0)=0, f(45)=45, f(90)=90',
      near(f(0), 0, 1e-9) && near(f(45), 45, 1e-9) && near(f(90), 90, 1e-9));
    check('it is continuous at the edge of the pull: f(R)=R',
      near(f(22.5), 22.5, 1e-9), 'f(22.5) = ' + f(22.5));
    check('it is a pull, not a stop - strictly increasing, so the piece always ' +
      'turns the way you did',
      s.every((e, i) => i === 0 || e.out > s[i - 1].out),
      s.map(e => e.in + '->' + e.out.toFixed(2)).join(' '));
    check('it pulls TOWARD the detent, never away',
      f(44) > 44 && f(46) < 46 && f(1) < 1,
      'f(44)=' + f(44).toFixed(2) + ' f(46)=' + f(46).toFixed(2) + ' f(1)=' + f(1).toFixed(2));
    check('it reuses the grid-snap constants rather than inventing new feel',
      K.SNAP_STRENGTH === 0.8 && near(K.SNAP_RADIUS_DEG, K.SNAP_STEP_DEG / 2, 1e-9));
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. both axes free is one trackball, not two dials ===');
  {
    const t = await page.evaluate(() => {
      const a = window.nsoRotate;
      a.setLock('x', false); a.setLock('y', false);
      const out = { mode: a.mode(), handles: a.handleCount() };
      a.setAngle('x', 0); a.setAngle('y', 0);
      a.beginDrag('trackball', 500, 400, 700, 450);
      a.moveDrag(600, 400);
      out.afterDx = { x: a.rawAngle('x'), y: a.rawAngle('y') };
      a.moveDrag(600, 500);
      out.afterDy = { x: a.rawAngle('x'), y: a.rawAngle('y') };
      a.moveDrag(650, 450);
      out.afterDiag = { x: a.rawAngle('x'), y: a.rawAngle('y') };
      a.endDrag();
      return out;
    });
    check('both axes free gives the trackball', t.mode === 'trackball', t.mode);
    check('a sideways drag turns Y and leaves X alone',
      t.afterDx.y !== 0 && t.afterDx.x === 0, JSON.stringify(t.afterDx));
    check('a vertical drag turns X and leaves Y alone',
      t.afterDy.x !== 0 && t.afterDy.y === t.afterDx.y, JSON.stringify(t.afterDy));
    check('a diagonal drag turns BOTH at once - the thing two dials cannot do',
      t.afterDiag.x !== t.afterDy.x && t.afterDiag.y !== t.afterDy.y,
      JSON.stringify(t.afterDiag));

    /* Task 7. There was no freehand rotation of a placed piece before this,
       so there is no old number to compare against; what is pinned is the
       relationship the ticket asked for - Y, the axis that runs away,
       deliberately slower than X. */
    check('Y is tuned calmer than X, and by a real margin',
      K.GAIN_Y_DEG_PER_PX < K.GAIN_X_DEG_PER_PX * 0.75,
      'X ' + K.GAIN_X_DEG_PER_PX + ' °/px vs Y ' + K.GAIN_Y_DEG_PER_PX + ' °/px');
    check('...but not so slow it is sluggish', K.GAIN_Y_DEG_PER_PX >= 0.15,
      K.GAIN_Y_DEG_PER_PX + ' °/px');
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. each lock disables its own axis and only its own ===');
  {
    const l = await page.evaluate(() => {
      const a = window.nsoRotate, out = {};
      const probe = () => ({ mode: a.mode(), handles: a.handleCount() });
      a.setLock('x', false); a.setLock('y', false); out.free = probe();

      a.setLock('x', true);
      a.setAngle('x', 0); a.setAngle('y', 0);
      out.xLocked = probe();
      out.xLocked.nudgeX = a.nudge('x', 1);
      out.xLocked.xAfter = a.angleOf('x');
      out.xLocked.nudgeY = a.nudge('y', 1);
      out.xLocked.yAfter = a.angleOf('y');
      out.xLocked.dragX = a.beginDrag('x', 1, 1, 0, 0);
      out.xLocked.dragY = a.beginDrag('y', 1, 1, 0, 0); a.endDrag();

      a.setLock('x', false); a.setLock('y', true);
      a.setAngle('x', 0); a.setAngle('y', 0);
      out.yLocked = probe();
      out.yLocked.nudgeY = a.nudge('y', 1);
      out.yLocked.yAfter = a.angleOf('y');
      out.yLocked.nudgeX = a.nudge('x', 1);
      out.yLocked.xAfter = a.angleOf('x');

      a.setLock('x', true);
      a.setAngle('x', 0); a.setAngle('y', 0);
      out.both = probe();
      out.both.nudgeX = a.nudge('x', 1); out.both.nudgeY = a.nudge('y', 1);
      out.both.xAfter = a.angleOf('x'); out.both.yAfter = a.angleOf('y');
      a.setLock('x', false); a.setLock('y', false);
      return out;
    });
    check('X locked: the mode falls back to the Y dial', l.xLocked.mode === 'y', l.xLocked.mode);
    check('X locked: its nudge is refused and X does not move',
      l.xLocked.nudgeX === false && l.xLocked.xAfter === 0, JSON.stringify(l.xLocked));
    check('X locked: its handle cannot be grabbed', l.xLocked.dragX === false);
    check('X locked: Y is still completely free - nudge and grab both work',
      l.xLocked.nudgeY === true && l.xLocked.yAfter === 1 && l.xLocked.dragY === true);
    check('Y locked: the mode falls back to the X dial', l.yLocked.mode === 'x', l.yLocked.mode);
    check('Y locked: its nudge is refused, X still free',
      l.yLocked.nudgeY === false && l.yLocked.yAfter === 0 &&
      l.yLocked.nudgeX === true && l.yLocked.xAfter === 1, JSON.stringify(l.yLocked));
    check('both locked: nothing rotates and there is no handle at all',
      l.both.mode === 'none' && l.both.handles === 0 &&
      l.both.nudgeX === false && l.both.nudgeY === false &&
      l.both.xAfter === 0 && l.both.yAfter === 0, JSON.stringify(l.both));
    check('the locks are checkboxes that persist', await page.evaluate(() => {
      const a = window.nsoRotate;
      a.setLock('x', true);
      const chk = document.getElementById('chk-rot-lock-x');
      const shown = chk && chk.checked;
      a.setLock('x', false);
      return shown && chk && !chk.checked;
    }));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the arrow keys, including held down ===');
  {
    await page.evaluate(() => {
      window.nsoRotate.setLock('x', false); window.nsoRotate.setLock('y', false);
      window.nsoRotate.setAngle('x', 0); window.nsoRotate.setAngle('y', 0);
      document.body.focus();
    });

    /* SHUT first, and this control is not optional. The arrows are scoped to
       the Rotate menu because Tilt in app-tip-orient.js claims the same four
       keys off #menu-tip - unscoped, one press would rotate AND tilt the same
       piece. But every assertion below is of the form "the angle moved", and
       those all fail alike whether the scoping is wrong or the nudge is simply
       broken. Measuring the shut case first is what tells the two apart. */
    const shut = await page.evaluate(() => {
      const a = window.nsoRotate;
      document.getElementById('menu-rotate').open = false;
      a.setAngle('x', 0); a.setAngle('y', 0);
      ['ArrowRight', 'ArrowUp'].forEach(function (k) {
        document.dispatchEvent(new KeyboardEvent('keydown',
          { key: k, bubbles: true, cancelable: true }));
      });
      return { x: a.angleOf('x'), y: a.angleOf('y') };
    });
    check('with the Rotate menu SHUT the arrows are not ours',
      near(shut.x, 0, 1e-9) && near(shut.y, 0, 1e-9),
      'X ' + shut.x + '°, Y ' + shut.y + '°');

    await page.evaluate(() => { document.getElementById('menu-rotate').open = true; });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    let a = await page.evaluate(() => ({ x: window.nsoRotate.angleOf('x'),
                                         y: window.nsoRotate.angleOf('y') }));
    check('left/right nudge X by 1° a press', near(a.x, -1, 1e-6), 'X ' + a.x + '°');
    check('up/down nudge Y by 1° a press', near(a.y, -1, 1e-6), 'Y ' + a.y + '°');

    /* Held down, the OS delivers a stream of keydowns with repeat=true. The
       handler must not filter those - "hold to keep going" is exactly the
       absence of an event.repeat guard, so that is what is measured. */
    const rep = await page.evaluate(() => {
      const before = window.nsoRotate.angleOf('x');
      for (let i = 0; i < 12; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true }));
      }
      return { before: before, after: window.nsoRotate.angleOf('x') };
    });
    check('holding an arrow keeps nudging - 12 repeats move 12°',
      near(rep.after - rep.before, 12, 1e-6), rep.before + '° -> ' + rep.after + '°');

    const locked = await page.evaluate(() => {
      const a = window.nsoRotate;
      a.setLock('x', true);
      const before = a.angleOf('x');
      for (let i = 0; i < 5; i++) {
        document.dispatchEvent(new KeyboardEvent('keydown',
          { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true }));
      }
      const after = a.angleOf('x');
      a.setLock('x', false);
      return { before: before, after: after };
    });
    check('a locked axis ignores the keys, held or not',
      near(locked.after, locked.before, 1e-9), locked.before + '° -> ' + locked.after + '°');

    const typing = await page.evaluate(() => {
      const a = window.nsoRotate;
      a.setAngle('x', 0);
      const inp = document.getElementById('cut-mm') || document.querySelector('input[type="number"]');
      if (!inp) return null;
      inp.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowRight', bubbles: true, cancelable: true }));
      return a.angleOf('x');
    });
    check('arrows inside a text field still belong to the field',
      typing === null || near(typing, 0, 1e-9), 'X ' + typing + '°');

    // Leave it as it was found - the sections after this one drive the 90°
    // buttons, and an open menu is not their subject.
    await page.evaluate(() => { document.getElementById('menu-rotate').open = false; });
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the 90° buttons are untouched, and the locks do not reach them ===');
  {
    const b = await page.evaluate(() => {
      const a = window.nsoRotate, out = {};
      const yaw = () => +(((state.placed[0].rotY || 0) * 180 / Math.PI).toFixed(6));
      a.setLock('x', false); a.setLock('y', false);
      a.setAngle('y', 0);
      out.before = yaw();
      document.getElementById('btn-rot-right').click();
      out.afterRight = yaw();
      document.getElementById('btn-rot-left').click();
      out.afterLeft = yaw();
      /* The one that would catch this ticket over-reaching: a lock is about
         the HANDLE and the arrow keys. It must not quietly disable a button
         that has worked since long before any of this existed. */
      a.setLock('y', true);
      a.setAngle('y', 0);
      const pre = yaw();
      document.getElementById('btn-rot-right').click();
      out.lockedYawFrom = pre; out.lockedYawTo = yaw();
      a.setLock('y', false);
      return out;
    });
    check('90° right still turns exactly 90°', near(b.afterRight - b.before, 90, 1e-6),
      b.before + '° -> ' + b.afterRight + '°');
    check('90° left still turns it exactly back', near(b.afterLeft, b.before, 1e-6),
      b.afterRight + '° -> ' + b.afterLeft + '°');
    check('a Y lock does NOT disable the 90° button - different control, untouched',
      near(b.lockedYawTo - b.lockedYawFrom, 90, 1e-6),
      b.lockedYawFrom + '° -> ' + b.lockedYawTo + '°');
    const src = require('fs').readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    check('rotateSelected still moves by exactly a quarter turn in the source',
      /p\.rotY = \(p\.rotY \|\| 0\) \+ dir \* \(Math\.PI \/ 2\);/.test(src));
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. the handle is a separate grab target from the piece ===');
  {
    /* Open first, and that is part of the subject now rather than setup.
       The guide used to be drawn on whatever was selected for as long as it
       was selected - and app-core hit-tests it AHEAD of select-and-drag, so
       it was a live rotation control in the Tip and Move menus too, where
       nobody had asked for one. It belongs to this menu; see
       nso_input_mode_test.js for the cross-menu half of that. */
    const h = await page.evaluate(() => {
      const a = window.nsoRotate;
      document.getElementById('menu-rotate').open = true;
      a.setLock('x', false); a.setLock('y', false);
      a.refresh();
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return { exists: !!g, visible: !!(g && g.visible), kids: g ? g.children.length : 0,
               balls: g ? g.children.filter(c => c.userData.nsoRotateHandle).length : 0,
               follows: g && state.placed[0] ?
                 g.position.distanceTo(state.placed[0].mesh.position) : null };
    });
    check('the handles are in the scene as their own object', h.exists && h.visible);
    check('there is a ball to grab', h.balls >= 1, h.balls + ' ball(s), ' + h.kids + ' parts');
    check('the group sits on the selected piece', near(h.follows, 0, 1e-6), h.follows);

    /* And gone when the menu is - EMPTIED, not hidden. `visible` is the flag
       app-core's picker was already trusting, so hiding the group would have
       left the same grab target live under another menu. */
    const shut = await page.evaluate(() => {
      document.getElementById('menu-rotate').open = false;
      window.nsoRotate.refresh();
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return { visible: !!(g && g.visible), kids: g ? g.children.length : 0 };
    });
    check('with the menu shut there is no handle left in the scene at all',
      !shut.visible && shut.kids === 0, JSON.stringify(shut));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
