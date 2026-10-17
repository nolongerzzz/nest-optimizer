#!/usr/bin/env node
/* Shell v3: which buttons exist, where they sit, and what each opens.

   UI only - a regrouping. Every control keeps its id, handler, tooltip and
   behaviour; only where it opens from changed.

   The top row, left to right: Import, Measure, Move, Rotate, Tip, Align,
   Gen+, Lock position, Lock plate, then at the right Undo, Remove, Export,
   and the Plate & pieces panel glued to the top-right corner. Under Remove
   sits Clear plate, under Export Optimize. The panel holds the old Plate
   menu's Plate and Pieces bodies, pinned open: never a drop-down.

   The left column, Import sharing the corner: G-scope, Scale, Cut, Crop,
   Join, Seat, Supports, Add, Subtract | Shape, Paint, Surface & edges,
   Sculpt | Check & repair, on its own over the view row | X-ray (X),
   Eye (👁), ◎ pinned to the bottom.

   GATES
     1. Grid on at load.
     2. Every button exists with its label, in its place: the row's order,
        the two stacks, the pinned panel clear of Lock plate, Clear plate and
        Optimize, the column's groups, pitch and gaps; no label cut at
        1280 x 800; the column fits inside its viewport.
     3. Each drop-down opens what it should, in the ticket's order, at the
        one spot (the green box), one open at a time, and closing a card
        keeps the selection.
     4. The panel: always visible, never a drop-down, untouched by every
        drop-down and by leaving the tool; Clone and Snap work from it.
     5. Each plain button does what it did: the locks, Undo, Remove, Clear
        plate, Optimize, X-ray, Eye, ◎, G-scope, Lift (in Subtract) opening
        G-scope at its row, Measure (in its row drop-down), Check piece (in
        Check & repair), and the Findings card docks under the panel.
     6. Every control the shell had before v3 (listed below by id, from
        claude-wip 9f68c20) is still reachable: each drop-down on the way to
        it is clicked open at its own on-screen spot, and the control is then
        hit-testable - or hidden by its own state, which is reported.
     7. The narrow window: at 900 x 820 and 900 x 720 the viewport fills the
        window, the panel drops under the stacks, and every column slab,
        every row slab and every panel control can be clicked.
     8. The panel's pieces list updates live, and Plate: Custom shows W / D / H
        in it (last, because both re-lay the plate).

     node tools/nso_shell_v3_test.js       exit 0 = every gate held */

const path = require('path');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* ---------------------------------------------------------------- the ticket */
const ROW = [
  ['menu-import', 'IMPORT'], ['menu-measure', 'MEASURE'], ['menu-move', 'MOVE'], ['menu-rotate', 'ROTATE'],
  ['menu-tip', 'TIP'], ['menu-align', 'ALIGN'], ['menu-gen', 'GEN+'],
  ['btn-lock-pos', 'LOCK POSITION'], ['btn-plate-lock', 'LOCK PLATE']
];
const RIGHT = [['btn-undo', 'UNDO'], ['btn-delete-placed', 'REMOVE'], ['menu-export', 'EXPORT']];
// Second row, right-aligned under the buttons: [what, label, under what].
const UNDER = [['btn-clear-plate', 'CLEAR PLATE', 'btn-delete-placed'], ['btn-optimize', 'OPTIMIZE', 'menu-export']];
const PANEL = 'plate-panel';
const PANEL_HOLDS = ['plate-select', 'custom-w', 'custom-d', 'custom-h', 'plate-grid-show', 'chk-plate-grid-snap',
                     'model-list', 'clone-count', 'btn-clone'];
const GROUPS = [
  [['btn-microscope', 'G-SCOPE'], ['menu-scale', 'SCALE'], ['menu-cut', 'CUT'], ['menu-crop', 'CROP'],
   ['menu-connect', 'CONNECT'], ['menu-joins', 'JOIN'], ['menu-seat', 'SEAT'], ['menu-supports', 'SUPPORTS'], ['menu-add', 'ADD'],
   ['menu-bit', 'SUBTRACT']],
  [['menu-shape', 'SHAPE'], ['menu-paint', 'PAINT'], ['menu-surface', 'SURFACE & EDGES'], ['menu-sculpt', 'SCULPT']],
  [['menu-repair', 'CHECK & REPAIR']],
  [['btn-xray', 'X-RAY'], ['btn-watch', 'EYE'], ['btn-frame-view', '◎']]
];
/* The view group's faces are icons; X and the eye are named by their
   aria-labels, ◎ by itself. */
const ICON = { 'btn-xray': 'X', 'btn-watch': '\u{1F441}', 'btn-frame-view': '◎' };
// Gone from the shell as buttons. Their contents moved (RETIRED below);
// Lift is not gone - it is Subtract's Lift verb (btn-lift), not a slab.
const GONE = ['menu-bend', 'menu-plates', 'menu-pack', 'btn-shell-supports', 'btn-shell-slice'];
const NOT_SLABS = ['btn-lift'];
const ALL = ROW.concat(RIGHT, UNDER.map(([id, l]) => [id, l]), ...GROUPS);
const DROPDOWNS = ALL.map(([id]) => id).filter(id => id.startsWith('menu-'));

/* What each drop-down's panel holds, in the ticket's order (document order
   is checked for the lists marked ORDERED). An id lives in one place, so a
   control listed here has left wherever it was. */
