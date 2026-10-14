#!/usr/bin/env node
/* Shell v2: which buttons exist, where they sit, and what each opens.

   The top row, left to right: Import, Move, Rotate, Tip, Bend, Align, Gen+ ▾,
   Lock position, Lock plate, then at the right Undo, Remove, Export, with
   Plate directly under Export. Gen+, Join and Plate hold several menus each
   but carry plain text, no drop-down mark. The left column in five groups, a
   12 px gap between them, a 36 px pitch inside them: Scale .. Subtract;
   Shape .. Sculpt; Measure & check, Check & repair; G-scope; and X-ray (X),
   Eye (👁), ◎ in one row pinned to the bottom.

   GATES
     1. Grid on at load.
     2. Every button exists with its label, in its place: the row's order, the
        stack, the column's groups, pitch and gaps; the column fits within
        744 px of a 1280 x 800 window and inside its viewport.
     3. Each drop-down opens what it should (the controls its panel holds),
        at the one spot (the green box), one open at a time, and closing a
        card keeps the selection.
     4. Each plain button does what it should: the locks, Undo (and its
        disabled state), Remove, X-ray, Eye, ◎, G-scope, and Lift opening
        G-scope at its row.
     5. Every control the shell had before v2 (listed below by id) is still
        reachable: each drop-down on the way to it is clicked open at its own
        on-screen spot, and the control is then hit-testable in its panel -
        or hidden by its own state, which is reported.
     6. The narrow-window rule: at 900 x 820 and 900 x 720 the viewport fills
        the window and every column slab, Undo, Remove, Export and Plate can
        be clicked.

     node tools/nso_shell_v2_test.js       exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* ---------------------------------------------------------------- the ticket */
const ROW = [
  ['menu-import', 'IMPORT'], ['menu-move', 'MOVE'], ['menu-rotate', 'ROTATE'], ['menu-tip', 'TIP'],
  ['menu-bend', 'BEND'], ['menu-align', 'ALIGN'], ['menu-gen', 'GEN+'],
  ['btn-lock-pos', 'LOCK POSITION'], ['btn-plate-lock', 'LOCK PLATE']
];
const RIGHT = [['btn-undo', 'UNDO'], ['btn-delete-placed', 'REMOVE'], ['menu-export', 'EXPORT']];
const UNDER_EXPORT = ['menu-plates', 'PLATE'];
const GROUPS = [
  [['menu-scale', 'SCALE'], ['menu-cut', 'CUT'], ['menu-crop', 'CROP'], ['menu-joins', 'JOIN'],
   ['btn-shell-lift', 'LIFT'], ['menu-seat', 'SEAT'], ['menu-supports', 'SUPPORTS'], ['menu-bit', 'SUBTRACT']],
  [['menu-shape', 'SHAPE'], ['menu-paint', 'PAINT'], ['menu-surface', 'SURFACE'], ['menu-sculpt', 'SCULPT']],
  [['menu-measure', 'MEASURE & CHECK'], ['menu-repair', 'CHECK & REPAIR']],
  [['btn-microscope', 'G-SCOPE']],
  [['btn-xray', 'X-RAY'], ['btn-watch', 'EYE'], ['btn-frame-view', '◎']]
];
/* The view group's faces are icons; X and the eye are named by their
   aria-labels, ◎ by itself. */
const ICON = { 'btn-xray': 'X', 'btn-watch': '\u{1F441}', 'btn-frame-view': '◎' };
const GONE = ['btn-shell-supports', 'btn-shell-slice'];
const ALL = ROW.concat(RIGHT, [UNDER_EXPORT], ...GROUPS);
const DROPDOWNS = ALL.map(([id]) => id).filter(id => id.startsWith('menu-'));

/* What each drop-down's panel holds: the controls it opens, by id or selector.
   NOT lists what must have left it. */
