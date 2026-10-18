#!/usr/bin/env node
/* QA tour: drive the REAL page through every column card, every verb in it, the
   top row and G-scope, on three fixtures in turn, and say what happened.

     npm run qa:tour                      all three fixtures
     node tools/nso_qa_tour.js hinge      just one (hinge | box | large)
     node tools/nso_qa_tour.js --only Cut,Seat     just those cards / sections
     node tools/nso_qa_tour.js --serial   never run two fixtures at once
     node tools/nso_qa_tour.js --report   rewrite report.md from the last run
     node tools/nso_qa_tour.js --items 3,9  just those plan entries (merged into the last run)   --resume  carry on a run that died

   A SURVEY, not a gate: nothing here asserts, and the exit code is 0 unless the
   tour itself could not run. For each verb it opens the card with a real mouse,
   does the obvious thing (pick the piece, click the verb, click or drag on the
   piece, press Set), and records one of

     worked | refused: "<its words>" | error in console | froze > 10 s | no visible result

   with the seconds it took, a note and a screenshot. Output is tools/qa-out/:
   report.md (a list at the top of everything that froze, errored or did
   nothing; one table per fixture; the console errors verbatim) and the PNGs.
   None of it is committed.

   The three fixtures:
     hinge   fixtures/hinge_knuckle_box.stl                (small: 730 triangles)
     box     library/box_closed.stl through tools/nso_fixture_union.mjs
             (the cleaned box: the raw file has overlapping shells; medium)
     large   a 1.46M-triangle 3MF in tools/fixtures-local/ (git-ignored);
             skipped with a notice when it is not there.

   How it is built. The orchestrator (no flag) runs a fixture's plan in a WORKER
   process (--worker) and reads one JSON line per verb off its stdout. A verb
   that blocks the page for good is killed from outside - the worker's own
   watchdog when one call has been pending 60 s, the orchestrator's after a long
   silence - and the next worker carries on from the next verb. Every verb
   starts from a freshly reloaded page with its storage cleared (the app keeps
   units, Watch, export format in localStorage), the fixture loaded and picked
   with a click, the view zoomed to it, and the card open. Dialogs are answered
   OK, as a person would.

   What the numbers mean here.
   - Headless Chromium draws WebGL in software (SwiftShader). The large
     fixture costs about a second a frame, so on it every mouse event is
     seconds, its cards are opened with the page's own click(), and its drags
     are coarser. Its times are this box's, not a GPU's.
   - "froze > 10 s" is the main thread blocked 10 s or more (longest long task,
     or longest gap between ticks of a 50 ms timer, taken over the verb); the
     large fixture's idle baseline is a gap of a couple of seconds.
   - "refused" is the status line in its error style, red text in the card, or
     words that say so; a message with the piece unchanged and none of those is
     "worked" with the words in the note. The raw findings are kept with each
     result, so --report re-reads the verdicts.
   - "not offered": the control is not on screen for this piece (Foam's Set
     needs a hollow, Back needs a producer). "no visible result" with "greyed
     out": the button stayed disabled after what a person would do first.
   - QA_TRACE=1 prints phases and the Join state to stderr; QA_LARGE=path
     points at the 3MF. */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'qa-out');
const CACHE = path.join(OUT, '.cache');
const LOCAL = path.join(__dirname, 'fixtures-local');

const FREEZE_MS = 10000;      // a Playwright call pending this long: the page was blocked
const KILL_MS = 60000;        // ... and this long: give up on the page (the worker's own watchdog)
const SILENCE_MS = 150000;    // the orchestrator's: a worker that has said nothing this long is dead
const MSG = '@@';

const FIXTURES = [
  { key: 'hinge', label: 'the hinge (small)', file: () => path.join(ROOT, 'fixtures', 'hinge_knuckle_box.stl') },
  { key: 'box', label: 'box_closed, cleaned (medium)', file: makeCleanBox },
  { key: 'large', label: 'the 1.46M-triangle 3MF (large)', file: findLarge }
];

function makeCleanBox() {
  const out = path.join(CACHE, 'box_closed_clean.stl');
  fs.mkdirSync(CACHE, { recursive: true });
  cp.execFileSync(process.execPath, [path.join(__dirname, 'nso_fixture_union.mjs'),
    path.join(ROOT, 'library', 'box_closed.stl'), out, '--header', 'bit:box_closed'], { stdio: 'pipe' });
  return out;
}
function findLarge() {
  if (process.env.QA_LARGE) return fs.existsSync(process.env.QA_LARGE) ? process.env.QA_LARGE : null;
  let best = null, size = 0;
  try {
    for (const f of fs.readdirSync(LOCAL)) {
      if (!/\.3mf$/i.test(f)) continue;
      const s = fs.statSync(path.join(LOCAL, f)).size;
      if (s > size) { best = path.join(LOCAL, f); size = s; }
    }
  } catch (e) { /* no directory: no fixture */ }
  return best;
}

/* ============================================================ the plan ==
   One entry per verb, V(section, card, id, label, options). `setup`: 'one' (the
   fixture, picked), 'two' (and a Stock box beside it, A = the fixture), 'none'
   (an empty page). `pre(x)` runs before the "before" is read (a state the verb
   needs); `run(x)` does the obvious thing, default: click the verb's button.
   `view`: the verb is a mode or a view, so a change on screen is a result. */

const PLAN = [];
const MENU = { 'Import': 'menu-import', 'Measure': 'menu-measure', 'Move': 'menu-move', 'Rotate': 'menu-rotate', 'Tip': 'menu-tip',
  'Align': 'menu-align', 'Gen+': 'menu-gen', 'Export': 'menu-export', 'Scale': 'menu-scale', 'Cut': 'menu-cut', 'Crop': 'menu-crop',
  'Connect': 'menu-connect', 'Join': 'menu-joins', 'Seat': 'menu-seat', 'Supports': 'menu-supports', 'Add': 'menu-add',
  'Subtract': 'menu-bit', 'Shape': 'menu-shape', 'Paint': 'menu-paint', 'Surface & edges': 'menu-surface', 'Sculpt': 'menu-sculpt',
  'Check & repair': 'menu-repair' };
function V(sec, card, id, label, o) {
  const it = Object.assign({ sec, card, id, label, setup: 'one', menu: MENU[card] || null }, o || {});
  PLAN.push(it);
}

/* the obvious thing, as small pieces */
const arm = (id, ks, go) => async x => {          // click the verb, click the piece at points ks, press each `go` that is up
  await x.click(id); await x.wait(250);
  for (const k of ks || []) await x.pick(0, k);
  for (const g of go || []) { await x.wait(200); await x.click(g); }
};
const press = ids => async x => { for (const i of ids) { await x.click(i); await x.wait(150); } };
const flag = id => async x => { await x.flag(id); };

