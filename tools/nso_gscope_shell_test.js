#!/usr/bin/env node
/* G-scope shell, round 2c: ONE card (docs/GSCOPE.md item 12).

   The left column (IMPORT · READ PLATE | SELECT · VIEW) and its SELECT and
   VIEW cards are gone. In their place one permanent card, top-left:

     [ IMPORT ▾ ]      Normal ○━━● Slice       the head: IMPORT stands at the main
     ---------------------------------------    page's Import spot, its ▾ holds Read
      the selection rows for the switch's side  plate; the switch is the view

   Normal side: REGION · WHOLE PART. Slice side: REGION · TAKE BAND ·
   Toolpath | Solid · Slice settings (folded; their defaults are the plate's
   printer profile). The side is the document's: a toolpath is the Slice side.

   Unchanged: the corner row BACK · ◎ · CLEAR · EXPORT · CLOSE, pinned top-right
   (Export's card opens under it); the dock - down the left wall, under the
   card, the file line and the Features list (Check all in its head); along
   the bottom SELECTION / SEGMENT INFO, the Slice report and the hint; the
   layer-range slider on the right; the mode badge top centre.

   GATES
     1. The ids: the card once, inside the viewport, not a .ms-card; the ▾ menu,
        the switch and every row (with its controls, its data-on) once; every
        id the column, SELECT and VIEW had that round 2c removed - and round
        1b's - is gone; no column; every other id the sidebar page had is
        still there once; Check all is in the Features list's head.
     2. On open (box-20mm, the plate read): the card is up top-left on the
        Normal side with its 2 rows; Normal active, Slice enabled; Whole part
        off; Region on, not armed; no label cut; IMPORT at the main page's
        Import spot (left / top / height), IMPORT ▾ the main Import's width;
        the corner, the dock, the readouts and the viewport where they were
        (no jump).
     3. IMPORT ▾: a real click opens the menu; a press outside, Escape and
        IMPORT shut it; IMPORT opens the file picker (#ms-input); Read plate
        (in the ▾) and IMPORT both load into the ACTIVE plate - plate 2 here,
        plate 1 untouched.
     4. The switch is the view and the row set: an imported slice is the
        Slice side with Normal off; on plate 1's mesh Slice slices (busy on the
        switch and in the Slice report, its label kept) and flips to the Slice
        side, 4 rows; the track (in 6) and Normal (in 8) go back to the mesh,
        2 rows.
     5. Slice settings: folded on the Slice side; a real click unfolds them;
        their values are NSO_GSCOPE_SLICE.profileDefaults(), 0.4 / 0.2 for
        the A1 mini; every field is hit-testable and shows its whole value;
        the slice was made with them; an edit survives a Normal / Slice round
        trip and the next slice takes it (in 6 and 7).
     6. Every removed control's job at its new home: Piece (a click in the
        view), Feature (the Features list), Line (the hover readout), Layer
        (slider + Take band), Region (the REGION row), Normal / Slice (the
        switch), Toolpath / Solid (the Slice side's row), Slice settings (the
        Slice row), Check all (the Features head), Clear from view (the corner
        CLEAR), Select shown (gone: Take band at All), Read plate (the ▾) -
        and the Export card, as it was. What the contract dropped - isolating
        one move from the UI, the Select shown and Clear from view buttons,
        the five-mode row - is checked gone, with the API that remains.
     7. The Features list and the slider are as they were.
     8. Layout: the card clears the corner row, the badge and the slider; the
        left wall stays under the card on both sides and with the Slice
        settings unfolded, at 1280 x 800 and 1024 x 720; at 1024 x 720 the
        card, the corner, the bottom boxes and the Export card fit.
     9. The Escape ladder: the ▾ menu -> the isolate -> the box -> REGION ->
        G-scope closes; CLOSE shuts the menu, and a new visit starts folded on
        the printer profile.
    10. No page errors.

   Screenshots go to tools/gscope-shell-out/ (git-ignored). card-normal.png,
   card-slice.png and card-slice-settings.png are the PR's.

     node tools/nso_gscope_shell_test.js       exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const J = JSON.stringify;
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const SHOTS = path.join(ROOT, 'tools', 'gscope-shell-out');
const BOX = path.join(ROOT, 'fixtures', 'box-20mm.stl');
const SLICED = path.join(ROOT, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');

/* ---------------------------------------------------------------- the ticket */
/* BACK · ◎ · CLEAR · EXPORT · CLOSE. The two plates stand side by side in the view and a click on one
   makes it active, so there is no plate toggle (docs/GSCOPE.md); ◎ frames both plates. */
const CORNER = [['ms-btn-back-producer', 'BACK'], ['ms-btn-frame', '◎'], ['ms-btn-take-clear', 'CLEAR'],
                ['ms-nav-export', 'EXPORT'], ['ms-close', 'CLOSE']];
/* The card's head: IMPORT ▾, then the switch Normal ○━━● Slice. */
const HEAD = ['ms-btn-open', 'ms-btn-import-more', 'ms-camera-row', 'ms-cam-normal', 'ms-cam-slice'];
/* The card's rows: [id, the sides it shows on (data-on), the ids it holds]. */
const ROWS = [
  ['ms-region-row', 'normal slice', ['ms-mode-select', 'ms-btn-isolate', 'ms-btn-clear', 'ms-region-note']],
  ['ms-whole-row', 'normal', ['ms-btn-back']],
  ['ms-band-row', 'slice', ['ms-btn-take-band', 'ms-band-read']],
  ['ms-compare-row', 'normal slice', ['ms-compare-toggle', 'ms-compare-body', 'ms-compare-start', 'ms-compare-overlay', 'ms-compare-tint', 'ms-compare-restore', 'ms-compare-step', 'ms-compare-read']],
  ['ms-render-row', 'slice', ['ms-render-toolpath', 'ms-render-solid', 'ms-render-read']],
  ['ms-slice-row', 'slice', ['ms-slice-settings-toggle', 'ms-slice-settings', 'ms-slice-nozzle', 'ms-slice-layer', 'ms-slice-walls',
                             'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle', 'ms-slice-settings-note']],
  ['ms-measure-row', 'slice', ['ms-measure-toggle', 'ms-measure', 'ms-measure-head', 'ms-measure-warn', 'ms-measure-feats', 'ms-measure-layers-toggle',
                               'ms-measure-copy', 'ms-measure-layers']],
  ['ms-play-row', 'slice', ['ms-play-toggle', 'ms-play', 'ms-play-prev', 'ms-play-run', 'ms-play-next', 'ms-play-speed', 'ms-play-scrub', 'ms-play-read']]
];
const NORMAL_ROWS = ['ms-region-row', 'ms-whole-row'];
const SLICE_ROWS = ['ms-region-row', 'ms-band-row', 'ms-render-row', 'ms-slice-row', 'ms-measure-row', 'ms-play-row'];
const SETTINGS = ['ms-slice-nozzle', 'ms-slice-layer', 'ms-slice-walls', 'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle'];
/* Export: one card, from the corner, as it was. */
const EXPORT_IDS = ['ms-btn-export-plate', 'ms-btn-export-stl', 'ms-btn-export-solid-plate', 'ms-btn-export-solid-stl',
                    'ms-btn-slice-export-plate', 'ms-btn-slice-export-stl'];
const EXPORT_GROUPS = { 'Selection': ['ms-btn-export-plate', 'ms-btn-export-stl', 'ms-btn-export-solid-plate', 'ms-btn-export-solid-stl'],
                        'Sliced piece': ['ms-btn-slice-export-plate', 'ms-btn-slice-export-stl'],
                        'Whole plate': ['ms-btn-take-export-plate', 'ms-btn-take-export-stl'] };   // the last shows on a plate of pieces or a mesh, either plate
const DOCK = ['ms-legend-float', 'ms-legend-title', 'ms-legend-toggle', 'ms-legend', 'ms-btn-show-all', 'ms-title', 'ms-sub',
              'ms-info-title', 'ms-info', 'ms-slice-readout', 'ms-slice-read', 'ms-hint-badge'];
const SLIDER = ['ms-zr', 'ms-zr-hi-read', 'ms-zr-track', 'ms-zr-fill', 'ms-zr-hi', 'ms-zr-lo', 'ms-zr-lo-read', 'ms-zr-count', 'ms-zr-card', 'ms-zr-all'];
/* What round 1b took out of G-scope: no element keeps these ids. */
const GONE_1B = ['ms-nav-render', 'ms-nav-overhangs', 'ms-nav-crop', 'ms-nav-slice', 'ms-card-render', 'ms-card-overhangs', 'ms-card-crop',
                 'ms-card-slice', 'ms-support-row', 'ms-btn-overhangs', 'ms-overhang-angle', 'ms-support-read', 'ms-crop-row', 'ms-btn-crop', 'ms-crop-read'];
/* What round 2c took out: the column, the SELECT and VIEW cards and the controls whose jobs moved (gate 6). */
const GONE_2C = ['ms-sidebar', 'ms-card-select', 'ms-card-view', 'ms-nav-select', 'ms-nav-view',
                 'ms-mode-piece', 'ms-mode-feature', 'ms-mode-line', 'ms-mode-layer', 'ms-mode-row', 'ms-mode-note', 'ms-select-controls',
                 'ms-line-controls', 'ms-line-prev', 'ms-line-next', 'ms-line-read', 'ms-btn-isolate-line',
                 'ms-layer-row', 'ms-layer-prev', 'ms-layer-index', 'ms-layer-next', 'ms-btn-layer-select', 'ms-layer-note',
                 'ms-detail-controls', 'ms-visibility-row', 'ms-btn-clear-view', 'ms-btn-select-visible'];
const GONE = GONE_1B.concat(GONE_2C);
/* The ids the sidebar page had (claude-wip 6ca7251), less what rounds 1b and 2c retired: still here, once each. */
const BEFORE = ['microscope', 'ms-sidebar', 'ms-title', 'ms-sub', 'ms-btn-back-producer', 'ms-btn-plate', 'ms-btn-open',
  'ms-close', 'ms-mode-select', 'ms-mode-line', 'ms-camera-row', 'ms-cam-normal',
  'ms-cam-slice', 'ms-select-controls', 'ms-btn-isolate', 'ms-btn-clear', 'ms-line-controls', 'ms-line-prev',
  'ms-line-next', 'ms-btn-isolate-line', 'ms-line-read', 'ms-detail-controls', 'ms-btn-back', 'ms-render-row',
  'ms-render-toolpath', 'ms-render-solid', 'ms-render-read', 'ms-layer-row', 'ms-layer-prev', 'ms-layer-index',
  'ms-layer-next', 'ms-btn-layer-select', 'ms-layer-note', 'ms-visibility-row', 'ms-btn-clear-view',
  'ms-btn-show-all', 'ms-btn-select-visible',
  'ms-slice-row', 'ms-slice-export-row', 'ms-btn-slice-export-plate', 'ms-btn-slice-export-stl',
  'ms-slice-read', 'ms-slice-settings', 'ms-slice-nozzle', 'ms-slice-layer', 'ms-slice-walls',
  'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle', 'ms-export-row', 'ms-btn-export-plate',
  'ms-btn-export-stl', 'ms-export-solid-row', 'ms-btn-export-solid-plate', 'ms-btn-export-solid-stl',
  'ms-info-title', 'ms-info', 'ms-viewport', 'ms-mode-badge', 'ms-legend-float', 'ms-legend-title',
  'ms-legend-toggle', 'ms-legend', 'ms-hint-badge', 'ms-support-pop', 'ms-sp-title',
  'ms-sp-sub', 'ms-sp-style', 'ms-sp-size', 'ms-sp-rest', 'ms-sp-generate', 'ms-sp-apply', 'ms-sp-remove',
  'ms-sp-cancel', 'ms-sp-read', 'ms-zr', 'ms-zr-hi-read', 'ms-zr-track', 'ms-zr-fill', 'ms-zr-hi', 'ms-zr-lo',
  'ms-zr-lo-read', 'ms-zr-count', 'ms-zr-all'].filter(id => !GONE.includes(id));

/* ------------------------------------------------------------------ helpers */
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9+&◎▾\- ]/g, ' ').replace(/\s+/g, ' ').trim();
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/* In the page: where a point of the active plate's document lands on screen,
   and a spot of bare canvas (nothing to take under it). */