const HOLDS = {
  'menu-import': ['btn-load-stl', 'btn-library', 'library-list'],
  'menu-measure': ['btn-measure', 'sel-measure-mode'],
  'menu-move': ['chk-move-vertical', 'btn-to-plate', 'btn-nudge-fwd', 'btn-nudge-back', 'btn-nudge-left', 'btn-nudge-right'],
  'menu-rotate': ['btn-rot-left', 'btn-rot-right', 'chk-rot-ring-turn', 'chk-rot-ring-fb', 'chk-rot-ring-ss'],
  'menu-tip': ['btn-flip', 'btn-tip', 'btn-flip-over', 'btn-tip-face', 'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn'],
  'menu-align': ['btn-join-align', 'btn-join-cx', 'btn-join-cz', 'btn-center-lock', 'btn-center-lock-pick', 'center-lock-ref'],
  'menu-gen': ['.vp-wheel-menu', '.vp-stock-menu', 'btn-stock-make', 'btn-stock-attach', 'menu-relief', 'btn-relief-pick',
               'menu-photo', 'btn-photoset-pick', 'btn-photoset-report', 'btn-photoset-clear'],
  'menu-export': ['export-format', 'btn-export-model', 'btn-library-save', 'btn-export-stl', 'btn-delete-model'],
  'menu-scale': ['scale-card', 'scale-factor', 'scale-target', 'btn-scale-fit'],
  'menu-cut': ['edit-card', 'cut-miter-dial', 'cut-slider', 'cut-mm', 'btn-cut'],
  // CROP: the Shape row, one readout, CROP, Cancel (Detach moved to Subtract, Reattach to Join)
  'menu-crop': ['crop-card', 'crop-shape-row', 'btn-crop-shape-box', 'btn-crop-shape-cylinder', 'btn-crop-shape-sphere',
                'btn-crop-shape-piece', 'btn-crop-shape-outline', 'crop-readout', 'btn-crop', 'btn-crop-cancel'],
  'menu-joins': ['menu-join', 'btn-join-start', 'join-slot-a', 'join-slot-b', 'join-slot-c', 'btn-join', 'btn-join-clear',
                 'menu-abc', 'triple-mode', 'btn-join-triple', 'btn-reattach'],
  'menu-seat': ['btn-seat-support', 'seat-gap', 'btn-seat-here', 'chk-oversize-washer', 'btn-seat-flush', 'btn-flip-port', 'btn-seat-grid'],
  'menu-supports': ['supports-card', 'btn-sup-all', 'btn-sup-none', 'btn-sup-paint', 'sel-sup-paint', 'sup-style', 'sup-size',
                    'sup-rest', 'btn-sup-remove'],
  // SHAPE: Smooth · Bend · Flare · Roll · Neck (Tube edge's three verbs)
  'menu-shape': ['btn-smooth', 'btn-bend', 'btn-tube-edge', 'bend-panel', 'te-panel', 'sel-te-verb'],
  // ADD: Fill/Densify · Foam · Thicken out · Thicken in (shared mm) · Extend · Bridge
  'menu-add': ['btn-fill', 'btn-foam', 'foam-panel', 'btn-thicken-out', 'inp-thicken-mm', 'btn-thicken-in',
               'btn-extend', 'inp-extend-mm', 'btn-bridge', 'bridge-panel'],
  // SUBTRACT: Subtract B from A · Extract bit · Carve · Hollow · Hollow to safe min · Lift
  'menu-bit': ['btn-subtract', 'btn-extract-bit', 'btn-carve', 'carve-blade', 'carve-depth', 'btn-hollow', 'inp-hollow-mm',
               'btn-hollow-safe', 'btn-lift', 'lift-panel', 'btn-detach'],
  'menu-paint': ['btn-mask-select', 'btn-mask-paint', 'btn-mask-clear', 'btn-mask-delete', 'sel-mask-delete', 'btn-extract-sel'],
  // SURFACE & EDGES: Soften (R, Full wrap, edge treatment) · Mirror · Skin face · Skin wrap · Skin patch · Trace raster · Texture
  'menu-surface': ['inp-soften-r', 'chk-full-wrap', 'btn-soften', 'sel-edge-treat', 'btn-mirror', 'inp-mirror-plane',
                   'btn-skin-face', 'btn-skin-wrap', 'btn-skin-patch', 'btn-trace-raster', 'btn-texture'],
  // SCULPT: the Brush (Carve / Emboss / Smooth here); Carve the tool is in Subtract
  'menu-sculpt': ['btn-brush', 'sel-brush-mode', 'inp-brush-size', 'inp-brush-intensity', 'chk-brush-hard'],
  // CHECK & REPAIR: Check piece · Cap open faces · Repair · Seal · Non-solid · Solidify
  'menu-repair': ['btn-check-defects', 'btn-cap-open', 'chk-seal-repair', 'btn-seal', 'chk-non-solid', 'btn-solidify']
};
const ORDERED = ['menu-shape', 'menu-add', 'menu-bit', 'menu-surface', 'menu-repair'];
/* Edge treatment offers exactly these; Tube edge's verbs are Flare, Roll, Neck. */
const OPTIONS = { 'sel-edge-treat': ['fillet', 'chamfer', 'corners', 'cornersedges'], 'sel-te-verb': ['flare', 'roll', 'neck'],
                  'sel-brush-mode': ['carve', 'emboss', 'smooth'], 'sel-measure-mode': ['span', 'edge'],
                  'plate-grid-show': ['auto', 'on', 'off'] };

/* Every control in the shell on claude-wip before v3 (9f68c20): each
   button, input, select, <details> and slider with an id in the top bar
   overlay, and the Move slider. */