function buildPlan() {
  if (PLAN.length) return PLAN;
  const TOP = 'Top row', COL = 'Column', GS = 'G-scope';
  const box20 = path.join(ROOT, 'fixtures', 'box-20mm.stl');

  /* ---- top row ---- */
  V(TOP, 'Import', 'btn-load-stl', 'From File', { setup: 'none', run: async x => { await x.chooser('btn-load-stl', box20); } });
  V(TOP, 'Import', 'btn-library', 'From Library', { setup: 'none', run: async x => {
    await x.click('btn-library');
    await x.wait(800);
    /* the catalog lists more than a checkout holds (the harness answers the rest 404, as the live
       site would for a file missing from the repo): take the first row whose bytes are here */
    const LIB = require('./nso_library_dir');
    const names = await x.page.evaluate(() => Array.from(document.querySelectorAll('#library-list .library-item')).map(r => r.dataset.file));
    const name = names.find(n => LIB.catalogFile(n));
    if (!name) { x.note('no catalog row has its file in this checkout'); return; }
    await x.page.evaluate(n => { const r = document.querySelector('#library-list .library-item[data-file="' + n + '"]'); for (let d = r; d; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true; }, name);
    x.note('row: ' + name);
    await x.clickSel('#library-list .library-item[data-file="' + name + '"]');
  } });
  const measure = async x => { await x.click('btn-measure'); await x.wait(250); const s = x.span(0); if (s) { await x.clickAt(s[0]); await x.wait(200); await x.clickAt(s[1]); } else x.note('no points on the piece'); };
  V(TOP, 'Measure', 'btn-measure', 'Two points', { view: true, run: measure });
  V(TOP, 'Measure', 'sel-measure-mode', 'Edge', { view: true, pre: async x => { await x.select('sel-measure-mode', { label: 'Edge' }); },
    run: async x => { await x.click('btn-measure'); await x.wait(250); const s = x.span(0); if (s) await x.clickAt(s[0]); else x.note('no points on the piece'); } });
  V(TOP, 'Move', 'chk-move-vertical', 'Vertical', { view: true, run: flag('chk-move-vertical') });
  V(TOP, 'Move', 'move-vert-slider', 'Vertical slider (drag up)', { pre: async x => { await x.flag('chk-move-vertical'); },
    run: async x => { await x.slider('move-vert-slider', 0.3); } });
  V(TOP, 'Move', 'btn-to-plate', 'To plate', { pre: async x => { await x.flag('chk-move-vertical'); await x.slider('move-vert-slider', 0.3); },
    run: press(['btn-to-plate']) });
  for (const [id, l] of [['btn-nudge-fwd', '↑'], ['btn-nudge-back', '↓'], ['btn-nudge-left', '←'], ['btn-nudge-right', '→']])
    V(TOP, 'Move', id, 'Nudge ' + l, { run: press([id]) });
  V(TOP, 'Move', 'drag-piece', 'Drag the piece across the plate', { menu: null, run: async x => {
    const a = x.pt(0, 0); await x.dragAt(a, a && { x: a.x + 80, y: a.y + 40 }, { steps: 10 }); } });
  V(TOP, 'Rotate', 'btn-rot-left', '⟲ 90°', { run: press(['btn-rot-left']) });
  V(TOP, 'Rotate', 'btn-rot-right', '90° ⟳', { run: press(['btn-rot-right']) });
  V(TOP, 'Rotate', 'chk-rot-ring-turn', 'Turn ring (switch off)', { view: true, run: flag('chk-rot-ring-turn') });
  V(TOP, 'Rotate', 'chk-rot-ring-fb', 'Front/back ring (switch on)', { view: true, run: flag('chk-rot-ring-fb') });
  V(TOP, 'Rotate', 'chk-rot-ring-ss', 'Side/side ring (switch on)', { view: true, run: flag('chk-rot-ring-ss') });
  V(TOP, 'Rotate', 'ring-turn', 'Drag the Turn ring', { nofit: true, run: async x => { await x.ringDrag('turn', 40); } });
  V(TOP, 'Rotate', 'ring-fb', 'Drag the front/back ring', { nofit: true, pre: async x => { await x.flag('chk-rot-ring-fb'); }, run: async x => { await x.ringDrag('fb', 40); } });
  V(TOP, 'Rotate', 'ring-ss', 'Drag the side/side ring', { nofit: true, pre: async x => { await x.flag('chk-rot-ring-ss'); }, run: async x => { await x.ringDrag('ss', 40); } });
  for (const [id, l] of [['btn-flip', 'Tip on side'], ['btn-tip', 'Stand'], ['btn-flip-over', 'Flip'], ['btn-tilt-up', 'Tilt ↑'],
                         ['btn-tilt-dn', 'Tilt ↓'], ['btn-bank-up', 'Tilt →'], ['btn-bank-dn', 'Tilt ←']])
    V(TOP, 'Tip', id, l, { run: press([id]) });
  V(TOP, 'Tip', 'btn-tip-face', 'Tip on face (click a face)', { run: arm('btn-tip-face', [1]) });
  /* Align: two pieces, A and B picked in Join's slots, the way the card's own text says */
  const two = { setup: 'two', pre: async x => { await x.joinAB(); } };
  for (const [id, l] of [['btn-join-align', 'Align edges'], ['btn-join-cx', 'Center X'], ['btn-join-cz', 'Center Z'], ['btn-center-lock', 'Center lock']])
    V(TOP, 'Align', id, l, Object.assign({ run: press([id]) }, two));
  V(TOP, 'Align', 'btn-center-lock-pick', 'Pick target (click a point on A)', Object.assign({ run: async x => { await x.click('btn-center-lock-pick'); await x.pick(0, 2); await x.click('btn-center-lock'); } }, two));
  V(TOP, 'Align', 'center-lock-ref', 'Lock on (other reference)', Object.assign({ run: async x => { await x.select('center-lock-ref', { index: 1 }); await x.click('btn-center-lock'); } }, two));
  /* Gen+ */
  for (const [id, l] of [['btn-stock-box', 'Box'], ['btn-stock-cylinder', 'Cylinder'], ['btn-stock-sphere', 'Sphere'], ['btn-stock-capsule', 'Capsule'],
                         ['btn-stock-ellipsoid', 'Ellipsoid'], ['btn-stock-torus', 'Torus'], ['btn-stock-tube', 'Tube'], ['btn-stock-cone', 'Cone']])
    V(TOP, 'Gen+', id, 'Stock: ' + l, { setup: 'none', run: press([id]) });
  const wheelSet = async x => { await x.fill('inp-wheel-height', 60); await x.fill('inp-wheel-radius', 30); await x.fill('inp-wheel-wall', 3); };
  const ball = async x => { await wheelSet(x); await x.click('btn-wheel-ball'); await x.wait(400); };
  V(TOP, 'Gen+', 'btn-wheel-ball', 'Wheel: Ball (height 60, radius 30)', { pre: wheelSet, run: press(['btn-wheel-ball']) });
  V(TOP, 'Gen+', 'btn-wheel-open', 'Wheel: Open', { pre: ball, run: press(['btn-wheel-open']) });
  V(TOP, 'Gen+', 'btn-wheel-pull', 'Wheel: Pull (height 30, +6 mm)', { pre: async x => { await ball(x); await x.click('btn-wheel-open'); await x.wait(400); await x.fill('inp-wheel-pull-z', 30); await x.fill('inp-wheel-pull-dr', 6); },
    run: press(['btn-wheel-pull']) });
  V(TOP, 'Gen+', 'btn-wheel-trim', 'Wheel: Trim', { pre: ball, run: press(['btn-wheel-trim']) });
  V(TOP, 'Gen+', 'btn-wheel-rim', 'Wheel: Rim +', { pre: ball, run: press(['btn-wheel-rim']) });
  V(TOP, 'Gen+', 'btn-relief-pick', 'Picture: Choose picture…', { setup: 'none', run: async x => { await x.chooser('btn-relief-pick', x.png()); } });
  V(TOP, 'Gen+', 'btn-relief-make', 'Picture: Make piece', { setup: 'none', pre: async x => { await x.chooser('btn-relief-pick', x.png()); await x.wait(800); }, run: press(['btn-relief-make']) });
  V(TOP, 'Gen+', 'btn-relief-undo', 'Picture: Undo', { setup: 'none', pre: async x => { await x.chooser('btn-relief-pick', x.png()); await x.wait(800); await x.click('btn-relief-make'); await x.wait(800); }, run: press(['btn-relief-undo']) });
  V(TOP, 'Gen+', 'btn-mold-make', 'Mold: Generate mold', { run: press(['btn-mold-make']) });
  V(TOP, 'Gen+', 'mold-slider', 'Mold: parting slider (drag)', { run: async x => { await x.slider('mold-slider', 0.7); } });
  V(TOP, 'Gen+', 'btn-mold-nudge-p', 'Mold: nudge →', { run: press(['btn-mold-nudge-p']) });
  V(TOP, 'Gen+', 'btn-mold-pour-reset', 'Mold: Pour: top', { run: press(['btn-mold-pour-reset']) });
  V(TOP, 'Gen+', 'btn-photoset-pick', 'Photo: Choose photos…', { setup: 'none', run: async x => { await x.chooser('btn-photoset-pick', [x.png(), x.png(1), x.png(2)]); } });
  V(TOP, 'Gen+', 'btn-photoset-report', 'Photo: Report', { setup: 'none', pre: async x => { await x.chooser('btn-photoset-pick', [x.png(), x.png(1), x.png(2)]); await x.wait(800); }, run: press(['btn-photoset-report']) });
  V(TOP, 'Gen+', 'btn-photoset-clear', 'Photo: Clear', { setup: 'none', pre: async x => { await x.chooser('btn-photoset-pick', [x.png(), x.png(1), x.png(2)]); await x.wait(800); }, run: press(['btn-photoset-clear']) });
  V(TOP, 'Lock', 'btn-lock-pos', 'Lock position', { menu: null, view: true, run: press(['btn-lock-pos']) });
  V(TOP, 'Lock', 'btn-plate-lock', 'Lock plate', { menu: null, view: true, run: press(['btn-plate-lock']) });
  V(TOP, 'Undo', 'btn-undo', 'Undo (after a nudge)', { menu: null, pre: async x => { await x.click('btn-nudge-fwd'); await x.wait(300); }, run: press(['btn-undo']) });
  V(TOP, 'Remove', 'btn-delete-placed', 'Remove', { menu: null, run: press(['btn-delete-placed']) });
  V(TOP, 'Export', 'export-format', 'Format: 3MF', { view: true, run: async x => { await x.select('export-format', { index: 1 }); } });
  V(TOP, 'Export', 'cooling-profile', 'Cooling profile (second, with 3MF chosen)', { view: true, pre: async x => { await x.select('export-format', { index: 1 }); }, run: async x => { await x.select('cooling-profile', { index: 1 }); } });
  V(TOP, 'Export', 'btn-export-model', 'Download selected STL', { view: true, run: async x => { await x.download('btn-export-model'); } });
  V(TOP, 'Export', 'btn-export-model-3mf', 'Download selected 3MF', { view: true, pre: async x => { await x.select('export-format', { index: 1 }); }, run: async x => { await x.download('btn-export-model'); } });
  V(TOP, 'Export', 'btn-library-save', 'Save selected to Library', { run: press(['btn-library-save']) });
  V(TOP, 'Export', 'btn-export-stl', 'Export plate STL', { view: true, run: async x => { await x.download('btn-export-stl'); } });
  V(TOP, 'Export', 'btn-delete-model', 'Delete model', { run: press(['btn-delete-model']) });
  V(TOP, 'View', 'btn-xray', 'X-ray', { menu: null, view: true, run: press(['btn-xray']) });
  V(TOP, 'View', 'btn-watch', 'Eye (Watch)', { menu: null, view: true, run: press(['btn-watch']) });
  V(TOP, 'View', 'btn-frame-view', 'Frame the view', { menu: null, view: true, run: press(['btn-frame-view']) });

  /* ---- the column ---- */
  V(COL, 'Scale', 'btn-scale-unit-in', 'Unit: in', { view: true, run: press(['btn-scale-unit-in']) });
  V(COL, 'Scale', 'scale-length', 'Length ×1.4', { run: async x => { await x.fillNum('scale-length', 1.4); } });
  V(COL, 'Scale', 'scale-width', 'Width ×1.4', { run: async x => { await x.fillNum('scale-width', 1.4); } });
  V(COL, 'Scale', 'scale-height', 'Height ×1.4', { run: async x => { await x.fillNum('scale-height', 1.4); } });
  V(COL, 'Scale', 'scale-offset', 'Offset 0.4 mm', { run: async x => { await x.fill('scale-offset', 0.4); } });
  V(COL, 'Scale', 'scale-factor', 'Whole × 1.5', { run: async x => { await x.fill('scale-factor', 1.5); } });
  V(COL, 'Scale', 'btn-scale-fit', 'Fit to plate', { run: press(['btn-scale-fit']) });
  V(COL, 'Scale', 'scale-ring-outer', 'Ring outer (Stock tube)', { setup: 'none', pre: async x => { await x.click('btn-stock-tube'); await x.wait(400); }, run: async x => { await x.fillNum('scale-ring-outer', 1.3); } });
  V(COL, 'Scale', 'scale-ring-wall', 'Ring wall (Stock tube)', { setup: 'none', pre: async x => { await x.click('btn-stock-tube'); await x.wait(400); }, run: async x => { await x.fillNum('scale-ring-wall', 1.3); } });
  V(COL, 'Scale', 'scale-rod-diameter', 'Rod diameter (Stock cylinder)', { setup: 'none', pre: async x => { await x.click('btn-stock-cylinder'); await x.wait(400); }, run: async x => { await x.fillNum('scale-rod-diameter', 1.3); } });
  V(COL, 'Scale', 'scale-ell-a', 'Ellipsoid a (Stock ellipsoid)', { setup: 'none', pre: async x => { await x.click('btn-stock-ellipsoid'); await x.wait(400); }, run: async x => { await x.fillNum('scale-ell-a', 1.3); } });
  V(COL, 'Scale', 'scale-torus-ring', 'Torus ring (Stock torus)', { setup: 'none', pre: async x => { await x.click('btn-stock-torus'); await x.wait(400); }, run: async x => { await x.fillNum('scale-torus-ring', 1.3); } });
  V(COL, 'Cut', 'cut-click', 'Click the piece (drop the blade)', { view: true, run: async x => { await x.pick(0, 1); } });
  V(COL, 'Cut', 'btn-cut-miter-plus', 'Mitre +', { view: true, run: press(['btn-cut-miter-plus', 'btn-cut-miter-plus', 'btn-cut-miter-plus']) });
  V(COL, 'Cut', 'btn-cut-square', 'Square', { view: true, pre: async x => { await x.click('btn-cut-miter-plus'); await x.wait(200); }, run: press(['btn-cut-square']) });
  V(COL, 'Cut', 'cut-slider', 'Blade slider (drag)', { view: true, run: async x => { await x.slider('cut-slider', 0.7); } });
  V(COL, 'Cut', 'btn-cut-nudge-p', 'Nudge →', { view: true, run: press(['btn-cut-nudge-p']) });
  V(COL, 'Cut', 'btn-cut', 'Cut', { run: async x => { await x.pick(0, 1); await x.wait(200); await x.click('btn-cut'); } });
  V(COL, 'Cut', 'btn-cut-right-side-out', 'Turn it right-side-out, then Cut', { run: press(['btn-cut-right-side-out']) });
  for (const [id, l] of [['btn-crop-shape-box', 'Box'], ['btn-crop-shape-cylinder', 'Cylinder'], ['btn-crop-shape-sphere', 'Sphere']])
    V(COL, 'Crop', id, l + ' then CROP', { run: arm(id, [], ['btn-crop']) });
  V(COL, 'Crop', 'btn-crop-shape-piece', 'Piece (click the other piece) then CROP', { setup: 'two', run: async x => { await x.click('btn-crop-shape-piece'); await x.wait(200); await x.pick(1, 0); await x.click('btn-crop'); } });
  V(COL, 'Crop', 'btn-crop-shape-outline', 'Outline (click the piece) then CROP', { run: async x => { await x.click('btn-crop-shape-outline'); await x.wait(200); await x.pick(0, 0); await x.click('btn-crop'); } });
  V(COL, 'Crop', 'crop-box-drag', 'Box: drag its body, then CROP', { run: async x => {
    await x.click('btn-crop-shape-box'); await x.wait(300);
    const a = x.pt(0, 0); await x.dragAt(a, a && { x: a.x + 40, y: a.y - 20 }); await x.click('btn-crop'); } });
  V(COL, 'Crop', 'btn-crop-cancel', 'Cancel', { pre: async x => { await x.click('btn-crop-shape-box'); await x.wait(300); }, run: press(['btn-crop-cancel']) });
  const conn = (shape, end) => async x => {
    await x.select('sel-connect-shape', { label: shape });
    if (end) await x.select('sel-connect-ends', { label: end });
    await x.pick(0, 0); await x.wait(200); await x.pick(1, 0); await x.wait(300); await x.click('btn-connect-go'); };
  for (const sh of ['String', 'Ribbon', 'Tube', 'Tapered']) V(COL, 'Connect', 'btn-connect-go', sh + ': pick two anchors, Set', { setup: 'two', run: conn(sh) });
  V(COL, 'Connect', 'btn-connect-go', 'String, ends: Ball', { setup: 'two', run: conn('String', 'Ball') });
  V(COL, 'Connect', 'btn-connect-go', 'String, kept as its own piece', { setup: 'two', run: async x => { await x.flag('input[value="separate"]'); await conn('String')(x); } });
  V(COL, 'Connect', 'btn-connect-cancel', 'Cancel', { setup: 'two', run: async x => { await x.pick(0, 0); await x.wait(200); await x.click('btn-connect-cancel'); } });
  V(COL, 'Connect', 'btn-stock-attach', 'Attach (a Stock blank, click a face)', { pre: async x => { await x.click('btn-stock-cylinder'); await x.wait(400); await x.pick(0, 0); }, run: arm('btn-stock-attach', [1]) });
  V(COL, 'Connect', 'btn-reattach', 'Reattach', { run: press(['btn-reattach']) });
  V(COL, 'Join', 'join-slot-a', 'Pick piece A (a side wall)', { setup: 'two', run: async x => { await x.click('join-slot-a'); await x.pick(0, 0, false); } });
  V(COL, 'Join', 'join-slot-b', 'Pick piece B (a side wall)', { setup: 'two', pre: async x => { await x.click('join-slot-a'); await x.pick(0, 0, false); }, run: async x => { await x.click('join-slot-b'); await x.pick(1, 0, false); } });
  V(COL, 'Join', 'join-slot-c', 'Pick piece C (a side wall)', { setup: 'three', pre: async x => { await x.joinAB(); }, run: async x => { await x.click('join-slot-c'); await x.pick(2, 0, false); } });
  V(COL, 'Join', 'btn-join', 'Complete Join (A, B picked)', { setup: 'two', pre: async x => { await x.joinAB(); }, run: press(['btn-join']) });
  V(COL, 'Join', 'btn-join-clear', 'Cancel Join', { setup: 'two', pre: async x => { await x.joinAB(); }, run: press(['btn-join-clear']) });
  V(COL, 'Join', 'triple-mode', 'A-B-C: mode (second)', { setup: 'three', view: true, run: async x => { await x.select('triple-mode', { index: 1 }); } });
  V(COL, 'Join', 'triple-gap-ab', 'A-B-C: gap slider', { setup: 'three', view: true, run: async x => { await x.slider('triple-gap-ab', 0.7); } });
  V(COL, 'Join', 'btn-join-triple', 'Join A-B-C', { setup: 'three', pre: async x => { await x.joinABC(); }, run: press(['btn-join-triple']) });
  const seatTwo = { setup: 'two', pre: async x => { await x.joinAB(); await x.click('btn-center-lock'); await x.wait(500); } };
  V(COL, 'Seat', 'btn-seat-support', 'Seat (support), after Center lock', Object.assign({ run: press(['btn-seat-support']) }, seatTwo));
  V(COL, 'Seat', 'seat-gap', 'Gap slider (drag), then Seat', Object.assign({ run: async x => { await x.slider('seat-gap', 0.8); await x.click('btn-seat-support'); } }, seatTwo));
  V(COL, 'Seat', 'btn-seat-here', 'Seat here (click a point on A)', Object.assign({ run: arm('btn-seat-here', [1]) }, seatTwo));
  V(COL, 'Seat', 'chk-oversize-washer', 'Oversize washer (on), then Seat', Object.assign({ run: async x => { await x.flag('chk-oversize-washer'); await x.click('btn-seat-support'); } }, seatTwo));
  V(COL, 'Seat', 'btn-seat-flush', 'Seat flush', Object.assign({ run: press(['btn-seat-flush']) }, seatTwo));
  V(COL, 'Seat', 'btn-flip-port', 'Flip port', Object.assign({ run: press(['btn-flip-port']) }, seatTwo));
  V(COL, 'Seat', 'btn-seat-grid', 'Surface grid', Object.assign({ view: true, run: press(['btn-seat-grid']) }, seatTwo));
  V(COL, 'Supports', 'btn-sup-all', 'Generate', { run: press(['btn-sup-all']) });
  V(COL, 'Supports', 'sup-style', 'Style: Tree, then Generate', { run: async x => { await x.select('sup-style', { index: 1 }); await x.click('btn-sup-all'); } });
  V(COL, 'Supports', 'sup-angle', 'Angle 30, then Generate', { run: async x => { await x.fill('sup-angle', 30); await x.click('btn-sup-all'); } });
  V(COL, 'Supports', 'btn-sup-remove', 'Remove (click a support)', { pre: async x => { await x.click('btn-sup-all'); await x.wait(800); }, run: arm('btn-sup-remove', [0, 1]) });
  V(COL, 'Supports', 'btn-sup-none', 'Remove all', { pre: async x => { await x.click('btn-sup-all'); await x.wait(800); }, run: press(['btn-sup-none']) });
  const hollowed = async x => { await x.click('btn-hollow'); await x.wait(1200); };
  V(COL, 'Add', 'btn-fill', 'Fill / Densify (after Hollow)', { pre: hollowed, run: press(['btn-fill']) });
  V(COL, 'Add', 'btn-foam', 'Foam (after Hollow; hold the mouse on the piece)', { pre: hollowed, run: async x => { await x.click('btn-foam'); await x.wait(300); const p = x.pt(0, 0); if (p) await x.hold(p, 1500); else x.note('no point on the piece'); } });
  V(COL, 'Add', 'btn-foam-all', 'Foam: Fill it all', { pre: async x => { await hollowed(x); await x.click('btn-foam'); await x.wait(300); }, run: press(['btn-foam-all']) });
  V(COL, 'Add', 'btn-foam-set', 'Foam: Fill it all, Set', { pre: async x => { await hollowed(x); await x.click('btn-foam'); await x.wait(300); await x.click('btn-foam-all'); await x.wait(500); }, run: press(['btn-foam-set']) });
  V(COL, 'Add', 'btn-foam-cancel', 'Foam: Cancel', { pre: async x => { await hollowed(x); await x.click('btn-foam'); await x.wait(300); }, run: press(['btn-foam-cancel']) });
  V(COL, 'Add', 'btn-thicken-out', 'Thicken out', { run: press(['btn-thicken-out']) });
  V(COL, 'Add', 'btn-thicken-in', 'Thicken in', { run: press(['btn-thicken-in']) });
  V(COL, 'Add', 'btn-extend', 'Extend (read the length)', { run: press(['btn-extend']) });
  V(COL, 'Add', 'inp-extend-mm', 'Extend 3 mm', { run: async x => { await x.fill('inp-extend-mm', 3); await x.click('btn-extend'); } });
  V(COL, 'Add', 'btn-bridge-go', 'Bridge: two points, Set', { setup: 'two', run: async x => { await x.click('btn-bridge'); await x.pick(0, 0); await x.wait(200); await x.pick(1, 0); await x.wait(300); await x.click('btn-bridge-go'); } });
  V(COL, 'Add', 'btn-bridge-cancel', 'Bridge: Cancel', { setup: 'two', run: async x => { await x.click('btn-bridge'); await x.pick(0, 0); await x.wait(200); await x.click('btn-bridge-cancel'); } });
  V(COL, 'Add', 'btn-close-go', 'Close: click the rim, Set', { run: arm('btn-close', [0, 1], ['btn-close-go']) });
  V(COL, 'Add', 'btn-patch', 'Patch (click a hole)', { run: arm('btn-patch', [0, 1]) });
  V(COL, 'Subtract', 'btn-subtract', 'Subtract B from A', Object.assign({ run: press(['btn-subtract']) }, two));
  V(COL, 'Subtract', 'btn-extract-bit', 'Extract bit', Object.assign({ run: press(['btn-extract-bit']) }, two));
  V(COL, 'Subtract', 'btn-carve', 'Carve (click a face)', { run: arm('btn-carve', [0]) });
  V(COL, 'Subtract', 'carve-drag', 'Carve (drag a groove)', { run: async x => { await x.click('btn-carve'); await x.wait(200); await x.dragAt(x.pt(0, 1), x.pt(0, 3)); } });
  V(COL, 'Subtract', 'btn-hollow', 'Hollow', { run: press(['btn-hollow']) });
  V(COL, 'Subtract', 'btn-hollow-safe', 'Hollow to safe min', { run: press(['btn-hollow-safe']) });
  V(COL, 'Subtract', 'btn-lift', 'Lift (click a feature)', { run: arm('btn-lift', [0, 1]) });
  V(COL, 'Subtract', 'btn-lift-strip-go', 'Lift: Strip, Confirm', { run: async x => { await x.click('btn-lift'); await x.wait(300); await x.click('btn-lift-strip'); await x.wait(300); await x.click('btn-lift-strip-go'); } });
  V(COL, 'Subtract', 'btn-split-parts', 'Split to parts', { run: press(['btn-split-parts']) });
  V(COL, 'Subtract', 'btn-detach', 'Detach flange', { run: press(['btn-detach']) });
  V(COL, 'Shape', 'btn-smooth', 'Smooth', { run: press(['btn-smooth']) });
  V(COL, 'Shape', 'btn-bend-go', 'Bend: click the piece, Bend', { run: async x => { await x.click('btn-bend'); await x.wait(300); await x.pick(0, 0); await x.wait(300); await x.click('btn-bend-go'); } });
  V(COL, 'Shape', 'btn-te-go', 'Tube edge: click near the end, Set', { run: async x => { await x.click('btn-tube-edge'); await x.wait(300); await x.pick(0, 1); await x.wait(300); await x.click('btn-te-go'); } });
  V(COL, 'Shape', 'btn-pull', 'Pull (drag a spot)', { run: async x => { await x.click('btn-pull'); await x.wait(300); const a = x.pt(0, 0); await x.dragAt(a, a && { x: a.x + 30, y: a.y - 25 }, { steps: 10 }); } });
  V(COL, 'Shape', 'btn-pull-pin', 'Pull: click to drop a pin', { run: async x => { await x.click('btn-pull'); await x.wait(300); await x.pick(0, 1); } });
  V(COL, 'Shape', 'btn-pull-clear', 'Pull: Clear pins', { pre: async x => { await x.click('btn-pull'); await x.wait(300); await x.pick(0, 1); }, run: press(['btn-pull-clear']) });
  V(COL, 'Shape', 'btn-pull-cancel', 'Pull: Cancel', { pre: async x => { await x.click('btn-pull'); await x.wait(300); }, run: press(['btn-pull-cancel']) });
  V(COL, 'Paint', 'btn-mask-select', 'Paint Selected (click a face)', { run: arm('btn-mask-select', [0]) });
  V(COL, 'Paint', 'btn-mask-paint', 'Paint Excluded (click a face)', { run: arm('btn-mask-paint', [0]) });
  const painted = async x => { await x.click('btn-mask-select'); await x.wait(200); await x.pick(0, 0); await x.wait(300); };
  V(COL, 'Paint', 'btn-mask-clear', 'Clear paint', { pre: painted, run: press(['btn-mask-clear']) });
  V(COL, 'Paint', 'btn-mask-delete', 'Delete painted', { pre: painted, run: press(['btn-mask-delete']) });
  V(COL, 'Paint', 'btn-extract-sel', 'Extract selection', { pre: painted, run: press(['btn-extract-sel']) });
  V(COL, 'Surface & edges', 'btn-soften', 'Soften', { run: press(['btn-soften']) });
  V(COL, 'Surface & edges', 'btn-mirror', 'Mirror', { run: press(['btn-mirror']) });
  V(COL, 'Surface & edges', 'btn-skin-face', 'Skin face', { pre: painted, run: press(['btn-skin-face']) });
  V(COL, 'Surface & edges', 'btn-skin-wrap', 'Skin wrap', { run: press(['btn-skin-wrap']) });
  V(COL, 'Surface & edges', 'btn-skin-patch', 'Skin patch', { run: press(['btn-skin-patch']) });
  V(COL, 'Surface & edges', 'btn-trace-raster', 'Trace raster (choose a picture)', { run: async x => { await x.chooser('btn-trace-raster', x.png()); } });
  V(COL, 'Surface & edges', 'btn-texture', 'Texture', { run: press(['btn-texture']) });
  for (const [mode, l] of [[0, 'Carve'], [1, 'Emboss'], [2, 'Smooth here']])
    V(COL, 'Sculpt', 'btn-brush', 'Brush: ' + l + ' (drag across the piece)', { run: async x => {
      await x.select('sel-brush-mode', { index: mode }); await x.click('btn-brush'); await x.wait(300);
      await x.dragAt(x.pt(0, 1), x.pt(0, 2), { steps: 12 }); } });
  V(COL, 'Check & repair', 'btn-check-defects', 'Check piece', { run: press(['btn-check-defects']) });
  V(COL, 'Check & repair', 'btn-findings-fixall', 'Check piece, Fix all', { run: async x => { await x.click('btn-check-defects'); await x.wait(800); await x.click('btn-findings-fixall'); } });
  V(COL, 'Check & repair', 'btn-cap-open', 'Cap open faces', { run: press(['btn-cap-open']) });
  V(COL, 'Check & repair', 'btn-seal', 'Seal', { run: press(['btn-seal']) });
  V(COL, 'Check & repair', 'chk-seal-repair', 'Repair flag, Seal', { run: async x => { await x.flag('chk-seal-repair'); await x.click('btn-seal'); } });
  V(COL, 'Check & repair', 'chk-non-solid', 'Non-solid flag', { view: true, run: flag('chk-non-solid') });
  V(COL, 'Check & repair', 'btn-solidify', 'Solidify', { run: press(['btn-solidify']) });

  /* ---- G-scope ---- */
  /* G-scope opens on the plate; `nav` is the column button whose card the verb lives in. Both, and any
     state the verb needs, are set up BEFORE the "before" is read, so a card opening is not the verb's result. */
  const gsOpen = async x => { await x.click('btn-microscope'); await x.wait(1200); };
  const gs = (nav, setup, o) => Object.assign({ menu: null, view: true, pre: async x => { await gsOpen(x); if (setup) await setup(x); if (nav) await x.nav(nav); } }, o);
  const isolated = async x => { await x.nav('ms-nav-select'); await x.click('ms-mode-piece'); await x.pick(0, 0, 'gs'); await x.wait(500); };
  const boxed = async x => { await x.nav('ms-nav-select'); await x.click('ms-mode-select'); await x.pick(0, 0, 'gs'); await x.wait(300); };   // Region: a click drops a capture box
  const taken = async x => { await x.gsTake(); };
  V(GS, 'G-scope', 'btn-microscope', 'Open (the plate under the lens)', { menu: null, view: true, run: press(['btn-microscope']) });
  V(GS, 'G-scope', 'ms-btn-plate', 'Read plate', gs(null, null, { run: press(['ms-btn-plate']) }));
  V(GS, 'G-scope', 'ms-btn-open', 'Import (a file instead of the plate)', gs(null, null, { run: async x => { await x.chooser('ms-btn-open', box20); } }));
  V(GS, 'Select', 'ms-mode-piece', 'Piece: click it to isolate', gs('ms-nav-select', null, { run: async x => { await x.click('ms-mode-piece'); await x.pick(0, 0, 'gs'); } }));
  V(GS, 'Select', 'ms-mode-select', 'Region: click it to drop a capture box', gs('ms-nav-select', null, { run: async x => { await x.click('ms-mode-select'); await x.pick(0, 0, 'gs'); } }));
  V(GS, 'Select', 'ms-btn-isolate', 'Region: Isolate all boxes', gs('ms-nav-select', null, { pre: async x => { await gsOpen(x); await boxed(x); }, run: press(['ms-btn-isolate']) }));
  V(GS, 'Select', 'ms-btn-clear', 'Region: Clear all boxes', gs('ms-nav-select', null, { pre: async x => { await gsOpen(x); await boxed(x); }, run: press(['ms-btn-clear']) }));
  V(GS, 'Select', 'ms-mode-feature', 'Feature (click the piece)', gs('ms-nav-select', null, { run: async x => { await x.click('ms-mode-feature'); await x.pick(0, 0, 'gs'); } }));
  V(GS, 'Select', 'ms-mode-line', 'Line (next line, Isolate)', gs('ms-nav-select', null, { run: async x => { await x.click('ms-mode-line'); await x.click('ms-line-next'); await x.click('ms-btn-isolate-line'); } }));
  V(GS, 'Select', 'ms-mode-layer', 'Layer (next layer, Select layer)', gs('ms-nav-select', null, { run: async x => { await x.click('ms-mode-layer'); await x.click('ms-layer-next'); await x.click('ms-btn-layer-select'); } }));
  V(GS, 'Select', 'ms-btn-back', 'Back to whole part (after isolating)', gs('ms-nav-select', isolated, { run: press(['ms-btn-back']) }));
  V(GS, 'View', 'ms-cam-slice', 'Slice view', gs('ms-nav-view', null, { run: press(['ms-cam-slice']) }));
  V(GS, 'View', 'ms-btn-clear-view', 'Clear from view (after isolating)', gs('ms-nav-view', isolated, { run: press(['ms-btn-clear-view']) }));
  V(GS, 'View', 'ms-btn-show-all', 'Show all', gs('ms-nav-view', null, { run: press(['ms-btn-show-all']) }));
  V(GS, 'View', 'ms-btn-select-visible', 'Select shown', gs('ms-nav-view', null, { run: press(['ms-btn-select-visible']) }));
  V(GS, 'Render', 'ms-render-solid', 'Solid', gs('ms-nav-render', null, { run: press(['ms-render-solid']) }));
  V(GS, 'Overhangs', 'ms-btn-overhangs', 'Show overhangs', gs('ms-nav-overhangs', null, { run: press(['ms-btn-overhangs']) }));
  V(GS, 'Crop Z', 'ms-btn-crop', 'Crop out band', gs('ms-nav-crop', null, { view: false, run: press(['ms-btn-crop']) }));
  V(GS, 'Slice', 'ms-slice-walls', 'Walls 3, then Slice view', gs('ms-nav-slice', null, { run: async x => { await x.fill('ms-slice-walls', 3); await x.nav('ms-nav-view'); await x.click('ms-cam-slice'); } }));
  V(GS, 'Take', 'ms-plate-take', 'Pull the piece onto TAKE (drag)', gs(null, null, { run: async x => { await x.gsTake(); } }));
  V(GS, 'Take', 'ms-plate-lens', 'Toggle TAKE, back to LENS', gs(null, null, { run: async x => { await x.click('ms-plate-take'); await x.wait(300); await x.click('ms-plate-lens'); } }));
  V(GS, 'Export', 'ms-btn-export-plate', 'Export to plate (a piece isolated)', gs('ms-nav-export', isolated, { view: false, run: press(['ms-btn-export-plate']) }));
  V(GS, 'Export', 'ms-btn-export-stl', 'Export as STL (a piece isolated)', gs('ms-nav-export', isolated, { run: async x => { await x.download('ms-btn-export-stl'); } }));
  V(GS, 'Export', 'ms-btn-take-export-stl', 'Export TAKE as STL', gs('ms-nav-export', taken, { run: async x => { await x.download('ms-btn-take-export-stl'); } }));
  V(GS, 'Export', 'ms-btn-take-export-plate', 'Export TAKE to plate', gs('ms-nav-export', taken, { view: false, run: press(['ms-btn-take-export-plate']) }));
  V(GS, 'Take', 'ms-btn-take-clear', 'Clear (after a pull)', gs(null, taken, { run: press(['ms-btn-take-clear']) }));
  V(GS, 'G-scope', 'ms-btn-back-producer', 'Back (G-scope opened by Picture › Make piece)', { setup: 'none', menu: null, view: true,
    pre: async x => { await x.chooser('btn-relief-pick', x.png()); await x.wait(800); await x.click('btn-relief-make'); await x.wait(1500); }, run: press(['ms-btn-back-producer']) });
  V(GS, 'G-scope', 'ms-close', 'Close', gs(null, null, { run: press(['ms-close']) }));
  /* ---- with Watch on: the app checks its own scene against its state after each bake (the eye in the view row) ---- */
  const watching = async x => { await x.click('btn-watch'); await x.wait(300); };
  V(COL, 'Seat', 'btn-flip-port', 'Flip port (Watch on)', Object.assign({ run: press(['btn-flip-port']) }, seatTwo, { pre: async x => { await watching(x); await seatTwo.pre(x); } }));
  V(COL, 'Shape', 'btn-pull', 'Pull (drag a spot, Watch on)', { pre: watching, run: async x => { await x.click('btn-pull'); await x.wait(300); const a = x.pt(0, 0); await x.dragAt(a, a && { x: a.x + 30, y: a.y - 25 }, { steps: 10 }); } });
  for (const [mode, l] of [[0, 'Carve'], [1, 'Emboss'], [2, 'Smooth here']])
    V(COL, 'Sculpt', 'btn-brush', 'Brush: ' + l + ' (Watch on)', { pre: watching, run: async x => {
      await x.select('sel-brush-mode', { index: mode }); await x.click('btn-brush'); await x.wait(300);
      await x.dragAt(x.pt(0, 1), x.pt(0, 2), { steps: 12 }); } });
  return PLAN;
}

/* ============================================================ the page ==*/
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The page's fingerprint: what a verb can change. `data` is the pieces (their
   geometry, poses, flags, the undo stack); `ui` is what is on screen around
   them (open cards, armed buttons, what is enabled, helper objects in the
   scene). Compared as JSON before and after. */
