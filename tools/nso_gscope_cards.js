/* G-scope's cards, for the checks.

   G-scope has ONE card that is always up (round 2c, docs/GSCOPE.md item 12):
   IMPORT ▾, the Normal | Slice switch and the selection rows for that side.
   Two things open from it, or from the corner: IMPORT's ▾ menu (Read plate)
   and the Export card - each only shows while its button has opened it - and
   on the card's Slice side the Slice settings row unfolds. A check that clicks
   "#ms-btn-plate" by id has to open the ▾ menu first, the way a person would;
   one that fills "#ms-slice-nozzle" has to unfold the Slice settings.

   A row on the side the switch is NOT on is reported 'unavailable' and left
   alone: flipping the switch slices (or goes back to the mesh), which is a
   check's own business, never a helper's.

   ONE helper does that for every check:

     install(page, { before })
                             wraps the page's own click / fill / select /
                             check / focus / hover ... and isVisible /
                             isEnabled / isDisabled / isChecked / isEditable,
                             so that before any of them acts on a selector
                             that lives in a closed card (or the folded Slice
                             settings), it is opened from its own button
                             (the ▾, Export, the settings row). Nothing else changes:
                             the call goes on to Playwright exactly as written,
                             so a control the engine has hidden is still
                             hidden (the card's button is disabled, nothing
                             opens, and the call fails or reports false as it
                             always did). Also closes the open card before a
                             real mouse press that would land on its bare
                             background (not on one of its controls) - a card
                             left open over the canvas swallows the click.
     openCardFor(page, sel)  the same walk, by hand, for a check that reads
                             the DOM itself (offsetParent, a bounding box) and
                             needs the card up first.
     closeCards(page)        shuts whichever card is open.
     clickThroughReadouts(page)
                             for a check about where something on the canvas
                             lands (a marker's card, a drag): the readouts
                             along the bottom and down the left wall are over
                             the canvas by design, so a real click at the
                             bottom of the view hits a readout box. This makes
                             them click-through for that page. Leave it out of
                             anything that tests the readouts themselves.

   Works in a CommonJS check (require) and in an .mjs one
   (import gscopeCards from '../nso_gscope_cards.js'). Safe on a page that has
   no G-scope or no matching selector: it opens nothing. */

/* Playwright's page methods that take a selector first. Reads that only look
   at text or attributes are left alone: they work on a closed card. */
const ACTIONS = ['click', 'dblclick', 'fill', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'tap', 'type',
                 'press', 'focus', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked', 'isEditable'];

/* Runs in the page. Finds the element and says what its card needs:
   { state, nav } - 'none' (not in a card), 'open', 'unavailable' (its button is
   disabled: the engine has nothing to show in it; or a card row on the side the
   switch is not on) or 'closed', with nav the id of the button that opens it
   (the card names it, data-nav; the Slice settings, their row's own button). */
function findCardFor(sel) {
  let el = null;
  try { el = document.querySelector(sel); } catch (e) { return { state: 'unreadable', nav: null }; }
  if (!el) return { state: 'none', nav: null };
  const row = el.closest('#ms-main-card .ms-row');
  if (row && getComputedStyle(row).display === 'none') return { state: 'unavailable', nav: null };
  const fold = el.closest('#ms-slice-settings');
  if (fold) return { state: fold.hidden ? 'closed' : 'open', nav: 'ms-slice-settings-toggle' };
  const card = el.closest('.ms-card');
  if (!card) return { state: 'none', nav: null };
  const navId = card.getAttribute('data-nav');
  if (card.classList.contains('is-open')) return { state: 'open', nav: navId };
  const nav = document.getElementById(navId);
  return { state: !nav || nav.disabled ? 'unavailable' : 'closed', nav: navId };
}

/* Runs in the page: press the button that opens it, as a person would. */
function pressNav(navId) { document.getElementById(navId).click(); }

/* Runs in the page: shut the open card, if any, by its own button. */
function closeOpenCard() {
  const card = document.querySelector('.ms-card.is-open');
  if (!card) return false;
  const nav = document.getElementById(card.getAttribute('data-nav'));
  if (nav) nav.click();
  return true;
}

/* Runs in the page: is this point over an open card's own background (its
   padding, a note)? A control in the card - a button, a field, a label - is
   the card doing its job: a click there is meant for it, so it stays open. */
function pointOnCard(pt) {
  const el = document.elementFromPoint(pt[0], pt[1]);
  return !!(el && el.closest('.ms-card.is-open') && !el.closest('button, input, select, textarea, label, a'));
}

/* Opens the card holding `sel`. `before(navId)`, if given, runs first, just
   ahead of the press - for a check that counts every action the page records
   (Watch logs a column button's press as a line of its own). Resolves to what
   it found: 'none', 'open', 'unavailable', or 'opened'. */
async function openCardFor(page, sel, before) {
  const f = await page.evaluate(findCardFor, sel);
  if (f.state !== 'closed') return f.state;
  if (before) await before(f.nav);
  await page.evaluate(pressNav, f.nav);
  await page.waitForTimeout(40);
  return 'opened';
}

async function closeCards(page) {
  const r = await page.evaluate(closeOpenCard);
  if (r) await page.waitForTimeout(40);
  return r;
}

/* A selector worth looking up: G-scope's own ids. Anything else cannot be in a
   card, so it costs no round trip. */
const MINE = /ms-/;

async function clickThroughReadouts(page) {
  await page.addStyleTag({ content: '#ms-dock-left, #ms-dock-left *, #ms-readouts, #ms-readouts * { pointer-events: none !important; }' });
}

function install(page, opts) {
  const before = opts && opts.before;
  if (!page || page.__gscopeCards) return page;
  page.__gscopeCards = true;
  for (const name of ACTIONS) {
    const act = page[name].bind(page);
    page[name] = async function (selector, ...rest) {
      if (typeof selector === 'string' && MINE.test(selector)) {
        try { await openCardFor(page, selector, before); } catch (e) { /* page busy: act as written */ }
      }
      return act(selector, ...rest);
    };
  }
  // A card left open over the canvas takes the click meant for the piece.
  const m = page.mouse, down = m.down.bind(m), click = m.click.bind(m);
  const clear = async (x, y) => {
    try { if (await page.evaluate(pointOnCard, [x, y])) await closeCards(page); } catch (e) { /* act as written */ }
  };
  m.click = async function (x, y, ...rest) { await clear(x, y); return click(x, y, ...rest); };
  m.down = async function (...rest) {
    // down() has no point of its own: it presses where the pointer last was.
    try { if (page.__lastMouse) await clear(page.__lastMouse[0], page.__lastMouse[1]); } catch (e) { /* ditto */ }
    return down(...rest);
  };
  const move = m.move.bind(m);
  m.move = async function (x, y, ...rest) { page.__lastMouse = [x, y]; return move(x, y, ...rest); };
  return page;
}

module.exports = { install, openCardFor, closeCards, clickThroughReadouts, findCardFor, closeOpenCard, ACTIONS };
