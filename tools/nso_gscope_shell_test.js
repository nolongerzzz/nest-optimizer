#!/usr/bin/env node
/* G-scope shell: the sidebar is gone, the controls are a button column with a
   card under each button, and the readouts have a fixed home.

   Look and feel only - the same job shell v3 did for the main page. Every
   control keeps its id, handler and behaviour; only where it sits changed.

   LAYOUT
     Left, a narrow column of vp-bar-btn slabs as wide as the main shell's:
       IMPORT, READ PLATE | SELECT, LINE, LAYER, VIEW, RENDER | OVERHANGS, CROP Z, SLICE
     A card under each of the last eight, opening to the RIGHT of the column,
     top-left of the viewport; one at a time; Escape shuts it.
     Top-right, a pinned row: BACK, EXPORT, CLOSE. EXPORT's card opens under it.
     Down the left wall, under the column: the file line (G-scope) and, right
     under it, the ALL FEATURES legend. Along the bottom, side by side to the
     right of them: SELECTION / SEGMENT INFO, FEATURES, the Slice report and the
     hint. Always up, never a card, low enough to leave the piece clear.
     The viewport takes the whole panel (the sidebar's width is given back).

   GATES
     1. Every ms-* id the sidebar had is still on the page exactly once, no
        <details> in #microscope, and the new ones are unique too.
     2. Every control is where the ticket lists it: the column, the cards, the
        corner, the dock. The three mode buttons are siblings.
     3. The geometry: the column is the main shell's width and pitch, the cards
        open right of it at the top, the corner is pinned top-right, the dock
        is bottom-left, and the viewport fills the panel.
     4. Each card opens and shuts from its button, only one is open at a time,
        a button whose rows the engine hides is disabled, and Escape shuts the
        open card first and G-scope only when none is open.
     5. Every control in an open card can be hit with a real click.
     6. The readouts stay up with a card open; Lift's rows land in #ms-lift-row,
        the overhang readout in its row, the Slice report in the dock.
     7. A slice (Slice view) brings Line, Render and the Sliced piece group.
     8. A short window (1024 x 720): the column, every card and the dock fit.

   Screenshots go to tools/gscope-shell-out/ (git-ignored).

     node tools/nso_gscope_shell_test.js       exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const SHOTS = path.join(ROOT, 'tools', 'gscope-shell-out');

/* ---------------------------------------------------------------- the ticket */
const COLUMN = [
  ['ms-btn-open', 'IMPORT'], ['ms-btn-plate', 'READ PLATE'],
  ['ms-nav-select', 'SELECT'], ['ms-nav-line', 'LINE'], ['ms-nav-layer', 'LAYER'], ['ms-nav-view', 'VIEW'],
  ['ms-nav-render', 'RENDER'],
  ['ms-nav-overhangs', 'OVERHANGS'], ['ms-nav-crop', 'CROP Z'], ['ms-nav-slice', 'SLICE']
];
const GROUPS = [2, 5, 3];                 // the column's three groups
const CORNER = [['ms-btn-back-producer', 'BACK'], ['ms-nav-export', 'EXPORT'], ['ms-close', 'CLOSE']];
/* card -> [its button, the ids it holds] */
const CARDS = {
  'ms-card-select': ['ms-nav-select', ['ms-mode-orbit', 'ms-mode-select', 'ms-mode-line', 'ms-btn-isolate', 'ms-btn-clear', 'ms-btn-back']],
  'ms-card-line': ['ms-nav-line', ['ms-line-prev', 'ms-line-next', 'ms-btn-isolate-line']],
  'ms-card-layer': ['ms-nav-layer', ['ms-layer-prev', 'ms-layer-index', 'ms-layer-next', 'ms-btn-layer-select']],
  'ms-card-view': ['ms-nav-view', ['ms-cam-normal', 'ms-cam-slice', 'ms-btn-clear-view', 'ms-btn-show-all', 'ms-btn-select-visible']],
  'ms-card-render': ['ms-nav-render', ['ms-render-toolpath', 'ms-render-solid']],
  'ms-card-overhangs': ['ms-nav-overhangs', ['ms-btn-overhangs', 'ms-overhang-angle', 'ms-support-read']],
  'ms-card-crop': ['ms-nav-crop', ['ms-btn-crop']],
  'ms-card-slice': ['ms-nav-slice', ['ms-slice-nozzle', 'ms-slice-layer', 'ms-slice-walls', 'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle']],
  'ms-card-export': ['ms-nav-export', ['ms-btn-export-plate', 'ms-btn-export-stl', 'ms-btn-export-solid-plate', 'ms-btn-export-solid-stl',
                                        'ms-btn-slice-export-plate', 'ms-btn-slice-export-stl']]
};
const EXPORT_GROUPS = { 'Selection': ['ms-btn-export-plate', 'ms-btn-export-stl', 'ms-btn-export-solid-plate', 'ms-btn-export-solid-stl'],
                        'Sliced piece': ['ms-btn-slice-export-plate', 'ms-btn-slice-export-stl'] };