const FINGERPRINT = () => {
  const r3 = v => Math.round(v * 1000) / 1000;
  const prim = o => { const a = []; for (const k of Object.keys(o)) { const t = typeof o[k]; if (t === 'boolean' || t === 'number' || t === 'string') a.push(k + '=' + (t === 'number' ? r3(o[k]) : o[k])); } return a.join(','); };
  const data = {
    models: state.models.map(m => [prim(m), m.rawTris ? m.rawTris.length : 0, m.geometry && m.geometry.uuid]),
    placed: (state.placed || []).map(p => [prim(p), p.mesh && [r3(p.mesh.position.x), r3(p.mesh.position.y), r3(p.mesh.position.z),
      r3(p.mesh.quaternion.x), r3(p.mesh.quaternion.y), r3(p.mesh.quaternion.z), r3(p.mesh.quaternion.w),
      r3(p.mesh.scale.x), r3(p.mesh.scale.y), r3(p.mesh.scale.z), p.mesh.geometry && p.mesh.geometry.uuid]]),
    undo: state.undoStack ? state.undoStack.length : -1
  };
  let n = 0; state.scene.traverse(() => { n++; });
  const ui = {
    open: Array.from(document.querySelectorAll('details[open]')).map(d => d.id || d.className).join(),
    pressed: Array.from(document.querySelectorAll('[aria-pressed="true"]')).map(e => e.id).join(),
    enabled: Array.from(document.querySelectorAll('button')).filter(b => !b.disabled && b.offsetParent).map(b => b.id).join(),
    scene: n,
    ms: (document.getElementById('microscope') || {}).hidden === false,
    gs: (window.NSO_MICROSCOPE && window.NSO_MICROSCOPE.isOpen && window.NSO_MICROSCOPE.isOpen()) ? (() => {
      const M = window.NSO_MICROSCOPE, f = (k, a) => { try { const v = M[k](a); return Array.isArray(v) ? v.length : (v && typeof v === 'object' ? JSON.stringify(v).length : v); } catch (e) { return 'x'; } };
      return [f('plate'), f('takePieces'), f('selection'), f('boxes'), f('isIsolated'), f('mode'), f('isSliced')];
    })() : null
  };
  const t = id => { const e = document.getElementById(id); return e ? e.textContent.trim().replace(/\s+/g, ' ') : ''; };
  /* what the open card and the findings card say: a refusal is often written there, not on the status line */
  const lines = [], warn = [];
  document.querySelectorAll('.vp-shell-menu[open], .ms-card.is-open, #findings-card:not([hidden])').forEach(e => {
    String(e.innerText || '').split('\n').map(x => x.trim()).filter(x => x.length > 3).forEach(x => lines.push(x));
    e.querySelectorAll('*').forEach(c => {          // red text in a card is the app refusing, in the card
      if (c.children.length || !(c.textContent || '').trim() || !c.offsetParent) return;
      const m = /rgba?\((\d+), (\d+), (\d+)/.exec(getComputedStyle(c).color || '');
      if (m && +m[1] > 170 && +m[2] < 130 && +m[3] < 130) warn.push(c.textContent.trim().replace(/\s+/g, ' '));
    });
  });
  const se = document.getElementById('status');
  return { data: JSON.stringify(data), ui: JSON.stringify(ui), status: t('status'), adjust: t('adjust-status'), edit: state.editId,
           cards: lines, warn, statusError: !!(se && se.classList.contains('error')) };
};

/* How long the page's main thread was blocked, two ways: the longest long task, and the longest gap between
   ticks of a 50 ms timer. (A frame the software renderer takes seconds over shows up here too: on the large
   fixture the baseline is a gap of a couple of seconds, and only 10 s past that is a freeze.) */
const LONGTASK = () => {
  window.__qa = { longest: 0, gap: 0, last: performance.now() };
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__qa.longest = Math.max(window.__qa.longest, e.duration); })
      .observe({ entryTypes: ['longtask'] });
  } catch (e) { /* no longtask support */ }
  setInterval(() => { const n = performance.now(); window.__qa.gap = Math.max(window.__qa.gap, n - window.__qa.last); window.__qa.last = n; }, 50);
};

