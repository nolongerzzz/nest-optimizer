#!/usr/bin/env node
/* G-scope's feature legend, down the left wall under the ONE card (round 2c,
   docs/GSCOPE.md item 12: IMPORT ▾ · Normal | Slice · the side's rows - the
   old button column is gone), with the G-scope file-line box directly above
   it. A layout move: the rows, the Display checks and Check all are the same
   code, so this checks WHERE it is and that moving it cost none of what it does.
   (The legend is the FEATURES list now - checkboxes only, docs/GSCOPE.md
   item 4; Check all sits in its head.)
   GATES:
     1  the column is gone; the legend is on the left wall, bottom-left, the
        file line right above it, the stack under the card's bottom edge; an
        imported slice shows the card's Slice side (4 rows)
     2  the Display checks hide/show without isolating; a row click off its
        check does nothing (mode stays 'piece'); soloGroup; Check all in the
        list's head shows every line type again
     3  Slice side: at six real window shapes nothing overlaps anything (the
        card included), nothing spills, the legend stays under the card, every
        row is reachable
     4  Normal side (a mesh through IMPORT): the card shows 2 rows and the same
        layout gates hold at every shape
   (docs: nso_gscope_shell_test.js has the card itself.)
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
const MESH = 'fixtures/box-20mm.stl';                            // the Normal side
const SHOTS = path.join(ROOT, 'tools', 'gscope-legend-out');

/* Real window shapes, not one comfortable default. The toolbar work shipped a
   buried Undo button that every check at 1400x900 called clean and the suite
   caught at 720, so the short ones are the point of this list. 1280x560 is
   shorter than anyone uses and is here to force the legend's height cap to
   engage: the card's Slice side takes ~280 px of the left wall, the file line
   sits under it, and the legend is what is left, so it scrolls inside itself. */
const SIZES = [[1680, 1050], [1400, 900], [1366, 768], [1280, 720], [1024, 768], [1280, 560]];

/* Everything that floats over this viewport. The legend has to clear all of
   them at every size. */
