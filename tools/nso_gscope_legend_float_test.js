#!/usr/bin/env node
/* G-scope's feature legend, floating over the viewport's top-left corner.
   A layout move: the rows, the click-to-isolate and the per-row "only"
   button are the same code, so this checks WHERE it is and that moving it
   cost none of what it does.
     node tools/nso_gscope_legend_float_test.js      exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const SLICE = 'fixtures/3mf/supportwithinsupport.gcode.3mf';   // ten slicer features
const SHOTS = path.join(ROOT, 'tools', 'gscope-legend-out');

/* Real window shapes, not one comfortable default. The toolbar work shipped a
   buried Undo button that every check at 1400x900 called clean and the suite
   caught at 720, so the short ones are the point of this list. 1280x360 is
   past anything anyone uses and is here to force the height cap to engage. */
const SIZES = [[1680, 1050], [1400, 900], [1366, 768], [1280, 720], [1024, 768], [1280, 360]];

/* Everything that floats over this viewport. The legend has to clear all of
   them at every size. */
const OVERLAYS = ['ms-legend-float', 'ms-mode-badge', 'ms-hint-badge', 'ms-zr'];

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setInputFiles('#file-input', path.join(ROOT, SLICE));
  await page.waitForTimeout(3500);

  check('the slice opens G-scope by itself',
    await page.evaluate(() => !document.getElementById('microscope').hidden));

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. it left the sidebar and lives over the viewport ===');
  {
    const where = await page.evaluate(() => {
      const el = document.getElementById('ms-legend');
      const box = document.getElementById('ms-legend-float');
      const vp = document.getElementById('ms-viewport').getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        inSidebar: !!document.querySelector('#ms-sidebar #ms-legend'),
        inViewport: !!document.querySelector('#ms-viewport #ms-legend'),
        sameNode: el === document.getElementById('ms-legend'),
        corner: [+(b.left - vp.left).toFixed(0), +(b.top - vp.top).toFixed(0)],
        positioned: getComputedStyle(box).position,
        title: document.getElementById('ms-legend-title').textContent
      };
    });
    check('no longer in the sidebar', !where.inSidebar);
    check('now inside the viewport', where.inViewport);
    check('floating, not in flow', where.positioned === 'absolute', where.positioned);
    check('anchored at the top-left corner', where.corner[0] === 12 && where.corner[1] === 12,
      '(' + where.corner.join(', ') + ') from the viewport corner');
    check('still titled for what it lists', /\(click to isolate\)$/.test(where.title), where.title);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. click-to-isolate is untouched ===');
  {
    /* The behaviour gate. Driven through the rows themselves - a real click
       on the row, and a real click on its "only" button - and read back off
       the module's own hidden set, so this passes only if the same handlers
       are still bound to the same nodes after the move. */
    const rowCount = await page.evaluate(() =>
      document.querySelectorAll('#ms-legend .ms-legend-item').length);
    check('every feature in the file has a row', rowCount === 10, rowCount + ' rows');

    const toggle = await page.evaluate(() => {
      const M = window.NSO_MICROSCOPE;
      const row = document.querySelectorAll('#ms-legend .ms-legend-item')[0];
      const name = row.dataset.group;
      const before = M.hidden().length;
      row.click();
      const afterOn = M.hidden();
      row.click();
      const afterOff = M.hidden();
      return { name, before, hidAfterOne: afterOn.indexOf(name) !== -1,
               countOne: afterOn.length, backTo: afterOff.length,
               dimmed: row.classList.contains('dim') };
    });
    check('a click on a row hides that feature',
      toggle.hidAfterOne && toggle.countOne === toggle.before + 1,
      toggle.name + ': hidden went ' + toggle.before + ' -> ' + toggle.countOne);
    check('...and clicking again brings it back',
      toggle.backTo === toggle.before, 'back to ' + toggle.backTo);

    const only = await page.evaluate(() => {
      const M = window.NSO_MICROSCOPE;
      const rows = [...document.querySelectorAll('#ms-legend .ms-legend-item')];
      const keep = rows[2].dataset.group;
      rows[2].querySelector('.ms-legend-only').click();
      const hidden = M.hidden();
      return { keep, hiddenCount: hidden.length, total: M.groups().length,
               keptVisible: hidden.indexOf(keep) === -1 };
    });
    check('the "only" button leaves exactly one feature showing',
      only.keptVisible && only.hiddenCount === only.total - 1,
      only.keep + ' alone, ' + only.hiddenCount + ' of ' + only.total + ' hidden');

    const styled = await page.evaluate(() => {
      const b = document.querySelector('.ms-legend-only');
      const cs = getComputedStyle(b);
      return { border: cs.borderTopStyle, radius: cs.borderTopLeftRadius, size: cs.fontSize };
    });
    /* It used to take its look from `.ms-sidebar button`, an ancestor it no
       longer has. Left alone it would render as a default browser button. */
    check('the "only" button kept its styling outside the sidebar',
      styled.border === 'solid' && styled.radius === '6px' && styled.size === '10.5px',
      JSON.stringify(styled));

    await page.evaluate(() => {
      const el = document.getElementById('ms-btn-show-all');
      if (el) el.click();
    });
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. clear of every other overlay, at real window shapes ===');
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(450);
    const r = await page.evaluate((IDS) => {
      const vp = document.getElementById('ms-viewport').getBoundingClientRect();
      const box = {};
      IDS.forEach(id => {
        const e = document.getElementById(id);
        if (!e) return;
        const b = e.getBoundingClientRect();
        if (b.width < 1 && b.height < 1) return;     // hidden ones are not in the way
        box[id] = b;
      });
      const clash = [];
      const k = Object.keys(box);
      for (let i = 0; i < k.length; i++) {
        for (let j = i + 1; j < k.length; j++) {
          const a = box[k[i]], b = box[k[j]];
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 0 && oy > 0) clash.push(k[i] + ' x ' + k[j] + ' = ' + (ox | 0) + 'x' + (oy | 0));
        }
      }
      const spill = Object.entries(box).filter(([, b]) =>
        b.left < vp.left - 0.5 || b.top < vp.top - 0.5 ||
        b.right > vp.right + 0.5 || b.bottom > vp.bottom + 0.5).map(([id]) => id);
      const L = document.getElementById('ms-legend-float');
      const rows = [...document.querySelectorAll('#ms-legend .ms-legend-item')];
      /* Reachable = on screen now, or scrollable to. A cap that CLIPS a
         feature away would pass a plain "does it overlap" check and still
         have cost you a control. */
      const hittableNow = () => new Set(rows.map((rr, i) => {
        const b = rr.getBoundingClientRect();
        const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return (el && el.closest('.ms-legend-item') === rr) ? i : -1;
      }).filter(i => i >= 0));
      L.scrollTop = 0;
      const top = hittableNow();
      L.scrollTop = L.scrollHeight;
      const bottom = hittableNow();
      L.scrollTop = 0;
      const reached = new Set([...top, ...bottom]);
      return { clash, spill, rows: rows.length, atRest: top.size, reached: reached.size,
               capped: L.scrollHeight > L.clientHeight,
               missing: rows.map((rr, i) => reached.has(i) ? null : rr.dataset.group)
                            .filter(Boolean) };
    }, OVERLAYS);

    const tag = w + 'x' + h;
    check(tag + ': nothing overlaps anything', r.clash.length === 0,
      r.clash.length ? r.clash.join('; ') : 'legend, mode badge, hint badge and layer slider all clear');
    check(tag + ': nothing hangs outside the viewport', r.spill.length === 0, r.spill.join(', '));
    /* Reachable means hit-testable at rest OR after scrolling to the end -
       the union of the two, not a count at either. A cap that CLIPPED a
       feature away would pass a plain overlap check and still have cost you
       a control, and a count alone would not say WHICH rows those were. */
    check(tag + ': every feature row is reachable',
      r.reached === r.rows && r.missing.length === 0,
      r.missing.length ? ('unreachable: ' + r.missing.join(', '))
        : r.capped ? ('capped and scrolling - ' + r.atRest + ' of ' + r.rows +
                      ' at rest, all ' + r.reached + ' reachable by scroll')
                   : (r.atRest + '/' + r.rows + ' shown, no scroll needed'));

    /* Standing rule: a screenshot at every size tested. */
    await page.locator('#microscope').screenshot({ path: path.join(SHOTS, 'gscope-' + tag + '.png') });
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  console.log('  screenshots: ' + SHOTS);

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});