/* The view, brought in on what is on the plate - a person zooms to a small piece before working on it.
   Same direction, closer; the pieces' bounding sphere fills most of the height. */
const FIT = (steep) => {
  const box = new THREE.Box3();
  (state.placed || []).forEach(p => box.expandByObject(p.mesh));
  if (box.isEmpty()) return;
  const sph = box.getBoundingSphere(new THREE.Sphere()), cam = state.camera;
  /* with several pieces: from the side they are spread along, raised, so none stands in front of another */
  const dir = steep ? new THREE.Vector3(0.9, 0.75, 0.15).normalize() : cam.position.clone().sub(state.controls.target).normalize();
  const dist = sph.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 1.25;
  state.controls.target.copy(sph.center);
  cam.position.copy(sph.center).addScaledVector(dir, dist);
  state.controls.update();
  cam.updateMatrixWorld(true);          // projection and rays read the matrices, which a render would refresh later
};

/* Where the pieces are on screen: for each placed piece, pixels whose ray the
   app's own raycaster says land on THAT piece first (nearest hit), centre out. */
const HITS = () => {
  const el = state.renderer.domElement, rect = el.getBoundingClientRect();
  const placed = state.placed || [];
  const out = placed.map(() => []), sides = placed.map(() => []), centres = [];
  state.scene.updateMatrixWorld(true);
  state.camera.updateMatrixWorld(true);
  const own = o => { for (let n = o; n; n = n.parent) { const i = placed.findIndex(p => p.mesh === n); if (i >= 0) return i; } return -1; };
  const boxes = placed.map(p => new THREE.Box3().setFromObject(p.mesh));
  const px = (x, y, z) => { const q = new THREE.Vector3(x, y, z).project(state.camera); return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height]; };
  placed.forEach((p, i) => {
    const b = boxes[i]; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const q = px(x, y, z); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cand = [];
    for (let a = 0; a < 11; a++) for (let b = 0; b < 11; b++) cand.push([x0 + (x1 - x0) * (a + 0.5) / 11, y0 + (y1 - y0) * (b + 0.5) / 11]);
    cand.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
    centres[i] = { x: Math.round(cx), y: Math.round(cy) };
    for (const c of cand) {
      if (out[i].length >= 8) break;
      if (c[0] < rect.left + 4 || c[0] > rect.right - 4 || c[1] < rect.top + 4 || c[1] > rect.bottom - 4) continue;
      /* a pixel counts only if it and the four a couple of pixels round it all land on this piece first:
         a click on a silhouette edge is a coin toss between the piece and whatever is in front */
      const first = (dx, dy) => {
        state.pointer.x = ((c[0] + dx - rect.left) / rect.width) * 2 - 1;
        state.pointer.y = -((c[1] + dy - rect.top) / rect.height) * 2 + 1;
        state.raycaster.setFromCamera(state.pointer, state.camera);
        const h = state.raycaster.intersectObjects(state.modelGroup.children, true);
        return h.length ? own(h[0].object) : -1;
      };
      c[0] = Math.round(c[0]); c[1] = Math.round(c[1]);
      if ([[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].every(d => first(d[0], d[1]) === i)) {
        out[i].push({ x: c[0], y: c[1] });
        state.pointer.x = ((c[0] - rect.left) / rect.width) * 2 - 1; state.pointer.y = -((c[1] - rect.top) / rect.height) * 2 + 1;
        state.raycaster.setFromCamera(state.pointer, state.camera);
        const hit = state.raycaster.intersectObjects(state.modelGroup.children, true)[0];
        if (hit && hit.face && Math.abs(hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y) < 0.3) sides[i].push({ x: c[0], y: c[1] });
      }
    }
  });
  return { hits: out, sides, centres };
};

