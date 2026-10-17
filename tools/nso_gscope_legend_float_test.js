#!/usr/bin/env node
/* G-scope's feature legend, down the left wall under the shell's button column,
   with the G-scope file-line box directly above it. A layout move: the rows,
   the Display checks and the click-to-isolate row are the same code, so
   this checks WHERE it is and that moving it cost none of what it does.
   (The legend is the FEATURES list now - docs/GSCOPE-SELECT.md section 3: the
   per-row "only" button is gone; a row click isolates that line type.)
   (It floated top-left over the sidebar-less viewport before the shell's
   readouts went to the bottom; docs: nso_gscope_shell_test.js has the layout.)
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
   caught at 720, so the short ones are the point of this list. 1280x560 is
   shorter than anyone uses and is here to force the legend's height cap to
   engage: the button column takes 330 px of the left wall, the file line sits
   under it, and the legend is what is left, so it scrolls inside itself. (Under
   about 500 high the column leaves the left wall no room at all.) */
const SIZES = [[1680, 1050], [1400, 900], [1366, 768], [1280, 720], [1024, 768], [1280, 560]];

/* Everything that floats over this viewport. The legend has to clear all of
   them at every size. */
const OVERLAYS = ['ms-sidebar', 'ms-corner', 'ms-legend-float', 'ms-title', 'ms-mode-badge', 'ms-info', 'ms-slice-readout',
                  'ms-hint-badge', 'ms-zr'];

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setInputFiles('#file-input', path.join(ROOT, SLICE));
  await page.waitForTimeout(3500);

  check('the slice opens G-scope by itself',
    await page.evaluate(() => !document.getElementById('microscope').hidden));

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. it left the sidebar and lives on the left wall, under the column ===');
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
        corner: [+(b.left - vp.left).toFixed(0), +(vp.bottom - b.bottom).toFixed(0)],
        positioned: getComputedStyle(box.parentElement).position,
        inStack: box.parentElement.id === 'ms-dock-left',
        headAbove: (h => !!h && h.getBoundingClientRect().bottom <= b.top && b.top - h.getBoundingClientRect().bottom < 16)(
          document.querySelector('#ms-dock-left > .ms-head')),
        clearOfColumn: b.top >= Math.max(...Array.from(document.querySelectorAll('#ms-sidebar > button')).map(e => e.getBoundingClientRect().bottom)),
        title: document.getElementById('ms-legend-title').textContent
      };
    });
    check('no longer in the sidebar', !where.inSidebar);
    check('now inside the viewport', where.inViewport);
    check('in the left-wall stack, which is pinned (not in flow)', where.inStack && where.positioned === 'absolute', where.positioned);
    check('anchored to the bottom-left: 8 px from the left wall, 12 px off the bottom', where.corner[0] === 8 && where.corner[1] === 12,
      '(' + where.corner.join(', ') + ') from the viewport\'s left and bottom');
    check('the G-scope file-line box is directly above it', where.headAbove);
    check('and the whole stack is under the button column', where.clearOfColumn);
    check('still titled for what it lists', where.title === 'Features', where.title);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. click-to-isolate is untouched ===');
  {
    /* The behaviour gate. Driven through the rows themselves - a real click
       on the row's Display check, a real click on the row (off its check, the
       Feature click) - and read back off the module's own state, so this
       passes only if the same handlers are still bound to the same nodes
       after the move. */
    const rowInfo = await page.evaluate(() => {
      const row = document.querySelectorAll('#ms-legend .ms-legend-item')[0];
      const label = row.querySelector('.ms-legend-label').textContent;
      return { name: row.dataset.group, label, hasSwatch: !!row.querySelector('.ms-swatch'),
               hasCheck: !!row.querySelector('input.ms-legend-display'),
               checked: row.querySelector('input.ms-legend-display').checked,
               noOnly: !document.querySelector('.ms-legend-only') };
    });
    check('a row is swatch, "name (count)" and a Display check; the "only" button is gone',
      rowInfo.hasSwatch && rowInfo.hasCheck && rowInfo.checked && rowInfo.noOnly &&
      /^.+ \(\d+\)$/.test(rowInfo.label), rowInfo.label);

    const toggle = await page.evaluate(() => {
      const M = window.NSO_MICROSCOPE;
      const row = document.querySelectorAll('#ms-legend .ms-legend-item')[0];
      const name = row.dataset.group;
      const chk = row.querySelector('input.ms-legend-display');
      const before = M.hidden().length;
      chk.click();
      const afterOn = M.hidden();
      const dimmedOff = document.querySelectorAll('#ms-legend .ms-legend-item')[0].classList.contains('dim');
      const checkedOff = document.querySelectorAll('#ms-legend .ms-legend-item')[0]
        .querySelector('input.ms-legend-display').checked;
      document.querySelectorAll('#ms-legend .ms-legend-item')[0].querySelector('input.ms-legend-display').click();
      const afterOff = M.hidden();
      return { name, before, hidAfterOne: afterOn.indexOf(name) !== -1,
               countOne: afterOn.length, backTo: afterOff.length,
               dimmedOff, checkedOff, isolated: M.isIsolated() };
    });
    check('unchecking a row\'s Display check hides that feature',
      toggle.hidAfterOne && toggle.countOne === toggle.before + 1 && toggle.dimmedOff && !toggle.checkedOff,
      toggle.name + ': hidden went ' + toggle.before + ' -> ' + toggle.countOne);
    check('...and checking it again brings it back', toggle.backTo === toggle.before, 'back to ' + toggle.backTo);
    check('the Display check hides but does not isolate', !toggle.isolated);

    /* The old "only" button's job, two ways: the row click (Feature click -
       this line type, isolated; again, whole) and the soloGroup API. */
    const click = await page.evaluate(() => {
      const M = window.NSO_MICROSCOPE;
      const row = document.querySelectorAll('#ms-legend .ms-legend-item')[2];
      const keep = row.dataset.group;
      const before = M.hidden().length;
      row.click();
      const iso = M.isIsolated(), mode = M.mode(), hidAfter = M.hidden().length;
      row.click();
      return { keep, iso, mode, hidAfter, before, isoAgain: M.isIsolated() };
    });
    check('a click on a row (off its check) isolates that line type: Feature mode',
      click.iso && click.mode === 'feature', click.keep + ' isolated=' + click.iso + ' mode=' + click.mode);
    check('...and clicking it again makes it whole', !click.isoAgain);
    check('the row click does not touch the Display set', click.hidAfter === click.before,
      click.before + ' -> ' + click.hidAfter);

    const only = await page.evaluate(() => {
      const M = window.NSO_MICROSCOPE;
      const rows = [...document.querySelectorAll('#ms-legend .ms-legend-item')];
      const keep = rows[2].dataset.group;
      M.soloGroup(keep);
      const hidden = M.hidden();
      const checks = [...document.querySelectorAll('#ms-legend .ms-legend-item')]
        .filter(r => r.querySelector('input.ms-legend-display').checked).map(r => r.dataset.group);
      return { keep, hiddenCount: hidden.length, total: M.groups().length,
               keptVisible: hidden.indexOf(keep) === -1, checks };
    });
    check('soloGroup leaves exactly one feature showing (one Display set)',
      only.keptVisible && only.hiddenCount === only.total - 1 &&
      only.checks.length === 1 && only.checks[0] === only.keep,
      only.keep + ' alone, ' + only.hiddenCount + ' of ' + only.total + ' hidden, checked: ' + only.checks.join(','));

    const styled = await page.evaluate(() => {
      const b = document.querySelector('.ms-legend-display');
      const cs = getComputedStyle(b);
      return { type: b.type, cursor: cs.cursor, accent: cs.accentColor, margin: cs.marginTop };
    });
    /* It used to take its look from `.ms-sidebar button`, an ancestor it no
       longer has (and no sidebar remains). The Display check carries its own
       rule; left alone it would be a default browser checkbox. */
    check('the Display check kept its styling outside the sidebar',
      styled.type === 'checkbox' && styled.cursor === 'pointer' && styled.accent !== 'auto' && styled.margin === '0px',
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
      /* Walk the scroll a window at a time: a legend squeezed to two or three
         rows (the short windows) shows its middle rows only part-way down, not
         at either end. */
      const reached = new Set(top);
      const step = Math.max(24, L.clientHeight - 36);
      for (let y = 0; y <= L.scrollHeight + step; y += step) {
        L.scrollTop = y;
        hittableNow().forEach(i => reached.add(i));
      }
      L.scrollTop = 0;
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