const BEFORE = ['menu-import', 'file-input', 'btn-load-stl', 'btn-library', 'menu-move', 'chk-move-vertical', 'btn-to-plate',
  'btn-nudge-fwd', 'btn-nudge-back', 'btn-nudge-left', 'btn-nudge-right', 'menu-rotate', 'btn-rot-left', 'btn-rot-right',
  'chk-rot-ring-turn', 'chk-rot-ring-fb', 'chk-rot-ring-ss', 'menu-tip', 'btn-flip', 'btn-tip', 'btn-flip-over', 'btn-tip-face',
  'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn', 'menu-align', 'btn-join-align', 'btn-join-cx', 'btn-join-cz',
  'btn-center-lock', 'btn-center-lock-pick', 'center-lock-ref', 'menu-gen', 'inp-wheel-height', 'inp-wheel-radius',
  'inp-wheel-wall', 'inp-wheel-nozzle', 'btn-wheel-ball', 'btn-wheel-open', 'inp-wheel-depth', 'inp-wheel-pull-z',
  'inp-wheel-pull-dr', 'btn-wheel-pull', 'btn-wheel-trim', 'inp-wheel-trim-z', 'btn-wheel-rim', 'inp-wheel-rim-mm',
  'sel-stock-shape', 'inp-stock-height', 'inp-stock-radius', 'inp-stock-wall', 'inp-stock-nozzle', 'inp-stock-waste',
  'inp-stock-prop', 'chk-stock-match', 'chk-stock-oversize', 'btn-stock-make', 'btn-stock-attach', 'menu-relief', 'relief-file',
  'btn-relief-pick', 'inp-relief-width', 'inp-relief-base', 'inp-relief-relief', 'inp-relief-detail', 'sel-relief-levels',
  'chk-relief-bright', 'btn-relief-make', 'btn-relief-undo', 'menu-photo', 'photoset-input', 'btn-photoset-pick',
  'btn-photoset-report', 'btn-photoset-clear', 'btn-lock-pos', 'btn-plate-lock', 'btn-undo', 'btn-delete-placed', 'menu-export',
  'export-format', 'cooling-profile', 'btn-export-model', 'btn-library-save', 'btn-export-stl', 'btn-delete-model',
  'menu-plates', 'menu-plate', 'plate-select', 'custom-w', 'custom-d', 'custom-h', 'plate-grid-show', 'chk-plate-grid-snap',
  'menu-pieces', 'clone-count', 'btn-clone', 'menu-pack', 'btn-optimize', 'btn-clear-plate', 'menu-scale', 'btn-scale-unit-mm',
  'btn-scale-unit-in', 'scale-length', 'btn-scale-length', 'scale-width', 'btn-scale-width', 'scale-height', 'btn-scale-height',
  'scale-ring-outer', 'btn-scale-ring-outer', 'scale-ring-wall', 'btn-scale-ring-wall', 'scale-rod-diameter',
  'btn-scale-rod-diameter', 'scale-offset', 'btn-scale-offset', 'scale-factor', 'btn-scale-factor', 'scale-target',
  'btn-scale-dim', 'btn-scale-fit', 'menu-cut', 'cut-miter-dial', 'cut-miter-deg', 'btn-cut-square', 'cut-slider',
  'btn-cut-nudge-m', 'cut-mm', 'btn-cut-nudge-p', 'btn-cut', 'btn-cut-right-side-out', 'menu-crop', 'edit-axis',
  /* The Crop card's axis buttons, box fields, Lift and Move controls are gone: one tool, a shape dragged to
     size (docs/CROP.md says where each job went). The ids that stay are the card's own, and Detach flange and
     Reattach, which moved to the Subtract and Join cards under the same ids. */
  'btn-crop', 'btn-detach', 'btn-reattach', 'menu-joins', 'menu-join', 'btn-join-start', 'join-slot-a', 'join-slot-b',
  'join-slot-c', 'btn-join', 'btn-join-clear', 'menu-abc', 'triple-mode', 'triple-gap-ab', 'triple-gap-bc', 'btn-join-triple',
  'btn-lift', 'menu-seat', 'btn-seat-support', 'seat-gap', 'btn-seat-here', 'chk-oversize-washer', 'oversize-gap',
  'btn-seat-flush', 'btn-flip-port', 'btn-seat-grid', 'menu-supports', 'btn-sup-all', 'btn-sup-none', 'btn-sup-paint',
  'sel-sup-paint', 'sup-style', 'sup-size', 'sup-rest', 'btn-sup-remove', 'menu-bit', 'btn-subtract', 'btn-extract-bit',
  'menu-shape', 'inp-soften-r', 'chk-full-wrap', 'btn-soften', 'sel-edge-treat', 'btn-smooth', 'btn-extend', 'inp-extend-mm',
  'btn-mirror', 'inp-mirror-plane', 'btn-bridge', 'inp-bridge-dia', 'inp-bridge-thick', 'btn-bridge-go', 'btn-bridge-cancel',
  'btn-thicken-out', 'inp-thicken-mm', 'btn-thicken-in', 'btn-hollow', 'inp-hollow-mm', 'btn-hollow-safe', 'btn-fill',
  'btn-foam', 'inp-foam-level', 'btn-foam-all', 'btn-foam-set', 'btn-foam-cancel', 'menu-bend', 'btn-bend', 'btn-tube-edge',
  'inp-bend-where', 'inp-bend-angle', 'inp-bend-radius', 'sel-bend-toward', 'inp-bend-roll', 'btn-bend-go', 'btn-bend-cancel',
  'sel-te-verb', 'sel-te-dir', 'inp-te-length', 'inp-te-angle', 'inp-te-dr', 'sel-te-profile', 'inp-te-radius',
  'inp-te-roll-angle', 'inp-te-neck-length', 'inp-te-neck-dr', 'sel-te-neck-profile', 'btn-te-go', 'btn-te-cancel',
  'menu-paint', 'btn-mask-select', 'btn-mask-paint', 'btn-mask-clear', 'btn-mask-delete', 'sel-mask-delete', 'btn-extract-sel',
  'menu-surface', 'btn-skin-face', 'skin-pattern', 'btn-skin-wrap', 'chk-skin-free', 'skin-layer2', 'btn-skin-patch',
  'skin-patch-variant', 'btn-trace-raster', 'raster-file', 'raster-size', 'raster-threshold', 'raster-line-width',
  'raster-line-height', 'raster-invert', 'btn-texture', 'sel-texture-pattern', 'inp-texture-pitch', 'inp-texture-depth',
  'menu-sculpt', 'btn-brush', 'sel-brush-mode', 'inp-brush-size', 'inp-brush-intensity', 'chk-brush-hard', 'btn-carve',
  'carve-blade', 'carve-depth', 'carve-a', 'carve-b', 'carve-roll', 'menu-measure', 'btn-measure', 'sel-measure-mode',
  'btn-check-defects', 'menu-repair', 'btn-cap-open', 'chk-seal-repair', 'btn-seal', 'chk-non-solid', 'btn-solidify',
  'btn-microscope', 'ms-input', 'btn-xray', 'btn-watch', 'btn-frame-view', 'move-vert-slider'];