/* A w x w grayscale PNG: a black ring on white (n shifts it), stored, no filter. */
function makePng(w, n) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - w / 2 - n * 3, y - w / 2), ring = Math.abs(d - w / 3) < 2.5;
    raw[y * (w + 1) + 1 + x] = ring ? 0 : 255;
  }
  const crcT = []; for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[i] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ===================================================== worker: one fixture */
const refusal = /refus|cannot|can't|can not|won't|unable|fail|couldn't|nothing|\bno\b|needs? |must|already|first\b|isn't|aren't|doesn't|did not|would not|not (a|an|enough|possible|found|available|solid|closed|supported)\b/i;

/* The verdict, from what was seen. froze and error outrank the rest (a verb can be both: both lists get it). */
function verdict(r) {
  const flags = [];
  let outcome;
  if (r.frozen) { outcome = 'froze > 10 s'; flags.push('froze'); }
  if (r.errs) { if (!outcome) outcome = 'error in console'; flags.push('error'); }
  if (outcome) return { outcome, flags };
  if (r.dataChanged) return { outcome: 'worked', flags };
  if (r.blocked === 'absent' && !r.said) { flags.push('na'); return { outcome: 'not offered', flags }; }   // the control is not there for this piece, or not yet
  if (r.blocked && !r.said) { flags.push('nothing'); return { outcome: 'no visible result', flags }; }       // greyed out
  if (r.view && (r.uiChanged || r.said)) return { outcome: 'worked', flags };
  if (r.said) {
    /* the app calling it an error (the status line's error style, red text in the card), or saying so in so many words */
    if (r.warned || refusal.test(r.said)) { flags.push('refused'); return { outcome: 'refused: "' + r.said.slice(0, 160) + '"', flags }; }
    return { outcome: 'worked', flags };        // it answered, and the piece is as it was: a reading, or a mode armed
  }
  if (r.uiChanged) return { outcome: 'worked', flags };
  flags.push('nothing'); return { outcome: 'no visible result', flags };
}