const DOCK = ['ms-legend-float', 'ms-legend-toggle', 'ms-legend', 'ms-detected', 'ms-title', 'ms-sub', 'ms-info-title', 'ms-info',
              'ms-lift-row', 'ms-lift-groups', 'ms-lift-read', 'ms-slice-read', 'ms-hint-badge'];
/* The ids the sidebar page had (claude-wip 6ca7251). */
const BEFORE = ['microscope', 'ms-sidebar', 'ms-title', 'ms-sub', 'ms-btn-back-producer', 'ms-btn-plate', 'ms-btn-open',
  'ms-close', 'ms-mode-orbit', 'ms-mode-select', 'ms-mode-line', 'ms-camera-row', 'ms-cam-normal',
  'ms-cam-slice', 'ms-select-controls', 'ms-btn-isolate', 'ms-btn-clear', 'ms-line-controls', 'ms-line-prev',
  'ms-line-next', 'ms-btn-isolate-line', 'ms-line-read', 'ms-detail-controls', 'ms-btn-back', 'ms-render-row',
  'ms-render-toolpath', 'ms-render-solid', 'ms-render-read', 'ms-layer-row', 'ms-layer-prev', 'ms-layer-index',
  'ms-layer-next', 'ms-btn-layer-select', 'ms-layer-note', 'ms-visibility-row', 'ms-btn-clear-view',
  'ms-btn-show-all', 'ms-btn-select-visible', 'ms-crop-row', 'ms-btn-crop', 'ms-crop-read', 'ms-support-row',
  'ms-btn-overhangs', 'ms-overhang-angle', 'ms-support-read', 'ms-lift-row', 'ms-lift-groups', 'ms-lift-read',
  'ms-slice-row', 'ms-slice-export-row', 'ms-btn-slice-export-plate', 'ms-btn-slice-export-stl',
  'ms-slice-read', 'ms-slice-settings', 'ms-slice-nozzle', 'ms-slice-layer', 'ms-slice-walls',
  'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle', 'ms-export-row', 'ms-btn-export-plate',
  'ms-btn-export-stl', 'ms-export-solid-row', 'ms-btn-export-solid-plate', 'ms-btn-export-solid-stl',
  'ms-info-title', 'ms-info', 'ms-viewport', 'ms-mode-badge', 'ms-legend-float', 'ms-legend-title',
  'ms-legend-toggle', 'ms-legend', 'ms-detected', 'ms-hint-badge', 'ms-support-pop', 'ms-sp-title',
  'ms-sp-sub', 'ms-sp-style', 'ms-sp-size', 'ms-sp-rest', 'ms-sp-generate', 'ms-sp-apply', 'ms-sp-remove',
  'ms-sp-cancel', 'ms-sp-read', 'ms-zr', 'ms-zr-hi-read', 'ms-zr-track', 'ms-zr-fill', 'ms-zr-hi', 'ms-zr-lo',
  'ms-zr-lo-read', 'ms-zr-count', 'ms-zr-all'];

/* ------------------------------------------------------------------ helpers */
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9+&◎\- ]/g, ' ').replace(/\s+/g, ' ').trim();
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/* A real click at the middle of an element, after checking that the middle is
   the element (nothing covers it). */
async function clickFace(page, sel) {
  const r = await page.evaluate(sel => {
    const e = document.querySelector(sel);
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const b = e.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return { ok: false, why: 'no box' };
    const x = b.left + b.width / 2, y = b.top + Math.min(b.height / 2, 12);
    const hit = document.elementFromPoint(x, y);
    const lab = e.id && document.querySelector('label[for="' + e.id + '"]');
    const ok = !!hit && (hit === e || e.contains(hit) || (lab && lab.contains(hit)));
    return { ok, x, y, why: ok ? '' : 'covered by ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing') };
  }, sel);
  if (!r || !r.ok) return r || { ok: false, why: 'missing' };
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(70);
  return r;
}

/* Which cards are open, and what each nav button says. */
const cardState = page => page.evaluate(([cards]) => {
  const open = [], shown = {};
  Object.keys(cards).forEach(id => {
    const c = document.getElementById(id), nav = document.getElementById(cards[id][0]);
    const vis = getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().height > 0;
    if (vis) open.push(id);
    shown[id] = { vis, cls: c.classList.contains('is-open'), on: nav.classList.contains('is-on'),
                  aria: nav.getAttribute('aria-expanded'), disabled: nav.disabled };
  });
  return { open, shown, panelHidden: document.getElementById('microscope').hidden };
}, [CARDS]);

/* Each control in the card that the engine is showing: on screen, and the
   middle of it is itself. */
const reach = (page, card) => page.evaluate(([cards, card]) => {
  const c = document.getElementById(card);
  const hit = [], hidden = [], blocked = [];
  cards[card][1].forEach(id => {
    const e = document.getElementById(id);
    if (!e || !c.contains(e)) { blocked.push(id + ' (not in the card)'); return; }
    for (let n = e; n && n !== c; n = n.parentElement) {
      if (n.hidden || getComputedStyle(n).display === 'none') { hidden.push(id); return; }
    }
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10));
    const lab = document.querySelector('label[for="' + id + '"]');
    if (r.width > 0 && r.height > 0 && t && (t === e || e.contains(t) || (lab && lab.contains(t)))) hit.push(id);
    else blocked.push(id + ' (covered by ' + (t ? (t.id || t.className || t.tagName) : 'nothing') + ')');
  });
  return { hit, hidden, blocked };
}, [CARDS, card]);