/* The ids that went: wrappers whose job is now done by what is listed. */
const RETIRED = {
  'menu-plates': ['plate-panel', 'btn-clear-plate', 'btn-optimize'],   // the PLATE button: pinned panel + two slabs
  'menu-pack': ['btn-optimize'],                                      // Pack's one button is the OPTIMIZE slab
  'menu-bend': ['menu-shape'],                                        // the BEND card: Bend and Tube edge, in Shape
  // #187: the Scale card's fields are live, no Set - each Set button's job
  // is its own field's
  'btn-scale-length': ['scale-length'], 'btn-scale-width': ['scale-width'], 'btn-scale-height': ['scale-height'],
  'btn-scale-ring-outer': ['scale-ring-outer'], 'btn-scale-ring-wall': ['scale-ring-wall'],
  'btn-scale-rod-diameter': ['scale-rod-diameter'], 'btn-scale-offset': ['scale-offset'],
  'btn-scale-factor': ['scale-factor'], 'btn-scale-dim': ['scale-target']
};
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
  'sel-te-verb': 'Tube edge on', 'sel-te-dir': 'Tube edge on', 'inp-te-length': 'Tube edge on', 'inp-te-angle': 'Tube edge on',
  'inp-te-dr': 'Tube edge on', 'sel-te-profile': 'Tube edge on', 'inp-te-radius': 'Tube edge on, Roll',
  'inp-te-roll-angle': 'Tube edge on, Roll', 'inp-te-neck-length': 'Tube edge on, Neck', 'inp-te-neck-dr': 'Tube edge on, Neck',
  'sel-te-neck-profile': 'Tube edge on, Neck', 'btn-te-go': 'Tube edge on', 'btn-te-cancel': 'Tube edge on',
  'inp-bridge-dia': 'Bridge on, point to point', 'inp-bridge-thick': 'Bridge on, edge to edge',
  'btn-bridge-go': 'Bridge on', 'btn-bridge-cancel': 'Bridge on',
  'scale-target': 'the longest edge, when a named section already shows the same number',
  'btn-scale-dim': 'ditto',
  'carve-b': 'a blade with a length', 'inp-stock-prop': 'a shape with proportions',
  // #194: the Supports card is a verb with a state - Remove all once it has
  // built, Remove once a built support is picked
  'btn-sup-none': 'Supports card BUILT', 'btn-sup-remove': 'Supports card BUILT, a support picked'
};
/* File inputs are never on screen: their button opens them. */
const FILE_INPUT_VIA = { 'file-input': 'btn-load-stl', 'photoset-input': 'btn-photoset-pick', 'relief-file': 'btn-relief-pick',
                         'raster-file': 'btn-trace-raster', 'ms-input': 'btn-microscope' };

/* ------------------------------------------------------------------ helpers */
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9+&◎\- ]/g, ' ').replace(/\s+/g, ' ').trim();

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

/* The panel's own box, and whether each of its controls is on screen and
   hit-testable where it is (hidden-by-state ones reported apart). */