async function worker(key, items) {
  const fx = FIXTURES.find(f => f.key === key);
  const file = fx.file();
  const plan = buildPlan();
  const dir = path.join(OUT, key);
  fs.mkdirSync(dir, { recursive: true });
  const { withApp } = require('./nso_app_harness');
  const emit = o => fs.writeSync(1, MSG + JSON.stringify(o) + '\n');
  const killSelf = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch (e) { process.exit(3); } };

  await withApp(async (page, logs) => {
    await page.addInitScript(LONGTASK);
    /* the app keeps preferences in localStorage (units, Watch, export format, cooling profile): without this one verb's setting leaks into the next */
    await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* no storage */ } });
    const dialogs = [];
    /* a person answers a prompt (Export asks for a file name) with OK, and a confirm the same */
    page.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message()); (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()).catch(() => {}); });
    let cur = null, busy = null;
    /* every Playwright call goes through G: one that stays pending is a frozen page */
    const G = async (label, fn) => {
      busy = { label, since: Date.now() };
      try { return await fn(); } finally { busy = null; }
    };
    setInterval(() => {
      if (!busy || !cur || !cur.armed) return;   // only the verb's own steps count, not the boot and the load
      const d = Date.now() - busy.since;
      if (d >= FREEZE_MS) cur.frozeFor = Math.max(cur.frozeFor || 0, d);      // (counted as a freeze at 30 s: a slow frame is not one)
      if (d >= KILL_MS) {
        emit({ t: 'res', i: cur.i, outcome: 'froze > 10 s', secs: +((Date.now() - cur.t0) / 1000).toFixed(1),
               note: 'the page never came back (' + busy.label + ' pending ' + Math.round(d / 1000) + ' s); killed', shot: '', flags: ['froze'] });
        killSelf();
      }
    }, 500);

    const LARGE = key === 'large';       // software GL draws it at about a frame a second: longer waits, coarser drags
    const TMO = LARGE ? 90000 : 8000;
    const FORCE = LARGE;      // no waits for rAF-stable: on the large fixture each is seconds. The mouse events themselves are still real
    const X = {};
    X.page = page; X.large = LARGE;
    X.wait = ms => sleep(ms);
    X.status = () => G('status', () => page.evaluate(() => (document.getElementById('status') || {}).textContent || ''));
    X.notes = [];
    X.note = s => { if (!X.notes.includes(s)) X.notes.push(s); if (cur && cur.id && s.startsWith(cur.id + ':')) { if (!X.blocked.includes(cur.id)) X.blocked.push(cur.id); if (/not in the page|hidden|not showing/.test(s)) X.gone.push(cur.id); } };
    X.blocked = []; X.gone = [];

    X.boot = async () => {
      await G('reload', () => page.reload({ waitUntil: 'load' }));
      await G('ready', () => page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 }));
    };
    X.load = async (f, wantPlaced) => {
      const before = await G('models', () => page.evaluate(() => state.models.length));
      await G('setInputFiles', () => page.setInputFiles('#file-input', f));
      await G('waitModel', () => page.waitForFunction(n => state.models.length > n, before, { timeout: 120000 }));
      await G('waitPlaced', () => page.waitForFunction(n => state.placed.length >= n && !/^(Indexing|Reading)/.test((document.getElementById('status') || {}).textContent || ''),
        wantPlaced, { timeout: 240000, polling: 250 }));
    };
    X.fit = steep => G('fit', () => page.evaluate(FIT, !!steep));
    X.hits = async () => { const r = await G('hits', () => page.evaluate(HITS)); X.H = r.hits; X.S = r.sides; X.C = r.centres; return X.H; };
    /* the two points of a piece furthest apart on screen (for a measure, a bridge, a drag) */
    X.span = i => {
      const a = (X.H && X.H[i]) || []; let best = null, d = -1;
      for (const p of a) for (const q of a) { const e = Math.hypot(p.x - q.x, p.y - q.y); if (e > d) { d = e; best = [p, q]; } }
      return best;
    };
    X.pt = (i, k) => {
      const a = (X.H && X.H[i]) || [];
      if (!a.length) { if (X.C && X.C[i]) { X.note('no sample landed on piece ' + (i + 1) + ': clicked the middle of it'); return X.C[i]; } return null; }
      return a[(k || 0) % a.length];
    };

    /* a control, found the way a person finds it: open what it hides in with the mouse */
    X.reveal = async id => {
      const chain = await G('chain', () => page.evaluate(id => {
        document.querySelectorAll('[data-qa-open]').forEach(d => d.removeAttribute('data-qa-open'));
        const e = document.getElementById(id); if (!e) return null;
        const c = [];
        for (let n = e.parentElement, k = 0; n; n = n.parentElement) {
          if (n.tagName === 'DETAILS' && !n.open) { n.setAttribute('data-qa-open', String(k)); c.unshift('[data-qa-open="' + k + '"] > summary'); k++; }
        }
        return c;
      }, id));
      if (chain === null) return false;
      for (const s of chain) if (s) { await G('summary', () => LARGE ? page.evaluate(s => document.querySelector(s).click(), s) : page.click(s, { timeout: TMO })); await sleep(200); }
      return true;
    };
    X.state = id => G('state', () => page.evaluate(id => {
      const e = document.getElementById(id); if (!e) return 'missing';
      if (e.disabled) return 'disabled';
      const r = e.getBoundingClientRect(); return (r.width && r.height) ? 'ok' : 'hidden';
    }, id));
    /* a real click on a button; false (and a note) when it is greyed, absent or blocked */
    X.click = async id => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      const s = await X.state(id);
      if (s !== 'ok') { X.note(id + ': ' + (s === 'disabled' ? 'greyed out' : s === 'hidden' ? 'not showing' : s)); X.blocked.push(id); if (s !== 'disabled') X.gone.push(id); return false; }
      try { await G('click ' + id, () => page.click('#' + id, { timeout: TMO, force: FORCE })); return true; }
      catch (e) { if (cur && cur.frozeFor >= 3 * FREEZE_MS) throw e; X.note(id + ': click failed - ' + String(e.message).split('\n')[0].slice(0, 120)); X.blocked.push(id); return false; }
    };
    X.clickSel = async sel => {
      try { await G('click ' + sel, () => page.click(sel, { timeout: TMO, force: FORCE })); return true; }
      catch (e) { X.note(sel + ': click failed - ' + String(e.message).split('\n')[0].slice(0, 120)); return false; }
    };
    X.clickAt = async p => {
      if (!p) { X.note('no point on the piece to click'); return false; }
      await G('mouse', () => page.mouse.move(p.x, p.y)); await G('mouse', () => page.mouse.down()); await G('mouse', () => page.mouse.up());
      return true;
    };
    X.dragAt = async (a, b, o) => {
      o = o || {};
      if (!a || !b) { X.note('no point on the piece to drag from'); return false; }
      await G('mouse', () => page.mouse.move(a.x, a.y)); await G('mouse', () => page.mouse.down());
      const n = Math.max(2, Math.ceil((o.steps || 8) / (LARGE ? 3 : 1)));
      for (let k = 1; k <= n; k++) await G('mouse', () => page.mouse.move(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n));
      if (!o.hold) await G('mouse', () => page.mouse.up());
      return true;
    };
    /* a G-scope column button toggles its card: press it only when the card is not already open */
    X.nav = async id => {
      const open = await G('nav', () => page.evaluate(id => { const b = document.getElementById(id), c = b && document.getElementById(b.getAttribute('data-card')); return !!(c && c.classList.contains('is-open')); }, id));
      if (!open) await X.click(id);
      await sleep(250);
    };
    X.up = () => G('up', () => page.mouse.up());
    X.hold = async (p, ms) => { await G('mouse', () => page.mouse.move(p.x, p.y)); await G('mouse', () => page.mouse.down()); await sleep(ms); await G('mouse', () => page.mouse.up()); };
    X.key = k => G('key', () => page.keyboard.press(k));
    X.fill = async (id, v) => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      const st = await X.state(id);
      if (st !== 'ok') { X.note(id + ': ' + (st === 'disabled' ? 'greyed out' : st === 'hidden' ? 'not showing' : st)); return false; }
      try { await G('fill', () => page.fill('#' + id, String(v), { timeout: TMO })); await G('enter', () => page.keyboard.press('Enter')); return true; }
      catch (e) { X.note(id + ': fill failed - ' + String(e.message).split('\n')[0].slice(0, 100)); return false; }
    };
    X.select = async (id, v) => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      const st = await X.state(id);
      if (st !== 'ok') { X.note(id + ': ' + (st === 'disabled' ? 'greyed out' : st === 'hidden' ? 'not showing' : st)); return false; }
      try { await G('select', () => page.selectOption('#' + id, v, { timeout: TMO })); return true; }
      catch (e) { X.note(id + ': select failed - ' + String(e.message).split('\n')[0].slice(0, 100)); return false; }
    };
    /* a button that opens a file chooser, answered with `f`; a download, saved and measured.
       The wait for the event is not a page call: a page that never offers one is not a frozen page. */
    X.chooser = async (id, f) => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      const fc = page.waitForEvent('filechooser', { timeout: TMO }).catch(() => null);
      try { await G('click ' + id, () => page.click('#' + id, { timeout: TMO, force: FORCE })); }
      catch (e) { X.note(id + ': click failed - ' + String(e.message).split('\n')[0].slice(0, 100)); return false; }
      const c = await fc;
      if (!c) { X.note(id + ': no file chooser opened'); return false; }
      await G('setFiles', () => c.setFiles(f)); return true;
    };
    X.download = async id => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      const st = await X.state(id);
      if (st !== 'ok') { X.note(id + ': ' + st); return false; }
      const dl = page.waitForEvent('download', { timeout: TMO }).catch(() => null);
      try { await G('click ' + id, () => page.click('#' + id, { timeout: TMO, force: FORCE })); }
      catch (e) { X.note(id + ': click failed - ' + String(e.message).split('\n')[0].slice(0, 100)); return false; }
      const d = await dl;
      if (!d) { X.note(id + ': no download followed'); return false; }
      const p = path.join(CACHE, 'dl-' + key + '-' + Date.now() + '-' + d.suggestedFilename());
      await d.saveAs(p); const sz = fs.statSync(p).size; fs.unlinkSync(p);
      X.note('downloaded ' + d.suggestedFilename() + ' (' + sz + ' bytes)'); return true;
    };
    /* until the page stops changing; returns when it last changed (ms from t0) */
    X.settle = async (maxMs) => {
      maxMs = maxMs || 30000;
      const t0 = Date.now(); let last = null, lastChange = t0, stable = 0;
      while (Date.now() - t0 < maxMs) {
        const f = await G('settle', () => page.evaluate(FINGERPRINT));
        const k = f.data + f.ui + f.status + f.adjust + f.cards.join('|');
        if (k === last) { if (++stable >= (LARGE ? 2 : 3)) return { at: lastChange, capped: false }; }
        else { stable = 0; last = k; lastChange = Date.now(); }
        await sleep(120);
      }
      X.note('still changing after ' + Math.round(maxMs / 1000) + ' s');
      return { at: Date.now(), capped: true };
    };

    /* a check box (by its id, or any selector) - clicked on its label, where a person clicks it */
    X.flag = async id => {
      const sel = /[#\[.]/.test(id) ? id : '#' + id;
      if (!/[#\[.]/.test(id) && !await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      try { await G('flag', () => page.click('label:has(' + sel + ')', { timeout: TMO, force: FORCE })); return true; }
      catch (e) { X.note(id + ': could not be ticked - ' + String(e.message).split('\n')[0].slice(0, 100)); return false; }
    };
    /* a range slider: press its thumb and drag along the track to `frac` of its length */
    X.slider = async (id, frac) => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      const b = await G('box', () => page.evaluate(id => { const e = document.getElementById(id), r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, v: (+e.value - +e.min) / ((+e.max - +e.min) || 1), off: !(r.width && r.height) }; }, id));
      if (b.off) { X.note(id + ': not showing'); return false; }
      const vert = b.h > b.w;
      const pad = 10;     // the thumb's centre sits half a thumb in from the track's end
      const at = f => vert ? { x: b.x + b.w / 2, y: b.y + pad + (b.h - 2 * pad) * (1 - f) } : { x: b.x + pad + (b.w - 2 * pad) * f, y: b.y + b.h / 2 };
      await X.dragAt(at(b.v), at(frac), { steps: 8 });
      return true;
    };
    /* a size field, multiplied: read what it says, type that times `k` */
    X.fillNum = async (id, k) => {
      if (!await X.reveal(id)) { X.note(id + ': not in the page'); return false; }
      if (await X.state(id) !== 'ok') { X.note(id + ': ' + await X.state(id) + ' for this piece'); return false; }
      const v = await G('val', () => page.evaluate(id => parseFloat(document.getElementById(id).value), id));
      if (!(v > 0)) { X.note(id + ': empty'); return false; }
      return X.fill(id, +(v * k).toFixed(3));
    };
    X.ringDrag = async (ring, deg) => {
      /* the lean rows are roles, and which ring answers to one depends on the view: drag the ring that is drawn */
      const drawn = await G('rings', () => page.evaluate(() => (window.nsoRotate && window.nsoRotate.rings()) || []));
      if (ring !== 'turn') ring = drawn.filter(r => r !== 'turn')[0] || ring;
      const h = await G('ring', () => page.evaluate(r => window.nsoRotate && window.nsoRotate.handleScreen(r, 1), ring));
      const c = await G('ctr', () => page.evaluate(() => window.nsoRotate && window.nsoRotate.centreScreen()));
      if (!h || !c) { X.note('no ' + ring + ' ring is drawn'); return false; }
      const a0 = Math.atan2(h.y - c.y, h.x - c.x), R = Math.hypot(h.x - c.x, h.y - c.y);
      await G('mouse', () => page.mouse.move(h.x, h.y)); await G('mouse', () => page.mouse.down());
      const step = LARGE ? 10 : 1;
      for (let i = step; i <= deg; i += step) { const a = a0 + i * Math.PI / 180; await G('mouse', () => page.mouse.move(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R)); }
      await G('mouse', () => page.mouse.up());
      return true;
    };
    /* the two pieces picked as Join's A and B, with the mouse */
    const jstate = tag => process.env.QA_TRACE && page.evaluate(() => ({ sess: state.joinSession, edit: state.editId, partner: state.joinPartnerId, armed: state.joinArmed, sel: state.selectedIndex }))
      .then(j => process.stderr.write(tag + ' ' + JSON.stringify(j) + ' pts ' + JSON.stringify([X.pt(0, 0), X.pt(1, 0)]) + '\n'));
    X.joinAB = async () => {
      await X.click('join-slot-a'); await jstate('slotA'); await X.pick(0, 0, false); await jstate('pickA');
      await X.click('join-slot-b'); await jstate('slotB'); await X.pick(1, 0, false); await jstate('pickB');
    };
    X.joinABC = async () => { await X.joinAB(); await X.click('join-slot-c'); await X.pick(2, 0, false); };
    /* a few little pictures: a black ring on white, for Picture, Trace raster and Photo */
    X.png = (n) => {
      n = n || 0;
      const f = path.join(CACHE, 'qa-picture-' + n + '.png');
      if (!fs.existsSync(f)) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, makePng(64, n)); }
      return f;
    };
    /* G-scope: where its first piece is, as a screen pixel (a triangle centroid, so on the surface) */
    const gsPixel = (which) => G('gsPx', () => page.evaluate(w => {
      const M = window.NSO_MICROSCOPE, v = M.getView(), d = M.getDoc(), r = v.renderer.domElement.getBoundingClientRect();
      const toPx = q => { const p = q.clone().project(v.camera); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; };
      const at = (x, y, z) => toPx(new THREE.Vector3(x - d.cx, z, -(y - d.cy)));
      if (w === 'bed') return at(d.cx, d.cy, 0);
      const o = d.objects[0]; if (!o) return null;
      const p = o.positions; return at((p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3);
    }, which));
    
    X.gsTake = async () => {
      await X.click('ms-plate-take'); await sleep(500);
      const bed = await gsPixel('bed');
      await X.click('ms-plate-lens'); await sleep(500);
      const from = await gsPixel('piece');
      if (!from || !bed) { X.note('G-scope shows no piece to pull'); return; }
      await X.dragAt(from, bed, { steps: 10 });
      await sleep(400);
    };
    /* a point on a side wall of piece i (Join wants one: "click a side wall, not the top"); any point when none shows */
    X.side = (i, k) => { const a = (X.S && X.S[i]) || []; return a.length ? a[(k || 0) % a.length] : X.pt(i, k); };
    X.pick = async (i, k, gs) => { await X.clickAt(gs ? await gsPixel('piece') : (gs === false ? X.side(i, k) : X.pt(i, k))); await sleep(150); };
    X.fp = () => G('fp', () => page.evaluate(FINGERPRINT));
    X.shotBuf = () => G('shot', () => page.screenshot());
    X.shotBufMaybe = async () => LARGE ? null : X.shotBuf();      // a pixel diff costs a screenshot, and one is seconds on the large fixture

    const results = [];
    for (const idx of items) {
      const it = plan[idx];
      cur = { i: idx, id: it.id, t0: Date.now(), frozeFor: 0 };
      emit({ t: 'start', i: idx });
      X.notes = []; X.blocked = []; X.gone = []; dialogs.length = 0;
      const rec = { t: 'res', i: idx, outcome: '', secs: 0, note: '', shot: '', flags: [], errors: [] };
      const tp = (tag) => { if (process.env.QA_TRACE) process.stderr.write('  [' + ((Date.now() - cur.t0) / 1000).toFixed(1) + ' s] ' + tag + '\n'); };
      try {
        tp('start'); await X.boot(); tp('booted');
        if (it.setup !== 'none') {
          await X.load(file, 1); tp('loaded');
          for (let n = 2; n <= (it.setup === 'three' ? 3 : it.setup === 'two' ? 2 : 0); n++) {
            await G('stock', () => page.click('#btn-stock-box', { timeout: TMO, force: FORCE }));
            await G('placed', () => page.waitForFunction(k => state.placed.length >= k, n, { timeout: LARGE ? 120000 : 20000 }));
            await sleep(300);
          }
          if (!it.nofit) { await X.fit(it.setup !== 'one'); await sleep(250); }
          tp('fitted'); await X.hits(); tp('hits');
          await X.pick(0, 0); tp('picked');
          cur.armed = true;       // from here a call pending 60 s is a frozen page - the verb's own setup included
          const e = await G('edit', () => page.evaluate(() => state.editId));
          if (e == null) X.note('a click on the piece did not select it');
        }
        if (it.menu) { await G('card', () => LARGE ? page.evaluate(m => document.querySelector('#' + m + ' > summary').click(), it.menu) : page.click('#' + it.menu + ' > summary', { timeout: TMO })).catch(() => X.note('card would not open')); await sleep(150); }
        if (it.pre) await it.pre(X);
        if (process.env.QA_TRACE) process.stderr.write(JSON.stringify({ placed: await page.evaluate(() => state.placed.map(p => [p.sourceId, p.name])), hits: X.H && X.H.map(a => a.length), join: await page.evaluate(() => ({ sess: state.joinSession, edit: state.editId, partner: state.joinPartnerId, armed: state.joinArmed })) }) + '\n');
        tp('pre done'); const fp0 = await X.fp(); tp('fp0');
        const shot0 = await X.shotBufMaybe(); tp('shot0');
        const ev0 = logs.length;
        await G('reset', () => page.evaluate(() => { if (window.__qa) { window.__qa.longest = 0; window.__qa.gap = 0; window.__qa.last = performance.now(); } }));
        cur.t0 = Date.now(); cur.armed = true; const t0 = cur.t0;
        await (it.run || (async x => { await x.click(it.id); }))(X);
        const act = Date.now() - t0;
        tp('ran'); const st = await X.settle(); tp('settled');
        const fp1 = await X.fp();
        const shot1 = await X.shotBuf(); tp('shot1');
        const longest = await G('longest', () => page.evaluate(() => window.__qa ? Math.max(window.__qa.longest, window.__qa.gap) : 0)).catch(() => 0);
        rec.secs = +(Math.max(act, st.at - t0) / 1000).toFixed(1);
        const errs = logs.slice(ev0).filter(l => /^\[(error|pageerror)\]/.test(l));
        rec.errors = errs;
        const dataChanged = fp0.data !== fp1.data, uiChanged = fp0.ui !== fp1.ui || (shot0 && !shot0.equals(shot1)) || fp0.cards.join() !== fp1.cards.join();
        const cardSaid = fp1.cards.filter(l => !fp0.cards.includes(l)).join(' / ');
        const said = (fp1.status !== fp0.status || fp1.adjust !== fp0.adjust) ? (fp1.status !== fp0.status ? fp1.status : fp1.adjust) : (dialogs[0] || cardSaid);
        const frozen = longest >= FREEZE_MS || cur.frozeFor >= 3 * FREEZE_MS;
        /* the raw findings are kept with the record, so the verdict can be re-read from them (--report) */
        const warned = (fp1.status !== fp0.status && fp1.statusError) || fp1.warn.some(l => !fp0.warn.includes(l));
        const gone = X.blocked.includes(it.id) ? (X.gone.includes(it.id) ? 'absent' : 'grey') : '';
        rec.raw = { frozen, stall: +(Math.max(longest, cur.frozeFor >= 3 * FREEZE_MS ? cur.frozeFor : 0) / 1000).toFixed(1), errs: errs.length, dataChanged, uiChanged, said, warned,
                    blocked: gone, view: !!it.view };
        const v = verdict(rec.raw);
        rec.outcome = v.outcome; rec.flags = v.flags;
        const bits = [];
        if (frozen) bits.push('page blocked ' + rec.raw.stall + ' s');
        if (errs.length) bits.push(errs.length + ' console error' + (errs.length > 1 ? 's' : ''));
        if (!dataChanged && uiChanged && !it.view) bits.push('screen changed, piece not');
        if (said && !/^refused/.test(rec.outcome)) bits.push('said: "' + said.slice(0, 120) + '"');
        rec.note = bits.concat(X.notes).join('; ');
        const shotName = String(idx).padStart(3, '0') + '-' + (it.id || it.label).replace(/[^\w.-]+/g, '_') + '.png';
        fs.writeFileSync(path.join(dir, shotName), shot1);
        rec.shot = key + '/' + shotName;
      } catch (e) {
        rec.outcome = cur.frozeFor >= 3 * FREEZE_MS ? 'froze > 10 s' : 'error in console';
        rec.flags.push(cur.frozeFor >= 3 * FREEZE_MS ? 'froze' : 'error');
        rec.errors = (rec.errors || []).concat(['[tour] ' + String(e && e.message || e).split('\n')[0]]);
        rec.note = 'the tour hit: ' + String(e && e.message || e).split('\n')[0].slice(0, 200) + (X.notes.length ? '; ' + X.notes.join('; ') : '');
        rec.secs = +((Date.now() - cur.t0) / 1000).toFixed(1);
        try { await page.screenshot({ path: path.join(dir, String(idx).padStart(3, '0') + '-failed.png') }); rec.shot = key + '/' + String(idx).padStart(3, '0') + '-failed.png'; } catch (e2) { /* page gone */ }
      }
      emit(rec);
      cur = null;
    }
    emit({ t: 'done' });
  });
  process.exit(0);
}

