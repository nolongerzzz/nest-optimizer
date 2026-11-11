#!/usr/bin/env node
/* G-scope: the browser's own right-click menu opens only on the web-tools bubble - never over a disabled control.

   Some browsers deliver no mouse event to a disabled form control, so the page's guard (app-core.js
   wireNativeMenuGate: the capture-phase contextmenu that cancels the browser menu outside [data-native-menu]) never
   heard a right-click on G-scope's disabled Back, Region, Isolate, Clear boxes, Whole part or Export, and the browser
   menu opened (the owner, 2026-11-11). Disabled controls in G-scope now take no pointer (styles.css), and what is
   behind each one catches it: its card, the corner row, Back's holder - never the 3D view.

   GATES
     1. Every visible disabled control in G-scope: the element at its centre is not the control (it takes no pointer)
        and not a canvas (a click there would be the 3D view's).
     2. A real right-click on each is cancelled by the guard (the event reaches the page, defaultPrevented).
     3. A right-click on the web-tools bubble is not cancelled: the browser menu is still offered there.

     node tools/nso_gscope_native_menu_test.js        exit 0 = every gate held */
'use strict';
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!cond) fails++; };
const J = JSON.stringify;

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('#btn-microscope');
  await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  // the page's own record of every contextmenu, after the guard has run (bubble phase, on window)
  await page.evaluate(() => { window.__ctx = []; window.addEventListener('contextmenu', (e) => { window.__ctx.push({ prevented: e.defaultPrevented }); }); });

  const ctl = await page.evaluate(() => [...document.querySelectorAll('#microscope button:disabled, #microscope input:disabled, #microscope select:disabled')]
    .filter((b) => b.offsetParent && b.getBoundingClientRect().width > 0)
    .map((b) => {
      const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, e = document.elementFromPoint(x, y);
      return { id: b.id || b.textContent.trim().slice(0, 16), x, y, self: e === b || b.contains(e), canvas: !!e && e.tagName === 'CANVAS', under: e ? (e.id || e.className || e.tagName) : null };
    }));
  console.log('\n=== 1. what is under each disabled control ===');
  check('there are disabled controls to try (' + ctl.map((c) => c.id).join(', ') + ')', ctl.length >= 4, J(ctl.length));
  const bad = ctl.filter((c) => c.self || c.canvas);
  check('none takes the pointer itself, none lets it through to the 3D view', bad.length === 0, J(bad));

  console.log('\n=== 2. a right-click on each ===');
  const missed = [];
  for (const c of ctl) {
    await page.evaluate(() => { window.__ctx = []; });
    await page.mouse.click(c.x, c.y, { button: 'right' });
    const got = await page.evaluate(() => window.__ctx);
    if (!(got.length === 1 && got[0].prevented)) missed.push({ id: c.id, got });
  }
  check('every one reaches the guard and is cancelled (' + ctl.length + ')', missed.length === 0, J(missed));

  console.log('\n=== 3. the web-tools bubble ===');
  const bub = await page.evaluate(() => { const b = [...document.querySelectorAll('#microscope [data-native-menu]')].find((x) => x.offsetParent); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.evaluate(() => { window.__ctx = []; });
  if (bub) await page.mouse.click(bub.x, bub.y, { button: 'right' });
  const onBub = await page.evaluate(() => window.__ctx);
  check('a right-click there is not cancelled (the browser menu is offered)', !!bub && onBub.length === 1 && !onBub[0].prevented, J({ bub, onBub }));

  check('no page errors', logs.filter((l) => /^\[pageerror\]/.test(l)).length === 0, logs.filter((l) => /^\[pageerror\]/.test(l)).slice(0, 3).join(' | '));
  console.log(fails ? '\nFAILED (' + fails + ')' : '\nall gates held');
  process.exitCode = fails ? 1 : 0;
});