const PAGE_HELPERS = `
  window.__s = (function () {
    const M = () => window.NSO_MICROSCOPE;
    const rect = () => M().getView().renderer.domElement.getBoundingClientRect();
    const toPx = v => { const p = v.clone().project(M().getView().camera), r = rect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; };
    const pxOf = (x, y, z) => { const d = M().getDoc(); return toPx(new THREE.Vector3(x - d.cx, z, -(y - d.cy))); };
    return {
      pxOf,
      /* the top of the first piece, in the middle */
      pxPiece: () => { const b = M().getDoc().objects[0].bounds; return pxOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ); },
      /* the middle of a printed move on the top layer (the nearest the camera) */
      pxTopMove: () => { const d = M().getDoc(); let s = null;
        d.segments.forEach(g => { if (g.feature !== 'Travel' && (!s || g.z > s.z || (g.z === s.z && g.feature === 'Outer wall' && s.feature !== 'Outer wall'))) s = g; });
        return pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z); },
      emptyPx: () => {
        const v = M().getView(), r = rect(), rc = new THREE.Raycaster(); rc.params.Line.threshold = 2;
        const roots = [v.overviewGroup, v.detailGroup, v.highlightGroup];
        for (let fy = 0.9; fy > 0.3; fy -= 0.03) for (let fx = 0.45; fx < 0.85; fx += 0.03) {
          const x = r.left + fx * r.width, y = r.top + fy * r.height;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
          if (!rc.intersectObjects(roots, true).length && document.elementFromPoint(x, y) === v.renderer.domElement) return [x, y];
        }
        return null;
      },
      /* a plate's own fingerprint: what it holds, not where the camera is */
      plateSig: n => { const s = M().plateState(n); return s ? JSON.stringify([s.doc, s.kind, s.source, s.sum, s.coords]) : 'empty'; },
      /* the slice's layer pitch: the median step between its printed Zs */
      layerPitch: () => { const d = M().getDoc(); if (!d || d.kind !== 'toolpath') return null;
        const zs = Array.from(new Set(d.segments.filter(g => g.feature !== 'Travel').map(g => +g.z.toFixed(4)))).sort((a, b) => a - b);
        const st = zs.slice(1).map((z, i) => z - zs[i]).sort((a, b) => a - b);
        return st.length ? +st[st.length >> 1].toFixed(4) : null; }
    };
  })();
`;

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

/* Each id: shown, and the middle of it is itself (a real click lands on it). */
const reach = (page, ids) => page.evaluate(ids => {
  const hit = [], hidden = [], blocked = [];
  ids.forEach(id => {
    const e = document.getElementById(id);
    if (!e || !e.getClientRects().length) { hidden.push(id); return; }
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10));
    const lab = document.querySelector('label[for="' + id + '"]');
    if (r.width > 0 && r.height > 0 && t && (t === e || e.contains(t) || (lab && lab.contains(t)))) hit.push(id);
    else blocked.push(id + ' (covered by ' + (t ? (t.id || t.className || t.tagName) : 'nothing') + ')');
  });
  return { hit, hidden, blocked };
}, ids);

/* Which of these show a label or value wider than their box (cut): id (content px > box px, the text). */
const cutOff = (page, ids) => page.evaluate(ids => ids.map(id => document.getElementById(id)).filter(e => e && e.getClientRects().length &&
  (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1))
  .map(e => e.id + ' (' + e.scrollWidth + ' > ' + e.clientWidth + ' px: "' + (e.tagName === 'SELECT' ? e.options[e.selectedIndex].text : e.value || e.textContent.trim()) + '")'), ids);

/* The card as a person sees it: its side, the rows up, the switch, REGION and WHOLE PART. */
const cardState = page => page.evaluate(() => {
  const $ = id => document.getElementById(id);
  const c = $('ms-main-card');
  const up = e => !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0;
  const btn = id => { const b = $(id); return { active: b.classList.contains('active'), pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, text: b.textContent.trim() }; };
  const S = window.NSO_GSCOPE_SLICE, M = window.NSO_MICROSCOPE;
  return {
    up: up(c), side: c.dataset.side, cardSide: M.cardSide(), viewMode: S.viewMode(),
    rows: Array.from(c.querySelectorAll('.ms-row')).filter(up).map(r => r.id).filter(id => id !== 'ms-compare-row'),   /* Compare shows with a file on each plate: its own test (nso_gscope_compare_test.js) */
    normal: btn('ms-cam-normal'), slice: btn('ms-cam-slice'), region: btn('ms-mode-select'), whole: btn('ms-btn-back'),
    isolate: btn('ms-btn-isolate'), clearBoxes: btn('ms-btn-clear'), band: btn('ms-btn-take-band'),
    regionNote: up($('ms-region-note')), mode: M.mode(), open: c.classList.contains('is-open'),
    busy: $('ms-camera-row').classList.contains('is-busy'), plate: M.plate()
  };
});

/* The two that open: IMPORT's ▾ menu and Export. */
const opens = page => page.evaluate(() => {
  const $ = id => document.getElementById(id);
  const one = (card, nav) => { const c = $(card), b = $(nav), r = c.getBoundingClientRect();
    return { open: c.classList.contains('is-open'), vis: getComputedStyle(c).display !== 'none' && r.height > 0,
             on: b.classList.contains('is-on'), aria: b.getAttribute('aria-expanded'), disabled: b.disabled }; };
  return { menu: one('ms-import-menu', 'ms-btn-import-more'), exp: one('ms-card-export', 'ms-nav-export'),
           panelHidden: $('microscope').hidden, isOpen: window.NSO_MICROSCOPE.isOpen() };
});

const exportGroups = page => page.evaluate(() => Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(g => ({
  t: g.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(g).display !== 'none' && g.getBoundingClientRect().height > 0,
  btns: Array.from(g.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => [b.id, b.disabled]) })));