/* ============================================ orchestrator: run and report */
function runWorker(key, items, onMsg) {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, [__filename, '--worker', key, '--items', items.join(',')],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let buf = '', last = Date.now(), done = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* gone */ } };
    const quiet = key === 'large' ? 6 * SILENCE_MS : SILENCE_MS;       // the large fixture draws at about a frame a second
    const dog = setInterval(() => { if (Date.now() - last > quiet) { onMsg({ t: 'silent' }); kill(); } }, 2000);
    child.stdout.on('data', d => {
      last = Date.now(); buf += d;
      let n; while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        if (line.startsWith(MSG)) { try { onMsg(JSON.parse(line.slice(MSG.length))); } catch (e) { /* torn line */ } }
      }
    });
    child.stderr.on('data', d => { last = Date.now(); process.stderr.write('[' + key + '] ' + d); });
    child.on('exit', code => { clearInterval(dog); kill(); if (!done) { done = true; resolve(code); } });
  });
}

async function tourFixture(fx, file, indices, results, resume) {
  const part = path.join(OUT, 'results.' + fx.key + '.partial.json');
  if (resume) { try { Object.assign(results, JSON.parse(fs.readFileSync(part, 'utf8'))); } catch (e) { /* nothing to resume */ } }
  const save = () => fs.writeFileSync(part, JSON.stringify(results));      // so a crash of the tour itself loses nothing
  let todo = indices.filter(i => !results[i]);
  const t0 = Date.now();
  let guard = 0, strikes = 0, lastCount = -1;
  while (todo.length && guard++ < indices.length * 2 + 5) {
    let current = null, finished = false;
    const code = await runWorker(fx.key, todo, m => {
      if (m.t === 'start') current = m.i;
      else if (m.t === 'res') {
        results[m.i] = m; current = null; save();
        const p = buildPlan()[m.i];
        console.log('[' + fx.key + '] ' + String(Object.keys(results).length).padStart(3) + '/' + indices.length + '  ' + (p.card + ' > ' + p.label).padEnd(40) + ' ' + m.outcome.slice(0, 50) + '  (' + m.secs + ' s)  ' + (m.note || '').slice(0, 70));
      } else if (m.t === 'done') finished = true;
    });
    todo = todo.filter(i => !results[i]);
    if (todo.length && current !== null && !results[current]) {
      const p = buildPlan()[current];
      results[current] = { t: 'res', i: current, outcome: code === 3 || code === null ? 'froze > 10 s' : 'error in console', secs: 0,
        note: 'the page process died or went silent for ' + (fx.key === 'large' ? 6 : 1) * SILENCE_MS / 1000 + ' s (exit ' + code + '); killed', shot: '', flags: ['froze'], errors: [] };
      console.log('[' + fx.key + '] ' + (p.card + ' > ' + p.label) + ' KILLED');
      todo = todo.filter(i => i !== current); save();
    } else if (todo.length && !finished) {
      /* The worker ended between verbs: it killed itself on a verb it had already reported (the 60 s watchdog),
         which is nothing to blame on the next one. Only a worker that made no progress at all - twice - is a boot failure. */
      const before = Object.keys(results).length;
      if (before === lastCount && ++strikes >= 2) {
        const i = todo[0], p = buildPlan()[i];
        results[i] = { t: 'res', i, outcome: 'error in console', secs: 0, note: 'the worker would not start this verb (exit ' + code + ')', shot: '', flags: ['error'], errors: ['[tour] worker exit ' + code] };
        console.log('[' + fx.key + '] ' + (p.card + ' > ' + p.label) + ' worker would not start');
        todo = todo.filter(k => k !== i); save(); strikes = 0;
      }
      lastCount = Object.keys(results).length;
    }
  }
}