const HOLDS = {
  'menu-import': ['btn-load-stl', 'btn-library', 'library-list'],
  'menu-move': ['chk-move-vertical', 'btn-to-plate', 'btn-nudge-fwd', 'btn-nudge-back', 'btn-nudge-left', 'btn-nudge-right'],
  'menu-rotate': ['btn-rot-left', 'btn-rot-right', 'chk-rot-ring-turn', 'chk-rot-ring-fb', 'chk-rot-ring-ss'],
  'menu-tip': ['btn-flip', 'btn-tip', 'btn-flip-over', 'btn-tip-face', 'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn'],
  'menu-bend': ['btn-bend', 'bend-panel', 'inp-bend-where', 'inp-bend-angle', 'inp-bend-radius', 'sel-bend-toward', 'btn-bend-go', 'btn-bend-cancel'],
  'menu-align': ['btn-join-align', 'btn-join-cx', 'btn-join-cz', 'btn-center-lock', 'btn-center-lock-pick', 'center-lock-ref'],
  'menu-gen': ['.vp-wheel-menu', '.vp-stock-menu', 'btn-stock-make', 'btn-stock-attach', 'menu-relief', 'btn-relief-pick',
               'menu-photo', 'btn-photoset-pick', 'btn-photoset-report', 'btn-photoset-clear'],
  'menu-export': ['export-format', 'btn-export-model', 'btn-library-save', 'btn-export-stl', 'btn-delete-model'],
  'menu-plates': ['menu-plate', 'plate-select', 'plate-grid-show', 'chk-plate-grid-snap', 'menu-pieces', 'model-list',
                  'clone-count', 'btn-clone', 'menu-pack', 'btn-optimize', 'btn-clear-plate'],
  'menu-scale': ['scale-card', 'btn-scale-factor', 'btn-scale-dim', 'btn-scale-fit'],
  'menu-cut': ['edit-card', 'cut-miter-dial', 'cut-slider', 'cut-mm', 'btn-cut'],
  'menu-crop': ['crop-card', 'btn-crop-axis-x', 'btn-crop-axis-z', 'chk-crop-box', 'btn-crop', 'btn-crop-lockin', 'btn-detach', 'btn-reattach'],
  'menu-joins': ['menu-join', 'btn-join-start', 'join-slot-a', 'join-slot-b', 'join-slot-c', 'btn-join', 'btn-join-clear',
                 'menu-abc', 'triple-mode', 'btn-join-triple'],
  'menu-seat': ['btn-seat-support', 'seat-gap', 'btn-seat-here', 'chk-oversize-washer', 'btn-seat-flush', 'btn-flip-port', 'btn-seat-grid'],
  'menu-supports': ['supports-card', 'btn-sup-all', 'btn-sup-none', 'btn-sup-paint', 'sel-sup-paint', 'sup-style', 'sup-size',
                    'sup-rest', 'btn-sup-remove'],
  'menu-bit': ['btn-subtract', 'btn-extract-bit'],
  'menu-shape': ['inp-soften-r', 'chk-full-wrap', 'btn-soften', 'sel-edge-treat', 'btn-smooth', 'btn-extend', 'btn-mirror',
                 'btn-thicken-out', 'btn-thicken-in', 'btn-hollow', 'btn-hollow-safe', 'btn-fill', 'btn-foam', 'foam-panel'],
  'menu-paint': ['btn-mask-select', 'btn-mask-paint', 'btn-mask-clear', 'btn-mask-delete', 'sel-mask-delete', 'btn-extract-sel'],
  'menu-surface': ['btn-skin-face', 'skin-pattern', 'btn-skin-wrap', 'chk-skin-free', 'skin-layer2', 'btn-skin-patch',
                   'btn-trace-raster', 'raster-size', 'btn-texture', 'inp-texture-pitch'],
  'menu-sculpt': ['btn-brush', 'sel-brush-mode', 'inp-brush-size', 'btn-carve', 'carve-blade', 'carve-depth'],
  'menu-measure': ['btn-measure', 'sel-measure-mode', 'btn-check-defects'],
  'menu-repair': ['btn-cap-open', 'chk-seal-repair', 'btn-seal', 'chk-non-solid', 'btn-solidify']
};
const NOT = { 'menu-shape': ['btn-bend', 'bend-panel'], 'menu-gen': [] };

/* Every control in the shell on claude-wip before v2 (ec46788): each button,
   input, select, <details> and the mitre dial with an id, in the top bar,
   the left column, the Finish menu and the bottom-left tool strip. */