const panelState = (page) => page.evaluate(([id, holds]) => {
  const p = document.getElementById(id);
  const b = p.getBoundingClientRect();
  const cs = getComputedStyle(p);
  const hit = [], hidden = [], blocked = [];
  holds.forEach(h => {
    const e = document.getElementById(h);
    if (!e || !p.contains(e)) { blocked.push(h + ' (not in the panel)'); return; }
    for (let n = e; n && n !== p; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (n.hidden || s.display === 'none' || s.visibility === 'hidden') { hidden.push(h); return; }
    }
    if (h === 'model-list' && !e.children.length) { hidden.push(h + ' (empty)'); return; }
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10));
    const lab = e.id && document.querySelector('label[for="' + e.id + '"]');
    if (r.width > 0 && r.height > 0 && t && (t === e || e.contains(t) || (lab && lab.contains(t)) ||
        (e.closest('label') && e.closest('label').contains(t)))) hit.push(h);
    else blocked.push(h + ' (covered by ' + (t ? (t.id || t.className || t.tagName) : 'nothing') + ')');
  });
  return { tag: p.tagName, x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height,
           shown: !p.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && b.height > 0,
           inDetails: !!p.closest('details'), hit, hidden, blocked };
}, [PANEL, PANEL_HOLDS]);

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
  await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { selectPlaced(0); });
  await page.waitForTimeout(100);
  const geo = await page.evaluate(([all, gone, notSlabs, panel]) => {
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
    out._marks = all.map(([id]) => (FACE(id) || {}).textContent || '').join('').match(/[▾▼⌄]/g) || [];
    out._gone = gone.filter(id => document.getElementById(id));
    // Not slabs: not a child of the row or the column, but inside a card.
    out._notSlabs = notSlabs.filter(id => {
      const e = document.getElementById(id);
      return !e || e.parentElement.closest('.vp-shell-row, .vp-shell-col') === e.parentElement ||
             !e.closest('.vp-menu-body');
    });
    const p = document.getElementById(panel);
    out._panel = p ? (() => { const b = p.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; })() : null;
    return out;
  }, [ALL, GONE, NOT_SLABS, PANEL]);
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
    check('no drop-down mark on any face', geo._marks.length === 0, geo._marks.length + ' found');
    check('Bend, Plate, Pack, Supports and Slice settings are not buttons any more', geo._gone.length === 0,
      geo._gone.join(', ') || GONE.join(', '));
    check('Lift is a button in a card, not a column slab', geo._notSlabs.length === 0, geo._notSlabs.join(', ') || 'in Subtract');
    const cut = ALL.filter(([id]) => geo[id] && geo[id].cut).map(([id]) => id);
    check('no label is cut off or spills out of its slab at 1280 x 800', cut.length === 0, cut.join(', ') || 'none');

    const row = ROW.concat(RIGHT).map(([id]) => Object.assign({ id }, geo[id]));
    const top = row[0].y;
    check('the top row is one line, in the ticket\'s order, left to right, no two slabs overlapping',
      row.every(b => b.inRow && Math.abs(b.y - top) < 0.5) && row.every((b, i) => i === 0 || b.x > row[i - 1].r - 0.5),
      row.map(b => b.id.replace(/^(menu|btn)-/, '') + '@' + Math.round(b.x)).join(' '));
    const undo = geo['btn-undo'], lockPlate = geo['btn-plate-lock'], exp = geo['menu-export'], pan = geo._panel;
    check('Undo, Remove and Export sit at the right of the row, apart from Lock plate',
      undo.x - lockPlate.r > 6 && pan && exp.r < pan.x,
      'lock plate ends ' + Math.round(lockPlate.r) + ', undo at ' + Math.round(undo.x) + ', export ends ' + Math.round(exp.r));
    const under = UNDER.map(([id, , over]) => {
      const u = geo[id], o = geo[over];
      return { id, ok: Math.abs(u.x - o.x) < 0.5 && Math.abs(u.w - o.w) < 0.5 && u.y > o.b && u.y - o.b < 8 && Math.abs(u.h - o.h) < 0.5,
               s: id + ' ' + [u.x, u.y, u.w].map(Math.round) + ' under ' + over + ' ' + [o.x, o.b, o.w].map(Math.round) };
    });
    check('Clear plate is directly under Remove and Optimize directly under Export, each the same width and height',
      under.every(u => u.ok), under.map(u => u.s).join('; '));
    const clr = geo['btn-clear-plate'], opt = geo['btn-optimize'];
    check('the Plate & pieces panel is glued to the top-right corner, level with the row',
      pan && Math.abs(pan.y - top) < 0.5 && Math.abs(pan.r - (geo._vp.right - 8)) < 1,
      pan ? 'panel ' + [pan.x, pan.y, pan.r, pan.b].map(Math.round) + ', row top ' + Math.round(top) + ', viewport right ' + geo._vp.right : 'missing');
    check('...and clear of Lock plate, Export, Clear plate and Optimize',
      pan && pan.x > lockPlate.r && pan.x > exp.r && pan.x > clr.r && pan.x > opt.r,
      pan ? 'panel left ' + Math.round(pan.x) + '; lock plate ends ' + Math.round(lockPlate.r) + ', export ' + Math.round(exp.r) +
            ', clear plate ' + Math.round(clr.r) + ', optimize ' + Math.round(opt.r) : '');
    check('...compact: no wider than 240 px and well under the viewport\'s height',
      pan && pan.w <= 240 && pan.b - geo._vp.top < geo._vp.h / 2, pan ? Math.round(pan.w) + ' x ' + Math.round(pan.h) : '');

    const imp = geo['menu-import'];
    const col = GROUPS.map(g => g.map(([id]) => Object.assign({ id }, geo[id])));
    const first = col[0][0];
    check('the column starts under Import with G-scope, at its x', Math.abs(first.x - imp.x) < 0.5 && first.y > imp.b &&
      first.y - imp.b < 8 && first.id === 'btn-microscope',
      'import ' + Math.round(imp.x) + ',' + Math.round(imp.b) + ' ' + first.id + ' ' + Math.round(first.x) + ',' + Math.round(first.y));
    const stacked = col.slice(0, 3).every(g => g.every(b => b.inCol && Math.abs(b.x - imp.x) < 0.5 && Math.abs(b.w - imp.w) < 0.5));
    check('groups 1-3 are one stack under Import, Import\'s width', stacked,
      col.slice(0, 3).map(g => g.map(b => Math.round(b.x) + '/' + Math.round(b.w)).join(' ')).join(' | '));
    const pitches = [];
    col.slice(0, 2).forEach(g => g.forEach((b, i) => { if (i) pitches.push(+(b.y - g[i - 1].y).toFixed(2)); }));
    check('a 36 px pitch inside each group', pitches.every(p => Math.abs(p - 36) < 0.5), pitches.join(' '));
    const gap12 = +(col[1][0].y - col[0][col[0].length - 1].b).toFixed(2);
    check('a 12 px gap between the make/edit and surface groups', Math.abs(gap12 - 12) < 0.5, String(gap12));
    const view = col[3], repair = col[2][0], lastAbove = col[1][col[1].length - 1];
    check('the view group (X, eye, ◎) is one row pinned to the bottom of the column',
      view.every(b => b.inCol && Math.abs(b.b - (geo._vp.bottom - 8)) < 0.5 && Math.abs(b.y - view[0].y) < 0.5) &&
      Math.abs(view[0].x - imp.x) < 0.5 && Math.abs(view[2].r - imp.r) < 0.5,
      view.map(b => b.id + '@' + Math.round(b.x) + ',' + Math.round(b.y) + '/' + Math.round(b.w)).join(' ') + '; viewport bottom ' + geo._vp.bottom);
    check('Check & repair is on its own, directly above the view row (a group gap), well below Sculpt',
      Math.abs(view[0].y - repair.b - 12) < 0.5 && repair.y - lastAbove.b >= 12 - 0.5,
      'sculpt ends ' + Math.round(lastAbove.b) + ', check & repair ' + Math.round(repair.y) + '..' + Math.round(repair.b) +
      ', view row at ' + Math.round(view[0].y));
    const colBottom = Math.max(...view.map(b => b.b));
    check('the column fits inside the viewport at 1280 x 800',
      colBottom <= geo._vp.bottom && first.y >= geo._vp.top && lastAbove.b < repair.y,
      'column ' + Math.round(first.y - geo._vp.top) + '..' + Math.round(colBottom - geo._vp.top) + ' px of a ' + geo._vp.h + ' px viewport');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. each drop-down opens what it should, in the green box, one at a time ===');
  {
    const vp = geo._vp;
    const spots = [], holdFails = [], orderFails = [], counts = [], keeps = [];
    for (const id of DROPDOWNS) {
      await shutAll(page);
      const before = await page.evaluate(() => ({ i: state.selectedIndex, id: state.editId }));
      const c = await clickFace(page, '#' + id + ' > summary');
      if (!c.ok) { holdFails.push(id + ' could not be clicked: ' + c.why); continue; }
      await page.waitForTimeout(150);
      const r = await page.evaluate(([id, holds]) => {
        const d = document.getElementById(id);
        const body = d.querySelector(':scope > .vp-menu-body');
        const b = body.getBoundingClientRect();
        const el = sel => sel[0] === '.' ? body.querySelector(sel) : document.getElementById(sel);
        const has = sel => { const e = el(sel); return !!e && body.contains(e); };
        const present = holds.filter(has);
        let ordered = true;
        for (let i = 1; i < present.length; i++) {
          if (!(el(present[i - 1]).compareDocumentPosition(el(present[i])) & Node.DOCUMENT_POSITION_FOLLOWING)) ordered = false;
        }
        return { open: d.open, x: b.left, y: b.top, w: b.width, ordered,
                 nOpen: [...document.querySelectorAll('.vp-shell-menu[open]')].map(x => x.id),
                 missing: holds.filter(s => !has(s)) };
      }, [id, HOLDS[id] || []]);
      if (!r.open) holdFails.push(id + ' did not open');
      if (r.missing.length) holdFails.push(id + ' lacks ' + r.missing.join(','));
      if (ORDERED.includes(id) && !r.ordered) orderFails.push(id);
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
    check('Shape, Add, Subtract, Surface & edges and Check & repair hold them in the ticket\'s order', orderFails.length === 0,
      orderFails.join(', ') || ORDERED.join(', '));
    const opts = await page.evaluate((o) => Object.entries(o).filter(([id, want]) => {
      const got = [...document.getElementById(id).options].map(x => x.value).sort().join();
      return got !== want.slice().sort().join();
    }).map(([id]) => id), OPTIONS);
    check('the choices ride along unchanged (Round / Bevel / Corners / Corners+edges; Flare / Roll / Neck; Carve / Emboss / Smooth here; Two points / Edge; auto / on / off)',
      opts.length === 0, opts.join(', ') || Object.keys(OPTIONS).join(', '));
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
    // The leave-tool gesture (double-click on the plate) shuts a drop-down and its open member.
    await shutAll(page);
    await clickFace(page, '#menu-gen > summary');
    await clickFace(page, '#menu-photo > summary');
    const left = await page.evaluate(() => ({ left: leaveTool(),
      open: [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id || d.className) }));
    check('leaving the tool (double-click on the plate) shuts Gen+ and the Photo open in it',
      left.open.length === 0 && left.left.includes('menu-gen') && left.left.includes('menu-photo'), JSON.stringify(left));
    // Bend and Tube edge, from Shape, open their panels.
    for (const [btn, panel, cancel] of [['btn-bend', 'bend-panel', 'btn-bend-cancel'], ['btn-tube-edge', 'te-panel', 'btn-te-cancel']]) {
      await shutAll(page);
      await clickFace(page, '#menu-shape > summary');
      await clickFace(page, '#' + btn);
      const p = await page.evaluate((panel) => ({ panel: !document.getElementById(panel).hidden,
                                                 vis: document.getElementById(panel).getBoundingClientRect().height > 0 }), panel);
      await page.evaluate((c) => { const b = document.getElementById(c); if (b && b.getBoundingClientRect().height) b.click(); }, cancel);
      check(btn + ', opened from SHAPE, opens ' + panel, p.panel && p.vis, JSON.stringify(p));
    }
    await page.evaluate(() => { if (window.nsoHelpers) window.nsoHelpers.teardown('test'); });
    await shutAll(page);
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. Plate & pieces: pinned open, never a drop-down, live ===');
  {
    const p0 = await panelState(page);
    check('the panel is on screen with nothing clicked, and is not a drop-down (no <details> over it)',
      p0.shown && p0.tag !== 'DETAILS' && !p0.inDetails, JSON.stringify({ tag: p0.tag, shown: p0.shown, inDetails: p0.inDetails }));
    check('every Plate and Pieces control in it is hit-testable where it is (custom W / D / H hidden until Custom)',
      p0.blocked.length === 0 && p0.hidden.every(h => /^custom-/.test(h)),
      'clickable: ' + p0.hit.join(',') + (p0.hidden.length ? '; hidden: ' + p0.hidden.join(',') : '') +
      (p0.blocked.length ? '; BLOCKED: ' + p0.blocked.join(',') : ''));
    // Every drop-down opened in turn leaves the panel open and where it was.
    const moved = [];
    for (const id of DROPDOWNS) {
      await shutAll(page);
      await clickFace(page, '#' + id + ' > summary');
      const p = await panelState(page);
      if (!p.shown || Math.abs(p.x - p0.x) > 0.5 || Math.abs(p.y - p0.y) > 0.5) moved.push(id);
    }
    await shutAll(page);
    const lt = await page.evaluate(() => { leaveTool(); return null; });
    const pl = await panelState(page);
    check('no drop-down, and not leaving the tool, shuts or moves it', moved.length === 0 && pl.shown,
      moved.join(', ') || DROPDOWNS.length + ' drop-downs and leaveTool()');
    // Clone, from the panel.
    await page.evaluate(() => { selectPlaced(0); });
    const n0 = await page.evaluate(() => state.placed.length);
    const cl = await clickFace(page, '#btn-clone');
    await page.waitForTimeout(250);
    const n1 = await page.evaluate(() => state.placed.length);
    check('Clone in the panel clones the selected piece', cl.ok && n1 === n0 + 1, n0 + ' -> ' + n1 + (cl.ok ? '' : ' ' + cl.why));
    await page.evaluate(() => { undoLast(); selectPlaced(0); });
    await page.waitForTimeout(150);
    // Snap to grid, in the panel.
    const sn = await clickFace(page, '#chk-plate-grid-snap');
    const snap = await page.evaluate(() => document.getElementById('chk-plate-grid-snap').checked);
    await clickFace(page, '#chk-plate-grid-snap');
    check('Snap to grid toggles from the panel', sn.ok && snap === true, String(snap));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the plain buttons do what they did ===');
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
    /* Undo puts the placed piece back but not its entry in the pieces list
       (as on claude-wip before v3), so the checks below that read the piece
       start again from a fresh import. */
    await page.evaluate(() => { clearPlateOnly(); });
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(300);
    await page.evaluate(() => { selectPlaced(0); });

    // Measure, from its row drop-down: the button arms, the mode choice is there.
    await shutAll(page);
    await clickFace(page, '#menu-measure > summary');
    c = await clickFace(page, '#btn-measure');
    const ms1 = await page.evaluate(() => document.getElementById('btn-measure').getAttribute('aria-pressed'));
    await clickFace(page, '#btn-measure');
    const ms2 = await page.evaluate(() => document.getElementById('btn-measure').getAttribute('aria-pressed'));
    check('MEASURE opens Measure; its button arms and disarms', c.ok && ms1 === 'true' && ms2 !== 'true', ms1 + ' -> ' + ms2);
    await shutAll(page);

    // Check piece, from Check & repair: it runs the check and the Findings card docks under the panel.
    await page.evaluate(() => { selectPlaced(0); });
    await clickFace(page, '#menu-repair > summary');
    c = await clickFace(page, '#btn-check-defects');
    await page.waitForTimeout(500);
    const ck = await page.evaluate(() => {
      const f = document.getElementById('findings-card'), p = document.getElementById('plate-panel');
      const fb = f.getBoundingClientRect(), pb = p.getBoundingClientRect();
      return { pressed: document.getElementById('btn-check-defects').getAttribute('aria-pressed'), shown: !f.hidden,
               fTop: fb.top, pBottom: pb.bottom, fR: fb.right, pR: pb.right };
    });
    check('CHECK PIECE in Check & repair runs the check; Findings docks under the panel, not over it',
      c.ok && ck.pressed === 'true' && ck.shown && ck.fTop >= ck.pBottom, JSON.stringify(ck));
    await page.evaluate(() => { const x = document.getElementById('btn-findings-close'); if (x && x.getBoundingClientRect().height) x.click(); });
    await shutAll(page);

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
    check('◎ frames the view', c.ok && fv.cam.some((v, i) => Math.abs(v - cam0[i]) > 1), fv.status);

    // G-scope, then Lift (in Subtract): on the plate, not a way into G-scope.
    const gs = async () => page.evaluate(() => {
      const panel = document.getElementById('microscope');
      const e = document.getElementById('ms-lift-row'), b = e.getBoundingClientRect();
      return { open: !panel.hidden, features: { shown: getComputedStyle(e).display !== 'none' && b.height > 0 } };
    });
    const msClose = () => page.evaluate(() => { if (NSO_MICROSCOPE.isOpen()) NSO_MICROSCOPE.close(); });
    c = await clickFace(page, '#btn-microscope');
    await page.waitForTimeout(300);
    const g1 = await gs();
    check('G-SCOPE (column slot 2) opens G-scope on the plate', c.ok && g1.open && g1.features.shown, JSON.stringify({ open: g1.open }));
    await page.evaluate(() => document.getElementById('btn-microscope').click());   // its own toggle shuts it
    const g1b = await page.evaluate(() => NSO_MICROSCOPE.isOpen());
    check('...and G-SCOPE shuts it again', g1b === false, String(g1b));
    await msClose();
    await shutAll(page);
    await clickFace(page, '#menu-bit > summary');
    c = await clickFace(page, '#btn-lift');
    await page.waitForTimeout(300);
    const gl = await gs(), lit = await page.evaluate(() => ({ armed: NSO_LIFT_PLATE.isArmed(), panel: !document.getElementById('lift-panel').hidden }));
    check('LIFT, in SUBTRACT, arms Lift on the plate and its panel opens; G-scope stays shut',
      c.ok && lit.armed && lit.panel && !gl.open, JSON.stringify({ lit, open: gl.open, why: c.why }));
    await page.evaluate(() => document.getElementById('btn-lift').click());
    check('...a second click puts Lift away', await page.evaluate(() => !NSO_LIFT_PLATE.isArmed()), '');
    await shutAll(page);

    // Optimize, then Clear plate (last: it empties the plate).
    await page.evaluate(() => { selectPlaced(0); });
    const op0 = await page.evaluate(() => ({ dis: document.getElementById('btn-optimize').disabled, n: state.placed.length }));
    await page.evaluate(() => { setStatus('-'); });
    c = await clickFace(page, '#btn-optimize');
    await page.waitForTimeout(1500);
    const op1 = await page.evaluate(() => ({ n: state.placed.length, status: document.getElementById('status').textContent }));
    check('OPTIMIZE (the old Pack button) nests the pieces', !op0.dis && c.ok && op1.n >= 1 && op1.status !== '-',
      JSON.stringify({ before: op0, after: op1, why: c.why }));
    c = await clickFace(page, '#btn-clear-plate');
    await page.waitForTimeout(200);
    const cp = await page.evaluate(() => ({ placed: state.placed.length, models: state.models.length }));
    check('CLEAR PLATE takes every piece off the plate and keeps the loaded pieces', c.ok && cp.placed === 0 && cp.models >= 1,
      JSON.stringify(cp));
  }

  /* The capture report's drawer docks top right too: its heading and Close
     must not land under the pinned panel (at 1280 here, at 900 in 7). */
  const drawerClear = () => page.evaluate(() => {
    const d = document.getElementById('photoset-drawer');
    const was = d.hidden;
    d.hidden = false;
    const c = document.getElementById('btn-photoset-close').getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    const db = d.getBoundingClientRect(), p = document.getElementById('plate-panel').getBoundingClientRect();
    const col = document.querySelector('.vp-shell-col').getBoundingClientRect();
    const out = { close: !!hit && hit.id === 'btn-photoset-close', apart: db.right <= p.left || db.top >= p.bottom,
                  rightOfCol: db.left >= col.right, hit: hit ? (hit.id || hit.className) : null };
    d.hidden = was;
    return out;
  });
  {
    const d = await drawerClear();
    check('the capture report drawer clears the panel and the column; its Close can be clicked', d.close && d.apart && d.rightOfCol,
      JSON.stringify(d));
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. nothing the shell had is unreachable ===');
  {
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(300);
    await page.evaluate(() => { selectPlaced(0); });
    const retired = Object.keys(RETIRED);
    const live = BEFORE.filter(id => !retired.includes(id));
    const chains = await page.evaluate((ids) => ids.map(id => {
      const e = document.getElementById(id);
      if (!e) return { id, missing: true };
      const chain = [];
      for (let n = e.parentElement; n; n = n.parentElement) if (n.tagName === 'DETAILS') chain.unshift(n.id ? '#' + n.id : null);
      return { id, chain, details: e.tagName === 'DETAILS' };
    }), live);
    const missing = chains.filter(c => c.missing).map(c => c.id);
    const anon = chains.filter(c => !c.missing && c.chain.some(s => !s)).map(c => c.id);
    check('every control from before v3 still exists (by id)', missing.length === 0,
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
      let ok = true;
      for (const d of chain) {
        const r = await clickFace(page, d + ' > summary');
        const open = await page.evaluate((d) => document.querySelector(d).open, d);
        if (!r.ok || !open) { ok = false; list.forEach(c => unreachable.push(c.id + ' (at ' + d + ': ' + (r.why || 'did not open') + ')')); break; }
      }
      if (!ok) continue;
      const res = await page.evaluate(([list, via]) => list.map(c => {
        let e = document.getElementById(c.id);
        if (c.details) e = e.querySelector(':scope > summary');
        if (via[c.id]) return { id: c.id, ok: !!document.getElementById(via[c.id]), how: 'opened by #' + via[c.id] };
        // Hidden by its own state (a [hidden] row, a hidden-quiet field, a
        // panel that opens on its own button)? Walk up to the panel.
        const panel = e.closest('.vp-menu-body') || e.closest('.vp-plate-panel, .vp-shell-row, .vp-shell-col, .viewport-section');
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
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 10));
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
    check('each is reached by clicking the drop-downs over it open (none, for the pinned panel), then hit-testable (or hidden by its own state)',
      unreachable.length === 0, unreachable.join('; ') || (live.length - ownState.length) + ' clickable, ' +
      ownState.length + ' hidden by their own state');
    if (ownState.length) console.log('       hidden by their own state, their drop-downs reached: ' + ownState.join(', '));
    const kept = await page.evaluate((r) => Object.entries(r).map(([gone, by]) => by.filter(id => !document.getElementById(id))).flat(), RETIRED);
    check('each retired wrapper\'s job is done by what replaced it', kept.length === 0,
      kept.join(', ') || Object.entries(RETIRED).map(([g, by]) => g + ' -> ' + by.join('+')).join('; '));
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. the narrow window (900 px) ===');
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
      const p = document.getElementById('plate-panel').getBoundingClientRect();
      const stacks = ['btn-clear-plate', 'btn-optimize'].map(id => document.getElementById(id).getBoundingClientRect());
      return { vBottom: v.bottom, H: innerHeight, vW: v.width, W: innerWidth, blocked, overlap,
               panelBelow: stacks.every(s => p.top >= s.bottom), panelRight: Math.round(innerWidth - p.right) };
    }, GROUPS.flat().map(([id]) => id).concat(ROW.map(([id]) => id), RIGHT.map(([id]) => id), UNDER.map(([id]) => id)));
    const ps = await panelState(page);
    const dr = await drawerClear();
    check('at 900x' + h + ' the capture report drawer clears the panel; its Close can be clicked', dr.close && dr.apart && dr.rightOfCol,
      JSON.stringify(dr));
    check('at 900x' + h + ' the viewport fills the window, the panel sits under the stacks at the right edge, and every slab and panel control can be clicked',
      Math.abs(r.vBottom - r.H) < 0.5 && Math.abs(r.vW - r.W) < 0.5 && r.blocked.length === 0 && r.overlap.length === 0 &&
      r.panelBelow && r.panelRight === 8 && ps.blocked.length === 0,
      JSON.stringify(r) + (ps.blocked.length ? ' panel blocked: ' + ps.blocked.join(',') : ''));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. Plate & pieces, live (last: the x and a plate change re-lay the plate) ===');
  {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);
    // The pieces list follows the models live: a second piece, then its x.
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#plate-panel #model-list .model-item .name')].map(n => n.textContent));
    const r1 = await rows();
    await loadSTL(page, path.join(ROOT, 'fixtures', 'box-20mm.stl'));
    await page.waitForTimeout(300);
    const r2 = await rows();
    await page.evaluate(() => { const rm = document.querySelector('#model-list .model-item:last-child .remove'); if (rm) rm.click(); });
    await page.waitForTimeout(200);
    const r3 = await rows();
    const nm = await page.evaluate(() => state.models.length);
    check('the pieces list updates live: one row per piece loaded, one more after an import, one fewer after its x',
      r1.length === nm && nm >= 1 && r2.length === r1.length + 1 && r3.length === r1.length, JSON.stringify([r1, r2, r3]));
    // Custom plate (a plate change re-lays the plate) shows W / D / H in the panel, still clear of the row.
    await page.selectOption('#plate-select', 'custom');
    await page.waitForTimeout(150);
    const pc = await panelState(page);
    await page.selectOption('#plate-select', 'a1mini');
    await page.waitForTimeout(150);
    check('Plate: Custom shows W / D / H in the panel, each clickable', ['custom-w', 'custom-d', 'custom-h'].every(h => pc.hit.includes(h)),
      'hidden: ' + pc.hidden.join(',') + ' blocked: ' + pc.blocked.join(','));
  }

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('SHELL V3 FAIL', e); process.exit(1); });