function writeReport(runs, prev) {
  const plan = buildPlan();
  const L = [], top = [];
  const bad = { froze: [], error: [], nothing: [] };
  for (const r of runs) for (const m of Object.values(r.results)) if (m.raw) { const v = verdict(m.raw); m.outcome = v.outcome; m.flags = v.flags; }
  for (const r of runs) {
    for (const i of Object.keys(r.results)) {
      const m = r.results[i], p = plan[i];
      for (const f of ['froze', 'error', 'nothing']) if ((m.flags || []).includes(f)) bad[f].push({ fx: r.fx.key, p, m });
    }
  }
  const row = b => '- `' + b.fx + '` · ' + b.p.card + ' › ' + b.p.label + ' — ' + (b.m.note || b.m.outcome).replace(/\|/g, '/').slice(0, 220) + (b.m.secs >= 1 ? ' (' + b.m.secs + ' s)' : '');
  const list = (title, a) => { top.push('### ' + title + ' (' + a.length + ')', '', ...(a.length ? a.map(row) : ['_none_']), ''); };
  const done = runs.filter(r => !r.skipped);
  top.push('Survey, not a gate. ' + runs.map(r => '`' + r.fx.key + '`: ' + (r.skipped ? 'skipped' : Object.keys(r.results).length + ' verbs')).join(' · '), '');
  for (const r of runs.filter(r => r.skipped)) top.push('> **Skipped `' + r.fx.key + '`** - ' + r.skipped, '');
  /* froze: the pages that never came back (killed at 60 s) are the plain finding; the ones that blocked 10-60 s and returned
     are listed apart, one line each - on the large fixture the software renderer alone costs seconds a frame */
  const hung = bad.froze.filter(b => /killed/.test(b.m.note || '')), slow = bad.froze.filter(b => !/killed/.test(b.m.note || ''));
  top.push('### Froze > 10 s (' + bad.froze.length + ')', '', 'Times are this box\'s: headless Chromium draws in software, about a frame a second on the large fixture (its idle gap is a couple of seconds), so its short blocks may be the renderer, not the app. A page that never came back is not.', '');
  top.push('**Never came back (killed at 60 s): ' + hung.length + '**', '', ...(hung.length ? hung.map(row) : ['_none_']), '');
  top.push('<details><summary>Blocked 10-60 s, then came back: ' + slow.length + '</summary>', '', ...slow.map(b => '- `' + b.fx + '` · ' + b.p.card + ' › ' + b.p.label + ' — ' + ((b.m.raw && b.m.raw.stall) || b.m.secs) + ' s' + ((b.m.raw && b.m.raw.errs) ? ', ' + b.m.raw.errs + ' console error(s)' : '')), '', '</details>', '');
  list('Errored in the console', bad.error);
  list('Did nothing', bad.nothing);
  const refusedN = done.reduce((n, r) => n + Object.values(r.results).filter(m => (m.flags || []).includes('refused')).length, 0);
  top.push('_' + refusedN + ' more refused in words - see the tables in `tools/qa-out/report.md`._', '');

  /* what changed since the last full run */
  const diff = [];
  if (prev && prev.length) {
    for (const r of done) {
      const pr = prev.find(x => x.key === r.fx.key);
      if (!pr || pr.skipped) { diff.push('- `' + r.fx.key + '`: not in the last run'); continue; }
      for (const i of Object.keys(r.results)) {
        const a = pr.results[i], b = r.results[i];
        if (!a) diff.push('- `' + r.fx.key + '` · ' + plan[i].card + ' › ' + plan[i].label + ': new - ' + b.outcome);
        else if (cls(a) !== cls(b)) diff.push('- `' + r.fx.key + '` · ' + plan[i].card + ' › ' + plan[i].label + ': ' + cls(a) + ' → ' + cls(b) + (b.note ? ' (' + b.note.slice(0, 100) + ')' : ''));
      }
    }
    top.push('### Changed since the last run (' + diff.length + ')', '', ...(diff.length ? diff : ['_nothing changed_']), '');
  }

  L.push('# QA tour', '', ...top);
  for (const r of runs) {
    L.push('## ' + r.fx.key + ' - ' + r.fx.label, '');
    if (r.skipped) { L.push('Skipped: ' + r.skipped, ''); continue; }
    L.push('| verb | outcome | seconds | note |', '|---|---|---:|---|');
    for (const i of Object.keys(r.results).map(Number).sort((a, b) => a - b)) {
      const m = r.results[i], p = plan[i];
      const cell = s => String(s || '').replace(/\|/g, '/').replace(/\n/g, ' ');
      L.push('| ' + cell(p.sec + ' · ' + p.card + ' › ' + p.label) + ' | ' + cell(m.outcome) + ' | ' + m.secs + ' | ' + cell(m.note) + (m.shot ? ' · `' + m.shot + '`' : '') + ' |');
    }
    L.push('');
  }
  L.push('## Console errors, verbatim', '');
  let any = false;
  for (const r of runs) for (const i of Object.keys(r.results)) {
    const m = r.results[i];
    if (!(m.errors || []).length) continue;
    any = true;
    L.push('**' + r.fx.key + ' · ' + plan[i].card + ' › ' + plan[i].label + '**', '', '```', ...m.errors, '```', '');
  }
  if (!any) L.push('_none_', '');
  fs.writeFileSync(path.join(OUT, 'report.md'), L.join('\n'));
  /* the PR body: the top list, the console errors verbatim, nothing else */
  const B = ['## QA tour - survey, not a gate', '', ...top];
  if (any) { B.push('<details><summary>Console errors, verbatim</summary>', ''); for (const r of runs) for (const i of Object.keys(r.results)) { const m = r.results[i]; if ((m.errors || []).length) B.push('**' + r.fx.key + ' · ' + plan[i].card + ' › ' + plan[i].label + '**', '', '```', ...m.errors, '```', ''); } B.push('</details>', ''); }
  fs.writeFileSync(path.join(OUT, 'pr-body.md'), B.join('\n'));
}

async function main() {
  const argv = process.argv.slice(2);
  const plan = buildPlan();
  if (argv[0] === '--worker') {
    const key = argv[1], items = argv[argv.indexOf('--items') + 1].split(',').filter(Boolean).map(Number);
    return worker(key, items);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',').map(s => s.toLowerCase()) : null;
  const keys = argv.filter(a => FIXTURES.some(f => f.key === a));
  const resFile = path.join(OUT, 'results.json');
  if (argv.includes('--report')) {
    const saved = JSON.parse(fs.readFileSync(resFile, 'utf8'));
    let prev = []; try { prev = JSON.parse(fs.readFileSync(path.join(OUT, 'results.prev.json'), 'utf8')); } catch (e) { /* no earlier run */ }
    return writeReport(saved.map(s => ({ fx: FIXTURES.find(f => f.key === s.key), skipped: s.skipped, results: s.results })), prev);
  }
  let indices = plan.map((p, i) => i).filter(i => !only || only.includes(plan[i].card.toLowerCase()) || only.includes(plan[i].sec.toLowerCase()));
  if (argv.includes('--items')) indices = argv[argv.indexOf('--items') + 1].split(',').map(Number).filter(i => plan[i]);
  const runs = FIXTURES.filter(f => !keys.length || keys.includes(f.key)).map(fx => ({ fx, results: {}, skipped: null, file: null }));
  for (const r of runs) {
    try { r.file = r.fx.file(); } catch (e) { r.skipped = 'could not prepare the fixture: ' + String(e.message).split('\n')[0]; }
    if (!r.skipped && !r.file) {
      r.skipped = 'no 3MF in tools/fixtures-local/ (git-ignored) - copy the 1.46M-triangle file there, or point QA_LARGE at it';
      console.log('NOTICE: skipping ' + r.fx.key + ': ' + r.skipped);
    }
  }
  const go = r => r.skipped ? Promise.resolve() : tourFixture(r.fx, r.file, indices, r.results, argv.includes('--resume'));
  const small = runs.filter(r => r.fx.key !== 'large'), big = runs.filter(r => r.fx.key === 'large');
  const partial = indices.length < plan.length || runs.length < FIXTURES.length;
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch (e) { /* first run */ }
  if (argv.includes('--serial')) for (const r of runs) await go(r);
  else { await Promise.all(small.map(go)); for (const r of big) await go(r); }
  /* a partial run (some fixtures, some cards) is folded into what the last run saved */
  const merged = FIXTURES.map(fx => {
    const mine = runs.find(r => r.fx.key === fx.key), old = saved.find(s => s.key === fx.key);
    if (!mine) return old ? { fx, skipped: old.skipped, results: old.results } : null;
    const results = Object.assign({}, partial && old ? old.results : {}, mine.results);
    return { fx, skipped: mine.skipped, results };
  }).filter(Boolean);
  if (!partial && saved.length) fs.writeFileSync(path.join(OUT, 'results.prev.json'), JSON.stringify(saved));
  fs.writeFileSync(resFile, JSON.stringify(merged.map(r => ({ key: r.fx.key, skipped: r.skipped, results: r.results }))));
  let prev = []; try { prev = JSON.parse(fs.readFileSync(path.join(OUT, 'results.prev.json'), 'utf8')); } catch (e) { /* no earlier run */ }
  writeReport(merged, prev);
  for (const r of runs) { try { fs.unlinkSync(path.join(OUT, 'results.' + r.fx.key + '.partial.json')); } catch (e) { /* none */ } }
  console.log('report: ' + path.join(OUT, 'report.md'));
}

if (require.main === module) main().catch(e => { console.error('tour failed:', e); process.exit(1); });
module.exports = { FIXTURES, buildPlan, FIT, HITS, FINGERPRINT, verdict };
