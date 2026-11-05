#!/usr/bin/env node
/* The Import dropdown's library list: it must grow taller and scroll
   vertically as the catalog grows, and never grow sideways.

   Real regression: the panel is flex-direction:column (so a dropdown grows
   downward) but the base .vp-menu-body rule sets flex-wrap: wrap and
   nothing had overridden it for this one. Wrap in a COLUMN direction means
   "once the current column is taller than max-height, start a new column
   to the right" - which is what a constrained flex container does instead
   of just scrolling. Small catalogs never hit max-height, so this sat
   invisible until the library grew enough rows to trip it - exactly the
   "reverted to horizontal scroll after library additions" report.
     node tools/nso_import_scroll_test.js      exit 0 = every gate held */

const path = require('path');
const { withApp, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* Real window shapes, not one comfortable default - the toolbar and G-scope
   work each found a real collision invisible at 1400x900. Short heights are
   exactly when max-height is tightest and the wrap-to-a-new-column failure
   mode is most likely to trip. */
const SIZES = [[1680, 1050], [1400, 900], [1366, 768], [1280, 720], [1024, 768]];

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(500);
  await page.click('#menu-import > summary');
  await page.waitForTimeout(150);
  await page.click('#btn-library');
  await page.waitForTimeout(150);

  /* Every category open at once, the way a user who has been clicking
     around ends up - and the state that actually triggers the bug, since a
     single small category never grows tall enough to hit max-height. */
  const opened = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.library-sec')];
    secs.forEach(d => { if (d.tagName === 'DETAILS') d.open = true; });
    return secs.length;
  });
  check('every catalog category is present', opened >= 5, opened + ' categories');
  await page.waitForTimeout(250);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. no horizontal scroll, at real window shapes ===');
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const body = document.querySelector('#menu-import .vp-top-body');
      const items = document.querySelectorAll('.library-item');
      /* Every element inside the panel, not just the rows - the actual
         failure widened .vp-library itself (a full column of content),
         which a check that only measured .library-item rows would have
         missed entirely, since no individual row was ever the problem. */
      const bodyLeft = body.getBoundingClientRect().left;
      let maxRight = 0, culprit = null;
      body.querySelectorAll('*').forEach(el => {
        const right = el.getBoundingClientRect().right - bodyLeft;
        if (right > maxRight) { maxRight = right; culprit = el.className || el.tagName; }
      });
      return {
        scrollWidth: body.scrollWidth,
        clientWidth: body.clientWidth,
        hasHScroll: body.scrollWidth > body.clientWidth + 1,
        overflowX: getComputedStyle(body).overflowX,
        flexWrap: getComputedStyle(body).flexWrap,
        maxRight: Math.round(maxRight),
        culprit,
        itemCount: items.length
      };
    });
    const tag = w + 'x' + h;
    check(tag + ': catalog fully rendered', r.itemCount >= 40, r.itemCount + ' rows');
    check(tag + ': flex-wrap is nowrap, not inherited wrap',
      r.flexWrap === 'nowrap', 'flex-wrap: ' + r.flexWrap);
    check(tag + ': overflow-x is hidden', r.overflowX === 'hidden', r.overflowX);
    check(tag + ': no horizontal overflow - scrollWidth === clientWidth',
      !r.hasHScroll, r.scrollWidth + ' vs ' + r.clientWidth +
        (r.hasHScroll ? ' (widened by ' + r.culprit + ')' : ''));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. vertical scroll reaches every row ===');
  {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const body = document.querySelector('#menu-import .vp-top-body');
      const items = [...document.querySelectorAll('.library-item')];
      body.scrollTop = 0;
      const firstOk = (() => {
        const b = items[0].getBoundingClientRect();
        const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return el && el.closest('.library-item') === items[0];
      })();
      body.scrollTop = body.scrollHeight;
      const last = items[items.length - 1];
      const b = last.getBoundingClientRect();
      const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      const lastOk = !!(el && el.closest('.library-item') === last);
      body.scrollTop = 0;
      return { canScroll: body.scrollHeight > body.clientHeight,
               firstOk, lastOk, lastFile: last.dataset.file, total: items.length };
    });
    check('the panel is genuinely taller than it can show, so it scrolls',
      r.canScroll);
    check('the first row is reachable at rest', r.firstOk);
    check('the last of ' + r.total + ' rows (' + r.lastFile + ') is reachable by scrolling',
      r.lastOk);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. click-to-load is unaffected by the layout fix ===');
  {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => state.models.length);
    /* v9_mirror_factory.stl - a Test Fixtures row with a real, longish name,
       and one of the few catalog entries with a local copy in library/, so
       the harness's own fallback (see nso_app_harness.js) can answer the
       fetch without a nest-library checkout. Most Test Fixtures rows moved
       to the nest-library repo and are not reachable offline - that is
       nso_library_dir.js's job to know about, not this file's; picking one
       that resolves locally keeps this check about the layout fix, not
       about network reachability. */
    const row = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.library-item')];
      const target = items.find(i => /v9_mirror_factory/.test(i.dataset.file || ''));
      if (!target) return null;
      target.scrollIntoView();
      return target.dataset.file;
    });
    check('the longish-named fixture has a row', !!row, row);
    if (row) {
      await page.evaluate((file) => {
        const items = [...document.querySelectorAll('.library-item')];
        items.find(i => i.dataset.file === file).click();
      }, row);
      await page.waitForFunction((n) => state.models.length > n, before, { timeout: 30000 })
        .catch(() => {});
      const after = await page.evaluate(() => state.models.length);
      check('clicking it loads the piece onto the plate', after === before + 1,
        before + ' -> ' + after);
      const dropdownClosed = await page.evaluate(() =>
        document.getElementById('menu-import').open === false);
      check('the dropdown closes on load, as it always did', dropdownClosed);
    }
  }

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});
