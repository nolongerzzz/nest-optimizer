/* The viewport overlays do not cover each other's controls.
     node tools/nso_viewport_overlay_test.js     exit 0 = every gate held

   WHY THIS EXISTS

   The viewport's top strip is several absolutely positioned overlays sharing
   one line: `.viewport-overlay-topbar` on the left, and the `Stock`, `Wheel`
   and `Finish` menus in the top-right corner. The topbar has to RESERVE room for the menus,
   because the menus sit at a higher z-index and their summaries have
   `pointer-events: auto` - so a topbar button underneath one of them is visible,
   enabled, and unclickable.

   That is not hypothetical. Two bugs met here:

   1. `.tp-detail` in styles.css was missing its closing brace, so the parser
      treated the whole `.viewport-overlay-wheel` rule as a nested block and
      DISCARDED it. The Wheel menu had no positioning at all, and nobody noticed
      because the only symptom was a menu in the wrong place.
   2. Closing that brace revived the rule - and revealed that the topbar's
      reserved gutter was a bare `right: 88px`, which fitted `Finish` alone.
      Nothing had widened it when `Wheel` was added beside `Finish`, so the Wheel
      menu landed on top of `#btn-lock-pos` and `npm run lock:test` died on a
      Playwright pointer-interception timeout.

   Neither bug is visible in a unit test, and the first is invisible even on
   screen unless you know where the menu is supposed to be. So both are pinned
   here: the stylesheet is checked for unclosed blocks WITHOUT a browser, and the
   rendered geometry is measured WITH one.

   Tier 1 needs no browser and catches bug 1 instantly.
   Tier 2 renders the real page and catches bug 2. */

'use strict';

const fs = require('fs');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// ===========================================================================
// Tier 1 - the stylesheet parses as intended, no browser
// ===========================================================================
//
// An unclosed block does not throw anywhere: CSS error recovery silently eats
// whatever follows until the next `}`, so a whole rule disappears and the only
// evidence is that something is in the wrong place on screen. Counting braces is
// the cheapest possible guard against that, and it is the one that was missing.

/** Blank out comments, keeping newlines so line numbers survive. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every block in a stylesheet closes. Returns the lines of any that do not.
 * @param {string} src
 * @returns {{open: number[], stray: number[]}}
 */
function unclosedBlocks(src) {
  const lines = stripComments(src).split('\n');
  const open = [];
  const stray = [];
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (ch === '{') open.push(i + 1);
      else if (ch === '}') { if (open.length) open.pop(); else stray.push(i + 1); }
    }
  });
  return { open, stray };
}

function cssStructure() {
  section('1. styles.css parses as written - every block closes');
  const file = path.join(ROOT, 'styles.css');
  const src = fs.readFileSync(file, 'utf8');
  const { open, stray } = unclosedBlocks(src);
  check('no block is left unclosed', open.length === 0,
        open.length ? 'still open from line(s) ' + open.join(', ') : '0 open');
  check('no stray closing brace', stray.length === 0,
        stray.length ? 'at line(s) ' + stray.join(', ') : '0 stray');

  // The check has teeth: the historical bug must be caught by it. Drop the brace
  // that closes `.tp-detail` and the scan has to notice.
  const broken = src.replace(
    /(\.tp-detail \{[^}]*?word-break: break-word;\n)\}/,
    '$1');
  check('the scan would catch the bug it was written for',
        broken !== src && unclosedBlocks(broken).open.length === 1,
        'removing .tp-detail\'s closing brace is detected');

  // And the rule that bug silently deleted is actually present.
  check('.viewport-overlay-wheel survives parsing as a rule of its own',
        /\n\.viewport-overlay-wheel \{/.test(stripComments(src)), 'declared at top level');
  check('.viewport-overlay-stock does too - menu 3 is the same trap',
        /\n\.viewport-overlay-stock \{/.test(stripComments(src)), 'declared at top level');

  // Every offset in the strip is derived from --vp-menu-count, so a menu added
  // without bumping it is the bug of 2 all over again. Count the menu overlays
  // in the markup and check the variable agrees.
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const menus = (html.match(/class="viewport-overlay viewport-overlay-(finish|wheel|stock)"/g) || []).length;
    const declared = (stripComments(src).match(/--vp-menu-count:\s*(\d+)/) || [])[1];
    check('--vp-menu-count matches the number of top-right menus in the markup',
          menus > 0 && String(menus) === declared, menus + ' menus, --vp-menu-count: ' + declared);
  }
}

// ===========================================================================
// Tier 2 - the rendered strip, measured
// ===========================================================================

/** Overlap of two DOMRect-likes, or null when they are clear of each other. */
function overlap(a, b) {
  const x = Math.min(a.right, b.right) - Math.max(a.x, b.x);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
  return x > 0 && y > 0 ? { x: Math.round(x), y: Math.round(y) } : null;
}

