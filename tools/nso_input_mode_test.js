#!/usr/bin/env node
/* One menu owns the input - driven in the real page.

   node tools/nso_input_mode_test.js        exit 0 = every gate held

   THE REGRESSION THIS PINS. Rotate, Tip/Tilt and Move each added a tool that
   wants the bare arrow keys and a click on the selected piece, and each
   scoped itself by reading its own `<details open>`. Every guard was right on
   its own and the set of them was not:

     - two <details> can be open at once, because the accordion that closes
       the others runs off `toggle` and toggle is dispatched a task late, so
       one ArrowUp was answered twice - Tilt's 15 degrees AND Rotate's one;
     - only the KEYBOARD was ever scoped. Rotate's grab ball and arcs were
       drawn on whatever was selected and app-core hit-tests them ahead of
       select-and-drag, so they appeared unasked in Tip and Move and a drag
       there rotated the piece;
     - the modes outlived their menus: Tip on face stayed armed, so a click
       anywhere re-seated the piece, and Vertical stayed on, so free drag went
       on being refused from menus that could not turn it off.

   So the checks below are mostly of the form "open A, use it, switch to B,
   and show that nothing of A's answers any more". A check that only opened
   one menu at a time could not have caught any of this.

   RUN AGAINST THE MERGE THIS FIX SITS ON, sections 1 to 7 fail - 17 gates.
   Section 8 PASSES on both trees, and that is the point of it being here: the
   lag came in with the phantom guide and the tempting reading was that the
   new geometry had made the page slow. It had not. A pointermove costs the
   same 4 microseconds with these guides in the scene or stripped out of it,
   and the render loop never stalled. The clicks were being swallowed or
   refused, not delayed, and the cure is scoping rather than optimising. The
   numbers are gated here so a later change cannot quietly make that untrue.

   WHAT IS NOT HERE: what each tool DOES. The dial, the detents, the tilt
   steps, the 0.25 mm micro-nudge and the lateral frame all have their own
   suites - nso_rotate_handles_test.js, nso_tip_orient_test.js and
   nso_move_vertical_test.js. This is about who is listening. */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const MENUS = ['menu-rotate', 'menu-tip', 'menu-move'];

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => selectPlaced(0));
  await page.waitForTimeout(300);

  /* WHO OWNS THE INPUT, computed without asking the arbiter.

     Everything below section 1 is about BEHAVIOUR, and has to be runnable
     against a tree that does not have app-input-mode.js on it - otherwise the
     only thing this file proves is that a file exists. The fallback is what
     the three modules were each computing for themselves before the arbiter:
     the one open top-bar menu, and nobody when that is ambiguous. Run against
     the merge this fix sits on, sections 2 to 8 fail on their own terms. */
  await page.evaluate(() => {
    window.__owner = function () {
      if (window.nsoInputMode) return window.nsoInputMode.active();
      var o = [].slice.call(
        document.querySelectorAll('.viewport-overlay-topbar .vp-top-menu'))
        .filter(function (d) { return d.open; });
      return o.length === 1 ? (o[0].id || null) : null;
    };
  });

  /* Clicking the summary, not setting .open - the accordion and the arbiter
     both have to survive the way a person actually switches menus. */
  const goTo = async (id) => {
    const already = await page.evaluate(i => {
      const d = document.getElementById(i);
      return !!(d && d.open);
    }, id);
    if (!already) await page.click('#' + id + ' > summary');
    await page.waitForTimeout(150);
  };
  const shutAll = async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.viewport-overlay-topbar details').forEach(d => { d.open = false; });
    });
    await page.waitForTimeout(120);
  };
  const zero = () => page.evaluate(() => {
    const p = state.placed[0];
    p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.flipX = false; p.liftY = 0;
    applyMeshRotation(p); refreshOutline(p);
  });
  const pose = () => page.evaluate(() => {
    const p = state.placed[0];
    return { tiltX: +(p.tiltX || 0).toFixed(6), tiltZ: +(p.tiltZ || 0).toFixed(6),
             rotY: +(p.rotY || 0).toFixed(6), liftY: +(p.liftY || 0).toFixed(6),
             x: +(p.x || 0).toFixed(6), z: +(p.z || 0).toFixed(6) };
  });
  const same = (a, b) => Object.keys(a).every(k => Math.abs(a[k] - b[k]) < 1e-9);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the arbiter is on the page and every menu tool is registered ===');
  {
    const r = await page.evaluate(() => ({
      api: typeof window.nsoInputMode,
      registered: window.nsoInputMode ? window.nsoInputMode.registered() : null
    }));
    check('nsoInputMode exists', r.api === 'object', 'typeof = ' + r.api);
    check('all three menu tools registered with it',
      !!r.registered && MENUS.every(m => r.registered.indexOf(m) !== -1),
      JSON.stringify(r.registered));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. exactly one owner, and only its own guide is in the scene ===');
  {
    for (const m of MENUS) {
      await goTo(m);
      const s = await page.evaluate(() => {
        const g = n => state.scene.getObjectByName(n);
        const rot = g('nso-rotate-handles'), mv = g('nso-move-arrows');
        return {
          active: window.__owner(),
          openCount: [...document.querySelectorAll('.viewport-overlay-topbar .vp-top-menu')]
            .filter(d => d.open).length,
          rotParts: rot ? rot.children.length : 0,
          mvParts: (mv && mv.visible) ? mv.children.length : 0
        };
      });
      check(m + ' is the sole owner', s.active === m && s.openCount === 1,
        'active=' + s.active + ', ' + s.openCount + ' open');
      const wantRot = m === 'menu-rotate', wantMv = m === 'menu-move';
      check('  rotate guide ' + (wantRot ? 'drawn' : 'gone from the scene'),
        wantRot ? s.rotParts > 0 : s.rotParts === 0, s.rotParts + ' parts');
      check('  move arrows ' + (wantMv ? 'drawn' : 'gone'),
        wantMv ? s.mvParts === 4 : s.mvParts === 0, s.mvParts + ' arrows');
    }
    await shutAll();
    const none = await page.evaluate(() => {
      const g = n => state.scene.getObjectByName(n);
      return { active: window.__owner(),
               rot: (g('nso-rotate-handles') || { children: [] }).children.length,
               mv: (g('nso-move-arrows') || {}).visible === true };
    });
    check('with every menu shut nobody owns the input and nothing is drawn',
      none.active === null && none.rot === 0 && none.mv === false, JSON.stringify(none));
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. ONE arrow press is answered once, even with two menus forced open ===');
  {
    /* The regression, exactly: `.open = true` twice in one turn is a state
       the toggle-driven accordion could not have cleared in time, and both
       Rotate's and Tilt's guards read true in it. */
    const d = await page.evaluate(() => {
      document.querySelectorAll('.viewport-overlay-topbar details').forEach(x => { x.open = false; });
      const p = state.placed[0];
      p.tiltX = 0; p.tiltZ = 0; p.rotY = 0; p.tipX = 0; p.tipZ = 0; p.flipX = false;
      applyMeshRotation(p);
      document.getElementById('menu-rotate').open = true;
      document.getElementById('menu-tip').open = true;
      document.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'ArrowUp', bubbles: true, cancelable: true }));
      return { tiltX: +p.tiltX.toFixed(6), rotYdeg: +(p.rotY * 180 / Math.PI).toFixed(6),
               openAfter: [...document.querySelectorAll('.viewport-overlay-topbar .vp-top-menu')]
                 .filter(x => x.open).map(x => x.id) };
    });
    const answered = (Math.abs(d.tiltX) > 1e-9 ? 1 : 0) + (Math.abs(d.rotYdeg) > 1e-9 ? 1 : 0);
    check('one press moved exactly one axis, not two',
      answered === 1, 'tiltX ' + d.tiltX + '°, rotY ' + d.rotYdeg + '°');
    check('...and the ambiguity was collapsed in the same turn, not a task later',
      d.openAfter.length === 1, JSON.stringify(d.openAfter));
    await zero();
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the drive: open each menu in turn, and prove the last one is deaf ===');
  {
    /* Arm whatever the menu has to arm, so there is something real left to
       leak, then leave and fire that tool's own input at the piece. */
    const use = {
      'menu-rotate': async () => { /* the guide is the state; nothing to arm */ },
      'menu-tip': async () => { await page.click('#btn-tip-face'); await page.waitForTimeout(100); },
      'menu-move': async () => { await page.click('#chk-move-vertical'); await page.waitForTimeout(150); }
    };

    for (const from of MENUS) {
      for (const to of MENUS) {
        if (from === to) continue;
        await goTo(from);
        await use[from]();
        await goTo(to);
        await zero();
        const before = await pose();

        /* (a) ArrowUp. All three menus claim it, so what is measured is not
               "did anything move" but "did EXACTLY the new owner's effect
               happen". A residual listener shows up as a second field moving
               alongside the right one - which is precisely what the bug did,
               15 degrees of tilt and a degree of yaw off one press. */
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(80);
        const afterKey = await pose();
        const moved = Object.keys(before).filter(k => Math.abs(afterKey[k] - before[k]) > 1e-9);
        /* Rotate's ArrowUp nudges Y; Tilt's lifts an edge 15 degrees about X;
           Move's does nothing at all with the Vertical box clear, which is
           what leaving the Move menu leaves it. */
        const expect = { 'menu-rotate': ['rotY'], 'menu-tip': ['tiltX'], 'menu-move': [] }[to];
        check('  ...one ArrowUp moves ' + (expect.length ? expect.join('+') : 'nothing') +
          ' and nothing else',
          moved.length === expect.length && expect.every(k => moved.indexOf(k) !== -1),
          'moved: ' + (moved.length ? moved.join(', ') : 'nothing'));

        /* (b) a drag where `from`'s grab target used to be - the piece's own
               centre for Move, the rotate ball's last screen point for
               Rotate, a face of the piece for Tip on face. All three land on
               or beside the piece, which is where every one of these tools
               put its affordance. */
        const at = await page.evaluate(() => {
          const p = state.placed[0];
          const r = state.renderer.domElement.getBoundingClientRect();
          const v = p.mesh.position.clone().project(state.camera);
          return { x: r.left + (v.x * .5 + .5) * r.width, y: r.top + (-v.y * .5 + .5) * r.height };
        });
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + 40, at.y + 30, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(100);
        const afterDrag = await pose();

        const owner = await page.evaluate(() => window.__owner());
        check(from + ' -> ' + to + ': ' + to + ' owns the input',
          owner === to, 'active=' + owner);
        /* Rotation is the one that must not happen off a drag: only Rotate's
           ball and Tip on face can turn a piece, and neither is `to`'s. */
        const turned = Math.abs(afterDrag.tiltX - afterKey.tiltX) > 1e-9 ||
                       Math.abs(afterDrag.rotY - afterKey.rotY) > 1e-9 ||
                       Math.abs(afterDrag.tiltZ - afterKey.tiltZ) > 1e-9;
        check('  ...and a drag on the piece does not turn it',
          to === 'menu-rotate' ? true : !turned,
          'tiltX ' + afterKey.tiltX + '->' + afterDrag.tiltX +
          ', rotY ' + afterKey.rotY + '->' + afterDrag.rotY +
          ', tiltZ ' + afterKey.tiltZ + '->' + afterDrag.tiltZ);

        /* and the modes themselves are down, not merely hidden */
        const residue = await page.evaluate(() => ({
          tipArmed: !!state.tipFaceArmed,
          tipBtn: (document.getElementById('btn-tip-face') || {}).textContent,
          vertical: !!state.moveVertical,
          vertBox: (document.getElementById('chk-move-vertical') || {}).checked,
          slider: !(document.getElementById('move-vert-wrap') || { hidden: true }).hidden,
          rotParts: (state.scene.getObjectByName('nso-rotate-handles') || { children: [] }).children.length
        }));
        if (from === 'menu-tip')
          check('  ...Tip on face is disarmed and its button says so',
            !residue.tipArmed && residue.tipBtn === 'Tip on face', JSON.stringify(residue));
        if (from === 'menu-move')
          check('  ...Vertical is off, box clear, slider put away',
            !residue.vertical && !residue.vertBox && !residue.slider, JSON.stringify(residue));
        if (from === 'menu-rotate')
          check('  ...the rotate guide is emptied, not hidden',
            to === 'menu-rotate' || residue.rotParts === 0, residue.rotParts + ' parts left');
      }
    }
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. free drag comes back the moment Vertical stops owning the input ===');
  {
    await goTo('menu-move');
    await page.click('#chk-move-vertical');
    await page.waitForTimeout(150);
    const on = await page.evaluate(() => !!state.moveVertical);
    check('Vertical is on inside the Move menu', on);
    await goTo('menu-tip');
    const off = await page.evaluate(() => !!state.moveVertical);
    check('...and it is off again the moment the Move menu is left', off === false);
    /* Vertical swings the camera to eye level and deliberately leaves it
       there, so put the ordinary three-quarter view back before asking for a
       drag: startMoveDrag needs a ray that meets the bed, and a horizon
       camera does not give it one. That is the mode's own documented
       behaviour, not the residue this file is hunting. */
    const at = await page.evaluate(() => {
      state.camera.position.set(160, 180, 200);
      state.controls.target.set(0, 0, 0);
      state.controls.update();
      state.camera.updateMatrixWorld(true);
      const p = state.placed[0];
      const r = state.renderer.domElement.getBoundingClientRect();
      const v = p.mesh.position.clone().project(state.camera);
      return { sx: r.left + (v.x * .5 + .5) * r.width, sy: r.top + (-v.y * .5 + .5) * r.height };
    });
    await page.waitForTimeout(120);
    await page.mouse.move(at.sx, at.sy);
    await page.mouse.down();
    await page.mouse.move(at.sx + 50, at.sy + 20, { steps: 8 });
    const dragging = await page.evaluate(() => !!state.moveDragging);
    await page.mouse.up();
    await page.waitForTimeout(100);
    check('a free drag starts again once Move is left', dragging === true);
    const st = await page.evaluate(() => document.getElementById('status').textContent);
    check('...and no refusal naming a menu the user has left',
      !/Vertical placement is on/.test(st || ''), JSON.stringify(st));
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the open menu\'s guide follows the selection, and goes with it ===');
  {
    await page.evaluate(() => {
      /* a second piece, so there is somewhere for the selection to go */
      if (state.placed.length < 2 && typeof cloneSelectedModel === 'function') cloneSelectedModel();
    });
    await page.waitForTimeout(400);
    const n = await page.evaluate(() => state.placed.length);

    await goTo('menu-rotate');
    await page.evaluate(() => selectPlaced(0));
    await page.waitForTimeout(150);
    let d = await page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-rotate-handles');
      return g && state.placed[0] ? +g.position.distanceTo(state.placed[0].mesh.position).toFixed(6) : null;
    });
    check('the rotate guide sits on the selected piece', d === 0, String(d));
    if (n > 1) {
      await page.evaluate(() => selectPlaced(1));
      await page.waitForTimeout(200);
      d = await page.evaluate(() => {
        const g = state.scene.getObjectByName('nso-rotate-handles');
        return g && state.placed[1] ? +g.position.distanceTo(state.placed[1].mesh.position).toFixed(6) : null;
      });
      check('...and moves to the next one selected', d === 0, String(d));
    }

    await goTo('menu-move');
    await page.evaluate(() => selectPlaced(0));
    await page.waitForTimeout(200);
    const near0 = await page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-move-arrows');
      return g && state.placed[0]
        ? +Math.hypot(g.position.x - state.placed[0].mesh.position.x,
                      g.position.z - state.placed[0].mesh.position.z).toFixed(6) : null;
    });
    check('the move arrows follow the selection too - the line in selectPlaced ' +
      'named one module and now asks the arbiter', near0 === 0, String(near0));

    await page.evaluate(() => selectPlaced(-1));
    await page.waitForTimeout(200);
    const orphan = await page.evaluate(() => {
      const g = state.scene.getObjectByName('nso-move-arrows');
      return { visible: !!(g && g.visible), parts: g ? g.children.length : 0 };
    });
    check('with nothing selected the arrows are gone, not left floating',
      !orphan.visible && orphan.parts === 0, JSON.stringify(orphan));
    await page.evaluate(() => selectPlaced(0));
    await page.waitForTimeout(150);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. Tip on face is in the shared disarm contract ===');
  {
    /* app-mask's disarmOthers is how every click-on-a-piece picker puts the
       others away. Tip on face was calling it and not listed in it, so arming
       another tool left Tip armed behind it - and app-core routes Tip first. */
    await goTo('menu-tip');
    await page.click('#btn-tip-face');
    await page.waitForTimeout(100);
    const armed = await page.evaluate(() => !!state.tipFaceArmed);
    check('Tip on face arms', armed);
    const after = await page.evaluate(() => {
      window.nsoMaskDisarmOthers();
      return { armed: !!state.tipFaceArmed,
               label: (document.getElementById('btn-tip-face') || {}).textContent,
               pressed: (document.getElementById('btn-tip-face') || {}).getAttribute('aria-pressed') };
    });
    check('nsoMaskDisarmOthers puts it away, through its own button',
      !after.armed && after.label === 'Tip on face' && after.pressed === 'false',
      JSON.stringify(after));
    const src = require('fs').readFileSync(path.join(ROOT, 'app-mask.js'), 'utf8');
    check('...and it is named in the contract, not only cleared by accident',
      /tipFaceArmed/.test(src));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. responsiveness: what the guides actually cost ===');
  {
    /* The lag report came in with the phantom guide and the phantom rotation,
       and the tempting reading was that the new geometry had made the page
       slow. It had not, and that matters: it means the cure is scoping, not
       optimising. These numbers are what say so - a burst of real events
       through the real handlers, in the menu that draws the most. */
    await goTo('menu-move');
    const cost = await page.evaluate(() => {
      const mv = n => new PointerEvent(n, { clientX: 700, clientY: 450, bubbles: true, cancelable: true });
      for (let i = 0; i < 50; i++) window.dispatchEvent(mv('pointermove'));    // warm
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) window.dispatchEvent(mv('pointermove'));
      const perMove = (performance.now() - t0) / 400;
      /* A synthesized pointerdown has no live pointer behind it, and
         OrbitControls calls setPointerCapture on one without a guard - so the
         burst below would fill the console with DOMExceptions that say
         nothing about this app. Stubbed for the measurement and put straight
         back; every handler under test still runs in full. */
      const real = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function () {};
      const c = state.renderer.domElement;
      const t1 = performance.now();
      for (let i = 0; i < 100; i++) { c.dispatchEvent(mv('pointerdown')); window.dispatchEvent(mv('pointerup')); }
      const perClick = (performance.now() - t1) / 100;
      Element.prototype.setPointerCapture = real;
      return { perMoveMs: +perMove.toFixed(4), perClickMs: +perClick.toFixed(4) };
    });
    check('a pointermove costs well under a frame', cost.perMoveMs < 2,
      cost.perMoveMs + ' ms');
    check('a click costs well under a frame', cost.perClickMs < 5, cost.perClickMs + ' ms');

    /* A stall is a requestAnimationFrame tick the app's loop did not draw on,
       so that is what is counted: the main renderer's render() calls between
       one tick and the next, over 60 ticks. Not frames a second against a
       clock - that is the shared runner's speed, and on a starved shard it
       read 15 against a bar of 15 with every tick drawn. The rate is still
       logged, as a finding, so drift shows. */
    const ticks = await page.evaluate(() => new Promise(res => {
      const r = state.renderer, orig = r.render;
      let renders = 0, last = -1;
      const drew = [];
      r.render = function () { renders++; return orig.apply(this, arguments); };
      const t0 = performance.now();
      (function tick() {
        if (last >= 0) drew.push(renders - last);
        last = renders;
        if (drew.length < 60) { requestAnimationFrame(tick); return; }
        r.render = orig;
        res({ drew, ms: performance.now() - t0 });
      })();
    }));
    const skipped = ticks.drew.filter(n => n < 1).length;
    console.log('  FINDING the render loop ran ' + (60 / ticks.ms * 1000).toFixed(1) +
      ' fps on the clock (swiftshader): 60 ticks in ' + Math.round(ticks.ms) + ' ms');
    check('the render loop is not stalled: it drew on every one of 60 ticks', skipped === 0,
      skipped + ' skipped; renders per tick ' + JSON.stringify([...new Set(ticks.drew)]));

    const residue = await page.evaluate(() => {
      let n = 0;
      state.scene.traverse(() => n++);
      return n;
    });
    await shutAll();
    const resting = await page.evaluate(() => {
      let n = 0;
      state.scene.traverse(() => n++);
      return n;
    });
    check('shutting every menu takes the guides back out of the scene',
      resting < residue, residue + ' objects with Move open, ' + resting + ' with none');
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  if (errs.length) { console.log('\npage errors:\n' + errs.join('\n')); fails++; }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