const BEFORE = ['menu-import', 'file-input', 'btn-load-stl', 'btn-library', 'menu-export', 'export-format', 'cooling-profile',
  'btn-export-model', 'btn-library-save', 'btn-export-stl', 'btn-delete-model', 'menu-rotate', 'btn-rot-left', 'btn-rot-right',
  'chk-rot-ring-turn', 'chk-rot-ring-fb', 'chk-rot-ring-ss', 'menu-tip', 'btn-flip', 'btn-tip', 'btn-flip-over', 'btn-tip-face',
  'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn', 'menu-move', 'chk-move-vertical', 'btn-to-plate', 'btn-nudge-fwd',
  'btn-nudge-back', 'btn-nudge-left', 'btn-nudge-right', 'btn-delete-placed', 'btn-lock-pos', 'btn-plate-lock', 'menu-photo',
  'photoset-input', 'btn-photoset-pick', 'btn-photoset-report', 'btn-photoset-clear', 'menu-gen', 'inp-wheel-height',
  'inp-wheel-radius', 'inp-wheel-wall', 'inp-wheel-nozzle', 'btn-wheel-ball', 'btn-wheel-open', 'inp-wheel-depth',
  'inp-wheel-pull-z', 'inp-wheel-pull-dr', 'btn-wheel-pull', 'btn-wheel-trim', 'inp-wheel-trim-z', 'btn-wheel-rim',
  'inp-wheel-rim-mm', 'sel-stock-shape', 'inp-stock-height', 'inp-stock-radius', 'inp-stock-wall', 'inp-stock-nozzle',
  'inp-stock-waste', 'inp-stock-prop', 'chk-stock-match', 'chk-stock-oversize', 'btn-stock-make', 'btn-stock-attach',
  'menu-relief', 'relief-file', 'btn-relief-pick', 'inp-relief-width', 'inp-relief-base', 'inp-relief-relief',
  'inp-relief-detail', 'sel-relief-levels', 'chk-relief-bright', 'btn-relief-make', 'btn-relief-undo', 'menu-scale',
  'btn-scale-unit-mm', 'btn-scale-unit-in', 'scale-length', 'btn-scale-length', 'scale-width', 'btn-scale-width',
  'scale-height', 'btn-scale-height', 'scale-ring-outer', 'btn-scale-ring-outer', 'scale-ring-wall', 'btn-scale-ring-wall',
  'scale-rod-diameter', 'btn-scale-rod-diameter', 'scale-offset', 'btn-scale-offset', 'scale-factor', 'btn-scale-factor',
  'scale-target', 'btn-scale-dim', 'btn-scale-fit', 'menu-cut', 'cut-miter-dial', 'cut-miter-deg', 'btn-cut-square',
  'cut-slider', 'btn-cut-nudge-m', 'cut-mm', 'btn-cut-nudge-p', 'btn-cut', 'btn-cut-right-side-out', 'menu-crop', 'edit-axis',
  'btn-crop-axis-x', 'btn-crop-axis-z', 'chk-crop-box', 'crop-start-mm', 'crop-end-mm', 'btn-crop', 'crop-up-from',
  'crop-up-to', 'crop-across-from', 'crop-across-to', 'chk-crop-lift', 'crop-move-dx', 'crop-move-dy', 'crop-move-dz',
  'btn-crop-lockin', 'btn-detach', 'btn-reattach', 'menu-join', 'btn-join-start', 'join-slot-a', 'join-slot-b', 'join-slot-c',
  'btn-join', 'btn-join-clear', 'menu-align', 'btn-join-align', 'btn-join-cx', 'btn-join-cz', 'btn-center-lock',
  'btn-center-lock-pick', 'center-lock-ref', 'menu-seat', 'btn-seat-support', 'seat-gap', 'btn-seat-here',
  'chk-oversize-washer', 'oversize-gap', 'btn-seat-flush', 'btn-flip-port', 'btn-seat-grid', 'menu-abc', 'triple-mode',
  'triple-gap-ab', 'triple-gap-bc', 'btn-join-triple', 'menu-bit', 'btn-subtract', 'btn-extract-bit', 'menu-plate',
  'plate-select', 'custom-w', 'custom-d', 'custom-h', 'plate-grid-show', 'chk-plate-grid-snap', 'menu-pieces', 'clone-count',
  'btn-clone', 'menu-pack', 'btn-optimize', 'menu-finish', 'inp-soften-r', 'chk-full-wrap', 'btn-soften', 'sel-edge-treat',
  'btn-smooth', 'btn-extend', 'inp-extend-mm', 'btn-bend', 'inp-bend-where', 'inp-bend-angle', 'inp-bend-radius',
  'sel-bend-toward', 'inp-bend-roll', 'btn-bend-go', 'btn-bend-cancel', 'btn-mirror', 'inp-mirror-plane', 'btn-thicken-out',
  'inp-thicken-mm', 'btn-thicken-in', 'btn-hollow', 'inp-hollow-mm', 'btn-hollow-safe', 'btn-fill', 'btn-foam',
  'inp-foam-level', 'btn-foam-all', 'btn-foam-set', 'btn-foam-cancel', 'btn-mask-select', 'btn-mask-paint', 'btn-mask-clear',
  'btn-mask-delete', 'sel-mask-delete', 'btn-extract-sel', 'btn-skin-face', 'skin-pattern', 'btn-skin-wrap', 'chk-skin-free',
  'skin-layer2', 'btn-skin-patch', 'skin-patch-variant', 'btn-trace-raster', 'raster-file', 'raster-size',
  'raster-threshold', 'raster-line-width', 'raster-line-height', 'raster-invert', 'btn-texture', 'sel-texture-pattern',
  'inp-texture-pitch', 'inp-texture-depth', 'btn-brush', 'sel-brush-mode', 'inp-brush-size', 'inp-brush-intensity',
  'chk-brush-hard', 'btn-carve', 'carve-blade', 'carve-depth', 'carve-a', 'carve-b', 'carve-roll', 'btn-measure',
  'sel-measure-mode', 'btn-check-defects', 'btn-cap-open', 'chk-seal-repair', 'btn-seal', 'chk-non-solid', 'btn-solidify',
  'btn-clear-plate', 'move-vert-slider', 'btn-undo', 'btn-frame-view', 'btn-xray', 'btn-microscope', 'ms-input', 'btn-watch'];
/* The one id that went: Finish was a wrapper. Its job - opening its six
   sections - is done by these six column buttons. */
const RETIRED = { 'menu-finish': ['menu-shape', 'menu-paint', 'menu-surface', 'menu-sculpt', 'menu-measure', 'menu-repair'] };
/* Hidden by their own state, with a box piece selected and nothing armed:
   each shows when its own control asks for it. Anything else found hidden
   is a failure, not a pass. */
const OWN_STATE = {
  'move-vert-slider': 'Move > Vertical on',
  'cooling-profile': 'Export format 3MF',
  'scale-length': 'a section the reader names', 'btn-scale-length': 'ditto', 'scale-width': 'ditto',
  'btn-scale-width': 'ditto', 'scale-height': 'ditto', 'btn-scale-height': 'ditto', 'scale-ring-outer': 'a ring',
  'btn-scale-ring-outer': 'a ring', 'scale-ring-wall': 'a ring', 'btn-scale-ring-wall': 'a ring',
  'scale-rod-diameter': 'a rod', 'btn-scale-rod-diameter': 'a rod', 'scale-offset': 'a shelled piece',
  'btn-scale-offset': 'a shelled piece',
  'btn-cut-right-side-out': 'after Cut refuses an inside-out piece',
  'edit-axis': 'kept hidden (hidden-quiet) since #166',
  'custom-w': 'Plate: Custom', 'custom-d': 'Plate: Custom', 'custom-h': 'Plate: Custom',
  'inp-foam-level': 'Foam on', 'btn-foam-all': 'Foam on', 'btn-foam-set': 'Foam on', 'btn-foam-cancel': 'Foam on',
  'inp-bend-where': 'Bend on', 'inp-bend-angle': 'Bend on', 'inp-bend-radius': 'Bend on', 'sel-bend-toward': 'Bend on',
  'inp-bend-roll': 'Bend on, a section that is not a rectangle', 'btn-bend-go': 'Bend on', 'btn-bend-cancel': 'Bend on',
  'carve-b': 'a blade with a length', 'inp-stock-prop': 'a shape with proportions'
};
/* File inputs are never on screen: their button opens them. */
const FILE_INPUT_VIA = { 'file-input': 'btn-load-stl', 'photoset-input': 'btn-photoset-pick', 'relief-file': 'btn-relief-pick',
                         'raster-file': 'btn-trace-raster', 'ms-input': 'btn-microscope' };