async function openCard(page, card) {
  const nav = CARDS[card][0];
  const r = await clickFace(page, '#' + nav);
  await page.waitForTimeout(60);
  return r;
}

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await page.waitForTimeout(300);
  /* Where the main page's corner sits, measured before G-scope covers it: the
     page has no header, so its viewport, Import slab and pinned panel start at
     the window's top edge - the spot G-scope's own panel, Import and corner
     row use - and switching between the two must not jump. */
  const mainPage = await page.evaluate(() => {
    const R = el => el.getBoundingClientRect();
    const imp = R(document.querySelector('#menu-import > summary')), pan = R(document.getElementById('plate-panel'));
    return { vpTop: R(document.getElementById('viewport')).top, impTop: imp.top, impLeft: imp.left,
             panelTop: pan.top, panelGap: innerWidth - pan.right };
  });
  await page.click('#btn-microscope');
  await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc() && window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 30000 });
  await page.waitForFunction(() => window.NSO_MICROSCOPE.flange().status !== 'pending', null, { timeout: 30000 });
  await frames(page);
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the ids ===');
  {
    const r = await page.evaluate(([before, cards, column, corner, dock]) => {
      const count = id => document.querySelectorAll('[id="' + id.replace(/"/g, '') + '"]').length;
      const ours = Array.from(document.querySelectorAll('#microscope [id]')).map(e => e.id);
      const dup = ours.filter((id, i) => ours.indexOf(id) !== i);
      const listed = [].concat(before, column.map(c => c[0]), corner.map(c => c[0]), dock, Object.keys(cards),
                              Object.keys(cards).map(k => cards[k][0]));
      return { missing: before.filter(id => count(id) !== 1), listedBad: listed.filter(id => count(id) !== 1),
               dup, details: document.querySelectorAll('#microscope details, #microscope summary').length,
               gone: !!document.querySelector('.ms-sidebar') };
    }, [BEFORE, CARDS, COLUMN, CORNER, DOCK]);
    check('every id the sidebar page had is on the page exactly once', r.missing.length === 0, r.missing.join(', ') || BEFORE.length + ' ids');
    check('every id the ticket lists, and the new ones, appear exactly once', r.listedBad.length === 0 && r.dup.length === 0,
      (r.listedBad.concat(r.dup)).join(', ') || 'no duplicates inside #microscope');
    check('no <details> or <summary> in #microscope', r.details === 0, String(r.details));
    check('the sidebar class is gone', !r.gone);
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. every control is where the ticket lists it ===');
  {
    const r = await page.evaluate(([column, corner, cards, exportGroups, dock]) => {
      const out = { colKids: [], colText: [], cornerKids: [], cornerText: [], cornerIn: false, cards: {}, groups: {}, dock: {}, siblings: false, cardInVp: {} };
      const col = document.getElementById('ms-sidebar');
      out.colKids = Array.from(col.children).map(e => e.id);
      out.colText = Array.from(col.children).map(e => e.textContent);
      const cr = document.getElementById('ms-corner');
      out.cornerKids = Array.from(cr.children).map(e => e.id);
      out.cornerText = Array.from(cr.children).map(e => e.textContent);
      out.cornerIn = !!cr.closest('#ms-viewport');
      Object.keys(cards).forEach(c => {
        const el = document.getElementById(c);
        out.cardInVp[c] = !!el.closest('#ms-viewport') && !el.closest('#ms-sidebar');
        out.cards[c] = cards[c][1].filter(id => !el.contains(document.getElementById(id)));
      });
      // the six export buttons in their two labelled groups
      const ex = document.getElementById('ms-card-export');
      Array.from(ex.querySelectorAll('.ms-xgroup')).forEach(g => {
        const t = g.querySelector('.ms-section-title').textContent.trim();
        out.groups[t] = Array.from(g.querySelectorAll('button')).map(b => b.id);
      });
      const dk = document.getElementById('ms-dock');
      out.dock = dock.filter(id => !dk.contains(document.getElementById(id)));
      out.dockInCard = dock.filter(id => document.getElementById(id).closest('.ms-card'));
      const o = document.getElementById('ms-mode-orbit'), s = document.getElementById('ms-mode-select'), l = document.getElementById('ms-mode-line');
      out.siblings = o.parentElement === s.parentElement && s.parentElement === l.parentElement &&
        Array.from(o.parentElement.children).filter(k => k.tagName === 'BUTTON').length === 3;
      out.navCount = document.querySelectorAll('#microscope .ms-nav').length;
      out.cornerOther = ['ms-btn-back-producer', 'ms-close'].every(id => document.getElementById(id).closest('#ms-corner'));
      return out;
    }, [COLUMN, CORNER, CARDS, EXPORT_GROUPS, DOCK]);
    check('the column holds the ten buttons in the ticket\'s order, as its direct children',
      JSON.stringify(r.colKids) === JSON.stringify(COLUMN.map(c => c[0])), r.colKids.join(' '));
    const colWrong = COLUMN.filter(([, l], i) => norm(r.colText[i]) !== l).map(([, l], i) => l + '?');
    check('each carries the ticket\'s label', colWrong.length === 0, r.colText.map(norm).join(' | '));
    check('the corner holds Back, Export, Close, in the viewport',
      JSON.stringify(r.cornerKids) === JSON.stringify(CORNER.map(c => c[0])) && r.cornerIn, r.cornerKids.join(' '));
    check('...labelled BACK, EXPORT, CLOSE', JSON.stringify(r.cornerText.map(norm)) === JSON.stringify(CORNER.map(c => c[1])), r.cornerText.map(norm).join(' | '));
    Object.keys(CARDS).forEach(c => check(c + ' holds its controls, and is in the viewport (not the column)', r.cards[c].length === 0 && r.cardInVp[c],
      r.cards[c].join(', ') || CARDS[c][1].length + ' ids'));
    check('Export: "Selection" holds the four, "Sliced piece" the two',
      JSON.stringify(r.groups) === JSON.stringify(EXPORT_GROUPS), JSON.stringify(r.groups));
    check('the dock holds the legend, the file line, the info, Features, the Slice report and the hint', r.dock.length === 0, r.dock.join(', ') || DOCK.length + ' ids');
    check('...and none of it is in a card', r.dockInCard.length === 0, r.dockInCard.join(', '));
    check('the three mode buttons are siblings, and only those three', r.siblings);
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. the geometry ===');
  await shot('01-no-card');
  {
    const g = await page.evaluate(() => {
      const R = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const panel = R('microscope'), vp = R('ms-viewport'), col = R('ms-sidebar');
      const slabs = ['ms-btn-open', 'ms-btn-plate', 'ms-nav-select', 'ms-nav-line', 'ms-nav-layer', 'ms-nav-view', 'ms-nav-render',
                     'ms-nav-overhangs', 'ms-nav-crop', 'ms-nav-slice'].map(R);
      const main = document.getElementById('btn-microscope').getBoundingClientRect();
      const mainStyle = getComputedStyle(document.getElementById('btn-microscope'));
      const slab = getComputedStyle(document.getElementById('ms-nav-select'));
      const cs = id => getComputedStyle(document.getElementById(id));
      return { panel, vp, col, slabs, mainW: main.width, mainH: main.height, mainFont: mainStyle.fontSize, mainTrack: mainStyle.letterSpacing,
               slabFont: slab.fontSize, slabTrack: slab.letterSpacing, slabCls: document.getElementById('ms-nav-select').classList.contains('vp-bar-btn'),
               corner: ['ms-btn-back-producer', 'ms-nav-export', 'ms-close'].map(id => document.getElementById(id).hidden ? null : R(id)),
               legend: R('ms-legend-float'), head: (b => ({ x: b.left, y: b.top, r: b.right, b: b.bottom }))(document.querySelector('#ms-dock-left .ms-head').getBoundingClientRect()), info: R('ms-info'),
               box: ['ms-info-title', 'ms-lift-row', 'ms-slice-readout'].map(id => { const e = document.getElementById(id).closest('.ms-glass'); if (getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }), W: innerWidth, H: innerHeight, colPos: cs('ms-sidebar').position,
               cut: ['ms-btn-open', 'ms-btn-plate', 'ms-nav-select', 'ms-nav-line', 'ms-nav-layer', 'ms-nav-view', 'ms-nav-render',
                     'ms-nav-overhangs', 'ms-nav-crop', 'ms-nav-slice'].filter(id => {
                       const e = document.getElementById(id); return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1; }),
               zr: (() => { const z = document.getElementById('ms-zr'); return z.hidden ? null : R('ms-zr'); })(),
               badge: R('ms-mode-badge') };
    });
    check('the viewport takes the sidebar\'s width: it is the whole panel',
      Math.abs(g.vp.x - g.panel.x) < 1 && Math.abs(g.vp.w - g.panel.w) < 1 && Math.abs(g.vp.h - g.panel.h) < 1, JSON.stringify([g.vp.x, g.vp.w, g.panel.w]));
    check('every slab is vp-bar-btn and the main shell column\'s width', g.slabCls && g.slabs.every(s => Math.abs(s.w - g.mainW) < 0.5),
      g.slabs.map(s => s.w).join(',') + ' vs ' + g.mainW);
    check('...in the main shell\'s face (size and tracking)', g.slabFont === g.mainFont && g.slabTrack === g.mainTrack, g.slabFont + '/' + g.slabTrack + ' vs ' + g.mainFont + '/' + g.mainTrack);
    check('...none with its label cut', g.cut.length === 0, g.cut.join(',') || 'whole');
    check('the column hugs the left edge and is narrow', g.col.x <= 12 && g.col.w <= 130, JSON.stringify([g.col.x, g.col.w]));
    // groups: pitch inside a group is one slab + the column gap; a bigger gap between groups
    const gaps = g.slabs.slice(1).map((s, i) => +(s.y - g.slabs[i].b).toFixed(1));
    let at = 0;
    const edges = GROUPS.map(n => { const e = at + n - 1; at += n; return e; });      // last slab of each group
    const inGroup = gaps.filter((_, i) => !edges.includes(i)), between = gaps.filter((_, i) => edges.includes(i));
    check('slabs run on one pitch inside a group', inGroup.every(x => Math.abs(x - inGroup[0]) < 0.6), inGroup.join(','));
    check('...with a wider gap between the three groups', between.length === 2 && between.every(x => x > inGroup[0] + 4), between.join(',') + ' vs ' + inGroup[0]);
    check('the column fits inside the window', g.slabs[g.slabs.length - 1].b <= g.H, String(g.slabs[g.slabs.length - 1].b));
    check('the corner row is pinned top-right: Export and Close at the right edge, a pitch from the top',
      g.corner[2] && g.corner[1] && Math.abs(g.W - g.corner[2].r - 8) < 1.5 && g.corner[2].y <= 12 && g.corner[1].r <= g.corner[2].x + 0.5,
      JSON.stringify(g.corner));
    check('Back is hidden until a document hands one over', g.corner[0] === null);
    const lastSlab = g.slabs[g.slabs.length - 1];
    check('the legend is on the left wall, under the column, in the lower half of the window',
      g.legend.x <= g.col.x + 2 && g.legend.y >= lastSlab.b && g.legend.b > g.H / 2 && g.legend.b <= g.H, JSON.stringify([g.legend.x, g.legend.y, g.legend.b]));
    check('the G-scope box is directly above the legend, on the same wall',
      Math.abs(g.head.x - g.legend.x) < 2 && g.head.b <= g.legend.y && g.legend.y - g.head.b < 16 && g.head.y >= lastSlab.b, JSON.stringify([g.head.x, g.head.b, g.legend.y]));
    check('the info box is along the bottom, to the right of the legend, bottom edges level',
      g.info.x >= g.legend.r && g.info.b > g.H - 40 && g.info.b <= g.H, JSON.stringify([g.info.x, g.info.b]));
    const row = g.box.filter(Boolean);
    check('the bottom boxes sit side by side on one line (none stacked over another), clear of the slider',
      row.length >= 2 && row.every(b => Math.abs(b.b - row[0].b) < 2) && row.every((b, i) => i === 0 || b.x >= row[i - 1].r) && row[row.length - 1].r <= (g.zr ? g.zr.x : g.W),
      JSON.stringify(row.map(b => [Math.round(b.x), Math.round(b.r), Math.round(b.b)])));
    check('the bottom row is short: its tallest box is under a quarter of the window', row.every(b => b.h < g.H / 4), row.map(b => Math.round(b.h)).join(','));
    check('switching to G-scope does not jump: its panel, Import and corner row sit where the main page\'s viewport, Import and pinned panel do',
      mainPage.vpTop === 0 && Math.abs(g.panel.y - mainPage.vpTop) < 0.5 &&
      Math.abs(g.slabs[0].y - mainPage.impTop) < 0.5 && Math.abs(g.slabs[0].x - mainPage.impLeft) < 0.5 &&
      g.corner[2] && Math.abs(g.corner[2].y - mainPage.panelTop) < 0.5 && Math.abs((g.W - g.corner[2].r) - mainPage.panelGap) < 0.5,
      JSON.stringify({ main: mainPage, gscope: { panelY: g.panel.y, importY: g.slabs[0].y, importX: g.slabs[0].x, closeY: g.corner[2] && g.corner[2].y, closeGap: g.corner[2] && g.W - g.corner[2].r } }));
    check('the layer-range slider (when up) is clear of the corner row', !g.zr || g.zr.y >= g.corner[1].b, JSON.stringify(g.zr));
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. each card opens and shuts from its button ===');
  {
    let st = await cardState(page);
    check('no card is open to begin with', st.open.length === 0, st.open.join(','));
    const dis = Object.keys(CARDS).filter(c => st.shown[c].disabled);
    check('on a plate piece, nothing selected: Line, Render and Export are disabled (their rows are hidden); the rest are not',
      JSON.stringify(dis.sort()) === JSON.stringify(['ms-card-export', 'ms-card-line', 'ms-card-render']), dis.join(','));
    const openable = Object.keys(CARDS).filter(c => !st.shown[c].disabled);
    for (const card of openable) {
      await openCard(page, card);
      st = await cardState(page);
      const right = await page.evaluate(([card, nav]) => {
        const c = document.getElementById(card).getBoundingClientRect(), col = document.getElementById('ms-sidebar').getBoundingClientRect();
        return { x: c.left, y: c.top, r: c.right, b: c.bottom, colR: col.right, W: innerWidth, H: innerHeight };
      }, [card, CARDS[card][0]]);
      check(card + ' opens from ' + CARDS[card][0] + ', alone, and its button lights',
        JSON.stringify(st.open) === JSON.stringify([card]) && st.shown[card].on && st.shown[card].aria === 'true' &&
        Object.keys(CARDS).filter(c => c !== card).every(c => !st.shown[c].on && st.shown[c].aria === 'false'), st.open.join(','));
      if (card === 'ms-card-export') check('...under the corner row, inside the window', right.y >= 40 && right.r <= right.W && right.b <= right.H, JSON.stringify(right));
      else check('...to the right of the column, at the top of the viewport, inside the window',
        right.x >= right.colR && right.y <= 16 && right.r <= right.W && right.b <= right.H, JSON.stringify(right));
      await shot('02-card-' + card.replace('ms-card-', ''));
    }
    // swap: another button replaces the open card
    await openCard(page, 'ms-card-view');
    await openCard(page, 'ms-card-layer');
    st = await cardState(page);
    check('another button swaps the card: only one is open', JSON.stringify(st.open) === JSON.stringify(['ms-card-layer']), st.open.join(','));
    // same button again shuts it
    await openCard(page, 'ms-card-layer');
    st = await cardState(page);
    check('its own button again shuts it', st.open.length === 0 && !st.shown['ms-card-layer'].on && st.shown['ms-card-layer'].aria === 'false', st.open.join(','));
    // a disabled button does nothing
    const before = await cardState(page);
    await page.evaluate(() => document.getElementById('ms-nav-line').click());
    st = await cardState(page);
    check('a disabled button opens nothing', st.open.length === 0 && before.open.length === 0, st.open.join(','));
    // Escape
    await openCard(page, 'ms-card-select');
    await page.focus('#ms-nav-select');
    await page.keyboard.press('Escape');
    st = await cardState(page);
    check('Escape shuts the open card and leaves G-scope up', st.open.length === 0 && !st.panelHidden, JSON.stringify([st.open, st.panelHidden]));
    // a click on a card control is the control, not the card
    await openCard(page, 'ms-card-select');
    await clickFace(page, '#ms-mode-select');
    const act = await page.evaluate(() => [document.getElementById('ms-mode-select').classList.contains('active'),
      document.getElementById('ms-mode-orbit').classList.contains('active'), window.NSO_MICROSCOPE.mode(),
      getComputedStyle(document.getElementById('ms-select-controls')).display]);
    check('Select\'s mode buttons keep their active state, and select mode shows its rows in the card', act[0] && !act[1] && act[2] === 'select' && act[3] !== 'none', JSON.stringify(act));
    check('every control in Select\'s card can be hit with a real click', (r => r.blocked.length === 0 && r.hit.length >= 5)(await reach(page, 'ms-card-select')),
      JSON.stringify(await reach(page, 'ms-card-select')));
    await shot('03-select-mode');
    await clickFace(page, '#ms-mode-orbit');
    await openCard(page, 'ms-card-select');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. every control in an open card can be hit ===');
  {
    for (const card of ['ms-card-layer', 'ms-card-view', 'ms-card-overhangs', 'ms-card-crop', 'ms-card-slice']) {
      await openCard(page, card);
      const r = await reach(page, card);
      const shown = r.hit.length, expect = CARDS[card][1].filter(id => !r.hidden.includes(id)).length;
      check(card + ': ' + shown + ' control(s) up, each hit-testable', r.blocked.length === 0 && shown === expect && shown > 0,
        'hit ' + r.hit.join(',') + (r.hidden.length ? ' | hidden by state: ' + r.hidden.join(',') : '') + (r.blocked.length ? ' | blocked: ' + r.blocked.join(',') : ''));
      await openCard(page, card);
    }
    // the slice settings are plain fields now
    await openCard(page, 'ms-card-slice');
    const f = await page.evaluate(() => ['nozzle', 'layer', 'walls', 'density', 'pattern', 'angle'].map(k => {
      const e = document.getElementById('ms-slice-' + k); const b = e.getBoundingClientRect();
      return [k, b.width > 0 && b.height > 0, e.closest('details') === null];
    }));
    check('Slice: nozzle, layer, walls, infill %, pattern, support below - all showing, none in a <details>', f.every(x => x[1] && x[2]), JSON.stringify(f));
    await shot('04-slice-settings');
    await openCard(page, 'ms-card-slice');
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the readouts stay up; their rows land where they did ===');
  {
    await openCard(page, 'ms-card-overhangs');
    const r = await page.evaluate(() => {
      const vis = id => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && b.width > 0 && b.height > 0; };
      return { info: vis('ms-info'), legend: vis('ms-legend-float'), lift: vis('ms-lift-row'), sub: vis('ms-sub'),
               liftIn: !!document.querySelector('#ms-lift-row #ms-lift-read'), liftRows: document.querySelectorAll('#ms-lift-row .ms-lift-group').length,
               liftText: document.getElementById('ms-lift-read').textContent, info1: document.getElementById('ms-info').textContent,
               legendRows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
               support: document.getElementById('ms-support-read').textContent, sliceRead: document.getElementById('ms-slice-read').textContent,
               sliceReadOut: getComputedStyle(document.getElementById('ms-slice-readout')).display,
               sub1: document.getElementById('ms-sub').textContent };
    });
    check('with a card open the legend, the file line, the info and Features are all still up', r.info && r.legend && r.lift && r.sub, JSON.stringify([r.info, r.legend, r.lift, r.sub]));
    check('the legend lists the plate\'s parts', r.legendRows >= 1, String(r.legendRows));
    check('Features (app-gscope-lift.js) landed in #ms-lift-row', r.liftIn && r.liftText.length > 1, r.liftText.slice(0, 70));
    check('the overhang readout (app-gscope-support.js) landed in the Overhangs card', r.support.length > 1 && !/^—$/.test(r.support), r.support.slice(0, 70));
    check('the Slice report is up in the dock', r.sliceReadOut !== 'none' && r.sliceRead.length > 1, r.sliceRead.slice(0, 70));
    await shot('05-overhangs');
    await clickFace(page, '#ms-btn-overhangs');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.getElementById('ms-support-read').textContent);
    check('Show overhangs still writes its readout into the card', after !== r.support || /overhang/i.test(after), after.slice(0, 90));
    await clickFace(page, '#ms-btn-overhangs');
    await openCard(page, 'ms-card-overhangs');
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. Select shown, then Slice view ===');
  {
    await openCard(page, 'ms-card-view');
    const r0 = await clickFace(page, '#ms-btn-select-visible');
    check('Select shown is clickable in the View card', r0 && r0.ok, r0 && r0.why);
    await page.waitForTimeout(150);
    let st = await cardState(page);
    check('with a selection Export is enabled; Line and Render still are not',
      !st.shown['ms-card-export'].disabled && st.shown['ms-card-line'].disabled && st.shown['ms-card-render'].disabled);
    await openCard(page, 'ms-card-export');
    const ex = await page.evaluate(() => {
      const gs = Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(g => ({
        t: g.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(g).display !== 'none' && g.getBoundingClientRect().height > 0,
        btns: Array.from(g.querySelectorAll('button')).map(b => [b.id, b.getBoundingClientRect().width > 0, b.disabled]) }));
      return gs;
    });
    check('Export, mesh selection: "Selection" shows its two (plate, STL), "Sliced piece" is out of the way',
      ex[0].shown && !ex[1].shown && ex[0].btns.filter(b => b[1]).map(b => b[0]).join() === 'ms-btn-export-plate,ms-btn-export-stl', JSON.stringify(ex));
    const rr = await reach(page, 'ms-card-export');
    check('...and those are hit-testable and enabled', rr.blocked.length === 0 && rr.hit.length === 2 && ex[0].btns.filter(b => b[1]).every(b => !b[2]), JSON.stringify(rr));
    await shot('06-export-selection');
    await openCard(page, 'ms-card-export');

    // Slice view, from the View card
    await openCard(page, 'ms-card-view');
    await clickFace(page, '#ms-cam-slice');
    const sawBusy = await page.evaluate(() => document.getElementById('ms-slice-read').textContent);
    await page.waitForFunction(() => {
      const d = window.NSO_MICROSCOPE.getDoc();
      return !window.NSO_GSCOPE_SLICE.busy() && d && d.kind === 'toolpath' && !!d.nsoSlice;
    }, null, { timeout: 120000 });
    await frames(page);
    check('slice progress text shows in the dock while it runs', /Slic/i.test(sawBusy), sawBusy.slice(0, 60));
    st = await cardState(page);
    const dis = Object.keys(CARDS).filter(c => st.shown[c].disabled).sort();
    check('a slice is a toolpath: Render, Layer and Export are up; Line waits for Pick a line; Overhangs belong to a mesh',
      JSON.stringify(dis) === JSON.stringify(['ms-card-line', 'ms-card-overhangs']), dis.join(','));
    const rep = await page.evaluate(() => document.getElementById('ms-slice-read').textContent);
    check('the slice report is in the dock', rep.length > 20 && /layer|wall|infill|slice/i.test(rep), rep.slice(0, 90));
    await shot('07-sliced-view');

    // RENDER
    await openCard(page, 'ms-card-render');
    const rd = await reach(page, 'ms-card-render');
    check('Render opens with Toolpath and Solid, both hit-testable', rd.blocked.length === 0 && rd.hit.length === 2, JSON.stringify(rd));
    await shot('08-render');
    await openCard(page, 'ms-card-render');

    // LINE
    await openCard(page, 'ms-card-select');
    await clickFace(page, '#ms-mode-line');
    await page.waitForTimeout(100);
    st = await cardState(page);
    check('Pick a line turns the Line button on', !st.shown['ms-card-line'].disabled, JSON.stringify(st.shown['ms-card-line']));
    const act = await page.evaluate(() => [document.getElementById('ms-mode-line').classList.contains('active'), window.NSO_MICROSCOPE.mode()]);
    check('...with the mode button active as before', act[0] && act[1] === 'line', JSON.stringify(act));
    await openCard(page, 'ms-card-line');
    const ln = await reach(page, 'ms-card-line');
    check('Line opens with line, line, Isolate - each hit-testable', ln.blocked.length === 0 && ln.hit.length === 3, JSON.stringify(ln));
    await shot('09-line');
    await openCard(page, 'ms-card-line');

    // LAYER on a slice
    await openCard(page, 'ms-card-layer');
    const ly = await reach(page, 'ms-card-layer');
    check('Layer: ▼ · index · ▲ · Select layer, each hit-testable', ly.blocked.length === 0 && ly.hit.length === 4, JSON.stringify(ly));
    await shot('10-layer');
    await openCard(page, 'ms-card-layer');

    // EXPORT, with a slice
    await openCard(page, 'ms-card-view');
    await clickFace(page, '#ms-btn-select-visible');
    await openCard(page, 'ms-card-export');
    const ex2 = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(g => ({
      t: g.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(g).display !== 'none' && g.getBoundingClientRect().height > 0,
      btns: Array.from(g.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => b.id) })));
    check('Export, a slice with a selection: all six - "Selection" four, "Sliced piece" two',
      ex2.length === 2 && ex2[0].btns.length === 4 && ex2[1].btns.length === 2 && ex2[0].shown && ex2[1].shown, JSON.stringify(ex2));
    const rr2 = await reach(page, 'ms-card-export');
    check('...each hit-testable', rr2.blocked.length === 0 && rr2.hit.length === 6, JSON.stringify(rr2));
    await shot('11-export-slice');
    await openCard(page, 'ms-card-export');

    // Normal goes back to the mesh and the button states follow
    await openCard(page, 'ms-card-view');
    await clickFace(page, '#ms-cam-normal');
    await page.waitForFunction(() => window.NSO_MICROSCOPE.getDoc().kind === 'mesh', null, { timeout: 30000 });
    await page.waitForTimeout(150);
    st = await cardState(page);
    check('Normal goes back to the mesh: Line and Render are disabled again, and the View card stays open',
      st.shown['ms-card-line'].disabled && st.shown['ms-card-render'].disabled && st.open.join() === 'ms-card-view', st.open.join());
    await openCard(page, 'ms-card-view');
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. the ladder of Escapes, and the short window ===');
  {
    await openCard(page, 'ms-card-crop');
    await page.focus('#ms-nav-crop');
    await page.keyboard.press('Escape');
    let st = await cardState(page);
    check('Escape 1: the card shuts, G-scope stays', st.open.length === 0 && !st.panelHidden);
    // Export needs a selection to have anything to show.
    await openCard(page, 'ms-card-view');
    await clickFace(page, '#ms-btn-select-visible');
    await openCard(page, 'ms-card-view');
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForTimeout(250);
    await frames(page);
    const short = await page.evaluate(([cards]) => {
      const H = innerHeight, W = innerWidth;
      const slabs = Array.from(document.querySelectorAll('#ms-sidebar > button')).map(b => b.getBoundingClientRect());
      const corner = Array.from(document.querySelectorAll('#ms-corner > button:not([hidden])')).map(b => b.getBoundingClientRect());
      const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom }; };
      const left = r('ms-dock-left');
      const boxes = ['ms-info-title', 'ms-lift-row', 'ms-slice-readout'].map(id => document.getElementById(id).closest('.ms-glass')).filter(e => getComputedStyle(e).display !== 'none')
        .map(e => e.getBoundingClientRect());
      return { H, W, colB: Math.max(...slabs.map(b => b.bottom)), cornerR: Math.max(...corner.map(b => b.right)), left,
               rowTop: Math.min(...boxes.map(b => b.top)), rowR: Math.max(...boxes.map(b => b.right)) };
    }, [CARDS]);
    check('1024 x 720: the column ends inside the window', short.colB <= short.H, String(short.colB));
    check('1024 x 720: the corner row stays inside', short.cornerR <= short.W, String(short.cornerR));
    check('1024 x 720: the left wall\'s boxes end inside the window and start under the column', short.left.b <= short.H && short.left.y >= short.colB, JSON.stringify([short.left, short.colB]));
    check('1024 x 720: the bottom boxes are inside the window and clear of the slider', short.rowTop >= 0 && short.rowR <= short.W - 76, JSON.stringify([short.rowTop, short.rowR]));
    for (const card of ['ms-card-select', 'ms-card-layer', 'ms-card-view', 'ms-card-overhangs', 'ms-card-crop', 'ms-card-slice', 'ms-card-export']) {
      await openCard(page, card);
      const r = await page.evaluate(card => { const b = document.getElementById(card).getBoundingClientRect(); return { b: b.bottom, r: b.right, t: b.top, l: b.left, H: innerHeight, W: innerWidth,
        on: getComputedStyle(document.getElementById(card)).display !== 'none' }; }, card);
      check('1024 x 720: ' + card + ' opens inside the window', r.on && r.b <= r.H && r.r <= r.W && r.t >= 0 && r.l >= 0, JSON.stringify(r));
      if (card === 'ms-card-slice') await shot('12-short-window-slice');
      await openCard(page, card);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
    await clickFace(page, '#ms-nav-select');
    await page.focus('#ms-nav-select');
    await page.keyboard.press('Escape');
    st = await cardState(page);
    check('Escape with a card open shuts only the card', st.open.length === 0 && !st.panelHidden);
    await page.keyboard.press('Escape');
    st = await cardState(page);
    check('Escape 2, none open: G-scope closes, as it always did', st.panelHidden);
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('GSCOPE SHELL FAIL', e); process.exit(1); });
