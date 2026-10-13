#!/usr/bin/env node
/* The drop-downs: one open on the whole page, and Cut's panel can be shut
   while the cutter stays armed.
     node tools/nso_topbar_accordion_test.js     exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Every top-level drop-down on the page: the row, the column, and Finish. */
const ROW = ['menu-import', 'menu-export', 'menu-rotate', 'menu-tip', 'menu-move',
             'menu-photo', 'menu-gen', 'menu-finish'];
const COL = ['menu-scale', 'menu-cut', 'menu-join', 'menu-align', 'menu-seat',
             'menu-abc', 'menu-bit', 'menu-plate', 'menu-pieces', 'menu-pack'];
const ALL = ROW.concat(COL);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(600);

  /* A real click on the summary, but only if nothing else is on top of it:
     a summary hidden under an open panel is a layout failure, and section 2
     counts them. */
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

  const shutAll = () => page.evaluate(() => {
    document.querySelectorAll('.vp-menu').forEach(d => { d.open = false; });
    if (state.cutterOpen && typeof closeCutter === 'function') closeCutter(true);
  });
  const openCount = () => page.evaluate(() => document.querySelectorAll('.vp-menu[open]').length);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. a panel never covers the bottom-left tools ===');
  {
    /* The panels open at one spot right of the column, so none of them can
       reach the tool column at the bottom-left (Undo, Frame, X-ray, G-scope,
       Watch) at any height. The left column itself does reach it on a short
       window - that is a known, separate collision and not this gate's. */
    for (const h of [720, 900]) {
      await page.setViewportSize({ width: 1280, height: h });
      await page.waitForTimeout(250);
      const hits = await page.evaluate((ids) => {
        const tools = ['btn-undo', 'btn-frame-view', 'btn-xray', 'btn-microscope', 'btn-watch']
          .map(id => document.getElementById(id)).filter(Boolean)
          .map(e => ({ id: e.id, r: e.getBoundingClientRect() }));
        const out = [];
        for (const id of ids) {
          document.querySelectorAll('.vp-menu').forEach(d => { d.open = false; });
          const d = document.getElementById(id);
          d.open = true;
          const b = d.querySelector(':scope > .vp-menu-body').getBoundingClientRect();
          tools.forEach(t => {
            if (Math.min(b.right, t.r.right) > Math.max(b.left, t.r.left) &&
                Math.min(b.bottom, t.r.bottom) > Math.max(b.top, t.r.top)) out.push(id + ' over ' + t.id);
          });
          d.open = false;
        }
        return out;
      }, ALL);
      check('at ' + h + 'px tall no panel overlaps a bottom-left tool', hits.length === 0,
        hits.length ? hits.slice(0, 6).join('; ') : ALL.length + ' panels clear');
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(250);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. one open at a time, across the whole page ===');
  {
    /* Real clicks first, the way a user goes: every drop-down in order, then
       back again in reverse. Each click must find its button uncovered and
       leave exactly that one panel open. */
    const walk = [];
    const occluded = [];
    for (const seq of [ALL, ALL.slice().reverse()]) {
      await shutAll();
      for (const id of seq) {
        if (!(await openMenu(id))) occluded.push(id);
        const st = await page.evaluate((id) => ({
          it: document.getElementById(id).open,
          n: document.querySelectorAll('.vp-menu[open]').length
        }), id);
        if (!st.it || st.n !== 1) walk.push(id + ' ' + JSON.stringify(st));
      }
    }
    check('clicking through every drop-down, forwards and back, leaves only the one clicked open',
      walk.length === 0, walk.length ? walk.slice(0, 6).join('; ') : (2 * ALL.length) + ' clicks');
    check('no button is ever under another drop-down\'s open panel',
      occluded.length === 0, occluded.length ? occluded.join(', ') : 'none');

    /* Then every ordered pair - 18 drop-downs, 306 pairs - by clicking the
       summaries in the page: the same click event and the same toggle a
       user's click runs, without a real mouse's ~0.7 s per click under
       SwiftShader. Measured after one macrotask, so the page has had every
       chance to settle - and after a microtask only, so the rule is shown
       to hold before the next event could arrive. */
    const res = await page.evaluate(async (ids) => {
      const tick = () => new Promise(r => setTimeout(r, 0));
      const bad = [], early = [], hidden = [];
      for (const a of ids) {
        for (const b of ids) {
          if (a === b) continue;
          document.querySelectorAll('.vp-menu').forEach(d => { d.open = false; });
          await tick();
          const A = document.getElementById(a), B = document.getElementById(b);
          A.querySelector(':scope > summary').click();
          await tick();
          const r = B.querySelector(':scope > summary').getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!top || !top.closest('#' + b)) hidden.push(a + '->' + b);
          B.querySelector(':scope > summary').click();
          await Promise.resolve();
          const n0 = document.querySelectorAll('.vp-menu[open]').length;
          if (n0 !== 1) early.push(a + '->' + b + ' n=' + n0);
          await tick();
          const n = document.querySelectorAll('.vp-menu[open]').length;
          if (A.open || !B.open || n !== 1) bad.push(a + '->' + b + ' a=' + A.open + ' b=' + B.open + ' n=' + n);
        }
      }
      return { bad, early, hidden };
    }, ALL);
    const pairs = ALL.length * (ALL.length - 1);
    check('opening any drop-down closes any other, one .vp-menu[open] left - all ' + pairs + ' ordered pairs',
      res.bad.length === 0, res.bad.length ? res.bad.slice(0, 6).join('; ') : pairs + '/' + pairs);
    check('...already true a microtask after the click, before any next event',
      res.early.length === 0, res.early.length ? res.early.slice(0, 6).join('; ') : pairs + '/' + pairs);
    check('...and with any one panel open, every other button is uncovered',
      res.hidden.length === 0, res.hidden.length ? res.hidden.slice(0, 6).join('; ') : 'none covered');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Gen+ keeps its nested menus ===');
  {
    await shutAll();
    await openMenu('menu-gen');
    const nested = [];
    for (const cls of ['.vp-wheel-menu', '.vp-stock-menu', '.vp-relief-menu']) {
      await page.click('#menu-gen ' + cls + ' > summary');
      await page.waitForTimeout(40);
      nested.push(await page.evaluate((cls) => ({
        gen: document.getElementById('menu-gen').open,
        it: document.querySelector('#menu-gen ' + cls).open,
        others: [...document.querySelectorAll('#menu-gen .vp-menu[open]')].length - 1
      }), cls));
    }
    check('opening Wheel, Stock or Picture leaves Gen+ open and shuts the other two',
      nested.every(n => n.gen && n.it && n.others === 0), JSON.stringify(nested));
    await openMenu('menu-seat');
    await page.waitForTimeout(40);
    check('opening another drop-down shuts Gen+ and whatever was open inside it',
      (await openCount()) === 1, (await openCount()) + ' open');
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. Cut: the panel hides, the cutter stays armed ===');
  {
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(400);

    await shutAll();
    await openMenu('menu-cut');
    const toolOff = await page.evaluate(() => state.cutterOpen);
    await openMenu('menu-rotate');
    const asOrdinary = await page.evaluate(() => document.getElementById('menu-cut').open);
    check('with the cutter NOT started, Cut closes like any other drop-down',
      toolOff === false && asOrdinary === false,
      'cutter was ' + toolOff + ', menu left ' + (asOrdinary ? 'OPEN' : 'shut'));

    await shutAll();
    await openMenu('menu-cut');
    await page.click('#btn-cutter-open');
    /* The blade goes on the selected piece. */
    await page.evaluate(() => selectPlaced(0));
    await page.waitForTimeout(150);
    /* Everything that makes up "the blade": the tool flag, the helper in the
       scene and where it sits, the slider's fraction and the axis. */
    const blade = () => page.evaluate(() => {
      const h = state.cutHelper;
      return {
        cutter: !!state.cutterOpen,
        helper: h ? h.uuid : null,
        inScene: !!(h && h.parent),
        pos: h ? h.position.toArray().map(v => +v.toFixed(4)) : null,
        rot: h ? [h.rotation.x, h.rotation.y, h.rotation.z].map(v => +v.toFixed(4)) : null,
        t: state.cutT, axis: state.cutAxis,
        slider: document.getElementById('cut-slider').value
      };
    });
    const live = await blade();
    check('the Open button starts the cutter and leaves Cut showing',
      live.cutter && live.inScene && !!live.helper && await page.evaluate(() => document.getElementById('menu-cut').open),
      JSON.stringify(live));

    /* Every other drop-down in turn: it opens, Cut's panel shuts, the blade
       does not move and the cutter stays armed. */
    const wrong = [];
    for (const other of ALL.filter(id => id !== 'menu-cut')) {
      await openMenu(other);
      await page.waitForTimeout(40);
      const st = await page.evaluate((o) => ({
        cut: document.getElementById('menu-cut').open,
        other: document.getElementById(o).open,
        n: document.querySelectorAll('.vp-menu[open]').length
      }), other);
      const now = await blade();
      if (st.cut || !st.other || st.n !== 1 || JSON.stringify(now) !== JSON.stringify(live)) {
        wrong.push(other + ' ' + JSON.stringify(st) + (JSON.stringify(now) !== JSON.stringify(live)
          ? ' blade ' + JSON.stringify(now) : ''));
      }
    }
    check('every other drop-down shuts Cut\'s panel, with the cutter armed and the blade unchanged',
      wrong.length === 0, wrong.length ? wrong.slice(0, 3).join('; ') : (ALL.length - 1) + '/' + (ALL.length - 1));

    /* Back to Cut: its panel shows again with the live cutter's controls. */
    await openMenu('menu-cut');
    await page.waitForTimeout(40);
    const back = await page.evaluate(() => {
      const r = document.getElementById('btn-cut').getBoundingClientRect();
      return {
        menu: document.getElementById('menu-cut').open,
        n: document.querySelectorAll('.vp-menu[open]').length,
        tools: document.getElementById('cutter-tools').classList.contains('is-open'),
        closeEnabled: !document.getElementById('btn-cutter-close').disabled,
        splitShown: r.width > 0 && r.height > 0
      };
    });
    check('reopening Cut shows its panel again, controls live',
      back.menu && back.n === 1 && back.tools && back.closeEnabled && back.splitShown,
      JSON.stringify(back));
    check('...and the blade is where it was', JSON.stringify(await blade()) === JSON.stringify(live));

    /* A deliberate click on Cut's own summary still collapses it. */
    await openMenu('menu-cut');
    const manual = await page.evaluate(() => ({
      menu: document.getElementById('menu-cut').open, cutter: state.cutterOpen
    }));
    check('a click on Cut\'s summary closes it, cutter left running',
      manual.menu === false && manual.cutter === true, JSON.stringify(manual));

    /* And closing the tool closes the drop-down with it. */
    await openMenu('menu-cut');
    await page.click('#btn-cutter-close');
    await page.waitForTimeout(150);
    const done = await page.evaluate(() => ({
      menu: document.getElementById('menu-cut').open, cutter: state.cutterOpen
    }));
    check('closing the cutter closes Cut\'s drop-down too',
      done.menu === false && done.cutter === false, JSON.stringify(done));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the other ways the cutter can go away ===');
  {
    /* closeCutter() is only one of four routes that clear state.cutterOpen;
       the closing hangs on updateCutterUI() precisely because the other
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
    check('Clear plate stops the cutter and closes Cut, though it never calls closeCutter',
      before === true && after.menu === false && after.cutter === false, JSON.stringify(after));
  }

  const errs = logs.filter(l => /^\[(error|pageerror)\]/.test(l));
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});