const OVERLAYS = ['ms-main-card', 'ms-corner', 'ms-legend-float', 'ms-title', 'ms-mode-badge', 'ms-info', 'ms-slice-readout',
                  'ms-hint-badge', 'ms-zr'];

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setInputFiles('#file-input', path.join(ROOT, SLICE));
  await page.waitForTimeout(3500);

  check('the slice opens G-scope by itself',
    await page.evaluate(() => !document.getElementById('microscope').hidden));

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the column is gone; it lives on the left wall, under the card ===');
  {
    const where = await page.evaluate(() => {
      const el = document.getElementById('ms-legend');
      const box = document.getElementById('ms-legend-float');
      const vp = document.getElementById('ms-viewport').getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        columnGone: !document.getElementById('ms-sidebar') && !document.getElementById('ms-card-select') &&
                    !document.getElementById('ms-card-view'),
        inCard: !!document.querySelector('#ms-main-card #ms-legend'),
        inViewport: !!document.querySelector('#ms-viewport #ms-legend'),
        sameNode: el === document.getElementById('ms-legend'),
        corner: [+(b.left - vp.left).toFixed(0), +(vp.bottom - b.bottom).toFixed(0)],
        positioned: getComputedStyle(box.parentElement).position,
        inStack: box.parentElement.id === 'ms-dock-left',
        headAbove: (h => !!h && h.getBoundingClientRect().bottom <= b.top && b.top - h.getBoundingClientRect().bottom < 16)(
          document.querySelector('#ms-dock-left > .ms-head')),
        cardBottom: (c => c ? c.getBoundingClientRect().bottom : null)(document.getElementById('ms-main-card')),
        stackTop: document.getElementById('ms-dock-left').getBoundingClientRect().top,
        legendTop: b.top,
        side: (c => c && c.dataset.side)(document.getElementById('ms-main-card')),
        apiSide: window.NSO_MICROSCOPE.cardSide(),
        rows: [...document.querySelectorAll('#ms-main-card .ms-row')]
          .filter(r => getComputedStyle(r).display !== 'none').map(r => r.id),
        title: document.getElementById('ms-legend-title').textContent
      };
    });
    check('the left column and the SELECT / VIEW cards are gone', where.columnGone);
    check('an imported slice shows the card\'s Slice side: its 4 rows',
      where.side === 'slice' && where.apiSide === 'slice' &&
      where.rows.join() === 'ms-region-row,ms-band-row,ms-render-row,ms-slice-row', where.side + ': ' + where.rows.join(', '));
    check('the legend is not in the card', !where.inCard);
    check('now inside the viewport', where.inViewport);
    check('in the left-wall stack, which is pinned (not in flow)', where.inStack && where.positioned === 'absolute', where.positioned);
    check('anchored to the bottom-left: 8 px from the left wall, 12 px off the bottom', where.corner[0] === 8 && where.corner[1] === 12,
      '(' + where.corner.join(', ') + ') from the viewport\'s left and bottom');
    check('the G-scope file-line box is directly above it', where.headAbove);
    check('and the whole stack (file line + legend) is under the card\'s bottom edge',
      where.cardBottom !== null && where.stackTop >= where.cardBottom && where.legendTop >= where.cardBottom,
      'card bottom ' + (where.cardBottom | 0) + ', stack top ' + (where.stackTop | 0) + ', legend top ' + (where.legendTop | 0));
    check('still titled for what it lists', where.title === 'Features', where.title);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. the checks, the row click and Check all are untouched ===');
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

    /* Checkboxes only (docs/GSCOPE.md, item 4): a click on a row off its
       check (its swatch, its gap) does nothing; the old "only" button's job is
       the soloGroup API. */
    const click = await page.evaluate(() => {
      const M = window.NSO_MICROSCOPE;
      const row = document.querySelectorAll('#ms-legend .ms-legend-item')[2];
      const keep = row.dataset.group;
      const before = M.hidden().slice().sort().join();
      row.click();
      row.querySelector('.ms-swatch').click();
      return { keep, iso: M.isIsolated(), mode: M.mode(), sel: M.selection().length, same: M.hidden().slice().sort().join() === before };
    });
    check('a click on a row off its check and text does nothing: no isolate, no selection, no box toggled',
      !click.iso && click.mode === 'piece' && click.sel === 0 && click.same, click.keep + ' isolated=' + click.iso + ' mode=' + click.mode);

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

    /* Check all left the VIEW card for the Features list's head (round 2c);
       same job: every line type shown again, Travel too. A real click. */
    const head = await page.evaluate(() => {
      const b = document.getElementById('ms-btn-show-all');
      return { inHead: !!(b && b.closest('#ms-legend-float .ms-legend-head')),
               besideToggle: !!(b && b.parentElement.querySelector('#ms-legend-toggle')),
               disabled: b ? b.disabled : null };
    });
    check('Check all is in the Features list\'s head, next to its toggle',
      head.inHead && head.besideToggle && head.disabled === false, JSON.stringify(head));
    await page.click('#ms-btn-show-all');
    const all = await page.evaluate(() => ({ hidden: window.NSO_MICROSCOPE.hidden(),
      unchecked: [...document.querySelectorAll('#ms-legend input.ms-legend-display')].filter(c => !c.checked).length,
      iso: window.NSO_MICROSCOPE.isIsolated() }));
    check('Check all (real click) shows every line type again, Travel too, and isolates nothing',
      all.hidden.length === 0 && all.unchecked === 0 && !all.iso, 'hidden: [' + all.hidden.join(', ') + ']');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Slice side: clear of every other overlay, at real window shapes ===');
  await clearAtEverySize(page, 'slice');

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. Normal side (a mesh through IMPORT): the same, under a shorter card ===');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ms-btn-open')]);
    await chooser.setFiles(path.join(ROOT, MESH));
    await page.waitForFunction(() => (window.NSO_MICROSCOPE.getDoc() || {}).kind === 'mesh', null, { timeout: 30000 });
    await page.waitForTimeout(450);
    const n = await page.evaluate(() => ({
      side: document.getElementById('ms-main-card').dataset.side, apiSide: window.NSO_MICROSCOPE.cardSide(),
      rows: [...document.querySelectorAll('#ms-main-card .ms-row')]
        .filter(r => getComputedStyle(r).display !== 'none').map(r => r.id),
      legendUp: document.getElementById('ms-legend-float').getBoundingClientRect().height > 0,
      note: (document.querySelector('#ms-legend .ms-legend-note') || {}).textContent || '',
      checkAllOff: document.getElementById('ms-btn-show-all').disabled,
      mode: window.NSO_MICROSCOPE.mode() }));
    check('IMPORT (real click, the file picker) a mesh: the card turns to its Normal side, 2 rows',
      n.side === 'normal' && n.apiSide === 'normal' && n.rows.join() === 'ms-region-row,ms-whole-row',
      n.side + ': ' + n.rows.join(', '));
    check('the Features list is up on this side too (a mesh has no line types: it says so; Check all is off), mode still piece',
      n.legendUp && /no line types/.test(n.note) && n.checkAllOff && n.mode === 'piece', '"' + n.note + '", mode ' + n.mode);
  }
  await clearAtEverySize(page, 'normal');

  const errs = logs.filter(l => l.type === 'error');
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

  if (fails) { console.log('\n' + fails + ' FAILED'); process.exit(1); }
  console.log('\nall gates held');
});

/* Section 3's gates at every window shape, on the side the card shows now. */
async function clearAtEverySize(page, side) {
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
      const card = document.getElementById('ms-main-card').getBoundingClientRect();
      const lb = L.getBoundingClientRect(), sb = document.getElementById('ms-dock-left').getBoundingClientRect();
      return { clash, spill, rows: rows.length, atRest: top.size, reached: reached.size,
               cardBottom: card.bottom, legendTop: lb.top, stackTop: sb.top, legendShown: lb.height > 0,
               side: document.getElementById('ms-main-card').dataset.side,
               capped: L.scrollHeight > L.clientHeight,
               missing: rows.map((rr, i) => reached.has(i) ? null : rr.dataset.group)
                            .filter(Boolean) };
    }, OVERLAYS);

    const tag = side + ' ' + w + 'x' + h;
    check(tag + ': nothing overlaps anything', r.clash.length === 0 && r.side === side,
      r.side !== side ? 'the card shows ' + r.side
        : r.clash.length ? r.clash.join('; ') : 'card, legend, mode badge, hint badge and layer slider all clear');
    check(tag + ': the legend stays under the card (its top >= the card\'s bottom)',
      r.legendShown && r.legendTop >= r.cardBottom && r.stackTop >= r.cardBottom,
      'card bottom ' + (r.cardBottom | 0) + ', stack top ' + (r.stackTop | 0) + ', legend top ' + (r.legendTop | 0));
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
    await page.locator('#microscope').screenshot({ path: path.join(SHOTS, 'gscope-' + side + '-' + w + 'x' + h + '.png') });
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  console.log('  screenshots: ' + SHOTS);
}
