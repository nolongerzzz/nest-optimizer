#!/usr/bin/env node
/* The top bar: two rows that line up, one dropdown open at a time, and the
   one exception - Cut stays put while the cutter tool is live.
     node tools/nso_topbar_accordion_test.js     exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Every dropdown in the bar. Cut is last deliberately - it is last in the
   markup too, which is what made the stacking rule necessary. */
const BAR = ['menu-import', 'menu-export', 'menu-rotate', 'menu-tip',
             'menu-move', 'menu-photo', 'menu-gen', 'menu-scale', 'menu-cut'];

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);

  /* Open a dropdown the way a user would - a real click on its summary -
     except where that summary is physically underneath another dropdown's
     open panel, which no click can reach. There the summary is clicked
     through the DOM instead: the same toggle, the same accordion, minus
     the hit test. Section 2 pins exactly which pairs need that, so the
     substitution is visible rather than a quiet force-click everywhere. */
  const openMenu = async (id) => {
    const reachable = await page.evaluate((id) => {
      const sm = document.getElementById(id).querySelector('summary');
      const r = sm.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(el && el.closest('#' + id));
    }, id);
    if (reachable) await page.click('#' + id + ' > summary');
    else await page.evaluate((id) => document.getElementById(id).querySelector('summary').click(), id);
    return reachable;
  };

  const shutAll = () => page.evaluate((ids) => {
    ids.forEach(id => { const e = document.getElementById(id); if (e) e.open = false; });
    if (state.cutterOpen && typeof closeCutter === 'function') closeCutter(true);
  }, BAR);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the two rows start at the same left edge ===');
  {
    const r = await page.evaluate(() => {
      const bar = document.querySelector('.viewport-overlay-topbar');
      /* Group the bar's children by the top of their box: that is what a
         "row" is here, since the row break is a zero-height flex spacer
         rather than a container. Skip anything with no box at all (the
         break itself, and the hidden Remove button). */
      const rows = new Map();
      [...bar.children].forEach(e => {
        const b = e.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return;
        const key = Math.round(b.top);
        if (!rows.has(key) || b.left < rows.get(key).left) {
          rows.set(key, { left: +b.left.toFixed(1), id: e.id });
        }
      });
      const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, v]) => ({ y, ...v }));
      return { rows: ordered,
               indent: getComputedStyle(document.getElementById('menu-scale')).marginLeft };
    });
    check('the bar really does wrap to two rows', r.rows.length === 2,
      r.rows.map(x => 'y=' + x.y + ' ' + x.id).join(' | '));
    check('both rows start at the same x - no indent on the second',
      r.rows.length === 2 && Math.abs(r.rows[0].left - r.rows[1].left) < 0.5,
      r.rows.map(x => x.id + ' @ ' + x.left).join('  vs  '));
    check('...and it is zero by rule, not by accident of content',
      r.indent === '0px', 'margin-left ' + r.indent);

    /* The indent that used to align-break the rows was load-bearing for a
       reason its own comment got wrong: Scale's open panel covers the
       viewport's bottom-left tool column, Undo included. That column grows
       upward from the bottom, so at 900px tall the two clear each other
       and nothing looks broken - which is exactly how the first pass of
       this change shipped a buried Undo past every drive check that ran at
       900. Checked at a short viewport on purpose. */
    for (const h of [720, 900]) {
      await page.setViewportSize({ width: 1280, height: h });
      await page.waitForTimeout(250);
      const reach = await page.evaluate(() => {
        document.querySelectorAll('.vp-top-menu').forEach(d => { d.open = false; });
        document.getElementById('menu-scale').open = true;
        const blocked = [];
        ['btn-undo', 'btn-frame-view', 'btn-xray', 'btn-gcode'].forEach(id => {
          const e = document.getElementById(id);
          if (!e) return;
          const b = e.getBoundingClientRect();
          if (b.width < 1) return;
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          if (!hit || hit.id !== id) blocked.push(id + ' (covered by ' +
            (hit ? (hit.id || hit.className) : 'nothing') + ')');
        });
        document.getElementById('menu-scale').open = false;
        return blocked;
      });
      check('with Scale open at ' + h + 'px tall, the bottom-left tools stay clickable',
        reach.length === 0, reach.length ? reach.join('; ') : 'undo, frame, x-ray, g-code all reachable');
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(250);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. one open at a time, across the whole bar ===');
  {
    /* Every ordered pair, not just neighbours: nine menus, so 72 pairs. A
       rule that holds for Import->Export and nothing else would pass a
       spot check and fail in use. Driven by real clicks on the summaries,
       because that is the only thing a user can actually do - setting
       .open from script skips whatever a click would have run. */
    const bad = [];
    const occluded = [];
    for (const a of BAR) {
      for (const b of BAR) {
        if (a === b) continue;
        await shutAll();
        await page.click('#' + a + ' > summary');
        const reachable = await openMenu(b);
        if (!reachable) occluded.push(a.replace('menu-', '') + '->' + b.replace('menu-', ''));
        const st = await page.evaluate(([a, b]) => ({
          a: document.getElementById(a).open, b: document.getElementById(b).open
        }), [a, b]);
        if (st.a || !st.b) bad.push(a + '->' + b + (st.a ? ' (first stayed open)' : '') +
                                   (!st.b ? ' (second did not open)' : ''));
      }
    }
    check('opening any dropdown closes any other - all 72 ordered pairs',
      bad.length === 0, bad.length ? bad.slice(0, 6).join('; ') : '72/72');
    /* A wrapped bar puts row two's buttons directly under row one's open
       panels, so a few summaries cannot be clicked at all while a
       particular other menu is open. That is a layout matter, not an
       accordion one, and it long predates the row alignment - which in
       fact cut the list from five pairs to three. Pinned here so it stays
       three: if a later change grows it, this is what says so. */
    const EXPECTED_OCCLUDED = ['import->scale', 'import->cut', 'export->cut'];
    check('exactly the three known unreachable summaries, no more',
      occluded.length === EXPECTED_OCCLUDED.length &&
      EXPECTED_OCCLUDED.every(x => occluded.indexOf(x) !== -1),
      occluded.length ? occluded.join(', ') : 'none');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Cut is exempt, but only while the cutter is live ===');
  {
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(400);

    /* First the control: the dropdown open but the TOOL not started. This
       is the case that separates "the menu is special" from "the tool is
       special", and it is the one the whole feature turns on. */
    await shutAll();
    await openMenu('menu-cut');
    const toolOff = await page.evaluate(() => state.cutterOpen);
    await openMenu('menu-rotate');
    const asOrdinary = await page.evaluate(() => document.getElementById('menu-cut').open);
    check('with the cutter NOT started, Cut closes like any other dropdown',
      toolOff === false && asOrdinary === false,
      'cutter was ' + toolOff + ', menu left ' + (asOrdinary ? 'OPEN' : 'shut'));

    /* Now start the tool through its own button, the way a user does. */
    await shutAll();
    await openMenu('menu-cut');
    await page.click('#btn-cutter-open');
    await page.waitForTimeout(150);
    const live = await page.evaluate(() => ({
      cutter: state.cutterOpen, menu: document.getElementById('menu-cut').open
    }));
    check('the Open button starts the cutter and leaves Cut showing',
      live.cutter === true && live.menu === true, JSON.stringify(live));

    /* Every other dropdown in turn, each one opened while the cutter runs. */
    const closedIt = [];
    for (const other of BAR.filter(id => id !== 'menu-cut')) {
      await openMenu(other);
      await page.waitForTimeout(40);
      const st = await page.evaluate((o) => ({
        cut: document.getElementById('menu-cut').open,
        other: document.getElementById(o).open,
        cutter: state.cutterOpen
      }), other);
      if (!st.cut || !st.other || !st.cutter) {
        closedIt.push(other + ' ' + JSON.stringify(st));
      }
    }
    check('Cut stays open through every other dropdown, and they open too',
      closedIt.length === 0, closedIt.length ? closedIt.join('; ') : '8/8 left Cut alone');

    /* Both on screen at once - so which one can you actually click? */
    /* Opened by click and then given a turn to settle: the front-most class
       is applied from a `toggle` listener, and toggle is dispatched in a
       queued task. Measuring in the same turn as the open reads the page
       before the promotion has landed, and DOM order - which puts Cut, last
       in the bar, on top - is what you would see. That is the very thing
       this pair of gates is here to catch, so the measurement has to happen
       after the turn, not during it. */
    await openMenu('menu-export');
    await page.waitForTimeout(80);
    const stack = await page.evaluate(() => {
      const cut = document.getElementById('menu-cut');
      const exp = document.getElementById('menu-export');
      const eb = exp.querySelector('.vp-top-body').getBoundingClientRect();
      const cb = cut.querySelector('.vp-top-body').getBoundingClientRect();
      /* A point inside BOTH panels - the contested pixels. */
      const x = (Math.max(eb.left, cb.left) + Math.min(eb.right, cb.right)) / 2;
      const y = (Math.max(eb.top, cb.top) + Math.min(eb.bottom, cb.bottom)) / 2;
      const overlaps = Math.min(eb.right, cb.right) > Math.max(eb.left, cb.left) &&
                       Math.min(eb.bottom, cb.bottom) > Math.max(eb.top, cb.top);
      /* The whole stack at that pixel, not just the top element: which of
         the two panels comes first is the answer, and printing the rest
         makes a failure readable instead of a bare "neither". */
      const chain = document.elementsFromPoint(x, y);
      let winner = 'neither';
      for (const el of chain) {
        if (el.closest('#menu-export')) { winner = 'export'; break; }
        if (el.closest('#menu-cut')) { winner = 'cut'; break; }
      }
      return { overlaps: overlaps, bothOpen: exp.open && cut.open, winner: winner,
               front: exp.classList.contains('is-front') ? 'export'
                    : cut.classList.contains('is-front') ? 'cut' : 'none',
               chain: chain.slice(0, 4).map(e => e.id || e.className || e.tagName) };
    });
    check('Cut and Export really do overlap on screen - the case is real',
      stack.overlaps && stack.bothOpen, JSON.stringify(stack));
    check('...and the one just opened is the one on top, not pinned Cut',
      stack.winner === 'export' && stack.front === 'export',
      'hit test returned ' + stack.winner + ', front-most marked ' + stack.front +
      ', stack: ' + stack.chain.join(' > '));

    /* A deliberate click on Cut's own summary still collapses it. */
    await openMenu('menu-cut');
    const manual = await page.evaluate(() => ({
      menu: document.getElementById('menu-cut').open, cutter: state.cutterOpen
    }));
    check('a click on Cut\'s summary still closes it, cutter left running',
      manual.menu === false && manual.cutter === true, JSON.stringify(manual));

    /* And closing the tool closes the dropdown with it. */
    await openMenu('menu-cut');
    await page.click('#btn-cutter-close');
    await page.waitForTimeout(150);
    const done = await page.evaluate(() => ({
      menu: document.getElementById('menu-cut').open, cutter: state.cutterOpen
    }));
    check('closing the cutter closes Cut\'s dropdown too',
      done.menu === false && done.cutter === false, JSON.stringify(done));
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the other ways the cutter can go away ===');
  {
    /* closeCutter() is only one of four routes that clear state.cutterOpen;
       the un-pinning hangs on updateCutterUI() precisely because the other
       three never call closeCutter. Clear plate is one of them. */
    await shutAll();
    await openMenu('menu-cut');
    await page.click('#btn-cutter-open');
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => state.cutterOpen);
    await page.evaluate(() => clearPlateOnly());
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({
      menu: document.getElementById('menu-cut').open, cutter: state.cutterOpen
    }));
    check('Clear plate stops the cutter and un-pins Cut, though it never calls closeCutter',
      before === true && after.menu === false && after.cutter === false, JSON.stringify(after));
  }

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});