async function rendered() {
  section('2. the rendered top strip - nothing covers anything');
  await withApp(async (page) => {
    // A selected piece, so every topbar button is enabled and laid out at its
    // real width - a disabled button is still positioned, but selecting keeps
    // this honest about the state a user is actually in when they click.
    const id = await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await selectModel(page, id);

    const m = await page.evaluate(() => {
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { sel, x: b.x, y: b.y, right: b.right, bottom: b.bottom,
                 w: Math.round(b.width), h: Math.round(b.height) };
      };
      /* Only the controls the bar is actually SHOWING: not inside a folded
         dropdown, and not hidden outright (Remove). The invariant this file
         exists for is unchanged and still applies to those - a bar control on
         screen must be clickable where it is drawn.

         The fold state is read directly rather than inferred from the box.
         A panel inside a closed <details> is position:absolute, and Chromium
         still computes a rect for it: #btn-rot-left measures 172x31 with its
         menu shut. It is not hit-testable - elementFromPoint over it returns
         the canvas, so it intercepts nothing - but "has a box" would have let
         seventeen folded controls back into this check, every one of them
         reported as covered by the canvas they are not in front of. */
      const btns = Array.from(document.querySelectorAll('.viewport-overlay-topbar .vp-bar-btn'))
        .filter((e) => !e.closest('details:not([open])') && !e.hidden);
      return {
        topbar: box('.viewport-overlay-topbar'),
        wheel: box('.vp-wheel-menu'),
        stock: box('.vp-stock-menu'),
        finish: box('.vp-finish-menu'),
        // Every topbar button, and what is actually on top at its click point -
        // which is the only thing that decides whether a click lands.
        buttons: btns.map((e) => {
          const b = e.getBoundingClientRect();
          const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return {
            id: e.id,
            x: b.x, y: b.y, right: b.right, bottom: b.bottom,
            covered: !(hit === e || e.contains(hit)),
            by: hit ? (hit.id || hit.className || hit.tagName) : null
          };
        })
      };
    });

    check('the topbar is on screen', !!m.topbar, m.topbar && m.topbar.w + 'px wide');
    check('the Finish menu is on screen', !!m.finish,
          m.finish && 'x ' + Math.round(m.finish.x) + '..' + Math.round(m.finish.right));

    /* Finish is the only top-right menu now. The Wheel and Stock overlays are
       gone - both menus moved into the bar's Gen+ dropdown - so the claims
       that used to stand here, that each sat in its own corner immediately
       left of the next, are claims about markup that no longer exists.
       --vp-menu-count went 3 -> 1 with them, and the check above that it
       matches the overlays in index.html is what keeps the two in step.

       What is NOT dropped is the bug this file was written for: the topbar
       must still end before the menu begins, or a bar control sits under a
       higher-z menu summary - visible, enabled and unclickable. */
    check('the Finish menu is positioned in the top-right corner, not left where an ' +
          'unstyled overlay lands',
          !!m.finish && m.finish.x > m.topbar.x,
          m.finish && 'finish x ' + Math.round(m.finish.x) + ' vs topbar x ' + Math.round(m.topbar.x));

    // THE ONE THAT BROKE. The topbar must end before the menus begin.
    const vsFinish = overlap(m.topbar, m.finish);
    check('the topbar reserves room for the Finish menu and does not run under it',
          !vsFinish, vsFinish ? vsFinish.x + 'x' + vsFinish.y + ' px overlap' : 'clear');

    // The invariant that actually matters to a user: every button is clickable.
    const covered = m.buttons.filter((b) => b.covered);
    check('every topbar button is clickable - nothing is on top of its click point',
          covered.length === 0,
          covered.length
            ? covered.map((b) => '#' + (b.id || '?') + ' covered by ' + b.by).join('; ')
            : m.buttons.length + ' buttons, none covered');

    // Named explicitly, because this is the button the regression hit.
    const lock = m.buttons.find((b) => b.id === 'btn-lock-pos');
    check('#btn-lock-pos specifically is not covered', !!lock && !lock.covered,
          lock ? (lock.covered ? 'covered by ' + lock.by : 'clear at x ' +
                  Math.round(lock.x) + '..' + Math.round(lock.right)) : 'button not found');

    console.log('       topbar x ' + Math.round(m.topbar.x) + '..' + Math.round(m.topbar.right) +
                ' | Stock ' + Math.round(m.stock.x) + '..' + Math.round(m.stock.right) +
                ' | Wheel ' + Math.round(m.wheel.x) + '..' + Math.round(m.wheel.right) +
                ' | Finish ' + Math.round(m.finish.x) + '..' + Math.round(m.finish.right));
  });
}

(async () => {
  cssStructure();
  await rendered();
  console.log('\n' + '-'.repeat(58));
  if (fails) { console.log(fails + ' gate(s) FAILED'); process.exit(1); }
  console.log('all gates held');
})().catch((e) => { console.error(e); process.exit(1); });
