#!/usr/bin/env node
/* G-scope's SELECT card: one selection model, five ways in (docs/GSCOPE-SELECT.md).

   Modes, a row of five: Piece . Region . Feature . Line . Layer. In EVERY mode
   the same three things, whatever the thing is:
     hover   outlines what a click would take
     click   isolates it; click it again, or Escape, and it is whole again
     drag    pulls it onto TAKE (ticket 1's gesture) - LENS untouched
   and a press on bare plate orbits in every mode.

   The legend is the FEATURES list: the slicer's line types only, Bambu-style -
   swatch, name, count, a Display check - and Display acts on both plates.
   Surface features (flange, handle ...) and Lift's Features readout are gone
   from G-scope: they live on the plate.

   Every drive is a real mouse.

   GATES
     1. The card: the five modes in a row, none of the old Orbit / Pick a line /
        Select layer buttons, no LINE / LAYER column buttons, the old ids that
        stay on the new controls; Feature / Line / Layer are a slice's.
     2. Each mode isolates: hover outlines, click isolates (the rest out of the
        view), click again un-isolates, Escape un-isolates.
     3. Each mode pulls: a press on the hovered thing and a drag lands exactly
        that thing on TAKE, and LENS is byte-identical afterwards.
     4. The slider's range is one card: hover, click, drag - one piece.
     5. The Features list: rows, counts, Display on both plates, a row isolates
        and is dragged like any feature.
     6. A mode switch keeps the camera; a press on bare plate orbits in every
        mode; Line's arrows and Layer's steps; the Escape ladder.
     7. A plate piece (mesh): Piece and Region only, the list says "not sliced".
     8. What left: detector rows, the Features readout, the old controls.

   Screenshots go to tools/gscope-select-out/ (git-ignored).

     node tools/nso_gscope_select_test.js       exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const cards = require('./nso_gscope_cards');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = path.join(ROOT, 'tools', 'gscope-select-out');
const SLICE = path.join(ROOT, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');
const BOX = path.join(ROOT, 'fixtures', 'box-20mm.stl');
const J = JSON.stringify;
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

const PAGE_HELPERS = `
  window.__t = (function () {
    const M = () => window.NSO_MICROSCOPE;
    const rect = () => M().getView().renderer.domElement.getBoundingClientRect();
    const toPx = (v) => { const p = v.clone().project(M().getView().camera), r = rect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; };
    const pxOf = (x, y, z) => { const d = M().getDoc(); return toPx(new THREE.Vector3(x - d.cx, z, -(y - d.cy))); };
    const find = (feature, layer) => M().getDoc().segments.find(g => g.feature === feature && g.layer === layer);
    return {
      state: n => JSON.stringify(M().plateState(n)),
      pxSeg: (feature, layer) => { const s = find(feature, layer); return pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z); },
      segOf: (feature, layer) => { const s = find(feature, layer); return { index: s.mv.index, zi: s.zi, obj: s.obj }; },
      countWhere: (feature, layer) => { const s = find(feature, layer), sh = M().getDoc().segments.filter(g => !(M().hidden().indexOf(g.feature) >= 0));
        return { piece: sh.filter(g => g.obj === s.obj).length, feature: sh.filter(g => g.obj === s.obj && g.feature === s.feature).length, layer: sh.filter(g => g.zi === s.zi).length, all: sh.length }; },
      pxObject: () => { const d = M().getDoc(), o = d.objects[0], b = o.bounds; return pxOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ); },
      bedPx: (x, y) => pxOf(x, y, 0),
      emptyPx: () => {
        const v = M().getView(), r = rect(), rc = new THREE.Raycaster(); rc.params.Line.threshold = 2;
        const roots = [v.overviewGroup, v.detailGroup, v.highlightGroup];
        for (let fy = 0.95; fy > 0.3; fy -= 0.03) for (let fx = 0.55; fx < 0.9; fx += 0.03) {
          const x = r.left + fx * r.width, y = r.top + fy * r.height;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
          if (!rc.intersectObjects(roots, true).length && document.elementFromPoint(x, y) === v.renderer.domElement) return [x, y];
        }
        return null;
      },
      cam: () => JSON.stringify(M().getView().camera.position.toArray().map(v => +v.toFixed(4))),
      pieces: () => M().takePieces()
    };
  })();
`;
const evalT = (page, fn, arg) => page.evaluate(fn, arg);
const plate = page => page.evaluate(() => NSO_MICROSCOPE.plate());
const lensState = page => page.evaluate(() => window.__t.state('lens'));
const iso = page => page.evaluate(() => NSO_MICROSCOPE.isIsolated());

async function drag(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 5 });
  await page.mouse.up();
  await frames(page);
}
async function showLens(page) { if (await plate(page) !== 'lens') { await page.click('#ms-plate-lens'); await frames(page); } }
async function setMode(page, id) {
  await page.click('#ms-mode-' + id);
  await cards.closeCards(page);
  await frames(page);
}

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(PAGE_HELPERS);
  await loadSTL(page, BOX);
  await page.waitForTimeout(300);
  const bytes = Array.from(fs.readFileSync(SLICE));
  await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytes, 'gt.gcode.3mf']);
  await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 30000 });
  await frames(page);
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  /* the TAKE bed's pixels are read once: its camera is the same for every pull */
  await page.click('#ms-plate-take'); await frames(page);
  const dest = [];
  for (const [x, y] of [[-30, -25], [-12, -25], [6, -25], [24, -25], [-30, 0], [-12, 0], [6, 0], [24, 0]]) dest.push(await page.evaluate(([x, y]) => window.__t.bedPx(x, y), [x, y]));
  await page.click('#ms-plate-lens'); await frames(page);

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the card ===');
  {
    const r = await page.evaluate(() => {
      const row = document.getElementById('ms-mode-row');
      const has = id => !!document.getElementById(id);
      return {
        kids: Array.from(row.children).map(e => e.id), text: Array.from(row.children).map(e => e.textContent.trim().toUpperCase()),
        inCard: Array.from(row.children).every(e => e.closest('#ms-card-select')),
        gone: ['ms-mode-orbit', 'ms-nav-line', 'ms-nav-layer', 'ms-card-line', 'ms-card-layer'].filter(has),
        stay: ['ms-btn-isolate', 'ms-btn-isolate-line', 'ms-btn-back', 'ms-btn-clear', 'ms-line-prev', 'ms-line-next', 'ms-line-read',
               'ms-layer-prev', 'ms-layer-index', 'ms-layer-next', 'ms-btn-layer-select', 'ms-layer-note', 'ms-select-controls', 'ms-line-controls', 'ms-layer-row']
          .filter(id => !document.getElementById(id) || !document.getElementById(id).closest('#ms-card-select')),
        column: Array.from(document.getElementById('ms-sidebar').children).map(e => e.id),
        mode: NSO_MICROSCOPE.mode(), avail: Array.from(row.children).map(e => !e.disabled),
        pressed: Array.from(row.children).map(e => e.getAttribute('aria-pressed'))
      };
    });
    check('the Select card holds the five modes in a row: Piece . Region . Feature . Line . Layer',
      J(r.kids) === J(['ms-mode-piece', 'ms-mode-select', 'ms-mode-feature', 'ms-mode-line', 'ms-mode-layer']) && J(r.text) === J(['PIECE', 'REGION', 'FEATURE', 'LINE', 'LAYER']) && r.inCard, J(r.text));
    check('Orbit is not a mode any more, and the Line and Layer cards folded into Select', r.gone.length === 0, r.gone.join(',') || 'gone');
    check('the controls that kept their ids are in the Select card now', r.stay.length === 0, r.stay.join(',') || 'all there');
    check('the column is Import, Read plate | Select, View, Render | Overhangs, Crop Z, Slice', J(r.column) === J(['ms-btn-open', 'ms-btn-plate', 'ms-nav-select', 'ms-nav-view', 'ms-nav-render', 'ms-nav-overhangs', 'ms-nav-crop', 'ms-nav-slice']), J(r.column));
    check('Piece is the mode a document opens in; on a slice every mode is available', r.mode === 'piece' && r.avail.every(Boolean) && J(r.pressed) === J(['true', 'false', 'false', 'false', 'false']), J(r.pressed));
    await page.click('#ms-nav-select'); await frames(page);
    await shot('01-select-card');
    await cards.closeCards(page);
  }

  /* ------------------------------------------------------------------ 2 + 3 */
  console.log('\n=== 2. each mode: hover outlines, click isolates, click again / Escape un-isolates ===');
  console.log('=== 3. each mode: a drag pulls it onto TAKE, LENS untouched ===');
  const CASES = [
    ['piece', 'Piece', 'Outer wall', 1, c => c.piece, 'pick'],
    ['select', 'Region', 'Outer wall', 1, c => null, 'box'],
    ['feature', 'Feature', 'Outer wall', 1, c => c.feature, 'feature'],
    ['line', 'Line', 'Outer wall', 1, c => 1, 'line'],
    ['layer', 'Layer', 'Outer wall', 1, c => c.layer, 'layer']
  ];
  let pulled = 0;
  for (const [id, label, feat, layer, expect, source] of CASES) {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.showAll(); if (M.isIsolated()) M.back(); M.normalView(); });
    await setMode(page, id);
    const want = await page.evaluate(([f, l]) => window.__t.countWhere(f, l), [feat, layer]);
    let px = await page.evaluate(([f, l]) => window.__t.pxSeg(f, l), [feat, layer]);
    // hover
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    await page.waitForTimeout(160);
    const hv = await page.evaluate(() => ({ info: NSO_MICROSCOPE.hoverInfo(), kids: NSO_MICROSCOPE.getView().hoverGroup.children.length, cursor: NSO_MICROSCOPE.getView().renderer.domElement.style.cursor }));
    const n = expect(want);
    check(label + ': hover outlines what a click would take (' + (n == null ? 'the box region' : n + ' move(s)') + ')', hv.info && hv.info.source === source && hv.kids > 0 && hv.cursor === 'pointer' && (n == null ? hv.info.count > 0 : hv.info.count === n), J(hv.info));
    if (id === 'piece') await shot('02-hover-piece');
    const hoverCount = hv.info.count;
    // click isolates
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    const c1 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource(), detail: NSO_MICROSCOPE.getView().detailGroup.visible, overview: NSO_MICROSCOPE.getView().overviewGroup.visible, boxes: NSO_MICROSCOPE.boxes().length, plate: NSO_MICROSCOPE.plate() }));
    check(label + ': a click isolates it - the selection alone is drawn, the rest is out of the view', c1.iso && c1.detail && !c1.overview && c1.sel === hoverCount && c1.src === source && c1.plate === 'lens' && (id !== 'select' || c1.boxes === 1), J(c1));
    if (id === 'select' || id === 'layer') await shot('03-isolated-' + id);
    // click it again
    px = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.getDoc(), s = M.selection()[0], v = M.getView();
      const p = new THREE.Vector3((s.x0 + s.x1) / 2 - d.cx, s.z, -((s.y0 + s.y1) / 2 - d.cy)).project(v.camera); const r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; });
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': clicked again, it is whole again (the selection stays)', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.getView().overviewGroup.visible && NSO_MICROSCOPE.selection().length > 0));
    // click the selection to isolate it again, then Escape
    px = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.getDoc(), s = M.selection()[0], v = M.getView();
      const p = new THREE.Vector3((s.x0 + s.x1) / 2 - d.cx, s.z, -((s.y0 + s.y1) / 2 - d.cy)).project(v.camera); const r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; });
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': a click on the selection isolates it again', await iso(page));
    await page.keyboard.press('Escape');
    await frames(page);
    check(label + ': Escape un-isolates, and G-scope stays open', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.isOpen()));
    // pull: a fresh state, so what is pressed is the hover and not the selection
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.setSelectionMoves([]); M.normalView(); });
    await frames(page);
    if (id === 'line' || id === 'layer' || id === 'feature' || id === 'piece' || id === 'select') await page.evaluate(m => NSO_MICROSCOPE.setMode(m), id);
    px = await page.evaluate(([f, l]) => window.__t.pxSeg(f, l), [feat, layer]);
    const before = await lensState(page);
    const n0 = await page.evaluate(() => window.__t.pieces().length);
    await page.mouse.move(px[0], px[1]);
    await page.waitForTimeout(160);
    const hv2 = await page.evaluate(() => NSO_MICROSCOPE.hoverInfo());
    await drag(page, px, dest[pulled % dest.length]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    const piece = after.pieces[after.pieces.length - 1];
    check(label + ': a drag pulls it onto TAKE - one new piece with exactly the hovered ' + (hv2 ? hv2.count : '?') + ' move(s)', after.plate === 'take' && after.pieces.length === n0 + 1 && hv2 && piece.moves === hv2.count, J([after.plate, after.pieces.length, piece && piece.moves, hv2 && hv2.count, piece && piece.name]));
    await page.click('#ms-plate-lens'); await frames(page);
    check(label + ': LENS is byte-identical after the pull', await lensState(page) === before);
    pulled++;
  }
  await shot('04-after-five-pulls');

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the slider\'s range is one card ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.showAll(); if (M.isIsolated()) M.back(); M.setMode('layer'); M.setZRange(0, 1); M.flushView(); });
    await frames(page);
    const want = await page.evaluate(() => NSO_MICROSCOPE.shownCount());
    const full = await page.evaluate(() => NSO_MICROSCOPE.getDoc().segments.length);
    const card = await page.evaluate(() => { const b = document.getElementById('ms-zr-card').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width > 0]; });
    check('the slider has a Range card, and the range (two handles) narrows what is shown', card[2] && want > 0 && want < full, want + ' of ' + full + ' moves');
    await page.mouse.move(card[0], card[1]);
    await page.waitForTimeout(160);
    const hv = await page.evaluate(() => ({ info: NSO_MICROSCOPE.hoverInfo(), kids: NSO_MICROSCOPE.getView().hoverGroup.children.length }));
    check('hovering the card outlines the whole range', hv.info && hv.info.source === 'range' && hv.info.count === want && hv.kids > 0, J(hv.info));
    await page.mouse.click(card[0], card[1]);
    await page.waitForTimeout(150);
    const c = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource() }));
    check('a click on the card isolates the range', c.iso && c.sel === want && c.src === 'range', J(c));
    await page.mouse.click(card[0], card[1]);
    await page.waitForTimeout(150);
    check('...and again, un-isolates it', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated()));
    await page.evaluate(() => { NSO_MICROSCOPE.setSelectionMoves([]); });
    const before = await lensState(page);
    const n0 = await page.evaluate(() => window.__t.pieces().length);
    await drag(page, [card[0], card[1]], dest[5]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    const piece = after.pieces[after.pieces.length - 1];
    check('a drag from the card pulls the range onto TAKE as ONE piece', after.plate === 'take' && after.pieces.length === n0 + 1 && piece.moves === want, J([after.pieces.length, piece && piece.moves, want]));
    await page.click('#ms-plate-lens'); await frames(page);
    check('LENS is byte-identical after it', await lensState(page) === before);
    await page.evaluate(() => NSO_MICROSCOPE.setZRange(0, 1e6)); await frames(page);
    check('the slider\'s range also works on a slice: All gives the whole range back', await page.evaluate(() => NSO_MICROSCOPE.shownCount()) === full);
    await shot('05-range');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the Features list ===');
  {
    await showLens(page);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map(r => ({
      name: r.dataset.group, label: r.querySelector('.ms-legend-label').textContent, swatch: !!r.querySelector('.ms-swatch'),
      check: !!r.querySelector('input.ms-legend-display'), only: !!r.querySelector('.ms-legend-only'), sw: r.querySelector('.ms-swatch').style.background })));
    const title = await page.evaluate(() => document.getElementById('ms-legend-title').textContent);
    check('the list is titled Features and holds the slice\'s line types, Bambu order: swatch, name (count), Display check',
      title === 'Features' && J(rows.map(r => r.name)) === J(['Outer wall', 'Inner wall', 'Sparse infill', 'Support', 'Support interface']) &&
      rows.every(r => r.swatch && r.check && !r.only && /\(\d+\)$/.test(r.label) && r.sw), J(rows.map(r => r.label)));
    check('no detector rows, no Parts', await page.evaluate(() => !document.getElementById('ms-detected') && !document.querySelector('.ms-detected-item')));
    // Display: Support off - a click on the real check
    const sup = await page.evaluate(() => window.__t.pxSeg('Support', 0));
    await page.evaluate(() => { NSO_MICROSCOPE.setMode('feature'); });
    const pt0 = await page.evaluate(() => NSO_MICROSCOPE.pressTargetAt(...window.__t.pxSeg('Support', 0)));
    check('before: a press on a Support line has something to take', !!pt0 && pt0.source === 'feature', J(pt0));
    await page.click('#ms-legend .ms-legend-item[data-group="Support"] .ms-legend-display');
    await frames(page);
    const off = await page.evaluate(() => ({ vis: NSO_MICROSCOPE.getView().overviewMeshes['Support'].visible, dim: document.querySelector('#ms-legend .ms-legend-item[data-group="Support"]').classList.contains('dim'),
      checked: document.querySelector('#ms-legend .ms-legend-item[data-group="Support"] input').checked, off: NSO_MICROSCOPE.hidden(), mid: NSO_MICROSCOPE.getView().overviewMeshes['Outer wall'].visible }));
    check('Display unchecked: the Support lines are not drawn, the row dims, the others stay', !off.vis && off.dim && !off.checked && off.mid && off.off.indexOf('Support') >= 0, J(off));
    const pt1 = await page.evaluate(() => NSO_MICROSCOPE.pressTargetAt(...window.__t.pxSeg('Support', 0)));
    check('...and where they were there is nothing to take', !pt1 || pt1.count === 0 || pt1.source !== 'feature', J(pt1));
    await shot('06-display-off');
    // on TAKE: a piece that holds Support lines is drawn without them
    await page.click('#ms-plate-take'); await frames(page);
    const tk = await page.evaluate(() => { const v = NSO_MICROSCOPE.getView(); let tri = 0, support = 0;
      Object.keys(v.overviewMeshes).forEach(k => { const m = v.overviewMeshes[k]; if (m.visible) tri += m.geometry.attributes.position.count / 3; });
      const d = NSO_MICROSCOPE.getDoc(); d.objects.forEach(o => (o.moves || []).forEach(m => { if (m.feature === 'Support') support++; }));
      return { tri, support, row: document.querySelector('#ms-legend .ms-legend-item[data-group="Support"]'), dim: !!document.querySelector('#ms-legend .ms-legend-item[data-group="Support"].dim') }; });
    check('on TAKE the same type is off: the pieces keep their Support beads but do not draw them, and its row is dimmed', tk.support > 0 && tk.dim, J([tk.tri, tk.support, tk.dim]));
    const trisOff = tk.tri;
    await page.click('#ms-legend .ms-legend-item[data-group="Support"] .ms-legend-display');
    await frames(page);
    const trisOn = await page.evaluate(() => { const v = NSO_MICROSCOPE.getView(); let tri = 0; Object.keys(v.overviewMeshes).forEach(k => { const m = v.overviewMeshes[k]; if (m.visible) tri += m.geometry.attributes.position.count / 3; }); return tri; });
    check('checked on TAKE, it comes back on both: more triangles drawn', trisOn > trisOff, trisOff + ' -> ' + trisOn);
    await page.click('#ms-plate-lens'); await frames(page);
    check('...and on LENS the lines are drawn again', await page.evaluate(() => NSO_MICROSCOPE.getView().overviewMeshes['Support'].visible && NSO_MICROSCOPE.hidden().indexOf('Support') < 0));
    // a row, off its check, is the Feature click
    const n0 = await page.evaluate(() => window.__t.pieces().length);
    const want = await page.evaluate(() => NSO_MICROSCOPE.getDoc().segments.filter(g => g.feature === 'Outer wall').length);
    await page.click('#ms-legend .ms-legend-item[data-group="Outer wall"] .ms-legend-label');
    await page.waitForTimeout(150);
    const r1 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource(), mode: NSO_MICROSCOPE.mode() }));
    check('a click on a legend row isolates that line type (and switches to Feature)', r1.iso && r1.sel === want && r1.src === 'feature' && r1.mode === 'feature', J(r1));
    await page.click('#ms-legend .ms-legend-item[data-group="Outer wall"] .ms-legend-label');
    await page.waitForTimeout(120);
    check('...the row again, whole again', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated()));
    await page.evaluate(() => NSO_MICROSCOPE.setSelectionMoves([]));
    // hover on a row outlines the type; a drag from the row pulls it
    const rowPt = await page.evaluate(() => { const b = document.querySelector('#ms-legend .ms-legend-item[data-group="Outer wall"] .ms-legend-label').getBoundingClientRect(); return [b.left + 20, b.top + b.height / 2]; });
    const before = await lensState(page);
    await drag(page, rowPt, dest[6]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    check('a drag from the row pulls the line type onto TAKE', after.plate === 'take' && after.pieces.length === n0 + 1 && after.pieces[after.pieces.length - 1].moves === want, J([after.pieces.length, n0, want]));
    await page.click('#ms-plate-lens'); await frames(page);
    check('LENS is byte-identical after it', await lensState(page) === before);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the camera, the orbit, the arrows, the Escape ladder ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.showAll(); M.setSelectionMoves([]); if (M.isIsolated()) M.back(); M.normalView(); });
    await frames(page);
    const cam0 = await page.evaluate(() => window.__t.cam());
    for (const id of ['select', 'feature', 'line', 'layer', 'piece']) await setMode(page, id);
    check('switching modes keeps the camera', await page.evaluate(() => window.__t.cam()) === cam0);
    for (const id of ['piece', 'select', 'feature', 'line', 'layer']) {
      await setMode(page, id);
      const empty = await page.evaluate(() => window.__t.emptyPx());
      const c0 = await page.evaluate(() => window.__t.cam()), n0 = await page.evaluate(() => window.__t.pieces().length);
      await drag(page, empty, [empty[0] - 70, empty[1] - 25]);
      const r = await page.evaluate(() => ({ cam: window.__t.cam(), plate: NSO_MICROSCOPE.plate(), n: window.__t.pieces().length, iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().length }));
      check(id + ': a drag on bare plate orbits - the camera moves, nothing is pulled, isolated or selected', r.cam !== c0 && r.plate === 'lens' && r.n === n0 && !r.iso && r.sel === 0, c0 + ' -> ' + r.cam);
      await page.evaluate(() => NSO_MICROSCOPE.normalView());
    }
    // Line: the arrows
    await setMode(page, 'line');
    await page.evaluate(() => NSO_MICROSCOPE.normalView());
    const px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(150);
    const a0 = await page.evaluate(() => NSO_MICROSCOPE.selection()[0].mv.index);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const a1 = await page.evaluate(() => ({ idx: NSO_MICROSCOPE.selection()[0].mv.index, n: NSO_MICROSCOPE.selection().length, iso: NSO_MICROSCOPE.isIsolated(), read: document.getElementById('ms-line-read').textContent }));
    await page.click('#ms-nav-select');
    await page.click('#ms-line-prev');
    await page.waitForTimeout(150);
    const a2 = await page.evaluate(() => NSO_MICROSCOPE.selection()[0].mv.index);
    check('Line: the arrows step along it - Right to the next move, the ◀ button back, still isolated', a1.idx !== a0 && a1.n === 1 && a1.iso && a2 === a0, J([a0, a1.idx, a2]) + ' ' + a1.read);
    await shot('07-line-step');
    // Escape ladder: a card open, something isolated
    check('Escape 1: the open card shuts first (the Select card is up)', await page.evaluate(() => document.getElementById('ms-card-select').classList.contains('is-open')) && (await page.keyboard.press('Escape'), await frames(page), await page.evaluate(() => !document.getElementById('ms-card-select').classList.contains('is-open') && NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.isOpen())));
    await page.keyboard.press('Escape');
    await frames(page);
    check('Escape 2: what is isolated is whole again', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.isOpen()));
    // Layer: the controls
    await setMode(page, 'layer');
    await page.click('#ms-nav-select');
    await page.click('#ms-layer-next');
    await page.waitForTimeout(120);
    const l1 = await page.evaluate(() => ({ idx: document.getElementById('ms-layer-index').value, sel: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource(), mode: NSO_MICROSCOPE.mode() }));
    check('Layer: the step buttons select a layer in this card, and the mode follows', l1.src === 'layer' && l1.sel > 0 && l1.mode === 'layer' && l1.idx === '1', J(l1));
    await cards.closeCards(page);
    await page.evaluate(() => { NSO_MICROSCOPE.setSelectionMoves([]); });
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. a plate piece: Piece and Region ===');
  {
    await showLens(page);
    await page.click('#ms-btn-plate');
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
    await frames(page);
    const r = await page.evaluate(() => ({ avail: ['piece', 'select', 'feature', 'line', 'layer'].map(m => !document.getElementById('ms-mode-' + m).disabled),
      mode: NSO_MICROSCOPE.mode(), note: (document.querySelector('#ms-legend .ms-legend-note') || {}).textContent, rows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      layerRow: getComputedStyle(document.getElementById('ms-layer-row')).display, lineRow: getComputedStyle(document.getElementById('ms-line-controls')).display }));
    check('on a mesh Piece and Region are available; Feature, Line and Layer are a slice\'s', J(r.avail) === J([true, true, false, false, false]) && r.mode === 'piece', J(r.avail));
    check('...the Features list says so, and the slice-only rows are out of the card', /Not sliced/.test(r.note || '') && r.rows === 0 && r.layerRow === 'none' && r.lineRow === 'none', J(r));
    await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);
    const px = await page.evaluate(() => window.__t.pxObject());
    await page.mouse.move(px[0], px[1]); await page.waitForTimeout(160);
    const hv = await page.evaluate(() => ({ info: NSO_MICROSCOPE.hoverInfo(), kids: NSO_MICROSCOPE.getView().hoverGroup.children.length }));
    check('Piece: hover outlines the piece', hv.info && hv.info.source === 'pick' && hv.info.count === 1 && hv.kids > 0, J(hv.info));
    await shot('08-plate-hover');
    await page.mouse.click(px[0], px[1]); await page.waitForTimeout(150);
    check('...click isolates it', await page.evaluate(() => NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.selection().length === 1));
    await page.keyboard.press('Escape'); await frames(page);
    check('...Escape un-isolates', await iso(page) === false);
    await page.evaluate(() => { NSO_MICROSCOPE.setSelectionMoves([]); NSO_MICROSCOPE.selectObjects([]); NSO_MICROSCOPE.normalView(); }); await frames(page);
    const px2 = await page.evaluate(() => window.__t.pxObject());
    const before = await lensState(page), n0 = await page.evaluate(() => window.__t.pieces().length);
    await drag(page, px2, dest[7]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    check('Piece: a drag pulls the piece onto TAKE', after.plate === 'take' && after.pieces.length === n0 + 1 && /box-20mm/.test(after.pieces[after.pieces.length - 1].name), J(after.pieces.map(p => p.name).slice(-1)));
    await page.click('#ms-plate-lens'); await frames(page);
    check('LENS is byte-identical after it', await lensState(page) === before);
    // Region on a mesh
    await setMode(page, 'select');
    await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);
    const px3 = await page.evaluate(() => window.__t.pxObject());
    await page.mouse.move(px3[0], px3[1]); await page.waitForTimeout(160);
    const hv3 = await page.evaluate(() => NSO_MICROSCOPE.hoverInfo());
    await page.mouse.click(px3[0], px3[1]); await page.waitForTimeout(150);
    const c3 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), boxes: NSO_MICROSCOPE.boxes().length, sel: NSO_MICROSCOPE.selection().length }));
    check('Region: hover shows the box a click would drop; the click drops it and isolates what it holds', hv3 && hv3.source === 'box' && c3.iso && c3.boxes === 1 && c3.sel === 1, J([hv3, c3]));
    await page.keyboard.press('Escape'); await frames(page);
    await page.evaluate(() => NSO_MICROSCOPE.clearBoxes());
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. what left G-scope ===');
  {
    const r = await page.evaluate(() => ({
      detectedRow: !!document.getElementById('ms-detected'), liftRow: !!document.getElementById('ms-lift-row'), liftObj: typeof window.NSO_GSCOPE_LIFT,
      liftScript: !!document.querySelector('script[src*="app-gscope-lift"]'),
      api: ['flange', 'detectFlanges', 'toggleDetected', 'detectedOn', 'feature', 'featureRules', 'detectFeatures'].filter(k => typeof NSO_MICROSCOPE[k] === 'function'),
      only: !!document.querySelector('.ms-legend-only'), liftCss: !!document.querySelector('.ms-lift-group') }));
    check('no detector rows, no Features readout, no Lift script, no detector API', !r.detectedRow && !r.liftRow && r.liftObj === 'undefined' && !r.liftScript && r.api.length === 0 && !r.only, J(r));
  }

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /^\[error\]/.test(l)).filter(l => !/Failed to load resource/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('TEST CRASH', e); process.exit(1); });