/* Rectangles of the layout gate. */
const layout = page => page.evaluate(() => {
  const R = e => { if (!e || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const $ = id => document.getElementById(id);
  const corner = Array.from(document.querySelectorAll('#ms-corner > button')).filter(b => !b.hidden).map(R).filter(Boolean);
  const zr = $('ms-zr');
  const panel = $('microscope').getBoundingClientRect();
  return { W: innerWidth, H: innerHeight, card: R($('ms-main-card')), corner, badge: R($('ms-mode-badge')),
           zr: zr.hidden ? null : R(zr), left: R($('ms-dock-left')), panelTop: panel.top,
           cardVar: parseFloat(getComputedStyle($('microscope')).getPropertyValue('--ms-card-bottom')),
           boxes: ['ms-info-title', 'ms-slice-readout'].map(id => $(id).closest('.ms-glass')).filter(e => getComputedStyle(e).display !== 'none').map(R),
           side: $('ms-main-card').dataset.side, unfolded: !$('ms-slice-settings').hidden };
});
const overlaps = (a, b) => !!a && !!b && a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;

/* The layout gate at the window size it is run at: one line per rule. */
function layoutChecks(L, tag) {
  check(tag + ': the card clears the corner row, the badge and the slider',
    !L.corner.some(c => overlaps(L.card, c)) && !overlaps(L.card, L.badge) && !overlaps(L.card, L.zr),
    J({ card: L.card && [L.card.x, L.card.y, L.card.r, L.card.b].map(Math.round), badge: L.badge && [L.badge.x, L.badge.r].map(Math.round), zr: L.zr && L.zr.x }));
  check(tag + ': the left wall stays under the card (its top at or below the card\'s bottom), inside the window',
    L.card && L.left && L.left.y >= L.card.b - 0.5 && L.left.b <= L.H + 0.5,
    J({ cardBottom: L.card && Math.round(L.card.b), wallTop: L.left && Math.round(L.left.y), wallBottom: L.left && Math.round(L.left.b), H: L.H }));
  check(tag + ': --ms-card-bottom is the card\'s bottom edge', L.card && Math.abs(L.cardVar - (L.card.b - L.panelTop)) <= 1.5,
    J([L.cardVar, L.card && Math.round(L.card.b - L.panelTop)]));
  check(tag + ': the card is inside the window', L.card && L.card.x >= 0 && L.card.y >= 0 && L.card.r <= L.W && L.card.b <= L.H, J(L.card));
}

/* Which Escape this is, with the panel holding the keyboard (it owns Escape). */
async function escape(page) {
  const inPanel = await page.evaluate(() => { const p = document.getElementById('microscope'); return !!p && p.contains(document.activeElement); });
  if (!inPanel) await page.evaluate(() => document.getElementById('microscope').focus());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  await frames(page);
}

const waitSlice = page => page.waitForFunction(() => {
  const d = window.NSO_MICROSCOPE.getDoc();
  return !window.NSO_GSCOPE_SLICE.busy() && d && d.kind === 'toolpath' && !!d.nsoSlice;
}, null, { timeout: 120000 });
const waitMesh = page => page.waitForFunction(() => { const d = window.NSO_MICROSCOPE.getDoc(); return !!d && d.kind === 'mesh'; }, null, { timeout: 30000 });

withApp(async (page, logs) => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadSTL(page, BOX);
  await page.waitForTimeout(300);
  /* Where the main page's corner sits, measured before G-scope covers it: the
     page has no header, so its viewport, Import slab and pinned panel start at
     the window's top edge - the spot G-scope's own panel, IMPORT and corner
     row use - and switching between the two must not jump. */
  const mainPage = await page.evaluate(() => {
    const R = el => el.getBoundingClientRect();
    const imp = R(document.querySelector('#menu-import > summary')), pan = R(document.getElementById('plate-panel'));
    return { vpTop: R(document.getElementById('viewport')).top, impTop: imp.top, impLeft: imp.left, impH: imp.height, impW: imp.width,
             panelTop: pan.top, panelGap: innerWidth - pan.right, plate: state.plate };
  });
  await page.click('#btn-microscope');
  await waitMesh(page);
  await page.evaluate(PAGE_HELPERS);
  await frames(page);
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  /* The card alone, for the PR: the pointer parked on bare canvas first (a hover lights a button). */
  const shotCard = async name => {
    const e = await page.evaluate(() => window.__s.emptyPx());
    if (e) await page.mouse.move(e[0], e[1]);
    await page.waitForTimeout(80);
    const c = await page.evaluate(() => { const b = document.getElementById('ms-main-card').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    await page.screenshot({ path: path.join(SHOTS, name + '.png'),
      clip: { x: Math.max(0, c.x - 7), y: Math.max(0, c.y - 7), width: c.w + 14, height: c.h + 14 } });
  };

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the ids ===');
  {
    const r = await page.evaluate(([before, head, rows, corner, dock, slider, exportIds]) => {
      const count = id => document.querySelectorAll('[id="' + id.replace(/"/g, '') + '"]').length;
      const $ = id => document.getElementById(id);
      const ours = Array.from(document.querySelectorAll('#microscope [id]')).map(e => e.id);
      const dup = ours.filter((id, i) => ours.indexOf(id) !== i);
      const rowIds = [].concat(...rows.map(r => [r[0]].concat(r[2])));
      const listed = [].concat(before, head, rowIds, corner.map(c => c[0]), dock, slider, exportIds,
                               ['ms-main-card', 'ms-import-menu', 'ms-btn-plate', 'ms-card-export', 'ms-dock', 'ms-dock-left', 'ms-readouts', 'ms-corner']);
      const card = $('ms-main-card'), menu = $('ms-import-menu'), plateBtn = $('ms-btn-plate');
      return {
        missing: before.filter(id => count(id) !== 1), listedBad: listed.filter(id => count(id) !== 1), dup,
        details: document.querySelectorAll('#microscope details, #microscope summary').length,
        column: document.querySelectorAll('#ms-sidebar, .ms-sidebar, .ms-col, #microscope .ms-nav:not(#ms-nav-export)').length,
        card: card && { inVp: !!card.closest('#ms-viewport'), cls: card.className, msCard: card.classList.contains('ms-card'), isOpen: card.classList.contains('is-open'),
                        side: card.dataset.side, cards: document.querySelectorAll('.ms-main-card').length },
        headIn: head.filter(id => !card.querySelector('.ms-main-head').contains($(id))),
        switchKids: Array.from($('ms-camera-row').children).map(e => e.id || e.className),
        switchCls: $('ms-camera-row').className,
        menu: menu && { cls: menu.className, nav: menu.getAttribute('data-nav'), role: menu.getAttribute('role'), inVp: !!menu.closest('#ms-viewport'),
                        inCard: card.contains(menu), plateIn: menu.contains(plateBtn), plateRole: plateBtn.getAttribute('role'),
                        moreAria: [$('ms-btn-import-more').getAttribute('aria-haspopup'), $('ms-btn-import-more').getAttribute('aria-controls')] },
        rows: rows.map(([id, on, kids]) => { const row = $(id); return [id, !!row && card.querySelector('.ms-main-rows').contains(row) && row.classList.contains('ms-row'),
                                                                        row && row.getAttribute('data-on') === on, kids.filter(k => !row.contains($(k)))]; }),
        rowCount: card.querySelectorAll('.ms-row').length,
        showAll: (b => ({ inHead: !!b.closest('.ms-legend-head'), nextToToggle: b.parentElement === $('ms-legend-toggle').parentElement, inLegend: !!b.closest('#ms-legend-float') }))($('ms-btn-show-all')),
        labels: {
          open: $('ms-btn-open').textContent, more: $('ms-btn-import-more').textContent, normal: $('ms-cam-normal').textContent, slice: $('ms-cam-slice').textContent,
          region: $('ms-mode-select').textContent, isolate: $('ms-btn-isolate').textContent, clear: $('ms-btn-clear').textContent, whole: $('ms-btn-back').textContent,
          band: $('ms-btn-take-band').textContent, toolpath: $('ms-render-toolpath').textContent, solid: $('ms-render-solid').textContent,
          settings: $('ms-slice-settings-toggle').textContent, plate: $('ms-btn-plate').textContent, showAll: $('ms-btn-show-all').textContent },
        cornerKids: Array.from($('ms-corner').children).map(e => e.id), cornerText: Array.from($('ms-corner').children).map(e => e.textContent),
        cornerIn: !!$('ms-corner').closest('#ms-viewport'),
        exportIn: exportIds.filter(id => !$('ms-card-export').contains($(id))), exportCls: $('ms-card-export').className, exportNav: $('ms-card-export').getAttribute('data-nav'),
        dockOut: dock.filter(id => !$('ms-dock').contains($(id))), dockInCard: dock.filter(id => $(id).closest('.ms-card, .ms-main-card')),
        input: (i => i && { type: i.type, accept: i.accept })($('ms-input'))
      };
    }, [BEFORE, HEAD, ROWS, CORNER, DOCK, SLIDER, EXPORT_IDS]);
    check('the card #ms-main-card is on the page once, inside the viewport, a .ms-main-card and NOT a .ms-card (it never opens or shuts)',
      r.card && r.card.inVp && r.card.cards === 1 && /\bms-main-card\b/.test(r.card.cls) && !r.card.msCard && !r.card.isOpen, J(r.card));
    check('its head holds IMPORT, its ▾ and the switch (Normal, the track, Slice)',
      r.headIn.length === 0 && J(r.switchKids) === J(['ms-cam-normal', 'ms-switch-track', 'ms-cam-slice']) && /\bms-switch\b/.test(r.switchCls),
      r.headIn.join(',') || J(r.switchKids));
    check('the ▾ menu #ms-import-menu is a "ms-card ms-menu" of the viewport, role=menu, opened by #ms-btn-import-more (aria-haspopup / aria-controls), holding Read plate (role=menuitem)',
      r.menu && /\bms-card\b/.test(r.menu.cls) && /\bms-menu\b/.test(r.menu.cls) && r.menu.nav === 'ms-btn-import-more' && r.menu.role === 'menu' && r.menu.inVp &&
      !r.menu.inCard && r.menu.plateIn && r.menu.plateRole === 'menuitem' && r.menu.moreAria[0] === 'menu' && r.menu.moreAria[1] === 'ms-import-menu', J(r.menu));
    r.rows.forEach(([id, inRows, on, out]) => check('row #' + id + ': a .ms-row of the card, data-on "' + ROWS.find(x => x[0] === id)[1] + '", holding its controls',
      inRows && on && out.length === 0, out.length ? 'not in it: ' + out.join(',') : ''));
    check('the card has exactly those seven rows', r.rowCount === ROWS.length, String(r.rowCount));
    check('every id the card, the corner, the dock, the slider and Export list appears exactly once, none twice inside #microscope',
      r.listedBad.length === 0 && r.dup.length === 0, (r.listedBad.concat(r.dup)).join(', ') || 'no duplicates');
    check('every other id the sidebar page had (less rounds 1b and 2c) is still there exactly once', r.missing.length === 0, r.missing.join(', ') || BEFORE.length + ' ids');
    const gone = await page.evaluate(ids => ids.filter(id => document.getElementById(id)), GONE);
    check('the column, SELECT and VIEW cards, the five-mode row, Line / Layer rows, Clear from view and Select shown are gone, with round 1b\'s ids',
      gone.length === 0, gone.join(', ') || GONE.length + ' ids gone');
    check('no column: no #ms-sidebar, .ms-sidebar, .ms-col, and no nav slab but EXPORT', r.column === 0, String(r.column));
    check('no <details> or <summary> in #microscope', r.details === 0, String(r.details));
    const L = r.labels;
    const want = { open: 'IMPORT', more: '▾', normal: 'NORMAL', slice: 'SLICE', region: 'REGION', isolate: 'ISOLATE', clear: 'CLEAR BOXES', whole: 'WHOLE PART',
                   band: 'TAKE BAND', toolpath: 'TOOLPATH', solid: 'SOLID', settings: 'SLICE SETTINGS', plate: 'READ PLATE', showAll: 'CHECK ALL' };
    const wrong = Object.keys(want).filter(k => norm(L[k]) !== want[k]);
    check('the labels: IMPORT ▾ · Normal ○━━● Slice (not "Slice view") · Region, Isolate, Clear boxes · Whole part · Take band · Toolpath | Solid · Slice settings · Read plate · Check all',
      wrong.length === 0, wrong.map(k => k + '=' + J(L[k])).join(', ') || 'all');
    check('Check all is in the Features list\'s head, beside its minimize toggle', r.showAll.inHead && r.showAll.nextToToggle && r.showAll.inLegend, J(r.showAll));
    check('the corner holds Back, the framing, Clear, Export, Close, in the viewport, labelled BACK, ◎, CLEAR, EXPORT, CLOSE',
      J(r.cornerKids) === J(CORNER.map(c => c[0])) && r.cornerIn && J(r.cornerText.map(norm)) === J(CORNER.map(c => c[1])), r.cornerText.map(norm).join(' | '));
    check('Export is a .ms-card opened from the corner\'s EXPORT, holding its six', r.exportIn.length === 0 && /\bms-card\b/.test(r.exportCls) && r.exportNav === 'ms-nav-export', r.exportIn.join(','));
    check('the dock holds the file line, the Features list (Check all in it), the info, the Slice report and the hint - none of it in a card',
      r.dockOut.length === 0 && r.dockInCard.length === 0, r.dockOut.concat(r.dockInCard).join(', ') || DOCK.length + ' ids');
    check('IMPORT\'s file picker is #ms-input (STL, 3MF)', r.input && r.input.type === 'file' && /\.stl/.test(r.input.accept) && /\.3mf/.test(r.input.accept), J(r.input));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. on open: the card, top-left, the Normal side ===');
  {
    const st = await cardState(page);
    const g = await page.evaluate(() => {
      const R = e => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const $ = id => document.getElementById(id);
      return { vp: R($('ms-viewport')), panel: R($('microscope')), card: R($('ms-main-card')), imp: R($('ms-btn-open')), more: R($('ms-btn-import-more')),
               group: R(document.querySelector('.ms-import')), sw: R($('ms-camera-row')), head: R(document.querySelector('.ms-main-head')),
               impFont: getComputedStyle($('ms-btn-open')).fontSize, mainFont: getComputedStyle(document.querySelector('#menu-import > summary')).fontSize,
               corner: ['ms-btn-back-producer', 'ms-nav-export', 'ms-close'].map(id => $(id).hidden ? null : R($(id))),
               legend: R($('ms-legend-float')), fileBox: R(document.querySelector('#ms-dock-left .ms-head')), info: R($('ms-info')),
               boxes: ['ms-info-title', 'ms-slice-readout'].map(id => $(id).closest('.ms-glass')).filter(e => getComputedStyle(e).display !== 'none').map(R),
               zr: $('ms-zr').hidden ? null : R($('ms-zr')), W: innerWidth, H: innerHeight,
               values: ['ms-slice-nozzle', 'ms-slice-layer'].map(id => $(id).value), prof: window.NSO_GSCOPE_SLICE.profileDefaults(),
               legendNote: (document.querySelector('#ms-legend .ms-legend-note') || {}).textContent || '',
               legendRows: document.querySelectorAll('#ms-legend .ms-legend-item').length, showAllOff: $('ms-btn-show-all').disabled,
               sliceRead: $('ms-slice-read').textContent, sliceReadOut: getComputedStyle($('ms-slice-readout')).display, info1: $('ms-info').textContent };
    });
    check('the card is up, top-left: within 8 px of the viewport\'s top-left corner',
      st.up && g.card.x - g.vp.x >= 0 && g.card.x - g.vp.x <= 8 && g.card.y - g.vp.y >= 0 && g.card.y - g.vp.y <= 8, J([g.card.x - g.vp.x, g.card.y - g.vp.y]));
    check('on the plate read (a mesh) it is on the Normal side: data-side, cardSide() and NSO_GSCOPE_SLICE.viewMode() all say normal',
      st.side === 'normal' && st.cardSide === 'normal' && st.viewMode === 'normal', J([st.side, st.cardSide, st.viewMode]));
    check('exactly 2 rows show: REGION and WHOLE PART', J(st.rows) === J(NORMAL_ROWS), J(st.rows));
    check('the switch: Normal active (aria-pressed), Slice not, and Slice enabled (a mesh can be sliced)',
      st.normal.active && st.normal.pressed === 'true' && !st.slice.active && st.slice.pressed === 'false' && !st.slice.disabled, J([st.normal, st.slice]));
    check('Whole part is disabled (nothing isolated); Region is enabled and not armed (mode piece, its note hidden)',
      st.whole.disabled && !st.region.disabled && !st.region.active && st.region.pressed === 'false' && st.mode === 'piece' && !st.regionNote, J([st.whole, st.region, st.mode, st.regionNote]));
    check('Isolate and Clear boxes are disabled (nothing selected, no box)', st.isolate.disabled && st.clearBoxes.disabled, J([st.isolate.disabled, st.clearBoxes.disabled]));
    check('IMPORT stands at the main page\'s Import spot: left, top and height within 1 px (no jump)',
      Math.abs(g.imp.x - mainPage.impLeft) <= 1 && Math.abs(g.imp.y - mainPage.impTop) <= 1 && Math.abs(g.imp.h - mainPage.impH) <= 1,
      J({ gscope: [g.imp.x, g.imp.y, g.imp.h], main: [mainPage.impLeft, mainPage.impTop, mainPage.impH] }));
    check('IMPORT and its ▾ together are the main Import\'s width (--shell-col-w, 118 px), side by side, one height',
      Math.abs(g.group.w - mainPage.impW) <= 1 && Math.abs(g.group.w - 118) <= 1 && Math.abs(g.more.x - g.imp.r) <= 1.5 && Math.abs(g.more.h - g.imp.h) <= 0.5,
      J({ group: g.group.w, main: mainPage.impW, imp: [g.imp.x, g.imp.r], more: [g.more.x, g.more.r] }));
    check('...in the main Import\'s face size', g.impFont === g.mainFont, g.impFont + ' vs ' + g.mainFont);
    const cutN = await cutOff(page, ['ms-btn-open', 'ms-btn-import-more', 'ms-cam-normal', 'ms-cam-slice', 'ms-mode-select', 'ms-btn-isolate', 'ms-btn-clear', 'ms-btn-back']);
    check('...none of the Normal side\'s buttons has its label cut', cutN.length === 0, cutN.join(', ') || 'whole');
    check('the switch is in the head, right of IMPORT ▾, centred in the rest of it',
      g.sw.x >= g.group.r && g.sw.r <= g.head.r && Math.abs((g.sw.x + g.sw.r) / 2 - (g.group.r + g.head.r) / 2) <= 6, J({ sw: [g.sw.x, g.sw.r], group: g.group.r, head: g.head.r }));
    check('the viewport takes the whole panel (no sidebar)', Math.abs(g.vp.x - g.panel.x) < 1 && Math.abs(g.vp.w - g.panel.w) < 1 && Math.abs(g.vp.h - g.panel.h) < 1, J([g.vp.x, g.vp.w, g.panel.w]));
    check('the corner row is pinned top-right: Export and Close at the right edge, a pitch from the top',
      g.corner[2] && g.corner[1] && Math.abs(g.W - g.corner[2].r - 8) < 1.5 && g.corner[2].y <= 12 && g.corner[1].r <= g.corner[2].x + 0.5, J(g.corner));
    check('Back is hidden until a document hands one over', g.corner[0] === null);
    check('switching to G-scope does not jump: its panel and corner row sit where the main page\'s viewport and pinned panel do',
      mainPage.vpTop === 0 && Math.abs(g.panel.y - mainPage.vpTop) < 0.5 &&
      g.corner[2] && Math.abs(g.corner[2].y - mainPage.panelTop) < 0.5 && Math.abs((g.W - g.corner[2].r) - mainPage.panelGap) < 0.5,
      J({ main: mainPage, gscope: { panelY: g.panel.y, closeY: g.corner[2] && g.corner[2].y, closeGap: g.corner[2] && g.W - g.corner[2].r } }));
    check('the legend is on the left wall, under the card, in the lower half of the window',
      g.legend.x <= g.card.x + 3 && g.legend.y >= g.card.b && g.legend.b > g.H / 2 && g.legend.b <= g.H, J([g.legend.x, g.legend.y, g.legend.b, g.card.b]));
    check('the G-scope file line is directly above the legend, on the same wall, under the card',
      Math.abs(g.fileBox.x - g.legend.x) < 2 && g.fileBox.b <= g.legend.y && g.legend.y - g.fileBox.b < 16 && g.fileBox.y >= g.card.b, J([g.fileBox.x, g.fileBox.y, g.fileBox.b, g.legend.y]));
    check('the info box is along the bottom, to the right of the legend, bottom edges level',
      g.info.x >= g.legend.r && g.info.b > g.H - 40 && g.info.b <= g.H, J([g.info.x, g.info.b]));
    const row = g.boxes;
    check('the bottom boxes sit side by side on one line, clear of the slider',
      row.length >= 2 && row.every(b => Math.abs(b.b - row[0].b) < 2) && row.every((b, i) => i === 0 || b.x >= row[i - 1].r) && row[row.length - 1].r <= (g.zr ? g.zr.x : g.W),
      J(row.map(b => [Math.round(b.x), Math.round(b.r), Math.round(b.b)])));
    check('the bottom row is short: its tallest box is under a quarter of the window', row.every(b => b.h < g.H / 4), row.map(b => Math.round(b.h)).join(','));
    check('the layer-range slider (when up) is clear of the corner row', !g.zr || g.zr.y >= g.corner[1].b, J(g.zr));
    check('the Features list says a plate piece is not sliced (no rows: line types are a slice\'s); Check all is disabled',
      g.legendRows === 0 && /Not sliced/.test(g.legendNote) && g.showAllOff, J([g.legendRows, g.legendNote, g.showAllOff]));
    check('the Slice report is up in the dock and names the switch', g.sliceReadOut !== 'none' && /Slice \(the switch\)/.test(g.sliceRead), g.sliceRead.slice(0, 80));
    check('the Slice settings were seeded from the printer profile at the start of the visit',
      g.values[0] === String(g.prof.nozzle) && g.values[1] === String(g.prof.layer), J([g.values, g.prof]));
    const o = await opens(page);
    check('neither the ▾ menu nor Export is open to begin with', !o.menu.open && !o.menu.vis && o.menu.aria === 'false' && !o.exp.open && !o.exp.vis, J(o));
    await shotCard('card-normal');
    await shot('01-open-normal');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. IMPORT ▾: Read plate, and IMPORT, into the ACTIVE plate ===');
  {
    let r = await clickFace(page, '#ms-btn-import-more');
    let o = await opens(page);
    check('a real click on ▾ opens the menu: .is-open, shown, aria-expanded true, ▾ lit', r && r.ok && o.menu.open && o.menu.vis && o.menu.aria === 'true' && o.menu.on, J([r, o.menu]));
    const m = await page.evaluate(() => {
      const b = document.getElementById('ms-import-menu').getBoundingClientRect(), h = document.querySelector('.ms-main-head').getBoundingClientRect();
      return { x: b.left, y: b.top, r: b.right, b: b.bottom, headB: h.bottom, W: innerWidth, H: innerHeight };
    });
    check('...under the card\'s head, inside the window', m.y >= m.headB - 0.5 && m.r <= m.W && m.b <= m.H && m.x >= 0, J(m));
    const rp = await reach(page, ['ms-btn-plate']);
    check('...and Read plate in it can be hit with a real click', rp.hit.length === 1, J(rp));
    await shot('02-import-menu');
    // a press outside the menu (the file line, in the dock) shuts it
    const out = await page.evaluate(() => { const b = document.getElementById('ms-sub').getBoundingClientRect(); return [b.left + 20, b.top + b.height / 2]; });
    await page.mouse.click(out[0], out[1]);
    await page.waitForTimeout(80);
    o = await opens(page);
    check('a press outside the menu shuts it (▾ unlit, aria-expanded false)', !o.menu.open && !o.menu.vis && o.menu.aria === 'false' && !o.menu.on && !o.panelHidden, J(o.menu));
    // its own button again shuts it
    await clickFace(page, '#ms-btn-import-more');
    await clickFace(page, '#ms-btn-import-more');
    o = await opens(page);
    check('▾ again shuts it', !o.menu.open && o.menu.aria === 'false', J(o.menu));
    // Escape shuts it, and only it
    await clickFace(page, '#ms-btn-import-more');
    await escape(page);
    o = await opens(page);
    check('Escape shuts the menu and leaves G-scope up', !o.menu.open && !o.menu.vis && !o.panelHidden && o.isOpen, J(o));
    // one at a time: Export swaps it out, ▾ swaps Export out
    await clickFace(page, '#ms-btn-import-more');
    await clickFace(page, '#ms-nav-export');
    o = await opens(page);
    const sw1 = !o.menu.open && o.exp.open;
    await clickFace(page, '#ms-btn-import-more');
    o = await opens(page);
    check('one at a time: Export shuts the ▾ menu, the ▾ shuts Export', sw1 && o.menu.open && !o.exp.open, J(o));
    await escape(page);

    // Read plate onto PLATE 2, the active plate
    const lensSig = await page.evaluate(() => window.__s.plateSig('lens'));
    await page.evaluate(() => NSO_MICROSCOPE.activatePlate('take'));
    await frames(page);
    const t0 = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), take: NSO_MICROSCOPE.plateDoc('take') }));
    await clickFace(page, '#ms-btn-import-more');
    r = await clickFace(page, '#ms-btn-plate');
    await page.waitForFunction(() => NSO_MICROSCOPE.plateDoc('take') && NSO_MICROSCOPE.plateDoc('take').source === 'plate', null, { timeout: 30000 }).catch(() => {});
    await frames(page);
    const t1 = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), take: (d => d && { kind: d.kind, source: d.source, n: d.objects && d.objects.length })(NSO_MICROSCOPE.plateDoc('take')),
                                              placed: state.placed ? state.placed.length : null, lens: window.__s.plateSig('lens') }));
    o = await opens(page);
    check('IMPORT ▾ -> Read plate (real clicks), plate 2 active and empty: plate 2 now holds the plate read',
      r && r.ok && t0.plate === 'take' && t0.take === null && t1.plate === 'take' && t1.take && t1.take.kind === 'mesh' && t1.take.source === 'plate' && t1.take.n >= 1,
      J([r && r.why, t0.plate, !!t0.take, t1]));
    check('...plate 1 is untouched', t1.lens === lensSig, t1.lens === lensSig ? '' : t1.lens + ' vs ' + lensSig);
    check('...and the choice shut the menu', !o.menu.open && !o.menu.vis && o.menu.aria === 'false', J(o.menu));
    let st = await cardState(page);
    check('...plate 2 holds a mesh: the card is on the Normal side, 2 rows', st.side === 'normal' && J(st.rows) === J(NORMAL_ROWS), J([st.side, st.rows]));

    // IMPORT: shuts the menu, opens the file picker, and the file lands on the ACTIVE plate (still plate 2)
    await clickFace(page, '#ms-btn-import-more');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null), clickFace(page, '#ms-btn-open')]);
    o = await opens(page);
    const pickerId = chooser ? await chooser.element().evaluate(e => e.id) : null;
    check('IMPORT (a real click) opens the file picker #ms-input, and shuts the ▾ menu', pickerId === 'ms-input' && !o.menu.open && o.menu.aria === 'false', J([pickerId, o.menu]));
    if (chooser) await chooser.setFiles(SLICED);
    await page.waitForFunction(() => NSO_MICROSCOPE.plateDoc('take') && NSO_MICROSCOPE.plateDoc('take').kind === 'toolpath', null, { timeout: 60000 }).catch(() => {});
    await frames(page);
    const t2 = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), take: (d => d && { kind: d.kind, name: d.name, sliced: !!d.nsoSlice })(NSO_MICROSCOPE.plateDoc('take')),
                                              lens: window.__s.plateSig('lens'), imported: NSO_MICROSCOPE.imported() }));
    check('...the chosen .gcode.3mf lands on the ACTIVE plate (plate 2); plate 1 is untouched',
      t2.plate === 'take' && t2.take && t2.take.kind === 'toolpath' && !t2.take.sliced && t2.lens === lensSig && !!t2.imported, J(t2));
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the switch: the view, and the row set ===');
  {
    // an imported slice: the Slice side, and Normal off (no mesh to go back to)
    let st = await cardState(page);
    const imp = await page.evaluate(() => ({ readout: getComputedStyle(document.getElementById('ms-slice-readout')).display,
                                             note: document.getElementById('ms-slice-settings-note').textContent }));
    check('an imported .gcode.3mf (plate 2) is the Slice side: data-side, cardSide() and viewMode() say slice',
      st.side === 'slice' && st.cardSide === 'slice' && st.viewMode === 'slice', J([st.side, st.cardSide, st.viewMode]));
    check('...6 rows: REGION, TAKE BAND, Toolpath | Solid, Slice settings, Measure, Play', J(st.rows) === J(SLICE_ROWS), J(st.rows));
    check('...the switch: Slice active, Normal DISABLED (a sliced file has no mesh), Slice enabled',
      st.slice.active && st.slice.pressed === 'true' && !st.slice.disabled && !st.normal.active && st.normal.disabled, J([st.normal, st.slice]));
    check('...the Slice report is hidden; the settings say this file is sliced already', imp.readout === 'none' && /sliced already/.test(imp.note), J(imp));
    const before = await page.evaluate(() => window.__s.plateSig('take'));
    await clickFace(page, '#ms-cam-slice');
    await clickFace(page, '.ms-switch-track');
    await page.waitForTimeout(150);
    st = await cardState(page);
    check('...a click on Slice, or on the track, changes nothing there', st.side === 'slice' && await page.evaluate(() => window.__s.plateSig('take')) === before, st.side);
    await shot('03-imported-slice');

    // plate 1's mesh: Slice slices and flips the side
    await page.evaluate(() => NSO_MICROSCOPE.activatePlate('lens'));
    await frames(page);
    st = await cardState(page);
    check('plate 1 active again: its mesh, the Normal side, 2 rows', st.plate === 'lens' && st.side === 'normal' && J(st.rows) === J(NORMAL_ROWS), J([st.plate, st.side, st.rows]));
    // every word the switch and the report show from the click on: a slice can be over before a read 70 ms after the click would see it
    await page.evaluate(() => {
      const el = document.getElementById('ms-slice-read'), sw = document.getElementById('ms-camera-row'), b = document.getElementById('ms-cam-slice');
      window.__sliceSeen = { texts: [], labels: [], busyCls: false, aria: false };
      window.__sliceObs = new MutationObserver(() => {
        const s = window.__sliceSeen;
        s.texts.push(el.textContent); s.labels.push(b.textContent.trim());
        if (sw.classList.contains('is-busy')) s.busyCls = true;
        if (b.getAttribute('aria-busy') === 'true') s.aria = true;
      });
      window.__sliceObs.observe(el, { childList: true, characterData: true, subtree: true });
      window.__sliceObs.observe(sw, { attributes: true, subtree: true, childList: true, characterData: true });
    });
    const r = await clickFace(page, '#ms-cam-slice');
    await waitSlice(page);
    await frames(page);
    const seen = await page.evaluate(() => { window.__sliceObs.disconnect(); return window.__sliceSeen; });
    check('a real click on Slice slices the mesh: a toolpath made here', r && r.ok, J(r));
    check('...while it runs the Slice report says "Slicing N object(s)..."', seen.texts.some(t => /^Slicing \d+ object\(s\)\.\.\./.test(t)), seen.texts.slice(0, 3).join(' | ').slice(0, 120));
    check('...and the switch shows busy (aria-busy on Slice, .is-busy on the switch), its label still "Slice", never "Slicing..."',
      seen.aria && seen.busyCls && seen.labels.every(l => l === 'Slice'), J({ aria: seen.aria, busyCls: seen.busyCls, labels: Array.from(new Set(seen.labels)) }));
    st = await cardState(page);
    check('the Slice side: data-side, cardSide() and viewMode() say slice', st.side === 'slice' && st.cardSide === 'slice' && st.viewMode === 'slice', J([st.side, st.cardSide, st.viewMode]));
    check('...exactly 6 rows: REGION, TAKE BAND, Toolpath | Solid, Slice settings, Measure, Play', J(st.rows) === J(SLICE_ROWS), J(st.rows));
    check('...Slice active, Normal enabled (it goes back to the mesh) and not busy',
      st.slice.active && st.slice.pressed === 'true' && !st.normal.active && st.normal.pressed === 'false' && !st.normal.disabled && !st.busy && st.slice.text === 'Slice', J([st.normal, st.slice, st.busy]));
    check('...Whole part is not shown on the Slice side (Escape is its job there); Take band is enabled',
      !st.rows.includes('ms-whole-row') && !st.band.disabled, J([st.rows, st.band]));
    const rep = await page.evaluate(() => ({ text: document.getElementById('ms-slice-read').textContent, shown: getComputedStyle(document.getElementById('ms-slice-readout')).display }));
    check('the slice report is in the dock', rep.shown !== 'none' && rep.text.length > 20 && /layer|wall|infill|slice/i.test(rep.text), rep.text.slice(0, 90));
    const reach4 = await reach(page, ['ms-mode-select', 'ms-btn-take-band', 'ms-render-toolpath', 'ms-render-solid', 'ms-slice-settings-toggle', 'ms-cam-normal']);
    check('...and every control the Slice side shows (settings folded) can be hit with a real click', reach4.blocked.length === 0 && reach4.hit.length === 6, J(reach4));
    const cutS = await cutOff(page, ['ms-btn-take-band', 'ms-render-toolpath', 'ms-render-solid', 'ms-slice-settings-toggle']);
    check('...none of the Slice side\'s buttons has its label cut', cutS.length === 0, cutS.join(', ') || 'whole');
    const docBefore = await page.evaluate(() => window.__s.plateSig('lens'));
    await clickFace(page, '#ms-cam-slice');
    await page.waitForTimeout(150);
    check('on a toolpath a click on Slice changes nothing', await page.evaluate(() => window.__s.plateSig('lens')) === docBefore && (await cardState(page)).side === 'slice');
    await shotCard('card-slice');
    await shot('04-slice-side');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. Slice settings: folded, the printer profile, the next slice ===');
  {
    let f = await page.evaluate(() => ({ hidden: document.getElementById('ms-slice-settings').hidden, aria: document.getElementById('ms-slice-settings-toggle').getAttribute('aria-expanded') }));
    check('on the Slice side the settings are folded: #ms-slice-settings hidden, the toggle aria-expanded false', f.hidden && f.aria === 'false', J(f));
    const r = await clickFace(page, '#ms-slice-settings-toggle');
    await frames(page);
    f = await page.evaluate(() => ({ hidden: document.getElementById('ms-slice-settings').hidden, aria: document.getElementById('ms-slice-settings-toggle').getAttribute('aria-expanded') }));
    check('a real click on "Slice settings" unfolds them', r && r.ok && !f.hidden && f.aria === 'true', J([r, f]));
    const v = await page.evaluate(ids => ({ vals: ids.map(id => document.getElementById(id).value), prof: window.NSO_GSCOPE_SLICE.profileDefaults(), plate: state.plate,
      nozzles: Array.from(document.getElementById('ms-slice-nozzle').options).map(o => o.value) }), SETTINGS);
    check('the values are NSO_GSCOPE_SLICE.profileDefaults(): nozzle and layer, with walls 2, infill 15 % grid, support below 30',
      v.vals[0] === String(v.prof.nozzle) && v.vals[1] === String(v.prof.layer) && J(v.vals.slice(2)) === J(['2', '15', 'grid', '30']), J(v));
    check('...and for the app\'s printer, the A1 mini, that is a 0.4 nozzle and 0.2 layers (not 0.6 / 0.3)',
      v.plate === 'a1mini' && mainPage.plate === 'a1mini' && v.prof.printer === 'a1mini' && v.prof.nozzle === 0.4 && v.prof.layer === 0.2 && v.vals[0] === '0.4' && v.vals[1] === '0.2',
      J({ plate: v.plate, prof: v.prof, vals: v.vals.slice(0, 2) }));
    check('the nozzle offers 0.4 and 0.6', J(v.nozzles) === J(['0.4', '0.6']), J(v.nozzles));
    const rr = await reach(page, SETTINGS);
    check('every field is hit-testable unfolded', rr.blocked.length === 0 && rr.hit.length === SETTINGS.length, J(rr));
    const cutF = await cutOff(page, SETTINGS);
    check('...and shows its whole value (none cut by its width)', cutF.length === 0, cutF.join(', ') || 'whole');
    const pitch = await page.evaluate(() => window.__s.layerPitch());
    check('the slice was made with them: its layers are 0.2 mm apart', pitch !== null && Math.abs(pitch - 0.2) < 0.005, String(pitch));
    await shotCard('card-slice-settings');
    await shot('05-slice-settings');
    // the layout gate, Slice side, unfolded, at 1280 x 800 (and folded below, and at 1024 x 720 in 8)
    layoutChecks(await layout(page), '1280 x 800, Slice side, settings unfolded');
    // MEASURE: shut until opened, and nothing is computed or shown while it is
    let m = await page.evaluate(() => ({ hidden: document.getElementById('ms-measure').hidden, aria: document.getElementById('ms-measure-toggle').getAttribute('aria-expanded'),
      head: document.getElementById('ms-measure-head').textContent, feats: document.getElementById('ms-measure-feats').textContent }));
    check('MEASURE is shut on the Slice side: the panel hidden, the toggle aria-expanded false, nothing computed', m.hidden && m.aria === 'false' && m.head === '\u2014' && m.feats === '', J(m));
    const mr = await clickFace(page, '#ms-measure-toggle');
    await frames(page);
    m = await page.evaluate(() => ({ hidden: document.getElementById('ms-measure').hidden, aria: document.getElementById('ms-measure-toggle').getAttribute('aria-expanded'),
      head: document.getElementById('ms-measure-head').textContent, feats: document.getElementById('ms-measure-feats').textContent,
      layersHidden: document.getElementById('ms-measure-layers').hidden }));
    check('a real click on "Measure" opens it: a line of totals and a row per line type', mr && mr.ok && !m.hidden && m.aria === 'true' && /moves, [\d]+ mm, [\d]+ layers/.test(m.head) && m.feats.split('\n').length >= 1, J([mr, m.head.slice(0, 90), m.feats.split('\n').length]));
    check('...the per-layer table stays folded until Layers is pressed', m.layersHidden, J(m.layersHidden));
    await page.evaluate(() => NSO_MICROSCOPE.setMeasureLayers(true));
    const tab = await page.evaluate(() => document.getElementById('ms-measure-layers').textContent);
    check('...Layers opens a table (or says why there is none)', tab.length > 10, tab.slice(0, 70));
    const rep = await page.evaluate(() => NSO_MICROSCOPE.measureReport());
    check('...and the report is plain text with the same totals', /^G-scope measure/.test(rep) && rep.indexOf('moves,') > 0, rep.slice(0, 60));
    await page.evaluate(() => { NSO_MICROSCOPE.setMeasureLayers(false); NSO_MICROSCOPE.setMeasureOpen(false); });
    await shotCard('card-slice-measure');

    // BACK: one step back along the view's own changes, beside the card
    await page.evaluate(() => { NSO_MICROSCOPE.setMeasureOpen(false); NSO_GSCOPE_SLICE.setSettingsOpen(false); NSO_MICROSCOPE.clearSteps(); });
    await frames(page);
    let bk = await page.evaluate(() => { const b = document.getElementById('ms-btn-step-back'), c = document.getElementById('ms-main-card').getBoundingClientRect(), r = b.getBoundingClientRect();
      return { n: document.querySelectorAll('#ms-btn-step-back').length, disabled: b.disabled, text: b.textContent, left: Math.round(r.left), top: Math.round(r.top), cardRight: Math.round(c.right), cardTop: Math.round(c.top), h: Math.round(r.height) }; });
    check('BACK stands once, grey at the starting point, right of the card\'s head and level with its top', bk.n === 1 && bk.disabled && /Back/.test(bk.text) && bk.left >= bk.cardRight && bk.left - bk.cardRight < 20 && Math.abs(bk.top - bk.cardTop) <= 2, J(bk));
    const rBk = await reach(page, ['ms-btn-step-back']);
    check('...and a click can reach it (nothing over it)', rBk.blocked.length === 0, J(rBk));
    await clickFace(page, '#ms-slice-settings-toggle'); await frames(page);
    await clickFace(page, '#ms-measure-toggle'); await frames(page);
    await page.evaluate(() => NSO_MICROSCOPE.setZRange(0, 5)); await frames(page);
    bk = await page.evaluate(() => ({ disabled: document.getElementById('ms-btn-step-back').disabled, n: NSO_MICROSCOPE.stepCount(), settings: !document.getElementById('ms-slice-settings').hidden, measure: !document.getElementById('ms-measure').hidden, z: NSO_MICROSCOPE.zRange() }));
    check('three changes (Slice settings opened, Measure opened, the slider moved) leave three steps and wake BACK', !bk.disabled && bk.n === 3 && bk.settings && bk.measure, J(bk));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    let b1 = await page.evaluate(() => ({ settings: !document.getElementById('ms-slice-settings').hidden, measure: !document.getElementById('ms-measure').hidden, z: NSO_MICROSCOPE.zRange() }));
    check('a real click on BACK takes the LATEST step back: the slider is full again, the two rows stay open', b1.settings && b1.measure && !(b1.z && b1.z.lo === 0 && b1.z.hi === 5), J(b1));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    b1 = await page.evaluate(() => ({ settings: !document.getElementById('ms-slice-settings').hidden, measure: !document.getElementById('ms-measure').hidden }));
    check('the next press shuts Measure', b1.settings && !b1.measure, J(b1));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    b1 = await page.evaluate(() => ({ settings: !document.getElementById('ms-slice-settings').hidden, measure: !document.getElementById('ms-measure').hidden, disabled: document.getElementById('ms-btn-step-back').disabled, n: NSO_MICROSCOPE.stepCount(), open: !document.getElementById('microscope').hidden }));
    check('the next shuts Slice settings; BACK is grey at the starting point and G-scope is still open', !b1.settings && !b1.measure && b1.disabled && b1.n === 0 && b1.open, J(b1));
    // a step undone another way is skipped, not a dead press
    await clickFace(page, '#ms-measure-toggle'); await frames(page);
    await clickFace(page, '#ms-measure-toggle'); await frames(page);     // shut by its own button
    bk = await page.evaluate(() => { document.getElementById('ms-btn-step-back').click(); return { disabled: document.getElementById('ms-btn-step-back').disabled, measure: !document.getElementById('ms-measure').hidden, n: NSO_MICROSCOPE.stepCount() }; });
    check('a step already undone another way is skipped: the press finds nothing left and BACK goes grey', !bk.measure && bk.disabled && bk.n === 0, J(bk));
    await page.evaluate(() => NSO_MICROSCOPE.setZRange(0, 99999));
    await clickFace(page, '#ms-slice-settings-toggle'); await frames(page);
    await clickFace(page, '#ms-slice-settings-toggle'); await frames(page);
    // the other kinds of step: a line type's check, an isolate
    await page.evaluate(() => { NSO_MICROSCOPE.clearSteps(); });
    const nameF = await page.evaluate(() => { const r = document.querySelector('#ms-legend .ms-legend-item'); return r ? r.dataset.group : null; });
    await page.evaluate(n => NSO_MICROSCOPE.setFeatureDisplay(n, false), nameF); await frames(page);
    let fk = await page.evaluate(n => ({ checked: document.querySelector('#ms-legend .ms-legend-item[data-group="' + n + '"] input').checked, n: NSO_MICROSCOPE.stepCount() }), nameF);
    check('unchecking a line type leaves a step', fk.n === 1 && !fk.checked, J([nameF, fk]));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    fk = await page.evaluate(n => ({ checked: document.querySelector('#ms-legend .ms-legend-item[data-group="' + n + '"] input').checked, n: NSO_MICROSCOPE.stepCount() }), nameF);
    check('...BACK checks it again, and the stack is empty', fk.checked && fk.n === 0, J(fk));
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.selectVisible(); M.isolate(); }); await frames(page);
    let ik = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.stepCount() }));
    check('isolating leaves a step', ik.iso && ik.n >= 1, J(ik));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    ik = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), open: !document.getElementById('microscope').hidden }));
    check('...BACK makes it whole again, and G-scope stays open', !ik.iso && ik.open, J(ik));
    await page.evaluate(() => { NSO_MICROSCOPE.setSelectionMoves([]); NSO_MICROSCOPE.clearSteps(); });

    // PLAY: shut until opened; the slider's top layer, move by move
    let pl = await page.evaluate(() => ({ hidden: document.getElementById('ms-play').hidden, st: NSO_MICROSCOPE.playState(), read: document.getElementById('ms-play-read').textContent }));
    check('PLAY is shut: the panel hidden, nothing drawn', pl.hidden && !pl.st.open && !pl.st.drawn && pl.read === '\u2014', J(pl));
    await clickFace(page, '#ms-play-toggle'); await frames(page);
    pl = await page.evaluate(() => ({ hidden: document.getElementById('ms-play').hidden, st: NSO_MICROSCOPE.playState(), max: +document.getElementById('ms-play-scrub').max,
      val: +document.getElementById('ms-play-scrub').value, read: document.getElementById('ms-play-read').textContent, steps: NSO_MICROSCOPE.stepCount() }));
    check('a real click on "Play" opens it on the slider\'s top layer, the whole layer drawn (scrubber at the end), one step left', !pl.hidden && pl.st.open && pl.st.n > 0 && pl.max === pl.st.n && pl.val === pl.max && pl.st.drawn && pl.steps === 1, J(pl));
    check('...the readout names the layer, its Z and the move', /^Layer \d+, Z \d+\.\d\d - move \d+ of \d+\n/.test(pl.read), pl.read.replace(/\n/g, ' | '));
    await page.evaluate(() => NSO_MICROSCOPE.playSeek(0));
    pl = await page.evaluate(() => ({ st: NSO_MICROSCOPE.playState(), read: document.getElementById('ms-play-read').textContent }));
    check('the scrubber at 0: only the nozzle marker is drawn', pl.st.pos === 0 && pl.st.children === 1 && /At the start/.test(pl.read), J(pl));
    await page.evaluate(() => NSO_MICROSCOPE.playSeek(10));
    pl = await page.evaluate(() => ({ st: NSO_MICROSCOPE.playState(), read: document.getElementById('ms-play-read').textContent }));
    check('at move 10: the path so far and the marker are drawn, the readout gives the move\'s line type, place and G-code line', pl.st.pos === 10 && pl.st.children >= 2 && /move 10 of /.test(pl.read) && /G-code line \d+/.test(pl.read), pl.read.replace(/\n/g, ' | '));
    await page.evaluate(() => NSO_MICROSCOPE.playSeek(Math.round(NSO_MICROSCOPE.playState().n * 0.6))); await frames(page);
    await shot('11-play-mid-layer');
    await page.evaluate(() => { document.getElementById('ms-play-speed').value = '1600'; });
    await clickFace(page, '#ms-play-run'); await frames(page);
    const ran = await page.waitForFunction(() => { const s = NSO_MICROSCOPE.playState(); return !s.running && s.pos === s.n; }, null, { timeout: 8000 }).then(() => true, () => false);
    pl = await page.evaluate(() => ({ st: NSO_MICROSCOPE.playState(), btn: document.getElementById('ms-play-run').textContent }));
    check('Play runs the layer to its end and stops, the button back to Play', ran && pl.btn === 'Play' && pl.st.pos === pl.st.n, J(pl));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    pl = await page.evaluate(() => ({ hidden: document.getElementById('ms-play').hidden, st: NSO_MICROSCOPE.playState() }));
    check('BACK shuts Play: the panel, the path and the marker are gone', pl.hidden && !pl.st.open && !pl.st.drawn, J(pl));
    await page.evaluate(() => NSO_MICROSCOPE.clearSteps());

    // SCRUB: the top handle between layers - the piece printed as the handle goes up
    await page.evaluate(() => { NSO_MICROSCOPE.setZRange(0, 99999); NSO_MICROSCOPE.clearSteps(); });
    const sc0 = await page.evaluate(() => ({ z: NSO_MICROSCOPE.zRange(), st: NSO_MICROSCOPE.scrubState() }));
    check('SCRUB: a whole-layer slider has no part layer (part 1, nothing drawn extra)', sc0.z.part === 1 && sc0.st === null, J(sc0));
    await page.evaluate(() => NSO_MICROSCOPE.setZHead(0.505)); await frames(page);
    let sc = await page.evaluate(() => ({ z: NSO_MICROSCOPE.zRange(), st: NSO_MICROSCOPE.scrubState(), steps: NSO_MICROSCOPE.stepCount(), hi: document.getElementById('ms-zr-hi-read').textContent }));
    check('the top handle half way up the track stands in a layer, part drawn: the layer\'s first moves, a nozzle on them', sc.st && sc.st.part > 0 && sc.st.part < 1 && sc.st.shown > 0 && sc.st.shown < sc.st.moves && sc.st.lines === sc.st.shown && sc.st.head, J(sc));
    check('...the label gives the layer and how far through it, and one BACK step was left', /^Z \d+\.\d\d - \d+%$/.test(sc.hi) && sc.steps === 1, J(sc));
    const first = sc.st;
    await page.evaluate(() => NSO_MICROSCOPE.setZHead(NSO_MICROSCOPE.zRange().hi / (NSO_MICROSCOPE.zRange().steps) + 0.9 / NSO_MICROSCOPE.zRange().steps)); await frames(page);
    sc = await page.evaluate(() => ({ st: NSO_MICROSCOPE.scrubState(), steps: NSO_MICROSCOPE.stepCount() }));
    check('further up the same layer: more of it is drawn, and the drag is still the one BACK step', sc.st && sc.st.layer === first.layer && sc.st.shown > first.shown && sc.st.lines === sc.st.shown && sc.steps === 1, J([first, sc]));
    await page.evaluate(() => NSO_MICROSCOPE.setZHead(1)); await frames(page);
    sc = await page.evaluate(() => ({ z: NSO_MICROSCOPE.zRange(), st: NSO_MICROSCOPE.scrubState() }));
    check('the top of the track is the last layer, whole', sc.st === null && sc.z.hi === sc.z.steps - 1 && sc.z.part === 1, J(sc));
    // isolated: one piece's own moves
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.selectVisible(); M.isolate(); M.setZHead(0.405); }); await frames(page);
    sc = await page.evaluate(() => ({ st: NSO_MICROSCOPE.scrubState(), iso: NSO_MICROSCOPE.isIsolated() }));
    check('isolated, the handle scrubs the isolation\'s own moves through the piece', sc.iso && sc.st && sc.st.shown > 0 && sc.st.shown <= sc.st.moves && sc.st.lines === sc.st.shown, J(sc));
    await shot('12-scrub-isolated');
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    sc = await page.evaluate(() => ({ st: NSO_MICROSCOPE.scrubState(), iso: NSO_MICROSCOPE.isIsolated(), z: NSO_MICROSCOPE.zRange() }));
    check('BACK takes the handle back to where it stood (the whole top layer), still isolated', sc.st === null && sc.z.part === 1 && sc.iso, J(sc));
    await clickFace(page, '#ms-btn-step-back'); await frames(page);
    await page.evaluate(() => { NSO_MICROSCOPE.setSelectionMoves([]); NSO_MICROSCOPE.setZRange(0, 99999); NSO_MICROSCOPE.clearSteps(); });
    // a layer stepped by key or API is whole again
    await page.evaluate(() => NSO_MICROSCOPE.setZHead(0.505)); await frames(page);
    await page.evaluate(() => { const z = NSO_MICROSCOPE.zRange(); NSO_MICROSCOPE.setZRange(z.lo, z.hi); }); await frames(page);
    sc = await page.evaluate(() => ({ z: NSO_MICROSCOPE.zRange(), st: NSO_MICROSCOPE.scrubState() }));
    check('a step by layer (a key, setZRange) makes the top layer whole again', sc.st === null && sc.z.part === 1, J(sc));
    await page.evaluate(() => { NSO_MICROSCOPE.setZRange(0, 99999); NSO_MICROSCOPE.clearSteps(); });
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. every removed control\'s job, at its new home ===');
  {
    // ---- Slice side ----
    // LINE (SELECT > Line): the hover readout. Isolating one move from the UI is dropped (the contract); the API stays.
    const base = await page.evaluate(() => document.getElementById('ms-info').textContent);
    const px = await page.evaluate(() => window.__s.pxTopMove());
    await page.mouse.move(px[0], px[1]);
    const lineOk = await page.waitForFunction(() => /^Move \d+ - /.test(document.getElementById('ms-info').textContent), null, { timeout: 5000 }).then(() => true, () => false);
    const hv = await page.evaluate(() => ({ info: document.getElementById('ms-info').textContent, sel: NSO_MICROSCOPE.selection().length, iso: NSO_MICROSCOPE.isIsolated(), src: NSO_MICROSCOPE.selectionSource() }));
    check('Line -> the hover readout: hovering a move writes "Move N - feature, layer L, Z ... mm" into SELECTION / SEGMENT INFO',
      lineOk && /^Move \d+ - [A-Za-z][A-Za-z ()-]*, layer \d+, Z \d+\.\d{3} mm/.test(hv.info), hv.info.slice(0, 90));
    check('...and picks nothing (nothing selected, nothing isolated)', hv.sel === 0 && !hv.iso, J(hv));
    const empty = await page.evaluate(() => window.__s.emptyPx());
    if (empty) await page.mouse.move(empty[0], empty[1]);
    const backOk = await page.waitForFunction(b => document.getElementById('ms-info').textContent === b, base, { timeout: 5000 }).then(() => true, () => false);
    check('...off the move, the box says what it said before', !!empty && backOk, await page.evaluate(() => document.getElementById('ms-info').textContent.slice(0, 60)));
    check('isolate-one-move from the UI is dropped (no Line row, no "isolate this line"); its APIs pickLine / stepLine / pickLineAt remain',
      await page.evaluate(() => !document.getElementById('ms-btn-isolate-line') && !document.getElementById('ms-line-controls') &&
        ['pickLine', 'stepLine', 'pickLineAt'].every(k => typeof NSO_MICROSCOPE[k] === 'function')));

    // LAYER (SELECT > Layer): the slider + Take band
    const lay = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, n = M.zRange().steps, k = Math.floor(n / 2);
      M.setZRange(k, k); M.flushView();
      const off = M.hidden();
      return { k, n, moves: M.getDoc().segments.filter(s => s.zi === k && off.indexOf(s.feature) < 0).length, shown: M.shownCount(), modeBefore: M.mode() };
    });
    await frames(page);
    let r = await clickFace(page, '#ms-btn-take-band');
    await page.waitForTimeout(150);
    let s = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), src: NSO_MICROSCOPE.selectionSource(), n: NSO_MICROSCOPE.selection().length, mode: NSO_MICROSCOPE.mode(),
      zis: Array.from(new Set(NSO_MICROSCOPE.selection().map(x => x.zi))) }));
    check('Layer -> the slider + Take band: one step of the slider, a real click on Take band isolates that layer (source "range", every move of it)',
      r && r.ok && s.iso && s.src === 'range' && s.n === lay.moves && s.n === lay.shown && s.n > 0 && J(s.zis) === J([lay.k]), J({ lay, s }));
    check('...and Take band leaves the mode as it was (no "layer" mode any more)', s.mode === lay.modeBefore && s.mode === 'piece', s.mode);
    check('...the selectLayer API still takes a layer', await page.evaluate(() => typeof NSO_MICROSCOPE.selectLayer === 'function'));

    // TOOLPATH / SOLID (VIEW > Toolpath / Solid): the Slice side's row - on one layer, so the sweep is small
    r = await clickFace(page, '#ms-render-solid');
    await page.waitForFunction(() => NSO_MICROSCOPE.renderMode() === 'solid' && !!NSO_MICROSCOPE.shownSolid(), null, { timeout: 30000 }).catch(() => {});
    const rs = await page.evaluate(() => ({ mode: NSO_MICROSCOPE.renderMode(), solid: !!NSO_MICROSCOPE.shownSolid(),
      pressed: [document.getElementById('ms-render-toolpath').getAttribute('aria-pressed'), document.getElementById('ms-render-solid').getAttribute('aria-pressed')] }));
    check('Toolpath / Solid -> the Slice side\'s row: a real click on Solid draws the slice as a solid', r && r.ok && rs.mode === 'solid' && rs.solid && J(rs.pressed) === J(['false', 'true']), J([r, rs]));
    await shot('06-solid-layer');
    r = await clickFace(page, '#ms-render-toolpath');
    check('...and Toolpath draws it as lines again', r && r.ok && await page.evaluate(() => NSO_MICROSCOPE.renderMode() === 'toolpath'));

    // WHOLE PART on the Slice side: Escape
    await escape(page);
    check('Whole part on the Slice side -> Escape: whole again, G-scope up', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.isOpen()));
    r = await clickFace(page, '#ms-zr-all');
    await page.evaluate(() => NSO_MICROSCOPE.flushView());
    check('the slider\'s All (a real click) takes it back to every layer', r && r.ok && await page.evaluate(() => NSO_MICROSCOPE.zRange().full));

    // FEATURE (SELECT > Feature): the Features list decides what is taken
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map(it => { const b = it.querySelector('input.ms-legend-display');
      return { name: it.dataset.group, cb: b.id, on: b.checked }; }));
    const keep = (rows.find(x => x.name === 'Outer wall') || rows.find(x => x.name !== 'Travel') || rows[0]).name;
    const missed = [];
    for (const row of rows.filter(x => x.name !== keep && x.on)) {
      const c = await clickFace(page, '#' + row.cb);
      if (!c || !c.ok) missed.push(row.name + ' (' + (c && c.why) + ')');
    }
    await page.evaluate(() => NSO_MICROSCOPE.flushView());
    // hidden() is every line type switched off - a type the slice has no row for (Travel, off by default) may be in it too
    const off = await page.evaluate(() => NSO_MICROSCOPE.hidden().sort());
    const listed = rows.map(x => x.name), offListed = off.filter(n => listed.includes(n));
    check('Feature -> the Features list: every row but "' + keep + '" unchecked by real clicks on its checkbox', missed.length === 0 && J(offListed) === J(listed.filter(n => n !== keep).sort()),
      missed.join(', ') || J({ off, rows: listed }));
    r = await clickFace(page, '#ms-btn-take-band');
    await page.waitForTimeout(150);
    s = await page.evaluate(k => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.selection().length, feats: Array.from(new Set(NSO_MICROSCOPE.selection().map(x => x.feature))),
      want: NSO_MICROSCOPE.getDoc().segments.filter(x => x.feature === k).length }), keep);
    check('...Take band then takes only that line type: every move of "' + keep + '", nothing else', r && r.ok && s.iso && J(s.feats) === J([keep]) && s.n === s.want && s.n > 0, J(s));
    await escape(page);

    // CHECK ALL (VIEW > Check all): the Features list's head
    r = await clickFace(page, '#ms-btn-show-all');
    await page.evaluate(() => NSO_MICROSCOPE.flushView());
    const ca = await page.evaluate(() => ({ off: NSO_MICROSCOPE.hidden(), boxes: Array.from(document.querySelectorAll('#ms-legend input.ms-legend-display')).map(b => b.checked) }));
    check('Check all -> the Features list\'s head: a real click checks every box, Travel too', r && r.ok && ca.off.length === 0 && ca.boxes.length === rows.length && ca.boxes.every(Boolean), J([r, ca]));

    // SELECT SHOWN (VIEW > Select shown): gone - what is shown is what is taken; Take band at All takes it all
    r = await clickFace(page, '#ms-btn-take-band');
    await page.waitForTimeout(150);
    s = await page.evaluate(() => ({ n: NSO_MICROSCOPE.selection().length, shown: NSO_MICROSCOPE.shownCount(), all: NSO_MICROSCOPE.getDoc().segments.length, src: NSO_MICROSCOPE.selectionSource(),
      btn: !!document.getElementById('ms-btn-select-visible'), api: typeof NSO_MICROSCOPE.selectVisible === 'function' }));
    check('Select shown -> gone (no button; the API stays): Take band at All takes everything shown', !s.btn && s.api && s.src === 'range' && s.n === s.shown && s.n === s.all, J(s));

    // EXPORT on a slice with a selection: all six, as it was
    await clickFace(page, '#ms-nav-export');
    let o = await opens(page);
    const ex = (await exportGroups(page)).filter(g => !/^This slice/.test(g.t));      // (the two groups of a slice made on the plate show only for one: app-print.js exportSlice)
    check('Export (a real click on the corner\'s EXPORT) opens its card alone, under the corner row; a slice with a selection: "Selection" four, "Sliced piece" two, no "Whole plate"',
      o.exp.open && o.exp.vis && o.exp.on && o.exp.aria === 'true' && !o.menu.open && ex.length === 3 && ex[0].btns.length === 4 && ex[1].btns.length === 2 && ex[0].shown && ex[1].shown && !ex[2].shown, J([o.exp, ex]));
    const rx = await reach(page, EXPORT_IDS);
    check('...each hit-testable', rx.blocked.length === 0 && rx.hit.length === 6, J(rx));
    await shot('07-export-slice');
    await clickFace(page, '#ms-nav-export');
    o = await opens(page);
    check('...its own button shuts it', !o.exp.open && o.exp.aria === 'false', J(o.exp));
    await escape(page);

    // REGION (SELECT > Region): the REGION row, on the Slice side too
    r = await clickFace(page, '#ms-mode-select');
    let st = await cardState(page);
    check('Region -> the REGION row (Slice side): a real click arms it - mode select, active, aria-pressed, its note shown',
      r && r.ok && st.mode === 'select' && st.region.active && st.region.pressed === 'true' && st.regionNote, J([st.mode, st.region, st.regionNote]));
    const mv = await page.evaluate(() => window.__s.pxTopMove());
    await page.mouse.click(mv[0], mv[1]);
    await page.waitForTimeout(150);
    s = await page.evaluate(() => ({ boxes: NSO_MICROSCOPE.boxes().length, iso: NSO_MICROSCOPE.isIsolated(), src: NSO_MICROSCOPE.selectionSource(), dots: NSO_MICROSCOPE.boxDots() }));
    st = await cardState(page);
    check('...armed, a click on the slice places a box and isolates nothing; Clear boxes is enabled',
      s.boxes === 1 && !s.iso && s.src === 'box' && !st.clearBoxes.disabled && s.dots.length === 1 && ['move', 'resizeH', 'resizeXY'].every(k => Array.isArray(s.dots[0][k])), J([s.boxes, s.iso, s.src, st.clearBoxes]));
    r = await clickFace(page, '#ms-btn-clear');
    st = await cardState(page);
    check('...Clear boxes (a real click) removes it, and is disabled again', r && r.ok && await page.evaluate(() => NSO_MICROSCOPE.boxes().length === 0) && st.clearBoxes.disabled, J(st.clearBoxes));
    r = await clickFace(page, '#ms-mode-select');
    st = await cardState(page);
    check('...a real click again disarms it (mode piece)', r && r.ok && st.mode === 'piece' && !st.region.active && st.region.pressed === 'false' && !st.regionNote, J([st.mode, st.region]));
    // the five-mode row is dropped (the contract): only piece and select are modes; the rest fall back, by the API
    check('the old modes fall back: setMode("feature" | "line" | "layer") is "piece"; the aliases region / orbit still work',
      await page.evaluate(() => { const M = NSO_MICROSCOPE, out = [];
        ['feature', 'line', 'layer', 'region', 'orbit'].forEach(m => { M.setMode(m); out.push(M.mode()); }); M.setMode('piece');
        return JSON.stringify(out); }) === J(['piece', 'piece', 'piece', 'select', 'piece']));

    // SLICE SETTINGS (VIEW > Slice settings): the Slice row - an edit survives the round trip and the next slice takes it
    await page.fill('#ms-slice-layer', '0.25');
    await page.evaluate(() => document.getElementById('ms-slice-layer').dispatchEvent(new Event('change', { bubbles: true })));
    // NORMAL / SLICE (VIEW > Normal / Slice view): the switch - the track back to the mesh
    r = await clickFace(page, '.ms-switch-track');
    await waitMesh(page);
    await frames(page);
    st = await cardState(page);
    check('Normal / Slice -> the switch: a real click on its track goes back to the mesh - the Normal side, 2 rows, Normal active',
      r && r.ok && st.side === 'normal' && st.viewMode === 'normal' && J(st.rows) === J(NORMAL_ROWS) && st.normal.active && !st.slice.active && !st.slice.disabled, J([st.side, st.rows, st.normal, st.slice]));
    const kept = await page.evaluate(() => document.getElementById('ms-slice-layer').value);
    check('...the edited layer (0.25) survives the round trip', kept === '0.25', kept);
    await shot('08-back-to-normal');
  }

  /* ---- Normal side ---- */
  {
    // PIECE (SELECT > Piece): a click in the view
    const px = await page.evaluate(() => window.__s.pxPiece());
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(150);
    let s = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource(), mode: NSO_MICROSCOPE.mode() }));
    let st = await cardState(page);
    check('Piece -> a click in the view: a real click on the piece isolates it (mode piece, source pick); Whole part lights up',
      s.iso && s.n === 1 && s.src === 'pick' && s.mode === 'piece' && !st.whole.disabled, J([s, st.whole]));
    // EXPORT on a mesh selection: "Selection" two, as it was
    await clickFace(page, '#ms-nav-export');
    const ex = await exportGroups(page);
    check('Export, a mesh selection: "Selection" shows its two (plate, STL), enabled; "Sliced piece" is out of the way',
      ex[0].shown && !ex[1].shown && J(ex[0].btns.map(b => b[0])) === J(['ms-btn-export-plate', 'ms-btn-export-stl']) && ex[0].btns.every(b => !b[1]), J(ex));
    const rx = await reach(page, ['ms-btn-export-plate', 'ms-btn-export-stl']);
    check('...and those are hit-testable', rx.blocked.length === 0 && rx.hit.length === 2, J(rx));
    await escape(page);
    check('Escape shuts Export first and leaves the isolate', await page.evaluate(() => NSO_MICROSCOPE.isIsolated() && !document.getElementById('ms-card-export').classList.contains('is-open')));
    // WHOLE PART (SELECT > Whole part): the Normal side's row
    let r = await clickFace(page, '#ms-btn-back');
    st = await cardState(page);
    check('Whole part (a real click) backs out of the isolate, and is disabled again', r && r.ok && await page.evaluate(() => !NSO_MICROSCOPE.isIsolated()) && st.whole.disabled, J([r, st.whole]));

    // REGION on the Normal side: click -> a box, no isolate; Isolate -> the box's contents
    r = await clickFace(page, '#ms-mode-select');
    st = await cardState(page);
    check('Region -> the REGION row (Normal side): armed by a real click', r && r.ok && st.mode === 'select' && st.region.active, J([st.mode, st.region]));
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(150);
    s = await page.evaluate(() => ({ boxes: NSO_MICROSCOPE.boxes().length, iso: NSO_MICROSCOPE.isIsolated(), src: NSO_MICROSCOPE.selectionSource(),
      sel: NSO_MICROSCOPE.selection().map(o => o.name) }));
    st = await cardState(page);
    check('...a click on the piece places a box, isolates nothing; Isolate is enabled', s.boxes === 1 && !s.iso && s.src === 'box' && s.sel.length >= 1 && !st.isolate.disabled, J([s, st.isolate]));
    r = await clickFace(page, '#ms-btn-isolate');
    const s2 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().map(o => o.name), boxes: NSO_MICROSCOPE.boxes().length }));
    st = await cardState(page);
    check('...Isolate (a real click) isolates exactly what the box holds; Isolate is disabled, Whole part enabled',
      r && r.ok && s2.iso && J(s2.sel) === J(s.sel) && s2.boxes === 1 && st.isolate.disabled && !st.whole.disabled, J([s2, st.isolate, st.whole]));

  }

  /* ------------------------------------------------------------------ 6, plate 2 */
  {
    // CLEAR FROM VIEW (VIEW > Clear from view): the corner CLEAR, which empties the ACTIVE plate - plate 2's import here
    const lensBefore = await page.evaluate(() => window.__s.plateSig('lens'));
    const lensState = await page.evaluate(() => { const s = NSO_MICROSCOPE.plateState('lens'); return JSON.stringify([s.isolated, s.boxes.length, s.mode]); });
    await page.evaluate(() => NSO_MICROSCOPE.activatePlate('take'));
    await frames(page);
    const r = await clickFace(page, '#ms-btn-take-clear');
    await page.waitForTimeout(150);
    const c = await page.evaluate(() => ({ take: NSO_MICROSCOPE.plateDoc('take'), plate: NSO_MICROSCOPE.plate(), lens: window.__s.plateSig('lens'), imported: NSO_MICROSCOPE.imported(),
      api: typeof NSO_MICROSCOPE.clearFromView === 'function' }));
    check('Clear from view -> the corner CLEAR (a real click) empties the active plate (plate 2), plate 1 untouched; the clearFromView API stays',
      r && r.ok && c.take === null && c.plate === 'take' && c.lens === lensBefore && c.imported === null && c.api && !(await page.evaluate(() => !!document.getElementById('ms-btn-clear-view'))), J([r, c]));
    // an empty plate: the Normal side; Slice and Region have nothing to act on; Export is off and opens nothing
    const st = await cardState(page);
    check('an empty plate is the Normal side, 2 rows; Slice and Region are disabled (no document)',
      st.side === 'normal' && J(st.rows) === J(NORMAL_ROWS) && st.slice.disabled && st.region.disabled, J([st.side, st.rows, st.slice, st.region]));
    const o0 = await opens(page);
    await page.evaluate(() => document.getElementById('ms-nav-export').click());
    const o1 = await opens(page);
    check('...Export is disabled there, and a press on it opens nothing', o0.exp.disabled && !o1.exp.open && !o1.exp.vis, J([o0.exp, o1.exp]));
    await page.evaluate(() => NSO_MICROSCOPE.activatePlate('lens'));
    await frames(page);
    const back = await page.evaluate(() => { const s = NSO_MICROSCOPE.plateState('lens'); return { sig: window.__s.plateSig('lens'), st: JSON.stringify([s.isolated, s.boxes.length, s.mode]) }; });
    check('plate 1 active again, as it was left (the isolated box, REGION armed)', back.sig === lensBefore && back.st === lensState, J([back, lensState]));
    check('Read plate -> inside IMPORT ▾ (gate 3: a real click there loaded the active plate)', await page.evaluate(() =>
      document.getElementById('ms-import-menu').contains(document.getElementById('ms-btn-plate')) && !document.getElementById('ms-btn-plate').closest('#ms-main-card')));
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. the Features list and the slider, as they were ===');
  let pitch2 = null;
  {
    // Slice again (the settings' 0.25 takes effect now); the Features list and the slider on a slice
    await page.evaluate(() => { NSO_MICROSCOPE.back(); NSO_MICROSCOPE.clearBoxes(); NSO_MICROSCOPE.setMode('piece'); });
    const r = await clickFace(page, '#ms-cam-slice');
    await waitSlice(page);
    await frames(page);
    pitch2 = await page.evaluate(() => window.__s.layerPitch());
    check('Slice settings -> the Slice row: the edit (layer 0.25) is what the next slice (Normal, then Slice again) takes', r && r.ok && pitch2 !== null && Math.abs(pitch2 - 0.25) < 0.005, String(pitch2));
    const f = await page.evaluate(() => {
      const $ = id => document.getElementById(id);
      const d = NSO_MICROSCOPE.getDoc();
      const feats = Array.from(new Set(d.segments.map(s => s.feature))).sort();
      const items = Array.from(document.querySelectorAll('#ms-legend .ms-legend-item'));
      const R = e => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom }; };
      const zr = $('ms-zr'), vp = $('ms-viewport').getBoundingClientRect();
      return { feats, names: items.map(it => it.dataset.group).sort(),
               oneBox: items.every(it => it.querySelectorAll('input[type="checkbox"]').length === 1 && !it.querySelector('button')),
               inLeft: !!$('ms-legend-float').closest('#ms-dock-left'), legend: R($('ms-legend-float')),
               zrUp: !zr.hidden && zr.getBoundingClientRect().height > 0, zr: R(zr), vpR: vp.right, vpW: vp.width,
               zrKids: ['ms-zr-track', 'ms-zr-hi', 'ms-zr-lo', 'ms-zr-card', 'ms-zr-all'].every(id => zr.contains($(id))),
               full: NSO_MICROSCOPE.zRange().full, title: $('ms-legend-title').textContent.trim() };
    });
    check('the Features list: one row per line type of the slice, each a single checkbox and nothing else (1b)', J(f.feats) === J(f.names) && f.oneBox && f.names.length > 1, J([f.feats, f.names]));
    check('...down the left wall (#ms-dock-left), at its foot', f.inLeft && f.legend.x < 20, J(f.legend));
    check('the slider is up on the right edge of the viewport with its handles, Range and All, at All', f.zrUp && f.zrKids && f.vpR - f.zr.r < 20 && f.zr.x > f.vpW * 0.8 && f.full, J([f.zr, f.vpR]));
    const t = await clickFace(page, '#ms-legend-toggle');
    const col = await page.evaluate(() => [document.getElementById('ms-legend-float').classList.contains('collapsed'), document.getElementById('ms-legend-toggle').getAttribute('aria-expanded')]);
    await clickFace(page, '#ms-legend-toggle');
    const exp = await page.evaluate(() => [document.getElementById('ms-legend-float').classList.contains('collapsed'), document.getElementById('ms-legend-toggle').getAttribute('aria-expanded')]);
    check('...the list\'s minimize toggle still folds and unfolds it', t && t.ok && col[0] && col[1] === 'false' && !exp[0] && exp[1] === 'true', J([col, exp]));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. layout: the card and the left wall, both sides, two window sizes ===');
  {
    // the settings stay open within a visit; fold them for the folded case
    let L = await layout(page);
    if (L.unfolded) { await clickFace(page, '#ms-slice-settings-toggle'); await frames(page); L = await layout(page); }
    layoutChecks(L, '1280 x 800, Slice side, settings folded');
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForTimeout(250);
    await frames(page);
    layoutChecks(await layout(page), '1024 x 720, Slice side, settings folded');
    await clickFace(page, '#ms-slice-settings-toggle');
    await page.waitForTimeout(80);
    await frames(page);
    L = await layout(page);
    layoutChecks(L, '1024 x 720, Slice side, settings unfolded');
    const short = await page.evaluate(() => {
      const corner = Array.from(document.querySelectorAll('#ms-corner > button:not([hidden])')).map(b => b.getBoundingClientRect());
      const boxes = ['ms-info-title', 'ms-slice-readout'].map(id => document.getElementById(id).closest('.ms-glass')).filter(e => getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect());
      return { W: innerWidth, H: innerHeight, cornerR: Math.max(...corner.map(b => b.right)), rowTop: Math.min(...boxes.map(b => b.top)), rowR: Math.max(...boxes.map(b => b.right)) };
    });
    check('1024 x 720: the corner row stays inside', short.cornerR <= short.W, String(short.cornerR));
    check('1024 x 720: the bottom boxes are inside the window and clear of the slider', short.rowTop >= 0 && short.rowR <= short.W - 76, J([short.rowTop, short.rowR]));
    const rr = await reach(page, SETTINGS.concat(['ms-mode-select', 'ms-btn-take-band', 'ms-render-solid']));
    check('1024 x 720: every control of the unfolded Slice side can be hit with a real click', rr.blocked.length === 0 && rr.hidden.length === 0, J(rr));
    await shot('09-short-slice-settings');
    // Export needs a selection to have anything to show on a slice
    await clickFace(page, '#ms-btn-take-band');
    await clickFace(page, '#ms-nav-export');
    const ex = await page.evaluate(() => { const b = document.getElementById('ms-card-export').getBoundingClientRect(); return { t: b.top, l: b.left, b: b.bottom, r: b.right, H: innerHeight, W: innerWidth,
      on: getComputedStyle(document.getElementById('ms-card-export')).display !== 'none' }; });
    check('1024 x 720: the Export card opens inside the window, clear of the card', ex.on && ex.b <= ex.H && ex.r <= ex.W && ex.t >= 0 && !overlaps({ x: ex.l, y: ex.t, r: ex.r, b: ex.b }, L.card), J(ex));
    await escape(page);
    await escape(page);
    // the Normal side, through #ms-cam-normal this time
    const r = await clickFace(page, '#ms-cam-normal');
    await waitMesh(page);
    await page.waitForTimeout(100);
    await frames(page);
    const st = await cardState(page);
    check('Normal (a real click on #ms-cam-normal) goes back to the mesh: the Normal side, 2 rows', r && r.ok && st.side === 'normal' && J(st.rows) === J(NORMAL_ROWS), J([st.side, st.rows]));
    layoutChecks(await layout(page), '1024 x 720, Normal side');
    await shot('10-short-normal');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
    await frames(page);
    layoutChecks(await layout(page), '1280 x 800, Normal side');
    // on a mesh, Normal is the re-frame it always was: same side, same document
    const sig = await page.evaluate(() => window.__s.plateSig('lens'));
    await clickFace(page, '#ms-cam-normal');
    check('on a mesh Normal re-frames and changes nothing else', (await cardState(page)).side === 'normal' && await page.evaluate(() => window.__s.plateSig('lens')) === sig);
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. the Escape ladder; CLOSE; a new visit ===');
  {
    // REGION armed, a box placed and isolated, the ▾ menu open
    const px = await page.evaluate(() => window.__s.pxPiece());
    await clickFace(page, '#ms-mode-select');
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(150);
    await clickFace(page, '#ms-btn-isolate');
    await clickFace(page, '#ms-btn-import-more');
    const at = () => page.evaluate(() => ({ menu: document.getElementById('ms-import-menu').classList.contains('is-open'), iso: NSO_MICROSCOPE.isIsolated(),
      boxes: NSO_MICROSCOPE.boxes().length, mode: NSO_MICROSCOPE.mode(), open: NSO_MICROSCOPE.isOpen() }));
    const s0 = await at();
    check('set up: REGION armed, one box, isolated, the ▾ menu open', s0.menu && s0.iso && s0.boxes === 1 && s0.mode === 'select' && s0.open, J(s0));
    await escape(page);
    const s1 = await at();
    check('Escape 1: the ▾ menu shuts; the isolate stays', !s1.menu && s1.iso && s1.boxes === 1 && s1.open, J(s1));
    await escape(page);
    const s2 = await at();
    check('Escape 2: whole again; the box stays', !s2.iso && s2.boxes === 1 && s2.mode === 'select' && s2.open, J(s2));
    await escape(page);
    const s3 = await at();
    check('Escape 3: the box (not isolated) is removed; REGION still armed', s3.boxes === 0 && s3.mode === 'select' && s3.open, J(s3));
    await escape(page);
    const s4 = await at();
    check('Escape 4: REGION disarms', s4.mode === 'piece' && s4.open, J(s4));
    await escape(page);
    const s5 = await at();
    check('Escape 5, nothing left to undo: G-scope closes', !s5.open && await page.evaluate(() => document.getElementById('microscope').hidden), J(s5));

    // a new visit: the plate read again, the Slice settings folded and back on the printer profile (0.25 forgotten)
    await page.click('#btn-microscope');
    await waitMesh(page);
    await frames(page);
    const v = await page.evaluate(() => ({ side: document.getElementById('ms-main-card').dataset.side, folded: document.getElementById('ms-slice-settings').hidden,
      aria: document.getElementById('ms-slice-settings-toggle').getAttribute('aria-expanded'), layer: document.getElementById('ms-slice-layer').value,
      nozzle: document.getElementById('ms-slice-nozzle').value, menu: document.getElementById('ms-import-menu').classList.contains('is-open') }));
    check('a new visit: the Normal side, the ▾ shut, the Slice settings folded and re-seeded (nozzle 0.4, layer 0.2 - the 0.25 is gone)',
      v.side === 'normal' && v.folded && v.aria === 'false' && v.layer === '0.2' && v.nozzle === '0.4' && !v.menu, J(v));
    // CLOSE shuts the menu with G-scope
    await clickFace(page, '#ms-btn-import-more');
    const r = await clickFace(page, '#ms-close');
    const c = await page.evaluate(() => ({ hidden: document.getElementById('microscope').hidden, menu: document.getElementById('ms-import-menu').classList.contains('is-open'),
      aria: document.getElementById('ms-btn-import-more').getAttribute('aria-expanded') }));
    check('CLOSE (a real click) with the ▾ menu open: G-scope closes and the menu with it', r && r.ok && c.hidden && !c.menu && c.aria === 'false', J(c));
  }

  /* ------------------------------------------------------------------ 10 */
  console.log('\n=== 10. no page errors ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  console.log('\nscreenshots: ' + path.relative(ROOT, SHOTS) + '/ (card-normal.png, card-slice.png, card-slice-settings.png)');
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('GSCOPE SHELL FAIL', e); process.exit(1); });