/* ------------------------------------------------------------------ helpers */
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9+&◎\- ]/g, ' ').replace(/\s+/g, ' ').trim();

// The clickable face of a shell entry: a <details>' summary, or the button.
const FACE = id => {
  const e = document.getElementById(id);
  return e && e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
};

async function shutAll(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.vp-menu[open]').forEach(d => { d.open = false; });
  });
  await page.waitForTimeout(60);
}

/* A real click at the middle of an element, after checking that the middle
   is the element (nothing covers it). Returns false if it is covered or has
   no box. */
async function clickFace(page, sel) {
  const r = await page.evaluate((sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return { ok: false, why: 'no box' };
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === e || e.contains(hit));
    return { ok, x, y, why: ok ? '' : 'covered by ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing') };
  }, sel);
  if (!r || !r.ok) return r || { ok: false, why: 'missing' };
  await page.mouse.click(r.x, r.y);
  await page.waitForTimeout(70);
  return r;
}

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. grid on at load ===');
  {
    const g = await page.evaluate(() => ({
      mode: state.plateGridMode, sel: document.getElementById('plate-grid-show').value,
      vis: !!(state.plateGrid && state.plateGrid.visible)
    }));
    check('the bed grid is on and drawn at load', g.mode === 'on' && g.sel === 'on' && g.vis, JSON.stringify(g));
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. every button, its label, its place ===');
  const geo = await page.evaluate(([all, gone]) => {
    const FACE = id => {
      const e = document.getElementById(id);
      return e && e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
    };
    const out = {};
    all.forEach(([id]) => {
      const f = FACE(id);
      if (!f) { out[id] = null; return; }
      const b = f.getBoundingClientRect();
      out[id] = { text: f.textContent, aria: f.getAttribute('aria-label') || '', x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom,
                  inRow: !!f.closest('.vp-shell-row'), inCol: !!f.closest('.vp-shell-col'),
                  cut: f.scrollWidth > f.clientWidth + 1 || f.scrollHeight > f.clientHeight + 1 };
    });
    const v = document.getElementById('viewport').getBoundingClientRect();
    out._vp = { top: v.top, bottom: v.bottom, left: v.left, right: v.right, h: v.height, W: innerWidth, H: innerHeight };
    out._strip = document.querySelectorAll('.viewport-overlay-bl, .viewport-tool-btn, .vp-finish-menu, #menu-finish').length;
    out._marks = all.map(([id]) => (FACE(id) || {}).textContent || '').join('').match(/[▾▼⌄]/g) || [];
    out._gone = gone.filter(id => document.getElementById(id));
    return out;
  }, [ALL, GONE]);
  {
    const missing = ALL.filter(([id]) => !geo[id]).map(([id]) => id);
    check('every button in the ticket exists', missing.length === 0, missing.join(', ') || ALL.length + ' buttons');
    const named = id => (ICON[id] && id !== 'btn-frame-view') ? geo[id].aria : geo[id].text;
    const wrong = ALL.filter(([id, label]) => geo[id] && norm(named(id)) !== norm(label))
      .map(([id, label]) => id + ' reads "' + norm(named(id)) + '", wants "' + label + '"');
    check('each carries the ticket\'s label', wrong.length === 0, wrong.join('; ') || 'all ' + ALL.length);
    const icons = Object.keys(ICON).filter(id => !geo[id] || geo[id].text.trim() !== ICON[id]);
    check('the view group shows X, the eye emoji and ◎', icons.length === 0,
      icons.map(id => id + ' shows "' + (geo[id] && geo[id].text.trim()) + '"').join('; ') || 'X 👁 ◎');
    check('no drop-down mark on any face (Gen+, Join, Plate are plain text)', geo._marks.length === 0,
      geo._marks.length + ' found');
    check('Supports and Slice settings are not in the column', geo._gone.length === 0, geo._gone.join(', ') || 'gone');
    const cut = ALL.filter(([id]) => geo[id] && geo[id].cut).map(([id]) => id);
    check('no label is cut off or spills out of its slab', cut.length === 0, cut.join(', ') || 'none');
    check('the bottom-left tool strip and the Finish wrapper are gone', geo._strip === 0, geo._strip + ' found');

    const row = ROW.concat(RIGHT).map(([id]) => Object.assign({ id }, geo[id]));
    const top = row[0].y;
    check('the top row is one line, in the ticket\'s order, left to right',
      row.every(b => b.inRow && Math.abs(b.y - top) < 0.5) && row.every((b, i) => i === 0 || b.x > row[i - 1].r - 0.5),
      row.map(b => b.id.replace(/^(menu|btn)-/, '') + '@' + Math.round(b.x)).join(' '));
    const undo = geo['btn-undo'], lockPlate = geo['btn-plate-lock'], exp = geo['menu-export'];
    check('Undo, Remove and Export sit at the right end, apart from Lock plate',
      Math.abs(exp.r - (geo._vp.right - 8)) < 1 && undo.x - lockPlate.r > 20,
      'lock plate ends ' + Math.round(lockPlate.r) + ', undo at ' + Math.round(undo.x) + ', export ends ' + Math.round(exp.r));
    const pl = geo['menu-plates'];
    check('Plate ▾ is directly under Export (second row, top right), the same width',
      Math.abs(pl.x - exp.x) < 0.5 && Math.abs(pl.w - exp.w) < 0.5 && pl.y > exp.b && pl.y - exp.b < 8,
      'export ' + [exp.x, exp.b, exp.w].map(Math.round) + ' / plate ' + [pl.x, pl.y, pl.w].map(Math.round));

    const imp = geo['menu-import'];
    const col = GROUPS.map(g => g.map(([id]) => Object.assign({ id }, geo[id])));
    const first = col[0][0];
    check('the column starts under Import, at its x', Math.abs(first.x - imp.x) < 0.5 && first.y > imp.b,
      'import ' + Math.round(imp.x) + ',' + Math.round(imp.b) + ' scale ' + Math.round(first.x) + ',' + Math.round(first.y));
    const stacked = col.slice(0, 4).every(g => g.every(b => b.inCol && Math.abs(b.x - imp.x) < 0.5 && Math.abs(b.w - imp.w) < 0.5));
    check('groups 1-4 are one stack under Import, Import\'s width', stacked,
      col.slice(0, 4).map(g => g.map(b => Math.round(b.x) + '/' + Math.round(b.w)).join(' ')).join(' | '));
    const pitches = [];
    col.slice(0, 4).forEach(g => g.forEach((b, i) => { if (i) pitches.push(+(b.y - g[i - 1].y).toFixed(2)); }));
    check('a 36 px pitch inside each group', pitches.every(p => Math.abs(p - 36) < 0.5), pitches.join(' '));
    const gaps = [];
    for (let i = 1; i < 4; i++) gaps.push(+(col[i][0].y - col[i - 1][col[i - 1].length - 1].b).toFixed(2));
    check('a 12 px gap between groups', gaps.every(g => Math.abs(g - 12) < 0.5), gaps.join(' '));
    const view = col[4];
    const lastAbove = col[3][col[3].length - 1];
    check('the view group (X, eye, ◎) is one row pinned to the bottom of the column, a group gap or more under G-scope',
      view.every(b => b.inCol && Math.abs(b.b - (geo._vp.bottom - 8)) < 0.5 && Math.abs(b.y - view[0].y) < 0.5) &&
      view[0].y - lastAbove.b >= 12 - 0.5 &&
      Math.abs(view[0].x - imp.x) < 0.5 && view[2].r <= imp.r + 0.5,
      view.map(b => b.id + '@' + Math.round(b.x) + ',' + Math.round(b.y)).join(' ') + '; viewport bottom ' + geo._vp.bottom);
    const colBottom = Math.max(...view.map(b => b.b));
    check('the column fits within 744 px at 1280 x 800, inside the viewport',
      colBottom - geo._vp.top <= 744 && colBottom <= geo._vp.bottom && first.y >= geo._vp.top,
      'column ' + Math.round(first.y - geo._vp.top) + '..' + Math.round(colBottom - geo._vp.top) + ' px of a ' + geo._vp.h + ' px viewport');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. each drop-down opens what it should, in the green box, one at a time ===');
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { selectPlaced(0); });
  await page.waitForTimeout(100);
  const sel0 = await page.evaluate(() => ({ i: state.selectedIndex, id: state.editId }));
  check('a piece is on the plate and selected', sel0.i === 0 && sel0.id != null, JSON.stringify(sel0));
  {
    const vp = geo._vp;
    const spots = [], holdFails = [], notFails = [], counts = [], keeps = [];
    for (const id of DROPDOWNS) {
      await shutAll(page);
      const before = await page.evaluate(() => ({ i: state.selectedIndex, id: state.editId }));
      const c = await clickFace(page, '#' + id + ' > summary');
      if (!c.ok) { holdFails.push(id + ' could not be clicked: ' + c.why); continue; }
      await page.waitForTimeout(150);
      const r = await page.evaluate(([id, holds, not]) => {
        const d = document.getElementById(id);
        const body = d.querySelector(':scope > .vp-menu-body');
        const b = body.getBoundingClientRect();
        const has = sel => { const e = sel[0] === '.' ? body.querySelector(sel) : document.getElementById(sel); return !!e && body.contains(e); };
        return { open: d.open, x: b.left, y: b.top, w: b.width,
                 nOpen: [...document.querySelectorAll('.vp-shell-menu[open]')].map(x => x.id),
                 missing: holds.filter(s => !has(s)), present: not.filter(s => has(s)) };
      }, [id, HOLDS[id] || [], NOT[id] || []]);
      if (!r.open) holdFails.push(id + ' did not open');
      if (r.missing.length) holdFails.push(id + ' lacks ' + r.missing.join(','));
      if (r.present.length) notFails.push(id + ' still holds ' + r.present.join(','));
      spots.push({ id, x: r.x - vp.left, y: r.y - vp.top });
      counts.push({ id, open: r.nOpen });
      // Close the card the way it was opened; the selection stays.
      await clickFace(page, '#' + id + ' > summary');
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({ i: state.selectedIndex, id: state.editId }));
      if (after.i !== before.i || after.id !== before.id) keeps.push(id + ' ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after));
    }
    check('every drop-down opens on a click and holds the controls the ticket gives it', holdFails.length === 0,
      holdFails.join('; ') || DROPDOWNS.length + ' drop-downs');
    check('Bend is out of Shape', notFails.length === 0, notFails.join('; ') || 'Shape holds no Bend');
    const off = spots.filter(s => Math.abs(s.x - 134) > 0.5 || Math.abs(s.y - 52) > 0.5);
    check('every panel opens at the one spot, the green box (134, 52 in the viewport)', off.length === 0,
      off.map(s => s.id + '@' + s.x.toFixed(1) + ',' + s.y.toFixed(1)).join('; ') || spots.length + ' panels');
    const many = counts.filter(c => c.open.length !== 1 || c.open[0] !== c.id);
    check('opening one leaves exactly that one open', many.length === 0,
      many.map(c => c.id + ': ' + c.open.join(',')).join('; ') || 'one at a time');
    check('closing a card keeps the selection', keeps.length === 0, keeps.join('; ') || DROPDOWNS.length + ' cards');

    // A member open inside a merged drop-down, then another drop-down: only the new one is open.
    await shutAll(page);
    await clickFace(page, '#menu-joins > summary');
    await clickFace(page, '#menu-abc > summary');
    const mid = await page.evaluate(() => [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id));
    await clickFace(page, '#menu-shape > summary');
    await page.waitForTimeout(100);
    const end = await page.evaluate(() => [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id));
    check('a member opens inside its drop-down, and the next drop-down shuts both',
      mid.join() === 'menu-joins,menu-abc' && end.join() === 'menu-shape', mid.join() + ' -> ' + end.join());
    // Two members of one drop-down: the second shuts the first.
    await shutAll(page);
    await clickFace(page, '#menu-plates > summary');
    await clickFace(page, '#menu-plate > summary');
    await clickFace(page, '#menu-pack > summary');
    const pm = await page.evaluate(() => [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id));
    check('inside Plate ▾, one member open at a time', pm.join() === 'menu-plates,menu-pack', pm.join());
    // The leave-tool gesture (double-click on the plate) shuts a drop-down and its open member.
    await shutAll(page);
    await clickFace(page, '#menu-gen > summary');
    await clickFace(page, '#menu-photo > summary');
    const left = await page.evaluate(() => ({ left: leaveTool(),
      open: [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id || d.className) }));
    check('leaving the tool (double-click on the plate) shuts Gen+ and the Photo open in it',
      left.open.length === 0 && left.left.includes('menu-gen') && left.left.includes('menu-photo'), JSON.stringify(left));
    // Bend: the button in BEND opens its panel.
    await shutAll(page);
    await clickFace(page, '#menu-bend > summary');
    await clickFace(page, '#btn-bend');
    const bend = await page.evaluate(() => ({ panel: !document.getElementById('bend-panel').hidden,
                                             vis: document.getElementById('bend-panel').getBoundingClientRect().height > 0 }));
    await page.evaluate(() => { const b = document.getElementById('btn-bend-cancel'); if (b) b.click(); });
    check('Bend\'s button, opened from BEND, opens the bend panel', bend.panel && bend.vis, JSON.stringify(bend));
    await shutAll(page);
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the plain buttons do what they did ===');
  {
    await page.evaluate(() => { selectPlaced(0); });
    // Lock position / Lock plate
    let c = await clickFace(page, '#btn-lock-pos');
    const lp1 = await page.evaluate(() => document.getElementById('btn-lock-pos').getAttribute('aria-pressed'));
    await clickFace(page, '#btn-lock-pos');
    const lp2 = await page.evaluate(() => document.getElementById('btn-lock-pos').getAttribute('aria-pressed'));
    check('LOCK POSITION locks and unlocks the selected piece', c.ok && lp1 === 'true' && lp2 === 'false', lp1 + ' -> ' + lp2);
    c = await clickFace(page, '#btn-plate-lock');
    const pl1 = await page.evaluate(() => document.getElementById('btn-plate-lock').getAttribute('aria-pressed'));
    await clickFace(page, '#btn-plate-lock');
    const pl2 = await page.evaluate(() => document.getElementById('btn-plate-lock').getAttribute('aria-pressed'));
    check('LOCK PLATE locks and unlocks the plate', c.ok && pl1 === 'true' && pl2 === 'false', pl1 + ' -> ' + pl2);

    // Undo: disabled with nothing to undo, live after a step, and it undoes it.
    await page.evaluate(() => { state.undoStack.length = 0; updateUndoBtn(); });
    const u0 = await page.evaluate(() => document.getElementById('btn-undo').disabled);
    const x0 = await page.evaluate(() => state.placed[0].x);
    await page.click('#btn-nudge-right');
    await shutAll(page);
    const u1 = await page.evaluate(() => ({ dis: document.getElementById('btn-undo').disabled, x: state.placed[0].x }));
    c = await clickFace(page, '#btn-undo');
    const u2 = await page.evaluate(() => ({ dis: document.getElementById('btn-undo').disabled, x: state.placed[0].x }));
    check('UNDO: disabled with nothing to undo, enabled after a nudge, undoes it and is disabled again',
      u0 === true && u1.dis === false && u1.x !== x0 && c.ok && u2.x === x0 && u2.dis === true,
      JSON.stringify({ u0, u1, u2, x0 }));

    // Remove, then Undo brings it back.
    await page.evaluate(() => { selectPlaced(0); });
    const n0 = await page.evaluate(() => state.placed.length);
    c = await clickFace(page, '#btn-delete-placed');
    const n1 = await page.evaluate(() => state.placed.length);
    await clickFace(page, '#btn-undo');
    const n2 = await page.evaluate(() => state.placed.length);
    check('REMOVE deletes the selected piece; Undo puts it back', c.ok && n1 === n0 - 1 && n2 === n0, n0 + ' -> ' + n1 + ' -> ' + n2);
    await page.evaluate(() => { selectPlaced(0); });

    // X-ray, Eye, ◎
    c = await clickFace(page, '#btn-xray');
    const xr1 = await page.evaluate(() => ({ on: !!state.xray, lit: document.getElementById('btn-xray').classList.contains('is-on') }));
    await clickFace(page, '#btn-xray');
    const xr2 = await page.evaluate(() => !!state.xray);
    check('X-RAY turns X-ray on (lit) and off', c.ok && xr1.on && xr1.lit && !xr2, JSON.stringify(xr1) + ' -> ' + xr2);
    c = await clickFace(page, '#btn-watch');
    const w1 = await page.evaluate(() => ({ on: NSOWatch.isOn(), lit: document.getElementById('btn-watch').classList.contains('is-on') }));
    await clickFace(page, '#btn-watch');
    const w2 = await page.evaluate(() => NSOWatch.isOn());
    await page.evaluate(() => { try { localStorage.removeItem('nso.watch'); } catch (e) {} });
    check('EYE starts and stops Watch', c.ok && w1.on && w1.lit && !w2, JSON.stringify(w1) + ' -> ' + w2);
    await page.evaluate(() => { state.camera.position.set(400, 30, -250); state.controls.target.set(60, 0, 60); state.controls.update(); setStatus('-'); });
    const cam0 = await page.evaluate(() => state.camera.position.toArray());
    c = await clickFace(page, '#btn-frame-view');
    const fv = await page.evaluate(() => ({ cam: state.camera.position.toArray(), status: document.getElementById('status').textContent }));
    check('◎ frames the view (the plate view, as before)', c.ok && /plate view/i.test(fv.status) &&
      fv.cam.some((v, i) => Math.abs(v - cam0[i]) > 1), fv.status);

    // G-scope, then Lift / Supports / Slice settings at their rows.
    const gs = async () => page.evaluate(() => {
      const panel = document.getElementById('microscope');
      const bar = document.getElementById('ms-sidebar').getBoundingClientRect();
      const row = id => {
        const e = document.getElementById(id);
        const b = e.getBoundingClientRect();
        return { shown: getComputedStyle(e).display !== 'none' && b.height > 0, target: e.classList.contains('ms-row-target'),
                 inView: b.top >= bar.top - 0.5 && b.top < bar.bottom - 20 };
      };
      return { open: !panel.hidden, lift: row('ms-lift-row'), sup: row('ms-support-row'), slice: row('ms-slice-row') };
    });
    const msClose = () => page.evaluate(() => { if (NSO_MICROSCOPE.isOpen()) NSO_MICROSCOPE.close(); });
    c = await clickFace(page, '#btn-microscope');
    await page.waitForTimeout(300);
    const g1 = await gs();
    check('G-SCOPE opens G-scope on the plate', c.ok && g1.open && g1.lift.shown, JSON.stringify({ open: g1.open }));
    await page.evaluate(() => document.getElementById('btn-microscope').click());   // its own toggle shuts it
    const g1b = await page.evaluate(() => NSO_MICROSCOPE.isOpen());
    check('...and G-SCOPE shuts it again', g1b === false, String(g1b));
    await msClose();
    c = await clickFace(page, '#btn-shell-lift');
    await page.waitForTimeout(300);
    const gl = await gs();
    const others = ['sup', 'slice'].filter(k => gl[k].target);
    check('LIFT opens G-scope with its Lift row shown, marked and scrolled into view',
      c.ok && gl.open && gl.lift.shown && gl.lift.target && gl.lift.inView && others.length === 0,
      JSON.stringify({ open: gl.open, row: gl.lift, others }));
    await page.evaluate(() => document.getElementById('btn-shell-lift').click());
    check('...a second click leaves G-scope open', await page.evaluate(() => NSO_MICROSCOPE.isOpen()), '');
    // Supports and Slice settings stay where they were: G-scope's own rows.
    check('Supports and Slice settings are reached in G-scope, as before', gl.sup.shown && gl.slice.shown,
      JSON.stringify({ supports: gl.sup.shown, slice: gl.slice.shown }));
    await msClose();
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. nothing the shell had is unreachable ===');
  {
    await page.evaluate(() => { selectPlaced(0); });
    const retired = Object.keys(RETIRED);
    const live = BEFORE.filter(id => !retired.includes(id));
    // Group by the chain of drop-downs over each control, outermost first.
    const chains = await page.evaluate((ids) => ids.map(id => {
      const e = document.getElementById(id);
      if (!e) return { id, missing: true };
      const chain = [];
      for (let n = e.parentElement; n; n = n.parentElement) if (n.tagName === 'DETAILS') chain.unshift(n.id ? '#' + n.id : null);
      return { id, chain, details: e.tagName === 'DETAILS' };
    }), live);
    const missing = chains.filter(c => c.missing).map(c => c.id);
    const anon = chains.filter(c => !c.missing && c.chain.some(s => !s)).map(c => c.id);
    check('every control from before v2 still exists (by id)', missing.length === 0,
      missing.join(', ') || live.length + ' controls; retired: ' + retired.join(', '));
    const groups = new Map();
    chains.filter(c => !c.missing && !c.chain.some(s => !s)).forEach(c => {
      const k = c.chain.join(' ');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    });
    // Wheel and Stock carry no id: reach them by class.
    const anonChains = await page.evaluate((ids) => ids.map(id => {
      const e = document.getElementById(id);
      const chain = [];
      for (let n = e.parentElement; n; n = n.parentElement) {
        if (n.tagName !== 'DETAILS') continue;
        chain.unshift(n.id ? '#' + n.id : '#' + n.parentElement.closest('details').id + ' .' + [...n.classList].find(c => /-menu$/.test(c) && c !== 'vp-menu'));
      }
      return { id, chain, details: e.tagName === 'DETAILS' };
    }), anon);
    anonChains.forEach(c => {
      const k = c.chain.join(' | ');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    });

    const unreachable = [], ownState = [];
    for (const [, list] of groups) {
      const chain = list[0].chain;
      await shutAll(page);
      let path = true;
      for (const d of chain) {
        const sum = d + ' > summary';
        const r = await clickFace(page, sum);
        const open = await page.evaluate((d) => document.querySelector(d).open, d);
        if (!r.ok || !open) { path = false; list.forEach(c => unreachable.push(c.id + ' (at ' + d + ': ' + (r.why || 'did not open') + ')')); break; }
      }
      if (!path) continue;
      const res = await page.evaluate(([list, via]) => list.map(c => {
        let e = document.getElementById(c.id);
        if (c.details) e = e.querySelector(':scope > summary');
        if (via[c.id]) return { id: c.id, ok: !!document.getElementById(via[c.id]), how: 'opened by #' + via[c.id] };
        // Hidden by its own state (a [hidden] row, a hidden-quiet field, a
        // panel that opens on its own button)? Walk up to the panel.
        const panel = e.closest('.vp-menu-body') || e.closest('.vp-shell-row, .vp-shell-col, .viewport-section');
        for (let n = e; n && n !== panel.parentElement; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (n.hidden || cs.display === 'none' || cs.visibility === 'hidden') {
            return { id: c.id, ok: true, own: true, how: 'hidden by its own state (' + (n.id || n.className || n.tagName) + ')' };
          }
        }
        // Scroll it into its panel's view, then hit-test its middle.
        e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        window.scrollTo(0, 0);
        const b = e.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return { id: c.id, ok: false, how: 'no box' };
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const lab = e.closest('label') || (e.id && document.querySelector('label[for="' + e.id + '"]'));
        const ok = !!hit && (hit === e || e.contains(hit) || (lab && (hit === lab || lab.contains(hit))));
        return { id: c.id, ok, how: ok ? 'clickable' : 'covered by ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing') };
      }), [list, FILE_INPUT_VIA]);
      res.forEach(r => {
        if (!r.ok) unreachable.push(r.id + ' (' + r.how + ')');
        else if (r.own && !OWN_STATE[r.id]) unreachable.push(r.id + ' (' + r.how + ', not a state it has)');
        else if (r.own) ownState.push(r.id);
      });
    }
    await shutAll(page);
    check('each is reached by clicking the drop-downs over it open, then hit-testable (or hidden by its own state)',
      unreachable.length === 0, unreachable.join('; ') || (live.length - ownState.length) + ' clickable, ' +
      ownState.length + ' hidden by their own state');
    if (ownState.length) console.log('       hidden by their own state, their drop-downs reached: ' + ownState.join(', '));
    const kept = await page.evaluate((r) => Object.entries(r).map(([gone, by]) => by.filter(id => !document.getElementById(id))).flat(), RETIRED);
    check('the retired Finish wrapper\'s job is done by its six column buttons', kept.length === 0,
      kept.join(', ') || RETIRED['menu-finish'].join(', '));
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the narrow window (900 px and under) ===');
  for (const h of [820, 720]) {
    await page.setViewportSize({ width: 900, height: h });
    await page.waitForTimeout(200);
    const r = await page.evaluate((ids) => {
      const FACE = id => {
        const e = document.getElementById(id);
        return e && e.tagName === 'DETAILS' ? e.querySelector(':scope > summary') : e;
      };
      const v = document.querySelector('.viewport-section').getBoundingClientRect();
      const blocked = [], overlap = [];
      let prev = null;
      ids.forEach(id => {
        const f = FACE(id), b = f.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!hit || !(hit === f || f.contains(hit)) || b.bottom > innerHeight) blocked.push(id);
        if (prev && f.closest('.vp-shell-col') && !f.closest('.vp-shell-view') && b.top < prev.bottom - 0.5) overlap.push(id);
        prev = b;
      });
      return { vBottom: v.bottom, H: innerHeight, vW: v.width, W: innerWidth, blocked, overlap };
    }, GROUPS.flat().map(([id]) => id).concat(['btn-undo', 'btn-delete-placed', 'menu-export', 'menu-plates']));
    check('at 900x' + h + ' the viewport fills the window and every column slab, Undo, Remove, Export and Plate can be clicked',
      Math.abs(r.vBottom - r.H) < 0.5 && Math.abs(r.vW - r.W) < 0.5 && r.blocked.length === 0 && r.overlap.length === 0,
      JSON.stringify(r));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('SHELL V2 FAIL', e); process.exit(1); });
